/**
 * Wording must not matter: a customer or technician name typed in lower case ("what equipment does thomas mercer have") is put back into the
 * name's stored spelling BEFORE the older lanes read the question, because several of them recognise a name by its capital letters. Only a
 * whole name of two or more words that is already on file for THIS organization is touched; anything else is left byte for byte.
 */
const cache = new WeakMap();
function index(vocab) {
  if (cache.has(vocab)) return cache.get(vocab);
  const map = new Map();
  for (const list of [vocab?.customers?.phrases, vocab?.technicians?.phrases]) {
    for (const ph of list ?? []) {
      const clean = String(ph ?? "").trim().replace(/\s+/g, " ");
      const n = clean.split(" ").length;
      if (n < 2 || n > 4) continue;
      const key = clean.toLowerCase();
      if (!map.has(key)) map.set(key, clean);
    }
  }
  cache.set(vocab, map);
  return map;
}
export function restoreNameCase(question, vocab) {
  const q = String(question ?? "");
  if (!vocab || !q) return { question: q, restored: 0 };
  // a negated question ("... the unit that isn't at ...") keeps its exact wording: the older lanes do not read negation, so they must not be reached by more wordings than today
  if (/\b(?:isn'?t|aren'?t|wasn'?t|not|never|no longer|except|without|other than|besides|excluding)\b/i.test(q)) return { question: q, restored: 0 };
  const map = index(vocab);
  if (!map.size) return { question: q, restored: 0 };
  const words = [...q.matchAll(/[A-Za-z][A-Za-z'’.-]*/g)].map((m) => ({ w: m[0], start: m.index, end: m.index + m[0].length }));
  let out = "", cursor = 0, restored = 0;
  for (let i = 0; i < words.length; i++) {
    let hit = null;
    for (let n = Math.min(4, words.length - i); n >= 2; n--) {
      const slice = words.slice(i, i + n);
      // the words must be separated by single spaces in the question (a comma or a period between them is not one name)
      if (!slice.every((x, k) => k === 0 || q.slice(slice[k - 1].end, x.start) === " ")) continue;
      const key = slice.map((x) => x.w.replace(/['’]s$/i, "").toLowerCase()).join(" ");
      const canon = map.get(key);
      if (canon) { hit = { n, canon, start: slice[0].start, end: slice[n - 1].start + slice[n - 1].w.replace(/['’]s$/i, "").length }; break; }
    }
    if (!hit) continue;
    if (q.slice(hit.start, hit.end) !== hit.canon) { out += q.slice(cursor, hit.start) + hit.canon; cursor = hit.end; restored++; }
    i += hit.n - 1;
  }
  return { question: out + q.slice(cursor), restored };
}

/** Everyday words for a stored fact the older lanes only know under one spelling ("freon" is the refrigerant). Whole words only; the meaning is unchanged. */
export function canonicalFactWords(question) {
  return String(question ?? "").replace(/^\s*(?:please\s+)?(?:don['’]?t|do not|dont|never mind)\b[^,;]*[,;]\s*/i, "").replace(/\bfreon\b/gi, "refrigerant");
}
