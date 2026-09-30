import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowUp, Mail, WifiOff, X } from 'lucide-react';
import {
  FALLBACK_STARTER,
  MAX_HISTORY,
  MAX_MESSAGE_CHARS,
  SUPPORT_EMAIL,
  fetchSupportStarter,
  sendSupportHandoff,
  sendSupportMessage,
  type SupportError,
  type SupportSource,
  type SupportStarter,
  type SupportSurface,
} from '../../services/supportClient';
import { buildDiagnostics } from '../../services/errorReporter';
import { SupportLogo } from './SupportLogo';
import { SupportText } from './SupportText';
import './support.css';

/**
 * DeepWell Help: the in-app support chat. One component, two shells:
 *  - variant 'panel'    desktop floating panel (own header, role=dialog, focus trap, Esc)
 *  - variant 'embedded' body only, hosted by the mobile Sheet (which supplies header, Esc and focus trap)
 * Chat needs a live connection: nothing here touches the offline queue.
 */

export const MAX_USER_TURNS = 12;
const COUNTER_FROM = 500;
const STORAGE_PREFIX = 'deepwell.support.chat.v1.';
const HANDOFF_TRANSCRIPT = 10;
const HANDOFF_TEXT_CAP = 800;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface ChatMsg {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  sources?: SupportSource[];
  /** The user question to prefill on the Ask screen (assistant reply with redirectTo:'ask'). */
  askQuestion?: string;
  handoffOffered?: boolean;
  suggestions?: string[];
}

interface Persisted {
  msgs: ChatMsg[];
  handoffSent: boolean;
}

function loadChat(surface: SupportSurface): Persisted {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_PREFIX + surface);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Persisted>;
      if (Array.isArray(p.msgs)) {
        const msgs = p.msgs.filter((m): m is ChatMsg => !!m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && typeof m.id === 'string');
        return { msgs, handoffSent: p.handoffSent === true };
      }
    }
  } catch {
    /* storage unavailable or corrupt: start fresh */
  }
  return { msgs: [], handoffSent: false };
}

function saveChat(surface: SupportSurface, p: Persisted) {
  try {
    if (p.msgs.length === 0 && !p.handoffSent) window.sessionStorage.removeItem(STORAGE_PREFIX + surface);
    else window.sessionStorage.setItem(STORAGE_PREFIX + surface, JSON.stringify(p));
  } catch {
    /* best effort */
  }
}

const starterCache: Partial<Record<SupportSurface, SupportStarter>> = {};

function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}

let idSeq = 0;
const newId = () => `m${Date.now().toString(36)}${(idSeq++).toString(36)}`;

export interface SupportAssistantProps {
  surface: SupportSurface;
  /** Where the user is (e.g. the current screen), sent as `page`. */
  page?: string;
  variant?: 'panel' | 'embedded';
  /** False while a kept-mounted panel is closed: hides it and releases the keyboard. */
  active?: boolean;
  onClose?: () => void;
  /** Called with the user's question when the reply says redirectTo:'ask'. Omit to hide that button. */
  onAskDonovan?: (question: string) => void;
  /** Clerk user's primary email, to prefill the hand-off form. */
  userEmail?: string;
  userName?: string;
}

export function SupportAssistant({ surface, page, variant = 'panel', active = true, onClose, onAskDonovan, userEmail = '', userName = '' }: SupportAssistantProps) {
  const panel = variant === 'panel';
  const online = useOnline();
  const [{ msgs, handoffSent }, setChat] = useState<Persisted>(() => loadChat(surface));
  const [starter, setStarter] = useState<SupportStarter | null>(() => starterCache[surface] ?? null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<SupportError | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [handoffKind, setHandoffKind] = useState<'help' | 'problem'>('help');

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const reqRef = useRef(0);
  const lastRef = useRef<HTMLDivElement>(null);

  const setMsgs = useCallback((fn: (m: ChatMsg[]) => ChatMsg[]) => setChat((c) => ({ ...c, msgs: fn(c.msgs) })), []);

  useEffect(() => saveChat(surface, { msgs, handoffSent }), [surface, msgs, handoffSent]);

  const userTurns = useMemo(() => msgs.filter((m) => m.role === 'user').length, [msgs]);
  const last = msgs[msgs.length - 1];
  const limitReached = userTurns >= MAX_USER_TURNS;
  const lastRole = last?.role;
  const orphan = !!last && last.role === 'user' && !sending; // a question that never got a reply (failed, or the sheet closed mid-flight)

  // Greeting + starter chips: only fetched for an empty conversation.
  useEffect(() => {
    if (!active || starter || msgs.length > 0) return;
    let cancelled = false;
    void fetchSupportStarter(surface).then((r) => {
      if (cancelled) return;
      const s = r.ok ? r.data : FALLBACK_STARTER;
      starterCache[surface] = s;
      setStarter(s);
    });
    return () => {
      cancelled = true;
    };
  }, [active, starter, msgs.length, surface]);

  // 429 cooldown countdown.
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = window.setTimeout(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => window.clearTimeout(t);
  }, [cooldown]);

  // Keep the newest thing in view: a long reply is shown from its top, everything else from the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!sending && !error && lastRole === 'assistant' && lastRef.current) el.scrollTop = Math.max(0, lastRef.current.offsetTop - 8);
    else el.scrollTop = el.scrollHeight;
  }, [msgs.length, lastRole, sending, error, handoffOpen, starter]);

  // Auto-grow the textarea to at most four lines.
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const cs = window.getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight) || 22;
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    const max = lh * 4 + pad;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [input, active]);

  // Panel only: focus in on open, Esc closes, Tab stays inside. (The mobile Sheet does this for the embedded variant.)
  useEffect(() => {
    if (!panel || !active) return;
    const t = window.setTimeout(() => (taRef.current ?? rootRef.current?.querySelector<HTMLElement>(FOCUSABLE))?.focus({ preventScroll: true }), 30);
    const onKey = (e: globalThis.KeyboardEvent) => {
      const root = rootRef.current;
      if (!root) return;
      const target = e.target as Node | null;
      const inside = !!target && root.contains(target);
      if (e.key === 'Escape') {
        if (inside || target === document.body) {
          e.stopPropagation();
          onClose?.();
        }
        return;
      }
      if (e.key !== 'Tab') return;
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0);
      if (items.length === 0) return;
      const first = items[0]!;
      const lastEl = items[items.length - 1]!;
      if (!inside) {
        e.preventDefault();
        (e.shiftKey ? lastEl : first).focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [panel, active, onClose]);

  const submit = useCallback(
    async (raw: string, retry = false) => {
      const text = raw.trim().slice(0, MAX_MESSAGE_CHARS);
      if (!text || sending || cooldown > 0) return;
      const base = retry ? msgs : [...msgs, { id: newId(), role: 'user' as const, text }];
      if (!retry) {
        if (userTurns >= MAX_USER_TURNS) return;
        setMsgs(() => base);
        setInput('');
      }
      setError(null);
      setSending(true);
      const id = ++reqRef.current;
      const history = base
        .slice(0, -1)
        .slice(-MAX_HISTORY)
        .map((m) => ({ role: m.role, text: m.text }));
      const res = await sendSupportMessage({ message: text, history, surface, page });
      if (id !== reqRef.current) return; // "New chat" happened while this was in flight
      setSending(false);
      if (!res.ok) {
        setError(res.error);
        if (res.error.kind === 'rate_limited' && res.error.retryAfterSec) setCooldown(Math.min(120, Math.ceil(res.error.retryAfterSec)));
        return;
      }
      const r = res.data;
      setMsgs((m) => [
        ...m,
        {
          id: newId(),
          role: 'assistant',
          text: r.reply,
          sources: r.sources.length ? r.sources : undefined,
          askQuestion: r.redirectTo === 'ask' ? text : undefined,
          handoffOffered: r.handoff?.offered || undefined,
          suggestions: r.suggestions?.length ? r.suggestions : undefined,
        },
      ]);
    },
    [msgs, sending, cooldown, userTurns, surface, page, setMsgs],
  );

  const newChat = () => {
    reqRef.current++;
    setChat({ msgs: [], handoffSent: false });
    setInput('');
    setError(null);
    setSending(false);
    setHandoffOpen(false);
    setCooldown(0);
    window.setTimeout(() => taRef.current?.focus({ preventScroll: true }), 0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit(input);
    }
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit(input);
  };

  const showChips = userTurns === 0 && !sending && starter && starter.suggestions.length > 0;
  const canSend = input.trim().length > 0 && !sending && cooldown === 0 && online;
  const greeting = starter?.greeting ?? (msgs.length > 0 ? FALLBACK_STARTER.greeting : null);
  const lastIdx = msgs.length - 1;

  const transcriptFor = () => msgs.slice(-HANDOFF_TRANSCRIPT).map((m) => ({ role: m.role, text: m.text.slice(0, HANDOFF_TEXT_CAP) }));
  const lastUserText = [...msgs].reverse().find((m) => m.role === 'user')?.text ?? '';

  return (
    <div
      ref={rootRef}
      {...(panel ? { role: 'dialog', 'aria-modal': true, 'aria-label': 'DeepWell Help' } : {})}
      style={active ? undefined : { display: 'none' }}
      className={`flex flex-col min-h-0 text-ink ${panel ? 'h-full w-full overflow-hidden rounded-2xl border border-line bg-surface shadow-modal dw-support-panel-in' : 'flex-1'}`}
    >
      {panel && (
        <header className="shrink-0 h-14 px-4 flex items-center gap-3 bg-forest-700 text-stone-0 border-b border-forest-800">
          <SupportLogo plate size={32} />
          <div className="flex-1 min-w-0">
            <h2 className="m-0 font-sans text-h4 font-semibold text-stone-0 leading-tight">DeepWell Help</h2>
            <p className="m-0 text-caption text-forest-200 truncate">Questions about using DeepWell</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close DeepWell Help" className="w-11 h-11 -mr-2 shrink-0 flex items-center justify-center rounded-full text-stone-0 hover:bg-white/10">
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </header>
      )}

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-3">
        <div role="log" aria-live="polite" aria-relevant="additions text" aria-label="Conversation with DeepWell Help" className="grid gap-3">
          {greeting ? (
            <AssistantRow>
              <Bubble>
                <SupportText text={greeting} />
              </Bubble>
            </AssistantRow>
          ) : (
            <Typing />
          )}

          {msgs.map((m, i) =>
            m.role === 'user' ? (
              <div key={m.id} className="flex justify-end dw-support-msg-in">
                <div className="max-w-[85%] rounded-2xl rounded-br-md px-3.5 py-2 bg-forest-700 dark:bg-forest-600 text-white text-body-lg sm:text-body">
                  <SupportText text={m.text} />
                </div>
              </div>
            ) : (
              <div key={m.id} ref={i === lastIdx ? lastRef : undefined} className="dw-support-msg-in">
                <AssistantRow>
                  <Bubble>
                    <SupportText text={m.text} />
                  </Bubble>
                  {m.sources && m.sources.length > 0 && (
                    <p className="m-0 mt-1 text-caption text-ink-3 break-words">From: {Array.from(new Set(m.sources.map((s) => s.title))).join(', ')}</p>
                  )}
                  {m.askQuestion && onAskDonovan && (
                    <button type="button" onClick={() => onAskDonovan(m.askQuestion!)} className="mt-2 min-h-11 px-4 rounded-full bg-accent text-forest-950 font-semibold text-body text-left">
                      Ask Donovan about your records →
                    </button>
                  )}
                  {m.handoffOffered && !handoffSent && !handoffOpen && (
                    <button type="button" onClick={() => setHandoffOpen(true)} className="mt-2 min-h-11 px-4 rounded-full border border-line-2 bg-surface text-ink font-medium text-body inline-flex items-center gap-2">
                      <Mail className="w-4 h-4" aria-hidden="true" /> Send this to a person
                    </button>
                  )}
                </AssistantRow>
              </div>
            ),
          )}

          {sending && <Typing />}

          {error && !sending && (
            <div role="alert" className="ml-9 rounded-xl border border-warn/40 bg-warn-bg text-warn-ink px-3.5 py-2.5 text-body">
              <p className="m-0">{error.message}</p>
              {error.kind === 'offline' || error.kind === 'server' ? (
                <p className="m-0 mt-1">
                  Or email <a className="underline font-medium" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
                </p>
              ) : null}
              {error.kind !== 'invalid' && error.kind !== 'auth' && (
                <button type="button" onClick={() => void submit(lastUserText, true)} disabled={cooldown > 0} className="mt-2 min-h-11 px-4 rounded-full bg-warn-ink text-warn-bg font-semibold disabled:opacity-50">
                  {cooldown > 0 ? `Try again in ${cooldown}s` : 'Try again'}
                </button>
              )}
            </div>
          )}
          {orphan && !error && (
            <div className="ml-9 rounded-xl border border-line bg-surface-2 px-3.5 py-2.5 text-body">
              <p className="m-0">That message didn't get a reply.</p>
              <button type="button" onClick={() => void submit(last!.text, true)} disabled={!online || cooldown > 0} className="mt-2 min-h-11 px-4 rounded-full border border-line-2 bg-surface font-medium disabled:opacity-50">
                Try again
              </button>
            </div>
          )}
        </div>

        {(showChips || (last?.role === 'assistant' && last.suggestions && !sending && !limitReached)) && (
          <div className="mt-3 ml-9 flex flex-wrap gap-2" aria-label="Suggested questions">
            {(showChips ? starter!.suggestions : last!.suggestions!).map((s) => (
              <button key={s} type="button" disabled={!online} onClick={() => void submit(s)} className="min-h-11 px-3.5 py-2 rounded-2xl border border-line-2 bg-surface text-ink text-body text-left hover:bg-surface-2 disabled:opacity-50">
                {s}
              </button>
            ))}
          </div>
        )}

        {handoffSent && (
          <div role="status" className="mt-3 ml-9 rounded-xl border border-ok/40 bg-ok-bg text-ok-ink px-3.5 py-2.5 text-body">
            <strong>Sent to the DeepWell team.</strong> We'll reply by email.
          </div>
        )}
        {handoffOpen && !handoffSent && (
          <HandoffForm
            surface={surface}
            defaultEmail={userEmail}
            defaultName={userName}
            kind={handoffKind}
            page={page}
            defaultMessage={handoffKind === 'problem' ? '' : lastUserText}
            transcript={handoffKind === 'problem' ? () => [] : transcriptFor}
            onCancel={() => {
              setHandoffOpen(false);
              taRef.current?.focus({ preventScroll: true }); // the form's own button is about to unmount: keep the keyboard user's place
            }}
            onSent={() => {
              setHandoffOpen(false);
              taRef.current?.focus({ preventScroll: true });
              setChat((c) => ({ ...c, handoffSent: true }));
            }}
          />
        )}
      </div>

      <div className="shrink-0 border-t border-line bg-surface">
        {!online ? (
          <div role="status" className="px-4 py-3 text-body flex gap-2 items-start">
            <WifiOff className="w-5 h-5 shrink-0 mt-0.5 text-ink-3" aria-hidden="true" />
            <p className="m-0">
              <strong>Help chat needs a connection.</strong> You can email us at <a className="underline font-medium text-accent-ink" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
            </p>
          </div>
        ) : limitReached ? (
          <div className="px-4 py-3 text-body">
            <p className="m-0">
              For more help, email <a className="underline font-medium text-accent-ink" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
            </p>
            {!handoffSent && !handoffOpen && (
              <button type="button" onClick={() => setHandoffOpen(true)} className="mt-2 min-h-11 px-4 rounded-full bg-accent text-forest-950 font-semibold inline-flex items-center gap-2">
                <Mail className="w-4 h-4" aria-hidden="true" /> Send this to a person
              </button>
            )}
          </div>
        ) : (
          <form onSubmit={onSubmit} className="px-3 pt-3 pb-1">
            <div className="flex items-end gap-2">
              <textarea
                ref={taRef}
                value={input}
                onChange={(e) => setInput(e.target.value.slice(0, MAX_MESSAGE_CHARS))}
                onKeyDown={onKeyDown}
                rows={1}
                maxLength={MAX_MESSAGE_CHARS}
                enterKeyHint="send"
                aria-label="Message DeepWell Help"
                placeholder="Ask about DeepWell"
                className={`flex-1 min-w-0 resize-none rounded-2xl border border-line-2 bg-bg text-ink placeholder:text-ink-3 px-3.5 py-2.5 ${panel ? 'text-body' : 'text-body-lg'}`}
              />
              <button type="submit" disabled={!canSend} aria-label="Send message" className="w-11 h-11 shrink-0 rounded-full bg-accent text-forest-950 flex items-center justify-center disabled:opacity-40">
                <ArrowUp className="w-5 h-5" aria-hidden="true" />
              </button>
            </div>
            {(panel || input.length >= COUNTER_FROM) && (
              <div className="h-5 flex items-center justify-between text-caption text-ink-3">
                <span className="hidden sm:inline">{panel ? 'Enter to send, Shift+Enter for a new line' : ''}</span>
                <span className={`ml-auto tabular-nums ${input.length >= MAX_MESSAGE_CHARS ? 'text-bad font-semibold' : input.length >= COUNTER_FROM ? 'text-ink-2' : 'invisible'}`} aria-live="off">
                  {input.length}/{MAX_MESSAGE_CHARS}
                </span>
              </div>
            )}
          </form>
        )}
        <div className="px-3 pb-1 flex items-center justify-between text-caption text-ink-3">
          <button type="button" onClick={newChat} disabled={msgs.length === 0} className="min-h-11 px-2 underline underline-offset-2 disabled:opacity-40 disabled:no-underline">
            New chat
          </button>
          {!handoffSent && !handoffOpen && (
            <span className="flex items-center gap-1">
              <button type="button" onClick={() => { setHandoffKind('problem'); setHandoffOpen(true); }} className="min-h-11 px-2 underline underline-offset-2">
                Report a problem
              </button>
              <button type="button" onClick={() => { setHandoffKind('help'); setHandoffOpen(true); }} className="min-h-11 px-2 underline underline-offset-2">
                Talk to a person
              </button>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function AssistantRow({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <SupportLogo plate size={28} className="shrink-0 mt-0.5" />
      <div className="min-w-0 max-w-[calc(100%-2.25rem)]">{children}</div>
    </div>
  );
}

function Bubble({ children }: { children: ReactNode }) {
  return <div className="rounded-2xl rounded-tl-md px-3.5 py-2 bg-surface-2 border border-line text-ink text-body-lg sm:text-body">{children}</div>;
}

function Typing() {
  return (
    <AssistantRow>
      <Bubble>
        <span className="inline-flex items-center gap-2 text-ink-3 text-caption">
          <SupportLogo pulsing size={22} className="text-accent-ink" />
          <span>Thinking…</span>
          <span className="sr-only">DeepWell Help is typing</span>
        </span>
      </Bubble>
    </AssistantRow>
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function HandoffForm({
  surface,
  defaultEmail,
  defaultName,
  defaultMessage,
  transcript,
  kind,
  page,
  onCancel,
  onSent,
}: {
  kind: 'help' | 'problem';
  page?: string;
  surface: SupportSurface;
  defaultEmail: string;
  defaultName: string;
  defaultMessage: string;
  transcript: () => { role: 'user' | 'assistant'; text: string }[];
  onCancel: () => void;
  onSent: () => void;
}) {
  const problem = kind === 'problem';
  const [email, setEmail] = useState(defaultEmail);
  const [name, setName] = useState(defaultName);
  const [message, setMessage] = useState(defaultMessage.slice(0, MAX_MESSAGE_CHARS));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const t = window.setTimeout(() => {
      const el = ref.current?.querySelector<HTMLInputElement>(defaultEmail ? 'textarea' : 'input[type=email]');
      el?.focus({ preventScroll: true });
      ref.current?.scrollIntoView({ block: 'nearest' });
    }, 30);
    return () => window.clearTimeout(t);
  }, [defaultEmail]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!EMAIL_RE.test(email.trim())) return setErr('Enter the email we should reply to.');
    if (!message.trim()) return setErr(problem ? 'Tell us what went wrong.' : 'Tell us what you need help with.');
    setErr(null);
    setBusy(true);
    const r = await sendSupportHandoff({ email, name: name.trim() || undefined, message, transcript: transcript(), surface, ...(problem ? { kind: 'problem' as const, diagnostics: buildDiagnostics(surface, page), page } : {}) });
    setBusy(false);
    if (r.ok) return onSent();
    setFailed(true);
    setErr(r.error.kind === 'rate_limited' || r.error.kind === 'invalid' ? r.error.message : "We couldn't send that just now.");
  };

  const mailto = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(problem ? 'DeepWell problem report' : 'DeepWell Help request')}&body=${encodeURIComponent(message)}`;
  const field = 'w-full rounded-lg border border-line-2 bg-bg text-ink px-3 py-2 min-h-11 text-body-lg sm:text-body';
  return (
    <form ref={ref} onSubmit={submit} className="mt-3 ml-9 rounded-xl border border-line-2 bg-surface p-3 grid gap-2.5" aria-label={problem ? 'Report a problem' : 'Send this conversation to a person'} noValidate>
      <p className="m-0 text-body font-semibold">{problem ? 'Report a problem' : 'Send this to a person'}</p>
      <label className="grid gap-1 text-caption text-ink-2">
        Your email
        <input type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className={field} required />
      </label>
      <label className="grid gap-1 text-caption text-ink-2">
        Name (optional)
        <input type="text" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} className={field} maxLength={80} />
      </label>
      <label className="grid gap-1 text-caption text-ink-2">
        {problem ? 'What went wrong?' : 'What do you need help with?'}
        <textarea value={message} onChange={(e) => setMessage(e.target.value.slice(0, MAX_MESSAGE_CHARS))} rows={3} maxLength={MAX_MESSAGE_CHARS} className={`${field} resize-none`} required />
      </label>
      {problem && <p className="m-0 text-caption text-ink-3">We attach the screen you are on, your device type and any recent error. Never your customers or documents.</p>}
      {err && (
        <p role="alert" className="m-0 text-body text-bad">
          {err}{' '}
          {failed && (
            <a className="underline font-medium" href={mailto}>
              Email {SUPPORT_EMAIL} instead
            </a>
          )}
        </p>
      )}
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onCancel} className="min-h-11 px-4 rounded-full border border-line-2 bg-surface text-ink font-medium">
          Cancel
        </button>
        <button type="submit" disabled={busy} className="min-h-11 px-4 rounded-full bg-accent text-forest-950 font-semibold disabled:opacity-60">
          {busy ? 'Sending…' : 'Send'}
        </button>
      </div>
    </form>
  );
}
