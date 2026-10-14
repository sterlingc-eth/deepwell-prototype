/**
 * dql/yn.js - "does 2025 have more invoices than 2020", "yes or no: Tucson has more than Marana": a yes/no question about the first-named side of a comparison.
 */
export function ynOf(raw) {
  const r = String(raw ?? '');
  if (/\bwhich\b/i.test(r)) return {};
  if (/\b(?:gap|gaps|difference|differ|diff)\b|\bmore\s+or\s+less\b|\bhow\s+(?:much|many|big)\b/i.test(r)) return {};
  const lead = r.split(/\s+/).slice(0, 8).join(' ');
  const clauseLead = r.split(/\s*[,:;\u2014]\s+|\s+-\s+/).some((c) => /^(?:does|did|do|is|was|has|have|are|were|yes\s+or\s+no)\b/i.test(c.trim()));
  const anywhere = !/\b(?:what|which|how|when|where|who|why|whats)\b|what's/i.test(r) && /\b(?:does|did|do|is|was|has|have|are|were)\b/i.test(r);
  if (!/\b(?:does|did|do|is|was|has|have|are|were|yes\s+or\s+no)\b/i.test(lead) && !clauseLead && !anywhere) return {};
  const less = /\b(?:fewer|less|lower|smaller|down)\b/i.test(r);
  const chrono = false;
  if (!/\b(?:more|higher|bigger|greater|larger|fewer|less|lower|smaller)\b/i.test(r) && /\b(?:up|down)\s+from\b/i.test(r)) return {};
  if (!less && !/\b(?:more|higher|bigger|greater|larger|up)\b/i.test(r)) return {};
  if (chrono && /\b(?:up|down)\s+(?:or|and)\s+(?:up|down)\b|\bup\s+or\s+down\b/i.test(r)) return {};
  const subj = (/\b(?:does|did|do|is|was|has|have)\s+(.+?)\s+(?:have|has|had|got|get)\b/i.exec(r) ?? /(?:yes\s+or\s+no[:,]?\s*)(.+?)\s+(?:has|have|had)\b/i.exec(r) ?? [])[1] ?? null;
  return { yn: { dir: less ? 'less' : 'more', subject: chrono ? null : subj, ...(chrono ? { chrono: true } : {}) } };
}

/** The "Yes, " / "No, " in front of a comparison sentence; a, b = the two sides ({label, value}), in the order they were written. */
export function ynLead(yn, a, b) {
  const subj = yn.subject ? String(yn.subject).toLowerCase() : null;
  if (yn.chrono) { if (!a.from || !b.from) return 'No, '; const later = a.from >= b.from ? a : b; const earlier = later === a ? b : a; return (yn.dir === 'more' ? later.value > earlier.value : later.value < earlier.value) ? 'Yes, ' : 'No, '; }
  const A = subj && String(b.label).toLowerCase().includes(subj) && !String(a.label).toLowerCase().includes(subj) ? b : a; const B = A === a ? b : a;
  const yes = A.value !== B.value && (yn.dir === 'more' ? A.value > B.value : A.value < B.value);
  return yes ? 'Yes, ' : 'No, ';
}

/** "Invoices: 2023 had 16 ..." reads "Yes, invoices: ..."; a sentence that starts with a name keeps its capital letter. */
export const ynText = (yn, a, b, text) => `${ynLead(yn, a, b)}${/^[A-Z][a-z]+(?: [a-z]+)*:/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text}`;

/** "what is the gap / difference between ...": the answer leads with the difference itself. */
export function gapOf(raw) {
  const r = String(raw ?? '');
  if (/\b(?:does|did|do|is|was|has|have)\b/i.test(r.split(/\s+/).slice(0, 3).join(' ')) && /\b(?:more|less|fewer|higher|lower)\b/i.test(r)) return {};
  return /\b(?:gap|gaps|difference|differences|diff|differ|how\s+(?:much|many)\s+(?:more|less|fewer|higher|lower|bigger|smaller))\b/i.test(r) ? { gap: true } : {};
}
export const gapText = (shown, a, b, text) => `The difference is ${a.value === b.value ? shown : shown}: ${text.charAt(0).toLowerCase() + text.slice(1)}`;
