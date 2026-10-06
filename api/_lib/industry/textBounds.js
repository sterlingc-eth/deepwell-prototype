/**
 * Bounds for the pack extractors (plumbing, property, electrical): a pathological page (one 60,000-character line, a few MB of text) must cost
 * milliseconds, not seconds. A line longer than MAX_LINE is cut to its first MAX_LINE characters (every real printed line is far shorter), and one
 * document's scan stops after MAX_TOTAL characters. Normal documents are untouched, so their extraction is identical.
 */
export const MAX_LINE = 2000;
export const MAX_TOTAL = 400000;

/** New scan budget for one document. */
/** `cut` turns true as soon as any text of the document was not read (a page past the total cap, or a line cut at MAX_LINE): the extractor reports the document as partly read. */
export const newBudget = () => ({ left: MAX_TOTAL, cut: false });

/** The lines of one page's text, each at most MAX_LINE characters, charged against `budget`; [] once the budget is spent. */
export function boundedLines(text, budget) {
  const s = String(text ?? '');
  if (budget.left <= 0) { if (s.trim()) budget.cut = true; return []; }
  const body = s.length > budget.left ? s.slice(0, budget.left) : s;
  if (body.length < s.length) budget.cut = true;
  budget.left -= body.length;
  const out = [];
  for (const raw of body.split(/\r?\n/)) { if (raw.length > MAX_LINE) budget.cut = true; out.push(raw.length > MAX_LINE ? raw.slice(0, MAX_LINE) : raw); }
  return out;
}
