/**
 * Office build, Engineer B: the UPLOAD allow-list at every place a file enters, the page estimate, iPhone-photo conversion, zip
 * contents, and the "every statement of accepted types agrees" consistency test.
 * No network, no real R2 / Neon / model: PGlite as the RLS role (scripts/lib/r35Harness.mjs); the browser pieces run in node with
 * mocked createImageBitmap / canvas / fetch. Real HEIC decoding on a real iPhone/Safari CANNOT be tested here.
 *
 *   npx tsx scripts/verify-office-uploads.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { bootHarness } from './lib/r35Harness.mjs';

const h = await bootHarness();
const { lite, RS, newTenant, rnd, root } = h;
const rel = (p) => path.join(root, p);
const read = (p) => fs.readFileSync(rel(p), 'utf8');

const fam = {};
let family = 'misc';
let failed = 0;
const check = (name, ok, detail = '') => {
  fam[family] ??= { pass: 0, fail: 0 };
  fam[family][ok ? 'pass' : 'fail']++;
  if (!ok) console.log(`FAIL  [${family}] ${name}${detail ? `  -> ${detail}` : ''}`);
  if (!ok) failed++;
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const quiet = async (fn) => { const e = console.error, w = console.warn; console.error = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.error = e; console.warn = w; } };
const mkRes = () => { const r = { statusCode: 0, body: null, headers: {}, status(c) { r.statusCode = c; return r; }, json(b) { r.body = b; return r; }, setHeader(k, v) { r.headers[k] = v; return r; }, end() { return r; } }; return r; };
const MiB = 1024 * 1024;

const UT = await import(rel('api/_lib/uploadTypes.js'));
const LIM = await import(rel('api/_lib/office/limits.js'));
const UP = await import(rel('api/upload-url.js'));
const RECORDS = await import(rel('api/records.ts'));
const PLAN = await import(rel('api/_lib/plan.js'));
const V1 = await import(rel('api/_lib/routes/v1-ingest.js'));
const KEYS = await import(rel('api/_lib/routes/keys.js'));
const { EXT_KIND, EXT_CONTENT_TYPES, checkUploadFile, extensionOf, KIND_CAP_BYTES } = UT;
const DOCX = UT.DOCX_CONTENT_TYPE, XLSX = UT.XLSX_CONTENT_TYPE;
const ACCEPTED = Object.keys(EXT_KIND);

const authFor = (key, userId = 'user_1') => ({ tenantId: key, orgId: key, userId, orgRole: 'admin' });
const countDocs = async (tenantId) => (await lite.query('SELECT count(*)::int AS n FROM documents WHERE tenant_id = $1', [tenantId])).rows[0].n;

/* ============================================================ A. the allow-list, as a pure matrix */
family = 'allow-list';
{
  eq('the accepted extensions are exactly the ACCEPT LIST in the brief', ACCEPTED.sort(), ['csv', 'docx', 'gif', 'jpeg', 'jpg', 'json', 'md', 'pdf', 'png', 'tsv', 'txt', 'webp', 'xlsx']);
  const capOf = (kind) => (kind === 'pdf' || kind === 'image' ? 24 * MiB : kind === 'text' || kind === 'sheet-text' ? LIM.MAX_SHEET_TEXT_UPLOAD_BYTES : LIM.MAX_OFFICE_UPLOAD_BYTES);
  for (const ext of ACCEPTED) {
    const kind = EXT_KIND[ext];
    const cap = capOf(kind);
    check(`${ext}: the cap table matches the brief (${kind})`, KIND_CAP_BYTES[kind] === cap, `${KIND_CAP_BYTES[kind]} vs ${cap}`);
    // declared types: none, empty, octet-stream, every legitimate type (also upper-case with parameters) are accepted and stored canonically
    const legit = EXT_CONTENT_TYPES[ext];
    for (const declared of [undefined, null, '', 'application/octet-stream', ...legit, ...legit.map((t) => `${t.toUpperCase()}; charset=binary`)]) {
      const r = checkUploadFile({ filename: `File.${ext}`, contentType: declared, sizeBytes: 1000 });
      check(`${ext} + ${JSON.stringify(declared)} -> accepted, canonical type stored`, r.ok === true && r.kind === kind && r.contentType === legit[0] && r.ext === ext, JSON.stringify(r));
    }
    // declared types that do not belong to the extension are refused with a 415 and a plain message
    for (const wrong of ['text/html', 'application/x-msdownload', 'image/svg+xml', 'application/zip', 'video/mp4', 'application/x-sh', 'image/heic', 'application/msword', 'image/tiff', 'application/xml', 'text/xml']) {
      if (legit.includes(wrong)) continue;
      const r = checkUploadFile({ filename: `File.${ext}`, contentType: wrong, sizeBytes: 1000 });
      check(`${ext} declared as ${wrong} -> refused 415`, r.ok === false && r.status === 415 && r.message.length > 40, JSON.stringify(r));
    }
    // sizes: cap-1 and cap pass, cap+1 is a 413, and the absolute ceiling is the 100 MB message; with and WITHOUT a declared type (L-2)
    for (const declared of [undefined, 'application/octet-stream', legit[0]]) {
      const at = (n) => checkUploadFile({ filename: `big.${ext}`, contentType: declared, sizeBytes: n });
      check(`${ext} (${declared ?? 'no type'}) cap-1 and cap accepted`, at(cap - 1).ok && at(cap).ok);
      const over = at(cap + 1);
      check(`${ext} (${declared ?? 'no type'}) cap+1 -> 413`, over.ok === false && over.status === 413 && over.message.length > 30, JSON.stringify(over));
      check(`${ext} (${declared ?? 'no type'}) 100 MiB -> 413, 100 MiB+1 -> the absolute message`, at(100 * MiB).status === 413 && at(100 * MiB + 1).message === 'File is larger than 100 MB');
    }
  }
  eq('pdf/photo over-cap message is the existing wording', checkUploadFile({ filename: 'a.pdf', sizeBytes: 24 * MiB + 1 }).message, 'PDFs and photos have to be under 24 MB to be read. Split this into smaller files, or scan at a lower resolution, and upload again.');
  eq('text over-cap message is the existing wording', checkUploadFile({ filename: 'a.csv', sizeBytes: 20 * MiB + 1 }).message, 'Text and spreadsheet files have to be under 20 MB. Split this into smaller files and upload them separately.');
  check('Word/Excel over-cap names Word and Excel', /Word and Excel/.test(checkUploadFile({ filename: 'a.docx', sizeBytes: 20 * MiB + 1 }).message));

  // every refused extension, with the "what to do" wording
  const refused = {
    doc: /Save As/, xls: /Save As/, ppt: /Save As/, dot: /Save As/, docm: /macros/, xlsm: /macros/, xlsb: /macros/, dotm: /macros/, xltm: /macros/, pptm: /macros/,
    exe: /never accepted/, msi: /never accepted/, bat: /never accepted/, js: /never accepted/, sh: /never accepted/, ps1: /never accepted/, dll: /never accepted/,
    zip: /Add files|unzip/i, rar: /Unzip/, '7z': /Unzip/, heic: /Most Compatible/, heif: /Most Compatible/, tif: /PDF, JPEG or PNG/, tiff: /PDF, JPEG or PNG/, bmp: /PDF, JPEG or PNG/,
    svg: /PDF, JPEG or PNG/, avif: /PDF, JPEG or PNG/, html: /not accepted/, htm: /not accepted/, xml: /not accepted/, mp4: /not accepted/, mov: /not accepted/, rtf: /PDF, \.docx or \.xlsx/,
    odt: /PDF, \.docx or \.xlsx/, pptx: /not accepted/, eml: /not accepted/, msg: /not accepted/, log: /not accepted/, yaml: /not accepted/, ini: /not accepted/, md5: /not accepted/,
  };
  for (const [ext, re] of Object.entries(refused)) {
    for (const declared of [undefined, 'application/octet-stream', 'application/pdf', 'text/plain']) {
      const r = checkUploadFile({ filename: `thing.${ext}`, contentType: declared, sizeBytes: 500 });
      check(`refused .${ext} (${declared ?? 'no type'}) -> 415 with a what-to-do message`, r.ok === false && r.status === 415 && re.test(r.message) && !/(\bexecut|\brun\b)/i.test(r.message.replace(/never accepted|programs and scripts/gi, '')), JSON.stringify(r));
    }
  }
  check('xml and text/* blanket acceptance are gone: .xml refused, text/html on a .txt refused', checkUploadFile({ filename: 'a.xml', contentType: 'application/xml' }).ok === false && checkUploadFile({ filename: 'a.txt', contentType: 'text/html' }).ok === false);

  // names that try to confuse the extension
  const nameCases = [
    ['invoice.pdf.exe', false], ['invoice.exe.pdf', true], ['INVOICE.PDF', true], ['Report.DocX', true], ['sheet.XLSX', true], ['a.pdf.', true], ['a.pdf   ', true], ['a.pdf . .', true],
    ['noext', false], ['.pdf', false], ['a.', false], ['', false], ['a. pdf', false], ['a.p df', false], ['a.pdf\u0000.exe', false], ['dir/sub/file.xlsx', true], ['C:\\x\\y.docx', true],
    ['invoice\u202Etxt.exe', false], ['photo\u202Egpj.exe', false], ['evil.exe\u202E.pdf', true], ['a.p\u200Bdf', true], ['a\uFF0Epdf', true], ['..\\..\\a.pdf', true], ['a.pdf;.exe', false],
    ['a.pdfx', false], ['a.docx.docm', false], ['a.xlsx.xlsm', false], ['a.csv.zip', false],
  ];
  for (const [name, ok] of nameCases) {
    const r = checkUploadFile({ filename: name, contentType: undefined, sizeBytes: 100 });
    check(`name ${JSON.stringify(name)} -> ${ok ? 'accepted' : 'refused'}`, r.ok === ok, JSON.stringify(r));
  }
  eq('extensionOf strips right-to-left and invisible characters and trailing dots/spaces', [extensionOf('x.\u202Epdf'), extensionOf('x.pdf. '), extensionOf('A.PNG')], ['pdf', 'pdf', 'png']);
  const noExt = checkUploadFile({ filename: 'mystery', sizeBytes: 90 * MiB });
  check('a name with no extension and 90 MiB is refused (limits-caps Z:type:none)', noExt.ok === false && noExt.status >= 400 && noExt.status < 500);
  check('every refusal message ends with something to do (mentions the accepted list or an action)', ['a.exe', 'a.doc', 'a.zip', 'a.heic', 'a.docm', 'noext', 'a.xyz'].every((n) => /accepts|Save As|Unzip|unzip|upload|Add files|JPEG|rename/i.test(checkUploadFile({ filename: n }).message)));
  check('no refusal message claims Word/Excel (.docx/.xlsx) is unsupported', ['a.doc', 'a.xls', 'a.xyz', 'a.docm'].every((n) => !/(word|excel)[^.]*(aren't|are not|isn't|not) accepted/i.test(checkUploadFile({ filename: n }).message)));
}

/* ============================================================ B. server entry points: no row, no signed URL for a refusal */
family = 'entry-points';
let tenantId;
{
  const TK = 'org_office_uploads';
  tenantId = await newTenant(TK, 'fleet');
  const auth = authFor(TK);
  const before = await countDocs(tenantId);
  const body = (o) => ({ sha256: rnd(), sizeBytes: 1000, ...o });

  // single path: every refused file is a 4xx throw, with NO row
  const refusedFiles = [
    { filename: 'virus.exe', contentType: 'application/x-msdownload' }, { filename: 'old.doc', contentType: 'application/msword' }, { filename: 'old.xls', contentType: 'application/vnd.ms-excel' },
    { filename: 'macro.xlsm' }, { filename: 'macro.docm' }, { filename: 'book.xlsb' }, { filename: 'a.zip', contentType: 'application/zip' }, { filename: 'iphone.heic', contentType: 'image/heic' },
    { filename: 'iphone.HEIF' }, { filename: 'noextension' }, { filename: 'invoice.pdf.exe', contentType: 'application/pdf' }, { filename: 'x.html', contentType: 'text/html' }, { filename: 'a.svg' },
    { filename: 'a.pdf', contentType: 'text/html' }, { filename: 'a.docx', contentType: 'application/pdf' }, { filename: 'a.xml', contentType: 'application/xml' }, { filename: 'a.tiff', contentType: 'image/tiff' },
    { filename: 'a.pdf', sizeBytes: 90 * MiB }, { filename: 'a.docx', sizeBytes: 21 * MiB }, { filename: 'a.xlsx', sizeBytes: 50 * MiB, contentType: XLSX }, { filename: 'a.csv', sizeBytes: 21 * MiB }, { filename: 'a.txt', sizeBytes: 150 * MiB },
  ];
  for (const f of refusedFiles) {
    let err = null, out = null;
    try { out = await UP.createUploadUrl(auth, body(f)); } catch (e) { err = e; }
    check(`single: ${f.filename} ${f.contentType ?? ''} ${f.sizeBytes ?? ''} refused 4xx, no signed URL`, err && err.status >= 400 && err.status < 500 && !out, `${err?.status} ${err?.message}`);
  }
  eq('single: NO document row for any refused file (count before/after)', await countDocs(tenantId), before);

  // accepted: a row and a signed URL; the stored content type is the canonical one
  const goodFiles = [
    { filename: 'a.pdf', contentType: 'application/pdf' }, { filename: 'a.DOCX', contentType: DOCX }, { filename: 'a.xlsx', contentType: '' }, { filename: 'a.csv', contentType: 'application/vnd.ms-excel' },
    { filename: 'a.md', contentType: 'text/x-markdown' }, { filename: 'a.json', contentType: 'text/json' }, { filename: 'a.jpg' }, { filename: 'a.tsv', contentType: 'application/octet-stream' },
  ];
  for (const f of goodFiles) {
    const out = await UP.createUploadUrl(auth, body(f));
    check(`single: ${f.filename} ${f.contentType ?? ''} accepted with a signed URL`, !!out.documentId && /^https:/.test(out.uploadUrl ?? ''), JSON.stringify(out));
  }
  eq('single: accepted files each made exactly one row', await countDocs(tenantId), before + goodFiles.length);
  const { rows: stored } = await lite.query(`SELECT original_filename, content_type FROM documents WHERE tenant_id = $1 ORDER BY created_at, original_filename`, [tenantId]);
  const typeOf = (n) => stored.find((r) => r.original_filename === n)?.content_type;
  eq('stored content types are canonical (csv declared as ms-excel -> text/csv; md x-markdown -> text/markdown; none -> by extension)', [typeOf('a.csv'), typeOf('a.md'), typeOf('a.json'), typeOf('a.xlsx'), typeOf('a.tsv'), typeOf('a.jpg')], ['text/csv', 'text/markdown', 'application/json', XLSX, 'text/tab-separated-values', 'image/jpeg']);

  // batch: mixed good/bad keeps order and gives per-item errors; refused ones create no row and have no URL
  const b0 = await countDocs(tenantId);
  const batch = await UP.createUploadUrls(auth, [
    body({ filename: 'one.pdf', contentType: 'application/pdf' }), body({ filename: 'two.exe' }), body({ filename: 'three.docx', contentType: DOCX }), body({ filename: 'four.heic', contentType: 'image/heic' }),
    body({ filename: 'five.xlsx' }), body({ filename: 'six.xlsm' }), body({ filename: 'seven.csv', contentType: 'text/csv' }), body({ filename: 'eight.pdf', sizeBytes: 25 * MiB }), body({ filename: 'nine.zip' }), body({ filename: 'ten.txt' }),
  ]);
  eq('batch: results come back in the same order, 10 of 10', batch.map((r) => r.filename), ['one.pdf', 'two.exe', 'three.docx', 'four.heic', 'five.xlsx', 'six.xlsm', 'seven.csv', 'eight.pdf', 'nine.zip', 'ten.txt']);
  const okIdx = [0, 2, 4, 6, 9], badIdx = [1, 3, 5, 7, 8];
  check('batch: good files have a documentId and a signed URL', okIdx.every((i) => batch[i].documentId && /^https:/.test(batch[i].uploadUrl ?? '')), JSON.stringify(batch));
  check('batch: bad files have their OWN error + 4xx status and no documentId and no URL', badIdx.every((i) => batch[i].error?.length > 30 && batch[i].status >= 400 && batch[i].status < 500 && !batch[i].documentId && !batch[i].uploadUrl), JSON.stringify(badIdx.map((i) => batch[i])));
  eq('batch: statuses are 415 for types, 413 for the over-cap PDF', badIdx.map((i) => batch[i].status), [415, 415, 415, 413, 415]);
  eq('batch: only the 5 good files created rows', await countDocs(tenantId), b0 + 5);
  check('batch: the HEIC item says what to do (Most Compatible), the .doc-type items say Save As / macros', /Most Compatible/.test(batch[3].error) && /macros/.test(batch[5].error));

  // /api/v1-ingest uses createUploadUrl (same validation): prove it with a real API key, and a source check
  check('v1-ingest reaches the allow-list only through createUploadUrl (no second path)', /createUploadUrl\(auth, req\.body\)/.test(read('api/_lib/routes/v1-ingest.js')) && !/createDocument/.test(read('api/_lib/routes/v1-ingest.js')));
  const key = await KEYS.createApiKey({ tenantKey: TK, tenantName: TK }, authFor(TK), { name: 'ingest', scopes: ['ingest'] });
  check('api key created for the v1 test', key.status === 201 && /^dw_live_/.test(key.body?.key ?? ''), JSON.stringify({ ...key.body, key: undefined }));
  const v1 = async (b) => { const res = mkRes(); await quiet(() => V1.default({ method: 'POST', headers: { authorization: `Bearer ${key.body.key}` }, body: b }, res)); return res; };
  const v0 = await countDocs(tenantId);
  for (const f of [{ filename: 'x.exe' }, { filename: 'x.doc' }, { filename: 'x.heic', contentType: 'image/heic' }, { filename: 'x.zip' }, { filename: 'noext' }, { filename: 'x.docx', contentType: 'text/html' }, { filename: 'x.xlsx', sizeBytes: 30 * MiB }]) {
    const res = await v1(body(f));
    check(`v1-ingest: ${f.filename} refused ${res.statusCode}, no URL`, res.statusCode >= 400 && res.statusCode < 500 && !res.body?.uploadUrl && !res.body?.documentId && /\w/.test(res.body?.error ?? ''), JSON.stringify(res.body));
  }
  eq('v1-ingest: no document row for any refused file', await countDocs(tenantId), v0);
  const good = await v1(body({ filename: 'ok.docx', contentType: DOCX }));
  check('v1-ingest: an allowed Word file gets a document and a signed URL', (good.statusCode === 0 || good.statusCode === 200) && !!good.body?.documentId && /^https:/.test(good.body?.uploadUrl ?? ''), JSON.stringify(good));

  // records.ts createDocument: the other way a document row is created
  const call = async (b) => { const res = mkRes(); await quiet(() => RECORDS.processRecords({ method: 'POST', headers: {}, body: b }, res, authFor(TK))); return res; };
  const r0 = await countDocs(tenantId);
  const cd = (o) => ({ action: 'createDocument', sha256_hash: rnd(), file_size_bytes: 1000, ...o });
  for (const f of [{ original_filename: 'virus.exe', content_type: 'application/x-msdownload' }, { original_filename: 'a.doc' }, { original_filename: 'a.heic', content_type: 'image/heic' }, { original_filename: 'a.zip' }, { original_filename: 'noext' }, { original_filename: 'a.pdf', content_type: 'text/html' }, { original_filename: 'a.docx', file_size_bytes: 21 * MiB }, { original_filename: 'a.pdf', file_size_bytes: 25 * MiB }]) {
    const res = await call(cd(f));
    check(`records createDocument: ${f.original_filename} refused ${res.statusCode}`, res.statusCode >= 400 && res.statusCode < 500 && !res.body?.id && /\w/.test(res.body?.error ?? ''), JSON.stringify(res.body));
  }
  eq('records createDocument: no document row for any refused file', await countDocs(tenantId), r0);
  const okc = await call(cd({ original_filename: 'sheet.xlsx', content_type: '' }));
  check('records createDocument: an allowed file is created and stores the canonical type', (okc.statusCode === 0 || okc.statusCode === 200) && !!okc.body?.id && (await lite.query('SELECT content_type FROM documents WHERE id = $1', [okc.body.id])).rows[0].content_type === XLSX, JSON.stringify(okc.body));

  // every place that can create a document row is covered: static proof
  const creators = [];
  for (const dir of ['api', 'src', 'scripts/import']) {
    const walk = (d) => fs.readdirSync(rel(d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]));
    for (const f of walk(dir)) if (/\.(js|ts|tsx|mjs)$/.test(f) && /\bcreateDocument\s*[(:]|\bINSERT INTO documents\b/.test(read(f))) creators.push(f);
  }
  const allowed = ['api/_lib/recordsStore.js', 'api/upload-url.js', 'api/records.ts', 'src/services/postgresRecordsStore.ts', 'src/services/recordsStoreClient.ts', 'api/_lib/members.js', 'api/_lib/routes/tenant-delete.js', 'api/_lib/opsStore.js'];
  check('only known code can insert or create a document row', creators.every((f) => allowed.includes(f)), creators.filter((f) => !allowed.includes(f)).join(', '));
  check('api/upload-url.js and api/records.ts both call the allow-list', /checkUploadFile/.test(read('api/upload-url.js')) && /checkUploadFile/.test(read('api/records.ts')));
  check('the store-level createDocument is only reachable through those two (records.ts strips storage_key/stage and validates)', /cleanCreateDocumentPayload\(payload\)/.test(read('api/records.ts')));
  check('expenses receipts create no document row and accept only PDF/JPEG/PNG/GIF/WebP (narrower than the list)', !/createDocument|INSERT INTO documents/.test(read('api/_lib/routes/expenses.js')) && /RECEIPT_TYPES = \/\^\(application\\\/pdf\|image\\\/\(jpeg\|png\|gif\|webp\)\)\$\//.test(read('api/_lib/routes/expenses.js')));
}

/* ============================================================ C. staff import tool */
family = 'staff-import';
{
  const T = await import(rel('scripts/import/deepwell-import.mjs'));
  for (const ext of ACCEPTED) {
    const r = T.classifyFile(`folder/File.${ext}`, 1000);
    check(`staff import accepts .${ext} with the same canonical type as the server`, r.ok === true && r.contentType === EXT_CONTENT_TYPES[ext][0], JSON.stringify(r));
  }
  eq('staff import table has exactly the server extensions (no drift)', Object.keys(T.SUPPORTED).sort(), ACCEPTED.slice().sort());
  eq('staff import limits match the server (24 / 20 / 100 MB)', [T.LIMITS.model, T.LIMITS.text, T.LIMITS.absolute], [24 * MiB, LIM.MAX_OFFICE_UPLOAD_BYTES, 100 * MiB]);
  for (const ext of ['doc', 'xls', 'ppt', 'docm', 'xlsm', 'xlsb', 'heic', 'heif', 'zip', 'exe', 'tif', 'svg', 'bmp', 'xml', 'html']) {
    const r = T.classifyFile(`File.${ext}`, 1000);
    check(`staff import refuses .${ext} (as the server does) with a note`, r.ok === false && r.reason === 'unsupported-type' && r.note.length > 30 && checkUploadFile({ filename: `File.${ext}` }).ok === false, JSON.stringify(r));
  }
  check('staff import size caps follow the kind (docx 20 MB, pdf 24 MB)', T.classifyFile('a.docx', 21 * MiB).ok === false && T.classifyFile('a.docx', 20 * MiB).ok === true && T.classifyFile('a.pdf', 24 * MiB).ok === true && T.classifyFile('a.pdf', 24 * MiB + 1).ok === false);
  for (const [t, n] of [[DOCX, 100_000], [XLSX, 100_000], ['text/csv', 100_000], ['application/pdf', 2_000_000], ['image/jpeg', 100_000], ['text/plain', 100_000]]) {
    const ext = Object.keys(EXT_CONTENT_TYPES).find((e) => EXT_CONTENT_TYPES[e][0] === t);
    const kind = T.SUPPORTED[ext][1];
    eq(`staff import page planning for .${ext} equals the server estimate`, T.gatePages(kind, n, ext), PLAN.estimatePagesForUpload(t, n));
  }
}

/* ============================================================ D. page estimate */
family = 'estimate';
{
  const est = PLAN.estimatePagesForUpload;
  eq('photos are 1 page, PDFs unchanged (204,800 bytes a page), txt/md/json unchanged (6,000)', [est('image/jpeg', 5e6), est('application/pdf', 204_800 * 3), est('text/plain', 60_000), est('text/markdown', 6000), est('application/json', 1)], [1, 3, 10, 1, 1]);
  eq('docx: min 1; fixed overhead then 1,500 bytes a page; cap 200', [est(DOCX, 0), est(DOCX, 6000), est(DOCX, 7500), est(DOCX, 7501), est(DOCX, 20 * MiB)], [1, 1, 1, 2, 200]);
  eq('xlsx: min 1; fixed overhead then 1,500 bytes a page; cap = the reader limit', [est(XLSX, 1), est(XLSX, 2000), est(XLSX, 3500), est(XLSX, 3501), est(XLSX, 20 * MiB)], [1, 1, 1, 2, LIM.MAX_PAGES_PER_FILE]);
  eq('csv/tsv: min 1; 3,000 bytes a page', [est('text/csv', 1), est('text/csv', 3000), est('text/csv', 3001), est('text/tab-separated-values', 30_000)], [1, 1, 2, 10]);
  // The SQL estimate (pending pages) must agree with the JS rule for each type: seed documents and compare.
  const TK = 'org_office_estimate';
  const id = await newTenant(TK, 'fleet');
  const cases = [[DOCX, 100_000], [DOCX, 5000], [XLSX, 129_298], [XLSX, 775_080], ['text/csv', 270_399], ['text/tab-separated-values', 3199], ['application/pdf', 1_000_000], ['image/png', 90_000], ['text/plain', 12_345], [null, 12_345]];
  let sqlTotal = 0, jsTotal = 0;
  for (const [t, n] of cases) {
    await lite.query(`INSERT INTO documents (tenant_id, original_filename, sha256_hash, file_size_bytes, stage, storage_key, content_type) VALUES ($1,'e.bin',$2,$3,'received','k',$4)`, [id, rnd(), n, t]);
    jsTotal += est(t, n);
  }
  sqlTotal = await RS.withTenant({ tenantKey: TK, tenantName: TK }, (db) => db.estimatePendingPages());
  eq('SQL pending-pages estimate (recordsStore) == JS estimatePagesForUpload summed over the same documents', sqlTotal, jsTotal);

  // calibration against the tester's fixtures: estimate vs the oracle's range and vs what Engineer A's reader actually counts
  const exp = JSON.parse(read('scripts/office-fixtures/expected.json')).files;
  let reader = null;
  try { reader = await import(rel('api/_lib/office/index.js')); } catch { /* reader not present */ }
  const rows = [];
  for (const [name, v] of Object.entries(exp)) {
    if (v.upload !== 'accept' || !v.structure?.pagesRange || !/\.(docx|xlsx|csv|tsv)$/.test(name)) continue;
    const ext = name.split('.').pop();
    const ct = EXT_CONTENT_TYPES[ext][0];
    const bytes = fs.readFileSync(rel(`scripts/office-fixtures/files/${name}`));
    const e = est(ct, bytes.length);
    let final = null;
    if (reader) { const r = reader.readOfficeFile(bytes, { filename: name }); if (r.ok && Array.isArray(r.pages)) final = r.pages.length; }
    rows.push({ name, ext, bytes: bytes.length, est: e, lo: v.structure.pagesRange[0], hi: v.structure.pagesRange[1], final });
  }
  check('fixtures were found for the calibration', rows.length >= 25, String(rows.length));
  const KNOWN_UNDER = new Set(['large-service-manual-150pages.docx']); // 37,890 bytes of extremely repetitive text = ~150 pages: not knowable from the size
  for (const r of rows) {
    const truth = r.final ?? r.hi;
    const within = r.est >= Math.floor(truth / 2) || r.est >= Math.floor(r.lo / 2);
    check(`${r.name}: estimate ${r.est} vs final ${r.final ?? `(oracle ${r.lo}-${r.hi})`} is not under half`, within || KNOWN_UNDER.has(r.name), JSON.stringify(r));
  }
  if (process.env.OFFICE_UPLOADS_TABLE) for (const r of rows) console.log(`${r.name.padEnd(42)} ${String(r.bytes).padStart(7)} B  est ${String(r.est).padStart(4)}  final ${String(r.final ?? '-').padStart(4)}  oracle ${r.lo}-${r.hi}`);
  const bigSheets = rows.filter((r) => ['xlsx', 'csv', 'tsv'].includes(r.ext) && (r.final ?? r.hi) >= 15);
  check('Excel/CSV files of 15+ pages are estimated within a factor of 2 either way of what the reader counts', bigSheets.length >= 6 && bigSheets.every((r) => r.est >= (r.final ?? r.hi) / 2 && r.est <= (r.final ?? r.hi) * 2), JSON.stringify(bigSheets.map((r) => [r.name, r.est, r.final])));
  const csvRows = rows.filter((r) => r.ext === 'csv' || r.ext === 'tsv');
  check('csv/tsv estimates fall inside the oracle range', csvRows.every((r) => r.est >= r.lo && r.est <= r.hi), JSON.stringify(csvRows));
}

/* ============================================================ E. zip contents (client unzipper) + zip bombs */
family = 'zip';
{
  const B = await import(rel('src/services/bulkImport.ts'));
  const cls = (p, size = 1000) => B.classifyEntry({ path: p, isDir: false, sizeBytes: size });
  for (const ext of ACCEPTED) check(`zip entry a/b/File.${ext} accepted`, cls(`a/b/File.${ext}`).accept === true);
  for (const ext of ['heic', 'HEIF']) check(`zip entry .${ext}: accepted client-side ONLY because the browser converts it to JPEG`, cls(`p/photo.${ext}`).accept === true);
  for (const [p, reason] of [['a/virus.exe', 'unsupported-type'], ['old.doc', 'unsupported-type'], ['old.xls', 'unsupported-type'], ['m.docm', 'unsupported-type'], ['m.xlsm', 'unsupported-type'], ['m.xlsb', 'unsupported-type'], ['noext', 'unsupported-type'], ['inner.zip', 'nested-zip'], ['x/INNER.ZIP', 'nested-zip'], ['a.svg', 'unsupported-type'], ['a.tiff', 'unsupported-type'], ['__MACOSX/a.pdf', 'macosx'], ['.hidden.pdf', 'dotfile']]) {
    const r = cls(p);
    check(`zip entry ${p} skipped (${reason})`, r.accept === false && r.reason === reason && r.detail.length > 5, JSON.stringify(r));
  }
  check('zip entry sizes follow the kind caps (pdf 24 MiB, docx/xlsx/csv 20 MiB)', cls('a.pdf', 24 * MiB).accept && !cls('a.pdf', 24 * MiB + 1).accept && cls('a.docx', 20 * MiB).accept && !cls('a.docx', 20 * MiB + 1).accept && cls('a.csv', 20 * MiB).accept && !cls('a.xlsx', 20 * MiB + 1).accept);
  check('unsafe archive paths are recognised', ['../x.pdf', 'a/../../x.pdf', '/etc/x.pdf', 'C:/x.pdf', 'c:\\x.pdf', '..\\x.pdf', 'a\\..\\..\\x.pdf'].every(B.isUnsafeArchivePath) && !['a/b.pdf', 'a..b/c.pdf', 'dir/file..pdf'].some(B.isUnsafeArchivePath));
  const ent = (name, u, c = u, dir = false) => ({ name, dir, uncompressedSize: u, compressedSize: c });
  let plan = B.planZipEntries([ent('ok.pdf', 5000, 4000), ent('../evil.pdf', 100), ent('/abs.pdf', 100), ent('inner.zip', 100), ent('run.exe', 100), ent('big.csv', 15 * MiB, 20_000), ent('fine.csv', 15 * MiB, 3 * MiB), ent('d/', 0, 0, true)]);
  eq('plan: verdict per entry (safe file, traversal, absolute, nested zip, exe, ratio bomb, honest big csv, folder)', plan.verdicts.map((v) => (v.accept ? 'ok' : v.reason)), ['ok', 'unsafe-path', 'unsafe-path', 'nested-zip', 'unsupported-type', 'zip-bomb', 'ok', 'directory']);
  check('plan: a small entry with a huge ratio is NOT a bomb (the limit is for entries over 1 MiB)', B.planZipEntries([ent('a.txt', 900_000, 100)]).verdicts[0].accept === true);
  plan = B.planZipEntries(Array.from({ length: B.MAX_ZIP_ENTRIES + 1 }, (_, i) => ent(`f${i}.pdf`, 10, 10)));
  check('plan: more entries than the cap refuses the whole archive', !!plan.refused && plan.verdicts.length === 0, plan.refused);
  check('plan: exactly the cap is fine', B.planZipEntries(Array.from({ length: B.MAX_ZIP_ENTRIES }, (_, i) => ent(`f${i}.pdf`, 10, 10))).refused === null);
  plan = B.planZipEntries(Array.from({ length: 400 }, (_, i) => ent(`f${i}.docx`, 20 * MiB, 12 * MiB)));
  check('plan: total declared size over the cap refuses the archive', !!plan.refused, String(plan.refused));
  // declared entry count from the end-of-central-directory record
  const eocd = (n) => { const b = Buffer.alloc(22); b.writeUInt32LE(0x06054b50, 0); b.writeUInt16LE(n, 8); b.writeUInt16LE(n, 10); return new Uint8Array(b); };
  eq('EOCD entry count is read from the tail', [B.declaredZipEntryCount(eocd(7)), B.declaredZipEntryCount(eocd(0xffff)), B.declaredZipEntryCount(new Uint8Array(30))], [7, Infinity, null]);

  // real archives through walkZip + jszip
  const { zip: mkZip, bombEntry } = await import(rel('scripts/office-fixtures/lib.mjs'));
  const asFile = (buf, name = 'export.zip') => new File([buf], name, { type: 'application/zip' });
  const good = mkZip([{ name: 'Cabinet/invoice.pdf', data: '%PDF-1.4 hello' }, { name: 'Cabinet/notes.docx', data: 'PK fake docx' }, { name: 'Cabinet/list.xlsx', data: 'fake xlsx' }, { name: 'Cabinet/virus.exe', data: 'MZ' }, { name: 'Cabinet/old.doc', data: 'x' },
    { name: 'inner.zip', data: 'PK' }, { name: '__MACOSX/._invoice.pdf', data: 'x' }, { name: 'Cabinet/phone.heic', data: 'x' }, { name: 'Cabinet/', data: '' }]);
  const w = await B.walkZip(asFile(good));
  eq('walkZip: accepted entries are exactly the allow-list (+ HEIC for browser conversion)', w.accepted.map((a) => a.path).sort(), ['Cabinet/invoice.pdf', 'Cabinet/list.xlsx', 'Cabinet/notes.docx', 'Cabinet/phone.heic']);
  eq('walkZip: skipped reasons', Object.fromEntries(w.skipped.map((s) => [s.path, s.reason])), { 'Cabinet/virus.exe': 'unsupported-type', 'Cabinet/old.doc': 'unsupported-type', 'inner.zip': 'nested-zip', '__MACOSX/._invoice.pdf': 'macosx', 'Cabinet/': 'directory' });
  const f0 = await w.accepted.find((a) => a.name === 'notes.docx').toFile();
  eq('walkZip: an entry becomes a File with the canonical Word type', [f0.name, f0.type], ['notes.docx', DOCX]);
  const bomb = mkZip([{ name: 'a.txt', ...(await bombEntry('a.txt', { filler: ' ', total: 30 * MiB })) }]);
  const wb = await B.walkZip(asFile(bomb));
  check('walkZip: a 30 MiB-of-spaces entry (ratio over the limit) is skipped as a zip bomb, never accepted', wb.accepted.length === 0 && wb.skipped.some((s) => s.reason === 'zip-bomb' || s.reason === 'too-large'), JSON.stringify(wb.skipped));
  const wt = await B.walkZip(asFile(mkZip([{ name: '../../evil.pdf', data: '%PDF' }, { name: 'ok/../fine.pdf', data: '%PDF' }, { name: 'plain.pdf', data: '%PDF' }])));
  check('walkZip: no accepted entry has a name that climbs out (traversal names are ignored or neutralised)', wt.accepted.every((a) => !B.isUnsafeArchivePath(a.path)) && wt.accepted.some((a) => a.path === 'plain.pdf'), JSON.stringify({ a: wt.accepted.map((a) => a.path), s: wt.skipped }));
  const wc = await B.walkZip(asFile(new Uint8Array(Buffer.from('this is not a zip file at all'))));
  check('walkZip: a damaged archive is one skipped row with a plain message, not a crash', wc.accepted.length === 0 && wc.skipped.length === 1 && /couldn't be opened/.test(wc.skipped[0].detail), JSON.stringify(wc));
  const many = mkZip(Array.from({ length: 30 }, (_, i) => ({ name: `d/f${i}.pdf`, data: `%PDF-${i}` })));
  check('walkZip: a normal archive of 30 files is fine', (await B.walkZip(asFile(many))).accepted.length === 30);
  void zlib;
}

/* ============================================================ F. HEIC -> JPEG in the browser (mocked decoder) */
family = 'heic';
{
  const IC = await import(rel('src/services/imageConvert.ts'));
  const brandBytes = (brand, pad = 64) => { const b = new Uint8Array(pad); b.set([0, 0, 0, 24], 0); b.set(Buffer.from('ftyp'), 4); b.set(Buffer.from(brand), 8); return b; };
  const heic = (name = 'IMG_0001.HEIC', brand = 'heic') => new File([brandBytes(brand)], name, { type: 'image/heic' });
  const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(60).fill(7)]);
  for (const b of ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1']) check(`magic bytes: brand ${b} is HEIC`, IC.isHeicBytes(brandBytes(b)));
  const compat = brandBytes('mp42'); compat.set([0, 0, 0, 32], 0); compat.set(Buffer.from('heic'), 20);
  check('magic bytes: a HEIC compatible brand later in the ftyp box counts even when the major brand is something else', IC.isHeicBytes(compat));
  check('magic bytes: ordinary MP4/AVIF brands are NOT HEIC', !IC.isHeicBytes(brandBytes('isom')) && !IC.isHeicBytes(brandBytes('avif')) && !IC.isHeicBytes(jpegBytes) && !IC.isHeicBytes(new Uint8Array(4)));
  check('detects HEIC by BYTES even when named .jpg with a jpeg type (iOS does this)', await IC.isHeicFile(new File([brandBytes('heic')], 'photo.jpg', { type: 'image/jpeg' })));
  check('a file named .heic whose bytes are really a JPEG is NOT converted', (await IC.isHeicFile(new File([jpegBytes], 'x.heic', { type: '' }))) === false);
  check('a tiny unreadable file named .heic still counts as HEIC (name fallback)', await IC.isHeicFile(new File([new Uint8Array(3)], 'x.heic')));

  const calls = { bitmap: [], draws: [], blobs: [], closed: 0 };
  const installMocks = ({ w = 4032, h: hh = 3024, decodes = true, encodeOk = true } = {}) => {
    globalThis.createImageBitmap = async (blob, opts) => { calls.bitmap.push(opts); if (!decodes) throw new Error('cannot decode'); return { width: w, height: hh, close() { calls.closed++; } }; };
    globalThis.document = { createElement: (t) => ({ _t: t, width: 0, height: 0, getContext() { return { fillStyle: '', fillRect() {}, drawImage: (...a) => calls.draws.push(a) }; }, toBlob(cb, type, q) { calls.blobs.push({ type, q, w: this.width, h: this.height }); cb(encodeOk ? new Blob([jpegBytes], { type: 'image/jpeg' }) : null); } }) };
  };
  installMocks();
  let r = await IC.prepareImageForUpload(heic());
  check('conversion: a decodable HEIC becomes a renamed .jpg File of type image/jpeg', r.ok && r.converted && r.file.name === 'IMG_0001.jpg' && r.file.type === 'image/jpeg' && r.file.size === jpegBytes.length, JSON.stringify({ ok: r.ok, n: r.file?.name, t: r.file?.type }));
  check('conversion: orientation is left to the decoder (imageOrientation from-image), JPEG at quality 0.9, bitmap closed', calls.bitmap.at(-1)?.imageOrientation === 'from-image' && calls.blobs.at(-1).type === 'image/jpeg' && calls.blobs.at(-1).q === 0.9 && calls.closed === 1);
  check('conversion: a 12 MP photo keeps its size (4032 x 3024)', calls.blobs.at(-1).w === 4032 && calls.blobs.at(-1).h === 3024);
  installMocks({ w: 8000, h: 6000 });
  await IC.prepareImageForUpload(heic());
  eq('conversion: a 48 MP photo is capped to a 4096 long edge, aspect kept', [calls.blobs.at(-1).w, calls.blobs.at(-1).h], [4096, 3072]);
  installMocks({ w: 3000, h: 4000 });
  await IC.prepareImageForUpload(heic('portrait.heif', 'mif1'));
  eq('conversion: portrait keeps its orientation (3000 x 4000 stays)', [calls.blobs.at(-1).w, calls.blobs.at(-1).h], [3000, 4000]);
  r = await IC.prepareImageForUpload(new File([brandBytes('heic')], 'weird.jpeg', { type: 'image/jpeg' }));
  check('conversion: HEIC bytes hiding behind a .jpeg name are converted and the name stays .jpg', r.ok && r.converted && r.file.name === 'weird.jpg');
  r = await IC.prepareImageForUpload(new File([brandBytes('heic')], 'noext', { type: '' }));
  check('conversion: a name with no extension gets .jpg', r.ok && r.file.name === 'noext.jpg');
  r = await IC.prepareImageForUpload(new File([jpegBytes], 'ok.jpg', { type: 'image/jpeg' }));
  check('a normal JPEG passes through untouched (same file object)', r.ok && !r.converted && r.file.name === 'ok.jpg');
  installMocks({ decodes: false });
  const savedImage = globalThis.Image; delete globalThis.Image;
  r = await IC.prepareImageForUpload(heic());
  check('a browser that cannot decode HEIC gets the clear message with the Most Compatible instruction, and NO file', r.ok === false && /Most Compatible/.test(r.message) && /Nothing was uploaded/.test(r.message) && !('file' in r), JSON.stringify(r));
  installMocks({ encodeOk: false });
  r = await IC.prepareImageForUpload(heic());
  check('a failed JPEG encode is also the clear message (never the raw HEIC)', r.ok === false && /Most Compatible/.test(r.message));
  globalThis.Image = savedImage;

  // wiring into the real intakes, with a patched fetch that counts every network call
  const net = [];
  globalThis.fetch = async (url) => { net.push(String(url)); const res = (s, b) => ({ ok: s < 300, status: s, headers: { get: () => null }, text: async () => JSON.stringify(b), json: async () => b }); if (String(url).includes('/api/upload-url')) return res(200, { documentId: 'd1', uploadUrl: 'https://fake-upload.test/x', alreadyUploaded: false }); if (String(url).includes('/api/read-document')) return res(200, { documentId: 'd1', pages: 1 }); return { ok: true, status: 200 }; };
  const ING = await import(rel('src/services/ingestClient.ts'));
  installMocks({ decodes: false });
  delete globalThis.Image;
  const rr = await ING.ingestFile(heic(), undefined, undefined, undefined);
  check('desktop picker/drag-drop (ingestFile): an undecodable HEIC is refused with the message and makes NO network call', !!rr.error && /Most Compatible/.test(rr.error) && net.length === 0, JSON.stringify({ rr, net }));
  const rx = await ING.ingestFile(new File([new Uint8Array(10)], 'virus.exe', { type: 'application/x-msdownload' }));
  check('ingestFile: a non-allowed file is refused locally with the server wording and makes no network call', !!rx.error && /never accepted/.test(rx.error) && net.length === 0, JSON.stringify(rx));
  const rw = await ING.ingestFile(new File([new Uint8Array(10)], 'old.doc', { type: 'application/msword' }));
  check('ingestFile: an old .doc says Save As', /Save As/.test(rw.error ?? '') && net.length === 0);
  installMocks();
  const sentBodies = [];
  const f1 = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/api/upload-url')) {
      const b = JSON.parse(init.body); sentBodies.push(b);
      if (b.files) return { ok: true, status: 200, headers: { get: () => null }, text: async () => '', json: async () => ({ results: b.files.map((f, i) => ({ filename: f.filename, documentId: `d${i}`, uploadUrl: 'https://fake-upload.test/x', alreadyUploaded: false })) }) };
    }
    return f1(url, init);
  };
  const ok = await ING.ingestFile(heic('IMG_9.HEIC'));
  check('ingestFile: a decodable HEIC uploads the converted JPEG (filename .jpg, type image/jpeg) but the result keeps the name the person chose', ok.filename === 'IMG_9.HEIC' && sentBodies.at(-1)?.filename === 'IMG_9.jpg' && sentBodies.at(-1)?.contentType === 'image/jpeg' && sentBodies.at(-1)?.sizeBytes === jpegBytes.length, JSON.stringify({ ok, b: sentBodies.at(-1) }));
  // phone: the shared attempt used by the Scan tab and the offline queue
  const Q = await import(rel('src/mobile/offline/uploadQueue.ts'));
  installMocks({ decodes: false });
  delete globalThis.Image;
  net.length = 0;
  let qerr = null;
  try { await Q.attemptUploadOnce(heic(), 'a'.repeat(64)); } catch (e) { qerr = e; }
  check('phone Scan tab / offline queue (attemptUploadOnce): an undecodable HEIC throws a permanent 415 with the message and makes no network call', qerr?.status === 415 && /Most Compatible/.test(qerr.message) && Q.classifyUploadError(qerr) === 'permanent' && net.length === 0, `${qerr?.status} ${net}`);
  installMocks();
  sentBodies.length = 0;
  const qo = await Q.attemptUploadOnce(heic('IMG_5.heic'), 'b'.repeat(64));
  check('phone: a decodable HEIC in the queue is converted and uploaded as a JPEG with the NEW hash', !!qo.documentId && sentBodies.at(-1)?.filename === 'IMG_5.jpg' && sentBodies.at(-1)?.sha256 !== 'b'.repeat(64) && /^[0-9a-f]{64}$/.test(sentBodies.at(-1)?.sha256), JSON.stringify(sentBodies.at(-1)));
  // bulk import: HEIC converts per file, one failure never fails its neighbours
  const B = await import(rel('src/services/bulkImport.ts'));
  installMocks();
  sentBodies.length = 0;
  const srcs = [heic('a.HEIC'), new File([jpegBytes], 'b.jpg', { type: 'image/jpeg' })].map(B.sourceFromFile);
  const out = await B.startBulkImport(srcs).result;
  check('bulk import / folder drop: a HEIC is converted and a neighbour JPEG uploads as is', out.every((s) => s.status === 'done' || s.status === 'queued') && sentBodies.flatMap((b) => b.files ?? [b]).map((f) => f.filename).sort().join() === 'a.jpg,b.jpg', JSON.stringify({ out: out.map((s) => [s.name, s.status, s.error]), sent: sentBodies }));
  installMocks({ decodes: false });
  delete globalThis.Image;
  sentBodies.length = 0;
  const out2 = await B.startBulkImport([heic('bad.heic'), new File([jpegBytes], 'good.jpg', { type: 'image/jpeg' })].map(B.sourceFromFile)).result;
  check('bulk import: an undecodable HEIC fails alone with the clear message; the other file still uploads', out2[0].status === 'failed' && /Most Compatible/.test(out2[0].error ?? '') && (out2[1].status === 'done' || out2[1].status === 'queued') && sentBodies.flatMap((b) => b.files ?? [b]).map((f) => f.filename).join() === 'good.jpg', JSON.stringify(out2.map((s) => [s.name, s.status, s.error?.slice(0, 40)])));
  globalThis.Image = savedImage;
  const src = (f) => read(f);
  check('wired: expenses upload converts HEIC first', /prepareImageForUpload/.test(src('src/screens/ExpensesScreen.tsx')));
  check('wired: serial/plate capture uses the shared HEIC detection and message', /isHeicFile/.test(src('src/services/plateCapture.ts')) && /HEIC_CANNOT_CONVERT_MESSAGE/.test(src('src/services/plateCapture.ts')));
  check('wired: Scan tab guards every file with preflightUpload', /preflightUpload/.test(src('src/mobile/ScanTab.tsx')));
  check('the old per-screen HEIC refusal in Expenses is gone (it now converts)', !/HEIC photos can't be read/.test(src('src/screens/ExpensesScreen.tsx')));
}

/* ============================================================ G. every statement of accepted types agrees */
family = 'consistency';
{
  const walk = (d, exts) => fs.readdirSync(rel(d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (['node_modules', 'samples'].includes(e.name) ? [] : walk(path.join(d, e.name), exts)) : exts.test(e.name) ? [path.join(d, e.name)] : []));
  const files = [
    ...walk('docs/help', /\.md$/), ...walk('public', /\.html$/), 'index.html', ...walk('src', /\.(ts|tsx)$/), ...walk('api/_lib/support', /\.js$/), 'api/upload-url.js', 'api/records.ts', 'api/_lib/uploadTypes.js', 'api/_lib/routes/expenses.js',
    'scripts/import/deepwell-import.mjs', 'handoffs/IMPORT_RUNBOOK.md', 'api/_lib/readDocument.js', 'api/extract.js',
  ].filter((f) => fs.existsSync(rel(f)));
  const stale = [
    [/Word and Excel (files )?(aren't|are not|isn't|is not) accepted/i, 'says Word/Excel is not accepted'],
    [/Word,? (and|or) Excel[^.\n]{0,40}(cannot|can't|can not) be read/i, 'says Word/Excel cannot be read'],
    [/save (them|it) as PDF first/i, 'tells people to save Word/Excel as PDF first'],
    [/Word, Excel, iPhone photos and TIFF cannot be read/i, 'old runbook claim'],
    [/\.tiff? \.txt|TIFF, TXT, CSV or ZIP|\.tiff,\.tif/i, 'lists .tiff as accepted'],
    [/plain text or CSV - convert/i, 'accepted-types sentence that leaves out Word/Excel'],
    [/DeepWell reads PDFs, photos \(JPEG, PNG, GIF, WebP\) and plain text/i, 'accepted-types sentence that leaves out Word/Excel'],
    [/whatever format it's in/i, 'overclaims "any format"'],
    [/doesn't publish a list of file formats/i, 'says the website lists no formats (it now does)'],
  ];
  for (const f of files) {
    const text = read(f);
    for (const [re, why] of stale) {
      if (f === 'api/_lib/uploadTypes.js' || f.endsWith('.generated.js')) continue;
      check(`${f}: ${why}`, !re.test(text), (text.match(re) ?? [''])[0]);
    }
  }
  // every explicit "Accepted: .a .b ..." list must be the allow-list (plus .zip and the converted HEIC/HEIF), no more, no less
  const must = new Set(ACCEPTED.map((e) => `.${e}`));
  const extra = new Set(['.zip', '.heic', '.heif']);
  for (const f of files) {
    for (const m of read(f).matchAll(/Accepted:?\s*((?:\.[a-z0-9]+[ ,]*)+)/g)) {
      const listed = new Set(m[1].match(/\.[a-z0-9]+/g));
      const missing = [...must].filter((x) => !listed.has(x));
      const unknown = [...listed].filter((x) => !must.has(x) && !extra.has(x));
      check(`${f}: the "Accepted:" list matches the allow-list`, !missing.length && !unknown.length, `missing ${missing} unknown ${unknown}`);
    }
  }
  const must2 = [['docs/help/07-uploading-and-scanning-web.md', /\.docx/], ['docs/help/07-uploading-and-scanning-web.md', /Most Compatible/], ['docs/help/10-page-allowance-and-limits.md', /3,000 characters/], ['docs/help/10-page-allowance-and-limits.md', /6,000 characters/], ['index.html', /Word \(\.docx\) and Excel \(\.xlsx\)/], ['index.html', /Most Compatible/],
    ['src/screens/IntakeScreen.tsx', /ACCEPTED_TYPES_SENTENCE/], ['docs/help/APP_INVENTORY.md', /\.docx \.xlsx/]];
  for (const [f, re] of must2) check(`${f} states ${re}`, re.test(read(f)));
  const kb = read('api/_lib/support/kb.generated.js');
  check('the support KB was rebuilt from docs/help (contains the Word/Excel answer, the HEIC answer and the page rule)', /Why wasn't my Word or Excel file read/.test(kb) && /What happens to iPhone photos/.test(kb) && /How are pages counted for Word, Excel and CSV files/.test(kb) && !/Word and Excel files aren't accepted/.test(kb));
  const sentence = UT.ACCEPTED_TYPES_SENTENCE;
  check('the one shared sentence names every accepted kind', /PDFs/.test(sentence) && /JPEG/.test(sentence) && /\.docx/.test(sentence) && /\.xlsx/.test(sentence) && /CSV/.test(sentence) && /plain text/.test(sentence));
  check('input accept attributes come from the shared list (desktop bulk + per-batch inputs)', /ACCEPT_ATTRIBUTE/.test(read('src/screens/IntakeScreen.tsx')) && !/accept="\.zip,\.pdf/.test(read('src/screens/IntakeScreen.tsx')));
  check('no desktop or phone picker still offers .tiff', !/accept=.*tiff/.test(read('src/screens/IntakeScreen.tsx') + read('src/mobile/ScanTab.tsx')));
}

/* ============================================================ summary */
for (const [k, v] of Object.entries(fam)) console.log(`${k.padEnd(14)} ${v.pass} passed, ${v.fail} failed`);
const total = Object.values(fam).reduce((a, v) => a + v.pass + v.fail, 0);
console.log(`\n${failed ? 'FAILED' : 'OK'}: ${total - failed}/${total} checks passed`);
process.exit(failed ? 1 : 0);
