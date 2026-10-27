/**
 * One visitor file (bytes in memory) -> page text, through the real app's reading routing: readPdfOrImage() in readDocument.js.
 *   PDF text layer first (no model) -> license barcode lane (no model) -> Haiku vision ONLY for scanned pages and photos.
 * The demo context (`ctx`) carries no tenant: ctx.onUsage books the cost into the demo's own spend counter, ctx.haikuOnly pins the
 * vision read to one Haiku call with no escalation pass (see extractWithClaude in readDocument.js). Nothing here touches a database.
 *
 * Validation happens BEFORE any model call: type by magic bytes (never by file name or the browser's guess), page count, size.
 */
import { readPdfOrImage, sniffMagicBytes, hasReadableText, IngestError } from '../../readDocument.js';
import { pdfPageCount } from '../../modelAvoidance/pdfPages.js';
import { LIMITS } from './config.js';

export class RejectError extends Error {
  constructor(code) { super(code); this.name = 'RejectError'; this.code = code; }
}

/**
 * Pure-ish (no model). @returns {{type: string, pages: number}}
 * @throws {RejectError} code in: empty | too-big | heic | wrong-type | unreadable
 */
export function inspectFile(bytes) {
  if (!bytes || bytes.length === 0) throw new RejectError('empty');
  if (bytes.length > LIMITS.maxFileBytes) throw new RejectError('too-big');
  const type = sniffMagicBytes(bytes);
  if (type === 'image/heic' || type === 'image/heif') throw new RejectError('heic');
  if (!type || !LIMITS.types.includes(type)) throw new RejectError('wrong-type');
  if (type === 'application/pdf') {
    let n = 0;
    try { n = pdfPageCount(bytes); } catch { n = 0; }
    if (!n) throw new RejectError('unreadable'); // encrypted, damaged, or not a PDF the page reader can open
    return { type, pages: n };
  }
  return { type, pages: 1 };
}

/** How the pages were read, in the visitor's words (config TEXT.readHow keys). */
export function howRead(method, readSource) {
  const s = String(readSource ?? '');
  if (s === 'pdf-text-layer') return 'text';
  if (s === 'aamva-barcode') return 'barcode';
  if (s.startsWith('pdf-mixed')) return 'mixed';
  return method === 'model' ? 'vision' : 'text';
}

/**
 * @param {Buffer} bytes
 * @param {string} type  from inspectFile
 * @param {{onUsage: Function, model: string}} demoCtx
 * @returns {Promise<{pages: {page_no:number,text:string}[], how: string}>}
 * @throws {RejectError} unreadable
 */
export async function readBytes(bytes, type, demoCtx, startedAt = Date.now()) {
  const ctx = { tenantKey: null, tenantName: null, haikuOnly: true, model: demoCtx.model, onUsage: demoCtx.onUsage };
  let r;
  try {
    r = await readPdfOrImage(bytes, type, ctx, startedAt);
  } catch (err) {
    if (err instanceof IngestError && (err.status === 413 || err.status === 415 || err.status === 422)) throw new RejectError('unreadable');
    throw err;
  }
  const pages = (r.pages ?? []).map((p) => ({ page_no: Number(p.page_no), text: String(p.text ?? '') })).filter((p) => Number.isFinite(p.page_no));
  if (!hasReadableText(pages)) throw new RejectError('unreadable');
  return { pages, how: howRead(r.method, r.readSource) };
}
