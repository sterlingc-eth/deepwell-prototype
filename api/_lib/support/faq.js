/**
 * Round 28 — Support Assistant, the $0 FAQ matcher over the generated knowledge base.
 *
 * No model, no network, no database: a phrase/keyword scorer with light stemming and IDF weighting.
 * Entries come from docs/help/*.md via scripts/build-support-kb.mjs (kb.generated.js), so every price and
 * limit in an answer was rendered from PLAN_CATALOG / PLAN_LIMITS at build time.
 *
 * Score = phrase hits (multi-word keywords count the most) + weighted single-keyword hits + overlap with the
 * entry's own question.
 *
 * Round 30 - PRECISION OVER RECALL. A wrong article is worse than a hand-off, so an answer is returned only when ALL hold:
 *   1. the score clears STRONG;
 *   2. the winner beats EVERY other entry (same article or not) by an absolute AND a relative margin;
 *   3. the winner's own question + keywords explain most of what the visitor said, counting words by how specific they are
 *      (a match that rests on "how", "app", "screen", "document" alone is refused);
 *   4. at least one SPECIFIC word (rare in the KB, not a generic one) was matched.
 * When the answer is not sure but two entries both look plausible, matchFaq returns `didYouMean` (2 entries, no answer)
 * so the engine can offer two chips instead of guessing. A message that is exactly an entry's own question always answers.
 */
import { ENTRIES, ARTICLES } from './kb.generated.js';
import { norm } from './guard.js';

export const STRONG = 2.8;   // best score needed to answer at $0
export const NEAR = 1.6;     // below STRONG but at least this: a candidate for a "did you mean" chip
/** Gate thresholds. Exported (mutable) only so scripts can sweep them; nothing in api/ changes them. */
export const GATES = {
  marginAbs: 1.2,        // the winner must beat every other entry by this much ...
  marginRel: 1.3,        // ... and be at least this many times its score
  minCoverage: 0.34,     // share of the visitor's content words that appear ANYWHERE in the entry (question, keywords, answer)
  minExplained: 0.62,    // idf-weighted share explained by the entry's own question + keywords (answer-only words count half)
  minSpecific: 0.5,      // total specificity weight of the matched words (generic words weigh ~0)
  minAnySpecific: 0.3,   // candidates with less matched specificity than this are ignored altogether
  dominantRel: 1.8,      // "towers over the rest": at least this ratio ...
  dominantAbs: 2.0,      // ... and this gap
  overwhelmAbs: 3.0,
  overwhelmRel: 3.0,
  explOverwhelm: 0.3,
  clearRel: 1.4,
  clearAbs: 1.5,
  explDominant: 0.5,     // how much of the question a dominant / clear winner must explain
  explClear: 0.5,
  specDominant: 0.4,
  advantageExpl: 0.3,    // winner explains this much MORE of the question than the runner-up: a smaller score margin is enough
  advantageAbs: 0.5,
  advantageRel: 1.08,
  complementSpec: 0.6,   // the runner-up matched this much specific vocabulary the winner did not ...
  complementExpl: 0.6,   // ... explains this much of the question itself ...
  complementRatio: 0.3,  // ... and is at least this close in score
  contestedExpl: 0.25,   // runner-up explains this much MORE of the question than the winner: do not guess
  verbForgivenExpl: 0.75,
  strangeShortLen: 5,
  dymScore: 2.2,         // both did-you-mean candidates must reach this
  dymExplained: 0.4,
  dymRatio: 0.6,
};

const STOP = new Set(('a an the is are was were be been am do does did i you your my me we our us it its to of for in on at by can could would should will shall how what when where who whom why which there this that these those with without and or but if so as than then too very just please pls hi hello hey want need like get got have has had also about into from up out any some whats hows wheres whos thats theres im ive id dont cant wont own first he she him her his hers they them their theirs myself yourself ourselves themselves') .split(' '));

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

/**
 * ACTION VERBS, grouped by meaning. A question that asks to DO one thing ("log out", "change my card") must not be answered by an
 * entry that only talks about a different action ("sign in", "do I need a card"). Only applied when both the message and the entry
 * (its question + keywords) name at least one of these; verbs outside the table impose nothing.
 */
const VERB_CLASSES = {
  add: 'add invite new create make enter insert register put',
  remove: 'remove delete erase wipe empty clear drop kick revoke',
  cancel: 'cancel unsubscribe terminate close quit',
  change: 'change edit update modify replace fix correct adjust amend rename upgrade downgrade switch move',
  upload: 'upload import drag drop ingest',
  scan: 'scan photograph snap capture camera',
  signin: 'signin login logon',
  signout: 'signout',
  reset: 'reset forgot recover unlock',
  export: 'export download',
  share: 'share forward copy',
  merge: 'merge combine dedupe',
  link: 'link attach assign connect associate match',
  verify: 'verify approve confirm mark validate',
  search: 'search lookup',
  filter: 'filter',
  sort: 'sort group order',
  save: 'save bookmark pin',
  grant: 'grant allow permit',
  toggle: 'turnon turnoff enable disable activate stop mute silence pause',
  start: 'start begin launch',
  install: 'install',
  buy: 'buy purchase',
};
/** Verbs that are (almost) never a noun in a support question; only these decide what a visitor is asking to DO. "scan", "upload", "order", "new", "put" are often nouns or fillers ("my scans", "an upload failed"). */
const FIRM_WORDS = new Set(('add invite create remove delete erase cancel unsubscribe change edit update modify replace fix correct rename upgrade downgrade signin signout reset export download merge combine verify approve search filter turnon turnoff enable disable install buy purchase grant revoke').split(' ').map((w) => stem(w)));
const VERB_OF = new Map();
for (const [cls, words] of Object.entries(VERB_CLASSES)) for (const w of words.split(' ')) { const st = stem(w); if (!VERB_OF.has(st)) VERB_OF.set(st, new Set()); VERB_OF.get(st).add(cls); }
const verbClasses = (tokens) => { const out = new Set(); for (const t of tokens) for (const c of VERB_OF.get(t) ?? []) out.add(c); return out; };

/** message -> {all: stems (stopwords kept, for phrase matching), content: Set of non-stop stems} */
export function tokenize(text) {
  // "sign out" / "log in" / "turn off" differ only in a word the stopword list drops: fuse them so "log out" can never match "sign in".
  const fused = norm(text)
    .replace(/\b(?:sign|log) ?(?:out|off)\b|\blogout\b/g, 'signout')
    .replace(/\b(?:sign|log) in\b/g, 'signin')
    .replace(/\bturn(?:ed|ing)? on\b/g, 'turnon')
    .replace(/\bturn(?:ed|ing)? off\b/g, 'turnoff');
  const words = fused.split(' ').filter(Boolean).map((w) => w.replace(/^[.$]+|[.]+$/g, '')).filter(Boolean);
  const all = words.map(stem);
  let seq = words.filter((w) => !STOP.has(w)).map(stem);
  // "deepwell" is in nearly every visitor message, so it only carries meaning in a short one ("what is deepwell").
  if (seq.length > 3) seq = seq.filter((t) => t !== 'deepwell');
  const content = new Set(seq);
  // the FIRST firm action named is the one being asked for ("adding a new hire so he can log in" is about adding, not logging in)
  const firstFirm = seq.find((t) => FIRM_WORDS.has(t) && VERB_OF.has(t));
  const primary = firstFirm ? VERB_OF.get(firstFirm) : new Set();
  return { all, seq, content, joined: ` ${all.join(' ')} `, verbs: verbClasses(content), primary };
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
  // words the entry claims for itself (its own question and keyword lists), as opposed to words that only occur in its answer
  const qk = new Set(qTok.content);
  for (const src of e.kw) for (const w of tokenize(src).seq) qk.add(w);
  return { e, qContent: qTok.content, qJoined: qTok.joined, phrases, vocab, qk, verbs: verbClasses(qk) };
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
/** Words that say "a question about the app" and nothing else: matching only on these is not evidence (stems). */
const GENERIC = new Set(['app', 'screen', 'page', 'button', 'tab', 'click', 'press', 'tap', 'open', 'go', 'see', 'show', 'look', 'use', 'work', 'thing', 'way', 'new', 'know', 'make', 'take', 'put', 'give', 'deepwell', 'happen', 'mean', 'say', 'bar', 'section', 'area', 'menu', 'option', 'right', 'kind', 'stuff', 'find', 'look', 'system', 'software', 'website', 'site']);
/** Fillers that colour a question without changing what it is about ("last month", "one", "again"): light, but not zero. */
const MODIFIER = new Set(['last', 'month', 'week', 'year', 'day', 'today', 'yesterday', 'old', 'past', 'previous', 'one', 'everyth', 'every', 'whole', 'some', 'more', 'another', 'other', 'different', 'same', 'still', 'again', 'already', 'just', 'only', 'even', 'really', 'actually', 'top', 'bottom', 'corner', 'first', 'next', 'usual', 'normal', 'anyth', 'someth', 'someone', 'anyone', 'everyone', 'thing', 'stuff', 'guy', 'lady', 'people', 'computer', 'laptop', 'browser', 'pc', 'differenc', 'between', 'versus', 'vs', 'compar', 'exact', 'actual']);
/** How much a word says. Generic words weigh almost nothing, fillers little; otherwise rarer in the KB = heavier. */
const weight = (t, allGeneric = false) => (allGeneric ? Math.max(0.2, idf(t)) : GENERIC.has(t) ? 0.06 : MODIFIER.has(t) ? 0.14 : Math.max(0.2, idf(t)));
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
  // R30: how much of what was said (weighted by specificity) does the entry's OWN question + keywords explain, and how much
  // specific evidence (non-generic matched words) is there at all?
  let totW = 0, expW = 0, specW = 0;
  // "how does it work?" says nothing but generic words: then they ARE the question, so judge them by rarity like any other word
  const allGeneric = ![...msg.content].some((t) => !GENERIC.has(t) && !MODIFIER.has(t));
  for (const t of msg.content) {
    const w = weight(t, allGeneric);
    totW += w;
    if (it.qk.has(t) || /^\d+$/.test(t)) expW += w;
    else if (it.vocab.has(t)) expW += w * 0.5;
    if (matchedTokens.has(t)) specW += w;
  }
  const explainedW = totW ? expW / totW : 0;
  // the message asks for an action the entry never talks about
  let verbClash = false;
  if (msg.primary.size) { verbClash = true; for (const v of msg.primary) if (it.verbs.has(v)) { verbClash = false; break; } }
  return { score, coverage, explainedW, specific: specW, verbClash, matched: matchedTokens, weightOf: (t) => weight(t, allGeneric) };
}

function rank(msg, items, exclude) {
  const scored = items
    .filter((it) => !exclude || !exclude.has(it.e.id))
    .map((it) => { const r = scoreEntry(it, msg); return { entry: it.e, score: r.score, coverage: r.coverage, explainedW: r.explainedW, specific: r.specific, verbClash: r.verbClash, matched: r.matched, weightOf: r.weightOf, exact: msg.joined === it.qJoined }; })
    // a candidate that matched nothing but generic words ("deepwell", "how", "app") is not evidence of anything
    .filter((x) => x.score > 0.4 && (x.exact || x.specific >= GATES.minAnySpecific))
    .sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 3);
  const best = top[0];
  if (!best) return { top, best: null, confident: false, didYouMean: null };
  // Entries that ask the very same question (public + app copies of one topic) are one candidate, not a tie.
  const rivals = scored.filter((x) => x !== best && x.entry.q !== best.entry.q);
  const second = rivals[0];
  const oov = [...msg.content].filter((t) => !VOCAB.has(t) && !/^\d+$/.test(t));
  const mostlyUnknown = oov.length >= 2 && oov.length / msg.content.size >= 0.25;
  // A winner that towers over everything else needs less of its own vocabulary to be believed.
  // The less clearly it wins, the more of the visitor's own words the entry must explain. A verb the entry never mentions
  // ("log out" vs an entry about signing in) is only forgiven when the winner is dominant AND explains nearly everything.
  const gap = second ? best.score - second.score : Infinity;
  const ratio = second ? best.score / second.score : Infinity;
  // ... and the mirror image: a slightly better score that also explains clearly MORE of the question is a real win.
  const advantage = second ? best.explainedW - second.explainedW : 1;
  const tier = gap >= GATES.overwhelmAbs && ratio >= GATES.overwhelmRel ? 'overwhelming'
    : gap >= GATES.dominantAbs && ratio >= GATES.dominantRel ? 'dominant'
    : gap >= GATES.clearAbs && ratio >= GATES.clearRel ? 'clear'
    : (gap >= GATES.marginAbs && ratio >= GATES.marginRel) || (advantage >= GATES.advantageExpl && gap >= GATES.advantageAbs && ratio >= GATES.advantageRel) ? 'narrow'
    : 'tie';
  // the runner-up explains clearly more of what was said than the winner does: the winner is probably matching on a shared word
  // (or the runner-up explains a DIFFERENT part of the question: "is there a trial for the shop plan" matches the Shop plan AND the trial)
  const extraSpec = second ? [...second.matched].filter((t) => !best.matched.has(t)).reduce((a, t) => a + second.weightOf(t), 0) : 0;
  const contested = Boolean(second) && second.specific >= GATES.minSpecific && (second.explainedW - best.explainedW > GATES.contestedExpl || (extraSpec >= GATES.complementSpec && second.explainedW >= GATES.complementExpl && second.score >= best.score * GATES.complementRatio));
  // a short question with a word the whole KB has never seen ("nonprofit", "rename") is about something we do not cover
  const strangeShort = msg.content.size <= GATES.strangeShortLen && oov.length >= 1;
  const needExpl = { overwhelming: GATES.explOverwhelm, dominant: GATES.explDominant, clear: GATES.explClear, narrow: GATES.minExplained, tie: Infinity }[tier];
  const needSpec = tier === 'dominant' || tier === 'overwhelming' ? GATES.specDominant : GATES.minSpecific;
  const grounded = best.explainedW >= (best.verbClash ? GATES.verbForgivenExpl : needExpl) && best.specific >= needSpec && !(best.verbClash && tier !== 'dominant' && tier !== 'overwhelming');
  const why = [];
  if (mostlyUnknown) why.push('unknown-words');
  if (strangeShort) why.push('strange-short');
  if (contested) why.push('contested');
  if (best.coverage < GATES.minCoverage) why.push('coverage');
  if (best.score < STRONG) why.push('score');
  if (tier === 'tie') why.push('margin');
  if (best.verbClash) why.push('verb');
  if (!grounded && tier !== 'tie') why.push('grounding');
  const confident = best.exact || why.length === 0;
  // Not sure, but two different entries both look plausible: offer them instead of guessing (never when unknown words dominate).
  let didYouMean = null;
  if (!confident && !mostlyUnknown && second) {
    const plausible = (x) => x.score >= GATES.dymScore && x.explainedW >= GATES.dymExplained && x.specific >= GATES.minSpecific * 0.8 && x.coverage >= GATES.minCoverage && !x.verbClash;
    if (plausible(best) && plausible(second) && second.score >= best.score * GATES.dymRatio) didYouMean = [best, second];
  }
  return { top, best, confident, didYouMean, scored, why, tier };
}

// Entry audiences: 'public' = everyone, 'app' = signed in only, 'public-only' = a signed-out summary of an app entry
// (signed-in users get the fuller app entry instead, so these are hidden from them).
const PUBLIC_INDEX = index.filter((it) => it.e.audience === 'public' || it.e.audience === 'public-only');
const APP_INDEX = index.filter((it) => it.e.audience !== 'public-only');
/** Article ids that have at least one entry a signed-out visitor may receive (the only ones the public model may cite). */
export const PUBLIC_ARTICLES = new Set(ENTRIES.filter((e) => e.audience !== 'app').map((e) => e.article));

/**
 * AUDIENCE ENFORCEMENT. `allowApp` is true only for a signed-in app/mobile caller. A public visitor is matched
 * against `audience: public` entries only; if the question is confidently about an app-only topic they get
 * `appOnly` (the entry, NEVER its answer text) so the engine can point them to the app / the team instead.
 * @param {string} text
 * @param {{allowApp?: boolean, exclude?: Set<string>}} [opts]
 * @returns {{hit: null | {entry: object, article: object, score: number}, top: Array<{entry: object, score: number}>, confident: boolean, appOnly: null | object, didYouMean: null | Array<{entry: object, score: number}>}}
 */
export function matchFaq(text, opts = {}) {
  const msg = tokenize(text);
  if (msg.content.size === 0) return { hit: null, top: [], confident: false, appOnly: null, didYouMean: null };
  const allowApp = opts.allowApp === true;
  const exclude = opts.exclude instanceof Set ? opts.exclude : null; // test hook: "what would it answer if that entry did not exist?"
  const first = rank(msg, allowApp ? APP_INDEX : PUBLIC_INDEX, exclude);
  const dym = first.didYouMean ? first.didYouMean.map((x) => ({ entry: x.entry, score: x.score })) : null;
  if (allowApp || first.confident) {
    return {
      hit: first.confident ? { entry: first.best.entry, article: ARTICLE_BY_ID.get(first.best.entry.article), score: first.best.score, explained: first.best.explainedW, tier: first.tier, exact: first.best.exact } : null,
      top: first.top,
      confident: first.confident,
      appOnly: null,
      didYouMean: first.confident ? null : dym,
    };
  }
  // public visitor, no confident public answer: is this an app-only topic?
  const all = rank(msg, APP_INDEX, exclude);
  const appOnly = all.confident && all.best.entry.audience === 'app' ? all.best.entry : null;
  return { hit: null, top: first.top, confident: false, appOnly, didYouMean: appOnly ? null : dym };
}

/** Test/analysis hook: every scored candidate with its features (signed-in index unless allowApp is false). */
export function debugRank(text, { allowApp = true, exclude = null } = {}) {
  const msg = tokenize(text);
  const r = rank(msg, allowApp ? APP_INDEX : PUBLIC_INDEX, exclude);
  return { content: [...msg.content], ...r };
}

/** Up to 3 short follow-up chips from the same article as `entry` (never the entry itself). */
export function suggestionsFor(entry, { allowApp = true } = {}) {
  const out = [];
  for (const e of ENTRIES) {
    if ((allowApp ? e.audience !== 'public-only' : e.audience !== 'app') && e.article === entry.article && e.id !== entry.id && e.q.length <= 60) out.push(e.q);
    if (out.length === 3) break;
  }
  return out;
}

export function articleById(id) { return ARTICLE_BY_ID.get(id) ?? null; }
export function entryById(id) { return ENTRIES.find((e) => e.id === id) ?? null; }
export function contactEntry() { return ENTRIES.find((e) => e.article === 'contacting-humans') ?? null; }
