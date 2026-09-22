/**
 * Donovan self-learning loop, Tier 2 Part A (handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md):
 * thin wrappers around the platform-level (no tenant_id — see M3-config/
 * 26-donovan-learning.sql's own doc comment) SECURITY DEFINER functions that
 * read/write donovan_proposals/donovan_learned. Same idiom as
 * api/_lib/missDigest.js's own store calls: a plain getPool() connection (no
 * withTenant — nothing here is scoped to a tenant), one console.warn the
 * first time a call fails (migration not applied yet), and an empty/false
 * return rather than a throw from then on.
 *
 * This file is the only place in the codebase that writes to
 * donovan_proposals/donovan_learned directly — everything else (the pure
 * validation/verification engine, api/ask.js's overlay consumption) goes
 * through here or through learning/overlay.js's own read-only loader.
 */
import { getPool } from '../recordsStore.js';

let warned = false;
function warnOnce(context, err) {
  if (warned) return;
  warned = true;
  console.warn(`donovan-learning: ${context} failed (M3-config/26-donovan-learning.sql may not be applied yet):`, err?.message);
}

/** Every active learned row, as {id, kind, key, value, created_at} — `id` is
 *  what a caller (api/review.js's learningDeactivate) sends back to
 *  deactivateLearned below. Empty array (never a throw) when the migration
 *  hasn't been applied yet. */
export async function listActiveLearned() {
  try {
    const { rows } = await getPool().query('SELECT * FROM learning_list_active()');
    return rows;
  } catch (err) {
    warnOnce('learning_list_active', err);
    return [];
  }
}

/** Inserts one proposal row. Returns its new id, or null on failure (table/
 *  function missing, or any other DB error) — never throws. */
export async function insertProposal({ kind, payload, evidence, verification, status, reason }) {
  try {
    const { rows } = await getPool().query(
      'SELECT learning_insert_proposal($1,$2,$3,$4,$5,$6) AS id',
      [
        kind,
        JSON.stringify(payload ?? {}),
        JSON.stringify(evidence ?? {}),
        JSON.stringify(verification ?? {}),
        status ?? 'pending',
        reason ?? null,
      ]
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    warnOnce('learning_insert_proposal', err);
    return null;
  }
}

/** Lists proposals, most recent first, optionally filtered by `status`
 *  ('pending'/'approved'/'rejected'/'auto_rejected'/'auto_approved'). Empty
 *  array on failure. */
export async function listProposals({ status = null, limit = 100 } = {}) {
  try {
    const { rows } = await getPool().query('SELECT * FROM learning_list_proposals($1,$2)', [status, limit]);
    return rows;
  } catch (err) {
    warnOnce('learning_list_proposals', err);
    return [];
  }
}

/** One proposal by id, or null (not found, or the migration/function isn't
 *  applied yet). Used by api/review.js's learningDecide to RE-VERIFY a
 *  proposal's stored kind/payload against the CURRENT routing bank before
 *  approving it — a proposal can go stale between being proposed and an
 *  operator clicking Approve. */
export async function getProposal(id) {
  try {
    const { rows } = await getPool().query('SELECT * FROM learning_get_proposal($1)', [id]);
    return rows[0] ?? null;
  } catch (err) {
    warnOnce('learning_get_proposal', err);
    return null;
  }
}

/** Records an operator's (or the nightly job's auto-approve/auto-reject)
 *  decision on one proposal. An 'approved'/'auto_approved' decision also
 *  atomically writes the corresponding donovan_learned row (see
 *  learning_decide, M3-config/26). Returns true only when the proposal was
 *  actually found and updated; false on any failure, including a bad id. */
export async function decideProposal(id, status, decidedBy) {
  try {
    const { rows } = await getPool().query('SELECT learning_decide($1,$2,$3) AS ok', [id, status, decidedBy ?? null]);
    return Boolean(rows[0]?.ok);
  } catch (err) {
    warnOnce('learning_decide', err);
    return false;
  }
}

/** Retires one learned row (sets active=false) without deleting it — the
 *  overlay loader (learning/overlay.js) only ever reads active=true rows, so
 *  this is how a bad learned item gets turned off without losing the
 *  history. Returns true only when a row was actually found and updated. */
export async function deactivateLearned(learnedId) {
  try {
    const { rows } = await getPool().query('SELECT learning_deactivate($1) AS ok', [learnedId]);
    return Boolean(rows[0]?.ok);
  } catch (err) {
    warnOnce('learning_deactivate', err);
    return false;
  }
}
