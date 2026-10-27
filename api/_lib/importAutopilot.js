/**
 * Bulk import autopilot (2026-10-26): a big upload becomes ONE import job (documents.batch_id), most of it is filed without a click,
 * and what is left is grouped by shared cause so a person makes a handful of decisions instead of clearing thousands of papers.
 *
 * NO DATABASE MIGRATION. It uses what is already there:
 *   - documents.batch_id (uuid) is the import job; every upload of one drop carries the same id (api/upload-url.js).
 *   - tenants.settings->'importAutopilot' holds the tenant setting {autoFileImports, autoFileSingles, pausedBatches}.
 *   - audit_log holds every action (import.auto_filed, import.decision_applied, ... ) with the run id, so each one is audited and undoable.
 *   - a set-aside duplicate is a synthetic `_set_aside` extraction row (underscore keys are never facts; nothing else reads it as one).
 *
 * WHAT IT MAY DO WITHOUT A CLICK
 *   Only one thing: FILE (stage -> verified, verified_by 'ai') a paper that passes EVERY automatic check. Those checks are the existing
 *   ones (documentTypes.js autoCheckDecision: readable, typed, complete, confident, linked or link not needed, not VOID, not a copy by name,
 *   dates and amounts confirmed) plus the import guards below (no dispute, no money to check, no stored-value flag, no look-alike of another
 *   paper, no type the page and the name disagree on, nothing parked, nothing set aside, not undone by a person).
 *   It NEVER links a paper, NEVER creates a customer, NEVER writes or changes a value and NEVER sets a paper aside.
 *
 * WHAT NEEDS A PERSON'S CLICK (one click covers a whole group; the server re-checks every paper before it applies)
 *   link-suggested   the page points at exactly one existing customer, not clearly enough to link on its own (R6 "weak" evidence)
 *   create-customer  the customer side of the page names someone who is not a customer yet (creating a customer is a person's click only)
 *   use-invoice-date a paper only lacks its service date and the invoice date is on file (written as the person's value, never over one)
 *   set-aside-copies a paper that looks like a copy of one already filed (kept on file, out of the counts)
 *   choose-type      the file name and the page name two different types for the same group
 *   file-passed      (only while "File papers automatically" is off) papers that passed every check
 * Each one: 3 sample papers, applied in chunks of 100, an audit row per paper, and an Undo that restores only what the click changed.
 *
 * Safety: R6 evidence rules (bodyNameLink.js) are reused as they are, never loosened. Money is never selected or returned by anything
 * here (document_financials is read only for its review flag and its invoice date). Every query carries the tenant predicate on top of
 * row-level security. Work is chunked: no call touches more than MAX_APPLY (100) papers to change them, or scans without a deadline.
 */
import { withTenant } from './recordsStore.js';
import * as reviewStore from './reviewStore.js';
import {
  autoCheckDecision, completenessFor, toCompletenessFields, normalizeDocumentType, linkNotRequired, inferTypeFromFilename, isLabelValue,
  isVoidMarked, isLikelyCopyName, DOCUMENT_TYPE_IDS,
} from './documentTypes.js';
import { splitPartyZones, isJunkCustomerName, isIssuerSigner, isSetAsidePaper, printedNameMatches } from './bodyNameLink.js';
import { loadOwnNames, isOwnName, nameKey } from './modelAvoidance/ownCompany.js';
import { classifyFromText } from './modelAvoidance/textExtract.js';
import { anchorTypeFromText } from './modelAvoidance/retype.js';
import { normalizeDate } from './extractFields.js';
import { REVIEW_FLAGS, REVIEW_CONFIDENCE } from './financials/normalize.js';
import { flagsVisible } from './storedAuditStore.js';
import { COMPANY_FOLDER_FIELD_KEY, HR_FOLDER_ID } from './companyFiles.js';

const T = "(current_setting('app.tenant_id', true))::uuid";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SETTINGS_KEY = 'importAutopilot';
export const DEFAULT_SETTINGS = Object.freeze({ autoFileImports: true, autoFileSingles: false });
export const SET_ASIDE_KEY = '_set_aside';
export const IMPORT_MIN_DOCS = 20; // a drop of fewer papers is not shown as an import job
export const MAX_APPLY = 100; // papers changed per call
export const MAX_FILE_PER_CALL = 200; // papers filed per call
export const MIN_GROUP = 2; // a "pattern" is at least two papers; one paper is a paper to look at
export const SAMPLE_COUNT = 3;
const SCAN_CHUNK = 400;
const CACHE_MS = 20_000;
const PROGRESS_WINDOW_MIN = 15; // same window importDone.js / recordsStore.importProgress use for "still being read"

export const ACTION = Object.freeze({
  autoFiled: 'import.auto_filed',
  autoFileUndone: 'import.auto_file_undone',
  decisionApplied: 'import.decision_applied',
  decisionUndone: 'import.decision_undone',
  customerCreated: 'import.customer_created',
  customerRemoved: 'import.customer_removed',
  settingsChanged: 'import.settings_changed',
});
const IMPORT_ACTIONS_SQL = `'${ACTION.autoFiled}','${ACTION.autoFileUndone}','${ACTION.decisionApplied}','${ACTION.decisionUndone}'`;

export class ImportError extends Error {
  constructor(message, status = 400, details = null) { super(message); this.name = 'ImportError'; this.status = status; this.details = details; }
}
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
const uuidOrNull = (v) => (isUuid(v) ? v : null);

/* =========================================================================================================== settings */

/** Pure. */
export function normalizeSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    autoFileImports: typeof s.autoFileImports === 'boolean' ? s.autoFileImports : DEFAULT_SETTINGS.autoFileImports,
    autoFileSingles: typeof s.autoFileSingles === 'boolean' ? s.autoFileSingles : DEFAULT_SETTINGS.autoFileSingles,
    pausedBatches: Array.isArray(s.pausedBatches) ? [...new Set(s.pausedBatches.filter(isUuid))].slice(-50) : [],
  };
}

async function readSettings(db) {
  const r = await db.raw(`SELECT settings->'${SETTINGS_KEY}' AS s FROM tenants WHERE id = ${T}`, []);
  return normalizeSettings(r.rows?.[0]?.s);
}
async function writeSettings(db, s) {
  await db.raw(
    `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('${SETTINGS_KEY}', $1::jsonb) WHERE id = ${T}`,
    [JSON.stringify(normalizeSettings(s))]
  );
}

export async function getImportSettings(ctx) {
  return withTenant(ctx, async (db) => readSettings(db));
}

/** Admin only (the route gates it). Audited. */
export async function setImportSettings(ctx, patch, actorClerkId = null) {
  return withTenant(ctx, async (db) => {
    const before = await readSettings(db);
    const next = { ...before };
    if (typeof patch?.autoFileImports === 'boolean') next.autoFileImports = patch.autoFileImports;
    if (typeof patch?.autoFileSingles === 'boolean') next.autoFileSingles = patch.autoFileSingles;
    await writeSettings(db, next);
    analysisCache.clear(); // the setting changes what counts as "filing" and "needs you" at once
    await db.logAction({ action: ACTION.settingsChanged, resource_type: 'tenant', resource_id: null, clerk_user_id: actorClerkId, changes: { before: { autoFileImports: before.autoFileImports, autoFileSingles: before.autoFileSingles }, after: { autoFileImports: next.autoFileImports, autoFileSingles: next.autoFileSingles } } });
    return normalizeSettings(next);
  });
}

function scopeOn(settings, scope) {
  if (scope.singles) return settings.autoFileSingles;
  return settings.autoFileImports && !settings.pausedBatches.includes(scope.batchId);
}
function parseScope(p) {
  if (p?.singles === true) return { singles: true, batchId: null, key: 'singles' };
  if (isUuid(p?.batchId)) return { singles: false, batchId: p.batchId, key: p.batchId };
  throw new ImportError('batchId is required (a uuid)', 400);
}
const scopeWhere = (scope, alias = 'd') => (scope.singles ? `${alias}.batch_id IS NULL` : `${alias}.batch_id = $SCOPE::uuid`);

/* ============================================================================================================== audit */

/** One INSERT for many rows. clock_timestamp() so rows written in one transaction still sort in the order they were written. */
async function bulkAudit(db, actorClerkId, action, rows, resourceType = 'document') {
  if (!rows.length) return;
  let userId = null;
  if (actorClerkId) {
    const u = await db.raw(`SELECT id FROM users WHERE clerk_user_id = $1 AND tenant_id = ${T}`, [actorClerkId]);
    userId = u.rows?.[0]?.id ?? null;
  }
  for (let i = 0; i < rows.length; i += 200) {
    const part = rows.slice(i, i + 200);
    await db.raw(
      `INSERT INTO audit_log (tenant_id, user_id, action, resource_type, resource_id, changes, created_at)
       SELECT ${T}, $1::uuid, $2::text, $3::text, x.rid, x.ch, clock_timestamp()
         FROM unnest($4::uuid[], $5::jsonb[]) AS x(rid, ch)`,
      [userId, action, resourceType, part.map((r) => r.resourceId), part.map((r) => JSON.stringify(r.changes ?? {}))]
    );
  }
}

/* ============================================================================================ pure rule helpers */

const DOC_NUMBER_PREFIXES = ['invoice', 'po', 'purchase_order', 'receipt', 'permit', 'document', 'order', 'ticket', 'work_order', 'estimate', 'quote', 'statement'];
/** The exact field keys that carry a document number. Matched by EXACT key (never by a pattern), like every other reader of field keys. */
const DOC_NUMBER_KEYS = DOC_NUMBER_PREFIXES.flatMap((p) => [`${p}_number`, `${p}_no`]);
const DOC_NUMBER_KEY = new RegExp(`^(?:${DOC_NUMBER_KEYS.join('|')})$`);
const DOC_NUMBER_SQL = DOC_NUMBER_KEYS.map((k) => `'${k}'`).join(',');
const COPY_SUFFIX = /(?:[\s_-]*\(\s*copy(?:\s*\d+)?\s*\)|[\s_-]+copy(?:\s*\d+)?|[\s_-]*\(\s*\d{1,2}\s*\)|[\s_-]+v\d{1,2})\s*$/i;

/** Same as src/core/entityGraph.ts copyStem (parity-tested by scripts/verify-import-autopilot.mjs). */
export function copyStem(filename) {
  let stem = String(filename ?? '').replace(/\.[A-Za-z0-9]{1,5}$/, '').trim().toLowerCase();
  let marked = false;
  for (let i = 0; i < 3; i++) {
    const next = stem.replace(COPY_SUFFIX, '').trim();
    if (next === stem || !next) break;
    stem = next;
    marked = true;
  }
  return { stem: stem.replace(/\s+/g, ' '), marked };
}

const val = (r) => {
  const c = r?.corrected_value;
  if (c != null && String(c).trim() !== '') return String(c).trim();
  const v = r?.value;
  return v != null && String(v).trim() !== '' ? String(v).trim() : '';
};
const first = (fields, test) => { for (const f of fields) if (test(f.field_key)) { const v = val(f); if (v) return v; } return ''; };
const docNumberOf = (fields) => first(fields, (k) => DOC_NUMBER_KEY.test(k)).toUpperCase().replace(/[^A-Z0-9]/g, '');
const costOf = (fields) => {
  const raw = first(fields, (k) => k === 'cost' || k === 'total');
  const n = Number(raw.replace(/[^0-9.-]/g, ''));
  return raw && Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};
const dateOf = (fields) => normalizeDate(first(fields, (k) => k === 'service_date') || first(fields, (k) => k === 'invoice_date')) || '';
// The customer named by a real customer_name fact. The vendor / issuer is NEVER the party (two customers' papers share the same vendor).
const partyOf = (fields) => first(fields, (k) => k === 'customer_name').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Pure. Which papers are copies of another paper, over plain rows {id, filename, type, stage, createdAt, number, cost, party, date, hash, customerIds}.
 * Returns Map(copyId -> originalId). A verified paper is never the copy. A copy is a paper that matches another on
 *   (a) the SAME CONTENT (a hash of the page text), or
 *   (b) ALL of: the same document type, the same document number (a different or missing number vetoes), the same date, the same amount,
 *       and the same CUSTOMER, taken from a real customer fact or a customer link. The vendor / issuer is never the party. If the customer
 *       is unknown on either side, it is not a duplicate.
 * Never across customers: two papers linked to different customers, or naming different customers, are never grouped.
 */
export function findCopies(docs) {
  const out = new Map();
  const customersApart = (a, b) => !!(a.customerIds?.length && b.customerIds?.length && !a.customerIds.some((id) => b.customerIds.includes(id)));
  const partiesApart = (a, b) => !!(a.party && b.party && a.party !== b.party);
  // A customer both papers share: an overlapping link, or (when neither is linked) the same customer_name fact. One linked + one only named is not proof.
  const sameCustomer = (a, b) => (a.customerIds?.length && b.customerIds?.length ? a.customerIds.some((id) => b.customerIds.includes(id)) : !a.customerIds?.length && !b.customerIds?.length && !!a.party && a.party === b.party);
  const order = (members) => [...members].sort((a, b) => (a.stage === 'verified' ? -1 : 0) - (b.stage === 'verified' ? -1 : 0) || a.createdAt - b.createdAt || String(a.id).localeCompare(String(b.id)));
  const run = (keyOf, needSameCustomer = false) => {
    const groups = new Map();
    for (const d of docs) { const k = keyOf(d); if (k) (groups.get(k) ?? groups.set(k, []).get(k)).push(d); }
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      const sorted = order(members);
      const original = sorted[0];
      for (const d of sorted.slice(1)) {
        if (d.stage === 'verified' || out.has(d.id) || out.has(original.id)) continue;
        if (customersApart(original, d) || partiesApart(original, d)) continue;
        if (needSameCustomer && !sameCustomer(original, d)) continue;
        out.set(d.id, original.id);
      }
    }
  };
  run((d) => (d.hash ? `h|${d.hash}` : null));
  run((d) => (d.type && d.number && d.date && d.cost !== null && (d.customerIds?.length || d.party) ? `k|${d.type}|${d.number}|${d.date}|${d.cost}|${d.customerIds?.length ? 'c:' + [...d.customerIds].sort().join(',') : 'n:' + d.party}` : null), true);
  return out;
}

const NOT_A_CUSTOMER_RE = /^(?:cash|various|same as above|same|walk[-\s]?in|customer copy|office copy|accounts? (?:payable|receivable)|attn.*|n\/?a|none)$/i;
const ADDRESSISH_RE = /^\d{1,6}\s+\S|\b(?:p\.?o\.?\s*box|suite|ste\.?|apt\.?|unit)\b\s*#?\w|,\s*[A-Z]{2}\s+\d{5}/i;
const CONTACTISH_RE = /@|https?:|www\.|\(\d{3}\)|\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/;
const MONEYISH_RE = /\$\s?\d|\b\d{1,3}(?:,\d{3})+(?:\.\d{2})?\b|\b\d+\.\d{2}\b/;

// Words that make a line a form LABEL or HEADING ("REGISTERED TO", "Submitted to", "Owner", "Bill To"), never a customer's name.
const HEADING_WORDS = new Set(['registered', 'owner', 'owners', 'to', 'bill', 'billed', 'billing', 'sold', 'ship', 'shipped', 'deliver', 'delivered', 'submitted', 'attention', 'attn',
  'customer', 'client', 'account', 'holder', 'tenant', 'purchaser', 'buyer', 'property', 'location', 'site', 'address', 'name', 'contact', 'for', 'by', 'of', 'the', 'from',
  'issued', 'prepared', 'recipient', 'payee', 'insured', 'certificate', 'policy', 'insurer', 'service', 'job', 'project', 'and', 'ship', 'remit', 'payable', 'information', 'details', 'party']);
/** A heading or label, not a name: every word is a label word, or the line is ALL CAPITALS and carries a label word. */
export function isHeadingNotName(name) {
  const words = String(name ?? '').toLowerCase().replace(/[^a-z' ]+/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  if (words.every((w) => HEADING_WORDS.has(w))) return true;
  const letters = String(name).replace(/[^A-Za-z]/g, '');
  return letters.length > 0 && letters === letters.toUpperCase() && words.some((w) => HEADING_WORDS.has(w));
}

function cleanPrintedName(raw) {
  let s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  s = s.split(/\s{2,}|\t|\|/)[0].trim();
  s = s.replace(/^[\s:;,.\-]+|[\s:;,.\-]+$/g, '');
  return s;
}

/**
 * Pure. The customer a paper names on its CUSTOMER side, for "create this customer" — or null. Same evidence the R6 linking rule uses:
 * the value of a customer label (Bill To / Customer / Sold To ...) from splitPartyZones, never the letterhead, never a name that is also in the
 * issuer's block, never our own company, a form label, an address, a signer, or a contact line. When the paper also carries a printed customer_name
 * fact, the two must agree. HR and licence papers have no customer. A name this short or this generic is not enough.
 * @returns {{name: string, key: string, line: string}|null}
 */
export function newCustomerEvidence({ type, filename = null, pages, printedName = null, ownNames = [], hrFiled = false }) {
  if (hrFiled || type === 'hr-letter' || type === 'license-certification') return null;
  const text = pages.map((p) => p.text ?? '').join('\n');
  if (isSetAsidePaper({ filename, text: pages.slice(0, 2).map((p) => p.text ?? '').join('\n') })) return null;
  const zones = splitPartyZones(pages);
  const vendorKeys = [...zones.vendor].map((v) => nameKey(v)).filter(Boolean);
  const seen = new Set();
  const found = [];
  for (const raw of zones.customerValues) {
    const name = cleanPrintedName(raw);
    if (!name || name.length < 4 || name.length > 70 || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    if (name.split(/\s+/).length > 8) continue;
    if (!/[A-Za-z]{3}/.test(name)) continue;
    if (NOT_A_CUSTOMER_RE.test(name) || isLabelValue(name) || isJunkCustomerName(name) || isHeadingNotName(name)) continue;
    if (ADDRESSISH_RE.test(name) || CONTACTISH_RE.test(name) || MONEYISH_RE.test(name)) continue;
    if (isOwnName(name, ownNames) || isIssuerSigner(name, text)) continue;
    const key = nameKey(name);
    // the issuer, vendor or letterhead is never the customer: not when the name equals a vendor-block line, nor when it sits inside one
    if (key.length < 4 || vendorKeys.some((v) => v === key || v.includes(key) || key.includes(v))) continue;
    if (printedName && !isLabelValue(printedName) && !printedNameMatches(printedName, name)) continue;
    found.push({ name, key });
  }
  if (!found.length) return null;
  // Two different customer-side names on one paper ("Submitted to the Water Authority" AND "Property / Owner: Brightwater"): the page does not say
  // which one is OUR customer, so nothing is proposed. (A shorter spelling of the same name counts as the same name.)
  const distinct = found.filter((f, i) => !found.some((g, j) => j !== i && g.key !== f.key && (g.key.startsWith(f.key + ' ') || f.key.startsWith(g.key + ' ')) && g.key.length > f.key.length));
  if (new Set(distinct.map((f) => f.key)).size > 1) return null;
  const pick = distinct[0];
  // name PLUS address: a street line sits in the customer block beside the name
  const hasAddress = zones.customer.some((l) => ADDRESSISH_RE.test(l));
  return { name: pick.name, key: pick.key, line: pick.name, hasAddress };
}

/** Pure. The evidence rule for creating a customer: the name on the customer side of at least 2 papers, or of one paper together with its address. */
export const createEvidenceEnough = (evs) => evs.length >= 2 || evs.some((e) => e.hasAddress);

/** Pure: the two types a paper could be, or null. The file name and the page must each name a (different) known type; a person's choice is never questioned. */
export function typeDisagreement({ type, filename, pages, humanTyped }) {
  if (humanTyped || !pages.length) return null;
  if (!DOCUMENT_TYPE_IDS.has(type)) return null;
  let page = null;
  try { page = anchorTypeFromText(pages)?.type ?? null; } catch { page = null; }
  if (!page) {
    try { const c = classifyFromText(pages); if (c && c.type && Number(c.confidence) >= 0.7) page = c.type; } catch { page = null; }
  }
  const byName = inferTypeFromFilename(filename);
  const b = page ?? null;
  if (!b || !DOCUMENT_TYPE_IDS.has(b) || b === type) return null;
  // The stored type A and a DIFFERENT type B read from the page (and the file name, when it says anything, does not settle it for A or B).
  if (byName && byName !== type && byName !== b) return null;
  if (type === 'other') return null; // "other" is "not typed yet": the existing re-sort / re-check decides that, not a group question
  return { a: type, b };
}

/** Pure. A valid, plausible calendar day from a stored value, or null. */
export function plausibleDay(raw, today = new Date().toISOString().slice(0, 10)) {
  const iso = normalizeDate(raw);
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  if (iso < '2000-01-01' || iso > today) return null;
  return iso;
}

/* =========================================================================================================== loading */

const FILTER_JSON = `COALESCE((SELECT jsonb_agg(jsonb_build_object('id', x.id, 'field_key', x.field_key, 'value', x.value, 'corrected_value', x.corrected_value, 'confidence', x.confidence, 'entity_id', x.entity_id))
                       FROM extractions x WHERE x.document_id = d.id AND x.tenant_id = d.tenant_id), '[]'::jsonb)`;

async function loadOpenChunk(db, scope, cursor, limit, ids = null) {
  const params = [];
  let where = `d.tenant_id = ${T} AND d.stage <> 'verified'`;
  if (scope.singles) where += ' AND d.batch_id IS NULL';
  else { params.push(scope.batchId); where += ` AND d.batch_id = $${params.length}::uuid`; }
  if (ids) { params.push(ids); where += ` AND d.id = ANY($${params.length}::uuid[])`; }
  else if (cursor) { params.push(cursor); where += ` AND d.id > $${params.length}::uuid`; }
  const r = await db.raw(
    `SELECT d.id, d.original_filename AS filename, d.document_type, d.stage, d.extract_error, d.created_at, d.extracted_at, d.verified_by, d.batch_id,
            ${FILTER_JSON} AS fields,
            EXISTS (SELECT 1 FROM document_entity_links l WHERE l.document_id = d.id AND l.tenant_id = d.tenant_id) AS linked_any,
            EXISTS (SELECT 1 FROM document_pages p WHERE p.document_id = d.id AND p.tenant_id = d.tenant_id AND btrim(COALESCE(p.text, '')) <> '') AS has_text
       FROM documents d WHERE ${where} ORDER BY d.id LIMIT ${Math.max(1, Math.min(2000, limit))}`,
    params
  );
  if (r.rows.length) {
    // set-based, not one audit lookup per paper (audit_log has no resource index)
    const ids2 = r.rows.map((x) => x.id);
    const a = await db.raw(
      `SELECT resource_id, bool_or(action = 'review.document_classified') AS human_typed,
              (array_agg(action ORDER BY created_at DESC, id DESC) FILTER (WHERE action IN (${IMPORT_ACTIONS_SQL})))[1] AS last_import_action,
              bool_or(action = 'review.stored_fact_flagged') AS flagged
         FROM audit_log WHERE tenant_id = ${T} AND resource_id = ANY($1::uuid[])
          AND action IN ('review.document_classified', 'review.stored_fact_flagged', ${IMPORT_ACTIONS_SQL}) GROUP BY resource_id`, [ids2]);
    const by = new Map(a.rows.map((x) => [x.resource_id, x]));
    for (const row of r.rows) { const x = by.get(row.id); row.human_typed = !!x?.human_typed; row.last_import_action = x?.last_import_action ?? null; row.flagged = !!x?.flagged; }
  }
  return r.rows;
}

async function loadPages(db, ids) {
  const by = new Map();
  if (!ids.length) return by;
  const r = await db.raw(
    `SELECT document_id, page_no, left(COALESCE(text, ''), 6000) AS text FROM document_pages
      WHERE tenant_id = ${T} AND document_id = ANY($1::uuid[]) AND page_no <= 3 ORDER BY document_id, page_no`, [ids]);
  for (const p of r.rows) (by.get(p.document_id) ?? by.set(p.document_id, []).get(p.document_id)).push({ page_no: p.page_no, text: p.text });
  return by;
}

/** Live "Link to <customer>?" suggestions for papers with no link (same rule as reviewStore.listLinks), and the customers they name that still exist. */
async function loadSuggestions(db, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const sug = (await db.raw(
    `SELECT DISTINCT ON (resource_id) resource_id AS document_id, changes, created_at
       FROM audit_log WHERE resource_id = ANY($1::uuid[]) AND action = 'recheck.link_suggestion' AND tenant_id = ${T}
      ORDER BY resource_id, created_at DESC`, [ids])).rows.filter((s) => Array.isArray(s.changes?.candidates) && s.changes.candidates.length > 0);
  if (!sug.length) return out;
  const touched = new Map((await db.raw(
    `SELECT resource_id, MAX(created_at) AS at FROM audit_log
      WHERE resource_id = ANY($1::uuid[]) AND action IN ('review.document_linked','review.document_unlinked') AND tenant_id = ${T} GROUP BY resource_id`,
    [sug.map((s) => s.document_id)])).rows.map((r) => [r.resource_id, new Date(r.at).getTime()]));
  const candIds = [...new Set(sug.flatMap((s) => s.changes.candidates.map((c) => String(c.id))).filter(isUuid))];
  const alive = new Map();
  if (candIds.length) {
    for (const e of (await db.raw(
      `SELECT id, data->>'customer_name' AS name FROM entities WHERE id = ANY($1::uuid[]) AND entity_type = 'customer' AND merged_into IS NULL AND tenant_id = ${T}`, [candIds])).rows) alive.set(e.id, e.name ?? '');
  }
  for (const s of sug) {
    if (touched.has(s.document_id) && touched.get(s.document_id) >= new Date(s.created_at).getTime()) continue;
    const list = s.changes.candidates.map((c) => ({ id: String(c.id), name: alive.get(String(c.id)) ?? null, strong: c.strong === true })).filter((c) => c.name !== null).slice(0, 3);
    if (list.length) out.set(s.document_id, list);
  }
  return out;
}

async function financialsFor(db, ids) {
  const by = new Map();
  if (!ids.length) return by;
  try {
    const probe = await db.raw("SELECT to_regclass('public.document_financials') IS NOT NULL AS ok", []);
    if (!probe.rows?.[0]?.ok) return by;
    const r = await db.raw(
      `SELECT document_id, flags, confidence, verified_by, invoice_date::text AS invoice_date FROM document_financials WHERE tenant_id = ${T} AND document_id = ANY($1::uuid[])`, [ids]);
    for (const f of r.rows) {
      const flags = Array.isArray(f.flags) ? f.flags : [];
      const conf = Number(f.confidence);
      by.set(f.document_id, { review: !f.verified_by && (flags.some((x) => REVIEW_FLAGS.includes(x)) || (Number.isFinite(conf) && conf < REVIEW_CONFIDENCE)), invoiceDate: f.invoice_date ?? null });
    }
  } catch { /* the table is optional */ }
  return by;
}

/** Light facts of EVERY paper in the scope (filed ones too) and of other papers sharing a document number: the pool a copy is looked for in. */
async function loadCopyPool(db, scope, numbers) {
  const select = `SELECT d.id, d.original_filename AS filename, d.document_type, d.stage, d.created_at,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('field_key', x.field_key, 'value', x.value, 'corrected_value', x.corrected_value))
                    FROM extractions x WHERE x.document_id = d.id AND x.tenant_id = d.tenant_id
                     AND x.field_key IN ('cost','total','customer_name','vendor','service_date','invoice_date',${DOC_NUMBER_SQL})), '[]'::jsonb) AS fields,
        (SELECT md5(string_agg(lower(regexp_replace(left(p.text, 4000), '\\s+', ' ', 'g')), '|' ORDER BY p.page_no)) FROM document_pages p
          WHERE p.document_id = d.id AND p.tenant_id = d.tenant_id AND p.page_no <= 3 AND btrim(COALESCE(p.text, '')) <> '') AS text_hash,
        COALESCE((SELECT array_agg(l.entity_id::text) FROM document_entity_links l WHERE l.document_id = d.id AND l.tenant_id = d.tenant_id), '{}') AS customer_ids
     FROM documents d`;
  const scoped = scope.singles ? 'd.batch_id IS NULL' : 'd.batch_id = $1::uuid';
  const rows = (await db.raw(`${select} WHERE d.tenant_id = ${T} AND ${scoped}`, scope.singles ? [] : [scope.batchId])).rows;
  const known = new Set(rows.map((r) => r.id));
  if (numbers.size) {
    const ext = (await db.raw(
      `${select} WHERE d.tenant_id = ${T} AND d.stage = 'verified' AND NOT (${scoped.replace('$1', '$2')})
         AND EXISTS (SELECT 1 FROM extractions x WHERE x.document_id = d.id AND x.tenant_id = d.tenant_id AND x.field_key IN (${DOC_NUMBER_SQL})
                        AND upper(regexp_replace(COALESCE(NULLIF(trim(x.corrected_value), ''), x.value, ''), '[^A-Za-z0-9]', '', 'g')) = ANY($1::text[]))
       LIMIT 2000`, scope.singles ? [[...numbers]] : [[...numbers], scope.batchId])).rows;
    for (const r of ext) if (!known.has(r.id)) rows.push(r);
  }
  return rows.map((r) => {
    const fields = Array.isArray(r.fields) ? r.fields : [];
    return { id: r.id, filename: r.filename ?? '', type: normalizeDocumentType(r.document_type), stage: r.stage, createdAt: new Date(r.created_at).getTime(), number: docNumberOf(fields), cost: costOf(fields), party: partyOf(fields), date: dateOf(fields), hash: r.text_hash ?? null, customerIds: r.customer_ids ?? [] };
  });
}

/* ========================================================================================================== analysis */

const HR_TYPES = new Set(['hr-letter', 'license-certification']);

/** The problems a paper has that keep it out of automatic filing (beyond autoCheckDecision's own reason). */
function guardBlockers(a, env) {
  const out = [];
  if (a.setAside) out.push('set-aside');
  if (a.fields.some((f) => f.field_key.endsWith('_unconfirmed') && val(f))) out.push('unconfirmed-date');
  if (a.fields.some((f) => f.field_key === '_nothing_read')) out.push('nothing-read');
  if (env.flagsVisible && a.flagged) out.push('stored-value-flag');
  if (a.money?.review) out.push('money');
  if (a.copyOf) out.push('copy');
  if (a.typeQuestion) out.push('type-question');
  if (a.lastImportAction === ACTION.autoFileUndone) out.push('undone');
  return out;
}

/**
 * Analyse a set of open papers (rows from loadOpenChunk) with the evidence they need. Pure given its inputs except for the helper loads.
 * Returns analysed papers: {id, filename, type, state, verdict, eligible, blockers, linked, causes...}
 */
async function analyseRows(db, rows, env) {
  const ids = rows.map((r) => r.id);
  const needPages = rows.filter((r) => r.has_text && !(r.extract_error));
  const [pages, sugg, fin] = await Promise.all([
    loadPages(db, needPages.map((r) => r.id)),
    loadSuggestions(db, rows.filter((r) => !r.linked_any).map((r) => r.id)),
    financialsFor(db, ids),
  ]);
  const now = env.now;
  const out = [];
  for (const r of rows) {
    const fields = Array.isArray(r.fields) ? r.fields : [];
    const factsObj = Object.fromEntries(fields.filter((f) => val(f)).map((f) => [f.field_key, val(f)]));
    const type = normalizeDocumentType(r.document_type, factsObj);
    const pg = pages.get(r.id) ?? [];
    const text = pg.map((p) => p.text).join('\n');
    const extractedAgo = r.extracted_at ? (now - new Date(r.extracted_at).getTime()) / 60000 : null;
    const a = {
      id: r.id, filename: r.filename ?? '', type, stage: r.stage, fields, pages: pg, createdAt: new Date(r.created_at).getTime(),
      humanTyped: !!r.human_typed, lastImportAction: r.last_import_action ?? null, flagged: !!r.flagged,
      linked: !!r.linked_any || fields.some((f) => f.entity_id),
      suggestions: sugg.get(r.id) ?? [], money: fin.get(r.id) ?? null,
      hrFiled: fields.some((f) => f.field_key === COMPANY_FOLDER_FIELD_KEY && val(f) === HR_FOLDER_ID),
      // set aside ON ITS OWN = VOID only (the Inbox's own rule); a copy by name is a decision for a person, not something done silently
      setAside: fields.some((f) => f.field_key === SET_ASIDE_KEY && val(f)) || isVoidMarked({ filename: r.filename, text: pg.slice(0, 2).map((p) => p.text).join('\n') }),
      copyName: isLikelyCopyName(r.filename),
      state: 'open', verdict: null, blockers: [], eligible: false, copyOf: null, typeQuestion: null,
    };
    if (r.extract_error) a.state = 'failed';
    else if (r.stage === 'received') a.state = 'progress';
    else if (r.stage === 'read' && extractedAgo !== null && extractedAgo >= 0 && extractedAgo < PROGRESS_WINDOW_MIN) a.state = 'progress';
    if (a.state === 'open') {
      a.verdict = autoCheckDecision(type, toCompletenessFields(fields), { hasText: !!r.has_text, hasLink: a.linked, filename: r.filename ?? null, text });
      a.typeQuestion = typeDisagreement({ type, filename: r.filename, pages: pg, humanTyped: a.humanTyped });
      a.copyOf = env.copies.get(a.id) ?? null;
      a.blockers = guardBlockers(a, env);
      a.eligible = a.verdict.ok && a.blockers.length === 0;
    }
    out.push(a);
  }
  return out;
}

async function openScopeRows(db, scope, env) {
  const all = [];
  let cursor = null;
  for (;;) {
    if (Date.now() > env.deadlineAt) throw new ImportError('This import is large; the check ran out of time. Try again in a moment.', 503);
    const rows = await loadOpenChunk(db, scope, cursor, SCAN_CHUNK);
    if (!rows.length) break;
    all.push(...rows);
    cursor = rows[rows.length - 1].id;
    if (rows.length < SCAN_CHUNK) break;
  }
  return all;
}

const analysisCache = new Map(); // `${tenantId}|${scopeKey}` -> {at, value}
export function _clearAnalysisCache() { analysisCache.clear(); }
const cacheKey = (db, scope) => `${db.tenantId}|${scope.key}`;

/** The whole scope: counts and every open paper analysed. Cached for CACHE_MS; patched in place by filing, dropped by anything else. */
async function analyseScope(db, scope, { deadlineAt = Date.now() + 100_000, fresh = false } = {}) {
  const ck = cacheKey(db, scope);
  const hit = analysisCache.get(ck);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const now = Date.now();
  const params = scope.singles ? [] : [scope.batchId];
  const countsRow = (await db.raw(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE stage = 'verified')::int AS filed,
            count(*) FILTER (WHERE stage = 'verified' AND verified_by = 'ai')::int AS filed_auto
       FROM documents d WHERE d.tenant_id = ${T} AND ${scopeWhere(scope).replace('$SCOPE', '$1')}`, params)).rows[0] ?? {};
  const rows = await openScopeRows(db, scope, { deadlineAt });
  const settings = await readSettings(db);
  // copy pool: every paper of the scope (filed ones too) plus filed papers elsewhere that share a document number with an open one
  const numbers = new Set();
  for (const r of rows) { const n = docNumberOf(Array.isArray(r.fields) ? r.fields : []); if (n.length >= 3) numbers.add(n); }
  const pool = await loadCopyPool(db, scope, numbers);
  const copies = findCopies(pool);
  const ownNames = await loadOwnNames({ raw: (s, p) => db.raw(s, p) }, {}).catch(() => []);
  const env = { now, flagsVisible: flagsVisible(), copies, ownNames };
  const analysed = [];
  for (let i = 0; i < rows.length; i += SCAN_CHUNK) {
    if (Date.now() > deadlineAt) throw new ImportError('This import is large; the check ran out of time. Try again in a moment.', 503);
    analysed.push(...(await analyseRows(db, rows.slice(i, i + SCAN_CHUNK), env)));
  }
  const poolById = new Map(pool.map((p) => [p.id, p]));
  for (const a of analysed) { if (a.copyOf) a.copyOfDoc = poolById.get(a.copyOf) ?? null; }
  const value = {
    at: Date.now(), scope, settings, ownNames, env,
    total: countsRow.total ?? 0, filed: countsRow.filed ?? 0, filedAuto: countsRow.filed_auto ?? 0,
    docs: analysed,
  };
  analysisCache.set(ck, { at: Date.now(), value });
  return value;
}

/** Counts for the progress page. */
function countsOf(an) {
  let progress = 0, failed = 0, open = 0, eligible = 0, setAside = 0;
  for (const a of an.docs) {
    if (a.state === 'progress') progress++;
    else if (a.state === 'failed') { failed++; open++; }
    else if (a.setAside) setAside++;
    else { open++; if (a.eligible) eligible++; }
  }
  const settingOn = scopeOn(an.settings, an.scope);
  // Papers that will be filed by the autopilot are still "in progress" from the person's side; with the setting off they are waiting for one click.
  const filing = settingOn ? eligible : 0;
  const needYou = open - filing;
  return {
    total: an.total, filed: an.filed, filedAutomatically: an.filedAuto, filedByPerson: Math.max(0, an.filed - an.filedAuto),
    reading: progress, filing, needYou, failed, setAside, eligible,
    inProgress: progress + filing,
  };
}

/* ======================================================================================================== decisions */

const pickSamples = (items, n = SAMPLE_COUNT) => {
  if (items.length <= n) return items.slice();
  const idx = [0, Math.floor(items.length / 2), items.length - 1].slice(0, n);
  return [...new Set(idx)].map((i) => items[i]);
};
const noMoney = (s) => String(s ?? '').replace(/\$\s?[\d,]+(?:\.\d+)?/g, '').replace(/\s{2,}/g, ' ').trim();

/**
 * Cluster the open papers that are not filing on their own by shared cause. A paper may sit in more than one group (it needs both a customer and
 * a date); a group needs MIN_GROUP papers. Everything in a group is re-checked by the server again at the moment of the click.
 */
function buildDecisions(an, cap = {}) {
  const settingOn = scopeOn(an.settings, an.scope);
  const open = an.docs.filter((a) => a.state === 'open' && !a.setAside);
  const groups = new Map(); // id -> {id, kind, params, items:[{a, note}]}
  const put = (kind, key, params, a, note) => {
    const id = `${kind}:${key}`;
    const g = groups.get(id) ?? groups.set(id, { id, kind, params, items: [] }).get(id);
    g.items.push({ a, note });
  };
  const today = new Date().toISOString().slice(0, 10);
  for (const a of open) {
    if (a.eligible) continue; // files by itself (or is covered by "file passed" below)
    const hr = HR_TYPES.has(a.type) || a.hrFiled;
    // copies of papers already filed
    if (a.copyOf && a.copyOfDoc && a.copyOfDoc.stage === 'verified') put('set-aside-copies', 'filed', {}, a, `Looks like a copy of ${noMoney(a.copyOfDoc.filename)}`);
    // type question
    if (a.typeQuestion) {
      const [x, y] = [a.typeQuestion.a, a.typeQuestion.b].sort();
      put('choose-type', `${x}|${y}`, { options: [x, y] }, a, `Stored as ${a.typeQuestion.a}; the page reads as ${a.typeQuestion.b}`);
    }
    // customer
    const needsLink = !a.linked && !linkNotRequired(a.type, new Set(a.fields.filter((f) => val(f)).map((f) => f.field_key)));
    if (needsLink && !hr && !a.copyOf) {
      if (a.suggestions.length === 1) {
        // R6: a group is linked in one press only on STRONG evidence (name and street, or the exact name as a customer-label value). A weak
        // suggestion (a name or a street alone) stays a paper to confirm one at a time.
        const s = a.suggestions[0];
        if (s.strong) put('link-suggested', s.id, { customerId: s.id, customerName: s.name }, a, `The page points at ${s.name}`);
      } else if (a.suggestions.length === 0) {
        const printed = first(a.fields, (k) => k === 'customer_name');
        const ev = newCustomerEvidence({ type: a.type, filename: a.filename, pages: a.pages, printedName: printed || null, ownNames: an.ownNames, hrFiled: a.hrFiled });
        if (ev) {
          const existing = an.customerByKey?.get(ev.key);
          if (existing) put('link-suggested', existing.id, { customerId: existing.id, customerName: existing.name }, a, `The customer side of the page names ${ev.name}`);
          else put('create-customer', ev.key, { name: ev.name }, a, `The customer side of the page names ${ev.name}`);
        }
      }
    }
    // service date from the invoice date
    if (a.verdict && a.verdict.reason === 'missing-required') {
      const facts = toCompletenessFields(a.fields);
      const c = completenessFor(a.type, facts, null, { filename: a.filename });
      if (c.missing.length === 1 && c.missing[0] === 'service_date' && !a.fields.some((f) => f.field_key === 'service_date_unconfirmed' && val(f))) {
        const inv = plausibleDay(first(a.fields, (k) => k === 'invoice_date') || a.money?.invoiceDate, today);
        if (inv && !val(a.fields.find((f) => f.field_key === 'service_date') ?? {})) put('use-invoice-date', 'service_date', {}, a, `Invoice date ${inv}`);
      }
    }
  }
  const decisions = [];
  const inDecision = new Set();
  const nameVotes = (g) => {
    const m = new Map();
    for (const it of g.items) { const n = it.note.replace(/^.*names /, ''); m.set(n, (m.get(n) ?? 0) + 1); }
    return [...m.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? '';
  };
  for (const g of groups.values()) {
    if (g.items.length < MIN_GROUP) continue;
    const members = g.items;
    if (g.kind === 'create-customer') g.params = { ...g.params, name: nameVotes(g) || g.params.name };
    for (const m of members) inDecision.add(m.a.id);
    decisions.push({
      id: g.id, kind: g.kind, params: g.params, count: members.length,
      samples: pickSamples(members).map((m) => ({ documentId: m.a.id, name: noMoney(m.a.filename), typeId: m.a.type, note: noMoney(m.note) })),
      documentIds: members.map((m) => m.a.id),
    });
  }
  if (!settingOn) {
    const passed = open.filter((a) => a.eligible);
    if (passed.length >= 1) {
      for (const a of passed) inDecision.add(a.id);
      decisions.push({
        id: 'file-passed:all', kind: 'file-passed', params: {}, count: passed.length,
        samples: pickSamples(passed).map((a) => ({ documentId: a.id, name: noMoney(a.filename), typeId: a.type, note: 'Passed every check' })),
        documentIds: passed.map((a) => a.id),
      });
    }
  }
  // order: biggest first, but the one-click-safe kinds before the ones that create something
  const rank = { 'file-passed': 0, 'set-aside-copies': 1, 'link-suggested': 2, 'use-invoice-date': 3, 'choose-type': 4, 'create-customer': 5 };
  decisions.sort((x, y) => (rank[x.kind] - rank[y.kind]) || (y.count - x.count) || x.id.localeCompare(y.id));
  const filingSet = new Set(settingOn ? open.filter((a) => a.eligible).map((a) => a.id) : []);
  const lookAt = open.filter((a) => !inDecision.has(a.id) && !filingSet.has(a.id));
  const failed = an.docs.filter((a) => a.state === 'failed');
  return { decisions, lookAt, failed };
}

function lookReason(a) {
  if (a.state === 'failed') return 'unreadable';
  const r = a.verdict?.reason;
  if (a.blockers?.includes('copy')) return 'copy';
  if (a.blockers?.includes('money')) return 'money';
  if (a.blockers?.includes('stored-value-flag')) return 'flag';
  if (a.blockers?.includes('type-question')) return 'type';
  if (a.blockers?.includes('undone')) return 'undone';
  if (a.blockers?.includes('unconfirmed-date')) return 'date';
  if (r === 'needs-link') return a.suggestions.length > 1 ? 'which-customer' : a.suggestions.length === 1 ? 'one-customer' : 'no-customer';
  if (r === 'missing-required') return 'missing-info';
  if (r === 'unreadable' || r === 'barely-readable') return 'hard-to-read';
  if (r === 'needs-type') return 'type';
  if (r === 'low-confidence' || r === 'amount-not-confirmed') return 'unsure-value';
  if (r === 'date-unconfirmed') return 'date';
  return 'other';
}

async function customerIndex(db) {
  const r = await db.raw(`SELECT id, data->>'customer_name' AS name FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND tenant_id = ${T} AND COALESCE(data->>'customer_name', '') <> '' LIMIT 20000`, []);
  const m = new Map();
  for (const e of r.rows) { const k = nameKey(e.name); if (k && !m.has(k)) m.set(k, { id: e.id, name: e.name }); }
  return m;
}

/* ============================================================================================================ queries */

/** Import jobs, newest first: every drop that carried a batch id and held at least IMPORT_MIN_DOCS papers. */
export async function listImports(ctx, { limit = 10, minDocs = IMPORT_MIN_DOCS } = {}) {
  return withTenant(ctx, async (db) => {
    const settings = await readSettings(db);
    const r = await db.raw(
      `SELECT batch_id, count(*)::int AS total, min(created_at) AS started_at, max(created_at) AS last_at,
              count(*) FILTER (WHERE stage = 'verified')::int AS filed
         FROM documents WHERE tenant_id = ${T} AND batch_id IS NOT NULL
        GROUP BY batch_id HAVING count(*) >= $1 ORDER BY max(created_at) DESC LIMIT $2`,
      [Math.max(1, Number(minDocs) || IMPORT_MIN_DOCS), Math.max(1, Math.min(50, Number(limit) || 10))]);
    return {
      settings,
      imports: r.rows.map((x) => ({ batchId: x.batch_id, total: x.total, filed: x.filed, startedAt: x.started_at, lastAt: x.last_at, paused: settings.pausedBatches.includes(x.batch_id) })),
    };
  });
}

const JUDGING_ACTIONS_SQL = `${IMPORT_ACTIONS_SQL}, 'review.document_unverified', 'review.field_corrected', 'review.document_verified', 'review.document_linked', 'review.document_unlinked', 'review.document_classified'`;

/** For every filed paper of the scope: the NEWEST audit row that says who last touched it (one pass, no per-paper lookup). */
async function newestAuditOfVerified(db, scope, runId = null, limit = 5000) {
  const params = scope.singles ? [] : [scope.batchId];
  const r = await db.raw(
    `SELECT DISTINCT ON (a.resource_id) a.resource_id AS id, a.action, a.changes
       FROM audit_log a
      WHERE a.tenant_id = ${T} AND a.action IN (${JUDGING_ACTIONS_SQL})
        AND a.resource_id IN (SELECT d.id FROM documents d WHERE d.tenant_id = ${T} AND ${scopeWhere(scope).replace('$SCOPE', '$1')} AND d.stage = 'verified' AND d.verified_by = 'ai')
      ORDER BY a.resource_id, a.created_at DESC, a.id DESC LIMIT ${limit}`, params);
  return runId ? r.rows.filter((x) => x.changes?.runId === runId) : r.rows;
}

/** Progress page numbers. Cheap to poll (cached for CACHE_MS). */
export async function importStatus(ctx, payload = {}) {
  const scope = parseScope(payload);
  return withTenant(ctx, async (db) => {
    const an = await analyseScope(db, scope, { fresh: payload.fresh === true });
    const c = countsOf(an);
    const undoable = (await newestAuditOfVerified(db, scope)).filter((r) => r.action === ACTION.autoFiled).length;
    return { batchId: scope.batchId, singles: scope.singles, settings: an.settings, autoFileOn: scopeOn(an.settings, scope), counts: c, autoFiledUndoable: undoable, asOf: new Date(an.at).toISOString() };
  });
}

/** Decisions + the onboarding summary. */
export async function importPlan(ctx, payload = {}) {
  const scope = parseScope(payload);
  return withTenant(ctx, async (db) => {
    const an = await analyseScope(db, scope, { fresh: payload.fresh === true });
    an.customerByKey = await customerIndex(db);
    const c = countsOf(an);
    const { decisions, lookAt, failed } = buildDecisions(an);
    const reasons = new Map();
    for (const a of [...lookAt, ...failed]) { const k = lookReason(a); reasons.set(k, (reasons.get(k) ?? 0) + 1); }
    const lookIds = lookAt.concat(failed);
    return {
      batchId: scope.batchId, singles: scope.singles, settings: an.settings, autoFileOn: scopeOn(an.settings, scope),
      counts: c,
      summary: { filedAutomatically: c.filedAutomatically, decisions: decisions.length, lookAt: lookIds.length },
      decisions,
      lookAt: {
        count: lookIds.length,
        reasons: [...reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((x, y) => y.count - x.count),
        samples: pickSamples(lookIds).map((a) => ({ documentId: a.id, name: noMoney(a.filename), typeId: a.type, reason: lookReason(a) })),
        documentIds: lookIds.slice(0, 500).map((a) => a.id),
      },
      asOf: new Date(an.at).toISOString(),
    };
  });
}

/* ================================================================================================= filing (no click) */

/**
 * File the papers that pass every check. `force` (a person pressed "File all") skips only the tenant setting, never a check.
 * Never links, never creates, never writes a value. Audited per paper with the run id; undone per batch by importUndoAutoFile.
 */
export async function importAutoFile(ctx, payload = {}, actorClerkId = null) {
  const scope = parseScope(payload);
  const limit = Math.max(1, Math.min(MAX_FILE_PER_CALL, Number(payload.limit) || MAX_FILE_PER_CALL));
  const deadlineAt = Number(payload.deadlineAt) > 0 ? Number(payload.deadlineAt) : Date.now() + 60_000;
  const runId = isUuid(payload.runId) ? payload.runId : null;
  return withTenant(ctx, async (db) => {
    const an = await analyseScope(db, scope, { deadlineAt });
    if (!payload.force && !scopeOn(an.settings, scope)) return { filed: 0, skipped: 0, remaining: 0, off: true, runId };
    const want = (Array.isArray(payload.documentIds) ? new Set(payload.documentIds.filter(isUuid)) : null);
    const candidates = an.docs.filter((a) => a.eligible && (!want || want.has(a.id))).slice(0, limit);
    if (!candidates.length) return { filed: 0, skipped: 0, remaining: 0, off: false, runId };
    const run = runId ?? (await db.raw('SELECT uuid_generate_v4() AS id', [])).rows[0].id;
    const res = await fileChecked(db, an, candidates.map((a) => a.id), { actorClerkId, runId: run, scope, source: payload.source ?? 'client', via: want ? 'click' : 'autopilot', deadlineAt });
    const remaining = an.docs.filter((a) => a.eligible).length;
    return { filed: res.filed.length, skipped: res.skipped.length, remaining, off: false, runId: run };
  });
}

/** Re-reads the papers fresh, re-runs every check, files those that still pass. Patches the cached analysis. */
async function fileChecked(db, an, ids, { actorClerkId, runId, scope, source, via, deadlineAt = Infinity }) {
  const filed = [], skipped = [];
  const rows = await loadOpenChunk(db, scope, null, ids.length, ids);
  const fresh = await analyseRows(db, rows, an.env);
  const byId = new Map(fresh.map((a) => [a.id, a]));
  const audit = [];
  for (const id of ids) {
    if (Date.now() > deadlineAt) { skipped.push({ documentId: id, reason: 'time' }); continue; }
    const a = byId.get(id);
    if (!a || !a.eligible) { skipped.push({ documentId: id, reason: a ? (a.verdict?.reason ?? a.blockers[0] ?? 'not-ready') : 'gone' }); if (a) Object.assign(an.docs.find((x) => x.id === id) ?? {}, a); continue; }
    // verifyByAi re-checks the link / readable guard in SQL and only moves a paper that is still read / mapped / linked
    const n = await db.verifyByAi(id, { allowUnlinked: a.verdict.allowUnlinked });
    if (n > 0) { filed.push(id); audit.push({ resourceId: id, changes: { batchId: scope.batchId, runId, source, via, prevStage: a.stage, allowUnlinked: !!a.verdict.allowUnlinked } }); }
    else skipped.push({ documentId: id, reason: 'not-eligible-now' });
  }
  await bulkAudit(db, actorClerkId, ACTION.autoFiled, audit);
  if (filed.length) {
    const set = new Set(filed);
    an.docs = an.docs.filter((a) => !set.has(a.id));
    an.filed += filed.length; an.filedAuto += filed.length;
  }
  return { filed, skipped };
}

/**
 * Undo the automatic filing of one import (or of the runId given). Only papers whose NEWEST audit row is the auto-filing are touched: one a person
 * has edited, re-linked, re-typed or checked since is left exactly as it is. The batch is then paused so the autopilot does not file it again.
 */
export async function importUndoAutoFile(ctx, payload = {}, actorClerkId = null) {
  const scope = parseScope(payload);
  const limit = Math.max(1, Math.min(500, Number(payload.limit) || 300));
  const runId = isUuid(payload.runId) ? payload.runId : null;
  return withTenant(ctx, async (db) => {
    const mine = (await newestAuditOfVerified(db, scope, runId)).filter((r) => r.action === ACTION.autoFiled);
    const rows = mine.slice(0, limit);
    const undone = [];
    for (const r of rows) {
      const prev = ['read', 'mapped', 'linked'].includes(r.changes?.prevStage) ? r.changes.prevStage : 'linked';
      const u = await db.raw(`UPDATE documents SET stage = $2, verified_by = NULL, verified_at = NULL WHERE id = $1 AND tenant_id = ${T} AND stage = 'verified' AND verified_by = 'ai'`, [r.id, prev]);
      if (u.rowCount) undone.push({ resourceId: r.id, changes: { batchId: scope.batchId, runId: r.changes?.runId ?? null, restoredStage: prev } });
    }
    await bulkAudit(db, actorClerkId, ACTION.autoFileUndone, undone);
    if (!scope.singles) {
      const s = await readSettings(db);
      if (!s.pausedBatches.includes(scope.batchId)) { s.pausedBatches.push(scope.batchId); await writeSettings(db, s); }
    }
    analysisCache.delete(cacheKey(db, scope));
    return { undone: undone.length, more: mine.length > rows.length, paused: !scope.singles };
  });
}

/** Lets the autopilot run on a paused import again (a person pressed "Turn back on"). */
export async function importResume(ctx, payload = {}, actorClerkId = null) {
  const scope = parseScope(payload);
  return withTenant(ctx, async (db) => {
    const s = await readSettings(db);
    s.pausedBatches = s.pausedBatches.filter((b) => b !== scope.batchId);
    await writeSettings(db, s);
    await db.logAction({ action: ACTION.settingsChanged, resource_type: 'tenant', resource_id: null, clerk_user_id: actorClerkId, changes: { resumed: scope.batchId } });
    analysisCache.delete(cacheKey(db, scope));
    return { ok: true };
  });
}

/**
 * Nightly / on-demand sweep for ONE tenant: file what passes in every import that is still on (and in single uploads when that is on).
 * Bounded by `deadlineAt` and `perTenant`. Used by cron-sweep.js. $0, no model.
 */
export async function autoFileSweep(ctx, { perTenant = 400, deadlineAt = Date.now() + 60_000, days = 14 } = {}) {
  const tally = { filed: 0, batches: 0 };
  const jobs = await withTenant(ctx, async (db) => {
    const settings = await readSettings(db);
    const out = [];
    if (settings.autoFileImports) {
      const r = await db.raw(
        `SELECT batch_id FROM documents WHERE tenant_id = ${T} AND batch_id IS NOT NULL AND stage <> 'verified' AND created_at > NOW() - ($1::int * INTERVAL '1 day')
          GROUP BY batch_id HAVING count(*) >= 1 ORDER BY max(created_at) DESC LIMIT 5`, [days]);
      for (const x of r.rows) if (!settings.pausedBatches.includes(x.batch_id)) out.push({ batchId: x.batch_id });
    }
    if (settings.autoFileSingles) out.push({ singles: true });
    return out;
  });
  let left = perTenant;
  for (const j of jobs) {
    if (left <= 0 || Date.now() > deadlineAt) break;
    for (let guard = 0; guard < 10 && left > 0 && Date.now() < deadlineAt; guard++) {
      const r = await importAutoFile(ctx, { ...j, limit: Math.min(MAX_FILE_PER_CALL, left), deadlineAt, source: 'cron' }, null);
      tally.filed += r.filed; left -= r.filed;
      if (!r.filed || !r.remaining) break;
    }
    tally.batches += 1;
  }
  return tally;
}

/* =================================================================================== decisions: apply (a person's click) */

async function loadForApply(db, scope, documentIds) {
  const ids = [...new Set((Array.isArray(documentIds) ? documentIds : []).filter(isUuid))];
  if (!ids.length) throw new ImportError('documentIds is required', 400);
  if (ids.length > MAX_APPLY) throw new ImportError(`A decision is applied ${MAX_APPLY} papers at a time`, 413);
  const rows = await loadOpenChunk(db, scope, null, ids.length, ids);
  const numbers = new Set();
  for (const r of rows) { const n = docNumberOf(Array.isArray(r.fields) ? r.fields : []); if (n.length >= 3) numbers.add(n); }
  const pool = await loadCopyPool(db, scope, numbers);
  const ownNames = await loadOwnNames({ raw: (s, p) => db.raw(s, p) }, {}).catch(() => []);
  const env = { now: Date.now(), flagsVisible: flagsVisible(), copies: findCopies(pool), ownNames };
  return { analysed: await analyseRows(db, rows, env), env, pool, ids };
}

async function advisory(db, key) { await db.raw('SELECT pg_advisory_xact_lock(hashtext($1))', [key]); }

/** Write a person's value for a field the paper does not have. Never replaces a read value or another person's value. Returns an undo record or null. */
async function writePersonValue(db, a, key, value, by) {
  const rows = a.fields.filter((f) => f.field_key === key);
  if (rows.some((f) => String(f.corrected_value ?? '').trim())) return null; // a person's value: never replaced
  if (rows.some((f) => String(f.value ?? '').trim() && !(key === 'customer_name' && isLabelValue(f.value)))) return null; // a real read value: not missing
  const target = rows[0];
  if (target) {
    // the read value (empty, or a form label) stays; the correction sits beside it, exactly as a person's correction does
    const u = await db.raw(`UPDATE extractions SET corrected_value = $2, corrected_by = $3, corrected_at = NOW() WHERE id = $1 AND tenant_id = ${T} AND COALESCE(btrim(corrected_value), '') = ''`, [target.id, value, by]);
    return u.rowCount ? { kind: 'corrected', extractionId: target.id, key, value } : null;
  }
  const ins = await db.raw(
    `INSERT INTO extractions (tenant_id, document_id, field_key, value, corrected_value, corrected_by, corrected_at, confidence, created_at)
     VALUES (${T}, $1, $2, NULL, $3, $4, NOW(), 1, NOW()) RETURNING id`, [a.id, key, value, by]);
  return { kind: 'inserted', extractionId: ins.rows[0].id, key, value };
}

async function linkAsPerson(db, a, customerId, by) {
  const ins = await db.raw(
    `INSERT INTO document_entity_links (tenant_id, document_id, entity_id, confidence, linked_by, created_at)
     VALUES (${T}, $1, $2, 1.0, $3, NOW()) ON CONFLICT (tenant_id, document_id, entity_id) DO NOTHING`, [a.id, customerId, by]);
  await db.raw(`UPDATE documents SET stage = 'linked' WHERE id = $1 AND tenant_id = ${T} AND stage IN ('received', 'read', 'mapped')`, [a.id]);
  return ins.rowCount > 0;
}

const cleanBy = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f\u202A-\u202E\u2066-\u2069]/g, '').trim().slice(0, 120) || 'a person';

/** Does this paper qualify for "create this customer" under the group key right now? (the server's own check, never the browser's) */
function qualifiesForCreate(a, env, key) {
  const printed = first(a.fields, (k) => k === 'customer_name');
  const ev = newCustomerEvidence({ type: a.type, filename: a.filename, pages: a.pages, printedName: printed || null, ownNames: env.ownNames, hrFiled: a.hrFiled });
  const hr = HR_TYPES.has(a.type) || a.hrFiled;
  if (!ev || ev.key !== key || a.suggestions.length > 0 || a.linked || hr || a.setAside || a.copyOf) return null;
  return ev;
}

/**
 * One click on a decision card, for one chunk of up to MAX_APPLY papers. The server re-derives the cause for EVERY paper (nothing the browser says
 * about a paper is trusted) and skips those that no longer fit. Payload: {batchId|singles, kind, key, documentIds, choice?, customerId?, name?, by, runId?}.
 * Returns {applied, skipped:[{documentId, reason}], runId, customerId?, filed}.
 */
export async function importApplyDecision(ctx, payload = {}, actorClerkId = null) {
  const scope = parseScope(payload);
  const kind = String(payload.kind ?? '');
  if (!['link-suggested', 'create-customer', 'use-invoice-date', 'set-aside-copies', 'choose-type', 'file-passed'].includes(kind)) throw new ImportError('Unknown decision kind', 400);
  const by = cleanBy(payload.by);
  const key = String(payload.key ?? '').slice(0, 200);
  let customerId = uuidOrNull(payload.customerId);
  const documentIds = [...new Set((Array.isArray(payload.documentIds) ? payload.documentIds : []).filter(isUuid))];
  if (!documentIds.length) throw new ImportError('documentIds is required', 400);
  if (documentIds.length > MAX_APPLY) throw new ImportError(`A decision is applied ${MAX_APPLY} papers at a time`, 413);
  let runId = isUuid(payload.runId) ? payload.runId : null;
  if (!runId) runId = (await withTenant(ctx, (db) => db.raw('SELECT uuid_generate_v4() AS id', []))).rows[0].id;

  // Creating a customer happens ONCE, only on a person's click, and only when the customer side of at least two papers in the chunk (or one paper, with its address) really names this customer.
  if (kind === 'create-customer' && !customerId) {
    const name = String(payload.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!name || nameKey(name) !== key) throw new ImportError('name does not match the group', 400);
    const anyQualifies = await withTenant(ctx, async (db) => {
      const { analysed, env } = await loadForApply(db, scope, documentIds);
      const evs = analysed.map((a) => qualifiesForCreate(a, env, key)).filter(Boolean);
      // the name must sit on the customer side of at least 2 papers, or of one paper together with its address
      return createEvidenceEnough(evs);
    });
    if (!anyQualifies) throw new ImportError('None of these papers names this customer any more. Refresh and try again.', 409);
    try {
      customerId = (await reviewStore.createCustomer(ctx, { name }, actorClerkId)).customer.id;
    } catch (err) {
      if (err instanceof reviewStore.ReviewError && err.status === 409) throw new ImportError('A customer with this name already exists. Refresh to link to it instead.', 409, err.details ?? null);
      throw err;
    }
    await withTenant(ctx, (db) => bulkAudit(db, actorClerkId, ACTION.customerCreated, [{ resourceId: customerId, changes: { runId, batchId: scope.batchId, name, by } }], 'entity'));
  }

  return withTenant(ctx, async (db) => {
    const result = { applied: 0, skipped: [], runId, customerId, filed: 0 };
    const settings = await readSettings(db);
    const { analysed, env, pool } = await loadForApply(db, scope, documentIds);
    const poolById = new Map(pool.map((p) => [p.id, p]));
    const found = new Map(analysed.map((a) => [a.id, a]));
    for (const id of documentIds) if (!found.has(id)) result.skipped.push({ documentId: id, reason: 'not-open' });
    const audit = [];
    const touched = [];
    const today = new Date().toISOString().slice(0, 10);

    if (kind === 'create-customer' || kind === 'link-suggested') {
      if (kind === 'link-suggested') customerId = customerId ?? uuidOrNull(key);
      if (!customerId) throw new ImportError('customerId is required', 400);
      result.customerId = customerId;
      const cust = (await db.raw(`SELECT id, data->>'customer_name' AS name FROM entities WHERE id = $1 AND entity_type = 'customer' AND merged_into IS NULL AND tenant_id = ${T}`, [customerId])).rows[0];
      if (!cust) throw new ImportError('That customer no longer exists. Refresh and try again.', 404);
      if (kind === 'create-customer') {
        const made = (await db.raw(`SELECT 1 FROM audit_log WHERE action = '${ACTION.customerCreated}' AND resource_id = $1 AND tenant_id = ${T} AND changes->>'runId' = $2`, [customerId, runId])).rowCount;
        if (!made) throw new ImportError('That customer was not created by this decision', 400);
      }
      for (const a of analysed) {
        await advisory(db, `import-apply:${a.id}`);
        const hr = HR_TYPES.has(a.type) || a.hrFiled;
        if (hr || a.setAside || a.copyOf) { result.skipped.push({ documentId: a.id, reason: 'not-a-customer-paper' }); continue; }
        const linkedNow = (await db.raw(`SELECT EXISTS (SELECT 1 FROM document_entity_links WHERE document_id = $1 AND tenant_id = ${T}) AS l`, [a.id])).rows[0].l;
        if (linkedNow) { result.skipped.push({ documentId: a.id, reason: 'already-linked' }); continue; }
        let valueUndo = null;
        if (kind === 'link-suggested') {
          // R6: only a paper whose own suggestion names EXACTLY this one customer, or whose customer side names exactly this customer
          const sOk = a.suggestions.length === 1 && a.suggestions[0].id === customerId && a.suggestions[0].strong === true;
          const printed = first(a.fields, (k) => k === 'customer_name');
          const ev = sOk ? null : newCustomerEvidence({ type: a.type, filename: a.filename, pages: a.pages, printedName: printed || null, ownNames: env.ownNames, hrFiled: a.hrFiled });
          if (!sOk && !(ev && a.suggestions.length === 0 && nameKey(cust.name) === ev.key)) { result.skipped.push({ documentId: a.id, reason: 'evidence-changed' }); continue; }
        } else {
          if (!qualifiesForCreate(a, env, key)) { result.skipped.push({ documentId: a.id, reason: 'evidence-changed' }); continue; }
        }
        // the paper carries no customer name of its own: record this person's value (never over a read or typed one)
        valueUndo = await writePersonValue(db, a, 'customer_name', cust.name, by);
        const inserted = await linkAsPerson(db, a, customerId, by);
        if (!inserted) { result.skipped.push({ documentId: a.id, reason: 'already-linked' }); continue; }
        result.applied++; touched.push(a.id);
        audit.push({ resourceId: a.id, changes: { kind, key, runId, batchId: scope.batchId, undo: { link: customerId, stageBefore: a.stage, value: valueUndo }, by } });
        await bulkAudit(db, actorClerkId, 'review.document_linked', [{ resourceId: a.id, changes: { entityId: customerId, by, via: 'import-decision', runId } }]);
      }
    } else if (kind === 'use-invoice-date') {
      const fin = await financialsFor(db, analysed.map((a) => a.id));
      for (const a of analysed) {
        await advisory(db, `import-apply:${a.id}`);
        const c = completenessFor(a.type, toCompletenessFields(a.fields), null, { filename: a.filename });
        const inv = plausibleDay(first(a.fields, (k) => k === 'invoice_date') || fin.get(a.id)?.invoiceDate, today);
        if (!(c.missing.length === 1 && c.missing[0] === 'service_date') || !inv || a.setAside || a.fields.some((f) => f.field_key === 'service_date_unconfirmed' && val(f))) { result.skipped.push({ documentId: a.id, reason: 'evidence-changed' }); continue; }
        const w = await writePersonValue(db, a, 'service_date', inv, by);
        if (!w) { result.skipped.push({ documentId: a.id, reason: 'has-a-date' }); continue; }
        result.applied++; touched.push(a.id);
        audit.push({ resourceId: a.id, changes: { kind, key, runId, batchId: scope.batchId, undo: { value: w }, by } });
      }
    } else if (kind === 'set-aside-copies') {
      for (const a of analysed) {
        await advisory(db, `import-apply:${a.id}`);
        const orig = a.copyOf ? poolById.get(a.copyOf) : null;
        if (!orig || orig.stage !== 'verified' || a.setAside) { result.skipped.push({ documentId: a.id, reason: 'evidence-changed' }); continue; }
        const ins = await db.raw(
          `INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence, created_at) VALUES (${T}, $1, '${SET_ASIDE_KEY}', $2, 1, NOW()) RETURNING id`, [a.id, orig.id]);
        result.applied++; touched.push(a.id);
        audit.push({ resourceId: a.id, changes: { kind, key, runId, batchId: scope.batchId, undo: { extractionId: ins.rows[0].id }, copyOf: orig.id, by } });
      }
    } else if (kind === 'choose-type') {
      const choice = String(payload.choice ?? '').trim().toLowerCase();
      const [x, y] = key.split('|');
      if (!DOCUMENT_TYPE_IDS.has(choice) || (choice !== x && choice !== y)) throw new ImportError('Choose one of the two types offered', 400);
      for (const a of analysed) {
        await advisory(db, `import-apply:${a.id}`);
        const q = a.typeQuestion;
        if (!q || [q.a, q.b].sort().join('|') !== key || a.humanTyped) { result.skipped.push({ documentId: a.id, reason: 'evidence-changed' }); continue; }
        await db.raw(`UPDATE documents SET document_type = $2 WHERE id = $1 AND tenant_id = ${T}`, [a.id, choice]);
        result.applied++; touched.push(a.id);
        audit.push({ resourceId: a.id, changes: { kind, key, runId, batchId: scope.batchId, undo: { typeBefore: a.type, typeAfter: choice }, by } });
        // the existing "a person chose this type" record, so the automatic re-sort never moves it again
        await bulkAudit(db, actorClerkId, 'review.document_classified', [{ resourceId: a.id, changes: { documentType: choice, via: 'import-decision', runId } }]);
      }
    } else if (kind === 'file-passed') {
      const an = await analyseScope(db, scope, { fresh: true });
      const ids = analysed.filter((a) => a.eligible).map((a) => a.id);
      for (const a of analysed) if (!a.eligible) result.skipped.push({ documentId: a.id, reason: a.verdict?.reason ?? a.blockers[0] ?? 'not-ready' });
      const res = await fileChecked(db, an, ids, { actorClerkId, runId, scope, source: 'click', via: 'click' });
      result.filed = res.filed.length; result.applied = res.filed.length;
      for (const sk of res.skipped) result.skipped.push(sk);
    }
    await bulkAudit(db, actorClerkId, ACTION.decisionApplied, audit);
    analysisCache.delete(cacheKey(db, scope));

    // a paper that now passes every check is filed on the spot (only while the autopilot is on for this import)
    if (kind !== 'file-passed' && touched.length && scopeOn(settings, scope)) {
      const an = await analyseScope(db, scope, { fresh: true });
      const ids = an.docs.filter((x) => x.eligible && touched.includes(x.id)).map((x) => x.id);
      if (ids.length) { const res = await fileChecked(db, an, ids, { actorClerkId, runId, scope, source: 'decision', via: 'decision' }); result.filed = res.filed.length; }
      analysisCache.delete(cacheKey(db, scope));
    }
    return result;
  });
}

/** True while the value a decision wrote is exactly what is stored (nobody typed over it). */
async function valueStillMine(db, v) {
  if (v.kind === 'inserted') return (await db.raw(`SELECT 1 FROM extractions WHERE id = $1 AND tenant_id = ${T} AND value IS NULL AND corrected_value = $2`, [v.extractionId, v.value])).rowCount > 0;
  return (await db.raw(`SELECT 1 FROM extractions WHERE id = $1 AND tenant_id = ${T} AND corrected_value = $2`, [v.extractionId, v.value])).rowCount > 0;
}
async function takeBackValue(db, v) {
  if (v.kind === 'inserted') await db.raw(`DELETE FROM extractions WHERE id = $1 AND tenant_id = ${T} AND value IS NULL AND corrected_value = $2`, [v.extractionId, v.value]);
  else await db.raw(`UPDATE extractions SET corrected_value = NULL, corrected_by = NULL, corrected_at = NULL WHERE id = $1 AND tenant_id = ${T} AND corrected_value = $2`, [v.extractionId, v.value]);
}

/**
 * Undo one decision (all the chunks it was applied in): restores only what the click changed, and only on papers nobody has touched since. A paper a
 * person edited, re-linked, re-typed or checked afterwards is left exactly as it is and reported in `left`. A customer THIS decision created is
 * removed when nothing else points at it. Payload: {batchId|singles, runId, limit?}. Returns {undone, restored, unfiled, left, customersRemoved, more}.
 */
export async function importUndoDecision(ctx, payload = {}, actorClerkId = null) {
  const scope = parseScope(payload);
  const runId = payload.runId;
  if (!isUuid(runId)) throw new ImportError('runId is required', 400);
  const limit = Math.max(1, Math.min(300, Number(payload.limit) || 200));
  return withTenant(ctx, async (db) => {
    const notUndone = (action, undoAction) => `SELECT a.resource_id AS id, a.changes, a.created_at FROM audit_log a
        WHERE a.tenant_id = ${T} AND a.action = '${action}' AND a.changes->>'runId' = $1
          AND NOT EXISTS (SELECT 1 FROM audit_log u WHERE u.tenant_id = a.tenant_id AND u.action = '${undoAction}' AND u.resource_id = a.resource_id AND u.changes->>'runId' = $1)
        ORDER BY a.created_at, a.id LIMIT ${limit}`;
    const applied = (await db.raw(notUndone(ACTION.decisionApplied, ACTION.decisionUndone), [runId])).rows;
    const filedRows = (await db.raw(notUndone(ACTION.autoFiled, ACTION.autoFileUndone), [runId])).rows;
    const left = [];
    // 1. the filing this click caused (newest audit row must still be that filing)
    const fileUndone = [];
    for (const f of filedRows) {
      const newest = (await db.raw(`SELECT action FROM audit_log WHERE resource_id = $1 AND tenant_id = ${T} AND action IN (${JUDGING_ACTIONS_SQL}) ORDER BY created_at DESC, id DESC LIMIT 1`, [f.id])).rows[0]?.action;
      if (newest !== ACTION.autoFiled) { left.push(f.id); continue; }
      const prev = ['read', 'mapped', 'linked'].includes(f.changes?.prevStage) ? f.changes.prevStage : 'linked';
      const u = await db.raw(`UPDATE documents SET stage = $2, verified_by = NULL, verified_at = NULL WHERE id = $1 AND tenant_id = ${T} AND stage = 'verified' AND verified_by = 'ai'`, [f.id, prev]);
      if (u.rowCount) fileUndone.push({ resourceId: f.id, changes: { runId, restoredStage: prev, batchId: scope.batchId } });
    }
    await bulkAudit(db, actorClerkId, ACTION.autoFileUndone, fileUndone);
    // 2. what the click changed
    const restored = [], doneAudit = [];
    for (const r of applied) {
      const u = r.changes?.undo ?? {};
      // anything a person did to this paper after the click (a different run id) means: hands off
      const later = (await db.raw(
        `SELECT 1 FROM audit_log WHERE resource_id = $1 AND tenant_id = ${T} AND created_at > $2
            AND action IN ('review.document_unlinked','review.field_corrected','review.document_classified','review.document_verified')
            AND COALESCE(changes->>'runId', '') <> $3 LIMIT 1`, [r.id, r.created_at, runId])).rowCount;
      if (later) { left.push(r.id); continue; }
      if (u.value && !(await valueStillMine(db, u.value))) { left.push(r.id); continue; }
      if (u.link) {
        const del = await db.raw(`DELETE FROM document_entity_links WHERE document_id = $1 AND entity_id = $2 AND tenant_id = ${T}`, [r.id, u.link]);
        if (del.rowCount) {
          const stillLinked = (await db.raw(`SELECT EXISTS (SELECT 1 FROM document_entity_links WHERE document_id = $1 AND tenant_id = ${T}) AS l`, [r.id])).rows[0].l;
          if (!stillLinked && ['received', 'read', 'mapped'].includes(u.stageBefore)) await db.raw(`UPDATE documents SET stage = $2 WHERE id = $1 AND tenant_id = ${T} AND stage = 'linked'`, [r.id, u.stageBefore]);
        }
      }
      if (u.value) await takeBackValue(db, u.value);
      if (u.extractionId) await db.raw(`DELETE FROM extractions WHERE id = $1 AND tenant_id = ${T} AND field_key = '${SET_ASIDE_KEY}'`, [u.extractionId]);
      if (u.typeBefore) {
        const cur = (await db.raw(`SELECT document_type FROM documents WHERE id = $1 AND tenant_id = ${T}`, [r.id])).rows[0]?.document_type;
        if (normalizeDocumentType(cur) !== u.typeAfter) { left.push(r.id); continue; }
        await db.raw(`UPDATE documents SET document_type = $2 WHERE id = $1 AND tenant_id = ${T}`, [r.id, u.typeBefore]);
        await bulkAudit(db, actorClerkId, 'review.document_classified', [{ resourceId: r.id, changes: { documentType: u.typeBefore, via: 'import-decision-undo', runId } }]);
      }
      restored.push(r.id);
      doneAudit.push({ resourceId: r.id, changes: { runId, kind: r.changes?.kind, batchId: scope.batchId } });
    }
    await bulkAudit(db, actorClerkId, ACTION.decisionUndone, doneAudit);
    // 3. the customer this decision made, when nothing else points at it
    let customersRemoved = 0;
    const more = applied.length === limit || filedRows.length === limit;
    if (!more) {
      const made = (await db.raw(`SELECT resource_id AS id FROM audit_log WHERE tenant_id = ${T} AND action = '${ACTION.customerCreated}' AND changes->>'runId' = $1`, [runId])).rows;
      for (const m of made) {
        const d = await db.raw(
          `DELETE FROM entities e WHERE e.id = $1 AND e.tenant_id = ${T} AND e.entity_type = 'customer'
              AND NOT EXISTS (SELECT 1 FROM document_entity_links l WHERE l.entity_id = e.id)
              AND NOT EXISTS (SELECT 1 FROM extractions x WHERE x.entity_id = e.id)
              AND NOT EXISTS (SELECT 1 FROM entities o WHERE o.customer_id = e.id)`, [m.id]);
        if (d.rowCount) { customersRemoved++; await bulkAudit(db, actorClerkId, ACTION.customerRemoved, [{ resourceId: m.id, changes: { runId } }], 'entity'); }
      }
    }
    analysisCache.delete(cacheKey(db, scope));
    return { undone: restored.length + fileUndone.length, restored: restored.length, unfiled: fileUndone.length, left: left.length, customersRemoved, more };
  });
}

export const __test = { buildDecisions, countsOf, analyseScope, lookReason, scopeOn, fileChecked };
