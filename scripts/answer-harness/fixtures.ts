// Fixtures for scripts/verify-answer-ui.mjs: one Answer per answerLayout() kind, plus the docs/schema
// useGraph needs to resolve document names, types and citation chips. Kept in a separate module so the
// SAME objects can be imported by the pure unit-test half of verify-answer-ui.mjs (via tsx) and by the
// harness page (via vite) without duplicating the shapes.
import type { Answer, Doc, DomainSchema } from '../../src/core/types';
import { hvacSchema } from '../../src/domains/hvac/schema';

export const SCHEMA: DomainSchema = hvacSchema;

function doc(id: string, typeId: string, filename: string, displayName?: string): Doc {
  return {
    id,
    filename,
    displayName,
    fileType: 'pdf',
    pages: 3,
    batchId: 'b1',
    source: 'email',
    receivedAt: new Date('2026-01-01'),
    typeId,
    stage: 'verified',
    extracted: [],
    linkedEntityIds: [],
    linkConfidence: 1,
    issues: [],
    preview: '',
  };
}

export const DOCS: Record<string, Doc> = {
  inv1: doc('inv1', 'invoice', '48219-scan.pdf', 'Invoice · Dana Reyes · Jun 2, 2025'),
  inv2: doc('inv2', 'invoice', '48311-scan.pdf', 'Invoice · Dana Reyes · Jul 14, 2025'),
  warr1: doc('warr1', 'warranty-registration', '90212.pdf', 'Warranty · Carrier XR16 · Mar 15, 2024'),
  wo1: doc('wo1', 'work-order', 'wo-9021.pdf', 'Work order · Spring tune-up · Mar 14, 2026'),
  wo2: doc('wo2', 'work-order', 'wo-8873.pdf', 'Work order · Furnace repair · Jan 9, 2026'),
  wo3: doc('wo3', 'work-order', 'wo-8501.pdf', 'Work order · Filter change · Sep 2, 2025'),
  reg1: doc('reg1', 'equipment-record', 'nameplate-24th.jpg', 'Equipment record · Carrier XR16'),
  reg2: doc('reg2', 'equipment-record', 'nameplate-baseline.jpg', 'Equipment record · Trane XV18'),
};

const src = (documentId: string, page?: number) => ({ documentId, location: page ? { page } : {} });

export const FIXTURES: Record<string, Answer> = {
  money: {
    kind: 'answer',
    text: "Dana Reyes' account has a $420.00 balance due on invoice 48219, unpaid since Jun 2, 2025.",
    facts: [
      { label: 'Balance due', value: '$420.00', kind: 'money', status: 'bad', sources: [src('inv1', 1)] },
      { label: 'Invoice total', value: '$620.00', kind: 'money', sources: [src('inv1', 1)] },
      { label: 'Paid so far', value: '$200.00', kind: 'money', sources: [src('inv1', 2)] },
      { label: 'Due date', value: 'Jun 2, 2025', kind: 'date', status: 'bad', sources: [src('inv1', 1)] },
    ],
    sources: [src('inv1', 1), src('inv1', 2)],
    confidence: 0.95,
    verifiedCount: 1,
    unverifiedCount: 0,
    closest: [],
    interpretation: 'Balance due for Dana Reyes',
    basis: 'Computed from the unpaid invoice on file for this customer.',
  },
  status: {
    kind: 'answer',
    text: 'The furnace at 2847 N 24th St is still under warranty.',
    facts: [
      { label: 'Warranty status', value: 'Active', status: 'ok', sources: [src('warr1', 1)] },
      { label: 'Serial number', value: 'SN-CAR-234567', kind: 'serial', sources: [src('reg1', 1)] },
      { label: 'Model', value: 'Carrier XR16', sources: [src('reg1', 1)] },
      { label: 'Warranty expires', value: '2029-03-15', kind: 'date', basis: 'computed', sources: [src('warr1', 1)] },
    ],
    sources: [src('warr1', 1), src('reg1', 1)],
    confidence: 0.92,
    verifiedCount: 2,
    unverifiedCount: 0,
    closest: [],
    interpretation: 'Warranty status for the unit at 2847 N 24th St',
    basis: 'Warranty expiry taken from the registration on file.',
  },
  list: {
    kind: 'answer',
    text: '14 customers have equipment currently under warranty.',
    facts: [],
    sources: [],
    confidence: 0.9,
    verifiedCount: 14,
    unverifiedCount: 0,
    closest: [],
    records: Array.from({ length: 14 }, (_, i) => ({
      type: 'customer' as const,
      id: `c${i + 1}`,
      label: `Customer ${i + 1}`,
      sublabel: i % 2 ? 'Active' : 'Expiring soon',
      group: i % 2 ? 'Active' : 'Expiring soon',
    })),
    recordsTotal: 19,
    recordsKind: 'basis',
    interpretation: 'Customers with active warranty coverage',
    basis: 'Counted from equipment records with a warranty expiry in the future.',
  },
  timeline: {
    kind: 'answer',
    text: 'This unit has had 3 service visits on file.',
    facts: [
      { label: 'Spring tune-up — Maria Santos', value: '2026-03-14', kind: 'date', sources: [src('wo1', 1)] },
      { label: 'Furnace repair — Carlos Rodriguez', value: '2026-01-09', kind: 'date', sources: [src('wo2', 1)] },
      { label: 'Filter change — Carlos Rodriguez', value: '2025-09-02', kind: 'date', sources: [src('wo3', 1)] },
    ],
    sources: [src('wo1', 1), src('wo2', 1), src('wo3', 1)],
    confidence: 0.9,
    verifiedCount: 3,
    unverifiedCount: 0,
    closest: [],
    interpretation: 'Service history for the unit at 2847 N 24th St',
  },
  comparison: {
    kind: 'answer',
    text: 'Both outdoor units are Carrier, but they were installed four years apart.',
    facts: [
      { label: 'Model', value: 'Carrier XR16', entityId: 'unit-a', sources: [src('reg1', 1)] },
      { label: 'Model', value: 'Carrier XR16', entityId: 'unit-b', sources: [src('reg2', 1)] },
      { label: 'Installed', value: '2021-03-15', kind: 'date', entityId: 'unit-a', sources: [src('reg1', 1)] },
      { label: 'Installed', value: '2025-06-02', kind: 'date', entityId: 'unit-b', sources: [src('reg2', 1)] },
    ],
    sources: [src('reg1', 1), src('reg2', 1)],
    confidence: 0.88,
    verifiedCount: 2,
    unverifiedCount: 0,
    closest: [],
    interpretation: 'Comparing the two outdoor units on this property',
  },
  'single-fact': {
    kind: 'answer',
    text: 'The serial number on that outdoor unit is SN-CAR-234567.',
    facts: [{ label: 'Serial number', value: 'SN-CAR-234567', kind: 'serial', sources: [src('reg1', 1)] }],
    sources: [src('reg1', 1)],
    confidence: 0.97,
    verifiedCount: 1,
    unverifiedCount: 0,
    closest: [],
    interpretation: 'Serial number for the outdoor unit at 2847 N 24th St',
  },
  explain: {
    kind: 'answer',
    text: "This unit's warranty is invalid because it was never registered within the manufacturer's 90-day window.",
    facts: [
      { label: 'Installed', value: '2024-01-10', kind: 'date', sources: [src('reg1', 1)] },
      { label: 'Registration deadline', value: '2024-04-09', kind: 'date', status: 'bad', basis: 'computed', sources: [src('reg1', 1)] },
      { label: 'Registered', value: 'No record on file', status: 'bad', sources: [src('reg1', 1)] },
    ],
    sources: [src('reg1', 1)],
    confidence: 0.85,
    verifiedCount: 1,
    unverifiedCount: 0,
    closest: [],
    interpretation: 'Why the warranty is invalid',
    basis: 'The manufacturer requires registration within 90 days of install; none is on file.',
  },
  prose: {
    kind: 'answer',
    text: 'Dana Reyes has one property on file, at 2847 N 24th St, with two pieces of equipment.',
    facts: [
      { label: 'Property', value: '2847 N 24th St', entityId: 'site-1', sources: [src('reg1', 1)] },
      { label: 'Customer type', value: 'Residential', sources: [src('reg1', 1)] },
    ],
    sources: [src('reg1', 1)],
    confidence: 0.8,
    verifiedCount: 1,
    unverifiedCount: 0,
    closest: [],
    interpretation: 'Overview for Dana Reyes',
  },
  'not-on-file': {
    kind: 'no-answer',
    text: 'Nothing on file mentions a unit at 900 W Baseline Rd.',
    facts: [],
    sources: [],
    confidence: 0,
    verifiedCount: 0,
    unverifiedCount: 1,
    closest: [src('reg2', 1), src('wo3', 1)],
    interpretation: 'Looking for equipment at 900 W Baseline Rd',
  },
};

export const LAYOUT_ORDER = ['money', 'status', 'list', 'timeline', 'comparison', 'single-fact', 'explain', 'prose', 'not-on-file'] as const;

declare global {
  interface Window {
    __dwOpens?: string[];
  }
}

/** Every fixture callback (onOpenSource/onOpenEntity/onAsk/...) funnels here so
 * scripts/verify-answer-ui.mjs can assert an interaction actually fired. */
export function noteOpen(label: string): void {
  window.__dwOpens!.push(label);
}
