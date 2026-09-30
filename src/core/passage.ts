/**
 * Passage highlight (R31 Loop 3a): find the cited words inside a document's text so the viewer can mark
 * them and scroll to them. Pure and dependency-free (unit-tested by scripts/verify-r31-capabilities.mjs).
 * Kill switch: VITE_PASSAGE_HIGHLIGHT=0 (default on; it only ever adds a <mark> and a scroll).
 */

export function passageHighlightOn(): boolean {
  try {
    return (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_PASSAGE_HIGHLIGHT !== '0';
  } catch {
    return true;
  }
}

export interface PassageSpan {
  start: number;
  end: number;
}

// Whitespace/quote/ellipsis-insensitive, case-insensitive matching. Builds a normalized copy of `text`
// plus a map from each normalized index back to the original index, so the span returned is in the
// ORIGINAL string (what we render).
function normalize(text: string): { norm: string; map: number[] } {
  let norm = '';
  const map: number[] = [];
  let lastSpace = true;
  for (let i = 0; i < text.length; i++) {
    let ch = text[i]!;
    if (ch === '‘' || ch === '’') ch = "'";
    else if (ch === '“' || ch === '”') ch = '"';
    if (/\s/.test(ch)) {
      if (lastSpace) continue;
      norm += ' ';
      map.push(i);
      lastSpace = true;
      continue;
    }
    norm += ch.toLowerCase();
    map.push(i);
    lastSpace = false;
  }
  return { norm: norm.replace(/ $/, ''), map };
}

/** Strip the "…" a server-side quote may carry at either end, and trim. */
export function passageNeedle(quote: string | undefined | null): string {
  return (quote ?? '').replace(/^[\s.…]+|[\s.…]+$/g, '').trim();
}

/**
 * The span of `text` that matches `needle`. Exact (normalized) match first; failing that, the longest
 * leading/trailing run of the needle's words (>= 3 words or >= 12 chars) so a quote the model trimmed
 * still lands. Returns null when nothing credible matches — the viewer then just doesn't highlight.
 */
export function findPassage(text: string, needle: string | undefined | null): PassageSpan | null {
  const n = passageNeedle(needle);
  if (!text || n.length < 3) return null;
  const { norm, map } = normalize(text);
  const nn = normalize(n).norm;
  if (!nn) return null;
  const at = (i: number, len: number): PassageSpan => ({ start: map[i]!, end: map[i + len - 1]! + 1 });
  let i = norm.indexOf(nn);
  if (i >= 0) return at(i, nn.length);
  const words = nn.split(' ');
  for (let k = words.length - 1; k >= 3 || (k >= 1 && words.slice(0, k).join(' ').length >= 12); k--) {
    const head = words.slice(0, k).join(' ');
    i = norm.indexOf(head);
    if (i >= 0) return at(i, head.length);
    const tail = words.slice(words.length - k).join(' ');
    i = norm.indexOf(tail);
    if (i >= 0) return at(i, tail.length);
  }
  return null;
}

export interface PassageSegment {
  text: string;
  hit: boolean;
}

export function splitByPassage(text: string, needle: string | undefined | null): PassageSegment[] {
  const span = findPassage(text, needle);
  if (!span) return [{ text, hit: false }];
  return [
    ...(span.start > 0 ? [{ text: text.slice(0, span.start), hit: false }] : []),
    { text: text.slice(span.start, span.end), hit: true },
    ...(span.end < text.length ? [{ text: text.slice(span.end), hit: false }] : []),
  ];
}

/** Presigned URL + PDF open parameters (#page=N is honored by the browser PDF viewers; a no-op elsewhere). */
export function withPdfPage(url: string, page: number | undefined | null): string {
  if (!page || !Number.isFinite(page) || page < 1 || url.includes('#')) return url;
  return `${url}#page=${Math.floor(page)}`;
}
