/**
 * AI finish field suggestions: every string the person sees. PROPOSED wording, awaiting owner approval.
 * No price, dollar sign, "cost" (as in money) or "budget" in any of them.
 */
export const SUGGEST_TEXT = {
  suggested: (value: string) => `Suggested: ${value}`,
  chipDate: 'Suggested: pick a date',
  hint: 'Found on the page, but not under its usual label. Check it against the page, then accept.',
  hintDate: 'The page writes this date so it could be read two ways. Pick the right one.',
  fromPage: 'On the page:',
  accept: 'Accept',
  edit: 'Edit',
  dismiss: 'Dismiss',
  save: 'Save',
  cancel: 'Cancel',
  monthFirst: 'Month first',
  dayFirst: 'Day first',
  pickFirst: 'Pick a date first.',
  editLabel: (field: string) => `Correct ${field.toLowerCase()}`,
  error: "We couldn't save that just now. Try again in a moment.",
  gone: 'That suggestion was already handled.',
  found: (n: number) => (n === 1 ? 'Found 1 value for you to check.' : `Found ${n} values for you to check.`),
} as const;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** A date shown the way a person reads it ("Mar 4, 2026"); anything else is returned as it is. */
export const prettyValue = (v: string): string => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v); return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : v; };
/** The short chip on an Inbox row: "Suggested: <value>", or "Suggested: pick a date" when the page can be read two ways. */
export const chipText = (s: { value?: string; options?: string[] }): string => (s.options ? SUGGEST_TEXT.chipDate : SUGGEST_TEXT.suggested(prettyValue(s.value ?? '')));
