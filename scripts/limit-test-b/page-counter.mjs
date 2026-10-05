/**
 * PAGE COUNTER (H-4): the monthly page meter must not give pages back when documents are deleted.
 * Handlers run in-process on PGlite (no R2: presign is local HMAC; R2 reads are faked with a stubbed fetch).
 *   npx tsx --import ./scripts/limit-test-b/register.mjs scripts/limit-test-b/page-counter.mjs
 *
 * Design under test: M3-config/67-page-usage-counter.sql (table page_usage_monthly + statement-level AFTER INSERT trigger on
 * document_pages) and the read side recordsStore.countPagesSince = GREATEST(counter this UTC month, live count).
 * Ids PCx1..PCx15 follow the engineering brief. Every check must FAIL on main 797abd7 (no migration 67, live count only).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { boot, adminTok, mkReq, mkRes, quiet } from './lib.mjs';

const { h, check, setFamily, finish } = await boot();
const { lite, RS, PLAN, newTenant, root, resetCaches } = h;
const imp = (p) => import(path.join(root, p));
const UPH = await imp('api/upload-url.js');
const UP = UPH.default;
const REVIEW = (await imp('api/review.js')).default;
const BILLING = (await imp('api/billing.js')).default;
const RECORDS = await imp('api/records.ts');
const OPS = await imp('api/_lib/opsStore.js');
const READ = await imp('api/_lib/readDocument.js');
const SI = await imp('api/_lib/staffImport.js');
const MIG_PATH = path.join(root, 'M3-config/67-page-usage-counter.sql');
const sha = () => crypto.randomBytes(32).toString('hex');
const D = 86_400_000, H = 3_600_000;

const ctxOf = (org) => ({ tenantKey: org, tenantName: org });
const W = (org, fn) => RS.withTenant(ctxOf(org), fn);
const tid = async (org) => (await RS.getTenantContext(org, org)).id;
const sinceIso = () => new Date(Date.now() - 30 * D).toISOString();
const pagesNow = (org) => W(org, (db) => db.countPagesSince(sinceIso()));
const post = async (org, body) => { const res = mkRes(); await quiet(() => UP(mkReq({ token: adminTok(org), body }), res)); return res; };
const file = (over = {}) => ({ filename: 'a.txt', sha256: sha(), sizeBytes: 100, contentType: 'text/plain', ...over });
const authFor = (key) => ({ tenantId: key, orgId: key, userId: 'user_admin', orgRole: 'admin' });
const MONTH_SQL = `(date_trunc('month', now() AT TIME ZONE 'UTC'))::date`;
const MONTH_START_TS = `(date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`; // timestamptz
const PREV_MID_TS = `((date_trunc('month', now() AT TIME ZONE 'UTC') - interval '10 days') AT TIME ZONE 'UTC')`; // inside last month

/** counter row for (org, month offset from the current UTC month); null when the table or the row is missing */
async function counter(org, off = 0) {
  try {
    const r = await lite.query(`SELECT pages::bigint AS p FROM page_usage_monthly WHERE tenant_id = $1 AND month = (${MONTH_SQL} + $2 * interval '1 month')::date`, [await tid(org), off]);
    return r.rows[0] ? Number(r.rows[0].p) : null;
  } catch { return null; }
}
const tableExists = async () => (await lite.query(`SELECT to_regclass('public.page_usage_monthly') IS NOT NULL AS ok`)).rows[0].ok;
const resetProbe = () => { RS._resetPageCounterProbe?.(); resetCaches(); };
async function mkDoc(org) {
  const id = await tid(org);
  const r = await lite.query(`INSERT INTO documents (tenant_id, original_filename, sha256_hash, file_size_bytes, content_type, storage_key, stage) VALUES ($1,'h.txt',$2,100,'text/plain',$3,'mapped') RETURNING id`, [id, sha(), `${id}/h/${sha().slice(0, 10)}`]);
  return r.rows[0].id;
}
const pageObjs = (n, from = 1) => Array.from({ length: n }, (_, i) => ({ page_no: from + i, text: `page ${from + i}` }));
/** the REAL write path (readDocument/queue call db.upsertPages inside withTenant) */
const upsert = (org, docId, n, from = 1) => W(org, (db) => db.upsertPages(docId, pageObjs(n, from)));
/** plain-SQL seed (staff tooling / tests): n pages at a timestamptz SQL expression */
async function seedSql(org, docId, n, tsSql = 'now()', from = 1) {
  await lite.query(`INSERT INTO document_pages (tenant_id, document_id, page_no, text, created_at) SELECT $1,$2,g,'p', ${tsSql} FROM generate_series($3::int,$4::int) g`, [await tid(org), docId, from, from + n - 1]);
}
const tenantLimits = async (org, limits) => { await lite.query('UPDATE tenants SET limits = $2::jsonb WHERE id = $1', [await tid(org), JSON.stringify(limits)]); resetCaches(); };
const del = async (org, ids) => { const res = mkRes(); await quiet(() => REVIEW(mkReq({ token: adminTok(org), body: { action: 'deleteDocuments', documentIds: ids } }), res)); resetCaches(); return res; };
const applyMig = async (stripTx = false) => {
  let sql = fs.readFileSync(MIG_PATH, 'utf8');
  if (stripTx) sql = sql.replace(/^\s*(BEGIN|COMMIT);\s*$/gim, '');
  await lite.exec(sql);
  resetProbe();
};
const migExists = fs.existsSync(MIG_PATH);
// PCx10b-d need the optional loadRescueCredit change (see the report). Without it they are reported as SKIP, not counted.
const RESCUE_FIX = /page_usage_months/.test(fs.readFileSync(path.join(root, 'api/_lib/plan.js'), 'utf8'));
const checkRescue = (id, name, ok, detail) => RESCUE_FIX ? check(id, name, ok, detail) : console.log(`SKIP  [PCx10] ${id} ${name} (loadRescueCredit untouched in this patch)`);
const capture = async (fn) => { try { return await fn(); } catch (e) { return { __err: String(e?.message ?? e).slice(0, 160) }; } };
const iso = (ms) => new Date(ms).toISOString();

/* ================================================================= PCx1 delete-and-reupload at the cap, real path */
setFamily('PCx1-2');
{
  const ORG = 'org_pc1'; await newTenant(ORG, 'solo', 'active', PLAN.PLAN_LIMITS.solo);
  const doc = await mkDoc(ORG);
  await upsert(ORG, doc, 750); resetCaches();
  const refused = await post(ORG, file({ filename: 'x1.txt' }));
  const msg = refused.body?.error ?? '';
  check('PCx1a', 'Solo at 750 pages read through upsertPages: next upload is 402 "Monthly page limit reached (750)."', refused.statusCode === 402 && msg.startsWith('Monthly page limit reached (750).'), `${refused.statusCode} ${msg}`);
  const dres = await del(ORG, [doc]);
  check('PCx1b', 'admin deleteDocuments through api/review.js succeeds and the live page rows are gone', dres.statusCode === 200 && (await lite.query(`SELECT count(*)::int n FROM document_pages WHERE tenant_id=$1`, [await tid(ORG)])).rows[0].n === 0, `${dres.statusCode} ${JSON.stringify(dres.body)}`);
  const after = await post(ORG, file({ filename: 'x2.txt' }));
  check('PCx1c', 'AFTER the delete the next upload is STILL 402 with the identical message and the same number (750)', after.statusCode === 402 && after.body?.error === msg, `${after.statusCode} ${after.body?.error}`);
  const after2 = await post(ORG, { files: [file({ filename: 'b1.txt' }), file({ filename: 'b2.txt' })] });
  check('PCx1d', 'a batch after the delete is refused too (402, no document created)', after2.statusCode === 402 && /^Monthly page limit reached \(750\)\./.test(after2.body?.error ?? '') && (await lite.query(`SELECT count(*)::int n FROM documents WHERE original_filename IN ('b1.txt','b2.txt')`)).rows[0].n === 0, JSON.stringify(after2.body)?.slice(0, 250));
  check('PCx1e', 'countPagesSince still reports 750 after the delete', (await pagesNow(ORG)) === 750, String(await pagesNow(ORG)));
  // 749 then delete: 1 page of room both before and after
  const ORGb = 'org_pc1b'; await newTenant(ORGb, 'solo', 'active', PLAN.PLAN_LIMITS.solo);
  const docb = await mkDoc(ORGb); await upsert(ORGb, docb, 749); resetCaches();
  const ok1 = await post(ORGb, file({ filename: 'one.txt' }));
  await del(ORGb, [docb]);
  const ok2 = await post(ORGb, file({ filename: 'two.txt', sizeBytes: 100 })); // second 1-page file would reach 750 + pending; the first document is pending 1 page
  check('PCx1f', '749 read: one more file fits (200); after deleting the 749-page document the room did NOT grow back (second file refused: 749 + 1 pending = 750)', ok1.statusCode === 200 && ok2.statusCode === 402, `${ok1.statusCode}/${ok2.statusCode} ${ok2.body?.error}`);
}

/* ================================================================= PCx2 month boundary */
{
  const ORG = 'org_pc2'; await newTenant(ORG, 'solo', 'active', PLAN.PLAN_LIMITS.solo);
  const docL = await mkDoc(ORG), docT = await mkDoc(ORG);
  await seedSql(ORG, docL, 300, PREV_MID_TS);        // last month
  await seedSql(ORG, docT, 40, 'now()');             // this month
  resetCaches();
  check('PCx2a', 'seeded last-month pages land in LAST month counter (300) and this month in this month (40)', (await counter(ORG, -1)) === 300 && (await counter(ORG, 0)) === 40, `${await counter(ORG, -1)} / ${await counter(ORG, 0)}`);
  check('PCx2b', 'this month shows 40 (last month does not carry into it)', (await pagesNow(ORG)) === 40, String(await pagesNow(ORG)));
  await del(ORG, [docL]);
  check('PCx2c', 'deleting last month\'s pages changes nothing this month', (await pagesNow(ORG)) === 40 && (await counter(ORG, 0)) === 40);
  await del(ORG, [docT]);
  check('PCx2d', 'deleting THIS month\'s pages still leaves 40 counted this month; last month counter is untouched (300)', (await pagesNow(ORG)) === 40 && (await counter(ORG, -1)) === 300, `${await pagesNow(ORG)} / ${await counter(ORG, -1)}`);
}

/* ================================================================= PCx3 re-read, PCx4 failed read (real ingestDocument) */
setFamily('PCx3-4');
const realFetch = globalThis.fetch;
{
  const ORG = 'org_pc3'; await newTenant(ORG, 'shop', 'active', PLAN.PLAN_LIMITS.shop);
  const id = await tid(ORG);
  const text = ('Invoice line for compressor service at 12 Main St. ' + 'x'.repeat(40) + '\n').repeat(300); // ~15k chars = 3 pages of 6,000
  const key = `${id}/doc/${sha().slice(0, 8)}`;
  const d = (await lite.query(`INSERT INTO documents (tenant_id, original_filename, sha256_hash, file_size_bytes, content_type, storage_key, stage) VALUES ($1,'inv.txt',$2,$3,'text/plain',$4,'received') RETURNING id`, [id, sha(), text.length, key])).rows[0].id;
  let mode = 'ok';
  globalThis.fetch = async () => mode === 'ok' ? new Response(Buffer.from(text), { status: 200, headers: { 'content-type': 'text/plain' } }) : new Response('nope', { status: 404 });
  try {
    // PCx4 first: failed read stores no pages
    mode = 'missing';
    const e1 = await capture(() => READ.ingestDocument(ctxOf(ORG), d, { userId: 'user_admin' }));
    check('PCx4a', 'a read whose file is missing (R2 404) throws and stores no pages', !!e1?.__err && (await lite.query(`SELECT count(*)::int n FROM document_pages WHERE tenant_id=$1`, [id])).rows[0].n === 0, JSON.stringify(e1));
    check('PCx4b', '...and does not count: counter absent/0 and countPagesSince 0', ((await counter(ORG)) ?? 0) === 0 && (await pagesNow(ORG)) === 0, `${await counter(ORG)} ${await pagesNow(ORG)}`);
    // unreadable (blank) text: IngestError 422, no pages
    mode = 'ok';
    const blankKey = `${id}/doc/${sha().slice(0, 8)}`;
    const dBlank = (await lite.query(`INSERT INTO documents (tenant_id, original_filename, sha256_hash, file_size_bytes, content_type, storage_key, stage) VALUES ($1,'blank.txt',$2,3,'text/plain',$3,'received') RETURNING id`, [id, sha(), blankKey])).rows[0].id;
    globalThis.fetch = async () => new Response(Buffer.from('   \n  '), { status: 200 });
    const e2 = await capture(() => READ.ingestDocument(ctxOf(ORG), dBlank, { userId: 'user_admin' }));
    check('PCx4c', 'a blank file (422 "no readable text") stores no pages and the counter does not move', !!e2?.__err && ((await counter(ORG)) ?? 0) === 0 && (await pagesNow(ORG)) === 0, JSON.stringify(e2));
    // successful first read
    globalThis.fetch = async () => new Response(Buffer.from(text), { status: 200 });
    const r1 = await capture(() => READ.ingestDocument(ctxOf(ORG), d, { userId: 'user_admin' }));
    const n1 = (await lite.query(`SELECT count(*)::int n FROM document_pages WHERE document_id=$1`, [d])).rows[0].n;
    check('PCx3a', 'first read stores its pages (5 for this ~15k-char text) and counts exactly that many', n1 >= 3 && (await counter(ORG)) === n1 && (await pagesNow(ORG)) === n1, `${JSON.stringify(r1)} n=${n1} counter=${await counter(ORG)} count=${await pagesNow(ORG)}`);
    // forced re-read of the SAME document (ON CONFLICT DO UPDATE path)
    const r2 = await capture(() => READ.ingestDocument(ctxOf(ORG), d, { userId: 'user_admin', force: true }));
    check('PCx3b', 'forced re-read of the already-counted document: counter unchanged (an upsert that updates adds 0)', (await counter(ORG)) === n1 && (await pagesNow(ORG)) === n1 && !r2?.__err, `${JSON.stringify(r2)} counter=${await counter(ORG)} count=${await pagesNow(ORG)}`);
    // direct upsertPages twice
    await upsert(ORG, d, n1); await upsert(ORG, d, n1);
    check('PCx3c', 'upsertPages called twice more with the same page numbers: counter unchanged', (await counter(ORG)) === n1, String(await counter(ORG)));
    // partial overlap: pages 4..(n1+3) -> 4 and 5 exist, the 3 above are new
    await upsert(ORG, d, n1, 4);
    check('PCx3d', 'upsert of pages 4-8 where 4,5 exist: only the 3 NEW rows are counted', (await counter(ORG)) === n1 + 3 && (await pagesNow(ORG)) === n1 + 3, `${await counter(ORG)} ${await pagesNow(ORG)}`);
    // recheck path ($0 re-read of stored text)
    const rc = await capture(() => import(path.join(root, 'api/_lib/recheck.js')).then((m) => m.recheckDocument(ctxOf(ORG), d, { actorClerkId: 'user_admin' })));
    check('PCx3e', 'recheckDocument (re-read of stored text) leaves the counter unchanged', (await counter(ORG)) === n1 + 3, `${JSON.stringify(rc)?.slice(0, 120)} counter=${await counter(ORG)}`);
  } finally { globalThis.fetch = realFetch; }
}

/* ================================================================= PCx5 isolation across three companies + RLS */
setFamily('PCx5');
{
  const [A, B, C] = ['org_pc5a', 'org_pc5b', 'org_pc5c'];
  for (const o of [A, B, C]) await newTenant(o, 'shop', 'active', PLAN.PLAN_LIMITS.shop);
  const dA = await mkDoc(A), dB = await mkDoc(B), dC = await mkDoc(C);
  await upsert(A, dA, 120); await upsert(B, dB, 70); await upsert(C, dC, 33);
  const before = { b: await counter(B), c: await counter(C), nb: await pagesNow(B), nc: await pagesNow(C) };
  check('PCx5a', 'three companies counted separately: A 120, B 70, C 33', (await counter(A)) === 120 && before.b === 70 && before.c === 33, `${await counter(A)}/${before.b}/${before.c}`);
  await del(A, [dA]); await upsert(A, await mkDoc(A), 5);
  const bRows = JSON.stringify((await lite.query(`SELECT month, pages FROM page_usage_monthly WHERE tenant_id=$1`, [await tid(B)]).catch(() => ({ rows: [] }))).rows);
  check('PCx5b', 'A reads/deletes: A is 125 (120 stays + 5 new); B (70) and C (33) numbers and rows unchanged', (await counter(A)) === 125 && (await counter(B)) === 70 && (await counter(C)) === 33 && (await pagesNow(B)) === 70 && (await pagesNow(C)) === 33 && JSON.parse(bRows).length === 1, `${await counter(A)}/${await counter(B)}/${await counter(C)} ${bRows}`);
  // RLS from B's session
  const aId = await tid(A);
  const seen = await capture(() => W(B, async (db) => (await db.raw(`SELECT tenant_id::text t FROM page_usage_monthly`, [])).rows.map((r) => r.t)));
  check('PCx5c', 'company B\'s session sees only its OWN counter rows (not A, not C)', Array.isArray(seen) && seen.length >= 1 && seen.every((t) => t === undefined ? false : true) && !seen.includes(aId), JSON.stringify(seen));
  const upd = await capture(() => W(B, async (db) => (await db.raw(`UPDATE page_usage_monthly SET pages = 0 WHERE tenant_id = $1`, [aId])).rowCount));
  check('PCx5d', 'B cannot UPDATE A\'s counter row (0 rows affected) and A is still 125', upd === 0 && (await counter(A)) === 125, `${JSON.stringify(upd)} ${await counter(A)}`);
  const dl = await capture(() => W(B, async (db) => (await db.raw(`DELETE FROM page_usage_monthly WHERE tenant_id = $1`, [aId])).rowCount));
  check('PCx5e', 'B cannot DELETE A\'s counter row (0 rows) and A is still 125', dl === 0 && (await counter(A)) === 125, `${JSON.stringify(dl)} ${await counter(A)}`);
  const ins = await capture(() => W(B, async (db) => db.raw(`INSERT INTO page_usage_monthly (tenant_id, month, pages) VALUES ($1, '2001-01-01', 5)`, [aId])));
  check('PCx5f', 'B cannot INSERT a counter row for A (row-level security rejects it)', !!ins?.__err && /row-level security|permission denied/i.test(ins.__err), JSON.stringify(ins));
  const noSess = await capture(async () => { const r = await lite.query(`SET ROLE deepwell_rls`).then(() => lite.query(`SELECT count(*)::int n FROM page_usage_monthly`)).finally(() => lite.query('RESET ROLE')); return r.rows[0].n; });
  check('PCx5g', 'a session with NO company set sees no counter rows (0 rows, or the usual fail-closed uuid error)', noSess === 0 || /invalid input syntax for type uuid/.test(noSess?.__err ?? ''), JSON.stringify(noSess));
  const rls = (await lite.query(`SELECT relrowsecurity r, relforcerowsecurity f FROM pg_class WHERE oid = to_regclass('public.page_usage_monthly')`).catch(() => ({ rows: [] }))).rows[0];
  check('PCx5h', 'page_usage_monthly has ENABLE + FORCE row level security', rls?.r === true && rls?.f === true, JSON.stringify(rls));
}

/* ================================================================= PCx9 staff import pages (before PCx6-8 which rebuild the table) */
setFamily('PCx9');
{
  const ORG = 'org_pc9'; await newTenant(ORG, 'solo', 'active', {});
  const now = Date.now();
  const si = (over = {}) => ({ from: iso(now - H), until: iso(now + 10 * D), pages: 5000, documents: 1000, ingestPerMinute: 600, ingestPerDay: 200_000, maxModelCallsPerDay: 150_000, ...over });
  await tenantLimits(ORG, { staffImport: si() });
  const win = SI.staffImportWindowFor({ limits: { staffImport: si() } });
  const doc = await mkDoc(ORG);
  await upsert(ORG, doc, 800);                          // 800 pages read INSIDE the window through the real path
  resetCaches();
  const between = await W(ORG, (db) => db.countPagesBetween(win.from, win.to));
  check('PCx9a', 'import pages are NOT counted in the monthly counter (counter absent/0; countPagesSince 0)', ((await counter(ORG)) ?? 0) === 0 && (await pagesNow(ORG)) === 0, `${await counter(ORG)} ${await pagesNow(ORG)}`);
  check('PCx9b', '...but countPagesBetween (import budget) still sees all 800', between === 800, String(between));
  const g = await UPH.checkUploadGate(authFor(ORG));
  check('PCx9c', 'import gate: Solo past its 750 cap is still allowed, against the import budget (4,200 left of 5,000)', g.allowed === true && g.importMode === true && g.pagesRemaining === 4200, JSON.stringify({ ...g, billingRow: undefined }));
  await tenantLimits(ORG, { staffImport: si({ pages: 800 }) });
  const g2 = await UPH.checkUploadGate(authFor(ORG));
  check('PCx9d', 'import budget of 800 with 800 read -> 402 code import-allowance-exhausted', g2.allowed === false && g2.status === 402 && g2.code === 'import-allowance-exhausted', JSON.stringify({ ...g2, billingRow: undefined }));
  await new Promise((r) => setTimeout(r, 30));
  await tenantLimits(ORG, { staffImport: si({ endedAt: iso(Date.now() - 5) }) });
  const g3 = await UPH.checkUploadGate(authFor(ORG));
  check('PCx9e', 'after the import is CLOSED the customer has their whole 750 allowance (import pages never counted)', g3.allowed === true && !g3.importMode && g3.pagesRemaining === 750, JSON.stringify({ ...g3, billingRow: undefined }));
  const doc2 = await mkDoc(ORG);
  await upsert(ORG, doc2, 10);                          // after the end: ordinary customer pages
  check('PCx9f', 'pages read after the window ended count normally (10)', (await counter(ORG)) === 10 && (await pagesNow(ORG)) === 10, `${await counter(ORG)} ${await pagesNow(ORG)}`);
  await del(ORG, [doc, doc2]);
  check('PCx9g', 'deleting import and customer documents leaves the 10 customer pages counted', (await pagesNow(ORG)) === 10, String(await pagesNow(ORG)));
  // plain-SQL seed inside the window (staff tooling / existing verify-r43 scenarios) is excluded by the trigger too
  const ORG2 = 'org_pc9b'; await newTenant(ORG2, 'solo', 'active', {});
  await tenantLimits(ORG2, { staffImport: si() });
  await seedSql(ORG2, await mkDoc(ORG2), 800, `now() - interval '30 minutes'`);
  check('PCx9h', 'a plain-SQL insert INSIDE the window is not counted either (every writer is covered)', ((await counter(ORG2)) ?? 0) === 0 && (await pagesNow(ORG2)) === 0, `${await counter(ORG2)} ${await pagesNow(ORG2)}`);
}

/* ================================================================= PCx10 Records Rescue */
setFamily('PCx10');
{
  const ORG = 'org_pc10'; const owner = { plan: 'solo', pagesPerMonth: 750, extraPagesPerMonth: 100 };
  const id = await newTenant(ORG, 'solo', 'active', owner);
  const credit = () => W(ORG, (db) => PLAN.loadRescueCredit(db, { plan: 'solo', limits: owner }));
  await lite.query(`INSERT INTO billing_events (id, type, tenant_id, received_at, payload) VALUES ('evt_pc10', 'checkout.session.completed', $1, now() - interval '75 days', '{"rescuePages": 5000, "sessionId":"cs_pc10"}'::jsonb)`, [id]);
  const doc = await mkDoc(ORG);
  await seedSql(ORG, doc, 1850, `(date_trunc('month', now() AT TIME ZONE 'UTC' - interval '2 months') + interval '3 days') AT TIME ZONE 'UTC'`, 1);
  await seedSql(ORG, doc, 300, `(date_trunc('month', now() AT TIME ZONE 'UTC' - interval '1 month') + interval '3 days') AT TIME ZONE 'UTC'`, 5001);
  await seedSql(ORG, doc, 400, 'now()', 9001);
  resetCaches();
  const c1 = await credit();
  check('PCx10a', 'numbers unchanged for the r36 scenario: 1,850 pages two months ago (allowance 850) used 1,000; 300 last month used none; remaining 4,000', c1.granted === 5000 && c1.used === 1000 && c1.remaining === 4000, JSON.stringify(c1));
  await lite.query(`DELETE FROM document_pages WHERE tenant_id=$1 AND page_no <= 1850`, [id]); resetCaches();
  const c2 = await credit();
  checkRescue('PCx10b', 'deleting the previous-month documents does NOT raise the remaining credit', c2.used === 1000 && c2.remaining === 4000, JSON.stringify(c2));
  const c3 = await credit();
  checkRescue('PCx10c', 'this month\'s pages are headroom, never spent from the credit (unchanged)', c3.remaining === 4000 && c3.granted === 5000, JSON.stringify(c3));
  await del(ORG, [doc]);
  const c4 = await credit();
  checkRescue('PCx10d', 'deleting every document: credit still not given back (used 1,000, remaining 4,000)', c4.used === 1000 && c4.remaining === 4000, JSON.stringify(c4));
}

/* ================================================================= PCx11 same number everywhere */
setFamily('PCx11');
{
  const ORG = 'org_pc11'; await newTenant(ORG, 'shop', 'active', PLAN.PLAN_LIMITS.shop);
  const doc = await mkDoc(ORG); await upsert(ORG, doc, 600);
  const doc2 = await mkDoc(ORG); await upsert(ORG, doc2, 400);
  const numbers = async () => {
    resetCaches();
    const st = mkRes(); await quiet(() => BILLING(mkReq({ method: 'GET', token: adminTok(ORG), query: { action: 'status' } }), st));
    const bo = mkRes(); await quiet(() => RECORDS.processRecords({ method: 'POST', headers: {}, body: { action: 'bootstrap' } }, bo, authFor(ORG)));
    const gate = await UPH.checkUploadGate(authFor(ORG));
    return { billing: st.body?.usage?.pagesThisMonth, bootstrap: bo.body?.billing?.usage?.pagesThisMonth, store: await pagesNow(ORG), gateLeft: gate.pagesRemaining, billingStatus: st.statusCode };
  };
  const a = await numbers();
  check('PCx11a', 'before deleting: Billing status, phone bootstrap and the gate all agree (1,000 read, 1,000 left of 2,000)', a.billing === 1000 && a.bootstrap === 1000 && a.store === 1000 && a.gateLeft === 1000, JSON.stringify(a));
  await del(ORG, [doc]);
  const b = await numbers();
  check('PCx11b', 'after deleting the 600-page document all three still agree on 1,000 (gate room 1,000)', b.billing === 1000 && b.bootstrap === 1000 && b.store === 1000 && b.gateLeft === 1000, JSON.stringify(b));
  await del(ORG, [doc2]);
  const c = await numbers();
  check('PCx11c', 'after deleting everything: still 1,000 on every surface', c.billing === 1000 && c.bootstrap === 1000 && c.store === 1000 && c.gateLeft === 1000, JSON.stringify(c));
  const tools = await imp('api/_lib/support/tools.js');
  const pu = await capture(() => tools.getPlanAndUsage(authFor(ORG)));
  check('PCx11d', 'the support assistant\'s pagesLast30d is the same number (1,000)', pu?.pagesLast30d === 1000, JSON.stringify(pu)?.slice(0, 200));
}

/* ================================================================= PCx12 whole-company delete, PCx13 merge + customer delete */
setFamily('PCx12-13');
{
  const [A, B] = ['org_pc12a', 'org_pc12b'];
  for (const o of [A, B]) await newTenant(o, 'shop', 'active', PLAN.PLAN_LIMITS.shop);
  await upsert(A, await mkDoc(A), 50); await upsert(B, await mkDoc(B), 60);
  const res = await capture(() => OPS.deleteTenantData(ctxOf(A)));
  check('PCx12a', '"delete all my data" keeps the monthly tally (the paid allowance cannot be reset that way) and the live pages are gone (the meter still reads 50)', (await counter(A)) === 50 && (await pagesNow(A)) === 50 && (await lite.query(`SELECT count(*)::int n FROM document_pages WHERE tenant_id=$1`, [await tid(A)])).rows[0].n === 0 && !res?.__err, `${JSON.stringify(res)?.slice(0, 160)} counter=${await counter(A)}`);
  check('PCx12b', '...and other companies\' rows stay (B still 60)', (await counter(B)) === 60 && (await pagesNow(B)) === 60, `${await counter(B)}`);
  check('PCx12c', '...page_usage_monthly is listed in RETAINED_TABLES, not DELETE_ORDER, and is not swept as a straggler', !!OPS.RETAINED_TABLES.page_usage_monthly && !OPS.DELETE_ORDER.includes('page_usage_monthly') && !(res?.stragglers ?? []).includes('page_usage_monthly'), JSON.stringify(res?.stragglers));
  const aId = await tid(A);
  await lite.query(`DELETE FROM tenants WHERE id = $1`, [aId]);
  const left = (await lite.query(`SELECT count(*)::int n FROM page_usage_monthly WHERE tenant_id = $1`, [aId])).rows[0].n;
  check('PCx12d', 'deleting the company itself (the tenants row) removes its tally through the foreign key; B untouched', left === 0 && (await counter(B)) === 60, `left=${left}`);
  // merge_tenant
  const SOLO = 'user_pc13solo', SHOP = 'org_pc13shop';
  await newTenant(SOLO, 'solo', 'active', {}); await newTenant(SHOP, 'shop', 'active', PLAN.PLAN_LIMITS.shop);
  const dShop = await mkDoc(SHOP); await upsert(SHOP, dShop, 200);
  const dSolo = await mkDoc(SOLO); await upsert(SOLO, dSolo, 30);
  const beforeShop = await counter(SHOP);
  const mres = await capture(() => lite.query(`SELECT * FROM merge_tenant($1, $2)`, [SOLO, SHOP]));
  resetCaches();
  const afterShop = await counter(SHOP);
  check('PCx13a', 'merge_tenant (UPDATEs document_pages.tenant_id) does not lower the surviving company\'s counter', !mres?.__err && beforeShop === 200 && afterShop === 200 && (await pagesNow(SHOP)) >= 200, `${JSON.stringify(mres)?.slice(0, 120)} before=${beforeShop} after=${afterShop} count=${await pagesNow(SHOP)}`);
  await del(SHOP, [dShop]);
  const shopId = await tid(SHOP); const cust = await capture(() => lite.query(`DELETE FROM entities WHERE tenant_id = $1`, [shopId]));
  check('PCx13b', 'deleting documents and customers of the survivor leaves its counter (200)', (await counter(SHOP)) === 200 && (await pagesNow(SHOP)) >= 200 && !cust?.__err, `${await counter(SHOP)} ${await pagesNow(SHOP)}`);
}

/* ================================================================= PCx14 batch bump + concurrency, PCx15 month rollover */
setFamily('PCx14-15');
{
  const ORG = 'org_pc14'; await newTenant(ORG, 'fleet', 'active', PLAN.PLAN_LIMITS.fleet);
  const doc = await mkDoc(ORG);
  await upsert(ORG, doc, 40);
  check('PCx14a', 'a 40-page insert makes the counter exactly 40', (await counter(ORG)) === 40, String(await counter(ORG)));
  const tg = (await lite.query(`SELECT tgtype::int t, tgname, (SELECT relname FROM pg_class WHERE oid=tgrelid) tbl FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = 'document_pages'::regclass AND tgname LIKE '%usage%'`).catch(() => ({ rows: [] }))).rows;
  check('PCx14b', 'the counting trigger is a STATEMENT-level AFTER INSERT trigger (row bit 0, insert bit 4, after = bit 2 clear)', tg.length === 1 && (tg[0].t & 1) === 0 && (tg[0].t & 4) === 4 && (tg[0].t & 2) === 0, JSON.stringify(tg));
  const docs = await Promise.all(Array.from({ length: 20 }, () => mkDoc(ORG)));
  await Promise.all(docs.map((d, i) => upsert(ORG, d, 5 + (i % 3))));
  const want = docs.reduce((s, _, i) => s + 5 + (i % 3), 40);
  check('PCx14c', '20 concurrent upsertPages for one company sum correctly (no lost update)', (await counter(ORG)) === want && (await pagesNow(ORG)) === want, `${await counter(ORG)} / ${await pagesNow(ORG)} want ${want}`);
  // PCx15
  const R = 'org_pc15'; await newTenant(R, 'fleet', 'active', PLAN.PLAN_LIMITS.fleet);
  const dr = await mkDoc(R);
  await seedSql(R, dr, 7, `(${MONTH_START_TS} - interval '1 second')`, 1);       // 23:59:59 UTC last day of previous month
  await seedSql(R, dr, 11, `${MONTH_START_TS}`, 100);                             // 00:00:00 UTC on the 1st
  check('PCx15a', '23:59:59 UTC on the last day lands in LAST month (7); 00:00:00 UTC on the 1st lands in THIS month (11)', (await counter(R, -1)) === 7 && (await counter(R, 0)) === 11, `${await counter(R, -1)} / ${await counter(R, 0)}`);
  check('PCx15b', 'countPagesSince shows 11 (last month\'s 7 are not this month\'s)', (await pagesNow(R)) === 11, String(await pagesNow(R)));
  const R2 = 'org_pc15b'; await newTenant(R2, 'fleet', 'active', PLAN.PLAN_LIMITS.fleet);
  const dr2 = await mkDoc(R2);
  await lite.query(`SET TIME ZONE 'Pacific/Auckland'`);
  try {
    await seedSql(R2, dr2, 3, `(${MONTH_START_TS} - interval '1 second')`, 1);
    await seedSql(R2, dr2, 5, `${MONTH_START_TS}`, 50);
  } finally { await lite.query('RESET TIME ZONE'); }
  check('PCx15c', 'the month bucket is UTC whatever the session time zone is (Auckland session: 3 last month / 5 this month)', (await counter(R2, -1)) === 3 && (await counter(R2, 0)) === 5, `${await counter(R2, -1)} / ${await counter(R2, 0)}`);
}

/* ================================================================= PCx6 migration not applied -> exactly as today; then apply to a populated DB */
setFamily('PCx6');
const PC6 = ['org_pc6a', 'org_pc6b', 'org_pc6c', 'org_pc6d'];
{
  // Take the counter away completely (trigger + table), as on a database that never ran migration 67.
  await lite.exec(`DROP TRIGGER IF EXISTS document_pages_usage_count ON document_pages; DROP TABLE IF EXISTS page_usage_monthly CASCADE;`);
  resetProbe();
  check('PCx6a', 'precondition: no page_usage_monthly table in the test database', !(await tableExists()));
  await newTenant(PC6[0], 'solo', 'active', PLAN.PLAN_LIMITS.solo);
  await newTenant(PC6[1], 'shop', 'active', PLAN.PLAN_LIMITS.shop);
  await newTenant(PC6[2], 'solo', 'active', {});
  await newTenant(PC6[3], 'fleet', 'active', PLAN.PLAN_LIMITS.fleet);
  const docs = [];
  for (const o of PC6) docs.push(await mkDoc(o));
  await upsert(PC6[0], docs[0], 749);
  await upsert(PC6[1], docs[1], 1200);
  await seedSql(PC6[3], docs[3], 25, PREV_MID_TS, 1);
  await seedSql(PC6[3], docs[3], 9, 'now()', 100);
  const bad = await mkDoc(PC6[0]); // a failed read stores nothing
  resetCaches();
  const nums = async () => Object.fromEntries(await Promise.all(PC6.map(async (o) => [o, await pagesNow(o)])));
  const n0 = await nums();
  check('PCx6b', 'without the migration the numbers are the live count (749, 1200, 0, 9)', n0[PC6[0]] === 749 && n0[PC6[1]] === 1200 && n0[PC6[2]] === 0 && n0[PC6[3]] === 9, JSON.stringify(n0));
  const up = await post(PC6[0], file({ filename: 'ok.txt' }));
  const up2 = await post(PC6[0], file({ filename: 'ok2.txt' }));
  check('PCx6c', 'uploads work as today without the table: 749 read + 1 more file fits (200), the next is refused (402)', up.statusCode === 200 && up2.statusCode === 402, `${up.statusCode}/${up2.statusCode}`);
  await upsert(PC6[1], docs[1], 5, 5000); // reads still work
  const st = mkRes(); await quiet(() => BILLING(mkReq({ method: 'GET', token: adminTok(PC6[1]), query: { action: 'status' } }), st));
  check('PCx6d', 'Billing status works without the table and shows the live count (1,205)', st.statusCode === 200 && st.body?.usage?.pagesThisMonth === 1205, `${st.statusCode} ${JSON.stringify(st.body?.usage)}`);
  const bo = mkRes(); await quiet(() => RECORDS.processRecords({ method: 'POST', headers: {}, body: { action: 'bootstrap' } }, bo, authFor(PC6[1])));
  check('PCx6e', 'bootstrap works without the table and shows 1,205', bo.body?.billing?.usage?.pagesThisMonth === 1205 && bo.statusCode === 200, `${bo.statusCode} ${JSON.stringify(bo.body)?.slice(0, 160)}`);
  const del6 = await del(PC6[1], [docs[1]]);
  check('PCx6f', 'deleting works without the table (and, as today, gives the pages back: live count 0)', del6.statusCode === 200 && (await pagesNow(PC6[1])) === 0, `${del6.statusCode} ${await pagesNow(PC6[1])}`);
  await upsert(PC6[1], await mkDoc(PC6[1]), 1200); resetCaches(); // put the 1,200 back for the before/after comparison
  const before = await nums();
  const migErr = await capture(async () => { if (!migExists) throw new Error('M3-config/67-page-usage-counter.sql does not exist'); await applyMig(); });
  check('PCx6g', 'migration 67 applies cleanly to the already-populated database', !migErr?.__err, JSON.stringify(migErr));
  const after = await nums();
  check('PCx6h', 'applying 67 to the populated DB: every company\'s number is IDENTICAL before and after (no drop, no jump)', JSON.stringify(before) === JSON.stringify(after), `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  // the probe notices the table without a redeploy (negative cache re-probes)
  check('PCx6i', 'the app starts using the table with no code reset (counter row exists for the 1,200 company)', (await counter(PC6[1])) === 1200, String(await counter(PC6[1])));
  await del(PC6[1], (await lite.query(`SELECT id FROM documents WHERE tenant_id=$1`, [await tid(PC6[1])])).rows.map((r) => r.id));
  check('PCx6j', 'after the migration a delete no longer gives pages back (still 1,200)', (await pagesNow(PC6[1])) === 1200, String(await pagesNow(PC6[1])));
  // under-counted counter is backstopped by live rows (pages written by old code between steps)
  await capture(async () => lite.query(`UPDATE page_usage_monthly SET pages = 1 WHERE tenant_id = $1`, [await tid(PC6[0])]));
  check('PCx6k', 'a counter lower than the live rows is backstopped by the live count (GREATEST): 749', (await pagesNow(PC6[0])) === 749, String(await pagesNow(PC6[0])));
  // dropping the table behind a warm positive probe must not break reads (no aborted transaction)
  await lite.exec(`DROP TRIGGER IF EXISTS document_pages_usage_count ON document_pages; DROP TABLE IF EXISTS page_usage_monthly CASCADE;`);
  const warm = await capture(() => pagesNow(PC6[0]));
  check('PCx6l', 'table dropped under a warm cache: reads still work (live count 749), no 500', warm === 749, JSON.stringify(warm));
  const warmGate = await post(PC6[0], file({ filename: 'w.txt' }));
  check('PCx6m', '...and the upload gate answers normally (402, the company is at its cap)', warmGate.statusCode === 402, `${warmGate.statusCode}`);
  await capture(() => applyMig());
}

/* ================================================================= PCx7 backfill equals the live rule */
setFamily('PCx7');
{
  const now = Date.now();
  const mk = async (name, plan = 'fleet') => { await newTenant(name, plan, 'active', {}); return mkDoc(name); };
  const lim = (over = {}) => ({ from: iso(now - H), until: iso(now + 10 * D), pages: 5000, ...over });
  const shapes = {
    org_pc7_none: null,
    org_pc7_valid: lim(),
    org_pc7_ended: lim({ from: iso(now - H), endedAt: iso(now - 20 * 60_000) }),
    org_pc7_expired: lim({ from: iso(now - 2 * D), until: iso(now - D) }),
    org_pc7_2099: lim({ from: iso(now - 70 * D), until: '2099-01-01T00:00:00Z' }),
    org_pc7_2099b: lim({ from: iso(now - H), until: '2099-01-01T00:00:00Z' }),
    org_pc7_bad_until: lim({ until: 'not a date' }),
    org_pc7_bad_from: lim({ from: '2026-10-03' }),
    org_pc7_no_zone: lim({ from: '2026-10-03T10:00:00' }),
    org_pc7_pages0: lim({ pages: 0 }),
    org_pc7_pages_str: lim({ pages: '1000' }),
    org_pc7_pages_bool: lim({ pages: true }),
    org_pc7_bad_ended: lim({ endedAt: 'garbage' }),
    org_pc7_null_ended: lim({ endedAt: null }),
    org_pc7_array: [lim()],
  };
  const orgs = [];
  // pages at many offsets so every window position is exercised: -3h (before), -50m, -10m (inside), +0, +11d, -2d, -30d
  const OFFS = ['3 hours', '50 minutes', '25 minutes', '10 minutes', '0 minutes'];
  // seed WITHOUT the trigger (as if written before migration 67), then run the migration
  await lite.exec(`DROP TRIGGER IF EXISTS document_pages_usage_count ON document_pages; DROP TABLE IF EXISTS page_usage_monthly CASCADE;`);
  resetProbe();
  for (const [org, shape] of Object.entries(shapes)) {
    const d = await mk(org); orgs.push(org);
    if (shape !== null) await tenantLimits(org, { staffImport: shape });
    let no = 1;
    for (const off of OFFS) { await seedSql(org, d, 3, `now() - interval '${off}'`, no); no += 10; }
    await seedSql(org, d, 4, `now() - interval '2 days'`, no); no += 10;        // earlier this month or last, depending on the date
    await seedSql(org, d, 2, `now() + interval '12 days'`, no);                  // after most windows
  }
  resetCaches();
  const live = {}; for (const o of orgs) live[o] = await pagesNow(o);
  const migErr = await capture(async () => { if (!migExists) throw new Error('migration 67 missing'); await applyMig(); });
  check('PCx7a', 'migration applies on the populated database', !migErr?.__err, JSON.stringify(migErr));
  const ctr = {}; for (const o of orgs) ctr[o] = await counter(o);
  const monthLive = {};
  for (const o of orgs) {
    // the counter must equal the live rule evaluated on the SAME rows (this month, not in the JS staff-import window, not next month)
    const win = SI.staffImportWindowFor({ limits: { staffImport: shapes[o] ?? undefined } });
    const r = await lite.query(`SELECT count(*)::int n FROM document_pages WHERE tenant_id=$1 AND created_at >= ${MONTH_START_TS} AND created_at < ${MONTH_START_TS} + interval '1 month' AND ($2::timestamptz IS NULL OR created_at < $2::timestamptz OR created_at >= $3::timestamptz)`, [await tid(o), win?.from ?? null, win?.to ?? null]);
    monthLive[o] = r.rows[0].n;
  }
  const mism = orgs.filter((o) => (ctr[o] ?? 0) !== monthLive[o]);
  check('PCx7b', `backfilled counter == the live rule (JS staffImportWindowFor) for all ${orgs.length} window shapes (valid, ended, expired, 2099, malformed, none)`, mism.length === 0, mism.map((o) => `${o}: counter ${ctr[o]} live ${monthLive[o]}`).join('; '));
  const after = {}; for (const o of orgs) after[o] = await pagesNow(o);
  const jumped = orgs.filter((o) => after[o] !== live[o]);
  check('PCx7c', 'countPagesSince before == after the migration for every window shape', jumped.length === 0, jumped.map((o) => `${o}: ${live[o]} -> ${after[o]}`).join('; '));
  check('PCx7d', 'the test is meaningful: the valid window excluded some pages and the malformed one did not', (ctr.org_pc7_valid ?? 0) < (ctr.org_pc7_none ?? 0) && (ctr.org_pc7_bad_until ?? 0) === (ctr.org_pc7_none ?? 0), JSON.stringify(ctr));
  // the SQL window function against the JS one, many shapes (exact instants)
  const fuzz = [];
  const tsVariants = [iso(now - 5 * D), iso(now), '2026-02-30T00:00:00Z', '2026-02-32T00:00:00Z', '2026-10-03T24:00:00Z', '2026-10-03T24:00:01Z', '2026-10-03T10:00:00+24:00', '2026-10-03T10:00:00+05:60', '2026-04-31T12:00:00Z', '2026-10-03T10:00Z', '2026-10-03T10:00:00.5+05:30', '2026-10-03T10:00:00.123456Z', '2026-10-03T10:00:00-00:00', '2026-10-03 10:00:00Z', '', null, 5, '2026-13-01T00:00:00Z', ' 2026-10-03T10:00:00Z'];
  const pagesVariants = [1000, '1000', 0, -1, 1.5, '0', '12', true, null, '1e3', 'abc', '1234567890123', 1e30];
  for (const from of tsVariants) for (const until of [iso(now + 3 * D), iso(now + 90 * D), '2099-01-01T00:00:00Z', iso(now - 9 * D), from, 'bad']) fuzz.push({ from, until, pages: 1000 });
  for (const pages of pagesVariants) fuzz.push({ from: iso(now - H), until: iso(now + D), pages });
  for (const endedAt of tsVariants) fuzz.push({ from: iso(now - H), until: iso(now + 20 * D), pages: 10, endedAt });
  fuzz.push({ from: iso(now - H), until: iso(now + D), pages: 10, endedAt: iso(now - 2 * H) }); // ends before it starts
  fuzz.push({ from: iso(now - H), until: iso(now + D) });
  fuzz.push('string', 5, null, []);
  let fuzzBad = [];
  for (const shape of fuzz) {
    const lj = { staffImport: shape };
    const js = SI.staffImportWindowFor({ limits: lj });
    const r = await capture(() => lite.query(`SELECT (extract(epoch from lower(w)) * 1000)::float8 lo, (extract(epoch from upper(w)) * 1000)::float8 up FROM (SELECT page_counter_import_window($1::jsonb) AS w) x`, [JSON.stringify(lj)]));
    if (r.__err) { fuzzBad.push(`${JSON.stringify(shape)} -> ${r.__err}`); continue; }
    const sql = r.rows[0];
    // a JS window of zero/negative length excludes nothing: that equals "no window" on the SQL side
    const jsEff = js && Date.parse(js.to) > Date.parse(js.from) ? js : null;
    const same = jsEff ? (sql.lo !== null && Math.abs(sql.lo - Date.parse(jsEff.from)) < 1 && Math.abs(sql.up - Date.parse(jsEff.to)) < 1) : (sql.lo === null && sql.up === null);
    if (!same) fuzzBad.push(`${JSON.stringify(shape)} js=${JSON.stringify(jsEff)} sql=${JSON.stringify(sql)}`);
  }
  check('PCx7e', `SQL page_counter_import_window == JS staffImportWindowFor on ${fuzz.length} shapes (any disagreement listed; only "SQL stricter = no window" is conservative)`, fuzzBad.length === 0, fuzzBad.slice(0, 6).join(' | '));
}

/* ================================================================= PCx8 idempotent, never lowers */
setFamily('PCx8');
{
  const ORG = 'org_pc8'; await newTenant(ORG, 'fleet', 'active', {});
  const d = await mkDoc(ORG); await upsert(ORG, d, 60);
  await del(ORG, [d]);                                  // counter 60, live 0
  const d2 = await mkDoc(ORG); await upsert(ORG, d2, 15); // counter 75, live 15
  const snap = async () => JSON.stringify((await lite.query(`SELECT t.clerk_org_id k, m.month::text, m.pages::text FROM page_usage_monthly m JOIN tenants t ON t.id = m.tenant_id ORDER BY 1,2`)).rows);
  const s1 = await capture(snap);
  const e2 = await capture(() => applyMig());
  const s2 = await capture(snap);
  const e3 = await capture(() => applyMig(true));
  const s3 = await capture(snap);
  check('PCx8a', 'running the migration twice (and once more without its BEGIN/COMMIT) leaves every counter row identical', !e2?.__err && !e3?.__err && typeof s1 === 'string' && s1 === s2 && s2 === s3, `${JSON.stringify(e2)} ${JSON.stringify(e3)} ${s1 === s2} ${s2 === s3}`);
  check('PCx8b', 'a counter HIGHER than the live count (75 vs 15) is not lowered by re-running', (await counter(ORG)) === 75, String(await counter(ORG)));
  const tid8 = await tid(ORG);
  await capture(() => lite.query(`UPDATE page_usage_monthly SET pages = 3 WHERE tenant_id = $1`, [tid8]));
  await capture(() => applyMig());
  check('PCx8c', 'a counter LOWER than the live rows is raised to the live count by the backfill (GREATEST), never double counted', (await counter(ORG)) === 15, String(await counter(ORG)));
  const trg = (await lite.query(`SELECT count(*)::int n FROM pg_trigger WHERE tgrelid='document_pages'::regclass AND NOT tgisinternal AND tgname LIKE '%usage%'`)).rows[0].n;
  check('PCx8d', 'exactly ONE counting trigger exists after several runs (no duplicate triggers, which would double count)', trg === 1, String(trg));
  await upsert(ORG, await mkDoc(ORG), 4);
  check('PCx8e', 'after re-running, a new 4-page read adds exactly 4 (19)', (await counter(ORG)) === 19, String(await counter(ORG)));
  // the trigger must never block ingestion, even when the counter table is unusable
  await capture(() => lite.query(`ALTER TABLE page_usage_monthly ADD CONSTRAINT pc8_block CHECK (pages < 0) NOT VALID`));
  const blocked = await capture(() => upsert(ORG, d2, 3, 500));
  await capture(() => lite.query(`ALTER TABLE page_usage_monthly DROP CONSTRAINT pc8_block`));
  const stored = (await lite.query(`SELECT count(*)::int n FROM document_pages WHERE document_id=$1 AND page_no >= 500`, [d2])).rows[0].n;
  check('PCx8f', 'a failing counter update never blocks page ingestion (pages are stored, only a warning is raised)', !blocked?.__err && stored === 3, `${JSON.stringify(blocked)} stored=${stored}`);
}

finish();
