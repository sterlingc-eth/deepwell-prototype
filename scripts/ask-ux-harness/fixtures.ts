import type { SamplePrompt } from '../../src/core/suggestions';

/** Three distinct, deterministic "server" responses so a test can tell at a glance which one the page
 *  is showing (and, critically, whether it's showing one that belongs to a DIFFERENT tenant). */
export const FIXTURES: Record<string, SamplePrompt[]> = {
  A: [
    { id: 'a1', text: 'Is M900123 still under warranty?', category: 'warranty-serial' },
    { id: 'a2', text: 'When were we last at 214 Mercer St?', category: 'last-visit-address' },
    { id: 'a3', text: "What's the phone number on file for Marisol Vega?", category: 'contact-customer' },
  ],
  B: [
    { id: 'b1', text: 'Which warranties expire in the next 12 months?', category: 'warranty-expiring' },
    { id: 'b2', text: 'How many customers do we have on file?', category: 'customer-count' },
    { id: 'b3', text: 'What documents are on file for 900 Other Rd?', category: 'doc-count' },
  ],
  C: [{ id: 'c1', text: "Tenant C's own question — must never appear for tenant A or B", category: 'isolation-check' }],
};
