/**
 * Signed tickets for the "Try your own documents" demo. Nothing is stored server-side, so two small signed blobs carry the state:
 *
 *   ticket    issued with the upload links: which temporary objects this visitor may have read (and how big each should be),
 *             for which browser session, until when, once. A visitor cannot make the server read any other key.
 *   context   issued with the results: the MASKED text of the visitor's own documents, sent back by the browser with each
 *             question. Signed so the question model can only ever be shown text this server produced; it is not a general
 *             "send any text to the model" door.
 *
 * HMAC-SHA256 with DEMO_TRYOWN_SECRET. Pure aside from the clock.
 */
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');

function sig(secret, kind, body) {
  return crypto.createHmac('sha256', secret).update(`${kind}.${body}`).digest('base64url');
}

export function sign(secret, kind, payload) {
  if (!secret) throw new Error('demo secret missing');
  const body = b64u(zlib.deflateSync(Buffer.from(JSON.stringify(payload), 'utf8')));
  return `${body}.${sig(secret, kind, body)}`;
}

/** @returns {object|null} the payload, or null for anything forged, truncated, expired or of another kind */
export function verify(secret, kind, token, now = Date.now()) {
  try {
    if (!secret || typeof token !== 'string' || token.length > 120_000) return null;
    const dot = token.lastIndexOf('.');
    if (dot < 1) return null;
    const body = token.slice(0, dot);
    const given = Buffer.from(token.slice(dot + 1));
    const want = Buffer.from(sig(secret, kind, body));
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
    const payload = JSON.parse(zlib.inflateSync(fromB64u(body), { maxOutputLength: 400_000 }).toString('utf8'));
    if (!payload || typeof payload !== 'object') return null;
    if (Number.isFinite(payload.exp) && now > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export const newId = (bytes = 16) => crypto.randomBytes(bytes).toString('hex');
