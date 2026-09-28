/**
 * Round 22 (S1, security & privacy audit): a handful of cheap, static, offline checks meant to catch
 * the specific classes of regression the audit found and fixed — never a substitute for the real
 * suites (verify-auth, verify-apikeys, verify-tenant-isolation, ...), which still exercise the actual
 * logic. This file only ever reads source text and (optionally) a built dist/; no database, no
 * network, no model calls.
 *
 *   node scripts/verify-security.mjs
 *
 * 1. Route auth inventory — every HTTP-reachable handler under api/ either calls one of the known
 *    auth primitives (requireAuth / requireAuthOrKey / the cron-sweep CRON_SECRET check) somewhere in
 *    its own file, is a pure dispatcher that hands the request to another already-inventoried handler
 *    and does no work of its own, or is named in ALLOWLIST with a `reason` explaining why it is
 *    intentionally open. Adding a new file to api/ or api/_lib/routes/ without any of the three is a
 *    FAIL, on purpose — the fix is either to add the auth call or to extend the inventory below with a
 *    reason, never to silently pass.
 * 2. vercel.json's headers block covers the required security headers on the catch-all route.
 * 3. If dist/ exists (this script does not build it — run `npm run build` first, as the finishing
 *    checklist already does), no built client asset contains a live-looking secret pattern.
 * 4. SQL param lint — no `db.raw(` / `.raw(` / a bare `.query(` template literal in api/ interpolates
 *    `req.`, `query.`, `body.`, or `params.` directly into the SQL text. Every legitimate value from a
 *    request has to go in as a `$1`-style bind parameter; this is the one shape that is never fine.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const path = (...p) => join(ROOT, ...p);

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};

/* ============================================================ 1. route auth inventory */

// Every file directly under api/ that Vercel serves as its own function, and every file under
// api/_lib/routes/ (+ the two lib/*/route.js siblings) that account.js's ACTIONS or api/v1.js's
// RESOURCES dispatches a request to. Kept as a flat list rather than parsed out of those two files'
// object literals — this is a security fixture, and a hand-maintained list that must be updated
// alongside a real dispatch-table change is the point, not a maintenance shortcut to route around.
const TOP_LEVEL = [
  'api/account.js', 'api/ask.js', 'api/billing.js', 'api/document-status.js', 'api/extract.js',
  'api/inngest.js', 'api/read-document.js', 'api/review.js', 'api/upload-url.js', 'api/v1.js',
  'api/warranty-attention.js',
];
const DISPATCH_TARGETS = [
  // api/account.js ACTIONS
  'api/_lib/routes/keys.js', 'api/_lib/routes/tenant-export.js', 'api/_lib/routes/tenant-delete.js',
  'api/_lib/routes/cron-sweep.js', 'api/_lib/routes/merge-tenant.js', 'api/_lib/routes/notifications.js',
  'api/_lib/routes/outreach.js', 'api/_lib/routes/followups.js', 'api/_lib/routes/expenses.js',
  'api/_lib/routes/financials.js', 'api/_lib/routes/graph.js', 'api/_lib/routes/entity-merge.js',
  'api/_lib/routes/naming.js', 'api/_lib/routes/intake-resolve.js', 'api/_lib/grid/route.js',
  'api/_lib/routes/ask-suggest.js', 'api/_lib/routes/unit-address-backfill.js',
  'api/_lib/routes/insights.js', 'api/_lib/audience/route.js',
  // api/v1.js RESOURCES
  'api/_lib/routes/v1-equipment.js', 'api/_lib/routes/v1-warranty.js', 'api/_lib/routes/v1-ingest.js',
  'api/_lib/routes/customer-equipment.js', 'api/_lib/routes/customers.js',
  'api/_lib/routes/export-csv.js', 'api/_lib/routes/v1-graph.js', 'api/_lib/routes/intake-status.js',
];

// file -> why it needs no auth call of its own. Every entry here is a deliberate, reviewed exception —
// see R22 SECURITY_AUDIT for the reasoning behind each. A file in ALLOWLIST is never also expected to
// contain an auth call; everything else in TOP_LEVEL/DISPATCH_TARGETS is.
const ALLOWLIST = {
  'api/account.js': 'pure dispatcher — hands off to ACTIONS[...], each of which is itself inventoried and auth-checked here',
  'api/v1.js': 'pure dispatcher — hands off to RESOURCES[...], each of which is itself inventoried and auth-checked here',
  'api/inngest.js': 'not Clerk-gated by design — verifies INNGEST_SIGNING_KEY itself (fails closed with none set); see its own header comment for the accepted introspection-GET exposure',
};

const AUTH_MARKERS = [
  'requireAuth(', 'requireAuthOrKey(',
  // cron-sweep.js's own bespoke, CRON_SECRET-based scheme (Vercel Cron's own auth pattern) —
  // never Clerk, and correctly so; see that file's own doc comment.
  'isValidCronAuth(',
];

function fileHasAuthMarker(relPath) {
  const abs = path(relPath);
  if (!existsSync(abs)) return { ok: false, reason: 'file does not exist' };
  const src = readFileSync(abs, 'utf8');
  const hit = AUTH_MARKERS.some((m) => src.includes(m));
  return { ok: hit };
}

for (const f of [...TOP_LEVEL, ...DISPATCH_TARGETS]) {
  if (ALLOWLIST[f]) continue;
  const { ok, reason } = fileHasAuthMarker(f);
  check(`auth: ${f}`, ok, reason ?? `no requireAuth/requireAuthOrKey/isValidCronAuth call found — add one, or add ${f} to ALLOWLIST in this script with a reason`);
}

// The inverse check: every file actually present under api/_lib/routes/ (+ the two route.js siblings)
// is accounted for above, in DISPATCH_TARGETS, in ALLOWLIST, or is a documented non-HTTP helper module
// (imported directly by another handler, never dispatched to by account.js/v1.js on its own) — so a
// brand-new route file can't be wired up somewhere and quietly skip this whole inventory.
const KNOWN_HELPER_MODULES = new Set([
  // Reached only via api/review.js (S2-owned operator gating) or as a plain function import from
  // another already-inventoried route (never as their own HTTP dispatch target) — see that file's
  // own auth for the actual gate.
  'api/_lib/routes/document-delete.js', 'api/_lib/routes/integrity.js', 'api/_lib/routes/scorecard.js',
  // Pure/impure helper modules, no default-export HTTP handler at all.
  'api/_lib/routes/analytics.js',
]);
function listRouteFiles(dir) {
  if (!existsSync(path(dir))) return [];
  return readdirSync(path(dir))
    .filter((f) => f.endsWith('.js') && statSync(path(dir, f)).isFile())
    .map((f) => `${dir}/${f}`);
}
const allRouteFiles = [
  ...listRouteFiles('api/_lib/routes'),
  'api/_lib/grid/route.js', 'api/_lib/audience/route.js',
];
const inventoried = new Set([...DISPATCH_TARGETS, ...KNOWN_HELPER_MODULES]);
for (const f of allRouteFiles) {
  check(`inventory covers: ${f}`, inventoried.has(f), 'new route file not in DISPATCH_TARGETS, ALLOWLIST, or KNOWN_HELPER_MODULES in scripts/verify-security.mjs — add it to whichever applies');
}

/* ============================================================ 2. vercel.json headers */

const vercelConfig = JSON.parse(readFileSync(path('vercel.json'), 'utf8'));
const catchAll = (vercelConfig.headers ?? []).find((h) => h.source === '/(.*)');
check('vercel.json has a catch-all headers block', Boolean(catchAll), 'expected one headers entry with source "/(.*)"');
const headerNames = new Set((catchAll?.headers ?? []).map((h) => h.key));
for (const required of [
  'Strict-Transport-Security', 'Content-Security-Policy', 'X-Content-Type-Options',
  'Referrer-Policy', 'Permissions-Policy',
]) {
  check(`vercel.json header present: ${required}`, headerNames.has(required));
}
const csp = (catchAll?.headers ?? []).find((h) => h.key === 'Content-Security-Policy')?.value ?? '';
check('CSP sets frame-ancestors', /frame-ancestors/.test(csp));
// R22 review: production Clerk loads clerk-js + calls its Frontend API from the custom domain
// encoded in the live pk_live_ key (clerk.deepwelltechnology.com). Missing it from script-src
// or connect-src takes sign-in down for every user, so pin it.
const dir = (n) => (csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(n + ' ')) ?? '');
for (const d of ['script-src', 'connect-src', 'frame-src']) check(`CSP ${d} allows production Clerk (clerk.deepwelltechnology.com)`, dir(d).includes('https://clerk.deepwelltechnology.com'));
check('CSP worker-src allows blob: (Clerk workers)', /\bblob:/.test(dir('worker-src')));
check('CSP img-src allows blob: (scan photo previews)', /\bblob:/.test(dir('img-src')));
check('CSP sets object-src \'none\'', /object-src\s+'none'/.test(csp));
check('CSP sets base-uri', /base-uri/.test(csp));
// X-Frame-Options: either on the catch-all, or (equivalently, and more precisely) via CSP
// frame-ancestors — accept either so a future round tightening one doesn't spuriously fail the other.
check('clickjacking defense present (X-Frame-Options or CSP frame-ancestors)', headerNames.has('X-Frame-Options') || /frame-ancestors/.test(csp));

/* ============================================================ 3. built bundle has no secrets */

const distDir = path('dist');
if (!existsSync(distDir)) {
  console.log('SKIP  dist/ secret scan — no dist/ (run `npm run build` first; the finishing checklist already does)');
} else {
  const SECRET_PATTERNS = [
    { name: 'Stripe live/test secret key', re: /sk_(live|test)_[A-Za-z0-9]{10,}/ },
    { name: 'Anthropic API key', re: /sk-ant-[A-Za-z0-9_-]{10,}/ },
    { name: 'AWS-style access key id', re: /AKIA[0-9A-Z]{12,}/ },
    { name: 'PEM private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    { name: 'Stripe webhook signing secret', re: /whsec_[A-Za-z0-9]{10,}/ },
    { name: 'Clerk secret key', re: /sk_(live|test)_clerk|CLERK_SECRET_KEY\s*[:=]\s*["'][^"']{10,}/i },
    { name: 'Postgres connection string with credentials', re: /postgres(?:ql)?:\/\/[^\s"'/]+:[^\s"'/]+@/ },
    { name: 'R2/AWS secret access key literal', re: /R2_SECRET_ACCESS_KEY["']?\s*[:=]\s*["'][A-Za-z0-9/+=]{20,}/i },
  ];
  function walk(dir) {
    let out = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) out = out.concat(walk(full));
      else if (/\.(js|mjs|html|css|json|map)$/.test(entry)) out.push(full);
    }
    return out;
  }
  const files = walk(distDir);
  let hit = null;
  outer: for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const p of SECRET_PATTERNS) {
      const m = p.re.exec(text);
      if (m) { hit = `${p.name} in ${relative(ROOT, f)}: ...${text.slice(Math.max(0, m.index - 20), m.index + 40)}...`; break outer; }
    }
  }
  check(`dist/ (${files.length} files) has no secret-shaped strings`, !hit, hit ?? '');
}

/* ============================================================ 4. SQL param lint */

function walkJs(dir) {
  let out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out = out.concat(walkJs(full));
    else if (entry.endsWith('.js') || entry.endsWith('.ts')) out.push(full);
  }
  return out;
}
const DANGEROUS_INTERP = /\.(?:raw|query)\(\s*`[^`]*\$\{\s*(req|query|body|params)\.[^}]*\}/gs;
let sqlLintHits = [];
for (const f of walkJs(path('api'))) {
  const src = readFileSync(f, 'utf8');
  const matches = [...src.matchAll(DANGEROUS_INTERP)];
  if (matches.length) sqlLintHits.push({ file: relative(ROOT, f), count: matches.length, sample: matches[0][0].slice(0, 120) });
}
check(
  'no request field interpolated directly into a db.raw()/.query() template literal',
  sqlLintHits.length === 0,
  sqlLintHits.map((h) => `${h.file} (${h.count}): ${h.sample}`).join('\n      ')
);

/* ------------------------------------------------------------------ done */

console.log('');
if (failures) {
  console.log(`${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log('All checks passed.');
