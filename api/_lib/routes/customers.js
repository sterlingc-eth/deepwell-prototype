import { handleCors, handleError } from "../claude.js";
import { denyAuth } from "../auth.js";
import { requireAuthOrKey, assertScope } from "../apiKeyAuth.js";
import { limit as rateLimit } from "../rateLimit.js";
import { withTenant, normalizeMatchText } from "../recordsStore.js";
import { alertTier, daysBetween, isPlausibleToday } from "../warrantyRules.js";
import { findDuplicateCustomerPairs } from "../integrity.js";

/**
 * GET /api/v1/customers?q=&sort=name|recent|docs&limit=200
 * GET /api/v1/customer?id=<uuid>|number=C-00012
 *
 * See handoffs/CUSTOMER_PROFILES_BRIEF_2026-09-20.md sections A-D for the
 * full contract this file implements. Same auth/rate-limit shape as every
 * other v1 read route (v1-equipment.js, v1-warranty.js): Clerk session OR an
 * API key with the 'read' scope, rate-limited on the 'read' bucket,
 * tenant-scoped throughout via recordsStore.js's withTenant/RLS.
 */

export class CustomerLookupError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "CustomerLookupError";
    this.status = status;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CUSTOMER_NUMBER_RE = /^C-\d{5}$/;

/* ---------------------------------------------------------------- pure --
 * Everything below is pure (no db, no I/O) so it's directly testable from
 * scripts/verify-customers.mjs with no database — see that file.
 */

/** 'C-00001' style formatting, mirroring next_customer_number()'s SQL
 *  (M3-config/15-customer-profiles.sql) so the JS side of any display logic
 *  agrees with what the database actually assigns. */
export function formatCustomerNumber(n) {
  const i = Math.trunc(Number(n));
  if (!Number.isFinite(i) || i < 1) return null;
  return `C-${String(i).padStart(5, "0")}`;
}

/** The next number a tenant with these EXISTING customer_number values would
 *  get — the same MAX(suffix)+1 rule next_customer_number() runs in SQL,
 *  pinned here as a plain function so that rule can be checked without a
 *  database. Ignores anything not shaped like 'C-\d+'. */
export function nextNumberFromExisting(existingNumbers) {
  let max = 0;
  for (const n of existingNumbers ?? []) {
    const m = typeof n === "string" && n.match(/^C-(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return formatCustomerNumber(max + 1);
}

export function isValidCustomerNumber(s) {
  return typeof s === "string" && CUSTOMER_NUMBER_RE.test(s);
}

/** Priority order when the same document reaches a customer through more
 *  than one path (see recordsStore.js's listCustomerDocumentLinks/
 *  listNameMatchedDocuments doc comments) — a document explicitly linked to
 *  the customer, or to their equipment, is a stronger claim than a bare
 *  name+address text match, so a document present via BOTH must show the
 *  stronger one. */
const VIA_PRIORITY = { direct: 3, equipment: 2, "name-match": 1 };

/**
 * Collapse [{documentId, via, serial?}, ...] — possibly the SAME documentId
 * more than once, from different paths — to one entry per documentId,
 * keeping the highest-priority `via` (and its serial, if the winning via is
 * 'equipment'). Order of the input is irrelevant; ties (same via twice) keep
 * the first occurrence's serial.
 */
export function mergeDocumentVia(entries) {
  const best = new Map();
  for (const e of entries ?? []) {
    if (!e || typeof e.documentId !== "string") continue;
    const prev = best.get(e.documentId);
    const pri = VIA_PRIORITY[e.via] ?? 0;
    if (!prev || pri > prev.pri) best.set(e.documentId, { via: e.via, serial: e.serial ?? null, pri });
  }
  return [...best.entries()].map(([documentId, v]) => ({ documentId, via: v.via, serial: v.serial }));
}

/** `via` string for a document, in the exact shape the API contract wants:
 *  'direct' | 'equipment:<serial>' | 'name-match'. A missing/blank serial on
 *  an 'equipment' via falls back to the bare word rather than emitting
 *  "equipment:" with nothing after the colon. */
export function formatVia(via, serial) {
  if (via === "equipment") return serial ? `equipment:${serial}` : "equipment";
  return via ?? "name-match";
}

/**
 * Duplicate-candidate rule: does `other` look like the same person as
 * `name`/`address` (both already normalizeMatchText'd)? Same-name OR
 * same-address, case-insensitively — the exact widen-not-narrow rule the
 * brief asks for ("duplicates ... other customers with same normalized name
 * OR same normalized address"). Returns the reason string, or null.
 */
export function duplicateReason(name, address, otherName, otherAddress) {
  const sameName = !!name && !!otherName && name.toLowerCase() === otherName.toLowerCase();
  const sameAddress = !!address && !!otherAddress && address.toLowerCase() === otherAddress.toLowerCase();
  if (sameName && sameAddress) return "same name and address";
  if (sameName) return "same name";
  if (sameAddress) return "same address";
  return null;
}

/** Best-effort city out of a free-text service address ("123 Main St,
 *  Phoenix, AZ 85001" -> "Phoenix"). There is no separate city field on the
 *  backend (service_address is one extracted string) so this is a display
 *  convenience, not a fact with a citation — returns null rather than
 *  guessing when the address doesn't look comma-separated. */
export function deriveCity(address) {
  const parts = String(address ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  // Owner bugs (2026-09-20): "880 S Dobson Rd, Suite 110, Chandler, AZ 85224"
  // returned "Suite 110"; "12 Main St, Apt 4B, Tempe AZ 85281" (no comma
  // before the state) returned nothing at all. Skip unit/suite/floor segments
  // and street lines outright; for everything else, strip a TRAILING state
  // (+ zip) off the segment rather than discarding the whole segment, so a
  // city glued to its state with no comma ("Tempe AZ 85281") still yields
  // "Tempe" instead of being thrown out as if it were state+zip alone.
  const UNIT_RE = /^(suite|ste\.?|unit|apt\.?|apartment|bldg\.?|building|floor|fl\.?|#|room|rm\.?|lot|space|spc\.?)\b/i;
  const STREET_RE = /^\d+\s/;
  const TRAILING_STATE_ZIP_RE = /\s*,?\s*[A-Z]{2}\s*\d{5}(?:-\d{4})?$/;
  const TRAILING_STATE_RE = /\s*,?\s*[A-Z]{2}$/;
  const candidates = [];
  for (const raw of parts.slice(1)) {
    if (UNIT_RE.test(raw) || STREET_RE.test(raw)) continue;
    const stripped = raw.replace(TRAILING_STATE_ZIP_RE, "").replace(TRAILING_STATE_RE, "").trim();
    if (!stripped || /\d/.test(stripped)) continue; // nothing left (state/zip only), or still has digits
    candidates.push(stripped);
  }
  if (!candidates.length) return null;
  return candidates[candidates.length - 1] || null;
}

/** Per-tier alert breakdown across a customer's units — {expiring, expired}.
 *  `warranties` is the raw jsonb array recordsStore.js's listCustomersSummary
 *  returns (each entry is one unit's data->'warranty', or null for a unit
 *  with none on file). 'expiring' folds alertTier()'s 'expiring-30' AND
 *  'expiring-90' together: those tiers are mutually exclusive buckets of the
 *  same "coming due soon" fact (a unit expiring in 9 days is at least as
 *  urgent as one expiring in 80 — excluding the more urgent tier, as an
 *  earlier version of this file did, made "Expiring soon" miss exactly the
 *  units that most needed it). 'expiring-365'/'ok'/'unknown'/
 *  'unregistered-window-closing' are not alerts here; the last is its own
 *  separate signal surfaced via /api/warranty-attention, not this badge. */
export function tallyWarrantyAlerts(warranties, today) {
  let expiring = 0;
  let expired = 0;
  for (const w of warranties ?? []) {
    if (!w) continue;
    const tier = alertTier(w, today);
    if (tier === "expired") expired++;
    else if (tier === "expiring-30" || tier === "expiring-90") expiring++;
  }
  return { expiring, expired };
}

/** Combined count, for the table's single-number badge column. */
export function countWarrantyAlerts(warranties, today) {
  const { expiring, expired } = tallyWarrantyAlerts(warranties, today);
  return expiring + expired;
}

const clampLimit = (v, fallback, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.trunc(n), max) : fallback;
};

/* ------------------------------------------------------------- handlers -- */

async function requireRead(req) {
  const auth = await requireAuthOrKey(req);
  assertScope(auth, "read");
  return auth;
}

/** GET /api/v1/customers */
export async function customers(req, res) {
  if (req.method === "OPTIONS") return handleCors(res, req).status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  let auth;
  try {
    auth = await requireRead(req);
  } catch (err) {
    return denyAuth(res, err);
  }
  if (!(await rateLimit(req, res, auth, "read"))) return;

  try {
    const query = req.query ?? {};
    const q = typeof query.q === "string" && query.q.trim() ? query.q.trim() : null;
    const sort = ["name", "recent", "docs"].includes(query.sort) ? query.sort : "recent";
    const lim = clampLimit(query.limit, 200, 200);
    const today = new Date().toISOString().slice(0, 10);

    const rows = await withTenant(
      { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId },
      (db) => db.listCustomersSummary({ like: q ? `%${q}%` : null, sort, limit: lim })
    );

    const data = rows.map((r) => ({
      id: r.id,
      customerNumber: r.customer_number,
      name: r.data?.customer_name ?? null,
      serviceAddress: r.data?.service_address ?? null,
      city: deriveCity(r.data?.service_address),
      phone: r.data?.phone ?? null,
      email: r.data?.email ?? null,
      documentCount: r.doc_count,
      equipmentCount: r.equipment_count,
      lastActivity: r.last_activity ? new Date(r.last_activity).toISOString() : null,
      alerts: tallyWarrantyAlerts(r.warranties, today),
      warrantyAlerts: countWarrantyAlerts(r.warranties, today),
      mergedInto: null,
    }));

    // Duplicate suggestions (handoffs/DATA_INTEGRITY_2026-09-20.md bug A /
    // section D, tightened by the 2026-09-20 "strict rules" follow-up) among
    // exactly the customers this call returned — same set the screen is
    // showing, so a scoped/filtered view surfaces only its own duplicates.
    // phone/email feed evaluateCustomerMatch's hard-veto + auto-tier contact
    // check. Response shape was a bare array; now an object with the array
    // nested under `customers` plus this new field, kept backward-compatible
    // in name only (frontend reads `.customers` going forward — see the
    // handoff).
    const duplicates = findDuplicateCustomerPairs(
      rows.map((r) => ({
        id: r.id, customerNumber: r.customer_number, name: r.data?.customer_name,
        address: r.data?.service_address, phone: r.data?.phone, email: r.data?.email,
      }))
    );

    return handleCors(res, req).status(200).json({ customers: data, duplicates });
  } catch (error) {
    return handleError(res, error, req);
  }
}

/** GET /api/v1/customer?id=<uuid>|number=C-00012 */
export async function customer(req, res) {
  if (req.method === "OPTIONS") return handleCors(res, req).status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  let auth;
  try {
    auth = await requireRead(req);
  } catch (err) {
    return denyAuth(res, err);
  }
  if (!(await rateLimit(req, res, auth, "read"))) return;

  const query = req.query ?? {};
  const id = typeof query.id === "string" && UUID_RE.test(query.id) ? query.id : null;
  const number = typeof query.number === "string" && isValidCustomerNumber(query.number) ? query.number : null;
  if (!id && !number) {
    return handleCors(res, req).status(400).json({ error: "Provide either ?id= (uuid) or ?number= (C-00012)" });
  }

  try {
    const today = isPlausibleToday(query.today) ? query.today : new Date().toISOString().slice(0, 10);

    const result = await withTenant(
      { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId },
      async (db) => {
        const row = await db.getCustomerByIdOrNumber({ id, number });
        if (!row || row.merged_into) return null;

        const name = normalizeMatchText(row.data?.customer_name);
        const address = normalizeMatchText(row.data?.service_address);

        const [equipmentRows, linkRows, nameMatchRows, duplicateRows] = await Promise.all([
          db.listCustomerEquipment(row.id),
          db.listCustomerDocumentLinks(row.id),
          db.listNameMatchedDocuments(name, address),
          db.listDuplicateCustomers(row.id, name, address),
        ]);

        const via = mergeDocumentVia([
          ...linkRows.map((r) => ({ documentId: r.document_id, via: r.via, serial: r.serial })),
          ...nameMatchRows.map((r) => ({ documentId: r.document_id, via: r.via, serial: r.serial })),
        ]);
        const documentDetails = await db.listDocumentDetails(via.map((v) => v.documentId));

        return { row, equipmentRows, via, documentDetails, duplicateRows, name, address };
      }
    );

    if (!result) throw new CustomerLookupError("Customer not found", 404);
    const { row, equipmentRows, via, documentDetails, duplicateRows } = result;

    const equipment = equipmentRows.map((u) => {
      const w = u.warranty ?? {};
      const daysLeft = w.expires ? daysBetween(today, w.expires) : null;
      return {
        id: u.id,
        serial: u.serial_number ?? null,
        model: u.model ?? null,
        manufacturer: u.manufacturer ?? null,
        installDate: u.installation_date ?? null,
        warranty: { tier: alertTier(w, today), expires: w.expires ?? null, daysLeft },
      };
    });

    const detailById = new Map(documentDetails.map((d) => [d.id, d]));
    const documents = via
      .map((v) => {
        const d = detailById.get(v.documentId);
        if (!d) return null;
        return {
          id: d.id,
          filename: d.original_filename,
          type: d.document_type,
          stage: d.stage,
          verifiedBy: d.verified_by,
          createdAt: d.created_at ? new Date(d.created_at).toISOString() : null,
          serviceDate: d.service_date ?? null,
          via: formatVia(v.via, v.serial),
        };
      })
      .filter(Boolean);

    // Timeline: one entry per document (kind inferred from its type) plus one
    // per unit's install date and warranty expiry — the "service/install/
    // invoice/warranty/document" event kinds the brief asks for. Most recent
    // first, so the profile screen's default view is "what happened lately".
    const timeline = [];
    for (const d of documents) {
      const kind = d.type === "invoice" ? "invoice"
        : d.type === "warranty-registration" ? "warranty"
        : d.type === "startup-sheet" ? "install"
        : d.type === "service-ticket" || d.type === "work-order" ? "service"
        : "document";
      const date = d.serviceDate ?? d.createdAt;
      if (date) timeline.push({ date, kind, title: d.filename ?? d.type ?? "Document", documentId: d.id });
    }
    for (const u of equipment) {
      if (u.installDate) timeline.push({ date: u.installDate, kind: "install", title: `${u.model ?? "Unit"} installed`, documentId: null });
      if (u.warranty.expires) timeline.push({ date: u.warranty.expires, kind: "warranty", title: `${u.model ?? "Unit"} warranty expires`, documentId: null });
    }
    timeline.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

    const duplicates = duplicateRows
      .map((r) => {
        const reason = duplicateReason(
          result.name, result.address,
          normalizeMatchText(r.data?.customer_name), normalizeMatchText(r.data?.service_address)
        );
        if (!reason) return null;
        return { id: r.id, customerNumber: r.customer_number, name: r.data?.customer_name ?? null, serviceAddress: r.data?.service_address ?? null, reason };
      })
      .filter(Boolean);

    return handleCors(res, req).status(200).json({
      customer: {
        id: row.id,
        customerNumber: row.customer_number,
        name: row.data?.customer_name ?? null,
        serviceAddress: row.data?.service_address ?? null,
        phone: row.data?.phone ?? null,
        email: row.data?.email ?? null,
        notes: row.data?.notes ?? null,
        billingAddress: row.data?.billing_address ?? null,
        formerNumbers: row.data?.former_numbers ?? [],
      },
      equipment,
      documents,
      timeline,
      duplicates,
    });
  } catch (error) {
    if (error?.name === "CustomerLookupError") {
      return handleCors(res, req).status(error.status).json({ error: error.message });
    }
    return handleError(res, error, req);
  }
}
