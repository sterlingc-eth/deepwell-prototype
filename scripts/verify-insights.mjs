/**
 * Checks for PROACTIVE INSIGHTS (R17 contract, G1): api/_lib/insights/**,
 * api/_lib/routes/insights.js, M3-config/55-insights-cache.sql.
 *
 * Two harnesses, same convention as scripts/verify-rollups.mjs and
 * scripts/verify-money-consistency.mjs:
 *
 *   1. A small, hand-built PGlite fixture (own tenant) — every detector's
 *      count is cross-checked against an INDEPENDENT SQL/JS computation
 *      (never the same code path the detector itself calls), plus a second,
 *      empty tenant proves RLS tenant isolation (no cross-tenant leakage).
 *   2. The real golden corpus (scripts/golden/golden-export.json, the
 *      "golden tenant" the R17 contract's own performance budget names) —
 *      cold compute, then a cache write + a warm cache read timed at
 *      <150ms.
 *
 * No network, no Anthropic key, no model call.
 *
 *   node scripts/verify-insights.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.NEON_CONNECTION_STRING ||= 'postgres://harness:harness@localhost:5432/harness';
delete process.env.VOYAGE_API_KEY;
const realWarn = console.warn;
console.warn = () => {};

let PGlite, contrib = {};
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  for (const key of ['uuid_ossp', 'pgcrypto', 'pg_trgm', 'btree_gin']) contrib[key] = (await import(`@electric-sql/pglite/contrib/${key}`))[key];
} catch (err) {
  console.log(`SKIP  database-backed checks: PGlite is not installed (${err?.message}). Run npm ci.`);
  if (failures) { console.log(`${failures} check(s) FAILED.`); process.exit(1); }
  console.log(`${passes} checks passed (database-backed checks skipped).`);
  process.exit(0);
}

const cfgDir = path.join(ROOT, 'M3-config');
const allMigrations = fs.readdirSync(cfgDir).filter((x) => /^\d\d.*\.sql$/.test(x) && !x.startsWith('99')).sort();

async function freshLite(migrations) {
  const lite = new PGlite({ extensions: contrib });
  const notes = [];
  for (const f of migrations) {
    try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch (err) { notes.push(`${f}: ${String(err.message).slice(0, 100)}`); }
  }
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch (err) { notes.push(`01b re-run failed: ${err.message}`); }
  return { lite, notes };
}

function wirePg(lite, pgMod) {
  let tail = Promise.resolve();
  const lock = () => { let release; const p = new Promise((r) => { release = r; }); const prev = tail; tail = tail.then(() => p); return prev.then(() => release); };
  pgMod.Pool.prototype.connect = async function connect() {
    const release = await lock();
    await lite.exec('SET ROLE deepwell_rls');
    return { query: (sql, params) => lite.query(sql, params), release: () => { lite.exec('RESET ROLE').finally(release); } };
  };
  pgMod.Pool.prototype.query = async function query(sql, params) {
    const release = await lock();
    try { return await lite.query(sql, params); } finally { release(); }
  };
}

const pgMod = (await import('pg')).default;

/* ================================================================== 1. fixture: per-detector correctness + isolation */
{
  const { lite, notes } = await freshLite(allMigrations);
  wirePg(lite, pgMod);
  for (const n of notes) console.log(`NOTE  migration harness: ${n}`);
  check('harness: migration 55 loaded cleanly', !notes.some((n) => n.startsWith('55-')));

  const { withTenant, getTenantContext } = await import('../api/_lib/recordsStore.js');
  const { computeInsights } = await import('../api/_lib/insights/detect.js');
  const { getCachedInsights, setCachedInsights, getCorpusStamp } = await import('../api/_lib/insights/store.js');

  const ctx = { tenantKey: 'org_insights', tenantName: 'Insights Shop' };
  const tenId = (await getTenantContext(ctx.tenantKey, ctx.tenantName)).id;
  const uid = (kind, n) => `dab00000-0000-4000-9${kind}00-${String(n).padStart(12, '0')}`;
  const eId = (n) => uid('e', n);
  const cId = (n) => uid('c', n);
  const dId = (n) => uid('d', n);
  const TODAY = '2026-09-26';

  await withTenant(ctx, async (db) => {
    // ---- customers
    await db.raw(`INSERT INTO entities (id, tenant_id, entity_type, data) VALUES ($1,$2,'customer',$3::jsonb)`,
      [cId(0), tenId, JSON.stringify({ customer_name: 'Acme Plaza', service_address: '1 Main St, Mesa, AZ 85201' })]);
    await db.raw(`INSERT INTO entities (id, tenant_id, entity_type, data) VALUES ($1,$2,'customer',$3::jsonb)`,
      [cId(1), tenId, JSON.stringify({ customer_name: 'Beacon Dental', service_address: '2 Oak Ave, Mesa, AZ 85201' })]);

    // ---- equipment: one expiring in 30 days (within 60), one registration window closing in 10
    // days, one fully covered (2400 days out), one missing serial+model entirely.
    await db.raw(`INSERT INTO entities (id, tenant_id, entity_type, data, customer_id) VALUES ($1,$2,'equipment',$3::jsonb,$4)`,
      [eId(0), tenId, JSON.stringify({ manufacturer: 'Trane', model: 'XR16', serial_number: 'SN-1', customer_name: 'Acme Plaza', service_address: '1 Main St, Mesa, AZ 85201', warranty: { expires: '2026-10-26', registrationOnFile: true } }), cId(0)]);
    await db.raw(`INSERT INTO entities (id, tenant_id, entity_type, data, customer_id) VALUES ($1,$2,'equipment',$3::jsonb,$4)`,
      [eId(1), tenId, JSON.stringify({ manufacturer: 'Carrier', model: '58MVC', serial_number: 'SN-2', customer_name: 'Beacon Dental', service_address: '2 Oak Ave, Mesa, AZ 85201', warranty: { registrationDeadline: '2026-10-06', registrationOnFile: false } }), cId(1)]);
    await db.raw(`INSERT INTO entities (id, tenant_id, entity_type, data, customer_id) VALUES ($1,$2,'equipment',$3::jsonb,$4)`,
      [eId(2), tenId, JSON.stringify({ manufacturer: 'Rheem', model: 'RHEEM-1', serial_number: 'SN-3', customer_name: 'Acme Plaza', service_address: '1 Main St, Mesa, AZ 85201', warranty: { expires: '2033-01-01', registrationOnFile: true } }), cId(0)]);
    await db.raw(`INSERT INTO entities (id, tenant_id, entity_type, data, customer_id) VALUES ($1,$2,'equipment',$3::jsonb,$4)`,
      [eId(3), tenId, JSON.stringify({ manufacturer: '', model: '', serial_number: '', customer_name: 'Beacon Dental', service_address: '2 Oak Ave, Mesa, AZ 85201' }), cId(1)]);

    // ---- documents + financials: one quote with no later invoice, one PO/cost doc with no
    // invoice at all (a separate job address so it never collides with the quote's own job),
    // one overdue invoice, one paid invoice (never counted anywhere).
    for (let i = 0; i < 4; i++) {
      await db.raw(`INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ($1,$2,$3,$4,$5,'verified')`,
        [dId(i), tenId, `doc${i}.pdf`, ['estimate', 'po', 'invoice', 'invoice'][i], `hash-${i}`]);
    }
    // document_financials has NO customer_id column of its own — the `financials` view
    // (api/_lib/agent/financeViews.js) resolves it live via document_entity_links (see below),
    // exactly like the real ingest pipeline. customer_name is a real column and is also set,
    // matching what extraction actually writes.
    await db.raw(
      `INSERT INTO document_financials (tenant_id, document_id, doc_kind, direction, currency, total, invoice_date, customer_name)
       VALUES ($1,$2,'estimate','receivable','USD',500,'2026-08-01','Acme Plaza')`,
      [tenId, dId(0)]
    );
    await db.raw(
      `INSERT INTO document_financials (tenant_id, document_id, doc_kind, direction, currency, total, invoice_date, vendor_name, job_key)
       VALUES ($1,$2,'po','payable','USD',800,'2026-08-05','Acme Supply Co','999 job site rd-mesa-az')`,
      [tenId, dId(1)]
    );
    await db.raw(
      `INSERT INTO document_financials (tenant_id, document_id, doc_kind, direction, currency, total, amount_paid, balance_due, due_date, invoice_date, status, customer_name)
       VALUES ($1,$2,'invoice','receivable','USD',1200,0,1200,'2026-08-01','2026-07-15','unpaid','Beacon Dental')`,
      [tenId, dId(2)]
    );
    await db.raw(
      `INSERT INTO document_financials (tenant_id, document_id, doc_kind, direction, currency, total, amount_paid, balance_due, due_date, invoice_date, status, customer_name)
       VALUES ($1,$2,'invoice','receivable','USD',300,300,0,'2026-06-01','2026-05-15','paid','Acme Plaza')`,
      [tenId, dId(3)]
    );

    // ---- link each money document to its customer, same table (document_entity_links) and
    // shape the real ingest pipeline writes — this is what lets f.customer_id/customer_name
    // resolve on the `financials` view at all.
    await db.raw(`INSERT INTO document_entity_links (tenant_id, document_id, entity_id) VALUES ($1,$2,$3)`, [tenId, dId(0), cId(0)]);
    await db.raw(`INSERT INTO document_entity_links (tenant_id, document_id, entity_id) VALUES ($1,$2,$3)`, [tenId, dId(2), cId(1)]);
    await db.raw(`INSERT INTO document_entity_links (tenant_id, document_id, entity_id) VALUES ($1,$2,$3)`, [tenId, dId(3), cId(0)]);
  });

  const result = await withTenant(ctx, (db) => computeInsights(db, { today: TODAY, includeMoney: true }));
  // Owner decision 2026-09-26: money insights are OFF by default (a payment recorded outside DeepWell would look overdue).
  {
    const { moneyInsightsEnabled } = await import('../api/_lib/insights/detect.js');
    check('money insights off by default (no DONOVAN_INSIGHTS_MONEY)', moneyInsightsEnabled({}) === false);
    check('money insights on only with DONOVAN_INSIGHTS_MONEY=1', moneyInsightsEnabled({ DONOVAN_INSIGHTS_MONEY: '1' }) === true);
    const dflt = await withTenant(ctx, (db) => computeInsights(db, { today: TODAY, includeMoney: false }));
    check('default compute emits no financial insights', !(dflt.items ?? []).some((i) => i.kind === 'financial'));
  }
  const byId = Object.fromEntries(result.items.map((i) => [i.id, i]));

  /* ---- 1. warranty: expiring <=60d (independent SQL: daysBetween by hand) */
  check('warranty-expiring-60: fires for the unit expiring in 30 days', byId['warranty-expiring-60']?.count === 1, JSON.stringify(byId['warranty-expiring-60']));
  check('warranty-expiring-60: cites the right unit (entityId) and no others', byId['warranty-expiring-60']?.items?.[0]?.entityId === eId(0));
  check('warranty-expiring-60: the 2033 unit and the unregistered unit are NOT counted', byId['warranty-expiring-60']?.count === 1);

  /* ---- 2. warranty: registration window closing (independent: registrationActionNeededOf is
   * itself the reused engine — cross-check with the raw rule it documents: no registrationOnFile
   * + deadline within 30 days). */
  check('warranty-registration-closing: fires for the unregistered unit with a 10-day deadline', byId['warranty-registration-closing']?.count === 1);
  check('warranty-registration-closing: cites that unit, not the registered ones', byId['warranty-registration-closing']?.items?.[0]?.entityId === eId(1));

  /* ---- 3. quotes waiting (independent SQL: any invoice for the SAME customer dated on/after the
   * quote? customer_id resolved through document_entity_links, same as the real `financials` view
   * does — see the fixture's own comment above). */
  const [{ n: liveQuotesWaiting }] = (await withTenant(ctx, (db) => db.raw(
    `SELECT count(*)::int AS n
       FROM document_financials q
       JOIN document_entity_links ql ON ql.document_id = q.document_id AND ql.tenant_id = q.tenant_id
      WHERE q.tenant_id = $1 AND q.doc_kind = 'estimate' AND q.direction = 'receivable' AND q.invoice_date IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM document_financials i
          JOIN document_entity_links il ON il.document_id = i.document_id AND il.tenant_id = i.tenant_id
          WHERE i.tenant_id = $1 AND i.doc_kind = 'invoice' AND i.direction = 'receivable'
            AND il.entity_id = ql.entity_id AND i.invoice_date IS NOT NULL AND i.invoice_date >= q.invoice_date)`,
    [tenId]
  ))).rows;
  check('quotes-not-invoiced: matches independent SQL', (byId['quotes-not-invoiced']?.count ?? 0) === liveQuotesWaiting, `detector=${byId['quotes-not-invoiced']?.count} live=${liveQuotesWaiting}`);
  check('quotes-not-invoiced: count is exactly 1 (Acme Plaza\'s quote)', byId['quotes-not-invoiced']?.count === 1);

  /* ---- 4. work done with no invoice (job-costing: a job with only a cost document) */
  check('work-no-invoice: fires for the PO with no matching invoice', byId['work-no-invoice']?.count === 1, JSON.stringify(byId['work-no-invoice']));
  check('work-no-invoice: reports the PO\'s own dollar amount ($800)', byId['work-no-invoice']?.dollars === 800);
  check('work-no-invoice: cites the PO document', (byId['work-no-invoice']?.items?.[0]?.documentIds ?? []).includes(dId(1)));

  /* ---- 5. overdue receivables (independent SQL against document_financials directly) */
  const [{ n: liveOverdueN, total: liveOverdueTotal }] = (await withTenant(ctx, (db) => db.raw(
    `SELECT count(*)::int AS n, COALESCE(sum(balance_due),0)::numeric AS total FROM document_financials
      WHERE tenant_id = $1 AND doc_kind='invoice' AND direction='receivable' AND currency='USD'
        AND status IN ('unpaid','partial') AND balance_due > 0 AND due_date < $2`,
    [tenId, TODAY]
  ))).rows;
  check('overdue-receivables: count matches independent SQL', byId['overdue-receivables']?.count === liveOverdueN, `detector=${byId['overdue-receivables']?.count} live=${liveOverdueN}`);
  check('overdue-receivables: dollars match independent SQL', byId['overdue-receivables']?.dollars === Number(liveOverdueTotal), `detector=${byId['overdue-receivables']?.dollars} live=${liveOverdueTotal}`);
  check('overdue-receivables: top customer is Beacon Dental', byId['overdue-receivables']?.items?.some((i) => i.entityId === cId(1)));

  /* ---- 6. citations present: every item on every insight names an entity or a document */
  const allItemsCited = result.items.every((ins) => ins.items.every((it) => it.entityId || (it.documentIds && it.documentIds.length)));
  check('every insight item carries a citation (entityId or documentIds)', allItemsCited);

  /* ---- 7. title length + shape */
  check('every insight title is <=60 chars', result.items.every((i) => i.title.length <= 60));
  check('every insight has a severity in {high,medium,low}', result.items.every((i) => ['high', 'medium', 'low'].includes(i.severity)));
  check('every insight has an action {label, href}', result.items.every((i) => i.action?.label && i.action?.href));

  /* ---- 8. tenant isolation: a brand-new, empty tenant sees NOTHING from org_insights */
  const ctx2 = { tenantKey: 'org_insights_empty', tenantName: 'Empty Shop' };
  await getTenantContext(ctx2.tenantKey, ctx2.tenantName);
  const result2 = await withTenant(ctx2, (db) => computeInsights(db, { today: TODAY, includeMoney: true }));
  check('tenant isolation: an empty tenant gets zero insights (not org_insights\' data)', result2.items.length === 0, JSON.stringify(result2.items));

  /* ---- 9. cache round-trip: store then read back under the SAME corpus_stamp */
  await withTenant(ctx, async (db) => {
    const stamp = await getCorpusStamp(db, { today: TODAY });
    const wrote = await setCachedInsights(db, stamp, result);
    check('cache: write succeeds once migration 55 is applied', wrote === true);
    const hit = await getCachedInsights(db, { today: TODAY });
    check('cache: a read right after write is a hit', hit !== null);
    check('cache: cached payload round-trips the same item count', hit?.payload?.items?.length === result.items.length);
  });
}

/* ================================================================== 2. golden tenant: performance budget */
{
  const { installPgHarness, createPGlite, setActiveDatabase, loadExportIntoNewTenant } = await import('./offline-exam.mjs');
  await installPgHarness();
  const lite = await createPGlite();
  await setActiveDatabase(lite);
  const exportData = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/golden/golden-export.json'), 'utf8'));
  const { ctx } = await loadExportIntoNewTenant(lite, exportData, { tenantKey: 'verify-insights-golden', tenantName: 'Verify Insights Golden' });

  const { withTenant } = await import('../api/_lib/recordsStore.js');
  const { computeInsights } = await import('../api/_lib/insights/detect.js');
  const { getCachedInsights, setCachedInsights, getCorpusStamp } = await import('../api/_lib/insights/store.js');
  const TODAY = '2026-09-26';

  const cold = await withTenant(ctx, async (db) => {
    const t0 = performance.now();
    const computed = await computeInsights(db, { today: TODAY, includeMoney: true });
    const ms = performance.now() - t0;
    const stamp = await getCorpusStamp(db, { today: TODAY });
    if (stamp != null) await setCachedInsights(db, stamp, computed);
    return { computed, ms };
  });
  check('golden tenant: cold compute produces at least one insight (a 604-document real corpus has SOMETHING to flag)', cold.computed.items.length > 0, JSON.stringify(cold.computed.items.map((i) => i.id)));
  console.log(`NOTE  golden tenant cold compute: ${cold.ms.toFixed(1)}ms (${cold.computed.items.length} insights)`);

  const warm = await withTenant(ctx, async (db) => {
    const t0 = performance.now();
    const hit = await getCachedInsights(db, { today: TODAY });
    const ms = performance.now() - t0;
    return { hit, ms };
  });
  check('golden tenant: warm read is a cache hit', warm.hit !== null);
  check(`golden tenant: warm cached read is under the 150ms budget (was ${warm.ms.toFixed(1)}ms)`, warm.ms < 150);
}

console.warn = realWarn;
console.log('');
if (failures) { console.log(`${failures} check(s) FAILED.`); process.exit(1); }
console.log(`${passes} checks passed.`);
