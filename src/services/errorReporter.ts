/**
 * Browser error reporter (R31 QA; R25 readiness should-have "browser error reporter" / "Report a problem").
 *
 * Nothing in the browser used to notice a crash: the backend has Sentry-style logging, the app had none, so a
 * tech's white screen was invisible until they phoned. This is deliberately tiny and third-party-free:
 *
 *  - installErrorReporter() listens for window "error" and "unhandledrejection" and keeps the last 10 in a
 *    small in-memory ring (mirrored to sessionStorage so a reload after a crash still has them);
 *  - recordRenderError() is called by the screen error boundary;
 *  - crashes (uncaught error / render error) are sent (from the production hostnames only, R34) ONCE each, at most 3 per page load, to POST /api/support
 *    {action:'client-error'} with the person's normal session, where the server logs them (hashes only) — no
 *    Sentry SDK, no new domain, nothing for the CSP to allow;
 *  - buildDiagnostics() is what "Report a problem" attaches to the message a person sends to support.
 *
 * PRIVACY: everything is scrubbed HERE before it leaves the device (emails, phone numbers, long numbers, long
 * tokens, URL query strings) and again on the server. Only the message text and file:line of the error, the
 * screen name and a coarse device string are ever included: no customer records, no document text, no answers.
 */
import { authHeader } from './authToken';

export type ClientErrorKind = 'error' | 'rejection' | 'render';
export interface ClientErrorEntry {
  /** epoch ms */
  t: number;
  kind: ClientErrorKind;
  message: string;
  where?: string;
}

const MAX_ENTRIES = 10;
const MAX_AUTO_REPORTS = 3;
const STORE_KEY = 'deepwell.clientErrors';
const API_URL = '/api/support';

/**
 * R34: crashes are POSTed to the server (which forwards them to Sentry) ONLY from the real production site.
 * localhost, 127.0.0.1, preview deployments, file:// and every test/QA harness page (which run on localhost and
 * throw on purpose) record to the local ring for "Report a problem" but never leave the device.
 * Mirrors APP_ORIGINS in api/_lib/util/origins.js (the production origins; not its localhost dev ports).
 */
export const PRODUCTION_HOSTS: readonly string[] = ['deepwelltechnology.com', 'www.deepwelltechnology.com', 'deepwellinc.vercel.app'];
/** Pure: is `hostname` one of the production hostnames? */
export function isProductionHost(hostname: string | undefined | null): boolean {
  return PRODUCTION_HOSTS.includes(String(hostname ?? '').toLowerCase());
}
/** True when this page may send crash reports. `window.__DEEPWELL_FORCE_ERROR_REPORT__ = true` is the explicit
 *  override for a deliberate live test (and for the QA harness that asserts the report payload). */
export function reportingAllowed(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    if ((window as unknown as { __DEEPWELL_FORCE_ERROR_REPORT__?: boolean }).__DEEPWELL_FORCE_ERROR_REPORT__ === true) return true;
    return isProductionHost(window.location?.hostname);
  } catch {
    return false;
  }
}

/** Errors that are noise, not bugs: browser quirks, cancelled requests, being offline. */
const NOISE_RE = /ResizeObserver loop|^Script error\.?$|AbortError|operation was aborted|Failed to fetch|NetworkError|Load failed|Network request failed|The user aborted a request|cancelled/i;

/** Remove anything that could identify a person or carry a secret; cap the length. Pure. */
export function scrubText(input: unknown, max = 200): string {
  return String(input ?? '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/(https?:\/\/[^\s?#)]+)[?#][^\s)]*/g, '$1')
    .replace(/\b(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/g, '[phone]')
    .replace(/\b\d{7,}\b/g, '[num]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[token]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** "/assets/index-ab12.js:1:2345" from an Error stack or a window error's filename/line — file and line only. */
export function whereFrom(stackOrFile: unknown, line?: number, col?: number): string | undefined {
  const s = String(stackOrFile ?? '');
  if (!s) return undefined;
  const m = /((?:https?:\/\/[^\s/]+)?\/[^\s():]+\.(?:js|mjs|tsx?)):(\d+)(?::(\d+))?/.exec(s);
  if (m && m[1]) return scrubText(`${m[1].replace(/^https?:\/\/[^/]+/, '')}:${m[2]}${m[3] ? `:${m[3]}` : ''}`, 120);
  if (/^https?:\/\//.test(s) || s.startsWith('/')) return scrubText(`${s.replace(/^https?:\/\/[^/]+/, '')}${line ? `:${line}${col ? `:${col}` : ''}` : ''}`, 120);
  return undefined;
}

/** Coarse device string ("iPhone iOS 17 Safari"), never the full user-agent. Pure. */
export function deviceFamily(ua: string): string {
  const os = /iPhone|iPad/.test(ua) ? `${/iPad/.test(ua) ? 'iPad' : 'iPhone'} iOS ${/OS (\d+)/.exec(ua)?.[1] ?? ''}`.trim()
    : /Android/.test(ua) ? `Android ${/Android (\d+)/.exec(ua)?.[1] ?? ''}`.trim()
    : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? 'macOS'
    : /Linux/.test(ua) ? 'Linux' : 'unknown OS';
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\/|CriOS\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'browser';
  return `${os} ${br}`;
}

let ring: ClientErrorEntry[] = [];
let installed = false;
let sentThisLoad = 0;
const sentKeys = new Set<string>();
let surfaceName: 'app' | 'mobile' = 'app';
let pageName: () => string = () => '';

function persist(): void {
  try {
    window.sessionStorage.setItem(STORE_KEY, JSON.stringify(ring));
  } catch {
    /* storage blocked: the in-memory ring still works */
  }
}
function restore(): void {
  try {
    const raw = window.sessionStorage.getItem(STORE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (Array.isArray(parsed)) {
      ring = parsed
        .filter((e): e is ClientErrorEntry => !!e && typeof (e as ClientErrorEntry).message === 'string' && typeof (e as ClientErrorEntry).t === 'number')
        .slice(-MAX_ENTRIES);
    }
  } catch {
    /* ignore */
  }
}

export function getRecentClientErrors(): ClientErrorEntry[] {
  return ring.slice();
}
export function _resetForTest(): void {
  ring = [];
  installed = false;
  sentThisLoad = 0;
  sentKeys.clear();
}

/** Record one error (scrubbed, de-duplicated against the newest entry) and, for crashes, report it. Never throws. */
export function recordClientError(kind: ClientErrorKind, err: unknown, where?: string): ClientErrorEntry | null {
  try {
    const raw = err instanceof Error ? err.message || err.name : typeof err === 'string' ? err : (err as { message?: string } | null)?.message ?? 'Unknown error';
    if (NOISE_RE.test(String(raw))) return null;
    const message = scrubText(raw, 200) || 'Unknown error';
    const loc = where ?? (err instanceof Error ? whereFrom(err.stack) : undefined);
    // React re-throws a render error to window.onerror as well as to the boundary: one crash must be one entry.
    const dup = ring.slice(-3).find((e) => e.message === message && Date.now() - e.t < 5000) ?? (ring[ring.length - 1]?.message === message ? ring[ring.length - 1] : undefined);
    if (dup) return dup;
    const entry: ClientErrorEntry = { t: Date.now(), kind, message, ...(loc ? { where: loc } : {}) };
    ring.push(entry);
    if (ring.length > MAX_ENTRIES) ring = ring.slice(-MAX_ENTRIES);
    persist();
    void maybeReport(entry);
    return entry;
  } catch {
    return null;
  }
}
/** For React's error boundary. */
export function recordRenderError(err: unknown): void {
  recordClientError('render', err);
}

async function maybeReport(entry: ClientErrorEntry): Promise<void> {
  if (!reportingAllowed()) return; // R34: dev / preview / harness pages never report
  const key = entry.message;
  if (sentThisLoad >= MAX_AUTO_REPORTS || sentKeys.has(key)) return;
  sentKeys.add(key);
  try {
    const headers = await authHeader();
    if (!headers.Authorization) return; // signed out: the server would refuse; nothing to attribute it to anyway
    sentThisLoad++;
    await fetch(API_URL, {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        action: 'client-error',
        surface: surfaceName,
        page: scrubText(pageName(), 80),
        kind: entry.kind,
        message: entry.message,
        where: entry.where,
        device: deviceFamily(navigator.userAgent),
        build: buildId(),
      }),
    });
  } catch {
    /* reporting must never itself become an error */
  }
}

function buildId(): string {
  try {
    const src = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.src ?? '';
    return scrubText(src.split('/').pop() ?? '', 60);
  } catch {
    return '';
  }
}

/** Install once per page load. `page` names the current screen for the report. Safe to call twice. */
export function installErrorReporter(surface: 'app' | 'mobile', page: () => string = () => ''): void {
  surfaceName = surface;
  pageName = page;
  if (installed || typeof window === 'undefined') return;
  installed = true;
  restore();
  window.addEventListener('error', (ev: ErrorEvent) => {
    // Resource load failures (an <img>/<script> that 404s) fire "error" on the element with no message: not app bugs.
    if (!ev.message && !ev.error) return;
    recordClientError('error', ev.error ?? ev.message, whereFrom(ev.filename, ev.lineno, ev.colno) ?? (ev.error instanceof Error ? whereFrom(ev.error.stack) : undefined));
  });
  window.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
    recordClientError('rejection', ev.reason);
  });
}

/**
 * The block "Report a problem" attaches (max ~1,200 chars). No customer data: screen name, device, viewport,
 * connectivity, build file name, and the scrubbed recent errors.
 */
export function buildDiagnostics(surface: 'app' | 'mobile' | 'public', page?: string): string {
  const lines: string[] = [];
  try {
    const standalone = typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches;
    lines.push(`Screen: ${scrubText(page || '(unknown)', 80)} (${surface})`);
    lines.push(`Device: ${deviceFamily(navigator.userAgent)} · viewport ${window.innerWidth}x${window.innerHeight}${standalone ? ' · installed app' : ''} · ${navigator.onLine === false ? 'offline' : 'online'}`);
    const b = buildId();
    if (b) lines.push(`Build: ${b}`);
    const recent = ring.slice(-5);
    if (recent.length) {
      lines.push(`Recent errors (${recent.length}):`);
      for (const e of recent) lines.push(`- ${new Date(e.t).toISOString().slice(11, 19)} ${e.kind}: ${e.message}${e.where ? ` (${e.where})` : ''}`);
    } else {
      lines.push('Recent errors: none recorded');
    }
  } catch {
    lines.push('Diagnostics unavailable');
  }
  return lines.join('\n').slice(0, 1200);
}
