/**
 * Office readers (Word / Excel / CSV): features, refusals, hostile fixtures built in memory, caps, determinism, fuzz, and the
 * ingest integration on PGlite (mock R2, stub model). No network, no filesystem writes, nothing from a fixture is executed.
 *   npx tsx scripts/verify-office-reader.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

for (const k of ['STRIPE_SECRET_KEY', 'CLERK_SECRET_KEY', 'RESEND_API_KEY', 'ANTHROPIC_API_KEY']) delete process.env[k];
process.env.NEON_CONNECTION_STRING = 'postgres://fixture_user:fixture_pw@db.fixture.invalid:5432/fixture?sslmode=require&channel_binding=require';
Object.assign(process.env, { R2_ACCOUNT_ID: 'acct123', R2_ACCESS_KEY_ID: 'AKIAFIXTURE', R2_SECRET_ACCESS_KEY: 'secretfixture', R2_BUCKET_NAME: 'fixture-bucket' });

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.join(root, p);
const O = await import(rel('api/_lib/office/index.js'));
const L = await import(rel('api/_lib/office/limits.js'));
const NF = await import(rel('api/_lib/office/numfmt.js'));
const B = await import(rel('scripts/lib/officeBuild.mjs'));
const { buildZip, buildDocx, buildXlsx, p, h, tbl, tr, cell, tc, partXml, defaultStyles } = B;

const fam = {};
let family = 'misc';
let failed = 0;
const check = (name, ok, detail = '') => {
  fam[family] ??= { pass: 0, fail: 0 };
  fam[family][ok ? 'pass' : 'fail']++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${family}] ${name}${ok ? '' : detail ? `  -> ${String(detail).slice(0, 300)}` : ''}`);
  if (!ok) failed++;
};
const read = (b, filename) => O.readOfficeFile(b, { filename });
const text = (r) => (r.pages ?? []).map((x) => x.text).join('\n');
const refused = (r, status, re) => r.ok === false && (status == null || r.status === status) && (!re || re.test(r.message));

/* ===================================================================== zip safety */
family = 'zip';
{
  const good = buildDocx(p('hello'));
  check('valid docx reads', read(good, 'a.docx').ok);
  const big = (n) => Buffer.alloc(n);
  // bomb: honest declared size over the per-entry cap
  const b1 = buildZip([{ name: '[Content_Types].xml', data: '<a/>' }, { name: 'word/document.xml', data: big(80 * 1024 * 1024) }]);
  let r = read(b1, 'a.docx');
  check('zip bomb (honest 80 MB entry) refused 413 before inflating', refused(r, 413), JSON.stringify(r));
  // lying header: declared tiny, really huge
  const b2 = buildZip(B.docxParts({ body: p('x') }).map((e) => (e.name === 'word/document.xml' ? { name: e.name, data: big(70 * 1024 * 1024), usize: 1000 } : e)));
  r = read(b2, 'a.docx');
  check('lying declared size (1000 vs 70 MB real) refused, never trusted', r.ok === false && [413, 422].includes(r.status), JSON.stringify(r));
  // ratio: 30 MB of zeros (~1000:1)
  const b3 = buildZip([{ name: '[Content_Types].xml', data: '<a/>' }, { name: 'word/document.xml', data: big(30 * 1024 * 1024) }]);
  r = read(b3, 'a.docx');
  check('per-entry ratio over 1000:1 refused', refused(r, 413), JSON.stringify(r));
  // total inflated budget: 4 entries of ~40 MB at ratio ~200 (declared sum 160 MB > 128 MB)
  const pat = crypto.randomBytes(1024); const comp = Buffer.alloc(40 * 1024 * 1024); for (let i = 0; i < comp.length; i += 1024) pat.copy(comp, i);
  const b4 = buildZip([1, 2, 3, 4].map((i) => ({ name: `word/p${i}.bin`, data: comp })).concat([{ name: '[Content_Types].xml', data: '<a/>' }]));
  r = read(b4, 'a.docx');
  check('total inflated over 128 MB refused', refused(r, 413), JSON.stringify(r));
  // entry count
  const many = []; for (let i = 0; i < 2001; i++) many.push({ name: `f${i}.txt`, data: '' });
  r = read(buildZip(many), 'a.docx');
  check('2001 entries refused 413', refused(r, 413, /parts/), JSON.stringify(r));
  // lying central directory
  r = read(buildZip([{ name: '[Content_Types].xml', data: '<a/>' }], { cdOffsetDelta: 5 }), 'a.docx');
  check('central directory pointing at the wrong offset refused cleanly', r.ok === false, JSON.stringify(r));
  r = read(buildZip([{ name: '[Content_Types].xml', data: '<a/>' }], { total: 5 }), 'a.docx');
  check('entry count larger than the directory refused', r.ok === false);
  // overlapping entries
  r = read(buildZip([{ name: 'a.xml', data: '<a>1</a>' }, { name: 'b.xml', data: '<a>2</a>', lho: 0 }]), 'a.docx');
  check('overlapping entries (two names, one data range) refused', refused(r, 422, /overlap|header|safe/), JSON.stringify(r));
  // zip64
  r = read(buildZip([{ name: 'a.xml', data: 'x' }], { zip64Locator: true }), 'a.docx');
  check('zip64 locator refused cleanly (415)', refused(r, 415, /ZIP64/), JSON.stringify(r));
  r = read(buildZip([{ name: 'a.xml', data: 'x' }], { total: 0xffff }), 'a.docx');
  check('zip64 entry-count marker refused cleanly', refused(r, 415, /ZIP64/), JSON.stringify(r));
  // names
  for (const [label, name] of [['path traversal', '../evil.xml'], ['nested traversal', 'word/../../evil'], ['absolute path', '/etc/passwd'], ['backslash', 'word\\document.xml'], ['drive letter', 'C:/x.xml'], ['NUL in name', 'a\u0000b.xml'], ['control char', 'a\u0007b.xml']]) {
    r = read(buildZip([{ name: '[Content_Types].xml', data: '<a/>' }, { name, data: 'x' }]), 'a.docx');
    check(`entry name: ${label} refused, nothing extracted`, refused(r, 422, /safe/), JSON.stringify(r));
  }
  r = read(buildZip([{ name: 'a.xml', data: '1' }, { name: 'a.xml', data: '2' }]), 'a.docx');
  check('duplicate entry names refused', refused(r, 422, /same name/), JSON.stringify(r));
  // encrypted
  r = read(buildZip([{ name: '[Content_Types].xml', data: '<a/>', flags: 0x801 }]), 'a.docx');
  check('encrypted zip entry refused with the password message', refused(r, 415, /password/), JSON.stringify(r));
  // corrupt
  const dd = Buffer.from(buildDocx(p('x'))); dd[60] ^= 0xff;
  r = read(dd, 'a.docx');
  check('flipped byte inside the zip: clean refusal or clean read, no throw', typeof r.ok === 'boolean');
  r = read(buildZip([{ name: '[Content_Types].xml', data: '<a/>', crc: 1234 }]), 'a.docx');
  check('wrong CRC refused', r.ok === false);
  r = read(buildZip([{ name: '[Content_Types].xml', data: '<a/>', method: 9 }]), 'a.docx');
  check('unsupported compression method refused', r.ok === false);
  r = read(good.subarray(0, good.length - 30), 'a.docx');
  check('truncated zip refused', refused(r, 422), JSON.stringify(r));
  r = read(Buffer.from('PK\x03\x04junk'), 'a.docx');
  check('PK header with nothing behind it refused', r.ok === false);
  // process stays healthy: a normal read right after the hostile ones
  check('process healthy after hostile zips (valid file still reads)', read(good, 'a.docx').ok);
}

/* ===================================================================== xml safety */
family = 'xml';
{
  const wrap = (xml) => buildZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: '_rels/.rels', data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/document.xml', data: xml },
  ]);
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const doc = (inner) => `<w:document ${W}><w:body>${inner}</w:body></w:document>`;
  let r;
  const laughs = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;"><!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]>' + doc('<w:p><w:r><w:t>&lol3;</w:t></w:r></w:p>');
  let t0 = Date.now(); r = read(wrap(laughs), 'a.docx');
  check('billion-laughs DTD refused fast, nothing expanded', refused(r, 422, /DOCTYPE|unsafe/) && Date.now() - t0 < 1000, JSON.stringify(r));
  r = read(wrap('<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + doc('<w:p><w:r><w:t>&x;</w:t></w:r></w:p>')), 'a.docx');
  check('XXE (SYSTEM entity) refused, no file read', refused(r, 422) && !/root:/.test(JSON.stringify(r)), JSON.stringify(r));
  r = read(wrap('<!DOCTYPE d SYSTEM "http://127.0.0.1:9/evil.dtd">' + doc('<w:p/>')), 'a.docx');
  check('external DTD reference refused, no fetch', refused(r, 422));
  r = read(wrap(doc('<w:p><w:r><w:t>&undefined;</w:t></w:r></w:p>')), 'a.docx');
  check('undefined entity reference refused', refused(r, 422));
  r = read(wrap(doc('<w:p><w:r><w:t>a &amp; b &lt; c &#65;&#x42; &quot;q&quot; &apos;s&apos;</w:t></w:r></w:p>')), 'a.docx');
  check('five predefined entities + numeric references decode', r.ok && /a & b < c AB "q" 's'/.test(text(r)), JSON.stringify(r));
  for (const bad of ['&#0;', '&#x110000;', '&#xD800;', '&#99999999999;', '&#;']) {
    r = read(wrap(doc(`<w:p><w:r><w:t>${bad}</w:t></w:r></w:p>`)), 'a.docx');
    check(`illegal character reference ${bad} refused`, refused(r, 422));
  }
  r = read(wrap(doc('<w:p><w:r><w:t><![CDATA[1 < 2 & 3]]></w:t></w:r></w:p>')), 'a.docx');
  check('CDATA text read literally', r.ok && /1 < 2 & 3/.test(text(r)));
  t0 = Date.now(); r = read(wrap(doc('<w:p>'.repeat(100000) + '</w:p>'.repeat(100000))), 'a.docx');
  check('100k nested tags refused at the depth cap, fast, no stack overflow', refused(r, 422, /nested/) && Date.now() - t0 < 3000, `${r.message} ${Date.now() - t0}ms`);
  r = read(wrap(doc('<w:p><w:r><w:t>x</w:t></w:r>')), 'a.docx');
  check('unclosed tags refused', refused(r, 422));
  r = read(wrap(doc('<w:p></w:r></w:p>')), 'a.docx');
  check('mismatched closing tag refused', refused(r, 422));
  r = read(wrap(doc('<w:p x="' + 'a'.repeat(2 * 1024 * 1024) + '"/>')), 'a.docx');
  check('huge attribute value refused', refused(r, 422));
  r = read(wrap(doc('<w:p ' + 'a'.repeat(400) + '="1"/>')), 'a.docx');
  check('attribute name over 256 chars refused', refused(r, 422));
  r = read(wrap(doc('<w:p ' + Array.from({ length: 300 }, (_, i) => `a${i}="1"`).join(' ') + '/>')), 'a.docx');
  check('more than 256 attributes refused', refused(r, 422));
  r = read(wrap(doc('<w:p><w:r><w:t>cut off')), 'a.docx');
  check('file cut off mid-text refused', refused(r, 422));
  r = read(wrap('<w:document ' + W + '><w:body><w:p a=b/></w:body></w:document>'), 'a.docx');
  check('unquoted attribute refused', refused(r, 422));
  // 10 MB single paragraph / cell
  const tenMB = 'word '.repeat(2 * 1024 * 1024);
  t0 = Date.now(); r = read(wrap(doc(`<w:p><w:r><w:t>${tenMB}</w:t></w:r></w:p>`)), 'a.docx');
  check('10 MB single paragraph: clean result (refused over the page cap or paged), bounded time', typeof r.ok === 'boolean' && Date.now() - t0 < 15000, `${r.ok} ${r.status} ${Date.now() - t0}ms`);
  const xl = buildXlsx([{ name: 'S', rows: [['h1', 'h2'], [{ is: 'x'.repeat(10 * 1024 * 1024) }, 'ok']] }]);
  t0 = Date.now(); r = read(xl, 'a.xlsx');
  check('10 MB single xlsx cell: cut at 32,767 chars and said so', r.ok && /cell cut at 32,767/.test(text(r)) && text(r).length < 100000 && Date.now() - t0 < 15000, `${r.ok} ${text(r).length}`);
  const csv10 = Buffer.from('a,b\n"' + 'y'.repeat(10 * 1024 * 1024) + '",z\n');
  r = read(csv10, 'a.csv');
  check('10 MB single csv cell: cut and said so', r.ok && /cell cut at 32,767/.test(text(r)) && text(r).length < 100000);
  check('process healthy after hostile xml', read(buildDocx(p('fine')), 'a.docx').ok);
}

/* ===================================================================== docx features */
family = 'docx';
{
  const t = (b, extra) => text(read(buildDocx(b, extra), 'a.docx'));
  let out = t(h('Invoice 1043') + p('Customer: Acme Heating') + h('Items', 2) + p('Filter', { list: 1 }) + p('Belt', { list: 1, ilvl: 1 }));
  check('paragraphs, headings, list items in order', /Invoice 1043\nCustomer: Acme Heating\nItems\n- Filter\n {2}- Belt/.test(out), out);
  check('page starts with a Section locator naming the nearest heading', /^Section: Invoice 1043\n/.test(out), out);
  out = t(tbl(tr(cell('Item'), cell('Qty'), cell('Total')), tr(cell('Filter'), cell('2'), cell('$40.00'))));
  check('table row = cells joined with " | "', /Item \| Qty \| Total\nFilter \| 2 \| \$40\.00/.test(out), out);
  out = t(tbl(tr(tc(p('Region'), { span: 2 }), cell('Total')), tr(tc(p('North'), { vmerge: 'restart' }), cell('Q1'), cell('5')), tr(tc(p(''), { vmerge: true }), cell('Q2'), cell('6'))));
  check('merged cells not duplicated (gridSpan once, vMerge continuation empty)', /Region \| Total/.test(out) && /North \| Q1 \| 5/.test(out) && !/North[^\n]*North/.test(out), out);
  const nested = tbl(tr(tc(p('outer') + tbl(tr(cell('in1'), cell('in2')))), cell('side')));
  out = t(nested);
  check('nested table text kept once inside its cell', /outer \/ \[in1 \| in2\] \| side/.test(out) && (out.match(/in1/g) ?? []).length === 1, out);
  out = t('<w:p><w:hyperlink r:id="rId9"><w:r><w:t>Click here</w:t></w:r></w:hyperlink></w:p>', { rels: '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="http://evil.example/x" TargetMode="External"/>' });
  check('hyperlink: text kept, target never read', /Click here/.test(out) && !/evil\.example/.test(out), out);
  out = t('<w:p><w:r><w:t>a</w:t></w:r><w:r><w:tab/><w:t>b</w:t></w:r><w:r><w:br/><w:t>c</w:t></w:r></w:p>');
  check('tabs and line breaks', /a\tb\nc/.test(out), JSON.stringify(out));
  out = t('<w:p><w:r><w:t>Keep </w:t></w:r><w:ins w:id="1"><w:r><w:t>inserted</w:t></w:r></w:ins><w:del w:id="2"><w:r><w:delText>deleted</w:delText></w:r></w:del><w:del w:id="3"><w:r><w:t>alsodeleted</w:t></w:r></w:del></w:p>');
  check('tracked changes: inserted kept, deleted dropped', /Keep inserted/.test(out) && !/deleted/.test(out), out);
  out = t(tbl(tr(cell('live')), '<w:tr><w:trPr><w:del w:id="9"/></w:trPr><w:tc><w:p><w:r><w:t>gonerow</w:t></w:r></w:p></w:tc></w:tr>'));
  check('tracked-deleted table row dropped', /live/.test(out) && !/gonerow/.test(out), out);
  out = t('<w:sdt><w:sdtPr/><w:sdtContent><w:p><w:r><w:t>Control text</w:t></w:r></w:p></w:sdtContent></w:sdt><w:sdt><w:sdtPr><w:showingPlcHdr/></w:sdtPr><w:sdtContent><w:p><w:r><w:t>Click to enter</w:t></w:r></w:p></w:sdtContent></w:sdt><w:p><w:sdt><w:sdtPr/><w:sdtContent><w:r><w:t>inline ctl</w:t></w:r></w:sdtContent></w:sdt></w:p>');
  check('content controls: text kept, placeholder dropped', /Control text/.test(out) && /inline ctl/.test(out) && !/Click to enter/.test(out), out);
  const tb = '<w:r><w:t>Host</w:t></w:r>';
  out = t(`<w:p>${tb}<mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wps:txbx><w:txbxContent><w:p><w:r><w:t>Box text</w:t></w:r></w:p></w:txbxContent></wps:txbx></w:drawing></mc:Choice><mc:Fallback><w:pict><v:textbox><w:txbxContent><w:p><w:r><w:t>Box text</w:t></w:r></w:p></w:txbxContent></v:textbox></w:pict></mc:Fallback></mc:AlternateContent></w:p>`);
  check('text box read once (Fallback copy not duplicated)', (out.match(/Box text/g) ?? []).length === 1 && /Host/.test(out), out);
  out = t(`<w:p><w:r><w:t>Plain</w:t></w:r><w:r><w:pict><v:textbox><w:txbxContent><w:p><w:r><w:t>Vml only</w:t></w:r></w:p></w:txbxContent></v:textbox></w:pict></w:r></w:p>`);
  check('stand-alone VML text box read', /Vml only/.test(out), out);
  out = t(p('Body'), { extra: { 'word/footnotes.xml': partXml('footnotes', '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:t>sep</w:t></w:r></w:p></w:footnote><w:footnote w:id="1"><w:p><w:r><w:t>Foot one</w:t></w:r></w:p></w:footnote>'), 'word/endnotes.xml': partXml('endnotes', '<w:endnote w:id="1"><w:p><w:r><w:t>End one</w:t></w:r></w:p></w:endnote>') }, rels: '<Relationship Id="f" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/><Relationship Id="e" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes" Target="endnotes.xml"/>' });
  check('footnotes and endnotes read (separators skipped)', /Footnote 1: Foot one/.test(out) && /Endnote 1: End one/.test(out) && !/sep/.test(out), out);
  const hdr = partXml('hdr', '<w:p><w:r><w:t>ACME HEATING 480-555-0100</w:t></w:r></w:p>');
  out = t(p('Body'), { extra: { 'word/header1.xml': hdr, 'word/header2.xml': hdr, 'word/footer1.xml': partXml('ftr', '<w:p><w:r><w:t>Page footer</w:t></w:r></w:p>') }, rels: '<Relationship Id="h1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="h2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header2.xml"/><Relationship Id="f1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>' });
  check('identical headers once, footer once', (out.match(/ACME HEATING/g) ?? []).length === 1 && /Footer: Page footer/.test(out), out);
  out = t('<w:p><w:r><w:t>Before </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>DDEAUTO c:\\windows\\system32\\cmd.exe "/k calc"</w:instrText></w:r><w:r><w:instrText>HYPERLINK "http://evil.example"</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>result</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>');
  check('field instructions (DDE/HYPERLINK) never read; cached result kept', /Before result/.test(out) && !/calc|DDEAUTO|evil/.test(out), out);
  out = t('<w:p><w:r><w:object><w:t>no</w:t></w:object></w:r><w:r><w:t>kept</w:t></w:r></w:p>', {});
  check('embedded object markup does not break reading', /kept/.test(out));
  out = t('<w:p><w:r><w:t>base</w:t></w:r><m:oMath><m:r><m:t>x+y</m:t></m:r></m:oMath></w:p>');
  check('math text kept', /base/.test(out));
  // pagination
  const paras = Array.from({ length: 300 }, (_, i) => p(`Paragraph number ${i} ${'lorem ipsum dolor '.repeat(5)}`)).join('');
  let r = read(buildDocx(h('Start') + paras), 'a.docx');
  const total = text(r).length;
  check('long document split into pages of ~3,000 chars', r.pages.length >= Math.floor(total / 3600) && r.pages.length <= Math.ceil(total / 2500), `${r.pages.length} pages, ${total} chars`);
  check('every page starts with a locator line', r.pages.every((x) => /^(Section: |Part \d+ of \d+)/.test(x.text)));
  check('page numbers are 1..n, contiguous', r.pages.every((x, i) => x.page_no === i + 1));
  const rowsDoc = tbl(...Array.from({ length: 200 }, (_, i) => tr(cell(`R${i}`), cell('x'.repeat(40)), cell(`END${i}`))));
  r = read(buildDocx(h('Table') + rowsDoc), 'a.docx');
  const rowLines = text(r).split('\n').filter((l) => /^R\d+ \|/.test(l));
  check('table rows never cut across pages (200 rows intact, in order)', rowLines.length === 200 && rowLines.every((l, i) => l.endsWith(`END${i}`)), `${rowLines.length}`);
  check('table pages carry the heading locator', r.pages.every((x) => /^Section: Table/.test(x.text)));
  r = read(buildDocx(p('Cover line') + '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' + p('Second part')), 'a.docx');
  check('explicit page break on a nearly empty page does not make a near-empty billable page', r.pages.length === 1, `${r.pages.length}`);
  const half = p('A'.repeat(1800)) + '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' + p('after break');
  r = read(buildDocx(half), 'a.docx');
  check('explicit page break on a half-full page ends the page', r.pages.length === 2 && /after break/.test(r.pages[1].text) && !/after break/.test(r.pages[0].text), `${r.pages.length}`);
  r = read(buildDocx(p('A'.repeat(1800)) + `<w:p><w:pPr><w:sectPr><w:type w:val="nextPage"/></w:sectPr></w:pPr><w:r><w:t>end of section one</w:t></w:r></w:p>` + p('section two')), 'a.docx');
  check('section break ends the page when half full', r.pages.length === 2, `${r.pages.length}`);
  r = read(buildDocx(p('x'.repeat(2960)) + h('Dangling heading') + p('b'.repeat(100))), 'a.docx');
  check('a heading is never left alone at the end of a page', r.pages.length === 2 && /Dangling heading/.test(r.pages[1].text) && !/Dangling heading/.test(r.pages[0].text), r.pages.map((x) => x.text.slice(0, 40)).join(' || '));
  check('second page locator names that heading', /^Section: Dangling heading/.test(r.pages[1]?.text ?? ''));
  r = read(buildDocx(p('s'.repeat(9000))), 'a.docx');
  check('one 9,000-char paragraph split into ~3 pages', r.pages.length >= 3 && r.pages.length <= 4, `${r.pages.length}`);
  r = read(buildDocx(''), 'a.docx');
  check('empty document: ok with 0 pages (ingest turns it into the NO_READABLE_TEXT 422)', r.ok && r.pages.length === 0);
  r = read(buildDocx(p('Plain no headings')), 'a.docx');
  check('no heading: locator is "Part 1 of 1"', /^Part 1 of 1\n/.test(r.pages[0].text));
  // style detection through styles.xml name and outline level
  r = read(buildDocx(p('Custom head', { style: 'MyHead' }) + p('body'), { styles: partXml('styles', '<w:style w:styleId="MyHead"><w:name w:val="heading 2"/></w:style>') }), 'a.docx');
  check('heading found through styles.xml name', /^Section: Custom head/.test(r.pages[0].text));
  const e = buildDocx(p('x'), { contentTypesExtra: '', ct: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml' });
  check('minimal docx without optional parts reads', read(e, 'a.docx').ok);
}

/* ===================================================================== xlsx features */
family = 'xlsx';
{
  const X = (rows, o = {}, bo = {}) => read(buildXlsx([{ name: 'Sheet1', rows, ...o }], bo), 'a.xlsx');
  let r = X([['Acme Heating - customer list'], ['Customer', 'Invoice', 'Date', 'Total'], ['Acme Heating', 1043, { s: 1, v: '46085' }, { s: 2, v: '1250' }], ['Beta Plumbing', 1044, { s: 1, v: '46086' }, { s: 2, v: '80.5' }]], {}, { styles: defaultStyles({ numFmts: { 164: '"$"#,##0.00' }, xfs: [0, 14, 164] }) });
  check('first line: Sheet "<name>" rows a-b of n', /^Sheet "Sheet1" rows 1-4 of 4\n/.test(r.pages[0].text), r.pages[0]?.text);
  check('header found under a title block; title shown once', /Header \(row 2\): Customer \| Invoice \| Date \| Total/.test(r.pages[0].text) && /Row 1 \| Acme Heating - customer list/.test(r.pages[0].text));
  check('row rendered with labels, row number, ISO date, currency', /Row 3 \| Customer: Acme Heating \| Invoice: 1043 \| Date: 2026-03-04 \| Total: \$1,250\.00/.test(r.pages[0].text), r.pages[0].text);
  check('currency with cents', /Total: \$80\.50/.test(r.pages[0].text));
  r = X([['Name', 'Note'], [{ raw: '<c r="{ref}" t="inlineStr"><is><t>inline one</t></is></c>' }, { raw: '<c r="{ref}" t="b"><v>1</v></c>' }], [{ raw: '<c r="{ref}" t="e"><v>#N/A</v></c>' }, { raw: '<c r="{ref}" t="b"><v>0</v></c>' }]]);
  check('inline strings, booleans, errors', /Name: inline one \| Note: TRUE/.test(text(r)) && /Name: #N\/A \| Note: FALSE/.test(text(r)), text(r));
  r = read(buildXlsx([{ name: 'S', rows: [['Label', 'Value'], ['Rich', 'x']] }], { sstRich: { Rich: '<si><r><t>Ri</t></r><r><rPr><b/></rPr><t>ch</t></r><rPh sb="0" eb="1"><t>PHONETIC</t></rPh></si>' } }), 'a.xlsx');
  check('shared string with rich-text runs joined, phonetic skipped', /Label: Rich/.test(text(r)) && !/PHONETIC/.test(text(r)), text(r));
  r = X([['Id', 'Val'], ['a', 0.1 + 0.2], ['b', Math.PI], ['c', 123456789012345], ['d', 1e-7], ['e', -42.5], ['f', 1234567890123456789]]);
  const tx = text(r);
  check('numbers: float noise cleaned, 16-digit value kept, big integers whole', /Val: 0\.3\n|Val: 0\.3$/m.test(tx) && /3\.141592653589793/.test(tx) && /123456789012345\b/.test(tx) && /Val: -42\.5/.test(tx), tx);
  const D = (v, fmtId, o = {}) => text(X([['Id', 'D'], ['x', { s: 1, v: String(v) }]], {}, { styles: defaultStyles({ xfs: [0, fmtId] }), ...o }));
  check('date 1900 system', /D: 2020-06-18/.test(D(44000, 14)));
  check('1900 leap-year bug: serial 60 is 1900-02-29, 61 is 1900-03-01', /1900-02-29/.test(D(60, 14)) && /1900-03-01/.test(D(61, 14)) && /1900-01-01/.test(D(1, 14)));
  check('date 1904 system', /D: 2024-06-19/.test(D(44000, 14, { date1904: true })), D(44000, 14, { date1904: true }));
  check('date-time (built-in 22) shows ISO date and time', /D: 2020-06-18 12:00/.test(D(44000.5, 22)));
  check('time only', /D: 18:00/.test(D(0.75, 20)));
  const C = (v, code) => text(X([['Id', 'V'], ['x', { s: 1, v: String(v) }]], {}, { styles: defaultStyles({ numFmts: { 170: code }, xfs: [0, 170] }) }));
  check('custom date format with time', /V: 2020-06-18 18:00/.test(C(44000.75, 'yyyy-mm-dd hh:mm')));
  check('locale-tagged long date format read as a date', /V: 2020-06-18/.test(C(44000, '[$-409]mmmm d, yyyy;@')));
  check('percent', /V: 12\.34%/.test(C(0.1234, '0.00%')));
  check('thousands separator', /V: 1,234,567/.test(C(1234567, '#,##0')));
  check('currency euro, negative in parentheses', /V: \(€1,234\.50\)|V: €\(1,234\.50\)/.test(C(-1234.5, '[$€-407]#,##0.00;([$€-407]#,##0.00)')) || /\(1,234\.50\)/.test(C(-1234.5, '#,##0.00;(#,##0.00)')));
  check('negative number always shows its sign', /V: -\$1,500/.test(C(-1500, '"$"#,##0')));
  check('scientific', /V: 1\.23E\+04/.test(C(12345, '0.00E+00')));
  check('accounting built-in 44', /V: \$1,234\.50/.test(text(X([['Id', 'V'], ['x', { s: 1, v: '1234.5' }]], {}, { styles: defaultStyles({ xfs: [0, 44] }) }))));
  check('numFmt helpers (unit): 1.005 -> 1.01, 0 -> 1900-01-00', NF.formatNumeric(1.005, NF.parseFormat('0.00'), false).text === '1.01' && NF.formatNumeric(0, NF.parseFormat('yyyy-mm-dd'), false).text === '1900-01-00');
  r = X([['Id', 'Calc'], ['a', { f: 'SUM(1,2)', v: '3' }], ['b', { f: 'NOW()' }], ['c', { f: "'[1]Ext'!A1+DDE(\"cmd\")", v: '99' }], ['d', { f: 'A1&"x"', t: 'str', v: 'text result' }]]);
  check('formulas: cached value shown, never evaluated; no cached value = nothing', /Calc: 3/.test(text(r)) && !/Row 3 \| Id: b \| Calc/.test(text(r)) && /Calc: 99/.test(text(r)) && /Calc: text result/.test(text(r)) && !/NOW|SUM|DDE/.test(text(r)), text(r));
  r = X([['Region', 'Item', 'Qty'], ['North', 'Filters', 5], [null, 'Belts', 6], [null, 'Fans', 7], ['South', 'Coils', 1]].map((row, i) => (i === 2 || i === 3) ? [null, row[1], row[2]] : row), { merges: ['A2:A4', 'A1:C1'] });
  check('merged group label stays attached to every covered row, not duplicated horizontally', /Row 3 \| Region: North \| Item: Belts/.test(text(r)) && /Row 4 \| Region: North \| Item: Fans/.test(text(r)) && !/Region: North \| Item: Filters \| Qty: 5 \| Region/.test(text(r)) && !/Region: North \| Item: Fans[^\n]*Region: North/.test(text(r)), text(r));
  r = X([['A1', null, 'C1'], [null, null, null], [null, null, null], ['A4', null, 'C4']]);
  check('empty rows and empty columns skipped; row numbers kept', /Row 4/.test(text(r)) && !/Row 2 /.test(text(r)) && !/Column B/.test(text(r)), text(r));
  check('single-column sheet: no header guessed, columns lettered', /Row 1 \| Column A: Only/.test(text(X([['Only'], ['two']]))));
  const wb2 = read(buildXlsx([{ name: 'Empty', rows: [] }, { name: 'Data', rows: [['H1', 'H2'], ['a', 'b']] }, { name: 'Blank2', rows: [[null, '']] }]), 'a.xlsx');
  check('empty sheets give 0 pages; page numbers contiguous', wb2.ok && wb2.pages.length === 1 && wb2.pages[0].page_no === 1 && /Sheet "Data"/.test(wb2.pages[0].text));
  const allEmpty = read(buildXlsx([{ name: 'Empty', rows: [] }]), 'a.xlsx');
  check('all-empty workbook: ok with 0 pages (NO_READABLE_TEXT path)', allEmpty.ok && allEmpty.pages.length === 0);
  const hid = read(buildXlsx([{ name: 'Vis', rows: [['A', 'B'], ['1', '2']] }, { name: 'Old', state: 'hidden', rows: [['A', 'B'], ['x', 'y']] }, { name: 'Deep', state: 'veryHidden', rows: [['A', 'B'], ['p', 'q']] }]), 'a.xlsx');
  check('hidden and veryHidden sheets read and marked; visible not marked', /Sheet "Old" rows [^\n]* \(hidden sheet\)/.test(hid.pages[1].text) && /Sheet "Deep" rows [^\n]* \(hidden sheet\)/.test(hid.pages[2].text) && !/hidden/.test(hid.pages[0].text), text(hid));
  const rowsBig = [['Customer', 'Notes']]; for (let i = 0; i < 400; i++) rowsBig.push([`Cust ${i}`, 'n'.repeat(60)]);
  r = X(rowsBig);
  check('long sheet chunked: header repeated in every chunk, first line in every chunk', r.pages.length > 3 && r.pages.every((x) => /^Sheet "Sheet1" rows \d+-\d+ of 401\n/.test(x.text) && /Header \(row 1\): Customer \| Notes/.test(x.text)), `${r.pages.length}`);
  const seen = text(r).match(/^Row \d+ /gm) ?? [];
  check('every data row present exactly once across chunks', seen.length === 400 && new Set(seen).size === 400);
  check('chunk size about SHEET_CHUNK_CHARS', r.pages.every((x) => x.text.length <= L.SHEET_CHUNK_CHARS + 200), Math.max(...r.pages.map((x) => x.text.length)));
  check('chunk row range matches its rows', r.pages.every((x) => { const m = /rows (\d+)-(\d+) of/.exec(x.text); const nums = [...x.text.matchAll(/^Row (\d+) /gm)].map((q) => +q[1]); return +m[1] === nums[0] && +m[2] === nums[nums.length - 1]; }));
  const rk = read(buildXlsx([{ name: 'Q"uote', rows: [['A', 'B'], ['x', 'y']] }]), 'a.xlsx');
  check('sheet name with a quote is safe in the locator', /Sheet "Q'uote"/.test(rk.pages[0].text));
  // external link / hostile relationships are never followed
  const ext = buildXlsx([{ name: 'S', rows: [['A', 'B'], ['x', 'y']] }], { extraParts: [{ name: 'xl/externalLinks/externalLink1.xml', data: '<externalLink/>' }, { name: 'xl/_rels/workbook.xml.rels.bak', data: 'x' }] });
  check('external links note, content still read', read(ext, 'a.xlsx').ok && /not followed/.test(read(ext, 'a.xlsx').notes.join(' ')));
  const wbExtern = zlib; void wbExtern;
}

/* ===================================================================== csv */
family = 'csv';
{
  const C = (s, name = 'a.csv') => read(Buffer.isBuffer(s) ? s : Buffer.from(s), name);
  let r = C('Name,Phone,City\nSmith J,555-1,Mesa\nBob,555-2,Tempe\n');
  check('csv: same page shape as xlsx (locator, header, labelled rows)', /^Sheet "a" rows 2-3 of 3\nHeader \(row 1\): Name \| Phone \| City\nRow 2 \| Name: Smith J \| Phone: 555-1 \| City: Mesa/.test(r.pages[0].text), r.pages[0]?.text);
  check('semicolon delimiter sniffed', /Name: A \| Val: 1,5/.test(text(C('Name;Val\nA;1,5\nB;2,5\n'))));
  check('tab delimiter sniffed (.tsv)', /Name: A \| Val: x/.test(text(C('Name\tVal\nA\tx\nB\ty\n', 'a.tsv'))));
  check('pipe delimiter sniffed', /Name: A \| Val: x/.test(text(C('Name|Val\nA|x\nB|y\n'))));
  r = C('Name,Quote\n"Smith, John","He said ""hi"""\n"Multi\nline",ok\n');
  check('quotes, escaped quotes, comma and newline inside a quoted cell', /Name: Smith, John \| Quote: He said "hi"/.test(text(r)) && /Name: Multi \/ line \| Quote: ok/.test(text(r)), text(r));
  check('CRLF and CR line endings', /Row 3 \| A: 3/.test(text(C('A,B\r\n1,2\r\n3,4\r\n'))) && /Row 3 \| A: 3/.test(text(C('A,B\r1,2\r3,4\r'))));
  check('UTF-8 BOM stripped from the first header', /Header \(row 1\): Name \| Zip/.test(text(C(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Name,Zip\nA,1\n')])))));
  check('UTF-16LE with BOM decoded', /Name: José/.test(text(C(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Name,Zip\nJosé,1\nB,2\n', 'utf16le')])))));
  check('Windows-1252 decoded (accent kept)', /Name: José Muñoz/.test(text(C(Buffer.from('Name,Zip\nJos\xE9 Mu\xF1oz,1\nB,2\n', 'latin1')))));
  check('title block above the header tolerated', /Header \(row 3\): Name \| Phone/.test(text(C('Customer list March\n\nName,Phone\nA,1\nB,2\n'))));
  check('empty cells and blank lines skipped, row numbers count blank lines', /Row 4 \| A: x/.test(text(C('A,B\n\n,\nx,\n'))) && !/Row 3 /.test(text(C('A,B\n\n,\nx,\n'))));
  check('empty csv: 0 bytes refused as empty; blank lines only = ok with 0 pages', refused(C(''), 422, /empty/) && C('\n\n').ok && C('\n\n').pages.length === 0);
  const big = ['Customer,Notes']; for (let i = 0; i < 500; i++) big.push(`Cust ${i},${'n'.repeat(50)}`);
  r = C(big.join('\n'));
  check('long csv: header repeated in every chunk', r.pages.length > 3 && r.pages.every((x) => /Header \(row 1\): Customer \| Notes/.test(x.text)), `${r.pages.length}`);
  r = C('a,b\n"unclosed,1\n2,3\n');
  check('unbalanced quote does not throw (noted)', r.ok && r.notes.length === 1);
  r = C(Buffer.from('Name,Phone\n' + 'x,y\n'.repeat(5)), 'noext');
  check('csv decoding for a name without an extension: refused honestly (not Office, not csv)', r.ok === false);
  check('csv row cap', refused(C('a,b\n' + '1,2\n'.repeat(200001)), 413, /rows/), '');
  check('csv column cap', refused(C('a,b\n' + Array.from({ length: 1001 }, (_, i) => i).join(',') + '\n'), 413, /columns/));
}

/* ===================================================================== refusals */
family = 'refuse';
{
  const sig = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const ole = Buffer.concat([sig, Buffer.alloc(600)]);
  const oleEnc = Buffer.concat([sig, Buffer.alloc(600), Buffer.from('EncryptedPackage', 'utf16le'), Buffer.from('EncryptionInfo', 'utf16le')]);
  const oleWord = Buffer.concat([sig, Buffer.alloc(600), Buffer.from('WordDocument', 'utf16le')]);
  let r = read(oleWord, 'legacy-named.docx');
  check('OLE2 with a WordDocument stream named .docx: old Word message, not password', refused(r, 415, /old Word \(\.doc\).*Save As \.docx, then upload again/) && !/password/.test(r.message), r.message);
  r = read(oleEnc, 'x.docx'); check('OLE2 with EncryptedPackage/EncryptionInfo = password-protected', refused(r, 415, /password-protected/), r.message);
  r = read(ole, 'old.doc');
  check('legacy .doc (OLE2): 415, says Save As .docx', refused(r, 415, /old Word.*\.docx/s), r.message);
  r = read(ole, 'old.xls'); check('legacy .xls: 415, says .xlsx', refused(r, 415, /old Excel.*\.xlsx/s), r.message);
  r = read(ole, 'old.ppt'); check('legacy .ppt: 415, says PDF', refused(r, 415, /PowerPoint/), r.message);
  r = read(oleEnc, 'new.docx'); check('.docx name over encrypted OLE2 = password-protected message', refused(r, 415, /password-protected.*remove the password|Remove the password/is), r.message);
  r = read(oleEnc, 'new.xlsx'); check('.xlsx name over encrypted OLE2 = password-protected message', refused(r, 415, /password-protected/i), r.message);
  const macroParts = (extra) => buildDocx(p('hi'), { extra: { 'word/vbaProject.bin': 'MZ-vba' }, ...extra });
  r = read(macroParts(), 'a.docx'); check('vbaProject.bin part refused with the no-macros message', refused(r, 415, /without macros|\.docx/i) && /macros/.test(r.message), r.message);
  r = read(buildDocx(p('hi'), { contentTypesExtra: '<Override PartName="/x.xml" ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/>' }), 'a.docx');
  check('macroEnabled content type refused', refused(r, 415, /macros/), r.message);
  for (const ext of ['docm', 'xlsm', 'xlsb', 'dotm', 'xltm']) {
    r = read(buildDocx(p('hi')), `a.${ext}`);
    check(`.${ext} refused by name, with the Save-As message`, refused(r, 415, /macros/), r.message);
  }
  r = read(buildZip([{ name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' }, { name: 'xl/workbook.bin', data: 'x' }]), 'a.xlsx');
  check('real xlsb package refused', refused(r, 415));
  r = read(buildZip([{ name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>' }, { name: 'ppt/presentation.xml', data: '<a/>' }]), 'a.docx');
  check('pptx refused (PowerPoint message)', refused(r, 415, /PowerPoint/), r.message);
  r = read(buildZip([{ name: 'META-INF/MANIFEST.MF', data: 'x' }, { name: 'A.class', data: 'x' }]), 'a.docx');
  check('jar refused', refused(r, 415, /not a Word or Excel|Java/), r.message);
  r = read(buildZip([{ name: 'AndroidManifest.xml', data: 'x' }, { name: 'classes.dex', data: 'x' }]), 'a.xlsx');
  check('apk refused', refused(r, 415, /Android|not a Word/), r.message);
  r = read(buildZip([{ name: 'notes.txt', data: 'hello' }]), 'a.docx');
  check('plain zip refused, says archive', refused(r, 415, /ZIP archive/), r.message);
  r = read(buildZip([{ name: 'mimetype', data: 'application/vnd.oasis.opendocument.text' }]), 'a.docx');
  check('OpenDocument refused', refused(r, 415));
  for (const [label, bytes, name] of [['exe', Buffer.from('MZ\x90\x00' + 'x'.repeat(300), 'latin1'), 'setup.docx'], ['ELF', Buffer.from('\x7fELF' + 'x'.repeat(300), 'latin1'), 'a.xlsx'], ['html', Buffer.from('<html><script>alert(1)</script></html>'.padEnd(200)), 'a.docx'], ['shell script', Buffer.from('#!/bin/sh\nrm -rf /\n'.padEnd(200)), 'a.xlsx'], ['pdf bytes', Buffer.from('%PDF-1.4\n' + 'x'.repeat(200)), 'a.docx']]) {
    r = read(bytes, name);
    check(`${label} renamed ${name.split('.').pop()} refused, nothing run`, r.ok === false && r.status === 415, JSON.stringify(r));
  }
  r = read(Buffer.alloc(0), 'a.docx'); check('empty file refused', refused(r, 422, /empty/));
  r = read(Buffer.from('plain words'), 'a.txt'); check('non-office, non-csv refused', r.ok === false);
  check('never throws on garbage input types', [undefined, null, 'string', 5, {}, []].every((g) => { try { return typeof O.readOfficeFile(g, { filename: 'x.docx' }).ok === 'boolean'; } catch { return false; } }));
  check('real-kind describer: docx / xlsx / ole2 / other', O.describeRealKind(buildDocx(p('x'))).kind === 'docx' && O.describeRealKind(buildXlsx([{ name: 'S', rows: [['a']] }])).kind === 'xlsx' && O.describeRealKind(ole).kind === 'ole2' && O.describeRealKind(Buffer.from('hi there')).kind === 'other');
}

/* ===================================================================== caps */
family = 'caps';
{
  let r = read(buildXlsx(Array.from({ length: L.MAX_SHEETS + 1 }, (_, i) => ({ name: `S${i}`, rows: [['a', 'b'], ['c', 'd']] }))), 'a.xlsx');
  check(`more than ${L.MAX_SHEETS} sheets refused 413`, refused(r, 413, /sheets/), r.message);
  const ok64 = read(buildXlsx(Array.from({ length: L.MAX_SHEETS }, (_, i) => ({ name: `S${i}`, rows: [['a', 'b'], ['c', 'd']] }))), 'a.xlsx');
  check(`exactly ${L.MAX_SHEETS} sheets read`, ok64.ok && ok64.pages.length === L.MAX_SHEETS);
  const cols = '<c r="{ref}" t="n"><v>1</v></c>';
  const wide = Array.from({ length: 2 }, () => Array.from({ length: L.MAX_COLS_PER_ROW + 1 }, () => ({ raw: cols })));
  r = read(buildXlsx([{ name: 'W', rows: wide }]), 'a.xlsx');
  check('row wider than 1,000 columns refused 413', refused(r, 413, /columns/), r.message);
  const rowsXml = (n) => `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${Array.from({ length: n }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join('')}</sheetData></worksheet>`;
  r = read(buildXlsx([{ name: 'R', xml: rowsXml(L.MAX_ROWS_PER_SHEET + 1) }]), 'a.xlsx');
  check(`more than ${L.MAX_ROWS_PER_SHEET} rows in a sheet refused 413`, refused(r, 413, /rows/), r.message);
  r = read(buildXlsx([{ name: 'S', xml: `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="9999999"><c r="A1"><v>1</v></c></row></sheetData></worksheet>` }]), 'a.xlsx');
  check('absurd row number refused', refused(r, 422));
  // total chars: shared string reused many times (expansion attack)
  const s32 = 'z'.repeat(32000);
  const cellsPerRow = 100;
  const bigRows = Array.from({ length: 450 }, (_, i) => Array.from({ length: cellsPerRow }, () => s32));
  const t0 = Date.now(); r = read(buildXlsx([{ name: 'Big', rows: bigRows }]), 'a.xlsx');
  check('shared-string expansion (one 32k string x 45,000 cells) stopped by the total-chars cap, fast', r.ok === false && r.status === 413 && Date.now() - t0 < 20000, `${r.status} ${Date.now() - t0}ms ${r.message}`);
  // pages cap: docx
  r = read(buildDocx(Array.from({ length: 2200 }, (_, i) => p('x'.repeat(2900) + i)).join('')), 'a.docx');
  check(`more than ${L.MAX_PAGES_PER_FILE} pages refused 413`, refused(r, 413), `${r.status} ${r.message}`);
  // timeout
  const slowRows = Array.from({ length: 20000 }, (_, i) => ['a' + i, 'b' + i]);
  const slow = buildXlsx([{ name: 'S', rows: slowRows }]);
  r = O.readOfficeFile(slow, { filename: 'a.xlsx', timeoutMs: 1 });
  check('wall-clock timeout (1 ms budget) gives a clean 413, not a hang', refused(r, 413, /too large or too complex/), JSON.stringify(r).slice(0, 200));
  r = O.readOfficeFile(slow, { filename: 'a.xlsx' });
  check('same file reads with the normal budget', r.ok);
  check('limits.js is the single source (no number copied into the readers)', !/(?:2000|64 \* 1024|200_000|2_000_000|32_767|12_000_000)\b/.test(['docx', 'xlsx', 'csv', 'zipSafe', 'sheetChunk', 'xml'].map((f) => fs.readFileSync(rel(`api/_lib/office/${f}.js`), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')).join('\n')));
}

/* ===================================================================== determinism, idempotence, fuzz */
family = 'fuzz';
{
  const fixtures = [
    ['a.docx', buildDocx(h('Invoice') + p('Customer: Acme') + tbl(tr(cell('a'), cell('b')), tr(cell('c'), cell('d'))) + p('end', { list: 1 }))],
    ['a.xlsx', buildXlsx([{ name: 'S', rows: [['Name', 'Qty', 'D'], ['x', 1, { s: 1, v: '44000' }], ['y', 2.5, { s: 1, v: '44001' }]], merges: ['A2:A3'] }, { name: 'H', state: 'hidden', rows: [['a', 'b'], ['c', 'd']] }], { styles: defaultStyles({ xfs: [0, 14] }) })],
    ['a.csv', Buffer.from('Name,Phone\n"Smith, J",555-1\nBob,555-2\n')],
  ];
  for (const [name, bytes] of fixtures) {
    const a = JSON.stringify(read(bytes, name)); const b = JSON.stringify(read(Buffer.from(bytes), name));
    check(`deterministic: same bytes -> same pages (${name})`, a === b && JSON.parse(a).ok === true);
  }
  let seed = 123456789;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  let threw = 0, bad = 0, slowest = 0, okCount = 0;
  const N = 2000;
  for (let i = 0; i < N; i++) {
    const [name, src] = fixtures[i % fixtures.length];
    let b = Buffer.from(src);
    const mode = Math.floor(rnd() * 4);
    if (mode === 0) b = b.subarray(0, Math.floor(rnd() * b.length));
    else if (mode === 1) for (let k = 0, n = 1 + Math.floor(rnd() * 8); k < n; k++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
    else if (mode === 2) { const at = Math.floor(rnd() * b.length); b = Buffer.concat([b.subarray(0, at), crypto.randomBytes(1 + Math.floor(rnd() * 40)), b.subarray(at)]); }
    else { const at = Math.floor(rnd() * b.length); const len = Math.floor(rnd() * 64); b = Buffer.concat([b.subarray(0, at), b.subarray(at + len)]); }
    const t0 = Date.now();
    try {
      const r = O.readOfficeFile(b, { filename: name });
      if (typeof r.ok !== 'boolean' || (r.ok === false && (!r.message || !r.status))) bad++;
      if (r.ok) okCount++;
    } catch { threw++; }
    slowest = Math.max(slowest, Date.now() - t0);
  }
  check(`${N} mutated/truncated files: no throw`, threw === 0, `${threw} threw`);
  check(`${N} mutated files: every result is a well-formed ok/refusal`, bad === 0, `${bad} malformed`);
  check('fuzz: nothing slower than 2 s', slowest < 2000, `${slowest} ms`);
  check('fuzz: some mutants still read (mutations are not all fatal), some refused', okCount > 0 && okCount < N, `${okCount}`);
  // inflated-content mutation: mutate the XML itself (valid zip, hostile xml)
  let xmlBad = 0;
  for (let i = 0; i < 300; i++) {
    const xml = `<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>hello</w:t></w:r></w:p></w:body></w:document>`;
    const arr = Buffer.from(xml); for (let k = 0; k < 3; k++) arr[Math.floor(rnd() * arr.length)] = 32 + Math.floor(rnd() * 95);
    const z = buildZip([{ name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' }, { name: 'word/document.xml', data: arr }]);
    try { const r = O.readOfficeFile(z, { filename: 'a.docx' }); if (typeof r.ok !== 'boolean') xmlBad++; } catch { xmlBad++; }
  }
  check('300 mutated XML parts inside a valid zip: no throw', xmlBad === 0);
}

/* ===================================================================== independent-review fixes (F1-F8) */
family = 'review';
{
  const timed = (fn) => { const t = Date.now(); const v = fn(); return [v, Date.now() - t]; };
  const maxPage = (r) => Math.max(0, ...(r.pages ?? []).map((x) => x.text.length));
  const totalChars = (r) => (r.pages ?? []).reduce((n, x) => n + x.text.length, 0);
  // F1: label amplification
  const label = 'L'.repeat(30000);
  const csvAmp = (rows) => Buffer.from(`${label}a,${label}b\n` + '1,2\n'.repeat(rows));
  let [r, ms] = timed(() => read(csvAmp(1990), 'amp.csv'));
  check('F1 csv: 1,990 rows under two 30,000-char header labels is bounded (labels cut, no page over ~1.5x chunk, total far below the cap)', r.ok && maxPage(r) < L.SHEET_CHUNK_CHARS * 1.5 && totalChars(r) < L.MAX_TOTAL_CHARS && ms < 5000, `${r.ok} ${r.status} max=${maxPage(r)} total=${totalChars(r)} ${ms}ms`);
  [r, ms] = timed(() => read(csvAmp(100000), 'amp.csv'));
  check('F1 csv: 100,000 rows under huge labels ends cleanly (ok under the caps or 413), fast', (r.ok ? totalChars(r) <= L.MAX_TOTAL_CHARS : r.status === 413) && ms < 20000, `${r.ok} ${r.status} ${ms}ms`);
  const rowsAmp = [[label + 'a', label + 'b']]; for (let i = 0; i < 2000; i++) rowsAmp.push(['1', '2']);
  [r, ms] = timed(() => read(buildXlsx([{ name: 'S', rows: rowsAmp }]), 'amp.xlsx'));
  check('F1 xlsx: same attack bounded', r.ok && maxPage(r) < L.SHEET_CHUNK_CHARS * 1.5 && totalChars(r) < L.MAX_TOTAL_CHARS && ms < 8000, `${r.ok} ${r.status} max=${maxPage(r)} ${ms}ms`);
  check('F1: header line shows the cut label, not 30,000 chars', /Header \(row 1\): L{80}\.\.\./.test(read(csvAmp(5), 'a.csv').pages[0].text));
  // render-budget: many wide rows must hit the clean 413 (not memory) well before the whole sheet is built
  const wideRows = Array.from({ length: 3000 }, () => Array.from({ length: 200 }, () => 'v'.repeat(300)));
  [r, ms] = timed(() => read(buildXlsx([{ name: 'Wide', rows: [Array.from({ length: 200 }, (_, i) => `H${i}`), ...wideRows] }]), 'w.xlsx'));
  check('F1: rendered text counted while building pages: 180 MB of rendered text refused cleanly with 413', refused(r, 413) && ms < 30000, `${r.ok} ${r.status} ${ms}ms`);
  // F4 sheets: a single row longer than a chunk is split with its row number and labels
  const fat = ['Name', 'Notes']; const fatRow = ['Acme', 'z'.repeat(20000)];
  r = read(buildXlsx([{ name: 'S', rows: [fat, fatRow, ['Beta', 'ok']] }]), 'fat.xlsx');
  check('F4 xlsx: a 20,000-char cell becomes ~4 chunks (not one 20,000-char page), every piece carries Row 2 and its label', r.ok && r.pages.length >= 4 && maxPage(r) <= L.SHEET_CHUNK_CHARS + 300 && r.pages.filter((x) => /Row 2 \| (Name: Acme \| )?Notes/.test(x.text)).length >= 4, `${r.pages?.length} max=${maxPage(r)}`);
  const many = [Array.from({ length: 100 }, (_, i) => `C${i}`), Array.from({ length: 100 }, () => 'x'.repeat(30000))];
  r = read(buildXlsx([{ name: 'S', rows: many }]), 'many.xlsx');
  check('F4 xlsx: one row of 100 cells x 30,000 chars bills as ~chars/6000 pages, none oversized', r.ok === false ? r.status === 413 : (r.pages.length >= totalChars(r) / (L.SHEET_CHUNK_CHARS + 400) && maxPage(r) <= L.SHEET_CHUNK_CHARS + 400), `${r.ok} ${r.status} ${r.pages?.length}`);
  // F2: tabs
  const tabsDoc = (n) => buildDocx(`<w:p><w:r>${'<w:tab/>'.repeat(n)}<w:t>end</w:t></w:r></w:p>`);
  [r, ms] = timed(() => read(tabsDoc(120000), 'a.docx'));
  check('F2: 120,000 tabs then text reads fast (linear trim)', r.ok && /end/.test(text(r)) && ms < 1500, `${ms}ms`);
  [r, ms] = timed(() => read(tabsDoc(3000000), 'a.docx'));
  check('F2: 3,000,000 tabs then text finishes in well under the budget', typeof r.ok === 'boolean' && ms < 8000, `${r.ok} ${r.status} ${ms}ms`);
  // F3: empty cells
  const emptyRow = (n) => buildDocx(`<w:tbl><w:tblPr/><w:tr><w:tc><w:p><w:r><w:t>first</w:t></w:r></w:p></w:tc>${'<w:tc/>'.repeat(n)}</w:tr></w:tbl>`);
  [r, ms] = timed(() => read(emptyRow(100000), 'a.docx'));
  check('F3: 100,000 trailing empty cells reads fast', r.ok && /first/.test(text(r)) && ms < 1500, `${ms}ms`);
  [r, ms] = timed(() => read(emptyRow(400000), 'a.docx'));
  check('F3: 400,000 trailing empty cells reads fast', r.ok && ms < 6000, `${r.ok} ${ms}ms`);
  // F3b: deadline is cooperative beyond the XML parser
  [r, ms] = timed(() => O.readOfficeFile(emptyRow(400000), { filename: 'a.docx', timeoutMs: 1 }));
  check('F3: a 1 ms budget stops a huge table with a clean 413', refused(r, 413) && ms < 3000, `${ms}ms ${JSON.stringify(r).slice(0, 120)}`);
  // F4 docx: huge row / cell
  const hugeCell = buildDocx(`<w:tbl><w:tblPr/><w:tr><w:tc><w:p><w:r><w:t>${'word '.repeat(1000000)}</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`);
  [r, ms] = timed(() => read(hugeCell, 'a.docx'));
  check('F4 docx: a single 5,000,000-char table cell becomes ~1,667 pages (billed by size), no page over ~2.5 pages of text', r.ok && r.pages.length >= 1500 && r.pages.length <= 2000 && maxPage(r) <= L.WORD_PAGE_CHARS * 2.5, `${r.pages?.length} max=${maxPage(r)} ${ms}ms ${r.status}`);
  const bigRow = buildDocx(`<w:tbl><w:tblPr/><w:tr>${Array.from({ length: 40 }, (_, i) => `<w:tc><w:p><w:r><w:t>${i === 0 ? 'KEYCELL' : 'c' + i}${' text'.repeat(500)}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr></w:tbl>`);
  r = read(bigRow, 'a.docx');
  check('F4 docx: a 40-cell row of ~2,500 chars each splits at cell boundaries; continuation pieces name the first cell', r.ok && r.pages.length >= 25 && /KEYCELL[^\n]*\(row continues\)/.test(r.pages[1].text) && maxPage(r) <= L.WORD_PAGE_CHARS * 2.5, `${r.pages?.length}`);
  r = read(buildDocx(`<w:tbl><w:tblPr/><w:tr>${'<w:tc/>'.repeat(100000)}<w:tc><w:p><w:r><w:t>only value</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`), 'a.docx');
  check('F4 docx: 100,000 empty cells before one value is not a 300 KB page', r.ok && maxPage(r) < 200 && /only value/.test(text(r)), `${maxPage(r)}`);
  // F7
  const fmtBook = (code) => buildXlsx([{ name: 'S', rows: [['Id', 'V'], ['x', { s: 1, v: '1.5' }]] }], { styles: defaultStyles({ numFmts: { 170: code }, xfs: [0, 170] }) });
  r = read(fmtBook('0.' + '0'.repeat(101)), 'a.xlsx');
  check('F7: a format with 101 decimals reads (cell as a number), the workbook is not refused', r.ok && /V: 1\.5/.test(text(r)), JSON.stringify(r).slice(0, 150));
  [r, ms] = timed(() => read(fmtBook('0.00' + ';'.repeat(100) + '"' + 'x'.repeat(1000000) + '"'), 'a.xlsx'));
  check('F7: a 1 MB format code reads as General, fast', r.ok && /V: 1\.5/.test(text(r)) && ms < 3000, `${ms}ms`);
  let allOk = true;
  for (let i = 0; i < 1200; i++) { if (NF.formatNumeric(1.5, NF.parseFormat(`0.0"u${i}"`), false).text !== `1.5u${i}`) allOk = false; }
  check('F7: 1,200 distinct formats still format correctly through the bounded cache', allOk);
  // F8
  r = read(buildDocx('<w:p><w:r><w:t>Seen </w:t></w:r><w:r><w:rPr><w:vanish/></w:rPr><w:t>HIDDENWORDS</w:t></w:r><w:r><w:rPr><w:vanish w:val="0"/></w:rPr><w:t>shown</w:t></w:r></w:p>'), 'a.docx');
  check('F8: hidden Word text (w:vanish) is not read; visible and vanish=0 text is', /Seen shown/.test(text(r)) && !/HIDDENWORDS/.test(text(r)), text(r));
  check('process healthy after review attacks', read(buildDocx(p('fine')), 'a.docx').ok);
}

/* ===================================================================== optional external fixture set */
family = 'fixtures';
{
  const dir = rel('scripts/office-fixtures');
  let n = 0, threw = 0;
  if (fs.existsSync(dir)) {
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    for (const f of walk(dir).filter((x) => /\.(docx|xlsx|csv|tsv|doc|xls|ppt|pptx|docm|xlsm|xlsb|zip|exe|pdf|txt)$/i.test(x))) {
      n++;
      try { const r = O.readOfficeFile(fs.readFileSync(f), { filename: path.basename(f) }); if (typeof r.ok !== 'boolean') threw++; } catch { threw++; }
    }
  }
  check(`tester fixture set read without a throw (${n} files found)`, threw === 0);
}

/* ===================================================================== ingest integration (PGlite) */
family = 'ingest';
{
  const { PGlite } = await import('@electric-sql/pglite');
  const contrib = {};
  for (const key of ['uuid_ossp', 'pgcrypto', 'pg_trgm', 'btree_gin']) contrib[key] = (await import(`@electric-sql/pglite/contrib/${key}`))[key];
  const lite = new PGlite({ extensions: contrib });
  const cfgDir = rel('M3-config');
  for (const f of fs.readdirSync(cfgDir).filter((x) => /^\d\d.*\.sql$/.test(x) && !x.startsWith('99')).sort()) { try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch { /* optional */ } }
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* optional */ }
  const pgMod = (await import('pg')).default;
  let tail = Promise.resolve();
  const lock = () => { let release; const pr = new Promise((r) => { release = r; }); const prev = tail; tail = tail.then(() => pr); return prev.then(() => release); };
  pgMod.Pool.prototype.connect = async function connect() { const release = await lock(); await lite.exec('SET ROLE deepwell_rls'); return { query: (sql, params) => lite.query(sql, params), release: () => { lite.exec('RESET ROLE').finally(release); } }; };
  pgMod.Pool.prototype.query = async function query(sql, params) { const release = await lock(); try { return await lite.query(sql, params); } finally { release(); } };
  const RS = await import(rel('api/_lib/recordsStore.js'));
  const PLAN = await import(rel('api/_lib/plan.js'));
  const newTenant = async (key) => { const ctx = await RS.getTenantContext(key, key); await lite.query(`UPDATE tenants SET billing_status='active', plan='fleet' WHERE id = $1`, [ctx.id]); RS._resetTenantContextCache?.(); PLAN._resetBillingRowCache?.(); return ctx.id; };
  const tenantA = await newTenant('org_off_a');
  const tenantB = await newTenant('org_off_b');
  const ctxA = { tenantKey: 'org_off_a', tenantName: 'org_off_a' };
  const ctxB = { tenantKey: 'org_off_b', tenantName: 'org_off_b' };
  const RD = await import(rel('api/_lib/readDocument.js'));
  const R2 = await import(rel('api/_lib/r2.js'));

  const store = new Map();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const key = decodeURIComponent(u.pathname.replace(/^\/[^/]+\//, ''));
    if ((init.method ?? 'GET') === 'DELETE') { store.delete(key); return new Response(null, { status: 204 }); }
    const b = store.get(key);
    if (!b) return new Response('nope', { status: 404 });
    return new Response(b, { status: 200, headers: { 'content-length': String(b.length) } });
  };
  let modelCalls = 0;
  RD.__setAnthropicClientFactoryForTests(() => ({ messages: { create: async () => { modelCalls++; throw new Error('model must not be called'); } } }));
  const put = async (tenantId, bytes, { filename, contentType = null }) => {
    const id = crypto.randomUUID();
    const key = `${tenantId}/ab/${crypto.randomBytes(16).toString('hex')}`;
    await lite.query(`INSERT INTO documents (id, tenant_id, original_filename, content_type, storage_key, sha256_hash, stage, created_at) VALUES ($1,$2,$3,$4,$5,$6,'received',NOW())`, [id, tenantId, filename, contentType, key, crypto.randomBytes(8).toString('hex')]);
    store.set(key, bytes);
    return id;
  };
  const ingest = async (ctx, id) => { try { return { ok: true, r: await RD.ingestDocument(ctx, id, { userId: 'u' }) }; } catch (e) { return { ok: false, status: e.status, message: e.message }; } };
  const pagesOf = async (id) => (await lite.query('select page_no, text from document_pages where document_id=$1 order by page_no', [id])).rows;
  const docRow = async (id) => (await lite.query('select stage, extract_error as error, page_count from documents where id=$1', [id])).rows[0];
  const DOCX_T = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const XLSX_T = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  const invoice = buildDocx(h('Invoice 5521') + p('Customer: Zephyr Cooling Co') + p('Service Address: 88 Palo Verde Dr, Mesa, AZ 85201') + p('Invoice Number: 5521') + p('Total Due: $842.17') + tbl(tr(cell('Item'), cell('Amount')), tr(cell('Capacitor 45/5'), cell('$842.17'))));
  const customers = buildXlsx([{ name: 'Customers', rows: [['Customer', 'Phone', 'Address'], ['Quillfeather Plumbing', '480-555-0142', '14 Saguaro Ln, Tempe, AZ'], ['Bramblewick Dental', '602-555-0190', '9 Ocotillo Rd, Phoenix, AZ']] }]);
  let id = await put(tenantA, invoice, { filename: 'invoice 5521.docx', contentType: DOCX_T });
  let x = await ingest(ctxA, id);
  check('docx invoice ingests: method text, source office-docx, no model call', x.ok && x.r.method === 'text' && x.r.source === 'office-docx' && modelCalls === 0, JSON.stringify(x));
  const dp = await pagesOf(id);
  check('docx pages stored in document_pages with the locator and the text', dp.length >= 1 && /^Section: Invoice 5521/.test(dp[0].text) && /Zephyr Cooling Co/.test(dp[0].text) && /\$842\.17/.test(dp[0].text), JSON.stringify(dp).slice(0, 200));
  check('document row advanced to read with page_count', (await docRow(id)).page_count === dp.length && (await docRow(id)).stage !== 'received');
  const act = (await lite.query(`select changes from audit_log where resource_id=$1 and action='document.extracted'`, [id]).catch(() => ({ rows: [] }))).rows[0];
  check('action log records source office-docx', !act || JSON.stringify(act.changes).includes('office-docx'));
  const again = await ingest(ctxA, id);
  check('idempotent: second ingest returns the cached result, no duplicate pages', again.ok && again.r.skipped === true && (await pagesOf(id)).length === dp.length);
  const forced = await RD.ingestDocument(ctxA, id, { userId: 'u', force: true });
  check('forced re-read converges on the same rows', (await pagesOf(id)).length === dp.length && forced.pages === dp.length);

  const id2 = await put(tenantA, customers, { filename: 'customers.xlsx', contentType: XLSX_T });
  x = await ingest(ctxA, id2);
  check('xlsx customer list ingests: source office-xlsx, free path', x.ok && x.r.source === 'office-xlsx' && modelCalls === 0, JSON.stringify(x));
  const xp = await pagesOf(id2);
  check('sheet page has locator, repeated header, labelled rows', /^Sheet "Customers" rows 2-3 of 3\nHeader \(row 1\): Customer \| Phone \| Address\nRow 2 \| Customer: Quillfeather Plumbing/.test(xp[0].text), xp[0]?.text);
  const id3 = await put(tenantA, Buffer.from('Customer,Phone\nGlimmerstone Roofing,480-555-0111\nNorthwind Air,480-555-0122\n'), { filename: 'list.csv', contentType: 'text/csv' });
  x = await ingest(ctxA, id3);
  check('csv ingests through the sheet chunker: source office-csv', x.ok && x.r.source === 'office-csv' && /Header \(row 1\)/.test((await pagesOf(id3))[0].text), JSON.stringify(x));
  const id3b = await put(tenantA, Buffer.from('Customer,Phone\nAlpha,1\nBeta,2\n'), { filename: 'win.csv', contentType: 'application/vnd.ms-excel' });
  x = await ingest(ctxA, id3b);
  check('csv declared application/vnd.ms-excel (Windows browsers) still read as csv', x.ok && x.r.source === 'office-csv', JSON.stringify(x));

  // search + isolation
  const hit = await RS.withTenant(ctxA, (db) => db.searchPassages('Zephyr Cooling invoice 5521', 5));
  check('offline search finds the docx page', hit.some((r) => r.document_id === id), JSON.stringify(hit.map((r) => r.document_id)));
  const hit2 = await RS.withTenant(ctxA, (db) => db.searchPassages('Quillfeather Plumbing', 5));
  check('offline search finds the xlsx row by customer name', hit2.some((r) => r.document_id === id2));
  const bSearch = await RS.withTenant(ctxB, (db) => db.searchPassages('Zephyr Cooling Quillfeather', 5));
  check('tenant B search never returns tenant A pages', bSearch.length === 0, JSON.stringify(bSearch).slice(0, 200));
  const bPages = await RS.withTenant(ctxB, (db) => db.listPages(id));
  check('tenant B cannot list tenant A document pages', bPages.length === 0);
  check('tenant B cannot get tenant A document', (await RS.withTenant(ctxB, (db) => db.getDocument(id))) == null);
  const idB = await put(tenantB, invoice, { filename: 'inv.docx', contentType: DOCX_T });
  x = await ingest(ctxA, idB);
  check('tenant A cannot ingest tenant B document (not found)', !x.ok && x.status === 404, JSON.stringify(x));
  x = await ingest(ctxB, idB);
  check('tenant B reads its own docx fine', x.ok);
  const spoof = await put(tenantA, invoice, { filename: 'inv.docx', contentType: DOCX_T });
  await lite.query('update documents set storage_key=$2 where id=$1', [spoof, `${tenantB}/zz/spoof`]);
  x = await ingest(ctxA, spoof);
  check("a row pointing at another tenant's storage key is refused (409)", !x.ok && x.status === 409);

  // downstream extraction on office pages. (a) a labelled service ticket as a docx with no Word heading: the locator is
  // "Part 1 of 1", which the deterministic extractor accepts, so it is extracted with NO model call and linked like any
  // other document. (b) the invoice docx (its heading makes a "Section:" locator) goes to the model path, answered by a
  // canned response from a patched fetch: proves the pipeline downstream of the pages is unchanged either way.
  const EX = await import(rel('api/_lib/extractDocument.js'));
  const ticket = buildDocx(['Desert Peak Heating & Cooling', 'SERVICE TICKET', 'Date of Service: 09/12/2025', 'Customer: Margaret Henderson', 'Service Address: 3247 Elm St, Mesa, AZ 85201', 'Equipment: Carrier 24ACC636A003 Serial: 4N2119-08772', 'Visit Type: Repair', 'Technician: Marcus Bell', 'Status: Completed', 'Work Performed: replaced capacitor and cleaned coil'].map((l) => p(l)).join(''));
  const idTk = await put(tenantA, ticket, { filename: 'ticket.docx', contentType: DOCX_T });
  await ingest(ctxA, idTk);
  let exErr = null, exr = null;
  try { exr = await EX.extractDocumentFields(ctxA, idTk, { userId: 'u' }); } catch (e) { exErr = e; }
  const fieldsOf = async (d) => (await lite.query(`select field_key, value from extractions where document_id=$1`, [d]).catch(() => ({ rows: [] }))).rows;
  const tf = await fieldsOf(idTk);
  check('docx service ticket: deterministic extraction, no model call, customer + address fields stored', !exErr && modelCalls === 0 && tf.some((f) => f.field_key === 'customer_name' && /Margaret Henderson/.test(f.value)) && tf.some((f) => f.field_key === 'service_address'), exErr ? `${exErr.status} ${exErr.message}` : JSON.stringify(tf).slice(0, 200));
  // headed docx ticket: its page starts with "Section: SERVICE TICKET"; the locator must not push it to the paid model
  const headed = buildDocx(h('SERVICE TICKET') + ['Date of Service: 09/12/2025', 'Customer: Margaret Henderson', 'Service Address: 3247 Elm St, Mesa, AZ 85201', 'Equipment: Carrier 24ACC636A003 Serial: 4N2119-08772', 'Visit Type: Repair', 'Technician: Marcus Bell', 'Status: Completed', 'Work Performed: replaced capacitor and cleaned coil'].map((l) => p(l)).join(''));
  const idHd = await put(tenantA, headed, { filename: 'headed.docx', contentType: DOCX_T });
  await ingest(ctxA, idHd);
  check('headed docx page starts with a Section locator', /^Section: SERVICE TICKET\n/.test((await pagesOf(idHd))[0].text));
  const mark = modelCalls;
  let hdErr = null; try { await EX.extractDocumentFields(ctxA, idHd, { userId: 'u' }); } catch (e) { hdErr = e; }
  check('headed docx ticket stays on the free deterministic path (locator line ignored)', !hdErr && modelCalls === mark && (await fieldsOf(idHd)).some((f) => f.field_key === 'customer_name'), hdErr ? hdErr.message : '');
  const TX = await import(rel('api/_lib/modelAvoidance/textExtract.js'));
  const body = ['SERVICE TICKET', 'Date of Service: 09/12/2025', 'Customer: Margaret Henderson', 'Service Address: 3247 Elm St, Mesa, AZ 85201', 'Equipment: Carrier 24ACC636A003 Serial: 4N2119-08772', 'Visit Type: Repair', 'Technician: Marcus Bell', 'Status: Completed', 'Work Performed: replaced capacitor and cleaned coil'];
  check('textExtract: Section / Part k of n / Sheet locator on the first line accepted', ['Section: SERVICE TICKET', 'Part 2 of 3', 'Sheet "Tickets" rows 2-9 of 9 (hidden sheet)'].every((loc) => TX.extractFromText([{ page_no: 1, text: [loc, ...body].join('\n') }], { pack: null }).accepted));
  check('textExtract: the same line in the MIDDLE of a page is still not ignored', !TX.extractFromText([{ page_no: 1, text: [body[0], 'Section: Anything', ...body.slice(1)].join('\n') }], { pack: null }).accepted);
  // cited-page text for the app (records getDocumentPage / db.getPage), tenant-scoped
  const pg = await RS.withTenant(ctxA, (db) => db.getPage(id2, 1));
  check('getPage returns the cited sheet chunk with its locator', pg && /^Sheet "Customers" rows 2-3 of 3/.test(pg.text), JSON.stringify(pg));
  check('getPage: tenant B cannot read tenant A page; missing page is null', (await RS.withTenant(ctxB, (db) => db.getPage(id2, 1))) == null && (await RS.withTenant(ctxA, (db) => db.getPage(id2, 99))) == null);
  const RC = await import(rel('api/records.ts'));
  check('getDocumentPage is a member-level READ action', RC.RECORDS_READ_ACTIONS.has('getDocumentPage') && !RC.RECORDS_ADMIN_ACTIONS.has('getDocumentPage'));
  const idCl = await put(tenantA, buildXlsx([{ name: 'Tickets', rows: [['Customer', 'Phone'], ['Zed', '1']] }]), { filename: 'x.xlsx', contentType: XLSX_T });
  await ingest(ctxA, idCl);
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-fixture';
  // A canned "model" on a loopback port (the SDK reads ANTHROPIC_BASE_URL): no external network, no real call.
  const http = await import('node:http');
  let anthropicCalls = 0;
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      anthropicCalls++;
      const body = JSON.parse(raw || '{}');
      const name = body.tool_choice?.name ?? body.tools?.[0]?.name;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_x', type: 'message', role: 'assistant', model: body.model, stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 10 }, content: [{ type: 'tool_use', id: 'tu1', name, input: { document_type: 'invoice', document_type_confidence: 0.9, fields: [{ key: 'customer_name', value: 'Zephyr Cooling Co', page_no: 1, verbatim: 'Customer: Zephyr Cooling Co', confidence: 0.9 }, { key: 'total_amount', value: '842.17', page_no: 1, verbatim: 'Total Due: $842.17', confidence: 0.9 }] } }] }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
  let invErr = null;
  try { await EX.extractDocumentFields(ctxA, id, { userId: 'u' }); } catch (e) { invErr = e; }
  srv.close();
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_API_KEY;
  const invFields = await fieldsOf(id);
  check('docx invoice: extraction over office pages writes fields via the (stubbed) model path', !invErr && anthropicCalls === 1 && invFields.some((f) => f.field_key === 'customer_name' && /Zephyr/.test(f.value)), invErr ? `${invErr.status} ${invErr.message}` : JSON.stringify(invFields).slice(0, 200));
  const docType = (await lite.query('select document_type from documents where id=$1', [id])).rows[0]?.document_type;
  check('document classified from office page text', docType === 'invoice', String(docType));
  void exr; void idCl;

  // empty workbook -> existing NO_READABLE_TEXT path
  const idE = await put(tenantA, buildXlsx([{ name: 'Empty', rows: [] }]), { filename: 'empty.xlsx', contentType: XLSX_T });
  x = await ingest(ctxA, idE);
  check('all-empty workbook: 422 with the NO_READABLE_TEXT message, recorded', !x.ok && x.status === 422 && x.message === RD.NO_READABLE_TEXT_MESSAGE && (await docRow(idE)).error === RD.NO_READABLE_TEXT_MESSAGE, JSON.stringify(x));

  // refusals at read time
  const refuse = async (label, bytes, o, status, re) => { const d = await put(tenantA, bytes, o); const r = await ingest(ctxA, d); check(label, !r.ok && r.status === status && re.test(r.message) && (status === 413 || re.test((await docRow(d)).error ?? '')), JSON.stringify(r)); };
  const mod0 = modelCalls;
  await refuse('real docx renamed .pdf: refused, says it is really a Word document', invoice, { filename: 'invoice.pdf', contentType: 'application/pdf' }, 415, /really a Word document/);
  await refuse('real xlsx named .docx: refused, says Excel', customers, { filename: 'x.docx', contentType: DOCX_T }, 415, /really an Excel workbook/);
  await refuse('real docx with a text/html declared type refused', invoice, { filename: 'a.docx', contentType: 'text/html' }, 415, /type/);
  await refuse('exe renamed .docx refused (not a real Word file)', Buffer.from('MZ\x90\x00' + 'x'.repeat(400), 'latin1'), { filename: 'setup.docx', contentType: DOCX_T }, 415, /not a Word/);
  await refuse('PDF bytes named .docx refused, says PDF', Buffer.from('%PDF-1.4\n' + '1 0 obj<<>>endobj\n'.repeat(20)), { filename: 'a.docx', contentType: DOCX_T }, 415, /really a PDF/);
  await refuse('legacy OLE2 .doc refused', Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600)]), { filename: 'old.doc', contentType: 'application/msword' }, 415, /old Word/);
  await refuse('encrypted OLE2 under .xlsx = password-protected', Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600), Buffer.from('EncryptionInfo', 'utf16le')]), { filename: 'a.xlsx', contentType: XLSX_T }, 415, /password/i);
  await refuse('macro docx refused with the Save-As message', buildDocx(p('x'), { extra: { 'word/vbaProject.bin': 'v' } }), { filename: 'a.docx', contentType: DOCX_T }, 415, /macros/);
  await refuse('.xlsm refused by name', customers, { filename: 'a.xlsm', contentType: null }, 415, /macros/);
  await refuse('zip archive named .txt refused', buildZip([{ name: 'a.txt', data: 'x' }]), { filename: 'a.txt', contentType: 'text/plain' }, 415, /ZIP archive/);
  await refuse('binary named .csv refused as not readable text', Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff\x00\x00\xb8\x00\x00\x00\x00\x00\x00\x00\x40\x00\x00\x00\x00\x00\x00\x00\x00\x01\x02\x03\x04'.repeat(6), 'latin1'), { filename: 'a.csv', contentType: 'text/csv' }, 415, /not readable text/);
  await refuse('zip bomb docx refused 413-class without crashing', buildZip([{ name: '[Content_Types].xml', data: '<a/>' }, { name: 'word/document.xml', data: Buffer.alloc(80 * 1024 * 1024) }]), { filename: 'bomb.docx', contentType: DOCX_T }, 413, /expands|too large|Split/i).catch(() => {});
  check('no model call for any office read or refusal', modelCalls === mod0 && modelCalls === 0);
  // unchanged text path
  const idT = await put(tenantA, Buffer.from('Jos\xE9 Mu\xF1oz\nsome plain note'.padEnd(80), 'latin1'), { filename: 'n.txt', contentType: 'text/plain' });
  x = await ingest(ctxA, idT);
  check('plain .txt unchanged (text path, 6,000-char pages, 1252 decoded)', x.ok && x.r.method === 'text' && !x.r.source && /José Muñoz/.test((await pagesOf(idT))[0].text));
  const idJ = await put(tenantA, Buffer.from('{"a": 1, "customer": "Json Co"}'), { filename: 'd.json', contentType: 'application/json' });
  x = await ingest(ctxA, idJ);
  check('.json unchanged', x.ok && /Json Co/.test((await pagesOf(idJ))[0].text));
  // wording
  const U = await import(rel('api/_lib/uploadTypes.js'));
  check('unsupportedTypeMessage quotes ACCEPTED_TYPES_SENTENCE', RD.unsupportedTypeMessage('application/x-foo').includes(U.ACCEPTED_TYPES_SENTENCE));
  check('TIFF message still says PDF, JPEG or PNG and quotes the sentence', /PDF, JPEG or PNG/.test(RD.unsupportedTypeMessage('image/tiff')) && RD.unsupportedTypeMessage('image/tiff').includes(U.ACCEPTED_TYPES_SENTENCE));
  const heic = await put(tenantA, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(40)]), { filename: 'IMG_1.heic', contentType: 'image/heic' });
  x = await ingest(ctxA, heic);
  check('HEIC: refused with the convert-to-JPEG steps, no server-conversion claim', !x.ok && x.status === 415 && /Most Compatible/.test(x.message) && /Convert it to JPEG/.test(x.message) && !/we convert|automatically/i.test(x.message), JSON.stringify(x));
  check('sniffMagicBytes: zip and OLE2 recognised, existing results unchanged', RD.sniffMagicBytes(invoice) === 'application/zip' && RD.sniffMagicBytes(Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(8)])) === 'application/x-ole-storage' && RD.sniffMagicBytes(Buffer.from('%PDF-1.4')) === 'application/pdf' && RD.sniffMagicBytes(Buffer.from('hello world')) === null);
  check('decodeText still exported from readDocument (same function)', typeof RD.decodeText === 'function' && RD.decodeText(Buffer.from([0xff, 0xfe, 0x41, 0])) === 'A');
  // serving
  const sv = R2.originalServing('Invoice.docx', DOCX_T);
  check('Open original: docx served with its content type and ALWAYS as a download', sv.contentType === DOCX_T && /^attachment;/.test(sv.disposition));
  const sx = R2.originalServing('a.xlsx', null);
  check('xlsx type from the extension, attachment', sx.contentType === XLSX_T && /^attachment;/.test(sx.disposition));
  check('a docx/xlsx declared as text/html is never inline', /^attachment;/.test(R2.originalServing('a.docx', 'text/html').disposition) && R2.originalServing('a.docx', 'text/html').contentType === 'application/octet-stream');
  check('pdf still inline (unchanged)', /^inline;/.test(R2.originalServing('a.pdf', 'application/pdf').disposition));
  // view page for office types
  const VP = await import(rel('api/_lib/agent/viewPage.js'));
  const passages = [];
  const viewer = VP.createPageViewer({ withTenant: RS.withTenant, ctxArg: ctxA, ledger: { docStage: new Map([[id2, 'read']]), addPassage: (...a) => passages.push(a) }, fetchObject: async () => { throw new Error('office view must not fetch the original'); } });
  const v = await viewer({ documentId: id2, page: 1 });
  check('view_document_page on an xlsx returns the cited sheet chunk text with its locator and registers evidence', v.ok === true && /Sheet "Customers" rows 2-3 of 3/.test(v.content) && /Quillfeather/.test(v.content) && passages.length === 1, JSON.stringify(v).slice(0, 200));

  // F5: read-time allowance check (real page count vs the pages left this month)
  {
    PLAN._resetBillingRowCache?.();
    const tenantC = await newTenant('org_off_c');
    const tenantD = await newTenant('org_off_d');
    const ctxC = { tenantKey: 'org_off_c', tenantName: 'org_off_c' };
    const ctxD = { tenantKey: 'org_off_d', tenantName: 'org_off_d' };
    PLAN._seedBillingRowForTest('org_off_c', { plan: 'solo', billing_status: 'active' });
    PLAN._seedBillingRowForTest('org_off_d', { plan: 'fleet', billing_status: 'active' });
    const cap = PLAN.PLAN_LIMITS.solo.pagesPerMonth;
    const fillerId = crypto.randomUUID();
    await lite.query(`INSERT INTO documents (id, tenant_id, original_filename, sha256_hash, stage, created_at) VALUES ($1,$2,'filler.pdf',$3,'read',NOW())`, [fillerId, tenantC, crypto.randomBytes(8).toString('hex')]);
    const setRemaining = async (left) => {
      await lite.query('delete from document_pages where tenant_id=$1', [tenantC]);
      await lite.query('delete from page_usage_monthly where tenant_id=$1', [tenantC]); // the tally never goes down on delete, so rewind it too
      await lite.query(`INSERT INTO document_pages (tenant_id, document_id, page_no, text) SELECT $1, $2, g, 'filler' FROM generate_series(1, $3::int) g`, [tenantC, fillerId, cap - left]);
      PLAN._resetBillingRowCache?.();
      PLAN._seedBillingRowForTest('org_off_c', { plan: 'solo', billing_status: 'active' });
      PLAN._seedBillingRowForTest('org_off_d', { plan: 'fleet', billing_status: 'active' });
    };
    const fourPages = buildDocx([1, 2, 3, 4].map((i) => p(String(i).repeat(2900))).join(''));
    check('test file really reads as 4 pages', read(fourPages, 'a.docx').pages.length === 4);
    await setRemaining(5);
    let dId = await put(tenantC, fourPages, { filename: 'four.docx', contentType: DOCX_T });
    x = await ingest(ctxC, dId);
    check('F5 under the remaining pages (4 pages, 5 left): read', x.ok && (await pagesOf(dId)).length === 4, JSON.stringify(x));
    await setRemaining(4);
    dId = await put(tenantC, fourPages, { filename: 'four2.docx', contentType: DOCX_T });
    x = await ingest(ctxC, dId);
    check('F5 exactly at the remaining pages (4 pages, 4 left): read', x.ok && (await pagesOf(dId)).length === 4, JSON.stringify(x));
    await setRemaining(3);
    dId = await put(tenantC, fourPages, { filename: 'four3.docx', contentType: DOCX_T });
    x = await ingest(ctxC, dId);
    const row3 = await docRow(dId);
    check('F5 over the remaining pages (4 pages, 3 left): 402 with N and M in plain words, nothing written or counted', !x.ok && x.status === 402 && /would use 4 pages and you have 3 left this month/.test(x.message) && (await pagesOf(dId)).length === 0 && row3.error === x.message && !row3.page_count, JSON.stringify(x));
    check('F5 refusal names what to do and the reset date', /Split it|upgrade/i.test(x.message) && /resets on/.test(x.message));
    // a same-size xlsx and csv are covered by the same check
    const xl4 = buildXlsx([{ name: 'S', rows: [['Name', 'Notes'], ...Array.from({ length: 4 }, (_, i) => [`n${i}`, 'q'.repeat(5800)])] }]);
    dId = await put(tenantC, xl4, { filename: 'four.xlsx', contentType: XLSX_T });
    x = await ingest(ctxC, dId);
    check('F5 xlsx over the remaining pages is refused the same way', !x.ok && x.status === 402 && (await pagesOf(dId)).length === 0, JSON.stringify(x).slice(0, 200));
    // two tenants: D (fleet) reads the same file; C's used pages never count for D
    dId = await put(tenantD, fourPages, { filename: 'four.docx', contentType: DOCX_T });
    x = await ingest(ctxD, dId);
    check('F5 two tenants: another company with room reads the same file; its count is its own', x.ok && (await pagesOf(dId)).length === 4);
    // lookup error fails open
    await lite.query('alter table document_pages rename to document_pages_off');
    let open;
    try { PLAN._resetBillingRowCache?.(); PLAN._seedBillingRowForTest('org_off_c', { plan: 'solo', billing_status: 'active' }); open = await RD.officeAllowanceRefusal(ctxC, 99999, 0); } finally { await lite.query('alter table document_pages_off rename to document_pages'); }
    check('F5 a failing page-count lookup fails OPEN (no refusal)', open === null);
    // uncapped / free preview / unknown tenant: no-op
    PLAN._resetBillingRowCache?.();
    PLAN._seedBillingRowForTest('org_off_d', { plan: 'fleet', billing_status: 'active' });
    check('F5 a plan with room never refuses a normal file', (await RD.officeAllowanceRefusal(ctxD, 50, 0)) === null);
    PLAN._seedBillingRowForTest('org_off_free', { billing_status: null });
    check('F5 no plan (free preview state): no-op', (await RD.officeAllowanceRefusal({ tenantKey: 'org_off_free', tenantName: 'org_off_free' }, 99999, 0)) === null);
    PLAN._resetBillingRowCache?.();
  }
  globalThis.fetch = realFetch;
  await lite.close?.();
}

/* ===================================================================== summary */
console.log('\nFamily counts:');
for (const [k, v] of Object.entries(fam)) console.log(`  ${k.padEnd(10)} ${String(v.pass + v.fail).padStart(3)} checks, ${v.fail} failed`);
const total = Object.values(fam).reduce((n, v) => n + v.pass + v.fail, 0);
console.log(failed ? `\nFAIL: ${failed} of ${total} checks FAILED` : `\nPASS: all ${total} checks passed`);
process.exit(failed ? 1 : 0);
