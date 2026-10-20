/**
 * Spoken-form clean-up for dictated questions. Pure, no DOM. Runs at SEND time only: the box keeps the
 * transcript exactly as the browser heard it, and the normalised text is what goes to /api/ask.
 *
 * Deliberately conservative. It only rewrites a number when the words around it say what kind of
 * number it is (a year, a unit, a street address, a record number, or a long run of single digits),
 * so "one of our customers" and "two weeks ago" are never touched.
 *
 *   "twenty twenty five"            -> "2025"
 *   "unit four b"                   -> "unit 4B"
 *   "one two three main street"     -> "123 Main Street"
 *   "invoice one zero four two"     -> "invoice 1042"
 */

const DIGIT: Record<string, number> = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const TEEN: Record<string, number> = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

const NUMW = '(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)';
const RUN = `${NUMW}(?:[\\s-]+${NUMW})*`;
const ONE_TO_NINE = '(?:one|two|three|four|five|six|seven|eight|nine)';
const TENS_W = '(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)';
const TEEN_W = '(?:ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)';

const SUFFIXES = 'street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|court|ct|way|circle|cir|place|pl|parkway|pkwy|trail|terrace|ter|highway|hwy';
const STOP = new Set(['and', 'the', 'at', 'of', 'to', 'for', 'on', 'in', 'is', 'was', 'a', 'an', 'my', 'our', 'by', 'from', 'with', 'about']);

const words = (run: string): string[] => run.toLowerCase().split(/[\s-]+/).filter(Boolean);

/** Number words -> digit string, or null when the run is not a clean number. */
export function parseNumberRun(run: string): string | null {
  const ws = words(run);
  if (!ws.length) return null;
  const dg = (w: string) => DIGIT[w] ?? 0;
  const tn = (w: string) => TEEN[w] ?? 0;
  const ty = (w: string) => TENS[w] ?? 0;
  if (ws.some((w) => !(w in DIGIT || w in TEEN || w in TENS || w === 'hundred' || w === 'thousand'))) return null;
  if (ws.includes('hundred') || ws.includes('thousand')) {
    let total = 0;
    let cur = 0;
    for (const w of ws) {
      if (w in DIGIT) cur += dg(w);
      else if (w in TEEN) cur += tn(w);
      else if (w in TENS) cur += ty(w);
      else if (w === 'hundred') cur = (cur || 1) * 100;
      else { total += (cur || 1) * 1000; cur = 0; }
    }
    return String(total + cur);
  }
  // Spoken digit by digit or in pairs ("twelve thirty four" -> 1234, "twenty twenty five" -> 2025).
  let out = '';
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i] ?? '';
    const next = ws[i + 1];
    if (w in TEEN) out += String(tn(w));
    else if (w in TENS) {
      if (next && next in DIGIT && dg(next) > 0) { out += String(ty(w) + dg(next)); i++; }
      else out += String(ty(w));
    } else out += String(dg(w));
  }
  return out;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

export interface SpokenChange { kind: 'address' | 'unit' | 'record-number' | 'year' | 'digits'; from: string; to: string }
export interface NormalizedSpeech { text: string; changes: SpokenChange[] }

export function normalizeSpoken(input: string): NormalizedSpeech {
  const changes: SpokenChange[] = [];
  let t = String(input ?? '');
  const note = (kind: SpokenChange['kind'], from: string, to: string) => { changes.push({ kind, from, to }); return to; };

  // 1. Street address: "<number words> <1-3 name words> <street suffix>"
  t = t.replace(new RegExp(`\\b(${RUN})\\s+((?:[A-Za-z']+\\s+){1,3}?)(${SUFFIXES})\\b\\.?`, 'gi'), (m, run: string, name: string, suffix: string) => {
    const num = parseNumberRun(run);
    const nameWords = name.trim().split(/\s+/);
    if (!num || nameWords.some((w) => STOP.has(w.toLowerCase()) || w.toLowerCase() in DIGIT || w.toLowerCase() in TEEN || w.toLowerCase() in TENS)) return m;
    return note('address', m, `${num} ${nameWords.map(cap).join(' ')} ${cap(suffix)}`);
  });

  // 2. Unit / suite: "unit four b" -> "unit 4B"; also "unit 4 b" -> "unit 4B"
  const UNIT_KW = '(unit|apt|apartment|suite|ste|building|bldg|room|rm|lot)';
  t = t.replace(new RegExp(`\\b${UNIT_KW}\\s+(${RUN})([\\s-]+([a-z])(?![A-Za-z']))?`, 'gi'), (m: string, kw: string, run: string, lpart: string | undefined, letter: string | undefined, offset: number, whole: string) => {
    const num = parseNumberRun(run);
    if (!num) return m;
    // "unit four a day" keeps the article; a bare trailing "a" is the unit letter.
    const isLetter = !!letter && !(letter.toLowerCase() === 'a' && /^\s+[A-Za-z]/.test(whole.slice(offset + m.length)));
    const from = isLetter ? m : m.slice(0, m.length - (lpart?.length ?? 0));
    note('unit', from, `${kw} ${num}${isLetter ? letter!.toUpperCase() : ''}`);
    return `${kw} ${num}${isLetter ? letter!.toUpperCase() : ''}${isLetter ? '' : lpart ?? ''}`;
  });
  t = t.replace(new RegExp(`\\b${UNIT_KW}\\s+(\\d+)\\s+([A-Za-z])(?![A-Za-z'])`, 'gi'), (m: string, kw: string, n: string, l: string, offset: number, whole: string) =>
    l.toLowerCase() === 'a' && /^\s+[A-Za-z]/.test(whole.slice(offset + m.length)) ? m : note('unit', m, `${kw} ${n}${l.toUpperCase()}`));

  // 3. Record numbers: "invoice number one zero four two" -> "invoice number 1042"
  t = t.replace(new RegExp(`\\b(invoice|work order|purchase order|po|ticket|job|order|estimate|quote|customer|account)(\\s+(?:number|no\\.?|#))?\\s+(${RUN})\\b`, 'gi'), (m, kw: string, numWord: string | undefined, run: string) => {
    const num = parseNumberRun(run);
    if (!num) return m;
    return note('record-number', m, `${kw}${numWord ?? ''} ${num}`);
  });

  // 4. Years: "twenty twenty five", "nineteen ninety nine", "twenty oh five", "two thousand twenty five"
  const NOT_YEAR_NEXT = `(?![\\s-]+${NUMW})(?!\\s+(?:dollars?|bucks|percent|degrees|minutes|hours|gallons|units|pounds|feet|miles|calls?|jobs?)\\b)`;
  t = t.replace(new RegExp(`\\b((?:nineteen|twenty)[\\s-]+(?:oh[\\s-]+${ONE_TO_NINE}|${TEEN_W}|${TENS_W}(?:[\\s-]+${ONE_TO_NINE})?))\\b${NOT_YEAR_NEXT}`, 'gi'), (m, run: string) => {
    const n = parseNumberRun(run);
    return n && n.length === 4 ? note('year', run, n) : m;
  });
  t = t.replace(new RegExp(`\\b(two[\\s-]+thousand(?:[\\s-]+and)?(?:[\\s-]+(?:${TENS_W}(?:[\\s-]+${ONE_TO_NINE})?|${TEEN_W}|${ONE_TO_NINE}))?)\\b${NOT_YEAR_NEXT}`, 'gi'), (m, run: string) => {
    const n = parseNumberRun(run.replace(/[\s-]+and\b/i, ''));
    return n && n.length === 4 && n.startsWith('20') ? note('year', run, n) : m;
  });

  // 5. Any other run of 3+ single spoken digits is an identifier or zip code read out digit by digit.
  t = t.replace(/\b(?:(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)[\s-]+){2,}(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/gi, (m) => {
    const n = parseNumberRun(m);
    return n ? note('digits', m, n) : m;
  });

  return { text: t, changes };
}
