/**
 * Voice dictation checks (DEEPWELL_VOICE). A mocked SpeechRecognition stands in for the browser; no audio, no network.
 *
 *   npm run verify:voice
 */
import { readFileSync } from 'node:fs';
import * as React from 'react';
import { createElement } from 'react';
// tsx compiles JSX with the classic transform; the app itself uses react-jsx (same trick as verify-company-files-ui).
(globalThis as unknown as { React: typeof React }).React = React;
import { renderToStaticMarkup } from 'react-dom/server';
import {
  applyHints, browserLang, buildHints, createDictation, dictationErrorMessage, getRecognitionCtor, isDictationSupported,
  streetOf, voiceFlagOn, VOICE_UNSUPPORTED_TIP, type RecognitionCtor, type RecognitionEventLike, type RecognitionLike,
} from '../src/core/dictation';
import { normalizeSpoken } from '../src/core/voiceNormalize';
import { VoiceMicButton, VoiceStatus, useVoiceInput, type VoiceInput } from '../src/components/ask/VoiceInput';
import { createClaudeProvider } from '../src/services/answerService.claude';

let passed = 0;
const failures: string[] = [];
function ok(cond: unknown, name: string) { if (cond) passed++; else failures.push(name); }
function eq(a: unknown, b: unknown, name: string) { if (JSON.stringify(a) === JSON.stringify(b)) passed++; else failures.push(`${name}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); }

// ---- mock engine + virtual clock ----
class MockRec implements RecognitionLike {
  static last: MockRec;
  lang = ''; continuous = true; interimResults = false; maxAlternatives = 0; grammars?: unknown; phrases?: unknown;
  onstart: (() => void) | null = null; onend: (() => void) | null = null;
  onresult: ((e: RecognitionEventLike) => void) | null = null; onerror: ((e: { error: string }) => void) | null = null;
  started = 0; stopped = 0; aborted = 0; endsOnStop = true;
  constructor() { MockRec.last = this; }
  start() { this.started++; this.onstart?.(); }
  stop() { this.stopped++; if (this.endsOnStop) this.onend?.(); }
  abort() { this.aborted++; }
  say(parts: Array<[string, boolean]>) {
    const results = parts.map(([t, f]) => Object.assign([{ transcript: t }], { isFinal: f }));
    this.onresult?.({ resultIndex: 0, results: Object.assign(results, { length: results.length }) as never });
  }
}
function clock() {
  let now = 0; let id = 0; const q = new Map<number, { at: number; fn: () => void }>();
  return {
    set: (fn: () => void, ms: number) => { q.set(++id, { at: now + ms, fn }); return id; },
    clear: (h: unknown) => { q.delete(h as number); },
    advance(ms: number) { const end = now + ms; for (;;) { const next = [...q.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; now = next[1].at; q.delete(next[0]); next[1].fn(); } now = end; },
  };
}
const Ctor = MockRec as unknown as RecognitionCtor;

// ---- 1. feature detection ----
eq(getRecognitionCtor({}), null, 'detect: none');
ok(getRecognitionCtor({ webkitSpeechRecognition: Ctor }) === Ctor, 'detect: webkit prefix');
ok(getRecognitionCtor({ SpeechRecognition: Ctor, webkitSpeechRecognition: undefined }) === Ctor, 'detect: standard name');
eq(getRecognitionCtor({ SpeechRecognition: Ctor, isSecureContext: false }), null, 'detect: insecure page is unsupported');
ok(isDictationSupported({ webkitSpeechRecognition: Ctor }) && !isDictationSupported({}), 'detect: boolean');
eq(browserLang({ languages: ['es-MX', 'en'] }), 'es-MX', 'lang: browser locale');
eq(browserLang({ language: 'en-GB' }), 'en-GB', 'lang: single locale');
eq(browserLang({}), 'en-US', 'lang: default en-US');
eq(browserLang({ language: 'x' }), 'en-US', 'lang: junk falls back');
ok(VOICE_UNSUPPORTED_TIP.length > 20, 'tooltip text exists');
eq(voiceFlagOn({}), false, 'flag: unset is off');
eq(voiceFlagOn({ VITE_DEEPWELL_VOICE: 'false' }), false, 'flag: false is off');
eq(voiceFlagOn({ VITE_DEEPWELL_VOICE: '1' }), false, 'flag: only "true" turns it on');
eq(voiceFlagOn({ VITE_DEEPWELL_VOICE: 'true' }), true, 'flag: true is on');
eq(voiceFlagOn(), false, 'flag: default in this process is off');

// ---- 2. start / stop / silence, 3. interim and final ----
{
  const c = clock(); const log: string[] = [];
  const d = createDictation({ Ctor, lang: 'en-US', timers: c, silenceMs: 1800, noSpeechMs: 8000,
    onStart: () => log.push('start'), onInterim: (t) => log.push('i:' + t), onFinal: (t) => log.push('f:' + t), onError: (code) => log.push('e:' + code), onEnd: () => log.push('end') });
  d.start();
  const r = MockRec.last;
  ok(d.listening && r.started === 1, 'start: listening');
  eq([r.lang, r.continuous, r.interimResults], ['en-US', false, true], 'start: engine configured');
  r.say([['when was the', false]]);
  r.say([['when was the last job at', false]]);
  r.say([['when was the last job at 412 West Palm Lane', true]]);
  eq(log, ['start', 'i:when was the', 'i:when was the last job at', 'i:when was the last job at 412 West Palm Lane'], 'interim text streams');
  c.advance(1799); ok(r.stopped === 0, 'silence: not yet');
  c.advance(2); ok(r.stopped === 1, 'silence: auto-stops after quiet');
  eq(log.slice(-2), ['f:when was the last job at 412 West Palm Lane', 'end'], 'final text delivered once, then end');
  ok(!d.listening, 'stopped: not listening');
}
{ // tap to stop; interim-only transcript still lands as final (Safari)
  const c = clock(); const log: string[] = [];
  const d = createDictation({ Ctor, timers: c, onFinal: (t) => log.push('f:' + t), onError: (x) => log.push('e:' + x), onEnd: () => log.push('end') });
  d.start(); MockRec.last.say([['show me the invoice', false]]); d.stop();
  eq(log, ['f:show me the invoice', 'end'], 'tap-to-stop keeps what was heard');
}
{ // engine that never fires onend after stop()
  const c = clock(); const log: string[] = [];
  const d = createDictation({ Ctor, timers: c, onFinal: (t) => log.push('f:' + t), onEnd: () => log.push('end') });
  d.start(); MockRec.last.endsOnStop = false; MockRec.last.say([['hello there', true]]); d.stop();
  ok(d.listening, 'stuck engine: still listening right after stop');
  c.advance(1600); ok(!d.listening && log.join() === 'f:hello there,end', 'stuck engine: forced to finish');
}
{ // abort delivers nothing
  const log: string[] = []; const c = clock();
  const d = createDictation({ Ctor, timers: c, onFinal: () => log.push('f'), onEnd: () => log.push('end') });
  d.start(); MockRec.last.say([['x y z', false]]); d.abort();
  eq(log, ['end'], 'abort: no final text'); ok(MockRec.last.aborted === 1, 'abort: engine aborted');
}

// ---- 6. permission and other errors ----
for (const [engineCode, want] of [['not-allowed', 'not-allowed'], ['service-not-allowed', 'not-allowed'], ['no-speech', 'no-speech'], ['network', 'network'], ['audio-capture', 'audio-capture'], ['language-not-supported', 'other']] as const) {
  const c = clock(); const log: Array<[string, string]> = [];
  const d = createDictation({ Ctor, timers: c, onError: (code, msg) => log.push([code, msg]), onFinal: () => log.push(['final', '']) });
  d.start(); MockRec.last.onerror?.({ error: engineCode }); MockRec.last.onend?.();
  eq(log.length, 1, `error ${engineCode}: reported once`);
  eq(log[0]?.[0], want, `error ${engineCode}: mapped`);
  ok(!d.listening, `error ${engineCode}: not listening`);
  const msg = log[0]?.[1] ?? '';
  ok(msg.length > 20 && !/error|exception|undefined|failed/i.test(msg), `error ${engineCode}: friendly wording`);
}
{ const c = clock(); const log: string[] = [];
  const d = createDictation({ Ctor, timers: c, noSpeechMs: 8000, onError: (code) => log.push(code) });
  d.start(); c.advance(8001); eq(log, ['no-speech'], 'silence from the start: friendly no-speech'); ok(!d.listening, 'no-speech: stops'); }
{ const c = clock(); const log: string[] = [];
  const d = createDictation({ Ctor, timers: c, onError: (code) => log.push(code) });
  d.start(); MockRec.last.onerror?.({ error: 'aborted' }); eq(log, [], 'aborted is not an error shown to the person'); }
{ const Throwing = class { constructor() { throw new Error('x'); } } as unknown as RecognitionCtor; const log: string[] = [];
  createDictation({ Ctor: Throwing, onError: (code) => log.push(code) }).start(); eq(log, ['unsupported'], 'constructor failure is handled'); }
ok(Object.values({ a: dictationErrorMessage('not-allowed'), b: dictationErrorMessage('network') }).every((m) => !/\bdenied\b|\bfailed\b/i.test(m)), 'error wording is positive and factual');

// ---- hints ----
{
  const h = buildHints([
    { type: 'customer', fields: { name: 'Plaza Dental' } },
    { type: 'property', fields: { customerName: 'Mesa Bakery', address: '412 W Palm Ln, Mesa, AZ 85201' } },
    { type: 'property', fields: { address: '1200 Main Street Unit 4B, Mesa' } },
    { type: 'equipment', fields: { serial: 'ZZ99' } },
  ], ['Work order', 'Invoice']);
  eq(h, ['Plaza Dental', 'Mesa Bakery', 'W Palm Ln', 'Main Street', 'Work order', 'Invoice'], 'hints: names, streets, document types');
  eq(streetOf('412 W Palm Ln, Mesa, AZ'), 'W Palm Ln', 'hints: street extraction');
  const rec = new MockRec();
  const none = applyHints(rec, h, {});
  eq(none, { phrases: false, grammar: false }, 'hints: unsupported API is skipped quietly');
  const added: string[] = [];
  const hintWin = {
    SpeechGrammarList: class { addFromString(s: string) { added.push(s); } },
    SpeechRecognitionPhrase: class { constructor(public p: string, public b?: number) {} },
  };
  const used = applyHints(rec, h, hintWin);
  eq(used, { phrases: false, grammar: true }, 'hints: phrases are NOT applied by default (Chrome ends the session with phrases-not-supported)');
  ok(rec.phrases === undefined, 'hints: rec.phrases untouched by default');
  ok(added[0]?.includes('Plaza Dental | Mesa Bakery'), 'hints: grammar lists the names');
  const rec2 = new MockRec();
  eq(applyHints(rec2, h, hintWin, true), { phrases: true, grammar: true }, 'hints: allowPhrases=true opts in to both hooks');
  ok(Array.isArray(rec2.phrases) && rec2.phrases.length === h.length, 'hints: phrases set when allowed');
  const c = clock(); createDictation({ Ctor, timers: c, hints: h, win: { SpeechRecognitionPhrase: class {} as never } }).start();
  ok(MockRec.last.phrases === undefined, 'hints: start() does not set phrases');
  for (const code of ['phrases-not-supported', 'language-not-supported']) {
    const c2 = clock(); const errs: string[] = [];
    createDictation({ Ctor, timers: c2, onError: (k, m) => errs.push(`${k}|${m}`) }).start();
    MockRec.last.onerror?.({ error: code });
    ok(errs.length === 1 && errs[0].startsWith('other|') && /try again/i.test(errs[0]), `error: ${code} maps to a friendly retry message`);
  }
  { // start() twice never creates a second engine
    const c3 = clock(); const d2 = createDictation({ Ctor, timers: c3 }); d2.start(); const first = MockRec.last; d2.start();
    ok(MockRec.last === first && first.started === 1, 'start twice: second call is ignored');
  }
  { // vercel.json must let the site use the microphone
    const vj = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as { headers?: Array<{ headers?: Array<{ key: string; value: string }> }> };
    const vals = (vj.headers ?? []).flatMap((x) => x.headers ?? []).filter((x) => x.key === 'Permissions-Policy').map((x) => x.value);
    ok(vals.length > 0 && vals.every((v) => /microphone=\(self\)/.test(v) && !/microphone=\(\)/.test(v)), 'vercel.json: Permissions-Policy allows microphone=(self)');
  }
  eq(buildHints(Array.from({ length: 400 }, (_, i) => ({ type: 'customer', fields: { name: `Customer Number ${i}` } }))).length, 150, 'hints: capped');
}

// ---- 4. number and address normalisation ----
for (const [spoken, want] of [
  ['what did we do in twenty twenty five', 'what did we do in 2025'],
  ['jobs in nineteen ninety nine', 'jobs in 1999'],
  ['invoices from twenty oh five', 'invoices from 2005'],
  ['revenue for two thousand twenty five', 'revenue for 2025'],
  ['who serviced unit four b', 'who serviced unit 4B'],
  ['apartment twelve c last month', 'apartment 12C last month'],
  ['what is at one two three main street', 'what is at 123 Main Street'],
  ['last job at four twelve west palm lane', 'last job at 412 West Palm Lane'],
  ['one hundred twenty three oak avenue unit two a', '123 Oak Avenue unit 2A'],
  ['invoice number one zero four two', 'invoice number 1042'],
  ['work order twenty one', 'work order 21'],
  ['zip eight five two zero one', 'zip 85201'],
  // left alone
  ['one of our customers called two weeks ago', 'one of our customers called two weeks ago'],
  ['twenty twenty five dollars', 'twenty twenty five dollars'],
  ['unit 4B is already typed', 'unit 4B is already typed'],
  ['show me plaza dental', 'show me plaza dental'],
  ['how many jobs in 2024', 'how many jobs in 2024'],
] as const) eq(normalizeSpoken(spoken).text, want, `normalise: ${spoken}`);
ok(normalizeSpoken('unit four b').changes[0]?.kind === 'unit', 'normalise: reports what it changed');
eq(normalizeSpoken('').text, '', 'normalise: empty');

// ---- 5. inputMode reaches the API ----
{
  const bodies: Array<Record<string, unknown>> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_u: unknown, init?: { body?: string }) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(JSON.stringify({ success: true, data: { kind: 'no-answer', text: 'x', facts: [], sources: [], confidence: 0, verifiedCount: 0, unverifiedCount: 0, closest: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    const p = createClaudeProvider(() => ({ entities: {}, docs: {} }) as never, '/api/ask');
    await p.ask('last job at 123 Main Street', { inputMode: 'voice' });
    await p.ask('last job at 123 Main Street');
    await p.ask('last job at 123 Main Street', { inputMode: 'voice', onStep: () => {} });
  } finally { globalThis.fetch = realFetch; }
  eq(bodies[0]?.inputMode, 'voice', 'api: voice question carries inputMode "voice"');
  ok(!('inputMode' in (bodies[1] ?? {})), 'api: typed question body is unchanged');
  eq(bodies[2]?.inputMode, 'voice', 'api: voice + streaming still carries inputMode');
  const server = readFileSync(new URL('../api/ask.js', import.meta.url), 'utf8');
  ok(/const inputMode = req\.body\?\.inputMode === "voice" \? "voice" : "typed";/.test(server), 'api/ask.js: only "voice" is accepted, anything else is typed');
  ok(/entityGate = \{[^}]*inputMode/.test(server), 'api/ask.js: inputMode handed to the entity gate');
}

// ---- 7. flag off = no mic rendered; flag on shapes ----
{
  const off: VoiceInput = { enabled: false, supported: true, listening: false, error: null, autoSend: false, setAutoSend() {}, toggle() {}, dictated: false, noteManualEdit() {}, markSent() {} };
  eq(renderToStaticMarkup(createElement(VoiceMicButton, { voice: off })), '', 'flag off: no mic');
  eq(renderToStaticMarkup(createElement(VoiceStatus, { voice: off })), '', 'flag off: no status or switch');
  let touched = 0;
  const Probe = () => { const v = useVoiceInput({ value: '', setValue() {}, send() {}, enabled: false, Ctor: class { constructor() { touched++; } } as never }); return createElement('i', null, v.enabled ? 'on' : 'off'); };
  eq(renderToStaticMarkup(createElement(Probe)), '<i>off</i>', 'flag off: hook is inert'); eq(touched, 0, 'flag off: engine never constructed');
  const DefaultProbe = () => { const v = useVoiceInput({ value: '', setValue() {}, send() {} }); return createElement('i', null, v.enabled ? 'on' : 'off'); };
  eq(renderToStaticMarkup(createElement(DefaultProbe)), '<i>off</i>', 'flag off by default (no env set)');
  const unsupported = renderToStaticMarkup(createElement(VoiceMicButton, { voice: { ...off, enabled: true, supported: false } }));
  ok(unsupported.includes('title="' + VOICE_UNSUPPORTED_TIP.replace(/'/g, '&#x27;') + '"') && !unsupported.includes('<button'), 'unsupported browser: inert icon with the reason as tooltip');
  const idle = renderToStaticMarkup(createElement(VoiceMicButton, { voice: { ...off, enabled: true } }));
  ok(idle.includes('<button') && idle.includes('aria-label="Ask by voice"') && idle.includes('aria-pressed="false"') && idle.includes('focus-visible:outline'), 'idle mic: button, label, pressed=false, visible focus');
  const live = renderToStaticMarkup(createElement(VoiceMicButton, { voice: { ...off, enabled: true, listening: true } }));
  ok(live.includes('aria-label="Stop listening"') && live.includes('aria-pressed="true"'), 'listening mic: label and pressed=true');
  const status = renderToStaticMarkup(createElement(VoiceStatus, { voice: { ...off, enabled: true, listening: true } }));
  ok(status.includes('role="status"') && status.includes('Listening') && status.includes('role="switch"') && status.includes('aria-checked="false"'), 'status: live region and send-automatically switch default off');
  const AutoOff = () => { const v = useVoiceInput({ value: '', setValue() {}, send() {}, enabled: true, Ctor: Ctor }); return createElement('i', null, String(v.autoSend)); };
  eq(renderToStaticMarkup(createElement(AutoOff)), '<i>false</i>', 'send automatically defaults to off');
  // both composers only ever render the mic through the shared component, behind the switch
  for (const f of ['../src/screens/AskScreen.tsx', '../src/mobile/AskTab.tsx']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    ok(src.includes('<VoiceMicButton') && src.includes('<VoiceStatus') && !/webkitSpeechRecognition|new SpeechRecognition/.test(src), `${f}: uses the shared voice component`);
    ok(/inputMode: 'voice'/.test(src) && src.includes('normalizeSpoken'), `${f}: sends inputMode and normalised text`);
  }
}

if (failures.length) { console.error(`verify:voice FAILED (${failures.length}):\n- ${failures.join('\n- ')}`); process.exit(1); }
console.log(`verify:voice OK (${passed} checks)`);
