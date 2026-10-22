/**
 * Put ONE industry demo company back to its original sample paperwork - used by "Clear my scans" (the presenter, after a
 * meeting) and by the nightly reset (every demo company).
 *
 * What it does, in one transaction on the company's own row-level-security context:
 *   1. refuses unless the company is a demo company (plan 'demo' AND billing_status 'demo') with a recorded seed
 *      (M3-config/demo/D2) - a real customer can never be reset, whatever the caller passes;
 *   2. deletes every document that is not part of the seed (a prospect's scan), with everything hanging off it;
 *   3. puts the seed STATE back exactly: the seed documents' own rows and every table a demo day can change (facts,
 *      links, customers and the summaries built from them) are restored from demo_seed_snapshot;
 *   4. clears what a demo day leaves behind that is not part of the seed: Donovan's answer caches, miss and handoff logs,
 *      notifications, drafted messages, outreach settings;
 *   5. puts the company's SETTINGS back (tenants.settings: notification digest on/off, mutes, per-person screen preferences) from
 *      the snapshot's 'tenant_settings' entry (M3-config/73 demo_mark_seed). For a seed recorded before that entry existed, the
 *      three keys a presenter can change are removed instead.
 * After the commit, the deleted documents' files are removed from storage (only keys under this company's prefix) and this
 * instance's caches for the company are dropped. Never touches another company: every statement is scoped to the one
 * tenant id resolved from the caller's own context, and RLS enforces the same.
 */
import { getPool, bustTenantCache } from '../recordsStore.js';
import { serializeClient, assertTenantUuid } from '../util/pgClient.js';
import { deleteObject, keyBelongsToTenant } from '../r2.js';

/** Parent tables first. Keep identical to demo_snapshot_tables() in M3-config/73-demo-accounts.sql. */
export const SNAPSHOT_TABLES = Object.freeze([
  'documents', 'entities', 'facets', 'extractions', 'document_entity_links', 'document_financials', 'document_financial_lines',
  'document_cards', 'intake_field_inferences', 'intake_needs_info', 'kg_edges', 'dossiers', 'customer_activity',
  'customer_activity_dirty', 'entity_merge_suggestions', 'tenant_insights_cache', 'tenant_rollups', 'knowledge_reports',
]);

/** Not part of the seed at all: emptied for the company on every reset. */
export const CLEAR_TABLES = Object.freeze([
  'ask_answer_cache', 'ask_semantic_cache', 'ask_misses', 'ask_miss_replays', 'notifications', 'notifications_sent', 'outreach_messages',
  'donovan_handoffs', 'donovan_learned_tenant', 'donovan_handoff_learned', 'donovan_examples', 'donovan_promoted_tests',
  'google_sync_items', 'google_connections', 'tenant_outreach_settings',
]);

/** Kept as they are (counters, audit trail, people, keys, the seed itself). Listed so the verify script can prove every
 *  tenant table is in exactly one of the three lists. */
export const KEPT_TABLES = Object.freeze([
  'tenants', 'users', 'audit_log', 'usage_counters', 'rate_limit_windows', 'page_usage_monthly', 'api_keys', 'billing_events',
  'staff_access_log', 'support_access_grants', 'tenant_deletions', 'demo_seed_documents', 'demo_seed_snapshot',
  'document_pages', 'donovan_gap_promotions', 'donovan_scorecard_runs', 'donovan_scorecard_results', 'proposals', 'schema_versions',
  'embedding_usage', 'page_chunks',
]);

/** The snapshot entry (in demo_seed_snapshot.table_name) that holds the seed copy of tenants.settings. Not a table. */
export const SETTINGS_SNAPSHOT_KEY = 'tenant_settings';
/** tenants.settings keys a presenter can change from the demo UI (notifications route). Removed on reset when no settings snapshot exists. */
export const PRESENTER_SETTINGS_KEYS = Object.freeze(['emailDigest', 'digestMuted', 'uiPrefs']);

export class DemoResetError extends Error {
  constructor(message, status = 409) { super(message); this.name = 'DemoResetError'; this.status = status; }
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
const q = (name) => { if (!IDENT.test(name)) throw new Error(`bad identifier ${name}`); return `"${name}"`; };

async function existingTables(client, names) {
  const { rows } = await client.query("SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND c.relname = ANY($1::text[])", [names]);
  return new Set(rows.map((r) => r.t));
}

async function insertableColumns(client, table) {
  const { rows } = await client.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND COALESCE(is_generated, 'NEVER') <> 'ALWAYS' ORDER BY ordinal_position",
    [table]);
  return rows.map((r) => r.column_name);
}

/**
 * @param {{tenantKey: string, tenantName?: string}} ctx
 * @param {{reason: 'clear-scans'|'nightly'|'verify', actor?: string|null, deleteObjects?: Function}} [opts]
 * @returns {Promise<{tenantId: string, removedDocuments: number, restored: Record<string, number>, cleared: Record<string, number>, filesDeleted: number, failedStorage: number}>}
 */
export async function resetDemoTenant(ctx, { reason = 'clear-scans', actor = null, deleteObjects = deleteObject } = {}) {
  if (!ctx?.tenantKey) throw new DemoResetError('A company is required', 400);
  const client = serializeClient(await getPool().connect());
  let tenantId;
  let storageKeys = [];
  const restored = {};
  const cleared = {};
  let removedDocuments = 0;
  try {
    await client.query('BEGIN');
    const { rows: idRows } = await client.query('SELECT resolve_tenant($1, $2) AS id', [ctx.tenantKey, ctx.tenantName ?? ctx.tenantKey]);
    tenantId = assertTenantUuid(idRows[0]?.id);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);

    // 1. demo companies only, with a recorded seed
    const { rows: tRows } = await client.query('SELECT plan, billing_status FROM tenants WHERE id = $1', [tenantId]);
    if (tRows[0]?.plan !== 'demo' || tRows[0]?.billing_status !== 'demo') throw new DemoResetError('Only a demo company can be reset.', 403);
    const { rows: seedRows } = await client.query('SELECT document_id FROM demo_seed_documents WHERE tenant_id = $1', [tenantId]);
    const { rows: snapRows } = await client.query('SELECT table_name, rows FROM demo_seed_snapshot WHERE tenant_id = $1', [tenantId]);
    if (!seedRows.length || !snapRows.some((r) => r.table_name === 'documents')) {
      throw new DemoResetError('This demo company has no recorded sample paperwork yet (run M3-config/demo/D2 after seeding).', 409);
    }
    const seedIds = seedRows.map((r) => r.document_id);
    const snapshot = new Map(snapRows.map((r) => [r.table_name, Array.isArray(r.rows) ? r.rows : []]));

    // 2. the prospect's documents (anything that is not seed)
    const extra = await client.query('SELECT id, storage_key FROM documents WHERE tenant_id = $1 AND NOT (id = ANY($2::uuid[]))', [tenantId, seedIds]);
    storageKeys = extra.rows.filter((r) => r.storage_key && keyBelongsToTenant(r.storage_key, tenantId)).map((r) => r.storage_key);
    if (extra.rows.length) {
      const del = await client.query('DELETE FROM documents WHERE tenant_id = $1 AND id = ANY($2::uuid[])', [tenantId, extra.rows.map((r) => r.id)]);
      removedDocuments = del.rowCount;
    }

    const present = await existingTables(client, [...SNAPSHOT_TABLES, ...CLEAR_TABLES]);
    // 4 (first, because some of these point at entities). Clear the non-seed leftovers.
    for (const t of CLEAR_TABLES) {
      if (!present.has(t)) continue;
      const r = await client.query(`DELETE FROM ${q(t)} WHERE tenant_id = $1`, [tenantId]);
      cleared[t] = r.rowCount;
    }
    // 3. restore the seed state: children first out, parents first in. documents rows are updated in place (never
    //    deleted - that would cascade to the page text, which a demo day never changes).
    const tables = SNAPSHOT_TABLES.filter((t) => present.has(t));
    for (const t of [...tables].reverse()) {
      if (t === 'documents') continue;
      await client.query(`DELETE FROM ${q(t)} WHERE tenant_id = $1`, [tenantId]);
    }
    for (const t of tables) {
      const rows = (snapshot.get(t) ?? []).map((r) => ({ ...r, tenant_id: tenantId }));
      const cols = await insertableColumns(client, t);
      const colList = cols.map(q).join(', ');
      if (t === 'documents') {
        const upd = cols.filter((c) => c !== 'id' && c !== 'tenant_id');
        if (rows.length && upd.length) {
          await client.query(
            `UPDATE documents d SET (${upd.map(q).join(', ')}) = (SELECT ${upd.map((c) => `s.${q(c)}`).join(', ')})
               FROM jsonb_populate_recordset(NULL::documents, $1::jsonb) s WHERE d.id = s.id AND d.tenant_id = $2`,
            [JSON.stringify(rows), tenantId]);
        }
        restored[t] = rows.length;
        continue;
      }
      // Restoring a parent table can fire triggers that add rows to a later (derived) table, e.g. customer_activity_dirty:
      // empty each table again right before its own rows go back, so it ends exactly as the snapshot.
      await client.query(`DELETE FROM ${q(t)} WHERE tenant_id = $1`, [tenantId]);
      if (rows.length) {
        await client.query(`INSERT INTO ${q(t)} (${colList}) SELECT ${colList} FROM jsonb_populate_recordset(NULL::${q(t)}, $1::jsonb)`, [JSON.stringify(rows)]);
      }
      restored[t] = rows.length;
    }

    // 5. settings a presenter could change (notification digest, mutes, screen prefs) go back to the seed value
    const settingsSnap = snapshot.get(SETTINGS_SNAPSHOT_KEY)?.[0]?.settings;
    if (settingsSnap && typeof settingsSnap === 'object' && !Array.isArray(settingsSnap)) {
      await client.query('UPDATE tenants SET settings = $2::jsonb WHERE id = $1', [tenantId, JSON.stringify(settingsSnap)]);
      restored[SETTINGS_SNAPSHOT_KEY] = 1;
    } else {
      await client.query(
        `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) - 'emailDigest' - 'digestMuted' - 'uiPrefs' WHERE id = $1`, [tenantId]);
      restored[SETTINGS_SNAPSHOT_KEY] = 0;
    }

    await client.query(
      'INSERT INTO audit_log (tenant_id, user_id, action, resource_type, changes, created_at) VALUES ($1, NULL, $2, $3, $4, NOW())',
      [tenantId, 'demo.reset', 'tenant', { reason, actor, removedDocuments, filesToDelete: storageKeys.length }]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  let failedStorage = 0;
  for (const key of storageKeys) {
    try { await deleteObjects(key); } catch (err) { failedStorage++; console.error('demo reset: storage delete failed:', err?.message); }
  }
  try { bustTenantCache(ctx.tenantKey); bustTenantCache(tenantId); } catch { /* best effort, TTLs bound staleness */ }
  return { tenantId, removedDocuments, restored, cleared, filesDeleted: storageKeys.length - failedStorage, failedStorage };
}

/** Status for the demo bar: is this a demo company, and how many extra (scanned) documents does it hold right now. */
export async function demoStatus(ctx) {
  const client = serializeClient(await getPool().connect());
  try {
    await client.query('BEGIN');
    const { rows: idRows } = await client.query('SELECT resolve_tenant($1, $2) AS id', [ctx.tenantKey, ctx.tenantName ?? ctx.tenantKey]);
    const tenantId = assertTenantUuid(idRows[0]?.id);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const { rows: [t] } = await client.query("SELECT plan, billing_status, limits -> 'demo' AS demo FROM tenants WHERE id = $1", [tenantId]);
    if (t?.plan !== 'demo' || t?.billing_status !== 'demo') { await client.query('COMMIT'); return { demo: false }; }
    const { rows: [c] } = await client.query(
      `SELECT (SELECT count(*)::int FROM documents WHERE tenant_id = $1) AS documents,
              (SELECT count(*)::int FROM demo_seed_documents WHERE tenant_id = $1) AS seed`, [tenantId]);
    await client.query('COMMIT');
    const demo = t.demo && typeof t.demo === 'object' ? t.demo : {};
    return {
      demo: true, industry: demo.industry ?? null, slug: demo.slug ?? null, company: demo.company ?? null, seededAt: demo.seededAt ?? null,
      documents: c.documents, seedDocuments: c.seed, scans: Math.max(0, c.documents - c.seed),
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
