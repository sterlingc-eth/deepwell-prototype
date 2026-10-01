/**
 * Typed client for POST/GET /api/support — the DeepWell Support Assistant ("DeepWell Help").
 *
 * Same authHeader + httpError pattern as billingClient/notifyClient, with one difference: nothing here
 * ever throws. Every call resolves to `{ ok: true, data }` or `{ ok: false, error }` so the chat UI can
 * render a friendly line instead of a stack trace. Chat needs a live connection, so this deliberately
 * uses plain fetch — it must never be routed through the offline queue (src/mobile/offline).
 */
import { authHeader } from './authToken';
import { UNREACHABLE_MESSAGE, friendlyErrorMessage, parseRetryAfterSeconds } from './httpError';

const API_URL = '/api/support';
const TIMEOUT_MS = 30_000;

export const SUPPORT_EMAIL = 'support@deepwelltechnology.com';
export const MAX_MESSAGE_CHARS = 600;
export const MAX_HISTORY = 6;

export type SupportSurface = 'app' | 'mobile';
export type SupportRole = 'user' | 'assistant';
export type SupportMode = 'faq' | 'model' | 'guard' | 'redirect' | 'fallback';

export interface SupportSource {
  id: string;
  title: string;
}

export interface SupportHistoryItem {
  role: SupportRole;
  text: string;
}

export interface SupportReply {
  reply: string;
  sources: SupportSource[];
  mode: SupportMode;
  redirectTo?: 'ask';
  handoff?: { offered: true; reason: string };
  suggestions?: string[];
}

export interface SupportStarter {
  greeting: string;
  suggestions: string[];
}

export interface SupportHandoffRequest {
  email: string;
  name?: string;
  message: string;
  transcript?: SupportHistoryItem[];
  surface: SupportSurface;
  /** 'problem' = sent from "Report a problem": subject tagged Problem, diagnostics attached. */
  kind?: 'help' | 'problem';
  /** Scrubbed screen/device/recent-errors block from errorReporter.buildDiagnostics(). */
  diagnostics?: string;
  /** Screen name the person was on. */
  page?: string;
}

export type SupportErrorKind = 'offline' | 'rate_limited' | 'invalid' | 'auth' | 'server';

export interface SupportError {
  kind: SupportErrorKind;
  message: string;
  status?: number;
  retryAfterSec?: number;
}

export type SupportResult<T> = { ok: true; data: T } | { ok: false; error: SupportError };

export const OFFLINE_ERROR: SupportError = { kind: 'offline', message: UNREACHABLE_MESSAGE };

/** "You're sending messages quickly — try again in 12s." */
export function rateLimitMessage(retryAfterSec?: number): string {
  if (retryAfterSec == null || !Number.isFinite(retryAfterSec)) return "You're sending messages quickly — try again in a moment.";
  const s = Math.max(1, Math.ceil(retryAfterSec));
  if (s >= 120) return `You're sending messages quickly — try again in about ${Math.ceil(s / 60)} minutes.`;
  return `You're sending messages quickly — try again in ${s}s.`;
}

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

async function readBody(res: Response): Promise<unknown> {
  const raw = await res.text().catch(() => '');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function errorFromResponse(res: Response, body: unknown): SupportError {
  const b = (body ?? {}) as { error?: unknown; retryAfterSec?: unknown };
  const serverMessage = asString(b.error);
  if (res.status === 429) {
    const fromBody = typeof b.retryAfterSec === 'number' ? b.retryAfterSec : undefined;
    const retryAfterSec = fromBody ?? parseRetryAfterSeconds(res.headers.get('Retry-After'));
    return { kind: 'rate_limited', status: 429, retryAfterSec, message: rateLimitMessage(retryAfterSec) };
  }
  if (res.status === 400) {
    return { kind: 'invalid', status: 400, message: serverMessage ?? "That message couldn't be sent. Try rephrasing it." };
  }
  if (res.status === 401 || res.status === 403) {
    return { kind: 'auth', status: res.status, message: 'Your session has expired. Reload the page and sign in again.' };
  }
  return { kind: 'server', status: res.status, message: 'Help is unavailable right now. Try again in a moment, or email us.' };
}

async function call<T>(init: RequestInit, url: string, parse: (body: unknown) => T | null): Promise<SupportResult<T>> {
  if (isOffline()) return { ok: false, error: OFFLINE_ERROR };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal, headers: { ...(init.headers ?? {}), ...(await authHeader()) } });
    const body = await readBody(res);
    if (!res.ok) return { ok: false, error: errorFromResponse(res, body) };
    const data = parse(body);
    if (data == null) return { ok: false, error: { kind: 'server', status: res.status, message: 'Help sent an unexpected response. Try again in a moment.' } };
    return { ok: true, data };
  } catch (e) {
    if (ctl.signal.aborted) return { ok: false, error: { kind: 'server', message: 'Help took too long to answer. Try again in a moment.' } };
    const message = friendlyErrorMessage(e, 'Something went wrong. Try again in a moment.');
    return { ok: false, error: { kind: message === UNREACHABLE_MESSAGE ? 'offline' : 'server', message } };
  } finally {
    clearTimeout(timer);
  }
}

function parseReply(body: unknown): SupportReply | null {
  const b = body as Partial<SupportReply> | null;
  if (!b || typeof b.reply !== 'string') return null;
  const sources = Array.isArray(b.sources)
    ? b.sources.filter((s): s is SupportSource => !!s && typeof s.title === 'string' && s.title.trim() !== '').map((s) => ({ id: String(s.id ?? s.title), title: s.title }))
    : [];
  const modes: SupportMode[] = ['faq', 'model', 'guard', 'redirect', 'fallback'];
  return {
    reply: b.reply,
    sources,
    mode: modes.includes(b.mode as SupportMode) ? (b.mode as SupportMode) : 'model',
    redirectTo: b.redirectTo === 'ask' ? 'ask' : undefined,
    handoff: b.handoff && b.handoff.offered ? { offered: true, reason: String(b.handoff.reason ?? '') } : undefined,
    suggestions: Array.isArray(b.suggestions) ? b.suggestions.filter((s): s is string => typeof s === 'string' && !!s.trim()).slice(0, 4) : undefined,
  };
}

/** Trim to `n` UTF-16 units without leaving half of an emoji (a lone surrogate) at the end. */
function capUnits(t: string, n: number): string {
  const c = t.slice(0, n);
  const last = c.charCodeAt(c.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? c.slice(0, -1) : c;
}

/** Ask the assistant a question. `history` is trimmed to the last MAX_HISTORY turns here so callers can't overshoot. */
export function sendSupportMessage(req: { message: string; history?: SupportHistoryItem[]; surface: SupportSurface; page?: string }): Promise<SupportResult<SupportReply>> {
  const body = {
    message: capUnits(req.message.trim(), MAX_MESSAGE_CHARS),
    history: (req.history ?? []).slice(-MAX_HISTORY).map((h) => ({ role: h.role, text: capUnits(h.text, MAX_MESSAGE_CHARS) })),
    surface: req.surface,
    ...(req.page ? { page: req.page } : {}),
  };
  return call({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, API_URL, parseReply);
}

/** Send the conversation to a person (`{action:'handoff'}`). */
export function sendSupportHandoff(req: SupportHandoffRequest): Promise<SupportResult<{ ok: true }>> {
  const body = { action: 'handoff', ...req, email: req.email.trim(), message: req.message.trim() };
  return call({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, API_URL, (b) => ((b as { ok?: unknown } | null)?.ok === true ? { ok: true as const } : null));
}

/** Greeting + starter chips. Callers should fall back to FALLBACK_STARTER on any error. */
export function fetchSupportStarter(surface: SupportSurface): Promise<SupportResult<SupportStarter>> {
  return call({ method: 'GET' }, `${API_URL}?starter=1&surface=${surface}`, (b) => {
    const s = b as Partial<SupportStarter> | null;
    if (!s || typeof s.greeting !== 'string') return null;
    return { greeting: s.greeting, suggestions: Array.isArray(s.suggestions) ? s.suggestions.filter((x): x is string => typeof x === 'string').slice(0, 6) : [] };
  });
}

export const FALLBACK_STARTER: SupportStarter = {
  greeting: "Hi, I'm DeepWell Help. Ask me how DeepWell works: plans, uploads, scanning, your team, billing or privacy.",
  suggestions: ['How do I upload documents?', 'What plans are available?', 'How do I add a teammate?'],
};
