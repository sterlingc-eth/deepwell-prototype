/**
 * decompose/index.js — Round 11, item 1 (literature #2, query decomposition) entry point.
 *
 * Parses a multi-part / conjunctive / comparison question into typed sub-queries (decompose/clauses.js,
 * pure), executes each deterministically (decompose/entitySets.js's shared-universe condition
 * evaluation, or decompose/compare.js's job-costing comparison), intersects/compares by entity id, and
 * answers with per-condition records + sources. Only ever claims a question when EVERY clause maps to a
 * supported sub-query — parseDecompose already enforces that at the parse stage (an unrecognized clause
 * simply isn't collected, so a question with one recognized and one unrecognized condition never reaches
 * the >= 2 threshold and returns null) and every db-side step below still returns null itself the moment
 * something doesn't resolve, rather than silently dropping a condition and answering partial credit.
 *
 * Wired into api/ask.js's pre-router chain AFTER the relations engine (0.35) and the deterministic history
 * router (0.4), BEFORE the analytics planner — see that file's own "0.42 query decomposition" comment.
 *
 * pure: classifyDecompose     db: runDecompose (one withTenant transaction; every read is TENANT_SQL-scoped)
 */
import { parseDecompose } from './clauses.js';
import { evaluateFilterClauses } from './entitySets.js';
import { runComparison } from './compare.js';
import { todayIso, answerEnvelope } from '../scope.js';
import { attachCitations, customerRecord } from '../citations/records.js';
import { documentRecordsFor } from '../citations/enrich.js';

/** Pure: question (+ the tenant's own industry pack, already resolved by ask.js before this is called —
 *  same convention as classifyRelationsQuestion/classifyDeterministic) -> a decompose intent, or null. */
export function classifyDecompose(question, { pack } = {}) {
  return parseDecompose(question, pack);
}

/** One short, human sentence naming every condition applied — same "list every condition in one basis
 *  sentence" convention compose.js/relations/questions.js's own multi-hop handlers already use. */
function describeClause(cond) {
  switch (cond.type) {
    case 'brand': return `have a ${cond.values.join(' or ')} unit`;
    case 'ageOlder': return `have a unit installed more than ${cond.years} years ago`;
    case 'ageOlderDays': return `have a unit installed more than ${cond.days} days ago`;
    case 'warrantyStatus':
      return cond.status === 'expired' ? 'have an expired warranty'
        : cond.status === 'expiring' ? 'have a warranty expiring within the next year'
        : 'have an active warranty';
    case 'hasDocType': return `have a ${cond.phrase} on file`;
    case 'lacksDocType': return `have no ${cond.phrase} on file`;
    case 'geoCity': return `have a service address in ${cond.value}`;
    case 'noEmail': return 'have no email on file';
    case 'unitCountGt': return `have more than ${cond.n} unit${cond.n === 1 ? '' : 's'}`;
    case 'distinctBrandsGte': return `have units from ${cond.n} or more different brands`;
    case 'technician': return `have been serviced by ${cond.name}`;
    case 'noVisitSinceYear': return `have had no service visit since ${cond.year}`;
    case 'callback':
      if (cond.scope === 'thisYear') return 'had a callback this year';
      if (cond.scope === 'sinceYear') return `had a callback since ${cond.year}`;
      return `had a callback within ${cond.days ?? 30} days of a service visit`;
    default: return null;
  }
}

function describeClauses(conditions) {
  return conditions.map(describeClause).filter(Boolean).join(' and ');
}

/** The conjunctive-filter (AND) side of decomposition: count/list customers matching every clause. */
async function runFilter(db, intent, { today }) {
  const t = todayIso(today);
  const { matched, callbackDocIds } = await evaluateFilterClauses(db, intent.conditions, { today: t });
  const sentence = describeClauses(intent.conditions);
  const named = matched.filter((c) => c.customerName).sort((a, b) => a.customerName.localeCompare(b.customerName));
  const n = named.length;
  const basis = `Checked every customer on file against: ${sentence}.`;
  const custRecords = named.map((c) => customerRecord({ id: c.id, customer_name: c.customerName, service_address: c.serviceAddress }));
  const docRecords = callbackDocIds.length ? await documentRecordsFor(db, callbackDocIds) : [];
  // claimedCount's honesty check (citations/records.js's attachCitations) assumes every record is the
  // same countable unit as the stated number — a mix of customer records + supporting callback-document
  // records is a DIFFERENT total, so claimedCount is omitted whenever docRecords is non-empty (same
  // convention relations/questions.js's own callbackSet/twoTechSet already use for the identical mix),
  // rather than firing a false "figure vs records" mismatch note over two counts that were never meant
  // to agree.
  const claimedCount = docRecords.length ? null : n;

  if (intent.op === 'count') {
    return attachCitations(answerEnvelope({
      text: `${n} customer${n === 1 ? '' : 's'} ${sentence}.`,
      facts: [{ label: 'Customers matching', value: String(n) }],
    }), { records: [...custRecords, ...docRecords], total: n + docRecords.length, claimedCount, basis });
  }

  const names = named.map((c) => c.customerName);
  const shown = names.slice(0, 40);
  const text = n === 0
    ? `No customers ${sentence}.`
    : `${n} customer${n === 1 ? '' : 's'} ${sentence}: ${shown.join(', ')}${n > shown.length ? `, and ${n - shown.length} more` : ''}.`;
  return attachCitations(answerEnvelope({ text, facts: [{ label: 'Customers matching', value: String(n) }] }), {
    records: [...custRecords, ...docRecords], total: n + docRecords.length, claimedCount, kind: n ? 'basis' : 'searched', basis,
  });
}

/**
 * @param db     a withTenant() store
 * @param intent classifyDecompose's result
 * @returns an /api/ask `data` object, or null (fall through to the normal chain)
 */
export async function runDecompose(db, intent, { today } = {}) {
  if (!intent) return null;
  if (intent.mode === 'compare') return runComparison(db, intent, { today });
  if (intent.mode === 'filter') return runFilter(db, intent, { today });
  return null;
}

/** Convenience one-shot entry (mirrors relations/questions.js's answerRelationsQuestion) for a caller
 *  that hasn't already resolved the tenant's industry pack. api/ask.js uses classifyDecompose/runDecompose
 *  directly (it already has `pack` in scope), so this is mainly for scripts/tests. */
export async function answerDecomposeQuestion({ withTenant, ctxArg, question, today, pack }) {
  const intent = classifyDecompose(question, { pack });
  if (!intent) return null;
  try {
    return await withTenant(ctxArg, (db) => runDecompose(db, intent, { today }));
  } catch (err) {
    console.error('decompose: answer failed:', err?.name ?? 'error');
    return null;
  }
}
