/**
 * Proactive insights — repeat-failure detectors (R17 contract, item 4).
 *
 *   a. same part replaced 2+ times on one unit — reuses
 *      api/_lib/relations/connect2.js's own exported HANDLERS.partReplacedUnitsCount
 *      (the exact proximity-regex/grouping query the "how many units have had
 *      the X replaced more than once" chat answer already uses) for each of
 *      the closed 6-part list that file's own header documents
 *      (capacitor/contactor/motor/filter/coil/thermostat) rather than
 *      re-deriving the regex or the query.
 *   b. a callback within 30 days of a service visit for the same customer —
 *      built on api/_lib/relations/timeline.js's own exported fetchAllVisits
 *      (the SAME visit list questions.js's callbackSet/callbackCount chat
 *      answers scan) plus addDaysIso; the two-visits-within-N-days predicate
 *      itself is a 5-line pure check with no separate export to reuse (see
 *      questions.js's own local `hasCallback` — not exported). A 1-line
 *      export of that helper from timeline.js/questions.js would let this
 *      become a literal call instead of a parallel copy; noted in the round
 *      report as the hook for whoever owns that file next.
 *
 * Neither HANDLERS.partReplacedUnitsCount nor fetchAllVisits ever opens its
 * own withTenant — both operate directly on `db`, so calling them from
 * inside the insights route's own transaction is safe.
 */
import { TENANT_SQL } from '../../scope.js';
import { HANDLERS as CONNECT2_HANDLERS } from '../../relations/connect2.js';
import { fetchAllVisits, addDaysIso } from '../../relations/timeline.js';

const MAX_ITEMS = 8;
const CALLBACK_WINDOW_DAYS = 30;

/** The same closed 6-part list connect2.js's own anyPartReplacedYesNo uses
 *  for "has this customer had any part replaced twice" — kept as a small,
 *  documented local copy (see this file's own header) rather than importing
 *  an unexported constant. */
const PARTS = ['capacitor', 'contactor', 'motor', 'filter', 'coil', 'thermostat'];

/** Item 4a: units with the same part replaced 2+ times, across every part in
 *  the closed list — dedupes a unit that qualifies on more than one part. */
async function detectRepeatPartFailures(db) {
  const byUnit = new Map(); // unitId -> {unit, parts: Set, docIds: Set}
  for (const part of PARTS) {
    let answer;
    try {
      answer = await CONNECT2_HANDLERS.partReplacedUnitsCount(db, { part });
    } catch {
      continue; // one part's query failing never blocks the others
    }
    const units = (answer?.records ?? []).filter((r) => r.type === 'unit');
    const docIds = (answer?.records ?? []).filter((r) => r.type === 'document' || r.type === 'invoice').map((r) => r.id);
    for (const u of units) {
      const entry = byUnit.get(u.id) ?? { id: u.id, label: u.label, customerId: u.customerId ?? null, parts: new Set(), docIds: new Set() };
      entry.parts.add(part);
      for (const d of docIds) entry.docIds.add(d);
      byUnit.set(u.id, entry);
    }
  }
  if (!byUnit.size) return null;
  const units = [...byUnit.values()].sort((a, b) => b.parts.size - a.parts.size);
  return {
    id: 'repeat-part-failures',
    kind: 'repeat',
    severity: 'medium',
    title: 'Same part replaced more than once',
    count: units.length,
    items: units.slice(0, MAX_ITEMS).map((u) => ({
      label: `${u.label} — ${[...u.parts].join(', ')} replaced more than once`,
      entityId: u.customerId ?? u.id,
      documentIds: [...u.docIds],
    })),
    action: { label: 'Ask about repeat repairs', href: 'ask:Which units have had a part replaced more than once?' },
  };
}

/** Customer id -> display name, for the callback insight's item labels. */
async function customerNames(db, ids) {
  if (!ids.length) return new Map();
  const { rows } = await db.raw(
    `SELECT id, data->>'customer_name' AS name FROM entities WHERE id = ANY($1::uuid[]) AND ${TENANT_SQL}`,
    [ids]
  );
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Same customer's visit list -> doc ids of a qualifying two-visits-within-N-days pair, or null.
 *  Mirrors relations/questions.js's own (unexported) hasCallback exactly — see this file's header. */
function hasCallbackWithin(list, days) {
  for (const a of list) {
    const upper = addDaysIso(a.date, days);
    const b = list.find((x) => x.docId !== a.docId && x.date > a.date && x.date <= upper);
    if (b) return [a.docId, b.docId];
  }
  return null;
}

/** Item 4b: customers with a callback within 30 days of a prior service visit. */
async function detectCallbacks(db, { today }) {
  const visits = await fetchAllVisits(db, today);
  const byCust = new Map();
  for (const v of visits) {
    const list = byCust.get(v.custId) ?? [];
    list.push(v);
    byCust.set(v.custId, list);
  }
  const hits = [];
  for (const [custId, list] of byCust) {
    const pair = hasCallbackWithin(list, CALLBACK_WINDOW_DAYS);
    if (pair) hits.push({ custId, docIds: pair });
  }
  if (!hits.length) return null;
  const names = await customerNames(db, hits.map((h) => h.custId));
  return {
    id: 'callbacks-30d',
    kind: 'repeat',
    severity: 'medium',
    title: 'Callbacks within 30 days',
    count: hits.length,
    items: hits.slice(0, MAX_ITEMS).map((h) => ({
      label: `${names.get(h.custId) ?? 'Unnamed customer'} — repeat visit within ${CALLBACK_WINDOW_DAYS} days`,
      entityId: h.custId,
      documentIds: h.docIds,
    })),
    action: { label: 'Ask about callbacks', href: `ask:Which customers had a callback within ${CALLBACK_WINDOW_DAYS} days of a service visit?` },
  };
}

/** @returns {Promise<object[]>} zero to two insight objects; never throws. */
export async function detectRepeatFailureInsights(db, { today } = {}) {
  const results = await Promise.allSettled([detectRepeatPartFailures(db), detectCallbacks(db, { today })]);
  return results.filter((r) => r.status === 'fulfilled' && r.value).map((r) => r.value);
}
