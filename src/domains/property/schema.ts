import type { DomainSchema } from '../../core/types';
import { DOCUMENT_TYPES, REQUIRED_FIELDS } from './documentTypes';

export { FIELD_LABELS, fieldLabel, requirementLabel } from './documentTypes';

/**
 * Property management adapter — SCAFFOLD (see
 * handoffs/INDUSTRY_EXPANSION_2026-09-21.md). Registered in ../registry.ts,
 * not bootstrapped anywhere — see src/domains/electrical/schema.ts's header
 * for why.
 *
 * The biggest schema delta of the three new domains: hvac's entity model
 * (property/equipment/customer/technician/service) assumes one paying
 * customer per property. Property management needs a `unit` sub-entity
 * (an apartment/suite inside a property), a `lease`/`tenant` pair with no
 * hvac equivalent at all, and external `vendor`s in place of W2
 * `technician`s. Only `equipment` (renamed conceptually to "appliance") and
 * the general shape of `service` carry over with minimal change.
 */
export const propertySchema: DomainSchema = {
  id: 'property',
  label: 'Property management',
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
        { key: 'ownerName', label: 'Owner', kind: 'text' },
        { key: 'ownerId', label: 'Owner record', kind: 'ref', refType: 'customer' },
        { key: 'unitsCount', label: 'Units', kind: 'number' },
      ],
    },
    {
      // No hvac equivalent — one property has many units, each with its own
      // tenant/lease/occupancy status. hvac has no concept below "property".
      id: 'unit',
      label: 'Unit',
      labelPlural: 'Units',
      labelField: 'unitNumber',
      fields: [
        { key: 'unitNumber', label: 'Unit', kind: 'text' },
        { key: 'propertyId', label: 'Property', kind: 'ref', refType: 'property' },
        { key: 'bedBath', label: 'Bed/bath', kind: 'text' },
        { key: 'rentAmount', label: 'Rent', kind: 'money' },
        { key: 'occupancyStatus', label: 'Status', kind: 'text' }, // occupied | vacant | turning
        { key: 'tenantId', label: 'Tenant', kind: 'ref', refType: 'tenant' },
        { key: 'leaseId', label: 'Lease', kind: 'ref', refType: 'lease' },
      ],
    },
    {
      // No hvac equivalent.
      id: 'tenant',
      label: 'Tenant',
      labelPlural: 'Tenants',
      labelField: 'name',
      fields: [
        { key: 'name', label: 'Name', kind: 'text' },
        { key: 'phone', label: 'Phone', kind: 'text' },
        { key: 'email', label: 'Email', kind: 'text' },
      ],
    },
    {
      // No hvac equivalent.
      id: 'lease',
      label: 'Lease',
      labelPlural: 'Leases',
      labelField: 'unitId',
      fields: [
        { key: 'unitId', label: 'Unit', kind: 'ref', refType: 'unit' },
        { key: 'tenantId', label: 'Tenant', kind: 'ref', refType: 'tenant' },
        { key: 'leaseStart', label: 'Start', kind: 'date' },
        { key: 'leaseEnd', label: 'End', kind: 'date' },
        { key: 'rentAmount', label: 'Rent', kind: 'money' },
        { key: 'securityDeposit', label: 'Security deposit', kind: 'money' },
        { key: 'status', label: 'Status', kind: 'text' }, // active | expiring | expired | renewed
      ],
    },
    {
      // Schema delta from hvac's equipment: same nameplate shape
      // (serial/model/manufacturer/installDate/warrantyExpiry), scoped to a
      // unit instead of a property — the one entity type that carries over
      // almost unchanged.
      id: 'equipment',
      label: 'Appliance',
      labelPlural: 'Appliances',
      labelField: 'serial',
      fields: [
        { key: 'serial', label: 'Serial', kind: 'serial' },
        { key: 'model', label: 'Model', kind: 'text' },
        { key: 'manufacturer', label: 'Manufacturer', kind: 'text' },
        { key: 'equipmentType', label: 'Type', kind: 'text' }, // hvac-unit | water-heater | range | dishwasher | washer-dryer
        { key: 'installDate', label: 'Installed', kind: 'date' },
        { key: 'warrantyExpiry', label: 'Warranty expires', kind: 'date' },
        { key: 'unitId', label: 'Unit', kind: 'ref', refType: 'unit' },
        { key: 'propertyId', label: 'Property', kind: 'ref', refType: 'property' },
      ],
    },
    {
      // Replaces hvac's `customer` (paying owner of the equipment) — here
      // the analogous party is the property's owner, a DeepWell PM
      // customer's client, not the end occupant (that's `tenant`).
      id: 'customer',
      label: 'Owner',
      labelPlural: 'Owners',
      labelField: 'name',
      fields: [
        { key: 'name', label: 'Name', kind: 'text' },
        { key: 'type', label: 'Type', kind: 'text' },
      ],
    },
    {
      // Replaces hvac's `technician` — an external vendor, not a W2 tech;
      // adds coiExpiry, a compliance date with no hvac equivalent.
      id: 'vendor',
      label: 'Vendor',
      labelPlural: 'Vendors',
      labelField: 'name',
      fields: [
        { key: 'name', label: 'Name', kind: 'text' },
        { key: 'trade', label: 'Trade', kind: 'text' },
        { key: 'phone', label: 'Phone', kind: 'text' },
        { key: 'coiExpiry', label: 'COI expires', kind: 'date' },
      ],
    },
    {
      id: 'service',
      label: 'Service visit',
      labelPlural: 'Service visits',
      labelField: 'workPerformed',
      fields: [
        { key: 'date', label: 'Date', kind: 'date' },
        { key: 'vendorId', label: 'Vendor', kind: 'ref', refType: 'vendor' },
        { key: 'vendorName', label: 'Vendor', kind: 'text' },
        { key: 'equipmentId', label: 'Appliance', kind: 'ref', refType: 'equipment' },
        { key: 'unitId', label: 'Unit', kind: 'ref', refType: 'unit' },
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
