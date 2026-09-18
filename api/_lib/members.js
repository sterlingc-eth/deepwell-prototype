/**
 * Records a technician as a member of their shop.
 *
 * Nothing ever inserted a `users` row before this file existed, which is why
 * `audit_log.user_id` was always null: recordsStore.js's logAction() has
 * always looked one up by clerk_user_id, but there was never anything to find.
 *
 * DEVIATION FROM THE ORIGINAL PLAN, FLAGGED HERE ON PURPOSE:
 * The natural way to write this would be `withTenant(ctx, (store) => ...)`
 * from ../_lib/recordsStore.js, reusing its transaction + RLS-scoping dance.
 * That is not possible without editing recordsStore.js, which this task does
 * not own: `withTenant`'s callback only ever receives the higher-level
 * `store` object (createDocument, listEntities, ...), never the raw `pg`
 * client underneath it, and there is no `users` table method on `store` to
 * call. So this file opens its own single-connection pool and replicates the
 * three-line scoping dance `withTenant` already does (resolve_tenant, then
 * `SET LOCAL app.tenant_id`) rather than duplicating none of it and guessing.
 * See HANDOFF.md for the one-line change to recordsStore.js that would let
 * this file delete its own pool and go through `withTenant` properly.
 *
 * CONNECTION COST, ACCEPTED AT THIS SCALE: this is a second pool alongside
 * recordsStore.js's, so an authenticated request now opens up to two Postgres
 * connections instead of one. For a five-technician shop that is nothing;
 * `max: 1` here keeps it from ever being more than one extra connection at a
 * time. If DeepWell grows into many concurrently-active shops, this should be
 * consolidated into recordsStore.js's own pool (see HANDOFF.md) rather than
 * scaled up as two independent pools.
 */
import pg from "pg";

let pool;

function getPool() {
  if (!pool) {
    const connectionString = process.env.NEON_CONNECTION_STRING;
    if (!connectionString) throw new Error("NEON_CONNECTION_STRING is not set");
    pool = new pg.Pool({
      connectionString,
      max: 1,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 8_000,
    });
  }
  return pool;
}

/**
 * users.role has a CHECK (role IN ('admin', 'user')) — it predates Clerk
 * organizations and calls the non-admin role 'user', not 'member'. Mapped
 * here rather than changing the CHECK, since nothing downstream reads
 * users.role today and widening the CHECK to also accept 'member' would just
 * be a second spelling of the same thing.
 */
function toUsersRole(orgRole) {
  return orgRole === "admin" ? "admin" : "user";
}

/**
 * Upsert the `users` row for an authenticated request that belongs to a shop.
 *
 * Takes `auth` alone (not `(ctx, auth)`) — there is no separate tenant
 * context to pass once resolve_tenant() is called with auth.orgId directly;
 * see the file header for why this doesn't take the `withTenant`-shaped ctx
 * the original request described.
 *
 * One upsert per authenticated request that has an active org. Cheap at this
 * scale (see the file header); called from requireAuth() in ./auth.js so
 * every route gets it for free without any of the route files (owned by
 * other engineers) having to remember to call it.
 *
 * users.email is NOT NULL, but a Clerk session token is not guaranteed to
 * carry `email` (see auth.js's header comment on what this file could not
 * verify from Clerk's docs). Rather than fail every request for a shop whose
 * token doesn't happen to include it, an unknown email is stored as an
 * obviously-synthetic placeholder that a later request — once a real email
 * IS available — silently corrects via the ON CONFLICT below. Nothing reads
 * users.email today, so a placeholder is never user-visible in the meantime.
 *
 * @param {{userId: string, orgId: string|null, orgRole: 'admin'|'member'|null, email?: string}} auth
 */
export async function upsertMember(auth) {
  if (!auth?.orgId || !auth?.userId) return;

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    // Same function recordsStore.js's withTenant() uses to map a Clerk org id
    // to its tenant uuid, creating the tenant row on first sight. Reusing it
    // (rather than re-deriving the mapping here) means this file can never
    // disagree with recordsStore.js about which uuid a given org is.
    const { rows } = await client.query("SELECT resolve_tenant($1, $2) AS id", [
      auth.orgId,
      auth.orgId,
    ]);
    const tenantId = rows[0].id;

    // `true` = SET LOCAL: reverts at COMMIT, never outlives this transaction
    // or leaks into the next request on a warm connection — same reasoning as
    // recordsStore.js's withTenant().
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);

    const email = auth.email ?? `${auth.userId}@users.clerk.deepwell.invalid`;
    const role = toUsersRole(auth.orgRole);

    await client.query(
      `INSERT INTO users (tenant_id, clerk_user_id, email, role, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (tenant_id, clerk_user_id) DO UPDATE
         SET email = EXCLUDED.email,
             role  = EXCLUDED.role`,
      [tenantId, auth.userId, email, role]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
