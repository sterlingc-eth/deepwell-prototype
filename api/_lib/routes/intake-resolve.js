/**
 * POST /api/account?action=intake — the clean exception queue's write side (Round 13, H2).
 *
 * Every question in the queue (api/_lib/intake/queue.js#listIntakeQueue) is already precise: a
 * plain-language `question` plus `candidates` that are either sourced VALUES (a genuine field
 * conflict — pick which document had it right) or ENTITY picks (which existing unit/customer this
 * document is actually about). Resolving one is therefore never a generic "set this column" write
 * — it's the SAME real action a person takes on the Review screen for the same fact (a field
 * correction, a document link, a customer assignment), just reached from a precomputed question
 * instead of a blank form. So this route does not reimplement those writes: it calls straight into
 * reviewStore.js's own correctField / linkDocument / assignDocumentCustomer / createCustomer —
 * same audit log entries, same forward-only stage rules, same everything — and only adds the two
 * things reviewStore.js doesn't know about: closing the intake_needs_info row, and re-running the
 * autofill/auto-verify/naming/graph cascade (api/_lib/intake/autofill.js#completeIntake) so a
 * resolved question can retroactively verify this document AND any sibling it was blocking
 * (autofill.js's own reexamineSiblingNeedsInfo — see its doc comment).
 *
 *   { op: 'resolve', documentId, fieldKey, value?, entityId?, by? }
 *     fieldKey === 'equipment_unit' -> entityId required (which unit this document is about)
 *     fieldKey === 'customer_name'  -> entityId (pick a candidate) OR value (create a new
 *                                      customer with that name) — exactly the two affordances
 *                                      ReviewScreen's LinkedCustomerSection already offers
 *     anything else                 -> value required (the field's corrected value)
 *   { op: 'dismiss', documentId, fieldKey, by? }   — "doesn't apply", permanent (never re-raised
 *                                                     by a sibling's own arrival; see autofill.js)
 *   { op: 'snooze',  documentId, fieldKey, minutes?, by? }  — ask again later; stays 'open'
 *                                                              underneath (M3-config/45)
 *
 * No admin gate: same bar as api/_lib/routes/naming.js's `rename` op and every reviewStore.js
 * action this delegates to — a field tech resolving a question about a document they can already
 * see is not an admin action. `by` is a client-supplied display label (reviewStore.js's own
 * documented convention — "You", a technician's name), not a trust boundary; the audit log's real
 * actor is `auth.userId`, verified from the token, same as every reviewStore.js call site.
 */
import { requireAuth, denyAuth, AuthError } from "../auth.js";
import { handleCors, handleError } from "../claude.js";
import { limit as rateLimit } from "../rateLimit.js";
import { withTenant } from "../recordsStore.js";
import { correctField, linkDocument, assignDocumentCustomer, createCustomer, ReviewError } from "../reviewStore.js";
import { completeIntake, markNeedsInfoResolved, dismissNeedsInfo, snoozeNeedsInfo } from "../intake/autofill.js";

export const config = { api: { bodyParser: { sizeLimit: "16kb" } }, maxDuration: 60 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === "string" && UUID_RE.test(v);
const isNonEmptyString = (v) => typeof v === "string" && v.trim() !== "";
const MAX_VALUE_LENGTH = 500;
const DEFAULT_SNOOZE_MINUTES = 24 * 60; // "later today" reads as tomorrow for most field crews — a full day, not an hour.
const MAX_SNOOZE_MINUTES = 30 * 24 * 60;

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
  const ok = (data) => handleCors(res, req).status(200).json(data);

  const documentId = body.documentId;
  const fieldKey = body.fieldKey;
  const by = isNonEmptyString(body.by) ? body.by.trim().slice(0, 80) : "Teammate";

  try {
    if (!isUuid(documentId)) return res.status(400).json({ error: "documentId must be a uuid" });
    if (!isNonEmptyString(fieldKey)) return res.status(400).json({ error: "fieldKey is required" });

    if (op === "resolve") {
      let resolvedLabel;

      if (fieldKey === "equipment_unit") {
        if (!isUuid(body.entityId)) return res.status(400).json({ error: "entityId (which unit) is required for equipment_unit" });
        await linkDocument(ctx, { documentId, entityId: body.entityId, by }, auth.userId);
        resolvedLabel = isNonEmptyString(body.value) ? body.value.trim() : body.entityId;
      } else if (fieldKey === "customer_name") {
        if (isUuid(body.entityId)) {
          await assignDocumentCustomer(ctx, { documentId, customerId: body.entityId }, auth.userId);
          resolvedLabel = isNonEmptyString(body.value) ? body.value.trim() : body.entityId;
        } else if (isNonEmptyString(body.value)) {
          const name = body.value.trim().slice(0, MAX_VALUE_LENGTH);
          const { customer } = await createCustomer(ctx, { name }, auth.userId);
          await assignDocumentCustomer(ctx, { documentId, customerId: customer.id }, auth.userId);
          resolvedLabel = name;
        } else {
          return res.status(400).json({ error: "customer_name needs either entityId (pick a candidate) or value (a new customer's name)" });
        }
      } else {
        if (!isNonEmptyString(body.value)) return res.status(400).json({ error: "value is required" });
        const value = body.value.trim().slice(0, MAX_VALUE_LENGTH);
        await correctField(ctx, { documentId, fieldKey, value, by }, auth.userId);
        resolvedLabel = value;
      }

      await withTenant(ctx, (db) => markNeedsInfoResolved(db, { documentId, fieldKey, value: resolvedLabel, resolvedBy: `human:${by}` }));
      // The cascade the contract asks for: re-run autofill (which also reexamines this document's
      // OWN siblings' open questions — see autofill.js), re-verify, re-name, refresh the graph.
      const autofill = await completeIntake(ctx, documentId, {});
      return ok({ ok: true, resolvedValue: resolvedLabel, autofill });
    }

    if (op === "dismiss") {
      const dismissed = await withTenant(ctx, (db) => dismissNeedsInfo(db, { documentId, fieldKey, resolvedBy: `human:${by}` }));
      return ok({ ok: true, dismissed });
    }

    if (op === "snooze") {
      const minutesRaw = Number(body.minutes);
      const minutes = Number.isFinite(minutesRaw) && minutesRaw > 0 ? Math.min(minutesRaw, MAX_SNOOZE_MINUTES) : DEFAULT_SNOOZE_MINUTES;
      const until = new Date(Date.now() + minutes * 60_000).toISOString();
      const snoozed = await withTenant(ctx, (db) => snoozeNeedsInfo(db, { documentId, fieldKey, until }));
      return ok({ ok: true, snoozed, until: snoozed ? until : null });
    }

    return res.status(400).json({ error: "op must be one of: resolve, dismiss, snooze" });
  } catch (error) {
    if (error instanceof AuthError) return handleCors(res, req).status(error.status).json({ error: error.message });
    if (error instanceof ReviewError) return handleCors(res, req).status(error.status).json({ error: error.message, ...(error.details ? { details: error.details } : {}) });
    return handleError(res, error, req);
  }
}
