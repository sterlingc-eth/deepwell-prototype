// Split out of harness-main.tsx so that file stays side-effects-only (window
// hooks, useGraph.seed, the fetch stub) — oxlint's react-refresh rule wants a
// component's own file to only export components (same reason
// scripts/answer-harness/Fixtures.tsx exists).
import { useCallback, useState } from 'react'
import { FileText, MessageCircle, Moon, ScanLine, Sun } from 'lucide-react'
import { useAppStore } from '../../src/store/appStore'
import type { Answer } from '../../src/core/types'
import { AskTab } from '../../src/mobile/AskTab'
import { ScanTab } from '../../src/mobile/ScanTab'
import { DocsTab } from '../../src/mobile/DocsTab'
import { DocSheet } from '../../src/mobile/DocSheet'
import { CustomerSheet } from '../../src/mobile/CustomerSheet'
import { MobileAnswer } from '../../src/mobile/MobileAnswer'
import { DOC_ID, note } from './fixtures-data'

type MobileTab = 'ask' | 'scan' | 'docs'
const LAST_TAB_KEY = 'deepwell.mobile.lastTab'

/** A trimmed stand-in for MobileApp.tsx's own header/tab-bar/sheet-routing
 *  shell (Clerk-free, since MobileApp.tsx itself hard-requires a live
 *  ClerkProvider) around the REAL tab and sheet components — same technique
 *  scripts/offline-queue-harness and scripts/records-harness use for ScanTab
 *  and DocsTab alone. Reproduces the exact header toggle + last-tab
 *  persistence MobileApp.tsx now has, so this genuinely exercises those two
 *  fixes, not a lookalike. */
export function Shell() {
  const fieldMode = useAppStore((s) => s.fieldMode)
  const setFieldMode = useAppStore((s) => s.setFieldMode)
  const [tab, setTabState] = useState<MobileTab>(() => {
    try {
      const last = window.localStorage.getItem(LAST_TAB_KEY)
      if (last === 'ask' || last === 'scan' || last === 'docs') return last
    } catch {
      /* ignore */
    }
    return 'ask'
  })
  // useCallback here (not just plain closures) matters for more than tidiness:
  // MobileApp.tsx memoizes these exact same handlers so DocRow's React.memo
  // (DocsTab.tsx) actually holds across an unrelated state change (e.g.
  // opening a sheet) instead of re-rendering every row in the list. A plain
  // inline closure here would make THIS shell re-create them every render and
  // silently defeat that memoization for anyone testing against it (round 23,
  // M1 fluidity walk) — this fixture would then be measuring its own
  // re-render churn instead of the real app's.
  const setTab = useCallback((t: MobileTab) => {
    setTabState(t)
    try {
      window.localStorage.setItem(LAST_TAB_KEY, t)
    } catch {
      /* ignore */
    }
  }, [])
  const [sheet, setSheet] = useState<{ kind: 'doc'; id: string } | { kind: 'customer'; ref: string } | null>(null)
  const openDoc = useCallback((id: string) => setSheet({ kind: 'doc', id }), [])
  const openCustomer = useCallback((ref: string) => setSheet({ kind: 'customer', ref }), [])
  const closeSheet = useCallback(() => setSheet(null), [])

  const tabs: { id: MobileTab; label: string; Icon: typeof MessageCircle }[] = [
    { id: 'ask', label: 'Ask', Icon: MessageCircle },
    { id: 'scan', label: 'Scan', Icon: ScanLine },
    { id: 'docs', label: 'Docs', Icon: FileText },
  ]

  return (
    <div className="dw-m h-[100dvh] bg-bg text-ink flex flex-col" data-testid="mobile-shell">
      <header className="dw-safe-top shrink-0 bg-surface border-b border-line/60">
        <div className="max-w-2xl mx-auto min-h-14 px-4 flex items-center justify-between gap-3">
          <span className="font-semibold">DeepWell</span>
          <button
            type="button"
            role="switch"
            aria-checked={fieldMode}
            aria-label={fieldMode ? 'Field view on. Switch to Office view' : 'Office view on. Switch to Field view'}
            onClick={() => setFieldMode(!fieldMode)}
            data-testid="theme-toggle"
            className="w-11 h-11 shrink-0 flex items-center justify-center rounded-full text-ink-3"
          >
            {fieldMode ? <Sun className="w-5 h-5" aria-hidden="true" /> : <Moon className="w-5 h-5" aria-hidden="true" />}
          </button>
        </div>
      </header>

      <main className="flex-1 min-h-0 overflow-hidden">
        <div className={tab === 'ask' ? 'h-full' : 'hidden'}>
          <AskTab onOpenDoc={openDoc} onOpenCustomer={openCustomer} billing={null} />
        </div>
        <div className={tab === 'scan' ? 'h-full' : 'hidden'}>
          <ScanTab tenantKey="harness-tenant" onUploaded={() => {}} onOpenDocs={() => setTab('docs')} onOpenDoc={openDoc} />
        </div>
        <div className={tab === 'docs' ? 'h-full' : 'hidden'}>
          <DocsTab syncStatus="ready" onOpenDoc={openDoc} onRefresh={async () => {}} />
        </div>
      </main>

      <nav className="dw-safe-bottom shrink-0 border-t border-line/60 bg-surface">
        <div className="max-w-md mx-auto grid grid-cols-3">
          {tabs.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              data-testid={`tab-${id}`}
              onClick={() => setTab(id)}
              className={`min-h-16 flex flex-col items-center justify-center gap-1 text-caption font-medium ${tab === id ? 'text-accent' : 'text-ink-3'}`}
            >
              <Icon className="w-6 h-6" aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
      </nav>

      {sheet?.kind === 'doc' && <DocSheet key={sheet.id} documentId={sheet.id} graphLoading={false} onOpenCustomer={openCustomer} onClose={closeSheet} />}
      {sheet?.kind === 'customer' && <CustomerSheet key={sheet.ref} customerRef={sheet.ref} onOpenDoc={openDoc} onClose={closeSheet} />}
    </div>
  )
}

/** A single-citation Answer (fix #7) and a two-citation one for contrast — a
 *  hand-built fixture rather than driving it through AskTab's mock provider,
 *  so this checks MobileAnswer's own tap logic directly and deterministically. */
const SINGLE_CITATION: Answer = {
  kind: 'answer',
  text: 'The Trane XR16 at 2847 N 24th St is still under warranty.',
  facts: [],
  sources: [{ documentId: DOC_ID, location: { page: 1 } }],
  confidence: 0.9,
  verifiedCount: 1,
  unverifiedCount: 0,
  closest: [],
}
const TWO_CITATIONS: Answer = {
  ...SINGLE_CITATION,
  sources: [{ documentId: DOC_ID, location: { page: 1 } }, { documentId: 'doc-2', location: { page: 1 } }],
}

export function CitationScenes() {
  return (
    <div className="dw-m bg-bg text-ink p-4 grid gap-4 max-w-sm mx-auto">
      <section data-testid="scene-single-citation">
        <MobileAnswer question="Is it under warranty?" answer={SINGLE_CITATION} onOpenDoc={(id) => note(`doc:${id}`)} onOpenCustomer={(ref) => note(`customer:${ref}`)} />
      </section>
      <section data-testid="scene-two-citations">
        <MobileAnswer question="Is it under warranty?" answer={TWO_CITATIONS} onOpenDoc={(id) => note(`doc:${id}`)} onOpenCustomer={(ref) => note(`customer:${ref}`)} />
      </section>
    </div>
  )
}
