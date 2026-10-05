/**
 * INTEGRATION SEAMS (page counter + office files): the Word/Excel read-time page-allowance check (readDocument.js
 * officeAllowanceRefusal) and the upload gate (upload-url.js checkUploadGate) must count with the SAME function
 * (recordsStore countPagesSince = GREATEST(this month's tally, live rows)), so a company cannot get pages back by deleting a
 * Word/Excel file and uploading it again, and the number a refusal quotes is the number the gate enforces.
 * Handlers run in-process on PGlite; R2 reads are faked with a stubbed fetch.
 *   npx tsx --import ./scripts/limit-test-b/register.mjs scripts/limit-test-b/integration-seams.mjs   (npm run verify:integration-seams)
 */
import path from 'node:path';
import crypto from 'node:crypto';
import { boot, adminTok, mkReq, mkRes, quiet } from './lib.mjs';
import { buildDocx, buildXlsx, p } from '../lib/officeBuild.mjs';

const { h, check, setFamily, finish } = await boot();
const { lite, RS, PLAN, newTenant, root, resetCaches } = h;
const imp = (x) => import(path.join(root, x));
const UPH = await imp('api/upload-url.js');
const UP = UPH.default;
const REVIEW = (await imp('api/review.js')).default;
const READ = await imp('api/_lib/readDocument.js');
const sha = () => crypto.randomBytes(32).toString('hex');
const D = 86_400_000;
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const ctxOf = (org) => ({ tenantKey: org, tenantName: org });
const W = (org, fn) => RS.withTenant(ctxOf(org), fn);
const tid = async (org) => (await RS.getTenantContext(org, org)).id;
const sinceIso = () => new Date(Date.now() - 30 * D).toISOString();
const pagesNow = (org) => W(org, (db) => db.countPagesSince(sinceIso()));
const authFor = (key) => ({ tenantId: key, orgId: key, userId: 'user_admin', orgRole: 'admin' });
const post = async (org, body) => { const res = mkRes(); await quiet(() => UP(mkReq({ token: adminTok(org), body }), res)); return res; };
const del = async (org, ids) => { const res = mkRes(); await quiet(() => REVIEW(mkReq({ token: adminTok(org), body: { action: 'deleteDocuments', documentIds: ids } }), res)); resetCaches(); return res; };
const capture = async (fn) => { try { return await fn(); } catch (e) { return { __err: String(e?.message ?? e), status: e?.status }; } };
const storedPages = async (org) => (await lite.query(`SELECT count(*)::int n FROM document_pages WHERE tenant_id=$1`, [await tid(org)])).rows[0].n;
const counter = async (org) => { try { const r = await lite.query(`SELECT pages::bigint p FROM page_usage_monthly WHERE tenant_id=$1 AND month=(date_trunc('month', now() AT TIME ZONE 'UTC'))::date`, [await tid(org)]); return r.rows[0] ? Number(r.rows[0].p) : 0; } catch { return null; } };

async function mkDoc(org, filename = 'h.txt', contentType = 'text/plain', size = 100) {
  const id = await tid(org);
  return (await lite.query(`INSERT INTO documents (tenant_id, original_filename, sha256_hash, file_size_bytes, content_type, storage_key, stage) VALUES ($1,$2,$3,$4,$5,$6,'received') RETURNING id`, [id, filename, sha(), size, contentType, `${id}/seam/${sha().slice(0, 10)}`])).rows[0].id;
}
/** a pre-read plain page block: n pages counted through the real write path */
async function seedRead(org, n) {
  const d = await mkDoc(org, 'seed.txt');
  await W(org, (db) => db.upsertPages(d, Array.from({ length: n }, (_, i) => ({ page_no: i + 1, text: `seed page ${i + 1}` }))));
  resetCaches();
  return d;
}
/** a .docx whose text is about `chars` characters (one page for every 3,000 characters) */
const docx = (chars, tag = 'seam') => {
  const para = (i) => p(`${tag} paragraph ${i} ` + 'compressor service record entry '.repeat(15));
  const n = Math.max(1, Math.ceil(chars / 500));
  return buildDocx(Array.from({ length: n }, (_, i) => para(i)).join(''));
};
const realFetch = globalThis.fetch;
const serve = (buf) => { globalThis.fetch = async () => new Response(buf, { status: 200 }); };
const readOffice = (org, docId, opts = {}) => capture(() => READ.ingestDocument(ctxOf(org), docId, { userId: 'user_admin', ...opts }));
const solo = (org, extra = {}) => newTenant(org, 'solo', 'active', { ...PLAN.PLAN_LIMITS.solo, ...extra });

try {
  /* ----------------------------------------------------------------- the same number in the refusal and in the gate */
  setFamily('same-number');
  {
    const ORG = 'org_seam_same'; await solo(ORG);
    await seedRead(ORG, 748); // 2 pages left of 750
    const gate = await UPH.checkUploadGate(authFor(ORG));
    check('S1', 'gate at 748 of 750 pages read: allowed, 2 pages of room', gate.allowed === true && gate.pagesRemaining === 2, JSON.stringify({ ...gate, billingRow: undefined }));
    const buf = docx(12_000); // about 4 pages: does not fit in 2
    serve(buf);
    const d = await mkDoc(ORG, 'big.docx', DOCX_MIME, buf.length);
    const r = await readOffice(ORG, d);
    check('S2', 'a Word file of more than 2 pages is refused at read time with 402 and quotes "2 left" (the gate\'s number)', r?.status === 402 && /you have 2 left this month/.test(r?.__err ?? ''), JSON.stringify(r));
    check('S3', 'the refusal stores nothing and counts nothing (live 748, tally 748)', (await storedPages(ORG)) === 748 && (await counter(ORG)) === 748 && (await pagesNow(ORG)) === 748, `${await storedPages(ORG)} ${await counter(ORG)} ${await pagesNow(ORG)}`);
  }

  /* ----------------------------------------------------------------- exact fit admitted, one over refused */
  setFamily('exact-fit');
  {
    const ORG = 'org_seam_fit'; await solo(ORG);
    await seedRead(ORG, 745);
    const small = docx(1_000); serve(small); // 1 page
    const d1 = await mkDoc(ORG, 'one.docx', DOCX_MIME, small.length);
    const r1 = await readOffice(ORG, d1);
    const n1 = (await lite.query(`SELECT count(*)::int n FROM document_pages WHERE document_id=$1`, [d1])).rows[0].n;
    check('S4', 'a 1-page Word file with room for 5: read, its pages stored and counted exactly once (tally = live = 745 + pages)', !r1?.__err && n1 >= 1 && (await counter(ORG)) === 745 + n1 && (await pagesNow(ORG)) === 745 + n1, `${JSON.stringify(r1)} n1=${n1} ${await counter(ORG)} ${await pagesNow(ORG)}`);
    const left = 750 - (745 + n1);
    const exact = docx(3_000 * Math.max(1, left) - 800); serve(exact); // fills the room exactly (or less)
    const d2 = await mkDoc(ORG, 'exact.docx', DOCX_MIME, exact.length);
    const r2 = await readOffice(ORG, d2);
    const used2 = await pagesNow(ORG);
    check('S5', 'a Word file that exactly fits what is left is admitted and the month lands on or under the cap (never over)', !r2?.__err && used2 <= 750 && used2 > 745 + n1, `${JSON.stringify(r2)} used=${used2}`);
    const over = docx(3_000 * 10); serve(over);
    const d3 = await mkDoc(ORG, 'over.docx', DOCX_MIME, over.length);
    const r3 = await readOffice(ORG, d3);
    check('S6', 'a Word file bigger than what is left is refused 402 and nothing is added', r3?.status === 402 && (await pagesNow(ORG)) === used2 && (await storedPages(ORG)) === used2, `${JSON.stringify(r3)} ${await pagesNow(ORG)}`);
  }

  /* ----------------------------------------------------------------- delete-and-reupload at the cap */
  setFamily('delete-reupload');
  {
    const ORG = 'org_seam_del'; await solo(ORG);
    await seedRead(ORG, 740);
    const buf = docx(9_000); serve(buf);
    const d1 = await mkDoc(ORG, 'report.docx', DOCX_MIME, buf.length);
    const r1 = await readOffice(ORG, d1);
    const pg = (await lite.query(`SELECT count(*)::int n FROM document_pages WHERE document_id=$1`, [d1])).rows[0].n;
    const used1 = await pagesNow(ORG);
    check('S7', 'the Word file is read (740 + its pages) and the tally agrees with the live count', !r1?.__err && pg >= 2 && used1 === 740 + pg && (await counter(ORG)) === used1, `${JSON.stringify(r1)} pg=${pg} used=${used1}`);
    const dres = await del(ORG, [d1]);
    check('S8', 'deleting the Word file removes its page rows, yet the month still shows the same number (tally keeps it)', dres.statusCode === 200 && (await storedPages(ORG)) === 740 && (await pagesNow(ORG)) === used1, `${dres.statusCode} stored=${await storedPages(ORG)} used=${await pagesNow(ORG)}`);
    // fill what is left of the cap with plain pages, then upload the same Word file again
    if (used1 < 750) await seedRead(ORG, 750 - used1);
    resetCaches();
    const gate = await UPH.checkUploadGate(authFor(ORG));
    check('S9', 'at the cap after the delete the upload gate refuses (402) with the 750 message', gate.allowed === false && gate.status === 402 && /^Monthly page limit reached \(750\)\./.test(gate.error ?? ''), JSON.stringify({ ...gate, billingRow: undefined }));
    serve(buf);
    const d2 = await mkDoc(ORG, 'report-again.docx', DOCX_MIME, buf.length);
    const r2 = await readOffice(ORG, d2);
    check('S10', 'the same Word file uploaded again after the delete is refused at read time too (402, 0 left) and nothing is stored for it', r2?.status === 402 && /you have 0 left/.test(r2?.__err ?? '') && (await lite.query(`SELECT count(*)::int n FROM document_pages WHERE document_id=$1`, [d2])).rows[0].n === 0, JSON.stringify(r2));
  }

  /* ----------------------------------------------------------------- forced re-read of a counted Word file */
  setFamily('re-read');
  {
    const ORG = 'org_seam_reread'; await solo(ORG);
    const buf = docx(9_000); serve(buf);
    const d = await mkDoc(ORG, 'again.docx', DOCX_MIME, buf.length);
    await readOffice(ORG, d);
    const pg = (await lite.query(`SELECT count(*)::int n FROM document_pages WHERE document_id=$1`, [d])).rows[0].n;
    await seedRead(ORG, 750 - pg); // the month is now exactly full
    const before = await pagesNow(ORG);
    const r = await readOffice(ORG, d, { force: true });
    check('S11', 'a forced re-read of the already-counted Word file at a full month is not refused and does not count its pages twice', !r?.__err && (await pagesNow(ORG)) === before && before === 750 && (await counter(ORG)) === 750, `${JSON.stringify(r)} ${before} ${await pagesNow(ORG)} ${await counter(ORG)}`);
  }

  /* ----------------------------------------------------------------- Excel counts through the same trigger */
  setFamily('xlsx');
  {
    const ORG = 'org_seam_xlsx'; await solo(ORG);
    const rows = [['Customer', 'Invoice', 'Amount'], ...Array.from({ length: 400 }, (_, i) => [`Customer ${i}`, `INV-${1000 + i}`, 100 + i])];
    const buf = buildXlsx([{ name: 'Invoices', rows }]); serve(buf);
    const d = await mkDoc(ORG, 'book.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buf.length);
    const r = await readOffice(ORG, d);
    const pg = (await lite.query(`SELECT count(*)::int n FROM document_pages WHERE document_id=$1`, [d])).rows[0].n;
    check('S12', 'an Excel file is read and its pages are counted exactly once in the monthly tally (tally = live = stored pages)', !r?.__err && pg >= 1 && (await counter(ORG)) === pg && (await pagesNow(ORG)) === pg, `${JSON.stringify(r)} pg=${pg} ${await counter(ORG)}`);
  }

  /* ----------------------------------------------------------------- a renamed program and a fake Word file */
  setFamily('hostile-files');
  {
    const ORG = 'org_seam_hostile'; await solo(ORG);
    const exe = await post(ORG, { filename: 'invoice.exe', sha256: sha(), sizeBytes: 5000, contentType: 'application/octet-stream' });
    check('S13', 'a program (.exe) is refused at upload with 415 and no document row is created', exe.statusCode === 415 && (await lite.query(`SELECT count(*)::int n FROM documents WHERE tenant_id=$1`, [await tid(ORG)])).rows[0].n === 0, `${exe.statusCode} ${JSON.stringify(exe.body)}`);
    const exe2 = await post(ORG, { filename: 'invoice.docx', sha256: sha(), sizeBytes: 5000, contentType: 'application/x-msdownload' });
    check('S14', 'a program renamed .docx but declared as a program type is refused 415 (declared type must match the name)', exe2.statusCode === 415, `${exe2.statusCode} ${JSON.stringify(exe2.body)}`);
    const fake = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(2000, 7)]); serve(fake);
    const d = await mkDoc(ORG, 'fake.docx', DOCX_MIME, fake.length);
    const r = await readOffice(ORG, d);
    check('S15', 'a program\'s bytes inside a file named .docx are refused when read (4xx) and nothing is stored or counted', !!r?.__err && (r.status >= 400 && r.status < 500) && (await storedPages(ORG)) === 0 && ((await counter(ORG)) ?? 0) === 0, JSON.stringify(r));
  }

  /* ----------------------------------------------------------------- the staff import keeps Word pages out of the tally */
  setFamily('import-window');
  {
    const ORG = 'org_seam_import'; await solo(ORG, { staffImport: { from: new Date(Date.now() - 3_600_000).toISOString(), until: new Date(Date.now() + 10 * D).toISOString(), pages: 5000, documents: 100, ingestPerMinute: 600, ingestPerDay: 200_000 } });
    resetCaches();
    const buf = docx(9_000); serve(buf);
    const d = await mkDoc(ORG, 'import.docx', DOCX_MIME, buf.length);
    const r = await readOffice(ORG, d);
    check('S16', 'during a staff import a Word file is read against the import budget and its pages stay out of the monthly tally (tally 0, month 0)', !r?.__err && (await storedPages(ORG)) >= 2 && ((await counter(ORG)) ?? 0) === 0 && (await pagesNow(ORG)) === 0, `${JSON.stringify(r)} ${await storedPages(ORG)} ${await counter(ORG)}`);
  }
} finally { globalThis.fetch = realFetch; }
finish();
