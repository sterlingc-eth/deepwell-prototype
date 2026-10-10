/**
 * R41N E3 - counts of a QUOTED phrase: 'how many times has Desert Air Mechanical done "serviced AC unit"',
 * 'how many work orders for "unclogged kitchen drain" in 2026'. The phrase must equal (ignoring case) a value this tenant's documents
 * actually carry in ONE extracted field; the count is the distinct documents carrying it, narrowed by the same question's document
 * type (a type the tenant has), a vendor / technician value the question names, and one calendar year (service_date). The answer
 * says exactly what it counted. Phrase not stored in one field, unreadable date words, or no such vendor value -> null (falls through).
 * Kill switch: DONOVAN_QUOTED_COUNT=0.   pure: parseQuotedPhraseCount     db: runQuotedPhraseCount
 */
import { attachCitations } from "../citations/records.js";
import { documentRecordsFor } from "../citations/enrich.js";
import { TENANT_SQL, answerEnvelope } from "../scope.js";

const VAL = (a) => `COALESCE(NULLIF(${a}.corrected_value, ''), ${a}.value)`;
const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9&]+/g, " ").trim();
const OTHER_DATE = /\b(?:last|this|past|since|between|before|after|ago|month|quarter|week|ytd|today|yesterday|january|february|march|april|may|june|july|august|september|october|november|december)\b/i;

/** Pure. @returns {kind:"quoted-count", phrase, year, question} or null. */
export function parseQuotedPhraseCount(question) {
  if (process.env.DONOVAN_QUOTED_COUNT === "0") return null;
  const raw = String(question ?? "").replace(/[“”]/g, '"').trim();
  if (!raw || raw.length > 200) return null;
  const quotes = [...raw.matchAll(/"([^"]{3,80})"/g)];
  if (quotes.length !== 1) return null;
  const rest = raw.replace(quotes[0][0], " ");
  if (!/\bhow many\b|\bnumber of\b|\bcount\b|\bhow often\b/i.test(rest)) return null;
  if (OTHER_DATE.test(rest)) return null;
  const years = [...rest.matchAll(/\b((?:19|20)\d\d)\b/g)].map((m) => m[1]);
  if (years.length > 1) return null;
  return { kind: "quoted-count", phrase: quotes[0][1].trim(), year: years[0] ?? null, question: raw, rest };
}

function lev(a, b) {
  const m = a.length; const n = b.length; let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[n];
}
// a misspelt phrase: the ONE stored value (seen on 3+ documents, one field) within 2 edits of it; ties or none -> null
async function closestStored(db, phrase) {
  const p = phrase.toLowerCase().trim(); if (p.length < 10) return null;
  const { rows } = await db.raw(
    `SELECT lower(trim(${VAL("x")})) AS v, x.field_key, count(DISTINCT x.document_id)::int AS n FROM extractions x
      WHERE x.${TENANT_SQL} AND length(trim(${VAL("x")})) BETWEEN $1 AND $2 GROUP BY 1, 2 HAVING count(DISTINCT x.document_id) >= 3`, [p.length - 2, p.length + 2]);
  const near = rows.map((r) => ({ ...r, d: lev(p, r.v) })).filter((r) => r.d <= 2).sort((a, b) => a.d - b.d);
  if (!near.length || (near[1] && near[1].d === near[0].d && near[1].v !== near[0].v)) return null;
  return near[0].v;
}

const FILLER = new Set("calls call get got visits visit s a an the we us our you me my has have had did do does done is was are were been on file in for of all time work works worked job jobs lol please thanks thx pls um ok okay hey yo quick real sorry more alright hang one so".split(" "));
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** @returns an /api/ask data object, or null. */
export async function runQuotedPhraseCount(db, intent0) {
  let intent = intent0; let readAs = null;
  const probe = async (ph) => (await db.raw(`SELECT 1 FROM extractions x WHERE x.${TENANT_SQL} AND lower(trim(${VAL("x")})) = lower($1) LIMIT 1`, [ph])).rows.length;
  if (!(await probe(intent.phrase))) {
    const fixed = await closestStored(db, intent.phrase);
    if (!fixed) return null;
    readAs = fixed; intent = { ...intent, phrase: fixed };
  }
  const { rows: fields } = await db.raw(
    `SELECT x.field_key, count(DISTINCT x.document_id)::int AS n FROM extractions x
      WHERE x.${TENANT_SQL} AND lower(trim(${VAL("x")})) = lower($1) GROUP BY 1`, [intent.phrase]);
  if (fields.length !== 1) return null; // not a stored value, or it sits in several fields: never guess which
  const field = fields[0].field_key;
  const nq = ` ${norm(intent.rest)} `;
  // document type the question names (a type this tenant has)
  const { rows: types } = await db.raw(`SELECT DISTINCT document_type FROM documents WHERE ${TENANT_SQL}`);
  const typeHits = types.map((t) => t.document_type).filter((t) => t && (nq.includes(` ${norm(t)} `) || nq.includes(` ${norm(t)}s `)));
  if (typeHits.length > 1) return null;
  // vendor / technician values the question names
  const { rows: names } = await db.raw(`SELECT DISTINCT x.field_key, ${VAL("x")} AS v FROM extractions x WHERE x.${TENANT_SQL} AND x.field_key IN ('vendor','technician')`);
  const NAME_GENERIC = new Set("plumbing service services company cleaning maintenance landscaping electric mechanical pest control glass supply repair hvac heating cooling comfort property management".split(" "));
  const qtok = new Set(nq.trim().split(" "));
  const nameHits = names.filter((r) => norm(r.v).length >= 4 && (nq.includes(` ${norm(r.v)} `) || norm(r.v).split(" ").some((w) => w.length >= 5 && !NAME_GENERIC.has(w) && qtok.has(w))));
  if (new Set(nameHits.map((r) => r.field_key)).size > 1 || new Set(nameHits.map((r) => norm(r.v))).size > 1) return null;
  // every other condition in the question (a unit, address, customer, negation, place...) must be one this count applies; else step aside
  {
    const used = new Set(["how", "many", "times", "often", "number", "count", "years"]);
    for (const t of types) for (const w of norm(t.document_type).split(" ")) { used.add(w); used.add(`${w}s`); }
    for (const r of nameHits) for (const w of norm(r.v).split(" ")) used.add(w);
    if (intent.year) used.add(intent.year);
    const left = nq.trim().split(" ").filter((w) => w && !used.has(w) && !FILLER.has(w));
    if (left.length) return null;
  }
  const params = [intent.phrase, field]; const joins = []; const where = [];
  if (typeHits.length) { params.push(typeHits[0]); where.push(`d.document_type = $${params.length}`); }
  if (nameHits.length) {
    params.push(nameHits[0].field_key, nameHits[0].v);
    joins.push(`JOIN extractions n ON n.document_id = x.document_id AND n.${TENANT_SQL} AND n.field_key = $${params.length - 1} AND lower(trim(${VAL("n")})) = lower($${params.length})`);
  }
  if (intent.year) {
    params.push(`${intent.year}-%`);
    joins.push(`JOIN extractions s ON s.document_id = x.document_id AND s.${TENANT_SQL} AND s.field_key = 'service_date' AND ${VAL("s")} LIKE $${params.length}`);
  }
  if (intent.year) {
    // a year can only be applied to documents that carry a service date; a type without one must not read as "none that year"
    const p2 = params.slice(0, 2 + (typeHits.length ? 1 : 0) + (nameHits.length ? 2 : 0));
    const base = await db.raw(
      `SELECT count(DISTINCT x.document_id)::int AS n, count(DISTINCT s.document_id)::int AS dated FROM extractions x JOIN documents d ON d.id = x.document_id AND d.${TENANT_SQL} ${joins.filter((j) => !j.includes("'service_date'")).join(" ")}
        LEFT JOIN extractions s ON s.document_id = x.document_id AND s.${TENANT_SQL} AND s.field_key = 'service_date'
        WHERE x.${TENANT_SQL} AND lower(trim(${VAL("x")})) = lower($1) AND x.field_key = $2 ${where.length ? `AND ${where.join(" AND ")}` : ""}`, p2);
    if (base.rows[0].n > 0 && base.rows[0].dated === 0) return null;
  }
  const { rows } = await db.raw(
    `SELECT DISTINCT x.document_id, d.document_type FROM extractions x JOIN documents d ON d.id = x.document_id AND d.${TENANT_SQL} ${joins.join(" ")}
      WHERE x.${TENANT_SQL} AND lower(trim(${VAL("x")})) = lower($1) AND x.field_key = $2 ${where.length ? `AND ${where.join(" AND ")}` : ""}`, params);
  const label = field.replace(/_/g, " ");
  const FIN = /invoice|purchase[-_ ]?order|quote|estimate|proposal|bill|receipt|credit/i;
  const byType = new Map(); for (const r of rows) byType.set(r.document_type, (byType.get(r.document_type) ?? 0) + 1);
  let rowsOut = rows; let alsoNote = "";
  if (!typeHits.length && byType.size > 1) {
    const jobs = [...byType.keys()].filter((t) => !FIN.test(String(t)));
    // "how many times has X done ...": a job is the work record (work order / ticket), not the invoice that bills the same job; the rest is disclosed
    if (jobs.length === 1 && /\b(?:times|done|did|performed|jobs?)\b/i.test(intent.rest)) {
      rowsOut = rows.filter((r) => r.document_type === jobs[0]);
      alsoNote = ` The same work also appears on ${[...byType].filter(([t]) => t !== jobs[0]).map(([t, n]) => `${n} ${String(t).replace(/[-_]/g, " ")}${n === 1 ? "" : "s"}`).join(" and ")}, not counted again.`;
      typeHits.push(jobs[0]);
    } else return null;
  }
  const what = typeHits.length ? `${typeHits[0].replace(/[-_]/g, " ")}s` : "documents";
  const scope = [nameHits.length ? `${nameHits[0].field_key === "vendor" ? "from vendor" : "by"} ${nameHits[0].v}` : null, intent.year ? `dated ${intent.year}` : null].filter(Boolean).join(", ");
  const lead = readAs ? `Reading "${intent0.phrase}" as "${readAs}": ` : "";
  const text = rowsOut.length
    ? `${lead}${plural(rowsOut.length, what.replace(/s$/, ""))} on file ${rowsOut.length === 1 ? "has" : "have"} "${intent.phrase}" as the ${label}${scope ? ` (${scope})` : ""}.${alsoNote}`
    : `${lead}No ${what} on file have "${intent.phrase}" as the ${label}${scope ? ` (${scope})` : ""}.`;
  const ids = rowsOut.map((r) => r.document_id).slice(0, 25);
  const src = ids.map((documentId) => ({ documentId, location: { field } }));
  const records = ids.length ? await documentRecordsFor(db, ids) : [];
  return attachCitations(answerEnvelope({ text, facts: rowsOut.length ? [{ label: "Documents", value: String(rowsOut.length), sources: src }] : [], sources: src, extra: { fastIntent: "quoted_phrase_count" } }),
    { records, total: rowsOut.length, ...(rowsOut.length ? {} : { kind: "searched" }), basis: `Counted the distinct ${what} whose ${label} is exactly "${intent.phrase}"${scope ? `, ${scope}` : ""}.` });
}
