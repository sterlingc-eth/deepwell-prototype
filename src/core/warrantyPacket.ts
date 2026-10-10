import { docsLinkedTo, type GraphSnapshot } from './entityGraph';
import { formatYmd } from './answer';
import { documentName, hasFriendlyName, originalFilename } from './documentName';
import type { Doc, Entity } from './types';

/**
 * Warranty claim packet builder. Pure: takes the entity graph and one unit and returns everything the printed
 * packet shows (customer, unit, warranty terms, supporting documents, service history, readiness). The screen only
 * renders this, so the same logic is checked by scripts/verify-warranty-packet.ts with no browser.
 *
 * Where the facts come from, in the live app (usePostgresSync.ts): the unit is an `equipment` entity carrying its own
 * serial/model/install date/warranty expiry plus `customerId`; the customer is a `customer` entity (raw data keys:
 * customer_name, service_address, phone, email). There are no `property` or `service` entities from the server, so a
 * packet that only walked unit -> property printed a blank customer and address. The demo fixture still has
 * properties, so both paths are read, newest information winning in this order: property, customer, the unit itself.
 */

/** Document types that can back a warranty claim, and the heading each is grouped under. Anything not listed
 *  (insurance certificates and floaters, HR letters, price lists, statements ...) never appears in a claim packet. */
const ROLE_OF_TYPE: Record<string, DocRole> = {
  'warranty-registration': 'registration',
  'warranty-certificate': 'registration',
  warranty: 'registration',
  'startup-sheet': 'install',
  'install-record': 'install',
  'equipment-record': 'install',
  'nameplate-photo': 'install',
  permit: 'install',
  invoice: 'purchase',
  receipt: 'purchase',
  'proposal-quote': 'purchase',
  'purchase-order': 'purchase',
  'delivery-ticket': 'purchase',
  'maintenance-agreement': 'agreement',
  agreement: 'agreement',
  'service-ticket': 'service',
  'service-report': 'service',
  'work-order': 'service',
  'inspection-report': 'service',
  'dispatch-note': 'service',
};

export type DocRole = 'registration' | 'install' | 'purchase' | 'agreement' | 'service';

export const ROLE_HEADING: Record<DocRole, string> = {
  registration: 'Warranty registration',
  install: 'Installation and equipment records',
  purchase: 'Proof of purchase',
  agreement: 'Maintenance agreements',
  service: 'Service records',
};
const ROLE_ORDER: DocRole[] = ['registration', 'install', 'purchase', 'agreement', 'service'];

export interface PacketDoc {
  id: string;
  name: string;
  /** Original upload name, only when it differs from `name`. */
  filename: string | null;
  typeLabel: string;
  role: DocRole;
  verifiedOn: string;
}

export interface ServiceVisit {
  /** Sort key and display, bare calendar day. */
  ymd: string;
  date: string;
  work: string;
  technician: string;
  /** The document this visit is read from. */
  source: string;
}

export interface PacketUnit {
  id: string;
  serial: string;
  model: string;
  manufacturer: string;
  equipmentType: string;
  installDate: string;
  installedBy: string;
}

export interface PacketCustomer {
  name: string;
  number: string;
  address: string;
  phone: string;
  email: string;
}

export interface PacketWarranty {
  expires: string;
  /** 'active' | 'expiring' | 'expired' | 'unknown' */
  status: 'active' | 'expiring' | 'expired' | 'unknown';
  statusLabel: string;
  daysRemaining: number | null;
  /** The manufacturer's term as printed on a document, e.g. "10 year parts limited". Empty when none says so. */
  termPrinted: string;
  /** Whole years from install date to expiry, when that comes out as a clean number. */
  termYears: number | null;
  registeredOn: string;
  /** 'printed' when a verified document states the expiry date; 'computed' when it is worked out from install date + term. */
  expiryBasis: 'printed' | 'computed' | 'unknown';
}

export interface Packet {
  unit: PacketUnit;
  customer: PacketCustomer;
  warranty: PacketWarranty;
  documents: { role: DocRole; heading: string; docs: PacketDoc[] }[];
  documentCount: number;
  serviceHistory: ServiceVisit[];
  /** Hard gaps: a manufacturer cannot act on a claim without these. */
  missing: string[];
  /** Worth fixing, but does not block the claim. */
  advisories: string[];
  ready: boolean;
}

const DAY = 86_400_000;

function fieldValue(doc: Doc, name: string): string {
  const hit = doc.extracted.find((f) => f.name === name);
  if (!hit) return '';
  return (hit.correctedValue ?? hit.value ?? '').trim();
}
const fieldAll = (doc: Doc, name: string): string[] =>
  doc.extracted.filter((f) => f.name === name).map((f) => (f.correctedValue ?? f.value ?? '').trim()).filter(Boolean);

const s = (e: Entity | undefined, key: string): string => {
  const v = e?.fields[key];
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return formatYmd(v);
  return String(v).trim();
};
const first = (...vals: string[]): string => vals.find((v) => v) ?? '';

function ymdOf(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

function customerFor(g: GraphSnapshot, unit: Entity): PacketCustomer {
  const property = g.entities[s(unit, 'propertyId')];
  const customerEntity =
    g.entities[s(unit, 'customerId')] ?? g.entities[s(property, 'customerId')];
  const cityLine = [s(property, 'city'), [s(property, 'state'), s(property, 'zip')].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const propertyAddress = s(property, 'address') ? [s(property, 'address'), cityLine].filter(Boolean).join(', ') : '';
  return {
    name: first(s(customerEntity, 'customer_name'), s(customerEntity, 'name'), s(property, 'customerName'), s(unit, 'customerName')),
    number: first(s(customerEntity, 'customer_number'), s(customerEntity, 'customerNumber')),
    address: first(propertyAddress, s(unit, 'address'), s(customerEntity, 'service_address')),
    phone: first(s(customerEntity, 'phone')),
    email: first(s(customerEntity, 'email')),
  };
}

/** Documents that belong to this unit: linked straight to it, or linked to its customer and naming this serial. */
function unitDocs(g: GraphSnapshot, unit: Entity, serial: string): Doc[] {
  const direct = docsLinkedTo(g, unit.id);
  const seen = new Set(direct.map((d) => d.id));
  const customerId = s(unit, 'customerId');
  const norm = (v: string) => v.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const extra =
    customerId && serial
      ? docsLinkedTo(g, customerId).filter(
          (d) => !seen.has(d.id) && fieldAll(d, 'serial_number').some((v) => norm(v) === norm(serial))
        )
      : [];
  return [...direct, ...extra];
}

export function buildPacket(g: GraphSnapshot, unit: Entity, now: Date = new Date()): Packet {
  const labelOf = (d: Doc) => g.schema.documentTypes.find((t) => t.id === d.typeId)?.label ?? 'Document';
  const serial = s(unit, 'serial');
  const verified = unitDocs(g, unit, serial).filter((d) => d.stage === 'verified');

  const documents: PacketDoc[] = [];
  const serviceHistory: ServiceVisit[] = [];
  let termPrinted = '';
  let registeredOn = '';
  let expiryPrintedOnDoc = false;

  for (const d of verified) {
    const role = d.typeId ? ROLE_OF_TYPE[d.typeId] : undefined;
    if (!role) continue; // insurance certificates, floaters, HR letters ...: not claim evidence
    documents.push({
      id: d.id,
      name: documentName(d),
      filename: hasFriendlyName(d) ? originalFilename(d) : null,
      typeLabel: labelOf(d),
      role,
      verifiedOn: d.verifiedAt ? formatYmd(d.verifiedAt) : '',
    });
    if (role === 'registration') {
      termPrinted ||= fieldValue(d, 'warranty_term');
      registeredOn ||= formatYmd(ymdOf(fieldValue(d, 'warranty_registered_date')));
      if (fieldValue(d, 'warranty_expires')) expiryPrintedOnDoc = true;
    }
    if (role === 'service') {
      const ymd = ymdOf(fieldValue(d, 'service_date'));
      const work = fieldAll(d, 'work_performed');
      if (ymd || work.length) {
        serviceHistory.push({
          ymd,
          date: ymd ? formatYmd(ymd) : 'Date not stated',
          work: work.join('; ') || 'Work not described',
          technician: fieldValue(d, 'technician'),
          source: documentName(d),
        });
      }
    }
  }
  serviceHistory.sort((a, b) => b.ymd.localeCompare(a.ymd));

  const grouped = ROLE_ORDER.map((role) => ({
    role,
    heading: ROLE_HEADING[role],
    docs: documents.filter((x) => x.role === role),
  })).filter((x) => x.docs.length);

  const installDate = unit.fields.installDate instanceof Date ? unit.fields.installDate : null;
  const expiry = unit.fields.warrantyExpiry instanceof Date ? unit.fields.warrantyExpiry : null;
  let status: PacketWarranty['status'] = 'unknown';
  let statusLabel = 'No warranty on file';
  let daysRemaining: number | null = null;
  if (expiry) {
    daysRemaining = Math.ceil((expiry.getTime() - now.getTime()) / DAY);
    if (daysRemaining < 0) { status = 'expired'; statusLabel = `Expired ${Math.abs(daysRemaining)} days ago`; }
    else if (daysRemaining <= 90) { status = 'expiring'; statusLabel = `Expires in ${daysRemaining} days`; }
    else { status = 'active'; statusLabel = 'In warranty'; }
  }
  let termYears: number | null = null;
  if (installDate && expiry) {
    const years = (expiry.getTime() - installDate.getTime()) / (365.25 * DAY);
    const rounded = Math.round(years);
    if (rounded >= 1 && Math.abs(years - rounded) < 0.1) termYears = rounded;
  }

  const missing: string[] = [];
  if (!serial) missing.push('serial');
  if (!installDate) missing.push('install date');
  if (!expiry) missing.push('warranty registration');
  const advisories: string[] = [];
  if (!s(unit, 'installedByName')) advisories.push('Installer not on file');

  return {
    unit: {
      id: unit.id,
      serial,
      model: s(unit, 'model'),
      manufacturer: s(unit, 'manufacturer'),
      equipmentType: s(unit, 'equipmentType'),
      installDate: installDate ? formatYmd(installDate) : '',
      installedBy: s(unit, 'installedByName'),
    },
    customer: customerFor(g, unit),
    warranty: {
      expires: expiry ? formatYmd(expiry) : '',
      status,
      statusLabel,
      daysRemaining,
      termPrinted,
      termYears,
      registeredOn,
      expiryBasis: !expiry ? 'unknown' : expiryPrintedOnDoc ? 'printed' : 'computed',
    },
    documents: grouped,
    documentCount: documents.length,
    serviceHistory,
    missing,
    advisories,
    ready: missing.length === 0 && status !== 'expired' && documents.length > 0,
  };
}
