/**
 * dql/snapshot.js - PURE builder: the raw rows of one organization -> the in-memory snapshot the DQL executor runs over.
 *
 * Nothing in here touches a database (load.js reads the rows; verify scripts hand the same row shapes in from an export file).
 * Every derived field is computed once, here, and never invented: a value that is not on file stays null.
 *
 *   document  {id, type, filename, custId, custName, city, unitId, date, dateBasis, serviceDate, invoiceDate, createdAt,
 *              tech, hours, status, serviceType, vendor, total, kind, direction, brand, model, serial, f}
 *   customer  {id, name, address, city, phone, email, number}
 *   unit      {id, custId, custName, city, brand, model, serial, tonnage, tonnageNum, refrigerant, type, installDate, installYear,
 *              warrantyStatus, warrantyExpires, warrantyTermYears, registeredDate, f}
 *   line      {id, docId, finId, lineNo, description, qty, unitPrice, amount}
 *
 * `f` on a document is every extracted field (corrected value first, newest row wins); the typed fields above are views of it.
 * `fMulti` holds every distinct value of a field the paper states more than once (null when there is none): only text search reads it.
 */
import { isPrivateDoc } from '../privacy/privateDocs.js';
import { deriveGeo, warrantyStatusOf } from '../analytics.js';
import { buildCard, aliasMap } from './card.js';

const clean = (v) => { const s = v == null ? '' : String(v).replace(/\s+/g, ' ').trim(); return s === '' ? null : s; };
const isoDay = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? '').trim());
  if (!m) return null;
  const mo = Number(m[2]); const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
};
/** "01/15/2026" or "2026-01-15" -> ISO day, else null. */
export function parseAnyDate(v) {
  const s = String(v ?? '').trim();
  const iso = isoDay(s);
  if (iso) return iso;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) {
    const mo = Number(m[1]); const d = Number(m[2]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${m[3]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}
const money = (v) => { if (v == null || v === '') return null; const n = Number(String(v).replace(/[$,]/g, '')); return Number.isFinite(n) ? n : null; };
const normType = (t) => String(t ?? '').trim().toLowerCase().replace(/_/g, '-');
/** Plain "labor hours" value: "2.5", "2.5 hrs", "3 hours" -> number, else null. */
function hoursOf(v) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)?\s*$/i.exec(String(v ?? ''));
  return m ? Number(m[1]) : null;
}
const tonnageNum = (v) => { const m = /(\d+(?:\.\d+)?)\s*(?:-?\s*ton|t\b)?/i.exec(String(v ?? '')); return m ? Number(m[1]) : null; };

/** People/HR papers are never read, listed or counted by DQL (summary/index.js applies the same rule); internal-audience papers are left out by load.js (audience/sql.js). */
export const EXCLUDED_DOC_TYPES = new Set(['hr-letter']);

/** The fields a paper states more than once: {field: [every distinct value]}; null when it states none twice. */
function multiOf(am) {
  if (!am) return null;
  let out = null;
  for (const [k, arr] of am) if (arr.length > 1) { out ??= {}; out[k] = arr; }
  return out;
}

/**
 * @param {object} raw {documents, extractions, entities, links, financials, lines, internalDocIds}
 *   documents   [{id, original_filename, document_type, created_at}]
 *   extractions [{document_id, entity_id?, field_key, value, corrected_value?, created_at?}]
 *   entities    [{id, entity_type, customer_id?, merged_into?, customer_number?, data}]
 *   links       [{document_id, entity_id}]
 *   financials  [{id, document_id, doc_kind, direction, invoice_number, po_number, invoice_date, due_date, subtotal, tax, total, amount_paid, balance_due, status, customer_name, vendor_name, corrections?}]
 *   lines       [{id, financial_id, document_id, line_no, description, qty, unit_price, amount}]
 *   internalDocIds  Set|array of document ids marked internal-audience
 */
export function buildSnapshot(raw, { today } = {}) {
  const internal = new Set(raw.internalDocIds ?? []);
  const entities = (raw.entities ?? []).filter((e) => !e.merged_into);
  const entById = new Map(entities.map((e) => [e.id, e]));

  // ---- customers
  const customers = [];
  for (const e of entities) {
    if (e.entity_type !== 'customer') continue;
    const d = e.data ?? {};
    const address = clean(d.service_address);
    customers.push({ id: e.id, name: clean(d.customer_name), address, city: address ? clean(deriveGeo(address).city) : null, phone: clean(d.phone), email: clean(d.email), number: clean(e.customer_number) });
  }
  const custById = new Map(customers.map((c) => [c.id, c]));

  // ---- units
  const units = [];
  for (const e of entities) {
    if (e.entity_type !== 'equipment') continue;
    const d = e.data ?? {};
    const cust = e.customer_id ? custById.get(e.customer_id) ?? null : null;
    const install = parseAnyDate(d.installation_date);
    const w = d.warranty && typeof d.warranty === 'object' ? d.warranty : null;
    units.push({
      id: e.id, custId: cust?.id ?? null, custName: cust?.name ?? null, city: cust?.city ?? null,
      brand: clean(d.manufacturer), model: clean(d.model), serial: clean(d.serial_number), tonnage: clean(d.tonnage), tonnageNum: d.tonnage ? tonnageNum(d.tonnage) : null,
      refrigerant: clean(d.refrigerant), type: clean(d.equipment_type), installDate: install, installYear: install ? Number(install.slice(0, 4)) : (/^\d{4}$/.test(String(d.installation_date ?? '')) ? Number(d.installation_date) : null),
      warrantyStatus: w && today ? warrantyStatusOf(w, today) : 'unknown', warrantyExpires: w && /^\d{4}-\d{2}-\d{2}/.test(String(w.expires ?? '')) ? String(w.expires).slice(0, 10) : null,
      warrantyTermYears: w && Number.isFinite(Number(w.termYears)) ? Number(w.termYears) : null, registeredDate: parseAnyDate(d.warranty_registered_date),
      f: d,
    });
  }
  const unitById = new Map(units.map((u) => [u.id, u]));

  // ---- which customer / unit a document belongs to (direct link, or through the unit's customer)
  const custsByDoc = new Map(); const unitsByDoc = new Map();
  for (const l of raw.links ?? []) {
    const e = entById.get(l.entity_id);
    if (!e) continue;
    if (e.entity_type === 'customer') { if (!custsByDoc.has(l.document_id)) custsByDoc.set(l.document_id, new Set()); custsByDoc.get(l.document_id).add(e.id); }
    else if (e.entity_type === 'equipment') {
      if (!unitsByDoc.has(l.document_id)) unitsByDoc.set(l.document_id, new Set());
      unitsByDoc.get(l.document_id).add(e.id);
      if (e.customer_id && custById.has(e.customer_id)) { if (!custsByDoc.has(l.document_id)) custsByDoc.set(l.document_id, new Set()); custsByDoc.get(l.document_id).add(e.customer_id); }
    }
  }

  // ---- extracted fields (corrected value first, newest wins)
  const fieldsByDoc = new Map();
  const allByDoc = new Map(); // every distinct value of a field a paper states more than once (two lines of work performed): text search reads them all
  // R15: the company's vocabulary card renames its own field keys (groomer, groom_date ...) to the ones the engine reads; a key the company already stores under the engine's own name is never overwritten
  const typeById = new Map((raw.documents ?? []).map((d) => [d.id, normType(d.document_type)]));
  const typeCount = new Map(); for (const t of typeById.values()) if (!EXCLUDED_DOC_TYPES.has(t)) typeCount.set(t, (typeCount.get(t) ?? 0) + 1);
  const card = buildCard({
    rows: (raw.extractions ?? []).map((x) => ({ k: x.field_key, t: typeById.get(x.document_id), v: clean(x.corrected_value) ?? clean(x.value) })).filter((r) => r.v != null && r.t && !EXCLUDED_DOC_TYPES.has(r.t)),
    docTypes: [...typeCount].map(([id, n]) => ({ id, n })), custNames: customers.map((c) => c.name).filter(Boolean), nDocs: typeById.size,
  });
  const renames = process.env.DONOVAN_CARD === '0' ? new Map() : aliasMap(card, new Set((raw.extractions ?? []).map((x) => x.field_key)));
  const ex = [...(raw.extractions ?? [])].map((x) => (renames.has(x.field_key) ? { ...x, field_key: renames.get(x.field_key) } : x)).sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
  for (const x of ex) {
    if (!x.document_id || !x.field_key) continue;
    const v = clean(x.corrected_value) ?? clean(x.value);
    if (v == null) continue;
    let m = fieldsByDoc.get(x.document_id);
    if (!m) { m = {}; fieldsByDoc.set(x.document_id, m); }
    m[x.field_key] = v;
    let am = allByDoc.get(x.document_id);
    if (!am) { am = new Map(); allByDoc.set(x.document_id, am); }
    const arr = am.get(x.field_key) ?? [];
    if (!arr.includes(v)) { arr.push(v); am.set(x.field_key, arr); }
  }
  const finByDoc = new Map();
  for (const f of raw.financials ?? []) {
    const corr = f.corrections && typeof f.corrections === 'object' ? f.corrections : {};
    const eff = { ...f };
    for (const k of Object.keys(corr)) eff[k] = corr[k] === '' ? null : corr[k];
    finByDoc.set(f.document_id, eff);
  }

  // ---- documents
  const documents = [];
  for (const d of raw.documents ?? []) {
    const type = normType(d.document_type);
    const f = fieldsByDoc.get(d.id) ?? {};
    // R21: the shared private-paper rule (type words, audience, staff named) - privacy/privateDocs.js
    if (EXCLUDED_DOC_TYPES.has(type) || isPrivateDoc({ document_type: type, audience: internal.has(d.id) || f._audience === 'internal' ? 'internal' : '', staffNamed: !!clean(f.technician) })) continue;
    if (internal.has(d.id) || f._audience === 'internal') continue;
    const fin = finByDoc.get(d.id) ?? null;
    const cs = custsByDoc.get(d.id);
    const custId = cs && cs.size === 1 ? [...cs][0] : null;
    const cust = custId ? custById.get(custId) : null;
    const us = unitsByDoc.get(d.id);
    const unit = us && us.size === 1 ? unitById.get([...us][0]) : null;
    const serviceDate = parseAnyDate(f.service_date);
    const invoiceDate = parseAnyDate(f.invoice_date) ?? isoDay(fin?.invoice_date);
    const createdAt = isoDay(d.created_at);
    const date = serviceDate ?? invoiceDate ?? createdAt;
    const dateBasis = serviceDate ? 'service_date' : invoiceDate ? 'invoice_date' : createdAt ? 'created_at' : null;
    const f2 = { ...f };
    documents.push({
      id: d.id, type, filename: clean(d.original_filename), createdAt, custId, custName: cust?.name ?? null, city: cust?.city ?? null,
      custIds: cs ? [...cs] : [], unitId: unit?.id ?? null,
      serviceDate, invoiceDate, date, dateBasis,
      tech: clean(f.technician), hours: hoursOf(f.labor_hours), status: clean(f.status) ?? clean(fin?.status !== 'unknown' ? fin?.status : null),
      serviceType: clean(f.service_type), vendor: clean(fin?.vendor_name) ?? clean(f.vendor_name), total: money(fin?.total), kind: fin?.doc_kind ?? null, direction: fin?.direction ?? null,
      finId: fin?.id ?? null, totalPage: (() => { const n = Math.trunc(Number(fin?.evidence?.total?.page)); return Number.isFinite(n) && n > 0 ? n : null; })(),
      brand: clean(f.manufacturer) ?? unit?.brand ?? null, model: clean(f.model) ?? unit?.model ?? null, serial: clean(f.serial_number) ?? unit?.serial ?? null,
      f: f2, fMulti: multiOf(allByDoc.get(d.id)),
    });
  }
  const docById = new Map(documents.map((d) => [d.id, d]));
  const finRows = [];
  for (const [docId, fin] of finByDoc) {
    const doc = docById.get(docId);
    if (!doc) continue;
    finRows.push({ ...fin, doc });
  }
  const lines = [];
  for (const l of raw.lines ?? []) {
    const doc = docById.get(l.document_id);
    if (!doc) continue;
    lines.push({ id: l.id, docId: l.document_id, finId: l.financial_id, lineNo: l.line_no, description: clean(l.description), qty: money(l.qty), unitPrice: money(l.unit_price), amount: money(l.amount), doc });
  }
  // per-customer relations, computed once: the documents, the units, the visits and the billed total of each customer
  const stats = new Map(customers.map((c) => [c.id, { docs: [], units: [], visits: 0, billed: 0, billedN: 0, firstVisit: null, lastVisit: null }]));
  for (const d of documents) {
    const st = d.custId ? stats.get(d.custId) : null;
    if (!st) continue;
    st.docs.push(d);
    if (d.serviceDate) { st.visits++; if (!st.firstVisit || d.serviceDate < st.firstVisit) st.firstVisit = d.serviceDate; if (!st.lastVisit || d.serviceDate > st.lastVisit) st.lastVisit = d.serviceDate; }
    if (d.type === 'invoice' && d.total != null) { st.billed += d.total; st.billedN++; }
  }
  for (const u of units) { const st = u.custId ? stats.get(u.custId) : null; if (st) st.units.push(u); }
  return { today: today ?? null, card, documents, docById, customers, custById, units, unitById, fin: finRows, lines, stats };
}
