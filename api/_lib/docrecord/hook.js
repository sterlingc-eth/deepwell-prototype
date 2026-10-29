/** Glue between the app (extractDocument.js / ask.js) and the pure docrecord modules. Imported lazily, only when a switch is ON. Never throws into ingest or ask. */
import { withTenant } from "../recordsStore.js";
import { assertModelBudget } from "../rateLimit.js";
import { recordModelCall } from "../usage.js";
import { extractDocRecord, DocRecordError } from "./extract.js";
import { makeAnthropicProvider, messageFor, RECORD_MODEL } from "./provider.js";
import { saveRecord, loadRecords } from "./store.js";
import { answerFromRecords } from "./answer.js";

/** Upload side. `pages` = the stored page rows the extraction just used. Returns {status} or {skipped|error}. */
export async function buildDocRecordForDocument(ctx, documentId, pages, { modelAttempts, userId, provider } = {}) {
  try {
    if (!pages?.some((p) => (p.text ?? "").trim())) return { skipped: "no_text" };
    try { await assertModelBudget(ctx); } catch { return { skipped: "budget" }; }
    const res = await extractDocRecord({ pages }, { provider: provider ?? makeAnthropicProvider({ modelAttempts }), messageFor });
    for (const u of res.usage ?? []) { try { await recordModelCall(ctx, u); } catch { /* best effort, as extractDocument.js */ } }
    if (!res.record) return { skipped: "empty" };
    await withTenant(ctx, async (db) => {
      await saveRecord(db, { documentId, record: res.record, status: res.status });
      await db.logAction({ action: "document.record_extracted", resource_type: "document", resource_id: documentId, clerk_user_id: userId, changes: { status: res.status, ok: res.stats.ok, total: res.stats.total, rejected: res.stats.rejected.length, reconcile: res.reconcile?.status, attempts: res.attempts, model: RECORD_MODEL } });
    });
    console.log(JSON.stringify({ route: "docrecord", status: res.status, ok: res.stats.ok, total: res.stats.total, attempts: res.attempts }));
    return { status: res.status };
  } catch (err) {
    const userMessage = err instanceof DocRecordError ? err.userMessage : null;
    console.error("docrecord build skipped:", err?.message);
    try { await withTenant(ctx, (db) => db.logAction({ action: "document.record_failed", resource_type: "document", resource_id: documentId, clerk_user_id: userId, changes: { message: userMessage } })); } catch { /* ingest already succeeded */ }
    return { error: userMessage ?? "failed" };
  }
}

/** Ask side. Returns an answer `data` object or null (= fall through to the existing chain, then the model). */
export async function runDocRecordAnswer(ctx, question) {
  const entries = await withTenant(ctx, (db) => loadRecords(db));
  return answerFromRecords(question, entries);
}
