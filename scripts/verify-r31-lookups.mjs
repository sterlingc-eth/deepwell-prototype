#!/usr/bin/env node
/**
 * R31 (Donovan Team A) — offline guard for the pure parts of the R31 coverage work. No DB, no network, no model.
 *
 *   node scripts/verify-r31-lookups.mjs
 *
 * Positive AND negative cases for each general rule (wrong entity, negation, multi-condition, ambiguity -> null):
 *   router/frame.js (conversational frame), lookups/slotFill.js (entity-first single-field lookups),
 *   lookups/technician.js (technician job counts), router/futureDate.js (future-year records), the out-of-domain
 *   decline families, analytics/brandCanon.js, vocab/tenantVocab.js multi-word name correction, and the
 *   THE_NAME_NOUN_RE root fix (full-corpus diff: every exam/blind/dialogue text, only non-name captures may change).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0; let passes = 0;
const check = (name, ok, detail = "") => { if (ok) passes++; else failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`); };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
console.warn = () => {};

const { stripConversationalFrame } = await import("../api/_lib/router/frame.js");
const { parseSlotFill } = await import("../api/_lib/lookups/slotFill.js");
const { parseTechnician } = await import("../api/_lib/lookups/technician.js");
const { isFutureRecordQuestion } = await import("../api/_lib/router/futureDate.js");
const { parseContactLookupQuestion } = await import("../api/_lib/contactLookup.js");
const { canonicalBrandLabel } = await import("../api/_lib/analytics/brandCanon.js");
const Vocab = await import("../api/_lib/vocab/tenantVocab.js");
const FP = await import("../api/_lib/fastPath.js");

/* ---- 1. conversational frame */
for (const [q, want] of [
  ["hold up, whats the phone number for Marisol Vega", "whats the phone number for Marisol Vega"],
  ["customer is on the line, phone number for Marisol Vega please", "phone number for Marisol Vega"],
  ["contact number for Marisol Vega", "phone number for Marisol Vega"],
]) check(`frame: "${q}"`, stripConversationalFrame(q) === want, `got ${JSON.stringify(stripConversationalFrame(q))}`);
for (const q of ["how many customers do we have", "list customers in Mesa", "phone"]) check(`frame: leaves "${q}" alone`, stripConversationalFrame(q) === null);

/* ---- 2. slot filling (parse only; resolution against the DB is measured by the blind sets + exam) */
const sf = (q) => parseSlotFill(q);
check("slotFill: name + one field concept", sf("best number for Marisol Vega")?.concept === "phone" && sf("best number for Marisol Vega")?.kind === "name");
check("slotFill: address + who", sf("who lives at 1234 Main St")?.kind === "address");
for (const q of [
  "how many customers have a phone number",       // aggregate
  "phone number for Marisol Vega and her email",  // two concepts
  "phone number for Marisol Vega last month",     // time window
  "what is the phone number for Marisol Vega not the office", // negation
  "phone number for Marisol Vega versus Ray Sutton", // comparison
  "phone number for the thermostat at 1234 Main St", // component word
  "serial number for 1234 Main St and 55 Oak St", // two addresses
]) check(`slotFill: defers "${q}"`, sf(q) === null, JSON.stringify(sf(q)));

/* ---- 3. technician job counts */
const tv = { technicians: { phrases: ["Danny Ochoa", "Ray Sutton", "Kevin Pratt"] } };
const tp = (q) => parseTechnician(q, tv);
check("technician: total", tp("job count for Danny Ochoa")?.kind === "total");
check("technician: city", tp("Ray Sutton's jobs in Phoenix")?.kind === "city" && tp("Ray Sutton's jobs in Phoenix")?.city === "phoenix");
check("technician: ever repair", tp("has Kevin Pratt ever done a repair visit")?.kind === "ever");
check("technician: compare keeps question order", JSON.stringify(tp("does Ray Sutton have more calls than Danny Ochoa")?.techs) === JSON.stringify(["Ray Sutton", "Danny Ochoa"]));
check("technician: fewer flips direction", tp("does Ray Sutton have fewer calls than Danny Ochoa")?.dir === "fewer");
check("technician: sum", tp("combined job total for Ray Sutton and Danny Ochoa")?.kind === "sum");
check("technician: threshold", tp("does every tech have at least 50 jobs")?.min === 50);
check("technician: any below", tp("is any technician under 56 jobs")?.kind === "anyBelow");
for (const q of [
  "how many jobs has Danny Ochoa done last month",     // time window
  "how many jobs has Danny Ochoa done in 2024",
  "how many jobs has Danny Ochoa done in Suite 110",   // not a city
  "how many jobs did Danny Ochoa not do",              // negation
  "how many jobs has Danny Ochoa done for Ray Sutton",  // two names, no combining word
  "how many Carrier jobs has Danny Ochoa done",        // extra condition
  "how many jobs has Danny Smith done",                // unknown person
  "how many jobs has Danny Ochoa done in Phoenix or Tempe",
  "does every tech have at least 50 jobs in Phoenix",
  "how much revenue did Danny Ochoa generate in jobs",
  "is any technician over 5 jobs",
]) check(`technician: defers "${q}"`, tp(q) === null, JSON.stringify(tp(q)));
check("technician: no vocab -> null", parseTechnician("job count for Danny Ochoa", null) === null);
check("technician: claimed through parseContactLookupQuestion only with vocab", parseContactLookupQuestion("job count for Danny Ochoa", { tenantVocab: tv })?.field === "technician" && parseContactLookupQuestion("job count for Danny Ochoa", {})?.field !== "technician");

/* ---- 4. future-year record questions */
for (const q of ["was there an invoice issued in March 2028", "anything on file from December 2029", "what work did we do on March 15th, 2027", "is there a permit filed for October 2029"])
  check(`future: claims "${q}"`, isFutureRecordQuestion(q, { today: "2026-09-25" }));
for (const q of [
  "when does the warranty expire in 2030", "which units are scheduled for service in 2027", "is the warranty still active in 2030",
  "was Nancy Zamora's invoice from this year, or was the 2030 invoice hers", "what work did we do in June 2025", "what is the price of the 2030 model",
  "how many jobs will we do by 2028", "do we have an invoice dated after 2027",
]) check(`future: defers "${q}"`, !isFutureRecordQuestion(q, { today: "2026-09-25" }));

/* ---- 5. out-of-domain families (through the contact parser's Shape 0a) */
for (const q of ["how many miles in a marathon", "who wrote hamlet", "what is the speed of light", "play some music", "how tall is mount everest"])
  check(`out-of-domain: "${q}"`, parseContactLookupQuestion(q)?.field === "outOfDomain", JSON.stringify(parseContactLookupQuestion(q)));
for (const q of ["how many customers are in our single biggest city", "how many miles is the Mesa job from the shop", "what is the capital cost on the invoice", "how many people live at 123 Main St", "tell me about the Carrier unit at 5 Elm St"])
  check(`out-of-domain: not "${q}"`, parseContactLookupQuestion(q)?.field !== "outOfDomain", JSON.stringify(parseContactLookupQuestion(q)));

/* ---- 5b. live dispatch / availability status (loop 5): declined deterministically; record questions untouched */
for (const q of ["who's out on a call right now", "is anybody free this afternoon", "what's the truck status for this afternoon", "who's next up in the queue", "whats on the schedule for tomorrow",
  "which tech is free right now", "show me tomorrow's schedule", "who's on call this weekend", "anyone out on a job at the moment", "is anyone on the way to the customer now"])
  check(`live-status: declines "${q}"`, parseContactLookupQuestion(q)?.field === "outOfDomain", JSON.stringify(parseContactLookupQuestion(q)));
for (const q of ["is there anything scheduled for the ibarra account", "what did the dispatch note say about the Thomas Mercer call", "who was out to 123 Main St yesterday", "which customers are available in Mesa",
  "how many techs do we have", "which tech installed the unit at 5 Elm St", "how many jobs are scheduled for the next 30 days", "what jobs did the crew do today", "what time is the Mercer appointment", "who is the technician on the Salazar job"])
  check(`live-status: not "${q}"`, parseContactLookupQuestion(q)?.field !== "outOfDomain", JSON.stringify(parseContactLookupQuestion(q)));

/* ---- 6. brand canonicalization */
for (const [raw, want] of [["CARRIER", "Carrier"], ["Carrier Corp.", "Carrier"], ["carrier air conditioning", "Carrier"], ["Trane Technologies", "Trane"], ["Lennox International", "Lennox"], ["Daikin North America", "Daikin"], ["Goodman Manufacturing Co", "Goodman"],
  ["Carrier Rheem Hybrid", "Carrier Rheem Hybrid"], ["Carrier Xyzzy", "Carrier Xyzzy"], ["Unknown Brand", "Unknown Brand"]])
  check(`brand: "${raw}" -> "${want}"`, canonicalBrandLabel(raw) === want, `got ${canonicalBrandLabel(raw)}`);

/* ---- 7. tenant-name typo correction never invents a person */
const g = { technicians: Vocab.buildNameGlossary(["Kevin Pratt", "Danny Ochoa"]), customers: Vocab.buildNameGlossary(["Kevin Zimmerman"]) };
check("vocab: 'Kevinn Zimmerman' (customer, typo) is not rewritten to a technician-first-name hybrid", Vocab.correctTenantNameTypos("who is Kevinn Zimmerman's", g).corrected.includes("Kevinn Zimmerman"));
check("vocab: a real technician typo is still corrected", Vocab.correctTenantNameTypos("did Denny Ochoa's", g).corrected.includes("Danny Ochoa") || Vocab.correctTenantNameTypos("Denny Ochoa's jobs", g).corrected.includes("Danny Ochoa"));

/* ---- 8. THE_NAME_NOUN_RE root fix: full-corpus diff against the legacy (/i on the whole pattern) regex */
const LEGACY = /\bthe\s+([A-Z][A-Za-z'-]+(?:\s+[A-Za-z'-]+){0,2})\s+(?:unit|account|job|customer|install(?:ation)?|condenser|furnace|job site)\b/i;
for (const [q, want] of [["the oldest unit we have", null], ["how old is the newest unit", null], ["the same unit twice", null], ["the mercer unit warranty", "mercer"], ["the Salazar account phone", "Salazar"]])
  check(`the-name-noun: "${q}"`, (FP.extractSubject(q).name ?? null) === want, `got ${FP.extractSubject(q).name}`);
const texts = new Set();
const addFile = (f) => { try { const d = JSON.parse(fs.readFileSync(f, "utf8")); const qs = d.questions ?? d; for (const q of Array.isArray(qs) ? qs : Object.values(qs)) { if (q?.text) texts.add(q.text); for (const t of q?.turns ?? []) if (t?.text || t?.question) texts.add(t.text || t.question); } } catch { /* not a question file */ } };
const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (f.name.endsWith(".json")) addFile(p); } };
walk(path.join(ROOT, "test-docs/scorecard"));
const NON_NAME = /^(?:oldest|newest|older|newer|last|latest|recent|first|next|previous|prior|other|same|whole|entire|main|new|old|only|biggest|largest|smallest|bigger|larger|smaller|current|existing|original|second|third|fourth|fifth|single|each|every|all|any|this|that|these|those|our|my|your|their|his|her|its|a|an|ac|hvac|air|outdoor|indoor|rooftop|roof|package|split|central|gas|electric|heating|cooling|upstairs|downstairs|front|back|rear|big|small|large|customer|customers|first-floor|second-floor)\b/i;
let changed = 0; let bad = [];

for (const t of texts) {
  const oldCap = LEGACY.exec(t)?.[1] ?? null;
  const newCap = FP.theNameNounCapture ? FP.theNameNounCapture(t) : undefined;
  if (newCap === undefined) break;
  if ((oldCap ?? null) !== (newCap ?? null)) { changed++; if (!(oldCap && NON_NAME.test(oldCap))) bad.push([t, oldCap, newCap]); }
}
if (FP.theNameNounCapture) check(`the-name-noun: full-corpus diff (${texts.size} texts): every changed capture was a non-name lead word`, bad.length === 0, JSON.stringify(bad.slice(0, 5)) + ` (changed ${changed})`);

console.log(`\n${failures ? `${failures} check(s) FAILED.` : `${passes} checks passed.`}`);
process.exit(failures ? 1 : 0);
