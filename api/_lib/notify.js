/**
 * Warranty-expiration notification engine (handoffs/NOTIFICATIONS.md).
 *
 * Reuses api/warranty-attention.js's `getWarrantyAttention` for all tier /
 * expiry-date arithmetic (warrantyRules.js's `alertTier`) rather than
 * re-deriving it — this file owns dedupe, digest rendering and delivery
 * only, never warranty math.
 *
 * DEDUPE MODEL: a unit is notified once per (unit, tier). A tier CHANGE
 * (expiring-90 -> expiring-30 -> expired) is a different tier value, so it
 * is a new row in notifications_sent and a new notify event — this needs no
 * "did the tier change" comparison of its own; the compound UNIQUE
 * (tenant_id, unit_id, tier) in M3-config/16-notifications.sql already IS
 * that rule. `record_warranty_notification` (SQL, SECURITY DEFINER) does the
 * INSERT ... ON CONFLICT DO NOTHING and tells the caller whether it was new.
 *
 * CRON-PATH TENANT CONTEXT: the nightly sweep has no Clerk session and
 * visits many tenants in one process, so every DB call in this file that
 * runs from the cron path goes through the SECURITY DEFINER functions in
 * migration 16 (tenant id passed explicitly) rather than opening a
 * resolve_tenant()/SET LOCAL transaction per tenant — see that migration's
 * header for the full reasoning.
 */
import { getPool } from "./recordsStore.js";
import { getWarrantyAttention } from "../warranty-attention.js";
import { sendEmail } from "./email.js";

/** The alert tiers worth waking someone up for. `expiring-365` and `ok` are
 *  visible on the Dashboard but are not urgent enough to notify on. */
export const NOTIFY_TIERS = Object.freeze(["expired", "expiring-30", "expiring-90", "unregistered-window-closing"]);

const TIER_LABEL = {
  expired: "Expired",
  "expiring-30": "Expires within 30 days",
  "expiring-90": "Expires within 90 days",
  "unregistered-window-closing": "Registration window closing",
};

const TIER_ACTION = {
  expired: "Offer an extended warranty or maintenance agreement",
  "expiring-30": "Reach out now — renewal window is closing",
  "expiring-90": "Reach out before it lapses",
  "unregistered-window-closing": "Confirm registration before the window closes",
};

/** @param {string} tier */
export function tierLabel(tier) {
  return TIER_LABEL[tier] ?? tier;
}

/** @param {string} tier */
export function suggestedAction(tier) {
  return TIER_ACTION[tier] ?? "Review this unit's warranty status";
}

/**
 * Pull the notify-worthy items out of a getWarrantyAttention() result and
 * shape them for this file's own use (digest rendering, DB writes).
 * @param {{tenantKey: string, tenantName?: string}} tenantCtx
 * @param {string} today YYYY-MM-DD
 */
export async function computeWarrantyNotifications(tenantCtx, today) {
  const result = await getWarrantyAttention(
    { tenantId: tenantCtx.tenantKey, orgId: tenantCtx.tenantName ?? tenantCtx.tenantKey },
    { today }
  );
  const wanted = new Set(NOTIFY_TIERS);
  return result.items
    .filter((i) => wanted.has(i.tier))
    .map((i) => ({
      unitId: i.entityId,
      serial: i.serialNumber ?? null,
      brand: i.manufacturer ?? null,
      model: i.model ?? null,
      customer: i.customerName ?? null,
      address: i.serviceAddress ?? null,
      tier: i.tier,
      expires: i.tier === "unregistered-window-closing" ? i.registrationDeadline : i.expires,
      daysLeft: i.daysLeft,
      upsell: i.upsell,
    }));
}

/**
 * Pure restatement of the SQL dedupe rule (UNIQUE (tenant_id, unit_id, tier)
 * + ON CONFLICT DO NOTHING in record_warranty_notification): a unit is
 * notified again only when it reaches a DIFFERENT tier than any it has
 * already been notified at. Exported so scripts/verify-notify.mjs can
 * assert the tier-transition behavior without a database.
 * @param {string[]} previouslySentTiers tiers already recorded for this unit
 * @param {string} tier the tier this sweep just computed for it
 */
export function isNewTierEvent(previouslySentTiers, tier) {
  return !(previouslySentTiers ?? []).includes(tier);
}

/** Dedupe + cap a recipient list. Pure. @param {(string|null|undefined)[]} emails */
export function capRecipients(emails, max = 10) {
  const seen = new Set();
  const out = [];
  for (const raw of emails ?? []) {
    const e = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!e || !e.includes("@") || seen.has(e)) continue;
    seen.add(e);
    out.push(e);
    if (out.length >= max) break;
  }
  return out;
}

/** True once `settings.emailDigest` has been explicitly turned off. Default
 *  is ON — an owner who never visits the Team screen still gets value.
 *  @param {{emailDigest?: boolean}|null|undefined} settings */
export function digestEnabled(settings) {
  return settings?.emailDigest !== false;
}

/** True when this tenant's digest for `today` has already gone out.
 *  @param {{lastDigestSentAt?: string}|null|undefined} settings
 *  @param {string} today YYYY-MM-DD */
export function alreadySentDigestToday(settings, today) {
  const last = settings?.lastDigestSentAt;
  if (typeof last !== "string" || !last) return false;
  return last.slice(0, 10) === today;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/**
 * Plain-text + HTML digest for a set of newly-notified items. Pure — no
 * clock read, no DB, no network — so scripts/verify-notify.mjs can assert
 * its shape directly.
 * @param {{tenantName: string, items: ReturnType<typeof computeWarrantyNotifications> extends Promise<infer T> ? T : never, appUrl: string}} args
 */
export function renderDigest({ tenantName, items, appUrl }) {
  const n = items.length;
  const subject = `${n} ${n === 1 ? "warranty needs" : "warranties need"} attention`;

  const rows = items.map((i) => {
    const link = `${appUrl}/app/?entity=${encodeURIComponent(i.unitId)}`;
    return { ...i, link, action: suggestedAction(i.tier) };
  });

  const textLines = [
    `${subject} — ${tenantName}`,
    "",
    ...rows.map(
      (r) =>
        `- ${r.customer ?? "Unknown customer"} | ${r.address ?? "no address on file"} | ` +
        `${tierLabel(r.tier)} (expires ${r.expires ?? "unknown"}, ${r.daysLeft ?? "?"} day(s) left) | ` +
        `${r.action} | ${r.link}`
    ),
  ];

  const tableRows = rows
    .map(
      (r) => `<tr>
        <td>${escapeHtml(r.customer ?? "Unknown customer")}</td>
        <td>${escapeHtml(r.brand ?? "")} ${escapeHtml(r.model ?? "")}${r.serial ? ` (#${escapeHtml(r.serial)})` : ""}</td>
        <td>${escapeHtml(r.expires ?? "unknown")}</td>
        <td>${r.daysLeft ?? "?"}</td>
        <td>${escapeHtml(r.action)}</td>
        <td><a href="${r.link}">Draft outreach</a></td>
      </tr>`
    )
    .join("\n");

  const html =
    `<p><strong>${escapeHtml(subject)}</strong> — ${escapeHtml(tenantName)}</p>` +
    `<table cellpadding="6" style="border-collapse:collapse;width:100%">` +
    `<thead><tr style="text-align:left;border-bottom:2px solid #ccc">` +
    `<th>Customer</th><th>Unit</th><th>Expires</th><th>Days</th><th>Suggested action</th><th></th>` +
    `</tr></thead><tbody>${tableRows}</tbody></table>`;

  return { subject: `${subject} — DeepWell`, text: textLines.join("\n"), html };
}

const ADMIN_ROLE_RE = /^(org:)?admin$/i;

/**
 * Org admin emails via the Clerk Backend API, capped at 10.
 * @param {string} orgId Clerk organization id (this app's tenant_key for a shop)
 */
export async function getOrgAdminEmails(orgId) {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey || !orgId) return [];
  try {
    const { createClerkClient } = await import("@clerk/backend");
    const clerkClient = createClerkClient({ secretKey });
    const list = await clerkClient.organizations.getOrganizationMembershipList({ organizationId: orgId, limit: 100 });
    const memberships = Array.isArray(list) ? list : (list?.data ?? []);
    const emails = memberships
      .filter((m) => ADMIN_ROLE_RE.test(String(m?.role ?? "")))
      .map((m) => m?.publicUserData?.identifier)
      .filter((id) => typeof id === "string" && id.includes("@"));
    return capRecipients(emails, 10);
  } catch (err) {
    console.error("getOrgAdminEmails failed:", err?.message);
    return [];
  }
}

const APP_URL = (process.env.APP_URL ?? "https://deepwelltechnology.com").replace(/\/$/, "");

/**
 * Run the engine for one tenant: compute notify-worthy items, dedupe-write
 * each via the SQL writer, and — if anything is new — send at most one
 * digest email for the day. Never throws; the caller (the cron sweep) is
 * responsible for the ≤5s-per-tenant bound and continue-on-error behavior.
 * @param {{tenant_id: string, tenant_key: string, tenant_name: string, settings: object}} tenant
 * @param {string} today YYYY-MM-DD
 */
export async function runWarrantyNotificationSweepForTenant(tenant, today) {
  const pool = getPool();
  try {
    return await runWarrantyNotificationSweepForTenantInner(pool, tenant, today);
  } finally {
    // Fairness marker (list_notification_eligible_tenants' ORDER BY —
    // M3-config/16-notifications.sql): written on success OR failure, so a
    // tenant that errors out doesn't also get to hog the front of every
    // future run's queue. Best-effort — a failure here must never mask the
    // real result/error above.
    await pool.query("SELECT mark_tenant_notified($1, $2)", [tenant.tenant_id, new Date().toISOString()]).catch(() => {});
  }
}

async function runWarrantyNotificationSweepForTenantInner(pool, tenant, today) {
  const items = await computeWarrantyNotifications({ tenantKey: tenant.tenant_key, tenantName: tenant.tenant_name }, today);

  const newItems = [];
  for (const item of items) {
    const title = `${tierLabel(item.tier)}: ${item.customer ?? item.address ?? "a unit"}`;
    const body = `${item.brand ?? "Unit"} ${item.model ?? ""}${item.serial ? ` (#${item.serial})` : ""} — ${suggestedAction(item.tier)}.`;
    const link = `/app/?entity=${item.unitId}`;
    const { rows } = await pool.query("SELECT record_warranty_notification($1,$2,$3,$4,$5,$6,$7,$8) AS is_new", [
      tenant.tenant_id,
      item.unitId,
      item.tier,
      "in-app",
      "warranty",
      title,
      body,
      link,
    ]);
    if (rows[0]?.is_new) newItems.push(item);
  }

  const result = { tenantKey: tenant.tenant_key, itemsFound: items.length, newlyNotified: newItems.length, emailed: false };
  if (newItems.length === 0) return result;
  if (!digestEnabled(tenant.settings)) return { ...result, emailSkippedReason: "digest-disabled" };
  if (alreadySentDigestToday(tenant.settings, today)) return { ...result, emailSkippedReason: "already-sent-today" };

  const recipients = await getOrgAdminEmails(tenant.tenant_key);
  const digest = renderDigest({ tenantName: tenant.tenant_name ?? tenant.tenant_key, items: newItems, appUrl: APP_URL });
  const sendResult = recipients.length
    ? await sendEmail({ to: recipients, ...digest })
    : { sent: false, channel: "in-app" };

  // REVIEW FIX: only mark "sent today" once an email actually went out to at
  // least one recipient — recipients.length is already implied by
  // sendResult.sent (sendEmail only returns sent:true on that path), checked
  // again here defensively. A failed send or an org with zero admin emails
  // must NOT burn today's one-digest allowance; the next sweep run retries.
  if (sendResult.sent && recipients.length > 0) {
    await pool.query("SELECT mark_tenant_digest_sent($1, $2)", [tenant.tenant_id, new Date().toISOString()]);
  }

  return { ...result, emailed: sendResult.sent, channel: sendResult.channel, recipients: recipients.length };
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}

/**
 * Defensive re-sort by fairness marker (oldest/never-visited first — NULLS
 * FIRST), mirroring list_notification_eligible_tenants()'s own ORDER BY
 * rather than trusting the SQL ordering blindly. Pure; stable for ties.
 * @param {{last_notified_at?: string|null}[]} tenants
 */
export function orderByLastNotified(tenants) {
  const rank = (t) => (t?.last_notified_at ? new Date(t.last_notified_at).getTime() : -Infinity);
  return [...(tenants ?? [])].sort((a, b) => rank(a) - rank(b));
}

/**
 * Pure scheduling loop: walks `tenants` in order, calling `processTenant`
 * for each one UNLESS the next tenant's estimated cost (`perTenantMs`) would
 * cross `deadlineAt` — at which point it stops and reports the rest as
 * skipped, rather than dropping them. No real timers: `now` is an injectable
 * clock so scripts/verify-notify.mjs can assert the halt-at-deadline and
 * next-run-starts-with-the-skipped-ones behavior with no database and no
 * real elapsed time. The real caller (runWarrantyNotificationSweep) passes
 * `Date.now` and lets each tenant's actual duration advance it.
 * @template T
 * @param {T[]} tenants
 * @param {{deadlineAt: number, perTenantMs: number, processTenant: (t: T) => Promise<void>, now?: () => number}} opts
 */
export async function sweepWithDeadline(tenants, { deadlineAt, perTenantMs, processTenant, now = () => Date.now() }) {
  const processed = [];
  const skipped = [];
  for (const tenant of tenants ?? []) {
    if (now() + perTenantMs > deadlineAt) {
      skipped.push(tenant);
      continue;
    }
    await processTenant(tenant);
    processed.push(tenant);
  }
  if (skipped.length) {
    console.log(`notify sweep: shared deadline reached, skipped ${skipped.length} tenant(s) this run — they lead next run's queue`);
  }
  return { processed, skipped };
}

const DEFAULT_BUDGET_MS = 45_000;

/**
 * Cross-tenant entry point for the nightly cron sweep. Bounded to
 * `maxTenants` tenants and `perTenantMs` per tenant, and to one shared
 * `deadlineAt` (default: 45s from now, matching the budget cron-sweep.js
 * carves out of api/account.js's 60s maxDuration) — a tenant list too long
 * to finish in time is stopped, not overrun; the skipped tenants sort first
 * next run via `last_notified_at` (see M3-config/16-notifications.sql and
 * `mark_tenant_notified`, called for every tenant this run actually visits).
 * A single tenant's failure or timeout is recorded and the sweep continues.
 * @param {{today?: string, maxTenants?: number, perTenantMs?: number, deadlineAt?: number}} [opts]
 */
export async function runWarrantyNotificationSweep({ today, maxTenants = 8, perTenantMs = 3000, deadlineAt } = {}) {
  const day = today ?? new Date().toISOString().slice(0, 10);
  const effectiveDeadline = deadlineAt ?? Date.now() + DEFAULT_BUDGET_MS;
  const pool = getPool();
  const summary = { tenantsChecked: 0, notified: 0, emailsSent: 0, skipped: 0, errors: [] };

  let tenants = [];
  try {
    const { rows } = await pool.query("SELECT * FROM list_notification_eligible_tenants()");
    tenants = orderByLastNotified(rows).slice(0, maxTenants);
  } catch (err) {
    summary.errors.push({ phase: "list-tenants", message: err?.message });
    return summary;
  }

  const { skipped } = await sweepWithDeadline(tenants, {
    deadlineAt: effectiveDeadline,
    perTenantMs,
    processTenant: async (tenant) => {
      summary.tenantsChecked += 1;
      try {
        const result = await withTimeout(runWarrantyNotificationSweepForTenant(tenant, day), perTenantMs);
        summary.notified += result.newlyNotified;
        if (result.emailed) summary.emailsSent += 1;
      } catch (err) {
        summary.errors.push({ tenant: tenant.tenant_key, message: err?.message });
      }
    },
  });
  summary.skipped = skipped.length;

  return summary;
}
