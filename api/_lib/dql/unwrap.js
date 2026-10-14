/**
 * dql/unwrap.js - R23: ONE question wrapped in chatter (greetings, "context first" paragraphs, urgency, thanks, sign-offs, Spanish openers and closers).
 *
 * unwrapQuestion(q, vocab) returns the question with the chatter taken away, or null. It is used ONLY after the text as typed was released, and the
 * core goes through exactly the same parser, coverage rule and learned-planner gates as any question.
 *
 * Only provably inert text is taken away. A piece goes only when it holds no digit, no money or time word, no negation, no cue word (how many, list,
 * total, when ...), none of this company's own words (kinds of paper, names, cities, brands, stored values) and no capitalised word that might be a name
 * (proposer/core.js `inert`, the same test the proposer's extractor uses). Closers and openers are matched as WHOLE exact phrases at the very start or end.
 * Two questions in one text (a second sentence that asks anything, a bulleted list) are never unwrapped: the text stays as it was (released).
 */
import { extractCore, inert, meaningWords } from './proposer/core.js';
import { COMMON_WORDS } from '../router/lexicon.generated.js';

const HEAD = [
  'hola', 'hello', 'hi there', 'hey there', 'hey', 'hi', 'ey', 'eh', 'oiga', 'oye', 'mira', 'buenas', 'buenos dias', 'buenas tardes', 'buenas noches', 'good morning', 'good afternoon', 'good evening',
  'dear donovan', 'hi donovan', 'hey donovan', 'hola donovan', 'donovan', 'quick question but urgent', 'quick question pero urgente', 'quick question', 'quick one', 'una pregunta rapida', 'una pregunta r\u00e1pida', 'pregunta rapida', 'pregunta r\u00e1pida',
  'disculpa la molestia', 'perdona la molestia', 'perdon la molestia', 'perd\u00f3n la molestia', 'disculpe la molestia', 'sorry to bother you', 'sorry for the bother', 'sorry for the trouble', 'excuse the interruption', 'si no es molestia', 'if it is not too much trouble', 'if its not too much trouble',
  'es urgente', 'pero urgente', 'it is urgent', 'its urgent', 'urgente', 'urgent', 'no rush', 'sin prisa', 'no hay prisa', 'por fa', 'porfa', 'por favor', 'pls', 'please', 'ok so', 'okay so', 'ok', 'okay', 'oh', 'um', 'uh',
  'when you get a sec', 'when you get a second', 'when you get a chance', 'when you get a minute', 'when you have a moment', 'whenever you get a chance', 'one quick thing', 'one more thing', 'please help', 'help please', 'help me out', 'i need your help', 'i could use your help', 'need your help',
  "it's urgent", "it's urgent please", 'thanks in advance', 'gracias de antemano', 'gracias', 'thanks', 'thank you', 'back to business', 'here goes', 'here we go', 'getting to the point', 'to the point', 'anyway back to it', 'the actual question is this', 'the actual question is', 'my question is', 'here is my question', 'heres my question', 'here is what i need', 'heres what i need',
  'not for nothing but', 'long story short', 'for what it is worth', 'for what its worth', 'heads up', 'una cosita', 'una duda', 'dime una cosa', 'mira esto', 'hola amigo', 'amigo', 'okay pues', 'pues', 'alright', 'right', 'as an aside', 'quick aside', 'by the way', 'btw', 'fast one', 'ahorita necesito saber', 'necesito saber', 'necesito algo', 'cuando puedas', 'si puede', 'si es molestia', 'si no te molesta', 'hola cuando puedas', 'perdon pero', 'perdon', 'sorry', 'bueno', 'entonces', 'a ver', 'una pregunta',
  'pero', 'ya', 'dime ya', 'tell me this', 'please tell me this', 'si puedes', 'could you answer this for me', 'can you answer this for me', 'can you help me with this', 'could you help me with this', 'can you help with this', 'i have a question for you', 'i have a question', 'i got a question', 'got a question', 'question for you',
];
const TAIL = [
  'por fa', 'porfa', 'por favor', 'es urgente', 'pero urgente', 'urgente', 'urgent', 'it is urgent', 'its urgent', "it's urgent", 'mil gracias', 'muchas gracias', 'muchisimas gracias', 'gracias de antemano', 'gracias', 'de antemano',
  'thanks', 'thank you', 'thank you so much', 'thanks so much', 'many thanks', 'thanks again', 'thanks a bunch', 'thanks a million', 'thanks in advance', 'thank you in advance', 'thx', 'ty', 'much appreciated', 'appreciate it', 'i appreciate it', 'appreciate the help', 'i appreciate the help', 'appreciate your help',
  'cheers', 'with thanks', 'with gratitude', 'thanks so much again', 'thank you very much', 'thanks very much', 'saludos', 'un saludo', 'abrazos', 'best regards', 'kind regards', 'warm regards', 'regards', 'sincerely', 'yours truly', 'talk soon', 'ttyl', 'have a good one', 'have a great day', 'have a good day', 'have a nice day', 'take care', 'hope that helps', 'hope you are well', 'hope youre well',
  'let me know', 'no rush', 'sin prisa', 'no hay prisa', 'whenever you can', 'cuando puedas', 'when you get a chance', 'when you get a sec', 'when you get a second', 'when you get a minute', 'when you have a moment', 'if you have a moment', 'if you have a sec', 'if you have a second', 'if you can', 'if you could',
  'gracias eh', 'gracias amigo', 'gracias amiga', 'mil gracias eh', 'si puede', 'si es molestia', 'si no es molestia', 'si no te molesta', 'hay prisa', 'no hay apuro', 'sin apuro', 'es urgente por favor', 'eh', 'amigo', 'lo antes posible', 'ahorita', 'rapidito', 'asap', 'pronto', 'right away', 'please and thank you', 'please', 'pls', 'por favor y gracias', 'sorry again', 'sorry for the trouble', 'sorry to bother you', 'disculpa la molestia', 'perdon por la molestia',
];
const norm = (p) => p.replace(/[\u00e1\u00e0]/g, 'a').replace(/[\u00e9]/g, 'e').replace(/[\u00ed]/g, 'i').replace(/[\u00f3]/g, 'o').replace(/[\u00fa]/g, 'u');
const esc = (p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['\u2019]?").replace(/\s+/g, '\\s+');
const build = (list, tail) => {
  const body = [...new Set(list)].sort((a, b) => b.length - a.length).map(esc).join('|');
  return tail ? new RegExp(`(?:^|[\\s,.;:!\\u00a1\\u00bf?(-])(?:${body})\\s*[)!.?,;]*\\s*$`, 'i') : new RegExp(`^\\s*[\\u00a1\\u00bf(]*(?:${body})(?=[\\s,.:;!?-]|$)[\\s,.:;!?)-]*`, 'i');
};
const HEAD_RE = build(HEAD, false);
const TAIL_RE = build(TAIL, true);
/* A clause that only talks about the asking itself ("I can't not ask this", "It would be a mistake to not get this right", "I won't say I'm not curious", "Nobody can say I didn't ask nicely") holds a negation but no condition:
   every word is a pronoun, helper, negation or speech-act word, and at least one is a speech-act word; it can not name anything of the records. */
const META_FN = new Set(('a an the else who could i im ive id ill me my mine myself you your youre it its this that these those there here we us our they them he she who nobody noone one everyone anyone someone nothing not no never cant cannot cant couldnt couldn wouldnt wont would will could can should shouldnt shall must may might dont doesnt didnt isnt arent wasnt werent havent hasnt hadnt aint do does did is am are was were be been being have has had to of for on about at in out up so but and or if then than as like just even still really actually simply honestly truly quite very too only also yet ever any all more less much going gonna about not why way how what when where which whom whose').split(/\s+/));
const META_FN_BLOCK = new Set('how what when where which whom whose why'.split(' '));
const META_SPEECH = new Set(('ask asks asked asking answer answers answered answering need needs needed needing want wants wanted wanting wonder wonders wondering wondered curious interested interest know knows knew knowing tell tells told telling say says said saying deny denied denying pretend pretending pretended hear heard hearing back looked look looking find found finding trust trusted think thinking thought wait waiting waited unreasonable unhappy mistake wrong right simple impossible nice nicely polite politely lie lying lied unsure sure certain care cares cared mind minds mention mentioning mentioned bother bothered bothering expect expecting expected get getting got give giving ignore ignoring ignored unwilling willing happy glad surprised surprise clear unclear obvious hard easy difficult complicated rude fair unfair fine ok okay reasonable').split(' '));
export function metaClause(text) {
  const w = String(text ?? '').toLowerCase().replace(/[\u2019\u2018`]/g, "'").replace(/'/g, '').split(/[^a-z]+/).filter(Boolean);
  if (w.length < 3 || w.length > 14) return false;
  let speech = false; let neg = false;
  for (const x of w) {
    if (/^(?:not|no|never|nobody|noone|nothing|cant|cannot|couldnt|wouldnt|wont|dont|doesnt|didnt|isnt|arent|wasnt|werent|havent|hasnt|hadnt|aint|unreasonable|unhappy|unwilling|unsure|impossible|unfair|unclear)$/.test(x)) neg = true;
    if (META_SPEECH.has(x)) { speech = true; continue; }
    if (META_FN.has(x) && !META_FN_BLOCK.has(x)) continue;
    return false;
  }
  return speech && neg;
}
/** drop leading "<meta clause>:" prefixes and whole meta sentences */
function dropMeta(text) {
  let t = text;
  for (let i = 0; i < 4; i++) {
    const m = /^([^:.!?]{3,100}):\s+(.+)$/s.exec(t);
    if (m && metaClause(m[1])) { t = m[2]; continue; }
    break;
  }
  const parts = t.split(/(?<=[.!?])\s+(?=[A-Za-z\u00bf\u00a1"'(])/);
  if (parts.length > 1) { const keep = parts.filter((p) => !metaClause(p.replace(/[.!?]+$/, ''))); if (keep.length && keep.length < parts.length) t = keep.join(' '); }
  return t;
}

/** the phrases only count as chatter when none of their words is a word of this company (a vocabulary word could be the question) */
const phraseOk = (ph, vocab) => { const mw = meaningWords(vocab); return !ph.toLowerCase().split(/[^a-z\u00c0-\u024f]+/).some((w) => w && mw.has(norm(w)) && !PHRASE_FREE.has(norm(w))); };
const PHRASE_FREE = new Set('hi hey hello thanks thank please urgent regards best cheers sorry well right ok okay pronto gracias hola por favor'.split(' '));

/** take exact opener / closer phrases off both ends, only when each phrase is inert for this company; returns the rest */
export function stripPhrases(text, vocab, { allowEmpty = false } = {}) {
  let t = String(text ?? '').trim();
  for (let i = 0; i < 8; i++) {
    const before = t;
    const h = HEAD_RE.exec(norm(t));
    if (h && h[0].length && phraseOk(h[0].replace(/[\s,.:;!?)(-]+/g, ' '), vocab) && (h[0].length < t.length || allowEmpty)) t = t.slice(h[0].length).trim();
    const m = TAIL_RE.exec(norm(t));
    if (m && phraseOk(m[0].replace(/[\s,.:;!?)(-]+/g, ' '), vocab)) {
      const cut = t.slice(0, m.index).replace(/[\s,;:-]+$/, '').trim();
      if (cut.length >= 8 || allowEmpty) t = cut;
    }
    if (t === before) break;
  }
  return t;
}


/* ---------- context sentences: a sentence of its own that provably holds no condition */
let DICT = null;
const dict = () => (DICT ??= new Set(String(COMMON_WORDS).split(/\s+/)));
const NEGW = /^(?:not|no|never|none|nobody|nothing|neither|nor|without|cant|cannot|couldnt|wouldnt|shouldnt|wont|dont|doesnt|didnt|isnt|arent|wasnt|werent|havent|hasnt|hadnt|aint)$/;
const BLOCK_WORDS = new Set(('how many much often old far number count counts tally total totals sum average avg mean median list lists show give tell which who whom whose whether compare versus vs latest earliest newest oldest most least biggest smallest largest highest lowest top bottom first last next previous recent recently current currently ' +
  'more less fewer greater than over under above below between within through until since before after during ago today tomorrow yesterday tonight week weeks weekly month months monthly year years yearly annual annually quarter quarters daily day days hour hours minute minutes date dates january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday ' +
  'hundred thousand million billion grand dollars bucks cents percent percentage price prices cost costs paid pay owe owed owes ' +
  'want wants wanted need needs needed care cares cared interested concerned focus focused matter matters important relevant specifically particularly mainly mostly especially exactly strictly solely merely exclusively ignore skip exclude excluding include including instead rather besides except unless depends only each every per same plus ' +
  'invoice invoices estimate estimates quote quotes receipt receipts order orders report reports record records file files document documents paper papers customer customers client clients vendor vendors supplier suppliers bill bills payment payments job jobs visit visits appointment appointments permit permits contract contracts form forms sheet sheets statement statements certificate certificates agreement agreements account accounts owner owners tenant tenants patient patients member members technician technicians tech techs city cities address street amount amounts balance').split(' '));
const IDIOM_OK = new Set('out little long plan planning office note new'.split(' '));
const NEW_BLOCK = /\bnew\s+(?:one|ones|stuff|items?|entries|entry|things?|additions?|ones)\b/i;
const NUMW = /^(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen|half|couple|several|few|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|twice|thrice|double|triple)$/;
const FILLER_PHRASES = /\blast\s+night\b|\bthis\s+(?:morning|afternoon|evening)\b|\b(?:which|that)\s+(?:has|have|is|was)\s+nothing\s+to\s+do\s+with\s+(?:this|that|anything)\b|\bbetween\s+you\s+and\s+me\b|\bevery\s+time\b|\bmuch\s+appreciated\b|\bmany\s+thanks\b|\bhope\s+your\s+day\s+is\s+going\s+(?:better|well)(?:\s+than\s+mine)?\b|\bwhole\s+street\b|\bwi-?fi\b|\bkeep\s+this\s+between\s+us\b|\bif\s+you\s+need\s+to\s+reach\s+me\b|\bno\s+rush\s+on\s+(?:the|this|that)\s+[a-z]+\s+thing\b|\bmr\.?\s|\bmrs\.?\s|\bms\.?\s|\bdr\.?\s/gi;
const BENIGN_ONLY = /\b(?:i\s+am|i'?m|we\s+are|we'?re|just)\s+only\s+(?:mentioning|saying|telling|writing|bringing|sharing|venting)(?:\s+(?:it|this|that))?\b/gi;
/** a sentence on its own that names nothing, asks nothing and limits nothing: "the stapler vanished and I am blaming the intern" */
export function contextSentence(text, vocab, { intent = false, min = 3, why = null, allow = null } = {}) {
  const no = (r) => { if (why) why.r = r; return false; };
  let t = String(text ?? '').replace(/[’‘`]/g, "'").trim();
  if (!t) return true;
  const words0 = t.split(/\s+/);
  if (words0.length > 70) return no('long');
  if (/[\d$%#@&?\\/=<>+*]/.test(t) || /[\p{Extended_Pictographic}]/u.test(t)) return no('symbol');
  const t0 = t;
  t = t.replace(BENIGN_ONLY, ' ').replace(FILLER_PHRASES, ' ');
  const filled = t !== t0;
  const shouted = !/[a-z]/.test(t);
  const mw = meaningWords(vocab);
  let neg = false; let n = 0;
  const re = /[A-Za-z\u00c0-\u024f']+/g; let m; let total = 0;
  const toks = []; while ((m = re.exec(t))) toks.push({ orig: m[0].replace(/^'+|'+$/g, ''), idx: m.index });
  total = toks.length;
  for (const { orig, idx } of toks) {
    if (!orig) continue;
    const w = orig.toLowerCase().replace(/'/g, '');
    n++;
    if (!shouted && /[A-Z]/.test(orig) && !/^(?:I|I'm|I've|I'll|I'd|Donovan|DeepWell)$/.test(orig)) {
      const before = t.slice(0, idx).replace(/[\s(\u00bf\u00a1"']+$/, '');
      if (before && !/[.!?:]$/.test(before)) return no('cap:' + orig); // a capitalised word inside a sentence may be a name
      if (/^[A-Z]{2,}$/.test(orig) && orig.length > 1) return no('caps:' + orig);
    }
    if (NEGW.test(w) || /n't$/i.test(orig)) neg = true;
    if (mw.has(w) && !IDIOM_OK.has(w)) return no('vocab:' + w);
    if (w === 'new' && NEW_BLOCK.test(t)) return no('block:new ones');
    if (BLOCK_WORDS.has(w) && !(allow && allow.has(w)) && !(intent && /^(?:want|wants|need|needs|needed|wanted|care|matter|matters|important|relevant)$/.test(w))) return no('block:' + w);
    if (NUMW.test(w) && total < 6) return no('num:' + w);
    if (/^(?:i|a|im|ive|id|ill|u|ok|okay|donovan|deepwell)$/.test(w)) continue;
    const low = orig.toLowerCase();
    const base = w.replace(/(?:nt|s|m|re|ve|ll|d)$/, '');
    if (!dict().has(w) && !dict().has(base) && !dict().has(low.replace(/n't$/, '').replace(/'(?:s|m|re|ve|ll|d)$/, ''))) return no('dict:' + w);
  }
  if (n === 0) return true;
  if (n < min && !(filled && n <= 2)) return no('short');
  if (neg && n < 7 && !metaClause(t)) return no('neg');
  return true;
}
const REQ_ALLOW = new Set('after below tell give show ask'.split(' '));
const REQUEST_WORD = /\b(?:question|answer|ask|asking|asked|need|want|thing|favou?r|help|following|below|request|wondering|wonder|know|curious|figure|tell|say|this|here)\b/i;
/** "The thing I cannot figure out is:" / "Here is what I am asking:" / "I just need one thing from the system:" / "Mira esto:" */
export function requestFrame(pre, vocab) {
  const p = String(pre ?? '').trim();
  if (!p || p.split(/\s+/).length > 14) return false;
  if (metaClause(p)) return true;
  if (/\b(?:how|which|who|whom|whose|many|much)\b/i.test(p)) return false;
  return REQUEST_WORD.test(p) && contextSentence(p.replace(/\bwhat\b/gi, 'that'), vocab, { intent: true, allow: REQ_ALLOW });
}
const phraseOnly = (p, vocab) => { const r = stripPhrases(p.replace(/^["'(]+|["')]+$/g, ''), vocab, { allowEmpty: true }); return r.replace(/[\s,.:;!?)(-]+/g, '') === '' || contextSentence(p, vocab); };
const piecesOf = (text) => { const out = []; for (const l of text.replace(/\r/g, '').split('\n').map((x) => x.trim()).filter(Boolean)) for (const sp of l.split(/(?<!\b(?:Mr|Mrs|Ms|Dr|P\.S|p\.s))(?<=[.!?])\s+(?=[A-Za-z¿¡"'(])/)) { const z = sp.trim().replace(/^p\.?\s?s\.?:?\s+/i, ''); if (z && !/^p\.?\s?s\.?$/i.test(z)) out.push(z); } return out; };

/** exactly one sentence is left once every context sentence is gone; the lead-in on that sentence ("Back to business:", "Here is what I am asking:") and phrases at its ends go too */
function ownCore(text, vocab) {
  const pieces = piecesOf(text);
  if (!pieces.length) return null;
  const keep = pieces.filter((p) => !(phraseOnly(p.replace(/[.!]+$/, ''), vocab) || SIGNOFF.test(p.replace(/[.!]+$/, '')) || metaClause(p.replace(/[.!]+$/, ''))));
  if (keep.length !== 1) return null;
  let t = keep[0];
  for (let i = 0; i < 5; i++) {
    const m = /^([^:]{3,160}):\s+(.+)$/s.exec(t);
    if (m && !/\d{1,2}$/.test(m[1]) && (requestFrame(m[1], vocab) || phraseOnly(m[1], vocab))) { t = m[2]; continue; }
    const d = /^([^-–—]{3,240}?)\s[-–—]\s+(.+)$/s.exec(t);
    if (d && (contextSentence(d[1], vocab) || phraseOnly(d[1], vocab) || requestFrame(d[1], vocab))) { t = d[2]; continue; }
    const hw = /^(?:now|well|anyway|anyhow|okay|ok|alright|right|oh|yes|yeah|listen|look|honestly|basically|actually)\s*,\s+(.+)$/is.exec(t);
    if (hw) { t = hw[1]; continue; }
    const c = /^([^,]{2,100}),\s+(.+)$/s.exec(t);
    if (c && (contextSentence(c[1], vocab) || phraseOnly(c[1], vocab)) && !/\?$/.test(c[1])) { t = c[2]; continue; }
    break;
  }
  return t;
}

const SUBJECT_OK = new Set('a an the quick little small short one question questions request requests favor favour help ask need needed needs your you can could would please advise info information got minute moment second check checking something on for hoping hope when chance get hello hi hey thanks regarding my our us me i some another new'.split(' '));
const SIGNOFF = /^(?:best(?:\s+regards)?|regards|kind\s+regards|warm\s+regards|thanks(?:\s+again|\s+so\s+much|\s+a\s+lot)?|thank\s+you(?:\s+so\s+much)?|many\s+thanks|cheers|sincerely|appreciate\s+it|with\s+thanks|with\s+gratitude|talk\s+soon|saludos|gracias|un\s+saludo|abrazos|yours\s+truly|respectfully|take\s+care|much\s+appreciated|thx|ty)\s*[,.!]*$/i;
const GREET = /^(?:hi|hello|hey|hola|greetings|dear|good\s+(?:morning|afternoon|evening)|howdy|buenas|buenos\s+dias)\b([^.!?]*)$/i;
const SUBJ_BLOCK = /\b(?:only|just|except|excluding|exclude|include|including|skip|ignore|instead|rather|besides|also|plus|since|before|after|during|between|over|under|above|below|more|less|than|last|first|latest|earliest|recent|newest|oldest|most|least|top|bottom|each|every|all|any|per|by|from|within|through|until)\b/i;
/** the structure of an email around the question: a subject line, a greeting line, a signature after a sign-off. Only lines with no condition in them go. */
function stripEmailShell(text, vocab) {
  const lines = text.split('\n').map((x) => x.trim()).filter(Boolean);
  if (lines.length < 2) return text;
  const mw = meaningWords(vocab);
  const hasMeaning = (s) => s.toLowerCase().replace(/'/g, '').split(/[^a-z0-9]+/).some((w) => w && mw.has(w));
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const sm = /^subject:\s*(.*)$/i.exec(l);
    if (sm && i === 0) { const sj = sm[1]; if (sj.trim().split(/\s+/).every((x) => SUBJECT_OK.has(x.toLowerCase().replace(/[^a-z]/g, '')))) continue; }
    const gm = GREET.exec(l.replace(/[,!]+$/, ''));
    if (gm && i <= 1 && l.split(/\s+/).length <= 7 && !/[\d$%#@?]/.test(l) && !hasMeaning(gm[1])) continue;
    out.push(l);
  }
  // a name on the last line right after a sign-off line
  if (out.length >= 3 && (SIGNOFF.test(out[out.length - 2]) || phraseOnly(out[out.length - 2].replace(/[.!,]+$/, ''), vocab)) && /^[A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*)?$/.test(out[out.length - 1])) out.pop();
  else if (out.length >= 2 && /^[A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*)?$/.test(out[out.length - 1]) && (SIGNOFF.test(out[out.length - 2]) || phraseOnly(out[out.length - 2].replace(/[.!,]+$/, ''), vocab))) out.pop();
  return out.join('\n');
}

/** the one real question inside a wrapped text, or null (nothing to take away, or not provably one question) */
export function unwrapQuestion(q, vocab) {
  // R24: pictures carry no condition, and the full stop of a title ("Mr. Donovan") is not the end of a sentence
  const raw = String(q ?? '').replace(/\r/g, '').replace(/[\p{Extended_Pictographic}\u200d\ufe0f]+/gu, ' ').replace(/\b(Mr|Mrs|Ms|Dr)\.(?=\s)/g, '$1').replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
  if (raw.length < 12 || !vocab) return null;
  // a list of questions is not one question
  const lines = raw.split('\n').map((x) => x.trim()).filter(Boolean);
  if (lines.length > 1 && lines.some((l) => /^(?:[a-z]\)|\d+[.)]|q\d+[:.)]|[-*\u2022])\s/i.test(l))) return null;
  if ((raw.match(/\?/g) ?? []).length > 1) return null; // two question marks: two questions
  let t = dropMeta(stripEmailShell(raw, vocab));
  try {
    const own = ownCore(t, vocab);
    if (own) t = own;
    else { const c = extractCore(t, vocab); if (c?.core) t = c.core; }
  } catch { /* keep the text */ }
  t = stripPhrases(t, vocab);
  // a trailing "... question?, <inert>" and the like are gone; what is left has to be a real shortening of the text
  t = t.replace(/\s+/g, ' ').trim();
  t = dropMeta(t);
  if (t.length < 8 || t === raw) return null;
  return t;
}

/** debugging aid: how each sentence of a text is judged */
export function explain(q, vocab) {
  const t = stripEmailShell(String(q ?? '').replace(/\r/g, '').trim(), vocab);
  return piecesOf(t).map((p) => { const w = {}; const ctx = contextSentence(p, vocab, { why: w }); return `${ctx ? 'CTX' : phraseOnly(p.replace(/[.!]+$/, ''), vocab) ? 'PHR' : metaClause(p.replace(/[.!]+$/, '')) ? 'META' : '   '} ${ctx ? '' : '[' + w.r + '] '}${p.slice(0, 110)}`; });
}

/* An unwrapped question is answered only when the plan it reads to is a kind of answer this engine gets right on its own (measured on bank 6, tier 1 and tier 2).
   The wrapper never changes what is asked, but the answer to the core is only as good as the engine is on that kind of question; the kinds below were right in at least
   98% of the unwrapped answers checked. Anything else stays released as before (the model answers it). DONOVAN_DQL_UNWRAP_ALL=1 lifts this list (used only to measure). */
const SAFE_OPS = new Set(['count_distinct', 'group_sum', 'tm_expiry', 'tm_since', 'pivot_two_dims', 'max', 'bottom_n', 'duplicates', 'tm_between', 'min', 'median', 'tm_series', 'tm_inactive', 'group_avg', 'set_per_entity', 'find_document', 'missing_field', 'share_pct', 'avg', 'set_ratio',
  /* R24: measured on bank 6 (train, every company): the same plans the plain question gets right at 98%+ once the chatter is gone */
  'count', 'exists_yes_no', 'latest', 'sum', 'top_n', 'tm_compare', 'compare_two_values']);
export function unwrapAllows(plan) {
  if (process.env.DONOVAN_DQL_UNWRAP_ALL === '1') return true;
  if (!plan) return false;
  if (SAFE_OPS.has(plan.op)) return true;
  const money = (plan.filters ?? []).some((f) => f.money);
  if (plan.op === 'count' && !money) return true;
  return false;
}
export function unwrapAllowsCore(plan, core) {
  if (!unwrapAllows(plan)) return false;
  if (plan.op === 'count' && /\b(?:count|number|how\s+many)\s+(?:of\s+)?[^?]{2,60}?\s(?:and|plus|&)\s+(?:of\s+|the\s+(?:count|number)\s+of\s+|how\s+many\s+)/i.test(String(core ?? ''))) return false; // R24: "count of A and of B": two counts are asked, one plan counts one of them
  if (plan.op === 'latest' && (plan.ask === 'tech' || /\b(?:who|whom|whose|which\s+(?!(?:one|date|day|month|year)\b)[a-z]+)\b/i.test(String(core ?? '')))) return false; // R24: "who worked on the last X": the person is not always on the paper (bank 6 measured)
  if (plan.op === 'missing_field' && /\b(?:not|never|n't)\s+(?:\w+\s+)?(?:by|done|handled|made|performed|worked|assigned|completed)\b/i.test(core)) return false; // "not handled by X" is a negated name, not a missing field
  return true;
}
