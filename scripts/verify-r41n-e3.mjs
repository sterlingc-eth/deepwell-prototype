#!/usr/bin/env node
// R41N E3: parse-level positive + NEGATIVE tests for vendorBills / quotedPhraseCount / docFindingWho / docNumberLookup bill wording.
import assert from "node:assert/strict";
import { parseVendorBills } from "../api/_lib/lookups/vendorBills.js";
import { parseQuotedPhraseCount } from "../api/_lib/lookups/quotedPhraseCount.js";
import { parseFindingWho } from "../api/_lib/lookups/docFindingWho.js";
import { parseDocNumberQuestion } from "../api/_lib/lookups/docNumberLookup.js";
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

// vendor bills
ok(parseVendorBills("total billed by Fresh Start Cleaning")?.op === "total", "total billed by");
ok(parseVendorBills("what's the most Clearview Glass ever charged us on one invoice")?.op === "max", "max");
ok(parseVendorBills("how much have we paid AllStar Locksmith for cleaning")?.unknownName === "AllStar Locksmith", "unknown vendor name");
ok(parseVendorBills("how many invoices has Clearview Glass sent") === null, "count is not ours");
ok(parseVendorBills("total billed by Fresh Start Cleaning in 2024") === null, "dated spend is not ours");
ok(parseVendorBills("which invoices are overdue") === null, "no money verb");
ok(parseVendorBills("show unpaid bills from Clearview Glass") === null, "unpaid is not ours");
// quoted phrase counts
ok(parseQuotedPhraseCount('how many work orders for "unclogged kitchen drain" in 2026')?.year === "2026", "quoted + year");
ok(parseQuotedPhraseCount("how many work orders for unclogged kitchen drain in 2026") === null, "no quotes");
ok(parseQuotedPhraseCount('how many work orders for "unclogged kitchen drain" last month') === null, "relative date declines");
ok(parseQuotedPhraseCount('list the work orders for "unclogged kitchen drain"') === null, "not a count");
ok(parseQuotedPhraseCount('how many "fixed leaking faucet" and "unclogged kitchen drain" work orders') === null, "two phrases");
// who / finding / city / brand
ok(parseFindingWho("who tested Jessica Estrada's backflow")?.shape === "who-did", "who-did");
ok(parseFindingWho("who tseted Donna Maldonado's backflow")?.shape === "who-did", "typo verb");
ok(parseFindingWho("who loved Donna Maldonado's backflow") === null, "unknown verb");
ok(parseFindingWho("who tested jessica estrada's backflow") === null, "lowercase name is not a name");
ok(parseFindingWho("who got root intrusion on the sewer scope")?.shape === "finding", "finding list");
ok(parseFindingWho("how many sewer camera jobs found root problems")?.mode === "count", "finding count");
ok(parseFindingWho("how many Rheem water heaters do we have in Nogales") === null, "unit count is not a finding count");
ok(parseFindingWho("how many customers have a Navien") === null, "customer count not ours");
ok(parseFindingWho("who in Vail has a water softener")?.city === "Vail", "city-type");
ok(parseFindingWho("Ashley Figueroa's Bosch - what model")?.brand === "Bosch", "brand-unit");
ok(parseFindingWho("Ashley Figueroa's heater what model") === null, "lowercase noun is not a make");
ok(parseFindingWho("what's the total for Ashley Figueroa") === null, "unrelated");
// "who billed us on INV-x" is still a single-document lookup
ok(parseDocNumberQuestion("who billed us on INV-52126")?.typed === "INV-52126", "doc number");

// ---- DB-level negatives on the property tenant (vendor bills + quoted counts)
import fs from "node:fs";
const off = await import("./offline-exam.mjs");
const rl = console.log; console.log = () => {}; console.warn = () => {}; console.error = () => {};
await off.installPgHarness(); await off.installModelBlock();
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const ed = JSON.parse(fs.readFileSync("test-docs/tenants/property/export.json", "utf8"));
const { ctx } = await off.loadExportIntoNewTenant(lite, ed, { tenantKey: `offline:${ed.tenantKey}`, tenantName: ed.tenantName });
const { withTenant } = await import("../api/_lib/recordsStore.js");
const { runVendorBills } = await import("../api/_lib/lookups/vendorBills.js");
const { runQuotedPhraseCount } = await import("../api/_lib/lookups/quotedPhraseCount.js");
const vb = (q) => withTenant(ctx, (db) => { const it = parseVendorBills(q); return it ? runVendorBills(db, it) : null; });
const qc = (q) => withTenant(ctx, (db) => { const it = parseQuotedPhraseCount(q); return it ? runQuotedPhraseCount(db, it) : null; });
const txt = (r) => r?.text ?? null;
ok(/billed us \$/.test(txt(await vb("total billed by Tucson Pest Control"))), "plain vendor total still answers");
ok(await vb("total billed by Tucson Pest Control for unit 1A") === null, "unit qualifier declines");
ok(await vb("total billed by Tucson Pest Control at 9135 W Ina Rd") === null, "address qualifier declines");
ok(await vb("most Tucson Pest Control charged us on one invoice for unit 1A") === null, "max with unit declines");
const paid = txt(await vb("How much have we paid Tucson Pest Control in total?"));
ok(!paid || /recorded as paid|not recorded/.test(paid), "paid is not the billed total");
for (const nm of ["Acme Roofing", "Saguaro Ridge Property Management", "Carrier Corporation"]) {
  const r = txt(await vb(`How much have we paid ${nm}?`));
  ok(r === null || (!/\$/.test(r) && /No bills from/.test(r)), `unknown name ${nm}: no paid/$ claim`);
}
ok(await qc('how many "unclogged kitchen drain" work orders for Julia Lopez') === null, "customer qualifier declines");
ok(await qc('how many "unclogged kitchen drain" work orders at 9135 W Ina Rd') === null, "address qualifier declines");
ok(await qc('how many "unclogged kitchen drain" work orders were not done by Rivera Plumbing') === null, "negation declines");
ok(await qc('how many "replaced water heater element" invoices in 2025') === null, "year on a type without service date declines");
const riv = txt(await qc('how many times has Rivera done "serviced AC unit"'));
ok(!riv || /Rivera Plumbing/.test(riv), "partial vendor name filters by that vendor");
console.log = rl;
console.log(`verify-r41n-e3: ${n} checks passed`);
