/**
 * dql/fields.js - what a row of each entity can be asked, in one table. The executor and the parser both read this; no business
 * word lives here (field ids are generic: customer, tech, city, brand, type, status ...). Values come from the snapshot.
 *
 *   ENTITIES[entity].fields[fieldId] = {kind, label, get(row, snap, today)}
 *   kind: 'text' | 'num' | 'date' | 'bool'
 */
import { canonicalBrandLabel } from '../analytics/brandCanon.js';

const lc = (v) => (v == null ? null : String(v).toLowerCase());
export const brandKey = (v) => (v == null || v === '' ? null : lc(canonicalBrandLabel(String(v))));

function yearsBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  const a = Date.parse(`${fromIso}T00:00:00Z`); const b = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (b - a) / (365.25 * 86400000);
}
export { yearsBetween };

const unitOf = (d, snap) => (d.unitId ? snap.unitById.get(d.unitId) ?? null : null);

const rentOf = (d) => { const v = d.f?.rent_amount ?? d.f?.monthly_rent ?? d.f?.rent; if (v == null || v === '') return null; const n = Number(String(v).replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : null; };
const DOC_FIELDS = {
  type: { kind: 'text', label: 'document type', get: (d) => d.type },
  customer: { kind: 'text', label: 'customer', get: (d) => d.custName },
  tech: { kind: 'text', label: 'technician', get: (d) => d.tech },
  city: { kind: 'text', label: 'city', get: (d) => d.city },
  brand: { kind: 'text', label: 'brand', get: (d) => d.brand, key: brandKey },
  model: { kind: 'text', label: 'model', get: (d) => d.model },
  serial: { kind: 'text', label: 'serial number', get: (d) => d.serial },
  status: { kind: 'text', label: 'status', get: (d) => d.status },
  serviceType: { kind: 'text', label: 'service type', get: (d) => d.serviceType },
  vendor: { kind: 'text', label: 'vendor', get: (d) => d.vendor },
  refrigerant: { kind: 'text', label: 'refrigerant', get: (d, s) => d.f.refrigerant ?? unitOf(d, s)?.refrigerant ?? null },
  tonnage: { kind: 'num', label: 'tonnage', get: (d, s) => { const t = d.f.tonnage ?? unitOf(d, s)?.tonnage; const m = /(\d+(?:\.\d+)?)/.exec(String(t ?? '')); return m ? Number(m[1]) : null; } },
  total: { kind: 'num', label: 'total', get: (d) => d.total },
  // a lease or rental agreement is asked about by its rent ("leases over $1,500"): the printed total of such a paper is the rent times the term. A paper type whose organization stores no rent is asked by its total.
  rent: { kind: 'num', label: 'rent', get: (d, s) => {
    if (!s) return d.total;
    if (!s._rentTypes) { s._rentTypes = new Set(); for (const x of s.documents ?? []) if (rentOf(x) != null) s._rentTypes.add(x.type); }
    return s._rentTypes.has(d.type) ? rentOf(d) : d.total;
  } },
  hours: { kind: 'num', label: 'labor hours', get: (d) => d.hours },
  date: { kind: 'date', label: 'document date', get: (d) => d.date },
  serviceDate: { kind: 'date', label: 'service date', get: (d) => d.serviceDate },
  invoiceDate: { kind: 'date', label: 'invoice date', get: (d) => d.invoiceDate },
  createdAt: { kind: 'date', label: 'upload date', get: (d) => d.createdAt },
  installDate: { kind: 'date', label: 'installation date', get: (d) => d.f.installation_date && /^\d{4}-\d{2}-\d{2}/.test(d.f.installation_date) ? d.f.installation_date.slice(0, 10) : null },
};

const stat = (c, snap) => snap.stats?.get(c.id) ?? { docs: [], units: [], visits: 0, billed: 0, billedN: 0 };
const CUST_FIELDS = {
  // relations: how many documents / units / visits a customer has, what they were billed, which brands they own
  docCount: { kind: 'num', label: 'documents on file', get: (c, s, t, f) => stat(c, s).docs.filter((d) => !f?.docType || d.type === f.docType).length },
  unitCount: { kind: 'num', label: 'units on file', get: (c, s) => stat(c, s).units.length },
  visitCount: { kind: 'num', label: 'service visits', get: (c, s) => stat(c, s).visits },
  billed: { kind: 'num', label: 'total billed on invoices', get: (c, s) => (stat(c, s).billedN ? stat(c, s).billed : null) },
  hasBrand: { kind: 'bool', label: 'owns a unit of the brand', get: (c, s, t, f) => stat(c, s).units.some((u) => brandKey(u.brand) === brandKey(f?.value)) },
  name: { kind: 'text', label: 'name', get: (c) => c.name },
  customer: { kind: 'text', label: 'customer', get: (c) => c.name },
  city: { kind: 'text', label: 'city', get: (c) => c.city },
  address: { kind: 'text', label: 'service address', get: (c) => c.address },
  email: { kind: 'text', label: 'email', get: (c) => c.email },
  phone: { kind: 'text', label: 'phone', get: (c) => c.phone },
};

const UNIT_FIELDS = {
  brand: { kind: 'text', label: 'brand', get: (u) => u.brand, key: brandKey },
  model: { kind: 'text', label: 'model', get: (u) => u.model },
  serial: { kind: 'text', label: 'serial number', get: (u) => u.serial },
  tonnage: { kind: 'num', label: 'tonnage', get: (u) => u.tonnageNum },
  refrigerant: { kind: 'text', label: 'refrigerant', get: (u) => u.refrigerant },
  equipmentType: { kind: 'text', label: 'equipment type', get: (u) => u.type },
  customer: { kind: 'text', label: 'customer', get: (u) => u.custName },
  city: { kind: 'text', label: 'city', get: (u) => u.city },
  installDate: { kind: 'date', label: 'installation date', get: (u) => u.installDate },
  warrantyExpires: { kind: 'date', label: 'warranty expiration', get: (u) => u.warrantyExpires },
  registeredDate: { kind: 'date', label: 'warranty registration date', get: (u) => u.registeredDate },
  warrantyStatus: { kind: 'text', label: 'warranty status', get: (u) => (u.warrantyStatus === 'unknown' ? null : u.warrantyStatus) },
  age: { kind: 'num', label: 'age in years', get: (u, s, today) => { const y = yearsBetween(u.installDate, today); return y == null || y < 0 ? null : y; } },
  installYear: { kind: 'num', label: 'installation year', get: (u) => u.installYear },
};

export const ENTITIES = {
  document: {
    id: 'document', fields: DOC_FIELDS, rows: (s) => s.documents,
    noun: (n) => (n === 1 ? 'document' : 'documents'), defaultDate: 'date',
  },
  customer: {
    id: 'customer', fields: CUST_FIELDS, rows: (s) => s.customers,
    noun: (n) => (n === 1 ? 'customer' : 'customers'), defaultDate: null,
  },
  unit: {
    id: 'unit', fields: UNIT_FIELDS, rows: (s) => s.units,
    noun: (n) => (n === 1 ? 'unit' : 'units'), defaultDate: null,
  },
};

/** Date-field choices a question can name, per entity: the verb/noun cue -> field id. */
export const DATE_CUES = {
  document: { default: 'date', created: 'createdAt', visit: 'serviceDate', invoice: 'invoiceDate' },
  unit: { install: 'installDate', expire: 'warrantyExpires', register: 'registeredDate' },
};
