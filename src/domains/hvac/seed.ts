/**
 * HVAC seed: turns the existing mock records into entities plus the documents
 * those records "came from". Every entity field that an answer can cite has
 * at least one extracted field pointing at it, so no fact is ever sourceless.
 *
 * Batches are seeded in different pipeline stages on purpose so the intake
 * workflow is visible on first load:
 *   - Camelback cabinet (2016–2023 registrations)   → all Verified
 *   - Work orders 2024–2026                          → Verified, last three Linked (unverified)
 *   - Truck photos — Sept 2026                        → Received / Classified / Extracted,
 *                                                       5 unlinked, 2 conflicts, gaps, 1 duplicate
 */
import type {
  Batch,
  Conflict,
  Doc,
  Entity,
  ExtractedField,
  IntakeSource,
  PipelineStage,
} from '../../core/types';
import { equipment, properties, serviceEvents, technicians } from '../../mocks/data';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const money = (n: number) => `$${n.toLocaleString('en-US')}`;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

const OFFICE = 'Dana R. (office)';

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export function buildEntities(): Entity[] {
  const out: Entity[] = [];

  // Customers are derived from property records (the mock customer table is out of sync)
  const customerIds = new Map<string, string>();
  for (const p of properties) {
    if (!customerIds.has(p.customerName)) {
      const id = `cust-${slug(p.customerName)}`;
      customerIds.set(p.customerName, id);
      const commercial = /inc|management|warehouse|plaza|manufacturing|llc/i.test(p.customerName);
      out.push({ id, type: 'customer', fields: { name: p.customerName, type: commercial ? 'commercial' : 'residential' } });
    }
  }

  for (const p of properties) {
    out.push({
      id: p.id,
      type: 'property',
      fields: {
        address: p.address,
        city: p.city,
        state: p.state,
        zip: p.zipCode,
        customerName: p.customerName,
        customerId: customerIds.get(p.customerName) ?? null,
      },
    });
  }

  for (const t of technicians) {
    out.push({
      id: t.id,
      type: 'technician',
      fields: {
        name: t.name,
        specialty: t.specialty,
        certifications: t.certifications.join(', '),
        phone: t.phone,
      },
    });
  }

  for (const e of equipment) {
    out.push({
      id: e.id,
      type: 'equipment',
      fields: {
        serial: e.serialNumber,
        model: e.modelNumber,
        manufacturer: e.manufacturer,
        equipmentType: e.equipmentType,
        installDate: e.installDate,
        installedBy: e.installedByTechId,
        installedByName: e.installedByTechName,
        warrantyExpiry: e.warrantyExpiry,
        propertyId: e.propertyId,
      },
    });
  }

  for (const s of serviceEvents) {
    out.push({
      id: s.id,
      type: 'service',
      fields: {
        date: s.date,
        technicianId: s.technicianId,
        technicianName: s.technicianName,
        equipmentId: s.equipmentId,
        propertyId: s.propertyId,
        workPerformed: s.workPerformed,
        cost: s.cost,
        notes: s.notes,
      },
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

const BATCH_CABINET = 'batch-camelback-cabinet';
const BATCH_WORK_ORDERS = 'batch-work-orders-2024-2026';
const BATCH_TRUCK = 'batch-truck-sept-2026';

function field(
  name: string,
  value: string,
  page: number,
  confidence: number,
  target?: { entityId: string; field: string },
  fieldLabel?: string,
): ExtractedField {
  const f: ExtractedField = { name, value, confidence, location: { page, field: fieldLabel ?? name } };
  if (target) f.target = target;
  return f;
}

function previewOf(title: string, fields: ExtractedField[]): string {
  return [title, '', ...fields.map((f) => `${f.name}: ${f.correctedValue ?? f.value}`)].join('\n');
}

function propertyOf(id: string) {
  const p = properties.find((x) => x.id === id);
  if (!p) throw new Error(`seed: unknown property ${id}`);
  return p;
}
function equipmentOf(id: string) {
  const e = equipment.find((x) => x.id === id);
  if (!e) throw new Error(`seed: unknown equipment ${id}`);
  return e;
}

function makeDoc(partial: Omit<Doc, 'preview' | 'issues' | 'linkConfidence'> & Partial<Pick<Doc, 'preview' | 'issues' | 'linkConfidence'>>, title: string): Doc {
  return {
    linkConfidence: partial.linkedEntityIds.length ? 0.97 : 0,
    issues: [],
    preview: previewOf(title, partial.extracted),
    ...partial,
  };
}

export function buildDocuments(): { docs: Doc[]; batches: Batch[]; conflicts: Conflict[] } {
  const docs: Doc[] = [];
  const conflicts: Conflict[] = [];

  // ---- Batch 1: warranty registrations from the cabinet (all verified) ----
  for (const e of equipment) {
    const p = propertyOf(e.propertyId);
    const fields: ExtractedField[] = [
      field('Serial No.', e.serialNumber, 1, 0.99, { entityId: e.id, field: 'serial' }),
      field('Model', e.modelNumber, 1, 0.98, { entityId: e.id, field: 'model' }),
      field('Manufacturer', e.manufacturer, 1, 0.99, { entityId: e.id, field: 'manufacturer' }),
      field('Equipment type', e.equipmentType, 1, 0.95, { entityId: e.id, field: 'equipmentType' }),
      field('Install date', iso(e.installDate), 1, 0.97, { entityId: e.id, field: 'installDate' }),
      field('Installed by', e.installedByTechName, 1, 0.93, { entityId: e.id, field: 'installedByName' }),
      field('Service address', `${p.address}, ${p.city}, ${p.state} ${p.zipCode}`, 1, 0.98, { entityId: p.id, field: 'address' }),
      field('Customer', p.customerName, 1, 0.96, { entityId: p.id, field: 'customerName' }),
    ];
    if (e.warrantyExpiry) {
      fields.push(field('Warranty expires', iso(e.warrantyExpiry), 2, 0.97, { entityId: e.id, field: 'warrantyExpiry' }));
    } else {
      fields.push(field('Warranty expires', 'Not registered', 2, 0.9, { entityId: e.id, field: 'warrantyExpiry' }));
    }
    docs.push(
      makeDoc(
        {
          id: `doc-wr-${e.id}`,
          filename: `WarrantyReg_${e.manufacturer}_${e.modelNumber}_${e.serialNumber}.pdf`,
          fileType: 'pdf',
          pages: 2,
          batchId: BATCH_CABINET,
          source: 'cabinet',
          receivedAt: new Date('2026-08-20T09:12:00'),
          typeId: 'warranty-registration',
          stage: 'verified',
          extracted: fields,
          linkedEntityIds: [e.id, p.id],
          verifiedBy: OFFICE,
          verifiedAt: new Date('2026-08-22T15:40:00'),
        },
        `${e.manufacturer} Warranty Registration Certificate`,
      ),
    );
  }

  // ---- Batch 2: work orders 2024–2026 (verified; last three still Linked) ----
  const UNVERIFIED_AFTER = new Date('2026-06-01');
  for (const s of serviceEvents) {
    const p = propertyOf(s.propertyId);
    const e = equipmentOf(s.equipmentId);
    const stage: PipelineStage = s.date >= UNVERIFIED_AFTER ? 'linked' : 'verified';
    const fields: ExtractedField[] = [
      field('Service address', `${p.address}, ${p.city}`, 1, 0.98, { entityId: p.id, field: 'address' }),
      field('Customer', p.customerName, 1, 0.95, { entityId: p.id, field: 'customerName' }),
      field('Date', iso(s.date), 1, 0.99, { entityId: s.id, field: 'date' }),
      field('Technician', s.technicianName, 1, 0.96, { entityId: s.id, field: 'technicianName' }),
      field('Serial No.', e.serialNumber, 1, 0.94, { entityId: e.id, field: 'serial' }),
      field('Model', e.modelNumber, 1, 0.92, { entityId: e.id, field: 'model' }),
      field('Work performed', s.workPerformed, 1, 0.97, { entityId: s.id, field: 'workPerformed' }),
      field('Notes', s.notes, 2, 0.9, { entityId: s.id, field: 'notes' }),
      field('Total', money(s.cost), 2, 0.98, { entityId: s.id, field: 'cost' }),
    ];
    const doc = makeDoc(
      {
        id: `doc-wo-${s.id}`,
        filename: `WO-${iso(s.date).replace(/-/g, '')}-${slug(p.address).slice(0, 18)}.pdf`,
        fileType: 'pdf',
        pages: 2,
        batchId: BATCH_WORK_ORDERS,
        source: 'drive',
        receivedAt: new Date('2026-09-01T08:30:00'),
        typeId: 'work-order',
        stage,
        extracted: fields,
        linkedEntityIds: [s.id, e.id, p.id, s.technicianId],
      },
      `Work Order ${s.id}`,
    );
    if (stage === 'verified') {
      doc.verifiedBy = OFFICE;
      doc.verifiedAt = new Date('2026-09-04T11:05:00');
    }
    docs.push(doc);
  }

  // ---- Batch 3: truck photos, Sept 2026 (the messy one) ----
  const truck = (id: string, filename: string, fileType: Doc['fileType'], receivedAt: string) => ({
    id,
    filename,
    fileType,
    pages: 1,
    batchId: BATCH_TRUCK,
    source: 'truck' as IntakeSource,
    receivedAt: new Date(receivedAt),
  });

  // Conflict 1 — nameplate serial disagrees with the registration for EQ003
  {
    const e = equipmentOf('EQ003');
    const p = propertyOf(e.propertyId);
    const doc = makeDoc(
      {
        ...truck('doc-np-EQ003', 'IMG_4402_nameplate.jpg', 'image', '2026-09-10T14:02:00'),
        typeId: 'nameplate-photo',
        stage: 'linked',
        extracted: [
          field('Serial No.', 'SN-CAR-567898', 1, 0.71, { entityId: e.id, field: 'serial' }, 'nameplate, lower left'),
          field('Model', e.modelNumber, 1, 0.9, { entityId: e.id, field: 'model' }),
          field('Manufacturer', e.manufacturer, 1, 0.97, { entityId: e.id, field: 'manufacturer' }),
        ],
        linkedEntityIds: [e.id, p.id],
        linkConfidence: 0.86,
        issues: [{ kind: 'conflict', conflictId: 'conflict-EQ003-serial' }],
      },
      'Nameplate photo — Carrier condenser',
    );
    docs.push(doc);
    conflicts.push({
      id: 'conflict-EQ003-serial',
      entityId: e.id,
      field: 'serial',
      candidates: [
        { value: e.serialNumber, documentId: 'doc-wr-EQ003', location: { page: 1, field: 'Serial No.' } },
        { value: 'SN-CAR-567898', documentId: 'doc-np-EQ003', location: { page: 1, field: 'nameplate, lower left' } },
      ],
    });
  }

  // Conflict 2 — nameplate model has a suffix the registration lacks (EQ013)
  {
    const e = equipmentOf('EQ013');
    const p = propertyOf(e.propertyId);
    docs.push(
      makeDoc(
        {
          ...truck('doc-np-EQ013', 'IMG_4419_nameplate.jpg', 'image', '2026-09-10T14:31:00'),
          typeId: 'nameplate-photo',
          stage: 'linked',
          extracted: [
            field('Serial No.', e.serialNumber, 1, 0.95, { entityId: e.id, field: 'serial' }),
            field('Model', 'RHEEM-2000H', 1, 0.83, { entityId: e.id, field: 'model' }, 'nameplate, model line'),
          ],
          linkedEntityIds: [e.id, p.id],
          linkConfidence: 0.95,
          issues: [{ kind: 'conflict', conflictId: 'conflict-EQ013-model' }],
        },
        'Nameplate photo — Rheem heat pump',
      ),
    );
    conflicts.push({
      id: 'conflict-EQ013-model',
      entityId: e.id,
      field: 'model',
      candidates: [
        { value: e.modelNumber, documentId: 'doc-wr-EQ013', location: { page: 1, field: 'Model' } },
        { value: 'RHEEM-2000H', documentId: 'doc-np-EQ013', location: { page: 1, field: 'nameplate, model line' } },
      ],
    });
  }

  // Clean nameplate, linked but not yet verified (EQ010)
  {
    const e = equipmentOf('EQ010');
    docs.push(
      makeDoc(
        {
          ...truck('doc-np-EQ010', 'IMG_4433_nameplate.jpg', 'image', '2026-09-10T15:10:00'),
          typeId: 'nameplate-photo',
          stage: 'linked',
          extracted: [
            field('Serial No.', e.serialNumber, 1, 0.97, { entityId: e.id, field: 'serial' }),
            field('Model', e.modelNumber, 1, 0.96, { entityId: e.id, field: 'model' }),
          ],
          linkedEntityIds: [e.id, e.propertyId],
          linkConfidence: 0.97,
        },
        'Nameplate photo — Lennox XP15',
      ),
    );
  }

  // Missing required field: work order with no technician (blocked at Classified)
  {
    const p = propertyOf('PROP006');
    docs.push(
      makeDoc(
        {
          ...truck('doc-wo-gap-PROP006', 'IMG_4451_workorder.jpg', 'image', '2026-09-10T15:44:00'),
          typeId: 'work-order',
          stage: 'classified',
          extracted: [
            field('Service address', `${p.address}, ${p.city}`, 1, 0.93),
            field('Date', '2026-09-03', 1, 0.9),
            field('Work performed', 'Replaced run capacitor, checked charge', 1, 0.88),
            field('Total', '$310', 1, 0.86),
          ],
          linkedEntityIds: [],
          issues: [{ kind: 'missing-field', field: 'Technician' }],
        },
        'Work order (handwritten)',
      ),
    );
  }

  // Missing required field: invoice photo with no total visible
  {
    const p = propertyOf('PROP002');
    docs.push(
      makeDoc(
        {
          ...truck('doc-inv-gap-PROP002', 'IMG_4458_invoice.jpg', 'image', '2026-09-10T15:52:00'),
          typeId: 'invoice',
          stage: 'classified',
          extracted: [
            field('Service address', `${p.address}, ${p.city}`, 1, 0.91),
            field('Date', '2026-08-29', 1, 0.87),
            field('Customer', p.customerName, 1, 0.9),
          ],
          linkedEntityIds: [],
          issues: [{ kind: 'missing-field', field: 'Total' }],
        },
        'Invoice (photo, bottom cut off)',
      ),
    );
  }

  // Unlinked inbox (5): extracted, but we can't attach them confidently
  docs.push(
    makeDoc(
      {
        ...truck('doc-unl-note-thunderbird', 'IMG_4460_note.jpg', 'image', '2026-09-10T16:01:00'),
        typeId: 'work-order',
        stage: 'extracted',
        extracted: [
          field('Service address', '…Thunderbird Rd (partial)', 1, 0.52),
          field('Date', '2026-09-08', 1, 0.8),
          field('Technician', 'Carlos', 1, 0.7),
          field('Work performed', 'Cleared condensate line', 1, 0.85),
        ],
        linkedEntityIds: [],
        linkConfidence: 0.55,
        issues: [{ kind: 'unlinked', bestGuess: 'PROP004', confidence: 0.55 }],
      },
      'Handwritten service note',
    ),
    makeDoc(
      {
        ...truck('doc-unl-startup-york', 'StartupSheet_YRK_990011.pdf', 'pdf', '2026-09-10T16:05:00'),
        typeId: 'startup-sheet',
        stage: 'extracted',
        extracted: [
          field('Serial No.', 'SN-YRK-990011', 1, 0.96),
          field('Model', 'YCG36', 1, 0.94),
          field('Date', '2026-09-02', 1, 0.93),
          field('Technician', 'Maria Santos', 1, 0.95),
        ],
        linkedEntityIds: [],
        linkConfidence: 0.1,
        issues: [{ kind: 'unlinked', confidence: 0.1 }],
      },
      'York startup sheet — serial not in records',
    ),
    makeDoc(
      {
        ...truck('doc-unl-permit-alma', 'Permit_2026-1187.pdf', 'pdf', '2026-09-10T16:09:00'),
        typeId: 'permit',
        stage: 'extracted',
        extracted: [
          field('Service address', '1523 Alma School', 1, 0.8),
          field('Permit No.', 'MES-2026-1187', 1, 0.97),
          field('Date', '2026-08-25', 1, 0.95),
        ],
        linkedEntityIds: [],
        linkConfidence: 0.62,
        issues: [{ kind: 'unlinked', bestGuess: 'PROP003', confidence: 0.62 }],
      },
      'City of Mesa mechanical permit',
    ),
    makeDoc(
      {
        ...truck('doc-unl-agreement-plaza', 'MaintAgreement_OfficePlaza_2026.pdf', 'pdf', '2026-09-10T16:15:00'),
        typeId: 'maintenance-agreement',
        stage: 'extracted',
        extracted: [
          field('Customer', 'Office Plaza', 1, 0.88),
          field('Service address', 'Broadway Rd, Mesa', 1, 0.6),
          field('Term', '12 months from 2026-10-01', 1, 0.92),
        ],
        linkedEntityIds: [],
        linkConfidence: 0.58,
        issues: [{ kind: 'unlinked', bestGuess: 'PROP005', confidence: 0.58 }],
      },
      'Maintenance agreement',
    ),
    makeDoc(
      {
        ...truck('doc-unl-invoice-scan', 'invoice_scan_0092.jpg', 'image', '2026-09-10T16:20:00'),
        typeId: 'invoice',
        stage: 'extracted',
        extracted: [
          field('Service address', '8765 Thunderbird', 1, 0.66),
          field('Date', '2026-07-30', 1, 0.9),
          field('Total', '$215', 1, 0.93),
        ],
        linkedEntityIds: [],
        linkConfidence: 0.6,
        issues: [{ kind: 'unlinked', bestGuess: 'PROP004', confidence: 0.6 }],
      },
      'Invoice scan',
    ),
  );

  // Received, not yet classified
  docs.push(
    makeDoc(
      {
        ...truck('doc-rcv-IMG_4471', 'IMG_4471.jpg', 'image', '2026-09-10T16:25:00'),
        typeId: null,
        stage: 'received',
        extracted: [],
        linkedEntityIds: [],
      },
      'Photo (unclassified)',
    ),
  );

  // Duplicate: the same 2026-08-08 work order uploaded again from the truck
  docs.push(
    makeDoc(
      {
        ...truck('doc-dup-SVC-20260808-001', 'WO-20260808-4521-e-camelback-rd (1).pdf', 'pdf', '2026-09-10T16:30:00'),
        typeId: 'work-order',
        stage: 'received',
        extracted: [],
        linkedEntityIds: [],
        issues: [{ kind: 'duplicate', of: 'doc-wo-SVC-20260808-001' }],
      },
      'Work Order SVC-20260808-001 (duplicate upload)',
    ),
  );

  const batches: Batch[] = [
    {
      id: BATCH_CABINET,
      name: 'Camelback cabinet — installs 2016–2023',
      source: 'cabinet',
      dateRange: { from: new Date('2016-06-01'), to: new Date('2023-07-31') },
      createdAt: new Date('2026-08-20T09:00:00'),
      createdBy: OFFICE,
      documentIds: docs.filter((d) => d.batchId === BATCH_CABINET).map((d) => d.id),
    },
    {
      id: BATCH_WORK_ORDERS,
      name: 'Work orders 2024–2026',
      source: 'drive',
      dateRange: { from: new Date('2024-09-01'), to: new Date('2026-08-31') },
      createdAt: new Date('2026-09-01T08:15:00'),
      createdBy: OFFICE,
      documentIds: docs.filter((d) => d.batchId === BATCH_WORK_ORDERS).map((d) => d.id),
    },
    {
      id: BATCH_TRUCK,
      name: 'Truck photos — Sept 2026',
      source: 'truck',
      dateRange: { from: new Date('2026-07-01'), to: new Date('2026-09-10') },
      createdAt: new Date('2026-09-10T14:00:00'),
      createdBy: 'Carlos Rodriguez',
      documentIds: docs.filter((d) => d.batchId === BATCH_TRUCK).map((d) => d.id),
    },
  ];

  return { docs, batches, conflicts };
}
