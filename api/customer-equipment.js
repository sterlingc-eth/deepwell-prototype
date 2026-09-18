import { handleCors, handleError } from "./_lib/claude.js";
import { denyAuth } from "./_lib/auth.js";
import { withTenant } from "./_lib/recordsStore.js";
import { describeWarranty, isPlausibleToday } from "./_lib/warrantyRules.js";
import { requireAuthOrKey, assertScope } from "./_lib/apiKeyAuth.js";
import { limit } from "./_lib/rateLimit.js";

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
 *
 * Accepts either a Clerk session or an API key with the 'read' scope, and is
 * rate-limited on the 'read' bucket (./_lib/apiKeyAuth.js, ./_lib/rateLimit.js).
 *
 * `getCustomerEquipment` and `getEquipmentBySerial` are exported so
 * api/v1-equipment.js (the public GET surface) can reuse this exact logic
 * instead of re-implementing the warranty-formatting step a second time.
 */
export const config = { api: { bodyParser: { sizeLimit: "8kb" } } };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const clampDays = (v, fallback, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.trunc(n), max) : fallback;
};

export class EquipmentLookupError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "EquipmentLookupError";
    this.status = status;
  }
}

/** Same shape on every equipment row, regardless of which query found it. */
function formatEquipmentWarranty(u, today, expiringWithin) {
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
    // The UI must never show a calculated date as though a document said it.
    expiresBasis: stable.expiresBasis ?? null,
    termYears: stable.termYears ?? null,
    ...now,
  };
}

function resolveTodayAndWindow(params) {
  if (params.today != null && !isPlausibleToday(params.today)) {
    throw new EquipmentLookupError("today must be a real YYYY-MM-DD date between 2000 and 2100");
  }
  return {
    today: params.today ?? new Date().toISOString().slice(0, 10),
    expiringWithin: clampDays(params.expiringWithinDays, 180, 3650),
  };
}

/**
 * @param {{tenantId: string, orgId: string|null}} auth
 * @param {{customerId: unknown, today?: unknown, expiringWithinDays?: unknown}} params
 * @throws {EquipmentLookupError}
 */
export async function getCustomerEquipment(auth, params) {
  const { customerId } = params;
  // Validated as a real uuid before it ever reaches a query. Postgres raises
  // "invalid input syntax for type uuid" on a malformed value passed as a
  // parameter compared against a uuid column — exactly the failure
  // 02-tenancy-fix.sql's header note describes for tenant_id — which would
  // turn a typo'd id into a 500 instead of a clean 400.
  if (typeof customerId !== "string" || !UUID_RE.test(customerId)) {
    throw new EquipmentLookupError("customerId must be a valid id");
  }
  const { today, expiringWithin } = resolveTodayAndWindow(params);

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

  if (!result) throw new EquipmentLookupError("Customer not found", 404);

  const equipment = result.equipment.map((u) => formatEquipmentWarranty(u, today, expiringWithin));
  return {
    today,
    customerId,
    customerName: result.customer.data?.customer_name ?? null,
    equipment,
    total: equipment.length,
  };
}

/**
 * Look up a single unit by serial number — the v1 API's equipment-by-serial
 * path. There is no indexed by-serial lookup in recordsStore.js (owned by
 * another engineer, not edited here) beyond findOrCreateEquipment, which
 * mutates; this reuses listEntities('equipment') (capped at 500 rows per
 * tenant, same as everywhere else that call is used) and filters in memory,
 * matching findOrCreateEquipment's own case-insensitive comparison.
 *
 * @param {{tenantId: string, orgId: string|null}} auth
 * @param {{serial: unknown, today?: unknown, expiringWithinDays?: unknown}} params
 * @throws {EquipmentLookupError}
 */
export async function getEquipmentBySerial(auth, params) {
  const serial = typeof params.serial === "string" ? params.serial.trim() : "";
  if (!serial) throw new EquipmentLookupError("serial is required");
  const { today, expiringWithin } = resolveTodayAndWindow(params);

  const match = await withTenant(
    { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId },
    async (db) => {
      const equipment = await db.listEntities("equipment");
      return equipment.find((e) => (e.data?.serial_number ?? "").toLowerCase() === serial.toLowerCase()) ?? null;
    }
  );

  if (!match) throw new EquipmentLookupError("No equipment found for that serial number", 404);

  const row = {
    id: match.id,
    serial_number: match.data?.serial_number ?? null,
    model: match.data?.model ?? null,
    manufacturer: match.data?.manufacturer ?? null,
    equipment_type: match.data?.equipment_type ?? null,
    service_address: match.data?.service_address ?? null,
    warranty: match.data?.warranty ?? null,
  };
  return { today, equipment: formatEquipmentWarranty(row, today, expiringWithin) };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return handleCors(res, req).status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let auth;
  try {
    auth = await requireAuthOrKey(req);
    assertScope(auth, "read");
  } catch (err) {
    return denyAuth(res, err);
  }

  if (!(await limit(req, res, auth, "read"))) return; // 429 already written

  try {
    const result = await getCustomerEquipment(auth, req.body ?? {});
    return handleCors(res, req).status(200).json(result);
  } catch (error) {
    if (error?.name === "EquipmentLookupError") {
      return handleCors(res, req).status(error.status).json({ error: error.message });
    }
    return handleError(res, error, req);
  }
}
