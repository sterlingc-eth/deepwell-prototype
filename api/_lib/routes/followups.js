/**
 * Missing-info follow-ups (owner brief, handoffs/START_HERE_NEXT_CHAT.md item
 * 3; design in handoffs/TECH_FOLLOWUPS_2026-09-21.md): a document sitting in
 * Needs-attention with unresolved required fields (documentTypes.js's
 * completenessFor — the exact rule the Inbox's own "missing-field" issues
 * are built on) generates a short, deterministic message asking the
 * technician responsible for exactly what's missing. No model call.
 *
 * POST /api/account?action=followups
 *   { op: 'settings' }                          -> { enabled, email, emailAvailable }
 *   { op: 'saveSettings', settings: {...} }      -> same shape (admin only, shop tenants)
 *   { op: 'run', apply?: boolean }               -> a dry-run preview (default)
 *                                                     or, apply:true, the real thing (admin only)
 *
 * Two entry points share the per-tenant work below (runFollowupsForTenant):
 *   - the interactive `run` op above, any signed-in admin can trigger
 *   - runFollowupsSweep(), called nightly from api/_lib/routes/cron-sweep.js
 *     after the integrity pass, same shared-deadline idiom as
 *     api/_lib/notify.js / api/_lib/routes/outreach.js.
 *
 * STORAGE: no new table or column. tenants.settings (jsonb, already exists)
 * carries `followups` ({enabled, email}, admin-set) and the 24h debounce
 * ledger `followupsLastSent` ({userId: ISO string}, capped) — the same
 * read-modify-write `||` merge pattern recordsStore.js's known_shop_contacts
 * uses, and the same pattern api/_lib/routes/notifications.js already uses
 * for `settings.emailDigest`. In-app delivery reuses the `notifications`
 * table (M3-config/16-notifications.sql) with a new `kind: 'followup'` value
 * — that table has no per-user target column, so per the brief, delivery is
 * tenant-wide with the technician's name in the title, exactly like
 * api/_lib/routes/outreach.js's own `kind: 'outreach'` notifications.
 */
import { requireAuth, denyAuth, hasShop, requireRole, AuthError } from "../auth.js";
import { handleCors, handleError } from "../claude.js";
import { withTenant, getPool } from "../recordsStore.js";
import { limit as rateLimit } from "../rateLimit.js";
import { sendEmail } from "../email.js";
import { sweepWithDeadline, withTimeout } from "../notify.js";
import {
  shapeFollowupSettings,
  missingFieldsForDocument,
  docTechnicianName,
  groupDocsByTechnician,
  selectGroupsForRun,
  renderFollowupMessage,
  canSendFollowup,
  recordFollowupSent,
} from "../followups.js";

export const config = { api: { bodyParser: { sizeLimit: "16kb" } } };

const APP_URL = (process.env.APP_URL ?? "https://deepwelltechnology.com").replace(/\/$/, "");

/**
 * Same "identifier as email" / name-from-publicUserData reading as
 * api/_lib/notify.js's getOrgAdminEmails, generalized to the whole roster
 * (not just admins). src/core/memberNames.ts's memberDisplayName is the
 * client-side twin of the name-shaping below — kept as its own small copy
 * rather than imported, since that file is frontend TS and this is the
 * server runtime (same split followups.js's own header explains).
 */
async function getOrgMembers(orgId) {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey || !orgId) return [];
  try {
    const { createClerkClient } = await import("@clerk/backend");
    const clerkClient = createClerkClient({ secretKey });
    const list = await clerkClient.organizations.getOrganizationMembershipList({ organizationId: orgId, limit: 100 });
    const memberships = Array.isArray(list) ? list : (list?.data ?? []);
    return memberships
      .map((m) => {
        const pud = m?.publicUserData ?? {};
        const name = `${pud.firstName ?? ""} ${pud.lastName ?? ""}`.trim();
        const identifier = typeof pud.identifier === "string" ? pud.identifier : null;
        return {
          userId: pud.userId ?? null,
          displayName: name || identifier || null,
          email: identifier && identifier.includes("@") ? identifier : null,
          isAdmin: /^(org:)?admin$/i.test(String(m?.role ?? "")),
        };
      })
      .filter((m) => m.userId);
  } catch (err) {
    console.error("followups: getOrgMembers failed:", err?.message);
    return [];
  }
}

/**
 * documents + their extractions -> needs-attention rows, shaped for
 * followups.js's pure grouping functions. Bounded by listDocuments' own
 * 500-row cap — a shop with more open documents than that gets its 500 most
 * recent scanned per run, the same bound every other screen backed by
 * listDocuments already lives with.
 */
async function listNeedsAttentionDocs(store) {
  const docs = await store.listDocuments();
  const ids = docs.map((d) => d.id);
  const extractions = await store.listExtractionsByDocuments(ids);
  const byDoc = new Map();
  for (const e of extractions) {
    if (!byDoc.has(e.document_id)) byDoc.set(e.document_id, []);
    byDoc.get(e.document_id).push(e);
  }

  const out = [];
  for (const d of docs) {
    const docExtractions = byDoc.get(d.id) ?? [];
    const missing = missingFieldsForDocument({ document_type: d.document_type, extractions: docExtractions });
    if (!missing.length) continue;
    out.push({
      id: d.id,
      filename: d.original_filename ?? "Untitled document",
      uploadedBy: d.uploaded_by ?? null,
      technicianName: docTechnicianName(docExtractions),
      missing,
    });
  }
  return out;
}

async function getTenantRow(store) {
  const { rows } = await store.raw(`SELECT clerk_org_id, name, settings FROM tenants WHERE id = $1`, [store.tenantId]);
  return rows[0] ?? null;
}

async function saveFollowupSettings(store, patch) {
  const current = shapeFollowupSettings((await getTenantRow(store))?.settings?.followups);
  const merged = {
    enabled: typeof patch?.enabled === "boolean" ? patch.enabled : current.enabled,
    email: typeof patch?.email === "boolean" ? patch.email : current.email,
  };
  await store.raw(
    `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('followups', $2::jsonb) WHERE id = $1`,
    [store.tenantId, JSON.stringify(merged)]
  );
  return merged;
}

async function getLastSentMap(store) {
  const raw = (await getTenantRow(store))?.settings?.followupsLastSent;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

async function saveLastSentMap(store, map) {
  await store.raw(
    `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('followupsLastSent', $2::jsonb) WHERE id = $1`,
    [store.tenantId, JSON.stringify(map)]
  );
}

async function writeInAppNotification(store, { title, body, link }) {
  await store.raw(`INSERT INTO notifications (tenant_id, kind, title, body, link) VALUES ($1,'followup',$2,$3,$4)`, [
    store.tenantId,
    title,
    body,
    link,
  ]);
}

/**
 * One tenant's worth of interactive/cron work: find needs-attention docs,
 * group by technician, respect the 24h debounce, and — apply only — deliver.
 * Shared by the interactive `run` op and the nightly sweep so the two paths
 * can never disagree about what counts as due. `apply: false` computes the
 * exact same preview with no writes at all (settings/dedupe untouched),
 * which is also what makes the Team screen's "Check now" safe to call as
 * often as an admin likes.
 * @param {{store: object, orgId: string|null, settings: {enabled: boolean, email: boolean}, apply: boolean}} args
 */
async function runFollowupsForTenant({ store, orgId, settings, apply }) {
  const result = { docsFlagged: 0, techniciansDue: 0, messagesSent: 0, emailsSent: 0, debounced: 0, preview: [] };
  if (!settings.enabled) return { ...result, skippedReason: "disabled" };

  const docs = await listNeedsAttentionDocs(store);
  result.docsFlagged = docs.length;
  if (!docs.length) return result;

  const members = await getOrgMembers(orgId);
  const groups = selectGroupsForRun(groupDocsByTechnician(docs, members));
  if (!groups.length) return result; // nothing assignable — no admin on the roster to fall back to

  const lastSent = await getLastSentMap(store);
  const now = Date.now();
  let nextLastSent = lastSent;

  for (const group of groups) {
    const key = group.member.userId;
    if (!canSendFollowup(lastSent, key, now)) {
      result.debounced += 1;
      continue;
    }
    result.techniciansDue += 1;
    const message = renderFollowupMessage(group, APP_URL);
    result.preview.push({
      userId: key,
      name: group.member.displayName ?? "Team member",
      email: group.member.email,
      itemCount: message.itemCount,
      subject: message.subject,
      text: message.text,
    });

    if (!apply) continue;

    const name = group.member.displayName ?? "A technician";
    await writeInAppNotification(store, {
      title: `${name}: ${message.subject}`,
      body: `${message.shownCount} of ${message.itemCount} document(s) listed — open the Inbox to fix them.`,
      link: message.link,
    });
    result.messagesSent += 1;

    if (settings.email && process.env.RESEND_API_KEY && group.member.email) {
      const sendResult = await sendEmail({ to: [group.member.email], subject: message.subject, text: message.text, html: message.html });
      if (sendResult.sent) result.emailsSent += 1;
    }

    nextLastSent = recordFollowupSent(nextLastSent, key, new Date(now).toISOString());
  }

  if (apply && nextLastSent !== lastSent) await saveLastSentMap(store, nextLastSent);
  return result;
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
  const op = typeof body.op === "string" ? body.op : "settings";
  const emailAvailable = Boolean(process.env.RESEND_API_KEY);

  try {
    if (op === "settings") {
      const settings = await withTenant(ctx, async (store) => shapeFollowupSettings((await getTenantRow(store))?.settings?.followups));
      return handleCors(res, req).status(200).json({ ...settings, emailAvailable });
    }

    if (op === "saveSettings") {
      if (hasShop(auth)) requireRole(auth, "admin");
      const patch = body.settings && typeof body.settings === "object" ? body.settings : {};
      const settings = await withTenant(ctx, (store) => saveFollowupSettings(store, patch));
      return handleCors(res, req).status(200).json({ ...settings, emailAvailable });
    }

    if (op === "run") {
      if (hasShop(auth)) requireRole(auth, "admin");
      const apply = body.apply === true;
      const result = await withTenant(ctx, async (store) => {
        const settings = shapeFollowupSettings((await getTenantRow(store))?.settings?.followups);
        return runFollowupsForTenant({ store, orgId: auth.orgId ?? null, settings, apply });
      });
      return handleCors(res, req).status(200).json({ ...result, dryRun: !apply });
    }

    return handleCors(res, req).status(400).json({ error: "op must be one of: settings, saveSettings, run" });
  } catch (error) {
    if (error instanceof AuthError) return handleCors(res, req).status(error.status).json({ error: error.message });
    return handleError(res, error, req);
  }
}

/**
 * Nightly cron entry point (api/_lib/routes/cron-sweep.js). Reuses
 * list_notification_eligible_tenants() (M3-config/16-notifications.sql) for
 * cross-tenant listing rather than adding a new SQL function — it already
 * returns exactly what's needed (tenant id/key/name + settings jsonb,
 * active/trialing shop tenants only) and nothing here writes through it, so
 * a second, near-identical SECURITY DEFINER function would just be one more
 * thing to keep in sync with the first.
 */
export async function runFollowupsSweep({ deadlineAt, maxTenants = 8, perTenantMs = 3000 } = {}) {
  const pool = getPool();
  const summary = { tenantsChecked: 0, tenantsEnabled: 0, messagesSent: 0, emailsSent: 0, errors: [] };

  let tenants = [];
  try {
    const { rows } = await pool.query("SELECT * FROM list_notification_eligible_tenants()");
    tenants = rows;
  } catch (err) {
    if (err?.code === "42P01") return summary; // migration not applied yet — nothing to do, not an error
    summary.errors.push({ phase: "list-tenants", message: err?.message });
    return summary;
  }

  const effectiveDeadline = deadlineAt ?? Date.now() + 45_000;
  const { skipped } = await sweepWithDeadline(tenants.slice(0, maxTenants), {
    deadlineAt: effectiveDeadline,
    perTenantMs,
    processTenant: async (tenant) => {
      summary.tenantsChecked += 1;
      const settings = shapeFollowupSettings(tenant.settings?.followups);
      if (!settings.enabled) return;
      summary.tenantsEnabled += 1;
      try {
        const result = await withTimeout(
          withTenant({ tenantKey: tenant.tenant_key, tenantName: tenant.tenant_name ?? tenant.tenant_key }, (store) =>
            runFollowupsForTenant({ store, orgId: tenant.tenant_key, settings, apply: true })
          ),
          perTenantMs
        );
        summary.messagesSent += result?.messagesSent ?? 0;
        summary.emailsSent += result?.emailsSent ?? 0;
      } catch (err) {
        summary.errors.push({ tenant: tenant.tenant_key, message: err?.message });
      }
    },
  });
  summary.skipped = skipped.length;
  return summary;
}
