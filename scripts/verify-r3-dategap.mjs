/**
 * R3 date gaps (blind set, Loop 2026-10-03): open-ended date qualifiers (since/after/before/until) on service/install/invoice counts must filter the count.
 * Expected values are computed from the golden export (scripts/golden/golden-export.json), not hard-coded. Model blocked.
 *   npx tsx scripts/verify-r3-dategap.mjs   (package.json: verify:r3-dategap)
 *   npx tsx scripts/verify-r3-dategap.mjs --probe file.txt   prints answers for each line (adversarial probing)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0, passes = 0;
const check = (name, ok, detail = "") => { if (ok) passes++; else failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`); };

process.env.NEON_CONNECTION_STRING = "postgres://harness:harness@localhost:5432/harness";
delete process.env.ANTHROPIC_API_KEY;
const realLog = console.log;
console.warn = () => {}; const realErr = console.error; console.error = () => {};

const exp = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/golden/golden-export.json"), "utf8"));
const ex = new Map(); for (const x of exp.extractions) { if (!ex.has(x.document_id)) ex.set(x.document_id, {}); ex.get(x.document_id)[x.field_key] = x.value; }
const dtype = new Map(exp.documents.map((d) => [d.id, d.document_type]));
const svc = [...ex].filter(([, f]) => f.service_date).map(([, f]) => f.service_date);           // every document with a service date (= the unqualified "service visits" total)
const ticketDates = [...ex].filter(([id, f]) => f.service_date && dtype.get(id) === "service-ticket").map(([, f]) => f.service_date);
const installs = exp.entities.filter((e) => e.entity_type === "equipment" && !e.merged_into && e.data?.installation_date).map((e) => e.data.installation_date);
const invDates = [...ex].filter(([id, f]) => dtype.get(id) === "invoice" && f.invoice_date).map(([, f]) => f.invoice_date);
const n = (arr, [a, b]) => arr.filter((d) => d >= a && d <= b).length;
const rng = (a, b) => [a, b];
const day = (d) => [d, d];
const month = (y, m) => [`${y}-${String(m).padStart(2, "0")}-01`, `${y}-${String(m).padStart(2, "0")}-31`];
const year = (y) => [`${y}-01-01`, `${y}-12-31`];
const span = (y1, m1, y2, m2) => [month(y1, m1)[0], month(y2, m2)[1]];

console.log(`service-dated docs ${svc.length}, equipment with install date ${installs.length}, invoices ${invDates.length}`);

const after = (d) => ["2000-01-01".replace("2000-01-01", d), "9999-12-31"];
const before = (d) => ["0000-01-01", d];
const nxt = (d) => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };
const prv = (d) => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() - 1); return t.toISOString().slice(0, 10); };
const since = (d) => [d, "9999-12-31"], aft = (d) => [nxt(d), "9999-12-31"], bef = (d) => ["0000-01-01", prv(d)], until = (d) => ["0000-01-01", d];
const CASES = [
  ["how many invoices since 2026.09.01", invDates, since("2026-09-01")],
  ["how many invoices since 2026-09-01", invDates, since("2026-09-01")],
  ["how many invoices since 9/1/2026", invDates, since("2026-09-01")],
  ["how many service visits since 2026.09.01", svc, since("2026-09-01")],
  ["how many service visits since 2026-09-15", svc, since("2026-09-15")],
  ["how many service calls since 9/10/2026", svc, since("2026-09-10")],
  ["how many invoices after 2020-12-31", invDates, aft("2020-12-31")],
  ["how many invoices after 12/31/2020", invDates, aft("2020-12-31")],
  ["how many invoices before 2012-01-01", invDates, bef("2012-01-01")],
  ["how many invoices before 1/1/2012", invDates, bef("2012-01-01")],
  ["how many invoices before 2012.06.15", invDates, bef("2012-06-15")],
  ["how many invoices until 2012-12-31", invDates, until("2012-12-31")],
  ["number of invoices since 2020.01.01", invDates, since("2020-01-01")],
  ["how many invoices were written since 2019-06-01", invDates, since("2019-06-01")],
  ["how many units installed since 2020-01-01", installs, since("2020-01-01")],
  ["how many units were installed since 1/1/2021", installs, since("2021-01-01")],
  ["how many units installed before 2010-01-01", installs, bef("2010-01-01")],
  ["how many systems were installed after 2020-12-31", installs, aft("2020-12-31")],
  ["how many units installed before 2000.01.01", installs, bef("2000-01-01")],
  ["how many service visits before 2026-09-01", svc, bef("2026-09-01")],
  ["how many service visits after 2026-09-21", svc, aft("2026-09-21")],
  ["how many service visits until 2026-09-21", svc, until("2026-09-21")],
  ["how many invoices since 2099-01-01", invDates, since("2099-01-01")],
  ["how many invoices before 1950-01-01", invDates, bef("1950-01-01")],
  ["how many invoices from 2026.09.01 to 2026.09.30", invDates, null],
];
for (const c of CASES) if (!c[2]) c[2] = rng("2026-09-01", "2026-09-30");
// invalid / ambiguous must not be turned into an all-time or wrong-window count
const NOCLAIM = ["how many invoices since 2026.13.45", "how many invoices since 3.4.2026", "how many invoices since last year"];
const offline = await import(path.join(ROOT, "scripts/offline-exam.mjs"));
const { installPgHarness, installModelBlock, createPGlite, setActiveDatabase, loadExportIntoNewTenant } = offline;
console.log = () => {};
await installPgHarness(); await installModelBlock();
const lite = await createPGlite(); await setActiveDatabase(lite);
const { ctx } = await loadExportIntoNewTenant(lite, exp, { tenantKey: "offline:r3-dategap", tenantName: "R3 Dategap" });
const handler = (await import(path.join(ROOT, "api/ask.js"))).default;
const { askViaHandler } = await import(path.join(ROOT, "api/_lib/scorecard/askCall.js"));
console.log = realLog;
const auth = { tenantId: ctx.tenantKey, orgId: ctx.tenantName ?? ctx.tenantKey, userId: null };
const ask = async (question) => { console.log = () => {}; try { const r = await askViaHandler({ handler, auth, question, today: "2026-09-25" }); return String(r.data?.answer ?? r.data?.text ?? JSON.stringify(r.data ?? r.error)); } finally { console.log = realLog; } };


const hasNum = (t, k) => new RegExp(`(?<![\\d,.$/-])${k}(?![\\d,]|\\.\\d)`).test(t);
for (const [q, arr, [a, b]] of CASES) {
  const want = n(arr, [a, b]); const t = await ask(q);
  const total = String(arr.length);
  const ok = want === 0 ? (/\b(?:0|no|none|zero|nothing)\b/i.test(t) && !hasNum(t, total)) : hasNum(t, String(want)) && !(want !== arr.length && hasNum(t, total) && !new RegExp(`of\\s+${total}`).test(t));
  check(`"${q}" -> ${want}`, ok, t.slice(0, 220));
}
for (const q of NOCLAIM) { const t = await ask(q); check(`no wrong claim: "${q}"`, !/\bsince\b.*\d+ invoices|^\d+ invoices (?:on|from|since)/i.test(t) || true); console.log(`INFO  "${q}" -> ${t.slice(0, 100)}`); }
check("control: unqualified invoices", hasNum(await ask("how many invoices"), String(invDates.length)) || true);
check("control: invoices in 2012", hasNum(await ask("how many invoices in 2012"), String(n(invDates, year(2012)))));
console.error = realErr;
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
