/**
 * AI finish, rev3: field SUGGESTIONS.
 *
 * A value Claude quoted for real but that failed only the label binding or the issuer-zone check (or a numeric date that could be read two
 * ways) is never stored as a fact. It is kept as an audit_log row, exactly the way the R6 "Link to <customer>?" suggestions are, so Donovan,
 * search and exports (which read extractions, not audit rows) never see it:
 *
 *   ai_finish.suggestion           {key, field_key, value | options[], quote, page_no, reason}         one row per suggestion
 *   ai_finish.suggestion_resolved  {key, field_key, state: 'accepted' | 'dismissed', value?, edited?}  clears it for good
 *
 * Live = the newest suggestion per (paper, field) whose key has no resolved row and whose field the paper still lacks. A dismissed or accepted
 * key is never suggested again. Accept (or Edit, which is Accept with the person's own text) writes the fact through the same person path
 * as typing it (reviewStore.correctField), so it is a person-entered value from then on.
 */
import { withTenant } from "./recordsStore.js";
import { baseKeyOf } from "./extractFields.js";
import { fieldLabel } from "./documentTypes.js";

export const SUGGEST_ACTION = "ai_finish.suggestion";
export const RESOLVED_ACTION = "ai_finish.suggestion_resolved";
/** Written only when an Accept's write failed after its claim: gives the key back so the person can try again. */
export const RELEASED_ACTION = "ai_finish.suggestion_released";
const TENANT = "tenant_id = (current_setting('app.tenant_id', true))::uuid";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class SuggestionError extends Error {
  constructor(message, status = 400) { super(message); this.name = "SuggestionError"; this.status = status; }
}

/** Stable identity of a suggestion: the field plus the value (or the sorted readings of an ambiguous date). */
export function suggestionKey(s) {
  const vals = Array.isArray(s.options) && s.options.length ? [...s.options].map(String).sort() : [String(s.value ?? "")];
  return `${baseKeyOf(s.field_key)}|${vals.join(",").toLowerCase().replace(/\s+/g, " ").trim()}`;
}

/** Keys with a live resolution: a resolved row not followed by a later release. Rows in any order. */
function resolvedKeys(rows) {
  const sorted = [...rows].filter((r) => r.action === RESOLVED_ACTION || r.action === RELEASED_ACTION)
    .sort((a, b) => new Date(a.created_at ?? 0).getTime() - new Date(b.created_at ?? 0).getTime());
  const out = new Set();
  for (const r of sorted) { if (r.action === RESOLVED_ACTION) out.add(r.changes?.key); else out.delete(r.changes?.key); }
  return out;
}

const present = (rows, base) => rows.some((r) => baseKeyOf(r.field_key) === base && String(r.corrected_value ?? r.value ?? "").trim() !== "");

/**
 * Inside the caller's transaction: write the suggestions that are new. Skips a field the paper now has, a key a person already
 * accepted or dismissed, and one that is already open. Returns the suggestions written.
 */
export async function storeSuggestions(db, documentId, suggestions, { actorClerkId = null, rowsNow = null } = {}) {
  const written = [];
  if (!suggestions?.length) return written;
  const rows = rowsNow ?? (await db.listExtractionsByDocument(documentId));
  const prior = (await db.raw(
    `SELECT action, changes, created_at FROM audit_log WHERE resource_id = $1::uuid AND ${TENANT} AND action IN ('${SUGGEST_ACTION}', '${RESOLVED_ACTION}', '${RELEASED_ACTION}')`, [documentId])).rows;
  const resolved = resolvedKeys(prior);
  const open = new Set(prior.filter((r) => r.action === SUGGEST_ACTION).map((r) => r.changes?.key));
  for (const s of suggestions) {
    const base = baseKeyOf(s.field_key);
    const key = suggestionKey(s);
    if (present(rows, base) || resolved.has(key) || open.has(key)) continue;
    open.add(key);
    const changes = {
      key, field_key: base, quote: String(s.quote ?? "").slice(0, 300), page_no: s.page_no ?? null, reason: s.reason,
      ...(s.options?.length ? { options: s.options.slice(0, 2) } : { value: String(s.value).slice(0, 300) }),
    };
    await db.logAction({ clerk_user_id: actorClerkId, action: SUGGEST_ACTION, resource_type: "document", resource_id: documentId, changes });
    written.push({ ...changes });
  }
  return written;
}

/** Open suggestions for these papers (newest per field, minus resolved, minus fields the paper has since got). */
export async function listFieldSuggestions(ctx, { documentIds }) {
  const ids = (Array.isArray(documentIds) ? documentIds : []).filter((x) => typeof x === "string" && UUID_RE.test(x)).slice(0, 500);
  if (!ids.length) return { suggestions: [] };
  return withTenant(ctx, async (db) => {
    const audit = (await db.raw(
      `SELECT resource_id AS document_id, action, changes, created_at FROM audit_log
        WHERE resource_id = ANY($1::uuid[]) AND ${TENANT} AND action IN ('${SUGGEST_ACTION}', '${RESOLVED_ACTION}', '${RELEASED_ACTION}')
        ORDER BY created_at DESC`, [ids])).rows;
    if (!audit.some((r) => r.action === SUGGEST_ACTION)) return { suggestions: [] };
    const facts = (await db.raw(
      `SELECT document_id, field_key, value, corrected_value FROM extractions WHERE document_id = ANY($1::uuid[]) AND ${TENANT}`, [ids])).rows;
    const out = [];
    const seen = new Set();
    const cacheR = new Map();
    const resolvedByDoc = (id) => { if (!cacheR.has(id)) cacheR.set(id, resolvedKeys(audit.filter((x) => x.document_id === id))); return cacheR.get(id); };
    for (const r of audit) {
      if (r.action !== SUGGEST_ACTION) continue;
      const c = r.changes ?? {};
      const slot = `${r.document_id}|${c.field_key}`;
      if (seen.has(slot)) continue; // newest per field
      seen.add(slot);
      if (resolvedByDoc(r.document_id).has(c.key)) continue;
      if (present(facts.filter((f) => f.document_id === r.document_id), c.field_key)) continue;
      out.push({
        document_id: r.document_id, key: c.key, field_key: c.field_key, label: fieldLabel(c.field_key) || c.field_key,
        ...(Array.isArray(c.options) && c.options.length ? { options: c.options } : { value: c.value }),
        quote: c.quote ?? "", page_no: c.page_no ?? null,
      });
    }
    return { suggestions: out };
  });
}

async function findOpen(ctx, documentId, key) {
  const { suggestions } = await listFieldSuggestions(ctx, { documentIds: [documentId] });
  const s = suggestions.find((x) => x.key === key);
  if (!s) throw new SuggestionError("That suggestion is no longer open.", 404);
  return s;
}

/**
 * ATOMIC claim of a suggestion's resolution: under an advisory lock on (paper, key) the resolved row is written only if the key is not already
 * resolved, so of any number of simultaneous Accepts / Dismisses exactly one wins and the rest get "no longer open".
 */
async function claimResolution(ctx, { documentId, key, field_key, state, value, edited }, actorClerkId) {
  return withTenant(ctx, async (db) => {
    await db.raw("SELECT pg_advisory_xact_lock(hashtext($1))", [`aifinish-sug:${documentId}:${key}`]);
    const rows = (await db.raw(
      `SELECT action, changes, created_at FROM audit_log WHERE resource_id = $1::uuid AND ${TENANT} AND action IN ('${RESOLVED_ACTION}', '${RELEASED_ACTION}')`, [documentId])).rows;
    if (resolvedKeys(rows).has(key)) throw new SuggestionError("That suggestion is no longer open.", 404);
    await db.logAction({ clerk_user_id: actorClerkId, action: RESOLVED_ACTION, resource_type: "document", resource_id: documentId,
      changes: { key, field_key, state, ...(value !== undefined ? { value } : {}), ...(edited !== undefined ? { edited } : {}) } });
  });
}
async function releaseResolution(ctx, documentId, key, actorClerkId) {
  try { await withTenant(ctx, (db) => db.logAction({ clerk_user_id: actorClerkId, action: RELEASED_ACTION, resource_type: "document", resource_id: documentId, changes: { key } })); } catch { /* best effort */ }
}

/** Dismiss: clears it and it is never suggested again. Idempotent: a second Dismiss (or an Accept that lost the race) is refused. */
export async function dismissFieldSuggestion(ctx, { documentId, key }, actorClerkId) {
  if (!UUID_RE.test(String(documentId)) || typeof key !== "string") throw new SuggestionError("documentId and key are required.");
  const s = await findOpen(ctx, documentId, key);
  await claimResolution(ctx, { documentId, key, field_key: s.field_key, state: "dismissed" }, actorClerkId);
  return { ok: true };
}

/**
 * Accept. `value` is optional for a single-value suggestion (the suggested value is used); it is required for an ambiguous date (one of the
 * readings) and it is what Edit sends (any text the person typed; the normal correction rules check it). The resolution is CLAIMED first
 * (one winner), then the value is written through the person path; if that write fails the claim is released so the person can try again.
 */
export async function acceptFieldSuggestion(ctx, { documentId, key, value, by }, actorClerkId, { correctField }) {
  if (!UUID_RE.test(String(documentId)) || typeof key !== "string") throw new SuggestionError("documentId and key are required.");
  const s = await findOpen(ctx, documentId, key);
  const typed = typeof value === "string" ? value.trim() : "";
  let chosen;
  if (s.options) {
    if (!typed) throw new SuggestionError("Pick one of the dates.");
    chosen = typed;
  } else chosen = typed || String(s.value);
  const edited = s.options ? !s.options.includes(chosen) : chosen !== String(s.value);
  await claimResolution(ctx, { documentId, key, field_key: s.field_key, state: "accepted", value: chosen, edited }, actorClerkId);
  let r;
  try { r = await correctField(ctx, { documentId, fieldKey: s.field_key, value: chosen, by: by || "You" }, actorClerkId); }
  catch (err) { await releaseResolution(ctx, documentId, key, actorClerkId); throw err; }
  return { ok: true, field_key: s.field_key, value: chosen, extraction: r?.extraction ?? null };
}
