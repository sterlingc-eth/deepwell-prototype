// Shared setup for the routes-* scripts (area `routes`): boots the harness, learns company B's identifiers through the raw
// connection, and provides leak / mutation detectors. Offline only.
import { boot, recorder } from './lib/harness.mjs';

export async function setup(area) {
  for (const b of ['READ', 'WRITE', 'INGEST', 'ASK', 'BILLING']) { process.env[`RATE_LIMIT_${b}_PER_MINUTE`] = '1000000'; process.env[`RATE_LIMIT_${b}_PER_DAY`] = '1000000'; }
  const H = await boot();
  const R = recorder(area);
  const q = async (s, p = []) => (await H.lite.query(s, p)).rows;
  const uA = H.tenantUuid.A, uB = H.tenantUuid.B;
  const B = { tenant: uB, org: H.orgB };
  B.docs = (await q('select id::text id, storage_key, sha256_hash, original_filename from documents where tenant_id=$1 order by id', [uB]));
  B.docIds = B.docs.map((d) => d.id);
  B.customers = await q("select id::text id, customer_number, data from entities where tenant_id=$1 and entity_type='customer' order by id", [uB]);
  B.equipment = await q("select id::text id, data, customer_id::text customer_id from entities where tenant_id=$1 and entity_type='equipment' order by id", [uB]);
  B.entityIds = [...B.customers, ...B.equipment].map((e) => e.id);
  B.serials = B.equipment.map((e) => e.data?.serial_number).filter(Boolean);
  B.extractions = await q('select id::text id, document_id::text document_id from extractions where tenant_id=$1 order by id limit 50', [uB]);
  B.allIds = new Set([...B.docIds, ...B.entityIds, ...B.extractions.map((x) => x.id), uB]);
  const tenantTables = (await q("select table_name from information_schema.columns where table_schema='public' and column_name='tenant_id' order by 1")).map((r) => r.table_name);
  const A = { tenant: uA, org: H.orgA };
  A.docs = await q('select id::text id from documents where tenant_id=$1 order by id limit 40', [uA]);
  A.customers = await q("select id::text id, customer_number from entities where tenant_id=$1 and entity_type='customer' order by id limit 40", [uA]);
  A.equipment = await q("select id::text id, data from entities where tenant_id=$1 and entity_type='equipment' order by id limit 40", [uA]);

  // Strings that exist only in B's fixture (see harness buildB): never legitimate in anything A may see.
  const markerRes = [/Zed Zimmer/i, /Beta Cooling/i, /BINV-/, /556-77/, /@beta\.example/i, /org_sec_B/, new RegExp(uB, 'i'), ...B.serials.slice(0, 400).map((s) => new RegExp(`(?<![A-Za-z0-9])${s.replace(/[^A-Za-z0-9]/g, '\\$&')}(?![A-Za-z0-9])`))];
  const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const hashes = new Set(B.docs.slice(1).map((d) => d.sha256_hash).filter(Boolean)); // doc 0's hash is planted on purpose by some tests (same-bytes upload in A)
  const keys = new Set(B.docs.map((d) => d.storage_key).filter(Boolean));

  /** Returns a list of leak reasons found in a call result. `supplied` = B ids the caller put in the request (echo is not a leak by itself). */
  function leaks(res, supplied = []) {
    const out = [];
    let text = res?.text ?? '';
    for (const s of supplied) text = text.split(s).join('<echo>');
    for (const re of markerRes) if (re.test(text)) { out.push(`marker ${re}`); break; }
    for (const m of new Set(text.match(uuidRe) ?? [])) if (B.allIds.has(m.toLowerCase())) out.push(`B id ${m}`);
    for (const h of hashes) if (text.includes(h)) { out.push('B sha256'); break; }
    for (const k of keys) if (text.includes(k)) { out.push('B storage key'); break; }
    // a full object whose id is a supplied B id = the record itself came back
    const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') { if (supplied.includes(v.id) && Object.keys(v).length >= 3) out.push(`record ${v.id} returned`); Object.values(v).forEach(walk); } };
    try { walk(res.body); } catch { /* ignore */ }
    return out;
  }

  // Whole-of-B state fingerprint (every tenant_id table + the tenant row) used to prove nothing of B changed.
  const fpSql = tenantTables.map((t) => `select '${t}' t, count(*)::int n, coalesce(md5(string_agg(x::text,'|' order by x::text)),'') h from ${t} x where tenant_id=$1`).join(' union all ')
    + " union all select 'tenants', count(*)::int, coalesce(md5(string_agg(x::text,'|' order by x::text)),'') from tenants x where id=$1";
  const fingerprint = async (u = uB) => { const o = {}; for (const r of await q(fpSql, [u])) o[r.t] = `${r.n}:${r.h}`; return o; };
  const BOOKKEEPING = new Set(['rate_limit_windows', 'usage_counters', 'users']); // written by sign-in / metering of any caller, not record data
const diffFp = (a, b, { bookkeeping = false } = {}) => Object.keys(b).filter((k) => a[k] !== b[k] && (bookkeeping || !BOOKKEEPING.has(k)));

  // Rows of tenant A that reference a B id (a cross-tenant link planted by a request).
  const ids = [...B.allIds].filter((x) => x !== uB);
  await q('create temp table if not exists bids(id text primary key)');
  await q('delete from bids'); for (let i = 0; i < ids.length; i += 500) await q(`insert into bids values ${ids.slice(i, i + 500).map((_, j) => `($${j + 1})`).join(',')} on conflict do nothing`, ids.slice(i, i + 500));
  const skipForeign = new Set(['audit_log', 'entity_merge_suggestions']); // reject stores caller-typed uuids in the caller's own row only (noted in the report)
  const foreignRefs = async () => {
    const out = [];
    for (const t of tenantTables) {
      if (skipForeign.has(t)) continue;
      const n = (await q(`select count(*)::int n from ${t} x where tenant_id=$1 and exists (select 1 from regexp_matches(x::text,'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}','g') m where m[1] in (select id from bids))`, [uA]))[0].n;
      if (n) { const sm = (await q(`select x::text s from ${t} x where tenant_id=$1 and exists (select 1 from regexp_matches(x::text,'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}','g') m where m[1] in (select id from bids)) limit 1`, [uA]))[0]?.s ?? ''; out.push(`${t}:${n} e.g. ${sm.slice(0, 260)}`); }
    }
    return out;
  };
  const apis = {};
  const api = async (name, path) => (apis[name] ??= (await H.importApi(path)).default);
  return { H, R, q, A, B, leaks, fingerprint, diffFp, foreignRefs, tenantTables, api };
}
