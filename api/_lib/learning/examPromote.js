/**
 * Donovan learning — MISSES → PERMANENT EXAM (R16 D3 research item 3, "golden-set growth from
 * production miss-digest"): a resolved production miss (an `ask_miss_replays` row this shop's own
 * Donovan now answers `answered_now` on replay, or one an operator manually confirms) can be turned
 * into an exam-candidate question — same {id, text, category, shape, cmp, oracle} shape
 * test-docs/scorecard/exam.json / generalization/*.json already use — so a fixed mistake becomes a
 * PERMANENT regression test instead of a one-off replay that could silently regress again.
 *
 * ORACLE: this file prefers a STRUCTURAL oracle re-derived from the answer's own citation — the
 * `documentId`/`field_key` a fastPath-style field-lookup answer already cites (see
 * api/_lib/fastPath.js's buildFieldAnswer/buildWarrantyAnswer: every such fact's `sources[0]` names
 * exactly the extraction row that backed it). Re-running `SELECT value FROM extractions WHERE
 * document_id = ... AND field_key = ...` against the tenant's OWN data at grading time is a real,
 * re-checkable question — if a future bug makes Donovan report a different value than that same
 * cited row, this test catches it, even though nothing here duplicates Donovan's own resolution
 * logic (same "no shared code with the answer path" rule scorecard/oracle.js documents for the
 * hand-written exam). When an answer can't be reduced to that shape (a list, a bare count with no
 * citation, …) there is no safe way to reconstruct a query with no hard-coded literal, so promotion
 * refuses UNLESS an operator supplies the expected value directly — the one documented exception
 * ("never a hard-coded string unless the operator supplies one"), stored as a trivial constant-SQL
 * oracle so it still round-trips through the exact same {sql, params} shape every other question
 * uses (api/_lib/scorecard/oracle.js's oracleSqlOk validates it exactly like any other).
 *
 * PRIVACY / SCOPE: every promoted test is TENANT-scoped (own RLS table, migration 56) — a shop's own
 * customer/address/serial data in the question text is no MORE exposed than that same shop's own
 * admin export already contains (redactPII strips email/phone defensively; nothing else is added).
 * scripts/offline-exam.mjs only ever merges a tenant's promoted set when grading THAT tenant's own
 * export (tenantKey match) — see that file's loadPromotedCategoryQuestions.
 *
 * DB access here follows missStore.js's own convention: tolerant of the table not existing yet (a
 * migration can lag a deploy), warn once, never throw, never fail the caller's request.
 */
import { createHash } from "node:crypto";
import { withTenant } from "../recordsStore.js";
import { redactPII } from "../missDigest.js";
import { classifyCapability } from "./gapReport.js";
import { VALID_CMP, validQuestions } from "../scorecard/exam.js";
import { oracleSqlOk } from "../scorecard/oracle.js";

const MAX_TEXT_CHARS = 300;
const ID_HASH_LEN = 10;

/* ------------------------------------------------------------------ pure: classification */

/** A short, free-text shape guess from the question's own wording — informational grouping only
 *  (never load-bearing for grading). Pure. Reuses no fastPath/nlNormalize internals on purpose: a
 *  cheap, local heuristic that can't drift out of sync with G4's own vocabulary work this same round. */
export function guessShape(question) {
  const q = String(question ?? "").toLowerCase();
  if (/\d+\s+[a-z][a-z .'-]{2,40}\b(st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|way|ct|court|pl|place|pkwy|parkway|cir|circle)\b/.test(q)) return "address-lookup";
  if (/\bserial\b|\bs\/n\b|\bmodel\b/.test(q)) return "unit-field-lookup";
  if (/\bhow many\b|\bcount\b|\bnumber of\b|\btotal\b/.test(q)) return "count";
  if (/@|\bemail\b|\bphone\b|\bcall\b/.test(q)) return "contact-lookup";
  return "generic";
}

/** outcome/category/detectedConditions -> a category label — the SAME capability classifier
 *  gapReport.js's weekly cluster report uses, reused (not reinvented) per the brief. */
export function guessCategory(row) {
  return classifyCapability(row);
}

/* ------------------------------------------------------------------ pure: oracle building */

/**
 * The preferred, structural oracle: re-derive the expected value from the SAME cited extraction row
 * a single-fact field-lookup answer already names. Null when the answer isn't that shape (a list, an
 * uncited count, no answer at all) — the caller falls back to an operator-supplied literal.
 * @param {{kind?: string, facts?: Array<{value?: unknown, entityId?: string, sources?: Array<{documentId?: string, location?: {field?: string}}>}>}} answer
 * @returns {{cmp: 'value', oracle: {sql: string, params: any[], requires: {sql: string, params: any[]}}, citationRequired: true, oracleKind: 'structural-extraction'} | null}
 */
export function buildStructuralOracle(answer) {
  const facts = Array.isArray(answer?.facts) ? answer.facts : [];
  if (facts.length !== 1) return null; // a list/multi-fact answer has no single re-checkable cell
  const fact = facts[0];
  const src = Array.isArray(fact?.sources) ? fact.sources[0] : null;
  const field = src?.location?.field;
  if (!src || typeof src.documentId !== "string" || !src.documentId || typeof field !== "string" || !field) return null;

  const hasEntity = typeof fact.entityId === "string" && fact.entityId.length > 0;
  const sql = hasEntity
    ? `SELECT value AS v FROM extractions WHERE document_id = $1::uuid AND field_key = $2 AND entity_id = $3::uuid ORDER BY confidence DESC NULLS LAST LIMIT 1`
    : `SELECT value AS v FROM extractions WHERE document_id = $1::uuid AND field_key = $2 ORDER BY confidence DESC NULLS LAST LIMIT 1`;
  const params = hasEntity ? [src.documentId, field, fact.entityId] : [src.documentId, field];
  const requiresSql = `SELECT count(*)::int AS n FROM extractions WHERE document_id = $1::uuid AND field_key = $2`;
  // Defensive only — this exact shape always passes; never emit something the runner would refuse.
  if (!oracleSqlOk(sql) || !oracleSqlOk(requiresSql)) return null;

  return {
    cmp: "value",
    oracle: { sql, params, requires: { sql: requiresSql, params: [src.documentId, field] } },
    citationRequired: true,
    oracleKind: "structural-extraction",
  };
}

/** The documented exception: an operator's own typed answer, wrapped as a trivial constant-SQL
 *  oracle so it still validates through the exact same {sql, params} contract every other question
 *  uses. Never Donovan's own guess — `literal` must come from a human. */
export function buildOperatorLiteralOracle(literal, cmp) {
  const text = String(literal ?? "").trim().slice(0, MAX_TEXT_CHARS);
  if (!text) return null;
  if (cmp === "number") {
    const n = Number(text);
    if (!Number.isFinite(n)) return null;
    return { cmp: "number", oracle: { sql: "SELECT $1::numeric AS n", params: [n] }, citationRequired: false, oracleKind: "operator-literal" };
  }
  if (cmp === "yesno") {
    return { cmp: "yesno", oracle: { sql: "SELECT $1::boolean AS v", params: [/^(y|yes|true)$/i.test(text)] }, citationRequired: false, oracleKind: "operator-literal" };
  }
  return { cmp: "value", oracle: { sql: "SELECT $1::text AS v", params: [text] }, citationRequired: false, oracleKind: "operator-literal" };
}

/* ------------------------------------------------------------------ ids */

function shortHash(s) {
  return createHash("sha256").update(String(s ?? "")).digest("hex").slice(0, ID_HASH_LEN);
}

/** A tenant key turned into a short, id-safe slug — never the raw key itself (which may be a raw
 *  UUID or a customer-chosen string with characters an exam question id shouldn't carry). Pure. */
export function tenantSlug(tenantKey) {
  const slug = String(tenantKey ?? "tenant").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  return slug || "tenant";
}

/** The deterministic exam-question id a (tenant, normalized question) pair always promotes to —
 *  stable across repeated promotions of the same miss (an upsert, never a new id each time). */
export function promotedQuestionId(tenantKey, questionNormalized) {
  return `promoted-${tenantSlug(tenantKey)}-${shortHash(questionNormalized)}`;
}

/* ------------------------------------------------------------------ the builder */

/**
 * Turn one resolved miss into an exam-candidate question. Pure (no DB) — the caller persists the
 * result. Refuses (ok:false) rather than ever inventing a value: an answer this can't structurally
 * re-check needs an operator-supplied literal, and a miss with no answer at all and no literal is
 * simply not promotable yet.
 * @param {object} p
 * @param {string} p.question          the miss's original text
 * @param {string} p.questionNormalized  its normalized/dedupe key (ask_misses.question_normalized)
 * @param {string} [p.outcome]           the ask_misses outcome this came from (usually 'answered_now')
 * @param {string} [p.category]          scorecard category, when this started as a scorecard-fail miss
 * @param {string[]} [p.detectedConditions]
 * @param {object|null} [p.answer]       the stored replay answer (ask_miss_replays.answer) — {kind, text, facts:[...]}
 * @param {string} p.tenantKey
 * @param {string} [p.operatorLiteral]   an operator-typed expected value — the one hard-coded-string exception
 * @param {string} [p.operatorCmp]       'value' | 'number' | 'yesno' for the literal above (default 'value')
 * @returns {{ok: true, question: object, oracleKind: string} | {ok: false, reason: string}}
 */
export function promoteMissToExamCandidate({
  question, questionNormalized, outcome, category, detectedConditions, answer, tenantKey, operatorLiteral, operatorCmp,
} = {}) {
  const text = redactPII(String(question ?? "").trim()).slice(0, MAX_TEXT_CHARS);
  if (!text) return { ok: false, reason: "no question text to promote" };
  const normalized = String(questionNormalized ?? text).slice(0, MAX_TEXT_CHARS);

  const hasLiteral = operatorLiteral != null && String(operatorLiteral).trim() !== "";
  let built;
  if (hasLiteral) {
    const cmp = VALID_CMP.has(operatorCmp) && operatorCmp !== "rubric" && operatorCmp !== "set" && operatorCmp !== "honest-zero" && operatorCmp !== "count-with-unknown" ? operatorCmp : "value";
    built = buildOperatorLiteralOracle(operatorLiteral, cmp);
    if (!built) return { ok: false, reason: "the supplied expected answer could not be turned into an oracle" };
  } else {
    if (!answer) {
      return { ok: false, reason: "this miss has no recorded answer yet — replay it first, or supply the expected answer yourself" };
    }
    built = buildStructuralOracle(answer);
    if (!built) {
      return { ok: false, reason: "could not derive a structural oracle from this answer (it isn't a single cited field lookup) — supply the expected answer yourself to keep it as a test" };
    }
  }

  const id = promotedQuestionId(tenantKey, normalized);
  const q = {
    id,
    text,
    category: guessCategory({ outcome, category, detectedConditions }),
    shape: guessShape(text),
    cmp: built.cmp,
    oracle: built.oracle,
    ...(built.citationRequired ? { citationRequired: true } : {}),
  };
  // Self-check against the same schema offline-exam.mjs/exam.js will hold every question to — a
  // candidate that wouldn't actually load is refused here, never silently written and discovered
  // broken weeks later at grading time.
  if (!validQuestions([q]).length) return { ok: false, reason: "built candidate failed the exam question schema (internal)" };

  return { ok: true, question: q, oracleKind: built.oracleKind };
}

/* ------------------------------------------------------------------ export-file shape */

/** {version, tenantKey, category, questions} — the same top-level shape
 *  test-docs/scorecard/generalization/*.json files use, so a promoted export can be saved verbatim
 *  under test-docs/scorecard/promoted/<slug>.json and merged by scripts/offline-exam.mjs's loader. */
export function buildPromotedExport(tenantKey, questions) {
  return {
    version: `${new Date().toISOString().slice(0, 10)}.promoted-${tenantSlug(tenantKey)}`,
    tenantKey: String(tenantKey ?? ""),
    category: "promoted",
    questions: Array.isArray(questions) ? questions : [],
  };
}

/* ================================================================== store (migration 56, optional) */

let warned = false;
function warnOnce(context, err) {
  if (warned) return;
  warned = true;
  console.warn(`donovan-exam-promote: ${context} failed (M3-config/56-donovan-promoted-tests.sql may not be applied yet):`, err?.message);
}

/**
 * Upsert one promoted test for the caller's own tenant. Never throws; returns null (never partially
 * written) when the table is missing or the write fails — same tolerant convention as missStore.js.
 * @returns {Promise<{id: string, examId: string, createdAt: string} | null>}
 */
export async function insertPromotedTest(ctxArg, { examId, questionNormalized, question, category, shape, cmp, oracle, citationRequired, oracleKind, sourceOutcome, createdBy } = {}) {
  if (!examId || !questionNormalized || !question) return null;
  try {
    return await withTenant(ctxArg, async (db) => {
      const { rows } = await db.raw(
        `INSERT INTO donovan_promoted_tests
           (tenant_id, exam_id, question_normalized, question, category, shape, cmp, oracle, citation_required, oracle_kind, source_outcome, created_by)
         VALUES ((current_setting('app.tenant_id', true))::uuid, $1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11)
         ON CONFLICT (tenant_id, question_normalized) DO UPDATE SET
           exam_id = EXCLUDED.exam_id, question = EXCLUDED.question, category = EXCLUDED.category, shape = EXCLUDED.shape,
           cmp = EXCLUDED.cmp, oracle = EXCLUDED.oracle, citation_required = EXCLUDED.citation_required,
           oracle_kind = EXCLUDED.oracle_kind, source_outcome = EXCLUDED.source_outcome, active = true
         RETURNING id, exam_id, created_at`,
        [
          examId, questionNormalized.slice(0, MAX_TEXT_CHARS), question.slice(0, MAX_TEXT_CHARS), category ?? "other", shape ?? "generic",
          cmp, JSON.stringify(oracle ?? {}), Boolean(citationRequired), oracleKind ?? "operator-literal", sourceOutcome ?? null, createdBy ?? null,
        ]
      );
      const r = rows[0];
      if (!r) return null;
      return { id: r.id, examId: r.exam_id, createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at) };
    });
  } catch (err) {
    warnOnce("insert", err);
    return null;
  }
}

/** This tenant's active promoted tests, newest first. Never throws (empty on a missing table). */
export async function listPromotedTests(ctxArg, { limit = 500 } = {}) {
  try {
    return await withTenant(ctxArg, async (db) => (await db.raw(
      `SELECT id, exam_id, question_normalized, question, category, shape, cmp, oracle, citation_required, oracle_kind, source_outcome, created_at
         FROM donovan_promoted_tests
        WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid AND active
        ORDER BY created_at DESC LIMIT $1`,
      [Math.max(1, Math.min(2000, Number(limit) || 500))]
    )).rows);
  } catch (err) {
    warnOnce("list", err);
    return [];
  }
}

/** listPromotedTests rows -> exam question objects, ready for buildPromotedExport. Pure. */
export function rowsToQuestions(rows) {
  return (rows ?? []).map((r) => ({
    id: r.exam_id,
    text: r.question,
    category: r.category,
    shape: r.shape,
    cmp: r.cmp,
    oracle: r.oracle,
    ...(r.citation_required ? { citationRequired: true } : {}),
  }));
}
