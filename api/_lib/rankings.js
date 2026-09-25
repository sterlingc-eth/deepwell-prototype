/**
 * rankings.js — Team J (2026-09-25): deterministic superlatives (rankings 13/18) and technician
 * performance (tech-performance 13/22) answers — R5_FAILS.md items 4.
 *
 * Both categories are the same shape underneath: "group the shop's own rows by some key and read off
 * the max/min/total" — the kind of question the free-form agent sometimes flattens wrong (a tie handled
 * arbitrarily, "this year" silently dropped, a technician name matched by substring across two different
 * people). Each handler below is a small, direct, tenant-scoped query — deliberately one per question
 * shape rather than one generic "group by anything" engine, because the grouping key (a derived city, a
 * lower-cased brand, an upper-cased model, a computed warranty tier, an ILIKE technician match) differs
 * enough per question that a generic engine would just be these same special cases wearing a costume.
 *
 * pure: parseRanking
 * db:   runRanking (one bounded, tenant-scoped read per handler, no model call)
 */
import { TENANT_SQL, isoDate, humanDate } from './scope.js';
import { installYearOf, warrantyStatusOf, deriveGeo } from './analytics.js';
import { attachCitations, customerRecord, documentRecord } from './citations/records.js';
import { financialsTableExists } from './financials/store.js';

const answer = (text, facts = []) => ({ kind: 'answer', text, facts, sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [] });
const noAnswer = (text) => ({ kind: 'no-answer', text, facts: [], sources: [], confidence: 0, verifiedCount: 0, unverifiedCount: 0, closest: [] });

/** Ties: every key sharing the winning count/value, joined "and". */
const namesList = (names) => names.join(names.length > 2 ? ', ' : ' and ').replace(/,([^,]*)$/, names.length > 2 ? ', and$1' : ',$1');

function topOf(entries, { max = true } = {}) {
  if (!entries.length) return { value: null, winners: [] };
  const target = max ? Math.max(...entries.map((e) => e.n)) : Math.min(...entries.map((e) => e.n));
  return { value: target, winners: entries.filter((e) => e.n === target).map((e) => e.k) };
}

/* ------------------------------------------------------------------ parse */

const NAME_RE = "[A-Z][a-zA-Z.'-]+(?:\\s+[A-Z][a-zA-Z.'-]+)+";

const PATTERNS = [
  ['mostUnitsCustomer', /\bwhich customer has the most units\b/i],
  ['mostDocumentsCustomer', /\bwhich customer has the most documents on file\b/i],
  ['mostVisitsCustomer', /\bwhich customer have we been out to the most times\b/i],
  ['mostCustomersCity', /\bwhich city has the most customers\b/i],
  ['mostCustomersZip', /\bwhich zip code has the most customers\b/i],
  ['mostCustomersState', /\bwhich state do most of our customers live in\b/i],
  ['mostCommonBrand', /\b(?:what'?s|what is) our most common brand\b/i],
  ['fewestBrand', /\bwhich brand do we have the fewest units of\b/i],
  ['mostExpiredBrand', /\bwhich brand has the most out-of-warranty units\b/i],
  ['mostCommonModel', /\b(?:what'?s|what is) the most common unit model we service\b/i],
  ['mostCommonTonnage', /\bwhat tonnage do we see most often\b/i],
  ['oldestUnitCustomer', /\bwhich customer has the oldest unit\b/i],
  ['newestUnitCustomer', /\bwho has our newest installed unit\b/i],
  ['mostDocType', /\bwhich document type do we have the most of\b/i],
  ['fewestDocType', /\bwhich document type do we have the fewest of\b/i],
  ['mostExpiredWarrantiesCustomer', /\bwhich customer has the most expired warranties\b/i],
  ['largestInvoiceCustomer', /\bwhich customer has the largest single invoice\b/i],
  ['mostInstallsYear', /\bwhich year did we install the most units\b/i],
  ['topTechByCustomers', /\bwhich technician has worked for the most different customers\b/i],
  ['busiestTechThisYear', /\bwho'?s our busiest technician this year\b/i],
  ['jobsNoTech', /\bhow many service jobs have no technician assigned\b/i],
  ['techCount', /\bhow many technicians do we have on record\b/i],
  ['listTechJobs', /\blist our technicians and how many jobs each (?:has done|they'?ve done)\b/i],
];

const NAMED_PATTERNS = [
  ['techTotalJobs', new RegExp(`\\bhow many jobs has (${NAME_RE}) done in total\\b`, 'i')],
  ['techJobsThisYear', new RegExp(`\\bhow many jobs did (${NAME_RE}) run this year\\b`, 'i')],
  ['techCustomerCount', new RegExp(`\\bhow many different customers has (${NAME_RE}) worked for\\b`, 'i')],
  ['techLastJob', new RegExp(`\\bwhen was (${NAME_RE})'s most recent job\\b`, 'i')],
];

/** Pure: question -> {kind} | {kind, name} | null. */
export function parseRanking(question) {
  const q = String(question ?? '').trim();
  if (!q) return null;
  for (const [kind, re] of NAMED_PATTERNS) {
    const m = re.exec(q);
    if (m) return { kind, name: m[1].trim() };
  }
  for (const [kind, re] of PATTERNS) if (re.test(q)) return { kind };
  return null;
}

/* ------------------------------------------------------------------ shared fetches */

async function fetchCustomers(db) {
  const { rows } = await db.raw(`SELECT id, data->>'customer_name' AS customer_name, data->>'service_address' AS service_address
                                    FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL} LIMIT 20000`);
  return rows;
}
async function fetchEquipment(db) {
  const { rows } = await db.raw(`SELECT id, customer_id, data->>'manufacturer' AS manufacturer, data->>'model' AS model,
                                         data->>'tonnage' AS tonnage, data->>'installation_date' AS installation_date, data->'warranty' AS warranty
                                    FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL AND customer_id IS NOT NULL AND ${TENANT_SQL} LIMIT 20000`);
  return rows;
}
async function fetchTechnicianRows(db, nameLike) {
  const { rows } = await db.raw(
    `SELECT t.document_id, t.value AS technician,
            (SELECT COALESCE(NULLIF(y.corrected_value, ''), y.value) FROM extractions y
              WHERE y.document_id = t.document_id AND y.field_key = 'service_date' AND y.${TENANT_SQL} ORDER BY y.created_at DESC LIMIT 1) AS service_date
       FROM extractions t
      WHERE t.field_key = 'technician' AND coalesce(t.value, '') <> '' AND t.${TENANT_SQL}
        ${nameLike ? 'AND t.value ILIKE $1' : ''}
      LIMIT 20000`,
    nameLike ? [`%${nameLike}%`] : []
  );
  return rows
    .map((r) => ({ documentId: r.document_id, technician: r.technician, date: isoDate(r.service_date) }))
    .filter((r) => r.date); // "a job" = a technician row that IS a dated service visit, same as the oracle
}

const customerNameOf = (customers, id) => customers.find((c) => c.id === id)?.customer_name ?? null;

/** A customer-superlative answer, cited to the winning customer(s). */
function citedCustomerAnswer(customers, entries, winnerNames, text, facts, basis) {
  const ids = entries.filter((e) => winnerNames.includes(e.k)).map((e) => e.id);
  const records = ids.map((id) => customers.find((c) => c.id === id)).filter(Boolean).map((c) => customerRecord(c));
  return attachCitations(answer(text, facts), { records, total: records.length, basis });
}

/* ------------------------------------------------------------------ handlers */

const HANDLERS = {
  async mostUnitsCustomer(db) {
    const [customers, equipment] = await Promise.all([fetchCustomers(db), fetchEquipment(db)]);
    const counts = new Map();
    for (const e of equipment) counts.set(e.customer_id, (counts.get(e.customer_id) ?? 0) + 1);
    const entries = [...counts.entries()].map(([id, n]) => ({ k: customerNameOf(customers, id), id, n })).filter((e) => e.k);
    const { value, winners } = topOf(entries);
    if (!value) return noAnswer('No customer has any units on file.');
    return citedCustomerAnswer(customers, entries, winners, `${namesList(winners)} ${winners.length > 1 ? 'are tied for' : 'has'} the most units on file, with ${value}.`, [{ label: 'Units', value: String(value) }], `Counted equipment per customer; the most is ${value}.`);
  },

  async mostDocumentsCustomer(db) {
    const [customers] = await Promise.all([fetchCustomers(db)]);
    const { rows } = await db.raw(
      `SELECT c.id, count(DISTINCT l.document_id)::int AS n FROM entities c
        JOIN document_entity_links l ON l.entity_id = c.id AND l.${TENANT_SQL}
       WHERE c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL} GROUP BY c.id`);
    const entries = rows.map((r) => ({ k: customerNameOf(customers, r.id), id: r.id, n: r.n })).filter((e) => e.k);
    const { value, winners } = topOf(entries);
    if (!value) return noAnswer('No customer has any documents on file.');
    return citedCustomerAnswer(customers, entries, winners, `${namesList(winners)} ${winners.length > 1 ? 'are tied for' : 'has'} the most documents on file, with ${value}.`, [{ label: 'Documents', value: String(value) }], `Counted documents linked to each customer; the most is ${value}.`);
  },

  async mostVisitsCustomer(db) {
    const customers = await fetchCustomers(db);
    const { rows } = await db.raw(
      `SELECT c.id, count(DISTINCT (l.document_id::text || COALESCE(NULLIF(y.corrected_value, ''), y.value)))::int AS n
         FROM entities c
         JOIN document_entity_links l ON l.entity_id = c.id AND l.${TENANT_SQL}
         JOIN extractions y ON y.document_id = l.document_id AND y.field_key = 'service_date' AND y.${TENANT_SQL}
        WHERE c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL} GROUP BY c.id`);
    const entries = rows.map((r) => ({ k: customerNameOf(customers, r.id), id: r.id, n: r.n })).filter((e) => e.k);
    const { value, winners } = topOf(entries);
    if (!value) return noAnswer('No customer has any service visits on file.');
    return citedCustomerAnswer(customers, entries, winners, `We've been out to ${namesList(winners)} the most, ${value} time${value === 1 ? '' : 's'}.`, [{ label: 'Visits', value: String(value) }], `Counted distinct service-visit dates per customer; the most is ${value}.`);
  },

  async mostCustomersCity(db) {
    const customers = await fetchCustomers(db);
    const entries = groupCount(customers, (c) => deriveGeo(c.service_address).city);
    const { value, winners } = topOf(entries);
    if (!value) return noAnswer('No customer has a recognizable city on file.');
    return answer(`${namesList(winners)} has the most customers, with ${value}.`, [{ label: 'Customers', value: String(value) }]);
  },

  async mostCustomersZip(db) {
    const customers = await fetchCustomers(db);
    const entries = groupCount(customers, (c) => deriveGeo(c.service_address).zip);
    const { value, winners } = topOf(entries);
    if (!value) return noAnswer('No customer has a recognizable ZIP code on file.');
    return answer(`ZIP ${namesList(winners)} has the most customers, with ${value}.`, [{ label: 'Customers', value: String(value) }]);
  },

  async mostCustomersState(db) {
    const customers = await fetchCustomers(db);
    const entries = groupCount(customers, (c) => deriveGeo(c.service_address).state);
    const { value, winners } = topOf(entries);
    if (!value) return noAnswer('No customer has a recognizable state on file.');
    return answer(`Most of our customers live in ${namesList(winners)} (${value}).`, [{ label: 'Customers', value: String(value) }]);
  },

  async mostCommonBrand(db) {
    const equipment = await fetchEquipment(db);
    const entries = groupCount(equipment, (e) => e.manufacturer?.toLowerCase() ?? null);
    const { value, winners } = topOf(entries);
    if (!value) return noAnswer('No unit has a manufacturer on file.');
    return answer(`${namesList(winners)} is our most common brand, with ${value} unit${value === 1 ? '' : 's'}.`, [{ label: 'Units', value: String(value) }]);
  },

  async fewestBrand(db) {
    const equipment = await fetchEquipment(db);
    const entries = groupCount(equipment, (e) => e.manufacturer?.toLowerCase() ?? null);
    const { value, winners } = topOf(entries, { max: false });
    if (!value) return noAnswer('No unit has a manufacturer on file.');
    return answer(`${namesList(winners)} — we have the fewest units of that brand, ${value}.`, [{ label: 'Units', value: String(value) }]);
  },

  async mostExpiredBrand(db) {
    const equipment = await fetchEquipment(db);
    const today = new Date().toISOString().slice(0, 10);
    const expired = equipment.filter((e) => warrantyStatusOf(e.warranty, today) === 'expired');
    const entries = groupCount(expired, (e) => e.manufacturer?.toLowerCase() ?? null);
    const { value, winners } = topOf(entries);
    if (!value) return noAnswer('No unit is currently out of warranty.');
    return answer(`${namesList(winners)} has the most out-of-warranty units, ${value}.`, [{ label: 'Out-of-warranty units', value: String(value) }]);
  },

  async mostCommonModel(db) {
    const equipment = await fetchEquipment(db);
    const entries = groupCount(equipment, (e) => e.model?.toUpperCase() ?? null);
    const { value, winners } = topOf(entries);
    if (!value) return noAnswer('No unit has a model on file.');
    return answer(`${namesList(winners)} is the most common unit model we service, with ${value}.`, [{ label: 'Units', value: String(value) }]);
  },

  async mostCommonTonnage(db) {
    const equipment = await fetchEquipment(db);
    const entries = groupCount(equipment, (e) => e.tonnage ?? null);
    const { value, winners } = topOf(entries);
    if (!value) return noAnswer('No unit has a tonnage on file.');
    return answer(`${namesList(winners)} is the tonnage we see most often, ${value} time${value === 1 ? '' : 's'}.`, [{ label: 'Units', value: String(value) }]);
  },

  async oldestUnitCustomer(db) {
    const [customers, equipment] = await Promise.all([fetchCustomers(db), fetchEquipment(db)]);
    const withYear = equipment.map((e) => ({ ...e, year: installYearOf(e.installation_date) })).filter((e) => e.year != null);
    if (!withYear.length) return noAnswer('No unit has an installation date on file.');
    const minYear = Math.min(...withYear.map((e) => e.year));
    const winnerIds = [...new Set(withYear.filter((e) => e.year === minYear).map((e) => e.customer_id))];
    const names = [...new Set(winnerIds.map((id) => customerNameOf(customers, id)).filter(Boolean))];
    if (!names.length) return noAnswer('No unit has an installation date on file.');
    const records = winnerIds.map((id) => customers.find((c) => c.id === id)).filter(Boolean).map((c) => customerRecord(c));
    return attachCitations(answer(`${namesList(names)} has the oldest unit on file, installed in ${minYear}.`, [{ label: 'Installed', value: String(minYear) }]), { records, total: records.length, basis: `Compared every unit's installation year; the oldest is ${minYear}.` });
  },

  async newestUnitCustomer(db) {
    const [customers, equipment] = await Promise.all([fetchCustomers(db), fetchEquipment(db)]);
    const thisYear = Number(new Date().toISOString().slice(0, 4));
    const withYear = equipment.map((e) => ({ ...e, year: installYearOf(e.installation_date) })).filter((e) => e.year != null && e.year <= thisYear);
    if (!withYear.length) return noAnswer('No unit has an installation date on file.');
    const maxYear = Math.max(...withYear.map((e) => e.year));
    const winnerIds = [...new Set(withYear.filter((e) => e.year === maxYear).map((e) => e.customer_id))];
    const names = [...new Set(winnerIds.map((id) => customerNameOf(customers, id)).filter(Boolean))];
    if (!names.length) return noAnswer('No unit has an installation date on file.');
    const records = winnerIds.map((id) => customers.find((c) => c.id === id)).filter(Boolean).map((c) => customerRecord(c));
    return attachCitations(answer(`${namesList(names)} has our newest installed unit, from ${maxYear}.`, [{ label: 'Installed', value: String(maxYear) }]), { records, total: records.length, basis: `Compared every unit's installation year (never a future one); the newest is ${maxYear}.` });
  },

  async mostDocType(db) {
    const { rows } = await db.raw(`SELECT lower(replace(document_type, '_', '-')) AS k, count(*)::int AS n FROM documents WHERE ${TENANT_SQL} GROUP BY 1`);
    const { value, winners } = topOf(rows.map((r) => ({ k: r.k, n: r.n })).filter((e) => e.k));
    if (!value) return noAnswer('No documents are on file.');
    return answer(`${namesList(winners)} is the document type we have the most of, ${value}.`, [{ label: 'Documents', value: String(value) }]);
  },

  async fewestDocType(db) {
    const { rows } = await db.raw(`SELECT lower(replace(document_type, '_', '-')) AS k, count(*)::int AS n FROM documents WHERE ${TENANT_SQL} GROUP BY 1`);
    const { value, winners } = topOf(rows.map((r) => ({ k: r.k, n: r.n })).filter((e) => e.k), { max: false });
    if (!value) return noAnswer('No documents are on file.');
    return answer(`${namesList(winners)} is the document type we have the fewest of, ${value}.`, [{ label: 'Documents', value: String(value) }]);
  },

  async mostExpiredWarrantiesCustomer(db) {
    const [customers, equipment] = await Promise.all([fetchCustomers(db), fetchEquipment(db)]);
    const today = new Date().toISOString().slice(0, 10);
    const expired = equipment.filter((e) => warrantyStatusOf(e.warranty, today) === 'expired');
    const byCust = groupCount(expired, (e) => e.customer_id);
    const entries = byCust.map((e) => ({ k: customerNameOf(customers, e.k), id: e.k, n: e.n })).filter((e) => e.k);
    const { value, winners } = topOf(entries);
    if (!value) return noAnswer('No customer currently has an expired warranty.');
    return citedCustomerAnswer(customers, entries, winners, `${namesList(winners)} has the most expired warranties, ${value}.`, [{ label: 'Expired warranties', value: String(value) }], `Counted each customer's equipment currently in 'expired' warranty status; the most is ${value}.`);
  },

  async largestInvoiceCustomer(db) {
    if (!(await financialsTableExists(db))) return noAnswer('No invoice totals have been captured yet.');
    const { rows } = await db.raw(
      `SELECT f.document_id, l.entity_id,
              (CASE WHEN f.corrections ? 'total' THEN NULLIF(f.corrections->>'total', '') ELSE f.total::text END)::numeric AS total
         FROM document_financials f
         JOIN document_entity_links l ON l.document_id = f.document_id AND l.${TENANT_SQL}
         JOIN entities c ON c.id = l.entity_id AND c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL}
        WHERE f.doc_kind = 'invoice' AND f.direction = 'receivable' AND f.${TENANT_SQL}`);
    if (!rows.length) return noAnswer('No invoice totals have been captured yet.');
    const customers = await fetchCustomers(db);
    const max = Math.max(...rows.map((r) => Number(r.total) || 0));
    const winners = [...new Set(rows.filter((r) => (Number(r.total) || 0) === max).map((r) => customerNameOf(customers, r.entity_id)).filter(Boolean))];
    const docIds = rows.filter((r) => (Number(r.total) || 0) === max).map((r) => r.document_id);
    return attachCitations(answer(`${namesList(winners)} has the largest single invoice, $${max.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`, [{ label: 'Invoice total', value: String(max) }]),
      { records: docIds.map((id) => documentRecord({ id })), total: docIds.length, basis: `Compared the total on every receivable invoice on file; the largest is $${max.toFixed(2)}.` });
  },

  async mostInstallsYear(db) {
    const equipment = await fetchEquipment(db);
    const entries = groupCount(equipment.map((e) => ({ year: installYearOf(e.installation_date) })).filter((e) => e.year != null), (e) => String(e.year));
    const { value, winners } = topOf(entries);
    if (!value) return noAnswer('No unit has an installation date on file.');
    return answer(`${namesList(winners)} is the year we installed the most units, ${value}.`, [{ label: 'Units installed', value: String(value) }]);
  },

  async techTotalJobs(db, { name }) {
    const rows = await fetchTechnicianRows(db, name);
    const n = new Set(rows.map((r) => r.documentId)).size;
    return answer(`${name} has done ${n} job${n === 1 ? '' : 's'} in total.`, [{ label: 'Jobs', value: String(n) }]);
  },

  async techJobsThisYear(db, { name }) {
    const rows = await fetchTechnicianRows(db, name);
    const year = new Date().toISOString().slice(0, 4);
    const n = new Set(rows.filter((r) => r.date.startsWith(year)).map((r) => r.documentId)).size;
    return answer(`${name} ran ${n} job${n === 1 ? '' : 's'} this year.`, [{ label: 'Jobs this year', value: String(n) }]);
  },

  async techCustomerCount(db, { name }) {
    const rows = await fetchTechnicianRows(db, name);
    if (!rows.length) return answer(`${name} isn't on record as having worked any jobs.`, [{ label: 'Customers', value: '0' }]);
    const ids = [...new Set(rows.map((r) => r.documentId))];
    const { rows: cust } = await db.raw(
      `SELECT DISTINCT c.id FROM document_entity_links l
         JOIN entities c ON c.id = l.entity_id AND c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL}
        WHERE l.document_id = ANY($1::uuid[]) AND l.${TENANT_SQL}`, [ids]);
    return answer(`${name} has worked for ${cust.length} different customer${cust.length === 1 ? '' : 's'}.`, [{ label: 'Customers', value: String(cust.length) }]);
  },

  async techLastJob(db, { name }) {
    const rows = await fetchTechnicianRows(db, name);
    const today = new Date().toISOString().slice(0, 10);
    const past = rows.filter((r) => r.date <= today).map((r) => r.date).sort().reverse();
    if (!past.length) return noAnswer(`No job on file for ${name}.`);
    return answer(`${name}'s most recent job was ${humanDate(past[0])}.`, [{ label: 'Most recent job', value: humanDate(past[0]) }]);
  },

  async topTechByCustomers(db) {
    const rows = await fetchTechnicianRows(db, null);
    const ids = [...new Set(rows.map((r) => r.documentId))];
    if (!ids.length) return noAnswer('No technician is on record.');
    const { rows: links } = await db.raw(
      `SELECT l.document_id, c.id AS customer_id FROM document_entity_links l
         JOIN entities c ON c.id = l.entity_id AND c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL}
        WHERE l.document_id = ANY($1::uuid[]) AND l.${TENANT_SQL}`, [ids]);
    const custByDoc = new Map();
    for (const l of links) { const s = custByDoc.get(l.document_id) ?? new Set(); s.add(l.customer_id); custByDoc.set(l.document_id, s); }
    const perTech = new Map();
    for (const r of rows) {
      const set = perTech.get(r.technician) ?? new Set();
      for (const cid of custByDoc.get(r.documentId) ?? []) set.add(cid);
      perTech.set(r.technician, set);
    }
    const entries = [...perTech.entries()].map(([k, set]) => ({ k, n: set.size }));
    const { value, winners } = topOf(entries);
    if (!value) return noAnswer('No technician is linked to any customer.');
    return answer(`${namesList(winners)} ${winners.length > 1 ? 'have' : 'has'} worked for the most different customers, ${value}.`, [{ label: 'Customers', value: String(value) }]);
  },

  async busiestTechThisYear(db) {
    const rows = await fetchTechnicianRows(db, null);
    const year = new Date().toISOString().slice(0, 4);
    const entries = groupCount(rows.filter((r) => r.date.startsWith(year)), (r) => r.technician, (r) => r.documentId);
    const { value, winners } = topOf(entries);
    if (!value) return noAnswer('No technician has a job on file this year.');
    return answer(`${namesList(winners)} ${winners.length > 1 ? 'are' : 'is'} our busiest technician this year, with ${value} job${value === 1 ? '' : 's'}.`, [{ label: 'Jobs this year', value: String(value) }]);
  },

  async jobsNoTech(db) {
    const { rows } = await db.raw(
      `SELECT count(DISTINCT y.document_id)::int AS n FROM extractions y
        WHERE y.field_key = 'service_date' AND y.${TENANT_SQL}
          AND NOT EXISTS (SELECT 1 FROM extractions t WHERE t.document_id = y.document_id AND t.field_key = 'technician' AND coalesce(t.value, '') <> '' AND t.${TENANT_SQL})`);
    const n = rows[0]?.n ?? 0;
    return answer(`${n} service job${n === 1 ? '' : 's'} have no technician assigned.`, [{ label: 'No technician', value: String(n) }]);
  },

  async techCount(db) {
    const rows = await fetchTechnicianRows(db, null);
    const n = new Set(rows.map((r) => r.technician.trim().toLowerCase())).size;
    return answer(`${n} technician${n === 1 ? '' : 's'} on record.`, [{ label: 'Technicians', value: String(n) }]);
  },

  async listTechJobs(db) {
    const rows = await fetchTechnicianRows(db, null);
    const entries = groupCount(rows, (r) => r.technician, (r) => r.documentId).sort((a, b) => a.k.localeCompare(b.k));
    if (!entries.length) return noAnswer('No technician is on record.');
    const text = `${entries.map((e) => `${e.k}: ${e.n}`).join('; ')}.`;
    return answer(text, entries.map((e) => ({ label: e.k, value: String(e.n) })));
  },
};

/** Groups `rows` by keyOf(row); counts distinct idOf(row) when given, else rows themselves. */
function groupCount(rows, keyOf, idOf = null) {
  const buckets = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (k == null || k === '') continue;
    const b = buckets.get(k) ?? new Set();
    b.add(idOf ? idOf(r) : b.size);
    buckets.set(k, b);
  }
  return [...buckets.entries()].map(([k, set]) => ({ k, n: set.size }));
}

/* ------------------------------------------------------------------ entry */

export async function runRanking(db, intent) {
  const fn = HANDLERS[intent.kind];
  if (!fn) return null;
  const data = await fn(db, intent);
  // A handler that already cited real rows (customer/document records) is left as-is; the rest get a
  // human basis sentence with no per-row records (a group-by-column count, not one entity's own fact).
  if (Array.isArray(data.records)) return data;
  return attachCitations(data, { records: [], total: 0, basis: `Grouped the shop's own records and read off the ${/fewest/i.test(intent.kind) ? 'minimum' : 'maximum'}.` });
}

export async function classifyAndRunRanking(db, question) {
  const intent = parseRanking(question);
  if (!intent) return null;
  return runRanking(db, intent);
}
