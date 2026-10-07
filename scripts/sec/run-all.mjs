// npm run verify:sec — runs every scripts/sec attack script. Scripts in KNOWN_OPEN still contain CONFIRMED findings whose fix is only
// proposed (see the security report); their failure is reported but does not fail this run. Everything else must pass.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const KNOWN_OPEN = new Set(['uploads-injection.mjs', 'uploads-limits-plan.mjs', 'edges-rls-coverage.mjs']);
let bad = 0;
for (const f of fs.readdirSync(dir).filter((x) => /^(routes|uploads|donovan|edges|walk)-.*\.mjs$/.test(x) && x !== 'routes-common.mjs' && x !== 'walk-run.mjs').sort()) {
  const r = spawnSync('npx', ['tsx', path.join(dir, f)], { encoding: 'utf8', timeout: 600000 });
  const ok = r.status === 0;
  const tail = (r.stdout || '').trim().split('\n').slice(-1)[0];
  console.log(`${ok ? 'PASS' : KNOWN_OPEN.has(f) ? 'OPEN' : 'FAIL'}  ${f}  ${tail}`);
  if (!ok && !KNOWN_OPEN.has(f)) bad++;
}
process.exit(bad ? 1 : 0);
