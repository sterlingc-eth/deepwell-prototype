/**
 * dql/families/pagefind.js - family "pagefind": which PAPERS (and which PAGES) say a word or phrase, found by reading the text of the papers themselves (no model).
 *
 *   page_find   "which papers mention \"net 30\"", "total invoices whose text has \"deposit is $35\", with page references",
 *               "what page talks about arbitration", "find the document about a boiler", "do we have anything on asbestos",
 *               "show me the contract with Acme Holdings" (when Acme Holdings is not one of the company's own customers)
 *
 * The text of every page of the candidate papers is searched (loadFindPages: one tenant-scoped read, private papers never read). A paper is a hit when its
 * page text contains the phrase as whole words (a single plain word also matches its plural). The answer names how many papers say it, lists them with their
 * date and the page(s), and cites them. A phrase nothing says is answered "no paper mentions it" ONLY when every candidate paper has readable text; a paper
 * with no text at all makes a zero (or any count) a lower bound, so a zero is then released and a hit list says that some papers could not be read.
 *
 * How a question reaches here (see dql/parse.js): the quoted / "text has" forms are read before the core parser (a quoted phrase is searched as typed);
 * the unquoted forms ("which papers mention X") only when no other family could read the question. pagefindParse() is pure. Kill switch: DONOVAN_PAGEFIND=0.
 * Nothing here names a business or an industry.
 */
import { registerFamily } from '../registry.js';
import { fmtDate } from '../say.js';
import { editDistance } from '../text.js';
import { documentTypeLabel } from '../../documentTypes.js';
import { isPrivateDoc, notPrivateIdSql } from '../../privacy/privateDocs.js';
import { TENANT_SQL } from '../../scope.js';

export const PAGEFIND_OPS = ['page_find'];
export const pagefindOn = () => process.env.DONOVAN_PAGEFIND !== '0';
const MAX_LIST = 8; const MAX_RECORDS = 40; const MAX_DOCS = 5000;
const norm = (s) => String(s ?? '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
const lc = (s) => norm(s).toLowerCase();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const GENERIC_DOC = '(?:papers?|documents?|docs?|files?|paperwork|pdfs?|scans?|forms?|records?|pages?)';
const COUNT_LEAD = /^(?:how\s+many|number\s+of|count\s+of|total|count|tally)\b/;
const FRAME = /^(?:(?:hey|hi|hello|ok|okay|so|um|uh|well|please|pls|donovan|quick\s+question|just\s+curious|can\s+you|could\s+you|would\s+you|will\s+you|i\s+need\s+to\s+know|i\s+want\s+to\s+know|i'?d\s+like\s+to\s+know|tell\s+me|let\s+me\s+know|help\s+me\s+out|for\s+the\s+(?:quarterly\s+review|books|binder)|i'?m\s+updating\s+(?:our|the)\s+binder)\b[\s,:;-]*)+/;
const TAIL = /[\s,;-]*(?:(?:thanks|thank\s+you|thx|please|pls|asap|if\s+you\s+can|for\s+me|when\s+you\s+get\s+a\s+(?:sec|second|chance|minute)|\(.*\)|need\s+it\s+for\s+the\s+books|in\s+the\s+company\s+files|in\s+our\s+files|in\s+the\s+files)[\s,;.!?-]*)+$/;
const TERM_STOP = new Set('total date dates time times number numbers history rank rate year month week day days top bottom best worst biggest smallest average amount amounts price prices cost costs customer customers name names address'.split(' '));
const ARTICLE = /^(?:a|an|the|any|some|our|my|their|its)\s+/;

/** The company's kinds of paper named in a sentence: {types:[ids], word, group} (longest phrase first); null when the sentence names none. */
function docKinds(s, vocab) {
  const keys = [...(vocab?.docPhrases?.keys() ?? []), ...(vocab?.docGroups?.keys() ?? [])].filter((p) => p.length >= 3).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (!new RegExp(`(?<![a-z0-9])${esc(k).replace(/\s+/g, '\\s+')}(?![a-z0-9])`, 'i').test(s)) continue;
    const one = vocab.docPhrases.get(k);
    if (one) return { types: [one], word: k };
    const grp = vocab.docGroups?.get(k);
    if (grp?.length) return { types: [...grp], word: k, group: true };
  }
  return null;
}

/** Is this phrase something the core already reads as a customer, a technician, a vendor, a brand, a city or another field value? Then it names that, not a phrase on the papers. */
function isFieldValue(phrase, vocab) {
  const p = lc(phrase).replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  const s = p.replace(/s$/, '');
  const hit = (m) => m && typeof m.has === 'function' && (m.has(p) || m.has(s));
  if (hit(vocab?.names) || hit(vocab?.brands) || hit(vocab?.cities)) return true;
  if (Object.values(vocab?.cat ?? {}).some((m) => hit(m))) return true;
  // a name typed with only part of it ("Smith" for "Ann Smith") is a person
  if (vocab?.nameWords && p.split(' ').some((w) => w.length >= 3 && vocab.nameWords.has(w))) return true;
  return false;
}

const CUE = '(?:mention(?:s|ed|ing)?|contain(?:s|ed|ing)?|say(?:s|ing)?|said|read(?:s|ing)?|include[sd]?|including|talk(?:s|ed|ing)?\\s+about|discuss(?:es|ed|ing)?|refer(?:s|red|ring)?\\s+to|reference[sd]?|cover(?:s|ed|ing)?|have|has|with)';
const TEXTWORD = '(?:text|wording|words?|content|contents|pages?|body)';


/** Words of the sentence's own grammar, for settling a typo: a long word one or two letters off exactly one of them is that word. */
const CUE_WORDS = ['whose', 'text', 'wording', 'words', 'page', 'pages', 'reference', 'references', 'mention', 'mentions', 'mentioning', 'mentioned', 'contain', 'contains', 'containing', 'total', 'which', 'documents', 'document', 'papers', 'paper', 'files', 'paperwork', 'anything', 'something', 'find', 'about', 'regarding', 'talks', 'phrase', 'where', 'show', 'number', 'many', 'with', 'that'];
function mendTypos(body, vocab) {
  const docWords = (vocab._pfDocWords ??= new Set([...(vocab?.docPhrases?.keys() ?? []), ...(vocab?.docGroups?.keys() ?? [])].flatMap((k) => k.split(' ')).filter((w) => w.length >= 4)));
  const known = new Set([...CUE_WORDS, ...'what when whom whose does have your from this they them list give tell show some more most also into over each every other than then there these those were been being would could should will just only like need want know look pull open'.split(' ')]); const all = [...CUE_WORDS, ...docWords];
  return body.split(/(@p@|\s+)/).map((w) => {
    if (!/^[a-z]{4,}$/.test(w) || known.has(w) || docWords.has(w) || (vocab?.known?.has?.(w))) return w;
    const max = w.length >= 8 ? 2 : 1; let best = null; let tie = false; let bd = max + 1;
    for (const c of all) { if (Math.abs(c.length - w.length) > max) continue; const d = editDistance(w, c, max); if (d < bd) { best = c; bd = d; tie = false; } else if (d === bd && c !== best) tie = true; }
    return best && !tie && bd <= max ? best : w;
  }).join('');
}

/**
 * The question as a phrase search, or null (not mine). `mode` 'early': a quoted phrase with a text / page cue, read before the core parser.
 * 'late': the unquoted forms, read only when no other family could explain the question.
 * @returns {null | {v:1, op:'page_find', entity:'document', phrase:string, quoted:boolean, docType:(string|string[]|null), docWord:string|null, show:'count'|'list'|'pages', pageAsk:boolean, ...}}
 */
export function pagefindParse(question, { vocab, mode = 'early', cite = false } = {}) {
  if (!pagefindOn()) return null;
  let q = norm(question).replace(/[?!]+\s*$/, '');
  if (!q || q.length > 240) return null;
  // ---- the phrase
  const quoteRe = /"([^"]{3,60})"/g; const quotes = [...q.matchAll(quoteRe)];
  if (quotes.length > 1) return null;
  let phrase = null; let quoted = false; let rest;
  let body = q.toLowerCase();
  if (quotes.length === 1) {
    phrase = lc(quotes[0][1]).replace(/^[\s.,;:]+|[\s.,;:]+$/g, ''); quoted = true;
    body = `${q.slice(0, quotes[0].index)} @P@ ${q.slice(quotes[0].index + quotes[0][0].length)}`.toLowerCase();
  } else if (/["]/.test(q)) return null;
  // iterate the polite frame / tail away
  for (let i = 0; i < 3; i++) { const b = body.replace(FRAME, '').replace(TAIL, '').trim(); if (b === body) break; body = b; }
  body = mendTypos(body.replace(/\s+/g, ' '), vocab);
  if (!body) return null;
  const wantsPages = /\bpages?\b/.test(body.replace(/@p@/g, '')) || /\bpage\s+references?\b/.test(question.toLowerCase()) || cite;

  let subject = ''; let shape = null;
  if (quoted) {
    if (mode !== 'early') return null;
    // "<subject> whose text has @P@" / "<subject> that mention @P@" / "find @P@ in the papers" / "where does it say @P@"
    const m1 = new RegExp(`^(.*?)\\s*(?:(?:whose|with|where|in\\s+which|that|which)\\s+(?:the\\s+)?${TEXTWORD}\\s+(?:${CUE}|is|are)\\s+|(?:that|which|who)?\\s*${CUE}\\s+(?:the\\s+)?(?:words?\\s+|phrase\\s+|text\\s+)?)@p@(.*)$`).exec(body);
    const m2 = /^(?:find|search\s+for|look\s+for|look\s+up|search|pull\s+up|show\s+me|locate)\s+(?:me\s+)?(?:the\s+)?(?:words?\s+|phrase\s+|text\s+)?@p@\s*(?:in|on|across|through|inside)?\s*(.*)$/.exec(body);
    if (m1) { subject = m1[1].trim(); rest = m1[2].trim(); shape = 'text'; } else if (m2) { subject = m2[1].trim(); rest = ''; shape = 'find'; } else return null;
    // the cue must be an explicit text / page ask (a bare "mention" of a quoted word is also the older text search's)
    if (!(/(?:\btext\b|\bwording\b|\bwords\b|\bpages?\b|\bphrase\b|\bpapers?\b|\bdocuments?\b|\bfiles?\b|\bpdfs?\b)/.test(body.replace(/@p@/g, '')) || cite)) return null;
    if (rest && !/^(?:[-,;.]?\s*(?:with|and)?\s*(?:the\s+)?(?:page\s+references?|pages?|page\s+numbers?|file\s+names?)\s*)?$/.test(rest)) return null;
  } else {
    let m;
    // "what page talks about X" asks for the page itself, so it is read before the core parser (the older text search would answer with whole papers)
    if ((m = new RegExp(`^(?:which|what|list|show\\s+me|find|give\\s+me|any|tell\\s+me)\\s+(?:the\\s+)?pages?\\s+(?:talk(?:s)?\\s+about|mention(?:s)?|say(?:s)?|discuss(?:es)?|cover(?:s)?|refer(?:s)?\\s+to|are\\s+about|is\\s+about|contain(?:s)?)\\s+(.+)$`).exec(body))) { shape = 'pages'; phrase = m[1]; }
    else if (mode !== 'late') return null;
    else if ((m = new RegExp(`^(?:which|what|list|show\\s+me|find|give\\s+me|how\\s+many|tell\\s+me)\\s+(?:all\\s+)?(?:the\\s+)?(${GENERIC_DOC}|[a-z -]{3,30}?)\\s+(?:that\\s+|which\\s+)?(?:mention(?:s|ed)?|talk(?:s)?\\s+about|are\\s+about|is\\s+about|discuss(?:es)?|refer(?:s)?\\s+to|reference[sd]?|cover(?:s)?|contain(?:s)?|say(?:s)?)\\s+(.+)$`).exec(body))) { shape = 'which'; subject = m[1]; phrase = m[2]; }
    else if ((m = new RegExp(`^(?:find|get|pull\\s+up|locate|look\\s+for|search\\s+for|show\\s+me)\\s+(?:me\\s+)?(?:the|a|an|any)?\\s*(${GENERIC_DOC}|[a-z -]{3,30}?)\\s+(?:about|on|regarding|concerning|that\\s+mentions?|that\\s+talks?\\s+about|mentioning|for)\\s+(.+)$`).exec(body))) { shape = 'find'; subject = m[1]; phrase = m[2]; }
    else if ((m = new RegExp(`^(?:do|does)\\s+we\\s+(?:have|got)\\s+(?:anything|something|any)\\s*(${GENERIC_DOC}|[a-z -]{3,30}?)?\\s*(?:on|about|regarding|concerning|for|mentioning|that\\s+mentions?)\\s+(.+)$`).exec(body))) { shape = 'have'; subject = (m[1] ?? '').trim(); phrase = m[2]; }
    else if ((m = new RegExp(`^(?:show\\s+me|pull\\s+up|find|get|open)\\s+(?:me\\s+)?(?:the|a)\\s+([a-z -]{3,30}?)\\s+with\\s+(.+)$`).exec(body))) { shape = 'with'; subject = m[1]; phrase = m[2]; }
    else return null;
    phrase = phrase.replace(TAIL, '').replace(/[?.!,;]+$/, '').replace(ARTICLE, '').replace(ARTICLE, '').trim();
    phrase = lc(phrase);
  }
  if (!phrase) return null;

  // ---- what kind of paper
  subject = subject.replace(/^(?:(?:which|what|list|show\s+me|find|give\s+me|tell\s+me|get|pull\s+up|how\s+many|number\s+of|count\s+of|total)\s+)+/, '').replace(/^(?:all\s+(?:of\s+)?(?:the\s+)?|the\s+|our\s+|my\s+)+/, '').replace(/^total\s+/, '').trim();
  const generic = new RegExp(`^(?:${GENERIC_DOC}|)$`).test(subject.replace(/^how many\s+/, ''));
  let kinds = null;
  if (!generic) {
    // the subject must be a kind of paper this company keeps: anything else (a person, a place, an unknown noun) is not a question about papers
    kinds = docKinds(subject.replace(/^(?:total|how\s+many|number\s+of)\s+/, ''), vocab);
    if (!kinds) return null;
    // nothing but the kind of paper may stand in the subject
    const left = subject.replace(new RegExp(`(?<![a-z0-9])${esc(kinds.word).replace(/\s+/g, '\\s+')}(?![a-z0-9])`, 'i'), ' ').replace(/\b(?:total|how|many|number|of|all|the|each|every|any|files?|papers?|documents?|docs?|sheets?|copies|copy|forms?)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
    if (left) return null;
  } else if (/\bpages?\b/.test(subject) && shape !== 'pages') { /* "which pages" read as pages */ }
  const front = body.split('@p@')[0];
  const countAsk = COUNT_LEAD.test(body) || /\bhow\s+many\b/.test(front) || /\btotal\b/.test(front);

  // ---- the phrase itself
  if (!quoted) {
    if (/[0-9]{3,}-?/.test(phrase) && /[a-z]{2,5}-\d{3,}/.test(phrase)) return null; // a paper's number is looked up, not searched
    const words = phrase.replace(/[^a-z0-9$'% -]/g, ' ').split(/\s+/).filter(Boolean);
    if (!words.length || words.length > 5) return null;
    if (words.some((w) => TERM_STOP.has(w))) return null;
    if (/\b(?:and|or|but|not|no|without|except|than|between|before|after|since|during|from|to)\b/.test(words.join(' '))) return null;
    if (words.length === 1 && (words[0].length < 4 || /^\d+$/.test(words[0]))) return null;
    if (isFieldValue(words.join(' '), vocab)) return null;
    phrase = words.join(' ');
  } else if (phrase.length < 3) return null;
  if (!/[a-z0-9]/.test(phrase)) return null;
  const docType = kinds ? (kinds.types.length === 1 ? kinds.types[0] : kinds.types) : null;
  return {
    v: 1, op: 'page_find', entity: 'document', phrase, quoted, docType, docWord: kinds?.word ?? null, visit: false, filters: [], time: null, measure: null, groupBy: [], limit: null, dir: 'desc',
    show: shape === 'pages' ? 'pages' : countAsk ? 'count' : 'list', pageAsk: wantsPages, shape,
  };
}

/* ------------------------------------------------------------------ matching */
/** The phrase as a regex over page text: whole words, any run of spaces / line breaks between words; a plain single word also matches its plural. */
export function phraseRegex(phrase, quoted) {
  const words = lc(phrase).split(/\s+/).filter(Boolean);
  const parts = words.map(esc);
  const last = words[words.length - 1] ?? '';
  if (!quoted && /^[a-z]{4,}$/.test(last) && !/(?:ss|us|is)$/.test(last)) {
    parts[parts.length - 1] = last.endsWith('ies') ? `${esc(last.slice(0, -3))}(?:y|ies)` : `${esc(last.replace(/s$/, ''))}(?:s|es)?`;
  }
  const head = /^[a-z0-9]/.test(lc(phrase)) ? '(?<![a-z0-9])' : '';
  const tail = /[a-z0-9]$/.test(lc(phrase)) ? '(?![a-z0-9])' : '';
  return new RegExp(`${head}${parts.join('\\s+')}${tail}`, 'i');
}

const typeMatch = (plan, d) => (Array.isArray(plan.docType) ? plan.docType.includes(d.type) : !plan.docType || d.type === plan.docType);
/** The papers to search: the company's own papers of that kind that are not private. */
export function findCandidates(plan, snap) {
  return snap.documents.filter((d) => typeMatch(plan, d) && !isPrivateDoc({ document_type: d.type }));
}

/** Called by runDql for a page_find plan: read the pages that could hold the phrase (a cheap text pre-filter in SQL) and which candidate papers have any text at all. */
export async function loadFindPages(db, snap, plan) {
  snap.findPages = null;
  const cands = findCandidates(plan, snap);
  if (!cands.length || cands.length > MAX_DOCS) return;
  const ids = cands.map((d) => d.id);
  const words = lc(plan.phrase).split(/[^a-z0-9]+/).filter(Boolean).sort((a, b) => b.length - a.length);
  const key = (words[0] ?? '').slice(0, words[0] && words[0].length >= 6 ? 5 : words[0]?.length ?? 0);
  const hasText = await db.raw(`SELECT DISTINCT p.document_id FROM document_pages p WHERE p.document_id = ANY($1::uuid[]) AND p.${TENANT_SQL} AND ${notPrivateIdSql('p.document_id')} AND length(btrim(coalesce(p.text, ''))) > 0`, [ids]);
  const withText = new Set((hasText.rows ?? []).map((r) => String(r.document_id).toLowerCase()));
  const { rows } = await db.raw(`SELECT p.document_id, p.page_no, p.text FROM document_pages p WHERE p.document_id = ANY($1::uuid[]) AND p.${TENANT_SQL} AND ${notPrivateIdSql('p.document_id')} ${key ? 'AND strpos(lower(p.text), $2) > 0' : ''} ORDER BY p.document_id, p.page_no`, key ? [ids, key] : [ids]);
  const pages = new Map();
  for (const r of rows ?? []) { const k = String(r.document_id).toLowerCase(); if (!pages.has(k)) pages.set(k, []); pages.get(k).push({ page: Number(r.page_no), text: String(r.text ?? '') }); }
  // an unquoted word that no page prints might be a misspelling of a word the papers do print: those words are read (distinct, from the candidate papers) so a near-miss is released, not answered "none"
  let nearWords = null;
  const reAny = phraseRegex(plan.phrase, plan.quoted);
  if (!plan.quoted && looksWordLike(plan.phrase) && !(rows ?? []).some((r) => reAny.test(String(r.text ?? '')))) {
    try {
      const r = await db.raw(`SELECT DISTINCT w FROM (SELECT lower(m[1]) AS w FROM document_pages p, regexp_matches(p.text, '([A-Za-z]{4,})', 'g') AS m WHERE p.document_id = ANY($1::uuid[]) AND p.${TENANT_SQL} AND ${notPrivateIdSql('p.document_id')}) q LIMIT 60000`, [ids]);
      nearWords = new Set((r.rows ?? []).map((x) => x.w));
    } catch { nearWords = null; }
  }
  snap.findPages = { pages, withText, nearWords };
}

function exec(plan, x) {
  const { snap } = x;
  if (!pagefindOn()) return { abstain: 'off' };
  const fp = snap.findPages;
  if (!fp) return { abstain: 'no-pages' };
  const cands = findCandidates(plan, snap);
  if (!cands.length) return { abstain: 'no-paper' };
  if (cands.length > MAX_DOCS) return { abstain: 'too-many' };
  const re = phraseRegex(plan.phrase, plan.quoted);
  const hits = []; const negated = []; let unread = 0;
  for (const d of cands) {
    const k = String(d.id).toLowerCase();
    if (!fp.withText.has(k)) { unread++; continue; }
    const hitPages = [];
    let negSeen = null;
    for (const p of fp.pages.get(k) ?? []) {
      const g = new RegExp(re.source, 'gi'); let m; let first = null;
      while ((m = g.exec(p.text))) { if (!plan.quoted && negatedAt(p.text, m.index, m[0].length)) { negSeen = negSeen ?? snippetAt(p.text, m.index, m[0].length); continue; } first = first ?? m; }
      if (first) hitPages.push({ page: p.page, snippet: snippetAt(p.text, first.index, first[0].length) });
    }
    if (hitPages.length) hits.push({ d, pages: hitPages }); else if (negSeen) negated.push(negSeen);
  }
  if (!hits.length && unread) return { abstain: 'unread-papers' };
  if (!hits.length && !negated.length && !quotedIsWord(plan) && looksMisspelt(plan.phrase, snap, fp)) return { abstain: 'unknown-word' };
  hits.sort((a, b) => String(b.d.date ?? '').localeCompare(String(a.d.date ?? '')) || String(a.d.filename ?? '').localeCompare(String(b.d.filename ?? '')));
  return { hits, unread, searched: cands.length, negated };
}
const quotedIsWord = (plan) => plan.quoted;
const NEG_BEFORE = new Set('no not none never without nor neither cannot cant dont doesnt didnt wasnt isnt arent werent wont couldnt wouldnt hasnt havent negative free zero absent nothing nobody lacks lacking lack'.split(' '));
const NEG_AFTER = new Set('not none free absent negative ruled excluded nowhere'.split(' '));
/** "no leaks found", "leak-free", "leaks: none": a mention that says the thing is absent is not a mention of it. */
function negatedAt(text, idx, len) {
  const wd = (t) => lc(t).replace(/['\u2019]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
  const before = wd(String(text).slice(Math.max(0, idx - 40), idx)).slice(-4);
  const after = wd(String(text).slice(idx + len, idx + len + 24)).slice(0, 2);
  return before.some((w) => NEG_BEFORE.has(w)) || after.some((w) => NEG_AFTER.has(w)) || /^-?(free|less)\b/i.test(String(text).slice(idx + len, idx + len + 6));
}
/** An unquoted single word that is not a word of the language and that no paper prints may be a misspelling: not answered "none". */
const looksWordLike = (phrase) => { const w = lc(phrase); return !/\s/.test(w) && w.length >= 5 && /^[a-z]+$/.test(w); };
function looksMisspelt(phrase, snap, fp) {
  if (!looksWordLike(phrase)) return false;
  if (!fp?.nearWords) return true; // the papers' words could not be read: it may be a misspelling
  const w = lc(phrase); const max = w.length >= 8 ? 2 : 1;
  for (const c of fp.nearWords) { if (Math.abs(c.length - w.length) <= max && editDistance(w, c, max) <= max) return true; }
  return false;
}

function snippetAt(text, idx, len) {
  const t = String(text);
  let a = Math.max(0, idx - 28); let b = Math.min(t.length, idx + len + 28);
  const sp1 = t.lastIndexOf(' ', idx); if (a > 0 && sp1 > a - 1 && sp1 >= 0 && sp1 <= idx) a = sp1 + 1;
  const sp2 = t.indexOf(' ', idx + len + 24); if (b < t.length && sp2 > 0 && sp2 <= b + 6) b = sp2;
  return t.slice(a, b).replace(/\s+/g, ' ').trim();
}

const pagesWord = (ps) => { const n = ps.map((p) => p.page); return n.length === 1 ? `page ${n[0]}` : `pages ${n.length === 2 ? n.join(' and ') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`}`; };
const fmtInt = (n) => Number(n).toLocaleString('en-US');
const docNumber = (d) => d.f?.invoice_number ?? d.f?.po_number ?? d.f?.permit_number ?? d.f?.quote_number ?? null;

function say(res, plan, { snap }) {
  const { hits, unread, searched } = res; const negN = res.negated?.length ?? 0;
  const kindWord = (() => {
    if (!plan.docType) return 'papers';
    const t = Array.isArray(plan.docType) ? null : plan.docType;
    const lab = t ? (documentTypeLabel(t) ?? t) : (plan.docWord ?? 'papers');
    const l = String(lab).toLowerCase();
    return /s$/.test(l) ? l : `${l}s`;
  })();
  const kind1 = kindWord.replace(/s$/, '');
  const shown = `“${plan.phrase}”`;
  const n = hits.length;
  if (!n) {
    const nn = negN ? ` ${fmtInt(negN)} ${negN === 1 ? kind1 : kindWord} ${negN === 1 ? 'says' : 'say'} it only in a negated form (for example "${res.negated[0]}") and ${negN === 1 ? 'is' : 'are'} not counted.` : '';
    const text = `No ${kindWord} mention ${shown}. I read the text of all ${fmtInt(searched)} ${searched === 1 ? kind1 : kindWord} on file.${nn}`;
    return { text, facts: [{ label: 'Papers that mention it', value: '0' }], records: [], total: 0, claimedCount: 0, basis: `Searched the text of every page of the ${fmtInt(searched)} ${kindWord} on file for ${shown}${negN ? ' (negated mentions such as "no leaks found" were left out)' : ''}.` };
  }
  const label = (h) => {
    const d = h.d; const num = docNumber(d);
    const bits = [d.filename, num && !String(d.filename).includes(num) ? `no. ${num}` : null, d.date ? fmtDate(d.date) : null, pagesWord(h.pages)].filter(Boolean);
    return `${bits[0]} (${bits.slice(1).join(', ')})`;
  };
  const list = hits.slice(0, MAX_LIST).map(label);
  const more = n > MAX_LIST ? ` and ${fmtInt(n - MAX_LIST)} more` : '';
  const lead = plan.show === 'pages'
    ? `${n === 1 ? `1 ${kind1} has` : `${fmtInt(n)} ${kindWord} have`} a page that mentions ${shown}`
    : `${fmtInt(n)} ${n === 1 ? kind1 : kindWord} ${n === 1 ? 'mentions' : 'mention'} ${shown}`;
  const warn = unread ? ' Some papers on file have no readable text, so there may be more.' : '';
  const negNote = negN ? ` ${fmtInt(negN)} more ${negN === 1 ? 'paper says' : 'papers say'} it only in a negated form (for example "${res.negated[0]}") and ${negN === 1 ? 'is' : 'are'} not counted.` : '';
  const text = `${lead}: ${list.join('; ')}${more}.${warn}${negNote}`;
  const records = hits.slice(0, MAX_RECORDS).map((h) => ({ type: h.d.type === 'invoice' ? 'invoice' : 'document', id: h.d.id, documentId: h.d.id, label: h.d.filename ?? documentTypeLabel(h.d.type) ?? 'Document', page: h.pages[0].page, sublabel: h.pages[0].snippet.slice(0, 90) }));
  return {
    text, facts: [{ label: `${cap(kindWord)} that mention it`, value: fmtInt(n) }], records, total: n, claimedCount: unread ? null : n,
    basis: `Read the text of every page of the ${fmtInt(searched - unread)} ${kindWord} on file${unread ? ' that have readable text' : ''} and kept the ones that print ${shown}${negN ? ' (negated mentions such as "no leaks found" were left out)' : ''}.`,
  };
}
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

registerFamily({ id: 'pagefind', ops: PAGEFIND_OPS, detect: () => null, exec, say });
export { exec as _exec, say as _say };
