/**
 * Warranty & compliance rules — property management (SCAFFOLD). See
 * src/domains/electrical/rules.ts's header for the pattern this follows;
 * nothing imports this file yet.
 */

export interface WarrantyRule {
  category: string;
  typicalYears: number;
  notes: string;
}

export const WARRANTY_RULES: WarrantyRule[] = [
  { category: 'appliance', typicalYears: 1, notes: 'Typical manufacturer appliance warranty; varies widely by brand/tier.' },
  { category: 'hvac-unit', typicalYears: 10, notes: 'Same as the hvac domain\'s warranty math — a property\'s HVAC units are hvac equipment scoped to a unit instead of a customer.' },
  { category: 'water-heater', typicalYears: 6, notes: 'See the plumbing domain\'s rules.ts for the fuller breakdown.' },
];

export interface ComplianceRule {
  id: string;
  label: string;
  recurring: boolean;
  intervalMonths?: number;
  notes: string;
}

export const COMPLIANCE_RULES: ComplianceRule[] = [
  {
    id: 'vendor-coi-current',
    label: 'Vendor certificate of insurance is current before dispatch',
    recurring: true,
    notes: 'A vendor with a lapsed COI is a liability exposure for the management company. Same expiry-tracking mechanism as warrantyExpiry — the standout reusable feature for this vertical (see handoffs/INDUSTRY_EXPANSION_2026-09-21.md).',
  },
  {
    id: 'lease-expiry-notice',
    label: 'Lease renewal/non-renewal notice sent before the required lead time',
    recurring: false,
    notes: 'Lead time is state/local-law and lease-specific (commonly 30–90 days) — not encoded here, flagged as jurisdiction-dependent.',
  },
  {
    id: 'habitability-repair-window',
    label: 'Urgent habitability repairs (no heat, no water) actioned within the legal window',
    recurring: false,
    notes: 'Governed by state landlord-tenant law, not a fixed national rule — out of scope for this scaffold.',
  },
];
