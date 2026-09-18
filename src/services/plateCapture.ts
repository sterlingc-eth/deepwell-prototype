import { authHeader } from './authToken';

/**
 * Read an equipment nameplate from a photo.
 *
 * This is the one step of the product that maps directly onto what a technician
 * actually does: stand in front of a unit, point a phone at the label, and get
 * the serial without typing it. Until now the capture was simulated — it picked
 * a random serial out of whatever was already on file, which is worse than
 * useless in the field because it returns a confident, wrong answer.
 *
 * The server side already existed and was never called: POST /api/extract with
 * `imageData` runs the real vision model over one photo and stores nothing.
 * That matters for a photo taken inside someone's home — nothing is persisted
 * unless the technician decides to keep it.
 */

export interface PlateFields {
  serial_number?: string;
  model?: string;
  manufacturer?: string;
  equipment_type?: string;
  installation_date?: string;
}

export interface PlateRead {
  fields: PlateFields;
  /** Per-field confidence, 0–1, straight from the extractor. */
  confidence: Record<string, number>;
  /** The exact substring the model says it read, for showing next to a value. */
  verbatim: Record<string, string>;
}

/** What the vision API will accept. Anything else has to be converted first. */
const SUPPORTED = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** The longest edge we send. A nameplate needs legible characters, not megapixels. */
const MAX_EDGE = 1600;

/** The route caps at 8MB of base64-decoded bytes; stay well under it. */
const JPEG_QUALITY = 0.85;

/**
 * True when the bytes are HEIC/HEIF, whatever the file claims to be.
 *
 * An iPhone set to "High Efficiency" hands HEIC to a file input in some iOS
 * versions and JPEG in others, and the `type` property is not reliable either
 * way. The server sniffs the same signature and refuses HEIC with a message
 * telling the technician to go and change a camera setting — which is a
 * terrible thing to read while standing on a roof. Detecting it here means we
 * can convert instead of refusing.
 */
async function isHeic(file: File): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (head.length < 12) return false;
  const brand = String.fromCharCode(...head.subarray(4, 12));
  return brand.startsWith('ftyp') && /heic|heix|heim|heis|hevc|hevx|mif1|msf1/.test(brand.slice(4));
}

/**
 * Normalize a captured photo into a JPEG the API will accept.
 *
 * Does three things at once, all of which matter in the field:
 * bakes EXIF rotation into the pixels (a sideways nameplate reads badly),
 * downscales (a 12MP photo over one bar of signal is a minute of waiting),
 * and re-encodes as JPEG (which quietly solves HEIC, since the decoder either
 * handled it or we never got here).
 */
async function toJpeg(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not process the photo on this device.');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY)
  );
  if (!blob) throw new Error('Could not process the photo on this device.');
  return blob;
}

async function toBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  // Chunked, because String.fromCharCode(...millions) overflows the stack.
  for (let i = 0; i < buf.length; i += 0x8000) {
    binary += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * Photo in, fields out. Throws with a message meant to be read by someone
 * holding a phone, not by a developer reading a log.
 */
export async function readPlate(file: File): Promise<PlateRead> {
  if (await isHeic(file)) {
    // createImageBitmap decodes HEIC on iOS (where the photos come from) and
    // not on most desktops. Attempting it is right: on the device that produces
    // HEIC, it works.
    try {
      await createImageBitmap(file);
    } catch {
      throw new Error(
        "This photo is in a format we can't read. Take the photo again from inside DeepWell, or send it as a JPEG."
      );
    }
  }

  let jpeg: Blob;
  try {
    jpeg = await toJpeg(file);
  } catch {
    throw new Error("Couldn't read that photo. Try taking it again.");
  }

  if (!SUPPORTED.has(jpeg.type)) throw new Error("Couldn't read that photo. Try taking it again.");

  const res = await fetch('/api/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({
      imageData: await toBase64(jpeg),
      mediaType: 'image/jpeg',
      documentType: 'photograph of an equipment nameplate',
    }),
  });

  if (!res.ok) {
    // Vercel returns HTML on a platform error, so parse defensively — the same
    // guard the ingest and records clients use.
    const raw = await res.text().catch(() => '');
    let message = "Couldn't read the plate. Try again in a moment.";
    try {
      const parsed = JSON.parse(raw) as { error?: string };
      if (parsed?.error) message = parsed.error;
    } catch {
      /* not JSON — keep the friendly default rather than showing a status line */
    }
    throw new Error(message);
  }

  const body = (await res.json()) as {
    fields?: { field_key: string; value: string; confidence?: number; verbatim?: string }[];
  };

  const fields: PlateFields = {};
  const confidence: Record<string, number> = {};
  const verbatim: Record<string, string> = {};
  for (const f of body.fields ?? []) {
    if (!f?.field_key) continue;
    (fields as Record<string, string>)[f.field_key] = f.value;
    if (typeof f.confidence === 'number') confidence[f.field_key] = f.confidence;
    if (typeof f.verbatim === 'string') verbatim[f.field_key] = f.verbatim;
  }

  return { fields, confidence, verbatim };
}

/** Below this, show the value as needing a second look rather than as read. */
export const LOW_CONFIDENCE = 0.6;
