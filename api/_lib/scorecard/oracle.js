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

/**
 * Run one oracle and derive the expected value.
 * @returns {Promise<{ok: true, expected: any, skip?: boolean, why?: string, rows: object[]} | {ok: false, error: string}>}
 */
export async function runOracle(withTenant, ctxArg, question, { today }) {
  const o = question?.oracle;
  if (!o || !oracleSqlOk(o.sql)) return { ok: false, error: "oracle-invalid" };
  const params = (o.params ?? []).map((p) => (p === "@today" ? today : p));
  try {
    const rows = await withTenant(ctxArg, async (db) => {
      await db.raw("SET LOCAL transaction_read_only = on", []);
      await db.raw(`SET LOCAL statement_timeout = ${ORACLE_TIMEOUT_MS}`, []);
      // Optional subject guard: a question about a named customer/address the shop does not have is skipped, not failed.
      if (o.requires && typeof o.requires.sql === "string") {
        if (!oracleSqlOk(o.requires.sql)) throw new Error("requires-invalid");
        const rp = (o.requires.params ?? []).map((p) => (p === "@today" ? today : p));
        const g = (await db.raw(o.requires.sql, rp)).rows?.[0] ?? {};
        if (Number(g.n ?? 0) === 0) return { __skip: "subject not in this shop's records" };
      }
      return (await db.raw(o.sql, params)).rows ?? [];
    });
    if (rows && rows.__skip) return { ok: true, skip: true, why: rows.__skip, expected: null, rows: [] };
    const e = expectedFromRows(question.cmp, rows);
    // An honest-zero question is only valid while its guard finds no data; once the data exists (e.g. the
    // financials layer landed) the question is skipped rather than failed.
    if (question.cmp === "honest-zero" && e.dataExists) return { ok: true, skip: true, why: "data now exists", expected: null, rows };
    return { ok: true, expected: e.expected, rows };
  } catch (err) {
    return { ok: false, error: `oracle-failed: ${String(err?.message ?? err).slice(0, 120)}` };
  }
}
