/**
 * R40 GROUNDING GATE - nothing the model composed is shown unless it is on the document it cites.
 *
 * The live failure (2026-10-07, HVAC tenant): the model answered "The $3,470.00 invoice is for Ronald Calloway ... INV-T226 ..." with a
 * "Cost $3,470.00" fact card whose chip pointed at a PDF that says TOTAL DUE $350.00. answer.js shapeAnswer only checked that the cited
 * document/page was among the retrieved ones - never that the VALUES appear on it - and the claim check was fail-open ("could not confirm" =
 * supported), so the answer went out "High confidence".
 *
 * This module is PURE (no DB, no model). It extracts the checkable claims from the headline text and from every fact card (money amounts,
 * identifiers such as invoice / PO / permit / serial / model numbers, dates, street addresses, person names) and finds each one in the text of
 * the document it is attributed to (every page of that document, plus that document's own extracted rows). A claim that is only in the
 * question, or only in a different document, is unsupported. Normalisation: currency formatting, date formats, case, whitespace, punctuation.
 *
 * A fact card is kept only when every one of ITS claims is on ITS cited document(s). The headline text is kept only when every claim in it is
 * on a cited document; when a sentence names an identifier (an invoice number...), its other claims must be on a document that carries that
 * identifier (so an amount from one document cannot be glued to another document's invoice number).
 * Fails CLOSED on a claim it cannot find; never throws.
 */
import { parseDateLoose, datesEqual } from '../claims/dates.js';
import { parseAmountAt } from '../amountWords.js';

/* ------------------------------------------------------------------ normalisation helpers */
const deAccent = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\u2013\u2014\u2212]/g, '-');
const norm = (s) => deAccent(s).toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
const alnumNorm = (s) => deAccent(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const MONEY_LABEL = /\b(?:cost|costs|total|totals|amount|price|balance|paid|fee|fees|charge|charges|due|subtotal|tax|rent|deposit|invoiced|billed|quote|quoted|revenue|payment|premium|rate|worth)\b/i;
const NAME_LABEL = /\b(?:customer|client|name|bill(?:ed)? to|owner|tenant|resident|technician|tech|vendor|landlord|contact|installed by|serviced by|performed by|signed by|sold to|attn|attention|person|occupant|lessee|contractor)\b/i;

/** Standalone numbers in `hay` as plain numeric strings ("3,470.00" -> "3470"), skipping digit groups glued to ids / dates / phone numbers. */
const memo = (fn) => { const m = new Map(); return (h) => { let v = m.get(h); if (v === undefined) { v = fn(h); if (m.size > 300) m.clear(); m.set(h, v); } return v; }; };
export const numbersIn = memo(numbersInRaw);
function numbersInRaw(hay) {
  const out = new Set();
  const re = /(?<![\w#/.\-,])\$?\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?![\w/\-]|[.,]\d)/g;
  let m;
  const s = String(hay ?? '');
  while ((m = re.exec(s))) out.add(canonNumber(m[1]));
  return out;
}
const MONEY_LINE = /\b(?:total|amount|due|balance|price|cost|rent|fee|fees|charge|charges|paid|payment|subtotal|tax|deposit|rate|labor|parts|credit|refund|owed|premium|per|each|\/)\b|[$]/i;
/** Numbers on the page that LOOK like money: $-prefixed (whatever follows: "/hr", "-$3,000"), comma-grouped, two-decimal, or on a line that names an amount. A zip code / street number / hour count is not one. */
export const moneyNumbersIn = memo(moneyNumbersRaw);
const ID_BEFORE = /(?:invoice|inv|po|p\.o\.|permit|serial|model|ticket|job|order|ref\w*|account|acct|customer|client|unit|apt|suite|agreement|contract|policy|license|work order|wo)\s*(?:no\.?|number|num|#)?\s*[:#]?\s*#?\s*$/i;
function moneyNumbersRaw(hay) {
  const out = new Set();
  for (const line of String(hay ?? '').split('\n')) {
    for (const m of line.matchAll(/\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/g)) out.add(canonNumber(m[1]));
    const lineMoney = MONEY_LINE.test(line);
    for (const m of line.matchAll(/(?<![\w#/.\-,])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d{2}|\d+(?:\.\d+)?)(?![\w/\-]|[.,]\d)/g)) {
      if (ID_BEFORE.test(line.slice(Math.max(0, m.index - 24), m.index)) && !/,|\.\d{2}$/.test(m[1])) continue; // "Invoice #: 3470" is an identifier, not an amount
      if (/,/.test(m[1]) || /\.\d{2}$/.test(m[1]) || lineMoney) out.add(canonNumber(m[1]));
    }
  }
  return out;
}
export function canonNumber(raw) {
  const n = Number(String(raw).replace(/,/g, ''));
  return Number.isFinite(n) ? String(Math.round(n * 1e6) / 1e6) : String(raw);
}

const MONTH_RE = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DATE_RE = new RegExp(`\\b\\d{4}-\\d{1,2}-\\d{1,2}\\b|\\b\\d{1,2}/\\d{1,2}/\\d{2,4}\\b|\\b${MONTH_RE}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH_RE}\\.?,?\\s+\\d{4}\\b`, 'gi');
const dateCandidates = (s) => (String(s ?? '').match(DATE_RE) ?? []).map((d) => d.replace(/(\d)(?:st|nd|rd|th)\b/i, '$1'));
const MD_RE = new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!,?\\s*\\d{4})`, 'gi');
const monthIndex = (m) => ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(String(m).slice(0, 3).toLowerCase()) + 1;

const ORDINAL_OR_UNIT = /^\d+(?:st|nd|rd|th|k|m|x|g|ft|hr|hrs|yr|yrs|ton|tons|btu|btus|seer|amp|amps|v|w|kw|psi|gal|lb|lbs|am|pm|min|mins|sqft)$|^\d+-(?:year|years|yr|yrs|hour|hours|hr|hrs|month|months|day|days|week|weeks|inch|in|ton|tons|foot|ft|gallon|gal|amp|amps|volt|pound|lb|btu|seer)$|^\d{1,2}(?::\d\d)?(?:am|pm)(?:-\d{1,2}(?::\d\d)?(?:am|pm))?$/i;
const ID_RE = /(?<![\w-])(?=[A-Za-z0-9-]*\d)(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*(?![\w-])/g;
const ID_CUE_RE = /\b(?:invoice|inv|po|p\.o\.|permit|serial|model|ticket|work order|wo|quote|estimate|job|agreement|contract|policy|reference|ref|confirmation|license|licence)\s*(?:no\.?|number|num|#)?\s*[:#]?\s*#?(\d{3,})\b/gi;
const STREET_SUFFIX = '(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|way|ct|court|pl|place|pkwy|parkway|cir|circle|trl|trail|hwy|highway|ter|terrace)';
const ADDRESS_RE = new RegExp(`\\b\\d{1,6}\\s+(?:[NSEW]\\.?\\s+|north\\s+|south\\s+|east\\s+|west\\s+)?(?:[A-Za-z0-9.']+\\s+){0,3}${STREET_SUFFIX}\\b\\.?(?:,?\\s*(?:apt|apartment|unit|suite|ste|#)\\.?\\s*[A-Za-z0-9-]+)?`, 'gi');
const NAME_PHRASE = /\b([A-Z][a-z'’-]{1,}(?:\s+[A-Z]\.?)?(?:\s+[A-Z][a-z'’-]{1,}){1,2})\b/g;
const NAME_CUE = /\b(?:visited|met|contacted|emailed|owns|owned|handled|serviced|replaced|signed|issued to|sent to|assigned to|hired|represents|supplied|purchased from|belongs to|and|for|to|by|from|with|customer|client|tenant|resident|technician|tech|vendor|landlord|owner|attn|belongs to|billed to|bill to|sold to|name is|named|contact)\s+(?:is\s+|was\s+)?$/i;
const NAME_STOP = new Set(['the', 'this', 'that', 'there', 'our', 'your', 'his', 'her', 'its', 'a', 'an', 'unknown', 'none', 'invoice', 'customer', 'client', 'tenant', 'technician', 'owner', 'vendor', 'landlord', 'not', 'no', 'yes', 'on', 'file', 'name', 'company', 'service', 'unit', 'sonoran', 'deepwell']);
const NOT_NAMES = new Set(['sonoran comfort', 'comfort air', 'service address', 'bill to', 'total due', 'work order', 'purchase order', 'maintenance agreement', 'invoice date', 'service date', 'due date', 'not on', 'on file']);

const ORD = { '1st': 'first', '2nd': 'second', '3rd': 'third', '4th': 'fourth', '5th': 'fifth', '6th': 'sixth', '7th': 'seventh', '8th': 'eighth', '9th': 'ninth', '10th': 'tenth' };
const addrNorm = (s) => alnumNorm(String(s).replace(/\b(\d{1,2}(?:st|nd|rd|th))\b/gi, (m) => ORD[m.toLowerCase()] ?? m).replace(/\b(?:apartment|apt|unit|suite|ste)\b\.?/gi, 'unit').replace(/#\s*/g, 'unit '))
  .replace(/\b(street)\b/g, 'st').replace(/\b(avenue)\b/g, 'ave').replace(/\b(road)\b/g, 'rd').replace(/\b(drive)\b/g, 'dr').replace(/\b(lane)\b/g, 'ln').replace(/\b(boulevard)\b/g, 'blvd').replace(/\b(court)\b/g, 'ct').replace(/\b(place)\b/g, 'pl').replace(/\b(north)\b/g, 'n').replace(/\b(south)\b/g, 's').replace(/\b(east)\b/g, 'e').replace(/\b(west)\b/g, 'w');

/**
 * Checkable claims in a string.
 * @param {string} s
 * @param {{moneyContext?: boolean, nameContext?: boolean, idContext?: boolean, qtyContext?: boolean, phoneContext?: boolean, emailContext?: boolean}} opts
 *   moneyContext: every number is an amount (a fact labelled "Cost"); nameContext: a whole capitalised value is a person name; idContext: the whole value is an identifier
 *   (invoice / PO / permit / serial / unit); qtyContext: the number is a quantity (tonnage, hours, years); phoneContext / emailContext: the value is a phone / email
 */
export function extractClaims(s, { moneyContext = false, nameContext = false, idContext = false, qtyContext = false, phoneContext = false, emailContext = false } = {}) {
  const text = deAccent(String(s ?? ''));
  const claims = [];
  const taken = [];
  const overlaps = (a, b) => taken.some(([x, y]) => a < y && b > x);
  const take = (kind, raw, start, end, extra = {}) => { claims.push({ kind, raw: raw.trim(), start, ...extra }); taken.push([start, end]); };
  // addresses first (they contain digits that must not be re-read as amounts). Street words must be capitalised / numeric (not "90812 is for Dr", "3 invoices from St").
  for (const m of text.matchAll(ADDRESS_RE)) {
    const mid = m[0].replace(/^\d+\s+/, '').replace(new RegExp(`\\b${STREET_SUFFIX}\\b.*$`, 'i'), '').trim().split(/\s+/).filter(Boolean);
    if (mid.some((w) => /^[a-z]/.test(w) && !/^(?:n|s|e|w|north|south|east|west)\.?$/i.test(w))) continue;
    take('address', m[0], m.index, m.index + m[0].length, { value: addrNorm(m[0]) });
    const zip = /^,?\s*[A-Za-z .]+,\s*[A-Z]{2}\s+(\d{5})\b/.exec(text.slice(m.index + m[0].length));
    if (zip) {
      take('id', zip[1], m.index + m[0].length, m.index + m[0].length + zip[0].length, { value: zip[1] });
      const cm = /^,?\s*([A-Za-z .]+),\s*[A-Z]{2}\s+\d{5}/.exec(text.slice(m.index + m[0].length));
      if (cm) claims.push({ kind: 'city', raw: cm[1].trim(), start: m.index + m[0].length, value: alnumNorm(cm[1]) });
    }
  }
  for (const m of text.matchAll(/\bP\.?\s?O\.?\s*Box\s*#?\s*(\d+)/gi)) { if (!overlaps(m.index, m.index + m[0].length)) take('id', m[1], m.index, m.index + m[0].length, { value: alnumNorm(m[1]) }); }
  for (const m of text.matchAll(/\b([A-Z][a-z]{2,}(?:\s[A-Z][a-z]{2,})?),\s*(?:AZ|CA|NV|NM|TX|UT|CO|FL|WA|OR|NY|IL|GA|NC|OH|PA|MI|AL|OK|ID|MT|WY|NE|KS|TN|VA|MN)\b/g)) {
    if (claims.some((c) => c.kind === 'city' && Math.abs(c.start - m.index) < 60 && c.value === alnumNorm(m[1]))) continue;
    claims.push({ kind: 'city', raw: m[1], start: m.index, value: alnumNorm(m[1]) });
  }
  for (const m of text.matchAll(DATE_RE)) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    const pd = parseDateLoose(m[0].replace(/(\d)(?:st|nd|rd|th)\b/i, '$1'));
    if (!pd) continue;
    take('date', m[0], m.index, m.index + m[0].length, { value: m[0] });
    const wd = /\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?,?\s*$/i.exec(text.slice(Math.max(0, m.index - 14), m.index));
    if (wd && pd.y && pd.m && pd.d) {
      const real = new Date(Date.UTC(pd.y, pd.m - 1, pd.d)).getUTCDay();
      if (['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(wd[1].toLowerCase()) !== real) claims.push({ kind: 'badweekday', raw: wd[0].trim() + ' ' + m[0], start: m.index, value: 'weekday' });
    }
  }
  for (const m of text.matchAll(/(?<![\d:.\/-])(\d{1,2})(?::(\d{2}))?\s?(am|pm)\b|(?<![\d:.\/-])(\d{1,2}):(\d{2})(?![\d:])/gi)) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    const hh = Number(m[1] ?? m[4]); const mm = Number(m[2] ?? m[5] ?? 0); const ap = (m[3] ?? '').toLowerCase();
    if (hh > 24 || mm > 59) continue;
    take('time', m[0], m.index, m.index + m[0].length, { value: `${hh % 12}:${String(mm).padStart(2, '0')}${ap ? `-${ap}` : ''}` });
  }
  for (const m of text.matchAll(new RegExp(`\\b(${MONTH_RE})\\.?,?\\s+(\\d{4})\\b`, 'gi'))) { if (!overlaps(m.index, m.index + m[0].length)) take('monyear', m[0], m.index, m.index + m[0].length, { value: `${monthIndex(m[1])}-${m[2]}` }); }
  for (const m of text.matchAll(MD_RE)) { if (overlaps(m.index, m.index + m[0].length)) continue; take('mday', m[0], m.index, m.index + m[0].length, { value: `${monthIndex(m[1])}-${Number(m[2])}` }); }
  for (const m of text.matchAll(ID_RE)) {
    if (overlaps(m.index, m.index + m[0].length) || ORDINAL_OR_UNIT.test(m[0]) || m[0].length < 4) continue;
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(m[0])) continue;
    take('id', m[0], m.index, m.index + m[0].length, { value: alnumNorm(m[0]) });
  }
  for (const m of text.matchAll(ID_CUE_RE)) { if (overlaps(m.index, m.index + m[0].length)) continue; take('id', m[1], m.index, m.index + m[0].length, { value: alnumNorm(m[1]) }); }
  for (const m of text.matchAll(/#\s?(\d{3,})\b/g)) { if (overlaps(m.index, m.index + m[0].length)) continue; take('id', m[1], m.index, m.index + m[0].length, { value: alnumNorm(m[1]) }); }
  // email / phone (whole-value, by label)
  for (const m of text.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) take('email', m[0], m.index, m.index + m[0].length, { value: m[0].toLowerCase() });
  for (const m of text.matchAll(/(?<![\w-])\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}(?![\w-])/g)) { if (!overlaps(m.index, m.index + m[0].length)) take('phone', m[0], m.index, m.index + m[0].length, { value: m[0].replace(/\D/g, '').slice(-10) }); }
  // whole-value identifiers by label ("Invoice #": "43", "Serial": "4821908", "Unit": "#4C")
  if (idContext) {
    const v = text.replace(/^[#\s]+/, '').trim();
    if (/^[A-Za-z0-9][A-Za-z0-9 -]{0,30}$/.test(v) && /\d/.test(v) && !overlaps(0, text.length)) take('id', v, 0, text.length, { value: alnumNorm(v) });
  }
  // $-prefixed amounts are ALWAYS claims, whatever follows ("$79/month", "-$3,470.00", "$9,999-$12,000"); other amounts by context or a cue word or "dollars"
  const moneyRe = /(\$\s?)?(?<![\w#/.,])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(\s?(?:k|thousand|million)\b)?(?![\w]|[.,]\d)/gi;
  for (const m of text.matchAll(moneyRe)) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    const dollar = Boolean(m[1]); const suffix = (m[3] ?? '').trim().toLowerCase();
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 14).toLowerCase();
    const before = text.slice(Math.max(0, m.index - 24), m.index).toLowerCase();
    const dollars = /^\s*(?:dollars?|bucks?|usd)\b/.test(after);
    const cue = /\b(?:total|totals|totalling|totaling|amount|due|balance|cost|costs|price|priced|paid|pay|owes|owed|owe|charge|charged|fee|billed|invoiced|worth|deposit|rent)\s*(?:of|is|was|at|:)?\s*(?:about\s*)?$/.test(before);
    const dateLike = /[/\-]$/.test(before.slice(-1)) || /^[/-]\d/.test(after);
    if (!(dollar || dollars || (moneyContext && /^\d/.test(m[2])) || (cue && !dateLike))) continue;
    if (!dollar && suffix === 'k' && !dollars) continue; // "24k BTU"
    const mult = suffix === 'k' || suffix === 'thousand' ? 1000 : suffix === 'million' ? 1e6 : 1;
    take('money', m[0], m.index, m.index + m[0].length, { value: canonNumber(Number(m[2].replace(/,/g, '')) * mult), approx: mult !== 1 });
  }
  // amounts in words: "three thousand four hundred seventy dollars"
  for (const m of text.matchAll(/\b((?:[a-z]+[\s-]){1,9})(?:dollars|bucks)\b/gi)) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    const words = m[1].trim().split(/[\s-]+/);
    for (let i = 0; i < words.length; i++) {
      const tail = words.slice(i).join(' '); const w = parseAmountAt(tail);
      if (w && w.length >= tail.length - 1) { take('money', m[0], m.index, m.index + m[0].length, { value: canonNumber(w.value) }); break; }
    }
  }
  // quantities by label (tonnage, hours, years): the number must be on the page
  if (qtyContext) for (const m of text.matchAll(/(?<![\w#/.\-])(\d+(?:\.\d+)?)(?![\w/\-])/g)) { if (!overlaps(m.index, m.index + m[0].length)) take('qty', m[0], m.index, m.index + m[0].length, { value: canonNumber(m[1]) }); }
  for (const m of text.matchAll(/(?<![\w#/.\-$,])(\d+(?:\.\d+)?)\s?-?\s?(?:tons?|hours?|hrs?|years?|yrs?|months?|days?|weeks?|seer|btus?|%|percent|psi|kwh|kw|kva|lbs?|oz|gal|gallons?|gpm|hp|cfm|amps?|volts?|ohms?|mfd|rpm|hz|ppm|ft|feet|foot|inch|inches|in\.?|sq\.?\s?ft|mph|°\s?[FC])(?![A-Za-z])/gi)) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    take('qty', m[1], m.index, m.index + m[0].length, { value: canonNumber(m[1]) });
  }
  for (const m of text.matchAll(/(?<![\w#/.\-$,])(\d+(?:\.\d+)?)\s?(?:V|A|°\s?[FC]?|degrees(?:\s[FC])?|[FC])(?![A-Za-z\d])/g)) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    take('qty', m[1], m.index, m.index + m[0].length, { value: canonNumber(m[1]), reading: true });
  }
  // person names
  const NAMEWORD = "(?:[A-Z]'[A-Z][a-z]+(?:-[A-Z][a-z]+)?|Mc[A-Z][a-z]+|[A-Z][a-z]+(?:-[A-Z][a-z]+)?)";
  const nameRe = new RegExp(`\\b((?:Dr\\.?\\s+|Mr\\.?\\s+|Mrs\\.?\\s+|Ms\\.?\\s+)?${NAMEWORD}(?:\\s+[A-Z]\\.?)?(?:\\s+${NAMEWORD}){1,2}(?:,?\\s+(?:Jr|Sr|II|III|IV)\\.?)?)`, 'g');
  const nameClaim = (phrase, start) => {
    const clean = phrase.replace(/[’]/g, "'").replace(/^(?:Dr|Mr|Mrs|Ms)\.?\s+/, '').replace(/,?\s+(?:Jr|Sr|II|III|IV)\.?$/, '').trim();
    if (!clean.includes(' ')) { if (/^[A-Z][a-z'’-]{2,}$/.test(clean) && !NAME_STOP.has(clean.toLowerCase()) && !overlaps(start, start + phrase.length)) take('name', clean, start, start + phrase.length, { value: clean, alts: [] }); return; }
    if (NOT_NAMES.has(clean.toLowerCase()) || overlaps(start, start + phrase.length)) return;
    const words = clean.split(/\s+/);
    take('name', clean, start, start + phrase.length, { value: clean, alts: words.length === 3 && !/^[A-Za-z]\.?$/.test(words[1]) ? [words.slice(0, 2).join(' ')] : [] });
  };
  if (nameContext) {
    if (/^[A-Z][a-z'’-]{2,}$/.test(text.trim())) nameClaim(text.trim(), text.indexOf(text.trim()));
    for (const bit of text.split(/\s*[·|;—–]\s*|\s+-\s+/)) {
      const b = bit.trim();
      if (/^[A-Z][A-Za-z'’-]+(?:\s+[A-Z]\.?)?(?:\s+[A-Z][A-Za-z'’-]+){1,3}(?:,?\s+(?:Jr|Sr|II|III|IV)\.?)?$/.test(b)) nameClaim(b, text.indexOf(b));
    }
  }
  const STRONG_CUE = /\b(?:customer|client|tenant|resident|technician|tech|vendor|landlord|billed to|bill to|sold to|attn|Mr\.?|Mrs\.?|Ms\.?|Dr\.?)\s+(?:is\s+|was\s+)?$/i;
  for (const m of text.matchAll(/\b(?:[A-Z][A-Z'’-]{1,}(?:\s+[A-Z]\.?)?(?:\s+[A-Z][A-Z'’-]{1,}){1,2}(?:,?\s+(?:JR|SR|II|III|IV)\.?)?)\b/g)) {
    const before = text.slice(0, m.index);
    if (!NAME_CUE.test(before)) continue;
    const words = m[0].split(/\s+/);
    nameClaim(words.map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(' '), m.index);
  }
  for (const m of text.matchAll(/\b([A-Z][a-z'’-]{2,})\b(?!\s+[A-Z])/g)) {
    if (!STRONG_CUE.test(text.slice(0, m.index))) continue;
    nameClaim(m[1], m.index);
  }
  for (const m of text.matchAll(/\b((?:[A-Z][A-Za-z&'’-]+\s+){1,3}(?:LLC|L\.L\.C\.|Inc\.?|Corp\.?|Co\.|Company|Ltd\.?|Plumbing|HVAC|Heating|Cooling|Air|Electric|Electrical|Mechanical|Services|Supply|Group|Contractors|Construction|Roofing|Properties|Management|HOA|Partners))\b/g)) {
    const words = m[1].split(/\s+/); if (words.length < 2 || NOT_NAMES.has(m[1].toLowerCase()) || overlaps(m.index, m.index + m[0].length)) continue;
    take('name', m[1], m.index, m.index + m[0].length, { value: m[1].replace(/[.,]+$/, ''), alts: words.length > 2 ? [words.slice(0, 2).join(' ')] : [], org: true });
  }
  for (const m of text.matchAll(nameRe)) {
    const before = text.slice(0, m.index); const after = text.slice(m.index + m[0].length);
    if (!(NAME_CUE.test(before) || /^'s\b/.test(after) || /^\.?\s+(?:owes|owe|has|have|is|was|paid|lives|called|at|on file|serviced|installed|performed|signed|arrived|visited|completed|inspected|requested|ordered|scheduled|reported|checked|replaced|handled|worked|owns|owned|met|contacted|issued|received|requested|visited|called|diagnosed|repaired|quoted|billed|charged|assigned)\b/.test(after) || (before.trim() === '' && /^\.?\s+(?:owes|has|is|was|paid|lives)\b/.test(after)))) continue;
    nameClaim(m[1], m.index);
  }
  return claims.sort((a, b) => a.start - b.start);
}

/* ------------------------------------------------------------------ support */
/** Is `claim` on the text `hay`? (hay = one document's page texts + that document's extracted rows) */
export function claimSupportedIn(claim, hay) {
  const h = deAccent(String(hay ?? ''));
  if (!h) return false;
  switch (claim.kind) {
    case 'money': return moneyNumbersIn(h).has(claim.value);
    case 'qty': { const hq = h.replace(DATE_RE, ' ').replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, ' ').replace(/\b\d{1,2}:\d{2}\b/g, ' ').replace(/\$\s?\d[\d,.]*/g, ' '); if (numbersIn(hq).has(claim.value)) return true; for (const m of hq.matchAll(/(?<![\w#/.,$])(\d+(?:\.\d+)?)(?:(?![\w]|[.,]\d)|(?=-[A-Za-z]))/g)) if (canonNumber(m[1]) === claim.value) return true; return false; }
    case 'email': { const esc = claim.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); return new RegExp(`(?<![\\w.+-])${esc}(?![\\w-])`).test(h.toLowerCase()); }
    case 'time': { const [hm, ap] = claim.value.split('-'); return [...h.toLowerCase().matchAll(/(?<![\d:.\/-])(\d{1,2})(?::(\d{2}))?\s?(am|pm)\b|(?<![\d:.\/-])(\d{1,2}):(\d{2})(?![\d:])/g)].some((m) => `${Number(m[1] ?? m[4]) % 12}:${String(Number(m[2] ?? m[5] ?? 0)).padStart(2, '0')}` === hm && (!ap || !m[3] || m[3] === ap)); }
    case 'city': return ` ${alnumNorm(h)} `.includes(` ${claim.value} `);
    case 'badweekday': return false;
    case 'monyear': { const [mo, yr] = claim.value.split('-').map(Number); return [...h.matchAll(new RegExp(`\\b(${MONTH_RE})\\.?,?\\s+(?:\\d{1,2}(?:st|nd|rd|th)?,?\\s+)?(\\d{4})\\b`, 'gi'))].some((m) => monthIndex(m[1]) === mo && Number(m[2]) === yr) || dateCandidates(h).some((d) => { const p = parseDateLoose(d); return p && p.m === mo && p.y === yr; }); }
    case 'phone': return [...h.matchAll(/\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}\b/g)].some((m) => m[0].replace(/\D/g, '').slice(-10) === claim.value);
    case 'id': { const hn = ` ${alnumNorm(h)} `; return hn.includes(` ${claim.value} `) || (claim.value.replace(/ /g, '').length >= 4 && tokenGlued(hn, claim.value)); }
    case 'date': { const c = dateCandidates(h); return c.some((d) => datesEqual(d, claim.value.replace(/(\d)(?:st|nd|rd|th)\b/i, '$1'))); }
    case 'mday': { const [mo, dy] = claim.value.split('-').map(Number); return [...h.matchAll(MD_RE_ANY)].some((m) => monthIndex(m[1]) === mo && Number(m[2]) === dy) || dateCandidates(h).some((d) => { const p = parseDateLoose(d); return p && p.m === mo && p.d === dy; }); }
    case 'address': { const hn = ` ${addrNorm(h)} `; return hn.includes(` ${claim.value} `); }
    case 'name': {
      const hn = ` ${alnumNorm(h)} `;
      const ok = (v) => { const words = alnumNorm(v).split(' ').filter(Boolean); if (hn.includes(` ${words.join(' ')} `)) return true; if (words.length === 2 && hn.includes(` ${words[1]} ${words[0]} `)) return true; return words.length === 3 && hn.includes(` ${words[0]} ${words[2]} `); };
      return ok(claim.value) || (claim.alts ?? []).some(ok);
    }
    default: return true;
  }
}
const MD_RE_ANY = new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi');
// id spaced-out variants ("INV T226" vs "INV-T226"): only trust the squashed match when the claim's alnum run appears whole inside one hay token-run
function tokenGlued(hn, value) { const sq = value.replace(/ /g, ''); return hn.split(' ').some((t, i, a) => { let acc = ''; for (let j = i; j < Math.min(a.length, i + 4); j++) { acc += a[j]; if (acc === sq) return true; if (!sq.startsWith(acc)) break; } return false; }); }

/* ------------------------------------------------------------------ the gate */
const SENT_SPLIT = /(?<=[.!?])\s+(?=[A-Z$#])(?<!\b(?:St|Rd|Ave|Apt|Dr|No|Mr|Mrs|Ms|Inc|Co|Ste|Ln|Blvd|vs|Jr|Sr)\.\s)(?<!\b[A-Z]\.\s)/;
export const splitSentences = (t) => String(t ?? '').split(SENT_SPLIT).map((x) => x.trim()).filter(Boolean);
/** clauses: a sentence that talks about several records ("INV-1 is $5 and INV-2 is $9") is checked clause by clause, so an amount cannot ride on the neighbouring record's id */
const splitClauses = (sent) => sent.split(/;\s+|\s+(?:and|while|whereas|but)\s+(?=[A-Z#$]|\w+-?\d)|,\s+(?=(?:invoice|inv|po|permit|serial)\b)/i).map((x) => x.trim()).filter(Boolean);

const docHay = (ev, id) => {
  const d = ev?.get?.(id);
  return d ? `${[...(d.pages?.values?.() ?? [])].join('\n')}\n${d.rows ?? ''}` : '';
};

const LABEL = {
  money: /\b(?:cost|costs|total|totals|amount|price|balance|paid|fee|fees|charge|charges|due|subtotal|tax|rent|deposit|invoiced|billed|quote|quoted|revenue|payment|premium|rate|worth|parts|labor cost|owed|outstanding|credit|refund|discount|monthly|annual|yearly)\b/i,
  name: /\b(?:customer|client|name|bill(?:ed)? to|owner|tenant|resident|technician|tech|vendor|landlord|contact|installed by|serviced by|performed by|signed by|sold to|attn|attention|person|occupant|lessee|contractor|account|company|business|insured|holder|manager|buyer|seller|applicant)\b/i,
  id: /\b(?:invoice|inv|po|purchase order|permit|serial|model|ticket|quote|estimate|job|work order|wo|reference|ref|policy|agreement|contract|confirmation|license|unit|apt|apartment|suite|account number|part number|part)\b\s*(?:#|no\.?|number|num)?/i,
  qty: /\b(?:ton|tons|tonnage|hours|hrs|labor|years?|term|seer|btu|qty|quantity|count|capacity|amps?|volts?|age|number of|units|days?|months?|weeks?|interval|duration|length|valid|efficiency|sq\.? ?ft|square feet|percent|warranty|frequency|visits)\b/i,
  phone: /\b(?:phone|tel|telephone|mobile|cell|fax)\b/i,
  email: /\b(?:email|e-mail)\b/i,
};
const NAME_SHAPED = /^[A-Z][A-Za-z'’-]+(?:\s+[A-Z]\.?)?(?:\s+[A-Z][A-Za-z'’-]+){1,3}(?:,?\s+(?:Jr|Sr|II|III|IV)\.?)?$/;
const NON_NAME_LABEL = /\b(?:status|type|brand|make|description|work|service|equipment|warranty|condition|notes?|category|system|location|city|refrigerant|manufacturer|product)\b/i;
export const factContext = (label, value) => {
  const l = String(label ?? ''); const v = String(value ?? '').trim();
  return {
    moneyContext: LABEL.money.test(l) && !/\d\s*-?\s*(?:years?|yrs?|months?|days?|hours?|hrs?|tons?|weeks?|seer|btus?)\b/i.test(v) && !/\bwarrant|\bterm\b/i.test(l), nameContext: LABEL.name.test(l) || /[·|]/.test(v) || (NAME_SHAPED.test(v) && !NON_NAME_LABEL.test(l)),
    idContext: LABEL.id.test(l) && !LABEL.money.test(l), qtyContext: LABEL.qty.test(l) && !LABEL.id.test(l), phoneContext: LABEL.phone.test(l), emailContext: LABEL.email.test(l),
  };
};
/** a name card's ROLE: a "Customer" card must be the bill-to / customer / tenant on the document, not its technician (when the document labels those roles at all) */
const ROLE_LINES = [
  [/\bcertificate\s+holder\b|\bholder\b/i, /\bcertificate\s+holder\b|\bholder\b/i],
  [/\b(?:claimant|payee|lienor|lien\s+claimant|subcontractor|payor)\b/i, /\b(?:claimant|payee|lienor|subcontractor|payor)\b/i],
  [/\b(?:producer|insurer|carrier|agency|agent)\b/i, /\b(?:producer|insurer|carrier|agency|agent)\b/i],
  [/\b(?:general\s+contractor|owner\/gc)\b/i, /\b(?:general\s+contractor)\b/i],
  [/\b(?:ship(?:ping)?[- ]?to|deliver\w*\s*to|job\s?site)\b/i, /\b(?:ship(?:ping)?[- ]?to|deliver\w*\s*to|job\s?site)\b/i],
  [/\b(?:customer|client|bill(?:ed)?\s*to|tenant|resident|sold\s*to|occupant|owner|insured|homeowner|lessee|buyer|applicant|prepared\s*for)\b/i, /\b(?:bill\s*to|billed\s*to|customer(?:_name)?|client|tenant|resident|sold\s*to|attn|occupant|owner|insured|homeowner|lessee|buyer|applicant|prepared\s*for)\b/i],
  [/\b(?:technician|tech|installed by|serviced by|performed by|crew)\b/i, /\b(?:technician|tech|installed by|serviced by|performed by|crew\s*lead|assigned to)\b/i],
  [/\b(?:landlord|lessor|manager)\b/i, /\b(?:landlord|lessor|manager|property\s*manager)\b/i],
  [/\b(?:vendor|supplier|seller|contractor)\b/i, /\b(?:vendor(?:_name)?|supplier|seller|contractor|remit)\b/i],
];
const ANY_ROLE = /\b(?:certificate\s+holder|claimant|payee|lienor|subcontractor|payor|producer|insurer|carrier|general\s+contractor|ship(?:ping)?[- ]?to|deliver\w*\s*to|job\s?site|bill\s*to|billed\s*to|customer|client|tenant|resident|sold\s*to|occupant|owner|insured|homeowner|lessee|buyer|applicant|prepared\s*for|technician|tech|installed by|serviced by|performed by|crew|landlord|lessor|manager|vendor|supplier|seller|contractor)\b/i;
function roleText(hay, label, withNext = false) {
  for (const [labelRe, lineRe] of ROLE_LINES) {
    if (!labelRe.test(String(label ?? ''))) continue;
    const all = String(hay ?? '').split('\n');
    const lines = all.flatMap((l, i) => (lineRe.test(l) ? (withNext && all[i + 1] != null && !/[:]/.test(all[i + 1].slice(0, 20)) ? [l, all[i + 1]] : [l]) : []));
    // a two-column line ("Bill To: Maria   Technician: Dale") only counts the part that carries this role's label
    const segs = withNext ? lines : lines.flatMap((l) => l.split(/\s{2,}|\t|\||;/).filter((x) => lineRe.test(x)));
    if (segs.length) return segs.join('\n');
    // the document labels roles but not this one: nothing on it can vouch for this card's role
    if (ANY_ROLE.test(String(hay ?? ''))) return '';
    return hay;
  }
  return hay;
}
/** the amount fields a document prints, by what the line calls them */
export const fieldAmounts = memo((h) => {
  const dueVals = new Set();
  const out = { total: new Set(), balance: new Set(), paid: new Set(), subtotal: new Set(), tax: new Set(), deposit: new Set(), closing: new Set(), opening: new Set(), pastdue: new Set(), minpay: new Set(), original: new Set(), newcontract: new Set(), thisco: new Set(), previous: new Set() };
  for (const line of String(h ?? '').split('\n')) {
    for (const seg0 of line.split(/\s{3,}|\t|\|/)) {
      const seg = seg0.replace(/_/g, ' ');
      const t = fieldOfText(seg, true); if (!t) continue;
      for (const m of seg.matchAll(/\$?\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d{2}|\d+)(?![\w/-])/g)) {
        if (!/\$/.test(m[0]) && !/[,.]/.test(m[1]) && !/total|amount|due|balance|paid|tax|deposit/i.test(seg)) continue;
        if (t.length === 2 && t[0] === 'total' && t[1] === 'balance') { dueVals.add(canonNumber(m[1])); continue; }
        for (const k of t) out[k].add(canonNumber(m[1]));
      }
    }
  }
  for (const v of dueVals) { out.balance.add(v); if (!out.total.size) out.total.add(v); }
  return out;
});
/** which amount field(s) a label / phrase names (null = no specific field). "Total Due" is the total; a bare "Amount Due" may be either the total or the balance. */
export function fieldOfText(t, forLine = false) {
  const x = String(t ?? '').toLowerCase();
  if (/\bnew\s+contract|\brevised\s+contract|\bcontract\s+(?:sum|total|price)|\bupdated\s+contract/.test(x)) return ['newcontract'];
  if (/\boriginal\s+contract|\boriginal\s+(?:sum|price|amount)/.test(x)) return ['original'];
  if (/\bprevious\s+(?:change|co|adjust)\w*|\bprior\s+(?:change|co)/.test(x)) return ['previous'];
  if (/\bthis\s+(?:change|co)\b|\bchange\s+order\s+(?:amount|total|#?\s*\d)|\bco\s*#?\s*\d+\s+(?:amount|total)/.test(x)) return ['thisco'];
  if (/\bpast\s+due\b|\boverdue\b/.test(x)) return ['pastdue'];
  if (/\bminimum\s+(?:payment|due)\b|\bmin\.?\s+payment\b/.test(x)) return ['minpay'];
  if (/\b(?:closing|ending|new)\s+balance\b|\bstatement\s+balance\b/.test(x)) return ['closing'];
  if (/\b(?:opening|previous|beginning|prior)\s+balance\b/.test(x)) return ['opening'];
  if (/sub-?\s?total/.test(x)) return ['subtotal'];
  if (/\btax(?:es)?\b|\bgst\b|\bvat\b/.test(x)) return ['tax'];
  if (/\bdeposit\s+paid\b|\bpaid\s+deposit\b|\bdeposit\s+received\b|\bdeposit\s+applied\b/.test(x)) return ['paid', 'deposit'];
  if (/\bdeposit\b|\bretainer\b|\bdown payment\b/.test(x)) return ['deposit'];
  if (/\b(?:amount\s+paid|paid|payments?(?:\s+received)?|collected|received)\b/.test(x) && !/\bpaid\s+by\b/.test(x)) return ['paid'];
  if (/\bbalance\b|\boutstanding\b|\bowe[sd]?\b|\bremaining\b/.test(x)) return forLine ? ['balance'] : ['balance', 'closing'];
  if (/\btotal\s+due\b|\bgrand\s+total\b|\binvoice\s+total\b|\btotal\b/.test(x)) return ['total'];
  if (/\bamount\s+due\b|\bdue\b/.test(x)) return ['total', 'balance'];
  if (!forLine && /\b(?:amount|cost|price|billed|charged?|invoiced|invoice\s+amount)\b/.test(x)) return ['total'];
  return null;
}
/** every total-like amount a document prints (a TOTAL / AMOUNT DUE line - not a subtotal), plus its financial row's total */
export function printedTotals(h) { return new Set(fieldAmounts(h).total); }
/** is `value` the amount the document prints under field(s) `types`? null when the document prints no such field and the field is the total (quotes/leases without a total line are not judged) */
function amountFieldOk(evidence, ids, types, value) {
  let any = false;
  for (const id of ids) {
    const fa = fieldAmounts(docHay(evidence, id));
    const d = evidence?.get?.(id);
    const tys = types.length === 2 && types[0] === 'total' && types[1] === 'balance' && fa.paid.size ? ['balance'] : types;
    for (const t of tys) {
      const set = new Set(fa[t]);
      if (t === 'total' && d?.totalNum != null) set.add(d.totalNum);
      if (t === 'balance' && d?.balanceNum != null) set.add(d.balanceNum);
      if (t === 'balance' && !set.size) { for (const x of fa.total) set.add(x); if (d?.totalNum != null) set.add(d.totalNum); } // an invoice that prints no balance owes its total
      if (set.size) any = true;
      if (set.has(value)) return true;
    }
  }
  if (!any && types.length === 1 && types[0] === 'total') return null;
  return false;
}
const NOT_FIELD = /\b(?:fee|fees|rate|per|monthly|annual|yearly|rent|hourly|labor|parts|discount|late|credit|refund|permit|equipment|materials?|shipping|travel|line|item)\b/i;
const labelField = (l) => {
  if (NOT_FIELD.test(String(l ?? ''))) return null;
  const t = fieldOfText(l);
  // a bare generic word ("Contactor price", "Capacitor cost") names a row, not the document total
  if (t && t.length === 1 && t[0] === 'total' && !/\b(?:total|due|invoice|grand)\b/i.test(String(l)) && bindTokens(l).length) return null;
  return t;
};
/**
 * label (or the words just before a value in a headline) -> the keyword the document's own line must carry. An Invoice Date is not the Due Date, Expires is not
 * Date issued, Monthly rent is not the deposit, a Certificate number is not the serial, Parts warranty is not the labor warranty. The CLOSEST cue to the value wins.
 */
const DATEISH = ['date', 'mday', 'monyear', 'time'];
const FIELD_RULES = [
  [DATEISH, /\b(?:expires?|expiry|expiration|expiring|valid\s+(?:until|through|thru|to)|good\s+through)\b/, { need: /expir|valid\s+(?:until|through|thru|to)|good\s+through|through|until/i }],
  [DATEISH, /\bdue\b|\bpay\s+by\b/, { need: /\bdue\b|pay\s+by|net\s*\d/i }],
  [DATEISH, /\binstall\w*/, { need: /install/i }],
  [DATEISH, /\b(?:start|starts|starting|begins?|commenc\w*|effective|move[- ]in)\b/, { need: /start|begin|commenc|effective|move[- ]in|\bfrom\b/i }],
  [DATEISH, /\b(?:end|ends|ending|terminat\w*|move[- ]out)\b/, { need: /\bend|terminat|expir|move[- ]out|through|until/i }],
  [DATEISH, /\b(?:arriv\w*|on\s*site|check[- ]in)\b/, { need: /arriv|on\s*site|start|\bin\b|check[- ]in/i }],
  [DATEISH, /\b(?:depart\w*|completed?|finish\w*|check[- ]out|left)\b/, { need: /depart|complet|finish|\bout\b|check[- ]out|end/i }],
  [DATEISH, /\binspect\w*/, { need: /inspect/i, not: /\b(?:next|due|valid|expires?|re-?inspect\w*)\b/i }],
  [DATEISH, /^\s*(?:the\s+)?(?:estimate|notice|issue|report|service|invoice|order|ticket|document|quote|visit)?\s*date\s*$|\bestimate\b|\bnotice\b/, { need: /date|estimate|notice|issued|dated/i, not: /\b(?:next|due|valid|expires?|expiry|cure|follow[- ]?up|renew\w*)\b/i }],
  [['money'], /\bfines?\b|\bpenalt\w+/, { need: /\bfines?\b|penalt/i, not: /\b(?:second|third|final|next|subsequent)\b/i }],
  [DATEISH, /\bscheduled?\b/, { need: /schedul/i }],
  [DATEISH, /\b(?:opened?|created|reported)\b/, { need: /open|creat|report/i }],
  [DATEISH, /\bclosed?\b/, { need: /clos/i }],
  [DATEISH, /\bperiod\b/, { need: /period/i }],
  [DATEISH, /\bthrough\b|\bthru\b/, { need: /through|thru|until|to\b/i }],
  [DATEISH, /\bsign\w*/, { need: /sign/i }],
  [DATEISH, /\b(?:purchas\w*|sold)\b/, { need: /purchas|sold|sale/i }],
  [DATEISH, /\b(?:invoice|issue|issued)\b/, { need: /\b(?:invoice|issued?|date)\b/i, not: /\bdue\b/i }],
  [['money'], /\b(?:rent|rental)\b/, { need: /rent/i }],
  [['money'], /\b(pet|late|application|admin\w*|cleaning|processing|trip|travel|disposal|permit|service)\s+(?:fees?|charges?)\b/, null],
  [['money'], /\b(?:fees?|charges?)\b/, { need: /\b(?:fees?|charges?)\b/i }],
  [['money'], /\boccurrence\b/, { need: /occurrence/i }],
  [['money'], /\baggregate\b/, { need: /aggregate/i }],
  [['money'], /\bdiscounts?\b/, { need: /discount|\boff\b|savings/i }],
  [['money'], /\bcredits?\b/, { need: /credit/i }],
  [['money'], /\blabou?r\b/, { need: /labou?r/i }],
  [['money'], /\b(?:parts?|materials?)\b/, { need: /parts?\b|materials?/i }],
  [['id'], /\b(?:asset|tag)\b/, { need: /asset|tag/i }],
  [['id'], /\bcertificate\b|\bcert\b/, { need: /certif|\bcert\b/i }],
  [['id'], /\bticket\b/, { need: /ticket/i }],
  [['id'], /\bwork\s*order\b|\bwo\b/, { need: /work\s*order|\bwo\b/i }],
  [['id'], /\bconfirmation\b/, { need: /confirm/i }],
  [['id'], /\bpolicy\b/, { need: /policy/i }],
  [['id'], /\blicen[sc]e\b/, { need: /licen[sc]e/i }],
  [['id'], /\b(?:account|acct)\b/, { need: /account|acct/i }],
  [['id', 'qty'], /\bparking\b/, { need: /parking|space/i }],
  [['id'], /\b(?:unit|apt|apartment|suite)\b/, { need: /unit|apt|apartment|suite|#/i }],
  [['id'], /\bserial\b/, { need: /\bserial\b|\bs\/n\b/i }],
  [['id'], /\bmodel\b/, { need: /\bmodel\b/i }],
  [['id'], /\bpermit\b/, { need: /\bpermit\b/i }],
  [['id'], /\b(?:po|purchase order)\b/, { need: /\bpo\b|p\.o\.|purchase order/i }],
  [['id'], /\binvoice\b|\binv\b/, { need: /\binvoice\b|\binv\b/i, not: /\b(?:po|p\.o\.|purchase order|serial|model|permit)\b/i }],
  [['qty'], /\bparts?\b/, { need: /\bparts?\b|compressor/i, window: true }],
  [['qty'], /\blabou?r\b/, { need: /\blabou?r\b/i, window: true }],
  [['qty'], /\bton/, { need: /\bton/i }],
  [['qty'], /\b(?:hours?|hrs)\b/, { need: /\b(?:hours?|hrs|labor)\b/i }],
  [['qty'], /\b(?:warrant\w*|years?|term)\b/, { need: /\b(?:warrant|years?|yrs?|term)\b/i }],
  [['qty'], /\bseer\b/, { need: /\bseer\b/i }],
  [['qty'], /\bbtu\b/, { need: /\bbtu\b/i }],
  [['qty'], /\bfilters?\b/, { need: /filter/i, window: true }],
  [['qty'], /\b(?:units?|systems?|machines?)\b/, { need: /unit|system|machine/i, window: true }],
];
export function lineRuleFor(kind, label, first = false) {
  const l = String(label ?? '').toLowerCase();
  let best = null;
  for (const [kinds, re, rule] of FIELD_RULES) {
    if (!kinds.includes(kind)) continue;
    const g = new RegExp(re.source, 'g'); let m; let last = null;
    while ((m = g.exec(l))) last = m;
    if (!last) continue;
    if (first) { m = new RegExp(re.source).exec(l); last = m; }
    const key = (first ? -last.index : last.index + last[0].length) + (!first && rule?.window ? 1000 : 0);
    if (!best || key >= best.end) best = { end: key, rule: rule ?? { need: new RegExp(last[1], 'i') } };
  }
  return best ? best.rule : null;
}
const escRe = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BIND_STOP = new Set(['the', 'a', 'an', 'of', 'to', 'for', 'and', 'or', 'in', 'on', 'at', 'by', 'is', 'was', 'are', 'were', 'be', 'it', 'its', 'this', 'that', 'with', 'from', 'per', 'as', 'has', 'have', 'had', 'will', 'would', 'about',
  'total', 'amount', 'price', 'cost', 'date', 'number', 'no', 'num', 'name', 'value', 'cust', 'customer', 'client', 'invoice', 'document', 'record', 'info', 'details', 'detail', 'listed', 'shown', 'inv', 'ticket', 'quote', 'permit', 'agreement', 'warranty', 'estimate', 'order', 'registration', 'charged', 'billed', 'due', 'owes', 'owe', 'owed', 'paid', 'pay', 'quote', 'quoted', 'estimate', 'show', 'shows', 'also', 'only', 'about', 'around', 'approximately', 'which', 'what', 'when', 'who', 'where', 'how', 'much', 'many', 'came', 'comes', 'come', 'covers', 'cover', 'includes', 'include', 'dated', 'on', 'file']);
const DISC = /^(?:annual|yearly|monthly|weekly|quarterly|next|last|previous|order|delivery|delivered|ship|shipping|visits?|amps?|ampacity|fuse|pressure|leakage|voltage|labou?r|parts?|rent|deposit|install\w*|start|end|expires?)/i;
const stem4 = (w) => w.slice(0, 4);
/** the discriminating words of a label (or of the words just before a value in a headline) that are NOT generic: "Option B", "Annual", "INV-1002", "Next service", "Delivery" */
function bindTokens(label, headline = false, rowWords = true) {
  const l = deAccent(String(label ?? '')).toLowerCase();
  const toks = [];
  const opt = /\b(option|plan|tier|package|choice|phase|bid|item|line|page|section|unit|building|bldg)\s*#?\s*([a-z0-9]{1,3})\b/.exec(l);
  if (opt) toks.push({ digit: true, re: new RegExp(`\\b${opt[1]}\\s*#?\\s*${opt[2]}\\b`, 'i') });
  for (const w of l.split(/[^a-z0-9]+/).filter(Boolean)) {
    if (opt && (w === opt[1] || w === opt[2])) continue;
    if (BIND_STOP.has(w)) continue;
    if (headline && !rowWords && !/\d/.test(w) && !DISC.test(w)) continue;
    if (/^\d{1,3}$/.test(w)) continue;
    if (/\d/.test(w)) { toks.push({ digit: true, re: new RegExp(`(?<![\\w.])${w}(?![\\w.])`, 'i') }); continue; }
    if (w.length < 3) continue;
    toks.push({ re: new RegExp(`\\b${escRe(stem4(w))}`, 'i') });
  }
  return headline ? toks.slice(-2) : toks;
}
/** does some line carrying the claim (plus a label-only line right above it) hold every discriminating label word that the document uses somewhere? */
function presentTokens(hay, label, headline = false, rowWords = true) {
  const toks = bindTokens(label, headline, rowWords);
  if (!toks.length) return [];
  const h = deAccent(String(hay ?? ''));
  const rowRe = rowWords ? /[$]\s?\d|\d+\.\d{2}/ : /[$]\s?\d|\d+\.\d{2}|\d\/\d/;
  const rowLayout = (t) => h.split('\n').some((ln) => t.re.test(ln) && rowRe.test(ln));
  return toks.filter((t) => (t.digit || headline ? rowLayout(t) : t.re.test(h)));
}
function boundToLabel(claim, hay, label, headline = false) {
  const present = presentTokens(hay, label, headline, claim.kind === 'money');
  const h = deAccent(String(hay ?? ''));
  if (!present.length) return true; // the label is the model's own wording: nothing on the document to bind it to
  const lines = h.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!claimSupportedIn(claim, lines[i])) continue;
    const win = lines[i] + (i > 0 && !/\d/.test(lines[i - 1]) ? `\n${lines[i - 1]}` : '');
    if (present.every((t) => t.re.test(win))) return true;
  }
  return false;
}
function onRuledLine(claim, hay, rule) {
  const lines = String(hay ?? '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!claimSupportedIn(claim, lines[i])) continue;
    if (rule.window && claim.kind === 'qty') {
      const re = new RegExp(`(?<![\\d.])${escRe(String(claim.raw).replace(/[^\d.]/g, ''))}(?![\\d])`, 'g'); let m;
      while ((m = re.exec(lines[i]))) {
        const L = lines[i]; const a0 = Math.max(L.lastIndexOf(',', m.index), L.lastIndexOf(';', m.index), m.index - 28); const nb = [L.indexOf(',', m.index), L.indexOf(';', m.index)].filter((x) => x >= 0);
        const b0 = Math.min(m.index + m[0].length + 28, ...(nb.length ? nb : [1e9]));
        if (rule.need.test(L.slice(Math.max(0, a0), b0))) return true;
      }
      continue;
    }
    const win = lines[i] + (i > 0 && lines[i].replace(/[^A-Za-z]/g, '').length <= 3 ? `\n${lines[i - 1]}` : '');
    if (!rule.need.test(win)) continue;
    if (rule.not && rule.not.test(lines[i])) continue;
    return true;
  }
  return false;
}

/**
 * @param {object} data       a model-composed answer ({kind, text, facts:[{label,value,sources:[{documentId,location}]}], sources, interpretation})
 * @param {Map<string,{pages:Map<number,string>, rows:string, label?:string, total?:string, totalNum?:string}>} evidence per cited document
 * @param {{question?: string, agent?: boolean}} opts agent: the answer came from the research agent (aggregates over many documents are legitimate there, so amounts in prose and in multi-document cards are not checked; everything else is)
 */
export function checkGrounding(data, evidence, { agent = false } = {}) {
  const failures = [];
  const facts = Array.isArray(data?.facts) ? data.facts : [];
  let checked = 0; let supported = 0;
  const factOk = facts.map((f, i) => {
    const docs = [...new Set((f.sources ?? []).map((s) => s.documentId))];
    if (agent && !docs.length) return true; // a record-derived card (no document cited): nothing to compare it with
    const pageCited = (f.sources ?? []).length > 0 && (f.sources ?? []).every((s) => typeof s?.location?.page === 'number');
    const own = [...extractClaims(`${f.value}`, factContext(f.label, f.value)), ...extractClaims(`${f.label}`, {})];
    const hays = docs.map((id) => docHay(evidence, id));
    let ok = true;
    for (const c of own) {
      if (agent && (c.kind === 'money' || c.kind === 'qty') && docs.length !== 1) continue; // aggregates over several documents are legitimate agent output; known residual (see report)
      checked++;
      let found = hays.some((h) => claimSupportedIn(c, h));
      if (found && c.kind === 'name') found = hays.some((h) => claimSupportedIn(c, roleText(h, f.label)));
      // a card labelled Total / Cost / Amount due is the document's TOTAL, not any other amount that happens to be on the page (subtotal, zip code, ...)
      if (found && c.kind === 'money') { const lf = labelField(f.label); if (lf && amountFieldOk(evidence, docs, lf, c.value) === false) found = false; }
      if (found && ['date', 'mday', 'monyear', 'time', 'id', 'qty', 'money'].includes(c.kind)) { const rule = lineRuleFor(c.kind, f.label); if (rule && !hays.some((h) => onRuledLine(c, h, rule))) found = false; }
      if (found && ['date', 'mday', 'monyear', 'time', 'qty', 'money', 'id'].includes(c.kind) && !hays.some((h) => boundToLabel(c, h, c.kind === 'id' ? String(f.label ?? '').replace(/\b(?:part|parts|tag|asset|serial|model|code|id|ref|reference|certificate|cert)\b/gi, ' ') : f.label))) found = false;
      if (found && ['address', 'city'].includes(c.kind) && /\b(?:ship|deliver\w*|bill\w*|job\s?site|site)\b/i.test(String(f.label ?? ''))) found = hays.some((h) => claimSupportedIn(c, roleText(h, f.label, true)));
      if (found) supported++; else { ok = false; failures.push({ where: 'fact', index: i, label: String(f.label ?? '').slice(0, 40), kind: c.kind, claim: c.raw.slice(0, 60), docs }); }
    }
    return ok;
  });

  const citedDocs = [...new Set([...(data?.sources ?? []), ...facts.flatMap((f) => f.sources ?? [])].map((s) => s?.documentId).filter(Boolean))];
  const textParts = [data?.text, data?.interpretation].filter((x) => typeof x === 'string' && x);
  const sentenceOk = [];
  textParts.forEach((part, pi) => { let carry = null; splitSentences(part).forEach((sent, si) => {
    let ok = true;
    for (const clause of splitClauses(sent)) {
      // agent answers may aggregate over many documents (amounts in prose are not checkable) - but a headline resting on ONE document is checked in full
      const single = agent && citedDocs.length === 1;
      const claims = extractClaims(clause).filter((c) => !agent || single || (['id', 'name', 'date', 'email', 'phone'].includes(c.kind) && citedDocs.length > 0));
      if (!claims.length) continue;
      const ids = claims.filter((c) => c.kind === 'id');
      let pool = carry && !ids.length ? carry : citedDocs;
      if (ids.length) {
        pool = citedDocs.filter((id) => ids.some((c) => claimSupportedIn(c, docHay(evidence, id))));
        if (!pool.length) { for (const c of ids) { checked++; failures.push({ where: pi ? 'interpretation' : 'text', sentence: si, kind: 'id', claim: c.raw.slice(0, 60), docs: citedDocs }); } ok = false; continue; }
        carry = pool.length < citedDocs.length ? pool : null;
        const absent = ids.filter((c) => !citedDocs.some((id) => claimSupportedIn(c, docHay(evidence, id))));
        if (absent.length) { for (const c of absent) { checked++; failures.push({ where: pi ? 'interpretation' : 'text', sentence: si, kind: 'id', claim: c.raw.slice(0, 60), docs: pool }); } ok = false; continue; }
      }
      else {
        const names = claims.filter((c) => c.kind === 'name');
        if (names.length) {
          const np = pool.filter((id) => names.some((c) => claimSupportedIn(c, docHay(evidence, id))));
          if (np.length) { pool = np; carry = np.length < citedDocs.length ? np : null; }
        }
      }
      // every claim of one clause must be on ONE document (the amount, the customer and the date of a record come from the same record)
      const rest = claims.filter((c) => c.kind !== 'id' || !ids.length);
      const oneDoc = pool.find((id) => rest.every((c) => claimSupportedIn(c, docHay(evidence, id))));
      if (ids.length) { const both = pool.filter((id) => rest.every((c) => claimSupportedIn(c, docHay(evidence, id)))); if (both.length && both.length < citedDocs.length) carry = both; }
      for (const c of rest) {
        checked++;
        const found = oneDoc != null || pool.some((id) => claimSupportedIn(c, docHay(evidence, id)));
        let fieldOk = true;
        if (found && c.kind === 'money') {
          const near = clause.slice(Math.max(0, c.start - 40), c.start + 1);
          const lf = /(?:subtotal|sub-total|tax(?:es)?|deposit|past due|minimum payment|closing balance|opening balance|new balance|original contract|new contract|revised contract|change order|paid|payment|collected|balance|outstanding|owes?|owed|remaining|total|amount|due|cost|price|billed|charged?|invoiced)\b[^.$]{0,40}\$?\s*$/i.exec(near);
          let types = lf ? fieldOfText(lf[0]) : null;
          if (types && types.length === 1 && types[0] === 'total' && !/\b(?:total|due|invoice|grand)\b/i.test(lf[0]) && (oneDoc != null ? [oneDoc] : pool).some((id) => presentTokens(docHay(evidence, id), clause.slice(0, c.start).split(/[.;:!?]\s/).pop().slice(-60), true).length)) types = null;
          if (types && amountFieldOk(evidence, oneDoc != null ? [oneDoc] : pool, types, c.value) === false) fieldOk = false;
        }
        if (found && ['date', 'mday', 'monyear', 'time', 'id', 'qty', 'money'].includes(c.kind) && !(c.kind === 'id' && ids.includes(c))) {
          const ctxText = c.kind === 'qty' ? clause.slice(c.start, c.start + 40).replace(/^(\d+(?:\.\d+)?)([\s\S]*?)(?=\d|$)/, '$1$2') : clause.slice(Math.max(0, c.start - 34), c.start);
          const rule = lineRuleFor(c.kind, c.kind === 'qty' ? ctxText.replace(/^[\d.]+/, '').split(/\d/)[0] : ctxText, c.kind === 'qty');
          if (rule && !(oneDoc != null ? [oneDoc] : pool).some((id) => onRuledLine(c, docHay(evidence, id), rule))) fieldOk = false;
        }
        if (found && fieldOk && c.kind === 'qty' && c.reading) {
          const lead = clause.slice(0, c.start).split(/[.;:!?]\s/).pop().slice(-26);
          if (!(oneDoc != null ? [oneDoc] : pool).some((id) => boundToLabel(c, docHay(evidence, id), lead, false))) fieldOk = false;
        }
        if (found && fieldOk && ['date', 'mday', 'monyear', 'time', 'money'].includes(c.kind)) {
          const lead = clause.slice(0, c.start).split(/[.;:!?]\s/).pop().slice(-60);
          if (!(oneDoc != null ? [oneDoc] : pool).some((id) => boundToLabel(c, docHay(evidence, id), lead, true))) fieldOk = false;
        }
        if (found && fieldOk && (oneDoc != null || rest.length === 1)) supported++;
        else { ok = false; failures.push({ where: pi ? 'interpretation' : 'text', sentence: si, kind: c.kind, claim: c.raw.slice(0, 60), docs: pool, glue: found }); }
      }
      checked += ids.length; supported += ids.length;
    }
    sentenceOk.push({ ok, interp: Boolean(pi) });
  }); });
  return { checked, supported, failures, factOk, textOk: sentenceOk.filter((x) => !x.interp).every((x) => x.ok), interpOk: sentenceOk.filter((x) => x.interp).every((x) => x.ok), sentenceOk: sentenceOk.map((x) => x.ok) };
}

/**
 * Apply the verdict. Returns a NEW answer object:
 *  - everything on its cited documents -> unchanged (plus an honest claimCheck);
 *  - a fact card with an unsupported value -> the card is removed;
 *  - an unsupported claim in the headline text -> the answer is withdrawn (kind 'no-answer', confidence 0, never "verified") with an honest line saying what the
 *    document does show; the caller may still hand the question to the slower path.
 */
export function applyGrounding(data, evidence, opts = {}) {
  let verdict;
  try { verdict = checkGrounding(data, evidence, opts); } catch { return failClosed(data, 'grounding check could not run'); }
  const claimCheck = { policy: 'grounding', checked: verdict.checked, supported: verdict.supported, unsupported: verdict.failures.slice(0, 8).map((f) => ({ kind: f.kind, claim: f.claim, origin: f.where })), rate: verdict.checked ? Math.round(((verdict.checked - verdict.supported) / verdict.checked) * 1000) / 1000 : 0, removedSentences: 0, removedFacts: 0 };
  if (!verdict.failures.length) return { ...data, claimCheck };
  const dropInterp = !verdict.interpOk ? { interpretation: undefined } : {};
  const keptFacts = (data.facts ?? []).filter((_, i) => verdict.factOk[i]);
  claimCheck.removedFacts = (data.facts ?? []).length - keptFacts.length;
  if (verdict.textOk && keptFacts.length) {
    const sources = keptFacts.flatMap((f) => f.sources ?? []);
    return { ...data, ...dropInterp, facts: keptFacts, sources, confidence: Math.min(Number.isFinite(data.confidence) ? data.confidence : 0.6, 0.7), claimCheck, groundingNote: 'Some details could not be confirmed on the cited documents and were left out.' };
  }
  return withdraw(data, evidence, verdict, claimCheck);
}

export const GROUNDING_NO_ANSWER = "I found a document that looks related, but I couldn't confirm the details of an answer against it, so I'm not going to state them.";

function describeDoc(evidence, id) { const d = evidence?.get?.(id); return d?.label ? `${d.label}` : 'the cited document'; }

function withdraw(data, evidence, verdict, claimCheck) {
  const first = verdict.failures.find((f) => f.kind === 'money') ?? verdict.failures[0];
  const doc = first?.docs?.[0];
  const d = doc ? evidence?.get?.(doc) : null;
  let detail = '';
  if (first && doc) {
    const what = first.kind === 'money' ? first.claim : `"${first.claim}"`;
    detail = ` ${describeDoc(evidence, doc)} does not show ${what}`;
    if (first.kind === 'money' && d?.total) detail += `; it shows a total of ${d.total}`;
    detail += '.';
  }
  const closest = [...new Set(verdict.failures.flatMap((f) => f.docs ?? []))].slice(0, 8).map((documentId) => ({ documentId, location: {} }));
  return {
    kind: 'no-answer', text: `${GROUNDING_NO_ANSWER}${detail}`.trim(), facts: [], sources: [], confidence: 0,
    verifiedCount: 0, unverifiedCount: 0, closest, claimCheck: { ...claimCheck, removedFacts: (data.facts ?? []).length }, groundingWithdrawn: true,
    ...(data.records ? {} : {}),
  };
}
function failClosed(data, why) {
  return { kind: 'no-answer', text: GROUNDING_NO_ANSWER, facts: [], sources: [], confidence: 0, verifiedCount: 0, unverifiedCount: 0, closest: data?.closest ?? [], groundingWithdrawn: true, claimCheck: { policy: 'grounding', checked: 0, supported: 0, unsupported: [{ kind: 'error', claim: why, origin: 'gate' }], rate: 1, removedSentences: 0, removedFacts: 0 } };
}

/* ------------------------------------------------------------------ evidence loader (one DB round trip) */
/**
 * Full page text + extracted rows + the money row of each cited document, tenant-scoped through `db` (a withTenant handle). Never throws: a document it cannot read is
 * simply absent from the map, and a claim attributed to an unreadable document is then UNSUPPORTED (fail closed).
 */
export async function loadGroundingEvidence(db, documentIds) {
  const ids = [...new Set((documentIds ?? []).filter((x) => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x)))].slice(0, 40);
  const ev = new Map();
  if (!ids.length) return ev;
  const pages = await db.raw(`SELECT p.document_id, p.page_no, p.text, d.original_filename FROM document_pages p JOIN documents d ON d.id = p.document_id WHERE p.document_id = ANY($1::uuid[]) ORDER BY p.document_id, p.page_no`, [ids]);
  for (const r of pages.rows) {
    if (!ev.has(r.document_id)) ev.set(r.document_id, { pages: new Map(), rows: '', label: r.original_filename ?? null });
    ev.get(r.document_id).pages.set(Number(r.page_no), String(r.text ?? ''));
  }
  try {
    const ex = await db.raw(`SELECT x.document_id, x.field_key, COALESCE(NULLIF(x.corrected_value, ''), x.value) AS value FROM extractions x WHERE x.document_id = ANY($1::uuid[])`, [ids]);
    for (const r of ex.rows) { const e = ev.get(r.document_id); if (e && r.value != null) e.rows += `${r.field_key}: ${r.value}\n`; }
  } catch { try {
    const ex = await db.raw(`SELECT x.document_id, x.field_key, x.value FROM extractions x WHERE x.document_id = ANY($1::uuid[])`, [ids]);
    for (const r of ex.rows) { const e = ev.get(r.document_id); if (e && r.value != null) e.rows += `${r.field_key}: ${r.value}\n`; }
  } catch { /* rows are an extra source of support; the page text above still stands */ } }
  return ev;
}
export async function loadFinancialRows(db, evidence) {
  try {
    const { extractionsHaveUnitIndex } = await import('../recordsStore.js');
    const { buildViewsSql } = await import('../agent/tools.js');
    const ids = [...evidence.keys()];
    if (!ids.length) return;
    const hu = await extractionsHaveUnitIndex(db);
    const views = buildViewsSql({ hasUnitIndex: hu, hasFinancials: true });
    const r = await db.raw(`WITH ${views} SELECT f.document_id, f.invoice_number, f.po_number, f.total, f.subtotal, f.tax, f.amount_paid, f.balance_due, f.invoice_date, f.due_date, f.customer_name, f.vendor_name FROM financials f WHERE f.document_id = ANY($2::uuid[])`, [JSON.stringify({ c: [], e: [] }), ids]);
    for (const row of r.rows) {
      const e = evidence.get(row.document_id); if (!e) continue;
      for (const [k, v] of Object.entries(row)) if (k !== 'document_id' && v != null && v !== '') e.rows += `${k}: ${v instanceof Date ? v.toISOString().slice(0, 10) : v}\n`;
      if (row.total != null) e.totalNum = canonNumber(row.total);
      if (row.balance_due != null) e.balanceNum = canonNumber(row.balance_due);
      if (row.total != null) e.total = `$${Number(row.total).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
  } catch { /* no financial row for this tenant / table missing: page text and extractions still stand */ }
}
