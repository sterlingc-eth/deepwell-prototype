import type { DomainSchema } from '../../core/types';
import { DOCUMENT_TYPES, REQUIRED_FIELDS } from './documentTypes';

export { FIELD_LABELS, fieldLabel, requirementLabel } from './documentTypes';

/**
 * Electrical adapter — SCAFFOLD (see handoffs/INDUSTRY_EXPANSION_2026-09-21.md).
 *
 * Registered in ../registry.ts alongside hvacSchema, but not bootstrapped
 * anywhere: there is no domain-switch UI in DeepWell today (hvacSchema is
 * hardcoded into the real pipeline — see src/hooks/usePostgresSync.ts and
 * src/main.tsx), so nothing makes this schema reachable by a user. It exists
 * so the shape type-checks and so a future domain-switcher has something to
 * list.
 */
export const electricalSchema: DomainSchema = {
  id: 'electrical',
  label: 'Electrical',
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
      // Schema delta from hvac: a panel's nameplate carries amperage/voltage/
      // phase instead of tonnage/refrigerant. Same shape otherwise (serial,
      // model, manufacturer, install date, warranty, location).
      id: 'equipment',
      label: 'Panel / equipment',
      labelPlural: 'Panels & equipment',
      labelField: 'serial',
      fields: [
        { key: 'serial', label: 'Serial', kind: 'serial' },
        { key: 'model', label: 'Model', kind: 'text' },
        { key: 'manufacturer', label: 'Manufacturer', kind: 'text' },
        { key: 'equipmentType', label: 'Type', kind: 'text' }, // panel | sub-panel | generator | EV charger | disconnect | meter
        { key: 'amperage', label: 'Amperage', kind: 'text' },
        { key: 'voltage', label: 'Voltage', kind: 'text' },
        { key: 'phase', label: 'Phase', kind: 'text' },
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
        { key: 'specialty', label: 'Specialty', kind: 'text' }, // journeyman | master electrician | apprentice
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
  documentTypes: DOCUMENT_TYPES.map((t) => ({
    id: t.id,
    label: t.label,
    requiredFields: REQUIRED_FIELDS[t.id] ?? [],
  })),
};
