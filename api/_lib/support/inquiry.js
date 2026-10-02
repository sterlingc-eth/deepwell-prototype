/**
 * Round 44 - website inquiry form ("Send my question" in the closing "Talk to us" section of index.html).
 *
 * POST /api/support {action:'inquiry', name, company, email, phone?, size?, where?:[...], message, website (honeypot), elapsedMs}
 *   -> 200 {ok:true}                                      sent (or silently dropped as a bot: same answer on purpose)
 *   -> 400 {error, fields:{name?,company?,email?,phone?,size?,where?,message?}}   plain-English, per field
 *   -> 429 {error, retryAfterSec}                          over the inquiry limits; the message tells the visitor to email us
 *   -> 502 {error}                                         email provider missing or failed; the page shows the email-us fallback
 *
 * Email is the record: nothing is stored. Two emails, both through api/_lib/email.js sendEmail (Resend):
 *   (a) team notification to INQUIRY_TO_EMAIL (default hello@deepwelltechnology.com), subject exactly
 *       "[DeepWell inquiry] <Company> - <size band>", plain text listing every field, Reply-To = the visitor.
 *   (b) a short plain-text receipt to the visitor, sent only after (a) succeeded, only to an address that passed
 *       validation, and only inside the per-IP, per-address and global caps below (so it cannot be used to mail third parties at volume).
 *
 * Header safety: the only visitor-controlled text that reaches a header is the sanitized Reply-To address (strict validator,
 * no whitespace or control characters) and the company name inside the subject (control characters, angle brackets and
 * line breaks stripped, length capped). Everything else lives in the body.
 *
 * Logging: one line of counts and hashes. No name, company, address, phone or message text is ever logged, and nothing about
 * an inquiry goes to Sentry.
 */
import { SALES_EMAIL, RATE } from './policy.js';
import { sanitizeInput, redactSensitive } from './guard.js';
import { isValidEmail } from './handoff.js';
import { redactSecrets, hashForLog } from '../privacy/redact.js';

/** Where inquiries go. Env INQUIRY_TO_EMAIL overrides it (only a strictly valid address is accepted). */
export const INQUIRY_DEFAULT_TO = SALES_EMAIL; // hello@deepwelltechnology.com
export const INQUIRY_REPLY_PROMISE = 'one business day';

export const INQUIRY_LIMITS = Object.freeze({
  nameChars: 100,
  companyChars: 120,
  subjectCompanyChars: 80,
  phoneChars: 30,
  messageMin: 5,
  messageChars: 2000,
  minFillMs: 2500,         // the page waits until 3 s have passed since the visitor started typing; faster than this = a script
  perIpPerHour: RATE.inquiryPerIpPerHour,
  globalPerDay: RATE.inquiryGlobalPerDay,
  perAddressPerDay: RATE.inquiryPerAddressPerDay, // the same visitor address can be mailed a receipt at most twice a day
});

/** Wire value -> label used in the email. The page's select and checkboxes use exactly these keys. */
export const SIZE_BANDS = Object.freeze({
  'not-sure': 'Not sure',
  'lt-1k': 'Under 1,000',
  '1k-5k': '1,000–5,000',
  '5k-25k': '5,000–25,000',
  '25k-50k': '25,000–50,000',
  'gt-50k': 'More than 50,000',
});
export const WHERE_OPTIONS = Object.freeze({
  paper: 'Paper',
  computer: 'On a computer or shared drive',
  'google-drive': 'Google Drive',
  other: 'Other software',
});

const MSG = Object.freeze({
  name: 'Please tell us your name.',
  nameLong: `Please keep your name under ${INQUIRY_LIMITS.nameChars} characters.`,
  company: 'Please add your company name.',
  companyLong: `Please keep the company name under ${INQUIRY_LIMITS.companyChars} characters.`,
  email: 'Please enter your work email, like name@company.com, so we can reply.',
  phone: "That phone number doesn't look right. You can leave it blank.",
  size: 'Please pick one of the document counts in the list.',
  where: 'Please pick from the places in the list.',
  message: 'Please type your question so we know how to help.',
  messageShort: 'Please add a little more detail so we can answer well.',
  messageLong: `Please keep your question under ${INQUIRY_LIMITS.messageChars} characters.`,
  summary: 'Please check the highlighted fields.',
});

const oneLine = (s) => String(s ?? '').replace(/[\r\n\u2028\u2029\u0085]+/g, ' ').replace(/\s+/g, ' ').trim();
// control, format, bidi and zero-width characters, and angle brackets (no HTML or fake tags can survive)
// eslint-disable-next-line no-control-regex
const UNSAFE_RE = /[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
const clean = (s) => String(typeof s === 'string' ? s : '').replace(UNSAFE_RE, '');
const scrubText = (s) => redactSensitive(redactSecrets(s));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The team address, from the env when it is a strictly valid address, else the default. */
export function inquiryRecipient(env = process.env) {
  const v = oneLine(env?.INQUIRY_TO_EMAIL).toLowerCase();
  return v && isValidEmail(v) ? v : INQUIRY_DEFAULT_TO;
}

/**
 * Bots: a filled honeypot, or a submit that came too fast (or without a timer at all). Checked BEFORE validation so
 * a bot learns nothing from error messages. Pure.
 */
export function looksLikeBot(body, min = INQUIRY_LIMITS.minFillMs) {
  const b = body && typeof body === 'object' ? body : {};
  if (typeof b.website === 'string' && b.website.trim() !== '') return 'honeypot';
  if (b.website !== undefined && b.website !== null && typeof b.website !== 'string') return 'honeypot';
  const t = Number(b.elapsedMs);
  if (!Number.isFinite(t) || t < min) return 'too-fast';
  return null;
}

/**
 * @returns {{ok:true, value:{name:string,company:string,email:string,phone:string,size:string,sizeLabel:string,where:string[],whereLabels:string[],message:string}}
 *          |{ok:false, error:string, fields:Record<string,string>}}
 */
export function validateInquiry(body) {
  const b = body && typeof body === 'object' ? body : {};
  const fields = {};

  const name = scrubText(oneLine(clean(b.name)).replace(/@/g, '')).trim();
  if (!name) fields.name = MSG.name;
  else if (name.length > INQUIRY_LIMITS.nameChars) fields.name = MSG.nameLong;

  const company = scrubText(oneLine(clean(b.company))).trim();
  if (!company) fields.company = MSG.company;
  else if (company.length > INQUIRY_LIMITS.companyChars) fields.company = MSG.companyLong;

  const email = oneLine(typeof b.email === 'string' ? b.email : '').toLowerCase();
  if (!isValidEmail(email)) fields.email = MSG.email;

  let phone = '';
  const rawPhone = oneLine(clean(b.phone));
  if (rawPhone) {
    const digits = rawPhone.replace(/\D/g, '');
    if (rawPhone.length > INQUIRY_LIMITS.phoneChars || !/^[0-9+().\-\sxX#]+$/.test(rawPhone) || digits.length < 7 || digits.length > 15) fields.phone = MSG.phone;
    else phone = rawPhone;
  }

  const sizeKey = b.size === undefined || b.size === null || b.size === '' ? 'not-sure' : b.size;
  const size = typeof sizeKey === 'string' && Object.hasOwn(SIZE_BANDS, sizeKey) ? sizeKey : null;
  if (!size) fields.size = MSG.size;

  let where = [];
  if (b.where !== undefined && b.where !== null && b.where !== '') {
    const list = Array.isArray(b.where) ? b.where : null;
    if (!list || list.length > 8 || !list.every((w) => typeof w === 'string' && Object.hasOwn(WHERE_OPTIONS, w))) fields.where = MSG.where;
    else where = Object.keys(WHERE_OPTIONS).filter((k) => list.includes(k)); // de-duplicated, fixed order
  }

  const message = scrubText(sanitizeInput(clean(b.message))).trim();
  if (!message) fields.message = MSG.message;
  else if (message.length < INQUIRY_LIMITS.messageMin) fields.message = MSG.messageShort;
  else if (message.length > INQUIRY_LIMITS.messageChars) fields.message = MSG.messageLong;

  if (Object.keys(fields).length) return { ok: false, error: MSG.summary, fields };
  return {
    ok: true,
    value: { name, company, email, phone, size, sizeLabel: SIZE_BANDS[size], where, whereLabels: where.map((k) => WHERE_OPTIONS[k]), message },
  };
}

/** The subject, exactly "[DeepWell inquiry] <Company> — <size band>". Company is single-line, bracket-free and capped. */
export function inquirySubject(v) {
  const company = oneLine(clean(v.company)).slice(0, INQUIRY_LIMITS.subjectCompanyChars).trim();
  return `[DeepWell inquiry] ${company} — ${v.sizeLabel}`;
}

export function buildInquiryEmail(v, { at = new Date() } = {}) {
  const lines = [
    'New website inquiry (reply to this email to answer the visitor).',
    '',
    `Name: ${v.name}`,
    `Company: ${v.company}`,
    `Work email: ${v.email}`,
    `Phone: ${v.phone || '(not given)'}`,
    `Documents: ${v.sizeLabel}`,
    `Where they are today: ${v.whereLabels.length ? v.whereLabels.join('; ') : '(not given)'}`,
    `Received: ${at.toISOString()}`,
    '',
    'Question:',
    v.message,
    '',
    'Sent from the "Talk to us" form on deepwelltechnology.com. SSN/card numbers and passwords are redacted before sending.',
  ];
  const text = lines.join('\n');
  const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5">${lines.map((l) => (l === '' ? '<br>' : `<div>${esc(l)}</div>`)).join('')}</div>`;
  return { subject: inquirySubject(v), text, html };
}

/** Short, plain, no marketing, one link (the site). The greeting uses the first word of the sanitized name; it is body text, never a header. */
export function buildAutoReply(v) {
  // Only a plain first name is echoed (letters, hyphen, apostrophe): a link or odd text in the name field must not ride along in a receipt.
  const w = v.name.split(' ')[0];
  const first = /^[\p{L}\p{M}'\u2019-]{1,40}$/u.test(w) ? w : 'there';
  const text = [
    `Hi ${first},`,
    '',
    'Thanks for your question. It reached Sterling and Hilton at DeepWell Technology, and one of us will reply by email within one business day.',
    '',
    'You do not need to do anything else. If you want to add something, just reply to this email.',
    '',
    'DeepWell Technology',
    'https://deepwelltechnology.com',
  ].join('\n');
  const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5">${text.split('\n').map((l) => (l === '' ? '<br>' : `<div>${esc(l)}</div>`)).join('')}</div>`;
  return { subject: 'We got your question - DeepWell Technology', text, html };
}

const FALLBACK_ERROR = (to) => `We could not send that just now. Please email us at ${to} and we will reply within ${INQUIRY_REPLY_PROMISE}.`;
const LIMIT_ERROR = (to) => `We have had a lot of messages from your network. Please email us at ${to} instead and we will reply within ${INQUIRY_REPLY_PROMISE}.`;

/**
 * The whole action. Pure apart from the injected `send` and `limiter`, so the verify script runs it with a mocked sender.
 * @param {object} body parsed request body
 * @param {{req?: object, limiter: {checkInquiry: Function}, send: (m: object) => Promise<{sent:boolean, error?:string}>, env?: object, now?: Date, log?: (line: string) => void}} deps
 * @returns {Promise<{status:number, body:object}>}
 */
export async function runInquiry(body, { req, limiter, send, env = process.env, now = new Date(), log = (l) => console.log(l) }) {
  const to = inquiryRecipient(env);
  const ok = { status: 200, body: { ok: true } };

  const bot = looksLikeBot(body);
  if (bot) {
    log(`support inquiry dropped reason=${bot}`);
    return ok; // same answer a real visitor gets, nothing sent, nothing learned
  }

  const v = validateInquiry(body);
  if (!v.ok) return { status: 400, body: { error: v.error, fields: v.fields } };
  const q = v.value;

  const rl = await limiter.checkInquiry({ req, email: q.email });
  if (!rl.ok) {
    log(`support inquiry rate_limited scope=${rl.scope}`);
    return { status: 429, body: { error: LIMIT_ERROR(to), retryAfterSec: rl.retryAfterSec ?? 3600 } };
  }

  const m = buildInquiryEmail(q, { at: now });
  let notified = false;
  try {
    const r = await send({ to: [to], subject: m.subject, text: m.text, html: m.html, replyTo: q.email });
    notified = Boolean(r?.sent);
  } catch { notified = false; }
  if (!notified) {
    log(`support inquiry sent=false email=h:${hashForLog(q.email)} msg_len=${q.message.length}`);
    return { status: 502, body: { error: FALLBACK_ERROR(to) } };
  }

  // Receipt to the visitor: best effort, never blocks or fails the request, never to the team address itself.
  let receipt = false;
  if (isValidEmail(q.email) && q.email !== to) {
    try {
      const a = buildAutoReply(q);
      const r = await send({ to: [q.email], subject: a.subject, text: a.text, html: a.html, replyTo: to });
      receipt = Boolean(r?.sent);
    } catch { receipt = false; }
  }
  log(`support inquiry sent=true receipt=${receipt} email=h:${hashForLog(q.email)} size=${q.size} where=${q.where.length} company_len=${q.company.length} msg_len=${q.message.length}`);
  return ok;
}
