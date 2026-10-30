// ingest1 / ingest_image.js - image stage for the Node/Vercel app: orientation (4-way OCR probe), crop to the page, projection-profile deskew, illumination flatten (CLAHE),
// denoise, upscale to ~22px text height, and several OCR passes (psm 6/4/11 on the flattened gray + psm 6 on an Otsu binary). `sharp` is the only dependency (optional, lazy-loaded);
// the OCR engine is injected: ocr(pngBuffer, { psm }) -> [{ l, t, w, h, c, s }]  (tesseract.js worker, a tesseract binary, or any engine that returns word boxes).
// Not ported from the Python prototype: perspective rectification of curved/keystoned photos and stamp-frame removal (need OpenCV); both are fail-soft omissions.
import { passScore, passesToPage } from "./ingest_ocr.js";
let _sharp; async function sharp() { if (_sharp !== undefined) return _sharp; try { _sharp = (await import("sharp")).default; } catch { _sharp = null; } return _sharp; }
export const imageStageAvailable = async () => !!(await sharp());
async function gray(sh) { const { data, info } = await sh.clone().greyscale().raw().toBuffer({ resolveWithObject: true }); return { data, w: info.width, h: info.height }; }
function otsu(data) { const hist = new Array(256).fill(0); for (let i = 0; i < data.length; i += 3) hist[data[i]]++; const tot = hist.reduce((a, b) => a + b, 0); let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i]; let sB = 0, wB = 0, best = 0, th = 128; for (let i = 0; i < 256; i++) { wB += hist[i]; if (!wB) continue; const wF = tot - wB; if (!wF) break; sB += i * hist[i]; const mB = sB / wB, mF = (sum - sB) / wF; const v = wB * wF * (mB - mF) ** 2; if (v > best) { best = v; th = i; } } return th; }
// crop to the bright page region (page photographed on a darker surface)
async function cropPage(sh) {
  const g = await gray(sh.clone().resize({ width: 400, fit: "inside" })); const th = otsu(g.data); let x0 = g.w, x1 = 0, y0 = g.h, y1 = 0; const rows = new Array(g.h).fill(0), cols = new Array(g.w).fill(0);
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) if (g.data[y * g.w + x] > th) { rows[y]++; cols[x]++; }
  const rt = g.w * 0.35, ct = g.h * 0.35; for (let y = 0; y < g.h; y++) if (rows[y] > rt) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); } for (let x = 0; x < g.w; x++) if (cols[x] > ct) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
  if (x1 - x0 < g.w * 0.5 || y1 - y0 < g.h * 0.5 || (x1 - x0 > g.w * 0.97 && y1 - y0 > g.h * 0.97)) return { sh, cropped: false };
  const meta = await sh.metadata(); const k = meta.width / g.w; const pad = 4;
  return { sh: sh.clone().extract({ left: Math.max(0, Math.floor((x0 - pad) * k)), top: Math.max(0, Math.floor((y0 - pad) * k)), width: Math.min(meta.width, Math.ceil((x1 - x0 + 2 * pad) * k)), height: Math.min(meta.height, Math.ceil((y1 - y0 + 2 * pad) * k)) }), cropped: true };
}
async function skewAngle(sh) {   // projection-profile search on a ~700px binarised copy
  const base = sh.clone().resize({ width: 700, height: 700, fit: "inside" }).greyscale(); let best = 0, bv = -1;
  const score = async (ang) => { const { data, info } = await base.clone().rotate(ang, { background: { r: 255, g: 255, b: 255, alpha: 1 } }).raw().toBuffer({ resolveWithObject: true }); const th = otsu(data) * 0.9; const rows = new Float64Array(info.height); for (let y = 0; y < info.height; y++) { let s = 0; for (let x = 0; x < info.width; x++) if (data[y * info.width + x] < th) s++; rows[y] = s; } let v = 0; for (let y = 1; y < info.height; y++) v += (rows[y] - rows[y - 1]) ** 2; return v; };
  for (let a = -6; a <= 6.01; a += 1) { const v = await score(a); if (v > bv) { bv = v; best = a; } } const c = best; for (let a = c - 0.8; a <= c + 0.81; a += 0.2) { const v = await score(a); if (v > bv) { bv = v; best = a; } } return Math.round(best * 10) / 10;
}
const png = (sh) => sh.clone().png().toBuffer();
export async function prepareImage(input, ocr, opt = {}) {
  const S = await sharp(); if (!S) throw new Error("sharp not available"); let sh = S(input).rotate().greyscale();   // honour EXIF orientation
  const c = await cropPage(sh); sh = c.sh;
  // orientation: 4-way probe on a downscaled copy; upright pages exit early
  const small = (s) => s.clone().resize({ width: 1100, height: 1100, fit: "inside", withoutEnlargement: true }); let bestK = 0, bestS = -1;
  for (const k of [0, 90, 180, 270]) { const buf = await png(small(sh).rotate(k, { background: { r: 255, g: 255, b: 255, alpha: 1 } })); const s = passScore({ words: await ocr(buf, { psm: 6 }) }); if (s > bestS) { bestS = s; bestK = k; } if (k === 0 && s > 180) break; }
  if (bestK) sh = S(await sh.clone().rotate(bestK, { background: { r: 255, g: 255, b: 255, alpha: 1 } }).png().toBuffer());
  const ang = await skewAngle(sh); if (Math.abs(ang) > 0.15) sh = S(await sh.clone().rotate(ang, { background: { r: 255, g: 255, b: 255, alpha: 1 } }).png().toBuffer());
  const meta = await sh.metadata(); const scale = Math.min(3, Math.max(1, (opt.targetWidth || 2200) / meta.width)); const up = sh.clone().resize({ width: Math.round(meta.width * scale), kernel: "lanczos3" });
  const flat = S(await up.clone().clahe({ width: 64, height: 64, maxSlope: 3 }).normalise().median(3).png().toBuffer());
  const g = await gray(flat); const th = otsu(g.data); const bin = await flat.clone().threshold(th).png().toBuffer();
  return { gray: await png(flat), bin, meta: { rot: bestK, skew: ang, cropped: c.cropped, scale } };
}
export async function ocrImage(input, ocr, opt = {}) {
  const pr = await prepareImage(input, ocr, opt); const passes = [];
  for (const [variant, buf, psm] of [["gray", pr.gray, 6], ["gray", pr.gray, 4], ["gray", pr.gray, 11], ["otsu", pr.bin, 6]]) passes.push({ psm, variant, scale: 1, words: await ocr(buf, { psm }) });
  return { ...passesToPage(passes, opt), meta: pr.meta };
}
