/**
 * Electrical question lanes (Build 2, stage 2B): answers the questions an electrical contractor
 * actually asks, straight from the extracted paperwork, with the source page, and NO model.
 *
 *   classifyElectrical(question, {today}) -> intent | null      (pure)
 *   runElectrical(db, intent, {today})    -> answer envelope | null
 *
 * null always means "not sure": the normal path (and its model) takes over. Out-of-scope code,
 * legal and "is this compliant" questions get the fixed decline text (12.9 of the tools spec).
 * Every fact cites {documentId, location:{field, page}}. Definitions (kept literal and short):
 *   - A permit is OPEN when no document for its permit number shows a passed FINAL inspection or
 *     a certificate of completion. "Open" says what the file shows, not what the city shows.
 *   - An inspection "passed" only when its result as written is passed / approved / accepted /
 *     satisfactory / ok / complied; "failed" when failed / rejected / not approved / disapproved /
 *     corrections (required|needed) / denied. Anything else is reported verbatim, never guessed.
 *   - Credentials (license, insurance, bond) use the newest document per number; EXPIRED when the
 *     date is before today, "expiring" within the asked window (default 60 days).
 * Company isolation: every query runs inside the caller's tenant transaction (row-level security).
 */
import { answerEnvelope } from '../../scope.js';
import { parseDate } from './extract.js';
import { cleanValue, laneAudienceSql, conflictKeys } from '../records.js';

const TENANT = "tenant_id = (current_setting('app.tenant_id', true))::uuid";

export const DECLINE = {
  code: "I can't judge whether work meets code, whether an inspection should have passed, or what the code requires. I can show what your documents say, with the page. Ask me about a specific permit, inspection or document.",
  legal: "I can't give legal advice. I can show what your documents say, with the page.",
  untracked: "DeepWell doesn't read that kind of paperwork for electrical companies yet. Ask about permits, inspections, panel schedules, licenses, insurance or bonds.",
};

const STOP = new Set(('a an the of for at on in to is are was were be been do does did has have had how many much what which who whom when where why show list tell give me us we our my your any every all each still now yet ever not no and or with from by about this that these those there their it its into out over under per as than then so if can could would should will shall may might must next last first new old current open closed passed failed fail pass rough roughin final inspection inspections inspector report reports permit permits panel panels job jobs site address account customer customers project projects work done on file number numbers code edition mention mentions say says state states issue issued issues office city county jurisdiction expire expires expired expiring expiration expiry insurance certificate certificates license licenses licence bond bonds contractor load calculation calc demand connected size main breaker breakers amp amps amperage voltage phase volts total count day days week weeks month months year years soon due test tests generator generators correction corrections item items list lists detail details record records document documents doc docs primary also please thanks unresolved outstanding pending overdue upcoming schedules calculations certificates results required haven hasn don finaled finals roughs result issue issued office offices tell').split(/\s+/));
const SUFFIX = new Set(['st', 'street', 'ave', 'avenue', 'rd', 'road', 'dr', 'drive', 'ln', 'lane', 'blvd', 'boulevard', 'way', 'ct', 'court', 'cir', 'circle', 'pl', 'place', 'pkwy', 'hwy', 'ter', 'trl']);
const norm = (s) => String(s ?? '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
const toks = (s) => norm(s).split(' ').filter(Boolean);
const STREET_SUF = 'st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|way|ct|court|cir|circle|pl|place|pkwy|parkway|hwy|ter|terrace|trl|trail';
const STREET_RE = new RegExp(`\\b(?:\\d{1,6}\\s+)?((?:[a-z0-9]+\\s+){1,2})(?:${STREET_SUF})\\b`, 'g');
const placeTokens0 = (q) => toks(q).filter((t) => !STOP.has(t) && !SUFFIX.has(t) && t.length > 1 && (!/^\d{1,2}$/.test(t) || true));

// A street phrase the person typed is kept word for word ("123 Main St" needs 123 AND main), even where a word is also a common word.
const placeTokens = (q) => {
  const base = placeTokens0(q);
  const ms = [...norm(q).matchAll(STREET_RE)];
  const extra = ms.flatMap((m) => m[0].split(' ').filter((t) => t && !/^(?:on|at|in|for|the|of|to|a|an|is|are|any|my|our)$/.test(t) && !new RegExp(`^(?:${STREET_SUF})$`).test(t)));
  // the street type typed ("412 Elm Avenue") is part of the address: kept as a "~ave" marker that matchPlace holds the document's street type to
  const sufs = ms.map((m) => `~${SUF_CANON[m[0].split(' ').pop()] ?? m[0].split(' ').pop()}`);
  const lone = [...String(q).matchAll(/\b(\d)\s+[A-Za-z]{3,}/g)].map((m) => m[1]); // "8 Harmon": a one-digit street number is part of the address, never dropped (8 is not 88)
  return [...new Set([...base, ...lone, ...extra, ...sufs])];
};

const PASS_RE = /\b(?:pass(?:es|ed)?|approved|accepted|satisfactory|complies|complied|ok|okay|no corrections|cleared|released)\b/i;
const FAIL_RE = /\b(?:fail(?:ed|ure)?|reject(?:ed)?|not approved|disapproved|denied|corrections?\s+(?:required|needed|issued)|correction notice|not passed|did not pass|unsatisfactory|red[- ]?tag(?:ged)?|needs? corrections?|re-?inspection (?:required|needed)|does not comply|no pass)\b|^\s*corrections?\s*$/i;
const NEG_RE = /\b(?:not|un|dis|non)[- ]?(?:passed?|approved|accepted|satisfactory|ok|okay|cleared|complies|compliant)\b|\bunsatisfactory\b/i;
const COND_RE = /\bwith\s+(?:corrections?|conditions?|comments?|exceptions?)\b|\bconditional(?:ly)?\b|\bpartial(?:ly)?\b|\bcorrect\w*|\bdeficienc\w*|\bviolations?\b|\bpending\b|\bnoted\b|\bto follow\b|\bw\/|\bre-?inspection\b|\bcomments?\b/i;
const NO_CORR = /\b(?:0|zero|no|none)\s+(?:fail\w*|deficienc\w*|violations?)\b|\bfail\w*\s*[:=]?\s*(?:0|zero|none|no)\b|\bcorrections?(?:\s+(?:required|needed|issued|noted))?\s*[:=\-]?\s*(?:none|nil|zero|0|n\/a|na)\b|\bno\s+corrections?(?:\s+(?:required|needed|issued|noted))?\b|\bwithout\s+corrections?\b|\bcorrections?\s+(?:not\s+(?:required|needed|issued))\b|\bcorrection notice not issued\b|\bno correction notice\b|\bno\s+re-?inspection(?:\s+(?:required|needed|necessary|fee))?\b|\bre-?inspection\s+not\s+(?:required|needed|necessary)\b|\bwithout\s+re-?inspection\b/gi;
const NEG_PASS = /\b(?:not|never|didn'?t|did not|un|non|dis|no)[- ]?\s*(?:pass(?:ed|es)?|approved|accepted|satisfactory|ok|okay|cleared|complies|complied|compliant|released)\b/gi;
const PASS_WORD = /\b(?:pass(?:es|ed)?|approved|accepted|satisfactory|complies|complied|ok|okay|cleared|released)\b/i;
/** "Failed - re-inspection passed": both a failure and a pass are written on one line, so it is neither (never counted as failed, never as passed). */
const UNCHECKED = /(?:\[\s*\]|☐|□)/;
const PASS_CLEAN = /^(?:(?:final |rough[- ]?in |underground |service )?(?:inspection )?(?:pass(?:ed|es)?|approved|accepted|satisfactory|ok(?:ay)?|complies|complied|cleared|released|inspection passed|work approved)|no corrections?(?: (?:required|needed|noted|issued))?)$/i;
/**
 * failed / passed / other / mixed. "passed" only for a result that is plainly a pass (Passed, Approved, Accepted, OK, ...). A result that mixes a
 * pass word with anything else ("Pass except panel cover", "Approved - TCO", "Passed - void", "Passed 2/3", an unchecked box) or says both failed and passed is 'mixed':
 * it is never counted as a pass or a failure, and answers resting on it decline.
 */
export const resultClass = (r0) => {
  let r1 = String(r0 ?? '').replace(NO_CORR, ' ');
  if (UNCHECKED.test(r1)) { r1 = r1.replace(/\S+\s*(?:\[\s*\]|☐|□)|(?:\[\s*\]|☐|□)\s*\S+/g, ' ').trim(); if (!r1) return 'mixed'; }
  if (!r1.trim() && String(r0 ?? '').trim()) return 'passed'; // "Corrections Required: None", "0 failed": nothing was found wrong
  const base = resultClass0(r1, String(r0 ?? ''));
  if (base === 'failed') return PASS_WORD.test(r1.replace(NEG_PASS, ' ').replace(NEG_RE, ' ')) ? 'mixed' : 'failed';
  if (base === 'passed') { const clean = r1.replace(/\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/g, ' ').replace(/[\s.!:;,-]+$/g, '').replace(/^[\s:-]+/, '').trim(); return PASS_CLEAN.test(clean) ? 'passed' : 'mixed'; }
  if (base === 'other' && PASS_WORD.test(String(r0 ?? '').replace(NEG_PASS, ' ')) && !COND_RE.test(String(r0 ?? ''))) return 'mixed';
  return base;
};
const resultClass0 = (r, orig) => (FAIL_RE.test(r ?? '') || NEG_RE.test(r ?? '') ? 'failed' : COND_RE.test(r ?? '') ? 'other' : PASS_RE.test(orig ?? '') ? 'passed' : 'other');
const isFinal = (t) => !/\bpre[- ]?final\b|\bnot final\b|\bpartial\b|\bphase\s*\d|\btco\b|\bpower only\b|\brelease\b|\btemp(?:orary)?\b|\bmeter\b|\bservice release\b|\bunderground\b|\bnon[- ]?final|\bsemi[- ]?final|\binterim|\bno final|\bfinal (?:rough|framing|pending|request\w*|schedul\w*)|\brough final|\brequest(?:ed)?\b|\bscheduled\b/i.test(t ?? '') && /\bfinal(?:ed)?\b|sign[- ]?off/i.test(t ?? '');
const stageOf = (t) => (isFinal(t) ? 'final' : /\bpre[- ]?final\b/i.test(t ?? '') ? 'prefinal' : /\brough/i.test(t ?? '') ? 'rough' : /\bunderground\b/i.test(t ?? '') ? 'underground' : /\b(?:service|meter|temporary|cover)\b/i.test(t ?? '') ? 'service' : 'other');
const isRough = (t) => /\brough/i.test(t ?? '');

const humanDate = (iso) => {
  const m = String(iso ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(iso ?? '');
  const mo = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][+m[2] - 1];
  return `${mo} ${+m[3]}, ${m[1]}`;
};
const FAMILIES = [['generator', /\bgenerators?\b|\bgenset\b/i], ['transfer', /\btransfer switch|\bats\b/i], ['thermography', /\bthermograph|\binfrared\b/i], ['megger', /\bmegger|\binsulation[- ]resistance/i], ['arcflash', /\barc[- ]flash/i], ['groundfault', /\bground[- ]fault/i]];
const familyOf = (d) => { const t = `${f(d, 'equipment_type') ?? ''}`; const hit = FAMILIES.filter(([, re]) => re.test(t)); return hit.length > 1 ? 'ambiguous' : hit.length ? hit[0][0] : null; }; // "Generator Transfer Switch" is two kinds of equipment: neither
const unitOf = (d) => `${alnum(f(d, 'serial_number') ?? '')} ${norm(f(d, 'equipment_detail') ?? '').replace(/\s+/g, '')}`.trim();
/** One piece of equipment: the full street address (city included), the kind of test, and its serial number / unit description. */
const testKey = (d) => norm(`${addrKey(d)} ${cityOf(d) ?? ''} ${familyOf(d) ?? f(d, 'equipment_type') ?? d.filename.replace(/\d+/g, '')} ${unitOf(d)}`);
const testGroupKey = (d) => norm(`${addrKey(d)} ${cityOf(d) ?? ''} ${familyOf(d) ?? f(d, 'equipment_type') ?? d.filename.replace(/\d+/g, '')}`);
/** Reports at one address for one kind of test where we cannot tell a retest from another unit: a unit with no serial/description beside one with, differing descriptions, or an undated report beside another. */
function ambiguousTests(docs) {
  const g = new Map(); for (const d of docs.filter((x) => x.type === 'test-report')) (g.get(testGroupKey(d)) ?? g.set(testGroupKey(d), []).get(testGroupKey(d))).push(d);
  const out = new Set();
  for (const d of docs) if (d.type === 'test-report' && familyOf(d) === 'ambiguous') out.add(d);
  { const g2 = new Map(); for (const d of docs.filter((x) => x.type === 'test-report')) { const k = `${addrKey(d)}|${familyOf(d) ?? f(d, 'equipment_type')}`; (g2.get(k) ?? g2.set(k, []).get(k)).push(d); } for (const ds of g2.values()) if (new Set(ds.map(testKey)).size > 1 && new Set(ds.map((d) => cityOf(d) ?? '')).size > 1 && ds.some((d) => !cityOf(d))) for (const d of ds) out.add(d); } // the same equipment written with and without its city
  for (const d of docs) if (d.type === 'test-report' && !f(d, 'equipment_type')) out.add(d); // a report that names no kind of equipment: its unit cannot be told from another's
  { const k = new Map(); for (const d of docs.filter((x) => x.type === 'test-report')) (k.get(`${testKey(d)}|${f(d, 'service_date') ?? ''}`) ?? k.set(`${testKey(d)}|${f(d, 'service_date') ?? ''}`, []).get(`${testKey(d)}|${f(d, 'service_date') ?? ''}`)).push(d); for (const ds of k.values()) if (ds.length > 1 && new Set(ds.map((d) => f(d, 'next_test_due') ?? '')).size > 1) for (const d of ds) out.add(d); }
  for (const ds of g.values()) { if (ds.length < 2) continue; const units = new Set(ds.map(unitOf)); const eqs = new Set(ds.map((d) => norm(f(d, 'equipment_type') ?? '')));
    const mixedId = units.has('') && units.size > 1;
    const undated = new Map(); for (const d of ds) { const u = unitOf(d); undated.set(u, (undated.get(u) ?? 0) + (okIso(f(d, 'service_date')) ? 0 : 1)); }
    const bad = mixedId || (units.size === 1 && eqs.size > 1) || [...undated.entries()].some(([u, n]) => n > 0 && ds.filter((d) => unitOf(d) === u).length > 1);
    if (bad) for (const d of ds) out.add(d); }
  return out;
}
// the newest report per piece of equipment decides: a retest with no printed due date must not leave last year's date showing as overdue
const latestTests = (docs) => { const m = new Map(); for (const d of [...docs.filter((x) => x.type === 'test-report')].sort((a, b) => String(f(a, 'service_date') ?? '').localeCompare(String(f(b, 'service_date') ?? '')))) m.set(testKey(d), d); return [...m.values()]; };
const okIso = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d ?? '');
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/* ------------------------------------------------------------------ classification (pure) */
const KINDS = {
  doctypes: [
    ['permit', /\bpermits?\b/], ['inspection-report', /\binspections?\b/], ['panel-schedule', /\bpanel schedules?\b/],
    ['load-calculation', /\bload calc(?:ulation)?s?\b/], ['certificate-of-insurance', /\b(?:insurance certificates?|certificates? of insurance|coi)\b/],
    ['contractor-license', /\blicen[sc]es?\b/], ['surety-bond', /\bbonds?\b/], ['test-report', /\btest reports?|studies|study\b/],
    ['correction-notice', /\bcorrection notices?\b/], ['utility-application', /\butility applications?|interconnection/],
  ],
};

export function classifyElectrical(question, opts = {}) {
  const r = classify0(question, opts);
  if (r && r.kind !== 'decline') {
    const qq = norm(question);
    // wording the lane does not apply to its lists and counts: a negated place / customer / stage, an extra qualifier (closed, new, last ...), a split by city, "pass all/every", a negative number
    if (/\bnot\s+(?:in|at|for|on|rough|rough-?in|final|finals|the|a|an|from|by|near|with)\b/.test(qq)) return null;
    if (/-\s*\d/.test(String(question).replace(/\b\d{4}-\d{2}-\d{2}\b|[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+/g, ' '))) return null;
    if (r.kind === 'count_type' && /\b(?:finaled|finalled|done|been)\b/.test(qq)) return null;
    if (['failed_inspections', 'open_permits', 'permit_city', 'count_type', 'inspection_result'].includes(r.kind) && /\b(?:closed(?: out)?|resolved|new|old|current|next|last|latest|oldest|newest|per|without|pending|had|completed|by (?:city|customer|address|month|stage|type)|(?:no|zero) (?:inspections?|cards?|reports?))\b/.test(qq) && !(r.kind === 'inspection_result' && /\b(?:last|latest|newest)\b/.test(qq))) return null;
    if (r.kind === 'inspection_result' && /\b(?:all|every|each|both|count|number)\b/.test(qq)) return null;
    if (r.kind === 'failed_inspections' && r.unresolved === false && /\b(?:unresolved|outstanding|open|still|pending|resolved)\b/.test(qq)) return null;
    if (r.kind === 'credentials' && ((/\b(?:workers|worker s|comp|wc|gl|general liability|liability|auto|umbrella)\b/.test(qq) && (r.expiredOnly || r.withinDays != null)) || /\b(?:past due|overdue)\b/.test(qq) || /[A-Za-z]\s+(?:Bond|Licen[sc]e|Insurance|Surety)\b/.test(String(question)) || /\bwhen (?:did|was|were)\b/.test(qq) || /\b\d+\s+\w+\s+(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|way|ct|court)\b/.test(qq))) return null;
    if (r.kind === 'credentials' && /\b(?:for|of|at|from)\s+(?!(?:the|us|me|my|our|all|any|each|this|next|a|an|every|it|them|now|years?)\b)[a-z]/.test(qq)) return null; // a credential question that names someone ("the bond for Pike Brewing"): credentials are not tracked per customer
    r.raw = String(question);
  } // the question as typed: a customer's own name is re-read against the company's records (see rescope)
  return r;
}
function classify0(question, { today } = {}) {
  const q = norm(question);
  if (!q || q.length > 400) return null;
  // ---- hard-limit declines first (never answered, never sent to a model)
  if (/\b(?:meet|meets|meeting|pass|passes|comply|complies|compliant|violat\w*|up to code|to code|code compliant|per code|legal|legally|allowed|required to|have to|need a permit|permit required|should (?:have|it have)|supposed to)\b/.test(q)
      && /\b(?:code|nec|compliance|compliant|legal|legally|violation|violate)\b/.test(q)
      && !/\b(?:which|what|who|when|how many|list|show)\b.*\b(?:permit number|inspection result|edition|passed|failed)\b/.test(q)
      && !(/\b(?:did|has|have)\b.*\b(?:pass\w*|fail\w*)\b.*\b(?:inspection|rough|final)\b/.test(q) && !/\b(?:should|meets?|comply|complies|violat\w*|legal|up to code|to code)\b/.test(q))) {
    if (/\blegal|legally|lawsuit|liab\w+|sue\b/.test(q)) return { kind: 'decline', which: 'legal' };
    return { kind: 'decline', which: 'code' };
  }
  if (/\b(?:sued?|lawsuit|liable|negligen\w*)\b/.test(q)) return { kind: 'decline', which: 'legal' };
  if (/\b(?:per|under|according to) (?:the )?(?:nec|code)\b|\bnec\b.*\b(?:ok|okay|enough|adequate|sufficient|right|correct)\b|\bright call\b/.test(q)) return { kind: 'decline', which: 'code' };
  if (/\bshould(?:n.?t| not)?\b.*\b(?:have|has|been)\s+(?:passed|failed|approved|rejected)\b|\bshould (?:it|that|this) pass\b/.test(q)) return { kind: 'decline', which: 'code' };
  if (/\b(?:what does (?:the )?(?:nec|code) (?:say|require)|is (?:it|this|that) (?:legal|allowed|code)|does (?:this|that|it) (?:meet|pass) (?:the )?code|will (?:it|this) pass|should (?:this|it) have passed|do i need a permit|is a permit (?:required|needed))\b/.test(q)) return { kind: 'decline', which: 'code' };
  // ---- other industries' words are never answered from electrical records
  if (/\b(?:backflow|water heater|leases?|rent roll|which tenants|tenants (?:have|has|with|owe|are|is)|refrigerant|tonnage|seer|furnace|condenser)\b/.test(q)) return { kind: 'decline', which: 'untracked' };

  // ---- one question at a time: two different asks in one sentence go to the normal path rather than half an answer
  const openRe = /\b(?:open permits?|permits? (?:are |is )?(?:still )?open|still open|no final(?: inspection)?|without a final(?: inspection)?|unfinaled|not (?:been )?finaled|finaled)\b/g;
  const hasOpen = openRe.test(q); const q2 = q.replace(openRe, ' ');
  const groups = (hasOpen ? 1 : 0) + [/\bpermit (?:number|no|#)|\bissued\b|\bwhich office|\bjurisdiction|permits? expir/, /\bedition\b|\bnec\b/, /\b(?:breaker|panel|amps?|amperage|voltage|volts?|phase|service size)\b/, /\b(?:load|demand|connected)\b/, /\b(?:pass|passed|fail|failed|result|rough|final|corrections?|why)\b/, /\b(?:licen[sc]es?|insurance|coi|bonds?)\b/, /\bhow many\b.*\bhow many\b|\bhow many\b.*\b(?:and|,)\b.*\bfailed\b/, /\btests?\b/].filter((re) => re.test(q2)).length;
  if (groups >= 2) return null;
  // relative time, "per month", "customers"/"jobs" counts and ordinals are conditions these answers do not apply
  if (/\b(?:last|past|previous)\s+(?:\d+\s+)?(?:days?|weeks?|months?|years?)\b|\b(?:days?|weeks?|months?|years?)\s+ago\b|\bover\s+\d+\s+(?:days?|weeks?|months?|years?)\b|\b(?:this|last)\s+(?:week|month|quarter|year)\b|\bper\s+(?:day|week|month|year)\b|\b(?:a|each|every)\s+(?:day|week|month|year)\b|\b(?:today|yesterday|tomorrow|tonight)\b|\b(?:first|oldest|earliest|original|initial)\b/.test(q)) return null;
  if (/\bhow many\b/.test(q) && /\b(?:customers?|clients?|jobs?|sites?|addresses|locations?|properties|people|companies)\b/.test(q) && !/\b(?:licen[sc]es?|bonds?|insurance)\b/.test(q)) return null;
  const timeQ = /\b(?:this|last|next)\s+(?:week|month|quarter|year)\b|\b(?:since|before|after|during)\b|\bin\s+(?:january|february|march|april|may|june|july|august|september|october|november|december|20\d\d)\b/.test(q);
  if (/[@&]|\b(?:corner|intersection|cross street|at the corner)\b/i.test(String(question))) return null; // an intersection ("Main @ Elm") is two streets: no single-address answer
  const place = placeTokens(String(question).replace(/\b\d{2,4}\s*(?:amps?|a|volts?|v|kva|kw|va)\b/gi, ' ').replace(/\b(?:next|within|in the next|over the next|in)\s+\d{1,3}\s+(?:days?|weeks?|months?)\b/gi, ' '));
  if (/\b(?:next|within|in the next|over the next|in)\s+\d{1,3}\s+months?\b/.test(q) && /\b(?:expir\w*|due|renew\w*)\b/.test(q)) return null;
  const win = (() => { const m = q.match(/\b(?:next|within|in the next|over the next|in)\s+(\d{1,3})\s+(day|days|week|weeks|month|months)\b/); if (!m) return null; const n = +m[1]; return m[2].startsWith('week') ? n * 7 : m[2].startsWith('month') ? n * 30 : n; })();

  // ---- credentials (license / insurance / bond)
  // any number, unit of time or comparison left over once the one supported window ("in the next 60 days") is removed is a condition this list does not apply
  const WINRE = /\b(?:next|within|in the next|over the next|in)\s+\d{1,3}\s+(?:day|days|week|weeks|month|months)\b/;
  const windowOdd = /\d\s*\+|\+\s*\d/.test(String(question)) || ((qr) => /\b20\d\d\b|\b(?:days?|weeks?|months?|years?|fortnight|ago|from now|later|exactly|between|over|more|less|than|but|yet|and which|and how many|and what|and who)\b/.test(qr))(q.replace(WINRE, ' '));
  const NEGDIR = /\b(?:not|no|never|won t|wont|n t|without|except|excluding|aren t|isn t|more than|or more|at least|beyond|later than|after the next|after next)\b/;
  const cred = /\b(?:licen[sc]es?|insurance certificates?|certificates? of insurance|coi|insurance|workers comp\w*|bonds?|surety)\b/.test(q) && /\b(?:expir\w*|renew\w*|lapse\w*|valid|good through|when|due)\b/.test(q);
  const CAL = /\b(?:jan\w*|feb\w*|march|apr\w*|may|june?|july?|aug\w*|sep\w*|oct\w*|nov\w*|dec\w*|q[1-4]|through|thru|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\b/;
  if (cred) {
    if (windowOdd) return null;
    if (/\b[a-z]{1,5}[- ]?\d{3,}\b|\b\d{5,}\b/i.test(String(question))) return null; // a named license / policy / bond number: this list does not filter by number
    if (NEGDIR.test(q)) return null; // "won't expire", "60 days or more": the opposite of what the list answers
    if (win == null && CAL.test(q)) return null;
    if (/\b(?:journeyman|master|apprentice)\b|\b\w+ s (?:licen[sc]es?|insurance|bonds?|coi)\b/.test(q)) return null;
    if (/\b(?:not|never|n t)\s+(?:\w+\s+)?(?:expired|lapsed)\b/.test(q) || /\b(?:last|past|previous)\s+\d{1,3}\s+(?:days?|weeks?|months?)\b/.test(q)) return null;
    if (win == null && /\b(?:this|next|last)\s+(?:week|month|quarter|year)\b|\b(?:before|by|after|until)\s+[a-z0-9]+/.test(q)) return null;
    const types = [];
    if (/\blicen[sc]e/.test(q)) types.push('contractor-license');
    if (/\b(?:insurance|coi|workers comp)/.test(q)) types.push('certificate-of-insurance');
    if (/\b(?:bond|surety)/.test(q)) types.push('surety-bond');
    if (/\b(?:valid|current|currently|still|today|tomorrow|tonight|yesterday|recent\w*|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(q) || /\b\d+\s*d\b|\bin \d+\b|^\d+$/.test(q) && win == null) return null;
    return { kind: 'credentials', types, withinDays: win ?? (/\b(?:expired|already expired|lapsed)\b/.test(q) && !/\b(?:soon|about to|upcoming|expiring)\b/.test(q) ? 0 : /\b(?:soon|about to|upcoming|coming up|expiring)\b/.test(q) ? 60 : null), expiredOnly: /\b(?:already )?(?:expired|lapsed)\b/.test(q) && !/\bwill\b|\bexpiring\b|\bnext\b|\bsoon\b|\babout to\b|\bupcoming\b/.test(q) };
  }
  // ---- tests due
  if (/\b(?:tests?|studies|study|megger|thermography|arc flash|ats|transfer switch)\b/.test(q) && /\b(?:due|overdue|upcoming|next|coming up)\b/.test(q)) { if (windowOdd || NEGDIR.test(q) || /\b(?:this|last|next)\s+(?:week|month|quarter|year)\b|\b(?:before|by|after|until|since|during)\b|\bin\s+(?:january|february|march|april|may|june|july|august|september|october|november|december|20\d\d)\b/.test(q)) return null; const eq = ['generator', 'transfer', 'thermograph', 'infrared', 'megger', 'arc flash'].filter((w) => q.includes(w)); const pl = place.filter((t) => !/^(?:generator|transfer|switch|thermography|thermograph|infrared|megger|flash|arc)$/.test(t)); return { kind: 'tests_due', lookup: win == null && !/\b(?:soon|upcoming|due or)\b/.test(q) && (/\bwhen\b/.test(q) || (/^(?:is|are|was|were)\b/.test(q) && /\boverdue\b/.test(q))), overdueOnly: /\boverdue\b/.test(q) && !/\bdue or\b|\bor overdue\b|\bupcoming\b|\bnext\b/.test(q), withinDays: win ?? 60, eq, place: pl, specific: eq.length > 0 && pl.length > 0 }; }
  // ---- "has it ever failed" / "is there a failed inspection": the answer is the list of failures, never the newest result
  if (place.length && !/\b(?:last|this|next|since|before|after|during|yesterday|today|week|month|year|quarter|recent\w*|days?|ago|20\d\d)\b/.test(q) && /\b(?:ever|is there|are there|was there|were there|has|have|had|did|does|do)\b/.test(q) && /\bfail\w*|did not pass|not pass|reject\w*/.test(q) && !/\bpass(?:ed|es)?\b(?!\s*$)/.test(q.replace(/did not pass|not pass/g, ' '))) {
    if (/\b(?:not|never|haven t|hasn t|hadn t|without|no)\b/.test(q)) return null;
    return { kind: 'failed_inspections', place, unresolved: false, count: true, stage: /\bfinals?\b/.test(q) && !/\brough/.test(q) ? 'final' : /\brough/.test(q) && !/\bfinals?\b/.test(q) ? 'rough' : null };
  }
  if (place.length && /\bever\b/.test(q) && /\bpass\w*|approved/.test(q)) return null;
  // ---- corrections
  if (/\bcorrections?\b|failed inspections?|failed (?:rough|final)|did not pass|inspections? (?:that )?failed|failed the/.test(q) && /\b(?:show|list|every|which|what|any|how many)\b/.test(q) && !/\b(?:did|does|was|were)\b.*\bpass\b/.test(q)) { if (timeQ || /\b(?:not|never|haven t|hasn t|didn t|without|no)\b.*\b(?:fail\w*|pass\w*)\b/.test(q)) return null; return { kind: 'failed_inspections', place, unresolved: /\b(?:open|outstanding|unresolved|pending|still)\b/.test(q), count: /\bhow many\b/.test(q), stage: /\bfinals?\b/.test(q) && !/\brough/.test(q) ? 'final' : /\brough/.test(q) && !/\bfinals?\b/.test(q) ? 'rough' : null }; }
  // ---- open permits / no final
  if (/\b(?:open permits?|permits? (?:are |is )?(?:still )?open|still open|unfinaled|no final|without a final|not (?:been )?finaled|haven.?t (?:been )?finaled|(?:issued permit|permit) but no final|never finaled|awaiting final|permits? (?:that )?(?:are )?not closed)\b/.test(q)) return timeQ || /\b(?:expir\w*|older|overdue|stale|aging|past due)\b/.test(q) ? null : { kind: 'open_permits', count: /\bhow many\b/.test(q), place, q };
  // ---- inspection result at a place
  if (/\bhow many\b/.test(q) && /\binspections?\b/.test(q) && /\b(?:pass\w*|fail\w*)\b/.test(q) && !/\bfailed inspections?\b/.test(q)) return null;
  if (/\b(?:pass|passed|fail|failed|result|results|status|approved|get approved)\b/.test(q) && /\b(?:inspection|rough|final|underground|service)\b/.test(q) || /\bdid\b.*\b(?:pass|fail)\b/.test(q)) {
    const stage = isFinal(q) && isRough(q) ? null : isFinal(q) ? 'final' : isRough(q) ? 'rough' : /\bunderground\b/.test(q) ? 'underground' : null;
    if (place.length) return { kind: 'inspection_result', place, stage };
  }
  // ---- permit number / jurisdiction / edition
  if (/\bwhen\b.*\bpermit\b.*\b(?:issued|pulled)\b|\bpermit\b.*\bissue date\b|\bissue date\b.*\bpermit\b/.test(q) && place.length) return { kind: 'permit_lookup', place, attr: 'issued' };
  if (/\bpermit number|permit no|permit #|which office issued|who issued|issuing (?:office|authority)|what jurisdiction|which jurisdiction|issued the permit\b/.test(q) && place.length) return { kind: 'permit_lookup', place };
  if (/\b(?:code )?edition\b|\bnec\b|which code/.test(q) && place.length) return { kind: 'code_edition', place };
  // ---- who is the owner / customer on one permit number (the permit's own paperwork names them)
  { const pn = /\b([a-z]{1,4}-\d{2}-\d{3,6})\b/i.exec(String(question)); if (pn && /^\s*(?:who|which customer|which owner)\b/.test(q) && /\b(?:owner|customer|client|belongs)\b/.test(q) && /\bpermit\b/.test(q)) return { kind: 'permit_party', permit: alnum(pn[1]) }; }
  // ---- panels
  if (/\b(?:main breaker|panel|panels|bus rating|service size|amperage|voltage|phase)\b/.test(q) && /\b(?:size|rating|rated|how big|what|list|amperage|voltage|phase|volts?|amps?)\b/.test(q) && place.filter((t) => t !== 'service').length && !/\bpermit|inspection\b/.test(q)) return { kind: 'panel_facts', want: [/\bvolt/.test(q) && 'voltage', /\bphase\b/.test(q) && 'phase', (/\b(?:amps?|amperage|size|rating|rated|main|breaker|how big)\b/.test(q) || !/\bvolt|\bphase\b/.test(q)) && 'amperage'].filter(Boolean), place: place.filter((t) => t !== 'service'), list: /\b(?:list|show|every|all)\b/.test(q) };
  // ---- load calculation
  if (/\bload calc|demand load|connected load|service load\b/.test(q) && place.length) return { kind: 'load_calc', place, field: /\bconnected\b/.test(q) && /\bdemand\b/.test(q) ? 'both' : /\bconnected\b/.test(q) ? 'connected_load' : 'demand_load' };
  // ---- counts by document type
  const cm = /\b(?:closed|open|pass\w*|expir\w*|this month|this year|last|since|before|after|overdue|due|not|never|current|valid|fail\w*|reject\w*|correction\w*|re-?inspect\w*|final|rough|underground|temporary|upcoming|scheduled|active)\b/.test(q) ? null : q.match(/\bhow many\b/);
  // a count/list of permits in a city ("how many permits are in Tempe"): the run step decides whether the word is a city on file; if not, null as before
  if (/\bpermits?\b/.test(q) && place.length && !/\b(?:expir\w*|overdue|due|fail\w*|not|never|since|before|after|this month|this year|last|open|closed|finaled?|finals?|passed|done|pending|outstanding|unresolved|current|old|new|complete\w*|active|inactive|valid|recent\w*|latest|oldest|issued|rough|underground)\b/.test(q) && (/\bhow many\b/.test(q) || /^(?:which|list|show|what|give)\b/.test(q))) return { kind: 'permit_city', count: /\bhow many\b/.test(q), place, q };
  // "Do we have a bond on file?": a yes / no on one kind of document, answered as the count of that kind (never a count of every document)
  if (/^(?:do we|do i|have we|is there|are there)\b.*\b(?:on file|have any|got any|any)\b/.test(q) && !place.length && !/\b(?:expir\w*|overdue|due|open|fail\w*|pass\w*|not|never|since|before|after|this|last|next|valid|current|active|final|rough)\b/.test(q)) { const hits = KINDS.doctypes.filter(([, re]) => re.test(q)); if (hits.length === 1) return { kind: 'count_type', type: hits[0][0], failed: false }; return null; }
  if (cm && !place.length) { const hits = KINDS.doctypes.filter(([, re]) => re.test(q)); if (hits.length === 1) return { kind: 'count_type', type: hits[0][0], failed: /\bfailed\b/.test(q) && hits[0][0] === 'inspection-report' }; }
  return null;
}

const failedDocs = (docs) => { const rep = docs.filter((d) => d.type === 'inspection-report' && resultClass(f(d, 'inspection_result')) === 'failed'); const dup = (n) => rep.some((r) => { const kp = alnum(f(n, 'permit_number') ?? ''); const rp = alnum(f(r, 'permit_number') ?? ''); const sameJob = kp && rp ? kp === rp : (addrKey(n) && addrKey(n) === addrKey(r)); const sn = f(n, 'inspection_type') ? stageOf(f(n, 'inspection_type')) : null; const sr = stageOf(f(r, 'inspection_type')); const dn = f(n, 'service_date'); const dr = f(r, 'service_date'); const near = !dn || !dr || (okIso(dn) && okIso(dr) ? Math.abs(daysBetween(dr, dn)) <= 60 : dn === dr); return sameJob && (!sn || sn === sr) && near; }); const seenF = new Set(); const uniq = rep.filter((d) => { const k = `${alnum(f(d, 'permit_number')) || addrKey(d) || norm(f(d, 'customer_name') ?? '')}|${stageOf(f(d, 'inspection_type'))}|${f(d, 'service_date') ?? ''}|${norm(f(d, 'inspection_result') ?? '')}`; if (seenF.has(k)) return false; seenF.add(k); return true; }); return [...uniq, ...docs.filter((d) => d.type === 'correction-notice' && !dup(d))]; };
const CERT_VOID = /\b(?:void|revoked|rescinded|expired|denied|not issued|withheld)\b/i;
/** A certificate of completion with no status written closes the permit; a status that is void is not closing; any other status (pending, on hold, draft ...) is unknown. */
const certState = (d) => { if (d.type !== 'certificate-of-completion') return null; const r = f(d, 'inspection_result'); if (!r) return 'closed'; if (CERT_VOID.test(r) || resultClass(r) === 'failed') return 'void'; return /\b(?:complete[d]?|final(?:ed)?|issued|approved|closed|passed|accepted|certified|satisfactory)\b/i.test(r) && !/\b(?:pending|hold|draft|progress|scheduled|submitted|awaiting|incomplete|not|partial|conditional|temporary|tco)\b/i.test(r) ? 'closed' : 'unknown'; };
const certClosed = (d) => certState(d) === 'closed';
const isFailedDoc = (d) => d.type === 'correction-notice' || (d.type === 'inspection-report' && resultClass(f(d, 'inspection_result')) === 'failed');
/* ------------------------------------------------------------------ data */
/** Every document with its extracted values and the page each value came from (corrected values win). */
/** Keys other readers may store a lane field under (a model-read document, an older import): read as the lane's own key, per document type. */
const ALIAS = {
  inspection_result: { types: ['inspection-report', 'correction-notice', 'certificate-of-completion'], from: ['status', 'result', 'inspection_status', 'outcome', 'inspection_outcome'] },
  license_expiry: { types: ['contractor-license'], from: ['expiry', 'expires', 'expiration', 'expiry_date', 'expiration_date', 'license_expires', 'valid_through'] },
  policy_expiry: { types: ['certificate-of-insurance'], from: ['expiry', 'expires', 'expiration', 'expiry_date', 'expiration_date', 'policy_expires', 'valid_through'] },
  bond_expiry: { types: ['surety-bond'], from: ['expiry', 'expires', 'expiration', 'expiry_date', 'expiration_date', 'bond_expires', 'valid_through'] },
  next_test_due: { types: ['test-report'], from: ['next_due', 'due_date', 'next_test_date', 'retest_date'] },
};
/** Place / permit keys other readers store, for every document type (a card that says "permit_no" is linked like one that says "permit_number"). */
const ALIAS_ANY = { permit_number: ['permit_no', 'permit_num', 'permit_id', 'permit_nr'], service_address: ['address', 'site_address', 'job_address', 'property_address', 'job_site_address'], customer_name: ['customer', 'client', 'client_name', 'customer_full_name'] };
const aliasOf = (type, key) => { for (const [canon, a] of Object.entries(ALIAS)) if (a.types.includes(type) && a.from.includes(key)) return canon; for (const [canon, from] of Object.entries(ALIAS_ANY)) if (from.includes(key)) return canon; return null; };
/** Keys that hold ONE value per document (two different readings of one is a conflict, never "the first"). A certificate listing several coverages keeps several policy numbers and expiries. */
const SCALARS = ['permit_number', 'inspection_type', 'inspection_result', 'service_date', 'license_number', 'license_expiry', 'bond_number', 'bond_expiry', 'permit_expiry', 'permit_issue_date', 'next_test_due', 'service_address'];
async function loadDocs(db) {
  const aud = await laneAudienceSql(db, 'd');
  const { rows } = await db.raw(
    `SELECT d.id, d.original_filename AS filename, d.document_type AS type, d.created_at,
            x.field_key AS key, COALESCE(x.corrected_value, x.value) AS value, f.page_no AS page
       FROM documents d
       LEFT JOIN extractions x ON x.document_id = d.id AND x.${TENANT}
       LEFT JOIN facets f ON f.id = x.source_facet_id
      WHERE d.${TENANT} AND d.document_type IS NOT NULL AND ${aud}
      ORDER BY d.created_at, d.id, x.created_at, x.id`, []);
  const map = new Map();
  for (const r of rows) {
    let d = map.get(r.id);
    if (!d) { d = { id: r.id, filename: r.filename, type: String(r.type).replace(/_/g, '-'), fields: {}, all: {} }; map.set(r.id, d); }
    const cv = cleanValue(r.value);
    if (r.key && cv != null) {
      let key = r.key; const al = aliasOf(d.type, key); if (al) key = al; // a value stored under an alias counts as the lane's own field
      let v = cv;
      // a model-read date can arrive as printed text; the lane only ever compares real ISO dates
      if (/_(?:date|expiry|due)$/.test(key) && !/^\d{4}-\d{2}-\d{2}$/.test(v)) { const iso = parseDate(v); if (iso) v = iso; }
      if (/_(?:expiry|due)$/.test(key) && /^\d{4}-\d{2}$/.test(v)) { const [yy, mm] = v.split('-').map(Number); v = new Date(Date.UTC(yy, mm, 0)).toISOString().slice(0, 10); } // a month-only expiry runs to the end of that month
      (d.all[key] ??= []).push({ value: v, page: r.page ?? 1 });
      d.fields[key] ??= { value: v, page: r.page ?? 1 };
    }
  }
  const out = [...map.values()];
  for (const d of out) {
    d.conflict = conflictKeys(d, d.type === 'certificate-of-insurance' ? SCALARS.filter((k) => k !== 'policy_expiry') : SCALARS);
    // a certificate listing several coverages: the EARLIEST expiry decides, and it is said so
    const ex = [...new Map((d.all.policy_expiry ?? []).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.value)).map((x) => [x.value, x])).values()].sort((a, b) => a.value.localeCompare(b.value));
    if (d.type === 'certificate-of-insurance' && ex.length > 1) { d.fields.policy_expiry = ex[0]; d.multi = true; }
  }
  for (const d of out) for (const k of Object.keys(d.all)) if (/_(?:expiry|due)$/.test(k) && d.all[k].some((x) => !/^\d{4}-\d{2}-\d{2}$/.test(x.value))) d.conflict.add(k); // a second reading of a date that cannot be read: never ignored
  linkCardsToPermits(out);
  return out;
}
const CARD_TYPES = ['inspection-report', 'correction-notice', 'certificate-of-completion'];
/**
 * An inspection card / correction notice / certificate that prints only a permit number belongs to the customer and address on
 * THAT permit's own paperwork. Linked only when the permit papers agree with each other and with the card; any disagreement
 * (one number on two customers, a card naming someone else) marks every paper involved 'permit_link' so answers resting on
 * them decline rather than guess. A card that stays unplaced (no permit on file, no address, no customer) is marked unplaced.
 */
function linkCardsToPermits(out) {
  const byNo = new Map(); const permits = out.filter((x) => x.type === 'permit');
  for (const d of out) if (d.type === 'permit' && f(d, 'permit_number')) { const k = alnum(f(d, 'permit_number')); (byNo.get(k) ?? byNo.set(k, []).get(k)).push(d); }
  for (const ps of byNo.values()) {
    const cs = new Set(ps.map((p) => norm(f(p, 'customer_name') ?? '')).filter(Boolean)); const as = new Set(ps.map(addrKey).filter(Boolean));
    const forms = new Set(ps.map((p) => norm(f(p, 'permit_number'))).filter((x) => x.includes(' '))); // A-12-345 and A-123-45 differ only in where the dashes sit: not told apart (a number typed without dashes still matches)
    if (cs.size > 1 || as.size > 1 || forms.size > 1) for (const p of ps) p.conflict.add('permit_link');
  }
  for (const d of out) {
    if (!CARD_TYPES.includes(d.type)) continue;
    const no = alnum(f(d, 'permit_number') ?? '');
    const ps = no ? byNo.get(no) : null;
    if (ps?.length) {
      const bad = ps.some((p) => p.conflict.has('permit_link'));
      const pc = ps.map((p) => f(p, 'customer_name')).find(Boolean); const pa = ps.map((p) => f(p, 'service_address')).find(Boolean);
      const oc = f(d, 'customer_name'); const oa = f(d, 'service_address');
      const clash = bad || (oc && pc && norm(oc) !== norm(pc)) || (oa && pa && canonAddr(oa) !== canonAddr(pa));
      if (clash) { d.conflict.add('permit_link'); for (const p of ps) p.conflict.add('permit_link'); d.unplaced = true; continue; }
      const pp = ps.find((p) => f(p, 'customer_name')); const ap = ps.find((p) => f(p, 'service_address'));
      if (!oc && pp) d.fields.customer_name = { value: f(pp, 'customer_name'), page: pp.fields.customer_name.page, derived: true };
      if (!oa && ap) d.fields.service_address = { value: f(ap, 'service_address'), page: ap.fields.service_address.page, derived: true };
    }
    // address only: the one customer whose permits are at that address; customer only: the one address that customer's permits are at (several = unknown)
    if (!f(d, 'customer_name') && f(d, 'service_address')) { const cs = new Map(permits.filter((p) => addrKey(p) === addrKey(d) && f(p, 'customer_name')).map((p) => [norm(f(p, 'customer_name')), p])); if (cs.size === 1) { const p = [...cs.values()][0]; d.fields.customer_name = { value: f(p, 'customer_name'), page: p.fields.customer_name.page, derived: true }; } }
    else if (f(d, 'customer_name') && !f(d, 'service_address')) { const as = new Map(permits.filter((p) => norm(f(p, 'customer_name') ?? '') === norm(f(d, 'customer_name')) && f(p, 'service_address')).map((p) => [addrKey(p), p])); if (as.size === 1) { const p = [...as.values()][0]; d.fields.service_address = { value: f(p, 'service_address'), page: p.fields.service_address.page, derived: true }; } }
    if (!f(d, 'customer_name') && !f(d, 'service_address')) d.unplaced = true;
    d.noCust = !f(d, 'customer_name'); d.noAddr = !f(d, 'service_address');
  }
}
const alnum = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const editDist = (a, b) => { const m = a.length; const n = b.length; let prev = Array.from({ length: n + 1 }, (_, j) => j); for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; } return prev[n]; };
const CRED = { 'contractor-license': ['license_expiry', 'license_number', 'Contractor license'], 'certificate-of-insurance': ['policy_expiry', 'policy_number', 'Insurance certificate'], 'surety-bond': ['bond_expiry', 'bond_number', 'Surety bond'] };
/**
 * Papers of one credential type that may be one and the same credential, so "the newest per number" cannot decide: a paper with no
 * number next to any other paper of that type, or two numbers one or two characters apart (a typo, or sequential policies).
 * Numbers that differ only by case, spaces or punctuation are the SAME credential (alnum key), not ambiguous.
 */
function ambiguousCreds(docs, type) {
  const [, numK] = CRED[type]; const of = docs.filter((x) => x.type === type);
  if (of.length > 1 && of.some((d) => !alnum(f(d, numK)))) return new Set(of);
  const out = new Set(); const keyed = of.map((d) => ({ d, k: alnum(f(d, numK)), runs: String(f(d, numK) ?? '').match(/\d{5,}/g) ?? [] }));
  for (let i = 0; i < keyed.length; i++) for (let j = i + 1; j < keyed.length; j++) { const a = keyed[i]; const b = keyed[j]; if (a.k !== b.k && a.k.length >= 5 && b.k.length >= 5 && (editDist(a.k, b.k) <= 2 || a.k.includes(b.k) || b.k.includes(a.k) || a.runs.some((x) => b.runs.includes(x)))) { out.add(a.d); out.add(b.d); } }
  return out;
}
const ampText = (v) => (/^\d{2,4}$/.test(String(v ?? '')) ? `${v} A` : String(v ?? ''));
const distinctVals = (d, k) => new Set((d.all[k] ?? []).map((x) => norm(x.value))).size;
const f = (d, k) => d.fields[k]?.value ?? null;
const src = (d, k) => ({ documentId: d.id, location: { field: k, page: d.fields[k]?.page ?? 1 } });
const UNIT_WORD = /^(?:suite|ste|unit|apt|apartment|bldg|building|floor|fl|room|rm|space|spc)\b|^#/i;
const STATE_NAMES = ['alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey', 'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'rhode island', 'south carolina', 'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington', 'west virginia', 'wisconsin', 'wyoming'];
const STATE_RE = new RegExp(`\\s+(?:${STATE_NAMES.join('|')})(?:\\s+\\d{5}(?:\\s*-?\\s*\\d{4})?)?$`);
/** The street part, the unit parts (Suite 4 / Ste 4 / #4 / Unit B, wherever they sit), and the city part of a "street, [unit,] City ST zip" address. */
function addrParts(raw) {
  const parts = String(raw ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const units = []; const rest = [];
  for (const p of parts.slice(1)) (UNIT_WORD.test(p) ? units : rest).push(p);
  return { street: parts[0] ?? '', units, rest };
}
const cityFromAddress = (raw) => { const { rest } = addrParts(raw); if (!rest.length) return null; const c = norm(rest[0]).replace(STATE_RE, '').replace(/\s+[a-z]{2}(?:\s+\d{5}(?:\s*-?\s*\d{4})?)?$/, '').replace(/\s+\d{5}(?:\s*-?\s*\d{4})?$/, '').trim(); return c && !/\d/.test(c) ? c : null; };
const placeText = (d) => { const { street, units } = addrParts(f(d, 'service_address')); return `${street} ${units.join(' ')} ${f(d, 'customer_name') ?? ''} ${String(d.filename ?? '').replace(/\d+/g, ' ')}`; }; // street + unit only: a city or zip is never a "job"
const canonTok = (t) => (UNIT_WORD.test(t) ? '' : DIR_CANON[t] ?? SUF_CANON[t] ?? t);
function matchPlace(docs, tokens) {
  if (!tokens.length) return [];
  const words0 = tokens.filter((t) => !t.startsWith('~')); const words = words0.map(canonTok).filter(Boolean); const sufs = tokens.filter((t) => t.startsWith('~')).map((t) => t.slice(1));
  if (!words.length) return [];
  const hit = docs.filter((d) => { const have = new Set(toks(sufs.length && f(d, 'service_address') ? String(f(d, 'service_address')) : placeText(d)).map(canonTok)); if (!words.every((t) => have.has(t))) return false; if (!sufs.length || !f(d, 'service_address')) return true; const st = canonAddr(f(d, 'service_address')).split(' u')[0].split(' '); const ds = SUF_SET.has(st[st.length - 1]) ? st[st.length - 1] : null; return !ds || sufs.includes(ds); });
  // a name that is a word-prefix of a longer customer name ("Ace Dental" inside "Ace Dental Group"): documents of the exact name only
  const custSet = (d) => new Set(toks(f(d, 'customer_name') ?? ''));
  const wset = new Set(words);
  const exact = hit.filter((d) => { const c = custSet(d); return c.size === wset.size && [...c].every((t) => wset.has(t)); });
  if (exact.length && exact.length < hit.length && hit.filter((d) => !exact.includes(d)).every((d) => { const c = custSet(d); return c.size > wset.size && words.every((t) => c.has(t)); })) return exact;
  // the name asked is only the start of a longer, different customer name ("Gamma Inc" vs "Gamma Inc West"): never answered from the longer name's records
  if (!exact.length && hit.length && hit.every((d) => { const c = custSet(d); return c.size > wset.size && words.every((t) => c.has(t)) && [...c].some((t) => !wset.has(t) && !/^(?:inc|llc|co|corp|company|group|ltd|the|and|of)$/.test(t)); })) return [];
  return hit;
}
const SUF_CANON = { street: 'st', avenue: 'ave', road: 'rd', drive: 'dr', lane: 'ln', court: 'ct', boulevard: 'blvd', circle: 'cir', place: 'pl', parkway: 'pkwy', terrace: 'ter', trail: 'trl', highway: 'hwy' };
const DIR_CANON = { north: 'n', south: 's', east: 'e', west: 'w' };
const SUF_SET = new Set([...Object.keys(SUF_CANON), ...Object.values(SUF_CANON), 'way']);
/** One job, however the street is spelled: street part only, suffix and directions canonical, nothing after the suffix (unit, city, zip). */
function canonAddr(raw) {
  const t = norm(String(raw ?? '').split(',')[0]).split(' ').filter(Boolean).map((w) => DIR_CANON[w] ?? SUF_CANON[w] ?? w);
  const i = t.findIndex((w, k) => k > 0 && SUF_SET.has(w));
  const unit = String(raw ?? '').toLowerCase().match(/(?:\b(?:suite|ste|unit|apt|apartment|bldg|building)\b\.?\s*#?\s*|#\s*)([a-z0-9-]+)/);
  return `${(i >= 0 ? t.slice(0, i + 1) : t).join(' ')}${unit ? ` u${unit[1]}` : ''}`;
}
const addrKey = (d) => canonAddr(f(d, 'service_address'));
/** The city a document names: the second part of a "street, City ST zip" address, else "City of X" in the issuing office. */
function cityOf(d) {
  const c = cityFromAddress(f(d, 'service_address')); if (c) return c;
  const j = /\bcity of ([a-z]+(?: [a-z]+)?)/i.exec(String(f(d, 'jurisdiction') ?? '').replace(/\b(?:building|development|permit|planning|safety|services?|department|dept|division|office)\b.*$/i, ''));
  return j ? norm(j[1]) : null;
}
const CITY_GENERIC = new Set(['permit', 'permits', 'open', 'closed', 'final', 'finaled', 'issued', 'city', 'number', 'numbers', 'many', 'issue', 'job', 'jobs', 'site', 'sites']);
/** The city (known from the documents) a question names, with the question's other place words; null when no known city is named or a street/customer is named too. */
function cityScope(docs, intent) {
  const q = ` ${norm(intent.q ?? '')} `;
  const cities = [...new Set(docs.map(cityOf).filter(Boolean))].filter((c) => q.includes(` ${c} `)).sort((a, b) => b.length - a.length);
  if (!cities.length) return null;
  if (cities.some((c) => !cities[0].split(' ').join(' ').includes(c))) return null; // two different cities in one question: no single-city answer
  const ct = new Set(cities.flatMap((c) => c.split(' ')));
  const rest = (intent.place ?? []).filter((t) => !ct.has(t) && !CITY_GENERIC.has(t));
  return rest.length ? null : cities[0];
}
function distinctPlaces(ds) { return [...new Set(ds.map(addrKey).filter(Boolean))]; }
const fact = (label, value, d, k) => ({ label, value, sources: [src(d, k)] });

function clarify(ds) {
  const places = [...new Map(ds.filter((d) => f(d, 'service_address')).map((d) => [addrKey(d), f(d, 'service_address')])).values()].slice(0, 6);
  return answerEnvelope({ text: `More than one job matches that. Which one do you mean: ${places.join('; ')}?`, facts: [], extra: { clarify: true, clarifyOptions: places } });
}

/* ------------------------------------------------------------------ run */
export async function runElectrical(db, intent, { today } = {}) {
  if (!intent) return null;
  if (intent.kind === 'decline') return answerEnvelope({ text: DECLINE[intent.which], facts: [], extra: { decline: true, declineKind: intent.which } });
  const docs = await loadDocs(db);
  // a customer whose own name holds a word the question reader treats as a filler or a qualifier ("First Choice Dental", "Final Touch Painting", "Open Door Realty"):
  // read the question again with that name set aside, then use the whole name as the place
  if (intent.raw && intent.place?.length && intent.kind !== 'permit_party') {
    const names = [...new Set(docs.map((d) => norm(f(d, 'customer_name') ?? '')).filter(Boolean))].sort((a, b) => b.length - a.length);
    const qn = ` ${norm(intent.raw)} `; const hit = names.find((n) => qn.includes(` ${n} `));
    if (hit && toks(hit).some((t) => STOP.has(t))) {
      const re = new RegExp(toks(hit).join('[^A-Za-z0-9]+'), 'i');
      const ni = classify0(String(intent.raw).replace(re, 'Zzcustx'), { today });
      if (!ni || ni.kind === 'decline') return null;
      ni.place = (ni.place ?? []).flatMap((t) => (t === 'zzcustx' ? toks(hit) : [t])); ni.raw = intent.raw; intent = ni;
    }
  }
  if (['permit_lookup', 'permit_party', 'open_permits'].includes(intent.kind)) {
    const g = new Map(); for (const d of docs.filter((x) => x.type === 'permit' && f(x, 'permit_number'))) (g.get(alnum(f(d, 'permit_number'))) ?? g.set(alnum(f(d, 'permit_number')), []).get(alnum(f(d, 'permit_number')))).push(d);
    for (const ds of g.values()) if (ds.length > 1) for (const k of ['permit_issue_date', 'jurisdiction', 'customer_name', 'service_address', 'code_edition', 'permit_expiry']) if (new Set(ds.map((d) => (k === 'service_address' ? addrKey(d) : norm(f(d, k) ?? ''))).filter(Boolean)).size > 1) return null; // a reissued permit paper: which one is current is not settled
  }
  // an inspection card with no readable stage or result (e.g. a multi-inspection card the reader could not pair) makes these answers unsafe: the normal path reads it
  if (['open_permits', 'inspection_result', 'failed_inspections'].includes(intent.kind)) {
    const unk = docs.filter((d) => (d.type === 'inspection-report' || d.type === 'correction-notice') && (d.type === 'inspection-report' ? !f(d, 'inspection_result') || !f(d, 'inspection_type') || !/\b(?:rough|final|underground|service|temporary|cover|meter)/i.test(f(d, 'inspection_type')) : false)); // no readable result, or a stage-less card such as a re-inspection
    const scope = intent.place?.length ? new Set(matchPlace(docs, intent.place).map((d) => d.id)) : null;
    if (unk.some((d) => !scope || scope.has(d.id))) return null;
    if (intent.kind === 'open_permits' && docs.some((d) => certState(d) === 'unknown')) return null; // a certificate whose status is not plainly complete (pending, on hold, draft...) cannot close or leave a permit open
    // a correction notice whose own result is not a plain failure ("Corrected - Approved", "Corrections verified complete") is not counted as a failure and not ignored
    if (intent.kind === 'failed_inspections' && docs.some((d) => d.type === 'correction-notice' && f(d, 'inspection_result') && resultClass(f(d, 'inspection_result')) !== 'failed' && (!scope || scope.has(d.id)))) return null;
    // a result that says both failed and passed ("Failed - re-inspection passed") cannot be counted either way
    if (docs.some((d) => CARD_TYPES.includes(d.type) && resultClass(f(d, 'inspection_result')) === 'mixed' && (!scope || scope.has(d.id)))) return null;
    // a result word the lane does not know (a typo, "UNSAT", "Complete") is neither failed nor passed: counts and open-permit answers decline rather than skip it
    if (intent.kind !== 'inspection_result' && docs.some((d) => d.type === 'inspection-report' && f(d, 'inspection_result') && resultClass(f(d, 'inspection_result')) === 'other' && (!scope || scope.has(d.id)))) return null;
    if (intent.kind === 'open_permits') {
      const fin = (cls) => { const m = new Map(); for (const d of docs.filter((x) => x.type === 'inspection-report' && isFinal(f(x, 'inspection_type')) && resultClass(f(x, 'inspection_result')) === cls)) { const n = alnum(f(d, 'permit_number') ?? ''); if (n) m.set(n, [...(m.get(n) ?? []), f(d, 'service_date')]); } return m; };
      const pf = fin('passed'); const ff = fin('failed');
      for (const [n, fd] of ff) if (pf.has(n)) { const pd = pf.get(n); if ([...fd, ...pd].some((x) => !okIso(x)) || fd.some((x) => pd.every((y) => x >= y))) return null; } // a failed final not older than every passed one: which is current is not settled here
      { const pn = new Set(docs.filter((d) => d.type === 'permit').map((d) => alnum(f(d, 'permit_number') ?? '')).filter(Boolean)); const pa = new Map(); for (const d of docs.filter((x) => x.type === 'permit')) { const k = addrKey(d); if (k) pa.set(k, new Set([...(pa.get(k) ?? []), alnum(f(d, 'permit_number') ?? d.id)])); }
        const orphan = docs.some((d) => (certClosed(d) || (d.type === 'inspection-report' && isFinal(f(d, 'inspection_type')) && resultClass(f(d, 'inspection_result')) === 'passed')) && !(pn.has(alnum(f(d, 'permit_number') ?? '')) || (!f(d, 'permit_number') && addrKey(d) && pa.get(addrKey(d))?.size === 1) || (addrKey(d) && !pa.has(addrKey(d)))));
        if (orphan) return null; } // a passed final / certificate tied to no permit on file might close one of them
      if (docs.some((d) => d.type === 'permit' && (d.all?.status?.length || d.all?.permit_status?.length))) return null; // a permit with a written status (closed, cancelled...) is not judged by its cards
    }
    // an unlinked card whose customer name shares words with the one asked about but is not the same name: could be the same customer
    if (intent.place?.length && ['failed_inspections', 'inspection_result'].includes(intent.kind)) {
      const asked = new Set(intent.place.filter((t) => !t.startsWith('~')).map(canonTok).filter(Boolean));
      if (docs.some((d) => CARD_TYPES.includes(d.type) && !f(d, 'permit_number') && !f(d, 'service_address') && f(d, 'customer_name') && !(scope && scope.has(d.id)) && toks(f(d, 'customer_name')).some((t) => asked.has(canonTok(t)) && t.length > 2))) return null;
    }
    // a card tied to no customer, address or permit on file could belong to the one asked about: a place-named answer would miss it
    if (intent.place?.length && docs.some((d) => CARD_TYPES.includes(d.type) && d.unplaced)) return null;
    // a card with only an address, or only a customer, cannot be told apart from the other's when the question names the missing kind of thing (a customer-named question and an address-only card, or the reverse)
    if (intent.place?.length) { const words = intent.place.filter((t) => !t.startsWith('~')); const named = (get) => docs.some((d) => { const have = new Set(toks(get(d))); return have.size && words.length && words.every((t) => have.has(t)); });
      const custNamed = named((d) => f(d, 'customer_name') ?? ''); const addrNamed = named((d) => String(f(d, 'service_address') ?? '').split(',')[0]);
      if (custNamed && docs.some((d) => CARD_TYPES.includes(d.type) && d.noCust)) return null;
      if ((addrNamed || !custNamed) && docs.some((d) => CARD_TYPES.includes(d.type) && d.noAddr)) return null; }
  }
  // the same street address in two different cities (12 Alder Street, Mesa / Gilbert) is two jobs, but papers are joined by street: such answers decline
  if (['open_permits', 'inspection_result', 'failed_inspections', 'permit_lookup', 'code_edition', 'panel_facts', 'load_calc'].includes(intent.kind)) {
    const cit = new Map(); for (const d of docs) { const a = addrKey(d); const c = cityFromAddress(f(d, 'service_address')); if (a && c) (cit.get(a) ?? cit.set(a, new Set()).get(a)).add(c); }
    const dup = new Set([...cit].filter(([, v]) => v.size > 1).map(([k]) => k));
    if (dup.size) { const sc = intent.place?.length && !cityScope(docs, intent) ? matchPlace(docs, intent.place) : docs; if (sc.some((d) => dup.has(addrKey(d)))) return null; }
  }
  const t0 = today && /^\d{4}-\d{2}-\d{2}$/.test(today) ? today : null;
  // Class guards (records.js): two readings of one single-valued field, or a credential with no readable date, on the records this answer rests on -> the normal path reads them.
  {
    const GUARD = {
      open_permits: [['permit', 'inspection-report', 'certificate-of-completion', 'correction-notice'], ['permit_number', 'inspection_type', 'inspection_result', 'service_address', 'permit_link']],
      inspection_result: [['inspection-report', 'certificate-of-completion', 'correction-notice'], ['permit_number', 'inspection_type', 'inspection_result', 'service_date', 'permit_link']],
      failed_inspections: [['inspection-report', 'correction-notice', 'permit'], ['permit_number', 'inspection_type', 'inspection_result', 'service_date', 'service_address', 'permit_link']],
      permit_lookup: [['permit', 'inspection-report', 'correction-notice'], ['permit_number', 'permit_issue_date']],
      permit_city: [['permit'], ['permit_number', 'service_address']],
      tests_due: [['test-report'], ['next_test_due', 'service_date', 'service_address']],
    };
    const g = GUARD[intent.kind];
    if (g) {
      const mp = intent.place?.length && intent.kind !== 'tests_due' ? matchPlace(docs, intent.place) : [];
      const scope = mp.length ? new Set(mp.map((d) => d.id)) : null;
      if (docs.some((d) => g[0].includes(d.type) && (!scope || scope.has(d.id)) && g[1].some((k) => d.conflict?.has(k)))) return null;
    }
    if (['open_permits', 'permit_city'].includes(intent.kind) && docs.some((d) => d.type === 'permit' && !f(d, 'permit_number'))) return null; // a permit paper with no readable number cannot be counted as open or closed
    if (intent.kind === 'tests_due' && ambiguousTests(docs).size) return null; // a retest or another unit? cannot be told
    if (intent.kind === 'tests_due' && intent.eq?.length && docs.some((d) => d.type === 'test-report' && !familyOf(d))) return null; // a report whose kind of equipment is not recognisable could be the one asked about
    if (intent.kind === 'tests_due' && latestTests(docs).some((d) => f(d, 'next_test_due') && !okIso(f(d, 'next_test_due')))) return null;
    if (intent.kind === 'credentials') {
      const dk = { 'contractor-license': ['license_expiry', 'license_number'], 'certificate-of-insurance': ['policy_expiry', 'policy_number'], 'surety-bond': ['bond_expiry', 'bond_number'] };
      for (const type of intent.types) {
        const [dateK, numK] = dk[type]; const ofType = docs.filter((x) => x.type === type);
        if (ofType.some((d) => d.conflict?.has(dateK) || d.conflict?.has(numK))) return null;
        if (ambiguousCreds(docs, type).size) return null; // may be the same credential twice (renewal / typo): never "expired" beside a current paper
        // a credential whose date cannot be read is never left out of the list (it may be the newest paper for its number): the normal path reads it
        if (ofType.some((d) => !okIso(f(d, dateK)))) return null; // (a date printed as a year, 2-digit year or words is not guessed either)
      }
    }
  }

  if (intent.kind === 'count_type') {
    let ds = docs.filter((d) => d.type === intent.type);
    if (intent.failed) { if (docs.some((d) => CARD_TYPES.includes(d.type) && resultClass(f(d, 'inspection_result')) === 'mixed')) return null; ds = failedDocs(docs); }
    return answerEnvelope({ text: `${ds.length} ${intent.failed ? 'failed ' : ''}${intent.type.replace(/-/g, ' ')} document${ds.length === 1 ? '' : 's'} on file.${ds.length === 0 && !intent.failed ? ` Upload ${/^[aeiou]/i.test(intent.type) ? 'an' : 'a'} ${intent.type.replace(/-/g, ' ')} to see it here.` : ''}`, facts: ds.slice(0, 40).map((d) => ({ label: d.filename, value: intent.type.replace(/-/g, ' '), sources: [{ documentId: d.id, location: { field: 'document_type', page: 1 } }] })) });
  }

  if (intent.kind === 'permit_city') {
    const cityName = cityScope(docs, intent);
    if (!cityName) return null;
    const byNum = new Map(); for (const d of docs.filter((x) => x.type === 'permit' && f(x, 'permit_number') && cityOf(x) === cityName)) byNum.set(alnum(f(d, 'permit_number')), d);
    const ps = [...byNum.values()]; const CN = cityName.replace(/\b[a-z]/g, (c) => c.toUpperCase());
    if (!ps.length) return null;
    return answerEnvelope({ text: `${ps.length} permit${ps.length === 1 ? '' : 's'} on file in ${CN}.`, facts: ps.slice(0, 40).map((d) => fact(`${f(d, 'permit_number')}${f(d, 'service_address') ? ` · ${f(d, 'service_address')}` : ''}`, f(d, 'jurisdiction') ?? 'permit', d, 'permit_number')) });
  }

  if (intent.kind === 'open_permits') {
    const finals = new Set(docs.filter((d) => certClosed(d) || (d.type === 'inspection-report' && isFinal(f(d, 'inspection_type')) && resultClass(f(d, 'inspection_result')) === 'passed')).map((d) => alnum(f(d, 'permit_number') ?? '')).filter(Boolean));
    // address-keyed finals too (a final card that names the site but no permit number)
    const permitCount = new Map(); for (const d of docs.filter((x) => x.type === 'permit')) { const k = addrKey(d); if (k) permitCount.set(k, new Set([...(permitCount.get(k) ?? []), alnum(f(d, 'permit_number') ?? d.id)])); }
    const finalAddrs = new Set(docs.filter((d) => certClosed(d) || (d.type === 'inspection-report' && isFinal(f(d, 'inspection_type')) && resultClass(f(d, 'inspection_result')) === 'passed')).filter((d) => !f(d, 'permit_number')).map(addrKey).filter((k) => k && permitCount.get(k)?.size === 1));
    let permits = docs.filter((d) => d.type === 'permit' && f(d, 'permit_number'));
    // one row per permit number: the newest-listed document wins; near-duplicates collapse
    const byNum = new Map(); for (const d of permits) byNum.set(alnum(f(d, 'permit_number')), d);
    permits = [...byNum.values()];
    const cityName = intent.place?.length ? cityScope(docs, intent) : null;
    if (cityName) permits = permits.filter((d) => cityOf(d) === cityName);
    else if (intent.place?.length) { const mp = matchPlace(docs, intent.place); if (distinctPlaces(mp).length > 1) return clarify(mp); const m = new Set(mp.map((d) => d.id)); permits = permits.filter((d) => m.has(d.id)); }
    const open = permits.filter((d) => !finals.has(alnum(f(d, 'permit_number'))) && !finalAddrs.has(addrKey(d)));
    if (!permits.length && intent.place?.length) return null;
    // a permit paper whose own status is anything but plainly active (cancelled, suspended, expired, closed, renewed...) is not "open" or "closed" by the cards alone
    if (permits.some((d) => f(d, 'permit_status') && !/^(?:active|issued|open|approved|in progress|pending|valid|current|issued active)$/.test(norm(f(d, 'permit_status'))))) return null;
    // a passed final / certificate with no permit number at an address holding two or more permits: which one it closes is unknown
    { const noNo = docs.filter((d) => (certClosed(d) || (d.type === 'inspection-report' && isFinal(f(d, 'inspection_type')) && resultClass(f(d, 'inspection_result')) === 'passed')) && !f(d, 'permit_number')).map(addrKey).filter(Boolean);
      if (open.some((d) => noNo.includes(addrKey(d)) && (permitCount.get(addrKey(d))?.size ?? 0) > 1)) return null; }
    const facts = open.slice(0, 40).map((d) => fact(`${f(d, 'permit_number')}${f(d, 'service_address') ? ` · ${f(d, 'service_address')}` : ''}`, f(d, 'permit_expiry') ? `no passed final on file; permit ${t0 && f(d, 'permit_expiry') < t0 ? 'expired' : 'expires'} ${humanDate(f(d, 'permit_expiry'))}` : 'no passed final on file', d, 'permit_number'));
    if (cityName) { const CN = cityName.replace(/\b[a-z]/g, (c) => c.toUpperCase()); return answerEnvelope({ text: open.length ? `${open.length} of the ${permits.length} permit${permits.length === 1 ? '' : 's'} in ${CN} ${open.length === 1 ? 'has' : 'have'} no passed final inspection or certificate of completion on file. This reflects your documents, not the city's records.` : `None of the ${permits.length} permit${permits.length === 1 ? '' : 's'} in ${CN} ${permits.length === 1 ? 'is' : 'are'} open: each has a passed final inspection or certificate of completion on file.`, facts }); }
    return answerEnvelope({ text: open.length ? `${open.length} permit${open.length === 1 ? ' has' : 's have'} no passed final inspection or certificate of completion on file. This reflects your documents, not the city's records.` : (intent.place?.length ? 'That permit has a passed final inspection or certificate of completion on file.' : permits.length || docs.some((d) => d.type === 'permit') ? 'Every permit on file has a passed final inspection or certificate of completion.' : 'No permits are on file yet, so there is nothing to list from your records.'), facts });
  }

  if (intent.kind === 'inspection_result') {
    const m = matchPlace(docs, intent.place).filter((d) => ['inspection-report', 'certificate-of-completion', 'correction-notice'].includes(d.type));
    if (!m.length) return null;
    if (distinctPlaces(m).length > 1) return clarify(m);
    let ds = m;
    if (intent.stage) ds = ds.filter((d) => (intent.stage === 'final' ? isFinal(f(d, 'inspection_type')) || d.type === 'certificate-of-completion' : intent.stage === 'rough' ? isRough(f(d, 'inspection_type')) : new RegExp(intent.stage, 'i').test(f(d, 'inspection_type') ?? '')));
    if (!ds.length) return answerEnvelope({ text: `I don't see a ${intent.stage} inspection for that job in your documents.`, facts: m.slice(0, 5).map((d) => fact(`${f(d, 'inspection_type') ?? d.type} (${humanDate(f(d, 'service_date'))})`, f(d, 'inspection_result') ?? 'no result written', d, f(d, 'inspection_result') ? 'inspection_result' : 'service_date')) });
    if (new Set(ds.map((d) => alnum(f(d, 'permit_number') ?? '')).filter(Boolean)).size > 1) return null; // several permits at one address: never one headline over another permit's history
    if (ds.some((d) => f(d, 'inspection_result'))) ds = ds.filter((d) => d.type !== 'correction-notice' || f(d, 'inspection_result')); // a notice with no printed result never headlines over a recorded result
    if (ds.length > 1 && ds.some((d) => !okIso(f(d, 'service_date')))) return null; // an undated or unreadably dated card beside others: which is newest cannot be told
    ds = [...ds].sort((a, b) => String(f(b, 'service_date') ?? '').localeCompare(String(f(a, 'service_date') ?? '')));
    const dates = ds.map((d) => f(d, 'service_date'));
    const facts = ds.slice(0, 6).map((d) => { const items = (d.all.correction_items ?? []).map((x) => x.value); return fact(`${f(d, 'inspection_type') ?? 'Inspection'} · ${humanDate(f(d, 'service_date'))}`, `${f(d, 'inspection_result') ?? (d.type === 'certificate-of-completion' ? 'certificate of completion' : 'no result written')}${resultClass(f(d, 'inspection_result')) === 'failed' && items.length ? ` — ${items.join('; ')}` : ''}`, d, f(d, 'inspection_result') ? 'inspection_result' : 'service_date'); });
    const top = ds[0];
    const conflict = ds.length > 1 && dates[0] === dates[1] && f(ds[0], 'inspection_result') !== f(ds[1], 'inspection_result');
    return answerEnvelope({ text: conflict ? `Your documents show different results for the same date; both are listed with their pages.` : `${f(top, 'inspection_type') ?? 'The inspection'} on ${humanDate(f(top, 'service_date'))}: ${f(top, 'inspection_result') ?? (top.type === 'certificate-of-completion' ? 'certificate of completion on file' : 'no result written')}${ds.length > 1 ? ' (newest first)' : ''}.`, facts });
  }

  if (intent.kind === 'failed_inspections') {
    const SUP = (d, strict) => { const keyP = alnum(f(d, 'permit_number') ?? ''); const keyA = addrKey(d); const dt = String(f(d, 'service_date') ?? ''); const same = (o) => { const kp = alnum(f(o, 'permit_number') ?? ''); return keyP && kp ? keyP === kp : (keyA && addrKey(o) === keyA); }; return docs.some((o) => o.id !== d.id && same(o) && (certClosed(o) || (o.type === 'inspection-report' && resultClass(f(o, 'inspection_result')) === 'passed' && (strict ? String(f(o, 'service_date') ?? '') > dt : String(f(o, 'service_date') ?? '') >= dt) && (isFinal(f(o, 'inspection_type')) || (d.type === 'correction-notice' && stageOf(f(d, 'inspection_type')) === 'other') || (stageOf(f(o, 'inspection_type')) === stageOf(f(d, 'inspection_type')) && stageOf(f(d, 'inspection_type')) !== 'other'))))); };
    if (!intent.place?.length && !docs.some((d) => d.type === 'inspection-report' || d.type === 'correction-notice')) return answerEnvelope({ text: 'No inspection reports are on file yet, so there is nothing to list from your records.', facts: [] }); // an empty library is not an all-clear
    if (intent.unresolved && failedDocs(docs).some((d) => !f(d, 'permit_number') && !addrKey(d))) return null; // a failure tied to no permit or address cannot be matched with a later pass
    if (intent.unresolved && failedDocs(docs).some((d) => (!okIso(f(d, 'service_date')) && SUP(d)) || (SUP(d) && !SUP(d, true)))) return null; // an undated failure, or one "resolved" only by a pass on the same day: the order is unknown
    if (intent.stage && failedDocs(docs).some((d) => d.type === 'correction-notice' && !f(d, 'inspection_type'))) return null; // a failure whose stage is unknown cannot be left out of a stage count
    let ds = failedDocs(docs).filter((d) => !intent.unresolved || !SUP(d)).filter((d) => (!intent.stage || (intent.stage === 'final' ? isFinal(f(d, 'inspection_type')) : isRough(f(d, 'inspection_type')))));
    if (intent.place?.length) { const mp = matchPlace(docs, intent.place); if (distinctPlaces(mp).length > 1) return clarify(mp); const m = new Set(mp.map((d) => d.id)); ds = ds.filter((d) => m.has(d.id)); if (!m.size) return null; }
    const withItems = ds.slice(0, 40).map((d) => {
      const items = (d.all.correction_items ?? []).map((x) => x.value);
      return { label: `${f(d, 'service_address') ?? d.filename} · ${f(d, 'inspection_type') ?? 'inspection'} · ${humanDate(f(d, 'service_date'))}`, value: `${f(d, 'inspection_result') ?? 'Correction notice'}${items.length ? ` — ${items.join('; ')}` : ''}`, sources: [src(d, f(d, 'inspection_result') ? 'inspection_result' : (f(d, 'correction_items') ? 'correction_items' : 'service_date'))] };
    });
    return answerEnvelope({ text: ds.length ? `${ds.length} ${intent.unresolved ? 'unresolved ' : ''}failed inspection${ds.length === 1 ? '' : 's'} on file${intent.unresolved ? ' with no later passed inspection' : ''}.` : (intent.unresolved ? 'No unresolved failed inspections on file.' : 'No failed inspections on file.'), facts: withItems });
  }

  if (intent.kind === 'permit_party') {
    const m = docs.filter((d) => alnum(f(d, 'permit_number') ?? '') === intent.permit && (f(d, 'customer_name') || f(d, 'owner_name')));
    const names = [...new Set(m.map((d) => String(f(d, 'customer_name') ?? f(d, 'owner_name')).trim()).filter(Boolean))];
    if (names.length !== 1) return null;
    const d0 = m.find((d) => f(d, 'customer_name')) ?? m[0]; const k = f(d0, 'customer_name') ? 'customer_name' : 'owner_name';
    return answerEnvelope({ text: `${names[0]} (as written on the permit paperwork for ${m.length === 1 ? 'that permit' : `that permit, ${m.length} documents agree`}).`, facts: [fact(`Customer · ${f(d0, 'permit_number')}`, names[0], d0, k)] });
  }

  if (intent.kind === 'permit_lookup') {
    const m = matchPlace(docs, intent.place).filter((d) => ['permit', 'inspection-report', 'correction-notice'].includes(d.type) && f(d, 'permit_number'));
    if (!m.length) return null;
    if (distinctPlaces(m).length > 1) return clarify(m);
    if (intent.attr === 'issued') {
      const dated = m.filter((d) => d.type === 'permit' && okIso(f(d, 'permit_issue_date')));
      if (!dated.length) return null;
      const byNo = [...new Map(dated.map((d) => [alnum(f(d, 'permit_number')), d])).values()];
      return answerEnvelope({ text: byNo.length === 1 ? `Permit ${f(byNo[0], 'permit_number')} was issued ${humanDate(f(byNo[0], 'permit_issue_date'))}.` : `${byNo.length} permits on file for that job, with their issue dates.`, facts: byNo.map((d) => fact(`Issued · ${f(d, 'permit_number')}`, humanDate(f(d, 'permit_issue_date')), d, 'permit_issue_date')) });
    }
    const nums = [...m.reduce((mp, d) => { const k = alnum(f(d, 'permit_number')); const cur = mp.get(k); if (!cur || (d.type === 'permit' && cur.type !== 'permit') || (!f(cur, 'jurisdiction') && f(d, 'jurisdiction'))) mp.set(k, d); return mp; }, new Map()).values()];
    const facts = nums.flatMap((d) => [fact(`Permit number · ${f(d, 'service_address') ?? ''}`.trim(), f(d, 'permit_number'), d, 'permit_number'), ...(f(d, 'jurisdiction') ? [fact('Issuing office', f(d, 'jurisdiction'), d, 'jurisdiction')] : [])]);
    return answerEnvelope({ text: nums.length === 1 ? `Permit ${f(nums[0], 'permit_number')}${f(nums[0], 'jurisdiction') ? `, issued by ${f(nums[0], 'jurisdiction')}` : ' (no issuing office is printed on the document)'}.` : `${nums.length} permit numbers on file for that job.`, facts });
  }

  if (intent.kind === 'code_edition') {
    const m = matchPlace(docs, intent.place).filter((d) => f(d, 'code_edition'));
    if (!m.length) return null;
    if (distinctPlaces(m).length > 1) return clarify(m);
    const eds = [...new Map(m.map((d) => [f(d, 'code_edition'), d])).values()];
    return answerEnvelope({ text: `${eds.map((d) => f(d, 'code_edition')).join(' and ')} (the edition label printed on the document; I can't say which edition applies).`, facts: eds.map((d) => fact(`${d.type.replace(/-/g, ' ')}`, f(d, 'code_edition'), d, 'code_edition')) });
  }

  if (intent.kind === 'panel_facts') {
    let m = matchPlace(docs, intent.place).filter((d) => (d.type === 'panel-schedule' || ((d.type === 'equipment-record' || d.type === 'nameplate-photo') && /\b(?:panel|panelboard|switchboard|load center|main|service|meter)\b/i.test(f(d, 'equipment_type') ?? '')) || d.type === 'load-calculation') && (f(d, 'amperage') || f(d, 'voltage') || f(d, 'phase')));
    if (!m.length) return null;
    if (m.some((d) => d.type === 'panel-schedule')) m = m.filter((d) => d.type === 'panel-schedule');
    if (m.some((d) => ['amperage', 'voltage', 'phase'].some((k) => distinctVals(d, k) > 1))) return null; // several panels in one document: the normal path reads each
    if (!intent.list && distinctPlaces(m).length > 1) return clarify(m);
    if ((intent.want ?? []).some((k) => !m.some((d) => f(d, k)))) return null; // the rating asked for is not written on any matching paper
    const facts = m.slice(0, 40).flatMap((d) => ['amperage', 'voltage', 'phase'].filter((k) => f(d, k)).map((k) => fact(`${f(d, 'equipment_type') ?? 'Panel'} · ${f(d, 'service_address') ?? d.filename} · ${k}`, k === 'amperage' ? ampText(f(d, k)) : f(d, k), d, k)));
    const first = m[0];
    return answerEnvelope({ text: m.length === 1 ? `${[f(first, 'amperage') && ampText(f(first, 'amperage')), f(first, 'voltage'), f(first, 'phase')].filter(Boolean).join(', ')} (as written on the document).` : `${m.length} panel documents match; each is listed with its rating.`, facts });
  }

  if (intent.kind === 'load_calc') {
    const m = matchPlace(docs, intent.place).filter((d) => d.type === 'load-calculation');
    if (!m.length) return null;
    if (distinctPlaces(m).length > 1) return clarify(m);
    let d = m[m.length - 1];
    if (m.length > 1) { // several revisions: the newest dated one, never an arbitrary one
      const val = (x) => `${f(x, 'connected_load') ?? ''}|${f(x, 'demand_load') ?? ''}|${f(x, 'service_size') ?? ''}`;
      if (new Set(m.map(val)).size > 1) { const dated = m.filter((x) => okIso(f(x, 'service_date'))).sort((a, b) => f(b, 'service_date').localeCompare(f(a, 'service_date'))); if (dated.length !== m.length || f(dated[0], 'service_date') === f(dated[1], 'service_date')) return null; d = dated[0]; }
    }
    const facts = ['connected_load', 'demand_load', 'service_size'].filter((k) => f(d, k)).map((k) => fact(k.replace(/_/g, ' '), f(d, k), d, k));
    if (!facts.length) return null;
    if (intent.field === 'both') return answerEnvelope({ text: `Connected load ${f(d, 'connected_load') ?? 'not printed'}; demand load ${f(d, 'demand_load') ?? 'not printed'}.`, facts });
    const fk = intent.field ?? 'demand_load'; const nm = fk === 'connected_load' ? 'connected load' : 'demand load';
    return answerEnvelope({ text: f(d, fk) ? `The load calculation shows a ${nm} of ${f(d, fk)}.` : `The load calculation does not print a ${nm}.`, facts: facts.filter((x) => x.label === nm) });
  }

  if (intent.kind === 'credentials' || intent.kind === 'tests_due') {
    if (!t0) return null;
    const isTest = intent.kind === 'tests_due';
    const dateKey = { 'contractor-license': 'license_expiry', 'certificate-of-insurance': 'policy_expiry', 'surety-bond': 'bond_expiry' };
    const numKey = { 'contractor-license': 'license_number', 'certificate-of-insurance': 'policy_number', 'surety-bond': 'bond_number' };
    let rows = [];
    if (isTest) {
      const latest = new Map();
      for (const d of latestTests(docs)) if (f(d, 'next_test_due')) latest.set(testKey(d), d);
      for (const d of latest.values()) rows.push({ d, key: 'next_test_due', label: `${f(d, 'equipment_type') ?? 'Test'} · ${f(d, 'service_address') ?? d.filename}`, date: f(d, 'next_test_due') });
    } else {
      for (const type of intent.types) {
        const newest = new Map();
        for (const d of docs.filter((x) => x.type === type && f(x, dateKey[type]))) { const k = alnum(f(d, numKey[type])) || norm(d.filename); const prev = newest.get(k); if (!prev || String(f(d, dateKey[type])) >= String(f(prev, dateKey[type]))) newest.set(k, d); }
        for (const d of newest.values()) rows.push({ d, key: dateKey[type], label: `${type.replace(/-/g, ' ')} ${f(d, numKey[type]) ?? ''}${f(d, 'license_holder') || f(d, 'insurer') ? ` · ${f(d, 'license_holder') ?? f(d, 'insurer')}` : ''}${d.multi ? ' (several coverages, earliest expiry shown)' : ''}`.trim(), date: f(d, dateKey[type]) });
      }
    }
    if (!rows.length) return null;
    let inScope = () => true;
    if (isTest && (intent.eq?.length || intent.place?.length)) {
      const EQK = { generator: 'generator', transfer: 'transfer', thermograph: 'thermography', infrared: 'thermography', megger: 'megger', 'arc flash': 'arcflash' };
      const eqHit = (r) => !intent.eq.length || intent.eq.some((x) => familyOf(r.d) === EQK[x]);
      const mm = intent.place?.length ? new Set(matchPlace(docs, intent.place).map((d) => d.id)) : null;
      inScope = (d) => (!mm || mm.has(d.id)) && (!intent.eq.length || intent.eq.some((x) => familyOf(d) === EQK[x]));
      rows = rows.filter((r) => (!mm || mm.has(r.d.id)) && eqHit(r));
      if (!rows.length) return null;
      // one named piece of equipment at one place (or "when is ... due"): its own date and status, no window
      if (intent.specific || intent.lookup) {
        const pk = rows.map((r) => ({ r, dd: okIso(r.date) ? daysBetween(t0, r.date) : null }));
        const st = (dd, date) => (dd == null ? 'date unreadable' : dd < 0 ? `overdue since ${humanDate(date)}` : dd === 0 ? 'due today' : `due ${humanDate(date)}`);
        const stv = (dd, date) => (dd == null ? 'date unreadable on the document' : dd < 0 ? `overdue since ${humanDate(date)} (${-dd} days overdue)` : dd === 0 ? `due today (${humanDate(date)})` : `due ${humanDate(date)} (${dd} days)`);
        const nOver = pk.filter((x) => x.dd != null && x.dd < 0).length; return answerEnvelope({ text: (intent.overdueOnly ? (nOver ? `${nOver} overdue. ` : 'None overdue. ') : '') + pk.map(({ r, dd }) => `${r.label.split(' · ')[0]}${intent.place?.length ? '' : ` at ${r.label.split(' · ')[1] ?? 'that site'}`}: ${st(dd, r.date)}`).join('; ') + '.', facts: pk.map(({ r, dd }) => fact(r.label, stv(dd, r.date), r.d, r.key)) });
      }
    }
    const w = intent.withinDays;
    let pick = rows;
    if (isTest && intent.overdueOnly) pick = rows.filter((r) => okIso(r.date) && r.date < t0);
    else if (isTest) pick = rows.filter((r) => !okIso(r.date) || daysBetween(t0, r.date) <= intent.withinDays);
    else if (intent.expiredOnly) pick = rows.filter((r) => okIso(r.date) && r.date < t0);
    else if (w != null) pick = rows.filter((r) => !okIso(r.date) || daysBetween(t0, r.date) <= w);
    pick = [...pick].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const facts = pick.slice(0, 40).map((r) => { if (!okIso(r.date)) return fact(r.label, 'date unreadable on the document', r.d, r.key); const dd = daysBetween(t0, r.date); return fact(r.label, `${dd < 0 ? `${isTest ? 'overdue since' : 'expired'} ${humanDate(r.date)} (${-dd} day${-dd === 1 ? '' : 's'} ${isTest ? 'overdue' : 'ago'})` : `${isTest ? 'due' : 'expires'} ${humanDate(r.date)} (${dd} day${dd === 1 ? '' : 's'})`}`, r.d, r.key); });
    const what = isTest ? 'test' : intent.types.length === 1 ? (intent.types[0] === 'certificate-of-insurance' ? 'insurance certificate' : intent.types[0].replace(/-/g, ' ')) : 'license, insurance or bond';
    const win = isTest && intent.overdueOnly ? ' overdue' : isTest ? ` due within ${intent.withinDays} days or overdue` : intent.expiredOnly ? ' already expired' : w != null ? ` expiring within ${w} days or already expired` : '';
    const noDue = isTest ? latestTests(docs).filter((d) => !f(d, 'next_test_due') && inScope(d)).length : 0; const tail = noDue ? ` ${noDue} test${noDue === 1 ? '' : 's'} on file ${noDue === 1 ? 'has' : 'have'} no next-test date printed, so ${noDue === 1 ? 'it is' : 'they are'} not counted.` : '';
    return answerEnvelope({ text: (pick.length ? `${pick.length} ${pick.length === 1 || what !== 'license, insurance or bond' ? what + (pick.length === 1 ? '' : 's') : 'licenses, insurance or bonds'}${win || ' on file'}. Your documents show these dates.${intent.types?.includes('certificate-of-insurance') ? ' A renewed policy under a new number may list the old one as expired too.' : ''}` : `None${win}. Your documents show no ${what} in that window.`) + tail, facts: w == null && !isTest && !intent.expiredOnly ? facts.length ? facts : rows.slice(0, 40).map((r) => fact(r.label, `expires ${humanDate(r.date)}`, r.d, r.key)) : facts });
  }
  return null;
}

/** Attention list (expiring / due / open) for dashboards and digests: same definitions as the lane. */
export async function electricalAttention(db, { today, withinDays = 60 } = {}) {
  if (!today) return { items: [] };
  const docs = await loadDocs(db);
  const items = [];
  const typeKey = CRED;
  for (const [type, [dk, nk, label]] of Object.entries(typeKey)) {
    const newest = new Map();
    const amb = ambiguousCreds(docs, type);
    if (amb.size) { const a0 = [...amb][0]; items.push({ kind: 'unreadable', category: 'credential', label: `${label}: ${amb.size} papers that may be the same credential`, date: '', days: -99999, documentId: a0.id, page: 1, note: "no number, or numbers that are nearly alike: I can't tell which paper is current" }); }
    for (const d of docs.filter((x) => x.type === type && !f(x, dk) && !amb.has(x))) items.push({ kind: 'unreadable', category: 'credential', label: `${label} ${f(d, nk) ?? d.filename}`.trim(), date: '', days: -99999, documentId: d.id, page: 1, note: 'no readable expiry date on this paper (it may be suspended, renewed or replaced)' }); // never silently left out
    for (const d of docs.filter((x) => x.type === type && f(x, dk) && !amb.has(x))) { const k = alnum(f(d, nk)) || norm(d.filename); const p = newest.get(k); if (!p || String(f(d, dk)) >= String(f(p, dk))) newest.set(k, d); }
    for (const d of newest.values()) { if (!okIso(f(d, dk)) || d.conflict?.has(dk)) { items.push({ kind: 'unreadable', category: 'credential', label: `${label} ${f(d, nk) ?? ''}`.trim(), date: f(d, dk), days: -99999, documentId: d.id, page: d.fields[dk].page }); continue; } const dd = daysBetween(today, f(d, dk)); if (dd <= withinDays) items.push({ kind: dd < 0 ? 'expired' : 'expiring', category: 'credential', label: `${label} ${f(d, nk) ?? ''}${d.multi ? ' (several coverages, earliest expiry)' : ''}`.trim(), date: f(d, dk), days: dd, documentId: d.id, page: d.fields[dk].page, ...(dd < 0 && type === 'certificate-of-insurance' && docs.some((o) => o.type === type && o.id !== d.id && f(o, 'insurer') && f(o, 'insurer') === f(d, 'insurer') && String(f(o, dk)) > String(f(d, dk))) ? { note: 'a newer policy from the same insurer is on file' } : {}) }); }
  }
  const ambT = ambiguousTests(docs);
  { const amb = ambT; if (amb.size) items.push({ kind: 'unreadable', category: 'test', label: `Test reports: ${amb.size} papers that may be the same equipment or a retest`, date: '', days: -99999, documentId: [...amb][0].id, page: 1, note: "I can't tell a retest from a second unit (no serial number, or an undated paper)" }); }
  const latestT = new Map(); for (const d of latestTests(docs).filter((x) => !ambT.has(x))) if (f(d, 'next_test_due')) latestT.set(testKey(d), d);
  for (const d of latestT.values()) { if (!okIso(f(d, 'next_test_due'))) continue; const dd = daysBetween(today, f(d, 'next_test_due')); if (dd <= withinDays) items.push({ kind: dd < 0 ? 'overdue' : 'due', category: 'test', label: `${f(d, 'equipment_type') ?? 'Test'} · ${f(d, 'service_address') ?? d.filename}`, date: f(d, 'next_test_due'), days: dd, documentId: d.id, page: d.fields.next_test_due.page }); }
  items.sort((a, b) => a.days - b.days);
  return { items };
}
