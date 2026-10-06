/**
 * R39 (round 3): "how many invoices have no due date". CLOSED list of invoice fields only (FIELDS below). A field's value can live in two places: an
 * extraction row (field_key) AND the financials table (document_financials column, incl. its corrections). The lane answers "N of N have no X" only
 * when X is in NEITHER place for any invoice of this organization (same tenant scope and audience clause as the sibling counts); any field that is
 * stored anywhere, or is not in the list, returns null (the question is declined, never answered with a whole-shop figure).
 * (Older header follows.) "how many units are missing a serial number".
 * The older paths read the noun and dropped "no <field>", so the whole-entity total came back as the answer. This lane handles ONE closed shape and ONLY
 * the case where the organization's own records carry no such field at all: then every record of that kind lacks it, and that is said plainly ("120 of
 * 120 invoices have no due date on file ... no invoice record carries a due date"). When the field DOES exist in the records (or its words only partly
 * match a field), the lane returns null and the question is declined to the model / clarify path rather than guessed at. Decided from the data
 * (distinct field keys of this organization), never from a built-in list of fields.   pure: parseFieldAbsence   db: runFieldAbsence
 * Kill switch: DONOVAN_FIELD_ABSENCE=0
 */
import { attachCitations, documentRecord } from "../citations/records.js";
import { TENANT_SQL, answerEnvelope } from "../scope.js";

const norm = (s) => String(s ?? "").toLowerCase().replace(/[’`]/g, "'").normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const NOUN = { invoice: "invoice", invoices: "invoice", unit: "unit", units: "unit", customer: "customer", customers: "customer" };
const RE = /^(?:how many|number of|count of)\s+(invoices?)\s+(?:do we have\s+|do you have\s+)?(?:have|has|with|are|is|show|list|come with|that have|that are)?\s*(?:been\s+)?(?:with\s+)?(?:(?:a|an|the)\s+)?(no|without|missing|lacking|lacks?|blank|empty|(?:don t|do not|doesn t|does not|didn t) have)\s+(?:(?:a|an|any|the)\s+)?([a-z][a-z ]{1,28}?)(?:\s+(?:on file|on record|recorded|listed|yet|entered))*$/;
const FILL = new Set(["a", "an", "the", "any", "on", "file", "of", "for", "in", "number", "no"]);
const singular = (w) => (w.length > 3 ? w.replace(/ies$/, "y").replace(/(?<!s)s$/, "") : w);

export function parseFieldAbsence(question) {
  if (process.env.DONOVAN_FIELD_ABSENCE === "0") return null;
  const q = norm(question);
  const m = RE.exec(q);
  if (!m) return null;
  const words = m[3].split(" ").filter((w) => w && !FILL.has(w)).map(singular);
  if (!words.length || words.length > 3) return null;
  return { kind: NOUN[m[1]], phrase: m[3].split(" ").filter((w) => !new Set(["a", "an", "the", "any", "on", "file"]).has(w)).map(singular).join(" "), words };
}

// Round 4: the lane answers ONLY the absence of an invoice's due date or PO number. Subtotal / tax / balance / amount paid are ambiguous (a missing field versus a printed
// zero) and decline. Each field lives in two places and is "on file" when EITHER holds a non-blank effective value:
//   1. the financials view (document_financials with its human corrections already applied: a cleared field is absent), and
//   2. an extraction row with the field's exact canonical key (extract.js's own field names), effective value = the correction if one exists, else the extracted value.
const FIELDS = {
  "due date": { col: "due_date", key: "due_date", label: "due date" },
  "po": { col: "po_number", key: "po_number", label: "PO number" },
  "purchase order": { col: "po_number", key: "po_number", label: "PO number" },
};

// NULL when the text is empty after removing ALL Unicode whitespace (space, tab, newline, NBSP, zero-width, ...): "blank" in every sense
const WS = "[[:space:]\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]";
const nb = (expr) => `NULLIF(regexp_replace(${expr}, '${WS}', '', 'g'), '')`;

export async function runFieldAbsence(db, intent) {
  if (!intent || intent.kind !== "invoice") return null;
  const field = FIELDS[(intent.words ?? []).join(" ")];
  if (!field) return null;
  const reg = await db.raw(`SELECT to_regclass('document_financials') IS NOT NULL AS ok`, []);
  if (!reg?.rows?.[0]?.ok) return null;
  // same population as the sibling "how many invoices" count (answers.js documentCount): receivable USD invoices, read from document_financials joined to its document exactly as the financials view does
  const FROM = `FROM document_financials f JOIN documents d ON d.id = f.document_id AND d.tenant_id = (current_setting('app.tenant_id', true))::uuid WHERE f.tenant_id = (current_setting('app.tenant_id', true))::uuid AND f.doc_kind = 'invoice' AND f.direction = 'receivable' AND f.currency = 'USD'`;
  // the effective value of the column: a correction replaces the original ('' or JSON null = a person cleared it), whitespace-only = absent (the product's own CASE, see financeViews.js eff())
  const effv = `${nb(`CASE WHEN f.corrections ? '${field.col}' THEN f.corrections->>'${field.col}' ELSE f.${field.col}::text END`)}`;
  const has = `(${effv} IS NOT NULL OR EXISTS (SELECT 1 FROM extractions x WHERE x.document_id = f.document_id AND x.${TENANT_SQL} AND x.field_key = $1 AND ${nb('CASE WHEN x.corrected_value IS NOT NULL THEN x.corrected_value ELSE x.value END')} IS NOT NULL))`;
  const agg = await db.raw(`SELECT count(*)::int AS total, (count(*) FILTER (WHERE NOT ${has}))::int AS missing ${FROM}`, [field.key]);
  const total = agg?.rows?.[0]?.total, missing = agg?.rows?.[0]?.missing;
  if (!total || missing == null) return null;
  // the plain "how many invoices do we have" answer counts the invoice documents themselves; if this lane's population is not exactly that, decline
  const docs = await db.raw(`SELECT count(*)::int AS n FROM documents d WHERE d.document_type = 'invoice' AND d.${TENANT_SQL}`, []);
  if (docs?.rows?.[0]?.n !== total) return null;
  const miss = (await db.raw(`SELECT f.document_id, f.doc_kind, f.invoice_number, d.original_filename AS filename ${FROM} AND NOT ${has} ORDER BY f.created_at DESC LIMIT 40`, [field.key]))?.rows ?? [];
  const text = missing === total
    ? `${total} of ${total} invoices have no ${field.label} on file: your invoice records do not carry a ${field.label} at all.`
    : `${missing} of ${total} invoices have no ${field.label} on file.`;
  return attachCitations(
    answerEnvelope({ text, facts: [{ label: `Invoices with no ${field.label}`, value: String(missing), sources: [] }], extra: { fastIntent: "field_absence_count" } }),
    { records: miss.map((r) => documentRecord({ id: r.document_id, original_filename: r.filename, document_type: 'invoice' })), total: missing, claimedCount: missing, basis: `Checked the ${total} invoices for a ${field.label}, in the financial record and in the extracted fields (a person's correction replaces the extracted value; a cleared field counts as none); ${missing} have none.` });
}
