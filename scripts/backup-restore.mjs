#!/usr/bin/env node
/**
 * DeepWell backup restore tool. Run it on YOUR computer. It never touches production.
 *
 *   node scripts/backup-restore.mjs list
 *   node scripts/backup-restore.mjs verify  --tenant <org id or uuid> [--date YYYY-MM-DD] [--scratch <postgres url>] [--files all|sample|none]
 *   node scripts/backup-restore.mjs restore --tenant <org id or uuid> --target <postgres url> [--date ...] [--yes]
 *   node scripts/backup-restore.mjs restore --all --target <postgres url> --yes
 *   node scripts/backup-restore.mjs files   --tenant X --out <folder>            (their original files, readable, per company)
 *   node scripts/backup-restore.mjs handback --tenant X --out <folder>           (files + their data tables, to give to a company)
 *   node scripts/backup-restore.mjs push-files --tenant X                        (put originals back into a NEW production bucket; needs RESTORE_S3_*)
 *   node scripts/backup-restore.mjs company-key --tenant X                       (this company's own decryption key)
 *   node scripts/backup-restore.mjs purge-company --tenant X --yes               (erase ALL backups of one company, e.g. after they asked to be deleted)
 *
 * Settings come from environment variables (names only here; set them in your terminal, nothing is read from .env files):
 *   BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY   the backup bucket
 *   BACKUP_ENCRYPTION_KEY                                                                       the master key
 *   RESTORE_S3_ENDPOINT RESTORE_S3_BUCKET RESTORE_S3_ACCESS_KEY_ID RESTORE_S3_SECRET_ACCESS_KEY  (push-files only) the NEW production bucket
 * "--target" / "--scratch" must be a NEW Neon branch or a local Postgres (with the app's tables already created from M3-config/*.sql).
 * A target that looks like production is refused.
 */
import { createRequire } from 'node:module';
import { parseMasterKey, deriveTenantKey } from '../api/_lib/backup/crypto.js';
import { createS3Storage, storageConfigFromEnv } from '../api/_lib/backup/s3.js';
import { listCompanies, findCompany, restoreSnapshot, verifySnapshot, purgeCompany, writeFilesToDir, writeTablesToDir, pushFilesToStorage, assertSafeTarget } from '../api/_lib/backup/restore.js';

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? (args[i + 1]?.startsWith('--') || args[i + 1] == null ? true : args[i + 1]) : null; };
const fail = (m) => { console.error(`\n${m}\n`); process.exit(1); };

async function connect(url) {
  const require = createRequire(import.meta.url);
  const { Client } = require('pg');
  const c = new Client({ connectionString: url });
  await c.connect();
  return c;
}

async function main() {
  if (!cmd || ['help', '--help', '-h'].includes(cmd)) return console.log(`Commands: list | verify | restore | files | handback | push-files | company-key | purge-company   (see the top of this file)`);
  let masterKey; let storage;
  try { masterKey = parseMasterKey(process.env.BACKUP_ENCRYPTION_KEY); storage = createS3Storage(storageConfigFromEnv()); } catch (e) { fail(e.message); }

  if (cmd === 'list') {
    const all = await listCompanies(storage, masterKey);
    if (!all.length) return console.log('No backups found in this bucket.');
    for (const c of all) console.log(`${c.tenantKey ?? '(unreadable)'}  ${c.companyName ?? ''}\n    id ${c.tenantId}  newest ${c.latest ?? 'none'}  (${c.snapshots.length} snapshots)`);
    return;
  }
  const sel = flag('tenant');
  if (cmd === 'restore' && flag('all')) {
    const target = flag('target'); if (!target || target === true) fail('--target <postgres url> is required');
    try { assertSafeTarget(target); } catch (e) { fail(e.message); }
    if (!flag('yes')) fail('Add --yes to confirm you are restoring EVERY company into that target.');
    const client = await connect(target);
    try {
      for (const c of await listCompanies(storage, masterKey)) {
        if (!c.latest) continue;
        const r = await restoreSnapshot({ storage, masterKey, tid: c.tenantId, date: c.latest, client });
        console.log(`restored ${c.tenantKey} (${c.latest}): ${Object.values(r.tables).reduce((a, t) => a + t.present, 0)} rows`);
      }
    } finally { await client.end(); }
    return;
  }
  if (!sel || sel === true) fail('--tenant <Clerk org id or company uuid> is required (see "list").');
  const company = await findCompany(storage, masterKey, sel).catch((e) => fail(e.message));
  const date = flag('date') && flag('date') !== true ? flag('date') : company.latest;
  if (!date) fail('That company has no finished backup yet.');
  const tid = company.tenantId;

  if (cmd === 'purge-company') {
    if (!flag('yes')) fail(`This permanently erases every backup of ${company.companyName ?? company.tenantKey}. Add --yes to confirm.`);
    return console.log(await purgeCompany(storage, tid));
  }
  if (cmd === 'company-key') return console.log(deriveTenantKey(masterKey, tid).toString('hex'));
  if (cmd === 'files') { const out = flag('out'); if (!out || out === true) fail('--out <folder> is required'); return console.log(await writeFilesToDir({ storage, masterKey, tid, date, dir: out })); }
  if (cmd === 'handback') {
    const out = flag('out'); if (!out || out === true) fail('--out <folder> is required');
    console.log(await writeFilesToDir({ storage, masterKey, tid, date, dir: out })); return console.log(await writeTablesToDir({ storage, masterKey, tid, date, dir: out }));
  }
  if (cmd === 'push-files') {
    const env = process.env; const miss = ['ENDPOINT', 'BUCKET', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY'].filter((n) => !env[`RESTORE_S3_${n}`]);
    if (miss.length) fail(`Set RESTORE_S3_${miss.join(', RESTORE_S3_')} (the NEW production bucket).`);
    const target = createS3Storage({ endpoint: env.RESTORE_S3_ENDPOINT, bucket: env.RESTORE_S3_BUCKET, accessKeyId: env.RESTORE_S3_ACCESS_KEY_ID, secretAccessKey: env.RESTORE_S3_SECRET_ACCESS_KEY, region: env.RESTORE_S3_REGION || 'auto' });
    return console.log(await pushFilesToStorage({ storage, masterKey, tid, date, target }));
  }
  if (cmd === 'verify') {
    const scratch = flag('scratch'); let client = null;
    if (scratch && scratch !== true) { try { assertSafeTarget(scratch); } catch (e) { fail(e.message); } client = await connect(scratch); }
    try {
      const r = await verifySnapshot({ storage, masterKey, tid, date, client, files: flag('files') && flag('files') !== true ? flag('files') : 'sample' });
      console.log(JSON.stringify({ ...r, restored: r.restored && Object.fromEntries(Object.entries(r.restored).map(([t, v]) => [t, `${v.present}/${v.expected}`])) }, null, 2));
      console.log(r.ok ? '\nVERIFY OK: every object matches its checksum and decrypts' + (client ? ', and the scratch restore matches the manifest counts (rolled back, scratch DB left empty).' : '.') : '\nVERIFY FAILED - see "problems" above.');
      process.exitCode = r.ok ? 0 : 2;
    } finally { await client?.end(); }
    return;
  }
  if (cmd === 'restore') {
    const target = flag('target'); if (!target || target === true) fail('--target <postgres url> is required (a NEW Neon branch or a local Postgres).');
    try { assertSafeTarget(target); } catch (e) { fail(e.message); }
    if (!flag('yes') && !/localhost|127\.0\.0\.1/.test(target)) fail('Add --yes to confirm the target is a NEW branch, not production.');
    const client = await connect(target);
    try {
      const r = await restoreSnapshot({ storage, masterKey, tid, date, client });
      for (const w of r.warnings) console.log(`note: ${w}`);
      for (const [t, v] of Object.entries(r.tables)) console.log(`${t.padEnd(28)} ${String(v.inserted).padStart(8)} added, ${String(v.present).padStart(8)} now there (backup had ${v.expected})`);
      console.log('\nDone. Original files are NOT in the database: run "push-files" (disaster) or "files" (copy to a folder).');
    } finally { await client.end(); }
    return;
  }
  fail(`Unknown command "${cmd}".`);
}
main().catch((e) => fail(`Failed: ${e.message}`));
