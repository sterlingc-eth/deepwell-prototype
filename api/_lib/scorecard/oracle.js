/**
 * Donovan Scorecard - the ORACLE runner.
 *
 * Every exam question carries a small SQL query over the shop's BASE tables (entities, documents,
 * extractions, document_entity_links, document_pages) that computes the expected answer for the current
 * data. It deliberately shares NO code with Donovan's own paths (no views, no analytics.js, no agent tools):
 * a bug in Donovan's geography / warranty / linking logic must not also live in the answer key.
 *
 * Safety: the SQL comes from the checked-in exam file (never from a request), must be a single SELECT/WITH,
 * and runs inside the tenant transaction (RLS scopes every table to the tenant, FORCE ROW LEVEL SECURITY) as
 * READ ONLY with a statement timeout. Parameters are positional; the sentinel "@today" is replaced with the
 * run's date.
 */
import { expectedFromRows } from "./compare.js";

export const ORACLE_TIMEOUT_MS = 5000;
const SINGLE_SELECT_RE = /^\s*(?:with|select)\b/i;

/** Pure: is this oracle SQL acceptable to run? (one statement, read-only shape). */
export function oracleSqlOk(sql) {
  if (typeof sql !== "string" || !SINGLE_SELECT_RE.test(sql)) return false;
  if (/;\s*\S/.test(sql)) return false;
  if (/\b(?:insert|update|delete|drop|alter|create|grant|revoke|truncate|copy)\b/i.test(sql.replace(/'(?:[^']|'')*'/g, "''"))) return false;
  return true;
}

const MISSING_TABLE_RE = /42P01|relation "?[\w.]+"? does not exist/i;

/**
 * Run one oracle and derive the expected value.
 *
 * Optional question fields it honours:
 *   oracle.requires {sql, params}  guard: n = 0 -> the subject / data is not in this shop's records -> SKIP (not fail)
 *   oracle.alt {sql, params, says}  a second defensible definition: rows {n, says?} -> `alts` for the number comparator
 *   maxItems                        a set longer than this is too long for a chat answer to be graded as a list -> SKIP
 * A query that fails because a table does not exist (the financials migration not pasted yet) retires the question
 * gracefully: it is SKIPPED, never failed.
 * @returns {Promise<{ok: true, expected: any, alts?: object[], skip?: boolean, why?: string, rows: object[]} | {ok: false, error: string}>}
 */
export async function runOracle(withTenant, ctxArg, question, { today }) {
  const o = question?.oracle;
  if (!o || !oracleSqlOk(o.sql)) return { ok: false, error: "oracle-invalid" };
  const bind = (list) => (list ?? []).map((p) => (p === "@today" ? today : p));
  try {
    const res = await withTenant(ctxArg, async (db) => {
      await db.raw("SET LOCAL transaction_read_only = on", []);
      await db.raw(`SET LOCAL statement_timeout = ${ORACLE_TIMEOUT_MS}`, []);
      // Optional subject guard: a question about a named customer/address the shop does not have is skipped, not failed.
      if (o.requires && typeof o.requires.sql === "string") {
        if (!oracleSqlOk(o.requires.sql)) throw new Error("requires-invalid");
        const g = (await db.raw(o.requires.sql, bind(o.requires.params))).rows?.[0] ?? {};
        if (Number(g.n ?? 0) === 0) return { __skip: "subject or data not in this shop's records" };
      }
      const rows = (await db.raw(o.sql, bind(o.params))).rows ?? [];
      let altRows = [];
      if (o.alt && typeof o.alt.sql === "string" && oracleSqlOk(o.alt.sql)) altRows = (await db.raw(o.alt.sql, bind(o.alt.params))).rows ?? [];
      return { rows, altRows };
    });
    if (res.__skip) return { ok: true, skip: true, why: res.__skip, expected: null, rows: [] };
    const { rows, altRows } = res;
    const e = expectedFromRows(question.cmp, rows);
    // An honest-zero question is only valid while its guard finds no data; once the data exists (e.g. the
    // financials layer landed) the question is skipped rather than failed.
    if (question.cmp === "honest-zero" && e.dataExists) return { ok: true, skip: true, why: "data now exists", expected: null, rows };
    if (question.cmp === "set" && Number.isFinite(question.maxItems) && e.expected.length > question.maxItems) {
      return { ok: true, skip: true, why: `list of ${e.expected.length} is too long to grade (max ${question.maxItems})`, expected: null, rows: [] };
    }
    const alts = altRows
      .map((r) => ({ expected: Number(r.n ?? r.v), says: String(r.says ?? o.alt?.says ?? "") }))
      .filter((a) => Number.isFinite(a.expected) && a.says);
    return { ok: true, expected: e.expected, ...(alts.length ? { alts } : {}), rows };
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (MISSING_TABLE_RE.test(msg + String(err?.code ?? ""))) return { ok: true, skip: true, why: "table not present yet (migration not applied)", expected: null, rows: [] };
    return { ok: false, error: `oracle-failed: ${msg.slice(0, 120)}` };
  }
}
