/**
 * R3 warranty-expiring-by-period ("units expiring this year", "warranties ending in 2026", "which equipment has a warranty running out next year"): every phrasing must give ONE consistent answer (count + units + citation + a plain line naming the date basis); honest none-on-file when zero. Kill switch DONOVAN_WARR_EXP=0.
 * Names computed from the golden export. Model blocked.   npx tsx scripts/verify-r3-warrexp.mjs
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
const offline = await import(path.join(ROOT, "scripts/offline-exam.mjs"));
const { installPgHarness, installModelBlock, createPGlite, setActiveDatabase, loadExportIntoNewTenant } = offline;
console.log = () => {};
await installPgHarness(); await installModelBlock();
const lite = await createPGlite(); await setActiveDatabase(lite);
const { ctx } = await loadExportIntoNewTenant(lite, exp, { tenantKey: "offline:r3-warrexp", tenantName: "R3 Warrexp" });
const handler = (await import(path.join(ROOT, "api/ask.js"))).default;
const { askViaHandler } = await import(path.join(ROOT, "api/_lib/scorecard/askCall.js"));
console.log = realLog;
const auth = { tenantId: ctx.tenantKey, orgId: ctx.tenantName ?? ctx.tenantKey, userId: null };
const ask = async (question) => { console.log = () => {}; try { const r = await askViaHandler({ handler, auth, question, today: "2026-09-25" }); return String(r.data?.answer ?? r.data?.text ?? JSON.stringify(r.data ?? r.error)); } finally { console.log = realLog; } };
const hasNum = (t, k) => new RegExp(`(?<![\\d,.$/-])${k}(?![\\d,]|\\.\\d)`).test(t.replace(/\$[\d,]+(?:\.\d+)?/g, " ").replace(/\b(?:19|20)\d\d(?:-\d\d(?:-\d\d)?)?\b/g, " "));
const badName = (t) => /couldn't find a customer named[^.]*\b(?:in|during|for)\b/i.test(t) || /customer named[^.]*\b(?:19|20)\d\d\b/.test(t);


const units = exp.entities.filter((e) => e.entity_type === "equipment" && !e.merged_into && /^\d{4}-\d\d-\d\d/.test(e.data?.warranty?.expires ?? ""));
const exp_ = (from, to) => units.filter((u) => { const d = u.data.warranty.expires.slice(0, 10); return d >= from && d <= to; }).map((u) => u.data.warranty.expires.slice(0, 10)).sort();
const SETS = {
  y26: { dates: exp_("2026-01-01", "2026-12-31"), qs: ["units expiring this year", "warranties expiring 2026", "which units have warranties expiring in 2026", "units with warranty ending this year", "which equipment has a warranty that runs out this year", "whose warranty expires in 2026", "any warranties up this year?", "show me warranties ending in 2026", "how many warranties expire this year", "warrenty expireing this year", "systems whose warranties end in 2026", "list the units with warranties expiring this calendar year", "what warranties run out in 2026", "which of our units come off warranty this year", "equipment with a warranty expiring during 2026", "can you tell me which units have warrantys that expire this year"] },
  y27: { dates: exp_("2027-01-01", "2027-12-31"), qs: ["units with warranties expiring next year", "which warranties expire in 2027", "equipment warranty ending next year", "how many warranties run out in 2027", "which systems have a warranty that expires next year", "list warranties expiring 2027"] },
  y28: { dates: exp_("2028-01-01", "2028-12-31"), qs: ["which units have warranties expiring in 2028", "warranties ending 2028"] },
  mNext: { dates: exp_("2026-10-01", "2026-10-31"), qs: ["warranties expiring next month", "which units have a warranty ending next month", "how many warranties expire next month"] },
  mThis: { dates: exp_("2026-09-01", "2026-09-30"), qs: ["warranties expiring this month", "which units have warranties that end this month"] },
  q4: { dates: exp_("2026-10-01", "2026-12-31"), qs: ["warranties expiring in Q4", "which units have warranties ending in the fourth quarter", "units whose warranty expires in Q4 2026"] },
  q2n: { dates: exp_("2027-04-01", "2027-06-30"), qs: ["warranties expiring in Q2 2027"] },
};
const MARK = (t) => /date basis/i.test(t) && /warranty end date/i.test(t);
for (const [k, set] of Object.entries(SETS)) {
  for (const q of set.qs) {
    const t = await ask(q); if (process.env.PROBE) realLog(q + " => " + t.slice(0, 300).replace(/\n/g, " | "));
    const n = set.dates.length;
    const countOk = n === 0 ? /\b(?:none|no units?|no warrant|0 units|nothing)\b/i.test(t) : hasNum(t, n) && set.dates.slice(0, 8).every((d) => t.includes(d));
    check(`[${k}] "${q}" -> ${n} unit(s), basis stated, no failure`, MARK(t) && countOk && !/processing failed|couldn't find|no pieces of equipment match/i.test(t), t.slice(0, 260));
  }
}
const NEG = ["is the warranty on my Trane transferable", "how long is the warranty on a Carrier furnace", "what does the warranty cover", "units with expired warranties", "how many units are out of warranty", "which units are still under warranty", "when does the warranty expire on the Rheem at 544 E Ray Rd", "what is the earliest warranty expiration on file", "how many service visits this year", "invoices expiring this year", "list the techs", "customers with agreements expiring this year", "which units were installed this year", "does the warranty cover labor", "units expiring soon without a warranty on file", "register my warranty", "How many units have a warranty expiring in the next year?", "units with warranties expiring within 90 days", "warranties expiring in the next 12 months"];
for (const q of NEG) { const t = await ask(q); if (process.env.PROBE) realLog("NEG " + q + " => " + t.slice(0, 200).replace(/\n/g, " | ")); check(`negative not claimed: "${q}"`, !MARK(t), t.slice(0, 200)); }
const off = process.env.DONOVAN_WARR_EXP;
console.error = realErr;
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
