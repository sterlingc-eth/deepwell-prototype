/**
 * search/extractive.js - the extractive reader: answer "what does the paper SAY" by quoting the paper, with no model.
 *
 *   splitUnits(pageText)                 a page -> quotable units: labelled lines ("Payment Terms: Net 30"), clause lines, and the sentences of a long paragraph
 *   topicOf(question, drop)              the question's content words as concepts (a concept = the words that name it, with plain synonyms)
 *   readPages(concepts, pages, opts)     BM25 over the units of the candidate pages -> {ok, best, runnerUp, why}
 *
 * The rule is precision over recall: the best unit is returned only when (1) it covers EVERY concept of the question, (2) it beats the best
 * DIFFERENT unit by a margin, (3) its words are really on that page (verbatim substring, every number of it on the page). Anything else is
 * {ok:false, why}, and the caller releases the question. Nothing is ever composed: the answer is the paper's own words.
 * Pure. No I/O, no clock. Nothing here names a business or an industry.
 */
import { numbersIn } from '../grounding/gate.js';

const norm = (s) => String(s ?? '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
const lc = (s) => norm(s).toLowerCase();
export const tokens = (s) => lc(s).replace(/'/g, '').match(/[a-z0-9]+(?:[-.][a-z0-9]+)*/g) ?? [];

/** Plain stem: plural, -ing, -ed, -ation, -al. Enough to join "terminate / termination / terminated", "fee / fees", "renews / renewal". */
export function stem(w) {
  let x = String(w).toLowerCase();
  if (x.length <= 3 || /\d/.test(x)) return x;
  if (/ies$/.test(x)) x = `${x.slice(0, -3)}y`;
  else if (/(?:ss|us|is)$/.test(x)) { /* keep */ } else if (/(?:ches|shes|sses|xes)$/.test(x)) x = x.slice(0, -2);
  else if (/s$/.test(x)) x = x.slice(0, -1);
  if (/ations?$/.test(x) && x.length > 7) x = x.replace(/ations?$/, 'at');
  else if (/ing$/.test(x) && x.length > 5) { x = x.slice(0, -3); if (/(.)\1$/.test(x)) x = x.slice(0, -1); } else if (/ed$/.test(x) && x.length > 4) { x = x.slice(0, -2); if (/(.)\1$/.test(x)) x = x.slice(0, -1); } else if (/(?:al|ly)$/.test(x) && x.length > 6) x = x.slice(0, -2);
  if (/e$/.test(x) && x.length > 4) x = x.slice(0, -1);
  return x;
}

/** Plain-language synonym sets: a concept is satisfied by any member. Generic business words; nothing industry specific. */
const SYN_SETS = [
  'terminate termination terminated cancel cancelled cancellation cancelling revoke rescind',
  'renew renewal renews renewed extend extended extension rollover',
  'fee fees charge charges charged penalty penalties surcharge',
  'warranty warranties warrant warrants warranted guarantee guaranteed guaranty',
  'deposit deposits retainer',
  'insurance insured insure indemnify indemnity',
  'liability liable',
  'sign signed signs signature signatures execute executed',
  'govern governing governed jurisdiction venue',
  'refund refunds refundable reimburse',
  'late overdue delinquent',
  'confidential confidentiality disclose disclosure',
  'dispute disputes arbitration mediation',
  'pay payment payments',
  'terms term due net payable',
  'note notes comment comments remark remarks observation observations',
];
const SYN = new Map();
for (const set of SYN_SETS) { const arr = [...new Set(set.split(' ').map(stem))]; for (const w of arr) SYN.set(w, arr); }

/** Words that are the question's grammar, or the paper's own name, never the topic. */
const STOP = new Set(`a an the of for on in at to from by with about and or is are was were be been do does did what whats which who whom when where how why any anything something
 say says said state states stated mention mentions mentioned include includes included cover covers contain contains specify specifies there it its this that these those
 me my our their your us we you they please tell show give find get have has had can could would should will shall if so as than then also just only
 last latest recent most previous first visit visits time one two`.split(/\s+/));
/** Words that shape the question but need not be found in the quote ("the warranty TERM"). */
const SOFT = new Set('term terms length period duration policy clause clauses section provision provisions details detail info information wording text language say regarding concerning'.split(' '));

/**
 * The question's concepts. `drop` = lowercase words already explained elsewhere (customer name, paper kind, document code).
 * @returns {{concepts: {word:string, stems:string[], soft:boolean}[], phrase:string}}
 */
export function topicOf(question, drop = []) {
  const dropSet = new Set(drop.flatMap((d) => tokens(d)));
  const seen = new Set(); const concepts = [];
  for (const w of tokens(question)) {
    if (STOP.has(w) || dropSet.has(w) || /^\d+$/.test(w) || w.length < 3) continue;
    const st = stem(w);
    const group = SYN.get(st) ?? [st];
    const key = [...group].sort()[0];
    if (seen.has(key)) continue;
    seen.add(key);
    concepts.push({ word: w, stems: group, soft: SOFT.has(w) });
  }
  // "payment TERMS": the plural names the thing asked for, so it must be found too
  if (concepts.some((c) => /^pay/.test(c.word))) for (const c of concepts) if (c.word === 'terms') c.soft = false;
  return { concepts };
}

/* ------------------------------------------------------------------ units */
const LABELLED = /^\s*([A-Za-z][A-Za-z0-9 /&'.-]{1,40}?)\s*:\s*(\S.*)$/;
/** A page -> units {text, label, heading, line}. `text` is always an exact substring of the page text (after whitespace folding). */
export function splitUnits(pageText) {
  const out = [];
  const lines = String(pageText ?? '').split(/\r?\n/);
  lines.forEach((raw, li) => {
    const line = norm(raw);
    if (line.length < 6) return;
    const lab = LABELLED.exec(line);
    const numbered = /^\s*\d{1,2}[.)]\s+/.test(line);
    let heading = null;
    if (lab && lab[1].split(' ').length <= 5) heading = lab[1];
    else if (numbered) { const h = /^\s*\d{1,2}[.)]\s+([^.]{2,50})\./.exec(line); heading = h ? h[1] : null; }
    if (line.length <= 420) { out.push({ text: line, heading, line: li }); return; }
    // a long paragraph: its sentences (a sentence keeps the heading of its line)
    const sents = line.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) ?? [line];
    for (const s of sents) { const t = norm(s); if (t.length >= 12) out.push({ text: t, heading, line: li }); }
  });
  return out;
}

/* ------------------------------------------------------------------ scoring */
const K1 = 1.2; const B = 0.75;
function unitStems(u) { return new Map([...tokens(u.text)].map((w) => stem(w)).reduce((m, s) => m.set(s, (m.get(s) ?? 0) + 1), new Map())); }

/**
 * @param concepts  from topicOf()
 * @param pages     [{docId, filename, page, text, order}] the candidate pages (a few documents)
 * @param opts      {margin = 1.25, minScore = 1.0, answerLabel = null}
 * @returns {{ok:boolean, why?:string, best?:object, runnerUp?:object, ranked:object[]}}
 */
export function readPages(concepts, pages, opts = {}) {
  const { margin = 1.25, minScore = 0.6 } = opts;
  const need = concepts.filter((c) => !c.soft);
  if (!need.length) return { ok: false, why: 'no topic words', ranked: [] };
  const units = [];
  for (const p of pages) for (const u of splitUnits(p.text)) units.push({ ...u, docId: p.docId, filename: p.filename, page: p.page, pageText: p.text, tf: null });
  if (!units.length) return { ok: false, why: 'no text', ranked: [] };
  for (const u of units) u.tf = unitStems(u);
  const N = units.length; const avgLen = units.reduce((a, u) => a + u.text.length, 0) / N || 1;
  const df = (c) => units.reduce((n, u) => n + (c.stems.some((s) => u.tf.has(s)) ? 1 : 0), 0);
  const idf = new Map(concepts.map((c) => { const d = df(c); return [c, Math.max(0.7, Math.log(1 + (N - d + 0.5) / (d + 0.5)))]; })); // floor: a topic word every unit shares (a tiny paper) still counts
  for (const u of units) {
    let score = 0; let covered = 0; let hardCovered = 0;
    const headStems = new Set(tokens(u.heading ?? '').map(stem));
    for (const c of concepts) {
      const tf = c.stems.reduce((a, s) => Math.max(a, u.tf.get(s) ?? 0), 0);
      const inHead = c.stems.some((s) => headStems.has(s));
      if (!tf && !inHead) continue;
      const w = idf.get(c) * ((Math.max(tf, 1) * (K1 + 1)) / (Math.max(tf, 1) + K1 * (1 - B + B * (u.text.length / avgLen)))) * (c.soft ? 0.3 : 1) * (inHead ? 1.5 : 1);
      score += w; covered++; if (!c.soft) hardCovered++;
    }
    u.score = score; u.covers = hardCovered === need.length; u.coveredN = covered;
  }
  const ranked = units.filter((u) => u.score > 0).sort((a, b) => b.score - a.score);
  if (!ranked.length) return { ok: false, why: 'nothing matches', ranked };
  const best = ranked[0];
  if (!best.covers) return { ok: false, why: 'top span misses a topic word', best, ranked };
  if (best.score < minScore) return { ok: false, why: 'weak match', best, ranked };
  const same = (a, b) => lc(a.text) === lc(b.text);
  const runnerUp = ranked.find((u) => !same(u, best) && !(u.docId === best.docId && u.page === best.page && best.text.includes(u.text)) && !(u.text.includes(best.text) && u.docId === best.docId && u.page === best.page));
  if (runnerUp && runnerUp.score * margin > best.score) return { ok: false, why: 'runner-up too close', best, runnerUp, ranked };
  // the same wording on two pages / papers is one answer, not two; a different wording with the same score was handled above
  if (best.text.length > 420) return { ok: false, why: 'span too long', best, ranked };
  if (!grounded(best)) return { ok: false, why: 'span not on the page', best, ranked };
  return { ok: true, best, runnerUp: runnerUp ?? null, ranked };
}

/** The span is verbatim on its page, and every number in it is a number of that page. */
export function grounded(u) {
  const page = norm(u.pageText);
  if (!page.includes(u.text)) return false;
  const pageNums = numbersIn(page);
  return [...numbersIn(u.text)].every((n) => pageNums.has(n));
}
