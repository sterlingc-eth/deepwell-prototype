import type { DomainSchema } from '../../core/types';

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
  documentTypes: [
    { id: 'work-order', label: 'Work order', requiredFields: ['Service address', 'Date', 'Technician'] },
    { id: 'invoice', label: 'Invoice', requiredFields: ['Service address', 'Date', 'Total'] },
    { id: 'warranty-registration', label: 'Warranty registration', requiredFields: ['Serial No.', 'Model', 'Warranty expires'] },
    { id: 'startup-sheet', label: 'Startup sheet', requiredFields: ['Serial No.', 'Date', 'Technician'] },
    { id: 'permit', label: 'Permit', requiredFields: ['Service address', 'Permit No.'] },
    { id: 'nameplate-photo', label: 'Nameplate photo', requiredFields: ['Serial No.', 'Model'] },
    { id: 'maintenance-agreement', label: 'Maintenance agreement', requiredFields: ['Service address', 'Customer', 'Term'] },
    { id: 'other', label: 'Other', requiredFields: [] },
  ],
};

/** Field names as printed on documents → entity field keys. Used by the seed and by the review screen. */
export const HVAC_FIELD_ALIASES: Record<string, string> = {
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
};
