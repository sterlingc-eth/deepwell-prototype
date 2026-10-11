/**
 * dql/plain.js - a plain count or list of one kind of record, with no condition and no period ("how many units", "customers with a maintenance
 * agreement"), is what the existing lanes (meta router, analytics, decompose) have always answered, in the wording the owner knows. The engine can
 * read such a question (parseDql still returns the plan), but the router (classifyAll) leaves it to those lanes.
 */
export function isPlainInventory(plan) {
  if (!plan || !['count', 'list', 'exists_yes_no'].includes(plan.op)) return false;
  if (plan.time || plan.sort || plan.distinct || (plan.groupBy ?? []).length) return false;
  return (plan.filters ?? []).every((x) => x.relPresence);
}
