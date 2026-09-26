import type { DidYouMeanChip, PreflightHint, SamplePrompt, TypeaheadItem } from '../../src/core/suggestions';

export const COMPLETIONS: TypeaheadItem[] = [
  { id: 'a', text: 'Is M900123 still under warranty?', category: 'warranty-serial' },
  { id: 'b', text: 'When were we last at 214 Mercer St?', category: 'last-visit-address' },
  { id: 'c', text: "What's the phone number on file for Marisol Vega?", category: 'contact-customer' },
  { id: 'd', text: 'How many customers do we have?', category: 'customer-count' },
];

export const INSTANT_HINT: PreflightHint = { level: 'instant', message: 'Instant answer', route: 'meta' };
export const SLOW_HINT: PreflightHint = { level: 'slow', message: 'This one may take longer', route: null };
export const NEEDS_ANCHOR_HINT: PreflightHint = { level: 'needs-anchor', message: 'Try adding a customer, address or date', route: null };

export const SAMPLE_PROMPTS: SamplePrompt[] = [
  { id: 'warranty-serial:M900123', text: 'Is M900123 still under warranty?', category: 'warranty-serial' },
  { id: 'last-visit-address:214 Mercer St', text: 'When were we last at 214 Mercer St?', category: 'last-visit-address' },
  { id: 'contact-customer:Marisol Vega', text: "What's the phone number on file for Marisol Vega?", category: 'contact-customer' },
];

export const DID_YOU_MEAN_CHIPS: DidYouMeanChip[] = [
  { text: 'What is the phone number for Marisol Vega?' },
  { text: 'What is the phone number for Marisol Vega at 214 Mercer St?' },
];
