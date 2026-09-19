import type { DomainSchema } from '../../core/types';
import { DOCUMENT_TYPES, REQUIRED_FIELDS } from './documentTypes';

export { FIELD_LABELS, fieldLabel, requirementLabel } from './documentTypes';

/**
 * HVAC adapter — the first vertical.
 * Everything domain-specific about entities and documents is declared here.
 */
export const hvacSchema: DomainSchema = {
  id: 'hvac',
  label: 'HVAC',
  fallbackDocumentType: 'other',
  entityTypes: [
    {
      id: 'property',
      label: 'Property',
      labelPlural: 'Properties',
      labelField: 'address',
      fields: [
        { key: 'address', label: 'Address', kind: 'text' },
        { key: 'city', label: 'City', kind: 'text' },
        { key: 'state', label: 'State', kind: 'text' },
        { key: 'zip', label: 'ZIP', kind: 'text' },
        { key: 'customerName', label: 'Customer', kind: 'text' },
        { key: 'customerId', label: 'Customer record', kind: 'ref', refType: 'customer' },
      ],
    },
    {
      id: 'equipment',
      label: 'Equipment',
      labelPlural: 'Equipment',
      labelField: 'serial',
      fields: [
        { key: 'serial', label: 'Serial', kind: 'serial' },
        { key: 'model', label: 'Model', kind: 'text' },
        { key: 'manufacturer', label: 'Manufacturer', kind: 'text' },
        { key: 'equipmentType', label: 'Type', kind: 'text' },
        { key: 'installDate', label: 'Installed', kind: 'date' },
        { key: 'installedBy', label: 'Installed by', kind: 'ref', refType: 'technician' },
        { key: 'installedByName', label: 'Installed by', kind: 'text' },
        { key: 'warrantyExpiry', label: 'Warranty expires', kind: 'date' },
        { key: 'propertyId', label: 'Location', kind: 'ref', refType: 'property' },
      ],
    },
    {
      id: 'customer',
      label: 'Customer',
      labelPlural: 'Customers',
      labelField: 'name',
      fields: [
        { key: 'name', label: 'Name', kind: 'text' },
        { key: 'type', label: 'Type', kind: 'text' },
      ],
    },
    {
      id: 'technician',
      label: 'Technician',
      labelPlural: 'Technicians',
      labelField: 'name',
      fields: [
        { key: 'name', label: 'Name', kind: 'text' },
        { key: 'specialty', label: 'Specialty', kind: 'text' },
        { key: 'certifications', label: 'Certifications', kind: 'text' },
        { key: 'phone', label: 'Phone', kind: 'text' },
      ],
    },
    {
      id: 'service',
      label: 'Service visit',
      labelPlural: 'Service visits',
      labelField: 'workPerformed',
      fields: [
        { key: 'date', label: 'Date', kind: 'date' },
        { key: 'technicianId', label: 'Technician', kind: 'ref', refType: 'technician' },
        { key: 'technicianName', label: 'Technician', kind: 'text' },
        { key: 'equipmentId', label: 'Equipment', kind: 'ref', refType: 'equipment' },
        { key: 'propertyId', label: 'Property', kind: 'ref', refType: 'property' },
        { key: 'workPerformed', label: 'Work performed', kind: 'text' },
        { key: 'cost', label: 'Cost', kind: 'money' },
        { key: 'notes', label: 'Notes', kind: 'text' },
      ],
    },
  ],
  // The 15 canonical ids/labels (handoffs/TEAM_BRIEF_2026-09-19.md), each
  // paired with its required extraction field_keys (REQUIRED_FIELDS entries
  // may contain `a|b` alternatives — see core/entityGraph.ts).
  documentTypes: DOCUMENT_TYPES.map((t) => ({
    id: t.id,
    label: t.label,
    requiredFields: REQUIRED_FIELDS[t.id] ?? [],
  })),
};

/**
 * Maps both the old demo display labels ("Serial No.") and the real
 * extraction field_keys ("serial_number") to entity field keys. Real synced
 * documents' `doc.extracted[].name` is always a field_key (see
 * usePostgresSync.ts's toDoc); the HVAC demo fixture (seed.ts) and manual
 * gap-filling in ReviewScreen used the old display-label strings, kept here
 * so neither breaks.
 */
export const HVAC_FIELD_ALIASES: Record<string, string> = {
  // Legacy display labels (demo fixture only)
  'Serial No.': 'serial',
  Model: 'model',
  Manufacturer: 'manufacturer',
  'Install date': 'installDate',
  'Warranty expires': 'warrantyExpiry',
  'Service address': 'address',
  Date: 'date',
  Technician: 'technicianName',
  'Work performed': 'workPerformed',
  Total: 'cost',
  Notes: 'notes',
  Customer: 'customerName',
  // Canonical extraction field_keys (real pipeline + required-field gaps)
  serial_number: 'serial',
  model: 'model',
  manufacturer: 'manufacturer',
  installation_date: 'installDate',
  warranty_expires: 'warrantyExpiry',
  warranty_term: 'warrantyExpiry',
  service_address: 'address',
  service_date: 'date',
  technician: 'technicianName',
  work_performed: 'workPerformed',
  cost: 'cost',
  notes: 'notes',
  customer_name: 'customerName',
};
