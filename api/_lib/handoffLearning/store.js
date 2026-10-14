/**
 * handoffLearning/store.js - the database layer (M3-config/7x-handoff-learning.sql). Every function takes the request's tenant-scoped handle (db.raw inside withTenant)
 * and touches this organization's rows only (RLS + an explicit tenant filter). A missing table never throws: the functions return {ok:false} / [] and warn once.
 */
import { LIMITS } from './flag.js';

const T = (a) => `${a}.tenant_id = (current_setting('app.tenant_id', true))::uuid`;
let warned = false;
const warnOnce = (where, err) => { if (!warned) { warned = true; console.warn(`handoff-learning: ${where} failed (M3-config/7x-handoff-learning.sql may not be applied yet):`, err?.message); } };
let spN = 0;
async function guarded(db, fn) {
  const sp = `donovan_hl_${++spN}`; let have = false;
  try { await db.raw(`SAVEPOINT ${sp}`); have = true; } catch { have = false; }
  try { const value = await fn(); if (have) await db.raw(`RELEASE SAVEPOINT ${sp}`).catch(() => {}); return { ok: true, value }; }
  catch (err) { if (have) await db.raw(`ROLLBACK TO SAVEPOINT ${sp}`).catch(() => {}); warnOnce('store', err); return { ok: false, error: err }; }
}

/* ---------------------------------------------------------------- handoffs */
/** Keep one grounded handoff: the question text is kept only until the job has read it. Returns {ok, id}. */
export async function insertHandoff(db, { questionText, questionMasked, reading, answerSig, groundedN }) {
  const r = await guarded(db, async () => (await db.raw(
    `INSERT INTO donovan_handoffs (tenant_id, question_text, question_masked, reading, answer_sig, grounded_n)
     VALUES ((current_setting('app.tenant_id', true))::uuid, $1, $2, $3::jsonb, $4::jsonb, $5) RETURNING id`,
    [questionText, questionMasked, JSON.stringify(reading ?? {}), JSON.stringify(answerSig ?? {}), groundedN ?? 0])).rows[0].id);
  return r.ok ? { ok: true, id: r.value } : { ok: false };
}
export async function listNewHandoffs(db, limit = 2000) {
  const r = await guarded(db, async () => (await db.raw(
    `SELECT id, question_text, question_masked, reading, answer_sig, grounded_n, created_at FROM donovan_handoffs h WHERE ${T('h')} AND status = 'new' AND question_text IS NOT NULL ORDER BY id ASC LIMIT $1`, [limit])).rows);
  return r.ok ? r.value : [];
}
/** After the job read a handoff: the raw text is blanked, only the masked form stays. */
export async function markHandoffs(db, ids, status) {
  if (!ids?.length) return 0;
  const r = await guarded(db, async () => (await db.raw(
    `UPDATE donovan_handoffs h SET status = $2, question_text = NULL, processed_at = NOW() WHERE ${T('h')} AND h.id = ANY($1::bigint[])`, [ids, status])).rowCount ?? 0);
  return r.ok ? r.value : 0;
}
/** Raw text older than the retention window is removed even when the job never ran. */
export async function purgeOldHandoffs(db) {
  const r = await guarded(db, async () => {
    await db.raw(`UPDATE donovan_handoffs h SET question_text = NULL WHERE ${T('h')} AND question_text IS NOT NULL AND created_at < NOW() - ($1 || ' days')::interval`, [String(LIMITS.handoffTtlDays)]);
    return (await db.raw(`DELETE FROM donovan_handoffs h WHERE ${T('h')} AND created_at < NOW() - ($1 || ' days')::interval * 4`, [String(LIMITS.handoffTtlDays)])).rowCount ?? 0;
  });
  return r.ok ? r.value : 0;
}

/* ---------------------------------------------------------------- learnings */
export async function listLearnings(db, { status = null } = {}) {
  const r = await guarded(db, async () => (await db.raw(
    `SELECT id, kind, phrase, target_kind, target_value, canonical, support, status, retire_reason, evidence, created_at, expires_at FROM donovan_handoff_learned l
     WHERE ${T('l')} ${status ? 'AND status = $1' : ''} ORDER BY id ASC`, status ? [status] : [])).rows);
  return r.ok ? r.value : [];
}
/** Active, unexpired learnings (what the parser reads). */
export async function listActive(db) {
  const r = await guarded(db, async () => (await db.raw(
    `SELECT kind, phrase, canonical, target_kind, target_value FROM donovan_handoff_learned l WHERE ${T('l')} AND status = 'active' AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY id ASC`, [])).rows);
  return r.ok ? r.value : [];
}
/** A cheap fingerprint of the active set (count + newest change), so the cached vocabulary is rebuilt when a learning is adopted or retired. */
export async function overlayVersion(db) {
  const r = await guarded(db, async () => (await db.raw(
    `SELECT count(*)::text || ':' || coalesce(max(greatest(created_at, coalesce(retired_at, created_at)))::text, '') AS v FROM donovan_handoff_learned l WHERE ${T('l')}`, [])).rows[0]?.v ?? '');
  return r.ok ? r.value : '';
}
export async function adoptLearning(db, L) {
  const r = await guarded(db, async () => (await db.raw(
    `INSERT INTO donovan_handoff_learned (tenant_id, kind, phrase, target_kind, target_value, canonical, support, evidence, expires_at, status)
     VALUES ((current_setting('app.tenant_id', true))::uuid, $1, $2, $3, $4, $5, $6, $7::jsonb, NOW() + ($8 || ' days')::interval, 'active')
     ON CONFLICT (tenant_id, kind, phrase) DO UPDATE SET target_kind = EXCLUDED.target_kind, target_value = EXCLUDED.target_value, canonical = EXCLUDED.canonical, support = EXCLUDED.support,
       evidence = EXCLUDED.evidence, expires_at = EXCLUDED.expires_at, status = 'active', retire_reason = NULL, retired_at = NULL
       WHERE donovan_handoff_learned.status <> 'retired' OR donovan_handoff_learned.retired_at < NOW() - INTERVAL '30 days'
     RETURNING id`,
    [L.kind, L.phrase, L.targetKind ?? null, L.targetValue ?? null, L.canonical ?? '', L.support ?? 0, JSON.stringify(L.evidence ?? {}), String(LIMITS.ttlDays)])).rows[0]?.id ?? null);
  return r.ok ? r.value : null;
}
export async function retireLearning(db, id, reason) {
  const r = await guarded(db, async () => (await db.raw(
    `UPDATE donovan_handoff_learned l SET status = 'retired', retire_reason = $2, retired_at = NOW() WHERE ${T('l')} AND l.id = $1 AND status = 'active'`, [id, String(reason).slice(0, 200)])).rowCount ?? 0);
  return r.ok ? r.value : 0;
}
export async function countActive(db) {
  const r = await guarded(db, async () => Number((await db.raw(`SELECT count(*)::int AS n FROM donovan_handoff_learned l WHERE ${T('l')} AND status = 'active'`, [])).rows[0]?.n ?? 0));
  return r.ok ? r.value : 0;
}

/* ---------------------------------------------------------------- shared (platform) learnings: no tenant, no question text, generic words only */
export async function listShared(rawDb) {
  try { return (await rawDb.raw(`SELECT kind, phrase, canonical, n_companies FROM donovan_handoff_shared WHERE status = 'active' ORDER BY id ASC`, [])).rows; } catch (err) { warnOnce('listShared', err); return []; }
}
export async function upsertShared(rawDb, S) {
  try {
    await rawDb.raw(`INSERT INTO donovan_handoff_shared (kind, phrase, canonical, n_companies, status) VALUES ($1, $2, $3, $4, 'active')
      ON CONFLICT (kind, phrase) DO UPDATE SET canonical = EXCLUDED.canonical, n_companies = EXCLUDED.n_companies, status = 'active'`, [S.kind, S.phrase, S.canonical, S.nCompanies]);
    return true;
  } catch (err) { warnOnce('upsertShared', err); return false; }
}
export async function retireShared(rawDb, kind, phrase) {
  try { await rawDb.raw(`UPDATE donovan_handoff_shared SET status = 'retired' WHERE kind = $1 AND phrase = $2`, [kind, phrase]); return true; } catch (err) { warnOnce('retireShared', err); return false; }
}
