// Round 22 (independent review) — CSP-vs-real-app-needs regression test.
//
// vercel.json's Content-Security-Policy is a static, hand-written allowlist. It is trivially easy
// to get "secure-looking" and still silently break real product features, because a missing origin
// in a fetch-directive fails CLOSED with no visible error anywhere except the browser console (no
// build failure, no server error, no test in the existing suites touches it). This script asserts,
// against a real headless browser enforcing the CURRENT policy from vercel.json, that every origin
// the shipped app actually needs is allowed — by reproducing the exact DOM operations the app
// performs (verified by reading the source, not guessed):
//
//   - DocumentPreview.tsx renders a PDF original via `<iframe src={r2PresignedUrl}>` — needs
//     the R2 host in frame-src (object-src 'none' does NOT cover this; frame-src does).
//   - DocumentPreview.tsx also renders images via `<img src={r2PresignedUrl}>` — img-src.
//   - ScanTab.tsx / SerialCapture.tsx preview a just-captured photo via
//     `<img src={URL.createObjectURL(file)}>` (a blob: URL) before it's ever uploaded — img-src
//     needs `blob:`, which plain `data:`/`https:` does not cover.
//   - Clerk's Frontend API (`connect-src`) and its bot-challenge iframe (`frame-src`).
//
// This is a static-server + Playwright check (no live network to real Clerk/R2 needed) — it proves
// the POLICY allows the request, not that the remote host is reachable from this sandbox.
//
//   node scripts/verify-csp-app-needs.mjs
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const vercelConfig = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
const cspHeader = vercelConfig.headers?.[0]?.headers?.find((h) => h.key === 'Content-Security-Policy')?.value;

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};

check('vercel.json has a Content-Security-Policy on the catch-all route', !!cspHeader);
if (!cspHeader) {
  console.log('\nCannot continue without a CSP header.');
  process.exit(1);
}

const html = `<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>`;
const server = http.createServer((_req, res) => {
  res.setHeader('Content-Security-Policy', cspHeader);
  res.setHeader('Content-Type', 'text/html');
  res.end(html);
});
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage();
const violations = [];
page.on('console', (m) => {
  if (m.type() === 'error' && /Content Security Policy directive/.test(m.text())) violations.push(m.text());
});
await page.goto(`http://localhost:${port}/`);

// A blob: URL always resolves same-origin-ish and doesn't need network egress to test for real.
await page.evaluate(() => {
  const blob = new Blob(['x'], { type: 'image/png' });
  const img = document.createElement('img');
  img.src = URL.createObjectURL(blob);
  document.body.appendChild(img);
});

// R2 / Clerk / Turnstile are cross-origin: the request itself may fail (no egress in CI/sandbox),
// but a CSP block happens BEFORE any network attempt and always logs its own distinct console error
// ("Refused to ... because it violates ... Content Security Policy directive"), so we can tell a
// policy block apart from a network failure by message shape, not by whether the fetch succeeded.
await page.evaluate(() => {
  const iframe = document.createElement('iframe');
  iframe.src = 'https://deadbeef00.r2.cloudflarestorage.com/tenant-id/doc.pdf?X-Amz-Signature=x';
  document.body.appendChild(iframe);

  const r2Img = document.createElement('img');
  r2Img.src = 'https://deadbeef00.r2.cloudflarestorage.com/tenant-id/photo.jpg?X-Amz-Signature=x';
  document.body.appendChild(r2Img);

  const turnstile = document.createElement('iframe');
  turnstile.src = 'https://challenges.cloudflare.com/turnstile/v0/x';
  document.body.appendChild(turnstile);
});
await page.evaluate(() =>
  fetch('https://some-tenant.clerk.accounts.dev/v1/client', { mode: 'no-cors' }).catch(() => {})
);
await page.waitForTimeout(1000);
await browser.close();
server.close();

const blocked = (needle) => violations.find((v) => v.includes(needle));

check('blob: image preview (mobile scan capture) not blocked by img-src', !violations.some((v) => v.startsWith('Refused to load the image') && v.includes('blob:')));
check('R2 presigned PDF iframe (DocumentPreview.tsx) not blocked by frame-src', !blocked('r2.cloudflarestorage.com') || !blocked("frame 'https"));
check('R2 presigned image (DocumentPreview.tsx) not blocked by img-src', !violations.some((v) => v.startsWith('Refused to load the image') && v.includes('r2.cloudflarestorage.com')));
// Turnstile's own response sets a strict `frame-ancestors` itself (Cloudflare only allows framing
// from domains registered to that Turnstile site key) — that fires even framing it from a bare
// `data:` page with NO CSP at all (verified separately), so it can't be used to test OUR policy from
// this sandbox (no real site key, no network egress to a registered origin). Skipped, not asserted.
check('Clerk Frontend API fetch not blocked by connect-src', !violations.some((v) => v.startsWith('Refused to connect') && v.includes('clerk.accounts.dev')));

if (violations.length) {
  console.log('\nRaw CSP console errors seen:');
  for (const v of violations) console.log('  -', v);
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
