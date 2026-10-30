/**
 * Email-in: each tenant gets a private address  docs+<token>@<EMAILIN_DOMAIN>. Mail sent there becomes documents.
 *
 * Existing path: the app only SENDS mail (api/_lib/email.js, Resend); there was no inbound route, so this adds one, routed through
 * the existing account.js action "connectors" (op "email-inbound"), no new api/ file. Inbound parsing is provider-neutral:
 * normalizeInbound() turns a provider payload into { messageId, from, to[], subject, authResults, attachments[] } and everything after
 * that is pure and tested. The Resend field names inside normalizeInbound are best-effort and MUST be confirmed against Resend's
 * inbound docs before ON (owner step E3 in the report).
 *
 * Safety: the token is random (24 bytes), only its HMAC is stored, a sender allow-list is required (empty list imports nothing),
 * SPF or DKIM must pass, message ids are deduped, a per-tenant hourly cap applies, tiny inline images are skipped, attachments go
 * through the same upload allow-list and plan gate as an upload. Rejected mail is counted, never imported, never stored.
 */
import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { limits as limitsFor, WORDING } from "./config.js";

const TOKEN_RE = /^[a-z0-9]{32,64}$/;

const hmacKey = (env) => { const k = String(env.EMAILIN_ADDRESS_KEY ?? ""); if (k.length < 16) throw new Error("EMAILIN_ADDRESS_KEY is not set"); return k; };
export const tokenHash = (token, env = process.env) => createHmac("sha256", hmacKey(env)).update(String(token)).digest("hex");
export const newToken = () => randomBytes(24).toString("hex");
export const addressFor = (token, env = process.env) => `docs+${token}@${String(env.EMAILIN_DOMAIN ?? "").toLowerCase()}`;

export function tokenFromRecipients(to, env = process.env) {
  const domain = String(env.EMAILIN_DOMAIN ?? "").toLowerCase();
  for (const raw of to ?? []) {
    const m = /<?([^<>\s]+)@([^<>\s]+?)>?$/.exec(String(raw).trim().toLowerCase());
    if (!m || m[2] !== domain) continue;
    const t = /^docs\+([a-z0-9]+)$/.exec(m[1])?.[1];
    if (t && TOKEN_RE.test(t)) return t;
  }
  return null;
}

export const senderAddress = (from) => (/<([^<>]+)>/.exec(String(from ?? ""))?.[1] ?? String(from ?? "")).trim().toLowerCase();
export function senderAllowed(from, allowed) {
  const a = senderAddress(from);
  return !!a && (allowed ?? []).some((e) => { const x = String(e).trim().toLowerCase(); return x.startsWith("@") ? a.endsWith(x) : a === x; });
}

/** SPF or DKIM must say pass. `authResults` is the provider's Authentication-Results header text or { spf, dkim }. */
export function authPassed(authResults) {
  if (authResults && typeof authResults === "object") return /pass/i.test(String(authResults.dkim)) || /pass/i.test(String(authResults.spf));
  const s = String(authResults ?? "").toLowerCase();
  return /dkim=pass/.test(s) || /spf=pass/.test(s);
}

/** Svix-style webhook signature (what Resend uses). secret = "whsec_<base64>". Constant-time; 5 minute tolerance. */
export function verifyWebhook(headers, rawBody, secret, now = Date.now()) {
  try {
    const id = headers["svix-id"], ts = headers["svix-timestamp"], sigs = String(headers["svix-signature"] ?? "");
    if (!id || !ts || !sigs || !secret) return false;
    if (Math.abs(now / 1000 - Number(ts)) > 300) return false;
    const key = Buffer.from(String(secret).replace(/^whsec_/, ""), "base64");
    const want = createHmac("sha256", key).update(`${id}.${ts}.${rawBody}`).digest();
    return sigs.split(" ").some((p) => {
      const got = Buffer.from(p.split(",")[1] ?? "", "base64");
      return got.length === want.length && timingSafeEqual(got, want);
    });
  } catch { return false; }
}

/** Provider payload -> neutral message. Resend inbound field names to be confirmed (see header). */
export function normalizeInbound(payload) {
  const d = payload?.data ?? payload ?? {};
  return {
    emailId: d.email_id ?? d.id ?? null,
    messageId: String(d.message_id ?? d.headers?.["message-id"] ?? d.email_id ?? "").trim(),
    from: d.from ?? "", to: [].concat(d.to ?? []), subject: String(d.subject ?? "").slice(0, 200),
    authResults: d.headers?.["authentication-results"] ?? d.authentication_results ?? d.auth ?? null,
    attachments: (d.attachments ?? []).map((a) => ({ id: a.id, filename: a.filename ?? a.name ?? "attachment", contentType: a.content_type ?? a.contentType ?? "application/octet-stream", size: Number(a.size) || 0, inline: !!(a.content_id ?? a.contentId ?? a.inline), content: a.content })),
  };
}

/**
 * The whole inbound pass.
 * deps = { lookup(hash)->{tenantKey, allowedSenders}|null, storeFor(tenantKey)->store, importer, fetchAttachment(msg, att)->Buffer, allowance(tenantKey)->{allowed}, env, now() }
 * @returns {{status:number, outcome:string, files?:number}}  status is always 200 for "handled" so the provider does not retry.
 */
export async function handleInbound(msg, deps) {
  const env = deps.env ?? process.env, lim = limitsFor(env), now = deps.now?.() ?? Date.now();
  const token = tokenFromRecipients(msg.to, env);
  if (!token) return { status: 200, outcome: "ignored" };
  const target = await deps.lookup(tokenHash(token, env));
  if (!target) return { status: 200, outcome: "ignored" };            // unknown or disabled address: say nothing
  const store = deps.storeFor(target.tenantKey);
  const ctx = { tenantKey: target.tenantKey, tenantName: target.tenantKey };
  if (!msg.messageId) return { status: 200, outcome: "ignored" };

  const okSender = senderAllowed(msg.from, target.allowedSenders) && authPassed(msg.authResults);
  if (!okSender) { await store.recordEmailEvent(msg.messageId, "quarantined"); return { status: 200, outcome: "quarantined", note: WORDING.senderNotAllowed }; }
  if ((await store.emailCountSince(now - 3_600_000)) >= lim.emailPerHour) { await store.recordEmailEvent(msg.messageId, "rate-limited"); return { status: 200, outcome: "rate-limited" }; }
  const gate = await deps.allowance(target.tenantKey);
  if (!gate.allowed) return { status: 503, outcome: "allowance" };          // 5xx and NOT recorded: the provider retries later, once the allowance resets
  if (!(await store.recordEmailEvent(msg.messageId, "imported"))) return { status: 200, outcome: "duplicate" };

  let files = 0;
  for (const att of msg.attachments.slice(0, lim.emailMaxAttachments)) {
    if (att.inline && /^image\//i.test(att.contentType) && att.size < lim.emailMinImageBytes) continue;       // signature logos, tracking pixels
    if (/^image\//i.test(att.contentType) && att.size > 0 && att.size < lim.emailMinImageBytes) continue;
    const pre = deps.importer.precheck({ filename: att.filename, contentType: att.contentType, sizeBytes: att.size || undefined });
    if (!pre.ok) continue;
    const bytes = att.content ? Buffer.from(att.content, "base64") : await deps.fetchAttachment(msg, att);
    const r = await deps.importer.importOne(ctx, { filename: pre.filename, contentType: pre.contentType, bytes, source: "connector_emailin", externalId: `${msg.messageId}:${att.filename}`,
      folderHint: "Email", meta: { fromDomain: senderAddress(msg.from).split("@")[1] ?? null, subject: msg.subject, messageIdHash: createHash("sha256").update(msg.messageId).digest("hex").slice(0, 16) } });
    if (r.outcome === "created") files++;
    if (r.outcome === "gate") return { status: 200, outcome: "plan-full", files };
  }
  return { status: 200, outcome: files ? "imported" : "empty", files };
}
