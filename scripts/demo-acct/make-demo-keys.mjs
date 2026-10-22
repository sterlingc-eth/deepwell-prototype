#!/usr/bin/env node
/**
 * Make the six demo import keys WITHOUT typing them anywhere: run this on your own computer.
 *
 *   node scripts/demo-acct/make-demo-keys.mjs --out "C:\Users\<you>\Documents\deepwell-demo-keys"
 *
 * It writes two files into --out (a folder OUTSIDE the repo, which it refuses):
 *   D1b-demo-import-keys.sql   paste into the Neon SQL editor (same branch you ran D1 on). It stores only each key's
 *                              sha256 hash, for the six demo companies only (it stops if a company is not a demo company).
 *   demo-keys.ps1              PowerShell: `. .\demo-keys.ps1` sets DEEPWELL_DEMO_KEY_<INDUSTRY> for this window only.
 * Nothing is printed. The keys work only while D1's loading window is open; D2 revokes them. Delete the folder afterwards.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const i = process.argv.indexOf('--out');
const out = i > 0 ? path.resolve(process.argv[i + 1] ?? '') : null;
if (!out) { console.error('--out <folder outside the repo> is required'); process.exit(2); }
if (out === ROOT || out.startsWith(ROOT + path.sep)) { console.error('Choose a folder OUTSIDE the repo, so keys can never be committed.'); process.exit(2); }
fs.mkdirSync(out, { recursive: true });

const SLUGS = ['realestate', 'propmgmt', 'hvac', 'plumbing', 'electrical', 'contractors'];
const rows = SLUGS.map((slug) => {
  const raw = 'dw_' + 'live_' + crypto.randomBytes(32).toString('hex');
  return { slug, raw, hash: crypto.createHash('sha256').update(raw).digest('hex'), prefix: raw.slice(8, 16) };
});

const sql = `-- D1b-demo-import-keys.sql (made ${new Date().toISOString()} by scripts/demo-acct/make-demo-keys.mjs)
-- One import key per demo company (scopes ingest, read, ask), stored as a hash only. Paste into the Neon SQL editor on
-- the SAME branch you ran D1 on. Stops without changing anything if a demo company is missing.
DO $keys$
DECLARE
  v_rows text[][] := ARRAY[
${rows.map((r) => `    ARRAY['${r.slug}', '${r.hash}', '${r.prefix}']`).join(',\n')}
  ];
  r text[];
  v_id uuid;
BEGIN
  FOREACH r SLICE 1 IN ARRAY v_rows LOOP
    SELECT id INTO v_id FROM tenants WHERE plan = 'demo' AND billing_status = 'demo' AND limits -> 'demo' ->> 'slug' = r[1];
    IF v_id IS NULL THEN RAISE EXCEPTION 'Nothing was changed: no demo company for "%" yet. Run D1 first.', r[1]; END IF;
    INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash, scopes, created_by)
    VALUES (v_id, 'Demo sample-data loading key', r[3], r[2], ARRAY['ingest', 'read', 'ask'], 'demo-setup');
  END LOOP;
END
$keys$;
SELECT t.limits -> 'demo' ->> 'industry' AS industry, k.key_prefix, k.scopes, k.created_at
  FROM api_keys k JOIN tenants t ON t.id = k.tenant_id
 WHERE t.plan = 'demo' AND k.revoked_at IS NULL ORDER BY 1;
`;
fs.writeFileSync(path.join(out, 'D1b-demo-import-keys.sql'), sql);
const ps1 = `# Demo import keys - this PowerShell window only. Usage:  . .\\demo-keys.ps1
${rows.map((r) => `$env:DEEPWELL_DEMO_KEY_${r.slug.toUpperCase()} = "${r.raw}"`).join('\n')}
Write-Host "Demo keys set for this window (6)."
`;
fs.writeFileSync(path.join(out, 'demo-keys.ps1'), ps1, { mode: 0o600 });
const sh = `# Demo import keys - this shell only. Usage:  source ./demo-keys.sh
${rows.map((r) => `export DEEPWELL_DEMO_KEY_${r.slug.toUpperCase()}="${r.raw}"`).join('\n')}
`;
fs.writeFileSync(path.join(out, 'demo-keys.sh'), sh, { mode: 0o600 });
console.log(`Wrote D1b-demo-import-keys.sql, demo-keys.ps1 and demo-keys.sh to ${out}. Paste the SQL into Neon, then load the keys file in the window you run the seeding from.`);
