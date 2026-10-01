// Split from InstallGuide.tsx so the sign-in screen can decide whether the guide is wanted without loading it.
export const DISMISS_KEY = 'deepwell.m.installGuide'
export const APP_URL = 'https://deepwelltechnology.com/m/'

export function forcedOpen(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('install') === '1'
  } catch {
    return false
  }
}

export function wasDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === 'off'
  } catch {
    return false
  }
}

