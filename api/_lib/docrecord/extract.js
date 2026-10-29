/**
 * One model pass per document -> a validated record. The model call is an injected `provider` (a function), so tests use a stub and the
 * app wires the real Anthropic call in provider.js. Retry policy: at most `maxAttempts` (default 2) passes; the second is a REPAIR pass that
 * shows the model only the spans that were not found verbatim on the stored page. The best-validated attempt wins. Never throws for a
 * low-quality record (returns status 'partial' | 'empty'); throws DocRecordError (with a fixed customer-safe userMessage) only when the provider failed.
 */
import { RECORD_RULES } from "./schema.js";
import { validateRecord } from "./validate.js";

export class DocRecordError extends Error {
  constructor(message, { userMessage, cause } = {}) { super(message); this.name = "DocRecordError"; this.userMessage = userMessage; this.cause = cause; }
}
export const FALLBACK_FAILURE_MESSAGE = "This document could not be read into a record right now. Nothing was lost - please try again in a few minutes.";
export const MAX_PROMPT_CHARS = 60_000;

export function buildRecordPrompt(pages) {
  let used = 0; const parts = [];
  for (const p of pages ?? []) {
    const t = String(p.text ?? "").trim(); if (!t) continue;
    const room = MAX_PROMPT_CHARS - used; if (room <= 0) break;
    const slice = t.slice(0, room); used += slice.length;
    parts.push(`[page ${p.page_no}]\n${slice}`);
  }
  return { system: RECORD_RULES, user: parts.join("\n\n"), truncated: used >= MAX_PROMPT_CHARS };
}

const score = (v) => v.stats.ok - v.stats.rejected.length * 0.5 - (v.reconcile.status === "fail" ? 1 : 0);

/**
 * @param {{pages:{page_no:number,text:string}[]}} doc
 * @param {{provider:(req:{system:string,user:string,repair?:object[]})=>Promise<{input:object,usage?:object}>, messageFor?:(e:any)=>string|null, maxAttempts?:number, minOkRatio?:number}} opts
 */
export async function extractDocRecord(doc, { provider, messageFor = () => null, maxAttempts = 2, minOkRatio = 0.7 } = {}) {
  if (typeof provider !== "function") throw new DocRecordError("no provider", { userMessage: FALLBACK_FAILURE_MESSAGE });
  const base = buildRecordPrompt(doc.pages);
  if (!base.user) return { status: "empty", record: null, stats: { total: 0, ok: 0, rejected: [] }, attempts: 0, usage: [] };
  let best = null; const usage = []; let repair;
  for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt++) {
    let res;
    try { res = await provider({ system: base.system, user: base.user, repair }); }
    catch (err) { throw new DocRecordError(`provider failed: ${err?.message ?? err}`, { userMessage: messageFor(err) ?? FALLBACK_FAILURE_MESSAGE, cause: err }); }
    if (res?.usage) usage.push(res.usage);
    const v = validateRecord(res?.input ?? {}, doc.pages);
    if (!best || score(v) > score(best)) best = v;
    const ratio = v.stats.total ? v.stats.ok / v.stats.total : 0;
    if (ratio >= minOkRatio && v.reconcile.status !== "fail") break;
    if (!v.stats.rejected.length && v.reconcile.status !== "fail") break; // nothing to repair (e.g. an empty record is a valid answer)
    repair = v.stats.rejected.slice(0, 25).map((r) => ({ section: r.section, why: r.why, span: r.span }));
    if (v.reconcile.status === "fail") repair.push({ section: "totals", why: "items do not add up to the printed totals: " + v.reconcile.detail, span: "" });
  }
  const ratio = best.stats.total ? best.stats.ok / best.stats.total : 0;
  const status = !best.usable ? "empty" : ratio >= minOkRatio && best.reconcile.status !== "fail" ? "verified" : "partial";
  return { status, record: best.record, stats: best.stats, reconcile: best.reconcile, attempts: usage.length || 1, usage, truncated: base.truncated };
}
