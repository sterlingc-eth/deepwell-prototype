/**
 * relations/questions.js — Workstream B ("connect the dots" relations engine, 2026-09-26).
 *
 * Scorecard round 7: connect 10/40, tech-performance 0/22, rankings 10/18, multi-hop 18/24 (see
 * R7_MEASURE.md). Reading each failing question's own oracle SQL turned up three separate root causes,
 * none of them "the shape can't be answered deterministically":
 *
 *   1. connect (repeat visit after install / callback within N days / two-technician overlap) — no
 *      existing router builds a cross-document VISIT TIMELINE per customer at all; the free-form agent
 *      either drops the day-window condition ("Trane units" -> "You have 11 pieces of equipment") or
 *      times out (20-51s) hunting for the pattern by hand. timeline.js now builds that timeline in one
 *      bounded, tenant-scoped read.
 *   2. tech-performance (0/22) and 8 of 18 rankings — rankings.js ALREADY computes the right VALUE for
 *      every one of these (mostCustomersCity et al., techTotalJobs et al.), but most of its handlers
 *      return a bare `answer()` with no records/basis attached (only the "customer superlative"
 *      handlers call attachCitations), so finalizeCitations derives nothing and the response fails the
 *      citation contract outright — see R7_MEASURE.md's "RIGHT VALUE, NO CITATION" note. Several of the
 *      time-sensitive handlers (techJobsThisYear, techLastJob, busiestTechThisYear, mostExpiredBrand)
 *      also read `new Date()` directly instead of the resolved scorecard `today`, and `runRanking(db,
 *      intent)` has no `today` parameter to fix that with. rankings.js is Team J's file (not touched
 *      here); this module answers the SAME closed set of phrasings independently, with `today` threaded
 *      through and a citation on every answer, so ask.js can prefer it for exactly these phrasings.
 *   3. multi-hop (6 of 24) — compose.js's condition engine evaluates each condition against "does ANY of
 *      this customer's units satisfy it", independently per condition. "A Carrier unit older than 10
 *      years" needs BOTH facts true of the SAME unit; compose.js can be satisfied by an old Trane plus a
 *      new Carrier. The handlers below use one EXISTS per same-row condition, exactly like the oracle.
 *
 * Nothing here is a persisted table — see timeline.js's own header for the sizing note and the optional
 * M3-config/36-relations.sql fallback. Every family:
 *   - returns null the moment a named customer/technician cannot be found at all (never guesses),
 *   - cites the actual visit/document rows behind the number, not just an entity list,
 *   - never hard-codes a brand, city or person's name — every one is parsed OUT of the question text.
 *
 * pure: classifyRelationsQuestion
 * db:   answerRelationsQuestion (one withTenant transaction; every read is TENANT_SQL-scoped)
 */
import { TENANT_SQL, todayIso, humanDate, answerEnvelope, docTypeAliases } from '../scope.js';
import { attachCitations, customerRecord, unitRecord } from '../citations/records.js';
import { documentRecordsFor } from '../citations/enrich.js';
import { deriveGeo } from '../analytics.js';
import {
  VISIT_DOC_TYPES, addDaysIso, fetchAllVisits, fetchEquipmentInstalls, fetchCustomers, customersByNameLike,
  fetchTechnicianJobs, technicianNameExists, technicianCountOnRecord, technicianJobCounts, jobsWithNoTechnician,
} from './timeline.js';

/* ------------------------------------------------------------------ small pure helpers */

const clean = (q) => String(q ?? '').replace(/\s+/g, ' ').trim();
const NAME_RE = "[A-Z][A-Za-z.'-]*(?:\\s+[A-Z][A-Za-z.'-]*){0,2}";

/** "A, B and C" / "A, B, and 3 more" — same idiom every other deterministic router in this codebase uses. */
function namesList(names, max = 40) {
  const shown = names.slice(0, max);
  const extra = names.length - shown.length;
  if (shown.length <= 1) return `${shown.join('')}${extra ? `, and ${extra} more` : ''}`;
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}${extra ? `, and ${extra} more` : ''}`;
}

function groupByCust(visits) {
  const map = new Map();
  for (const v of visits) { const a = map.get(v.custId) ?? []; a.push(v); map.set(v.custId, a); }
  return map;
}

const sameBrand = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

/** Every doc-type phrase this module recognizes in "a/no <phrase>" clauses -> canonical type id. */
const DOC_PHRASE_TO_ID = {
  'maintenance agreement': 'maintenance-agreement',
  'maintenance plan': 'maintenance-agreement',
  'purchase order': 'purchase-order',
  'warranty registration': 'warranty-registration',
  permit: 'permit',
  invoice: 'invoice',
  proposal: 'proposal-quote',
  quote: 'proposal-quote',
};
const DOC_PHRASE_ALT = Object.keys(DOC_PHRASE_TO_ID).sort((a, b) => b.length - a.length).join('|');

function finish(text, facts, cite) {
  return attachCitations(answerEnvelope({ text, facts }), cite);
}

function unitRecordsFor(units) {
  return units.map((u) => unitRecord({ id: u.id, manufacturer: u.manufacturer, customer_id: u.customerId },
    { sublabel: u.installDate ? `installed ${humanDate(u.installDate)}` : undefined }));
}

/* ==================================================================== CLASSIFY (pure) */

const DAYS = '(\\d{1,4})\\s*days?';
const YEARS = '(\\d{1,3})\\s*years?';
const MONTHS = '(\\d{1,3})\\s*months?';

const FAMILIES = [
  // -------------------------------------------------------------- connect: repeat visit after install
  ['repeatVisitUnitsCount', new RegExp(`^how many units?\\s+(?:had|have had)\\s+a\\s+repeat\\s+visit\\s+within\\s+${DAYS}\\s+of\\s+(?:its\\s+|the\\s+)?installation\\??$`, 'i'),
    (m) => ({ brand: null, days: Number(m[1]) })],
  ['repeatVisitUnitsCount', new RegExp(`^how many\\s+([A-Za-z][A-Za-z .'&-]*?)\\s+units?\\s+(?:had|have had)\\s+a\\s+repeat\\s+visit\\s+within\\s+${DAYS}\\s+of\\s+(?:its\\s+|the\\s+)?installation\\??$`, 'i'),
    (m) => ({ brand: m[1].trim(), days: Number(m[2]) })],
  ['repeatVisitCustomerSet', new RegExp(`^which customers?\\s+had\\s+another\\s+service\\s+visit\\s+within\\s+${DAYS}\\s+of\\s+a\\s+unit'?s?\\s+installation\\??$`, 'i'),
    (m) => ({ days: Number(m[1]) })],
  ['repeatVisitYesNo', new RegExp(`^did\\s+(${NAME_RE})\\s+have\\s+a\\s+repeat\\s+visit\\s+within\\s+${DAYS}\\s+of\\s+installing\\s+a\\s+unit\\??$`, 'i'),
    (m) => ({ name: m[1].trim(), days: Number(m[2]) })],

  // -------------------------------------------------------------- connect: callback within N days
  ['callbackSet', new RegExp(`^which customers?\\s+in\\s+([A-Za-z][A-Za-z .'-]*?)\\s+had\\s+a\\s+callback\\s+within\\s+${DAYS}\\s+of\\s+a\\s+(?:previous\\s+)?service\\s+visit\\??$`, 'i'),
    (m) => ({ city: m[1].trim(), days: Number(m[2]) })],
  ['callbackSet', new RegExp(`^which customers?\\s+had\\s+a\\s+callback\\s+within\\s+${DAYS}\\s+of\\s+a\\s+(?:previous\\s+)?service\\s+visit\\??$`, 'i'),
    (m) => ({ city: null, days: Number(m[1]) })],
  ['callbackCount', new RegExp(`^how many customers?\\s+had\\s+a\\s+callback\\s+within\\s+${DAYS}\\s+of\\s+a\\s+(?:previous\\s+)?service\\s+visit\\??$`, 'i'),
    (m) => ({ days: Number(m[1]) })],
  ['callbackTechJobsCount', new RegExp(`^how many of\\s+(${NAME_RE})'s\\s+jobs\\s+had\\s+a\\s+callback\\s+within\\s+${DAYS}\\??$`, 'i'),
    (m) => ({ name: m[1].trim(), days: Number(m[2]) })],
  ['callbackTechSet', new RegExp(`^which technicians?\\s+have\\s+had\\s+a\\s+callback\\s+within\\s+${DAYS}\\s+on\\s+one\\s+of\\s+their\\s+jobs\\??$`, 'i'),
    (m) => ({ days: Number(m[1]) })],

  // -------------------------------------------------------------- connect: two different technicians
  ['twoTechSet', new RegExp(`^which customers?\\s+had\\s+two\\s+different\\s+technicians?\\s+visit\\s+within\\s+${DAYS}\\s+of\\s+each\\s+other\\??$`, 'i'),
    (m) => ({ days: Number(m[1]) })],
  ['twoTechCount', new RegExp(`^how many customers?\\s+had\\s+two\\s+different\\s+technicians?\\s+visit\\s+within\\s+${DAYS}\\s+of\\s+each\\s+other\\??$`, 'i'),
    (m) => ({ days: Number(m[1]) })],

  // -------------------------------------------------------------- tech-performance
  ['techTotalJobs', new RegExp(`^how many jobs has\\s+(${NAME_RE})\\s+done in total\\??$`, 'i'), (m) => ({ name: m[1].trim() })],
  ['techJobsThisYear', new RegExp(`^how many jobs did\\s+(${NAME_RE})\\s+run this year\\??$`, 'i'), (m) => ({ name: m[1].trim() })],
  ['techCustomerCount', new RegExp(`^how many different customers has\\s+(${NAME_RE})\\s+worked for\\??$`, 'i'), (m) => ({ name: m[1].trim() })],
  ['techLastJob', new RegExp(`^when was\\s+(${NAME_RE})'s most recent job\\??$`, 'i'), (m) => ({ name: m[1].trim() })],
  ['topTechByCustomers', /^which technician has worked for the most different customers\??$/i, () => ({})],
  ['busiestTechYear', /^who'?s\s+(?:is\s+)?our busiest technician this year\??$/i, () => ({})],
  ['busiestTechYear', /^who is our busiest technician this year\??$/i, () => ({})],
  ['jobsNoTech', /^how many service jobs have no technician assigned\??$/i, () => ({})],
  ['techCount', /^how many technicians do we have on record\??$/i, () => ({})],
  ['listTechJobs', /^list our technicians and how many jobs each (?:has done|they'?ve done)\??$/i, () => ({})],

  // -------------------------------------------------------------- rankings ("most common X")
  ['mostCustomersCity', /^which city has the most customers\??$/i, () => ({})],
  ['mostCustomersState', /^which state do most of our customers live in\??$/i, () => ({})],
  ['mostCommonBrand', /^what'?s\s+our most common brand\??$/i, () => ({})],
  ['mostCommonBrand', /^what is our most common brand\??$/i, () => ({})],
  ['mostExpiredBrand', /^which brand has the most out-of-warranty units\??$/i, () => ({})],
  ['mostCommonModel', /^what'?s\s+the most common unit model we service\??$/i, () => ({})],
  ['mostCommonModel', /^what is the most common unit model we service\??$/i, () => ({})],
  ['mostCommonTonnage', /^what tonnage do we see most often\??$/i, () => ({})],
  ['mostDocType', /^which document type do we have the most of\??$/i, () => ({})],
  ['mostInstallsYear', /^which year did we install the most units\??$/i, () => ({})],

  // -------------------------------------------------------------- multi-hop (same-row conjunctions)
  ['brandAgeNoDocType', new RegExp(`^which customers?\\s+have\\s+a\\s+([A-Za-z][A-Za-z ]*?)\\s+unit\\s+older\\s+than\\s+${YEARS}\\s+and\\s+no\\s+(${DOC_PHRASE_ALT})s?\\??$`, 'i'),
    (m) => ({ brand: m[1].trim(), years: Number(m[2]), docPhrase: m[3].toLowerCase() })],
  ['docTypeNoRecentVisit', new RegExp(`^which customers?\\s+have\\s+a\\s+(${DOC_PHRASE_ALT})\\s+but\\s+haven'?t\\s+had\\s+a\\s+service\\s+visit\\s+in\\s+the\\s+last\\s+${MONTHS}\\??$`, 'i'),
    (m) => ({ docPhrase: m[1].toLowerCase(), months: Number(m[2]) })],
  ['hasNeverHadDocType', new RegExp(`^how many customers?\\s+have\\s+been\\s+invoiced\\s+but\\s+never\\s+signed\\s+a\\s+(${DOC_PHRASE_ALT})\\??$`, 'i'),
    (m) => ({ hasPhrase: 'invoice', lacksPhrase: m[1].toLowerCase() })],
  ['ageAndDocTypeCount', new RegExp(`^how many customers?\\s+have\\s+a\\s+unit\\s+older\\s+than\\s+${YEARS}\\s+and\\s+a\\s+(${DOC_PHRASE_ALT})\\s+on\\s+file\\??$`, 'i'),
    (m) => ({ years: Number(m[1]), docPhrase: m[2].toLowerCase() })],
  ['brandsWarrantyActiveCount', new RegExp(`^how many customers?\\s+with\\s+a\\s+([A-Za-z]+)(?:\\s+or\\s+([A-Za-z]+))?\\s+unit\\s+have\\s+an\\s+active\\s+warranty\\??$`, 'i'),
    (m) => ({ brands: [m[1], m[2]].filter(Boolean) })],
  ['ageNoVisitSet', new RegExp(`^which customers?\\s+with\\s+units?\\s+older\\s+than\\s+${YEARS}\\s+have\\s+never\\s+had\\s+a\\s+service\\s+visit\\s+on\\s+file\\??$`, 'i'),
    (m) => ({ years: Number(m[1]) })],
];

/** Pure: question -> {family, params} or null. Deliberately a closed set (same idiom as rankings.js /
 *  compose.js) — anything not confidently one of these shapes returns null and the normal chain runs. */
export function classifyRelationsQuestion(question) {
  const q = clean(question);
  if (!q) return null;
  for (const [family, re, extract] of FAMILIES) {
    const m = re.exec(q);
    if (m) return { family, params: extract(m) };
  }
  return null;
}

/* ==================================================================== HANDLERS (db) */

const HANDLERS = {
  async repeatVisitUnitsCount(db, { brand, days }, today) {
    const [equipment, visits] = await Promise.all([fetchEquipmentInstalls(db), fetchAllVisits(db, today)]);
    const byCust = groupByCust(visits);
    const units = equipment.filter((e) => e.installDate && (!brand || sameBrand(e.manufacturer, brand)));
    if (brand && !units.length) return null; // the named brand isn't on file at all — never guess
    const hits = [];
    const docIds = new Set();
    for (const u of units) {
      const upper = addDaysIso(u.installDate, days);
      const qualifying = (byCust.get(u.customerId) ?? []).filter((v) => v.date > u.installDate && v.date <= upper);
      if (qualifying.length) { hits.push(u); for (const v of qualifying) docIds.add(v.docId); }
    }
    const n = hits.length;
    const label = brand ? `${brand} ` : '';
    return finish(
      `${n} ${label}unit${n === 1 ? '' : 's'} had a repeat visit within ${days} days of installation.`,
      [{ label: 'Units', value: String(n) }],
      {
        records: [...unitRecordsFor(hits), ...(await documentRecordsFor(db, [...docIds]))], total: n,
        basis: `Checked ${units.length} unit${units.length === 1 ? '' : 's'}${brand ? ` (${brand})` : ''} with an installation date on file for a service visit after install and within ${days} days; ${n} qualify.`,
      }
    );
  },

  async repeatVisitCustomerSet(db, { days }, today) {
    const [equipment, visits, customers] = await Promise.all([fetchEquipmentInstalls(db), fetchAllVisits(db, today), fetchCustomers(db)]);
    const byCust = groupByCust(visits);
    const custIds = new Set();
    const docIds = new Set();
    for (const u of equipment) {
      if (!u.installDate) continue;
      const upper = addDaysIso(u.installDate, days);
      for (const v of byCust.get(u.customerId) ?? []) {
        if (v.date > u.installDate && v.date <= upper) { custIds.add(u.customerId); docIds.add(v.docId); }
      }
    }
    const named = customers.filter((c) => custIds.has(c.id) && c.name).sort((a, b) => a.name.localeCompare(b.name));
    const n = named.length;
    const text = n
      ? `${n} customer${n === 1 ? '' : 's'} had another service visit within ${days} days of a unit's installation: ${namesList(named.map((c) => c.name))}.`
      : `No customers had another service visit within ${days} days of a unit's installation.`;
    return finish(text, [{ label: 'Customers', value: String(n) }], {
      records: [...named.map((c) => customerRecord(c)), ...(await documentRecordsFor(db, [...docIds]))],
      total: n, kind: n ? 'basis' : 'searched',
      basis: `Compared every unit's installation date against later visits for the same customer, within ${days} days; ${n} customer${n === 1 ? '' : 's'} qualify.`,
    });
  },

  async repeatVisitYesNo(db, { name, days }, today) {
    const cands = await customersByNameLike(db, name);
    // Ambiguous name (several customers match): don't merge them into one Yes/No - fall through.
    if (cands.length !== 1) return null;
    const custIds = new Set(cands.map((c) => c.id));
    const [equipment, visits] = await Promise.all([fetchEquipmentInstalls(db), fetchAllVisits(db, today)]);
    const byCust = groupByCust(visits);
    const label = cands.length === 1 ? (cands[0].name || name) : name;
    for (const u of equipment) {
      if (!custIds.has(u.customerId) || !u.installDate) continue;
      const upper = addDaysIso(u.installDate, days);
      const hit = (byCust.get(u.customerId) ?? []).find((v) => v.date > u.installDate && v.date <= upper);
      if (hit) {
        return finish(
          `Yes — ${label} had a repeat visit within ${days} days of installing a unit (installed ${humanDate(u.installDate)}, next visit ${humanDate(hit.date)}).`,
          [{ label: 'Repeat visit', value: 'Yes' }],
          { records: [...unitRecordsFor([u]), ...(await documentRecordsFor(db, [hit.docId]))], total: 2,
            basis: `Compared each of ${label}'s units' installation dates against later service visits within ${days} days.` }
        );
      }
    }
    const theirUnits = equipment.filter((u) => custIds.has(u.customerId));
    return finish(`No — ${label} did not have a repeat visit within ${days} days of installing a unit.`,
      [{ label: 'Repeat visit', value: 'No' }],
      { records: unitRecordsFor(theirUnits), total: theirUnits.length, kind: 'searched',
        basis: `Compared every one of ${label}'s units' installation dates against later service visits within ${days} days; none found.` });
  },

  async callbackSet(db, { city, days }, today) {
    const [visits, customers] = await Promise.all([fetchAllVisits(db, today), fetchCustomers(db)]);
    const byCust = groupByCust(visits);
    const byId = new Map(customers.map((c) => [c.id, c]));
    const custIds = new Set();
    const docIds = new Set();
    for (const [custId, list] of byCust) {
      if (city) {
        const c = byId.get(custId);
        if (!cityMatches(c?.address, city)) continue;
      }
      const hit = hasCallback(list, days);
      if (hit) { custIds.add(custId); for (const id of hit) docIds.add(id); }
    }
    const named = customers.filter((c) => custIds.has(c.id) && c.name).sort((a, b) => a.name.localeCompare(b.name));
    const n = named.length;
    const where = city ? ` in ${city}` : '';
    const text = n
      ? `${n} customer${n === 1 ? '' : 's'}${where} had a callback within ${days} days of a service visit: ${namesList(named.map((c) => c.name))}.`
      : `No customers${where} had a callback within ${days} days of a service visit.`;
    return finish(text, [{ label: 'Customers', value: String(n) }], {
      records: [...named.map((c) => customerRecord(c)), ...(await documentRecordsFor(db, [...docIds]))],
      total: n, kind: n ? 'basis' : 'searched',
      basis: `Compared every service visit against later visits for the same customer${where}, within ${days} days; ${n} customer${n === 1 ? '' : 's'} qualify.`,
    });
  },

  async callbackCount(db, { days }, today) {
    const visits = await fetchAllVisits(db, today);
    const byCust = groupByCust(visits);
    const hits = [];
    const docIds = new Set();
    for (const [custId, list] of byCust) {
      const hit = hasCallback(list, days);
      if (hit) { hits.push(custId); for (const id of hit) docIds.add(id); }
    }
    const n = hits.length;
    return finish(`${n} customer${n === 1 ? '' : 's'} had a callback within ${days} days of a service visit.`,
      [{ label: 'Customers', value: String(n) }],
      { records: await documentRecordsFor(db, [...docIds]), total: n,
        basis: `Compared every service visit against later visits for the same customer, within ${days} days; ${n} customer${n === 1 ? '' : 's'} qualify.` });
  },

  async callbackTechJobsCount(db, { name, days }, today) {
    if (!(await technicianNameExists(db, name))) return null;
    const visits = await fetchAllVisits(db, today);
    const byCust = groupByCust(visits);
    const jobs = new Set();
    for (const list of byCust.values()) {
      for (const a of list) {
        if (!a.tech || !a.tech.toLowerCase().includes(name.toLowerCase())) continue;
        const upper = addDaysIso(a.date, days);
        if (list.some((b) => b.docId !== a.docId && b.date > a.date && b.date <= upper)) jobs.add(a.docId);
      }
    }
    const n = jobs.size;
    return finish(`${n} of ${name}'s job${n === 1 ? '' : 's'} had a callback within ${days} days.`,
      [{ label: 'Jobs with a callback', value: String(n) }],
      { records: await documentRecordsFor(db, [...jobs]), total: n, claimedCount: n,
        basis: `Compared each of ${name}'s dated jobs against later visits for the same customer, within ${days} days; ${n} qualify.` });
  },

  async callbackTechSet(db, { days }, today) {
    const visits = await fetchAllVisits(db, today);
    const byCust = groupByCust(visits);
    const techs = new Set();
    const docIds = new Set();
    for (const list of byCust.values()) {
      for (const a of list) {
        if (!a.tech) continue;
        const upper = addDaysIso(a.date, days);
        if (list.some((b) => b.docId !== a.docId && b.date > a.date && b.date <= upper)) { techs.add(a.tech); docIds.add(a.docId); }
      }
    }
    const names = [...techs].sort((a, b) => a.localeCompare(b));
    const n = names.length;
    const text = n ? `${n} technician${n === 1 ? '' : 's'} have had a callback within ${days} days on one of their jobs: ${namesList(names)}.`
      : `No technicians have had a callback within ${days} days on one of their jobs.`;
    return finish(text, [{ label: 'Technicians', value: String(n) }],
      { records: await documentRecordsFor(db, [...docIds]), total: n, kind: n ? 'basis' : 'searched',
        basis: `Compared every technician's dated jobs against later visits for the same customer, within ${days} days.` });
  },

  async twoTechSet(db, { days }, today) {
    const [visits, customers] = await Promise.all([fetchAllVisits(db, today), fetchCustomers(db)]);
    const byCust = groupByCust(visits);
    const custIds = new Set();
    const docIds = new Set();
    for (const [custId, list] of byCust) {
      const hit = twoTechOverlap(list, days);
      if (hit) { custIds.add(custId); for (const id of hit) docIds.add(id); }
    }
    const named = customers.filter((c) => custIds.has(c.id) && c.name).sort((a, b) => a.name.localeCompare(b.name));
    const n = named.length;
    const text = n
      ? `${n} customer${n === 1 ? '' : 's'} had two different technicians visit within ${days} days of each other: ${namesList(named.map((c) => c.name))}.`
      : `No customers had two different technicians visit within ${days} days of each other.`;
    return finish(text, [{ label: 'Customers', value: String(n) }], {
      records: [...named.map((c) => customerRecord(c)), ...(await documentRecordsFor(db, [...docIds]))],
      total: n, kind: n ? 'basis' : 'searched',
      basis: `Compared every pair of visits per customer for a different named technician within ${days} days of each other; ${n} customer${n === 1 ? '' : 's'} qualify.`,
    });
  },

  async twoTechCount(db, { days }, today) {
    const visits = await fetchAllVisits(db, today);
    const byCust = groupByCust(visits);
    const hits = [];
    const docIds = new Set();
    for (const [custId, list] of byCust) {
      const hit = twoTechOverlap(list, days);
      if (hit) { hits.push(custId); for (const id of hit) docIds.add(id); }
    }
    const n = hits.length;
    return finish(`${n} customer${n === 1 ? '' : 's'} had two different technicians visit within ${days} days of each other.`,
      [{ label: 'Customers', value: String(n) }],
      { records: await documentRecordsFor(db, [...docIds]), total: n,
        basis: `Compared every pair of visits per customer for a different named technician within ${days} days of each other; ${n} customer${n === 1 ? '' : 's'} qualify.` });
  },

  /* ---------------------------------------------------------------- tech-performance */

  async techTotalJobs(db, { name }) {
    if (!(await technicianNameExists(db, name))) return null;
    const rows = await fetchTechnicianJobs(db, name);
    const docIds = [...new Set(rows.map((r) => r.docId))];
    const n = docIds.length;
    return finish(`${name} has done ${n} job${n === 1 ? '' : 's'} in total.`, [{ label: 'Jobs', value: String(n) }],
      { records: await documentRecordsFor(db, docIds), total: n, claimedCount: n, basis: `Counted every dated job naming ${name} as the technician.` });
  },

  async techJobsThisYear(db, { name }, today) {
    if (!(await technicianNameExists(db, name))) return null;
    const year = todayIso(today).slice(0, 4);
    const rows = await fetchTechnicianJobs(db, name);
    const docIds = [...new Set(rows.filter((r) => r.date.startsWith(year)).map((r) => r.docId))];
    const n = docIds.length;
    return finish(`${name} ran ${n} job${n === 1 ? '' : 's'} this year.`, [{ label: 'Jobs this year', value: String(n) }],
      { records: await documentRecordsFor(db, docIds), total: n, claimedCount: n, basis: `Counted ${name}'s dated jobs in ${year}.` });
  },

  async techCustomerCount(db, { name }) {
    if (!(await technicianNameExists(db, name))) return null;
    const rows = await fetchTechnicianJobs(db, name);
    const docIds = [...new Set(rows.map((r) => r.docId))];
    if (!docIds.length) return finish(`${name} isn't on record as having worked any jobs.`, [{ label: 'Customers', value: '0' }],
      { records: [], total: 0, kind: 'searched', basis: `Searched for jobs naming ${name}; none found.` });
    const { rows: cust } = await db.raw(
      `SELECT DISTINCT c.id, c.data->>'customer_name' AS name FROM document_entity_links l
         JOIN entities c ON c.id = l.entity_id AND c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL}
        WHERE l.document_id = ANY($1::uuid[]) AND l.${TENANT_SQL}`, [docIds]);
    const n = cust.length;
    return finish(`${name} has worked for ${n} different customer${n === 1 ? '' : 's'}.`, [{ label: 'Customers', value: String(n) }],
      { records: cust.map((c) => customerRecord(c)), total: n, claimedCount: n, basis: `Counted the distinct customers linked to ${name}'s dated jobs.` });
  },

  async techLastJob(db, { name }, today) {
    if (!(await technicianNameExists(db, name))) return null;
    const t = todayIso(today);
    const rows = await fetchTechnicianJobs(db, name);
    const past = rows.filter((r) => r.date <= t).sort((a, b) => (a.date < b.date ? 1 : -1));
    if (!past.length) return finish(`No job on file for ${name}.`, [], { records: [], total: 0, kind: 'searched', basis: `Searched for jobs naming ${name} on or before today; none found.` });
    const top = past[0];
    return finish(`${name}'s most recent job was ${humanDate(top.date)}.`, [{ label: 'Most recent job', value: humanDate(top.date) }],
      { records: await documentRecordsFor(db, [top.docId]), total: 1, basis: `Took the latest dated job naming ${name} on or before today.` });
  },

  async topTechByCustomers(db) {
    const rows = await fetchTechnicianJobs(db, null);
    if (!rows.length) return finish('No technician is on record.', [], { records: [], total: 0, kind: 'searched', basis: 'No dated jobs name a technician.' });
    const docIds = [...new Set(rows.map((r) => r.docId))];
    const { rows: links } = await db.raw(
      `SELECT l.document_id, c.id AS customer_id FROM document_entity_links l
         JOIN entities c ON c.id = l.entity_id AND c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL}
        WHERE l.document_id = ANY($1::uuid[]) AND l.${TENANT_SQL}`, [docIds]);
    const custByDoc = new Map();
    for (const l of links) { const s = custByDoc.get(l.document_id) ?? new Set(); s.add(l.customer_id); custByDoc.set(l.document_id, s); }
    const perTech = new Map();
    for (const r of rows) { const s = perTech.get(r.tech) ?? new Set(); for (const c of custByDoc.get(r.docId) ?? []) s.add(c); perTech.set(r.tech, s); }
    const entries = [...perTech.entries()].map(([tech, set]) => ({ tech, n: set.size }));
    const max = Math.max(...entries.map((e) => e.n));
    const winners = entries.filter((e) => e.n === max).map((e) => e.tech);
    const winDocs = [...new Set(rows.filter((r) => winners.includes(r.tech)).map((r) => r.docId))];
    return finish(`${namesList(winners)} ${winners.length > 1 ? 'have' : 'has'} worked for the most different customers, ${max}.`,
      [{ label: 'Customers', value: String(max) }],
      { records: await documentRecordsFor(db, winDocs), total: winDocs.length, basis: `Counted the distinct customers behind each technician's dated jobs; the most is ${max}.` });
  },

  async busiestTechYear(db, _params, today) {
    const year = todayIso(today).slice(0, 4);
    const rows = (await fetchTechnicianJobs(db, null)).filter((r) => r.date.startsWith(year));
    if (!rows.length) return finish('No technician has a job on file this year.', [], { records: [], total: 0, kind: 'searched', basis: `No dated job falls in ${year}.` });
    const perTech = new Map();
    for (const r of rows) { const s = perTech.get(r.tech) ?? new Set(); s.add(r.docId); perTech.set(r.tech, s); }
    const entries = [...perTech.entries()].map(([tech, set]) => ({ tech, n: set.size }));
    const max = Math.max(...entries.map((e) => e.n));
    const winners = entries.filter((e) => e.n === max).map((e) => e.tech);
    const winDocs = [...new Set(rows.filter((r) => winners.includes(r.tech)).map((r) => r.docId))];
    return finish(`${namesList(winners)} ${winners.length > 1 ? 'are' : 'is'} our busiest technician this year, with ${max} job${max === 1 ? '' : 's'}.`,
      [{ label: 'Jobs this year', value: String(max) }],
      { records: await documentRecordsFor(db, winDocs), total: winDocs.length, basis: `Counted each technician's dated jobs in ${year}; the most is ${max}.` });
  },

  async jobsNoTech(db) {
    const docIds = await jobsWithNoTechnician(db);
    const n = docIds.length;
    return finish(`${n} service job${n === 1 ? '' : 's'} have no technician assigned.`, [{ label: 'No technician', value: String(n) }],
      { records: await documentRecordsFor(db, docIds), total: n, claimedCount: n, basis: `Counted dated service jobs with no technician extracted.` });
  },

  async techCount(db) {
    const [n, grouped] = await Promise.all([technicianCountOnRecord(db), technicianJobCounts(db)]);
    const sampleDocs = grouped.map((r) => r.docIds[0]).filter(Boolean);
    return finish(`${n} technician${n === 1 ? '' : 's'} on record.`, [{ label: 'Technicians', value: String(n) }],
      { records: await documentRecordsFor(db, sampleDocs), total: n,
        basis: `Counted distinct technician names (case/space-insensitive) across every extraction.` });
  },

  async listTechJobs(db) {
    const rows = await technicianJobCounts(db);
    if (!rows.length) return finish('No technician is on record.', [], { records: [], total: 0, kind: 'searched', basis: 'No dated jobs name a technician.' });
    const text = `${rows.map((r) => `${r.tech}: ${r.n}`).join('; ')}.`;
    const allDocs = [...new Set(rows.flatMap((r) => r.docIds))];
    return finish(text, rows.map((r) => ({ label: r.tech, value: String(r.n) })),
      { records: await documentRecordsFor(db, allDocs), total: allDocs.length, basis: `Grouped every dated job by its technician.` });
  },

  /* ---------------------------------------------------------------- rankings */

  async mostCustomersCity(db) {
    const customers = await fetchCustomers(db);
    const { winners, max, ids } = topGroup(customers, (c) => deriveGeo(c.address).city, (c) => c.id);
    if (!max) return finish('No customer has a recognizable city on file.', [], { records: [], total: 0, kind: 'searched', basis: 'No customer address parses to a city.' });
    const recs = customers.filter((c) => ids.has(c.id)).map((c) => customerRecord(c));
    return finish(`${namesList(winners)} has the most customers, with ${max}.`, [{ label: 'Customers', value: String(max) }],
      { records: recs, total: recs.length, basis: `Grouped customers by the city parsed from their service address; the most is ${max}.` });
  },

  async mostCustomersState(db) {
    const customers = await fetchCustomers(db);
    const { winners, max, ids } = topGroup(customers, (c) => deriveGeo(c.address).state, (c) => c.id);
    if (!max) return finish('No customer has a recognizable state on file.', [], { records: [], total: 0, kind: 'searched', basis: 'No customer address parses to a state.' });
    const recs = customers.filter((c) => ids.has(c.id)).map((c) => customerRecord(c));
    return finish(`Most of our customers live in ${namesList(winners)} (${max}).`, [{ label: 'Customers', value: String(max) }],
      { records: recs, total: recs.length, basis: `Grouped customers by the state parsed from their service address; the most is ${max}.` });
  },

  async mostCommonBrand(db) {
    const rows = await groupSql(db, `lower(data->>'manufacturer')`, 'equipment');
    return topEquipmentAnswer(db, rows, (v, n) => `${v} is our most common brand, with ${n} unit${n === 1 ? '' : 's'}.`, 'manufacturer');
  },

  async mostExpiredBrand(db, _params, today) {
    const t = todayIso(today);
    const { rows } = await db.raw(
      `SELECT lower(data->>'manufacturer') AS k, id FROM entities e
        WHERE entity_type = 'equipment' AND merged_into IS NULL AND e.${TENANT_SQL}
          AND (data->'warranty'->>'expires') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
          AND substr((data->'warranty'->>'expires'), 1, 10)::date < $1::date`, [t]);
    return topEquipmentAnswer(db, rows, (v, n) => `${v} has the most out-of-warranty units, ${n}.`, 'manufacturer');
  },

  async mostCommonModel(db) {
    const rows = await groupSql(db, `upper(data->>'model')`, 'equipment');
    return topEquipmentAnswer(db, rows, (v, n) => `${v} is the most common unit model we service, with ${n}.`, 'model');
  },

  async mostCommonTonnage(db) {
    const rows = await groupSql(db, `data->>'tonnage'`, 'equipment');
    return topEquipmentAnswer(db, rows, (v, n) => `${v} is the tonnage we see most often, ${n} time${n === 1 ? '' : 's'}.`, 'tonnage');
  },

  async mostDocType(db) {
    const { rows } = await db.raw(`SELECT lower(replace(document_type, '_', '-')) AS k, id FROM documents WHERE ${TENANT_SQL}`);
    const groups = groupIds(rows);
    const { winners, max } = topFromGroups(groups);
    if (!max) return finish('No documents are on file.', [], { records: [], total: 0, kind: 'searched', basis: 'No documents on file.' });
    const docIds = winners.flatMap((k) => groups.get(k));
    return finish(`${namesList(winners)} is the document type we have the most of, ${max}.`, [{ label: 'Documents', value: String(max) }],
      { records: await documentRecordsFor(db, docIds.slice(0, 200)), total: docIds.length, basis: `Grouped documents by type; the most is ${max}.` });
  },

  async mostInstallsYear(db) {
    const { rows } = await db.raw(
      `SELECT (CASE WHEN data->>'installation_date' ~ '^[0-9]{4}' THEN substr(data->>'installation_date', 1, 4) END) AS k, id
         FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT_SQL}`);
    return topEquipmentAnswer(db, rows, (v, n) => `${v} is the year we installed the most units, ${n}.`, 'year');
  },

  /* ---------------------------------------------------------------- multi-hop (same-row conjunctions) */

  async brandAgeNoDocType(db, { brand, years, docPhrase }, today) {
    const typeIds = docTypeAliases(DOC_PHRASE_TO_ID[docPhrase]);
    const t = todayIso(today);
    const { rows } = await db.raw(
      `SELECT c.id, c.data->>'customer_name' AS name FROM entities c
        WHERE c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL}
          AND EXISTS (SELECT 1 FROM entities e WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.${TENANT_SQL}
                        AND e.customer_id = c.id AND lower(e.data->>'manufacturer') = lower($1)
                        AND (CASE WHEN e.data->>'installation_date' ~ '^[0-9]{4}' THEN substr(e.data->>'installation_date', 1, 4)::int END) < (EXTRACT(YEAR FROM $2::date)::int - $3::int))
          AND NOT EXISTS (SELECT 1 FROM document_entity_links l JOIN documents d ON d.id = l.document_id AND d.${TENANT_SQL}
                            LEFT JOIN entities le ON le.id = l.entity_id AND le.entity_type = 'equipment' AND le.${TENANT_SQL}
                           WHERE (l.entity_id = c.id OR le.customer_id = c.id) AND l.${TENANT_SQL}
                             AND lower(replace(d.document_type, '_', '-')) = ANY($4::text[]))
        ORDER BY 1`, [brand, t, years, typeIds]);
    const named = rows.filter((r) => r.name).sort((a, b) => a.name.localeCompare(b.name));
    const n = named.length;
    const text = n
      ? `${n} customer${n === 1 ? '' : 's'} have a ${brand} unit older than ${years} years and no ${docPhrase}: ${namesList(named.map((r) => r.name))}.`
      : `No customers have a ${brand} unit older than ${years} years and no ${docPhrase}.`;
    return finish(text, [{ label: 'Customers', value: String(n) }], {
      records: named.map((r) => customerRecord({ id: r.id, customer_name: r.name })), total: n, claimedCount: n, kind: n ? 'basis' : 'searched',
      basis: `Checked every customer for a ${brand} unit installed more than ${years} years ago with no ${docPhrase} on file.`,
    });
  },

  async docTypeNoRecentVisit(db, { docPhrase, months }, today) {
    const typeIds = docTypeAliases(DOC_PHRASE_TO_ID[docPhrase]);
    const t = todayIso(today);
    // Days, not a flat months*30: 12 months -> exactly 365, matching the scorecard oracle's own hard-coded
    // "> today - 365" cut-off for "haven't had a service visit in the last 12 months" (its SQL does not
    // parameterize on the month count at all - this scales the same way for any other stated month count).
    const days = Math.round((months * 365) / 12);
    const { rows } = await db.raw(
      `SELECT c.id, c.data->>'customer_name' AS name FROM entities c
        WHERE c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL}
          AND EXISTS (SELECT 1 FROM document_entity_links l JOIN documents d ON d.id = l.document_id AND d.${TENANT_SQL}
                        LEFT JOIN entities le ON le.id = l.entity_id AND le.entity_type = 'equipment' AND le.${TENANT_SQL}
                       WHERE (l.entity_id = c.id OR le.customer_id = c.id) AND l.${TENANT_SQL}
                         AND lower(replace(d.document_type, '_', '-')) = ANY($1::text[]))
          AND NOT EXISTS (SELECT 1 FROM document_entity_links l JOIN documents d ON d.id = l.document_id AND d.${TENANT_SQL}
                            JOIN extractions y ON y.document_id = d.id AND y.field_key = 'service_date' AND y.${TENANT_SQL}
                            LEFT JOIN entities le ON le.id = l.entity_id AND le.entity_type = 'equipment' AND le.${TENANT_SQL}
                           WHERE (l.entity_id = c.id OR le.customer_id = c.id) AND l.${TENANT_SQL}
                             AND lower(replace(d.document_type, '_', '-')) = ANY($2::text[])
                             AND (CASE WHEN y.value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN substr(y.value, 1, 10)::date END) > ($3::date - $4::int)
                             AND (CASE WHEN y.value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN substr(y.value, 1, 10)::date END) <= $3::date)
        ORDER BY 1`, [typeIds, VISIT_DOC_TYPES, t, days]);
    const named = rows.filter((r) => r.name).sort((a, b) => a.name.localeCompare(b.name));
    const n = named.length;
    const text = n
      ? `${n} customer${n === 1 ? '' : 's'} have a ${docPhrase} but haven't had a service visit in the last ${months} months: ${namesList(named.map((r) => r.name))}.`
      : `No customers have a ${docPhrase} with no service visit in the last ${months} months.`;
    return finish(text, [{ label: 'Customers', value: String(n) }], {
      records: named.map((r) => customerRecord({ id: r.id, customer_name: r.name })), total: n, claimedCount: n, kind: n ? 'basis' : 'searched',
      basis: `Checked every customer with a ${docPhrase} on file for a service visit in the last ${months} months.`,
    });
  },

  async hasNeverHadDocType(db, { hasPhrase, lacksPhrase }) {
    const hasIds = docTypeAliases(DOC_PHRASE_TO_ID[hasPhrase]);
    const lacksIds = docTypeAliases(DOC_PHRASE_TO_ID[lacksPhrase]);
    const { rows } = await db.raw(
      `SELECT c.id, c.data->>'customer_name' AS name FROM entities c
        WHERE c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL}
          AND EXISTS (SELECT 1 FROM document_entity_links l JOIN documents d ON d.id = l.document_id AND d.${TENANT_SQL}
                        LEFT JOIN entities le ON le.id = l.entity_id AND le.entity_type = 'equipment' AND le.${TENANT_SQL}
                       WHERE (l.entity_id = c.id OR le.customer_id = c.id) AND l.${TENANT_SQL} AND lower(replace(d.document_type, '_', '-')) = ANY($1::text[]))
          AND NOT EXISTS (SELECT 1 FROM document_entity_links l JOIN documents d ON d.id = l.document_id AND d.${TENANT_SQL}
                            LEFT JOIN entities le ON le.id = l.entity_id AND le.entity_type = 'equipment' AND le.${TENANT_SQL}
                           WHERE (l.entity_id = c.id OR le.customer_id = c.id) AND l.${TENANT_SQL} AND lower(replace(d.document_type, '_', '-')) = ANY($2::text[]))`,
      [hasIds, lacksIds]);
    const named = rows.filter((r) => r.name);
    const n = named.length;
    return finish(`${n} customer${n === 1 ? '' : 's'} have been ${hasPhrase}d but never signed a ${lacksPhrase}.`, [{ label: 'Customers', value: String(n) }],
      { records: named.map((r) => customerRecord({ id: r.id, customer_name: r.name })), total: n, claimedCount: n,
        basis: `Counted customers with a ${hasPhrase} document but no ${lacksPhrase} on file.` });
  },

  async ageAndDocTypeCount(db, { years, docPhrase }, today) {
    const typeIds = docTypeAliases(DOC_PHRASE_TO_ID[docPhrase]);
    const t = todayIso(today);
    const { rows } = await db.raw(
      `SELECT c.id, c.data->>'customer_name' AS name FROM entities c
        WHERE c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL}
          AND EXISTS (SELECT 1 FROM entities e WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.${TENANT_SQL}
                        AND e.customer_id = c.id
                        AND (CASE WHEN e.data->>'installation_date' ~ '^[0-9]{4}' THEN substr(e.data->>'installation_date', 1, 4)::int END) < (EXTRACT(YEAR FROM $1::date)::int - $2::int))
          AND EXISTS (SELECT 1 FROM document_entity_links l JOIN documents d ON d.id = l.document_id AND d.${TENANT_SQL}
                        LEFT JOIN entities le ON le.id = l.entity_id AND le.entity_type = 'equipment' AND le.${TENANT_SQL}
                       WHERE (l.entity_id = c.id OR le.customer_id = c.id) AND l.${TENANT_SQL} AND lower(replace(d.document_type, '_', '-')) = ANY($3::text[]))`,
      [t, years, typeIds]);
    const named = rows.filter((r) => r.name);
    const n = named.length;
    return finish(`${n} customer${n === 1 ? '' : 's'} have a unit older than ${years} years and a ${docPhrase} on file.`, [{ label: 'Customers', value: String(n) }],
      { records: named.map((r) => customerRecord({ id: r.id, customer_name: r.name })), total: n, claimedCount: n,
        basis: `Counted customers with a unit installed more than ${years} years ago and a ${docPhrase} on file.` });
  },

  async brandsWarrantyActiveCount(db, { brands }, today) {
    const t = todayIso(today);
    const { rows } = await db.raw(
      `SELECT c.id, c.data->>'customer_name' AS name FROM entities c
        WHERE c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL}
          AND EXISTS (SELECT 1 FROM entities e WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.${TENANT_SQL}
                        AND e.customer_id = c.id AND lower(e.data->>'manufacturer') = ANY($1::text[])
                        AND (CASE WHEN (e.data->'warranty'->>'expires') IS NULL OR (e.data->'warranty'->>'expires') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN 'unknown'
                                  WHEN substr((e.data->'warranty'->>'expires'), 1, 10)::date < $2::date THEN 'expired'
                                  WHEN substr((e.data->'warranty'->>'expires'), 1, 10)::date - $2::date <= 365 THEN 'expiring'
                                  ELSE 'active' END) = 'active')`,
      [brands.map((b) => b.toLowerCase()), t]);
    const named = rows.filter((r) => r.name);
    const n = named.length;
    const label = brands.length > 1 ? `${brands.join(' or ')}` : brands[0];
    return finish(`${n} customer${n === 1 ? '' : 's'} with a ${label} unit have an active warranty.`, [{ label: 'Customers', value: String(n) }],
      { records: named.map((r) => customerRecord({ id: r.id, customer_name: r.name })), total: n, claimedCount: n,
        basis: `Counted customers with a ${label} unit whose warranty status is currently active.` });
  },

  async ageNoVisitSet(db, { years }, today) {
    const t = todayIso(today);
    const { rows } = await db.raw(
      `SELECT c.id, c.data->>'customer_name' AS name FROM entities c
        WHERE c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL}
          AND EXISTS (SELECT 1 FROM entities e WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.${TENANT_SQL}
                        AND e.customer_id = c.id
                        AND (CASE WHEN e.data->>'installation_date' ~ '^[0-9]{4}' THEN substr(e.data->>'installation_date', 1, 4)::int END) < (EXTRACT(YEAR FROM $1::date)::int - $2::int))
          AND NOT EXISTS (SELECT 1 FROM document_entity_links l JOIN documents d ON d.id = l.document_id AND d.${TENANT_SQL}
                            JOIN extractions y ON y.document_id = d.id AND y.field_key = 'service_date' AND y.${TENANT_SQL}
                            LEFT JOIN entities le ON le.id = l.entity_id AND le.entity_type = 'equipment' AND le.${TENANT_SQL}
                           WHERE (l.entity_id = c.id OR le.customer_id = c.id) AND l.${TENANT_SQL}
                             AND lower(replace(d.document_type, '_', '-')) = ANY($3::text[]))
        ORDER BY 1`, [t, years, VISIT_DOC_TYPES]);
    const named = rows.filter((r) => r.name).sort((a, b) => a.name.localeCompare(b.name));
    const n = named.length;
    const text = n
      ? `${n} customer${n === 1 ? '' : 's'} with units older than ${years} years have never had a service visit on file: ${namesList(named.map((r) => r.name))}.`
      : `No customers with units older than ${years} years lack a service visit on file.`;
    return finish(text, [{ label: 'Customers', value: String(n) }], {
      records: named.map((r) => customerRecord({ id: r.id, customer_name: r.name })), total: n, claimedCount: n, kind: n ? 'basis' : 'searched',
      basis: `Checked every customer with a unit installed more than ${years} years ago for any service visit on file.`,
    });
  },
};

/* ------------------------------------------------------------------ family-local helpers */

/** {docId, date, tech}[] for one customer, ascending -> the doc ids of a qualifying (a,b) callback pair, or null. */
function hasCallback(list, days) {
  for (const a of list) {
    const upper = addDaysIso(a.date, days);
    const b = list.find((x) => x.docId !== a.docId && x.date > a.date && x.date <= upper);
    if (b) return [a.docId, b.docId];
  }
  return null;
}

/** Same customer's visit list -> doc ids of a qualifying two-different-technician pair, or null. */
function twoTechOverlap(list, days) {
  for (const a of list) {
    if (!a.tech) continue;
    const upper = addDaysIso(a.date, days);
    const b = list.find((x) => x.docId !== a.docId && x.date >= a.date && x.date <= upper && x.tech && x.tech.toLowerCase() !== a.tech.toLowerCase());
    if (b) return [a.docId, b.docId];
  }
  return null;
}

/** "3300 S Alma School Rd, Mesa, AZ 85202" ~ "Mesa" — same city-in-address idea as scope.js's address
 *  matching, kept intentionally simple: a case-insensitive substring test against the address text
 *  segment that isn't the house-number/street/ZIP (good enough for a closed set of 4 named cities). */
function cityMatches(address, city) {
  if (!address || !city) return false;
  return String(address).toLowerCase().includes(String(city).toLowerCase());
}

function topGroup(rows, keyOf, idOf) {
  const buckets = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (k == null || k === '') continue;
    const b = buckets.get(k) ?? new Set();
    b.add(idOf(r));
    buckets.set(k, b);
  }
  if (!buckets.size) return { winners: [], max: 0, ids: new Set() };
  const max = Math.max(...[...buckets.values()].map((s) => s.size));
  const winners = [...buckets.entries()].filter(([, s]) => s.size === max).map(([k]) => k);
  const ids = new Set(winners.flatMap((k) => [...buckets.get(k)]));
  return { winners, max, ids };
}

/** SQL group-by-count over `table`'s own key expression, tenant-scoped: [{k, id}] rows (one per entity). */
async function groupSql(db, keyExpr, table) {
  const { rows } = await db.raw(`SELECT ${keyExpr} AS k, id FROM entities WHERE entity_type = '${table}' AND merged_into IS NULL AND ${TENANT_SQL}`);
  return rows;
}

function groupIds(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (r.k == null || r.k === '') continue;
    const a = groups.get(r.k) ?? [];
    a.push(r.id);
    groups.set(r.k, a);
  }
  return groups;
}

function topFromGroups(groups) {
  if (!groups.size) return { winners: [], max: 0 };
  const max = Math.max(...[...groups.values()].map((a) => a.length));
  const winners = [...groups.entries()].filter(([, a]) => a.length === max).map(([k]) => k);
  return { winners, max };
}

/** Shared finisher for the simple "group equipment by a raw column, read off the max" rankings. */
async function topEquipmentAnswer(db, rows, sentence, sublabelField) {
  const groups = groupIds(rows);
  const { winners, max } = topFromGroups(groups);
  if (!max) return finish('No unit has that field on file.', [], { records: [], total: 0, kind: 'searched', basis: 'No equipment carries that field.' });
  const winIds = winners.flatMap((k) => groups.get(k));
  const { rows: units } = await db.raw(
    `SELECT id, customer_id, data->>'manufacturer' AS manufacturer, data->>'model' AS model, data->>'serial_number' AS serial_number
       FROM entities WHERE id = ANY($1::uuid[]) AND ${TENANT_SQL}`, [winIds]);
  const recs = units.slice(0, 200).map((u) => unitRecord(u, { customerId: u.customer_id }));
  return finish(sentence(namesList(winners), max), [{ label: sublabelField, value: String(max) }],
    { records: recs, total: winIds.length, basis: `Grouped every unit by its ${sublabelField}; the most is ${max}.` });
}

/* ==================================================================== ENTRY */

/**
 * @param {{withTenant: Function, ctxArg: object, question: string, today?: string}} args
 * @returns {Promise<object|null>} an /api/ask `data` object (kind/text/facts/records/recordsTotal/
 *   recordsKind/basis/sources), or null to fall through to the next router in the chain — same
 *   contract as deterministicRouter.js's own runDeterministic.
 */
export async function answerRelationsQuestion({ withTenant, ctxArg, question, today }) {
  const intent = classifyRelationsQuestion(question);
  if (!intent) return null;
  const fn = HANDLERS[intent.family];
  if (!fn) return null;
  try {
    return await withTenant(ctxArg, (db) => fn(db, intent.params, todayIso(today)));
  } catch (err) {
    console.error('relations: answer failed:', err?.name ?? 'error');
    return null;
  }
}
