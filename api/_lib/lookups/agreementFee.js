/**
 * R43: "what does <customer> pay for the maintenance agreement", "how much is Laura Mercer's service plan", "<name> agreement cost":
 * the AGREEMENT's own fee (document_financials rows of kind 'agreement' for that customer), never the customer's total invoiced.
 * The customer must be a whole customer of THIS organization (exact name, merged-away excluded); anything else returns null and the older lanes decide.
 * Kill switch: DONOVAN_AGREEMENT_FEE=0.   pure: parseAgreementFee     db: runAgreementFee
 */
import { attachCitations } from "../citations/records.js";
import { documentRecordsFor } from "../citations/enrich.js";
import { TENANT_SQL, answerEnvelope } from "../scope.js";

const NOUN_RE = /\b(?:(?:maintenance|service|annual|preventive|preventative)\s+(?:agreements?|contracts?|plans?)|agreements?)\b/i;
const FEE_RE = /\b(?:pay|pays|paying|cost|costs|fee|fees|charge|charged|price|rate|how much|premium|per year|a year|annually|monthly)\b/i;
const NAME_RE = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z'’-]+){1,2})\b/g;
const MISC = /\b(?:expire|expires|expiring|end|ends|renew\w*|start\w*|term|when|who|which|how many|average|total|all|every|most|least|cheapest|highest|lowest|list|over|under|above|below|between)\b/i;
const SKIP_CAPS = new Set(["Maintenance Agreement", "Service Plan", "Service Agreement"]);

export function parseAgreementFee(question) {
  if (process.env.DONOVAN_AGREEMENT_FEE === "0") return null;
  const raw = String(question ?? "").replace(/[’`]/g, "'").trim();
  if (!raw || raw.length > 200 || !NOUN_RE.test(raw) || !FEE_RE.test(raw) || MISC.test(raw)) return null;
  if (/\b\d{1,5}\s+[NSEW]?\.?\s*[A-Za-z]+\s+(?:st|street|rd|road|ave|avenue|dr|drive|ln|lane|blvd|way|ct|court)\b/i.test(raw) || /\b(?:19|20)\d{2}\b|\$\s*\d/.test(raw)) return null;
  // the name is the Capitalised words that are not the first word of the sentence; exactly one candidate
  const body = raw.replace(/^[^A-Za-z]*[A-Za-z]+\b/, " ");
  const cands = [...body.matchAll(NAME_RE)].map((m) => m[1].replace(/'s$/, "")).filter((n) => !SKIP_CAPS.has(n));
  const uniq = [...new Set(cands)];
  if (uniq.length !== 1) return null;
  return { name: uniq[0], question: raw };
}

const money = (n) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export async function runAgreementFee(db, intent) {
  const c = await db.raw(
    `SELECT id, data->>'customer_name' AS name FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL} AND lower(data->>'customer_name') = lower($1)`,
    [intent.name]
  );
  if (c.rows.length !== 1) return null; // not exactly one whole customer of this organization: older lanes (unknown-name guard) decide
  const name = c.rows[0].name;
  const { rows } = await db.raw(
    `SELECT f.document_id, f.total, f.currency FROM document_financials f
      WHERE f.${TENANT_SQL} AND f.doc_kind = 'agreement' AND f.customer_name ILIKE $1 AND f.total IS NOT NULL`,
    [name]
  );
  if (!rows.length) {
    return attachCitations(
      { kind: "no-answer", text: `No maintenance agreement with a stated fee is on file for ${name}.`, facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [] },
      { records: [], total: 0, kind: "searched", basis: `Looked for agreement documents with a stated total for ${name}; none.` }
    );
  }
  const ids = [...new Set(rows.map((r) => r.document_id))];
  const sum = rows.reduce((a, r) => a + Number(r.total), 0);
  const text = rows.length === 1
    ? `${name}'s maintenance agreement is ${money(sum)}.`
    : `${name} has ${rows.length} agreements on file totalling ${money(sum)} (${rows.map((r) => money(r.total)).join(", ")}).`;
  const facts = [{ label: rows.length === 1 ? "Agreement fee" : "Agreement fees", value: money(sum), sources: ids.map((id) => ({ documentId: id, location: { field: "total" } })) }];
  return attachCitations(answerEnvelope({ text, facts, extra: { fastIntent: "agreement_fee" } }), {
    records: await documentRecordsFor(db, ids), total: ids.length,
    basis: `Read the total printed on ${ids.length} agreement document${ids.length === 1 ? "" : "s"} for ${name}.`,
  });
}
