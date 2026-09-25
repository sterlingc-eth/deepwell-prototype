/**
 * TEAM H (2026-09-24): WEEKLY GAP REPORT — clusters still-failing misses and
 * scorecard failures across every tenant by CAPABILITY, industry-agnostic
 * (the categories below name a kind of failure Donovan had, never an
 * industry-specific word), so an engineer reviewing it sees "money status
 * unknown: 14 shops, 3 industries" instead of one undifferentiated pile of
 * miss rows.
 *
 * Three layers, same split every other file in this loop uses:
 *   - classifyCapability / clusterFailures / fixSpecFor — pure, no DB.
 *   - buildGapReport() — the cross-tenant read (reuses the EXISTING
 *     list_ask_misses_window SECURITY DEFINER function for misses, plus a
 *     new list_scorecard_failures_window for scorecard failures — both
 *     never carry raw question text: ask_misses only ever exposes its own
 *     already-redacted question_normalized, and a scorecard question is
 *     always the exam's own generic wording, never a customer's data — see
 *     scorecard/store.js's own doc comment).
 *   - store/deliver — persisted via donovan_gap_reports (optional migration
 *     32; tolerant of its absence, same "warn once, return empty" idiom as
 *     every other learning store file).
 */
import { getPool } from '../recordsStore.js';

/* ------------------------------------------------------------------ pure: classify + cluster */

/** outcome/category/detectedConditions -> one of a small, industry-agnostic
 *  set of CAPABILITY tags. Pure. Unknown/unrecognized inputs fall back to
 *  'other' rather than being dropped — every failure lands in some cluster. */
export function classifyCapability({ outcome, category, detectedConditions } = {}) {
  const conds = new Set(Array.isArray(detectedConditions) ? detectedConditions : []);
  if (outcome === 'money-fallback' || conds.has('money')) return 'money-status-unknown';
  if (outcome === 'cross-doc-unsupported' || conds.has('cross-doc')) return 'multi-hop';
  if (outcome === 'contact-lookup-zero' || outcome === 'contact-lookup-ambiguous') return 'contact-lookup';
  if (outcome === 'doc-lookup-zero') return 'doc-lookup';
  if (outcome === 'analytics-fallthrough') return 'content-count';
  if (outcome === 'maintenance-fallback' || outcome === 'unsupported-condition') return 'industry-field-missing';
  if (outcome === 'scorecard-fail') {
    if (category === 'money' || category === 'financials') return 'money-status-unknown';
    if (category === 'count' || category === 'aggregate') return 'content-count';
    if (category === 'multi-hop' || category === 'cross-doc') return 'multi-hop';
    return 'scorecard-other';
  }
  if (outcome === 'no-answer' || outcome === 'agent-no-answer') return 'no-answer';
  if (outcome === 'user-marked-wrong') return 'user-corrected';
  return 'other';
}

/** A short, deterministic fix-spec paragraph per capability — a starting
 *  point for the weekly human-reviewed engineering session, not a final
 *  spec. Pure. */
const FIX_SPEC_BY_CAPABILITY = {
  'money-status-unknown': 'Donovan cannot yet say whether an amount is paid/overdue/unknown with confidence for these shops. Fix: extend the financials extraction/oracle to cover the document types these misses came from, and add an honest "status unknown" answer instead of a fallback.',
  'content-count': 'A counting/aggregate question fell through to the generic fallback instead of an analytics plan. Fix: extend analytics.js\'s plan vocabulary (entity/op/filters) to cover the phrasing in these examples, and add a few-shot example once one grounded answer exists.',
  'multi-hop': 'The question needs facts joined across more than one document/entity and the current single-hop tools could not do it. Fix: add a bounded multi-step tool (or a pre-built join view) for this shape, scoped read-only like every other agent tool.',
  'contact-lookup': 'A customer/contact lookup matched zero or more than one record. Fix: improve name/address disambiguation (fuzzy match + a clarifying follow-up) for the shapes seen here.',
  'doc-lookup': 'A direct document-type lookup found nothing. Fix: check whether the document type/synonym is missing from the pack, or the extraction for that type needs work.',
  'industry-field-missing': 'The question names a field this industry pack does not define yet. Fix: add the field (and its synonyms/abbreviations) to the affected pack(s).',
  'scorecard-other': 'A golden-exam question failed for a reason outside the categories above. Fix: read the individual failing question in the Scorecard tab before writing a spec.',
  'no-answer': 'Donovan had nothing grounded to say at all. Fix: check whether the corpus genuinely lacks this data, or whether a retrieval/tool gap is hiding it.',
  'user-corrected': 'A real customer marked a live answer wrong. Fix: highest priority — read the replay outcome recorded for each example before anything else this week.',
  other: 'Uncategorized. Fix: read the individual examples before writing a spec.',
};

export function fixSpecFor(capability) {
  return FIX_SPEC_BY_CAPABILITY[capability] ?? FIX_SPEC_BY_CAPABILITY.other;
}

/**
 * Cluster a flat list of failure rows by capability.
 * @param {Array<{tenantId?:string, industry?:string, outcome?:string, category?:string, detectedConditions?:unknown, question?:string, count?:number}>} rows
 * @param {number} [maxExamplesPerCluster]
 * @returns {Array<{capability:string, count:number, tenantCount:number, industries:string[], examples:string[], fixSpec:string}>} sorted by count desc
 */
export function clusterFailures(rows, maxExamplesPerCluster = 5) {
  const clusters = new Map();
  for (const r of rows ?? []) {
    const capability = classifyCapability(r);
    const c = clusters.get(capability) ?? { capability, count: 0, tenants: new Set(), industries: new Set(), examples: [] };
    c.count += Number(r.count) || 1;
    if (r.tenantId) c.tenants.add(r.tenantId);
    if (r.industry) c.industries.add(r.industry);
    const example = String(r.question ?? '').trim();
    if (example && c.examples.length < maxExamplesPerCluster && !c.examples.includes(example)) c.examples.push(example);
    clusters.set(capability, c);
  }
  return [...clusters.values()]
    .map((c) => ({
      capability: c.capability, count: c.count, tenantCount: c.tenants.size,
      industries: [...c.industries].sort(), examples: c.examples, fixSpec: fixSpecFor(c.capability),
    }))
    .sort((a, b) => b.count - a.count);
}

/* ------------------------------------------------------------------ cross-tenant read */

let warnedMissingSql = false;
function warnOnce(context, err) {
  if (warnedMissingSql) return;
  warnedMissingSql = true;
  console.warn(`gap-report: ${context} failed (migration may not be applied yet):`, err?.message);
}

/** Cross-tenant still-failing ask_misses in [from,to) (reuses the EXISTING
 *  list_ask_misses_window from M3-config/25-miss-digest.sql — no new SQL). */
async function readMissRows(from, to) {
  try {
    const { rows } = await getPool().query('SELECT * FROM list_ask_misses_window($1,$2)', [from, to]);
    return rows.map((r) => ({
      tenantId: r.tenant_id, outcome: r.outcome, question: r.question_normalized,
      detectedConditions: r.detected_conditions, count: Number(r.count) || 1,
    }));
  } catch (err) {
    warnOnce('list_ask_misses_window', err);
    return [];
  }
}

/** Cross-tenant scorecard failures in [from,to) (M3-config/32's
 *  list_scorecard_failures_window — tolerant of migration 30/32 not being
 *  applied). No customer data: scorecard questions are always the exam's own
 *  generic wording (scorecard/store.js's own doc comment). */
async function readScorecardFailureRows(from, to) {
  try {
    const { rows } = await getPool().query('SELECT * FROM list_scorecard_failures_window($1,$2)', [from, to]);
    return rows.map((r) => ({
      tenantId: r.tenant_id, outcome: 'scorecard-fail', category: r.category, question: r.question, count: Number(r.count) || 1,
    }));
  } catch (err) {
    warnOnce('list_scorecard_failures_window', err);
    return [];
  }
}

export const GAP_REPORT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Build this week's gap report from the last GAP_REPORT_WINDOW_MS of
 * cross-tenant misses + scorecard failures. `industryByTenant` is an
 * optional {tenantId -> industry id} map (autopilot.js has this from the
 * tenants it just processed); tenants not in it are left out of the
 * `industries` breakdown for their cluster, never dropped from the count.
 * @param {{now?: Date, industryByTenant?: Record<string,string>}} [opts]
 */
export async function buildGapReport({ now = new Date(), industryByTenant = {} } = {}) {
  const to = now;
  const from = new Date(now.getTime() - GAP_REPORT_WINDOW_MS);
  const [missRows, scorecardRows] = await Promise.all([readMissRows(from, to), readScorecardFailureRows(from, to)]);
  const rows = [...missRows, ...scorecardRows].map((r) => ({ ...r, industry: industryByTenant[r.tenantId] }));
  return {
    weekStart: from.toISOString().slice(0, 10),
    generatedAt: to.toISOString(),
    totalFailures: rows.reduce((n, r) => n + (Number(r.count) || 1), 0),
    clusters: clusterFailures(rows),
  };
}

/* ------------------------------------------------------------------ store (optional migration 32) */

/** Persists (upserts by ISO week-start date) and returns the report's id, or null on failure. */
export async function storeGapReport(report) {
  try {
    const { rows } = await getPool().query('SELECT gap_report_upsert($1,$2) AS id', [report.weekStart, JSON.stringify(report)]);
    return rows[0]?.id ?? null;
  } catch (err) {
    warnOnce('gap_report_upsert', err);
    return null;
  }
}

/** The most recently stored gap report, or null (never generated, or migration not applied). */
export async function latestGapReport() {
  try {
    const { rows } = await getPool().query('SELECT * FROM gap_report_latest()');
    return rows[0]?.report ?? null;
  } catch (err) {
    warnOnce('gap_report_latest', err);
    return null;
  }
}

/** Up to `limit` past reports, newest first (week_start, generated_at only — not the full clusters payload). */
export async function listGapReports(limit = 12) {
  try {
    const { rows } = await getPool().query('SELECT * FROM gap_report_list($1)', [Math.max(1, Math.min(52, limit))]);
    return rows.map((r) => ({ id: r.id, weekStart: r.week_start, generatedAt: r.generated_at }));
  } catch (err) {
    warnOnce('gap_report_list', err);
    return [];
  }
}
