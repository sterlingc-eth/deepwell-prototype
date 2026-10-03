// Shared helpers for scripts/limit-test-b/limits-*.mjs (TESTER B). Run any script as:
//   flock /home/claude/work/cpu.lock npx tsx --import ./scripts/limit-test-b/register.mjs scripts/limit-test-b/<script>.mjs
import { bootHarness } from '../lib/r35Harness.mjs';

export async function boot() {
  const h = await bootHarness();
  process.env.CLERK_SECRET_KEY = 'sk_test_fixture_not_real';
  // The shared harness serialises every pool use behind one lock, so a pool.query() made while a connection is held
  // (billing status -> getUsage) would deadlock. With h.nested=true such a call runs on the held session instead.
  const pgMod = (await import('pg')).default;
  const origQuery = pgMod.Pool.prototype.query;
  h.nested = true;
  pgMod.Pool.prototype.query = function (sql, params) { return h.nested && h.stats.out > 0 ? h.lite.query(sql, params) : origQuery.call(this, sql, params); };
  const results = [];
  let family = 'misc';
  const setFamily = (f) => { family = f; };
  const check = (id, name, ok, detail = '') => {
    results.push({ id, family, name, ok: !!ok, detail: ok ? '' : String(detail).slice(0, 300) });
    console.log(`${ok ? 'PASS' : 'FAIL'}  [${family}] ${id} ${name}${ok || !detail ? '' : `\n        -> ${String(detail).slice(0, 300)}`}`);
  };
  const finish = () => {
    const f = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - f} PASS, ${f} FAIL`);
    process.exitCode = f ? 1 : 0;
  };
  return { h, check, setFamily, finish, results };
}

export const tok = (claims) => Buffer.from(JSON.stringify(claims)).toString('base64url');
export const memberTok = (org, user = 'user_member', extra = {}) => tok({ sub: user, o: { id: org, rol: 'member' }, ...extra });
export const adminTok = (org, user = 'user_admin', extra = {}) => tok({ sub: user, o: { id: org, rol: 'admin' }, ...extra });
export const legacyTok = (org, role, user) => tok({ sub: user, org_id: org, org_role: role });
export const soloTok = (user = 'user_solo') => tok({ sub: user });

export const mkReq = ({ method = 'POST', token, query = {}, body, headers = {}, rawBody = body } = {}) => ({
  method, query, body, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-forwarded-for': '203.0.113.7', ...headers },
  // raw-stream body for handlers with bodyParser off (billing.js): emits the JSON body then 'end'
  on(ev, cb) { if (ev === 'data' && rawBody !== undefined) setImmediate(() => cb(Buffer.from(typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody)))); if (ev === 'end') setImmediate(() => setImmediate(() => cb())); return this; },
  socket: { remoteAddress: '203.0.113.7' },
});
export const mkRes = () => {
  const r = { statusCode: 200, body: null, headers: {}, ended: false,
    status(c) { r.statusCode = c; return r; }, json(b) { r.body = b; r.ended = true; return r; },
    send(b) { try { r.body = typeof b === 'string' ? JSON.parse(b) : b; } catch { r.body = b; } r.ended = true; return r; }, setHeader(k, v) { r.headers[k] = v; return r; },
    getHeader(k) { return r.headers[k]; }, end() { r.ended = true; return r; }, write() { return true; }, once() {}, on() {} };
  return r;
};
export const quiet = async (fn) => { const e = console.error, w = console.warn; console.error = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.error = e; console.warn = w; } };

/** Deterministic per-table fingerprint of every public table (count + md5 of all rows) except noise tables. */
export async function snapshot(lite, skip = ['rate_limit_windows', 'usage_counters']) {
  const { rows: tabs } = await lite.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1`);
  const out = {};
  for (const { table_name: t } of tabs) {
    if (skip.includes(t)) continue;
    try {
      const { rows } = await lite.query(`SELECT count(*)::int AS n, COALESCE(md5(string_agg(x::text, '|' ORDER BY x::text)), '') AS h FROM "${t}" x`);
      out[t] = `${rows[0].n}:${rows[0].h}`;
    } catch { /* unreadable table: ignore */ }
  }
  return out;
}
export const diffSnap = (a, b) => Object.keys(b).filter((k) => a[k] !== b[k]);
