/**
 * Donovan analytics executor: the Haiku planner call, the parameterized DB
 * reads it drives, and the deterministic answer built from what came back.
 * The pure classifier/schema/geo/formatting logic all lives in
 * api/_lib/analytics.js (no `db`, no Anthropic client) so it's testable with
 * no database or network — see scripts/verify-analytics.mjs. This file is the
 * impure half: it's the only place in the analytics path that touches
 * Postgres or calls Anthropic.
 *
 * Wired into api/ask.js AFTER the meta-router and fast path, BEFORE
 * retrieval — see handoffs/DONOVAN_ANALYTICS_A_2026-09-21.md.
 */
import Anthropic from '@anthropic-ai/sdk';
import { getApiKey, MODEL_TIMEOUT_MS, withBackoff } from '../claude.js';
// ROUND 20 (J4, credit-return readiness) — both added ONLY for planAnalyticsQuestion's own model-call
// section below (J4's ownership within this file); nothing else in this file uses either import.
// planCacheBreakpoints: prompt-cache the (large, stable) system prompt + tool schema the same way
// agent/loopV2.js already does — see that file's own use for the pattern this mirrors.
import { planCacheBreakpoints } from '../promptCache.js';
// validateModelPlan: rejects a MODEL-produced plan (never the deterministic one just above it) that
// drops a stated condition, invents a filter the question never named, or names an entity id outside
// the tenant — see planner/validate.js's own doc comment for why this is stricter than, and separate
// from, this file's own downstream missingConditions/override machinery.
import { validateModelPlan } from '../planner/validate.js';
// assertDailySpend/recordDailySpend/routeCostReport: a per-tenant daily $ cap and a $/question log
// line for this route, layered on top of (never instead of) ask.js's own assertModelBudget call-count
// cap — see planner/spend.js's own doc comment. `withTenant`/`ctxArg` are OPTIONAL, new parameters on
// planAnalyticsQuestion below (see its own doc comment): runAnalyticsQuestion's call site does not pass
// them yet, so today this fails open exactly as if this file were unchanged — see
// handoffs/CREDIT_RETURN_PLAYBOOK.md for the one-line hook that turns the cap on.
import { assertDailySpend, recordDailySpend, routeCostReport } from '../planner/spend.js';
import { getCacheEntry, isCacheHit } from '../askCache.js';
import { documentTypeLabel } from '../documentTypes.js';
import {
  ANALYTICS_TOOL,
  buildAnalyticsSystemPrompt,
  ANALYTICS_PROMPT_VERSION,
  analyticsQuestionHash,
  analyticsPlanHash,
  suspiciousUnfilteredCustomerPlan,
  reconcileTimeRange,
  resolveServiceVisitsOverride,
  resolveAgeFilter,
  resolveAnyTimeRange,
  withinTimeRange,
  monthRangeLabel,
  missingConditions,
  detectedConditions,
  unsupportedConditionAnswer,
  buildConditionOverrideFilter,
  parseCrossDocCondition,
  crossDocUnsupportedAnswer,
  moneyFallbackAnswer,
  mentionsFutureYear,
  futureDateAnswer,
  isExistenceQuestion,
  existenceWrap,
  CONDITION_CROSS_VISIT_RELATION,
  CONDITION_UNTRACKED_CALLBACK,
  CONDITION_RATIO,
  DOC_TYPE_FILTER_FIELDS,
  SERVICE_TYPE_FILTER_FIELDS,
  SERVICE_TYPE_PHRASE_RE,
  serviceTypeValueOf,
  validatePlan,
  deriveGeo,
  normalizeStateValue,
  matchesAllFilters,
  buildAnalyticsSQL,
  groupRows,
  formatAnalyticsAnswer,
  brandMatches,
  installYearOf,
  warrantyStatusOf,
  UNKNOWN_BUCKET,
  TOP_CUSTOMERS_LIMIT,
  INSTALL_DATE_EXTREME_LIMIT,
  WARRANTY_REG_DATE_SORT_FIELDS,
  GROUP_LABEL,
  isTeamScopedQuestion,
} from '../analytics.js';
import { normalizeQuestion } from '../nlNormalize.js';
import { detectCountComparison } from '../analytics/comparison.js';
// R19 (I2, task 5): team-only (internal) documents never count toward a customer-scoped analytics
// answer — same fragment/probe search/store.js and search/knowledge.js already adopt.
import { documentsHaveAudience } from '../audience/probe.js';
import { audienceFilterSql } from '../audience/sql.js';
// Round 11 (literature #6/#7): per-tenant vocabulary schema-linking for the planner prompt (above).
import { schemaLinkedVocabLines } from '../vocab/tenantVocab.js';
// TEAM C (citations everywhere): records/basis come from the SAME rows the number was computed from.
import { withAnalyticsCitations } from '../citations/analytics.js';
import { canonicalBrandLabel } from '../analytics/brandCanon.js';
// g133/g138 (oldest/newest install): its own citation build, not withAnalyticsCitations'
// (that helper's sortBy wording is customers-ranking-specific — see citations/analytics.js's
// own analyticsBasis) — attachCitations/unitRecord are the same generic, pure primitives
// compose.js already reuses the same way, just called directly here instead.
import { attachCitations, unitRecord, customerRecord, documentRecord } from '../citations/records.js';
// Team A (2026-09-24): time semantics (uploaded vs service date) and future-dated service records.
import { dateBasisOf, todayIso, splitFuture, isVisitType } from '../scope.js';
// Tier 2 learning loop, Part A (handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md):
// overlayFewShotHash mixes the active overlay's few-shot items into this
// file's own analytics cache promptVersion (see runAnalyticsQuestion below)
// so approving a new example invalidates every previously-cached plan.
import { overlayFewShotHash } from '../learning/overlay.js';
// Round 14 (K3): the deterministic planner tried BEFORE ever spending a
// model call — see planAnalyticsQuestion below and detPlan.js's own doc
// comment for the "never guess" contract.
import { detectAnalyticsPlan } from '../analytics/detPlan.js';

export const ANALYTICS_MODEL = process.env.ANALYTICS_MODEL || process.env.ASK_MODEL || 'claude-haiku-4-5';
export function isAnalyticsEnabled(env = process.env) {
  return env?.ASK_ANALYTICS !== '0';
}

/**
 * The one Haiku tool-use call this feature makes. Returns a VALIDATED plan
 * (never raw model output) or null — a schema violation, a timeout, or any
 * Anthropic error all fall through to null, which api/ask.js treats exactly
 * like a fast-path miss: run retrieval+model instead. `max_tokens` is small
 * (a plan is a handful of enum strings) — see the brief's cost note.
 *
 * ROUND 20 (J4): `withTenant`/`ctxArg` are NEW, OPTIONAL parameters — runAnalyticsQuestion's own call
 * site (just below, outside this function's model-call section) does not pass them yet, so omitting
 * them leaves every existing caller's behavior byte-identical to before this round: the per-tenant $
 * cap check (assertDailySpend, planner/spend.js) fails open with no tenant context to check against,
 * same as every other budget read in this codebase. See handoffs/CREDIT_RETURN_PLAYBOOK.md for the
 * one-line hook that threads the tenant context through once credits are back and this is worth turning
 * on live.
 */
export async function planAnalyticsQuestion(question, { today, overlay, tenantVocab, withTenant, ctxArg } = {}) {
  try {
    // Round 14 (K3): try the deterministic planner FIRST — no model call, no
    // I/O, no cost. Its result (the same {entity, op, groupBy?, filters?,
    // sortBy?} shape a tool_use `input` has) is fed through the EXACT SAME
    // post-processing a model plan gets below; the model is only ever
    // called when detectAnalyticsPlan returns null (an unrecognized shape —
    // see that file's own "never guess" doc comment).
    let rawInput = detectAnalyticsPlan(question, tenantVocab, today);
    if (!rawInput) {
      // ROUND 20 (J4), task 2: per-tenant daily $ cap for this route, on top of (never instead of)
      // ask.js's own call-count assertModelBudget. Throws ModelBudgetExceededError when exceeded,
      // caught by this function's own outer try/catch below exactly like any other planner failure —
      // this function's contract ("never throws, returns null") is unchanged.
      await assertDailySpend(withTenant, ctxArg, 'analyticsPlanner');
      const client = new Anthropic({ apiKey: getApiKey(), timeout: MODEL_TIMEOUT_MS, maxRetries: 0 });
      const deadlineAt = Date.now() + MODEL_TIMEOUT_MS;
      // Tier 2 learning (Part A): the active overlay's approved few-shot
      // examples, appended after the curated ANALYTICS_FEW_SHOT_BLOCK — see
      // buildAnalyticsSystemPrompt's own doc comment for the 12-item/500-token
      // cap. No overlay (or none with few-shot items) returns the exact same
      // ANALYTICS_SYSTEM_PROMPT constant as before this existed.
      // Round 11 (literature #6, schema linking): `tenantVocab` (vocab/tenantVocab.js's getTenantVocab),
      // when present, contributes a short, question-relevant subset of this tenant's own brand/document-
      // type/city vocabulary — omitted (no tenantVocab, or none of it matches this question) leaves the
      // prompt byte-identical to before this existed.
      const systemPrompt = buildAnalyticsSystemPrompt({ extraFewShot: overlay?.fewShot, vocabLines: schemaLinkedVocabLines(question, tenantVocab) });
      // ROUND 20 (J4), task 2: prompt-cache the system prompt + tool schema — both are large (the base
      // prompt, every few-shot example, the full field vocabulary) and IDENTICAL on every call for a
      // given overlay/tenantVocab combination, the same "big, stable system prompt" shape agent/
      // loopV2.js already caches. The per-question `messages` block (the actual question text) is never
      // a breakpoint — it changes every call, so caching it would only spend a breakpoint for zero
      // reuse. See promptCache.js's own cacheable()/minTokensFor(): a breakpoint is only actually
      // attached once the cumulative prefix clears Haiku's real minimum, so this is a no-op (byte-
      // identical request) until the prompt is long enough for Anthropic to honor it anyway.
      const { tools, system } = planCacheBreakpoints(
        {
          tools: [{ block: ANALYTICS_TOOL, breakpoint: true }],
          system: [{ block: { type: 'text', text: systemPrompt }, breakpoint: true }],
        },
        ANALYTICS_MODEL
      );
      const response = await withBackoff(
        () =>
          client.messages.create(
            {
              model: ANALYTICS_MODEL,
              max_tokens: 400,
              temperature: 0,
              system,
              tools,
              tool_choice: { type: 'tool', name: 'analytics_plan' },
              messages: [{ role: 'user', content: `Today's date: ${today}\n\nQUESTION: ${question}` }],
            },
            { timeout: Math.max(1000, deadlineAt - Date.now()) }
          ),
        { deadlineAt }
      );
      // ROUND 20 (J4), task 2: "report estimated $/question by route" — one small, structured log
      // line (no question text, no plan values), and the SAME figure recorded against this tenant's
      // daily $ ledger (recordDailySpend/assertDailySpend share one bucket — see planner/spend.js).
      const usage = response.usage ?? {};
      const costReport = routeCostReport({
        route: 'analytics-planner',
        model: ANALYTICS_MODEL,
        usage: {
          inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
          cacheReadInputTokens: usage.cache_read_input_tokens, cacheCreationInputTokens: usage.cache_creation_input_tokens,
        },
      });
      console.log(JSON.stringify(costReport));
      if (costReport.cost_usd > 0) await recordDailySpend(withTenant, ctxArg, 'analyticsPlanner', costReport.cost_usd);
      const toolUse = response.content.find((b) => b.type === 'tool_use');
      rawInput = toolUse?.input;
      // ROUND 20 (J4), task 1: reject a MODEL plan (never the deterministic one above — that's pure
      // code, already trusted) that drops a condition the question named, invents a filter value the
      // question never said, or names an entity id outside this tenant. See planner/validate.js.
      if (rawInput) {
        const guard = validateModelPlan(rawInput, question, { tenantVocab });
        if (!guard.ok) {
          console.error('Analytics planner: model plan rejected by guard, falling through:', guard.reason);
          rawInput = null;
        }
      }
    }
    // Live miss (2026-09-21, "which units had service this month"): a
    // "<units/equipment/customers> <had/got/were> service(d)" / "<did/do> we
    // service" / "service call(s)" shape forces entity 'serviceVisits' and a
    // deterministic op, exactly like reconcileTimeRange below forces
    // timeRange — see resolveServiceVisitsOverride's own doc comment for why
    // this can never depend on the model choosing the entity correctly.
    // Filters are dropped when this fires: none of the known phrasings need
    // one, and a stray model filter for the WRONG entity (customers/
    // equipment) would otherwise reject the whole plan downstream.
    const serviceVisitsOverride = resolveServiceVisitsOverride(question);
    // R32: the override used to drop EVERY filter, silently turning "how many repair/PM visits in the last 90 days" into the
    // untyped visit count. A service-type qualifier the question names is a real filter on a visit (hasServiceType) and is kept.
    // Only for a plain count/existence question: a negated or "which/who" question ("which technicians have never logged a
    // PM visit") is a different relation, and a count would answer it wrongly, so it is left to fail closed as before.
    const visitTypeQ = String(question ?? '');
    const visitTypePhrase = serviceVisitsOverride && serviceVisitsOverride.op === 'count'
      && !/\b(?:never|without|no|not|none|haven'?t|hasn'?t|didn'?t|which|who|whose|each|every|per|by)\b/i.test(visitTypeQ)
      ? visitTypeQ.match(SERVICE_TYPE_PHRASE_RE) : null;
    const base = serviceVisitsOverride
      ? { ...(rawInput ?? {}), ...serviceVisitsOverride, filters: visitTypePhrase ? [{ field: 'hasServiceType', op: 'eq', value: serviceTypeValueOf(visitTypePhrase[1]) }] : [] }
      : rawInput;
    // Item 1 (2026-09-21 live miss) + round 5 item 2: a literal month name/
    // "this month"/"last month" phrase in the QUESTION overrides whatever
    // timeRange the model filled in, computed deterministically from `today`
    // — UNLESS the model's own timeRange is well-formed and names a year the
    // question itself actually wrote out (reconcileTimeRange, analytics.js) —
    // see that function's own doc comment for why the model's date math is
    // not trusted by default, and when it is trusted anyway.
    let input = base ? { ...base, timeRange: reconcileTimeRange(base.timeRange, question, today) } : base;
    // D4: the year in "which agreements expire in 2026" is the END year (agreementEnd), never a service-date window on the document.
    if (input?.filters?.some((f) => f?.field === 'agreementEnd')) input = { ...input, timeRange: undefined };
    // R32: a typed visit filter is only trustworthy on a plain count/existence question; a negated or "which/who/each" question
    // is a different relation (which technicians NEVER logged a PM visit) that a positive typed count would answer wrongly.
    if (input?.entity === 'serviceVisits' && input.filters?.some((f) => f.field === 'hasServiceType' || f.field === 'lacksServiceType')
      && (input.op !== 'count' || /\b(?:never|without|no|not|none|haven'?t|hasn'?t|didn'?t|which|who|whose|each|every|per|by)\b/i.test(String(question ?? '')))) {
      input = null;
    }
    // Team A (2026-09-24): "older/newer than N years" is year arithmetic done in code, not by the model; and a documents
    // time window is decided by the wording - "added/uploaded/received/scanned/filed" -> upload date (created_at),
    // "serviced/visited/job/work done" -> service date. Both override whatever the model guessed.
    if (input) {
      const age = resolveAgeFilter(question, today);
      // R21 M2 (Cluster 3, j144 "between X and Y years old"): resolveAgeFilter now returns an ARRAY
      // of two filters for the between-shape (a single age direction still returns one plain filter
      // object, unchanged) — spread either shape the same way; installDate replaces installYear as
      // the age filter's field (day-precise, see resolveAgeFilter's own doc comment), so any stray
      // installYear the model guessed is stripped here too, never left to double up with the real one.
      if (age) {
        const ageFilters = Array.isArray(age) ? age : [age];
        input = { ...input, filters: [...(input.filters ?? []).filter((f) => f?.field !== 'installYear' && f?.field !== 'installDate'), ...ageFilters] };
      }
      const basis = dateBasisOf(question);
      if (input.entity === 'documents' && basis) input = { ...input, dateBasis: basis };
    }
    return validatePlan(input);
  } catch (err) {
    console.error('Analytics planner failed, falling through:', err?.message);
    return null;
  }
}

/* ============================================================ row shaping
 * Each entity's fetched rows get one extra pass here that attaches the
 * derived/computed fields (geo, brand-normalized, warranty tier, install
 * year) the closed vocabulary promises, before matchesAllFilters/groupRows
 * (both pure, in analytics.js) ever see them.
 */

// Reviewer NO-GO (2026-09-21, round 2, gap 2): `value` used to be the full
// service_address, which read fine at a 12-row cap but got noisy once the
// list cap rose to 50 (MAX_FACT_ROWS, analytics.js) — "compact one-line rows
// (name · city)" is the requested shape, so a plain customer-list row shows
// just the city here (still the full address on the row itself in the app
// once opened via entityId).
// Round 15 (A): a plain boolean column that arrived from `EXISTS (...)`
// (has_any_document, has_customer_link) — pg/PGlite both hand this back as a
// real JS boolean, but 't'/'f' is tolerated too (defense in depth, same
// reason matchesFilter's own hasEmail/hasPhone check never trusts a driver's
// exact type).
function pgBool(v) {
  return v === true || v === 't';
}

// Round 15 (A): non-blank presence of a raw column value — the same
// "has this field been recorded at all" check every hasSerial/hasModel/
// hasTonnage/hasInstallDate/hasServiceAddress/hasServiceDate data-quality
// filter needs, computed once here rather than four times inline below.
function present(v) {
  return v != null && String(v).trim() !== '';
}

/** The END date (YYYY-MM-DD) of an agreement term string - the last date printed in it ("01/01/2025 - 12/31/2026" -> 2026-12-31). A term that only
 *  prints years ("2025 - 2026") ends on 12/31 of the last year; null when no date or year is printed. */
function agreementEndOf(term) {
  const t = String(term ?? '');
  const dates = [];
  for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) dates.push({ i: m.index, iso: `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}` });
  for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) dates.push({ i: m.index, iso: m[0] });
  if (dates.length) return dates.sort((a, b) => a.i - b.i)[dates.length - 1].iso;
  const years = t.match(/\b(?:19|20|21)\d{2}\b/g);
  return years?.length ? `${years[years.length - 1]}-12-31` : null;
}

/** D14: unit fields that are only filled in for some units (nameplate / startup-sheet / registration data) - filter field, entity data key, plain label. */
const PARTIAL_UNIT_FIELDS = [
  { filter: 'tonnage', key: 'tonnage', label: 'tonnage' },
  { filter: 'refrigerant', key: 'refrigerant', label: 'refrigerant' },
];

/** D9: the filter value detPlan.js uses for "out of state" - resolved to the shop's home state at execution time (see resolveHomeState). */
const OUT_OF_STATE_HOME = 'HOME';

/** The state most customers are in (ties broken alphabetically), with how many of the customers that carry a state it covers; null when none has one. */
async function resolveHomeState(db) {
  const { rows } = await db.raw(
    `SELECT data->>'service_address' AS service_address FROM entities
      WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL}`,
    []
  );
  const counts = new Map();
  let total = 0;
  for (const r of rows) {
    const st = deriveGeo(r.service_address).state;
    if (!st) continue;
    total += 1;
    counts.set(st, (counts.get(st) ?? 0) + 1);
  }
  if (!counts.size) return null;
  const [state, count] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return { state, count, total };
}

/** D8: what a permit's own text says - its "Scope of Work" line (commercial vs residential), the city on its "CITY OF X" header and its number. */
function permitFactsOf(text) {
  const t = String(text ?? '');
  const scopeLine = /scope of work:\s*([^\n]*)/i.exec(t)?.[1]?.trim() ?? null;
  const basis = scopeLine ?? t;
  const scope = /\bcommercial\b|\brtu\b|\brooftop\b/i.test(basis) ? 'commercial' : /\bresidential\b|single[- ]family|\bhome\b|\bhouse\b/i.test(basis) ? 'residential' : null;
  const city = /\bcity of\s+([a-z][a-z .'-]*?)\s*,/i.exec(t)?.[1]?.trim().toLowerCase() ?? null;
  const number = /permit\s*(?:no\.?|number|#)\s*:?\s*([a-z0-9-]+)/i.exec(t)?.[1] ?? null;
  return { scope, city, number, scopeLine };
}

function shapeCustomerRow(r) {
  const geo = deriveGeo(r.service_address);
  return {
    id: r.id, label: r.customer_name || 'Unnamed customer', value: geo.city || r.service_address || '—',
    entityId: r.id, city: geo.city, county: geo.county, state: geo.state, zip: geo.zip,
    customerName: r.customer_name,
    // hasEmail/hasPhone (item 2) read these two via matchesFilter's own
    // HAS_FIELD_ROW_KEY map (analytics.js) — buildAnalyticsSQL's customers
    // SELECT already carries both columns.
    email: r.email, phone: r.phone,
    // Round 15 (A, data-quality): read via matchesFilter's own
    // DATA_QUALITY_ROW_KEY map (analytics.js) — hasServiceAddress/hasZip are
    // plain presence checks on columns this row already carries (service_address
    // itself, and zip already derived above by deriveGeo); hasAnyDocument comes
    // from buildAnalyticsSQL's own correlated EXISTS subquery.
    hasServiceAddress: present(r.service_address),
    hasZip: present(geo.zip),
    hasAnyDocument: pgBool(r.has_any_document),
    // R18 P4 (C4, negation, h134): "how many customers have zero equipment on file" — the
    // customers-side mirror of hasAnyDocument, via buildAnalyticsSQL's own correlated EXISTS.
    hasAnyEquipment: pgBool(r.has_any_equipment),
    // R20 (J3, i011): see analytics.js's DATA_QUALITY_FIELD_ENTITY doc comment on hasMultipleUnits.
    hasMultipleUnits: pgBool(r.has_multiple_units),
    // R18 (H1): raw value for attachDuplicateFlag's sharesAddress computation just below — every
    // other field here is already derived/boolean, but the frequency map needs the actual string.
    serviceAddress: r.service_address,
  };
}

function shapeEquipmentRow(r, today) {
  const geo = deriveGeo(r.service_address);
  // Round 15 (A): "install date in the future" — a real, parseable
  // installation_date whose value sorts AFTER today's date string. Plain
  // string comparison is safe here because every format this corpus stores
  // (YYYY-MM-DD, YYYY-MM, YYYY) is left-zero-padded and a prefix of the next-
  // finer one, so lexicographic order always agrees with calendar order at
  // whatever precision is actually on file. A blank/unparseable date is never
  // "in the future" — only a real, comparable value can be.
  const installRaw = r.installation_date == null ? '' : String(r.installation_date).trim();
  const installDateInFuture = /^\d{4}(-\d{2}(-\d{2})?)?$/.test(installRaw) && installRaw > String(today ?? '');
  return {
    id: r.id, label: [r.manufacturer, r.equipment_type].filter(Boolean).join(' ') || 'Equipment',
    value: r.model || r.id, entityId: r.customer_id || r.id,
    brand: r.manufacturer, model: r.model, equipmentType: r.equipment_type, tonnage: r.tonnage,
    refrigerant: r.refrigerant, installYear: installYearOf(r.installation_date),
    warrantyStatus: warrantyStatusOf(r.warranty, today),
    // R18 P4 (C3): warrantyExpires (a raw date string, for the warrantyExpires filter field —
    // detPlan.js's detectWarrantyExpiryWindow) and warrantyRegistered (registration paperwork on
    // file — MISSING_FIELD_RULES' own warrantyRegistered rule) both read the SAME `warranty` JSON
    // column warrantyStatusOf already reads just above, never a new SQL column.
    warrantyExpires: r.warranty?.expires ?? null,
    warrantyRegistered: r.warranty?.registrationState === 'on_file',
    // R20 (J3, i094/i115/i116): the raw registration date, and the day gap between it and the
    // unit's own install date (installDate falls back to the unit's top-level installation_date for
    // a unit whose `warranty` object predates that field — see deriveWarranty's own doc comment for
    // why both dates normally agree). Null whenever either date is missing or unparseable — never a
    // guessed gap — so matchesFilter's ordinary "actual == null -> never matches" rule already keeps
    // a unit with no registration on file out of any warrantyRegistrationDays filter, exactly like
    // the oracle's own JOIN (a unit absent from the registration-date extraction can't appear in it).
    warrantyRegisteredDate: r.warranty?.registrationOnFile ?? null,
    warrantyRegistrationDays: (() => {
      const reg = r.warranty?.registrationOnFile;
      const inst = r.warranty?.installDate ?? r.installation_date;
      if (!/^\d{4}-\d{2}-\d{2}/.test(String(reg ?? '')) || !/^\d{4}-\d{2}-\d{2}/.test(String(inst ?? ''))) return null;
      const diffMs = new Date(reg).getTime() - new Date(inst).getTime();
      if (!Number.isFinite(diffMs)) return null;
      return Math.round(diffMs / 86400000);
    })(),
    city: geo.city, county: geo.county, state: geo.state, zip: geo.zip,
    // Round 15 (A, data-quality): see shapeCustomerRow's own comment above —
    // same DATA_QUALITY_ROW_KEY map. No hasWarrantyInfo here: "no warranty
    // information at all" is answered via the existing warrantyStatus filter
    // (value 'unknown') instead — see detPlan.js's MISSING_FIELD_RULES doc
    // comment for why a raw-presence check on `warranty` can't work.
    hasSerial: present(r.serial_number),
    hasInstallDate: present(r.installation_date),
    hasModel: present(r.model),
    hasTonnage: present(r.tonnage),
    // R16 D2 audit item 9: same presence-check pattern as hasTonnage right
    // above — refrigerant is only ever printed on a nameplate/startup-sheet/
    // warranty-registration document, same as tonnage, so this corpus's ~53%
    // coverage is real and by design, not a bug; this just makes the gap
    // countable/filterable instead of invisible.
    hasRefrigerant: present(r.refrigerant),
    hasCustomerLink: present(r.customer_id),
    installDateInFuture,
    // R21 M2 (Cluster 2/3): the raw YYYY-MM-DD (or shorter) install date, day-precise — installYear
    // above is a bare calendar-year number and can't tell "before June 1" from "any time that same
    // year" apart; a relative-time plan.timeRange (detPlan.js's detectInstallDateRelativeRange) and
    // an age-threshold filter (resolveAgeFilter) both need the real date, not just its year.
    installDate: /^\d{4}(-\d{2}(-\d{2})?)?$/.test(installRaw) ? installRaw : null,
    // R18 (H1): raw value for attachDuplicateFlag's isDuplicateSerial computation just below —
    // see shapeCustomerRow's own serviceAddress comment above for why this needs the raw string.
    serialNumber: r.serial_number,
  };
}

/**
 * R18 (H1, breadth-data-quality-017/018/019/023): sets `flagKey` true on every row whose
 * (case-insensitive, trimmed) `key` value is shared with at least one OTHER already-fetched row
 * for the same entity — the "does this row duplicate another row" condition
 * analytics.js's DATA_QUALITY_FIELD_ENTITY doc comment (isDuplicateName/sharesAddress/
 * isDuplicateSerial) describes. Must run on the FULL row set fetched for the entity, before
 * applyEntityFilters narrows anything down (a filter can only ever shrink the set being
 * compared, silently hiding a real duplicate's partner) — every call site below adds it
 * immediately after the `raw.map(...)` shape step and before any filtering. Blank values never
 * count as duplicates of each other (a customer/unit with no name/address/serial on file isn't
 * "the same" as another blank one) — matches every oracle's own `coalesce(...) <> ''`/lower-btrim
 * shape exactly. Mutates `rows` in place (cheap: one pass to count, one pass to flag) and returns
 * it for convenience.
 */
function attachDuplicateFlag(rows, key, flagKey) {
  const counts = new Map();
  for (const r of rows) {
    const v = String(r[key] ?? '').trim().toLowerCase();
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  for (const r of rows) {
    const v = String(r[key] ?? '').trim().toLowerCase();
    r[flagKey] = Boolean(v) && (counts.get(v) ?? 0) > 1;
  }
  return rows;
}

function shapeDocumentRow(r, dateBasis) {
  // Item 1: month by the WORK date (extractions.service_date, left-joined in
  // buildAnalyticsSQL's documents branch), not the upload date — falls back
  // to created_at only for a document nothing was ever extracted as its
  // service_date for. `date` (item 5, 2026-09-22) is the same value at full
  // day precision, for the extended day-grain time windows (this week,
  // since 2024, ...) that a month truncation alone can't compare correctly —
  // see analytics.js's withinTimeRange.
  const fullDate = r.service_date && /^\d{4}-\d{2}-\d{2}/.test(String(r.service_date))
    ? String(r.service_date).slice(0, 10)
    : null;
  // Round 14 (K3) BUG FIX: the DB's own `::date` cast of a timestamptz runs
  // under its session timezone — 'Etc/GMT+8' (a fixed -8h offset, no DST) is
  // what this app's Postgres/PGlite session actually uses by default — so a
  // document created at "2026-09-01T00:00:00Z" is that DB's "2026-08-31" for
  // any date/month bucketing. Reading it back as a plain UTC slice (no
  // offset) silently disagreed with that by up to a full calendar day right
  // at every month boundary — several "documents added THIS/LAST month"
  // counts were off by exactly the handful of midnight-UTC uploads that
  // straddle the boundary. Applying the same fixed -8h shift here keeps this
  // in agreement with the DB no matter which entity's date math is compared.
  const uploadDate = r.created_at ? new Date(new Date(r.created_at).getTime() - 8 * 3600 * 1000).toISOString().slice(0, 10) : null;
  // R19 (I2, h071): "how many maintenance agreements have we signed since 2020" — the upload-date
  // fallback just below is right for a VISIT-type document (a service ticket with no extracted
  // service_date almost always still got scanned close to when the work happened, so upload date is
  // a reasonable stand-in) but silently wrong for a NON_VISIT_TYPES document (scope.js — a contract,
  // quote, permit, registration, ...), whose service_date field means something else entirely (an
  // agreement/registration/effective date, never a job date) and is simply absent from most of
  // them: falling back to upload date there manufactured a match the oracle's own `EXISTS (...
  // service_date ...)` never counts (h071's real answer is 0 — no maintenance-agreement in this
  // corpus carries a service_date at all — not "however many happen to have been scanned since
  // 2020"). Scoped narrowly to entity 'documents' with a real time-range filter and no real
  // service_date on file; every OTHER caller of this row shape (a bare doc-type count/list with no
  // time filter at all) is completely unaffected since `date`/`month` are only ever read by
  // withinTimeRange.
  const fallbackDate = isVisitType(r.document_type) ? uploadDate : null;
  const date = dateBasis === 'uploaded' ? uploadDate : (fullDate ?? fallbackDate);
  const month = date ? date.slice(0, 7) : r.service_date ? String(r.service_date).slice(0, 7) : null;
  return {
    id: r.id, label: documentTypeLabel(r.document_type), value: r.original_filename || r.id,
    entityId: undefined, documentType: r.document_type, month, date,
    // Round 15 (A, data-quality): hasServiceDate is the RAW extraction's
    // presence (before dateBasis/upload-date fallback ever applies) —
    // "service documents have no service date" asks whether a service date
    // was ever extracted at all, not what `date`/`month` above resolved to
    // display. hasCustomerLink comes from buildAnalyticsSQL's own correlated
    // EXISTS subquery, same "direct link" semantics as shapeCustomerRow's own
    // hasAnyDocument (analytics.js's DATA_QUALITY_ROW_KEY reads both).
    hasServiceDate: present(r.service_date),
    hasCustomerLink: pgBool(r.has_customer_link),
    // R20 (J3, i020/i021): the vendor_name extraction — see buildAnalyticsSQL's documents branch.
    vendor: r.vendor ?? null,
    // D4: the agreement's own term ("01/01/2025 - 12/31/2026") and its END year (the last year printed in it); only selected for an end-year question.
    ...(r.permit_text != null ? (() => { const pf = permitFactsOf(r.permit_text); return { permitScope: pf.scope, permitCity: pf.city, permitNumber: pf.number, permitScopeText: pf.scopeLine }; })() : {}),
    agreementTerm: r.agreement_term ?? null,
    agreementEnd: agreementEndOf(r.agreement_term),
    customerName: r.agreement_customer ?? null,
  };
}

/** Filters whose field this entity's row shape doesn't carry at all — e.g. a
 *  "brand" filter against `documents` — make the plan meaningless for this
 *  entity. Rather than silently ignoring it (answering a DIFFERENT question
 *  than what was asked), treat it as a fall-through, same as an invalid plan. */
const ENTITY_SUPPORTED_FIELDS = {
  customers: new Set([
    'state', 'county', 'city', 'zip', 'customerName', 'hasEmail', 'hasPhone', 'hasDocType', 'lacksDocType',
    'hasServiceAddress', 'hasZip', 'hasAnyDocument',
    // R18 (H1, breadth-data-quality-017/018/019): see attachDuplicateFlag's own doc comment.
    'isDuplicateName', 'sharesAddress',
    // R18 P4 (C2/C4): hasServiceType/lacksServiceType (queryCustomersByServiceTypeCondition,
    // below) and hasAnyEquipment (the customers-side mirror of hasAnyDocument).
    'hasServiceType', 'lacksServiceType', 'hasAnyEquipment',
    // R20 (J3, i011): see analytics.js's DATA_QUALITY_FIELD_ENTITY doc comment on hasMultipleUnits.
    'hasMultipleUnits',
  ]),
  equipment: new Set([
    'state', 'county', 'city', 'zip', 'brand', 'model', 'equipmentType', 'tonnage', 'refrigerant', 'installYear', 'installDate', 'warrantyStatus',
    'hasSerial', 'hasInstallDate', 'hasModel', 'hasTonnage', 'hasRefrigerant', 'hasCustomerLink', 'installDateInFuture',
    // R18 (H1, breadth-data-quality-023): see attachDuplicateFlag's own doc comment.
    'isDuplicateSerial',
    // R18 P4 (C3): warrantyExpires (a raw date-range test) and warrantyRegistered (registration
    // paperwork on file) — see analytics.js's own doc comments on each.
    'warrantyExpires', 'warrantyRegistered',
    // R20 (J3, i094): the registration-vs-install day gap — see shapeEquipmentRow's own doc comment.
    'warrantyRegistrationDays',
    // R21 M2 (Cluster 1/C1): a unit existentially linked to a service VISIT of a given type — see
    // queryEquipmentByServiceTypeCondition's own doc comment for the dedicated join query this
    // needs (buildAnalyticsSQL's plain equipment branch has no notion of a document join).
    'hasServiceType', 'lacksServiceType',
  ]),
  warranties: new Set(['state', 'county', 'city', 'zip', 'brand', 'model', 'equipmentType', 'warrantyStatus', 'warrantyExpires']),
  // R21 (M2, g103): 'linkedEquipmentBrand' — see queryDocumentsByEquipmentBrand's own doc comment
  // for why this needs its own dedicated join query rather than a plain column filter.
  documents: new Set(['documentType', 'hasServiceDate', 'hasCustomerLink', 'vendor', 'linkedEquipmentBrand', 'agreementEnd', 'permitScope', 'permitCity']),
  // R21 (L3): 'hasServiceType' — a visit's OWN service_type (see buildAnalyticsSQL's serviceVisits
  // branch, analytics.js, and the row-merge just above where it is set) — was missing here, so
  // "how many repair visits have we logged" always failed this whitelist and fell straight to
  // `return null` in executeAnalyticsPlan below, even though detectAnalyticsPlan already built the
  // exact right filter deterministically.
  //
  // NOTE: 'brand' was tried here too (for "how many trane jobs have we done total") and reverted.
  // The oracle for that shape counts DISTINCT DOCUMENTS joined to an equipment ENTITY whose
  // data->>'manufacturer' matches (any document type, not gated by a service_date extraction
  // existing on that document) — see test-docs/scorecard/generalization/field-phrasing.json g103.
  // This serviceVisits row set is anchored on field_key='service_date' extractions and a per-
  // document manufacturer subquery, which undercounts against that oracle (34 vs 54 measured) and
  // would need its own entity-linked plan/executor, not this filter whitelist. Left as needs-model;
  // see final report for the hook a future round should build.
  serviceVisits: new Set(['technician', 'hasServiceType']),
};

/**
 * Reviewer NO-GO (2026-09-21, round 2, gap 1): "Which customers have Trane
 * units?" already passed the classifier AND validatePlan (brand is in the
 * closed FILTER_FIELDS vocabulary) — the planner correctly returned
 * `{entity: 'customers', op: 'list', filters: [{field: 'brand', ...}]}` — but
 * filtersSupported (above) rejected it outright because `customers` carries
 * no equipment-level column, so the whole question fell through to
 * retrieval+model. These are the equipment-level fields customers can be
 * filtered by via a join through equipment.customer_id — see
 * queryCustomersByEquipmentFilter below.
 */
const EQUIPMENT_FIELDS_VIA_CUSTOMER_JOIN = new Set([
  'brand', 'model', 'equipmentType', 'tonnage', 'refrigerant', 'installYear', 'installDate', 'warrantyStatus',
]);

function filtersSupported(entity, filters) {
  const supported = ENTITY_SUPPORTED_FIELDS[entity] ?? new Set();
  return (filters ?? []).every(
    (f) => supported.has(f.field) || (entity === 'customers' && EQUIPMENT_FIELDS_VIA_CUSTOMER_JOIN.has(f.field))
  );
}

/** brand/state filters need special-cased matching (normalizeBrand,
 *  normalizeStateValue) that plain matchesFilter's case-insensitive string
 *  compare doesn't give them — applied first, then the rest via
 *  matchesAllFilters. */
function applyEntityFilters(rows, filters) {
  const special = (filters ?? []).filter((f) => f.field === 'brand' || f.field === 'state');
  const plain = (filters ?? []).filter((f) => f.field !== 'brand' && f.field !== 'state');
  return rows.filter((r) => {
    for (const f of special) {
      if (f.field === 'brand') {
        const values = f.op === 'in' ? f.value : [f.value];
        const hit = values.some((v) => brandMatches(r.brand, v));
        if (f.op === 'neq' ? hit : !hit) return false;
      }
      if (f.field === 'state') {
        const want = normalizeStateValue(f.value);
        const have = r.state ? normalizeStateValue(r.state) : null;
        const hit = have === want;
        if (f.op === 'neq' ? hit : !hit) return false;
      }
    }
    return matchesAllFilters(r, plain);
  });
}

const TENANT_SQL = "tenant_id = (current_setting('app.tenant_id', true))::uuid";

/**
 * Reviewer NO-GO (2026-09-21, round 2, gaps 1 + 3): "customers" filtered by
 * an equipment-level field (brand, model, equipmentType, tonnage,
 * refrigerant, installYear, warrantyStatus) — "which customers have Trane
 * units", "how many customers have units older than 10 years". There is no
 * single `customers` SQL statement for this (a customer has zero or more
 * units), so this queries EQUIPMENT (reusing buildAnalyticsSQL's own
 * equipment branch + shapeEquipmentRow + applyEntityFilters — the exact same
 * matching a plain equipment-entity question already gets), then resolves
 * each surviving unit's customer_id to a customer row and de-duplicates to
 * ONE row per customer (a customer with 3 matching Trane units still counts
 * once). The matching unit's own brand/model is carried onto that row as the
 * list's detail column (gap 3: "Linda Fitzgerald · Trane 4TTR4036 · Mesa") —
 * the most-recently-updated matching unit wins when a customer has more than
 * one (buildAnalyticsSQL's equipment query is already `ORDER BY updated_at
 * DESC`), since that is the one most likely to be what "have Trane units"
 * was actually asking about today.
 */
async function queryCustomersByEquipmentFilter(db, plan, { today } = {}) {
  // Round 14 (K3) BUG FIX: equipment rows in this corpus carry NO address of
  // their own at all (data.service_address is never populated on an
  // equipment entity — only the CUSTOMER row has one) — passing plan.filters
  // through UNCHANGED here used to hand a city/county/state/zip filter
  // straight to buildAnalyticsSQL's equipment branch, whose WHERE clause
  // compares against that always-empty column, silently zeroing out every
  // row before the customer join below ever runs (a geo-filtered "which
  // customers have Trane units in Mesa" always answered "0 customers", no
  // matter how many actually matched). Only genuinely equipment-level fields
  // belong in the SQL run against the equipment table; a geo/customerName/
  // contact-info/doc-type filter riding along in the same plan is resolved
  // the correct way, against the JOINED customer row, by
  // executeAnalyticsPlan's own full-plan.filters applyEntityFilters pass
  // over what this function returns (see that idempotent-pass comment).
  const equipmentFilters = (plan.filters ?? []).filter((f) => EQUIPMENT_FIELDS_VIA_CUSTOMER_JOIN.has(f.field));
  const equipmentPlan = { ...plan, entity: 'equipment', filters: equipmentFilters };
  const { sql, params } = buildAnalyticsSQL(equipmentPlan);
  const { rows: raw } = await db.raw(sql, params);
  const unitRows = raw
    .map((r) => ({ ...shapeEquipmentRow(r, today), customerId: r.customer_id || null }))
    .filter((r) => r.customerId);

  // Only the genuinely equipment-level filters apply at this stage (same set
  // as the SQL above) — hasEmail/hasPhone/geo/customerName/hasDocType are all
  // CUSTOMER-level facts a raw unit row never carries; applying any of them
  // here (against a row that has none of those fields) would make
  // matchesFilter compare against undefined and silently return wrong rows.
  // They are deferred to the CUSTOMER rows fetched below, then re-checked by
  // executeAnalyticsPlan's own second applyEntityFilters pass over what this
  // function returns (see that idempotent-pass comment further down).
  const filtered = applyEntityFilters(unitRows, equipmentFilters);
  if (!filtered.length) return { rows: [], unfilteredCustomerIds: [], unitCount: 0 };

  const customerIds = [...new Set(filtered.map((r) => r.customerId))];
  const { rows: custRaw } = await db.raw(
    `SELECT id, data->>'customer_name' AS customer_name, data->>'service_address' AS service_address,
            data->>'email' AS email, data->>'phone' AS phone
       FROM entities
      WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL} AND id = ANY($1::uuid[])`,
    [customerIds]
  );
  const custById = new Map(custRaw.map((c) => [c.id, c]));

  const rows = [];
  const seen = new Set();
  for (const unit of filtered) {
    if (seen.has(unit.customerId)) continue;
    const cust = custById.get(unit.customerId);
    if (!cust) continue; // merged/removed between the two queries — skip, don't guess
    seen.add(unit.customerId);
    const geo = deriveGeo(cust.service_address);
    const detail = [unit.brand, unit.model].filter(Boolean).join(' ');
    rows.push({
      id: unit.customerId, label: cust.customer_name || 'Unnamed customer',
      value: [detail, geo.city].filter(Boolean).join(' · ') || geo.city || cust.service_address || '—',
      entityId: unit.customerId, city: geo.city, county: geo.county, state: geo.state, zip: geo.zip,
      customerName: cust.customer_name, email: cust.email, phone: cust.phone,
      // Every equipment-level field, not just brand/model — executeAnalyticsPlan
      // re-runs applyEntityFilters on whatever this function returns (the same
      // idempotent second pass every other entity branch gets), so a plan
      // combining e.g. brand + warrantyStatus must still find both fields here.
      // hasEmail/hasPhone (round 5 item 1) are genuinely checked for the
      // FIRST time in that second pass, now that email/phone are on the row.
      brand: unit.brand, model: unit.model, equipmentType: unit.equipmentType,
      tonnage: unit.tonnage, refrigerant: unit.refrigerant, installYear: unit.installYear, installDate: unit.installDate,
      warrantyStatus: unit.warrantyStatus,
    });
  }
  return { rows, unitCount: filtered.length };
}

/**
 * Round 4 item 1 (2026-09-21): "who's our biggest customer" — customers
 * RANKED by a size measure (equipmentCount or documentCount), not filtered.
 * A LEFT JOIN + COUNT + ORDER BY DESC + LIMIT — the join/columns are fixed,
 * whitelisted SQL text (never model input), and `limit` is a plan-validated
 * number, never a raw string. Deliberately ignores plan.filters for v1 (a
 * "biggest customer in Arizona" county/state filter combined with a sort) —
 * an honest, documented limitation (handoffs/DONOVAN_ANALYTICS_A_2026-09-21.md),
 * not a silent one: the brief's own examples never combine the two.
 */
async function queryTopCustomers(db, sortBy, limit) {
  const sql =
    sortBy === 'documentCount'
      ? `SELECT c.id, c.data->>'customer_name' AS customer_name, c.data->>'service_address' AS service_address,
                COUNT(DISTINCT l.document_id) AS metric
           FROM entities c
           LEFT JOIN document_entity_links l ON l.entity_id = c.id AND l.${TENANT_SQL}
          WHERE c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL}
          GROUP BY c.id
          ORDER BY metric DESC, c.updated_at DESC
          LIMIT $1`
      : `SELECT c.id, c.data->>'customer_name' AS customer_name, c.data->>'service_address' AS service_address,
                COUNT(DISTINCT e.id) AS metric
           FROM entities c
           LEFT JOIN entities e ON e.customer_id = c.id AND e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.${TENANT_SQL}
          WHERE c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL}
          GROUP BY c.id
          ORDER BY metric DESC, c.updated_at DESC
          LIMIT $1`;
  const { rows } = await db.raw(sql, [limit]);
  const noun = sortBy === 'documentCount' ? 'document' : 'unit';
  return rows.map((r) => {
    const n = Number(r.metric) || 0;
    return {
      id: r.id, label: r.customer_name || 'Unnamed customer',
      value: `${n} ${noun}${n === 1 ? '' : 's'}`, entityId: r.id,
    };
  });
}

/**
 * Field-phrasing g133/g138 ("whats the oldest unit we have on file" /
 * "whats our newest install"): the equipment entity/entities whose
 * installation_date is the min/max of every one actually on file. Two
 * queries rather than one ORDER BY ... LIMIT N — the first finds the exact
 * extreme VALUE, the second fetches every unit that shares it (a tie), so a
 * fleet where several units share one install date never silently reports
 * just whichever one row Postgres happened to return first. String
 * comparison/equality is safe here for the same reason shapeEquipmentRow's
 * own installDateInFuture check already relies on it: every install-date
 * shape this corpus stores (YYYY-MM-DD, YYYY-MM, YYYY) is left-zero-padded,
 * so lexicographic min/max agrees with calendar min/max at whatever
 * precision is actually on file, and an EXACT string match is the correct
 * definition of "the same printed date" regardless of precision.
 */
// R19 (I2, h114): `filters` (only ever a `brand` filter today — see detectInstallDateExtreme,
// detPlan.js) narrows the candidate set BEFORE the extreme date is found, so "whats our newest
// mitsubishi install" ranks only Mitsubishi units instead of the whole fleet. brandMatches (not a
// raw SQL ILIKE) is the same normalized brand comparison every other brand filter in this file
// uses, so "Mitsubishi"/"mitsubishi electric"/etc. all narrow the same way — done in JS over the
// full equipment set (this corpus is small; a second indexed SQL pass per brand alias would be the
// same cost for no real benefit) rather than a second, brand-specific SQL WHERE clause.
async function queryInstallDateExtreme(db, sortBy, filters = []) {
  const dir = sortBy === 'installDateAsc' ? 'ASC' : 'DESC';
  const brandValues = (filters ?? [])
    .filter((f) => f.field === 'brand')
    .flatMap((f) => (f.op === 'in' ? f.value : [f.value]));

  const { rows: raw } = await db.raw(
    `SELECT e.id, e.customer_id, e.data->>'model' AS model, e.data->>'manufacturer' AS manufacturer,
            e.data->>'equipment_type' AS equipment_type, e.data->>'tonnage' AS tonnage,
            e.data->>'refrigerant' AS refrigerant, e.data->>'installation_date' AS installation_date,
            e.data->>'serial_number' AS serial_number,
            c.data->>'service_address' AS service_address, c.data->>'customer_name' AS customer_name,
            e.data->'warranty' AS warranty, e.updated_at
       FROM entities e
       LEFT JOIN entities c ON c.id = e.customer_id AND c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL}
      WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.${TENANT_SQL}
        AND e.data->>'installation_date' IS NOT NULL AND e.data->>'installation_date' <> ''`,
    []
  );
  const candidates = brandValues.length
    ? raw.filter((r) => brandValues.some((v) => brandMatches(r.manufacturer, v)))
    : raw;
  if (!candidates.length) return { rows: [], extreme: null };

  let extreme = candidates[0].installation_date;
  for (const r of candidates) {
    if (dir === 'ASC' ? r.installation_date < extreme : r.installation_date > extreme) extreme = r.installation_date;
  }
  const tied = candidates
    .filter((r) => r.installation_date === extreme)
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
    .slice(0, INSTALL_DATE_EXTREME_LIMIT);
  const rows = tied.map((r) => ({
    ...shapeEquipmentRow(r, null),
    customerId: r.customer_id || null,
    customerName: r.customer_name || null,
  }));
  return { rows, extreme };
}

/** Answer + citations for queryInstallDateExtreme's result. Built directly
 *  (attachCitations/unitRecord, citations/records.js) rather than through
 *  withAnalyticsCitations/analyticsCitations (citations/analytics.js): that
 *  helper's own sortBy wording ("Ranked customers by...") is written for the
 *  customers-ranking shape only — see that file's own analyticsBasis. */
// R21 M2 (Cluster 3, j148/j149): full ELAPSED calendar years between `dateStr` and `today` — the
// same thing Postgres's `extract(year from age(today, dateStr))` gives (the generator's own oracle
// SQL): the years component of the calendar interval, decremented by one whenever this year's
// month/day anniversary of `dateStr` hasn't happened yet — never a bare `today.year - date.year`,
// which overcounts by one for any date whose anniversary later in the year hasn't yet occurred.
function calendarAgeYears(today, dateStr) {
  const t = new Date(`${today}T00:00:00Z`);
  const d = new Date(`${dateStr.length === 4 ? `${dateStr}-01-01` : dateStr.length === 7 ? `${dateStr}-01` : dateStr}T00:00:00Z`);
  if (Number.isNaN(t.getTime()) || Number.isNaN(d.getTime())) return null;
  let years = t.getUTCFullYear() - d.getUTCFullYear();
  const anniversaryPassed =
    t.getUTCMonth() > d.getUTCMonth() || (t.getUTCMonth() === d.getUTCMonth() && t.getUTCDate() >= d.getUTCDate());
  if (!anniversaryPassed) years -= 1;
  return Math.max(0, years);
}

function formatInstallDateExtremeAnswer(plan, rows, extreme, today) {
  if (!rows.length || !extreme) {
    const data = {
      kind: 'no-answer', text: 'No installation dates on file yet.',
      facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
    };
    return attachCitations(data, { records: [], total: 0, kind: 'searched', basis: 'Searched every unit on file for an installation date; none was found.' });
  }
  const label = plan.sortBy === 'installDateAsc' ? 'oldest' : 'newest';
  if (plan.ageInYears) {
    const years = calendarAgeYears(today, extreme);
    const text = `The ${label} unit on file is ${years} year${years === 1 ? '' : 's'} old (installed ${extreme}).`;
    const data = {
      kind: 'answer', text,
      facts: [{ label: `Age of ${label} unit (years)`, value: String(years) }],
      sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
    };
    const records = rows.map((r) => unitRecord(
      { id: r.id, manufacturer: r.brand, equipment_type: r.equipmentType, model: r.model, customer_id: r.customerId },
      { sublabel: [r.model, extreme, r.city].filter(Boolean).join(' · '), customerId: r.customerId ?? undefined }
    ));
    return attachCitations(data, {
      records, total: rows.length, kind: 'basis',
      basis: `Ranked every unit on file by installation date; the ${label} is dated ${extreme}, ${years} year${years === 1 ? '' : 's'} old as of ${today}.`,
    });
  }
  const describe = (r) => {
    const detail = [r.brand, r.model].filter(Boolean).join(' ') || 'Equipment';
    const where = r.customerName ? `${r.customerName}${r.city ? `, ${r.city}` : ''}` : r.city || null;
    return where ? `${detail} (${where})` : detail;
  };
  const tieText = rows.length > 1
    ? ` ${rows.length} units share that date: ${rows.map(describe).join('; ')}.`
    : ` (${describe(rows[0])}).`;
  const text = `The ${label} unit on file was installed ${extreme} —${tieText}`.replace(/—\s+\(/, '— (');
  const data = {
    kind: 'answer', text,
    facts: rows.map((r) => ({ label: describe(r), value: extreme, entityId: r.id, sources: [] })),
    sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
  };
  const records = rows.map((r) => unitRecord(
    { id: r.id, manufacturer: r.brand, equipment_type: r.equipmentType, model: r.model, customer_id: r.customerId },
    { sublabel: [r.model, extreme, r.city].filter(Boolean).join(' · '), customerId: r.customerId ?? undefined }
  ));
  return attachCitations(data, {
    records, total: rows.length, kind: 'basis',
    basis: `Ranked every unit on file by installation date; the ${label} is dated ${extreme}.`,
  });
}

// R20 (J3, i115/i116): "what's the earliest/most recent warranty registration date we have on
// file" — same shape as queryInstallDateExtreme just above, ranked on
// data.warranty.registrationOnFile (an already-derived, left-zero-padded YYYY-MM-DD string —
// see deriveWarranty/warrantyRules.js) instead of installation_date. No brand-filter support
// (no detected shape asks for one yet, unlike h114's install-date ranking); a future one is the
// same one-line addition detectInstallDateExtreme's own filters plumbing already shows.
async function queryWarrantyRegDateExtreme(db, sortBy) {
  const dir = sortBy === 'warrantyRegDateAsc' ? 'ASC' : 'DESC';
  const { rows: raw } = await db.raw(
    `SELECT e.id, e.customer_id, e.data->>'model' AS model, e.data->>'manufacturer' AS manufacturer,
            e.data->>'equipment_type' AS equipment_type, e.data->>'tonnage' AS tonnage,
            e.data->>'refrigerant' AS refrigerant, e.data->>'installation_date' AS installation_date,
            e.data->>'serial_number' AS serial_number,
            c.data->>'service_address' AS service_address, c.data->>'customer_name' AS customer_name,
            e.data->'warranty' AS warranty, e.updated_at
       FROM entities e
       LEFT JOIN entities c ON c.id = e.customer_id AND c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL}
      WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.${TENANT_SQL}
        AND e.data->'warranty'->>'registrationOnFile' IS NOT NULL AND e.data->'warranty'->>'registrationOnFile' <> ''`,
    []
  );
  if (!raw.length) return { rows: [], extreme: null };
  let extreme = raw[0].warranty?.registrationOnFile;
  for (const r of raw) {
    const v = r.warranty?.registrationOnFile;
    if (dir === 'ASC' ? v < extreme : v > extreme) extreme = v;
  }
  const tied = raw
    .filter((r) => r.warranty?.registrationOnFile === extreme)
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
    .slice(0, INSTALL_DATE_EXTREME_LIMIT);
  const rows = tied.map((r) => ({
    ...shapeEquipmentRow(r, null),
    customerId: r.customer_id || null,
    customerName: r.customer_name || null,
  }));
  return { rows, extreme };
}

function formatWarrantyRegDateExtremeAnswer(plan, rows, extreme) {
  if (!rows.length || !extreme) {
    const data = {
      kind: 'no-answer', text: 'No warranty registration dates on file yet.',
      facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
    };
    return attachCitations(data, { records: [], total: 0, kind: 'searched', basis: 'Searched every unit on file for a warranty registration date; none was found.' });
  }
  const label = plan.sortBy === 'warrantyRegDateAsc' ? 'earliest' : 'most recent';
  const describe = (r) => {
    const detail = [r.brand, r.model].filter(Boolean).join(' ') || 'Equipment';
    const where = r.customerName ? `${r.customerName}${r.city ? `, ${r.city}` : ''}` : r.city || null;
    return where ? `${detail} (${where})` : detail;
  };
  const tieText = rows.length > 1
    ? ` ${rows.length} units share that date: ${rows.map(describe).join('; ')}.`
    : ` (${describe(rows[0])}).`;
  const text = `The ${label} warranty registration on file is dated ${extreme} —${tieText}`.replace(/—\s+\(/, '— (');
  const data = {
    kind: 'answer', text,
    facts: rows.map((r) => ({ label: describe(r), value: extreme, entityId: r.id, sources: [] })),
    sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
  };
  const records = rows.map((r) => unitRecord(
    { id: r.id, manufacturer: r.brand, equipment_type: r.equipmentType, model: r.model, customer_id: r.customerId },
    { sublabel: [r.model, extreme, r.city].filter(Boolean).join(' · '), customerId: r.customerId ?? undefined }
  ));
  return attachCitations(data, {
    records, total: rows.length, kind: 'basis',
    basis: `Ranked every unit with a warranty registration date on file; the ${label} is dated ${extreme}.`,
  });
}

/**
 * R19 (I2, task 2): executes a detectCountComparison() result — fetches every row of the one
 * entity involved ONCE (no filters), then runs applyEntityFilters twice (once per side) over the
 * SAME already-shaped rows, reusing brandMatches/city-equality exactly like every other filtered
 * analytics answer rather than a second hand-written SQL comparison. Small-corpus cost (one full
 * table fetch instead of two COUNT(*) queries) is the same trade-off queryCustomersByEquipmentFilter
 * already makes elsewhere in this file.
 */
async function runCountComparison(db, cmp, { today } = {}) {
  if (cmp.entity === 'serviceVisits') {
    const sides = [];
    for (const f of [cmp.leftFilter, cmp.rightFilter]) {
      const d = await executeAnalyticsPlan(db, { entity: 'serviceVisits', op: 'count', filters: [f] }, { today });
      const n = Number(d?.facts?.[0]?.value);
      if (!Number.isFinite(n)) return null;
      sides.push({ n, records: Array.isArray(d.records) ? d.records : [] });
    }
    const [l, r] = sides;
    const yes = l.n > r.n; // detectServiceTypeComparison already swapped the sides for a "fewer" question
    // report the counts in the order the question asked them
    const [an, bn] = cmp.fewerAsked ? [r.n, l.n] : [l.n, r.n];
    const text = `${yes ? 'Yes' : 'No'}, you have ${an} ${cmp.askedLeftLabel} and ${bn} ${cmp.askedRightLabel}.`;
    const data = {
      kind: 'answer', text,
      facts: [{ label: cmp.askedLeftLabel, value: String(an), sources: [] }, { label: cmp.askedRightLabel, value: String(bn), sources: [] }],
      sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
    };
    return attachCitations(data, {
      records: [...l.records, ...r.records], total: l.n + r.n, kind: 'basis',
      basis: `Counted service visits by their own service type: ${cmp.askedLeftLabel} (${an}) versus ${cmp.askedRightLabel} (${bn}).`,
    });
  }
  const { sql, params } = buildAnalyticsSQL({ entity: cmp.entity, op: 'list', filters: [] });
  const { rows: raw } = await db.raw(sql, params);
  const rows = cmp.entity === 'customers' ? raw.map((r) => shapeCustomerRow(r)) : raw.map((r) => shapeEquipmentRow(r, today));
  const leftRows = applyEntityFilters(rows, [cmp.leftFilter]);
  const rightRows = applyEntityFilters(rows, [cmp.rightFilter]);
  const leftCount = leftRows.length;
  const rightCount = rightRows.length;
  const yes = leftCount > rightCount;
  const text = `${yes ? 'Yes' : 'No'}, you have ${leftCount} ${cmp.leftLabel} and ${rightCount} ${cmp.rightLabel}.`;
  const data = {
    kind: 'answer', text,
    facts: [
      { label: cmp.leftLabel, value: String(leftCount), sources: [] },
      { label: cmp.rightLabel, value: String(rightCount), sources: [] },
    ],
    sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
  };
  const records = [
    ...leftRows.map((r) => superlativeRecordFor({ entity: cmp.entity }, r)),
    ...rightRows.map((r) => superlativeRecordFor({ entity: cmp.entity }, r)),
  ];
  return attachCitations(data, {
    records, total: leftCount + rightCount, kind: 'basis',
    basis: `Counted ${cmp.entity} matching ${cmp.leftLabel} (${leftCount}) versus ${cmp.rightLabel} (${rightCount}).`,
  });
}

const SUPERLATIVE_NOUN = {
  customers: (n) => `customer${n === 1 ? '' : 's'}`,
  equipment: (n) => `unit${n === 1 ? '' : 's'}`,
  documents: (n) => `document${n === 1 ? '' : 's'}`,
  serviceVisits: (n) => `visit${n === 1 ? '' : 's'}`,
  warranties: (n) => `unit${n === 1 ? '' : 's'}`,
};

/** One record per row in the target (extreme) group — the same per-entity record shapes
 *  citations/analytics.js's own (unexported) recordFor builds, kept local here since this path
 *  never goes through withAnalyticsCitations (a single-group answer needs its OWN total/claimedCount,
 *  not the whole-plan group-count assertion that helper performs across every group at once). */
function superlativeRecordFor(plan, row) {
  if (plan.entity === 'customers') {
    return customerRecord({ id: row.id, customer_name: row.customerName ?? row.label, address: row.serviceAddress ?? row.value });
  }
  if (plan.entity === 'equipment' || plan.entity === 'warranties') {
    return unitRecord(
      { id: row.id, manufacturer: row.brand, equipment_type: row.equipmentType, model: row.model, customer_id: row.customerId },
      { sublabel: [row.model, row.city].filter(Boolean).join(' · '), customerId: row.customerId ?? undefined }
    );
  }
  return documentRecord({ id: row.id, document_type: row.documentType }, {
    label: row.label, sublabel: [row.value, row.date].filter(Boolean).join(' · '),
  });
}

/**
 * R19 (I2, h112/h113/h115): answer + citations for a `plan.superlative` plan — the extreme (top or
 * bottom) named group(s), cited by only those groups' own rows (never the whole entity, and never
 * every group's rows the way a plain groupBy breakdown would be) — see detPlan.js's
 * detectGroupBySuperlative for the question shapes this answers.
 *
 * `tiedGroups` is every named group sharing the extreme count (usually just one). A genuine tie
 * (several brands/technicians/cities sharing the fewest/most count) has no principled way to name
 * ONE winner from the question text alone, so every tied name is listed instead of guessing — this
 * still answers correctly for an oracle that accepts any one of the tied values (the true answer is
 * always among the names listed) without ever asserting a single group is uniquely the extreme when
 * the data says otherwise.
 */
function formatGroupBySuperlativeAnswer(plan, tiedGroups, groupRowsForTarget) {
  const label = GROUP_LABEL[plan.groupBy] ?? plan.groupBy;
  const count = tiedGroups[0].count;
  const noun = (SUPERLATIVE_NOUN[plan.entity] ?? ((n) => `record${n === 1 ? '' : 's'}`))(count);
  const names = tiedGroups.map((g) => g.key);
  const verb = plan.superlative === 'top' ? 'biggest' : 'fewest';
  const text = names.length === 1
    ? (plan.superlative === 'top'
        ? `Your single biggest ${label} is ${names[0]}, with ${count} ${noun}.`
        : `${names[0]} has the fewest ${noun} on file: ${count}.`)
    : `${names.length} ${label}s are tied for the ${verb} ${noun} on file, with ${count} each: ${names.join(', ')}.`;
  const data = {
    kind: 'answer', text,
    facts: tiedGroups.map((g) => ({ label: `${g.key} (${label})`, value: String(g.count), sources: [] })),
    sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
  };
  const total = groupRowsForTarget.length;
  const records = groupRowsForTarget.map((r) => superlativeRecordFor(plan, r));
  return attachCitations(data, {
    records, total, kind: 'basis',
    basis: `Ranked every ${plan.entity} on file by ${label}; the ${plan.superlative === 'top' ? 'largest' : 'smallest'} group${names.length === 1 ? ' is' : 's are'} ${names.join(', ')} (${count} each).`,
  });
}

/**
 * Item 7 (100-question persona sample, 2026-09-22): "customers with a
 * proposal but no invoice" — hasDocType/lacksDocType filters, resolved by
 * finding every customer directly/manually linked (document_entity_links) to
 * a document of the "has" type, then excluding any of THOSE customers also
 * linked to a document of the "lacks" type (when one is given at all — a
 * bare hasDocType with no lacksDocType is just "which customers have an X").
 * Deliberately simpler than queryCustomersByEquipmentFilter's own join: only
 * documents linked straight to the customer entity count (not a document
 * reachable only via one of their units, and not a name-matched-but-never-
 * linked document) — a maintenance agreement or invoice is, in practice,
 * always a customer-scoped document, never an equipment-scoped one, so this
 * trade-off costs nothing on the corpus this ships against.
 */
async function queryCustomersByDocTypeCondition(db, plan, { audienceClause = 'TRUE' } = {}) {
  const hasFilter = (plan.filters ?? []).find((f) => f.field === 'hasDocType');
  const lacksFilter = (plan.filters ?? []).find((f) => f.field === 'lacksDocType');
  // R19 (I2, h125-shaped negation): this used to bail to an empty result set the moment there was
  // no POSITIVE hasDocType filter — correct for "which customers have an X" and "have X but no Y",
  // but silently wrong for a PURE negation with nothing else riding along ("how many customers have
  // never signed a maintenance agreement", "customers with no proposal on file at all"): a real
  // lacksDocType-only plan (validatePlan/detPlan.js both allow one) always answered "0", the exact
  // "negation collapses to nothing" bug this round's contract calls out. See the mirror fix on
  // queryCustomersByServiceTypeCondition just below for the identical shape one filter type over.
  if (!hasFilter && !lacksFilter) return { rows: [] };

  const docCustomerSql = `
    SELECT DISTINCT c.id, c.data->>'customer_name' AS customer_name, c.data->>'service_address' AS service_address,
           c.data->>'email' AS email, c.data->>'phone' AS phone
      FROM entities c
      JOIN document_entity_links l ON l.entity_id = c.id AND l.${TENANT_SQL}
      JOIN documents d ON d.id = l.document_id AND d.${TENANT_SQL}
     WHERE c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL} AND d.document_type = $1
       AND (${audienceClause})`;

  if (hasFilter) {
    const { rows: hasRows } = await db.raw(docCustomerSql, [hasFilter.value]);
    if (!lacksFilter) return { rows: hasRows.map((r) => shapeCustomerRow(r)) };
    const { rows: lacksRows } = await db.raw(docCustomerSql, [lacksFilter.value]);
    const lacksIds = new Set(lacksRows.map((r) => r.id));
    return { rows: hasRows.filter((r) => !lacksIds.has(r.id)).map((r) => shapeCustomerRow(r)) };
  }

  // lacksFilter only ("never signed", "no X on file at all"): every customer, minus the ones the
  // SAME EXISTS-style query finds for that document type — never a second, drifting definition of
  // "has one" from the has-side above.
  const [{ rows: allRows }, { rows: lacksRows }] = await Promise.all([
    db.raw(
      `SELECT id, data->>'customer_name' AS customer_name, data->>'service_address' AS service_address,
              data->>'email' AS email, data->>'phone' AS phone
         FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL}`,
      []
    ),
    db.raw(docCustomerSql, [lacksFilter.value]),
  ]);
  const lacksIds = new Set(lacksRows.map((r) => r.id));
  return { rows: allRows.filter((r) => !lacksIds.has(r.id)).map((r) => shapeCustomerRow(r)) };
}

/**
 * R21 (M2, g103): "how many trane jobs have we done total" — the oracle counts DISTINCT DOCUMENTS
 * joined (via document_entity_links) to an equipment ENTITY whose manufacturer matches, ANY document
 * type, never gated by a service_date extraction existing on that same document. The serviceVisits
 * entity (buildAnalyticsSQL, analytics.js) is anchored on field_key='service_date' rows and a
 * per-document manufacturer subquery, which undercounts against this exact join definition (34 vs 54
 * measured — see ENTITY_SUPPORTED_FIELDS' own doc comment on why 'brand' was reverted from that
 * entity's whitelist instead of fixed there). This is the dedicated join query that definition
 * actually needs, the same "buildAnalyticsSQL can't express a real join as a plain column filter"
 * shape queryCustomersByDocTypeCondition above already exists for.
 */
async function queryDocumentsByEquipmentBrand(db, plan, { audienceClause = 'TRUE' } = {}) {
  const brandFilter = (plan.filters ?? []).find((f) => f.field === 'linkedEquipmentBrand');
  if (!brandFilter) return { rows: [] };
  const { rows: raw } = await db.raw(
    `SELECT DISTINCT d.id, d.document_type, d.original_filename, d.created_at,
            (SELECT x.value FROM extractions x
              WHERE x.document_id = d.id AND x.field_key = 'service_date' AND x.${TENANT_SQL}
              ORDER BY x.created_at DESC LIMIT 1) AS service_date
       FROM documents d
       JOIN document_entity_links l ON l.document_id = d.id AND l.${TENANT_SQL}
       JOIN entities e ON e.id = l.entity_id AND e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.${TENANT_SQL}
      WHERE d.${TENANT_SQL} AND (${audienceClause}) AND e.data->>'manufacturer' ILIKE $1
      ORDER BY d.created_at DESC
      LIMIT 500`,
    [brandFilter.value]
  );
  return { rows: raw.map((r) => shapeDocumentRow(r, plan.dateBasis)) };
}

/**
 * R18 P4 (blind generalization round 18 part 2, C2/C4): "how many trane customers needed a
 * repair visit" / "how many customers have never had a preventive maintenance visit" —
 * hasServiceType/lacksServiceType filters, the event-level sibling of
 * queryCustomersByDocTypeCondition just above. A customer counts when a document linked either
 * DIRECTLY to them OR to one of THEIR units (see the oracle's own `l.entity_id = e.customer_id OR
 * l.entity_id = e.id` join — a service ticket is often linked to the specific unit worked on, not
 * the customer record) carries an extractions.service_type value matching the filter.
 */
async function queryCustomersByServiceTypeCondition(db, plan) {
  const hasFilter = (plan.filters ?? []).find((f) => f.field === 'hasServiceType');
  const lacksFilter = (plan.filters ?? []).find((f) => f.field === 'lacksServiceType');
  // R19 (I2, h125): "how many customers have never had a preventive maintenance visit" is a PURE
  // negation — detectCustomersHasServiceType (detPlan.js) correctly builds a lacksServiceType-ONLY
  // plan for it (there is no positive counterpart to name) — but this used to bail to an empty
  // result set whenever there was no hasFilter, so the answer was always "0" regardless of what the
  // data actually says (h125's real answer is 85), the exact "negation collapses to nothing" bug
  // this round's contract calls out. See the mirror fix on queryCustomersByDocTypeCondition above
  // for the identical shape one filter type over.
  if (!hasFilter && !lacksFilter) return { rows: [] };

  // R20 (J3, i028/i182/i183): "how many customers have both a maintenance agreement on file and a
  // repair visit THIS YEAR" / "how many rheem customers needed a repair THIS YEAR" — a real calendar
  // window on the QUALIFYING VISIT's own service_date, not merely a label decorating the count
  // (reconcileTimeRange, analytics.js, already puts a {from,to} on `plan` for ANY plan whenever the
  // question names a time phrase, regardless of entity — see planAnalyticsQuestion's own doc
  // comment). Previously ignored here entirely: the EXISTS below matched a service_type row from ANY
  // year, so "this year" only ever changed the ANSWER TEXT's label, never the actual count. Applied
  // as a nested EXISTS against the SAME document's own service_date extraction (never the visit's
  // upload date) so a qualifying visit is scoped exactly like every other service_date-windowed
  // query in this file.
  const range = plan.timeRange;
  const dateWindowSql = range?.from || range?.to
    ? `AND EXISTS (
             SELECT 1 FROM extractions sd
              WHERE sd.document_id = x.document_id AND sd.field_key = 'service_date' AND sd.${TENANT_SQL}
                AND ($2::text IS NULL OR sd.value >= $2::text) AND ($3::text IS NULL OR sd.value <= $3::text)
           )`
    : '';
  const dateParams = range?.from || range?.to ? [range?.from ?? null, range?.to ?? null] : [];

  const serviceTypeCustomerSql = `
    SELECT DISTINCT c.id, c.data->>'customer_name' AS customer_name, c.data->>'service_address' AS service_address,
           c.data->>'email' AS email, c.data->>'phone' AS phone
      FROM entities c
     WHERE c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL}
       AND c.id IN (
             -- R31 (speed): a set-based semi-join, same rows as the per-customer correlated EXISTS it replaces
             -- (a customer qualifies when a matching-service_type document is linked to the customer itself OR to
             -- one of that customer's units) — the correlated form re-probed links x extractions once per customer.
             SELECT l.entity_id FROM document_entity_links l
             JOIN extractions x ON x.document_id = l.document_id AND x.${TENANT_SQL}
            WHERE l.${TENANT_SQL} AND x.field_key = 'service_type' AND x.value = $1
              ${dateWindowSql}
             UNION
             SELECT e.customer_id FROM entities e
             JOIN document_entity_links l ON l.entity_id = e.id AND l.${TENANT_SQL}
             JOIN extractions x ON x.document_id = l.document_id AND x.${TENANT_SQL}
            WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.${TENANT_SQL}
              AND x.field_key = 'service_type' AND x.value = $1
              ${dateWindowSql}
           )`;

  if (hasFilter) {
    const { rows: hasRows } = await db.raw(serviceTypeCustomerSql, [hasFilter.value, ...dateParams]);
    if (!lacksFilter) return { rows: hasRows.map((r) => shapeCustomerRow(r)) };
    const { rows: lacksRows } = await db.raw(serviceTypeCustomerSql, [lacksFilter.value, ...dateParams]);
    const lacksIds = new Set(lacksRows.map((r) => r.id));
    return { rows: hasRows.filter((r) => !lacksIds.has(r.id)).map((r) => shapeCustomerRow(r)) };
  }

  // lacksFilter only: every customer, minus the ones the SAME EXISTS-style query finds for that
  // service type — never a second, drifting definition of "had one" from the has-side above.
  const [{ rows: allRows }, { rows: lacksRows }] = await Promise.all([
    db.raw(
      `SELECT id, data->>'customer_name' AS customer_name, data->>'service_address' AS service_address,
              data->>'email' AS email, data->>'phone' AS phone
         FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL}`,
      []
    ),
    db.raw(serviceTypeCustomerSql, [lacksFilter.value, ...dateParams]),
  ]);
  const lacksIds = new Set(lacksRows.map((r) => r.id));
  return { rows: allRows.filter((r) => !lacksIds.has(r.id)).map((r) => shapeCustomerRow(r)) };
}

/**
 * R21 M2 (deferred list, Cluster 1/C1): the equipment-entity sibling of
 * queryCustomersByServiceTypeCondition just above — same EXISTS-a-linked-document-with-this-
 * service_type shape, just anchored on the UNIT (e.id) rather than the customer, and joined either
 * DIRECTLY (a ticket linked to the unit itself) or via the unit's OWN customer_id (a ticket linked
 * to the customer record instead) — the oracle's own `l.entity_id = e.id OR l.entity_id =
 * e.customer_id` (every C1 id shares this exact join). detectBrandCityServiceTypeSince (detPlan.js)
 * is the only producer of this filter shape; brand/city (this plan's other filters) are applied
 * afterward by executeAnalyticsPlan's own generic applyEntityFilters pass, exactly like the
 * customers-side function leaves its own equipment-join filter for queryCustomersByEquipmentFilter
 * to combine separately.
 */
async function queryEquipmentByServiceTypeCondition(db, plan) {
  const hasFilter = (plan.filters ?? []).find((f) => f.field === 'hasServiceType');
  const lacksFilter = (plan.filters ?? []).find((f) => f.field === 'lacksServiceType');
  if (!hasFilter && !lacksFilter) return { rows: [] };

  const range = plan.timeRange;
  const dateWindowSql = range?.from || range?.to
    ? `AND EXISTS (
             SELECT 1 FROM extractions sd
              WHERE sd.document_id = x.document_id AND sd.field_key = 'service_date' AND sd.${TENANT_SQL}
                AND ($2::text IS NULL OR sd.value >= $2::text) AND ($3::text IS NULL OR sd.value <= $3::text)
           )`
    : '';
  const dateParams = range?.from || range?.to ? [range?.from ?? null, range?.to ?? null] : [];

  const equipmentCols = `e.id, e.customer_id, e.data->>'model' AS model, e.data->>'manufacturer' AS manufacturer,
           e.data->>'equipment_type' AS equipment_type, e.data->>'tonnage' AS tonnage,
           e.data->>'refrigerant' AS refrigerant, e.data->>'installation_date' AS installation_date,
           e.data->>'serial_number' AS serial_number,
           e.data->>'service_address' AS service_address, e.data->'warranty' AS warranty, e.updated_at`;

  const serviceTypeEquipmentSql = `
    SELECT ${equipmentCols}
      FROM entities e
     WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.${TENANT_SQL}
       AND EXISTS (
             SELECT 1 FROM document_entity_links l
             JOIN extractions x ON x.document_id = l.document_id AND x.${TENANT_SQL}
            WHERE l.${TENANT_SQL} AND x.field_key = 'service_type' AND x.value = $1
              AND (l.entity_id = e.id OR l.entity_id = e.customer_id)
              ${dateWindowSql}
           )`;

  if (hasFilter) {
    const { rows: hasRows } = await db.raw(serviceTypeEquipmentSql, [hasFilter.value, ...dateParams]);
    if (!lacksFilter) return { rows: hasRows.map((r) => shapeEquipmentRow(r)) };
    const { rows: lacksRows } = await db.raw(serviceTypeEquipmentSql, [lacksFilter.value, ...dateParams]);
    const lacksIds = new Set(lacksRows.map((r) => r.id));
    return { rows: hasRows.filter((r) => !lacksIds.has(r.id)).map((r) => shapeEquipmentRow(r)) };
  }

  // lacksFilter only: every unit, minus the ones the SAME EXISTS-style query finds for that service
  // type — never a second, drifting definition of "had one" from the has-side above. Mirrors
  // queryCustomersByServiceTypeCondition's own lacks-only path; kept for parity even though none of
  // C1's own ids need it (every one names a positive hasServiceType).
  const [{ rows: allRows }, { rows: lacksRows }] = await Promise.all([
    db.raw(
      `SELECT ${equipmentCols} FROM entities e WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.${TENANT_SQL}`,
      []
    ),
    db.raw(serviceTypeEquipmentSql, [lacksFilter.value, ...dateParams]),
  ]);
  const lacksIds = new Set(lacksRows.map((r) => r.id));
  return { rows: allRows.filter((r) => !lacksIds.has(r.id)).map((r) => shapeEquipmentRow(r)) };
}

/** R19 (I2, task 5): one probe + one clause per request, shared by every documents-touching branch
 *  executeAnalyticsPlan runs — `db` here is the SAME withTenant store every other query in this file
 *  already uses via `.raw`, wrapped to the `{query}` shape documentsHaveAudience expects (identical
 *  adapter shape search/knowledge.js's own adoption already uses for its own non-pg `db`). */
async function analyticsAudienceClause(db, teamScoped) {
  const hasAudienceColumn = await documentsHaveAudience({ query: (sql, params) => db.raw(sql, params) });
  return audienceFilterSql({ docAlias: 'd', hasAudienceColumn, teamScoped });
}

function keyOf(groupBy) {
  return (row) => {
    if (groupBy === 'warrantyStatus') return row.warrantyStatus ?? UNKNOWN_BUCKET;
    // R18 P4 (h074): 'year' is never a stored column — derived from the serviceVisits row's own
    // `month` (YYYY-MM) string, see detPlan.js's detectDistinctYearsCount.
    if (groupBy === 'year') return row.month ? String(row.month).slice(0, 4) : UNKNOWN_BUCKET;
    const v = row[groupBy];
    if (groupBy === 'brand' && v != null && v !== '') return canonicalBrandLabel(v); // R31: one manufacturer printed several ways is ONE brand group
    return v == null || v === '' ? UNKNOWN_BUCKET : String(v);
  };
}

/**
 * Run one validated plan against the tenant's own data. `db` is a
 * recordsStore.js store (has `.raw`), called from inside a withTenant
 * transaction — same calling convention as fastPathQuery.js.
 */
// R19 (I2, task 5): 'TRUE' (a no-op AND) whenever a caller doesn't pass one — every existing test/
// script call site keeps its exact current behavior; runAnalyticsQuestion (the only real caller)
// computes a real clause per request from documentsHaveAudience's own probe + isTeamScopedQuestion.
export async function executeAnalyticsPlan(db, plan, { today, timeRangeLabel, audienceClause = 'TRUE' } = {}) {
  // "who's our biggest customer" (round 4, item 1) — a distinct shape from
  // every other op: ranked, not filtered/counted. validatePlan already
  // guarantees sortBy only ever appears with entity 'customers' + op 'list'.
  if (plan.sortBy) {
    // g133/g138: equipment ranked by installation_date is its own query/answer
    // shape (queryInstallDateExtreme/formatInstallDateExtremeAnswer above) —
    // distinct from the customers-by-equipmentCount/documentCount ranking
    // below, which queryTopCustomers/withAnalyticsCitations already own.
    if (plan.entity === 'equipment' && WARRANTY_REG_DATE_SORT_FIELDS.includes(plan.sortBy)) {
      const { rows, extreme } = await queryWarrantyRegDateExtreme(db, plan.sortBy);
      return formatWarrantyRegDateExtremeAnswer(plan, rows, extreme);
    }
    if (plan.entity === 'equipment') {
      const { rows, extreme } = await queryInstallDateExtreme(db, plan.sortBy, plan.filters);
      return formatInstallDateExtremeAnswer(plan, rows, extreme, today);
    }
    const rows = await queryTopCustomers(db, plan.sortBy, plan.limit ?? TOP_CUSTOMERS_LIMIT);
    // TEAM C: citations from the same ranked rows.
    return withAnalyticsCitations(formatAnalyticsAnswer(plan, { total: rows.length, rows }), plan, { rows, total: rows.length });
  }

  if (!filtersSupported(plan.entity, plan.filters)) return null;

  const hasEquipmentJoinFilter =
    plan.entity === 'customers' && (plan.filters ?? []).some((f) => EQUIPMENT_FIELDS_VIA_CUSTOMER_JOIN.has(f.field));
  // Item 7 (100-question persona sample, 2026-09-22): hasDocType/lacksDocType
  // are resolved by their own dedicated query (queryCustomersByDocTypeCondition
  // above) — never by buildAnalyticsSQL, which has no notion of a
  // document_entity_links join. Checked before hasEquipmentJoinFilter since
  // the two are mutually exclusive in practice (validatePlan never mixes an
  // equipment-level filter into a cross-doc plan) but this ordering costs
  // nothing either way.
  const hasDocTypeFilter =
    plan.entity === 'customers' && (plan.filters ?? []).some((f) => DOC_TYPE_FILTER_FIELDS.includes(f.field));
  // R18 P4 (h090, h099-h105): a service-type condition ("needed a repair visit",
  // "never had a preventive maintenance visit") is its own cross-doc query,
  // same shape as hasDocTypeFilter above — see queryCustomersByServiceTypeCondition.
  const hasServiceTypeFilter =
    plan.entity === 'customers' && (plan.filters ?? []).some((f) => SERVICE_TYPE_FILTER_FIELDS.includes(f.field));
  // R21 M2 (Cluster 1/C1): the equipment-entity sibling of hasServiceTypeFilter just above —
  // detectBrandCityServiceTypeSince (detPlan.js) is the only producer of an equipment-entity
  // hasServiceType filter (see queryEquipmentByServiceTypeCondition's own doc comment for the
  // dedicated join query this needs, same "buildAnalyticsSQL can't express a real join" shape as
  // hasServiceTypeFilter's own customers-side query).
  const hasEquipmentServiceTypeFilter =
    plan.entity === 'equipment' && (plan.filters ?? []).some((f) => SERVICE_TYPE_FILTER_FIELDS.includes(f.field));
  // R21 (M2, g103): see queryDocumentsByEquipmentBrand's own doc comment — a real join,
  // buildAnalyticsSQL's documents branch has no notion of one.
  const hasLinkedEquipmentBrandFilter =
    plan.entity === 'documents' && (plan.filters ?? []).some((f) => f.field === 'linkedEquipmentBrand');

  let rows;
  // Set only in the serviceVisits branch below, from the SAME already-fetched
  // (and already DESC-by-date-sorted) rows — never a second query — see
  // formatAnalyticsAnswer's own doc comment for how this powers the honest
  // zero-result wording ("which units had service this month" live miss).
  let mostRecentServiceVisit;
  // Team A: how many matching UNITS stand behind a customers-via-equipment count; how many service records are dated in
  // the future (excluded from "jobs done"/"last service").
  let unitCount = null;
  let futureVisitCount = 0;
  if (hasDocTypeFilter && hasServiceTypeFilter) {
    // R20 (J3, i028, F1 "both a maintenance agreement on file and a repair visit"): the OLD
    // version of this branch only ever intersected hasDocTypeFilter/hasServiceTypeFilter together
    // when hasEquipmentJoinFilter ALSO rode along — a plan with BOTH cross-doc conditions but no
    // equipment filter fell to the plain `else if (hasDocTypeFilter)` branch below, which silently
    // dropped the service-type condition entirely (answering the doc-type count alone). Both
    // dedicated queries already return real shaped customer rows (not just ids), so the doc-type
    // rows ARE the base row set here, intersected down to the ids the service-type query also
    // found — the identical "run both, intersect by id" technique the equipment-join branch below
    // already used, just without requiring an equipment filter too.
    const [{ rows: docRows }, { rows: svcRows }] = await Promise.all([
      queryCustomersByDocTypeCondition(db, plan, { audienceClause }),
      queryCustomersByServiceTypeCondition(db, plan),
    ]);
    const svcIds = new Set(svcRows.map((r) => r.id));
    rows = docRows.filter((r) => svcIds.has(r.id));
    if (hasEquipmentJoinFilter) {
      const crossIds = new Set(rows.map((r) => r.id));
      const eqResult = await queryCustomersByEquipmentFilter(db, plan, { today });
      rows = eqResult.rows.filter((r) => crossIds.has(r.id));
      unitCount = eqResult.unitCount;
    }
  } else if ((hasDocTypeFilter || hasServiceTypeFilter) && hasEquipmentJoinFilter) {
    // R18 P4 (multi-hop AND-drop, e.g. "how many Trane customers needed a
    // repair visit"): hasDocTypeFilter/hasServiceTypeFilter and
    // hasEquipmentJoinFilter each resolve via their OWN dedicated query
    // (neither buildAnalyticsSQL nor queryCustomersByEquipmentFilter alone
    // knows about the other condition) — so when a plan carries both, run
    // both and intersect by customer id rather than silently picking one
    // and dropping the other.
    let crossIds = null;
    if (hasDocTypeFilter) {
      const { rows: docRows } = await queryCustomersByDocTypeCondition(db, plan, { audienceClause });
      crossIds = new Set(docRows.map((r) => r.id));
    }
    if (hasServiceTypeFilter) {
      const { rows: svcRows } = await queryCustomersByServiceTypeCondition(db, plan);
      const svcIds = new Set(svcRows.map((r) => r.id));
      crossIds = crossIds ? new Set([...crossIds].filter((id) => svcIds.has(id))) : svcIds;
    }
    const eqResult = await queryCustomersByEquipmentFilter(db, plan, { today });
    rows = eqResult.rows.filter((r) => crossIds.has(r.id));
    unitCount = eqResult.unitCount;
  } else if (hasDocTypeFilter) {
    ({ rows } = await queryCustomersByDocTypeCondition(db, plan, { audienceClause }));
  } else if (hasServiceTypeFilter) {
    ({ rows } = await queryCustomersByServiceTypeCondition(db, plan));
  } else if (hasEquipmentJoinFilter) {
    // Gaps 1 + 3: "which customers have Trane units" — a customer filtered
    // by an equipment-level attribute. queryCustomersByEquipmentFilter already
    // applies every filter itself (equipment-level AND the geo ones a unit's
    // own address also carries), so `filtered` below is a no-op pass-through
    // (matchesAllFilters([], []) === true) rather than re-filtering.
    ({ rows, unitCount } = await queryCustomersByEquipmentFilter(db, plan, { today }));
  } else if (plan.entity === 'customers') {
    const { sql, params } = buildAnalyticsSQL(plan, { audienceClause });
    const { rows: raw } = await db.raw(sql, params);
    rows = raw.map((r) => shapeCustomerRow(r));
    // R18 (H1): see attachDuplicateFlag's own doc comment — must run on the full fetched set,
    // before applyEntityFilters (below) narrows it down.
    attachDuplicateFlag(rows, 'customerName', 'isDuplicateName');
    attachDuplicateFlag(rows, 'serviceAddress', 'sharesAddress');
  } else if (hasEquipmentServiceTypeFilter) {
    // R21 M2 (Cluster 1/C1): plan.timeRange here scopes the QUALIFYING VISIT's own service_date
    // (already applied inside the dedicated query's own EXISTS join, exactly like
    // queryCustomersByServiceTypeCondition's identical dateWindowSql) — never the unit's own
    // install date, so this branch deliberately never runs the install-date withinTimeRange pass
    // the plain equipment branch below does; brand/city (plan's other filters) are left for the
    // generic applyEntityFilters pass further down, same as every other cross-doc branch above.
    ({ rows } = await queryEquipmentByServiceTypeCondition(db, plan, { today }));
  } else if (plan.entity === 'equipment' || plan.entity === 'warranties') {
    const { sql, params } = buildAnalyticsSQL(plan);
    const { rows: raw } = await db.raw(sql, params);
    rows = raw.map((r) => shapeEquipmentRow(r, today));
    // R18 (H1): see attachDuplicateFlag's own doc comment.
    attachDuplicateFlag(rows, 'serialNumber', 'isDuplicateSerial');
    // R21 M2 (Cluster 2, j040/j041/j046/j061 — "before the summer this year", "within the past 5
    // years"): buildAnalyticsSQL's equipment branch has no notion of plan.timeRange at all (its own
    // WHERE clause only ever applies plan.filters), so a relative-time install-date question used to
    // fetch every unit, unfiltered, and answer with the whole-corpus count. Same day-grain
    // withinTimeRange helper (analytics.js) the documents branch above already uses, keyed off the
    // row's own installDate (shapeEquipmentRow, just added) rather than a document date/month —
    // `.date`/`.month` is exactly the shape withinTimeRange itself expects.
    // R21 M2 (h047/h051 regression fix): reconcileTimeRange (analytics.js) attaches SOME plan.timeRange
    // to EVERY plan whenever the question names ANY relative-time phrase, regardless of which field
    // that phrase is really about — "how many units had their warranty expire in the past year" names
    // a time window on warrantyExpires (already fully expressed via THIS plan's own filters, above,
    // built by detectWarrantyExpiryWindow), never on the unit's own install date. Applying the
    // install-date withinTimeRange narrowing on top of an UNRELATED warrantyExpires-filtered plan
    // wrongly intersected two different dates on the same unit and silently zeroed out real matches.
    // Skipped whenever the plan already carries its own warrantyExpires filter — the time condition is
    // then already fully answered by that filter, never a second, wrong-field one.
    const hasOwnWarrantyExpiresFilter = (plan.filters ?? []).some((f) => f.field === 'warrantyExpires');
    if (plan.timeRange && !hasOwnWarrantyExpiresFilter) {
      const withRangeFields = rows.map((r) => ({ ...r, date: r.installDate, month: r.installDate ? r.installDate.slice(0, 7) : null }));
      rows = withRangeFields.filter((r) => withinTimeRange(r, plan.timeRange));
    }
  } else if (hasLinkedEquipmentBrandFilter) {
    ({ rows } = await queryDocumentsByEquipmentBrand(db, plan, { audienceClause }));
  } else if (plan.entity === 'documents') {
    const { sql, params } = buildAnalyticsSQL(plan, { audienceClause });
    const { rows: raw } = await db.raw(sql, params);
    rows = raw.map((r) => shapeDocumentRow(r, plan.dateBasis));
    // Item 5 (100-question persona sample, 2026-09-22): withinTimeRange
    // compares on the row's own `date` (full YYYY-MM-DD) when plan.timeRange
    // is itself day-grain (the new "this week"/"last N days"/etc. windows —
    // see resolveExtendedTimeRange in analytics.js), and falls back to the
    // pre-existing month-grain `month` comparison for a plain "August 2026"
    // style range — never a raw-date-vs-month-bound lexicographic compare
    // (see the serviceVisits branch's own comment below for why that traps).
    if (plan.timeRange) rows = rows.filter((r) => withinTimeRange(r, plan.timeRange));
  } else {
    // serviceVisits: service_date + technician are two different
    // extractions.field_key rows for the same document — fetched separately
    // and merged here, tenant-scoped identically to buildAnalyticsSQL's own
    // service_date query. customer_name/model now come back ON the
    // service_date row itself (buildAnalyticsSQL's own correlated
    // subqueries) — see that function's own doc comment ("which units had
    // service this month" live miss).
    const { sql, params } = buildAnalyticsSQL(plan);
    const [{ rows: dateRows }, { rows: techRows }] = await Promise.all([
      db.raw(sql, params),
      db.raw(
        `SELECT x.document_id, x.value FROM extractions x
          WHERE x.field_key = 'technician' AND tenant_id = (current_setting('app.tenant_id', true))::uuid
          LIMIT 500`,
        []
      ),
    ]);
    const techByDoc = new Map(techRows.map((r) => [r.document_id, r.value]));
    const allServiceVisitRows = dateRows.map((r) => ({
      id: r.document_id,
      label: r.customer_name || techByDoc.get(r.document_id) || 'Unassigned',
      // "brand/model · date" when a unit's model was extracted, else just the
      // date — the row's own raw date lives separately in `date` so the
      // timeRange filter below (and the zero-result "most recent" wording)
      // never has to parse this display string back apart.
      value: [r.model, r.value].filter(Boolean).join(' · ') || r.value,
      date: r.value, entityId: undefined,
      technician: techByDoc.get(r.document_id) ?? null,
      customerName: r.customer_name ?? null,
      model: r.model ?? null,
      // R21 (L3): a visit's own brand (applyEntityFilters' generic brand-matching special case,
      // above, already reads whatever entity's row carries a `.brand`) and its own service type —
      // see buildAnalyticsSQL's serviceVisits branch (analytics.js) for where these come from.
      // `hasServiceType` is named to match the SAME filter field detPlan.js's safety net already
      // builds for a serviceVisits plan (SERVICE_TYPE_PHRASE_RE) — on a customers-entity plan that
      // field means "linked to ANY visit of this type" (queryCustomersByServiceTypeCondition,
      // above); on a serviceVisits row it is simply the row's OWN type, a plain matchesFilter string
      // eq (analytics.js) — the two never collide since a plan's entity picks which path runs.
      brand: r.manufacturer ?? null,
      hasServiceType: r.service_type ?? null,
      documentType: r.document_type ?? null, // D20: lets the count say what kind of document each "visit" is
      month: /^\d{4}-\d{2}/.test(r.value ?? '') ? r.value.slice(0, 7) : null,
    }));
    // buildAnalyticsSQL's own query is `ORDER BY x.value DESC`, so the first
    // row (if any) is already the single most recent service visit on file,
    // regardless of what plan.timeRange narrows it to below — no second
    // query needed.
    // Team A: a service_date AFTER today is a scheduled visit or a typo - never "the most recent visit", never a job
    // that was done. splitFuture separates them (newest-first past list); they are reported as a count instead.
    const { past: pastVisitRows, future: futureVisitRows } = splitFuture(allServiceVisitRows, todayIso(today));
    futureVisitCount = futureVisitRows.length;
    // R20 (J3, i014/i015): "how many jobs has Denise Ford closed out total" — a NAMED-technician
    // count with no time filter must count every job that technician appears on, not just the ones
    // that ALSO happen to carry a service_date extraction. dateRows above is seeded from
    // field_key='service_date' rows only (see this branch's own header comment), so a document with
    // a technician extraction but no paired service_date row was silently invisible to any
    // technician-filtered plan — undercounting exactly the technician's own real total. Appended
    // AFTER splitFuture (never fed into it — splitFuture drops any row with no parseable date, which
    // is exactly what these rows are) so `mostRecentServiceVisit`/`visitRowsToUse[0]` above still
    // reflects only real, dated visits; date: null makes withinTimeRange (analytics.js) exclude these
    // rows from any genuinely time-windowed question, while a bare, no-time-filter count still
    // includes every one of them.
    // Scoped to op !== 'groupBy': a "breakdown by technician" / "how many different years"
    // groupBy plan legitimately needs every row to carry a real date (a groupBy's own bucket is
    // keyed off it, or IS the date's year) - regression caught by h074/technician-0002-canonical
    // (oe20 R20): including these date-less rows there inflated every bucket's count / added a
    // bogus extra year. Only a plain, non-grouped technician-filtered COUNT (detectTechnicianAction's
    // shape - i014/i015's own fix) wants a document counted even with no paired service_date row.
    //
    // R21 (M2, j048/j049): the technician-filter check below is NEW — this used to run for ANY
    // non-groupBy serviceVisits plan, not just a technician-filtered one, so even a bare "how many
    // service visits have we logged in total" (no technician named at all) silently counted every
    // document with a stray technician extraction and no service_date row too, inflating the true
    // all-time total (317 real dated visits) to 340. i014/i015's own shape always carries a
    // `{field:'technician'}` filter (detectTechnicianAction, detPlan.js) — scoping to that keeps
    // their fix exactly as it was while no longer silently padding every OTHER bare/filtered count.
    const hasTechnicianFilter = (plan.filters ?? []).some((f) => f.field === 'technician');
    const dateRowDocIds = new Set(dateRows.map((r) => r.document_id));
    const dateLessTechRows = plan.op === 'groupBy' || !hasTechnicianFilter ? [] : techRows
      .filter((t) => !dateRowDocIds.has(t.document_id))
      .map((t) => ({
        id: t.document_id, label: t.value || 'Unassigned', value: t.value,
        date: null, entityId: undefined, technician: t.value ?? null,
        customerName: null, model: null, month: null,
      }));
    const visitRowsToUse = [...pastVisitRows, ...dateLessTechRows];
    mostRecentServiceVisit = visitRowsToUse.length
      ? { date: visitRowsToUse[0].date, customer: visitRowsToUse[0].customerName || null }
      : null;
    // Reviewer NO-GO (2026-09-21, "which units had service this month" live
    // miss): comparing the full YYYY-MM-DD date directly against a YYYY-MM
    // timeRange bound is a lexicographic trap — '2026-09-10' > '2026-09' is
    // TRUE (a longer string sharing the shorter one's prefix sorts after it),
    // so a real September visit was wrongly excluded from its OWN month's
    // range by the `to` check. Compare on `r.month` (already truncated to
    // YYYY-MM) against the bound truncated the same way, exactly like the
    // documents branch above already does — never the raw date against a
    // bound of a different granularity.
    // Item 5: same withinTimeRange helper as the documents branch above — day
    // grain for the new extended windows, month grain (via r.month) otherwise.
    rows = plan.timeRange ? visitRowsToUse.filter((r) => withinTimeRange(r, plan.timeRange)) : visitRowsToUse;
  }

  // hasDocType/lacksDocType (and, R18 P4, hasServiceType/lacksServiceType) are
  // already fully resolved by their own dedicated query above — matchesFilter
  // has no notion of any of these fields (row[field] is always undefined for
  // them), so re-applying them here would zero out every row. Every OTHER
  // filter in the plan (a geo filter, or brand/model via the equipment-join
  // branch above, combined with the cross-doc condition) still needs this
  // pass, same as hasEquipmentJoinFilter's own rows above.
  // R21 (M2, g103): linkedEquipmentBrand is likewise already fully resolved by its own dedicated
  // join query (queryDocumentsByEquipmentBrand) — rows carry no such field, so leaving it in would
  // zero out every row the same way an unstripped hasDocType/hasServiceType filter would.
  const crossDocFilterUsed = hasDocTypeFilter || hasServiceTypeFilter || hasEquipmentServiceTypeFilter || hasLinkedEquipmentBrandFilter;
  const filtersToApply = crossDocFilterUsed
    ? (plan.filters ?? []).filter(
        (f) => !DOC_TYPE_FILTER_FIELDS.includes(f.field) && !SERVICE_TYPE_FILTER_FIELDS.includes(f.field) && f.field !== 'linkedEquipmentBrand'
      )
    : plan.filters;
  // D9: "out of state" = not in the shop's home state (the state most customers are in) - resolved against the live customer list, never
  // guessed; a customer whose state is unknown is not "out of state" either.
  let homeState = null;
  let filtersResolved = filtersToApply;
  if ((filtersToApply ?? []).some((f) => f.field === 'state' && f.value === OUT_OF_STATE_HOME)) {
    const homeInfo = await resolveHomeState(db);
    if (!homeInfo) return null; // no customer states on file to take a home state from - never guess
    homeState = homeInfo;
    filtersResolved = filtersToApply.map((f) => (f.field === 'state' && f.value === OUT_OF_STATE_HOME ? { ...f, value: homeInfo.state } : f));
    rows = rows.filter((r) => r.state);
  }
  const filtered = applyEntityFilters(rows, filtersResolved);
  const total = filtered.length;

  let groups = [];
  if (plan.op === 'groupBy') groups = groupRows(filtered, keyOf(plan.groupBy));

  // R19 (I2, h112/h113/h115): "the biggest city" / "the fewest units" — its own answer/citation
  // shape (formatGroupBySuperlativeAnswer above), distinct from the plain per-group breakdown below.
  // Named groups only — UNKNOWN_BUCKET is always sorted last by groupRows regardless of its real
  // count, so it must never be picked as either extreme.
  if (plan.op === 'groupBy' && plan.superlative) {
    const named = groups.filter((g) => g.key !== UNKNOWN_BUCKET);
    if (!named.length) {
      const data = {
        kind: 'no-answer', text: 'No data on file to rank.',
        facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
      };
      return attachCitations(data, { records: [], total: 0, kind: 'searched', basis: 'Searched every record on file for a ranking; none was found.' });
    }
    const target = plan.superlative === 'top' ? named[0] : named[named.length - 1];
    // A genuine tie at the extreme count (two+ named groups sharing it): list every tied name
    // rather than guessing one (formatGroupBySuperlativeAnswer's own doc comment) — the question
    // names no tie-break of its own, so no single group is uniquely "the" answer.
    const tiedGroups = named.filter((g) => g.count === target.count);
    const keyFn = keyOf(plan.groupBy);
    const groupRowsForTarget = filtered.filter((r) => tiedGroups.some((g) => g.key === keyFn(r)));
    return formatGroupBySuperlativeAnswer(plan, tiedGroups, groupRowsForTarget);
  }

  let sum = null;
  if (plan.op === 'sum') {
    // Live miss cluster 2 (2026-09-21): tonnage is the ONLY numeric field
    // this codebase can honestly total today — there is no financials layer
    // (handoffs/FINANCIALS_DESIGN_2026-09-21.md, not built), so summing
    // anything else (r.value ends up being a filename/document id for a
    // `documents` plan) silently reduced to 0 and printed as a confident
    // "$0.00 across N documents." api/ask.js's money gate already intercepts
    // most money phrasings before a plan is ever made; this is the second
    // line of defense — refuse rather than guess, same as every other
    // "can't answer this confidently" path in this file.
    if (plan.entity !== 'equipment' && plan.entity !== 'warranties') return null;
    sum = filtered.reduce((acc, r) => acc + (Number(r.tonnage) || 0), 0);
  }

  // Ambiguity rule (design point 5): 0 results from a named filter — show
  // what the tenant's data DOES have for this entity instead of a bare "0".
  let broaderGroups = null;
  let unfilteredTotal = null;
  if (total === 0 && plan.filters?.length) {
    const geoField = plan.filters.find((f) => ['state', 'county', 'city', 'zip'].includes(f.field));
    const groupField = geoField?.field === 'state' ? 'state' : geoField ? 'county' : null;
    if (groupField) {
      broaderGroups = groupRows(rows, keyOf(groupField));
      unfilteredTotal = rows.length;
    }
  } else if (plan.filters?.length) {
    unfilteredTotal = rows.length;
  }

  // TEAM C: records + basis from the SAME `filtered` rows (and the same group keys) the answer counts.
  const answered = withAnalyticsCitations(formatAnalyticsAnswer(plan, {
    total, groups, rows: filtered, sum, unfilteredTotal, broaderGroups, mostRecentServiceVisit, timeRangeLabel,
    unitCount, futureVisitCount,
  }), plan, {
    rows: filtered, total, groups, keyOf: plan.op === 'groupBy' ? keyOf(plan.groupBy) : null,
    unfilteredRows: total === 0 ? rows : null, timeRangeLabel, monthLabel: timeRangeLabel ? null : monthRangeLabel(plan.timeRange),
    futureVisitCount, // TEAM C: future-dated visits are mentioned in the basis, never cited as records
  });
  // D14: a count by tonnage / refrigerant only sees the units that HAVE that field; the rest (about half the units in a typical file) are neither
  // counted nor ruled out, so the number is never presented as the whole answer - say how many units have no value on file.
  if (answered && typeof answered.text === 'string' && plan.op !== 'groupBy' && (plan.entity === 'equipment' || plan.entity === 'customers' || plan.entity === 'warranties')) {
    const partialFields = PARTIAL_UNIT_FIELDS.filter((pf) => (plan.filters ?? []).some((f) => f.field === pf.filter));
    if (partialFields.length) {
      const notes = [];
      // Single partial field on a plain unit count: complete it from the invoice / startup-sheet text that names the unit's serial.
      const only = partialFields.length === 1 && plan.op === 'count' && plan.entity === 'equipment'
        && !plan.timeRange // a date window is a second condition the text completion cannot apply: keep the record count plus the note
        && (plan.filters ?? []).every((f) => f.field === partialFields[0].filter && f.op === 'eq' && typeof f.value === 'string');
      if (only) {
        const pf = partialFields[0];
        const want = (plan.filters ?? [])[0].value;
        const norm = (v) => (pf.key === 'tonnage' ? (/(\d+(?:\.\d+)?)/.exec(String(v))?.[1] ?? '') : String(v).toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^R/, ''));
        const textRe = pf.key === 'tonnage' ? /(\d+(?:\.\d+)?)\s*-?\s*ton\b/gi : /\bR-?(\d{2,3}[A-Z]?)\b/g;
        const { rows: units } = await db.raw(
          `SELECT data->>'serial_number' AS serial, COALESCE(data->>'${pf.key}', '') AS val
             FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT_SQL}`, []);
        const { rows: pages } = await db.raw(`SELECT text FROM document_pages WHERE ${TENANT_SQL}`, []);
        const have = units.filter((u) => u.val !== '');
        const lacking = units.filter((u) => u.val === '');
        let inferredHits = 0; let stillNone = 0;
        for (const u of lacking) {
          const serial = String(u.serial ?? '').trim();
          const vals = new Set();
          if (serial.length >= 4) {
            for (const pg of pages) {
              const t = String(pg.text ?? '');
              if (!t.includes(serial)) continue;
              for (const m of t.matchAll(textRe)) vals.add(norm(m[0]).replace(/^R-?/i, ''));
            }
          }
          if (vals.size === 1) { if ([...vals][0] === norm(want)) inferredHits += 1; } else stillNone += 1;
        }
        if (lacking.length > 0) {
          const recorded = have.filter((u) => norm(u.val) === norm(want)).length;
          const sum2 = recorded + inferredHits;
          const what = pf.key === 'tonnage' ? `${want} units` : `units with ${want}`;
          answered.text = `${recorded} ${what} on the unit records. Another ${inferredHits} show it only in invoice or startup-sheet text, so ${sum2} in all. Note: ${stillNone} of the ${units.length} units have no ${pf.label} on file or in their paperwork, so the true number could be higher.`;
          return answered;
        }
      }
      for (const pf of partialFields) {
        const { rows: cnt } = await db.raw(
          `SELECT count(*)::int AS total, count(*) FILTER (WHERE COALESCE(data->>'${pf.key}', '') = '')::int AS missing
             FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT_SQL}`, []);
        const { total: unitsTotal, missing } = cnt[0] ?? {};
        if (missing > 0) notes.push(`${missing} of the ${unitsTotal} units on file have no ${pf.label} recorded, so units that match could be among them and this count may be low`);
      }
      if (notes.length) answered.text = `${answered.text.replace(/\s+$/, '')} Note: ${notes.join('; ')}.`;
    }
  }
  if (homeState && answered && typeof answered.text === 'string' && plan.op !== 'groupBy' && (plan.entity === 'customers')) {
    // D9: say what "out of state" meant, so the number is never read as something else.
    const names = plan.op === 'list' && total > 0 && total <= 12 ? `: ${filtered.map((r) => r.label).join(', ')}` : '';
    answered.text = `${total} customer${total === 1 ? ' is' : 's are'} out of state${names} (service address not in ${homeState.state}, where ${homeState.count} customers are).`;
  }
  return answered;
}

/**
 * R7 guardrail item 2 ("yes/no shape"): exported for api/ask.js to apply to the OUTGOING response text only,
 * AFTER runAnalyticsQuestion's own cache write/read logic has already used the un-wrapped `data` — never baked
 * into what gets cached here, because a "how many Ruud units" and a "do we have any Ruud units" question can
 * resolve to the exact same Tier-2 plan-hash row, and only the second one wants the Yes/No lead-in; caching the
 * wrapped text would leak it onto the first question's answer too. Only wraps when the answer's own first fact
 * is cleanly a number (the ordinary count-op shape); anything else (a list breakdown, a sum, an honest fallback
 * with no facts) is left exactly as it was — never guesses at "yes"/"no" from a shape that doesn't actually say
 * a count. existenceWrap itself is idempotent, so an already-wrapped answer is never double-prefixed.
 */
export function applyExistenceShape(data, question) {
  if (!data || data.kind !== 'answer' || typeof data.text !== 'string' || !isExistenceQuestion(question)) return data;
  const n = Number(data.facts?.[0]?.value);
  if (!Number.isFinite(n)) return data;
  return { ...data, text: existenceWrap(data.text, n > 0) };
}

/**
 * Full orchestration for one question: cache check -> plan -> guard ->
 * execute. Returns {handled, data, cacheHit, writes} — `writes` lists every
 * (questionHash, corpusStamp) pair api/ask.js's own bookkeeping should
 * upsert on a fresh (non-cache-hit) answer; a cache hit needs no write.
 *
 * Reviewer NO-GO (2026-09-21, A2) fix: this used to take a `questionHash`
 * from api/ask.js and pass it straight to askCache.js's getCacheEntry — the
 * SAME hash the retrieval+model path caches under, and the SAME (retrieval's)
 * prompt version baked into its corpus_stamp. A question the classifier now
 * routes to analytics could therefore return a STALE retrieval-cached answer
 * as if it were a fresh analytics one. Fixed by computing this file's OWN
 * namespaced hashes (api/_lib/analytics.js's analyticsQuestionHash/
 * analyticsPlanHash — see that file's own doc comment for the two-tier
 * design) and passing ANALYTICS_PROMPT_VERSION to getCacheEntry, so an
 * analytics cache row can never be read as, or overwrite, a retrieval one,
 * regardless of what either path's prompt/schema does in the future.
 *
 * @param withTenant  api/_lib/recordsStore.js's withTenant, injected so this
 *                    stays easy to call from ask.js without a second import
 *                    cycle back through recordsStore.
 */
export async function runAnalyticsQuestion({ withTenant, ctxArg, question, today, overlay, tenantVocab, noCache = false }) {
  const EMPTY = { handled: false, data: null, cacheHit: false, modelCalled: false, writes: [] };
  // Day 1 training-plan normalization layer (nlNormalize.js): both the plan
  // and every cache key below key off the NORMALIZED text (more cache hits,
  // cheaper — a repeated question typed three different sloppy ways still
  // hits the same Tier-1 row) — `question` itself is kept only for anything
  // that might ever need to show the dispatcher back their own original
  // wording, which nothing in this file currently does.
  const { normalized: question_nRaw } = normalizeQuestion(question, { overlay });
  // R19 (I2, h113/h115): nlNormalize.js (outside this round's file ownership — see the round report's
  // "hooks needed" note) fuzzy-corrects the real word "fewest" into its own vocabulary word "newest"
  // (edit distance 1, and "fewest" isn't itself in that file's EXTRA_DOMAIN_WORDS list — the identical
  // false-correction shape that file's own doc comment already documents for "serviced" -> "service"),
  // silently turning "which manufacturer do we have the FEWEST units of" into "...the NEWEST units of"
  // before detPlan.js ever sees it, so a ranking-BOTTOM question got answered as a ranking-TOP one.
  // Reverted here (never in nlNormalize.js itself, which this round doesn't own) whenever the ORIGINAL
  // text plainly named "fewest" and no "newest" of its own — the real fix belongs in that file's own
  // EXTRA_DOMAIN_WORDS list, same one-line shape as its existing 'serviced'/'oldest'/'newest' entries.
  const question_n =
    /\bfewest\b/i.test(question) && !/\bnewest\b/i.test(question) && /\bnewest\b/i.test(question_nRaw)
      ? question_nRaw.replace(/\bnewest\b/i, 'fewest')
      : question_nRaw;
  // Tier 2 learning (Part A): the promptVersion namespace now also carries a
  // fingerprint of the active overlay's own few-shot items, so approving (or
  // retiring) one invalidates every previously-cached analytics answer —
  // otherwise a plan cached under the OLD prompt could be served forever
  // even after the planner starts seeing a new example.
  const promptVersion = `${ANALYTICS_PROMPT_VERSION}:${overlayFewShotHash(overlay)}`;
  try {
    // Reviewer NO-GO (2026-09-21, round 6): production still served a stale
    // cached "49 customers." for maintenance-due questions after this file's
    // own missingConditions check was added, because that check only ran
    // AFTER a plan existed, downstream of the Tier-1 cache probe below — a
    // cache row written before the fix (or under any future plan) short-
    // circuited straight past it. 'money' and 'maintenance' both have no
    // entry in CONDITION_PLAN_FIELD (analytics.js), so missingConditions()
    // would flag them as unsupported no matter what any plan says — that
    // makes them safe to decide HERE, before any cache lookup or model call,
    // so a stale/wrong cached answer can never be returned for them again.
    // R21 M2 (Cluster 6, j192/j195): a future-dated year named in the question — checked FIRST,
    // before even the money/maintenance conditions below, since a future-dated MONEY question
    // ("do we have an invoice dated January 1st, 2030") is still a future-date question first and
    // foremost, never a "financials not built yet" one. See mentionsFutureYear's own doc comment.
    if (mentionsFutureYear(question_n, today)) {
      return { handled: true, data: futureDateAnswer(), cacheHit: false, modelCalled: false, writes: [] };
    }
    const conditionsUpFront = detectedConditions(question_n);
    if (conditionsUpFront.has('money')) {
      // Miss loop (handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md): missOutcome
      // is api/ask.js's own signal to log this to ask_misses (api/_lib/
      // missStore.js) — a real answer never sets it, only an honest fallback.
      return { handled: true, data: moneyFallbackAnswer(), cacheHit: false, modelCalled: false, writes: [], missOutcome: 'money-fallback' };
    }
    if (conditionsUpFront.has('maintenance')) {
      return {
        handled: true, data: unsupportedConditionAnswer('maintenance', 'customers'), cacheHit: false, modelCalled: false, writes: [],
        missOutcome: 'maintenance-fallback',
      };
    }

    // R19 (I2, task 2, h122 + h117/h118/h119/h124): "do we have more X than Y" yes/no count
    // comparisons — decided up front, before any cache probe or model call, same as money/
    // maintenance just above; detectCountComparison only ever returns non-null for the closed set of
    // comparisons it can resolve BOTH sides of with no fuzzy customer-name/address matching (its own
    // doc comment), so a miss here falls straight through to the Tier-1/planner path below exactly
    // like any other question this file doesn't recognize.
    const cmp = detectCountComparison(question_n, today);
    if (cmp) {
      const data = await withTenant(ctxArg, (db) => runCountComparison(db, cmp, { today }));
      if (data) return { handled: true, data, cacheHit: false, modelCalled: false, writes: [] };
    }
    // R7 guardrail item 1 (R7_MEASURE.md: "How many Trane units had a repeat visit within 90 days of
    // installation?" answered with the plain Trane count — the plan silently dropped the relationship). Same
    // idiom as money/maintenance above: CONDITION_CROSS_VISIT_RELATION/CONDITION_RATIO have no
    // CONDITION_PLAN_FIELD entry (analytics.js) and never will (no flat plan can express either), so deciding
    // this before the plan/cache is both cheaper (no wasted Haiku call) and immune to a stale cached wrong
    // answer for the same reason the round-6 fix above was needed. missOutcome routes this through ask.js's
    // "give the agent one shot first" branch (api/ask.js, near tryAgent()) rather than a bare decline, since a
    // real multi-hop agent CAN answer these — this layer must only ever decline to guess, never answer wrong.
    // R21 M2 (deferred list, h106/i006): a bare "callback(s)" mention naming no computable time
    // window at all — unlike CONDITION_CROSS_VISIT_RELATION just below, there is no path to a real
    // answer here, ever (see CONDITION_UNTRACKED_CALLBACK's own doc comment, analytics.js), so this
    // declines immediately with NO missOutcome set — ask.js's "give the agent one shot first" branch
    // only ever runs when missOutcome is present, so leaving it unset (unlike money/maintenance/
    // cross-visit-relation, which all still want that one shot) is what skips it here.
    if (conditionsUpFront.has(CONDITION_UNTRACKED_CALLBACK)) {
      return { handled: true, data: unsupportedConditionAnswer(CONDITION_UNTRACKED_CALLBACK, 'customers'), cacheHit: false, modelCalled: false, writes: [] };
    }
    if (conditionsUpFront.has(CONDITION_CROSS_VISIT_RELATION)) {
      return {
        handled: true, data: unsupportedConditionAnswer(CONDITION_CROSS_VISIT_RELATION, 'customers'), cacheHit: false, modelCalled: false, writes: [],
        missOutcome: 'unsupported-condition', missMeta: { condition: CONDITION_CROSS_VISIT_RELATION },
      };
    }
    if (conditionsUpFront.has(CONDITION_RATIO)) {
      return {
        handled: true, data: unsupportedConditionAnswer(CONDITION_RATIO, 'customers'), cacheHit: false, modelCalled: false, writes: [],
        missOutcome: 'unsupported-condition', missMeta: { condition: CONDITION_RATIO },
      };
    }

    // Item 7 (100-question persona sample, 2026-09-22): "customers with a
    // proposal but no invoice" — a fully deterministic hasDocType/lacksDocType
    // plan, decided the same up-front way as money/maintenance above (never
    // asked of the model — see parseCrossDocCondition's own doc comment in
    // analytics.js for why this is safer than teaching the planner a new
    // vocabulary). A cross-doc phrasing paired with a time window this file
    // can't express against a customers-level plan (e.g. "...but no service
    // this year" — service visits aren't a document type) falls back
    // honestly, naming the unsupported half, rather than silently ignoring it.
    const cross = parseCrossDocCondition(question_n);
    if (cross) {
      if (cross.unsupported) {
        return {
          handled: true, data: crossDocUnsupportedAnswer(cross), cacheHit: false, modelCalled: false, writes: [],
          missOutcome: 'cross-doc-unsupported',
        };
      }
      const crossPlan = {
        entity: 'customers', op: 'list',
        filters: [
          { field: 'hasDocType', op: 'eq', value: cross.hasType },
          ...(cross.lacksType ? [{ field: 'lacksDocType', op: 'eq', value: cross.lacksType }] : []),
        ],
      };
      const data = await withTenant(ctxArg, async (db) => {
        const audienceClause = await analyticsAudienceClause(db, isTeamScopedQuestion(question_n));
        return executeAnalyticsPlan(db, crossPlan, { today, audienceClause });
      });
      if (data) return { handled: true, data, cacheHit: false, modelCalled: false, writes: [] };
      // Fell through (no data) — treat like any other unusable plan and let
      // ask.js's own retrieval+model path take the question instead.
    }

    // ---- Tier 1: exact question text, checked BEFORE the Haiku call -------
    const qHash = analyticsQuestionHash(question_n);
    // noCache: Donovan Scorecard calls (api/_lib/scorecard) always exercise the live planner, never a stored answer.
    const qProbe = noCache ? { row: null, corpusStamp: null } : await withTenant(ctxArg, (db) =>
      getCacheEntry(db, { questionHash: qHash, today, promptVersion })
    );
    if (isCacheHit(qProbe.row, qProbe.corpusStamp)) {
      return { handled: true, data: qProbe.row.answer, cacheHit: true, modelCalled: false, writes: [] };
    }

    // modelCalled: true from here on, REGARDLESS of whether this question
    // ends up `handled` — planAnalyticsQuestion is the one Haiku call this
    // feature makes, and it just ran. Monthly-allowance counting (owner
    // decision, 2026-09-21, see usage.js's isCountableAskSource) keys off
    // this, not off `handled`: a plan that comes back but turns out
    // unusable (invalid, no matching data) still spent a real model call,
    // even though api/ask.js will fall through to retrieval+model right
    // after — that fallback's own model call is the one actually counted
    // for the question (see api/ask.js's own doc comment at its call site),
    // so this file never double-reports one question as two.
    const plan = await planAnalyticsQuestion(question_n, { today, overlay, tenantVocab, withTenant, ctxArg });
    if (!plan) return { ...EMPTY, modelCalled: true };

    // A1(b): a question that named something specific (a street number, a
    // ZIP, a serial fragment) but produced an unfiltered customers list/count
    // plan is a sign the classifier let a single-record question through —
    // fall back to retrieval+model rather than confidently answering "every
    // customer" for what was really a lookup about one of them.
    if (suspiciousUnfilteredCustomerPlan(plan, question_n)) return { ...EMPTY, modelCalled: true };

    // Round 5 item 3: the plan silently dropped a condition the question
    // actually named (email/phone/brand/county/month) — answering the
    // unfiltered query anyway would look confidently right and be wrong
    // (exactly item 2's original bug shape). Answered honestly instead of
    // executed or falling through, and not cached — see missingConditions'
    // own doc comment in analytics.js.
    // Item 4 (100-question persona sample, 2026-09-22): a condition the
    // question named but the model's plan dropped is no longer an automatic
    // honest fallback — buildConditionOverrideFilter first tries to add the
    // filter deterministically (email/phone polarity from "no"/"without" vs
    // "have"/"on file"; brand/county/city/state/zip from the matched word
    // itself). Only a condition it genuinely can't resolve this way still
    // falls back honestly, and only for that one condition.
    const missing = missingConditions(plan, question_n);
    let planWithOverrides = plan;
    if (missing.size > 0) {
      const stillMissing = [];
      const addedFilters = [];
      for (const condition of missing) {
        const override = buildConditionOverrideFilter(condition, question_n, plan.entity);
        if (override) addedFilters.push(override);
        else stillMissing.push(condition);
      }
      if (stillMissing.length > 0) {
        const [condition] = stillMissing;
        return {
          handled: true, data: unsupportedConditionAnswer(condition, plan.entity), cacheHit: false, modelCalled: true, writes: [],
          missOutcome: 'unsupported-condition', missMeta: { condition, plan },
        };
      }
      planWithOverrides = { ...plan, filters: [...(plan.filters ?? []), ...addedFilters] };
    }
    // R19 (I2, task 5): folded into the plan BEFORE hashing (canonicalPlanString, analytics.js) so a
    // customer-scoped and a team-scoped question that happen to build the identical entity/op/filters
    // plan never share a Tier-2 cache row — see that function's own doc comment.
    planWithOverrides = { ...planWithOverrides, teamScoped: isTeamScopedQuestion(question_n) };

    // ---- Tier 2: the plan itself, checked once the plan is known ----------
    // Two different phrasings that resolve to the identical plan reuse one
    // answer here without ever re-running the SQL — see analyticsPlanHash's
    // own doc comment for why this can never collide with a DIFFERENT plan.
    // Hashed with the overrides already applied (planWithOverrides) so a
    // question needing a condition override never shares a cache row with
    // one that didn't.
    const pHash = analyticsPlanHash(planWithOverrides);
    const pProbe = noCache ? { row: null, corpusStamp: null } : await withTenant(ctxArg, (db) =>
      getCacheEntry(db, { questionHash: pHash, today, promptVersion })
    );
    // Item 5: the extended windows' own label ("in Q2 2026", "year to date",
    // ...) — resolveAnyTimeRange re-derives it from the question text rather
    // than threading it through planAnalyticsQuestion/validatePlan, since the
    // label is display-only and never part of the closed plan vocabulary.
    const timeRangeLabel = planWithOverrides.timeRange ? resolveAnyTimeRange(question_n, today)?.label ?? null : null;

    let data;
    if (isCacheHit(pProbe.row, pProbe.corpusStamp)) {
      data = pProbe.row.answer;
    } else {
      data = await withTenant(ctxArg, async (db) => {
        const audienceClause = await analyticsAudienceClause(db, planWithOverrides.teamScoped);
        return executeAnalyticsPlan(db, planWithOverrides, { today, timeRangeLabel, audienceClause });
      });
      if (!data) return { ...EMPTY, modelCalled: true };
    }

    // Both tiers get written on a fresh answer (or a Tier-2 hit that Tier 1
    // hadn't seen yet, so the NEXT identical phrasing hits Tier 1 directly).
    // Corpus stamps for the two probes are computed a few milliseconds apart
    // from the same STAMP_EXPR query; using each probe's own stamp for its
    // own row is correct even in the vanishingly rare case a write landed
    // between them — worst case is one extra cache miss next time, never a
    // wrong answer.
    return {
      handled: true, data, cacheHit: false, modelCalled: true,
      writes: [
        { questionHash: qHash, corpusStamp: qProbe.corpusStamp },
        { questionHash: pHash, corpusStamp: pProbe.corpusStamp },
      ],
    };
  } catch (err) {
    console.error('Analytics question failed, falling through to retrieval+model:', err?.message);
    return EMPTY;
  }
}
