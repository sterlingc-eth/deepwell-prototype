/**
 * R3 month-name-without-year (blind set): a bare month resolves to the most recent such month not in the future (today 2026-09-25), 'since <month>' = 1st of it to today, and the answer states month+year. Expected values are computed from
 * the golden export (scripts/golden/golden-export.json). Model blocked.   npx tsx scripts/verify-r3-monthnoyear.mjs   (verify:r3-monthnoyear)
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
const SETS = { invoices: [inv, "invoice"], tickets: [tick, "ticket"], "service visits": [svc, "visit"], "units installed": [installs, "install"] };
const spell = { 1: ["jan", "january"], 2: ["feb", "february"], 3: ["march", "mar"], 4: ["april", "apr"], 5: ["may"], 6: ["june", "jun"], 7: ["july", "jul"], 8: ["august", "aug"], 9: ["sept", "september", "sep"], 10: ["oct", "october"], 11: ["nov", "november"], 12: ["dec", "december"] };
const CASES = []; // [question, expectedCount, arr, mustSay]
const add = (q, arr, w, y, m, kind) => CASES.push([q, n(arr, w), arr, kind === "since" ? new RegExp(`${CAP(m)}\\s+(?:1,\\s+)?${y}`) : new RegExp(`${CAP(m)}\\s+${y}`, "i"), y, m]);
function n(arr, [a, b]) { return arr.filter((d) => d >= a && d <= b).length; }
const plan = [
  ["how many invoices in sept", "invoices", 9, "in"], ["how many tickets in sept", "tickets", 9, "in"], ["how many installs in september", "units installed", 9, "in"],
  ["how many invoices since january", "invoices", 1, "since"], ["how many invoices since jan", "invoices", 1, "since"], ["how many service visits since march", "service visits", 3, "since"],
  ["how many service visits in september", "service visits", 9, "in"], ["how many service visits in august", "service visits", 8, "in"], ["how many invoices in august", "invoices", 8, "in"],
  ["how many invoices in december", "invoices", 12, "in"], ["how many invoices in october", "invoices", 10, "in"], ["how many invoices in dec", "invoices", 12, "in"],
  ["how many tickets in oct", "tickets", 10, "in"], ["how many tickets in november", "tickets", 11, "in"], ["how many tickets since november", "tickets", 11, "since"],
  ["how many invoices in june", "invoices", 6, "in"], ["how many invoices in march", "invoices", 3, "in"], ["how many invoices in july", "invoices", 7, "in"],
  ["how many tickets in july", "tickets", 7, "in"], ["how many tickets in may", "tickets", 5, "in"], ["how many service visits in february", "service visits", 2, "in"],
  ["how many invoices since october", "invoices", 10, "since"], ["how many invoices since sept", "invoices", 9, "since"], ["how many service visits since august", "service visits", 8, "since"],
  ["how many units installed in january", "units installed", 1, "in"], ["how many units installed since june", "units installed", 6, "since"], ["how many units installed in december", "units installed", 12, "in"],
  ["how many invoices in april", "invoices", 4, "in"], ["how many tickets in sept.", "tickets", 9, "in"], ["how many service calls in september", "service visits", 9, "in"],
  ["how many invoices were written in jan", "invoices", 1, "in"], ["how many tickets since feb", "tickets", 2, "since"],
];
for (const [q, set, m, kind] of plan) { const [arr] = SETS[set]; const [y, w] = kind === "since" ? swin(m) : mwin(m); add(q, arr, w, y, m, kind); }
const CTRL = [ // an explicit year must still win
  ["how many invoices in september 2026", inv, month(2026, 9)], ["how many invoices in september 2025", inv, month(2025, 9)], ["how many tickets in sept 2025", tick, month(2025, 9)], ["how many invoices since january 2026", inv, [`2026-01-01`, TODAY]],
];
const offline = await import(path.join(ROOT, "scripts/offline-exam.mjs"));
const { installPgHarness, installModelBlock, createPGlite, setActiveDatabase, loadExportIntoNewTenant } = offline;
console.log = () => {}; await installPgHarness(); await installModelBlock();
const lite = await createPGlite(); await setActiveDatabase(lite);
const { ctx } = await loadExportIntoNewTenant(lite, exp, { tenantKey: "offline:r3-monthnoyear", tenantName: "R3 Monthnoyear" });
const handler = (await import(path.join(ROOT, "api/ask.js"))).default;
const { askViaHandler } = await import(path.join(ROOT, "api/_lib/scorecard/askCall.js"));
console.log = realLog;
const auth = { tenantId: ctx.tenantKey, orgId: ctx.tenantName ?? ctx.tenantKey, userId: null };
const ask = async (question) => { console.log = () => {}; try { const r = await askViaHandler({ handler, auth, question, today: TODAY }); return String(r.data?.answer ?? r.data?.text ?? JSON.stringify(r.data ?? r.error)); } finally { console.log = realLog; } };
const hasNum = (t, k) => new RegExp(`(?<![\\d,.$/-])${k}(?![\\d,]|\\.\\d)`).test(t);
const stripYears = (t) => t.replace(/\b(?:19|20)\d\d\b/g, "");
const zeroOk = (t) => /\b(?:0|no|none|zero|nothing)\b|not on file|nothing on file/i.test(t);
for (const [q, want, arr, say] of CASES) {
  const t = await ask(q); const tot = String(arr.length); const body = stripYears(t);
  const cOk = want === 0 ? zeroOk(t) && !hasNum(body, tot) : hasNum(body, String(want)) && (want === arr.length || !hasNum(body, tot));
  check(`"${q}" -> ${want} and states month+year`, cOk && say.test(t), t.slice(0, 240));
}
for (const [q, arr, w] of CTRL) { const t = await ask(q); const want = n(arr, w); check(`explicit-year control "${q}" -> ${want}`, want === 0 ? zeroOk(t) : hasNum(stripYears(t), String(want)), t.slice(0, 200)); }
for (const [q, w] of [["how many invoices", inv.length], ["how many tickets", exp.documents.filter((d) => d.document_type === "service-ticket").length]]) { const t = await ask(q); check(`guard "${q}"`, hasNum(t, String(w)), t.slice(0, 160)); }
console.error = realErr;
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
