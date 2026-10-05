/**
 * H-4 page counter: static wiring checks + the in-process PGlite scenarios of scripts/limit-test-b/page-counter.mjs.
 *   npx tsx scripts/verify-page-counter.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : detail ? `  -> ${detail}` : ''}`); if (!ok) failed++; };

const mig = read('M3-config/67-page-usage-counter.sql');
const code = mig.replace(/--.*$/gm, '');
check('migration 67: whole file in one BEGIN ... COMMIT with the page lock first', /BEGIN;\s*SET LOCAL lock_timeout = '5s';[\s\S]*?LOCK TABLE document_pages IN SHARE ROW EXCLUSIVE MODE;/.test(code) && /COMMIT;/.test(code));
check('migration 67: additive only (no DROP TABLE/COLUMN, no ALTER of an existing table except RLS on the new one, no DELETE/TRUNCATE of data)', !/\bDROP\s+(TABLE|COLUMN)\b/i.test(code) && !/\bTRUNCATE\b/i.test(code) && !/\bDELETE\s+FROM\b/i.test(code) && (code.match(/ALTER TABLE\s+(\w+)/gi) ?? []).every((m) => /page_usage_monthly/.test(m)));
check('migration 67: every CREATE is idempotent (IF NOT EXISTS / OR REPLACE / DROP ... IF EXISTS first)', !/CREATE TABLE (?!IF NOT EXISTS)/i.test(code) && !/CREATE FUNCTION/i.test(code) && /CREATE OR REPLACE TRIGGER document_pages_usage_count/.test(code) && !/DROP TRIGGER/i.test(code) && /DROP POLICY IF EXISTS tenants_isolate_page_usage_monthly/.test(code));
check('migration 67: RLS enabled + forced, tenant policy with USING and WITH CHECK', /ENABLE ROW LEVEL SECURITY/.test(code) && /FORCE\s+ROW LEVEL SECURITY/.test(code) && /USING\s+\(tenant_id = \(current_setting\('app\.tenant_id', true\)\)::uuid\)\s+WITH CHECK/.test(code));
check('migration 67: only an INSERT trigger on document_pages (no DELETE/UPDATE trigger: nothing ever decrements)', (code.match(/CREATE (OR REPLACE )?TRIGGER/gi) ?? []).length === 1 && /AFTER INSERT ON document_pages\s+REFERENCING NEW TABLE AS new_rows\s+FOR EACH STATEMENT/.test(code));
check('migration 67: the trigger function only adds (no "pages = ... -") and never raises (WARNING + RETURN NULL)', /pages = p\.pages \+ EXCLUDED\.pages/.test(code) && !/pages\s*=\s*[^,;]*-\s*/.test(code.slice(code.indexOf('page_usage_count_insert()'), code.indexOf('CREATE OR REPLACE TRIGGER'))) && /RAISE WARNING[\s\S]*RETURN NULL/.test(code));
check('migration 67: SECURITY DEFINER trigger function pins search_path', /page_usage_count_insert\(\)[\s\S]*?SECURITY DEFINER\s+SET search_path = public, pg_temp/.test(code));
check('migration 67: backfill uses GREATEST (never lowers, never double counts)', /pages = GREATEST\(p\.pages, EXCLUDED\.pages\)/.test(code));
check('migration 67: app role gets SELECT and DELETE only on the tally', /GRANT SELECT, DELETE ON page_usage_monthly/.test(code) && !/GRANT[^;]*(INSERT|UPDATE)[^;]*page_usage_monthly/.test(code));
check('opsStore RETAINED_TABLES lists page_usage_monthly (delete-all-data cannot reset the meter)', /page_usage_monthly:/.test(read('api/_lib/opsStore.js')));
check('migration 67: gives up after 5 s instead of queueing behind a slow query', /SET LOCAL lock_timeout = '5s'/.test(code));
check('sqlGuard REAL_TABLES lists page_usage_monthly and the helper functions are denied', /"page_usage_monthly"/.test(read('api/_lib/agent/sqlGuard.js')) && /"page_usage_current_month"/.test(read('api/_lib/agent/sqlGuard.js')));
check('recordsStore.countPagesSince keeps its signature and falls back to the live count when the table is absent', /countPagesSince: async \(sinceIso, excludeWindow = undefined\)/.test(read('api/_lib/recordsStore.js')) && /pageCounterReady\(/.test(read('api/_lib/recordsStore.js')));
check('every caller still goes through countPagesSince (gate, Billing, bootstrap, support)', ['api/upload-url.js', 'api/billing.js', 'api/records.ts', 'api/_lib/support/tools.js'].every((f) => /countPagesSince\(/.test(read(f))));
check('the client only displays the server\'s pagesThisMonth (no client-side page counting)', !/document_pages|countPages/.test(read('src/screens/BillingScreen.tsx')) && /pagesThisMonth/.test(read('src/screens/BillingScreen.tsx') + read('src/services/billingClient.ts')));

const r = spawnSync('npx', ['tsx', '--import', './scripts/limit-test-b/register.mjs', 'scripts/limit-test-b/page-counter.mjs'], { cwd: ROOT, stdio: 'inherit' });
if (r.status !== 0) failed++;
console.log(failed ? `\n${failed} check group(s) FAILED` : '\nAll page-counter checks passed.');
process.exit(failed ? 1 : 0);
