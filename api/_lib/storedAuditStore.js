/**
 * Docread2 round (2026-10-23): the database half of the READ-ONLY stored-value audit (modelAvoidance/storedAudit.js decides WHAT
 * looks wrong; this file only reads rows and records the verdict).
 *
 *   NEVER writes extractions / facets / documents. A value a person corrected is never judged. No schema change: a flag is one
 *   audit_log row (action 'review.stored_fact_flagged'); a dismissal is another ('review.stored_fact_dismissed'); every run
 *   leaves one count row ('review.stored_fact_audit_run').
 *
 *   DRY RUN BY DEFAULT. Flags are written, and the Inbox shows "Please check this value", only when the OWNER sets the
 *   environment switch STORED_FACT_FLAGS=1 (Vercel project settings). Until then every run only counts, per rule, in its
 *   audit_log run row and in the nightly sweep summary.
 *
 *   auditDocumentTx(db, documentId, opts)   one document inside an open tenant transaction (Re-check calls it after its fill)
 *   auditStoredTenant(ctx, opts)            a bounded, resumable batch of one tenant's documents (nightly sweep + admin button)
 *   listStoredFlags(ctx)                    the flags still standing (not dismissed, not corrected, value unchanged)
 *   dismissStoredFlag(ctx, input, userId)   "this value is fine": stored as an audit row so it is not flagged again
 */
import { withTenant } from "./recordsStore.js";
import { auditStoredFacts, AUDIT_RULE_VERSION } from "./modelAvoidance/storedAudit.js";
import { COMPANY_FOLDER_FIELD_KEY, HR_FOLDER_ID } from "./companyFiles.js";

export const FLAG_ACTION = "review.stored_fact_flagged";
export const DISMISS_ACTION = "review.stored_fact_dismissed";
export const RUN_ACTION = "review.stored_fact_audit_run";
const TENANT = "tenant_id = (current_setting('app.tenant_id', true))::uuid";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUDITED_KEYS = ["customer_name", "vendor", "cost", "start_date", "end_date", "agreement_term"];

/** The owner-run switch: flags are written and shown only when STORED_FACT_FLAGS=1. Default: dry run (counts only). */
export const flagsVisible = (env = process.env) => env?.STORED_FACT_FLAGS === "1" && env?.STORED_FACT_AUDIT !== "0";
/** STORED_FACT_AUDIT=0 turns the audit off entirely (not even counting). */
export const auditEnabled = (env = process.env) => env?.STORED_FACT_AUDIT !== "0";

const keyOf = (docId, f) => `${docId}|${f.field_key}|${f.rule}`;

/** Existing flags / dismissals for these documents: Map(key -> Set of stored values already judged). */
async function judged(db, documentIds) {
  const seen = new Map();
  const dismissed = new Map();
  if (!documentIds.length) return { seen, dismissed };
  const { rows } = await db.raw(
    `SELECT resource_id, action, changes FROM audit_log
      WHERE ${TENANT} AND action IN ('${FLAG_ACTION}', '${DISMISS_ACTION}') AND resource_id = ANY($1::uuid[])`, [documentIds]);
  for (const r of rows) {
    const c = r.changes ?? {};
    if (r.action === FLAG_ACTION && Number(c.rule_version) >= AUDIT_RULE_VERSION) { const k = keyOf(r.resource_id, { field_key: c.field_key, rule: c.rule }); (seen.get(k) ?? seen.set(k, new Set()).get(k)).add(String(c.value)); }
    if (r.action === DISMISS_ACTION) { const k = `${r.resource_id}|${c.field_key}`; (dismissed.get(k) ?? dismissed.set(k, new Set()).get(k)).add(String(c.value)); }
  }
  return { seen, dismissed };
}

/** Pure: which of `flags` are new for this document given what was judged before. */
export function newFlags(documentId, flags, { seen, dismissed }) {
  return flags.filter((f) => !seen.get(keyOf(documentId, f))?.has(f.value) && !dismissed.get(`${documentId}|${f.field_key}`)?.has(f.value));
}

async function loadDoc(db, documentId) {
  const [pages, ex] = await Promise.all([
    db.listPages(documentId),
    db.raw(
      `SELECT e.field_key, e.value, e.corrected_value, f.page_no, f.label_raw AS verbatim
         FROM extractions e LEFT JOIN facets f ON f.id = e.source_facet_id
        WHERE e.document_id = $1::uuid AND e.${TENANT} AND (e.field_key = ANY($2::text[]) OR e.field_key = $3::text)`, [documentId, AUDITED_KEYS, COMPANY_FOLDER_FIELD_KEY]),
  ]);
  const rows = ex.rows ?? [];
  const hr = rows.some((r) => r.field_key === COMPANY_FOLDER_FIELD_KEY && r.value === HR_FOLDER_ID);
  return { pages: pages.map((p) => ({ page_no: p.page_no, text: p.text ?? "" })), fields: rows.filter((r) => r.field_key !== COMPANY_FOLDER_FIELD_KEY), hr };
}

/** One document inside an open tenant transaction. Reads only; writes audit_log rows only when `commit` and the switch is on. */
export async function auditDocumentTx(db, documentId, { commit = false, actorClerkId = null, source = "admin", prior = null } = {}) {
  const { pages, fields, hr } = await loadDoc(db, documentId);
  if (hr || !fields.length) return { documentId, flags: [], written: 0 };
  const flags = auditStoredFacts({ pages, fields });
  if (!flags.length) return { documentId, flags: [], written: 0 };
  const j = prior ?? (await judged(db, [documentId]));
  const fresh = newFlags(documentId, flags, j);
  let written = 0;
  if (commit && flagsVisible()) {
    for (const f of fresh) {
      await db.logAction({
        clerk_user_id: actorClerkId, action: FLAG_ACTION, resource_type: "document", resource_id: documentId,
        changes: { field_key: f.field_key, value: f.value, rule: f.rule, rule_version: AUDIT_RULE_VERSION, reason: f.reason, quote: f.quote, page: f.page, ...(f.expected ? { expected: f.expected } : {}), source },
      });
      written++;
    }
  }
  return { documentId, flags: fresh, written };
}

/**
 * A bounded, resumable batch. `afterId` continues where the last run stopped; when none is given the previous run row's cursor is
 * used, so the nightly sweep walks the whole account over successive nights.
 * @returns {{scanned:number, flagged:number, documentsFlagged:number, byRule:Record<string,number>, written:number, dryRun:boolean, nextAfter:string|null, done:boolean}}
 */
export async function auditStoredTenant(ctx, { limit = 60, afterId = null, commit = false, deadlineAt = Infinity, actorClerkId = null, source = "cron" } = {}) {
  if (!auditEnabled()) return { scanned: 0, flagged: 0, documentsFlagged: 0, byRule: {}, written: 0, dryRun: true, nextAfter: null, done: true, disabled: true };
  const cap = Math.max(1, Math.min(300, Number(limit) || 60));
  const write = commit && flagsVisible();
  return withTenant(ctx, async (db) => {
    let cursor = afterId && UUID_RE.test(afterId) ? afterId : null;
    if (!cursor && afterId == null) {
      const last = await db.raw(`SELECT changes FROM audit_log WHERE ${TENANT} AND action = '${RUN_ACTION}' ORDER BY created_at DESC LIMIT 1`, []);
      const n = last.rows?.[0]?.changes?.next_after;
      cursor = typeof n === "string" && UUID_RE.test(n) ? n : null;
    }
    const { rows: docs } = await db.raw(
      `SELECT d.id FROM documents d
        WHERE d.${TENANT} AND ($1::uuid IS NULL OR d.id > $1::uuid)
          AND EXISTS (SELECT 1 FROM extractions e WHERE e.document_id = d.id AND e.${TENANT} AND e.field_key = ANY($2::text[]))
        ORDER BY d.id LIMIT $3`, [cursor, AUDITED_KEYS, cap]);
    const ids = docs.map((d) => d.id);
    const prior = await judged(db, ids);
    const out = { scanned: 0, flagged: 0, documentsFlagged: 0, byRule: {}, written: 0, dryRun: !write, nextAfter: null, done: false };
    let last = null;
    const runKeys = new Set();
    for (const id of ids) {
      if (Date.now() >= deadlineAt) break;
      out.scanned++; last = id;
      const r = await auditDocumentTx(db, id, { commit: write, actorClerkId, source, prior });
      if (r.flags.length) out.documentsFlagged++;
      for (const f of r.flags) { runKeys.add(`${id}|${f.field_key}|${f.rule}`); out.flagged++; out.byRule[f.rule] = (out.byRule[f.rule] ?? 0) + 1; }
      out.written += r.written;
    }
    // Distinct flags: a dry run flags the same paper again on every pass, so count each (paper, field, rule) once across all passes.
    const keys = [...runKeys];
    const prev = await db.raw(`SELECT changes->'keys' AS k FROM audit_log WHERE ${TENANT} AND action = '${RUN_ACTION}' ORDER BY created_at DESC LIMIT 400`, []);
    const known = new Set();
    for (const r of prev.rows ?? []) for (const k of (Array.isArray(r.k) ? r.k : [])) known.add(k);
    out.newFlags = keys.filter((k) => !known.has(k)).length;
    for (const k of keys) known.add(k);
    out.distinctFlags = known.size;
    out.distinctFlaggedPapers = new Set([...known].map((k) => k.split("|")[0])).size;
    out.done = ids.length < cap && out.scanned === ids.length;
    out.nextAfter = out.done ? null : last;
    await db.logAction({
      clerk_user_id: actorClerkId, action: RUN_ACTION, resource_type: "tenant", resource_id: null,
      changes: { rule_version: AUDIT_RULE_VERSION, source, dry_run: out.dryRun, scanned: out.scanned, flagged: out.flagged, documents_flagged: out.documentsFlagged, by_rule: out.byRule, written: out.written, next_after: out.nextAfter, keys: keys.slice(0, 500), new_flags: out.newFlags, distinct_flags: out.distinctFlags, distinct_flagged_papers: out.distinctFlaggedPapers },
    });
    return out;
  });
}

/** Flags still standing. Empty while the owner switch is off. */
export async function listStoredFlags(ctx) {
  if (!flagsVisible()) return { visible: false, flags: [] };
  return withTenant(ctx, async (db) => {
    const { rows } = await db.raw(
      `SELECT resource_id AS document_id, changes, created_at FROM audit_log
        WHERE ${TENANT} AND action = '${FLAG_ACTION}' ORDER BY created_at DESC LIMIT 3000`, []);
    if (!rows.length) return { visible: true, flags: [] };
    const ids = [...new Set(rows.map((r) => r.document_id))];
    const [dis, cur] = await Promise.all([
      judged(db, ids),
      db.raw(`SELECT document_id, field_key, value, corrected_value FROM extractions WHERE ${TENANT} AND document_id = ANY($1::uuid[]) AND field_key = ANY($2::text[])`, [ids, AUDITED_KEYS]),
    ]);
    const now = new Map();
    for (const e of cur.rows) (now.get(`${e.document_id}|${e.field_key}`) ?? now.set(`${e.document_id}|${e.field_key}`, []).get(`${e.document_id}|${e.field_key}`)).push(e);
    const seen = new Set();
    const flags = [];
    for (const r of rows) {
      const c = r.changes ?? {};
      const k = `${r.document_id}|${c.field_key}|${c.rule}`;
      if (seen.has(k)) continue; seen.add(k);
      const stored = now.get(`${r.document_id}|${c.field_key}`) ?? [];
      // gone once a person corrected it, or the stored value is no longer the one that was flagged
      if (!stored.some((e) => e.corrected_value == null && String(e.value) === String(c.value))) continue;
      if (dis.dismissed.get(`${r.document_id}|${c.field_key}`)?.has(String(c.value))) continue;
      flags.push({ documentId: r.document_id, field: c.field_key, value: c.value, rule: c.rule, reason: c.reason, quote: c.quote ?? null, page: c.page ?? null, expected: c.expected ?? null, flaggedAt: r.created_at });
    }
    return { visible: true, flags };
  });
}

/** "This value is fine." Writes one audit row; changes no value. */
export async function dismissStoredFlag(ctx, { documentId, field, value }, userId = null) {
  if (typeof documentId !== "string" || !UUID_RE.test(documentId) || typeof field !== "string" || !AUDITED_KEYS.includes(field) || value == null) {
    const err = new Error("documentId, field and value are required"); err.status = 400; throw err;
  }
  return withTenant(ctx, async (db) => {
    await db.logAction({ clerk_user_id: userId, action: DISMISS_ACTION, resource_type: "document", resource_id: documentId, changes: { field_key: field, value: String(value), rule_version: AUDIT_RULE_VERSION } });
    return { documentId, field, dismissed: true };
  });
}
