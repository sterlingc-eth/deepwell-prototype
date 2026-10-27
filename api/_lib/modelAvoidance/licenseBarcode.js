/**
 * License-barcode lane (free, exact): the back of a US / Canadian driver licence or CDL carries a PDF417 barcode in the AAMVA format.
 * It holds the printed fields EXACTLY, so reading it beats reading the printed text with a vision model: no model call, no OCR error.
 *
 *   readLicenseBarcodePages(bytes, contentType, opts)   decode image pages / photo-PDF pages; returns the pages that held a VALID barcode
 *   parseAamva(payload)                                 strict parse of one payload (pure; used by the tests)
 *   barcodePageText(fields)                             the page text stored for such a page (the existing label readers read it)
 *
 * What it will NOT do (every one of these falls back to the existing vision path, with no change in behaviour):
 *   - a barcode that does not decode, or decodes to something that is not an AAMVA driver-licence payload ("@\n\x1e\rANSI " + IIN + version,
 *     a consistent subfile directory, a "DL" subfile);
 *   - ANY inconsistency: an unknown element line, two different values for one element, a date that is not a date (or reads two ways),
 *     expiry before issue, a name that is truncated or has digits, a state that does not match the country, a missing number / name / expiry.
 *     The rule is "all or nothing": a barcode that is not fully understood yields NO values (never a partial or wrong one).
 *
 * Privacy (same rules as the rest of the people lane): the page text carries only holder name, class, issue / expiry dates, state,
 * restrictions, endorsements and the licence number MASKED to its last 4 ("XXXX5789"). Date of birth, address, sex, height, eye colour,
 * the document discriminator and the raw barcode payload are never copied anywhere: not into the page text, not into a log line.
 *
 * Decoder: zxing-wasm (zxing-cpp compiled to WebAssembly, MIT wrapper over Apache-2.0 zxing-cpp), reader build only (947 KB wasm).
 * Loaded lazily; if the package or the wasm file is missing the lane answers "nothing" and ingest behaves exactly as before.
 * zxing's PDF417 detector tolerates about +-2 degrees of tilt, so a photo is first searched for a barcode-like region (coherent vertical
 * edges) and the region is deskewed before decoding. A page with no such region costs one gradient pass, not a decode sweep.
 *
 * Pure apart from the lazy wasm load. No network, no clock except the budget deadline.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import jpeg from "jpeg-js";
import { inflateSync } from "node:zlib";

/** First line of every page this lane writes. Other readers use it to know the values came from the barcode, not from OCR. */
export const BARCODE_MARKER = "[aamva-pdf417 exact read]";
export const isBarcodePageText = (t) => typeof t === "string" && t.startsWith(BARCODE_MARKER);

/* ================================================================================================ 1. AAMVA parse */
const US = new Set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR GU VI AS MP".split(" "));
const CA = new Set("AB BC MB NB NL NF NS NT NU ON PE QC SK YT".split(" "));
const ABSENT = /^(?:none|unavl|unavailable|unknown|n\/a|na|nil|-+)$/i;
const clean = (v) => String(v ?? "").replace(/[\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim();

const validYmd = (y, m, d) => {
  if (!(y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1)) return null;
  const dim = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return d <= dim ? `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null;
};
/** An AAMVA date is 8 digits: MMDDCCYY in the US, CCYYMMDD in Canada. With no country element both layouts are tried and the date is
 *  accepted only when EXACTLY ONE of them is a real calendar date. */
function aamvaDate(raw, country) {
  const s = clean(raw);
  if (!/^\d{8}$/.test(s)) return null;
  const us = validYmd(+s.slice(4), +s.slice(0, 2), +s.slice(2, 4));
  const ca = validYmd(+s.slice(0, 4), +s.slice(4, 6), +s.slice(6));
  if (country === "USA") return us;
  if (country === "CAN") return ca;
  return us && ca ? null : us || ca;
}
const NAME_OK = /^[A-Za-z][A-Za-z .'’-]{0,60}$/;
function titleName(s) {
  return s.toLowerCase().split(" ").filter(Boolean).map((w) => w.split("-").map((p) => {
    if (/^(?:ii|iii|iv)$/.test(p)) return p.toUpperCase();
    let o = p.replace(/(^|['’.])([a-z])/g, (m, a, b) => a + b.toUpperCase());
    if (/^mc[a-z]{3,}/.test(p)) o = "Mc" + o.charAt(2).toUpperCase() + o.slice(3);
    return o;
  }).join("-")).join(" ");
}
const nameBit = (v) => { const s = clean(v).replace(/,/g, " ").replace(/\s+/g, " ").trim(); return !s || ABSENT.test(s) ? "" : s; };
const codes = (v, max = 12) => { const s = clean(v).toUpperCase(); if (/^NONE$/.test(s)) return "none"; return /^[A-Z0-9](?:[ ,/]*[A-Z0-9]){0,11}$/.test(s) && s.length <= max ? s : null; };

/**
 * @param {string} payload the decoded bytes as latin1 (one char per byte)
 * @returns {{ok:true, fields:{holder_name:string, license_number:string|null, license_last4:string|null, license_class:string|null, start_date:string|null, end_date:string, license_state:string, restrictions:string|null, endorsements:string|null, version:number}}|{ok:false, reason:string}}
 */
export function parseAamva(payload) {
  const bad = (reason) => ({ ok: false, reason });
  if (typeof payload !== "string" || payload.length < 40 || payload.length > 4000) return bad("size");
  const h = /^@\n\x1e\rANSI (\d{6})(\d{2})/.exec(payload);
  if (!h) return bad("header");
  const version = Number(h[2]);
  if (version < 1 || version > 12) return bad("version");
  let p = h[0].length;
  if (version >= 2) { if (!/^\d{2}/.test(payload.slice(p, p + 2))) return bad("jurisdiction-version"); p += 2; }
  const ne = /^(\d{2})/.exec(payload.slice(p, p + 2));
  if (!ne) return bad("entries");
  const n = Number(ne[1]); p += 2;
  if (n < 1 || n > 6) return bad("entries");
  const dirEnd = p + 10 * n;
  if (dirEnd >= payload.length) return bad("directory");
  const subs = [];
  for (let i = 0; i < n; i++) {
    const d = /^([A-Z]{2})(\d{4})(\d{4})$/.exec(payload.slice(p + i * 10, p + i * 10 + 10));
    if (!d) return bad("directory");
    const off = Number(d[2]), len = Number(d[3]);
    if (off < dirEnd || len < 4 || off + len > payload.length) return bad("directory");
    if (payload.slice(off, off + 2) !== d[1]) return bad("subfile-type");
    subs.push({ type: d[1], off, len });
  }
  for (let i = 0; i < subs.length; i++) for (let j = i + 1; j < subs.length; j++) if (subs[i].off < subs[j].off + subs[j].len && subs[j].off < subs[i].off + subs[i].len) return bad("overlap");
  const dl = subs.filter((s) => s.type === "DL");
  if (dl.length !== 1) return bad(subs.some((s) => s.type === "ID") ? "not-a-license" : "no-dl-subfile");
  const body = payload.slice(dl[0].off + 2, dl[0].off + dl[0].len).replace(/\r+$/, "");
  const el = new Map();
  for (const line of body.split("\n")) {
    if (!line) continue;
    const m = /^([A-Z]{3})([\s\S]*)$/.exec(line);
    if (!m) return bad("element");
    if (el.has(m[1]) && el.get(m[1]) !== m[2]) return bad("duplicate-element");
    el.set(m[1], m[2]);
  }
  const get = (k) => (el.has(k) ? clean(el.get(k)) : "");

  // country / jurisdiction
  const dcg = get("DCG").toUpperCase();
  if (dcg && dcg !== "USA" && dcg !== "CAN") return bad("country");
  const country = dcg || null;
  const state = get("DAJ").toUpperCase();
  const isUS = US.has(state), isCA = CA.has(state);
  if (!isUS && !isCA) return bad("jurisdiction");
  if ((country === "USA" && !isUS) || (country === "CAN" && !isCA)) return bad("country-mismatch");

  // dates
  const exp = aamvaDate(get("DBA"), country);
  if (!exp) return bad("expiry-date");
  let iss = null;
  if (get("DBD")) { iss = aamvaDate(get("DBD"), country); if (!iss) return bad("issue-date"); }
  if (iss) {
    const dy = (+exp.slice(0, 4) - +iss.slice(0, 4));
    if (exp < iss || dy > 30) return bad("date-order");
  }
  // a date of birth that does not parse is a corrupt payload, even though the DOB itself is never copied out
  if (get("DBB") && !aamvaDate(get("DBB"), country)) return bad("birth-date");

  // name
  let first = "", mid = "", last = "";
  if (version === 1 && !el.has("DCS")) {
    const parts = get("DAA").split(",").map((x) => x.trim());
    if (parts.length < 2 || parts.length > 4) return bad("name");
    [last, first, mid = ""] = parts;
  } else { last = nameBit(get("DCS")); first = nameBit(get("DAC")); mid = nameBit(get("DAD")); }
  if (get("DDE").toUpperCase() === "T" || get("DDF").toUpperCase() === "T") return bad("name-truncated");
  if (get("DDG").toUpperCase() === "T") mid = "";
  if (!last || !first) return bad("name");
  for (const x of [last, first, mid]) if (x && !NAME_OK.test(x)) return bad("name-chars");
  const firstWords = first.toLowerCase().split(" ");
  const midKeep = mid && !firstWords.includes(mid.toLowerCase()) ? mid : "";
  const holder = titleName([first, midKeep, last].filter(Boolean).join(" "));
  if (holder.split(" ").length > 5) return bad("name");

  // licence number: kept only as its last 4
  const num = get("DAQ").toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9 .-]{3,24}$/.test(num)) return bad("number");
  const solid = num.replace(/[^A-Z0-9]/g, "");
  if (solid.length < 5 || (solid.match(/\d/g) ?? []).length < 3 || /^(.)\1+$/.test(solid)) return bad("number");
  const last4 = solid.slice(-4);

  const dca = get("DCA").toUpperCase();
  return {
    ok: true,
    fields: {
      holder_name: holder,
      license_number: `XXXX${last4}`,
      license_last4: last4,
      license_class: /^[A-D]$/.test(dca) ? dca : null,
      start_date: iss,
      end_date: exp,
      license_state: state,
      restrictions: el.has("DCB") ? codes(get("DCB")) : null,
      endorsements: el.has("DCD") ? codes(get("DCD")) : null,
      version,
    },
  };
}

/** The page text stored for a decoded licence (read afterwards by idDocFields.js like any printed licence). No DOB, no address. */
export function barcodePageText(f) {
  const lines = [
    BARCODE_MARKER,
    "DRIVER LICENSE",
    `Driver's Name: ${f.holder_name}`,
    `Driver License Number: ${f.license_number}`,
    `Driver License Issuing State: ${f.license_state}`,
  ];
  if (f.license_class) lines.push(`License Class: ${f.license_class}`);
  if (f.start_date) lines.push(`Date Issued: ${f.start_date}`);
  lines.push(`Expiration Date: ${f.end_date}`);
  if (f.restrictions) lines.push(`Restrictions: ${f.restrictions}`);
  if (f.endorsements) lines.push(`Endorsements: ${f.endorsements}`);
  return lines.join("\n");
}

/* ================================================================================================ 2. wasm decoder */
let zxingP = null;
/** Where the reader wasm sits. Candidates, first that exists: next to the ES entry (import.meta.resolve: the file a bundler / the Vercel tracer
 *  actually ships), via require, and under the working directory (vercel.json "includeFiles" puts node_modules/zxing-wasm/dist/reader/*.wasm there). */
function wasmPath() {
  const rel = ["reader", "zxing_reader.wasm"];
  const cands = [];
  try { const u = import.meta.resolve("zxing-wasm/reader"); cands.push(path.join(path.dirname(fileURLToPath(u)), "..", "..", ...rel)); } catch { /* older runtime */ }
  try { const e = createRequire(import.meta.url).resolve("zxing-wasm/reader"); cands.push(path.join(path.dirname(e), "..", "..", ...rel)); } catch { /* not traced as cjs */ }
  cands.push(path.join(process.cwd(), "node_modules", "zxing-wasm", "dist", ...rel), path.join("/var/task", "node_modules", "zxing-wasm", "dist", ...rel));
  const hit = cands.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } });
  if (!hit) throw new Error("zxing_reader.wasm not found");
  return hit;
}
/** Resolves to {read(rgba,w,h)->latin1 payload|null} or null when the decoder is unavailable. Never throws. */
function loadZxing() {
  if (!zxingP) zxingP = (async () => {
    try {
      const wasmBinary = fs.readFileSync(wasmPath());
      const z = await import("zxing-wasm/reader");
      await z.prepareZXingModule({ overrides: { wasmBinary }, fireImmediately: true });
      return {
        async read(rgba, width, height) {
          const res = await z.readBarcodesFromImageData({ data: rgba, width, height }, { formats: ["PDF417"], tryHarder: true, tryRotate: true, tryInvert: true, tryDownscale: true, maxNumberOfSymbols: 2 });
          for (const r of res) if (r.isValid && r.bytes?.length) return Buffer.from(r.bytes).toString("latin1");
          return null;
        },
      };
    } catch (err) {
      console.warn(`licenseBarcode: decoder unavailable (${String(err?.message ?? err).slice(0, 80)}); skipping the barcode lane`);
      return null;
    }
  })();
  return zxingP;
}

/* ================================================================================================ 3. pixels */
const MAX_DECODE_PIXELS = 16e6; // a bigger photo is left to the vision path (jpeg-js costs ~25 bytes per pixel)
const MAX_WORK_EDGE = 2400; // the barcode search works on at most this many pixels on the long edge

/** RGB(A) -> 8-bit grey. */
function toGray(src, stride, w, h) {
  const g = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += stride) g[i] = (src[j] * 77 + src[j + 1] * 151 + src[j + 2] * 28) >> 8;
  return g;
}
function grayDownscale(g, w, h, maxEdge) {
  const k = Math.max(w, h) / maxEdge;
  if (k <= 1) return { g, w, h, k: 1 };
  const ow = Math.max(1, Math.floor(w / k)), oh = Math.max(1, Math.floor(h / k));
  const out = new Uint8Array(ow * oh);
  for (let y = 0; y < oh; y++) {
    const y0 = Math.floor(y * k), y1 = Math.max(y0 + 1, Math.min(h, Math.floor((y + 1) * k)));
    for (let x = 0; x < ow; x++) {
      const x0 = Math.floor(x * k), x1 = Math.max(x0 + 1, Math.min(w, Math.floor((x + 1) * k)));
      let a = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) a += g[yy * w + xx];
      out[y * ow + x] = (a / ((y1 - y0) * (x1 - x0))) | 0;
    }
  }
  return { g: out, w: ow, h: oh, k };
}
const grayToRgba = (g) => { const o = new Uint8ClampedArray(g.length * 4); for (let i = 0, j = 0; i < g.length; i++) { o[j++] = g[i]; o[j++] = g[i]; o[j++] = g[i]; o[j++] = 255; } return o; };

/** Decode a stand-alone JPEG / PNG file to grey. null when it is not one of those, too big, or not decodable. */
export function imageFileToGray(bytes) {
  try {
    const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) {
      const d = jpeg.decode(b, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: MAX_DECODE_PIXELS / 1e6, maxMemoryUsageInMB: 700 });
      return { g: toGray(d.data, 4, d.width, d.height), w: d.width, h: d.height };
    }
    if (b.length > 33 && b.readUInt32BE(0) === 0x89504e47) return pngToGray(b);
  } catch { /* undecodable: not our file */ }
  return null;
}
function pngToGray(b) {
  let p = 8, w = 0, h = 0, depth = 0, ctype = -1, interlace = 0; const idat = []; let plte = null;
  while (p + 8 <= b.length) {
    const len = b.readUInt32BE(p), type = b.toString("latin1", p + 4, p + 8), d = b.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; ctype = d[9]; interlace = d[12]; }
    else if (type === "PLTE") plte = d; else if (type === "IDAT") idat.push(d); else if (type === "IEND") break;
    p += 12 + len;
  }
  if (!w || !h || depth !== 8 || interlace !== 0 || w * h > MAX_DECODE_PIXELS || ![0, 2, 3, 4, 6].includes(ctype)) return null;
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: w * h * ch + h + 64 });
  const px = pngUnfilter(raw, w, h, ch);
  const g = new Uint8Array(w * h);
  for (let i = 0; i < g.length; i++) {
    const o = i * ch;
    g[i] = ctype === 0 || ctype === 4 ? px[o] : ctype === 3 ? (plte ? (plte[px[o] * 3] * 77 + plte[px[o] * 3 + 1] * 151 + plte[px[o] * 3 + 2] * 28) >> 8 : px[o]) : (px[o] * 77 + px[o + 1] * 151 + px[o + 2] * 28) >> 8;
  }
  return { g, w, h };
}
function pngUnfilter(raw, w, h, bpp) {
  const rowLen = w * bpp, out = new Uint8Array(rowLen * h);
  for (let r = 0; r < h; r++) {
    const ft = raw[r * (rowLen + 1)];
    for (let i = 0; i < rowLen; i++) {
      const x = raw[r * (rowLen + 1) + 1 + i];
      const a = i >= bpp ? out[r * rowLen + i - bpp] : 0, b = r > 0 ? out[(r - 1) * rowLen + i] : 0, c = i >= bpp && r > 0 ? out[(r - 1) * rowLen + i - bpp] : 0;
      let v;
      if (ft === 0) v = x; else if (ft === 1) v = x + a; else if (ft === 2) v = x + b; else if (ft === 3) v = x + ((a + b) >> 1);
      else { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      out[r * rowLen + i] = v & 255;
    }
  }
  return out;
}

/* ================================================================================================ 4. find + deskew */
/**
 * Look for a barcode-like region on a (down-scaled) grey image: blocks where the strong edges are coherent (PDF417 = parallel bars) and
 * dense. Returns {angle, turn, box:{x0,y0,x1,y1}} in the coordinates of the grey image, or null. `angle` is the bar direction's tilt in degrees,
 * folded into (-45, 45]; the 90 / 180 / 270 turns are left to the decoder.
 */
export function findBarcodeRegion(g, w, h) {
  const B = 16, bw = Math.floor(w / B), bh = Math.floor(h / B);
  if (bw < 6 || bh < 3) return null;
  const E = new Float64Array(bw * bh), C = new Float64Array(bw * bh), T = new Float64Array(bw * bh), X = new Float64Array(bw * bh);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    let jxx = 0, jyy = 0, jxy = 0, cross = 0, crossY = 0;
    for (let y = by * B + 1; y < by * B + B - 1; y++) for (let x = bx * B + 1; x < bx * B + B - 1; x++) {
      const i = y * w + x;
      const gx = g[i + 1] - g[i - 1], gy = g[i + w] - g[i - w];
      jxx += gx * gx; jyy += gy * gy; jxy += gx * gy;
      // bars alternate dark / light every few pixels (a card edge or a ruled line crosses a row once)
      if ((g[i + 1] - g[i]) * (g[i] - g[i - 1]) < 0 && Math.abs(gx) > 30) cross++;
      if ((g[i + w] - g[i]) * (g[i] - g[i - w]) < 0 && Math.abs(gy) > 30) crossY++;
    }
    const e = jxx + jyy, k = by * bw + bx;
    E[k] = e / (B * B); X[k] = Math.max(cross, crossY) / (B - 2);
    if (e > 0) { C[k] = Math.sqrt((jxx - jyy) ** 2 + 4 * jxy * jxy) / e; T[k] = 0.5 * Math.atan2(2 * jxy, jxx - jyy); }
  }
  // a strong, coherent, alternating block: PDF417 rows give ~0.4-0.95 coherence at high energy; running text and edges stay below / are single
  const orig = new Uint8Array(bw * bh);
  let n = 0;
  for (let k = 0; k < orig.length; k++) if (E[k] > 250 && C[k] > 0.35 && X[k] >= 1.0) { orig[k] = 1; n++; }
  if (n < 10) return null;
  // the symbol's data area is patchy at this scale: close the gaps (dilate twice) before looking for clusters
  let hit = orig;
  for (let pass = 0; pass < 2; pass++) {
    const nx = new Uint8Array(hit.length);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      if (!hit[y * bw + x]) continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < bw && yy < bh) nx[yy * bw + xx] = 1; }
    }
    hit = nx;
  }
  // 8-connected clusters of the closed map; the best is the one with the most ORIGINAL hits that is box-like (not a long thin run)
  const seen = new Uint8Array(hit.length); let best = null, bestScore = 0;
  for (let s0 = 0; s0 < hit.length; s0++) {
    if (!hit[s0] || seen[s0]) continue;
    const st = [s0]; seen[s0] = 1; const cells = [];
    while (st.length) {
      const k = st.pop(); cells.push(k);
      const x = k % bw, y = (k / bw) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= bw || yy >= bh) continue; const q = yy * bw + xx; if (hit[q] && !seen[q]) { seen[q] = 1; st.push(q); } }
    }
    let cx0 = bw, cy0 = bh, cx1 = 0, cy1 = 0, nOrig = 0;
    for (const k of cells) { const x = k % bw, y = (k / bw) | 0; cx0 = Math.min(cx0, x); cx1 = Math.max(cx1, x); cy0 = Math.min(cy0, y); cy1 = Math.max(cy1, y); if (orig[k]) nOrig++; }
    const cw = cx1 - cx0 + 1, ch = cy1 - cy0 + 1;
    // a symbol is dense in alternating edges (measured 0.23-0.42 of its closed cluster); running text and form lines stay under 0.15
    if (nOrig < 8 || nOrig / cells.length < 0.18 || cw < 5 || ch < 4 || cells.length / (cw * ch) < 0.3 || Math.max(cw, ch) / Math.min(cw, ch) > 6) continue;
    if (nOrig > bestScore) { bestScore = nOrig; best = cells.filter((k) => orig[k]) }
  }
  if (!best) return null;
  let x0 = bw, y0 = bh, x1 = 0, y1 = 0, sx = 0, sy = 0, sw = 0;
  for (const k of best) {
    const x = k % bw, y = (k / bw) | 0;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    const wt = E[k]; sx += Math.cos(2 * T[k]) * wt; sy += Math.sin(2 * T[k]) * wt; sw += wt; // angles of a line field repeat every 180 degrees: average the doubled angle
  }
  if (sw <= 0) return null;
  const raw = (0.5 * Math.atan2(sy, sx) * 180) / Math.PI; // direction of the dominant gradient (across the bars), (-90, 90]
  // the bars' gradient points along x when upright: fold so "upright" is 0; a quarter turn is reported apart in `turn`
  const ang = ((raw + 45) % 90 + 90) % 90 - 45;
  const turn = Math.round((raw - ang) / 90) * 90;
  const box = { x0: x0 * B, y0: y0 * B, x1: (x1 + 1) * B, y1: (y1 + 1) * B };
  const wd = box.x1 - box.x0, ht = box.y1 - box.y0;
  if (Math.max(wd, ht) < 100) return null;
  return { angle: ang, turn, box };
}

/** Cut the region around `box` out of the grey image (expanded generously: the detected blocks cover only the densest part of the symbol),
 *  rotated by `angleDeg` about its centre, into a square-ish bitmap that holds the whole rotated rectangle. */
export function cropDeskew(g, w, h, box, angleDeg) {
  const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
  const ew = Math.max((box.x1 - box.x0) * 2.2, w * 0.55), eh = Math.max((box.y1 - box.y0) * 2.6, h * 0.4); // the detected blocks may cover only part of a glared / blurred symbol
  const full = Math.min(2600, Math.ceil(Math.hypot(ew, eh)));
  const step = Math.max(1, full / 1300); // keep the bitmap handed to the decoder small (module size stays >= ~2 px at the working scale)
  const side = Math.ceil(full / step);
  const a = (angleDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const out = new Uint8Array(side * side).fill(255);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const dx = (x - side / 2) * step, dy = (y - side / 2) * step;
    const sx = cx + dx * c - dy * s, sy = cy + dx * s + dy * c;
    const x0 = Math.floor(sx), y0 = Math.floor(sy);
    if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) continue;
    const fx = sx - x0, fy = sy - y0, i = y0 * w + x0;
    out[y * side + x] = g[i] * (1 - fx) * (1 - fy) + g[i + 1] * fx * (1 - fy) + g[i + w] * (1 - fx) * fy + g[i + w + 1] * fx * fy;
  }
  return { g: out, w: side, h: side };
}

/**
 * Try to read a PDF417 payload from one grey image. Order: one plain pass over the (down-scaled) image, then, when a barcode-like
 * region exists, deskewed crops at the estimated tilt and a few degrees around it. Returns the latin1 payload or null.
 */
export async function decodePayloadFromGray(img, { deadline = Infinity, accept = () => true } = {}) {
  const z = await loadZxing();
  if (!z) return null;
  const ds = grayDownscale(img.g, img.w, img.h, MAX_WORK_EDGE);
  // a payload counts only when `accept` (the AAMVA parser) takes it: a damaged symbol can decode to a wrong string, and the sweep goes on
  const attempt = async (g, w, h) => { try { const r = await z.read(grayToRgba(g), w, h); return r !== null && accept(r) ? r : null; } catch { return null; } };
  const region = findBarcodeRegion(ds.g, ds.w, ds.h);
  if (!region) return null; // no barcode-like region: nothing worth decoding (saves a sweep on every ordinary page)
  const plain = await attempt(ds.g, ds.w, ds.h);
  if (plain) return plain;
  // The tilt estimate reads about 15-20% high (measured on rendered tilted symbols), and zxing tolerates about +-2 degrees: sweep a few
  // fractions of the estimate and +-2.5 around the best guess. The sign of the estimate is the sign of the deskew.
  // the symbol is searched for on the down-scaled copy but cut from the ORIGINAL pixels (a big photo keeps its module size)
  const fullBox = { x0: region.box.x0 * ds.k, y0: region.box.y0 * ds.k, x1: region.box.x1 * ds.k, y1: region.box.y1 * ds.k };
  const e = region.angle;
  const tries = [];
  for (const f of [0.85 * e, e, 0.72 * e, 0.85 * e + 2.5, 0.85 * e - 2.5, 1.2 * e, 0.6 * e]) {
    const a = f + region.turn;
    if (Math.abs(f) <= 50 && (Math.abs(a) >= 0.4) && !tries.some((t) => Math.abs(t - a) < 1)) tries.push(a);
  }
  if (!tries.length) tries.push(region.turn);
  // The symbol's data area has about as many edges across the rows as along them, so the estimate can be a quarter turn out: try that too
  // (after the likely orientation, and with fewer angles; 180 degrees is handled by the decoder).
  for (const f of [0.85 * e, e, 0.85 * e + 2.5, 0.85 * e - 2.5]) { const a = f + region.turn + (region.turn >= 0 ? 90 : -90); if (!tries.some((t) => Math.abs(t - a) < 1)) tries.push(a); }
  for (const ang of tries) {
    if (Date.now() > deadline) return null;
    const crop = cropDeskew(img.g, img.w, img.h, fullBox, ang);
    const r = await attempt(crop.g, crop.w, crop.h);
    if (r) return r;
  }
  return null;
}

/* ================================================================================================ 5. entry point */
const MAX_PAGES_TRIED = 8;
const MIN_EDGE_PX = 400;

/**
 * @param {Buffer|Uint8Array} bytes the uploaded file
 * @param {string} contentType
 * @param {{budgetMs?:number, onlyPages?:number[]|null, parsed?:object, pdfLib?:object|null, stats?:object}} [opts]
 *   onlyPages: PDF page numbers worth trying (the caller already knows the others have a text layer); pdfLib: the pdfPages.js module
 * @returns {Promise<{pages:Map<number,{text:string,fields:object}>, pageCount:number}|null>} null when nothing decoded to a VALID licence
 */
export async function readLicenseBarcodePages(bytes, contentType, opts = {}) {
  const t0 = Date.now();
  const deadline = t0 + (opts.budgetMs ?? 6000);
  const stats = opts.stats ?? {};
  stats.tried = 0; stats.decoded = 0; stats.valid = 0; stats.ms = 0;
  try {
    const found = new Map();
    const take = (pageNo, payload) => {
      const r = parseAamva(payload);
      payload = null; // the raw barcode text is never kept
      if (!r.ok) { stats.lastReject = r.reason; return; }
      stats.valid++;
      found.set(pageNo, { text: barcodePageText(r.fields), fields: r.fields });
    };
    let pageCount = 1;
    if (contentType === "application/pdf") {
      const lib = opts.pdfLib;
      if (!lib?.pageImagesForBarcode) return null;
      const pdf = lib.openPdf(bytes, { budgetMs: 8000, ...(opts.parsed ? { parsed: opts.parsed } : {}) });
      if (!pdf) return null;
      pageCount = pdf.pages.length;
      const want = (opts.onlyPages ?? Array.from({ length: pageCount }, (_, i) => i + 1)).filter((n) => n >= 1 && n <= pageCount).slice(0, MAX_PAGES_TRIED);
      for (const n of want) {
        if (Date.now() > deadline) break;
        for (const im of lib.pageImagesForBarcode(pdf, n, { minEdge: MIN_EDGE_PX, maxImages: 3, maxPixels: MAX_DECODE_PIXELS, maxFlatePixels: 70e6 })) {
          if (Date.now() > deadline) break;
          stats.tried++;
          const gray = { g: im.gray, w: im.w, h: im.h };
          const payload = await decodePayloadFromGray(gray, { deadline, accept: (x) => { stats.decoded++; const r = parseAamva(x); if (!r.ok) stats.lastReject = r.reason; return r.ok; } });
          if (payload) { take(n, payload); if (found.has(n)) break; }
        }
      }
    } else {
      const img = imageFileToGray(bytes);
      if (!img || Math.min(img.w, img.h) < MIN_EDGE_PX) return null;
      stats.tried++;
      const payload = await decodePayloadFromGray(img, { deadline, accept: (x) => { stats.decoded++; const r = parseAamva(x); if (!r.ok) stats.lastReject = r.reason; return r.ok; } });
      if (payload) take(1, payload);
    }
    return found.size ? { pages: found, pageCount } : null;
  } catch (err) {
    console.warn(`licenseBarcode: skipped (${String(err?.message ?? err).slice(0, 80)})`);
    return null;
  } finally {
    stats.ms = Date.now() - t0;
  }
}
