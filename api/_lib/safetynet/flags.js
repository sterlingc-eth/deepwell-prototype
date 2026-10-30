/**
 * safetynet/flags.js - every switch of the wrong-answer safety net. All default OFF; nothing here touches the database or a model while its switch is off.
 *   DONOVAN_AUDIT=1              background verifier on Donovan-alone answers (valuereader / docrecord)
 *   DONOVAN_AUDIT_RATE=0.05      share of alone answers verified (0..1)
 *   DONOVAN_AUDIT_LOW_SCORE=0.8  an answer whose reader score is below this is ALWAYS verified (lowest confidence band)
 *   DONOVAN_AUDIT_DAILY_MAX=100  verifier calls per tenant per UTC day (hard cost cap; forced audits obey it too)
 *   DONOVAN_AUDIT_CORRECT=1      show the customer a follow-up correction note when the verifier disagrees
 *   DONOVAN_AUDIT_MODEL          verifier model (default claude-haiku-4-5)
 *   DONOVAN_LEARNING_CASES=1     write structured learning cases (reports, audit disagreements, Claude handoffs)
 *   DONOVAN_LEARNING_OPTIN_TENANTS=a,b  tenants whose cases may be exported (default none)
 */
const on = (v) => /^(?:1|true|on|yes)$/i.test(String(v ?? '').trim());
const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) && String(v ?? '').trim() !== '' ? Math.min(hi, Math.max(lo, n)) : d; };
export const auditOn = (env = process.env) => on(env.DONOVAN_AUDIT);
export const auditRate = (env = process.env) => num(env.DONOVAN_AUDIT_RATE, 0.05, 0, 1);
export const lowScore = (env = process.env) => num(env.DONOVAN_AUDIT_LOW_SCORE, 0.8, 0, 1);
export const dailyMax = (env = process.env) => Math.floor(num(env.DONOVAN_AUDIT_DAILY_MAX, 100, 0, 100000));
export const correctOn = (env = process.env) => on(env.DONOVAN_AUDIT_CORRECT);
export const auditModel = (env = process.env) => String(env.DONOVAN_AUDIT_MODEL || 'claude-haiku-4-5');
export const casesOn = (env = process.env) => on(env.DONOVAN_LEARNING_CASES);
export const optedIn = (tenantKey, env = process.env) => String(env.DONOVAN_LEARNING_OPTIN_TENANTS ?? '').split(',').map((s) => s.trim()).filter(Boolean).includes(String(tenantKey ?? ''));

/** Pure sampling decision. score = reader score (undefined = unknown, never forced). Returns {audit, forced}. */
export function decideAudit({ score, rand = Math.random, env = process.env } = {}) {
  if (!auditOn(env)) return { audit: false, forced: false };
  const forced = typeof score === 'number' && Number.isFinite(score) && score < lowScore(env);
  return { audit: forced || rand() < auditRate(env), forced };
}
