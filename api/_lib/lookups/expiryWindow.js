/**
 * E2 A7: "which leases expire in 60 days" / "how many leases expire in the next 90 days": an expiry WINDOW on a document type's own end-date field,
 * computed from the stored dates against today (never from the model, never from a guess). Closed shape: (which / how many / list / show / any) + <lease> +
 * (expire / expiring / end / ending / run out) + (in / within / in the next / over the next) N days / weeks / months. Anything else -> null (falls through unchanged).
 *   - leases with no end date on file are said plainly ("3 of 7 leases have no end date"); when NONE has one the lane declines instead of answering a confident zero.
 *   - no lease documents at all -> "No leases on file." (honest zero, cited as searched).
 * Kill switch: DONOVAN_EXPIRY_WINDOW=0.   pure: parseExpiryWindow   db: runExpiryWindow
 */
import { attachCitations } from "../citations/records.js";
import { documentRecordsFor } from "../citations/enrich.js";
import { TENANT_SQL, answerEnvelope } from "../scope.js";

const KINDS = [
  { re: /\b(?:lease\s+agreements?|rental\s+agreements?|leases?)\b/, type: "lease-agreement", field: "lease_end_date", noun: ["lease", "leases"] },
];
const WORD_N = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, sixty: 60, ninety: 90 };
const EXPIRE = /\b(?:expir(?:e|es|ed|ing|y|ation)|end|ends|ending|run\s+out|runs\s+out|lapse|lapses|up\s+for\s+renewal|come\s+due)\b/;

export function parseExpiryWindow(question) {
  if (process.env.DONOVAN_EXPIRY_WINDOW === "0") return null;
  const q = String(question ?? "").toLowerCase().replace(/[’`]/g, "'").replace(/[?!.,;]+/g, " ").replace(/\s+/g, " ").trim();
  if (!q || q.length > 140) return null;
  const kind = KINDS.find((k) => k.re.test(q));
  if (!kind || !EXPIRE.test(q)) return null;
  if (/\b(?:already|expired|past|ago|last|since|before|between|per|average|longest|shortest|oldest|newest|most|least)\b/.test(q.replace(/\bexpired\b/, "x")) && /\b(?:already|ago|last|since|before|between)\b/.test(q)) return null;
  const m = q.match(/\b(?:in|within|over|during|for)?\s*(?:the\s+)?(?:next|coming|following)?\s*(\d{1,3}|[a-z]+)\s*(day|days|week|weeks|month|months)\b/);
  if (!m) return null;
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : WORD_N[m[1]];
  if (!n || n < 1 || n > 730) return null;
  if (!/\b(?:next|within|in|coming|over)\b/.test(q.slice(0, m.index + m[0].length))) return null;
  const unit = m[2].replace(/s$/, "");
  const days = unit === "day" ? n : unit === "week" ? n * 7 : n * 30;
  // every other word must be known grammar, so a name / city / qualifier we did not read is never silently dropped
  const rest = q.replace(m[0], " ").replace(kind.re, " ").replace(EXPIRE, " ");
  const known = new Set("which what who how many number of count list show me tell give us the our my a an any all are is there do does we have has that will going to be on file next coming within in over during for and or leases lease soon units unit please can you i want need see out".split(" "));
  if (rest.split(" ").filter(Boolean).some((w) => !known.has(w))) return null;
  const mode = /\bhow many\b|\bnumber of\b|\bcount\b/.test(q) ? "count" : "list";
  return { kind: "expiry", ...kind, re: undefined, n, unit, days, mode };
}

const pad = (x) => String(x).padStart(2, "0");
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
export function isoOf(s) {
  const t = String(s ?? "").trim();
  let m = /(\d{4})-(\d{2})-(\d{2})/.exec(t); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(t); if (m) return `${m[3]}-${pad(+m[1])}-${pad(+m[2])}`;
  m = /([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i.exec(t);
  if (m) { const mo = MONTHS.findIndex((x) => x.startsWith(m[1].toLowerCase().slice(0, 3))) + 1; if (mo) return `${m[3]}-${pad(mo)}-${pad(+m[2])}`; }
  return null;
}
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const fmtDate = (iso) => { const [y, m, d] = iso.split("-").map(Number); return `${MONTHS[m - 1][0].toUpperCase()}${MONTHS[m - 1].slice(1)} ${d}, ${y}`; };
const VAL = "COALESCE(NULLIF(x.corrected_value, ''), x.value)";
const none = (text, basis, kind = "no-answer") => attachCitations({ kind, text, facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [] }, { records: [], total: 0, kind: "searched", basis });

export async function runExpiryWindow(db, it, { today } = {}) {
  const todayIso = String(today ?? new Date().toISOString()).slice(0, 10);
  const [noun1, nounN] = it.noun;
  const { rows: docs } = await db.raw(`SELECT d.id, d.original_filename AS file FROM documents d WHERE d.${TENANT_SQL} AND replace(lower(d.document_type), '_', '-') = $1`, [it.type]);
  if (!docs.length) return none(`No ${nounN} on file.`, `Searched your documents for ${nounN}; none is on file.`);
  const { rows: vals } = await db.raw(`SELECT x.document_id AS id, x.field_key AS k, ${VAL} AS v FROM extractions x WHERE x.${TENANT_SQL} AND x.field_key IN ($1, 'tenant_name', 'unit_number') AND x.document_id = ANY($2::uuid[])`, [it.field, docs.map((d) => d.id)]);
  const by = new Map(docs.map((d) => [d.id, { id: d.id, file: d.file, end: null, tenant: null, unit: null }]));
  for (const r of vals) { const o = by.get(r.id); if (!o) continue; if (r.k === it.field) o.end ??= isoOf(r.v); else if (r.k === "tenant_name") o.tenant ??= r.v; else o.unit ??= r.v; }
  const all = [...by.values()];
  const dated = all.filter((o) => o.end); const undated = all.length - dated.length;
  const to = it.unit === "month" ? (() => { const d = new Date(`${todayIso}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + it.n); return d.toISOString().slice(0, 10); })() : addDays(todayIso, it.days);
  const phrase = `in the next ${it.n} ${it.unit}${it.n === 1 ? "" : "s"} (${fmtDate(todayIso)} through ${fmtDate(to)})`;
  if (!dated.length) {
    return none(`I can't tell which ${nounN} expire ${phrase}: none of your ${all.length} ${all.length === 1 ? noun1 : nounN} has an end date on file.`, `Checked the ${it.field.replace(/_/g, " ")} on ${all.length} ${nounN}; none has one recorded.`);
  }
  const hits = dated.filter((o) => o.end >= todayIso && o.end <= to).sort((a, b) => (a.end < b.end ? -1 : 1));
  const note = undated ? ` Note: ${undated} of your ${all.length} ${nounN} ${undated === 1 ? "has" : "have"} no end date on file, so ${undated === 1 ? "it" : "they"} could not be checked.` : "";
  const basis = `Compared the ${it.field.replace(/_/g, " ")} of ${dated.length} ${nounN} with ${fmtDate(todayIso)} through ${fmtDate(to)}.`;
  if (!hits.length) return none(`No ${nounN} expire ${phrase}.${note}`, `${basis} None fall in it.`);
  const label = (o) => [o.tenant, o.unit ? `unit ${o.unit}` : null].filter(Boolean).join(", ") || o.file || "Lease";
  const text = it.mode === "count"
    ? `${hits.length} ${hits.length === 1 ? noun1 : nounN} ${hits.length === 1 ? "expires" : "expire"} ${phrase}.${note}`
    : `${hits.length} ${hits.length === 1 ? noun1 : nounN} ${hits.length === 1 ? "expires" : "expire"} ${phrase}: ${hits.slice(0, 12).map((o) => `${label(o)} (${fmtDate(o.end)})`).join("; ")}${hits.length > 12 ? `; and ${hits.length - 12} more` : ""}.${note}`;
  const facts = it.mode === "count"
    ? [{ label: `${noun1[0].toUpperCase()}${noun1.slice(1)}s expiring`, value: String(hits.length), sources: hits.slice(0, 20).map((o) => ({ documentId: o.id, location: { field: it.field } })) }]
    : hits.slice(0, 12).map((o) => ({ label: label(o), value: fmtDate(o.end), sources: [{ documentId: o.id, location: { field: it.field } }] }));
  return attachCitations(answerEnvelope({ text, facts, extra: { fastIntent: "expiry_window" } }),
    { records: await documentRecordsFor(db, hits.slice(0, 200).map((o) => o.id)), total: hits.length, claimedCount: hits.length, basis });
}
