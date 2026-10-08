/**
 * R41U E3: second-generation checks for the grounding gate (gate.js). PURE; no DB, no model.
 *
 *  - confusables (Cyrillic / Greek look-alikes folded to Latin) and mixed-script detection
 *  - number formats ("1800,00", "1 800,00")
 *  - quantity + noun / unit claims ("42 bags", "30 months", "10% after 5 days", "a dozen", "$412 per week", "the 15th")
 *  - status / negation / payment-method / descriptor / relative-date / quarter claims, held to a lexicon on the page or a dated field consistent with today
 *  - role binding of names and addresses to the label on their own page line ("Label: value" sections)
 *
 * gate.js owns the claim plumbing; it hands this module the few helpers it needs through initGate2().
 */
let D = null;
export const initGate2 = (deps) => { D = deps; };
let TODAY = null; // {y,m,d} or null, set by checkGrounding for the duration of one (synchronous) check
export const setToday = (t) => { TODAY = parseISO(t); };

/* ------------------------------------------------------------------ confusables */
const CONF = {
  // Cyrillic
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X', 'У': 'Y', 'І': 'I', 'Ј': 'J', 'Ѕ': 'S', 'Ү': 'Y',
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x', 'у': 'y', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'һ': 'h', 'ԛ': 'q', 'ԝ': 'w', 'ӏ': 'l', 'ɡ': 'g',
  // Greek
  'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X',
  'ο': 'o', 'ν': 'v', 'ι': 'i', 'κ': 'k', 'ρ': 'p', 'υ': 'u', 'α': 'a', 'τ': 't',
};
const CONF_RE = new RegExp(`[${Object.keys(CONF).join('')}]`, 'g');
export const foldConfusables = (s) => (/[Ͱ-ϿЀ-ӿ]/.test(s) ? s.replace(CONF_RE, (c) => CONF[c]) : s);
/** a word that mixes Latin letters with Cyrillic / Greek ones: a look-alike spelling of a Latin word */
export function hasMixedScript(s) {
  const t = String(s ?? '');
  if (!/[Ͱ-ϿЀ-ӿ]/.test(t)) return false;
  for (const w of t.match(/[\p{L}\p{M}]+/gu) ?? []) if (/[A-Za-z]/.test(w) && /[Ͱ-ϿЀ-ӿ]/.test(w)) return true;
  return false;
}

/* ------------------------------------------------------------------ number formats */
/** "1800,00" and "1 800,00" (decimal comma) -> "1800.00". Dot-grouped European amounts ("1.800,00") stay as they are (they are refused as unparsed). */
export const foldNumFormat = (s) => (typeof s === 'string' && /\d,\d{2}(?!\d)/.test(s)
  ? s.replace(/(?<![\w.,])(\d{1,3}(?:[  ]\d{3})+|\d+),(\d{2})(?!\d)/g, (m, a, b) => `${a.replace(/[\s  ]/g, '')}.${b}`)
  : s);

/* ------------------------------------------------------------------ dates */
function parseISO(t) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(t ?? '')); return m ? { y: +m[1], m: +m[2], d: +m[3] } : null; }
const toUTC = (p) => Date.UTC(p.y, p.m - 1, p.d);
const fromUTC = (ms) => { const x = new Date(ms); return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate() }; };
const addDays = (p, n) => fromUTC(toUTC(p) + n * 86400000);
const cmpD = (a, b) => toUTC(a) - toUTC(b);
const sameD = (a, b) => a.y === b.y && a.m === b.m && a.d === b.d;
const WD = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const addMonths = (p, n) => { const t = p.y * 12 + (p.m - 1) + n; const y = Math.floor(t / 12); const m = (t % 12) + 1; const dim = new Date(Date.UTC(y, m, 0)).getUTCDate(); return { y, m, d: Math.min(p.d, dim) }; };
const pageDatesRaw = (h) => {
  const out = [];
  String(h ?? '').split('\n').forEach((ln, i) => { for (const s of D.dateCandidates(ln)) { const p = D.parseDate(s); if (p?.y && p.m && p.d) out.push({ ...p, i, ln }); } });
  return out;
};
const memo1 = (fn) => { const m = new Map(); return (h) => { let v = m.get(h); if (v === undefined) { v = fn(h); if (m.size > 200) m.clear(); m.set(h, v); } return v; }; };
export const pageDates = memo1(pageDatesRaw);
const hasDate = (h, pred) => pageDates(h).some(pred);

/* ------------------------------------------------------------------ units */
const FAM_TABLE = {
  day: 'day', d: 'day', daily: 'day', week: 'week', wk: 'week', wks: 'week', weekly: 'week', month: 'month', mo: 'month', mos: 'month', monthly: 'month', year: 'year', yr: 'year', yrs: 'year', yearly: 'year', annual: 'year', annually: 'year',
  hour: 'hour', hr: 'hour', hrs: 'hour', hourly: 'hour', minute: 'minute', min: 'minute', mins: 'minute', '%': 'pct', percent: 'pct', pct: 'pct',
  lb: 'lb', pound: 'lb', oz: 'oz', ounce: 'oz', kg: 'kg', kilogram: 'kg', ct: 'count', count: 'count', pc: 'piece', pcs: 'piece', piece: 'piece', ea: 'each', each: 'each', qt: 'quart', quart: 'quart',
  gal: 'gallon', gallon: 'gallon', ft: 'foot', foot: 'foot', feet: 'foot', in: 'inch', inch: 'inch', amp: 'amp', br: 'bedroom', bd: 'bedroom',
};
const TIME_FAMS = new Set(['day', 'week', 'month', 'year', 'hour', 'minute']);
const GENERIC_FAMS = new Set(['each', 'unit', 'item', 'piece', 'one', 'ea', 'person', 'count']);
export function fam(w) {
  const x = String(w).toLowerCase();
  if (FAM_TABLE[x]) return FAM_TABLE[x];
  let s = x;
  if (/ies$/.test(s)) s = `${s.slice(0, -3)}y`; else if (/(?:ch|sh|x|ss|z)es$/.test(s)) s = s.slice(0, -2); else if (/[^su]s$/.test(s)) s = s.slice(0, -1);
  return FAM_TABLE[s] ?? s;
}
const hasFam = (ln, f) => (f === 'pct' ? /%|\bpercent\b/i.test(ln) : (String(ln).match(/[A-Za-z]+/g) ?? []).some((w) => fam(w) === f));
const SKIPW = new Set(`of to and or a an the in on at by is was are were for with from per through until till than as that this which who whom whose has have had will would be been being it its if not no yes also then only about around over under between within without after before during since while when where what how nor but so
  more less much most many some any all each every both other another such same next last previous this these those there here out up down off just still even again already ago early late due plus minus x
  january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec monday tuesday wednesday thursday friday saturday sunday am pm
  total totals subtotal price cost amount balance rate fee fees charge charges tax taxes number no id page dollar dollars cent cents buck bucks usd eur euro euros gbp cad peso pesos mxn aud percent million billion thousand grand k m mm bn hundred`.split(/\s+/));

/* ------------------------------------------------------------------ number words */
const NUM_UNITS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const NUM_TENS = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const NW = '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fourty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)';
function wordsVal(phrase) {
  let total = 0; let cur = 0; let seen = false;
  for (const t of String(phrase).toLowerCase().split(/[\s-]+/).filter((x) => x && x !== 'and')) {
    if (t in NUM_UNITS) { cur += NUM_UNITS[t]; seen = true; } else if (t in NUM_TENS) { cur += NUM_TENS[t]; seen = true; } else if (t === 'hundred') { cur = (cur || 1) * 100; seen = true; } else if (t === 'thousand') { total += (cur || 1) * 1000; cur = 0; seen = true; } else return null;
  }
  return seen ? total + cur : null;
}
const LABEL_NOUN_BEFORE = /\b(?:item|option|line|page|section|unit|step|part|row|figure|table|plan|tier|package|phase|bid|building|bldg|room|suite|apt|lot|space|bay|slip|badge|case|claim|order|ticket|invoice|number|no|q|chapter|version|rev|zone|floor|co|po|inv)\.?\s*#?\s*$/i;
const QTYN_RE = new RegExp(`(?<![\\w#$/.,:-])(?:((?:half\\s+a|a|an|one|two|three|four|five|six|seven|eight|nine|ten|\\d+)\\s+dozen)|(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)|(${NW}(?:[\\s-]+(?:and[\\s-]+)?${NW})*))(?:\\s*-\\s*|\\s+)([A-Za-z][A-Za-z]*)\\b`, 'gi');
const DOZ = { 'half a': 6, a: 12, an: 12, one: 12, two: 24, three: 36, four: 48, five: 60, six: 72, seven: 84, eight: 96, nine: 108, ten: 120 };

/* ------------------------------------------------------------------ the extra claims */
const RATE_NOUNS = new Set('case bag box pound unit item piece visit session night person head sheet roll gallon foot yard square pallet carton crate pair dozen hour day week month year quarter mile lb kg mo yr hr'.split(' '));
const STATUS_WORDS = [
  ['approved', /\bapprov(?:ed|al)\b/], ['denied', /\b(?:denied|rejected|declined)\b/], ['terminated', /\bterminat(?:ed|ion)\b/], ['cancelled', /\bcancel+ed\b/], ['voided', /\bvoid(?:ed)?\b/],
  ['revoked', /\brevoked\b/], ['suspended', /\bsuspended\b/], ['pending', /\bpending\b/], ['renewed', /\brenewed\b/], ['final', /\bfinal(?:ized)?\b/],
];
const STATUS_PHRASE = new RegExp(`\\b(?:is|was|are|were|been|has been|have been|now|marked|status(?: is)?|remains?|got|gets)\\s+(?:also\\s+|currently\\s+|officially\\s+|already\\s+)?(approved|denied|rejected|declined|terminated|cancel+ed|voided?|revoked|suspended|pending|renewed|final(?:ized)?)\\b|\\b(approved|denied|rejected|terminated|cancel+ed|voided|revoked|suspended|finalized)\\b`, 'gi');
const DESC_GROUPS = [
  ['planetary', 'spiral'], ['residential', 'commercial', 'industrial'], ['single-phase', 'three-phase', 'split-phase'], ['refurbished', 'reconditioned', 'used'],
  ['stainless', 'copper', 'aluminum', 'galvanized', 'brass'], ['tankless', 'tank'], ['indoor', 'outdoor'], ['wholesale', 'retail'], ['gas-fired', 'electric'], ['manual', 'automatic'],
];
const DESC_RE = new RegExp(`(?<![\\w-])(visa|master[- ]?card|american\\s+express|amex|discover|planetary|spiral|residential|commercial|industrial|single[- ]phase|three[- ]phase|3[- ]phase|split[- ]phase|refurbished|reconditioned|stainless|copper|aluminum|galvanized|tankless|indoor|outdoor|wholesale|retail|gas[- ]fired)(?![\\w-])`, 'gi');
const NEG_META = new Set('other others more further additional match matches result results record records document documents information info data mention mentions answer answers issue issues problem problems error errors doubt doubts idea way need worry worries concern concerns difference differences change changes update updates'.split(' '));
const NEG_STOPV = new Set('is are was were will be been being has have had applies apply charged charge required needed due owed found given recorded listed noted included shown stated mentioned specified indicated on in at for to of that which and or but if as with'.split(' '));
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

export function extraClaims(text, { take, overlaps, claims, statusContext = false }) {
  const lower = text.toLowerCase();
  // "N-year-old"
  for (const m of text.matchAll(/(?<![\w#$/.-])(\d+(?:\.\d+)?)-(years?|months?|weeks?|days?)-old\b/gi)) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    take('qty', m[1], m.index, m.index + m[0].length, { value: D.canonNumber(m[1]), noun: null, unitRaw: m[2] });
  }
  // quantity + noun (open class)
  for (const m of text.matchAll(QTYN_RE)) {
    const end = m.index + m[0].length;
    const unit = m[4]; if (!/^[a-z]/.test(unit) || SKIPW.has(unit.toLowerCase()) || unit.length < 2) continue;
    if (LABEL_NOUN_BEFORE.test(text.slice(Math.max(0, m.index - 14), m.index))) continue; // "Item 2 total", "Option 3 price", "Page 2 of 5"
    let val;
    if (m[1]) { const parts = /^(half\s+a|a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+dozen$/i.exec(m[1].replace(/\s+/g, ' ')); const k = parts[1].toLowerCase().replace(/\s+/g, ' '); val = /^\d+$/.test(k) ? Number(k) * 12 : DOZ[k]; }
    else if (m[2]) val = Number(m[2].replace(/,/g, ''));
    else { val = wordsVal(m[3]); if (val == null || /^one$/i.test(m[3].trim())) continue; }
    if (!Number.isFinite(val) || (val >= 1900 && val <= 2100 && !m[1])) continue;
    const numEnd = m.index + (m[1] ?? m[2] ?? m[3]).length;
    if (overlaps(m.index, numEnd)) continue;
    const per = /^\s*(?:per|a|an|\/|every)\s*([A-Za-z]+)\b/i.exec(text.slice(end, end + 20));
    const perF = per && (FAM_TABLE[per[1].toLowerCase()] || RATE_NOUNS.has(fam(per[1]))) ? fam(per[1]) : null;
    take('qtyn', perF ? `${m[0]} ${per[0].trim()}` : m[0], m.index, end + (perF ? per[0].length : 0), { value: D.canonNumber(val), unit, dozen: Boolean(m[1]), per: perF });
  }
  // an amount with a rate: "$412.00 per week", "$22.50 a case"
  for (const c of claims.slice()) {
    if (c.kind !== 'money' || c.loose) continue;
    const endC = c.start + c.raw.length; const rest = text.slice(endC, endC + 24);
    const r = /^\s*(per|a|an|\/|every)\s*([A-Za-z]+)\b/i.exec(rest);
    if (!r || !/^[a-z]/i.test(r[2])) continue;
    if (/^(?:a|an)$/i.test(r[1]) && !(FAM_TABLE[r[2].toLowerCase()] || RATE_NOUNS.has(fam(r[2])))) continue;
    if (SKIPW.has(r[2].toLowerCase()) && r[2].toLowerCase() !== 'each') continue;
    take('rate', `${c.raw} ${r[1]} ${r[2]}`, endC, endC + r[0].length, { value: c.value, unit: r[2] });
  }
  // "the 15th" (a day of the month with no month named)
  for (const m of text.matchAll(/(?<![\w#/.-])(?:the\s+)?(\d{1,2})(st|nd|rd|th)\b(?!\s+(?:of\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/gi)) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    const d = Number(m[1]); if (d < 1 || d > 31) continue;
    if (/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*$/i.test(text.slice(Math.max(0, m.index - 12), m.index))) continue;
    take('ordday', m[0], m.index, m.index + m[0].length, { value: String(d) });
  }
  // payment method: "paid in cash"
  for (const m of text.matchAll(/\bpaid(?:\s+in\s+full)?\s+(?:by|in|with|using|via)\s+(cash|check|cheque|credit\s+card|debit\s+card|card|ach|wire|zelle|venmo|visa|mastercard|amex)\b/gi)) {
    claims.push({ kind: 'status', raw: m[0], start: m.index, value: `by ${m[1].toLowerCase().replace(/\s+/g, ' ')}` });
  }
  // paid / unpaid / overdue / expired / active
  const stat = (key, re, extra = () => ({})) => { for (const m of lower.matchAll(re)) { if (key === 'overdue' && m[1]) { for (let i = claims.length - 1; i >= 0; i--) if ((claims[i].kind === 'qty' || claims[i].kind === 'qtyn') && claims[i].start >= m.index && claims[i].start < m.index + m[0].length) claims.splice(i, 1); claims.push({ kind: 'stat', raw: m[0], start: m.index, key, ...extra(m) }); continue; } if (overlaps(m.index, m.index + m[0].length)) continue; take('stat', m[0], m.index, m.index + m[0].length, { key, ...extra(m) }); } };
  stat('unpaid', /\b(?:(?:has|have|had|is|was|are)\s+not\s+(?:yet\s+)?(?:been\s+)?paid(?:\s+yet)?|(?:has|have)n't\s+(?:yet\s+)?been\s+paid|not\s+yet\s+paid|unpaid|non-?paid|(?:is\s+)?still\s+(?:owed|outstanding|unpaid)|unsettled|remains\s+(?:unpaid|outstanding))\b/g);
  stat('overdue', /\b(?:(\d+|[a-z]+(?:-[a-z]+)?)\s+days?\s+(?:overdue|late|past\s+due)|overdue|past\s+due|delinquent)\b/g, (m) => ({ days: m[1] && /^\d+$/.test(m[1]) ? Number(m[1]) : m[1] ? wordsVal(m[1]) : null }));
  stat('paid', /\b(?:(?:is|was|been|has\s+been|got|already)\s+(?:already\s+|fully\s+|now\s+)?paid(?:\s+(?:off|up))?|paid\s+(?:off|up)|settled\s+in\s+full|has\s+been\s+settled)\b(?!\s+(?:by|in|with|using|via)\b)(?!\s+(?:on|at|upon)\s+(?:signing|completion|delivery|approval|acceptance|closing|execution|start)\b)/g);
  stat('expired', /\b(?:(?:has|have|had)\s+(?:already\s+)?(?:expired|lapsed)|(?:is|are|was|were)\s+(?:already\s+|now\s+)?(?:expired|lapsed)|(?:already|now)\s+(?:expired|lapsed)|(?<!\bnot\s+(?:yet\s+)?)(?:expired|lapsed)|no\s+longer\s+(?:valid|active|in\s+force|in\s+effect))\b/g);
  stat('active', /\b(?:(?:is|are|remains?|still|currently)\s+(?:currently\s+|still\s+)?(?:active|valid|in\s+force|in\s+effect)|(?:has|have)\s+not\s+(?:yet\s+)?expired|not\s+(?:yet\s+)?expired)\b(?!\s+(?:for|until|through|thru|from|to|within|during)\b)/g);
  for (const m of text.matchAll(STATUS_PHRASE)) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    const w = (m[1] ?? m[2]).toLowerCase(); const ent = STATUS_WORDS.find(([, re]) => re.test(w)); if (!ent) continue;
    take('stat', m[0], m.index, m.index + m[0].length, { key: ent[0] });
  }
  if (statusContext) {
    const w = text.trim().toLowerCase().replace(/[.!]+$/, '');
    const key = { paid: 'paid', unpaid: 'unpaid', overdue: 'overdue', expired: 'expired', lapsed: 'expired', active: 'active', valid: 'active', 'past due': 'overdue', 'paid in full': 'paid' }[w] ?? STATUS_WORDS.find(([, re]) => re.test(w))?.[0];
    if (key && !claims.some((c) => c.kind === 'stat' || c.kind === 'status') && w.split(/\s+/).length <= 3) take('stat', text.trim(), 0, text.length, { key });
  }
  // negation: "no late charge", "no inspections are required", "without a deposit", "not required"
  for (const m of lower.matchAll(/\b(?:there\s+(?:is|are|was|were)\s+)?(?:no|without\s+(?:a|an|any)?|zero)\s+([a-z]+(?:\s+[a-z]+){0,2})/g)) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    const words = m[1].split(/\s+/); const cut = words.findIndex((w) => NEG_STOPV.has(w)); const np = (cut < 0 ? words : words.slice(0, cut)).filter(Boolean);
    if (!np.length || NEG_META.has(np[np.length - 1]) || NEG_META.has(np[0]) || /^(?:a|an|the|longer|one|other|doubt|matter)$/.test(np[0])) continue;
    if (/\bno\s+(?:longer|one|matter|problem|worries)\b/.test(m[0])) continue;
    take('neg', m[0], m.index, m.index + m[0].length, { head: np[np.length - 1], words: np });
  }
  for (const m of lower.matchAll(/\b([a-z]+(?:\s+[a-z]+){0,1})\s+(?:is|are|was|were)\s+(?:not\s+(?:required|needed|applicable|charged|due)|waived)\b/g)) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    const words = m[1].split(/\s+/).filter((w) => !NEG_STOPV.has(w) && !/^(?:the|a|an|it|this|that|there|which|they)$/.test(w)); if (!words.length || NEG_META.has(words[words.length - 1])) continue;
    take('neg', m[0], m.index, m.index + m[0].length, { head: words[words.length - 1], words });
  }
  // descriptors (a closed lexicon of mutually exclusive adjectives)
  for (const m of text.matchAll(DESC_RE)) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    take('desc', m[0], m.index, m.index + m[0].length, { value: m[1].toLowerCase().replace(/[ ]/g, '-').replace(/^3-phase$/, 'three-phase').replace(/^master-?card$/, 'mastercard').replace(/^american-express$/, 'amex') });
  }
  // quarters: "Q3", "third quarter 2026"
  for (const m of text.matchAll(/(?<![\w-])(?:q([1-4])|(first|second|third|fourth|1st|2nd|3rd|4th)\s+quarter)(?![\w-])(?:\s+(?:of\s+)?(20\d\d))?/gi)) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    const q = m[1] ? Number(m[1]) : { first: 1, second: 2, third: 3, fourth: 4, '1st': 1, '2nd': 2, '3rd': 3, '4th': 4 }[m[2].toLowerCase()];
    take('quarter', m[0], m.index, m.index + m[0].length, { value: String(q), year: m[3] ? Number(m[3]) : null });
  }
  // relative dates
  const rel = (re, fn) => { for (const m of lower.matchAll(re)) { if (overlaps(m.index, m.index + m[0].length)) continue; const r = fn(m); if (r) take('rel', m[0], m.index, m.index + m[0].length, { spec: r }); } };
  rel(/\b(tomorrow|yesterday)\b/g, (m) => ({ dates: [m[1] === 'tomorrow' ? 1 : -1] }));
  rel(/\b(next|last|this|coming|previous)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/g, (m) => ({ wd: WD.indexOf(m[2]), which: m[1] }));
  const dateCue = /\b(?:expir\w*|due|issued|dated|renew\w*|valid|effective|ends?|starts?|began|begin|scheduled|delivered|completed|installed|signed|lapsed|paid|inspect\w*|terminat\w*|cancel+ed|approved)\b/.test(lower);
  rel(/\b(next|last|this|previous|coming)\s+(week|month|year|quarter)\b/g, (m) => (dateCue ? { win: m[2], which: m[1] } : null));
  rel(/\b(\d{1,3}|[a-z]+(?:-[a-z]+)?)\s+(days?|weeks?|months?|years?)\s+(ago|from\s+now|from\s+today)\b/g, (m) => { const n = /^\d+$/.test(m[1]) ? Number(m[1]) : wordsVal(m[1]); return n == null ? null : { ago: m[3] === 'ago' ? -n : n, unit: m[2].replace(/s$/, '') }; });
  rel(/\bend\s+of\s+(?:the\s+)?(?:year\s+)?(20\d\d)\b/g, (m) => ({ eoy: Number(m[1]) }));
  rel(/\b(?:end\s+of\s+(?:this\s+|the\s+)year|year[- ]end)\b/g, () => ({ eoy: 0 }));
  rel(/\bend\s+of\s+(?:this\s+)?month\b/g, () => ({ eom: true }));
  void MONTHS;
}

/* ------------------------------------------------------------------ support */
function qtyUnitOk(h, value, unit, per = null) {
  const f = fam(unit);
  const lines = String(h).split('\n');
  const numRe = /(?<![\w#$/.,:-])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?![\d])/g;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]; numRe.lastIndex = 0; let m;
    while ((m = numRe.exec(ln))) {
      if (D.canonNumber(m[1]) !== value) continue;
      const rest = ln.slice(m.index + m[0].length);
      const nx = /^\s*-?\s*(%|[A-Za-z]+)/.exec(rest);
      if (nx) { if (fam(nx[1]) === f) { if (!per || hasFam(ln, per)) return true; continue; } if (!SKIPW.has(nx[1].toLowerCase())) continue; }
      if (f === 'day' && /\bnet\s*-?\s*$/i.test(ln.slice(0, m.index))) return true;
      if (hasFam(ln, f) || (i > 0 && !/\d/.test(lines[i - 1]) && hasFam(lines[i - 1], f))) return true;
      if (f === 'hour' && /labou?r|duration|service time|time on site/i.test(ln)) return true;
    }
  }
  return false;
}
function rateOk(h, value, unit) {
  const f = fam(unit);
  const lines = String(h).split('\n');
  let amountSeen = false;
  for (let i = 0; i < lines.length; i++) {
    if (!D.moneyNumbersIn(lines[i]).has(value)) continue;
    amountSeen = true;
    if (GENERIC_FAMS.has(f)) return true;
    const ctx = `${lines[i]}\n${i > 0 && !/\d/.test(lines[i - 1]) ? lines[i - 1] : ''}`;
    if (hasFam(ctx, f)) return true;
    if (TIME_FAMS.has(f)) {
      // an hourly rate on a line that prints a different explicit unit ("per mile", "per sq ft") is not an hourly rate
      const perUnits = [...lines[i].matchAll(/(?:\bper\b|\/)\s*([A-Za-z]+)/gi)].map((x) => fam(x[1]));
      if (f === 'hour' && !perUnits.length && /labou?r|rate|technician|service|diagnos|trip|overtime|detention|attorney|paralegal|consult|drop-?in|hourly/i.test(lines[i]) && ![...TIME_FAMS].some((t) => t !== 'hour' && hasFam(lines[i], t))) return true;
      continue;
    }
    if (f === 'month' && /\/\s?mo\b/i.test(lines[i])) return true;
  }
  void amountSeen;
  return false;
}
export const payEvidence = (h) => /paid\s+in\s+full|fully\s+paid|paid\s+off|status\s*:?\s*paid\b|payment\s+received|\bpaid\b\s*(?:by|on|via|with)\b|\b(?:amount\s+)?paid\s*:?\s*\$\s?(?!0(?:\.00)?(?![\d.,]))\d|balance[^\n]{0,24}\$\s?0(?:\.00)?(?![\d.,])|\bpaid\b(?!\s*:?\s*\$?\s?0(?:\.00)?(?![\d.,]))(?!\s*(?:to|from)\b)/i.test(h);
export const unpaidEvidence = (h) => /\bunpaid\b|\bnot\s+paid\b|\bpast\s+due\b|\boverdue\b|\boutstanding\b|\bdelinquent\b|\b(?:balance|amount)\s+due\s*:?\s*\$?\s?(?!0(?:\.00)?(?![\d.,]))\d/i.test(h);
const expiryDates = (h) => pageDates(h).filter((x) => /expir|valid\s+(?:to|until|through|thru)|good\s+through|end\s+date|lease\s+end|\bends?\b|terminat|through|until/i.test(x.ln));
const dueDates = (h) => pageDates(h).filter((x) => /\bdue\b|pay\s+by/i.test(x.ln));
const monthsOf = (q) => [q * 3 - 2, q * 3 - 1, q * 3];
function relDates(spec) {
  if (!TODAY) return null;
  if (spec.dates) return { dates: spec.dates.map((n) => addDays(TODAY, n)) };
  if (spec.wd != null) {
    const delta = (spec.wd - new Date(toUTC(TODAY)).getUTCDay() + 7) % 7;
    const up = addDays(TODAY, delta === 0 && spec.which !== 'this' ? 7 : delta); const down = addDays(TODAY, -(((new Date(toUTC(TODAY)).getUTCDay() - spec.wd + 7) % 7) || 7));
    if (spec.which === 'last' || spec.which === 'previous') return { dates: [down, addDays(down, -7)] };
    if (spec.which === 'next') { const mon = addDays(TODAY, -((new Date(toUTC(TODAY)).getUTCDay() + 6) % 7)); return { dates: [cmpD(up, addDays(mon, 6)) <= 0 ? addDays(up, 7) : up] }; }
    return { dates: [up] };
  }
  if (spec.win) {
    const w = spec.which; const sgn = w === 'last' || w === 'previous' ? -1 : w === 'this' ? 0 : 1;
    if (spec.win === 'week') { const mon = addDays(TODAY, -((new Date(toUTC(TODAY)).getUTCDay() + 6) % 7)); const from = addDays(mon, 7 * sgn); return { from: sgn === -1 ? addDays(from, -7) : from, to: sgn === 1 ? addDays(from, 13) : addDays(from, 6) }; }
    if (spec.win === 'month') { const a = addMonths({ ...TODAY, d: 1 }, sgn); return { from: a, to: addDays(addMonths(a, 1), -1) }; }
    if (spec.win === 'year') { const y = TODAY.y + sgn; return { from: { y, m: 1, d: 1 }, to: { y, m: 12, d: 31 } }; }
    if (spec.win === 'quarter') { const q = Math.floor((TODAY.m - 1) / 3) + 1 + sgn; const y = TODAY.y + Math.floor((q - 1) / 4); const qq = ((q - 1 + 4) % 4) + 1; return { from: { y, m: qq * 3 - 2, d: 1 }, to: addDays({ y, m: qq * 3 + 1 > 12 ? 1 : qq * 3 + 1, d: 1 }, -1) }; }
  }
  if (spec.ago != null) {
    const base = spec.unit === 'day' ? addDays(TODAY, spec.ago) : spec.unit === 'week' ? addDays(TODAY, 7 * spec.ago) : spec.unit === 'month' ? addMonths(TODAY, spec.ago) : addMonths(TODAY, 12 * spec.ago);
    return { dates: [base] };
  }
  if (spec.eoy != null) return { dates: [{ y: spec.eoy || TODAY.y, m: 12, d: 31 }] };
  if (spec.eom) return { dates: [addDays(addMonths({ ...TODAY, d: 1 }, 1), -1)] };
  return null;
}
const negMark = /\b(?:no|none|n\/a|nil|waived|not\s+(?:required|applicable|charged|due)|not\s+applicable|zero)\b|\$\s?0(?:\.00)?(?![\d.,])|:\s*0(?:\.00)?\s*$/i;
const stem5 = (w) => String(w).toLowerCase().replace(/(?:ies|es|s)$/, '').slice(0, 5);
const METHOD = { cash: /\bcash\b/i, check: /\b(?:check|cheque)\b/i, card: /\b(?:card|visa|mastercard|master card|amex|american express|discover|debit|credit)\b/i, 'credit card': /\b(?:credit|visa|mastercard|master card|amex|american express|discover)\b/i, 'debit card': /\bdebit\b/i, ach: /\bach\b/i, wire: /\bwire\b/i, zelle: /\bzelle\b/i, venmo: /\bvenmo\b/i, visa: /\bvisa\b/i, mastercard: /\bmaster\s?card\b/i, amex: /\b(?:amex|american express)\b/i };
export const methodOk = (h, value) => { const k = String(value).replace(/^by /, ''); return (METHOD[k] ?? new RegExp(`\\b${k}\\b`, 'i')).test(h); };

export function supportedExtra(c, h) {
  switch (c.kind) {
    case 'qtyn': return qtyUnitOk(h, c.value, c.unit, c.per);
    case 'rate': return rateOk(h, c.value, c.unit);
    case 'ordday': {
      const d = Number(c.value);
      return hasDate(h, (x) => x.d === d) || new RegExp(`(?<![\\d/])0?${d}(?:st|nd|rd|th)\\b`, 'i').test(h) || new RegExp(`\\b${Object.entries({ 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', 5: 'fifth', 6: 'sixth', 7: 'seventh', 8: 'eighth', 9: 'ninth', 10: 'tenth', 15: 'fifteenth', 20: 'twentieth', 25: 'twenty-fifth', 30: 'thirtieth' }).find(([k]) => Number(k) === d)?.[1] ?? 'zzzz'}\\b`, 'i').test(h);
    }
    case 'stat': {
      switch (c.key) {
        case 'paid': return payEvidence(h) && !/\bunpaid\b|\bnot\s+paid\b/i.test(h);
        case 'unpaid': return unpaidEvidence(h) && !payEvidence(h);
        case 'overdue': {
          if (c.days != null) { if (new RegExp(`\\b${c.days}\\s+days?\\s+(?:overdue|late|past\\s+due)`, 'i').test(h)) return true; if (!TODAY || payEvidence(h)) return false; return dueDates(h).some((x) => Math.round((toUTC(TODAY) - toUTC(x)) / 86400000) === c.days); }
          if (/\boverdue\b|\bpast\s+due\b|\bdelinquent\b/i.test(h)) return true;
          return Boolean(TODAY) && !payEvidence(h) && dueDates(h).some((x) => cmpD(x, TODAY) < 0);
        }
        case 'expired': return /\bexpired\b|\blapsed\b/i.test(h) || (Boolean(TODAY) && expiryDates(h).some((x) => cmpD(x, TODAY) < 0));
        case 'active': return /\bactive\b|\bin\s+force\b|\bin\s+effect\b/i.test(h) || (Boolean(TODAY) && expiryDates(h).some((x) => cmpD(x, TODAY) >= 0));
        default: { const ent = STATUS_WORDS.find(([k]) => k === c.key); return ent ? ent[1].test(h.toLowerCase()) || (c.key === 'cancelled' && /\bcancel/i.test(h)) : false; }
      }
    }
    case 'neg': {
      const st = stem5(c.head); if (st.length < 3) return false;
      const lines = String(h).split('\n');
      return lines.some((ln, i) => new RegExp(`\\b${st.replace(/[^a-z0-9]/g, '')}`, 'i').test(ln) && negMark.test(`${ln}\n${/:\s*$/.test(ln) ? (lines[i + 1] ?? '') : ''}`));
    }
    case 'desc': { const v = c.value; const re = v === 'mastercard' ? /\bmaster[- ]?card\b/i : v === 'amex' ? /\b(?:amex|american express)\b/i : new RegExp(`(?<![\\w-])${v.replace(/-/g, '[- ]')}(?![\\w-])`, 'i'); return re.test(h); }
    case 'quarter': { const q = Number(c.value); return hasDate(h, (x) => monthsOf(q).includes(x.m) && (!c.year || x.y === c.year)); }
    case 'rel': {
      const r = relDates(c.spec); if (!r) return false;
      if (r.dates) return hasDate(h, (x) => r.dates.some((d) => sameD(d, x)));
      return hasDate(h, (x) => cmpD(x, r.from) >= 0 && cmpD(x, r.to) <= 0);
    }
    default: return true;
  }
}

/* ------------------------------------------------------------------ roles */
const TITLE = '(?:(?:mr|mrs|ms|miss|dr)\\.?\\s+)?';
export const ROLE_DEFS = [
  { key: 'holder', noun: 'certificate\\s+holder|holder', label: /certificate\s+holder|^\s*holder/i, strict: true },
  { key: 'shipto', noun: 'ship(?:ped|ping)?[- ]?to|deliver(?:y|ed)\\s+(?:was\\s+|is\\s+|went\\s+)?(?:made\\s+)?to|deliver(?:y|ed)(?:\\s+(?:contact|person|recipient))?|recipient|receiver|consignee', verbs: 'received|receives|accepted\\s+delivery|signed\\s+for', label: /ship|deliver|consign|recipient|receiv|job\s?site/i, strict: true },
  { key: 'doctor', noun: 'veterinarian|vet|doctor|dvm|physician|clinician', verbs: 'examined|treated|vaccinated|diagnosed|operated\\s+on', label: /veterinar|\bvet\b|doctor|\bdr\b|dvm|physician|provider|clinician|attending/i, strict: true },
  { key: 'patient', noun: 'patient|pet|animal', label: /patient|\bpet\b|animal/i, strict: true },
  { key: 'guarantor', noun: 'guarantor|co-?signer|cosigner|surety', label: /guarant|co-?sign|surety/i, strict: true },
  { key: 'inspector', noun: 'inspector', verbs: 'inspected', label: /inspector|inspected/i, strict: true },
  { key: 'agent', noun: 'agent|broker|producer|sales\\s?rep|sales\\s?person|salesman|representative|rep', label: /agent|broker|producer|\brep\b|representative|sales/i, strict: true },
  { key: 'insured', noun: 'named\\s+insured|insured|policy\\s?holder', label: /insured|policy\s?holder/i, strict: true },
  { key: 'technician', noun: 'technician|tech|installed\\s+by|serviced\\s+by|performed\\s+by|crew\\s+lead', old: true },
  { key: 'landlord', noun: 'landlord|lessor', old: true },
  { key: 'vendor', noun: 'vendor|supplier|seller', old: true },
  { key: 'customer', noun: 'customer|client|buyer|bill(?:ed)?\\s+to|bill\\s+goes\\s+to|invoice\\s+goes\\s+to|invoiced\\s+to|sold\\s+to|homeowner|payer|purchaser|owner|tenant|resident|lessee|renter|applicant|prepared\\s+for', verbs: 'ordered|purchased|bought|applied', old: true,
    label: /bill|customer|client|sold\s?to|buyer|payer|owner|tenant|resident|lessee|renter|applicant|insured|homeowner|prepared|attn|occupant/i, notLabel: /ship|deliver|job\s?site|site/i },
  { key: 'contact', noun: 'point\\s+of\\s+contact|contact|attn|attention', label: /contact|attn|attention/i, strict: true },
];
for (const r of ROLE_DEFS) {
  r.before = new RegExp(`\\b(?:${r.noun})\\b\\s*(?:is|was|are|were|=|:|-|,|as|being)?\\s*(?:the\\s+|a\\s+|an\\s+|our\\s+|his\\s+|her\\s+)?(?:named\\s+)?${TITLE}$`, 'i');
  r.after = new RegExp(`^\\s*(?:,\\s*)?(?:who\\s+)?(?:(?:is|was|are|were|as|being|signed\\s+as|acts\\s+as|serves\\s+as)\\s+(?:the\\s+|a\\s+|an\\s+|our\\s+|his\\s+|her\\s+)?(?:named\\s+)?(?:${r.noun})\\b${r.verbs ? `|\\s*(?:${r.verbs})\\b` : ''})`, 'i');
  if (!r.verbs) r.after = new RegExp(`^\\s*(?:,\\s*)?(?:who\\s+)?(?:is|was|are|were|as|being|signed\\s+as|acts\\s+as|serves\\s+as)\\s+(?:the\\s+|a\\s+|an\\s+|our\\s+|his\\s+|her\\s+)?(?:named\\s+)?(?:${r.noun})\\b`, 'i');
  r.labelNoun = new RegExp(`\\b(?:${r.noun})\\b`, 'i');
}
const ROLE_BY_KEY = Object.fromEntries(ROLE_DEFS.map((r) => [r.key, r]));
/** the role a name plays in this sentence: the closest role word before ("the guarantor is X", "Dr. X") or after ("X is the lessee", "X received") the name */
export function detectRole(text, start, end, titled) {
  const pre = text.slice(Math.max(0, start - 40), start).replace(/\s+$/, ' ').split(/[.;!?]\s/).pop();
  const post = text.slice(end, end + 50);
  let best = null;
  ROLE_DEFS.forEach((r, ord) => {
    let dist = null;
    const b = r.before.exec(pre); if (b) dist = pre.length - b.index;
    if (!b) { const a = r.after.exec(post); if (a) dist = a[0].length + 40; }
    if (dist != null && (!best || dist < best.dist)) best = { key: r.key, dist, ord };
  });
  return best?.key ?? null;
}
export const roleDefForLabel = (label) => { const l = String(label ?? ''); return ROLE_DEFS.find((r) => r.labelNoun.test(l)) ?? null; };

const LABEL_LINE = /^\s*([A-Za-z][A-Za-z0-9 /#.&()'_-]{0,34}?)\s*:\s*(.*)$/;
const LABEL_ONLY = /^\s*([A-Za-z][A-Za-z /#.&-]{1,28}?)\s*:?\s*$/;
const KNOWN_LABEL = new RegExp(`\\b(?:${ROLE_DEFS.map((r) => r.noun).join('|')}|bill\\s*to|ship\\s*to|sold\\s*to|attn|owner|insured|holder|applicant|lessee|tenant|customer|technician|vendor|patient)\\b`, 'i');
function sectionsRaw(h) {
  const lines = String(h ?? '').split('\n'); const secs = []; let last = null; let cont = 0;
  const push = (labels, text, top) => { const s = { labels, text, top }; secs.push(s); return s; };
  lines.forEach((ln0, i) => {
    let handled = false;
    for (const part of ln0.split(/\s{3,}|\t|\|/)) {
      const m = LABEL_LINE.exec(part);
      const lo = !m && LABEL_ONLY.exec(part);
      if (m && !/^\d+$/.test(m[1].trim())) {
        const lead = m[1].trim(); const segs = m[2].split(/,\s*(?=[A-Z][A-Za-z ]{1,24}:\s)/);
        segs.forEach((sg, k) => { const mm = k ? /^([A-Za-z][A-Za-z ]{1,24}):\s*(.*)$/.exec(sg) : null; last = push(mm ? `${lead} ${mm[1]}` : lead, mm ? mm[2] : sg, i < 3); });
        cont = 2; handled = true;
      } else if (lo && KNOWN_LABEL.test(lo[1]) && lo[1].split(/\s+/).length <= 4) { last = push(lo[1].trim(), '', i < 3); cont = 3; handled = true; }
    }
    if (!handled) {
      if (last && cont > 0 && ln0.trim() && !/\$/.test(ln0)) { last.text += `\n${ln0}`; cont--; } else { cont = 0; last = null; if (ln0.trim()) push('', ln0, i < 3); }
    }
  });
  return secs;
}
export const sectionsOf = memo1(sectionsRaw);
/** is this name on the page under a label that carries `key`'s role? */
export function nameRoleOk(c, h, key, supported) {
  const def = ROLE_BY_KEY[key]; if (!def) return true;
  if (!def.old) {
    if (sectionsOf(h).some((s) => def.label.test(s.labels) && supported(c, s.text))) return true;
    if (key === 'doctor') { const w = String(c.value).trim().split(/\s+/); const sur = w[w.length - 1].replace(/[^A-Za-z'-]/g, ''); if (sur && new RegExp(`\\bdr\\.?\\s+(?:[A-Za-z'.-]+\\s+){0,2}${sur.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(h)) return true; }
    return false;
  }
  if (key === 'customer') {
    const secs = sectionsOf(h).filter((s) => def.label.test(s.labels) && !def.notLabel.test(s.labels));
    if (secs.length) return secs.some((s) => supported(c, s.text));
  }
  return null; // the caller's established path (roleText) decides
}
const ADDR_ROLE = [
  ['shipto', /ship(?:ped|ping)?(?:\s+(?:to|address))?|deliver(?:ed|y)?(?:\s+(?:to|at|address))?|sent\s+to|job\s?site/gi, /ship|deliver|job\s?site|site|consign|recipient/i],
  ['billto', /bill(?:ed|ing)?(?:\s+(?:to|address))?|invoice[ds]?\s+to/gi, /bill|invoice\s?to|sold\s?to|payer|remit/i],
];
/** which address role the words before an address name (ship-to / bill-to), nearest wins */
export function addressRole(text, start) {
  const pre = text.slice(Math.max(0, start - 70), start).split(/[.;!?]\s/).pop();
  let best = null;
  for (const [key, re] of ADDR_ROLE) { for (const m of pre.matchAll(re)) { if (!best || m.index >= best.at) best = { key, at: m.index }; } }
  return best?.key ?? null;
}
export function addressRoleOk(c, h, supported) {
  const re = ADDR_ROLE.find(([k]) => k === c.arole)?.[2]; if (!re) return true;
  return sectionsOf(h).some((s) => re.test(s.labels) && supported(c, s.text));
}
