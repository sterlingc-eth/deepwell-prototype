/**
 * Follow-up merge for the Donovan query engine (DQL): "and Chandler?", "what about 2024", "same for Kevin Pratt",
 * "only the repair ones", "just in Mesa", "by brand", "list them", "make it top 3".
 *
 * The standalone question a follow-up becomes must be one the DQL parser can fully explain, so this file works the way the parser
 * does: the PRIOR question is read into slots (person, city, brand, period, window, threshold, document, id ...), the follow-up is
 * read into slots the same way, and the follow-up must be explained ENTIRELY by those slots plus filler words.
 *
 *   - A slot of the same kind in the prior is REPLACED (a new customer never inherits the old one: the old name is cut out of the text).
 *   - A slot of a kind the prior lacks is ADDED, but only when the follow-up says it narrows ("only", "just", "of those", "in X").
 *   - A plain operator change ("list them", "how many", "by brand", "top 3", "and the median") swaps one operator word or phrase.
 *   - Anything uncertain (two candidates in the prior, an unexplained word, a name that cannot be located, a negation) returns null:
 *     the caller then leaves the follow-up exactly as typed, which the engine releases.
 *
 * Pure. No database, no model, no network. Called from followup/resolve.js after slots.js has had its turn.
 */
import { findSpans, slotRewrite } from './slots.js';
import { lexWords } from '../dql/vocab.js';
import { FILLER as DQL_FILLER } from '../dql/lex.js';
import { editDistance as lexDistance } from '../dql/text.js';
import { parseDql } from '../dql/parse.js';
import { KNOWN_AZ_CITY_NAMES } from '../analytics.js';

const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec';
const YEAR = '(?:19|20)\\d{2}';
const UNIT = 'days?|weeks?|months?|years?|yrs?';
const DIRS = 'next|last|past|previous|coming|following';
const PREPS = 'in|during|for|of|from|within|throughout|over|since|before|after|until|through|by|between|to';
const OWN_PREPS = 'since|before|after|until|through|by';

const LEAD_RE = /^\s*(?:(?:hey|ok|okay|so|um|well|please|pls|and|also|then|but|now|actually|i mean|oh|what about|how about|what of|same thing for|same for|same|make it|try|let'?s try|switch to|change it to|instead|just)\b[\s,]*)+/i;
const NARROW_RE = /\b(?:only|just|of those|of them|of these|which of those|which of them|how many of those|how many of them|the ones|those|exclusively)\b/i;

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const strip = (t) => String(t ?? '').trim().replace(/[?.!\s]+$/, '');
const clean = (q) => String(q).replace(/\s+/g, ' ').replace(/\s+([?.!,])/g, '$1').trim();
const overlaps = (a, b) => a.start < b.end && b.start < a.end;
const cap = (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/* ----------------------------------------------------------------------------------------------- extra slot kinds */

const SVC = [
  [/\b(?:repairs?|repaired)\b/gi, 'repair'],
  [/\b(?:pms?|preventive maintenance|preventative maintenance|tune-?ups?)\b/gi, 'pm'],
];
const BARE_NUM = /^\s*(?:(?:the|a|an)\s+)?(?:(next|last|past|previous|coming)\s+)?(\d+(?:\.\d+)?)\s*(days?|weeks?|months?|years?|yrs?)?\s*(?:only|instead|then)?\s*$/i;

const UNIT_WORDS = ['day', 'days', 'week', 'weeks', 'month', 'months', 'year', 'years'];
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
/** A misspelled unit word ("motnhs") right after a window's number; null when the next word is not clearly a unit. */
function typoUnit(text, from) {
  const m = /^\s+([A-Za-z]{4,8})\b/.exec(text.slice(from));
  if (!m) return null;
  const w = m[1].toLowerCase();
  const hit = UNIT_WORDS.filter((u) => u.length >= 4 && editDistance(w, u) <= 1 + (u.length >= 6 ? 1 : 0)).sort((x, y) => editDistance(w, x) - editDistance(w, y))[0];
  return hit ? { unit: hit, len: m[0].length } : null;
}

/** Extra spans claimed before the generic finder: ids, serials, apartments, windows, since-months, quantities, service types. */
function extraSpans(text, fragment = false) {
  const spans = [];
  const claim = (s) => { if (!spans.some((x) => overlaps(x, s))) spans.push(s); };
  const all = (re, f) => { re.lastIndex = 0; for (let m; (m = re.exec(text));) { if (m[0] === '') { re.lastIndex++; continue; } f(m); } };
  all(/\b[A-Za-z]{1,5}-\d{3,}(?:-\d+)*\b|#\d{3,}\b/g, (m) => claim({ kind: 'id', start: m.index, end: m.index + m[0].length, raw: m[0] }));
  all(/\b(?:apt|apartment|suite|ste)\.?\s*#?\d+[a-z]?\b/gi, (m) => claim({ kind: 'id', start: m.index, end: m.index + m[0].length, raw: m[0], apt: true }));
  all(/\b\d?[A-Za-z]{1,2}\d{5,7}\b/g, (m) => { if (/[A-Za-z]/.test(m[0])) claim({ kind: 'serial', start: m.index, end: m.index + m[0].length, raw: m[0] }); });
  // since/before/after/until/through <month [year]>: a period that carries its own preposition
  all(new RegExp(`\\b(${OWN_PREPS})\\s+(${MONTHS})\\.?(?:\\s+(${YEAR}))?\\b`, 'gi'), (m) => claim({ kind: 'period', start: m.index, end: m.index + m[0].length, raw: m[0], period: { gran: 'month', word: m[2], year: m[3] || null, raw: m[0], prep: m[1].toLowerCase() } }));
  // a window: "last 30 days", "next 90 days", "past 6 months", "last 90" (unit inherited from the prior), "year to date"
  all(new RegExp(`\\b(?:the\\s+)?(${DIRS})\\s+(\\d+)(?:\\s+(${UNIT}))?\\b`, 'gi'), (m) => {
    let end = m.index + m[0].length; let unit = (m[3] || '').toLowerCase() || null;
    if (!unit) {
      const rest = text.slice(end).replace(/[?.!,\s]+/g, '');
      if (rest) { const tu = typoUnit(text, end); if (!tu) return; unit = tu.unit; end += tu.len; }
    }
    claim({ kind: 'period', start: m.index, end, raw: text.slice(m.index, end), period: { gran: 'win', dir: m[1].toLowerCase(), n: m[2], unit, raw: text.slice(m.index, end) } });
  });
  // a quantity with a comparator: "older than 15 years", "over 3 tons", "at least 2 units"
  all(new RegExp(`\\b(older than|younger than|newer than|more than|less than|fewer than|at least|at most|no more than|over|under|above|below|within)\\s+(\\d+(?:\\.\\d+)?)\\s*(${UNIT}|tons?|units?)\\b`, 'gi'), (m) => claim({ kind: 'qty', start: m.index, end: m.index + m[0].length, raw: m[0], comp: m[1].toLowerCase(), n: m[2], unit: m[3].toLowerCase() }));
  all(/\br-?\d{2,3}[A-Za-z]?\b/gi, (m) => claim({ kind: 'refrig', start: m.index, end: m.index + m[0].length, raw: m[0], key: m[0].toUpperCase().replace(/^R-?/, 'R-') }));
  if (fragment) all(/\b\d{3}[A-Za-z]\b/g, (m) => claim({ kind: 'refrig', start: m.index, end: m.index + m[0].length, raw: m[0], key: `R-${m[0].toUpperCase()}` }));
  for (const [re, key] of SVC) all(re, (m) => claim({ kind: 'svc', start: m.index, end: m.index + m[0].length, raw: m[0], key }));
  return spans;
}

/** All slot spans of a question, in reading order: the extra kinds first, then slots.js's finder over the rest. */
function spansOf(text, { fragment = false } = {}) {
  const extra = extraSpans(text, fragment);
  let masked = text;
  for (const s of extra) masked = masked.slice(0, s.start) + ' '.repeat(s.end - s.start) + masked.slice(s.end);
  const base = findSpans(masked, { fragment }).filter((s) => !extra.some((x) => overlaps(x, s)));
  const out = [...extra, ...base].sort((a, b) => a.start - b.start);
  // a person name runs on through the rest of a business name ("Sunrise Valley Elementary School")
  for (const s of out) {
    if (s.kind !== 'person') continue;
    for (;;) {
      const m = /^\s+([A-Z][A-Za-z'’&-]*)/.exec(text.slice(s.end));
      if (!m || out.some((x) => x !== s && x.start >= s.end && x.start < s.end + m[0].length)) break;
      if (/^(?:In|At|And|For|Of|How|What|Who|When|Where|Which|The|To|On|By)$/.test(m[1])) break;
      s.end += m[0].length; s.raw = text.slice(s.start, s.end);
    }
  }
  return out;
}

/* ----------------------------------------------------------------------------------------------- the DQL gate */

const GENERIC_CATEGORIES = { serviceType: ['Repair', 'Preventive Maintenance', 'Install', 'Startup', 'Inspection'] };
let GENERIC_CITIES = null;
/**
 * Would the DQL parser fully explain `question`? Asked with a stand-in vocabulary: the closed word lists, the Arizona cities, the usual
 * service types, and any capitalised name the question itself carries (a name's role is irrelevant to whether the words are explained).
 * No organization data is read here: an unknown city or value simply fails the gate and the merge is released.
 */
function dqlExplains(question, names = []) {
  try {
    GENERIC_CITIES ??= KNOWN_AZ_CITY_NAMES.map((c) => c.replace(/\b[a-z]/g, (x) => x.toUpperCase()));
    const tv = { customers: { phrases: names }, technicians: { phrases: [] }, cities: GENERIC_CITIES, brands: [], models: [], docTypePhrases: [], dql: { categorical: GENERIC_CATEGORIES, docTypes: [] }, industryWords: [] };
    return Boolean(parseDql(question, { tenantVocab: tv, today: '2026-10-07' }));
  } catch { return false; }
}

/* ----------------------------------------------------------------------------------------------- is the prior fully understood? */

const EXTRA_KNOWN = new Set(('list show display give pull find tell who which what where when whose whom how many much ago its do does did we have has had had are is were was been being tenant tenants resident residents ' +
  'client clients site sites job jobs call calls order orders request requests ticket tickets permit permits invoice invoices estimate estimates quote quotes proposal proposals agreement agreements ' +
  'unit units system systems equipment customer customers visit visits doc docs document documents install installs service services pm repair repairs ones one all our the ' +
  'by per vs at top bottom best worst each every across than most least fewest no not missing lacking email emails phone phones address addresses name names date dates warranty warranties registration registered startup sheet sheets multiple more less than over under').split(' '));

/** A word the parser, the filler lists, the cities, the brands or the months already explain (so it cannot be half of a person's name). */
function isKnownWord(w) {
  const x = w.toLowerCase();
  const lex = lexWords();
  const forms = [x, x.replace(/s$/, ''), x.replace(/es$/, '')];
  if (forms.some((f) => DQL_FILLER.has(f) || lex.has(f) || EXTRA_KNOWN.has(f) || FILLER.has(f))) return true;
  if (new RegExp(`^(?:${MONTHS})$`, 'i').test(x)) return true;
  if (KNOWN_AZ_CITY_NAMES.some((c) => c.toLowerCase() === x)) return true;
  if (findSpans(` ${x} `, { fragment: true }).some((s) => s.kind === 'brand' || s.kind === 'doc' || s.kind === 'city')) return true;
  if (x.length >= 5) { for (const k of lex) { if (k.length >= 4 && Math.abs(k.length - x.length) <= 1 && lexDistance(x, k, 1) <= 1) return true; } }
  return false;
}

/** True when every word of `text` outside the slot spans is one the DQL parser itself explains (a word it does not know is a condition nobody can carry). */
function coveredPrior(text, spans) {
  const lex = lexWords();
  for (const w of leftover(text, spans)) {
    if (/^\$?\d/.test(w)) continue;
    const base = w.replace(/'s$/, '');
    const forms = [base, base.replace(/s$/, ''), base.replace(/es$/, '')];
    if (forms.some((f) => DQL_FILLER.has(f) || lex.has(f) || EXTRA_KNOWN.has(f))) continue;
    if (base.length >= 5) {
      const max = base.length >= 8 ? 2 : 1;
      let near = false;
      for (const k of lex) { if (k.length >= 4 && Math.abs(k.length - base.length) <= max && lexDistance(base, k, max) <= max) { near = true; break; } }
      if (near) continue;
    }
    return false;
  }
  return true;
}

/* ----------------------------------------------------------------------------------------------- the follow-up's own reading */

const FILLER = new Set(('and also then now just only what whats what\'s about how same for in of on at the a an to from during is are was were do does did we you i ' +
  'have has there that this those these them it they one ones as well too again please me us our tell give show which with by instead since before after until through ' +
  'all hey ok okay so that\'s thats make try').split(' '));

function stripLead(f) { return strip(f).replace(LEAD_RE, '').trim(); }

/** The words of `text` outside every span, with measure words and punctuation removed. */
function leftover(text, spans) {
  let t = text;
  for (const s of spans) t = t.slice(0, s.start) + ' '.repeat(s.end - s.start) + t.slice(s.end);
  return t.toLowerCase().replace(/[?.!,;:()"]/g, ' ').split(/\s+/).filter(Boolean);
}

/* ----------------------------------------------------------------------------------------------- period rendering */

function renderWindow(w, prior, the = false) {
  const dir = w.dir ?? prior?.dir;
  const unit = w.unit ?? prior?.unit;
  if (!dir || !unit) return null;
  return `${the ? 'the ' : ''}${dir} ${w.n} ${unit}`;
}

function renderPeriod(p, yearHint) {
  const y = p.year || yearHint || null;
  if (p.gran === 'year') return p.year;
  if (p.gran === 'rel') return p.raw.toLowerCase();
  if (p.gran === 'month') return `${p.word}${y ? ' ' + y : ''}`;
  if (p.gran === 'quarter') return `Q${p.n}${y ? ' ' + y : ''}`;
  return null;
}

const PREP_BEFORE = new RegExp(`(?:^|\\s)(${PREPS})\\s+(?:the\\s+)?$`, 'i');

/** Replaces `target` (a period span of the prior) with the follow-up's period; null when it cannot be done exactly. */
function swapPeriod(P, target, fs, F) {
  const tp = target.period; const fp = fs.period;
  const fPrepM = F.slice(0, fs.start).match(PREP_BEFORE);
  let fPrep = fp.prep || (fPrepM && new RegExp(`^(?:${OWN_PREPS})$`, 'i').test(fPrepM[1]) ? fPrepM[1].toLowerCase() : null);
  let text;
  if (fp.gran === 'win') {
    if (tp.gran !== 'win' && !(fp.dir && fp.unit)) return null;
    text = renderWindow(fp, tp.gran === 'win' ? tp : null, /^the\s/i.test(target.raw));
    if (!text) return null;
  } else if (fp.gran === 'rel' && tp.gran === 'rel') {
    return null; // two readings from today: left to the engine to ask
  } else if (fp.gran === 'rel') {
    const sh = relShift(fp.raw);
    if (sh) {
      const r = shiftPeriod(tp, sh);
      if (!r) return null;
      text = renderPeriod(r);
    } else text = fp.raw.toLowerCase().replace(/^the\s+/, '');
  } else if (fp.gran === 'year' && ['quarter', 'half', 'month'].includes(tp.gran)) {
    text = renderPeriod({ ...tp, year: fp.year });
  } else if (fp.gran === 'month' && !fp.year) {
    if (tp.gran === 'win') return null;
    text = renderPeriod(fp, tp.year || null);
  } else text = renderPeriod(fp, tp.year || null);
  if (!text) return null;
  if (fp.gran === 'half') return null;
  let start = target.start;
  const pre = P.slice(0, start).match(PREP_BEFORE);
  if (fPrep) {
    // the follow-up brings its own preposition ("since 2015"): it replaces the prior's
    if (pre) start -= pre[0].replace(/^\s/, '').length;
    return clean(P.slice(0, start) + `${fPrep} ${text}` + P.slice(target.end));
  }
  if (tp.prep) { // the prior's span carried its own preposition ("since June"): keep it
    return clean(P.slice(0, target.start) + `${tp.prep} ${text}` + P.slice(target.end));
  }
  if (/^(?:this|current|year to date|ytd|so far)/i.test(text) && pre) return clean(P.slice(0, start) + text + P.slice(target.end));
  return clean(P.slice(0, start) + P.slice(start, target.start) + text + P.slice(target.end));
}

function relShift(raw) {
  const t = raw.toLowerCase();
  const unit = (t.match(/year|quarter|month/) || [])[0];
  if (!unit) return null;
  if (/\b(previous|prior|last|before)\b/.test(t)) return { unit, d: -1 };
  if (/\b(next|following|after)\b/.test(t)) return { unit, d: 1 };
  return null;
}
function shiftPeriod(prior, sh) {
  if (prior.gran === 'year' && sh.unit === 'year' && prior.year) return { gran: 'year', year: String(Number(prior.year) + sh.d) };
  return null;
}

/* ----------------------------------------------------------------------------------------------- adding a slot the prior lacks */

const HEAD_NOUN = /\b(?:units?|systems?|equipment|machines?|customers?|clients?|tickets?|invoices?|estimates?|quotes?|proposals?|visits?|permits?|agreements?|contracts?|orders?|documents?|docs?|installs?|startup sheets?|inspections?)\b/i;

/** Appends a new slot value the prior did not have; null when the right wording is not certain. */
function addSlot(P, fs, F, { narrow, own }) {
  const k = fs.kind;
  const withQ = (t) => clean(t);
  if (k === 'city') {
    const prep = /(?:^|\s)(in|at|near|around)\s+$/i.test(F.slice(0, fs.start));
    if (!narrow && !prep) return null;
    // a grouped question ('installs per year') takes the place as 'for Mesa': the engine's grouped-count lane reads that wording whole
    return withQ(`${P} ${/\b(?:per|by)\s+(?:year|month|quarter|technician|tech|brand|customer|vendor|type)\b/i.test(P) ? 'for' : 'in'} ${fs.raw}`);
  }
  // Only a place is ever added to a question that lacked one. Adding a period, a brand, a service type, a threshold or a name was
  // measured against sealed dialogues: the lanes that read those questions drop a condition they do not know, so they stay with the model.
  return null;
}

/* ----------------------------------------------------------------------------------------------- slot merge */

function slotMerge(P, F0) {
  const hadLead = LEAD_RE.test(F0);
  let F = stripLead(F0);
  if (!F) return null;
  // "how many are Rheem", "which of those are in Mesa": a restated question word that only introduces the narrowing
  let wantCount = false; let restated = false;
  {
    const rm = /^(how many|which|what|who)\s+(?:of\s+(?:those|them|these|the ones)\s+)?(?:(?:are|is|were|was|have|has|had|did|do|does)\s+)?(?=\S)/i.exec(F);
    if (rm) { F = F.slice(rm[0].length).trim(); restated = true; wantCount = /^how many/i.test(rm[1]); }
  }
  if (!F) return null;
  if (F.split(/\s+/).length > 12) return null;
  const NEG = /\b(?:not|never|without|except|excluding|exclude|other than|besides|apart from|but not|no|isn'?t|aren'?t|don'?t|doesn'?t)\b|n't\b/i;
  if (NEG.test(F0)) return null;
  const narrow = restated || NARROW_RE.test(F0) || /\bones?\b/i.test(F);
  const pSpans = spansOf(P);
  const fSpans = spansOf(F, { fragment: true });

  // a bare number: "now 20", "last 90", "make it 3 months"
  const bn = BARE_NUM.exec(F);
  if (bn && !fSpans.some((s) => s.kind !== 'qty')) {
    const [, dir, n, unit] = bn;
    const wins = pSpans.filter((s) => s.kind === 'period' && s.period.gran === 'win');
    const qtys = pSpans.filter((s) => s.kind === 'qty');
    if (wins.length === 1 && qtys.length === 0) {
      const t = wins[0];
      const w = { gran: 'win', dir: dir ? dir.toLowerCase() : null, n, unit: unit ? unit.toLowerCase() : null };
      const text = renderWindow(w, t.period, /^the\s/i.test(t.raw));
      if (!text) return null;
      return clean(P.slice(0, t.start) + text + P.slice(t.end));
    }
    if (qtys.length === 1 && wins.length === 0 && !dir) {
      const t = qtys[0];
      const u = unit ? unit.toLowerCase() : t.unit;
      if (unit && u.replace(/s$/, '') !== t.unit.replace(/s$/, '')) return null;
      return clean(P.slice(0, t.start) + `${t.comp} ${n} ${t.unit}` + P.slice(t.end));
    }
    return null;
  }

  // a quantity or window written out in full by the follow-up
  const left = leftover(F, fSpans).filter((w) => !FILLER.has(w));
  if (left.length) return null;
  if (!fSpans.length) return null;
  if (fSpans.length > 2) return null;
  const kinds = fSpans.map((s) => s.kind);
  if (new Set(kinds).size !== kinds.length) return null;
  // apply right-to-left so earlier offsets stay valid
  // a specific document word replaces the generic one ("how many docs are older than 10 years" -> "what about proposals ...")
  let P1 = P; let fSpans1 = fSpans; let pSpans1 = pSpans;
  {
    const fd = fSpans.find((x) => x.kind === 'doc');
    if (fd && !pSpans.some((x) => x.kind === 'doc')) {
      const g = /\b(documents?|docs?|paperwork)\b/i.exec(P);
      if (g) {
        const word = /s$/i.test(g[0]) || /paperwork/i.test(g[0]) ? (/s$/i.test(fd.raw) ? fd.raw : `${fd.raw}s`) : fd.raw.replace(/s$/i, '');
        P1 = clean(P.slice(0, g.index) + word + P.slice(g.index + g[0].length));
        fSpans1 = fSpans.filter((x) => x !== fd); pSpans1 = spansOf(P1);
      }
    }
  }
  if (fSpans1 !== fSpans && !fSpans1.length) return P1;
  const plan = [];
  for (const fs of fSpans1) {
    const same = pSpans1.filter((s) => s.kind === fs.kind && (fs.kind !== 'id' || !!s.apt === !!fs.apt));
    if (same.length > 1) return null;
    plan.push({ fs, target: same[0] ?? null });
  }
  // a person in the follow-up may only replace a person the prior holds as ONE located span; never inherit the old name
  const priorPeople = pSpans1.filter((s) => s.kind === 'person');
  if (fSpans1.some((s) => s.kind === 'person') && priorPeople.length > 1) return null;
  const gated = plan.some((x) => !x.target) || P1 !== P || wantCount;
  if (gated && !coveredPrior(P1, pSpans1)) return null;
  let cur = P1;
  // texts are rebuilt one slot at a time on the evolving string, right to left so earlier offsets stay valid
  for (const { fs, target } of plan.sort((a, b) => (b.target?.start ?? -1) - (a.target?.start ?? -1))) {
    const spansNow = spansOf(cur);
    const t = target ? spansNow.find((s) => s.kind === fs.kind && (fs.kind !== 'id' || !!s.apt === !!fs.apt) && s.raw === target.raw) ?? null : null;
    if (target && !t) return null;
    if (t) {
      const r = replaceOne(cur, t, fs, F);
      if (!r) return null;
      cur = r;
    } else {
      if (!narrow && !(fs.kind === 'city' || fs.kind === 'period')) return null;
      const r = addSlot(cur, fs, F, { narrow, own: hadLead || narrow });
      if (!r) return null;
      cur = r;
    }
  }
  let out = cur;
  if (wantCount) { out = asCount(out); if (!out) return null; }
  if (out === P) return null;
  if (gated && !dqlExplains(`${out}?`, spansOf(out).filter((x) => x.kind === 'person').map((x) => x.raw))) return null;
  return out;
}

/** The count form of a list or noun-phrase question; null when the question is some other measure ("total ...", "average ..."). */
function asCount(q) {
  const t = strip(q);
  if (COUNT_LEAD.test(t)) return t;
  if (/\b(?:total|sum|average|avg|mean|median|biggest|largest|smallest|highest|lowest|most|least|top|bottom)\b/i.test(t)) return null;
  if (LIST_LEAD.test(t)) {
    if (/^(?:and\s+)?who\b/i.test(t)) return null;
    const rest = t.replace(LIST_LEAD, '');
    return rest && !/^(?:one|ones|of|that|who|which)\b/i.test(rest) ? clean(`how many ${rest}`) : null;
  }
  if (HEAD_NOUN.test(t.split(/\s+/).slice(0, 3).join(' '))) return clean(`how many ${t}`);
  return null;
}

function replaceOne(P, t, fs, F) {
  const k = fs.kind;
  const cut = (v) => clean(P.slice(0, t.start) + v + P.slice(t.end));
  if (k === 'period') return swapPeriod(P, t, fs, F);
  if (k === 'person') return cut(fs.raw.replace(/['’]s$/i, ''));
  if (k === 'city') return cut(/^[a-z]/.test(fs.raw) ? cap(fs.raw) : fs.raw);
  if (k === 'brand') return cut(fs.raw);
  if (k === 'id') return cut(fs.raw);
  if (k === 'serial') return cut(fs.raw.toUpperCase());
  if (k === 'svc') return cut(fs.key === 'repair' ? 'repair' : 'PM');
  if (k === 'refrig') return cut(fs.key);
  if (k === 'doc') { let v = fs.raw; if (/s$/i.test(t.raw) && !/s$/i.test(v)) v += 's'; return cut(v); }
  if (k === 'thr') { const comp = fs.comp || t.comp || ''; return cut(`${comp ? comp + ' ' : ''}${fs.amount}`); }
  if (k === 'qty') { if (fs.unit.replace(/s$/, '') !== t.unit.replace(/s$/, '')) return null; return cut(`${fs.comp} ${fs.n} ${fs.unit}`); }
  return null;
}

/* ----------------------------------------------------------------------------------------------- operator changes */

const LIST_LEAD = /^(?:and\s+)?(?:please\s+)?(?:list|show(?:\s+me)?|give\s+me|display|pull\s+up|which|what|who)\s+(?:are\s+|is\s+|were\s+)?(?:all\s+)?(?:of\s+)?(?:the\s+|our\s+)?/i;
const COUNT_LEAD = /^(?:and\s+)?(?:what(?:'s|\s+is|\s+was)\s+the\s+)?(?:how\s+many(?:\s+total)?|number\s+of|count\s+of|total\s+number\s+of)\s+(?:of\s+)?(?:the\s+|our\s+)?/i;
const BYDIM = 'year|month|quarter|technician|tech|city|brand|manufacturer|customer|vendor|type|service type|refrigerant|tonnage|model|status';
const DIM_NORM = { manufacturer: 'brand', technician: 'technician', tech: 'technician' };
const DIM_PL = { years: 'year', months: 'month', quarters: 'quarter', technicians: 'technician', techs: 'technician', cities: 'city', brands: 'brand', manufacturers: 'brand', customers: 'customer', vendors: 'vendor', types: 'type', refrigerants: 'refrigerant', models: 'model' };

// only the groupings whose lanes were seen to keep every condition of the question
const SAFE_DIMS = new Set(['technician', 'year', 'month', 'quarter']);
const normDim = (d) => { const x = d.toLowerCase().trim(); return DIM_PL[x] ?? DIM_NORM[x] ?? x; };

function priorKind(P) {
  if (COUNT_LEAD.test(P)) return 'count';
  if (/^(?:and\s+)?(?:list|show|which|who|what\s+are|give\s+me|display|pull\s+up)\b/i.test(P)) return 'list';
  return null;
}

function opChange(P, F0) {
  const F = stripLead(F0).replace(/\bplease\b/gi, '').trim();
  const NEG = /\b(?:not|never|without|except|excluding|exclude|other than|besides|no)\b|n't\b/i;
  if (NEG.test(F0)) return null;
  if (!coveredPrior(P, spansOf(P))) return null;
  const pk = priorKind(P);
  const pByM = new RegExp(`\\s+(?:by|per)\\s+(${BYDIM})s?\\s*$`, 'i').exec(strip(P));
  const pHasBy = /\b(?:by|per|for each|each)\s+(?:year|month|quarter|technician|tech|city|brand|manufacturer|customer|vendor|type|service type|refrigerant|tonnage|model|status)s?\b/i.test(P);

  // ---- "by brand", "break that down by city", "split it by technician", "per month"
  if (false) { // grouping a prior question by a dimension: the engine's grouped lanes were seen to drop conditions, so it stays with the model
    const m = new RegExp(`^(?:(?:break|split)\\s+(?:that|it|this|them|those)\\s+(?:down\\s+)?|broken\\s+down\\s+|grouped\\s+)?(?:by|per|for each|in each|across)\\s+(?:the\\s+)?(${BYDIM}|cities|brands|technicians|years|months|quarters)(?:\\s+instead)?$`, 'i').exec(F);
    const m2 = /^(?:break|split)\s+(?:that|it|this|them|those)\s+(?:down\s+)?(?:by|per)\s+(\w+(?:\s+type)?)$/i.exec(F);
    const d = m ? m[1] : m2 ? m2[1] : null;
    if (d && new RegExp(`^(?:${BYDIM}|cities|brands|technicians|years|months|quarters)$`, 'i').test(d)) {
      const dim = normDim(d);
      if (!SAFE_DIMS.has(dim)) return null;
      if (pByM) return clean(strip(P).replace(pByM[0], '') + ` by ${dim}`);
      if (pHasBy) return null;
      // a lane that groups units or invoices by brand or city drops the other conditions of the question: only a plain prior is grouped
      if ((dim === 'brand' || dim === 'city') && (spansOf(P).some((x) => ['qty', 'thr', 'person', 'id', 'serial'].includes(x.kind)) || /\b(?:older|newer|younger|more|less|fewer|over|under|above|below|since|before|after|no|not|without|missing)\b/i.test(P))) return null;
      if (!pk && !/^(?:total|average|avg|median|revenue|biggest|how much)/i.test(strip(P)) && !/\b(?:billed|invoiced|revenue|sales|spent|total)\b/i.test(P)) return null;
      if (/\b(?:biggest|largest|smallest|highest|lowest|latest|last|oldest|newest|first|most|least|fewest|top|bottom)\b/i.test(P)) return null;
      return clean(`${strip(P)} by ${dim}`);
    }
  }
  // ---- "which brands were those", "which technicians"
  if (false) { // grouping a prior question by a dimension: the engine's grouped lanes were seen to drop conditions, so it stays with the model
    const m = new RegExp(`^(?:which|what)\\s+(${BYDIM}|cities|brands|technicians|years|months|quarters)(?:\\s+(?:were|are|was|is)\\s+(?:those|they|that|these|them))?$`, 'i').exec(F);
    if (m && pk === 'count' && !pHasBy) {
      const dim = normDim(m[1]);
      if (!SAFE_DIMS.has(dim)) return null;
      if ((dim === 'brand' || dim === 'city') && (spansOf(P).some((x) => ['qty', 'thr', 'person', 'id', 'serial'].includes(x.kind)) || /\b(?:older|newer|younger|more|less|fewer|over|under|above|below|since|before|after|no|not|without|missing)\b/i.test(P))) return null;
      return clean(`${strip(P)} by ${dim}`);
    }
  }

  // ---- "list them", "who are they", "show them", "which ones", "names"
  if (/^(?:list|show|display|give|name|pull up)\s+(?:them|those|these|all of them|all of those|them all|the list)(?:\s+(?:out|for me))?$|^(?:which|what)\s+(?:ones|are they|are those)$|^who\s+(?:are|were)\s+(?:they|those|these)$/i.test(F)) {
    if (pk === 'count') {
      const rest = strip(P).replace(COUNT_LEAD, '');
      if (!rest || /^(?:on file|do we have)\b/i.test(rest)) return null;
      return clean(`list ${rest.replace(/^(\S+(?:\s\S+)?)\s+do we have\b/i, '$1 we have').replace(/^(\S+(?:\s\S+)?)\s+(are|were|have|has|had)\b/i, '$1 that $2')}`);
    }
    return null;
  }
  // ---- "how many", "how many is that", "count them", "how many are there", "how many of those"
  if (/^(?:how\s+many(?:\s+(?:is|are|was|were)\s+(?:that|those|there|they|these|it))?(?:\s+(?:in\s+total|total|altogether))?|count\s+(?:them|those|these)(?:\s+up)?|how\s+many\s+of\s+(?:those|them|these))$/i.test(F)) {
    if (pk === 'list' && !pHasBy && !/\b(?:oldest|newest|latest|first|last|top|bottom|biggest|smallest|most|least|fewest)\b/i.test(P)) {
      const rest = strip(P).replace(LIST_LEAD, '');
      if (!rest || /^(?:one|ones|of|that|who|which)\b/i.test(rest)) return null;
      const lm = LIST_LEAD.exec(strip(P));
      if (lm && /^(?:and\s+)?who\b/i.test(lm[0])) return null;
      return clean(`how many ${rest}`);
    }
    return null;
  }

  // ---- "make it top 3", "show 10 instead", "just the top 1", "now 20" (rank/limit)
  {
    const m = /^(?:make it\s+|show\s+|give me\s+|just\s+|only\s+|now\s+)?(?:the\s+)?(top|bottom|last|latest|first|newest|oldest|most recent)?\s*(\d+)(?:\s+(?:instead|only|please))?$/i.exec(F);
    const pm = /\b(top|bottom|last|latest|first|newest|oldest|most recent)\s+(\d+)\b/i.exec(P);
    if (m && pm && !/\b(?:older|younger|newer|more|less|over|under)\s+than\s+\d+\s*$/i.test(P)) {
      const word = (m[1] ?? pm[1]);
      if (m[1] && m[1].toLowerCase() !== pm[1].toLowerCase() && !(/^(?:top|bottom)$/i.test(m[1]) && /^(?:top|bottom)$/i.test(pm[1]))) {
        // the follow-up names a different end of the ranking ("just the top 1" after "top 3") only when it is the same family
        if (!(/^(?:top|bottom)$/i.test(m[1]) === /^(?:top|bottom)$/i.test(pm[1]))) return null;
      }
      return clean(P.slice(0, pm.index) + `${word} ${m[2]}` + P.slice(pm.index + pm[0].length));
    }
    if (m && !pm) {
      // "show 10 instead" after "show me the latest 5 invoices": a bare N replaces the one N the prior holds as a row limit
      const nums = [...P.matchAll(/\b(\d+)\b/g)].filter((x) => !/^(?:19|20)\d\d$/.test(x[1]));
      const lim = /\b(?:latest|last|first|newest|oldest|recent|top|bottom)\s+(\d+)/i.exec(P);
      if (lim && nums.length === 1) return clean(P.slice(0, lim.index) + lim[0].replace(/\d+/, m[2]) + P.slice(lim.index + lim[0].length));
    }
  }

  // ---- a different measure of the same scope: "average age", "the oldest one" after a count of units
  {
    const mm = /^(?:the\s+)?(average|avg|median|mean)\s+age$/i.exec(F);
    const om = /^(?:the\s+)?(oldest|newest)(?:\s+one)?$/i.exec(F);
    if ((mm || om) && pk === 'count') {
      const rest = strip(P).replace(COUNT_LEAD, '').replace(/\s+(?:do we have(?: on file)?|are there|we have|on file|on the books|do we have on the books)$/i, '').trim();
      if (!/\bunits?\b|\bequipment\b/i.test(rest) || /\b(?:older|newer|younger)\b/i.test(rest) && om) return null;
      if (mm) return clean(`${mm[1].toLowerCase()} age of ${rest}`);
      return clean(`${om[1].toLowerCase()} ${rest.replace(/\bunits\b/i, 'unit')}`);
    }
  }
  // ---- one measure word for another: "and the median?", "and the biggest?" (same family only)
  {
    const FAMS = [['average', 'avg', 'mean', 'median'], ['biggest', 'largest', 'highest', 'greatest', 'smallest', 'lowest', 'cheapest', 'least expensive', 'most expensive']];
    const fw = F.toLowerCase().replace(/^(?:the\s+|a\s+)/, '').replace(/\s+(?:one|ones|then|instead|too)$/, '');
    for (const fam of FAMS) {
      if (!fam.includes(fw)) continue;
      const inP = [...P.matchAll(new RegExp(`\\b(${fam.slice().sort((a, b) => b.length - a.length).join('|')})\\b`, 'gi'))];
      if (inP.length !== 1) return null;
      if (inP[0][1].toLowerCase() === fw) return null;
      return clean(P.slice(0, inP[0].index) + fw + P.slice(inP[0].index + inP[0][0].length));
    }
  }
  // ---- "which year was highest/lowest" after a prior grouped by that dimension
  if (false) { // grouping a prior question by a dimension: the engine's grouped lanes were seen to drop conditions, so it stays with the model
    const m = new RegExp(`^(?:which|what)\\s+(${BYDIM}|city|brand|technician)\\s+(?:was|is|had|has|did)\\s+(?:the\\s+)?(highest|lowest|biggest|smallest|most|least|fewest|busiest|slowest|best|worst)$`, 'i').exec(F);
    if (m) {
      const dim = normDim(m[1]);
      const by = new RegExp(`\\s+(?:by|per)\\s+${dim === 'technician' ? '(?:technician|tech)' : dim}s?\\b`, 'i').exec(P);
      if (!by) return null;
      const w = m[2].toLowerCase();
      const low = /^(lowest|smallest|least|fewest|slowest|worst)$/.test(w);
      const rest = clean(P.slice(0, by.index) + P.slice(by.index + by[0].length));
      if (/^(?:how many|list|show)/i.test(rest) || /\b(?:hours?|labor|revenue|billed|invoiced|sales|dollars?|amount|spent|total|average)\b/i.test(rest)) return null;
      return `which ${dim} had the ${low ? 'fewest' : 'most'} ${strip(rest).replace(/^(?:show me|list|what(?:'s| is)?)\s+(?:the\s+)?/i, '')}?`;
    }
  }
  return null;
}

/* ----------------------------------------------------------------------------------------------- entry points */

/**
 * @param {string} prior the prior question as the engine saw it
 * @param {string} follow the new question as typed
 * @returns {{query: string, slot: string}|null}
 */
export function dqlMergeRewrite(prior, follow) {
  if (process.env.DQL_FOLLOWUP_MERGE === '0') return null; // kill switch
  const P = strip(prior); const F0 = strip(follow);
  if (!P || !F0 || F0.length > 160) return null;
  if (LEAD_RE.test(P)) return null; // the prior is itself a bare fragment with nothing of its own to carry
  try {
    const a = slotMerge(P, F0);
    if (a) return { query: `${a}?`, slot: 'dql-slot' };
    const b = opChange(P, F0);
    if (b && !dqlExplains(/\?$/.test(b) ? b : `${b}?`, spansOf(b).filter((x) => x.kind === 'person').map((x) => x.raw))) return null;
    if (b) return { query: /\?$/.test(b) ? b : `${b}?`, slot: 'dql-op' };
  } catch { /* fall through: release */ }
  return null;
}

/**
 * The previous turn's question as the engine saw it: a prior elliptical follow-up is itself expanded against the turn before it.
 */
function effectivePrior(turns, i, depth = 0) {
  const q = turns[i].question;
  if (i === 0 || depth > 3) return q;
  const base = effectivePrior(turns, i - 1, depth + 1);
  const r = slotRewrite(base, q, turns[i - 1]) || dqlMergeRewrite(base, q);
  return r ? r.query : q;
}

/** Entry point: the last turn's question (itself expanded if it was a follow-up) and the new question. */
export function dqlMergeFollowup(turns, question) {
  try {
    if (!Array.isArray(turns) || !turns.length) return null;
    const i = turns.length - 1;
    const r = dqlMergeRewrite(effectivePrior(turns, i), question);
    if (!r || !r.query || r.query.toLowerCase() === String(question).trim().toLowerCase()) return null;
    return r;
  } catch {
    return null;
  }
}

/**
 * The noun a plain inventory question counts or lists ("how many Trane units do we have" -> "units"), or null when the question carries
 * any other condition (a period, a city, a threshold, a name ...). A bare "those" can only be given back its scope when nothing else
 * was in it.
 */
export function plainScope(question) {
  const q = strip(question);
  if (!q) return null;
  const spans = spansOf(q);
  if (spans.some((x) => !['brand', 'doc'].includes(x.kind))) return null;
  const PLAIN = new Set(('how many do does we have has are is there on file the books our all total number of what whats count tell me show list in system a an piece pieces').split(' '));
  const NOUNS = { unit: 'units', units: 'units', equipment: 'units', system: 'units', systems: 'units', machine: 'units', machines: 'units', customer: 'customers', customers: 'customers', client: 'customers', clients: 'customers' };
  let noun = null;
  for (const w of leftover(q, spans)) {
    if (NOUNS[w]) { if (noun && noun !== NOUNS[w]) return null; noun = NOUNS[w]; continue; }
    if (!PLAIN.has(w)) return null;
  }
  const docs = spans.filter((x) => x.kind === 'doc');
  if (docs.length > 1 || (docs.length && noun)) return null;
  if (docs.length) noun = docs[0].raw.toLowerCase();
  return noun ? { noun } : null;
}
