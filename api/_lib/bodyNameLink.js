/**
 * Link a document to a customer named in its BODY - deterministic, no model, no cost.
 *
 * Owner-reported defect (2026-09-23): an internal memo / piece of correspondence such as "Reminder logged for
 * David Prentiss's account: confirm filter size on next visit" showed "Missing required field: Customer" and
 * "Not linked to any record", because extraction only sets customer_name from a printed field and the
 * memo's body never had one.
 *
 * For a document with NO customer link, scan its page text for the FULL name (first + last, or a business
 * name of 2+ words) or the street address of the tenant's EXISTING customers, with strict rules (owner rule:
 * near-misses go to review, never auto):
 *
 *   exactly one distinct customer matches (by full name and/or address)     -> LINK it: fills the missing
 *       customer_name extraction and writes a document_entity_links row with linked_by = 'name-in-body'
 *       (the UI shows "Linked from name in document - confirm"; it is non-blocking, and nothing else in the
 *       integrity code ever re-points a 'name-in-body' link automatically);
 *   two or more customers match (a repeated full name, a name and an address that disagree)  -> 'ambiguous':
 *       NEVER auto - reported as "Needs your review" with the candidates;
 *   no full-name/address match but a capitalized surname of exactly one/several customers appears -> 'partial':
 *       NEVER auto - reported as "Needs your review".
 *
 * Only ever matches the calling tenant's own customers (every read runs through withTenant + RLS). Never
 * creates a customer. A document a person explicitly unlinked (review.document_unlinked) is left alone.
 * Runs at ingest (extractDocument.js, after extraction) and as the `linkBodyNames` integrity fix
 * (the "Fix everything" button and the nightly sweep).
 */
import { withTenant, linkDocumentToCustomer } from "./recordsStore.js";

export const BODY_NAME_LINKED_BY = "name-in-body";
const CUSTOMER_CAP = 5000;
const DOC_BATCH = 200;
const MIN_SURNAME_LEN = 4;

const TENANT = "(current_setting('app.tenant_id', true))::uuid";

/* ------------------------------------------------------------------ pure matching */

/** Lowercase alnum tokens; possessives dropped ("Prentiss's" -> "prentiss"), punctuation to spaces. */
export function nameTokens(s) {
  return String(s ?? "")
    .replace(/[’']s\b/gi, "")
    .toLowerCase()
    .replace(/[^a-z0-9À-ɏ]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

const norm = (s) => nameTokens(s).join(" ");
const contains = (hay, needle) => needle.length > 0 && ` ${hay} `.includes(` ${needle} `);

/** "Customer at 412 Elm St" style placeholders carry no real name. */
const isPlaceholderName = (c) => c.nameSource === "address" || /^customer at\b/i.test(c.name ?? "");

/** The house-number + street part of an address ("412 Elm St, Mesa, AZ 85201" -> "412 elm st"), or "" if none. */
export function streetOf(address) {
  const first = String(address ?? "").split(",")[0];
  const t = nameTokens(first);
  return t.length >= 3 && /^\d/.test(t[0]) ? t.join(" ") : "";
}

/**
 * Pure: which customers does `text` name? Returns
 * {status: 'unique'|'ambiguous'|'partial'|'none', matches: [{customerId, name, basis}], candidates: [{customerId, name}], page?}
 * `pages` is [{page_no, text}]; the first page with a match is reported.
 * @param {{page_no: number, text: string}[]} pages
 * @param {{id: string, name: string, address?: string, nameSource?: string}[]} customers
 */
export function findCustomersInBody(pages, customers) {
  const named = customers.filter((c) => !isPlaceholderName(c)).map((c) => ({ c, tokens: nameTokens(c.name) })).filter((x) => x.tokens.length >= 2);
  const fullNames = named.map((x) => ({ id: x.c.id, name: x.c.name, key: x.tokens.join(" ") }));
  const streets = customers.map((c) => ({ id: c.id, name: c.name, key: streetOf(c.address) })).filter((x) => x.key);

  const found = new Map(); // id -> {customerId, name, basis, page}
  for (const p of pages) {
    const hay = norm(p.text);
    if (!hay) continue;
    for (const f of fullNames) {
      if (contains(hay, f.key) && !found.has(f.id)) found.set(f.id, { customerId: f.id, name: f.name, basis: "full-name", page: p.page_no });
    }
    for (const s of streets) {
      if (contains(hay, s.key)) {
        const prev = found.get(s.id);
        if (!prev) found.set(s.id, { customerId: s.id, name: s.name, basis: "address", page: p.page_no });
        else if (prev.basis === "full-name") prev.basis = "full-name+address";
      }
    }
  }
  // A shorter full name contained in a longer one ("Ann Lee" inside "Mary Ann Lee") would otherwise count twice for the
  // same person; only collapse when both names belong to the SAME customer id (already keyed by id above).
  const matches = [...found.values()];
  if (matches.length === 1) return { status: "unique", matches, candidates: matches.map(({ customerId, name }) => ({ customerId, name })), page: matches[0].page };
  if (matches.length > 1) return { status: "ambiguous", matches, candidates: matches.map(({ customerId, name }) => ({ customerId, name })), page: matches[0].page };

  // Partial: a capitalized surname of a real customer appears on its own. Never auto.
  const partial = new Map();
  for (const p of pages) {
    const words = new Set((String(p.text ?? "").replace(/[’']s\b/g, "").match(/\b[A-Z][a-z]{3,}\b/g) ?? []).map((w) => w.toLowerCase()));
    if (!words.size) continue;
    for (const x of named) {
      const surname = x.tokens[x.tokens.length - 1];
      if (surname.length >= MIN_SURNAME_LEN && words.has(surname) && !partial.has(x.c.id)) partial.set(x.c.id, { customerId: x.c.id, name: x.c.name, page: p.page_no });
    }
  }
  if (partial.size) {
    const candidates = [...partial.values()];
    return { status: "partial", matches: [], candidates: candidates.map(({ customerId, name }) => ({ customerId, name })), page: candidates[0].page };
  }
  return { status: "none", matches: [], candidates: [] };
}

/* ------------------------------------------------------------------ data access */

async function loadCustomers(db) {
  const { rows } = await db.raw(
    `SELECT id, data->>'customer_name' AS name, data->>'service_address' AS address, data->>'name_source' AS name_source
       FROM entities
      WHERE entity_type = 'customer' AND merged_into IS NULL AND tenant_id = ${TENANT}
      ORDER BY created_at LIMIT ${CUSTOMER_CAP}`, []);
  return rows.filter((r) => r.name || r.address).map((r) => ({ id: r.id, name: r.name ?? "", address: r.address ?? "", nameSource: r.name_source ?? null }));
}

/** Documents with no customer link, page text present, never explicitly unlinked by a person. */
async function loadDocuments(db, documentId) {
  const { rows } = await db.raw(
    `SELECT d.id AS document_id
       FROM documents d
      WHERE d.tenant_id = ${TENANT} AND ($1::uuid IS NULL OR d.id = $1)
        AND NOT EXISTS (SELECT 1 FROM document_entity_links l JOIN entities e ON e.id = l.entity_id
                         WHERE l.document_id = d.id AND e.entity_type = 'customer' AND e.merged_into IS NULL AND l.tenant_id = ${TENANT})
        AND EXISTS (SELECT 1 FROM document_pages p WHERE p.document_id = d.id AND p.tenant_id = ${TENANT} AND length(p.text) > 0)
        AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.resource_id = d.id AND a.action = 'review.document_unlinked' AND a.tenant_id = ${TENANT})
      ORDER BY d.created_at DESC LIMIT ${DOC_BATCH}`, [documentId ?? null]);
  return rows.map((r) => r.document_id);
}

async function loadPages(db, documentIds) {
  if (!documentIds.length) return new Map();
  const { rows } = await db.raw(
    `SELECT document_id, page_no, text FROM document_pages
      WHERE tenant_id = ${TENANT} AND document_id = ANY($1::uuid[]) ORDER BY document_id, page_no`, [documentIds]);
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.document_id)) by.set(r.document_id, []);
    by.get(r.document_id).push({ page_no: r.page_no, text: r.text ?? "" });
  }
  return by;
}

/**
 * Plan (and, unless dryRun, apply) body-name links inside ONE tenant transaction.
 * @returns {Promise<{linked: {documentId, customerId, name, basis, page}[], review: {documentId, kind: 'ambiguous'|'partial', candidates: {customerId, name}[]}[]}>}
 */
export async function planBodyNameLinks(db, { documentId = null, dryRun = false } = {}) {
  const out = { linked: [], review: [] };
  const docIds = await loadDocuments(db, documentId);
  if (!docIds.length) return out;
  const [customers, pagesByDoc] = await Promise.all([loadCustomers(db), loadPages(db, docIds)]);
  if (!customers.length) return out;

  for (const id of docIds) {
    const verdict = findCustomersInBody(pagesByDoc.get(id) ?? [], customers);
    if (verdict.status === "none") continue;
    if (verdict.status !== "unique") {
      out.review.push({ documentId: id, kind: verdict.status, candidates: verdict.candidates.slice(0, 5) });
      continue;
    }
    const m = verdict.matches[0];
    if (dryRun) { out.linked.push({ documentId: id, customerId: m.customerId, name: m.name, basis: m.basis, page: m.page }); continue; }

    // Fill the missing customer_name (only when the document has none), so "Missing required field: Customer" clears.
    const has = await db.raw(`SELECT 1 FROM extractions WHERE document_id = $1 AND field_key = 'customer_name' AND tenant_id = ${TENANT} LIMIT 1`, [id]);
    if (!has.rows.length) {
      const facet = await db.createFacet({
        document_id: id, page_no: m.page, segment_id: "body-name-link", label_raw: "Customer named in document",
        value_raw: m.name, value_type_guess: "text", confidence: 0.6,
      });
      await db.createExtraction({ document_id: id, entity_id: null, field_key: "customer_name", value: m.name, confidence: 0.6, source_facet_id: facet?.id ?? null });
    }
    const didLink = await linkDocumentToCustomer(db, { documentId: id, customerId: m.customerId, confidence: 0.6, linkedBy: BODY_NAME_LINKED_BY });
    if (didLink) {
      await db.logAction({
        action: "integrity.link_body_name", resource_type: "document", resource_id: id,
        changes: { customer_id: m.customerId, basis: m.basis, page: m.page },
      });
      out.linked.push({ documentId: id, customerId: m.customerId, name: m.name, basis: m.basis, page: m.page });
    }
  }
  return out;
}

/**
 * Integrity-fix entry point: every unlinked document in the tenant (bounded), or one document.
 * dryRun previews (also what integrityScan reports). Never throws; an unexpected error returns empty lists.
 */
export async function applyBodyNameLinks(ctx, { documentId = null, dryRun = false } = {}) {
  try {
    return await withTenant(ctx, (db) => planBodyNameLinks(db, { documentId, dryRun }));
  } catch (err) {
    console.error("bodyNameLink: pass failed (non-fatal):", err?.message);
    return { linked: [], review: [] };
  }
}
