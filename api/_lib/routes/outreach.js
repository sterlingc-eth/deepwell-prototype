/**
 * Customer outreach (handoffs/OUTREACH_2026-09-20.md): automated email to
 * customers whose equipment is close to (or past) the end of its warranty.
 * Dispatched from api/account.js's `?action=outreach`.
 *
 * POST /api/account?action=outreach
 * body: { op: 'settings' | 'saveSettings' | 'list' | 'generate' | 'approve'
 *            | 'skip' | 'sendApproved' | 'preview' | 'optOut', ... }
 *
 * Same raw-client withTenant idiom as api/_lib/routes/document-delete.js and
 * keys.js (own resolve_tenant()/SET LOCAL transaction on recordsStore.js's
 * shared pool) rather than recordsStore.js's curated store — outreach's
 * reads join `entities` (equipment -> customer) in ways nothing else in that
 * store does, and this is exactly the kind of bespoke query reviewStore.js's
 * module comment says does not belong behind a generic column-allowlist
 * updater. `tenant_outreach_settings`/`outreach_messages` carry FORCE RLS
 * (M3-config/18-outreach.sql) so every statement here is tenant-scoped by
 * the transaction's `app.tenant_id` alone, same as every other table.
 *
 * Admin required (hasShop -> requireRole 'admin', same pattern as
 * api/_lib/routes/keys.js) for saveSettings / approve / sendApproved —
 * sending real email to a shop's customers, and turning it on, is an owner
 * decision. generate / list / skip / preview / optOut are open to any
 * signed-in member, same as reading or triaging the Inbox.
 */
import { requireAuth, denyAuth, hasShop, requireRole, AuthError } from "../auth.js";
import { handleCors, handleError } from "../claude.js";
import { getPool } from "../recordsStore.js";
import { getWarrantyAttention } from "../../warranty-attention.js";
import { limit as rateLimit } from "../rateLimit.js";
import { sendEmail } from "../email.js";
import { sweepWithDeadline, withTimeout } from "../notify.js";
import { hasOutreachAutoEntitlement } from "../plan.js";
import {
  OUTREACH_TIERS,
  renderOutreachEmail,
  dedupeKey,
  isOptedOut,
  maskSerial,
  batchForSend,
  sweepAction,
  classifyCandidates,
  assertEnabledForOp,
  assertModeAllowed,
  sendCapFor,
} from "../outreach.js";

/** Distinct from AuthError (403) and the generic 42P01 migration-pending
 *  path — a plain client error with its own status/message, same shape as
 *  customers.js's CustomerLookupError. */
export class OutreachError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "OutreachError";
    this.status = status;
  }
}

export const config = { api: { bodyParser: { sizeLimit: "32kb" } } };

const TENANT = "tenant_id = (current_setting('app.tenant_id', true))::uuid";
const MAX_SEND_BATCH = 50;
const MAX_IDS = 100;
const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  mode: "review",
  leadDays: 90,
  fromName: null,
  replyTo: null,
  offerText: null,
  // REQUEST 2a (draft-to-copy, 2026-09-21): the shop's own details Donovan's
  // template uses (M3-config/21-outreach-shop-fields.sql).
  shopName: null,
  shopPhone: null,
  signature: null,
});

/** Same memoized information_schema-probe idiom as recordsStore.js's
 *  documentsHaveUpdatedAt — guards upsertSettings' INSERT column list so a
 *  deploy that lands before M3-config/21 is pasted just can't persist these
 *  three fields yet, instead of a 42703 undefined_column error. Reads are
 *  already tolerant for free: `SELECT *` + shapeSettings()'s `?? null`. */
let outreachHasShopFields = null;
async function outreachSettingsHaveShopFields(client) {
  if (outreachHasShopFields !== null) return outreachHasShopFields;
  try {
    const r = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tenant_outreach_settings' AND column_name = 'shop_name'`
    );
    outreachHasShopFields = r.rowCount > 0;
  } catch {
    return false;
  }
  return outreachHasShopFields;
}

async function withTenantTx(ctx, fn) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT resolve_tenant($1, $2) AS id", [ctx.tenantKey, ctx.tenantName ?? ctx.tenantKey]);
    const tenantId = rows[0].id;
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client, tenantId);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function logAudit(client, tenantId, { clerkUserId, action, resourceId, changes }) {
  let userId = null;
  if (clerkUserId) {
    const { rows } = await client.query(`SELECT id FROM users WHERE clerk_user_id = $1 AND ${TENANT}`, [clerkUserId]);
    userId = rows[0]?.id ?? null;
  }
  const payload = { ...(changes ?? {}) };
  if (!userId && clerkUserId) payload.clerk_user_id = clerkUserId;
  await client.query(
    `INSERT INTO audit_log (tenant_id, user_id, action, resource_type, resource_id, changes, created_at)
     VALUES ($1,$2,$3,'outreach_message',$4,$5,NOW())`,
    [tenantId, userId, action, resourceId ?? null, payload]
  );
}

function shapeSettings(row) {
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    enabled: row.enabled,
    mode: row.mode,
    leadDays: row.lead_days,
    fromName: row.from_name,
    replyTo: row.reply_to,
    offerText: row.offer_text,
    // `?? null`: undefined (column doesn't exist yet, M3-config/21 not
    // applied) reads the same as an explicit NULL — never throws, never
    // shows "undefined" in the UI.
    shopName: row.shop_name ?? null,
    shopPhone: row.shop_phone ?? null,
    signature: row.signature ?? null,
  };
}

async function getSettings(client, tenantId) {
  const { rows } = await client.query(`SELECT * FROM tenant_outreach_settings WHERE tenant_id = $1`, [tenantId]);
  return shapeSettings(rows[0] ?? null);
}

async function getTenantName(client, tenantId) {
  const { rows } = await client.query(`SELECT name FROM tenants WHERE id = $1`, [tenantId]);
  return rows[0]?.name ?? null;
}

async function upsertSettings(client, tenantId, patch) {
  const current = await getSettings(client, tenantId);
  const leadDaysNum = Number(patch.leadDays);
  const merged = {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
    mode: patch.mode === "auto" || patch.mode === "review" ? patch.mode : current.mode,
    leadDays: Number.isFinite(leadDaysNum) && leadDaysNum >= 1 && leadDaysNum <= 365 ? Math.trunc(leadDaysNum) : current.leadDays,
    fromName: typeof patch.fromName === "string" ? patch.fromName.trim().slice(0, 200) || null : current.fromName,
    replyTo: typeof patch.replyTo === "string" ? patch.replyTo.trim().slice(0, 200) || null : current.replyTo,
    offerText: typeof patch.offerText === "string" ? patch.offerText.trim().slice(0, 2000) || null : current.offerText,
    shopName: typeof patch.shopName === "string" ? patch.shopName.trim().slice(0, 200) || null : current.shopName,
    shopPhone: typeof patch.shopPhone === "string" ? patch.shopPhone.trim().slice(0, 40) || null : current.shopPhone,
    signature: typeof patch.signature === "string" ? patch.signature.trim().slice(0, 200) || null : current.signature,
  };

  if (await outreachSettingsHaveShopFields(client)) {
    const { rows } = await client.query(
      `INSERT INTO tenant_outreach_settings (tenant_id, enabled, mode, lead_days, from_name, reply_to, offer_text, shop_name, shop_phone, signature, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
       ON CONFLICT (tenant_id) DO UPDATE
         SET enabled = $2, mode = $3, lead_days = $4, from_name = $5, reply_to = $6, offer_text = $7,
             shop_name = $8, shop_phone = $9, signature = $10, updated_at = NOW()
       RETURNING *`,
      [tenantId, merged.enabled, merged.mode, merged.leadDays, merged.fromName, merged.replyTo, merged.offerText,
       merged.shopName, merged.shopPhone, merged.signature]
    );
    return shapeSettings(rows[0]);
  }
  const { rows } = await client.query(
    `INSERT INTO tenant_outreach_settings (tenant_id, enabled, mode, lead_days, from_name, reply_to, offer_text, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT (tenant_id) DO UPDATE
       SET enabled = $2, mode = $3, lead_days = $4, from_name = $5, reply_to = $6, offer_text = $7, updated_at = NOW()
     RETURNING *`,
    [tenantId, merged.enabled, merged.mode, merged.leadDays, merged.fromName, merged.replyTo, merged.offerText]
  );
  return shapeSettings(rows[0]);
}

/** equipmentId -> {customerId, email, optedOut}. LEFT JOIN so a unit whose
 *  customer link is missing (or whose customer has no email) still shows up
 *  — as a "needs email" candidate, never silently dropped. `tenant_id`
 *  predicates on both sides of the join are belt-and-braces (RLS already
 *  scopes both tables to app.tenant_id) — REVIEW FIX 2026-09-20 (item 3),
 *  same defensive pattern recordsStore.js documents on its own by-id reads. */
async function fetchContacts(client, tenantId, equipmentIds) {
  const ids = [...new Set(equipmentIds)].slice(0, 500);
  if (!ids.length) return new Map();
  const { rows } = await client.query(
    `SELECT e.id AS equipment_id, e.customer_id,
            c.data->>'email' AS email, c.data->>'opted_out' AS opted_out_raw
       FROM entities e
       LEFT JOIN entities c ON c.id = e.customer_id AND c.entity_type = 'customer' AND c.tenant_id = $2
      WHERE e.id = ANY($1::uuid[]) AND e.entity_type = 'equipment' AND e.tenant_id = $2`,
    [ids, tenantId]
  );
  const map = new Map();
  for (const r of rows) {
    map.set(r.equipment_id, {
      customerId: r.customer_id,
      email: r.email && r.email.includes("@") ? r.email : null,
      optedOut: isOptedOut({ opted_out: r.opted_out_raw }),
    });
  }
  return map;
}

async function fetchExistingKeys(client, tenantId, equipmentIds) {
  const ids = [...new Set(equipmentIds)].slice(0, 500);
  if (!ids.length) return new Set();
  const { rows } = await client.query(
    `SELECT equipment_id, tier FROM outreach_messages WHERE equipment_id = ANY($1::uuid[]) AND tenant_id = $2`,
    [ids, tenantId]
  );
  return new Set(rows.map((r) => dedupeKey(r.equipment_id, r.tier)));
}

/**
 * Draft creation core, shared by the interactive `generate` op and the
 * nightly sweep. `items` is `getWarrantyAttention().items` already filtered
 * to nothing — the caller passes the raw list, this narrows to
 * OUTREACH_TIERS and applies leadDays/dedupe/opt-out itself
 * (classifyCandidates, api/_lib/outreach.js) so that decision is testable
 * with no database.
 */
async function generateDraftsFromItems(client, tenantId, { shopName, settings }, items) {
  const candidateItems = items.filter((i) => OUTREACH_TIERS.includes(i.tier));
  const equipmentIds = candidateItems.map((i) => i.entityId);
  const [contacts, existingKeys] = await Promise.all([
    fetchContacts(client, tenantId, equipmentIds),
    fetchExistingKeys(client, tenantId, equipmentIds),
  ]);
  const daysLeftByEntity = new Map(candidateItems.map((i) => [i.entityId, i.daysLeft ?? null]));
  const { eligible, needsEmail, optedOut, alreadyDrafted, outsideLeadWindow } = classifyCandidates(
    candidateItems,
    contacts,
    existingKeys,
    settings.leadDays ?? 90,
    daysLeftByEntity
  );

  let created = 0;
  for (const { item, contact } of eligible) {
    const { subject, bodyText } = renderOutreachEmail({
      tier: item.tier,
      shopName: settings.shopName || settings.fromName || shopName,
      senderName: settings.fromName,
      signature: settings.signature,
      shopPhone: settings.shopPhone,
      customerName: item.customerName,
      manufacturer: item.manufacturer,
      model: item.model,
      serial: item.serialNumber,
      installDate: item.installDate,
      expiryDate: item.expires,
      offerText: settings.offerText,
      replyTo: settings.replyTo,
    });
    const { rows } = await client.query(
      `INSERT INTO outreach_messages (tenant_id, customer_id, equipment_id, tier, to_email, subject, body_text, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',NOW())
       ON CONFLICT (tenant_id, equipment_id, tier) DO NOTHING
       RETURNING id`,
      [tenantId, contact.customerId, item.entityId, item.tier, contact.email, subject, bodyText]
    );
    if (rows[0]) created++;
  }

  return { created, needsEmail, optedOut, alreadyDrafted, outsideLeadWindow, candidates: candidateItems.length };
}

async function approveDrafts(client, tenantId, ids, approvedBy) {
  if (ids) {
    const { rows } = await client.query(
      `UPDATE outreach_messages SET status = 'approved', approved_by = $3, approved_at = NOW()
        WHERE id = ANY($1::uuid[]) AND tenant_id = $2 AND status = 'draft' RETURNING id`,
      [ids, tenantId, approvedBy]
    );
    return rows.length;
  }
  const { rows } = await client.query(
    `UPDATE outreach_messages SET status = 'approved', approved_by = $2, approved_at = NOW()
      WHERE tenant_id = $1 AND status = 'draft' RETURNING id`,
    [tenantId, approvedBy]
  );
  return rows.length;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/**
 * Sends up to `maxBatch` currently-'approved' rows, oldest first.
 *
 * REVIEW FIX 2026-09-20 (item 4): `FOR UPDATE SKIP LOCKED` on the select
 * means an overlapping call (a double-click, or the cron and an admin
 * clicking "Send" at the same moment) can never grab the same rows — a
 * concurrent transaction just skips whatever this one already has locked,
 * rather than blocking or double-reading. The status flip to 'sending'
 * happens immediately after, still before the Resend call, so even a row
 * this transaction fails to finish (a crash mid-loop) is visibly "sending",
 * never silently still "approved" for a naive caller that doesn't lock to
 * re-select it. Both the select and every following statement are scoped
 * with an explicit `tenant_id = $n` (item 3), belt-and-braces alongside RLS.
 *
 * Opt-out is re-checked per row (not just at generate time) in case the
 * customer opted out between approval and send.
 */
async function sendApprovedBatch(client, tenantId, auth, maxBatch = MAX_SEND_BATCH) {
  const { rows } = await client.query(
    `SELECT id, to_email, subject, body_text, customer_id, equipment_id, tier
       FROM outreach_messages
      WHERE tenant_id = $1 AND status = 'approved'
      ORDER BY created_at ASC
      LIMIT $2
      FOR UPDATE SKIP LOCKED`,
    [tenantId, maxBatch]
  );
  const batch = batchForSend(rows, maxBatch);
  if (!batch.length) return { sent: 0, failed: 0, skippedOptOut: 0, attempted: 0 };

  const batchIds = batch.map((r) => r.id);
  await client.query(`UPDATE outreach_messages SET status = 'sending' WHERE id = ANY($1::uuid[]) AND tenant_id = $2`, [batchIds, tenantId]);

  let sent = 0, failed = 0, skippedOptOut = 0;
  for (const row of batch) {
    const { rows: custRows } = await client.query(
      `SELECT data->>'opted_out' AS opted_out_raw FROM entities WHERE id = $1 AND tenant_id = $2`,
      [row.customer_id, tenantId]
    );
    if (isOptedOut({ opted_out: custRows[0]?.opted_out_raw })) {
      await client.query(
        `UPDATE outreach_messages SET status = 'skipped', error = 'Customer opted out before sending.' WHERE id = $1 AND tenant_id = $2`,
        [row.id, tenantId]
      );
      skippedOptOut++;
      continue;
    }

    const result = await sendEmail({
      to: [row.to_email],
      subject: row.subject,
      text: row.body_text,
      html: `<div style="white-space:pre-wrap;font-family:inherit">${escapeHtml(row.body_text)}</div>`,
    });

    if (result.sent) {
      await client.query(`UPDATE outreach_messages SET status = 'sent', sent_at = NOW(), error = NULL WHERE id = $1 AND tenant_id = $2`, [row.id, tenantId]);
      await logAudit(client, tenantId, {
        clerkUserId: auth?.userId ?? null,
        action: "outreach.sent",
        resourceId: row.id,
        changes: { tier: row.tier, equipmentId: row.equipment_id },
      });
      sent++;
    } else {
      const err = result.error ?? (result.channel === "in-app" ? "Email is not configured yet (no RESEND_API_KEY) — nothing was sent." : "Send failed.");
      await client.query(`UPDATE outreach_messages SET status = 'failed', error = $3 WHERE id = $1 AND tenant_id = $2`, [row.id, tenantId, err]);
      failed++;
    }
  }
  return { sent, failed, skippedOptOut, attempted: batch.length };
}

async function listMessages(client, tenantId, { status, limitRaw }) {
  const lim = Math.min(Math.max(Number(limitRaw) || 100, 1), 200);
  const params = [lim, tenantId];
  let statusClause = "";
  if (status) {
    params.push(status);
    statusClause = "AND m.status = $3";
  }
  const { rows } = await client.query(
    `SELECT m.id, m.tier, m.to_email, m.subject, m.body_text, m.status, m.created_at, m.approved_at, m.sent_at, m.error,
            m.equipment_id, c.customer_number, c.data->>'customer_name' AS customer_name,
            e.data->>'model' AS model, e.data->>'manufacturer' AS manufacturer, e.data->>'serial_number' AS serial_number
       FROM outreach_messages m
       LEFT JOIN entities c ON c.id = m.customer_id AND c.tenant_id = m.tenant_id
       LEFT JOIN entities e ON e.id = m.equipment_id AND e.tenant_id = m.tenant_id
      WHERE m.tenant_id = $2 ${statusClause}
      ORDER BY (m.status = 'draft') DESC, m.created_at DESC
      LIMIT $1`,
    params
  );
  return rows;
}

function shapeMessage(r) {
  return {
    id: r.id,
    tier: r.tier,
    equipmentId: r.equipment_id,
    toEmail: r.to_email,
    subject: r.subject,
    preview: (r.body_text ?? "").slice(0, 160),
    status: r.status,
    customerNumber: r.customer_number,
    customerName: r.customer_name,
    unit: [r.manufacturer, r.model].filter(Boolean).join(" ") || null,
    serialLast4: maskSerial(r.serial_number),
    createdAt: r.created_at,
    approvedAt: r.approved_at,
    sentAt: r.sent_at,
    error: r.error,
  };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return handleCors(res, req).status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let auth;
  try {
    auth = await requireAuth(req);
  } catch (err) {
    return denyAuth(res, err);
  }
  if (!(await rateLimit(req, res, auth, "write"))) return;

  const ctx = { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId };
  const body = req.body ?? {};
  const op = typeof body.op === "string" ? body.op : "";

  try {
    if (op === "settings") {
      try {
        const { settings, outreachAutoEntitled } = await withTenantTx(ctx, async (client, tenantId) => {
          const { rows } = await client.query(`SELECT limits FROM tenants WHERE id = $1`, [tenantId]);
          return { settings: await getSettings(client, tenantId), outreachAutoEntitled: hasOutreachAutoEntitlement(rows[0]) };
        });
        return handleCors(res, req).status(200).json({ ...settings, outreachAutoEntitled, migrationPending: false });
      } catch (err) {
        if (err?.code === "42P01") return handleCors(res, req).status(200).json({ ...DEFAULT_SETTINGS, outreachAutoEntitled: false, migrationPending: true });
        throw err;
      }
    }

    if (op === "saveSettings") {
      if (hasShop(auth)) requireRole(auth, "admin");
      const patch = body.settings && typeof body.settings === "object" ? body.settings : {};
      const { settings, outreachAutoEntitled } = await withTenantTx(ctx, async (client, tenantId) => {
        const { rows } = await client.query(`SELECT limits FROM tenants WHERE id = $1`, [tenantId]);
        const entitled = hasOutreachAutoEntitlement(rows[0]);
        // REQUEST 2b: mode='auto' is a paid add-on; mode='review' never
        // needs this check (assertModeAllowed returns null immediately).
        const gate = assertModeAllowed(patch.mode, entitled);
        if (gate) throw new OutreachError(gate.error, gate.status);

        const s = await upsertSettings(client, tenantId, patch);
        await logAudit(client, tenantId, { clerkUserId: auth.userId, action: "outreach.settings_saved", changes: patch });
        return { settings: s, outreachAutoEntitled: entitled };
      });
      return handleCors(res, req).status(200).json({ ...settings, outreachAutoEntitled, migrationPending: false });
    }

    if (op === "list") {
      const status = typeof body.status === "string" ? body.status : null;
      const rows = await withTenantTx(ctx, (client, tenantId) => listMessages(client, tenantId, { status, limitRaw: body.limit }));
      return handleCors(res, req).status(200).json({ items: rows.map(shapeMessage) });
    }

    if (op === "generate") {
      const attention = await getWarrantyAttention({ tenantId: ctx.tenantKey, orgId: ctx.tenantName }, {});
      const result = await withTenantTx(ctx, async (client, tenantId) => {
        const settings = await getSettings(client, tenantId);
        // REQUEST 2a: prefill from the org/tenant name only when the shop
        // hasn't set anything more specific of its own.
        const shopName = settings.shopName || settings.fromName || (await getTenantName(client, tenantId)) || null;
        return generateDraftsFromItems(client, tenantId, { shopName, settings }, attention.items);
      });
      return handleCors(res, req).status(200).json(result);
    }

    if (op === "approve") {
      if (hasShop(auth)) requireRole(auth, "admin");
      const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === "string").slice(0, MAX_IDS) : null;
      if (!ids?.length && body.all !== true) {
        return handleCors(res, req).status(400).json({ error: "Provide ids: string[] or all: true" });
      }
      const count = await withTenantTx(ctx, async (client, tenantId) => {
        // REVIEW FIX 2026-09-20 (item 1): a draft can be generated and
        // previewed with outreach off, but nothing may be approved (a step
        // toward actually sending) until an admin has turned it on.
        const gate = assertEnabledForOp("approve", await getSettings(client, tenantId));
        if (gate) throw new OutreachError(gate.error, gate.status);

        const n = await approveDrafts(client, tenantId, ids?.length ? ids : null, auth.userId ?? "admin");
        if (n > 0) await logAudit(client, tenantId, { clerkUserId: auth.userId, action: "outreach.approved", changes: { count: n } });
        return n;
      });
      return handleCors(res, req).status(200).json({ approved: count });
    }

    if (op === "skip") {
      const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === "string").slice(0, MAX_IDS) : [];
      if (!ids.length) return handleCors(res, req).status(400).json({ error: "ids is required" });
      const count = await withTenantTx(ctx, async (client, tenantId) => {
        const { rows } = await client.query(
          `UPDATE outreach_messages SET status = 'skipped'
            WHERE id = ANY($1::uuid[]) AND tenant_id = $2 AND status IN ('draft','approved') RETURNING id`,
          [ids, tenantId]
        );
        if (rows.length) await logAudit(client, tenantId, { clerkUserId: auth.userId, action: "outreach.skipped", changes: { count: rows.length } });
        return rows.length;
      });
      return handleCors(res, req).status(200).json({ skipped: count });
    }

    if (op === "sendApproved") {
      if (hasShop(auth)) requireRole(auth, "admin");
      const result = await withTenantTx(ctx, async (client, tenantId) => {
        // REVIEW FIX 2026-09-20 (item 1): same gate as 'approve' — the cron
        // path already only ever visits enabled tenants
        // (list_outreach_enabled_tenants), but the interactive path had no
        // such check until now.
        const gate = assertEnabledForOp("sendApproved", await getSettings(client, tenantId));
        if (gate) throw new OutreachError(gate.error, gate.status);
        return sendApprovedBatch(client, tenantId, auth, sendCapFor("interactive"));
      });
      return handleCors(res, req).status(200).json(result);
    }

    if (op === "preview") {
      const id = typeof body.id === "string" ? body.id : null;
      if (!id) return handleCors(res, req).status(400).json({ error: "id is required" });
      const row = await withTenantTx(ctx, async (client, tenantId) => (
        await client.query(
          `SELECT id, tier, to_email, subject, body_text, status FROM outreach_messages WHERE id = $1 AND tenant_id = $2`,
          [id, tenantId]
        )
      ).rows[0]);
      if (!row) return handleCors(res, req).status(404).json({ error: "Not found" });
      return handleCors(res, req).status(200).json({ id: row.id, tier: row.tier, toEmail: row.to_email, subject: row.subject, bodyText: row.body_text, status: row.status });
    }

    if (op === "optOut") {
      const customerId = typeof body.customerId === "string" ? body.customerId : null;
      if (!customerId) return handleCors(res, req).status(400).json({ error: "customerId is required" });
      await withTenantTx(ctx, async (client, tenantId) => {
        await client.query(
          `UPDATE entities SET data = COALESCE(data, '{}'::jsonb) || jsonb_build_object('opted_out', true), updated_at = NOW()
            WHERE id = $1 AND entity_type = 'customer' AND ${TENANT}`,
          [customerId]
        );
        await logAudit(client, tenantId, { clerkUserId: auth.userId, action: "outreach.opt_out", resourceId: customerId });
      });
      return handleCors(res, req).status(200).json({ customerId, optedOut: true });
    }

    return handleCors(res, req).status(400).json({
      error: "op must be one of: settings, saveSettings, list, generate, approve, skip, sendApproved, preview, optOut",
    });
  } catch (error) {
    if (error instanceof AuthError) return handleCors(res, req).status(error.status).json({ error: error.message });
    if (error instanceof OutreachError) return handleCors(res, req).status(error.status).json({ error: error.message });
    return handleError(res, error, req);
  }
}

/**
 * Nightly cron entry point (api/_lib/routes/cron-sweep.js), mirroring
 * api/_lib/notify.js's runWarrantyNotificationSweep shape: its own
 * cross-tenant listing (list_outreach_enabled_tenants — SECURITY DEFINER,
 * M3-config/18-outreach.sql), the same shared-deadline scheduler
 * (sweepWithDeadline, imported from notify.js rather than duplicated), and a
 * per-tenant fairness marker (mark_outreach_swept). For 'auto' tenants this
 * generates AND sends (auto-approving whatever the generate step just
 * drafted); for 'review' tenants it only generates and drops an in-app
 * notification (kind: 'outreach') so the drafts don't sit unseen — nothing
 * is ever emailed for a 'review' tenant without an admin clicking Approve.
 */
/** One enabled tenant's worth of work for the nightly sweep — generate, then
 *  (auto mode) auto-approve + send capped at sendCapFor("auto"), or (review
 *  mode) drop an in-app notification. Pulled out to its own function so the
 *  call site below can bound it with `withTimeout`, exactly like
 *  api/_lib/notify.js's runWarrantyNotificationSweepForTenant bounds its own
 *  per-tenant work — REVIEW FIX 2026-09-20 (item 2): a big auto-mode send
 *  batch (or a slow DB/Resend call) must never itself blow the shared 45s
 *  cron deadline; sendEmail (api/_lib/email.js) now has its own 10s
 *  per-request timeout on top of this, so a single hung Resend call can't
 *  eat the whole per-tenant budget either. */
async function runOutreachSweepForTenant(tenant, settings, result) {
  const ctx = { tenantKey: tenant.tenant_key, tenantName: tenant.tenant_name ?? tenant.tenant_key };
  const attention = await getWarrantyAttention({ tenantId: ctx.tenantKey, orgId: ctx.tenantName }, {});
  await withTenantTx(ctx, async (client, tenantId) => {
    const gen = await generateDraftsFromItems(client, tenantId, { shopName: tenant.tenant_name, settings }, attention.items);
    result.drafted = gen.created;

    let action = sweepAction(settings);
    if (action === "auto") {
      // REQUEST 2b, defense in depth: saveSettings already refuses to turn
      // mode='auto' on without the entitlement, but this cron path reads
      // `tenant_outreach_settings.mode` directly — if the entitlement was
      // later revoked (a downgrade, a canceled add-on) with nobody visiting
      // Settings again to notice, degrade to 'review' rather than send.
      const { rows } = await client.query(`SELECT limits FROM tenants WHERE id = $1`, [tenantId]);
      if (!hasOutreachAutoEntitlement(rows[0])) action = "review";
    }

    if (action === "auto") {
      if (gen.created > 0) await approveDrafts(client, tenantId, null, "system:auto");
      // Capped tighter than an interactive click (sendCapFor("auto") = 20):
      // one tenant's backlog must not eat the whole shared cron budget. The
      // rest carry over to tomorrow night via mark_outreach_swept's fairness
      // ordering (list_outreach_enabled_tenants sorts oldest-swept first).
      const sendResult = await sendApprovedBatch(client, tenantId, { userId: null }, sendCapFor("auto"));
      result.sent = sendResult.sent;
      result.failed = sendResult.failed;
    } else if (gen.created > 0) {
      await client.query(
        `INSERT INTO notifications (tenant_id, kind, title, body, link) VALUES ($1,'outreach',$2,$3,'/app/?screen=outreach')`,
        [
          tenantId,
          `${gen.created} outreach draft${gen.created === 1 ? "" : "s"} ready`,
          `${gen.created} customer${gen.created === 1 ? "" : "s"} close to (or past) their warranty end — review and approve before sending.`,
        ]
      );
    }
  });
}

export async function runOutreachSweep({ deadlineAt, maxTenants = 8, perTenantMs = 3000 } = {}) {
  const pool = getPool();
  const summary = { tenantsChecked: 0, drafted: 0, sent: 0, failed: 0, skipped: 0, errors: [] };

  let tenants = [];
  try {
    const { rows } = await pool.query("SELECT * FROM list_outreach_enabled_tenants()");
    tenants = rows.slice(0, maxTenants);
  } catch (err) {
    if (err?.code === "42P01") return summary; // migration not applied yet — nothing to do, not an error
    summary.errors.push({ phase: "list-tenants", message: err?.message });
    return summary;
  }

  const effectiveDeadline = deadlineAt ?? Date.now() + 45_000;
  const { skipped } = await sweepWithDeadline(tenants, {
    deadlineAt: effectiveDeadline,
    perTenantMs,
    processTenant: async (tenant) => {
      summary.tenantsChecked += 1;
      const settings = {
        mode: tenant.mode,
        leadDays: tenant.lead_days,
        fromName: tenant.from_name,
        replyTo: tenant.reply_to,
        offerText: tenant.offer_text,
        // `?? null`: list_outreach_enabled_tenants() only returns these
        // columns once M3-config/21 is applied — undefined until then.
        shopName: tenant.shop_name ?? null,
        shopPhone: tenant.shop_phone ?? null,
        signature: tenant.signature ?? null,
      };
      const result = { drafted: 0, sent: 0, failed: 0 };
      try {
        // REVIEW FIX 2026-09-20 (item 2): bounded exactly like notify.js's
        // per-tenant call — a tenant whose work runs long is abandoned (not
        // awaited further) rather than allowed to run past its own budget.
        await withTimeout(runOutreachSweepForTenant(tenant, settings, result), perTenantMs);
      } catch (err) {
        summary.errors.push({ tenant: tenant.tenant_key, message: err?.message });
      } finally {
        // Counted even on a timeout/error: `result` may carry real progress
        // committed before the failure (generate is its own transaction,
        // already committed by the time a later send step times out) — a
        // slow tenant's partial work shouldn't be misreported as zero.
        summary.drafted += result.drafted;
        summary.sent += result.sent;
        summary.failed += result.failed;
        await pool.query("SELECT mark_outreach_swept($1, $2)", [tenant.tenant_id, new Date().toISOString()]).catch(() => {});
      }
    },
  });
  summary.skipped = skipped.length;
  return summary;
}
