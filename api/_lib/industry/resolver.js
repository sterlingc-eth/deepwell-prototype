/**
 * Pack resolver (slice 1A 2026-10-02; wired in Build 2 stage 2A, 2026-10-05).
 * 2A: `industry` now selects the capability layers when `packs` is absent (see
 * defaultPacksForIndustry), onboarding / the account route write both through
 * setTenantIndustry, and a failed lookup is never cached. A company with no
 * `industry` and no `packs` is still legacy HVAC, unchanged.
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
import { invalidateTenantIndustryCache, getPack, listPacks } from './index.js';

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

/** The four industries a company can pick (ids match industry/index.js PACK_IDS). */
export const INDUSTRY_IDS = Object.freeze(['hvac', 'electrical', 'plumbing', 'property']);
const INDUSTRY_PACKS = Object.freeze({
  hvac: LEGACY_PACKS,
  electrical: Object.freeze(['equipment', 'electrical']),
  plumbing: Object.freeze(['equipment', 'plumbing']),
  property: Object.freeze(['property']),
});

/** Pure: the capability layers an industry switches on when `packs` was never
 *  written. Unknown / missing industry -> legacy (hvac), the historical default. */
export function defaultPacksForIndustry(industry) {
  const key = typeof industry === 'string' ? industry.trim().toLowerCase() : '';
  return [...(INDUSTRY_PACKS[key] ?? LEGACY_PACKS)];
}

export function packsEnabled(env = process.env) {
  const v = String(env?.DEEPWELL_PACKS_ENABLED ?? '').trim().toLowerCase();
  return !(v === 'false' || v === '0' || v === 'off' || v === 'no');
}

/** Pure: raw settings.packs value -> canonical pack id list (known ids only,
 *  requirements auto-included, KNOWN_PACKS order). undefined/null/malformed ->
 *  legacy copy; [] -> []. */
export function normalizePacks(raw, industry) {
  if (!Array.isArray(raw)) return defaultPacksForIndustry(industry);
  const want = new Set();
  const add = (id) => {
    if (typeof id !== 'string' || !Object.hasOwn(PACK_MANIFESTS, id) || want.has(id)) return;
    want.add(id);
    PACK_MANIFESTS[id].requires.forEach(add);
  };
  raw.forEach((id) => add(typeof id === 'string' ? id.trim().toLowerCase() : id));
  if (raw.length > 0 && want.size === 0) return defaultPacksForIndustry(industry); // all unknown: fail safe
  return KNOWN_PACKS.filter((id) => want.has(id));
}

/** Pure: from a settings object (or null) to pack ids, honouring kill switch. */
export function packsFromSettings(settings, env = process.env) {
  if (!packsEnabled(env)) return [...LEGACY_PACKS];
  const s = settings && typeof settings === 'object' ? settings : null;
  return normalizePacks(s ? s.packs : undefined, s ? s.industry : undefined);
}

/** Pure: 'general' when nothing is on. */
export function isGeneral(packIds) { return !packIds || packIds.length === 0; }

/** Pure: sorted unique feature list for a pack id list. */
export function featuresFor(packIds) {
  const out = new Set();
  for (const id of packIds || []) (Object.hasOwn(PACK_MANIFESTS, id) ? PACK_MANIFESTS[id].features : []).forEach((f) => out.add(f));
  return [...out].sort();
}

/** Pure: does this pack id list switch the feature on? */
export function hasFeature(packIds, feature) {
  return featuresFor(packIds).includes(feature);
}

/* ------------------------------------------------------------ tenant lookup + cache */
// 60 s (was 10 min): a change made on another serverless instance is seen within a minute.
const TTL_MS = 60 * 1000;
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
    for (const [k, v] of cache) if (v.tenantId === id) cache.delete(k);
    invalidateTenantIndustryCache(id);
  }
}

const looksLikeDb = (x) => Boolean(x) && (typeof x.raw === 'function' || typeof x.query === 'function');

async function queryPacks(db) {
  const run = typeof db.raw === 'function' ? db.raw.bind(db) : db.query.bind(db);
  const { rows } = await run(
    "SELECT settings->'packs' AS packs, settings->>'industry' AS industry FROM tenants WHERE id = (current_setting('app.tenant_id', true))::uuid",
    []
  );
  return { packs: rows?.[0]?.packs, industry: rows?.[0]?.industry, tenantId: db.tenantId ?? null };
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
  const packs = normalizePacks(raw?.packs, raw?.industry);
  if (key && !failed) cache.set(key, { packs, tenantId: raw?.tenantId ?? null, expiresAt: Date.now() + TTL_MS });
  return [...packs];
}

/** Convenience: tenant -> feature list. */
export async function tenantFeatures(dbOrCtx) { return featuresFor(await packsForTenant(dbOrCtx)); }

/**
 * Set a company's industry (2A). Writes settings.industry (wording / content
 * pack) and settings.packs (capability layers) together so the two can never
 * disagree, records it in the audit log, and drops both caches so the change is
 * seen at once on this instance. `db` is a tenant-scoped store (withTenant).
 * Never writes any other tenant: the UPDATE is keyed on db.tenantId.
 */
export async function setTenantIndustry(db, industry, { clerkUserId = null, tenantKey = null, ifUnset = false } = {}) {
  const id = typeof industry === 'string' ? industry.trim().toLowerCase() : '';
  if (!INDUSTRY_IDS.includes(id)) {
    const err = new Error(`industry must be one of: ${INDUSTRY_IDS.join(', ')}`);
    err.status = 400;
    throw err;
  }
  const packs = defaultPacksForIndustry(id);
  const cur = (await db.raw(`SELECT settings->>'industry' AS industry FROM tenants WHERE id = $1`, [db.tenantId])).rows[0];
  if (!cur) { const err = new Error('company not found'); err.status = 404; throw err; }
  // ifUnset: onboarding's pending pick never overwrites an industry that was already chosen.
  if (ifUnset && cur.industry) return { industry: String(cur.industry), packs: defaultPacksForIndustry(cur.industry), applied: false };
  const changed = (cur.industry ?? 'hvac') !== id;
  await db.raw(
    `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('industry', $2::text, 'packs', $3::jsonb) WHERE id = $1`,
    [db.tenantId, id, JSON.stringify(packs)]
  );
  try {
    await db.logAction?.({ clerk_user_id: clerkUserId, action: 'industry.set', resource_type: 'tenant', resource_id: db.tenantId, changes: { industry: id, packs } });
  } catch { /* audit is best-effort; the setting itself is saved */ }
  invalidatePacksCache({ tenantId: db.tenantId, tenantKey: tenantKey ?? db.tenantKey });
  // Cached answers were worded for the old industry: drop this company's (only) so none is served after a change.
  if (changed) {
    for (const table of ['ask_answer_cache', 'ask_semantic_cache']) {
      try {
        await db.raw('SAVEPOINT industry_cache_drop', []);
        await db.raw(`DELETE FROM ${table} WHERE tenant_id = $1`, [db.tenantId]);
        await db.raw('RELEASE SAVEPOINT industry_cache_drop', []);
      } catch { try { await db.raw('ROLLBACK TO SAVEPOINT industry_cache_drop', []); } catch { /* */ } }
    }
  }
  return { industry: id, packs, applied: true };
}

/** Pure: what the client needs to know about a company's industry, from its settings JSON (or null).
 *  Missing industry = hvac + legacy packs. Used by the bootstrap payload and the industry route. */
export function industrySummaryFromSettings(settings, env = process.env) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const pack = getPack(s.industry);
  const packs = packsFromSettings(s, env);
  return { industry: pack.id, label: pack.label, unitNoun: pack.unitNoun, packs, features: featuresFor(packs), chosen: typeof s.industry === 'string' && s.industry.trim() !== '' };
}

/** The industries a company can pick, for the picker. */
export function industryChoices() {
  return listPacks().map((p) => ({ id: p.id, label: p.label, unitNoun: p.unitNoun }));
}
