import type { ImportDecision, ImportApplyResult } from '../../services/reviewClient';

/** The server applies at most this many papers per call. */
export const APPLY_CHUNK = 100;

type ApplyFn = (args: { batchId: string; kind: ImportDecision['kind']; key: string; documentIds: string[]; customerId?: string; name?: string; choice?: string; by: string; runId?: string | null }) => Promise<ImportApplyResult>;

/**
 * Apply one decision card in chunks. If a later chunk fails after earlier ones changed papers, the result says so (`partial`) and keeps the run id
 * so Undo still works; nothing is claimed that did not happen. `total` is the group size, `applied` what the server confirmed.
 */
export async function runDecision(apply: ApplyFn, batchId: string, d: ImportDecision, choice: string | undefined, by: string) {
  let runId: string | null = null; let customerId: string | undefined = d.params.customerId; let applied = 0; let skipped = 0; let error: unknown = null;
  try {
    for (let i = 0; i < d.documentIds.length; i += APPLY_CHUNK) {
      const r = await apply({ batchId, kind: d.kind, key: d.id.slice(d.kind.length + 1), documentIds: d.documentIds.slice(i, i + APPLY_CHUNK), customerId, name: d.params.name, choice, by, runId });
      runId = r.runId; customerId = r.customerId ?? customerId; applied += r.applied; skipped += r.skipped.length;
    }
  } catch (e) { error = e; }
  return { runId, applied, skipped, total: d.documentIds.length, partial: !!error && applied > 0, error };
}
