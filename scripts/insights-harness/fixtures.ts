// Canned InsightsResponse for scripts/verify-insights-ui.mjs — same technique as
// scripts/answer-harness/fixtures.ts, but for InsightsCard: six insights (one more than the
// "max 5 visible" cap) covering every severity, with and without a dollars chip, and items with
// zero/one/many source documents, so the screenshots show truncation, both pill colors, and the
// expand/source-chip rendering all in one page.
import type { Insight, InsightsResponse } from '../../src/components/insights/insightsClient';

export const FIXTURE_INSIGHTS: Insight[] = [
  {
    id: 'warranty-registration-closing',
    kind: 'warranty',
    severity: 'high',
    title: 'Registration window closing soon',
    count: 2,
    items: [
      { label: 'Trane XR16 at 2847 N 24th St — 10 days left to register', entityId: 'ent-1', documentIds: ['doc-1'] },
      { label: 'Carrier 58STA at 19 Beacon Way — 21 days left to register', entityId: 'ent-2', documentIds: ['doc-2'] },
    ],
    action: { label: 'Ask about registration deadlines', href: 'ask:Which units have a registration window closing soon?' },
  },
  {
    id: 'work-no-invoice',
    kind: 'financial',
    severity: 'high',
    title: 'Work done with no invoice',
    count: 3,
    dollars: 4820,
    items: [
      { label: '2847 N 24th St — 2 cost documents, no invoice on file', entityId: null, documentIds: ['doc-3', 'doc-4'] },
      { label: '19 Beacon Way — 1 cost document, no invoice on file', entityId: null, documentIds: ['doc-5'] },
      { label: '408 Elm Ct — 1 cost document, no invoice on file', entityId: null, documentIds: ['doc-6'] },
    ],
    action: { label: 'Ask about unbilled jobs', href: 'ask:Which jobs have cost documents but no invoice?' },
  },
  {
    id: 'overdue-receivables',
    kind: 'financial',
    severity: 'medium',
    title: 'Overdue receivables',
    count: 5,
    dollars: 12300,
    items: [
      { label: 'Beacon Dental — $6,400 overdue', entityId: 'cust-1', documentIds: ['doc-7'] },
      { label: 'Acme Plaza — $3,100 overdue', entityId: 'cust-2', documentIds: ['doc-8'] },
    ],
    action: { label: 'Ask about overdue invoices', href: 'ask:Which invoices are overdue?' },
  },
  {
    id: 'warranty-expiring-60',
    kind: 'warranty',
    severity: 'medium',
    title: 'Warranties expiring within 60 days',
    count: 4,
    items: [
      { label: 'Lennox EL16XC1 at 12 Main St — expires in 30 days', entityId: 'ent-3', documentIds: ['doc-9'] },
    ],
    action: { label: 'Ask about expiring warranties', href: 'ask:Which warranties expire in the next 60 days?' },
  },
  {
    id: 'units-missing-identifiers',
    kind: 'data-gap',
    severity: 'low',
    title: 'Units missing a serial number or model',
    count: 6,
    items: [
      { label: '408 Elm Ct — furnace has no serial number on file', entityId: 'ent-4', documentIds: [] },
    ],
    action: { label: 'Open the Inbox', href: 'inbox' },
  },
  {
    id: 'repeat-part-capacitor',
    kind: 'repeat',
    severity: 'low',
    title: 'Capacitor replaced twice on one unit',
    count: 1,
    items: [
      { label: '19 Beacon Way — capacitor replaced 2 times', entityId: 'ent-2', documentIds: ['doc-10', 'doc-11'] },
    ],
    action: { label: 'Ask about repeat repairs', href: 'ask:Which units have had the same part replaced more than once?' },
  },
  {
    id: 'quotes-not-invoiced',
    kind: 'financial',
    severity: 'low',
    title: 'Quotes waiting on an invoice',
    count: 1,
    items: [{ label: 'Acme Plaza — quote from 3 weeks ago, no invoice yet', entityId: 'cust-2', documentIds: ['doc-12'] }],
    action: { label: 'Ask about waiting quotes', href: 'ask:Do we have any quotes waiting on a customer?' },
  },
];

export const FIXTURE_RESPONSE: InsightsResponse = {
  items: FIXTURE_INSIGHTS,
  total: FIXTURE_INSIGHTS.length,
  generatedAt: new Date().toISOString(),
  cached: false,
};

export const EMPTY_RESPONSE: InsightsResponse = { items: [], total: 0, generatedAt: new Date().toISOString(), cached: false };
