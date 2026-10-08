#!/usr/bin/env node
/**
 * R32 (Team A, deterministic coverage) regression gate. $0: real /api/ask handler, PGlite golden tenant, model blocked.
 *   TZ=America/Phoenix EXAM_TODAY=2026-09-25 node scripts/verify-r32-coverage.mjs
 *
 * Covers, with NEGATIVE tests next to every positive:
 *   1. typo policy (lookups/typoResolve.js): pure policy negatives, end-to-end positives, quoted-as-typed, kill switch
 *   2. early decline (router/earlyDecline.js): record questions that merely contain lexicon words must NOT be declined
 *   3. rewrite (router/rewrite.js): "manufacturers" plural untouched, kill switch
 *   4. clarify chips (lookups/clarify.js): ambiguous surname, recognised entity, complex / conversation / kill-switch negatives
 *   5. new answers: every-technician, last visit type, windowed address visits, type comparisons, ranking dimensions
 *   6. blind-set floors (test-docs/scorecard/blind/r32-*.json): wrong stays 0 and no-model coverage floors only go up
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.TZ = process.env.TZ || "America/Phoenix";
process.env.EXAM_TODAY = process.env.EXAM_TODAY || "2026-09-25";

let failures = 0;
let passes = 0;
const realLog = console.log;
const check = (name, ok, detail = "") => {
  if (ok) passes++; else failures++;
  realLog(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${String(detail).slice(0, 400)}`}`);
};

/* ------------------------------------------------------------------ 0. pure units (no db) */
const { decideTypoResolution, isQuotedAsTyped } = await import("../api/_lib/lookups/typoResolve.js");
const { classifyEarlyDecline } = await import("../api/_lib/router/earlyDecline.js");
const { rewriteQuestion } = await import("../api/_lib/router/rewrite.js");
const { buildClarifyAnswer, buildClarifyChips, detectAmbiguousSurname } = await import("../api/_lib/lookups/clarify.js");

const universe = ["Sandra Wyckoff", "Thomas Mercer", "Laura Mercer", "Charles Whitford", "Emily Whitfield", "Bo Ray", "Ann Lee", "Mark Rose", "Bill Woods", "Karen Abernathy"].map((customer_name) => ({ customer_name }));
const dec = (typed, cand) => decideTypoResolution(typed, { customer_name: cand }, universe);

check("typo policy +: transposition in a long surname resolves", dec("Sanrda Wyckoff", "Sandra Wyckoff").ok === true);
check("typo policy +: one dropped letter resolves", dec("Sandra Wyckof", "Sandra Wyckoff").ok === true);
check("typo policy -: a name that is already exact is not a typo", dec("Sandra Wyckoff", "Sandra Wyckoff").ok === false);
check("typo policy -: short names never resolve (Bo Ray / Ann Lee)", dec("Bo Rey", "Bo Ray").ok === false && dec("Anne Lee", "Ann Lee").ok === false);
check("typo policy -: a real word is not a typo (Mark Rose -> Mark Ross, Bill Wood -> Bill Woods)", dec("Mark Ross", "Mark Rose").ok === false && dec("Bill Wood", "Bill Woods").ok === false);
check("typo policy -: a typo that equals another customer's surname does not resolve (Emily Whitford)", dec("Emily Whitford", "Emily Whitfield").ok === false);
check("typo policy -: more than 2 total edits never resolves", dec("Sndra Wyckff", "Sandra Wyckoff").ok === false || dec("Sndrq Wykoff", "Sandra Wyckoff").ok === false);
check("typo policy -: different word count never resolves", dec("Sandra", "Sandra Wyckoff").ok === false);
check("typo policy -: a name typed in quotes means 'as typed'", isQuotedAsTyped('phone for "Sanrda Wyckoff"', "Sanrda Wyckoff") === true && isQuotedAsTyped("phone for Sanrda Wyckoff", "Sanrda Wyckoff") === false);

/* early decline: positives */
const declines = (q) => classifyEarlyDecline(q, { hasConversation: false })?.kind ?? null;
check("early decline +: weather", declines("is it going to rain today") !== null);
check("early decline +: entertainment", declines("tell me a joke") !== null);
/* early decline: negatives (record questions that merely contain lexicon words) */
for (const q of [
  "when was the tune-up at 803 E Pecos Rd", "what is the phone number for Karen Abernathy", "how much did we invoice Thomas Mercer", "list customers that owe us money",
  "what does the condenser cost on the last invoice", "how many units do we have that are carrier", "who was the last tech at 803 E Pecos Rd", "is the Sonoran Grill Restaurant account current",
]) check(`early decline -: record question not declined: "${q}"`, declines(q) === null, JSON.stringify(classifyEarlyDecline(q, {})));

/* rewrite: negatives */
check("rewrite -: 'manufacturers' (plural) is left alone", (rewriteQuestion("how many manufacturers do we have") ?? "how many manufacturers do we have").includes("manufacturers"));
check("rewrite +: 'mfr' becomes 'manufacturer'", /manufacturer/.test(rewriteQuestion("what mfr made the unit at 803 E Pecos Rd") ?? ""));
check("rewrite -: an untouched question returns null", rewriteQuestion("what is the phone number for Karen Abernathy") === null);
check("rewrite +: tech total phrasing", rewriteQuestion("how many service calls has Danny Ochoa been out on, total") === "how many jobs has Danny Ochoa done");
check("rewrite -: a windowed tech question is NOT turned into a lifetime total", (rewriteQuestion("how many visits has Danny Ochoa been on this year") ?? "").indexOf("done") === -1);

/* clarify (pure) */
const vocab = { customers: { phrases: ["Thomas Mercer", "Laura Mercer", "Karen Abernathy", "Sandra Wyckoff", "Sonoran Grill Restaurant"] } };
const amb = detectAmbiguousSurname("serial on mercer's unit", vocab);
check("clarify +: bare surname shared by 2 customers is detected", amb?.names?.join("|") === "Laura Mercer|Thomas Mercer");
check("clarify +: chips substitute each full name into the question", buildClarifyChips("serial on mercer's unit", vocab).map((c) => c.text).join("|") === "serial on Laura Mercer's unit|serial on Thomas Mercer's unit");
check("clarify -: a full name is never a bare-surname reference", detectAmbiguousSurname("serial on Thomas Mercer's unit", vocab) === null);
check("clarify -: a unique surname is not ambiguous", detectAmbiguousSurname("serial on wyckoff's unit", vocab) === null);
check("clarify -: a first name typed before the surname is not a bare surname", detectAmbiguousSurname("serial on laura mercer's unit", vocab) === null);
check("clarify -: no record cue, no clarify", detectAmbiguousSurname("mercer", vocab) === null);
const named = buildClarifyChips("what is the deal with Karen Abernathy", vocab, { routesWithoutModel: (q) => ({ matched: /equipment|last serviced|phone/.test(q) }) });
check("clarify +: a named customer gets 2-3 validated reformulation chips", named.length >= 2 && named.length <= 3 && named.every((c) => c.text.includes("Karen Abernathy")), JSON.stringify(named));
check("clarify -: an unvalidated reformulation is never offered", buildClarifyChips("what is the deal with Karen Abernathy", vocab, { routesWithoutModel: () => ({ matched: false }) }).length === 0);
check("clarify -: complex questions (compare/average) never get chips", buildClarifyChips("compare Karen Abernathy to Sandra Wyckoff", vocab, { routesWithoutModel: () => ({ matched: true }) }).length === 0);
check("clarify -: an unrecognised entity gets no chips", buildClarifyAnswer("what is the deal with Nobody Real", vocab, { routesWithoutModel: () => ({ matched: true }) }) === null);
process.env.DONOVAN_CLARIFY_CHIPS = "0";
check("clarify -: kill switch DONOVAN_CLARIFY_CHIPS=0 disables it", buildClarifyAnswer("serial on mercer's unit", vocab) === null && buildClarifyChips("serial on mercer's unit", vocab).length === 0);
delete process.env.DONOVAN_CLARIFY_CHIPS;

/* ------------------------------------------------------------------ 1. end to end through the real handler */
if (!process.env.DEBUG) { console.warn = () => {}; console.error = () => {}; }
console.log = (...a) => { if (typeof a[0] === "string" && (a[0].startsWith('{"route"') || a[0].startsWith('{"event"') || a[0].startsWith('{"timestamp"'))) return; realLog(...a); };
const off = await import("./offline-exam.mjs");
await off.installPgHarness();
const counter = await off.installModelBlock();
const lite = await off.createPGlite();
await off.setActiveDatabase(lite);
const exportData = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/golden/golden-export.json"), "utf8"));
const { ctx } = await off.loadExportIntoNewTenant(lite, exportData, { tenantKey: `offline:${exportData.tenantKey ?? "r32"}`, tenantName: "R32" });
const today = process.env.EXAM_TODAY;
const { askViaHandler } = await import("../api/_lib/scorecard/askCall.js");
const { default: handler } = await import("../api/ask.js");
const auth = { tenantId: ctx.tenantKey, orgId: ctx.tenantName, userId: null };
async function ask(q) {
  counter.n = 0;
  const r = await askViaHandler({ handler, auth, question: q, today });
  return { d: r.data, text: String(r.data?.text ?? ""), usedModel: counter.n > 0, kind: r.data?.kind };
}
const noModel = (a) => !a.usedModel;

// typo policy end to end
let a = await ask("what is the phone number for Sanrda Wyckoff");
check("typo e2e +: 'Sanrda Wyckoff' resolves with the visible note", /^Showing results for Sandra Wyckoff \(you typed "Sanrda Wyckoff"\)\./.test(a.text) && /480/.test(a.text), a.text);
a = await ask("what is the phone number for Thomas Mercr");
check("typo e2e +: 'Thomas Mercr' resolves to Thomas Mercer (not Laura Mercer)", /Showing results for Thomas Mercer/.test(a.text) && !/Laura/.test(a.text), a.text);
a = await ask('what is the phone number for "Sanrda Wyckoff"');
check("typo e2e -: quoted-as-typed gives the honest decline, never a resolved answer", /I couldn't (?:match|find)/i.test(a.text) && !/Showing results for/.test(a.text), a.text);
for (const nm of ["Bo Ray", "Ann Lee", "Mark Rose", "Emily Whitford", "Wyckof Sandr"]) {
  a = await ask(`what is the phone number for ${nm}`);
  check(`typo e2e -: "${nm}" is never auto-resolved`, !/Showing results for/.test(a.text), a.text);
}
a = await ask("what is the phone number for Mercer");
check("typo e2e -: bare shared surname stays a 'which one' decline", /more than one customer/.test(a.text) && /Thomas Mercer/.test(a.text) && /Laura Mercer/.test(a.text), a.text);
process.env.DONOVAN_TYPO_AUTORESOLVE = "0";
a = await ask("what is the phone number for Sanrda Wyckoff");
check("typo kill switch: DONOVAN_TYPO_AUTORESOLVE=0 restores the tap-to-confirm decline", !/^Showing results for/.test(a.text) && /Did you mean Sandra Wyckoff/.test(a.text), a.text);
delete process.env.DONOVAN_TYPO_AUTORESOLVE;

// early decline end to end (no model, honest)
a = await ask("tell me a joke");
check("early decline e2e +: off-domain is declined with no model call", a.kind === "no-answer" && noModel(a), a.text);
a = await ask("who was the last tech at 803 E Pecos Rd");
check("early decline e2e -: a record question is still answered", a.kind === "answer" && /Marisol Vega/.test(a.text), a.text);
a = await ask("what is the phone number for Karen Abernathy");
check("early decline e2e -: a customer lookup is still answered", a.kind === "answer" && /480/.test(a.text), a.text);
process.env.DONOVAN_EARLY_DECLINE = "0";
a = await ask("hum me a tune");
check("early decline kill switch: DONOVAN_EARLY_DECLINE=0 stops the early decline (the question reaches the model path)", a.usedModel === true, a.text);
delete process.env.DONOVAN_EARLY_DECLINE;

// new deterministic answers
a = await ask("who's been out to Edward Dominguez's place");
check("answer +: every technician (not just the last one)", /Denise Ford/.test(a.text) && /Wyatt Coburn/.test(a.text) && noModel(a), a.text);
a = await ask("which tech did the last job for Thomas Quintana");
check("answer -: 'last' still means one technician", /was the last technician/.test(a.text), a.text);
a = await ask("what was the last visit at 692 S Higley Rd for");
check("answer +: last visit type at an address", /Repair visit/.test(a.text) && noModel(a), a.text);
a = await ask("any service calls at 803 E Pecos Rd last year");
check("answer +: windowed address visits, honest No with the last visit", /^No/.test(a.text) && /June 11, 2019/.test(a.text) && noModel(a), a.text);
a = await ask("have we been out to 3319 N Val Vista Dr over the past 90 days");
check("answer +: windowed address visits, Yes with the date", /^Yes/.test(a.text) && /September 21, 2026/.test(a.text), a.text);
a = await ask("do we do more repairs than pm");
check("answer +: service-type comparison names both counts", /^Yes, you have 85 Repair visits and 35 Preventive Maintenance visits/.test(a.text), a.text);
a = await ask("do we have fewer preventive maintenance visits than repair visits");
check("answer +: 'fewer' flips the comparison", /^Yes/.test(a.text) && /35 Preventive Maintenance visits and 85 Repair visits/.test(a.text), a.text);
a = await ask("which technicians have never once logged a preventive maintenance visit");
check("answer -: a negated 'which technicians' question is never answered with a positive typed count", !/^\d+ service visits/.test(a.text), a.text);
a = await ask("which city do we have the most customers in");
check("answer +: ranking dimension phrasing is answered correctly (was '120 customers.')", /^Mesa has the most customers, with 16/.test(a.text), a.text);
a = await ask("whens the winslow warranty up");
check("answer -: a bare shared surname that is also a city is never read as the city", a.kind === "no-answer" && /more than one customer/.test(a.text) && !/customers match that/.test(a.text), a.text);

// address not on file (lookups/addressMiss.js)
a = await ask("who was the last tech out to 3431 W Ocotillo Rd");
check("address miss +: an address nobody serves gets an honest 'nothing on file', no model", a.kind === "no-answer" && /don't have anything on file for 3431 W Ocotillo Rd/.test(a.text) && noModel(a), a.text);
a = await ask("who was the last tech out to 803 E Pecos Road");
check("address miss -: an on-file address spelled 'Road' is never declared absent", !/don't have anything on file/.test(a.text), a.text);
a = await ask("who was the last tech out to 803 Pecos Rd");
check("address miss -: a missing direction is never declared absent", !/don't have anything on file/.test(a.text), a.text);
a = await ask("what is the deal with 3431 W Ocotillo Rd");
check("address miss -: no record cue, no decline", !/don't have anything on file/.test(a.text), a.text);
process.env.DONOVAN_ADDRESS_MISS = "0";
a = await ask("who was the last tech out to 3431 W Ocotillo Rd");
check("address miss kill switch: DONOVAN_ADDRESS_MISS=0 restores the model fallthrough", !/don't have anything on file/.test(a.text), a.text);
delete process.env.DONOVAN_ADDRESS_MISS;
a = await ask("mail address for Patricia Esparza");
check("rewrite e2e +: 'mail address' is the e-mail (honest 'No email on file', not the service address)", /No email on file/.test(a.text), a.text);
a = await ask("what is the mailing address for Patricia Esparza");
check("rewrite e2e -: 'mailing address' stays the postal reading", /1284 S Alma School Rd/.test(a.text), a.text);
a = await ask("what is the seer on Joseph Norwood's system");
check("clarify e2e -: an unextracted attribute (seer) is never turned into chips", a.d?.clarify !== true, a.text);

// clarify end to end
a = await ask("serial on nakamura's unit");
check("clarify e2e +: ambiguous surname -> no-answer with clarify flag, every candidate named, no model", a.kind === "no-answer" && a.d?.clarify === true && /Stephanie Nakamura/.test(a.text) && /Thomas Nakamura/.test(a.text) && /Laura Nakamura/.test(a.text) && noModel(a), a.text);
check("clarify e2e +: chips travel as full-name substitutions", (a.d?.didYouMean ?? []).length === 3 && a.d.didYouMean.every((c) => /Nakamura's unit$/.test(c.text) && /^serial on [A-Z][a-z]+ Nakamura/.test(c.text)), JSON.stringify(a.d?.didYouMean));
a = await ask("what is the deal with Thomas Mercer's furnace vibes");
check("clarify e2e +: recognised entity with no rule -> 2-3 chips, no model, flagged so it is never counted as correct", a.kind === "no-answer" && a.d?.clarify === true && (a.d.didYouMean ?? []).length >= 2 && noModel(a), a.text);
a = await ask("compare Thomas Mercer's spending against everyone in Mesa");
check("clarify e2e -: a complex question is not replaced by chips", !(a.d?.clarify === true), a.text);
process.env.DONOVAN_CLARIFY_CHIPS = "0";
a = await ask("what is the deal with Thomas Mercer's furnace vibes");
check("clarify e2e kill switch: DONOVAN_CLARIFY_CHIPS=0 gives no chips (falls to the model path)", a.d?.clarify !== true, a.text);
delete process.env.DONOVAN_CLARIFY_CHIPS;

/* ------------------------------------------------------------------ 2. blind-set floors */
const FLOORS = {
  decline: { correct: 135, total: 140 }, "r31-address": { correct: 129, total: 129 }, "r31-contact2": { correct: 117, total: 124 }, decline2: { correct: 139, total: 141 }, decline3: { correct: 119, total: 120 },
  unit: { correct: 131, total: 131 }, unit2: { correct: 105, total: 105 }, window: { correct: 141, total: 141 }, acct: { correct: 74, total: 102, clarified: 28 },
};
for (const [fam, f] of Object.entries(FLOORS)) {
  const file = path.join(ROOT, `test-docs/scorecard/blind/${fam.startsWith("r31-") ? fam : `r32-${fam}`}.json`);
  if (!fs.existsSync(file)) { check(`blind ${fam}: fixture present`, false, file); continue; }
  const r = spawnSync(process.execPath, ["scripts/run-exam-subset.mjs", "--no-base", "--blind", file], { cwd: ROOT, encoding: "utf8", env: process.env, timeout: 300_000 });
  const m = /TOTAL (\d+) q \| no-model (\d+) \| correct (\d+) \| wrong (\d+) \| needs-model (\d+) \| clarified (\d+)/.exec(r.stdout ?? "");
  if (!m) { check(`blind ${fam}: runner produced a TOTAL line`, false, (r.stdout ?? "").slice(-300) + (r.stderr ?? "").slice(-300)); continue; }
  const [total, , correct, wrong, , clarified] = m.slice(1).map(Number);
  check(`blind ${fam}: ${total} q, wrong stays 0 (got ${wrong})`, total === f.total && wrong === 0);
  check(`blind ${fam}: correct >= ${f.correct} (got ${correct}); clarified ${clarified} is reported separately`, correct >= f.correct && (f.clarified == null || clarified >= f.clarified - 5));
}

realLog(`\n${failures ? `${failures} check(s) FAILED, ${passes} passed.` : `${passes} checks passed.`}`);
process.exit(failures ? 1 : 0);
