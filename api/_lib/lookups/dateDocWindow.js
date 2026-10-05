/**
 * Date windows on document-type counts that the older paths dropped or half-read (Loop 2026-10-03b):
 *   "how many tickets on 2026-09-21 and 2026-09-22" (second date dropped), "how many work orders in 2026-09" ("31 documents"),
 *   "quotes since 2018.11.29" (all 60), "how many permits in 2026" (0 - permits carry no date), "service calls on 3.4.2026" (317).
 * Closed shape: a count question (how many / number of / count) = <one document type> + <date points / range / open window>, nothing else.
 *   types: service tickets, work orders, startup sheets, inspection reports, quotes/proposals, purchase orders, warranty registrations (dated types);
 *          permits, dispatch notes, maintenance agreements (no date on file -> total + a plain note); invoices / service visits / units installed (date LISTS only).
 *   shapes: "on A and B" (union of days/months/years, per-date split shown), "between A and B", single point, since/after/before/until + one numeric date.
 *   An ambiguous numeric date (3.4.2026) is asked back, never guessed.
 * Kill switch: DONOVAN_DATE_DOCS=0 (DONOVAN_DATE_QUALIFIERS=0 kills too).   pure: parseDocWindow   db: runDocWindow
 */
import { attachCitations } from "../citations/records.js";
import { documentRecordsFor, customerRecordsFor } from "../citations/enrich.js";
import { TENANT_SQL, answerEnvelope } from "../scope.js";
import { extractPoints } from "./dateQualifiers.js";

const KINDS = [
  ["service", /\bservice\s+(?:visits?|calls?)\b/, "service_date", null, ["service visit", "service visits"], false],
  ["install", /\b(?:(?:units?|systems?|equipment|pieces?\s+of\s+equipment|ac\s+units?|hvac\s+units?|furnaces?|heat\s+pumps?)\b.*\binstall(?:ed|s)?|install(?:ed|s)?\b.*\b(?:units?|systems?|equipment))\b/, "installation_date", null, ["unit installed", "units installed"], false],
  ["invoice", /\binvoices?\b/, "invoice_date", "invoice", ["invoice", "invoices"], false],
  ["ticket", /\b(?:service\s+)?tickets?\b/, "service_date", "service-ticket", ["service ticket", "service tickets"], true],
  ["workorder", /\bwork\s*orders?\b/, "service_date", "work-order", ["work order", "work orders"], true],
  ["startup", /\bstart-?\s?up\s+(?:sheets?|reports?)\b/, "service_date", "startup-sheet", ["startup sheet", "startup sheets"], true],
  ["inspection", /\binspections?(?:\s+reports?)?\b/, "service_date", "inspection-report", ["inspection report", "inspection reports"], true],
  ["quote", /\b(?:quotes?|proposals?|estimates?)\b/, "invoice_date", "proposal-quote", ["quote", "quotes"], true],
  ["po", /\b(?:purchase\s+orders?|pos)\b/, "invoice_date", "purchase-order", ["purchase order", "purchase orders"], true],
  ["warranty", /\bwarrant(?:y|ies)\s+(?:were\s+|was\s+)?(?:registrations?|registered)\b|\bregistered\s+warrant(?:y|ies)\b/, "warranty_registered_date", "warranty-registration", ["warranty registration", "warranty registrations"], true],
  ["permit", /\bpermits?\b/, null, "permit", ["permit", "permits"], true],
  ["dispatch", /\bdispatch(?:\s+notes?)?\b/, null, "dispatch-note", ["dispatch note", "dispatch notes"], true],
  ["agreement", /\b(?:maintenance\s+)?(?:agreements?|contracts?)\b/, null, "maintenance-agreement", ["maintenance agreement", "maintenance agreements"], true],
];
const FILLER = new Set("how many number of count the our all we do did have has are is were was there on in during between and from to through thru until till since after before dated date a an got done performed completed total file made issued written for within each service visit visits call calls unit units system systems equipment piece pieces installed install installs invoice invoices ac hvac furnace furnaces heat pump pumps ticket tickets work order orders startup start up sheet sheets inspection inspections report reports quote quotes proposal proposals estimate estimates purchase po pos warranty warranties registration registrations registered permit permits dispatch note notes maintenance agreement agreements contract contracts pull pulled send sent".split(" "));
const pad = (n) => String(n).padStart(2, "0");
const norm = (t) => String(t ?? "").replace(/_/g, "-").toLowerCase();

/** Pure. @returns {kind, mode:'list'|'range'|'single'|'open'|'ambiguous', windows:[{from,to,label}], ...} or null. */
export function parseDocWindow(question) {
  if (process.env.DONOVAN_DATE_DOCS === "0" || process.env.DONOVAN_DATE_QUALIFIERS === "0") return null;
  const raw = String(question ?? "").replace(/[’`]/g, "'").trim();
  if (!raw || raw.length > 200 || !/\b(?:how\s+many|number\s+of|count\s+of|count)\b/i.test(raw)) return null;
  const q = raw.toLowerCase().replace(/[?!]+$/, "").replace(/(\d)\.\s*$/, "$1").trim();
  const hit = KINDS.filter((k) => k[1].test(q));
  if (hit.length !== 1) return null;
  const [kind, , field, dtype, noun, newKind] = hit[0];
  const words = (s) => s.replace(/[^a-z0-9'\s]/g, " ").split(/\s+/).filter(Boolean);
  // ambiguous day/month ("3.4.2026"): ask, never guess
  const amb = /\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/.exec(q);
  if (amb && +amb[1] <= 12 && +amb[2] <= 12 && +amb[1] !== +amb[2]) {
    if (!words(q.replace(amb[0], " ")).every((w) => FILLER.has(w) || /^\d+$/.test(w) && false)) return null;
    return { kind, mode: "ambiguous", token: amb[0], a: +amb[1], b: +amb[2], y: +amb[3], noun };
  }
  const ex = extractPoints(q);
  if (!ex || ex.points.length < 1 || ex.points.length > 4) return null;
  if (!words(ex.rest).every((w) => FILLER.has(w))) return null;
  const pts = ex.points;
  const rangeWords = /\b(?:between\b.*\band\b|from\b.*\b(?:to|through|thru|until|till)\b|\b(?:to|through|thru)\b)/.test(q);
  const open = /\b(since|after|before|until|till)\b/.exec(q);
  const win = (p) => ({ from: p.from, to: p.to, label: p.label });
  const base = { kind, field, dtype, noun, newKind };
  if (open && !rangeWords) {
    if (!newKind || pts.length !== 1 || !pts[0].numeric || process.env.DONOVAN_DATE_OPEN === "0" || (q.match(/\b(?:since|after|before|until|till)\b/g) ?? []).length !== 1) return null;
    const esc = ex.keys[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`\\b${open[1]}\\s+(?:on\\s+)?${esc}`).test(q)) return null;
    const step = (d, n) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
    const w = open[1] === "till" ? "until" : open[1];
    const a = pts[0];
    const [f, t] = w === "since" ? [a.from, "9999-12-31"] : w === "after" ? [step(a.to, 1), "9999-12-31"] : w === "before" ? ["0001-01-01", step(a.from, -1)] : ["0001-01-01", a.to];
    return { ...base, mode: "open", windows: [{ from: f, to: t, label: `${w} ${a.label}` }] };
  }
  if (open) return null;
  if (rangeWords) {
    if (!newKind || pts.length !== 2 || pts[1].from < pts[0].from || !/\b(?:between\b.*\band\b|from\b.*\b(?:to|through|thru|until|till)\b)/.test(q)) return null;
    return { ...base, mode: "range", windows: [{ from: pts[0].from, to: pts[1].to, label: `${pts[0].label} through ${pts[1].label}` }] };
  }
  if (pts.length === 1) return newKind ? { ...base, mode: "single", windows: [win(pts[0])] } : null;
  // "on A and B" / "in 2010 and 2012": a LIST of dates - the union, with each date's own count
  if (!/\band\b|,/.test(q)) return null;
  if (new Set(pts.map((p) => p.from + p.to)).size !== pts.length) return null;
  return { ...base, mode: "list", windows: pts.map(win) };
}

const VAL = (a) => `COALESCE(NULLIF(${a}.corrected_value, ''), ${a}.value)`;
const isoOf = (s) => { const m = /(\d{4})-(\d{2})-(\d{2})/.exec(String(s ?? "")); if (m) return `${m[1]}-${m[2]}-${m[3]}`; const u = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(s ?? "")); return u ? `${u[3]}-${pad(+u[1])}-${pad(+u[2])}` : null; };
const MONTH = (n) => ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][n - 1];
const when = (w, mode) => (mode === "open" ? w.label : mode === "range" ? `from ${w.label}` : w.from === w.to ? `on ${w.label}` : `in ${w.label}`);
const joinAnd = (xs) => (xs.length < 3 ? xs.join(" and ") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const none = (text, basis) => attachCitations({ kind: "no-answer", text, facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [] }, { records: [], total: 0, kind: "searched", basis });

export async function runDocWindow(db, it) {
  const plural = (n) => it.noun[n === 1 ? 0 : 1];
  if (it.mode === "ambiguous") {
    const m1 = `${MONTH(it.a)} ${it.b}, ${it.y}`, m2 = `${MONTH(it.b)} ${it.a}, ${it.y}`;
    const iso1 = `${it.y}-${pad(it.a)}-${pad(it.b)}`, iso2 = `${it.y}-${pad(it.b)}-${pad(it.a)}`;
    return none(`"${it.token}" could be ${m1} or ${m2}, so I haven't guessed. Ask again with the date written as ${iso1} or ${iso2} and I'll count ${it.noun[1]}.`, "The date in the question can be read two ways - nothing was searched.");
  }
  const inAny = (d, ws) => d && ws.some((w) => d >= w.from && d <= w.to);
  const ws = it.windows;
  const where = it.mode === "list" ? `on ${joinAnd(ws.map((w) => w.label))}`.replace(/^on /, ws.every((w) => w.from !== w.to) ? "in " : "on ") : when(ws[0], it.mode);
  if (!it.field) { // undated document types
    const { rows } = await db.raw(`SELECT d.document_type AS t, count(*)::int AS n FROM documents d WHERE d.${TENANT_SQL} GROUP BY 1`, []);
    const total = rows.filter((r) => norm(r.t) === it.dtype).reduce((s, r) => s + r.n, 0);
    if (!total) return none(`No ${it.noun[1]} on file.`, `No ${it.noun[1]} documents found.`);
    return attachCitations(answerEnvelope({ text: `You have ${total} ${plural(total)} on file, but ${it.noun[1]} aren't dated in your records, so I can't count them ${where}.`, facts: [{ label: `${it.noun[1][0].toUpperCase()}${it.noun[1].slice(1)} on file`, value: String(total), sources: [] }], extra: { fastIntent: "date_doc_window" } }),
      { records: [], total, claimedCount: total, basis: `Counted ${it.noun[1]} documents; none carries a date field, so no date window was applied.` });
  }
  let hits, dated, coverage = "";
  if (it.kind === "install") {
    const { rows } = await db.raw(`SELECT id, data->>'installation_date' AS d FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT_SQL}`, []);
    dated = rows.map((r) => ({ id: r.id, date: isoOf(r.d) })).filter((r) => r.date);
    if (rows.length > dated.length) coverage = ` ${rows.length - dated.length} of ${rows.length} units have no install date on file.`;
  } else {
    const { rows } = await db.raw(
      `SELECT x.document_id, d.document_type AS dtype, ${VAL("x")} AS v FROM extractions x JOIN documents d ON d.id = x.document_id AND d.${TENANT_SQL}
        WHERE x.${TENANT_SQL} AND x.field_key = $1`, [it.field]);
    const seen = new Map();
    for (const r of rows) if (!seen.has(r.document_id)) seen.set(r.document_id, { id: r.document_id, type: norm(r.dtype), date: isoOf(r.v) });
    dated = [...seen.values()].filter((r) => r.date && (!it.dtype || r.type === it.dtype));
  }
  hits = dated.filter((r) => inAny(r.date, ws));
  const basis = `Compared the ${it.field.replace(/_/g, " ")} on ${dated.length} ${it.kind === "install" ? "units" : "dated documents"} to ${ws.map((w) => `${w.from} through ${w.to}`).join(" and ")}.`;
  if (!hits.length) return none(`No ${it.noun[1]} on file ${where}.${coverage}`, `${basis} None fall in it.`);
  const per = it.mode === "list" ? ` (${ws.map((w) => `${dated.filter((r) => r.date >= w.from && r.date <= w.to).length} ${when(w, "single")}`).join(", ")})` : "";
  const text = `${hits.length} ${plural(hits.length)} ${where}${per}.${coverage}`;
  const label = `${it.noun[1][0].toUpperCase()}${it.noun[1].slice(1)} ${where}`;
  const facts = [it.kind === "install"
    ? { label, value: String(hits.length), entityIds: hits.slice(0, 40).map((r) => r.id), sources: [] }
    : { label, value: String(hits.length), sources: hits.slice(0, 20).map((r) => ({ documentId: r.id, location: { field: it.field } })) }];
  return attachCitations(answerEnvelope({ text, facts, extra: { fastIntent: "date_doc_window" } }),
    { records: it.kind === "install" ? await customerRecordsFor(db, hits.slice(0, 200).map((r) => r.id)) : await documentRecordsFor(db, hits.slice(0, 200).map((r) => r.id)), total: hits.length, claimedCount: hits.length, basis });
}
