/**
 * Per-tenant AI allowance for connectors. Fetching files from a storage provider costs DeepWell nothing in AI spend, but anything
 * that makes a PAID call on a connector's behalf (vision reading of a scanned attachment, summarising an email body) must go through
 * paidCall(): it checks the tenant's monthly allowance first (api/_lib/aiAllowance.js), runs the call only if allowed, and records the
 * dollars afterwards. Customers see only "your allowance is used for now" wording, never a dollar figure.
 */
import { allowanceStatus, recordAllowanceSpend, isAllowanceEnabled } from "../aiAllowance.js";

/** @returns {{ran:boolean, value?:any, why?:string}} */
export async function paidCall(withTenant, ctx, estimateUsd, fn, env = process.env) {
  if (isAllowanceEnabled(env)) {
    const a = await allowanceStatus(withTenant, ctx, env);
    if (!a.allowed) return { ran: false, why: a.why };
  }
  const out = await fn();
  const usd = Number.isFinite(out?.costUsd) ? out.costUsd : estimateUsd;
  if (isAllowanceEnabled(env)) await recordAllowanceSpend(withTenant, ctx, usd);
  return { ran: true, value: out };
}

/** Sync gate: when the allowance is used up, imports pause (the files would be read by paid steps downstream). */
export async function importsAllowed(withTenant, ctx, env = process.env) {
  if (!isAllowanceEnabled(env)) return { allowed: true };
  const a = await allowanceStatus(withTenant, ctx, env);
  return { allowed: a.allowed, why: a.why };
}
