/**
 * dql/load.js - ONE tenant-scoped read of the organization's records per request: documents, extractions (a corrected value wins),
 * customers, equipment, links, financials and financial lines. db.raw + TENANT_SQL, the same way relations/timeline.js and compose.js read.
 * Merged entities are left out here (merged_into IS NULL); internal-audience documents are left out by the shared audience fragment
 * (audience/sql.js) and again by snapshot.js, which also never reads an HR letter.
 */
import { TENANT_SQL, todayIso } from '../scope.js';
import { documentsHaveAudience } from '../audience/probe.js';
import { audienceFilterSql } from '../audience/sql.js';
import { buildSnapshot } from './snapshot.js';
import { getCorpusStamp } from '../askCache.js';

// R19 (scale): rows are read in pages of PAGE_ROWS in heap order (ctid keyset), so a company of 100k papers is read whole instead of being cut at one
// LIMIT; only a table past the row cap (3,000,000 rows) is "truncated", and DQL then releases the question (never a partial answer).
const maxRows = () => (Number(process.env.DQL_MAX_ROWS) > 0 ? Number(process.env.DQL_MAX_ROWS) : 3000000);
const pageRows = () => (Number(process.env.DQL_PAGE_ROWS) > 0 ? Number(process.env.DQL_PAGE_ROWS) : 50000);

/** Every row of one tenant-scoped SELECT, PAGE_ROWS at a time in heap order (the order one unpaged scan returns, which snapshot.js's tie-breaks rely on).
 *  `selectFrom` = "SELECT <cols> FROM <table> <alias> WHERE <where>" (no ORDER/LIMIT). Returns {rows, truncated}. */
async function readAll(db, selectFrom, alias) {
  const rows = []; let after = null; const PAGE_ROWS = pageRows(); const MAX_ROWS = maxRows();
  for (;;) {
    const sql = `${selectFrom}${after ? ` AND ${alias}.ctid > '${after}'::tid` : ''} ORDER BY ${alias}.ctid LIMIT ${PAGE_ROWS}`;
    const r = await db.raw(sql.replace(/^SELECT /, `SELECT ${alias}.ctid::text AS _ctid, `), []);
    const got = r.rows ?? [];
    for (const g of got) { after = g._ctid; delete g._ctid; rows.push(g); }
    if (got.length < PAGE_ROWS) return { rows, truncated: false };
    if (rows.length >= MAX_ROWS) return { rows, truncated: true };
  }
}

export async function loadRaw(db) {
  const hasAudienceColumn = await documentsHaveAudience({ query: (sql, params) => db.raw(sql, params) });
  const audience = audienceFilterSql({ docAlias: 'd', hasAudienceColumn });
  const [docs, ex, ents, links] = await Promise.all([
    readAll(db, `SELECT d.id, d.original_filename, d.document_type, d.created_at FROM documents d WHERE d.${TENANT_SQL} AND (${audience})`, 'd'),
    readAll(db, `SELECT x.document_id, x.entity_id, x.field_key, x.value, x.corrected_value, x.created_at FROM extractions x WHERE x.${TENANT_SQL} AND x.field_key NOT LIKE '\\_%'`, 'x'),
    readAll(db, `SELECT e.id, e.entity_type, e.customer_id, e.customer_number, e.data, e.merged_into FROM entities e WHERE e.merged_into IS NULL AND e.entity_type IN ('customer', 'equipment') AND e.${TENANT_SQL}`, 'e'),
    readAll(db, `SELECT l.document_id, l.entity_id FROM document_entity_links l WHERE l.${TENANT_SQL}`, 'l'),
  ]);
  let financials = { rows: [], truncated: false }; let lines = { rows: [], truncated: false };
  // probe first: a failed statement would abort the surrounding transaction
  const has = await db.raw(`SELECT to_regclass('document_financials') IS NOT NULL AS ok`, []);
  if (has.rows?.[0]?.ok) {
    financials = await readAll(db, `SELECT f.* FROM document_financials f WHERE f.${TENANT_SQL}`, 'f');
    lines = await readAll(db, `SELECT l.id, l.financial_id, l.document_id, l.line_no, l.description, l.qty, l.unit_price, l.amount FROM document_financial_lines l WHERE l.${TENANT_SQL}`, 'l');
  }
  const rows = (r) => r.rows ?? [];
  const fin = financials.rows; const lns = lines.rows;
  // a read that hit the row limit is a partial picture: DQL then declines to answer rather than count a part as the whole
  const truncated = [docs, ex, ents, links, financials, lines].some((r) => r.truncated);
  const toIso = (v) => (v instanceof Date ? v.toISOString() : v);
  return {
    documents: rows(docs).map((d) => ({ ...d, created_at: toIso(d.created_at) })),
    extractions: rows(ex).map((e) => ({ ...e, created_at: toIso(e.created_at) })),
    entities: rows(ents),
    links: rows(links),
    financials: fin.map((f) => ({ ...f, invoice_date: toIso(f.invoice_date), due_date: toIso(f.due_date) })),
    lines: lns,
    truncated,
  };
}

async function loadSnapshotUncached(db, today) {
  const raw = await loadRaw(db);
  const snap = buildSnapshot(raw, { today });
  snap.truncated = Boolean(raw.truncated);
  return snap;
}

// R19 (scale): the built snapshot is kept per tenant and reused while the tenant's corpus stamp (the same data-version fingerprint the answer cache
// trusts: documents, extractions, links, entities, financials) and the day are unchanged. A read that races a write gets the older snapshot at worst
// for that one request, the same as the answer cache; a stamp that cannot be computed means no memo. Concurrent misses share one load.
// Kill switch: DONOVAN_SNAPCACHE=0. Callers must treat the snapshot as read-only (a request that needs extra state works on a shallow copy).
const SNAP_MEMO_MAX = 3;
const SNAP_MEMO_MAX_DOCS = 400000;
const snapMemo = new Map(); // tenantId -> { key, snap }
const inflight = new Map(); // `${tenantId}|${key}` -> Promise<snap>
const stampMemo = new Map(); // tenantId -> { stamp, at, cost }
export function _resetSnapshotMemo() { snapMemo.clear(); inflight.clear(); stampMemo.clear(); }
// The stamp is O(rows) to compute. On a big company (the stamp query took more than STAMP_SLOW_MS) a stamp is reused for up to STAMP_TTL_MS, so a write
// shows in answers within seconds instead of costing every question a table scan; small companies are checked on every question.
const STAMP_SLOW_MS = 120;
const STAMP_TTL_MS = process.env.DONOVAN_STAMP_TTL_MS != null ? Number(process.env.DONOVAN_STAMP_TTL_MS) : 3000;
async function stampFor(db, tenantId) {
  const m = stampMemo.get(tenantId);
  const now = Date.now();
  if (m && m.cost > STAMP_SLOW_MS && now - m.at < STAMP_TTL_MS) return m.stamp;
  const t0 = Date.now();
  const stamp = await getCorpusStamp(db);
  if (stamp) { stampMemo.set(tenantId, { stamp, at: Date.now(), cost: Date.now() - t0 }); while (stampMemo.size > 16) stampMemo.delete(stampMemo.keys().next().value); } else stampMemo.delete(tenantId);
  return stamp;
}

/** The snapshot DQL executes over (see snapshot.js for its shape). */
export async function loadSnapshot(db, { today } = {}) {
  const t = todayIso(today);
  const tenantId = db?.tenantId ?? null;
  if (!tenantId || process.env.DONOVAN_SNAPCACHE === '0') return loadSnapshotUncached(db, t);
  const stamp = await stampFor(db, tenantId);
  if (!stamp) return loadSnapshotUncached(db, t);
  const key = `${stamp}|${t}|${process.env.DONOVAN_CARD ?? ''}`;
  const hit = snapMemo.get(tenantId);
  if (hit && hit.key === key) { snapMemo.delete(tenantId); snapMemo.set(tenantId, hit); return hit.snap; }
  const fk = `${tenantId}|${key}`;
  let p = inflight.get(fk);
  if (!p) {
    p = loadSnapshotUncached(db, t).then((snap) => {
      if (!snap.truncated && snap.documents.length <= SNAP_MEMO_MAX_DOCS) {
        snapMemo.delete(tenantId); snapMemo.set(tenantId, { key, snap });
        while (snapMemo.size > SNAP_MEMO_MAX) snapMemo.delete(snapMemo.keys().next().value);
      }
      return snap;
    }).finally(() => inflight.delete(fk));
    inflight.set(fk, p);
  }
  return p;
}
