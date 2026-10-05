/**
 * R3 trailing date WINDOW after a customer name (Loop 2026-10-04): "invoices for Linda Fitzgerald from 2009 to 2011 / 2009-2011 / since 2009 / before 2010 / after 2008 / in september 2010 / in Q3 2010"
 * must apply the window, not look for a customer named "... Since 2009"; "PO for 2026" reads as purchase orders. Kill switch DONOVAN_NAME_WINDOW=0 (PO wording: DONOVAN_NAME_YEAR=0).
 * Blind set: golden tenant names only; expected counts computed from golden-export.json (service date, else invoice date). Model blocked.
 *   npx tsx scripts/verify-r3-namewindow.mjs
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
const TYPES = [["invoice", ["invoices", "invoice"]], ["service-ticket", ["tickets", "service tickets"]], ["work-order", ["work orders"]]];
const picked = [];
for (const c of uniq) { const ds = docsOf(c).filter((d) => d.document_type === "invoice" && docDate(d)); if (ds.length >= 1 && picked.length < 6 && !picked.some((p) => p.c.data.customer_name === c.data.customer_name)) picked.push({ c, ds: ds.map(docDate).sort() }); }
const inr = (c, type, a, b) => docsOf(c).filter((d) => d.document_type === type && docDate(d) && docDate(d) >= a && docDate(d) <= b).length;
const CASES = [];
let k = 0;
for (const { c, ds } of picked) {
  const n = c.data.customer_name, y = Number(ds[0].slice(0, 4)), m = ds[0].slice(5, 7), q = Math.floor((Number(m) - 1) / 3) + 1;
  const MONN = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"][Number(m) - 1];
  const w = (words) => words[k++ % words.length];
  for (const [type, words] of TYPES) {
    const nn = w(words);
    CASES.push([`${nn} for ${n} from ${y} to ${y + 2}`, inr(c, type, `${y}-01-01`, `${y + 2}-12-31`)]);
    CASES.push([`${nn} for ${n} ${y}-${y + 2}`, inr(c, type, `${y}-01-01`, `${y + 2}-12-31`)]);
    CASES.push([`${nn} for ${n} since ${y}`, inr(c, type, `${y}-01-01`, "9999-12-31")]);
    CASES.push([`${nn} for ${n} before ${y + 1}`, inr(c, type, "0001-01-01", `${y}-12-31`)]);
  }
  CASES.push([`invoices for ${n} in ${MONN} ${y}`, inr(c, "invoice", `${y}-${m}-01`, `${y}-${m}-31`)]);
  CASES.push([`invoices for ${n} in Q${q} ${y}`, inr(c, "invoice", `${y}-${String((q - 1) * 3 + 1).padStart(2, "0")}-01`, `${y}-${String(q * 3).padStart(2, "0")}-31`)]);
  CASES.push([`invoices for ${n} after ${y - 1}`, inr(c, "invoice", `${y}-01-01`, "9999-12-31")]);
  CASES.push([`invoices for ${n} between ${y} and ${y + 1}`, inr(c, "invoice", `${y}-01-01`, `${y + 1}-12-31`)]);
  CASES.push([`invoices for ${n} from 1990 to 1995`, 0]);
}
const poY = [...new Set(exp.documents.filter((d) => d.document_type === "purchase-order" && docDate(d)).map((d) => docDate(d).slice(0, 4)))].sort().pop() ?? "2026";
const poN = exp.documents.filter((d) => d.document_type === "purchase-order" && docDate(d).startsWith(poY)).length;
CASES.push([`PO for ${poY}`, poN]);
CASES.push([`POs for ${poY}`, poN]);
const typeYr = (type, y) => exp.documents.filter((d) => d.document_type === type && docDate(d).startsWith(y)).length;
const lc = picked[0];
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
const badName = (t) => /couldn't find a customer (?:named|at)\b[^.]*\b(?:in|during|for|from|since|before|after|between|through|until|Q[1-4]|(?:19|20)\d\d)\b/i.test(t);
for (const [q, want] of CASES) {
  const t = await ask(q);
  const ok = !badName(t) && (want === 0 ? /\b(?:0|no|none|zero|nothing)\b/i.test(t) : hasNum(t, String(want)));
  check(`"${q}" -> ${want}`, ok, t.slice(0, 200));
}
// negative controls: these must NOT change
const n0 = lc.c.data.customer_name;
const allInv = docsOf(lc.c).filter((d) => d.document_type === "invoice").length;
const c1 = await ask(`invoices for ${n0}`);
check(`control: undated "invoices for ${n0}" lists all ${allInv}`, hasNum(c1, String(allInv)), c1.slice(0, 200));
const c2 = await ask("invoices for Zzyzx Quimby since 2009");
check("control: unknown name + window still says no such customer, window not in the name", /couldn't find a customer named Zzyzx Quimby\b(?! Since)/i.test(c2), c2.slice(0, 200));
const c3 = await ask("invoices for Zzyzx Quimby from 2009 to 2011");
check("control: unknown name + range never claims a count", !/\b\d+ invoices? on file\b/.test(c3) && !/Quimby From/i.test(c3), c3.slice(0, 200));
const c4 = await ask("invoices for 4410 E Baseline Rd");
check("control: address with digits is not split", !badName(c4), c4.slice(0, 200));
const c5 = await ask(`how many invoices in ${lc.ds[0].slice(0, 4)}`);
check("control: shop-wide year count unchanged", hasNum(c5, String(typeYr("invoice", lc.ds[0].slice(0, 4)))), c5.slice(0, 200));
console.error = realErr;
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
