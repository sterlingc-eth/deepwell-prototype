/**
 * Voice dictation engine v1: the browser's built-in speech recognition (Web Speech API). No server, no
 * extra cost. Framework-free so it can be tested with a mocked SpeechRecognition (scripts/verify-voice.ts).
 *
 * Privacy note: the browser may send the audio to its vendor (Google for Chrome and Edge, Apple for
 * Safari) to turn it into text. DeepWell itself never receives or stores audio; it only receives the text.
 */

export interface RecognitionResultLike { readonly isFinal: boolean; readonly length: number; [i: number]: { transcript: string } }
export interface RecognitionEventLike { resultIndex: number; results: { length: number; [i: number]: RecognitionResultLike } }
export interface RecognitionLike {
  lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number;
  grammars?: unknown; phrases?: unknown;
  onstart: (() => void) | null; onend: (() => void) | null;
  onresult: ((e: RecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void; stop(): void; abort(): void;
}
export type RecognitionCtor = new () => RecognitionLike;

interface WinLike { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor; SpeechGrammarList?: new () => { addFromString(s: string, w?: number): void }; webkitSpeechGrammarList?: new () => { addFromString(s: string, w?: number): void }; SpeechRecognitionPhrase?: new (p: string, boost?: number) => unknown; isSecureContext?: boolean }

export const VOICE_UNSUPPORTED_TIP = "Voice input isn't available in this browser. Try Chrome, Edge or Safari, or type your question.";

/** The build-time switch. Off unless VITE_DEEPWELL_VOICE is exactly "true" (same pattern as VITE_DEMO_MODE). */
export function voiceFlagOn(env?: Record<string, string | undefined>): boolean {
  const e = env ?? (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return e?.VITE_DEEPWELL_VOICE === 'true';
}

export function getRecognitionCtor(win: WinLike | undefined = typeof window === 'undefined' ? undefined : (window as unknown as WinLike)): RecognitionCtor | null {
  if (!win) return null;
  if (win.isSecureContext === false) return null; // speech recognition needs https (or localhost)
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
}
export const isDictationSupported = (win?: WinLike): boolean => getRecognitionCtor(win) !== null;

/** BCP-47 tag from the browser locale; en-US when there is none. */
export function browserLang(nav: { language?: string; languages?: readonly string[] } | undefined = typeof navigator === 'undefined' ? undefined : navigator): string {
  const l = nav?.languages?.[0] || nav?.language || '';
  return /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/i.test(l) ? l : 'en-US';
}

export type DictationErrorCode = 'not-allowed' | 'no-speech' | 'network' | 'audio-capture' | 'unsupported' | 'other';
export function dictationErrorMessage(code: DictationErrorCode): string {
  switch (code) {
    case 'not-allowed': return "Microphone access is off for this site. Allow the microphone in your browser's site settings, then tap the mic again.";
    case 'no-speech': return "I didn't catch anything. Tap the mic and say your question again.";
    case 'network': return 'Voice input needs an internet connection right now. You can type your question instead.';
    case 'audio-capture': return "I couldn't find a microphone. Check that one is connected, or type your question.";
    case 'unsupported': return VOICE_UNSUPPORTED_TIP;
    default: return "Voice input stopped unexpectedly. Tap the mic to try again, or type your question.";
  }
}
function mapError(code: string): DictationErrorCode | null {
  if (code === 'aborted') return null; // we stopped it ourselves
  if (code === 'not-allowed' || code === 'service-not-allowed') return 'not-allowed';
  if (code === 'no-speech') return 'no-speech';
  if (code === 'network') return 'network';
  if (code === 'audio-capture') return 'audio-capture';
  return 'other';
}

// ---------------------------------------------------------------------------------------------
// Hints: customer names, street names and document types the company actually uses.
// ---------------------------------------------------------------------------------------------

const MAX_HINTS = 150;
const clean = (s: unknown) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');

/** "412 W Palm Ln, Mesa, AZ" -> "W Palm Ln" */
export function streetOf(address: string): string {
  const first = clean(address).split(',')[0] ?? '';
  return first.replace(/^\d+[A-Za-z]?\s+/, '').replace(/\s+(?:unit|apt|suite|ste|#)\s*\S+$/i, '').trim();
}

export function buildHints(entities: ReadonlyArray<{ type: string; fields: Record<string, unknown> }>, documentTypeLabels: readonly string[] = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (s: string) => {
    const v = clean(s);
    const k = v.toLowerCase();
    if (v.length < 3 || v.length > 60 || seen.has(k) || out.length >= MAX_HINTS) return;
    seen.add(k); out.push(v);
  };
  for (const e of entities) {
    for (const key of ['customerName', 'name']) {
      const v = e.fields?.[key];
      if (e.type === 'customer' || key === 'customerName') push(clean(v));
    }
  }
  for (const e of entities) {
    const a = clean(e.fields?.address);
    if (a) push(streetOf(a));
  }
  for (const l of documentTypeLabels) push(l);
  return out;
}

/** Offers the hints to the engine wherever it has a hook: `phrases` (Chrome contextual biasing) and the older grammar list. Never throws. */
export function applyHints(rec: RecognitionLike, hints: readonly string[], win: WinLike | undefined = typeof window === 'undefined' ? undefined : (window as unknown as WinLike)): { phrases: boolean; grammar: boolean } {
  const used = { phrases: false, grammar: false };
  if (!hints.length || !win) return used;
  try {
    if (win.SpeechRecognitionPhrase) {
      rec.phrases = hints.map((h) => new win.SpeechRecognitionPhrase!(h, 5));
      used.phrases = true;
    }
  } catch { /* the engine refused phrases; carry on without */ }
  try {
    const GL = win.SpeechGrammarList ?? win.webkitSpeechGrammarList;
    if (GL) {
      const list = new GL();
      const alts = hints.map((h) => h.replace(/[;|<>=]/g, ' ')).join(' | ');
      list.addFromString(`#JSGF V1.0; grammar company; public <name> = ${alts} ;`, 1);
      rec.grammars = list;
      used.grammar = true;
    }
  } catch { /* grammar lists are a no-op in several browsers */ }
  return used;
}

// ---------------------------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------------------------

export interface DictationHandlers {
  onStart?(): void;
  onInterim?(text: string): void;
  onFinal?(text: string): void;
  onError?(code: DictationErrorCode, message: string): void;
  onEnd?(): void;
}
export interface DictationOptions extends DictationHandlers {
  Ctor: RecognitionCtor;
  lang?: string;
  hints?: readonly string[];
  /** Stop this long after the last words were heard. */
  silenceMs?: number;
  /** Give up if nothing at all is heard in this long. */
  noSpeechMs?: number;
  win?: WinLike;
  timers?: { set(fn: () => void, ms: number): unknown; clear(h: unknown): void };
}
export interface Dictation { start(): void; stop(): void; abort(): void; readonly listening: boolean }

export function createDictation(opts: DictationOptions): Dictation {
  const silenceMs = opts.silenceMs ?? 1800;
  const noSpeechMs = opts.noSpeechMs ?? 8000;
  const T = opts.timers ?? { set: (fn: () => void, ms: number) => setTimeout(fn, ms), clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  let rec: RecognitionLike | null = null;
  let listening = false;
  let finalText = '';
  let interimText = '';
  let errored = false;
  let timer: unknown = null;
  let forceTimer: unknown = null;

  const clearTimers = () => { if (timer != null) T.clear(timer); if (forceTimer != null) T.clear(forceTimer); timer = forceTimer = null; };
  const arm = (ms: number) => { if (timer != null) T.clear(timer); timer = T.set(() => d.stop(), ms); };

  function finish() {
    if (!listening) return;
    listening = false;
    clearTimers();
    const text = (finalText || interimText).replace(/\s+/g, ' ').trim();
    const r = rec; rec = null;
    if (r) { r.onstart = r.onend = r.onresult = r.onerror = null; }
    if (text) opts.onFinal?.(text);
    else if (!errored) { errored = true; opts.onError?.('no-speech', dictationErrorMessage('no-speech')); }
    opts.onEnd?.();
  }

  const d: Dictation = {
    get listening() { return listening; },
    start() {
      if (listening) return;
      finalText = interimText = ''; errored = false;
      let r: RecognitionLike;
      try { r = new opts.Ctor(); } catch { errored = true; opts.onError?.('unsupported', dictationErrorMessage('unsupported')); return; }
      rec = r;
      r.lang = opts.lang || browserLang();
      r.continuous = false;
      r.interimResults = true;
      r.maxAlternatives = 1;
      if (opts.hints?.length) applyHints(r, opts.hints, opts.win);
      r.onstart = () => { opts.onStart?.(); };
      r.onresult = (e) => {
        let f = ''; let i = '';
        for (let k = 0; k < e.results.length; k++) {
          const res = e.results[k];
          const tr = res?.[0]?.transcript ?? '';
          if (res?.isFinal) f += (f ? ' ' : '') + tr.trim(); else i += (i ? ' ' : '') + tr.trim();
        }
        finalText = f; interimText = i;
        const live = [f, i].filter(Boolean).join(' ');
        if (live) opts.onInterim?.(live);
        arm(silenceMs); // every new words resets the silence clock
      };
      r.onerror = (e) => {
        const code = mapError(e?.error ?? '');
        if (!code) return;
        errored = true;
        opts.onError?.(code, dictationErrorMessage(code));
      };
      r.onend = () => finish();
      listening = true;
      try { r.start(); } catch { listening = false; rec = null; errored = true; opts.onError?.('other', dictationErrorMessage('other')); return; }
      arm(noSpeechMs);
    },
    stop() {
      if (!listening || !rec) return;
      if (timer != null) { T.clear(timer); timer = null; }
      try { rec.stop(); } catch { /* already stopping */ }
      // Some engines never fire onend after stop(); do not leave the mic button stuck on "listening".
      if (forceTimer != null) T.clear(forceTimer);
      forceTimer = T.set(() => finish(), 1500);
    },
    abort() {
      if (!listening) return;
      listening = false; clearTimers();
      const r = rec; rec = null;
      if (r) { r.onstart = r.onend = r.onresult = r.onerror = null; try { r.abort(); } catch { /* ignore */ } }
      opts.onEnd?.();
    },
  };
  return d;
}
