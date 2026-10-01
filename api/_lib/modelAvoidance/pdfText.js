/**
 * R32 (Team M, model avoidance): a dependency-free reader for the TEXT LAYER of a born-digital PDF.
 *
 * WHY: a PDF a shop exports from its own software (an invoice from QuickBooks, a warranty registration
 * printed to PDF, a service ticket from the dispatch app) already CONTAINS its text. Sending those bytes to a
 * vision model to "read" them (readDocument.js -> callTranscribe) pays ~$0.004/page to recover characters
 * that are sitting in the file. This module recovers them for free, in-process, in single-digit milliseconds.
 *
 * WHAT IT IS NOT: an OCR engine. A scanned page (an image, with or without an invisible OCR text overlay) has
 * no trustworthy text layer, so every path that is not clearly "real text drawn by the producer" returns
 * `{ ok: false, reason }` and the caller sends the file to the model exactly as before. The gates are
 * deliberately conservative — a false "ok" would ship a wrong transcription, a false "not ok" only costs one
 * model call that would have been made anyway:
 *   - encrypted files, unparseable structure, unknown stream filters
 *   - any font whose codes cannot be mapped to Unicode (no ToUnicode CMap and no readable encoding)
 *   - invisible text (render mode 3 = the OCR overlay of a scan), rotated text (watermarks/stamps carry meaning)
 *   - a large raster image on a page (the model would read that image; we cannot)
 *   - a text layer that looks garbled (mojibake, spaced-out letters, no vowels)
 *   - pages with an image and almost no text
 *
 * How: scan the whole file for `N G obj` (robust to broken xref tables and incremental updates: the last copy
 * of an object wins), inflate streams with zlib, unpack object streams, walk the page tree, interpret the
 * text-showing operators of each content stream with the CTM/text matrix so runs can be put in reading order,
 * decode bytes through each font's ToUnicode CMap / Encoding, then rebuild lines from run positions.
 *
 * Pure: bytes in, {ok, pages[], stats} out. Never throws (a bug here degrades to the model path).
 */
import { inflateSync } from "node:zlib";

const MAX_INFLATE = 24 * 1024 * 1024;
const MAX_OBJECTS = 200_000;
const MAX_PAGES = 200;
const MAX_XOBJECT_DEPTH = 4;
const DEFAULT_BUDGET_MS = 6000;

/* ------------------------------------------------------------------ Helvetica widths (1/1000 em) */
// Only used to estimate where a run ENDS so a gap to the next run can be judged; exactness is not needed.
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722,
  667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556,
  333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
function helvWidth(ch) {
  const c = ch.charCodeAt(0);
  return c >= 32 && c <= 126 ? HELV[c - 32] : 556;
}

/* ------------------------------------------------------------------ glyph names -> unicode (subset) */
const GLYPH = {
  space: " ", exclam: "!", quotedbl: '"', numbersign: "#", dollar: "$", percent: "%", ampersand: "&", quotesingle: "'",
  quoteright: "'", quoteleft: "`", parenleft: "(", parenright: ")", asterisk: "*", plus: "+", comma: ",", hyphen: "-",
  minus: "-", period: ".", slash: "/", colon: ":", semicolon: ";", less: "<", equal: "=", greater: ">", question: "?",
  at: "@", bracketleft: "[", backslash: "\\", bracketright: "]", asciicircum: "^", underscore: "_", grave: "`",
  braceleft: "{", bar: "|", braceright: "}", asciitilde: "~", bullet: "•", endash: "–", emdash: "—",
  degree: "°", fi: "fi", fl: "fl", ff: "ff", ffi: "ffi", ffl: "ffl", quotedblleft: '"', quotedblright: '"',
  nbspace: " ", nonbreakingspace: " ", copyright: "©", registered: "®", trademark: "™",
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9",
  ampersand_: "&", cent: "¢", sterling: "£", yen: "¥", section: "§", multiply: "×", divide: "÷",
  plusminus: "±", onehalf: "½", onequarter: "¼", threequarters: "¾", periodcentered: "·",
  ellipsis: "…", fraction: "/", acute: "'", dieresis: "¨", Euro: "€", mu: "µ",
};
function glyphToUnicode(name) {
  if (!name) return null;
  if (GLYPH[name] !== undefined) return GLYPH[name];
  if (/^[A-Za-z]$/.test(name)) return name;
  let m = /^uni([0-9A-Fa-f]{4})$/.exec(name);
  if (m) return String.fromCharCode(parseInt(m[1], 16));
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) return String.fromCodePoint(parseInt(m[1], 16));
  // accented latin: Aacute, eacute, ntilde, ...
  const acc = /^([A-Za-z])(acute|grave|circumflex|tilde|dieresis|ring|cedilla|caron|macron)$/.exec(name);
  if (acc) return acc[1].normalize("NFC");
  return null;
}

/* ------------------------------------------------------------------ base encodings */
function buildByteTable(label) {
  const t = new Array(256);
  try {
    const dec = new TextDecoder(label);
    for (let i = 0; i < 256; i++) t[i] = dec.decode(Uint8Array.of(i));
  } catch {
    for (let i = 0; i < 256; i++) t[i] = String.fromCharCode(i);
  }
  for (let i = 0; i < 32; i++) t[i] = i === 9 || i === 10 || i === 13 ? " " : "";
  return t;
}
let WIN, MAC, STD;
function baseTable(name) {
  if (name === "WinAnsiEncoding") return (WIN ??= buildByteTable("windows-1252"));
  if (name === "MacRomanEncoding") return (MAC ??= buildByteTable("macintosh"));
  if (!STD) {
    STD = buildByteTable("windows-1252");
    STD[0x27] = "'"; STD[0x60] = "`"; // StandardEncoding quoteright/quoteleft, normalised to ASCII
    for (let i = 0x80; i < 0x100; i++) STD[i] = ""; // StandardEncoding has different high glyphs: treat as unmapped
    STD[0xb0] = "";
  }
  return STD;
}

/* ------------------------------------------------------------------ PDF object parser */
const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set(["(", ")", "<", ">", "[", "]", "{", "}", "/", "%"]);
const isWs = (c) => WS.has(c);

class Cursor {
  constructor(s, i = 0) { this.s = s; this.i = i; }
}
function skipWs(cur) {
  const s = cur.s;
  for (;;) {
    while (cur.i < s.length && isWs(s.charCodeAt(cur.i))) cur.i++;
    if (s[cur.i] === "%") { while (cur.i < s.length && s[cur.i] !== "\n" && s[cur.i] !== "\r") cur.i++; continue; }
    break;
  }
}

function readLiteralString(cur) {
  const s = cur.s;
  let depth = 1; cur.i++;
  let out = "";
  while (cur.i < s.length && depth > 0) {
    const ch = s[cur.i++];
    if (ch === "\\") {
      const n = s[cur.i++];
      if (n === "n") out += "\n"; else if (n === "r") out += "\r"; else if (n === "t") out += "\t";
      else if (n === "b") out += "\b"; else if (n === "f") out += "\f";
      else if (n === "\r") { if (s[cur.i] === "\n") cur.i++; }
      else if (n === "\n") { /* line continuation */ }
      else if (n >= "0" && n <= "7") {
        let oct = n;
        for (let k = 0; k < 2 && s[cur.i] >= "0" && s[cur.i] <= "7"; k++) oct += s[cur.i++];
        out += String.fromCharCode(parseInt(oct, 8) & 0xff);
      } else out += n ?? "";
    } else if (ch === "(") { depth++; out += ch; }
    else if (ch === ")") { depth--; if (depth > 0) out += ch; }
    else out += ch;
  }
  return { s: out };
}

function readHexString(cur) {
  const s = cur.s;
  cur.i++;
  let hex = "";
  while (cur.i < s.length && s[cur.i] !== ">") { const ch = s[cur.i++]; if (/[0-9a-fA-F]/.test(ch)) hex += ch; }
  cur.i++;
  if (hex.length % 2) hex += "0";
  let out = "";
  for (let k = 0; k < hex.length; k += 2) out += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16));
  return { s: out };
}

/** Parses one PDF value. Names are strings starting "/", refs {r:n}, strings {s}, keywords {k}. */
function parseValue(cur, depth = 0) {
  if (depth > 40) throw new Error("nesting");
  skipWs(cur);
  const s = cur.s;
  const c = s[cur.i];
  if (c === undefined) return undefined;
  if (c === "<" && s[cur.i + 1] === "<") {
    cur.i += 2;
    const d = {};
    for (;;) {
      skipWs(cur);
      if (s[cur.i] === ">" && s[cur.i + 1] === ">") { cur.i += 2; break; }
      if (cur.i >= s.length) break;
      const key = parseValue(cur, depth + 1);
      if (typeof key !== "string" || key[0] !== "/") { if (key === undefined) break; continue; }
      const val = parseValue(cur, depth + 1);
      d[key.slice(1)] = val;
    }
    return d;
  }
  if (c === "<") return readHexString(cur);
  if (c === "(") return readLiteralString(cur);
  if (c === "[") {
    cur.i++;
    const a = [];
    for (;;) {
      skipWs(cur);
      if (s[cur.i] === "]") { cur.i++; break; }
      if (cur.i >= s.length) break;
      const v = parseValue(cur, depth + 1);
      if (v === undefined) break;
      a.push(v);
    }
    return a;
  }
  if (c === "/") {
    let j = cur.i + 1;
    while (j < s.length && !isWs(s.charCodeAt(j)) && !DELIM.has(s[j])) j++;
    const name = s.slice(cur.i, j).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    cur.i = j;
    return name;
  }
  if (c === ")" || c === ">" || c === "]" || c === "}" || c === "{") { cur.i++; return { k: c }; }
  // number, ref or keyword
  let j = cur.i;
  while (j < s.length && !isWs(s.charCodeAt(j)) && !DELIM.has(s[j])) j++;
  const tok = s.slice(cur.i, j);
  cur.i = j;
  if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) {
    if (/^\d+$/.test(tok)) {
      const save = cur.i;
      const m = /^\s+(\d+)\s+R(?![A-Za-z0-9])/.exec(s.slice(cur.i, cur.i + 24));
      if (m) { cur.i += m[0].length; return { r: Number(tok) }; }
      cur.i = save;
    }
    return Number(tok);
  }
  return { k: tok };
}

/* ------------------------------------------------------------------ file scan */
function decodeFilters(dict, raw, deadline) {
  let filters = dict.Filter;
  let parms = dict.DecodeParms ?? dict.DP;
  if (filters === undefined) return { data: raw, ok: true, image: false };
  if (!Array.isArray(filters)) { filters = [filters]; parms = [parms]; }
  else if (!Array.isArray(parms)) parms = filters.map(() => parms);
  let data = raw;
  for (let i = 0; i < filters.length; i++) {
    const f = filters[i];
    const p = parms?.[i] && typeof parms[i] === "object" ? parms[i] : {};
    if (f === "/FlateDecode" || f === "/Fl") {
      try { data = inflateSync(data, { maxOutputLength: MAX_INFLATE }); } catch {
        try { data = inflateSync(data, { maxOutputLength: MAX_INFLATE, finishFlush: 2 }); } catch { return { ok: false }; }
      }
      const pred = Number(p.Predictor ?? 1);
      if (pred >= 10) data = pngUnpredict(data, Number(p.Columns ?? 1), Number(p.Colors ?? 1) * Math.ceil(Number(p.BitsPerComponent ?? 8) / 8));
      else if (pred === 2) return { ok: false };
    } else if (f === "/ASCIIHexDecode" || f === "/AHx") {
      const hex = data.toString("latin1").replace(/[^0-9a-fA-F]/g, "");
      data = Buffer.from(hex.length % 2 ? hex + "0" : hex, "hex");
    } else if (f === "/ASCII85Decode" || f === "/A85") {
      data = ascii85(data.toString("latin1"));
    } else if (f === "/DCTDecode" || f === "/JPXDecode" || f === "/CCITTFaxDecode" || f === "/JBIG2Decode" || f === "/DCT") {
      return { data, ok: true, image: true };
    } else return { ok: false };
    if (Date.now() > deadline) return { ok: false };
  }
  return { data, ok: true, image: false };
}

function pngUnpredict(buf, columns, bpp) {
  const rowLen = columns * bpp;
  const stride = rowLen + 1;
  const rows = Math.floor(buf.length / stride);
  const out = Buffer.alloc(rows * rowLen);
  for (let r = 0; r < rows; r++) {
    const ft = buf[r * stride];
    for (let i = 0; i < rowLen; i++) {
      const x = buf[r * stride + 1 + i];
      const a = i >= bpp ? out[r * rowLen + i - bpp] : 0;
      const b = r > 0 ? out[(r - 1) * rowLen + i] : 0;
      const c = i >= bpp && r > 0 ? out[(r - 1) * rowLen + i - bpp] : 0;
      let v;
      if (ft === 0) v = x; else if (ft === 1) v = x + a; else if (ft === 2) v = x + b; else if (ft === 3) v = x + ((a + b) >> 1);
      else { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      out[r * rowLen + i] = v & 0xff;
    }
  }
  return out;
}

function ascii85(str) {
  const s = str.replace(/\s+/g, "").replace(/^<~/, "").replace(/~>.*$/s, "");
  const out = [];
  let group = [];
  for (const ch of s) {
    if (ch === "z" && group.length === 0) { out.push(0, 0, 0, 0); continue; }
    group.push(ch.charCodeAt(0) - 33);
    if (group.length === 5) {
      let n = 0; for (const g of group) n = n * 85 + g;
      out.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255); group = [];
    }
  }
  if (group.length > 1) {
    const k = group.length; while (group.length < 5) group.push(84);
    let n = 0; for (const g of group) n = n * 85 + g;
    const b = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    out.push(...b.slice(0, k - 1));
  }
  return Buffer.from(out);
}

function scanObjects(bytes, deadline) {
  const s = bytes.toString("latin1");
  const objs = new Map(); // num -> {dict, value, raw(Buffer)|null, fromStream}
  const re = /(?:^|[\s>\]])(\d{1,9})\s+(\d{1,5})\s+obj(?![A-Za-z])/g;
  let m;
  let count = 0;
  while ((m = re.exec(s))) {
    if (++count > MAX_OBJECTS || Date.now() > deadline) throw new Error("too-many-objects");
    const num = Number(m[1]);
    const cur = new Cursor(s, m.index + m[0].length);
    let value;
    try { value = parseValue(cur); } catch { re.lastIndex = cur.i; continue; }
    let raw = null;
    if (value && typeof value === "object" && !Array.isArray(value) && value.k === undefined && value.r === undefined && value.s === undefined) {
      skipWs(cur);
      if (s.startsWith("stream", cur.i)) {
        let start = cur.i + 6;
        if (s[start] === "\r" && s[start + 1] === "\n") start += 2; else if (s[start] === "\n" || s[start] === "\r") start += 1;
        let end = -1;
        const len = value.Length;
        if (typeof len === "number" && len >= 0 && start + len <= s.length && /^\s*endstream/.test(s.slice(start + len, start + len + 12))) end = start + len;
        if (end < 0) {
          const e = s.indexOf("endstream", start);
          end = e < 0 ? s.length : e;
          if (s[end - 1] === "\n") end--; if (s[end - 1] === "\r") end--;
        }
        raw = bytes.subarray(start, end);
        re.lastIndex = end;
      } else re.lastIndex = cur.i;
    } else re.lastIndex = cur.i;
    objs.set(num, { value, raw });
  }
  return { objs, text: s };
}

/* ------------------------------------------------------------------ document model */
class Doc {
  constructor(objs, deadline) { this.objs = objs; this.deadline = deadline; this.streamCache = new Map(); }
  get(v) {
    let guard = 0;
    while (v && typeof v === "object" && v.r !== undefined && guard++ < 20) v = this.objs.get(v.r)?.value;
    return v;
  }
  dict(v) { const d = this.get(v); return d && typeof d === "object" && !Array.isArray(d) && d.k === undefined && d.s === undefined ? d : null; }
  arr(v) { const a = this.get(v); return Array.isArray(a) ? a : null; }
  num(v, dflt = 0) { const n = this.get(v); return typeof n === "number" ? n : dflt; }
  stream(ref) {
    const num = typeof ref === "object" && ref?.r !== undefined ? ref.r : null;
    if (num !== null && this.streamCache.has(num)) return this.streamCache.get(num);
    const o = num !== null ? this.objs.get(num) : null;
    let res = { ok: false };
    if (o?.raw && o.value && typeof o.value === "object") res = decodeFilters(o.value, o.raw, this.deadline);
    if (num !== null) this.streamCache.set(num, res);
    return res;
  }
}

function unpackObjectStreams(doc) {
  const added = [];
  for (const [num, o] of doc.objs) {
    const d = o.value;
    if (!o.raw || !d || d.Type !== "/ObjStm") continue;
    const st = doc.stream({ r: num });
    if (!st.ok) continue;
    const text = st.data.toString("latin1");
    const n = doc.num(d.N), first = doc.num(d.First);
    const hdr = text.slice(0, first).trim().split(/\s+/).map(Number);
    for (let k = 0; k < n && 2 * k + 1 < hdr.length; k++) {
      const onum = hdr[2 * k], off = hdr[2 * k + 1];
      if (!Number.isFinite(onum) || !Number.isFinite(off)) continue;
      try { added.push([onum, { value: parseValue(new Cursor(text, first + off)), raw: null }]); } catch { /* skip */ }
    }
  }
  for (const [n, o] of added) if (!doc.objs.has(n) || !doc.objs.get(n).raw) doc.objs.set(n, o);
}

function collectPages(doc, text) {
  let root = null;
  const rm = [...text.matchAll(/\/Root\s+(\d+)\s+\d+\s+R/g)];
  if (rm.length) root = { r: Number(rm[rm.length - 1][1]) };
  let catalog = root ? doc.dict(root) : null;
  if (!catalog || catalog.Type !== "/Catalog") {
    catalog = null;
    for (const [, o] of doc.objs) if (o.value?.Type === "/Catalog") { catalog = o.value; break; }
  }
  const pages = [];
  const seen = new Set();
  const walk = (ref, inherited) => {
    if (pages.length > MAX_PAGES) return;
    const key = ref?.r;
    if (key !== undefined) { if (seen.has(key)) return; seen.add(key); }
    const node = doc.dict(ref);
    if (!node) return;
    const inh = { ...inherited };
    for (const k of ["Resources", "MediaBox", "Rotate"]) if (node[k] !== undefined) inh[k] = node[k];
    if (node.Type === "/Pages" || node.Kids) {
      for (const kid of doc.arr(node.Kids) ?? []) walk(kid, inh);
    } else pages.push({ node, inh, ref });
  };
  if (catalog?.Pages) walk(catalog.Pages, {});
  if (!pages.length) {
    const flat = [];
    for (const [n, o] of doc.objs) if (o.value?.Type === "/Page") flat.push([n, o.value]);
    flat.sort((a, b) => a[0] - b[0]);
    for (const [n, v] of flat) pages.push({ node: v, inh: { Resources: v.Resources, MediaBox: v.MediaBox, Rotate: v.Rotate }, ref: { r: n }, flat: true });
  }
  return pages;
}

/* ------------------------------------------------------------------ fonts */
function parseCMap(text) {
  const map = new Map();
  const codespaces = [];
  const hexToStr = (h) => {
    let out = "";
    for (let k = 0; k + 3 < h.length + 1; k += 4) out += String.fromCharCode(parseInt(h.slice(k, k + 4), 16));
    return out;
  };
  for (const blk of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) {
    for (const m of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) codespaces.push(m[1].length / 2);
  }
  for (const blk of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(parseInt(m[1], 16), hexToStr(m[2].padEnd(Math.ceil(m[2].length / 4) * 4, "0")));
  }
  for (const blk of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = blk[1];
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]*)>|\[([^\]]*)\])/g;
    let m;
    while ((m = re.exec(body))) {
      const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16);
      if (hi - lo > 65535) continue;
      if (m[3] !== undefined) {
        const dst = hexToStr(m[3].padEnd(Math.ceil(m[3].length / 4) * 4, "0"));
        for (let c = lo; c <= hi; c++) {
          const last = dst.charCodeAt(dst.length - 1) + (c - lo);
          map.set(c, dst.slice(0, -1) + String.fromCharCode(last));
        }
      } else if (m[4] !== undefined) {
        const items = [...m[4].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => hexToStr(x[1].padEnd(Math.ceil(x[1].length / 4) * 4, "0")));
        for (let c = lo; c <= hi && c - lo < items.length; c++) map.set(c, items[c - lo]);
      }
    }
  }
  return { map, twoByte: codespaces.length ? codespaces.every((n) => n === 2) : null, mixed: new Set(codespaces).size > 1 };
}

function loadFont(doc, fontRef) {
  const f = doc.dict(fontRef);
  if (!f) return { readable: false, reason: "no-font" };
  const subtype = f.Subtype;
  const font = { readable: true, widths: null, firstChar: 0, dw: 1000, cidW: null, twoByte: false, toUni: null, table: null, diffs: null, base: String(f.BaseFont ?? ""), std: false };
  if (f.ToUnicode) {
    const st = doc.stream(f.ToUnicode);
    if (st.ok) { const cm = parseCMap(st.data.toString("latin1")); if (cm.map.size) { font.toUni = cm.map; if (cm.twoByte !== null) font.twoByte = cm.twoByte; if (cm.mixed) return { readable: false, reason: "mixed-codespace" }; } }
  }
  if (subtype === "/Type0") {
    const enc = doc.get(f.Encoding);
    const desc = doc.dict((doc.arr(f.DescendantFonts) ?? [])[0]);
    if (typeof enc === "string" && /^\/Identity/.test(enc)) font.twoByte = true;
    else if (typeof enc === "string" && !font.toUni) return { readable: false, reason: "cmap-" + enc };
    else if (!font.toUni) return { readable: false, reason: "type0-no-tounicode" };
    if (!font.toUni) return { readable: false, reason: "type0-no-tounicode" };
    if (desc) {
      font.dw = doc.num(desc.DW, 1000);
      const w = doc.arr(desc.W);
      if (w) {
        const cw = new Map();
        for (let i = 0; i < w.length;) {
          const a = doc.get(w[i]);
          const b = doc.get(w[i + 1]);
          if (Array.isArray(b)) { b.forEach((x, k) => cw.set(a + k, doc.num(x))); i += 2; }
          else { const wd = doc.num(w[i + 2]); for (let c = a; c <= b && c - a < 70000; c++) cw.set(c, wd); i += 3; }
        }
        font.cidW = cw;
      }
    }
    return font;
  }
  if (subtype === "/Type3" && !font.toUni) return { readable: false, reason: "type3-no-tounicode" };
  // simple font
  font.firstChar = doc.num(f.FirstChar, 0);
  const widths = doc.arr(f.Widths);
  if (widths) font.widths = widths.map((x) => doc.num(x, 0));
  font.std = /^\/?(?:[A-Z]{6}\+)?(Helvetica|Arial|Times|Courier|Symbol|ZapfDingbats)/i.test(font.base) || /^(Helvetica|Times|Courier)/i.test(font.base);
  let baseName = null;
  const enc = doc.get(f.Encoding);
  let diffs = null;
  if (typeof enc === "string") baseName = enc.slice(1);
  else if (enc && typeof enc === "object" && !Array.isArray(enc)) {
    if (typeof enc.BaseEncoding === "string") baseName = enc.BaseEncoding.slice(1);
    const dArr = doc.arr(enc.Differences);
    if (dArr) {
      diffs = new Map();
      let code = 0;
      for (const item of dArr) {
        const v = doc.get(item);
        if (typeof v === "number") code = v;
        else if (typeof v === "string") diffs.set(code++, v.slice(1));
      }
    }
  }
  const symbolic = /Symbol|Zapf|Dingbats/i.test(font.base);
  if (symbolic && !font.toUni) return { readable: false, reason: "symbolic-font" };
  const embedded = Boolean(doc.dict(f.FontDescriptor) && (doc.dict(f.FontDescriptor).FontFile || doc.dict(f.FontDescriptor).FontFile2 || doc.dict(f.FontDescriptor).FontFile3));
  if (!baseName && !diffs && !font.toUni && !font.std && embedded && subtype === "/TrueType") return { readable: false, reason: "truetype-no-encoding" };
  if (!baseName && !diffs && !font.toUni && !font.std && embedded && subtype !== "/TrueType") return { readable: false, reason: "custom-builtin-encoding" };
  font.table = baseTable(baseName ?? (subtype === "/TrueType" ? "WinAnsiEncoding" : "StandardEncoding"));
  font.diffs = diffs;
  return font;
}

function decodeShown(font, str, stats) {
  // -> [{ch, w (1/1000 em), single (bool: a one-byte code 32)}]
  const out = [];
  if (font.twoByte) {
    for (let i = 0; i + 1 < str.length; i += 2) {
      const code = (str.charCodeAt(i) << 8) | str.charCodeAt(i + 1);
      const ch = font.toUni?.get(code);
      stats.chars++;
      if (ch === undefined) { stats.unmapped++; out.push({ ch: "�", w: font.cidW?.get(code) ?? font.dw }); continue; }
      out.push({ ch, w: font.cidW?.get(code) ?? font.dw });
    }
    return out;
  }
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i) & 0xff;
    let ch = font.toUni?.get(code);
    if (ch === undefined && font.diffs?.has(code)) { ch = glyphToUnicode(font.diffs.get(code)); if (ch === null) ch = undefined; }
    if (ch === undefined && font.table) {
      const t = font.table[code];
      if (t !== "" && t !== undefined) ch = t;
      else if (code === 9 || code === 10 || code === 13) ch = " ";
      else if (code < 32) ch = "";
    }
    stats.chars++;
    if (ch === undefined) { stats.unmapped++; ch = "�"; }
    let w;
    if (font.widths && code >= font.firstChar && code - font.firstChar < font.widths.length) w = font.widths[code - font.firstChar];
    if (!(w > 0)) w = /courier/i.test(font.base) ? 600 : /times/i.test(font.base) ? helvWidth(ch) * 0.92 : helvWidth(ch[0] ?? " ");
    out.push({ ch, w, single: code === 32 });
  }
  return out;
}

/* ------------------------------------------------------------------ content stream interpreter */
const mul = (a, b) => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];
const IDENT = [1, 0, 0, 1, 0, 0];

function* tokens(str) {
  const cur = new Cursor(str, 0);
  const n = str.length;
  while (cur.i < n) {
    skipWs(cur);
    if (cur.i >= n) break;
    const c = str[cur.i];
    if (c === "(") { yield readLiteralString(cur); continue; }
    if (c === "<" && str[cur.i + 1] !== "<") { yield readHexString(cur); continue; }
    if (c === "<" && str[cur.i + 1] === "<") {
      // inline dict (BDC properties, inline-image params): skip balanced
      let depth = 0;
      while (cur.i < n) {
        if (str[cur.i] === "<" && str[cur.i + 1] === "<") { depth++; cur.i += 2; }
        else if (str[cur.i] === ">" && str[cur.i + 1] === ">") { depth--; cur.i += 2; if (depth === 0) break; }
        else if (str[cur.i] === "(") readLiteralString(cur);
        else cur.i++;
      }
      yield { dict: true };
      continue;
    }
    if (c === "[") {
      cur.i++;
      const arr = [];
      for (;;) {
        skipWs(cur);
        if (cur.i >= n || str[cur.i] === "]") { cur.i++; break; }
        const ch = str[cur.i];
        if (ch === "(") arr.push(readLiteralString(cur));
        else if (ch === "<") arr.push(readHexString(cur));
        else {
          let j = cur.i;
          while (j < n && !isWs(str.charCodeAt(j)) && !DELIM.has(str[j])) j++;
          if (j === cur.i) { cur.i++; continue; }
          const t = str.slice(cur.i, j); cur.i = j;
          const v = Number(t); if (Number.isFinite(v)) arr.push(v);
        }
      }
      yield { array: arr };
      continue;
    }
    if (c === "/") {
      let j = cur.i + 1;
      while (j < n && !isWs(str.charCodeAt(j)) && !DELIM.has(str[j])) j++;
      yield str.slice(cur.i, j); cur.i = j; continue;
    }
    if (c === ">" || c === ")" || c === "]" || c === "{" || c === "}") { cur.i++; continue; }
    let j = cur.i;
    while (j < n && !isWs(str.charCodeAt(j)) && !DELIM.has(str[j])) j++;
    const t = str.slice(cur.i, j); cur.i = j;
    if (t === "BI") {
      // inline image: skip to EI
      const m = /[\s]EI(?=[\s]|$)/.exec(str.slice(cur.i));
      cur.i = m ? cur.i + m.index + m[0].length : n;
      yield { op: "BI" };
      continue;
    }
    const v = Number(t);
    if (t !== "" && Number.isFinite(v) && /^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) yield v;
    else yield { op: t };
  }
}

function interpret(doc, content, resources, state, depth) {
  const { runs, stats, fontCache, images } = state;
  const res = doc.dict(resources) ?? {};
  const fonts = doc.dict(res.Font) ?? {};
  const xobjs = doc.dict(res.XObject) ?? {};
  let ctm = state.ctm.slice();
  const stack = [];
  let tm = IDENT.slice(), tlm = IDENT.slice();
  let font = null, fsize = 0, tc = 0, tw = 0, th = 1, tl = 0, trise = 0, tr = 0;
  const operands = [];
  const showString = (str) => {
    if (!font) return;
    if (!font.readable) { stats.unreadableFont = font.reason ?? "unreadable-font"; return; }
    const glyphs = decodeShown(font, str, stats);
    if (!glyphs.length) return;
    const trm = mul(tm, ctm);
    const size = Math.abs(fsize) * (Math.hypot(trm[2], trm[3]) || 1);
    const rotated = Math.abs(trm[1]) > Math.abs(trm[0]) * 0.2 && Math.abs(trm[0]) < Math.abs(trm[1]) * 5;
    const x0 = trm[4] + trm[2] * trise, y0 = trm[5] + trm[3] * trise;
    let adv = 0;
    let text = "";
    for (const g of glyphs) {
      text += g.ch;
      adv += ((g.w / 1000) * fsize + tc + (g.single ? tw : 0)) * th;
    }
    const x1 = x0 + adv * Math.hypot(trm[0], trm[1]) * Math.sign(trm[0] || 1);
    if (tr === 3 || tr === 7) { stats.invisible++; }
    else if (rotated) { stats.rotated++; }
    else if (text.trim()) runs.push({ x: Math.min(x0, x1), x2: Math.max(x0, x1), y: y0, size: Math.max(1, size), text });
    // advance text matrix
    tm = mul([1, 0, 0, 1, adv, 0], tm);
  };
  const adjust = (n) => { tm = mul([1, 0, 0, 1, (-n / 1000) * fsize * th, 0], tm); };
  let guardOps = 0;
  for (const t of tokens(content)) {
    if (++guardOps > 3_000_000 || Date.now() > doc.deadline) { stats.timeout = true; break; }
    if (t && typeof t === "object" && t.op !== undefined) {
      const op = t.op;
      const o = operands;
      switch (op) {
        case "q": stack.push({ ctm: ctm.slice() }); break;
        case "Q": if (stack.length) ctm = stack.pop().ctm; break;
        case "cm": if (o.length >= 6) ctm = mul(o.slice(-6), ctm); break;
        case "BT": tm = IDENT.slice(); tlm = IDENT.slice(); break;
        case "ET": break;
        case "Tf": {
          const name = o[o.length - 2]; fsize = Number(o[o.length - 1]) || 0;
          const fref = fonts[String(name).slice(1)];
          const key = fref?.r ?? String(name);
          if (!fontCache.has(key)) fontCache.set(key, fref ? loadFont(doc, fref) : { readable: false, reason: "font-missing" });
          font = fontCache.get(key);
          break;
        }
        case "Tc": tc = Number(o[o.length - 1]) || 0; break;
        case "Tw": tw = Number(o[o.length - 1]) || 0; break;
        case "Tz": th = (Number(o[o.length - 1]) || 100) / 100; break;
        case "TL": tl = Number(o[o.length - 1]) || 0; break;
        case "Ts": trise = Number(o[o.length - 1]) || 0; break;
        case "Tr": tr = Number(o[o.length - 1]) || 0; break;
        case "Td": if (o.length >= 2) { tlm = mul([1, 0, 0, 1, Number(o[o.length - 2]), Number(o[o.length - 1])], tlm); tm = tlm.slice(); } break;
        case "TD": if (o.length >= 2) { tl = -Number(o[o.length - 1]); tlm = mul([1, 0, 0, 1, Number(o[o.length - 2]), Number(o[o.length - 1])], tlm); tm = tlm.slice(); } break;
        case "Tm": if (o.length >= 6) { tm = o.slice(-6).map(Number); tlm = tm.slice(); } break;
        case "T*": tlm = mul([1, 0, 0, 1, 0, -tl], tlm); tm = tlm.slice(); break;
        case "Tj": { const s = o[o.length - 1]; if (s?.s !== undefined) showString(s.s); break; }
        case "'": { tlm = mul([1, 0, 0, 1, 0, -tl], tlm); tm = tlm.slice(); const s = o[o.length - 1]; if (s?.s !== undefined) showString(s.s); break; }
        case '"': { tw = Number(o[o.length - 3]) || 0; tc = Number(o[o.length - 2]) || 0; tlm = mul([1, 0, 0, 1, 0, -tl], tlm); tm = tlm.slice(); const s = o[o.length - 1]; if (s?.s !== undefined) showString(s.s); break; }
        case "TJ": {
          const arr = o[o.length - 1]?.array;
          if (arr) for (const item of arr) {
            if (typeof item === "number") {
              // a big backwards kern is how producers draw a word space without a space glyph
              if (item < -180 && runs.length && font?.readable) {
                const last = runs[runs.length - 1];
                if (!/\s$/.test(last.text)) last.text += " ";
              }
              adjust(item);
            } else if (item?.s !== undefined) showString(item.s);
          }
          break;
        }
        case "Do": {
          const name = String(o[o.length - 1] ?? "").slice(1);
          const xref = xobjs[name];
          const xo = doc.dict(xref);
          if (!xo) break;
          if (xo.Subtype === "/Image") {
            const area = Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]);
            const w = doc.num(xo.Width), h = doc.num(xo.Height);
            const mask = xo.ImageMask === true || (xo.ImageMask?.k === "true");
            images.push({ area, w, h, mask });
          } else if (xo.Subtype === "/Form" && depth < MAX_XOBJECT_DEPTH) {
            const st = doc.stream(xref);
            if (!st.ok) { stats.badStream = true; break; }
            const mat = (doc.arr(xo.Matrix) ?? IDENT).map((x) => doc.num(x));
            const sub = { ...state, ctm: mul(mat.length === 6 ? mat : IDENT, ctm) };
            interpret(doc, st.data.toString("latin1"), xo.Resources ?? resources, sub, depth + 1);
          }
          break;
        }
        default: break;
      }
      operands.length = 0;
    } else if (t && t.dict) { operands.push(t); }
    else operands.push(t);
    if (operands.length > 64) operands.splice(0, operands.length - 16);
  }
}

/* ------------------------------------------------------------------ lines from runs */
function buildLines(runs) {
  if (!runs.length) return "";
  const sorted = runs.slice().sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const r of sorted) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line.y - r.y) <= Math.max(1.2, 0.4 * Math.min(line.size, r.size))) { line.runs.push(r); line.size = Math.max(line.size, r.size); }
    else lines.push({ y: r.y, size: r.size, runs: [r] });
  }
  const outLines = [];
  let prev = null;
  for (const line of lines) {
    line.runs.sort((a, b) => a.x - b.x);
    let text = "";
    let last = null;
    for (const r of line.runs) {
      if (last) {
        const gap = r.x - last.x2;
        const em = Math.max(1, Math.min(last.size, r.size));
        const needsSpace = gap > 0.12 * em && !/\s$/.test(text) && !/^\s/.test(r.text);
        if (gap > 2.2 * em) text += "   ";
        else if (needsSpace) text += " ";
      }
      text += r.text;
      last = r;
    }
    text = text.replace(/[ \t]+$/g, "");
    if (!text) continue;
    if (prev && prev.y - line.y > 1.75 * Math.max(prev.size, line.size) * 1.2) outLines.push("");
    outLines.push(text);
    prev = line;
  }
  return outLines.join("\n");
}

/* ------------------------------------------------------------------ garble heuristics */
/** Pure. True when text that is meant to be English business paperwork is clearly not. */
export function looksGarbled(text) {
  const t = String(text ?? "");
  if (!t.trim()) return false;
  if (/�/.test(t)) return true;
  const chars = t.replace(/\s/g, "");
  if (chars.length < 20) return false;
  const plain = chars.replace(/[^A-Za-z0-9.,:;#$%&()@'"!?\/\\_+*=<>\[\]{}|~^`-]/g, "");
  if (plain.length / chars.length < 0.95) return true;
  const words = t.split(/\s+/).filter(Boolean);
  const singles = words.filter((w) => /^[A-Za-z]$/.test(w)).length;
  if (words.length >= 12 && singles / words.length > 0.4) return true;
  const letters = (t.match(/[A-Za-z]/g) ?? []);
  if (letters.length >= 80) {
    const vowels = (t.match(/[aeiouAEIOU]/g) ?? []).length;
    const ratio = vowels / letters.length;
    if (ratio < 0.14 || ratio > 0.62) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ public API */
/**
 * @param {Buffer|Uint8Array} bytes  a PDF file
 * @param {{budgetMs?: number, maxPages?: number}} [opts]
 * @returns {{ok: true, pages: {page_no:number,text:string}[], stats: object}|{ok: false, reason: string, stats?: object}}
 */
export function readPdfTextLayer(bytes, opts = {}) {
  const started = Date.now();
  const deadline = started + (opts.budgetMs ?? DEFAULT_BUDGET_MS);
  const stats = { pages: 0, chars: 0, unmapped: 0, invisible: 0, rotated: 0, images: 0, bigImages: 0, badStream: false, unreadableFont: null, timeout: false, ms: 0 };
  try {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (buf.length < 64 || buf.subarray(0, 1024).toString("latin1").indexOf("%PDF") === -1) return { ok: false, reason: "not-pdf", stats };
    const { objs, text } = scanObjects(buf, deadline);
    if (/\/Encrypt\s*(?:\d+\s+\d+\s+R|<<)/.test(text)) return { ok: false, reason: "encrypted", stats };
    const doc = new Doc(objs, deadline);
    unpackObjectStreams(doc);
    const pageList = collectPages(doc, text);
    if (!pageList.length) return { ok: false, reason: "no-pages", stats };
    if (pageList.length > (opts.maxPages ?? MAX_PAGES)) return { ok: false, reason: "too-many-pages", stats };
    const fontCache = new Map();
    const pages = [];
    for (let i = 0; i < pageList.length; i++) {
      const { node, inh } = pageList[i];
      const rot = doc.num(inh.Rotate, 0);
      if (rot % 360 !== 0) return { ok: false, reason: "rotated-page", stats };
      const mb = (doc.arr(inh.MediaBox) ?? [0, 0, 612, 792]).map((x) => doc.num(x));
      const pageArea = Math.abs((mb[2] - mb[0]) * (mb[3] - mb[1])) || 612 * 792;
      let contentStr = "";
      const c = doc.get(node.Contents);
      const refs = Array.isArray(c) ? c : node.Contents !== undefined ? [node.Contents] : [];
      for (const r of refs) {
        const st = doc.stream(r);
        if (!st.ok) { return { ok: false, reason: "content-stream-undecodable", stats }; }
        contentStr += st.data.toString("latin1") + "\n";
      }
      const runs = [];
      const images = [];
      const pstats = { ...stats, unmapped: 0, chars: 0, invisible: 0, rotated: 0, unreadableFont: null };
      const state = { runs, stats: pstats, fontCache, images, ctm: IDENT.slice() };
      interpret(doc, contentStr, inh.Resources, state, 0);
      if (pstats.timeout || Date.now() > deadline) return { ok: false, reason: "timeout", stats };
      if (pstats.badStream) return { ok: false, reason: "form-stream-undecodable", stats };
      if (pstats.unreadableFont) return { ok: false, reason: `font:${pstats.unreadableFont}`, stats };
      if (pstats.invisible) return { ok: false, reason: "invisible-text-ocr-layer", stats };
      if (pstats.rotated) return { ok: false, reason: "rotated-text", stats };
      if (pstats.chars && pstats.unmapped / pstats.chars > 0.005) return { ok: false, reason: "unmapped-characters", stats };
      stats.chars += pstats.chars; stats.unmapped += pstats.unmapped;
      const pageText = buildLines(runs);
      const bigImg = images.filter((im) => !im.mask && im.area / pageArea > 0.12);
      stats.images += images.length; stats.bigImages += bigImg.length;
      if (bigImg.length) return { ok: false, reason: "page-image", stats };
      if (images.length && pageText.replace(/\s/g, "").length < 120 && images.some((im) => im.area / pageArea > 0.02)) return { ok: false, reason: "image-with-little-text", stats };
      if (looksGarbled(pageText)) return { ok: false, reason: "garbled-text", stats };
      pages.push({ page_no: i + 1, text: pageText });
    }
    stats.pages = pages.length;
    if (!pages.some((p) => p.text.trim())) return { ok: false, reason: "no-text", stats };
    stats.ms = Date.now() - started;
    return { ok: true, pages, stats };
  } catch (err) {
    stats.ms = Date.now() - started;
    return { ok: false, reason: `parse-error:${String(err?.message ?? err).slice(0, 60)}`, stats };
  }
}
