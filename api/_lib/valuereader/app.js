/**
 * valuereader app glue (DONOVAN_VALUEREADER=1, default OFF). A pre-model, $0 path: one-fact questions are read from the tenant's stored page text by the
 * deterministic valuereader1 and answered with the verbatim value plus a page citation; anything else returns null and the existing chain runs unchanged.
 * Stricter-only: customer-audience documents only, a collision (same file name + page on two documents) or any error = null. No DB writes, no migration.
 */
import { buildCorpus, readValue, analyze } from "./index.js";
import { revchainOn, absAuditOn, aggFuzzOn, guardRevision, guardAggregate, auditAbsenceAnswer } from "./vr_guard.js";

export const valueReaderOn = () => /^(?:1|true|on|yes)$/i.test(String(process.env.DONOVAN_VALUEREADER ?? "").trim());
const MAX_PAGES = Number(process.env.DONOVAN_VALUEREADER_MAX_PAGES) > 0 ? Number(process.env.DONOVAN_VALUEREADER_MAX_PAGES) : 20000;
const TENANT = "tenant_id = current_setting('app.tenant_id', true)::uuid";
const cache = new Map(); // tenant -> { sig, corpus, idx }  (at most 4 tenants kept)

/** rows: [{ document_id, page_no, text, original_filename, display_name }] -> { corpus, idx } */
export function prepare(rows) {
  const pages = []; const idx = new Map();
  for (const r of rows) {
    const file = String(r.original_filename ?? "").replace(/^batch\d+__/, ""); const k = `${file}\u0000${r.page_no}`;
    pages.push({ docId: r.document_id, file, page_no: r.page_no, text: r.text ?? "" });
    idx.set(k, idx.has(k) ? { dup: true } : { documentId: r.document_id, name: r.display_name || file || "the document" });
  }
  return { corpus: buildCorpus(pages), idx };
}

/** Pure: question + prepared library -> answer `data` object (same shape as the docrecord answer) or null (= fall through). */
export function answerFromPrepared({ corpus, idx }, question) {
  let r = readValue(corpus, String(question ?? ""), {});
  if (revchainOn()) r = guardRevision(corpus, String(question ?? ""), r);   // H328 (DONOVAN_REVCHAIN, default OFF): a stale revision never beats the latest; only ever turns an answer into null
  if (aggFuzzOn()) r = guardAggregate(corpus, String(question ?? ""), r, analyze(String(question ?? ""), corpus).names, 3);   // H340 (DONOVAN_AGGFUZZ, default OFF): a count/sum is withheld when an unattributed scanned page may hold another record of the party; only ever turns an answer into null
  if (!r || r.ans == null) return null;
  const hit = idx.get(`${r.doc}\u0000${r.page}`);
  const shown = String(r.ans).trim();
  if (!hit || hit.dup || !shown) return null;
  const label = String(r.label ?? "Value").trim() || "Value";
  const ex = Array.isArray(r.sources) ? r.sources : [];
  const srcs = []; const seen = new Set(); const names = [];
  for (const x of ex) { const h = idx.get(`${x.doc}\u0000${x.page}`); if (!h || h.dup) return null; const k = `${h.documentId}:${x.page}`; if (seen.has(k)) continue; seen.add(k); srcs.push({ documentId: h.documentId, location: { page: Number(x.page) } }); names.push(`page ${x.page} of ${h.name}`); }
  if (!srcs.length) { srcs.push({ documentId: hit.documentId, location: { page: Number(r.page) } }); names.push(`page ${r.page} of ${hit.name}`); }
  const detail = r.detail ? ` Worked from: ${String(r.detail).slice(0, 400)}.` : "";
  const out = {
    kind: "answer", text: `${label}: ${shown} (${names.join("; ")}, printed as "${shown}").${detail}`, facts: [{ label, value: shown }],
    sources: srcs,
    confidence: 1, verifiedCount: 1, unverifiedCount: 0, closest: [], valueReader: true,
  };
  // safety net: the reader's score, kept OFF the wire (non-enumerable, never serialized to the customer)
  Object.defineProperty(out, "_audit", { value: { score: typeof r.score === "number" ? r.score : undefined }, enumerable: false });
  return out;
}

/** Ask side. ctx = the ask handler's ctxArg. Returns an answer `data` object or null. Never throws. */
export async function runValueReaderAnswer(ctx, question) {
  try {
    const { withTenant } = await import("../recordsStore.js");
    return await withTenant(ctx, async (db) => {
      const s = await db.raw(
        `SELECT current_setting('app.tenant_id', true) AS t, count(*)::int AS n, max(dp.created_at) AS m FROM document_pages dp JOIN documents d ON d.id = dp.document_id WHERE dp.${TENANT} AND d.audience = 'customer'`, []);
      const row = s.rows?.[0]; if (!row || !row.n || row.n > MAX_PAGES) return null;
      const sig = `${row.n}|${row.m instanceof Date ? row.m.toISOString() : row.m}`; let ent = cache.get(row.t);
      if (!ent || ent.sig !== sig) {
        const { rows } = await db.raw(
          `SELECT dp.document_id, dp.page_no, dp.text, d.original_filename, d.display_name FROM document_pages dp JOIN documents d ON d.id = dp.document_id WHERE dp.${TENANT} AND d.audience = 'customer' ORDER BY dp.document_id, dp.page_no LIMIT $1`, [MAX_PAGES]);
        ent = { sig, ...prepare(rows) }; cache.delete(row.t); cache.set(row.t, ent); while (cache.size > 4) cache.delete(cache.keys().next().value);
      }
      return answerFromPrepared(ent, question);
    });
  } catch (err) { console.error("valuereader skipped:", err?.message); return null; }
}

/** H327 (DONOVAN_ABSAUDIT, default OFF): before a "No X on file" answer goes out, sweep the raw text + filenames of ALL stored documents (read or not) for X.
 *  Returns replacement answer text (claims no value) or null = leave the answer unchanged. Never throws; no writes. */
export async function auditAbsence(ctx, question, answerText) {
  if (!absAuditOn()) return null;
  try {
    const { withTenant } = await import("../recordsStore.js");
    return await withTenant(ctx, async (db) => {
      const { rows } = await db.raw(
        `SELECT d.id AS document_id, d.original_filename, dp.page_no, dp.text FROM documents d LEFT JOIN document_pages dp ON dp.document_id = d.id WHERE d.${TENANT} AND d.audience = 'customer' ORDER BY d.id, dp.page_no LIMIT $1`, [MAX_PAGES]);
      const pages = rows.map((r) => ({ docId: r.document_id, file: String(r.original_filename ?? ""), page_no: r.page_no ?? 1, text: r.text ?? "" }));
      return auditAbsenceAnswer(pages, question, answerText);
    });
  } catch (err) { console.error("absence audit skipped:", err?.message); return null; }
}
