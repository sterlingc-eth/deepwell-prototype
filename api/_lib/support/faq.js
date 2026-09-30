/**
 * Round 28 — Support Assistant, the $0 FAQ matcher over the generated knowledge base.
 *
 * No model, no network, no database: a phrase/keyword scorer with light stemming and IDF weighting.
 * Entries come from docs/help/*.md via scripts/build-support-kb.mjs (kb.generated.js), so every price and
 * limit in an answer was rendered from PLAN_CATALOG / PLAN_LIMITS at build time.
 *
 * Score = phrase hits (multi-word keywords count the most) + weighted single-keyword hits + overlap with the
 * entry's own question. An answer is returned only when the best score clears STRONG and beats the runner-up
 * (unless both are the same article, where the better one is fine to show).
 */
import { ENTRIES, ARTICLES } from './kb.generated.js';
import { norm } from './guard.js';

export const STRONG = 2.8;   // best score needed to answer at $0
export const NEAR = 1.6;     // below STRONG but at least this: offered as a "did you mean" chip
const MARGIN = 0.45;
const MIN_COVERAGE = 0.34;   // at least half of the visitor's content words must be explained by the winning entry         // best must beat a runner-up from a DIFFERENT article by this much

const STOP = new Set(('a an the is are was were be been am do does did i you your my me we our us it its to of for in on at by can could would should will shall how what when where who whom why which there this that these those with without and or but if so as than then too very just please pls hi hello hey want need like get got have has had also about into from up out any some whats hows wheres whos thats theres im ive id dont cant wont own first') .split(' '));

/** Tiny stemmer, applied identically to keywords and messages so they meet in the middle. */
export function stem(w) {
  let t = w;
  if (t.length > 4 && t.endsWith('ies')) return `${t.slice(0, -3)}y`;
  if (t.length > 5 && t.endsWith('ing')) t = t.slice(0, -3);
  else if (t.length > 4 && t.endsWith('ed')) t = t.slice(0, -2);
  else if (t.length > 4 && t.endsWith('es') && /(?:ss|x|ch|sh)es$/.test(t)) t = t.slice(0, -2);
  else if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
  if (t.length > 4 && t.endsWith('e')) t = t.slice(0, -1);
  return t;
}

/** message -> {all: stems (stopwords kept, for phrase matching), content: Set of non-stop stems} */
export function tokenize(text) {
  const words = norm(text).split(' ').filter(Boolean).map((w) => w.replace(/^[.$]+|[.]+$/g, '')).filter(Boolean);
  const all = words.map(stem);
  let seq = words.filter((w) => !STOP.has(w)).map(stem);
  // "deepwell" is in nearly every visitor message, so it only carries meaning in a short one ("what is deepwell").
  if (seq.length > 3) seq = seq.filter((t) => t !== 'deepwell');
  return { all, seq, content: new Set(seq), joined: ` ${all.join(' ')} ` };
}

/** Every word the KB knows (questions, keywords, answers). A message full of words outside it is not FAQ material. */
const VOCAB = new Set();
for (const e of ENTRIES) for (const src of [e.q, e.a, ...e.kw]) for (const w of tokenize(src).seq) VOCAB.add(w);
for (const a of ARTICLES) for (const w of tokenize(`${a.title} ${a.intro}`).seq) VOCAB.add(w);

const ARTICLE_BY_ID = new Map(ARTICLES.map((a) => [a.id, a]));

/* ------------------------------------------------------------------ index (built once per instance) */
const index = ENTRIES.map((e) => {
  const qTok = tokenize(e.q);
  const phrases = e.kw.map((k) => tokenize(k)).filter((t) => t.all.length > 0);
  const vocab = new Set();
  for (const src of [e.q, e.a, ...e.kw]) for (const w of tokenize(src).seq) vocab.add(w);
  return { e, qContent: qTok.content, qJoined: qTok.joined, phrases, vocab };
});
const df = new Map();
for (const it of index) {
  const seen = new Set();
  for (const p of it.phrases) if (p.seq.length === 1) seen.add(p.seq[0]);
  for (const t of it.qContent) seen.add(t);
  for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
}
const N = index.length;
const idf = (t) => Math.max(0.15, Math.log((N + 1) / ((df.get(t) ?? 0) + 1)) / Math.log(N + 1));
const artKwIndex = new Map(ARTICLES.map((a) => [a.id, a.keywords.map((k) => tokenize(k)).filter((t) => t.seq.length === 1).map((t) => t.seq[0])]));

/** Do the phrase's content tokens appear in order in the message, within a small span? Returns the span slack or -1. */
function orderedSpan(pseq, mseq) {
  const n = pseq.length;
  for (let i = 0; i < mseq.length; i++) {
    if (mseq[i] !== pseq[0]) continue;
    let pos = i;
    let ok = true;
    for (let k = 1; k < n; k++) {
      let found = -1;
      for (let j = pos + 1; j < Math.min(mseq.length, pos + 3); j++) if (mseq[j] === pseq[k]) { found = j; break; }
      if (found < 0) { ok = false; break; }
      pos = found;
    }
    if (ok) return pos - i - (n - 1);
  }
  return -1;
}

function scoreEntry(it, msg) {
  let score = 0;
  let hits = 0;
  const matchedTokens = new Set();
  // 1. keyword phrases
  const phraseScores = [];
  for (const p of it.phrases) {
    const pc = p.seq;
    if (pc.length === 0) {
      if (p.all.length > 1 && msg.joined.includes(p.joined)) { phraseScores.push(1.2); hits++; }
    } else if (pc.length === 1) {
      const t = pc[0];
      if (msg.content.has(t)) {
        let w = 0.7 + 1.5 * idf(t);
        if (p.all.length > 1 && msg.joined.includes(p.joined)) w += 0.8;
        phraseScores.push(w); matchedTokens.add(t); hits++;
      }
    } else {
      const slack = orderedSpan(pc, msg.seq);
      if (slack >= 0) {
        let w = (slack === 0 ? 1.9 : 1.4) + 0.9 * Math.min(4, pc.length - 1);
        if (msg.joined.includes(p.joined)) w += 0.5;
        // phrases made of rare words (records rescue, support access) outrank phrases of common ones (how much, my data)
        const avgIdf = pc.reduce((a, t) => a + idf(t), 0) / pc.length;
        w *= 0.65 + 0.7 * avgIdf;
        phraseScores.push(w);
        for (const t of pc) matchedTokens.add(t);
        hits++;
      }
    }
  }
  phraseScores.sort((a, b) => b - a);
  // diminishing returns: full credit for the best 3, half credit after that
  phraseScores.forEach((s, i) => { score += i < 2 ? s : s * 0.3; });
  // 2. overlap with the entry's own question text
  let qHits = 0;
  for (const t of it.qContent) if (msg.content.has(t)) { qHits += idf(t); matchedTokens.add(t); }
  const qDen = Math.max(1, [...it.qContent].reduce((a, t) => a + idf(t), 0));
  score += 5 * (qHits / qDen);
  // 3. exact / near-exact question
  if (msg.joined === it.qJoined) score += 8;
  // 4. article keywords: tie-break only, and only when the entry already matched something
  if (hits > 0 || qHits > 0) {
    for (const t of artKwIndex.get(it.e.article) ?? []) if (msg.content.has(t) && !matchedTokens.has(t)) score += 0.25;
  }
  // 5. coverage: penalise messages whose content words are mostly unexplained by this entry
  const explained = [...msg.content].filter((t) => matchedTokens.has(t)).length;
  score *= 0.7 + 0.3 * (msg.content.size ? explained / msg.content.size : 0);
  // coverage: how much of what the visitor said is even in this entry's vocabulary (question + keywords + answer)
  const known = [...msg.content].filter((t) => it.vocab.has(t) || /^\d+$/.test(t)).length;
  const coverage = msg.content.size ? known / msg.content.size : 0;
  return { score, coverage };
}

/**
 * @param {string} text
 * @param {{surface?: string}} [opts]
 * @returns {{hit: null | {entry: object, article: object, score: number}, top: Array<{entry: object, score: number}>, confident: boolean}}
 */
export function matchFaq(text) {
  const msg = tokenize(text);
  if (msg.content.size === 0) return { hit: null, top: [], confident: false };
  const scored = index.map((it) => { const r = scoreEntry(it, msg); return { entry: it.e, score: r.score, coverage: r.coverage }; }).filter((x) => x.score > 0.4).sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 3);
  const best = top[0];
  if (!best) return { hit: null, top, confident: false };
  const second = top.find((x) => x.entry.article !== best.entry.article);
  const oov = [...msg.content].filter((t) => !VOCAB.has(t) && !/^\d+$/.test(t));
  const mostlyUnknown = oov.length >= 2 && oov.length / msg.content.size >= 0.25;
  const confident = !mostlyUnknown && best.coverage >= MIN_COVERAGE && best.score >= STRONG && (!second || best.score - second.score >= MARGIN || best.score >= second.score * 1.12);
  return {
    hit: confident ? { entry: best.entry, article: ARTICLE_BY_ID.get(best.entry.article), score: best.score } : null,
    top,
    confident,
  };
}

/** Up to 3 short follow-up chips from the same article as `entry` (never the entry itself). */
export function suggestionsFor(entry) {
  const out = [];
  for (const e of ENTRIES) {
    if (e.article === entry.article && e.id !== entry.id && e.q.length <= 60) out.push(e.q);
    if (out.length === 3) break;
  }
  return out;
}

export function articleById(id) { return ARTICLE_BY_ID.get(id) ?? null; }
export function entryById(id) { return ENTRIES.find((e) => e.id === id) ?? null; }
export function contactEntry() { return ENTRIES.find((e) => e.article === 'contacting-humans') ?? null; }
