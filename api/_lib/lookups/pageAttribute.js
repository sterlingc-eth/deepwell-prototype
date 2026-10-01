/**
 * R32b (loop A) — deterministic answers for the two unit attributes this schema has no extraction field for: SEER rating and filter size.
 *
 * They used to defer to the model ("a model can find them in free page text"). That is a page-text SEARCH, which is code: read the pages of
 * the documents linked to the resolved customer/unit and look for a printed value. Found -> the cited value(s) with the page; not found ->
 * the honest "no SEER rating is printed in the N documents on file" decline. Never a guess, never a model call.
 *
 * Pure helpers only (no db): fastPathQuery.js runs the SQL and calls these.
 */
import { attachCitations, documentRecord } from "../citations/records.js";

/** A printed SEER value: "SEER 16", "SEER: 14.5", "SEER2 rating of 15.2", "16 SEER". Plausible range only (8-40). */
const SEER_AFTER_RE = /\bSEER2?\b[^0-9\n]{0,24}?(\d{1,2}(?:\.\d{1,2})?)(?![\d.]*\s*(?:years?|yrs?|months?|tons?|%))/gi;
const SEER_BEFORE_RE = /\b(\d{1,2}(?:\.\d{1,2})?)\s*-?\s*SEER2?\b/gi;
/** A printed filter size: "filter size: 16x25x1", "16 x 25 x 1 filter", "filter dimensions 20x20x4". */
const FILTER_AFTER_RE = /\bfilter\s+(?:size|dimensions?)\b[^0-9\n]{0,14}(\d{1,2}(?:\.\d+)?\s*[x×]\s*\d{1,2}(?:\.\d+)?(?:\s*[x×]\s*\d{1,2}(?:\.\d+)?)?)/gi;
const FILTER_BEFORE_RE = /\b(\d{1,2}(?:\.\d+)?\s*[x×]\s*\d{1,2}(?:\.\d+)?\s*[x×]\s*\d{1,2}(?:\.\d+)?)\s*(?:inch\s+|in\.?\s+)?(?:air\s+)?filters?\b/gi;

export const PAGE_ATTRIBUTES = {
  seer: { label: "SEER rating", res: [SEER_AFTER_RE, SEER_BEFORE_RE], valid: (v) => { const n = Number(v); return n >= 8 && n <= 40; } },
  filter_size: { label: "filter size", res: [FILTER_AFTER_RE, FILTER_BEFORE_RE], valid: () => true },
};

const norm = (v) => String(v).replace(/\s+/g, "").replace(/×/g, "x").toLowerCase();

/** Every printed value for `intent` in `pages` ([{document_id, page_no, text}]) -> [{ value, documentId, page }] (one per distinct value + document). */
export function findPrintedValues(intent, pages) {
  const spec = PAGE_ATTRIBUTES[intent];
  if (!spec) return [];
  const out = [];
  const seen = new Set();
  for (const p of pages ?? []) {
    const text = String(p.text ?? "");
    for (const re of spec.res) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        const value = m[1];
        if (!spec.valid(value)) continue;
        const key = `${norm(value)}|${p.document_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ value: String(value).replace(/\s+/g, "").replace(/×/g, "x"), documentId: p.document_id, page: p.page_no ?? null });
      }
    }
  }
  return out;
}

/** The answer for `intent` about `label` (a customer name or address) from the printed values found over `docCount` documents. */
export function buildPageAttributeAnswer({ intent, label, found, docCount }) {
  const spec = PAGE_ATTRIBUTES[intent];
  if (!found.length) {
    return attachCitations(
      {
        kind: "no-answer",
        text: docCount
          ? `No ${spec.label} is printed in any of the ${docCount} document${docCount === 1 ? "" : "s"} on file for ${label} — not on file.`
          : `There are no documents on file for ${label} to read a ${spec.label} from — not on file.`,
        facts: [], sources: [], confidence: 0, verifiedCount: 0, unverifiedCount: 0, closest: [], fastIntent: intent,
      },
      { records: [], total: 0, kind: "searched", basis: `Searched the text of every page of the ${docCount} document${docCount === 1 ? "" : "s"} linked to ${label} for a printed ${spec.label}; none states one.` }
    );
  }
  const values = [...new Set(found.map((f) => norm(f.value)))];
  const single = values.length === 1;
  const facts = found.slice(0, 8).map((f) => ({
    label: `${spec.label}${found.length > 1 ? ` (document ${f.documentId.slice(0, 8)})` : ""}`,
    value: f.value, basis: "printed", sources: [{ documentId: f.documentId, location: f.page ? { page: f.page } : {} }],
  }));
  const shown = [...new Set(found.map((f) => f.value))];
  const text = single
    ? `The ${spec.label} printed in the documents on file for ${label} is ${shown[0]}.`
    : `The documents on file for ${label} print more than one ${spec.label}: ${shown.slice(0, 6).join(", ")}. They may belong to different units, so check the cited pages.`;
  return attachCitations(
    {
      kind: "answer", text, facts, sources: facts.flatMap((f) => f.sources), confidence: single ? 0.9 : 0.6,
      interpretation: label, verifiedCount: 0, unverifiedCount: facts.length, closest: [], fastIntent: intent,
    },
    { records: [...new Set(found.map((f) => f.documentId))].map((id) => documentRecord({ id })), total: new Set(found.map((f) => f.documentId)).size, basis: `Found a printed ${spec.label} on ${new Set(found.map((f) => f.documentId)).size} document page${found.length === 1 ? "" : "s"} linked to ${label}.` }
  );
}
