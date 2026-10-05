/**
 * R3 relname + rangenoun: (a) relative windows after a customer name ("invoices for <name> last year / this year / last month / this month / this quarter") apply the window instead of leaking into the name;
 * (b) shop-wide year ranges on a record noun without "how many" ("service tickets 2010-2012", "invoices from 2010 through 2012", "jobs from 2010 to 2012") answer like the count form. Kill switches DONOVAN_NAME_REL=0, DONOVAN_RANGE_NOUN=0.
 * Expected values computed from the golden export; today = 2026-09-25. Model blocked.   npx tsx scripts/verify-r3-relname.mjs
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
const inr = (c, type, a, b) => docsOf(c).filter((d) => d.document_type === type && docDate(d) && docDate(d) >= a && docDate(d) <= b).length;
const WINS = [["last year", "2025-01-01", "2025-12-31"], ["this year", "2026-01-01", "2026-12-31"], ["last month", "2026-08-01", "2026-08-31"], ["this month", "2026-09-01", "2026-09-30"], ["last quarter", "2026-04-01", "2026-06-30"], ["this quarter", "2026-07-01", "2026-09-30"], ["previous year", "2025-01-01", "2025-12-31"], ["during last year", "2025-01-01", "2025-12-31"], ["in this year", "2026-01-01", "2026-12-31"]];
const CASES = [];
let k = 0;
const TYPES = [["invoice", ["invoices", "invoice"]], ["service-ticket", ["tickets", "service tickets"]], ["work-order", ["work orders"]]];
for (const [label, a, b] of WINS) {
  const hits = uniq.filter((c) => inr(c, "invoice", a, b) > 0).slice(0, 2);
  const miss = uniq.filter((c) => inr(c, "invoice", a, b) === 0 && docsOf(c).some((d) => d.document_type === "invoice")).slice(0, 1);
  for (const c of [...hits, ...miss]) { const [type, words] = TYPES[k % 3]; const w = words[k++ % words.length]; const t = inr(c, type, a, b) || 0; CASES.push([`invoices for ${c.data.customer_name} ${label}`, inr(c, "invoice", a, b)]); if (k % 2) CASES.push([`${w} for ${c.data.customer_name} ${label}`, t]); }
}
const offline = await import(path.join(ROOT, "scripts/offline-exam.mjs"));
const { installPgHarness, installModelBlock, createPGlite, setActiveDatabase, loadExportIntoNewTenant } = offline;
console.log = () => {};
await installPgHarness(); await installModelBlock();
const lite = await createPGlite(); await setActiveDatabase(lite);
const { ctx } = await loadExportIntoNewTenant(lite, exp, { tenantKey: "offline:r3-relname", tenantName: "R3 Relname" });
const handler = (await import(path.join(ROOT, "api/ask.js"))).default;
const { askViaHandler } = await import(path.join(ROOT, "api/_lib/scorecard/askCall.js"));
console.log = realLog;
const auth = { tenantId: ctx.tenantKey, orgId: ctx.tenantName ?? ctx.tenantKey, userId: null };
const ask = async (question) => { console.log = () => {}; try { const r = await askViaHandler({ handler, auth, question, today: "2026-09-25" }); return String(r.data?.answer ?? r.data?.text ?? JSON.stringify(r.data ?? r.error)); } finally { console.log = realLog; } };
const hasNum = (t, k) => new RegExp(`(?<![\\d,.$/-])${k}(?![\\d,]|\\.\\d)`).test(t.replace(/\$[\d,]+(?:\.\d+)?/g, " ").replace(/\b(?:19|20)\d\d(?:-\d\d(?:-\d\d)?)?\b/g, " "));
const badName = (t) => /couldn't find a customer (?:named|at)\b[^.]*\b(?:last|this|previous|during|year|month|quarter)\b/i.test(t) || /Processing failed/.test(t);
for (const [q, want] of CASES) {
  const t = await ask(q);
  const ok = !badName(t) && (want === 0 ? /\b(?:0|no|none|zero|nothing)\b/i.test(t) : hasNum(t, String(want)));
  check(`"${q}" -> ${want}`, ok, t.slice(0, 200));
}
// (b) shop-wide ranges: the count form is the oracle, and must equal the golden export
const shopCount = (type, a, b) => exp.documents.filter((d) => d.document_type === type && docDate(d) && docDate(d) >= a && docDate(d) <= b).length;
const RN = [["invoices", "invoice"], ["service tickets", "service-ticket"], ["quotes", "quote"], ["work orders", "work-order"]];
const RANGES = [[2010, 2012], [2009, 2011], [2011, 2013], [2024, 2026]];
for (const [noun, type] of RN) for (const [y1, y2] of RANGES) {
  const base = await ask(`how many ${noun} from ${y1} to ${y2}`);
  for (const phr of [`${noun} ${y1}-${y2}`, `${noun} from ${y1} through ${y2}`, `${noun} from ${y1} to ${y2}`, `how many ${noun} ${y1}-${y2}`, `${noun} between ${y1} and ${y2}`]) {
    const t = await ask(phr);
    const num = (s) => (s.match(/\b\d+(?= (?:invoices?|service tickets?|quotes?|work orders?|documents?))/) || [])[0];
    const ok = !/Processing failed/.test(t) && num(t) != null && num(t) === num(base);
    check(`"${phr}" matches count form (${num(base)})`, ok, `${t.slice(0, 160)} || base: ${base.slice(0, 100)}`);
  }
}
const c1 = await ask("invoices for Zzyzx Quimby last year");
check("control: unknown name + relative window never claims a count and window not in name", !/\b\d+ invoices? on file\b/.test(c1) && !/Quimby Last/i.test(c1), c1.slice(0, 200));
const c2 = await ask("how many invoices last year");
check("control: shop-wide last year unchanged", hasNum(c2, String(shopCount("invoice", "2025-01-01", "2025-12-31"))), c2.slice(0, 200));
const c3 = await ask("invoices from 2010 to 2012 for Zzyzx Quimby");
check("control: name after the range does not produce a shop count", !/\b21 invoices\b/.test(c3), c3.slice(0, 200));
console.error = realErr;
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
