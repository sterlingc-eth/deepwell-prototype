/**
 * Per-person "Mute my daily digest" (R30). Stored in tenants.settings.digestMuted, a jsonb array of Clerk
 * user ids, next to the shop-wide emailDigest switch (no new table). Shared by the notifications route
 * (read/write the caller's own entry) and notify.js (skip muted admins when sending).
 */

/** Max muted user ids kept per shop (the roster read in notify.js is capped at 100 anyway). */
export const MAX_DIGEST_MUTED = 100;

/** @param {{digestMuted?: unknown}|null|undefined} settings @returns {string[]} */
export function mutedDigestUserIds(settings) {
  const v = settings?.digestMuted;
  return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x) : [];
}
