/**
 * Subscription gating: what state a tenant's billing is in, and what that
 * state permits on upload-url, ask, v1-ingest, read-document, extract, and
 * review's model-calling actions. Every function down to requireActiveBilling
 * is pure — no database, no Stripe — so scripts/verify-billing.mjs can test
 * every branch with fixture tenant rows. assertActiveBilling (bottom of the
 * file) is the one deliberate exception: it fetches the tenant row itself, so
 * the three routes with no bespoke gate wrapper of their own (read-document,
 * extract, review) don't each need to reimplement that query. The exact
 * rules this file implements are written out in handoffs/BILLING_RULES.md;
 * keep the two in sync.
 */
import { getTenantContext, withTenant } from './recordsStore.js';
import { TTLCache, memoAsync, logStage, registerTenantCache } from './perf.js';
import { DOCX_CONTENT_TYPE, XLSX_CONTENT_TYPE } from './uploadTypes.js';
import {
  ESTIMATE_DOCX_FIXED_BYTES, ESTIMATE_DOCX_BYTES_PER_PAGE, ESTIMATE_XLSX_FIXED_BYTES, ESTIMATE_XLSX_BYTES_PER_PAGE, ESTIMATE_CSV_BYTES_PER_PAGE, ESTIMATE_DOCX_MAX_PAGES, ESTIMATE_SHEET_MAX_PAGES,
} from './office/limits.js';
import { STAFF_IMPORT_KEY, STAFF_IMPORT_MAX_DAYS, STAFF_IMPORT_CEILINGS, staffImportFor, staffImportWindowFor, staffImportNow, noteDatabaseClock } from './staffImport.js';
export { STAFF_IMPORT_KEY, STAFF_IMPORT_MAX_DAYS, STAFF_IMPORT_CEILINGS, staffImportFor, staffImportWindowFor, staffImportNow, noteDatabaseClock };

/** Per-plan entitlements, written to tenants.limits by billing_apply() on every
 * subscription create/update webhook. Exported so api/_lib/billing.js's
 * webhook handler and scripts/verify-billing.mjs share one source of truth.
 * `null` = uncapped.
 *
 * ROUND 26 (owner decisions, 2026-09-28) — plan tiers:
 *  - `logins` (was `technicians`): how many people besides the ONE owner
 *    account can sign in. Solo 2, Team 5, Crew 10, Fleet 11+ (null = no
 *    DeepWell cap). Enforced for real — see api/_lib/seats.js (server-side
 *    invite guard + Clerk maxAllowedMemberships) and TeamScreen.tsx.
 *  - Donovan (asks) is UNLIMITED on every plan. There is deliberately no
 *    per-plan ask allowance any more; DONOVAN_SAFETY below is a hidden
 *    abuse/runaway ceiling, identical for every plan.
 *  - Document scans keep their monthly page allowances (750/2,000/5,000/10,000).
 *  - API access is Fleet-only (hasApiAccess below).
 * Stored tenants.limits rows written before Round 26 still carry the old
 * `technicians` / `asksPerMonth` keys; nothing reads them — every reader takes
 * caps from this live table by plan (see loginCapForPlan). */
export const PLAN_LIMITS = Object.freeze({
  solo:  Object.freeze({ logins: 2,    documentsStored: 25_000,  pagesPerMonth: 750 }),
  shop:  Object.freeze({ logins: 5,    documentsStored: 100_000, pagesPerMonth: 2_000 }),
  crew:  Object.freeze({ logins: 10,   documentsStored: 500_000, pagesPerMonth: 5_000 }),
  fleet: Object.freeze({ logins: null, documentsStored: null,    pagesPerMonth: 10_000 }),
});

/** Login cap (people besides the owner) for a plan: a number, `null` for
 * Fleet (no DeepWell cap), or `undefined` when the plan is unknown/absent
 * (no subscription yet — callers must not enforce or sync anything). */
export function loginCapForPlan(plan) {
  if (typeof plan !== 'string' || !Object.prototype.hasOwnProperty.call(PLAN_LIMITS, plan)) return undefined;
  return PLAN_LIMITS[plan].logins;
}

/** The limits object the API reports to clients / stores for a plan: always
 * the live table, never a stale tenants.limits snapshot. */
export function limitsForPlan(plan) {
  return Object.prototype.hasOwnProperty.call(PLAN_LIMITS, plan ?? '') ? { ...PLAN_LIMITS[plan] } : null;
}

/** Limits object for /api/billing?action=status and the bootstrap payload:
 * the live plan table (never the stale tenants.limits snapshot) plus the
 * outreachAuto add-on flag carried on the stored row. */
export function clientLimits(tenantRow) {
  const base = limitsForPlan(tenantRow?.plan) ?? {};
  return tenantRow?.limits?.outreachAuto === true ? { ...base, outreachAuto: true } : base;
}

/** API access (v1 API + API keys) is included on Fleet only (Round 26). */
export const API_ACCESS_MESSAGE = 'API access is included on the Fleet plan';
export function hasApiAccess(plan) {
  return plan === 'fleet';
}

/** API access: Fleet, or any plan while a staff import is active (R43). */
export function hasApiAccessFor(tenantRow, now) {
  return hasApiAccess(tenantRow?.plan) || staffImportFor(tenantRow, now)?.active === true;
}

/** Stable machine-readable codes the staff import tool reads off a 402 (the browser ignores them). */
export const IMPORT_ALLOWANCE_CODE = 'import-allowance-exhausted';

/**
 * Hidden Donovan safety ceiling (Round 26): Donovan is "Unlimited" to
 * customers on every plan, but a runaway script or abuse must still be
 * stoppable. These are per-tenant, plan-independent, generous enough that no
 * normal shop reaches them (a 10-login shop asking ~100 questions a day is
 * ~2,200 a month), and env-overridable:
 *   RATE_LIMIT_ASK_PER_DAY        daily requests on the ask bucket (rateLimit.js; existing env)
 *   DONOVAN_SAFETY_ASKS_PER_MONTH monthly model-reaching asks (gateAsk below)
 * Existing daily $ spend caps (rateLimit.js assertModelBudget /
 * maxModelCallsPerDay) still apply underneath, unchanged.
 * Hitting a ceiling is never an "upgrade your plan" message — see
 * DONOVAN_SAFETY_MESSAGE.
 */
export const DONOVAN_SAFETY = Object.freeze({ perDay: 3_000, perMonth: 30_000 });
export const DONOVAN_SAFETY_MESSAGE =
  "Donovan is seeing unusually high usage on your account. Please contact support@deepwelltechnology.com and we'll get you sorted out.";

/** Monthly safety ceiling, with DONOVAN_SAFETY_ASKS_PER_MONTH layered on top
 * (a positive number, anything else falls back to the default). */
export function donovanSafetyPerMonth(env = process.env) {
  const n = Number(env?.DONOVAN_SAFETY_ASKS_PER_MONTH);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : DONOVAN_SAFETY.perMonth;
}

/**
 * Add-on entitlements a tenant may hold independently of their plan tier
 * (PLAN_LIMITS, above, caps USAGE per plan; this is a separate yes/no a
 * tenant buys on top). Stored under tenants.limits — the same jsonb column
 * billing_apply() already writes PLAN_LIMITS into on every subscription
 * webhook (M3-config/14-billing.sql) — so no new column/migration is
 * needed: a tenant granted an add-on gets `limits.<key> = true` merged in
 * from its own Stripe subscription item, independent of which base plan
 * they're on. See api/_lib/billing.js's OUTREACH_AUTO_ADDON_LOOKUP_KEY for
 * where that Stripe item is recognized.
 *
 * REQUEST 2b (2026-09-21, owner brief): "Maybe they can add the automated
 * portion that auto-sends if they pay extra." `outreachAuto` gates
 * api/_lib/routes/outreach.js's mode='auto' (unattended nightly sending);
 * mode='review' (Donovan drafts, a human copies/sends) needs no entitlement
 * at all.
 */
export function hasOutreachAutoEntitlement(tenantRow) {
  return tenantRow?.limits?.outreachAuto === true;
}

/** Documents a never-subscribed tenant may ingest and ask about before a
 * trial or subscription is required. HARD GATE (owner decision, 2026-09-21):
 * no free preview any more — a tenant with no subscription is blocked at
 * upload #1 and question #1, same as a canceled one. The client mirrors this
 * by showing ONLY Billing for a 'none'/'canceled' tenant (src/App.tsx), but
 * this constant is what actually enforces it — kept at 0 rather than removed
 * so freePreviewExhausted/gateUpload/gateAsk below don't need their own
 * separate "no preview at all" branch. */
export const FREE_PREVIEW_DOCUMENTS = 0;

/** Days of full access after a subscription goes `past_due` before it drops
 * to read-only (ask allowed, uploads blocked). */
export const PAST_DUE_GRACE_DAYS = 7;

/** R30 M4: hours a trial keeps working AFTER trial_ends_at while the database still says 'trialing'. The
 * trial->paid conversion (charge + webhook) can lag by hours; without this a paying customer saw "Choose a plan"
 * (and could start a second checkout) the instant the clock passed trial_ends_at. Stripe's own status wins the
 * moment a webhook / reconcile lands; this only bounds how long a missing webhook can keep a dead trial alive. */
export const TRIAL_END_GRACE_HOURS = 48;

const DAY_MS = 24 * 60 * 60 * 1000;

function toDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * @param {{billing_status?: string|null, trial_ends_at?: string|Date|null}} tenantRow
 * @param {Date} [now]
 * @returns {'trialing'|'active'|'past_due'|'canceled'|'none'}
 */
export function planStateFor(tenantRow, now = new Date()) {
  const status = tenantRow?.billing_status ?? null;
  if (status === 'trialing') {
    const trialEnd = toDate(tenantRow?.trial_ends_at);
    // A trial Stripe itself hasn't rolled forward yet but whose end date has
    // passed is treated as expired here rather than waiting on the webhook —
    // gating must never depend on webhook delivery timing. R30 M4: ...but only after a 48h grace, so the normal
    // lag of the trial->paid conversion never shows a paying customer the paywall.
    if (trialEnd && now.getTime() > trialEnd.getTime() + TRIAL_END_GRACE_HOURS * 60 * 60 * 1000) return 'none';
    return 'trialing';
  }
  if (status === 'active') return 'active';
  if (status === 'past_due') return 'past_due';
  if (status === 'canceled') return 'canceled';
  return 'none';
}

/**
 * When a past_due tenant's grace clock started, or null if unknown. R30 M3: persisted by the billing webhook at the
 * moment the tenant ENTERS past_due (tenants.limits->'_billing'.pastDueSince, unix seconds; api/_lib/billing.js
 * decideBillingEvent). Counting from current_period_end (the old rule) is wrong for a failed RENEWAL: Stripe has
 * already rolled current_period_end to the NEW period by then, so "7 days" became roughly 37.
 * @param {object} tenantRow
 * @returns {Date|null}
 */
export function pastDueSinceFor(tenantRow) {
  const secs = Number(tenantRow?.limits?._billing?.pastDueSince);
  return Number.isFinite(secs) && secs > 0 ? new Date(secs * 1000) : null;
}

/** True once a `past_due` tenant is past the grace window (read-only territory). */
export function isPastGrace(tenantRow, now = new Date()) {
  if (planStateFor(tenantRow, now) !== 'past_due') return false;
  // Preferred: the moment the tenant went past_due. Legacy rows (past_due before this was recorded) fall back to
  // the old reference — current_period_end / trial_ends_at — until their next dunning event records the real one.
  const ref = pastDueSinceFor(tenantRow) ?? toDate(tenantRow?.current_period_end) ?? toDate(tenantRow?.trial_ends_at) ?? now;
  return now.getTime() - ref.getTime() > PAST_DUE_GRACE_DAYS * DAY_MS;
}

/**
 * @param {{documentsStored: number}} usage
 * @returns {boolean} true once a never-subscribed tenant has used its free preview
 */
export function freePreviewExhausted(usage) {
  return (Number(usage?.documentsStored) || 0) >= FREE_PREVIEW_DOCUMENTS;
}

/**
 * The shared HARD GATE (owner decision, 2026-09-21): does this tenant have
 * ANY active billing relationship at all, ignoring usage entirely? 'none' or
 * 'canceled' blocks; every other state (trialing/active/past_due — including
 * past_due PAST grace, which upload's own gate below still reports with its
 * own stricter "Subscription required" message where that distinction
 * matters) is allowed here. This is the one decision gateUpload, gateAsk,
 * and every model-costing route below all need identically, so it lives in
 * exactly one place rather than four copies of the same message string.
 * @param {object} tenantRow
 * @param {Date} [now]
 * @returns {{allowed: true}|{allowed: false, status: 402, error: string, url: string}}
 */
export function requireActiveBilling(tenantRow, now = new Date()) {
  const state = planStateFor(tenantRow, now);
  if (state === 'none' || state === 'canceled') {
    return { allowed: false, status: 402, error: 'Choose a plan to get started', url: '/app/?screen=billing' };
  }
  return { allowed: true };
}

/**
 * R35: extra pages a tenant may have ON TOP of its plan's monthly allowance (a Records Rescue customer, a negotiated
 * backfile import). Stored as tenants.limits.extraPagesPerMonth, a plain number; migration 62 stops the billing webhook
 * (which replaces `limits` wholesale on every subscription event) from wiping it. 0 / absent / garbage = no extra.
 * @param {{limits?: object|null}|null|undefined} tenantRow
 */
export const EXTRA_PAGES_KEY = 'extraPagesPerMonth';
export function extraPagesFor(tenantRow) {
  const n = Number(tenantRow?.limits?.[EXTRA_PAGES_KEY]);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), 10_000_000) : 0;
}

/**
 * R36: pages bought through Records Rescue that have not been read yet. Carried on the billing row as
 * `rescuePagesRemaining` (a number; loadRescueCredit computes it from the webhook ledger). 0 / absent / garbage = none.
 */
export function rescuePagesFor(tenantRow) {
  const n = Number(tenantRow?.rescuePagesRemaining);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), 10_000_000) : 0;
}

/** The monthly page cap that actually applies (plan allowance + any owner extra + unused Records Rescue pages), or null when uncapped / no plan. */
export function pageCapFor(tenantRow) {
  const base = PLAN_LIMITS[tenantRow?.plan]?.pagesPerMonth;
  return base == null ? null : base + extraPagesFor(tenantRow) + rescuePagesFor(tenantRow);
}

/**
 * R36: the Records Rescue page credit of the CURRENT tenant (call inside withTenant / a store with `.raw`).
 *
 * Granted = sum of `rescuePages` over the tenant's webhook-ledger rows (api/_lib/billing.js recordAndApplyEvent writes one
 * per paid checkout, keyed by the Stripe event id, so a replay cannot add twice). Used = the pages a past month read
 * ABOVE that month's plan + extra allowance (the allowance is spent first; only the overflow draws on the credit), summed
 * from the month of the first purchase up to, not including, this month. This month's overflow is simply headroom the
 * credit provides: remaining = granted - used in earlier months, and the monthly cap is plan + extra + remaining.
 * Past months use TODAY's plan allowance (a plan change shifts what earlier overflow counts as; documented, not tracked).
 * Fails safe: any error means "no credit" (the plain plan cap applies) and is logged.
 * @returns {Promise<{granted: number, used: number, remaining: number}>}
 */
export async function loadRescueCredit(db, tenantRow, now = new Date()) {
  const none = { granted: 0, used: 0, remaining: 0 };
  try {
    const T = "tenant_id = (current_setting('app.tenant_id', true))::uuid";
    const g = await db.raw(
      `SELECT COALESCE(SUM((payload->>'rescuePages')::bigint), 0)::bigint AS granted, MIN(received_at) AS first_at
         FROM billing_events
        WHERE ${T} AND payload ? 'rescuePages'`,
      []
    );
    const granted = Number(g.rows[0]?.granted) || 0;
    if (granted <= 0) return none;
    const firstAt = g.rows[0]?.first_at ? new Date(g.rows[0].first_at) : now;
    const firstMonth = new Date(Date.UTC(firstAt.getUTCFullYear(), firstAt.getUTCMonth(), 1)).toISOString();
    const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const monthlyAllowance = (PLAN_LIMITS[tenantRow?.plan]?.pagesPerMonth ?? 0) + extraPagesFor(tenantRow);
    // R43: pages read inside a staff import window never draw on the monthly allowance, so they do not draw on the credit.
    const win = staffImportWindowFor(tenantRow);
    const u = await db.raw(
      `SELECT COALESCE(SUM(GREATEST(n - $3::bigint, 0)), 0)::bigint AS used FROM (
         SELECT count(*) AS n FROM document_pages
          WHERE ${T} AND created_at >= $1::timestamptz AND created_at < $2::timestamptz
            AND ($4::timestamptz IS NULL OR created_at < $4::timestamptz OR created_at >= $5::timestamptz)
          GROUP BY date_trunc('month', created_at AT TIME ZONE 'UTC')
       ) m`,
      [firstMonth, thisMonth, monthlyAllowance, win?.from ?? null, win?.to ?? null]
    );
    const used = Math.min(granted, Number(u.rows[0]?.used) || 0);
    return { granted, used, remaining: Math.max(0, granted - used) };
  } catch (err) {
    console.error('rescue credit lookup failed (plain plan cap applies):', err?.message);
    return none;
  }
}

/** The stored-documents cap for the tenant's plan, or null when uncapped (Fleet) / no plan. */
export function documentCapFor(tenantRow) {
  return PLAN_LIMITS[tenantRow?.plan]?.documentsStored ?? null;
}

/** "Oct 1" - when the monthly page count starts over (UTC calendar month; the same date the Billing screen shows). */
export function monthResetLabel(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return `${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${d.getUTCDate()}`;
}

const fmtInt = (n) => Number(n).toLocaleString('en-US');

/**
 * Pure (R35): the pages one upload is expected to add, for gating only (nothing is billed from this). Photos 1; PDFs about
 * 200 KB a page; text 6,000 characters a page (readDocument's PAGE_CHARS); never below 1, never above 200 for one file.
 * Mirrors recordsStore.js estimatePendingPages' SQL, which is what counts the same file once it is stored.
 */
export function estimatePagesForUpload(contentType, sizeBytes) {
  const size = Number(sizeBytes);
  const bytes = Number.isFinite(size) && size > 0 ? size : 0;
  const type = String(contentType ?? '').toLowerCase();
  if (type.startsWith('image/')) return 1;
  // Office build: Word / Excel / CSV by the rule in office/limits.js (a compressed size is all that is known before reading).
  if (type === DOCX_CONTENT_TYPE) {
    return Math.max(1, Math.min(ESTIMATE_DOCX_MAX_PAGES, Math.ceil(Math.max(0, bytes - ESTIMATE_DOCX_FIXED_BYTES) / ESTIMATE_DOCX_BYTES_PER_PAGE)));
  }
  if (type === XLSX_CONTENT_TYPE) return Math.max(1, Math.min(ESTIMATE_SHEET_MAX_PAGES, Math.ceil(Math.max(0, bytes - ESTIMATE_XLSX_FIXED_BYTES) / ESTIMATE_XLSX_BYTES_PER_PAGE)));
  if (type === 'text/csv' || type === 'text/tab-separated-values') {
    return Math.max(1, Math.min(ESTIMATE_SHEET_MAX_PAGES, Math.ceil(bytes / ESTIMATE_CSV_BYTES_PER_PAGE)));
  }
  const per = type === 'application/pdf' ? 204_800 : 6_000;
  return Math.max(1, Math.min(200, Math.ceil(bytes / per)));
}

/**
 * Gate for POST /api/upload-url (new ingestion).
 * @param {object} tenantRow
 * @param {{documentsStored: number, pagesThisMonth: number, pendingPages?: number}} usage
 *   `pendingPages` (R30 M6): estimated pages of documents uploaded but not yet read. document_pages rows only exist
 *   after the read step, so pipelining uploads faster than the reader used to slip past the monthly cap.
 * @param {Date} [now]
 * @returns {{allowed: true, pagesRemaining: number|null, documentsRemaining: number|null}|{allowed: false, status: 402, error: string, url: string}}
 *   On allow, `pagesRemaining` / `documentsRemaining` (R35) say how much headroom is left (null = uncapped), so a batch of
 *   50 files stops at the cap instead of every file in it sailing past a check that only looked at the count before it.
 */
export function gateUpload(tenantRow, usage, now) {
  const state = planStateFor(tenantRow, now);
  const billingUrl = '/app/?screen=billing';

  if (state === 'none') {
    if (freePreviewExhausted(usage)) {
      return requireActiveBilling(tenantRow, now);
    }
    return { allowed: true, pagesRemaining: null, documentsRemaining: null };
  }
  if (state === 'canceled') {
    return requireActiveBilling(tenantRow, now);
  }
  if (state === 'past_due' && isPastGrace(tenantRow, now)) {
    // R35: not a bare "Subscription required" dead end - say why, what still works, and where to fix it.
    return {
      allowed: false, status: 402, url: billingUrl,
      error: "Subscription required: your last payment didn't go through, so adding new documents is paused. Update your payment method in Billing to continue. Everything you've already added is safe and Donovan still answers.",
    };
  }
  // trialing, active, or past_due-within-grace: check the monthly page cap and the stored-document cap.
  const pagesRead = Number(usage?.pagesThisMonth) || 0;
  const pending = Math.max(0, Math.trunc(Number(usage?.pendingPages) || 0));
  // R43: while a staff import is active, a dedicated import page budget replaces the monthly cap (and the stored-document
  // cap is raised by `documents`); the pages it reads are kept out of the monthly count (recordsStore.js countPagesSince).
  const imp = staffImportFor(tenantRow, now);
  if (imp?.active) {
    const importUsed = Math.max(0, Math.trunc(Number(usage?.importPagesUsed) || 0));
    if (importUsed + pending >= imp.pages) {
      return { allowed: false, status: 402, url: billingUrl, code: IMPORT_ALLOWANCE_CODE, error: importAllowanceMessage(imp.pages) };
    }
    const docCapI = documentCapFor(tenantRow);
    const docsI = Number(usage?.documentsStored);
    if (docCapI != null && Number.isFinite(docsI) && docsI >= docCapI + imp.documents) {
      return {
        allowed: false, status: 402, url: billingUrl, code: 'import-documents-exhausted',
        error: `Your plan stores up to ${fmtInt(docCapI)} documents${imp.documents ? ` (${fmtInt(imp.documents)} more are allowed while the DeepWell import is open)` : ''} and you have ${fmtInt(docsI)}. DeepWell staff can raise the import's document allowance, or move you to a larger plan.`,
      };
    }
    return {
      allowed: true, importMode: true,
      pagesRemaining: Math.max(0, imp.pages - importUsed - pending),
      documentsRemaining: docCapI == null || !Number.isFinite(docsI) ? null : Math.max(0, docCapI + imp.documents - docsI),
    };
  }
  const cap = pageCapFor(tenantRow);
  const topPlan = tenantRow?.plan === 'fleet';
  const moreHelp = topPlan
    ? 'Email support@deepwelltechnology.com to add pages for a big import.'
    : 'Upgrade your plan for more.';
  if (cap != null && pagesRead + pending >= cap) {
    const resets = `It resets on ${monthResetLabel(now)}.`;
    const error = pagesRead >= cap
      ? `Monthly page limit reached (${fmtInt(cap)}). ${resets} ${moreHelp}`
      : `Monthly page limit reached (${fmtInt(cap)}): ${fmtInt(pagesRead)} pages are read and about ${fmtInt(pending)} more are still being processed. Wait for them to finish. ${resets} ${moreHelp}`;
    return { allowed: false, status: 402, error, url: billingUrl };
  }
  const docCap = documentCapFor(tenantRow);
  const docs = Number(usage?.documentsStored);
  if (docCap != null && Number.isFinite(docs) && docs >= docCap) {
    return {
      allowed: false, status: 402, url: billingUrl,
      error: `Your plan stores up to ${fmtInt(docCap)} documents and you have ${fmtInt(docs)}. Delete documents you no longer need, or upgrade your plan for more room. You can still search and ask about everything you have.`,
    };
  }
  return {
    allowed: true,
    pagesRemaining: cap == null ? null : Math.max(0, cap - pagesRead - pending),
    documentsRemaining: docCap == null || !Number.isFinite(docs) ? null : Math.max(0, docCap - docs),
  };
}

/** R43: the 402 text when the staff import's page budget is used up. */
export function importAllowanceMessage(pages) {
  return `The temporary page allowance for DeepWell's data import on this account (${fmtInt(pages)} pages) is used up, so nothing more can be added right now. Everything already uploaded is safe. DeepWell staff can raise the allowance; then run the import again and it carries on where it stopped.`;
}

/** R35: the per-file 402 a batch reports for a file that did not fit under the monthly page cap / stored-document cap. */
export function batchLimitMessage(kind, tenantRow, now) {
  const imp = staffImportFor(tenantRow, now);
  if (imp?.active && kind === 'pages') return importAllowanceMessage(imp.pages);
  if (kind === 'documents') {
    return `Your plan's document limit was reached part-way through this batch. Delete documents you no longer need, or upgrade your plan, then add the rest again.`;
  }
  const cap = pageCapFor(tenantRow);
  const more = tenantRow?.plan === 'fleet' ? 'Email support@deepwelltechnology.com to add pages.' : 'Upgrade your plan for more.';
  return `Monthly page limit reached (${cap == null ? '' : fmtInt(cap)}) part-way through this batch, so this file was not added. The count resets on ${monthResetLabel(now)}. ${more}`;
}

/**
 * Gate for POST /api/ask. Ask is read-only in nature, so it stays available
 * through past-due grace AND past-grace — only a never-subscribed tenant that
 * has exhausted its free preview, or a canceled subscription, blocks it.
 * Round 26: there is NO plan-sized ask allowance any more (Donovan is
 * unlimited on every plan). The only other check is the hidden safety
 * ceiling — a very high monthly count that stops runaway automation — and its
 * message is deliberately a polite support contact, never an upgrade prompt.
 * @param {object} tenantRow
 * @param {{documentsStored: number, asksThisMonth?: number}} usage
 * @param {Date} [now]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function gateAsk(tenantRow, usage, now = new Date(), env = process.env) {
  const state = planStateFor(tenantRow, now);

  if ((state === 'none' && freePreviewExhausted(usage)) || state === 'canceled') {
    return requireActiveBilling(tenantRow, now);
  }

  if ((Number(usage?.asksThisMonth) || 0) >= donovanSafetyPerMonth(env)) {
    return { allowed: false, status: 429, error: DONOVAN_SAFETY_MESSAGE, scope: 'safety' };
  }
  return { allowed: true };
}

/**
 * API_PERF_2026-09-22: billing-gate row cache, DELIBERATELY separate from
 * recordsStore.js's 5-minute getTenantContext cache (getCachedBillingRow
 * reads THROUGH that cache below, but re-keys its own, shorter-lived entry
 * on top of it). requireActiveBilling's whole job is noticing a subscription
 * has gone 'none'/'canceled', so this cache cannot use a 5-minute blind spot
 * — that would mean a tenant who cancels keeps full access for up to five
 * more minutes. 2 minutes for every other state (trialing/active/past_due);
 * 30 seconds once the cached state IS 'none' or 'canceled' — long enough to
 * spare the database under load, short enough that reactivating a plan (or a
 * fixed payment method putting it back to 'active') takes effect within half
 * a minute rather than five.
 *
 * Shared by assertActiveBilling (below) and upload-url.js's checkUploadGate —
 * see each call site — so two gates checking the same tenant in the same
 * request never run this lookup twice.
 */
export const BILLING_ROW_TTL_MS = 2 * 60_000;
export const BILLING_ROW_BLOCKED_TTL_MS = 30_000;
const billingRowCache = new TTLCache(BILLING_ROW_TTL_MS, 1000);
registerTenantCache(billingRowCache);

async function fetchBillingRow(ctx) {
  const t = await getTenantContext(ctx.tenantKey, ctx.tenantName ?? ctx.tenantKey);
  const row = { plan: t.plan, billing_status: t.billingStatus, trial_ends_at: t.trialEndsAt, current_period_end: t.currentPeriodEnd, limits: t.limits ?? {} };
  // R36: unused Records Rescue pages raise this tenant's monthly cap. Only a tenant on a capped plan can use them, and the
  // lookup is cached with the row (2 min), so this is one small query per tenant per cache window, not per upload.
  if (PLAN_LIMITS[row.plan]) {
    try {
      row.rescuePagesRemaining = (await withTenant(ctx, (db) => loadRescueCredit(db, row))).remaining;
    } catch (err) {
      console.error('billing gate: rescue credit unavailable (plain plan cap applies):', err?.message);
    }
  }
  return row;
}

/**
 * Pure: which TTL a just-fetched billing row should be cached under. Split
 * out from getCachedBillingRow so scripts/verify-perf.mjs can assert the
 * 'none'/'canceled' -> short-TTL rule directly, with no database and no
 * cache object involved.
 * @param {{billing_status?: string|null, trial_ends_at?: *}} row
 * @param {Date} [now]
 */
export function billingCacheTtlFor(row, now = new Date()) {
  const state = planStateFor(row, now);
  return state === 'none' || state === 'canceled' ? BILLING_ROW_BLOCKED_TTL_MS : BILLING_ROW_TTL_MS;
}

/**
 * @param {{tenantKey: string, tenantName?: string}} ctx
 * @returns {Promise<{plan?: string|null, billing_status?: string|null, trial_ends_at?: *, current_period_end?: *}>}
 */
export async function getCachedBillingRow(ctx) {
  const tenantKey = ctx?.tenantKey;
  if (!tenantKey) return {};
  const start = Date.now();
  const hit = billingRowCache.get(tenantKey) !== undefined;
  const row = await memoAsync(billingRowCache, tenantKey, () => fetchBillingRow(ctx), BILLING_ROW_TTL_MS);
  if (!hit) {
    // A freshly-fetched BLOCKED state is re-capped to the short TTL right
    // away, rather than left to expire on the normal 2-minute schedule — see
    // this cache's own doc comment for why 'none'/'canceled' can't wait that
    // long.
    const ttl = billingCacheTtlFor(row);
    if (ttl === BILLING_ROW_BLOCKED_TTL_MS) billingRowCache.set(tenantKey, row, ttl);
  }
  logStage({ t: 'billing_gate_row', ms: Date.now() - start, cacheHit: hit });
  return row;
}

/** Test-only: clear the billing row cache between fixtures. */
export function _resetBillingRowCache() {
  billingRowCache.map.clear();
}

/** Test-only: seed a row directly, bypassing getTenantContext/the database —
 *  scripts/verify-perf.mjs uses this to exercise the cache-bust path without
 *  a live Postgres connection. */
export function _seedBillingRowForTest(tenantKey, row, ttlMs = BILLING_ROW_TTL_MS) {
  billingRowCache.set(tenantKey, row, ttlMs);
}

/** Test-only: read a tenant's raw cache entry (undefined if absent/expired),
 *  with no fetch-on-miss — the read side of _seedBillingRowForTest. */
export function _peekBillingRowForTest(tenantKey) {
  return billingRowCache.get(tenantKey);
}

/**
 * DB-touching sibling of requireActiveBilling(), for routes that have no
 * bespoke gate wrapper of their own: read-document.js, extract.js, and
 * review.js's model-calling actions (reclassify). upload-url.js and ask.js
 * keep their own checkUploadGate/checkAskGate wrappers instead of this one
 * because gateUpload/gateAsk need `usage` for page-cap math this function
 * doesn't do — but both of those call requireActiveBilling() above for the
 * exact same 'none'/'canceled' decision, so the rule itself still lives
 * once.
 *
 * FAILS CLOSED — the opposite of every other gate in this file, and of
 * api/_lib/rateLimit.js's assertModelBudget. Those fail open because a
 * broken lookup degrading to "allow" only ever costs a few cents of
 * additional Anthropic spend on an ALREADY-PAYING tenant. This function
 * guards the routes that would otherwise let a tenant with NO active
 * subscription keep spending real Anthropic-billed model calls indefinitely
 * if the billing lookup itself were ever the thing that broke — so a lookup
 * failure here returns a 503 instead of quietly running the model.
 *
 * @param {{tenantKey: string, tenantName?: string}} ctx
 * @param {Date} [now]
 * @returns {Promise<
 *   {allowed: true} |
 *   {allowed: false, status: 402, error: string, url: string} |
 *   {allowed: false, status: 503, error: string}
 * >}
 */
export async function assertActiveBilling(ctx, now = new Date()) {
  try {
    // API_PERF_2026-09-22: used to open its OWN withTenant transaction just to
    // run this one SELECT — a full BEGIN/resolve_tenant/SET LOCAL/COMMIT round
    // trip for a single read. getCachedBillingRow shares its cache (and TTL
    // rule — see the cache's own doc comment) with upload-url.js's
    // checkUploadGate, so two routes gating the same request no longer each
    // pay for this lookup, and a warm cache hit costs nothing at all.
    const row = await getCachedBillingRow(ctx);
    return requireActiveBilling(row, now);
  } catch (err) {
    console.error('billing gate failed CLOSED (assertActiveBilling):', err?.message);
    return { allowed: false, status: 503, error: 'Billing check unavailable, try again' };
  }
}
