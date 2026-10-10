/**
 * Proactive insights — repeat-failure detectors (R17 contract, item 4).
 *
 *   a. same part replaced 2+ times on one unit — api/_lib/relations/connect2.js's
 *      exported repeatPartUnits (the same function Donovan's "which units have had a
 *      part replaced more than once" answer runs), so the two never disagree.
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
 * Neither repeatPartUnits nor fetchAllVisits ever opens its
 * own withTenant — both operate directly on `db`, so calling them from
 * inside the insights route's own transaction is safe.
 */
import { TENANT_SQL } from '../../scope.js';
import { repeatPartUnits } from '../../relations/connect2.js';
import { fetchAllVisits, addDaysIso } from '../../relations/timeline.js';

const MAX_ITEMS = 8;
const CALLBACK_WINDOW_DAYS = 30;

/** Item 4a: units with the same part replaced 2+ times. Uses connect2.js's exported repeatPartUnits - the very function
 *  Donovan's chat answer runs - so the dashboard number and the answer cannot drift. */
async function detectRepeatPartFailures(db) {
  let found;
  try {
    found = await repeatPartUnits(db);
  } catch {
    return null;
  }
  const docIds = [...new Set((found.docs ?? []).map((d) => d.id))];
  const byUnit = new Map();
  for (const u of found.units ?? []) {
    byUnit.set(u.rec.id, { id: u.rec.id, label: u.rec.label, customerId: u.rec.customerId ?? null, parts: u.parts, docIds: new Set(docIds) });
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
