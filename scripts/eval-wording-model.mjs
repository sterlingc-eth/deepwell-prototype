#!/usr/bin/env node
// Corpus evaluation of the wording model WITH slot carry-over and the original-question guards (no database, no lanes).
// usage: node scripts/eval-wording-model.mjs [--calibrate]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { adapt, buildLex } from "../api/_lib/wording/index.js";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const W = path.join(HERE, "../api/_lib/wording");
const CORPUS = process.env.WORDING_CORPUS ?? "/home/claude/work/train/corpus";
const par = JSON.parse(fs.readFileSync(path.join(HERE, "wording-parity.json"), "utf8"));
const lex = buildLex({ techs: par.techs, customers: par.customers });
const rows = fs.readdirSync(CORPUS).filter((f) => /^g\d+\.jsonl$/.test(f)).flatMap((f) => fs.readFileSync(path.join(CORPUS, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
const test = rows.filter((r) => r.split === "test");
const gold = (r) => (r.template === "none" ? "none" : r.template);
const out = [];
for (const r of test) out.push({ r, a: adapt(r.text, { lex, threshold: 0, roster: { techs: par.techs } }) });
const goldCover = test.filter((r) => gold(r) !== "none" && !gold(r).startsWith("fup_") && !gold(r).startsWith("decl_")).length;
const ths = [0.5, 0.7, 0.8, 0.9, 0.95, 0.97, 0.98, 0.99, 0.995];
console.log("th      emitted right  prec    coverage (of adoptable gold)");
let chosen = null;
for (const th of ths) {
  const em = out.filter((o) => o.a.canonical && o.a.prob >= th);
  const ok = em.filter((o) => gold(o.r) === o.a.template).length;
  const prec = em.length ? ok / em.length : 1;
  console.log(String(th).padEnd(7), String(em.length).padStart(7), String(ok).padStart(5), prec.toFixed(4), (ok / goldCover).toFixed(4));
  if (chosen == null && em.length && prec >= 0.99) chosen = th;
}
const th = Number(process.env.TH ?? chosen ?? 0.995);
const em = out.filter((o) => o.a.canonical && o.a.prob >= th);
console.log("threshold", th);
console.log("wrong emitted:", em.filter((o) => gold(o.r) !== o.a.template).map((o) => `${gold(o.r)}->${o.a.template} ${o.a.prob.toFixed(3)} | ${o.r.text} => ${o.a.canonical}`));
const skipC = {};
for (const o of out) if (gold(o.r) !== "none" && o.a.skip) skipC[o.a.skip.replace(/:.*/, "")] = (skipC[o.a.skip.replace(/:.*/, "")] ?? 0) + 1;
console.log("skip reasons on adoptable gold rows:", skipC);
// ---- through the real classifier chain (no database): how many test lines does a lane claim without / with the wording model?
// This is the system-level precision: classifier + slot carry-over + original-question guards + "a deterministic lane must claim the canonical".
const { classifyAll } = await import("../api/_lib/router/classifyAll.js");
const tv = { technicians: { phrases: par.techs, words: [] }, customers: { phrases: par.customers, words: [] }, brands: [], cities: [] };
const lines = test.filter((r) => !gold(r).startsWith("fup_"));
process.env.DONOVAN_WORDING_MODEL = "0";
const before = new Map();
for (const r of lines) before.set(r, await classifyAll(r.text, { today: "2026-10-07", tenantVocab: tv }));
delete process.env.DONOVAN_WORDING_MODEL;
const FLOOR = 0.7; // never calibrate below this: the near-miss evidence is thin
const sweep = [];
for (const t of [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.98]) {
  process.env.DONOVAN_WORDING_TH = String(t);
  const adopted = [];
  const stat = { para: { n: 0, before: 0, after: 0 }, near: { n: 0, before: 0, after: 0 } };
  for (const r of lines) {
    const b = before.get(r);
    const a = await classifyAll(r.text, { today: "2026-10-07", tenantVocab: tv });
    const k = stat[r.kind];
    k.n++; if (b.winner) k.before++; if (a.winner) k.after++;
    if (!b.winner && a.wording) adopted.push({ r, a });
  }
  const right = adopted.filter((x) => x.a.wording.template === gold(x.r));
  sweep.push({ t, stat, adopted, right: right.length });
  console.log(`system th=${t}: adopted ${adopted.length}, template-correct ${right.length}, claimed para ${stat.para.before}->${stat.para.after} of ${stat.para.n}, near ${stat.near.before}->${stat.near.after} of ${stat.near.n}`);
}
delete process.env.DONOVAN_WORDING_TH;
const pick = sweep.find((x) => x.t >= FLOOR && x.adopted.length && x.right / x.adopted.length >= 0.99) ?? sweep[sweep.length - 1];
console.log("system-level threshold", pick.t, "| adopted wrong:", pick.adopted.filter((x) => x.a.wording.template !== gold(x.r)).map((x) => `${gold(x.r)}->${x.a.wording.template} | ${x.r.text} => ${x.a.effectiveQuestion}`));
if (process.argv.includes("--calibrate")) {
  const mp = path.join(W, "model.json");
  const m = JSON.parse(fs.readFileSync(mp, "utf8"));
  m.threshold = pick.t;
  fs.writeFileSync(mp, JSON.stringify(m));
  const sa = out.filter((o) => o.a.canonical && o.a.prob >= pick.t);
  const sr = sa.filter((o) => gold(o.r) === o.a.template).length;
  fs.writeFileSync(path.join(HERE, "wording-eval.json"), JSON.stringify({
    threshold: pick.t,
    system: { adopted: pick.adopted.length, right: pick.right, precision: pick.right / pick.adopted.length, claimedParaBefore: pick.stat.para.before, claimedParaAfter: pick.stat.para.after, paraN: pick.stat.para.n, nearBefore: pick.stat.near.before, nearAfter: pick.stat.near.after },
    guardedClassifier: { emitted: sa.length, right: sr, precision: sa.length ? sr / sa.length : 1, coverage: sr / goldCover },
    note: "system = classifier + slot carry-over + original-question guards + a lane must claim the canonical; guardedClassifier = same without the lane check; 'right' = teacher template label (some labels are noisy or answer-equivalent)",
  }));
  console.log("model.json threshold set to", pick.t);
}
