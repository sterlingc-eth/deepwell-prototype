import { ClipboardCheck, Upload, X } from 'lucide-react';
import { formatBytes, kindLabels, type PrecheckSummary } from '../../core/importPrecheck';

interface Props {
  summary: PrecheckSummary;
  /** Plain-language label for each skip reason (the same labels the import list uses). */
  reasonLabel: (reason: string) => string;
  onStart: () => void;
  onCancel: () => void;
}

/**
 * "Check before importing": what a bulk drop will actually import, what will be skipped and why, and what to expect,
 * before a single byte is uploaded. Nothing starts until the person presses Start import.
 */
export function ImportPrecheck({ summary, reasonLabel, onStart, onCancel }: Props) {
  const kinds = kindLabels(summary.byKind);
  const slowKinds = summary.byKind.pdf + summary.byKind.photo;
  const fastKinds = summary.byKind.word + summary.byKind.excel + summary.byKind.text;
  return (
    <section aria-labelledby="precheck-heading" className="rounded-lg border border-line bg-surface p-5 space-y-3">
      <h3 id="precheck-heading" className="text-h3 flex items-center gap-2">
        <ClipboardCheck className="w-5 h-5 text-brass-500" aria-hidden="true" />
        Check before importing
      </h3>

      {summary.count > 0 ? (
        <>
          <p className="text-body">
            {summary.count.toLocaleString('en-US')} {summary.count === 1 ? 'file is' : 'files are'} ready to import ({formatBytes(summary.bytes)}).
          </p>
          {kinds.length > 0 && (
            <ul className="flex flex-wrap gap-1.5" aria-label="Files by kind">
              {kinds.map((k) => (
                <li key={k} className="dw-pill-muted">{k}</li>
              ))}
            </ul>
          )}
          {slowKinds > 0 && fastKinds > 0 && (
            <p className="text-body text-ink-2">PDFs and photos take longer to read than Word, Excel and text files.</p>
          )}
        </>
      ) : (
        <p className="text-body">None of these files can be imported.</p>
      )}

      {summary.skippedCount > 0 && (
        <div className="text-body text-ink-2">
          <p>
            {summary.skippedCount.toLocaleString('en-US')} {summary.skippedCount === 1 ? 'file will be skipped' : 'files will be skipped'}:
          </p>
          <ul className="list-disc pl-5 mt-1">
            {summary.skippedByReason.map((r) => (
              <li key={r.reason}>{reasonLabel(r.reason)}: {r.count.toLocaleString('en-US')}</li>
            ))}
          </ul>
        </div>
      )}

      {summary.count > 0 && (
        <p className="text-caption text-ink-3">
          Keep this page open until the upload finishes. After that you can close it: reading carries on, and the Inbox shows live progress and the time left.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {summary.count > 0 && (
          <button type="button" className="dw-btn-primary" onClick={onStart}>
            <Upload className="w-4 h-4" aria-hidden="true" /> Start import
          </button>
        )}
        <button type="button" className="dw-btn-secondary" onClick={onCancel}>
          <X className="w-4 h-4" aria-hidden="true" /> Cancel
        </button>
      </div>
    </section>
  );
}
