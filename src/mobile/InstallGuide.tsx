import { useEffect, useState, type ReactNode } from 'react'
import { Check, Copy, EllipsisVertical, Share, SquarePlus, X } from 'lucide-react'
import { installPath, onInstallAvailabilityChange, promptInstall, type InstallPath } from './pwa'

/**
 * "Put DeepWell on your phone" — shown on the sign-in screen, before the
 * person signs in, because on iPhone the home-screen app keeps its own
 * sign-in (separate from Safari): install first, then sign in once inside
 * the app. `?install=1` (the QR code on /get and the desktop app) forces it
 * open even if it was dismissed before.
 */

const DISMISS_KEY = 'deepwell.m.installGuide'
const APP_URL = 'https://deepwelltechnology.com/m/'

function forcedOpen(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('install') === '1'
  } catch {
    return false
  }
}

function wasDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === 'off'
  } catch {
    return false
  }
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="shrink-0 w-6 h-6 rounded-full bg-white/15 text-white text-caption font-semibold flex items-center justify-center" aria-hidden="true">
        {n}
      </span>
      <span className="pt-0.5">{children}</span>
    </li>
  )
}

function Icon({ children }: { children: ReactNode }) {
  return <span className="inline-flex align-[-3px] mx-0.5 text-white">{children}</span>
}

function CopyLink() {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(APP_URL)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2500)
    } catch {
      window.prompt('Copy this link', APP_URL)
    }
  }
  return (
    <button type="button" onClick={() => void copy()} className="min-h-11 px-3 rounded-lg bg-white/15 text-white font-semibold inline-flex items-center gap-2">
      {copied ? <Check className="w-4 h-4" aria-hidden="true" /> : <Copy className="w-4 h-4" aria-hidden="true" />}
      {copied ? 'Link copied' : 'Copy link'}
    </button>
  )
}

export function InstallGuide() {
  const [path, setPath] = useState<InstallPath>(() => installPath())
  const [hidden, setHidden] = useState(() => !forcedOpen() && wasDismissed())
  const [accepted, setAccepted] = useState(false)

  // Chrome's install prompt can arrive a few seconds after load.
  useEffect(() => onInstallAvailabilityChange(() => setPath(installPath())), [])

  if (hidden || path === 'installed') return null

  const dismiss = () => {
    setHidden(true)
    try {
      localStorage.setItem(DISMISS_KEY, 'off')
    } catch {
      /* ignore */
    }
  }

  const install = async () => {
    const ok = await promptInstall()
    setAccepted(ok)
    setPath(installPath())
  }

  let title = 'Put DeepWell on your phone'
  let body: ReactNode
  switch (path) {
    case 'prompt':
      body = accepted ? (
        <p>Installed. Open DeepWell from your home screen.</p>
      ) : (
        <div className="flex items-center gap-3">
          <p className="flex-1">One tap. It opens full screen like any app, and there's no app store needed.</p>
          <button type="button" onClick={() => void install()} className="min-h-11 px-4 rounded-lg bg-accent text-forest-950 font-semibold">
            Install
          </button>
        </div>
      )
      break
    case 'ios-safari':
      body = (
        <ol className="space-y-2">
          <Step n={1}>
            Tap <b>Share</b>
            <Icon><Share className="w-4 h-4" aria-label="Share icon" /></Icon>
            at the bottom of Safari (top right on iPad).
          </Step>
          <Step n={2}>
            Scroll down and tap <b>Add to Home Screen</b>
            <Icon><SquarePlus className="w-4 h-4" aria-hidden="true" /></Icon>, then <b>Add</b>.
          </Step>
          <Step n={3}>Open <b>DeepWell</b> from your home screen and sign in there.</Step>
        </ol>
      )
      break
    case 'ios-other':
      body = (
        <div className="space-y-3">
          <ol className="space-y-2">
            <Step n={1}>
              Tap <b>Share</b>
              <Icon><Share className="w-4 h-4" aria-label="Share icon" /></Icon>
              next to the address bar, then <b>Add to Home Screen</b>.
            </Step>
            <Step n={2}>Open <b>DeepWell</b> from your home screen and sign in there.</Step>
          </ol>
          <p className="text-white/70">Don't see it? Copy the link and open it in Safari.</p>
          <CopyLink />
        </div>
      )
      break
    case 'in-app':
      title = 'Open this in your browser to install'
      body = (
        <div className="space-y-3">
          <p>
            This app's built-in browser can't install DeepWell. Tap the menu
            <Icon><EllipsisVertical className="w-4 h-4" aria-hidden="true" /></Icon>
            and choose <b>Open in Safari</b> or <b>Open in Chrome</b>, or copy the link.
          </p>
          <CopyLink />
        </div>
      )
      break
    case 'android-menu':
      body = (
        <ol className="space-y-2">
          <Step n={1}>
            In Chrome, tap the menu
            <Icon><EllipsisVertical className="w-4 h-4" aria-hidden="true" /></Icon>
            at the top right.
          </Step>
          <Step n={2}>
            Tap <b>Install app</b> (or <b>Add to Home screen</b>).
          </Step>
          <Step n={3}>Open <b>DeepWell</b> from your home screen.</Step>
        </ol>
      )
      break
    case 'desktop':
      title = 'Get DeepWell on your phone'
      body = (
        <div className="flex items-center gap-4">
          <img src="/get/qr.svg" alt="QR code that opens DeepWell Mobile" width={96} height={96} className="w-24 h-24 rounded-md bg-white p-1 shrink-0" />
          <p>
            Point your phone's camera at the code. On this computer, use the{' '}
            <a href="/app/" className="underline font-semibold text-white">
              full DeepWell app
            </a>
            .
          </p>
        </div>
      )
      break
  }

  return (
    <section aria-label="Install DeepWell" className="w-full max-w-md rounded-xl bg-white/10 text-white/90 text-body p-4 relative">
      <button type="button" onClick={dismiss} aria-label="Hide install steps" className="absolute top-1 right-1 w-11 h-11 flex items-center justify-center text-white/70">
        <X className="w-5 h-5" aria-hidden="true" />
      </button>
      <h2 className="font-semibold text-white mb-3 pr-10">{title}</h2>
      {body}
    </section>
  )
}
