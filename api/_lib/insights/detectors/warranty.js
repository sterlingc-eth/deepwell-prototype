/**
 * Proactive insights — warranty detector (R17 contract, item 1).
 *
 * Reuses warrantyRules.js's own pure functions directly — never re-derives
 * the coverage/registration math. Per the R16 fix (api/_lib/analytics.js's
 * own module header on warrantyStatusOf/registrationActionNeededOf): a
 * unit's COVERAGE expiry and its REGISTRATION paperwork deadline are two
 * independent signals, so this file reports them as two separate insights
 * rather than folding them into warrantyRules.alertTier()'s combined
 * reminder-UI tiers (that combined ordering is right for the Dashboard's own
 * alert cards — src/screens/DashboardScreen.tsx — but wrong here, where the
 * two need distinct titles/questions).
 *
 *   - coverage expiring within `EXPIRING_WITHIN_DAYS` (60) days, via
 *     daysBetween(today, warranty.expires) — the same date arithmetic
 *     warrantyStatusOf() uses, just a tighter window than its own 365-day
 *     "expiring" bucket.
 *   - registrationActionNeededOf(warranty, today) — the registration-window
 *     signal, unchanged from warrantyRules.alertTier()'s
 *     'unregistered-window-closing' tier.
 *
 * No model call. Tenant-scoped via the caller's own transaction (`db`) —
 * this file never opens its own withTenant.
 */
import { TENANT_SQL } from '../../scope.js';
import { daysBetween, isPlausibleToday } from '../../warrantyRules.js';
import { registrationActionNeededOf } from '../../analytics.js';

const EXPIRING_WITHIN_DAYS = 60;
const MAX_ITEMS = 8;

/** Every equipment entity's warranty-relevant fields, tenant-scoped, plus the document(s) it was
 *  extracted from/linked to (for citations) — one row per unit, never per document. */
async function fetchEquipmentRows(db) {
  const { rows } = await db.raw(
    `SELECT e.id, e.customer_id, e.data->'warranty' AS warranty,
            e.data->>'serial_number' AS serial_number, e.data->>'model' AS model,
            e.data->>'manufacturer' AS manufacturer, e.data->>'service_address' AS service_address,
            e.data->>'customer_name' AS customer_name,
            COALESCE((SELECT array_agg(DISTINCT l.document_id) FROM document_entity_links l WHERE l.entity_id = e.id AND l.${TENANT_SQL}), ARRAY[]::uuid[]) AS document_ids
       FROM entities e
      WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.${TENANT_SQL}`,
    []
  );
  return rows;
}

function unitLabel(r) {
  const parts = [r.manufacturer, r.model].filter(Boolean).join(' ') || 'Unknown unit';
  return [parts, r.customer_name, r.service_address].filter(Boolean).join(' · ');
}

/** @returns {Promise<object[]>} zero, one, or two insight objects. */
export async function detectWarrantyInsights(db, { today } = {}) {
  if (!isPlausibleToday(today)) return [];
  const rows = await fetchEquipmentRows(db);
  if (!rows.length) return [];

  const expiring = [];
  const registration = [];
  for (const r of rows) {
    const w = r.warranty ?? {};
    const daysToExpiry = w.expires ? daysBetween(today, w.expires) : null;
    if (daysToExpiry !== null && daysToExpiry >= 0 && daysToExpiry <= EXPIRING_WITHIN_DAYS) {
      expiring.push({ ...r, daysToExpiry });
    }
    if (registrationActionNeededOf(w, today)) {
      const daysToRegister = w.registrationDeadline ? daysBetween(today, w.registrationDeadline) : null;
      registration.push({ ...r, daysToRegister });
    }
  }

  const insights = [];

  if (expiring.length) {
    expiring.sort((a, b) => a.daysToExpiry - b.daysToExpiry);
    insights.push({
      id: 'warranty-expiring-60',
      kind: 'warranty',
      severity: expiring.some((r) => r.daysToExpiry <= 14) ? 'high' : 'medium',
      title: 'Warranties expiring soon',
      count: expiring.length,
      items: expiring.slice(0, MAX_ITEMS).map((r) => ({
        label: `${unitLabel(r)} — expires in ${r.daysToExpiry} day${r.daysToExpiry === 1 ? '' : 's'}`,
        entityId: r.id,
        documentIds: r.document_ids ?? [],
      })),
      action: { label: 'Ask about expiring warranties', href: 'ask:Which warranties expire in the next 60 days?' },
    });
  }

  if (registration.length) {
    registration.sort((a, b) => (a.daysToRegister ?? 9999) - (b.daysToRegister ?? 9999));
    insights.push({
      id: 'warranty-registration-closing',
      kind: 'warranty',
      severity: 'high',
      title: 'Registration windows closing',
      count: registration.length,
      items: registration.slice(0, MAX_ITEMS).map((r) => ({
        label: `${unitLabel(r)} — register within ${r.daysToRegister ?? '?'} day${r.daysToRegister === 1 ? '' : 's'}`,
        entityId: r.id,
        documentIds: r.document_ids ?? [],
      })),
      action: { label: 'Ask about registration deadlines', href: 'ask:Which units have a registration window closing soon?' },
    });
  }

  return insights;
}
