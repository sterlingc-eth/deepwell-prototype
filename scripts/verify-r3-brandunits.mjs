/**
 * R3 brand/refrigerant unit counts (Loop 2026-10-04): "how many carrier units" must name the brand it counted; "R410A units" must count units, not documents. Kill switch DONOVAN_BRAND_UNITS=0.
 * Expected values are computed from the golden export, not hard-coded. Model blocked.
 *   npx tsx scripts/verify-r3-brandunits.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0, passes = 0;
const check = (name, ok, detail = "") => { if (ok) passes++; else failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`); };
process.env.NEON_CONNECTION_STRING = "postgres://harness:harness@localhost:5432/harness";
delete process.env.ANTHROPIC_API_KEY;
const realLog = console.log; console.warn = () => {}; const realErr = console.error; console.error = () => {};

const exp = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/golden/golden-export.json"), "utf8"));
const ex = new Map(); for (const x of exp.extractions) { if (!ex.has(x.document_id)) ex.set(x.document_id, {}); const o = ex.get(x.document_id); if (!(x.field_key in o)) o[x.field_key] = x.corrected_value || x.value; }
const fin = new Map(exp.financials.map((f) => [f.document_id, f]));
const custs = exp.entities.filter((e) => e.entity_type === "customer" && !e.merged_into && e.data?.customer_name);
const docDate = (d) => (ex.get(d.id)?.service_date || fin.get(d.id)?.invoice_date || "").slice(0, 10);
const docsOf = (c) => { const ents = new Set(exp.entities.filter((x) => x.id === c.id || x.customer_id === c.id).map((x) => x.id)); const ids = new Set(exp.document_entity_links.filter((l) => ents.has(l.entity_id)).map((l) => l.document_id)); return exp.documents.filter((d) => ids.has(d.id)); };
const nameCount = new Map(); for (const c of custs) nameCount.set(c.data.customer_name, (nameCount.get(c.data.customer_name) || 0) + 1);
const uniq = custs.filter((c) => nameCount.get(c.data.customer_name) === 1 && /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(c.data.customer_name));
const cnt = (c, type, y) => docsOf(c).filter((d) => d.document_type === type && docDate(d).startsWith(y)).length;
const units = exp.entities.filter((e) => e.entity_type === "equipment" && !e.merged_into).map((e) => e.data);
const nb = (b) => units.filter((u) => (u.manufacturer || "").toLowerCase() === b).length;
const nr = (r, b) => units.filter((u) => (!b || (u.manufacturer || "").toLowerCase() === b) && (u.refrigerant || "").toLowerCase().replace(/[^a-z0-9]/g, "") === r).length;
const L = (b) => b[0].toUpperCase() + b.slice(1);
const CASES = [];
for (const [b, t] of [["carrier", ["how many carrier units do we have", "how many carrier units?", "number of carrier systems", "how many carier units", "hw many Carrier units we got", "count of carrier equipment on file"]], ["trane", ["how many trane units", "how many Trane systems do we have", "how mny trane units", "total trane units", "how many trane heat pumps"]], ["lennox", ["how many lennox units", "How many lennox units are there?", "how many lennox sytems", "number of lennox units we have"]]]) for (const q of t) CASES.push([q, nb(b), L(b)]);
CASES.push(["how many rheem units", nb("rheem"), "Rheem"], ["how many york or goodman units", nb("york") + nb("goodman"), "York"], ["how many daikin and mitsubishi units", nb("daikin") + nb("mitsubishi"), "Daikin"]);
CASES.push(["how many R410A units", nr("r410a"), "410A"], ["how many r-410a systems do we have", nr("r410a"), "410A"], ["how many R410A units are there", nr("r410a"), "410A"], ["number of R22 units", 0, "22"], ["how many r22 systems", 0, "22"], ["how many R-454B units", nr("r454b"), "454B"], ["how many carrier R410A units", nr("r410a", "carrier"), "Carrier"], ["how many trane units use r410a", nr("r410a", "trane"), "Trane"], ["how many units are carrier", nb("carrier"), "Carrier"]);
const bad = (t) => /documents? mention|mention(?:s|ed)? refrigerant/i.test(t);
const offline = await import(path.join(ROOT, "scripts/offline-exam.mjs"));
const { installPgHarness, installModelBlock, createPGlite, setActiveDatabase, loadExportIntoNewTenant } = offline;
console.log = () => {};
await installPgHarness(); await installModelBlock();
const lite = await createPGlite(); await setActiveDatabase(lite);
const { ctx } = await loadExportIntoNewTenant(lite, exp, { tenantKey: "offline:r3-nameyear", tenantName: "R3 Nameyear" });
const handler = (await import(path.join(ROOT, "api/ask.js"))).default;
const { askViaHandler } = await import(path.join(ROOT, "api/_lib/scorecard/askCall.js"));
console.log = realLog;
const auth = { tenantId: ctx.tenantKey, orgId: ctx.tenantName ?? ctx.tenantKey, userId: null };
const ask = async (question) => { console.log = () => {}; try { const r = await askViaHandler({ handler, auth, question, today: "2026-09-25" }); return String(r.data?.answer ?? r.data?.text ?? JSON.stringify(r.data ?? r.error)); } finally { console.log = realLog; } };
const hasNum = (t, k) => new RegExp(`(?<![\\d,.$/-])${k}(?![\\d,]|\\.\\d)`).test(t.replace(/\$[\d,]+(?:\.\d+)?/g, " ").replace(/\b(?:19|20)\d\d(?:-\d\d(?:-\d\d)?)?\b/g, " "));
const badName = (t) => /couldn't find a customer named[^.]*\b(?:in|during|for)\b/i.test(t) || /customer named[^.]*\b(?:19|20)\d\d\b/.test(t);

for (const [q, want, lab] of CASES) {
  const t = await ask(q);
  const ok = !bad(t) && t.includes(lab) && (want === 0 ? /\b(?:0|no|none|zero)\b/i.test(t) : hasNum(t, String(want)));
  check(`"${q}" -> ${want} ${lab}`, ok, t.slice(0, 220));
}
// negative controls: these must NOT change
const c1 = await ask("how many units do we have");
check("control: plain unit count never names a brand", !/of \d+ units are/.test(c1), c1.slice(0, 200));
const c2 = await ask(`how many carrier units at ${custs[0].data.customer_name}`);
check("control: customer-qualified brand count is not answered as a whole-company brand count", !/\bof 132 units are Carrier/.test(c2), c2.slice(0, 200));
const c3 = await ask("how many carrier units installed in 2015");
check("control: dated brand count is not answered as an all-time brand count", !/\bof 132 units are Carrier/.test(c3), c3.slice(0, 200));
const c4 = await ask("how many invoices");
check("control: invoice count unchanged", !/units are/.test(c4), c4.slice(0, 200));
// 2026-10 reviewer: paperwork fallback must be scoped to the unit the page is about (serial >= 4 chars, no other unit's serial, refrigerant on that page).
{
  const { runBrandUnitCount } = await import(path.join(ROOT, "api/_lib/lookups/brandUnitCount.js"));
  const U = (id, sn, rf = "") => ({ id, mfr: "carrier", rf, sn });
  const mk = (units, pages) => ({ raw: async (sql) => (/FROM entities/.test(sql) ? { rows: units } : /document_pages/.test(sql) ? { rows: pages } : { rows: [] }) });
  const count = async (units, pages) => { const r = await runBrandUnitCount(mk(units, pages), { brands: [], refrig: "22" }).catch(() => null); return r; };
  const units = [U("u1", "ab12345"), U("u2", "zz98765")];
  const two = [{ id: "u1", t: "service ticket ab12345: unit 1 recharged r-22. zz98765: unit 2 no refrigerant work" }, { id: "u2", t: "service ticket ab12345: unit 1 recharged r-22. zz98765: unit 2 no refrigerant work" }];
  const r1 = await count(units, two);
  check("paperwork scope: a ticket naming two units' serials counts neither", r1 && /^0 of 2 units are R-22/.test(r1.text) && !/paperwork/.test(r1.text.replace(/in their paperwork/g, "")), r1?.text);
  const r2 = await count(units, [{ id: "u1", t: "install ab12345 r-22 charge" }, { id: "u2", t: "unit zz98765 checked, no refrigerant work" }]);
  check("paperwork scope: a page with only this unit's serial and the refrigerant counts that unit only", r2 && /^1 of 2 units are R-22/.test(r2.text) && /1 more say so in their paperwork/.test(r2.text), r2?.text);
  const r3 = await count(units, [{ id: "u1", t: "unit one recharged r-22 (no serial printed)" }, { id: "u2", t: "serial zz9 r-22" }]);
  check("paperwork scope: a page without the unit's serial (or with a < 4 char serial) counts nothing", r3 && /^0 of 2 units are R-22/.test(r3.text), r3?.text);
  const r4 = await count([U("u1", "ab1"), U("u2", "zz98765")], [{ id: "u1", t: "ab1 r-22" }]);
  check("paperwork scope: serial shorter than 4 chars never matches", r4 && /^0 of 2 units are R-22/.test(r4.text), r4?.text);
  // P8: whole-token match; a serial needs >= 5 chars AND a digit ("none", "2026" can never match)
  const r5 = await count([U("u1", "none"), U("u2", "zz98765")], [{ id: "u1", t: "none of the units: r-22 recharge" }]);
  check("paperwork scope: a serial of letters only (\"none\") never matches", r5 && /^0 of 2 units are R-22/.test(r5.text), r5?.text);
  const r6 = await count([U("u1", "2026"), U("u2", "zz98765")], [{ id: "u1", t: "visit 2026 r-22 recharge" }]);
  check("paperwork scope: a four-digit serial (\"2026\") never matches", r6 && /^0 of 2 units are R-22/.test(r6.text), r6?.text);
  const r7 = await count([U("u1", "ab12345"), U("u2", "zz98765")], [{ id: "u1", t: "install xab123456 r-22 charge" }]);
  check("paperwork scope: a serial inside a longer token never matches", r7 && /^0 of 2 units are R-22/.test(r7.text), r7?.text);
  const r8 = await count([U("u1", "ab12345"), U("u2", "zz98765")], [{ id: "u1", t: "install s/n ab12345, r-22 charge" }]);
  check("paperwork scope: a whole-token serial next to punctuation still matches", r8 && /^1 of 2 units are R-22/.test(r8.text), r8?.text);
}
console.error = realErr;
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
