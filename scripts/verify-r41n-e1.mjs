#!/usr/bin/env node
/**
 * R41n E1: dropped conditions in counts. Pure checks (no DB, no model): the leftover guard declines when a typed year / unknown brand / kind of equipment / typo'd
 * qualifier was not used by the lane, and still lets the fully-explained form through (negatives and controls); the county/city twin and the "units" readings.
 *   node scripts/verify-r41n-e1.mjs
 */
import { detectAnalyticsPlan } from "../api/_lib/analytics/detPlan.js";
import { finalizePlanInput } from "../api/_lib/routes/analytics.js";
import { leftoverWords, domainWordsFromVocab } from "../api/_lib/router/leftover.js";
import { normalizeQuestion } from "../api/_lib/nlNormalize.js";
import { resolveCountyCityTwin, markUnitsAsked, mentionsPlainUnits } from "../api/_lib/lookups/rentalUnits.js";

const TODAY = "2026-09-25";
const vocab = { brands: ["Carrier", "Rheem", "Trane"], cities: ["Mesa", "Tucson", "Maricopa"], equipmentTypes: ["water heater (tank)", "backflow preventer"], docTypePhrases: [{ phrase: "backflow test report" }], industryWords: ["plumbing"] };
const sigOf = (x) => JSON.stringify(finalizePlanInput(detectAnalyticsPlan(normalizeQuestion(x, {}).normalized, vocab, TODAY), normalizeQuestion(x, {}).normalized, TODAY) ?? null);
const lo = (q, entityKey = "equipment") => leftoverWords(q, sigOf, { lane: "analytics", plain: false, entityKey, domainWords: domainWordsFromVocab(vocab), normalized: normalizeQuestion(q, {}).normalized });
let fail = 0;
const ok = (cond, msg) => { if (!cond) { fail++; console.log("FAIL", msg); } };
const declines = (q) => ok(lo(q).length > 0, `must decline: ${q}`);
const answers = (q) => ok(lo(q).length === 0, `must answer: ${q} (flagged ${JSON.stringify(lo(q))})`);

// a year the lane did not use (hv41-069), an unknown brand with a year (hv41-114), a kind of equipment that was dropped (pl41-102)
declines("number of Carrier systems installed 2017");
declines("how many Fujitsus did we install in 2013");
declines("how many Zephyrcool units installed in 2013");           // unknown name
declines("how many backflow preventers did we install in 2022");   // type word the lane never filtered on
declines("how many manitenance visits did Kevin Pratt do in 2025"); // typo'd qualifier before a job noun
// controls: the same conditions fully used must still answer
answers("how many Carrier units installed in 2017");
answers("how many Carriers did we install in 2017");               // plural of a brand the org has
answers("how many units were installed in 2017");
answers("how many invoices in august 2026");                       // a year after a month belongs to the month
// negation and two values of one dimension: used by the lane (neq / in), never silently dropped
ok(/"op":"neq"/.test(sigOf("how many units other than Carrier")) || lo("how many units other than Carrier").length > 0, "negation kept or declined");
ok(/"op":"in"/.test(sigOf("how many Carrier or Trane units")) || lo("how many Carrier or Trane units").length > 0, "two brands kept or declined");
ok(sigOf("how many Rheem units in Mesa and Tucson") === "null" || lo("how many Rheem units in Mesa and Tucson").length > 0, "two cities kept or declined");

// "Maricopa" is a county AND a city: bare name = the city (as the shop's own count lane reads it); "county" keeps only the county; never both filters at once
const twin = { entity: "customers", op: "count", filters: [{ field: "county", op: "eq", value: "Maricopa" }, { field: "city", op: "eq", value: "Maricopa" }] };
const bare = resolveCountyCityTwin(twin, "customers in Maricopa running Rheem");
ok(bare.filters.length === 1 && bare.filters[0].field === "city", "bare twin -> city only");
const cty = resolveCountyCityTwin(twin, "customers in Maricopa county");
ok(cty.filters.length === 1 && cty.filters[0].field === "county" && cty.placeReading === "county", "county word -> county only");
const two = { entity: "customers", op: "count", filters: [{ field: "county", op: "eq", value: "Pinal" }, { field: "city", op: "eq", value: "Maricopa" }] };
ok(resolveCountyCityTwin(two, "customers in Maricopa") === two, "different county and city values are left alone");
ok(resolveCountyCityTwin({ entity: "customers", op: "count", filters: [{ field: "city", op: "eq", value: "Mesa" }] }, "x").filters.length === 1, "single filter untouched");

// "units" asked of a customers plan counts units; a customer / property wording is left alone
ok(markUnitsAsked("Maricopa units on R-410A, how many", { entity: "customers", op: "count", filters: [] }).countUnits === true, "units asked -> countUnits");
ok(!markUnitsAsked("how many customers have units older than 15 years", { entity: "customers", op: "count", filters: [] }).countUnits, "customers wording untouched");
ok(!markUnitsAsked("how many properties have more than one unit installed", { entity: "customers", op: "count", filters: [] }).countUnits, "properties wording untouched");
// a property tenant's plain "units" is not equipment, but a unit-level filter (brand) or equipment word is
ok(mentionsPlainUnits("how many units do we have in Tucson", { entity: "customers", op: "count", filters: [{ field: "city", op: "eq", value: "Tucson" }] }), "plain units + place only -> candidate");
ok(!mentionsPlainUnits("Maytag units in our buildings", { entity: "equipment", op: "count", filters: [{ field: "brand", op: "eq", value: "Maytag" }] }), "brand filter -> equipment");
ok(!mentionsPlainUnits("how many water heaters in Tucson", { entity: "equipment", op: "count", filters: [] }), "equipment word -> equipment");

// brand/type + city + year must never silently drop one: a dated customers plan with a unit attribute declines; undated or place-only plans pass through
const tw = { from: "2022-01-01", to: "2022-12-31" };
ok(resolveCountyCityTwin({ entity: "customers", op: "count", filters: [{ field: "brand", op: "eq", value: "Carrier" }, { field: "city", op: "eq", value: "Phoenix" }], timeRange: tw }, "installed in 2022") === null, "brand+city+year declines");
ok(resolveCountyCityTwin({ entity: "customers", op: "count", filters: [{ field: "equipmentType", op: "eq", value: "boiler" }, { field: "city", op: "eq", value: "Tucson" }], timeRange: tw }, "installed in 2022") === null, "type+city+year declines");
ok(resolveCountyCityTwin({ entity: "customers", op: "count", filters: [{ field: "brand", op: "eq", value: "Carrier" }, { field: "city", op: "eq", value: "Phoenix" }] }, "q") !== null, "brand+city undated answers");
ok(resolveCountyCityTwin({ entity: "equipment", op: "count", filters: [{ field: "brand", op: "eq", value: "Carrier" }], timeRange: tw }, "q") !== null, "equipment brand+year (window applied) answers");

console.log(fail ? `${fail} FAILED` : "verify-r41n-e1: all passed");
process.exit(fail ? 1 : 0);
