/**
 * dql/ordinal.js - "the second largest invoice", "third most recent", "2nd busiest month", "runner-up customer", "next-to-last invoice".
 *
 * The older lanes drop the ordinal and answer with the extreme (round 7: 30 wrong answers, all of them the largest / the grand total).
 * Here the ordinal is read off the question (the rest of the question then reads as the plain extreme), and the plan that comes back
 * for that extreme is turned into "the Nth" of the same ranking (applyOrdinal). Pure: no database, no model.
 *
 * Ties: a tie that starts exactly at place N is stated ("tied for second place"); a tie among the places BEFORE N makes "the Nth" mean
 * two different things (the second row, or the second distinct value), so the question is released (nthOf says "ambiguous").
 */

const ORD_WORDS = ['second', '2nd', 'third', '3rd', 'fourth', '4th', 'fifth', '5th', 'sixth', '6th', 'seventh', '7th', 'eighth', '8th', 'ninth', '9th', 'tenth', '10th'];
const ORD_N = { second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, fifth: 5, '5th': 5, sixth: 6, '6th': 6, seventh: 7, '7th': 7, eighth: 8, '8th': 8, ninth: 9, '9th': 9, tenth: 10, '10th': 10 };
const RANK_WORDS = 'most\\s+recent|least\\s+recent|largest|biggest|highest|greatest|smallest|lowest|least|fewest|busiest|slowest|quietest|costliest|priciest|cheapest|best|worst|newest|latest|oldest|earliest|most';
const ORD_RANK = new RegExp(`(?<![a-z0-9$.-])(${ORD_WORDS.join('|')})[\\s-]+(${RANK_WORDS})(?![a-z0-9-])`, 'i');
const ORD_RANK_G = new RegExp(ORD_RANK.source, 'gi');
const RUNNER = /(?<![a-z0-9$.-])runner[\s-]?ups?(?![a-z0-9-])/i;
const NEXT_LAST = /(?<![a-z0-9$.-])(?:(?:next|second)[\s-]to[\s-]last|second[\s-]last|penultimate|last\s+but\s+one)(?![a-z0-9-])/i;

/** the trailing "and who is it for" of "the second highest invoice and who is it for" */
export const ORD_WHO_TAIL = /[\s,]+(?:and|plus|&)?\s*(?:who(?:'s|s|\s+is|\s+was)\s+(?:it|that|this|the\s+(?:invoice|bill|one))\s+(?:for|to|from|billed\s+to|made\s+out\s+to)|(?:for|to)\s+whom|who\s+(?:is|was)\s+(?:the\s+)?(?:customer|client))\s*[?.!]*$/i;
const NUM_ORD = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const HASH_ORD = /(?<![a-z0-9$.-])(?:#|no\.?|nos?\.?|number|num\.?)\s*(\d{1,2})(?:st|nd|rd|th)?\s+(?=(?:(?:top|best|biggest|largest)\s+)?(?:customers?|clients?|tenants?|patients?|donors?|members?|vendors?|suppliers?|techs?|technicians?|accounts?|invoices?)\b)/i;
const HASH_ORD_G = new RegExp(HASH_ORD.source, 'gi');
/** "#2 customer by revenue" / "number 2 client" / "No. 3 tech" -> "second biggest customer by revenue" (the ordinal forms the rest of this file reads). */
export function hashOrdinalRewrite(text) {
  return String(text ?? '').replace(HASH_ORD_G, (m, d, off, all) => {
    const n = Number(d); if (!(n >= 1 && n <= 10)) return m;
    const rest = String(all).slice(off + m.length);
    const rank = /^(?:techs?|technicians?)\b/i.test(rest) ? 'busiest' : 'biggest';
    return n === 1 ? `${rank} ` : `${NUM_ORD[n]} ${rank} `;
  });
}

/** True when the text carries an ordinal ranking expression (used by the router to keep older lanes from answering with the extreme). */
export function hasOrdinalRank(text) {
  const s = hashOrdinalRewrite(String(text ?? ''));
  return ORD_RANK.test(s) || RUNNER.test(s) || NEXT_LAST.test(s);
}

/** {text, n} with the ordinal taken out ("second largest invoice" -> "largest invoice", n 2); null when there is none; {bad:true} when it is not a single clear one. */
export function readOrdinal(text) {
  const s = hashOrdinalRewrite(String(text ?? ''));
  const hits = [...s.matchAll(ORD_RANK_G)];
  const runner = RUNNER.test(s); const nl = NEXT_LAST.test(s);
  const count = hits.length + (runner ? 1 : 0) + (nl ? 1 : 0);
  if (!count) return null;
  if (count > 1) return { bad: true };
  if (hits.length) return { text: s.replace(ORD_RANK, (_, o, r) => r), n: ORD_N[hits[0][1].toLowerCase()], lead: hits[0][2].toLowerCase().replace(/\s+/g, ' ') };
  if (runner) return { text: s.replace(RUNNER, 'biggest'), n: 2, lead: 'biggest' };
  return { text: s.replace(NEXT_LAST, 'latest'), n: 2, lead: 'latest' };
}

/** "which tech has the most jobs" (the ordinal already taken out) -> "which tech is the busiest": the same ranking of technicians, in the words the engine ranks by. */
export function ordinalTechRewrite(text) {
  return String(text ?? '').replace(/\b(which|what)\s+(tech|techs|technician|technicians|mechanic|mechanics|plumber|electrician|installer)\s+(?:has|have|had|did|does)\s+(?:the\s+)?most\s+(?:jobs?|work\s+orders?|tickets?|calls?)\b/i, (_, q, t) => `${q} ${t.replace(/s$/i, '')} is the busiest`);
}

const NTH = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
export const nthWord = (n) => NTH[n] ?? `${n}th`;

const same = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-9 : a === b);

/**
 * Place n (1-based) of a ranking. `vals` are the ranked values, best first (ties adjacent). Returns
 *   {status:'short'}                       fewer than n items
 *   {status:'ambiguous'}                   a tie before place n (or a tie reaching back to it)
 *   {status:'ok', from, to}                the items at place n: indexes [from, to) of the ranking (more than one = a tie that starts at place n)
 */
export function nthOf(vals, n) {
  if (!Array.isArray(vals) || vals.length < n) return { status: 'short', have: vals?.length ?? 0 };
  const earlier = vals.slice(0, n - 1);
  for (let i = 0; i < earlier.length; i++) {
    if (same(earlier[i], vals[n - 1])) return { status: 'ambiguous' };
    if (i > 0 && same(earlier[i], earlier[i - 1])) return { status: 'ambiguous' };
  }
  let to = n; while (to < vals.length && same(vals[to], vals[n - 1])) to++;
  return { status: 'ok', from: n - 1, to };
}

/**
 * The plan the plain extreme produced, turned into the Nth of the same ranking; null when the plan is not a ranking this can place (release).
 */
export function applyOrdinal(plan, n) {
  if (!plan || !(n >= 2 && n <= 10)) return null;
  const op = plan.op;
  if ((op === 'max' || op === 'min') && plan.measure && plan.entity && !plan.groupBy?.length) {
    return { ...plan, op: op === 'max' ? 'top_n' : 'bottom_n', measure: { ...plan.measure, agg: 'row' }, limit: n, dir: op === 'max' ? 'desc' : 'asc', rank: 'rows', nth: n };
  }
  if ((op === 'top_n' || op === 'bottom_n') && plan.rank === 'groups' && plan.limit === 1) return { ...plan, limit: n, nth: n };
  if ((op === 'latest' || op === 'first_ever') && !plan.ask && plan.sortField) return { ...plan, nth: n };
  if (op === 'tm_series' && plan.mode === 'peak') return { ...plan, nth: n };
  return null;
}
