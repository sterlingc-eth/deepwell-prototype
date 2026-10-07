/**
 * Runs the property data-variant generator (scripts/lib/property-variants.mjs) against the real lane on a real (PGlite) database with
 * TWO property-management companies of the same trade in it (same vendor / unit / property names, different data), plus a set of
 * extractor variants. Wired into `npm run verify:industry-property`.
 *
 *   node scripts/lib/property-variants.run.mjs [-v] [--per N]
 *
 * Every case is graded against the truth computed from the raw rows (see the generator): the LEADING number / amount and the wording
 * are asserted, a declined answer counts as "left to the model" (a floor is asserted so the suite cannot pass by declining everything),
 * and a wrong answer fails the run.
 */
import crypto from 'node:crypto';
import { TODAY, buildCases, bigCase, rng, grade, FAMILY_NAMES } from './property-variants.mjs';

const VERBOSE = process.argv.includes('-v');
const perIdx = process.argv.indexOf('--per');
const PER = perIdx > 0 ? Number(process.argv[perIdx + 1]) : 24;
const seedIdx = process.argv.indexOf('--seed');
const SEED = seedIdx > 0 ? Number(process.argv[seedIdx + 1]) : 20261006;
let failures = 0; let passes = 0;
const check = (n, ok, d = '') => { if (ok) passes++; else { failures++; console.log(`FAIL  ${n}${d ? `\n      ${d}` : ''}`); } };

const { startMixedHarness } = await import('./mixed-company-harness.mjs');
const { classifyProperty, runProperty } = await import('../../api/_lib/industry/property/lane.js');
const { extractProperty } = await import('../../api/_lib/industry/property/extract.js');
const { getTenantContext } = await import('../../api/_lib/recordsStore.js');

const H = await startMixedHarness({ industries: ['property'] });
const ctxB = { tenantKey: 'org_variants_property_two', tenantName: 'Variants property two Co' };
await getTenantContext(ctxB.tenantKey, ctxB.tenantName);
await H.withTenant(ctxB, (db) => H.R.setTenantIndustry(db, 'property', { tenantKey: ctxB.tenantKey }));
H.R.resetPacksCacheForTests(); H.I.resetPackForTenantCacheForTests();
const inA = (fn) => H.as('property', fn);
const inB = (fn) => H.withTenant(ctxB, fn);

let counter = 0;
async function wipe(db) { await db.raw('DELETE FROM documents', []); }
async function load(db, rows) {
  const aud = (await db.raw("SELECT 1 FROM information_schema.columns WHERE table_name = 'documents' AND column_name = 'audience'", [])).rows.length > 0;
  for (const r of rows) {
    const f = r.f.map(([k, v, c]) => (c === undefined ? { k, v: String(v) } : { k, v: String(v), c: String(c) }));
    const internal = r.aud === 'internal';
    if (internal && !aud) f.push({ k: '_audience', v: 'internal' });
    const sha = crypto.createHash('sha256').update(`v${counter++}`).digest('hex');
    const sql = `WITH d AS (INSERT INTO documents (tenant_id, original_filename, document_type, sha256_hash, stage${aud ? ', audience' : ''}) VALUES ((current_setting('app.tenant_id', true))::uuid, $1, $2, $3, 'mapped'${aud ? ', $5' : ''}) RETURNING id),
      x AS (INSERT INTO extractions (tenant_id, document_id, field_key, value, corrected_value, created_at) SELECT (current_setting('app.tenant_id', true))::uuid, d.id, e->>'k', e->>'v', e->>'c', NOW() + (t.ord * interval '1 millisecond') FROM d, jsonb_array_elements($4::jsonb) WITH ORDINALITY AS t(e, ord) RETURNING 1)
      SELECT id FROM d`;
    const params = aud ? [`${r.type}-${counter}.pdf`, r.type, sha, JSON.stringify(f), internal ? 'internal' : 'customer'] : [`${r.type}-${counter}.pdf`, r.type, sha, JSON.stringify(f)];
    const { rows: ids } = await db.raw(sql, params);
    if (r.fin) {
      const x = r.fin;
      await db.raw(`INSERT INTO document_financials (tenant_id, document_id, doc_kind, direction, currency, invoice_number, total, status, due_date, amount_paid, balance_due) VALUES ((current_setting('app.tenant_id', true))::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [ids[0].id, x.kind ?? 'invoice', x.direction ?? 'payable', x.currency ?? 'USD', r.f.find((a) => a[0] === 'invoice_number')?.[1] ?? null, x.total ?? null, x.status ?? 'unknown', x.due ?? null, x.paid ?? null, x.balance ?? null]);
    }
  }
}
const ask = async (db, q) => { const i = classifyProperty(q, { today: TODAY }); return i ? runProperty(db, i, { today: TODAY }) : null; };

const stats = {}; const wrongs = [];
const tally = (fam, g, label) => { const s = (stats[fam] ??= { correct: 0, model: 0, wrong: 0, answerable: 0 }); s[g.cls]++; if (g.cls === 'wrong') wrongs.push(`${label}: ${g.why}`); };
async function runCase(c) {
  for (const [org, rows, run] of [['A', c.rowsA, inA], ['B', c.rowsB, inB]]) {
    await run(async (db) => {
      await wipe(db); await load(db, rows);
      const exp = c.expect(rows);
      const r = await ask(db, c.question);
      const g = grade(exp, r);
      if (!exp.decline && !exp.nearMiss) (stats[c.family] ??= { correct: 0, model: 0, wrong: 0, answerable: 0 }).answerable++;
      tally(c.family, g, `[${c.name}/${org}] "${c.question}"`);
      if (VERBOSE) console.log(`${g.cls.padEnd(7)} ${c.name}/${org}: ${c.question} -> ${r ? String(r.text).slice(0, 110) : 'null'}`);
    });
  }
}

const cases = buildCases(SEED, PER);
for (const c of cases) await runCase(c);
for (const size of [230, 520]) await runCase({ family: 'big', ...bigCase(rng(7 + size), size) });

const tot = Object.values(stats).reduce((a, s) => ({ correct: a.correct + s.correct, model: a.model + s.model, wrong: a.wrong + s.wrong, answerable: a.answerable + s.answerable }), { correct: 0, model: 0, wrong: 0, answerable: 0 });
console.log(`property variants: ${cases.length + 2} cases x 2 companies = ${tot.correct + tot.model + tot.wrong} questions: ${tot.correct} correct / ${tot.model} left to the model / ${tot.wrong} wrong`);
for (const [fam, s] of Object.entries(stats)) console.log(`  ${fam.padEnd(18)} correct ${String(s.correct).padStart(3)}  model ${String(s.model).padStart(3)}  wrong ${s.wrong}  (answerable ${s.answerable})`);
for (const w of wrongs.slice(0, 25)) console.log(`      ${w}`);
check('property variants: no wrong answer (leading number, amount and wording asserted against truth from the raw rows)', tot.wrong === 0, `${tot.wrong} wrong`);
check(`property variants: the lane answers a real share of the answerable questions (${tot.correct} correct of ${tot.answerable} answerable)`, tot.correct >= Math.floor(tot.answerable * 0.5), `${tot.correct}/${tot.answerable}`);
for (const fam of ['coiWhen', 'coiWindow', 'woCount', 'invTotal', 'invOverdue', 'leaseWindow', 'tenantOf', 'countType', 'coiMissing']) {
  const s = stats[fam]; check(`property variants floor: ${fam} answers at least a third of its answerable cases`, !!s && s.correct >= Math.floor(s.answerable / 3), `${s ? `${s.correct}/${s.answerable}` : 'missing'}`);
}
check('property variants: the big corpora (230 and 520 invoices, both companies) were counted exactly', stats.big?.correct === 4, JSON.stringify(stats.big));
check('property variants: every family ran', FAMILY_NAMES.every((f) => stats[f]));

/* ------------------------------------------------------------------ extractor variants */
{
  const page = (t) => [{ page_no: 1, text: t }];
  const LS = (extra) => `RESIDENTIAL LEASE AGREEMENT\nTenant Name: Alma Arden\nUnit: 4B\nProperty: 1 Other St, Mesa AZ\nLease Start Date: 01/01/2026\nLease End Date: 12/31/2026\n${extra}\n`;
  const val = (r, k) => r?.fields.find((x) => x.key === k)?.value;
  check('extractor: a monthly rent in dollars is read', val(extractProperty(page(LS('Monthly Rent: $1,450.00')), { today: TODAY }), 'rent_amount') === '1450.00' || val(extractProperty(page(LS('Monthly Rent: $1,450.00')), { today: TODAY }), 'rent_amount') === '1450');
  for (const bad of ['Monthly Rent: $350.00 per week', 'Monthly Rent: €1,200', 'Monthly Rent: 1,200 EUR', 'Monthly Rent: $1.200,00', 'Monthly Rent: CAD $1,200', 'Monthly Rent: C$1,200', 'Monthly Rent: $14,400 annually', 'Monthly Rent: $60/hr']) {
    const r = extractProperty(page(LS(`${bad}\nSecurity Deposit: $500.00`)), { today: TODAY });
    check(`extractor: not read as monthly dollars: ${bad}`, r == null || val(r, 'rent_amount') == null, String(val(r, 'rent_amount')));
  }
  const withZw = extractProperty(page('RESIDENTIAL LEASE AGREEMENT\nTenant Name: Alma Arden\nUnit: 4B\nProperty: 1 Other St, Mesa AZ\nLease Start Date: 01/01/2026\nLease End​ Date:​ 12/31/2026\nMonthly Rent: $1,000.00\n'), { today: TODAY });
  check('extractor: zero-width characters inside a label or a value are nothing', val(withZw, 'lease_end_date') === '2026-12-31', String(val(withZw, 'lease_end_date')));
  const IV = (extra) => `INVOICE\nVendor: Marlow Plumbing LLC\nInvoice Number: M-1001\nInvoice Date: 09/01/2026\nDue Date: 09/30/2026\nProperty: 1 Other St, Mesa AZ\nTotal: $425.00\n${extra}\n`;
  check('extractor: a plain invoice is read with its total', val(extractProperty(page(IV('Status: Unpaid')), { today: TODAY }), 'cost') === '425.00');
  check('extractor: a VOID stamp makes the invoice status Void', val(extractProperty(page(IV('Status: Unpaid\nVOID')), { today: TODAY }), 'status') === 'Void');
  check('extractor: "Status: Cancelled" on an invoice is Cancelled', val(extractProperty(page(IV('Status: Cancelled')), { today: TODAY }), 'status') === 'Cancelled' || val(extractProperty(page(IV('Status: Cancelled')), { today: TODAY }), 'status') == null);
  check('extractor: a SUPERSEDED stamp on a lease is read as its status', val(extractProperty(page(LS('Monthly Rent: $1,000.00\nSUPERSEDED')), { today: TODAY }), 'status') === 'Superseded');
  const VC = (extra) => `VENDOR SERVICE AGREEMENT\nVendor: Marlow Landscaping LLC\nContract Start Date: 01/01/2026\nContract End Date: 12/31/2026\nMonthly Fee: $500.00\n${extra}\n`;
  check('extractor: a voided vendor contract is not read as a live one', extractProperty(page(VC('VOID')), { today: TODAY }) === null && extractProperty(page(VC('')), { today: TODAY }) != null);
  check('extractor: an hourly rate is never the invoice total', val(extractProperty(page(IV('Status: Unpaid').replace('Total: $425.00', 'Total: $85.00/hr')), { today: TODAY }), 'cost') == null);
}

await H.stop?.();
console.log(`${passes + failures ? `${failures ? failures + ' FAILED, ' : ''}${passes} passed` : 'no checks'}`);
if (failures) process.exit(1);
