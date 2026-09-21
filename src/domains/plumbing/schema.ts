import type { DomainSchema } from '../../core/types';
import { DOCUMENT_TYPES, REQUIRED_FIELDS } from './documentTypes';

export { FIELD_LABELS, fieldLabel, requirementLabel } from './documentTypes';

/**
 * Plumbing adapter — SCAFFOLD (see handoffs/INDUSTRY_EXPANSION_2026-09-21.md).
 * Registered in ../registry.ts, not bootstrapped anywhere — see
 * src/domains/electrical/schema.ts's header for why.
 */
export const plumbingSchema: DomainSchema = {
  id: 'plumbing',
  label: 'Plumbing',
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
      // Schema delta from hvac: adds a due-date field (nextTestDue) for
      // backflow devices — the same shape as warrantyExpiry, reused for a
      // recurring compliance date instead of a one-time coverage date.
      id: 'equipment',
      label: 'Fixture / equipment',
      labelPlural: 'Fixtures & equipment',
      labelField: 'serial',
      fields: [
        { key: 'serial', label: 'Serial', kind: 'serial' },
        { key: 'model', label: 'Model', kind: 'text' },
        { key: 'manufacturer', label: 'Manufacturer', kind: 'text' },
        { key: 'equipmentType', label: 'Type', kind: 'text' }, // water-heater | tankless | sump-pump | backflow-device | fixture | gas-line
        { key: 'installDate', label: 'Installed', kind: 'date' },
        { key: 'installedBy', label: 'Installed by', kind: 'ref', refType: 'technician' },
        { key: 'installedByName', label: 'Installed by', kind: 'text' },
        { key: 'warrantyExpiry', label: 'Warranty expires', kind: 'date' },
        { key: 'nextTestDue', label: 'Next test due', kind: 'date' }, // backflow devices only
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
        { key: 'certifications', label: 'Certifications', kind: 'text' }, // e.g. certified backflow tester
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
