/**
 * handoffLearning/sig.js - what is kept of the answer Claude gave: numbers and record ids only, never the sentence. Pure.
 *   answerSignature(text, citedRecords)  -> {nums:[...], ids:[...]}
 *   agreesWithSignature(engineAns, sig)  -> true when the engine's answer carries every number Claude gave and (when both list records) the same records
 */
const numsOf = (text) => {
  const out = new Set();
  for (const m of String(text ?? '').matchAll(/\$?\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/[$,]/g, ''));
    if (Number.isFinite(n)) out.add(String(Math.round(n * 100) / 100));
  }
  return out;
};
export function answerSignature(text, citedRecords = []) {
  const ids = [...new Set((citedRecords ?? []).map((r) => r?.id ?? r?.documentId).filter(Boolean).map(String))].sort().slice(0, 200);
  return { nums: [...numsOf(text)].slice(0, 40), ids };
}
export function agreesWithSignature(ans, sig) {
  if (!ans || !sig) return false;
  const have = numsOf(ans.text);
  const want = (sig.nums ?? []).filter((n) => !/^(?:19|20)\d\d$/.test(n)); // a year in a sentence says nothing about the figure
  if (!want.length && !(sig.ids ?? []).length) return false; // nothing to compare against: never "agrees"
  for (const n of want) if (!have.has(n)) return false;
  const mine = new Set((ans.records ?? []).map((r) => String(r.id ?? r.documentId ?? '')).filter(Boolean));
  const theirs = new Set((sig.ids ?? []).map(String));
  if (mine.size && theirs.size) {
    let inter = 0; for (const i of theirs) if (mine.has(i)) inter++;
    if (inter !== theirs.size && inter !== mine.size) return false; // one list must contain the other
  }
  return true;
}
