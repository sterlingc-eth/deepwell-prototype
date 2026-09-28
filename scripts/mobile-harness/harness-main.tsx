// See index.html's comment. Round 17 (UX-M) mobile UX verification harness.
// Side-effects only (window hooks, graph seed, fetch stub) — the components
// themselves live in Fixtures.tsx so oxlint's react-refresh rule is happy.
import { createRoot } from 'react-dom/client'
import { useGraph } from '../../src/core/entityGraph'
import { useAppStore } from '../../src/store/appStore'
import { hvacSchema } from '../../src/domains/hvac/schema'
import type { Doc, Entity } from '../../src/core/types'
import { CUSTOMER_ID, DOC_ID } from './fixtures-data'
import { CitationScenes, Shell } from './Fixtures'
import '../../src/index.css'
import '../../src/mobile/mobile.css'

declare global {
  interface Window {
    __dwSetField?: (on: boolean) => void
  }
}
window.__dwSetField = (on: boolean) => useAppStore.getState().setFieldMode(on)
window.__dwOpens = []

/* ------------------------------------------------------------- fixtures -- */
const customer: Entity = {
  id: CUSTOMER_ID,
  type: 'customer',
  fields: { name: 'Carol Rios', address: '2847 N 24th St, Mesa, AZ 85213' },
}

const doc: Doc = {
  id: DOC_ID,
  filename: 'carol-warranty.pdf',
  fileType: 'pdf',
  pages: 1,
  batchId: 'harness-batch',
  source: 'drive',
  receivedAt: new Date('2026-06-12T00:00:00Z'),
  typeId: 'warranty-registration',
  stage: 'verified',
  // Required on Doc (src/core/types.ts) — was missing here, which this
  // harness's own scripts/tsx transpile-only tooling never catches (no
  // tsconfig here is type-checked; see tsconfig.app.json's "include": ["src"]).
  // A doc with no preview isn't a fixture-only case either: it crashed
  // src/domains/hvac/answer.ts's closestDocs() for real (round 23, M1 —
  // fixed there too) the moment a query's tokens matched this doc's filename
  // with no direct fact to answer from.
  preview: 'Trane XR16 outdoor unit, warranty registration for Carol Rios at 2847 N 24th St, Mesa, AZ 85213.',
  extracted: [
    { name: 'brand', value: 'Trane', confidence: 0.95, location: {} },
    { name: 'model', value: 'XR16', confidence: 0.95, location: {} },
  ],
  linkedEntityIds: [CUSTOMER_ID],
  linkConfidence: 0.95,
  issues: [],
}

useGraph.getState().seed(hvacSchema, [customer], [doc], [], [])

/* ------------------------------------------------------------ mocked API -- */
// Every network call the mounted components can make, offline-first: fetch is
// stubbed at the global level (Playwright's page.route covers real network
// requests too, but a jsdom-free Vite dev build talks straight to `fetch`,
// so both layers are covered — see verify-mobile-ux.mjs for the page.route side).
const originalFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
  // Only DocSheet's "get the original" read (getOriginalUrl, `mode: 'get'`)
  // is handled here — ScanTab's own upload calls to this SAME path (create/
  // put, no `mode` or a different one) fall through to the real network,
  // where verify-mobile-ux.mjs's page.route fake server (same shape as
  // scripts/verify-offline-queue-ui.mjs's) owns them.
  if (url.startsWith('/api/upload-url') && init?.body) {
    try {
      const body = JSON.parse(String(init.body))
      if (body.mode === 'get') {
        return new Response(
          JSON.stringify({ url: 'about:blank', contentType: 'application/pdf', filename: doc.filename, expiresIn: 300 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
    } catch {
      /* not JSON — let it fall through */
    }
  }
  if (url.startsWith('/api/v1/customer?')) {
    const params = new URLSearchParams(url.split('?')[1])
    if (params.get('id') === CUSTOMER_ID) {
      return new Response(
        JSON.stringify({
          customer: { id: CUSTOMER_ID, customerNumber: 'C-00042', name: 'Carol Rios', serviceAddress: '2847 N 24th St, Mesa, AZ 85213', phone: '480-555-0148', email: 'carol@example.com', notes: null, billingAddress: null, formerNumbers: [] },
          equipment: [],
          documents: [],
          timeline: [],
          duplicates: [],
          alertCount: 0,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
  }
  return originalFetch(input as RequestInfo, init)
}

// /api/v1/intake-status and /api/account (DocIntakeCard's own reads/writes)
// are deliberately NOT stubbed above — they fall through to the real
// network, where verify-mobile-ux.mjs's page.route mock owns them, so that
// script can flip the queue from "one open question" to "resolved" between
// steps without this file knowing anything about that state machine.

/* --------------------------------------------------------------- render -- */
const params = new URLSearchParams(window.location.search)
const scene = params.get('scene') === 'citations' ? 'citations' : 'shell'

const root = document.getElementById('root')
if (root) createRoot(root).render(scene === 'citations' ? <CitationScenes /> : <Shell />)
