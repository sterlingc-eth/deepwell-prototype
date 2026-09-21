import { useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Clipboard, Loader2, Mail, RefreshCw, UserCog } from 'lucide-react';
import {
  fetchFollowupsSettings,
  runFollowups,
  saveFollowupsSettings,
  type FollowupPreviewItem,
  type FollowupsSettings,
} from '../services/followupsClient';

/**
 * Admin-only "Follow-ups" card (owner brief item 3,
 * handoffs/TECH_FOLLOWUPS_2026-09-21.md) — Team screen. Off by default;
 * turning it on lets the nightly sweep (and this card's own "Check now" /
 * "Send now") message a technician when one of their documents is missing a
 * required detail. Mirrors OutreachScreen's copy/mailto fallback so nothing
 * here needs an email account to be useful — "Send now" additionally drops
 * an in-app notification per technician, and emails too when "Also email" is
 * on and Resend is configured.
 */
export function FollowupsCard() {
  const [settings, setSettings] = useState<FollowupsSettings | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<FollowupPreviewItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastApplied, setLastApplied] = useState<{ messagesSent: number; emailsSent: number } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    fetchFollowupsSettings()
      .then(setSettings)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load follow-up settings.'));
  }, []);

  const refreshPreview = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await runFollowups(false);
      setPreview(result.preview);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not check for follow-ups.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (settings?.enabled && open && preview === null) void refreshPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.enabled, open]);

  const toggle = (patch: Partial<Pick<FollowupsSettings, 'enabled' | 'email'>>) => {
    if (!settings) return;
    const previous = settings;
    setSettings({ ...settings, ...patch });
    setSavingSettings(true);
    saveFollowupsSettings(patch)
      .then(setSettings)
      .catch((e) => {
        setError(e instanceof Error ? e.message : 'Could not save follow-up settings.');
        setSettings(previous);
      })
      .finally(() => setSavingSettings(false));
  };

  const sendNow = async () => {
    setApplying(true);
    setError(null);
    try {
      const result = await runFollowups(true);
      setLastApplied({ messagesSent: result.messagesSent, emailsSent: result.emailsSent });
      setPreview(result.preview);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send follow-ups.');
    } finally {
      setApplying(false);
    }
  };

  const copyMessage = async (item: FollowupPreviewItem) => {
    try {
      await navigator.clipboard.writeText(`Subject: ${item.subject}\n\n${item.text}`);
      setCopiedId(item.userId);
      setTimeout(() => setCopiedId((c) => (c === item.userId ? null : c)), 2000);
    } catch {
      setError('Could not copy to your clipboard — your browser may be blocking it.');
    }
  };

  const openInMail = (item: FollowupPreviewItem) => {
    const url = `mailto:${item.email ? encodeURIComponent(item.email) : ''}?subject=${encodeURIComponent(item.subject)}&body=${encodeURIComponent(item.text)}`;
    window.location.href = url;
  };

  const enabled = settings?.enabled ?? false;
  const email = settings?.email ?? false;
  const emailAvailable = settings?.emailAvailable ?? false;

  return (
    <div className="dw-card p-4 space-y-3">
      <button type="button" className="w-full flex items-center justify-between text-left" onClick={() => setOpen((v) => !v)}>
        <span className="text-body font-medium text-ink flex items-center gap-2">
          <UserCog className="w-4 h-4" aria-hidden="true" />
          Follow-ups
          <span className={enabled ? 'dw-pill-ok' : 'dw-pill-muted'}>{enabled ? 'On' : 'Off'}</span>
        </span>
        {open ? <ChevronUp className="w-4 h-4" aria-hidden="true" /> : <ChevronDown className="w-4 h-4" aria-hidden="true" />}
      </button>

      {open && (
        <div className="space-y-3 pt-1">
          <p className="text-caption text-ink-3">
            When a document is missing something Donovan needs — a serial number, an install date — send the
            technician responsible a short message asking for it, with a link straight to their own work. At most
            one message per technician per day.
          </p>

          {error && <p role="alert" className="text-caption text-bad-ink">{error}</p>}

          <label className="flex items-center justify-between gap-3">
            <span className="text-body text-ink-2">Send follow-up messages</span>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              disabled={!settings || savingSettings}
              onClick={() => toggle({ enabled: !enabled })}
              className={[
                'relative inline-flex items-center h-6 w-11 rounded-full transition-colors duration-quick shrink-0',
                enabled ? 'bg-forest-700' : 'bg-line',
                !settings ? 'opacity-50' : '',
              ].join(' ')}
            >
              <span className={['inline-block h-4 w-4 transform rounded-full bg-stone-0 transition-transform duration-quick', enabled ? 'translate-x-6' : 'translate-x-1'].join(' ')} />
            </button>
          </label>

          <div>
            <label className="flex items-center justify-between gap-3">
              <span className="text-body text-ink-2">Also email</span>
              <button
                type="button"
                role="switch"
                aria-checked={email}
                disabled={!settings || savingSettings || !emailAvailable}
                onClick={() => toggle({ email: !email })}
                className={[
                  'relative inline-flex items-center h-6 w-11 rounded-full transition-colors duration-quick shrink-0',
                  email ? 'bg-forest-700' : 'bg-line',
                  !emailAvailable ? 'opacity-50' : '',
                ].join(' ')}
              >
                <span className={['inline-block h-4 w-4 transform rounded-full bg-stone-0 transition-transform duration-quick', email ? 'translate-x-6' : 'translate-x-1'].join(' ')} />
              </button>
            </label>
            {!emailAvailable && <p className="text-caption text-ink-3 mt-1">Needs an email provider configured — in-app only for now.</p>}
          </div>

          {enabled && (
            <div className="space-y-2 pt-2 border-t border-line">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="dw-label">Currently due</h3>
                <div className="flex gap-2">
                  <button type="button" onClick={() => void refreshPreview()} disabled={loading} className="dw-btn-tertiary !min-h-[32px] !py-0.5">
                    {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />}
                    Check now
                  </button>
                  {(preview?.length ?? 0) > 0 && (
                    <button type="button" onClick={() => void sendNow()} disabled={applying} className="dw-btn-primary !min-h-[32px] !py-0.5">
                      {applying ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : null} Send now
                    </button>
                  )}
                </div>
              </div>

              {lastApplied && (
                <p className="text-caption text-ink-3">
                  Sent {lastApplied.messagesSent} message{lastApplied.messagesSent === 1 ? '' : 's'}
                  {lastApplied.emailsSent > 0 ? ` (${lastApplied.emailsSent} emailed)` : ''}.
                </p>
              )}

              <ul className="space-y-2">
                {(preview ?? []).map((item) => (
                  <li key={item.userId} className="dw-card p-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-body text-ink">{item.name}</p>
                      <p className="text-caption text-ink-3">{item.subject}</p>
                    </div>
                    <div className="flex flex-wrap gap-1.5 shrink-0">
                      <button type="button" onClick={() => void copyMessage(item)} className="dw-btn-tertiary !min-h-[32px] !py-0.5">
                        {copiedId === item.userId ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : <Clipboard className="w-3.5 h-3.5" aria-hidden="true" />}
                        {copiedId === item.userId ? 'Copied' : 'Copy message'}
                      </button>
                      <button type="button" onClick={() => openInMail(item)} disabled={!item.email} className="dw-btn-tertiary !min-h-[32px] !py-0.5 disabled:opacity-50">
                        <Mail className="w-3.5 h-3.5" aria-hidden="true" /> Open in mail
                      </button>
                    </div>
                  </li>
                ))}
                {preview && preview.length === 0 && <li className="text-body text-ink-3">Nobody's due a follow-up right now.</li>}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
