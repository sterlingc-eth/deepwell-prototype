import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Folder, Loader2, Mail, Plug, X } from 'lucide-react';
import {
  googleSyncClient, openGooglePicker, relativeTime,
  type GoogleConnection, type GoogleProvider, type GoogleStatus,
} from '../services/googleSyncClient';

/**
 * "Connected sources" (Settings, Team screen, admins only). Connect Google Drive and Gmail, choose what to bring in, see when it
 * last ran, pause or disconnect. Everything is hidden until the server says the feature is on (status.enabled), so with
 * DEEPWELL_GOOGLE_SYNC off this renders nothing at all. The server enforces every rule; this is presentation.
 */
type Picked = { id: string; name: string; kind: 'folder' | 'file' };

const TEXT = {
  title: 'Connected sources',
  intro: 'Keep saving files in Google Drive and receiving invoices in Gmail. DeepWell picks them up automatically, reads them like any file you upload, and Donovan can answer from them.',
  driveTitle: 'Google Drive',
  driveBlurb: 'DeepWell brings in the files from the folders you choose, and checks for new and changed files all day.',
  gmailTitle: 'Gmail',
  gmailBlurb: 'DeepWell brings in the attachments from the labels and senders you choose, such as invoices and statements. It does not import the emails themselves.',
  connectDrive: 'Connect Google Drive',
  connectGmail: 'Connect Gmail',
  modeNarrow: 'Only the folders and files I choose',
  modeNarrowHelp: "You pick folders and files in Google's own picker, and DeepWell can see only those.",
  modeFull: 'Read access to my whole Drive',
  modeFullHelp: 'DeepWell can read your Drive but never change it. You then choose which folders to bring in.',
  chooseFiles: 'Choose folders and files',
  chooseFolders: 'Choose folders',
  labels: 'Labels to bring attachments from',
  senders: 'Senders to bring attachments from',
  sendersHelp: 'Separate addresses with commas. Leave empty to use labels only.',
  lookback: 'Start with email from the last',
  save: 'Save choices',
  syncNow: 'Sync now',
  pause: 'Pause',
  resume: 'Resume',
  disconnect: 'Disconnect',
  confirmDisconnect: 'Files already in DeepWell stay. DeepWell stops checking Google and removes its access.',
  lastChecked: 'Last checked',
  imported: 'Files brought in',
  removed: 'No longer in Google',
  removedHelp: 'These were removed from Google after DeepWell brought them in. DeepWell keeps its copy.',
  notSetUp: 'Connecting Google is not available on this account yet.',
  adminOnly: 'Only a company admin can connect Google accounts.',
  signIn: 'Google asked you to sign in again. Choose Connect to continue.',
  paused: 'Paused. Nothing is being checked.',
  pickerBlurb: 'Choose the files you want DeepWell to read. DeepWell can see only the files you choose, nothing else in your Drive, and checks them regularly for changes.',
  pickerChoose: 'Choose files',
  pickerAddMore: 'Add more files',
  pickerFolderNote: 'Choose the files themselves. Open a folder in the window and select the files inside it. When you add new files to Drive later, choose them here too so DeepWell can see them.',
  pickerFoldersNotTaken: "Folders can't be chosen. Open the folder in the window and select the files inside it.",
  pickerSyncNote: 'DeepWell re-checks the files you chose and brings in new versions automatically.',
  pickerNeedsFiles: 'Choose the files DeepWell should bring in.',
};

const FLASH: Record<string, string> = {
  connected: 'Connected. Now choose what to bring in.',
  cancelled: 'Nothing was connected.',
  error: 'Google did not finish connecting. Please try again.',
};

export function ConnectedSourcesCard() {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    googleSyncClient.status().then((s) => { if (live) setStatus(s); }).catch(() => { if (live) setStatus({ enabled: false }); });
    return () => { live = false; };
  }, [tick]);

  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      const g = url.searchParams.get('google');
      if (g && FLASH[g]) {
        setFlash(FLASH[g]);
        url.searchParams.delete('google');
        window.history.replaceState({}, '', url.toString());
      }
    } catch { /* no URL access: no message */ }
  }, []);

  if (!status?.enabled) return null;
  const byProvider = (p: GoogleProvider) => status.connections?.find((c) => c.provider === p) ?? null;
  const used = status.usedToday ?? 0;

  return (
    <section className="dw-card p-4 sm:p-5 space-y-4" aria-labelledby="connected-sources-heading" data-testid="connected-sources">
      <div className="space-y-1">
        <h2 id="connected-sources-heading" className="text-h3 flex items-center gap-2">
          <Plug className="w-4 h-4" aria-hidden="true" />
          {TEXT.title}
        </h2>
        <p className="text-caption text-ink-2">{TEXT.intro}</p>
      </div>
      {flash && (
        <p role="status" className="text-body text-ink flex items-start gap-2 rounded-md border border-line bg-surface-2 p-3">
          <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
          <span className="flex-1">{flash}</span>
          <button type="button" aria-label="Dismiss" className="min-h-touch min-w-touch -my-2 -mr-2 inline-flex items-center justify-center" onClick={() => setFlash(null)}>
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <SourceBlock provider="drive" conn={byProvider('drive')} status={status} onChanged={reload} />
        {status.scopeMode !== 'picker' && <SourceBlock provider="gmail" conn={byProvider('gmail')} status={status} onChanged={reload} />}
      </div>
      {status.scopeMode === 'picker' && status.monthlyLimit ? (
        <p className="text-caption text-ink-3" data-testid="monthly-usage">Files brought in this month: {status.usedThisMonth ?? 0} of {status.monthlyLimit}.</p>
      ) : status.dailyLimit ? (
        <p className="text-caption text-ink-3">Files brought in today: {used} of {status.dailyLimit}.</p>
      ) : null}
    </section>
  );
}

function StatusPill({ conn }: { conn: GoogleConnection }) {
  if (conn.status === 'needs-reconnect') return <span className="dw-pill-warn">Sign in again</span>;
  if (conn.status === 'paused') return <span className="dw-pill-muted">Paused</span>;
  return <span className="dw-pill-ok">Connected</span>;
}

function SourceBlock({ provider, conn, status, onChanged }: { provider: GoogleProvider; conn: GoogleConnection | null; status: GoogleStatus; onChanged: () => void }) {
  const isDrive = provider === 'drive';
  const Icon = isDrive ? Folder : Mail;
  const title = isDrive ? TEXT.driveTitle : TEXT.gmailTitle;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [mode, setMode] = useState<'narrow' | 'full'>('narrow');
  const [confirming, setConfirming] = useState(false);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    setNote(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.'); } finally { setBusy(null); }
  };

  const connect = () => run('connect', async () => {
    const { url } = await googleSyncClient.start(provider, isDrive ? mode : undefined);
    window.location.assign(url);
  });

  return (
    <div className="rounded-lg border border-line p-4 space-y-3" data-testid={`source-${provider}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <h3 className="text-body font-medium text-ink flex items-center gap-2">
          <Icon className="w-4 h-4" aria-hidden="true" />
          {title}
        </h3>
        {conn && <StatusPill conn={conn} />}
      </div>

      {!conn ? (
        <>
          <p className="text-caption text-ink-2">{isDrive ? (status.scopeMode === 'picker' ? TEXT.pickerBlurb : TEXT.driveBlurb) : TEXT.gmailBlurb}</p>
          {isDrive && status.scopeMode !== 'picker' && (
            <fieldset className="space-y-2">
              <legend className="sr-only">How much of Google Drive DeepWell can see</legend>
              {([['narrow', TEXT.modeNarrow, TEXT.modeNarrowHelp], ['full', TEXT.modeFull, TEXT.modeFullHelp]] as const).map(([value, label, help]) => (
                <label key={value} className="flex items-start gap-3 min-h-touch cursor-pointer rounded-md border border-line p-3 has-[:checked]:border-line-2 has-[:checked]:bg-surface-2">
                  <input type="radio" name="drive-mode" className="mt-1 h-4 w-4" checked={mode === value} onChange={() => setMode(value)} />
                  <span className="space-y-0.5">
                    <span className="block text-body text-ink">{label}</span>
                    <span className="block text-caption text-ink-2">{help}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          {status.configured === false ? (
            <p className="text-caption text-ink-3">{TEXT.notSetUp}</p>
          ) : (
            <button type="button" className="dw-btn-primary" disabled={busy !== null} onClick={() => void connect()}>
              {busy === 'connect' && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
              {isDrive ? TEXT.connectDrive : TEXT.connectGmail}
            </button>
          )}
        </>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-caption">
            <div><dt className="text-ink-3">Account</dt><dd className="text-ink break-all">{conn.email ?? 'Connected'}</dd></div>
            <div><dt className="text-ink-3">{TEXT.lastChecked}</dt><dd className="text-ink">{relativeTime(conn.lastSyncAt)}</dd></div>
            <div><dt className="text-ink-3">{TEXT.imported}</dt><dd className="text-ink">{conn.filesImported}</dd></div>
            {conn.removedCount > 0 && <div><dt className="text-ink-3">{TEXT.removed}</dt><dd className="text-ink">{conn.removedCount}</dd></div>}
            {isDrive && status.scopeMode === 'picker' && (
              <>
                <div><dt className="text-ink-3">Files chosen</dt><dd className="text-ink" data-testid="count-chosen">{conn.choices.picked?.length ?? 0}</dd></div>
                <div><dt className="text-ink-3">Files read so far</dt><dd className="text-ink" data-testid="count-imported">{conn.importedCount}</dd></div>
                {(conn.skippedCount ?? 0) + conn.errorCount > 0 && <div><dt className="text-ink-3">Not brought in</dt><dd className="text-ink" data-testid="count-skipped">{(conn.skippedCount ?? 0) + conn.errorCount}</dd></div>}
              </>
            )}
          </dl>
          {conn.status === 'needs-reconnect' ? (
            <p className="text-body text-ink">{TEXT.signIn}</p>
          ) : conn.status === 'paused' ? (
            <p className="text-caption text-ink-2">{TEXT.paused}</p>
          ) : conn.lastResult ? (
            <p className="text-caption text-ink-2" data-testid={`result-${provider}`}>{conn.lastResult}</p>
          ) : null}
          {(conn.removed?.length ?? 0) > 0 && (
            <details className="text-caption text-ink-2">
              <summary className="min-h-touch inline-flex items-center cursor-pointer">{TEXT.removed}: {conn.removedCount}</summary>
              <p className="mb-1">{TEXT.removedHelp}</p>
              <ul className="list-disc pl-5">{conn.removed!.map((f, i) => <li key={i} className="break-words">{f.filename}</li>)}</ul>
            </details>
          )}
          {(conn.problems?.length ?? 0) > 0 && (
            <details className="text-caption text-ink-2">
              <summary className="min-h-touch inline-flex items-center cursor-pointer">Files that were not brought in: {conn.problems!.length}</summary>
              <ul className="list-disc pl-5 space-y-1">{conn.problems!.map((p, i) => <li key={i} className="break-words"><span className="text-ink">{p.filename}</span>{p.note ? `: ${p.note}` : ''}</li>)}</ul>
            </details>
          )}

          {conn.status !== 'needs-reconnect' && (
            isDrive
              ? <DriveChoices conn={conn} status={status} run={run} onChanged={onChanged} />
              : <GmailChoices conn={conn} status={status} run={run} onChanged={onChanged} />
          )}

          <div className="flex items-center gap-2 flex-wrap pt-1">
            {conn.status === 'needs-reconnect' ? (
              <button type="button" className="dw-btn-primary" disabled={busy !== null} onClick={() => void connect()}>
                {isDrive ? TEXT.connectDrive : TEXT.connectGmail}
              </button>
            ) : (
              <>
                <button type="button" className="dw-btn-secondary" disabled={busy !== null || conn.status === 'paused'}
                  onClick={() => void run('sync', async () => { const r = await googleSyncClient.syncNow(provider); setNote(r.result ?? 'Done.'); onChanged(); })}>
                  {busy === 'sync' && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
                  {TEXT.syncNow}
                </button>
                <button type="button" className="dw-btn-secondary" disabled={busy !== null}
                  onClick={() => void run('pause', async () => { await (conn.status === 'paused' ? googleSyncClient.resume(provider) : googleSyncClient.pause(provider)); onChanged(); })}>
                  {conn.status === 'paused' ? TEXT.resume : TEXT.pause}
                </button>
              </>
            )}
            {!confirming && <button type="button" className="dw-btn-tertiary min-h-touch" disabled={busy !== null} onClick={() => setConfirming(true)}>{TEXT.disconnect}</button>}
          </div>
          {confirming && (
            <div className="rounded-md border border-line bg-surface-2 p-3 space-y-2" role="group" aria-label={`Disconnect ${title}`}>
              <p className="text-caption text-ink-2">{TEXT.confirmDisconnect}</p>
              <div className="flex gap-2 flex-wrap">
                <button type="button" className="dw-btn-secondary" disabled={busy !== null}
                  onClick={() => void run('disconnect', async () => { await googleSyncClient.disconnect(provider); setConfirming(false); onChanged(); })}>
                  {busy === 'disconnect' && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
                  {TEXT.disconnect} {title}
                </button>
                <button type="button" className="dw-btn-tertiary min-h-touch" onClick={() => setConfirming(false)}>Keep it connected</button>
              </div>
            </div>
          )}
        </>
      )}
      {note && <p role="status" className="text-caption text-ink-2">{note}</p>}
      {error && <p role="alert" className="text-caption text-bad-ink">{error}</p>}
    </div>
  );
}

type Runner = (label: string, fn: () => Promise<void>) => Promise<void>;

function DriveChoices({ conn, status, run, onChanged }: { conn: GoogleConnection; status: GoogleStatus; run: Runner; onChanged: () => void }) {
  const picked: Picked[] = conn.choices.picked ?? [];
  const [browsing, setBrowsing] = useState(false);
  const [trail, setTrail] = useState<Array<{ id: string; name: string }>>([]);
  const [folders, setFolders] = useState<Array<{ id: string; name: string }> | null>(null);
  const full = conn.scopeMode === 'full';
  const pickerMode = status.scopeMode === 'picker';
  const [folderMsg, setFolderMsg] = useState<string | null>(null);

  const save = (next: Picked[]) => run('save', async () => { await googleSyncClient.saveDrive(next); onChanged(); });
  const open = (parentId?: string) => run('browse', async () => { setFolders(null); setFolders(await googleSyncClient.folders(parentId)); });

  return (
    <div className="space-y-2">
      {picked.length === 0 ? (
        <p className="text-body text-ink">{pickerMode ? TEXT.pickerNeedsFiles : 'Choose what DeepWell should bring in.'}</p>
      ) : (
        <ul className="space-y-1" aria-label="Chosen folders and files">
          {picked.slice(0, 25).map((p) => (
            <li key={p.id} className="flex items-center gap-2 rounded-md border border-line pl-3">
              <span className="flex-1 text-body text-ink break-words py-2">{p.name || p.id}</span>
              <button type="button" aria-label={`Stop bringing in ${p.name || 'this item'}`} className="min-h-touch min-w-touch inline-flex items-center justify-center"
                onClick={() => void save(picked.filter((x) => x.id !== p.id))}>
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </li>
          ))}
          {picked.length > 25 && <li className="text-caption text-ink-3 pl-3">and {picked.length - 25} more</li>}
        </ul>
      )}
      {full ? (
        <>
          <button type="button" className="dw-btn-secondary" onClick={() => { setBrowsing(true); setTrail([]); void open(); }}>{TEXT.chooseFolders}</button>
          {browsing && (
            <div className="rounded-md border border-line p-3 space-y-2">
              <p className="text-caption text-ink-3 break-words">{['My Drive', ...trail.map((t) => t.name)].join(' / ')}</p>
              {trail.length > 0 && (
                <button type="button" className="dw-btn-tertiary min-h-touch" onClick={() => { const t = trail.slice(0, -1); setTrail(t); void open(t[t.length - 1]?.id); }}>Back</button>
              )}
              {folders === null ? <Loader2 className="w-4 h-4 animate-spin" aria-label="Loading" /> : folders.length === 0 ? <p className="text-caption text-ink-2">No more folders here.</p> : (
                <ul className="space-y-1">
                  {folders.map((f) => {
                    const on = picked.some((p) => p.id === f.id);
                    return (
                      <li key={f.id} className="flex items-center gap-1">
                        <button type="button" className="flex-1 text-left min-h-touch px-2 rounded-md hover:bg-surface-2 break-words" onClick={() => { setTrail([...trail, f]); void open(f.id); }}>{f.name}</button>
                        <button type="button" className={on ? "dw-btn-tertiary min-h-touch" : "dw-btn-secondary"} disabled={on}
                          onClick={() => void save([...picked, { id: f.id, name: f.name, kind: 'folder' }])}>{on ? 'Added' : 'Add'}</button>
                      </li>
                    );
                  })}
                </ul>
              )}
              <button type="button" className="dw-btn-tertiary min-h-touch" onClick={() => setBrowsing(false)}>Done</button>
            </div>
          )}
        </>
      ) : (
        <>
          <button type="button" className="dw-btn-secondary" disabled={!status.pickerReady}
            onClick={() => void run('picker', async () => {
              setFolderMsg(null);
              const tok = await googleSyncClient.pickerToken();
              await openGooglePicker(tok, (items) => {
                const files = pickerMode ? items.filter((it) => it.kind !== 'folder') : items;
                if (files.length < items.length) setFolderMsg(TEXT.pickerFoldersNotTaken);
                const merged = [...picked]; for (const it of files) if (!merged.some((m) => m.id === it.id)) merged.push(it);
                if (files.length) void save(merged);
              });
            })}>
            {pickerMode ? (picked.length ? TEXT.pickerAddMore : TEXT.pickerChoose) : TEXT.chooseFiles}
          </button>
          {pickerMode && <p className="text-caption text-ink-2" data-testid="picker-note">{TEXT.pickerFolderNote}</p>}
          {pickerMode && picked.length > 0 && <p className="text-caption text-ink-3">{TEXT.pickerSyncNote}</p>}
          {folderMsg && <p role="status" className="text-caption text-ink-2">{folderMsg}</p>}
        </>
      )}
    </div>
  );
}

function GmailChoices({ conn, status, run, onChanged }: { conn: GoogleConnection; status: GoogleStatus; run: Runner; onChanged: () => void }) {
  const [available, setAvailable] = useState<Array<{ id: string; name: string }> | null>(null);
  const [labelIds, setLabelIds] = useState<string[]>(conn.choices.labelIds ?? []);
  const [senders, setSenders] = useState((conn.choices.senders ?? []).join(', '));
  const [lookback, setLookback] = useState(conn.choices.lookbackDays ?? 30);
  const known = new Map<string, string>((conn.choices.labelIds ?? []).map((id, i) => [id, conn.choices.labelNames?.[i] ?? id]));
  for (const l of available ?? []) known.set(l.id, l.name);
  const options = available ?? [...known].map(([id, name]) => ({ id, name }));

  return (
    <div className="space-y-3">
      <fieldset className="space-y-1">
        <legend className="dw-label mb-1">{TEXT.labels}</legend>
        {available === null && (
          <button type="button" className="dw-btn-secondary" onClick={() => void run('labels', async () => setAvailable(await googleSyncClient.labels()))}>Show my labels</button>
        )}
        {options.map((l) => (
          <label key={l.id} className="flex items-center gap-3 min-h-touch cursor-pointer">
            <input type="checkbox" className="h-4 w-4" checked={labelIds.includes(l.id)} onChange={(e) => setLabelIds(e.target.checked ? [...labelIds, l.id] : labelIds.filter((x) => x !== l.id))} />
            <span className="text-body text-ink break-words">{l.name}</span>
          </label>
        ))}
      </fieldset>
      <div className="space-y-1">
        <label htmlFor="gmail-senders" className="dw-label">{TEXT.senders}</label>
        <input id="gmail-senders" className="dw-input" value={senders} onChange={(e) => setSenders(e.target.value)} placeholder="billing@supplier.com" inputMode="email" autoComplete="off" />
        <p className="text-caption text-ink-3">{TEXT.sendersHelp}</p>
      </div>
      <div className="space-y-1">
        <label htmlFor="gmail-lookback" className="dw-label">{TEXT.lookback}</label>
        <select id="gmail-lookback" className="dw-input" value={lookback} onChange={(e) => setLookback(Number(e.target.value))}>
          {(status.lookbackChoices ?? [7, 30, 90]).map((d) => <option key={d} value={d}>{d} days</option>)}
        </select>
      </div>
      <button type="button" className="dw-btn-primary" onClick={() => void run('save', async () => {
        await googleSyncClient.saveGmail(labelIds.map((id) => ({ id, name: known.get(id) ?? id })), senders, lookback);
        onChanged();
      })}>{TEXT.save}</button>
    </div>
  );
}
