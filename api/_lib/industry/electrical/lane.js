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

const TENANT = "tenant_id = (current_setting('app.tenant_id', true))::uuid";

export const DECLINE = {
  code: "I can't judge whether work meets code, whether an inspection should have passed, or what the code requires. I can show what your documents say, with the page. Ask me about a specific permit, inspection or document.",
  legal: "I can't give legal advice. I can show what your documents say, with the page.",
  untracked: "Your company doesn't track that in DeepWell yet, so I can't answer from it.",
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
  const extra = [...norm(q).matchAll(STREET_RE)].flatMap((m) => m[0].split(' ').filter((t) => t && !/^(?:on|at|in|for|the|of|to|a|an|is|are|any|my|our)$/.test(t) && !new RegExp(`^(?:${STREET_SUF})$`).test(t)));
  return [...new Set([...base, ...extra])];
};

const PASS_RE = /\b(?:pass(?:es|ed)?|approved|accepted|satisfactory|complies|complied|ok|okay|no corrections|cleared|released)\b/i;
const FAIL_RE = /\b(?:fail(?:ed|ure)?|reject(?:ed)?|not approved|disapproved|denied|corrections?\s+(?:required|needed|issued)|correction notice|not passed|did not pass|unsatisfactory|red[- ]?tag(?:ged)?|needs? corrections?|re-?inspection (?:required|needed)|does not comply|no pass)\b|^\s*corrections?\s*$/i;
const NEG_RE = /\b(?:not|un|dis|non)[- ]?(?:passed?|approved|accepted|satisfactory|ok|okay|cleared|complies|compliant)\b|\bunsatisfactory\b/i;
const COND_RE = /\bwith\s+(?:corrections?|conditions?|comments?|exceptions?)\b|\bconditional(?:ly)?\b|\bpartial(?:ly)?\b|\bcorrect\w*|\bdeficienc\w*|\bviolations?\b|\bpending\b|\bnoted\b|\bto follow\b|\bw\/|\bre-?inspection\b|\bcomments?\b/i;
const NO_CORR = /\bno\s+corrections?(?:\s+(?:required|needed|issued|noted))?\b|\bwithout\s+corrections?\b|\bcorrections?\s+(?:not\s+(?:required|needed|issued))\b|\bcorrection notice not issued\b|\bno correction notice\b|\bno\s+re-?inspection(?:\s+(?:required|needed|necessary|fee))?\b|\bre-?inspection\s+not\s+(?:required|needed|necessary)\b|\bwithout\s+re-?inspection\b/gi;
export const resultClass = (r0) => { const r = String(r0 ?? '').replace(NO_CORR, ' '); return resultClass0(r, r0); };
const resultClass0 = (r, orig) => (FAIL_RE.test(r ?? '') || NEG_RE.test(r ?? '') ? 'failed' : COND_RE.test(r ?? '') ? 'other' : PASS_RE.test(orig ?? '') ? 'passed' : 'other');
const isFinal = (t) => !/\bpre[- ]?final\b|\bnot final\b|\btemp(?:orary)?\b|\bmeter\b|\bservice release\b|\bunderground\b/i.test(t ?? '') && /\bfinal(?:ed)?\b|sign[- ]?off/i.test(t ?? '');
const stageOf = (t) => (isFinal(t) ? 'final' : /\bpre[- ]?final\b/i.test(t ?? '') ? 'prefinal' : /\brough/i.test(t ?? '') ? 'rough' : /\bunderground\b/i.test(t ?? '') ? 'underground' : /\b(?:service|meter|temporary|cover)\b/i.test(t ?? '') ? 'service' : 'other');
const isRough = (t) => /\brough/i.test(t ?? '');

const humanDate = (iso) => {
  const m = String(iso ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(iso ?? '');
  const mo = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][+m[2] - 1];
  return `${mo} ${+m[3]}, ${m[1]}`;
};
const testKey = (d) => norm(`${addrKey(d)} ${f(d, 'equipment_type') ?? d.filename.replace(/\d+/g, '')}`);
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

export function classifyElectrical(question, { today } = {}) {
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
  const timeQ = /\b(?:this|last|next)\s+(?:week|month|quarter|year)\b|\b(?:since|before|after|during)\b|\bin\s+(?:january|february|march|april|may|june|july|august|september|october|november|december|20\d\d)\b/.test(q);
  const place = placeTokens(String(question).replace(/\b\d{2,4}\s*(?:amps?|a|volts?|v|kva|kw|va)\b/gi, ' ').replace(/\b(?:next|within|in the next|over the next|in)\s+\d{1,3}\s+(?:days?|weeks?|months?)\b/gi, ' '));
  if (/\b(?:next|within|in the next|over the next|in)\s+\d{1,3}\s+months?\b/.test(q) && /\b(?:expir\w*|due|renew\w*)\b/.test(q)) return null;
  const win = (() => { const m = q.match(/\b(?:next|within|in the next|over the next|in)\s+(\d{1,3})\s+(day|days|week|weeks|month|months)\b/); if (!m) return null; const n = +m[1]; return m[2].startsWith('week') ? n * 7 : m[2].startsWith('month') ? n * 30 : n; })();

  // ---- credentials (license / insurance / bond)
  const cred = /\b(?:licen[sc]es?|insurance certificates?|certificates? of insurance|coi|insurance|workers comp\w*|bonds?|surety)\b/.test(q) && /\b(?:expir\w*|renew\w*|lapse\w*|valid|good through|when|due)\b/.test(q);
  const CAL = /\b(?:jan\w*|feb\w*|march|apr\w*|may|june?|july?|aug\w*|sep\w*|oct\w*|nov\w*|dec\w*|q[1-4]|through|thru|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\b/;
  if (cred) {
    if (win == null && CAL.test(q)) return null;
    if (/\b(?:journeyman|master|apprentice)\b|\b\w+ s (?:licen[sc]es?|insurance|bonds?|coi)\b/.test(q)) return null;
    if (/\b(?:not|never|n t)\s+(?:\w+\s+)?(?:expired|lapsed)\b/.test(q) || /\b(?:last|past|previous)\s+\d{1,3}\s+(?:days?|weeks?|months?)\b/.test(q)) return null;
    if (win == null && /\b(?:this|next|last)\s+(?:week|month|quarter|year)\b|\b(?:before|by|after|until)\s+[a-z0-9]+/.test(q)) return null;
    const types = [];
    if (/\blicen[sc]e/.test(q)) types.push('contractor-license');
    if (/\b(?:insurance|coi|workers comp)/.test(q)) types.push('certificate-of-insurance');
    if (/\b(?:bond|surety)/.test(q)) types.push('surety-bond');
    return { kind: 'credentials', types, withinDays: win ?? (/\b(?:expired|already expired|lapsed)\b/.test(q) && !/\b(?:soon|about to|upcoming|expiring)\b/.test(q) ? 0 : /\b(?:soon|about to|upcoming|coming up|expiring)\b/.test(q) ? 60 : null), expiredOnly: /\b(?:already )?(?:expired|lapsed)\b/.test(q) && !/\bwill\b|\bexpiring\b|\bnext\b|\bsoon\b|\babout to\b|\bupcoming\b/.test(q) };
  }
  // ---- tests due
  if (/\b(?:tests?|studies|study|megger|thermography|arc flash|ats|transfer switch)\b/.test(q) && /\b(?:due|overdue|upcoming|next|coming up)\b/.test(q)) { const eq = ['generator', 'transfer', 'thermograph', 'infrared', 'megger', 'arc flash'].filter((w) => q.includes(w)); const pl = place.filter((t) => !/^(?:generator|transfer|switch|thermography|thermograph|infrared|megger|flash|arc)$/.test(t)); return { kind: 'tests_due', overdueOnly: /\boverdue\b/.test(q) && !/\bdue or\b|\bor overdue\b|\bupcoming\b|\bnext\b/.test(q), withinDays: win ?? 60, eq, place: pl, specific: eq.length > 0 && pl.length > 0 }; }
  // ---- corrections
  if (/\bcorrections?\b|failed inspections?|failed (?:rough|final)|did not pass|inspections? (?:that )?failed|failed the/.test(q) && /\b(?:show|list|every|which|what|any|how many)\b/.test(q) && !/\b(?:did|does|was|were)\b.*\bpass\b/.test(q)) { if (timeQ || /\b(?:not|never|haven t|hasn t|didn t|without|no)\b.*\b(?:fail\w*|pass\w*)\b/.test(q)) return null; return { kind: 'failed_inspections', place, unresolved: /\b(?:open|outstanding|unresolved|pending|still)\b/.test(q), count: /\bhow many\b/.test(q), stage: /\bfinals?\b/.test(q) && !/\brough/.test(q) ? 'final' : /\brough/.test(q) && !/\bfinals?\b/.test(q) ? 'rough' : null }; }
  // ---- open permits / no final
  if (/\b(?:open permits?|permits? (?:are |is )?(?:still )?open|still open|unfinaled|no final|without a final|not (?:been )?finaled|haven.?t (?:been )?finaled|(?:issued permit|permit) but no final|never finaled|awaiting final|permits? (?:that )?(?:are )?not closed)\b/.test(q)) return timeQ || /\b(?:expir\w*|older|overdue|stale|aging|past due)\b/.test(q) ? null : { kind: 'open_permits', count: /\bhow many\b/.test(q), place };
  // ---- inspection result at a place
  if (/\b(?:pass|passed|fail|failed|result|results|status|approved|get approved)\b/.test(q) && /\b(?:inspection|rough|final|underground|service)\b/.test(q) || /\bdid\b.*\b(?:pass|fail)\b/.test(q)) {
    const stage = isFinal(q) && isRough(q) ? null : isFinal(q) ? 'final' : isRough(q) ? 'rough' : /\bunderground\b/.test(q) ? 'underground' : null;
    if (place.length) return { kind: 'inspection_result', place, stage };
  }
  // ---- permit number / jurisdiction / edition
  if (/\bpermit number|permit no|permit #|which office issued|who issued|issuing (?:office|authority)|what jurisdiction|which jurisdiction|issued the permit\b/.test(q) && place.length) return { kind: 'permit_lookup', place };
  if (/\b(?:code )?edition\b|\bnec\b|which code/.test(q) && place.length) return { kind: 'code_edition', place };
  // ---- panels
  if (/\b(?:main breaker|panel|panels|bus rating|service size|amperage|voltage|phase)\b/.test(q) && /\b(?:size|rating|rated|how big|what|list|amperage|voltage|phase|volts?|amps?)\b/.test(q) && place.length && !/\bpermit|inspection\b/.test(q)) return { kind: 'panel_facts', place, list: /\b(?:list|show|every|all)\b/.test(q) };
  // ---- load calculation
  if (/\bload calc|demand load|connected load|service load\b/.test(q) && place.length) return { kind: 'load_calc', place, field: /\bconnected\b/.test(q) && /\bdemand\b/.test(q) ? 'both' : /\bconnected\b/.test(q) ? 'connected_load' : 'demand_load' };
  // ---- counts by document type
  const cm = /\b(?:closed|open|pass\w*|expir\w*|this month|this year|last|since|before|after|overdue|due|not|never|current|valid|fail\w*|reject\w*|correction\w*|re-?inspect\w*|final|rough|underground|temporary|upcoming|scheduled|active)\b/.test(q) ? null : q.match(/\bhow many\b/);
  if (cm) for (const [type, re] of KINDS.doctypes) if (re.test(q) && !place.length) return { kind: 'count_type', type, failed: /\bfailed\b/.test(q) && type === 'inspection-report' };
  return null;
}

const failedDocs = (docs) => { const rep = docs.filter((d) => d.type === 'inspection-report' && resultClass(f(d, 'inspection_result')) === 'failed'); const dup = (n) => rep.some((r) => { const kp = norm(f(n, 'permit_number') ?? ''); const rp = norm(f(r, 'permit_number') ?? ''); const sameJob = kp && rp ? kp === rp : (addrKey(n) && addrKey(n) === addrKey(r)); const sn = f(n, 'inspection_type') ? stageOf(f(n, 'inspection_type')) : null; const sr = stageOf(f(r, 'inspection_type')); const dn = f(n, 'service_date'); const dr = f(r, 'service_date'); const near = !dn || !dr || (okIso(dn) && okIso(dr) ? Math.abs(daysBetween(dr, dn)) <= (sn ? 0 : 7) : dn === dr); return sameJob && (!sn || sn === sr) && near; }); return [...rep, ...docs.filter((d) => d.type === 'correction-notice' && !dup(d))]; };
const certClosed = (d) => d.type === 'certificate-of-completion' && !/\b(?:void|revoked|rescinded|expired|denied|not issued|withheld)\b/i.test(f(d, 'inspection_result') ?? '') && resultClass(f(d, 'inspection_result')) !== 'failed';
const isFailedDoc = (d) => d.type === 'correction-notice' || (d.type === 'inspection-report' && resultClass(f(d, 'inspection_result')) === 'failed');
/* ------------------------------------------------------------------ data */
/** Every document with its extracted values and the page each value came from (corrected values win). */
async function loadDocs(db) {
  const { rows } = await db.raw(
    `SELECT d.id, d.original_filename AS filename, d.document_type AS type, d.created_at,
            x.field_key AS key, COALESCE(x.corrected_value, x.value) AS value, f.page_no AS page
       FROM documents d
       LEFT JOIN extractions x ON x.document_id = d.id AND x.${TENANT}
       LEFT JOIN facets f ON f.id = x.source_facet_id
      WHERE d.${TENANT} AND d.document_type IS NOT NULL
      ORDER BY d.created_at, d.id, x.created_at, x.id`, []);
  const map = new Map();
  for (const r of rows) {
    let d = map.get(r.id);
    if (!d) { d = { id: r.id, filename: r.filename, type: String(r.type).replace(/_/g, '-'), fields: {}, all: {} }; map.set(r.id, d); }
    if (r.key && r.value != null && String(r.value).trim() !== '') {
      // a model-read date can arrive as printed text; the lane only ever compares real ISO dates
      if (/_(?:date|expiry|due)$/.test(r.key) && !/^\d{4}-\d{2}-\d{2}$/.test(String(r.value))) { const iso = parseDate(r.value); if (iso) r.value = iso; }
      if (/_(?:expiry|due)$/.test(r.key) && /^\d{4}-\d{2}$/.test(String(r.value))) { const [yy, mm] = String(r.value).split('-').map(Number); r.value = new Date(Date.UTC(yy, mm, 0)).toISOString().slice(0, 10); } // a month-only expiry runs to the end of that month
      (d.all[r.key] ??= []).push({ value: String(r.value), page: r.page ?? 1 });
      d.fields[r.key] ??= { value: String(r.value), page: r.page ?? 1 };
    }
  }
  const out = [...map.values()];
  for (const d of out) {
    // a certificate listing several coverages: the EARLIEST expiry decides, and it is said so
    const ex = [...new Map((d.all.policy_expiry ?? []).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.value)).map((x) => [x.value, x])).values()].sort((a, b) => a.value.localeCompare(b.value));
    if (d.type === 'certificate-of-insurance' && ex.length > 1) { d.fields.policy_expiry = ex[0]; d.multi = true; }
  }
  return out;
}
const ampText = (v) => (/^\d{2,4}$/.test(String(v ?? '')) ? `${v} A` : String(v ?? ''));
const distinctVals = (d, k) => new Set((d.all[k] ?? []).map((x) => norm(x.value))).size;
const f = (d, k) => d.fields[k]?.value ?? null;
const src = (d, k) => ({ documentId: d.id, location: { field: k, page: d.fields[k]?.page ?? 1 } });
const placeText = (d) => `${String(f(d, 'service_address') ?? '').split(',')[0]} ${f(d, 'customer_name') ?? ''} ${d.filename ?? ''}`; // street part only: a city or zip is never a "job"
function matchPlace(docs, tokens) {
  if (!tokens.length) return [];
  return docs.filter((d) => { const have = new Set(toks(placeText(d))); return tokens.every((t) => have.has(t)); });
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
  // an inspection card with no readable stage or result (e.g. a multi-inspection card the reader could not pair) makes these answers unsafe: the normal path reads it
  if (['open_permits', 'inspection_result', 'failed_inspections'].includes(intent.kind)) {
    const unk = docs.filter((d) => (d.type === 'inspection-report' || d.type === 'correction-notice') && (d.type === 'inspection-report' ? !f(d, 'inspection_result') || !f(d, 'inspection_type') || !/\b(?:rough|final|underground|service|temporary|cover|meter)/i.test(f(d, 'inspection_type')) : false)); // no readable result, or a stage-less card such as a re-inspection
    const scope = intent.place?.length ? new Set(matchPlace(docs, intent.place).map((d) => d.id)) : null;
    if (unk.some((d) => !scope || scope.has(d.id))) return null;
  }
  const t0 = today && /^\d{4}-\d{2}-\d{2}$/.test(today) ? today : null;

  if (intent.kind === 'count_type') {
    let ds = docs.filter((d) => d.type === intent.type);
    if (intent.failed) ds = failedDocs(docs);
    return answerEnvelope({ text: `${ds.length} ${intent.failed ? 'failed ' : ''}${intent.type.replace(/-/g, ' ')} document${ds.length === 1 ? '' : 's'} on file.`, facts: ds.slice(0, 40).map((d) => ({ label: d.filename, value: intent.type.replace(/-/g, ' '), sources: [{ documentId: d.id, location: { field: 'document_type', page: 1 } }] })) });
  }

  if (intent.kind === 'open_permits') {
    const finals = new Set(docs.filter((d) => certClosed(d) || (d.type === 'inspection-report' && isFinal(f(d, 'inspection_type')) && resultClass(f(d, 'inspection_result')) === 'passed')).map((d) => norm(f(d, 'permit_number') ?? '')).filter(Boolean));
    // address-keyed finals too (a final card that names the site but no permit number)
    const permitCount = new Map(); for (const d of docs.filter((x) => x.type === 'permit')) { const k = addrKey(d); if (k) permitCount.set(k, new Set([...(permitCount.get(k) ?? []), norm(f(d, 'permit_number') ?? d.id)])); }
    const finalAddrs = new Set(docs.filter((d) => certClosed(d) || (d.type === 'inspection-report' && isFinal(f(d, 'inspection_type')) && resultClass(f(d, 'inspection_result')) === 'passed')).filter((d) => !f(d, 'permit_number')).map(addrKey).filter((k) => k && permitCount.get(k)?.size === 1));
    let permits = docs.filter((d) => d.type === 'permit' && f(d, 'permit_number'));
    // one row per permit number: the newest-listed document wins; near-duplicates collapse
    const byNum = new Map(); for (const d of permits) byNum.set(norm(f(d, 'permit_number')), d);
    permits = [...byNum.values()];
    if (intent.place?.length) { const mp = matchPlace(docs, intent.place); if (distinctPlaces(mp).length > 1) return clarify(mp); const m = new Set(mp.map((d) => d.id)); permits = permits.filter((d) => m.has(d.id)); }
    const open = permits.filter((d) => !finals.has(norm(f(d, 'permit_number'))) && !finalAddrs.has(addrKey(d)));
    if (!permits.length && intent.place?.length) return null;
    const facts = open.slice(0, 40).map((d) => fact(`${f(d, 'permit_number')}${f(d, 'service_address') ? ` · ${f(d, 'service_address')}` : ''}`, f(d, 'permit_expiry') ? `no passed final on file; permit ${t0 && f(d, 'permit_expiry') < t0 ? 'expired' : 'expires'} ${humanDate(f(d, 'permit_expiry'))}` : 'no passed final on file', d, 'permit_number'));
    return answerEnvelope({ text: open.length ? `${open.length} permit${open.length === 1 ? ' has' : 's have'} no passed final inspection or certificate of completion on file. This reflects your documents, not the city's records.` : (intent.place?.length ? 'That permit has a passed final inspection or certificate of completion on file.' : 'Every permit on file has a passed final inspection or certificate of completion on file.'), facts });
  }

  if (intent.kind === 'inspection_result') {
    const m = matchPlace(docs, intent.place).filter((d) => ['inspection-report', 'certificate-of-completion', 'correction-notice'].includes(d.type));
    if (!m.length) return null;
    if (distinctPlaces(m).length > 1) return clarify(m);
    let ds = m;
    if (intent.stage) ds = ds.filter((d) => (intent.stage === 'final' ? isFinal(f(d, 'inspection_type')) || d.type === 'certificate-of-completion' : intent.stage === 'rough' ? isRough(f(d, 'inspection_type')) : new RegExp(intent.stage, 'i').test(f(d, 'inspection_type') ?? '')));
    if (!ds.length) return answerEnvelope({ text: `I don't see a ${intent.stage} inspection for that job in your documents.`, facts: m.slice(0, 5).map((d) => fact(`${f(d, 'inspection_type') ?? d.type} (${humanDate(f(d, 'service_date'))})`, f(d, 'inspection_result') ?? 'no result written', d, f(d, 'inspection_result') ? 'inspection_result' : 'service_date')) });
    if (new Set(ds.map((d) => norm(f(d, 'permit_number') ?? '')).filter(Boolean)).size > 1) return null; // several permits at one address: never one headline over another permit's history
    if (ds.some((d) => f(d, 'inspection_result'))) ds = ds.filter((d) => d.type !== 'correction-notice' || f(d, 'inspection_result')); // a notice with no printed result never headlines over a recorded result
    ds = [...ds].sort((a, b) => String(f(b, 'service_date') ?? '').localeCompare(String(f(a, 'service_date') ?? '')));
    const dates = ds.map((d) => f(d, 'service_date'));
    const facts = ds.slice(0, 6).map((d) => { const items = (d.all.correction_items ?? []).map((x) => x.value); return fact(`${f(d, 'inspection_type') ?? 'Inspection'} · ${humanDate(f(d, 'service_date'))}`, `${f(d, 'inspection_result') ?? (d.type === 'certificate-of-completion' ? 'certificate of completion' : 'no result written')}${resultClass(f(d, 'inspection_result')) === 'failed' && items.length ? ` — ${items.join('; ')}` : ''}`, d, f(d, 'inspection_result') ? 'inspection_result' : 'service_date'); });
    const top = ds[0];
    const conflict = ds.length > 1 && dates[0] === dates[1] && f(ds[0], 'inspection_result') !== f(ds[1], 'inspection_result');
    return answerEnvelope({ text: conflict ? `Your documents show different results for the same date; both are listed with their pages.` : `${f(top, 'inspection_type') ?? 'The inspection'} on ${humanDate(f(top, 'service_date'))}: ${f(top, 'inspection_result') ?? (top.type === 'certificate-of-completion' ? 'certificate of completion on file' : 'no result written')} (newest first).`, facts });
  }

  if (intent.kind === 'failed_inspections') {
    const SUP = (d) => { const keyP = norm(f(d, 'permit_number') ?? ''); const keyA = addrKey(d); const dt = String(f(d, 'service_date') ?? ''); const same = (o) => { const kp = norm(f(o, 'permit_number') ?? ''); return keyP && kp ? keyP === kp : (keyA && addrKey(o) === keyA); }; return docs.some((o) => o.id !== d.id && same(o) && (certClosed(o) || (o.type === 'inspection-report' && resultClass(f(o, 'inspection_result')) === 'passed' && String(f(o, 'service_date') ?? '') >= dt && (isFinal(f(o, 'inspection_type')) || (d.type === 'correction-notice' && stageOf(f(d, 'inspection_type')) === 'other') || (stageOf(f(o, 'inspection_type')) === stageOf(f(d, 'inspection_type')) && stageOf(f(d, 'inspection_type')) !== 'other'))))); };
    let ds = failedDocs(docs).filter((d) => !intent.unresolved || !SUP(d)).filter((d) => (!intent.stage || (intent.stage === 'final' ? isFinal(f(d, 'inspection_type')) : isRough(f(d, 'inspection_type')))));
    if (intent.place?.length) { const mp = matchPlace(docs, intent.place); if (distinctPlaces(mp).length > 1) return clarify(mp); const m = new Set(mp.map((d) => d.id)); ds = ds.filter((d) => m.has(d.id)); if (!m.size) return null; }
    const withItems = ds.slice(0, 40).map((d) => {
      const items = (d.all.correction_items ?? []).map((x) => x.value);
      return { label: `${f(d, 'service_address') ?? d.filename} · ${f(d, 'inspection_type') ?? 'inspection'} · ${humanDate(f(d, 'service_date'))}`, value: `${f(d, 'inspection_result') ?? 'Correction notice'}${items.length ? ` — ${items.join('; ')}` : ''}`, sources: [src(d, f(d, 'inspection_result') ? 'inspection_result' : (f(d, 'correction_items') ? 'correction_items' : 'service_date'))] };
    });
    return answerEnvelope({ text: ds.length ? `${ds.length} ${intent.unresolved ? 'unresolved ' : ''}failed inspection${ds.length === 1 ? '' : 's'} on file${intent.unresolved ? ' with no later passed inspection' : ''}.` : (intent.unresolved ? 'No unresolved failed inspections on file.' : 'No failed inspections on file.'), facts: withItems });
  }

  if (intent.kind === 'permit_lookup') {
    const m = matchPlace(docs, intent.place).filter((d) => ['permit', 'inspection-report', 'correction-notice'].includes(d.type) && f(d, 'permit_number'));
    if (!m.length) return null;
    if (distinctPlaces(m).length > 1) return clarify(m);
    const nums = [...m.reduce((mp, d) => { const k = norm(f(d, 'permit_number')); const cur = mp.get(k); if (!cur || (d.type === 'permit' && cur.type !== 'permit') || (!f(cur, 'jurisdiction') && f(d, 'jurisdiction'))) mp.set(k, d); return mp; }, new Map()).values()];
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
    let m = matchPlace(docs, intent.place).filter((d) => ['panel-schedule', 'equipment-record', 'nameplate-photo', 'utility-application', 'load-calculation'].includes(d.type) && (f(d, 'amperage') || f(d, 'voltage') || f(d, 'phase')));
    if (!m.length) return null;
    if (m.some((d) => d.type === 'panel-schedule')) m = m.filter((d) => d.type === 'panel-schedule');
    if (m.some((d) => ['amperage', 'voltage', 'phase'].some((k) => distinctVals(d, k) > 1))) return null; // several panels in one document: the normal path reads each
    if (!intent.list && distinctPlaces(m).length > 1) return clarify(m);
    const facts = m.slice(0, 40).flatMap((d) => ['amperage', 'voltage', 'phase'].filter((k) => f(d, k)).map((k) => fact(`${f(d, 'equipment_type') ?? 'Panel'} · ${f(d, 'service_address') ?? d.filename} · ${k}`, k === 'amperage' ? ampText(f(d, k)) : f(d, k), d, k)));
    const first = m[0];
    return answerEnvelope({ text: m.length === 1 ? `${[f(first, 'amperage') && ampText(f(first, 'amperage')), f(first, 'voltage'), f(first, 'phase')].filter(Boolean).join(', ')} (as written on the document).` : `${m.length} panel documents match; each is listed with its rating.`, facts });
  }

  if (intent.kind === 'load_calc') {
    const m = matchPlace(docs, intent.place).filter((d) => d.type === 'load-calculation');
    if (!m.length) return null;
    if (distinctPlaces(m).length > 1) return clarify(m);
    const d = m[m.length - 1];
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
    const rows = [];
    if (isTest) {
      const latest = new Map();
      for (const d of latestTests(docs)) if (f(d, 'next_test_due')) latest.set(testKey(d), d);
      for (const d of latest.values()) rows.push({ d, key: 'next_test_due', label: `${f(d, 'equipment_type') ?? 'Test'} · ${f(d, 'service_address') ?? d.filename}`, date: f(d, 'next_test_due') });
    } else {
      for (const type of intent.types) {
        const newest = new Map();
        for (const d of docs.filter((x) => x.type === type && f(x, dateKey[type]))) { const k = norm(f(d, numKey[type]) ?? d.filename); const prev = newest.get(k); if (!prev || String(f(d, dateKey[type])) >= String(f(prev, dateKey[type]))) newest.set(k, d); }
        for (const d of newest.values()) rows.push({ d, key: dateKey[type], label: `${type.replace(/-/g, ' ')} ${f(d, numKey[type]) ?? ''}${f(d, 'license_holder') || f(d, 'insurer') ? ` · ${f(d, 'license_holder') ?? f(d, 'insurer')}` : ''}${d.multi ? ' (several coverages, earliest expiry shown)' : ''}`.trim(), date: f(d, dateKey[type]) });
      }
    }
    if (!rows.length) return null;
    if (isTest && intent.eq?.length && !intent.place?.length) { const sel = rows.filter((r) => intent.eq.some((w) => norm(r.label).includes(w.replace('transfer', 'transfer switch').replace('thermograph', 'thermograph')))); if (!sel.length) return null; const pk = sel.map((r) => ({ r, dd: okIso(r.date) ? daysBetween(t0, r.date) : null })); return answerEnvelope({ text: pk.map(({ r, dd }) => `${r.label.split(' · ')[0]}: ${dd == null ? 'date unreadable' : dd < 0 ? `overdue since ${humanDate(r.date)}` : `due ${humanDate(r.date)}`}`).join('; ') + '.', facts: pk.map(({ r, dd }) => fact(r.label, dd == null ? 'date unreadable on the document' : dd < 0 ? `overdue since ${humanDate(r.date)} (${-dd} days overdue)` : `due ${humanDate(r.date)} (${dd} days)`, r.d, r.key)) }); }
    if (isTest && intent.place?.length) { const mm = new Set(matchPlace(docs, intent.place).map((d) => d.id)); const sel = rows.filter((r) => mm.has(r.d.id) && (!intent.eq.length || intent.eq.some((w) => norm(r.label).includes(w.replace('transfer', 'transfer switch'))))); if (!sel.length) return null; return answerEnvelope({ text: `${sel.map((r) => `${r.label.split(' · ')[0]} ${daysBetween(t0, r.date) < 0 ? 'overdue since' : 'due'} ${humanDate(r.date)}`).join('; ')}.`, facts: sel.map((r) => fact(r.label, daysBetween(t0, r.date) < 0 ? `overdue since ${humanDate(r.date)} (${-daysBetween(t0, r.date)} days overdue)` : `due ${humanDate(r.date)} (${daysBetween(t0, r.date)} days)`, r.d, r.key)) }); }
    const w = intent.withinDays;
    let pick = rows;
    if (isTest && intent.overdueOnly) pick = rows.filter((r) => okIso(r.date) && r.date < t0);
    else if (isTest) pick = rows.filter((r) => !okIso(r.date) || daysBetween(t0, r.date) <= intent.withinDays);
    else if (intent.expiredOnly) pick = rows.filter((r) => okIso(r.date) && r.date < t0);
    else if (w != null) pick = rows.filter((r) => !okIso(r.date) || daysBetween(t0, r.date) <= w);
    pick = [...pick].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const facts = pick.slice(0, 40).map((r) => { if (!okIso(r.date)) return fact(r.label, 'date unreadable on the document', r.d, r.key); const dd = daysBetween(t0, r.date); return fact(r.label, `${dd < 0 ? `${isTest ? 'overdue since' : 'expired'} ${humanDate(r.date)} (${-dd} day${-dd === 1 ? '' : 's'} ${isTest ? 'overdue' : 'ago'})` : `${isTest ? 'due' : 'expires'} ${humanDate(r.date)} (${dd} day${dd === 1 ? '' : 's'})`}`, r.d, r.key); });
    const what = isTest ? 'test' : intent.types.length === 1 ? intent.types[0].replace(/-/g, ' ') : 'credential';
    const win = isTest && intent.overdueOnly ? ' overdue' : isTest ? ` due within ${intent.withinDays} days or overdue` : intent.expiredOnly ? ' already expired' : w != null ? ` expiring within ${w} days or already expired` : '';
    return answerEnvelope({ text: pick.length ? `${pick.length} ${what}${pick.length === 1 ? '' : 's'}${win}. Your documents show these dates.${intent.types?.includes('certificate-of-insurance') ? ' A renewed policy under a new number may list the old one as expired too.' : ''}` : `None${win}. Your documents show no ${what} in that window.`, facts: w == null && !isTest && !intent.expiredOnly ? facts.length ? facts : rows.slice(0, 40).map((r) => fact(r.label, `expires ${humanDate(r.date)}`, r.d, r.key)) : facts });
  }
  return null;
}

/** Attention list (expiring / due / open) for dashboards and digests: same definitions as the lane. */
export async function electricalAttention(db, { today, withinDays = 60 } = {}) {
  if (!today) return { items: [] };
  const docs = await loadDocs(db);
  const items = [];
  const typeKey = { 'contractor-license': ['license_expiry', 'license_number', 'Contractor license'], 'certificate-of-insurance': ['policy_expiry', 'policy_number', 'Insurance certificate'], 'surety-bond': ['bond_expiry', 'bond_number', 'Surety bond'] };
  for (const [type, [dk, nk, label]] of Object.entries(typeKey)) {
    const newest = new Map();
    for (const d of docs.filter((x) => x.type === type && f(x, dk))) { const k = norm(f(d, nk) ?? d.filename); const p = newest.get(k); if (!p || String(f(d, dk)) >= String(f(p, dk))) newest.set(k, d); }
    for (const d of newest.values()) { if (!okIso(f(d, dk))) { items.push({ kind: 'unreadable', category: 'credential', label: `${label} ${f(d, nk) ?? ''}`.trim(), date: f(d, dk), days: -99999, documentId: d.id, page: d.fields[dk].page }); continue; } const dd = daysBetween(today, f(d, dk)); if (dd <= withinDays) items.push({ kind: dd < 0 ? 'expired' : 'expiring', category: 'credential', label: `${label} ${f(d, nk) ?? ''}${d.multi ? ' (several coverages, earliest expiry)' : ''}`.trim(), date: f(d, dk), days: dd, documentId: d.id, page: d.fields[dk].page, ...(dd < 0 && type === 'certificate-of-insurance' && docs.some((o) => o.type === type && o.id !== d.id && f(o, 'insurer') && f(o, 'insurer') === f(d, 'insurer') && String(f(o, dk)) > String(f(d, dk))) ? { note: 'a newer policy from the same insurer is on file' } : {}) }); }
  }
  const latestT = new Map(); for (const d of latestTests(docs)) if (f(d, 'next_test_due')) latestT.set(testKey(d), d);
  for (const d of latestT.values()) { if (!okIso(f(d, 'next_test_due'))) continue; const dd = daysBetween(today, f(d, 'next_test_due')); if (dd <= withinDays) items.push({ kind: dd < 0 ? 'overdue' : 'due', category: 'test', label: `${f(d, 'equipment_type') ?? 'Test'} · ${f(d, 'service_address') ?? d.filename}`, date: f(d, 'next_test_due'), days: dd, documentId: d.id, page: d.fields.next_test_due.page }); }
  items.sort((a, b) => a.days - b.days);
  return { items };
}
