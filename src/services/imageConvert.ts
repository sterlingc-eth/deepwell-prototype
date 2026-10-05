/**
 * iPhone photos (HEIC/HEIF) -> JPEG, in the BROWSER, before anything is uploaded.
 *
 * The server never accepts .heic/.heif (api/_lib/uploadTypes.js): converting on the server would need a native or WASM decoder
 * we do not ship. iPhone Safari (and Safari on a Mac) can decode HEIC itself, so the one shared helper below decodes with the
 * browser (createImageBitmap, falling back to an <img>), draws it on a canvas and re-encodes it as a JPEG. Every client intake
 * (desktop pickers, drag-drop and folder import, the phone Scan tab and offline queue, expenses, serial/plate capture) calls
 * `prepareImageForUpload` first. A browser that cannot decode HEIC (most desktop Chrome/Firefox builds) gets a plain message and
 * NOTHING is uploaded - the raw HEIC is never sent.
 *
 * Detection is by the file's own bytes (ISO-BMFF "ftyp" box with a HEIC/HEIF brand), not only by name or declared type: iOS
 * sometimes hands over HEIC bytes named ".jpg", and Windows hands over ".heic" with no type at all.
 */

/** Shown when this browser cannot decode the photo. Keeps the 'Most Compatible' instruction (it makes the iPhone camera itself save JPEG). */
export const HEIC_CANNOT_CONVERT_MESSAGE =
  "This is an iPhone HEIC photo and this browser can't convert it. Open DeepWell in Safari on the iPhone, or switch the camera to Settings > Camera > Formats > Most Compatible, " +
  "or share/export the photo as a JPEG, then add it again. Nothing was uploaded.";

/** Longest edge of the converted JPEG. 4096 keeps a 12 MP iPhone photo at full resolution (4032 px) while capping 48 MP originals. */
export const HEIC_MAX_EDGE = 4096;
export const HEIC_JPEG_QUALITY = 0.9;

// Major/compatible brands that mean HEIC/HEIF still images or sequences.
const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1']);

/** True when these first bytes are an ISO-BMFF file whose major brand (or a compatible brand) is a HEIC/HEIF brand. */
export function isHeicBytes(head: Uint8Array): boolean {
  if (head.length < 12) return false;
  const ascii = (a: number, b: number) => String.fromCharCode(...head.subarray(a, b));
  if (ascii(4, 8) !== 'ftyp') return false;
  if (HEIC_BRANDS.has(ascii(8, 12))) return true;
  // compatible brands follow the 4-byte minor version, starting at byte 16, up to the end of the ftyp box
  const boxLen = ((head[0]! << 24) | (head[1]! << 16) | (head[2]! << 8) | head[3]!) >>> 0;
  const end = Math.min(head.length, boxLen || head.length);
  for (let i = 16; i + 4 <= end; i += 4) if (HEIC_BRANDS.has(ascii(i, i + 4))) return true;
  return false;
}

const HEIC_NAME = /\.(heic|heif|heics|heifs)$/i;
const HEIC_TYPE = /^image\/(heic|heif)(-sequence)?$/i;

/** HEIC by bytes first (authoritative), else by the name or declared type when the bytes could not be read. */
export async function isHeicFile(file: Blob & { name?: string }): Promise<boolean> {
  try {
    const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
    if (isHeicBytes(head)) return true;
    // Bytes were readable and say "not HEIC": a file merely NAMED .heic that is really a JPEG/PNG needs no conversion.
    if (head.length >= 12) return false;
  } catch {
    /* fall through to name / type */
  }
  return HEIC_NAME.test(file.name ?? '') || HEIC_TYPE.test(file.type ?? '');
}

export type PrepareImageResult =
  | { ok: true; file: File; converted: boolean }
  | { ok: false; message: string };

function jpgName(name: string): string {
  const base = name.replace(/[/\\]+$/, '');
  return /\.[A-Za-z0-9]+$/.test(base) ? base.replace(/\.[A-Za-z0-9]+$/, '.jpg') : `${base}.jpg`;
}

async function decodeBitmap(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  const g = globalThis as unknown as { createImageBitmap?: (b: Blob, o?: unknown) => Promise<ImageBitmap> };
  if (typeof g.createImageBitmap === 'function') {
    try {
      // 'from-image' = the decoder applies the EXIF/HEIF orientation, so the pixels come out upright.
      const bmp = await g.createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close?.() };
    } catch {
      /* fall back to <img> */
    }
  }
  if (typeof Image === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') throw new Error('no decoder');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode(); // an <img> applies image-orientation: from-image by default in current browsers
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Decode a HEIC/HEIF photo with the browser and re-encode it as a JPEG File named *.jpg. Throws when the browser cannot. */
export async function convertHeicToJpeg(file: File): Promise<File> {
  const bmp = await decodeBitmap(file);
  try {
    if (!(bmp.width > 0 && bmp.height > 0)) throw new Error('empty image');
    const scale = Math.min(1, HEIC_MAX_EDGE / Math.max(bmp.width, bmp.height));
    const width = Math.max(1, Math.round(bmp.width * scale));
    const height = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bmp.source, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', HEIC_JPEG_QUALITY));
    if (!blob || blob.size === 0 || (blob.type && blob.type !== 'image/jpeg')) throw new Error('encode failed');
    return new File([blob], jpgName(file.name || 'photo.heic'), { type: 'image/jpeg', lastModified: file.lastModified || Date.now() });
  } finally {
    bmp.close();
  }
}

/**
 * The one call every intake makes. A file that is not HEIC comes back untouched. A HEIC comes back as a renamed JPEG, or as
 * { ok: false, message } when this browser cannot decode it (the caller shows `message` and uploads nothing).
 */
export async function prepareImageForUpload(file: File): Promise<PrepareImageResult> {
  if (!(await isHeicFile(file))) return { ok: true, file, converted: false };
  try {
    return { ok: true, file: await convertHeicToJpeg(file), converted: true };
  } catch {
    return { ok: false, message: HEIC_CANNOT_CONVERT_MESSAGE };
  }
}
