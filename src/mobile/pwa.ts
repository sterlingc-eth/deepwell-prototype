/** Service worker + "Add to Home Screen" helpers for DeepWell Mobile. */

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/m/sw.js', { scope: '/m/' }).catch(() => {
      /* best effort — the app works the same without it */
    })
  })
}

/** Chrome/Android's deferred install prompt. */
export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferred: BeforeInstallPromptEvent | null = null
const listeners = new Set<() => void>()
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferred = e as BeforeInstallPromptEvent
    listeners.forEach((fn) => fn())
  })
  window.addEventListener('appinstalled', () => {
    deferred = null
    listeners.forEach((fn) => fn())
  })
}

export function onInstallAvailabilityChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function canPromptInstall(): boolean {
  return deferred !== null
}

export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false
  const e = deferred
  deferred = null
  await e.prompt()
  const choice = await e.userChoice
  listeners.forEach((fn) => fn())
  return choice.outcome === 'accepted'
}

export function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean }
  return window.matchMedia?.('(display-mode: standalone)').matches || nav.standalone === true
}

export function isIos(): boolean {
  const ua = navigator.userAgent
  // iPadOS 13+ reports itself as a Mac; a Mac with touch is an iPad.
  return /iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
}

export function isAndroid(): boolean {
  return /android/i.test(navigator.userAgent)
}

/**
 * Email / social apps open links in their own browser, which cannot install
 * a web app. The person has to move to Safari (iPhone) or Chrome (Android).
 */
export function isInAppBrowser(): boolean {
  return /FBAN|FBAV|Instagram|LinkedInApp|Line\/|Snapchat|Twitter|GSA\/|; wv\)|MicroMessenger|Pinterest/i.test(navigator.userAgent)
}

/** Safari itself (not Chrome/Firefox/Edge for iOS, which still install via their Share menu on iOS 16.4+). */
export function isIosSafari(): boolean {
  return isIos() && !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(navigator.userAgent)
}

/** How this browser installs the app — drives the words on the install guide. */
export type InstallPath = 'installed' | 'prompt' | 'ios-safari' | 'ios-other' | 'in-app' | 'android-menu' | 'desktop'

export function installPath(): InstallPath {
  if (isStandalone()) return 'installed'
  if (isInAppBrowser()) return 'in-app'
  if (canPromptInstall()) return 'prompt'
  if (isIos()) return isIosSafari() ? 'ios-safari' : 'ios-other'
  if (isAndroid()) return 'android-menu'
  return 'desktop'
}
