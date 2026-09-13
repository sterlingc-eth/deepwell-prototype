/**
 * Page renderings — the viewer's contract with extraction.
 *
 * For a document id the viewer fetches `/docs/<documentId>.json`:
 *
 *   {
 *     pages: [
 *       {
 *         url: '/docs/<documentId>-p1.svg',   // any image the browser can draw
 *         width: 816, height: 1056,           // page units (US Letter at 96 dpi here)
 *         fields: {                           // bbox of each extracted field's VALUE text
 *           'Serial No.': { page: 1, x: 120, y: 340, w: 210, h: 22 }
 *         }
 *       }
 *     ]
 *   }
 *
 * Bounding boxes are in page units, so the overlay scales with the image no
 * matter how it is rasterised. Today the files come from
 * scripts/gen-sample-pages.mjs; real uploads (M2) will write the same shape
 * from the extraction step. A 404 (or a malformed file) resolves to null and
 * the viewer falls back to the extracted-fields list.
 */

export interface FieldBox {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PageRendering {
  url: string;
  width: number;
  height: number;
  fields: Record<string, FieldBox>;
}

export interface PageRenderings {
  pages: PageRendering[];
}

const cache = new Map<string, Promise<PageRenderings | null>>();

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function parseBox(v: unknown): FieldBox | null {
  if (!isRecord(v)) return null;
  const { page, x, y, w, h } = v;
  if (!isNum(page) || !isNum(x) || !isNum(y) || !isNum(w) || !isNum(h)) return null;
  return { page, x, y, w, h };
}

function parsePage(v: unknown): PageRendering | null {
  if (!isRecord(v)) return null;
  const { url, width, height, fields } = v;
  if (typeof url !== 'string' || !isNum(width) || !isNum(height) || width <= 0 || height <= 0) return null;
  const out: Record<string, FieldBox> = {};
  if (isRecord(fields)) {
    for (const [name, raw] of Object.entries(fields)) {
      const box = parseBox(raw);
      if (box) out[name] = box;
    }
  }
  return { url, width, height, fields: out };
}

export function parsePageRenderings(raw: unknown): PageRenderings | null {
  if (!isRecord(raw) || !Array.isArray(raw.pages)) return null;
  const pages: PageRendering[] = [];
  for (const p of raw.pages) {
    const page = parsePage(p);
    if (!page) return null;
    pages.push(page);
  }
  if (pages.length === 0) return null;
  return { pages };
}

/** Where the sidecar lives for a document. Exported so tests and tooling agree with the viewer. */
export function renderingsUrl(documentId: string): string {
  return `${import.meta.env.BASE_URL}docs/${encodeURIComponent(documentId)}.json`;
}

/**
 * Fetches and caches the page renderings for a document.
 * Resolves to null when the document has no renderings (404) or the file is malformed.
 */
export function loadPageRenderings(documentId: string): Promise<PageRenderings | null> {
  const hit = cache.get(documentId);
  if (hit) return hit;
  let networkFailure = false;
  const p = (async (): Promise<PageRenderings | null> => {
    try {
      const res = await fetch(renderingsUrl(documentId), { headers: { Accept: 'application/json' } });
      if (!res.ok) return null;
      // A dev server may answer an unknown path with index.html (200); guard on the content type.
      const type = res.headers.get('content-type') ?? '';
      if (!type.includes('json')) return null;
      return parsePageRenderings((await res.json()) as unknown);
    } catch {
      networkFailure = true;
      return null;
    }
  })();
  cache.set(documentId, p);
  // 404s and malformed files are cached as null; a dropped connection is not.
  void p.then(() => {
    if (networkFailure) cache.delete(documentId);
  });
  return p;
}

/** Test hook: forget everything cached. */
export function clearPageRenderingsCache(): void {
  cache.clear();
}
