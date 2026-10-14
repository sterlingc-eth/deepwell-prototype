/**
 * handoffLearning/mask.js - what may be kept of a question. Pure.
 *
 *   maskQuestion(question, vocab)  -> {masked, words, blocked}   names (customers, staff, vendors, cities, brands), numbers, dates, ids, e-mails, phones and quoted text are
 *                                      replaced by {NAME} {NUM} {DATE} {QUOTE}; `blocked` is set when the text looks personal (card / SSN / e-mail / phone) and must not be kept at all.
 * The masked form is the only question text that is ever stored beyond the job's own run (and it is stored per organization only, never in a shared table).
 */
const PII = [
  /\b\d{3}-\d{2}-\d{4}\b/, /\b(?:\d[ -]?){13,19}\b/, /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i, /\(?\b\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/,
];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function maskQuestion(question, vocab = null) {
  let t = String(question ?? '').replace(/\s+/g, ' ').trim();
  const blocked = PII.some((re) => re.test(t));
  if (blocked) return { masked: '', words: [], blocked: true };
  t = t.replace(/"[^"]{1,80}"|“[^”]{1,80}”/g, ' {QUOTE} ');
  const names = new Set();
  for (const key of ['customers', 'technicians']) for (const p of vocab?.[key]?.phrases ?? []) names.add(String(p));
  for (const v of vocab?.dql?.categorical?.vendor ?? []) names.add(String(v));
  for (const c of vocab?.cities ?? []) names.add(String(c));
  for (const b of vocab?.brands ?? []) names.add(String(b));
  for (const m of vocab?.models ?? []) names.add(String(m).split(/\s+serial/i)[0]);
  const list = [...names].filter((n) => n.length >= 3).sort((a, b) => b.length - a.length);
  for (const n of list) t = t.replace(new RegExp(`\\b${esc(n)}(?:'s)?\\b`, 'gi'), ' {NAME} ');
  t = t.replace(/\b(?:19|20)\d\d-\d{1,2}-\d{1,2}\b|\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g, ' {DATE} ')
    .replace(/\$?\d[\d,]*(?:\.\d+)?/g, ' {NUM} ')
    .replace(/#\s*\{NUM\}|\b[A-Z]{1,4}-\{NUM\}/g, ' {NUM} ')
    .replace(/\s+/g, ' ').trim();
  const words = t.toLowerCase().match(/[a-z][a-z'-]*/g) ?? [];
  return { masked: t, words, blocked: false };
}

/** True when a word must never become a learning: a name word of this organization, a number-ish word, anything with a digit. */
export function isNameWord(word, vocab) {
  const w = String(word).toLowerCase();
  for (const key of ['customers', 'technicians']) if (vocab?.[key]?.words?.has?.(w)) return true;
  for (const key of ['customers', 'technicians']) for (const p of vocab?.[key]?.phrases ?? []) if (String(p).toLowerCase().split(/[^a-z]+/).includes(w)) return true;
  for (const c of vocab?.cities ?? []) if (String(c).toLowerCase().split(/[^a-z]+/).includes(w)) return true;
  for (const b of vocab?.brands ?? []) if (String(b).toLowerCase().split(/[^a-z]+/).includes(w)) return true;
  for (const v of vocab?.dql?.categorical?.vendor ?? []) if (String(v).toLowerCase().split(/[^a-z]+/).includes(w)) return true;
  return false;
}
