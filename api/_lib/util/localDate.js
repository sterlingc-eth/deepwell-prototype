/**
 * "Today" for a shop is the shop's local date, not the server's UTC date (R30 M10). A Mesa, AZ shop (UTC-7, no DST)
 * asking a warranty question after 5 pm local time got TOMORROW's date, so registration / warranty windows and
 * "expires in N days" were off by one every evening.
 *
 * There is no per-tenant timezone setting in the schema. Resolution order for server-side work:
 *   1. tenants.settings.timezone, if a valid IANA zone is ever set (nothing writes it yet - reserved);
 *   2. TENANT_DEFAULT_TZ (env), if it is a valid IANA zone;
 *   3. 'America/Phoenix' - the founding customers' zone.
 * The browser always knows its own local date (localYmd() in src/lib/localDate.ts) and sends it with questions;
 * the server validates it (isPlausibleToday) and only falls back to these when it is missing/invalid.
 */

import { isPlausibleToday } from "../warrantyRules.js";

export const FALLBACK_TZ = "America/Phoenix";

/** @param {unknown} tz */
export function isValidTimeZone(tz) {
  if (typeof tz !== "string" || !tz.trim() || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {{settings?: {timezone?: unknown}|null}|null} [tenant]
 * @param {Record<string,string|undefined>} [env]
 */
export function tenantTimeZone(tenant, env = process.env) {
  const own = tenant?.settings?.timezone;
  if (isValidTimeZone(own)) return own;
  if (isValidTimeZone(env?.TENANT_DEFAULT_TZ)) return env.TENANT_DEFAULT_TZ;
  return FALLBACK_TZ;
}

/**
 * The calendar date (YYYY-MM-DD) of instant `now` in zone `tz`.
 * @param {Date|number} [now]
 * @param {string} [tz]
 */
export function localYmdIn(now = new Date(), tz = FALLBACK_TZ) {
  const d = now instanceof Date ? now : new Date(now);
  const zone = isValidTimeZone(tz) ? tz : FALLBACK_TZ;
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** Today's date for a tenant (server-side default when the caller sent none). */
export function tenantToday(tenant, now = new Date(), env = process.env) {
  return localYmdIn(now, tenantTimeZone(tenant, env));
}

/**
 * R30 M9: a client-supplied `today` is used only if it is a strict, real, plausible YYYY-MM-DD (the same
 * isPlausibleToday the warranty routes use); anything else - garbage, an array, padded whitespace, year 9999 - is
 * ignored in favour of the tenant's local date. Stops arbitrary strings reaching cache keys, date math and prompts.
 * @param {unknown} raw
 */
export function resolveToday(raw, tenant = null, now = new Date(), env = process.env) {
  if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw) && isPlausibleToday(raw)) return raw;
  return tenantToday(tenant, now, env);
}
