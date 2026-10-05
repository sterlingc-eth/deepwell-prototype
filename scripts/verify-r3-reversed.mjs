/**
 * R3 reversed year range (blind set): 'between 2012 and 2010' / 'from 2012 to 2010' / '2012-2010' answers the real (swapped) range AND says the range was reversed. Expected values computed from the golden export; model blocked.   npx tsx scripts/verify-r3-reversed.mjs   (verify:r3-reversed)
 */
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0, passes = 0;
const check = (name, ok, detail = "") => { if (ok) passes++; else failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`); };
process.env.NEON_CONNECTION_STRING = "postgres://harness:harness@localhost:5432/harness"; delete process.env.ANTHROPIC_API_KEY;
const realLog = console.log; console.warn = () => {}; const realErr = console.error; console.error = () => {};
const exp = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/golden/golden-export.json"), "utf8"));
const ex = new Map(); for (const x of exp.extractions) { if (!ex.has(x.document_id)) ex.set(x.document_id, {}); ex.get(x.document_id)[x.field_key] = x.value; }
const dtype = new Map(exp.documents.map((d) => [d.id, d.document_type]));
const datesOf = (type, field) => [...ex].filter(([id, f]) => dtype.get(id) === type && f[field]).map(([, f]) => f[field]);
const typeCount = (type) => exp.documents.filter((d) => d.document_type === type).length;
const inAny = (arr, wins) => arr.filter((d) => wins.some(([a, b]) => d >= a && d <= b)).length;
const day = (d) => [d, d]; const year = (y) => [`${y}-01-01`, `${y}-12-31`]; const month = (y, m) => [`${y}-${String(m).padStart(2, "0")}-01`, `${y}-${String(m).padStart(2, "0")}-31`];
const us = (d) => { const [y, m, dd] = d.split("-"); return `${+m}/${+dd}/${y}`; };
const dot = (d) => d.replace(/-/g, ".");
const TODAY = "2026-09-25";
const MN = ["january","february","march","april","may","june","july","august","september","october","november","december"];
const CAP = (m) => MN[m - 1][0].toUpperCase() + MN[m - 1].slice(1);
// independent resolver: most recent month not in the future
const resolveY = (m) => (`2026-${String(m).padStart(2, "0")}-01` > TODAY ? 2025 : 2026);
const mwin = (m) => { const y = resolveY(m); return [y, [`${y}-${String(m).padStart(2, "0")}-01`, `${y}-${String(m).padStart(2, "0")}-31`]]; };
const swin = (m) => { const y = resolveY(m); return [y, [`${y}-${String(m).padStart(2, "0")}-01`, TODAY]]; };
const svc = [...ex].filter(([, f]) => f.service_date).map(([, f]) => f.service_date);
const installs = exp.entities.filter((e) => e.entity_type === "equipment" && !e.merged_into && e.data?.installation_date).map((e) => e.data.installation_date);
const tick = datesOf("service-ticket", "service_date"), inv = datesOf("invoice", "invoice_date");
const SETS = { invoices: [inv, "invoices"], tickets: [tick, "tickets"], "service visits": [svc, "service visits"], "units installed": [installs, "units installed"] };
const n = (arr, a, b) => arr.filter((d) => d >= `${a}-01-01` && d <= `${b}-12-31`).length;
const FORMS = [(a, b) => `between ${a} and ${b}`, (a, b) => `from ${a} to ${b}`, (a, b) => `between ${a} and ${b}`, (a, b) => `from ${a} to ${b}`];
const PAIRS = [[2012, 2010], [2011, 2009], [2026, 2024], [2012, 2009], [2025, 2023], [2010, 2009], [2013, 2011]];
const CASES = []; let k = 0;
for (const [set, [arr, noun]] of Object.entries(SETS)) for (let i = 0; i < 8; i++) { const [hi, lo] = PAIRS[(k + i) % PAIRS.length]; const f = FORMS[(k + i) % FORMS.length]; CASES.push([`how many ${noun} ${f(hi, lo)}`, n(arr, lo, hi), arr, lo, hi]); k++; }
const CTRL = [["how many invoices between 2010 and 2012", inv, 2010, 2012], ["how many tickets from 2009 to 2011", tick, 2009, 2011]];
const offline = await import(path.join(ROOT, "scripts/offline-exam.mjs"));
const { installPgHarness, installModelBlock, createPGlite, setActiveDatabase, loadExportIntoNewTenant } = offline;
console.log = () => {}; await installPgHarness(); await installModelBlock();
const lite = await createPGlite(); await setActiveDatabase(lite);
const { ctx } = await loadExportIntoNewTenant(lite, exp, { tenantKey: "offline:r3-reversed", tenantName: "R3 Reversed" });
const handler = (await import(path.join(ROOT, "api/ask.js"))).default;
const { askViaHandler } = await import(path.join(ROOT, "api/_lib/scorecard/askCall.js"));
console.log = realLog;
const auth = { tenantId: ctx.tenantKey, orgId: ctx.tenantName ?? ctx.tenantKey, userId: null };
const ask = async (question) => { console.log = () => {}; try { const r = await askViaHandler({ handler, auth, question, today: TODAY }); return String(r.data?.answer ?? r.data?.text ?? JSON.stringify(r.data ?? r.error)); } finally { console.log = realLog; } };
const hasNum = (t, k) => new RegExp(`(?<![\\d,.$/-])${k}(?![\\d,]|\\.\\d)`).test(t);
const stripYears = (t) => t.replace(/\b(?:19|20)\d\d\b/g, "");
const zeroOk = (t) => /\b(?:0|no|none|zero|nothing)\b|not on file|nothing on file/i.test(t);
const SAYS = /revers|backward|swapp|flipp|other way|out of order|older year first|oldest first|earlier year/i;
for (const [q, want, arr, lo, hi] of CASES) {
  const t = await ask(q); const tot = String(arr.length); const body = stripYears(t);
  const cOk = !/Processing failed/.test(t) && (want === 0 ? zeroOk(t) && !hasNum(body, tot) : hasNum(body, String(want)) && (want === arr.length || !hasNum(body, tot)));
  check(`"${q}" -> ${want} and says reversed`, cOk && SAYS.test(t) && t.includes(String(lo)) && t.includes(String(hi)), t.slice(0, 240));
}
for (const [q, arr, a, b] of CTRL) { const t = await ask(q); const want = n(arr, a, b); check(`ordered control "${q}" -> ${want} (no reversed note)`, (want === 0 ? zeroOk(t) : hasNum(stripYears(t), String(want))) && !SAYS.test(t), t.slice(0, 200)); }
console.error = realErr;
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
