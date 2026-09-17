import { handleCors, handleError } from "./_lib/claude.js";
import { requireAuth, denyAuth } from "./_lib/auth.js";
import { withTenant } from "./_lib/recordsStore.js";
import { describeWarranty, addDays, ruleCoverage, isPlausibleToday } from "./_lib/warrantyRules.js";

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
 */
export const config = { api: { bodyParser: { sizeLimit: "8kb" } } };

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
  // `today` is overridable so the list can be previewed at a future date and so
  // tests are deterministic. It must still be a real ISO date — it goes into a
  // SQL comparison.
  // Validated as a real calendar date, not just the right shape: "2024-13-40"
  // matches /\d{4}-\d{2}-\d{2}/ but every downstream date function rejects it,
  // which would turn a typo into a silently empty list instead of an error.
  if (body.today != null && !isPlausibleToday(body.today)) {
    return res.status(400).json({ error: "today must be a real YYYY-MM-DD date between 2000 and 2100" });
  }
  const today = body.today ?? new Date().toISOString().slice(0, 10);

  const registerWithin = clampDays(body.registerWithinDays, 30, 365);
  const registerLookback = clampDays(body.registerLookbackDays, 60, 3650);
  const expiringWithin = clampDays(body.expiringWithinDays, 180, 3650);

  try {
    const rows = await withTenant(
      { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId },
      (db) =>
        db.listWarrantyAttention({
          registerFrom: addDays(today, -registerLookback),
          registerTo: addDays(today, registerWithin),
          // Expiries already past are handled by the registration branch or are
          // simply history; this list is about what can still be acted on.
          expiringFrom: today,
          expiringTo: addDays(today, expiringWithin),
        })
    );

    const items = rows
      .map((r) => {
        const stable = r.warranty ?? {};
        const now = describeWarranty(stable, today, { expiringWithinDays: expiringWithin });
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
        };
      })
      // A row whose dates no longer imply anything actionable is dropped rather
      // than shown with an empty reason.
      .filter((i) => i.action);

    const order = { register_urgent: 0, register_soon: 1, register_missed: 2, expiring: 3, expired: 4 };
    items.sort((a, b) => (order[a.urgency] ?? 9) - (order[b.urgency] ?? 9));

    const counts = items.reduce((acc, i) => {
      acc[i.urgency] = (acc[i.urgency] ?? 0) + 1;
      return acc;
    }, {});

    const cov = ruleCoverage();

    return handleCors(res, req).status(200).json({
      today,
      items,
      counts,
      total: items.length,
      coverage: {
        verifiedBrands: cov.verified.map((v) => v.label),
        unverifiedBrands: cov.unverified.map((v) => v.label),
        note: "Only manufacturers whose published warranty terms have been verified produce deadlines.",
      },
    });
  } catch (error) {
    return handleError(res, error, req);
  }
}
