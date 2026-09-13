// Prose validator for /api/ask — the last line against invented values.
//
// validateProse(text, facts) → { text, strikes, removed }
//
// The answer text is split into sentences. A sentence survives when it shares
// at least one normalised value (date, money, serial, number, capitalised name
// token, address token) with a cited fact's value or label, or when it is a
// hedge / no-answer / structural sentence from the allow-list. Everything else
// is removed and counted as a strike. Nothing left → text "" (caller takes the
// no-answer path).

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_RE = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";

const ALLOW_START = [
  "nothing in your records",
  "no ",
  "no—",
  "no —",
  "none",
  "yes",
  "i couldn't",
  "i could not",
  "i can't",
  "i cannot",
  "there are no",
  "there is no",
  "there's no",
  "based on your records",
  "your records show",
  "your records don't",
  "your records do not",
  "according to your records",
  "the records show",
  "the records don't",
  "the records do not",
  "records show",
  "not enough",
  "that's not",
  "that is not",
  "unable to",
];

const ALLOW_CONTAINS = [
  "not on file",
  "on file",
  "under warranty",
  "out of warranty",
  "expired",
  "unverified",
  "no record",
  "not in your records",
  "nothing in your records",
  "not answer",
  "doesn't answer",
  "does not answer",
  "can't tell",
  "cannot tell",
  "no matching",
  "not covered",
  "still covered",
];

// ---------------------------------------------------------------------------
// Normalisers
// ---------------------------------------------------------------------------

const CONFUSABLES = { O: "0", I: "1", S: "5", B: "8" };
const serialKey = (s) =>
  String(s)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/[OISB]/g, (c) => CONFUSABLES[c]);

const pad = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const fullYear = (y) => (y.length === 2 ? `20${y}` : y);

/** Every date in the text as YYYY-MM-DD (and YYYY-MM for month-only mentions). */
export function extractDates(text) {
  const s = String(text ?? "");
  const out = new Set();
  let m;
  // 2029-11-22 / 2029/11/22
  const isoRe = /\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/g;
  while ((m = isoRe.exec(s))) out.add(iso(m[1], m[2], m[3]));
  // 11/22/2029, 11-22-29
  const usRe = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/g;
  while ((m = usRe.exec(s))) out.add(iso(fullYear(m[3]), m[1], m[2]));
  // Nov 22, 2029 / November 22 2029 / Nov. 22, 2029
  const mdyRe = new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi");
  while ((m = mdyRe.exec(s))) out.add(iso(m[3], MONTHS[m[1].toLowerCase()], m[2]));
  // 22 Nov 2029 / 22 November, 2029
  const dmyRe = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE},?\\s+(\\d{4})\\b`, "gi");
  while ((m = dmyRe.exec(s))) out.add(iso(m[3], MONTHS[m[2].toLowerCase()], m[1]));
  // Nov 2029 / November 2029 (month granularity)
  const myRe = new RegExp(`\\b${MONTH_RE}\\s+(\\d{4})\\b`, "gi");
  while ((m = myRe.exec(s))) out.add(`${m[2]}-${pad(MONTHS[m[1].toLowerCase()])}`);
  return out;
}

/** Money as a plain number string: "$1,850.00" → "1850", "$1,850.50" → "1850.5". */
export function extractMoney(text) {
  const out = new Set();
  const re = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/g;
  let m;
  while ((m = re.exec(String(text ?? "")))) {
    const whole = m[1].replace(/,/g, "");
    const cents = m[2] ? Number.parseInt(m[2].padEnd(2, "0"), 10) : 0;
    out.add(cents ? `${whole}.${cents / 100}`.replace(/^(\d+)\.0\./, "$1.") : whole);
    out.add(whole); // "$1,850.00" also matches a fact written as "$1,850"
  }
  return out;
}

/** Serial-looking tokens (letters+digits, ≥6 chars) in confusable-collapsed form. */
export function extractSerials(text) {
  const out = new Set();
  const re = /\b[A-Za-z0-9][A-Za-z0-9-]{4,}[A-Za-z0-9]\b/g;
  let m;
  while ((m = re.exec(String(text ?? "")))) {
    const tok = m[0];
    if (!/[A-Za-z]/.test(tok) || !/\d/.test(tok)) continue;
    const key = serialKey(tok);
    if (key.length >= 6) out.add(key);
  }
  return out;
}

/** Text with dates and money blanked, so their digits do not count as bare numbers. */
function withoutDatesAndMoney(text) {
  return String(text ?? "")
    .replace(/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/g, " ")
    .replace(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, " ")
    .replace(new RegExp(`\\b${MONTH_RE}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b`, "gi"), " ")
    .replace(new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH_RE},?\\s+\\d{4}\\b`, "gi"), " ")
    .replace(new RegExp(`\\b${MONTH_RE}\\s+\\d{4}\\b`, "gi"), " ")
    .replace(/\$\s?\d[\d,]*(?:\.\d{1,2})?/g, " ");
}

/** Bare numbers (counts, years, house numbers, prices without $) — dates and money excluded. */
export function extractNumbers(text) {
  const out = new Set();
  const re = /\d[\d,]*(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(withoutDatesAndMoney(text)))) {
    const n = m[0].replace(/,/g, "").replace(/\.0+$/, "");
    if (n) out.add(n);
  }
  return out;
}

const NAME_STOP = new Set(
  "the a an and or of to in on at for by with is are was were be been it its this that these those we our you your i they them their he she his her from as into about over under still any all some there here yes no none nothing based your records record according unit units warranty expired expiring expires under out covered coverage service serviced visit last installed install technician customer property equipment serial model number".split(
    " ",
  ),
);

/** Capitalised words that are not sentence-leading stopwords: names, streets, makes. */
export function extractNameTokens(text) {
  const out = new Set();
  const re = /\b([A-Z][a-z]{2,}|[A-Z]{2,})\b/g;
  let m;
  while ((m = re.exec(String(text ?? "")))) {
    const t = m[1].toLowerCase();
    if (!NAME_STOP.has(t)) out.add(t);
  }
  return out;
}

/** Lower-cased alphanumeric tokens (for address parts like "24th", "camelback"). */
function wordTokens(text) {
  return new Set(
    String(text ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3),
  );
}

const STREET_WORDS = new Set("rd road st street ave avenue blvd boulevard dr drive ln lane ct court pl place way pkwy parkway hwy highway cir circle ter terrace trl trail loop".split(" "));

/** Address tokens: "2847 N 24th St" → {"2847","24th"}; street suffixes and directionals dropped. */
export function extractAddressTokens(text) {
  const out = new Set();
  const re = /\b(\d{1,6})\s+((?:[NSEW]\.?\s+)?[A-Za-z0-9][A-Za-z0-9.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,3})/g;
  let m;
  while ((m = re.exec(withoutDatesAndMoney(text)))) {
    out.add(m[1]);
    for (const w of m[2].toLowerCase().split(/\s+/)) {
      const t = w.replace(/[^a-z0-9]/g, "");
      if (t.length >= 3 && !STREET_WORDS.has(t)) out.add(t);
    }
  }
  return out;
}

export function normalizedValues(text) {
  return {
    dates: extractDates(text),
    money: extractMoney(text),
    serials: extractSerials(text),
    numbers: extractNumbers(text),
    names: extractNameTokens(text),
    address: extractAddressTokens(text),
    words: wordTokens(text),
  };
}

function intersects(a, b) {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------

/** Split on sentence punctuation followed by whitespace + a capital/digit/quote; keeps abbreviations like "St." and "Nov." together. */
export function splitSentences(text) {
  const s = String(text ?? "").trim();
  if (!s) return [];
  const parts = [];
  let start = 0;
  const re = /([.!?])(["')\]]?)\s+(?=[A-Z0-9"'(])/g;
  let m;
  while ((m = re.exec(s))) {
    const end = m.index + m[1].length + m[2].length;
    const candidate = s.slice(start, end).trim();
    const lastWord = candidate.split(/\s+/).pop() ?? "";
    // "Nov." / "St." / "Rd." / "No." / "Inc." are not sentence ends.
    if (/^(?:[A-Z][a-z]{1,3}|[A-Z])\.$/.test(lastWord) && !/^(?:etc)\.$/i.test(lastWord)) continue;
    parts.push(candidate);
    start = end;
  }
  const tail = s.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

export function isAllowed(sentence) {
  const lower = sentence.trim().toLowerCase().replace(/^["'(]+/, "");
  if (ALLOW_START.some((p) => lower.startsWith(p))) return true;
  if (ALLOW_CONTAINS.some((p) => lower.includes(p))) return true;
  if (/\bno\b[^.]{0,40}\bon file\b/.test(lower)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * validateProse(text, facts) → { text, strikes, removed }
 * facts: [{ label, value }] — only cited facts should be passed.
 */
export function validateProse(text, facts = []) {
  const sentences = splitSentences(text);
  if (!sentences.length) return { text: "", strikes: 0, removed: [] };

  const factBlob = facts.map((f) => `${f?.label ?? ""} ${f?.value ?? ""}`).join(" \n ");
  const known = normalizedValues(factBlob);
  known.numbers.add(String(facts.length));

  const kept = [];
  const removed = [];
  for (const sentence of sentences) {
    if (supported(sentence, known) || isAllowed(sentence)) kept.push(sentence);
    else removed.push(sentence);
  }
  return { text: kept.join(" "), strikes: removed.length, removed };
}

function supported(sentence, known) {
  const v = normalizedValues(sentence);
  if (intersects(v.dates, known.dates)) return true;
  // A month-only mention ("in November 2029") supports a full date in the facts.
  for (const d of v.dates) if (d.length === 7) for (const k of known.dates) if (k.startsWith(d)) return true;
  if (intersects(v.money, known.money)) return true;
  if (intersects(v.serials, known.serials)) return true;
  if (intersects(v.address, known.address) || intersects(v.address, known.words)) return true;
  if (intersects(v.names, known.names) || intersects(v.names, known.words)) return true;
  if (intersects(v.numbers, known.numbers)) return true;
  // "$1,850" in a fact vs "1,850 dollars" in prose
  if (intersects(v.numbers, known.money)) return true;
  return false;
}
