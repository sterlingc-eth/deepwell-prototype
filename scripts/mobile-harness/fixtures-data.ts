// Plain data/helpers shared between harness-main.tsx (seeds the graph, stubs
// fetch) and Fixtures.tsx (the components) — kept out of both so neither one
// mixes component and non-component exports (oxlint's react-refresh rule).
export const CUSTOMER_ID = '33333333-3333-4333-8333-000000000001'
export const DOC_ID = '44444444-4444-4444-8444-000000000001'

declare global {
  interface Window {
    __dwOpens?: string[]
  }
}

/** Every fixture callback (onOpenDoc/onOpenCustomer) funnels here so
 *  verify-mobile-ux.mjs can assert an interaction actually fired — same
 *  technique scripts/answer-harness/fixtures.ts's noteOpen() uses. */
export function note(label: string): void {
  window.__dwOpens!.push(label)
}
