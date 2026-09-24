/**
 * Donovan agent — the SQL guard for run_query (api/_lib/agent/tools.js).
 *
 * LAYERED DEFENCE. This file is layer 1 of 4 and is deliberately paranoid, but
 * it is NOT what protects tenant data; if every rule here were bypassed the
 * remaining layers still hold:
 *   2. every statement runs inside withTenant(): app.tenant_id is SET LOCAL and
 *      every table the views touch (entities, extractions, documents,
 *      document_entity_links, facets, document_pages) is ENABLE + FORCE ROW
 *      LEVEL SECURITY, read by the non-owner NOBYPASSRLS role deepwell_rls;
 *   3. the transaction is switched to READ ONLY before the model's SQL runs;
 *   4. a 3 s statement_timeout, inside a SAVEPOINT so a failed query cannot
 *      poison the transaction.
 *
 * What the guard does: it does not try to "understand" SQL. It rejects
 * anything outside a small, boring subset:
 *   - one statement, SELECT/WITH only, no `;`, no comments, no `$` (dollar
 *     quoting), no backslash / E'' / U&'' strings, no quoted identifiers, no
 *     non-ASCII or control characters outside string literals (unicode
 *     whitespace / homoglyph tricks), balanced parentheses;
 *   - string literals are lexed out first and replaced with '' before any
 *     keyword check, so `WHERE city = 'Set'` is fine but SQL hiding in a
 *     literal is never executed anyway (no EXECUTE / query_to_xml allowed);
 *   - a denylist of statement keywords and system prefixes (pg_, lo_, dblink,
 *     information_schema, current_setting, set_config, ...);
 *   - the real table names are denied outright: the model queries the
 *     virtual views only, never `documents` / `tenants` / `users` directly;
 *   - every function call must be on an ALLOWLIST of plain read-only
 *     functions (so SECURITY DEFINER helpers such as list_ask_misses_window()
 *     and resolve_tenant() are unreachable).
 */

import { FINANCE_VIEW_NAMES, FINANCE_REAL_TABLES } from "./financeViews.js";

/** The virtual views tools.js prepends as a WITH clause. */
export const VIEW_NAMES = Object.freeze(["customers", "equipment", "documents_v", "facts", "doc_links", ...FINANCE_VIEW_NAMES]);

/** Every real table in M3-config (scripts/verify-agent.mjs cross-checks this
 *  against the migrations, so a new table cannot be forgotten). */
export const REAL_TABLES = Object.freeze([
  "tenants", "users", "documents", "document_pages", "facets", "proposals", "schema_versions",
  "extractions", "entities", "audit_log", "document_entity_links", "tenant_deletions", "api_keys",
  "usage_counters", "rate_limit_windows", "billing_events", "notifications_sent", "notifications",
  "ask_answer_cache", "tenant_outreach_settings", "outreach_messages", "ask_misses",
  "donovan_proposals", "donovan_learned", "platform_expenses", "ask_miss_replays",
  "donovan_scorecard_runs", "donovan_scorecard_results", // M3-config/30-donovan-scorecard.sql
  ...FINANCE_REAL_TABLES, // document_financials, document_financial_lines (M3-config/22)
  "page_chunks", "embedding_usage", // M3-config/31 (search by meaning)
]);

const DENY_TOKENS = new Set([
  // statements / DDL / DML / session control
  "insert", "update", "delete", "drop", "alter", "create", "grant", "revoke", "truncate", "copy", "set", "reset",
  "do", "call", "execute", "prepare", "deallocate", "declare", "listen", "notify", "unlisten", "vacuum", "analyze",
  "analyse", "explain", "cluster", "reindex", "refresh", "lock", "discard", "begin", "commit", "rollback",
  "savepoint", "release", "abort", "start", "checkpoint", "merge", "comment", "security", "import", "load",
  "show", "into", "returning", "recursive", "function", "procedure", "trigger", "extension", "language",
  "database", "schema", "role", "owner",
  // identity / settings / functions that leak or mutate
  "current_setting", "set_config", "current_user", "session_user", "user", "current_role", "current_catalog",
  "current_schema", "current_database", "dblink", "nextval", "setval", "currval", "lastval",
  // catalog-ish
  "information_schema", "pg_catalog", "regclass", "regproc", "regprocedure", "regoper", "regoperator",
  "regtype", "regnamespace", "regrole", "regconfig", "regdictionary", "oid", "xmin", "xmax", "ctid",
  // app SECURITY DEFINER helpers (also unreachable through the function allowlist)
  "resolve_tenant", "resolve_api_key", "get_request_context", "get_tenant_limits", "get_usage_counters",
  "increment_usage_counters", "increment_rate_limit_window", "list_ask_misses_window", "merge_tenant",
  "next_customer_number", "billing_apply", "billing_record_event", "billing_tenant_by_customer",
  "claim_platform_daily_task", "insert_platform_notification", "learning_decide", "learning_deactivate",
  "learning_get_proposal", "learning_insert_proposal", "learning_list_proposals",
  "list_notification_eligible_tenants", "list_outreach_enabled_tenants", "mark_outreach_swept",
  "mark_tenant_digest_sent", "mark_tenant_notified", "record_warranty_notification",
  "expenses_delete", "expenses_insert", "expenses_list", "expenses_totals", "expenses_update",
]);
const DENY_PREFIXES = ["pg_", "lo_", "dblink", "information_schema", "txid_", "xpath", "query_to_xml", "table_to_xml", "cursor_to_xml"];

/** Words that legitimately sit directly before `(` without being a function. */
const KEYWORDS_BEFORE_PAREN = new Set([
  "and", "or", "not", "in", "on", "as", "from", "join", "where", "when", "then", "else", "select", "having", "by",
  "over", "filter", "exists", "any", "all", "some", "union", "intersect", "except", "values", "using", "between",
  "like", "ilike", "is", "case", "distinct", "limit", "offset", "with", "lateral", "within", "group", "order",
  "partition", "rows", "range", "cross", "inner", "outer", "natural", "full", "interval", "array", "row", "at",
  "escape", "only", "table", "similar", "to", "asc", "desc", "nulls", "first", "last", "end", "unbounded",
  "preceding", "following", "current", "fetch", "next", "collate", "symmetric", "isnull", "notnull",
]);

/** Plain, read-only, non-amplifying functions. Anything else is rejected. */
const SAFE_FUNCTIONS = new Set([
  // aggregates / windows
  "count", "sum", "avg", "min", "max", "array_agg", "string_agg", "json_agg", "jsonb_agg", "bool_and", "bool_or",
  "every", "row_number", "rank", "dense_rank", "lag", "lead", "first_value", "last_value", "ntile", "percentile_cont",
  "percentile_disc", "mode",
  // null / conditional
  "coalesce", "nullif", "greatest", "least",
  // text
  "lower", "upper", "initcap", "length", "char_length", "left", "right", "substring", "substr", "trim", "btrim",
  "ltrim", "rtrim", "replace", "translate", "split_part", "position", "strpos", "concat", "concat_ws", "reverse",
  "starts_with", "regexp_replace", "regexp_match", "regexp_matches", "regexp_split_to_array", "regexp_split_to_table",
  "string_to_array", "array_to_string", "md5", "overlay",
  // numbers
  "abs", "round", "floor", "ceil", "ceiling", "trunc", "mod", "sign", "sqrt", "power", "div",
  // dates
  "date_trunc", "date_part", "extract", "age", "now", "make_date", "to_date", "to_char", "to_timestamp",
  "current_date", "current_timestamp", "localtimestamp", "localtime", "clock_timestamp", "date", "timestamp", "timestamptz",
  "generate_series",
  // arrays / json
  "unnest", "cardinality", "array_length", "array_position", "array_remove", "array_cat", "array_append",
  "jsonb_array_elements", "jsonb_array_elements_text", "jsonb_each", "jsonb_each_text", "jsonb_object_keys",
  "jsonb_extract_path", "jsonb_extract_path_text", "jsonb_build_object", "jsonb_build_array", "to_jsonb",
  "jsonb_typeof", "jsonb_array_length", "jsonb_path_exists", "json_build_object", "to_json",
  // type constructors used as casts: numeric(10,2) etc.
  "numeric", "decimal", "varchar", "char", "character", "bpchar", "time", "bit", "float", "int", "integer",
  "bigint", "smallint", "text", "boolean", "real", "double", "cast",
]);

/** The one place SQL text is measured; also the response to the model. */
export const MAX_SQL_CHARS = 4000;

/**
 * Lex out string literals. Returns {ok:false,error} or {ok:true, code} where
 * `code` is the SQL with every literal replaced by ''  (lowercased, ready for
 * token checks) and `literals` is the count.
 */
function stripLiterals(sql) {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    if (ch === "'") {
      // a prefix letter directly before the quote: E'..' (backslash escapes) is refused,
      // as is U&'..' (unicode escapes). B/X/N prefixes are harmless.
      const prev = out.length ? out[out.length - 1] : "";
      const prev2 = out.length > 1 ? out[out.length - 2] : "";
      if ((prev === "e" || prev === "E") && !/[A-Za-z0-9_]/.test(prev2)) return { ok: false, error: "escape strings (E'...') are not allowed" };
      if (prev === "&") return { ok: false, error: "unicode-escape strings are not allowed" };
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; }
          closed = true;
          break;
        }
        if (sql[j] === "\\") return { ok: false, error: "backslashes are not allowed" };
        j++;
      }
      if (!closed) return { ok: false, error: "unterminated string literal" };
      out += "''";
      i = j + 1;
      continue;
    }
    out += ch;
    i++;
  }
  return { ok: true, code: out };
}

/**
 * @param {unknown} rawSql
 * @returns {{ok: true, sql: string, startsWithWith: boolean, code: string} | {ok: false, error: string}}
 */
export function guardSql(rawSql) {
  if (typeof rawSql !== "string") return { ok: false, error: "sql must be a string" };
  const sql = rawSql.trim();
  if (!sql) return { ok: false, error: "sql is empty" };
  if (sql.length > MAX_SQL_CHARS) return { ok: false, error: `sql is too long (max ${MAX_SQL_CHARS} characters)` };

  // Character-level checks that must hold for the WHOLE text, literals included:
  // NUL / control characters (except tab, LF, CR) and backslashes.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(sql)) return { ok: false, error: "control characters are not allowed" };

  const lit = stripLiterals(sql);
  if (!lit.ok) return lit;
  const code = lit.code;

  // Everything outside literals must be plain ASCII (no NBSP, zero-width, fullwidth
  // semicolons, Cyrillic homoglyphs...).
  // eslint-disable-next-line no-control-regex
  if (/[^\u0009\u000a\u000d -~]/.test(code)) return { ok: false, error: "non-ASCII characters are only allowed inside string literals" };
  if (code.includes(";")) return { ok: false, error: "only a single statement is allowed (no semicolons)" };
  if (code.includes("--") || code.includes("/*") || code.includes("*/")) return { ok: false, error: "comments are not allowed" };
  if (code.includes("$")) return { ok: false, error: "dollar quoting / parameters are not allowed" };
  if (code.includes("\\")) return { ok: false, error: "backslashes are not allowed" };
  if (code.includes('"')) return { ok: false, error: "quoted identifiers are not allowed" };

  const lower = code.toLowerCase();
  const tokens = lower.match(/[a-z_][a-z0-9_]*|[0-9]+(?:\.[0-9]+)?|::|<=|>=|<>|!=|\|\||[^\s]/g) ?? [];
  if (!tokens.length) return { ok: false, error: "sql is empty" };

  // Must be a SELECT or a WITH ... SELECT.
  if (tokens[0] !== "select" && tokens[0] !== "with") return { ok: false, error: "only SELECT queries are allowed" };

  // Parentheses must balance and never go negative (no escaping the wrapper subquery).
  let depth = 0;
  for (const t of tokens) {
    if (t === "(") depth++;
    else if (t === ")") { depth--; if (depth < 0) return { ok: false, error: "unbalanced parentheses" }; }
  }
  if (depth !== 0) return { ok: false, error: "unbalanced parentheses" };

  const realTables = new Set(REAL_TABLES);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!/^[a-z_]/.test(t)) continue;
    if (DENY_TOKENS.has(t)) return { ok: false, error: `"${t}" is not allowed in a read-only query` };
    for (const p of DENY_PREFIXES) {
      if (t.startsWith(p)) return { ok: false, error: `"${t}" is not allowed in a read-only query` };
    }
    if (realTables.has(t)) {
      return { ok: false, error: `"${t}" is not queryable — use the views: ${VIEW_NAMES.join(", ")}` };
    }
    // Function-call check: a word directly followed by "(" is a call unless it is a keyword,
    // or the name in "AS name(" (CTE / alias with a column list).
    if (tokens[i + 1] === "(") {
      if (KEYWORDS_BEFORE_PAREN.has(t)) continue;
      if (tokens[i - 1] === "as") continue;
      if (!SAFE_FUNCTIONS.has(t)) {
        // "WITH name(col, ...) AS (" — a CTE definition with a column list, not a call.
        if (tokens[i - 1] === "with" || tokens[i - 1] === ",") {
          let d = 0;
          let j = i + 1;
          for (; j < tokens.length; j++) {
            if (tokens[j] === "(") d++;
            else if (tokens[j] === ")" && --d === 0) break;
          }
          if (tokens[j + 1] === "as" && tokens[j + 2] === "(") continue;
        }
        return { ok: false, error: `function "${t}" is not allowed` };
      }
    }
  }

  return { ok: true, sql, startsWithWith: tokens[0] === "with", code: lower };
}

/** Lower-cased word tokens of a guarded query (used to decide which derived data to load). */
export function referencedNames(guardedCode) {
  return new Set(String(guardedCode).match(/[a-z_][a-z0-9_]*/g) ?? []);
}

/**
 * Merge our view CTEs with the model's query and wrap it with the row cap.
 * `views` is the comma-separated CTE list (no leading WITH).
 * A model query that starts with its own WITH gets its CTEs appended after ours.
 */
export function wrapSql(guarded, views, rowCap) {
  const cap = Math.max(1, Math.min(1000, Math.trunc(rowCap) || 100));
  const body = guarded.startsWithWith
    ? `WITH ${views}, ${guarded.sql.replace(/^\s*with\s+/i, "")}`
    : `WITH ${views} ${guarded.sql}`;
  return `SELECT * FROM (${body}) q LIMIT ${cap}`;
}
