/**
 * Donovan learning - RECIPES (the part of the loop that actually changes what Donovan does).
 *
 * A recipe is what a grounded agent answer teaches: {normalized question, the successful run_query
 * SQL, the result's columns, an answer template, a result signature}. Active recipes
 *   1. are injected into the agent's prompt as worked examples (top 3 by token overlap), so the
 *      same query shapes are reused instead of rediscovered, and
 *   2. when the incoming question EQUALS an active single-query recipe's question, are re-executed
 *      fresh (same sqlGuard + tenant transaction as any model query) and answered from the rows with
 *      the recipe's template - no model call (agent/fastReplay.js).
 *
 * Pure module: no DB, no model, no I/O. Everything stored is data-free by construction: the SQL may
 * only contain string literals that are dates, zips, known vocabulary, or words that appear in the
 * question and are not part of a customer's name, and the answer template carries no digits and no
 * capitalised word the question did not contain. Questions that are single-record references,
 * contain an email/phone, or are money questions never become recipes. A recipe is platform-level
 * (shared by every shop), which is why nothing shop-specific may live in one.
 */
import { createHash } from 'node:crypto';
import { normalizeQuestion } from '../nlNormalize.js';
import { guardSql } from '../agent/sqlGuard.js';
import { isMoneyQuestion, looksLikeSingleRecordReference, WARRANTY_STATUSES, KNOWN_US_CITY_NAMES, KNOWN_AZ_CITY_NAMES } from '../analytics.js';
import { DOCUMENT_TYPE_IDS } from '../documentTypes.js';
import { BRAND_RULES } from '../warrantyRules.js';
import { STOPWORDS } from './proposals.js';
import { loadRoutingBank } from './verify.js';

export const RECIPE_KIND = 'recipe';
export const MAX_RECIPE_SQLS = 3;
export const MAX_RECIPE_SQL_CHARS = 1200;
const MAX_FACTS = 40;
const ID_COL = /(^|_)id$/;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/;

const LITERAL_VOCAB = new Set([
  ...DOCUMENT_TYPE_IDS,
  ...WARRANTY_STATUSES,
  ...Object.keys(BRAND_RULES).map((k) => k.toLowerCase()),
  ...Object.values(BRAND_RULES).map((b) => String(b?.label ?? '').toLowerCase()).filter(Boolean),
  ...KNOWN_US_CITY_NAMES.map((c) => String(c).toLowerCase()),
  ...KNOWN_AZ_CITY_NAMES.map((c) => String(c).toLowerCase()),
]);

const cellText = (v) => (v == null ? '' : String(v));

/* ------------------------------------------------------------------ question */

/** The key a recipe is stored and matched under (the same normalisation ask_misses uses). */
export function normalizeRecipeQuestion(question) {
  return normalizeQuestion(String(question ?? '')).normalized.trim().replace(/[?!.\s]+$/, '').slice(0, 300);
}

function questionTokens(q) {
  return new Set((String(q).toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !STOPWORDS.has(w)));
}

/** Why this question may never become a recipe, or null. */
export function recipeQuestionBlocker(question) {
  const raw = String(question ?? '').trim();
  const norm = normalizeRecipeQuestion(raw);
  if (norm.length < 8) return 'question too short';
  if (EMAIL_RE.test(raw) || PHONE_RE.test(raw)) return 'question contains contact details';
  if (looksLikeSingleRecordReference(raw)) return 'single-record question';
  if (isMoneyQuestion(norm)) return 'money question';
  const bank = loadRoutingBank();
  if (Array.isArray(bank)) {
    for (const entry of bank) {
      const [text, expected] = Array.isArray(entry) ? entry : [entry?.text, entry?.route];
      if ((expected === 'R' || expected === 'L') && text && normalizeRecipeQuestion(text) === norm) return 'single-record question (routing bank)';
    }
  }
  return null;
}

/* ------------------------------------------------------------------ literals */

export function stringLiterals(sql) {
  const out = [];
  const re = /'((?:[^']|'')*)'/g;
  let m;
  while ((m = re.exec(String(sql ?? ''))) !== null) out.push(m[1].replace(/''/g, "'"));
  return out;
}

/**
 * @param {string} sql
 * @param {string} question
 * @param {{nameTokens?: Set<string>}} [opts]  lower-case words of the shop's customer names
 */
export function literalsAllowed(sql, question, { nameTokens } = {}) {
  const q = ` ${normalizeRecipeQuestion(question)} `;
  for (const lit of stringLiterals(sql)) {
    const core = lit.replace(/[%_]/g, '').trim().toLowerCase();
    if (!core) continue;
    if (/^\d{4}(-\d{2}(-\d{2})?)?$/.test(core) || /^\d{5}$/.test(core)) continue;
    if (LITERAL_VOCAB.has(core)) continue;
    if (/^[a-z][a-z' -]{1,30}$/.test(core) && q.includes(core)) {
      if (nameTokens && core.split(/[\s'-]+/).some((w) => w.length > 2 && nameTokens.has(w))) return { ok: false, reason: 'literal looks like a customer name' };
      continue;
    }
    return { ok: false, reason: 'SQL holds a data literal' };
  }
  return { ok: true };
}

/* ----------------------------------------------------------------- signature */

export function resultSignature(columns, rows) {
  const h = createHash('sha256');
  h.update(JSON.stringify(columns ?? []));
  h.update(String((rows ?? []).length));
  const lines = (rows ?? []).slice(0, 100).map((r) => JSON.stringify((columns ?? []).map((c) => cellText(r?.[c]))));
  lines.sort();
  for (const l of lines) h.update(l);
  return h.digest('hex').slice(0, 16);
}

/* ------------------------------------------------------------------ template */

function templateWordsOk(tpl, question) {
  const q = String(question).toLowerCase();
  const sentences = tpl.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    const words = sentence.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
    for (let i = 1; i < words.length; i++) {
      if (/^[A-Z]/.test(words[i]) && words[i].length > 2 && !q.includes(words[i].toLowerCase())) return false;
    }
  }
  return true;
}

/** model sentence -> template with the count replaced by {n}; null if it is not safely generic. */
function textToTemplate(text, n, question) {
  const t = String(text ?? '').trim();
  if (!t || t.length > 240) return null;
  const parts = t.split(new RegExp(`(?<![\\d,.])${String(n)}(?![\\d])`));
  if (parts.length !== 2) return null;
  const tpl = parts.join('{n}');
  if (/\d/.test(tpl.replace('{n}', '')) || !templateWordsOk(tpl, question)) return null;
  return tpl;
}

function groupList(tpl, columns, rows) {
  const groups = new Map();
  for (const r of rows) {
    const label = cellText(r[tpl.labelCol]).trim();
    if (!label) continue;
    const g = groups.get(label) ?? { label, values: [], id: '' };
    const part = tpl.constValue ?? (tpl.valueCols ?? []).map((c) => cellText(r[c]).trim()).filter(Boolean).join(' · ');
    if (part && !g.values.includes(part)) g.values.push(part);
    if (tpl.idCol && !g.id) g.id = cellText(r[tpl.idCol]).toLowerCase();
    groups.set(label, g);
  }
  void columns;
  return [...groups.values()].filter((g) => g.values.length);
}

/** Derive an answer template from the answer the agent gave and the rows it came from. Null when the
 *  answer cannot be reproduced deterministically (the recipe still works as a worked example). */
export function deriveTemplate({ text, facts, columns, rows, question }) {
  if (!Array.isArray(rows) || !rows.length || !Array.isArray(facts) || !facts.length) return null;
  if (rows.length === 1 && columns.length === 1 && /^-?\d+$/.test(cellText(rows[0][columns[0]]))) {
    const tpl = textToTemplate(text, cellText(rows[0][columns[0]]), question);
    if (!tpl) return null;
    return { mode: 'count', column: columns[0], text: tpl, label: facts.length === 1 ? String(facts[0].label).slice(0, 80) : 'Total' };
  }
  const labelCol = columns.find((c) => !ID_COL.test(c) && facts.every((f) => rows.some((r) => cellText(r[c]) === f.label)));
  if (!labelCol) return null;
  const idCol = columns.find((c) => ID_COL.test(c) && facts.some((f) => f.entityId)
    && facts.every((f) => !f.entityId || rows.some((r) => cellText(r[labelCol]) === f.label && cellText(r[c]).toLowerCase() === String(f.entityId).toLowerCase())));
  const cand = columns.filter((c) => c !== labelCol && !ID_COL.test(c));
  const need = Math.ceil(facts.length / 2);
  const valueCols = cand.filter((c) => facts.filter((f) => rows.some((r) => cellText(r[labelCol]) === f.label && cellText(r[c]).trim() && String(f.value).includes(cellText(r[c]).trim()))).length >= need);
  let constValue;
  if (!valueCols.length) {
    const v = facts[0].value;
    if (facts.every((f) => f.value === v) && String(v).length <= 80 && !/\d/.test(String(v)) && templateWordsOk(String(v), question)) constValue = String(v);
    else return null;
  }
  const tpl = { mode: 'list', labelCol, ...(idCol ? { idCol } : {}), ...(valueCols.length ? { valueCols } : {}), ...(constValue ? { constValue } : {}) };
  const groups = groupList(tpl, columns, rows);
  if (groups.map((g) => g.label).join('\u0001') !== facts.map((f) => f.label).join('\u0001')) return null;
  tpl.text = textToTemplate(text, groups.length, question) ?? 'Found {n} matching records; the full list is below.';
  return tpl;
}

/** Compose an answer-tool input from FRESH rows and a recipe's template. */
export function composeFromRecipe(recipe, columns, rows) {
  const tpl = recipe?.template;
  if (!tpl || JSON.stringify(columns) !== JSON.stringify(recipe.columns)) return { ok: false, reason: 'shape-changed' };
  if (tpl.mode === 'count') {
    if (rows.length !== 1) return { ok: false, reason: 'shape-changed' };
    const v = cellText(rows[0][tpl.column]);
    if (!/^-?\d+$/.test(v)) return { ok: false, reason: 'shape-changed' };
    return { ok: true, input: { status: 'answered', text: tpl.text.replace('{n}', v), facts: [{ label: tpl.label, value: v }], confidence: 1 } };
  }
  if (tpl.mode === 'list') {
    const groups = groupList(tpl, columns, rows);
    if (!groups.length) return { ok: false, reason: 'no-rows' };
    const facts = groups.map((g) => ({ label: g.label.slice(0, 120), value: g.values.join('; ').slice(0, 300), ...(g.id ? { entityId: g.id } : {}) }));
    const text = tpl.text.replace('{n}', String(groups.length));
    return { ok: true, input: { status: 'answered', text, facts: facts.slice(0, MAX_FACTS + 1), confidence: 1 } };
  }
  return { ok: false, reason: 'unknown-template' };
}

/* ------------------------------------------------------------- build / verify */

/**
 * @param {{question: string, run: {handled: boolean, data: any, queries?: any[]}, nameTokens?: Set<string>}} p
 * @returns {{ok: true, recipe: object} | {ok: false, reason: string}}
 */
export function buildRecipeCandidate({ question, run, nameTokens }) {
  if (!run?.handled || run.data?.kind !== 'answer' || !(run.data.facts?.length > 0)) return { ok: false, reason: 'not a grounded answer' };
  const blocked = recipeQuestionBlocker(question);
  if (blocked) return { ok: false, reason: blocked };
  const seen = new Set();
  const usable = (run.queries ?? []).filter((q) => q && q.rowCount > 0 && typeof q.sql === 'string' && q.sql.length <= MAX_RECIPE_SQL_CHARS
    && guardSql(q.sql).ok && literalsAllowed(q.sql, question, { nameTokens }).ok && !seen.has(q.sql) && seen.add(q.sql)).slice(-MAX_RECIPE_SQLS);
  if (!usable.length) return { ok: false, reason: 'no reusable query' };
  const primary = usable[usable.length - 1];
  const template = usable.length === 1
    ? deriveTemplate({ text: run.data.text, facts: run.data.facts, columns: primary.columns, rows: primary.rows, question })
    : null;
  const recipe = {
    question: normalizeRecipeQuestion(question),
    sqls: usable.map((q) => q.sql),
    columns: primary.columns,
    rowCount: primary.rowCount,
    signature: resultSignature(primary.columns, primary.rows),
    ...(template ? { template } : {}),
  };
  return { ok: true, recipe };
}

/** Schema check for a payload read back from the DB (never trust stored JSON). */
export function validateRecipePayload(p) {
  if (!p || typeof p !== 'object') return { ok: false, reasons: ['payload must be an object'] };
  const reasons = [];
  if (typeof p.question !== 'string' || !p.question || p.question.length > 300) reasons.push('bad question');
  if (!Array.isArray(p.sqls) || !p.sqls.length || p.sqls.length > MAX_RECIPE_SQLS || p.sqls.some((s) => typeof s !== 'string' || !s || s.length > MAX_RECIPE_SQL_CHARS)) reasons.push('bad sqls');
  if (!Array.isArray(p.columns) || p.columns.some((c) => typeof c !== 'string')) reasons.push('bad columns');
  if (typeof p.signature !== 'string' || p.signature.length > 40) reasons.push('bad signature');
  if (p.template != null) {
    const t = p.template;
    const okCount = t.mode === 'count' && typeof t.column === 'string' && typeof t.text === 'string' && t.text.includes('{n}') && typeof t.label === 'string';
    const okList = t.mode === 'list' && typeof t.labelCol === 'string' && typeof t.text === 'string' && t.text.includes('{n}')
      && (t.valueCols == null || (Array.isArray(t.valueCols) && t.valueCols.every((c) => typeof c === 'string')));
    if (!okCount && !okList) reasons.push('bad template');
  }
  return { ok: reasons.length === 0, reasons };
}

/** The gate a recipe passes before it may go live (operator approve, thumbs-up, or twice-seen). */
export function verifyRecipe(payload, { nameTokens } = {}) {
  const v = validateRecipePayload(payload);
  if (!v.ok) return { ok: false, reasons: v.reasons };
  const reasons = [];
  const blocked = recipeQuestionBlocker(payload.question);
  if (blocked) reasons.push(blocked);
  for (const sql of payload.sqls) {
    const g = guardSql(sql);
    if (!g.ok) reasons.push(`sql rejected by the guard: ${g.error}`);
    const l = literalsAllowed(sql, payload.question, { nameTokens });
    if (!l.ok) reasons.push(l.reason);
  }
  return { ok: reasons.length === 0, reasons };
}

/* ----------------------------------------------------------------- selection */

/** Top-n active recipes most similar to the question (token overlap), never a tampered one. */
export function selectWorkedExamples(recipes, question, n = 3) {
  const qt = questionTokens(normalizeRecipeQuestion(question));
  if (!qt.size || !Array.isArray(recipes)) return [];
  const scored = [];
  for (const r of recipes) {
    if (!validateRecipePayload(r).ok) continue;
    const rt = questionTokens(r.question);
    let inter = 0;
    for (const t of qt) if (rt.has(t)) inter++;
    if (inter < Math.min(2, qt.size, rt.size)) continue;
    scored.push({ r, score: inter / (qt.size + rt.size - inter) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((s) => s.score >= 0.25).slice(0, n).map((s) => s.r);
}

export function formatWorkedExamples(examples) {
  if (!examples?.length) return '';
  const body = examples.map((e) => `Q: ${e.question}\nSQL: ${e.sqls[e.sqls.length - 1].slice(0, 700)}`).join('\n\n');
  return `WORKED EXAMPLES (queries that answered similar questions correctly; reuse the shape, change the filters to fit the new question, never copy a value):\n${body}\n\n`;
}

export function findExactRecipe(recipes, question) {
  const norm = normalizeRecipeQuestion(question);
  if (!norm || !Array.isArray(recipes)) return null;
  return recipes.find((r) => validateRecipePayload(r).ok && r.question === norm && r.sqls.length === 1 && r.template) ?? null;
}
