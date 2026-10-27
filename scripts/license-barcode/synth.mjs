// TEST-ONLY synthetic AAMVA PDF417 generator + image degraders. Every name / number / date here is INVENTED. bwip-js (devDependency) is the
// barcode writer; nothing in api/ imports this file. Pure JS: no canvas, no native code (jpeg-js encodes, node:zlib packs PNG / PDF).
import zlib from "node:zlib";
import bwipjs from "bwip-js";
import jpeg from "jpeg-js";

/* ---------------------------------------------------------------- AAMVA payload builder */
/**
 * @param {{iin:string, version:number, jver?:number, type?:string, country?:"USA"|"CAN", elements:[string,string][]}} o
 * version 1 has no jurisdiction-version field in the header (19 bytes), later versions have it (21 bytes).
 */
export function buildAamva({ iin, version, jver = 0, type = "DL", elements, entries = 1, extraSub = null }) {
  const body = type + elements.map(([k, v]) => k + v).join("\n") + "\r";
  const hdrLen = (version === 1 ? 19 : 21) + 10 * (extraSub ? 2 : 1);
  const subs = [{ type, text: body }];
  if (extraSub) subs.push(extraSub);
  let off = hdrLen; let desig = "";
  for (const s of subs) { desig += s.type + String(off).padStart(4, "0") + String(s.text.length).padStart(4, "0"); off += s.text.length; }
  const head = "@\n\x1e\rANSI " + iin + String(version).padStart(2, "0") + (version === 1 ? "" : String(jver).padStart(2, "0")) + String(subs.length).padStart(2, "0");
  return head + desig + subs.map((s) => s.text).join("");
}
const mdy = (y, m, d) => String(m).padStart(2, "0") + String(d).padStart(2, "0") + String(y);
const ymd = (y, m, d) => String(y) + String(m).padStart(2, "0") + String(d).padStart(2, "0");

/** Invented people. `st` state / province code, `iin` an IIN-shaped number (the reader does not map IIN to state). */
export const PEOPLE = [
  { st: "VA", iin: "636000", ver: 9, last: "TESTCASE", first: "ALDER", mid: "REEDE", num: "T64235789", cls: "D", rest: "NONE", end: "NONE", iss: [2022, 8, 24], exp: [2030, 6, 20], dob: [1988, 6, 20], country: "USA" },
  { st: "AZ", iin: "636026", ver: 10, last: "OKONKWO-PENHALLOW", first: "BRIDGETTE", mid: "", num: "D07731942", cls: "A", rest: "B", end: "H N T", iss: [2023, 2, 3], exp: [2031, 2, 3], dob: [1979, 11, 2], country: "USA" },
  { st: "TX", iin: "636015", ver: 8, last: "O'KELLEHER", first: "MARISOL", mid: "ANNE", num: "41800977", cls: "C", rest: "A,B", end: "NONE", iss: [2021, 12, 14], exp: [2029, 12, 14], dob: [1992, 3, 9], country: "USA" },
  { st: "OH", iin: "636023", ver: 6, last: "LINDQVIST", first: "ROWAN", mid: "", num: "XQ118264", cls: "B", rest: "NONE", end: "P S", iss: [2019, 5, 30], exp: [2027, 5, 30], dob: [1985, 8, 17], country: "USA" },
  { st: "NY", iin: "636001", ver: 3, last: "VILLANUEVA", first: "DESMOND", mid: "J", num: "708344915", cls: "D", rest: "NONE", end: "NONE", iss: [2018, 9, 1], exp: [2026, 9, 1], dob: [1970, 1, 25], country: "USA" },
  { st: "CA", iin: "636014", ver: 2, last: "ZAVALA", first: "PRISCILLA", mid: "MAE", num: "Y3350721", cls: "C", rest: "NONE", end: "NONE", iss: [2020, 1, 17], exp: [2028, 1, 17], dob: [1996, 4, 4], country: "USA" },
  { st: "FL", iin: "636010", ver: 1, last: "KOWALCZYK", first: "TOBIAS", mid: "L", num: "K420-554-77-123-0", cls: "E", rest: "NONE", end: "NONE", iss: [2017, 7, 8], exp: [2025, 7, 8], dob: [1964, 12, 30], country: "USA" },
  { st: "ON", iin: "636012", ver: 9, last: "ABERNATHY", first: "CORDELIA", mid: "", num: "A5507-10222-65118", cls: "G", rest: "NONE", end: "NONE", iss: [2022, 4, 11], exp: [2027, 4, 11], dob: [1990, 10, 12], country: "CAN" },
  { st: "BC", iin: "636028", ver: 9, last: "RAMANATHAN", first: "ISHAAN", mid: "", num: "6600127", cls: "5", rest: "NONE", end: "NONE", iss: [2021, 3, 22], exp: [2026, 3, 22], dob: [1983, 2, 28], country: "CAN" },
];

/** The element list a given AAMVA version would carry for one person. Includes DOB / address on purpose: the reader must NOT pass them on. */
export function personElements(p, { overrides = {}, drop = [], extra = [] } = {}) {
  const fmt = p.country === "CAN" ? ymd : mdy;
  const els = [];
  els.push(["DAQ", p.num]);
  if (p.ver === 1) { els.push(["DAA", `${p.last},${p.first}${p.mid ? "," + p.mid : ""}`]); }
  else { els.push(["DCS", p.last]); els.push(["DAC", p.first]); els.push(["DAD", p.mid || "NONE"]); }
  els.push(["DCA", p.cls], ["DCB", p.rest], ["DCD", p.end]);
  els.push(["DBD", fmt(...p.iss)], ["DBB", fmt(...p.dob)], ["DBA", fmt(...p.exp)]);
  els.push(["DBC", "1"], ["DAY", "BRO"], ["DAU", "069 in"], ["DAG", "123 INVENTED LANE"], ["DAI", "EXAMPLETON"], ["DAJ", p.st], ["DAK", "000010000"]);
  if (p.ver >= 2) els.push(["DCF", "0000000000"]);
  els.push(["DCG", p.country]);
  if (p.ver >= 8) els.push(["DDE", "N"], ["DDF", "N"], ["DDG", "N"]);
  const out = els.filter(([k]) => !drop.includes(k)).map(([k, v]) => [k, k in overrides ? overrides[k] : v]);
  return [...out, ...extra];
}
export const payloadFor = (p, opts) => buildAamva({ iin: p.iin, version: p.ver, jver: p.ver >= 2 ? 0 : 0, elements: personElements(p, opts) });

/* ---------------------------------------------------------------- rendering */
/** Grey bitmap {w,h,px:Uint8Array(0..255)} of the PDF417 for `payload` (string: each char one byte, latin1). */
export function renderPdf417(payload, { columns = 12, eclevel = 4, modW = 3, rowH = 9, quiet = 24 } = {}) {
  const r = bwipjs.raw({ bcid: "pdf417", text: payload, columns, eclevel, parse: false, binarytext: true })[0];
  const w = r.pixx * modW + quiet * 2, h = r.pixy * rowH + quiet * 2;
  const px = new Uint8Array(w * h).fill(255);
  for (let y = 0; y < r.pixy; y++) for (let x = 0; x < r.pixx; x++) if (r.pixs[y * r.pixx + x]) {
    for (let yy = 0; yy < rowH; yy++) { const o = (quiet + y * rowH + yy) * w + quiet + x * modW; px.fill(0, o, o + modW); }
  }
  return { w, h, px };
}
/** Put the barcode on a card-back sized canvas with some printed-looking clutter. Returns RGB {w,h,rgb}. */
export function cardBack(bar, { W = 1600, H = 1010, bx = 120, by = 330, seed = 1, bg = [236, 232, 222] } = {}) {
  let s = seed >>> 0; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const rgb = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) { const n = (rnd() - 0.5) * 6; rgb[i * 3] = bg[0] + n; rgb[i * 3 + 1] = bg[1] + n; rgb[i * 3 + 2] = bg[2] + n; }
  // clutter: grey bars standing in for the printed text lines above and below
  const bar2 = (x0, y0, w, h, v) => { for (let y = y0; y < Math.min(H, y0 + h); y++) for (let x = x0; x < Math.min(W, x0 + w); x++) { const o = (y * W + x) * 3; rgb[o] = rgb[o + 1] = rgb[o + 2] = v; } };
  for (let k = 0; k < 7; k++) bar2(100 + (rnd() * 200) | 0, 60 + k * 36, 500 + (rnd() * 700) | 0, 12, 110 + (rnd() * 70) | 0);
  for (let k = 0; k < 4; k++) bar2(100, by + bar.h + 50 + k * 40, 600 + (rnd() * 600) | 0, 12, 120 + (rnd() * 60) | 0);
  const sc = Math.min(1, (W - bx - 60) / bar.w);
  const bw = Math.round(bar.w * sc), bh = Math.round(bar.h * sc);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const sx = Math.min(bar.w - 1, Math.floor(x / sc)), sy = Math.min(bar.h - 1, Math.floor(y / sc));
    const v = bar.px[sy * bar.w + sx]; const o = ((by + y) * W + bx + x) * 3;
    if (v < 128) { rgb[o] = rgb[o + 1] = rgb[o + 2] = 18; }
  }
  return { w: W, h: H, rgb };
}
/* ---- degraders (all in place on RGB {w,h,rgb}, return a new image) */
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
function sample(img, x, y, o) {
  const x0 = Math.floor(x), y0 = Math.floor(y); if (x0 < 0 || y0 < 0 || x0 >= img.w - 1 || y0 >= img.h - 1) return false;
  const fx = x - x0, fy = y - y0; const i = (y0 * img.w + x0) * 3, st = img.w * 3;
  for (let c = 0; c < 3; c++) o[c] = img.rgb[i + c] * (1 - fx) * (1 - fy) + img.rgb[i + 3 + c] * fx * (1 - fy) + img.rgb[i + st + c] * (1 - fx) * fy + img.rgb[i + st + 3 + c] * fx * fy;
  return true;
}
/** inverse-map warp: for each output pixel, `inv(x,y)` gives the source coordinate */
function warp(img, outW, outH, inv, fill = [60, 58, 54]) {
  const out = new Uint8Array(outW * outH * 3); const t = [0, 0, 0];
  for (let y = 0; y < outH; y++) for (let x = 0; x < outW; x++) {
    const [sx, sy] = inv(x, y); const o = (y * outW + x) * 3;
    if (sample(img, sx, sy, t)) { out[o] = t[0]; out[o + 1] = t[1]; out[o + 2] = t[2]; } else { out[o] = fill[0]; out[o + 1] = fill[1]; out[o + 2] = fill[2]; }
  }
  return { w: outW, h: outH, rgb: out };
}
export function rotate(img, deg, pad = 0.18) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const ow = Math.round((img.w * Math.abs(c) + img.h * Math.abs(s)) * (1 + pad / 3)), oh = Math.round((img.w * Math.abs(s) + img.h * Math.abs(c)) * (1 + pad / 3));
  const cx = img.w / 2, cy = img.h / 2, ocx = ow / 2, ocy = oh / 2;
  return warp(img, ow, oh, (x, y) => { const dx = x - ocx, dy = y - ocy; return [cx + dx * c + dy * s, cy - dx * s + dy * c]; });
}
/** projective tilt: the right edge is `k` (0..0.4) shorter than the left one, like a card photographed from the side */
export function perspective(img, k = 0.18) {
  const ow = Math.round(img.w * 1.05), oh = Math.round(img.h * 1.1);
  return warp(img, ow, oh, (x, y) => {
    const u = x / ow; const scale = 1 - k * u; const cy = oh / 2;
    return [(x - ow * 0.025), img.h / 2 + (y - cy) / scale * 1 - 0];
  });
}
export function blur(img, r = 1) {
  const { w, h } = img; let src = img.rgb; const tmp = new Uint8Array(src.length), dst = new Uint8Array(src.length); const n = 2 * r + 1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) { let a = 0; for (let k = -r; k <= r; k++) a += src[(y * w + Math.min(w - 1, Math.max(0, x + k))) * 3 + c]; tmp[(y * w + x) * 3 + c] = a / n; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) { let a = 0; for (let k = -r; k <= r; k++) a += tmp[(Math.min(h - 1, Math.max(0, y + k)) * w + x) * 3 + c]; dst[(y * w + x) * 3 + c] = a / n; }
  return { w, h, rgb: dst };
}
/** a soft white hot-spot (flash glare) centred at (gx, gy) fractions of the image, radius fraction, peak strength 0..1 */
export function glare(img, gx = 0.5, gy = 0.5, rad = 0.2, peak = 0.7) {
  const out = new Uint8Array(img.rgb.length); const R = rad * Math.max(img.w, img.h);
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) { const d = Math.hypot(x - gx * img.w, y - gy * img.h) / R; const g = d < 1 ? peak * (1 - d * d) : 0; const o = (y * img.w + x) * 3; for (let c = 0; c < 3; c++) out[o + c] = clamp(img.rgb[o + c] + (255 - img.rgb[o + c]) * g); }
  return { w: img.w, h: img.h, rgb: out };
}
export function noise(img, amp = 18, seed = 7) {
  let s = seed >>> 0; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const out = new Uint8Array(img.rgb.length); for (let i = 0; i < out.length; i += 3) { const n = (rnd() - 0.5) * 2 * amp; out[i] = clamp(img.rgb[i] + n); out[i + 1] = clamp(img.rgb[i + 1] + n); out[i + 2] = clamp(img.rgb[i + 2] + n); }
  return { w: img.w, h: img.h, rgb: out };
}
export function scaleTo(img, W) { const k = W / img.w; const H = Math.round(img.h * k); return warp(img, W, H, (x, y) => [x / k, y / k]); }
/** wipe a rectangle (fractions of the barcode area) to white: physical damage beyond what the error correction can repair */
export function damage(img, x0, y0, x1, y1, v = 235) { const out = Uint8Array.from(img.rgb); for (let y = Math.floor(y0 * img.h); y < y1 * img.h; y++) for (let x = Math.floor(x0 * img.w); x < x1 * img.w; x++) { const o = (y * img.w + x) * 3; out[o] = out[o + 1] = out[o + 2] = v; } return { w: img.w, h: img.h, rgb: out }; }

/* ---------------------------------------------------------------- containers */
export function toJpeg(img, quality = 80) {
  const rgba = Buffer.alloc(img.w * img.h * 4); for (let i = 0, j = 0; i < img.w * img.h; i++) { rgba[j++] = img.rgb[i * 3]; rgba[j++] = img.rgb[i * 3 + 1]; rgba[j++] = img.rgb[i * 3 + 2]; rgba[j++] = 255; }
  return Buffer.from(jpeg.encode({ data: rgba, width: img.w, height: img.h }, quality).data);
}
const crcT = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = (b) => { let c = -1; for (let i = 0; i < b.length; i++) c = crcT[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
export function toPng(img) {
  const raw = Buffer.alloc((img.w * 3 + 1) * img.h); for (let y = 0; y < img.h; y++) { raw[y * (img.w * 3 + 1)] = 0; Buffer.from(img.rgb.buffer, img.rgb.byteOffset + y * img.w * 3, img.w * 3).copy(raw, y * (img.w * 3 + 1) + 1); }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, "latin1"), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(img.w, 0); ihdr.writeUInt32BE(img.h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
/** A PDF whose pages are full-page images. pages: [{kind:"jpeg"|"flate", img}] or [{text}] for a digital page. */
export function toPdf(pages) {
  const objs = []; const add = (s) => { objs.push(s); return objs.length; };
  const kids = []; const pagesRef = 2; objs.push(null, null);
  for (const p of pages) {
    let content, res;
    if (p.img) {
      const im = p.img, W = 612, H = Math.round((612 * im.h) / im.w);
      let dict, data;
      if (p.kind === "flate") { data = zlib.deflateSync(Buffer.from(im.rgb)); dict = `/Type/XObject/Subtype/Image/Width ${im.w}/Height ${im.h}/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/FlateDecode`; }
      else { data = toJpeg(im, p.quality ?? 80); dict = `/Type/XObject/Subtype/Image/Width ${im.w}/Height ${im.h}/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/DCTDecode`; }
      const imgN = add(Buffer.concat([Buffer.from(`<<${dict}/Length ${data.length}>>\nstream\n`, "latin1"), data, Buffer.from("\nendstream", "latin1")]));
      const cs = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
      const cN = add(`<</Length ${cs.length}>>\nstream\n${cs}\nendstream`);
      kids.push(add(`<</Type/Page/Parent ${pagesRef} 0 R/MediaBox[0 0 ${W} ${H}]/Contents ${cN} 0 R/Resources<</XObject<</Im0 ${imgN} 0 R>>>>>>`));
    } else {
      const cs = `BT /F1 12 Tf 72 700 Td (${String(p.text).replace(/[()\\]/g, "")}) Tj ET`;
      const fN = add("<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>");
      const cN = add(`<</Length ${cs.length}>>\nstream\n${cs}\nendstream`);
      kids.push(add(`<</Type/Page/Parent ${pagesRef} 0 R/MediaBox[0 0 612 792]/Contents ${cN} 0 R/Resources<</Font<</F1 ${fN} 0 R>>>>>>`));
    }
  }
  objs[0] = "<</Type/Catalog/Pages 2 0 R>>";
  objs[1] = `<</Type/Pages/Kids[${kids.map((k) => k + " 0 R").join(" ")}]/Count ${kids.length}>>`;
  const parts = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")]; const offs = []; let pos = parts[0].length;
  objs.forEach((o, i) => { const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, "latin1"), Buffer.isBuffer(o) ? o : Buffer.from(o, "latin1"), Buffer.from("\nendobj\n", "latin1")]); offs.push(pos); pos += b.length; parts.push(b); });
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  parts.push(Buffer.from(xref + `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${pos}\n%%EOF\n`, "latin1"));
  return Buffer.concat(parts);
}
