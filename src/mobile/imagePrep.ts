/**
 * On-device prep for field scans, before they go through the normal ingest
 * path (src/services/ingestClient.ts):
 *   - photos are downscaled + re-encoded as JPEG (phone cameras produce 4–12 MB
 *     HEIC/JPEG; the reader only accepts jpeg/png/gif/webp under 24 MB and
 *     reads ~2000 px just as well), which also makes uploads fast on LTE;
 *   - several photos of one paper can be combined into a single PDF so a
 *     3-page work order lands as ONE document, not three.
 * Anything that can't be decoded (an unusual format) is passed through as-is
 * and the server's own validation has the final word.
 */

const MAX_EDGE = 2200
const JPEG_QUALITY = 0.85

export interface PreparedPage {
  blob: Blob
  width: number
  height: number
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
}

export function scanFilename(ext: 'jpg' | 'pdf', index?: number): string {
  return `Scan ${stamp()}${index != null ? ` (${index + 1})` : ''}.${ext}`
}

async function decode(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' })
    } catch {
      /* fall back to <img> below */
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.decoding = 'async'
    img.src = url
    await img.decode()
    return img
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Downscale + JPEG-encode one photo. Returns null if the browser can't decode it. */
export async function preparePhoto(file: Blob): Promise<PreparedPage | null> {
  let source: ImageBitmap | HTMLImageElement
  try {
    source = await decode(file)
  } catch {
    return null
  }
  const w0 = 'naturalWidth' in source ? source.naturalWidth : source.width
  const h0 = 'naturalHeight' in source ? source.naturalHeight : source.height
  const scale = Math.min(1, MAX_EDGE / Math.max(w0, h0))
  const width = Math.round(w0 * scale)
  const height = Math.round(h0 * scale)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(source, 0, 0, width, height)
  if ('close' in source) source.close()
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY))
  return blob ? { blob, width, height } : null
}

/** Several prepared photos -> one PDF, one page per photo, each page sized to its photo. */
export async function combineToPdf(pages: PreparedPage[]): Promise<Blob> {
  const { jsPDF } = await import('jspdf')
  // Points at 150 dpi-equivalent keeps the page dimensions sane for any viewer.
  const toPt = (px: number) => (px * 72) / 150
  const first = pages[0]
  if (!first) throw new Error('No pages to combine')
  const pdf = new jsPDF({
    unit: 'pt',
    format: [toPt(first.width), toPt(first.height)],
    orientation: first.width > first.height ? 'landscape' : 'portrait',
    compress: true,
  })
  for (const [i, p] of pages.entries()) {
    const w = toPt(p.width)
    const h = toPt(p.height)
    if (i > 0) pdf.addPage([w, h], w > h ? 'landscape' : 'portrait')
    const bytes = new Uint8Array(await p.blob.arrayBuffer())
    pdf.addImage(bytes, 'JPEG', 0, 0, w, h, undefined, 'NONE')
  }
  return pdf.output('blob')
}
