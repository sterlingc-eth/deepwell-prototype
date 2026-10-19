/**
 * app.js - Donovan Reader V2 inside the app. Two switches, both OFF unless set:
 *   DONOVAN_READER_V2          answers a question from the organization's own documents, but ONLY where the current path would release (kind "no-answer"); never replaces an answer.
 *   DONOVAN_READER_V2_SHADOW   runs the reader next to the current path on every question and LOGS the comparison; no customer ever sees it.
 * The reader refuses to run unless the bundle carries a parity stamp of 0 mismatches (data/bundle.json -> parity).
 * Logs carry ids, hashes, scores and the release reason - never document text (set DONOVAN_READER_V2_LOG_TEXT=1 to also print the answer text, off by default).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { TENANT_SQL } from '../../scope.js';
import { documentsHaveAudience } from '../../audience/probe.js';
import { audienceFilterSql } from '../../audience/sql.js';
import { getCorpusStamp } from '../../askCache.js';
import { attachCitations, makeRecord } from '../../citations/records.js';
import { isFinalDecline } from '../../router/releaseGate.js';
import { fileURLToPath } from 'node:url';
const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');

const truthy = (v) => /^(?:1|true|on|yes)$/i.test(String(v ?? '').trim());
export const readerV2On = () => truthy(process.env.DONOVAN_READER_V2);
export const readerV2ShadowOn = () => truthy(process.env.DONOVAN_READER_V2_SHADOW);
export const readerV2Wanted = () => readerV2On() || readerV2ShadowOn();
const MAX_DOCS = () => (Number(process.env.DONOVAN_READER_V2_MAX_DOCS) > 0 ? Number(process.env.DONOVAN_READER_V2_MAX_DOCS) : 5000);
const BUDGET_MS = () => (Number(process.env.DONOVAN_READER_V2_BUDGET_MS) > 0 ? Number(process.env.DONOVAN_READER_V2_BUDGET_MS) : 8000);
const h12 = (s) => (s == null || s === '' ? null : createHash('sha256').update(String(s)).digest('hex').slice(0, 12));
const log = (o) => { try { console.log(JSON.stringify({ route: 'ask', readerV2: o })); } catch { /* never block */ } };

// ---- the parity stamp: the reader is allowed to run only when the bundle was verified against the reference pipeline with zero mismatches
let stampOk = null;
/** verify scripts only: pretend the stamp is present so the database checks can run before the stamp is written */
export function _assumeParity(v) { stampOk = v === null ? null : Boolean(v); }
export function paritySealed() {
  if (stampOk !== null) return stampOk;
  try {
    const B = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'bundle.json'), 'utf8'));
    stampOk = Boolean(B.parity && B.parity.mismatches === 0 && Number(B.parity.questions) >= 2000);
  } catch { stampOk = false; }
  if (!stampOk) log({ refused: 'parity stamp missing or not zero' });
  return stampOk;
}

// ---- lazy model load (the encoders and the wasm runtime are only touched when a switch is on)
let readerP = null; let brokenAt = 0;
async function reader() {
  if (readerP) return readerP;
  if (brokenAt && Date.now() - brokenAt < 60000) throw new Error('reader unavailable');
  readerP = import('./index.js').then((m) => m.loadReaderV2()).catch((e) => { readerP = null; brokenAt = Date.now(); throw e; });
  return readerP;
}
// ---- one organization's records, read inside the tenant (same predicates the rest of the app uses)
async function readRecords(db, today) {
  const hasAudienceColumn = await documentsHaveAudience({ query: (sql, params) => db.raw(sql, params) });
  const audience = audienceFilterSql({ docAlias: 'd', hasAudienceColumn });
  const cnt = await db.raw(`SELECT count(*)::int AS n FROM documents d WHERE d.${TENANT_SQL} AND (${audience})`, []);
  const n = cnt.rows?.[0]?.n ?? 0;
  if (n > MAX_DOCS()) return { tooBig: true, n };
  const rows = async (sql, p = []) => (await db.raw(sql, p)).rows ?? [];
  const iso = (v) => (v instanceof Date ? v.toISOString() : v);
  const documents = (await rows(`SELECT d.id, d.document_type, d.created_at FROM documents d WHERE d.${TENANT_SQL} AND (${audience}) ORDER BY d.created_at, d.id`)).map((d) => ({ ...d, created_at: iso(d.created_at) }));
  const ids = documents.map((d) => d.id);
  const pages = ids.length ? await rows(`SELECT p.document_id, p.page_no, p.text FROM document_pages p WHERE p.${TENANT_SQL} AND p.document_id = ANY($1::uuid[]) ORDER BY p.document_id, p.page_no`, [ids]) : [];
  const extractions = await rows(`SELECT x.document_id, x.entity_id, x.field_key, COALESCE(NULLIF(x.corrected_value, ''), x.value) AS value FROM extractions x WHERE x.${TENANT_SQL} AND x.field_key NOT LIKE '\\_%' AND x.document_id = ANY($1::uuid[]) ORDER BY x.created_at, x.id`, [ids]);
  const entities = await rows(`SELECT e.id, e.entity_type, e.customer_number, e.data, e.merged_into FROM entities e WHERE e.merged_into IS NULL AND e.entity_type = 'customer' AND e.${TENANT_SQL}`);
  const links = await rows(`SELECT l.document_id, l.entity_id FROM document_entity_links l WHERE l.${TENANT_SQL} AND l.document_id = ANY($1::uuid[])`, [ids]);
  let financials = [];
  const has = await db.raw(`SELECT to_regclass('document_financials') IS NOT NULL AS ok`, []);
  if (has.rows?.[0]?.ok) financials = await rows(`SELECT f.document_id, f.invoice_number, f.po_number, f.total, f.status FROM document_financials f WHERE f.${TENANT_SQL} AND f.document_id = ANY($1::uuid[])`, [ids]);
  return { tenantName: 'organization', exportedAt: `${today}T00:00:00.000Z`, documents, pages, extractions, entities, document_entity_links: links, financials, financial_lines: [] };
}
const memo = new Map(); // tenantId -> { key, ix }
export function _forgetIndexes() { memo.clear(); }
async function indexFor(db, today) {
  const tenantId = db?.tenantId ?? null;
  const stamp = tenantId ? await getCorpusStamp(db) : null;
  const key = stamp ? `${stamp}|${today}` : null;
  if (key) { const hit = memo.get(tenantId); if (hit && hit.key === key) return hit.ix; }
  const rec = await readRecords(db, today);
  if (rec.tooBig) return { tooBig: true, n: rec.n };
  const { buildIndex } = await import('./index.js');
  const ix = buildIndex(rec, tenantId || 'org');
  if (key) { memo.delete(tenantId); memo.set(tenantId, { key, ix }); while (memo.size > 2) memo.delete(memo.keys().next().value); }
  return ix;
}
// one question at a time: the wasm session and the per-organization caches are shared state
let chain = Promise.resolve(); let lastTenant = null;
// HANDOFF: a job that never settles must not freeze the queue for every later question on this instance, so each job is cut off after twice the reader budget
const serial = (fn) => {
  const run = () => { let t; return Promise.race([fn(), new Promise((_, rej) => { t = setTimeout(() => rej(new Error('reader job timeout')), Math.max(2 * BUDGET_MS(), 15000)); })]).finally(() => clearTimeout(t)); };
  const p = chain.then(run, run); chain = p.catch(() => {}); return p;
};

/** run the reader for one question inside the organization. Returns { answered, text, docs, page, pv, reason, ms, ix } or { skipped } */
export async function runReader(withTenant, ctxArg, question, today) {
  if (!paritySealed()) return { skipped: 'parity' };
  const t0 = Date.now();
  // HANDOFF: the budget covers the wait in the one-at-a-time queue too, so a busy or slow reader can never hold a customer past BUDGET_MS: the question then goes on to the Claude path
  let timer;
  const budget = new Promise((resolve) => { timer = setTimeout(() => resolve({ skipped: 'budget' }), BUDGET_MS()); });
  const job = serial(async () => {
    const R = await reader();
    return withTenant(ctxArg, async (db) => {
      if (lastTenant !== (db.tenantId ?? null)) { R.M.emb.cache.clear(); R.M.intent_emb.cache.clear(); lastTenant = db.tenantId ?? null; }
      const ix = await indexFor(db, today);
      if (ix.tooBig) return { skipped: 'size' };
      const r = await R.answer(ix, String(question).slice(0, 400));
      return { ...r, ix };
    });
  });
  job.catch(() => {});
  try { const out = await Promise.race([job, budget]); return { ...out, ms: Date.now() - t0 }; } finally { clearTimeout(timer); }
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const hum = (t) => String(t).replace(/[_-]+/g, ' ');
const pluralOf = (w) => (/[^aeiou]y$/.test(w) ? w.slice(0, -1) + 'ies' : /is$/.test(w) ? w.slice(0, -2) + 'es' : /(?:s|x|z|ch|sh)$/.test(w) ? w + 'es' : w + 's');
/** presentation only (the reference pipeline simply appends "s"): "analysiss" -> "analyses", "summarys" -> "summaries"; nothing else in the text changes */
export function polish(text, ix) {
  let t = String(text);
  for (const type of ix.types || []) {
    const base = hum(type); const wrong = base + 's'; const right = pluralOf(base);
    if (wrong === right) continue;
    t = t.replace(new RegExp(`(^|[^A-Za-z])${wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z])`, 'gi'), (m, pre) => pre + (m.slice(pre.length)[0] === m.slice(pre.length)[0].toUpperCase() && /[A-Z]/.test(m.slice(pre.length)[0]) ? right[0].toUpperCase() + right.slice(1) : right));
  }
  return t;
}
/** the answer in the shape every other lane returns (text, sources with documentId + page, citation records, a one-sentence basis) */
export function toAnswerData(r) {
  const ix = r.ix; const docIds = [...new Set((r.docs || []))];
  const sources = docIds.slice(0, 20).map((id) => ({ documentId: id, location: r.page != null && docIds.length === 1 ? { page: Number(r.page) } : { field: 'document' } }));
  const records = docIds.map((id) => { const x = ix.D.get(id); return makeRecord({ type: x && x.type === 'invoice' ? 'invoice' : 'document', id, label: x ? ix.cite(x) : 'Document', documentId: id, page: docIds.length === 1 ? r.page : undefined }); }).filter(Boolean);
  const basis = docIds.length === 0 ? 'Read from the records stored in your files.'
    : docIds.length === 1 ? 'Read from the cited document in your files.' : `Worked out from the ${plural(docIds.length, 'matching document', 'matching documents')} in your files; each is listed.`;
  const data = { kind: 'answer', text: polish(r.text, ix), facts: [], sources, confidence: Math.min(1, Math.max(0, Number(r.pv) || 0)), verifiedCount: sources.length, unverifiedCount: 0, closest: [] };
  return attachCitations(data, { records, total: records.length, basis });
}
/**
 * Does the reader's answer address the fact the question asked? (HANDOFF) The reader is trained on other kinds of companies: on a field-service tenant it can read "has this unit had a compressor replaced? <address>"
 * as the intent "who is at this address" and answer with the customer's name (a broad answer where one fact was asked). A reader answer that does not fit goes to the Claude path instead.
 * Permissive on purpose: it only rejects when the question names a different fact, or lacks every cue its intent needs. A false reject costs one model call, never a wrong answer.
 */
const OTHER_FACT_RE = /\b(?:compressor|capacitor|refrigerant|tonnage|btu|seer|filter|thermostat|permits?|warrant\w*|serial|model|brand|install\w*|servic\w*|repair\w*|replac\w*|maintenance|visits?|last time|invoices?|quotes?|estimates?|proposals?|balance|owe\w*)\b/i;
const NEED_CUE = {
  who_addr: /\b(?:who|whose|who'?s|whos|cust\w*|clients?|owner|lives?|living|resid\w*|tenants?|occupant|staying|name|located)\b/i,
  contact: /\b(?:phone|cell|mobile|e-?mail|contact|number|reach|call|text|address|fax)\b/i,
  date: /\b(?:when|date|dated|day|month|year|signed|filed|recorded|received|closed|due|expires?|expir\w*)\b/i,
};
export function answerFits(question, r) {
  const q = String(question ?? '');
  const intent = r?.intent;
  if (intent === 'who_addr' && OTHER_FACT_RE.test(q)) return false;
  const need = NEED_CUE[intent];
  if (need && !need.test(q)) return intent === 'who_addr' ? !/\b(?:what|when|how|which|do we|does|did|has|have)\b/i.test(q) : false;
  return true;
}
const docsOf = (d) => [...new Set([...(d?.sources || []).map((s) => s?.documentId), ...(d?.records || []).map((x) => x?.documentId)].filter(Boolean))].slice(0, 8);
const normText = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
/**
 * The one hook ask.js calls with a response body that is about to be sent. Returns the body to send (the same object unless the reader answered a released question).
 * Never throws; any failure sends the current body untouched.
 */
export async function readerV2Hook(ctx, body) {
  try {
    const data = body?.data;
    if (!ctx || !body?.success || !data || typeof data !== 'object' || (data.kind !== 'answer' && data.kind !== 'no-answer')) return body;
    const on = readerV2On(); const shadow = readerV2ShadowOn();
    const released = data.kind === 'no-answer' && !data.help && !isFinalDecline(data); // a decline the lane VERIFIED (absent from this company's records, policy, privacy) is never rescued
    const live = on && released;                                    // the only case where a customer can see the reader
    if (!shadow && !live) return body;
    const r = await runReader(ctx.withTenant, ctx.ctxArg, ctx.question, ctx.today);
    const mode = live ? 'on' : 'shadow';
    if (r.skipped) { log({ skipped: r.skipped, mode, cur: data.kind }); return body; }
    const entry = { mode, cur: { kind: data.kind, docs: docsOf(data), h: h12(normText(data.text)) }, v2: { answered: r.answered, docs: (r.docs || []).slice(0, 8), n: (r.docs || []).length, pv: Number((r.pv || 0).toFixed(4)), reason: r.answered ? '' : String(r.reason || '').slice(0, 40), intent: r.intent || null, h: r.answered ? h12(normText(r.text)) : null }, ms: r.ms };
    entry.agree = data.kind === 'answer' ? Boolean(r.answered && entry.cur.h === entry.v2.h) : null;
    if (truthy(process.env.DONOVAN_READER_V2_LOG_TEXT) && r.answered) entry.v2.text = String(r.text).slice(0, 300);
    log(entry);
    if (!live || !r.answered) return body;                         // shadow, an existing answer, or a release the reader also keeps: send what the current path produced (the Claude path takes it from there)
    if (!answerFits(ctx.question, r)) { log({ unfit: true, intent: r.intent || null, pv: Number((r.pv || 0).toFixed(4)) }); return body; }
    return { ...body, data: toAnswerData(r) };
  } catch (e) { log({ error: String(e?.message || e).slice(0, 80) }); return body; }
}
