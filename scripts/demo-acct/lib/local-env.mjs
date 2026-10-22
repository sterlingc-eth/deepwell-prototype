/**
 * Local, offline stand-in for staging used by the demo-account seeding proof and the QA run.
 *
 *   - a real Postgres (PGlite) with EVERY M3-config migration applied (including 73-demo-accounts.sql), the app's RLS role,
 *     and pg.Pool pointed at it (scripts/offline-exam.mjs harness);
 *   - object storage (R2) emulated in memory behind the app's own presigned URLs (globalThis.fetch is patched for the
 *     *.r2.cloudflarestorage.com host only);
 *   - a local HTTP server that routes /api/upload-url, /api/read-document, /api/v1/* and /api/account to the REAL handlers,
 *     so the real staff import tool (scripts/import/deepwell-import.mjs) can run against it as a child process, exactly as
 *     it would against staging;
 *   - the Anthropic client replaced: transcription requests (the vision reader for scans and photos) are answered by a
 *     LOCAL OCR STAND-IN (tesseract) because no model key exists in this sandbox; every other model call is BLOCKED and
 *     counted. Production uses Claude for both. Nothing here talks to a live service.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export async function bootLocal({ dataDir = null, ocr = true } = {}) {
  for (const k of ['STRIPE_SECRET_KEY', 'CLERK_SECRET_KEY', 'RESEND_API_KEY', 'ANTHROPIC_API_KEY', 'INNGEST_EVENT_KEY', 'INNGEST_SIGNING_KEY', 'VOYAGE_API_KEY']) delete process.env[k];
  Object.assign(process.env, {
    NEON_CONNECTION_STRING: 'postgres://harness:harness@localhost:5432/harness',
    R2_ACCOUNT_ID: 'acct123', R2_ACCESS_KEY_ID: 'AKIAFIXTURE', R2_SECRET_ACCESS_KEY: 'secretfixture', R2_BUCKET_NAME: 'fixture-bucket',
    CRON_SECRET: 'local-cron-secret-for-tests-only', DEEPWELL_TELEMETRY_OFF: '1', CLAUDE_API_KEY: 'sk-ant-local-disabled',
  });
  const off = await import(path.join(ROOT, 'scripts/offline-exam.mjs'));
  await off.installPgHarness();
  let lite;
  if (dataDir && fs.existsSync(dataDir)) {
    const { PGlite } = await import('@electric-sql/pglite');
    const contrib = {};
    for (const key of ['uuid_ossp', 'pgcrypto', 'pg_trgm', 'btree_gin']) contrib[key] = (await import(`@electric-sql/pglite/contrib/${key}`))[key];
    lite = new PGlite({ extensions: contrib, loadDataDir: new Blob([fs.readFileSync(dataDir)]) });
    await lite.waitReady;
  } else {
    lite = await off.createPGlite();
  }
  await off.setActiveDatabase(lite);

  // ---- object storage
  const store = new Map();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url?.url ?? url));
    if (!u.hostname.endsWith('.r2.cloudflarestorage.com')) return realFetch(url, init);
    const key = decodeURIComponent(u.pathname.replace(/^\/[^/]+\//, ''));
    const method = (init.method ?? 'GET').toUpperCase();
    if (method === 'PUT') { store.set(key, Buffer.from(await new Response(init.body).arrayBuffer())); return new Response(null, { status: 200 }); }
    if (method === 'DELETE') { store.delete(key); return new Response(null, { status: 204 }); }
    if (method === 'HEAD') return new Response(null, { status: store.has(key) ? 200 : 404, headers: { 'content-length': String(store.get(key)?.length ?? 0) } });
    const b = store.get(key);
    if (!b) return new Response('NoSuchKey', { status: 404 });
    return new Response(b, { status: 200, headers: { 'content-length': String(b.length) } });
  };

  // ---- model: OCR stand-in for transcription, everything else blocked + counted
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const proto = Object.getPrototypeOf(new Anthropic({ apiKey: 'x' }).messages);
  const model = { ocrCalls: 0, blocked: 0, mode: 'block', answerMock: null };
  proto.create = async function localModel(req) {
    const tool = req?.tools?.[0]?.name;
    if (tool === 'pages' && ocr) { model.ocrCalls++; return ocrStandIn(req); }
    if (model.mode === 'mock' && model.answerMock) return model.answerMock(req);
    model.blocked++;
    const err = new Error('local harness: model calls are disabled (no model key in this sandbox)');
    err.status = 400; err.isMock = true;
    throw err;
  };

  return { lite, off, store, model, realFetch };
}

/** Tesseract over each page of the image / image-only PDF the reader would have sent to the vision model. */
function ocrStandIn(req) {
  const content = req.messages?.[0]?.content ?? [];
  const src = content.find((c) => c.type === 'image' || c.type === 'document')?.source;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-'));
  const pages = [];
  try {
    const bytes = Buffer.from(src.data, 'base64');
    let images = [];
    if (src.media_type === 'application/pdf') {
      fs.writeFileSync(path.join(tmp, 'in.pdf'), bytes);
      execFileSync('pdftoppm', ['-r', '200', '-png', path.join(tmp, 'in.pdf'), path.join(tmp, 'p')]);
      images = fs.readdirSync(tmp).filter((f) => f.startsWith('p') && f.endsWith('.png')).sort().map((f) => path.join(tmp, f));
    } else {
      const ext = src.media_type.split('/')[1] ?? 'jpg';
      fs.writeFileSync(path.join(tmp, `in.${ext}`), bytes);
      images = [path.join(tmp, `in.${ext}`)];
    }
    images.forEach((img, i) => {
      let text = '';
      try { text = execFileSync('tesseract', [img, '-', '--psm', '4'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8'); } catch { text = ''; }
      pages.push({ page_no: i + 1, text: text.replace(/\n{3,}/g, '\n\n').trim(), confidence: 0.85 });
    });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  return { content: [{ type: 'tool_use', id: 'tu_ocr', name: 'pages', input: { pages } }], usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: 'tool_use' };
}

/** Vercel-style req/res around a real handler. */
export function makeReqRes({ method, url, headers, body }) {
  const u = new URL(url, 'http://local');
  const req = { method, url, headers: Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])), query: Object.fromEntries(u.searchParams), body };
  const res = {
    statusCode: 200, headers: {}, headersSent: false, body: undefined, ended: false,
    setHeader(k, v) { res.headers[String(k).toLowerCase()] = v; return res; },
    getHeader(k) { return res.headers[String(k).toLowerCase()]; },
    status(c) { res.statusCode = c; return res; },
    json(b) { res.body = b; res.headersSent = true; res.ended = true; return res; },
    send(b) { res.body = b; res.headersSent = true; res.ended = true; return res; },
    end(b) { if (b !== undefined) res.body = b; res.headersSent = true; res.ended = true; return res; },
    write() { return true; },
  };
  return { req, res };
}

/** Local HTTP server routing the app's API paths to the real handlers. */
export async function startApiServer() {
  const handlers = {
    '/api/upload-url': (await import(path.join(ROOT, 'api/upload-url.js'))).default,
    '/api/read-document': (await import(path.join(ROOT, 'api/read-document.js'))).default,
    '/api/document-status': (await import(path.join(ROOT, 'api/document-status.js'))).default,
    '/api/account': (await import(path.join(ROOT, 'api/account.js'))).default,
    '/api/v1': (await import(path.join(ROOT, 'api/v1.js'))).default,
  };
  let port = 0;
  const server = http.createServer(async (rq, rs) => {
    const chunks = [];
    for await (const c of rq) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const u = new URL(rq.url, 'http://local');
    if (u.pathname.startsWith('/__r2/')) { // presigned PUT rewritten to us: forward into the in-memory store via the patched fetch
      const target = `https://acct123.r2.cloudflarestorage.com/${u.pathname.slice('/__r2/'.length)}${u.search}`;
      const r = await globalThis.fetch(target, { method: rq.method, body: raw });
      rs.writeHead(r.status); rs.end(); return;
    }
    let p = u.pathname;
    let url = rq.url;
    const v1 = /^\/api\/v1\/([\w-]+)$/.exec(p);
    if (v1) { p = '/api/v1'; url = `/api/v1?resource=${v1[1]}`; }
    const h = handlers[p];
    if (!h) { rs.writeHead(404, { 'content-type': 'application/json' }); rs.end('{"error":"not found"}'); return; }
    let body;
    try { body = raw.length ? JSON.parse(raw.toString('utf8')) : undefined; } catch { body = undefined; }
    const { req, res } = makeReqRes({ method: rq.method, url, headers: rq.headers, body });
    try { await h(req, res); } catch (e) { res.statusCode = 500; res.body = { error: String(e?.message ?? e) }; }
    for (let i = 0; i < 400 && !res.ended; i++) await new Promise((r) => setTimeout(r, 25));
    let out = res.body;
    const rewrite = (x) => (typeof x === 'string' ? x.replace(/^https:\/\/acct123\.r2\.cloudflarestorage\.com\//, `http://127.0.0.1:${port}/__r2/`) : x);
    if (out && typeof out === 'object') {
      if (out.uploadUrl) out = { ...out, uploadUrl: rewrite(out.uploadUrl) };
      if (Array.isArray(out.results)) out = { ...out, results: out.results.map((r) => (r?.uploadUrl ? { ...r, uploadUrl: rewrite(r.uploadUrl) } : r)) };
    }
    const hdrs = { 'content-type': 'application/json' };
    for (const [k, v] of Object.entries(res.headers)) if (k === 'retry-after') hdrs[k] = v;
    rs.writeHead(res.statusCode, hdrs);
    rs.end(typeof out === 'string' ? out : JSON.stringify(out ?? null));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  return { server, port, close: () => new Promise((r) => server.close(r)) };
}

/** Insert an import key for a tenant (what Sterling does in the app's API access screen). Returns the raw key. */
export async function createImportKey(lite, tenantId, scopes = ['ingest', 'read']) {
  const raw = 'dw_' + 'live_' + crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await lite.query(`INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash, scopes, created_by) VALUES ($1, 'demo import key (local)', $2, $3, $4, 'local-harness')`,
    [tenantId, raw.slice(8, 16), hash, scopes]);
  return raw;
}

export const WAVE1 = [
  { slug: 'realestate', label: 'Real Estate' },
  { slug: 'propmgmt', label: 'Property Management' },
  { slug: 'hvac', label: 'HVAC' },
  { slug: 'plumbing', label: 'Plumbing' },
  { slug: 'electrical', label: 'Electrical' },
  { slug: 'contractors', label: 'General Contractors' },
];
export const localOrgId = (slug) => `org_demolocal${slug}`;

export const LOCAL_DEMO_USER = 'user_localdemologin1';
export const D1_ORG_PLACEHOLDERS = { REAL_ESTATE: 'realestate', PROPERTY_MANAGEMENT: 'propmgmt', HVAC: 'hvac', PLUMBING: 'plumbing', ELECTRICAL: 'electrical', GENERAL_CONTRACTORS: 'contractors' };

/** What the app does when the demo login opens each organization once (runbook B5): creates the company row and records the demo login as admin. */
export async function openDemoOrgs(lite, { slugs = Object.values(D1_ORG_PLACEHOLDERS), user = LOCAL_DEMO_USER } = {}) {
  await lite.exec('RESET ROLE');
  for (const slug of slugs) {
    const org = localOrgId(slug);
    const { rows: [{ id }] } = await lite.query('SELECT resolve_tenant($1, $1) AS id', [org]);
    await lite.query("INSERT INTO users (tenant_id, clerk_user_id, email, role) VALUES ($1, $2, 'demo@deepwelltechnology.com', 'admin') ON CONFLICT (tenant_id, clerk_user_id) DO NOTHING", [id, user]);
  }
}

/** D1 text with the six placeholder org ids and the demo login's user id replaced by local ones. */
export function d1Sql({ user = LOCAL_DEMO_USER } = {}) {
  let sql = fs.readFileSync(path.join(ROOT, 'M3-config/demo/D1-setup-demo-companies.sql'), 'utf8');
  for (const [k, slug] of Object.entries(D1_ORG_PLACEHOLDERS)) sql = sql.replace(`org_PASTE_${k}_ORG_ID`, localOrgId(slug));
  return sql.replace('user_PASTE_DEMO_LOGIN_USER_ID', user);
}

/** Run D1 as the migration owner, like the Neon SQL editor, after the demo login has opened the six organizations (runbook B5). */
export async function runD1(lite) {
  await openDemoOrgs(lite);
  await lite.exec('RESET ROLE');
  return lite.exec(d1Sql());
}
