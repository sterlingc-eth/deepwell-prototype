#!/usr/bin/env node
/**
 * ROUND 34 — observability hygiene. The production Sentry org had 13 unresolved issues, nearly all produced by
 * TEST runs that inherited a SENTRY_DSN (offline-exam's mocked "model calls are disabled" x3,189, verify-prod-hardening's
 * mocked 400/429/500/529, live-test-day's mocked outage). This suite proves:
 *   1. Sentry reports only from a real Vercel deployment (production|preview) or with SENTRY_FORCE=1; never under
 *      NODE_ENV=test, a mock/offline flag, or a scripts/ entry point (pure branch tests of telemetryDisabledReason).
 *   2. Mock-made errors are dropped by beforeSend even when everything else says "report" (belt and braces).
 *   3. The cron-sweep summary is info (log + breadcrumb), an error-level event only when documents were NOT recovered.
 *   4. Config errors (R2 not configured) reach Sentry once per cold start, tagged kind=config.
 *   5. `.env.local` is never auto-loaded by anything under scripts/ (R30 envGuard, widened in R34).
 *   6. Browser crash reports only leave production hostnames.
 *   7. Representative scripts (offline-exam, verify-prod-hardening, verify-live-test-day) run with a FAKE SENTRY_DSN
 *      (and even VERCEL_ENV=production leaked into the shell) and make ZERO Sentry sends — measured with a stubbed
 *      transport (scripts/lib/sentry-sink.mjs), whose positive controls prove the stub does see real sends.
 *
 *   tsx scripts/verify-r34-telemetry.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { telemetryDisabledReason, shouldLoadEnvLocal, isMockError, markMockRun } from "../api/_lib/util/envGuard.js";
import { scrubSentryEvent, gateSentryEvent } from "../api/_lib/telemetry.js";
import { isProductionHost, reportingAllowed, PRODUCTION_HOSTS } from "../src/services/errorReporter.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
let failures = 0;
let passes = 0;
const check = (name, ok, detail = "") => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
};

const FAKE_DSN = "https://fakepublickey@o000000.ingest.sentry.io/0000000";
const SCRIPT = ["node", "/repo/scripts/offline-exam.mjs"];
const dev = (env, argv = ["node", "/repo/dev-server.js"]) => telemetryDisabledReason({ env, argv });

/* ================================================== 1. when may Sentry report? (pure) */
check("deployment: VERCEL_ENV=production reports", dev({ VERCEL_ENV: "production" }) === null);
check("deployment: VERCEL_ENV=preview reports", dev({ VERCEL_ENV: "preview" }) === null);
check("developer shell (no VERCEL_ENV) never reports, even with a DSN", dev({ SENTRY_DSN: FAKE_DSN }) === "not-a-vercel-deployment");
check("VERCEL_ENV=development (vercel dev / env pull) never reports", dev({ VERCEL_ENV: "development" }) === "not-a-vercel-deployment");
check("NODE_ENV=test never reports, even with VERCEL_ENV=production", dev({ VERCEL_ENV: "production", NODE_ENV: "test" }) === "node-env-test");
for (const flag of ["OFFLINE_EXAM", "DEEPWELL_OFFLINE_EXAM", "DEEPWELL_MOCK_MODEL", "DEEPWELL_TEST", "DEEPWELL_TELEMETRY_OFF", "EXAM_TODAY", "DONOVAN_EXAM_TZ"]) {
  check(`mock/offline flag ${flag} silences Sentry even in production`, /^mock-flag:/.test(dev({ VERCEL_ENV: "production", [flag]: "1" }) ?? ""));
}
check("a flag set to 0 does not silence", dev({ VERCEL_ENV: "production", OFFLINE_EXAM: "0" }) === null);
check("scripts/ entry point never reports (offline-exam / live-test-day / verify-*)", ["scripts/offline-exam.mjs", "/repo/scripts/live-test-day.mjs", "C:\\repo\\scripts\\verify-x.mjs", "/repo/scripts/lib/x.mjs"].every((e) => dev({ VERCEL_ENV: "production" }, ["node", e]) === "script-entrypoint"));
check("npm verify:* lifecycle never reports", dev({ VERCEL_ENV: "production", npm_lifecycle_event: "verify:ops" }) === "npm-test-script");
check("SENTRY_FORCE=1 overrides everything (deliberate live test)", dev({ SENTRY_FORCE: "1", NODE_ENV: "test", EXAM_TODAY: "2026-09-25" }, SCRIPT) === null);
check("this very process (a scripts/ entry) is silenced", telemetryDisabledReason() !== null);

/* ================================================== 2. mock errors are dropped by beforeSend */
const mockEvt = { exception: { values: [{ type: "Error", value: "offline-exam: model calls are disabled for this run (Anthropic client mocked)" }] } };
const realEvt = { exception: { values: [{ type: "Error", value: "relation does not exist" }] }, tags: { route: "/api/ask" } };
check("isMockError: isMock flag / '(mocked' / 'Anthropic client mocked' / 'model calls are disabled'", isMockError(Object.assign(new Error("x"), { isMock: true })) && isMockError(new Error("Overloaded (mocked live-test-day scenario)")) && isMockError(new Error(mockEvt.exception.values[0].value)) && !isMockError(new Error("relation does not exist")) && !isMockError(null));
// beforeSend path is exercised for real in the child-process section; here pin the pure gate with force on (so the
// env/argv rule does not mask the mock rules) and the scrubbing contract (verify-privacy covers it in depth).
process.env.SENTRY_FORCE = "1";
check("gate: mock-flagged original exception is dropped", gateSentryEvent(realEvt, { originalException: Object.assign(new Error("x"), { isMock: true }) }) === null);
check("gate: '(mocked' message is dropped", gateSentryEvent({ message: "Your credit balance is too low (mocked live-test-day scenario)" }, {}) === null);
delete process.env.SENTRY_FORCE;
check("gate: with no force, a scripts/ entry drops even a real-looking event", gateSentryEvent(realEvt, {}) === null);
check("gate output for a real event still goes through scrubSentryEvent (scrubbing unchanged)", (() => { process.env.SENTRY_FORCE = "1"; const g = gateSentryEvent({ ...realEvt, request: { data: "secret" }, user: { email: "a@b.com" } }, {}); delete process.env.SENTRY_FORCE; return g && !g.request && !g.user && JSON.stringify(g) === JSON.stringify(scrubSentryEvent({ ...realEvt, request: { data: "secret" }, user: { email: "a@b.com" } })); })());

/* ================================================== 3-4. call sites */
const cron = read("api/_lib/routes/cron-sweep.js");
check("cron-sweep: the summary goes through recordInfo (log + breadcrumb), not captureMessage", /await recordInfo\(\s*`cron-sweep:/.test(cron) && !/await captureMessage\(\s*`cron-sweep: \$\{summary\.tenantsChecked\}/.test(cron));
check("cron-sweep: an error-level event only when documents were NOT recovered (stable fingerprint)", /const unrecovered = summary\.stillFailing \+ summary\.budgetDeferredStillFailing;\s*if \(unrecovered > 0\)/.test(cron) && /level: "warning", fingerprint: \["cron-sweep-unrecovered-documents"\]/.test(cron));
check("r2.js: the 'R2 is not configured' error is tagged isConfig (reported once per cold start)", /isConfig: true/.test(read("api/_lib/r2.js")));
const tele = read("api/_lib/telemetry.js");
check("telemetry: environment = VERCEL_ENV, release = VERCEL_GIT_COMMIT_SHA", /environment: process\.env\.VERCEL_ENV \|\| "forced"/.test(tele) && /release: process\.env\.VERCEL_GIT_COMMIT_SHA/.test(tele));
check("telemetry: Sentry is only loaded when telemetryEnabled() (no import, no client, no network otherwise)", /async function getSentry\(\) \{\s*if \(!telemetryEnabled\(\)\) return null;/.test(tele));
check("every Sentry call site routes through telemetry.js (no direct @sentry import elsewhere)", (() => {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) { const rel = `${d}/${e.name}`; if (e.isDirectory()) walk(rel); else if (/\.(js|ts|tsx|mjs)$/.test(e.name) && /@sentry\//.test(read(rel)) && rel !== "api/_lib/telemetry.js") out.push(rel); } };
  walk("api"); walk("src");
  return out.length === 0;
})());

/* ================================================== 5. .env.local is never auto-loaded by scripts */
for (const s of ["offline-exam.mjs", "live-test-day.mjs", "model-ab.mjs", "verify-prod-hardening.mjs", "run-dialogues.mjs", "lib/x.mjs"]) {
  check(`envGuard: scripts/${s} does not load .env.local`, shouldLoadEnvLocal({ env: {}, argv: ["node", `/repo/scripts/${s}`] }) === false);
}
check("envGuard: a normal dev server still loads it; VERCEL never does; explicit DEEPWELL_LOAD_ENV_LOCAL=1 opts a script back in", shouldLoadEnvLocal({ env: {}, argv: ["node", "/repo/dev.js"] }) === true && shouldLoadEnvLocal({ env: { VERCEL: "1", DEEPWELL_LOAD_ENV_LOCAL: "1" }, argv: ["node", "/repo/dev.js"] }) === false && shouldLoadEnvLocal({ env: { DEEPWELL_LOAD_ENV_LOCAL: "1" }, argv: ["node", "/repo/scripts/live-test-day.mjs"] }) === true);
check("a script that loads .env.local deliberately STILL cannot report to Sentry (needs SENTRY_FORCE=1)", dev({ DEEPWELL_LOAD_ENV_LOCAL: "1", SENTRY_DSN: FAKE_DSN }, ["node", "/repo/scripts/live-test-day.mjs"]) !== null);

/* ================================================== 6. browser reporter */
check("browser: production hostnames report", isProductionHost("deepwelltechnology.com") && isProductionHost("www.deepwelltechnology.com") && isProductionHost("DEEPWELLINC.vercel.app") && PRODUCTION_HOSTS.length === 3);
check("browser: localhost / 127.0.0.1 / previews / lookalikes / empty never report", ["localhost", "127.0.0.1", "[::1]", "deepwell-git-x-team.vercel.app", "evil-deepwelltechnology.com", "deepwelltechnology.com.evil.example", "", null, undefined].every((h) => !isProductionHost(h)));
{
  const g = globalThis;
  const had = "window" in g;
  const prev = g.window;
  g.window = { location: { hostname: "localhost" } };
  const local = reportingAllowed();
  g.window = { location: { hostname: "localhost" }, __DEEPWELL_FORCE_ERROR_REPORT__: true };
  const forced = reportingAllowed();
  g.window = { location: { hostname: "www.deepwelltechnology.com" } };
  const prod = reportingAllowed();
  if (had) g.window = prev; else delete g.window;
  check("browser: reportingAllowed() false on localhost, true on production host, true with the explicit force flag", local === false && prod === true && forced === true);
}
check("browser: maybeReport is gated by reportingAllowed()", /async function maybeReport[^]*?if \(!reportingAllowed\(\)\) return;/.test(read("src/services/errorReporter.ts")));
check("browser: both entry points still install the reporter", /installErrorReporter\('app'/.test(read("src/main.tsx")) && /installErrorReporter\('mobile'/.test(read("src/mobile/main.tsx")));

/* ================================================== 7. zero outbound Sentry sends (stubbed transport) */
const sink = path.join(ROOT, "scripts/lib/sentry-sink.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "r34-"));
const baseEnv = () => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(SENTRY_|VERCEL|EXAM_TODAY$|OFFLINE_EXAM$|DEEPWELL_|NODE_ENV$|npm_lifecycle)/.test(k)) delete env[k];
  return env;
};
/** Run `argv` with the transport stub preloaded; returns { code, hits, out }. */
function run(argv, extraEnv, { timeout = 280000 } = {}) {
  const file = path.join(tmp, `sink-${Math.random().toString(36).slice(2)}.json`);
  const r = spawnSync(process.execPath, ["--import", sink, ...argv], {
    cwd: ROOT, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024,
    env: { ...baseEnv(), R34_SINK_FILE: file, SENTRY_DSN: FAKE_DSN, ...extraEnv },
  });
  let hits = null;
  try { hits = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* no file: the process died before exit handlers */ }
  return { code: r.status, hits, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
const PROBE = `
const t = await import(${JSON.stringify(path.join(ROOT, "api/_lib/telemetry.js"))});
const g = await import(${JSON.stringify(path.join(ROOT, "api/_lib/util/envGuard.js"))});
const c = process.env.CASE;
if (c === "error") await t.captureException(new Error("real production failure"), { route: "/api/ask" });
if (c === "warn") await t.captureMessage("something failed", {}, { level: "warning" });
if (c === "info") await t.recordInfo("cron-sweep: 7 tenant(s) checked, 0 stuck", { route: "/api/cron-sweep" });
if (c === "mockflag") await t.captureException(Object.assign(new Error("Overloaded"), { isMock: true }), {});
if (c === "mockmsg") await t.captureException(new Error("Overloaded (mocked live-test-day scenario)"), {});
if (c === "config") for (let i = 0; i < 3; i++) await t.captureException(Object.assign(new Error("R2 is not configured: missing R2_ACCOUNT_ID"), { isConfig: true }), { route: "/api/upload-url" });
if (c === "frame") console.log("GATE:" + JSON.stringify(t.gateSentryEvent({ exception: { values: [{ value: "boom", stacktrace: { frames: [{ filename: "/repo/api/_lib/claude.js" }, { filename: "/repo/scripts/verify-prod-hardening.mjs" }] } }] } }, {})));
if (c === "frame-real") console.log("GATE:" + JSON.stringify(t.gateSentryEvent({ exception: { values: [{ value: "boom", stacktrace: { frames: [{ filename: "/var/task/api/_lib/claude.js" }] } }] } }, {})?.exception?.values?.[0]?.value));
if (c === "late-mark") { g.markMockRun(); await t.captureException(new Error("after the harness flagged itself"), {}); }
try { const S = await import("@sentry/node"); await S.flush(3000); } catch {}
`;
const probe = (caseName, env) => run(["--input-type=module", "-e", PROBE], { CASE: caseName, ...env }, { timeout: 60000 });
const PROD = { VERCEL_ENV: "production" };
{
  const p1 = probe("error", PROD);
  check("control: a real error in a production deployment IS sent (the stub sees real sends)", (p1.hits?.length ?? 0) >= 1, JSON.stringify(p1.hits) + p1.out.slice(-300));
  const p2 = probe("warn", { VERCEL_ENV: "preview" });
  check("control: a warning-level message in a preview deployment IS sent", (p2.hits?.length ?? 0) >= 1, JSON.stringify(p2.hits));
  check("cron summary as info (recordInfo) sends NO Sentry event (breadcrumb only)", (probe("info", PROD).hits ?? [null]).length === 0);
  check("developer shell with a DSN but no VERCEL_ENV sends nothing", (probe("error", {}).hits ?? [null]).length === 0);
  check("NODE_ENV=test with production env sends nothing", (probe("error", { ...PROD, NODE_ENV: "test" }).hits ?? [null]).length === 0);
  check("EXAM_TODAY (offline exam flag) with production env sends nothing", (probe("error", { ...PROD, EXAM_TODAY: "2026-09-25" }).hits ?? [null]).length === 0);
  check("a mock-flagged error is dropped by beforeSend even in production", (probe("mockflag", PROD).hits ?? [null]).length === 0);
  check("a '(mocked ...)' message is dropped by beforeSend even in production", (probe("mockmsg", PROD).hits ?? [null]).length === 0);
  check("beforeSend: an event whose culprit frame is scripts/verify-* is dropped (child, production env)", /GATE:null/.test(probe("frame", PROD).out) && /GATE:"boom"/.test(probe("frame-real", PROD).out));
  check("a harness that flags itself AFTER telemetry loaded (markMockRun) silences it", (probe("late-mark", PROD).hits ?? [null]).length === 0);
  check("a config error captured 3 times reaches Sentry exactly once per cold start", (probe("config", PROD).hits ?? []).length === 1, JSON.stringify(probe("config", PROD).hits));
  check("SENTRY_FORCE=1 lets a deliberate live test report", (probe("error", { SENTRY_FORCE: "1" }).hits?.length ?? 0) >= 1);
  check("SENTRY_FORCE=1 still drops mock-made errors", (probe("mockflag", { SENTRY_FORCE: "1" }).hits ?? [null]).length === 0);
}

// Representative scripts: fake DSN set, and VERCEL_ENV=production leaked into the shell (the worst case: someone ran
// `vercel env pull` against production). They must still make zero Sentry sends and still pass on their own terms.
// The slow ones run concurrently.
const leaked = { VERCEL_ENV: "production" };
function runAsync(argv, extraEnv, timeoutMs = 280000) {
  return new Promise((resolve) => {
    const file = path.join(tmp, `sink-${Math.random().toString(36).slice(2)}.json`);
    const child = spawn(process.execPath, ["--import", sink, ...argv], { cwd: ROOT, env: { ...baseEnv(), R34_SINK_FILE: file, SENTRY_DSN: FAKE_DSN, ...extraEnv } });
    let out = "";
    child.stdout.on("data", (d) => { out = (out + d).slice(-4000); });
    child.stderr.on("data", (d) => { out = (out + d).slice(-4000); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      let hits = null;
      try { hits = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* process died before its exit handler */ }
      resolve({ code, hits, out });
    });
  });
}
// live-test-day's mocked outage scenarios (credits out / 529 / bad key) thrown by the mock client and reported the way
// handleError reports them. `-e` has no scripts/ argv, so ONLY the mock-client layers (markMockRun + isMock) protect it.
const MOCK_PROBE = `
const { installMockAnthropicClient } = await import(${JSON.stringify(path.join(ROOT, "scripts/lib/mockAnthropicClient.mjs"))});
const t = await import(${JSON.stringify(path.join(ROOT, "api/_lib/telemetry.js"))});
const { default: Anthropic } = await import("@anthropic-ai/sdk");
let thrown = 0;
for (const mode of ["creditsOut", "overloaded", "authError"]) {
  const mock = await installMockAnthropicClient({ mode });
  try { await new Anthropic({ apiKey: "x" }).messages.create({ model: "m", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }); } catch (err) { thrown++; await t.captureException(err, { route: "/api/ask" }); }
  mock.restore();
}
console.log("THROWN:" + thrown);
try { const S = await import("@sentry/node"); await S.flush(3000); } catch {}
`;
const exam = (name, env) => runAsync(["scripts/offline-exam.mjs", "scripts/golden/golden-export.json", path.join(tmp, `${name}.json`), path.join(tmp, `${name}.md`)], { TZ: "America/Phoenix", EXAM_TODAY: "2026-09-25", ...env });
const [ex, ex2, ph, lt, lt2] = await Promise.all([
  exam("o1", leaked),
  exam("o2", {}),
  runAsync(["scripts/verify-prod-hardening.mjs"], leaked),
  runAsync(["--input-type=module", "-e", MOCK_PROBE], leaked, 120000),
  runAsync(["scripts/live-test-day.mjs", "--help"], { ...leaked, DEEPWELL_LOAD_ENV_LOCAL: "1" }, 60000),
]);
check("offline-exam (fake SENTRY_DSN + leaked VERCEL_ENV=production): ran to completion", ex.code === 0 || ex.code === 1, `exit ${ex.code}\n${ex.out.slice(-400)}`);
check("offline-exam: ZERO Sentry sends (3,189 events of DEEPWELL-B came from exactly this run)", Array.isArray(ex.hits) && ex.hits.length === 0, JSON.stringify(ex.hits));
check("offline-exam (fake DSN only): ZERO Sentry sends", Array.isArray(ex2.hits) && ex2.hits.length === 0, JSON.stringify(ex2.hits));
check("verify-prod-hardening (fake DSN + leaked VERCEL_ENV=production): passes with ZERO Sentry sends", ph.code === 0 && Array.isArray(ph.hits) && ph.hits.length === 0, `exit ${ph.code} hits ${JSON.stringify(ph.hits)}\n${ph.out.slice(-400)}`);
check("live-test-day mock client (credits-out / 529 / bad key; fake DSN + leaked VERCEL_ENV=production): 3 mocked failures, ZERO Sentry sends", /THROWN:3/.test(lt.out) && Array.isArray(lt.hits) && lt.hits.length === 0, `exit ${lt.code} hits ${JSON.stringify(lt.hits)}\n${lt.out.slice(-400)}`);
check("live-test-day.mjs directly (even with DEEPWELL_LOAD_ENV_LOCAL=1): zero Sentry sends", Array.isArray(lt2.hits) && lt2.hits.length === 0, JSON.stringify(lt2.hits));
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
