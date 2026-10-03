/**
 * Agreement END DATES are a document field, not a "record date": "which maintenance agreements expire in 2026", "how many
 * maintenance agreements run through 2027" are answered from the agreement_term printed on every agreement (its last date is
 * the end date), never declined as a "future date". Shop-wide only (a named customer / address / possessive falls through).
 *   expire/end in|during|on|for Y -> end year = Y   | by/before Y -> end year <= Y / < Y   | after Y -> end year > Y
 *   run(s) through|thru|until|till|to Y, "through Y" -> still in force at end of Y (end year >= Y)
 * pure: parseAgreementEndQuestion     db: runAgreementEnd
 */
import { attachCitations } from "../citations/records.js";
import { documentRecordsFor } from "../citations/enrich.js";
import { TENANT_SQL, answerEnvelope } from "../scope.js";

const NOUN_RE = /\b(?:(?:maintenance|service|annual|preventive|preventative)\s+(?:agreements?|contracts?|plans?)|agreements?)\b/i;
const YEAR_RE = /\b(20\d{2})\b/g;
const THROUGH_RE = /\b(?:run|runs|running|ran|good|valid|active|in\s+force|in\s+effect|covered|extend\w*)\s+(?:through|thru|until|till|to)\b|\b(?:through|thru|until|till)\s+(?:the\s+(?:end\s+of\s+)?)?(?:20\d{2})/i;
const ENDS_RE = /\b(?:expir\w*|end|ends|ending|ended|lapse\w*|terminat\w*)\b/i;
const VAL = (a) => `COALESCE(NULLIF(${a}.corrected_value, ''), ${a}.value)`;

/** Pure. @returns {op, year, count} or null. */
export function parseAgreementEndQuestion(question) {
  if (process.env.DONOVAN_AGREEMENT_END === "0") return null;
  const raw = String(question ?? "").replace(/[’`]/g, "'").trim();
  if (!raw || raw.length > 200 || !NOUN_RE.test(raw)) return null;
  if (/'s\b/.test(raw) || /\b\d{1,5}\s+[NSEW]?\.?\s*[A-Za-z]+\s+(?:st|street|rd|road|ave|avenue|dr|drive|ln|lane|blvd|way|ct|court)\b/i.test(raw)) return null;
  if (/\b(?:for|of|with|at)\s+(?:[A-Z][a-z]+\s+){1,2}[A-Z][a-z]+\b/.test(raw.replace(/^\W*\w+/, ""))) return null;
  const years = [...raw.matchAll(YEAR_RE)].map((m) => Number(m[1]));
  if (years.length !== 1) return null;
  const year = years[0];
  const q = raw.toLowerCase();
  let op = null;
  if (THROUGH_RE.test(q)) op = "gte";
  else if (ENDS_RE.test(q)) {
    if (/\b(?:before|prior to|earlier than)\b/.test(q)) op = "lt";
    else if (/\bby\b/.test(q)) op = "lte";
    else if (/\b(?:after|later than)\b/.test(q)) op = "gt";
    else op = "eq";
  }
  if (!op) return null;
  return { op, year, count: /\b(?:how many|count|number of|total)\b/.test(q) };
}

const lastDate = (term) => {
  const ds = [...String(term ?? "").matchAll(/(\d{1,2})\/(\d{1,2})\/(\d{4})|(\d{4})-(\d{2})-(\d{2})/g)];
  const m = ds[ds.length - 1];
  if (!m) return null;
  return m[4] ? { y: +m[4], mo: +m[5], d: +m[6] } : { y: +m[3], mo: +m[1], d: +m[2] };
};
const fmt = (d) => `${String(d.mo).padStart(2, "0")}/${String(d.d).padStart(2, "0")}/${d.y}`;
const ONE = { eq: "ends in", gte: "runs through the end of", lte: "ends by the end of", lt: "ends before", gt: "ends after" };
const PHRASE = { eq: "end in", gte: "run through the end of", lte: "end by the end of", lt: "end before", gt: "end after" };

export async function runAgreementEnd(db, intent) {
  const { rows } = await db.raw(
    `SELECT x.document_id, ${VAL("x")} AS term,
            (SELECT string_agg(DISTINCT c.data->>'customer_name', ' and ') FROM document_entity_links l
               JOIN entities c ON c.id = l.entity_id AND c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL}
              WHERE l.document_id = x.document_id AND l.${TENANT_SQL}) AS customer
       FROM extractions x JOIN documents d ON d.id = x.document_id AND d.document_type = 'maintenance-agreement' AND d.${TENANT_SQL}
      WHERE x.${TENANT_SQL} AND x.field_key = 'agreement_term'`,
    []
  );
  const byDoc = new Map();
  for (const r of rows) if (!byDoc.has(r.document_id)) byDoc.set(r.document_id, r);
  const all = [...byDoc.values()].map((r) => ({ ...r, end: lastDate(r.term) }));
  const dated = all.filter((r) => r.end);
  const y = intent.year;
  const hit = dated.filter((r) => ({ eq: r.end.y === y, gte: r.end.y >= y, lte: r.end.y <= y, lt: r.end.y < y, gt: r.end.y > y })[intent.op]);
  const phrase = `${PHRASE[intent.op]} ${y}`;
  const unread = all.length - dated.length;
  const tail = unread ? ` (${unread} agreement${unread === 1 ? " has" : "s have"} no readable end date.)` : "";
  if (!hit.length) {
    return attachCitations(
      { kind: "no-answer", text: `No maintenance agreements on file ${phrase}.${tail}`, facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [] },
      { records: [], total: 0, kind: "searched", basis: `Read the term printed on ${dated.length} maintenance agreements; none ${phrase}.` }
    );
  }
  hit.sort((a, b) => (a.end.y - b.end.y) || (a.end.mo - b.end.mo) || (a.end.d - b.end.d) || String(a.customer).localeCompare(String(b.customer)));
  const ends = [...new Set(hit.map((r) => fmt(r.end)))];
  const endNote = ends.length === 1 ? ` (all end ${ends[0]})` : "";
  const text = `${hit.length} maintenance agreement${hit.length === 1 ? "" : "s"} ${hit.length === 1 ? `${ONE[intent.op]} ${y}` : phrase}${endNote}.${tail}`;
  const facts = [
    { label: "Maintenance agreements", value: String(hit.length), sources: hit.slice(0, 40).map((r) => ({ documentId: r.document_id, location: { field: "agreement_term" } })) },
    ...hit.slice(0, 40).map((r) => ({ label: r.customer ?? "Agreement", value: `ends ${fmt(r.end)}`, sources: [{ documentId: r.document_id, location: { field: "agreement_term" } }] })),
  ];
  return attachCitations(answerEnvelope({ text, facts, extra: { fastIntent: "agreement_end" } }), {
    records: await documentRecordsFor(db, hit.map((r) => r.document_id)), total: hit.length,
    basis: `Read the term printed on ${dated.length} maintenance agreements (the last date is the end date); ${hit.length} ${phrase}.`,
  });
}
