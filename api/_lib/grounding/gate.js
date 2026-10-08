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
import { initGate3, sentenceGuards, cardGuards, fixPages } from './gate3.js';
import { initGate2, setToday, foldConfusables, foldNumFormat, hasMixedScript, extraClaims, supportedExtra, detectRole, roleDefForLabel, nameRoleOk, addressRole, addressRoleOk, sectionsOf, methodOk, fam } from './gate2.js';

/* ------------------------------------------------------------------ normalisation helpers */
const INVISIBLE = /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;
const _daCache = new Map();
/** NFKC (fullwidth -> ascii), invisible / zero-width characters stripped, Arabic-Indic digits -> ascii, accents removed, dashes unified. Applied to BOTH the claim text and the document text. */
const deAccent = (s0) => {
  const s = String(s0 ?? '');
  if (s.length > 160) { const c = _daCache.get(s); if (c !== undefined) return c; }
  const out = foldConfusables(s.normalize('NFKC').replace(INVISIBLE, '')).replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - (d.charCodeAt(0) >= 0x06F0 ? 0x06F0 : 0x0660))).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\u2010-\u2015\u2212]/g, '-');
  if (s.length > 160) { if (_daCache.size > 400) _daCache.clear(); _daCache.set(s, out); }
  return out;
};
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
const DATE_RE = new RegExp(`\\b\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}\\b|\\b\\d{1,2}/\\d{1,2}/\\d{2,4}\\b|\\b${MONTH_RE}\\.?\\s+(?:the\\s+)?\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\.?,?\\s+\\d{4}\\b`, 'gi');
/** "the 21st of March 2026" / "March the 15th, 2026" / "15th March 2026" -> "21 March 2026" / "March 15, 2026" shapes parseDateLoose understands */
const cleanDate = (d) => String(d ?? '').replace(/\bthe\s+/gi, '').replace(/\s+of\s+/gi, ' ').replace(/(\d)(?:st|nd|rd|th)\b/gi, '$1').replace(/,?\s+(\d{4})$/, ', $1').replace(/^(\d{1,2}),/, '$1');
/** parseDateLoose plus the day-first slash form (15/03/2026) when it can only be day-first */
function parseDate(s) {
  const c = cleanDate(s);
  const p = parseDateLoose(c) ?? parseDateLoose(c.replace(/,\s+(\d{4})$/, ' $1'));
  if (p) return p;
  const ym = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(c);
  if (ym) return parseDateLoose(`${ym[1]}-${ym[2]}-${ym[3]}`);
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(c);
  if (m && Number(m[1]) > 12 && Number(m[1]) <= 31 && Number(m[2]) >= 1 && Number(m[2]) <= 12) { let y = Number(m[3]); if (y < 100) y += y < 70 ? 2000 : 1900; return { y, m: Number(m[2]), d: Number(m[1]) }; }
  return null;
}
const sameDate = (a, b) => { const x = parseDate(a); const y = parseDate(b); return Boolean(x && y && x.y === y.y && x.m === y.m && x.d === y.d); };
const dateCandidates = (s) => (String(s ?? '').match(DATE_RE) ?? []).map(cleanDate);
const RANGE_RE = new RegExp(`(?:${DATE_RE.source})\\s*(?:to|-|–|until|till|through|thru)\\s*(?:${DATE_RE.source})`, 'gi');
const ORD_WORDS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, 'twenty-first': 21, 'twenty-second': 22, 'twenty-third': 23, 'twenty-fourth': 24, 'twenty-fifth': 25, 'twenty-sixth': 26, 'twenty-seventh': 27, 'twenty-eighth': 28, 'twenty-ninth': 29, thirtieth: 30, 'thirty-first': 31 };
const ORDW = Object.keys(ORD_WORDS).sort((a, b) => b.length - a.length).join('|');
const MDW_RE = new RegExp(`\\b(${MONTH_RE})\\.?\\s+(?:the\\s+)?(${ORDW})\\b(?:,?\\s+(\\d{4})\\b)?|\\b(?:the\\s+)?(${ORDW})\\s+of\\s+(${MONTH_RE})\\b(?:,?\\s+(\\d{4})\\b)?`, 'gi');
const DAYMON_RE = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_RE})\\b(?!\\.?,?\\s*\\d{4})`, 'gi');
const MD_RE = new RegExp(`\\b(${MONTH_RE})\\.?\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\b(?!,?\\s*\\d{4})`, 'gi');
const DM_RE = new RegExp(`\\bthe\\s+(\\d{1,2})(?:st|nd|rd|th)\\s+of\\s+(${MONTH_RE})\\b(?!,?\\s*\\d{4})`, 'gi');
const monthIndex = (m) => ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(String(m).slice(0, 3).toLowerCase()) + 1;

const ORDINAL_OR_UNIT = /^\d+(?:st|nd|rd|th|k|m|x|g|ft|hr|hrs|yr|yrs|ton|tons|btu|btus|seer|amp|amps|v|w|kw|psi|gal|lb|lbs|am|pm|min|mins|sqft)$|^\d+-(?:year|years|yr|yrs|hour|hours|hr|hrs|month|months|day|days|week|weeks|inch|in|ton|tons|foot|ft|gallon|gal|amp|amps|volt|pound|lb|btu|seer)$|^\d{1,2}(?::\d\d)?(?:am|pm)(?:-\d{1,2}(?::\d\d)?(?:am|pm))?$/i;
const ID_RE = /(?<![\w-])(?=[A-Za-z0-9-]*\d)(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*(?![\w-])/g;
const ID_CUE_RE = /\b(?:invoice|inv|po|p\.o\.|permit|serial|model|ticket|work order|wo|quote|estimate|job|agreement|contract|policy|reference|ref|confirmation|license|licence)\s*(?:no\.?|number|num|#)?\s*[:#]?\s*#?(\d{3,})\b/gi;
/** any other noun that introduces a reference: "Account 99812", "Customer number 1042", "Order 5521", "Suite 410", "Room 3304", "Unit #7", "unit 5D" */
const ID_CUE2_RE = /\b(account|acct|customer|client|member|order|suite|ste|room|rm|unit|apt|apartment|lot|space|bldg|building|case|claim|tracking|reservation|badge|bay|slip)\s*(?:no\.?|number|num|id|#)?\s*[:#]?\s*#?\s*((?=[A-Za-z0-9-]*\d)[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)(?![\w-])/gi;
const CUE_GROUP = (c) => { const x = String(c).toLowerCase(); if (/^(?:account|acct|customer|client|member)$/.test(x)) return 'account|acct|customer|client|member|cust'; if (/^(?:order|case|claim|tracking|reservation)$/.test(x)) return 'order|po|purchase order|ticket|wo|work order|job|confirmation|reservation|case|claim|tracking|reference|ref'; return 'unit|apt|apartment|suite|ste|room|rm|space|bldg|building|lot|bay|slip|badge|#'; };
/** the WHOLE token after a cue (hyphens and slashes kept): "Serial 31-882-040", "S/N AB-77-12", "ROC 301874", "certificate no. C-5521" */
const ID_CUE3_RE = /\b(?:serial(?:\s*(?:no\.?|number|num|#))?|s\/n|roc|certificate(?:\s*(?:no\.?|number|num|#))?|cert(?:\s*(?:no\.?|#))?|lic(?:ense|ence)?(?:\s*(?:no\.?|number|num|#))?|registration(?:\s*(?:no\.?|number|#))?|vin|asset(?:\s*(?:tag|no\.?|#))?|sku|policy(?:\s*(?:no\.?|number|#))?|permit(?:\s*(?:no\.?|number|#))?)\b\.?\s*[:#]?\s*(?:no\.?\s*)?#?\s*(?=[A-Za-z0-9/-]*\d)([A-Za-z0-9]+(?:[-/][A-Za-z0-9]+)*)/gi;
const STREET_SUFFIX = '(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|way|ct|court|pl|place|pkwy|parkway|cir|circle|trl|trail|hwy|highway|ter|terrace)';
const ADDRESS_RE = new RegExp(`\\b\\d{1,6}\\s+(?:[NSEW]\\.?\\s+|north\\s+|south\\s+|east\\s+|west\\s+)?(?:[A-Za-z0-9.']+\\s+){0,3}${STREET_SUFFIX}\\b\\.?(?:,?\\s*(?:apt|apartment|unit|suite|ste|#)\\.?\\s*[A-Za-z0-9-]+)?`, 'gi');
const NAME_CUE = /\b(?:visited|met|contacted|emailed|owns|owned|handled|serviced|replaced|signed|issued to|sent to|assigned to|hired|represents|supplied|purchased from|belongs to|and|for|to|by|from|with|customer|client|tenant|resident|technician|tech|vendor|landlord|owner|attn|belongs to|billed to|bill to|sold to|name is|named|contact)\s+(?:is\s+|was\s+)?$/i;
const NAME_STOP = new Set(['the', 'this', 'that', 'there', 'our', 'your', 'his', 'her', 'its', 'a', 'an', 'unknown', 'none', 'invoice', 'customer', 'client', 'tenant', 'technician', 'owner', 'vendor', 'landlord', 'not', 'no', 'yes', 'on', 'file', 'name', 'company', 'service', 'unit', 'sonoran', 'deepwell']);
const NOT_NAMES = new Set(['sonoran comfort', 'comfort air', 'service address', 'bill to', 'total due', 'work order', 'purchase order', 'maintenance agreement', 'invoice date', 'service date', 'due date', 'not on', 'on file']);
/** capitalised words that are ordinary vocabulary (document labels, trade nouns, calendar words, function words) - never a person / company / brand on their own */
const GENERIC_WORDS = new Set(`invoice invoices estimate estimates quote quotes total subtotal tax taxes balance due amount amounts date dates service services address addresses customer customers client clients technician technicians tenant tenants landlord vendor vendors warranty warranties parts part labor labour work order orders permit permits agreement agreements contract contracts lease leases rent deposit fee fees credit credits memo memos refund refunds payment payments paid unpaid status water heater heaters conditioning conditioner unit units number numbers serial model equipment phone email property properties job jobs document documents record records page pages notes note description reference term terms start end hours hour visits visit maintenance repair repairs replacement installation install inspection system systems schedule scheduled monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec today tomorrow yesterday tonight morning afternoon evening noon midnight arizona az nevada california texas usa us united states america american english spanish id ok yes no na nan pdf sku qty usd eur dollars dollar cents percent first second third fourth fifth last next previous final new old open closed active inactive pending complete completed canceled cancelled expired overdue current late early annual monthly weekly yearly daily quarterly summary overview details detail info information results result match matches found report reports line lines item items card cards type types category categories name names label labels value values notice notices policy policies certificate certificates license licence licenses insurance insured holder producer carrier agency agent claim claims case cases account accounts bill billed ship shipping delivery deliver delivered site sites location locations floor floors room rooms building buildings suite suites apartment apartments apt lot space spaces parking bedroom bedrooms bathroom bathrooms kitchen garage attic basement roof coverage rate rates hourly discount discounts delivery notes summary`.split(/\s+/));
/** words that open a sentence / sit before a name without being part of it */
const FUNC_WORDS = new Set(`the this that these those there here it its he she they we you your our i if in on at for from to of by with as and but or so also per call email contact ask see show shows note please thanks thank hi hello dear regarding about after before during since until while when where which what who how why yes no not however therefore currently based according both each all any some most many one two three four five six seven eight nine ten then than too very just only still even again maybe perhaps unfortunately fortunately sorry sure okay mr mrs ms miss dr jr sr attn attention name named per cc fyi re let here's there's that's it's what's who's don't doesn't isn't wasn't can't won't also another other such same several few more less much over under between within without across among upon onto into out off up down am is are was were be been being has have had do does did will would shall should could can may might must get got give gave take took make made find found look looked check checked tell told ask asked need needed want wanted use used`.split(/\s+/));
const TITLE_RE = /\b(?:Mr|Mrs|Ms|Miss|Dr)\.?\s+/;
const CAPW = "(?:[OD]['’])?[A-Z][a-z]+(?:[A-Z][a-z]+)*(?:-[A-Z][a-z]+(?:[A-Z][a-z]+)*)*";
const CAP_RUN_RE = new RegExp(`(?<![A-Za-z0-9'’-])${CAPW}(?:[ \\t]+(?:[A-Z]\\.?(?=[ \\t]))?[ \\t]*${CAPW})*(?:['’]s)?(?![A-Za-z0-9-])`, 'g');
const LOWER_STOP = new Set([...FUNC_WORDS, ...GENERIC_WORDS, 'unknown', 'none', 'happy', 'satisfied', 'waiting', 'ready', 'here', 'away', 'home', 'present', 'available', 'unavailable', 'upset', 'angry', 'pleased', 'new', 'existing', 'returning', 'repeat', 'regular', 'local', 'residential', 'commercial', 'responsible', 'listed', 'named', 'shown', 'different', 'same', 'good', 'bad', 'great', 'fine', 'late', 'early', 'on', 'off', 'out', 'up']);

/* number words ("five", "twenty-five", "three and a half") */
const NUM_UNITS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const NUM_TENS = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const NUMW = '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fourty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)';
function wordsToNumber(phrase) {
  const toks = String(phrase).toLowerCase().split(/[\s-]+/).filter((t) => t && t !== 'and' && t !== 'a');
  let total = 0; let cur = 0; let seen = false;
  for (const t of toks) {
    if (t === 'half') { cur += 0.5; seen = true; } else if (t in NUM_UNITS) { cur += NUM_UNITS[t]; seen = true; } else if (t in NUM_TENS) { cur += NUM_TENS[t]; seen = true; }
    else if (t === 'hundred') { cur = (cur || 1) * 100; seen = true; } else if (t === 'thousand') { total += (cur || 1) * 1000; cur = 0; seen = true; } else return null;
  }
  return seen ? total + cur : null;
}
const TIME_UNITS = 'hours?|hrs?|years?|yrs?|months?|days?|weeks?';
const OLD_UNITS = `tons?|${TIME_UNITS}|seer|btus?|%|percent|psi|kwh|kw|kva|lbs?|oz|gal|gallons?|gpm|hp|cfm|amps?|volts?|ohms?|mfd|rpm|hz|ppm|ft|feet|foot|inch|inches|in\\.?|sq\\.?\\s?ft|mph|°\\s?[FC]`;
const NEW_UNITS = 'visits?|filters?|bedrooms?|bathrooms?|baths?|rooms?|parking\\s+spaces?|spaces?|stories|storys?|floors?|installments?|payments?|appointments?|inspections?|systems?|zones?|units?|technicians?|thermostats?|vents?|drains?|fixtures?|valves?|outlets?|breakers?|circuits?|panels?';
/** the noun a counted thing must sit next to on the page */
const NOUN_STEM = { visit: 'visit', filter: 'filter', bedroom: 'bedroom|\\bbr\\b|\\bbd\\b', bathroom: 'bathroom|\\bbath', bath: 'bath', room: 'room', parking: 'parking|space', space: 'space|parking', stor: 'stor(?:y|ies)', floor: 'floor', installment: 'installment|payment', payment: 'payment|installment', appointment: 'appointment|visit', inspection: 'inspection', system: 'system|unit', zone: 'zone', unit: 'unit|system', technician: 'technician|tech\\b', thermostat: 'thermostat', vent: 'vent', drain: 'drain', fixture: 'fixture', valve: 'valve', outlet: 'outlet', breaker: 'breaker', circuit: 'circuit', panel: 'panel' };
const nounKey = (u) => { const x = String(u).toLowerCase().replace(/\s+/g, ' '); const w = x.split(' ')[0].replace(/(?:ies|s)$/, (m) => (m === 'ies' ? 'y' : '')); if (w.startsWith('stor')) return 'stor'; return NOUN_STEM[w] ? w : null; };
const WORD_UNITS = `${TIME_UNITS}|percent|gallons?|tons?|btus?|amps?|volts?|seer|${NEW_UNITS}`;
const WORDQTY_RE = new RegExp(`\\b(${NUMW}(?:[\\s-]+(?:and[\\s-]+)?${NUMW})*(?:\\s+and\\s+a\\s+half)?)(?:\\s*-\\s*|\\s+)(${WORD_UNITS})\\b`, 'gi');
const COUNT_RE = new RegExp(`\\b(\\d{1,5}|${NUMW}(?:[\\s-]+(?:and[\\s-]+)?${NUMW})*)\\s+(?:open\\s+|unpaid\\s+|total\\s+|separate\\s+|different\\s+|more\\s+|other\\s+)?(invoices?|documents?|records?|customers?|jobs?|estimates?|quotes?|agreements?|contracts?|warrant(?:y|ies)|leases?|permits?|work orders?|statements?|receipts?)\\b`, 'gi');
const MONEYISH = /\b(?:total|owe[sd]?|owing|due|cost|costs|price|priced|paid|pay|charg\w*|bill\w*|invoice[sd]?|amount|balance|refund\w*|credit\w*|fee|fees|rent|deposit|tax|quote[sd]?|estimate[sd]?|payment|came|comes|sum|dollars?|usd|worth|receipt)\b/i;
const MONEY_CUE = /\b(?:total|totals|totalling|totaling|amount|due|balance|cost|costs|price|priced|paid|pay|owes|owed|owe|owing|charge|charged|fee|billed|invoiced|worth|deposit|rent|refund|refunded|credit|credited|reimbursed|subtotal|tax|payment|came to|comes to|come to|comes out to|came out to|coming to|sum of|adds up to|add up to|adding up to|equals|equal to|invoice for|invoice of|bill for|bill of|quoted|quote of|estimate of|rate of|discount of|payable|outstanding)\s*(?:of|is|was|at|:|=|to|for)?\s*(?:about\s*|around\s*|roughly\s*|approximately\s*)?$|=\s*$/;

const ORD = { '1st': 'first', '2nd': 'second', '3rd': 'third', '4th': 'fourth', '5th': 'fifth', '6th': 'sixth', '7th': 'seventh', '8th': 'eighth', '9th': 'ninth', '10th': 'tenth' };
const addrNorm = (s) => alnumNorm(String(s).replace(/\b(\d{1,2}(?:st|nd|rd|th))\b/gi, (m) => ORD[m.toLowerCase()] ?? m).replace(/\b(?:apartment|apt|unit|suite|ste)\b\.?/gi, 'unit').replace(/#\s*/g, 'unit '))
  .replace(/\b(street)\b/g, 'st').replace(/\b(avenue)\b/g, 'ave').replace(/\b(road)\b/g, 'rd').replace(/\b(drive)\b/g, 'dr').replace(/\b(lane)\b/g, 'ln').replace(/\b(boulevard)\b/g, 'blvd').replace(/\b(court)\b/g, 'ct').replace(/\b(place)\b/g, 'pl').replace(/\b(north)\b/g, 'n').replace(/\b(south)\b/g, 's').replace(/\b(east)\b/g, 'e').replace(/\b(west)\b/g, 'w');
/** names compare word-by-word with a hyphenated surname kept as ONE token ("okafor~smythe"), so "Wendell Okafor" is not "Wendell Okafor-Smythe" */
const nameNorm = (s) => deAccent(s).toLowerCase().replace(/[‘’]/g, "'").replace(/\bcompany\b/g, 'co').replace(/\bincorporated\b/g, 'inc').replace(/\bcorporation\b/g, 'corp').replace(/\blimited\b/g, 'ltd').replace(/(?<=[a-z])-(?=[a-z])/g, '~').replace(/'s\b/g, '').replace(/[^a-z0-9~]+/g, ' ').trim();
const roleOfBefore = (pre) => {
  const p = String(pre ?? '').toLowerCase();
  if (/\b(?:technician|tech|installed by|serviced by|performed by|crew lead)\s*(?:is|was|:|-)?\s*$/.test(p)) return 'technician';
  if (/\b(?:customer|client|tenant|resident|bill(?:ed)? to|sold to|homeowner|lessee|buyer|applicant|prepared for)\s*(?:is|was|:|-)?\s*$/.test(p)) return 'customer';
  if (/\b(?:landlord|lessor)\s*(?:is|was|:|-)?\s*$/.test(p)) return 'landlord';
  if (/\b(?:vendor|supplier|seller)\s*(?:is|was|:|-)?\s*$/.test(p)) return 'vendor';
  return null;
};

/**
 * Checkable claims in a string.
 * @param {string} s
 * @param {{moneyContext?: boolean, nameContext?: boolean, idContext?: boolean, qtyContext?: boolean, phoneContext?: boolean, emailContext?: boolean, capsAll?: boolean}} opts
 *   moneyContext: every number is an amount (a fact labelled "Cost"); nameContext: a whole capitalised value is a person name; idContext: the whole value is an identifier
 *   (invoice / PO / permit / serial / unit); qtyContext: the number is a quantity (tonnage, hours, years); phoneContext / emailContext: the value is a phone / email;
 *   capsAll: a card value (its first word is not just a sentence start)
 */
export function extractClaims(s, { moneyContext = false, nameContext = false, idContext = false, qtyContext = false, phoneContext = false, emailContext = false, capsAll = false, statusContext = false } = {}) {
  const text = deAccent(String(s ?? ''));
  const claims = [];
  const taken = [];
  const overlaps = (a, b) => taken.some(([x, y]) => a < y && b > x);
  const take = (kind, raw, start, end, extra = {}) => { claims.push({ kind, raw: raw.trim(), start, ...extra }); taken.push([start, end]); };
  // addresses first (they contain digits that must not be re-read as amounts). Street words must be capitalised / numeric (not "90812 is for Dr", "3 invoices from St").
  for (const m of text.matchAll(ADDRESS_RE)) {
    const mid = m[0].replace(/^\d+\s+/, '').replace(new RegExp(`\\b${STREET_SUFFIX}\\b.*$`, 'i'), '').trim().split(/\s+/).filter(Boolean);
    if (mid.some((w) => /^[a-z]/.test(w) && !/^(?:n|s|e|w|north|south|east|west)\.?$/i.test(w))) continue;
    const endAt = m.index + m[0].length;
    // the city / state / zip that follow are part of THIS address line (a zip that is elsewhere on the page - the vendor's - is not the job's zip)
    const tail = /^,?\s*([A-Z][A-Za-z.]+(?:\s[A-Z][A-Za-z.]+){0,2}),\s*([A-Z]{2})\b(?:\.?\s+(\d{5})\b)?/.exec(text.slice(endAt));
    const zipOnly = tail ? null : /^,?\s*(\d{5})\b/.exec(text.slice(endAt));
    const consumed = tail ? tail[0].length : zipOnly ? zipOnly[0].length : 0;
    take('address', m[0], m.index, endAt + consumed, { value: addrNorm(m[0]), city: tail ? alnumNorm(tail[1]) : null, zip: tail?.[3] ?? zipOnly?.[1] ?? null, arole: addressRole(text, m.index) });
  }
  // a PO Box address: the box, then the city / state / zip that belong to it (each still has to be on the page)
  for (const m of text.matchAll(/\bP\.?\s?O\.?\s*Box\s*#?\s*(\d+),?\s+([A-Z][A-Za-z.]+(?:\s[A-Z][A-Za-z.]+){0,2}),\s*([A-Z]{2})\b(?:\.?\s+(\d{5})\b)?/gi)) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    take('id', m[1], m.index, m.index + m[0].length, { value: alnumNorm(m[1]) });
    claims.push({ kind: 'city', raw: m[2], start: m.index, value: alnumNorm(m[2]) });
    if (m[4]) claims.push({ kind: 'id', raw: m[4], start: m.index, value: m[4] });
  }
  for (const m of text.matchAll(/\bP\.?\s?O\.?\s*Box\s*#?\s*(\d+)/gi)) { if (!overlaps(m.index, m.index + m[0].length)) take('id', m[1], m.index, m.index + m[0].length, { value: alnumNorm(m[1]) }); }
  for (const m of text.matchAll(/\b(?:zip(?:\s*code)?|postal\s*code)\s*(?:is|was|:|-)?\s*(\d{5})(?:-\d{4})?\b/gi)) { if (!overlaps(m.index, m.index + m[0].length)) take('id', m[1], m.index, m.index + m[0].length, { value: m[1] }); }
  for (const m of text.matchAll(/\b([A-Z][a-z]{2,}(?:\s[A-Z][a-z]{2,})?),\s*(?:AZ|CA|NV|NM|TX|UT|CO|FL|WA|OR|NY|IL|GA|NC|OH|PA|MI|AL|OK|ID|MT|WY|NE|KS|TN|VA|MN)\b/g)) {
    if (claims.some((c) => (c.kind === 'address' && c.city === alnumNorm(m[1]) && Math.abs(c.start - m.index) < 90) || (c.kind === 'city' && Math.abs(c.start - m.index) < 60 && c.value === alnumNorm(m[1])))) continue;
    if (overlaps(m.index, m.index + m[0].length)) continue;
    claims.push({ kind: 'city', raw: m[1], start: m.index, value: alnumNorm(m[1]) });
  }
  for (const m of text.matchAll(DATE_RE)) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    const pd = parseDate(m[0]);
    if (!pd) { take('unparsed', m[0], m.index, m.index + m[0].length, { value: m[0] }); continue; }
    take('date', m[0], m.index, m.index + m[0].length, { value: cleanDate(m[0]) });
    const wd = /\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?,?\s*$/i.exec(text.slice(Math.max(0, m.index - 14), m.index));
    if (wd && pd.y && pd.m && pd.d) {
      const real = new Date(Date.UTC(pd.y, pd.m - 1, pd.d)).getUTCDay();
      if (['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(wd[1].toLowerCase()) !== real) claims.push({ kind: 'badweekday', raw: wd[0].trim() + ' ' + m[0], start: m.index, value: 'weekday' });
    }
  }
  // a date range ("01/01/2026 to 01/01/2027", "from X to Y", "X - Y", "between X and Y", "X until Y"): both ends must be on the page, start before end
  for (const m of text.matchAll(RANGE_RE)) {
    const a = claims.find((c) => c.kind === 'date' && c.start === m.index); const b = claims.find((c) => c.kind === 'date' && c.start > m.index && c.start < m.index + m[0].length && c !== a);
    if (!a || !b) continue;
    a.range = 'start'; b.range = 'end';
    const pa = parseDate(a.raw); const pb = parseDate(b.raw);
    if (pa && pb && (pa.y * 372 + pa.m * 31 + pa.d) > (pb.y * 372 + pb.m * 31 + pb.d)) { a.rangeBad = true; b.rangeBad = true; }
  }
  for (const m of text.matchAll(MDW_RE)) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    const mo = monthIndex(m[1] ?? m[5]); const dy = ORD_WORDS[(m[2] ?? m[4]).toLowerCase()]; const yr = m[3] ?? m[6];
    if (yr) take('date', m[0], m.index, m.index + m[0].length, { value: `${mo}/${dy}/${yr}` }); else take('mday', m[0], m.index, m.index + m[0].length, { value: `${mo}-${dy}` });
  }
  for (const m of text.matchAll(/(?<![\d:.\/-])(\d{1,2})(?::(\d{2}))?\s?(am|pm)\b|(?<![\d:.\/-])(\d{1,2}):(\d{2})(?![\d:])/gi)) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    const hh = Number(m[1] ?? m[4]); const mm = Number(m[2] ?? m[5] ?? 0); const ap = (m[3] ?? '').toLowerCase();
    if (hh > 24 || mm > 59) continue;
    take('time', m[0], m.index, m.index + m[0].length, { value: `${hh % 12}:${String(mm).padStart(2, '0')}${ap ? `-${ap}` : ''}` });
  }
  for (const m of text.matchAll(new RegExp(`\\b(${MONTH_RE})\\.?,?\\s+(\\d{4})\\b`, 'gi'))) { if (!overlaps(m.index, m.index + m[0].length)) take('monyear', m[0], m.index, m.index + m[0].length, { value: `${monthIndex(m[1])}-${m[2]}` }); }
  for (const m of text.matchAll(MD_RE)) { if (overlaps(m.index, m.index + m[0].length)) continue; take('mday', m[0], m.index, m.index + m[0].length, { value: `${monthIndex(m[1])}-${Number(m[2])}` }); }
  for (const m of text.matchAll(DAYMON_RE)) { if (overlaps(m.index, m.index + m[0].length) || Number(m[1]) < 1 || Number(m[1]) > 31) continue; take('mday', m[0], m.index, m.index + m[0].length, { value: `${monthIndex(m[2])}-${Number(m[1])}` }); }
  for (const m of text.matchAll(DM_RE)) { if (overlaps(m.index, m.index + m[0].length)) continue; take('mday', m[0], m.index, m.index + m[0].length, { value: `${monthIndex(m[2])}-${Number(m[1])}` }); }
  // "Visa ending 4412", "card ending in 4412", "last 4 digits 4412", "****4412": the last digits of a card, an identifier (never an amount)
  for (const m of text.matchAll(/\b(?:ending(?:\s+in)?|ends(?:\s+in)?|last\s+(?:four|4)(?:\s+digits)?(?:\s+(?:of|are|is))?(?:\s+the\s+card)?)\s*[:#]?\s*(\d{4})\b|(?:x{2,}|\*{2,}|•{2,})[-\s]?(\d{4})\b/gi)) { if (!overlaps(m.index, m.index + m[0].length)) take('id', m[1] ?? m[2], m.index, m.index + m[0].length, { value: m[1] ?? m[2] }); }
  for (const m of text.matchAll(/(?<![\w#$/.-])(\d+(?:\.\d+)?)-(years?|months?|weeks?|days?)-old\b/gi)) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    take('qty', m[1], m.index, m.index + m[0].length, { value: canonNumber(m[1]), noun: null, unitRaw: m[2] });
  }
  for (const m of text.matchAll(ID_RE)) {
    if (overlaps(m.index, m.index + m[0].length) || ORDINAL_OR_UNIT.test(m[0]) || m[0].length < 4) continue;
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(m[0])) continue;
    take('id', m[0], m.index, m.index + m[0].length, { value: alnumNorm(m[0]) });
  }
  for (const m of text.matchAll(ID_CUE_RE)) { if (overlaps(m.index, m.index + m[0].length)) continue; take('id', m[1], m.index, m.index + m[0].length, { value: alnumNorm(m[1]) }); }
  for (const m of text.matchAll(ID_CUE2_RE)) { if (overlaps(m.index, m.index + m[0].length)) continue; take('id', m[2], m.index, m.index + m[0].length, { value: alnumNorm(m[2]), cue: m[1].toLowerCase() }); }
  for (const m of text.matchAll(ID_CUE3_RE)) {
    const tok = m[1]; if (!/\d/.test(tok) || tok.length < 3 || /^\d{4}-\d{1,2}-\d{1,2}$/.test(tok) || overlaps(m.index, m.index + m[0].length)) continue;
    take('id', tok, m.index, m.index + m[0].length, { value: alnumNorm(tok) });
  }
  for (const m of text.matchAll(/#\s?(\d{3,})\b/g)) { if (overlaps(m.index, m.index + m[0].length)) continue; take('id', m[1], m.index, m.index + m[0].length, { value: alnumNorm(m[1]) }); }
  // email / phone / url (whole-value, by label)
  for (const m of text.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) take('email', m[0], m.index, m.index + m[0].length, { value: m[0].toLowerCase() });
  for (const m of text.matchAll(/(?<![\w-])(?:\+?1[\s.-]*)?\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}(?![\w-])/g)) { if (!overlaps(m.index, m.index + m[0].length)) take('phone', m[0], m.index, m.index + m[0].length, { value: m[0].replace(/\D/g, '').slice(-10) }); }
  for (const m of text.matchAll(/(?<![\w-])\d{3}-\d{4}(?![\w-])/g)) { if (!overlaps(m.index, m.index + m[0].length)) take('phone', m[0], m.index, m.index + m[0].length, { value: m[0].replace(/\D/g, ''), local: true }); }
  for (const m of text.matchAll(/(?<![\w@.-])(?:https?:\/\/)?(?:www\.)?([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|us|biz|info|gov|edu|app|dev|ai))(?![\w-])(?:\/[^\s,;)]*)?/gi)) { if (!overlaps(m.index, m.index + m[0].length)) take('url', m[0], m.index, m.index + m[0].length, { value: m[1].toLowerCase() }); }
  // whole-value identifiers by label ("Invoice #": "43", "Serial": "4821908", "Unit": "#4C")
  if (idContext) {
    const v = text.replace(/^[#\s]+/, '').trim();
    if (/^[A-Za-z0-9][A-Za-z0-9 -]{0,30}$/.test(v) && /\d/.test(v) && !overlaps(0, text.length)) take('id', v, 0, text.length, { value: alnumNorm(v) });
  }
  // payment terms / payment status asserted in prose
  for (const m of text.matchAll(/\bnet\s*-?\s*(\d{1,3})\b/gi)) { if (!overlaps(m.index, m.index + m[0].length)) take('terms', m[0], m.index, m.index + m[0].length, { value: String(Number(m[1])) }); }
  for (const m of text.matchAll(/\b(paid\s+in\s+full|fully\s+paid|paid\s+off|paid\s+by\s+(?:check|cheque|cash|credit\s+card|card|ach|wire|venmo|zelle))\b/gi)) { if (!overlaps(m.index, m.index + m[0].length)) take('status', m[0], m.index, m.index + m[0].length, { value: /by/i.test(m[1]) ? `by ${m[1].toLowerCase().replace(/^paid\s+by\s+/, '').replace(/credit\s+card/, 'card').replace('cheque', 'check')}` : 'full' }); }
  // money. $-prefixed amounts are ALWAYS claims, whatever follows ("$79/month", "-$3,470.00", "$9,999-$12,000"); other amounts by context or a cue word or "dollars" / a currency code
  const moneyish = MONEYISH.test(text);
  const NUMRE = /(?<![\w#/.,])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{1,3}(?:\.\d{3})+,\d{1,2}(?!\d)|\d+(?:\.\d+)?)(?:(?=\s?(?:thousand|million|billion|grand|mm|bn|k|m|b)\b)|(?![\w]|[.,]\d))/gi;
  for (const m of text.matchAll(NUMRE)) {
    let a = m.index; const z = m.index + m[0].length;
    if (overlaps(a, z)) continue;
    const raw = m[1];
    const pre = text.slice(Math.max(0, a - 8), a);
    let neg = false; let sym = false; let cur = null;
    const p1 = /(?:([$€£¥₹])|\b(usd|eur|gbp|cad|mxn|aud|nzd|jpy|cny|inr|chf|brl|zar|us\$|c\$|ca\$|mx\$|a\$|au\$)\s?)\s?(-\s?)?$/i.exec(pre); const p2 = /(-)\s?[$€£]\s?$/.exec(pre); const p3 = /\(\s?[$€£]?\s?$/.exec(pre);
    if (p1) { sym = true; const lm = /-\s?$/.exec(pre.slice(0, pre.length - p1[0].length)); neg = Boolean(p1[3]) || Boolean(lm); a -= p1[0].length + (lm ? lm[0].length : 0); const cs = (p1[1] ?? p1[2]).toLowerCase(); if (cs !== '$' && cs !== 'usd' && cs !== 'us$') cur = CUR_KEY[cs] ?? cs; } else if (p2) { sym = true; neg = true; a -= p2[0].length; } else if (p3 && /^\s?\)/.test(text.slice(z))) { neg = true; a -= p3[0].length; }
    const tailTxt = text.slice(z, z + 24).toLowerCase();
    const suf = /^\s?(thousand|million|billion|grand|mm|bn|k|m|b)\b/.exec(tailTxt);
    const rest = suf ? tailTxt.slice(suf[0].length) : tailTxt;
    const dollars = /^\s*(?:dollars?|bucks?|usd|eur|euros?|gbp|cad|mxn|aud|nzd|jpy|yen|cny|yuan|inr|rupees?|chf|francs?|pesos?|brl|zar|rand|\$)(?![A-Za-z])/.test(rest);
    const before = text.slice(Math.max(0, a - 28), a).toLowerCase();
    const cue = MONEY_CUE.test(before);
    const afterCue = /^\s*(?:is|are|was|were)\s+(?:owed|due|outstanding|payable|charged|billed|invoiced)\b/.test(tailTxt);
    const dateLike = /[/\-]$/.test(text.slice(Math.max(0, m.index - 1), m.index)) && !sym || /^[/-]\d/.test(text.slice(z));
    const rc = /^\s*(eur|euros?|gbp|cad|mxn|aud|nzd|jpy|yen|cny|yuan|inr|rupees?|chf|francs?|pesos?|brl|zar|rand)\b/.exec(rest); if (rc && !cur) cur = CUR_KEY[rc[1]] ?? rc[1];
    const isGrand = suf?.[1] === 'grand';
    const isMoney = sym || dollars || isGrand || (moneyContext && /^\d/.test(raw)) || ((cue || afterCue) && !dateLike);
    if (!isMoney) continue;
    if (/^\d{1,3}(?:\.\d{3})+,\d{1,2}$/.test(raw)) { take('unparsed', text.slice(a, z), a, z, { value: raw }); continue; }
    const s1 = suf?.[1];
    if (s1 && /^(?:k|m|mm|b|bn)$/.test(s1) && !(sym || dollars || cue || (moneyish && !/^\s?btu/i.test(rest)))) continue; // "24k BTU", "50 m"
    const mult = s1 === 'k' || s1 === 'thousand' || s1 === 'grand' ? 1000 : s1 === 'million' || s1 === 'm' || s1 === 'mm' ? 1e6 : s1 === 'billion' || s1 === 'b' || s1 === 'bn' ? 1e9 : 1;
    const end = z + (suf ? suf[0].length : 0);
    take('money', text.slice(a, end), a, end, { value: canonNumber(Number(raw.replace(/,/g, '')) * mult), approx: mult !== 1, neg, cur });
  }
  // amounts in words: "three thousand four hundred seventy dollars [and fifteen cents]"
  for (const m of text.matchAll(/\b((?:[a-z]+[\s-]){1,9})(?:dollars?|bucks?)\b/gi)) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    const words = m[1].trim().split(/[\s-]+/);
    for (let i = 0; i < words.length; i++) {
      const tail = words.slice(i).join(' '); const w = parseAmountAt(tail);
      if (w && w.length >= tail.length - 1) {
        let value = Number(w.value); let endAt = m.index + m[0].length;
        const cents = /^\s*(?:and\s+)?(\d{1,2}|(?:[a-z]+[\s-]){0,2}[a-z]+)\s+cents?\b/i.exec(text.slice(endAt));
        if (cents) { const cv = /^\d+$/.test(cents[1]) ? Number(cents[1]) : wordsToNumber(cents[1]); if (cv != null && cv < 100) { value += cv / 100; endAt += cents[0].length; } }
        const wstart = m.index + ([...m[1].matchAll(/[A-Za-z]+/g)][i]?.index ?? 0);
        take('money', text.slice(wstart, endAt), wstart, endAt, { value: canonNumber(value) }); break;
      }
    }
  }
  // quantities by label (tonnage, hours, years): the number must be on the page
  if (qtyContext) for (const m of text.matchAll(/(?<![\w#/.\-])(\d+(?:\.\d+)?)(?![\w/\-])/g)) { if (!overlaps(m.index, m.index + m[0].length)) { const un = /^\s*-?\s*(years?|yrs?|months?|mos?|weeks?|wks?|days?|hours?|hrs?|minutes?|mins?|%|percent)(?![A-Za-z])/i.exec(text.slice(m.index + m[0].length)); take('qty', m[0], m.index, m.index + m[0].length + (un ? un[0].length : 0), { value: canonNumber(m[1]), ...(un ? { unitRaw: un[1], noun: null } : {}) }); } }
  const qtyRe = new RegExp(`(?<![\\w#/.\\-$,])(\\d+(?:\\.\\d+)?)\\s?-?\\s?(${OLD_UNITS}|${NEW_UNITS})(?![A-Za-z])`, 'gi');
  for (const m of text.matchAll(qtyRe)) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    const nk = new RegExp(`^(?:${NEW_UNITS})$`, 'i').test(m[2].replace(/\s+/g, ' ')) && !new RegExp(`^(?:${TIME_UNITS})$`, 'i').test(m[2]) ? nounKey(m[2]) : null;
    take('qty', m[1], m.index, m.index + m[0].length, { value: canonNumber(m[1]), noun: nk, unitRaw: m[2] });
  }
  for (const m of text.matchAll(WORDQTY_RE)) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    const v = wordsToNumber(m[1]); if (v == null) continue;
    const isTime = new RegExp(`^(?:${TIME_UNITS}|%|percent)$`, 'i').test(m[2]);
    if (/^one$/i.test(m[1].trim()) && !isTime) continue;
    const nk = new RegExp(`^(?:${NEW_UNITS})$`, 'i').test(m[2].replace(/\s+/g, ' ')) && !isTime ? nounKey(m[2]) : null;
    take('qty', m[1], m.index, m.index + m[0].length, { value: canonNumber(v), noun: nk, unitRaw: m[2] });
  }
  for (const m of text.matchAll(/(?<![\w#/.\-$,])(\d+(?:\.\d+)?)\s?(?:V|A|°\s?[FC]?|degrees(?:\s[FC])?|[FC])(?![A-Za-z\d])/g)) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    take('qty', m[1], m.index, m.index + m[0].length, { value: canonNumber(m[1]), reading: true });
  }
  for (const m of text.matchAll(COUNT_RE)) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    const v = /^\d+$/.test(m[1]) ? Number(m[1]) : wordsToNumber(m[1]); if (v == null) continue;
    take('count', m[0], m.index, m.index + m[0].length, { value: String(v) });
  }
  // hyphenated digit identifiers with no cue ("31-882-040"); dates, phones and ranges are not
  for (const m of text.matchAll(/(?<![\w-])\d{2,}(?:-\d{2,}){1,3}(?![\w-])/g)) {
    const g = m[0].split('-'); if (overlaps(m.index, m.index + m[0].length) || /^\d{4}-\d{1,2}-\d{1,2}$/.test(m[0])) continue;
    if (!(g.length >= 3 || (g.length === 2 && g.every((x) => x.length >= 3)))) continue;
    if (g.length === 2 && g[0].length === 5 && g[1].length === 4) continue; // zip+4
    take('id', m[0], m.index, m.index + m[0].length, { value: alnumNorm(m[0]) });
  }
  extraClaims(text, { take, overlaps, claims, statusContext });
  // a bare four-digit year
  for (const m of text.matchAll(/(?<![\w$#/.,:-])((?:19|20)\d{2})(?![\w/-]|[.,]\d)/g)) { if (!overlaps(m.index, m.index + m[0].length)) take('year', m[1], m.index, m.index + m[0].length, { value: m[1] }); }
  // any other money-looking number in a sentence that talks about money is an amount too (comma-grouped, two decimals, or 3+ digits)
  if (moneyish || moneyContext) for (const m of text.matchAll(/(?<![\w#/.,\-])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d{2}|\d{3,})(?![\w]|[.,]\d|[/-]\d)/g)) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    take('money', m[0], m.index, m.index + m[0].length, { value: canonNumber(Number(m[1].replace(/,/g, ''))), neg: false, loose: true });
  }
  // person names
  const NAMEWORD = "(?:[A-Z]'[A-Z][a-z]+(?:-[A-Z][a-z]+)?|Mc[A-Z][a-z]+|[A-Z][a-z]+(?:-[A-Z][a-z]+)?)";
  const nameClaim = (phrase, start, extra = {}) => {
    const clean = phrase.replace(/[’]/g, "'").replace(/^(?:Dr|Mr|Mrs|Ms)\.?\s+/, '').replace(/^(?:(?:Vice\s+)?President|Director|Treasurer|Secretary|Chairman|Chairwoman|Manager|Owner|Principal|Supervisor)\s+(?=[A-Z][a-z]+\s+[A-Z])/, '').replace(/,?\s+(Jr|Sr|II|III|IV)\.?$/, ' $1').trim();
    const role = detectRole(text, start, start + phrase.length, TITLE_RE.exec(text.slice(Math.max(0, start - 8), start))?.[0] ?? null);
    if (!clean.includes(' ')) { if (/^[A-Z][a-z'’-]{2,}$/.test(clean) && !NAME_STOP.has(clean.toLowerCase()) && !overlaps(start, start + phrase.length)) take('name', clean, start, start + phrase.length, { value: clean, role, ...extra }); return; }
    if (NOT_NAMES.has(clean.toLowerCase()) || overlaps(start, start + phrase.length)) return;
    take('name', clean, start, start + phrase.length, { value: clean, role, ...extra });
  };
  if (nameContext) {
    if (/^[A-Z][a-z'’-]{2,}$/.test(text.trim())) nameClaim(text.trim(), text.indexOf(text.trim()));
    for (const bit of text.split(/\s*[·|;—–]\s*|\s+-\s+/)) {
      const b = bit.trim();
      const lf = /^([A-Z][A-Za-z'’-]+),\s+([A-Z][a-z'’-]+(?:\s+[A-Z]\.?)?)$/.exec(b); // "Quimby, Delbert" (Last, First)
      if (lf && !/^[A-Z]{2,3}$/.test(lf[2])) { nameClaim(`${lf[2]} ${lf[1]}`.replace(/\s+[A-Z]\.?\s+/, ' '), text.indexOf(b), { lastFirst: true }); continue; }
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
  // a title + a name ("Mr. Parrish", "mrs. gideon parrish")
  for (const m of text.matchAll(/\b(?:Mr|Mrs|Ms|Miss|Dr|mr|mrs|ms|miss|dr)\.?\s+([A-Za-z][A-Za-z'’-]+(?:\s+[A-Za-z][A-Za-z'’-]+){0,1})/g)) {
    const words = [];
    for (const w of m[1].split(/\s+/)) { if (words.length && (/^[a-z]/.test(words[0]) !== /^[a-z]/.test(w))) break; if (/^[a-z]/.test(w) && (LOWER_STOP.has(w) || /(?:ing|ly|ed)$/.test(w))) break; if (/^[A-Z]/.test(w) && GENERIC_WORDS.has(w.toLowerCase())) break; words.push(w); }
    if (!words.length) continue;
    const ph = words.join(' ');
    if (NAME_STOP.has(ph.toLowerCase())) continue;
    const start = m.index + m[0].length - m[1].length;
    if (overlaps(start, start + ph.length)) continue;
    const title = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    take('name', title, start, start + ph.length, { value: title, role: detectRole(text, start, start + ph.length, m[0]), title: true });
  }
  // lower-case names after a role word ("the customer is delbert quimby")
  for (const m of text.matchAll(/\b(?:[Cc]ustomer|[Cc]lient|[Tt]enant|[Tt]echnician|[Tt]ech|[Ll]andlord|[Vv]endor|[Oo]wner|[Bb]illed to|[Bb]ill to|[Ss]old to|[Ss]igned by|[Cc]ontact|[Aa]ttn)\s*(?:is\s+|was\s+|:\s*)?([a-z][a-z'’-]+(?:\s+[a-z][a-z'’-]+){1,2})/g)) {
    const words = []; for (const w of m[1].split(/\s+/)) { if (LOWER_STOP.has(w) || /(?:ing|ly)$/.test(w)) break; words.push(w); }
    if (words.length < 2) continue;
    const start = m.index + m[0].length - m[1].length; const ph = words.join(' ');
    if (overlaps(start, start + ph.length)) continue;
    take('name', ph.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '), start, start + ph.length, { value: ph, role: detectRole(text, start, start + ph.length, null) });
  }
  for (const m of text.matchAll(/\b([A-Z][a-z'’-]{2,})\b(?!\s+[A-Z])/g)) {
    if (!STRONG_CUE.test(text.slice(0, m.index))) continue;
    nameClaim(m[1], m.index);
  }
  for (const m of text.matchAll(/\b((?:[A-Z][A-Za-z&'’-]+\s+){1,3}(?:LLC|L\.L\.C\.|Inc\.?|Corp\.?|Co\.|Company|Ltd\.?|Plumbing|HVAC|Heating|Cooling|Air|Electric|Electrical|Mechanical|Services|Supply|Group|Contractors|Construction|Roofing|Properties|Management|HOA|Partners))\b/g)) {
    const words = m[1].split(/\s+/); if (words.length < 2 || NOT_NAMES.has(m[1].toLowerCase()) || overlaps(m.index, m.index + m[0].length)) continue;
    let lead = 0; while (words.length - lead > 2 && (FUNC_WORDS.has(words[lead].toLowerCase()) || GENERIC_WORDS.has(words[lead].toLowerCase()))) lead++;
    const org = words.slice(lead).join(' '); const ostart = m.index + m[1].indexOf(org, lead ? words.slice(0, lead).join(' ').length : 0);
    take('name', org, ostart, m.index + m[0].length, { value: org.replace(/[.,]+$/, ''), org: true });
  }
  // every other capitalised run (a person, company, brand, city...): the whole thing must be on the cited document. Ordinary vocabulary at its edges is not part of it.
  for (const m of text.matchAll(CAP_RUN_RE)) {
    const start0 = m.index; let phrase = m[0]; let poss = false;
    if (/['’]s$/.test(phrase)) { poss = true; phrase = phrase.replace(/['’]s$/, ''); }
    const before = text.slice(0, start0).trimEnd();
    const initial = !capsAll && (before === '' || /[.!?\n]$/.test(before) || /(?:^|\n)\s*(?:[*•>#-]+|\d+[.)])$/.test(before));
    let words = phrase.split(/\s+/); let off = 0; let stripped = false;
    const edgeWord = (w) => FUNC_WORDS.has(w.toLowerCase()) || GENERIC_WORDS.has(w.toLowerCase()) || w.length < 3 && /^[A-Z]\.?$/.test(w);
    for (;;) {
      if (words.length && edgeWord(words[0])) { off += words[0].length + 1; words = words.slice(1); stripped = true; continue; }
      if (words.length > 1 && initial && !stripped && off === 0 && /(?:ed|ing|ly)$/.test(words[0])) { off += words[0].length + 1; words = words.slice(1); stripped = true; continue; }
      break;
    }
    while (words.length && edgeWord(words[words.length - 1])) words = words.slice(0, -1);
    if (!words.length) continue;
    const start = start0 + off;
    let ph = words.join(' ');
    if (!ph.includes(' ') && ph.length < 3) continue;
    const midOK = !initial || stripped || poss || words.length > 1 || off > 0 || /^\s+(?:owes?|paid|lives|called|serviced|installed|performed|signed|arrived|visited|completed|inspected|requested|ordered|scheduled|reported|checked|replaced|handled|worked|owns|owned|met|contacted|issued|received|diagnosed|repaired|quoted|billed|charged|assigned|made|built|manufactured|supplied|did|approved|rents|leases|manages)\b/.test(text.slice(start0 + m[0].length));
    if (!midOK) continue;
    if (overlaps(start, start + ph.length) || NOT_NAMES.has(ph.toLowerCase())) continue;
    if (/^[A-Z][a-z]+$/.test(ph) && (NAME_STOP.has(ph.toLowerCase()) || FUNC_WORDS.has(ph.toLowerCase()))) continue;
    take('name', ph, start, start + ph.length, { value: ph, role: detectRole(text, start, start + ph.length, null), run: true });
  }
  void phoneContext; void emailContext;
  return claims.sort((a, b) => a.start - b.start);
}

/* ------------------------------------------------------------------ support */
const CUR_KEY = { '€': 'eur', '£': 'gbp', '¥': 'jpy', '₹': 'inr', 'c$': 'cad', 'ca$': 'cad', 'mx$': 'mxn', 'a$': 'aud', 'au$': 'aud', euros: 'eur', euro: 'eur', yen: 'jpy', yuan: 'cny', rupee: 'inr', rupees: 'inr', franc: 'chf', francs: 'chf', peso: 'mxn', pesos: 'mxn', rand: 'zar' };
const CUR_RE = { eur: /€|\beur(?:os?)?\b/i, gbp: /£|\bgbp\b|\bpounds?\b/i, cad: /\bcad\b|\bc\$|\bca\$/i, mxn: /\bmxn\b|\bmx\$|\bpesos?\b/i, aud: /\baud\b|\ba\$|\bau\$/i, nzd: /\bnzd\b|\bnz\$/i, jpy: /¥|\bjpy\b|\byen\b/i, cny: /\bcny\b|\brmb\b|\byuan\b/i, inr: /₹|\binr\b|\brupees?\b/i, chf: /\bchf\b|\bfrancs?\b/i, brl: /\bbrl\b|\br\$/i, zar: /\bzar\b|\brand\b/i };
const NAME_VARIANTS = memo((h) => { const n = nameNorm(h); return { strict: ` ${n} `, loose: ` ${n.replace(/~/g, ' ')} `, noInit: ` ${n} `.replace(/ [a-z](?= )/g, '') }; });
const PAGE_PHONES = memo((h) => [...h.matchAll(/(?<![\w-])(?:\+?1[\s.-]*)?\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}(?![\w-])|(?<![\w-])\d{3}-\d{4}(?![\w-])/g)].map((m) => m[0].replace(/\D/g, '')));
/** Is `claim` on the text `hay`? (hay = one document's page texts + that document's extracted rows) */

/** a percentage of an amount printed on the page ("50% on signing" of "$75,000.00" = $37,500.00) */
const pctProduct = (h, value) => {
  const v = Number(value); if (!Number.isFinite(v) || v <= 0) return false;
  const pcts = [...String(h).matchAll(/(?<![\w.])(\d{1,3}(?:\.\d+)?)\s?%/g)].map((m) => Number(m[1])).filter((p) => p > 0 && p <= 100);
  if (!pcts.length) return false;
  for (const a of moneyNumbersIn(h)) { const n = Number(a); if (!(n > 0)) continue; for (const p of pcts) if (Math.abs(n * p / 100 - v) < 0.005) return true; }
  return false;
};
/** a date that is a printed date plus a printed duration on the same line ("24 months from 02/15/2026" -> 02/15/2028) */
const DUR_RE = /\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|twelve|eighteen|twenty-four|thirty-six)[- ](day|week|month|year)s?\b[^\n]{0,24}?\b(?:from|after|following|of)\b/gi;
const DUR_W = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, eighteen: 18, 'twenty-four': 24, 'thirty-six': 36 };
function derivedDate(h, value) {
  const want = parseDate(value); if (!want) return false;
  for (const ln of String(h).split('\n')) {
    if (ln.length > 300 || !/\b(?:day|week|month|year)s?\b/i.test(ln)) continue;
    const ds = dateCandidates(ln).map(parseDate).filter(Boolean); if (!ds.length) continue;
    for (const m of ln.matchAll(DUR_RE)) {
      const n = /^\d/.test(m[1]) ? Number(m[1]) : DUR_W[m[1].toLowerCase()]; if (!n) continue;
      for (const d of ds) {
        let t;
        if (/day/i.test(m[2])) t = new Date(Date.UTC(d.y, d.m - 1, d.d + n)); else if (/week/i.test(m[2])) t = new Date(Date.UTC(d.y, d.m - 1, d.d + 7 * n));
        else { const months = /year/i.test(m[2]) ? 12 * n : n; const tm = d.y * 12 + (d.m - 1) + months; const yy = Math.floor(tm / 12); const mm = tm % 12; const dim = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate(); t = new Date(Date.UTC(yy, mm, Math.min(d.d, dim))); }
        if (t.getUTCFullYear() === want.y && t.getUTCMonth() + 1 === want.m && t.getUTCDate() === want.d) return true;
      }
    }
  }
  return false;
}
export function claimSupportedIn(claim, hay) {
  const h = deAccent(String(hay ?? ''));
  if (!h) return false;
  switch (claim.kind) {
    case 'unparsed': return false;
    case 'money': return (!claim.cur || CUR_RE[claim.cur]?.test(h)) && (moneyNumbersIn(h).has(claim.value) || pctProduct(h, claim.value));
    case 'qty': {
      const hq = h.replace(DATE_RE, ' ').replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, ' ').replace(/\b\d{1,2}:\d{2}\b/g, ' ').replace(/\$\s?\d[\d,.]*/g, ' ');
      let has = numbersIn(hq).has(claim.value);
      if (!has) for (const m of hq.matchAll(/(?<![\w#/.,$])(\d+(?:\.\d+)?)(?:(?![\w]|[.,]\d)|(?=-[A-Za-z]))/g)) if (canonNumber(m[1]) === claim.value) { has = true; break; }
      if (!has && /^[A-Za-z]/.test(claim.raw ?? '') && new RegExp(`\\b${escRe(claim.raw)}\\b`, 'i').test(hq)) has = true; // "Three installments": the number word printed on the page
      if (!has) return false;
      if (claim.unitRaw && UNIT_CHECKED.has(fam(claim.unitRaw)) && !supportedExtra({ kind: 'qtyn', value: claim.value, unit: claim.unitRaw }, hq)) return false;
      if (claim.noun) { // a counted noun (visits, filters, bedrooms...): the number must sit on a line that names that noun
        const nre = new RegExp(NOUN_STEM[claim.noun], 'i'); const word = /^[A-Za-z]/.test(claim.raw ?? '') ? `|\\b${escRe(claim.raw)}\\b` : ''; const nums = new RegExp(`(?<![\\w#/.,$])${escRe(claim.value)}(?![\\w]|[.,]\\d)${word}`, 'i');
        return hq.split('\n').some((ln, i, arr) => nums.test(ln) && (nre.test(ln) || (i > 0 && !/\d/.test(arr[i - 1]) && nre.test(arr[i - 1]))));
      }
      return true;
    }
    case 'email': { const esc = claim.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); return new RegExp(`(?<![\\w.+-])${esc}(?![\\w-])`).test(h.toLowerCase()); }
    case 'url': { const esc = claim.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); return new RegExp(`(?<![\\w@.-])(?:www\\.)?${esc}(?![\\w-])`).test(h.toLowerCase()); }
    case 'time': { const [hm, ap] = claim.value.split('-'); return [...h.toLowerCase().matchAll(/(?<![\d:.\/-])(\d{1,2})(?::(\d{2}))?\s?(am|pm)\b|(?<![\d:.\/-])(\d{1,2}):(\d{2})(?![\d:])/g)].some((m) => `${Number(m[1] ?? m[4]) % 12}:${String(Number(m[2] ?? m[5] ?? 0)).padStart(2, '0')}` === hm && (!ap || !m[3] || m[3] === ap)); }
    case 'city': return ` ${alnumNorm(h)} `.includes(` ${claim.value} `);
    case 'badweekday': return false;
    case 'year': return new RegExp(`(?<![\\d$.,#-])${claim.value}(?![\\d]|[.,]\\d)`).test(h);
    case 'count': return numbersIn(h).has(claim.value);
    case 'terms': return new RegExp(`\\bnet\\s*-?\\s*0*${claim.value}\\b|\\b(?:due|payable|pay)\\s+(?:in|within)\\s+${claim.value}\\s+days\\b`, 'i').test(h);
    case 'qtyn': case 'rate': case 'ordday': case 'stat': case 'neg': case 'desc': case 'quarter': case 'rel': return supportedExtra(claim, h);
    case 'status': if (/^by /.test(claim.value)) return methodOk(h, claim.value); return claim.value === 'full' ? /paid\s+in\s+full|fully\s+paid|paid\s+off|status\s*:?\s*paid\b|\bpaid\b(?!\s*:?\s*\$?\s?0(?:\.00)?(?![\d.,]))|balance[^\n]{0,20}\$\s?0(?:\.00)?(?![\d.,])/i.test(h) : new RegExp(`\\b${claim.value.replace(/^by /, '').replace('check', '(?:check|cheque)')}\\b`, 'i').test(h);
    case 'monyear': { const [mo, yr] = claim.value.split('-').map(Number); return [...h.matchAll(new RegExp(`\\b(${MONTH_RE})\\.?,?\\s+(?:the\\s+)?(?:\\d{1,2}(?:st|nd|rd|th)?,?\\s+)?(\\d{4})\\b`, 'gi'))].some((m) => monthIndex(m[1]) === mo && Number(m[2]) === yr) || dateCandidates(h).some((d) => { const p = parseDate(d); return p && p.m === mo && p.y === yr; }); }
    case 'phone': { const pp = PAGE_PHONES(h); return claim.local ? pp.some((d) => d.endsWith(claim.value)) : pp.some((d) => d.slice(-10) === claim.value && d.length >= 10); }
    case 'id': {
      const hn = ` ${alnumNorm(h)} `;
      if (claim.cue) { // a short reference ("Unit 7", "Account 99812") must sit right after the same kind of label on the page
        const v = escRe(claim.raw.replace(/^#/, '')); return new RegExp(`(?:${CUE_GROUP(claim.cue)})[^\\n]{0,16}?(?<![\\w-])${v}(?![\\w-])`, 'i').test(h);
      }
      return hn.includes(` ${claim.value} `) || (claim.value.replace(/ /g, '').length >= 4 && tokenGlued(hn, claim.value));
    }
    case 'date': { if (claim.rangeBad) return false; const c = dateCandidates(h); return c.some((d) => sameDate(d, claim.value)) || derivedDate(h, claim.value); }
    case 'mday': { const [mo, dy] = claim.value.split('-').map(Number); return [...h.matchAll(MD_RE_ANY)].some((m) => monthIndex(m[1]) === mo && Number(m[2]) === dy) || [...h.matchAll(DM_RE)].some((m) => monthIndex(m[2]) === mo && Number(m[1]) === dy) || [...h.matchAll(DAYMON_RE)].some((m) => monthIndex(m[2]) === mo && Number(m[1]) === dy) || dateCandidates(h).some((d) => { const p = parseDate(d); return p && p.m === mo && p.d === dy; }); }
    case 'address': {
      const lines = h.split('\n'); const want = ` ${claim.value} `;
      for (let i = 0; i < lines.length; i++) {
        const w = ` ${addrNorm(`${lines[i]} ${lines[i + 1] ?? ''} ${lines[i + 2] ?? ''}`)} `;
        const at = w.indexOf(want); if (at < 0) continue;
        if (!claim.city && !claim.zip) return true;
        const tail = w.slice(at + want.length - 1).trim().split(' ').slice(0, 8);
        if ((!claim.city || ` ${tail.join(' ')} `.includes(` ${claim.city} `)) && (!claim.zip || tail.includes(claim.zip))) return true;
      }
      return false;
    }
    case 'name': {
      const v = NAME_VARIANTS(h);
      const w = nameNorm(claim.value).split(' ').filter(Boolean); if (!w.length) return false;
      const wNI = w.filter((x) => x.length > 1);
      const strictOk = (hh, ww) => ww.length > 0 && (hh.includes(` ${ww.join(' ')} `) || (ww.length === 2 && hh.includes(` ${ww[1]} ${ww[0]} `)));
      if (strictOk(v.strict, w) || strictOk(v.noInit, wNI)) return true;
      if (w.some((x) => x.includes('~'))) return strictOk(v.loose, w.map((x) => x.replace(/~/g, ' ')).join(' ').split(' '));
      return false;
    }
    default: return true;
  }
}
const UNIT_CHECKED = new Set(['day', 'week', 'month', 'year', 'hour', 'minute', 'pct', 'lb', 'oz', 'kg']);
const MD_RE_ANY = new RegExp(`\\b(${MONTH_RE})\\.?\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi');
// id spaced-out variants ("INV T226" vs "INV-T226"): only trust the squashed match when the claim's alnum run appears whole inside one hay token-run
function tokenGlued(hn, value) { const sq = value.replace(/ /g, ''); return hn.split(' ').some((t, i, a) => { let acc = ''; for (let j = i; j < Math.min(a.length, i + 4); j++) { acc += a[j]; if (acc === sq) return true; if (!sq.startsWith(acc)) break; } return false; }); }

/* ------------------------------------------------------------------ the gate */
const SENT_SPLIT = /(?<=[.!?])\s+(?=[A-Z$#])(?<!\b(?:St|Rd|Ave|Apt|Dr|No|Mr|Mrs|Ms|Inc|Co|Ste|Ln|Blvd|vs|Jr|Sr)\.\s)(?<!\b[A-Z]\.\s)/;
export const splitSentences = (t) => String(t ?? '').split(SENT_SPLIT).map((x) => x.trim()).filter(Boolean);
/** clauses: a sentence that talks about several records ("INV-1 is $5 and INV-2 is $9") is checked clause by clause, so an amount cannot ride on the neighbouring record's id */
const AGG_CUE_EARLY = /\b(?:together|combined|altogether|in all|sum of|adds? up|both|collectively|between them|cumulative)\b/i;
const splitClauses = (sent) => (AGG_CUE_EARLY.test(sent) ? [sent.trim()] : sent.split(/;\s+|(?<!\bdollars?)\s+(?:and|while|whereas|but)\s+(?=[A-Z#$]|\w+-?\d)|,\s+(?=(?:[Ii]nvoice|[Ii]nv|[Pp][Oo]|[Pp]ermit|[Ss]erial)\b)/).map((x) => x.trim()).filter(Boolean));

const docHay = (ev, id) => {
  const d = ev?.get?.(id);
  if (!d) return '';
  const full = `${[...(d.pages?.values?.() ?? [])].join('\n')}\n${d.rows ?? ''}`;
  // a quoted nickname inside a printed name (Reginald "Reggie" Thackeray) also reads as the name without it
  const plain = full.replace(/([A-Z][a-z]+)\s+["“(]([A-Z][a-z]+)[”")]\s+(?=[A-Z])/g, '$1 ');
  return plain === full ? full : `${full}\n${plain}`;
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
/** a vendor line is a LABELLED one ("Vendor: X", "Sold by: X"); a title like "SUPPLIER INVOICE" is not */
const VENDOR_LABELLED = /^\s*(?:vendor(?:_name)?|supplier|seller|contractor|sold\s+by|remit(?:\s+to)?)\b[^\n:]{0,20}:/i;
function roleText(hay, label, withNext = false) {
  for (const [labelRe, lineRe] of ROLE_LINES) {
    if (!labelRe.test(String(label ?? ''))) continue;
    const all = String(hay ?? '').split('\n');
    const isVendor = /supplier\|seller/.test(lineRe.source);
    const lines = all.flatMap((l, i) => ((isVendor ? VENDOR_LABELLED.test(l) : lineRe.test(l)) ? (withNext && all[i + 1] != null && !/[:]/.test(all[i + 1].slice(0, 20)) ? [l, all[i + 1]] : [l]) : []));
    // a two-column line ("Bill To: Maria   Technician: Dale") only counts the part that carries this role's label
    const segs = withNext ? lines : lines.flatMap((l) => l.split(/\s{2,}|\t|\||;/).filter((x) => (isVendor ? VENDOR_LABELLED.test(x) : lineRe.test(x))));
    if (segs.length) return segs.join('\n');
    if (isVendor) return String(hay ?? '').split('\n').slice(0, 3).join('\n'); // a vendor is the letterhead when no line labels it
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
const INCL_TAX = /\([^)]*\b(?:incl\w*|including|inc|with|plus|after|before|w\/)\b[^)]*\)|\b(?:incl\w*\.?|including|inc\.|with|plus|after|before|w\/)\s+(?:sales\s+)?tax(?:es)?\b/gi;
export function fieldOfText(t, forLine = false) {
  const x = String(t ?? '').replace(INCL_TAX, ' ').toLowerCase();
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
const DATEISH = ['date', 'mday', 'monyear', 'time', 'year'];
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
  [DATEISH, /\bthrough\b|\bthru\b/, { need: /through|thru|until|\bto\b|\bend|expir|terminat|valid|\bthru/i }],
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
  'total', 'amount', 'price', 'cost', 'date', 'number', 'no', 'num', 'name', 'value', 'cust', 'customer', 'client', 'invoice', 'document', 'record', 'info', 'details', 'detail', 'listed', 'shown', 'inv', 'ticket', 'quote', 'permit', 'agreement', 'warranty', 'estimate', 'order', 'registration', 'limit', 'limits', 'maximum', 'charged', 'billed', 'due', 'owes', 'owe', 'owed', 'paid', 'pay', 'quote', 'quoted', 'estimate', 'show', 'shows', 'also', 'only', 'about', 'around', 'approximately', 'which', 'what', 'when', 'who', 'where', 'how', 'much', 'many', 'came', 'comes', 'come', 'covers', 'cover', 'includes', 'include', 'dated', 'on', 'file']);
const DISC = /^(?:annual|yearly|monthly|weekly|quarterly|next|last|previous|order|delivery|delivered|ship|shipping|visits?|amps?|ampacity|fuse|pressure|leakage|voltage|labou?r|parts?|rent|deposit|install\w*|start|end|expires?)/i;
const stem4 = (w) => w.slice(0, 4);
/** the discriminating words of a label (or of the words just before a value in a headline) that are NOT generic: "Option B", "Annual", "INV-1002", "Next service", "Delivery" */
const DATE_GENERIC = new Set(['service', 'services', 'visit', 'job', 'work', 'completion', 'performed', 'serviced', 'appointment', 'call', 'term', 'terms', 'period', 'dates', 'range', 'coverage', 'duration', 'lease', 'agreement', 'contract', 'warranty', 'policy']);
const QTY_GENERIC = new Set(['equipment', 'work', 'description', 'notes', 'note', 'details', 'summary', 'item', 'items', 'product', 'brand', 'model', 'system', 'unit', 'included', 'incl', 'includes']);
function bindTokens(label, headline = false, rowWords = true, kind = null) {
  const l = deAccent(String(label ?? '').replace(INCL_TAX, ' ')).toLowerCase();
  const isDateKind = kind && DATEISH.includes(kind);
  const toks = [];
  const opt = /\b(option|plan|tier|package|choice|phase|bid|item|line|page|section|unit|building|bldg)\s*#?\s*([a-z0-9]{1,3})\b/.exec(l);
  if (opt) toks.push({ digit: true, re: new RegExp(`\\b${opt[1]}\\s*#?\\s*${opt[2]}\\b`, 'i') });
  for (const w of l.split(/[^a-z0-9]+/).filter(Boolean)) {
    if (opt && (w === opt[1] || w === opt[2])) continue;
    if (BIND_STOP.has(w)) continue;
    if (isDateKind && DATE_GENERIC.has(w)) continue;
    if (kind === 'qty' && QTY_GENERIC.has(w)) continue;
    if (headline && !rowWords && !/\d/.test(w) && !DISC.test(w)) continue;
    if (/^\d{1,3}$/.test(w)) continue;
    if (/\d/.test(w)) { toks.push({ digit: true, re: new RegExp(`(?<![\\w.])${w}(?![\\w.])`, 'i') }); continue; }
    if (w.length < 3) continue;
    toks.push({ re: new RegExp(`\\b${escRe(stem4(w))}`, 'i') });
  }
  return headline ? toks.slice(-2) : toks;
}
/** does some line carrying the claim (plus a label-only line right above it) hold every discriminating label word that the document uses somewhere? */
function presentTokens(hay, label, headline = false, rowWords = true, kind = null) {
  const toks = bindTokens(label, headline, rowWords, kind);
  if (!toks.length) return [];
  const h = deAccent(String(hay ?? ''));
  const rowRe = rowWords ? /[$]\s?\d|\d+\.\d{2}/ : /[$]\s?\d|\d+\.\d{2}|\d\/\d/;
  const rowLayout = (t) => h.split('\n').some((ln) => t.re.test(ln) && rowRe.test(ln));
  return toks.filter((t) => (t.digit || headline ? rowLayout(t) : t.re.test(h)));
}
function boundToLabel(claim, hay, label, headline = false) {
  const present = presentTokens(hay, label, headline, claim.kind === 'money', claim.kind);
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

const CREDIT_WORD = /\b(?:credit(?:s|ed|ing)?(?!\s+card)|refund(?:s|ed|ing)?|reimburs\w*|reversal|money back|chargeback)\b/i;
const CHARGE_WORD = /\b(?:owes?|owed|owing|charged?|billed|invoice[ds]?(?:\s+(?:for|at|of))?|payable|amount due|balance due|total due|(?:is|was|are)\s+due)\b/i;
const CHARGE_LABEL = /\b(?:total|due|balance|owed|owes|charged?|billed|invoice(?:d)? amount|grand total)\b/i;
const NEG_MARK = /-\s?\$|\$\s?-|\(\s?\$/;
const CREDIT_LINE = /\b(?:credit(?!\s+card)|refund|return(?:ed)?|reversal|memo)\b/i;
/** where the page prints this amount: on a credit / refund line (or a credit memo) and/or on an ordinary charge line */
function pageSign(c, hays) {
  let anyNeg = false; let anyPos = false;
  const probe = { kind: 'money', value: c.value };
  for (const h of hays) {
    const credDoc = /\bcredit\s+(?:memo|note)\b/i.test(h);
    for (const line of String(h).split('\n')) {
      if (!claimSupportedIn(probe, line)) continue;
      if (credDoc || NEG_MARK.test(line) || CREDIT_LINE.test(line)) anyNeg = true; else anyPos = true;
    }
  }
  return { anyNeg, anyPos };
}
/** a credit / refund claim needs a credit line on the page; a charge / owed claim needs an ordinary charge line (a credit memo's amount is not owed) */
function signOk(c, dirText, hays, labelCharge = false) {
  const credit = Boolean(c.neg) || CREDIT_WORD.test(dirText);
  const charge = !credit && (labelCharge || CHARGE_WORD.test(dirText));
  if (!credit && !charge) return true;
  const { anyNeg, anyPos } = pageSign(c, hays);
  return credit ? anyNeg : anyPos;
}
const AGG_CUE = /\b(?:together|combined|altogether|in all|in total|sum|adds? up|both|overall|across|grand total|aggregate|collectively|between them|cumulative|all (?:of )?(?:the|these|those)|total of)\b/i;
const cents = (v) => Math.round(Number(v) * 100);
/** can `c` (money or qty) be the sum of one figure from each of at least two of these documents? (the one figure per document is the field the label / phrase names) */
function sumSupported(c, docs, evidence, label) {
  if (docs.length < 2 || docs.length > 40) return false;
  const opts = docs.map((id) => {
    const h = docHay(evidence, id); const d = evidence?.get?.(id); const set = new Set();
    if (c.kind === 'money') {
      const types = (label && labelField(label)) || fieldOfText(label ?? '') || ['total', 'balance'];
      const fa = fieldAmounts(h);
      for (const t of types) { for (const x of fa[t] ?? []) set.add(x); if (t === 'total' && d?.totalNum != null) set.add(d.totalNum); if (t === 'balance' && d?.balanceNum != null) set.add(d.balanceNum); }
    } else {
      const toks = bindTokens(label ?? '', false, false, 'qty'); const rule = lineRuleFor('qty', label ?? '');
      for (const ln of h.split('\n')) if ((rule && rule.need.test(ln)) || (!rule && toks.length && toks.every((t) => t.re.test(ln)))) for (const m of ln.matchAll(/(?<![\w#/.,$-])(\d+(?:\.\d+)?)(?![\w/]|[.,]\d)/g)) set.add(canonNumber(m[1]));
    }
    return [...set];
  });
  const want = cents(c.value);
  let reach = new Map([['0|0', 0]]);
  for (const o of opts) {
    const next = new Map(reach);
    for (const [k, sum] of reach) { const n = Number(k.split('|')[1]); for (const v of o) { const ns = sum + cents(v); const nk = `${ns}|${Math.min(2, n + 1)}`; next.set(nk, ns); } }
    reach = next; if (reach.size > 6000) return false;
  }
  return reach.has(`${want}|2`);
}
const KINDS_BOUND = ['date', 'mday', 'monyear', 'time', 'year', 'id', 'qty', 'money'];
const CARD_OWN_KEYS = new Set(['label', 'value', 'sources', 'status', 'basis', 'modelBasis', 'entityId', 'kind', 'valueOk']);
const ORG_LABEL = /\b(?:brand|make|manufacturer|equipment|product|vendor|supplier|company|business|contractor|carrier|organi[sz]ation|firm|landlord|insurer|agency|builder|installer)\b/i;
const COUNT_LABEL = /\b(?:pages?|documents?|records?|results?|matches|found|count|number of|total (?:invoices|documents|records|customers|jobs))\b/i;

const cleanText = (x) => (typeof x === 'string' ? foldNumFormat(deAccent(x)) : x);
/** card keys the gate treats as the card's own (not text): enum / charset validated, so an arbitrary string in "status" or "entityId" cannot carry prose past the gate */
const OWN_ENUM = {
  status: (v) => typeof v === 'string' && /^(?:ok|warn|bad|info|muted)$/.test(v), entityId: (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v), kind: (v) => typeof v === 'string' && /^[a-z][a-z_-]{0,23}$/.test(v),
  valueOk: (v) => typeof v === 'boolean', basis: (v) => v === 'printed' || v === 'computed', modelBasis: (v) => v === 'printed' || v === 'computed',
};
const isOwnKey = (k, v) => CARD_OWN_KEYS.has(k) && (!(k in OWN_ENUM) || OWN_ENUM[k](v));
const MAX_TEXT = 5000; const MAX_SENT = 80; const MAX_TOKEN = 200; const MAX_CARD = 800;
const tooBig = (t, max) => typeof t === 'string' && (t.length > max || /\S{201,}/.test(t));
const FIGURE_KINDS = new Set(['money', 'qty', 'qtyn', 'rate', 'date', 'mday', 'monyear', 'time', 'year', 'id', 'phone', 'ordday', 'quarter', 'rel', 'address', 'email', 'url', 'terms', 'unparsed', 'badweekday', 'city']);
/**
 * @param {object} data       a model-composed answer ({kind, text, facts:[{label,value,sources:[{documentId,location}]}], sources, interpretation})
 * @param {Map<string,{pages:Map<number,string>, rows:string, label?:string, total?:string, totalNum?:string}>} evidence per cited document
 * @param {{question?: string, agent?: boolean}} opts agent: the answer came from the research agent. Aggregates over several documents are legitimate there, but every claim is still bound to the document(s) it
 *   names (its own id / name) or cites, and a sum must be a sum of the cited documents' own figures
 */
const mixedHit = (d0, pi) => hasMixedScript(pi ? d0?.interpretation : d0?.text);
/** a name's role on this page: bound to the label on its own line; the roles the page never labels cannot vouch for a name */
function roleOkFor(c, h, key) {
  const r = nameRoleOk(c, h, key, claimSupportedIn);
  return r === null ? claimSupportedIn(c, roleText(h, key)) : r;
}
function nameRoleForLabel(c, h, label) {
  const def = roleDefForLabel(label);
  if (def) return roleOkFor(c, h, def.key);
  return claimSupportedIn(c, roleText(h, label));
}
const RANGE_START = /effective|start|begin|from|commenc|issued|inception|move[- ]in|open|date|period|term|coverage|runs|valid/i;
const RANGE_END = /expir|\bend|through|until|valid|terminat|\bto\b|period|term|date|due|close|coverage|runs/i;
/** both ends of a range sit on a date line of the page, and the start is on a start-ish one, the end on an end-ish one */
function rangeBound(c, h) {
  if (c.rangeBad || !claimSupportedIn(c, h)) return false;
  const re = c.range === 'start' ? RANGE_START : RANGE_END;
  const lines = String(h).split('\n');
  return lines.some((ln, i) => claimSupportedIn(c, ln) && re.test(`${ln}\n${i > 0 && ln.replace(/[^A-Za-z]/g, '').length <= 3 ? lines[i - 1] : ''}`));
}
export function checkGrounding(data0, evidence, opts = {}) {
  setToday(opts?.today ?? null);
  try { return checkGroundingInner(data0, evidence, opts ?? {}); } finally { setToday(null); }
}
function checkGroundingInner(data0, evidence, { agent = false, agentRows = false, evidenceFailed = false } = {}) {
  const mixedText = hasMixedScript(data0?.text) || hasMixedScript(data0?.interpretation);
  // one normalisation for the claim side as for the page side (fullwidth digits, zero-width characters, Arabic-Indic digits...)
  const data = { ...data0, text: cleanText(data0?.text), interpretation: cleanText(data0?.interpretation), facts: Array.isArray(data0?.facts) ? data0.facts.map((f) => ({ ...f, label: cleanText(f?.label), value: cleanText(f?.value), ...Object.fromEntries(Object.entries(f ?? {}).filter(([k, v]) => !isOwnKey(k, v) && typeof v === 'string').map(([k, v]) => [k, cleanText(v)])), __mixed: hasMixedScript(f?.label) || hasMixedScript(f?.value) || Object.entries(f ?? {}).some(([k, v]) => !isOwnKey(k, v) && hasMixedScript(v)) })) : [] };
  const failures = [];
  let g3hays = null;
  const facts = data.facts;
  let checked = 0; let supported = 0;
  const citedDocs0 = [...new Set([...(data?.sources ?? []), ...facts.flatMap((f) => f.sources ?? [])].map((s) => s?.documentId).filter(Boolean))];
  // an agent answer that cites NO document is held to every document retrieved in that run (when the evidence is available); with none available its figures are withdrawn
  const uncitedAgent = agent && !citedDocs0.length;
  const citedDocs = uncitedAgent ? [...(evidence?.keys?.() ?? [])].slice(0, 40) : citedDocs0;
  const countSet = new Set([String(citedDocs.length), String(facts.length)]);
  // an agent answer that says it totals MORE records than it cites ("across 40 invoices") aggregates over uncited records: its multi-document amounts cannot be held to the few cited ones
  const aggBig = agent && [data.text, data.interpretation].some((t) => typeof t === 'string' && !tooBig(t, MAX_TEXT) && extractClaims(t).some((c) => c.kind === 'count' && Number(c.value) > citedDocs.length));
  const sup = (c, id) => {
    const h = docHay(evidence, id);
    if (c.kind === 'count' && countSet.has(c.value)) return true;
    if (c.kind === 'qtyn' && agent && countSet.has(c.value)) return true;
    if (!claimSupportedIn(c, h)) return false;
    if (c.kind === 'name' && c.role) return roleOkFor(c, h, c.role);
    if (c.kind === 'address' && c.arole) return addressRoleOk(c, h, claimSupportedIn);
    return true;
  };
  const factOk = facts.map((f, i) => {
    const docs = [...new Set((f.sources ?? []).map((s) => s.documentId))];
    if (agent && !docs.length) return true; // a record-derived card (no document cited): nothing to compare it with
    const ctx = factContext(f.label, f.value);
    if (!ctx.moneyContext && !ctx.nameContext && !ctx.idContext && !ctx.qtyContext && !ctx.phoneContext && !ctx.emailContext && !COUNT_LABEL.test(String(f.label ?? '')) && /^\s*\d+(?:\.\d+)?\s*[A-Za-z. ]{0,14}$/.test(String(f.value ?? ''))) ctx.qtyContext = ctx.qtyDefault = true; // a bare count under any other label
    const capsAll = ctx.nameContext || ORG_LABEL.test(String(f.label ?? ''));
    const extraTexts = Object.entries(f).filter(([k, v]) => !isOwnKey(k, v) && typeof v === 'string' && v.trim()).map(([, v]) => v);
    if (f.__mixed || tooBig(f.value, MAX_CARD) || tooBig(f.label, MAX_CARD) || extraTexts.some((t) => tooBig(t, MAX_CARD))) { checked++; failures.push({ where: 'fact', index: i, label: String(f.label ?? '').slice(0, 40), kind: 'unparsed', claim: 'unverifiable text', docs }); return false; }
    const own = [...extractClaims(`${f.value}`, { ...ctx, capsAll, statusContext: /\b(?:status|state|condition|standing)\b/i.test(String(f.label ?? '')) }), ...extractClaims(`${f.label}`, {}), ...extraTexts.flatMap((t) => extractClaims(t, {}))];
    const hays = docs.map((id) => docHay(evidence, id));
    const multi = agent && docs.length > 1;
    const perKind = {}; for (const c of own) perKind[c.kind] = (perKind[c.kind] ?? 0) + 1;
    let ok = true;
    for (const c of own) {
      checked++;
      let found = docs.some((id) => sup(c, id));
      let viaSum = false;
      if (!found && (c.kind === 'money' || c.kind === 'qty') && docs.length > 1 && perKind[c.kind] === 1 && sumSupported(c, docs, evidence, f.label)) { found = true; viaSum = true; }
      if (!found && multi && aggBig && (c.kind === 'money' || c.kind === 'qty') && perKind[c.kind] === 1) { found = true; viaSum = true; }
      // one figure on a card that cites several documents must be on every one of them (or be their sum) - not just on whichever one happens to carry it
      if (found && !viaSum && multi && !aggBig && ['money', 'qty', 'date', 'mday', 'monyear', 'time', 'year'].includes(c.kind) && perKind[c.kind] === 1 && !hays.every((h) => claimSupportedIn(c, h))) found = false;
      if (found && c.kind === 'name') found = hays.some((h) => nameRoleForLabel(c, h, f.label));
      // a card labelled Total / Cost / Amount due is the document's TOTAL, not any other amount that happens to be on the page (subtotal, zip code, ...)
      if (found && !viaSum && c.kind === 'money') { const lf = labelField(f.label); if (lf && amountFieldOk(evidence, docs, lf, c.value) === false) found = false; }
      if (found && !viaSum && c.kind === 'money') { const credLabel = CREDIT_WORD.test(String(f.label ?? '')); if (!signOk(c, `${f.label}`, hays, !credLabel && CHARGE_LABEL.test(String(f.label ?? '')))) found = false; }
      if (found && !viaSum && c.range) found = hays.some((h) => rangeBound(c, h));
      if (found && !viaSum && KINDS_BOUND.includes(c.kind) && !c.range) { const rule = lineRuleFor(c.kind, f.label); if (rule && !hays.some((h) => onRuledLine(c, h, rule))) found = false; }
      if (found && !viaSum && KINDS_BOUND.includes(c.kind) && !c.range && !hays.some((h) => boundToLabel(c, h, c.kind === 'id' ? String(f.label ?? '').replace(/\b(?:part|parts|tag|asset|serial|model|code|id|ref|reference|certificate|cert)\b/gi, ' ') : f.label))) found = false;
      if (found && c.kind === 'qty' && ctx.qtyDefault) { const toks = bindTokens(f.label, false, false, 'qty').filter((t) => !t.digit); if (toks.length && !hays.some((h) => h.split('\n').some((ln) => claimSupportedIn(c, ln) && toks.some((t) => t.re.test(ln))))) found = false; }
      if (found && ['address', 'city'].includes(c.kind) && /\b(?:ship|deliver\w*|bill\w*|job\s?site|site)\b/i.test(String(f.label ?? ''))) found = hays.some((h) => claimSupportedIn(c, roleText(h, f.label, true)));
      if (found && c.kind === 'name' && hays.length) { const g3 = cardGuards(f.label, f.value, hays); if (g3) found = false; }
      if (found) supported++; else { ok = false; failures.push({ where: 'fact', index: i, label: String(f.label ?? '').slice(0, 40), kind: c.kind, claim: c.raw.slice(0, 60), docs }); }
    }
    return ok;
  });

  const textParts = [data?.text, data?.interpretation].filter((x) => typeof x === 'string' && x);
  const sentenceOk = [];
  if ([data0?.text, data0?.interpretation].some((x) => x != null && typeof x !== 'string')) { checked++; failures.push({ where: 'text', sentence: 0, kind: 'unparsed', claim: 'text is not a string', docs: citedDocs }); sentenceOk.push({ ok: false, interp: false }); }
  textParts.forEach((part, pi) => { let carry = null;
    const sents = tooBig(part, MAX_TEXT) || mixedHit(data0, pi) ? null : splitSentences(part);
    if (!sents || sents.length > MAX_SENT) { checked++; failures.push({ where: pi ? 'interpretation' : 'text', sentence: 0, kind: 'unparsed', claim: sents ? 'text too long to verify' : 'unverifiable text', docs: citedDocs }); sentenceOk.push({ ok: false, interp: Boolean(pi) }); return; }
    sents.forEach((sent, si) => {
    let ok = true;
    for (const clause of splitClauses(sent)) {
      // counts of records are aggregates the agent computes. An agent answer that cites NO document is held to every document retrieved in that run; with none retrieved its figures are withdrawn
      // (unless the answer rests on record queries, whose figures the shape gate already matched against the tool results)
      let claims = extractClaims(clause).filter((c) => !(agent && c.kind === 'count'));
      if (uncitedAgent && agentRows) claims = citedDocs.length ? claims.filter((c) => !['money', 'qty', 'qtyn', 'rate', 'count', 'rel', 'quarter'].includes(c.kind)) : [];
      if (uncitedAgent && !citedDocs.length) {
        for (const c of claims.filter((x) => evidenceFailed || FIGURE_KINDS.has(x.kind))) { checked++; ok = false; failures.push({ where: pi ? 'interpretation' : 'text', sentence: si, kind: c.kind, claim: c.raw.slice(0, 60), docs: [] }); }
        continue;
      }
      if (!claims.length) continue;
      const ids = claims.filter((c) => c.kind === 'id');
      let pool = carry && !ids.length ? carry : citedDocs;
      if (ids.length) {
        pool = citedDocs.filter((id) => ids.some((c) => sup(c, id)));
        if (!pool.length) { for (const c of ids) { checked++; failures.push({ where: pi ? 'interpretation' : 'text', sentence: si, kind: 'id', claim: c.raw.slice(0, 60), docs: citedDocs }); } ok = false; continue; }
        carry = pool.length < citedDocs.length ? pool : null;
        const absent = ids.filter((c) => !citedDocs.some((id) => sup(c, id)));
        if (absent.length) { for (const c of absent) { checked++; failures.push({ where: pi ? 'interpretation' : 'text', sentence: si, kind: 'id', claim: c.raw.slice(0, 60), docs: pool }); } ok = false; continue; }
      }
      else {
        const names = claims.filter((c) => c.kind === 'name');
        if (names.length) {
          const np = pool.filter((id) => names.some((c) => sup(c, id)));
          if (np.length) { pool = np; carry = np.length < citedDocs.length ? np : null; }
        }
      }
      const aggClause = agent && citedDocs.length > 1 && !ids.length;
      const aggUncited = aggClause && aggBig && !claims.some((c) => c.kind === 'name');
      // neighbouring context of every claim: the words between the previous claim (and its trailing label) and this one, and the label right after it ("$98.15 tax")
      const ends = []; let consumed = 0;
      const ctxOf = claims.map((c, k) => {
        const lead0 = clause.slice(consumed, c.start); const endC = c.start + c.raw.length;
        const pm = c.kind === 'money' ? /^\s*(?!(?:for|of|from|to|on|about|per|in)\b)((?:(?!(?:and|the|a|an|with|plus|but|or|is|was|are|were|comes|came|to|for|of|on|in)\b)[A-Za-z]+\s+){0,2}?(?:tax|taxes|subtotal|sub-total|total|deposit|fee|fees|balance|rent|parts|labor|labour|due|credit|refund|discount|payment|charge|charges|occurrence|aggregate))\b/i.exec(clause.slice(endC)) : null;
        let lead = lead0.split(/[.;:!?]\s/).pop().split(/\b(?:with|and|plus|but|while|whereas|versus)\b|[,+=]/i).pop().slice(-60);
        if (k > 0 && claims[k - 1].kind === 'money') { const tv = /^\s*(?:[A-Za-z]+\s+){1,2}(?:is|was|are|equals?|makes|comes\s+to|totals?|adds?\s+up\s+to|gives)\b\s*(.*)$/i.exec(lead); if (tv) lead = tv[1]; }
        const nextStart = claims.find((x) => x.start > c.start)?.start ?? clause.length;
        const after = clause.slice(endC, Math.min(endC + 16, nextStart));
        if (c.kind === 'money') consumed = Math.max(consumed, endC + (pm ? pm[0].length : 0)); ends.push(endC);
        return { lead, post: pm ? pm[1] : '', before40: lead0.slice(-40), pre60: clause.slice(Math.max(0, c.start - 60), c.start), after };
      });
      // sums: a figure that is the sum of the pooled documents' own figures (together / combined / across ...)
      const sumFlags = new Map();
      if (pool.length > 1 && (agent || AGG_CUE.test(clause)) && !aggUncited) claims.forEach((c, k) => { if ((c.kind === 'money' || c.kind === 'qty') && !pool.some((id) => sup(c, id)) && sumSupported(c, pool, evidence, ctxOf[k].lead)) sumFlags.set(c, true); });
      // every claim of one clause must be on ONE document (the amount, the customer and the date of a record come from the same record)
      const rest = claims.filter((c) => c.kind !== 'id' || !ids.length);
      const restOne = rest.filter((c) => !sumFlags.has(c));
      const oneDoc = pool.find((id) => restOne.every((c) => sup(c, id)));
      if (ids.length) { const both = pool.filter((id) => restOne.every((c) => sup(c, id))); if (both.length && both.length < citedDocs.length) carry = both; }
      for (const c of rest) {
        const k = claims.indexOf(c); const cx = ctxOf[k];
        checked++;
        const viaSum = sumFlags.has(c);
        const exempt = aggUncited && (c.kind === 'money' || c.kind === 'qty'); // "$589,866.50 across 40 invoices": an aggregate over records that are not all cited
        const found = viaSum || exempt || oneDoc != null || pool.some((id) => sup(c, id));
        const useDocs = oneDoc != null ? [oneDoc] : pool;
        let fieldOk = true;
        if (found && !viaSum && !exempt && c.kind === 'money') {
          const near = `${cx.before40.slice(-40)}`;
          const lf = /(?:(?:prior|previous|opening|beginning|closing|ending|new|statement)\s+)?(?:subtotal|sub-total|tax(?:es)?|deposit|past due|minimum payment|closing balance|opening balance|new balance|original contract|new contract|revised contract|change order|paid|payment|collected|balance|outstanding|owes?|owed|remaining|total|amount|due|cost|price|billed|charged?|invoiced)\b[^.$]{0,40}\$?\s*$/i.exec(near);
          const perPart = /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+(?:equal\s+|monthly\s+|quarterly\s+|annual\s+)?(?:installments?|payments?|instalments?)\s+of\s*$/i.test(cx.lead); // "in three installments of $600": a part, not the whole
          let types = lf && !perPart ? fieldOfText(lf[0]) : null;
          if (!types && cx.post) types = fieldOfText(cx.post);
          if (types && types.length === 1 && types[0] === 'total' && !/\b(?:total|due|invoice|grand)\b/i.test(lf?.[0] ?? cx.post) && useDocs.some((id) => presentTokens(docHay(evidence, id), (cx.lead + ' ' + cx.post).trim(), true).length)) types = null;
          if (types && amountFieldOk(evidence, useDocs, types, c.value) === false) fieldOk = false;
          // "40 bags of flour at $22.50 each, $900.00 total": a line item's own total, on the row that names the item
          if (!fieldOk && types?.length === 1 && types[0] === 'total' && cx.pre60.trim() && useDocs.some((id) => presentTokens(docHay(evidence, id), cx.pre60, false, true, 'money').length && boundToLabel(c, docHay(evidence, id), cx.pre60, false))) fieldOk = true;
          if (fieldOk) { const dir = `${cx.before40.slice(-32)}${cx.after}`; if (!signOk(c, dir, useDocs.map((id) => docHay(evidence, id)))) fieldOk = false; }
        }
        if (found && fieldOk && c.range && !useDocs.some((id) => rangeBound(c, docHay(evidence, id)))) fieldOk = false;
        const derivedD = c.kind === 'date' && !useDocs.some((id) => dateCandidates(docHay(evidence, id)).some((d) => sameDate(d, c.value))); // a printed date plus a printed duration
        if (found && !viaSum && !exempt && !derivedD && !c.range && KINDS_BOUND.includes(c.kind) && !(c.kind === 'id' && ids.includes(c))) {
          const ctxText = c.kind === 'qty' ? clause.slice(c.start, c.start + 40).replace(/^(\d+(?:\.\d+)?)([\s\S]*?)(?=\d|$)/, '$1$2') : `${cx.lead.slice(-34)} ${c.kind === 'money' ? cx.post : ''}`;
          const rule = lineRuleFor(c.kind, c.kind === 'qty' ? ctxText.replace(/^[\d.]+/, '').split(/\d/)[0] : ctxText, c.kind === 'qty');
          if (rule && !useDocs.some((id) => onRuledLine(c, docHay(evidence, id), rule))) fieldOk = false;
        }
        if (found && fieldOk && !viaSum && !exempt && c.kind === 'qty' && c.reading) {
          const lead = clause.slice(0, c.start).split(/[.;:!?]\s/).pop().slice(-26);
          if (!useDocs.some((id) => boundToLabel(c, docHay(evidence, id), lead, false))) fieldOk = false;
        }
        if (found && fieldOk && !viaSum && !exempt && !derivedD && !c.range && ['date', 'mday', 'monyear', 'time', 'year', 'money'].includes(c.kind)) {
          const lead = (cx.lead + ' ' + (c.kind === 'money' ? cx.post : '')).trim();
          if (!/\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+[a-z]+\s+of\s*$/i.test(lead) && !useDocs.some((id) => boundToLabel(c, docHay(evidence, id), lead, true))) fieldOk = false;
        }
        if (found && fieldOk && (oneDoc != null || rest.length === 1 || aggClause || viaSum)) supported++;
        else { ok = false; failures.push({ where: pi ? 'interpretation' : 'text', sentence: si, kind: c.kind, claim: c.raw.slice(0, 60), docs: pool, glue: found }); }
      }
      checked += ids.length; supported += ids.length;
    }
    if (ok && citedDocs.length) { const g3 = sentenceGuards(sent, (g3hays ??= citedDocs.map((id) => docHay(evidence, id)))); if (g3) { checked++; ok = false; failures.push({ where: pi ? 'interpretation' : 'text', sentence: si, kind: g3.kind, claim: g3.claim.slice(0, 60), docs: citedDocs }); } }
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
  try { data = fixPages(data, evidence, extractClaims, claimSupportedIn); } catch { /* pages are cosmetic */ }
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
  return withdraw(data, evidence, verdict, claimCheck, opts.question);
}

export const GROUNDING_NO_ANSWER = "I found a document that looks related, but I couldn't confirm the details of an answer against it, so I'm not going to state them.";

function describeDoc(evidence, id) { const d = evidence?.get?.(id); return d?.label ? `${d.label}` : 'the cited document'; }

function withdraw(data, evidence, verdict, claimCheck, question = '') {
  const first = verdict.failures.find((f) => f.kind === 'money') ?? verdict.failures[0];
  const doc = first?.docs?.[0];
  const d = doc ? evidence?.get?.(doc) : null;
  let detail = '';
  if (first && doc) {
    // R2: a figure or name the MODEL supplied is never repeated in a decline; only one the user typed in the question is echoed back
    const qs = String(question ?? '').toLowerCase();
    const claim = String(first.claim ?? '');
    const typed = claim && (first.kind === 'money' ? (() => { const n = claim.replace(/[^\d.]/g, '').replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1'); return n.length > 0 && qs.replace(/,/g, '').includes(n); })() : qs.includes(claim.toLowerCase()));
    if (typed) {
      const what = first.kind === 'money' ? claim : `"${claim}"`;
      detail = ` ${describeDoc(evidence, doc)} does not show ${what}`;
      if (first.kind === 'money' && d?.total) detail += `; it shows a total of ${d.total}`;
      detail += '.';
    } else detail = ` ${describeDoc(evidence, doc)} does not back up the answer I drafted.`;
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

initGate2({ parseDate, dateCandidates, canonNumber, moneyNumbersIn, dateRe: DATE_RE });
initGate3({ parseDate, dateCandidates, canonNumber, moneyNumbersIn });
