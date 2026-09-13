/**
 * Pipeline step 2 — read: the universal, schema-free reading pass.
 * Calls `POST /api/ingest/read` once per rendered page and collects
 * segments + facets, unfiltered, per docs/INGEST_API.md.
 *
 * Pages with no visual rendering (receive.ts's `pageText` fallback — a CSV
 * sheet, a page render.ts couldn't produce) skip the model call entirely
 * and are read directly into facets, per the contract's "skipping the
 * vision call" instruction.
 */
import type { Bbox, Doc, Facet, Segment, ValueTypeGuess } from '../types';
import type { PipelineContext } from './runner';
import { newId } from './runner';

export interface ReadStepResult {
  facets: Facet[];
  segments: Segment[];
}

interface ReadApiSegment {
  kind: Segment['kind'];
  bbox: { x: number; y: number; w: number; h: number };
}

interface ReadApiFacet {
  labelRaw: string;
  valueRaw: string;
  valueTypeGuess: ValueTypeGuess;
  bbox: { x: number; y: number; w: number; h: number };
  confidence: number;
}

interface ReadApiResponse {
  segments: ReadApiSegment[];
  facets: ReadApiFacet[];
}

function inBounds(b: { x: number; y: number; w: number; h: number }): boolean {
  return [b.x, b.y, b.w, b.h].every((n) => Number.isFinite(n) && n >= 0 && n <= 1);
}

function mediaTypeOfDataUrl(dataUrl: string): string {
  const m = /^data:([^;]+);base64,/.exec(dataUrl);
  return m?.[1] ?? 'image/png';
}
function base64OfDataUrl(dataUrl: string): string {
  const idx = dataUrl.indexOf(',');
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}

async function readPageImage(documentId: string, page: number, dataUrl: string, filename: string): Promise<ReadApiResponse> {
  const res = await fetch('/api/ingest/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pageImageBase64: base64OfDataUrl(dataUrl),
      mediaType: mediaTypeOfDataUrl(dataUrl),
      documentId,
      page,
      hint: { filename },
    }),
  });
  if (!res.ok) throw new Error(`POST /api/ingest/read failed: ${res.status}`);
  return (await res.json()) as ReadApiResponse;
}

/** Turns "header | header2\nval | val2" CSV-ish page text into facets directly — no model call. */
function facetsFromPageText(documentId: string, page: number, text: string): Facet[] {
  const lines = text.split('\n').filter(Boolean);
  const header = lines[0]?.split('|').map((c) => c.trim());
  if (!header || header.length < 2) return [];
  const out: Facet[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split('|').map((c) => c.trim());
    for (let i = 0; i < header.length; i++) {
      const label = header[i];
      const value = cells[i];
      if (!label || !value) continue;
      out.push({
        id: newId('facet'),
        documentId,
        page,
        labelRaw: label,
        valueRaw: value,
        valueTypeGuess: /^\d[\d,.]*$/.test(value) ? 'number' : 'text',
        bbox: { page, x: 0, y: 0, w: 1, h: 1 },
        confidence: 0.85,
        linkedEntityIds: [],
      });
    }
  }
  return out;
}

export async function read(doc: Doc, _context: PipelineContext): Promise<ReadStepResult> {
  const facets: Facet[] = [];
  const segments: Segment[] = [];

  const pageImages = doc.pageImages ?? [];
  const pageText = doc.pageText ?? [];

  if (pageImages.length) {
    for (let i = 0; i < pageImages.length; i++) {
      const page = i + 1;
      const dataUrl = pageImages[i];
      if (!dataUrl) continue;
      const result = await readPageImage(doc.id, page, dataUrl, doc.filename);
      for (const s of result.segments ?? []) {
        if (!inBounds(s.bbox)) continue;
        segments.push({ id: newId('seg'), documentId: doc.id, page, kind: s.kind, bbox: { page, ...s.bbox } satisfies Bbox });
      }
      for (const f of (result.facets ?? []).slice(0, 60)) {
        if (!inBounds(f.bbox)) continue;
        facets.push({
          id: newId('facet'),
          documentId: doc.id,
          page,
          labelRaw: f.labelRaw,
          valueRaw: f.valueRaw,
          valueTypeGuess: f.valueTypeGuess,
          bbox: { page, ...f.bbox },
          confidence: f.confidence,
          linkedEntityIds: [],
        });
      }
    }
  } else {
    for (let i = 0; i < pageText.length; i++) {
      const page = i + 1;
      const text = pageText[i];
      if (!text) continue;
      facets.push(...facetsFromPageText(doc.id, page, text));
    }
  }

  return { facets, segments };
}
