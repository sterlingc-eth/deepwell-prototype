/**
 * safetynet/hook.js - the glue ask.js / review.js call. Everything is best-effort and never throws into the request.
 *   afterAloneAnswer   RUNS AFTER the customer's response was sent (valuereader / docrecord answers): decide, verify with Claude, log, flag, write a case.
 *   recordReport       "Report a wrong answer": writes the learning case (the replacement answer itself is the existing thumbs-down replay).
 *   recordHandoffCase  a Claude (agent) answer, kept as a case so the training team sees what Donovan could not do alone.
 *   correctionFor      the follow-up note, only when DONOVAN_AUDIT_CORRECT=1 and an audit disagreed.
 */
import crypto from 'node:crypto';
import * as F from './flags.js';
import { verifyAnswer, makeAnthropicVerifier } from './verifier.js';
import { buildCase, stageFromWhy } from './cases.js';
import * as S from './store.js';

const qhash = (q) => crypto.createHash('sha256').update(String(q ?? '').toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 32);
// Haiku-class list price, USD per million tokens (override with DONOVAN_AUDIT_PRICE_IN/OUT). Used for the operator-only cost figure.
const priceIn = () => Number(process.env.DONOVAN_AUDIT_PRICE_IN) || 1; const priceOut = () => Number(process.env.DONOVAN_AUDIT_PRICE_OUT) || 5;
export const costMicro = (u) => Math.round((((u?.inputTokens ?? 0) + (u?.cacheCreationInputTokens ?? 0)) * priceIn() + (u?.cacheReadInputTokens ?? 0) * priceIn() * 0.1 + (u?.outputTokens ?? 0) * priceOut()));

const deps = async () => ({ withTenant: (await import('../recordsStore.js')).withTenant, assertModelBudget: (await import('../rateLimit.js')).assertModelBudget, recordModelCall: (await import('../usage.js')).recordModelCall });

async function loadPages(db, data) {
  const want = (data?.sources ?? []).map((s) => ({ id: s.documentId, page: Number(s.location?.page) })).filter((s) => s.id && s.page > 0).slice(0, 3);
  const out = [];
  for (const w of want) {
    const { rows } = await db.raw(`SELECT text FROM document_pages dp WHERE dp.tenant_id = (current_setting('app.tenant_id', true))::uuid AND dp.document_id = $1 AND dp.page_no = $2`, [w.id, w.page]);
    if (rows?.[0]) out.push({ page: w.page, text: rows[0].text ?? '' });
  }
  return out;
}

/** d = injected collaborators for tests: {withTenant, assertModelBudget, recordModelCall, provider, rand, loadPages}. Returns a small result object (tests / logs); never throws. */
export async function afterAloneAnswer(ctx, { question, data, lane, score }, d = null) {
  try {
    const env = process.env;
    const pick = F.decideAudit({ score, rand: d?.rand, env });
    if (!pick.audit || data?.kind !== 'answer') return { skipped: 'not-sampled' };
    const dp = d ?? await deps();
    return await dp.withTenant(ctx, async (db) => {
      const used = await S.auditsToday(db);
      if (used == null || used >= F.dailyMax(env)) return { skipped: used == null ? 'no-table' : 'daily-cap' };
      try { await (dp.assertModelBudget ?? (async () => {}))(ctx); } catch { return { skipped: 'model-budget' }; }
      const pages = await (dp.loadPages ?? loadPages)(db, data);
      const provider = dp.provider ?? await makeAnthropicVerifier(F.auditModel(env));
      const v = await verifyAnswer({ question, answerText: data.text, pages, provider });
      if (v.usage) { try { await (dp.recordModelCall ?? (async () => {}))(ctx, v.usage); } catch { /* usage is best-effort */ } }
      const showNote = F.correctOn(env) && v.verdict === 'disagree';
      const note = showNote ? (v.correct ? `A second check disagrees with this answer. The cited page shows "${v.correct}". It has been flagged for review.` : 'A second check was not sure this answer is right. It has been flagged for review.') : null;
      await S.insertAudit(db, { lane, questionHash: qhash(question), verdict: v.verdict, why: v.why, forced: pick.forced, score, correction: showNote ? note : null, showNote, costMicro: costMicro(v.usage), tokensIn: v.usage?.inputTokens, tokensOut: v.usage?.outputTokens, model: F.auditModel(env) });
      if (v.verdict === 'disagree' && F.casesOn(env)) await S.insertCase(db, buildCase({ source: 'audit_disagree', question, data, expected: v.correct || null, why: v.why, lane }), { exportOk: F.optedIn(ctx?.tenantKey, env) });
      return { verdict: v.verdict, forced: pick.forced, stage: stageFromWhy(v.why) };
    });
  } catch (err) { console.error('safetynet audit skipped:', err?.message); return { skipped: 'error' }; }
}

/** report = {answerText, sources:[{documentId,page}]} from the customer's click. Cheap; no model. */
export async function recordReport(ctx, { question, report, lane = null }, d = null) {
  try {
    const env = process.env; if (!F.casesOn(env)) return { skipped: 'off' };
    const withTenant = d?.withTenant ?? (await import('../recordsStore.js')).withTenant;
    const refs = (report?.sources ?? []).map((s) => ({ documentId: String(s.documentId ?? ''), page: Number(s.page) || null })).filter((r) => r.documentId).slice(0, 8);
    const c = buildCase({ source: 'customer_report', question, given: String(report?.answerText ?? '').slice(0, 800), refs, stage: 'unknown', lane: lane ?? (report?.lane || 'unknown') });
    return { id: await withTenant(ctx, (db) => S.insertCase(db, c, { exportOk: F.optedIn(ctx?.tenantKey, env) })) };
  } catch { return { skipped: 'error' }; }
}

export async function recordHandoffCase(ctx, { question, data }, d = null) {
  try {
    if (!F.casesOn(process.env) || data?.kind !== 'answer') return { skipped: 'off' };
    const withTenant = d?.withTenant ?? (await import('../recordsStore.js')).withTenant;
    return { id: await withTenant(ctx, (db) => S.insertCase(db, buildCase({ source: 'claude_handoff', question, data, lane: 'agent', stage: 'agent' }), { exportOk: F.optedIn(ctx?.tenantKey, process.env) })) };
  } catch { return { skipped: 'error' }; }
}

export async function correctionFor(ctx, question) {
  try {
    if (!F.correctOn(process.env)) return { note: null };
    const { withTenant } = await import('../recordsStore.js');
    const r = await withTenant(ctx, (db) => S.takeCorrection(db, qhash(question)));
    return { note: r?.correction || null };
  } catch { return { note: null }; }
}
export async function statsFor(ctx, days) { const { withTenant } = await import('../recordsStore.js'); return withTenant(ctx, (db) => S.stats(db, { days })); }
