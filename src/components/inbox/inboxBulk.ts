/**
 * Inbox redesign: one-click and bulk "Link" / "Approve" with an Undo that really undoes.
 *
 * Every change is CONFIRMED BY THE SERVER before the screen says it is done: each paper is saved with an awaited call, a paper whose save failed is
 * reported (and left exactly as it was), and only then is the screen refreshed from the server. So "Linked 12 papers." is never shown before the
 * server agrees, and Undo can only be pressed once there is something confirmed to undo. One action at a time: a second one (or an Undo) started while
 * another is still running is refused, so a fast Undo cannot race the action it undoes.
 * A link is only ever added by a click, an approval only goes as far as maxStageFor allows, and no value a person typed or confirmed is touched.
 * Undo puts back the stage the paper had and the "Link to <customer>?" suggestion the link used up.
 * Calls are paced (a few at a time) so a few hundred papers never fire a few hundred requests at once.
 */
import { useGraph, maxStageFor } from '../../core/entityGraph';
import type { Doc, Entity } from '../../core/types';
import { reviewClient } from '../../services/reviewClient';
import { loadGraphFromServer } from '../../hooks/usePostgresSync';

const DEMO = import.meta.env?.VITE_DEMO_MODE === 'true';
const BATCH = 6;
const GAP_MS = 220;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type UndoAction =
  | { kind: 'link'; items: { docId: string; entityId: string }[]; before: Record<string, Doc>; label: string }
  | { kind: 'approve'; docIds: string[]; before: Record<string, Doc>; entities: Record<string, Entity>; label: string };

let running = false;
/** True while a bulk action or an Undo is in flight (the screen also disables its buttons). */
export const isBulkBusy = () => running;
async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  if (running) throw new Error('Another change is still being saved.');
  running = true;
  try { return await fn(); } finally { running = false; }
}

/** Runs `fn` over `items` a few at a time with a short pause between batches. */
async function paced<T>(items: T[], fn: (x: T) => void | Promise<void>, onProgress?: (done: number) => void) {
  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH);
    await Promise.all(chunk.map((x) => fn(x)));
    onProgress?.(Math.min(items.length, i + chunk.length));
    if (i + BATCH < items.length) await sleep(GAP_MS);
  }
}

/** What a person has typed or corrected on a paper, as a comparable string (object identity changes on every refresh, so it is not used). */
export const factSig = (d: Doc) => d.extracted.map((f) => `${f.name}=${f.correctedValue ?? f.value}`).sort().join('|');

/** The server's stage a paper goes back to when its link is taken away: 'received' stays 'received', everything else before 'linked' was 'read'. */
const restoreStageOf = (d: Doc): string => (d.stage === 'received' ? 'received' : 'read');

async function refresh() {
  if (DEMO) return;
  try { await loadGraphFromServer(); } catch { /* keep what is on screen */ }
}

/** Links each paper to its own customer. Only the papers the server confirmed are in `action`; `failed` counts the rest (left as they were). */
export function linkMany(pairs: { docId: string; entityId: string }[], by: string, label: string, onProgress?: (done: number) => void): Promise<{ action: UndoAction; failed: number }> {
  return exclusive(async () => {
    const s = useGraph.getState();
    const before: Record<string, Doc> = {};
    for (const p of pairs) { const d = s.docs[p.docId]; if (d) before[p.docId] = d; }
    const ok: { docId: string; entityId: string }[] = [];
    let failed = 0;
    await paced(pairs, async (p) => {
      try {
        if (DEMO) useGraph.getState().linkDoc(p.docId, p.entityId, by);
        else await reviewClient.linkDocument(p.docId, p.entityId, by);
        ok.push(p);
      } catch { failed++; }
    }, onProgress);
    await refresh();
    return { action: { kind: 'link' as const, items: ok, before, label }, failed };
  });
}

/** Approves each paper (only as far as its checks allow). Same confirm-first rule as linkMany. */
export function approveMany(docIds: string[], by: string, label: string, onProgress?: (done: number) => void): Promise<{ action: UndoAction; failed: number }> {
  return exclusive(async () => {
    const s = useGraph.getState();
    const before: Record<string, Doc> = {};
    for (const id of docIds) { const d = s.docs[id]; if (d) before[id] = d; }
    const entities = s.entities;
    const ok: string[] = [];
    let failed = 0;
    await paced(docIds, async (id) => {
      const d = before[id];
      try {
        if (DEMO || !d || maxStageFor(d, useGraph.getState().schema) !== 'verified') useGraph.getState().approveDoc(id, by);
        else await reviewClient.verifyDocument(id, by);
        ok.push(id);
      } catch { failed++; }
    }, onProgress);
    await refresh();
    return { action: { kind: 'approve' as const, docIds: ok, before, entities, label }, failed };
  });
}

/** Puts every confirmed paper back the way it was (server first, then the screen). Papers a person changed since are left alone. */
export function undo(a: UndoAction, onProgress?: (done: number) => void): Promise<{ restored: number; leftAlone: number; failed: number }> {
  return exclusive(async () => {
    const ids = a.kind === 'link' ? a.items.map((i) => i.docId) : a.docIds;
    let restored = 0, leftAlone = 0, failed = 0;
    const toRestore: string[] = [];
    const cur = useGraph.getState().docs;
    for (const id of ids) {
      const was = a.before[id];
      const now = cur[id];
      if (!was || !now) { leftAlone++; continue; }
      // Changed by someone since (a value was corrected, it was moved on a stage): not ours to undo.
      const entityId = a.kind === 'link' ? a.items.find((i) => i.docId === id)!.entityId : '';
      const unchanged = a.kind === 'link'
        ? now.linkedEntityIds.includes(entityId) && now.linkedEntityIds.length === was.linkedEntityIds.length + 1 && factSig(now) === factSig(was)
        : now.stage === 'verified' && factSig(now) === factSig(was);
      if (!unchanged) { leftAlone++; continue; }
      toRestore.push(id);
    }
    const okIds: string[] = [];
    await paced(toRestore, async (id) => {
      try {
        if (!DEMO) {
          if (a.kind === 'link') {
            const was = a.before[id]!;
            const entityId = a.items.find((i) => i.docId === id)!.entityId;
            const strong = new Set(was.linkSuggestionStrongIds ?? []);
            const names = useGraph.getState().entities;
            const suggestion = (was.linkSuggestionIds ?? []).flatMap((sid) => {
              const e = names[sid];
              return e ? [{ id: sid, name: String(e.fields?.customer_name ?? e.fields?.name ?? ''), ...(strong.has(sid) ? { strong: true } : {}) }] : [];
            });
            await reviewClient.unlinkDocument(id, entityId, { stage: restoreStageOf(was), suggestion });
          } else await reviewClient.unverifyDocument(id);
        }
        okIds.push(id);
        restored++;
      } catch { failed++; }
    }, onProgress);
    if (DEMO) {
      useGraph.setState((s) => {
        const docs = { ...s.docs };
        for (const id of okIds) { const was = a.before[id]; if (was) docs[id] = was; }
        return a.kind === 'approve' ? { docs, entities: a.entities } : { docs };
      });
    } else await refresh();
    return { restored, leftAlone, failed };
  });
}
