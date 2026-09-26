/**
 * suggest/templates.js — Round 14 K1.
 *
 * Answerable question TEMPLATES filled with this tenant's own real vocabulary (customers, addresses,
 * serials, technicians, brands, document types — vocab/tenantVocab.js + this feature's own
 * vocabExtras.js), for two surfaces:
 *
 *   buildValidatedPrompts(vocab, {role})  -> role-based sample prompts for an EMPTY Ask screen (tech vs
 *                                            office) and the raw candidate pool typeahead ranks over.
 *   rankTypeahead(text, candidates)       -> those candidates, ranked by prefix/fuzzy match against
 *                                            partial input text.
 *   buildDidYouMean(question, vocab, ...) -> 2-3 rephrasings offered after a failed/"not on file" answer.
 *
 * EVERY generated prompt is run through classify.js's routesWithoutModel before it is ever returned —
 * never a hard-coded example, never a template shown "just because it filled in", so a suggestion can
 * never itself be the failed query the owner is trying to prevent. A template with no matching tenant
 * data (no serial on file yet, say) simply contributes nothing rather than falling back to a fake one.
 *
 * No model call, no DB — everything here is pure, and pure over ANY vocab shape (see the top of each
 * function for exactly which fields it reads), so scripts/verify-ask-suggest.mjs exercises this with
 * plain objects and no database at all.
 */
import { routesWithoutModel } from "./classify.js";

/**
 * One entry per question SHAPE this feature knows how to fill and validate. `role` is which empty-screen
 * persona a template is offered to (see R14_CONTRACT.md: tech = field, phone, one thing at a time; office
 * = desktop, counts/lists); `need` is which vocab bucket fills it (null = no fill needed at all).
 */
const TEMPLATE_DEFS = [
  { id: "warranty-serial", role: "tech", need: "serial", build: (v) => `Is ${v} still under warranty?` },
  { id: "last-visit-address", role: "tech", need: "address", build: (v) => `When were we last at ${v}?` },
  { id: "contact-customer", role: "tech", need: "customer", build: (v) => `What's the phone number on file for ${v}?` },
  // Exact phrasing of one of ask.js's own COUNT_QUESTIONS keys (classifyMetaQuestion) — same reasoning
  // as doc-count below.
  { id: "customer-count", role: "tech", need: null, build: () => "How many customers do we have?" },
  { id: "docs-for-address", role: "office", need: "address", build: (v) => `List the documents on file for ${v}.` },
  { id: "docs-for-customer", role: "office", need: "customer", build: (v) => `What do we have on file for ${v}?` },
  { id: "tech-jobs", role: "office", need: "technician", build: (v) => `What has ${v} worked on?` },
  { id: "brand-count", role: "office", need: "brand", build: (v) => `How many ${v} units do we have?` },
  { id: "doctype-count", role: "office", need: "docType", build: (v) => `How many ${v} do we have on file?` },
  { id: "expiring-warranties", role: "office", need: null, build: () => "Which warranties expire in the next 12 months?" },
  // Exact phrasing of one of ask.js's own COUNT_QUESTIONS keys (classifyMetaQuestion) — guarantees the
  // fastest, most certain "instant" route rather than depending on the analytics pre-router being enabled.
  { id: "doc-count", role: "office", need: null, build: () => "How many documents do we have?" },
];

function vocabValues(vocab, need) {
  switch (need) {
    case "serial":
      return vocab?.serials ?? [];
    case "address":
      return vocab?.addresses ?? [];
    case "customer":
      return vocab?.customers?.phrases ?? [];
    case "technician":
      return vocab?.technicians?.phrases ?? [];
    case "brand":
      return vocab?.brands ?? [];
    case "docType":
      return (vocab?.docTypePhrases ?? []).map((t) => t.phrase);
    default:
      return [null];
  }
}

/**
 * Every valid, VALIDATED question these templates can build from `vocab` — a template whose filled
 * question would not actually route anywhere model-free (routesWithoutModel, the same precedence ask.js
 * itself uses) is dropped rather than shown. `role` narrows to one persona's templates (null = both, used
 * by typeahead, which ranks across the whole tenant vocabulary regardless of who is typing).
 */
export function buildValidatedPrompts(vocab, { role = null, limitPerTemplate = 3, ctx = {} } = {}) {
  const out = [];
  const seen = new Set();
  for (const t of TEMPLATE_DEFS) {
    if (role && t.role !== role) continue;
    const values = t.need ? vocabValues(vocab, t.need).slice(0, limitPerTemplate) : [null];
    for (const v of values) {
      if (t.need && !v) continue;
      const text = t.build(v);
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      if (!routesWithoutModel(text, ctx).matched) continue;
      seen.add(key);
      out.push({ id: `${t.id}:${v ?? ""}`, text, category: t.id });
    }
  }
  return out;
}

/**
 * Ranks `candidates` (from buildValidatedPrompts) against partial input `text`: an exact-prefix match on
 * the full question first, then a substring match, then a match on any individual word (so typing a
 * customer's last name or a street name surfaces the question naming it, not just ones that happen to
 * start the same way literal-for-literal). Ties broken by shorter text first (the more specific-looking
 * completion). No `text` at all just returns the first `max` candidates as-is, for an empty-box "browse
 * what you could ask" affordance.
 */
export function rankTypeahead(text, candidates, max = 6) {
  const p = String(text ?? "").trim().toLowerCase();
  if (!p) return (candidates ?? []).slice(0, max);
  const scored = [];
  for (const c of candidates ?? []) {
    const t = c.text.toLowerCase();
    let score;
    if (t.startsWith(p)) score = 0;
    else if (t.includes(p)) score = 1;
    else if (t.split(/\s+/).some((w) => w.startsWith(p))) score = 2;
    else continue;
    scored.push({ c, score, len: t.length });
  }
  scored.sort((a, b) => a.score - b.score || a.len - b.len);
  return scored.slice(0, max).map((s) => s.c);
}

/**
 * Up to `max` "Did you mean…" rephrasings for a question that just came back with no answer:
 *   1. A tenant-vocabulary SPELLING fix (technician/customer name via correctTenantNameTypos, street name
 *      via correctStreetTypos) — offered whenever it actually changes the text, since a typo is the single
 *      most fixable reason a real record's own question comes back empty.
 *   2. The same question with a real ADDRESS or CUSTOMER NAME this tenant has on file appended, for a
 *      question that named no anchor at all (see classify.js's hasAnchor) — "adding the missing entity".
 * Corrections are preferred first (sorted so anything routesWithoutModel would actually answer floats to
 * the top) but not required to validate: after a genuine miss, a best-effort second try is still worth
 * offering even when this pure classifier can't itself confirm it will land — the real ask.js chain (and
 * its DB-backed resolution) is always the final word on any one rephrasing.
 */
export function buildDidYouMean(question, vocab, ctx = {}, deps = {}) {
  const { correctTenantNameTypos, correctStreetTypos, streetVocab } = deps;
  const original = String(question ?? "").trim();
  if (!original) return [];
  const seen = new Set([original.toLowerCase()]);
  const chips = [];
  const add = (text) => {
    const clean = String(text ?? "").trim();
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) return;
    seen.add(key);
    chips.push({ text: clean, matched: routesWithoutModel(clean, ctx).matched });
  };

  if (typeof correctTenantNameTypos === "function") {
    try {
      const { corrected } = correctTenantNameTypos(original, vocab);
      if (corrected) add(corrected);
    } catch {
      /* best-effort — a correction failure just means fewer chips, never a thrown response */
    }
  }
  if (typeof correctStreetTypos === "function" && streetVocab) {
    try {
      const { corrected } = correctStreetTypos(original, streetVocab);
      if (corrected) add(corrected);
    } catch {
      /* same best-effort convention */
    }
  }

  const stripTrailingPunct = (s) => s.replace(/[.?!]+$/, "");
  const address = vocab?.addresses?.[0];
  if (address) add(`${stripTrailingPunct(original)} at ${address}?`);
  const customer = vocab?.customers?.phrases?.[0];
  if (customer) add(`${stripTrailingPunct(original)} for ${customer}?`);

  chips.sort((a, b) => Number(b.matched) - Number(a.matched));
  return chips.slice(0, 3).map(({ text }) => ({ text }));
}

export { TEMPLATE_DEFS };
