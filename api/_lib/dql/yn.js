/**
 * dql/yn.js - "does 2025 have more invoices than 2020", "yes or no: Tucson has more than Marana": a yes/no question about the first-named side of a comparison.
 */
export function ynOf(raw) {
  const r = String(raw ?? '');
  if (/\bwhich\b/i.test(r)) return {};
  const lead = r.split(/\s+/).slice(0, 8).join(' ');
  if (!/\b(?:does|did|do|is|was|has|have|yes\s+or\s+no)\b/i.test(lead)) return {};
  const less = /\b(?:fewer|less|lower|smaller)\b/i.test(r);
  if (!less && !/\b(?:more|higher|bigger|greater|larger)\b/i.test(r)) return {};
  const subj = (/\b(?:does|did|do|is|was|has|have)\s+(.+?)\s+(?:have|has|had|got|get)\b/i.exec(r) ?? /(?:yes\s+or\s+no[:,]?\s*)(.+?)\s+(?:has|have|had)\b/i.exec(r) ?? [])[1] ?? null;
  return { yn: { dir: less ? 'less' : 'more', subject: subj } };
}

/** The "Yes, " / "No, " in front of a comparison sentence; a, b = the two sides ({label, value}), in the order they were written. */
export function ynLead(yn, a, b) {
  const subj = yn.subject ? String(yn.subject).toLowerCase() : null;
  const A = subj && String(b.label).toLowerCase().includes(subj) && !String(a.label).toLowerCase().includes(subj) ? b : a; const B = A === a ? b : a;
  const yes = A.value !== B.value && (yn.dir === 'more' ? A.value > B.value : A.value < B.value);
  return yes ? 'Yes, ' : 'No, ';
}

/** "Invoices: 2023 had 16 ..." reads "Yes, invoices: ..."; a sentence that starts with a name keeps its capital letter. */
export const ynText = (yn, a, b, text) => `${ynLead(yn, a, b)}${/^[A-Z][a-z]+:/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text}`;
