/**
 * Vision-lane helpers (no new service, no native binary): cut a PDF down to just the pages that need the vision model, and
 * shrink a phone-photo page so it fits the request.
 *
 * WHY: (1) a one-page PDF wrapping a 24 MP phone photo is 60+ MB and was refused (413) before any reading; (2) an escalation
 * re-read re-sent the WHOLE file, so every flagged page re-paid the image tokens of every page; (3) a mixed PDF (some digital
 * pages, some scans) sent every page to the model. All three need the same primitive: "give me a small valid PDF holding only
 * pages N, M ...", optionally with its oversized raster images re-encoded to a ~2000 px JPEG.
 *
 * HOW: parse with the same dependency-free scanner as the text-layer reader (pdfText.js), copy the objects reachable from each
 * wanted page (fonts, images, content streams are copied byte-for-byte), write a fresh Catalog/Pages/Page set and xref table.
 * Because the page's own content stream is kept, anything drawn on it (stencil text over a JPEG background, stamps) survives;
 * only an image XObject that is bigger than `maxEdge` px is replaced - same dictionary, fewer pixels - and the page's matrix
 * still scales it onto the sheet, so no rotation/placement logic is needed. Pure JS: node:zlib + jpeg-js (≈100 KB, no deps, no
 * native code, so it bundles into a Vercel function unchanged).
 *
 * Contract: buildPdfSubset NEVER throws; it returns {ok:false, reason} for anything it is not sure about (encrypted, an image
 * kind it cannot decode safely, SMask/Mask on a shrink target, ...) and the caller falls back to the previous behaviour.
 */
import { inflateSync } from "node:zlib";
import jpeg from "jpeg-js";
import { _pdfInternals } from "./pdfText.js";

const { scanObjects, Doc, unpackObjectStreams, collectPages, pngUnpredict } = _pdfInternals;

export const MAX_SHRINK_INPUT_BYTES = 100 * 1024 * 1024; // the upload cap
export const SHRINK_EDGE_PX = 2000;
export const SHRINK_JPEG_QUALITY = 85;
// Memory ceilings (measured: jpeg-js costs ~18-35 bytes/pixel, so 48 MP = 1.28 GB; Flate RGB is 3 bytes/pixel). Kept low enough that a
// 1 GB function survives; anything bigger is a clean refusal (413), never an out-of-memory kill.
const MAX_RAW_PIXEL_BYTES = 200 * 1024 * 1024; // inflated Flate image ceiling (~66 MP RGB; a 24 MP photo is 72 MB)
const MAX_DCT_MEGAPIXELS = 50; // jpeg-js decode ceiling; sized from measured peak RSS (see VISION_LANE_R2_REPORT.md)
const MAX_DCT_MEGAPIXELS_CMYK = 24; // 4-component JPEGs decode to 4 planes first: lower ceiling (measured, see report)
const MAX_PAGES_SUPPORTED = 200;
const MAX_SUBSET_BYTES = 24 * 1024 * 1024;
const COPY_PAGE_KEYS = ["MediaBox", "CropBox", "Rotate", "UserUnit"];

/* ------------------------------------------------------------------ serialising parsed values */
function serName(n) {
  let out = "/";
  for (const ch of String(n).slice(1)) {
    const c = ch.charCodeAt(0);
    out += c < 33 || c > 126 || "#()<>[]{}/%".includes(ch) ? "#" + c.toString(16).padStart(2, "0") : ch;
  }
  return out;
}
function serNum(n) {
  if (!Number.isFinite(n)) return "0";
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(6)));
}
function ser(v, refMap) {
  if (v === undefined || v === null) return "null";
  if (typeof v === "number") return serNum(v);
  if (typeof v === "string") return v[0] === "/" ? serName(v) : serName("/" + v);
  if (Array.isArray(v)) return "[" + v.map((x) => ser(x, refMap)).join(" ") + "]";
  if (typeof v === "object") {
    if (v.r !== undefined) return refMap.has(v.r) ? `${refMap.get(v.r)} 0 R` : "null";
    if (v.s !== undefined) return "<" + Buffer.from(String(v.s), "latin1").toString("hex") + ">";
    if (v.k !== undefined) return /^(true|false|null)$/.test(v.k) ? v.k : "null";
    return "<<" + Object.entries(v).map(([k, x]) => serName("/" + k) + " " + ser(x, refMap)).join(" ") + ">>";
  }
  return "null";
}

/* ------------------------------------------------------------------ parsing */
/** Parse once; callers may reuse the result to build several subsets. Returns null for anything unusable. */
export function openPdf(bytes, opts = {}) {
  try {
    if (opts.parsed) {
      // reuse the scan the text-layer reader already did (saves a second pass over a possibly 60+ MB file)
      const pp = opts.parsed;
      pp.doc.deadline = Date.now() + (opts.budgetMs ?? 12000);
      pp.doc.budget.left = 48 * 1024 * 1024; pp.doc.budget.over = false;
      if (pp.pages.length > MAX_PAGES_SUPPORTED) return null;
      return { buf: pp.buf, objs: pp.objs, doc: pp.doc, pages: pp.pages, deadline: pp.doc.deadline };
    }
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (buf.length < 64 || buf.subarray(0, 1024).toString("latin1").indexOf("%PDF") === -1) return null;
    const deadline = Date.now() + (opts.budgetMs ?? 12000);
    const { objs, text } = scanObjects(buf, deadline);
    if (/\/Encrypt\s*(?:\d+\s+\d+\s+R|<<)/.test(text)) return null;
    const doc = new Doc(objs, deadline);
    // Object streams hold small objects only; images are never in one, so the (capped) inflate budget is not a problem here.
    unpackObjectStreams(doc);
    if (doc.budget.over) return null;
    const pages = collectPages(doc, text);
    // a page tree past the supported size is truncated by the scanner: never present a partial file as complete
    if (!pages.length || pages.length > MAX_PAGES_SUPPORTED) return null;
    return { buf, objs, doc, pages, deadline };
  } catch {
    return null;
  }
}

export function pdfPageCount(bytes) {
  const p = openPdf(bytes);
  return p ? p.pages.length : 0;
}

/* ------------------------------------------------------------------ image shrinking */
function colourInfo(doc, xo) {
  let cs = doc.get(xo.ColorSpace);
  let palette = null;
  if (Array.isArray(cs)) {
    const kind = doc.get(cs[0]);
    if (kind === "/ICCBased") {
      const prof = doc.dict(cs[1]);
      const n = doc.num(prof?.N, 0);
      return n === 3 ? { comps: 3 } : n === 1 ? { comps: 1 } : null;
    }
    if (kind === "/CalRGB") return { comps: 3 };
    if (kind === "/CalGray") return { comps: 1 };
    if (kind === "/Indexed" || kind === "/I") {
      const base = colourInfo(doc, { ColorSpace: cs[1] });
      const hival = doc.num(cs[2], -1);
      const look = doc.get(cs[3]);
      let table = null;
      if (look && typeof look === "object" && look.s !== undefined) table = Buffer.from(look.s, "latin1");
      else if (cs[3] && cs[3].r !== undefined) { const st = doc.stream(cs[3]); if (st.ok) table = st.data; }
      if (!base || !table || hival < 0 || table.length < (hival + 1) * base.comps) return null;
      palette = { table, base: base.comps };
      return { comps: 1, palette };
    }
    return null;
  }
  if (cs === "/DeviceRGB" || cs === "/RGB") return { comps: 3 };
  if (cs === "/DeviceGray" || cs === "/G") return { comps: 1 };
  return null;
}

function filtersOf(doc, xo) {
  let f = doc.get(xo.Filter);
  if (f === undefined) return [];
  if (!Array.isArray(f)) f = [f];
  return f.map((x) => doc.get(x));
}
function parmsOf(doc, xo, i) {
  let p = doc.get(xo.DecodeParms ?? xo.DP);
  if (Array.isArray(p)) p = doc.get(p[i]);
  else if (i > 0) p = null;
  return p && typeof p === "object" && !Array.isArray(p) ? p : {};
}

/** Number of colour components declared by a JPEG's first SOF marker (0 if not found). */
function dctComponents(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return buf[i + 9];
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return 0;
}
function hasAdobeMarker(buf) { return buf.subarray(0, 4096).includes("Adobe"); }

/** Decode an image XObject to tightly packed 8-bit RGB. Returns null for any kind we are not sure about. */
function decodeImageRGB(doc, ref) {
  const o = doc.objs.get(ref.r);
  const xo = o?.value;
  if (!xo || xo.Subtype !== "/Image" || !o.raw) return null;
  if (xo.ImageMask === true || xo.ImageMask?.k === "true") return null;
  if (xo.SMask !== undefined || xo.Mask !== undefined) return null;
  const w = doc.num(xo.Width), h = doc.num(xo.Height);
  if (!(w > 0 && h > 0) || w * h * 3 > MAX_RAW_PIXEL_BYTES) return null;
  if (filtersOf(doc, xo).some((f) => f === "/DCTDecode" || f === "/DCT")) {
    const comps = dctComponents(o.raw);
    if (comps !== 1 && comps !== 3 && comps !== 4) return null;
    if (comps === 4 && !hasAdobeMarker(o.raw)) return null; // unmarked CMYK: polarity unknown, never guess colours
    if (w * h > (comps === 4 ? MAX_DCT_MEGAPIXELS_CMYK : MAX_DCT_MEGAPIXELS) * 1e6) return null;
  }
  const filters = filtersOf(doc, xo);
  const isDct = filters.some((f) => f === "/DCTDecode" || f === "/DCT");
  const decodeArr = xo.Decode !== undefined ? (doc.arr(xo.Decode) ?? []).map((x) => doc.num(x, NaN)) : null;
  // A /Decode array is honoured nowhere here, so any image carrying one is refused - except the one common, understood case:
  // an Adobe CMYK JPEG with the inverting [1 0 1 0 1 0 1 0], which jpeg-js already inverts itself from the Adobe marker.
  if (decodeArr && !(isDct && decodeArr.join() === "1,0,1,0,1,0,1,0" && dctComponents(o.raw) === 4 && hasAdobeMarker(o.raw))) return null;
  let data = o.raw;
  let dctRGBA = null;
  for (let i = 0; i < filters.length; i++) {
    const f = filters[i];
    if (f === "/FlateDecode" || f === "/Fl") {
      if (dctRGBA) return null;
      try { data = inflateSync(data, { maxOutputLength: MAX_RAW_PIXEL_BYTES }); } catch { return null; }
      const p = parmsOf(doc, xo, i);
      const pred = Number(p.Predictor ?? 1);
      if (pred >= 10) {
        const comps = colourInfo(doc, xo)?.comps ?? 3;
        data = pngUnpredict(data, Number(p.Columns ?? 1), comps * Math.ceil(Number(p.BitsPerComponent ?? 8) / 8));
      } else if (pred === 2) return null;
    } else if (f === "/DCTDecode" || f === "/DCT") {
      if (i !== filters.length - 1) return null;
      try {
        const d = jpeg.decode(data, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: dctComponents(data) === 4 ? MAX_DCT_MEGAPIXELS_CMYK : MAX_DCT_MEGAPIXELS, maxMemoryUsageInMB: 1500 });
        if (d.width !== w || d.height !== h) return null;
        dctRGBA = d.data;
      } catch { return null; }
    } else return null;
  }
  if (doc.num(xo.BitsPerComponent, 8) !== 8) return null;
  if (dctRGBA) return { rgb: null, rgba: dctRGBA, w, h };
  const ci = colourInfo(doc, xo);
  if (!ci) return null;
  const px = w * h;
  if (ci.palette) {
    if (data.length < px) return null;
    const { table, base } = ci.palette;
    const rgb = Buffer.allocUnsafe(px * 3);
    for (let i = 0, j = 0; i < px; i++) {
      const idx = data[i] * base;
      if (base === 3) { rgb[j++] = table[idx]; rgb[j++] = table[idx + 1]; rgb[j++] = table[idx + 2]; }
      else { const g = table[idx]; rgb[j++] = g; rgb[j++] = g; rgb[j++] = g; }
    }
    return { rgb, w, h };
  }
  if (data.length < px * ci.comps) return null;
  if (ci.comps === 3) return { rgb: data, w, h };
  const rgb = Buffer.allocUnsafe(px * 3);
  for (let i = 0, j = 0; i < px; i++) { const g = data[i]; rgb[j++] = g; rgb[j++] = g; rgb[j++] = g; }
  return { rgb, w, h };
}

/** Area-average downscale of packed RGB (stride 3) or RGBA (stride 4) to outW x outH, returned as RGBA for jpeg-js. */
export function boxDownscale(src, stride, w, h, outW, outH) {
  const out = Buffer.allocUnsafe(outW * outH * 4);
  const xs = new Int32Array(outW + 1);
  for (let x = 0; x <= outW; x++) xs[x] = Math.min(w, Math.floor((x * w) / outW));
  for (let y = 0; y < outH; y++) {
    const y0 = Math.min(h - 1, Math.floor((y * h) / outH));
    const y1 = Math.max(y0 + 1, Math.min(h, Math.floor(((y + 1) * h) / outH)));
    for (let x = 0; x < outW; x++) {
      const x0 = xs[x], x1 = Math.max(x0 + 1, xs[x + 1]);
      let r = 0, g = 0, b = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * w + x0) * stride;
        for (let xx = x0; xx < x1; xx++, i += stride) { r += src[i]; g += src[i + 1]; b += src[i + 2]; }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * outW + x) * 4;
      out[o] = (r / n + 0.5) | 0; out[o + 1] = (g / n + 0.5) | 0; out[o + 2] = (b / n + 0.5) | 0; out[o + 3] = 255;
    }
  }
  return out;
}

/** Re-encode one image XObject to <= maxEdge px JPEG. Returns {dict, raw, w, h} or null (unsupported / not worth it). */
export function shrinkImageObject(doc, ref, maxEdge = SHRINK_EDGE_PX, quality = SHRINK_JPEG_QUALITY) {
  const dec = decodeImageRGB(doc, ref);
  if (!dec) return null;
  const long = Math.max(dec.w, dec.h);
  const scale = Math.min(1, maxEdge / long);
  const outW = Math.max(1, Math.round(dec.w * scale)), outH = Math.max(1, Math.round(dec.h * scale));
  const rgba = dec.rgba ? boxDownscale(dec.rgba, 4, dec.w, dec.h, outW, outH) : boxDownscale(dec.rgb, 3, dec.w, dec.h, outW, outH);
  const enc = jpeg.encode({ data: rgba, width: outW, height: outH }, quality);
  const orig = doc.objs.get(ref.r).value;
  const dict = { ...orig, Width: outW, Height: outH, ColorSpace: "/DeviceRGB", BitsPerComponent: 8, Filter: "/DCTDecode" };
  delete dict.DecodeParms; delete dict.DP; delete dict.Decode; delete dict.Length; delete dict.Intent; delete dict.Interpolate;
  return { dict, raw: Buffer.from(enc.data), w: outW, h: outH };
}


/* ------------------------------------------------------------------ resource pruning (a subset carries only what its pages use) */
const RES_CATS = new Set(["XObject", "Font", "ExtGState", "ColorSpace", "Pattern", "Shading", "Properties"]);
function namesIn(str) {
  const out = new Set();
  for (const m of str.matchAll(/\/([^\s\/\[\]<>()%{}]+)/g)) out.add(m[1].replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));
  return out;
}
function contentNames(doc, contents) {
  const c = doc.get(contents);
  const refs = Array.isArray(c) ? c : contents !== undefined ? [contents] : [];
  let str = "";
  for (const r of refs) { const st = doc.stream(r); if (!st.ok) return null; str += st.data.toString("latin1") + "\n"; }
  return namesIn(str);
}
/**
 * Keep only the resource entries whose names the content actually mentions. Form XObjects that are kept get the same treatment
 * (their rewritten dictionary goes into `overrides`); a form with no Resources of its own inherits the page's, so its names are
 * added to the page's set. Returns the pruned dictionary, or null when a stream cannot be decoded (caller then refuses the subset).
 */
function pruneResources(doc, resVal, names, overrides, depth = 0) {
  const res = doc.dict(resVal);
  if (!res) return resVal;
  const all = new Set(names);
  for (let round = 0; round < 6; round++) {
    const xo = doc.dict(res.XObject) ?? {};
    let grew = false;
    for (const [k, ref] of Object.entries(xo)) {
      if (!all.has(k)) continue;
      const f = doc.dict(ref);
      if (!f || f.Subtype !== "/Form" || f.Resources !== undefined || !ref?.r) continue;
      const st = doc.stream(ref);
      if (!st.ok) return null;
      for (const n of namesIn(st.data.toString("latin1"))) if (!all.has(n)) { all.add(n); grew = true; }
    }
    if (!grew) break;
  }
  const out = {};
  for (const [cat, v] of Object.entries(res)) {
    const d = RES_CATS.has(cat) ? doc.dict(v) : null;
    if (!d) { out[cat] = v; continue; }
    const nd = {};
    for (const [k, x] of Object.entries(d)) if (all.has(k)) nd[k] = x;
    out[cat] = nd;
  }
  if (depth < 4) {
    for (const [k, ref] of Object.entries(out.XObject ?? {})) {
      const f = doc.dict(ref);
      if (!f || f.Subtype !== "/Form" || f.Resources === undefined || !ref?.r || overrides.has(ref.r)) continue;
      const st = doc.stream(ref);
      if (!st.ok) return null;
      const sub = pruneResources(doc, f.Resources, namesIn(st.data.toString("latin1")), overrides, depth + 1);
      if (sub === null) return null;
      overrides.set(ref.r, { ...f, Resources: sub });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ subset writer */
/**
 * @param {ReturnType<typeof openPdf>|Buffer} src  an openPdf() result, or the raw bytes
 * @param {number[]} pageNos  1-based page numbers, in the order wanted
 * @param {{shrink?: boolean, maxEdge?: number, quality?: number, maxBytes?: number}} [opts]
 *   shrink: re-encode any image XObject longer than maxEdge px (only done for oversized files; small files are copied verbatim)
 * @returns {{ok:true, bytes:Buffer, pageMap:number[], shrunk:{objects:number, from:number, to:number}}|{ok:false, reason:string}}
 */
export function buildPdfSubset(src, pageNos, opts = {}) {
  try {
    const pdf = src && src.doc ? src : openPdf(src);
    if (!pdf) return { ok: false, reason: "unparseable" };
    const { objs, doc, pages } = pdf;
    const wanted = [...new Set(pageNos)].filter((n) => Number.isInteger(n) && n >= 1 && n <= pages.length);
    if (!wanted.length) return { ok: false, reason: "no-pages" };
    const maxEdge = opts.maxEdge ?? SHRINK_EDGE_PX;

    // 1. collect reachable objects
    const keep = new Set();
    const stack = [];
    const visitValue = (v, depth = 0) => {
      if (v === null || typeof v !== "object" || depth > 60) return;
      if (Array.isArray(v)) { for (const x of v) visitValue(x, depth + 1); return; }
      if (v.r !== undefined) { if (!keep.has(v.r) && objs.has(v.r)) { keep.add(v.r); stack.push(v.r); } return; }
      if (v.s !== undefined || v.k !== undefined) return;
      for (const x of Object.values(v)) visitValue(x, depth + 1);
    };
    const overrides = new Map(); // form object number -> dictionary with pruned Resources
    let unprunable = false;
    const pageSpecs = wanted.map((n) => {
      const { node, inh } = pages[n - 1];
      const names = contentNames(doc, node.Contents);
      let resources = inh.Resources;
      if (resources !== undefined) {
        const pr = names ? pruneResources(doc, resources, names, overrides) : null;
        if (pr === null) unprunable = true; else resources = pr;
      }
      const spec = { Resources: resources, Contents: node.Contents };
      for (const k of COPY_PAGE_KEYS) { const v = node[k] !== undefined ? node[k] : inh[k]; if (v !== undefined) spec[k] = v; }
      return spec;
    });
    if (unprunable) return { ok: false, reason: "resources-unprunable" };
    for (const sp of pageSpecs) visitValue(sp);
    while (stack.length) {
      const n = stack.pop();
      const v = overrides.get(n) ?? objs.get(n)?.value;
      // never follow a back-pointer into the page tree: it would drag the whole document in
      if (v && typeof v === "object" && !Array.isArray(v) && (v.Type === "/Page" || v.Type === "/Pages" || v.Type === "/Catalog")) { keep.delete(n); continue; }
      visitValue(v);
    }

    // 2. shrink oversized images
    const replaced = new Map();
    const shrunk = { objects: 0, from: 0, to: 0 };
    for (const n of keep) {
      const o = objs.get(n);
      const v = o?.value;
      if (!o?.raw || !v || v.Subtype !== "/Image") continue;
      const w = doc.num(v.Width), h = doc.num(v.Height);
      const isMask = v.ImageMask === true || v.ImageMask?.k === "true";
      // Only an image that is both long-edged AND heavy in bytes is a shrink target: a 1-bit stencil or a small high-pixel graphic is
      // copied verbatim (re-encoding it would only risk fidelity for no saving).
      if (!opts.shrink || isMask || Math.max(w, h) <= maxEdge || o.raw.length < (opts.minShrinkBytes ?? 1_500_000)) continue;
      const r = shrinkImageObject(doc, { r: n }, maxEdge, opts.quality ?? SHRINK_JPEG_QUALITY);
      if (!r) return { ok: false, reason: "image-not-shrinkable" };
      replaced.set(n, r);
      shrunk.objects++; shrunk.from += o.raw.length; shrunk.to += r.raw.length;
    }

    // 3. write
    let maxNum = 0;
    for (const n of objs.keys()) if (n > maxNum) maxNum = n;
    const catalogNum = maxNum + 1, pagesNum = maxNum + 2;
    const pageNums = wanted.map((_, i) => maxNum + 3 + i);
    const refMap = new Map();
    for (const n of keep) refMap.set(n, n);
    const chunks = [];
    const offsets = new Map();
    let pos = 0;
    const push = (b) => { const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, "latin1"); chunks.push(buf); pos += buf.length; };
    push("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n");
    const writeObj = (num, dict, raw) => {
      offsets.set(num, pos);
      if (raw) {
        const d = { ...dict, Length: raw.length };
        push(`${num} 0 obj\n${ser(d, refMap)}\nstream\n`); push(raw); push("\nendstream\nendobj\n");
      } else push(`${num} 0 obj\n${ser(dict, refMap)}\nendobj\n`);
    };
    for (const n of [...keep].sort((a, b) => a - b)) {
      const o = objs.get(n);
      const rep = replaced.get(n);
      if (rep) writeObj(n, rep.dict, rep.raw);
      else if (o.raw) writeObj(n, overrides.get(n) ?? (o.value && typeof o.value === "object" ? o.value : {}), o.raw);
      else writeObj(n, o.value);
    }
    refMap.set(catalogNum, catalogNum); refMap.set(pagesNum, pagesNum);
    pageNums.forEach((n) => refMap.set(n, n));
    writeObj(catalogNum, { Type: "/Catalog", Pages: { r: pagesNum } });
    writeObj(pagesNum, { Type: "/Pages", Kids: pageNums.map((n) => ({ r: n })), Count: pageNums.length });
    pageSpecs.forEach((sp, i) => {
      const d = { Type: "/Page", Parent: { r: pagesNum } };
      for (const [k, v] of Object.entries(sp)) if (v !== undefined) d[k] = v;
      writeObj(pageNums[i], d);
    });
    const size = pageNums[pageNums.length - 1] + 1;
    const xrefPos = pos;
    let x = `xref\n0 ${size}\n0000000000 65535 f \n`;
    for (let n = 1; n < size; n++) x += offsets.has(n) ? `${String(offsets.get(n)).padStart(10, "0")} 00000 n \n` : "0000000000 65535 f \n";
    push(x + `trailer\n<</Size ${size}/Root ${catalogNum} 0 R>>\nstartxref\n${xrefPos}\n%%EOF\n`);
    const bytes = Buffer.concat(chunks);
    if (bytes.length > (opts.maxBytes ?? MAX_SUBSET_BYTES)) return { ok: false, reason: "subset-too-large" };
    return { ok: true, bytes, pageMap: wanted, shrunk };
  } catch (err) {
    return { ok: false, reason: `subset-error:${String(err?.message ?? err).slice(0, 60)}` };
  }
}
