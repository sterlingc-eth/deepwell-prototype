import type { DomainSchema, FieldSpec } from '../../core/types';

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

/**
 * Tier-0 registry metadata every shipped field carries in the open schema
 * (v2): tier 0 (core, shipped by DeepWell), a starting synonym set drawn
 * from `HVAC_FIELD_ALIASES` plus a few realistic real-world label variants
 * per field (so the mapping pass has more than one printed label to match
 * against on day one), zero observations, and schema version 0 (the
 * shipped baseline every later `SchemaVersionRow` counts up from).
 */
function tier0(key: string, extraSynonyms: string[] = []): Pick<FieldSpec, 'tier' | 'synonyms' | 'observationCount' | 'addedInSchemaVersion'> {
  const printed = Object.entries(HVAC_FIELD_ALIASES)
    .filter(([, k]) => k === key)
    .map(([label]) => label);
  return {
    tier: 0,
    synonyms: Array.from(new Set([...printed, ...extraSynonyms])),
    observationCount: 0,
    addedInSchemaVersion: 0,
  };
}

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
        { key: 'address', label: 'Address', kind: 'text', ...tier0('address', ['Property Address', 'Site Address', 'Job Address']) },
        { key: 'city', label: 'City', kind: 'text', ...tier0('city', ['City']) },
        { key: 'state', label: 'State', kind: 'text', ...tier0('state', ['State', 'ST']) },
        { key: 'zip', label: 'ZIP', kind: 'text', ...tier0('zip', ['ZIP', 'Zip Code', 'Postal Code']) },
        { key: 'customerName', label: 'Customer', kind: 'text', ...tier0('customerName', ['Customer Name', 'Client', 'Account Name']) },
        { key: 'customerId', label: 'Customer record', kind: 'ref', refType: 'customer', ...tier0('customerId') },
      ],
    },
    {
      id: 'equipment',
      label: 'Equipment',
      labelPlural: 'Equipment',
      labelField: 'serial',
      fields: [
        // High-consequence: the identifier a manufacturer claim packet hands to the manufacturer. A misread
        // serial is a rejected claim, not a shrug. Never auto-verify.
        { key: 'serial', label: 'Serial', kind: 'serial', consequence: 'high', ...tier0('serial', ['S/N', 'Serial Number', 'Ser#', 'SN']) },
        { key: 'model', label: 'Model', kind: 'text', ...tier0('model', ['Model No.', 'Model #', 'MODEL']) },
        { key: 'manufacturer', label: 'Manufacturer', kind: 'text', ...tier0('manufacturer', ['Mfr', 'Mfr.', 'Make', 'Brand']) },
        { key: 'equipmentType', label: 'Type', kind: 'text', ...tier0('equipmentType', ['Equipment Type', 'Unit Type']) },
        { key: 'installDate', label: 'Installed', kind: 'date', ...tier0('installDate', ['Date Installed', 'Installation Date']) },
        { key: 'installedBy', label: 'Installed by', kind: 'ref', refType: 'technician', ...tier0('installedBy') },
        { key: 'installedByName', label: 'Installed by', kind: 'text', ...tier0('installedByName', ['Installer', 'Installed By']) },
        // High-consequence: a wrong warranty date can cost a customer a covered repair, or cost DeepWell's
        // customer a claim they were entitled to. Never auto-verify — see claude/INGESTION_STRATEGY_AT_SCALE.md, layer 1.
        { key: 'warrantyExpiry', label: 'Warranty expires', kind: 'date', consequence: 'high', ...tier0('warrantyExpiry', ['Warranty Expiration', 'Warranty End Date', 'Warranty Exp.']) },
        { key: 'propertyId', label: 'Location', kind: 'ref', refType: 'property', ...tier0('propertyId') },
      ],
    },
    {
      id: 'customer',
      label: 'Customer',
      labelPlural: 'Customers',
      labelField: 'name',
      fields: [
        { key: 'name', label: 'Name', kind: 'text', ...tier0('name', ['Customer Name', 'Client Name']) },
        { key: 'type', label: 'Type', kind: 'text', ...tier0('type', ['Customer Type', 'Account Type']) },
      ],
    },
    {
      id: 'technician',
      label: 'Technician',
      labelPlural: 'Technicians',
      labelField: 'name',
      fields: [
        { key: 'name', label: 'Name', kind: 'text', ...tier0('name', ['Tech Name', 'Technician Name']) },
        { key: 'specialty', label: 'Specialty', kind: 'text', ...tier0('specialty', ['Specialty', 'Trade']) },
        { key: 'certifications', label: 'Certifications', kind: 'text', ...tier0('certifications', ['Certs', 'Certifications']) },
        { key: 'phone', label: 'Phone', kind: 'text', ...tier0('phone', ['Phone Number', 'Tel', 'Cell']) },
      ],
    },
    {
      id: 'service',
      label: 'Service visit',
      labelPlural: 'Service visits',
      labelField: 'workPerformed',
      fields: [
        // Medium-consequence (explicit, matching claude/INGESTION_STRATEGY_AT_SCALE.md's own examples): a
        // single misread is exactly the failure mode aggregate accuracy hides, but the fix isn't "never auto" —
        // it's "not on the strength of one document alone." See autoverify.ts.
        { key: 'date', label: 'Date', kind: 'date', consequence: 'medium', ...tier0('date', ['Service Date', 'Date of Service']) },
        { key: 'technicianId', label: 'Technician', kind: 'ref', refType: 'technician', ...tier0('technicianId') },
        { key: 'technicianName', label: 'Technician', kind: 'text', consequence: 'medium', ...tier0('technicianName', ['Tech', 'Technician Name']) },
        { key: 'equipmentId', label: 'Equipment', kind: 'ref', refType: 'equipment', ...tier0('equipmentId') },
        { key: 'propertyId', label: 'Property', kind: 'ref', refType: 'property', ...tier0('propertyId') },
        // Low-consequence: freeform description, not a fact anyone acts on directly. Fine to auto-verify from day one.
        { key: 'workPerformed', label: 'Work performed', kind: 'text', consequence: 'low', ...tier0('workPerformed', ['Description of Work', 'Services Rendered', 'Work Description']) },
        { key: 'cost', label: 'Cost', kind: 'money', consequence: 'medium', ...tier0('cost', ['Total Due', 'Amount Due', 'Total Cost']) },
        { key: 'notes', label: 'Notes', kind: 'text', consequence: 'low', ...tier0('notes', ['Comments', 'Remarks']) },
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
