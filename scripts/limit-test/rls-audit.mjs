// RLS audit: every table with a tenant_id column must have ENABLE + FORCE RLS and a policy; app role must not be superuser/BYPASSRLS.
import { bootHarness } from '../lib/r35Harness.mjs';
let failures = 0;
const check = (n, ok, d = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ok || !d ? '' : `\n      ${d}`}`); };
const h = await bootHarness();
console.log('skipped migrations:', JSON.stringify(h.skipped));
const { rows } = await h.lite.query(`
  SELECT c.relname, c.relrowsecurity rls, c.relforcerowsecurity frc,
         (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) npol,
         (SELECT string_agg(pg_get_expr(p.polqual,p.polrelid),' | ') FROM pg_policy p WHERE p.polrelid=c.oid) qual
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relkind='r'
     AND EXISTS (SELECT 1 FROM information_schema.columns k WHERE k.table_schema='public' AND k.table_name=c.relname AND k.column_name IN ('tenant_id','id') AND (k.column_name='tenant_id' OR c.relname='tenants'))
   ORDER BY 1`);
for (const r of rows) {
  check(`table ${r.relname}: RLS enabled+forced with >=1 policy`, r.rls && r.frc && Number(r.npol) > 0, JSON.stringify(r));
}
const all = await h.lite.query(`SELECT c.relname, c.relrowsecurity rls, c.relforcerowsecurity frc FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY 1`);
const withTid = new Set((await h.lite.query(`SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id'`)).rows.map(r=>r.table_name));
console.log('tables:', all.rows.length, 'with tenant_id:', withTid.size);
for (const r of all.rows) if (!withTid.has(r.relname) && r.relname!=='tenants') console.log('  no tenant_id col:', r.relname, 'rls=', r.rls, 'force=', r.frc);
const role = await h.lite.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='deepwell_rls'`);
check('app role deepwell_rls is not superuser / BYPASSRLS', role.rows[0] && !role.rows[0].rolsuper && !role.rows[0].rolbypassrls, JSON.stringify(role.rows));
// SECURITY DEFINER functions + whether granted to app role
const fns = await h.lite.query(`SELECT proname, prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND prosecdef ORDER BY 1`);
console.log('SECURITY DEFINER fns:', fns.rows.map(r=>r.proname).join(','));
console.log(failures ? `${failures} FAILED` : 'ALL PASS');
process.exit(failures?1:0);
