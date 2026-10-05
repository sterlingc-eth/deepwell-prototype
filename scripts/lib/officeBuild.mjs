/**
 * In-memory builders for the office reader tests: a ZIP writer (with knobs to lie about sizes/offsets), and minimal valid
 * .docx / .xlsx packages. Nothing here touches a filesystem. Owned by the readers' verify script.
 */
import zlib from 'node:zlib';

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

/**
 * entries: [{name, data: Buffer|string, store?: bool, flags?, method?, crc?, csize?, usize?, localName?, dir?: bool, lho?}]
 * opts: {comment, cdOffsetDelta, total, zip64Locator, cdSizeDelta}
 */
export function buildZip(entries, opts = {}) {
  const chunks = [];
  const central = [];
  let off = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '', 'utf8');
    const method = e.method ?? (e.store ? 0 : 8);
    const comp = e.rawComp ?? (method === 0 ? data : zlib.deflateRawSync(data, { level: 6 }));
    const crc = e.crc ?? zlib.crc32(data);
    const csize = e.csize ?? comp.length;
    const usize = e.usize ?? data.length;
    const flags = e.flags ?? 0x800;
    const lname = e.localName ? Buffer.from(e.localName) : nameBuf;
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(flags), u16(method), u16(0), u16(0x21), u32(crc), u32(csize), u32(usize), u16(lname.length), u16(0), lname]);
    const lho = e.lho ?? off;
    chunks.push(local, comp);
    central.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(flags), u16(method), u16(0), u16(0x21), u32(crc), u32(csize), u32(usize), u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0), u32(e.dir ? 0x10 : 0), u32(lho), nameBuf]));
    off += local.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const cdStart = off + (opts.cdOffsetDelta ?? 0);
  const comment = Buffer.from(opts.comment ?? '');
  const eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(opts.total ?? entries.length), u16(opts.total ?? entries.length), u32(cd.length + (opts.cdSizeDelta ?? 0)), u32(opts.cdOffset ?? cdStart), u16(comment.length), comment]);
  const loc = opts.zip64Locator ? Buffer.concat([u32(0x07064b50), u32(0), Buffer.alloc(8), u32(1)]) : Buffer.alloc(0);
  return Buffer.concat([...chunks, cd, loc, eocd]);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const CT_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const CT_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';

/** Word body helpers. */
export const p = (text, { style, list, ilvl = 0 } = {}) =>
  `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${list ? `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="1"/></w:numPr>` : ''}</w:pPr><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
export const h = (text, n = 1) => p(text, { style: `Heading${n}` });
export const tc = (inner, { span, vmerge } = {}) => `<w:tc><w:tcPr>${span ? `<w:gridSpan w:val="${span}"/>` : ''}${vmerge === 'restart' ? '<w:vMerge w:val="restart"/>' : vmerge ? '<w:vMerge/>' : ''}</w:tcPr>${inner}</w:tc>`;
export const tr = (...cells) => `<w:tr>${cells.join('')}</w:tr>`;
export const tbl = (...rows) => `<w:tbl><w:tblPr/>${rows.join('')}</w:tbl>`;
export const cell = (text, o) => tc(p(text), o);

export function docxParts({ body, extra = {}, rels = '', styles, contentTypesExtra = '', ct = CT_DOCX, withStyles = true }) {
  const stylesXml = styles ?? `${XML}<w:styles ${W}>${[1, 2, 3].map((n) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/></w:style>`).join('')}<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style></w:styles>`;
  const parts = [
    { name: '[Content_Types].xml', data: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="${ct}"/>${contentTypesExtra}</Types>` },
    { name: '_rels/.rels', data: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: 'word/document.xml', data: `${XML}<w:document ${W}><w:body>${body}</w:body></w:document>` },
    { name: 'word/_rels/document.xml.rels', data: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${withStyles ? '<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' : ''}${rels}</Relationships>` },
  ];
  if (withStyles) parts.push({ name: 'word/styles.xml', data: stylesXml });
  for (const [name, data] of Object.entries(extra)) parts.push({ name, data });
  return parts;
}
export const buildDocx = (body, opts = {}) => buildZip(docxParts({ body, ...opts }));
export const partXml = (root, inner) => `${XML}<w:${root} ${W}>${inner}</w:${root}>`;

/** Excel. sheets: [{name, state, xml (full <worksheet>), rows:[[cell,...]]}] with cell = string|number|{t,v,s,f,is}|null */
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
export const colName = (c) => { let s = ''; let n = c + 1; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };

/** rows: array of arrays. strings go to sharedStrings; numbers are numbers; {raw:'<c .../>'} passes through; {s:n, v:num} styled number. */
export function sheetXml(rows, { merges = [], rowStart = 1, extra = '' } = {}, sst) {
  let out = `${XML}<worksheet ${NS}><sheetData>`;
  rows.forEach((row, ri) => {
    if (row == null) return;
    const rn = rowStart + ri;
    out += `<row r="${rn}">`;
    row.forEach((c, ci) => {
      if (c == null || c === '') return;
      const ref = `${colName(ci)}${rn}`;
      if (typeof c === 'string') out += `<c r="${ref}" t="s"><v>${sst.add(c)}</v></c>`;
      else if (typeof c === 'number') out += `<c r="${ref}"><v>${c}</v></c>`;
      else if (typeof c === 'boolean') out += `<c r="${ref}" t="b"><v>${c ? 1 : 0}</v></c>`;
      else if (c.raw) out += c.raw.replace('{ref}', ref);
      else if (c.is !== undefined) out += `<c r="${ref}" t="inlineStr"><is><t>${esc(c.is)}</t></is></c>`;
      else if (c.f !== undefined) out += `<c r="${ref}"${c.t ? ` t="${c.t}"` : ''}${c.s ? ` s="${c.s}"` : ''}><f>${esc(c.f)}</f>${c.v !== undefined ? `<v>${esc(c.v)}</v>` : ''}</c>`;
      else out += `<c r="${ref}"${c.t ? ` t="${c.t}"` : ''}${c.s !== undefined ? ` s="${c.s}"` : ''}><v>${esc(c.v)}</v></c>`;
    });
    out += '</row>';
  });
  out += '</sheetData>';
  if (merges.length) out += `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`;
  out += `${extra}</worksheet>`;
  return out;
}

export const defaultStyles = ({ numFmts = {}, xfs = [0] } = {}) =>
  `${XML}<styleSheet ${NS}>${Object.keys(numFmts).length ? `<numFmts count="${Object.keys(numFmts).length}">${Object.entries(numFmts).map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${esc(code).replace(/"/g, '&quot;')}"/>`).join('')}</numFmts>` : ''}<cellXfs count="${xfs.length}">${xfs.map((id) => `<xf numFmtId="${id}"/>`).join('')}</cellXfs></styleSheet>`;

export function buildXlsx(sheets, { date1904 = false, styles, extraParts = [], contentTypesExtra = '', sstRich = null, workbookExtra = '' } = {}) {
  const strings = [];
  const index = new Map();
  const sst = { add(s) { if (!index.has(s)) { index.set(s, strings.length); strings.push(s); } return index.get(s); } };
  const sheetFiles = sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: s.xml ?? sheetXml(s.rows ?? [], s, sst) }));
  const sstXml = `${XML}<sst ${NS} count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => (sstRich && sstRich[s]) ? sstRich[s] : `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`;
  const wb = `${XML}<workbook ${NS}><workbookPr${date1904 ? ' date1904="1"' : ''}/><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name).replace(/"/g, '&quot;')}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ''} r:id="rId${i + 1}"/>`).join('')}</sheets>${workbookExtra}</workbook>`;
  const rels = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rIdSS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rIdST" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const ct = `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="${CT_XLSX}"/>${contentTypesExtra}</Types>`;
  return buildZip([
    { name: '[Content_Types].xml', data: ct },
    { name: '_rels/.rels', data: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: wb },
    { name: 'xl/_rels/workbook.xml.rels', data: rels },
    { name: 'xl/sharedStrings.xml', data: sstXml },
    { name: 'xl/styles.xml', data: styles ?? defaultStyles() },
    ...sheetFiles,
    ...extraParts,
  ]);
}
