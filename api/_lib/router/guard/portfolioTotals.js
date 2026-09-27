/**
 * Round 20 (J1) — the ONE extra signal check.js needs that no already-available intent/plan object can
 * give it: whether a bare "You have N X." answer's N happens to equal the tenant's ENTIRE portfolio for
 * that entity, which is the fingerprint of F1's dominant root cause (r19_blind3_clusters.json) — a
 * time/negation/comparator constraint the question named got silently dropped and the plan executed
 * unfiltered. Mirrors api/ask.js's own private countFor()/COUNT_LABEL exactly (same TENANT_SQL predicate,
 * same table/entity mapping) — duplicated rather than imported because countFor is a module-private helper
 * inside the api/ask.js entry-point file, never exported for reuse; see this round's final report for the
 * one-line "export it instead" hook the lead can take if a future round wants to collapse the two.
 *
 * Deliberately narrow: only the entities an analytics bare-count answer ever actually names (customers,
 * equipment, documents, invoices, warranties) — never called for anything else. Fails OPEN (returns null on
 * any DB error) so a probe failure only means the guard has one less signal, never a 500 or a wrongly
 * blocked answer.
 */
import { TENANT_SQL } from '../../scope.js';

const ENTITY_WHERE = {
  customers: `entity_type = 'customer' AND ${TENANT_SQL}`,
  equipment: `entity_type = 'equipment' AND ${TENANT_SQL}`,
  documents: TENANT_SQL,
  invoices: `document_type = 'invoice' AND ${TENANT_SQL}`,
  warranties: `document_type IN ('warranty-registration','warranty') AND ${TENANT_SQL}`,
  // Mirrors analytics.js's own bare serviceVisits query (buildAnalyticsSQL's non-documents branch): one
  // row per extractions.field_key = 'service_date', the same base set an unfiltered "how many
  // jobs/visits/service calls" bare count runs over.
  serviceVisits: `field_key = 'service_date' AND ${TENANT_SQL}`,
};
const ENTITY_TABLE = {
  customers: 'entities', equipment: 'entities', documents: 'documents', invoices: 'documents', warranties: 'documents',
  serviceVisits: 'extractions',
};

/** {withTenant, ctxArg} (same shape api/ask.js already threads through every other router call), entityKey
 *  (one of ENTITY_WHERE's keys) -> the tenant's current total row count for that entity, or null (unknown
 *  entity key, or the probe itself failed — never thrown). */
export async function fetchPortfolioTotal({ withTenant, ctxArg }, entityKey) {
  const where = ENTITY_WHERE[entityKey];
  if (!where || typeof withTenant !== 'function') return null;
  try {
    return await withTenant(ctxArg, async (db) => {
      const { rows } = await db.raw(`SELECT COUNT(*)::int AS n FROM ${ENTITY_TABLE[entityKey]} WHERE ${where}`, []);
      const n = rows?.[0]?.n;
      return Number.isFinite(n) ? n : null;
    });
  } catch {
    return null;
  }
}

export const PORTFOLIO_ENTITY_KEYS = Object.keys(ENTITY_WHERE);
