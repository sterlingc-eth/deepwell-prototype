// Realistic sample shop data for the warranty claim packet: shaped exactly like the live app's graph (usePostgresSync):
// equipment entities carry customerId and their own address, customers use the raw data keys, there are no property
// or service entities, and each document carries its extracted fields. Used by verify-warranty-packet.ts.
import { hvacSchema } from '../../src/domains/hvac/schema';
import type { GraphSnapshot } from '../../src/core/entityGraph';
import type { Doc, Entity, ExtractedField } from '../../src/core/types';

const d = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
const f = (name: string, value: string): ExtractedField => ({ name, value, confidence: 0.95, location: {} });

const ent = (id: string, type: string, fields: Entity['fields']): Entity => ({ id, type, fields });
export function doc(id: string, filename: string, typeId: string | null, stage: Doc['stage'], linked: string[], extracted: ExtractedField[], extra: Partial<Doc> = {}): Doc {
  return {
    id, filename, fileType: 'pdf', pages: 1, batchId: 'b1', source: 'drive', receivedAt: d('2026-09-01'), typeId, stage,
    extracted, linkedEntityIds: linked, linkConfidence: 0.95, issues: [], preview: '',
    verifiedAt: stage === 'verified' ? d('2026-09-15') : undefined, verifiedBy: stage === 'verified' ? 'Pat Owner' : undefined, ...extra,
  };
}

export const NOW = new Date('2026-10-10T18:00:00Z');

export function sampleGraph(): GraphSnapshot {
  const entities: Record<string, Entity> = {};
  const add = (e: Entity) => { entities[e.id] = e; };
  add(ent('cust-carol', 'customer', { customer_name: 'Carol Rios', service_address: '412 Elm St, Mesa, AZ 85201', phone: '(480) 555-0148', email: 'carol.rios@example.com', customer_number: 'C-00001' }));
  add(ent('cust-plaza', 'customer', { customer_name: 'Plaza Dental Group', service_address: '2210 E Main St, Gilbert, AZ 85234' }));
  // Unit 1: complete, in warranty, installed by a named tech.
  add(ent('unit-1', 'equipment', { serial: 'TR2306A1234', model: 'XR16', manufacturer: 'Trane', equipmentType: 'Condensing unit', installDate: d('2023-06-12'), installedByName: 'D. Ramirez', warrantyExpiry: d('2033-06-12'), address: '412 Elm St, Mesa, AZ 85201', customerName: 'Carol Rios', customerId: 'cust-carol' }));
  // Unit 2: no installer, no registration document, only an insurance certificate linked.
  add(ent('unit-2', 'equipment', { serial: 'LX1905D9090', model: 'XC21', manufacturer: 'Lennox', equipmentType: 'Heat pump', installDate: d('2019-05-20'), warrantyExpiry: d('2029-05-20'), address: '2210 E Main St, Gilbert, AZ 85234', customerId: 'cust-plaza' }));
  // Unit 3: expired.
  add(ent('unit-3', 'equipment', { serial: 'CA1807B7788', model: '24ACC636', manufacturer: 'Carrier', equipmentType: 'Air conditioner', installDate: d('2016-07-01'), warrantyExpiry: d('2026-07-01'), installedByName: 'S. Patel', address: '412 Elm St, Mesa, AZ 85201', customerId: 'cust-carol' }));
  // Unit 4: no serial, no install date.
  add(ent('unit-4', 'equipment', { model: 'GSX140361', manufacturer: 'Goodman', equipmentType: 'Condensing unit', address: '9 Pine Ct, Mesa, AZ 85205', customerName: 'Mesa Pines HOA' }));

  const docs: Record<string, Doc> = {};
  const addDoc = (x: Doc) => { docs[x.id] = x; };
  addDoc(doc('d-reg', 'trane-registration-carol.pdf', 'warranty-registration', 'verified', ['unit-1', 'cust-carol'], [f('serial_number', 'TR2306A1234'), f('warranty_term', '10 year parts limited'), f('warranty_registered_date', '2023-07-01'), f('warranty_expires', '2033-06-12')], { displayName: 'Warranty · Carol Rios · Trane XR16 · Jun 12, 2023' }));
  addDoc(doc('d-startup', 'startup-sheet.pdf', 'startup-sheet', 'verified', ['unit-1'], [f('serial_number', 'TR2306A1234'), f('service_date', '2023-06-12')], { displayName: 'Startup sheet · Carol Rios · Jun 12, 2023' }));
  addDoc(doc('d-inv', 'invoice-1042.pdf', 'invoice', 'verified', ['unit-1', 'cust-carol'], [f('cost', '8420.00'), f('service_date', '2023-06-12')], { displayName: 'Invoice · Carol Rios · Jun 12, 2023' }));
  addDoc(doc('d-svc1', 'ticket-2025-04.pdf', 'service-ticket', 'verified', ['unit-1'], [f('service_date', '2025-04-08'), f('work_performed', 'Replaced run capacitor'), f('work_performed', 'Cleared condensate drain'), f('technician', 'D. Ramirez')], { displayName: 'Service ticket · Carol Rios · Apr 8, 2025' }));
  // Linked to the customer only, but names this unit's serial: still part of this unit's history.
  addDoc(doc('d-svc2', 'ticket-2026-03.pdf', 'service-ticket', 'verified', ['cust-carol'], [f('serial_number', 'TR2306A1234'), f('service_date', '2026-03-19'), f('work_performed', 'Spring tune-up and coil cleaning'), f('technician', 'S. Patel')], { displayName: 'Service ticket · Carol Rios · Mar 19, 2026' }));
  // Same customer, different unit: must NOT show up in unit 1.
  addDoc(doc('d-svc-other', 'ticket-other.pdf', 'service-ticket', 'verified', ['cust-carol'], [f('serial_number', 'CA1807B7788'), f('service_date', '2026-05-01'), f('work_performed', 'Refrigerant leak check'), f('technician', 'S. Patel')]));
  addDoc(doc('d-maint', 'maintenance-2026.pdf', 'maintenance-agreement', 'verified', ['unit-1', 'cust-carol'], [f('agreement_term', '01/01/2026 - 12/31/2026')], { displayName: 'Maintenance agreement · Carol Rios · 2026' }));
  // Not claim evidence: insurance certificate / floater linked to the unit, and an unverified registration.
  addDoc(doc('d-coi', 'coi-2026.pdf', 'insurance-certificate', 'verified', ['unit-1', 'unit-2'], [], { displayName: 'Insurance certificate · Desert Peak HVAC' }));
  addDoc(doc('d-unver', 'registration-draft.pdf', 'warranty-registration', 'linked', ['unit-1'], [f('warranty_term', '5 year')]));
  addDoc(doc('d-lennox-inv', 'lennox-invoice.pdf', 'invoice', 'verified', ['unit-2'], [f('cost', '6100.00'), f('service_date', '2019-05-20')], { displayName: 'Invoice · Plaza Dental Group · May 20, 2019' }));
  addDoc(doc('d-carrier-reg', 'carrier-reg.pdf', 'warranty-registration', 'verified', ['unit-3'], [f('warranty_term', '10 year parts')]));

  return { schema: hvacSchema, entities, docs, batches: {}, conflicts: {}, lastError: null };
}
