/**
 * Job costing (M3-config/36-job-costing.sql) — groups money documents by JOB (the
 * property/service address a job was done at) so Donovan can total revenue against
 * cost per job and answer margin questions.
 *
 * job_key resolution, in priority order, per document_financials row:
 *   1. the stored job_key (extract.js captured a printed job/service address at
 *      extraction time, or the backfill below read one from stored page text) —
 *      used only when its job_confidence is at or above JOB_MATCH_CONFIDENCE.
 *   2. the customer linked to the document's own on-file service address (already
 *      stored — no OCR, no model call).
 *   3. a live regex read of the document's stored page-1 text for a "For job at:" /
 *      "Service address:" / "Job address:" line (same regex the backfill uses).
 * A document that resolves no address at any of these, or resolves one below
 * JOB_MATCH_CONFIDENCE, is reported as UNMATCHED — never grouped, never guessed.
 *
 * Grouping math is done on integer cents (parseCents/centsToString — the same
 * technique normalize.js's own arithmetic checks use), never JS floating point;
 * every printed total that goes into a sum still comes straight from the exact
 * NUMERIC(12,2) column (corrections already applied), same as every other answer
 * in this layer.
 *
 * Tolerant of migration 36 not being pasted: jobCostingColumnsExist() probes
 * information_schema.columns (mirrors store.js's financialsTableExists) and the
 * fallback (2 + 3 above) computes the same groups without the columns, at a lower
 * confidence — so this feature works before AND after the owner pastes the SQL.
 *
 * No question text, amounts or names are ever logged here.
 */
import { parseCents, centsToString } from './normalize.js';
import { JOB_MATCH_CONFIDENCE, extractJobReference, normalizeJobKey, jobKeyParts, jobKeyFromText } from './jobKey.js';

export { JOB_MATCH_CONFIDENCE, extractJobReference, normalizeJobKey };

const TENANT = "(current_setting('app.tenant_id', true))::uuid";
const NEGATIVE_TTL_MS = 30_000;

let jobColsKnown = null;
export function _resetJobCostingProbe() { jobColsKnown = null; }

/** Does document_financials have the migration-36 columns? Memoized like financialsTableExists. */
export async function jobCostingColumnsExist(db) {
  if (jobColsKnown === true) return true;
  if (jobColsKnown && jobColsKnown.falseUntil > Date.now()) return false;
  try {
    const r = await db.raw(
      "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'document_financials' AND column_name = 'job_key') AS ok",
      []
    );
    const ok = Boolean(r.rows[0]?.ok);
    jobColsKnown = ok ? true : { falseUntil: Date.now() + NEGATIVE_TTL_MS };
    return ok;
  } catch {
    return false; // a transient failure is never memoized
  }
}

/** The doc_kind/direction combinations that count as a job's revenue or cost (same semantics
 *  answers.js's REVENUE_WHERE / payables_open already use — never estimates/agreements). */
const REVENUE_SCOPE = `f.direction = 'receivable' AND f.doc_kind IN ('invoice', 'credit_memo')`;
const COST_SCOPE = `f.direction = 'payable'`;

/** Effective (corrected-over-original) value of one document_financials column, as text. */
const eff = (col) => `(CASE WHEN f.corrections ? '${col}' THEN NULLIF(f.corrections->>'${col}', '') ELSE f.${col}::text END)`;

async function fetchJobRows(db, { hasCols, from, to }) {
  const jobCols = hasCols
    ? `f.job_key, f.job_key_source, f.job_confidence, f.job_raw,`
    : `NULL::text AS job_key, NULL::text AS job_key_source, NULL::numeric AS job_confidence, NULL::text AS job_raw,`;
  const dateFilter = from || to ? `AND ${eff('invoice_date')}::date BETWEEN COALESCE($1::date, '0001-01-01') AND COALESCE($2::date, '9999-12-31')` : '';
  const params = from || to ? [from ?? null, to ?? null] : [];
  const r = await db.raw(
    `SELECT f.document_id, f.doc_kind, f.direction, f.invoice_number, f.po_number, f.customer_name, f.vendor_name,
            ${eff('total')} AS total, ${eff('invoice_date')}::date AS invoice_date,
            ${jobCols}
            d.original_filename AS filename,
            ce.customer_address, ce.customer_entity_id
       FROM document_financials f
       JOIN documents d ON d.id = f.document_id AND d.tenant_id = f.tenant_id
       LEFT JOIN LATERAL (
         SELECT c.id AS customer_entity_id, c.data->>'service_address' AS customer_address
           FROM document_entity_links l
           JOIN entities en ON en.id = l.entity_id AND en.merged_into IS NULL AND en.tenant_id = f.tenant_id
           JOIN entities c ON c.id = CASE WHEN en.entity_type = 'customer' THEN en.id ELSE en.customer_id END
                            AND c.entity_type = 'customer' AND c.merged_into IS NULL AND c.tenant_id = f.tenant_id
          WHERE l.document_id = f.document_id AND l.tenant_id = f.tenant_id
          ORDER BY l.created_at DESC LIMIT 1
       ) ce ON true
      WHERE f.tenant_id = ${TENANT} AND ((${REVENUE_SCOPE}) OR (${COST_SCOPE})) AND ${eff('total')} IS NOT NULL
        AND f.currency = 'USD'
        ${dateFilter}
      ORDER BY f.document_id`,
    params
  );
  return r.rows;
}

/** Count of job-relevant (revenue/cost scope) documents excluded from job costing purely
 *  because they're in another currency — same `f.currency = 'USD'` scoping answers.js's
 *  REVENUE_WHERE uses, and the same "never silently drop a document" disclosure pattern as
 *  the rest of this layer (exclusionText). */
async function countExcludedCurrency(db, { from, to }) {
  const dateFilter = from || to ? `AND ${eff('invoice_date')}::date BETWEEN COALESCE($1::date, '0001-01-01') AND COALESCE($2::date, '9999-12-31')` : '';
  const params = from || to ? [from ?? null, to ?? null] : [];
  const r = await db.raw(
    `SELECT count(*)::int AS n FROM document_financials f
      WHERE f.tenant_id = ${TENANT} AND ((${REVENUE_SCOPE}) OR (${COST_SCOPE}))
        AND ${eff('total')} IS NOT NULL AND f.currency <> 'USD' ${dateFilter}`,
    params
  );
  return r.rows[0]?.n ?? 0;
}

async function fetchPage1Text(db, documentIds) {
  if (!documentIds.length) return new Map();
  const r = await db.raw(
    `SELECT document_id, text FROM document_pages WHERE document_id = ANY($1::uuid[]) AND page_no = 1 AND tenant_id = ${TENANT}`,
    [documentIds]
  );
  return new Map(r.rows.map((x) => [x.document_id, x.text]));
}

/**
 * One row's effective job key + source + confidence, from an address text, at a query-time
 * (never-stored) source. Prefers house+street+unit+CITY when the text prints a city; when it
 * doesn't, the key is a bare house+street(+unit) `core` — NOT safe to group on by itself (see
 * `needsElevation` below), because a bare core collides across different cities/customers.
 */
function candidateFromAddress(addressText, source, confidentBase) {
  const parts = jobKeyParts(addressText);
  if (!parts) return null;
  const hasLocality = Boolean(parts.locality);
  return {
    key: parts.full, core: parts.core, source, raw: addressText,
    confidence: hasLocality ? confidentBase : Math.min(confidentBase, JOB_MATCH_CONFIDENCE - 0.1),
    needsElevation: !hasLocality,
  };
}

/**
 * One row's effective job key + source + confidence. Prefers a stored key at or above
 * JOB_MATCH_CONFIDENCE, then the customer's on-file address, then a page-text regex read.
 * A stored key BELOW JOB_MATCH_CONFIDENCE is kept as a last resort ("weak") only so the caller
 * can report it honestly as "too uncertain to link automatically" — never used to group a job.
 *
 * A customer_address/page_text candidate whose printed text has NO city on it comes back with
 * `needsElevation: true` and a confidence already below JOB_MATCH_CONFIDENCE — computeJobCosts'
 * second pass is the only thing allowed to raise it (by confirming the SAME customer entity
 * behind a confident, city-bearing job at the same house+street+unit); on its own, a bare
 * "123 Main St" is never enough to merge two documents that might belong to different jobs.
 */
function resolveRowKey(row, page1Text) {
  let weak = null;
  if (row.job_key) {
    // A stored key's OWN raw text is re-checked for a printed city too — this covers a bare
    // key written at extraction time (the model reported high confidence in the ADDRESS, which
    // says nothing about whether it also had enough of it to be unique) the same way a bare
    // customer_address/page_text candidate is covered below. No raw text on file at all (older
    // rows, or one that never parsed as a street address) is left exactly as stored.
    const storedParts = row.job_raw ? jobKeyParts(row.job_raw) : null;
    const bare = Boolean(storedParts) && !storedParts.locality;
    const confidence = bare ? Math.min(Number(row.job_confidence ?? 1), JOB_MATCH_CONFIDENCE - 0.1) : Number(row.job_confidence ?? 1);
    const resolved = { key: row.job_key, source: row.job_key_source ?? 'extracted', confidence, raw: row.job_raw ?? null, core: storedParts?.core ?? null, needsElevation: bare };
    if (confidence >= JOB_MATCH_CONFIDENCE) return resolved;
    weak = resolved;
  }
  if (row.customer_address) {
    const cand = candidateFromAddress(row.customer_address, 'customer_address', 0.6);
    if (cand) return cand;
  }
  const ref = extractJobReference(page1Text ?? '');
  if (ref) {
    const cand = candidateFromAddress(ref.address, 'page_text', 0.55);
    if (cand) return cand;
  }
  return weak ?? { key: null, source: null, confidence: 0, raw: null, core: null, needsElevation: false };
}

const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? null : String(v).slice(0, 10));

function docRefOf(row, cents) {
  return {
    documentId: row.document_id, docKind: row.doc_kind, direction: row.direction, filename: row.filename,
    invoiceNumber: row.invoice_number, poNumber: row.po_number, customerName: row.customer_name, vendorName: row.vendor_name,
    invoiceDate: ymd(row.invoice_date), total: centsToString(cents),
  };
}

/**
 * Every job-relevant document (customer invoice/credit memo = revenue; payable
 * PO/vendor invoice = cost) grouped by job, tenant-scoped, human corrections applied.
 * @param {{from?: string, to?: string}} opts  from/to are inclusive YYYY-MM-DD invoice-date
 *   bounds (a period, like the rest of this layer).
 * @returns {Promise<{jobs: Array, unmatched: Array, hasJobColumns: boolean, excludedCurrency: number}>}
 */
export async function computeJobCosts(db, { from = null, to = null } = {}) {
  const hasCols = await jobCostingColumnsExist(db);
  const rows = await fetchJobRows(db, { hasCols, from, to });
  const excludedCurrency = await countExcludedCurrency(db, { from, to });
  const needText = rows
    .filter((r) => !(r.job_key && Number(r.job_confidence ?? 1) >= JOB_MATCH_CONFIDENCE) && !r.customer_address)
    .map((r) => r.document_id);
  const textById = await fetchPage1Text(db, needText);

  // Pass 1: resolve every row's naive candidate key on its own.
  const resolved = rows.map((row) => ({ row, cents: row.total == null ? null : parseCents(row.total), cand: resolveRowKey(row, textById.get(row.document_id)) }));

  // Pass 2: a bare (no-city) candidate is trustworthy ONLY when the SAME customer entity also
  // sits behind a confident, city-bearing job at the same house+street(+unit) core — never on
  // the bare address text alone. Build that lookup from every row that already resolved with a
  // city AND a linked customer entity, then try to elevate every bare candidate through it.
  const confidentByCore = new Map(); // core -> Map<customerEntityId, fullKey>
  for (const { row, cand } of resolved) {
    if (cand.core && cand.confidence >= JOB_MATCH_CONFIDENCE && row.customer_entity_id) {
      let m = confidentByCore.get(cand.core);
      if (!m) { m = new Map(); confidentByCore.set(cand.core, m); }
      if (!m.has(row.customer_entity_id)) m.set(row.customer_entity_id, cand.key);
    }
  }
  for (const r of resolved) {
    if (r.cand.needsElevation && r.cand.core && r.row.customer_entity_id) {
      const elevated = confidentByCore.get(r.cand.core)?.get(r.row.customer_entity_id);
      if (elevated) r.cand = { ...r.cand, key: elevated, confidence: Math.max(r.cand.confidence, JOB_MATCH_CONFIDENCE) };
    }
  }

  const groups = new Map();
  const unmatched = [];
  for (const { row, cents, cand } of resolved) {
    const { key, source, confidence, raw } = cand;
    if (cents == null || !key || confidence < JOB_MATCH_CONFIDENCE) {
      unmatched.push({
        ...docRefOf(row, cents ?? 0), total: cents == null ? null : centsToString(cents),
        reason: cents == null ? 'no printed total' : !key ? 'no job address found on file for this document' : 'the job address match was too uncertain to link automatically',
      });
      continue;
    }
    let g = groups.get(key);
    if (!g) { g = { jobKey: key, addressSample: raw, revenueCents: 0, costCents: 0, revenueDocs: [], costDocs: [], sources: new Set() }; groups.set(key, g); }
    g.sources.add(source);
    if (!g.addressSample && raw) g.addressSample = raw;
    const isRevenue = row.direction === 'receivable' && (row.doc_kind === 'invoice' || row.doc_kind === 'credit_memo');
    const ref = docRefOf(row, cents);
    if (isRevenue) { g.revenueCents += cents; g.revenueDocs.push(ref); } else { g.costCents += cents; g.costDocs.push(ref); }
  }

  const jobs = [...groups.values()].map((g) => {
    const marginCents = g.revenueCents - g.costCents;
    const hasRevenue = g.revenueDocs.length > 0;
    const hasCost = g.costDocs.length > 0;
    return {
      jobKey: g.jobKey, address: g.addressSample, sources: [...g.sources],
      revenue: centsToString(g.revenueCents), cost: centsToString(g.costCents), marginDollars: centsToString(marginCents),
      marginPercent: hasRevenue && hasCost && g.revenueCents !== 0 ? Math.round((marginCents / g.revenueCents) * 10000) / 100 : null,
      hasRevenue, hasCost, revenueDocs: g.revenueDocs, costDocs: g.costDocs,
    };
  });
  return { jobs, unmatched, hasJobColumns: hasCols, excludedCurrency };
}

/** The job_key a question's own embedded address resolves to, or null (no address in the text). */
export function jobKeyFromQuestionAddress(question) {
  return jobKeyFromText(question);
}

/**
 * Find the one job an address phrase means, tolerant of the phrase printing no city (a question
 * like "the job at 412 Elm St, Mesa?" has no state code, so it resolves no `locality` at all).
 *   - the phrase resolves a city -> exact key match only (never guessed across cities).
 *   - the phrase is bare (house+street+unit only) -> matches by CORE, but only when exactly one
 *     job on file shares that core; more than one (the same street in different cities/units) is
 *     never guessed at — treated the same as "not found" so the caller asks to be more specific
 *     rather than silently picking one.
 * @returns {object|null} the matching job from computeJobCosts' `jobs`, or null.
 */
export function findJobForAddress(jobs, addressText) {
  const parts = jobKeyParts(addressText);
  if (!parts) return null;
  if (parts.locality) return jobs.find((j) => j.jobKey === parts.full) ?? null;
  const candidates = jobs.filter((j) => j.jobKey === parts.core || j.jobKey.startsWith(`${parts.core}-`));
  return candidates.length === 1 ? candidates[0] : null;
}

/* ================================================================== backfill (job_key only) */
/*
 * Populates job_key on document_financials rows extracted BEFORE this feature existed, from
 * data already stored on disk — the linked customer's on-file service address, or a regex
 * read of the document's own stored page-1 text. No model call, no re-OCR: this is pure
 * JS/SQL work, so unlike runFinancialsBackfill (extract.js's per-document model call) there is
 * no per-document dollar cost — the batch/deadline caps below exist to keep one call bounded
 * on a large table, not to protect a model budget.
 */

/** document_financials rows (money-relevant kinds) with no job_key yet, never a human-reviewed
 *  row (same "never overwrite a person's work" rule upsertFinancials already applies), oldest
 *  document id first — same keyset paging store.js's listBackfillCandidates uses. */
export async function listJobKeyCandidates(db, { afterId = null, limit = 200 } = {}) {
  if (!(await jobCostingColumnsExist(db))) return [];
  const r = await db.raw(
    `SELECT f.document_id AS id
       FROM document_financials f
      WHERE f.tenant_id = ${TENANT} AND f.job_key IS NULL
        AND f.corrections = '{}'::jsonb AND f.verified_by IS NULL
        AND ((${REVENUE_SCOPE}) OR (${COST_SCOPE}))
        AND ($1::uuid IS NULL OR f.document_id > $1::uuid)
      ORDER BY f.document_id LIMIT $2`,
    [afterId, Math.max(1, Math.min(500, limit))]
  );
  return r.rows;
}

/** {eligible, done, remaining} for the job-key backfill status line. */
export async function jobKeyBackfillCounts(db) {
  if (!(await jobCostingColumnsExist(db))) return { enabled: false, eligible: 0, done: 0, remaining: 0 };
  const r = await db.raw(
    `SELECT count(*)::int AS eligible, count(*) FILTER (WHERE f.job_key IS NOT NULL)::int AS done
       FROM document_financials f WHERE f.tenant_id = ${TENANT} AND ((${REVENUE_SCOPE}) OR (${COST_SCOPE}))`,
    []
  );
  const { eligible, done } = r.rows[0];
  return { enabled: true, eligible, done, remaining: eligible - done };
}

/**
 * Resolve + store ONE document_financials row's job_key. Never touches a row a person has
 * corrected or verified (same rule as extraction). Returns what happened, never throws for a
 * document with no resolvable address (that is a normal, honest outcome, not a failure).
 */
export async function backfillOneJobKey(db, documentId) {
  const row = (await db.raw(
    `SELECT f.id, f.corrections, f.verified_by,
            (SELECT c.data->>'service_address'
               FROM document_entity_links l
               JOIN entities en ON en.id = l.entity_id AND en.merged_into IS NULL AND en.tenant_id = f.tenant_id
               JOIN entities c ON c.id = CASE WHEN en.entity_type = 'customer' THEN en.id ELSE en.customer_id END
                                AND c.entity_type = 'customer' AND c.merged_into IS NULL AND c.tenant_id = f.tenant_id
              WHERE l.document_id = f.document_id AND l.tenant_id = f.tenant_id
              ORDER BY l.created_at DESC LIMIT 1) AS customer_address
       FROM document_financials f WHERE f.document_id = $1 AND f.tenant_id = ${TENANT}`,
    [documentId]
  )).rows[0];
  if (!row) return { updated: false, reason: 'not_found' };
  if ((row.corrections && Object.keys(row.corrections).length) || row.verified_by) return { updated: false, reason: 'human_reviewed' };

  // Same candidateFromAddress rule the live query path uses: a bare (no printed city) address
  // is stored at a confidence below JOB_MATCH_CONFIDENCE, so it is never treated as a safe
  // group-on-its-own key until (if ever) a read-time customer-entity match elevates it.
  let cand = row.customer_address ? candidateFromAddress(row.customer_address, 'customer_address', 0.6) : null;
  if (!cand) {
    const page = (await db.raw(
      `SELECT text FROM document_pages WHERE document_id = $1 AND page_no = 1 AND tenant_id = ${TENANT}`, [documentId]
    )).rows[0];
    const ref = extractJobReference(page?.text ?? '');
    cand = ref ? candidateFromAddress(ref.address, 'page_text', 0.55) : null;
  }
  if (!cand) return { updated: false, reason: 'no_address_found' };
  await db.raw('UPDATE document_financials SET job_key = $2, job_key_source = $3, job_confidence = $4::numeric, job_raw = $5 WHERE id = $1', [row.id, cand.key, cand.source, cand.confidence, cand.raw]);
  return { updated: true, jobKey: cand.key, source: cand.source, confidence: cand.confidence, raw: cand.raw };
}

/**
 * One backfill batch over `db` (already inside the caller's tenant transaction) — batched
 * with a deadline so one call on a large table stays bounded. See backfill.js's
 * runJobKeyBackfill for the tenant-wrapped, UI-facing entry point.
 */
export async function runJobKeyBackfillBatch(db, { afterId = null, limit = 200, deadlineMs = 20_000 } = {}) {
  if (!(await jobCostingColumnsExist(db))) {
    return { enabled: false, processed: 0, updated: 0, remaining: 0, eligible: 0, nextCursor: null, stoppedReason: 'columns_missing' };
  }
  const candidates = await listJobKeyCandidates(db, { afterId, limit });
  const deadlineAt = Date.now() + Math.max(1000, Number(deadlineMs) || 20_000);
  let processed = 0;
  let updated = 0;
  let cursor = afterId;
  let stoppedReason = null;
  for (const c of candidates) {
    if (Date.now() > deadlineAt) { stoppedReason = 'deadline'; break; }
    const r = await backfillOneJobKey(db, c.id);
    processed++;
    if (r.updated) updated++;
    if (cursor == null || c.id > cursor) cursor = c.id;
  }
  const counts = await jobKeyBackfillCounts(db);
  return {
    enabled: true, processed, updated, eligible: counts.eligible, remaining: counts.remaining,
    nextCursor: candidates.length ? cursor : null,
    stoppedReason: stoppedReason ?? (candidates.length === 0 ? 'done' : 'batch_complete'),
  };
}
