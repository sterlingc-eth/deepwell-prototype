/**
 * E2 (billing-limits fix 2): simultaneous uploads must not overshoot the stored-document cap or the monthly page cap.
 * The gate and the insert used to be two transactions with no lock. Handlers run in-process on PGlite.
 *   npx tsx --import ./scripts/limit-test-b/register.mjs scripts/limit-test-b/upload-race.mjs
 * Note: the shared harness hands out ONE database session at a time, so transactions never truly overlap here; what these
 * checks prove is that the gate decision and the insert are now ONE transaction (no other request slips in between).
 * The advisory lock is what gives the same guarantee on a real multi-connection Postgres.
 */
import path from 'node:path';
import crypto from 'node:crypto';
import { boot, adminTok, mkReq, mkRes, quiet } from './lib.mjs';
const { h, check, setFamily, finish } = await boot();
const { lite, RS, PLAN, newTenant, root, resetCaches } = h;
const imp = (p) => import(path.join(root, p));
const UP = (await imp('api/upload-url.js')).default;
const V1 = (await imp('api/_lib/routes/v1-ingest.js')).default;
const RECORDS = await imp('api/records.ts');
const sha = () => crypto.randomBytes(32).toString('hex');
const tenantUuid = async (org) => (await RS.getTenantContext(org, org)).id;
const countDocs = async (org) => (await lite.query(`SELECT count(*)::int n FROM documents WHERE tenant_id=$1`, [await tenantUuid(org)])).rows[0].n;
const seedDocs = async (org, n) => { const id = await tenantUuid(org); await lite.query(`INSERT INTO documents (tenant_id, original_filename, sha256_hash, file_size_bytes, content_type, storage_key, stage) SELECT $1, 'seed-'||g||'.txt', md5(g::text)||md5(g::text||'x'), 100, 'text/plain', $2||'/seed/'||g, 'mapped' FROM generate_series(1,$3) g`, [id, id, n]); resetCaches(); };
const seedPages = async (org, n) => { const id = await tenantUuid(org); const d = (await lite.query(`INSERT INTO documents (tenant_id, original_filename, sha256_hash, file_size_bytes, content_type, storage_key, stage) VALUES ($1,'pages-holder.txt',$2,100,'text/plain',$3,'mapped') RETURNING id`, [id, sha(), `${id}/holder/${sha().slice(0, 8)}`])).rows[0].id; await lite.query(`INSERT INTO document_pages (tenant_id, document_id, page_no, created_at) SELECT $1,$2,g, now() FROM generate_series(1,$3) g`, [id, d, n]); resetCaches(); };
const file = (over = {}) => ({ filename: 'a.txt', sha256: sha(), sizeBytes: 100, contentType: 'text/plain', ...over });
const pdf10 = (over = {}) => file({ filename: 'p.pdf', contentType: 'application/pdf', sizeBytes: 2_048_000, ...over }); // 10 estimated pages
const post = async (org, body, user = 'user_admin') => { const res = mkRes(); await quiet(() => UP(mkReq({ token: adminTok(org, user), body }), res)); return res; };
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`HANG: ${what} did not finish in ${ms} ms`)), ms))]);
const tally = (rs) => { const t = {}; for (const r of rs) t[r.statusCode] = (t[r.statusCode] ?? 0) + 1; return t; };
const DOC_MSG = "Your plan stores up to 25,000 documents and you have 25,000. Delete documents you no longer need, or upgrade your plan for more room. You can still search and ask about everything you have.";
const solo = async (org, extra = null) => newTenant(org, 'solo', 'active', extra ? { ...PLAN.PLAN_LIMITS.solo, ...extra } : PLAN.PLAN_LIMITS.solo);

/* ------------------------------------------------------------ single uploads, documents cap */
setFamily('race-docs');
{
  const ORG = 'org_race_docs'; await solo(ORG); await seedDocs(ORG, 24_998); // room for exactly 2
  const bodies = Array.from({ length: 20 }, (_, i) => file({ filename: `r${i}.txt` }));
  const res = await withTimeout(Promise.all(bodies.map((b, i) => post(ORG, b, `user_${i}`))), 60_000, '20 single uploads');
  const t = tally(res); const total = await countDocs(ORG);
  check('U1', '20 SIMULTANEOUS single uploads with room for 2 documents: exactly 2 get 200, 18 get 402, stored count exactly 25,000', t[200] === 2 && t[402] === 18 && total === 25_000 && Object.keys(t).length === 2, `statuses ${JSON.stringify(t)}, stored ${total}`);
  const refused = res.map((r, i) => [r, bodies[i]]).filter(([r]) => r.statusCode === 402);
  check('U1b', 'every refusal carries the exact documents-cap message + billing link', refused.every(([r]) => r.body?.error === DOC_MSG && r.body?.url === '/app/?screen=billing'), JSON.stringify(refused[0]?.[0]?.body));
  const rows = (await lite.query(`SELECT count(*)::int n FROM documents WHERE tenant_id=$1 AND sha256_hash = ANY($2)`, [await tenantUuid(ORG), refused.map(([, b]) => b.sha256)])).rows[0].n;
  check('U8', 'a refused request leaves no document row behind', rows === 0, `${rows} rows for ${refused.length} refused shas`);
}

/* ------------------------------------------------------------ single uploads, monthly pages cap */
setFamily('race-pages');
{
  const ORG = 'org_race_pages'; await solo(ORG); await seedPages(ORG, 740); // room for 10 of 750
  const res = await withTimeout(Promise.all(Array.from({ length: 20 }, (_, i) => post(ORG, pdf10({ filename: `p${i}.pdf` }), `user_${i}`))), 60_000, '20 pdf uploads');
  const t = tally(res);
  check('U2', '20 SIMULTANEOUS single 10-page PDFs with room for 10 pages: exactly 1 passes, 19 get 402', t[200] === 1 && t[402] === 19 && Object.keys(t).length === 2, `statuses ${JSON.stringify(t)}`);
  check('U2b', 'the page-cap refusals use the "still being processed" message', res.filter((r) => r.statusCode === 402).every((r) => /Monthly page limit reached \(750\): 740 pages are read and about 10 more are still being processed/.test(r.body?.error)), JSON.stringify(res.find((r) => r.statusCode === 402)?.body));
}

/* ------------------------------------------------------------ batch + singles at once */
setFamily('race-mixed');
{
  const ORG = 'org_race_mixed'; await solo(ORG); await seedDocs(ORG, 24_995); // room for 5
  const jobs = [post(ORG, { files: Array.from({ length: 10 }, (_, i) => file({ filename: `b${i}.txt` })) }, 'user_batch'), ...Array.from({ length: 10 }, (_, i) => post(ORG, file({ filename: `s${i}.txt` }), `user_s${i}`))];
  let res, err = null;
  try { res = await withTimeout(Promise.all(jobs), 60_000, 'batch + 10 singles'); } catch (e) { err = e; }
  const total = await countDocs(ORG);
  check('U3', 'one batch of 10 + 10 singles at once, room for 5: stored never above 25,000 (and exactly 25,000), no 500s, no hang', !err && total === 25_000 && res.every((r) => r.statusCode === 200 || r.statusCode === 402), err ? err.message : `statuses ${JSON.stringify(tally(res))}, stored ${total}`);
  if (res) {
    const batch = res[0];
    const per = batch.body?.results ?? [];
    const made = per.filter((x) => x.documentId).length;
    check('U3b', 'the batch (when it ran) answers per file: created files first, each refused file has its own 402 "limit was reached part-way through this batch" (or the whole batch is the plain 402)', batch.statusCode === 402 ? batch.body?.error === DOC_MSG : per.length === 10 && per.filter((x) => !x.documentId).every((x) => x.status === 402 && (x.error === DOC_MSG || /document limit was reached part-way through this batch/.test(x.error))) && per.slice(0, made).every((x) => x.documentId), JSON.stringify(per).slice(0, 300));
  }
}

/* ------------------------------------------------------------ three companies at once */
setFamily('race-tenants');
{
  const rooms = { org_race_ta: 2, org_race_tb: 3, org_race_tc: 1 };
  for (const [org, room] of Object.entries(rooms)) { await solo(org); await seedDocs(org, 25_000 - room); }
  const jobs = [];
  for (let i = 0; i < 8; i++) for (const org of Object.keys(rooms)) jobs.push(post(org, file({ filename: `t${i}.txt` }), `user_${i}`).then((r) => [org, r]));
  const out = await withTimeout(Promise.all(jobs), 90_000, 'three companies');
  const ok = {}; for (const [org, r] of out) if (r.statusCode === 200) ok[org] = (ok[org] ?? 0) + 1;
  const only = out.every(([, r]) => r.statusCode === 200 || r.statusCode === 402);
  const stored = {}; for (const org of Object.keys(rooms)) stored[org] = await countDocs(org);
  check('U4', 'three companies racing at once: each gets exactly its own room (2 / 3 / 1), each stored count lands exactly on 25,000, no 500s, nobody blocked by another', only && Object.entries(rooms).every(([org, room]) => ok[org] === room && stored[org] === 25_000), `accepted ${JSON.stringify(ok)} stored ${JSON.stringify(stored)}`);
}

/* ------------------------------------------------------------ duplicates at once */
setFamily('race-dups');
{
  const ORG = 'org_race_dups'; await solo(ORG);
  const same = file({ filename: 'same.txt' });
  const res = await withTimeout(Promise.all(Array.from({ length: 6 }, (_, i) => post(ORG, { ...same }, `user_${i}`))), 60_000, 'dups');
  const n = (await lite.query(`SELECT count(*)::int n FROM documents WHERE tenant_id=$1 AND sha256_hash=$2`, [await tenantUuid(ORG), same.sha256])).rows[0].n;
  check('U5', 'the same file (same sha256) sent 6 times at once = ONE document, all 6 answers 200 with the same documentId', n === 1 && res.every((r) => r.statusCode === 200) && new Set(res.map((r) => r.body?.documentId)).size === 1, `rows ${n}, ${JSON.stringify(tally(res))}`);
  const ORG2 = 'org_race_dups2'; await solo(ORG2); await seedDocs(ORG2, 24_999); // room for 1; two different files + each sent twice
  const a = file({ filename: 'a.txt' }), b = file({ filename: 'b.txt' });
  const r2 = await withTimeout(Promise.all([a, b, a, b].map((x, i) => post(ORG2, { ...x }, `user_${i}`))), 60_000, 'dups at the edge');
  check('U5b', 'room for 1 document, files A and B each sent twice at once: never above 25,000 stored, no 500s', (await countDocs(ORG2)) <= 25_000 && r2.every((r) => r.statusCode === 200 || r.statusCode === 402), `${JSON.stringify(tally(r2))} stored ${await countDocs(ORG2)}`);
}

/* ------------------------------------------------------------ v1-ingest (partner route, API key) and staff import */
setFamily('race-v1-import');
const imp0 = (over = {}) => ({ from: new Date(Date.now() - 3_600_000).toISOString(), until: new Date(Date.now() + 10 * 86_400_000).toISOString(), pages: 100_000, documents: 0, ingestPerMinute: 600, ingestPerDay: 200_000, ...over });
const mintKey = async (org) => { const raw = 'dw_live_' + crypto.randomBytes(32).toString('hex'); const hash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex'); await lite.query(`INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash, scopes) VALUES ($1,'t',$2,$3,ARRAY['ingest','read'])`, [await tenantUuid(org), raw.slice(8, 16), hash]); return raw; };
const v1post = async (key, body) => { const res = mkRes(); await quiet(() => V1(mkReq({ token: key, body }), res)); return res; };
{
  const ORG = 'org_race_v1docs'; await solo(ORG, { staffImport: imp0() }); await seedDocs(ORG, 24_998); const key = await mintKey(ORG);
  const res = await withTimeout(Promise.all(Array.from({ length: 20 }, (_, i) => v1post(key, file({ filename: `v${i}.txt` })))), 90_000, 'v1 docs');
  const t = tally(res); const total = await countDocs(ORG);
  check('U6', 'v1-ingest with an API key, 20 at once, room for 2 documents: exactly 2 get 200, the rest 402, stored exactly 25,000', t[200] === 2 && t[402] === 18 && total === 25_000, `statuses ${JSON.stringify(t)} stored ${total}`);
  const ORG2 = 'org_race_v1pages'; await solo(ORG2, { staffImport: imp0({ pages: 25 }) }); const key2 = await mintKey(ORG2);
  const r2 = await withTimeout(Promise.all(Array.from({ length: 12 }, (_, i) => v1post(key2, pdf10({ filename: `v${i}.pdf` })))), 90_000, 'v1 import pages');
  const t2 = tally(r2);
  check('U6b', 'v1-ingest, import budget 25 pages, twelve 10-page PDFs at once: exactly 3 pass (0,10,20 used < 25), the rest 402, budget not overshot', t2[200] === 3 && t2[402] === 9, `statuses ${JSON.stringify(t2)}`);
  const ORG3 = 'org_race_v1plain'; await solo(ORG3); await seedPages(ORG3, 740);
  const rP = await withTimeout(Promise.all(Array.from({ length: 12 }, (_, i) => post(ORG3, pdf10({ filename: `w${i}.pdf` }), `user_${i}`))), 60_000, 'plain pages');
  check('U6c', 'sanity: the same page race on /api/upload-url for a second company: exactly 1 passes', tally(rP)[200] === 1);
}
setFamily('race-import');
{
  const ORG = 'org_race_imp'; await solo(ORG, { staffImport: imp0({ pages: 25 }) });
  const res = await withTimeout(Promise.all(Array.from({ length: 15 }, (_, i) => post(ORG, pdf10({ filename: `i${i}.pdf` }), `user_${i}`))), 90_000, 'import pages');
  const t = tally(res);
  check('U7', 'staff import active, budget 25 pages, fifteen 10-page PDFs at once via /api/upload-url: exactly 3 pass, the rest 402 with the import-allowance code, budget not overshot', t[200] === 3 && t[402] === 12 && res.filter((r) => r.statusCode === 402).every((r) => /temporary page allowance/.test(r.body?.error)), `statuses ${JSON.stringify(t)} ${JSON.stringify(res.find((r) => r.statusCode === 402)?.body)?.slice(0, 160)}`);
  const ORG2 = 'org_race_imp_batch'; await solo(ORG2, { staffImport: imp0({ pages: 25 }) });
  const mixed = await withTimeout(Promise.all([post(ORG2, { files: Array.from({ length: 6 }, (_, i) => pdf10({ filename: `ib${i}.pdf` })) }, 'user_b'), ...Array.from({ length: 6 }, (_, i) => post(ORG2, pdf10({ filename: `is${i}.pdf` }), `user_${i}`))]), 90_000, 'import batch+singles');
  const made = (await countDocs(ORG2));
  check('U7b', 'staff import, budget 25 pages: a 6-file batch and six singles at once never create more than 3 PDFs of 10 estimated pages (the gate admits while used+pending < 25), no 500s', mixed.every((r) => r.statusCode === 200 || r.statusCode === 402) && made <= 3, `created ${made}; ${JSON.stringify(tally(mixed))}`);
}

/* ------------------------------------------------------------ records.ts createDocument */
setFamily('race-createdocument');
{
  const ORG = 'org_race_cd'; await solo(ORG); await seedDocs(ORG, 24_998); // room for 2
  const cd = async (i) => { const res = mkRes(); const f = file({ filename: `cd${i}.txt` }); await quiet(() => RECORDS.processRecords({ method: 'POST', headers: { 'x-forwarded-for': '203.0.113.9' }, body: { action: 'createDocument', original_filename: f.filename, sha256_hash: f.sha256, file_size_bytes: 100, content_type: 'text/plain' } }, res, { userId: `user_${i}`, tenantId: ORG, orgId: ORG, orgRole: 'admin' })); return res; };
  const res = await withTimeout(Promise.all(Array.from({ length: 12 }, (_, i) => cd(i))), 60_000, 'createDocument race');
  const t = tally(res); const total = await countDocs(ORG);
  check('U11', 'records createDocument, 12 at once with room for 2: exactly 2 get 200, 10 get 402 with the same {error,url} body, stored exactly 25,000', t[200] === 2 && t[402] === 10 && total === 25_000 && res.filter((r) => r.statusCode === 402).every((r) => r.body?.error === DOC_MSG && r.body?.url === '/app/?screen=billing'), `statuses ${JSON.stringify(t)} stored ${total} ${JSON.stringify(res.find((r) => r.statusCode === 402)?.body)}`);
}

/* ------------------------------------------------------------ rate limiter: refunds are bounded */
setFamily('refund-bound');
{
  const ORG = 'org_race_flood'; await solo(ORG); await seedDocs(ORG, 25_000);
  const w0 = Math.floor(Date.now() / 60_000); const out = []; for (let i = 0; i < 120; i++) out.push(await post(ORG, file({ filename: `f${i}.txt` }))); const windows = Math.floor(Date.now() / 60_000) - w0 + 1; // minute windows the flood touched
  const t = tally(out);
  check('U9', 'a flood of 120 sequential requests refused by the document cap is still stopped by the per-minute window (some 429s), and at most 60 + 20 refund-allowance reach the plan gate', (t[429] ?? 0) > 0 && (t[402] ?? 0) <= 80 * windows && (await countDocs(ORG)) === 25_000, `statuses ${JSON.stringify(t)} over ${windows} minute window(s)`);
}

/* ------------------------------------------------------------ latency of a normal upload */
setFamily('latency');
{
  const ORG = 'org_race_lat'; await newTenant(ORG, 'fleet', 'active', PLAN.PLAN_LIMITS.fleet);
  const samples = [];
  for (let i = 0; i < 4; i++) { await post(ORG, file({ filename: `warm${i}.txt` })); }
  for (let i = 0; i < 40; i++) {
    // keep under the 60/min ingest window
    if (i === 30) await lite.query(`DELETE FROM rate_limit_windows`);
    const t0 = process.hrtime.bigint(); const r = await post(ORG, file({ filename: `l${i}.txt` })); const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (r.statusCode === 200) samples.push(ms);
  }
  samples.sort((a, b) => a - b);
  const med = samples[Math.floor(samples.length / 2)], mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  console.log(`LATENCY single upload on PGlite: n=${samples.length} median ${med.toFixed(1)} ms, mean ${mean.toFixed(1)} ms, p90 ${samples[Math.floor(samples.length * 0.9)].toFixed(1)} ms`);
  check('U10', 'single uploads still succeed (latency printed above)', samples.length >= 38);
}
finish();
