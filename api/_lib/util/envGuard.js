/**
 * Should api/_lib/claude.js read `.env.local` into process.env?
 *
 * `.env.local` exists so `vercel dev` / a local `node` session finds its keys (Vercel does not reliably inject
 * it into functions there). It is a hazard everywhere else: a verify script that happens to import claude.js
 * (almost all of them do) inherited the developer's REAL Neon / Clerk / Stripe / Anthropic credentials and, given
 * network, could touch real services (R30 audit: verify-scale saw a cached real pool; verify-prod-hardening hit
 * Clerk). Tests must be hermetic, so:
 *
 *   - never on Vercel (VERCEL is set on every deployment; the platform env is the only source there);
 *   - never when the entry script is ANY file under scripts/ (R34: offline-exam.mjs / live-test-day.mjs / model-ab.mjs
 *     are not verify-* files, so they used to load .env.local — and with it SENTRY_DSN — and reported mocked failures
 *     to production Sentry), or npm is running a verify:* script;
 *   - never when DEEPWELL_SKIP_ENV_LOCAL=1;
 *   - an explicit DEEPWELL_LOAD_ENV_LOCAL=1 wins over the scripts rule (deliberate live run), but not over
 *     VERCEL. Even then Sentry stays silent for a script unless SENTRY_FORCE=1 (telemetryDisabledReason below).
 *
 * Pure (env/argv injected) so scripts/verify-r30-audit-fixes.mjs can test it.
 * @param {{env?: Record<string,string|undefined>, argv?: string[]}} [deps]
 * @returns {boolean}
 */
export function shouldLoadEnvLocal({ env = process.env, argv = process.argv } = {}) {
  if (env.VERCEL) return false;
  if (env.DEEPWELL_SKIP_ENV_LOCAL === "1") return false;
  if (env.DEEPWELL_LOAD_ENV_LOCAL === "1") return true;
  const entry = String(argv?.[1] ?? "").replace(/\\/g, "/");
  if (/(^|\/)scripts\//.test(entry)) return false;
  if (/^verify(:|-)/.test(String(env.npm_lifecycle_event ?? ""))) return false;
  return true;
}

/* ========================================================================================================
 * R34 observability hygiene: WHEN may this process talk to Sentry?
 *
 * 13 unresolved production Sentry issues were all test runs (offline-exam's "model calls are disabled",
 * verify-prod-hardening's mocked 400/429/500/529, live-test-day's mocked outage, ...): a developer shell
 * (or .env.local, loaded by a non-verify script such as offline-exam.mjs) had SENTRY_DSN, and every mocked
 * failure was reported to the PRODUCTION project. Sentry now reports only from a real Vercel deployment.
 * ====================================================================================================== */

/** Env flags that mean "this is a test / offline / mocked run" (scripts set them; a Vercel deployment never does). */
export const MOCK_RUN_FLAGS = Object.freeze([
  "OFFLINE_EXAM",
  "DEEPWELL_OFFLINE_EXAM",
  "DEEPWELL_MOCK_MODEL",
  "DEEPWELL_TEST",
  "DEEPWELL_TELEMETRY_OFF", // set at runtime by markMockRun() (installModelBlock / installMockAnthropicClient / verify scripts)
  "EXAM_TODAY",
  "DONOVAN_EXAM_TZ",
]);

const SENTRY_ENVIRONMENTS = new Set(["production", "preview"]);

/**
 * Why Sentry must stay silent in this process, or null when reporting is allowed. Pure (env/argv injected) so
 * scripts/verify-r34-telemetry.mjs can test every branch. Order matters: SENTRY_FORCE=1 (a deliberate live test)
 * beats everything; then explicit test/mock signals; then "not a real Vercel deployment" (the catch-all, so a
 * developer shell that merely HAS a DSN never reports).
 * @param {{env?: Record<string,string|undefined>, argv?: string[]}} [deps]
 * @returns {string|null}
 */
export function telemetryDisabledReason({ env = process.env, argv = process.argv } = {}) {
  if (env.SENTRY_FORCE === "1") return null;
  if (env.NODE_ENV === "test") return "node-env-test";
  for (const flag of MOCK_RUN_FLAGS) {
    if (env[flag] != null && env[flag] !== "" && env[flag] !== "0") return `mock-flag:${flag}`;
  }
  const entry = String(argv?.[1] ?? "").replace(/\\/g, "/");
  if (/(^|\/)scripts\//.test(entry)) return "script-entrypoint";
  if (/^(verify|test|eval)(:|-)/.test(String(env.npm_lifecycle_event ?? ""))) return "npm-test-script";
  if (!SENTRY_ENVIRONMENTS.has(String(env.VERCEL_ENV ?? ""))) return "not-a-vercel-deployment";
  return null;
}

/** Called by every offline/mocked harness right after it stubs the model: from now on this process never reports. */
export function markMockRun() {
  process.env.DEEPWELL_TELEMETRY_OFF = "1";
}

/** Errors thrown by test doubles carry `isMock = true`; a few legacy fixtures are recognised by message. */
export function isMockError(err) {
  if (!err) return false;
  if (err.isMock === true) return true;
  const msg = typeof err === "string" ? err : String(err.message ?? "");
  return /\(mocked\b|Anthropic client mocked|model calls are disabled/i.test(msg);
}

/** Tag an error as test-double-made (so even a stray report is dropped by telemetry's beforeSend). Returns the error. */
export function tagMock(err) {
  if (err && typeof err === "object") err.isMock = true;
  return err;
}
