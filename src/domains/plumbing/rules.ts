/**
 * Warranty & compliance rules — plumbing (SCAFFOLD). See
 * src/domains/electrical/rules.ts's header for the pattern this follows;
 * nothing imports this file yet.
 */

export interface WarrantyRule {
  category: string;
  typicalYears: number;
  notes: string;
}

export const WARRANTY_RULES: WarrantyRule[] = [
  { category: 'labor', typicalYears: 1, notes: 'Contractor-set, not code-mandated.' },
  { category: 'tank-water-heater', typicalYears: 9, notes: 'Manufacturer tank warranty commonly 6–12 years depending on tier; parts/labor terms are usually shorter.' },
  { category: 'tankless-water-heater', typicalYears: 12, notes: 'Heat exchanger often 10–15 years; parts commonly 5 years; labor commonly 1 year.' },
  { category: 'fixture', typicalYears: 1, notes: 'Varies widely by manufacturer and fixture class.' },
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
    id: 'backflow-test-annual',
    label: 'Backflow preventer tested and reported to the water utility',
    recurring: true,
    intervalMonths: 12,
    notes: 'Most jurisdictions require annual testing (some biennial) by a certified tester, with the result filed with the local water purveyor. Structurally identical to warrantyExpiry tracking — the standout reusable feature for this vertical (see handoffs/INDUSTRY_EXPANSION_2026-09-21.md).',
  },
  {
    id: 'permit-inspection-pairing',
    label: 'Plumbing/gas permit requires a passed inspection before cover-up',
    recurring: false,
    notes: 'Same permit + inspection-report doc-type pairing hvac already uses — no schema change needed.',
  },
];
