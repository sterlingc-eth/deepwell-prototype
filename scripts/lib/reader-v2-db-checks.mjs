/** DB-backed checks for verify:reader-v2: a real Postgres (PGlite) loaded from M3-config, queried as the app's non-superuser role. */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export async function run({ ROOT, FX, PGlite, contrib, check, eq, R, expected, keys }) {
  process.env.NEON_CONNECTION_STRING = 'postgres://harness:harness@localhost:5432/harness';
  const realLog = console.log;
  const cfgDir = path.join(ROOT, 'M3-config');
  const migrations = fs.readdirSync(cfgDir).filter((x) => /^\d\d.*\.sql$/.test(x) && !x.startsWith('99')).sort();
  const lite = new PGlite({ extensions: contrib });
  for (const f of migrations) { try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch { /* same quirks as the other database harnesses */ } }
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* pre-existing harness quirk */ }
  const pg = (await import('pg')).default;
  let tail = Promise.resolve();
  const lock = () => { let release; const p = new Promise((r) => { release = r; }); const prev = tail; tail = tail.then(() => p); return prev.then(() => release); };
  pg.Pool.prototype.connect = async function connect() { const release = await lock(); await lite.exec('SET ROLE deepwell_rls'); return { query: (sql, params) => lite.query(sql, params), release: () => { lite.exec('RESET ROLE').finally(release); } }; };
  pg.Pool.prototype.query = async function query(sql, params) { const release = await lock(); try { return await lite.query(sql, params); } finally { release(); } };
  const RS = await import('../../api/_lib/recordsStore.js');
  const A = await import('../../api/_lib/dql/reader-v2/app.js');
  A._assumeParity(true);
  const ctxA = { tenantKey: 'org_readerv2_a', tenantName: 'Reader A' }; const ctxB = { tenantKey: 'org_readerv2_b', tenantName: 'Reader B' };
  const tenA = (await RS.getTenantContext(ctxA.tenantKey, ctxA.tenantName)).id; const tenB = (await RS.getTenantContext(ctxB.tenantKey, ctxB.tenantName)).id;
  const load = (key) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(FX, 'companies', `${key}.json.gz`))).toString('utf8'));
  const KA = 'pg_re0_title', KB = 'pg_ot0_horseboarding';
  async function seed(tenant, d) {
    const many = async (table, cols, rows, cast = {}) => {
      for (let i = 0; i < rows.length; i += 200) {
        const part = rows.slice(i, i + 200); const params = []; const vals = part.map((r) => `(${cols.map((c) => { params.push(r[c]); return `$${params.length}${cast[c] || ''}`; }).join(',')})`);
        await lite.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${vals.join(',')} ON CONFLICT DO NOTHING`, params);
      }
    };
    await many('documents', ['id', 'tenant_id', 'original_filename', 'document_type', 'sha256_hash', 'stage', 'created_at'], d.documents.map((x) => ({ ...x, tenant_id: tenant, stage: 'linked' })));
    await many('document_pages', ['id', 'tenant_id', 'document_id', 'page_no', 'text'], d.pages.map((x) => ({ ...x, tenant_id: tenant })));
    await many('entities', ['id', 'tenant_id', 'entity_type', 'customer_number', 'data'], d.entities.map((x) => ({ ...x, tenant_id: tenant, data: JSON.stringify(x.data) })), { data: '::jsonb' });
    await many('document_entity_links', ['id', 'tenant_id', 'document_id', 'entity_id', 'confidence', 'linked_by'], d.document_entity_links.map((x) => ({ ...x, tenant_id: tenant })));
    await many('extractions', ['id', 'tenant_id', 'document_id', 'entity_id', 'field_key', 'value'], d.extractions.map((x) => ({ ...x, tenant_id: tenant })));
    await many('document_financials', ['tenant_id', 'document_id', 'doc_kind', 'direction', 'invoice_number', 'po_number', 'total', 'status'],
      d.financials.map((f) => ({ tenant_id: tenant, document_id: f.document_id, doc_kind: f.doc_kind || 'invoice', direction: f.direction || 'receivable', invoice_number: f.invoice_number ?? null, po_number: f.po_number ?? null, total: f.total ?? null, status: ['paid', 'unpaid', 'partial'].includes(f.status) ? f.status : 'unknown' })));
  }
  const dA = load(KA), dB = load(KB);
  await seed(tenA, dA); await seed(tenB, dB);
  const today = '2026-10-07';
  process.env.DONOVAN_READER_V2 = '1'; delete process.env.DONOVAN_READER_V2_SHADOW;
  const exp = (key) => expected.filter((e) => e.key === key);
  const pick = (key, pred, n) => exp(key).filter(pred).slice(0, n);
  const quiet = async (fn) => { const l = console.log; console.log = (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"route"')) return; l(...a); }; try { return await fn(); } finally { console.log = l; } };
  const ask = (ctx, q) => quiet(() => A.runReader(RS.withTenant, ctx, q, today));

  // 1. the tenant-scoped reads give the same answers as the fixture run (answered ones)
  const sampleA = pick(KA, (e) => e.a === 1, 25);
  let same = 0; for (const e of sampleA) { const r = await ask(ctxA, e.q); if (r.answered && r.text === e.t && JSON.stringify(r.docs) === JSON.stringify(e.d)) same++; }
  check(`database read (organization A): ${same}/${sampleA.length} answered questions give the identical answer and documents`, same === sampleA.length);
  const relA = pick(KA, (e) => e.a === 0, 10); let rel = 0; for (const e of relA) { const r = await ask(ctxA, e.q); if (!r.answered) rel++; }
  check(`database read (organization A): ${rel}/${relA.length} released questions stay released`, rel === relA.length);
  // 2. isolation: organization B never answers from A's documents, and A's document numbers are unknown to B
  const sampleB = pick(KB, (e) => e.a === 1, 15); let sameB = 0; for (const e of sampleB) { const r = await ask(ctxB, e.q); if (r.answered && r.text === e.t) sameB++; }
  check(`database read (organization B): ${sameB}/${sampleB.length} identical`, sameB === sampleB.length);
  const aDocs = new Set(dA.documents.map((d) => d.id)); let leak = 0, probes = 0;
  for (const e of sampleA.slice(0, 15)) { const r = await ask(ctxB, e.q); probes++; if (r.answered && (r.docs || []).some((id) => aDocs.has(id))) leak++; }
  check(`isolation: ${probes} questions written for organization A, asked inside organization B, cited none of A's documents`, leak === 0, `leaks=${leak}`);
  // 3. a document the audience filter keeps out is not readable
  const target = sampleA.find((e) => (e.d || []).length === 1 && /^(Total|Date)/.test(e.t)); 
  if (target) {
    await lite.query(`UPDATE documents SET audience = 'internal' WHERE id = $1`, [target.d[0]]);
    A._forgetIndexes?.();
    const r = await ask(ctxA, target.q);
    check('an internal-audience document is left out of the reader', !(r.answered && (r.docs || []).includes(target.d[0])), JSON.stringify({ answered: r.answered, text: String(r.text).slice(0, 60) }));
    await lite.query(`UPDATE documents SET audience = 'customer' WHERE id = $1`, [target.d[0]]);
  }
  // 4. the hook end to end: released -> answered only when ON; an answer is never replaced; shadow never changes the body
  const rel1 = exp(KA).find((e) => e.a === 0 && false); void rel1;
  const ans1 = sampleA[0]; A._forgetIndexes?.();
  const released = { success: true, data: { kind: 'no-answer', text: 'I could not find that.', facts: [], sources: [], confidence: 0, verifiedCount: 0, unverifiedCount: 0, closest: [] } };
  const ctx = { withTenant: RS.withTenant, ctxArg: ctxA, question: ans1.q, today };
  process.env.DONOVAN_READER_V2 = '1'; const onOut = await quiet(() => A.readerV2Hook(ctx, released));
  check('switch on, current path released: the reader answers with the document it came from', onOut.data.kind === 'answer' && onOut.data.text === ans1.t && onOut.data.sources.length >= 1 && onOut.data.sources.every((s) => s.documentId));
  check('the answer has the same response shape as other lanes (kind, text, facts, sources, confidence, verifiedCount, closest, records, basis)', ['kind', 'text', 'facts', 'sources', 'confidence', 'verifiedCount', 'unverifiedCount', 'closest', 'records', 'basis'].every((k) => k in onOut.data));
  delete process.env.DONOVAN_READER_V2; process.env.DONOVAN_READER_V2_SHADOW = '1';
  const logs = []; const orig = console.log; console.log = (...a) => { if (typeof a[0] === 'string' && a[0].includes('"readerV2"')) logs.push(a[0]); };
  const shOut = await A.readerV2Hook(ctx, released); console.log = orig;
  check('shadow only: what is sent is untouched', shOut === released);
  const line = logs.length ? JSON.parse(logs[0]).readerV2 : null;
  check('shadow only: one log line compares the two answers with ids, scores and reason, and carries no document text', Boolean(line) && line.mode === 'shadow' && line.cur.kind === 'no-answer' && line.v2.answered === true && !JSON.stringify(line).includes(ans1.t.slice(0, 20)), JSON.stringify(line)?.slice(0, 200));
  delete process.env.DONOVAN_READER_V2_SHADOW;
  A._assumeParity(null);
  await lite.close?.();
}
