/**
 * Pipeline step 1 — receive: hash, exact-dup check, page rendering.
 * See docs/INGEST_API.md, "Pipeline", item 1.
 */
import type { Doc, DocumentId } from '../types';
import type { PipelineContext, StepPatch } from './runner';

export interface ReceivedFile {
  documentId: DocumentId;
  filename: string;
  fileType: Doc['fileType'];
  bytes: ArrayBuffer;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function bytesToBase64(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < arr.length; i += chunk) {
    binary += String.fromCharCode(...arr.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function mediaTypeFor(filename: string): string {
  const f = filename.toLowerCase();
  if (f.endsWith('.png')) return 'image/png';
  if (f.endsWith('.jpg') || f.endsWith('.jpeg')) return 'image/jpeg';
  if (f.endsWith('.webp')) return 'image/webp';
  if (f.endsWith('.heic')) return 'image/heic';
  if (f.endsWith('.gif')) return 'image/gif';
  return 'application/octet-stream';
}

/** Minimal CSV splitter — good enough for the prototype's generated spreadsheets. */
function parseCsv(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => line.split(',').map((cell) => cell.trim()));
}

interface PdfPageLike {
  getViewport(opts: { scale: number }): { width: number; height: number };
  render(opts: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }): { promise: Promise<void> };
}

interface PdfjsModuleLike {
  getDocument: (opts: { data: Uint8Array }) => { promise: Promise<{ numPages: number; getPage: (n: number) => Promise<PdfPageLike> }> };
}

/**
 * Renders a PDF's pages to PNG data URLs using `pdfjs-dist`. That package is
 * owned by the UI agent to add to package.json (see docs/INGEST_API.md file
 * ownership) and may not be installed yet. Loaded through a non-literal
 * dynamic import so this module still type-checks and runs before that
 * dependency lands — once it's installed, real page rendering activates
 * with no code change here. Until then, or if rendering fails for any
 * reason (a password-protected PDF, for instance), this returns no pages
 * and the caller falls back to the same "no visual page" path spreadsheets
 * use, per the contract's requirement that a password-protected PDF must
 * fail gracefully rather than throw.
 */
async function renderPdfPages(bytes: ArrayBuffer): Promise<string[]> {
  try {
    const specifier = 'pdfjs-dist';
    const pdfjs = (await import(/* @vite-ignore */ specifier)) as unknown as PdfjsModuleLike;
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
    const pages: string[] = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx2d = canvas.getContext('2d');
      if (!ctx2d) continue;
      await page.render({ canvasContext: ctx2d, viewport }).promise;
      pages.push(canvas.toDataURL('image/png'));
    }
    return pages;
  } catch {
    return [];
  }
}

export async function receive(doc: Doc, file: ReceivedFile, context: PipelineContext): Promise<StepPatch> {
  const hash = await sha256Hex(file.bytes);

  const existing = Object.values(context.graph.docs).find((d) => d.id !== doc.id && d.contentHash === hash);
  if (existing) {
    return {
      contentHash: hash,
      issues: [...doc.issues.filter((i) => i.kind !== 'duplicate'), { kind: 'duplicate', of: existing.id }],
      stage: 'received',
    };
  }

  if (file.fileType === 'image') {
    const dataUrl = `data:${mediaTypeFor(file.filename)};base64,${bytesToBase64(file.bytes)}`;
    return { contentHash: hash, pageImages: [dataUrl], pages: 1 };
  }

  if (file.fileType === 'spreadsheet') {
    // One page per sheet, per the contract; this prototype decodes a single
    // CSV text stream (a real .xlsx needs a sheet-splitting library, out of
    // scope here), so a CSV upload is one page.
    const text = new TextDecoder().decode(file.bytes);
    const rows = parseCsv(text);
    const pageText = [rows.map((row) => row.join(' | ')).join('\n')];
    return { contentHash: hash, pageText, pages: 1 };
  }

  if (file.fileType === 'pdf') {
    const pages = await renderPdfPages(file.bytes);
    if (pages.length) return { contentHash: hash, pageImages: pages, pages: pages.length };
    // pdfjs-dist unavailable, or the PDF couldn't be rendered (e.g. password-protected) — fail gracefully.
    return {
      contentHash: hash,
      pageText: ['(no visual page — this PDF could not be rendered; it may be password-protected)'],
      pages: 1,
      issues: [...doc.issues, { kind: 'missing-field', field: 'page render' }],
    };
  }

  // Plain text: one "page" of text, no visual rendering.
  const text = new TextDecoder().decode(file.bytes);
  return { contentHash: hash, pageText: [text], pages: 1 };
}
