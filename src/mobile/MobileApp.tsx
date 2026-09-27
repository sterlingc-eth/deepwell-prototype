import { useCallback, useEffect, useState } from 'react'
import { SignIn, UserButton, useAuth, useOrganization } from '@clerk/clerk-react'
import { FileText, Loader2, MessageCircle, Moon, ScanLine, Sun } from 'lucide-react'
import { setAuthTokenProvider } from '../services/authToken'
import { billingClient, type BillingStatus } from '../services/billingClient'
import { usePostgresSync } from '../hooks/usePostgresSync'
import { useAppStore } from '../store/appStore'
import { Wordmark } from '../components/Wordmark'
import { AskTab } from './AskTab'
import { ScanTab } from './ScanTab'
import { DocsTab } from './DocsTab'
import { DocSheet } from './DocSheet'
import { CustomerSheet } from './CustomerSheet'
import { useKeyboardOpen } from './useKeyboardOpen'
import { InstallGuide } from './InstallGuide'

export type MobileTab = 'ask' | 'scan' | 'docs'
const TABS: { id: MobileTab; label: string; Icon: typeof MessageCircle }[] = [
  { id: 'ask', label: 'Ask', Icon: MessageCircle },
  { id: 'scan', label: 'Scan', Icon: ScanLine },
  { id: 'docs', label: 'Docs', Icon: FileText },
]

const LAST_TAB_KEY = 'deepwell.mobile.lastTab'

function isMobileTab(v: string | null): v is MobileTab {
  return v === 'ask' || v === 'scan' || v === 'docs'
}

/** URL wins (a shared/deep link), then the last tab this phone was on
 *  (round 17, audit fix #5 — a Scan-first tech no longer pays a tap on
 *  every open just to leave Ask), then Ask. */
function initialTab(): MobileTab {
  const fromUrl = new URLSearchParams(window.location.search).get('tab')
  if (isMobileTab(fromUrl)) return fromUrl
  try {
    const last = window.localStorage.getItem(LAST_TAB_KEY)
    if (isMobileTab(last)) return last
  } catch {
    /* storage unavailable — Ask is still a fine default */
  }
  return 'ask'
}

function FullScreenMessage({ title, body, action }: { title: string; body: string; action?: { href: string; label: string } }) {
  return (
    <div className="dw-m dw-safe-top min-h-screen bg-bg text-ink flex flex-col items-center justify-center gap-5 p-6 text-center">
      <Wordmark size="lg" />
      <h1 className="text-h3 font-semibold m-0">{title}</h1>
      <p className="text-body-lg text-ink-2 m-0 max-w-sm">{body}</p>
      {action && (
        <a href={action.href} className="min-h-touch inline-flex items-center px-5 rounded-lg bg-accent text-forest-950 font-semibold">
          {action.label}
        </a>
      )}
    </div>
  )
}

export function MobileApp() {
  const { isLoaded, isSignedIn, getToken, orgId, userId } = useAuth()
  const { organization } = useOrganization()

  useEffect(() => {
    setAuthTokenProvider(() => getToken())
    return () => setAuthTokenProvider(null)
  }, [getToken])

  const fieldMode = useAppStore((s) => s.fieldMode)
  const setFieldMode = useAppStore((s) => s.setFieldMode)

  const [tab, setTabState] = useState<MobileTab>(initialTab)
  const setTab = (t: MobileTab) => {
    setTabState(t)
    const url = new URL(window.location.href)
    url.searchParams.set('tab', t)
    window.history.replaceState(null, '', url)
    try {
      window.localStorage.setItem(LAST_TAB_KEY, t)
    } catch {
      /* best-effort only */
    }
  }
  const [sheet, setSheet] = useState<{ kind: 'doc'; id: string } | { kind: 'customer'; ref: string } | null>(null)
  const openDoc = useCallback((id: string) => setSheet({ kind: 'doc', id }), [])
  const openCustomer = useCallback((ref: string) => setSheet({ kind: 'customer', ref }), [])
  const closeSheet = useCallback(() => setSheet(null), [])
  const keyboardOpen = useKeyboardOpen()

  const ready = isLoaded && !!isSignedIn && !!orgId
  // The full records graph (Docs list, source filenames, suggestions) is the
  // heaviest thing this app downloads, and Ask doesn't need it. Start it once
  // the first screen has painted and the phone is idle, or immediately if
  // the tech goes to Docs or opens a document first.
  const [graphWanted, setGraphWanted] = useState(false)
  useEffect(() => {
    if (!ready || graphWanted) return
    const start = () => setGraphWanted(true)
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (h: number) => void }
    if (w.requestIdleCallback) {
      const h = w.requestIdleCallback(start, { timeout: 2500 })
      return () => w.cancelIdleCallback?.(h)
    }
    const t = window.setTimeout(start, 1200)
    return () => window.clearTimeout(t)
  }, [ready, graphWanted])
  // Once wanted, stays wanted (graphWanted latches via the idle timer; the
  // tab/sheet triggers only ever add to it while visible, and the latch below
  // keeps the sync enabled after they leave).
  const needGraphNow = tab === 'docs' || sheet?.kind === 'doc'
  const [graphLatched, setGraphLatched] = useState(false)
  if (needGraphNow && !graphLatched) setGraphLatched(true)
  const sync = usePostgresSync(ready && (graphWanted || graphLatched), orgId ?? userId ?? null, { linkSweep: false })

  const [billing, setBilling] = useState<BillingStatus | null>(null)
  const [billingLoaded, setBillingLoaded] = useState(false)
  useEffect(() => {
    if (!ready) return
    let cancelled = false
    billingClient
      .status()
      .then((s) => !cancelled && setBilling(s))
      .catch(() => {})
      .finally(() => !cancelled && setBillingLoaded(true))
    return () => {
      cancelled = true
    }
  }, [ready])

  if (!isLoaded) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-accent animate-spin" aria-label="Loading" />
      </div>
    )
  }

  if (!isSignedIn) {
    return (
      <div className="dw-m dw-safe-top min-h-screen bg-gradient-to-br from-[#163C2C] to-[#0F2818] flex flex-col items-center justify-center gap-6 p-4">
        <Wordmark size="lg" animated />
        <InstallGuide />
        <div className="w-full max-w-md rounded-lg p-4 flex justify-center" style={{ background: '#F6F8F6' }}>
          <SignIn
            routing="hash"
            fallbackRedirectUrl="/m/"
            signUpFallbackRedirectUrl="/m/"
            appearance={{
              elements: { rootBox: 'w-full flex justify-center', cardBox: 'w-full shadow-none border-0', card: 'w-full shadow-none border-0' },
              variables: { colorPrimary: '#0D3827', colorBackground: '#F6F8F6' },
            }}
          />
        </div>
      </div>
    )
  }

  if (!orgId) {
    return (
      <FullScreenMessage
        title="Join your shop first"
        body="Your account isn't part of a shop yet. Create your shop or accept your invite on DeepWell, then come back here."
        action={{ href: '/app/', label: 'Open DeepWell' }}
      />
    )
  }

  if (!billingLoaded) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-accent animate-spin" aria-label="Loading" />
      </div>
    )
  }

  // Same hard gate as /app (owner decision 2026-09-21); fails open if the
  // status call itself failed, exactly like the desktop app.
  if (billing && (billing.status === 'none' || billing.status === 'canceled')) {
    return (
      <FullScreenMessage
        title="Choose a plan to continue"
        body="Your shop doesn't have an active DeepWell plan. The shop owner can pick one on the desktop app."
        action={{ href: '/app/?screen=billing', label: 'See plans' }}
      />
    )
  }

  return (
    <div className="dw-m h-[100dvh] bg-bg text-ink flex flex-col">
      <header className="dw-safe-top shrink-0 bg-surface border-b border-line/60">
        <div className="max-w-2xl mx-auto min-h-14 short:min-h-11 px-4 flex items-center justify-between gap-3">
          <Wordmark size="sm" />
          <div className="flex items-center gap-2 min-w-0">
            {organization?.name && (
              <span className="hidden min-[360px]:inline short:hidden text-caption text-ink-3 truncate max-w-[30vw] md:max-w-xs">{organization.name}</span>
            )}
            {/* Round 17 audit fix #1: reachable, 1-tap, persisted (same
                setFieldMode/localStorage the desktop toggle uses) — the only
                thing missing before was a button that calls it from here. */}
            <button
              type="button"
              role="switch"
              aria-checked={fieldMode}
              aria-label={fieldMode ? 'Field view on. Switch to Office view' : 'Office view on. Switch to Field view'}
              title={fieldMode ? 'Field view: light, larger type for outdoors. Tap for Office view.' : 'Office view: dark. Tap for Field view (light, larger type).'}
              onClick={() => setFieldMode(!fieldMode)}
              className="w-11 h-11 -mr-1 shrink-0 flex items-center justify-center rounded-full text-ink-3"
            >
              {fieldMode ? <Sun className="w-5 h-5" aria-hidden="true" /> : <Moon className="w-5 h-5" aria-hidden="true" />}
            </button>
            <UserButton afterSignOutUrl="/m/" />
          </div>
        </div>
      </header>

      {sync.status === 'error' && (
        <div role="alert" className="shrink-0 bg-bad-bg text-bad-ink text-caption">
          <div className="max-w-2xl mx-auto px-4 min-h-11 flex items-center gap-2">
            <span className="flex-1">Couldn't load your records{sync.error ? `: ${sync.error}` : ''}.</span>
            <button type="button" className="min-h-11 px-2 underline font-semibold" onClick={() => void sync.refresh()}>
              Retry
            </button>
          </div>
        </div>
      )}

      <main className="flex-1 min-h-0 overflow-hidden">
        {/* All three stay mounted so an upload keeps going and the Ask
            thread survives while the tech flips between tabs. */}
        <div className={tab === 'ask' ? 'h-full' : 'hidden'}>
          <AskTab onOpenDoc={openDoc} onOpenCustomer={openCustomer} billing={billing} tenantKey={orgId ?? userId ?? null} />
        </div>
        <div className={tab === 'scan' ? 'h-full' : 'hidden'}>
          <ScanTab
            tenantKey={orgId ?? userId ?? null}
            onUploaded={() => void sync.refresh()}
            onOpenDocs={() => setTab('docs')}
            onOpenDoc={openDoc}
          />
        </div>
        <div className={tab === 'docs' ? 'h-full' : 'hidden'}>
          <DocsTab syncStatus={sync.status} onOpenDoc={openDoc} onRefresh={() => sync.refresh()} />
        </div>
      </main>

      {/* Hidden while typing so the keyboard, the question and the answer get the screen. */}
      <nav className={`dw-safe-bottom shrink-0 border-t border-line/60 bg-surface ${keyboardOpen ? 'hidden' : ''}`} aria-label="Main">
        <div className="max-w-md mx-auto grid grid-cols-3">
          {TABS.map(({ id, label, Icon }) => {
            const active = tab === id
            return (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                aria-current={active ? 'page' : undefined}
                className={`min-h-16 short:min-h-11 flex flex-col short:flex-row items-center justify-center gap-1 short:gap-2 text-caption font-medium ${active ? 'text-accent' : 'text-ink-3'}`}
              >
                <Icon className="w-6 h-6 short:w-5 short:h-5" aria-hidden="true" />
                {label}
              </button>
            )
          })}
        </div>
      </nav>

      {sheet?.kind === 'doc' && (
        <DocSheet key={sheet.id} documentId={sheet.id} graphLoading={sync.status !== 'ready' && sync.status !== 'error'} onOpenCustomer={openCustomer} onClose={closeSheet} />
      )}
      {sheet?.kind === 'customer' && <CustomerSheet key={sheet.ref} customerRef={sheet.ref} onOpenDoc={openDoc} onClose={closeSheet} />}
    </div>
  )
}
