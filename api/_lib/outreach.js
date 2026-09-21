/**
 * Customer outreach: automated email to customers whose equipment is close
 * to (or past) the end of its warranty, pitching an extended warranty /
 * maintenance agreement. See handoffs/OUTREACH_2026-09-20.md.
 *
 * Pure functions only — no DB, no network, no Clerk. api/_lib/routes/
 * outreach.js does the database work and calls into this file for every
 * decision that can be tested without one (scripts/verify-outreach.mjs).
 *
 * TIER SOURCE: the three tiers here are a subset of warrantyRules.js's
 * `alertTier` output (api/_lib/notify.js's NOTIFY_TIERS is the sibling list
 * for in-app/digest notifications) — 'unregistered-window-closing' is
 * deliberately excluded: an unregistered unit isn't a warranty-upsell
 * moment, it's a "please register this" moment, which is what the bell
 * already covers.
 */

export const OUTREACH_TIERS = Object.freeze(["expiring-90", "expiring-30", "expired"]);

const TIER_SUBJECT_PHRASE = {
  "expiring-90": "is expiring soon",
  "expiring-30": "expires in 30 days",
  expired: "has expired",
};

/** @param {string} tier one of OUTREACH_TIERS @param {string|null} shopName */
export function subjectFor(tier, shopName) {
  const phrase = TIER_SUBJECT_PHRASE[tier] ?? "needs attention";
  const shop = shopName?.trim() ? shopName.trim() : "your HVAC contractor";
  return `Your HVAC warranty ${phrase} — ${shop}`;
}

export const DEFAULT_OFFER_TEXT =
  "We offer an extended warranty and maintenance agreement that covers parts and labor beyond the " +
  "manufacturer's terms, so a future repair doesn't come as a surprise bill.";

/** Last 4 characters only, so a draft or sent email never carries a full
 *  serial number. `null` in, `null` out — a unit with no serial on file
 *  shows nothing rather than the word "null". */
export function maskSerial(serial) {
  if (!serial) return null;
  const s = String(serial).trim();
  if (!s) return null;
  return s.length <= 4 ? s : `••••${s.slice(-4)}`;
}

const STATUS_LINE = {
  expired: (unit, masked, expires) =>
    `Our records show your ${unit}${masked ? ` (serial ending ${masked})` : ""} is no longer covered by the ` +
    `manufacturer's parts warranty${expires ? ` — it expired ${expires}` : ""}.`,
  "expiring-30": (unit, masked, expires) =>
    `Our records show your ${unit}${masked ? ` (serial ending ${masked})` : ""} is nearing the end of its ` +
    `manufacturer's parts warranty${expires ? `, expiring ${expires}` : ""} — within the next 30 days.`,
  "expiring-90": (unit, masked, expires) =>
    `Our records show your ${unit}${masked ? ` (serial ending ${masked})` : ""} is nearing the end of its ` +
    `manufacturer's parts warranty${expires ? `, expiring ${expires}` : ""}.`,
};

/**
 * Render a plain-English outreach email. Deterministic, no model call — the
 * brief's requirement, mirroring src/screens/DashboardScreen.tsx's existing
 * `outreachDraft()` clipboard template but with a mandatory opt-out footer
 * and a masked serial (that clipboard draft is a rep's private scratch pad;
 * this one is actually emailed to the customer).
 *
 * @param {{tier: string, shopName?: string|null, customerName?: string|null,
 *   manufacturer?: string|null, model?: string|null, serial?: string|null,
 *   installDate?: string|null, expiryDate?: string|null,
 *   offerText?: string|null, replyTo?: string|null, address?: string|null}} args
 * @returns {{subject: string, bodyText: string, footer: string}}
 */
export function renderOutreachEmail({
  tier,
  shopName = null,
  customerName = null,
  manufacturer = null,
  model = null,
  serial = null,
  installDate = null,
  expiryDate = null,
  offerText = null,
  replyTo = null,
  address = null,
  // REQUEST 2 (draft-to-copy, 2026-09-21): the shop's own contact details,
  // beyond just its name — "Donovan uses their information to draft the
  // emails." All optional and additive; every existing caller/test that
  // omits them gets byte-identical output to before.
  shopPhone = null,
  senderName = null,
  signature = null,
}) {
  const shop = shopName?.trim() || "your HVAC service team";
  const name = customerName?.trim() || "there";
  const unit = [manufacturer, model].filter(Boolean).join(" ").trim() || "HVAC unit";
  const masked = maskSerial(serial);
  const statusLine = (STATUS_LINE[tier] ?? STATUS_LINE["expiring-90"])(unit, masked, expiryDate);
  const offer = offerText?.trim() || DEFAULT_OFFER_TEXT;
  // Sign-off: an explicit signature line wins, then the sender's own name,
  // then just the shop name — exactly today's behavior when neither is set.
  const signOff = signature?.trim() || senderName?.trim() || shop;
  const contactBits = [];
  if (replyTo?.trim()) contactBits.push(`reach us at ${replyTo.trim()}`);
  if (shopPhone?.trim()) contactBits.push(`call us at ${shopPhone.trim()}`);
  const replyLine = contactBits.length
    ? `Reply to this email or ${contactBits.join(" or ")} to get started.`
    : "Reply to this email to get started.";

  // Mandatory: every outreach email says why the recipient is getting it and
  // how to opt out (handoffs/OUTREACH_2026-09-20.md's CAN-SPAM note). `address`
  // is the tenant's physical address if one is on file; omitted, never
  // fabricated, when it isn't (see the handoff for the compliance gap this
  // leaves until a shop enters one).
  const footer = `You're receiving this because ${shop} serviced your equipment. Reply STOP to opt out.${
    address?.trim() ? ` ${address.trim()}` : ""
  }`;

  const lines = [
    `Hi ${name},`,
    "",
    statusLine,
    ...(installDate ? [`Installed: ${installDate}.`] : []),
    "",
    offer,
    "",
    replyLine,
    "",
    `— ${signOff}`,
    "",
    footer,
  ];

  return { subject: subjectFor(tier, shop), bodyText: lines.join("\n"), footer };
}

/** The exact dedupe key the DB's UNIQUE (tenant_id, equipment_id, tier)
 *  enforces — exported so the rule can be asserted with no database. */
export function dedupeKey(equipmentId, tier) {
  return `${equipmentId}:${tier}`;
}

/** True once a customer has opted out (`entities.data->>'opted_out'`, stored
 *  as the string "true" once round-tripped through Postgres jsonb ->> ,
 *  hence the loose check rather than `=== true`). */
export function isOptedOut(customerData) {
  const v = customerData?.opted_out;
  return v === true || v === "true";
}

/** At most `max` rows, stable order preserved — the sendApproved cap. */
export function batchForSend(rows, max = 50) {
  return (rows ?? []).slice(0, Math.max(0, max));
}

/**
 * REVIEW FIX 2026-09-20 (item 4): how many approved drafts one sendApproved
 * pass may send. An interactive admin click gets the full 50; the
 * unattended nightly auto-sweep is capped tighter (20) so one tenant with a
 * big backlog can't eat the whole shared cron budget — the rest carry over
 * to the next night via the fairness ordering (mark_outreach_swept, see
 * M3-config/18-outreach.sql). Pure so the cap itself is asserted with no
 * database.
 */
export const SEND_BATCH_CAP = Object.freeze({ interactive: 50, auto: 20 });

/** @param {'interactive'|'auto'} context */
export function sendCapFor(context) {
  return SEND_BATCH_CAP[context] ?? SEND_BATCH_CAP.interactive;
}

/**
 * REVIEW FIX 2026-09-20 (item 1): 'approve' and 'sendApproved' are the two
 * ops that turn a draft into something a customer will actually receive —
 * both must refuse until an admin has explicitly turned outreach on, even
 * though a draft can be generated and previewed with it off. Pure gate,
 * checked before either op opens a transaction.
 * @param {string} op
 * @param {{enabled?: boolean}|null|undefined} settings
 * @returns {{status: number, error: string}|null} null means "allowed"
 */
export function assertEnabledForOp(op, settings) {
  if (op !== "approve" && op !== "sendApproved") return null;
  if (settings?.enabled) return null;
  return { status: 409, error: "Turn on Customer outreach in settings first" };
}

/**
 * REQUEST 2b (2026-09-21): mode='review' (Donovan drafts, a human copies or
 * opens in their own mail app) never needs anything beyond the base
 * product — no RESEND_API_KEY, no add-on. mode='auto' (unattended nightly
 * sending) is a paid add-on: refused with 402 unless the tenant holds the
 * `outreachAuto` entitlement (api/_lib/plan.js's hasOutreachAutoEntitlement).
 * Pure so scripts/verify-outreach.mjs can assert both branches with no
 * database.
 * @param {string|undefined} mode 'review' | 'auto' | undefined
 * @param {boolean} hasOutreachAutoEntitlement
 * @returns {{status: number, error: string}|null} null means "allowed"
 */
export function assertModeAllowed(mode, hasOutreachAutoEntitlement) {
  if (mode !== "auto") return null;
  if (hasOutreachAutoEntitlement) return null;
  return {
    status: 402,
    error:
      "Auto-send is an add-on. Upgrade your plan to turn it on — Donovan will keep drafting for you to copy and send in the meantime.",
  };
}

/**
 * What the nightly sweep should do for one enabled tenant: 'auto' generates
 * AND sends, 'review' only generates drafts (+ an in-app notification).
 * Pure restatement of the settings.mode column so the branch is testable
 * without a database.
 * @param {{mode?: string}|null|undefined} settings
 */
export function sweepAction(settings) {
  return settings?.mode === "auto" ? "auto" : "review";
}

/**
 * Which of a tenant's warranty-attention items (api/warranty-attention.js's
 * `getWarrantyAttention` shape) are outreach candidates, and why not for the
 * rest. Pure — the caller supplies `contacts` (equipmentId -> {email,
 * customerId, optedOut}) and `existingKeys` (Set of dedupeKey() strings
 * already drafted) so this needs no database itself.
 *
 * @param {{entityId: string, tier: string}[]} items
 * @param {Map<string, {email: string|null, customerId: string|null, optedOut: boolean}>} contacts
 * @param {Set<string>} existingKeys
 * @param {number} leadDays only 'expiring-*' tiers are filtered by this; 'expired' always qualifies
 * @param {Map<string, number|null>} daysLeftByEntity
 */
export function classifyCandidates(items, contacts, existingKeys, leadDays, daysLeftByEntity) {
  const eligible = [];
  let needsEmail = 0;
  let optedOut = 0;
  let alreadyDrafted = 0;
  let outsideLeadWindow = 0;

  for (const item of items ?? []) {
    if (!OUTREACH_TIERS.includes(item.tier)) continue;

    if (item.tier !== "expired") {
      const daysLeft = daysLeftByEntity?.get(item.entityId) ?? null;
      if (daysLeft != null && daysLeft > leadDays) {
        outsideLeadWindow++;
        continue;
      }
    }

    const key = dedupeKey(item.entityId, item.tier);
    if (existingKeys.has(key)) {
      alreadyDrafted++;
      continue;
    }

    const contact = contacts?.get(item.entityId);
    if (contact?.optedOut === true) {
      optedOut++;
      continue;
    }
    if (!contact?.email) {
      needsEmail++;
      continue;
    }

    eligible.push({ item, contact });
  }

  return { eligible, needsEmail, optedOut, alreadyDrafted, outsideLeadWindow };
}
