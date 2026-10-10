// npm run verify:dashboard-alerts
// Dashboard "Needs attention" hide/snooze rules, the alerts grouping + filter, the per-person prefs validator,
// the "Read amounts now" result summary, and the removal of the Records Graph tab. No browser, no network, no database.
import { readFileSync, existsSync } from 'node:fs';
import { hide, isHidden, restore, snoozeUntil, splitHidden, ymd } from '../src/components/insights/attentionPrefs.ts';
import { ALERT_FILTERS, groupAlerts, kindLabel, matchesFilter } from '../src/services/alertGroups.ts';
import { summarizeBackfill, type BackfillResult } from '../src/services/financialsClient.ts';
import type { NotificationItem } from '../src/services/notifyClient.ts';
// @ts-expect-error plain JS module without types
import { sanitizeUiPrefs, userUiPrefs } from '../api/_lib/util/userPrefs.js';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`); }
}
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

console.log('verify:dashboard-alerts');

/* ---------- Needs attention: dismiss / snooze / restore ---------- */
{
  const now = new Date(2026, 9, 10); // 10 Oct 2026, local
  const today = ymd(now);
  eq('ymd formats a local date', today, '2026-10-10');
  eq('snooze 7 days lands on the 17th', snoozeUntil(now), '2026-10-17');
  eq('snooze rolls over a month end', snoozeUntil(new Date(2026, 9, 28)), '2026-11-04');
  let m = hide({}, 'callbacks-30d', 'dismiss', 4, now);
  check('dismiss hides the row at the same count', isHidden(m['callbacks-30d'], 4, today));
  check('dismiss shows the row again when the count changes (up)', !isHidden(m['callbacks-30d'], 5, today));
  check('dismiss shows the row again when the count changes (down)', !isHidden(m['callbacks-30d'], 3, today));
  m = hide(m, 'warranty-expiring-60', 'snooze', 12, now);
  check('snooze hides until the date, even if the count changes', isHidden(m['warranty-expiring-60'], 99, '2026-10-16'));
  check('snooze ends on the date itself', !isHidden(m['warranty-expiring-60'], 12, '2026-10-17'));
  check('a row with no entry is never hidden', !isHidden(undefined, 1, today));
  const items = [{ id: 'callbacks-30d', count: 4 }, { id: 'warranty-expiring-60', count: 12 }, { id: 'data-gaps-units', count: 2 }];
  const sp = splitHidden(items, m, today);
  eq('split: two hidden, one visible', [sp.visible.map((i) => i.id), sp.hidden.map((i) => i.id)], [['data-gaps-units'], ['callbacks-30d', 'warranty-expiring-60']]);
  const back = restore(m, 'callbacks-30d');
  check('restore brings a row back and leaves the other hidden', !('callbacks-30d' in back) && 'warranty-expiring-60' in back);
  check('hide/restore never mutate the old map', Object.keys(m).length === 2);
}

/* ---------- Alerts: grouping, filter, labels ---------- */
{
  const now = Date.UTC(2026, 9, 10, 12);
  const ago = (days: number) => new Date(now - days * 86400000).toISOString();
  const mk = (id: string, kind: string, days: number, read: boolean): NotificationItem => ({ id, kind, title: id, body: null, link: null, createdAt: ago(days), readAt: read ? ago(days) : null });
  const items = [mk('a', 'warranty', 1, false), mk('b', 'warranty', 20, true), mk('c', 'outreach', 2, false), mk('d', 'followup', 9, false), mk('e', 'custom_thing', 3, true)];
  eq('filters offered: All / Unread / This week', ALERT_FILTERS.map((f) => f.label), ['All', 'Unread', 'This week']);
  const all = groupAlerts(items, 'all', now);
  eq('All hides read items until "earlier" is on (existing behaviour)', all.flatMap((g) => g.items.map((i) => i.id)).sort(), ['a', 'c', 'd']);
  eq('All + earlier shows every item', groupAlerts(items, 'all', now, true).flatMap((g) => g.items.map((i) => i.id)).sort(), ['a', 'b', 'c', 'd', 'e']);
  eq('Unread shows only unread', groupAlerts(items, 'unread', now).flatMap((g) => g.items.map((i) => i.id)).sort(), ['a', 'c', 'd']);
  eq('This week keeps read items from the last 7 days', groupAlerts(items, 'week', now).flatMap((g) => g.items.map((i) => i.id)).sort(), ['a', 'c', 'e']);
  const g = groupAlerts(items, 'all', now, true);
  eq('one group per kind, with counts', g.map((x) => [x.kind, x.items.length, x.unread]).sort(), [['custom_thing', 1, 0], ['followup', 1, 1], ['outreach', 1, 1], ['warranty', 2, 1]]);
  eq('groups with unread items come first', g[g.length - 1].kind, 'custom_thing');
  eq('labels', [kindLabel('warranty'), kindLabel('followup'), kindLabel('custom_thing'), kindLabel('')], ['Warranties', 'Follow-ups', 'Custom thing', 'Other']);
  check('matchesFilter: unread', matchesFilter(items[0], 'unread', now) && !matchesFilter(items[1], 'unread', now));
}

/* ---------- Per-person prefs validator (server) ---------- */
{
  const ok = sanitizeUiPrefs({ needsAttention: { 'callbacks-30d': { mode: 'dismiss', count: 3 }, 'x y': { mode: 'dismiss', count: 1 }, bad: { mode: 'snooze', count: 1 }, 'good-snooze': { mode: 'snooze', count: 2, until: '2026-10-17' } }, alerts: { collapsed: { warranty: true, 'bad key!': true, outreach: 'yes' }, filter: 'week' }, evil: 1 });
  eq('needsAttention keeps only well-formed entries', Object.keys(ok.needsAttention).sort(), ['callbacks-30d', 'good-snooze']);
  eq('alerts keeps only boolean collapsed flags on safe keys, and a known filter', ok.alerts, { collapsed: { warranty: true }, filter: 'week' });
  check('unknown top-level keys are dropped', !('evil' in ok));
  eq('an unknown filter falls back to all', sanitizeUiPrefs({ alerts: { filter: 'zzz' } }).alerts.filter, 'all');
  eq('junk input is rejected', [sanitizeUiPrefs(null), sanitizeUiPrefs('x'), sanitizeUiPrefs({}), sanitizeUiPrefs([])], [null, null, null, null]);
  const settings = { uiPrefs: { u1: { alerts: { collapsed: { warranty: true }, filter: 'unread' } }, u2: { alerts: { collapsed: {}, filter: 'week' } } } };
  eq('a person reads only their own prefs', userUiPrefs(settings, 'u1').alerts.filter, 'unread');
  eq('no user id, no prefs', userUiPrefs(settings, null), {});
  eq('unknown person, no prefs', userUiPrefs(settings, 'u3'), {});
  const route = src('api/_lib/routes/notifications.js');
  check('the notifications route writes only the caller\'s own entry', /jsonb_build_object\(\$2::text/.test(route) && /auth\.userId/.test(route));
}

/* ---------- "Read amounts now" result ---------- */
{
  const r = (written: number, added: BackfillResult['added']): BackfillResult => ({ enabled: true, processed: written, written, skipped: 0, failed: 0, remaining: 0, stoppedReason: 'done', added });
  const s = summarizeBackfill([
    r(2, [{ documentId: 'd1', filename: 'inv-1.pdf', docKind: 'invoice', invoiceNumber: '1', total: '1240.50', currency: 'USD' }, { documentId: 'd2', filename: 'inv-2.pdf', docKind: 'invoice', invoiceNumber: null, total: '0.10', currency: 'USD' }]),
    r(2, [{ documentId: 'd3', filename: 'agreement.pdf', docKind: 'agreement', invoiceNumber: null, total: null, currency: 'USD' }, { documentId: 'd4', filename: 'euro.pdf', docKind: 'invoice', invoiceNumber: null, total: '500.00', currency: 'EUR' }]),
  ]);
  eq('documents read, amounts added, total in cents (USD only, no float drift)', [s.documentsRead, s.amountsAdded, s.totalCents], [4, 3, 124060]);
  eq('every document is listed', s.items.map((i) => i.documentId), ['d1', 'd2', 'd3', 'd4']);
  eq('an older server (no added list) still reports the count', summarizeBackfill([r(3, undefined)]).documentsRead, 3);
  const card = src('src/components/FinancialsCard.tsx');
  check('the card shows the result and links each document', /backfill-result/.test(card) && /openDocument\(it\.documentId\)/.test(card) && /Read amounts now/.test(card));
}

/* ---------- Records: no Graph tab ---------- */
{
  const browse = src('src/screens/BrowseScreen.tsx');
  check('BrowseScreen has no Graph tab, icon or KnowledgeGraph import', !/'graph'/.test(browse.replace(/including a saved 'graph'[^*]*/, '')) && !/Network/.test(browse) && !/KnowledgeGraph/.test(browse));
  check('a saved "graph" tab falls back to documents', /RECORDS_TABS as string\[\]\)\.includes\(v\)/.test(browse) && !/RECORDS_TABS: RecordsTab\[\] = \[[^\]]*graph/.test(browse));
  const kg = src('src/components/KnowledgeGraph.tsx');
  check('KnowledgeGraph lost its Records-only search box (showSearch is gone)', !/showSearch/.test(kg) && !/graph-search-input/.test(kg));
  check('shared graph code stays: customer profile and unit page still use it', /KnowledgeGraph/.test(src('src/screens/CustomerProfileScreen.tsx')) && /KnowledgeGraph/.test(src('src/screens/EntityScreen.tsx')));
  check('shared graph helpers stay (entityGraph, graphClient, graphNodeId)', existsSync(new URL('../src/core/entityGraph.ts', import.meta.url)) && existsSync(new URL('../src/services/graphClient.ts', import.meta.url)) && existsSync(new URL('../src/core/graphNodeId.ts', import.meta.url)));
  const nav = src('src/components/nav.ts');
  check('no navigation entry points at a Graph screen', !/screen: 'graph'/.test(nav));
  check('help text no longer sends people to Records -> Graph', !/Records → Graph/.test(src('docs/help/24-finding-records.md')) && !/Records → Graph/.test(src('docs/help/APP_INVENTORY.md')));
}

console.log(`\nverify:dashboard-alerts: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
