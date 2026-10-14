// Shared simulation helpers (round 24): read factory banks, deterministic sampling.
import fs from "node:fs"; import zlib from "node:zlib"; import path from "node:path";
export const FACT = "/home/claude/work/factory";
export function readBank(dir, company, split, { filter = null } = {}) {
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.startsWith(company + "-")).sort()) {
    for (const l of zlib.gunzipSync(fs.readFileSync(path.join(dir, f))).toString().split("\n")) { if (!l) continue; const r = JSON.parse(l); if (r.split !== split) continue; if (filter && !filter(r)) continue; out.push(r); }
  }
  return out;
}
export function sampleN(arr, n, seed = 1) {
  let s = seed >>> 0; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}
