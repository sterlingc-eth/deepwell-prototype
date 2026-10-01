/**
 * Login ("seat") entitlements — Round 26 plan tiers.
 *
 * Solo 2, Team 5, Crew 10 logins, Fleet 11+ (no DeepWell cap) — see plan.js
 * PLAN_LIMITS.logins. "Logins" are people who can sign in to the shop, NOT
 * counting the ONE owner account.
 *
 * WHO IS THE OWNER (decision, documented in handoffs/ROUND26_PLAN_TIERS.md):
 * the Clerk organization's own `createdBy` — the user who created the org
 * (the shop). It is set by Clerk once, at creation, never changes when roles
 * are edited, and is the same person who starts the Stripe checkout (billing
 * is admin-only and a new shop's creator is its first admin). It needs no
 * DeepWell column (no DDL). Fallback when Clerk returns no createdBy (a very
 * old org, or the creating user was deleted): the earliest-joined ADMIN
 * membership. If neither exists there is no owner exclusion (everyone counts).
 * Extra admins are NOT the owner and DO count.
 *
 * WHAT COUNTS: every active membership except the owner + every pending
 * invitation (so an admin cannot over-invite while invites are outstanding).
 *
 * ENFORCEMENT (three layers):
 *  1. UI — TeamScreen shows "N of M logins used (owner not counted)" and
 *     replaces Clerk's invite button with a form that is disabled at the cap.
 *  2. Server invite guard — POST /api/billing?action=invite (guardedInvite
 *     below) refuses an invite when used >= cap and only then calls Clerk's
 *     Backend API. Clerk's own invite button is hidden in the UI.
 *  3. Clerk backstop — every plan change / lazy sync sets the org's
 *     maxAllowedMemberships to cap + 1 (the owner's own seat); Fleet -> 0
 *     (unlimited on DeepWell's side). Clerk's instance-level plan limit still
 *     applies underneath: a value Clerk refuses is logged and skipped, never
 *     thrown (billing must never break on it).
 *
 * GRANDFATHERING: nobody is ever removed or locked out by a downgrade or a
 * legacy over-cap org. Admins see the banner; NEW invites are blocked until
 * the org is back under the cap. If Clerk refuses to lower maxAllowedMemberships
 * below the current member count, that too is logged and ignored.
 *
 * Every function that talks to Clerk takes an injectable `clerk` client so
 * scripts/verify-plan-tiers-r26.mjs runs with no network.
 */
import { loginCapForPlan } from './plan.js';
import { getPool } from './recordsStore.js';

export const OWNER_NOT_COUNTED = 'owner not counted';

/** Clerk maxAllowedMemberships for a DeepWell login cap: cap + 1 (the owner's
 * seat); a null cap (Fleet) -> 0, which Clerk defines as "unlimited". */
export function clerkLimitForCap(cap) {
  return cap == null ? 0 : cap + 1;
}

/** "3 of 5 logins used (owner not counted)" / "3 logins used (owner not counted)". */
export function seatLabel(used, cap) {
  return cap == null
    ? `${used} login${used === 1 ? '' : 's'} used (${OWNER_NOT_COUNTED})`
    : `${used} of ${cap} login${cap === 1 ? '' : 's'} used (${OWNER_NOT_COUNTED})`;
}

/** Normalise a Clerk membership role to admin / member. */
function isAdminMembership(m) {
  return String(m?.role ?? '').replace(/^org:/, '').trim().toLowerCase() === 'admin';
}

function membershipUserId(m) {
  return m?.publicUserData?.userId ?? m?.userId ?? null;
}

/**
 * The owner's Clerk user id: org.createdBy WHEN that user is still a member of the org, else the earliest-joined
 * admin membership, else null. Pure.
 *
 * Why the membership check: createdBy is immutable in Clerk. If the creator later left / was removed (or the org
 * was created by a DeepWell staff account that is not a member), excluding a user who is not even in the org would
 * exclude nobody and charge the shop's real top admin a login. Falling back to the earliest admin keeps
 * "exactly one owner account is free" true in every case (and can never exclude more than one person).
 */
export function resolveOwnerUserId(org, memberships = []) {
  const created = org?.createdBy ?? null;
  const present = memberships.map(membershipUserId).filter(Boolean);
  if (created && present.includes(created)) return created;
  const admins = memberships.filter(isAdminMembership).filter((m) => membershipUserId(m));
  admins.sort((a, b) => (Number(a?.createdAt) || 0) - (Number(b?.createdAt) || 0));
  if (admins.length) return membershipUserId(admins[0]);
  return created;
}

/**
 * Pure seat math. `memberships` / `invitations` are Clerk backend resources
 * (or anything with the same fields); only pending invitations are counted.
 * @param {{cap: number|null, ownerUserId?: string|null, memberships?: any[], invitations?: any[]}} args
 */
export function computeSeatUsage({ cap, ownerUserId = null, memberships = [], invitations = [] }) {
  const members = memberships.filter((m) => !(ownerUserId && membershipUserId(m) === ownerUserId)).length;
  const pending = invitations.filter((i) => !i?.status || i.status === 'pending').length;
  const used = members + pending;
  const c = cap ?? null;
  return {
    cap: c,
    ownerUserId,
    members,
    pending,
    used,
    remaining: c == null ? null : Math.max(0, c - used),
    atCap: c != null && used >= c,
    overCap: c != null && used > c,
    label: seatLabel(used, c),
  };
}

/** Structured, loggable view of an error thrown by the Clerk SDK. */
export function describeClerkError(err) {
  const first = err?.errors?.[0];
  return {
    status: err?.status ?? err?.statusCode ?? null,
    code: first?.code ?? null,
    message: first?.longMessage ?? first?.message ?? err?.message ?? 'unknown error',
  };
}

let _clerk;
/** Test-only: inject a fake Clerk client for the webhook / lazy-sync paths (pass null to reset). */
export function _setClerkForTest(c) { _clerk = c ?? undefined; }
async function getClerk(opts = {}) {
  if (opts.clerk) return opts.clerk;
  if (_clerk) return _clerk;
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) return null;
  try {
    const { createClerkClient } = await import('@clerk/backend');
    _clerk = createClerkClient({ secretKey });
    return _clerk;
  } catch (err) {
    console.error('seats: Clerk client unavailable:', err?.message);
    return null;
  }
}

/** Reject after `ms` so a hung Clerk call can never stall a webhook / the Team screen for the whole function timeout. */
export function withTimeout(promise, ms, label = 'Clerk') {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
export const CLERK_CALL_TIMEOUT_MS = 10_000;

const PAGE = 100;
const MAX_PAGES = 20; // 2,000 rows: far past any plausible shop, bounded so a bad org can't loop forever

async function listAll(fetchPage) {
  const out = [];
  for (let i = 0; i < MAX_PAGES; i++) {
    const res = await fetchPage(i * PAGE);
    const data = res?.data ?? res ?? [];
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

/**
 * Live seat state for an org from Clerk. Throws on a Clerk failure (callers
 * decide whether that is fatal).
 * @returns {Promise<ReturnType<typeof computeSeatUsage> & {org: any}>}
 */
export async function getSeatState({ orgId, plan, clerk: injected }) {
  const clerk = await getClerk({ clerk: injected });
  if (!clerk) throw new Error('Clerk is not configured');
  const cap = loginCapForPlan(plan) ?? null;
  const [org, memberships, invitations] = await withTimeout(Promise.all([
    clerk.organizations.getOrganization({ organizationId: orgId }),
    listAll((offset) => clerk.organizations.getOrganizationMembershipList({ organizationId: orgId, limit: PAGE, offset })),
    listAll((offset) => clerk.organizations.getOrganizationInvitationList({ organizationId: orgId, status: ['pending'], limit: PAGE, offset })),
  ]), CLERK_CALL_TIMEOUT_MS, 'Clerk seat lookup');
  const ownerUserId = resolveOwnerUserId(org, memberships);
  return { ...computeSeatUsage({ cap, ownerUserId, memberships, invitations }), org };
}

// One lazy sync per org per plan per 10 minutes per warm instance (the
// webhook / reconcile path passes force:true and always syncs).
const SYNC_MIN_INTERVAL_MS = 10 * 60 * 1000;
const _syncAt = new Map();
export function _resetSyncThrottle() { _syncAt.clear(); }

/**
 * Set the Clerk organization's maxAllowedMemberships to (login cap + 1), or 0
 * (unlimited) on Fleet. NEVER throws: returns
 *   { ok, action: 'updated'|'unchanged'|'skipped'|'throttled'|'rejected'|'error', target?, reason?, clerkStatus?, clerkCode? }
 * 'rejected' = Clerk answered with a 4xx (e.g. the value exceeds the Clerk
 * instance's own plan limit); 'error' = anything else (network, 5xx, no key).
 * @param {{orgId: string, plan: string|null|undefined, clerk?: any, force?: boolean, org?: any, now?: number}} args
 */
export async function syncOrgMemberLimit({ orgId, plan, clerk, force = false, org = null, now = Date.now() }) {
  let throttleKey = null;
  try {
    if (typeof orgId !== 'string' || !orgId.startsWith('org_')) return { ok: true, action: 'skipped', reason: 'not-an-org' };
    const cap = loginCapForPlan(plan);
    if (cap === undefined) return { ok: true, action: 'skipped', reason: 'no-plan' };
    const target = clerkLimitForCap(cap);

    const key = `${orgId}:${target}`;
    throttleKey = key;
    if (!force && now - (_syncAt.get(key) ?? 0) < SYNC_MIN_INTERVAL_MS) return { ok: true, action: 'throttled', target };

    const client = await getClerk({ clerk });
    if (!client) return { ok: false, action: 'error', reason: 'clerk-unavailable', target };

    let current = org?.maxAllowedMemberships;
    if (current === undefined) {
      const fetched = await client.organizations.getOrganization({ organizationId: orgId });
      current = fetched?.maxAllowedMemberships;
    }
    if (current === target) {
      _syncAt.set(key, now);
      return { ok: true, action: 'unchanged', target };
    }
    await client.organizations.updateOrganization(orgId, { maxAllowedMemberships: target });
    _syncAt.set(key, now);
    return { ok: true, action: 'updated', target, previous: current ?? null };
  } catch (err) {
    const d = describeClerkError(err);
    const rejected = typeof d.status === 'number' && d.status >= 400 && d.status < 500;
    // A Clerk 4xx will keep failing until the owner raises the Clerk limit: remember the attempt so opening the
    // Team screen does not re-send the same doomed write (and re-log it) every time. force:true still retries.
    if (rejected && throttleKey) _syncAt.set(throttleKey, now);
    console.error(
      `seats: could not set Clerk maxAllowedMemberships for ${orgId} (${rejected ? 'Clerk rejected the value — raise the Clerk member limit' : 'error'}; non-fatal):`,
      d.status ?? '', d.code ?? '', d.message
    );
    return { ok: false, action: rejected ? 'rejected' : 'error', reason: d.message, clerkStatus: d.status, clerkCode: d.code };
  }
}

/**
 * Look up a tenant's Clerk org key + plan after a billing change and sync the
 * Clerk limit. Runs inside a tenant-scoped transaction because `tenants` is
 * FORCE RLS (a plain SELECT with no app.tenant_id returns nothing). Never throws.
 * @param {{connect: Function}} pool  pg pool
 */
export async function syncTenantAfterBilling(pool, tenantId, opts = {}) {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const { rows } = await client.query('SELECT clerk_org_id, plan FROM tenants WHERE id = $1', [tenantId]);
    await client.query('COMMIT');
    // Free the pool connection BEFORE the network call to Clerk (the pool is small; never hold a DB connection across it).
    client.release();
    client = null;
    const row = rows[0];
    if (!row?.clerk_org_id) return { ok: true, action: 'skipped', reason: 'no-org' };
    // Bounded: this runs inside the Stripe webhook, which must answer promptly whatever Clerk is doing.
    return await withTimeout(
      syncOrgMemberLimit({ orgId: row.clerk_org_id, plan: opts.plan ?? row.plan, clerk: opts.clerk, force: true }),
      CLERK_CALL_TIMEOUT_MS,
      'Clerk limit sync'
    );
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('seats: post-billing Clerk sync failed (non-fatal):', err?.message);
    return { ok: false, action: 'error', reason: err?.message };
  } finally {
    client?.release();
  }
}

/** Display name for a plan id (the 'shop' id is shown to people as "Team"; ids themselves never change). */
const planDisplayName = (plan) => {
  const id = String(plan);
  return id === 'shop' ? 'Team' : id.charAt(0).toUpperCase() + id.slice(1);
};

export const SEAT_LIMIT_MESSAGE = (plan, cap, used = null) =>
  // R35: after a downgrade (or an invite accepted just before one) an org can be OVER its cap. Say so plainly: current
  // members keep their access, only NEW invites are blocked, and removing people or upgrading is the way back.
  (Number.isFinite(used) && used > cap
    ? `Your team has ${used} logins (including pending invites) but your ${planDisplayName(plan)} plan includes up to ${cap}. Everyone already on the team keeps their access; to invite someone new, remove ${used - cap} login${used - cap === 1 ? '' : 's'} or upgrade your plan.`
    : null) ??
  `Your ${planDisplayName(plan)} plan includes up to ${cap} login${cap === 1 ? '' : 's'} (the owner account isn't counted). Upgrade your plan to invite more people.`;

/**
 * The server-side invite guard. Counts live (members + pending invites, owner
 * excluded) and refuses when used >= cap — including an org that is already
 * over cap (grandfathered members stay, new invites are blocked). Only when
 * under cap does it create the invitation through Clerk's Backend API.
 * Returns { ok: true, invitation, seats } or { ok: false, status, error, seats?, url? }.
 * @param {{orgId: string, plan: string|null, email: string, role?: 'admin'|'member', inviterUserId?: string, clerk?: any, redirectUrl?: string}} args
 */
export async function guardedInvite(args) {
  // R30 L6: the count (getSeatState) and the create (createOrganizationInvitation) below are two calls, so two
  // admins inviting at the same moment both saw "under cap" and both created an invite. Serialise per org: an
  // in-process queue (same warm instance) plus a Postgres advisory lock held across the pair (other instances).
  // The lock is best effort - if there is no database, or it errors, the in-process queue and Clerk's own
  // maxAllowedMemberships (the backstop) still apply.
  return withOrgInviteLock(args?.orgId, () => guardedInviteUnlocked(args));
}

const inviteChains = new Map();
async function withOrgInviteLock(orgId, fn) {
  const key = String(orgId ?? '');
  const prev = inviteChains.get(key) ?? Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  const tail = prev.then(() => mine);
  inviteChains.set(key, tail);
  await prev;
  let lockClient = null;
  try {
    try {
      const pool = getPool();
      const connecting = pool.connect();
      let timer;
      try {
        lockClient = await Promise.race([
          connecting,
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('invite lock: connect timed out')), 2000); timer.unref?.(); }),
        ]);
      } catch (e) {
        connecting.then((c) => c.release()).catch(() => {}); // a late connection must not leak
        throw e;
      } finally {
        clearTimeout(timer);
      }
      await lockClient.query('BEGIN');
      await lockClient.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`invite:${key}`]);
    } catch {
      if (lockClient) { await lockClient.query('ROLLBACK').catch(() => {}); lockClient.release(); }
      lockClient = null;
    }
    return await fn();
  } finally {
    if (lockClient) { await lockClient.query('COMMIT').catch(() => {}); lockClient.release(); }
    release();
    if (inviteChains.get(key) === tail) inviteChains.delete(key);
  }
}

async function guardedInviteUnlocked({ orgId, plan, email, role = 'member', inviterUserId, clerk, redirectUrl }) {
  const cap = loginCapForPlan(plan);
  if (cap === undefined) return { ok: false, status: 402, error: 'Choose a plan to get started', url: '/app/?screen=billing' };
  const addr = String(email ?? '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) return { ok: false, status: 400, error: 'Enter a valid email address' };

  const client = await getClerk({ clerk });
  if (!client) return { ok: false, status: 503, error: 'Invites are unavailable right now. Try again in a moment.' };

  let seats;
  try {
    seats = await getSeatState({ orgId, plan, clerk: client });
  } catch (err) {
    console.error('seats: could not read org seats for invite:', describeClerkError(err).message);
    return { ok: false, status: 503, error: 'Could not check your team size. Try again in a moment.' };
  }
  const { org: _org, ...view } = seats;
  if (cap != null && seats.used >= cap) {
    return { ok: false, status: 402, error: SEAT_LIMIT_MESSAGE(plan, cap, seats.used), seats: view, url: '/app/?screen=billing' };
  }
  try {
    const invitation = await client.organizations.createOrganizationInvitation({
      organizationId: orgId,
      emailAddress: addr,
      role: role === 'admin' ? 'org:admin' : 'org:member',
      ...(inviterUserId ? { inviterUserId } : {}),
      ...(redirectUrl ? { redirectUrl } : {}),
    });
    const used = view.used + 1;
    return {
      ok: true,
      invitation: { id: invitation?.id ?? null, emailAddress: addr },
      seats: {
        ...view,
        pending: view.pending + 1,
        used,
        remaining: cap == null ? null : Math.max(0, cap - used),
        atCap: cap != null && used >= cap,
        label: seatLabel(used, cap),
      },
    };
  } catch (err) {
    const d = describeClerkError(err);
    const quota = /member.*(limit|quota)|quota|exceed|maximum/i.test(`${d.code} ${d.message}`);
    if (quota) {
      return { ok: false, status: 402, error: cap != null ? SEAT_LIMIT_MESSAGE(plan, cap, seats?.used) : 'Your team has reached its member limit. Contact support@deepwelltechnology.com.', seats: view, url: '/app/?screen=billing' };
    }
    const status = d.status === 422 || d.status === 400 ? 400 : d.status === 409 ? 409 : 502;
    return { ok: false, status, error: status === 502 ? 'Could not send that invite. Try again in a moment.' : d.message };
  }
}
