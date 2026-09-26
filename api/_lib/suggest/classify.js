/**
 * suggest/classify.js — Round 14 K1 (R14_CONTRACT.md item (a): "Donovan should suggest sample prompts /
 * predict input so users rarely hit a failed query").
 *
 * Mirrors, READ-ONLY, the exact precedence order api/ask.js's own pre-router chain uses to decide whether
 * a question will be answered WITHOUT a model call at all: meta -> fastPath -> deterministic -> relations
 * -> contactLookup -> docLookup -> contentCount -> decompose -> money-gate -> analytics pre-router (see
 * ask.js lines ~799-873). Every function imported below is the SAME pure, no-DB shape classifier ask.js
 * itself calls at that point in its chain (see each module's own header for "pure shape detection, no
 * DB") — nothing here executes a query, and nothing here is a copy: it is the real function, imported.
 * classifyMetaQuestion is the one exception — it is defined (and only defined) inside api/ask.js itself,
 * so importing it here is a read of that export, never an edit of the file.
 *
 * This is used two ways:
 *   1. routesWithoutModel(question, ctx) — would ask.js answer this without ever calling a model? Used
 *      both to build the preflight hint below AND to VALIDATE every generated sample/typeahead prompt in
 *      templates.js before it is ever shown to a person (an unvalidated suggestion could set someone up
 *      for exactly the failed query the owner is asking to avoid).
 *   2. classifyPreflight(question, ctx) — the three-level hint shown next to the Ask box while typing.
 *
 * R14_CONTRACT.md's own root-cause measurement: with Anthropic credits OUT, every question that reaches
 * the Haiku analytics planner or the Sonnet research agent currently fails live. `routesWithoutModel`
 * returning true is therefore not just "faster" — right now it is the only way the question gets answered
 * at all, which is exactly why an unmatched question earns "may take longer" rather than a false promise.
 */
import { classifyMetaQuestion } from "../../ask.js";
import { classifyFastPath, isFastPathEnabled } from "../fastPath.js";
import { classifyDeterministic } from "../deterministicRouter.js";
import { classifyRelationsQuestion } from "../relations/questions.js";
import { parseContactLookupQuestion } from "../contactLookup.js";
import { parseDocLookupQuestion } from "../docLookup.js";
import { parseContentCountQuestion } from "../contentCount.js";
import { classifyDecompose } from "../decompose/index.js";
import { preClassifyAnalytics, looksLikeSingleRecordReference, isMoneyQuestion } from "../analytics.js";
import { isFinancialQuestion } from "../financials/classify.js";
import { isAnalyticsEnabled } from "../routes/analytics.js";
import { normalizeQuestion as normalizeQuestionForAnalytics } from "../nlNormalize.js";

export const PREFLIGHT = Object.freeze({
  INSTANT: "instant",
  SLOW: "slow",
  NEEDS_ANCHOR: "needs-anchor",
});

const HINT_TEXT = Object.freeze({
  [PREFLIGHT.INSTANT]: "Instant answer",
  [PREFLIGHT.SLOW]: "This one may take longer",
  [PREFLIGHT.NEEDS_ANCHOR]: "Try adding a customer, address or date",
});

/**
 * Pure: the same precedence ask.js's own pre-router block runs, stopping at the first classifier that
 * claims the question. Returns {matched, route}. `ctx` is {overlay?, pack?, tenantVocab?} — every field
 * optional; a caller that hasn't resolved one just gets a slightly less name/pack-aware classification,
 * never a throw (same "degrade, never fail" convention as ask.js's own overlay/pack/vocab lookups).
 */
export function routesWithoutModel(question, ctx = {}) {
  const q = String(question ?? "");
  if (!q.trim()) return { matched: false, route: null };
  const { overlay, pack, tenantVocab } = ctx;

  if (classifyMetaQuestion(q)) return { matched: true, route: "meta" };
  if (isFastPathEnabled() && classifyFastPath(q)) return { matched: true, route: "fastpath" };
  if (classifyDeterministic(q, { overlay })) return { matched: true, route: "deterministic" };
  if (classifyRelationsQuestion(q)) return { matched: true, route: "relations" };
  const contactLookupIntent = parseContactLookupQuestion(q, { overlay });
  if (contactLookupIntent) return { matched: true, route: "contact-lookup" };
  const docLookupIntent = parseDocLookupQuestion(q, { overlay });
  if (docLookupIntent) return { matched: true, route: "doc-lookup" };
  const contentCountIntent = parseContentCountQuestion(q, pack ?? null);
  if (contentCountIntent) return { matched: true, route: "content-count" };
  if (classifyDecompose(q, { pack })) return { matched: true, route: "decompose" };

  const normalized = normalizeQuestionForAnalytics(q, { overlay, pack, tenantVocab }).normalized;
  if (isMoneyQuestion(normalized) || isFinancialQuestion(normalized)) return { matched: true, route: "financials" };

  // Analytics pre-router (handoffs/DONOVAN_ANALYTICS_A_2026-09-21.md): the same cheap, no-DB gate ask.js
  // itself checks before ever paying for the Haiku planner call — counted here as "instant" because (a)
  // its own executor is already fully deterministic (R14_CONTRACT.md) and (b) it is still the closest
  // this chain gets to an answer for a question shaped this way; the hint is a forecast, not a guarantee,
  // and the real ask.js chain is always the final word on any one question.
  if (isAnalyticsEnabled() && !looksLikeSingleRecordReference(q) && preClassifyAnalytics(normalized, { overlay })) {
    return { matched: true, route: "analytics" };
  }
  return { matched: false, route: null };
}

// Anchors: a real customer/technician name on file (from tenantVocab), an address-shaped number+word
// span, a 5-digit zip, a year, or a relative/named date word — the same kinds of things fastPath's own
// hasAnchor()/extractSubject() and the address/date routers above already require SOMETHING to key off
// of. Used only to pick the wording of the NEEDS_ANCHOR hint, never to answer anything itself.
const DATE_WORD_RE =
  /\b(today|yesterday|tomorrow|last\s+(week|month|year|quarter)|this\s+(week|month|year|quarter)|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;
const YEAR_RE = /\b(19|20)\d{2}\b/;
const ADDR_NUM_RE = /\b\d{1,6}\s+[A-Za-z]/;
const ZIP_RE = /\b\d{5}\b/;

/** Pure: does `question` already carry something that could anchor a single-record lookup? */
export function hasAnchor(question, tenantVocab) {
  const q = String(question ?? "");
  if (ADDR_NUM_RE.test(q) || YEAR_RE.test(q) || ZIP_RE.test(q) || DATE_WORD_RE.test(q)) return true;
  const ql = q.toLowerCase();
  const names = [...(tenantVocab?.customers?.phrases ?? []), ...(tenantVocab?.technicians?.phrases ?? [])];
  return names.some((n) => n && ql.includes(String(n).toLowerCase()));
}

/**
 * The three-level hint for the text currently in the Ask box. Returns null for empty/whitespace-only
 * text (nothing to hint about yet) — never throws.
 */
export function classifyPreflight(question, ctx = {}) {
  const q = String(question ?? "").trim();
  if (!q) return null;
  const { matched, route } = routesWithoutModel(q, ctx);
  const level = matched ? PREFLIGHT.INSTANT : hasAnchor(q, ctx.tenantVocab) ? PREFLIGHT.SLOW : PREFLIGHT.NEEDS_ANCHOR;
  return { level, message: HINT_TEXT[level], route };
}
