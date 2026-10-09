#!/usr/bin/env node
// Hostile-review harness for the R5 organization-driven pick. Input: a JSON file { "fixture": "office"|"hvac"|"golden"|<export.json path>, "cases": [ { "q": "question", "pick": <the raw structure an ideal reader would return, or null for 'none'>, "has": ["substring that must be in the answer"], "not": ["substring that must NOT be in the answer"], "note": "..." } ] }
// Each case runs through the REAL /api/ask handler with DONOVAN_MENU_PICK=1 and a transport that returns exactly `pick` (so the code around the model is tested, not the model). Also prints the answer with the switch OFF for comparison.
// usage: node scripts/review-orgpick-run.mjs cases.json
import fs from "node:fs";
const spec = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const realLog = console.log; console.log = () => {}; console.warn = () => {}; console.error = () => {};
const off = await import("./offline-exam.mjs");
await off.installPgHarness(); await off.installModelBlock();
const { askViaHandler } = await import("../api/_lib/scorecard/askCall.js");
const { default: askHandler } = await import("../api/ask.js");
const OM = await import("../api/_lib/records/orgMenu.js");
const OC = await import("../api/_lib/records/orgPickCall.js");
let data;
if (spec.fixture === "office") data = (await import("./lib/office-fixture-r4.mjs")).buildOfficeFixture({ variant: "A" }).export;
else if (spec.fixture === "hvac") data = (await import("./lib/records-fixture.mjs")).buildRecordsFixture({ variant: "A", extraCustomers: 14 }).export;
else if (spec.fixture === "golden") data = (await import("./lib/records-fixture.mjs")).loadGolden();
else data = JSON.parse(fs.readFileSync(spec.fixture, "utf8"));
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const ctx = (await off.loadExportIntoNewTenant(lite, data, { tenantKey: "offline:review", tenantName: "review" })).ctx;
const run = async (q, on) => {
  if (on) process.env.DONOVAN_MENU_PICK = "1"; else delete process.env.DONOVAN_MENU_PICK;
  OC.clearOrgPickCache(); OM.clearInventoryCache();
  const r = await askViaHandler({ handler: askHandler, auth: { tenantId: ctx.tenantKey, orgId: "review", userId: null }, question: q, today: spec.today ?? "2026-10-07" });
  return `${r.data?.text ?? ""}${(r.data?.facts ?? []).length ? "  [cards: " + r.data.facts.map((f) => `${f.label}=${f.value}`).join(" | ") + "]" : ""}`;
};
let bad = 0; const out = [];
for (const c of spec.cases) {
  OC.setOrgPickTransport(async () => (c.pick === null || c.pick === undefined ? { none: true } : c.pick));
  const on = await run(c.q, true); const base = await run(c.q, false);
  const missing = (c.has ?? []).filter((x) => !on.toLowerCase().includes(String(x).toLowerCase()));
  const forbidden = (c.not ?? []).filter((x) => on.toLowerCase().includes(String(x).toLowerCase()));
  const verdict = missing.length || forbidden.length ? "FAIL" : "ok";
  if (verdict === "FAIL") bad++;
  out.push({ q: c.q, verdict, missing, forbidden, answer_on: on.slice(0, 400), answer_off: base.slice(0, 250), note: c.note });
}
realLog(JSON.stringify(out, null, 1));
realLog(`REVIEW-HARNESS: ${spec.cases.length - bad}/${spec.cases.length} ok`);
process.exit(0);
