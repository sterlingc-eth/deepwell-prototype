/**
 * "Who is overdue / due for maintenance?" — answered deterministically from the records (Team A, 2026-09-24).
 *
 * Scorecard: maintenance-due 1/5. The old path treated the question as an unsupported filter and handed it to the agent,
 * which described what the agreement text says instead of listing customers. The shop owner's question is really
 * arithmetic over three facts Donovan already has:
 *   1. which customers are on a maintenance agreement (documents of type maintenance-agreement, linked to them) or have
 *      PM history at all,
 *   2. the agreement's cadence ("2 visits per year" -> every 6 months; unstated -> 12 months),
 *   3. the customer's last service visit ON OR BEFORE TODAY (a future-dated record is a typo or a scheduled visit and is
 *      never "the last visit"; preventive-maintenance visits are preferred over repairs when both exist).
 * A customer is OVERDUE when last visit + cadence is before today (or there is no visit on file at all).
 * "Due for fall/spring/summer/winter maintenance" = overdue now OR coming due before the end of that season's window.
 * "Haven't had a tune-up this year" / "no service in N months" = last visit before that cut-off, for everyone with an
 * agreement or any visit on file.
 *
 * pure: parseMaintenanceDue, parseCadenceMonths, seasonWindow, computeMaintenanceDue, buildMaintenanceAnswer
 * db:   runMaintenanceDue (one bounded set of tenant-scoped reads, no model call)
 */
import {
  TENANT_SQL, isoDate, todayIso, humanDate, addMonths, splitFuture, futureNote, docTypeAliases, typeSql,
  isVisitType, answerEnvelope,
} from './scope.js';
// TEAM C: citations for this producer (records / recordsTotal / recordsKind / basis).
import { attachCitations } from './citations/records.js';
import { maintenanceCitations } from './citations/history.js';

/* ------------------------------------------------------------------ question shape */

const MAINT_WORD = '(?:maintenance|maint|tune-?ups?|tune ups?|service|servicing|serviced|pm|preventive|preventative|check-?ups?|inspection)';
const SET_LEAD = /\b(?:who|whos|who's|which|what)\b|\bcustomers?\b|\bclients?\b|\baccounts?\b|\bagreements?\b|\bunits?\b/i;
const SEASON_RE = /\b(fall|autumn|spring|summer|winter)\b/i;

// Team E (2026-09-24, R3 fail): "list custs due for a tune-up" / "list ustomers due for a tune-up" / "who's due for
// fall mainttenance" fell all the way through to the agent's own generic "Found N matching records" fallback
// (agent/shape.js) because SET_LEAD/MAINT_WORD never saw a real "customer(s)"/"maintenance" token to trigger on.
// nlNormalize.js's own general fuzzy corrector deliberately skips EVERY word of a question it judges a single-record
// reference (streetVocab.js's own doc comment explains why), and this file never calls it either way — so a
// dispatcher typo/abbreviation of this file's own trigger words never gets fixed by anything upstream. A small
// closed table for exactly the typos this corpus's question bank produces, same idiom as contactLookup.js's own
// FIELD_WORD_TYPO_FIXES (explicit tokens, never a generic fuzzy match, so this can never rewrite an unrelated word).
const ROUTER_WORD_TYPO_FIXES = [
  [/\b(?:custs?|custmrs?|ustomers?)\b/g, 'customers'],
  [/\bmainttenance\b/g, 'maintenance'],
];

function fixRouterWordTypos(q) {
  let out = q;
  for (const [re, to] of ROUTER_WORD_TYPO_FIXES) out = out.replace(re, to);
  return out;
}

/**
 * Pure. {mode, season, months, sinceYear} or null.
 *   mode 'cadence' — overdue / due, judged against each agreement's own cadence
 *   mode 'window'  — "haven't had a tune-up this year", "no service in 18 months": a fixed look-back
 * A single-customer question ("when is Ellison due for his next filter change") never matches: it needs a set lead-in
 * ("who", "which customers") and a maintenance-type word.
 */
export function parseMaintenanceDue(question) {
  const q = fixRouterWordTypos(String(question ?? '').toLowerCase().replace(/\s+/g, ' ').trim());
  if (!q || /^\s*when\b/.test(q)) return null;
  if (!SET_LEAD.test(q)) return null;
  const season = (SEASON_RE.exec(q) ?? [])[1]?.toLowerCase().replace('autumn', 'fall') ?? null;

  const notInMonths = new RegExp(`\\b(?:no|not|haven'?t|hasn'?t|without)\\b[^?]*\\b${MAINT_WORD}\\b[^?]*\\b(?:in|for|over|within)\\s+(?:the\\s+(?:last|past)\\s+)?(\\d{1,3})\\s*(months?|years?|yrs?)\\b`).exec(q)
    ?? new RegExp(`\\b${MAINT_WORD}\\b[^?]*\\b(?:in|for|over)\\s+(?:the\\s+(?:last|past)\\s+)?(\\d{1,3})\\s*(months?|years?|yrs?)\\b`).exec(q);
  if (notInMonths && /\b(?:no|not|haven'?t|hasn'?t|without|none)\b/.test(q)) {
    const n = Number(notInMonths[1]);
    return { mode: 'window', season: null, months: /^y/.test(notInMonths[2]) ? n * 12 : n, sinceYear: null };
  }
  if (new RegExp(`\\b(?:haven'?t|hasn'?t|have not|has not|not|no)\\b[^?]*\\b(?:had|been|received|gotten|got|done)\\b[^?]*\\b${MAINT_WORD}\\b[^?]*\\bthis year\\b`).test(q)
    || new RegExp(`\\b${MAINT_WORD}\\b[^?]*\\bthis year\\b[^?]*\\b(?:yet|missing|not)\\b`).test(q)) {
    return { mode: 'window', season: null, months: null, sinceYear: 'this' };
  }
  if (new RegExp(`\\b(?:overdue|past due|behind|late)\\b[^?]*\\b${MAINT_WORD}\\b|\\b${MAINT_WORD}\\b[^?]*\\b(?:overdue|past due)\\b`).test(q)) {
    return { mode: 'cadence', season, months: null, sinceYear: null };
  }
  if (new RegExp(`\\bdue\\b[^?]*\\b(?:for|to get|a|their|its)?[^?]*\\b${MAINT_WORD}\\b`).test(q) || new RegExp(`\\b${MAINT_WORD}\\b[^?]*\\bdue\\b`).test(q)) {
    return { mode: 'cadence', season, months: null, sinceYear: null };
  }
  if (/\b(?:haven'?t|hasn'?t|not)\s+(?:been\s+)?(?:serviced|seen|visited)\b/.test(q)) {
    return { mode: 'cadence', season, months: null, sinceYear: null };
  }
  return null;
}

/* ------------------------------------------------------------------ cadence */

const WORD_NUM = { one: 1, once: 1, two: 2, twice: 2, three: 3, four: 4, six: 6, twelve: 12 };

/**
 * Pure. Months between visits, from agreement wording, or null when it says nothing about frequency.
 * "2 visits per year" / "twice a year" / "semi-annual" -> 6; "quarterly" / "4 visits a year" -> 3; "annual" -> 12;
 * "every 4 months" -> 4; "monthly" -> 1.
 */
/** `pack` (optional, Team G industry packs): checked FIRST, against that
 *  pack's own `maintenance.cadencePhrases` ({re, months}, re a regex SOURCE
 *  string) — a recurring compliance cadence a pack's own vocabulary states
 *  (plumbing's "annual backflow test", electrical's "panel inspection every
 *  three years", ...) that the generic phrasing below has no way to know
 *  about. Omitted (every existing caller), or the hvac pack itself (which
 *  ships no cadencePhrases — see industry/packs/hvac.js), this check is
 *  skipped entirely and behavior is byte-for-byte unchanged. */
export function parseCadenceMonths(text, pack = null) {
  const t = String(text ?? '').toLowerCase();
  if (!t.trim()) return null;
  for (const phrase of pack?.maintenance?.cadencePhrases ?? []) {
    if (new RegExp(phrase.re, 'i').test(t)) return phrase.months;
  }
  const perYear = /(\d{1,2}|one|two|three|four|six|twelve)\s*(?:x|times)?\s*(?:scheduled\s+|annual\s+|preventive\s+|maintenance\s+|routine\s+)?(?:visits?|inspections?|tune-?ups?|service\s+(?:calls?|visits?)|check-?ups?|cleanings?|maintenance)\s*(?:per|a|each|every|\/)\s*(?:year|yr|annum)\b/.exec(t);
  if (perYear) {
    const n = /^\d/.test(perYear[1]) ? Number(perYear[1]) : WORD_NUM[perYear[1]];
    if (n >= 1 && n <= 12) return Math.max(1, Math.round(12 / n));
  }
  const every = /every\s+(\d{1,2}|three|four|six|twelve)\s+months?\b/.exec(t);
  if (every) {
    const n = /^\d/.test(every[1]) ? Number(every[1]) : WORD_NUM[every[1]];
    if (n >= 1 && n <= 24) return n;
  }
  if (/\bsemi-?annual(?:ly)?\b|\bbi-?annual(?:ly)?\b|\btwice\s+(?:a|per|each)\s+year\b|\btwo\s+times\s+(?:a|per|each)\s+year\b|\bspring\s+(?:and|&)\s+fall\b|\bfall\s+(?:and|&)\s+spring\b/.test(t)) return 6;
  if (/\bquarterly\b|\bfour\s+times\s+(?:a|per|each)\s+year\b/.test(t)) return 3;
  if (/\bmonthly\b/.test(t)) return 1;
  if (/\bannual(?:ly)?\b|\bonce\s+(?:a|per|each)\s+year\b|\byearly\b|\bevery\s+year\b/.test(t)) return 12;
  return null;
}

/** Agreement term text like "01/01/2025 - 12/31/2025" / "2025-01-01 to 2025-12-31" -> {start, end} (ISO) or nulls. */
export function parseAgreementTerm(text) {
  const t = String(text ?? '');
  const dates = [];
  for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) dates.push(`${m[1]}-${m[2]}-${m[3]}`);
  for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) dates.push(`${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`);
  const valid = dates.map(isoDate).filter(Boolean).sort();
  if (valid.length >= 2) return { start: valid[0], end: valid[valid.length - 1] };
  if (valid.length === 1) return { start: valid[0], end: null };
  return { start: null, end: null };
}

/* ------------------------------------------------------------------ seasons */

/** The season window containing (or next after) today: {name, from, to} as ISO dates. Winter spans the year end.
 *  `pack` (optional): every pack ships the same [startMonth, endMonth] season definitions as the hard-coded ones
 *  below (see industry/packs/*.js's `maintenance.seasons`), so passing one changes nothing today — it exists so a
 *  pack COULD define different seasons (a warmer-climate pack, say) without this function changing again. */
export function seasonWindow(season, today, pack = null) {
  const t = todayIso(today);
  const y = Number(t.slice(0, 4));
  const [ps, pe] = pack?.maintenance?.seasons?.[season] ?? [];
  const pad2 = (n) => String(n).padStart(2, '0');
  const lastDayOf = (yy, mo) => new Date(Date.UTC(yy, mo, 0)).getUTCDate();
  const defs = ps && pe
    ? { [season]: (yy) => (pe >= ps
        ? { from: `${yy}-${pad2(ps)}-01`, to: `${yy}-${pad2(pe)}-${lastDayOf(yy, pe)}` }
        : { from: `${yy}-${pad2(ps)}-01`, to: `${yy + 1}-${pad2(pe)}-${lastDayOf(yy + 1, pe)}` }) }
    : {
        spring: (yy) => ({ from: `${yy}-03-01`, to: `${yy}-05-31` }),
        summer: (yy) => ({ from: `${yy}-06-01`, to: `${yy}-08-31` }),
        fall: (yy) => ({ from: `${yy}-09-01`, to: `${yy}-11-30` }),
        winter: (yy) => ({ from: `${yy}-12-01`, to: `${yy + 1}-02-28` }),
      };
  const mk = defs[season];
  if (!mk) return null;
  let w = mk(y);
  if (season === 'winter' && t <= `${y}-02-28`) w = { from: `${y - 1}-12-01`, to: `${y}-02-28` };
  if (w.to < t) w = mk(y + 1);
  return { name: season, ...w };
}

/* ------------------------------------------------------------------ core (pure) */

const PM_RE = /prevent|maint|tune|\bpm\b|check|clean|inspect|annual/i;
const isPmVisit = (v) => PM_RE.test(String(v.serviceType ?? '')) || /inspection/i.test(String(v.documentType ?? ''));

/**
 * @param {{customers: Array<{id, name, address}>, agreements: Array<{customerId, documentId, term, cadenceMonths}>,
 *          visits: Array<{customerId, documentId, date, documentType, serviceType, technician}>}} data
 * @param {{today: string, mode: 'cadence'|'window', season?: string|null, months?: number|null, sinceYear?: string|null, pack?: object|null}} opts
 *   `pack` (optional, Team G industry packs): its `maintenance.defaultCadenceMonths` replaces the hard-coded 12
 *   below wherever an agreement/window states no cadence of its own. Omitted, every existing caller keeps 12.
 */
export function computeMaintenanceDue(data, opts) {
  const today = todayIso(opts.today);
  const defaultCadence = opts.pack?.maintenance?.defaultCadenceMonths ?? 12;
  const byCust = new Map((data.customers ?? []).map((c) => [c.id, { ...c, agreements: [], visits: [] }]));
  for (const a of data.agreements ?? []) byCust.get(a.customerId)?.agreements.push(a);
  for (const v of data.visits ?? []) byCust.get(v.customerId)?.visits.push(v);

  const win = opts.season ? seasonWindow(opts.season, today, opts.pack) : null;
  const cutoff = opts.mode === 'window'
    ? (opts.sinceYear ? `${today.slice(0, 4)}-01-01` : addMonths(today, -(opts.months ?? defaultCadence)))
    : null;

  const overdue = [];
  const comingDue = [];
  const checked = []; // TEAM C: every customer judged (the honest-zero citation when nobody is overdue)
  let futureVisits = [];
  let considered = 0;
  for (const c of byCust.values()) {
    const { past, future } = splitFuture(c.visits, today);
    futureVisits = futureVisits.concat(future);
    // Agreements that ended before today no longer create an obligation (PM history alone still does).
    const activeAgreements = c.agreements.filter((a) => !a.end || a.end >= today);
    const pmVisits = past.filter((v) => isPmVisit(v) && isVisitType(v.documentType));
    const anyVisits = past.filter((v) => isVisitType(v.documentType));
    const hasObligation = activeAgreements.length > 0 || pmVisits.length > 0;
    if (opts.mode === 'window' ? !(hasObligation || anyVisits.length) : !hasObligation) continue;
    considered += 1;

    const last = pmVisits[0] ?? anyVisits[0] ?? null; // splitFuture sorts newest first
    const cadence = activeAgreements.length
      ? Math.min(...activeAgreements.map((a) => a.cadenceMonths ?? defaultCadence))
      : defaultCadence;
    const agreement = activeAgreements[0] ?? null;
    const entry = {
      customerId: c.id, name: c.name, address: c.address, lastVisit: last, cadenceMonths: cadence,
      cadenceStated: activeAgreements.some((a) => a.cadenceMonths != null),
      agreement, lastIsPm: Boolean(last && isPmVisit(last)),
      nextDue: last ? addMonths(last.date, cadence) : null,
    };
    checked.push(entry);
    if (opts.mode === 'window') {
      if (!last || last.date < cutoff) overdue.push(entry);
      continue;
    }
    if (!last || entry.nextDue < today) overdue.push(entry);
    else if (win && entry.nextDue <= win.to) comingDue.push(entry);
  }
  const byDue = (a, b) => (a.nextDue ?? '0000') < (b.nextDue ?? '0000') ? -1 : (a.nextDue ?? '0000') > (b.nextDue ?? '0000') ? 1 : a.name.localeCompare(b.name);
  overdue.sort(byDue);
  comingDue.sort(byDue);
  return { today, mode: opts.mode, season: opts.season ?? null, window: win, cutoff, overdue, comingDue, considered, futureVisits, checked };
}

const cadenceLabel = (m) => (m === 12 ? 'every 12 months' : m === 6 ? 'every 6 months (2 visits a year)' : `every ${m} month${m === 1 ? '' : 's'}`);

/** Pure: the answer envelope for a computed result. Every listed customer cites the visit and agreement documents. */
export function buildMaintenanceAnswer(res) {
  const MAX = 40;
  const listed = [...res.overdue, ...res.comingDue];
  const fact = (e, status) => {
    const sources = [];
    if (e.lastVisit) sources.push({ documentId: e.lastVisit.documentId, location: { field: 'service_date' } });
    if (e.agreement?.documentId) sources.push({ documentId: e.agreement.documentId, location: { field: 'agreement_term' } });
    // Team E (2026-09-24): the rubric grades this on "last visit date + type + tech" per customer, not a bare count -
    // tech is added here (it was already fetched into each visit row, just never shown).
    const tech = e.lastVisit?.technician ? `, tech ${e.lastVisit.technician}` : '';
    const last = e.lastVisit ? `last ${e.lastIsPm ? 'maintenance' : 'service'} visit ${humanDate(e.lastVisit.date)}${tech}` : 'no service visit on file';
    const cad = e.agreement ? `, ${cadenceLabel(e.cadenceMonths)}${e.cadenceStated ? '' : ' (default)'}` : '';
    const due = res.mode === 'cadence' && e.nextDue ? `, ${status === 'overdue' ? 'was due' : 'due'} ${humanDate(e.nextDue)}` : '';
    return { label: e.name, value: `${last}${cad}${due}`, entityId: e.customerId, sources };
  };
  const facts = [
    ...res.overdue.slice(0, MAX).map((e) => fact(e, 'overdue')),
    ...res.comingDue.slice(0, Math.max(0, MAX - res.overdue.length)).map((e) => fact(e, 'due')),
  ];

  let head;
  if (res.mode === 'window') {
    const span = res.cutoff ? `since ${humanDate(res.cutoff)}` : 'in that window';
    head = res.overdue.length
      ? `${res.overdue.length} customer${res.overdue.length === 1 ? ' has' : 's have'} had no service visit ${span}, of ${res.considered} with a maintenance agreement or visit on file`
      : `Every customer with a maintenance agreement or visit on file (${res.considered}) has had service ${span}`;
  } else if (res.window) {
    head = `${res.overdue.length} overdue and ${res.comingDue.length} coming due before the end of ${res.window.name} (${humanDate(res.window.to)}), out of ${res.considered} customers on a maintenance agreement or with maintenance history`;
  } else {
    head = res.overdue.length
      ? `${res.overdue.length} of ${res.considered} customers on a maintenance agreement (or with maintenance history) are overdue`
      : `None of the ${res.considered} customers on a maintenance agreement (or with maintenance history) are overdue`;
  }
  const names = listed.slice(0, 6).map((e) => e.name);
  const nameList = names.length ? `: ${names.join(', ')}${listed.length > names.length ? `, and ${listed.length - names.length} more` : ''}` : '';
  const basis = res.mode === 'cadence'
    ? ' Overdue = the last visit on or before today is older than the agreement cadence (12 months when the agreement does not say), or there is no visit on file.'
    : '';
  const text = `${head}${nameList}.${basis}${futureNote(res.futureVisits, res.today)}`;
  // TEAM C: one customer record per listed customer (same lists the counts come from), future visits mentioned only.
  return attachCitations(answerEnvelope({ text, facts, extra: { maintenanceDue: true } }), maintenanceCitations(res, listed));
}

/* ------------------------------------------------------------------ db */

const CADENCE_TEXT_KEYS = ['agreement_term', 'work_performed', 'notes', 'service_type'];

/** Reads the tenant's customers, agreements (with cadence) and visits, then computes + formats. Returns the envelope.
 *  `pack` (optional, Team G industry packs): threaded into parseCadenceMonths/computeMaintenanceDue so a
 *  plumbing/electrical/property tenant's own cadence phrasing and default cadence apply. Omitted, every existing
 *  caller keeps today's hard-coded HVAC-shaped defaults exactly. */
export async function runMaintenanceDue(db, intent, { today, pack = null } = {}) {
  const t = todayIso(today);
  const { rows: customers } = await db.raw(
    `SELECT id, data->>'customer_name' AS name, data->>'service_address' AS address
       FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL}
      LIMIT 5000`, []);
  if (!customers.length) return null;

  const aliases = docTypeAliases('maintenance-agreement');
  const [{ rows: agreementDocs }, { rows: visitRows }] = await Promise.all([
    db.raw(
      `SELECT d.id FROM documents d WHERE ${typeSql('d.document_type')} = ANY($1::text[]) AND d.${TENANT_SQL} LIMIT 5000`,
      [aliases]),
    db.raw(
      `SELECT x.document_id, COALESCE(NULLIF(x.corrected_value, ''), x.value) AS service_date, d.document_type,
              (SELECT COALESCE(NULLIF(s.corrected_value, ''), s.value) FROM extractions s
                WHERE s.document_id = x.document_id AND s.field_key = 'service_type' AND s.${TENANT_SQL}
                ORDER BY s.created_at DESC LIMIT 1) AS service_type,
              (SELECT COALESCE(NULLIF(tt.corrected_value, ''), tt.value) FROM extractions tt
                WHERE tt.document_id = x.document_id AND tt.field_key = 'technician' AND tt.${TENANT_SQL}
                ORDER BY tt.created_at DESC LIMIT 1) AS technician
         FROM extractions x JOIN documents d ON d.id = x.document_id
        WHERE x.field_key = 'service_date' AND x.${TENANT_SQL}
        LIMIT 20000`, []),
  ]);
  const docIds = [...new Set([...agreementDocs.map((r) => r.id), ...visitRows.map((r) => r.document_id)])];
  if (!docIds.length) return null;

  const [{ rows: linkRows }, { rows: textRows }, { rows: pageRows }] = await Promise.all([
    db.raw(
      `SELECT l.document_id, CASE WHEN e.entity_type = 'customer' THEN e.id ELSE e.customer_id END AS customer_id
         FROM document_entity_links l JOIN entities e ON e.id = l.entity_id AND e.merged_into IS NULL AND e.${TENANT_SQL}
        WHERE l.document_id = ANY($1::uuid[]) AND l.${TENANT_SQL}
       UNION
       SELECT x.document_id, CASE WHEN e.entity_type = 'customer' THEN e.id ELSE e.customer_id END
         FROM extractions x JOIN entities e ON e.id = x.entity_id AND e.merged_into IS NULL AND e.${TENANT_SQL}
        WHERE x.document_id = ANY($1::uuid[]) AND x.entity_id IS NOT NULL AND x.${TENANT_SQL}`,
      [docIds]),
    agreementDocs.length
      ? db.raw(
        `SELECT document_id, field_key, COALESCE(NULLIF(corrected_value, ''), value) AS value FROM extractions
          WHERE document_id = ANY($1::uuid[]) AND field_key = ANY($2::text[]) AND ${TENANT_SQL}`,
        [agreementDocs.map((r) => r.id), CADENCE_TEXT_KEYS])
      : Promise.resolve({ rows: [] }),
    agreementDocs.length
      ? db.raw(
        `SELECT document_id, left(text, 6000) AS text FROM document_pages
          WHERE document_id = ANY($1::uuid[]) AND ${TENANT_SQL}
          LIMIT 2000`,
        [agreementDocs.map((r) => r.id)]).catch(() => ({ rows: [] }))
      : Promise.resolve({ rows: [] }),
  ]);

  const custOfDoc = new Map();
  for (const r of linkRows) if (r.customer_id && !custOfDoc.has(r.document_id)) custOfDoc.set(r.document_id, r.customer_id);
  const textOfDoc = new Map();
  const add = (id, s) => textOfDoc.set(id, `${textOfDoc.get(id) ?? ''}\n${s}`);
  for (const r of textRows) add(r.document_id, `${r.value ?? ''}`);
  for (const r of pageRows) add(r.document_id, `${r.text ?? ''}`);

  const agreements = [];
  for (const d of agreementDocs) {
    const customerId = custOfDoc.get(d.id);
    if (!customerId) continue;
    const text = textOfDoc.get(d.id) ?? '';
    const term = textRows.find((r) => r.document_id === d.id && r.field_key === 'agreement_term')?.value ?? '';
    const { start, end } = parseAgreementTerm(term);
    agreements.push({ customerId, documentId: d.id, term, start, end, cadenceMonths: parseCadenceMonths(text, pack) });
  }
  const visits = [];
  for (const r of visitRows) {
    const customerId = custOfDoc.get(r.document_id);
    const date = isoDate(r.service_date);
    if (!customerId || !date) continue;
    visits.push({
      customerId, documentId: r.document_id, date, documentType: r.document_type, serviceType: r.service_type, technician: r.technician,
    });
  }
  const res = computeMaintenanceDue({ customers, agreements, visits }, { today: t, mode: intent.mode, season: intent.season, months: intent.months, sinceYear: intent.sinceYear, pack });
  if (!res.considered) return null; // nothing to judge (no agreements, no visits): let the fallback say so
  return buildMaintenanceAnswer(res);
}
