/**
 * D10 - dollar amounts the way people say them: "three thousand dollars", "five hundred", "ten grand", "3k", "2.5k", "$4K", "twenty five hundred",
 * "two and a half thousand", "a thousand", "3 thousand", plus the plain "$3,000" / "3000.50" forms the money parser already knew.
 *
 * Why: the invoice-threshold parser (financials/answers.js THRESHOLD_RE) only read digits, so "invoices over three thousand dollars" and "over ten
 * grand" never matched it, fell to the plain document count and answered "We have 120 invoices on file" (every invoice, the threshold silently
 * dropped); "over 2.5k" matched "2" and answered "120 invoices are over $2.00" (a different number than the one asked).
 *
 * Pure, no I/O. parseAmountAt(text) reads ONE amount at the very start of `text` (after an optional "$"/"usd"/"about"/"roughly"/"around").
 * parseThreshold(question) finds "over/above/more than/exceeding/under/below/less than/at least/at most <amount>" in a question.
 */

const UNITS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const BIG = { thousand: 1000, grand: 1000, k: 1000, million: 1000000, mil: 1000000, m: 1000000 };
const NUMBER_WORD = new Set([...Object.keys(UNITS), ...Object.keys(TENS), 'hundred', 'thousand', 'grand', 'million', 'half']);

const NOISE_LEAD = /^(?:about|around|roughly|approximately|approx\.?|exactly|just|a total of|total of|the amount of|an amount of)\s+/i;

/** An amount at the very start of `text`: {value, length} (length = characters consumed) or null. */
export function parseAmountAt(text) {
  let s = String(text ?? '');
  const lead = /^\s*/.exec(s)[0].length;
  s = s.slice(lead);
  let offset = lead;
  for (;;) {
    const n = NOISE_LEAD.exec(s);
    if (!n) break;
    s = s.slice(n[0].length); offset += n[0].length;
  }
  const sign = /^\$\s*/.exec(s);
  if (sign) { s = s.slice(sign[0].length); offset += sign[0].length; }
  // Digits: 3000, 3,000, 2.5, 4k, 2.5k, 3 thousand, 2.5 thousand, 1.2m
  const dm = /^(\d[\d,]*(?:\.\d+)?|\.\d+)\s*(k\b|thousand\b|grand\b|g\b|million\b|mil\b|m\b)?/i.exec(s);
  if (dm) {
    const base = Number(dm[1].replace(/,/g, ''));
    if (!Number.isFinite(base)) return null;
    const suffix = (dm[2] ?? '').toLowerCase();
    // A trailing bare letter that is really the start of another word ("3 men", "5 grandchildren") is not a suffix - the regex's \b already guards that.
    const mult = suffix === 'k' || suffix === 'thousand' || suffix === 'grand' || suffix === 'g' ? 1000 : suffix === 'million' || suffix === 'mil' || suffix === 'm' ? 1000000 : 1;
    // "3 hundred"
    if (!suffix) {
      const hm = /^\s*hundred\b/i.exec(s.slice(dm[0].length));
      if (hm) return finish(base * 100, offset + dm[0].length + hm[0].length, s.slice(dm[0].length + hm[0].length));
    }
    return finish(base * mult, offset + dm[0].length, s.slice(dm[0].length));
  }
  // Words: "three thousand", "four thousand five hundred", "twenty five hundred", "two and a half thousand", "a thousand", "ten grand"
  const tokens = [];
  const re = /[a-z]+/gi;
  let m;
  while ((m = re.exec(s))) tokens.push({ w: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
  let total = 0; let current = 0; let used = 0; let lastEnd = 0; let any = false;
  for (let i = 0; i < tokens.length; i++) {
    const { w } = tokens[i];
    // Tokens must be separated only by spaces/hyphens (a comma or period ends the amount).
    if (i > 0 && /[^\s-]/.test(s.slice(tokens[i - 1].end, tokens[i].start))) break;
    const next = tokens[i + 1]?.w;
    if (w === 'a' || w === 'an') {
      if (!any && (next === 'thousand' || next === 'hundred' || next === 'grand' || next === 'million')) { current = 1; used = i + 1; lastEnd = tokens[i].end; any = true; continue; }
      if (any && tokens[i - 1]?.w === 'and' && next === 'half') { used = i + 1; lastEnd = tokens[i].end; continue; }
      break;
    }
    if (w === 'and') {
      const after = next;
      if (any && (after === 'a' || (after && NUMBER_WORD.has(after)))) { used = i + 1; lastEnd = tokens[i].end; continue; }
      break;
    }
    if (w === 'half') { if (!any) break; current += 0.5; used = i + 1; lastEnd = tokens[i].end; continue; }
    if (w in UNITS) { current += UNITS[w]; any = true; used = i + 1; lastEnd = tokens[i].end; continue; }
    if (w in TENS) { current += TENS[w]; any = true; used = i + 1; lastEnd = tokens[i].end; continue; }
    if (w === 'hundred') { if (!any) break; current = (current || 1) * 100; used = i + 1; lastEnd = tokens[i].end; continue; }
    if (w === 'thousand' || w === 'grand' || w === 'million') {
      if (!any) break;
      const mult = w === 'million' ? 1000000 : 1000;
      total += (current || 1) * mult; current = 0; used = i + 1; lastEnd = tokens[i].end; continue;
    }
    break;
  }
  if (!any || !used) return null;
  const value = total + current;
  return finish(value, offset + lastEnd, s.slice(lastEnd));
}

/** Swallows a trailing "dollars"/"bucks"/"usd" and returns the amount. */
function finish(value, end, rest) {
  if (!Number.isFinite(value)) return null;
  const tail = /^\s*(?:dollars?|bucks?|usd)\b/i.exec(rest);
  return { value, length: end + (tail ? tail[0].length : 0) };
}

const DIRECTION_RE = /\b(over|above|more than|greater than|exceeding|exceeds|under|below|less than|fewer than|at least|at most|no more than|no less than|up to)\b\s*/gi;
const DIRECTION_KIND = {
  over: 'over', above: 'over', 'more than': 'over', 'greater than': 'over', exceeding: 'over', exceeds: 'over',
  under: 'under', below: 'under', 'less than': 'under', 'fewer than': 'under',
  'at least': 'atleast', 'no less than': 'atleast', 'at most': 'atmost', 'no more than': 'atmost', 'up to': 'atmost',
};
const AMOUNT_START = /^\s*(?:\$|\d|\.\d|(?:about|around|roughly|approximately|exactly|a|an)\b|(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fourty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|grand|half)\b)/i;

/**
 * "invoices over ten grand" -> {dir: 'over', inclusive: false, amount: 10000, unparsed: false}.
 * dir is 'over' | 'under'; inclusive is true for "at least"/"at most". When a direction word is followed by something that LOOKS like an amount but
 * cannot be read, returns {unparsed: true} so the caller declines to answer the unfiltered question. null when the question names no amount threshold
 * (a direction word followed by "30 days" or "the last year" is not one).
 */
export function parseThreshold(question) {
  const q = String(question ?? '');
  DIRECTION_RE.lastIndex = 0;
  let m;
  while ((m = DIRECTION_RE.exec(q))) {
    const rest = q.slice(m.index + m[0].length);
    if (!AMOUNT_START.test(rest)) continue;
    const kind = DIRECTION_KIND[m[1].toLowerCase()];
    const dir = kind === 'over' || kind === 'atleast' ? 'over' : 'under';
    const inclusive = kind === 'atleast' || kind === 'atmost';
    const got = parseAmountAt(rest);
    if (!got) {
      // "over a year", "under an hour" are not amounts - only flag a dollar sign / digit / number word that could not be read.
      if (/^\s*(?:\$|\d|\.\d)/.test(rest)) return { unparsed: true };
      continue;
    }
    // "over 30 days" / "under 5 years" / "more than 10 units" are not dollar amounts.
    if (/^\s*(?:days?|weeks?|months?|years?|hours?|minutes?|units?|tons?|visits?|invoices?|customers?|jobs?|times?|pieces?|items?|%|percent)\b/i.test(rest.slice(got.length))) continue;
    return { dir, inclusive, amount: got.value, unparsed: false };
  }
  return null;
}

/** R39 round 5: does the question contain "between <amount> and <amount>" where an end carries a currency marker ($, k, grand, dollars, usd, bucks)? Used ONLY to
 *  decline: no lane answers an amount range, and a lane that ignores the range would return the whole-shop count or a false zero. A bare pair with no marker
 *  ("between 2020 and 2025") is not matched and stays whatever it was (a year window). */
const BTW_AMT = String.raw`(\$\s*)?\d[\d,]*(?:\.\d+)?(\s*(?:k|grand|dollars?|usd|bucks)\b)?`;
const BTW_RE = new RegExp(String.raw`\bbetween\s+${BTW_AMT}\s+(?:and|to|-)\s+${BTW_AMT}`, 'i');
export function betweenWithCurrency(question) {
  const m = BTW_RE.exec(String(question ?? ''));
  if (!m) return false;
  return Boolean(m[1] || m[2] || m[3] || m[4]) || /\b(?:dollars?|usd|bucks)\b/i.test(String(question ?? ''));
}
