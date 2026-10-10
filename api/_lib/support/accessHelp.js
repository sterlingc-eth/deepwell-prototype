/**
 * Easy support access (Team T8). The Help chat can turn "I need a person" into a time-boxed, logged
 * support-access grant in one tap, tells DeepWell staff it happened, and lets every signed-in member see
 * (and an admin end) an active grant.
 *
 *   POST /api/support {action:'access-status'}                      any signed-in member -> {active, isAdmin}
 *   POST /api/support {action:'access-grant', note?, companyName?} admin only -> {ok, already, grant}
 *   POST /api/support {action:'access-end', grantId}                admin only -> {ok}
 *
 * Rules kept from api/_lib/privacy/supportAccess.js: the tenant is only ever what the verified session says;
 * the grant is 24 hours (DEFAULT_GRANT_HOURS), revocable, and every staff access is still written to the
 * tenant's Access log. The staff notice (email + the operator's bell) carries the company name, the reason
 * the customer gave, and the expiry. It never carries document content, and the reason is scrubbed of
 * card/SSN-shaped runs and "password is ..." patterns first.
 */
import { withTenant } from '../recordsStore.js';
import { grantSupportAccess, revokeSupportAccess, getActiveGrant, DEFAULT_GRANT_HOURS } from '../privacy/supportAccess.js';
import { hashForLog } from '../privacy/redact.js';
import { sanitizeInput } from './guard.js';
import { scrub } from './handoff.js';
import { SUPPORT_EMAIL } from './policy.js';
import { sendEmail } from '../email.js';

export const GRANT_HOURS = DEFAULT_GRANT_HOURS;
export const NOTIFY_KIND = 'support-access';

const oneLine = (s) => String(s ?? '').replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const BAD_CHARS = /[<>\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Solo tenants (no org) are their own admin; inside a company only an admin may grant or end access. Same rule as review.js requireAdmin. */
export const canManageAccess = (auth) => !auth?.orgId || auth?.orgRole === 'admin';

export const DEFAULT_REASON = 'Asked for help in the Help chat';
export const NOTE_MAX = 200;

/**
 * PURE. The reason stored with the grant. It is ALWAYS the fixed sentence; the only free text is the optional
 * note the customer typed and saw before granting (scrubbed, capped). The chat transcript is never used.
 */
export function reasonFromChat(note) {
  const text = scrub(oneLine(sanitizeInput(typeof note === 'string' ? note : ''))).replace(BAD_CHARS, '').slice(0, NOTE_MAX).trim();
  return text ? `${DEFAULT_REASON}: ${text}` : DEFAULT_REASON;
}

/** PURE. Display name for the notice. The browser's value is only a label (never used for access). */
export function cleanCompanyName(name) {
  return scrub(oneLine(typeof name === 'string' ? name : '')).replace(BAD_CHARS, '').slice(0, 80).trim();
}

/** PURE. Staff email. No document content, no customer email address: company, reason, expiry, account reference. */
export function buildStaffGrantNotice({ companyName, accountRef, reason, expiresAt, hours = GRANT_HOURS, browserName = '' }) {
  // companyName is server-known (shop name) or the account reference; browserName is the unverified label from the browser.
  const company = companyName || 'A DeepWell company';
  const until = new Date(expiresAt).toUTCString();
  const subject = `[DeepWell Support access] ${company} granted ${hours} hours`.replace(/[\r\n]+/g, ' ').slice(0, 120);
  const lines = [
    `${company} let DeepWell support look at their account for ${hours} hours.`,
    '',
    `Company: ${company}`,
    `Account reference: ${accountRef}`,
    ...(browserName && browserName !== company ? [`Name typed in the browser (unverified): ${browserName}`] : []),
    `Access ends: ${until}`,
    `Reason: ${reason}`,
    '',
    'Every look is recorded in that company\'s Access log. Open their account from your operator login (you must be a member of their DeepWell company).',
  ];
  const text = lines.join('\n');
  const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5">${lines.map((l) => (l === '' ? '<br>' : `<div>${esc(l)}</div>`)).join('')}</div>`;
  return { subject, text, html };
}

/** PURE. Bell entry for the operator (title + body only, same facts as the email). */
export function buildBellNotice({ companyName, reason, expiresAt }) {
  return {
    title: `${companyName || 'A company'} granted support access`,
    body: `${reason} (until ${new Date(expiresAt).toUTCString()})`.slice(0, 400),
    link: null,
  };
}

/** The company name DeepWell itself holds (outreach shop name), never the browser's. Empty when none is saved. */
async function lookupShopName(auth) {
  try {
    return await withTenant(ctxFor(auth), async (store) => {
      const r = await store.raw(`SELECT shop_name FROM tenant_outreach_settings WHERE tenant_id = $1`, [store.tenantId]);
      return r.rows?.[0]?.shop_name ?? '';
    });
  } catch { return ''; }
}

async function writeOperatorBell(notice) {
  const founderKey = process.env.DEEPWELL_FOUNDER_TENANT_ID;
  if (!founderKey) return false;
  try {
    await withTenant({ tenantKey: founderKey, tenantName: founderKey }, (store) =>
      store.raw(`INSERT INTO notifications (tenant_id, kind, title, body, link) VALUES ($1, $2, $3, $4, $5)`,
        [store.tenantId, NOTIFY_KIND, notice.title, notice.body, notice.link]));
    return true;
  } catch (err) {
    console.error('support access bell failed:', err?.message);
    return false;
  }
}

/**
 * Tell DeepWell staff a company just turned support access on: an email through the existing sendEmail
 * wrapper plus a bell entry in the operator (founder) tenant. Used by the Help-chat button AND the Settings
 * card's Grant button (api/review.js). Never throws; a failed notice never undoes the grant.
 */
export async function notifyStaffOfGrant(auth, { reason, expiresAt, companyName } = {}, deps = {}) {
  const browserName = cleanCompanyName(companyName);
  const company = cleanCompanyName(await (deps.lookupShopName ?? lookupShopName)(auth)) || String(auth.orgId ?? auth.tenantId ?? '');
  const iso = toIso(expiresAt);
  const accountRef = auth.orgId ?? auth.tenantId;
  const reasonText = oneLine(reason || '') || 'No reason given';
  const email = buildStaffGrantNotice({ companyName: company, accountRef, reason: reasonText, expiresAt: iso, browserName });
  const bell = buildBellNotice({ companyName: company, reason: reasonText, expiresAt: iso });
  let emailed = false;
  try {
    const r = await (deps.send ?? sendEmail)({ to: [SUPPORT_EMAIL], subject: email.subject, text: email.text, html: email.html });
    emailed = Boolean(r?.sent);
  } catch { /* the grant stands; staff also see it via the bell */ }
  const belled = await (deps.writeBell ?? writeOperatorBell)(bell);
  console.log(`support access granted tenant=h:${hashForLog(auth.tenantId)} emailed=${emailed} bell=${belled}`);
  return { emailed, belled };
}

/** Status for the banner and the chat offer. Members see only the expiry; the reason stays with admins (Settings). */
export async function accessStatus(auth, deps = {}) {
  const ctx = ctxFor(auth);
  const g = await (deps.getActiveGrant ?? getActiveGrant)(ctx);
  return { active: g ? { id: g.id, expiresAt: toIso(g.expires_at ?? g.expiresAt) } : null, isAdmin: canManageAccess(auth) };
}

/**
 * Grant 24 hours from the Help chat. Idempotent: an already-active grant is returned as-is (no second grant,
 * no second email). Notification failures never undo the grant.
 * @returns {Promise<{status:number, body:object}>}
 */
export async function grantFromChat(auth, { note, companyName } = {}, deps = {}) {
  if (!canManageAccess(auth)) {
    return { status: 403, body: { error: 'Only a company admin can let support look at the account.', code: 'not-admin' } };
  }
  const ctx = ctxFor(auth);
  const getActive = deps.getActiveGrant ?? getActiveGrant;
  const existing = await getActive(ctx);
  if (existing) return { status: 200, body: { ok: true, already: true, grant: { id: existing.id, expiresAt: toIso(existing.expires_at ?? existing.expiresAt) } } };

  const reason = reasonFromChat(note);
  const grant = await (deps.grantSupportAccess ?? grantSupportAccess)(ctx, { hours: GRANT_HOURS, reason }, auth.userId);
  if (!grant) return { status: 503, body: { error: 'We could not turn on support access just now. Please use "Send this to a person" instead.', code: 'unavailable' } };

  await notifyStaffOfGrant(auth, { reason, expiresAt: grant.expiresAt, companyName }, deps);
  return { status: 200, body: { ok: true, already: false, grant: { id: grant.id, expiresAt: toIso(grant.expiresAt) } } };
}

export async function endGrant(auth, grantId, deps = {}) {
  if (!canManageAccess(auth)) return { status: 403, body: { error: 'Only a company admin can end support access.', code: 'not-admin' } };
  if (typeof grantId !== 'string' || !grantId || grantId.length > 64) return { status: 400, body: { error: 'Missing access id.' } };
  const ok = await (deps.revokeSupportAccess ?? revokeSupportAccess)(ctxFor(auth), grantId, auth.userId);
  return ok ? { status: 200, body: { ok: true } } : { status: 404, body: { error: 'Support access has already ended.' } };
}

const ctxFor = (auth) => ({ tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId });
function toIso(v) { const d = v instanceof Date ? v : new Date(v); return Number.isFinite(d.getTime()) ? d.toISOString() : null; }
