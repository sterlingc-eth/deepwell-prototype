/**
 * Round 28 — Support Assistant, hand-off to a person. Validation, redaction and the email.
 *
 * POST /api/support {action:'handoff', email, name?, message, transcript?, surface}
 *   -> emails support@deepwelltechnology.com through the existing api/_lib/email.js sendEmail (Resend), with the
 *      customer's address as Reply-To so staff can just hit Reply. Sender stays EMAIL_FROM.
 *
 * What never leaves this file un-redacted: SSN-shaped and card-shaped runs and "password is ..." patterns are
 * removed from EVERYTHING (message, name, page, every transcript turn) before the email is built. Nothing is
 * stored server-side; the transcript is capped (last 12 turns, 600 chars each) and exists only in the email.
 */
import crypto from 'node:crypto';
import { LIMITS, SUPPORT_EMAIL, SURFACES } from './policy.js';
import { sanitizeInput } from './guard.js';
import { redactSecrets, hashForLog } from '../privacy/redact.js';

const EMAIL_RE = /^[^\s@<>()",;:\\]+@[^\s@<>()",;:\\]+\.[^\s@<>()",;:\\]{2,}$/;
const SECRET_PHRASE_RE = /\b(password|passcode|passwd|pin|secret|api[ _-]?key|token)\b(\s*(?:is|was|:|=)\s*)\S+/gi;

export function scrub(text) {
  return redactSecrets(String(text ?? '')).replace(SECRET_PHRASE_RE, '$1$2[redacted]');
}

const oneLine = (s) => String(s ?? '').replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** @returns {{ok:true, value:{email:string,name:string,message:string,transcript:Array<{role:string,text:string}>,surface:string,page:string,honeypot:boolean}}|{ok:false,error:string}} */
export function validateHandoff(body) {
  const b = body && typeof body === 'object' ? body : {};
  const email = oneLine(b.email).toLowerCase();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) return { ok: false, error: 'Please enter a valid email address so the team can reply.' };
  const message = sanitizeInput(typeof b.message === 'string' ? b.message : '');
  if (!message) return { ok: false, error: 'Please add a short message for the team.' };
  if (message.length > LIMITS.handoffMessageChars) return { ok: false, error: `Please keep your message under ${LIMITS.handoffMessageChars} characters.` };
  const surface = SURFACES.includes(b.surface) ? b.surface : 'public';
  const name = oneLine(typeof b.name === 'string' ? b.name : '').slice(0, LIMITS.handoffNameChars);
  const page = oneLine(typeof b.page === 'string' ? b.page : '').slice(0, 120);
  const transcript = (Array.isArray(b.transcript) ? b.transcript : [])
    .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.text === 'string' && t.text.trim())
    .slice(-LIMITS.handoffTranscriptTurns)
    .map((t) => ({ role: t.role, text: scrub(sanitizeInput(t.text)).slice(0, LIMITS.handoffTranscriptChars) }));
  return {
    ok: true,
    value: {
      email,
      name: scrub(name),
      message: scrub(message),
      transcript,
      surface,
      page: scrub(page),
      honeypot: typeof b.website === 'string' && b.website.trim() !== '',
    },
  };
}

export function ticketRef(now = new Date()) {
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = crypto.randomBytes(4).readUInt32BE(0).toString(36).toUpperCase().padStart(5, '0').slice(-5);
  return `DW-${ymd}-${rand}`;
}

/**
 * @param {ReturnType<typeof validateHandoff> extends infer R ? R extends {ok:true,value:infer V} ? V : never : never} v
 * @param {{ref: string, account?: {plan?: string|null, state?: string|null, role?: string|null, tenantHash?: string|null}|null}} meta
 */
export function buildHandoffEmail(v, meta) {
  const subjectBase = oneLine(v.message).slice(0, 70);
  const subject = `[DeepWell Help ${meta.ref}] ${subjectBase}`;
  const acct = meta.account
    ? `Plan: ${meta.account.plan ?? 'none'} | Billing state: ${meta.account.state ?? 'unknown'} | Role: ${meta.account.role ?? 'unknown'} | Tenant (hash): ${meta.account.tenantHash ?? 'n/a'}`
    : 'Signed out (website visitor)';
  const lines = [
    `Ticket: ${meta.ref}`,
    `From: ${v.name ? `${v.name} ` : ''}<${v.email}>  (reply to this email to answer them)`,
    `Surface: ${v.surface}${v.page ? `  Page: ${v.page}` : ''}`,
    acct,
    '',
    'Message:',
    v.message,
  ];
  if (v.transcript.length) {
    lines.push('', `Recent chat (last ${v.transcript.length} turns, redacted):`);
    for (const t of v.transcript) lines.push(`${t.role === 'user' ? 'Visitor' : 'Assistant'}: ${t.text.replace(/\n+/g, ' ')}`);
  }
  lines.push('', 'Sent by the DeepWell Support Assistant. SSN/card numbers and passwords are redacted before sending.');
  const text = lines.join('\n');
  const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5">${lines.map((l) => (l === '' ? '<br>' : `<div>${esc(l)}</div>`)).join('')}</div>`;
  return { subject, text, html };
}

/**
 * @param {ReturnType<typeof validateHandoff>} validated must be ok
 * @param {{account?: object|null, send: (msg: object) => Promise<{sent: boolean, error?: string}>, now?: Date}} deps
 * @returns {Promise<{ok: boolean, ref: string, log: string}>}
 */
export async function deliverHandoff(validated, { account = null, send, now = new Date() }) {
  const v = validated.value;
  const ref = ticketRef(now);
  const { subject, text, html } = buildHandoffEmail(v, { ref, account });
  const result = await send({ to: [SUPPORT_EMAIL], subject, text, html, replyTo: v.email });
  return {
    ok: Boolean(result?.sent),
    ref,
    // Hashes and counts only — never the message or the address.
    log: `support handoff ref=${ref} surface=${v.surface} sent=${Boolean(result?.sent)} email=h:${hashForLog(v.email)} msg_len=${v.message.length} turns=${v.transcript.length}`,
  };
}
