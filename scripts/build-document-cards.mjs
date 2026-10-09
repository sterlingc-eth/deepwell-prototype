#!/usr/bin/env node
/**
 * OPTIONAL (owner runs later, after M3-config/68-document-cards.sql): build or refresh the stored document cards for every organization.
 *   NEON_CONNECTION_STRING=... node scripts/build-document-cards.mjs [--tenant <slug>] [--dry-run]
 * Reads each organization's own rows through withTenant (row-level security applies), writes one card per document into document_cards. Re-runnable. Makes no model call.
 * Uses the same builder as the on-the-fly path (api/_lib/retrieval/cards.js), so a stored card and a built card are identical.
 */
import { loadCards } from "../api/_lib/retrieval/cards.js";
import { writeStoredCards } from "../api/_lib/retrieval/cardStore.js";
const argv = process.argv.slice(2);
const dry = argv.includes("--dry-run");
const only = argv.includes("--tenant") ? argv[argv.indexOf("--tenant") + 1] : null;
const { default: pg } = await import("pg");
const pool = new pg.Pool({ connectionString: process.env.NEON_CONNECTION_STRING });
const tenants = (await pool.query("SELECT id, slug FROM tenants ORDER BY created_at")).rows.filter((t) => !only || t.slug === only);
// one transaction per organization with app.tenant_id set, so row-level security applies exactly as in the app; db.raw is the thin wrapper cards.js / cardStore.js expect
const inTenant = async (id, fn) => {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [id]);
    const out = await fn({ raw: (sql, params) => c.query(sql, params) });
    await c.query("COMMIT");
    return out;
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
};
let total = 0;
for (const t of tenants) {
  const ids = await inTenant(t.id, async (db) => (await db.raw("SELECT id FROM documents ORDER BY created_at")).rows.map((r) => r.id));
  for (let i = 0; i < ids.length; i += 60) {
    await inTenant(t.id, async (db) => {
      const cards = await loadCards(db, ids.slice(i, i + 60));
      if (!dry) await writeStoredCards(db, cards);
      total += cards.length;
    });
  }
  console.log(`${t.slug}: ${ids.length} documents${dry ? " (dry run)" : ""}`);
}
console.log(`cards ${dry ? "built" : "written"}: ${total}`);
await pool.end();
