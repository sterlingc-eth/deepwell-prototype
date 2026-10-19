#!/usr/bin/env node
/**
 * verify:handoff - the HANDOFF rule (api/_lib/router/releaseGate.js, api/ask.js send()):
 *   when Donovan's own lanes release a question, the Claude path gets it; a plain "not on file" is allowed ONLY when the lane verified the fact is absent.
 *
 * Runs the REAL /api/ask handler (in-process, PGlite) on synthetic tenants (scripts/fixtures/reader-v2/companies) with Reader V2 ON and the Claude model replaced by a counting mock.
 * FAILS when any answerable question (the answer is in that company's own rows) ends as a decline without the Claude path having run.
 * Also checks: a decline that is verified final stays final, a Reader V2 failure / timeout escalates, an exhausted spend cap still reaches the cheaper model path,
 * escalation never shows another company's data, and (negative control) that the handoff switched OFF really does leave declines, so this test cannot pass by accident.
 *   node scripts/verify-handoff.mjs            quick set (about 2 minutes)
 *   node scripts/verify-handoff.mjs --big      the full census set (about 15 minutes)
 * No network, no key, no real model call. Synthetic documents only.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const SELF = fileURLToPath(import.meta.url);
const BIG = process.argv.includes("--big");
const CHILD = process.argv.includes("--agent-off");
let failures = 0, passes = 0;
const check = (name, ok, detail = "") => { if (ok) passes++; else failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`); };

const G = await import("../api/_lib/router/releaseGate.js");
const A = await import("../api/_lib/dql/reader-v2/app.js");

/* ---------------------------------------------------------------- 1. the rule itself (pure) */
if (!CHILD) {
  const decl = (extra = {}) => ({ kind: "no-answer", text: "x", ...extra });
  check("a plain decline is escalated", G.isEscalatableRelease(decl()));
  check("clarify chips for a recognised entity are escalated (chips are only the fallback)", G.isEscalatableRelease(decl({ clarify: true, clarifyReason: "recognised-entity" })));
  check("an ambiguous surname is final (only the person can settle it)", !G.isEscalatableRelease(decl({ clarify: true, clarifyReason: "ambiguous-surname" })));
  check("a verified-absent decline is final", !G.isEscalatableRelease(G.markFinal(decl(), "absent-name")) && !G.isEscalatableRelease(decl({ addressMiss: true })));
  check("a policy / privacy refusal is final", !G.isEscalatableRelease(G.markFinal(decl(), "policy")) && !G.isEscalatableRelease(G.markFinal(decl(), "private")));
  check("a help answer is final", !G.isEscalatableRelease(decl({ help: true })));
  check("an answer is never re-escalated; neither is a request a model path already ran for", !G.isEscalatableRelease({ kind: "answer" }) && !G.isEscalatableRelease(decl(), { touched: true }));
  check("the marker is server-only", !("finalDecline" in G.stripReleaseMarker(G.markFinal(decl(), "policy"))));
  check("cause labels", G.releaseCause(decl({ clarify: true, clarifyReason: "recognised-entity" })) === "clarify:recognised-entity" && G.releaseCause(decl({ text: "No purchase order PO-1 on file." })) === "docnumber-no-match" && G.releaseCause(decl({ text: "Nothing in your records answers that yet. x" })) === "honest-zero");
  check("handoff switch: on by default, DONOVAN_RELEASE_ESCALATION=0 turns it off", G.releaseEscalationEnabled({}) && !G.releaseEscalationEnabled({ DONOVAN_RELEASE_ESCALATION: "0" }));
  // Reader V2 answer fit: a broad answer where one fact was asked goes to Claude instead
  check("V2 fit: 'who is at this address' is not an answer to a question about the compressor", !A.answerFits("has this unit had a compressor replaced? 174 n college ave, mesa, az 85201", { intent: "who_addr" }) && !A.answerFits("do we have the permit for the mesa install at 174 n college ave", { intent: "who_addr" }));
  check("V2 fit: a real who-question still fits", A.answerFits("cust at 618 n power rd casa grande", { intent: "who_addr" }) && A.answerFits("who is staying at 6940 S Kingfisher Ct", { intent: "who_addr" }) && A.answerFits("total on er-1896", { intent: "total" }));
  const U = await import("../api/_lib/lookups/unknownName.js");
  check("unknown-name gate: 'for the newsletter' is not a person nobody has heard of", U.extractNamePhrase("List customers missing a phone number for the newsletter") == null && U.extractNamePhrase("phone number for Zelda Pemberton") === "Zelda Pemberton");
}

/* ---------------------------------------------------------------- 2. end to end */
const { boot, loadCompany, loadExpected } = await import("./lib/handoff-harness.mjs");
const { generate, judge } = await import("./lib/handoff-questions.mjs");
const H = await boot({ v2: true, release: true });
const KEYS = ["pg_re0_title", "pn_re1_commercial"]; const data = {}; const sets = {};
const expected = loadExpected(); let seed = 11;
for (const k of KEYS) {
  data[k] = loadCompany(k); await H.addTenant(k, data[k]);
  const n = BIG ? 1 : 0.35;
  const qs = generate(data[k], { seed: seed++, nAnswerable: Math.round(220 * n), nAbsent: Math.round(60 * n), nMulti: Math.round(40 * n), nVague: Math.round(40 * n) });
  const ref = expected.filter((e) => e.key === k && e.a === 1); const want = BIG ? 120 : 40; const step = Math.max(1, Math.floor(ref.length / want));
  for (let i = 0; i < ref.length && qs.filter((q) => q.cat === "v2ref").length < want; i += step) qs.push({ cat: "v2ref", q: ref[i].q, gold: { has: true, needles: [] } });
  sets[k] = qs;
}
if (CHILD) {
  // agent switched off (DONOVAN_AGENT=0, DONOVAN_ESCALATION=0): the retrieval + model path alone must still catch every release
  const bad = []; let n = 0;
  for (const k of KEYS) for (const q of sets[k].filter((x) => x.gold.has).slice(0, 25)) { const r = await H.ask(k, q.q); n++; if (r.path === "declined") bad.push(`${k}: ${q.q.slice(0, 70)} => ${r.text.slice(0, 60)}`); }
  check(`agent OFF: ${n} answerable questions, none declined without the Claude path`, bad.length === 0, bad.slice(0, 5).join("\n      "));
  console.log(`\nverify:handoff (agent off) ${failures ? "FAILED" : "OK"}  ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

const rows = [];
for (const k of KEYS) for (const q of sets[k]) { const r = await H.ask(k, q.q); rows.push({ key: k, q, r }); }
const answerable = rows.filter((x) => x.q.gold.has);
// the private-papers refusal (HR letters) is a POLICY decline: it stays a refusal even when its word list over-matches a chatty question
const PRIVATE_REPLY = (await import("../api/_lib/privacy/privateDocs.js")).PRIVATE_DOCS_REPLY;
const policyKept = answerable.filter((x) => x.r.path === "declined" && x.r.text === PRIVATE_REPLY).length;
const declined = answerable.filter((x) => x.r.path === "declined" && x.r.text !== PRIVATE_REPLY);
check(`${answerable.length} answerable questions (${rows.length} asked): none ends declined without the Claude path (${policyKept} private-papers refusals kept by policy)`, declined.length === 0,
  declined.slice(0, 8).map((x) => `${x.key} [${x.q.cat}] ${x.q.q.slice(0, 70).replace(/\n/g, " ")} => ${x.r.text.slice(0, 70)}`).join("\n      "));
check("no request errored", rows.every((x) => x.r.path !== "error"), rows.filter((x) => x.r.path === "error").slice(0, 3).map((x) => `${x.q.q.slice(0, 60)}: ${x.r.err}`).join("; "));
const escalated = rows.filter((x) => x.r.path.startsWith("escalated")).length;
check(`the Claude path really ran for a good share of the questions (${escalated})`, escalated > rows.length * 0.1);
const finals = rows.filter((x) => !x.q.gold.has && x.r.path === "declined").length;
check(`facts that are truly absent still get the honest decline (${finals} of ${rows.filter((x) => !x.q.gold.has).length}), not a model call every time`, finals > 0);

// verified-final declines stay final
const ghost = await H.ask(KEYS[0], "phone number for Zelda Quillfeather"); const ghost2 = await H.ask(KEYS[0], "what is the weather in Mesa");
check("a name that exists nowhere gets the honest decline with NO model call", ghost.path === "declined" && ghost.modelCalls === 0, `${ghost.path} ${ghost.text.slice(0, 80)}`);
check("an off-topic question keeps its policy decline with NO model call", ghost2.modelCalls === 0 && ghost2.kind === "no-answer", `${ghost2.path} ${ghost2.text.slice(0, 80)}`);

// negative control: with the handoff OFF the same kind of questions DO end declined (so this test can fail)
const ctlSet = sets[KEYS[0]].filter((x) => x.gold.has).slice(0, BIG ? 400 : 120); let ctlDeclined = 0;
process.env.DONOVAN_READER_V2 = "0"; // the old lanes alone: Reader V2 (which rescues most of them) is off in the control
for (const q of ctlSet) { const r = await H.ask(KEYS[0], q.q, "2026-10-07", { release: false }); if (r.path === "declined" && r.text !== PRIVATE_REPLY) ctlDeclined++; }
process.env.DONOVAN_READER_V2 = "1";
check(`negative control: with the handoff and Reader V2 switched off, ${ctlDeclined} of ${ctlSet.length} answerable questions end declined (the test is sensitive)`, ctlDeclined > 0);

// Reader V2 failures and timeouts must escalate, not end the request
const v2set = answerable.filter((x) => x.r.v2 || x.q.cat === "v2ref").slice(0, 25).map((x) => x);
process.env.DONOVAN_READER_V2_BUDGET_MS = "1"; process.env.DONOVAN_READER_V2_MAX_DOCS = "1";
let v2bad = 0; for (const x of v2set) { const r = await H.ask(x.key, x.q.q); if (r.path === "declined" || r.path === "error") v2bad++; }
delete process.env.DONOVAN_READER_V2_BUDGET_MS; delete process.env.DONOVAN_READER_V2_MAX_DOCS;
check(`Reader V2 skipped (budget 1 ms, size cap 1): ${v2set.length} questions, none declined`, v2bad === 0, `${v2bad} declined/errored`);

// spend caps at zero: the research agent is refused, the cheaper retrieval + model path still answers
process.env.DONOVAN_RESEARCH_DAILY_USD = "0"; process.env.DONOVAN_SONNET_DAILY_USD = "0";
let capBad = 0; const capSet = answerable.slice(0, 40);
for (const x of capSet) { const r = await H.ask(x.key, x.q.q); if (r.path === "declined" || r.path === "error") capBad++; }
delete process.env.DONOVAN_RESEARCH_DAILY_USD; delete process.env.DONOVAN_SONNET_DAILY_USD;
check(`research + Sonnet daily caps at 0: ${capSet.length} questions, none declined`, capBad === 0, `${capBad} declined/errored`);

// escalation sees only the asking company's data
H.mock.keep = true; H.mock.prompts.length = 0;
const namesOf = (d) => [...new Set(d.entities.filter((e) => e.entity_type === "customer").map((e) => String(e.data?.customer_name ?? "").toLowerCase()).filter((n) => n.length > 8))];
const nameA = new Set(namesOf(data[KEYS[0]])), nameB = new Set(namesOf(data[KEYS[1]]));
const onlyB = [...nameB].filter((n) => !nameA.has(n)); const onlyA = [...nameA].filter((n) => !nameB.has(n));
for (const x of sets[KEYS[0]].filter((q) => q.gold.has).slice(0, 25)) await H.ask(KEYS[0], x.q);
const leakB = onlyB.filter((n) => H.mock.prompts.some((p) => p.includes(n)));
H.mock.prompts.length = 0;
for (const x of sets[KEYS[1]].filter((q) => q.gold.has).slice(0, 25)) await H.ask(KEYS[1], x.q);
const leakA = onlyA.filter((n) => H.mock.prompts.some((p) => p.includes(n)));
H.mock.keep = false;
check(`tenant isolation: what the Claude path is shown never contains the other company's customers (${onlyB.length + onlyA.length} names checked)`, leakA.length === 0 && leakB.length === 0, `${leakA.slice(0, 2)} ${leakB.slice(0, 2)}`);

// the agent-off child run (a separate process: the agent switches are read once per process)
try {
  const out = execFileSync(process.execPath, [SELF, "--agent-off"], { env: { ...process.env, DONOVAN_AGENT: "0", DONOVAN_ESCALATION: "0", TZ: process.env.TZ ?? "America/Phoenix" }, encoding: "utf8", timeout: 600000 });
  check("agent OFF (child process): the retrieval + model path alone still catches every release", /verify:handoff \(agent off\) OK/.test(out), out.split("\n").filter((l) => /FAIL|\s{6}/.test(l)).slice(0, 6).join("\n"));
} catch (e) { check("agent OFF (child process) ran", false, String(e.stdout ?? e.message).split("\n").filter((l) => /FAIL|\s{6}/.test(l)).slice(0, 6).join("\n")); }

console.log(`\nverify:handoff ${failures ? "FAILED" : "OK"}  ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
