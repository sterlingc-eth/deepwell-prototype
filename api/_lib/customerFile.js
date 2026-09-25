/**
 * "What do we have on file for <customer>?" and "any notes on the <Name> unit?" (Team A, 2026-09-24).
 *
 * Scorecard: "what do we have on file for donald holbrook" answered with the contact card only (phone + address). An
 * owner asking for a customer's file wants the whole picture: contact, units, documents by type with the latest date,
 * the last service visit, open reminders and warranty status — every item cited to a document where one exists.
 * "Notes on the Rios unit" wants the notes and findings the technicians wrote down, gathered from that customer's own
 * documents, not a serial number and one visit.
 *
 * Deterministic: SQL over the customer's own documents (direct links, unit links, address matches), no model call.
 *
 * pure: buildFileSummary, buildNotesAnswer      db: fetchFileData, fetchNotes
 */
import { documentTypeLabel } from './documentTypes.js';
import { listOpenReminders } from './reminders.js';
import { warrantyStatusOf } from './analytics.js';
import {
  TENANT_SQL, isoDate, todayIso, humanDate, splitFuture, futureNote, fetchVisits, scopeDocumentIds, scopeFromCustomers,
  normalizeTypeId, answerEnvelope, describeVisit,
} from './scope.js';

/** Every document id owned by one customer or its units, plus name+address matches (the customer profile's own union). */
async function documentIdsFor(db, customerRow) {
  const scope = await scopeFromCustomers(db, [customerRow]);
  const ids = new Set(await scopeDocumentIds(db, scope));
  try {
    const name = customerRow.customer_name;
    const address = customerRow.service_address;
    if (name && address) for (const r of await db.listNameMatchedDocuments(name, address)) ids.add(r.document_id);
  } catch { /* the name-match union is an enrichment, never load-bearing */ }
  return { ids: [...ids], scope };
}

/* ------------------------------------------------------------------ file summary */

/**
 * @returns {Promise<{units: object[], docs: object[], visits: object[], reminders: object[], agreementTerm: string|null}>}
 */
export async function fetchFileData(db, customerRow) {
  const { ids, scope } = await documentIdsFor(db, customerRow);
  let units = [];
  try { units = await db.listCustomerEquipment(customerRow.id); } catch { units = []; }
  let docs = [];
  if (ids.length) {
    const { rows } = await db.raw(
      `SELECT d.id, d.document_type, d.original_filename, d.created_at,
              (SELECT COALESCE(NULLIF(x.corrected_value, ''), x.value) FROM extractions x
                WHERE x.document_id = d.id AND x.field_key = 'service_date' AND x.${TENANT_SQL}
                ORDER BY x.created_at DESC LIMIT 1) AS service_date
         FROM documents d WHERE d.id = ANY($1::uuid[]) AND d.${TENANT_SQL} LIMIT 1000`,
      [ids]);
    docs = rows;
  }
  const visits = ids.length ? await fetchVisits(db, ids) : [];
  let reminders = [];
  try { reminders = await listOpenReminders(db, { customerId: customerRow.id }); } catch { reminders = []; }
  let agreementTerm = null;
  const agreementDoc = docs.find((d) => normalizeTypeId(d.document_type) === 'maintenance-agreement');
  if (agreementDoc) {
    const { rows } = await db.raw(
      `SELECT COALESCE(NULLIF(corrected_value, ''), value) AS v FROM extractions
        WHERE document_id = $1 AND field_key = 'agreement_term' AND ${TENANT_SQL} ORDER BY created_at DESC LIMIT 1`,
      [agreementDoc.id]);
    agreementTerm = rows[0]?.v ?? null;
  }
  return { units, docs, visits, reminders, agreementTerm, scope };
}

const pluralType = (label, n) => (n === 1 ? label.toLowerCase() : `${label.toLowerCase()}${/s$/i.test(label) ? '' : 's'}`);

/**
 * Pure: extra text + facts to append to a customer's contact card. Every fact that comes from a document cites it.
 * @param {object} row  the customer row ({id, customer_name, ...})
 * @param {object} data fetchFileData's result
 */
export function buildFileSummary(row, data, today) {
  const t = todayIso(today);
  const facts = [];
  const lines = [];

  // Documents by type, newest date per type (service date when there is one, else upload date).
  const byType = new Map();
  for (const d of data.docs) {
    const id = normalizeTypeId(d.document_type);
    const date = isoDate(d.service_date) ?? isoDate(d.created_at instanceof Date ? d.created_at.toISOString() : d.created_at);
    const cur = byType.get(id) ?? { id, count: 0, latest: null, latestDoc: null };
    cur.count += 1;
    if (date && (!cur.latest || date > cur.latest) && date <= t) { cur.latest = date; cur.latestDoc = d.id; }
    if (!cur.latestDoc) cur.latestDoc = d.id;
    byType.set(id, cur);
  }
  const types = [...byType.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  if (data.docs.length) {
    const parts = types.map((x) => `${x.count} ${pluralType(documentTypeLabel(x.id), x.count)}`);
    lines.push(`${data.docs.length} document${data.docs.length === 1 ? '' : 's'} on file (${parts.join(', ')}).`);
    for (const x of types) {
      facts.push({
        label: documentTypeLabel(x.id),
        value: `${x.count}${x.latest ? ` · latest ${humanDate(x.latest)}` : ''}`,
        sources: x.latestDoc ? [{ documentId: x.latestDoc, location: { field: 'document' } }] : [],
      });
    }
  } else {
    lines.push('No documents are linked to this customer yet.');
  }

  // Last service visit (never a future-dated one).
  const { past, future } = splitFuture(data.visits, t);
  if (past.length) {
    const v = past[0];
    lines.push(`Last service visit: ${humanDate(v.date)} (${describeVisit(v)}); ${past.length} visit${past.length === 1 ? '' : 's'} on file.`);
    facts.push({ label: 'Last service visit', value: `${humanDate(v.date)} · ${describeVisit(v)}`, sources: [{ documentId: v.documentId, location: { field: 'service_date' } }] });
    facts.push({ label: 'Visits on file', value: String(past.length), sources: past.slice(0, 5).map((p) => ({ documentId: p.documentId, location: { field: 'service_date' } })) });
  } else {
    lines.push('No service visits on file.');
  }
  const fut = futureNote(future, t).trim();
  if (fut) lines.push(fut);

  // Warranty status across units.
  if (data.units.length) {
    const tally = { active: 0, expiring: 0, expired: 0, unknown: 0 };
    for (const u of data.units) tally[warrantyStatusOf(u.warranty, t)] += 1;
    const parts = Object.entries(tally).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`);
    lines.push(`Warranty: ${parts.join(', ')}.`);
    facts.push({ label: 'Warranty status', value: parts.join(', '), sources: [] });
  }

  if (data.agreementTerm || types.some((x) => x.id === 'maintenance-agreement')) {
    const doc = types.find((x) => x.id === 'maintenance-agreement');
    lines.push(`Maintenance agreement on file${data.agreementTerm ? ` (${data.agreementTerm})` : ''}.`);
    facts.push({
      label: 'Maintenance agreement', value: data.agreementTerm ?? 'on file',
      sources: doc?.latestDoc ? [{ documentId: doc.latestDoc, location: { field: 'agreement_term' } }] : [],
    });
  }

  if (data.reminders.length) {
    lines.push(`${data.reminders.length} open reminder${data.reminders.length === 1 ? '' : 's'}: ${data.reminders.map((r) => r.reminderText).join('; ')}`);
    for (const r of data.reminders) {
      facts.push({
        label: r.reminderTrigger === 'next_visit' ? 'Reminder (next visit)' : 'Reminder', value: r.reminderText,
        sources: r.documentId ? [{ documentId: r.documentId, location: {} }] : [],
      });
    }
  } else {
    lines.push('No open reminders.');
  }
  return { lines, facts };
}

/** Append the file summary to an already-built contact answer (facts first: contact, units, then the file). */
export function attachFileSummary(answer, row, data, today) {
  const { lines, facts } = buildFileSummary(row, data, today);
  const text = [answer.text, ...lines].filter(Boolean).join('\n');
  const sources = [...new Map([...(answer.sources ?? []), ...facts.flatMap((f) => f.sources ?? [])].map((s) => [s.documentId, s])).values()];
  return {
    ...answer, text, facts: [...answer.facts, ...facts], sources,
    verifiedCount: (answer.verifiedCount ?? 0) + facts.filter((f) => f.sources?.length).length,
  };
}

/* ------------------------------------------------------------------ notes on a unit */

/** Note-bearing fields, in priority order. */
const NOTE_KEYS = ['notes', 'work_performed', 'status'];
const MAX_NOTES = 25;

/**
 * Notes and findings from the customer's own documents: the `notes` extractions (chronological, newest first BY
 * SERVICE DATE - never upload order, which can differ when documents are batch-scanned later), the work performed
 * on each visit, and any open reminders. Passage excerpts that mention findings/recommendations fill in when the
 * structured fields are thin. Round 5 (R5_FAILS.md #3): a future-dated note or work-performed row (a typo'd year,
 * a scheduled-but-not-yet-done visit) is excluded from "most recent" and called out, the same rule buildFileSummary
 * already applies to visits — never a second, disagreeing definition of "most recent" in this file.
 */
export async function fetchNotes(db, customerRows, today) {
  const t = todayIso(today);
  const scope = await scopeFromCustomers(db, customerRows);
  const ids = await scopeDocumentIds(db, scope);
  if (!ids.length) return { ids, notes: [], work: [], passages: [], reminders: [], future: [], scope };
  const { rows } = await db.raw(
    `SELECT x.document_id, x.field_key, COALESCE(NULLIF(x.corrected_value, ''), x.value) AS value, d.document_type,
            d.original_filename, d.created_at,
            (SELECT COALESCE(NULLIF(s.corrected_value, ''), s.value) FROM extractions s
              WHERE s.document_id = x.document_id AND s.field_key = 'service_date' AND s.${TENANT_SQL}
              ORDER BY s.created_at DESC LIMIT 1) AS service_date
       FROM extractions x JOIN documents d ON d.id = x.document_id
      WHERE x.document_id = ANY($1::uuid[]) AND x.field_key = ANY($2::text[]) AND x.${TENANT_SQL}
        AND coalesce(x.value, '') <> ''
      ORDER BY d.created_at DESC
      LIMIT 300`,
    [ids, NOTE_KEYS]);
  const dateOf = (r) => isoDate(r.service_date) ?? isoDate(r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at);
  const notesAll = rows.filter((r) => r.field_key === 'notes').map((r) => ({ documentId: r.document_id, text: r.value, date: dateOf(r), type: r.document_type }));
  const workByDoc = new Map();
  for (const r of rows.filter((x) => x.field_key === 'work_performed')) {
    const w = workByDoc.get(r.document_id) ?? { documentId: r.document_id, items: [], date: dateOf(r), type: r.document_type };
    w.items.push(r.value);
    workByDoc.set(r.document_id, w);
  }
  // splitFuture also sorts `past` newest-first by date (scope.js) - the one chronology this file uses.
  const notesSplit = splitFuture(notesAll, t);
  const workSplit = splitFuture([...workByDoc.values()], t);
  const notes = notesSplit.past;
  const work = workSplit.past;
  const future = [...notesSplit.future, ...workSplit.future];

  let passages = [];
  if (notes.length + work.length < 3) {
    try {
      const found = await db.searchPassages('notes findings observations recommended recommendation condition issue', 6, { documentIds: ids });
      passages = found.map((p) => ({ documentId: p.document_id, page: p.page_no, excerpt: String(p.excerpt ?? '').replace(/\s+/g, ' ').slice(0, 280), type: p.document_type }));
    } catch { passages = []; }
  }
  let reminders = [];
  try {
    for (const c of customerRows) reminders = reminders.concat(await listOpenReminders(db, { customerId: c.id }));
  } catch { reminders = []; }
  return { ids, notes, work, passages, reminders, future, scope };
}

/** Pure: the notes answer. `label` is the phrase the user typed ("Rios unit"). `today` should be the same value
 *  passed to fetchNotes, so the future-dated note it excluded and the date this text states agree. */
export function buildNotesAnswer(label, customerRows, data, today) {
  const name = customerRows.length === 1 ? (customerRows[0].customer_name || label) : label;
  const facts = [];
  for (const n of data.notes.slice(0, MAX_NOTES)) {
    facts.push({
      label: `Note${n.date ? ` · ${humanDate(n.date)}` : ''} · ${documentTypeLabel(normalizeTypeId(n.type)).toLowerCase()}`,
      value: n.text, sources: [{ documentId: n.documentId, location: { field: 'notes' } }],
    });
  }
  for (const w of data.work.slice(0, 8)) {
    facts.push({
      label: `Work performed${w.date ? ` · ${humanDate(w.date)}` : ''}`,
      value: w.items.slice(0, 8).join('; '), sources: [{ documentId: w.documentId, location: { field: 'work_performed' } }],
    });
  }
  for (const p of data.passages) {
    facts.push({ label: `From the ${documentTypeLabel(normalizeTypeId(p.type)).toLowerCase()} (page ${p.page})`, value: p.excerpt, sources: [{ documentId: p.documentId, location: { page: p.page } }] });
  }
  for (const r of data.reminders) {
    facts.push({ label: r.reminderTrigger === 'next_visit' ? 'Reminder (next visit)' : 'Reminder', value: r.reminderText, sources: r.documentId ? [{ documentId: r.documentId, location: {} }] : [] });
  }
  const fut = futureNote(data.future, todayIso(today)).trim();
  if (!facts.length) {
    return answerEnvelope({
      text: `No notes or findings are on file for ${name}${data.ids.length ? ` (searched ${data.ids.length} document${data.ids.length === 1 ? '' : 's'})` : ''}.${fut ? ` ${fut}` : ''}`,
      facts: [],
    });
  }
  const bits = [];
  if (data.notes.length) bits.push(`${data.notes.length} technician note${data.notes.length === 1 ? '' : 's'}`);
  if (data.work.length) bits.push(`work performed on ${data.work.length} visit${data.work.length === 1 ? '' : 's'}`);
  if (data.reminders.length) bits.push(`${data.reminders.length} open reminder${data.reminders.length === 1 ? '' : 's'}`);
  if (data.passages.length) bits.push(`${data.passages.length} relevant page excerpt${data.passages.length === 1 ? '' : 's'}`);
  const first = facts[0];
  return answerEnvelope({ text: `${name}: ${bits.join(', ')}. Most recent — ${first.label}: ${first.value}${fut ? ` ${fut}` : ''}`, facts });
}
