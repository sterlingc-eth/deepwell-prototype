/**
 * Donovan claim-check (R11, build spec item 1) — split an answer (headline + facts + text) into atomic
 * claims: numbers/money/counts, dates, names (customer/tech/brand/model/serial), statuses (under
 * warranty/expired/overdue), yes/no. Pure, deterministic, regex-based — no model call, same technique
 * verify.js already uses for its own (coarser) fact-vs-source check.
 *
 * A claim never spans more than one "origin": a fact's own `label: value` pair, or one sentence of the
 * answer's free-form `text` (the headline is simply sentence 0). Each claim carries enough to (a) be
 * checked against a cited source in check.js and (b) be located and removed/rewritten by policy.js if
 * it turns out unsupported.
 */
import { parseDateLoose, toIsoDate } from "./dates.js";

const STATUS_PATTERNS = [
  // Longest/most specific phrase first so a negated form is never shadowed by its bare counterpart.
  { re: /\bnot\s+(?:currently\s+)?under\s+warranty\b/i, value: "expired", family: "warranty" },
  { re: /\bout\s+of\s+warranty\b/i, value: "expired", family: "warranty" },
  { re: /\bwarranty\s+(?:has\s+)?expired\b/i, value: "expired", family: "warranty" },
  { re: /\bexpiring\s+(?:soon|within)\b/i, value: "expiring", family: "warranty" },
  { re: /\bunder\s+warranty\b/i, value: "active", family: "warranty" },
  { re: /\bwarranty\s+is\s+active\b/i, value: "active", family: "warranty" },
  { re: /\bpast\s+due\b/i, value: "overdue", family: "invoice" },
  { re: /\boverdue\b/i, value: "overdue", family: "invoice" },
  { re: /\bpaid\s+in\s+full\b/i, value: "paid", family: "invoice" },
  { re: /\bexpired\b/i, value: "expired", family: "warranty" },
  { re: /\bcurrent\b/i, value: "current", family: "invoice" },
  { re: /\bactive\b/i, value: "active", family: "warranty" },
];

/** value -> every regex from STATUS_PATTERNS that produces it — lets check.js recognize a SYNONYMOUS
 *  phrasing in the cited source ("under warranty" supporting a claimed value of "active") instead of
 *  requiring the source to repeat the exact claimed word. */
export const STATUS_VALUE_PHRASES = STATUS_PATTERNS.reduce((map, { re, value }) => {
  (map[value] ??= []).push(re);
  return map;
}, {});

const NAME_LABEL_RE = /customer|tech|contact|owner|name|brand|manufacturer|model|serial/i;
const MONEY_LABEL_RE = /amount|total|balance|paid|due(?!.*date)|price|cost|subtotal|tax/i;
const DATE_LABEL_RE = /date|expires?|due|install|purchased|created|issued/i;
const STATUS_LABEL_RE = /status|warranty|overdue/i;
const COUNT_NOUN_RE = /customers?|units?|records?|invoices?|documents?|results?|jobs?|technicians?|visits?|equipment/i;

let nextId = 0;
const mkClaim = (partial) => ({ id: `c${nextId++}`, sources: [], meta: {}, ...partial });

/** Split `text` into trimmed sentences. Avoids splitting mid-decimal ("$1,250.00") — a '.' only ends a
 *  sentence when it is followed by whitespace/end-of-string, never by another digit. */
export function splitSentences(text) {
  const s = String(text ?? "").trim();
  if (!s) return [];
  const out = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    if (ch === "." && /\d/.test(s[i - 1] ?? "") && /\d/.test(s[i + 1] ?? "")) continue; // decimal point
    let j = i + 1;
    while (j < s.length && /["')\]]/.test(s[j])) j++;
    if (j < s.length && s[j] !== " ") continue; // e.g. "Mr." mid-word — not a sentence end
    out.push(s.slice(start, j).trim());
    while (j < s.length && s[j] === " ") j++;
    start = j;
    i = j - 1;
  }
  if (start < s.length) out.push(s.slice(start).trim());
  return out.filter(Boolean);
}

/** Numeric ranges already claimed (money/count/date), so the generic "number" pass does not also
 *  re-claim the same digits as a bare, uncategorized number. */
function overlaps(ranges, start, end) {
  return ranges.some((r) => start < r[1] && end > r[0]);
}

/**
 * Extract every atomic claim found in one span of text (a sentence, or a fact's "label: value").
 * @param {string} span
 * @param {{origin:'headline'|'text'|'fact', factIndex?:number, sentenceIndex?:number, sentenceText?:string,
 *   sources?: object[], labelHint?: string}} ctx
 */
export function extractClaims(span, ctx) {
  const s = String(span ?? "");
  const claims = [];
  const claimedRanges = [];
  const base = { origin: ctx.origin, factIndex: ctx.factIndex ?? null, sentenceIndex: ctx.sentenceIndex ?? null, sentenceText: ctx.sentenceText ?? null, sources: ctx.sources ?? [] };

  // ---- money -----------------------------------------------------------------------------------
  for (const m of s.matchAll(/\$\s?\d[\d,]*(?:\.\d{1,2})?/g)) {
    claimedRanges.push([m.index, m.index + m[0].length]);
    claims.push(mkClaim({ ...base, kind: "money", raw: m[0].trim(), value: Number(m[0].replace(/[$,\s]/g, "")) }));
  }

  // ---- count ("14 customers", "3 invoices") -----------------------------------------------------
  for (const m of s.matchAll(new RegExp(`\\b(\\d{1,6})\\s+(${COUNT_NOUN_RE.source})\\b`, "gi"))) {
    if (overlaps(claimedRanges, m.index, m.index + m[0].length)) continue;
    claimedRanges.push([m.index, m.index + m[0].length]);
    claims.push(mkClaim({ ...base, kind: "count", raw: m[0].trim(), value: Number(m[1]), meta: { noun: m[2].toLowerCase() } }));
  }

  // ---- dates -------------------------------------------------------------------------------------
  const dateRes = [
    /\b\d{4}-\d{1,2}-\d{1,2}\b/g,
    /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,
    /\b[a-zA-Z]{3,9}\.?\s+\d{1,2},?\s+\d{4}\b/g,
    /\b\d{1,2}\s+[a-zA-Z]{3,9}\.?,?\s+\d{4}\b/g,
  ];
  for (const re of dateRes) {
    for (const m of s.matchAll(re)) {
      if (overlaps(claimedRanges, m.index, m.index + m[0].length)) continue;
      const parsed = parseDateLoose(m[0]);
      if (!parsed) continue;
      claimedRanges.push([m.index, m.index + m[0].length]);
      claims.push(mkClaim({ ...base, kind: "date", raw: m[0].trim(), value: toIsoDate(parsed) }));
    }
  }

  // ---- status words --------------------------------------------------------------------------
  for (const { re, value, family } of STATUS_PATTERNS) {
    const m = re.exec(s);
    if (!m) continue;
    if (overlaps(claimedRanges, m.index, m.index + m[0].length)) continue;
    claimedRanges.push([m.index, m.index + m[0].length]);
    claims.push(mkClaim({ ...base, kind: "status", raw: m[0].trim(), value, meta: { family } }));
  }

  // ---- yes/no (leading token of a sentence only — a fact's label:value is never a yes/no claim) --
  if (ctx.origin !== "fact") {
    const m = s.match(/^\s*(yes|no)\b[,.]?/i);
    if (m) claims.push(mkClaim({ ...base, kind: "yesno", raw: m[1], value: m[1].toLowerCase() === "yes" }));
  }

  // ---- bare numbers (whatever digits weren't already claimed above) ----------------------------
  for (const m of s.matchAll(/\b\d{1,9}(?:\.\d+)?\b/g)) {
    if (overlaps(claimedRanges, m.index, m.index + m[0].length)) continue;
    claimedRanges.push([m.index, m.index + m[0].length]);
    claims.push(mkClaim({ ...base, kind: "number", raw: m[0], value: Number(m[0]) }));
  }

  // ---- names (fact-origin only, unless already covered above by a more specific kind) ----------
  // Free-form `text` still gets a conservative pass: a run of 2+ capitalized words NOT at the very
  // start of the sentence (position 0 is just ordinary capitalization, not a name claim worth
  // checking — flagging every sentence-initial capital would tank precision for no gain).
  if (ctx.origin === "fact") {
    const label = String(ctx.labelHint ?? "");
    // Use the fact's own VALUE, not the whole "label: value" span — "Customer: Jonathan Smith" must be
    // checked (and, if removed, reported) as "Jonathan Smith", never with the label text glued on.
    const nameValue = String(ctx.rawValue ?? "").trim();
    if (nameValue && !claimedRanges.length && NAME_LABEL_RE.test(label)) {
      claims.push(mkClaim({ ...base, kind: "name", raw: nameValue, value: nameValue }));
    }
  } else {
    for (const m of s.matchAll(/\b[A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){1,3}\b/g)) {
      if (m.index === 0) continue;
      if (overlaps(claimedRanges, m.index, m.index + m[0].length)) continue;
      claimedRanges.push([m.index, m.index + m[0].length]);
      claims.push(mkClaim({ ...base, kind: "name", raw: m[0], value: m[0] }));
    }
  }

  return claims;
}

/**
 * Split a whole answer into atomic claims. `answer` is an /api/ask-shaped object: {text, facts, sources}.
 * Returns {claims, sentences} — `sentences` is `text` split into sentences (index 0 == the headline)
 * so policy.js can remove one sentence's worth of text without touching the rest.
 */
export function splitIntoClaims(answer) {
  const facts = Array.isArray(answer?.facts) ? answer.facts : [];
  const sentences = splitSentences(answer?.text);
  const answerSources = Array.isArray(answer?.sources) ? answer.sources : facts.flatMap((f) => (Array.isArray(f?.sources) ? f.sources : []));

  const claims = [];

  facts.forEach((f, factIndex) => {
    if (!f || typeof f !== "object") return;
    const span = `${f.label ?? ""}: ${f.value ?? ""}`;
    const sources = Array.isArray(f.sources) ? f.sources : [];
    // Re-derive kind hints from the label so a plain regex pass over "Balance due: $1,250.00" doesn't
    // need to guess — the label itself picks money/date/status/name priority via each pass's own regex,
    // this hint only feeds the fact-origin "name" fallback pass above.
    const extracted = extractClaims(span, { origin: "fact", factIndex, sources, labelHint: f.label, rawValue: f.value });
    // Money-label facts whose value parsed only as a bare "number" (no $ sign in the source string) are
    // still money semantically ("Balance due: 1250.00") — retag so amount comparison (not int comparison)
    // applies. Status-label facts likewise retag a bare word the regex pass missed.
    for (const c of extracted) {
      if (c.kind === "number" && MONEY_LABEL_RE.test(f.label ?? "")) c.kind = "money";
      if (c.kind === "date" && DATE_LABEL_RE.test(f.label ?? "")) c.meta.labelIsDate = true;
    }
    if (!extracted.length && STATUS_LABEL_RE.test(f.label ?? "") && typeof f.value === "string" && f.value.trim()) {
      claims.push(mkClaim({ origin: "fact", factIndex, sentenceIndex: null, sentenceText: null, sources, kind: "status", raw: f.value.trim(), value: f.value.trim().toLowerCase(), meta: { family: /overdue|past due|paid/i.test(f.value) ? "invoice" : "warranty", freeform: true } }));
    }
    claims.push(...extracted);
  });

  sentences.forEach((sentence, sentenceIndex) => {
    claims.push(...extractClaims(sentence, { origin: sentenceIndex === 0 ? "headline" : "text", sentenceIndex, sentenceText: sentence, sources: answerSources }));
  });

  return { claims, sentences, answerSources };
}
