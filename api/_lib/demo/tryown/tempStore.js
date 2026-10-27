/**
 * Temporary storage for the "Try your own documents" demo: the object store already used for uploads (Cloudflare R2), under a
 * prefix no tenant key can ever start with (tenant keys are "<tenant uuid>/..."; r2.js keyBelongsToTenant refuses anything else).
 *
 *   put    the browser PUTs the file straight to a one-use presigned URL (a Vercel function cannot take a 15 MB body),
 *          the URL signs the exact byte length, so a different size is refused by R2
 *   read   the server fetches the bytes into memory, reads them, and DELETES the object in a finally block
 *   sweep  anything under the prefix older than 10 minutes is deleted (an abandoned upload, a crashed read, a failed delete). It runs on EVERY upload
 *          request and every read (so with any traffic, nothing outlives ~10 minutes) and from the hourly cron entry, which is valid on every Vercel plan.
 *          On a plan that allows it the cron can be made every 5 minutes (one-line edit in vercel.json). An R2 lifecycle rule on the prefix
 *          (1 day, R2's minimum) is the last net. The normal path never waits for any of them: the object is deleted in the read's finally block.
 *
 * Nothing here logs a key or a size. Pure functions are exported for the tests; the R2 calls are behind createR2Store().
 */
import crypto from 'node:crypto';
import { presign, getObject, deleteObject } from '../../r2.js';

export const TEMP_PREFIX = 'demo-tmp/';
const KEY_RE = /^demo-tmp\/[a-f0-9]{32}$/;

export const newTempKey = () => `${TEMP_PREFIX}${crypto.randomBytes(16).toString('hex')}`;
export const isTempKey = (k) => typeof k === 'string' && KEY_RE.test(k);

/** Pure: pull {key, lastModified} out of an S3 ListObjectsV2 XML body. */
export function parseListXml(xml) {
  const out = [];
  const re = /<Contents>([\s\S]*?)<\/Contents>/g;
  let m;
  while ((m = re.exec(String(xml ?? '')))) {
    const key = /<Key>([^<]*)<\/Key>/.exec(m[1])?.[1];
    const lm = /<LastModified>([^<]*)<\/LastModified>/.exec(m[1])?.[1];
    const t = lm ? Date.parse(lm) : NaN;
    if (key) out.push({ key: key.replace(/&amp;/g, '&'), lastModified: Number.isFinite(t) ? t : 0 });
  }
  return out;
}
export const nextToken = (xml) => (/<IsTruncated>true<\/IsTruncated>/.test(xml) ? /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1] ?? null : null);

/** Pure: which listed objects are old enough to delete. An unreadable timestamp counts as old. */
export function expiredKeys(list, now, maxAgeMs) {
  return list.filter((o) => isTempKey(o.key) && (!o.lastModified || now - o.lastModified > maxAgeMs)).map((o) => o.key);
}

export function createR2Store() {
  return {
    newKey: newTempKey,
    putUrl(key, size, expiresSec) {
      if (!isTempKey(key)) throw new Error('bad temp key');
      return presign('PUT', key, expiresSec, {}, new Date(), { contentLength: size });
    },
    get(key, maxBytes) {
      if (!isTempKey(key)) throw new Error('bad temp key');
      return getObject(key, { maxBytes });
    },
    del(key) {
      if (!isTempKey(key)) throw new Error('bad temp key');
      return deleteObject(key);
    },
    async list() {
      const all = [];
      let token = null;
      for (let page = 0; page < 20; page++) {
        const extra = { 'list-type': '2', prefix: TEMP_PREFIX, ...(token ? { 'continuation-token': token } : {}) };
        const r = await fetch(presign('GET', '', 120, extra), { signal: AbortSignal.timeout(10_000) });
        if (!r.ok) { await r.body?.cancel().catch(() => {}); throw new Error(`list failed ${r.status}`); }
        const xml = await r.text();
        all.push(...parseListXml(xml));
        token = nextToken(xml);
        if (!token) break;
      }
      return all;
    },
  };
}

/** Delete every expired temporary object. Never throws; returns how many it removed. */
export async function sweepTemp(store, { now = Date.now(), maxAgeMs }) {
  let removed = 0;
  try {
    for (const key of expiredKeys(await store.list(), now, maxAgeMs)) {
      try { await store.del(key); removed++; } catch { /* the next sweep retries */ }
    }
  } catch { /* listing failed; the next sweep retries */ }
  return removed;
}
