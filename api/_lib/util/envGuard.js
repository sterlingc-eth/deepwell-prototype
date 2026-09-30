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
 *   - never when the entry script is a scripts/verify-* file, or npm is running a verify:* script;
 *   - never when DEEPWELL_SKIP_ENV_LOCAL=1;
 *   - an explicit DEEPWELL_LOAD_ENV_LOCAL=1 wins over the verify-script rule (deliberate live run), but not over
 *     VERCEL.
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
  if (/(^|\/)scripts\/(?:[^/]*\/)*verify-[^/]*$/.test(entry)) return false;
  if (/^verify(:|-)/.test(String(env.npm_lifecycle_event ?? ""))) return false;
  return true;
}
