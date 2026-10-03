/**
 * Date qualifiers on count questions that the old path dropped or collapsed (answered as the all-time total, or as the first
 * month of a range): "how many service visits on 2026.09.21 / in 9/2026 / between January 2026 and March 2026",
 * "how many units were installed between January 2020 and December 2021", "how many invoices dated 2012.04.28 / in 4/2012".
 * Closed shapes only. A count question (how many / number of) whose ONLY content is <subject> + <date or date range>:
 *   subject: service visits|calls (every document with a service date)  |  units/systems/equipment installed (install date)  |  invoices (invoice date)
 *   claimed when the window is a range of two dates, or a single date written numerically (2026-09-21, 2026.09.21, 9.21.2026, 9/2026, 2026/09).
 *   Ambiguous day/month ("3.4.2026"), invalid dates, "before/after/since", names, amounts or any other word -> null (falls through, unchanged).
 * Kill switch: DONOVAN_DATE_QUALIFIERS=0.      pure: parseDateQualifier     db: runDateQualifier
 */
import { attachCitations } from "../citations/records.js";
import { documentRecordsFor, customerRecordsFor } from "../citations/enrich.js";
import { TENANT_SQL, answerEnvelope } from "../scope.js";

const MON = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MON_ALT = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const monthNum = (w) => MON.findIndex((m) => m.startsWith(String(w).toLowerCase().slice(0, 3))) + 1;
const pad = (n) => String(n).padStart(2, "0");
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const okDay = (y, m, d) => y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= lastDay(y, m);
const monthName = (m) => MON[m - 1][0].toUpperCase() + MON[m - 1].slice(1);

// One alternation, most specific first; each alternative -> a point {from,to,label,numeric}. null from a handler = abort the whole parse.
const POINT_RES = [
  [/\b(\d{4})[-./](\d{1,2})[-./](\d{1,2})\b/, (m) => day(+m[1], +m[2], +m[3], true)],
  [/\b(\d{1,2})([-./])(\d{1,2})\2(\d{4})\b/, (m) => {
    const a = +m[1], b = +m[3], y = +m[4];
    if (a > 12) return day(y, b, a, true);          // 21.9.2026 = day.month
    if (b > 12) return day(y, a, b, true);          // 9.21.2026 = month.day
    return m[2] === "/" ? day(y, a, b, true) : undefined; // 3/4/2026 = US month/day; 3.4.2026 ambiguous
  }],
  [/\b(\d{4})[-./](\d{1,2})\b(?![-./]\d)/, (m) => month(+m[1], +m[2], true)],
  [/\b(\d{1,2})[-./](\d{4})\b/, (m) => month(+m[2], +m[1], true)],
  [new RegExp(`\\b(${MON_ALT})\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`), (m) => day(+m[3], monthNum(m[1]), +m[2], false)],
  [new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MON_ALT})\\b\\.?,?\\s+(\\d{4})\\b`), (m) => day(+m[3], monthNum(m[2]), +m[1], false)],
  [new RegExp(`\\b(${MON_ALT})\\b\\.?,?\\s+(\\d{4})\\b`), (m) => month(+m[2], monthNum(m[1]), false)],
  [/\b((?:19|20)\d{2})\b/, (m) => ({ from: `${m[1]}-01-01`, to: `${m[1]}-12-31`, label: m[1], numeric: false })],
];
function day(y, m, d, numeric) { return okDay(y, m, d) ? { from: `${y}-${pad(m)}-${pad(d)}`, to: `${y}-${pad(m)}-${pad(d)}`, label: `${monthName(m)} ${d}, ${y}`, numeric } : null; }
function month(y, m, numeric) { return okDay(y, m, 1) ? { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastDay(y, m))}`, label: `${monthName(m)} ${y}`, numeric } : null; }

/** Pull every date point out of the text (left to right); returns {points, rest} or null when a point is invalid/ambiguous. */
function extractPoints(text) {
  const found = [];
  let rest = text;
  for (const [re, fn] of POINT_RES) {
    const g = new RegExp(re.source, "gi");
    let m;
    const spans = [];
    while ((m = g.exec(rest))) {
      const p = fn(m);
      if (!p) return null;
      found.push({ at: m.index + rest.slice(0, 0).length, p, key: m[0] });
      spans.push([m.index, m.index + m[0].length]);
    }
    // blank matched spans so lower-priority patterns (bare year) cannot re-match inside them
    for (const [a, b] of spans.reverse()) rest = rest.slice(0, a) + " ".repeat(b - a) + rest.slice(b);
  }
  // order by position in the ORIGINAL text
  found.forEach((f) => { f.at = text.toLowerCase().indexOf(f.key.toLowerCase()); });
  found.sort((a, b) => a.at - b.at);
  return { points: found.map((f) => f.p), rest };
}

const SERVICE_RE = /\bservice\s+(?:visits?|calls?)\b/;
const INSTALL_RE = /\b(?:(?:units?|systems?|equipment|pieces?\s+of\s+equipment|ac\s+units?|hvac\s+units?|furnaces?|heat\s+pumps?)\b.*\binstall(?:ed|s)?|install(?:ed|s)?\b.*\b(?:units?|systems?|equipment|pieces?\s+of\s+equipment))\b/;
const INVOICE_RE = /\binvoices?\b/;
const FILLER = new Set("how many number of count the our all we do did have has are is were was there on in during between and from to through thru until till dated date of a an got done performed completed total file made issued written for within each service visit visits call calls unit units system systems equipment piece pieces installed install installs invoice invoices ac hvac furnace furnaces heat pump pumps".split(" "));

/** Pure. @returns {kind:'service'|'install'|'invoice', from, to, label, range} or null. */
export function parseDateQualifier(question) {
  if (process.env.DONOVAN_DATE_QUALIFIERS === "0") return null;
  const raw = String(question ?? "").replace(/[’`]/g, "'").trim();
  if (!raw || raw.length > 200 || !/\b(?:how\s+many|number\s+of|count\s+of|count)\b/i.test(raw)) return null;
  const q = raw.toLowerCase().replace(/[?!]+$/, "").replace(/(\d)\.\s*$/, "$1").trim();
  const kind = SERVICE_RE.test(q) ? "service" : INSTALL_RE.test(q) ? "install" : INVOICE_RE.test(q) ? "invoice" : null;
  if (!kind) return null;
  const ex = extractPoints(q);
  if (!ex || ex.points.length < 1 || ex.points.length > 2) return null;
  // every remaining word must be filler (no names, amounts, statuses, before/after/since ...)
  const words = ex.rest.replace(/[^a-z0-9'\s]/g, " ").split(/\s+/).filter(Boolean);
  if (words.some((w) => !FILLER.has(w) && !/^\d+$/.test(w) && false)) return null;
  if (words.some((w) => !FILLER.has(w))) return null;
  const [a, b] = ex.points;
  if (b) {
    if (!/\b(?:between\b.*\band\b|from\b.*\b(?:to|through|thru|until|till)\b|\b(?:to|through|thru)\b)/.test(q)) return null;
    if (b.from < a.from) return null;
    return { kind, from: a.from, to: b.to, label: `${a.label} through ${b.label}`, range: true };
  }
  if (!a.numeric) return null; // single "September 2026" / "2020" stay with the older path
  return { kind, from: a.from, to: a.to, label: a.label, range: false };
}

const VAL = (a) => `COALESCE(NULLIF(${a}.corrected_value, ''), ${a}.value)`;
const iso = (s) => { const m = /(\d{4})-(\d{2})-(\d{2})/.exec(String(s ?? "")) ?? null; if (m) return `${m[1]}-${m[2]}-${m[3]}`; const u = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(s ?? "")); return u ? `${u[3]}-${pad(+u[1])}-${pad(+u[2])}` : null; };
const TYPE_LABEL = { "service-ticket": ["service ticket", "service tickets"], invoice: ["invoice", "invoices"], "work-order": ["work order", "work orders"], "startup-sheet": ["startup sheet", "startup sheets"], "inspection-report": ["inspection report", "inspection reports"] };
const when = (i) => (i.range ? `from ${i.label.replace(" through ", " through ")}` : `on ${i.label}`);
const whenIn = (i) => (i.range ? `from ${i.label}` : /^[A-Z][a-z]+ \d{4}$/.test(i.label) ? `in ${i.label}` : `on ${i.label}`);

export async function runDateQualifier(db, intent) {
  const inRange = (d) => d && d >= intent.from && d <= intent.to;
  if (intent.kind === "service" || intent.kind === "invoice") {
    const field = intent.kind === "service" ? "service_date" : "invoice_date";
    const { rows } = await db.raw(
      `SELECT x.document_id, d.document_type AS dtype, ${VAL("x")} AS v FROM extractions x JOIN documents d ON d.id = x.document_id AND d.${TENANT_SQL}
        WHERE x.${TENANT_SQL} AND x.field_key = $1`, [field]);
    const seen = new Map();
    for (const r of rows) if (!seen.has(r.document_id)) seen.set(r.document_id, { id: r.document_id, type: String(r.dtype ?? "").replace(/_/g, "-").toLowerCase(), date: iso(r.v) });
    let all = [...seen.values()];
    if (intent.kind === "invoice") all = all.filter((r) => r.type === "invoice");
    const dated = all.filter((r) => r.date);
    const hits = dated.filter((r) => inRange(r.date));
    const noun = intent.kind === "service" ? ["service visit", "service visits"] : ["invoice", "invoices"];
    const w = whenIn(intent);
    if (!hits.length) {
      return attachCitations({ kind: "no-answer", text: `No ${noun[1]} on file ${w}.`, facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [] },
        { records: [], total: 0, kind: "searched", basis: `Compared the ${field.replace("_", " ")} on ${dated.length} documents to ${intent.from} through ${intent.to}; none fall in it.` });
    }
    let split = "";
    if (intent.kind === "service") {
      const by = new Map(); for (const r of hits) by.set(r.type, (by.get(r.type) ?? 0) + 1);
      const parts = [...by].sort((a, b) => b[1] - a[1]).map(([t, c]) => `${c} ${(TYPE_LABEL[t] ?? [t.replace(/-/g, " "), `${t.replace(/-/g, " ")}s`])[c === 1 ? 0 : 1]}`);
      split = ` - counted from every document with a service date: ${parts.join(", ")}.`;
    } else split = ".";
    const text = `${hits.length} ${noun[hits.length === 1 ? 0 : 1]} ${w}${split}`;
    return attachCitations(answerEnvelope({ text, facts: [{ label: `${noun[1][0].toUpperCase()}${noun[1].slice(1)} ${w}`, value: String(hits.length), sources: hits.slice(0, 20).map((r) => ({ documentId: r.id, location: { field } })) }], extra: { fastIntent: "date_qualifier" } }),
      { records: await documentRecordsFor(db, hits.slice(0, 200).map((r) => r.id)), total: hits.length, claimedCount: hits.length, basis: `Compared the ${field.replace("_", " ")} on ${dated.length} documents to ${intent.from} through ${intent.to}.` });
  }
  // installs: equipment records by installation date
  const { rows } = await db.raw(`SELECT id, data->>'installation_date' AS d FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT_SQL}`, []);
  const dated = rows.map((r) => ({ id: r.id, date: iso(r.d) })).filter((r) => r.date);
  const noDate = rows.length - dated.length;
  const hits = dated.filter((r) => inRange(r.date));
  const w = whenIn(intent).replace(/^on /, "on ");
  const tail = noDate ? ` ${noDate} of ${rows.length} units have no install date on file.` : "";
  if (!hits.length) {
    return attachCitations({ kind: "no-answer", text: `No units on file were installed ${w}.${tail}`, facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [] },
      { records: [], total: 0, kind: "searched", basis: `Compared the install date on ${dated.length} units to ${intent.from} through ${intent.to}; none fall in it.` });
  }
  const text = `${hits.length} ${hits.length === 1 ? "piece of equipment was" : "pieces of equipment were"} installed ${w}.${tail}`;
  return attachCitations(answerEnvelope({ text, facts: [{ label: `Units installed ${w}`, value: String(hits.length), entityIds: hits.slice(0, 40).map((r) => r.id), sources: [] }], extra: { fastIntent: "date_qualifier" } }),
    { records: await customerRecordsFor(db, hits.slice(0, 200).map((r) => r.id)), total: hits.length, claimedCount: hits.length, basis: `Compared the install date on ${dated.length} units to ${intent.from} through ${intent.to}.` });
}
