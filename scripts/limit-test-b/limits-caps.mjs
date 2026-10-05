/**
 * TESTER B (4): documents stored, pages per month, upload size cap, file type, batch size, concurrency, failure mode.
 * Handlers run in-process on PGlite (no R2: presign is local HMAC with fixture keys).
 *   flock /home/claude/work/cpu.lock npx tsx --import ./scripts/limit-test-b/register.mjs scripts/limit-test-b/limits-caps.mjs
 */
import path from 'node:path';
import crypto from 'node:crypto';
import { boot, adminTok, memberTok, mkReq, mkRes, quiet } from './lib.mjs';
const { h, check, setFamily, finish } = await boot();
const { lite, RS, PLAN, newTenant, rnd, root, resetCaches } = h;
const imp = (p) => import(path.join(root, p));
const UPH = await imp('api/upload-url.js');
const UP = UPH.default;
const REVIEW = (await imp('api/review.js')).default;
const SIZE = { MiB: 1024 * 1024 };
const sha = () => crypto.randomBytes(32).toString('hex');
const post = async (org, body, token = adminTok(org), extraHeaders = {}) => { const res = mkRes(); await quiet(() => UP(mkReq({ token, body, headers: extraHeaders }), res)); return res; };
const tenantUuid = async (org) => (await RS.getTenantContext(org, org)).id;
const countDocs = async (org) => (await lite.query(`SELECT count(*)::int n FROM documents WHERE tenant_id=$1`, [await tenantUuid(org)])).rows[0].n;
const seedDocs = async (org, n) => { const id = await tenantUuid(org); await lite.query(`INSERT INTO documents (tenant_id, original_filename, sha256_hash, file_size_bytes, content_type, storage_key, stage) SELECT $1, 'seed-'||g||'.txt', md5(g::text)||md5(g::text||'x'), 100, 'text/plain', $2||'/seed/'||g, 'mapped' FROM generate_series(1,$3) g`, [id, id, n]); resetCaches(); };
const seedPages = async (org, n, atIso = null) => { const id = await tenantUuid(org); const d = (await lite.query(`INSERT INTO documents (tenant_id, original_filename, sha256_hash, file_size_bytes, content_type, storage_key, stage) VALUES ($1,'pages-holder.txt',$2,100,'text/plain',$3,'mapped') RETURNING id`, [id, sha() , `${id}/holder/${sha().slice(0, 8)}`])).rows[0].id; await lite.query(`INSERT INTO document_pages (tenant_id, document_id, page_no, created_at) SELECT $1,$2,g, COALESCE($4::timestamptz, now()) FROM generate_series(1,$3) g`, [id, d, n, atIso]); resetCaches(); return d; };
const file = (over = {}) => ({ filename: 'a.txt', sha256: sha(), sizeBytes: 100, contentType: 'text/plain', ...over });
const monthReset = PLAN.monthResetLabel();

/* ---------------------------------------------------------------- upload size cap + type (validation is plan independent) */
setFamily('size');
{
  const ORG = 'org_caps_size'; await newTenant(ORG, 'fleet', 'active', PLAN.PLAN_LIMITS.fleet);
  const t = async (name, body, wantStatus, re) => { const r = await post(ORG, body); const ok = r.statusCode === wantStatus && (!re || re.test(JSON.stringify(r.body))); check(`Z:${name}`, `${name} -> HTTP ${wantStatus}${re ? ` + ${re}` : ''}`, ok, `${r.statusCode} ${JSON.stringify(r.body)?.slice(0, 200)}`); return r; };
  const PDF = 24 * SIZE.MiB, TXT = 20 * SIZE.MiB, MAX = 100 * SIZE.MiB;
  await t('pdf at cap (25,165,824 B = 24 MiB)', file({ filename: 'a.pdf', contentType: 'application/pdf', sizeBytes: PDF }), 200);
  await t('pdf cap+1', file({ filename: 'a.pdf', contentType: 'application/pdf', sizeBytes: PDF + 1 }), 413, /PDFs and photos have to be under 24 MB to be read/);
  for (const ct of ['image/jpeg', 'image/png', 'image/webp', 'image/gif']) {
    // Office build: the declared type must match the extension (a .jpg declared image/png is a mislabel and is refused), so the name follows the type.
    const pn = `p.${ct === 'image/jpeg' ? 'jpg' : ct.split('/')[1]}`;
    await t(`${ct} at cap`, file({ filename: pn, contentType: ct, sizeBytes: PDF }), 200);
    await t(`${ct} cap+1`, file({ filename: pn, contentType: ct, sizeBytes: PDF + 1 }), 413, /under 24 MB/);
  }
  await t('PDF with uppercase + charset parameter cap+1 (normalised)', file({ filename: 'b.pdf', contentType: 'Application/PDF; charset=binary', sizeBytes: PDF + 1 }), 413);
  await t('text/csv at cap (20 MiB)', file({ filename: 'a.csv', contentType: 'text/csv', sizeBytes: TXT }), 200);
  await t('text/csv cap+1', file({ filename: 'a.csv', contentType: 'text/csv', sizeBytes: TXT + 1 }), 413, /Text and spreadsheet files have to be under 20 MB/);
  await t('application/json cap+1', file({ filename: 'a.json', contentType: 'application/json', sizeBytes: TXT + 1 }), 413);
  // Office build: every accepted kind now has a cap at or under 24 MiB, so the 100 MiB ceiling is only the message for anything larger and
  // a no-extension / unlisted-type file is refused outright (415) instead of being accepted up to 100 MiB.
  await t('hard ceiling: 104,857,600 B (100 MiB) is over the PDF cap -> 413', file({ filename: 'a.pdf', contentType: 'application/octet-stream', sizeBytes: MAX }), 413, /under 24 MB/);
  await t('hard ceiling +1', file({ filename: 'a.pdf', contentType: 'application/octet-stream', sizeBytes: MAX + 1 }), 413, /File is larger than 100 MB/);
  await t('an unlisted type (a.bin, 1 MiB) is refused 415, not accepted up to 100 MiB', file({ filename: 'a.bin', contentType: 'application/octet-stream', sizeBytes: SIZE.MiB }), 415, /not accepted/);
  await t('size missing', { filename: 'a.pdf', sha256: sha(), contentType: 'application/pdf' }, 400, /sizeBytes is required/);
  await t('size 0', file({ sizeBytes: 0 }), 400, /This file is empty \(0 bytes\)/);
  for (const bad of [-1, 1.5, '100', NaN, null, Infinity, 2 ** 60]) await t(`size ${JSON.stringify(bad)}`, file({ sizeBytes: bad }), bad === null ? 400 : bad === 2 ** 60 ? 400 : 400);
  await t('bad sha256', file({ sha256: 'xyz' }), 400, /sha256 must be a 64-character hex digest/);
  await t('contentType not a string', file({ contentType: { a: 1 } }), 400, /contentType must be a string/);
  // file type allow-list (site/KB: "Accepted: .zip .pdf .jpg .jpeg .png .webp .tiff .tif .txt .csv ... Word and Excel files aren't accepted")
  for (const [fn, ct] of [['virus.exe', 'application/x-msdownload'], ['report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], ['sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], ['movie.mp4', 'video/mp4'], ['x.html', 'text/html']]) {
    const r = await post(ORG, file({ filename: fn, contentType: ct, sizeBytes: 50 * SIZE.MiB }));
    check(`Z:type:${fn}`, `server refuses an unsupported file type (${fn}, ${ct}, 50 MiB) - the KB says Word/Excel/other types "aren't accepted"`, r.statusCode >= 400 && r.statusCode < 500, `server ACCEPTED it: HTTP ${r.statusCode}, a document row + a signed 50 MiB upload URL were created (the allow-list exists only in the browser client)`);
  }
  const noType = await post(ORG, { filename: 'mystery', sha256: sha(), sizeBytes: 90 * SIZE.MiB });
  check('Z:type:none', 'upload with NO contentType and 90 MiB is refused or size-limited like a PDF', noType.statusCode >= 400, `HTTP ${noType.statusCode}`);
  // batch size
  const b50 = await post(ORG, { files: Array.from({ length: 50 }, (_, i) => file({ filename: `b${i}.txt` })) });
  check('Z:batch50', 'batch of exactly 50 files accepted, 50 results', b50.statusCode === 200 && b50.body?.results?.length === 50 && b50.body.results.every((r) => r.documentId), `${b50.statusCode} ${JSON.stringify(b50.body)?.slice(0, 150)}`);
  const before = await countDocs(ORG);
  const b51 = await post(ORG, { files: Array.from({ length: 51 }, (_, i) => file({ filename: `c${i}.txt` })) });
  check('Z:batch51', 'batch of 51 -> 413 "A batch is limited to 50 files", nothing created', b51.statusCode === 413 && /limited to 50 files/.test(b51.body?.error) && (await countDocs(ORG)) === before, `${b51.statusCode} ${JSON.stringify(b51.body)}`);
  const mixed = await post(ORG, { files: [file({ filename: 'ok.pdf', contentType: 'application/pdf', sizeBytes: 1000 }), file({ filename: 'big.pdf', contentType: 'application/pdf', sizeBytes: PDF + 1 }), file({ filename: 'ok2.txt' })] });
  check('Z:batch-mixed', 'in a batch, the too-big file gets its own 413 and the other two are still created', mixed.body?.results?.[0]?.documentId && mixed.body.results[1].status === 413 && mixed.body.results[2].documentId, JSON.stringify(mixed.body)?.slice(0, 300));
  const dup = file({ filename: 'dup.txt' });
  const d1 = await post(ORG, dup), d2 = await post(ORG, dup);
  check('Z:dup', 'the same file (same sha256) twice is ONE document (idempotent)', d1.body.documentId === d2.body.documentId, `${d1.body?.documentId} / ${d2.body?.documentId}`);
  const sign = await post(ORG, file({ filename: 'sig.pdf', contentType: 'application/pdf', sizeBytes: 12345 }));
  check('Z:signed-length', 'the presigned PUT signs content-length (a client cannot upload more than it declared)', /content-length/i.test(sign.body?.uploadUrl ?? ''), sign.body?.uploadUrl?.slice(0, 120));
}

/* ---------------------------------------------------------------- documents stored: Solo 25,000 end to end */
setFamily('documents-cap');
{
  const ORG = 'org_caps_docs'; await newTenant(ORG, 'solo', 'active', PLAN.PLAN_LIMITS.solo);
  await seedDocs(ORG, 24_998);
  check('DC0', 'seeded Solo tenant with 24,998 documents', (await countDocs(ORG)) === 24_998);
  const a = await post(ORG, file({ filename: 'n-1.txt' }));
  check('DC1', 'document #24,999 (N-1) accepted', a.statusCode === 200 && !!a.body.documentId, `${a.statusCode} ${JSON.stringify(a.body)}`);
  const b = await post(ORG, file({ filename: 'n.txt' }));
  check('DC2', 'document #25,000 (exactly N) accepted', b.statusCode === 200 && !!b.body.documentId && (await countDocs(ORG)) === 25_000, `${b.statusCode} ${JSON.stringify(b.body)}`);
  const c = await post(ORG, file({ filename: 'n+1.txt' }));
  const msg = "Your plan stores up to 25,000 documents and you have 25,000. Delete documents you no longer need, or upgrade your plan for more room. You can still search and ask about everything you have.";
  check('DC3', 'document #25,001 (N+1) refused: HTTP 402, exact stated message, billing link', c.statusCode === 402 && c.body?.error === msg && c.body?.url === '/app/?screen=billing', `${c.statusCode} ${JSON.stringify(c.body)}`);
  const ingestUnits = async () => (await lite.query(`SELECT COALESCE(sum(units),0)::int n FROM rate_limit_windows WHERE tenant_id=$1 AND bucket='ingest'`, [await tenantUuid(ORG)])).rows[0].n;
  const u0 = await ingestUnits(); await post(ORG, file({ filename: 'refused-again.txt' })); const u1 = await ingestUnits();
  check('DC3b', 'a request refused by the document cap (402) does not spend rate-limit units', u1 === u0, `ingest burst counter ${u0} -> ${u1}: limit() runs before the plan gate, and only the 429 path refunds, so every 402-refused retry burns one unit of the 60/min bucket`);
  check('DC4', 'refusal leaves NO partial write (still 25,000 documents) and existing documents are untouched', (await countDocs(ORG)) === 25_000);
  const dupAtCap = await post(ORG, { ...file({ filename: 'n.txt' }), sha256: (await lite.query(`SELECT sha256_hash FROM documents WHERE original_filename='n.txt' AND tenant_id=$1`, [await tenantUuid(ORG)])).rows[0].sha256_hash });
  check('DC5', 'at the cap, re-sending a document you ALREADY have is still refused by the gate (cap message, not a duplicate answer)', dupAtCap.statusCode === 402, `HTTP ${dupAtCap.statusCode} (documents the behaviour)`);
  // batch: leaves room for exactly 2 of 5
  const ORG2 = 'org_caps_docs2'; await newTenant(ORG2, 'solo', 'active', PLAN.PLAN_LIMITS.solo); await seedDocs(ORG2, 24_998);
  const bt = await post(ORG2, { files: Array.from({ length: 5 }, (_, i) => file({ filename: `bt${i}.txt` })) });
  const r = bt.body?.results ?? [];
  check('DC6', 'batch of 5 with room for 2: files 1-2 created, files 3-5 each get their own 402 "document limit was reached part-way", exactly 25,000 stored', bt.statusCode === 200 && r.slice(0, 2).every((x) => x.documentId) && r.slice(2).every((x) => x.status === 402 && /document limit was reached part-way through this batch/.test(x.error)) && (await countDocs(ORG2)) === 25_000, JSON.stringify(r).slice(0, 400));
  // the other plans' numbers (pure gate): N-1 ok, N refused, exact figures
  const g = (plan, docs) => PLAN.gateUpload({ plan, billing_status: 'active', limits: {} }, { documentsStored: docs, pagesThisMonth: 0, pendingPages: 0 });
  for (const [plan, N] of [['solo', 25000], ['shop', 100000], ['crew', 500000]]) {
    check(`DC:${plan}`, `${plan}: ${N - 1} stored -> allowed (1 left); ${N} -> 402 naming "${N.toLocaleString('en-US')}"`, g(plan, N - 1).allowed === true && g(plan, N - 1).documentsRemaining === 1 && g(plan, N).allowed === false && g(plan, N).status === 402 && g(plan, N).error.includes(`stores up to ${N.toLocaleString('en-US')} documents`), JSON.stringify(g(plan, N)));
  }
  check('DC:fleet', 'fleet: unlimited documents (9,000,000 stored still allowed)', g('fleet', 9_000_000).allowed === true && g('fleet', 9_000_000).documentsRemaining === null);
}

/* ---------------------------------------------------------------- pages per month: Solo 750 end to end */
setFamily('pages-cap');
{
  const ORG = 'org_caps_pages'; await newTenant(ORG, 'solo', 'active', PLAN.PLAN_LIMITS.solo);
  await seedPages(ORG, 749);
  const a = await post(ORG, file({ filename: 'pg1.txt', sizeBytes: 100 }));
  check('PC1', '749 pages read this month: the next upload (est. 1 page) is accepted (N-1)', a.statusCode === 200, `${a.statusCode} ${JSON.stringify(a.body)}`);
  // that upload is pending (1 page) -> 749 + 1 pending = 750 -> now refused
  const b = await post(ORG, file({ filename: 'pg2.txt', sizeBytes: 100 }));
  check('PC2', 'with 749 read + 1 still pending (=750) the next upload is refused: HTTP 402 and the message says pages are still being processed', b.statusCode === 402 && b.body?.error === `Monthly page limit reached (750): 749 pages are read and about 1 more are still being processed. Wait for them to finish. It resets on ${monthReset}. Upgrade your plan for more.`, `${b.statusCode} ${JSON.stringify(b.body)}`);
  const ORG2 = 'org_caps_pages2'; await newTenant(ORG2, 'solo', 'active', PLAN.PLAN_LIMITS.solo);
  await seedPages(ORG2, 750);
  const c = await post(ORG2, file({ filename: 'pg3.txt' }));
  check('PC3', '750 pages read (exactly N): upload refused with the exact stated message "Monthly page limit reached (750). It resets on <1st of next month>. Upgrade your plan for more."', c.statusCode === 402 && c.body?.error === `Monthly page limit reached (750). It resets on ${monthReset}. Upgrade your plan for more.` && c.body?.url === '/app/?screen=billing', `${c.statusCode} ${JSON.stringify(c.body)}`);
  check('PC4', 'refused upload created no document row (only the holder doc exists)', (await countDocs(ORG2)) === 1);
  const ORG3 = 'org_caps_pages3'; await newTenant(ORG3, 'solo', 'active', PLAN.PLAN_LIMITS.solo);
  await seedPages(ORG3, 750, new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1) - 86_400_000).toISOString());
  const d = await post(ORG3, file({ filename: 'pg4.txt' }));
  check('PC5', 'month boundary: 750 pages read on the LAST day of the previous UTC month do not count; upload accepted', d.statusCode === 200, `${d.statusCode} ${JSON.stringify(d.body)}`);
  const ORG4 = 'org_caps_pages4'; await newTenant(ORG4, 'solo', 'active', PLAN.PLAN_LIMITS.solo);
  await seedPages(ORG4, 750, new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1, 0, 0, 0)).toISOString());
  const e = await post(ORG4, file({ filename: 'pg5.txt' }));
  check('PC6', 'month boundary: 750 pages read at 00:00:00 UTC on the 1st DO count (refused)', e.statusCode === 402, `${e.statusCode}`);
  // pending pages from big PDFs: 700 read + a 10,240,000 B pdf (=50 pages est.) -> 750
  const ORG5 = 'org_caps_pages5'; await newTenant(ORG5, 'solo', 'active', PLAN.PLAN_LIMITS.solo); await seedPages(ORG5, 700);
  const f1 = await post(ORG5, file({ filename: 'big.pdf', contentType: 'application/pdf', sizeBytes: 10_240_000 }));
  const f2 = await post(ORG5, file({ filename: 'big2.pdf', contentType: 'application/pdf', sizeBytes: 100_000 }));
  check('PC7', '700 read + a 50-page PDF queued -> the next file is refused (pending pages counted)', f1.statusCode === 200 && f2.statusCode === 402 && /still being processed/.test(f2.body?.error), `${f1.statusCode}/${f2.statusCode} ${JSON.stringify(f2.body)}`);
  // batch: 748 read; a batch of 4 one-page files -> 2 created, 2 refused
  const ORG6 = 'org_caps_pages6'; await newTenant(ORG6, 'solo', 'active', PLAN.PLAN_LIMITS.solo); await seedPages(ORG6, 748);
  const bt = await post(ORG6, { files: Array.from({ length: 4 }, (_, i) => file({ filename: `q${i}.txt` })) });
  const rr = bt.body?.results ?? [];
  check('PC8', 'batch of 4 one-page files at 748/750: 2 created, 2 get their own 402 "Monthly page limit reached (750) part-way through this batch"', rr.slice(0, 2).every((x) => x.documentId) && rr.slice(2).every((x) => x.status === 402 && /Monthly page limit reached \(750\) part-way through this batch, so this file was not added/.test(x.error)), JSON.stringify(rr).slice(0, 400));
  // other plans pure
  const gp = (plan, pages, pending = 0) => PLAN.gateUpload({ plan, billing_status: 'active', limits: {} }, { documentsStored: 0, pagesThisMonth: pages, pendingPages: pending });
  for (const [plan, N] of [['solo', 750], ['shop', 2000], ['crew', 5000], ['fleet', 10000]]) {
    const nl = N.toLocaleString('en-US');
    check(`PC:${plan}`, `${plan}: ${N - 1} pages -> allowed (1 left); ${N} -> 402 "Monthly page limit reached (${nl})"`, gp(plan, N - 1).allowed && gp(plan, N - 1).pagesRemaining === 1 && !gp(plan, N).allowed && gp(plan, N).error.startsWith(`Monthly page limit reached (${nl}).`), JSON.stringify(gp(plan, N)));
  }
  check('PC:fleet-msg', 'fleet at its cap is told to email support, not "upgrade"', /support@deepwelltechnology\.com/.test(gp('fleet', 10000).error) && !/Upgrade/.test(gp('fleet', 10000).error));
  // delete-and-reupload loophole: page count = rows in document_pages
  const ORG7 = 'org_caps_pages7'; await newTenant(ORG7, 'solo', 'active', PLAN.PLAN_LIMITS.solo);
  const holder = await seedPages(ORG7, 750);
  const refused = await post(ORG7, file({ filename: 'x1.txt' }));
  const del = mkRes(); await quiet(() => REVIEW(mkReq({ token: adminTok(ORG7), body: { action: 'deleteDocuments', documentIds: [holder] } }), del));
  resetCaches();
  const after = await post(ORG7, file({ filename: 'x2.txt' }));
  check('PC9', 'monthly page cap cannot be reset by deleting documents (pages already read this month stay counted)', refused.statusCode === 402 && del.statusCode === 200 && after.statusCode === 402, `before delete ${refused.statusCode}; delete ${del.statusCode}; AFTER deleting the 750-page document the next upload is HTTP ${after.statusCode} - the count is live rows in document_pages, so deleting frees the allowance (read pages were already paid for in model calls)`);
}

/* ---------------------------------------------------------------- concurrency: N+1 simultaneous uploads against a limit of N */
setFamily('concurrency');
{
  const ORG = 'org_caps_race'; await newTenant(ORG, 'solo', 'active', PLAN.PLAN_LIMITS.solo);
  await seedDocs(ORG, 24_998); // room for exactly 2
  const res = await Promise.all(Array.from({ length: 6 }, (_, i) => post(ORG, file({ filename: `race${i}.txt` }), adminTok(ORG, `user_r${i}`))));
  const ok = res.filter((r) => r.statusCode === 200).length;
  const total = await countDocs(ORG);
  check('CX1', `6 SIMULTANEOUS single-file uploads with room for 2 documents: at most 2 get through (stored count never above 25,000)`, total <= 25_000, `${ok} requests were accepted and the tenant now stores ${total} documents (cap 25,000): the gate (checkUploadGate) and the insert (createUploadUrl) are separate transactions with no lock`);
  const ORG2 = 'org_caps_race2'; await newTenant(ORG2, 'solo', 'active', PLAN.PLAN_LIMITS.solo);
  await seedPages(ORG2, 749);
  const res2 = await Promise.all(Array.from({ length: 6 }, (_, i) => post(ORG2, file({ filename: `prace${i}.pdf`, contentType: 'application/pdf', sizeBytes: 2_048_000 }), adminTok(ORG2, `user_p${i}`))));
  const ok2 = res2.filter((r) => r.statusCode === 200).length;
  check('CX2', `6 SIMULTANEOUS 10-page PDFs with 1 page of monthly allowance left: none beyond the first should pass`, ok2 <= 1, `${ok2} requests were accepted (each would add ~10 pages): every request read pending pages before any of the others had inserted its row`);
  // batch in ONE request is safe (single transaction + allowance counter) - already shown by DC6/PC8
}
finish();
