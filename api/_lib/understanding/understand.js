/**
 * R41U Part B - ONE shared, pure question-understanding step (no DB, no model).
 *
 * understandQuestion(question, {today, conversation, vocab}) reads a records question the way a person would and returns a structured reading that every lane
 * consumes instead of re-parsing the text on its own:
 *
 *   { kind, docKind, role, direction, filters:{amount, docNumber, name, address, dateWindow, status, order}, wants, corrections, strippedQuestionWords, notes, text }
 *
 * Rules (owner's):
 *  - Role words (customer, client, vendor, supplier, tenant, donor, adopter, volunteer, landlord) set the KIND of document and the DIRECTION
 *    (customer -> invoice we sent / money in; vendor, supplier -> bill we received / money out). They are NEVER part of a name.
 *  - Question words (wheres, whats, hows, show me, find me, who, which ...) are never part of a name.
 *  - A bare number is tried as an AMOUNT, then as a DOCUMENT NUMBER, and as an ADDRESS only when address words are present.
 *  - A typo of 1-2 letters in a known word ("invoces") is corrected with a visible note and never drops a filter.
 *  - Pronouns ("their", "that one") are resolved from the conversation; with none they are flagged, never guessed.
 *  - A date with no year ("before december 24") takes the nearest sensible year relative to `today`, and says which.
 *  - A name that matches nobody in `vocab.names` is reported as notes.unknownName so the lane can decline BY NAME.
 *
 * kind: invoice | bill | receipt | contract | permit | certificate | record | person | total | count | list | latest | biggest | overdue | unknown
 * (for total / count / list / latest / biggest / overdue the document type is in `docKind`).
 */

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MON_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const monthNo = (s) => MONTHS.findIndex((m) => m.startsWith(s.slice(0, 3))) + 1;
const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const parseYmd = (s) => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return { y, m, d }; };
const dayNum = (y, m, d) => Date.UTC(y, m - 1, d) / 86400000;
const addDays = (s, n) => { const { y, m, d } = parseYmd(s); const t = new Date(Date.UTC(y, m - 1, d + n)); return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); };

/** Words that open a question or ask it politely: never part of a name, never a filter. */
const QUESTION_PHRASES = [
  'show me', 'show', 'find me', 'find', 'pull up', 'look up', 'lookup', 'give me', 'get me', 'tell me', 'can you', 'could you', 'would you', 'will you', 'please', 'pls', 'kindly', 'i need', 'i want', 'i would like', 'id like', 'we need', 'let me see', 'i am looking for', 'im looking for', 'looking for', 'do you have', 'do we have', 'have we got', 'is there', 'are there', 'there is', 'what is', 'what are', 'what was', 'what were', 'where is', 'where are', 'where was',
  'wheres', 'whats', 'hows', 'whos', 'whose', 'whom', 'who', 'which', 'what', 'where', 'when', 'how much', 'how many', 'how', 'thanks', 'thank you', 'hey', 'hi', 'hello', 'donovan', 'quick question', 'real quick', 'if you dont mind', 'if you can', 'when you get a chance', 'thank you', 'appreciate it', 'sir', 'quickly', 'right now', 'asap', 'by any chance', 'could i', 'can i', 'may i', 'i would like to see', 'i d like', 'i want to see', 'for me', 'on file', 'on record', 'in the system', 'we have', 'we sent', 'we got',
];
const QUESTION_WORDS_SET = new Set(['wheres', 'whats', 'hows', 'whos', 'who', 'whose', 'whom', 'which', 'what', 'where', 'when', 'how', 'show', 'find', 'get', 'give', 'tell', 'please', 'pls', 'can', 'could', 'would', 'will', 'kindly', 'lookup', 'me', 'us', 'thanks', 'hey', 'hi', 'hello', 'donovan', 'need', 'want', 'see', 'look', 'pull', 'up']);
const ROLE_WORDS = { customer: 'customer', customers: 'customer', client: 'customer', clients: 'customer', vendor: 'vendor', vendors: 'vendor', supplier: 'supplier', suppliers: 'supplier', tenant: 'tenant', tenants: 'tenant', donor: 'donor', donors: 'donor', adopter: 'adopter', adopters: 'adopter', volunteer: 'volunteer', volunteers: 'volunteer', landlord: 'landlord', landlords: 'landlord' };
// R2: tenant / donor / adopter are the paying side (a document we sent them); a landlord is the side we pay (a bill we received). volunteer sets nothing.
const ROLE_DIRECTION = { customer: 'in', vendor: 'out', supplier: 'out', tenant: 'in', donor: 'in', adopter: 'in', landlord: 'out' };
const PLAIN_ROLES = new Set(['customer', 'vendor', 'supplier']);
const DOC_NOUNS = { invoice: 'invoice', invoices: 'invoice', inv: 'invoice', bill: 'bill', bills: 'bill', receipt: 'receipt', receipts: 'receipt', contract: 'contract', contracts: 'contract', agreement: 'contract', agreements: 'contract', lease: 'contract', permit: 'permit', permits: 'permit', certificate: 'certificate', certificates: 'certificate', cert: 'certificate', certs: 'certificate', record: 'record', records: 'record', document: 'record', documents: 'record', doc: 'record', docs: 'record', paperwork: 'record', file: 'record', files: 'record' };
const FILLER = new Set(`named called named a an the this that these those it its is are was were be been being do does did have has had there here to of for from on in at by with and or any all every one ones only just also about around roughly approximately approx nearly almost near close on file filed my our your their his her them they he she we i you us as so if then than too very really number numbers no nr num id amount amounts total totals totaling dollar dollars usd bucks buck worth that's thats whats it's its who's anyone anything something someone name names copy pdf ever`.split(/\s+/));
const NAME_VERBS = new Set('pay pays paying payed get gets getting got need needs needed want wants wanted call calls calling sign signs signed charge charges charged billed invoiced buy buys bought order orders ordered send sends sent cost costs'.split(' '));
for (const v of ['gave', 'give', 'gives', 'giving', 'donated', 'donate', 'donates', 'pledged', 'contributed', 'rented', 'leased', 'adopted']) NAME_VERBS.add(v);
const NONNAME = new Set(['account', 'accounts', 'profile', 'info', 'information', 'history', 'details', 'detail', 'balance', 'phone', 'email', 'address', 'warranty', 'tax', 'include', 'includes', 'come', 'comes', 'mention', 'mentions', 'say', 'says', 'cover', 'covers', 'contain', 'contains', 'unit', 'serial', 'technician', 'tech']);
const SUPER_LATEST = /\b(?:latest|newest|most recent|last|recent|current)\b/;
const SUPER_BIGGEST = /\b(?:biggest|largest|highest|greatest|most expensive|top|max(?:imum)?|priciest)\b/;
const SUPER_SMALLEST = /\b(?:smallest|lowest|least expensive|cheapest|minimum|min)\b/;
const STATUS_WORDS = [['overdue', /\b(?:overdue|past due|late)\b/], ['unpaid', /\b(?:unpaid|outstanding|owing|owed|owes?|open|balance)\b/], ['paid', /\b(?:paid|settled)\b/]];

/** Lexicon of words we can repair a 1-2 letter typo of. value = canonical word. */
const LEXICON = ['invoice', 'invoices', 'receipt', 'receipts', 'contract', 'contracts', 'agreement', 'permit', 'permits', 'certificate', 'certificates', 'customer', 'customers', 'vendor', 'vendors', 'supplier', 'suppliers', 'tenant', 'landlord', 'overdue', 'latest', 'newest', 'biggest', 'largest', 'smallest', 'highest', 'lowest', 'recent', 'unpaid', 'outstanding', 'total', 'amount', 'before', 'after', 'since', 'between'];
const NEVER_CORRECT = new Set(['bill', 'bills', 'bell', 'built', 'cell', 'fill', 'will', 'tenants', 'record', 'records', 'recent', 'agree', 'amount', 'amounts', 'permit', 'lasts', 'later', 'latter']);

function editDistance(a, b, cap = 3) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1); // transposition
  }
  return dp[a.length][b.length];
}

const KNOWN_TYPOS = { bil: 'bill', bils: 'bills', biill: 'bill', invoce: 'invoice', invice: 'invoice', recipt: 'receipt', reciept: 'receipt', permt: 'permit', vendr: 'vendor', suplier: 'supplier', supplyer: 'supplier' };
function repairTypo(word, protect) {
  if (KNOWN_TYPOS[word] && !protect.has(word)) return KNOWN_TYPOS[word];
  if (word.length < 5 || NEVER_CORRECT.has(word) || LEXICON.includes(word) || protect.has(word)) return null;
  if (!/^[a-z]+$/.test(word)) return null;
  let best = null;
  for (const cand of LEXICON) {
    if (cand.length < 5 && cand !== word) continue;
    const d = editDistance(word, cand);
    const limit = cand.length >= 7 ? 2 : 1;
    if (d >= 1 && d <= limit && (!best || d < best.d)) best = { cand, d };
    else if (best && d === best.d && best.cand !== cand) best.tie = true;
  }
  return best && !best.tie ? best.cand : null;
}

function toCents(raw, k) {
  const s = String(raw).replace(/,/g, '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(s) && !(k && /^\d+(?:\.\d+)?$/.test(s))) return null;
  const n = Number(s) * (k ? 1000 : 1);
  return Number.isFinite(n) && n > 0 && n < 1e10 ? String(Math.round(n * 100)) : null;
}
export const centsToDollarString = (c) => { const s = String(c).padStart(3, '0'); return `${s.slice(0, -2)}.${s.slice(-2)}`; };

const ADDRESS_WORDS = /\b(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|way|ct|court|pl|place|cir|circle|hwy|highway|pkwy|parkway|trl|trail|terrace|apt|apartment|unit|suite|ste|address|located|lives|property)\b/;

function nearestYear(m, d, today) {
  const t = parseYmd(today); const tn = dayNum(t.y, t.m, t.d);
  let best = null;
  for (const y of [t.y - 1, t.y, t.y + 1]) { const diff = Math.abs(dayNum(y, m, Math.min(d, lastDay(y, m))) - tn); if (!best || diff < best.diff) best = { y, diff }; }
  return best.y;
}
function recentPastYear(m, d, today) {
  const t = parseYmd(today);
  return dayNum(t.y, m, Math.min(d, lastDay(t.y, m))) <= dayNum(t.y, t.m, t.d) ? t.y : t.y - 1;
}
const fmtDate = (y, m, d) => `${MONTHS[m - 1][0].toUpperCase()}${MONTHS[m - 1].slice(1)} ${d}, ${y}`;

/** Date window ({from,to,yearAssumed,note}) or null. Never throws. */
function parseDates(q, today) {
  if (!today || !/^\d{4}-\d{2}-\d{2}/.test(today)) return null;
  const t = parseYmd(today);
  const rel = q.match(/\b(before|prior to|until|till|by|after|since|on|in|during|from)\s+(?:the\s+)?(?:(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?)?(?:(?:(\w+)\s+)?(\d{1,2})(?:st|nd|rd|th)?)?/); // unused shape guard
  void rel;
  const dir = (w) => (/^(before|prior to|until|till|by)$/.test(w) ? 'before' : /^(after|since)$/.test(w) ? 'after' : /^(on)$/.test(w) ? 'on' : 'in');
  let m;
  // "before december 24, 2025" / "after march 3 2026" / "on may 5"
  m = q.match(new RegExp(`\\b(before|prior to|until|till|by|after|since|on|in|during|from|of)?\\s*${MON_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*,?\\s*((?:19|20)\\d\\d))?\\b`));
  if (m) {
    const word = m[1] ?? 'on'; const mo = monthNo(m[2]); const d = Number(m[3]);
    if (mo && d >= 1 && d <= 31) {
      const hasYear = Boolean(m[4]);
      const dd = Math.min(d, lastDay(hasYear ? Number(m[4]) : t.y, mo));
      const kind = dir(word);
      const y = hasYear ? Number(m[4]) : (kind === 'before' || kind === 'after') ? nearestYear(mo, dd, today) : recentPastYear(mo, dd, today);
      const day = ymd(y, mo, Math.min(dd, lastDay(y, mo)));
      const label = fmtDate(y, mo, Math.min(dd, lastDay(y, mo)));
      const win = kind === 'before' ? { from: null, to: addDays(day, -1) } : kind === 'after' ? { from: addDays(day, 1), to: null } : { from: day, to: day };
      return { ...win, yearAssumed: hasYear ? null : y, label: `${kind === 'before' ? 'before' : kind === 'after' ? 'after' : 'on'} ${label}`,
        note: hasYear ? null : `no year was given, so I read "${m[2]} ${d}" as ${label}${kind === 'in' || kind === 'on' ? ' (the most recent one)' : ' (the nearest one to today)'}; say the year to change it` };
    }
  }
  // "in march 2026" / "in march" / "march 2026"
  m = q.match(new RegExp(`\\b(before|prior to|until|by|after|since|in|during|from|of)?\\s*${MON_RE}(?:\\s+((?:19|20)\\d\\d))?\\b(?!\\s+\\d{1,2}\\b)`));
  if (m && monthNo(m[2]) && !(m[2] === 'may' && !m[1] && !m[3])) {
    const mo = monthNo(m[2]); const kind = dir(m[1] ?? 'in'); const hasYear = Boolean(m[3]);
    const y = hasYear ? Number(m[3]) : (kind === 'in' ? recentPastYear(mo, 1, today) : nearestYear(mo, 1, today));
    const from = ymd(y, mo, 1); const to = ymd(y, mo, lastDay(y, mo));
    const win = kind === 'before' ? { from: null, to: addDays(from, -1) } : kind === 'after' ? { from: addDays(to, 1), to: null } : { from, to };
    const label = `${MONTHS[mo - 1][0].toUpperCase()}${MONTHS[mo - 1].slice(1)} ${y}`;
    return { ...win, yearAssumed: hasYear ? null : y, label: `${kind === 'in' ? 'in' : kind} ${label}`, note: hasYear ? null : `no year was given, so I read "${m[2]}" as ${label}; say the year to change it` };
  }
  m = q.match(/\b(before|prior to|until|by|after|since|in|during|of|for)\s+((?:19|20)\d\d)\b/);
  if (m) { const y = Number(m[2]); const kind = dir(m[1]); return { from: kind === 'before' ? null : kind === 'after' ? ymd(y, 12, 31) : ymd(y, 1, 1), to: kind === 'after' ? null : kind === 'before' ? ymd(y - 1, 12, 31) : ymd(y, 12, 31), yearAssumed: null, label: `${kind === 'in' ? 'in' : kind} ${y}`, note: null }; }
  if (/\blast year\b/.test(q)) return { from: ymd(t.y - 1, 1, 1), to: ymd(t.y - 1, 12, 31), yearAssumed: null, label: String(t.y - 1), note: null };
  if (/\bthis year\b|\bytd\b|\byear to date\b/.test(q)) return { from: ymd(t.y, 1, 1), to: today.slice(0, 10), yearAssumed: null, label: String(t.y), note: null };
  if (/\blast month\b/.test(q)) { const py = t.m === 1 ? t.y - 1 : t.y; const pm = t.m === 1 ? 12 : t.m - 1; return { from: ymd(py, pm, 1), to: ymd(py, pm, lastDay(py, pm)), yearAssumed: null, label: 'last month', note: null }; }
  if (/\bthis month\b/.test(q)) return { from: ymd(t.y, t.m, 1), to: ymd(t.y, t.m, lastDay(t.y, t.m)), yearAssumed: null, label: 'this month', note: null };
  return null;
}

/** words of the question (lowercase, apostrophes removed) with their original spelling */
function tokenize(text) {
  const out = []; const re = /[A-Za-z][A-Za-z'’.-]*[A-Za-z]|[A-Za-z]|[$#]?\d[\d,]*(?:\.\d+)?k?/g; let m;
  while ((m = re.exec(text))) out.push({ raw: m[0], low: m[0].toLowerCase().replace(/['’]/g, ''), start: m.index, end: m.index + m[0].length });
  return out;
}

const MON_NAMES = /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)$/;
const cap = (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** @returns {object} see file header. Pure; never throws (a failure degrades to kind 'unknown'). */
/**
 * R2: customer names that are also ordinary words ("Bill's invoice", "Will Owens", "bill paye's invoice", "billpaye invoice", "Kenneths invoice"): when the organization's own customer
 * names (rescueNames) contain the words, they are swapped for a placeholder BEFORE any question/doc/role word logic runs, so "Bill" is a name and not the word bill.
 * Returns {text, map} or null. Pure.
 */
function rescueNames(text, names) {
  const list = (names ?? []).map(String).filter(Boolean);
  if (!list.length) return null;
  const norm = (x) => x.toLowerCase().replace(/['’]s\b/g, '').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
  const full = new Map(); const glued = new Map(); const tokens = new Set();
  for (const n of list) { const k = norm(n); if (!k) continue; full.set(k, n); glued.set(k.replace(/ /g, ''), n); for (const t of k.split(' ')) if (t.length >= 3) tokens.add(t); }
  const toks = []; const re = /[A-Za-z][A-Za-z'’]*/g; let m;
  while ((m = re.exec(text))) toks.push({ s: m.index, e: m.index + m[0].length, raw: m[0], l: norm(m[0]) });
  const common = (l) => Boolean(DOC_NOUNS[l] || FILLER.has(l) || QUESTION_WORDS_SET.has(l) || ROLE_WORDS[l] || NAME_VERBS.has(l));
  const spans = []; const used = new Set();
  const hasDoc = () => toks.some((t, i) => !used.has(i) && (Boolean(DOC_NOUNS[t.l]) || /^(?:owe|owes|owed|pay|pays|paid|bill|billed)$/.test(t.l)));
  for (let i = 0; i < toks.length; i++) {
    if (used.has(i)) continue;
    let hit = null;
    for (let n = Math.min(3, toks.length - i); n >= 2 && !hit; n--) {
      let ok = true; for (let k = i; k < i + n - 1; k++) if (text.slice(toks[k].e, toks[k + 1].s) !== ' ') ok = false;
      if (!ok) continue;
      const nm = full.get(norm(text.slice(toks[i].s, toks[i + n - 1].e)));
      if (nm) hit = { i, n, name: nm };
    }
    if (!hit) { const g = glued.get(toks[i].l); if (g && toks[i].l.length >= 6 && !tokens.has(toks[i].l)) hit = { i, n: 1, name: g }; }
    if (!hit && /^[A-Z]/.test(toks[i].raw)) {
      const l = toks[i].l; const stem = l.endsWith('s') ? l.slice(0, -1) : null;
      const poss = /['’]s$/i.test(toks[i].raw);
      if (tokens.has(l) && common(l) && (used.add(i), hasDoc())) hit = { i, n: 1, name: l[0].toUpperCase() + l.slice(1) };
      else if (stem && stem.length >= 3 && tokens.has(stem) && !tokens.has(l) && (poss || true) && (used.add(i), hasDoc())) hit = { i, n: 1, name: stem[0].toUpperCase() + stem.slice(1) };
      used.delete(i);
    }
    if (!hit && /^[A-Z]/.test(toks[i].raw) && common(toks[i].l) && toks[i + 1] && /^[A-Z]/.test(toks[i + 1].raw) && text.slice(toks[i].e, toks[i + 1].s) === ' ' && (tokens.has(toks[i].l) || tokens.has(toks[i + 1].l))) {
      // "Bill Pay invoice": a capitalised run that starts with an ordinary word is ONE name as typed (never "Bill" alone, never "Pay" alone)
      let n = 2; while (n < 3 && toks[i + n] && /^[A-Z]/.test(toks[i + n].raw) && text.slice(toks[i + n - 1].e, toks[i + n].s) === ' ' && !common(toks[i + n].l)) n++;
      hit = { i, n, name: text.slice(toks[i].s, toks[i + n - 1].e).replace(/['’]s$/i, '') };
    }
    if (!hit && !/^[A-Z]/.test(toks[i].raw) && tokens.has(toks[i].l) && !common(toks[i].l) && toks[i].l.length >= 4 && !NONNAME.has(toks[i].l) && !/^(?:latest|newest|biggest|largest|highest|lowest|smallest|total|average|overdue|unpaid|paid|open|recent|today|yesterday|month|year|week|quarter|january|february|march|april|june|july|august|september|october|november|december|first|last|next|this|that|many|much|number|count|list|every|between|before|after|since|until|over|under|above|below|around|about|more|less|invoicee|invoicing|vendor|customer|bills|billed|invoiced|amount|amounts|equal|equals|check|checks|cash|cards?|gives?|gets?|sent|made|done|only|just|also|even|ever|never|always|still|already|yet|than|then|them|they|their|there|here|with|have|from|into|onto|your|mine|ours|ones?)$/.test(toks[i].l) && !MON_NAMES.test(toks[i].l) && (used.add(i), hasDoc())) hit = { i, n: 1, name: toks[i].l[0].toUpperCase() + toks[i].l.slice(1) };
    if (hit && hit.n === 1) used.delete(i);
    if (hit) { for (let k = hit.i; k < hit.i + hit.n; k++) used.add(k); spans.push(hit); }
  }
  if (!spans.length) return null;
  const map = {}; let out = ''; let at = 0;
  spans.forEach((sp, idx) => { const ph = `Qnmx${String.fromCharCode(97 + idx)}`; map[ph] = sp.name; out += text.slice(at, toks[sp.i].s) + ph; at = toks[sp.i + sp.n - 1].e; });
  return { text: out + text.slice(at), map };
}

export function understandQuestion(question, { today = null, conversation = null, vocab = null, rescueNames: rescueList = null, _depth = 0 } = {}) {
  const out = { kind: 'unknown', docKind: null, role: null, direction: null, filters: { amount: null, docNumber: null, name: null, address: null, dateWindow: null, status: null, order: null }, wants: [], corrections: [], strippedQuestionWords: [], notes: [], residual: [], text: '' };
  try {
    let text = String(question ?? '').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
    out.text = text;
    if (!text) return out;
    const rescued = rescueNames(text, rescueList);
    if (rescued) text = rescued.text;
    const protect = new Set((vocab?.names ?? []).flatMap((n) => String(n).toLowerCase().split(/\s+/)));
    if (rescued) for (const ph of Object.keys(rescued.map)) protect.add(ph.toLowerCase());

    // 1. typo repair of known words (visible, never drops anything)
    text = text.replace(/[A-Za-z]{3,}(?![A-Za-z'’])/g, (w) => {
      const fix = repairTypo(w.toLowerCase(), protect);
      if (!fix) return w;
      out.corrections.push({ from: w, to: fix, note: `reading "${w}" as "${fix}"` });
      return w[0] === w[0].toUpperCase() && w.slice(1) === w.slice(1).toLowerCase() ? cap(fix) : fix;
    });
    const low = text.toLowerCase().replace(/'s\b/g, '').replace(/[’']/g, '');

    // 2. question words / politeness (recorded, then ignored everywhere downstream)
    let rest = ` ${low.replace(/[?!,;:]/g, ' ')} `;
    for (const ph of [...QUESTION_PHRASES].sort((a, b) => b.length - a.length)) {
      const re = new RegExp(`(?<=\\s)${ph}(?=\\s)`, 'g');
      if (re.test(rest)) { out.strippedQuestionWords.push(ph); rest = rest.replace(re, ' '); }
    }
    const asks = (re) => re.test(low);
    if (/\bwho(?:s|se|m)?\b|\bwho is\b|\bto whom\b|\bwhich (?:customer|client|vendor|supplier|tenant|donor|person)\b|\bwhose\b/.test(low)) out.wants.push('who');
    if (/\bwhich (?:invoice|bill|receipt|contract|permit|certificate|document|one)\b|\bwheres?\b|\bfind\b|\bshow\b|\bpull up\b|\bwhat (?:invoice|bill)\b/.test(low)) out.wants.push('which');
    if (/\bwhen\b|\bwhat date\b|\bwhich date\b|\bdate\b/.test(low)) out.wants.push('when');
    if (/\bhow much\b|\bamount\b|\btotal\b|\bwhat (?:was|is) (?:the )?(?:total|amount)\b|\bcost\b/.test(low)) out.wants.push('how-much');
    if (/\bhow many\b|\bcount\b|\bnumber of\b/.test(low)) out.wants.push('how-many');

    // the same text with those phrases cut out (original case kept), for name / leftover detection
    let strippedText = ` ${text.replace(/['’]s\b/g, '').replace(/[?!,;:]/g, ' ')} `;
    for (const ph of [...QUESTION_PHRASES].sort((a, b) => b.length - a.length)) strippedText = strippedText.replace(new RegExp(`(?<=\\s)${ph.replace(/ /g, '\\s+')}(?=\\s)`, 'gi'), ' ');
    const words = tokenize(strippedText);

    // 3. role + document kind (role words are never matched as names)
    const wordSet = new Set(rest.split(/\s+/).filter(Boolean));
    for (const w of wordSet) if (ROLE_WORDS[w]) { out.role = ROLE_WORDS[w]; break; }
    out.direction = out.role ? (ROLE_DIRECTION[out.role] ?? null) : null;
    // "bill" as a VERB ("who did we bill 3086", "who we billed") is a customer invoice, not a vendor bill
    const billVerb = /\b(?:did we|do we|have we|had we|we|i|did i|have i|were we|are we|we've|weve|ive|we ever)\s+(?:ever\s+|already\s+)?(?:bill|billed|invoice|invoiced|charge|charged)\b/.test(low) || /\bwho (?:was|were|is|are) (?:billed|invoiced|charged)\b/.test(low) || /(?<!\b(?:we|i)\s)\b(?:get|got|gets|was|were|been|being)\s+(?:charged|billed|invoiced)\b/.test(low);
    let docKind = null;
    for (const w of wordSet) {
      if (DOC_NOUNS[w]) { if (DOC_NOUNS[w] === 'record' && docKind) continue; if (w === 'bills' || w === 'bill') { if (!billVerb || /\b(?:the|a|an|this|that|latest|biggest|largest|last|vendor|supplier)\s+(?:\w+\s+)?bills?\b/.test(low)) docKind = 'bill'; } else docKind = DOC_NOUNS[w]; if (docKind && docKind !== 'record') break; }
    }
    if (!docKind && billVerb) docKind = 'invoice';
    const creditMemo = /\bcredit\s+memos?\b/.test(low);
    if (creditMemo && !docKind) { docKind = 'invoice'; out.notes.push('credit memo: looked up among the invoices by its signed total'); }
    if (billVerb && out.direction == null) out.direction = 'in';
    // R41U E4: sent/issued/billed/charged = money in; got/received/owe = money out; conflicting words -> one short question (never a silent pick)
    {
      const sentV = billVerb || /\b(?:we|i)\s+(?:have\s+|had\s+|already\s+|just\s+)?(?:sent|issued)\b|\b(?:sent|issued) out\b/.test(low);
      const gotV = /(?<!\b(?:have|had|do|did|does|would|could)\s)\b(?:we|i)\s+(?:have\s+|had\s+|already\s+|just\s+)?(?:got|received|owe)\b|\b(?:sent|billed|invoiced|charged) (?:to )?(?:us|me)\b|\bwe were (?:sent|billed|charged)\b|\b(?:and|or)\s+(?:got|received)\b/.test(low);
      if ((docKind === 'invoice' || docKind === 'bill') && (sentV || gotV)) {
        const vd = sentV && gotV ? 'conflict' : sentV ? 'in' : 'out';
        if (vd === 'conflict' || (out.direction && out.direction !== vd)) out.notes.push('directionConflict');
        else { out.direction = vd; out.notes.push(`direction from the verb: ${vd === 'in' ? 'we sent it' : 'we received it'}`); }
      }
    }
    if (docKind === 'invoice' && out.direction === 'out') docKind = 'bill'; // "invoice from a supplier" is a bill we received
    if (docKind === 'bill' && out.direction === 'in') docKind = 'invoice'; // "bill for a customer" is an invoice we sent
    if (docKind === 'bill' && !out.direction) out.direction = 'out';
    if (docKind === 'invoice' && !out.direction && !out.role) out.direction = null; // plain "invoice": both sides stay possible, the lane says which
    if (docKind === 'invoice' && out.direction == null && /\b(?:we sent|we billed|we invoiced|sent to|bill(?:ed)? to)\b/.test(low)) out.direction = 'in';
    out.docKind = docKind;

    // 4. numbers: amount first, then document number, then address only with address words
    const addressy = ADDRESS_WORDS.test(low);
    const approx = /\b(?:about|around|roughly|approximately|approx|nearly|almost|close to|near|ish)\b/.test(low);
    const numRe = /(?<![\w#/.,-])(\$\s?)?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(\s?k\b)?(?![\w/-]|[.,]\d)/gi; let nm; const nums = [];
    while ((nm = numRe.exec(text))) nums.push({ text: nm[0], dollar: Boolean(nm[1]), raw: nm[2], k: Boolean(nm[3]), start: nm.index, end: nm.index + nm[0].length });
    const dateConsumed = (n) => new RegExp(`${MON_RE}\\s*$`, 'i').test(text.slice(Math.max(0, n.start - 12), n.start)) || /^(?:st|nd|rd|th)\b/.test(text.slice(n.end)) || new RegExp(`^\\s*(?:st|nd|rd|th)?\\s*,?\\s*(?:19|20)\\d\\d`).test(text.slice(n.end)) && new RegExp(`${MON_RE}\\s*$`, 'i').test(text.slice(Math.max(0, n.start - 12), n.start));
    // explicit document-number forms: INV-7720, BILL-77, #3470, invoice number 3470, "no. 3470"
    const alnum = text.match(/\b([A-Za-z]{1,6}-?\d{2,}(?:-\d+)*)\b/);
    const marked = text.match(/(?:#|\b(?:number|no\.?|num|nr|nbr|numbered)\s*#?\s*)\s*(\d{2,}(?:-\d+)*)\b/i);
    if (alnum && /[A-Za-z]/.test(alnum[1]) && !/^(?:mp|st|nd|rd|th)\d/i.test(alnum[1]) && !new RegExp(`^${MON_RE}$`, 'i').test(alnum[1].replace(/\d.*/, ''))) out.filters.docNumber = { value: alnum[1].toUpperCase(), explicit: true };
    else if (marked) out.filters.docNumber = { value: marked[1], explicit: true };
    for (const n of nums) {
      if (out.filters.docNumber?.explicit && n.raw === out.filters.docNumber.value) continue;
      if (dateConsumed(n)) continue;
      const bare = !n.dollar && !n.k && !/[.,]/.test(n.raw);
      if (bare && /^(?:19|20)\d\d$/.test(n.raw) && /\b(?:in|during|since|before|after|of|for|year|by)\s*$/.test(text.slice(0, n.start).toLowerCase())) continue; // a year
      // F4: a bare 4-digit year right next to a document noun ("invoices 2025", "2025 receipts") is a year, unless a "$" or a money word is in the question.
      if (bare && /^(?:19|20)\d\d$/.test(n.raw) && !/[$]|\b(?:dollars?|bucks?|usd|grand|total|amount|worth|cost|costs|price|priced)\b/i.test(text)
        && (/\b(?:invoices?|bills?|receipts?|statements?|estimates?|quotes?|proposals?|orders?|pos?|agreements?|contracts?|documents?|docs?|paperwork|files?|papers?|schedules?|letters?|certificates?|tickets?)\s*$/i.test(text.slice(0, n.start)) || /^\s*(?:invoices?|bills?|receipts?|statements?|estimates?|quotes?|proposals?|orders?|agreements?|contracts?|documents?|docs?|paperwork|papers?|files?)\b/i.test(text.slice(n.end)))) continue;
      if (bare && /^(?:19|20)\d\d$/.test(n.raw) && new RegExp(`\\b${MON_RE}\\.?\\s*(?:\\d{1,2}(?:st|nd|rd|th)?\\s*,?\\s*)?$`, 'i').test(text.slice(0, n.start))) continue; // a year after a month (and day): "december 24 2026"
      const tail = text.slice(n.end).toLowerCase();
      if (bare && /^\s*(?:days?|weeks?|months?|years?|hours?|minutes?|invoices|bills|customers|clients|jobs|units|visits|miles|%|percent|am|pm|st|nd|rd|th)\b/.test(tail)) continue;
      if (bare && n.raw.length <= 2 && /^\s*(?:customer|client|job|unit|visit|mile|hour)\b/.test(tail)) continue;
      if (bare && /\b(?:customer|client|job|unit|ticket|account|acct|tech|technician)\s*#?\s*$/.test(text.slice(0, n.start).toLowerCase())) continue; // an id of something else, not an amount
      if (bare && n.raw.length <= 1 && /^\s*(?:invoice|bill)\b/.test(tail)) continue;
      // an address: "123 E Main St" (number then street words), or address words present and the number leads a capitalised street
      if (bare && addressy && /^\s+(?:[nsew]\.?|north|south|east|west|ne|nw|se|sw)?\.?\s*[A-Za-z]+(?:\s+[A-Za-z]+){0,2}\s+(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|way|ct|court|pl|place|cir|circle|hwy|pkwy|trl)\b/i.test(tail)) {
        const am = text.slice(n.start).match(/^\d+\s+[A-Za-z.\s]+?\b(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|way|ct|court|pl|place|cir|circle|hwy|pkwy|trl)\b\.?/i);
        out.filters.address = { value: am ? am[0].trim() : n.raw }; continue;
      }
      if (out.filters.amount) { if (docKind && n.raw !== out.filters.amount.raw.replace(/^\$\s?/, '')) (out._extra ??= []).push(n.text.trim()); continue; }
      const cents = toCents(n.raw, n.k);
      if (!cents) continue;
      out.filters.amount = { value: centsToDollarString(cents), cents, approx, bare, dollar: n.dollar || /^\s*(?:dollars?|bucks?|usd)\b/.test(tail), raw: n.text.trim() };
      if (bare && !out.filters.docNumber && !n.k) { out.filters.docNumber = { value: n.raw, explicit: false, viaBareNumber: true }; }
      out.notes.push(bare ? `the number ${n.raw} is tried as an amount first, then as a document number` : `the number ${n.raw} is read as a dollar amount`);
    }
    if (out._extra?.length) { out.corrections.push({ note: `only ${out.filters.amount.raw} was looked up; ${out._extra.join(' and ')} was not applied, so ask about ${out._extra.length === 1 ? 'it' : 'them'} separately` }); }
    delete out._extra;
    // "who owes us 3470": a status word with an amount and no document word is the invoice of that total (money in); the status is not applied and that is said
    if (!docKind && out.filters.amount && out.filters.docNumber && /\b(?:owes?|owed|owing|unpaid|outstanding)\b/.test(low) && /\b(?:who|which|what)\b/.test(low)) {
      docKind = 'invoice'; out.docKind = 'invoice'; out.kind = 'invoice'; out.direction = out.direction ?? 'in';
      out.corrections.push({ note: 'you asked who still owes it; this lists every invoice with that total whether or not it has been paid' });
    }
    // R2: a role word with a number and no document word ("#1234 from a donor", "which donor gave 500", "who is the tenant billed 1200") is the invoice (or bill) of that
    // number / total on the role's side of the books. The role never becomes a name; when the records do not mark who is a tenant / donor / landlord that is said.
    if (!docKind && out.role && (out.filters.amount || out.filters.docNumber) && !out.filters.address && !/\b(?:owes?|owed|owing|unpaid|outstanding|overdue|late)\b/.test(low)) {
      const dn = out.filters.docNumber;
      const numberish = dn?.explicit ? /^\d{2,9}$/.test(dn.value) : true;
      // a billing cue is required ("customers in 85122" is a zip code, never an amount)
      const cue = /\b(?:from|billed|charged|invoiced|gave|give|gives|giving|donated|donates|pledged|contributed|rented|leased|adopted|bill|bills|invoice|invoices|receipt|gift|donation|payment|rent|with|has|have|had)\b/.test(low) || /\b(?:donors?|tenants?|adopters?)\s+of\b/.test(low) || Boolean(dn?.explicit);
      const placeNum = /\b(?:in|at|near|around|within|zip|code)\s+#?\d+\s*$/.test(low.replace(/[?!.]/g, '').trim());
      if (numberish && cue && !placeNum) {
        docKind = out.direction === 'out' ? 'bill' : 'invoice'; out.docKind = docKind; out.kind = docKind;
        if (!PLAIN_ROLES.has(out.role) && out.role !== 'volunteer') out.corrections.push({ note: `your records don't mark who is a ${out.role}, so this looks at every ${docKind === 'bill' ? 'bill we received' : 'invoice we sent'}` });
        if (dn?.explicit && /^\d{2,9}$/.test(dn.value) && !out.filters.amount) out.filters.numberOnly = true;
      }
    }
    if (out.role && out.filters.docNumber?.explicit && /^\d{2,9}$/.test(out.filters.docNumber.value) && !out.filters.amount && (docKind === 'invoice' || docKind === 'bill')) out.filters.numberOnly = true; // "invoice #1234 from a landlord": the number as typed
    // R2: "what was the 3,470.00 for" / "what was 3470 for" is the invoice of that total; "who paid 3407" lists the invoices with that total (payment status is not applied, and that is said)
    if (!docKind && out.filters.amount && !out.role) {
      if (/\bwhats?\s+(?:(?:was|is)\s+)?(?:the\s+)?\$?[\d,.]+\s*(?:dollars?\s+)?for\b/.test(low)) { docKind = 'invoice'; out.docKind = 'invoice'; out.kind = 'invoice'; }
      else if (/\bwho(?:s)?\s+(?:paid|pays|has paid)\b/.test(low)) { docKind = 'invoice'; out.docKind = 'invoice'; out.kind = 'invoice'; out.direction = out.direction ?? 'in'; out.filters.status = null; out.corrections.push({ note: 'payment status is not applied: this lists every invoice with that total whether or not it has been paid' }); }
    }
    if (!docKind && out.filters.docNumber?.explicit) { const pf = String(out.filters.docNumber.value).match(/^([A-Za-z]+)/)?.[1]?.toUpperCase(); const pk = { INV: 'invoice', INVOICE: 'invoice', BILL: 'bill', RCPT: 'receipt', RECEIPT: 'receipt', PERMIT: 'permit', BP: 'permit', CERT: 'certificate' }[pf]; if (pk) { out.docKind = pk; docKind = pk; out.kind = pk; } }
    if (out.filters.docNumber?.explicit) out.filters.amount = out.filters.amount && !out.filters.amount.bare ? out.filters.amount : null;
    if (out.filters.address && !addressy) out.filters.address = null; // never an address without address words

    // 5. dates
    out.filters.dateWindow = parseDates(low, today);
    if (out.filters.dateWindow?.note) out.notes.push(out.filters.dateWindow.note);

    // 6. status + order + shape
    for (const [s, re] of STATUS_WORDS) if (re.test(low)) { out.filters.status = s; break; }
    if (out.corrections.some((c) => /who still owes it|payment status is not applied/.test(c.note))) out.filters.status = null;
    if (SUPER_SMALLEST.test(low)) out.filters.order = 'min';
    const biggest = SUPER_BIGGEST.test(low) || out.filters.order === 'min';
    const latest = SUPER_LATEST.test(low) && !/\blast (?:year|month|week|quarter)\b/.test(low);
    if (biggest && docKind) { out.kind = 'biggest'; if (!out.filters.order) out.filters.order = 'max'; }
    else if (latest && docKind) out.kind = 'latest';
    else if (out.filters.status === 'overdue') out.kind = 'overdue';
    else if (/\bhow many\b|\bcount\b|\bnumber of\b/.test(low)) out.kind = 'count';
    else if (/\bhow much\b.*\b(?:total|all|altogether|combined|together|invoiced|billed)\b|\btotal\b.*\b(?:invoiced|billed|sales|revenue)\b|\b(?:sum|total) of\b/.test(low) && !out.filters.amount) out.kind = 'total';
    else if (/\b(?:list|every|all)\b/.test(low) && docKind && !out.filters.amount && !out.filters.docNumber) out.kind = 'list';
    else if (docKind) out.kind = docKind;
    else if (out.filters.amount || out.filters.docNumber) out.kind = 'unknown';
    if (out.kind === 'unknown' && !docKind && out.role && !out.filters.amount) out.kind = 'person';

    // 7. names: what remains once question words, role words, doc nouns, filler, numbers, dates and status words are gone
    const dateWords = new RegExp(`^(?:${MON_RE}|january|february|march|april|june|july|august|september|october|november|december|before|after|since|until|between|today|yesterday|tomorrow|week|month|year|quarter|ytd|last|this|next|past|ago|latest|newest|biggest|largest|smallest|highest|lowest|recent|most|top|unpaid|overdue|outstanding|paid|open|late|issued|issue|still|owe|owes|owing|owed|balance|bill|billed|invoiced|charged|charge|did|sent|got|received|list|count|many|much|total|every|each|per)$`, 'i');
    const kept = []; const extraResidual = [];
    for (const w of words) {
      if (/^[$#]?\d/.test(w.raw)) continue;
      const l = w.low;
      if (creditMemo && (l === 'credit' || l === 'memo' || l === 'memos')) { kept.push(null); continue; }
      if (NONNAME.has(l)) { kept.push(null); extraResidual.push(l); continue; }
      if (QUESTION_WORDS_SET.has(l) || FILLER.has(l) || ROLE_WORDS[l] || DOC_NOUNS[l] || dateWords.test(l)) { kept.push(null); continue; }
      // R2: a verb right after the name ("did Michelle Sandoval pay their invoice", "what did X get charged") is never part of the name
      if (NAME_VERBS.has(l) && w.raw === l) { kept.push(null); continue; }
      kept.push(w);
    }
    const groups = []; let cur = [];
    for (const k of kept) { if (k) cur.push(k); else if (cur.length) { groups.push(cur); cur = []; } }
    if (cur.length) groups.push(cur);
    const nameGroup = groups.find((g) => g.length >= 1 && g.length <= 4 && g.every((w) => /^[A-Za-z][A-Za-z'’.-]*$/.test(w.raw)) && (g.some((w) => /^[A-Z]/.test(w.raw)) || vocabHas(vocab, g.map((w) => w.raw).join(' ')) || g.length >= 2));
    if (nameGroup && !(out.filters.address && nameGroup.some((w) => ADDRESS_WORDS.test(w.low)))) {
      let value = nameGroup.map((w) => w.raw).join(' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());
      if (rescued) for (const [ph, nm] of Object.entries(rescued.map)) value = value.replace(new RegExp(ph, 'i'), nm);
      out.filters.name = { value, source: nameGroup.some((w) => /^[A-Z]/.test(w.raw)) ? 'capitalised' : 'leftover' };
      if (vocab?.names?.length) {
        const hit = vocabMatch(vocab.names, value);
        if (hit.length === 0) { if (out.filters.name.source === 'capitalised') out.notes.push(`unknownName:${value}`); }
        else out.filters.name.matches = hit;
      }
      if (out.kind === 'unknown') out.kind = docKind ?? 'person';
    }
    const nameSet = new Set(nameGroup && !(out.filters.address && nameGroup.some((w) => ADDRESS_WORDS.test(w.low))) ? nameGroup : []);
    out.residual = [...kept.filter((k) => k && !nameSet.has(k)).map((k) => k.low), ...extraResidual];
    const unk = out.notes.find((n) => n.startsWith('unknownName:'));
    if (unk) out.unknownName = unk.slice(12);

    // 8. pronouns resolve from the conversation, never silently
    const pron = /\b(?:their|theirs|them|his|hers?|that one|this one|the same (?:customer|vendor|supplier|one)|that (?:customer|vendor|supplier|invoice|bill|one)|same (?:customer|vendor|one))\b/.test(low) || /^\s*(?:and\s+)?(?:what|how|when|who)\b.*\b(?:it|that)\b\s*\??$/.test(low);
    if (pron && !out.filters.name && !out.filters.docNumber && !out.filters.amount) {
      let prior = null;
      const turns = Array.isArray(conversation) ? conversation : Array.isArray(conversation?.turns) ? conversation.turns : [];
      if (_depth === 0) for (let i = turns.length - 1; i >= 0 && !prior; i--) {
        const t = turns[i]; const tq = typeof t === 'string' ? t : t?.question ?? t?.q ?? (t?.role === 'user' ? t.text ?? t.content : null);
        if (!tq) continue;
        const u = understandQuestion(tq, { today, vocab, _depth: 1 });
        if (u.filters.name || u.filters.docNumber || u.filters.amount) prior = u;
      }
      if (prior) {
        if (prior.filters.name) out.filters.name = { ...prior.filters.name, source: 'conversation' };
        else if (prior.filters.docNumber) out.filters.docNumber = { ...prior.filters.docNumber, source: 'conversation' };
        else if (prior.filters.amount) out.filters.amount = { ...prior.filters.amount, source: 'conversation' };
        if (!out.docKind) out.docKind = prior.docKind;
        if (!out.direction) out.direction = prior.direction;
        if (out.kind === 'unknown') out.kind = out.docKind ?? 'person';
        out.notes.push('a pronoun in the question was resolved from the earlier question');
      } else out.notes.push('unresolvedPronoun');
    }
    return out;
  } catch (err) {
    out.kind = 'unknown'; out.notes.push('understanding failed');
    return out;
  }
}

function vocabHas(vocab, v) { return Boolean(vocab?.names?.length) && vocabMatch(vocab.names, v).length > 0; }
/** names whose every query token matches a name token (case-insensitive, 1-letter slack on longer tokens) */
function vocabMatch(names, value) {
  const qt = value.toLowerCase().split(/\s+/).filter(Boolean);
  return names.filter((n) => { const nt = String(n).toLowerCase().split(/[\s,]+/).filter(Boolean); return qt.every((t) => nt.some((x) => x === t || (t.length >= 5 && editDistance(x, t) <= 1))); });
}

/** One short human line per correction / assumption, for the answer's visible "I read this as ..." note. */
export function understandingNote(u) {
  const bits = [...(u?.corrections ?? []).map((c) => c.note), ...(u?.filters?.dateWindow?.note ? [u.filters.dateWindow.note] : [])];
  return bits.length ? `(${bits.join('; ')})` : '';
}

/* ============================================================ what is being COUNTED (E2 A4)
 * "how many customer invoices do we have" counts INVOICES (customer is a role word that sets the direction, not the thing counted);
 * "how many customers have invoices" counts CUSTOMERS; "how many units do we manage in Mesa" counts UNITS (not the customers who own them).
 * Pure. Returns { subject: 'units'|'customers'|'invoice'|'bill'|... |null, plural } or null when the question is not a "how many" count or names no countable thing. */
const UNIT_WORDS = new Set(['unit', 'units', 'equipment', 'system', 'systems', 'install', 'installs', 'installation', 'installations', 'furnace', 'furnaces', 'condenser', 'condensers', 'heater', 'heaters', 'piece', 'pieces']);
const CUSTOMER_COUNT_WORDS = new Set(['customer', 'customers', 'client', 'clients', 'account', 'accounts', 'tenant', 'tenants', 'owner', 'owners']);
const COUNT_ADJ = new Set(['different', 'distinct', 'unique', 'total', 'active', 'separate', 'individual', 'open', 'unpaid', 'paid', 'overdue', 'outstanding', 'our', 'my', 'your', 'the', 'all', 'of', 'a', 'an', 'we', 'do', 'does', 'have', 'got', 'manage', 'managed', 'own', 'owned', 'currently']);
export function countSubject(question) {
  const low = String(question ?? '').toLowerCase().replace(/[’']/g, '').replace(/[?!,.;:]/g, ' ').replace(/\s+/g, ' ').trim();
  const m = low.match(/\b(?:how many|number of|count of|total number of|count)\s+(.*)$/);
  if (!m) return null;
  const toks = m[1].split(' ').filter(Boolean);
  for (let i = 0; i < Math.min(toks.length, 6); i++) {
    const t = toks[i];
    if (COUNT_ADJ.has(t)) continue;
    const next = toks[i + 1];
    if (ROLE_WORDS[t] && next && DOC_NOUNS[next] && !(CUSTOMER_COUNT_WORDS.has(t) && /^(?:have|has|with)$/.test(next))) continue; // "customer invoices": the role word modifies the thing counted
    if (CUSTOMER_COUNT_WORDS.has(t) && !(next && DOC_NOUNS[next])) return { subject: 'customers', plural: t.endsWith('s') };
    if (UNIT_WORDS.has(t)) return { subject: 'units', plural: t !== 'unit' };
    if (DOC_NOUNS[t]) return { subject: DOC_NOUNS[t], plural: t.endsWith('s') };
    if (/^(?:in|at|for|on|with|have|has|had|that|who|which|from|by|are|is|were|was|did|been|been)$/.test(t)) return null; // a verb/preposition before any noun: nothing countable named
    // otherwise an unknown modifier (a brand, a city, 'new'): keep looking for the thing counted
  }
  return null;
}

/** The question with 1-2 letter typos of known words repaired ("cutomer invoices" -> "customer invoices"); text otherwise unchanged. Pure. */
export function repairKnownTypos(question, vocab = null) {
  const protect = new Set((vocab?.names ?? []).flatMap((n) => String(n).toLowerCase().split(/\s+/)));
  return String(question ?? '').replace(/[A-Za-z]{5,}(?!['’])/g, (w) => {
    const fix = repairTypo(w.toLowerCase(), protect);
    return fix ? (w[0] === w[0].toUpperCase() && w.slice(1) === w.slice(1).toLowerCase() ? cap(fix) : fix) : w;
  });
}
