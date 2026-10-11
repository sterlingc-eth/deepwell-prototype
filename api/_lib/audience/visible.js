/**
 * audience/visible.js - the ONE "papers an answer may count" fragment for lanes that count or group documents in the business as a whole:
 * People / HR papers and internal-audience papers are both left out, so a total ("how many documents") and a by-type list always agree.
 *   visibleDocSql(db, alias) -> WHERE-safe SQL text, TRUE for a paper that may be counted
 */
import { documentsHaveAudience } from './probe.js';
import { audienceFilterSql } from './sql.js';
import { notPrivateSql } from '../privacy/privateDocs.js';

export async function visibleDocSql(db, alias = 'd') {
  try {
    const q = typeof db.query === 'function' ? db : { query: (sql, params) => db.raw(sql, params) };
    return audienceFilterSql({ docAlias: alias, hasAudienceColumn: await documentsHaveAudience(q) });
  } catch { return notPrivateSql(alias); }
}
