/**
 * Round 16 D1 #7 (F4): cold-start regression guard for api/ask.js.
 *
 * The audit measured a plain `import('./api/ask.js')` — before a single request is even
 * handled — at ~250-290ms, ~130ms of it @anthropic-ai/sdk alone, because ask.js statically
 * imported the SDK directly plus several "model-only" siblings (agent/loop.js, agent/loopV2.js,
 * routes/analytics.js, financials/moneyGate.js, learning/replay.js, agent/fastReplay.js) that
 * themselves pull the SDK in transitively — paid on every cold invocation even for a request a
 * deterministic pre-router branch (meta/relations/deterministic/decompose/fast-path/contact/
 * doc-lookup/content-count/money) answers without ever touching the model. Those are now behind
 * dynamic import() calls (cached module-level, see ask.js's loadXModule() helpers), resolved only
 * the first time a request actually reaches a call site that needs them.
 *
 * A wall-clock timing assertion here would be flaky (shared CI runners, disk cache state, GC
 * pauses). Instead this asserts the one thing that's actually deterministic and unaffected by any
 * of that: statically walk ask.js's own import graph (following only relative `import ... from`
 * declarations — a dynamic `import()` call inside a function body is exactly the escape hatch this
 * fix uses, and is correctly NOT followed) and fail if @anthropic-ai/sdk (or any of the specific
 * modules known to pull it in) is reachable. This can never flake: it either finds the string in
 * the file text or it doesn't, on every run, every machine.
 *
 * A live dynamic import + a custom loader hook (belt-and-suspenders — confirms Node's REAL module
 * resolver agrees with the static walk, not just this script's own regex) and a plain wall-clock
 * timing sample are also run and printed, informational only (never gate pass/fail — see above).
 *
 *   node scripts/verify-cold-start.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASK_JS = path.join(ROOT, 'api', 'ask.js');

/* ================================================================== 1. static import-graph walk */
// Only static `import ... from "spec"` declarations are followed (a dynamic import(...) call has
// no `from` before the string and is not matched here — that's the point: it's the deferred path).
const STATIC_IMPORT_RE = /^\s*import\s+(?:[\s\S]*?\bfrom\s+)?["']([^"']+)["']/gm;
const BLOCKED_BARE_SPECIFIERS = new Set(['@anthropic-ai/sdk']);

function resolveRelative(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const c of [base, `${base}.js`, `${base}.mjs`, path.join(base, 'index.js')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

function walkStaticGraph(entry) {
  const visited = new Set();
  const hits = []; // {chain: [file,...], specifier}
  (function walk(file, chain) {
    if (visited.has(file)) return;
    visited.add(file);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
    let m;
    STATIC_IMPORT_RE.lastIndex = 0;
    while ((m = STATIC_IMPORT_RE.exec(text))) {
      const spec = m[1];
      if (BLOCKED_BARE_SPECIFIERS.has(spec)) {
        hits.push({ chain: [...chain, file], specifier: spec });
        continue;
      }
      if (!spec.startsWith('.')) continue; // other bare package: not walked, can't reach the SDK's own source this way
      const resolved = resolveRelative(file, spec);
      if (resolved) walk(resolved, [...chain, file]);
    }
  })(entry, []);
  return { visited, hits };
}

const { visited, hits } = walkStaticGraph(ASK_JS);
check(
  '@anthropic-ai/sdk is not statically reachable from api/ask.js',
  hits.length === 0,
  hits.map((h) => `${h.specifier} via ${h.chain.map((f) => path.relative(ROOT, f)).join(' -> ')}`).join('\n      ')
);
console.log(`      (static walk visited ${visited.size} files reachable from api/ask.js via static imports)`);

// Belt-and-suspenders: the specific modules this round moved behind dynamic import() must not be
// back in ask.js's own top-of-file static import list (the regression this whole check exists for).
const askText = fs.readFileSync(ASK_JS, 'utf8');
const topOfFile = askText.slice(0, askText.indexOf('\nasync function') === -1 ? askText.length : askText.indexOf('\nasync function'));
const MUST_STAY_DYNAMIC = [
  '@anthropic-ai/sdk',
  './_lib/agent/loop.js',
  './_lib/agent/loopV2.js',
  './_lib/agent/fastReplay.js',
  './_lib/routes/analytics.js',
  './_lib/financials/moneyGate.js',
  './_lib/learning/replay.js',
];
for (const spec of MUST_STAY_DYNAMIC) {
  const staticRe = new RegExp(`^\\s*import\\s+[\\s\\S]*?\\bfrom\\s+["']${spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'm');
  check(`${spec} is not a static top-of-file import in ask.js`, !staticRe.test(topOfFile));
}

/* ================================================================== 2. informational: live resolver + timing */
const hookSrc = `export async function resolve(s,c,n){if(s.includes('@anthropic-ai/sdk'))console.error('SDK_RESOLVED:'+s);return n(s,c);}`;
const hookPath = path.join(ROOT, '.verify-cold-start-hook.mjs');
fs.writeFileSync(hookPath, hookSrc);
try {
  const runOne = () => {
    const t0 = Date.now();
    const res = spawnSync(process.execPath, [
      '--experimental-loader', hookPath,
      '-e', `import('./${path.relative(ROOT, ASK_JS)}').then(()=>{}).catch((e)=>{console.error(e); process.exit(1);})`,
    ], { cwd: ROOT, encoding: 'utf8' });
    const ms = Date.now() - t0;
    return { ms, stderr: res.stderr ?? '', status: res.status };
  };
  const samples = [runOne(), runOne(), runOne()];
  const sdkResolvedLive = samples.some((s) => s.stderr.includes('SDK_RESOLVED'));
  check(
    'live resolver hook confirms @anthropic-ai/sdk is never resolved importing api/ask.js',
    !sdkResolvedLive,
    samples.map((s) => s.stderr).filter(Boolean).join('\n')
  );
  const anyFailedToImport = samples.some((s) => s.status !== 0);
  check('a plain `import(\'./api/ask.js\')` still succeeds (no accidental breakage)', !anyFailedToImport);
  console.log(
    `      informational only, not gated (process spin-up dominates; see this file's own doc comment): ` +
    `cold import samples = [${samples.map((s) => s.ms).join(', ')}] ms`
  );
} finally {
  fs.rmSync(hookPath, { force: true });
}

/* ================================================================== summary */
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
