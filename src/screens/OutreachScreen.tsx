import { useEffect, useMemo, useState } from 'react';
import { useAuth, useOrganization } from '@clerk/clerk-react';
import { AlertTriangle, ArrowLeft, Check, ChevronDown, ChevronUp, Clipboard, Loader2, Mail, RefreshCw, Send, X } from 'lucide-react';
import { AppShell } from '../components/AppShell';
import { useAppStore } from '../store/appStore';
import { isAdminRole } from '../services/teamClient';
import {
  approveAllOutreach,
  approveOutreach,
  fetchOutreachSettings,
  generateOutreachDrafts,
  listOutreachMessages,
  previewOutreach,
  saveOutreachSettings,
  sendApprovedOutreach,
  sentThisMonth,
  skipOutreach,
  type GenerateResult,
  type OutreachMessage,
  type OutreachSettings,
} from '../services/outreachClient';

const TIER_LABEL: Record<OutreachMessage['tier'], string> = {
  'expiring-90': 'Expires in 90 days',
  'expiring-30': 'Expires in 30 days',
  expired: 'Expired',
};

/**
 * Customer outreach (handoffs/OUTREACH_2026-09-20.md): automated email to
 * customers close to (or past) the end of their equipment's warranty,
 * pitching an extended warranty / maintenance agreement. Reached from the
 * Dashboard's "Customer outreach" card and "Open in Outreach" buttons, or a
 * `?screen=outreach` deep link — not part of the primary nav (Ask ·
 * Dashboard · Inbox · Records stays exactly four).
 */
export function OutreachScreen() {
  const { orgRole } = useAuth();
  const admin = isAdminRole(orgRole ?? null);
  const { organization } = useOrganization();
  const setCurrentScreen = useAppStore((s) => s.setCurrentScreen);
  const pendingEquipmentId = useAppStore((s) => s.pendingOutreachEquipmentId);
  const clearPendingOutreachEquipment = useAppStore((s) => s.clearPendingOutreachEquipment);

  const [settings, setSettings] = useState<OutreachSettings | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<Partial<OutreachSettings>>({});
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [items, setItems] = useState<OutreachMessage[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateNote, setGenerateNote] = useState<GenerateResult | null>(null);
  const [sending, setSending] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedBody, setExpandedBody] = useState<Record<string, string>>({});
  const [notFoundNote, setNotFoundNote] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const load = async () => {
    setLoadError(null);
    try {
      const [s, l] = await Promise.all([fetchOutreachSettings(), listOutreachMessages('all', 200)]);
      setSettings(s);
      setItems(l.items);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load outreach data.');
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "Open in Outreach" from the Dashboard: make sure a draft exists for the
  // preselected unit, then highlight it. Runs once per preselect.
  useEffect(() => {
    if (!pendingEquipmentId || !settings || settings.migrationPending) return;
    void (async () => {
      try {
        await generateOutreachDrafts();
        const l = await listOutreachMessages('all', 200);
        setItems(l.items);
        const match = l.items.find((i) => i.equipmentId === pendingEquipmentId);
        if (match) {
          setExpandedId(match.id);
          setNotFoundNote(false);
        } else {
          setNotFoundNote(true);
        }
      } catch {
        setNotFoundNote(true);
      } finally {
        clearPendingOutreachEquipment();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingEquipmentId, settings?.migrationPending]);

  const drafts = useMemo(() => (items ?? []).filter((i) => i.status === 'draft'), [items]);
  const approved = useMemo(() => (items ?? []).filter((i) => i.status === 'approved'), [items]);
  const sentLog = useMemo(
    () => (items ?? []).filter((i) => ['sent', 'failed', 'skipped', 'bounced'].includes(i.status)).slice(0, 50),
    [items]
  );
  const sentCount = useMemo(() => sentThisMonth(items ?? []), [items]);

  const runGenerate = async () => {
    setGenerating(true);
    setGenerateNote(null);
    try {
      const result = await generateOutreachDrafts();
      setGenerateNote(result);
      await load();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not generate drafts.');
    } finally {
      setGenerating(false);
    }
  };

  const withBusy = async (ids: string[], fn: () => Promise<void>) => {
    setBusyIds((s) => new Set([...s, ...ids]));
    try {
      await fn();
      await load();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'That action failed.');
    } finally {
      setBusyIds((s) => {
        const next = new Set(s);
        for (const id of ids) next.delete(id);
        return next;
      });
    }
  };

  const toggleExpand = async (msg: OutreachMessage) => {
    if (expandedId === msg.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(msg.id);
    if (!expandedBody[msg.id]) {
      try {
        const full = await previewOutreach(msg.id);
        setExpandedBody((s) => ({ ...s, [msg.id]: full.bodyText }));
      } catch {
        /* falls back to the short preview already shown */
      }
    }
  };

  // REQUEST 2a (draft-to-copy, 2026-09-21): the base flow needs no email
  // provider at all — "Copy email" and "Open in your mail app" work off the
  // exact same deterministic draft the review queue already shows.
  const fullBodyFor = async (msg: OutreachMessage): Promise<string> => {
    const cached = expandedBody[msg.id];
    if (cached) return cached;
    try {
      const full = await previewOutreach(msg.id);
      setExpandedBody((s) => ({ ...s, [msg.id]: full.bodyText }));
      return full.bodyText;
    } catch {
      return msg.preview; // short preview beats nothing if the fetch fails
    }
  };

  const copyMessage = async (msg: OutreachMessage) => {
    const body = await fullBodyFor(msg);
    try {
      await navigator.clipboard.writeText(`Subject: ${msg.subject}\n\n${body}`);
      setCopiedId(msg.id);
      setTimeout(() => setCopiedId((c) => (c === msg.id ? null : c)), 2000);
    } catch {
      setLoadError('Could not copy to your clipboard — your browser may be blocking it.');
    }
  };

  const openInMail = async (msg: OutreachMessage) => {
    const body = await fullBodyFor(msg);
    const url = `mailto:${encodeURIComponent(msg.toEmail)}?subject=${encodeURIComponent(msg.subject)}&body=${encodeURIComponent(body)}`;
    window.location.href = url;
  };

  const saveSettings = async () => {
    setSavingSettings(true);
    try {
      const next = await saveOutreachSettings(settingsDraft);
      setSettings(next);
      setSettingsDraft({});
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not save settings.');
    } finally {
      setSavingSettings(false);
    }
  };

  const enabled = settingsDraft.enabled ?? settings?.enabled ?? false;
  const mode = settingsDraft.mode ?? settings?.mode ?? 'review';
  const leadDays = settingsDraft.leadDays ?? settings?.leadDays ?? 90;
  const fromName = settingsDraft.fromName ?? settings?.fromName ?? '';
  const replyTo = settingsDraft.replyTo ?? settings?.replyTo ?? '';
  const offerText = settingsDraft.offerText ?? settings?.offerText ?? '';
  const shopName = settingsDraft.shopName ?? settings?.shopName ?? '';
  const shopPhone = settingsDraft.shopPhone ?? settings?.shopPhone ?? '';
  const signature = settingsDraft.signature ?? settings?.signature ?? '';
  const outreachAutoEntitled = settings?.outreachAutoEntitled ?? false;
  const hasSettingsChanges = Object.keys(settingsDraft).length > 0;

  return (
    <AppShell>
      <div className="space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <button type="button" onClick={() => setCurrentScreen('dashboard')} className="dw-btn-tertiary !min-h-[32px] !py-1 mb-2">
              <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" /> Back to Dashboard
            </button>
            <h1 className="flex items-center gap-2">
              <Mail className="w-5 h-5" aria-hidden="true" /> Customer outreach
            </h1>
            <p className="text-ink-2 mt-1">
              Donovan drafts a plain-English email for every customer whose equipment is close to — or past — the
              end of its warranty. Copy it or open it in your own mail app to send it — no email account needed.
              Want Donovan to send it for you automatically? That's an optional add-on.
            </p>
          </div>
        </header>

        {loadError && (
          <div role="alert" className="dw-card border-bad/40 px-4 py-3 text-bad-ink flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" /> {loadError}
          </div>
        )}

        {settings?.migrationPending && (
          <div role="alert" className="dw-card border-warn/40 px-4 py-3 text-warn-ink flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
            Needs a database update. Ask whoever manages DeepWell's database to apply the latest migration, then
            reload this page.
          </div>
        )}

        {notFoundNote && (
          <div className="dw-card px-4 py-3 text-body text-ink-2">
            That unit doesn't have a draft yet — it may not have a customer email on file, or its warranty isn't
            close enough to qualify.
          </div>
        )}

        {/* ---- Settings ---- */}
        <section className="dw-card p-4 space-y-3">
          <button type="button" className="w-full flex items-center justify-between text-left" onClick={() => setSettingsOpen((v) => !v)}>
            <span className="text-body font-medium text-ink flex items-center gap-2">
              Settings
              <span className={enabled ? 'dw-pill-ok' : 'dw-pill-muted'}>{enabled ? `On · ${mode === 'auto' ? 'Automatic' : 'Review first'}` : 'Off'}</span>
            </span>
            {settingsOpen ? <ChevronUp className="w-4 h-4" aria-hidden="true" /> : <ChevronDown className="w-4 h-4" aria-hidden="true" />}
          </button>

          {settingsOpen && (
            <div className="space-y-4 pt-2">
              <label className="flex items-center justify-between gap-3">
                <span className="text-body text-ink-2">Send outreach emails</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={enabled}
                  disabled={!admin}
                  onClick={() => setSettingsDraft((d) => ({ ...d, enabled: !enabled }))}
                  className={['relative inline-flex items-center h-6 w-11 rounded-full transition-colors duration-quick shrink-0', enabled ? 'bg-forest-700' : 'bg-line', !admin ? 'opacity-50' : ''].join(' ')}
                >
                  <span className={['inline-block h-4 w-4 transform rounded-full bg-stone-0 transition-transform duration-quick', enabled ? 'translate-x-6' : 'translate-x-1'].join(' ')} />
                </button>
              </label>

              <div className="grid sm:grid-cols-2 gap-3">
                <button
                  type="button"
                  disabled={!admin}
                  onClick={() => setSettingsDraft((d) => ({ ...d, mode: 'review' }))}
                  className={['dw-card p-3 text-left disabled:opacity-50', mode === 'review' ? 'ring-2 ring-accent' : ''].join(' ')}
                >
                  <p className="text-body font-medium text-ink">Review first</p>
                  <p className="text-caption text-ink-3 mt-1">
                    Donovan drafts each one for you to check — copy it or open it in your mail app whenever you're
                    ready. No email account needed.
                  </p>
                </button>
                {outreachAutoEntitled ? (
                  <button
                    type="button"
                    disabled={!admin}
                    onClick={() => setSettingsDraft((d) => ({ ...d, mode: 'auto' }))}
                    className={['dw-card p-3 text-left disabled:opacity-50', mode === 'auto' ? 'ring-2 ring-accent' : ''].join(' ')}
                  >
                    <p className="text-body font-medium text-ink">Automatic</p>
                    <p className="text-caption text-ink-3 mt-1">
                      Every night, new drafts are approved and emailed automatically — no review step.
                    </p>
                  </button>
                ) : (
                  <div className="dw-card p-3 text-left opacity-90">
                    <p className="text-body font-medium text-ink flex items-center gap-1.5">
                      Automatic <span className="dw-pill-muted">Add-on</span>
                    </p>
                    <p className="text-caption text-ink-3 mt-1">
                      Auto-send is an add-on — Donovan sends approved drafts for you, no clicking required.{' '}
                      <button type="button" className="underline font-medium" onClick={() => setCurrentScreen('billing')}>
                        See plans
                      </button>
                    </p>
                  </div>
                )}
              </div>

              <label className="block">
                <span className="text-caption text-ink-3">Reach out this many days before a warranty expires</span>
                <input
                  type="number"
                  min={1}
                  max={365}
                  disabled={!admin}
                  value={leadDays}
                  onChange={(e) => setSettingsDraft((d) => ({ ...d, leadDays: Number(e.target.value) || 90 }))}
                  className="dw-input mt-1 w-32"
                />
              </label>

              <label className="block">
                <span className="text-caption text-ink-3">Shop name (shown in the email)</span>
                <input
                  type="text"
                  disabled={!admin}
                  value={shopName}
                  placeholder={organization?.name || "Your shop's name"}
                  onChange={(e) => setSettingsDraft((d) => ({ ...d, shopName: e.target.value }))}
                  className="dw-input mt-1 w-full"
                />
              </label>

              <label className="block">
                <span className="text-caption text-ink-3">Shop phone (optional — offered as a way to reply)</span>
                <input
                  type="tel"
                  disabled={!admin}
                  value={shopPhone}
                  placeholder="(555) 555-0100"
                  onChange={(e) => setSettingsDraft((d) => ({ ...d, shopPhone: e.target.value }))}
                  className="dw-input mt-1 w-full"
                />
              </label>

              <label className="block">
                <span className="text-caption text-ink-3">From name (the person signing — optional)</span>
                <input
                  type="text"
                  disabled={!admin}
                  value={fromName}
                  placeholder="e.g. Dana"
                  onChange={(e) => setSettingsDraft((d) => ({ ...d, fromName: e.target.value }))}
                  className="dw-input mt-1 w-full"
                />
              </label>

              <label className="block">
                <span className="text-caption text-ink-3">Signature line (optional — overrides the sign-off above)</span>
                <input
                  type="text"
                  disabled={!admin}
                  value={signature}
                  placeholder="e.g. Dana, Acme HVAC"
                  onChange={(e) => setSettingsDraft((d) => ({ ...d, signature: e.target.value }))}
                  className="dw-input mt-1 w-full"
                />
              </label>

              <label className="block">
                <span className="text-caption text-ink-3">Reply-to email</span>
                <input
                  type="email"
                  disabled={!admin}
                  value={replyTo}
                  placeholder="service@yourshop.com"
                  onChange={(e) => setSettingsDraft((d) => ({ ...d, replyTo: e.target.value }))}
                  className="dw-input mt-1 w-full"
                />
              </label>

              <label className="block">
                <span className="text-caption text-ink-3">Offer (shown in the email body)</span>
                <textarea
                  disabled={!admin}
                  value={offerText}
                  placeholder="We offer an extended warranty and maintenance agreement that covers parts and labor beyond the manufacturer's terms."
                  onChange={(e) => setSettingsDraft((d) => ({ ...d, offerText: e.target.value }))}
                  rows={3}
                  className="dw-input mt-1 w-full"
                />
              </label>

              {admin ? (
                <button type="button" disabled={!hasSettingsChanges || savingSettings} onClick={() => void saveSettings()} className="dw-btn-primary">
                  {savingSettings ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : null} Save settings
                </button>
              ) : (
                <p className="text-caption text-ink-3">Only a shop admin can change these settings.</p>
              )}
            </div>
          )}
        </section>

        {/* ---- Overview ---- */}
        <section className="grid grid-cols-3 gap-3">
          <div className="dw-card p-4">
            <p className="text-caption text-ink-3">Drafts ready</p>
            <p className="font-display text-h1 mt-1">{drafts.length}</p>
          </div>
          <div className="dw-card p-4">
            <p className="text-caption text-ink-3">Sent this month</p>
            <p className="font-display text-h1 mt-1">{sentCount}</p>
          </div>
          <div className="dw-card p-4">
            <p className="text-caption text-ink-3">Needs an email on file</p>
            <p className="font-display text-h1 mt-1">{generateNote?.needsEmail ?? 0}</p>
          </div>
        </section>

        {/* ---- Drafts ---- */}
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="dw-label">Drafts · {drafts.length}</h2>
            <div className="flex gap-2">
              <button type="button" onClick={() => void runGenerate()} disabled={generating} className="dw-btn-secondary !min-h-[36px] !py-1">
                {generating ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />}
                Generate drafts
              </button>
              {drafts.length > 0 && (
                <button
                  type="button"
                  onClick={() => void withBusy(drafts.map((d) => d.id), () => approveAllOutreach().then(() => undefined))}
                  className="dw-btn-secondary !min-h-[36px] !py-1"
                >
                  Approve all
                </button>
              )}
              {approved.length > 0 && admin && (
                <button
                  type="button"
                  disabled={sending}
                  onClick={() =>
                    void (async () => {
                      setSending(true);
                      try {
                        await sendApprovedOutreach();
                        await load();
                      } catch (e) {
                        setLoadError(e instanceof Error ? e.message : 'Send failed.');
                      } finally {
                        setSending(false);
                      }
                    })()
                  }
                  className="dw-btn-primary !min-h-[36px] !py-1"
                >
                  {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Send className="w-3.5 h-3.5" aria-hidden="true" />}
                  Send approved ({approved.length})
                </button>
              )}
            </div>
          </div>

          {generateNote && (
            <p className="text-caption text-ink-3">
              {generateNote.created} new draft{generateNote.created === 1 ? '' : 's'}
              {generateNote.needsEmail > 0 ? ` · ${generateNote.needsEmail} skipped (no customer email on file)` : ''}
              {generateNote.optedOut > 0 ? ` · ${generateNote.optedOut} skipped (opted out)` : ''}
            </p>
          )}

          {!admin && approved.length > 0 && <p className="text-caption text-ink-3">Only a shop admin can send approved drafts.</p>}

          <ul className="space-y-2">
            {[...drafts, ...approved].map((msg) => (
              <li key={msg.id} className={['dw-card p-3', expandedId === msg.id ? 'ring-2 ring-accent' : ''].join(' ')}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <button type="button" onClick={() => void toggleExpand(msg)} className="min-w-0 text-left flex-1">
                    <p className="text-ink font-medium">
                      {msg.customerName ?? 'Unknown customer'} {msg.customerNumber ? <span className="text-ink-3 font-normal">· {msg.customerNumber}</span> : null}
                    </p>
                    <p className="text-body text-ink-3">
                      {msg.unit ?? 'Unit'} {msg.serialLast4 ? `(#${msg.serialLast4})` : ''} · {msg.toEmail}
                    </p>
                    <p className="text-caption text-ink-3 mt-1">{expandedId === msg.id ? (expandedBody[msg.id] ?? msg.preview) : `${msg.preview}…`}</p>
                  </button>
                  <div className="flex flex-col items-end gap-1.5 shrink-0">
                    <span className={msg.status === 'approved' ? 'dw-pill-info' : 'dw-pill-muted'}>{TIER_LABEL[msg.tier]}</span>
                    <div className="flex flex-wrap justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => void copyMessage(msg)}
                        className="dw-btn-tertiary !min-h-[32px] !py-0.5"
                      >
                        {copiedId === msg.id ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : <Clipboard className="w-3.5 h-3.5" aria-hidden="true" />}
                        {copiedId === msg.id ? 'Copied' : 'Copy email'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void openInMail(msg)}
                        className="dw-btn-tertiary !min-h-[32px] !py-0.5"
                      >
                        <Mail className="w-3.5 h-3.5" aria-hidden="true" /> Open in mail
                      </button>
                      {msg.status === 'draft' && (
                        <button
                          type="button"
                          disabled={busyIds.has(msg.id)}
                          onClick={() => void withBusy([msg.id], () => approveOutreach([msg.id]).then(() => undefined))}
                          className="dw-btn-secondary !min-h-[32px] !py-0.5"
                        >
                          <Check className="w-3.5 h-3.5" aria-hidden="true" /> Approve
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busyIds.has(msg.id)}
                        onClick={() => void withBusy([msg.id], () => skipOutreach([msg.id]).then(() => undefined))}
                        className="dw-btn-tertiary !min-h-[32px] !py-0.5"
                      >
                        <X className="w-3.5 h-3.5" aria-hidden="true" /> Skip
                      </button>
                    </div>
                  </div>
                </div>
              </li>
            ))}
            {drafts.length === 0 && approved.length === 0 && (
              <li className="text-body text-ink-3">No drafts right now — click "Generate drafts" to check for units that qualify.</li>
            )}
          </ul>
        </section>

        {/* ---- Sent log ---- */}
        <section className="space-y-3">
          <h2 className="dw-label">Sent log</h2>
          <ul className="space-y-1.5">
            {sentLog.map((msg) => (
              <li key={msg.id} className="dw-card p-3 flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-body text-ink">
                    {msg.customerName ?? 'Unknown customer'} · {msg.toEmail}
                  </p>
                  <p className="text-caption text-ink-3">
                    {TIER_LABEL[msg.tier]} · {msg.status === 'sent' ? `Sent ${msg.sentAt ? new Date(msg.sentAt).toLocaleDateString() : ''}` : msg.status}
                    {msg.error ? ` — ${msg.error}` : ''}
                  </p>
                </div>
                <span className={msg.status === 'sent' ? 'dw-pill-ok' : msg.status === 'failed' ? 'dw-pill-bad' : 'dw-pill-muted'}>{msg.status}</span>
              </li>
            ))}
            {sentLog.length === 0 && <li className="text-body text-ink-3">Nothing sent yet.</li>}
          </ul>
        </section>
      </div>
    </AppShell>
  );
}

