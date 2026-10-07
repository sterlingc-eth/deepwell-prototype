#!/usr/bin/env node
/**
 * FORGE promise bank (report-only): the website's example questions, 5 phrasings each, run through the REAL /api/ask path offline
 * on a realistic fake org with look-alike traps (+ org B for isolation). Truth comes from the raw rows (scripts/lib/forge-promise-bank.mjs).
 * Classes: RIGHT / HONEST DECLINE / CONFIDENT WRONG / NEEDS MODEL (no-model pass); then the model is stubbed with a correct, a wrong-figure and a
 * wrong-citation answer for every NEEDS MODEL row. Usage: node scripts/verify-forge-promises.mjs [--strict] [--only key] [--industry name] [--rows]
 * --strict exits 1 if any CONFIDENT WRONG remains in any pass (the default run only reports).
 */
const args = process.argv.slice(2);
const flag = (n) => args.includes(n); const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const only = opt("--only"), industry = opt("--industry");
const off = await import("./offline-exam.mjs");
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === "string" && /^\{"(route|event|timestamp|level)"/.test(a[0])) return; realLog(...a); };
console.warn = () => {}; console.error = () => {};
await off.installPgHarness(); const modelCounter = await off.installModelBlock();
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const { askViaHandler } = await import("../api/_lib/scorecard/askCall.js");
const { default: askHandler } = await import("../api/ask.js");
const { parsePassages } = await import("./lib/r40-model-stub.mjs");
const bank = await import("./lib/forge-promise-bank.mjs");
const { default: Anthropic } = await import("@anthropic-ai/sdk");
const proto = Object.getPrototypeOf(new Anthropic({ apiKey: "x" }).messages);
const blocked = proto.create; const stub = { fn: null };
proto.create = async function (req) {
  if (!stub.fn) return blocked.call(this, req);
  const blocks = req.messages?.[0]?.content ?? []; const text = Array.isArray(blocks) ? blocks.map((b) => b.text ?? "").join("\n") : String(blocks);
  return { content: [{ type: "tool_use", name: "answer", input: stub.fn(text) }], usage: { input_tokens: 10, output_tokens: 10 }, stop_reason: "tool_use" };
};
const A = bank.buildOrgA(), B = bank.buildOrgB();
const ctxA = (await off.loadExportIntoNewTenant(lite, A.data, { tenantKey: "forge:a", tenantName: "forge-a" })).ctx;
const ctxB = (await off.loadExportIntoNewTenant(lite, B.data, { tenantKey: "forge:b", tenantName: "forge-b" })).ctx;
const authOf = (c) => ({ tenantId: c.tenantKey, orgId: c.tenantName, userId: null });
const fileOf = Object.fromEntries([...A.data.documents, ...B.data.documents].map((d) => [d.id, d.original_filename]));
const idOf = Object.fromEntries(Object.entries(fileOf).map(([k, v]) => [v, k]));
const TODAY = "2026-10-07";
const latencies = [];
const ask = async (ctx, q) => { modelCounter.n = 0; const r = await askViaHandler({ handler: askHandler, auth: authOf(ctx), question: q, today: TODAY }); latencies.push(r.latencyMs); return { ...r, models: modelCounter.n }; };

// ---- normalisation: money -> cents, dates -> ISO ----
const MONTHS = "january february march april may june july august september october november december".split(" ");
const money = (t) => [...String(t).matchAll(/\$\s?([\d,]+(?:\.\d{1,2})?)/g)].map((m) => "m" + (+m[1].replace(/,/g, "")).toFixed(2));
const dates = (t) => {
  const out = [], s = String(t);
  for (const m of s.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) out.push(`d${m[1]}-${m[2]}-${m[3]}`);
  for (const m of s.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) out.push(`d${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`);
  for (const m of s.matchAll(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(\d{4})\b/gi)) out.push(`d${m[3]}-${String(MONTHS.indexOf(m[1].toLowerCase()) + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`);
  return out;
};
const norm = (t) => [...money(t), ...dates(t)];
const asNorm = (a) => norm(/^[\d,]+\.\d\d$/.test(a) ? "$" + a : a);
const plainAllowed = (arr) => new Set(arr.flatMap(asNorm));
const ansText = (d) => [d?.text, ...(d?.facts ?? []).map((f) => `${f.label ?? ""} ${f.value ?? ""}`)].join(" \n ");
const citedFiles = (d) => [...new Set([...(d?.facts ?? []).flatMap((f) => f.sources ?? []), ...(d?.sources ?? [])].map((s) => fileOf[s.documentId]).filter(Boolean))];
const NAMES = A.data.entities.filter((e) => e.entity_type === "customer").map((e) => e.data.customer_name);
const leakB = B.T.leakTokens, leakA = bank.leakTokensForA();

function classify(q, r, ctxName = "A") {
  if (r.error || !r.data) return { c: r.models ? "NEEDS MODEL" : "HONEST DECLINE", why: r.error ?? "no data" };
  const d = r.data, t = ansText(d), low = t.toLowerCase(), figs = norm(t), files = citedFiles(d);
  const declineKind = ["no-answer", "clarify", "decline", "refusal"].includes(d.kind) || /couldn'?t find|can'?t answer|which (one|customer|address|job|vendor)|more than one|no earlier question|nothing in your records/i.test(d.text ?? "");
  if (r.models && !figs.length && !files.length && declineKind) return { c: "NEEDS MODEL", why: "declined after a blocked model call" };
  for (const tok of ctxName === "A" ? leakB : leakA) if (t.includes(tok) || files.includes(tok)) return { c: "CONFIDENT WRONG", why: `other org's data leaked: ${tok}` };
  if (q.contextual) {
    const pick = NAMES.find((n) => low.includes(n.toLowerCase())) || files.length;
    if (figs.length || pick) return { c: "CONFIDENT WRONG", why: `answered a "this ..." question with no context: ${figs[0]?.slice(1) ?? pick}` };
    return { c: "HONEST DECLINE", why: `${d.kind}: ${(d.text ?? "").slice(0, 60)}` };
  }
  for (const f of q.forbid ?? []) if (t.includes(f)) return { c: "CONFIDENT WRONG", why: `shows ${f} (look-alike/unrelated)` };
  const allowed = plainAllowed(q.allowed ?? []);
  const bad = figs.filter((f) => !allowed.has(f));
  if (q.numeric) { const nums = [...t.matchAll(/\b(\d+)\b/g)].map((m) => m[1]).filter((n) => !/^(20\d\d)$/.test(n)); if (nums.length && !nums.every((n) => (q.allowed ?? []).includes(n))) return { c: "CONFIDENT WRONG", why: `states ${nums.join(",")}, truth ${q.allowed.join(",")}` }; }
  if (bad.length) return { c: "CONFIDENT WRONG", why: `shows ${bad[0].slice(1)} (not in the truth)` };
  if (q.noneIsWrong && /no pieces|none|no units|0 units/i.test(low) && !figs.length) return { c: "CONFIDENT WRONG", why: "says none but records exist" };
  const claim = figs.length > 0 || (q.listFiles && files.length > 0) || (q.files?.length && files.length > 0 && !declineKind);
  if (claim && q.files?.length) { const stray = files.filter((f) => !q.files.includes(f)); if (stray.length) return { c: "CONFIDENT WRONG", why: `cites ${stray[0]} (wrong document)` }; }
  const has = (g) => g.some((x) => low.includes(String(x).toLowerCase()) || asNorm(String(x)).some((n) => figs.includes(n)) || files.includes(x));
  if (q.need?.length) {
    const ok = q.needAnyOf ? q.need.some(has) : q.need.every(has);
    if (ok) return { c: "RIGHT", why: files.length ? "answer and citation match the raw rows" : "correct but no source shown" };
    return figs.length ? { c: "CONFIDENT WRONG", why: "incomplete: required figure missing" } : { c: "HONEST DECLINE", why: `${d.kind}: ${(d.text ?? "").slice(0, 60)}` };
  }
  if (q.listFiles) return q.files.every((f) => files.includes(f)) ? { c: "RIGHT", why: "all documents listed" } : { c: "HONEST DECLINE", why: `${d.kind}: ${(d.text ?? "").slice(0, 60)}` };
  if (!claim) return { c: "HONEST DECLINE", why: `${d.kind}: ${(d.text ?? "").slice(0, 60)}` };
  return { c: "RIGHT", why: "claims supported by the raw rows" };
}

const wrongValue = (v) => (/^\$?[\d,]+\.\d\d$/.test(v) ? "$9,999.00" : /\//.test(v) ? "01/01/2031" : /^\d+$/.test(v) ? String(+v + 6) : v === "20A" ? "60A" : "$9,999.00");
function stubFor(q, mode) {
  const m = q.model;
  return (prompt) => {
    const ps = parsePassages(prompt);
    const pick = (f) => ps.find((p) => p.file === f) ?? (idOf[f] ? { documentId: idOf[f], page: 1 } : ps[0]);
    const doc = mode === "cite" ? pick(m.wrongFile) : pick(m.file);
    let text = m.text, value = m.value || "on file";
    if (mode === "figure") { const wv = wrongValue(m.value); text = m.value ? text.replace(m.value.replace(/^\$/, ""), wv.replace(/^\$/, "")) : `${text} $9,999.00 on file.`; value = m.value ? wv : "$9,999.00"; }
    return { text, confidence: 0.95, facts: [{ label: "Answer", value, status: "info", sources: doc ? [{ documentId: doc.documentId, location: { page: doc.page } }] : [] }] };
  };
}

// ---- run ----
const questions = bank.buildQuestions(A.T).filter((q) => (!only || q.key === only) && (!industry || q.pages.includes(industry)));
const rows = [];
for (const q of questions) {
  for (let i = 0; i < q.p.length; i++) {
    stub.fn = null;
    const r = await ask(ctxA, q.p[i]); const base = classify(q, r);
    const row = { key: q.key, phr: i, q: q.p[i], pages: q.pages, none: base, dump: flag("--dump") ? { t: ansText(r.data).slice(0, 200), f: citedFiles(r.data) } : null };
    if (base.c === "NEEDS MODEL" && q.model) {
      for (const mode of ["correct", "figure", "cite"]) { stub.fn = stubFor(q, mode); const rr = await ask(ctxA, q.p[i]); row[mode] = classify(q, rr); }
      stub.fn = null;
    }
    rows.push(row);
  }
  // isolation: org B must never see org A's data (and gets its own, different answer)
  stub.fn = null; const rb = await ask(ctxB, q.p[0]); const tb = ansText(rb.data);
  for (const tok of leakA) if (tb.includes(tok)) rows.push({ key: q.key, phr: "B", q: q.p[0], pages: q.pages, none: { c: "CONFIDENT WRONG", why: `org A data leaked into org B: ${tok}` } });
}
const count = (sel) => { const o = { RIGHT: 0, "HONEST DECLINE": 0, "CONFIDENT WRONG": 0, "NEEDS MODEL": 0 }; for (const r of rows) { const c = sel(r); if (c) o[c.c]++; } return o; };
const nm = rows.filter((r) => r.none.c === "NEEDS MODEL");
const sub = (mode) => { const o = { RIGHT: 0, "HONEST DECLINE": 0, "CONFIDENT WRONG": 0 }; for (const r of nm) if (r[mode]) o[r[mode].c] = (o[r[mode].c] ?? 0) + 1; return o; };
if (flag("--dump")) for (const r of rows) realLog(r.q, JSON.stringify(r.dump ?? "").slice(0, 400));
if (flag("--rows")) for (const r of rows) realLog(`${r.key.padEnd(24)} ${String(r.phr).padEnd(2)} ${r.none.c.padEnd(16)} ${r.none.why.slice(0, 80)}${r.correct ? `  | model ok:${r.correct.c} fig:${r.figure.c} cite:${r.cite.c}` : ""}`);
realLog("\nper question (5 phrasings): no model right / decline / wrong / needs-model | model-correct right | wrong-figure confident-wrong | wrong-citation confident-wrong");
realLog("| question | R | D | W | NM | model ok R | wf CW | wc CW |\n|---|---|---|---|---|---|---|---|");
for (const q of questions) {
  const rs = rows.filter((r) => r.key === q.key); const c = (f) => rs.filter(f).length; const n = rs.filter((r) => r.none.c === "NEEDS MODEL");
  realLog(`| ${q.key} | ${c((r) => r.none.c === "RIGHT")} | ${c((r) => r.none.c === "HONEST DECLINE")} | ${c((r) => r.none.c === "CONFIDENT WRONG")} | ${n.length} | ${n.filter((r) => r.correct?.c === "RIGHT").length} | ${n.filter((r) => r.figure?.c === "CONFIDENT WRONG").length} | ${n.filter((r) => r.cite?.c === "CONFIDENT WRONG").length} |`);
}
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const none = count((r) => r.none);
realLog(`\nSCOREBOARD cases=${rows.length} no-model: ${JSON.stringify(none)}`);
realLog(`  needs-model=${nm.length}: correct ${JSON.stringify(sub("correct"))} | wrong-figure ${JSON.stringify(sub("figure"))} | wrong-citation ${JSON.stringify(sub("cite"))}`);
realLog(`  latency ms p50=${pct(latencies, 0.5)} p95=${pct(latencies, 0.95)} (n=${latencies.length})`);
const cw = none["CONFIDENT WRONG"] + sub("correct")["CONFIDENT WRONG"] + sub("figure")["CONFIDENT WRONG"] + sub("cite")["CONFIDENT WRONG"];
if (flag("--strict") && cw) { realLog(`STRICT: ${cw} confident-wrong outcomes`); process.exit(1); }
process.exit(0);
