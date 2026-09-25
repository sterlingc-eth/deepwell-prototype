/**
 * Donovan research agent (v2) — the verify step (build spec item 3, 2026-09-25).
 *
 * shape.js already refuses to let a fact through unless its citation is one the tools actually
 * returned (buildAllowed/shapeAnswer) and its numbers/names appear SOMEWHERE in the run's evidence
 * corpus (ledger.corpus — every tool result concatenated). That is a real guard, but it is corpus-wide:
 * a fact citing document A, page 3 passes as long as its value appears ANYWHERE the model was shown,
 * including a different document entirely. This step is narrower and runs AFTER shape.js: for every
 * fact with a document+page or document+field citation, it re-reads THAT EXACT page/field from the
 * database (a cheap, indexed lookup — no model call) and checks the fact's value against THAT text
 * alone. A fact whose cited source does not actually say what the fact claims is dropped.
 *
 * This is the "cheap Haiku (or rule) pass" the build spec asks for, implemented as a rule (regex token/
 * phrase match, same technique shape.js already uses) rather than a second model call: it is exact,
 * free, and instant, and a real model call here would itself need grounding against something — the
 * page text is that something, so checking against it directly is strictly better than paying for an
 * LLM to do the same regex-shaped judgement less reliably. DONOVAN_VERIFY_MODEL is read for a future
 * model-backed pass but unused today (kept as a documented extension point, not a half-built feature).
 *
 * Never throws: a verify failure (DB error) is treated as "could not confirm" and the fact is kept
 * as shape.js already decided, so a transient DB hiccup degrades to today's behavior, never to a worse
 * one — the ledger check is a tightening, not a new trust boundary shape.js doesn't already have.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function digitTokens(s) {
  return (String(s).toLowerCase().match(/[a-z0-9$#][a-z0-9$#.,:/-]*/g) ?? [])
    .map((tok) => tok.replace(/[.,:/-]+$/, ""))
    .filter((tok) => /\d/.test(tok));
}

function wordTokens(s) {
  return (String(s).toLowerCase().match(/[a-z]{4,}/g) ?? []);
}

/** Does `needle` (a digit-bearing token or a >=4-letter word) appear in `haystack` (already lowercased)? */
function tokenIn(haystack, needle) {
  const variants = new Set([needle, needle.replace(/,/g, ""), needle.replace(/^[$#]/, "")]);
  for (const v of variants) {
    if (!v) continue;
    const re = new RegExp(`(?<![a-z0-9])${escapeRe(v)}(?![a-z0-9])`);
    if (re.test(haystack)) return true;
  }
  return false;
}

/**
 * @param {{label:string, value:string, sources?: {documentId:string, location:{page?:number, field?:string}}[]}} fact
 * @param {(documentId:string, location:object) => Promise<string|null>} fetchSourceText  resolves the
 *   exact cited text (a page's transcript, or an extracted field's value), or null if it cannot be read.
 * @returns {Promise<boolean>} true if every one of the fact's sources supports the fact (or it has none
 *   to check — an aggregate/unsourced fact is out of scope for this step; shape.js already vetted it).
 */
async function factIsSupported(fact, fetchSourceText) {
  const sources = Array.isArray(fact.sources) ? fact.sources : [];
  if (!sources.length) return true;
  const needles = [...digitTokens(fact.value), ...wordTokens(fact.value)];
  if (!needles.length) return true; // nothing checkable (e.g. a bare status word already vetted by shape.js)
  for (const src of sources) {
    if (typeof src.documentId !== "string" || !UUID_RE.test(src.documentId)) continue;
    if (src.location?.field === "document") continue; // a whole-document citation has no one passage to check
    let text;
    try { text = await fetchSourceText(src.documentId, src.location ?? {}); } catch { text = null; }
    if (text == null) continue; // could not confirm -> not a reason to drop (fail open, see file header)
    const hay = text.toLowerCase();
    // At least one checkable token from the fact's value must actually be in THIS cited text — a fact
    // whose every number/word is absent from the page it claims to cite is the failure this step exists
    // to catch (the corpus-wide check in shape.js would have let it through if that token appeared
    // anywhere else in the run's evidence).
    if (!needles.some((n) => tokenIn(hay, n))) return false;
  }
  return true;
}

/**
 * @param {object} data  a shaped answer (shapeAgentAnswer's `.data`, kind 'answer')
 * @param {(documentId:string, location:object) => Promise<string|null>} fetchSourceText
 * @returns {Promise<{data: object, droppedCount: number, checkedCount: number}>}
 */
export async function verifyFacts(data, fetchSourceText) {
  if (!data || data.kind !== "answer" || !Array.isArray(data.facts) || !data.facts.length) {
    return { data, droppedCount: 0, checkedCount: 0 };
  }
  const kept = [];
  let droppedCount = 0;
  let checkedCount = 0;
  for (const f of data.facts) {
    if (Array.isArray(f.sources) && f.sources.length) checkedCount++;
    // eslint-disable-next-line no-await-in-loop -- sequential on purpose: this runs a handful of indexed
    // point lookups (bounded by MAX_FACTS=40), not a hot loop, and keeping it simple keeps it auditable.
    if (await factIsSupported(f, fetchSourceText)) kept.push(f);
    else droppedCount++;
  }
  if (!droppedCount) return { data, droppedCount: 0, checkedCount };
  const citedDocIds = new Set(kept.flatMap((f) => (f.sources ?? []).map((s) => s.documentId)));
  const verifiedCount = [...citedDocIds].filter((id) => (data.sourceStages ?? {})[id] === "verified").length;
  const next = {
    ...data,
    facts: kept,
    sources: kept.flatMap((f) => f.sources ?? []),
    verifiedCount: verifiedCount || Math.min(data.verifiedCount ?? 0, kept.length),
  };
  if (!kept.length) {
    return {
      data: { ...next, kind: "no-answer", text: "Nothing in your records could be confirmed for that.", facts: [], sources: [], confidence: 0, closest: data.closest ?? [] },
      droppedCount, checkedCount,
    };
  }
  next.text = `${String(next.text ?? "").replace(/[.\s]+$/, "")} (one or more claims could not be confirmed against the cited page and were left out).`;
  return { data: next, droppedCount, checkedCount };
}

/**
 * Builds `fetchSourceText` for verifyFacts against a live tenant DB: a page citation re-reads
 * document_pages.text for that exact (documentId, page); a field citation re-reads the extraction's
 * own (corrected) value for that exact (documentId, field_key). One tiny query per distinct source,
 * memoized within the call so a fact citing the same page twice costs one round trip.
 */
export function createDbSourceFetcher({ withTenant, ctxArg }) {
  const cache = new Map();
  return async function fetchSourceText(documentId, location) {
    const key = `${documentId}:${location?.page ?? ""}:${location?.field ?? ""}`;
    if (cache.has(key)) return cache.get(key);
    const p = (async () => {
      if (typeof location?.page === "number") {
        const { rows } = await withTenant(ctxArg, (db) => db.raw(
          `SELECT text FROM document_pages WHERE document_id = $1 AND page_no = $2 AND (current_setting('app.tenant_id', true))::uuid = tenant_id`,
          [documentId, location.page]
        ));
        return rows[0]?.text ?? null;
      }
      if (typeof location?.field === "string" && location.field) {
        const { rows } = await withTenant(ctxArg, (db) => db.raw(
          `SELECT COALESCE(NULLIF(corrected_value, ''), value) AS v FROM extractions
            WHERE document_id = $1 AND field_key = $2 AND (current_setting('app.tenant_id', true))::uuid = tenant_id
            ORDER BY created_at DESC LIMIT 1`,
          [documentId, location.field]
        ));
        return rows[0]?.v ?? null;
      }
      return null;
    })().catch(() => null);
    cache.set(key, p);
    return p;
  };
}
