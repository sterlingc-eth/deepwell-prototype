/**
 * R3 count phrasing + typos (blind set): 'number of / count of / total number of <noun> <window>' and typo'd 'how many' / noun spellings must answer like the plain 'how many' form. Expected values computed from the golden export; model blocked.   npx tsx scripts/verify-r3-countphrase.mjs   (verify:r3-countphrase)
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
const WINS = { "in 2009": year(2009), "in 2010": year(2010), "in 2011": year(2011), "in 2012": year(2012), "in 2013": year(2013), "in 2026": year(2026), "in 2025": year(2025), "in april 2026": month(2026, 4), "in march 2026": month(2026, 3), "in august 2025": month(2025, 8), "in sept": mwin(9)[1], "in august": mwin(8)[1] };
const n = (arr, [a, b]) => arr.filter((d) => d >= a && d <= b).length;
const CASES = []; const add = (q, set, win) => { const [arr] = SETS[set]; CASES.push([q, n(arr, WINS[win]), arr]); };
const LEADS = ["number of", "count of", "total number of", "what's the number of", "the count of", "num of", "what is the total number of", "give me the number of"];
const sets = Object.keys(SETS), wins = Object.keys(WINS);
let k = 0; for (const lead of LEADS) for (let j = 0; j < 4; j++) { const set = sets[(k + j) % 4]; const win = wins[(k * 3 + j * 5) % wins.length]; add(`${lead} ${SETS[set][1]} ${win}`, set, win); k++; }
const HOWS = ["how mny", "how mant", "hw many", "how maney", "how manny", "howmany", "how mnay", "hou many"];
const NOUNT = { invoices: ["invoces", "invoicse", "invioces", "nvoices", "invoics", "invoises"], tickets: ["tikets", "ticets", "ticktes", "tickts", "ticekts", "tickests"] };
k = 0; for (const h of HOWS) for (let j = 0; j < 2; j++) { const set = j ? "tickets" : "invoices"; const nn = NOUNT[set][(k + j) % 6]; const win = wins[(k * 5 + j * 7 + 1) % wins.length]; add(`${h} ${nn} ${win}`, set, win); k++; }
const NUMT = ["numbr of", "nmber of", "numer of", "numbe of", "nuber of", "countt of"]; k = 0;
for (const h of NUMT) for (let j = 0; j < 2; j++) { const set = sets[(k + j * 2) % 4]; const win = wins[(k * 4 + j * 3 + 2) % wins.length]; add(`${h} ${SETS[set][1]} ${win}`, set, win); k++; }
const CTRL = [["how many invoices in 2012", inv, year(2012)], ["how many tickets in 2011", tick, year(2011)], ["how many service visits in 2010", svc, year(2010)]];
const offline = await import(path.join(ROOT, "scripts/offline-exam.mjs"));
const { installPgHarness, installModelBlock, createPGlite, setActiveDatabase, loadExportIntoNewTenant } = offline;
console.log = () => {}; await installPgHarness(); await installModelBlock();
const lite = await createPGlite(); await setActiveDatabase(lite);
const { ctx } = await loadExportIntoNewTenant(lite, exp, { tenantKey: "offline:r3-countphrase", tenantName: "R3 Countphrase" });
const handler = (await import(path.join(ROOT, "api/ask.js"))).default;
const { askViaHandler } = await import(path.join(ROOT, "api/_lib/scorecard/askCall.js"));
console.log = realLog;
const auth = { tenantId: ctx.tenantKey, orgId: ctx.tenantName ?? ctx.tenantKey, userId: null };
const ask = async (question) => { console.log = () => {}; try { const r = await askViaHandler({ handler, auth, question, today: TODAY }); return String(r.data?.answer ?? r.data?.text ?? JSON.stringify(r.data ?? r.error)); } finally { console.log = realLog; } };
const hasNum = (t, k) => new RegExp(`(?<![\\d,.$/-])${k}(?![\\d,]|\\.\\d)`).test(t);
const stripYears = (t) => t.replace(/\b(?:19|20)\d\d\b/g, "");
const zeroOk = (t) => /\b(?:0|no|none|zero|nothing)\b|not on file|nothing on file/i.test(t);
for (const [q, want, arr] of CASES) {
  const t = await ask(q); const tot = String(arr.length); const body = stripYears(t);
  const ok = !/Processing failed/.test(t) && (want === 0 ? zeroOk(t) && !hasNum(body, tot) : hasNum(body, String(want)) && (want === arr.length || !hasNum(body, tot)));
  check(`"${q}" -> ${want}`, ok, t.slice(0, 220));
}
for (const [q, arr, w] of CTRL) { const t = await ask(q); const want = n(arr, w); check(`control "${q}" -> ${want}`, want === 0 ? zeroOk(t) : hasNum(stripYears(t), String(want)), t.slice(0, 200)); }
console.error = realErr;
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
