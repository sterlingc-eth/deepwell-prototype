/**
 * Shared offline harness for scripts/sec/*: two fake companies (A = golden export, B = a renamed subset), real API
 * handlers on in-memory Postgres (PGlite + RLS role), a stub for the sign-in vendor, the model blocked, R2 patched out.
 * No network. Import FIRST in every sec script:   const H = await boot();
 */
import { register } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
register('./clerk-hooks.mjs', import.meta.url);

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const rel = (p) => path.join(ROOT, p);
export const TODAY = '2026-09-25';

export function buildB(exportData) {
  const d = JSON.parse(JSON.stringify(exportData));
  const custs = d.entities.filter((e) => e.entity_type === 'customer').slice(0, 60);
  const cIds = new Set(custs.map((c) => c.id));
  const eqs = d.entities.filter((e) => e.entity_type === 'equipment' && cIds.has(e.customer_id));
  const eIds = new Set(eqs.map((e) => e.id));
  d.entities = [...custs, ...eqs];
  const linked = new Set(d.document_entity_links.filter((l) => cIds.has(l.entity_id) || eIds.has(l.entity_id)).map((l) => l.document_id));
  d.documents = d.documents.filter((x) => linked.has(x.id));
  const dIds = new Set(d.documents.map((x) => x.id));
  d.document_entity_links = d.document_entity_links.filter((l) => dIds.has(l.document_id) && (cIds.has(l.entity_id) || eIds.has(l.entity_id)));
  d.pages = d.pages.filter((x) => dIds.has(x.document_id));
  d.extractions = d.extractions.filter((x) => dIds.has(x.document_id));
  d.financials = d.financials.filter((x) => dIds.has(x.document_id));
  const fIds = new Set(d.financials.map((x) => x.id));
  d.financial_lines = d.financial_lines.filter((x) => fIds.has(x.financial_id));
  const serials = new Set(eqs.map((e) => e.data.serial_number).filter(Boolean));
  let str = JSON.stringify(d);
  const map = new Map();
  str = str.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (m) => { if (!map.has(m)) map.set(m, crypto.randomUUID()); return map.get(m); });
  for (const sn of serials) str = str.split(sn).join('Z' + sn);
  str = str.replace(/555-01/g, '556-77').replace(/@gmail\.com/g, '@beta.example').replace(/Danny Ochoa/g, 'Zed Zimmer').replace(/Sonoran Comfort Air/g, 'Beta Cooling').replace(/INV-/g, 'BINV-');
  str = str.replace(/"sha256_hash":"[0-9a-f]{64}"/g, () => `"sha256_hash":"${crypto.randomBytes(32).toString('hex')}"`);
  return JSON.parse(str);
}

export function mkRes() {
  const res = {
    statusCode: 200, headers: {}, headersSent: false, body: undefined, chunks: [],
    setHeader(k, v) { res.headers[String(k).toLowerCase()] = v; return res; },
    getHeader(k) { return res.headers[String(k).toLowerCase()]; },
    status(c) { res.statusCode = c; return res; },
    json(b) { res.body = b; res.headersSent = true; return res; },
    send(b) { res.body = b; res.headersSent = true; return res; },
    write(c) { res.chunks.push(String(c)); return true; },
    end(c) { if (c != null) res.chunks.push(String(c)); res.headersSent = true; return res; },
    redirect(code, url) { res.statusCode = typeof code === 'number' ? code : 302; res.headers.location = url ?? code; res.headersSent = true; return res; },
    on() { return res; }, once() { return res; }, emit() { return false; },
  };
  return res;
}

/** @param {{tenant?: string}} o */
export async function boot() {
  process.env.CLERK_SECRET_KEY = 'sk_test_offline_stub_not_a_real_key';
  process.env.CLAUDE_API_KEY ||= 'sk-ant-offline-disabled';
  const OE = await import(rel('scripts/offline-exam.mjs'));
  await OE.installPgHarness();
  const modelCalls = await OE.installModelBlock();
  const lite = await OE.createPGlite();
  await OE.setActiveDatabase(lite);
  for (const k of ['STRIPE_SECRET_KEY', 'RESEND_API_KEY', 'ANTHROPIC_API_KEY', 'INNGEST_EVENT_KEY', 'INNGEST_SIGNING_KEY', 'STRIPE_WEBHOOK_SECRET', 'CRON_SECRET']) delete process.env[k];
  Object.assign(process.env, { R2_ACCOUNT_ID: 'acct123', R2_ACCESS_KEY_ID: 'AKIAFIXTURE', R2_SECRET_ACCESS_KEY: 'secretfixture', R2_BUCKET_NAME: 'fixture-bucket' });
  const exportA = JSON.parse(fs.readFileSync(rel('scripts/golden/golden-export.json'), 'utf8'));
  const exportB = buildB(exportA);
  const orgA = 'org_sec_A', orgB = 'org_sec_B';
  await OE.loadExportIntoNewTenant(lite, exportA, { tenantKey: orgA, tenantName: 'Company A' });
  await OE.loadExportIntoNewTenant(lite, exportB, { tenantKey: orgB, tenantName: 'Company B' });
  const RS = await import(rel('api/_lib/recordsStore.js'));
  const PLAN = await import(rel('api/_lib/plan.js'));
  const reset = () => { RS._resetTenantContextCache?.(); PLAN._resetBillingRowCache?.(); };
  const tenantUuid = {};
  for (const [k, org] of [['A', orgA], ['B', orgB]]) {
    const { rows } = await lite.query('SELECT id FROM tenants WHERE clerk_org_id=$1', [org]);
    tenantUuid[k] = rows[0].id;
    await lite.query("UPDATE tenants SET plan='fleet', billing_status='active' WHERE id=$1", [rows[0].id]);
  }
  reset();
  const setTenant = async (k, sets, params = []) => { await lite.query(`UPDATE tenants SET ${sets} WHERE id=$1`, [tenantUuid[k], ...params]); reset(); };
  /** Session token the stub verifier accepts. role: 'admin'|'member'|null (null with org=null => solo user). */
  const mintToken = ({ userId, org = null, role = 'member', exp, azp, extra = {} }) => {
    const claims = { sub: userId, ...(org ? { o: { id: org, rol: role } } : {}), ...(exp !== undefined ? { exp } : {}), ...(azp ? { azp } : {}), ...extra };
    return `stub.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.ok`;
  };
  const tok = {
    adminA: mintToken({ userId: 'user_adminA', org: orgA, role: 'admin' }), memberA: mintToken({ userId: 'user_memberA', org: orgA, role: 'member' }),
    adminB: mintToken({ userId: 'user_adminB', org: orgB, role: 'admin' }), memberB: mintToken({ userId: 'user_memberB', org: orgB, role: 'member' }),
    soloC: mintToken({ userId: 'user_soloC' }),
    expired: mintToken({ userId: 'user_adminA', org: orgA, role: 'admin', exp: Math.floor(Date.now() / 1000) - 60 }),
    garbage: 'not.a.token',
  };
  const { generateKey } = await import(rel('api/_lib/apiKeyAuth.js'));
  const mintKey = async (k, scopes = ['read', 'ingest', 'ask'], { revoked = false } = {}) => {
    const g = generateKey();
    await lite.query("INSERT INTO api_keys (tenant_id,name,key_prefix,key_hash,scopes,revoked_at) VALUES ($1,'sec',$2,$3,$4,$5)", [tenantUuid[k], g.keyPrefix, g.keyHash, scopes, revoked ? new Date() : null]);
    return g.rawKey;
  };
  /** Call a real handler. opts: {token, method, query, body, headers}. Returns {status, body, headers, text, thrown}. */
  const call = async (handler, { token, method = 'POST', query = {}, body = {}, headers = {} } = {}) => {
    const req = { method, query, body, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, url: '/', socket: { remoteAddress: '203.0.113.9' } };
    const res = mkRes();
    let thrown = null; const logs = [];
    const origE = console.error, origL = console.log, origW = console.warn;
    const cap = (...a) => logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    console.error = cap; console.log = cap; console.warn = cap;
    try { await handler(req, res); } catch (e) { thrown = e; } finally { console.error = origE; console.log = origL; console.warn = origW; }
    return { status: res.statusCode, body: res.body, headers: res.headers, text: res.chunks.join('') || (typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? null)), thrown, logs };
  };
  const importApi = (p) => import(rel(p));
  return { lite, OE, RS, PLAN, reset, setTenant, tenantUuid, orgA, orgB, exportA, exportB, mintToken, tok, mintKey, call, importApi, modelCalls, root: ROOT, rel };
}

/** Findings recorder. Each script ends with finish(); a CONFIRMED finding's script FAILS (exit 1) until fixed. */
export function recorder(area) {
  const results = [];
  const rec = {
    results,
    /** ok=true means the defence held. */
    check(id, title, ok, { severity = 'Medium', route = '', detail = '', status = 'CONFIRMED' } = {}) {
      results.push({ id, title, ok, severity, route, detail: String(detail).slice(0, 400), status });
      console.log(`${ok ? 'PASS' : 'FAIL'}  [${area}] ${id} ${title}${ok ? '' : `  -> ${severity} ${route} ${String(detail).slice(0, 200)}`}`);
    },
    finish() {
      const fails = results.filter((r) => !r.ok);
      const dir = path.join(process.env.TMPDIR || process.env.TEMP || '/tmp', 'deepwell-sec-out'); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${area}.json`), JSON.stringify(results, null, 1));
      console.log(`\n[${area}] ${results.length - fails.length}/${results.length} defences held; ${fails.length} finding(s) open`);
      process.exit(fails.length ? 1 : 0);
    },
  };
  return rec;
}
