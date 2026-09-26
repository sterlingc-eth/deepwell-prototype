#!/usr/bin/env node
/**
 * OFFLINE EXAM — grades Donovan against the golden exam (test-docs/scorecard/exam.json) with $0 in model
 * calls, for the week the owner's Anthropic credits are exhausted.
 *
 * How: loads an admin data export (api/_lib/routes/tenant-export.js's JSON — documents, pages, extractions,
 * entities, document_entity_links, facets, document_financials[_lines]) into a REAL Postgres (PGlite, in
 * process, same M3-config/*.sql migrations every verify-*.mjs script uses) under a fresh tenant, then asks
 * every exam question through the REAL /api/ask handler in-process (api/_lib/scorecard/askCall.js — the exact
 * production code path, via the scorecard's own auth hook) with the Anthropic SDK's `messages.create` patched
 * to always throw. That means only a genuinely model-free answer path (fast path, the deterministic router,
 * financials, relations, analytics, contact/doc lookup, ...) can produce an answer; anything that reaches the
 * agent or the retrieval-synthesis step is caught here (by counting attempted model calls, not by guessing at
 * ask.js's internal fallback shape) and recorded as `needs-model`, never scored as wrong.
 *
 * Grading reuses the scorecard's own comparators (api/_lib/scorecard/compare.js) for every comparison type
 * that is mechanical (number, set, value, yesno, honest-zero, count-with-unknown) and its citation-precision
 * checker (citationCheck.js) — both pure/deterministic, no model. A `rubric` question (free-text, graded by
 * an LLM in production) cannot be graded here at all: it is recorded as `needs-grader`, not wrong.
 *
 * Usage:
 *   node scripts/offline-exam.mjs <export.json> [out.json] [out.md]
 *
 * out.json defaults to offline-exam-results.json next to the export file; out.md to offline-exam-report.md.
 * Whole run budgeted to finish well under 3 minutes (see runOfflineExam's own perf note) — there is no real
 * network and no model latency anywhere in this path.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");

/* ============================================================== PGlite harness (shared with verify-agent.mjs
 * / verify-scorecard.mjs's own pattern: real M3-config migrations, pg.Pool swapped for PGlite). Exposed as
 * `installPgHarness` / `createPGlite` / `setActiveDatabase` so scripts/verify-offline-exam.mjs can stand up TWO
 * independent databases in one process — one to seed fixtures and produce a synthetic export, a second,
 * completely fresh one to import that export into — without either script duplicating the migration-loading
 * code. */

const holder = { lite: null };
let harnessInstalled = false;

/** Load every M3-config migration (numeric prefix, skipping 99-founder-testing-limits.sql) into a fresh
 *  PGlite instance, exactly like verify-agent.mjs's own harness — 01b-app-role.sql re-run last since it
 *  depends on resolve_tenant() from a later file. */
export async function createPGlite() {
  const { PGlite } = await import("@electric-sql/pglite");
  const contrib = {};
  for (const key of ["uuid_ossp", "pgcrypto", "pg_trgm", "btree_gin"]) {
    contrib[key] = (await import(`@electric-sql/pglite/contrib/${key}`))[key];
  }
  const lite = new PGlite({ extensions: contrib });
  const cfgDir = path.join(ROOT, "M3-config");
  const migrations = fs.readdirSync(cfgDir).filter((f) => /^\d\d.*\.sql$/.test(f) && !f.startsWith("99")).sort();
  for (const f of migrations) {
    try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), "utf8")); }
    catch (err) { console.error(`NOTE  migration ${f} failed: ${err?.message}`); }
  }
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, "01b-app-role.sql"), "utf8")); } catch { /* dependency-order re-run, as verify-agent.mjs */ }
  return lite;
}

/** Point every future pg.Pool query/connect at `lite` (swap freely between two PGlite instances in the same
 *  process — recordsStore.js's cached tenant-context lookups are reset too, since a tenantKey resolved in one
 *  database is meaningless in the other). */
export async function setActiveDatabase(lite) {
  holder.lite = lite;
  try {
    const { _resetTenantContextCache } = await import("../api/_lib/recordsStore.js");
    _resetTenantContextCache();
  } catch { /* ok if recordsStore hasn't been imported yet */ }
}

/** Monkeypatch pg.Pool (once per process) to run every query against whatever `setActiveDatabase` last set. */
export async function installPgHarness() {
  if (harnessInstalled) return;
  harnessInstalled = true;
  process.env.NEON_CONNECTION_STRING ||= "postgres://harness:harness@localhost:5432/harness";
  const pgMod = (await import("pg")).default;
  let tail = Promise.resolve();
  const lock = () => { let release; const p = new Promise((r) => { release = r; }); const prev = tail; tail = tail.then(() => p); return prev.then(() => release); };
  pgMod.Pool.prototype.connect = async function connect() {
    const release = await lock();
    await holder.lite.exec("SET ROLE deepwell_rls");
    return {
      query: (sql, params) => holder.lite.query(sql, params),
      release: () => { holder.lite.exec("RESET ROLE").finally(release); },
    };
  };
  pgMod.Pool.prototype.query = async function query(sql, params) {
    const release = await lock();
    try { return await holder.lite.query(sql, params); } finally { release(); }
  };
}

/** Patch every Anthropic client's `messages.create` (shared class prototype — every `new Anthropic()` call
 *  site in the codebase gets the same instance method) to throw a non-retryable error. Returns a counter
 *  object `{ n }` the caller resets to 0 before each question and reads after: `n > 0` means SOME code path
 *  tried to reach the model for that question, whatever it did with the resulting error — the one thing that
 *  can never happen this week. A fake API key is set first so getApiKey() (claude.js) does not throw its own
 *  ConfigError before the call site is ever reached — we want the SAME code path a real model outage would
 *  hit, not an earlier one. */
export async function installModelBlock() {
  process.env.CLAUDE_API_KEY ||= "sk-ant-offline-exam-disabled";
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const probe = new Anthropic({ apiKey: "x" });
  const proto = Object.getPrototypeOf(probe.messages);
  const counter = { n: 0 };
  proto.create = async function offlineExamBlockedCreate() {
    counter.n += 1;
    const err = new Error("offline-exam: model calls are disabled for this run (Anthropic client mocked)");
    err.status = 400; // not one of isRetryableModelStatus's 429/529 — withBackoff throws immediately, no delay
    throw err;
  };
  return counter;
}

/* ============================================================== loading an export into a fresh tenant */

const insertableColumnsCache = new Map();

/** Every column of `table` a plain INSERT may target — i.e. not a generated column (document_pages.tsv, a
 *  tsvector search index, is one: Postgres refuses an explicit value, even NULL, for it). Cached per table
 *  per process since the schema never changes mid-run. */
async function insertableColumns(lite, table) {
  if (insertableColumnsCache.has(table)) return insertableColumnsCache.get(table);
  const { rows } = await lite.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND COALESCE(is_generated, 'NEVER') <> 'ALWAYS'
      ORDER BY ordinal_position`,
    [table]
  );
  const cols = rows.map((r) => r.column_name);
  insertableColumnsCache.set(table, cols);
  return cols;
}

/** INSERT INTO <table> (cols...) SELECT cols... FROM jsonb_populate_recordset(NULL::<table>, $1) — lets
 *  Postgres itself cast every column (jsonb, text[], numeric, date, uuid) from the export's plain JSON
 *  instead of hand-mapping columns here; the explicit column list (rather than a bare `SELECT *`) is what
 *  keeps this working on a table with a generated column. `table` is always one of our own fixed identifiers
 *  below, never user input. */
async function insertRows(lite, table, rows) {
  if (!rows || !rows.length) return;
  const cols = await insertableColumns(lite, table);
  const colList = cols.map((c) => `"${c}"`).join(", ");
  await lite.query(
    `INSERT INTO ${table} (${colList}) SELECT ${colList} FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb)`,
    [JSON.stringify(rows)]
  );
}

/**
 * Load one tenant-export.js/opsStore.exportTenant JSON payload into `lite` under a brand-new tenant, and
 * return that tenant's context. Every row's `tenant_id` is overwritten to the new tenant (an export's own
 * tenant_id values are meaningless outside the database it came from); rows whose required parent is
 * missing — possible if the export's own per-table row cap (opsStore.js EXPORT_ROW_CAP) truncated a parent
 * but not its children — are skipped rather than left to fail a foreign key at insert time, since a partial
 * offline exam is still worth grading.
 */
export async function loadExportIntoNewTenant(lite, exportData, { tenantKey = "offline-exam", tenantName = "Offline Exam" } = {}) {
  const { getTenantContext } = await import("../api/_lib/recordsStore.js");
  const tenantId = (await getTenantContext(tenantKey, tenantName)).id;
  const withId = (rows, extra = {}) => (Array.isArray(rows) ? rows : []).map((r) => ({ ...r, tenant_id: tenantId, ...extra }));

  const entities = Array.isArray(exportData.entities) ? exportData.entities : [];
  const entIds = new Set(entities.map((e) => e.id));
  // Self-referential FKs (customer_id, merged_into): insert every entity first with both nulled out, then
  // patch them in a second pass once every id in the export is known to exist in THIS database.
  await insertRows(lite, "entities", withId(entities, { customer_id: null, merged_into: null }));
  for (const e of entities) {
    const customerId = e.customer_id && entIds.has(e.customer_id) ? e.customer_id : null;
    const mergedInto = e.merged_into && entIds.has(e.merged_into) ? e.merged_into : null;
    if (customerId || mergedInto) {
      await lite.query("UPDATE entities SET customer_id = $2, merged_into = $3 WHERE id = $1 AND tenant_id = $4", [e.id, customerId, mergedInto, tenantId]);
    }
  }

  const documents = Array.isArray(exportData.documents) ? exportData.documents : [];
  const docIds = new Set(documents.map((d) => d.id));
  await insertRows(lite, "documents", withId(documents));

  const facets = (Array.isArray(exportData.facets) ? exportData.facets : []).filter((f) => docIds.has(f.document_id));
  const facetIds = new Set(facets.map((f) => f.id));
  await insertRows(lite, "facets", withId(facets));

  const extractions = (Array.isArray(exportData.extractions) ? exportData.extractions : []).filter((x) => docIds.has(x.document_id));
  await insertRows(lite, "extractions", withId(extractions).map((x) => ({ ...x, source_facet_id: x.source_facet_id && facetIds.has(x.source_facet_id) ? x.source_facet_id : null })));

  const pages = (Array.isArray(exportData.pages) ? exportData.pages : []).filter((p) => docIds.has(p.document_id));
  await insertRows(lite, "document_pages", withId(pages));

  const links = (Array.isArray(exportData.document_entity_links) ? exportData.document_entity_links : []).filter((l) => docIds.has(l.document_id) && entIds.has(l.entity_id));
  await insertRows(lite, "document_entity_links", withId(links));

  const financials = (Array.isArray(exportData.financials) ? exportData.financials : []).filter((f) => docIds.has(f.document_id));
  const finIds = new Set(financials.map((f) => f.id));
  if (financials.length) await insertRows(lite, "document_financials", withId(financials));
  const financialLines = (Array.isArray(exportData.financial_lines) ? exportData.financial_lines : []).filter((l) => finIds.has(l.financial_id) && docIds.has(l.document_id));
  if (financialLines.length) await insertRows(lite, "document_financial_lines", withId(financialLines));

  // ANALYZE (2026-09-26, golden-tenant perf fix): a fresh PGlite database has NO table
  // statistics after a bulk INSERT (autovacuum never gets a chance to run before the exam
  // starts asking questions), so the planner falls back to flat per-table row-count guesses
  // and picks catastrophic nested-loop plans for any query joining several tables with an OR
  // condition (exactly the shape every "connect"-family oracle question uses: "document links
  // to EITHER the customer directly OR the customer's equipment"). Measured on the golden
  // tenant (scripts/golden/): one such query went from ~58s to ~44ms after this ANALYZE alone
  // — same rows back (this changes only the plan, never a result), so it is safe for every
  // caller, not just the golden tenant. Runs once per loaded tenant, right after the data that
  // needs statistics exists; a real Postgres would have this from autovacuum/pg_cron and never
  // notices the difference.
  await lite.exec("ANALYZE");

  return {
    ctx: { tenantKey, tenantName },
    tenantId,
    counts: { entities: entities.length, documents: documents.length, facets: facets.length, extractions: extractions.length, pages: pages.length, links: links.length, financials: financials.length, financialLines: financialLines.length },
  };
}

/* ============================================================== the exam run */

const PASS_THROUGH_CMP = new Set(["number", "set", "value", "yesno", "honest-zero", "count-with-unknown"]);

function emptyBucket() {
  return { total: 0, answeredWithoutModel: 0, correct: 0, wrong: 0, needsModel: 0, needsGrader: 0, skipped: 0, oracleError: 0, cited: 0, citationChecked: 0, citationSupportRate: [], latenciesMs: [] };
}

function fold(bucket, r) {
  bucket.total += 1;
  if (r.status === "oracle-error") { bucket.oracleError += 1; return; }
  if (r.status === "skipped") { bucket.skipped += 1; return; }
  if (r.status === "needs-model") { bucket.needsModel += 1; bucket.latenciesMs.push(r.latencyMs); return; }
  bucket.answeredWithoutModel += 1;
  bucket.latenciesMs.push(r.latencyMs);
  if (r.status === "needs-grader") { bucket.needsGrader += 1; return; }
  if (r.status === "correct") bucket.correct += 1; else bucket.wrong += 1;
  if (r.cited) bucket.cited += 1;
  if (typeof r.citationPrecision === "number") { bucket.citationChecked += 1; bucket.citationSupportRate.push(r.citationPrecision); }
}

function summarize(bucket) {
  const avg = (arr) => (arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null);
  const sorted = [...bucket.latenciesMs].sort((a, b) => a - b);
  const pct = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);
  const graded = bucket.correct + bucket.wrong;
  return {
    total: bucket.total,
    answeredWithoutModel: bucket.answeredWithoutModel,
    correct: bucket.correct,
    wrong: bucket.wrong,
    accuracy: graded ? Math.round((bucket.correct / graded) * 1000) / 1000 : null,
    needsModel: bucket.needsModel,
    needsGrader: bucket.needsGrader,
    skipped: bucket.skipped,
    oracleError: bucket.oracleError,
    citationPresenceRate: bucket.answeredWithoutModel - bucket.needsGrader > 0 ? Math.round((bucket.cited / (bucket.answeredWithoutModel - bucket.needsGrader)) * 1000) / 1000 : null,
    citationSupportRate: avg(bucket.citationSupportRate),
    latencyMsAvg: avg(bucket.latenciesMs),
    latencyMsP50: pct(50),
    latencyMsP95: pct(95),
  };
}

/**
 * Run the whole exam (or a subset, for the smoke test) against one already-loaded tenant, through the real
 * /api/ask handler, with the model blocked. Sequential (not batched): every question here is either a fast,
 * in-process PGlite query or an immediate thrown error — there is no real model latency or network to hide
 * behind concurrency, so a plain loop keeps the model-call counter unambiguous (one question at a time, no
 * risk of one question's attempted call being credited to another running alongside it) and the whole 746-
 * question exam still finishes in well under 3 minutes.
 *
 * @param {object} p
 * @param {{tenantKey: string, tenantName?: string}} p.ctx
 * @param {object[]} p.questions  exam.json's `questions` (or a subset)
 * @param {string} p.today  'YYYY-MM-DD'
 * @param {{n: number}} p.modelCounter  from installModelBlock()
 * @returns {Promise<{perQuestion: object[], overall: object, byCategory: object}>}
 */
export async function runOfflineExam({ ctx, questions, today, modelCounter }) {
  const { withTenant } = await import("../api/_lib/recordsStore.js");
  const { runOracle } = await import("../api/_lib/scorecard/oracle.js");
  const { compareAnswer, summarizeExpected } = await import("../api/_lib/scorecard/compare.js");
  const { checkCitationPrecision } = await import("../api/_lib/scorecard/citationCheck.js");
  const { askViaHandler } = await import("../api/_lib/scorecard/askCall.js");
  const { default: askHandler } = await import("../api/ask.js");

  const auth = { tenantId: ctx.tenantKey, orgId: ctx.tenantName ?? ctx.tenantKey, userId: null };
  const perQuestion = [];

  for (const q of questions) {
    const base = { id: q.id, category: q.category, cmp: q.cmp, question: q.text };
    const oracle = await runOracle(withTenant, ctx, q, { today });
    if (!oracle.ok) { perQuestion.push({ ...base, status: "oracle-error", error: oracle.error, latencyMs: 0 }); continue; }
    if (oracle.skip) { perQuestion.push({ ...base, status: "skipped", why: oracle.why, latencyMs: 0 }); continue; }

    modelCounter.n = 0;
    const started = Date.now();
    let asked;
    try {
      asked = await askViaHandler({ handler: askHandler, auth, question: q.text, today });
    } catch (err) {
      // askCall.js swallows every error except ModelBudgetExceededError (a real daily-spend cap, unrelated
      // to the model being mocked) and rethrows that one — should not happen with a fresh, zero-usage
      // tenant, but if it does, this question simply cannot be asked this run; skip rather than crash the
      // whole exam over one question.
      perQuestion.push({ ...base, status: "skipped", why: `ask threw: ${err?.name ?? err?.message ?? err}`, latencyMs: Date.now() - started });
      continue;
    }
    const latencyMs = Date.now() - started;

    if (modelCounter.n > 0) { perQuestion.push({ ...base, status: "needs-model", latencyMs }); continue; }

    if (!asked.data) {
      perQuestion.push({ ...base, status: "wrong", expected: summarizeExpected({ ...q, expected: oracle.expected }), got: `error: ${asked.error ?? "no response"}`, latencyMs });
      continue;
    }
    if (q.cmp === "rubric" || !PASS_THROUGH_CMP.has(q.cmp)) {
      perQuestion.push({ ...base, status: "needs-grader", latencyMs });
      continue;
    }

    const graded = compareAnswer({ cmp: q.cmp, expected: oracle.expected, question: q.text, citationRequired: q.citationRequired, alts: oracle.alts, tolerance: q.tolerance, anyNumber: q.anyNumber }, asked.data);
    let citationPrecision;
    if (graded.cited) {
      const cp = await checkCitationPrecision(withTenant, ctx, asked.data);
      if (typeof cp.precision === "number") citationPrecision = cp.precision;
    }
    perQuestion.push({
      ...base, status: graded.passed ? "correct" : "wrong", cited: Boolean(graded.cited), citationPrecision,
      expected: graded.expectedSummary, got: graded.got, latencyMs,
    });
  }

  const overallBucket = emptyBucket();
  const catBuckets = new Map();
  for (const r of perQuestion) {
    fold(overallBucket, r);
    if (!catBuckets.has(r.category)) catBuckets.set(r.category, emptyBucket());
    fold(catBuckets.get(r.category), r);
  }
  const byCategory = Object.fromEntries([...catBuckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, summarize(v)]));

  return { perQuestion, overall: summarize(overallBucket), byCategory };
}

/* ============================================================== markdown report */

export function renderMarkdownReport({ tenantKey, examVersion, generatedAt, durationMs, overall, byCategory, perQuestion, counts }) {
  const pct = (n) => (n == null ? "—" : `${Math.round(n * 1000) / 10}%`);
  const row = (name, s) => `| ${name} | ${s.total} | ${s.answeredWithoutModel} | ${s.correct} | ${s.wrong} | ${pct(s.accuracy)} | ${s.needsModel} | ${s.needsGrader} | ${s.skipped} | ${pct(s.citationPresenceRate)} | ${s.latencyMsAvg ?? "—"} |`;
  const lines = [
    `# Offline exam report`,
    ``,
    `Tenant: \`${tenantKey}\` · exam version \`${examVersion}\` · generated ${generatedAt} · run took ${Math.round(durationMs / 1000)}s`,
    counts ? `Loaded from export: ${counts.documents} documents, ${counts.entities} entities, ${counts.extractions} extractions, ${counts.links} links, ${counts.financials} money documents.` : "",
    ``,
    `**$0 in model calls.** Only questions Donovan's no-model paths (fast path, deterministic router, financials, relations, analytics, contact/doc lookup) could answer on their own are graded; anything that would have reached the agent or model-based retrieval synthesis is counted under **needs-model**, not wrong. Free-text \`rubric\` questions cannot be graded without the LLM grader and are counted under **needs-grader**.`,
    ``,
    `| Category | N | Answered w/o model | Correct | Wrong | Accuracy | Needs model | Needs grader | Skipped | Citation presence | Avg ms |`,
    `|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|`,
    row("**Overall**", overall),
    ...Object.entries(byCategory).map(([cat, s]) => row(cat, s)),
    ``,
    `## Wrong answers`,
    ``,
  ];
  const wrong = perQuestion.filter((r) => r.status === "wrong");
  if (!wrong.length) {
    lines.push("None.");
  } else {
    lines.push(`| id | category | expected | got |`, `|---|---|---|---|`);
    for (const r of wrong) lines.push(`| ${r.id} | ${r.category} | ${String(r.expected).replace(/\|/g, "\\|").slice(0, 120)} | ${String(r.got).replace(/\|/g, "\\|").slice(0, 120)} |`);
  }
  lines.push(``, `## Limits`, ``,
    `- Requires an admin data export (POST /api/tenant-export) taken while credits were still available; this script does not talk to a live database.`,
    `- \`rubric\`-graded exam questions (free text) are marked \`needs-grader\` — they need the LLM grader (api/_lib/scorecard/grader.js) production uses, which itself needs a model.`,
    `- A question whose real answer requires the agent (multi-hop reasoning, ranking, most "explain"/"persona" questions) is marked \`needs-model\`, not wrong — this offline exam measures the no-model floor, not full Donovan accuracy.`,
    `- The export's own per-table row cap (opsStore.js EXPORT_ROW_CAP, 5000) can truncate a very large tenant; a \`truncated\` export still loads (see \`counts\` above) but oracle answers computed here are only as complete as the export itself.`,
  );
  return lines.filter((l) => l !== "").join("\n") + "\n";
}

/* ============================================================== CLI */

async function main() {
  const [exportPath, outJsonArg, outMdArg] = process.argv.slice(2);
  if (!exportPath) {
    console.error("Usage: node scripts/offline-exam.mjs <export.json> [out.json] [out.md]");
    process.exit(2);
  }
  const outJson = outJsonArg ?? path.join(path.dirname(path.resolve(exportPath)), "offline-exam-results.json");
  const outMd = outMdArg ?? (/\.json$/i.test(outJson) ? outJson.replace(/\.json$/i, ".md") : `${outJson}.md`);

  const exportData = JSON.parse(fs.readFileSync(path.resolve(exportPath), "utf8"));

  await installPgHarness();
  const modelCounter = await installModelBlock();
  const lite = await createPGlite();
  await setActiveDatabase(lite);

  const { loadExam } = await import("../api/_lib/scorecard/exam.js");
  const exam = loadExam();
  if (!exam.questions.length) {
    console.error("offline-exam: test-docs/scorecard/exam.json not found or empty — run `node scripts/gen-scorecard.mjs` first.");
    process.exit(1);
  }

  const started = Date.now();
  const { ctx, counts } = await loadExportIntoNewTenant(lite, exportData, { tenantKey: exportData.tenantKey ? `offline:${exportData.tenantKey}` : "offline-exam", tenantName: "Offline Exam" });
  const today = new Date().toISOString().slice(0, 10);
  const { perQuestion, overall, byCategory } = await runOfflineExam({ ctx, questions: exam.questions, today, modelCounter });
  const durationMs = Date.now() - started;

  const resultsJson = { version: exam.version, tenantKey: exportData.tenantKey ?? null, exportedAt: exportData.exportedAt ?? null, generatedAt: new Date().toISOString(), durationMs, counts, overall, byCategory, perQuestion };
  fs.mkdirSync(path.dirname(path.resolve(outJson)), { recursive: true });
  fs.writeFileSync(outJson, JSON.stringify(resultsJson, null, 2));
  fs.writeFileSync(outMd, renderMarkdownReport({ tenantKey: exportData.tenantKey ?? "(unknown)", examVersion: exam.version, generatedAt: resultsJson.generatedAt, durationMs, overall, byCategory, perQuestion, counts }));

  console.log(`offline-exam: ${exam.questions.length} questions in ${Math.round(durationMs / 1000)}s -> ${outJson}, ${outMd}`);
  console.log(JSON.stringify(overall));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch((err) => { console.error(err); process.exit(1); });
