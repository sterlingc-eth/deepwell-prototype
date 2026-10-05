/**
 * Fixture-building toolbox: tiny hand-rolled zip / docx / xlsx / OLE2 / pdf writers (node + zlib only, no dependency),
 * a seeded PRNG and the fake Sonoran-style business data. Nothing here knows how DeepWell reads files (independence).
 */
import zlib from 'node:zlib';

/* ---------------------------------------------------------------- deterministic PRNG */
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  next.int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  return next;
}

/* ---------------------------------------------------------------- xml helpers */
export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const XMLDECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/* ---------------------------------------------------------------- zip writer */
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 15; // 2026-01-15 (fixed: deterministic bytes)
const DOS_TIME = 12 << 11;
/** entries: {name, data?:Buffer|string, store?:true} | {name, raw:Buffer(deflated), crc, usize} */
export function zip(entries, { truncateAt = null } = {}) {
  const parts = []; const cd = []; let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    let comp, crc, usize, method;
    if (e.raw) { comp = e.raw; crc = e.crc; usize = e.usize; method = 8; }
    else {
      const d = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '', 'utf8');
      crc = zlib.crc32(d); usize = d.length;
      if (e.store || d.length === 0) { comp = d; method = 0; } else { comp = zlib.deflateRawSync(d, { level: 9 }); method = 8; }
    }
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(DOS_TIME, 10); lh.writeUInt16LE(DOS_DATE, 12); lh.writeUInt32LE(crc >>> 0, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(usize, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(DOS_TIME, 12); ch.writeUInt16LE(DOS_DATE, 14); ch.writeUInt32LE(crc >>> 0, 16);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(usize, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    cd.push(ch, name);
    off += 30 + name.length + comp.length;
  }
  const cdBuf = Buffer.concat(cd);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length & 0xffff, 8); eocd.writeUInt16LE(entries.length & 0xffff, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(off, 16);
  const all = Buffer.concat([...parts, cdBuf, eocd]);
  return truncateAt ? all.subarray(0, truncateAt) : all;
}

/** A deflated entry that INFLATES to `total` bytes but is only ~1 KB per MB on disk (never writes the big thing). */
export async function bombEntry(name, { prefix = '', filler = ' ', total, suffix = '' }) {
  const d = zlib.createDeflateRaw({ level: 6 });
  const out = []; d.on('data', (c) => out.push(c));
  const ended = new Promise((r) => d.on('end', r));
  let crc = 0; let size = 0;
  const w = async (b) => { crc = zlib.crc32(b, crc); size += b.length; if (!d.write(b)) await new Promise((r) => d.once('drain', r)); };
  await w(Buffer.from(prefix));
  const chunk = Buffer.alloc(1 << 20, filler);
  let left = total;
  while (left > 0) { const n = Math.min(left, chunk.length); await w(n === chunk.length ? chunk : chunk.subarray(0, n)); left -= n; }
  await w(Buffer.from(suffix));
  d.end(); await ended;
  return { name, raw: Buffer.concat(out), crc, usize: size };
}

/* ---------------------------------------------------------------- docx writer */
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
/** run: string | {t, b, i, ins, del} */
const runXml = (r) => {
  if (typeof r === 'string') r = { t: r };
  const rpr = (r.b ? '<w:b/>' : '') + (r.i ? '<w:i/>' : '');
  const rp = rpr ? `<w:rPr>${rpr}</w:rPr>` : '';
  if (r.del) return `<w:del w:id="${r.id ?? 1}" w:author="J. Ortega" w:date="2026-02-03T10:00:00Z"><w:r>${rp}<w:delText xml:space="preserve">${esc(r.t)}</w:delText></w:r></w:del>`;
  const run = `<w:r>${rp}<w:t xml:space="preserve">${esc(r.t)}</w:t></w:r>`;
  if (r.ins) return `<w:ins w:id="${r.id ?? 2}" w:author="J. Ortega" w:date="2026-02-03T10:05:00Z">${run}</w:ins>`;
  return run;
};
export const P = (runs, { style, num, jc } = {}) => {
  const arr = Array.isArray(runs) ? runs : [runs];
  const ppr = (style ? `<w:pStyle w:val="${style}"/>` : '') + (num ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>` : '') + (jc ? `<w:jc w:val="${jc}"/>` : '');
  return `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${arr.map(runXml).join('')}</w:p>`;
};
/** rows: array of array of string | {t, span} ; first row bold when header */
export const TBL = (rows, { header = true } = {}) => {
  const ncols = Math.max(...rows.map((r) => r.reduce((n, c) => n + (c?.span ?? 1), 0)));
  const grid = '<w:tblGrid>' + Array.from({ length: ncols }, () => '<w:gridCol w:w="1800"/>').join('') + '</w:tblGrid>';
  const trs = rows.map((r, ri) => '<w:tr>' + r.map((c) => {
    const o = typeof c === 'object' && c ? c : { t: c };
    const tcpr = `<w:tcPr><w:tcW w:w="${1800 * (o.span ?? 1)}" w:type="dxa"/>${o.span ? `<w:gridSpan w:val="${o.span}"/>` : ''}</w:tcPr>`;
    return `<w:tc>${tcpr}${P({ t: String(o.t ?? ''), b: header && ri === 0 })}</w:tc>`;
  }).join('') + '</w:tr>').join('');
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr>${grid}${trs}</w:tbl>`;
};
export function docx({ body, header = null, footer = null, extra = [], contentTypesExtra = '', relsExtra = '', docRelsExtra = '', bodyPrefix = '', rawDocument = null }) {
  const doc = rawDocument ?? `${XMLDECL}<w:document ${W}><w:body>${bodyPrefix}${body.join('')}<w:sectPr>${header ? '<w:headerReference w:type="default" r:id="rId10"/>' : ''}${footer ? '<w:footerReference w:type="default" r:id="rId11"/>' : ''}<w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`;
  const ct = `${XMLDECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>${header ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : ''}${footer ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' : ''}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${contentTypesExtra}</Types>`;
  const rels = `${XMLDECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>${relsExtra}</Relationships>`;
  const docRels = `${XMLDECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>${header ? '<Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>' : ''}${footer ? '<Relationship Id="rId11" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>' : ''}${docRelsExtra}</Relationships>`;
  const styles = `${XMLDECL}<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="48"/></w:rPr></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style></w:styles>`;
  const numbering = `${XMLDECL}<w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
  const core = `${XMLDECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Fixture</dc:title><dc:creator>Front Office</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">2026-01-15T12:00:00Z</dcterms:created></cp:coreProperties>`;
  const app = `${XMLDECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Office Word</Application></Properties>`;
  const entries = [
    { name: '[Content_Types].xml', data: ct }, { name: '_rels/.rels', data: rels }, { name: 'word/document.xml', data: doc },
    { name: 'word/_rels/document.xml.rels', data: docRels }, { name: 'word/styles.xml', data: styles }, { name: 'word/numbering.xml', data: numbering },
    { name: 'docProps/core.xml', data: core }, { name: 'docProps/app.xml', data: app },
  ];
  if (header) entries.push({ name: 'word/header1.xml', data: `${XMLDECL}<w:hdr ${W}>${header.map((h) => P(h)).join('')}</w:hdr>` });
  if (footer) entries.push({ name: 'word/footer1.xml', data: `${XMLDECL}<w:ftr ${W}>${footer.map((h) => P(h)).join('')}</w:ftr>` });
  return { entries: [...entries, ...extra], doc };
}

/* ---------------------------------------------------------------- xlsx writer */
export const colName = (i) => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
export const serial = (iso) => Math.round((Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) - Date.UTC(1899, 11, 30)) / 86400000);
const FMT = { general: 0, date: 1, cur: 2, pct: 3, bold: 4, iso: 5, text: 6, pct0: 7, dmy: 8 };
/**
 * sheet: {name, state?, rows:[ [cell...] ], merges?:['A1:D1'], cols?:[widths]}
 * cell: null | string | number | {v, fmt, f}  fmt in FMT; date cells give v as ISO 'YYYY-MM-DD' and are stored as serials;
 * a string cell with fmt:'text' and numeric-looking content is stored as text (the classic "number stored as text").
 */
export function xlsx(sheets, { definedNames = '', extra = [], contentTypesExtra = '', wbRelsExtra = '', macroCt = false, sstOverride = null } = {}) {
  const sst = []; const sstIdx = new Map();
  const si = (s) => { let i = sstIdx.get(s); if (i == null) { i = sst.length; sst.push(s); sstIdx.set(s, i); } return i; };
  const sheetXml = sheets.map((sh) => {
    const rowsXml = [];
    sh.rows.forEach((row, ri) => {
      if (!row || !row.length) return;
      const cs = [];
      row.forEach((c, ci) => {
        if (c == null) return;
        const ref = `${colName(ci)}${ri + 1}`;
        const o = typeof c === 'object' ? c : { v: c };
        const fmt = o.fmt ?? 'general';
        const s = FMT[fmt] ? ` s="${FMT[fmt]}"` : '';
        const f = o.f ? `<f>${esc(o.f)}</f>` : '';
        if (fmt === 'date' || fmt === 'iso' || fmt === 'dmy') cs.push(`<c r="${ref}"${s}>${f}<v>${typeof o.v === 'number' ? o.v : serial(o.v)}</v></c>`);
        else if (typeof o.v === 'number') cs.push(`<c r="${ref}"${s}>${f}<v>${o.v}</v></c>`);
        else if (o.f) cs.push(`<c r="${ref}"${s} t="str">${f}<v>${esc(o.v)}</v></c>`);
        else cs.push(`<c r="${ref}"${s} t="s"><v>${si(String(o.v))}</v></c>`);
      });
      if (cs.length) rowsXml.push(`<row r="${ri + 1}">${cs.join('')}</row>`);
    });
    const cols = sh.cols ? '<cols>' + sh.cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>' : '';
    const merges = sh.merges?.length ? `<mergeCells count="${sh.merges.length}">${sh.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
    return `${XMLDECL}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${cols}<sheetData>${rowsXml.join('')}</sheetData>${merges}</worksheet>`;
  });
  const wb = `${XMLDECL}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ''} r:id="rId${i + 1}"/>`).join('')}</sheets>${definedNames}</workbook>`;
  const n = sheets.length;
  const wbRels = `${XMLDECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId${n + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>${wbRelsExtra}</Relationships>`;
  const ct = `${XMLDECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${macroCt ? 'application/vnd.ms-excel.sheet.macroEnabled.main+xml' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'}"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>${contentTypesExtra}</Types>`;
  const rels = `${XMLDECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const styles = `${XMLDECL}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/><numFmt numFmtId="165" formatCode="yyyy\\-mm\\-dd"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="9"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="15" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`;
  const sstXml = sstOverride ?? `${XMLDECL}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sst.length}" uniqueCount="${sst.length}">${sst.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`;
  return [
    { name: '[Content_Types].xml', data: ct }, { name: '_rels/.rels', data: rels }, { name: 'xl/workbook.xml', data: wb },
    { name: 'xl/_rels/workbook.xml.rels', data: wbRels }, { name: 'xl/styles.xml', data: styles }, { name: 'xl/sharedStrings.xml', data: sstXml },
    ...sheetXml.map((x, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: x })), ...extra,
  ];
}

/* ---------------------------------------------------------------- OLE2 (compound file) minimal writer */
/** streams: [{name, size}] each stream >= 4096 bytes so no mini-stream is needed; content is filler plus an optional lead. */
export function ole2(streams) {
  const SS = 512; const END = 0xfffffffe; const FATSECT = 0xfffffffd; const FREE = 0xffffffff;
  const secsFor = (n) => Math.ceil(Math.max(n, 4096) / SS);
  let next = 2; const alloc = streams.map((s) => { const n = secsFor(s.size ?? 4096); const start = next; next += n; return { ...s, n, start, size: Math.max(s.size ?? 4096, 4096) }; });
  const totalSecs = next;
  const fat = Buffer.alloc(SS, 0xff); // one FAT sector: up to 128 sectors (enough: callers keep streams small)
  if (totalSecs > 128) throw new Error('ole2: too big for one FAT sector');
  fat.writeUInt32LE(FATSECT, 0); fat.writeUInt32LE(END, 4);
  for (const a of alloc) for (let i = 0; i < a.n; i++) fat.writeUInt32LE(i === a.n - 1 ? END : a.start + i + 1, (a.start + i) * 4);
  const dir = Buffer.alloc(SS);
  const entry = (idx, name, type, left, right, child, start, size) => {
    const o = idx * 128; const nm = Buffer.from(name + '\0', 'utf16le');
    nm.copy(dir, o); dir.writeUInt16LE(nm.length, o + 64); dir[o + 66] = type; dir[o + 67] = 1;
    dir.writeUInt32LE(left, o + 68); dir.writeUInt32LE(right, o + 72); dir.writeUInt32LE(child, o + 76);
    dir.writeUInt32LE(start, o + 116); dir.writeUInt32LE(size, o + 120);
  };
  for (let i = 0; i < 4; i++) { const o = i * 128; dir.writeUInt32LE(FREE, o + 68); dir.writeUInt32LE(FREE, o + 72); dir.writeUInt32LE(FREE, o + 76); }
  entry(0, 'Root Entry', 5, FREE, FREE, alloc.length ? 1 : FREE, END, 0);
  alloc.slice(0, 3).forEach((a, i) => entry(i + 1, a.name, 2, FREE, i + 1 < alloc.length && i < 2 ? i + 2 : FREE, FREE, a.start, a.size));
  const hdr = Buffer.alloc(SS);
  Buffer.from('D0CF11E0A1B11AE1', 'hex').copy(hdr, 0); hdr.writeUInt16LE(0x3e, 24); hdr.writeUInt16LE(3, 26); hdr.writeUInt16LE(0xfffe, 28);
  hdr.writeUInt16LE(9, 30); hdr.writeUInt16LE(6, 32); hdr.writeUInt32LE(1, 44); hdr.writeUInt32LE(1, 48); hdr.writeUInt32LE(4096, 56);
  hdr.writeUInt32LE(END, 60); hdr.writeUInt32LE(END, 68); hdr.writeUInt32LE(0, 76); for (let i = 1; i < 109; i++) hdr.writeUInt32LE(FREE, 76 + i * 4);
  const bodies = alloc.map((a) => { const b = Buffer.alloc(a.n * SS); if (a.lead) Buffer.from(a.lead, 'latin1').copy(b, 0); return b; });
  return Buffer.concat([hdr, fat, dir, ...bodies]);
}

/* ---------------------------------------------------------------- pdf (text layer) */
export function pdf(pagesOfLines) {
  const e = (s) => String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'];
  const kids = [];
  for (const lines of pagesOfLines) {
    const ops = ['BT', '/F1 11 Tf', '13 TL', '50 760 Td', ...lines.flatMap((l) => [`(${e(l)}) Tj`, 'T*']), 'ET'].join('\n');
    const data = Buffer.from(ops, 'latin1');
    objs.push({ stream: data, dict: `<< /Length ${data.length} >>` });
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objs.length} 0 R >>`);
    kids.push(`${objs.length} 0 R`);
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;
  let out = Buffer.from('%PDF-1.4\n'); const offs = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    const body = typeof o === 'string' ? Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1') : Buffer.concat([Buffer.from(`${i + 1} 0 obj\n${o.dict}\nstream\n`), o.stream, Buffer.from('\nendstream\nendobj\n')]);
    out = Buffer.concat([out, body]);
  });
  const xref = out.length;
  const tail = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.concat([out, Buffer.from(tail)]);
}

/* ---------------------------------------------------------------- fake business data (no real people, no real emails) */
export const BIZ = {
  hvac: { name: 'Saguaro Air & Heating', lic: 'ROC 298114', phone: '(480) 555-0142', addr: '1840 W Baseline Rd, Mesa, AZ 85202' },
  plumb: { name: 'Ironwood Plumbing Co.', lic: 'ROC 301772', phone: '(602) 555-0177', addr: '922 N 7th Ave, Phoenix, AZ 85007' },
  elec: { name: 'Palo Verde Electric', lic: 'ROC 287456', phone: '(520) 555-0133', addr: '455 E Speedway Blvd, Tucson, AZ 85705' },
  prop: { name: 'Mesquite Property Services', lic: 'ROC 310245', phone: '(480) 555-0108', addr: '77 S Gilbert Rd, Gilbert, AZ 85296' },
};
const FIRST = ['Rosalind', 'Mateo', 'Priya', 'Dwayne', 'Lucinda', 'Tomas', 'Hattie', 'Ignacio', 'Beverly', 'Kenji', 'Marisol', 'Gordon', 'Imelda', 'Russell', 'Tamsin', 'Alonzo', 'Delphine', 'Wendell', 'Corinne', 'Hector', 'Odette', 'Leland', 'Yolanda', 'Barnaby', 'Noelle', 'Cecil', 'Paloma', 'Duncan', 'Ingrid', 'Rafael'];
const LAST = ['Tavares', 'Okonkwo', 'Whitcombe', 'Delgado', 'Fairbanks', 'Nakamura', 'Quintero', 'Abernathy', 'Villanueva', 'Pemberton', 'Castellanos', 'Holloway', 'Ibarra', 'Lindqvist', 'Montoya', 'Ostrander', 'Prescott', 'Ramanathan', 'Sandoval', 'Thibodeaux', 'Underhill', 'Vasquez', 'Wetherby', 'Yazzie', 'Zamora', 'Ballard', 'Cordero', 'Dunleavy', 'Escobedo', 'Fontaine'];
const BIZC = ['Cactus Flats Apartments LLC', 'Desert Bloom Dental', 'Acme Heating Supply', 'Copper Canyon Diner', 'Red Rock Self Storage', 'Sunrise Montessori', 'Agave Ridge HOA', 'Palm Court Motel', 'Blue Mesa Pharmacy', 'Ocotillo Chiropractic'];
const STREETS = ['W Baseline Rd', 'E Southern Ave', 'N Alma School Rd', 'S McClintock Dr', 'W Elliot Rd', 'E Warner Rd', 'N Scottsdale Rd', 'W Camelback Rd', 'E Broadway Rd', 'S Val Vista Dr', 'W Thomas Rd', 'N Higley Rd', 'E Ray Rd', 'W Peoria Ave', 'S Rural Rd'];
const CITIES = [['Mesa', '852'], ['Tempe', '852'], ['Chandler', '852'], ['Gilbert', '852'], ['Scottsdale', '852'], ['Phoenix', '850'], ['Peoria', '853'], ['Glendale', '853'], ['Queen Creek', '851'], ['Tucson', '857']];
export function makeCustomers(n, seed = 7) {
  const r = rng(seed); const seen = new Set(); const phones = new Set(); const out = [];
  for (let i = 0; out.length < n; i++) {
    const biz = i < BIZC.length && i % 3 === 0 ? BIZC[i] : null;
    const name = biz ?? `${r.pick(FIRST)} ${r.pick(LAST)}`;
    const lastKey = name.split(' ').pop();
    if (seen.has(name) || (!biz && [...seen].some((s) => s.endsWith(' ' + lastKey) && out.length < 30))) { if (i > 5000) break; continue; }
    seen.add(name);
    let phone; do { phone = `(${r.pick(['480', '602', '623', '520'])}) 555-01${String(r.int(0, 99)).padStart(2, '0')}`; } while (phones.has(phone)); phones.add(phone);
    const [city, z] = r.pick(CITIES);
    out.push({ id: `C-${1001 + out.length}`, name, phone, addr: `${r.int(100, 9899)} ${r.pick(STREETS)}`, city, zip: `${z}${r.int(0, 99).toString().padStart(2, '0')}`, since: `20${r.int(12, 25)}-${String(r.int(1, 12)).padStart(2, '0')}-${String(r.int(1, 28)).padStart(2, '0')}`, plan: r.pick(['None', 'Silver', 'Gold', 'Gold', 'Platinum']) });
  }
  return out;
}
export const TECHS = ['Marcus Bell', 'Angela Ruiz', 'Dale Whitfield', 'Sofia Brandt', 'Terrance Oyelaran'];
export const money = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const moneyVariants = (n) => { const m = money(n); return [m, m.slice(1), n.toFixed(2), String(n)]; };
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const dateVariants = (iso) => { const y = +iso.slice(0, 4); const m = +iso.slice(5, 7); const d = +iso.slice(8, 10); const mm = String(m).padStart(2, '0'); const dd = String(d).padStart(2, '0'); return [iso, `${m}/${d}/${y}`, `${mm}/${dd}/${y}`, `${d}-${MON[m - 1].slice(0, 3)}-${String(y).slice(2)}`, `${d}-${MON[m - 1].slice(0, 3)}-${y}`, `${MON[m - 1].slice(0, 3)} ${d}, ${y}`, `${MON[m - 1]} ${d}, ${y}`]; };
export const addDays = (iso, n) => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + n)).toISOString().slice(0, 10);
export const mdy = (iso) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
export const PARTS = ['Capacitor', 'Contactor', 'Condenser Fan Motor', 'Blower Motor', 'Thermostat', 'Filter Drier', 'TXV Valve', 'Evaporator Coil', 'Float Switch', 'Igniter', 'Flame Sensor', 'Gas Valve', 'Inducer Motor', 'Pressure Switch', 'Run Capacitor', 'Transformer', 'Relay', 'Circuit Board', 'Refrigerant Line Set', 'Condensate Pump', 'Faucet Cartridge', 'Angle Stop', 'P-Trap', 'Wax Ring', 'Water Heater Element', 'Expansion Tank', 'PRV Valve', 'Hose Bib', 'GFCI Outlet', 'Breaker 20A', 'Breaker 30A', 'Wire 12/2', 'Wire 10/3', 'Junction Box', 'Service Panel', 'Ceiling Fan Kit'];
export const BRANDS = ['Carrier', 'Trane', 'Lennox', 'Rheem', 'Goodman', 'Bradford', 'Square D', 'Eaton', 'Moen', 'Delta'];
