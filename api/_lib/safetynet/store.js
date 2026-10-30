/**
 * safetynet/store.js - database layer (donovan-training/safetynet_tables.sql, applied by the owner). Takes the tenant-scoped handle from withTenant.
 * A missing table never throws: functions return {ok:false} / [] / null and warn once. No cost or token figure is ever returned to a customer-facing caller.
 */
const T = (a) => `${a}.tenant_id = (current_setting('app.tenant_id', true))::uuid`;
let warned = false; let n = 0;
async function guarded(db, fn) {
  const sp = `sn_${++n}`; let have = false;
  try { await db.raw(`SAVEPOINT ${sp}`); have = true; } catch { have = false; }
  try { const value = await fn(); if (have) await db.raw(`RELEASE SAVEPOINT ${sp}`).catch(() => {}); return { ok: true, value }; }
  catch (err) { if (have) await db.raw(`ROLLBACK TO SAVEPOINT ${sp}`).catch(() => {}); if (!warned) { warned = true; console.warn('safetynet store failed (donovan-training/safetynet_tables.sql applied?):', err?.message); } return { ok: false, error: err }; }
}

export async function auditsToday(db) {
  const r = await guarded(db, async () => (await db.raw(`SELECT count(*)::int AS n FROM donovan_audits a WHERE ${T('a')} AND created_at >= date_trunc('day', now() AT TIME ZONE 'utc')`, [])).rows[0].n);
  return r.ok ? r.value : null; // null = table missing: the caller does not audit
}
export async function insertAudit(db, { lane, questionHash, verdict, why, forced, score, correction, showNote, costMicro, tokensIn, tokensOut, model }) {
  const r = await guarded(db, async () => (await db.raw(
    `INSERT INTO donovan_audits (tenant_id, lane, question_hash, verdict, why, forced, score, correction, show_note, cost_micro_usd, tokens_in, tokens_out, model)
     VALUES ((current_setting('app.tenant_id', true))::uuid, $1,$2,$3,$4,$5,$6,$7,$12,$8,$9,$10,$11) RETURNING id`,
    [lane, questionHash, verdict, why ?? null, !!forced, score ?? null, correction || null, costMicro ?? 0, tokensIn ?? 0, tokensOut ?? 0, model ?? null, !!showNote])).rows[0].id);
  return r.ok ? r.value : null;
}
export async function insertCase(db, c, { exportOk = false } = {}) {
  const r = await guarded(db, async () => (await db.raw(
    `INSERT INTO donovan_learning_cases (tenant_id, source, lane, stage, question, given, expected, doc_refs, export_ok)
     VALUES ((current_setting('app.tenant_id', true))::uuid, $1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING id`,
    [c.source, c.lane, c.stage, c.question, c.given, c.expected, JSON.stringify(c.docRefs ?? []), !!exportOk])).rows[0].id);
  return r.ok ? r.value : null;
}
/** The newest unseen correction for this question hash (set by a disagreeing audit when DONOVAN_AUDIT_CORRECT=1). Marks it shown. */
export async function takeCorrection(db, questionHash) {
  const r = await guarded(db, async () => (await db.raw(
    `UPDATE donovan_audits a SET shown_at = now() WHERE a.id = (SELECT id FROM donovan_audits b WHERE ${T('b')} AND b.question_hash = $1 AND b.verdict = 'disagree' AND b.show_note AND b.shown_at IS NULL AND b.created_at > now() - interval '10 minutes' ORDER BY id DESC LIMIT 1) RETURNING a.correction`, [questionHash])).rows[0]);
  return r.ok && r.value ? { correction: r.value.correction ?? '' } : null;
}
/** Owner/operator numbers: sampled precision, report/flag rate against the alone-answer count in audit_log. */
export async function stats(db, { days = 30 } = {}) {
  const d = Math.max(1, Math.min(365, Number(days) || 30));
  const a = await guarded(db, async () => (await db.raw(
    `SELECT lane, count(*)::int AS audited, count(*) FILTER (WHERE verdict='agree')::int AS agree, count(*) FILTER (WHERE verdict='disagree')::int AS disagree, count(*) FILTER (WHERE verdict='unsure')::int AS unsure,
            count(*) FILTER (WHERE forced)::int AS forced, COALESCE(sum(cost_micro_usd),0)::bigint AS cost_micro_usd
       FROM donovan_audits a WHERE ${T('a')} AND created_at > now() - ($1 || ' days')::interval GROUP BY lane`, [String(d)])).rows);
  const c = await guarded(db, async () => (await db.raw(
    `SELECT source, count(*)::int AS n FROM donovan_learning_cases c WHERE ${T('c')} AND created_at > now() - ($1 || ' days')::interval GROUP BY source`, [String(d)])).rows);
  const alone = await guarded(db, async () => (await db.raw(
    `SELECT count(*)::int AS n FROM audit_log l WHERE ${T('l')} AND l.action = 'document.queried' AND l.created_at > now() - ($1 || ' days')::interval AND (l.changes->>'valuereader' = 'true' OR l.changes->>'docrecord' = 'true')`, [String(d)])).rows[0].n);
  return summarize({ audits: a.ok ? a.value : [], cases: c.ok ? c.value : [], aloneAnswers: alone.ok ? alone.value : null, days: d });
}
/** Pure. Disagreement rate is over decided audits (agree + disagree); unsure is reported separately and excluded from precision. */
export function summarize({ audits, cases, aloneAnswers, days }) {
  const sum = (k) => audits.reduce((s, r) => s + Number(r[k] ?? 0), 0);
  const agree = sum('agree'), disagree = sum('disagree'), decided = agree + disagree;
  const caseN = (s) => Number(cases.find((x) => x.source === s)?.n ?? 0);
  const reports = caseN('customer_report');
  return {
    days, aloneAnswers, audited: sum('audited'), forcedAudits: sum('forced'), agree, disagree, unsure: sum('unsure'),
    disagreementRate: decided ? disagree / decided : null, sampledPrecision: decided ? agree / decided : null,
    reports, flagRate: aloneAnswers ? (reports + disagree) / aloneAnswers : null, reportRate: aloneAnswers ? reports / aloneAnswers : null,
    cases: Object.fromEntries(cases.map((x) => [x.source, Number(x.n)])), auditCostUsd: sum('cost_micro_usd') / 1e6, byLane: audits,
  };
}
