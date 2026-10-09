/**
 * DONOVAN-R4 retrieval v2 (switch DONOVAN_RETRIEVAL_V2, default OFF): what the model path is given as evidence, improved in four general ways, none of them keyed to a wording:
 *   (a) DOCUMENT CARDS (cards.js): a compact card per candidate document, ranked against the question and merged into the retrieved passages, so structured facts (technician,
 *       totals, dates, vendor, agreement term ...) are VISIBLE to the reader, not only the page fragment the full-text search happened to highlight;
 *   (b) HEADERS: every card carries its document type, file, number, customer / vendor and date, so nothing is orphaned from whose it is;
 *   (c) HYBRID + HARD FILTER: a customer, document number or serial named in the question is a hard filter on the pages searched (exact names and numbers combined with the
 *       existing full-text search); other customers' pages are not retrieved at all;
 *   (d) ONE REFINED SEARCH with the subject made explicit when the first pass found nothing that mentions the question's fact words;
 *   (e) coverage: every stored field of a document is on its card (tested in verify-retrieval-r4).
 * Pure helpers are exported for the tests. augmentEvidence() never throws: any failure returns the evidence it was given (today's behaviour).
 */
import { loadCards } from "./cards.js";
import { resolveSubject } from "./subject.js";
import { findFacts, tokensOf, normalizeText, STOP } from "../records/parse.js";
import { factById } from "../records/directory.js";
import * as store from "../records/store.js";
import { readStoredCards, cardsStoreEnabled } from "./cardStore.js";

const T = (a) => `${a}.tenant_id = (current_setting('app.tenant_id', true))::uuid`;
export const retrievalV2Enabled = (env = process.env) => /^(?:1|true|on|yes)$/i.test(String(env?.DONOVAN_RETRIEVAL_V2 ?? "").trim());
export const CARDS_PER_QUESTION = 6;
const CANDIDATE_DOCS = 60;

const GLUE = new Set(("tell give show find look pull list name names number numbers many much long often ever last latest first newest oldest recent get got has have had does did doing done is was are were be been being the a an of for on at in to from by with and or but how what which who whom whose when where why please pls ").split(/\s+/));
const stem = (t) => t.length > 4 ? t.replace(/(?:ies)$/, "y").replace(/(?:ing|ed|es|s)$/, "") : t;

/** content terms of a question, stemmed, plus the label words of every directory fact the question names ("tech" -> technician) */
export function queryTerms(question, { subjectTokens = new Set() } = {}) {
  const tokens = tokensOf(normalizeText(question));
  const found = findFacts(tokens);
  const terms = new Set();
  tokens.forEach((t, i) => {
    if (STOP.has(t) || GLUE.has(t) || t.length < 3 || subjectTokens.has(t)) return;
    if (found.used?.[i]) return; // fact words are handled through their labels below
    terms.add(stem(t));
  });
  const labelTerms = new Set();
  for (const id of found.ids ?? []) for (const w of String(factById(id)?.label ?? "").toLowerCase().split(/[^a-z0-9]+/)) if (w.length >= 3 && !GLUE.has(w)) labelTerms.add(stem(w));
  return { terms: [...terms], labelTerms: [...labelTerms], factIds: found.ids ?? [] };
}

const cardTokens = (text) => new Set((String(text).toLowerCase().match(/[a-z0-9$#.][a-z0-9$#./-]*/g) ?? []).map((t) => t.replace(/^[.-]+|[.-]+$/g, "")).filter(Boolean).flatMap((t) => [t, stem(t)]));

/** rank cards by the question: identifiers and rare terms count more (idf over the candidate cards), fact labels count once. Pure. */
export function rankCards(cards, q) {
  const toks = cards.map((c) => cardTokens(c.text));
  const df = (t) => toks.filter((s) => s.has(t)).length;
  const N = Math.max(1, cards.length);
  return cards.map((card, i) => {
    let score = 0, hits = 0;
    for (const t of q.terms) if (toks[i].has(t)) { score += 1 + Math.log(1 + N / Math.max(1, df(t))); hits++; }
    for (const t of q.labelTerms) if (toks[i].has(t)) { score += 0.75; hits++; }
    return { card, score, hits, i };
  }).sort((a, b) => b.score - a.score || a.i - b.i);
}

/** documents whose stored values mention a rare content word of the question (a vendor, a company, a name that is not a customer): the structured route to a document the page search may miss */
async function probeStoredValues(db, q, limit = 40) {
  const words = q.terms.filter((t) => /^[a-z]{4,}$/.test(t)).slice(0, 5);
  if (!words.length) return [];
  const pats = words.map((w) => `%${w}%`);
  const out = new Set();
  const ex = await db.raw(`SELECT DISTINCT x.document_id FROM extractions x WHERE ${T("x")} AND x.field_key NOT LIKE '\\_%' AND COALESCE(NULLIF(x.corrected_value, ''), x.value) ILIKE ANY($1::text[]) LIMIT $2`, [pats, limit]);
  for (const r of ex.rows) out.add(r.document_id);
  if (await store.hasFinancials(db)) {
    const fin = await db.raw(`SELECT DISTINCT f.document_id FROM document_financials f WHERE ${T("f")} AND (f.vendor_name ILIKE ANY($1::text[]) OR f.customer_name ILIKE ANY($1::text[])) LIMIT $2`, [pats, limit]);
    for (const r of fin.rows) out.add(r.document_id);
  }
  return [...out];
}

/** a card as a retrieved-passage row (same shape as searchPassages), merged with the real page-1 passage of the same document when there is one (the dedupe is by document + page) */
function cardRow(card, existing, stageBy) {
  if (existing) return { ...existing, excerpt: `${card.text}\nPAGE ${existing.page_no} TEXT: ${existing.excerpt}`, matched_by: `card+${existing.matched_by}` };
  return { id: `card:${card.documentId}`, document_id: card.documentId, page_no: 1, original_filename: card.filename, document_type: card.documentType, stage: stageBy.get(card.documentId) ?? null, excerpt: card.text, rank: 1, matched_by: "card" };
}

/**
 * `ev` = { passages, extractions, documentIdsFilter } as retrieveEvidence got them from searchPassages / searchExtractions.
 * Returns { passages, extractions, cards, subject, refined } in the same row shapes. Never throws.
 */
export async function augmentEvidence(db, question, ev, { limit = 12 } = {}) {
  const base = { passages: ev.passages ?? [], extractions: ev.extractions ?? [], cards: [], subject: null, refined: false };
  let savepoint = false;
  try {
    // a failed statement inside the caller's transaction would poison every later query of the request: guard all of this with a savepoint
    try { await db.raw("SAVEPOINT donovan_r4"); savepoint = true; } catch { savepoint = false; }
    let passages = base.passages.slice(), extractions = base.extractions.slice();
    const scoped = Boolean(ev.documentIdsFilter && ev.documentIdsFilter.length);
    const subject = scoped ? null : await resolveSubject(db, question);
    let candidateIds = [];
    if (subject?.documentIds?.length) {
      // (c) hard filter: the subject's own documents only
      const allowed = new Set(subject.documentIds);
      const sp = await db.searchPassages(question, limit, { documentIds: subject.documentIds });
      passages = sp.length ? sp : passages.filter((p) => allowed.has(p.document_id));
      extractions = extractions.filter((x) => allowed.has(x.document_id));
      candidateIds = subject.documentIds.slice(0, CANDIDATE_DOCS);
    } else {
      candidateIds = [...new Set([...passages.map((p) => p.document_id), ...extractions.map((x) => x.document_id)])];
    }
    const q = queryTerms(question, { subjectTokens: new Set(tokensOf(normalizeText(subject?.label ?? ""))) });
    if (!subject?.documentIds?.length) { try { for (const id of await probeStoredValues(db, q)) if (!candidateIds.includes(id)) candidateIds.push(id); } catch { /* the page search above still stands */ } }
    candidateIds = candidateIds.slice(0, CANDIDATE_DOCS);
    let cards = [];
    if (cardsStoreEnabled()) {
      try { await db.raw("SAVEPOINT donovan_r4_cards"); cards = await readStoredCards(db, candidateIds); await db.raw("RELEASE SAVEPOINT donovan_r4_cards"); }
      catch { cards = []; await db.raw("ROLLBACK TO SAVEPOINT donovan_r4_cards").catch(() => {}); } // table not created (optional): fall back to cards built on the fly
    }
    if (cards.length < candidateIds.length) {
      const have = new Set(cards.map((c) => c.documentId));
      cards = [...cards, ...(await loadCards(db, candidateIds.filter((id) => !have.has(id))))];
    }
    const ranked = rankCards(cards, q);
    // keep a card when it mentions a term of the question; with a subject and no fact term at all, the newest documents (the order candidateIds came in)
    const chosen = ranked.filter((r) => r.hits > 0).slice(0, CARDS_PER_QUESTION).map((r) => r.card);
    if (!chosen.length && subject?.documentIds?.length) chosen.push(...ranked.slice(0, 3).map((r) => r.card));
    // (d) one refined search with the subject explicit when nothing retrieved mentions the question's fact words
    let refined = false;
    const mentions = (text) => { const t = cardTokens(text); return q.terms.some((x) => t.has(x)) || q.labelTerms.some((x) => t.has(x)); };
    if (subject?.documentIds?.length && !passages.some((p) => mentions(p.excerpt)) && !chosen.some((c) => mentions(c.text))) {
      refined = true;
      const rp = await db.searchPassages(`${subject.label} ${[...q.labelTerms, ...q.terms].join(" ")}`.trim(), limit, { documentIds: subject.documentIds });
      const have = new Set(passages.map((p) => p.id)); passages = [...passages, ...rp.filter((p) => !have.has(p.id))].slice(0, limit);
    }
    const stageBy = new Map(passages.map((p) => [p.document_id, p.stage]));
    const rows = [];
    for (const c of chosen) {
      const i = passages.findIndex((p) => p.document_id === c.documentId && p.page_no === 1);
      rows.push(cardRow(c, i >= 0 ? passages[i] : null, stageBy));
      if (i >= 0) passages.splice(i, 1);
    }
    const result = { passages: [...rows, ...passages].slice(0, limit + CARDS_PER_QUESTION), extractions, cards: chosen, subject: subject ? { kind: subject.kind, label: subject.label, documents: subject.documentIds.length } : null, refined };
    if (savepoint) await db.raw("RELEASE SAVEPOINT donovan_r4").catch(() => {});
    return result;
  } catch (err) {
    if (savepoint) await db.raw("ROLLBACK TO SAVEPOINT donovan_r4").catch(() => {});
    console.error("retrieval v2 failed, using the plain evidence:", err?.message);
    return base;
  }
}
