/**
 * The answer contract, shared by /api/ask and anything else that needs to
 * produce a sourced answer.
 *
 * Three rules live here, and they are the product:
 *
 *   1. The model may only return the `answer` tool — no free prose path.
 *
 *   2. Every fact must cite a page (or an already-extracted field) that the
 *      retrieval step actually returned FOR THAT EXACT DOCUMENT — not merely
 *      a document that happens to be in the allowed set. Checking only
 *      `allowedDocs.has(documentId)` let a fact through with a real,
 *      retrieved document and a fabricated or empty `location`: the document
 *      genuinely was evidence, but the specific claim ("page 4 says X") was
 *      never checked, so it could be invented anyway. `buildAllowed` /
 *      `shapeAnswer` below track pages and extracted-field names per
 *      document and reject a citation that doesn't match one exactly.
 *
 *   3. A fact whose value was produced by arithmetic (not read off a page)
 *      says so via `basis: "computed"`, so nothing downstream can render a
 *      calculated date as though a document stated it. Nothing that reaches
 *      this file today is computed — extraction is forbidden from doing
 *      arithmetic itself (see warrantyRules.js) — so `shapeAnswer` only
 *      trusts a model's "computed" claim when the caller opts in via
 *      `allowComputed`. /api/ask never passes that, so a model can't dodge
 *      rule 2 just by labelling a fabrication "computed"; a future
 *      computed-answer endpoint (e.g. for warranty dates) can pass
 *      `allowComputed: true` once it supplies real computed evidence.
 *
 * `shapeAnswer` enforces all of this in code, not by asking the model
 * nicely: it drops any source that doesn't check out and then drops facts
 * left with no source at all.
 */
import { DOCUMENT_TYPES, DOCUMENT_TYPE_DEFINITIONS } from './documentTypes.js';
import { BRAND_RULES } from './warrantyRules.js';
import { estimateTokens } from './promptCache.js';

export const ANSWER_TOOL = {
  name: "answer",
  description: "Return the answer to the user's question using only the supplied evidence.",
  input_schema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description:
          "1–3 plain-English sentences answering the question. If the evidence doesn't support an answer, say so plainly and do not guess.",
      },
      facts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            value: { type: "string" },
            status: { type: "string", enum: ["ok", "warn", "bad", "info", "muted"] },
            entityId: { type: "string" },
            basis: {
              type: "string",
              enum: ["printed", "computed"],
              description:
                "'printed' (default): the value is written on the cited page or was already extracted from one. " +
                "'computed': you personally did arithmetic on other evidence to produce this value (e.g. adding a " +
                "term length to an install date). Use 'computed' ONLY for a value you calculated; a value you simply " +
                "read, even one that required combining two sentences, is still 'printed'.",
            },
            sources: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  documentId: { type: "string" },
                  location: {
                    type: "object",
                    properties: { page: { type: "number" }, field: { type: "string" } },
                  },
                  excerpt: { type: "string" },
                },
                required: ["documentId", "location"],
              },
            },
          },
          required: ["label", "value", "sources"],
        },
      },
      confidence: { type: "number" },
      entityId: { type: "string" },
      interpretation: { type: "string" },
    },
    required: ["text", "facts", "confidence"],
  },
};

const RULES = `Rules:
- Answer only from the evidence above. Every fact must cite at least one source, copying documentId exactly as given.
- For a passage, location must be { "page": <the page number shown for that passage> } — the exact number, never a guess or a nearby page.
- For an already-extracted field, location must be { "field": "<field name exactly as shown>" } — those aren't tied to a single page here, so do not invent a page number for one.
- Never invent a document, a page, a date, a serial, a model number, or a price. If the evidence does not answer the question, set text to "Nothing in your records answers that." and return no facts.
- If two passages disagree, say so in text and cite both rather than picking one.
- Facts are a key/value grid: keep labels short ("Warranty", "Installed by", "Cost"). Use status "ok" for an active warranty, "warn" for one expiring within 90 days, "bad" for expired.
- basis is "printed" unless you personally computed the value yourself — see the basis field description.
- text is 1–3 sentences a dispatcher would say out loud.`;

/**
 * ---------------------------------------------------------------------------
 * Prompt-caching split (added for /api/ask cost accounting — see
 * scripts/verify-caching.mjs and handoffs/HANDOFF-B.md).
 *
 * buildPrompt() above stays exactly as it was: it's still exercised directly
 * by scripts/verify-answer.mjs and scripts/verify-retrieval.mjs, and nothing
 * here changes what it returns.
 *
 * /api/ask itself no longer sends one flat user-message string, because a
 * flat string can't have an Anthropic cache breakpoint in the middle of it.
 * Instead it sends three pieces, ordered so a cache breakpoint after each of
 * the first two can be reused by the next call:
 *
 *   1. SYSTEM_PROMPT       — the task framing + RULES. Zero variables: the
 *                            same text on every single call, for every
 *                            tenant, forever (until this file changes).
 *   2. buildContextBlock() — the retrieved passages/extractions for THIS
 *                            question. Varies per call, but a follow-up
 *                            question that retrieves the same top passages
 *                            (the common case — "and when was it installed"
 *                            right after "what's the warranty on unit 3")
 *                            reproduces this block byte-for-byte, so it's
 *                            the one placed behind a cache breakpoint, ahead
 *                            of the question. This is the one that matters:
 *                            it's usually the largest block by far (up to 12
 *                            passages x 1200 chars), and it's the one that
 *                            repeats across a real conversation.
 *   3. buildQuestionBlock() — today's date + the question itself. Always
 *                            different (today ticks daily even on a
 *                            word-for-word repeated question), so it is
 *                            NEVER given cache_control — see api/ask.js.
 *
 * Concatenating all three (in order, with the same blank-line join buildPrompt
 * uses) reproduces buildPrompt()'s own text, so this is a pure decomposition,
 * not a second, drifting copy of the wording.
 */

const PREAMBLE =
  "You are a grounded question-answering assistant for an HVAC dispatch " +
  'company. You will be given retrieved passages from the customer\'s own ' +
  'documents, then a question. Answer using only the "answer" tool.';

/**
 * Reference material below (glossary, document-type guide, warranty-brand
 * table, style rules) is what pushes SYSTEM_PROMPT above Haiku's 2048-token
 * prompt-caching minimum (api/_lib/promptCache.js) so ASK_MODEL=claude-haiku-4-5
 * (the 2026-09-20 owner default) actually gets a cache hit on it, instead of
 * cache_control being attached to a block too short for Anthropic to ever
 * cache. It is genuinely load-bearing content, not padding: every section is
 * something the model needs to interpret an HVAC dispatcher's question and
 * the passages it's shown, none of it is a substitute for evidence — see the
 * "background only" guard on each section, and the RULES below still forbid
 * stating anything not also in the evidence.
 */
const HVAC_GLOSSARY = `HVAC GLOSSARY (background only — never state a fact from here unless the evidence above also states it; this is for understanding the question and the passages, not for answering from):
- RTU (rooftop unit): a packaged heating/cooling unit mounted on a roof, common on commercial buildings.
- Condenser: the outdoor half of a split system; rejects heat to outside air in cooling mode.
- Evaporator coil: the indoor coil, usually above or beside a furnace/air handler, where refrigerant absorbs heat from indoor air.
- Air handler: the indoor unit that moves air across the evaporator coil; paired with a heat pump or as the indoor half of a split system with no gas furnace.
- Heat pump: a unit that both heats and cools by reversing refrigerant flow.
- Furnace: a gas-, oil-, or electric-fired indoor unit that heats air directly.
- Mini-split / ductless: one outdoor condenser feeding one or more small indoor units with no ductwork.
- Compressor: the pump inside a condenser that pressurizes refrigerant; the single most expensive part to replace.
- Capacitor / contactor: small electrical parts that start a compressor/fan motor or switch power to it; common, inexpensive service items.
- Refrigerant: the working fluid (R-410A, R-22 [phased out], R-454B); "a charge" means adding refrigerant.
- Tonnage: cooling capacity, in tons of refrigeration (1 ton = 12,000 BTU/hr); residential units are usually 1.5-5 tons.
- SEER / SEER2: a unit's rated cooling efficiency; higher is more efficient, and is NOT the same measurement as tonnage.
- Plenum: the sheet-metal box atop a furnace/air handler that ductwork connects to.
- PM (preventive maintenance): a routine scheduled visit, as opposed to a repair or emergency call.
- Startup / commissioning: the initial readings recorded when newly installed equipment is first run.
- Registration window: the number of days after install a manufacturer allows for registering equipment to unlock its full parts warranty (see the brand table below).
- Document pipeline stages you may see on a passage/extraction: received (uploaded, not yet read) -> read (text transcribed) -> classified (document type set) -> extracted (fields pulled) -> linked (attached to a customer/equipment record) -> verified (confirmed complete and correct, by the AI or a person). "AI verified" and "human verified" both mean stage verified, distinguished only by who confirmed it.
- Registration window closing / expiring / expired describe a warranty's urgency, computed from the install date and, if on file, the registration date — never guessed from a document that doesn't state one.`;

const DOCUMENT_TYPE_GUIDE = `DOCUMENT TYPES you may see named next to a passage (the "documentType" field):
${DOCUMENT_TYPES.map((t) => `- ${t.id}: ${DOCUMENT_TYPE_DEFINITIONS[t.id] ?? ''}`).join('\n')}`;

/** Rendered once at module load from warrantyRules.js's BRAND_RULES — never
 * copied by hand, so this can never drift from the actual derivation logic.
 * Only verified brands (a real `rule`) are listed; an unverified brand
 * computes nothing there either, so it has nothing useful to summarize here. */
function renderBrandWarrantyTable() {
  return Object.values(BRAND_RULES)
    .filter((v) => v.rule)
    .map((v) => {
      const r = v.rule;
      const registered = r.registeredPartsYears != null
        ? `${r.registeredPartsYears}-year parts if registered in time`
        : `up to ${Math.max(r.unregisteredPartsYears, ...(r.conditionalRegisteredTerms ?? []).map((o) => o.years))}` +
          `-year parts if registered in time, depending on conditions not always on file`;
      return `- ${v.label}: register within ${r.registrationWindowDays} days of install for ${registered}; ` +
        `${r.unregisteredPartsYears}-year parts if never registered.`;
    })
    .join('\n');
}

const WARRANTY_BRAND_TABLE = `MANUFACTURER WARRANTY BACKGROUND (background only — a specific unit's actual term/expiry always comes from its extracted warranty fields or an already-computed warranty shown in the evidence, never computed here from this table alone):
${renderBrandWarrantyTable()}`;

const ANSWER_STYLE_RULES = `ANSWER STYLE:
- Write like a dispatcher talking to another dispatcher: short, plain, no hedging filler ("it appears that...", "based on the provided information...").
- Money: "$1,234.56" — two decimals, comma-separated thousands.
- Dates: say them the way a person would ("expires March 10, 2034"), not the raw YYYY-MM-DD, even though sources cite the raw value.
- A serial or model number is always copied exactly as shown in the evidence — never reformatted, abbreviated, or "corrected".
- If two documents disagree, name both (filename or date) in text so the dispatcher knows which is which, rather than silently picking one.
- Never fill in a customer's phone number, address, or unit location that isn't itself in the evidence, even to make a sentence read more naturally.`;

export const SYSTEM_PROMPT =
  `${PREAMBLE}\n\n${HVAC_GLOSSARY}\n\n${DOCUMENT_TYPE_GUIDE}\n\n${WARRANTY_BRAND_TABLE}\n\n${ANSWER_STYLE_RULES}\n\n${RULES}`;

export function buildContextBlock({ passages, extractions } = {}) {
  const ev =
    (passages ?? [])
      .map(
        (p, i) =>
          `[${i + 1}] documentId: ${p.documentId} | page: ${p.page} | file: ${p.filename}${
            p.documentType ? ` (${p.documentType})` : ""
          }\n${p.excerpt}`
      )
      .join("\n\n") || "(no passages matched)";

  const factsBlock = extractions?.length
    ? `\n\nALREADY-EXTRACTED FIELDS (verified by the pipeline; cite with location: { "field": "<field>" }, no page):\n` +
      extractions
        .map((x) => `- ${x.field} = ${x.value}  [documentId: ${x.documentId} | file: ${x.filename}]`)
        .join("\n")
    : "";

  return `These passages were retrieved from the customer's own documents because they match the question. They are the only evidence you have.

PASSAGES:
${ev}${factsBlock}`;
}

/**
 * Token budget for the context block api/ask.js sends (passages +
 * already-extracted fields), independent of MAX_PASSAGES/MAX_EXCERPT's own
 * per-passage caps — those bound a single passage's size and count; this
 * bounds the whole block's cost regardless of how many passages retrieval
 * returned. ~6K tokens keeps a worst-case (12 full-length passages) call well
 * under half its context window while leaving room for the (uncapped)
 * extracted-fields block and the question.
 */
export const CONTEXT_TOKEN_BUDGET = 6000;

/**
 * Pure: what actually gets shown to the model for one question, chosen from
 * what retrieval returned.
 *
 * Two things happen, in order:
 *   1. Dedupe by (documentId, page) — retrieval can return the same page
 *      more than once (e.g. it matched on more than one search term), and a
 *      repeated passage is pure waste: same tokens, no new evidence.
 *   2. Keep passages, IN THE ORDER GIVEN (assumed already rank-sorted by the
 *      caller — see db.searchPassages), until the next one would push the
 *      cumulative excerpt text over `maxTokens`. Always keeps at least the
 *      first passage even if it alone exceeds the budget, so a single large
 *      match is never dropped to zero context.
 *
 * @param {{documentId: string, page?: number, excerpt?: string}[]} passages
 */
export function selectPassagesForContext(passages, maxTokens = CONTEXT_TOKEN_BUDGET) {
  const seen = new Set();
  const deduped = [];
  for (const p of passages ?? []) {
    if (!p || typeof p.documentId !== 'string') continue;
    const key = `${p.documentId}\u0000${p.page ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(p);
  }

  const kept = [];
  let used = 0;
  for (const p of deduped) {
    const cost = estimateTokens(p.excerpt ?? '');
    if (kept.length && used + cost > maxTokens) break;
    kept.push(p);
    used += cost;
  }
  return kept;
}

export function buildQuestionBlock({ question, today }) {
  return `Today's date: ${today}

QUESTION: ${question}`;
}

export function buildPrompt({ question, today, passages, extractions }) {
  const ev =
    (passages ?? [])
      .map(
        (p, i) =>
          `[${i + 1}] documentId: ${p.documentId} | page: ${p.page} | file: ${p.filename}${
            p.documentType ? ` (${p.documentType})` : ""
          }\n${p.excerpt}`
      )
      .join("\n\n") || "(no passages matched)";

  const factsBlock = extractions?.length
    ? `\n\nALREADY-EXTRACTED FIELDS (verified by the pipeline; cite with location: { "field": "<field>" }, no page):\n` +
      extractions
        .map((x) => `- ${x.field} = ${x.value}  [documentId: ${x.documentId} | file: ${x.filename}]`)
        .join("\n")
    : "";

  return `Today's date: ${today}

These passages were retrieved from the customer's own documents because they match the question. They are the only evidence you have.

PASSAGES:
${ev}${factsBlock}

QUESTION: ${question}

${RULES}`;
}

/**
 * What retrieval actually returned, structured for citation-checking: which
 * documents are in play, and — per document — which pages and which
 * already-extracted field names were shown to the model. Built from the same
 * rows handed to buildPrompt, never from anything a client supplied.
 */
export function buildAllowed({ passages = [], extractions = [] } = {}) {
  const docs = new Set();
  const pages = new Map(); // documentId -> Set<page number>
  const fields = new Map(); // documentId -> Set<field name>
  // documentId -> that document's pipeline stage ('received'/.../'verified'),
  // as recordsStore.js's searchPassages/searchExtractions now return it
  // (H4, 2026-09-19 adversarial audit) — see shapeAnswer's verifiedCount/
  // unverifiedCount below, the only consumer of this map.
  const stageByDoc = new Map();

  for (const p of passages ?? []) {
    if (!p || typeof p.documentId !== "string") continue;
    docs.add(p.documentId);
    if (typeof p.page === "number") {
      if (!pages.has(p.documentId)) pages.set(p.documentId, new Set());
      pages.get(p.documentId).add(p.page);
    }
    if (typeof p.stage === "string" && !stageByDoc.has(p.documentId)) stageByDoc.set(p.documentId, p.stage);
  }
  for (const x of extractions ?? []) {
    if (!x || typeof x.documentId !== "string") continue;
    docs.add(x.documentId);
    if (typeof x.field === "string" && x.field) {
      if (!fields.has(x.documentId)) fields.set(x.documentId, new Set());
      fields.get(x.documentId).add(x.field);
    }
    if (typeof x.stage === "string" && !stageByDoc.has(x.documentId)) stageByDoc.set(x.documentId, x.stage);
  }
  return { docs, pages, fields, stageByDoc };
}

/** Does this one source cite a specific, real piece of evidence? */
function sourceIsGrounded(s, allowed, isComputed) {
  if (!s || typeof s.documentId !== "string" || !allowed.docs.has(s.documentId)) return false;
  // A derived value has no page behind it by definition — but only when the
  // caller has actually vouched for computed evidence; see file header.
  if (isComputed) return true;
  const loc = s.location && typeof s.location === "object" ? s.location : {};
  if (typeof loc.page === "number" && allowed.pages.get(s.documentId)?.has(loc.page)) return true;
  if (typeof loc.field === "string" && loc.field && allowed.fields.get(s.documentId)?.has(loc.field)) return true;
  return false;
}

/**
 * @param raw     the model's raw tool_use input — untrusted.
 * @param allowed {docs, pages, fields} from buildAllowed(): what retrieval
 *                actually returned for THIS question.
 * @param opts.allowComputed  Only a caller that supplies real computed
 *                evidence should pass true. /api/ask does not, so a fact
 *                claiming basis "computed" is corrected back to "printed" and
 *                held to the normal page/field check rather than exempted
 *                from it.
 */
/** Forced when nothing survived citation-checking. Never the model's own words
 *  — see the "text is not citation-checked" note below for why. */
export const NO_ANSWER_TEXT = "Nothing in your records answers that.";

/**
 * @param opts.candidates  What retrieval returned (mapped passages/extractions,
 *                see api/ask.js), used ONLY to build `closest` when every fact
 *                gets dropped — never to source a fact. Each needs a
 *                `documentId`; deduplicated and capped.
 */
export function shapeAnswer(raw, allowed, { allowComputed = false, candidates = [] } = {}) {
  const safeAllowed = allowed ?? buildAllowed();
  const input = raw && typeof raw === "object" ? raw : {};

  const facts = (Array.isArray(input.facts) ? input.facts : [])
    .filter((f) => f && typeof f === "object" && typeof f.label === "string" && typeof f.value === "string")
    .map((f) => {
      const basis = allowComputed && f.basis === "computed" ? "computed" : "printed";
      const sources = (Array.isArray(f.sources) ? f.sources : []).filter((s) =>
        sourceIsGrounded(s, safeAllowed, basis === "computed")
      );
      return { ...f, basis, sources };
    })
    .filter((f) => f.sources.length > 0);

  const rawText = typeof input.text === "string" ? input.text : "";

  // THE 2026-09-19 BUG: `text` is free prose the model writes, and unlike
  // `facts`/`sources` above it was never citation-checked — a model can lose
  // every fact to sourceIsGrounded() above (nothing it cited maps to real
  // retrieval) and still have written a confident, detailed narrative into
  // `text` itself ("Show me everything on Plaza Dental" came back with a full
  // narrative and dollar figures while facts/sources were empty). Once
  // facts.length is 0 there is nothing left in this answer that was actually
  // grounded, so the model's own words must never reach the user — only this
  // fixed, honest string does, regardless of what `rawText` says.
  const text = facts.length ? rawText : NO_ANSWER_TEXT;

  // Downgraded to no-answer: tell the user what retrieval DID find instead of
  // leaving "closest documents" permanently empty. Built only from what
  // retrieval actually returned (`candidates`), never from the model.
  const closest = facts.length
    ? []
    : [...new Map(
        (candidates ?? [])
          .filter((c) => c && typeof c.documentId === "string")
          .map((c) => [c.documentId, c])
      ).values()]
        .slice(0, 8)
        .map((c) => ({ documentId: c.documentId, location: {} }));

  // H4 (2026-09-19 adversarial audit): verifiedCount used to mean "number of
  // distinct cited documents" and unverifiedCount was hardcoded to 0 — so a
  // UI trusting these fields to communicate confidence was told every answer
  // is 100% verified, always, regardless of whether the underlying documents
  // had ever been through AI or human verification (stage === 'verified').
  // Computed here from the ACTUALLY-CITED documents' real stage, not from
  // retrieval's whole candidate set — a document that was merely retrieved
  // but cited by nothing surviving shapeAnswer's grounding check should not
  // count either way.
  const citedDocIds = new Set(facts.flatMap((f) => f.sources.map((s) => s.documentId)));
  const verifiedCount = [...citedDocIds].filter((id) => safeAllowed.stageByDoc?.get(id) === "verified").length;
  const unverifiedCount = citedDocIds.size - verifiedCount;

  return {
    kind: facts.length ? "answer" : "no-answer",
    text,
    facts,
    sources: facts.flatMap((f) => f.sources),
    // Clamped, because ANSWER_TOOL declares confidence as a bare number with no
    // minimum or maximum — a model returning 5 passes schema validation, and
    // the client's `?? 0.8` fallback does not catch an out-of-range number
    // either. The type says 0–1; this makes that true.
    confidence: facts.length
      ? Math.max(0, Math.min(1, Number.isFinite(input.confidence) ? input.confidence : 0.8))
      : 0,
    entityId: typeof input.entityId === "string" ? input.entityId : undefined,
    interpretation: typeof input.interpretation === "string" ? input.interpretation : undefined,
    verifiedCount,
    unverifiedCount,
    closest,
  };
}
