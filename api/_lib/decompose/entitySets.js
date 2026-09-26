/**
 * decompose/entitySets.js — Round 11, item 1: the DB half of the conjunctive-filter side of query
 * decomposition. Evaluates decompose/clauses.js's typed conditions as independent, deterministic
 * "sub-queries" over one shared, tenant-scoped customer universe and INTERSECTS the results (every
 * condition must hold for the same customer — same semantics as compose.js's own AND, extended with two
 * condition types compose.js has no vocabulary for at all: `callback` (a cross-document visit-timeline
 * condition, reusing relations/timeline.js's own visit fetch — see that file's own header for why a
 * VISIT is defined exactly the way the scorecard oracle defines it) and `noVisitSinceYear` (an absolute-
 * date cutoff, as opposed to compose.js's own rolling-N-month `lacksRecentService`).
 *
 * Shared condition types (brand/ageOlder/warrantyStatus/hasDocType/lacksDocType/geoCity/noEmail/
 * unitCountGt/distinctBrandsGte/technician/lacksRecentService/neverServiced) are evaluated by compose.js's
 * OWN exported `matchesCondition` against compose.js's OWN exported `fetchUniverse` — one shared
 * definition of "does this customer satisfy X", never a second one that could quietly disagree with it.
 *
 * db: evaluateFilterClauses. No model call.
 */
import { fetchUniverse, matchesCondition } from '../compose.js';
import { fetchAllVisits, addDaysIso } from '../relations/timeline.js';

export const DEFAULT_CALLBACK_WINDOW_DAYS = 30;

function groupByCust(visits) {
  const map = new Map();
  for (const v of visits) {
    const list = map.get(v.custId) ?? [];
    list.push(v);
    map.set(v.custId, list);
  }
  for (const list of map.values()) list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return map;
}

/**
 * A customer's own dated visit list (ascending, `{docId, date, tech}`) -> the doc ids of a qualifying
 * (earlier, later) callback pair, or null. `days` defaults to DEFAULT_CALLBACK_WINDOW_DAYS when the
 * question named no explicit window (a bare "had a callback this year"/"...since 2024"). `scope` further
 * restricts WHEN the later (callback) visit itself must fall:
 *   'anytime'   — no restriction beyond the day window (an explicit "within N days" question).
 *   'thisYear'  — the callback visit's own date must be in `today`'s calendar year.
 *   'sinceYear' — the callback visit's own date must be on or after `${year}-01-01`.
 */
export function qualifyingCallback(list, { days, scope, year }, today) {
  const window = Number.isFinite(days) ? days : DEFAULT_CALLBACK_WINDOW_DAYS;
  const yearPrefix = String(today ?? '').slice(0, 4);
  const cutoff = scope === 'sinceYear' ? `${year}-01-01` : null;
  for (const a of list) {
    const upper = addDaysIso(a.date, window);
    const b = list.find((x) => x.docId !== a.docId && x.date > a.date && x.date <= upper);
    if (!b) continue;
    if (scope === 'thisYear' && !b.date.startsWith(yearPrefix)) continue;
    if (scope === 'sinceYear' && b.date < cutoff) continue;
    return [a.docId, b.docId];
  }
  return null;
}

/** True when customer `c` (compose.js's fetchUniverse shape) satisfies `cond`, for the two condition
 *  types compose.js's own matchesCondition doesn't know. Falls through to matchesCondition for every
 *  other (shared) condition type. */
function conditionMatches(c, cond, ctx) {
  if (cond.type === 'noVisitSinceYear') {
    const cutoff = `${cond.year}-01-01`;
    return !c.serviceDates.some((d) => d >= cutoff);
  }
  if (cond.type === 'callback') {
    return Boolean(qualifyingCallback(ctx.visitsByCust?.get(c.id) ?? [], cond, ctx.today));
  }
  // "installed more than N days ago" — a day-accurate cutoff (today - N days), distinct from
  // compose.js's own year-truncated 'ageOlder'; requires a full YYYY-MM-DD installDate (never a
  // year-only or missing one guessed into a date, exactly like the scorecard oracle's own
  // installation_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' guard).
  if (cond.type === 'ageOlderDays') {
    const cutoff = addDaysIso(ctx.today, -cond.days);
    return c.equipment.some((e) => e.installDate && /^\d{4}-\d{2}-\d{2}/.test(e.installDate) && e.installDate.slice(0, 10) <= cutoff);
  }
  return matchesCondition(c, cond, { today: ctx.today, thisYear: ctx.thisYear });
}

/**
 * Evaluates every condition against the shared universe and returns the customers matching ALL of them,
 * plus the qualifying-visit document ids for any `callback` condition (gathered only for customers that
 * end up in the FINAL matched set, so a customer eliminated by some other condition never contributes a
 * document citation to an answer it isn't actually part of).
 *
 * @returns {Promise<{matched: object[], callbackDocIds: string[]}>}
 */
export async function evaluateFilterClauses(db, conditions, { today }) {
  const universe = await fetchUniverse(db, today);
  const thisYear = Number(String(today).slice(0, 4));
  const needsCallback = conditions.some((c) => c.type === 'callback');
  let visitsByCust = null;
  if (needsCallback) visitsByCust = groupByCust(await fetchAllVisits(db, today));
  const ctx = { today, thisYear, visitsByCust };

  const matched = universe.filter((c) => conditions.every((cond) => conditionMatches(c, cond, ctx)));

  const callbackDocIds = new Set();
  if (needsCallback) {
    const cbCond = conditions.find((c) => c.type === 'callback');
    for (const c of matched) {
      const hit = qualifyingCallback(visitsByCust.get(c.id) ?? [], cbCond, today);
      if (hit) for (const id of hit) callbackDocIds.add(id);
    }
  }
  return { matched, callbackDocIds: [...callbackDocIds] };
}
