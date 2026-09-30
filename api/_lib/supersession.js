/**
 * R31 Loop 3b: superseded-document flag.
 *
 * A document is SUPERSEDED when a newer upload carries the same business reference - the same invoice number, permit
 * number, or warranty serial number, under the same document type. The shop re-issued or renewed it; the older copy is
 * no longer the one to quote. Deliberately conservative: no reference number, no claim (a revised quote with no quote
 * number is NOT guessed at), and the newer copy is decided by upload time (created_at), never by parsing a free-form date.
 *
 * Read side only: one small tenant-scoped query, memoized per tenant for SUPERSEDED_FRESH_MS (uploads change it rarely),
 * and a pure, synchronous `annotateSuperseded` that api/ask.js's `send` calls on the finished answer. It never removes
 * or rewrites a fact; it (1) lists the replaced sources in `data.supersession` so the UI can say "replaced on <date>" and
 * offer the newer copy, and (2) when both copies are cited, moves the newer one first. Any failure = no annotation.
 *
 * Flag: DONOVAN_SUPERSEDED=0 turns the whole thing off (default on).
 */

const FRESH_MS = (() => { const n = Number(process.env.DONOVAN_SUPERSEDED_FRESH_MS); return Number.isFinite(n) && n >= 0 ? n : 15_000; })();
const MAX_TENANTS = 200;
const MAX_ENTRIES = 5000;
const memo = new Map(); // tenantKey -> { map, at }

export function isSupersessionEnabled(env = process.env) {
  return String(env.DONOVAN_SUPERSEDED ?? '1') !== '0';
}

// (document type, extraction field that identifies "the same document") - kept tiny on purpose.
export const SUPERSEDABLE = [
  ['invoice', 'invoice_number'],
  ['permit', 'permit_number'],
  ['warranty-registration', 'serial_number'],
];

export const SUPERSESSION_SQL = `
WITH refs AS (
  SELECT DISTINCT ON (d.id) d.id, d.document_type AS dtype, d.created_at, d.original_filename,
         lower(regexp_replace(x.value, '[^a-zA-Z0-9]', '', 'g')) AS ref
    FROM documents d
    JOIN extractions x ON x.document_id = d.id
   WHERE x.value IS NOT NULL
     AND ${SUPERSEDABLE.map(([t, f]) => `(d.document_type = '${t}' AND x.field_key = '${f}')`).join('\n      OR ')}
   ORDER BY d.id, x.created_at DESC
), ranked AS (
  SELECT r.*, ROW_NUMBER() OVER (PARTITION BY dtype, ref ORDER BY created_at DESC, id DESC) AS rn
    FROM refs r WHERE length(ref) >= 3
)
SELECT o.id AS document_id, n.id AS newer_id, n.created_at AS newer_at, n.original_filename AS newer_name
  FROM ranked o
  JOIN ranked n ON n.dtype = o.dtype AND n.ref = o.ref AND n.rn = 1
 WHERE o.rn > 1 AND n.created_at > o.created_at
 LIMIT ${MAX_ENTRIES}`;

function isoDay(v) {
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** @returns {Promise<Map<string,{replacedOn:string,replacedById:string,replacedByName:string|null}>>} */
export async function loadSupersessionMap(db) {
  const { rows } = await db.raw(SUPERSESSION_SQL, []);
  const map = new Map();
  for (const r of rows ?? []) {
    const on = isoDay(r.newer_at);
    if (!on || !r.document_id || !r.newer_id) continue;
    map.set(String(r.document_id), { replacedOn: on, replacedById: String(r.newer_id), replacedByName: r.newer_name ?? null });
  }
  return map;
}

/** Memoized per tenant; never throws (an empty map on any failure). `withTenant`/`ctxArg` are api/ask.js's own. */
export async function getSupersessionMap({ withTenant, ctxArg, tenantKey, env = process.env }) {
  if (!isSupersessionEnabled(env)) return new Map();
  const now = Date.now();
  const hit = FRESH_MS > 0 ? memo.get(tenantKey) : null;
  if (hit && now - hit.at < FRESH_MS) return hit.map;
  try {
    const map = await withTenant(ctxArg, (db) => loadSupersessionMap(db));
    if (FRESH_MS > 0) {
      if (memo.size >= MAX_TENANTS) memo.delete(memo.keys().next().value);
      memo.set(tenantKey, { map, at: Date.now() });
    }
    return map;
  } catch {
    return new Map();
  }
}

export function _resetSupersessionMemo() { memo.clear(); }

/**
 * Pure + synchronous. Mutates `data` in place (the answer cache stores what `send` sends). No-op on an empty map, a
 * non-answer, or an answer that cites nothing replaced. Returns the entries it attached.
 */
export function annotateSuperseded(data, map) {
  if (!map || map.size === 0 || !data || typeof data !== 'object' || data.kind !== 'answer') return [];
  const sources = Array.isArray(data.sources) ? data.sources : [];
  const cited = new Set();
  for (const s of sources) if (s && typeof s.documentId === 'string') cited.add(s.documentId);
  if (Array.isArray(data.records)) for (const r of data.records) if (r && typeof r.documentId === 'string') cited.add(r.documentId);
  const entries = [];
  for (const id of cited) {
    const m = map.get(id);
    if (m) entries.push({ documentId: id, ...m, newerAlsoCited: cited.has(m.replacedById) });
  }
  if (!entries.length) return [];
  data.supersession = entries;
  // Prefer the newer copy: when both are cited, the newer one leads the source list (stable otherwise).
  const newer = new Set(entries.filter((e) => e.newerAlsoCited).map((e) => e.replacedById));
  if (newer.size && sources.length > 1) {
    data.sources = [...sources.filter((s) => newer.has(s?.documentId)), ...sources.filter((s) => !newer.has(s?.documentId))];
  }
  return entries;
}
