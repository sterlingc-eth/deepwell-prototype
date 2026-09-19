import { handleCors, handleError } from "./_lib/claude.js";
import { denyAuth } from "./_lib/auth.js";
import { withTenant } from "./_lib/recordsStore.js";
import { describeWarranty, addDays, ruleCoverage, isPlausibleToday, alertTier, upsell, daysBetween } from "./_lib/warrantyRules.js";
import { requireAuthOrKey, assertScope } from "./_lib/apiKeyAuth.js";
import { limit } from "./_lib/rateLimit.js";

/**
 * POST /api/warranty-attention
 * body: { today?, registerWithinDays?, registerLookbackDays?, expiringWithinDays? }
 *
 * -> { today, items: [...], counts: {...}, coverage: {...} }
 *
 * The reminder list. Two populations, one query:
 *
 *   1. Units whose manufacturer registration window is open or has just closed,
 *      with nothing on file saying anyone registered them. This is the urgent
 *      one — the window is about 60 days from installation, and missing it
 *      costs the homeowner five years of parts coverage and the contractor the
 *      callback in year seven. Nobody tracks it today; it is the reason this
 *      endpoint exists.
 *
 *   2. Units whose parts warranty is approaching its end, which is exactly when
 *      an extended warranty is worth selling.
 *
 * Urgency is computed HERE, per request, from the dates stored on the equipment
 * entity. Nothing time-sensitive is persisted — "19 days left" would be wrong
 * by tomorrow.
 *
 * `coverage` is returned on purpose: only manufacturers whose published terms
 * someone has actually read produce deadlines, so a tenant running mostly
 * Carrier equipment will see a short list. That should be visible as a gap in
 * our rules table rather than looking like there is nothing to do.
 *
 * Accepts either a Clerk session or an API key with the 'read' scope, and is
 * rate-limited on the 'read' bucket (./_lib/apiKeyAuth.js, ./_lib/rateLimit.js).
 *
 * `getWarrantyAttention` is exported so api/v1-warranty.js (the public GET
 * surface) can reuse this exact logic.
 */
export const config = { api: { bodyParser: { sizeLimit: "8kb" } } };

const clampDays = (v, fallback, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.trunc(n), max) : fallback;
};

export class WarrantyAttentionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "WarrantyAttentionError";
    this.status = status;
  }
}

/**
 * @param {{tenantId: string, orgId: string|null}} auth
 * @param {{today?: unknown, registerWithinDays?: unknown, registerLookbackDays?: unknown, expiringWithinDays?: unknown}} params
 * @throws {WarrantyAttentionError}
 */
export async function getWarrantyAttention(auth, params) {
  // `today` is overridable so the list can be previewed at a future date and so
  // tests are deterministic. It must still be a real ISO date — it goes into a
  // SQL comparison. Validated as a real calendar date, not just the right
  // shape: "2024-13-40" matches /\d{4}-\d{2}-\d{2}/ but every downstream date
  // function rejects it, which would turn a typo into a silently empty list
  // instead of an error.
  if (params.today != null && !isPlausibleToday(params.today)) {
    throw new WarrantyAttentionError("today must be a real YYYY-MM-DD date between 2000 and 2100");
  }
  const today = params.today ?? new Date().toISOString().slice(0, 10);

  const registerWithin = clampDays(params.registerWithinDays, 30, 365);
  const registerLookback = clampDays(params.registerLookbackDays, 60, 3650);
  const expiringWithin = clampDays(params.expiringWithinDays, 180, 3650);

  // The fixed alert tiers (30/90/365 days) are a separate, wider lens than
  // the caller's own `expiringWithin` horizon (used by the legacy
  // action/urgency fields below) — the SQL fetch has to cover the wider of
  // the two or a tenant asking for the default 180-day list would silently
  // never see its own expiring-365 or upsell-eligible rows.
  const ALERT_TIER_HORIZON_DAYS = 365;
  const EXPIRED_LOOKBACK_DAYS = 730;
  const fetchExpiringWithin = Math.max(expiringWithin, ALERT_TIER_HORIZON_DAYS);

  const rows = await withTenant(
    { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId },
    (db) =>
      db.listWarrantyAttention({
        registerFrom: addDays(today, -registerLookback),
        registerTo: addDays(today, registerWithin),
        // Include units that expired within the last two years: an expired
        // warranty is the strongest extended-warranty / service-agreement
        // upsell signal there is, and the 'expired' alert tier needs them.
        expiringFrom: addDays(today, -EXPIRED_LOOKBACK_DAYS),
        expiringTo: addDays(today, fetchExpiringWithin),
      })
  );

  const items = rows
    .map((r) => {
      const stable = r.warranty ?? {};
      const now = describeWarranty(stable, today, { expiringWithinDays: expiringWithin });
      const tier = alertTier(stable, today);
      const daysLeft =
        tier === 'unregistered-window-closing'
          ? daysBetween(today, stable.registrationDeadline)
          : now.daysToExpiry;
      return {
        entityId: r.id,
        serialNumber: r.serial_number,
        model: r.model,
        manufacturer: r.manufacturer,
        serviceAddress: r.service_address,
        customerName: r.customer_name,
        installDate: stable.installDate ?? null,
        registrationDeadline: stable.registrationDeadline ?? null,
        registrationOnFile: stable.registrationOnFile ?? null,
        expires: stable.expires ?? null,
        // The UI must never show a calculated date as though a document said
        // it. This field is what that distinction hangs on.
        expiresBasis: stable.expiresBasis ?? null,
        termYears: stable.termYears ?? null,
        ...now,
        tier,
        daysLeft,
        upsell: upsell(stable, today),
      };
    })
    // A row is kept if the legacy urgency logic names an action OR it lands
    // in one of the new fixed alert tiers (the two horizons can disagree —
    // see ALERT_TIER_HORIZON_DAYS above).
    .filter((i) => i.action || (i.tier !== 'ok' && i.tier !== 'unknown'));

  const order = { register_urgent: 0, register_soon: 1, register_missed: 2, expiring: 3, expired: 4 };
  items.sort((a, b) => (order[a.urgency] ?? 9) - (order[b.urgency] ?? 9));

  const counts = items.reduce((acc, i) => {
    acc[i.urgency] = (acc[i.urgency] ?? 0) + 1;
    return acc;
  }, {});

  const summary = {
    expired: items.filter((i) => i.tier === 'expired').length,
    expiring30: items.filter((i) => i.tier === 'expiring-30').length,
    expiring90: items.filter((i) => i.tier === 'expiring-90').length,
    expiring365: items.filter((i) => i.tier === 'expiring-365').length,
    registrationClosing: items.filter((i) => i.tier === 'unregistered-window-closing').length,
    upsellEligible: items.filter((i) => i.upsell.eligible).length,
  };

  const cov = ruleCoverage();

  return {
    today,
    items,
    counts,
    summary,
    total: items.length,
    coverage: {
      verifiedBrands: cov.verified.map((v) => v.label),
      unverifiedBrands: cov.unverified.map((v) => v.label),
      note: "Only manufacturers whose published warranty terms have been verified produce deadlines.",
    },
  };
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
    const result = await getWarrantyAttention(auth, req.body ?? {});
    return handleCors(res, req).status(200).json(result);
  } catch (error) {
    if (error?.name === "WarrantyAttentionError") {
      return handleCors(res, req).status(error.status).json({ error: error.message });
    }
    return handleError(res, error, req);
  }
}
