/**
 * dql/families/links.js - the links family: questions that CONNECT papers of different kinds, for any business. Nothing here knows a trade:
 * the kinds of paper come from the organization's own words (vocab.docPhrases), the links come from what the papers hold.
 *
 *   link_chain    "quotes that turned into invoices", "estimates never billed", "invoices with no matching work order", "what percent of bids became jobs"
 *   link_seq      "who had a leak and then a callback within 90 days", "jobs mentioning drywall later billed over $5000"
 *   link_ending   "agreements ending soon whose holders have open work orders"
 *   link_address  "who else is at 5650 W Mesquite Way", "what happened at 5650 W Mesquite Way in 2022"
 *
 * How papers are linked (every answer states it): first a shared job key (when both papers carry one), otherwise the same person on file
 * (the paper is linked to exactly one customer record, directly or through the customer's asset). A paper tied to no one, or to more than one person,
 * is left out and counted. Dates are the paper's service date, else its invoice date, else the day it was filed. A link needs the second paper to come
 * within a window after the first (90 days unless the question says); each later paper counts toward the closest earlier one of the first kind.
 * An ambiguous name (two customers called the same) is released to the clarify path; a kind of paper the organization does not keep is released.
 *
 * Like the sets family this one reads the whole sentence (feat.text0), is strict (every word must be explained) and stands aside for sets/time.
 */
import { registerFamily } from '../registry.js';
import { normName } from '../vocab.js';
import { ENTITY_WORDS } from '../lex.js';
import { documentTypeLabel } from '../../documentTypes.js';
import { recordFor, fmtDate } from '../say.js';
import { textIndex, resolveTerm, matchAny, isRealWord } from './textdq.js';
import { ADDR_RE, parseAddress, streetKey } from '../linkAddress.js';

export const LINK_OPS = ['link_chain', 'link_seq', 'link_ending', 'link_address', 'link_after', 'link_repeat', 'link_job'];

const fmtInt = (n) => Number(n).toLocaleString('en-US');
const usd = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const lc = (v) => (v == null ? '' : String(v).toLowerCase().trim());
const cap1 = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const DAY = 86400000;
const dayNum = (iso) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const DEFAULT_WINDOW = 90; // only for "ending soon"; a chain or a follow-up has no limit unless the question names one
const NUMW = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, sixty: 60, ninety: 90, a: 1, an: 1 };

/* ====================================================================== words */

const LEAD_OK = new Set((
  'which what list show give me name display pull find tell all the our my of are there is do did does we have has had how many count number total percent percentage share fraction proportion ' +
  'ones one any ever those these and that to in on us who whom please can you could would i need want see look bring run get a an'
).split(/\s+/));
const TAIL_OK = new Set('the a an of in on at for from by us we our my are is was were been be do did does have has had'.split(' '));
const REL_FILLER = new Set('that which who have has had were was been did do does we you ever actually all any an a the got gotten get still they it are is our my'.split(' '));
const NEG_WORDS = new Set('never not yet didnt dont doesnt havent hasnt hadnt wasnt werent isnt arent no without'.split(' '));
const MATCH_ADJ = new Set('matching matched linked related corresponding connected attached associated'.split(' '));
const CHAIN_CORES = [
  'turn into', 'turned into', 'turns into', 'become', 'became', 'becomes', 'lead to', 'led to', 'leads to', 'convert to', 'converted to', 'converts to', 'convert into', 'converted into',
  'result in', 'resulted in', 'results in', 'end up as', 'ended up as', 'ended up in', 'go on to', 'went on to', 'followed by', 'turned in', 'turn in',
];
const VERB_B = { billed: 'invoice', invoiced: 'invoice', bill: 'invoice', invoice: 'invoice' };

/* ====================================================================== lexer */

function lexItems(text0, vocab) {
  const toks = String(text0 ?? '').trim().split(/\s+/).filter(Boolean);
  const items = [];
  for (let i = 0; i < toks.length;) {
    let hit = null;
    for (let n = Math.min(vocab.maxNameWords, 6); n >= 1 && !hit; n--) {
      if (i + n > toks.length) continue;
      const key = normName(toks.slice(i, i + n).join(' '));
      const nm = vocab.names.get(key);
      if (!nm || (n === 1 && key.length < 5)) continue;
      const roles = [nm.customer && 'customer', nm.tech && 'tech', nm.vendor && 'vendor'].filter(Boolean);
      if (roles.length !== 1) return null;
      hit = { len: n, item: { t: 'name', display: nm.display, role: roles[0] } };
    }
    if (hit) { items.push(hit.item); i += hit.len; continue; }
    for (let n = Math.min(4, toks.length - i); n >= 1 && !hit; n--) {
      const ph = toks.slice(i, i + n).join(' ');
      if (n === 1 && /^(?:other|others)$/.test(ph)) continue;
      let id = vocab.docPhrases.get(ph);
      // a shared word for a kind of paper this company does not keep ("agreement" -> maintenance agreement) means the kind it does keep under that very name
      if (id && !vocab.docTypesInUse?.has(id)) { const slug = ph.replace(/s$/, '').replace(/\s+/g, '-'); const own = [...(vocab.docTypesInUse?.keys() ?? [])].filter((x) => x === slug); if (own.length === 1) id = own[0]; }
      if (id) hit = { len: n, item: { t: 'doc', id, raw: ph, word: ph.endsWith('s') && vocab.docPhrases.has(ph.slice(0, -1)) ? ph.slice(0, -1) : ph } };
    }
    if (hit) { items.push(hit.item); i += hit.len; continue; }
    const m = /^(\$?)(\d+(?:\.\d+)?)$/.exec(toks[i]);
    if (m) { items.push({ t: 'num', v: Number(m[2]), dollar: m[1] === '$' }); i++; continue; }
    items.push({ t: 'w', v: toks[i] });
    i++;
  }
  return items;
}
const words = (items) => items.map((x) => (x.t === 'w' ? x.v : null));
const allW = (items) => items.every((x) => x.t === 'w');

/** "within 90 days" (the parser's frame writes it "in the next 90 days") / "in 2025" / "for NAME": the optional ending of a question. null = something else is in it. */
function parseTail(items, today) {
  const out = { window: null, windowExplicit: false, year: null, name: null, status: null };
  for (let i = 0; i < items.length;) {
    const it = items[i];
    if (it.t === 'w' && /^(?:within|inside|in|over)$/.test(it.v)) {
      let j = i + 1;
      while (items[j]?.t === 'w' && /^(?:the|next|following|coming)$/.test(items[j].v)) j++;
      const a = items[j]; const b = items[j + 1];
      const num = a?.t === 'num' && !a.dollar ? a.v : a?.t === 'w' && NUMW[a.v] != null ? NUMW[a.v] : null;
      if (num != null && b?.t === 'w' && unitFactor(b.v)) {
        if (a.t === 'num' && it.v === 'in' && j === i + 1 && !b) return null;
        out.window = num * unitFactor(b.v); out.windowExplicit = true; i = j + 2; continue;
      }
      if (it.v === 'in' && a?.t === 'num' && !a.dollar && a.v >= 1990 && a.v <= 2100 && Number.isInteger(a.v)) { out.year = a.v; i = j + 1; continue; }
      if (it.v === 'in' && items[i + 1]?.t === 'w' && /^(?:last|this)$/.test(items[i + 1].v) && items[i + 2]?.t === 'w' && items[i + 2].v === 'year') { out.year = Number(today.slice(0, 4)) - (items[i + 1].v === 'last' ? 1 : 0); i += 3; continue; }
      return null;
    }
    if (it.t === 'w' && it.v === 'with' && items[i + 1]?.t === 'w' && items[i + 1].v === 'status' && items[i + 2]?.t === 'w') { out.status = items[i + 2].v; i += 3; continue; }
    if (it.t === 'num' && !it.dollar && it.v >= 1990 && it.v <= 2100 && Number.isInteger(it.v) && out.year == null) { out.year = it.v; i++; continue; }
    if (it.t === 'name' && it.role === 'customer' && !out.name) { out.name = it.display; i++; continue; }
    if (it.t === 'w' && TAIL_OK.has(it.v)) { i++; continue; }
    return null;
  }
  return out;
}
function unitFactor(u) {
  if (/^days?$/.test(u)) return 1;
  if (/^weeks?$/.test(u)) return 7;
  if (/^months?$/.test(u)) return 30;
  if (/^years?$/.test(u)) return 365;
  return null;
}

function leadKind(items) {
  const ws = words(items);
  if (!allW(items)) return null;
  const s = ws.join(' ');
  if (!ws.every((w) => LEAD_OK.has(w))) return null;
  let kind = 'list';
  if (/\b(?:how many|number of|count|total number)\b/.test(s)) kind = 'count';
  if (/\b(?:percent|percentage|share|fraction|proportion)\b/.test(s)) kind = 'share';
  return kind;
}

/* ====================================================================== parse: chain */

function typeOk(vocab, id) { return id && vocab.docTypesInUse?.has(id) && !/^(?:hr-letter|internal)$/.test(id); }

function parseChain(items, vocab, today) {
  const di = items.map((x, i) => (x.t === 'doc' ? i : -1)).filter((i) => i >= 0);
  if (di.length < 1 || di.length > 2) return null;
  const aIdx = di[0];
  const A = items[aIdx];
  let B; let relItems; let tailItems; let verbB = false;
  if (di.length === 2) {
    B = items[di[1]];
    relItems = items.slice(aIdx + 1, di[1]);
    tailItems = items.slice(di[1] + 1);
  } else {
    // "quotes never billed": the verb names the second kind of paper
    const vi = items.findIndex((x, i) => i > aIdx && x.t === 'w' && VERB_B[x.v]);
    if (vi < 0) return null;
    const id = VERB_B[items[vi].v];
    if (!vocab.docTypesInUse?.has(id)) return null;
    B = { t: 'doc', id, word: 'invoice' };
    verbB = true;
    relItems = items.slice(aIdx + 1, vi);
    tailItems = items.slice(vi + 1);
  }
  if (A.id === B.id) return null;
  if (!typeOk(vocab, A.id) || !typeOk(vocab, B.id)) return null;
  const leadAll = items.slice(0, aIdx);
  const leadNames = leadAll.filter((x) => x.t === 'name');
  const lead = leadAll.filter((x) => x.t !== 'name');
  const kind = leadKind(lead);
  if (!kind) return null;
  if (!allW(relItems)) return null;
  // the relation words between the two kinds of paper
  const rel = relItems.map((x) => x.v);
  const negs = rel.filter((w) => NEG_WORDS.has(w));
  let rest = rel.filter((w) => !NEG_WORDS.has(w) && !REL_FILLER.has(w));
  const hasMatch = rest.some((w) => MATCH_ADJ.has(w));
  rest = rest.filter((w) => !MATCH_ADJ.has(w));
  const restS = rest.join(' ');
  let dir; let mode;
  if (verbB) {
    // "never billed", "that were not yet invoiced", "that got billed"
    if (rest.length && !(rest.length === 1 && /^(?:be|get|been|become|became|was)$/.test(rest[0]))) { if (rest.join(' ') !== '') return null; }
    dir = 'forward'; mode = negs.length ? 'no' : 'yes';
    if (negs.some((w) => w === 'no' || w === 'without')) return null;
  } else if (CHAIN_CORES.includes(restS)) {
    dir = 'forward'; mode = negs.length ? 'no' : 'yes';
    if (negs.some((w) => w === 'no' || w === 'without')) return null;
  } else if (/^(?:with|with no|no|missing|lacking|without|with a|with an)$/.test(restS) || (restS === '' && negs.some((w) => w === 'no' || w === 'without'))) {
    // "invoices with no matching work order", "quotes without an invoice"
    const noNeg = negs.some((w) => w === 'no' || w === 'without') || /^(?:missing|lacking|without|with no|no)$/.test(restS);
    const plain = /^(?:with|with a|with an)$/.test(restS) && !negs.length;
    if (!noNeg && !plain) return null;
    if (negs.some((w) => !(w === 'no' || w === 'without'))) return null;
    dir = 'around'; mode = noNeg ? 'no' : 'yes';
    if (restS === '' && !hasMatch && !negs.length) return null;
  } else return null;
  const tail = parseTail(tailItems, today);
  if (!tail) return null;
  const names = [...leadNames.map((n) => n.display), ...(tail.name ? [tail.name] : [])];
  if (names.length > 1) return null;
  return {
    op: 'link_chain', a: { type: A.id, word: A.word }, b: { type: B.id, word: B.word, verb: verbB }, dir, mode, kind,
    window: tail.window ?? null, windowExplicit: tail.windowExplicit, year: tail.year, name: names[0] ?? null, match: hasMatch,
  };
}

/* ====================================================================== parse: sequences inside the papers */

const SEQ_THEN = new Set('then later afterwards afterward subsequently thereafter'.split(' '));
const STOPT = new Set('and then later afterwards afterward subsequently that which were was got get is are within in on for by from over under above below more less than'.split(' '));

/** [words] between two cue positions -> a raw term for textdq's resolveTerm (articles dropped). */
function termOf(ws) {
  const parts = ws.filter((w) => !/^(?:a|an|the|any|some|another|their|his|her|its|of)$/.test(w));
  if (!parts.length || parts.length > 3) return null;
  if (parts.some((w) => STOPT.has(w) || LEAD_OK.has(w) || /^\d+$/.test(w))) return null;
  return { words: parts, chunkLens: [parts.length], literalNeg: false, display: parts.join(' ') };
}

function parseSeq(items, vocab, today) {
  // everything but numbers/doc types must be words for the term parts
  const flat = items.map((x) => (x.t === 'w' ? x.v : x.t === 'doc' ? `@doc:${x.id}:${x.raw ?? x.word}` : x.t === 'num' ? `@num:${x.v}:${x.dollar ? 1 : 0}` : x.t === 'name' ? '@name' : '?'));
  if (flat.includes('@name') || flat.includes('?')) return null;
  const cueIdx = flat.findIndex((w) => /^(?:had|has|have|reported|reporting|mention|mentions|mentioned|mentioning|saying|said|says|noting|noted|with|involving|involved|about)$/.test(w));
  if (cueIdx < 0) return null;
  const leadWs = flat.slice(0, cueIdx);
  if (leadWs.some((w) => w.startsWith('@'))) {
    // a document type in the lead: "jobs mentioning drywall ..." (subject kind)
  }
  const subjDoc = items.slice(0, cueIdx).find((x) => x.t === 'doc') ?? null;
  const leadPlain = leadWs.filter((w) => !w.startsWith('@'));
  const subjectWho = leadPlain.some((w) => /^(?:who|customers?|clients?|people|accounts?|folks|anyone|anybody)$/.test(w)) || (ENTITY_WORDS.customer ?? []).some((p) => leadPlain.includes(p));
  const jobs = leadPlain.some((w) => /^(?:jobs?|work|papers?|documents?|records?|visits?|tickets?|orders?|files?|paperwork|ones|entries|notes)$/.test(w)) || Boolean(subjDoc);
  if (!subjectWho && !jobs) return null;
  const kind = (() => { const k = leadKind(items.slice(0, cueIdx).filter((x) => x.t === 'w' && !/^(?:jobs?|work|papers?|documents?|records?|visits?|tickets?|orders?|files?|paperwork|entries|customers?|clients?|people|accounts?|folks|anyone|anybody|notes)$/.test(x.v))); return k; })();
  if (!kind || kind === 'share') return null;
  // the first term: from the cue to the first "then"/"later"/"and"/"billed"
  let j = cueIdx + 1;
  const t1 = []; let docWord1 = false;
  while (j < flat.length && (!flat[j].startsWith('@') || flat[j].startsWith('@doc:')) && !STOPT.has(flat[j]) && !VERB_B[flat[j]]) { if (flat[j].startsWith('@doc:')) docWord1 = true; t1.push(flat[j].startsWith('@doc:') ? flat[j].split(':').slice(2).join(':') : flat[j]); j++; }
  const term1 = termOf(t1);
  if (!term1) return null;
  term1.docWord = docWord1;
  // connector words
  const conn = [];
  while (j < flat.length && (STOPT.has(flat[j]) || /^(?:followed|by|go|went|on|to|came|come|back|again|also|were|was|a|an|the|another|new|second|follow)$/.test(flat[j]))) {
    if (/^(?:within|over|under|above|below|more|less|than|in|for|by|from)$/.test(flat[j]) && !(flat[j] === 'by' && conn.includes('followed'))) break;
    conn.push(flat[j]); j++;
  }
  if (!conn.some((w) => SEQ_THEN.has(w) || w === 'followed' || w === 'and')) return null;
  if (conn.includes('and') && !conn.some((w) => SEQ_THEN.has(w) || w === 'followed')) return null;
  // the second part: a billed amount, a kind of paper, or another term
  let b = null; let k = j;
  if (VERB_B[flat[k]] && vocab.docTypesInUse?.has('invoice')) {
    // "later billed over $5000"
    k++;
    let cmp = null; let amount = null;
    const cw = [];
    while (k < flat.length && !flat[k].startsWith('@num')) { cw.push(flat[k]); k++; }
    const s = cw.join(' ');
    if (/^(?:for |at )?(?:over|above|more than|greater than|exceeding|higher than|bigger than)$/.test(s)) cmp = 'gt';
    else if (/^(?:for |at )?(?:under|below|less than|lower than|smaller than)$/.test(s)) cmp = 'lt';
    else if (/^(?:at least)$/.test(s)) cmp = 'gte';
    else if (/^(?:at most|no more than)$/.test(s)) cmp = 'lte';
    else if (s !== '') return null;
    if (cmp) { if (!flat[k] || !flat[k].startsWith('@num')) return null; const [, v, dol] = flat[k].split(':'); if (dol !== '1' && Number(v) < 100) return null; amount = Number(v); k++; }
    b = { type: 'invoice', cmp, amount };
  } else if (flat[k] && flat[k].startsWith('@doc:')) {
    b = { type: flat[k].split(':')[1] }; k++;
  } else {
    const t2 = [];
    while (k < flat.length && !flat[k].startsWith('@') && !/^(?:within|in|over|under)$/.test(flat[k])) { t2.push(flat[k]); k++; }
    const term2 = termOf(t2.filter((w) => !/^(?:a|an|the|another|follow|up|visit)$/.test(w) || true));
    if (!term2) return null;
    b = { term: term2 };
  }
  const tail = parseTail(items.slice(k), today);
  if (!tail || tail.name) return null;
  return { op: 'link_seq', a: { term: term1, type: subjDoc?.id ?? null, word: subjDoc?.word ?? null }, b, dir: 'forward', mode: 'yes', kind, group: subjectWho && !subjDoc && !/jobs?|work|papers?|documents?|records?|visits?|tickets?/.test(leadPlain.join(' ')) ? 'customer' : (subjectWho && leadPlain.includes('who') ? 'customer' : 'doc'), window: tail.window ?? null, windowExplicit: tail.windowExplicit, year: tail.year };
}

/* ====================================================================== parse: ending soon + open papers */

function parseEnding(items, vocab, today) {
  const di = items.map((x, i) => (x.t === 'doc' ? i : -1)).filter((i) => i >= 0);
  if (di.length !== 2) return null;
  const A = items[di[0]]; const B = items[di[1]];
  if (!typeOk(vocab, A.id) || !typeOk(vocab, B.id) || A.id === B.id) return null;
  const lead = items.slice(0, di[0]);
  if (!allW(lead)) return null;
  const kind = leadKind(lead);
  if (!kind || kind === 'share') return null;
  const mid = items.slice(di[0] + 1, di[1]);
  const ws = mid.map((x) => (x.t === 'w' ? x.v : x.t === 'num' ? `#${x.v}` : '?'));
  if (ws.includes('?')) return null;
  const whoseAt = ws.findIndex((w) => /^(?:whose|where|with|and|but|whose)$/.test(w));
  const s0 = whoseAt >= 0 ? ws.slice(0, whoseAt) : ws;
  // "ending soon" / "ending in the next 60 days" / "expiring within 90 days"
  const verbI = s0.findIndex((w) => /^(?:ending|ends|end|expiring|expires|expire|run|runs|running|due|coming|lapsing|lapse|lapses)$/.test(w));
  if (verbI < 0) return null;
  let windowDays = null; let explicit = false;
  const after = s0.slice(verbI + 1);
  const a2 = after.filter((w) => !/^(?:to|end|out|up|soon|shortly|the|in|within|next|coming|a|an|for|by)$/.test(w));
  if (a2.length === 0) { windowDays = DEFAULT_WINDOW; }
  else if (a2.length === 2 && /^#\d+$/.test(a2[0]) && unitFactor(a2[1])) { windowDays = Number(a2[0].slice(1)) * unitFactor(a2[1]); explicit = true; }
  else if (a2.length === 2 && NUMW[a2[0]] != null && unitFactor(a2[1])) { windowDays = NUMW[a2[0]] * unitFactor(a2[1]); explicit = true; }
  else return null;
  const rest = whoseAt >= 0 ? ws.slice(whoseAt) : [];
  // "whose holders have open work orders": a holder word, a have word, then (optionally) a status word before the kind of paper
  const hold = rest.filter((w) => !/^(?:whose|where|with|and|but|the|their|its|also|still|that|who|have|has|had|got|holder|holders|owner|owners|customer|customers|client|clients|tenant|tenants|people|person|member|members|account|accounts|signers|parties|party|on|file|any|an|a)$/.test(w));
  if (!rest.length) return null;
  if (!rest.some((w) => /^(?:holders?|owners?|customers?|clients?|tenants?|people|person|members?|accounts?|parties|party|who)$/.test(w))) return null;
  if (hold.length > 1) return null;
  const tail = parseTail(items.slice(di[1] + 1), today);
  if (!tail || tail.name || tail.year || tail.window) return null;
  if (tail.status && hold[0]) return null;
  return { op: 'link_ending', a: { type: A.id, word: A.word }, b: { type: B.id, word: B.word, status: hold[0] ?? tail.status ?? null }, kind, window: windowDays, windowExplicit: explicit };
}

/* ====================================================================== parse: served after a term ended */

const EVENT_VERBS = new Set('serviced visited repaired seen handled worked fixed'.split(' '));
const UNIT_NOUNS = new Set((ENTITY_WORDS.unit ?? []).filter((x) => !x.includes(' ')));
const CUST_NOUNS = new Set([...(ENTITY_WORDS.customer ?? []).filter((x) => !x.includes(' ')), 'people', 'accounts']);

/** "units serviced after their warranty ended", "customers visited after their agreement expired" */
function parseAfter(items, vocab) {
  const ai = items.findIndex((x) => x.t === 'w' && x.v === 'after');
  if (ai < 1) return null;
  const pre = items.slice(0, ai); const post = items.slice(ai + 1);
  if (pre.some((x) => x.t === 'name' || x.t === 'num')) return null;
  const pw = pre.filter((x) => x.t === 'w').map((x) => x.v);
  const subjUnit = pw.find((w) => UNIT_NOUNS.has(w)); const subjCust = pw.find((w) => CUST_NOUNS.has(w));
  if ((subjUnit ? 1 : 0) + (subjCust ? 1 : 0) !== 1) return null;
  const evI = pw.findIndex((w) => EVENT_VERBS.has(w));
  const rest = pw.filter((w, i) => i !== evI && w !== subjUnit && w !== subjCust);
  if (evI < 0 && !(pw.includes('service') || pw.includes('visit'))) return null;
  if (!rest.every((w) => LEAD_OK.has(w) || /^(?:were|was|ever|had|have|got|gotten|any|service|visit|a|an|that|which|who|been)$/.test(w))) return null;
  const kind = leadKind(pre.filter((x) => x.t === 'w' && !UNIT_NOUNS.has(x.v) && !CUST_NOUNS.has(x.v) && !EVENT_VERBS.has(x.v) && !/^(?:service|visit|had|have|got|gotten|ever|were|was|been|any|that|which|who)$/.test(x.v)).concat(pre.filter((x) => x.t !== 'w')));
  if (!kind || kind === 'share') return null;
  const dI = post.findIndex((x) => x.t === 'doc');
  const pwords = post.filter((x) => x.t === 'w').map((x) => x.v);
  const endV = pwords.findIndex((w) => /^(?:ended|expired|lapsed|ending|expiration|expiry|expires|ends)$/.test(w) || (w === 'ran' && pwords.includes('out')));
  if (endV < 0) return null;
  const poss = pwords.filter((w) => /^(?:their|its|the|his|her|a|an|has|had|was|were|is|over|ran|out|ended|expired|lapsed|ending|expiration|expiry|expires|ends)$/.test(w));
  const other = pwords.filter((w) => !poss.includes(w) && w !== 'warranty' && w !== 'coverage');
  if (other.length) return null;
  const warranty = pwords.includes('warranty') || pwords.includes('coverage');
  if (warranty && dI >= 0 && post[dI].id !== 'warranty-registration') return null;
  if (subjUnit) { if (!warranty && dI < 0) return null; if (!warranty) return null; return { op: 'link_after', subject: 'unit', kind, via: 'warranty', noun: subjUnit }; }
  if (warranty) return null;
  if (dI < 0 || !typeOk(vocab, post[dI].id)) return null;
  return { op: 'link_after', subject: 'customer', kind, via: post[dI].id, word: post[dI].word, noun: subjCust };
}

/* ====================================================================== parse: people a member of staff has seen more than once */

const REPEAT_VERBS = new Set('seen served handled visited helped worked serviced treated met assisted done had'.split(' '));
function parseRepeat(items) {
  const names = items.filter((x) => x.t === 'name');
  if (names.length !== 1 || names[0].role !== 'tech') return null;
  const flat = items.map((x) => (x.t === 'w' ? x.v : x.t === 'name' ? '@N' : x.t === 'num' ? `#${x.v}` : x.t === 'doc' ? '?' : '?'));
  if (flat.includes('?')) return null;
  const s = flat.join(' ');
  let min = null; let stripped = s;
  const sub = (re, f) => { const m = re.exec(stripped); if (m) { min = f(m); stripped = stripped.replace(m[0], ' '); return true; } return false; };
  if (!(sub(/\b(?:more than once|multiple times|repeatedly|several times|more than one time)\b/, () => 2) || sub(/\bmore than #(\d+) times\b/, (m) => Number(m[1]) + 1) || sub(/\b(?:at least )?#(\d+) (?:or more )?times(?: or more)?\b/, (m) => Number(m[1])) || sub(/\bat least #(\d+)\b/, (m) => Number(m[1])))) return null;
  if (min == null || min < 2 || min > 20) return null;
  const ws = stripped.split(/\s+/).filter(Boolean).filter((w) => w !== '@N');
  const custNoun = ws.find((w) => CUST_NOUNS.has(w) || /^(?:who|whom|people|persons?)$/.test(w));
  if (!custNoun) return null;
  const rest = ws.filter((w) => w !== custNoun);
  if (!rest.some((w) => REPEAT_VERBS.has(w))) return null;
  const kind = rest.some((w) => /^(?:how|many|count|number)$/.test(w)) ? 'count' : 'list';
  const extra = rest.filter((w) => !LEAD_OK.has(w) && !REPEAT_VERBS.has(w) && !/^(?:by|been|has|have|had|did|does|for|with|on|to|more|than|times|time|or|at|least|ever|again|once|worked|work)$/.test(w));
  if (extra.length) return null;
  return { op: 'link_repeat', tech: names[0].display, min, kind };
}

/* ====================================================================== parse: which job is a paper for */

const NUM_TOKEN = /\b([A-Za-z]{1,6}-?\d{2,}[A-Za-z0-9-]*)\b/;
function parseJob(raw) {
  const m = NUM_TOKEN.exec(String(raw ?? ''));
  if (!m) return null;
  const rest = String(raw).replace(m[0], ' ').toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!rest.some((w) => /^(?:job|project|matter|case|site|jobs|projects|matters|cases)$/.test(w))) return null;
  if (!rest.some((w) => /^(?:which|what)$/.test(w))) return null;
  const OK = new Set('which what job project matter case site jobs projects matters cases was is does did the this that paper belong belongs belonged to for of part under go goes with relate related tied linked connected attached assigned and in are were a an'.split(' '));
  if (!rest.every((w) => OK.has(w) || LEAD_OK.has(w))) return null;
  return { op: 'link_job', number: m[1] };
}

/* ====================================================================== parse: addresses */

/* ====================================================================== slots + detect */

function parseLinks(feat, vocab, today) {
  const text0 = feat.text0;
  let plan = null;
  plan = parseJob(feat.raw); if (plan) return plan;
  if (ADDR_RE.test(feat.raw ?? '')) { plan = parseAddress(feat.raw, today); if (plan) return plan; }
  const items = lexItems(text0, vocab);
  if (!items) return null;
  plan = parseChain(items, vocab, today);
  if (plan) return plan;
  plan = parseEnding(items, vocab, today);
  if (plan) return plan;
  plan = parseAfter(items, vocab);
  if (plan) return plan;
  plan = parseRepeat(items);
  if (plan) return plan;
  return parseSeq(items, vocab, today);
}

function slots(w, feat, vocab) {
  if (!feat.text0 || feat.sets || feat.timeq) return;
  { const off = process.env.DONOVAN_DQL_LINKS_OFF; if (off && off.split(',').map((x) => x.trim()).some((x) => x === 'all')) return; }
  let plan = null;
  const text0 = feat.text0;
  // the core repairs a misspelling into one of its own words ("replaced" -> "placed"): a plain word typed correctly is read as typed (only while this family reads; the text is restored when it does not claim the question)
  try {
    const tk = String(feat.text0).trim().split(/\s+/);
    const rw = feat.rawWords; if (Array.isArray(rw) && rw.length === tk.length) feat.text0 = ` ${tk.map((t, i) => (rw[i] !== t && isRealWord(rw[i]) ? rw[i] : t)).join(' ')} `;
  } catch { /* keep the text as it is */ }
  try { plan = parseLinks(feat, vocab, feat.today); } catch (e) { if (process.env.DQL_DEBUG) console.error('links slots error', e); plan = null; }
  if (!plan) feat.text0 = text0;
  if (process.env.DQL_DEBUG) console.error('links:', String(feat.text0).trim(), '=>', plan ? JSON.stringify(plan).slice(0, 300) : 'no parse');
  if (!plan) return;
  { const off = process.env.DONOVAN_DQL_LINKS_OFF; if (off && off.split(',').map((x) => x.trim()).includes(plan.op)) { feat.text0 = text0; return; } }
  feat.links = plan;
  feat.text0 = '';
  w.s = ' '.repeat(w.s.length);
}
function detect(feat) { return feat.links ?? null; }

/* ====================================================================== exec: shared link index */

const IX = new WeakMap();
function linkIndex(snap) {
  let ix = IX.get(snap);
  if (ix) return ix;
  const jobKey = new Map();
  for (const f of snap.fin ?? []) { const k = f.job_key ?? null; if (k && f.doc?.id) jobKey.set(f.doc.id, String(k)); }
  const byType = new Map();
  for (const d of snap.documents) { if (!byType.has(d.type)) byType.set(d.type, []); byType.get(d.type).push(d); }
  ix = { jobKey, byType };
  IX.set(snap, ix);
  return ix;
}
const docNum = (d) => d.f?.invoice_number ?? d.f?.po_number ?? d.f?.permit_number ?? null;
const docLabel = (d) => `${docNum(d) ?? d.filename ?? documentTypeLabel(d.type)}`;
const docLine = (d, withCust = true) => {
  const bits = [withCust ? d.custName : null, d.date ? fmtDate(d.date) : null, d.total != null ? usd(d.total) : null].filter(Boolean);
  return bits.length ? `${docLabel(d)} (${bits.join(', ')})` : docLabel(d);
};
const art = (w) => (/^[aeiou]/i.test(w) ? 'an' : 'a');
const plural = (w) => (/s$/.test(w) ? w : /(?:ch|sh|x)$/.test(w) ? `${w}es` : /[^aeiou]y$/.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`);
const wordOf = (x) => { const w = String(x.word ?? documentTypeLabel(x.type) ?? x.type).toLowerCase(); return w.replace(/s$/, ''); };

/** Is the pair of papers one job: both carry the same job key (and are not tied to two different people), otherwise the same person on file. */
function sameJob(a, b, ix) {
  const ka = ix.jobKey.get(a.id); const kb = ix.jobKey.get(b.id);
  if (ka && kb) return ka === kb && (a.custId === b.custId || !a.custId || !b.custId);
  return Boolean(a.custId) && a.custId === b.custId;
}
const tied = (d, ix) => Boolean(d.custId || ix.jobKey.get(d.id));
/** index of papers by person and by job key: the candidates a paper may be linked to */
function indexPapers(list, ix) {
  const byC = new Map(); const byK = new Map();
  for (const d of list) {
    if (!d.date) continue;
    if (d.custId) { if (!byC.has(d.custId)) byC.set(d.custId, []); byC.get(d.custId).push(d); }
    const k = ix.jobKey.get(d.id); if (k) { if (!byK.has(k)) byK.set(k, []); byK.get(k).push(d); }
  }
  return { cands(x) { const out = new Map(); for (const d of byC.get(x.custId) ?? []) out.set(d.id, d); const k = ix.jobKey.get(x.id); if (k) for (const d of byK.get(k) ?? []) out.set(d.id, d); return [...out.values()]; } };
}
const inYear = (d, year) => year == null || (d.date && d.date.slice(0, 4) === String(year));

function ambiguousCustomer(plan, snap) {
  if (!plan.name) return null;
  const same = snap.customers.filter((c) => lc(c.name) === lc(plan.name));
  if (same.length > 1) return { abstain: 'ambiguous-name', name: plan.name };
  return null;
}

/* ====================================================================== exec: chain */

function execChain(plan, x) {
  const { snap } = x;
  const ix = linkIndex(snap);
  const amb = ambiguousCustomer(plan, snap); if (amb) return amb;
  const aAll = ix.byType.get(plan.a.type) ?? []; const bAll = ix.byType.get(plan.b.type) ?? [];
  if (!aAll.length || !bAll.length) return { abstain: 'type-not-on-file' };
  const cust = plan.name ? snap.customers.find((c) => lc(c.name) === lc(plan.name)) : null;
  if (plan.name && !cust) return { abstain: 'name-not-found' };
  // the answer must rest on evidence that the linking rule works in this company's papers: when the rule finds no (or almost no) ordered links anywhere, or the dates run against the order asked, the question is released
  {
    const bIx0 = indexPapers(bAll.filter((d) => tied(d, ix)), ix);
    const tiedA = aAll.filter((d) => tied(d, ix) && d.date);
    let L = 0;
    for (const a of tiedA) {
      if (bIx0.cands(a).some((b) => b.id !== a.id && sameJob(a, b, ix) && (plan.dir === 'around' || (plan.dir === 'back' ? b.date <= a.date : b.date >= a.date)))) L++;
    }
    if (tiedA.length >= 3 && L <= (tiedA.length >= 20 ? Math.floor(tiedA.length * 0.02) : 0)) return { abstain: 'no-link-evidence' };
  }
  let A = aAll.filter((d) => inYear(d, plan.year) && (!cust || d.custId === cust.id));
  const notTied = A.filter((d) => !tied(d, ix)).length;
  const noDate = A.filter((d) => tied(d, ix) && !d.date).length;
  A = A.filter((d) => tied(d, ix) && d.date);
  const W = plan.window ?? Infinity;
  const linked = new Map(); // a.id -> [b...]
  if (plan.dir === 'forward') {
    // each later paper counts toward the closest earlier paper of the first kind (same job)
    const aIx = indexPapers(aAll.filter((d) => tied(d, ix)), ix);
    for (const b of bAll) {
      if (!tied(b, ix) || !b.date) continue;
      let best = [];
      for (const a of aIx.cands(b)) {
        if (a.date > b.date || !sameJob(a, b, ix) || dayNum(b.date) - dayNum(a.date) > W) continue;
        if (!best.length || a.date > best[0].date) best = [a]; else if (a.date === best[0].date) best.push(a); // two equally close: the later paper counts toward both, never toward a guessed one
      }
      for (const a of best) { if (!linked.has(a.id)) linked.set(a.id, []); linked.get(a.id).push(b); }
    }
  } else {
    const bIx = indexPapers(bAll.filter((d) => tied(d, ix)), ix);
    for (const a of A) {
      const hit = bIx.cands(a).filter((b) => sameJob(a, b, ix) && Math.abs(dayNum(b.date) - dayNum(a.date)) <= W && (plan.dir === 'around' || (plan.dir === 'back' && b.date <= a.date)));
      if (hit.length) linked.set(a.id, hit);
    }
  }
  const yes = A.filter((a) => linked.has(a.id)); const no = A.filter((a) => !linked.has(a.id));
  const sel = plan.mode === 'yes' ? yes : no;
  sel.sort((p, q) => p.date.localeCompare(q.date) || String(p.id).localeCompare(String(q.id)));
  return { sel, yes, no, total: A.length, linked, notTied, noDate, cust };
}

function sayChain(res, plan, { snap }) {
  const out = { text: '', facts: [], records: [], basis: '', total: 0, claimedCount: null };
  const aw = wordOf(plan.a); const bw = wordOf(plan.b);
  const Ap = plural(aw); const Bp = plural(bw);
  const who = plan.name ? ` for ${plan.name}` : '';
  const when = plan.year ? ` in ${plan.year}` : '';
  const rel = plan.dir === 'forward'
    ? (plan.b.verb ? (plan.mode === 'yes' ? 'were billed' : 'were never billed') : (plan.mode === 'yes' ? `turned into ${Bp}` : `never turned into ${Bp}`))
    : (plan.mode === 'yes' ? `have a matching ${bw}` : `have no matching ${bw}`);
  const winTxt = plan.window ? ` and within ${fmtInt(plan.window)} days of it` : '';
  const linkTxt = plan.dir === 'forward'
    ? `${art(bw)} ${bw} for the same person dated on or after the ${aw}${winTxt}`
    : `${art(bw)} ${bw} for the same person dated ${plan.window ? `within ${fmtInt(plan.window)} days of the ${aw}` : `at any time`}`;
  const left = [res.notTied ? `${fmtInt(res.notTied)} ${res.notTied === 1 ? aw : Ap} not tied to one person on file ${res.notTied === 1 ? 'was' : 'were'} left out` : null, res.noDate ? `${fmtInt(res.noDate)} with no date ${res.noDate === 1 ? 'was' : 'were'} left out` : null].filter(Boolean);
  const rule = `Linked each ${aw} to ${linkTxt}${plan.dir === 'forward' ? ' (each ' + bw + ' counts toward the closest earlier ' + aw + ')' : ''}; where both papers carry a job key it must match, otherwise the link is the same person on file.${left.length ? ` ${cap1(left.join('; '))}.` : ''}`;
  out.basis = rule;
  const n = res.sel.length; const total = res.total;
  out.facts = [{ label: cap1(Ap), value: fmtInt(n) }];
  if (!total) { out.text = `No ${Ap}${who}${when} are tied to one person on file, so there is nothing to link.`; return out; }
  if (plan.kind === 'share') {
    const pct = Math.round((res.yes.length / total) * 1000) / 10;
    out.text = `${fmtInt(res.yes.length)} of ${fmtInt(total)} ${total === 1 ? aw : Ap}${who}${when} (${pct}%) ${plan.dir === 'forward' ? (plan.b.verb ? 'were billed' : `turned into ${Bp}`) : `have a matching ${bw}`}.`;
    out.facts = [{ label: 'Share', value: `${pct}%` }];
    out.records = res.yes.slice(0, 200).map((d) => recordFor({ entity: 'document' }, d, snap)); out.total = res.yes.length;
    return out;
  }
  if (plan.kind === 'count') {
    out.text = `${fmtInt(n)} of ${fmtInt(total)} ${total === 1 ? aw : Ap}${who}${when} ${rel}.`;
    out.records = res.sel.slice(0, 200).map((d) => recordFor({ entity: 'document' }, d, snap)); out.total = n;
    return out;
  }
  if (!n) { out.text = `None of the ${fmtInt(total)} ${total === 1 ? aw : Ap}${who}${when} ${rel}.`; out.total = 0; out.claimedCount = 0; return out; }
  const cut = 40;
  const items = res.sel.slice(0, cut).map((d) => {
    const b = res.linked.get(d.id);
    return plan.mode === 'yes' && b?.length ? `${docLine(d)} -> ${docLabel(b[0])}${b[0].date ? ` (${fmtDate(b[0].date)})` : ''}` : docLine(d);
  });
  out.text = `${fmtInt(n)} of ${fmtInt(total)} ${total === 1 ? aw : Ap}${who}${when} ${rel}: ${items.join('; ')}${n > cut ? `; and ${fmtInt(n - cut)} more` : ''}.`;
  out.records = res.sel.slice(0, 200).map((d) => recordFor({ entity: 'document' }, d, snap)); out.total = n;
  return out;
}

/* ====================================================================== exec: sequences in the text */

function docHasTerm(d, term, tix) {
  const sns = tix.byDoc.get(d.id);
  if (!sns) return false;
  return matchAny(sns, term).m === 'pos';
}

function execSeq(plan, x) {
  const { snap } = x;
  const tix = textIndex(snap); const ix = linkIndex(snap);
  const t1 = resolveTerm(plan.a.term, tix);
  if (!t1) return { abstain: 'term' };
  // a word that is also the company's name for a kind of paper ("letter") is a search term only when the notes themselves use it
  if (plan.a.term.docWord && !t1.stems.every((st) => tix.stems.has(st))) return { abstain: 'term' };
  let t2 = null;
  if (plan.b.term) { t2 = resolveTerm(plan.b.term, tix); if (!t2) return { abstain: 'term' }; }
  if (plan.a.type && !(ix.byType.get(plan.a.type) ?? []).length) return { abstain: 'type-not-on-file' };
  if (plan.b.type && !(ix.byType.get(plan.b.type) ?? []).length) return { abstain: 'type-not-on-file' };
  const docs = snap.documents.filter((d) => d.custId && d.date);
  const notTied = snap.documents.filter((d) => !d.custId && tix.byDoc.has(d.id)).length;
  const A = docs.filter((d) => (!plan.a.type || d.type === plan.a.type) && inYear(d, plan.year) && docHasTerm(d, t1, tix) && !(plan.b.type === 'invoice' && d.type === 'invoice'));
  const Bcand = plan.b.term ? docs.filter((d) => docHasTerm(d, t2, tix)) : docs.filter((d) => d.type === plan.b.type && (plan.b.cmp == null || (d.total != null && (plan.b.cmp === 'gt' ? d.total > plan.b.amount : plan.b.cmp === 'gte' ? d.total >= plan.b.amount : plan.b.cmp === 'lt' ? d.total < plan.b.amount : d.total <= plan.b.amount))));
  const bIx = indexPapers(Bcand, ix);
  const W = plan.window ?? Infinity;
  const pairs = [];
  for (const a of A) {
    const cands = bIx.cands(a).filter((b) => b.id !== a.id && sameJob(a, b, ix) && (plan.b.term ? b.date > a.date : b.date >= a.date) && dayNum(b.date) - dayNum(a.date) <= W);
    if (cands.length) { cands.sort((p, q) => p.date.localeCompare(q.date)); pairs.push({ a, b: cands[0], n: cands.length }); }
  }
  pairs.sort((p, q) => p.a.date.localeCompare(q.a.date) || String(p.a.id).localeCompare(String(q.a.id)));
  if (!pairs.length && A.length && !plan.b.term) {
    // no later paper of that kind for anyone's mention: only an answer when the rule links papers at all in this company
    const tiedDocs = docs.filter((d) => d.type !== plan.b.type);
    let any = false;
    for (const a of tiedDocs) { if (bIx.cands(a).some((b) => b.id !== a.id && sameJob(a, b, ix) && b.date >= a.date)) { any = true; break; } }
    if (!any) return { abstain: 'no-link-evidence' };
  }
  return { pairs, t1, t2, notTied, nA: A.length };
}

function saySeq(res, plan, { snap }) {
  const out = { text: '', facts: [], records: [], basis: '', total: 0, claimedCount: null };
  const t1 = res.t1.display ?? plan.a.term.display; const t2 = plan.b.term ? (res.t2.display ?? plan.b.term.display) : null;
  const bDesc = plan.b.term ? `a paper mentioning "${t2}"` : `${plan.b.cmp ? `an ${wordOf({ type: plan.b.type })} ${plan.b.cmp === 'gt' ? 'over' : plan.b.cmp === 'lt' ? 'under' : plan.b.cmp === 'gte' ? 'of at least' : 'of at most'} ${usd(plan.b.amount)}` : `a ${wordOf({ type: plan.b.type })}`}`;
  out.basis = `Read the notes, work performed and line items of every paper for the mention of "${t1}" (a mention that says there was none does not count), then looked for ${bDesc} for the same person on a later date${plan.window ? ` within ${fmtInt(plan.window)} days` : ''}${plan.b.term ? '' : ' (the same day counts for a bill)'}; where both papers carry a job key it must match. ${res.notTied ? `${fmtInt(res.notTied)} papers with text that are not tied to one person were left out.` : ''}`.trim();
  const rows = res.pairs;
  const within = plan.window ? ` within ${fmtInt(plan.window)} days` : '';
  const byCust = new Map();
  for (const p of rows) { if (!byCust.has(p.a.custId)) byCust.set(p.a.custId, []); byCust.get(p.a.custId).push(p); }
  const subj = plan.group === 'customer' ? 'customers' : 'papers';
  const n = plan.group === 'customer' ? byCust.size : rows.length;
  const phrase = plan.b.term ? `then a paper mentioning "${t2}"` : `later billed${plan.b.cmp ? ` ${plan.b.cmp === 'gt' ? 'over' : plan.b.cmp === 'lt' ? 'under' : plan.b.cmp === 'gte' ? 'at least' : 'at most'} ${usd(plan.b.amount)}` : ''}`;
  out.facts = [{ label: cap1(subj), value: fmtInt(n) }];
  if (!n) { out.text = `No ${subj} on file have "${t1}" in their papers ${phrase}${within}.`; out.total = 0; out.claimedCount = 0; return out; }
  const gap = (p) => `${Math.round(dayNum(p.b.date) - dayNum(p.a.date))} days later`;
  if (plan.kind === 'count') { out.text = `${fmtInt(n)} ${n === 1 ? subj.replace(/s$/, '') : subj} with "${t1}" in a paper ${phrase}${within}.`; }
  else if (plan.group === 'customer') {
    const lines = [...byCust.values()].slice(0, 40).map((ps) => { const p = ps[0]; return `${p.a.custName} ("${t1}" ${fmtDate(p.a.date)}, ${docLabel(p.a)}; then ${docLabel(p.b)} ${fmtDate(p.b.date)}, ${gap(p)})`; });
    out.text = `${fmtInt(n)} ${n === 1 ? 'customer' : 'customers'} with "${t1}" in a paper ${phrase}${within}: ${lines.join('; ')}${n > 40 ? `; and ${fmtInt(n - 40)} more` : ''}.`;
  } else {
    const lines = rows.slice(0, 40).map((p) => `${docLine(p.a)} -> ${docLabel(p.b)} ${fmtDate(p.b.date)}${p.b.total != null ? ` ${usd(p.b.total)}` : ''}`);
    out.text = `${fmtInt(n)} ${n === 1 ? 'paper' : 'papers'} mentioning "${t1}" ${phrase.replace(/^then /, 'followed by ')}${within}: ${lines.join('; ')}${n > 40 ? `; and ${fmtInt(n - 40)} more` : ''}.`;
  }
  out.records = rows.slice(0, 200).map((p) => recordFor({ entity: 'document' }, p.a, snap)); out.total = out.records.length;
  return out;
}

/* ====================================================================== exec: ending soon + open papers */

const pad2 = (n) => String(n).padStart(2, '0');
const isoOf = (v) => { const t = String(v ?? '').trim(); let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t); if (m) return `${m[1]}-${m[2]}-${m[3]}`; m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t); return m ? `${m[3]}-${pad2(m[1])}-${pad2(m[2])}` : null; };
/** The day a paper stops being in force, read from what the paper states (a term "start - end", a lease end, an expiry). */
export function endOfPaper(d) {
  const t = String(d.f?.agreement_term ?? '');
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*(?:-|to|through|–)\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/i.exec(t);
  if (m) return `${m[6]}-${pad2(m[4])}-${pad2(m[5])}`;
  return isoOf(d.f?.lease_end_date) ?? isoOf(d.f?.coi_expires) ?? isoOf(d.f?.expiration_date) ?? isoOf(d.f?.expires) ?? isoOf(d.f?.end_date) ?? null;
}

function execEnding(plan, x) {
  const { snap, today } = x;
  const ix = linkIndex(snap);
  const aAll = ix.byType.get(plan.a.type) ?? []; const bAll = ix.byType.get(plan.b.type) ?? [];
  if (!aAll.length || !bAll.length) return { abstain: 'type-not-on-file' };
  const statuses = new Set(bAll.map((d) => lc(d.status)).filter(Boolean));
  const st = plan.b.status ? lc(plan.b.status) : null;
  if (st && !statuses.has(st)) return { abstain: 'status-word' };
  const to = addDays(today, plan.window);
  let noEnd = 0; let notTied = 0;
  const ending = [];
  for (const a of aAll) {
    const e = endOfPaper(a);
    if (!e) { noEnd++; continue; }
    if (e < today || e > to) continue;
    if (!a.custId) { notTied++; continue; }
    ending.push({ a, end: e });
  }
  const bBy = new Map();
  for (const b of bAll) { if (!b.custId || (st && lc(b.status) !== st)) continue; if (!bBy.has(b.custId)) bBy.set(b.custId, []); bBy.get(b.custId).push(b); }
  const rows = ending.filter((r) => bBy.has(r.a.custId)).map((r) => ({ ...r, bs: bBy.get(r.a.custId) }));
  rows.sort((p, q) => p.end.localeCompare(q.end) || String(p.a.id).localeCompare(String(q.a.id)));
  return { rows, nEnding: ending.length, noEnd, notTied, to, st };
}

function sayEnding(res, plan, { snap, today }) {
  const out = { text: '', facts: [], records: [], basis: '', total: 0, claimedCount: null };
  const aw = wordOf(plan.a); const bw = wordOf(plan.b); const Ap = plural(aw); const Bp = plural(bw);
  const nA = (n) => (n === 1 ? aw : Ap);
  const st = res.st ? `${res.st} ` : '';
  const span = plan.windowExplicit ? `in the next ${fmtInt(plan.window)} days` : `in the next ${fmtInt(plan.window)} days (what "soon" is read as)`;
  out.basis = `Took the ${Ap} whose end date, as the paper states it, falls between ${fmtDate(today)} and ${fmtDate(res.to)}, then looked for ${st}${Bp} filed for the same person on file; ${fmtInt(res.noEnd)} ${Ap} state no end date and ${fmtInt(res.notTied)} ending ${res.notTied === 1 ? 'one is' : 'ones are'} not tied to one person, and are left out.`;
  const n = res.rows.length;
  out.facts = [{ label: cap1(Ap), value: fmtInt(n) }];
  if (!n) { out.text = `None of the ${fmtInt(res.nEnding)} ${nA(res.nEnding)} ending ${span} belongs to someone with ${st}${Bp}.`; out.claimedCount = 0; return out; }
  if (plan.kind === 'count') { out.text = `${fmtInt(n)} of ${fmtInt(res.nEnding)} ${nA(res.nEnding)} ending ${span} belong${n === 1 ? 's' : ''} to ${n === 1 ? 'someone' : 'people'} with ${st}${Bp}.`; }
  else {
    const lines = res.rows.slice(0, 40).map((r) => `${docLabel(r.a)} (${r.a.custName}, ends ${fmtDate(r.end)}; ${fmtInt(r.bs.length)} ${st}${r.bs.length === 1 ? bw : Bp})`);
    out.text = `${fmtInt(n)} of ${fmtInt(res.nEnding)} ${nA(res.nEnding)} ending ${span} belong${n === 1 ? 's' : ''} to ${n === 1 ? 'someone' : 'people'} with ${st}${Bp}: ${lines.join('; ')}${n > 40 ? `; and ${fmtInt(n - 40)} more` : ''}.`;
  }
  out.records = res.rows.slice(0, 200).map((r) => recordFor({ entity: 'document' }, r.a, snap)); out.total = n;
  return out;
}

/* ====================================================================== exec: served after a term ended */

function execAfter(plan, x) {
  const { snap } = x;
  const ix = linkIndex(snap);
  const rows = [];
  if (plan.subject === 'unit') {
    const withExp = snap.units.filter((u) => u.warrantyExpires);
    if (!withExp.length) return { abstain: 'no-warranty-dates' };
    const byUnit = new Map();
    for (const d of snap.documents) { if (d.unitId && d.serviceDate) { if (!byUnit.has(d.unitId)) byUnit.set(d.unitId, []); byUnit.get(d.unitId).push(d); } }
    for (const u of withExp) {
      const after = (byUnit.get(u.id) ?? []).filter((d) => d.serviceDate > u.warrantyExpires).sort((p, q) => p.serviceDate.localeCompare(q.serviceDate));
      if (after.length) rows.push({ u, end: u.warrantyExpires, after });
    }
    rows.sort((p, q) => String(p.u.serial ?? p.u.id).localeCompare(String(q.u.serial ?? q.u.id)));
    return { rows, pop: withExp.length, unknown: snap.units.length - withExp.length };
  }
  const xs = ix.byType.get(plan.via) ?? [];
  if (!xs.length) return { abstain: 'type-not-on-file' };
  if (!xs.some((d) => endOfPaper(d))) return { abstain: 'no-end-dates' };
  const visits = new Map();
  for (const d of snap.documents) { if (d.custId && d.serviceDate && d.type !== plan.via) { if (!visits.has(d.custId)) visits.set(d.custId, []); visits.get(d.custId).push(d); } }
  const byC = new Map();
  let noEnd = 0; let notTied = 0;
  for (const d of xs) {
    const e = endOfPaper(d);
    if (!e) { noEnd++; continue; }
    if (!d.custId) { notTied++; continue; }
    if (e >= x.today) continue; // not ended yet
    const after = (visits.get(d.custId) ?? []).filter((v) => v.serviceDate > e).sort((p, q) => p.serviceDate.localeCompare(q.serviceDate));
    if (!after.length) continue;
    const cur = byC.get(d.custId);
    if (!cur || e > cur.end) byC.set(d.custId, { c: snap.custById.get(d.custId), paper: d, end: e, after });
  }
  const rowsC = [...byC.values()].sort((p, q) => String(p.c?.name).localeCompare(String(q.c?.name)));
  return { rows: rowsC, pop: xs.length, noEnd, notTied };
}

function sayAfter(res, plan, { snap }) {
  const out = { text: '', facts: [], records: [], basis: '', total: 0, claimedCount: null };
  const n = res.rows.length;
  if (plan.subject === 'unit') {
    out.basis = `Compared each unit's warranty end date (as the warranty record states it) with the service dates of the papers tied to that unit; ${fmtInt(res.unknown)} units with no warranty end date on file are left out.`;
    out.facts = [{ label: 'Units', value: fmtInt(n) }];
    if (!n) { out.text = `None of the ${fmtInt(res.pop)} units with a warranty end date was serviced after that date.`; out.claimedCount = 0; return out; }
    if (plan.kind === 'count') out.text = `${fmtInt(n)} of ${fmtInt(res.pop)} units with a warranty end date ${n === 1 ? 'was' : 'were'} serviced after the warranty ended.`;
    else {
      const lines = res.rows.slice(0, 40).map((r) => `${[r.u.serial, r.u.brand].filter(Boolean).join(' ') || 'unit'}${r.u.custName ? ` (${r.u.custName})` : ''}: warranty ended ${fmtDate(r.end)}, ${fmtInt(r.after.length)} ${r.after.length === 1 ? 'visit' : 'visits'} after, first ${fmtDate(r.after[0].serviceDate)}`);
      out.text = `${fmtInt(n)} of ${fmtInt(res.pop)} units with a warranty end date ${n === 1 ? 'was' : 'were'} serviced after the warranty ended: ${lines.join('; ')}${n > 40 ? `; and ${fmtInt(n - 40)} more` : ''}.`;
    }
    out.records = res.rows.slice(0, 200).map((r) => recordFor({ entity: 'unit' }, r.u, snap)); out.total = n;
    return out;
  }
  const w = String(plan.word ?? documentTypeLabel(plan.via) ?? plan.via).toLowerCase().replace(/s$/, '');
  out.basis = `Took each person's ${w} whose end date, as the paper states it, is before today, and looked for later papers of other kinds for the same person that carry a service date; ${fmtInt(res.noEnd)} ${plural(w)} state no end date and ${fmtInt(res.notTied)} ended ${res.notTied === 1 ? 'one is' : 'ones are'} not tied to one person, and are left out.`;
  out.facts = [{ label: 'Customers', value: fmtInt(n) }];
  if (!n) { out.text = `No one on file was serviced after their ${w} ended.`; out.claimedCount = 0; return out; }
  if (plan.kind === 'count') out.text = `${fmtInt(n)} ${n === 1 ? 'customer was' : 'customers were'} serviced after their ${w} ended.`;
  else {
    const lines = res.rows.slice(0, 40).map((r) => `${r.c?.name ?? 'unnamed'}: ${w} ended ${fmtDate(r.end)}, ${fmtInt(r.after.length)} ${r.after.length === 1 ? 'visit' : 'visits'} after, first ${fmtDate(r.after[0].serviceDate)}`);
    out.text = `${fmtInt(n)} ${n === 1 ? 'customer was' : 'customers were'} serviced after their ${w} ended: ${lines.join('; ')}${n > 40 ? `; and ${fmtInt(n - 40)} more` : ''}.`;
  }
  out.records = res.rows.slice(0, 200).map((r) => recordFor({ entity: 'customer' }, r.c, snap)); out.total = n;
  return out;
}

/* ====================================================================== exec: people a member of staff has seen more than once */

function execRepeat(plan, x) {
  const { snap } = x;
  const techs = new Set(snap.documents.map((d) => lc(d.tech)).filter(Boolean));
  if (!techs.has(lc(plan.tech))) return { abstain: 'tech-not-on-file' };
  const per = new Map(); let notTied = 0;
  for (const d of snap.documents) {
    if (lc(d.tech) !== lc(plan.tech)) continue;
    if (!d.custId) { notTied++; continue; }
    if (!per.has(d.custId)) per.set(d.custId, []);
    per.get(d.custId).push(d);
  }
  const rows = [...per.entries()].filter(([, ds]) => ds.length >= plan.min).map(([cid, ds]) => ({ c: snap.custById.get(cid), docs: ds }))
    .sort((p, q) => q.docs.length - p.docs.length || String(p.c?.name).localeCompare(String(q.c?.name)));
  return { rows, seen: per.size, notTied };
}

function sayRepeat(res, plan, { snap }) {
  const out = { text: '', facts: [], records: [], basis: '', total: 0, claimedCount: null };
  const n = res.rows.length;
  const minTxt = plan.min === 2 ? 'more than once' : `${fmtInt(plan.min)} or more times`;
  out.basis = `Counted the papers that name ${plan.tech} as the technician, per customer on file (a paper counts once, whatever its kind); ${fmtInt(res.notTied)} such ${res.notTied === 1 ? 'paper is' : 'papers are'} not tied to one customer and left out.`;
  out.facts = [{ label: 'Customers', value: fmtInt(n) }];
  if (!n) { out.text = `${plan.tech} has not seen any of the ${fmtInt(res.seen)} customers on their papers ${minTxt}.`; out.claimedCount = 0; return out; }
  if (plan.kind === 'count') out.text = `${fmtInt(n)} of the ${fmtInt(res.seen)} customers ${plan.tech} appears with ${n === 1 ? 'has' : 'have'} ${plan.tech} named on ${minTxt === 'more than once' ? 'more than one paper' : `${fmtInt(plan.min)} or more papers`}.`;
  else {
    const lines = res.rows.slice(0, 40).map((r) => `${r.c?.name ?? 'unnamed'} (${fmtInt(r.docs.length)} papers)`);
    out.text = `${fmtInt(n)} of the ${fmtInt(res.seen)} customers ${plan.tech} appears with ${n === 1 ? 'has' : 'have'} ${plan.tech} named on ${minTxt === 'more than once' ? 'more than one paper' : `${fmtInt(plan.min)} or more papers`}: ${lines.join('; ')}${n > 40 ? `; and ${fmtInt(n - 40)} more` : ''}.`;
  }
  out.records = res.rows.slice(0, 200).map((r) => recordFor({ entity: 'customer' }, r.c, snap)); out.total = n;
  return out;
}

/* ====================================================================== exec: which job is a paper for */

const alnumKey = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
function execJob(plan, x) {
  const { snap } = x;
  const ix = linkIndex(snap);
  const key = alnumKey(plan.number);
  const hits = snap.documents.filter((d) => [d.f?.invoice_number, d.f?.po_number, d.f?.permit_number].some((v) => v && alnumKey(v) === key));
  if (!hits.length) return { abstain: 'number-not-on-file' };
  if (hits.length > 1) return { abstain: 'number-on-two-papers' };
  const d = hits[0];
  const k = ix.jobKey.get(d.id) ?? null;
  let sibs;
  if (k) sibs = snap.documents.filter((o) => ix.jobKey.get(o.id) === k);
  else if (d.custId) sibs = snap.documents.filter((o) => o.custId === d.custId);
  else return { d, k: null, sibs: [] };
  const byType = new Map();
  for (const o of sibs) byType.set(o.type, (byType.get(o.type) ?? 0) + 1);
  return { d, k, sibs, byType, cust: d.custId ? snap.custById.get(d.custId) : null };
}

function sayJob(res, plan, { snap }) {
  const out = { text: '', facts: [], records: [], basis: '', total: 0, claimedCount: null };
  const d = res.d; const id = docLabel(d);
  if (!res.sibs.length) { out.text = `${id} carries no job key and is not tied to one customer on file, so I cannot say which job it was for.`; out.basis = 'Looked for a job key printed on the paper, then for the one customer record linked to it; it has neither.'; return out; }
  const counts = [...res.byType.entries()].sort((p, q) => q[1] - p[1] || String(p[0]).localeCompare(String(q[0]))).map(([t, n]) => `${fmtInt(n)} ${String(documentTypeLabel(t) && documentTypeLabel(t) !== 'Other' ? documentTypeLabel(t) : t.replace(/-/g, ' ')).toLowerCase()}${n === 1 ? '' : 's'}`);
  const who = res.cust ? ` for ${res.cust.name}${res.cust.address ? ` (${res.cust.address})` : ''}` : '';
  if (res.k) out.text = `${id} is part of job ${res.k}${who}. ${fmtInt(res.sibs.length)} papers share that job key: ${counts.join(', ')}.`;
  else out.text = `${id} carries no job key; it is tied to ${res.cust.name}${res.cust.address ? ` (${res.cust.address})` : ''}, who has ${fmtInt(res.sibs.length)} papers on file: ${counts.join(', ')}.`;
  out.basis = res.k ? 'Read the job key printed on the paper and collected every paper that carries the same key.' : 'The paper carries no job key, so it is tied by the one customer record linked to it; every paper of that customer is counted.';
  out.facts = [{ label: 'Papers on the job', value: fmtInt(res.sibs.length) }];
  out.records = [d, ...res.sibs.filter((o) => o.id !== d.id)].slice(0, 200).map((o) => recordFor({ entity: 'document' }, o, snap)); out.total = res.sibs.length;
  return out;
}

/* ====================================================================== exec: address */

function execAddress(plan, x) {
  const { snap } = x;
  const custs = snap.customers.filter((c) => c.address && streetKey(c.address) === plan.key);
  if (!custs.length) return { abstain: 'address-not-on-file' };
  const ids = new Set(custs.map((c) => c.id));
  const docs = snap.documents.filter((d) => d.custId && ids.has(d.custId) && d.date);
  const hasUnit = custs.map((c) => /\b(?:apt|apartment|unit|suite|ste|#)/i.test(String(c.address).split(',').slice(1, 2).join(' ')));
  return { custs, docs, hasUnit };
}

function sayAddress(res, plan, { snap }) {
  const out = { text: '', facts: [], records: [], basis: '', total: 0, claimedCount: null };
  const street = plan.display;
  const stat = (c) => snap.stats?.get(c.id);
  if (plan.mode === 'people') {
    const n = res.custs.length;
    out.basis = `Matched the street address (house number and street, ignoring the unit) against the address on every customer record on file.`;
    out.records = res.custs.map((c) => recordFor({ entity: 'customer' }, c, snap)); out.total = n; out.claimedCount = n;
    out.facts = [{ label: 'At this address', value: fmtInt(n) }];
    if (n === 1) { out.text = `Only ${res.custs[0].name} is on file at ${street}; there is no one else at that address.`; return out; }
    const lines = res.custs.map((c) => { const unit = String(c.address).split(',').slice(1, 2).join('').trim(); const nd = stat(c)?.docs.length ?? 0; return `${c.name}${/\b(?:apt|apartment|unit|suite|ste|#)/i.test(unit) ? ` (${unit})` : ''} - ${fmtInt(nd)} ${nd === 1 ? 'paper' : 'papers'}`; });
    out.text = `${fmtInt(n)} customers are on file at ${street}: ${lines.join('; ')}.`;
    return out;
  }
  const docs = res.docs.filter((d) => plan.year == null || d.date.slice(0, 4) === String(plan.year));
  docs.sort((p, q) => p.date.localeCompare(q.date) || String(p.id).localeCompare(String(q.id)));
  const when = plan.year ? ` in ${plan.year}` : '';
  out.basis = `Took every customer record whose street address is ${street} (ignoring the unit) and listed their papers by date${plan.year ? `, ${plan.year} only` : ''}; the date is the service date, else the invoice date, else the day it was filed.`;
  out.facts = [{ label: 'Papers', value: fmtInt(docs.length) }];
  if (!docs.length) { out.text = `Nothing is on file at ${street}${when}.`; out.claimedCount = 0; return out; }
  const cut = 40;
  const lines = docs.slice(0, cut).map((d) => {
    const tl = documentTypeLabel(d.type); const bits = [tl && !(tl === 'Other' && d.type !== 'other') ? tl : d.type.replace(/-/g, ' '), docLabel(d), res.custs.length > 1 ? d.custName : null, d.tech ? `by ${d.tech}` : null, d.status, d.total != null ? usd(d.total) : null].filter(Boolean);
    return `${fmtDate(d.date)}: ${bits.join(', ')}`;
  });
  out.text = `${fmtInt(docs.length)} ${docs.length === 1 ? 'paper' : 'papers'} at ${street}${when}, oldest first: ${lines.join('; ')}${docs.length > cut ? `; and ${fmtInt(docs.length - cut)} more` : ''}.`;
  out.records = docs.slice(0, 200).map((d) => recordFor({ entity: 'document' }, d, snap)); out.total = docs.length;
  return out;
}

/* ====================================================================== registration */

function exec(plan, x) {
  switch (plan.op) {
    case 'link_chain': return execChain(plan, x);
    case 'link_seq': return execSeq(plan, x);
    case 'link_ending': return execEnding(plan, x);
    case 'link_address': return execAddress(plan, x);
    case 'link_after': return execAfter(plan, x);
    case 'link_repeat': return execRepeat(plan, x);
    case 'link_job': return execJob(plan, x);
    default: return { abstain: 'op' };
  }
}
function say(res, plan, x) {
  switch (plan.op) {
    case 'link_chain': return sayChain(res, plan, x);
    case 'link_seq': return saySeq(res, plan, x);
    case 'link_ending': return sayEnding(res, plan, x);
    case 'link_address': return sayAddress(res, plan, x);
    case 'link_after': return sayAfter(res, plan, x);
    case 'link_repeat': return sayRepeat(res, plan, x);
    case 'link_job': return sayJob(res, plan, x);
    default: return null;
  }
}

registerFamily({ id: 'links', ops: LINK_OPS, slots, detect, exec, say });
export { slots as linksSlots };
