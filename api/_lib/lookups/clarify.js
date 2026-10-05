/**
 * R32 (Team A): the deterministic "clarify instead of model" path.
 *
 * When a question is on-topic and names something we recognise (a customer on file, an ambiguous bare surname, a street address) but no
 * deterministic rule answers it confidently, the honest move is not a model guess: it is 2-3 tap-able reformulations that WILL route
 * deterministically. This module is pure (no db, no model, no network): the caller supplies the tenant vocab (vocab/tenantVocab.js).
 *
 *   buildClarifyChips(question, vocab, ctx)   -> [{ text }] (0-3; every template chip was validated with routesWithoutModel)
 *   buildClarifyAnswer(question, vocab, ctx)  -> a `kind: 'no-answer'` payload with `clarify: true`, or null when nothing recognised
 *   detectAmbiguousSurname(question, vocab)   -> { token, names } | null   ("serial on nakamura's unit" with 3 Nakamuras on file)
 *
 * UI contract (verified in src/): AskScreen/AskTab render the server `didyoumean` chips (useDidYouMean -> ask-suggest op "didyoumean" ->
 * suggest/templates.js buildDidYouMean) whenever the answer's kind is 'no-answer'. buildDidYouMean calls buildClarifyChips first, so the
 * payload here needs only kind 'no-answer' + honest text; the chips travel the existing channel and no UI change is needed. The same
 * chips are also attached as `didYouMean` for tests and non-React clients.
 *
 * Kill switch: DONOVAN_CLARIFY_CHIPS=0. Reported separately from "correct" everywhere (a chip list is never a correct answer).
 */
// No static imports on purpose: ask.js and router/classifyAll.js load this module on the hot path, and suggest/classify.js (the validator) pulls in
// the analytics route (-> @anthropic-ai/sdk). The caller injects the validator as `ctx.routesWithoutModel` (templates.js and ask.js do).

export function clarifyEnabled() {
  return process.env.DONOVAN_CLARIFY_CHIPS !== "0";
}

const MAX_WORDS = 18;
// Questions whose shape needs real reasoning across records: never replaced by a chip list.
const COMPLEX_RE = /\b(?:compare|versus|vs\.?|than|average|median|trend|forecast|predict|percent|percentage|ratio|correlat\w*|why|how\s+come|every|all\s+of|each|per|most|least|top|rank(?:ed|ing)?|between|combined|together|and\s+also)\b/i;
// Attributes this schema does not extract (recognised-but-unextracted intents keep deferring: a model may find them in page text): chips would mislead.
const UNEXTRACTED_RE = /\b(?:seer|filter|thermostat|capacitor|coil|breaker|wiring|blower|duct|amperage|btu|decibels?|noise|color|colour)\b/i;
const CUE_RE = /\b(?:serial|model|brand|make|warranty|warranties|covered|file|scheduled?|appointment|agreement|contract|account|unit|units|system|systems|equipment|furnace|ac|a\/c|heat\s*pump|handles?|invoices?|balance|owe|paperwork|visit|visits|serviced?|service|last|install(?:ed|ation)?|phone|email|e-mail|address|tonnage|tech|technician|technicians|job|jobs|call|calls|repair|maintenance|notes?|dispatch)\b/i;

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordCount = (q) => String(q).trim().split(/\s+/).filter(Boolean).length;

function fullNames(vocab) {
  return (vocab?.customers?.phrases ?? []).filter((p) => /^\S+(?:\s+\S+)+$/.test(p));
}

/** A customer full name (from the tenant vocab) named in the question, case-insensitively, at word boundaries. */
export function findNamedCustomer(question, vocab) {
  const q = ` ${String(question ?? "").toLowerCase()} `;
  let best = null;
  for (const n of fullNames(vocab)) {
    if (new RegExp(`(?<![a-z])${escapeRe(n.toLowerCase())}(?![a-z])`).test(q) && (!best || n.length > best.length)) best = n;
  }
  return best;
}

export const ADDRESS_RE = /\b\d{2,6}\s+(?:[NSEW]\.?\s+)?[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,3}\s+(?:St|Street|Rd|Road|Ave|Avenue|Dr|Drive|Blvd|Boulevard|Ln|Lane|Way|Ct|Court|Pkwy|Parkway|Pl|Place|Cir|Circle|Ter|Trail|Trl|Hwy)\b\.?/i;

/** "serial on nakamura's unit" with 2+ customers named Nakamura: the bare surname cannot say whose value is meant. */
export function detectAmbiguousSurname(question, vocab) {
  const q = String(question ?? "");
  if (!CUE_RE.test(q) || wordCount(q) > MAX_WORDS) return null;
  const names = fullNames(vocab);
  if (!names.length || findNamedCustomer(q, vocab)) return null;
  const bySurname = new Map();
  for (const n of names) {
    const parts = n.split(/\s+/);
    if (parts.length !== 2) continue; // people only; business names are not bare-surname references
    const s = parts[1].toLowerCase();
    if (!bySurname.has(s)) bySurname.set(s, []);
    bySurname.get(s).push(n);
  }
  const words = q.toLowerCase().match(/[a-z][a-z'-]+/g) ?? [];
  for (let i = 0; i < words.length; i++) {
    const token = words[i].replace(/'s$/, "");
    const list = bySurname.get(token);
    if (!list || list.length < 2) continue;
    // a first name right before it means a (typo'd or partial) full name, not a bare surname
    const prev = words[i - 1];
    if (prev && list.some((n) => n.split(/\s+/)[0].toLowerCase() === prev)) continue;
    // needs the possessive / "<name> account" / "the|on|for|about <name>" framing of a reference to a customer
    const t = escapeRe(token);
    const framed = new RegExp(`(?:\\b${t}'s\\b|\\b${t}\\s+(?:account|unit|system|file|place|house|job)\\b|\\b(?:the|on|for|about|does|did|has)\\s+${t}\\b)`, "i").test(q);
    if (!framed) continue;
    return { token, names: [...list].sort() };
  }
  return null;
}

const CUSTOMER_TEMPLATES = [
  { re: /\b(?:warrant\w*|covered|coverage)\b/i, t: (n) => `when does the warranty expire on ${n}'s unit` },
  { re: /\b(?:invoice|invoices|owe|balance|bill|billed|paid|cost|price|total)\b/i, t: (n) => `how much did we invoice ${n}` },
  { re: /\b(?:serial|model|brand|make|tonnage|unit|units|system|equipment|furnace|ac|install\w*)\b/i, t: (n) => `what equipment does ${n} have` },
  { re: /\b(?:tech|technician|technicians|who|handles?|dispatch)\b/i, t: (n) => `who's been out to ${n}'s place` },
  { re: /\b(?:last|visit|visits|serviced?|service|repair|maintenance|job|jobs|call|calls|scheduled?|appointment)\b/i, t: (n) => `when was ${n} last serviced` },
  { re: /\b(?:phone|email|e-mail|address|contact|reach|number)\b/i, t: (n) => `what is the phone number for ${n}` },
];
const CUSTOMER_DEFAULTS = [
  (n) => `what equipment does ${n} have`,
  (n) => `when was ${n} last serviced`,
  (n) => `what is the phone number for ${n}`,
  (n) => `what is the service address for ${n}`,
];
const ADDRESS_TEMPLATES = [
  { re: /\b(?:warrant\w*|covered)\b/i, t: (a) => `when does the warranty expire on the unit at ${a}` },
  { re: /\b(?:tech|technician|who)\b/i, t: (a) => `who was the last tech at ${a}` },
  { re: /\b(?:last|visit|serviced?|service|repair|maintenance|job|call)\b/i, t: (a) => `when was ${a} last serviced` },
  { re: /\b(?:serial|model|brand|unit|system|equipment|install\w*)\b/i, t: (a) => `what equipment is at ${a}` },
];
const ADDRESS_DEFAULTS = [(a) => `what equipment is at ${a}`, (a) => `when was ${a} last serviced`, (a) => `who is the customer at ${a}`];

const tidy = (s) => String(s ?? "").replace(/[.?!]+\s*$/, "").trim();

function validated(candidates, question, ctx) {
  const seen = new Set([tidy(question).toLowerCase()]);
  const out = [];
  for (const c of candidates) {
    const text = tidy(c);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    const check = ctx?.routesWithoutModel;
    if (typeof check !== "function" || check(text, ctx).matched) out.push({ text });
    if (out.length >= 3) break;
  }
  return out;
}

/** Chip candidates in priority order for what the question recognisably names. */
export function buildClarifyChips(question, vocab, ctx = {}) {
  if (!clarifyEnabled()) return [];
  const q = tidy(question);
  if (!q || wordCount(q) > MAX_WORDS) return [];
  const amb = detectAmbiguousSurname(q, vocab);
  if (amb) {
    const at = q.toLowerCase().search(new RegExp(`(?<![a-z])${escapeRe(amb.token)}(?![a-z])`));
    // the name substitution IS the reformulation: each one is kept (the real chain has the last word on it)
    return amb.names.slice(0, 3).map((n) => ({ text: `${q.slice(0, at)}${n}${q.slice(at + amb.token.length)}` }));
  }
  if (COMPLEX_RE.test(q) || UNEXTRACTED_RE.test(q)) return [];
  const name = findNamedCustomer(q, vocab);
  if (name) {
    const picked = CUSTOMER_TEMPLATES.filter((t) => t.re.test(q)).map((t) => t.t(name));
    return validated([...picked, ...CUSTOMER_DEFAULTS.map((f) => f(name))], q, ctx);
  }
  const m = ADDRESS_RE.exec(q);
  // An address is only a recognised entity once the caller has confirmed it is on file (ctx.knownAddress): chips for a street nobody serves would be noise.
  if (m && ctx.knownAddress === true) {
    const addr = m[0].replace(/\.$/, "");
    const picked = ADDRESS_TEMPLATES.filter((t) => t.re.test(q)).map((t) => t.t(addr));
    return validated([...picked, ...ADDRESS_DEFAULTS.map((f) => f(addr))], q, ctx);
  }
  return [];
}

/**
 * The `no-answer` payload for a question the deterministic layer could not answer but whose entities we recognise.
 * Returns null unless there are at least 2 chips (a single chip is a guess, not a clarification) - except the ambiguous-surname case,
 * where the candidate list itself is the answer to "which one?".
 */
import { attachCitations } from "../citations/records.js";
export function buildClarifyAnswer(question, vocab, ctx = {}) {
  if (!clarifyEnabled()) return null;
  const q = tidy(question);
  const amb = detectAmbiguousSurname(q, vocab);
  if (amb) {
    return attachCitations({
      kind: "no-answer",
      text: `"${amb.token}" matches more than one customer (${amb.names.join(", ")}). Which one do you mean? I won't guess whose record it is. Tap one, or ask by full name.`,
      facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
      clarify: true, clarifyReason: "ambiguous-surname", didYouMean: buildClarifyChips(q, vocab, ctx),
    }, { records: [], total: 0, kind: "searched", basis: "More than one customer has that name, so nothing was looked up until you pick one." });
  }
  const chips = buildClarifyChips(q, vocab, ctx);
  if (chips.length < 2) return null;
  const subject = findNamedCustomer(q, vocab) ?? (ctx.knownAddress === true ? ADDRESS_RE.exec(q)?.[0]?.replace(/\.$/, "") : null) ?? "that";
  return attachCitations({
    kind: "no-answer",
    text: `I can't answer that exactly as worded. Here is what I can look up for ${subject}: tap one.`,
    facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
    clarify: true, clarifyReason: "recognised-entity", didYouMean: chips,
  }, { records: [], total: 0, kind: "searched", basis: `I could not map the wording to one exact lookup, so nothing has been answered or searched yet. The options are lookups available for ${subject === "that" ? "what you named" : subject}.` });
}
