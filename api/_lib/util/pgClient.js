/**
 * pg client helpers shared by every "check out one connection, run a
 * transaction" helper (withTenant in recordsStore/reviewStore/opsStore/
 * search/store, notifications, outreach, document-delete, members).
 *
 * WHY serializeClient: a pg Client runs ONE query at a time. Code such as
 * `await Promise.all([db.query(a), db.query(b)])` on the same checked-out
 * client is legal today only because node-postgres silently queues the second
 * query behind the first, and it prints "Calling client.query() when the client
 * is already executing a query is deprecated and will be removed in pg@9.0"
 * (43x in the production logs). Two real risks follow:
 *   1. pg@9 removes the implicit queue: the same code would then throw/misbehave.
 *   2. Inside a transaction, if query A fails the transaction is aborted and
 *      B (already queued) fails with a misleading "current transaction is
 *      aborted" (25P02); with Promise.allSettled callers (insights detectors)
 *      one failing detector poisons the rest and hides the root cause.
 * serializeClient makes the queue explicit: each query starts only after the
 * previous one has settled, so call sites keep their shape, results are
 * identical, and pg never sees an overlapping call. Parallel readers gain
 * nothing on a single connection anyway (the server runs them one by one).
 */

const SERIAL = Symbol.for('deepwell.serialClient');

/**
 * Patch (once) a pg client so overlapping .query() calls run strictly one at a
 * time, in call order. Safe to call on a pooled client every checkout: the
 * marker keeps it from double-wrapping. Callback-style and Submittable calls
 * pass straight through (nothing in this codebase uses them).
 * @template T
 * @param {T} client
 * @returns {T}
 */
export function serializeClient(client) {
  if (!client || typeof client.query !== 'function' || client[SERIAL]) return client;
  const rawQuery = client.query.bind(client);
  let tail = Promise.resolve();
  client.query = (...args) => {
    const last = args[args.length - 1];
    if (typeof last === 'function' || (args[0] && typeof args[0].submit === 'function')) return rawQuery(...args);
    const run = () => rawQuery(...args);
    const result = tail.then(run, run);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  client[SERIAL] = true;
  return client;
}

/**
 * Guard for `set_config('app.tenant_id', $1, true)`: a null/empty id would set
 * the GUC to '' and every RLS policy's `::uuid` cast would then fail with
 * `invalid input syntax for type uuid: ""`. Fail loudly and early instead.
 */
export function assertTenantUuid(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    const err = new Error('Tenant could not be resolved');
    err.status = 401;
    err.code = 'NO_TENANT';
    throw err;
  }
  return id;
}

/** True for a usable identifier string (non-empty after trim). */
export function isNonBlankId(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * SSL config for pg.Pool without changing security and without the
 * "SECURITY WARNING: SSL modes 'prefer', 'require', and 'verify-ca' are treated
 * as aliases for 'verify-full'" line (508x in the production logs).
 *
 * pg-connection-string already treats sslmode=prefer|require|verify-ca as
 * verify-full (certificate chain AND hostname verified) and prints that warning
 * on every parse. We make the identical semantics explicit: drop just that one
 * query parameter from the string handed to pg and pass
 * `ssl: { rejectUnauthorized: true }` (Node verifies chain + hostname by
 * default; the host comes from the connection string). Every other part of the
 * string is passed through byte-for-byte. Anything else (no sslmode, disable,
 * no-verify, verify-full, uselibpqcompat=true, a fragment) is left untouched so
 * behavior there cannot change. The connection string is never logged.
 * @param {string} connectionString
 * @returns {{connectionString: string, ssl?: {rejectUnauthorized: true}}}
 */
export function explicitPgSsl(connectionString) {
  const cs = String(connectionString ?? '');
  const q = cs.indexOf('?');
  if (q < 0 || cs.includes('#') || /[?&]uselibpqcompat=true(&|$)/i.test(cs)) return { connectionString: cs };
  const base = cs.slice(0, q);
  const parts = cs.slice(q + 1).split('&');
  const mode = parts.map((p) => /^sslmode=(.*)$/i.exec(p)?.[1]).find((v) => v !== undefined);
  if (mode === undefined || !/^(prefer|require|verify-ca)$/i.test(mode)) return { connectionString: cs };
  const rest = parts.filter((p) => !/^sslmode=/i.test(p));
  return {
    connectionString: rest.length ? `${base}?${rest.join('&')}` : base,
    ssl: { rejectUnauthorized: true },
  };
}
