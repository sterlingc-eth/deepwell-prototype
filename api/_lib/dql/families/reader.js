/**
 * dql/families/reader.js - family "reader": what a paper SAYS, answered by quoting the paper (no model).
 *
 *   read_span   "what does the agreement for <customer> say about termination", "does the contract for <customer> mention late fees",
 *               "who signed the lease for <customer>", "what are the payment terms on invoice INV-123",
 *               "what was the note on the last visit to <customer>"
 *
 * The parsed filters (customer, paper kind, document number) pick the few papers that can answer; runDql then reads only THEIR pages
 * (loadReaderPages), search/extractive.js scores the lines and sentences, and the best one is quoted word for word with the file name,
 * date and page. The answer is given only when that span covers every topic word of the question, clearly beats the next best span,
 * and is really on that page; otherwise the question is released (to the older lanes / the model), never guessed.
 * Private papers (HR letters, internal-audience papers) are never in the snapshot and are filtered again when the pages are read.
 * Kill switch: DONOVAN_READER=0.
 */
import { appendFileSync as fsAppend } from 'node:fs';
import { registerFamily } from '../registry.js';
import { selectRows } from '../exec.js';
import { fmtDate, recordFor } from '../say.js';
import { documentTypeLabel } from '../../documentTypes.js';
import { isPrivateDoc, notPrivateIdSql } from '../../privacy/privateDocs.js';
import { TENANT_SQL } from '../../scope.js';
import { topicOf, readPages } from '../../search/extractive.js';

export const READER_OPS = ['read_span'];
const on = () => process.env.DONOVAN_READER !== '0';
const MAX_DOCS = 12;
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const lc = (s) => norm(s).toLowerCase();

const VISIT_TYPE = /work-?order|service|ticket|inspection|visit|dispatch|call/;
const LATEST = /\b(?:last|latest|most\s+recent|newest|previous)\b/i;
/** Topics a plain "what is the X on ..." may ask for (clause words); structured fields (a total, a date, an address) are left to the other lanes. */
const CLAUSE_WORD = /^(?:terminat\w*|cancel\w*|renew\w*|warrant\w*|guarant\w*|governing|late|terms|conditions|liabilit\w*|confidential\w*|indemn\w*|arbitrat\w*|dispute\w*|refund\w*)$/;

const CODE_RE = /\b([A-Za-z]{1,5}-?\d{3,}(?:-\d+)?)\b/;

/** Cheap text test used by the parser: does the question have the shape of a "what does the paper say" ask about one customer's / one numbered paper? */
export function readerShaped(raw) {
  if (!on()) return false;
  const b = norm(raw).toLowerCase();
  return /\b(?:say|says|mention|mentions|include|includes|cover|covers|contain|contains|specify|specifies|state|states)\b/.test(b) && /\b(?:agreement|contract|lease|invoice|policy|quote|estimate|proposal|warranty|permit|statement)\b/.test(b)
    || /\bwhat\b.*\b(?:late|governing|terms|terminat\w*|cancel\w*|renew\w*)\b.*\b(?:agreement|contract|lease|invoice)\b/.test(b);
}

function analyze(feat) {
  if (!on() || !feat?.raw) return null;
  const q = norm(feat.raw).replace(/[?.!]+$/, '');
  if (q.length > 200) return null;
  if (feat.time || (feat.times?.length ?? 0)) return null;
  const cust = (feat.filters ?? []).filter((f) => f.role === 'customer');
  if ((feat.filters ?? []).length !== cust.length || cust.length > 1) return null;
  const docTypes = feat.docTypes ?? [];
  if (docTypes.length > 1) return null;
  const codeM = CODE_RE.exec(q);
  const code = codeM && /\d/.test(codeM[1]) && /^[A-Za-z]/.test(codeM[1]) ? codeM[1] : null;
  const L = q.toLowerCase();
  const GLUE = /^(?:hey|hi|please|pls|can you|could you|tell me|show me|i need to know|do you know)\s*,?\s*/;
  const body = L.replace(GLUE, '');
  let mode = null; let topicSrc = null;
  if (/\bwho\s+(?:signed|executed|countersigned)\b/.test(body)) { mode = 'who'; topicSrc = 'signed'; }
  else if (/\b(?:notes?|comments?|remarks?)\b/.test(body) && LATEST.test(body) && /\b(?:visit|service|call|appointment|inspection|job)\b/.test(body) && cust.length === 1) { mode = 'note'; topicSrc = 'note'; }
  else if (/^(?:what|which)\b.*\b(?:does|do|did)\b.*\b(?:say|state|specify|provide|spell\s+out)\b.*\b(?:about|on|regarding|concerning|for)\b/.test(body)) { mode = 'quote'; topicSrc = body.replace(/^.*\b(?:say|says|state|states|specify|specifies|provide|provides|spell\s+out)\b\s*(?:about|on|regarding|concerning|for)?\s*/, ''); }
  else if (/^(?:does|do|did|is\s+there|are\s+there)\b.*\b(?:mention|mentions|include|includes|say|says|cover|covers|contain|contains|specify|specifies|state|states|provide|provides)\b/.test(body)) { mode = 'yesno'; topicSrc = body.replace(/^.*\b(?:mention|mentions|include|includes|say|says|cover|covers|contain|contains|specify|specifies|state|states|provide|provides)\b\s*(?:anything\s+about|about|any|a|an|the)?\s*/, ''); }
  else if (/^(?:what|whats|what's)\b/.test(body)) {
    const m = /^(?:what|whats|what's)\s+(?:is|are|was|were)?\s*(?:the|our|their)?\s*([a-z][a-z -]{2,40}?)\s+(?:on|in|under|of|for)\s+(?:the|this|that)?\s*(?:.+)$/.exec(body);
    if (m && m[1].split(' ').some((w) => CLAUSE_WORD.test(w))) { mode = 'quote'; topicSrc = m[1]; }
  }
  if (!mode) return null;
  // the question must name WHICH paper: a customer's paper kind, a document number, or (notes) a customer
  const hasDocKind = docTypes.length === 1 || /\b(?:agreement|contract|lease|invoice|policy|quote|estimate|proposal|warranty|permit|statement)\b/.test(body);
  if (mode !== 'note' && !((cust.length === 1 && hasDocKind) || code)) return null;
  if (mode !== 'note' && cust.length === 1 && docTypes.length !== 1) return null; // "the contract" must resolve to one kind of paper in this company
  if (mode === 'who' && !cust.length && !code) return null;
  // trailing clauses / second asks are not a single span question
  if (/\b(?:and|also|plus|compare|versus|vs)\b.*\b(?:what|who|how|when|total|amount|date)\b/.test(body.replace(/payment and /g, ''))) return null;
  const drop = [...cust.map((f) => f.value), feat.docWord ?? '', code ?? '', 'agreement', 'contract', 'lease', 'invoice', 'paperwork', 'document', 'paper', 'visit'];
  const { concepts } = mode === 'who' ? topicOf('signed', []) : mode === 'note' ? topicOf('note', []) : topicOf(topicSrc, drop);
  if (concepts.length === 1 && concepts[0].word === 'terms' && code) concepts[0].soft = false; // "the terms on invoice INV-12": the paper's own terms line
  if (!concepts.length || concepts.every((c) => c.soft)) return null;
  if (concepts.length > 3) return null;
  return {
    v: 1, op: 'read_span', entity: 'document', docType: docTypes[0] ?? null, docWord: feat.docWord ?? null, visit: false,
    filters: cust.map((f) => ({ ...f })), time: null, measure: null, groupBy: [], limit: null, dir: 'desc',
    mode, code, latest: LATEST.test(body), concepts, topic: norm(topicSrc ?? ''),
  };
}

/* ------------------------------------------------------------------ candidate papers */
const docNumberOf = (d, snap) => {
  const fin = (snap.fin ?? []).find?.((f) => f.doc?.id === d.id);
  return d.f?.invoice_number ?? fin?.invoice_number ?? d.f?.po_number ?? d.f?.permit_number ?? d.f?.quote_number ?? null;
};
const dateKey = (d) => String(d.date ?? d.createdAt ?? '');

/** The papers that can answer: {docs} or {abstain}. Pure over the snapshot (no page text). */
export function readerCandidates(plan, snap, today) {
  let rows;
  if (plan.mode === 'note') {
    const sel = selectRows({ ...plan, docType: null, visit: false }, snap, today);
    if (sel.abstain) return { abstain: sel.abstain };
    rows = sel.rows.filter((d) => VISIT_TYPE.test(String(d.type)));
    if (!rows.length) return { abstain: 'no-visits' };
    const top = rows.map(dateKey).sort().pop();
    if (!top) return { abstain: 'undated' };
    rows = rows.filter((d) => dateKey(d) === top);
  } else if (plan.code) {
    const want = lc(plan.code);
    rows = snap.documents.filter((d) => lc(docNumberOf(d, snap)) === want || lc(d.filename).includes(want));
    if (plan.filters.length) { const sel = selectRows({ ...plan, docType: plan.docType }, snap, today); if (sel.abstain) return { abstain: sel.abstain }; const ok = new Set(sel.rows.map((d) => d.id)); rows = rows.filter((d) => ok.has(d.id)); }
    if (plan.docType) rows = rows.filter((d) => d.type === plan.docType);
  } else {
    const sel = selectRows(plan, snap, today);
    if (sel.abstain) return { abstain: sel.abstain };
    rows = sel.rows;
  }
  rows = rows.filter((d) => !isPrivateDoc({ document_type: d.type }));
  if (!rows.length) return { abstain: 'no-paper' };
  if (plan.latest && plan.mode !== 'note') { rows = [...rows].sort((a, b) => dateKey(b).localeCompare(dateKey(a))); const top = dateKey(rows[0]); rows = rows.filter((d) => dateKey(d) === top); }
  if (rows.length > MAX_DOCS) return { abstain: 'too-many' };
  return { docs: rows };
}

/** Called by runDql for a read_span plan: fetch the pages of the candidate papers only (one tenant-scoped read) and hang them on the snapshot. */
export async function loadReaderPages(db, snap, plan, today) {
  const c = readerCandidates(plan, snap, today);
  snap.pageText = new Map();
  if (c.abstain) return;
  const ids = c.docs.map((d) => d.id);
  const { rows } = await db.raw(`SELECT p.document_id, p.page_no, p.text FROM document_pages p WHERE p.document_id = ANY($1::uuid[]) AND p.${TENANT_SQL} AND ${notPrivateIdSql('p.document_id')} ORDER BY p.document_id, p.page_no`, [ids]);
  for (const r of rows ?? []) { if (!snap.pageText.has(r.document_id)) snap.pageText.set(r.document_id, []); snap.pageText.get(r.document_id).push({ page: Number(r.page_no), text: String(r.text ?? '') }); }
}

/* ------------------------------------------------------------------ execution */
function exec(plan, x) {
  const r = exec0(plan, x);
  if (process.env.READER_DEBUG && r?.abstain) { try { fsAppend(process.env.READER_DEBUG, `${plan.mode} ${plan.topic} :: ${r.abstain}\n`); } catch { /* debug only */ } }
  return r;
}
function exec0(plan, x) {
  const { snap, today } = x;
  if (!on()) return { abstain: 'off' };
  if (!(snap.pageText instanceof Map)) return { abstain: 'no-pages' };
  const c = readerCandidates(plan, snap, today);
  if (c.abstain) return { abstain: c.abstain };
  const found = [];
  for (const d of c.docs) {
    const pages = (snap.pageText.get(d.id) ?? []).map((p) => ({ docId: d.id, filename: d.filename, page: p.page, text: p.text }));
    if (!pages.length) return { abstain: 'no-text' };
    const r = readPages(plan.concepts, pages, {});
    if (!r.ok) return { abstain: `unsure: ${r.why}` };
    found.push({ d, best: r.best });
  }
  if (!found.length) return { abstain: 'none' };
  const key = (f) => lc(f.best.text);
  if (found.some((f) => key(f) !== key(found[0]))) return { abstain: 'papers differ' };
  const pick = [...found].sort((a, b) => dateKey(b.d).localeCompare(dateKey(a.d)))[0];
  return { d: pick.d, best: pick.best, same: found.length };
}

const NEGATED = /\b(?:no|not|none|never|without|waive[sd]?|excluded?|exempt|n\/a)\b/i;
function say(res, plan, { snap }) {
  const { d, best } = res;
  const kind = (documentTypeLabel(d.type) ?? d.type ?? 'paper').toLowerCase();
  const who = d.custName ? ` for ${d.custName}` : '';
  const span = best.text;
  const src = `${d.filename}${d.date ? `, ${fmtDate(d.date)}` : ''}, page ${best.page}`;
  let lead;
  if (plan.mode === 'note') lead = `The note on the last visit to ${d.custName ?? 'that customer'}`;
  else if (plan.code) lead = `${documentTypeLabel(d.type) ?? 'The paper'} ${plan.code}`;
  else lead = `The ${plan.docWord ?? kind}${who}`;
  const yes = plan.mode === 'yesno' && !NEGATED.test(span) ? 'Yes. ' : '';
  const text = `${yes}${yes ? lead.replace(/^The /, 'The ') : lead} says (${src}): “${span}”`;
  return {
    text, facts: [{ label: 'File', value: d.filename }, { label: 'Page', value: String(best.page) }],
    records: [{ ...recordFor({ entity: 'document' }, d, snap), page: best.page }], total: 1, claimedCount: null,
    basis: `Read the pages of ${d.filename}${res.same > 1 ? ` (the same wording is on ${res.same} papers; this is the newest)` : ''} and quoted the line that matches your question word for word.`,
  };
}

const beats = (mine) => mine.op === 'read_span';
registerFamily({ id: 'reader', ops: READER_OPS, beats, detect: (feat) => analyze(feat), rescue: (feat) => analyze(feat), exec, say });
export { analyze as _analyze, exec as _exec };
