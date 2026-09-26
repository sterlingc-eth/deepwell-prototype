/**
 * suggest/vocabExtras.js — Round 14 K1.
 *
 * A small, cached, tenant-scoped supplement to vocab/tenantVocab.js: service ADDRESSES, equipment SERIAL
 * NUMBERS and ZIP codes — three things the sample-prompt/typeahead templates (templates.js) need to fill
 * "Is <serial> still under warranty?" / "When were we last at <address>?" with THIS tenant's own real
 * data, none of which tenantVocab.js exposes today (it derives only CITIES from addresses, for its own
 * schema-linking purpose). This file is purely additive — vocab/tenantVocab.js is read from (its exported
 * `computeDataVersion`) and never edited, and every query here follows the exact same tenant-scoping
 * (TENANT_SQL), dedup and cache-by-data-version idiom that file already established, so a second glossary
 * never means a second set of tenant-isolation bugs to reason about.
 *
 * No model call anywhere in this file.
 */
import { TENANT_SQL } from "../scope.js";
import { computeDataVersion } from "../vocab/tenantVocab.js";
import { deriveGeo } from "../analytics.js";

const CACHE_TTL_MS = 10 * 60 * 1000; // same backstop as tenantVocab.js's own cache
const SCAN_LIMIT = 300; // typeahead/samples only ever need a handful of examples, never the whole corpus

// tenantKey -> {version, extras, expiresAt} — one cache per tenant, never shared across tenants.
const cacheByTenant = new Map();

async function distinctServiceAddresses(db, limit = SCAN_LIMIT) {
  const { rows } = await db.raw(
    `SELECT DISTINCT data->>'service_address' AS v FROM entities
      WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL} AND data->>'service_address' IS NOT NULL
      LIMIT ${Number(limit) || SCAN_LIMIT}`,
    []
  );
  return rows.map((r) => String(r.v ?? "").trim()).filter(Boolean);
}

async function distinctSerials(db, limit = SCAN_LIMIT) {
  const { rows } = await db.raw(
    `SELECT DISTINCT data->>'serial_number' AS v FROM entities
      WHERE entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT_SQL} AND data->>'serial_number' IS NOT NULL
      LIMIT ${Number(limit) || SCAN_LIMIT}`,
    []
  );
  return rows.map((r) => String(r.v ?? "").trim()).filter(Boolean);
}

/** Case-insensitive de-dup that keeps the first-seen casing — same helper tenantVocab.js's own dedupCi
 *  does, duplicated rather than imported so this file never needs a non-exported symbol from it. */
function dedupCi(values) {
  const seen = new Map();
  for (const v of values ?? []) {
    const key = String(v).toLowerCase();
    if (!seen.has(key)) seen.set(key, v);
  }
  return [...seen.values()];
}

/** Builds the full extras for the calling tenant, no caching — see getSuggestVocabExtras for the cached
 *  entry point every real caller should use. */
export async function buildSuggestVocabExtras(db) {
  const [addressesRaw, serialsRaw] = await Promise.all([distinctServiceAddresses(db), distinctSerials(db)]);
  const addresses = dedupCi(addressesRaw);
  const zips = dedupCi(addresses.map((a) => deriveGeo(a).zip).filter(Boolean));
  return { addresses, serials: dedupCi(serialsRaw), zips };
}

/** Cached, data-version-keyed (rebuilt only when this tenant's own rows actually changed, never a blind
 *  timer alone — same computeDataVersion tenantVocab.js's own cache already keys off of). */
export async function getSuggestVocabExtras(db, tenantKey) {
  const now = Date.now();
  const cached = cacheByTenant.get(tenantKey);
  let version = null;
  try {
    version = await computeDataVersion(db);
  } catch {
    version = null; // a probe failure never blocks the caller — fall back to whatever's cached (or rebuild)
  }
  if (cached && cached.expiresAt > now && (version === null || cached.version === version)) return cached.extras;
  const extras = await buildSuggestVocabExtras(db);
  cacheByTenant.set(tenantKey, { version, extras, expiresAt: now + CACHE_TTL_MS });
  return extras;
}

/** Test-only: drop every cached tenant extras glossary. */
export function resetSuggestVocabExtrasCacheForTests() {
  cacheByTenant.clear();
}
