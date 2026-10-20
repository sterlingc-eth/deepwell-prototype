import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Mic, Square } from 'lucide-react';
import {
  browserLang, buildHints, createDictation, getRecognitionCtor, voiceFlagOn, VOICE_UNSUPPORTED_TIP,
  type Dictation, type RecognitionCtor,
} from '../../core/dictation';
import { DOCUMENT_TYPES } from '../../domains/hvac/documentTypes';
import type { Entity } from '../../core/types';

const AUTOSEND_KEY = 'deepwell.voice.autosend';
const AUTOSEND_DELAY_MS = 1200;

const readAutoSend = (): boolean => { try { return window.localStorage.getItem(AUTOSEND_KEY) === '1'; } catch { return false; } };
const writeAutoSend = (v: boolean) => { try { window.localStorage.setItem(AUTOSEND_KEY, v ? '1' : '0'); } catch { /* private window */ } };

export interface VoiceInput {
  /** The DEEPWELL_VOICE switch. When false nothing below renders and no browser API is touched. */
  enabled: boolean;
  supported: boolean;
  listening: boolean;
  error: string | null;
  autoSend: boolean;
  setAutoSend(v: boolean): void;
  toggle(): void;
  /** True while the box holds dictated text the person has not edited (the question is sent as inputMode "voice"). */
  readonly dictated: boolean;
  /** Call from the textarea's onChange / on send / on clear. */
  noteManualEdit(): void;
  markSent(): void;
}

/**
 * Wires dictation to an ask box. The box owns its text; this hook only reads `value` when listening starts (so
 * dictated words are appended to what is already there) and writes through `setValue`.
 */
export function useVoiceInput(args: {
  value: string;
  setValue(v: string): void;
  /** Called after the final transcript lands, only when "send automatically" is on. Receives the final text. */
  send(text: string): void;
  entities?: ReadonlyArray<Entity>;
  enabled?: boolean;
  Ctor?: RecognitionCtor | null;
}): VoiceInput {
  const enabled = args.enabled ?? voiceFlagOn();
  const Ctor = useMemo(() => (enabled ? (args.Ctor !== undefined ? args.Ctor : getRecognitionCtor()) : null), [enabled, args.Ctor]);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoSend, setAutoSendState] = useState<boolean>(() => (enabled ? readAutoSend() : false));
  const [dictated, setDictated] = useState(false);
  const dRef = useRef<Dictation | null>(null);
  const baseRef = useRef('');
  const sendTimer = useRef<number | null>(null);
  const latest = useRef(args);
  latest.current = args;
  const autoRef = useRef(autoSend);
  autoRef.current = autoSend;

  const hints = useMemo(() => (enabled && Ctor ? buildHints(args.entities ?? [], DOCUMENT_TYPES.map((t) => t.label)) : []), [enabled, Ctor, args.entities]);
  const hintsRef = useRef(hints);
  hintsRef.current = hints;

  const cancelSend = () => { if (sendTimer.current != null) { window.clearTimeout(sendTimer.current); sendTimer.current = null; } };

  useEffect(() => () => { cancelSend(); dRef.current?.abort(); }, []);

  const toggle = useCallback(() => {
    if (!enabled || !Ctor) return;
    cancelSend();
    if (dRef.current?.listening) { dRef.current.stop(); return; }
    setError(null);
    const v = latest.current.value.trim();
    baseRef.current = v ? `${v} ` : '';
    const join = (t: string) => `${baseRef.current}${t}`;
    dRef.current = createDictation({
      Ctor,
      lang: browserLang(),
      hints: hintsRef.current,
      onStart: () => setListening(true),
      onInterim: (t) => { latest.current.setValue(join(t)); setDictated(true); },
      onFinal: (t) => {
        const full = join(t);
        latest.current.setValue(full);
        setDictated(true);
        if (autoRef.current) {
          sendTimer.current = window.setTimeout(() => { sendTimer.current = null; latest.current.send(full); }, AUTOSEND_DELAY_MS);
        }
      },
      onError: (_c, message) => { setError(message); setListening(false); },
      onEnd: () => setListening(false),
    });
    setListening(true);
    dRef.current.start();
  }, [enabled, Ctor]);

  return {
    enabled,
    supported: !!Ctor,
    listening,
    error,
    autoSend,
    setAutoSend: (v) => { setAutoSendState(v); writeAutoSend(v); },
    toggle,
    dictated,
    noteManualEdit: () => { cancelSend(); if (dRef.current?.listening) dRef.current.abort(); setListening(false); setDictated(false); },
    markSent: () => { cancelSend(); setDictated(false); setError(null); },
  };
}

const focusRing = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

/** The mic. Renders nothing when the switch is off; a dimmed, explained icon when the browser cannot dictate. */
export function VoiceMicButton({ voice, className = '' }: { voice: VoiceInput; className?: string }) {
  if (!voice.enabled) return null;
  if (!voice.supported) {
    return (
      <span
        role="img"
        aria-label={VOICE_UNSUPPORTED_TIP}
        title={VOICE_UNSUPPORTED_TIP}
        data-testid="voice-mic-unsupported"
        className={`min-w-touch min-h-touch grid place-items-center text-ink-3 opacity-40 cursor-not-allowed ${className}`}
      >
        <Mic className="w-5 h-5" aria-hidden="true" />
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={voice.toggle}
      aria-pressed={voice.listening}
      aria-label={voice.listening ? 'Stop listening' : 'Ask by voice'}
      title={voice.listening ? 'Stop listening' : 'Ask by voice'}
      data-testid="voice-mic"
      className={`relative min-w-touch min-h-touch grid place-items-center rounded-md ${voice.listening ? 'text-accent bg-accent/15' : 'text-ink-3 hover:text-ink'} ${focusRing} ${className}`}
    >
      {voice.listening && <span aria-hidden="true" className="absolute inset-1 rounded-full border-2 border-accent animate-pulse motion-reduce:animate-none" />}
      {voice.listening ? <Square className="w-4 h-4 fill-current relative" aria-hidden="true" /> : <Mic className="w-5 h-5" aria-hidden="true" />}
    </button>
  );
}

/** Live status line (screen readers hear it) plus the "send automatically" switch. */
export function VoiceStatus({ voice, className = '' }: { voice: VoiceInput; className?: string }) {
  if (!voice.enabled || !voice.supported) return null;
  return (
    <div className={`flex items-center flex-wrap gap-x-3 gap-y-1 text-caption text-ink-3 ${className}`} data-testid="voice-status">
      <span role="status" aria-live="polite">
        {voice.listening ? 'Listening… speak your question, then pause.' : voice.error ?? ''}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={voice.autoSend}
        onClick={() => voice.setAutoSend(!voice.autoSend)}
        className={`inline-flex items-center gap-1.5 rounded px-1 min-h-[28px] ${focusRing}`}
      >
        <span aria-hidden="true" className={`inline-block w-7 h-4 rounded-full relative ${voice.autoSend ? 'bg-accent' : 'bg-line'}`}>
          <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-surface transition-all ${voice.autoSend ? 'left-3.5' : 'left-0.5'}`} />
        </span>
        Send automatically
      </button>
    </div>
  );
}
