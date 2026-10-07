/** edges: every table with tenant_id has RLS enabled+forced and exactly one tenant-isolation policy (SECURITY.md claim). */
import { boot, recorder } from './lib/harness.mjs';
const H = await boot(); const R = recorder('edges-rls');
const { rows } = await H.lite.query(`SELECT c.relname, c.relrowsecurity rls, c.relforcerowsecurity frc,
  (SELECT count(*) FROM pg_policy p WHERE p.polrelid=c.oid) pols
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r' AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenant_id' AND NOT a.attisdropped)`);
const bad = rows.filter((r) => !r.rls || !r.frc || Number(r.pols) !== 1);
console.log('tables with tenant_id:', rows.length, 'not ok:', bad.map((b) => `${b.relname}(rls=${b.rls},force=${b.frc},pol=${b.pols})`).join(' '));
R.check('RLS1', `all ${rows.length} tenant_id tables have forced RLS and exactly one policy`, bad.length === 0, { severity: 'Low', route: 'db', detail: bad.map((b) => b.relname).join(',') });
const role = (await H.lite.query("SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname='deepwell_rls'")).rows[0];
R.check('RLS2', 'deepwell_rls has no BYPASSRLS / superuser', role && !role.rolbypassrls && !role.rolsuper, { severity: 'Critical', route: 'db' });
R.finish();
