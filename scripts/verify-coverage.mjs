#!/usr/bin/env node
// B3: coverage check against the tracked schema (api/_lib/router/coverage.js) and the negation guard (classifyAll leftoverDecline).
import fs from "node:fs";
import { classifyCoverage, trackedVocabulary } from "../api/_lib/router/coverage.js";
import { classifyEarlyDecline, buildEarlyDeclineAnswer } from "../api/_lib/router/earlyDecline.js";
let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.log("FAIL", m); } };

// 1. untracked measures decline, by class
const DECLINE = [
  "what's the customer satisfaction score", "how many gallons of gas did the fleet use last month", "what's our cash balance in the bank",
  "when is Jane Doe's birthday", "how much does Sam Roe make per hour", "which truck is Alex Poe driving", "did any customer complain about Pat Lee",
  "what's our no-show rate for appointments", "how many hours did the techs actually clock last week", "how much stock of filters is in the warehouse",
  "how many leads came from google ads",
];
for (const q of DECLINE) {
  const e = classifyEarlyDecline(q, {});
  ok(e && e.measure === true, `should decline: ${q}`);
  if (e) ok(/not in your business records/i.test(buildEarlyDeclineAnswer(e.kind, e).text), `reuses existing decline sentence: ${q}`);
}
// 2. real record questions are never declined
const KEEP = [
  "how many gas furnaces do we have", "list what should i know about our equipment fleet", "how many invoices last month", "labor hours on the Smith job",
  "how many service tickets are on file", "what is the warranty end date at 123 Main Street", "how do I upload a document", "which customers have a maintenance agreement",
  "how many units were installed in 2019", "how many fuel pumps were replaced", "clock replacement invoice", "warehouse club invoices",
  "what is the savings on the maintenance agreement", "customer satisfaction survey document", "show invoice INV-20003",
];
for (const q of KEEP) ok(!classifyCoverage(q), `must not decline: ${q}`);
ok(classifyCoverage("what's our fuel spend")?.cls === "fuel", "fuel spend declines");
// trace terms cover short roots
import { coverageTraceTerms } from "../api/_lib/router/coverage.js";
for (const [t, r] of [["fuel", "fuel"], ["cash balance", "cash"], ["clocked in", "clock"], ["stock of", "stock"], ["wages", "wage"], ["churn", "churn"], ["nps", "nps"], ["which truck", "truck"], ["bank balance", "bank"]]) ok(coverageTraceTerms(t).includes(r), `trace root ${r} for ${t}`);
// 3. the tracked vocabulary comes from the schema
ok(trackedVocabulary().has("labor") && trackedVocabulary().has("invoice"), "tracked vocabulary built from schema");
// 4. zero new declines on the dev set (non-decl questions)
const DEV = "/home/claude/work/loop/r1/dev.json";
if (fs.existsSync(DEV)) {
  for (const x of JSON.parse(fs.readFileSync(DEV, "utf8"))) {
    if (x.category === "decl") continue;
    const e = classifyEarlyDecline(x.question, {});
    ok(!(e && e.measure === true), `new decline on ${x.id}: ${x.question}`);
  }
} else console.log("(dev set not present; skipped)");
console.log(fail ? `verify:coverage FAILED (${fail})` : "verify:coverage OK");
process.exit(fail ? 1 : 0);
