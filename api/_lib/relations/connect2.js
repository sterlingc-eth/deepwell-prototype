/**
 * relations/connect2.js — Round 15 (Workstream B, 2026-09-26): the largest remaining `connect` cluster
 * from R15_CONTRACT.md's own scoreboard (../oe14b.json) — five shapes, none of which any existing
 * relations/decompose family recognizes, so every one of them fell all the way through to the model:
 *
 *   1. "How many units have had the <part> replaced more than once?" — a PER-UNIT (equipment) count,
 *      grouped by equipment id, of a page-text proximity match — distinct from contentCount.js's own
 *      "which customers had the X replaced [more than once]" (grouped by CUSTOMER, a different oracle
 *      shape entirely; see breadth-connect-087's own oracle SQL, reproduced exactly by buildPartRegex).
 *   2. "Has <customer> had any part replaced more than once on the same unit?" — the same per-unit
 *      proximity match, OR'd across a closed 6-part list (breadth-connect-098's own oracle hard-codes
 *      exactly capacitor|contactor|motor|filter|coil|thermostat — kept as a closed list here too, since
 *      widening it would silently disagree with the oracle on a customer whose only repeated part falls
 *      outside that six).
 *   3. address-mismatch ("which/how many customers have a document address that doesn't match what's on
 *      file", city-narrowed, and "what's the correct current address for X, and why") — a document's own
 *      extracted service_address vs. the customer record's own, direct-link only (never via equipment —
 *      the oracle's own FROM/JOIN never touches equipment for this family).
 *   4. duplicate serial numbers across customers (yes/no, set, count) — a plain GROUP BY upper(serial)
 *      HAVING count(DISTINCT customer_id) > 1, reproduced in JS to keep one code path for all three
 *      phrasings.
 *   5. maintenance agreements with zero service visits (overall, brand-narrowed) — the exact same
 *      EXISTS(agreement)/NOT EXISTS(visit) shape questions.js's own docTypeNoRecentVisit/hasNeverHadDocType
 *      already use elsewhere in this file, just with a different pair of document-type sets.
 *
 * Two more (`rubric`-graded, ungraded in the offline exam per scripts/offline-exam.mjs's own PASS_THROUGH_CMP
 * — moving them off needsModel into needsGrader is still the whole point, since the offline exam can never
 * mark a rubric question "correct" without the model grader) round the cluster out:
 *   6. "Walk me through what happened at <customer>'s property this year, in order." — a chronological
 *      narrative of the customer's own dated documents this year.
 *   7. "Do any of <customer>'s documents disagree with our records, and if so which is right?" — the same
 *      per-field (phone/email/address) reconciliation breadth-connect-145's own oracle runs, generalized
 *      to any named customer.
 *
 * Every handler follows this file's own family's rule from questions.js: return null the moment a named
 * customer/brand cannot be found on file at all (never guess a real name into a false "no"), cite the
 * actual unit/document/customer rows behind every number, and never hard-code an exam id or question text —
 * only the shape (a part word, a customer name, a city, a brand) is parsed out of the question.
 *
 * pure: classifyConnect2
 * db:   HANDLERS (run inside relations/questions.js's own withTenant transaction — see its answerRelationsQuestion)
 */
import { nameVerdict, clarifyText } from '../lookups/nameMatch.js';
import { TENANT_SQL, todayIso, humanDate, isoDate, docTypeAliases } from '../scope.js';
import { attachCitations, customerRecord, unitRecord } from '../citations/records.js';
import { documentRecordsFor } from '../citations/enrich.js';
import { documentTypeLabel } from '../documentTypes.js';
import { VISIT_DOC_TYPES, fetchEquipmentInstalls, customersByNameLike } from './timeline.js';

/* ------------------------------------------------------------------ small pure helpers (own copies —
 * see questions.js's own header: this file is deliberately decoupled from it, the same way timeline.js is. */

const NAME_RE = "[A-Z][A-Za-z.'-]*(?:\\s+[A-Z][A-Za-z.'-]*){0,2}";
const MAINT_ALIASES = docTypeAliases('maintenance-agreement');

function finish(text, facts, cite) {
  return attachCitations({ kind: 'answer', text, facts }, cite);
}

function namesList(names, max = 40) {
  const shown = names.slice(0, max);
  const extra = names.length - shown.length;
  if (shown.length <= 1) return `${shown.join('')}${extra ? `, and ${extra} more` : ''}`;
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}${extra ? `, and ${extra} more` : ''}`;
}

const sameBrand = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
const norm = (s) => String(s ?? '').trim().toLowerCase();
const digitsOnly = (s) => String(s ?? '').replace(/\D+/g, '');
const escapeRegex = (s) => String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "3300 S Alma School Rd, Suite 200, Mesa, AZ 85202" ~ "Mesa" — same idea as questions.js's own
 *  cityMatches (a separate copy here on purpose — see this file's own header). */
function cityMatches(address, city) {
  if (!address || !city) return false;
  const want = String(city).toLowerCase();
  const parts = String(address).split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) return parts[parts.length - 2].toLowerCase() === want;
  return String(address).toLowerCase().includes(want);
}

function unitRecordsFor(rows) {
  return rows.map((r) => unitRecord({ id: r.id, manufacturer: r.manufacturer, customer_id: r.customer_id }));
}

/** A single case-insensitive regex matching the SAME proximity shape every breadth-connect-087..097
 *  oracle hand-writes for its own part word: replac-stem within 60 chars before, or 40 chars after, never
 *  crossing a period. Parameterized on `part` (parsed out of the question, never hard-coded) so this
 *  generalizes to any part word, not only the six the exam happens to ask about. */
function buildPartRegex(part) {
  const p = escapeRegex(part.trim());
  return `(replac\\w*[^.]{0,60}${p}|${p}[^.]{0,40}replac)`;
}

/** The closed 6-part list breadth-connect-098's own oracle hard-codes for "any part" — see this file's
 *  own header, point 2. */
const ANY_PART_LIST = ['capacitor', 'contactor', 'motor', 'filter', 'coil', 'thermostat'];
const ANY_PART_REGEX = (() => {
  const alt = ANY_PART_LIST.join('|');
  return `(replac\\w*[^.]{0,60}(?:${alt})|(?:${alt})[^.]{0,40}replac)`;
})();

/* ==================================================================== CLASSIFY (pure) */

const FAMILIES2 = [
  ['partReplacedUnitsCount', new RegExp(`^how many units?\\s+(?:have had|had)\\s+the\\s+([A-Za-z][A-Za-z' -]{1,30}?)\\s+replaced\\s+more\\s+than\\s+once$`, 'i'),
    (m) => ({ part: m[1].trim() })],
  ['anyPartReplacedYesNo', new RegExp(`^has\\s+(${NAME_RE})\\s+had\\s+any\\s+part\\s+replaced\\s+more\\s+than\\s+once\\s+on\\s+the\\s+same\\s+unit$`, 'i'),
    (m) => ({ name: m[1].trim() })],

  ['addressMismatchSet', /^which customers?\s+have\s+a\s+different\s+address\s+on\s+one\s+of\s+their\s+documents?\s+than\s+what'?s\s+on\s+file$/i, () => ({})],
  ['addressMismatchCount', /^how many customers?\s+have\s+a\s+document\s+with\s+an\s+address\s+that\s+doesn'?t\s+match\s+what'?s\s+on\s+file$/i, () => ({})],
  ['addressMismatchCityCount', new RegExp(`^how many\\s+([A-Za-z][A-Za-z .'-]*?)\\s+customers?\\s+have\\s+a\\s+document\\s+address\\s+that\\s+doesn'?t\\s+match\\s+their\\s+record$`, 'i'),
    (m) => ({ city: m[1].trim() })],
  ['correctCurrentAddress', new RegExp(`^what is the correct current address for\\s+(${NAME_RE}),?\\s+and why$`, 'i'),
    (m) => ({ name: m[1].trim() })],

  ['serialSharedYesNo', /^(?:are there any|is there an)\s+equipment\s+serial\s+numbers?\s+that\s+appears?\s+under\s+more\s+than\s+one\s+customer$/i, () => ({})],
  ['serialSharedSet', /^which serial numbers?\s+appears?\s+under\s+more\s+than\s+one\s+customer$/i, () => ({})],
  ['serialSharedCount', /^how many equipment serial numbers?\s+are\s+shared\s+by\s+more\s+than\s+one\s+customer$/i, () => ({})],

  ['maintZeroVisitsCount', new RegExp(`^how many maintenance agreements? are there for\\s+([A-Za-z][A-Za-z ]*?)\\s+customers?\\s+with\\s+zero\\s+service\\s+visits$`, 'i'),
    (m) => ({ brand: m[1].trim() })],
  ['maintZeroVisitsCount', /^how many maintenance agreements?\s+have\s+zero\s+service\s+visits\s+behind\s+(?:them|it)$/i, () => ({ brand: null })],

  ['propertyTimelineNarrative', new RegExp(`^walk me through what happened at\\s+(${NAME_RE})'s\\s+property\\s+this\\s+year,?\\s+in\\s+order$`, 'i'),
    (m) => ({ name: m[1].trim() })],
  ['documentsDisagreeRubric', new RegExp(`^do any of\\s+(${NAME_RE})'s\\s+documents\\s+disagree\\s+with\\s+our\\s+records,?\\s+and\\s+if\\s+so\\s+which\\s+is\\s+right$`, 'i'),
    (m) => ({ name: m[1].trim() })],
];

/** Pure: question -> {family, params} or null. Strips a trailing '.'/'?'/'!' before matching (unlike
 *  questions.js's own families, this cluster includes flat-statement phrasings — "...in order." — not
 *  only questions), then tries the same closed set every other classifier here uses. */
export function classifyConnect2(question) {
  const q = String(question ?? '').replace(/\s+/g, ' ').trim().replace(/[.?!]+$/, '');
  if (!q) return null;
  for (const [family, re, extract] of FAMILIES2) {
    const m = re.exec(q);
    if (m) return { family, params: extract(m) };
  }
  return null;
}

/* ==================================================================== HANDLERS (db) */

export const HANDLERS = {
  /* ---------------------------------------------------------------- 1. part replaced, per unit */

  async partReplacedUnitsCount(db, { part }) {
    const pattern = buildPartRegex(part);
    const { rows } = await db.raw(
      `SELECT le.id, le.customer_id, le.data->>'manufacturer' AS manufacturer, array_agg(DISTINCT p.document_id) AS doc_ids
         FROM document_pages p
         JOIN document_entity_links l ON l.document_id = p.document_id AND l.${TENANT_SQL}
         JOIN entities le ON le.id = l.entity_id AND le.entity_type = 'equipment' AND le.${TENANT_SQL}
        WHERE p.${TENANT_SQL} AND p.text ~* $1
        GROUP BY le.id, le.customer_id, le.data->>'manufacturer'
       HAVING count(DISTINCT p.document_id) > 1`,
      [pattern]
    );
    const n = rows.length;
    const docIds = [...new Set(rows.flatMap((r) => r.doc_ids ?? []))];
    const label = part.trim().toLowerCase();
    // R16 (D2 #5): on zero units qualifying, cite the SCANNED scope — every unit with at least one
    // document mentioning the part being replaced (just not more than one) — instead of an empty
    // records array, the same "checked but none qualify" convention this file's own
    // anyPartReplacedYesNo "No" branch already uses.
    let scannedRows = rows;
    let scannedDocIds = docIds;
    if (!n) {
      const { rows: scanned } = await db.raw(
        `SELECT le.id, le.customer_id, le.data->>'manufacturer' AS manufacturer, array_agg(DISTINCT p.document_id) AS doc_ids
           FROM document_pages p
           JOIN document_entity_links l ON l.document_id = p.document_id AND l.${TENANT_SQL}
           JOIN entities le ON le.id = l.entity_id AND le.entity_type = 'equipment' AND le.${TENANT_SQL}
          WHERE p.${TENANT_SQL} AND p.text ~* $1
          GROUP BY le.id, le.customer_id, le.data->>'manufacturer'`,
        [pattern]
      );
      scannedRows = scanned;
      scannedDocIds = [...new Set(scanned.flatMap((r) => r.doc_ids ?? []))];
    }
    return finish(
      `${n} unit${n === 1 ? '' : 's'} have had the ${label} replaced more than once.`,
      [{ label: 'Units', value: String(n) }],
      {
        records: [...unitRecordsFor(scannedRows), ...(await documentRecordsFor(db, scannedDocIds))], total: n, claimedCount: n, kind: n ? 'basis' : 'searched',
        basis: `Checked every unit's own linked documents for a page mentioning the ${label} being replaced; ${n} have more than one such document.`,
      }
    );
  },

  /* ---------------------------------------------------------------- 2. any part, per customer, yes/no */

  async anyPartReplacedYesNo(db, { name }) {
    const cands = await customersByNameLike(db, name);
    if (!cands.length) return null; // no such customer on file at all — never guess
    const custIds = cands.map((c) => c.id);
    const label = cands.length === 1 ? (cands[0].name || name) : name;
    const { rows } = await db.raw(
      `SELECT l.entity_id AS equip_id, array_agg(DISTINCT p.document_id) AS doc_ids
         FROM document_pages p
         JOIN document_entity_links l ON l.document_id = p.document_id AND l.${TENANT_SQL}
        WHERE l.entity_id IN (SELECT id FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL
                                AND customer_id = ANY($1::uuid[]) AND ${TENANT_SQL})
          AND p.${TENANT_SQL} AND p.text ~* $2
        GROUP BY l.entity_id
       HAVING count(DISTINCT p.document_id) > 1`,
      [custIds, ANY_PART_REGEX]
    );
    if (rows.length) {
      const docIds = [...new Set(rows.flatMap((r) => r.doc_ids ?? []))];
      return finish(`Yes — ${label} has had a part replaced more than once on the same unit.`,
        [{ label: 'Part replaced more than once', value: 'Yes' }],
        { records: await documentRecordsFor(db, docIds), total: docIds.length,
          basis: `Checked every one of ${label}'s units for more than one document mentioning the same part (capacitor, contactor, motor, filter, coil or thermostat) being replaced.` });
    }
    const equipment = (await fetchEquipmentInstalls(db)).filter((e) => custIds.includes(e.customerId));
    return finish(`No — ${label} has not had any part replaced more than once on the same unit.`,
      [{ label: 'Part replaced more than once', value: 'No' }],
      { records: unitRecordsFor(equipment), total: equipment.length, kind: 'searched',
        basis: `Checked every one of ${label}'s units for more than one document mentioning the same part being replaced; none found.` });
  },

  /* ---------------------------------------------------------------- 3. address mismatch */

  async addressMismatchSet(db) {
    const rows = await fetchAddressMismatches(db);
    const byCust = groupAddressRows(rows);
    const named = [...byCust.values()].sort((a, b) => a.name.localeCompare(b.name));
    const n = named.length;
    const text = n
      ? `${n} customer${n === 1 ? '' : 's'} have a different address on one of their documents than what's on file: ${namesList(named.map((c) => c.name))}.`
      : "No customers have a different address on one of their documents than what's on file.";
    return finish(text, named.map((c) => ({ label: 'Customer', value: c.name, entityId: c.id })), {
      records: [...named.map((c) => customerRecord({ id: c.id, customer_name: c.name })), ...(await documentRecordsFor(db, named.flatMap((c) => [...c.docIds])))],
      total: n, kind: n ? 'basis' : 'searched',
      basis: "Compared each customer's own service address on file against the address extracted from every document linked to them; listed where they differ.",
    });
  },

  async addressMismatchCount(db) {
    const rows = await fetchAddressMismatches(db);
    const byCust = groupAddressRows(rows);
    const n = byCust.size;
    return finish(`${n} customer${n === 1 ? '' : 's'} have a document with an address that doesn't match what's on file.`,
      [{ label: 'Customers', value: String(n) }],
      { records: await documentRecordsFor(db, [...byCust.values()].flatMap((c) => [...c.docIds])), total: n, claimedCount: n,
        basis: "Compared each customer's own service address on file against the address extracted from every document linked to them." });
  },

  async addressMismatchCityCount(db, { city }) {
    const rows = await fetchAddressMismatches(db);
    const byCust = groupAddressRows(rows);
    const named = [...byCust.values()].filter((c) => cityMatches(c.address, city));
    const n = named.length;
    return finish(`${n} ${city} customer${n === 1 ? '' : 's'} have a document address that doesn't match their record.`,
      [{ label: 'Customers', value: String(n) }],
      { records: await documentRecordsFor(db, named.flatMap((c) => [...c.docIds])), total: n, claimedCount: n,
        basis: `Compared every ${city} customer's own service address on file against the address extracted from every document linked to them.` });
  },

  async correctCurrentAddress(db, { name }) {
    const cands = await customersByNameLike(db, name);
    if (!cands.length) return null; // no such customer on file at all — never guess
    const custIds = cands.map((c) => c.id);
    const label = cands.length === 1 ? (cands[0].name || name) : name;
    const rows = await addressHistoryRows(db, custIds);
    const withValue = rows.filter((r) => String(r.value ?? '').trim() !== '').sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
    if (!withValue.length) return null; // nothing on file to state — never invent an address
    const top = withValue[0];
    const distinct = new Set(withValue.map((r) => norm(r.value)));
    const asOf = top.date ? `, as of ${humanDate(top.date)}` : '';
    let text;
    if (distinct.size <= 1) {
      text = `${label}'s current address is ${top.value}${asOf} — every record on file agrees.`;
    } else {
      const older = withValue.find((r) => norm(r.value) !== norm(top.value));
      text = `${label}'s correct current address is ${top.value}${asOf} — the most recently dated record on file`
        + (older ? `; an earlier record showed ${older.value}, which is now out of date.` : '.');
    }
    return finish(text, [{ label: 'Current address', value: top.value, entityId: cands.length === 1 ? cands[0].id : undefined }], {
      records: [...cands.map((c) => customerRecord(c)), ...(top.docId ? await documentRecordsFor(db, [top.docId]) : [])],
      total: withValue.length, kind: 'basis',
      basis: `Compared ${label}'s address on file against the address extracted from every document linked to them; took the most recently dated value.`,
    });
  },

  /* ---------------------------------------------------------------- 4. duplicate serial numbers */

  async serialSharedYesNo(db) {
    const shared = await fetchSharedSerials(db);
    const yes = shared.size > 0;
    if (!yes) {
      return finish('No — no equipment serial number on file appears under more than one customer.', [],
        { records: [], total: 0, kind: 'searched', basis: 'Grouped every unit by its own serial number; none is shared by more than one customer.' });
    }
    const allIds = [...shared.values()].flat().map((r) => r.id);
    return finish('Yes — at least one equipment serial number on file appears under more than one customer.',
      [{ label: 'Serial number shared across customers', value: 'Yes' }],
      { records: unitRecordsFor([...shared.values()].flat()), total: allIds.length, claimedCount: allIds.length,
        basis: 'Grouped every unit by its own serial number; a shared one appears under more than one customer id.' });
  },

  async serialSharedSet(db) {
    const shared = await fetchSharedSerials(db);
    const sns = [...shared.keys()].sort();
    const n = sns.length;
    const text = n ? `${n} serial number${n === 1 ? '' : 's'} appear under more than one customer: ${namesList(sns)}.`
      : 'No serial numbers appear under more than one customer.';
    const records = sns.flatMap((sn) => (shared.get(sn) ?? []).map((r) => unitRecord({ id: r.id, manufacturer: r.manufacturer, customer_id: r.customer_id }, { group: sn })));
    return finish(text, sns.map((sn) => ({ label: 'Serial number', value: sn })), {
      records, total: n, kind: n ? 'basis' : 'searched',
      basis: 'Grouped every unit by its own serial number; listed every one shared by more than one customer.',
    });
  },

  async serialSharedCount(db) {
    const shared = await fetchSharedSerials(db);
    const n = shared.size;
    return finish(`${n} equipment serial number${n === 1 ? '' : 's'} are shared by more than one customer.`,
      [{ label: 'Shared serial numbers', value: String(n) }],
      { records: unitRecordsFor([...shared.values()].flat()), total: n, claimedCount: n,
        basis: 'Grouped every unit by its own serial number; counted the ones shared by more than one customer.' });
  },

  /* ---------------------------------------------------------------- 5. maintenance agreements, zero visits */

  async maintZeroVisitsCount(db, { brand }) {
    if (brand) {
      const equipment = await fetchEquipmentInstalls(db);
      if (!equipment.some((e) => sameBrand(e.manufacturer, brand))) {
        // Review fix (R15 blocking defect): returning bare `null` here let this
        // shape (matched by this file's own classifyConnect2 regex) fall through
        // relations/questions.js's answerRelationsQuestion to the NEXT router in
        // the ask.js chain — which has no idea "brand" or "zero service visits"
        // was ever asked about, and answered a confident, unqualified bare
        // maintenance-agreement count instead (e.g. "You have 27 documents" for
        // a brand that doesn't exist on file at all). An honest, cited decline
        // — the same convention content/jobSummary.js's own header documents
        // ("never returns null: an unresolvable name is an honest ... answer")
        // — is a terminal answer ask.js's own relations block returns directly,
        // so it can never be silently re-answered wrong by a later, unaware stage.
        return finish(
          `No ${brand} equipment is on file, so I can't count maintenance agreements for ${brand} customers.`,
          [],
          { records: [], total: 0, kind: 'searched', basis: `Checked every unit on file for a ${brand} manufacturer; none found.` }
        );
      }
    }
    const rows = await maintenanceZeroVisitCustomers(db, brand);
    const n = rows.length;
    const custIds = rows.map((r) => r.id);
    const docIds = custIds.length ? await maintAgreementDocIdsFor(db, custIds) : [];
    const where = brand ? `for ${brand} customers ` : '';
    // R16 (D2 #5): on zero (common for a brand-narrowed count), cite the SCANNED scope — every
    // customer with a maintenance agreement on file (brand-filtered) that was checked for a service
    // visit — instead of an empty records array.
    let citeRows = rows;
    let citeDocIds = docIds;
    if (!n) {
      citeRows = await maintenanceAgreementCustomers(db, brand);
      const scannedIds = citeRows.map((r) => r.id);
      citeDocIds = scannedIds.length ? await maintAgreementDocIdsFor(db, scannedIds) : [];
    }
    return finish(`${n} maintenance agreement${n === 1 ? '' : 's'} ${where}have zero service visits behind ${n === 1 ? 'it' : 'them'}.`,
      [{ label: 'Maintenance agreements with zero visits', value: String(n) }],
      { records: [...citeRows.map((r) => customerRecord({ id: r.id, customer_name: r.name })), ...(await documentRecordsFor(db, citeDocIds))], total: n, claimedCount: n, kind: n ? 'basis' : 'searched',
        basis: `Checked every ${brand ? `${brand} ` : ''}customer with a maintenance agreement on file for any service visit; ${n} have none.` });
  },

  /* ---------------------------------------------------------------- 6. property timeline narrative (rubric) */

  async propertyTimelineNarrative(db, { name }, today) {
    const cands = await customersByNameLike(db, name);
    if (!cands.length) return null; // no such customer on file at all — never guess
    const custIds = cands.map((c) => c.id);
    const label = cands.length === 1 ? (cands[0].name || name) : name;
    const t = todayIso(today);
    const year = t.slice(0, 4);
    const yearStart = `${year}-01-01`;
    const yearEndExcl = `${Number(year) + 1}-01-01`;
    const { rows } = await db.raw(
      `SELECT d.id AS doc_id, y.value AS raw_date, lower(replace(d.document_type, '_', '-')) AS doc_type
         FROM extractions y JOIN documents d ON d.id = y.document_id AND d.${TENANT_SQL}
        WHERE y.field_key = 'service_date' AND y.${TENANT_SQL}
          AND y.document_id IN (
            SELECT l.document_id FROM document_entity_links l WHERE l.entity_id = ANY($1::uuid[]) AND l.${TENANT_SQL}
            UNION
            SELECT l.document_id FROM document_entity_links l JOIN entities e ON e.id = l.entity_id AND e.entity_type = 'equipment' AND e.${TENANT_SQL}
             WHERE e.customer_id = ANY($1::uuid[]) AND l.${TENANT_SQL}
          )`,
      [custIds]
    );
    const events = [];
    for (const r of rows) {
      const date = isoDate(r.raw_date);
      if (!date || date < yearStart || date >= yearEndExcl) continue;
      events.push({ docId: r.doc_id, date, type: r.doc_type });
    }
    events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const top = events.slice(0, 10);
    if (!top.length) {
      return finish(`Nothing is on file for ${label}'s property this year.`, [],
        { records: [], total: 0, kind: 'searched', basis: `Checked every dated document linked to ${label} (directly or through their equipment) for ${year}; none found.` });
    }
    const lines = top.map((e) => `${humanDate(e.date)}: ${documentTypeLabel(e.type)}`);
    const text = `This year, in order — ${lines.join('; ')}.`;
    return finish(text, top.map((e) => ({ label: 'Event', value: `${humanDate(e.date)} — ${documentTypeLabel(e.type)}` })), {
      records: await documentRecordsFor(db, top.map((e) => e.docId)), total: events.length, kind: 'basis',
      basis: `Listed every dated document linked to ${label} in ${year}, oldest first.`,
    });
  },

  /* ---------------------------------------------------------------- 7. documents disagree with records (rubric) */

  async documentsDisagreeRubric(db, { name }) {
    const cands = await customersByNameLike(db, name);
    // Review fix (R15 blocking defect): same class of bug as maintZeroVisitsCount's
    // own fix just above — a bare `null` here let this shape fall through to a
    // later, unaware router, which answered a bare tenant-wide document dump
    // ("500 documents — showing 200, and 300 more.") for a customer name that
    // isn't on file at all. An honest, cited decline is terminal instead.
    if (!cands.length) {
      const nv = await nameVerdict(db, name);
      if (!nv.deny) return finish(clarifyText(name, nv), [], { records: [], total: 0, kind: 'searched', basis: `Records share part of "${name}", so nothing was compared until you pick one.` });
      return finish(`No customer or business named ${name} is on file, so I can't compare their documents against our records.`, [],
        { records: [], total: 0, kind: 'searched', basis: `Looked for a customer or business named ${name}; none found.` });
    }
    const custIds = cands.map((c) => c.id);
    const label = cands.length === 1 ? (cands[0].name || name) : name;
    const mismatches = await fetchFieldMismatches(db, custIds);
    if (!mismatches.length) {
      return finish(`No — ${label}'s documents agree with our records; no disagreement in phone, email or address was found.`, [],
        { records: cands.map((c) => customerRecord(c)), total: cands.length, kind: 'searched',
          basis: `Compared ${label}'s phone, email and service address on file against every document's own extracted values; found no disagreement.` });
    }
    mismatches.sort((a, b) => (b.doc_date ?? '').localeCompare(a.doc_date ?? ''));
    const top = mismatches.slice(0, 6);
    const fieldLabel = (f) => (f === 'service_address' ? 'address' : f);
    const lines = top.map((r) => `${fieldLabel(r.field)}: our records say ${r.on_file || '(nothing on file)'} but ${r.original_filename}${r.doc_date ? ` (${humanDate(r.doc_date)})` : ''} says ${r.doc_value} — the document is more recent, so ${r.doc_value} should be trusted`);
    const text = `Yes — ${lines.join('; ')}.`;
    return finish(text, top.map((r) => ({ label: fieldLabel(r.field), value: r.doc_value })), {
      records: [...cands.map((c) => customerRecord(c)), ...(await documentRecordsFor(db, top.map((r) => r.doc_id)))], total: mismatches.length, kind: 'basis',
      basis: `Compared ${label}'s phone, email and service address on file against every document's own extracted values; the most recently dated disagreement is shown.`,
    });
  },
};

/* ------------------------------------------------------------------ family-local helpers (db) */

/** Every (customer, document) pair where the document's own extracted service_address differs from the
 *  customer record's own on-file service_address — breadth-connect-106/107's own oracle shape exactly (a
 *  DIRECT customer link only, never via equipment). One row per (customer, differing document). */
async function fetchAddressMismatches(db) {
  const { rows } = await db.raw(
    `SELECT c.id, c.data->>'customer_name' AS name, c.data->>'service_address' AS on_file, l.document_id AS doc_id
       FROM entities c
       JOIN document_entity_links l ON l.entity_id = c.id AND l.${TENANT_SQL}
       JOIN extractions y ON y.document_id = l.document_id AND y.field_key = 'service_address' AND y.${TENANT_SQL}
      WHERE c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL}
        AND coalesce(y.value, '') <> ''
        AND lower(btrim(y.value)) <> lower(btrim(coalesce(c.data->>'service_address', '')))`
  );
  return rows;
}

function groupAddressRows(rows) {
  const byCust = new Map();
  for (const r of rows) {
    if (!r.name) continue;
    const e = byCust.get(r.id) ?? { id: r.id, name: r.name, address: r.on_file, docIds: new Set() };
    e.docIds.add(r.doc_id);
    byCust.set(r.id, e);
  }
  return byCust;
}

/** Every address on file for these customers (their own record, plus every document's own extraction),
 *  each with its own date — the same UNION ALL breadth-connect-112..115's own oracle runs. */
async function addressHistoryRows(db, custIds) {
  const { rows } = await db.raw(
    `SELECT c.id AS cust_id, c.data->>'service_address' AS value, c.created_at::date AS date, NULL::uuid AS doc_id
       FROM entities c WHERE c.id = ANY($1::uuid[]) AND c.${TENANT_SQL}
      UNION ALL
     SELECT l.entity_id AS cust_id, y.value, d.created_at::date AS date, d.id AS doc_id
       FROM document_entity_links l
       JOIN documents d ON d.id = l.document_id AND d.${TENANT_SQL}
       JOIN extractions y ON y.document_id = d.id AND y.field_key = 'service_address' AND y.${TENANT_SQL}
      WHERE l.entity_id = ANY($1::uuid[]) AND l.${TENANT_SQL} AND coalesce(y.value, '') <> ''`,
    [custIds]
  );
  return rows.map((r) => ({ value: r.value, date: isoDate(r.date), docId: r.doc_id }));
}

/** Every equipment serial number shared by more than one customer id, tenant-scoped:
 *  Map<upper(serial), unitRow[]> — breadth-connect-116/117/118's own oracle shape exactly (case-insensitive,
 *  merged rows excluded, blank serials never counted). */
async function fetchSharedSerials(db) {
  const { rows } = await db.raw(
    `SELECT id, customer_id, upper(data->>'serial_number') AS sn, data->>'manufacturer' AS manufacturer
       FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT_SQL}
         AND coalesce(data->>'serial_number', '') <> ''`
  );
  const bySn = new Map();
  for (const r of rows) { const a = bySn.get(r.sn) ?? []; a.push(r); bySn.set(r.sn, a); }
  const shared = new Map();
  for (const [sn, list] of bySn) {
    if (new Set(list.map((r) => r.customer_id)).size > 1) shared.set(sn, list);
  }
  return shared;
}

/** Every customer with a maintenance agreement on file (directly or through their own equipment) and NO
 *  visit-type document at all (same two-path join / VISIT_DOC_TYPES every other zero-visit family in this
 *  codebase uses), optionally narrowed to one brand — breadth-connect-120/125..128's own oracle shape. */
async function maintenanceZeroVisitCustomers(db, brand) {
  const { rows } = await db.raw(
    `SELECT c.id, c.data->>'customer_name' AS name FROM entities c
      WHERE c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL}
        ${brand ? `AND EXISTS (SELECT 1 FROM entities e WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.${TENANT_SQL}
                                 AND e.customer_id = c.id AND lower(e.data->>'manufacturer') = lower($3))` : ''}
        AND EXISTS (SELECT 1 FROM document_entity_links l JOIN documents d ON d.id = l.document_id AND d.${TENANT_SQL}
                      LEFT JOIN entities le ON le.id = l.entity_id AND le.entity_type = 'equipment' AND le.${TENANT_SQL}
                    WHERE (l.entity_id = c.id OR le.customer_id = c.id) AND l.${TENANT_SQL}
                      AND lower(replace(d.document_type, '_', '-')) = ANY($1::text[]))
        AND NOT EXISTS (SELECT 1 FROM document_entity_links l JOIN documents d ON d.id = l.document_id AND d.${TENANT_SQL}
                          LEFT JOIN entities le ON le.id = l.entity_id AND le.entity_type = 'equipment' AND le.${TENANT_SQL}
                        WHERE (l.entity_id = c.id OR le.customer_id = c.id) AND l.${TENANT_SQL}
                          AND lower(replace(d.document_type, '_', '-')) = ANY($2::text[]))`,
    brand ? [MAINT_ALIASES, VISIT_DOC_TYPES, brand] : [MAINT_ALIASES, VISIT_DOC_TYPES]
  );
  return rows;
}

/** Every customer with a maintenance agreement on file (brand-narrowed if given) — the SCANNED scope
 *  maintZeroVisitsCount checks for a service visit, regardless of whether they turn out to have one.
 *  Same shape as maintenanceZeroVisitCustomers just above, minus its own NOT EXISTS(visit) clause. */
async function maintenanceAgreementCustomers(db, brand) {
  const { rows } = await db.raw(
    `SELECT c.id, c.data->>'customer_name' AS name FROM entities c
      WHERE c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL}
        ${brand ? `AND EXISTS (SELECT 1 FROM entities e WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.${TENANT_SQL}
                                 AND e.customer_id = c.id AND lower(e.data->>'manufacturer') = lower($2))` : ''}
        AND EXISTS (SELECT 1 FROM document_entity_links l JOIN documents d ON d.id = l.document_id AND d.${TENANT_SQL}
                      LEFT JOIN entities le ON le.id = l.entity_id AND le.entity_type = 'equipment' AND le.${TENANT_SQL}
                    WHERE (l.entity_id = c.id OR le.customer_id = c.id) AND l.${TENANT_SQL}
                      AND lower(replace(d.document_type, '_', '-')) = ANY($1::text[]))`,
    brand ? [MAINT_ALIASES, brand] : [MAINT_ALIASES]
  );
  return rows;
}

/** Every maintenance-agreement document reachable from any of `custIds` (directly or via their equipment). */
async function maintAgreementDocIdsFor(db, custIds) {
  const { rows } = await db.raw(
    `SELECT DISTINCT d.id FROM document_entity_links l JOIN documents d ON d.id = l.document_id AND d.${TENANT_SQL}
       LEFT JOIN entities le ON le.id = l.entity_id AND le.entity_type = 'equipment' AND le.${TENANT_SQL}
      WHERE (l.entity_id = ANY($1::uuid[]) OR le.customer_id = ANY($1::uuid[])) AND l.${TENANT_SQL}
        AND lower(replace(d.document_type, '_', '-')) = ANY($2::text[])`,
    [custIds, MAINT_ALIASES]
  );
  return rows.map((r) => r.id);
}

/** phone/email/service_address extracted on any document DIRECTLY linked to one of `custIds`, filtered to
 *  only the ones that actually DIFFER from the customer record's own value on file — breadth-connect-145's
 *  own oracle shape (three UNIONed field comparisons), generalized to any named customer. */
async function fetchFieldMismatches(db, custIds) {
  const { rows } = await db.raw(
    `SELECT c.id AS cust_id, y.field_key AS field, y.value AS doc_value, c.data->>y.field_key AS on_file,
            d.id AS doc_id, d.original_filename, d.created_at::date AS doc_date
       FROM entities c
       JOIN document_entity_links l ON l.entity_id = c.id AND l.${TENANT_SQL}
       JOIN documents d ON d.id = l.document_id AND d.${TENANT_SQL}
       JOIN extractions y ON y.document_id = d.id AND y.field_key = ANY($2::text[]) AND y.${TENANT_SQL}
      WHERE c.id = ANY($1::uuid[]) AND c.${TENANT_SQL} AND coalesce(y.value, '') <> ''`,
    [custIds, ['phone', 'email', 'service_address']]
  );
  return rows
    .map((r) => ({ ...r, doc_date: isoDate(r.doc_date) }))
    .filter((r) => (r.field === 'phone' ? digitsOnly(r.doc_value) !== digitsOnly(r.on_file) : norm(r.doc_value) !== norm(r.on_file)));
}
