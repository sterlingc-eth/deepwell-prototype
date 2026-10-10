/**
 * Wording model (api/_lib/wording): parity with the Python trainer, threshold, guards, slot carry-over, kill switch, integration, latency.
 * No database, no network, no key.   node scripts/verify-wording-model.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

delete process.env.ANTHROPIC_API_KEY;
delete process.env.DONOVAN_WORDING_MODEL;
delete process.env.DONOVAN_WORDING_TH;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const W = path.join(HERE, "../api/_lib/wording");
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) pass++; else fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`); };

const idx = await import("../api/_lib/wording/index.js");
const { adapt, buildLex, maskText, predict, scoreTokens } = idx;
const par = JSON.parse(fs.readFileSync(path.join(HERE, "wording-parity.json"), "utf8"));
const t0 = performance.now();
const lex = buildLex({ techs: par.techs, customers: par.customers }); // first call loads and parses model.json + friends
adapt("how many bills did we send out in 2024", { lex }); // first prediction builds the indexes
const coldMs = performance.now() - t0;
const roster = { techs: par.techs };
const model = JSON.parse(fs.readFileSync(path.join(W, "model.json"), "utf8"));

// 1. parity with Python (200 corpus lines)
{
  let agree = 0, tokOk = 0, probOk = 0;
  const bad = [];
  for (const l of par.lines) {
    const m = maskText(l.text, lex);
    const s = scoreTokens(m.tokens);
    const cls = model.classes[s.k];
    if (JSON.stringify(m.tokens) === JSON.stringify(l.tokens)) tokOk++; else bad.push(`tokens: ${l.text} | js=${m.tokens.join(" ")} | py=${l.tokens.join(" ")}`);
    if (cls === l.cls) agree++; else bad.push(`class: ${l.text} js=${cls} py=${l.cls}`);
    if (Math.abs(s.prob - l.prob) < 1e-4) probOk++;
  }
  check(`parity: masking identical on ${par.lines.length} lines`, tokOk === par.lines.length, bad.slice(0, 3).join("\n      "));
  check(`parity: predicted template agrees >99.5% (${agree}/${par.lines.length})`, agree / par.lines.length > 0.995, bad.slice(0, 3).join("\n      "));
  check(`parity: probabilities agree to 1e-4 (${probOk}/${par.lines.length})`, probOk / par.lines.length > 0.995);
}

// 2. model file size and threshold
{
  const sz = fs.statSync(path.join(W, "model.json")).size;
  check(`model.json under 600KB (${(sz / 1024).toFixed(0)}KB)`, sz < 600 * 1024);
  const total = fs.readdirSync(W).reduce((n, f) => n + fs.statSync(path.join(W, f)).size, 0);
  check(`wording folder under 800KB (${(total / 1024).toFixed(0)}KB)`, total < 800 * 1024);
  check(`threshold is at least 0.7 (${model.threshold})`, model.threshold >= 0.7);
  const ev = JSON.parse(fs.readFileSync(path.join(HERE, "wording-eval.json"), "utf8"));
  check(`calibration record: threshold matches and system precision >= 0.99 (system ${(ev.system.precision * 100).toFixed(1)}%, classifier+guards ${(ev.guardedClassifier.precision * 100).toFixed(1)}%)`, ev.threshold === model.threshold && ev.system.precision >= 0.99);
}

// 3. adoption and slot carry-over
const A = (q) => adapt(q, { lex, roster });
{
  const a = A("how many bills did we send out in 2024");
  check("paraphrase adopted: bills -> invoices, year carried over", a.canonical === "how many invoices did we send out in 2024", JSON.stringify(a));
  const b = A("number of folks located in Gilbert");
  check("city carried over verbatim", b.canonical === "number of clients located in Gilbert", JSON.stringify(b));
  const c = A("gimme the average invoice size for Kevin Pratt");
  check("technician name carried over verbatim", c.canonical === "average invoice amount for Kevin Pratt", JSON.stringify(c));
  const d = A("what is the vendor on PO-9004");
  check("document number carried over", d.canonical === "vendor on PO-9004", JSON.stringify(d));
  const e = A("Joseph Norwood's phone and email");
  check("customer name carried over", e.canonical === "Joseph Norwood phone and email", JSON.stringify(e));
  const f = A("how many customers are not in Mesa");
  check("negation template keeps its negation", f.canonical === "how many customers are not in Mesa", JSON.stringify(f));
}

// 4. guards on the ORIGINAL question: each must refuse
{
  const blocked = [
    ["unused period", "how many customers have no phone number on file for Q3 2023", /unused-zzperiod/],
    ["unused second year", "how many invoices in 2024 were over 5k", /unused-zzyear/],
    ["unused place", "how many customers have no email in Mesa", /unused|slots/],
    ["unused negation", "how many customers are in Mesa but not Tempe", /negation|unused/],
    ["dropped 'not'", "how many customers have a phone number", /negation-missing|low|none|unused/],
    ["second clause", "average invoice amount and who wrote the most invoices", /second-clause|polarity|measure/],
    ["polarity flip: fewest", "which customer has written the fewest invoices", /polarity|low|none|noun|unused/],
    ["polarity flip: least recent", "Kevin Pratt's least recent job", /polarity|low|none|noun|unused/],
    ["changed noun: payment", "when was Linda Fitzgerald's last payment", /noun|doctype|polarity|low|none/],
    ["changed noun: call", "when was Linda Fitzgerald's last call", /noun|doctype|polarity|low|none/],
    ["changed noun: first ticket", "when was the first ticket for Linda Fitzgerald", /noun|doctype|polarity|low|none/],
    ["changed doc type", "average work order amount", /doctype|noun|low|none/],
    ["changed measure", "top 5 customers by total proposed", /noun|measure|low|none/],
    ["desire", "does Linda Fitzgerald want a maintenance agreement", /modality|low|none/],
    ["need", "does Linda Fitzgerald need a maintenance agreement", /modality|low|none/],
    ["future will", "will Linda Fitzgerald have a maintenance agreement", /modality|low|none/],
    ["dropped scope: per tech", "average invoice amount per tech", /scope|noun|low|none|unused/],
    ["dropped scope: per customer", "how many invoices per customer", /scope|low|none|unused/],
    ["dropped scope: each", "average invoice amount for each customer", /scope|low|none|unused/],
    ["dropped scope: near", "how many customers near Mesa", /scope|low|none|unused/],
    ["dropped scope: under warranty", "how many units under warranty", /scope|low|none|unused/],
    ["count asked, list template", "how many units were installed in 2024", /count-vs-list/],
    ["unknown concept word", "how many invoices did we send out in 2024 that are overdue", /unknown-word|unused|low|noun/],
    ["not a catalogued shape", "when is Barbara Ellison's next appointment", /none|low/],
  ];
  for (const [name, q, rx] of blocked) {
    const a = A(q);
    check(`guard blocks: ${name}`, !a.canonical && rx.test(a.skip ?? ""), JSON.stringify(a));
  }
  check("follow-up templates are not adopted (the conversation engine folds those)", (() => { const a = adapt("what about 2020?", { lex, roster, threshold: 0 }); return !a.canonical; })());
  check("decline templates are not adopted here (early decline owns them)", (() => { const a = adapt("what's our net profit for the quarter", { lex, roster, threshold: 0 }); return !a.canonical; })());
}

// 5. kill switch
{
  process.env.DONOVAN_WORDING_MODEL = "0";
  const a = A("how many bills did we send out in 2024");
  check("kill switch: adapt refuses", !a.canonical && a.skip === "off", JSON.stringify(a));
  const { classifyAll } = await import("../api/_lib/router/classifyAll.js");
  const o = await classifyAll("number of folks located in Gilbert", { today: "2026-10-07" });
  check("kill switch: classifyAll adds no wording", !o.wording);
  delete process.env.DONOVAN_WORDING_MODEL;
}

// 6. classifyAll integration: adopts only an unclaimed question, never overrides a claim
{
  const { classifyAll } = await import("../api/_lib/router/classifyAll.js");
  const tv = { technicians: { phrases: par.techs, words: [] }, customers: { phrases: par.customers, words: [] }, brands: [], cities: [] };
  const ctx = { today: "2026-10-07", tenantVocab: tv };
  process.env.DONOVAN_WORDING_MODEL = "0";
  const claimedQs = ["how many invoices in 2024", "how many customers are in Mesa", "average invoice amount"];
  const base = [];
  for (const q of claimedQs) base.push(await classifyAll(q, ctx));
  const unclaimed = [];
  for (const q of ["Joseph Norwood documents count?", "Scottsdale customers count and Mesa customers count", "yo how many unis use r-454b"]) unclaimed.push([q, await classifyAll(q, ctx)]);
  delete process.env.DONOVAN_WORDING_MODEL;
  for (let i = 0; i < claimedQs.length; i++) {
    const o = await classifyAll(claimedQs[i], ctx);
    check(`existing claim untouched: "${claimedQs[i]}"`, base[i].winner && !o.wording && o.winner?.name === base[i].winner.name && o.effectiveQuestion === base[i].effectiveQuestion);
  }
  let adopted = 0;
  for (const [q, b] of unclaimed) {
    const o = await classifyAll(q, ctx);
    if ((!b.winner || b.winner.name === "analytics") && o.winner && o.winner.name !== "analytics" && o.wording && o.effectiveQuestion !== q) adopted++;
  }
  check(`unclaimed paraphrases are adopted through classifyAll (${adopted}/${unclaimed.length})`, adopted >= 3);
}

// 7. latency
{
  const qs = par.lines.map((l) => l.text);
  const times = [];
  for (let r = 0; r < 3; r++) for (const q of qs) { const s = performance.now(); adapt(q, { lex, roster }); times.push(performance.now() - s); }
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length / 2)], p95 = times[Math.floor(times.length * 0.95)];
  console.log(`INFO  cold load (model + data files, first call): ${coldMs.toFixed(0)} ms | adapt() p50 ${p50.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms`);
  check("latency: adapt() p95 under 15 ms", p95 < 15, `p95=${p95.toFixed(2)}`);
  check("latency: cold load under 400 ms", coldMs < 400, `${coldMs.toFixed(0)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
