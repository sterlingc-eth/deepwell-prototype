/**
 * R31 QA — browser error reports. POST /api/support {action:'client-error', ...} from src/services/errorReporter.ts.
 *
 * Signed-in surfaces only (app / mobile): the tenant is whatever the verified session says. The payload is a scrubbed
 * one-line error (message, file:line, screen name, coarse device, build file name), never customer data. It is NOT
 * stored and NOT emailed: it becomes ONE structured log line (Vercel logs, and Sentry once SENTRY_DSN is set through
 * telemetry.captureMessage) carrying hashes and counts only, capped per user per day so a crash loop cannot flood it.
 */
import { redactSecrets } from '../privacy/redact.js';

/**
 * Second scrub, server side (the browser already scrubbed): emails, phone numbers, long digit runs, long tokens and
 * provider-style secret keys. Also used for the "Report a problem" diagnostics block in handoff.js.
 */
export function scrub(text) {
  return redactSecrets(String(text ?? ''))
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\b(?:sk|pk|rk|whsec)_[A-Za-z0-9_]{8,}/g, '[secret]')
    .replace(/\b(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/g, '[phone]')
    .replace(/\b\d{7,}\b/g, '[num]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[token]');
}

const KINDS = ['error', 'rejection', 'render'];
const oneLine = (s, n) => String(s ?? '').replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/** @returns {{ok:true, value:{kind:string,message:string,where:string,page:string,device:string,build:string,surface:string}}|{ok:false,error:string}} */
export function validateClientError(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (b.surface !== 'app' && b.surface !== 'mobile') return { ok: false, error: 'Not available for this surface.' };
  const message = scrub(oneLine(b.message, 240));
  if (!message) return { ok: false, error: 'No error message.' };
  return {
    ok: true,
    value: {
      surface: b.surface,
      kind: KINDS.includes(b.kind) ? b.kind : 'error',
      message,
      where: scrub(oneLine(b.where, 120)),
      page: scrub(oneLine(b.page, 80)),
      device: scrub(oneLine(b.device, 60)),
      build: scrub(oneLine(b.build, 60)),
    },
  };
}

/** One JSON line for the platform logs; the per-tenant hash is supplied by the caller. */
export function clientErrorLogLine(v, tenantHash) {
  return JSON.stringify({ route: 'client-error', surface: v.surface, kind: v.kind, page: v.page, msg: v.message, where: v.where, device: v.device, build: v.build, tenant_h: tenantHash });
}
