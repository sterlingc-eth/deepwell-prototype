/**
 * Shared record rules for the industry lanes (electrical, plumbing). One place for the data-state classes every lane must get right,
 * so a fix lands everywhere at once:
 *   - the effective value of a stored field is the human correction when there is one (an EMPTY correction means cleared), else the read value;
 *   - a value of only whitespace (any Unicode space, non-breaking space, zero-width marks) is empty, never a "result" or a "date";
 *   - tech-only (internal audience) documents never feed a lane answer;
 *   - one single-valued field that holds two different values is a CONFLICT: the lane declines rather than picking the first.
 */
import { documentsHaveAudience } from '../audience/probe.js';
import { audienceFilterSql } from '../audience/sql.js';

const INVISIBLE = new RegExp('[\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060-\\u2064\\ufeff\\u00ad\\u180e]', 'g');
const SPACES = new RegExp('[\\s\\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000]+', 'g');
/** Text as a person would read it: invisible marks removed, every kind of space collapsed, trimmed. Empty -> null. */
export function cleanValue(v) {
  if (v == null) return null;
  const s = String(v).replace(INVISIBLE, "").replace(SPACES, " ").trim();
  return s === '' ? null : s;
}

/** SQL (alias d) true for documents a lane may read: everything except tech-only (internal) documents. */
export async function laneAudienceSql(db, alias = 'd') {
  const run = typeof db.raw === 'function' ? db.raw.bind(db) : db.query.bind(db);
  const adapter = { query: async (s, p) => { const r = await run(s, p); return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length }; } };
  let has = false;
  try { has = await documentsHaveAudience(adapter); } catch { has = false; }
  return audienceFilterSql({ docAlias: alias, hasAudienceColumn: has });
}

/** Keys that hold ONE value per document. Two different readings of one of these on one document is a conflict. */
export function conflictKeys(d, keys) {
  const out = new Set();
  for (const k of keys) {
    const vs = new Set((d.all?.[k] ?? []).map((x) => String(x.value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).filter(Boolean));
    if (vs.size > 1) out.add(k);
  }
  return out;
}

/** True when any of these documents has a conflict on any of these keys. */
export const anyConflict = (docs, keys) => docs.some((d) => keys.some((k) => d.conflict?.has(k)));
