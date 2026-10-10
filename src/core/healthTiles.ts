/**
 * Dashboard "Data health" tiles, from ONE source each (pure, no React).
 *
 * The tiles used to mix the browser's partial graph (it holds the newest 500 documents plus some older ones) with the
 * server's shop-wide counts, which produced lines like "661 documents · 724 checked · 110%". Now:
 *  - the total, the checked count, the AI-verified count and the stage bar all come from the server's summary
 *    (`reviewSummary`), so checked can never exceed total;
 *  - the "needs attention" tiles (needs linking, missing info, conflicts, duplicates) are counted from the graph, only on
 *    documents that are not verified, and carry a "+" when the graph did not load every unverified document.
 */
import type { Doc, PipelineStage } from './types';
import { conflictDocs, docCountsByStage, duplicateDocs, gapDocs, unlinkedDocs, type GraphSnapshot, type ServerCounts } from './entityGraph';

/** The slice of `reviewSummary` the tiles use. */
export interface HealthSummary {
  total: number;
  byStage: { received: number; read: number; mapped: number; linked: number; verified: number };
  verified: number;
  needsReview: number;
  aiVerified?: number;
}

export interface CountTile {
  value: number;
  /** True when the graph did not load every unverified document, so the true number is at least `value`. */
  atLeast: boolean;
  /** What the tile shows: "12", or "12+" when the graph is partial. */
  text: string;
}

export interface HealthTiles {
  total: number;
  checked: number;
  /** Whole percent of documents checked, 0 to 100. */
  checkedPct: number;
  aiVerified: number;
  /** Whole percent of checked documents the AI verified, 0 to 100. */
  aiPctOfChecked: number;
  stages: Record<PipelineStage, number>;
  unlinked: CountTile;
  gaps: CountTile;
  conflicts: CountTile;
  duplicates: CountTile;
  /** True when the unverified tiles are lower bounds. */
  partial: boolean;
}

const nonNeg = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
const unverified = (docs: Doc[]) => docs.filter((d) => d.stage !== 'verified');

/** The summary to use: the fresh server answer, else the counts the sync stored on the graph, else null (count the graph). */
export function summaryFrom(summary: HealthSummary | null | undefined, sc: ServerCounts | null | undefined): HealthSummary | null {
  if (summary && Number.isFinite(summary.total) && summary.byStage) return summary;
  if (sc && Number.isFinite(sc.documents) && sc.byStage) {
    return { total: sc.documents, byStage: sc.byStage, verified: sc.verified, needsReview: sc.needsReview, aiVerified: sc.aiVerified };
  }
  return null;
}

export function healthTiles(g: GraphSnapshot, summary?: HealthSummary | null): HealthTiles {
  const s = summaryFrom(summary, g.serverCounts);
  const graphDocs = Object.values(g.docs);
  const heldUnverified = unverified(graphDocs).length;

  let total: number;
  let checked: number;
  let aiVerified: number;
  let stages: Record<PipelineStage, number>;
  let notLoaded: number;
  if (s) {
    total = nonNeg(s.total);
    checked = Math.min(nonNeg(s.verified), total);
    aiVerified = Math.min(nonNeg(s.aiVerified ?? graphDocs.filter((d) => d.verifiedBy === 'ai').length), checked);
    stages = { received: nonNeg(s.byStage.received), classified: nonNeg(s.byStage.read), extracted: nonNeg(s.byStage.mapped), linked: nonNeg(s.byStage.linked), verified: nonNeg(s.byStage.verified) };
    notLoaded = Math.max(0, nonNeg(s.needsReview) - heldUnverified);
  } else {
    stages = docCountsByStage({ ...g, serverCounts: null });
    total = graphDocs.length;
    checked = Math.min(stages.verified, total);
    aiVerified = Math.min(graphDocs.filter((d) => d.verifiedBy === 'ai').length, checked);
    notLoaded = 0;
  }

  const partial = notLoaded > 0;
  const tile = (docs: Doc[]): CountTile => {
    const value = unverified(docs).length;
    // "N+" only when something was found: a zero stays "0" (the tile's subtitle says none were found so far).
    return { value, atLeast: partial, text: partial && value > 0 ? `${value}+` : String(value) };
  };
  return {
    total,
    checked,
    checkedPct: Math.min(100, Math.round((checked / Math.max(total, 1)) * 100)),
    aiVerified,
    aiPctOfChecked: Math.min(100, Math.round((aiVerified / Math.max(checked, 1)) * 100)),
    stages,
    unlinked: tile(unlinkedDocs(g)),
    gaps: tile(gapDocs(g)),
    conflicts: tile(conflictDocs(g)),
    // Only true duplicates (held out of every count). "Might be a copy" look-alikes are a hint, listed under the Inbox Duplicates chip.
    duplicates: tile(duplicateDocs(g).filter((d) => d.issues.some((i) => i.kind === 'duplicate'))),
    partial,
  };
}
