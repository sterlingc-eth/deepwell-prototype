import { useCallback, useEffect, useState } from 'react';
import { Clock, Loader2, ShieldCheck } from 'lucide-react';
import {
  SUPPORT_ACCESS_CHANGED,
  endSupportAccess,
  fetchSupportAccessStatus,
  grantSupportAccessFromChat,
  type SupportAccessStatus,
  type SupportSurface,
} from '../../services/supportClient';

/** "3:42 PM" for today, "Oct 11, 3:42 PM" otherwise. */
export function formatAccessEnd(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Re-reads support-access status on mount, and whenever a grant or end happens anywhere in this tab. */
function useAccessStatus(surface: SupportSurface) {
  const [status, setStatus] = useState<SupportAccessStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const load = useCallback(() => {
    void fetchSupportAccessStatus(surface).then((r) => {
      if (r.ok) setStatus(r.data);
      setNow(Date.now());
    });
  }, [surface]);
  useEffect(() => {
    load();
    window.addEventListener(SUPPORT_ACCESS_CHANGED, load);
    return () => window.removeEventListener(SUPPORT_ACCESS_CHANGED, load);
  }, [load]);
  const expiresMs = status?.active ? Date.parse(status.active.expiresAt) : null;
  // The grant expires on its own: drop the banner at that moment without another request.
  useEffect(() => {
    if (expiresMs == null) return;
    const wait = expiresMs - Date.now();
    if (wait <= 0) return;
    const t = setTimeout(() => setNow(Date.now()), Math.min(wait + 500, 2_000_000_000));
    return () => clearTimeout(t);
  }, [expiresMs]);
  const active = status?.active && Date.parse(status.active.expiresAt) > now ? status.active : null;
  return { status, active };
}

/**
 * Help-chat offer shown next to "Send this to a person": admins get one tap to let DeepWell support look for
 * 24 hours (with an optional note you write); everyone else is told how to ask their admin.
 */
export function SupportAccessOffer({ surface, companyName }: { surface: SupportSurface; companyName?: string }) {
  const { status, active } = useAccessStatus(surface);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justGranted, setJustGranted] = useState(false);
  const [note, setNote] = useState('');

  if (!status) return null;
  if (active) {
    return (
      <p role="status" className="mt-2 text-body text-ink-2 flex items-start gap-2">
        <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0 text-ok-ink" aria-hidden="true" />
        <span>
          {justGranted ? 'Done. ' : ''}Support can see your account until {formatAccessEnd(active.expiresAt)}.
          {justGranted ? ' The team has been told.' : ''}
        </span>
      </p>
    );
  }
  if (!status.isAdmin) {
    return (
      <p className="mt-2 text-body text-ink-2">
        To let support look at your account, ask your company admin to open Team, then Support access.
      </p>
    );
  }
  const grant = async () => {
    setBusy(true);
    setError(null);
    const r = await grantSupportAccessFromChat({ surface, note, companyName });
    setBusy(false);
    if (r.ok) setJustGranted(true);
    else setError(r.error.message);
  };
  return (
    <div className="mt-2">
      <label className="block">
        <span className="block text-caption text-ink-3">Add a note for support (optional)</span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, 200))}
          rows={2}
          maxLength={200}
          className="mt-1 w-full rounded-lg border border-line-2 bg-surface text-ink text-body px-3 py-2"
        />
      </label>
      <p className="m-0 mb-2 mt-1 text-caption text-ink-3">Support is told your company and this note only. Nothing else from the chat is shared.</p>
      <button
        type="button"
        disabled={busy}
        onClick={() => void grant()}
        className="min-h-11 px-4 rounded-full border border-line-2 bg-surface text-ink font-medium text-body inline-flex items-center gap-2 disabled:opacity-60"
      >
        {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <ShieldCheck className="w-4 h-4" aria-hidden="true" />}
        Let DeepWell support look for 24 hours
      </button>
      <p className="m-0 mt-1 text-caption text-ink-3">Support can see your account for 24 hours. You can end it any time.</p>
      {error && <p role="alert" className="m-0 mt-1 text-body text-warn-ink">{error}</p>}
    </div>
  );
}

/**
 * Always-visible notice while a grant is active, on every screen the help button is on. Admins get "End now".
 * Fixed bottom-left so it never covers the header or the help button.
 */
export function SupportAccessBanner({ surface }: { surface: SupportSurface }) {
  const { status, active } = useAccessStatus(surface);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!active) return null;
  const end = async () => {
    setBusy(true);
    setError(null);
    const r = await endSupportAccess(surface, active.id);
    setBusy(false);
    if (!r.ok) setError(r.error.message);
  };
  return (
    <div
      role="status"
      data-testid="support-access-banner"
      className="fixed z-30 print:hidden left-4 right-[5.5rem] bottom-4 sm:right-auto sm:max-w-md rounded-xl border border-brass-500/50 bg-surface text-ink shadow-lift px-3.5 py-2.5 text-body flex items-center gap-x-3 gap-y-1 flex-wrap"
      style={{ bottom: 'max(1rem, env(safe-area-inset-bottom))' }}
    >
      <Clock className="w-4 h-4 shrink-0 text-brass-500" aria-hidden="true" />
      <span className="flex-1 min-w-[10rem]">Support can see your account until {formatAccessEnd(active.expiresAt)}</span>
      {status?.isAdmin && (
        <button type="button" disabled={busy} onClick={() => void end()} className="min-h-11 px-3 -my-1 underline underline-offset-2 font-semibold text-accent-ink disabled:opacity-60">
          {busy ? 'Ending…' : 'End now'}
        </button>
      )}
      {error && <span role="alert" className="basis-full text-caption text-warn-ink">{error}</span>}
    </div>
  );
}
