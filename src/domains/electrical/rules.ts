/**
 * Warranty & compliance rules — electrical (SCAFFOLD).
 *
 * A new pattern: hvac has no equivalent `rules.ts` today (its warranty math
 * lives inline wherever warrantyExpiry is read). This file exists so the
 * research in handoffs/INDUSTRY_EXPANSION_2026-09-21.md has a typed home,
 * for whoever builds the electrical extraction + answer engine to consume.
 * Nothing imports this file yet — it is not wired into any pipeline.
 *
 * Figures are typical/illustrative (see the handoff's sourcing notes), not
 * contractual — every real job's warranty terms come from its own paperwork.
 */

export interface WarrantyRule {
  /** What the rule covers, e.g. 'panel', 'generator', 'labor'. */
  category: string;
  typicalYears: number;
  notes: string;
}

export const WARRANTY_RULES: WarrantyRule[] = [
  { category: 'labor', typicalYears: 1, notes: 'Contractor-set; 1–2 years is typical, not code-mandated.' },
  { category: 'breaker', typicalYears: 1, notes: 'Manufacturer part warranty; varies by brand.' },
  { category: 'panel', typicalYears: 10, notes: 'Some manufacturers (e.g. Square D, Siemens) offer longer limited warranties on the panel enclosure/busbar.' },
  { category: 'generator', typicalYears: 5, notes: 'Often paired with an hours cap (e.g. 2,000 hrs) — whichever comes first.' },
  { category: 'ev-charger', typicalYears: 3, notes: 'Residential EVSE units commonly carry 2–3 year manufacturer warranties.' },
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
    id: 'permit-inspection-pairing',
    label: 'Permit requires a passed inspection before cover-up',
    recurring: false,
    notes: 'Same permit + inspection-report doc-type pairing hvac already uses — no schema change needed.',
  },
  {
    id: 'nec-code-cycle',
    label: 'Work is governed by the NEC edition adopted at the time of permit issuance',
    recurring: false,
    notes: 'NEC updates on a 3-year cycle (2023, 2026, …). Not a per-job expiry, but useful context for "is this still compliant" questions — flagged as future work in the handoff, not built.',
  },
  {
    id: 'afci-gfci-documentation',
    label: 'AFCI/GFCI protection documented per circuit',
    recurring: false,
    notes: 'Increasingly required by code on new/renovated circuits; a natural analytics groupBy once extraction supports it.',
  },
];
