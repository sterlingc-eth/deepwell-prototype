#!/usr/bin/env node
/**
 * R32b (Team A3, deterministic coverage, loops A-E) regression gate. $0: real /api/ask handler, PGlite golden tenant, model blocked.
 *   TZ=America/Phoenix EXAM_TODAY=2026-09-25 node scripts/verify-r32-lookups.mjs
 *
 * Every positive has a NEGATIVE next to it (a lookalike that must keep going down the normal path). Sections:
 *   0. pure parsers: aggregates, namedCompare, customer counts, unknown names, early decline, financial subject phrase
 *   1. end to end: page attributes (SEER / filter), unknown names, per-customer / per-vendor counts, named comparisons, technicians,
 *      warranty extremes + out-of-warranty counts, tech-never sets, date extremes, history skew, open-in-period honesty, city abbreviations
 *   2. blind-set floors (test-docs/scorecard/blind/r32b-*.json): wrong stays 0, no-model coverage floors only go up
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

/* ------------------------------------------------------------------ 0. pure parsers */
const { parseAggregate } = await import("../api/_lib/lookups/aggregates.js");
const { parseNamedCompare, parseCustomerCount } = await import("../api/_lib/lookups/namedCompare.js");
const { extractNamePhrase } = await import("../api/_lib/lookups/unknownName.js");
const { classifyEarlyDecline } = await import("../api/_lib/router/earlyDecline.js");
const { extractSubjectPhrase } = await import("../api/_lib/financials/answers.js");

const agg = (q) => parseAggregate(q)?.kind ?? null;
check("aggregate +: earliest warranty expiration", agg("whats the earliest warranty expiration we have on file") === "warranty-extreme");
check("aggregate -: 'soonest warranty' is a from-today reading, never claimed", agg("soonest warranty expiry on file") === null);
check("aggregate -: an address is never a shop-wide extreme", agg("when does the warranty expire at 803 E Pecos Rd") === null);
check("aggregate +: units out of warranty", agg("how many units are not currently under warranty") === "warranty-count");
check("aggregate +: technicians who never logged PM", agg("which technicians have never logged a preventive maintenance visit") === "tech-never");
check("aggregate -: 'which customers never had a PM' is not a technician question", agg("which customers have never had a preventive maintenance visit") === null);
check("aggregate +: no readable text", agg("how many documents have no readable text extracted") === "no-text-docs");
check("aggregate -: documents for a customer are not the shop-wide text check", agg("how many documents have no phone number for Karen Abernathy") === null);
check("aggregate +: history skew", agg("has most of our service history happened before last year") === "history-skew");
check("aggregate -: a customer's history is not the shop-wide skew", agg("has most of Karen Abernathy's service history happened before last year") === null);
check("aggregate +: first service visit on file", agg("when was the first service visit on file") === "date-extreme");
check("aggregate -: the last visit at an address is the history route's", agg("when was the last service visit at 803 E Pecos Rd") === null);
check("aggregate +: open invoices from a period", agg("any invoices from last quarter that are still open") === "open-in-period");
check("aggregate -: open invoices for a customer are the money route's", agg("any open invoices for Karen Abernathy from last quarter") === null);
check("aggregate +: technician extreme", agg("who has done the most jobs overall") === "tech-extreme");
check("aggregate -: a windowed technician ranking keeps the existing 'this year' route", agg("who has done the most jobs this year") === null);

const nc = (q) => parseNamedCompare(q);
check("namedCompare +: two customers, documents", nc("has Rebecca Montoya had more documents on file than Charles Montoya")?.kind === "named");
check("namedCompare +: two vendors", nc("have we bought more from Baker Distributing or Watsco Supply")?.kind === "vendor");
check("namedCompare +: two service types", nc("do we do more repair work or more preventive maintenance")?.kind === "servicetype");
check("namedCompare +: technicians 'ahead of'", nc("is Kevin Pratt ahead of Marisol Vega")?.techOnly === true);
check("namedCompare -: document-kind words are never names", nc("do we have more invoices than documents") === null);
check("namedCompare -: no second side, no comparison", nc("has Rebecca Montoya had more documents") === null);
check("customerCount +: how many documents does X have", parseCustomerCount("how many documents does Mark Jennings have")?.phrase === "mark jennings");
check("customerCount +: conversational frame and filler tail are stripped", parseCustomerCount("ok um, how many docs does David Prentiss have thanks")?.phrase === "david prentiss");
check("customerCount -: a time word is never a customer", parseCustomerCount("how many documents for last year") === null);
check("customerCount -: shop-wide counts have no subject", parseCustomerCount("how many documents do we have") === null);
check("customerCount -: 'how many invoices for X' is left to the (customer-scoped) money route", parseCustomerCount("how many invoices for Rebecca Montoya") === null);

check("unknownName +: 'phone number for X'", extractNamePhrase("phone number for Zzyzx Qwerty") === "Zzyzx Qwerty");
check("unknownName +: possessive unit shape", extractNamePhrase("serial on the zzyzx unit") === "zzyzx");
check("unknownName -: a shop-wide question has no name phrase", extractNamePhrase("how many units do we have") === null);

const dec = (q) => classifyEarlyDecline(q, { hasConversation: false })?.kind ?? null;
for (const q of ["who's your favorite technician", "how do I change my account password", "what did the shop manager circulate to everyone", "what's the square root of 144", "which laptop should i buy for school", "what is the capital of australia", "how do i take a screenshot on a mac", "what's the temperature in new york", "what about the one in chandler instead", "now do the one in gilbert"]) {
  check(`early decline +: "${q}"`, dec(q) !== null);
}
for (const q of ["how many company-wide invoices have we sent", "how many trane systems have we sold company-wide", "who won the Rios contract", "who wrote up the Mercer job", "what is the phone number for Karen Abernathy", "how many units are out of warranty", "what about the Rios unit", "how many days in the warranty period for the unit at 803 E Pecos Rd"]) {
  check(`early decline -: record question not declined: "${q}"`, dec(q) === null, JSON.stringify(classifyEarlyDecline(q, {})));
}
check("financials -: 'sent out last quarter' names no customer", extractSubjectPhrase("how many invoices did we send out last quarter") === null);
check("financials -: 'yr to date' names no customer", extractSubjectPhrase("how many invoices have we sent yr to date") === null);
check("financials +: 'sent Maria Gallardo' names the customer", /maria gallardo/i.test(extractSubjectPhrase("how many invoices have we sent Maria Gallardo") ?? ""));

/* ------------------------------------------------------------------ 1. end to end */
if (!process.env.DEBUG) { console.warn = () => {}; console.error = () => {}; }
console.log = (...a) => { if (typeof a[0] === "string" && (a[0].startsWith('{"route"') || a[0].startsWith('{"event"') || a[0].startsWith('{"timestamp"'))) return; realLog(...a); };
const off = await import("./offline-exam.mjs");
await off.installPgHarness();
const counter = await off.installModelBlock();
const lite = await off.createPGlite();
await off.setActiveDatabase(lite);
const exportData = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/golden/golden-export.json"), "utf8"));
const { ctx } = await off.loadExportIntoNewTenant(lite, exportData, { tenantKey: `offline:${exportData.tenantKey ?? "r32b"}`, tenantName: "R32b" });
const today = process.env.EXAM_TODAY;
const { askViaHandler } = await import("../api/_lib/scorecard/askCall.js");
const { default: handler } = await import("../api/ask.js");
const auth = { tenantId: ctx.tenantKey, orgId: ctx.tenantName, userId: null };
async function ask(q) {
  counter.n = 0;
  const r = await askViaHandler({ handler, auth, question: q, today });
  return { d: r.data, text: String(r.data?.text ?? ""), usedModel: counter.n > 0, kind: r.data?.kind, records: r.data?.records ?? r.data?.citations?.records ?? [] };
}
const noModel = (a) => !a.usedModel;
let a;

// loop A: page attributes and unknown names
a = await ask("what's the seer on the unit at 100 E Main St");
check("page attribute +: an unprinted SEER is an honest 'not on file', no model", a.kind === "no-answer" && /SEER/i.test(a.text) && /not on file/.test(a.text) && noModel(a), a.text);
a = await ask("seer rating for 100 e main phx");
check("page attribute -: a trailing metro abbreviation (phx) never makes the address 'not on file'", !/isn't on file|don't have anything on file/.test(a.text), a.text);
a = await ask("phone number for Zzyzx Qwerty");
check("unknown name +: a name that appears nowhere is an honest decline, no model", a.kind === "no-answer" && /Zzyzx Qwerty/.test(a.text) && noModel(a), a.text);
a = await ask("phone number for Karen Abernathy");
check("unknown name -: a real customer is still answered", a.kind === "answer" && /480/.test(a.text), a.text);
a = await ask("phone number for Karen Abernathey");
check("unknown name -: a typo of a real surname is never declared absent", !/nothing to look up/.test(a.text), a.text);
a = await ask("phone number for Thaddeus Abernethy-Cole");
check("unknown name +: a hyphenated unknown name is declined as one name", a.kind === "no-answer" && /Abernethy-Cole/.test(a.text) && !/nothing to look up.*Abernathy/.test(a.text), a.text);
process.env.DONOVAN_UNKNOWN_NAME_DECLINE = "0";
a = await ask("phone number for Zzyzx Qwerty");
check("unknown name kill switch: DONOVAN_UNKNOWN_NAME_DECLINE=0 restores the old path", !/nothing to look up/.test(a.text), a.text);
delete process.env.DONOVAN_UNKNOWN_NAME_DECLINE;

// loop B: counts and comparisons
a = await ask("how many documents does Mark Jennings have");
check("count +: per-customer documents", /Mark Jennings has 5 documents/.test(a.text) && noModel(a), a.text);
a = await ask("ok um, how many docs does Mark Jennings have thanks");
check("count +: frame and filler tail do not stop a per-customer count", /Mark Jennings has 5 documents/.test(a.text) && noModel(a), a.text);
a = await ask("how many invoices for Mark Jennings");
check("count -: a customer-scoped invoice count is never the shop-wide 120", !/\b120\b/.test(a.text), a.text);
a = await ask("how many purchase orders from baker distributing");
check("count +: vendor PO count uses the printed vendor name", /10 purchase orders from Baker Distributing/.test(a.text), a.text);
a = await ask("how many invoices have we sent out last quarter");
check("count -: 'sent out last quarter' is the shop-wide window, not a customer called 'out last quarter'", !/couldn't find a customer|no customer/i.test(a.text), a.text);
a = await ask("has Rebecca Montoya had more documents on file than Charles Montoya");
check("compare +: equal counts are a tie, not a yes", /^No/.test(a.text) && /tied/.test(a.text) && noModel(a), a.text);
a = await ask("have we bought more from Baker Distributing or Watsco Supply");
check("compare +: vendor PO counts name both", /Baker Distributing/.test(a.text) && /10/.test(a.text) && /9/.test(a.text), a.text);
a = await ask("do we do more repairs than pm");
check("compare +: service types", /^Yes, you have 85 Repair visits and 35 Preventive Maintenance visits/.test(a.text), a.text);
a = await ask("do we have more invoices or more service tickets on file");
check("compare -: document-type comparisons keep the existing route", !/Counted by the service type/.test(a.text), a.text);

// loop C: aggregates
a = await ask("whats the earliest warranty expiration we have on file");
check("agg +: earliest warranty expiration", /2014-01-13/.test(a.text) && noModel(a), a.text);
a = await ask("latest warranty expiry on file");
check("agg +: latest warranty expiration", /2035-09-17/.test(a.text), a.text);
a = await ask("earliest warranty expiration for Karen Abernathy");
check("agg -: a named customer's warranty is never answered with the shop-wide extreme", !/2014-01-13/.test(a.text), a.text);
a = await ask("how many units does Karen Abernathy have under warranty");
check("agg -: a named customer's warranty count is never the shop-wide out-of-warranty count", !/^79 units are out of warranty/.test(a.text), a.text);
a = await ask("how many units are not currently under warranty");
check("agg +: units out of warranty (end date passed)", /^79 units are out of warranty/.test(a.text) && /no warranty end date/.test(a.text) && a.records.length > 0, a.text);
a = await ask("how many units are still under warranty");
// R35 (owner decision 2026-10-01, ADJUDICATION.md "R35"): shop-wide "still under warranty" = not expired (37), with the within-a-year share named.
check("agg +: the shop-wide 'still under warranty' = not expired, with the next-12-months qualifier (owner wording)", /^37 units are still under warranty — 4 of them run out in the next 12 months/.test(a.text), a.text);
a = await ask("which technicians have never logged a preventive maintenance visit");
check("agg +: technicians who never did PM (set)", ["Danny Ochoa", "Denise Ford", "Ray Sutton", "Marisol Vega"].every((n) => a.text.includes(n)) && !/Kevin Pratt|Wyatt Coburn/.test(a.text.split("The other")[0] ?? a.text), a.text);
a = await ask("which technicians never did a PM last year");
check("agg +: a windowed tech-never question is answered over visits dated in the window (never '120 customers')", /Danny Ochoa/.test(a.text) && /Wyatt Coburn/.test(a.text) && /in 2025/.test(a.text) && !/customers/.test(a.text), a.text);
a = await ask("which technicians have never logged a repair");
check("agg +: everyone has a repair -> an honest 'every technician', no names", /Every technician on file/.test(a.text), a.text);
a = await ask("when was the first service visit on file");
check("agg +: first service visit", /2009-01-01/.test(a.text), a.text);
a = await ask("date of our most recent invoice");
check("agg +: most recent invoice date (no 'customer named Date Of ...' decline)", /2026-08-28/.test(a.text), a.text);
a = await ask("has most of our service history happened before last year");
check("agg +: history skew is Yes with both counts", /^Yes/.test(a.text) && /257/.test(a.text) && /60/.test(a.text) && a.records.length > 0, a.text);
a = await ask("any invoices from last quarter that are still open");
check("agg +: no invoice carries a payment status -> honest no-answer", a.kind === "no-answer" && /none of the invoices/.test(a.text), a.text);
a = await ask("how many documents have no readable text extracted");
check("agg +: documents with no text (none) is an honest zero, not the document total", /No documents are missing text/.test(a.text), a.text);

// loop D: technicians
a = await ask("is Kevin Pratt ahead of Marisol Vega");
check("tech +: pair comparison over the technician rows", /^Yes/.test(a.text) && /Kevin Pratt has 59/.test(a.text) && noModel(a), a.text);
a = await ask("who has done the most jobs overall");
check("tech +: most jobs overall", /Kevin Pratt/.test(a.text) && /59/.test(a.text), a.text);
a = await ask("repair count for Danny Ochoa");
check("tech +: typed count", /Danny Ochoa has 19 repair visits/.test(a.text), a.text);

// loop E: off-domain
a = await ask("which laptop should i buy for school");
check("off-domain +: shopping advice is declined with no model", a.kind === "no-answer" && noModel(a), a.text);
a = await ask("what about the one in chandler instead");
check("dangling +: a context-free fragment gets the honest 'which customer or address' reply", a.kind === "no-answer" && noModel(a), a.text);

/* ------------------------------------------------------------------ 2. blind-set floors */
const FLOORS = {
  decl: { total: 144, noModel: 143 }, decl2: { total: 135, noModel: 135 }, compare: { total: 106, noModel: 105 }, agg: { total: 106, noModel: 106 },
  agg2: { total: 81, noModel: 81 }, tech: { total: 115, noModel: 115 }, off: { total: 103, noModel: 103 }, off2: { total: 68, noModel: 68 },
};
for (const [fam, f] of Object.entries(FLOORS)) {
  const file = path.join(ROOT, `test-docs/scorecard/blind/r32b-${fam}.json`);
  if (!fs.existsSync(file)) { check(`blind r32b-${fam}: fixture present`, false, file); continue; }
  const r = spawnSync(process.execPath, ["scripts/run-exam-subset.mjs", "--no-base", "--blind", file], { cwd: ROOT, encoding: "utf8", env: process.env, timeout: 300_000 });
  const m = /TOTAL (\d+) q \| no-model (\d+) \| correct (\d+) \| wrong (\d+) \| needs-model (\d+) \| clarified (\d+)/.exec(r.stdout ?? "");
  if (!m) { check(`blind r32b-${fam}: runner produced a TOTAL line`, false, (r.stdout ?? "").slice(-300) + (r.stderr ?? "").slice(-300)); continue; }
  const [total, noModelN, , wrong] = m.slice(1).map(Number);
  check(`blind r32b-${fam}: ${total} q, wrong stays 0 (got ${wrong})`, total === f.total && wrong === 0);
  check(`blind r32b-${fam}: no-model >= ${f.noModel} (got ${noModelN})`, noModelN >= f.noModel);
}

realLog(`\n${failures ? `${failures} check(s) FAILED, ${passes} passed.` : `${passes} checks passed.`}`);
process.exit(failures ? 1 : 0);
