import { Component, lazy, Suspense, type ComponentProps, type ReactNode } from 'react'
import { Sheet } from './Sheet'
import { loadCustomerSheet, loadDocSheet } from './sheetLoader'
import { forcedOpen, wasDismissed } from './installGuideState'
import { installPath } from './pwa'

/**
 * R36 (mobile fluidity): the document and customer sheets are rarely on the first screen, so their code lives in
 * its own chunk instead of the phone's entry bundle (see sheetLoader.ts for the idle prefetch). The Suspense
 * fallback is the real Sheet chrome with a fixed-height placeholder, so a tap on a slow link shows the sheet at
 * once and the content fills in below the header.
 */
const DocSheetLazy = lazy(() => loadDocSheet().then((m) => ({ default: m.DocSheet })))
const CustomerSheetLazy = lazy(() => loadCustomerSheet().then((m) => ({ default: m.CustomerSheet })))

/** A sheet chunk that can't load (offline before it was ever prefetched) must not blank the whole app: say so in the
 *  sheet itself. `React.lazy` remembers a failed import, so the way out is a reload, which the button does. */
export class SheetBoundary extends Component<{ title: string; onClose: () => void; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  override render() {
    if (!this.state.failed) return this.props.children
    return (
      <Sheet title={this.props.title} onClose={this.props.onClose}>
        <p className="m-0 text-body text-ink-2">Couldn't load this screen. Check your connection, then reload.</p>
        <button type="button" onClick={() => window.location.reload()} className="min-h-touch rounded-xl bg-accent text-forest-950 font-semibold">
          Reload
        </button>
      </Sheet>
    )
  }
}

function SheetSkeleton({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="min-h-[40dvh]" aria-busy="true" />
    </Sheet>
  )
}

export function LazyDocSheet(props: ComponentProps<typeof DocSheetLazy>) {
  return (
    <SheetBoundary title="Document" onClose={props.onClose}>
      <Suspense fallback={<SheetSkeleton title="Document" onClose={props.onClose} />}>
        <DocSheetLazy {...props} />
      </Suspense>
    </SheetBoundary>
  )
}

export function LazyCustomerSheet(props: ComponentProps<typeof CustomerSheetLazy>) {
  return (
    <SheetBoundary title="Customer" onClose={props.onClose}>
      <Suspense fallback={<SheetSkeleton title="Customer" onClose={props.onClose} />}>
        <CustomerSheetLazy {...props} />
      </Suspense>
    </SheetBoundary>
  )
}

const InstallGuideLazy = lazy(() => import('./InstallGuide').then((m) => ({ default: m.InstallGuide })))

/** The sign-in screen's "put DeepWell on your phone" card. Signed-in phones never load it; when it is wanted, the
 *  placeholder reserves roughly its height so the sign-in form below doesn't jump when it lands. */
export function LazyInstallGuide() {
  if ((!forcedOpen() && wasDismissed()) || installPath() === 'installed') return null
  return (
    <Suspense fallback={<div className="w-full max-w-md min-h-40" aria-hidden="true" />}>
      <InstallGuideLazy />
    </Suspense>
  )
}
