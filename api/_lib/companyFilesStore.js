/**
 * Company Files: the database half (api/_lib/companyFiles.js is the pure half). Called from recordsStore.js's makeStore,
 * which hands in its tenant-scoped transaction client; every statement here carries the tenant predicate as well as RLS,
 * and every value is a bound parameter.
 *
 * No new table and no schema change. Storage used:
 *   - A person's folder choice for one paper: an `extractions` row, field_key '_company_folder' (a synthetic key, like
 *     '_audience'), value = a folder id or 'customer'. One row per document, rewritten by delete-then-insert.
 *   - "Always file {vendor} here" and who may open People and HR: tenants.settings.companyFiles (jsonb, already exists).
 *   - Expiry dates: read from the extraction keys that already carry an end date (EXPIRY_FIELD_KEYS).
 * People and HR is admin-only unless the admin grants more; every listing, count and search here, and the Records browse
 * (hrGateSql, below), leave HR papers out for anyone without access.
 */
import {
  ALWAYS_CUSTOMER_TYPES, COMPANY_FOLDERS, COMPANY_FOLDER_FIELD_KEY, EXPIRY_FIELD_KEYS, HR_FOLDER_ID, OVERRIDE_CUSTOMER,
  applyMoveToSettings, canSeeHr, canonType, checkReasons, companyFolderInfo, copyKey, expiryDateFor, expiryState, folderLabel,
  isFolderId, monthKey, normalizeCompanyFilesSettings, planMove, undoRuleInSettings, vendorKey, visibleFolders, daysBetween,
  COMING_UP_DAYS,
} from './companyFiles.js';
import { documentTypeLabel } from './documentTypes.js';

const TENANT = "tenant_id = (current_setting('app.tenant_id', true))::uuid";
const tenantOf = (alias) => TENANT.replace('tenant_id', `${alias}.tenant_id`);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Stored spellings of types that are always customer paper (canonical ids plus the legacy aliases). */
const CUSTOMER_TYPE_SPELLINGS = [...ALWAYS_CUSTOMER_TYPES, 'maintenance-plan', 'warranty', 'service-report', 'nameplate'];

/** The extraction keys the folder logic and the screen read. */
const FIELD_KEYS = [
  'vendor', 'customer_name', 'service_address', 'job_number', 'job_key', 'work_order_number', 'invoice_number',
  'cost', 'total', 'amount', 'service_date', 'notes', 'status', 'shop_address', 'shop_phone', 'shop_email',
  ...EXPIRY_FIELD_KEYS, COMPANY_FOLDER_FIELD_KEY,
];

const CANDIDATE_CAP = 5000;
const FOLDER_DOC_CAP = 300;
const CHECK_CAP = 100;
const COMING_UP_CAP = 30;
const SEARCH_CAP = 100;

/** `expose`: the message is safe to show the caller (api/records.ts returns it with this status; any other error is a bare 500). */
const httpErr = (status, message) => Object.assign(new Error(message), { status, statusCode: status, expose: true });

/**
 * SQL (WHERE-safe, no parameters) that is TRUE for papers a caller WITHOUT People and HR access may see: it leaves out
 * every paper whose effective folder is People and HR (a saved choice of 'people-hr', or an HR letter nobody moved).
 * AND it into any listing that could return documents. `alias` is a literal table alias chosen by the caller.
 */
export function hrGateSql(alias = 'd') {
  return `(COALESCE(
      (SELECT hx.value FROM extractions hx
        WHERE hx.document_id = ${alias}.id AND hx.tenant_id = ${alias}.tenant_id AND hx.field_key = '${COMPANY_FOLDER_FIELD_KEY}'
        ORDER BY hx.created_at DESC, hx.id DESC LIMIT 1),
      CASE WHEN replace(lower(${alias}.document_type), '_', '-') = 'hr-letter' THEN '${HR_FOLDER_ID}' END,
      '') <> '${HR_FOLDER_ID}')`;
}

/** The same test for a table that carries only a document id (extractions, document_pages): `docIdExpr` is a column such as
 *  'extractions.document_id'. Correlated index lookups, so it costs per row returned, not per document in the shop. */
export function hrDocGate(docIdExpr) {
  return `(COALESCE(
      (SELECT hx.value FROM extractions hx
        WHERE hx.document_id = ${docIdExpr} AND ${tenantOf('hx')} AND hx.field_key = '${COMPANY_FOLDER_FIELD_KEY}'
        ORDER BY hx.created_at DESC, hx.id DESC LIMIT 1),
      (SELECT CASE WHEN replace(lower(hd.document_type), '_', '-') = 'hr-letter' THEN '${HR_FOLDER_ID}' END
         FROM documents hd WHERE hd.id = ${docIdExpr} AND ${tenantOf('hd')}),
      '') <> '${HR_FOLDER_ID}')`;
}

/* ---------------------------------------------------------------------------------------------------- settings */

export async function loadSettings(q) {
  const r = await q(`SELECT settings->'companyFiles' AS cf, name FROM tenants WHERE ${TENANT.replace('tenant_id', 'id')}`, []);
  return { settings: normalizeCompanyFilesSettings(r.rows?.[0]?.cf), companyName: r.rows?.[0]?.name ?? '' };
}

async function saveSettings(q, settings) {
  await q(
    `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('companyFiles', $1::jsonb)
      WHERE ${TENANT.replace('tenant_id', 'id')}`,
    [JSON.stringify({ vendorRules: settings.vendorRules, hrAccess: settings.hrAccess })]
  );
}

/** Whether this caller may open People and HR (one small read; records.ts asks once per request). auth comes from the verified token. */
export async function hrAllowed(q, auth) {
  const { settings } = await loadSettings(q);
  return canSeeHr(auth, settings);
}

/* -------------------------------------------------------------------------------------------------- the papers */

async function loadItems(ctx, settings, companyName, { documentId = null } = {}) {
  const { query, hasDisplayName } = ctx;
  const nameCol = hasDisplayName ? 'd.display_name' : 'NULL::text';
  const overrideExists = `EXISTS (SELECT 1 FROM extractions ox WHERE ox.document_id = d.id AND ${tenantOf('ox')} AND ox.field_key = $2)`;
  const docs = documentId
    ? await query(
      `SELECT d.id, d.original_filename, ${nameCol} AS display_name, d.document_type, d.stage, d.created_at::text AS created_at, d.extract_error,
              EXISTS (SELECT 1 FROM document_entity_links del JOIN entities e ON e.id = del.entity_id AND ${tenantOf('e')} AND e.merged_into IS NULL
                       AND e.entity_type IN ('customer', 'property', 'equipment')
                      WHERE del.document_id = d.id AND ${tenantOf('del')}) AS linked_customer
         FROM documents d WHERE ${tenantOf('d')} AND d.id = $1`,
      [documentId]
    )
    : await query(
      `SELECT d.id, d.original_filename, ${nameCol} AS display_name, d.document_type, d.stage, d.created_at::text AS created_at, d.extract_error,
              EXISTS (SELECT 1 FROM document_entity_links del JOIN entities e ON e.id = del.entity_id AND ${tenantOf('e')} AND e.merged_into IS NULL
                       AND e.entity_type IN ('customer', 'property', 'equipment')
                      WHERE del.document_id = d.id AND ${tenantOf('del')}) AS linked_customer
         FROM documents d
        WHERE ${tenantOf('d')}
          AND ((d.document_type IS NOT NULL AND replace(lower(d.document_type), '_', '-') <> ALL($1::text[])) OR ${overrideExists})
        ORDER BY d.created_at DESC, d.id DESC
        LIMIT ${CANDIDATE_CAP}`,
      [CUSTOMER_TYPE_SPELLINGS, COMPANY_FOLDER_FIELD_KEY]
    );
  const rows = docs.rows ?? [];
  if (!rows.length) return { items: [], truncated: false };

  const ids = rows.map((r) => r.id);
  const fr = await query(
    `SELECT DISTINCT ON (x.document_id, x.field_key) x.document_id, x.field_key, COALESCE(NULLIF(x.corrected_value, ''), x.value) AS value
       FROM extractions x
      WHERE ${tenantOf('x')} AND x.document_id = ANY($1::uuid[]) AND x.field_key = ANY($2::text[])
      ORDER BY x.document_id, x.field_key, x.confidence DESC NULLS LAST, x.id`,
    [ids, FIELD_KEYS]
  );
  const byDoc = new Map();
  for (const r of fr.rows ?? []) {
    if (!byDoc.has(r.document_id)) byDoc.set(r.document_id, {});
    byDoc.get(r.document_id)[r.field_key] = r.value;
  }

  const opts = { vendorRules: settings.vendorRules, companyNames: companyName ? [companyName] : [] };
  const items = [];
  for (const r of rows) {
    const all = byDoc.get(r.id) ?? {};
    const override = all[COMPANY_FOLDER_FIELD_KEY] ?? null;
    const fields = { ...all };
    delete fields[COMPANY_FOLDER_FIELD_KEY];
    const title = r.display_name || r.original_filename || '';
    const info = companyFolderInfo({ type: r.document_type, fields, title, linkedCustomer: !!r.linked_customer, override }, opts);
    if (!info.folder) continue;
    const factCount = Object.values(fields).filter((v) => typeof v === 'string' && v.trim() !== '').length;
    const unreadable = !!r.extract_error || (r.stage !== 'received' && factCount === 0);
    const type = canonType(r.document_type);
    const total = String(fields.cost || fields.total || fields.amount || '').replace(/[^0-9.-]/g, '');
    const amount = total !== '' && Number.isFinite(Number(total)) ? Number(total) : null;
    const dateIso = /^\d{4}-\d{2}-\d{2}/.test(String(fields.service_date ?? '')) ? String(fields.service_date).slice(0, 10) : String(r.created_at ?? '').slice(0, 10);
    items.push({
      id: r.id,
      name: title,
      type,
      typeLabel: documentTypeLabel(type),
      folder: info.folder,
      moved: info.source === 'override',
      vendor: fields.vendor ? String(fields.vendor).trim() : null,
      vendorKey: vendorKey(fields.vendor),
      invoiceNumber: fields.invoice_number ? String(fields.invoice_number).trim() : null,
      amount,
      date: dateIso || null,
      createdAt: String(r.created_at ?? ''),
      expires: expiryDateFor(fields),
      stage: r.stage,
      _info: info,
      _fields: fields,
      _unreadable: unreadable,
    });
  }
  return { items, truncated: rows.length >= CANDIDATE_CAP && !documentId };
}

const byNewest = (a, b) => (b.date ?? '').localeCompare(a.date ?? '') || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);

/** Marks older price lists ("Older") and replaced certificates ("Replaced"), flags likely copies, computes the reasons. */
function decorate(items, todayIso) {
  items.sort(byNewest);
  const seenCopy = new Set();
  const latest = new Map();
  for (const it of items) {
    const ck = copyKey(it.type, it._fields);
    const copy = ck !== '' && seenCopy.has(ck);
    if (ck) seenCopy.add(ck);
    it._copy = copy;
    it.older = false;
    it.replaced = false;
    if (it.type === 'price-list' || it.type === 'insurance-certificate') {
      const gk = `${it.type}|${it.folder}|${it.vendorKey}`;
      if (it.vendorKey && latest.has(gk)) {
        if (it.type === 'price-list') it.older = true; else it.replaced = true;
      } else if (it.vendorKey) latest.set(gk, it.id);
    }
  }
  for (const it of items) {
    it.flags = checkReasons({ type: it.type, fields: it._fields, info: it._info, unreadable: it._unreadable, copy: it._copy });
    it.expiryState = it.replaced || it.older ? null : expiryState(it.expires, todayIso);
    it.daysLeft = it.expires && it.expiryState ? daysBetween(todayIso, it.expires) : null;
  }
  return items;
}

const strip = (it) => {
  const { _info, _fields, _unreadable, _copy, ...rest } = it;
  return rest;
};

const REASON_ORDER = { 'hard-to-read': 0, 'no-total': 1, 'might-be-copy': 2, 'unsure-folder': 3 };
function checkList(items) {
  const flagged = items.filter((i) => i.flags.length);
  flagged.sort((a, b) => Math.min(...a.flags.map((f) => REASON_ORDER[f])) - Math.min(...b.flags.map((f) => REASON_ORDER[f])));
  return { count: flagged.length, items: flagged.slice(0, CHECK_CAP).map(strip) };
}
function comingUpList(items) {
  const up = items.filter((i) => i.expiryState === 'upcoming').sort((a, b) => a.expires.localeCompare(b.expires));
  const gone = items.filter((i) => i.expiryState === 'expired').sort((a, b) => b.expires.localeCompare(a.expires));
  return { count: up.length + gone.length, items: [...up, ...gone].slice(0, COMING_UP_CAP).map(strip) };
}

/**
 * The read side. view: 'home' | 'folder' | 'search'. canHr: may this caller open People and HR (computed by the caller from the
 * verified token, never from the payload). Papers in People and HR are dropped here, before anything is counted or listed.
 */
export async function companyFilesView(ctx, { view = 'home', folder = null, q = null, canHr = false, todayIso }) {
  const { settings, companyName } = await loadSettings(ctx.query);
  const { items: all, truncated } = await loadItems(ctx, settings, companyName);
  const visible = all.filter((i) => canHr || i.folder !== HR_FOLDER_ID);
  decorate(visible, todayIso);
  const folders = visibleFolders(canHr);

  if (view === 'folder') {
    if (!folders.some((f) => f.id === folder)) throw httpErr(404, 'Folder not found');
    const def = COMPANY_FOLDERS.find((f) => f.id === folder);
    const inFolder = visible.filter((i) => i.folder === folder);
    const vendors = new Map();
    const kinds = new Map();
    const months = new Map();
    for (const it of inFolder) {
      if (def.layout === 'vendor') {
        const k = it.vendorKey || '';
        const v = vendors.get(k) ?? { key: k, name: it.vendor || 'No vendor named', count: 0, latest: it.date, older: 0, flagged: 0 };
        v.count++; if (it.older) v.older++; if (it.flags.length) v.flagged++;
        vendors.set(k, v);
      } else if (def.layout === 'kind') {
        const k = kinds.get(it.type) ?? { type: it.type, label: it.typeLabel, count: 0 };
        k.count++; kinds.set(it.type, k);
      } else {
        const m = monthKey(it.date) || 'none';
        months.set(m, (months.get(m) ?? 0) + 1);
      }
    }
    return {
      folder: { id: def.id, label: def.label, layout: def.layout },
      total: inFolder.length,
      docs: inFolder.slice(0, FOLDER_DOC_CAP).map(strip),
      vendors: [...vendors.values()].sort((a, b) => (a.key === '') - (b.key === '') || (b.latest ?? '').localeCompare(a.latest ?? '')),
      kinds: [...kinds.values()].sort((a, b) => b.count - a.count),
      months: [...months.entries()].map(([month, count]) => ({ month, count })).sort((a, b) => b.month.localeCompare(a.month)),
      checkThese: checkList(inFolder),
      comingUp: comingUpList(inFolder),
      truncated,
    };
  }

  if (view === 'search') {
    const needle = String(q ?? '').trim().toLowerCase().slice(0, 200);
    const scoped = folder && isFolderId(folder) ? visible.filter((i) => i.folder === folder) : visible;
    const hits = needle
      ? scoped.filter((i) => `${i.name} ${i.vendor ?? ''} ${i.invoiceNumber ?? ''} ${i.typeLabel} ${folderLabel(i.folder)}`.toLowerCase().includes(needle))
      : [];
    return { q: needle, total: hits.length, docs: hits.slice(0, SEARCH_CAP).map(strip), truncated };
  }

  const counts = folders.map((f) => {
    const inF = visible.filter((i) => i.folder === f.id);
    return { id: f.id, label: f.label, count: inF.length, check: inF.filter((i) => i.flags.length).length };
  });
  return {
    folders: counts,
    total: visible.length,
    comingUp: comingUpList(visible),
    checkThese: checkList(visible),
    windowDays: COMING_UP_DAYS,
    canSeeHr: canHr,
    truncated,
  };
}

/* ----------------------------------------------------------------------------------------------------- writes */

async function writeOverride(q, documentId, value) {
  await q(`DELETE FROM extractions WHERE document_id = $1 AND field_key = $2 AND ${TENANT}`, [documentId, COMPANY_FOLDER_FIELD_KEY]);
  if (value === null) return;
  await q(
    `INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence, created_at)
     VALUES ((current_setting('app.tenant_id', true))::uuid, $1, $2, $3, 1, NOW())`,
    [documentId, COMPANY_FOLDER_FIELD_KEY, value]
  );
}

async function currentOverride(q, documentId) {
  const r = await q(
    `SELECT value FROM extractions WHERE document_id = $1 AND field_key = $2 AND ${TENANT} ORDER BY created_at DESC, id DESC LIMIT 1`,
    [documentId, COMPANY_FOLDER_FIELD_KEY]
  );
  return r.rows?.[0]?.value ?? null;
}

/** A paper's effective folder before a move (null = customer side), plus its vendor. */
async function describe(ctx, settings, companyName, documentId) {
  const { items } = await loadItems(ctx, settings, companyName, { documentId });
  const it = items[0];
  if (it) return { folder: it.folder, vendor: it.vendor };
  // Not a company file today (customer paper): still its type/vendor for the vendor rule.
  const r = await ctx.query(`SELECT 1 FROM documents WHERE id = $1 AND ${TENANT}`, [documentId]);
  if (!r.rows?.length) return null;
  const f = await ctx.query(
    `SELECT COALESCE(NULLIF(corrected_value, ''), value) AS value FROM extractions WHERE document_id = $1 AND field_key = 'vendor' AND ${TENANT}
      ORDER BY confidence DESC NULLS LAST, id LIMIT 1`,
    [documentId]
  );
  return { folder: null, vendor: f.rows?.[0]?.value ?? null };
}

/**
 * Move one paper. Returns what Undo needs. `to`: a folder id, or 'customer'. People and HR needs `canHr` both ways (into it
 * and out of it). "Always file {vendor} here" (alwaysFile, default on) is remembered in tenants.settings.companyFiles.
 */
export async function moveCompanyFile(ctx, { documentId, to, alwaysFile = true, canHr = false }) {
  if (typeof documentId !== 'string' || !UUID_RE.test(documentId)) throw httpErr(400, 'documentId must be a uuid');
  const { settings, companyName } = await loadSettings(ctx.query);
  const now = await describe(ctx, settings, companyName, documentId);
  if (!now) throw httpErr(404, 'Document not found');
  // A caller who cannot see People and HR is told "not found", the same as for any paper they cannot see.
  if (now.folder === HR_FOLDER_ID && !canHr) throw httpErr(404, 'Document not found');
  const plan = planMove({ to, alwaysFile }, { vendor: now.vendor, canHr, currentFolder: now.folder });
  if (!plan.ok) throw httpErr(plan.error === 'Unknown folder' ? 400 : 403, plan.error);
  const previousOverride = await currentOverride(ctx.query, documentId);
  await writeOverride(ctx.query, documentId, plan.override);
  const applied = applyMoveToSettings(settings, plan);
  if (applied.ruleKey) await saveSettings(ctx.query, applied.settings);
  return {
    documentId,
    to: plan.override,
    toLabel: plan.override === OVERRIDE_CUSTOMER ? 'a customer' : folderLabel(plan.override),
    previousOverride,
    vendor: now.vendor,
    ruleKey: applied.ruleKey,
    previousRule: applied.previousRule,
    ruleFolder: plan.rule?.folder ?? null,
  };
}

/** Undo a move: restore the saved choice (or none) and the vendor rule, unless the rule has been changed since. */
export async function undoCompanyFileMove(ctx, { documentId, previousOverride = null, ruleKey = null, previousRule = null, ruleFolder = null, canHr = false }) {
  if (typeof documentId !== 'string' || !UUID_RE.test(documentId)) throw httpErr(400, 'documentId must be a uuid');
  const prev = previousOverride == null ? null : String(previousOverride);
  if (prev !== null && prev !== OVERRIDE_CUSTOMER && !isFolderId(prev)) throw httpErr(400, 'Unknown folder');
  const { settings, companyName } = await loadSettings(ctx.query);
  const now = await describe(ctx, settings, companyName, documentId);
  if (!now) throw httpErr(404, 'Document not found');
  if ((now.folder === HR_FOLDER_ID || prev === HR_FOLDER_ID) && !canHr) throw httpErr(404, 'Document not found');
  await writeOverride(ctx.query, documentId, prev);
  if (ruleKey && typeof ruleKey === 'string' && settings.vendorRules[ruleKey] === ruleFolder) {
    await saveSettings(ctx.query, undoRuleInSettings(settings, ruleKey, previousRule == null ? null : String(previousRule)));
  }
  return { documentId, restored: prev };
}

/** Admin only (the caller enforces it): who besides admins may open People and HR. */
export async function setHrAccess(ctx, { roles = [], members = [] }) {
  const { settings } = await loadSettings(ctx.query);
  const next = normalizeCompanyFilesSettings({ vendorRules: settings.vendorRules, hrAccess: { roles, members } });
  await saveSettings(ctx.query, next);
  return { hrAccess: next.hrAccess };
}

export async function readHrAccess(ctx) {
  const { settings } = await loadSettings(ctx.query);
  return { hrAccess: settings.hrAccess };
}
