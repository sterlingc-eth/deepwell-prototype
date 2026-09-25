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

/**
 * Perf pass (2026-09-25, ask-latency): field keys this step's own DB re-fetch (createDbSourceFetcher,
 * below — it only ever reads `extractions`) can NEVER see, because the tool that produced them computes
 * the value in application code rather than storing it as an extraction row:
 *   - warranty_status / warranty_expires / warranty_current / warranty_tier — the `equipment` view and
 *     get_unit's own profile (tools.js) compute these with analytics.js's warrantyStatusOf and
 *     warrantyRules.js's alertTier from the entity's `warranty` JSON; there is no extractions row for them.
 *   - total / subtotal / tax / amount_paid / balance_due / open_balance / days_past_due — the `financials`
 *     view (financeViews.js) reads a wholly separate table (document_financials /
 *     document_financial_lines), never `extractions`.
 * A fact citing one of these fields would ALWAYS get `text == null` back from fetchOne below and therefore
 * ALWAYS fail open (kept — see the file header), every single time, for every tenant: checking it can
 * never drop the fact, so the round trip cannot change the answer. Skipping it here (and out of
 * .prefetch()'s batch) is a pure latency win, not a new trust boundary — a real corrupted warranty/
 * financial fact is still caught by shape.js's corpus-wide check and by the SQL views themselves (they
 * ARE the source of truth for these fields; nothing here weakens that).
 */
export const DETERMINISTIC_FIELD_KEYS = new Set([
  "warranty_status", "warranty_expires", "warranty_current", "warranty_tier",
  "total", "subtotal", "tax", "amount_paid", "balance_due", "open_balance", "days_past_due",
]);

function isDeterministicField(location) {
  return typeof location?.field === "string" && DETERMINISTIC_FIELD_KEYS.has(location.field);
}

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
 * @param {{skipped: number}} [counters]  bumped once per source skipped as a deterministic/computed field
 *   (see DETERMINISTIC_FIELD_KEYS above) — a diagnostic count only, never affects the boolean result.
 * @returns {Promise<boolean>} true if every one of the fact's sources supports the fact (or it has none
 *   to check — an aggregate/unsourced fact is out of scope for this step; shape.js already vetted it).
 */
async function factIsSupported(fact, fetchSourceText, counters) {
  const sources = Array.isArray(fact.sources) ? fact.sources : [];
  if (!sources.length) return true;
  const needles = [...digitTokens(fact.value), ...wordTokens(fact.value)];
  if (!needles.length) return true; // nothing checkable (e.g. a bare status word already vetted by shape.js)
  for (const src of sources) {
    if (typeof src.documentId !== "string" || !UUID_RE.test(src.documentId)) continue;
    if (src.location?.field === "document") continue; // a whole-document citation has no one passage to check
    if (isDeterministicField(src.location)) { if (counters) counters.skipped++; continue; } // always fails open anyway — see above
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
 * @returns {Promise<{data: object, droppedCount: number, checkedCount: number, skippedCount: number}>}
 *   skippedCount: sources skipped because they cite a DETERMINISTIC_FIELD_KEYS field (a diagnostic count —
 *   see that constant's own doc comment for why skipping them never changes the result).
 */
export async function verifyFacts(data, fetchSourceText) {
  if (!data || data.kind !== "answer" || !Array.isArray(data.facts) || !data.facts.length) {
    return { data, droppedCount: 0, checkedCount: 0, skippedCount: 0 };
  }
  const allSources = data.facts.flatMap((f) => (Array.isArray(f.sources) ? f.sources : []));
  // Perf (2026-09-25, ask-latency pass): batch every citation this answer needs into ONE round trip
  // before checking any of them, instead of letting the per-fact loop below fault each one in on its
  // own withTenant transaction (see createDbSourceFetcher's own doc comment for why that's expensive).
  // Optional — a fetchSourceText with no .prefetch (e.g. a test double) just runs the loop as before.
  // Deterministic-field sources are left out of the batch too: they are never looked up at all (below),
  // so there is nothing for the batch to usefully fetch for them.
  if (typeof fetchSourceText.prefetch === "function") {
    await fetchSourceText.prefetch(allSources.filter((s) => !isDeterministicField(s?.location)));
  }
  const kept = [];
  let droppedCount = 0;
  let checkedCount = 0;
  const counters = { skipped: 0 };
  for (const f of data.facts) {
    if (Array.isArray(f.sources) && f.sources.length) checkedCount++;
    // eslint-disable-next-line no-await-in-loop -- sequential on purpose: this runs a handful of indexed
    // point lookups (bounded by MAX_FACTS=40), not a hot loop, and keeping it simple keeps it auditable.
    if (await factIsSupported(f, fetchSourceText, counters)) kept.push(f);
    else droppedCount++;
  }
  if (!droppedCount) return { data, droppedCount: 0, checkedCount, skippedCount: counters.skipped };
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
      droppedCount, checkedCount, skippedCount: counters.skipped,
    };
  }
  next.text = `${String(next.text ?? "").replace(/[.\s]+$/, "")} (one or more claims could not be confirmed against the cited page and were left out).`;
  return { data: next, droppedCount, checkedCount, skippedCount: counters.skipped };
}

/**
 * Builds `fetchSourceText` for verifyFacts against a live tenant DB: a page citation re-reads
 * document_pages.text for that exact (documentId, page); a field citation re-reads the extraction's
 * own (corrected) value for that exact (documentId, field_key). Memoized within the call so a fact
 * citing the same page twice costs one round trip.
 *
 * Perf (2026-09-25, ask-latency pass): the returned function also carries a `.prefetch(sources)`
 * method — verifyFacts calls it once, up front, with every source across the whole answer. It batches
 * every DISTINCT (documentId, page) into one query and every DISTINCT (documentId, field) into another,
 * both inside a SINGLE withTenant transaction, instead of the naive per-source shape below (one
 * withTenant — connect + BEGIN + resolve_tenant + SET LOCAL + COMMIT, four round trips — PER cited
 * fact, run strictly sequentially: an answer with 20 citations used to cost up to 80 round trips just
 * to verify them). `fetchSourceText` itself is unchanged and still works standalone (a cache miss after
 * prefetch, or a caller that never calls prefetch at all, just falls back to its own single-source
 * query) — prefetch is purely an optimization, never a correctness dependency.
 */
export function createDbSourceFetcher({ withTenant, ctxArg }) {
  const cache = new Map();

  async function fetchOne(documentId, location) {
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
  }

  const fetchSourceText = function fetchSourceText(documentId, location) {
    const key = `${documentId}:${location?.page ?? ""}:${location?.field ?? ""}`;
    if (cache.has(key)) return cache.get(key);
    const p = fetchOne(documentId, location).catch(() => null);
    cache.set(key, p);
    return p;
  };

  fetchSourceText.prefetch = async function prefetch(sources) {
    const pagePairs = [];
    const fieldPairs = [];
    const seen = new Set();
    for (const src of sources ?? []) {
      const documentId = src?.documentId;
      const location = src?.location ?? {};
      if (typeof documentId !== "string") continue;
      if (typeof location.page === "number") {
        const key = `${documentId}:${location.page}:`;
        if (cache.has(key) || seen.has(key)) continue;
        seen.add(key);
        pagePairs.push({ key, documentId, page: location.page });
      } else if (typeof location.field === "string" && location.field) {
        const key = `${documentId}::${location.field}`;
        if (cache.has(key) || seen.has(key)) continue;
        seen.add(key);
        fieldPairs.push({ key, documentId, field: location.field });
      }
    }
    if (!pagePairs.length && !fieldPairs.length) return;

    const found = new Map(); // key -> text|null, from whichever rows actually matched below
    try {
      await withTenant(ctxArg, async (db) => {
        const [pageRows, fieldRows] = await Promise.all([
          pagePairs.length
            ? db.raw(
                `SELECT dp.document_id, dp.page_no, dp.text
                   FROM document_pages dp
                   JOIN (SELECT * FROM unnest($1::uuid[], $2::int[]) AS t(document_id, page_no)) t
                     ON dp.document_id = t.document_id AND dp.page_no = t.page_no
                  WHERE (current_setting('app.tenant_id', true))::uuid = dp.tenant_id`,
                [pagePairs.map((p) => p.documentId), pagePairs.map((p) => p.page)]
              )
            : { rows: [] },
          fieldPairs.length
            ? db.raw(
                `SELECT DISTINCT ON (e.document_id, e.field_key) e.document_id, e.field_key,
                        COALESCE(NULLIF(e.corrected_value, ''), e.value) AS v
                   FROM extractions e
                   JOIN (SELECT * FROM unnest($1::uuid[], $2::text[]) AS t(document_id, field_key)) t
                     ON e.document_id = t.document_id AND e.field_key = t.field_key
                  WHERE (current_setting('app.tenant_id', true))::uuid = e.tenant_id
                  ORDER BY e.document_id, e.field_key, e.created_at DESC`,
                [fieldPairs.map((f) => f.documentId), fieldPairs.map((f) => f.field)]
              )
            : { rows: [] },
        ]);
        for (const r of pageRows.rows) found.set(`${r.document_id}:${r.page_no}:`, r.text ?? null);
        for (const r of fieldRows.rows) found.set(`${r.document_id}::${r.field_key}`, r.v ?? null);
      });
    } catch {
      // Fail open (see file header): leave these keys uncached so fetchSourceText's own per-source
      // fallback runs for them individually (and itself fails open the same way on error).
      return;
    }
    for (const { key } of pagePairs) cache.set(key, Promise.resolve(found.has(key) ? found.get(key) : null));
    for (const { key } of fieldPairs) cache.set(key, Promise.resolve(found.has(key) ? found.get(key) : null));
  };

  return fetchSourceText;
}
