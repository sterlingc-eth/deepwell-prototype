import { handleCors, handleError } from "./_lib/claude.js";
import { requireAuth, denyAuth } from "./_lib/auth.js";
import { withTenant } from "./_lib/recordsStore.js";
import { describeWarranty, isPlausibleToday } from "./_lib/warrantyRules.js";

/**
 * POST /api/customer-equipment
 * body: { customerId, today?, expiringWithinDays? }
 *
 * -> { today, customerId, customerName, equipment: [...], total }
 *
 * The other half of the reminder list in warranty-attention.js: instead of
 * "every unit anywhere due for something", this is "everything one customer
 * owns", for a customer screen — select a customer, see their units and each
 * one's warranty state in a single query (recordsStore.js's
 * listCustomerEquipment, keyed off entities.customer_id — see
 * M3-config/05-customer-link.sql).
 *
 * Urgency is computed HERE, per request, from the dates stored on each
 * equipment entity, for the same reason as warranty-attention.js: nothing
 * time-sensitive is persisted, so "expires in 19 days" is never wrong by
 * tomorrow because it was never written down.
 */
export const config = { api: { bodyParser: { sizeLimit: "8kb" } } };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const clampDays = (v, fallback, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.trunc(n), max) : fallback;
};

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return handleCors(res, req).status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let auth;
  try {
    auth = await requireAuth(req);
  } catch (err) {
    return denyAuth(res, err);
  }

  const body = req.body ?? {};

  // Validated as a real uuid before it ever reaches a query. Postgres raises
  // "invalid input syntax for type uuid" on a malformed value passed as a
  // parameter compared against a uuid column — exactly the failure
  // 02-tenancy-fix.sql's header note describes for tenant_id — which would
  // turn a typo'd id into a 500 instead of a clean 400.
  const { customerId } = body;
  if (typeof customerId !== "string" || !UUID_RE.test(customerId)) {
    return res.status(400).json({ error: "customerId must be a valid id" });
  }

  // Same validation as warranty-attention.js, for the same reason: `today` is
  // overridable for previews and deterministic tests, but it goes into date
  // arithmetic below, so a malformed value must fail loudly rather than
  // silently produce nonsense urgency.
  if (body.today != null && !isPlausibleToday(body.today)) {
    return res.status(400).json({ error: "today must be a real YYYY-MM-DD date between 2000 and 2100" });
  }
  const today = body.today ?? new Date().toISOString().slice(0, 10);
  const expiringWithin = clampDays(body.expiringWithinDays, 180, 3650);

  try {
    const result = await withTenant(
      { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId },
      async (db) => {
        // getEntity() already carries the TENANT predicate, so a customerId
        // belonging to another tenant comes back null exactly like one that
        // doesn't exist at all — the caller cannot tell the two apart, which
        // is the point.
        const customer = await db.getEntity(customerId);
        if (!customer || customer.entity_type !== "customer") return null;
        const equipment = await db.listCustomerEquipment(customerId);
        return { customer, equipment };
      }
    );

    if (!result) return res.status(404).json({ error: "Customer not found" });

    const equipment = result.equipment.map((u) => {
      const stable = u.warranty ?? {};
      const now = describeWarranty(stable, today, { expiringWithinDays: expiringWithin });
      return {
        entityId: u.id,
        serialNumber: u.serial_number,
        model: u.model,
        manufacturer: u.manufacturer,
        equipmentType: u.equipment_type,
        serviceAddress: u.service_address,
        installDate: stable.installDate ?? null,
        registrationDeadline: stable.registrationDeadline ?? null,
        registrationOnFile: stable.registrationOnFile ?? null,
        expires: stable.expires ?? null,
        // Same rule as warranty-attention.js: the UI must never show a
        // calculated date as though a document said it.
        expiresBasis: stable.expiresBasis ?? null,
        termYears: stable.termYears ?? null,
        ...now,
      };
    });

    return handleCors(res, req).status(200).json({
      today,
      customerId,
      customerName: result.customer.data?.customer_name ?? null,
      equipment,
      total: equipment.length,
    });
  } catch (error) {
    return handleError(res, error, req);
  }
}
