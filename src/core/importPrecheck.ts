// Pure summary behind the bulk import's "Check before importing" step (src/components/intake/ImportPrecheck.tsx).
// Free of React so scripts/verify-import-progress.ts can check it.

export type PrecheckKind = 'pdf' | 'photo' | 'word' | 'excel' | 'text';

const KIND_BY_EXT: Record<string, PrecheckKind> = {
  pdf: 'pdf',
  jpg: 'photo', jpeg: 'photo', png: 'photo', gif: 'photo', webp: 'photo', heic: 'photo', heif: 'photo',
  docx: 'word',
  xlsx: 'excel',
  csv: 'text', tsv: 'text', txt: 'text', md: 'text', json: 'text',
};

export interface PrecheckSummary {
  count: number;
  bytes: number;
  byKind: Record<PrecheckKind, number>;
  skippedCount: number;
  /** Skip reason -> how many files, in first-seen order. */
  skippedByReason: Array<{ reason: string; count: number }>;
}

export function kindOf(path: string): PrecheckKind | null {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  return m ? KIND_BY_EXT[m[1]!.toLowerCase()] ?? null : null;
}

export function summarizePrecheck(
  accepted: ReadonlyArray<{ path: string; sizeBytes: number }>,
  skipped: ReadonlyArray<{ skipReason?: string }>
): PrecheckSummary {
  const byKind: Record<PrecheckKind, number> = { pdf: 0, photo: 0, word: 0, excel: 0, text: 0 };
  let bytes = 0;
  for (const f of accepted) {
    bytes += Number.isFinite(f.sizeBytes) && f.sizeBytes > 0 ? f.sizeBytes : 0;
    const k = kindOf(f.path);
    if (k) byKind[k] += 1;
  }
  const reasons = new Map<string, number>();
  for (const s of skipped) {
    const r = s.skipReason ?? 'other';
    reasons.set(r, (reasons.get(r) ?? 0) + 1);
  }
  return {
    count: accepted.length,
    bytes,
    byKind,
    skippedCount: skipped.length,
    skippedByReason: [...reasons.entries()].map(([reason, count]) => ({ reason, count })),
  };
}

/** 950 KB, 12.4 MB, 1.2 GB. */
export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

const KIND_WORDS: Record<PrecheckKind, [string, string]> = {
  pdf: ['PDF', 'PDFs'],
  photo: ['photo', 'photos'],
  word: ['Word file', 'Word files'],
  excel: ['Excel file', 'Excel files'],
  text: ['text or CSV file', 'text and CSV files'],
};

/** "3 PDFs", "1 Excel file": the kinds present, in a fixed order. */
export function kindLabels(byKind: Record<PrecheckKind, number>): string[] {
  return (Object.keys(KIND_WORDS) as PrecheckKind[])
    .filter((k) => byKind[k] > 0)
    .map((k) => `${byKind[k].toLocaleString('en-US')} ${byKind[k] === 1 ? KIND_WORDS[k][0] : KIND_WORDS[k][1]}`);
}
