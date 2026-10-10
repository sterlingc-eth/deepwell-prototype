/**
 * Guard for sample-data generators: a generated customer list must never contain
 * the same customer twice (exact name, spelling variants, same phone/email) or the
 * company's own name. Uses the same grouping rules the app's "Review duplicates"
 * uses (api/_lib/integrity.js groupDuplicateCustomers), so a sample set can never
 * hand the app a duplicate the app itself would flag.
 *
 *   import { assertUniqueRoster } from './lib/sampleRoster.mjs';
 *   assertUniqueRoster('plumbing', customers.map((c) => ({ name: c.name, address: c.addr, phone: c.phone, email: c.email })), { ownNames: [CO] });
 *
 * `allow` lists the deliberate look-alike pairs a test set is built to contain
 * (for example a near-miss surname pair), as exact name strings.
 */
import { groupDuplicateCustomers } from '../../api/_lib/integrity.js';

export function rosterProblems(list, { ownNames = [], allow = [] } = {}) {
  const rows = list.map((c, i) => ({ id: String(i), customerNumber: `C-${String(i + 1).padStart(5, '0')}`, name: c.name ?? '', address: c.address ?? '', phone: c.phone ?? '', email: c.email ?? '' }));
  const g = groupDuplicateCustomers(rows, { ownNames });
  const ok = new Set(allow.map((x) => String(x).toLowerCase()));
  const skip = (name) => ok.has(String(name).toLowerCase());
  const problems = [];
  for (const x of g.exact) if (!skip(x.name)) problems.push(`same customer ${x.ids.length} times: ${x.name}`);
  for (const x of g.near) if (!x.ids.map((id) => rows[Number(id)].name).every(skip)) problems.push(`look-alike customers (${x.reasons.join(', ')}): ${[...new Set(x.ids.map((id) => rows[Number(id)].name))].join(' / ')}`);
  for (const s of g.self) problems.push(`the company's own name used as a customer: ${s.name}`);
  return problems;
}

export function assertUniqueRoster(label, list, opts) {
  const problems = rosterProblems(list, opts);
  if (problems.length) throw new Error(`${label}: sample customer list has duplicates:\n  - ${problems.join('\n  - ')}`);
  return list.length;
}

/** Same key, different identity across two sets (loading both into one account would create duplicates). */
export function crossSetConflicts(a, b) {
  const byKey = new Map(a.map((c) => [c.key, c]));
  return b.filter((c) => byKey.has(c.key) && (byKey.get(c.key).name !== c.name || byKey.get(c.key).address !== c.address))
    .map((c) => ({ key: c.key, a: byKey.get(c.key), b: c }));
}
