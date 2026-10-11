/**
 * dql/custWord.js - the word a kind of business uses for the people it bills, so an answer says "patients" in a clinic, "tenants" for a landlord, "donors" at a
 * nonprofit and "clients" at a law office or a contractor. A business with no kind chosen, an HVAC shop and anything not listed here keep "customer".
 */
const WORDS = { legal: 'client', medical: 'patient', 'medical-admin': 'patient', nonprofit: 'donor', property: 'tenant', construction: 'client' };

/** @returns {{one: string, many: string}} */
export function customerWordFor(kind) {
  const one = WORDS[String(kind ?? '').toLowerCase()] ?? 'customer';
  return { one, many: `${one}s` };
}

const cache = new WeakMap();
/** Reads the organization's kind once per store object. Never throws. */
export async function customerWordForDb(db) {
  if (cache.has(db)) return cache.get(db);
  let kind = null;
  try { const { rows } = await db.raw("SELECT settings->>'industry' AS i FROM tenants WHERE id = (current_setting('app.tenant_id', true))::uuid", []); kind = rows?.[0]?.i ?? null; } catch { kind = null; }
  const w = customerWordFor(kind);
  cache.set(db, w);
  return w;
}
