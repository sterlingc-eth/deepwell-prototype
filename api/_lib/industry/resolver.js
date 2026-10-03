/**
 * Pack resolver, slice 1A (2026-10-02). NOTHING calls this yet: no screen,
 * prompt, extractor, alert, card or Donovan recipe is gated by it, so no
 * company sees any change.
 *
 * Two orthogonal settings live in tenants.settings (JSONB, no DDL):
 *   - `industry`  (existing, Round 4): which content pack (vocabulary, doc
 *                 types, exam templates) the AI layer reads. See ./index.js.
 *     Source of truth for WORDING stays `industry`; `packs` only decides which
 *                 capabilities exist. They are independent on purpose.
 *   - `packs`     (new): which capability layers are switched on:
 *                 'equipment' (base module) and industry layers on top of it.
 *
 * Missing `packs` key  -> LEGACY default ['equipment','hvac'] (every existing
 *                         company unchanged; rollback = code only).
 * `packs: []`          -> `general` = foundation only.
 * Kill switch          -> env DEEPWELL_PACKS_ENABLED=false|0|off|no forces the
 *                         legacy default for everyone, read on every call.
 * Malformed value (not an array, or only unknown ids) fails SAFE to legacy.
 */
import { invalidateTenantIndustryCache } from './index.js';

export const LEGACY_PACKS = Object.freeze(['equipment', 'hvac']);
export const GENERAL = 'general';

/** Manifest = identity + requires + feature flags it switches on. Features are
 *  declared here only; nothing consumes them until the gating slices. */
export const PACK_MANIFESTS = Object.freeze({
  equipment: { id: 'equipment', label: 'Equipment', requires: [],
    features: ['equipment_screens', 'nameplate_capture', 'warranty_alerts', 'outreach_drafts', 'claim_packet', 'unit_linking', 'equipment_recipes'] },
  hvac: { id: 'hvac', label: 'HVAC', requires: ['equipment'], features: ['hvac_wording', 'hvac_recipes'] },
  plumbing: { id: 'plumbing', label: 'Plumbing', requires: ['equipment'], features: ['plumbing_wording'] },
  electrical: { id: 'electrical', label: 'Electrical', requires: ['equipment'], features: ['electrical_wording'] },
  property: { id: 'property', label: 'Property management', requires: [], features: ['property_wording'] },
});
export const KNOWN_PACKS = Object.freeze(Object.keys(PACK_MANIFESTS));

export function packsEnabled(env = process.env) {
  const v = String(env?.DEEPWELL_PACKS_ENABLED ?? '').trim().toLowerCase();
  return !(v === 'false' || v === '0' || v === 'off' || v === 'no');
}

/** Pure: raw settings.packs value -> canonical pack id list (known ids only,
 *  requirements auto-included, KNOWN_PACKS order). undefined/null/malformed ->
 *  legacy copy; [] -> []. */
export function normalizePacks(raw) {
  if (!Array.isArray(raw)) return [...LEGACY_PACKS];
  const want = new Set();
  const add = (id) => {
    if (!PACK_MANIFESTS[id] || want.has(id)) return;
    want.add(id);
    PACK_MANIFESTS[id].requires.forEach(add);
  };
  raw.forEach((id) => add(typeof id === 'string' ? id.trim().toLowerCase() : id));
  if (raw.length > 0 && want.size === 0) return [...LEGACY_PACKS]; // all unknown: fail safe
  return KNOWN_PACKS.filter((id) => want.has(id));
}

/** Pure: from a settings object (or null) to pack ids, honouring kill switch. */
export function packsFromSettings(settings, env = process.env) {
  if (!packsEnabled(env)) return [...LEGACY_PACKS];
  return normalizePacks(settings && typeof settings === 'object' ? settings.packs : undefined);
}

/** Pure: 'general' when nothing is on. */
export function isGeneral(packIds) { return !packIds || packIds.length === 0; }

/** Pure: sorted unique feature list for a pack id list. */
export function featuresFor(packIds) {
  const out = new Set();
  for (const id of packIds || []) (PACK_MANIFESTS[id]?.features || []).forEach((f) => out.add(f));
  return [...out].sort();
}

/** Pure: does this pack id list switch the feature on? */
export function hasFeature(packIds, feature) {
  return featuresFor(packIds).includes(feature);
}

/* ------------------------------------------------------------ tenant lookup + cache */
const TTL_MS = 10 * 60 * 1000;
const cache = new Map();

export function resetPacksCacheForTests() { cache.clear(); }

/** Call after any write to tenants.settings so the change shows at once. Also
 *  clears the Round 4 industry cache for the same tenant. */
export function invalidatePacksCache(who) {
  // Accepts a tenant UUID, a tenantKey, or {tenantId, tenantKey}: the two call
  // shapes key their caches differently (db:<uuid> vs ctx:<tenantKey>).
  if (who == null) return;
  const ids = typeof who === 'object' ? [who.tenantId, who.tenantKey] : [who];
  for (const id of ids) {
    if (id == null) continue;
    cache.delete(`db:${id}`);
    cache.delete(`ctx:${id}`);
    invalidateTenantIndustryCache(id);
  }
}

const looksLikeDb = (x) => Boolean(x) && (typeof x.raw === 'function' || typeof x.query === 'function');

async function queryPacks(db) {
  const run = typeof db.raw === 'function' ? db.raw.bind(db) : db.query.bind(db);
  const { rows } = await run(
    "SELECT settings->'packs' AS packs FROM tenants WHERE id = (current_setting('app.tenant_id', true))::uuid",
    []
  );
  return rows?.[0]?.packs;
}

/**
 * Resolve the CALLING tenant's enabled pack ids. Same inputs as
 * packForTenant (a tenant-scoped db handle, or {withTenant, ctxArg}). Never
 * throws: any failure degrades to legacy. The kill switch short-circuits
 * before any query or cache read.
 */
export async function packsForTenant(dbOrCtx) {
  if (!packsEnabled()) return [...LEGACY_PACKS];
  let key = null; let run;
  if (looksLikeDb(dbOrCtx)) {
    key = dbOrCtx.tenantId ? `db:${dbOrCtx.tenantId}` : null;
    run = () => queryPacks(dbOrCtx);
  } else {
    const ctx = dbOrCtx?.ctxArg ?? dbOrCtx;
    const withTenant = dbOrCtx?.withTenant;
    key = ctx?.tenantKey ? `ctx:${ctx.tenantKey}` : null;
    if (typeof withTenant !== 'function' || !ctx) return [...LEGACY_PACKS];
    run = () => withTenant(ctx, (db) => queryPacks(db));
  }
  if (key) { const hit = cache.get(key); if (hit && hit.expiresAt > Date.now()) return [...hit.packs]; }
  let raw; let failed = false;
  try { raw = await run(); } catch { raw = undefined; failed = true; }
  const packs = normalizePacks(raw);
  if (key && !failed) cache.set(key, { packs, expiresAt: Date.now() + TTL_MS });
  return [...packs];
}

/** Convenience: tenant -> feature list. */
export async function tenantFeatures(dbOrCtx) { return featuresFor(await packsForTenant(dbOrCtx)); }
