// Shared harness for the limit tests: PGlite (all M3 migrations, RLS role deepwell_rls) + locally-signed Clerk JWTs (JWKS served from an in-process fetch mock) + mock R2.
// No network: globalThis.fetch is replaced; any URL that is not Clerk JWKS or the mock R2 bucket THROWS (and is recorded).
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { bootHarness } from '../lib/r35Harness.mjs';

export const stats = { pass: 0, fail: 0 };
export const check = (name, ok, detail = '') => { if (ok) stats.pass++; else stats.fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`); };
export const finish = () => { console.log(`\n${stats.pass} passed, ${stats.fail} failed`); process.exit(stats.fail ? 1 : 0); };

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'ins_test', alg: 'RS256', use: 'sig' };
const b64u = (b) => Buffer.from(b).toString('base64url');
export function signToken(claims) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: 'ins_test' };
  const payload = { iss: 'https://clerk.test', azp: 'https://deepwelltechnology.com', iat: now - 5, nbf: now - 5, exp: now + 600, ...claims };
  const data = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(data), privateKey);
  return `${data}.${b64u(sig)}`;
}
/** Bearer token for a shop (org) member or, with no org, a solo user. */
export const orgToken = (orgId, userId, role = 'admin') => signToken({ sub: userId, org_id: orgId, org_role: `org:${role}` });
export const soloToken = (userId) => signToken({ sub: userId });

export const r2 = { objects: new Map(), requested: [], blocked: [] };
export function installFetchMock() {
  process.env.CLERK_SECRET_KEY = 'sk_test_limit_fixture';
  globalThis.fetch = async (url, init) => {
    const u = String(url?.url ?? url);
    if (/clerk\.com\/v1\/jwks/.test(u)) return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (/\.r2\.cloudflarestorage\.com/.test(u)) {
      const key = decodeURIComponent(new URL(u).pathname.replace(/^\/[^/]+\//, ''));
      r2.requested.push({ method: init?.method ?? 'GET', key });
      const obj = r2.objects.get(key);
      if ((init?.method ?? 'GET') === 'GET' && obj) return new Response(obj.bytes, { status: 200, headers: { 'content-type': obj.type ?? 'text/plain', 'content-length': String(obj.bytes.length) } });
      if (init?.method === 'DELETE') { r2.objects.delete(key); return new Response(null, { status: 204 }); }
      return new Response('NoSuchKey', { status: 404 });
    }
    r2.blocked.push(u);
    throw new Error(`limit-test: outbound fetch blocked: ${u}`);
  };
}

export function mkRes() {
  const r = { statusCode: 200, body: null, headers: {}, headersSent: false, status(c) { r.statusCode = c; return r; }, json(b) { r.body = b; r.headersSent = true; return r; }, send(b) { r.body = b; r.headersSent = true; return r; }, setHeader(k, v) { r.headers[k.toLowerCase()] = v; return r; }, getHeader(k) { return r.headers[k.toLowerCase()]; }, end(b) { if (b !== undefined && b !== null) r.body = b; r.headersSent = true; return r; }, write(c) { r._w = (r._w ?? '') + (typeof c === 'string' ? c : Buffer.from(c).toString()); r.body = r._w; return true; }, on() { return r; }, once() { return r; }, flushHeaders() {}, writeHead(c) { r.statusCode = c; return r; } };
  return r;
}
export const mkReq = ({ method = 'POST', token = null, body = {}, query = {}, headers = {} } = {}) => Object.assign(Readable.from([Buffer.from(JSON.stringify(body ?? {}))]), { method, body, query, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), origin: 'https://deepwelltechnology.com', ...headers }, url: '/', socket: { remoteAddress: '127.0.0.1' } });
export async function call(handler, reqOpts) { const res = mkRes(); const req = mkReq(reqOpts); await handler(req, res); return res; }
export const quiet = async (fn) => { const e = console.error, l = console.log, w = console.warn; console.error = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.error = e; console.warn = w; void l; } };

/** Production runs EVERY pool statement as the non-owner role deepwell_rls. The shared harness only did SET ROLE for pool.connect(); pool.query() ran as the PGlite superuser (bypassing RLS). Fixed here so a bare pool.query is RLS-enforced like production. */
async function patchPoolQueryRole(h) {
  const pgMod = (await import('pg')).default;
  let tail = Promise.resolve();
  const lock = () => { let rel; const p = new Promise((r) => { rel = r; }); const prev = tail; tail = tail.then(() => p); return prev.then(() => rel); };
  void lock;
  const orig = pgMod.Pool.prototype.connect;
  pgMod.Pool.prototype.query = async function query(sql, params) {
    const c = await orig.call(this);
    try { h.stats.queries++; return await c.query(sql, params); } finally { c.release(); }
  };
}
export async function boot() { const h = await bootHarness(); await patchPoolQueryRole(h); installFetchMock(); return h; }
export { bootHarness };
