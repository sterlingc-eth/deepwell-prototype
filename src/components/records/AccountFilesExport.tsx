import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, FolderArchive, Loader2 } from 'lucide-react';
import {
  AccountExportError, downloadAccountFilesPart, getAccountFilesExport, startAccountFilesExport, stepAccountFilesExport,
  type AccountExportJob,
} from '../../services/exportClient';

/**
 * "Download all my files": every original file this company has uploaded, as zip files sorted by customer and by company folder,
 * with a list of every file and the spreadsheets. For a company that is leaving (or just wants its own copy). Admin only;
 * the server enforces that. The work happens in the background, so the person can close the page; the bell says when it is ready.
 */
const POLL_MS = 4000;

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 KB';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

export function AccountFilesExport() {
  const [job, setJob] = useState<AccountExportJob | null>(null);
  const [mode, setMode] = useState<'background' | 'page' | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [starting, setStarting] = useState(false);
  const [notAdmin, setNotAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyPart, setBusyPart] = useState<number | 'index' | null>(null);
  const alive = useRef(true);
  const driving = useRef(false);

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const running = job && (job.status === 'queued' || job.status === 'running');

  // Keep a running job moving: ask the server to build the next part (a deployment with no queue), or just look again (the queue is doing it).
  const follow = useCallback(async (first: AccountExportJob, knownMode: 'background' | 'page' | null) => {
    if (driving.current) return;
    driving.current = true;
    let current = first;
    let m = knownMode;
    try {
      while (alive.current && (current.status === 'queued' || current.status === 'running')) {
        try {
          if (m === 'background') {
            await new Promise((r) => setTimeout(r, POLL_MS));
            if (!alive.current) break;
            current = (await getAccountFilesExport(current.jobId)).job ?? current;
          } else {
            current = (await stepAccountFilesExport(current.jobId)).job;
          }
        } catch (e) {
          if (e instanceof AccountExportError && e.status === 409) { m = 'background'; setMode('background'); continue; }
          throw e;
        }
        if (alive.current) setJob(current);
      }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : 'Could not check on your download.');
    } finally {
      driving.current = false;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    getAccountFilesExport()
      .then(({ job: j }) => {
        if (cancelled) return;
        setJob(j);
        setLoaded(true);
        if (j && (j.status === 'queued' || j.status === 'running')) void follow(j, null);
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof AccountExportError && e.status === 403) setNotAdmin(true);
        setLoaded(true);
      });
    return () => { cancelled = true; };
  }, [follow]);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const out = await startAccountFilesExport();
      setJob(out.job);
      setMode(out.mode);
      if (out.job.status === 'queued' || out.job.status === 'running') void follow(out.job, out.mode);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the download.');
    } finally {
      setStarting(false);
    }
  };

  const download = async (part: number | 'index') => {
    if (!job) return;
    setBusyPart(part);
    setError(null);
    try {
      await downloadAccountFilesPart(job.jobId, part);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not download this file.');
    } finally {
      setBusyPart(null);
    }
  };

  const ready = job?.status === 'done';
  const startLabel = ready || job?.status === 'expired' || job?.status === 'failed' || job?.status === 'stuck' ? 'Prepare a new download' : 'Download all my files';

  return (
    <div className="space-y-2" data-testid="account-files-export">
      <h3 className="text-body font-medium text-ink flex items-center gap-2">
        <FolderArchive className="w-4 h-4" aria-hidden="true" /> Download all my files
      </h3>
      <p className="text-caption text-ink-3">
        Leaving DeepWell, or just want your own copy? This packs every original file you uploaded into zip files, sorted by customer
        and by company folder, with a list of every file and your spreadsheets.
      </p>
      <details className="text-caption text-ink-3">
        <summary className="cursor-pointer text-ink-2 min-h-touch flex items-center">What is in the download?</summary>
        <ul className="list-disc pl-5 space-y-1 pb-1">
          <li>Every original file, in a Customers folder (one folder per customer) and a Company Files folder.</li>
          <li>People and HR papers are included, because you are an admin.</li>
          <li>A list of every file: what it is, which customer, and its date.</li>
          <li>Your documents, customers and units spreadsheets.</li>
          <li>Big accounts come as several zip files. Unzip them all into the same folder.</li>
        </ul>
      </details>

      {!loaded && <p className="text-caption text-ink-3 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Checking…</p>}

      {loaded && notAdmin && <p className="text-caption text-ink-3">Only a company admin can download all files.</p>}

      {loaded && !notAdmin && (
        <>
          {running && job && (
            <div className="rounded-md border border-line bg-surface-2 p-3 space-y-1" role="status" aria-live="polite">
              <p className="text-body text-ink flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                Packing your files: {job.filesDone.toLocaleString('en-US')} of {job.totalFiles.toLocaleString('en-US')}
              </p>
              <div className="h-2 rounded-full bg-line overflow-hidden" aria-hidden="true">
                <div className="h-full bg-brass-500" style={{ width: `${job.totalFiles ? Math.min(100, Math.round((job.filesDone / job.totalFiles) * 100)) : 0}%` }} />
              </div>
              <p className="text-caption text-ink-3">
                {mode === 'page'
                  ? 'Keep this page open until it finishes.'
                  : "You can leave this page. We'll tell you in the bell when it's ready."}
              </p>
            </div>
          )}

          {ready && job && (
            <div className="rounded-md border border-line bg-surface-2 p-3 space-y-2">
              <p className="text-body text-ink">Your files are ready. Available until {fmtDate(job.expiresAt)}.</p>
              <ul className="space-y-2">
                {job.parts.map((p) => (
                  <li key={p.n} className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-body text-ink-2">
                      Part {p.n} of {job.parts.length} <span className="text-ink-3">· {p.files.toLocaleString('en-US')} files · {formatBytes(p.bytes)}</span>
                    </span>
                    <button type="button" className="dw-btn-secondary shrink-0" disabled={busyPart !== null} onClick={() => void download(p.n)} aria-label={`Download part ${p.n} of ${job.parts.length}`}>
                      {busyPart === p.n ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Download className="w-4 h-4" aria-hidden="true" />} Download
                    </button>
                  </li>
                ))}
                {job.index && (
                  <li className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-body text-ink-2">List of files and spreadsheets</span>
                    <button type="button" className="dw-btn-secondary shrink-0" disabled={busyPart !== null} onClick={() => void download('index')} aria-label="Download the list of files and spreadsheets">
                      {busyPart === 'index' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Download className="w-4 h-4" aria-hidden="true" />} Download
                    </button>
                  </li>
                )}
              </ul>
              {job.skippedFiles > 0 && (
                <p className="text-caption text-ink-3">
                  {job.skippedFiles.toLocaleString('en-US')} {job.skippedFiles === 1 ? 'file' : 'files'} could not be included. The list of files says which.
                </p>
              )}
              <p className="text-caption text-ink-3">Download every part, then unzip them all into the same folder.</p>
            </div>
          )}

          {job?.status === 'failed' && <p role="alert" className="text-body text-warn-ink dark:text-brass-200">We could not finish preparing your files. Please try again.</p>}
          {job?.status === 'stuck' && <p role="alert" className="text-body text-warn-ink dark:text-brass-200">This is taking longer than expected. You can start it again.</p>}
          {job?.status === 'expired' && <p className="text-caption text-ink-3">The last download has expired. Prepare a new one any time.</p>}

          {!running && (
            <button type="button" className="dw-btn-secondary shrink-0" disabled={starting} onClick={() => void start()}>
              {starting ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <FolderArchive className="w-4 h-4" aria-hidden="true" />} {startLabel}
            </button>
          )}
        </>
      )}
      {error && <p role="alert" className="text-body text-warn-ink dark:text-brass-200">{error}</p>}
    </div>
  );
}
