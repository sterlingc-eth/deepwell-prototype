/**
 * Geo count parity (Workstream C, 2026-09-25): "how many customers in Mesa" / "in AZ", the by-city and
 * by-state breakdowns, and zip counts must agree EXACTLY with the scorecard's own independent oracle SQL
 * (test-docs/scorecard/exam.json / api/_lib/scorecard/oracle.js) — no code shared with it.
 *
 * Root cause of the live scorecard's 75.9% run (Mesa 19 vs oracle 18, AZ 45 vs 44): api/_lib/analytics.js's
 * deriveState() required an UPPERCASE state code right before the ZIP and only recognized a dash-separated
 * ZIP+4, so it silently disagreed with the oracle's own (case-insensitive, space-or-dash-or-nothing) ZIP+4
 * regex on odd-but-real address shapes — a customer the oracle can (or can't) place in a state/city, the app
 * placed differently, shifting a count by exactly one customer. Fixed in deriveState/deriveZip
 * (api/_lib/analytics.js); this script locks the fix in and is not code the oracle itself depends on.
 *
 * Method: seed one tenant in a REAL Postgres (PGlite, from the actual M3-config/*.sql migrations, queried
 * through the app's own RLS role) with every disagreeing address shape called out in the scorecard failure
 * notes, then run BOTH:
 *   (a) the oracle SQL, copied verbatim from test-docs/scorecard/exam.json's counts-geo/comparisons questions
 *       (never imported from the app — see oracle.js's own header comment on why), via runOracle, and
 *   (b) the app's own pipeline: deriveCity/deriveState/deriveZip + buildAnalyticsSQL + matchesAllFilters +
 *       groupRows (api/_lib/analytics.js), fed by a real db.raw() read of the same seeded rows,
 * and asserts they produce the same number/breakdown every time.
 *
 *   node scripts/verify-geo-parity.mjs
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
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.NEON_CONNECTION_STRING = 'postgres://harness:harness@localhost:5432/harness';
delete process.env.ANTHROPIC_API_KEY;

console.warn = () => {};
console.error = () => {};

/* ================================================================== harness: real Postgres via PGlite */
let PGlite;
const contrib = {};
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  for (const key of ['uuid_ossp', 'pgcrypto', 'pg_trgm', 'btree_gin']) contrib[key] = (await import(`@electric-sql/pglite/contrib/${key}`))[key];
} catch (err) {
  console.log(`SKIP  database-backed checks: PGlite is not installed (${err?.message}). Run npm ci.`);
  console.log(failures ? `${failures} check(s) FAILED.` : `${passes} checks passed (database-backed checks skipped).`);
  process.exit(failures ? 1 : 0);
}
const lite = new PGlite({ extensions: contrib });
const cfgDir = path.join(ROOT, 'M3-config');
for (const f of fs.readdirSync(cfgDir).filter((x) => /^\d\d.*\.sql$/.test(x) && !x.startsWith('99')).sort()) {
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch { /* notes printed by verify-agent */ }
}
try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* as verify-agent */ }

const pgMod = (await import('pg')).default;
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

const { withTenant, getTenantContext } = await import('../api/_lib/recordsStore.js');
const { runOracle } = await import('../api/_lib/scorecard/oracle.js');
const { deriveCity } = await import('../api/_lib/routes/customers.js');
const {
  deriveState, deriveZip, deriveGeo, buildAnalyticsSQL, matchesAllFilters, groupRows,
} = await import('../api/_lib/analytics.js');

const TODAY = '2026-09-25';
const ctx = { tenantKey: 'org_geo_parity', tenantName: 'Geo Parity Shop' };
const tenId = (await getTenantContext(ctx.tenantKey, ctx.tenantName)).id;
const uid = (n) => `ceababcd-0000-4000-8000-${String(n).padStart(12, '0')}`;

/* ================================================================== fixture
 * Every address shape the failure notes named as a suspect (comma vs no comma before the state, a
 * suite/unit segment, a ZIP+4, a bare state with no ZIP at all, a bare zip with no state) PLUS the shapes
 * a byte-for-byte read of the oracle's own regex says it also accepts but the app's old code didn't
 * (lowercase/mixed-case state, a space- or un-separated ZIP+4) and the merged/duplicate cases the failure
 * notes explicitly flagged as worth checking.
 */
const CUSTOMERS = [
  { n: 1, name: 'Ann Alpha', address: '10 Main St, Mesa, AZ 85201' }, // baseline: comma before state
  { n: 2, name: 'Bob Bravo', address: '20 Oak Ave, Tempe AZ 85281' }, // no comma before the state
  { n: 3, name: 'Cy Charlie', address: '30 Elm Rd, Suite 110, Mesa, AZ 85202-1234' }, // unit segment + ZIP+4 (dash)
  { n: 4, name: 'Di Delta', address: '40 Pine Ln, Gilbert, AZ' }, // state with no ZIP at all
  { n: 5, name: 'Ed Echo', address: '50 Cedar Dr, Las Vegas, NV 89101' }, // out of state
  { n: 6, name: 'Fay Foxtrot', address: '60 Birch Ct, Mesa AZ 85203' }, // no comma, plain ZIP
  { n: 7, name: 'Gus Golf', address: '70 Palm Way, Tucson, AZ 85701' },
  { n: 8, name: 'Hank Hotel', address: '80 Ranch Rd, Mesa, az 85204' }, // lowercase state + ZIP
  { n: 9, name: 'Ivy India', address: '90 Vista Dr, Chandler, AZ 85205 1234' }, // ZIP+4, SPACE separator
  { n: 10, name: 'Jan Juliet', address: '11 Main St, Mesa, AZ 85201' }, // same city as #1, distinct customer, never merged
  { n: 11, name: 'Ken Kilo', address: '12 Main St, Mesa, AZ 85201', mergedInto: 1 }, // MERGED: must be invisible everywhere
  { n: 12, name: 'Leo Lima', address: '95 Odd Address' }, // no comma at all: no city, no state, on both sides
  { n: 13, name: 'Mia Mike', address: '13 Fourth St, Chandler, AZ 852061234' }, // ZIP+4, NO separator at all
];

async function seed() {
  for (const c of CUSTOMERS) {
    await lite.query(
      'INSERT INTO entities (id, tenant_id, entity_type, data, merged_into) VALUES ($1,$2,$3,$4::jsonb,$5)',
      [uid(c.n), tenId, 'customer', JSON.stringify({ customer_name: c.name, service_address: c.address }), c.mergedInto ? uid(c.mergedInto) : null]
    );
  }
}
await seed();

/* ================================================================== app-side count/breakdown, driven by
 * the real code this fix touched — the same pipeline routes/analytics.js's runAnalyticsQuestion drives,
 * minus the model call (that classifier/planner behavior is verify-analytics.mjs's job, not this one's).
 */
async function appCustomerRows(filters = []) {
  const { sql, params } = buildAnalyticsSQL({ entity: 'customers', filters });
  const rows = await withTenant(ctx, (db) => db.raw(sql, params));
  return rows.rows
    .map((r) => ({ id: r.id, customerName: r.customer_name, ...deriveGeo(r.service_address) }))
    .filter((r) => matchesAllFilters(r, filters));
}
async function appCountByCity(city) { return (await appCustomerRows([{ field: 'city', op: 'eq', value: city }])).length; }
async function appCountByState(state) { return (await appCustomerRows([{ field: 'state', op: 'eq', value: state }])).length; }
async function appCountByZip(zip) { return (await appCustomerRows([{ field: 'zip', op: 'eq', value: zip }])).length; }
const UNKNOWN_BUCKET = 'Unknown';
/** The app's own groupBy buckets an unclassifiable customer into "Unknown" (a deliberate, transparent UX
 *  choice — see analytics.js's UNKNOWN_BUCKET) rather than the oracle's "just leave it out of the breakdown"
 *  choice; that's an intentional display difference, not a parity bug, so it's excluded here — what this
 *  compares is whether the buckets BOTH sides do classify agree exactly. */
async function appBreakdown(field) {
  const rows = await appCustomerRows([]);
  return groupRows(rows, (r) => r[field] ?? null)
    .filter((g) => g.key !== UNKNOWN_BUCKET)
    .map((g) => `${g.key}|${g.count}`)
    .sort();
}

/* ================================================================== oracle-side, via the SAME oracle SQL
 * shapes exam.json ships (copied verbatim from the live counts-geo/comparisons questions — see the
 * literal text in test-docs/scorecard/exam.json for hvac-owner-0030-canonical's city clause etc.).
 */
const CITY_EXPR = `(SELECT z.s FROM (SELECT btrim(regexp_replace(regexp_replace(t.seg, '(^|[[:space:],])[A-Za-z]{2}[[:space:]]*[0-9]{5}([[:space:]-]*[0-9]{4})?[[:space:]]*$', ''), '(^|[[:space:],])[A-Z]{2}[[:space:]]*$', '')) AS s, t.ord FROM unnest(string_to_array((c.data->>'service_address'), ',')) WITH ORDINALITY AS t(seg, ord) WHERE t.ord > 1) z WHERE z.s <> '' AND z.s !~ '[0-9]' AND z.s !~* '^(suite|ste|unit|apt|apartment|bldg|building|floor|fl|room|rm|lot|space|spc)([[:space:].]|$)' ORDER BY z.ord DESC LIMIT 1)`;
const STATE_EXPR = `COALESCE(upper(substring((c.data->>'service_address') from '(?:^|[^A-Za-z])([A-Za-z]{2})[[:space:]]*[0-9]{5}([[:space:]-]*[0-9]{4})?[[:space:]]*$')), upper(substring((c.data->>'service_address') from ',[[:space:]]*([A-Za-z]{2})[[:space:]]*$')), CASE WHEN (c.data->>'service_address') ~* '\\marizona\\M' THEN 'AZ' END)`;
const ZIP_EXPR = `substring((c.data->>'service_address') from '([0-9]{5})([[:space:]-]*[0-9]{4})?[[:space:]]*$')`;

async function oracleQuestion(sql, params = [], cmp = 'number') {
  const q = { text: 'geo-parity-fixture', cmp, oracle: { sql, params } };
  return runOracle(withTenant, ctx, q, { today: TODAY });
}
async function oracleCountByCity(city) {
  const r = await oracleQuestion(`SELECT count(*) AS n FROM entities c WHERE c.entity_type = 'customer' AND c.merged_into IS NULL AND lower(${CITY_EXPR}) = lower($1)`, [city]);
  return r.expected;
}
async function oracleCountByState(state) {
  const r = await oracleQuestion(`SELECT count(*) AS n FROM entities c WHERE c.entity_type = 'customer' AND c.merged_into IS NULL AND lower(${STATE_EXPR}) = lower($1)`, [state]);
  return r.expected;
}
async function oracleCountByZip(zip) {
  const r = await oracleQuestion(`SELECT count(*) AS n FROM entities c WHERE c.entity_type = 'customer' AND c.merged_into IS NULL AND ${ZIP_EXPR} = $1`, [zip]);
  return r.expected;
}
async function oracleBreakdown(expr) {
  const r = await oracleQuestion(
    `SELECT k || '|' || n AS item FROM (SELECT ${expr} AS k, count(*) AS n FROM entities c WHERE c.entity_type = 'customer' AND c.merged_into IS NULL GROUP BY 1) g WHERE k IS NOT NULL ORDER BY n DESC, k`,
    [], 'set'
  );
  return [...(r.expected ?? [])].sort();
}

/* ================================================================== 1. per-address unit checks (deriveCity/State/Zip
 * against the oracle's own extraction, one shape at a time — pinpoints exactly which shape regressed). */
for (const c of CUSTOMERS) {
  const [{ rows: cityRows }, { rows: stateRows }, { rows: zipRows }] = await Promise.all([
    lite.query(`SELECT ${CITY_EXPR} AS v FROM (SELECT $1::jsonb AS data) c`, [JSON.stringify({ service_address: c.address })]),
    lite.query(`SELECT ${STATE_EXPR} AS v FROM (SELECT $1::jsonb AS data) c`, [JSON.stringify({ service_address: c.address })]),
    lite.query(`SELECT ${ZIP_EXPR} AS v FROM (SELECT $1::jsonb AS data) c`, [JSON.stringify({ service_address: c.address })]),
  ]);
  const oracleCity = cityRows[0]?.v ?? null;
  const oracleState = stateRows[0]?.v ?? null;
  const oracleZip = zipRows[0]?.v ?? null;
  eq(`city parity :: "${c.address}"`, deriveCity(c.address), oracleCity);
  eq(`state parity :: "${c.address}"`, deriveState(c.address), oracleState);
  eq(`zip parity :: "${c.address}"`, deriveZip(c.address), oracleZip);
}

/* ================================================================== 2. counts (the exact scorecard failure shape) */
{
  const [appMesa, oraMesa] = [await appCountByCity('Mesa'), await oracleCountByCity('Mesa')];
  eq('count parity :: customers in Mesa', appMesa, oraMesa);
  check('count parity :: Mesa is the expected 5 (1, 3, 6, 8, 10 — #11 merged out)', appMesa === 5, `got ${appMesa}`);

  const [appAZ, oraAZ] = [await appCountByState('AZ'), await oracleCountByState('AZ')];
  eq('count parity :: customers in AZ', appAZ, oraAZ);
  check('count parity :: AZ is the expected 10 (everyone but #5 NV, #11 merged, #12 no state)', appAZ === 10, `got ${appAZ}`);

  const [appNV, oraNV] = [await appCountByState('NV'), await oracleCountByState('NV')];
  eq('count parity :: customers in NV', appNV, oraNV);

  const [appTucson, oraTucson] = [await appCountByCity('Tucson'), await oracleCountByCity('Tucson')];
  eq('count parity :: customers in Tucson', appTucson, oraTucson);
}

/* ================================================================== 3. breakdowns never gain or lose a customer
 * differently than the oracle (this is exactly the "46 vs 45, one customer lost/gained" scorecard symptom). */
{
  const appCity = await appBreakdown('city');
  const oraCity = await oracleBreakdown(CITY_EXPR);
  eq('breakdown parity :: by city', appCity, oraCity);
  const appCitySum = appCity.reduce((s, x) => s + Number(x.split('|')[1]), 0);
  const oraCitySum = oraCity.reduce((s, x) => s + Number(x.split('|')[1]), 0);
  eq('breakdown parity :: by-city totals match (both exclude #12, the one address with no comma at all)', appCitySum, oraCitySum);

  const appState = await appBreakdown('state');
  const oraState = await oracleBreakdown(STATE_EXPR);
  eq('breakdown parity :: by state', appState, oraState);
}

/* ================================================================== 4. zip counts + ZIP+4 in every separator shape */
{
  eq('zip parity :: 85202 finds the dash-separated ZIP+4 customer (#3)', await appCountByZip('85202'), await oracleCountByZip('85202'));
  eq('zip parity :: 85205 finds the space-separated ZIP+4 customer (#9)', await appCountByZip('85205'), await oracleCountByZip('85205'));
  eq('zip parity :: 85206 finds the unseparated ZIP+4 customer (#13)', await appCountByZip('85206'), await oracleCountByZip('85206'));
  eq('zip parity :: 85201 finds both Main St customers (#1 and #10)', await appCountByZip('85201'), await oracleCountByZip('85201'));
  check('zip parity :: 85201 is exactly 2 (the merged #11 at the same address never counts)', (await appCountByZip('85201')) === 2);
}

/* ================================================================== 5. "no comma at all" customer (#12) is excluded
 * from every geo bucket on BOTH sides — never silently guessed into one. */
{
  eq('geo parity :: an address with no comma at all has no derivable city on either side', deriveCity('95 Odd Address'), null);
  eq('geo parity :: an address with no comma at all has no derivable state on either side', deriveState('95 Odd Address'), null);
}

const total = passes + failures;
console.log(`\n${passes}/${total} checks passed.`);
process.exit(failures ? 1 : 0);
