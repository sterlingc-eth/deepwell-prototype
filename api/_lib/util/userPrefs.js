/**
 * Per-person screen preferences (which "Needs attention" rows a person hid, which alert groups they collapsed).
 * Stored in tenants.settings.uiPrefs, a jsonb object keyed by Clerk user id, next to the per-person digestMuted
 * list (no new table, no new endpoint: it rides GET/POST /api/account?action=notifications). A person can only
 * read and write their OWN entry. Everything is validated down to a tiny closed shape so the blob stays small.
 */

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ENTRIES = 30;

/** @param {unknown} v @returns {Record<string, {mode: 'dismiss'|'snooze', count: number, until?: string}>} */
function cleanNeedsAttention(v) {
  const out = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [id, e] of Object.entries(v).slice(0, MAX_ENTRIES)) {
    if (!/^[a-z0-9-]{1,64}$/.test(id) || !e || typeof e !== 'object') continue;
    const mode = e.mode === 'snooze' ? 'snooze' : e.mode === 'dismiss' ? 'dismiss' : null;
    const count = Number.isInteger(e.count) && e.count >= 0 && e.count < 1e7 ? e.count : null;
    if (!mode || count == null) continue;
    if (mode === 'snooze') {
      if (typeof e.until !== 'string' || !YMD.test(e.until)) continue;
      out[id] = { mode, count, until: e.until };
    } else out[id] = { mode, count };
  }
  return out;
}

/** @param {unknown} v @returns {{collapsed: Record<string, boolean>, filter: 'all'|'unread'|'week'}} */
function cleanAlerts(v) {
  const collapsed = {};
  const src = v && typeof v === 'object' ? v : {};
  if (src.collapsed && typeof src.collapsed === 'object' && !Array.isArray(src.collapsed)) {
    for (const [k, b] of Object.entries(src.collapsed).slice(0, MAX_ENTRIES)) {
      if (/^[a-z0-9_.-]{1,40}$/i.test(k) && typeof b === 'boolean') collapsed[k] = b;
    }
  }
  const filter = src.filter === 'unread' || src.filter === 'week' ? src.filter : 'all';
  return { collapsed, filter };
}

/**
 * Keeps only the known keys, each cleaned. Returns null when nothing valid was supplied.
 * @param {unknown} input
 */
export function sanitizeUiPrefs(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  if ('needsAttention' in input) out.needsAttention = cleanNeedsAttention(input.needsAttention);
  if ('alerts' in input) out.alerts = cleanAlerts(input.alerts);
  return Object.keys(out).length ? out : null;
}

/** @param {{uiPrefs?: unknown}|null|undefined} settings @param {string|null|undefined} userId */
export function userUiPrefs(settings, userId) {
  const all = settings?.uiPrefs;
  if (!userId || !all || typeof all !== 'object') return {};
  return sanitizeUiPrefs(all[userId]) ?? {};
}
