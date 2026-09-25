/**
 * Donovan Scorecard - the CLAUDE BASELINE (TEAM T3, 2026-09-25).
 *
 * "Is Donovan as good as Claude with full access to the documents?" That is the new yardstick: for a
 * question, this gives SONNET (never Opus) a generous budget and DIRECT full-text access to the documents
 * the oracle's own answer is drawn from - an "open-book, best-case" run - and stores the answer. The
 * scorecard then reports, per category, Donovan's score vs this baseline's score and the GAP between them.
 * The target this exam holds Donovan to is: Donovan >= baseline on every category.
 *
 * SCOPE ("the oracle's own candidate set"): a question can carry an optional `oracle.scope` {sql, params} -
 * a query returning the exact `document_id`s its own answer is drawn from. It is populated for the new
 * CONNECT category (see test-docs/scorecard/breadth.mjs's VISIT_ROWS/subj-derived doc sets) where the
 * pattern the exam is built around (repeat failures, quoted-but-never-replaced, missing warranty
 * registrations, callbacks, mismatched invoices, conflicting facts) makes "which documents does this need"
 * unambiguous. A question with no `oracle.scope` falls back to a keyword-narrowed full-text search over
 * document_pages (the significant words in the question itself) - still open-book and direct, just not
 * literally the oracle's own candidate set; this shortcut is documented HERE rather than overclaimed.
 *
 * Cost-bounded (env DONOVAN_BASELINE_BUDGET_USD, default $8) and paged the same way runner.js pages a
 * scorecard run (a request's own deadline, not a fixed count). CACHED per (tenant, exam version, question
 * id) via baselineStore.js: once a question has a stored baseline for the CURRENT exam version it is never
 * re-asked, so a re-run only pays for the questions the exam actually changed.
 *
 * No question text or document text is logged; console output carries counts and ids only.
 */
import Anthropic from "@anthropic-ai/sdk";
import { getApiKey, MODEL_TIMEOUT_MS, withBackoff } from "../claude.js";
import { recordModelCall, estimateModelCostUsd } from "../usage.js";
import { escalationModel } from "../agent/escalation.js";
import { runOracle } from "./oracle.js";
import { gradeAnswer } from "./runner.js";
import { getBaseline, saveBaseline, listBaselines } from "./baselineStore.js";

export const DEFAULT_BASELINE_BUDGET_USD = 8;
export const DEFAULT_BASELINE_PAGE_SIZE = 6;
export const MIN_BASELINE_QUESTION_MS = 20_000;
export const MAX_SCOPE_DOCS = 12;
export const MAX_SCOPE_CHARS = 24_000;
export const BASELINE_MAX_TOKENS = 900;

export const baselineModel = (env = process.env) => escalationModel(env); // Sonnet, same id the scorecard's own escalation retry uses - never Opus

export const baselineBudgetUsd = (env = process.env) => {
  const n = Number(env?.DONOVAN_BASELINE_BUDGET_USD);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BASELINE_BUDGET_USD;
};

const STOPWORDS = new Set([
  "that", "this", "with", "have", "from", "were", "been", "what", "when", "which", "where", "does", "doesn",
  "didn", "their", "there", "about", "would", "could", "should", "customer", "customers", "document",
  "documents", "unit", "units", "many", "have", "these", "those", "since", "into", "than",
]);

/** Pure: the significant (>=4 letters, not a stopword) words in a question - the fallback keyword scope. */
export function keywordsOf(text) {
  const words = [...new Set(String(text ?? "").toLowerCase().match(/[a-z']{4,}/g) ?? [])];
  return words.filter((w) => !STOPWORDS.has(w)).slice(0, 6);
}

/**
 * The candidate document ids a question's answer should be drawn from: the oracle's own scope when the
 * question carries one, else the keyword fallback described above.
 */
export async function candidateDocIds(db, question, { today }) {
  const scope = question?.oracle?.scope;
  if (scope && typeof scope.sql === "string") {
    const bind = (list) => (list ?? []).map((p) => (p === "@today" ? today : p));
    const { rows } = await db.raw(scope.sql, bind(scope.params));
    return [...new Set(rows.map((r) => r.document_id).filter(Boolean))].slice(0, MAX_SCOPE_DOCS);
  }
  const words = keywordsOf(question?.text);
  if (!words.length) {
    const { rows } = await db.raw(`SELECT id AS document_id FROM documents ORDER BY created_at DESC LIMIT ${MAX_SCOPE_DOCS}`, []);
    return rows.map((r) => r.document_id);
  }
  const like = words.map((w) => `%${w.replace(/[%_\\]/g, (m) => `\\${m}`)}%`);
  const clause = words.map((_, i) => `p.text ILIKE $${i + 1}`).join(" OR ");
  const { rows } = await db.raw(`SELECT DISTINCT p.document_id FROM document_pages p WHERE (${clause}) LIMIT ${MAX_SCOPE_DOCS}`, like);
  return rows.map((r) => r.document_id);
}

/** The candidate documents' own full text, one labelled block per document, capped so the prompt stays bounded. */
export async function scopeText(db, docIds) {
  if (!docIds.length) return { text: "", docIds: [] };
  const { rows } = await db.raw(
    `SELECT d.id, d.original_filename, d.document_type, p.page_no, p.text FROM documents d JOIN document_pages p ON p.document_id = d.id
      WHERE d.id = ANY($1::uuid[]) ORDER BY d.id, p.page_no`,
    [docIds]);
  const byDoc = new Map();
  for (const r of rows) {
    if (!byDoc.has(r.id)) byDoc.set(r.id, { name: r.original_filename, type: r.document_type, pages: [] });
    byDoc.get(r.id).pages.push(`[page ${r.page_no}] ${r.text ?? ""}`);
  }
  let out = ""; let budget = MAX_SCOPE_CHARS; const used = [];
  for (const [id, doc] of byDoc) {
    const block = `\n=== document ${id} (${doc.type ?? "unknown"} - ${doc.name}) ===\n${doc.pages.join("\n")}\n`;
    if (block.length > budget) { out += block.slice(0, Math.max(0, budget)); used.push(id); break; }
    out += block; budget -= block.length; used.push(id);
  }
  return { text: out, docIds: used };
}

const BASELINE_SYSTEM = `You are answering a question about an HVAC shop's own records using ONLY the documents given to you below - this is an open-book test of what a careful reader with full document access would conclude. Read every document. Give the single best, most complete answer the documents support. If the documents do not contain the answer, say so plainly rather than guessing. Cite the document(s) your answer relies on by their "document <id>" label. Call the answer tool once.`;

const ANSWER_TOOL = {
  name: "answer",
  description: "Record the answer.",
  input_schema: {
    type: "object",
    properties: {
      text: { type: "string", description: "The answer, in a sentence or two, as you would say it to the shop owner." },
      facts: {
        type: "array", description: "Optional structured facts backing the answer (name/value pairs, list items, figures).",
        items: { type: "object", properties: { label: { type: "string" }, value: { type: "string" } }, required: ["label", "value"] },
      },
      citedDocumentIds: { type: "array", items: { type: "string" }, description: "The document ids (from the '=== document <id> ...' headers) the answer relies on." },
    },
    required: ["text"],
  },
};

async function defaultCallModel(req, { deadlineAt }) {
  const client = new Anthropic({ apiKey: getApiKey(), timeout: MODEL_TIMEOUT_MS, maxRetries: 0 });
  return withBackoff(() => client.messages.create(req, { timeout: Math.max(1000, deadlineAt - Date.now()) }), { deadlineAt });
}

/**
 * Ask the baseline model one question, open-book, over the given document text. Returns an answer shaped
 * exactly like an /api/ask `data` payload (kind/text/facts/sources) so it can be graded with the SAME
 * compareAnswer/gradeRubric path a Donovan answer is graded with (runner.js's gradeAnswer, reused as-is).
 */
export async function askBaseline({ ctxArg, question, docText, docIds, callModel = defaultCallModel, deadlineAt = Date.now() + 60_000, model = baselineModel() }) {
  const started = Date.now();
  const user = docText
    ? `DOCUMENTS:\n${docText}\n\nQUESTION: ${question.text}`
    : `No documents matched this question in this shop's records.\n\nQUESTION: ${question.text}`;
  try {
    const resp = await callModel(
      {
        model, max_tokens: BASELINE_MAX_TOKENS, temperature: 0,
        system: [{ type: "text", text: BASELINE_SYSTEM }],
        tools: [ANSWER_TOOL], tool_choice: { type: "tool", name: "answer" },
        messages: [{ role: "user", content: [{ type: "text", text: user }] }],
      },
      { deadlineAt }
    );
    const u = resp?.usage ?? {};
    const usage = { inputTokens: Number(u.input_tokens) || 0, outputTokens: Number(u.output_tokens) || 0, cacheReadInputTokens: Number(u.cache_read_input_tokens) || 0, cacheCreationInputTokens: Number(u.cache_creation_input_tokens) || 0 };
    await recordModelCall(ctxArg, { ...usage, model });
    const costUsd = estimateModelCostUsd(model, usage);
    const use = (Array.isArray(resp?.content) ? resp.content : []).find((b) => b?.type === "tool_use" && b.name === "answer");
    if (!use) return { data: null, error: "no-answer-tool", costUsd, latencyMs: Date.now() - started, model };
    const cited = Array.isArray(use.input?.citedDocumentIds) ? use.input.citedDocumentIds.filter((id) => docIds.includes(id)) : [];
    const facts = Array.isArray(use.input?.facts) ? use.input.facts.filter((f) => f && typeof f === "object") : [];
    const data = {
      kind: docText ? "answer" : "no-answer",
      text: String(use.input?.text ?? ""),
      facts,
      sources: cited.map((id) => ({ documentId: id })),
    };
    return { data, error: null, costUsd, latencyMs: Date.now() - started, model };
  } catch (err) {
    if (err?.name === "ModelBudgetExceededError") throw err;
    return { data: null, error: String(err?.name ?? "error"), costUsd: 0, latencyMs: Date.now() - started, model };
  }
}

/**
 * Run (or read the cached) baseline for one question. Never throws on a missing/skip oracle: mirrors
 * runner.js's own "skip, don't fail" discipline so a question absent from this shop's data does not count
 * against either side of the gap.
 */
export async function runBaselineForQuestion({ ctxArg, withTenant, question, examVersion, today, callModel, deadlineAt, model = baselineModel() }) {
  const cached = await getBaseline(ctxArg, examVersion, question.id);
  if (cached) return { ...cached, cached: true };

  const oracle = await runOracle(withTenant, ctxArg, question, { today });
  if (!oracle.ok || oracle.skip) return { questionId: question.id, skipped: true, error: oracle.error ?? oracle.why, cached: false };

  const built = await withTenant(ctxArg, async (db) => {
    const docIds = await candidateDocIds(db, question, { today });
    return scopeText(db, docIds);
  });
  const asked = await askBaseline({ ctxArg, question, docText: built.text, docIds: built.docIds, callModel, deadlineAt, model });
  if (!asked.data) {
    const record = { questionId: question.id, examVersion, category: question.category, passed: false, score: 0, error: asked.error, costUsd: asked.costUsd, latencyMs: asked.latencyMs, model: asked.model, citedDocumentIds: [], at: new Date().toISOString() };
    await saveBaseline(ctxArg, examVersion, question.id, record);
    return { ...record, cached: false };
  }
  const graded = await gradeAnswer({ ctx: ctxArg, question, expected: oracle.expected, alts: oracle.alts, data: asked.data, callModel, deadlineAt });
  const record = {
    questionId: question.id, examVersion, category: question.category, passed: Boolean(graded.passed), score: graded.score ?? (graded.passed ? 1 : 0),
    got: graded.got, error: null, costUsd: asked.costUsd + (graded.costUsd ?? 0), latencyMs: asked.latencyMs, model: asked.model,
    citedDocumentIds: built.docIds, scopeDocs: built.docIds.length, at: new Date().toISOString(),
  };
  await saveBaseline(ctxArg, examVersion, question.id, record);
  return { ...record, cached: false };
}

/**
 * Page through `questions`, filling in any baseline the current exam version does not already have cached,
 * inside `budgetUsd` and the caller's own deadline. Mirrors runner.js's paging contract (offset/nextOffset/
 * done/stopped) so the operator UI/cron can drive it the same way scorecardRun is driven.
 */
export async function runBaselinePage({ ctxArg, withTenant, questions, examVersion, today, offset = 0, pageSize = DEFAULT_BASELINE_PAGE_SIZE, budgetUsd, deadlineAt, callModel, env = process.env }) {
  const budget = Number.isFinite(budgetUsd) && budgetUsd > 0 ? budgetUsd : baselineBudgetUsd(env);
  const deadline = deadlineAt ?? Date.now() + 45_000;
  const list = Array.isArray(questions) ? questions : [];
  const size = Math.max(1, Math.trunc(pageSize) || DEFAULT_BASELINE_PAGE_SIZE);
  const model = baselineModel(env);

  let spent = 0; let stopped = null; let i = Math.max(0, Math.trunc(offset) || 0);
  const end = Math.min(list.length, i + size);
  const results = [];
  while (i < end) {
    if (spent >= budget) { stopped = "budget"; break; }
    if (deadline - Date.now() < MIN_BASELINE_QUESTION_MS) { stopped = "deadline"; break; }
    const q = list[i];
    const r = await runBaselineForQuestion({ ctxArg, withTenant, question: q, examVersion, today, callModel, deadlineAt: deadline, model });
    if (!r.cached) spent += Number(r.costUsd) || 0;
    results.push(r);
    i++;
  }
  console.log(JSON.stringify({ route: "scorecard-baseline", examVersion: examVersion?.slice(0, 24), asked: results.filter((r) => !r.cached && !r.skipped).length, cached: results.filter((r) => r.cached).length, offset, next: i >= list.length ? null : i, stopped, spent_usd: Math.round(spent * 10000) / 10000 }));
  return { offset, nextOffset: i >= list.length || stopped === "budget" ? null : i, done: i >= list.length || stopped === "budget", stopped, results, spentUsd: Math.round(spent * 10000) / 10000 };
}

/**
 * Per-category Donovan-vs-baseline comparison for a completed scorecard run: for each category, Donovan's
 * own score (from the run's results), the baseline's score over the SAME questions (from whatever is
 * cached for this exam version) and the gap (donovan - baseline). A category with no cached baseline yet
 * reports baselineScore: null (never a misleading 0) so the operator sees "not run yet", not "Donovan beat
 * an empty baseline".
 */
export async function baselineGapReport(ctxArg, examVersion, donovanResults) {
  const graded = (donovanResults ?? []).filter((r) => r && !r.skipped);
  const ids = graded.map((r) => r.questionId);
  const baselines = await listBaselines(ctxArg, examVersion, ids);
  const baseById = new Map(baselines.map((b) => [b.questionId, b]));
  const byCat = {};
  for (const r of graded) {
    const c = (byCat[r.category] ??= { donovanPassed: 0, donovanTotal: 0, basePassed: 0, baseTotal: 0 });
    c.donovanTotal += 1; if (r.passed) c.donovanPassed += 1;
    const b = baseById.get(r.questionId);
    if (b && !b.skipped) { c.baseTotal += 1; if (b.passed) c.basePassed += 1; }
  }
  const out = {};
  for (const [cat, c] of Object.entries(byCat)) {
    const donovanScore = c.donovanTotal ? Math.round((c.donovanPassed / c.donovanTotal) * 1000) / 1000 : null;
    const baselineScore = c.baseTotal ? Math.round((c.basePassed / c.baseTotal) * 1000) / 1000 : null;
    out[cat] = { donovanScore, baselineScore, gap: donovanScore != null && baselineScore != null ? Math.round((donovanScore - baselineScore) * 1000) / 1000 : null, baselineCoverage: c.donovanTotal ? Math.round((c.baseTotal / c.donovanTotal) * 1000) / 1000 : 0 };
  }
  return out;
}
