import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { boot, recorder } from './lib/harness.mjs';
const H = await boot(); const R = recorder('uploads');
const { default: upload } = await H.importApi('api/upload-url.js');
const { default: status } = await H.importApi('api/document-status.js');
const { default: readDoc } = await H.importApi('api/read-document.js');
const { default: extract } = await H.importApi('api/extract.js');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const tu = H.tenantUuid;
const docsOf = async (k) => (await H.lite.query('SELECT id, storage_key FROM documents WHERE tenant_id=$1 LIMIT 5', [tu[k]])).rows;
const aDocs = await docsOf('A'); const aId = aDocs[0].id;
const noLeak = (r) => !r.text.includes('https://') && r.status !== 200;
const U = (token, body, headers) => H.call(upload, { token, body, headers });

/* ---- U1 cross tenant mode:get, all id variants */
const variants = {
  plain: { mode: 'get', documentId: aId },
  array: { mode: 'get', documentId: [aId] },
  obj: { mode: 'get', documentId: { toString: aId } },
  upper: { mode: 'get', documentId: aId.toUpperCase() },
  trailing: { mode: 'get', documentId: aId + '\n' },
  ids: { mode: 'get', documentIds: [aId], documentId: aId },
};
for (const [n, b] of Object.entries(variants)) {
  const r = await U(H.tok.adminB, b);
  R.check(`U1-${n}`, `B cannot mint original-download link for A doc (${n})`, noLeak(r), { severity: 'Critical', route: 'upload-url get', detail: `${r.status} ${r.text.slice(0, 120)}`, status: r.status });
}
const rq = await H.call(upload, { token: H.tok.adminB, query: { mode: 'get', documentId: aId }, body: { mode: 'get', documentId: aId } });
R.check('U1-query', 'query-string id does not widen', noLeak(rq), { severity: 'Critical', route: 'upload-url get' });
const ownUp = await U(H.tok.adminA, { filename: 'own.pdf', sha256: sha('own-doc'), contentType: 'application/pdf', sizeBytes: 500 });
const rOwn = await U(H.tok.adminA, { mode: 'get', documentId: ownUp.body.documentId });
R.check('U1-own', 'A can mint own link (control)', rOwn.status === 200 && /^https:\/\/acct123\.r2/.test(rOwn.body?.url ?? ''), { route: 'upload-url get', detail: rOwn.text.slice(0, 100) });
const exp = new URL(rOwn.body?.url ?? 'https://x/').searchParams;
R.check('U1-exp', 'GET link lifetime <= 900s and key under A prefix', exp.get('X-Amz-Expires') === '900' && rOwn.body.url.includes(`/${tu.A}/`), { route: 'upload-url get', severity: 'Medium' });

/* ---- U2 status/read/extract with foreign ids */
const sB = await H.call(status, { token: H.tok.adminB, body: { documentIds: [aId, ...aDocs.map((d) => d.id)] } });
R.check('U2-status', 'document-status gives B nothing about A docs', sB.status === 200 && (sB.body?.documents ?? []).length === 0, { severity: 'Critical', route: 'document-status', detail: sB.text.slice(0, 120) });
const sB2 = await H.call(status, { token: H.tok.adminB, body: { documentIds: [{ x: 1 }, null, aId, `${aId}' OR 1=1--`] } });
R.check('U2-status-junk', 'status junk ids do not 500/leak', sB2.status === 200 && (sB2.body?.documents ?? []).length === 0, { route: 'document-status', detail: sB2.text.slice(0, 100) });
const rB = await H.call(readDoc, { token: H.tok.adminB, body: { documentId: aId, sync: true, force: true } });
R.check('U2-read', 'read-document on A id from B is 404 and does not touch A', rB.status === 404, { severity: 'Critical', route: 'read-document', detail: `${rB.status} ${rB.text.slice(0, 100)}` });
const eB = await H.call(extract, { token: H.tok.adminB, body: { documentId: aId } });
R.check('U2-extract', 'extract on A id from B is refused', eB.status >= 400 && eB.status < 500 && H.modelCalls.count === undefined ? true : eB.status >= 400 && eB.status < 500, { severity: 'Critical', route: 'extract', detail: `${eB.status} ${eB.text.slice(0, 100)}` });
const rArr = await H.call(readDoc, { token: H.tok.adminB, body: { documentId: [aId] } });
R.check('U2-read-array', 'array documentId rejected 400', rArr.status === 400, { route: 'read-document', detail: `${rArr.status}` });

/* ---- U3 tampered storage_key on B's own row pointing into A's prefix (as if a bug wrote it) */
const bDoc = (await docsOf('B'))[0];
let fetched = [];
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => { fetched.push(String(url)); return new Response(Buffer.from('%PDF-1.4 fake'), { status: 200 }); };
for (const [n, key] of [['foreign', aDocs[0].storage_key], ['traversal', `${tu.B}/../${tu.A}/ab/x`], ['prefixsibling', `${tu.B}x/ab/c`]]) {
  await H.lite.query('UPDATE documents SET storage_key=$2, stage=$3, page_count=0 WHERE id=$1', [bDoc.id, key, 'received']);
  fetched = [];
  const r = await H.call(readDoc, { token: H.tok.adminB, body: { documentId: bDoc.id, sync: true, force: true } });
  const og = await U(H.tok.adminB, { mode: 'get', documentId: bDoc.id });
  const bad = fetched.some((u) => u.includes(`/${tu.A}/`)) || (og.body?.url ?? '').includes(`/${tu.A}/`);
  const encOk = n === 'encoded' ? true : true;
  R.check(`U3-${n}`, `row key '${n}' never fetched/presigned`, !bad && encOk, { severity: 'Critical', route: 'read-document/upload-url', detail: `${r.status} ${og.status}` });
}
await H.lite.query('UPDATE documents SET storage_key=$2 WHERE id=$1', [bDoc.id, bDoc.storage_key]);

/* ---- U4 weird filenames / types / sizes */
const base = (o) => ({ filename: 'a.pdf', sha256: sha('x' + Math.random()), contentType: 'application/pdf', sizeBytes: 1000, ...o });
const names = { traversal: '../../../etc/passwd.pdf', win: '..\\..\\x.pdf', nul: 'a\u0000b.pdf', script: '<script>alert(1)</script>.pdf', quote: 'a"; filename="evil.exe.pdf', crlf: 'a\r\nSet-Cookie: x=1.pdf', rlo: 'inv‮fdp.exe.pdf', emoji: '😀📄.pdf', long: 'x'.repeat(100000) + '.pdf', slashonly: '////.pdf', dots: '....//....//a.pdf' };
for (const [n, filename] of Object.entries(names)) {
  const r = await U(H.tok.adminA, base({ filename }));
  const key = r.body?.storageKey ?? '';
  const ok = r.status < 500 && (r.status !== 200 || (key.startsWith(`${tu.A}/`) && !key.includes('..') && key.split('/').length === 3));
  let storedOk = true;
  if (r.status === 200) {
    const row = (await H.lite.query('SELECT original_filename FROM documents WHERE id=$1', [r.body.documentId])).rows[0];
    storedOk = row.original_filename.length <= 255 && !/[\u0000-\u001f‮]/.test(row.original_filename);
    const og = await U(H.tok.adminA, { mode: 'get', documentId: r.body.documentId });
    const cd = decodeURIComponent(new URL(og.body.url).searchParams.get('response-content-disposition') || '');
    storedOk = storedOk && !/[\r\n]/.test(cd) && (cd.match(/filename="/g) || []).length === 1 && !/filename="[^"]*"[^;]*"/.test(cd.split(';')[1] ?? '');
  }
  R.check(`U4-name-${n}`, `filename ${n} safe`, ok && storedOk, { severity: 'Medium', route: 'upload-url', detail: `${r.status} ${key} ${r.text.slice(0, 80)}` });
}
const typeCases = {
  exe: base({ filename: 'a.exe', contentType: 'application/x-msdownload' }),
  html: base({ filename: 'a.html', contentType: 'text/html' }),
  svg: base({ filename: 'a.svg', contentType: 'image/svg+xml' }),
  doublext: base({ filename: 'a.pdf.html', contentType: 'application/pdf' }),
  mismatch: base({ filename: 'a.pdf', contentType: 'text/html' }),
  noext: base({ filename: 'README', contentType: 'application/pdf' }),
  size_neg: base({ sizeBytes: -5 }), size_float: base({ sizeBytes: 1.5 }), size_str: base({ sizeBytes: '1000' }), size_inf: base({ sizeBytes: 1e999 }), size_big: base({ sizeBytes: 25 * 1024 * 1024 }),
  size_huge: base({ sizeBytes: Number.MAX_SAFE_INTEGER }), size_bigint_str: base({ sizeBytes: '99999999999999999999' }),
  sha_upper: base({ sha256: sha('q').toUpperCase() }), sha_short: base({ sha256: 'ab' }), sha_arr: base({ sha256: [sha('q')] }),
  ct_obj: base({ contentType: { a: 1 } }), proto: JSON.parse('{"__proto__":{"sizeBytes":5},"filename":"a.pdf","sha256":"' + sha('p') + '","contentType":"application/pdf","sizeBytes":99}'),
};
for (const [n, body] of Object.entries(typeCases)) {
  const r = await U(H.tok.adminA, body);
  const mustReject = !['proto', 'doublext', 'noext'].includes(n);
  R.check(`U4-${n}`, `upload body '${n}' refused (4xx, never 5xx)`, r.status < 500 && (!mustReject || r.status >= 400), { severity: n.startsWith('size') || n === 'html' || n === 'svg' || n === 'exe' ? 'Medium' : 'Low', route: 'upload-url', detail: `${r.status} ${r.text.slice(0, 100)}` });
}
/* signed PUT scope */
const ok1 = await U(H.tok.adminA, base({ sizeBytes: 24 * 1024 * 1024 }));
const pu = new URL(ok1.body?.uploadUrl ?? 'https://x/');
R.check('U5-put', 'PUT link signs content-length, lifetime<=3600, key = tenant/hash', /content-length/.test(pu.searchParams.get('X-Amz-SignedHeaders') ?? '') && Number(pu.searchParams.get('X-Amz-Expires')) <= 3600 && pu.pathname.includes(`/${tu.A}/`), { route: 'upload-url', detail: pu.search.slice(0, 200) });
const hasA = (await H.lite.query('SELECT sha256_hash FROM documents WHERE tenant_id=$1 AND id IN (SELECT document_id FROM document_pages) LIMIT 1', [tu.A])).rows[0].sha256_hash;
const dB = await U(H.tok.adminB, base({ sha256: hasA }));
R.check('U6-dup-oracle', "B uploading A's sha256 learns nothing (alreadyUploaded=false, own prefix, own doc)", dB.status === 200 && dB.body.alreadyUploaded === false && dB.body.storageKey.startsWith(`${tu.B}/`) && !aDocs.some((d) => d.id === dB.body.documentId), { severity: 'Medium', route: 'upload-url', detail: dB.text.slice(0, 150) });
const d1 = await U(H.tok.adminA, base({ sha256: sha('same') })); const d2 = await U(H.tok.adminA, base({ sha256: sha('same'), filename: 'other.pdf' }));
R.check('U6-dup-same', 'replay same sha gives one document row', d1.body?.documentId === d2.body?.documentId, { severity: 'Low', route: 'upload-url' });
const batch = await U(H.tok.adminA, { files: Array.from({ length: 51 }, () => base({ sha256: sha(String(Math.random())) })) });
R.check('U6-batch51', 'batch over 50 refused', batch.status === 413, { route: 'upload-url', detail: String(batch.status) });
const batchBad = await U(H.tok.adminA, { files: [null, 5, 'x', [], base({ sha256: sha('bb') })] });
R.check('U6-batch-junk', 'batch junk entries do not 500', batchBad.status < 500, { route: 'upload-url', detail: `${batchBad.status} ${batchBad.text.slice(0, 120)}` });
const memGet = await H.call(upload, { token: H.mintKey ? await H.mintKey('A', ['ingest']) : null, body: variants.plain });
R.check('U6-ingestkey-get', 'ingest-only API key cannot mint download link', memGet.status === 403 || memGet.status === 401, { severity: 'High', route: 'upload-url get', detail: String(memGet.status) });
const spoof = await U(H.tok.adminB, base({ sha256: sha('sp') }), { 'x-dw-expected-tenant': H.orgA });
R.check('U6-expected-tenant', 'x-dw-expected-tenant mismatch refused (409)', spoof.status === 409, { route: 'upload-url' });

/* ---- U7 bombs through read-document with patched R2 */
const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return (b) => { let c = ~0; for (const x of b) c = t[(c ^ x) & 255] ^ (c >>> 8); return ~c >>> 0; }; })();
function zip(entries) { const parts = [], cd = []; let off = 0; for (const [name, data] of entries) { const comp = zlib.deflateRawSync(data, { level: 9 }); const nb = Buffer.from(name); const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8); h.writeUInt32LE(CRC(data), 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nb.length, 26); parts.push(h, nb, comp); const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10); c.writeUInt32LE(CRC(data), 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nb.length, 28); c.writeUInt32LE(off, 42); cd.push(c, nb); off += 30 + nb.length + comp.length; } const cdb = Buffer.concat(cd); const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(entries.length, 8); e.writeUInt16LE(entries.length, 10); e.writeUInt32LE(cdb.length, 12); e.writeUInt32LE(off, 16); return Buffer.concat([...parts, cdb, e]); }
const ct = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>';
const wbRels = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';
const wb = '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>';
const bombs = {
  xlsx_ratio: zip([['[Content_Types].xml', Buffer.from(ct)], ['xl/workbook.xml', Buffer.from(wb)], ['xl/_rels/workbook.xml.rels', Buffer.from(wbRels)], ['xl/worksheets/sheet1.xml', Buffer.concat([Buffer.from('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'), Buffer.alloc(60 * 1024 * 1024, 0x20), Buffer.from('</sheetData></worksheet>')])]]),
  xlsx_cells: zip([['[Content_Types].xml', Buffer.from(ct)], ['xl/workbook.xml', Buffer.from(wb)], ['xl/_rels/workbook.xml.rels', Buffer.from(wbRels)], ['xl/worksheets/sheet1.xml', Buffer.from('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + '<row><c t="inlineStr"><is><t>a</t></is></c></row>'.repeat(300000) + '</sheetData></worksheet>')]]),
  xlsx_entries: zip([['[Content_Types].xml', Buffer.from(ct)], ['xl/workbook.xml', Buffer.from(wb)], ...Array.from({ length: 5000 }, (_, i) => [`junk/${i}.xml`, Buffer.from('a')])]),
  docx_deep: zip([['[Content_Types].xml', Buffer.from(ct)], ['word/document.xml', Buffer.from('<w:document xmlns:w="x"><w:body>' + '<w:p>'.repeat(200000) + '</w:body></w:document>')]]),
  docx_traversal: zip([['[Content_Types].xml', Buffer.from(ct)], ['../../evil.xml', Buffer.from('x')], ['word/document.xml', Buffer.from('<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>hi</w:t></w:r></w:p></w:body></w:document>')]]),
};
let currentBytes = null;
globalThis.fetch = async (url) => new Response(currentBytes, { status: 200, headers: { 'content-length': String(currentBytes.length) } });
for (const [n, bytes] of Object.entries(bombs)) {
  const ext = n.startsWith('xlsx') ? 'xlsx' : 'docx';
  const s = sha('bomb' + n);
  const up = await U(H.tok.adminA, { filename: `${n}.${ext}`, sha256: s, sizeBytes: bytes.length, contentType: ext === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  currentBytes = bytes;
  const rss0 = process.memoryUsage().rss; const t0 = Date.now();
  const r = await H.call(readDoc, { token: H.tok.adminA, body: { documentId: up.body?.documentId, sync: true, extract: false } });
  const ms = Date.now() - t0;
  const pgs = (await H.lite.query('SELECT count(*)::int n FROM document_pages WHERE document_id=$1', [up.body?.documentId])).rows[0].n;
  R.check(`U7-${n}`, `${n} (${bytes.length}B) bounded: refused or <=2000 pages, <15s`, ms < 15000 && pgs <= 2000 && r.status < 500, { severity: 'High', route: 'read-document', detail: `status ${r.status} pages ${pgs} ${ms}ms ${r.text.slice(0, 100)}` });
}
/* plain text 20MB: pages written vs plan page cap (read-time allowance only enforced for office) */
await H.setTenant('A', "plan='solo', billing_status='active'");
const txt = Buffer.from(('line of service history for unit 4412\n').repeat(Math.ceil(19 * 1024 * 1024 / 37)));
const tup = await U(H.tok.adminA, { filename: 'big.txt', sha256: sha('bigtxt'), sizeBytes: txt.length, contentType: 'text/plain' });
currentBytes = txt;
const tr = await H.call(readDoc, { token: H.tok.adminA, body: { documentId: tup.body?.documentId, sync: true, extract: false } });
const tp = (await H.lite.query('SELECT count(*)::int n FROM document_pages WHERE document_id=$1', [tup.body?.documentId])).rows[0].n;
R.check('U8-txt-pages', `one ${(txt.length / 1e6).toFixed(0)}MB .txt (gate est. 200 pages) cannot write more pages than the solo monthly cap (750)`, tp <= 750, { severity: 'Medium', route: 'read-document', detail: `upload ${tup.status}, read ${tr.status}, pages written ${tp}` });
globalThis.fetch = origFetch;
await H.setTenant('A', "plan='fleet', billing_status='active'");
R.finish();
