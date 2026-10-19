/**
 * The nightly backup engine. Storage-, database- and clock-agnostic: everything outside comes in through `deps`, so the
 * same code runs against R2 + the live database in production and against an in-memory bucket + PGlite in the tests.
 *
 * LAYOUT in the backup bucket (every object is AES-256-GCM encrypted, see crypto.js; the names hold no customer text):
 *   v1/<tenant uuid>/snap/<YYYY-MM-DD>/<table>.<n>.jsonl.gz.enc    database rows, one JSON object per line
 *   v1/<tenant uuid>/snap/<YYYY-MM-DD>/_files.<n>.jsonl.gz.enc     list of that night's document files (name, type, date, hash)
 *   v1/<tenant uuid>/snap/<YYYY-MM-DD>/refs.enc                    the file objects this snapshot needs (for pruning)
 *   v1/<tenant uuid>/snap/<YYYY-MM-DD>/manifest.enc                written LAST: a snapshot without it is unfinished and ignored
 *   v1/<tenant uuid>/snap/<YYYY-MM-DD>/_progress.enc               resume point while a big company is still being copied
 *   v1/<tenant uuid>/files/<sha256 of the file>.enc                the original files, content-addressed: a file already
 *                                                                  there is never copied again (the incremental part)
 *   v1/_meta/runs/<date>.enc, v1/_meta/last-success.enc            run status (for monitoring and the operator view)
 *
 * ONE COMPANY = ONE FOLDER = ONE KEY, so a single company can be restored, handed back, or deleted on its own.
 */
import { deriveTenantKey, deriveSystemKey, encrypt, decrypt, gzip, gunzip, sha256Hex } from './crypto.js';
import { selectRetention } from './retention.js';

export const FORMAT = 'deepwell-backup-manifest-v1';
export const PART_TARGET_BYTES = 8 * 1024 * 1024;
export const FILE_CONCURRENCY = 4;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const LOCK_FRESH_MS = 10 * 60 * 1000;

export const keys = {
  base: (tid) => `v1/${tid}/`,
  snapPrefix: (tid) => `v1/${tid}/snap/`,
  snap: (tid, date) => `v1/${tid}/snap/${date}/`,
  manifest: (tid, date) => `v1/${tid}/snap/${date}/manifest.enc`,
  progress: (tid, date) => `v1/${tid}/snap/${date}/_progress.enc`,
  refs: (tid, date) => `v1/${tid}/snap/${date}/refs.enc`,
  lock: (tid, date) => `v1/${tid}/snap/${date}/_lock.enc`,
  part: (tid, date, name, n) => `v1/${tid}/snap/${date}/${name}.${n}.jsonl.gz.enc`,
  file: (tid, sha) => `v1/${tid}/files/${sha}.enc`,
  filesPrefix: (tid) => `v1/${tid}/files/`,
  run: (date) => `v1/_meta/runs/${date}.enc`,
  lastSuccess: () => 'v1/_meta/last-success.enc',
  alertMarker: (date, kind) => `v1/_meta/alerts/${date}-${kind}.enc`,
};

export const utcDate = (ms) => new Date(ms).toISOString().slice(0, 10);

/* ---------------------------------------------------------------- small encrypted-JSON helpers */
export async function putJson(storage, key, key32, obj) { await storage.put(key, encrypt(key32, Buffer.from(JSON.stringify(obj)), key)); }
export async function getJson(storage, key, key32) {
  const blob = await storage.get(key);
  return blob ? JSON.parse(decrypt(key32, blob, key).toString('utf8')) : null;
}

/** Short, content-free reason for a status row / alert (never row data, never a connection string). */
export function scrubError(err) {
  return String(err?.message ?? err ?? 'unknown error').replace(/postgres(ql)?:\/\/\S+/gi, '[db]').replace(/[A-Za-z0-9+/_-]{40,}/g, '[x]').slice(0, 200);
}

/* ---------------------------------------------------------------- one company */

/**
 * Back up one company for `date`. Resumable: stops cleanly at `deadlineAt` with status 'partial' and picks up from its
 * progress file next time. Never touches production data (read-only) and never throws for a data problem: it returns status
 * 'failed' with a short reason, so one bad company does not stop the others.
 * @param {object} deps { storage, masterKey, source: { describeTenant, readTablePage, readDocumentFilePage, readTenantIdentity }, getObject(storageKey), keyBelongsToTenant(key, tenantId), now() }
 * @param {{tenantKey: string, tenantName?: string}} ctx
 */
export async function backupTenant(deps, ctx, { date, deadlineAt = Infinity } = {}) {
  const { storage, masterKey, source } = deps;
  const now = deps.now ?? Date.now;
  let tid = null;
  try {
    const desc = await source.describeTenant(ctx, deps.skipTables);
    tid = desc.tenantId;
    const k = deriveTenantKey(masterKey, tid);
    if (await storage.head(keys.manifest(tid, date))) return { status: 'skipped', tenantId: tid, reason: 'already done' };

    const lock = await getJson(storage, keys.lock(tid, date), k).catch(() => null);
    if (lock && now() - lock.at < LOCK_FRESH_MS && lock.owner !== deps.runId) return { status: 'skipped', tenantId: tid, reason: 'in progress elsewhere' };
    await putJson(storage, keys.lock(tid, date), k, { at: now(), owner: deps.runId ?? null });

    const identity = await source.readTenantIdentity(ctx);
    let st = await getJson(storage, keys.progress(tid, date), k).catch(() => null);
    if (!st) st = { startedAt: new Date(now()).toISOString(), tableIdx: 0, after: null, tables: {}, filesAfter: null, files: { total: 0, new: 0, unchanged: 0, missing: 0, tooLarge: 0, notExportable: 0, hashMismatch: 0, bytesNew: 0, parts: [], n: 0 }, refs: [], bytes: 0 };

    const release = () => storage.del(keys.lock(tid, date)).catch(() => {});
    const writePart = async (name, n, lines) => {
      const plain = gzip(Buffer.from(lines.join('\n') + '\n'));
      const key = keys.part(tid, date, name, n);
      const blob = encrypt(k, plain, key);
      await storage.put(key, blob);
      st.bytes += blob.length;
      return { key, rows: lines.length, bytes: blob.length, sha256: sha256Hex(blob), plainSha256: sha256Hex(plain) };
    };
    const checkpoint = () => putJson(storage, keys.progress(tid, date), k, st);

    /* ---- phase 1: database tables */
    while (st.tableIdx < desc.tables.length) {
      const t = desc.tables[st.tableIdx];
      const rec = (st.tables[t.name] ??= { rows: 0, parts: [] });
      let buf = []; let bufBytes = 0;
      const flush = async () => {
        if (!buf.length) return;
        rec.parts.push(await writePart(t.name, rec.parts.length + 1, buf));
        rec.rows += buf.length; buf = []; bufBytes = 0;
        await checkpoint();
      };
      for (;;) {
        if (now() >= deadlineAt) { await flush(); await checkpoint(); await release(); return { status: 'partial', tenantId: tid, phase: `table ${t.name}` }; }
        const page = await source.readTablePage(ctx, t, { idType: t.idType, after: st.after });
        for (const line of page.lines) { buf.push(line); bufBytes += line.length; }
        st.after = page.last;
        if (bufBytes >= PART_TARGET_BYTES || page.done) { await flush(); }
        if (page.done) break;
      }
      st.tableIdx += 1; st.after = null;
      await checkpoint();
    }

    /* ---- phase 2: the original files, incrementally */
    const sizeCap = deps.maxFileBytes ?? MAX_FILE_BYTES;
    for (;;) {
      if (now() >= deadlineAt) { await checkpoint(); await release(); return { status: 'partial', tenantId: tid, phase: 'files' }; }
      const page = await source.readDocumentFilePage(ctx, { after: st.filesAfter });
      const entries = new Array(page.rows.length);
      let next = 0;
      const one = async (i) => {
        const d = page.rows[i];
        const e = { documentId: d.id, filename: d.original_filename, type: d.document_type, createdAt: d.created_at, sizeBytes: d.file_size_bytes, sha256: d.sha256_hash, storageKey: d.storage_key };
        entries[i] = e;
        if (!deps.keyBelongsToTenant(d.storage_key, tid)) { e.status = 'not-exportable'; st.files.notExportable++; return; }
        // Incremental: a file whose content hash is already in the bucket is not fetched or copied again.
        const have = d.sha256_hash && /^[0-9a-f]{64}$/.test(d.sha256_hash) ? await storage.head(keys.file(tid, d.sha256_hash)) : null;
        if (have) { e.status = 'unchanged'; e.backupKey = keys.file(tid, d.sha256_hash); st.files.unchanged++; return; }
        let bytes;
        try { bytes = await deps.getObject(d.storage_key, { maxBytes: sizeCap }); } catch (err) {
          if (err?.status === 404) { e.status = 'missing'; st.files.missing++; return; }
          if (err?.status === 413) { e.status = 'too-large'; st.files.tooLarge++; return; }
          throw err; // a real storage fault: the step is retried later, nothing is half-recorded
        }
        const actual = sha256Hex(bytes);
        if (d.sha256_hash && actual !== d.sha256_hash) { e.status = 'hash-mismatch'; e.recordedSha256 = d.sha256_hash; st.files.hashMismatch++; }
        else e.status = 'new';
        e.sha256 = actual; e.backupKey = keys.file(tid, actual);
        if (!(await storage.head(e.backupKey))) {
          const blob = encrypt(k, bytes, e.backupKey);
          await storage.put(e.backupKey, blob);
          st.files.bytesNew += blob.length; st.bytes += blob.length;
        }
        if (e.status === 'new') st.files.new++;
      };
      const workers = Array.from({ length: Math.min(deps.fileConcurrency ?? FILE_CONCURRENCY, page.rows.length) }, async () => { for (;;) { const i = next++; if (i >= page.rows.length) return; await one(i); } });
      await Promise.all(workers);
      if (entries.length) {
        const lines = entries.map((e) => JSON.stringify(e));
        st.files.n += 1;
        st.files.parts.push(await writePart('_files', st.files.n, lines));
        st.files.total += entries.length;
        for (const e of entries) if (e.backupKey) st.refs.push(e.backupKey.split('/').pop().replace(/\.enc$/, ''));
      }
      st.filesAfter = page.last;
      await checkpoint();
      if (page.done) break;
    }

    /* ---- finish: refs, then the manifest LAST */
    await putJson(storage, keys.refs(tid, date), k, [...new Set(st.refs)]);
    const counts = Object.fromEntries(Object.entries(st.tables).map(([n, r]) => [n, r.rows]));
    const manifest = {
      format: FORMAT, tenantId: tid, tenantKey: identity.tenantKey, companyName: identity.name, date,
      startedAt: st.startedAt, finishedAt: new Date(now()).toISOString(),
      tables: st.tables, counts,
      files: { ...st.files }, totalBytes: st.bytes,
    };
    await putJson(storage, keys.manifest(tid, date), k, manifest);
    await storage.del(keys.progress(tid, date)).catch(() => {});
    await storage.del(keys.lock(tid, date)).catch(() => {});
    return { status: 'complete', tenantId: tid, counts, files: st.files, bytes: st.bytes };
  } catch (err) {
    return { status: 'failed', tenantId: tid, error: scrubError(err) };
  }
}

/* ---------------------------------------------------------------- retention */

/** Snapshot dates that have a manifest (finished), for one company. */
export async function listSnapshotDates(storage, tid) {
  const { prefixes } = await storage.list(keys.snapPrefix(tid), { delimiter: '/' });
  const dates = prefixes.map((p) => p.slice(keys.snapPrefix(tid).length, -1)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  const done = [];
  for (const d of dates) if (await storage.head(keys.manifest(tid, d))) done.push(d);
  return { all: dates.sort(), done: done.sort() };
}

/**
 * Prune one company: drop snapshots outside the policy, drop unfinished snapshots from earlier days, then delete any file
 * object no kept snapshot still needs. Order matters: a file is only deleted after the snapshots that referenced it are
 * decided, and today's finished snapshot (always kept) already lists everything it needs in refs.enc.
 */
export async function pruneTenant(deps, tid, { today, policy }) {
  const { storage, masterKey } = deps;
  const k = deriveTenantKey(masterKey, tid);
  const { all, done } = await listSnapshotDates(storage, tid);
  const { keep, drop } = selectRetention(done, policy);
  const stale = all.filter((d) => !done.includes(d) && d < today); // unfinished older days: leftovers
  let deletedObjects = 0;
  for (const d of [...drop, ...stale]) {
    const { keys: ks } = await storage.list(keys.snap(tid, d));
    for (const key of ks) { await storage.del(key); deletedObjects++; }
  }
  // Mark and sweep the file objects.
  const needed = new Set();
  for (const d of keep) {
    const refs = await getJson(storage, keys.refs(tid, d), k).catch(() => null);
    if (!refs) return { dropped: drop, stale, deletedObjects, sweptFiles: 0, sweepSkipped: `no refs for ${d}` }; // unsure: delete nothing
    refs.forEach((r) => needed.add(r));
  }
  let sweptFiles = 0;
  const { keys: fileKeys } = await storage.list(keys.filesPrefix(tid));
  for (const key of fileKeys) {
    const sha = key.slice(keys.filesPrefix(tid).length).replace(/\.enc$/, '');
    if (!needed.has(sha)) { await storage.del(key); sweptFiles++; }
  }
  return { kept: keep, dropped: drop, stale, deletedObjects, sweptFiles };
}

/* ---------------------------------------------------------------- the whole nightly run */

/**
 * Walk every company, back each up (resumable across invocations), prune, then write the run status. Idempotent: a company that
 * already has today's manifest costs one HEAD request.
 * @param {object} deps  see backupTenant, plus listTenants(), policy, alert({kind, subject, text}), runId
 */
export async function runBackup(deps, { deadlineAt = Infinity } = {}) {
  const { storage, masterKey } = deps;
  const now = deps.now ?? Date.now;
  const date = utcDate(now());
  const sys = deriveSystemKey(masterKey);
  const prev = await getJson(storage, keys.run(date), sys).catch(() => null);
  const run = prev ?? { date, startedAt: new Date(now()).toISOString(), tenantsTotal: 0, done: 0, failed: [], complete: false, bytes: 0, files: { new: 0, missing: 0, hashMismatch: 0 } };
  run.invocations = (run.invocations ?? 0) + 1;

  const tenants = await deps.listTenants();
  run.tenantsTotal = tenants.length;
  const failed = new Map();
  let done = 0; let partial = 0;
  const pruneNotes = [];
  for (const t of tenants) {
    const ctx = { tenantKey: t.tenant_key, tenantName: t.tenant_name ?? t.tenant_key };
    if (now() >= deadlineAt) { partial++; continue; }
    const r = await backupTenant({ ...deps, runId: deps.runId }, ctx, { date, deadlineAt });
    if (r.status === 'complete' || r.status === 'skipped' && r.reason === 'already done') {
      done++;
      if (r.status === 'complete') {
        run.bytes += r.bytes ?? 0;
        run.files.new += r.files?.new ?? 0; run.files.missing += r.files?.missing ?? 0; run.files.hashMismatch += r.files?.hashMismatch ?? 0;
        try { pruneNotes.push(await pruneTenant(deps, r.tenantId, { today: date, policy: deps.policy })); } catch (err) { pruneNotes.push({ error: scrubError(err) }); }
      }
    } else if (r.status === 'partial' || r.status === 'skipped') partial++;
    else failed.set(r.tenantId ?? ctx.tenantKey.slice(0, 12), r.error);
  }
  run.done = done;
  run.failed = [...failed].map(([tenant, error]) => ({ tenant, error }));
  run.complete = tenants.length > 0 && done === tenants.length && failed.size === 0;
  run.updatedAt = new Date(now()).toISOString();
  run.pruneErrors = pruneNotes.filter((p) => p.error).length;
  await putJson(storage, keys.run(date), sys, run);
  if (run.complete) {
    await putJson(storage, keys.lastSuccess(), sys, { at: run.updatedAt, date, tenants: tenants.length, bytes: run.bytes });
  } else if (tenants.length === 0 && deps.alert) {
    // A listing that returns nobody must never look like success (in production this happens until M3-config/60 has been run).
    await alertOncePerDay(deps, sys, date, { kind: 'empty', date, subject: 'DeepWell backup found no companies to back up',
      text: 'The nightly backup could not list any companies, so nothing was copied. In production this usually means M3-config/60-list-all-tenant-keys.sql has not been run in Neon. See BACKUP_RUNBOOK.md ("Turning it on").' });
  } else if (run.failed.length && deps.alert) {
    await alertOncePerDay(deps, sys, date, { kind: 'failed', date, subject: `DeepWell backup FAILED for ${run.failed.length} compan${run.failed.length === 1 ? 'y' : 'ies'} (${date})`,
      text: `The nightly backup for ${date} did not finish for ${run.failed.length} of ${tenants.length} companies.\n\n${run.failed.slice(0, 10).map((f) => `- ${f.tenant}: ${f.error}`).join('\n')}\n\nNothing in production was changed. Re-run: open the operator view or wait for the next scheduled attempt; see BACKUP_RUNBOOK.md ("If a backup fails").` });
  }
  return { date, ...run, partial };
}

/* ---------------------------------------------------------------- monitoring */

/** Send an alert unless one of this kind already went out today (the marker lives in the bucket; if the bucket itself is down we send anyway). */
async function alertOncePerDay(deps, sys, day, payload) {
  const marker = keys.alertMarker(day, payload.kind);
  if (await deps.storage.head(marker).catch(() => null)) return false;
  await deps.alert(payload);
  await putJson(deps.storage, marker, sys, { at: (deps.now ?? Date.now)() }).catch(() => {});
  return true;
}

export const STALE_AFTER_HOURS = 36;

/** Is the newest successful backup older than 36 hours (or missing)? Alerts at most once per day per kind. */
export async function checkBackupHealth(deps, { maxAgeHours = STALE_AFTER_HOURS } = {}) {
  const { storage, masterKey } = deps;
  const now = deps.now ?? Date.now;
  const sys = deriveSystemKey(masterKey);
  const last = await getJson(storage, keys.lastSuccess(), sys).catch(() => null);
  const ageH = last ? (now() - new Date(last.at).getTime()) / 3_600_000 : Infinity;
  const stale = ageH > maxAgeHours;
  let alerted = false;
  if (stale && deps.alert) {
    const day = utcDate(now());
    {
      alerted = await alertOncePerDay(deps, sys, day, { kind: 'stale', date: day, subject: 'DeepWell backup is OVERDUE',
        text: last ? `The last good backup finished ${Math.floor(ageH)} hours ago (${last.at}). It should run every night.\nSee BACKUP_RUNBOOK.md ("If a backup fails").`
          : 'No successful backup has ever been recorded. Check BACKUP_RUNBOOK.md ("Turning it on").' });
    }
  }
  return { ok: !stale, lastSuccessAt: last?.at ?? null, ageHours: Number.isFinite(ageH) ? Math.round(ageH * 10) / 10 : null, stale, alerted };
}

/** For the operator view: last success, today's run, and the age. */
export async function backupStatus(deps) {
  const { storage, masterKey } = deps;
  const now = deps.now ?? Date.now;
  const sys = deriveSystemKey(masterKey);
  const last = await getJson(storage, keys.lastSuccess(), sys).catch(() => null);
  const today = await getJson(storage, keys.run(utcDate(now())), sys).catch(() => null);
  return {
    lastSuccessAt: last?.at ?? null, lastSuccessDate: last?.date ?? null, lastTenants: last?.tenants ?? null,
    ageHours: last ? Math.round(((now() - new Date(last.at).getTime()) / 3_600_000) * 10) / 10 : null,
    stale: !last || (now() - new Date(last.at).getTime()) / 3_600_000 > STALE_AFTER_HOURS,
    today: today && { complete: today.complete, done: today.done, tenantsTotal: today.tenantsTotal, failed: today.failed?.length ?? 0, updatedAt: today.updatedAt },
  };
}
