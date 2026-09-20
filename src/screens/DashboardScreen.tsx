import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Check, ChevronRight, ClipboardList, Copy, FileText, Loader2, ShieldCheck, Upload, User } from 'lucide-react';
import { AppShell } from '../components/AppShell';
import { DataHealthStrip } from '../components/DataHealthStrip';
import { WarrantyStatusBadge, warrantyStatus, type AlertTier } from '../components/WarrantyStatusBadge';
import { docCountsByStage, entitiesOfType, useGraph } from '../core/entityGraph';
import { dateOf, formatYmd, normalize, str } from '../core/answer';
import type { Entity } from '../core/types';
import { deepLinkFor } from '../hooks/useDeepLink';
import { customerClient } from '../services/customerClient';
import { useAppStore } from '../store/appStore';
import { authHeader } from '../services/authToken';

const DAY = 86400000;
const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === 'true';

/** One row of POST /api/warranty-attention's `items` — see
 *  api/warranty-attention.js and api/_lib/warrantyRules.js (`alertTier`,
 *  `upsell`). Kept local: this is the only screen that reads this endpoint. */
interface AttentionItem {
  entityId: string;
  serialNumber: string | null;
  model: string | null;
  manufacturer: string | null;
  serviceAddress: string | null;
  customerName: string | null;
  expires: string | null;
  registrationDeadline: string | null;
  tier: AlertTier;
  daysLeft: number | null;
  upsell: { eligible: boolean; reason: string };
}
interface AttentionResponse {
  today: string;
  items: AttentionItem[];
  summary: {
    expired: number;
    expiring30: number;
    expiring90: number;
    expiring365: number;
    registrationClosing: number;
    upsellEligible: number;
  };
}

/** Alert cards shown on the dashboard, in priority order: the five real
 *  `alertTier` buckets this feature computes, plus `upsell` (not a tier —
 *  it's `item.upsell.eligible` across every item, so a unit can show up here
 *  and in another card too). Always rendered, 0 included, so the owner can
 *  tell the feature is working even on a quiet day. */
type AlertCardKey = 'expired' | 'expiring-30' | 'expiring-90' | 'expiring-365' | 'unregistered-window-closing' | 'upsell';
const ALERT_CARDS: { key: AlertCardKey; title: string }[] = [
  { key: 'expired', title: 'Expired' },
  { key: 'expiring-30', title: 'Expiring in 30 days' },
  { key: 'expiring-90', title: 'Expiring in 90 days' },
  { key: 'expiring-365', title: 'Expiring in 12 months' },
  { key: 'unregistered-window-closing', title: 'Registration closing' },
  { key: 'upsell', title: 'Upsell candidates' },
];

/** Names the bucket instead of a generic "Nothing in this bucket right now." */
const ALERT_EMPTY_LABEL: Record<AlertCardKey, string> = {
  expired: 'No units expired right now.',
  'expiring-30': 'No units expiring in 30 days right now.',
  'expiring-90': 'No units expiring in 90 days right now.',
  'expiring-365': 'No units expiring in 12 months right now.',
  'unregistered-window-closing': 'No registrations closing soon.',
  upsell: 'No upsell candidates right now.',
};

function itemsForCard(items: AttentionItem[], key: AlertCardKey): AttentionItem[] {
  return key === 'upsell' ? items.filter((i) => i.upsell.eligible) : items.filter((i) => i.tier === key);
}

/** Plain-text extended-warranty / maintenance-agreement pitch. Template only —
 *  no model call, per the brief. Copied to the clipboard for the rep to paste. */
function outreachDraft(item: AttentionItem): string {
  const name = item.customerName || 'there';
  const unit = [item.manufacturer, item.model].filter(Boolean).join(' ') || 'HVAC unit';
  const where = item.serviceAddress ? ` at ${item.serviceAddress}` : '';
  const status =
    item.tier === 'expired'
      ? `is no longer covered by ${item.manufacturer ?? 'the manufacturer'}'s parts warranty${item.expires ? ` (expired ${item.expires})` : ''}`
      : item.tier === 'unregistered-window-closing'
        ? `still needs to be registered with ${item.manufacturer ?? 'the manufacturer'} — the window to lock in the full parts term closes ${item.registrationDeadline ?? 'soon'}`
        : item.expires
          ? `is nearing the end of its ${item.manufacturer ?? 'manufacturer'} parts warranty (expires ${item.expires})`
          : `may not be fully covered for labor even while parts are still under warranty`;
  return (
    `Hi ${name},\n\n` +
    `Our records show your ${unit}${where} ${status}.\n\n` +
    `We offer an extended warranty / maintenance agreement that covers parts and labor beyond the manufacturer's ` +
    `terms, so a future repair doesn't come as a surprise bill. Want me to send over the options?\n\n` +
    `Thanks`
  );
}

/**
 * The office view. Every row is a question — click it and the Ask screen
 * answers it with sources. Warranty expiry and at-risk sections read the
 * entity graph, so they change when review changes the records.
 */
export function DashboardScreen() {
  const graph = useGraph();
  const askQuestion = useAppStore((s) => s.askQuestion);
  const openEntity = useAppStore((s) => s.openEntity);
  const openCustomer = useAppStore((s) => s.openCustomer);
  const setCurrentScreen = useAppStore((s) => s.setCurrentScreen);
  const setInboxTab = useAppStore((s) => s.setInboxTab);
  const toggleSelectForExport = useAppStore((s) => s.toggleSelectForExport);
  const clearExportSelection = useAppStore((s) => s.clearExportSelection);

  const now = new Date();
  const counts = docCountsByStage(graph);
  const total = Object.values(graph.docs).length;

  const units = useMemo(() => entitiesOfType(graph, 'equipment'), [graph]);
  // The real (non-demo) ingestion pipeline has no writer for `service` entities
  // yet (see usePostgresSync.ts) — every real tenant has zero of them. Saying
  // "none on record" per unit in that world is a lie by omission: it reads as
  // "we checked and this unit has no history" when the truth is "we don't
  // track visits at all yet". Gate on whether the graph has ANY service
  // entities so demo mode (which does) keeps its honest per-unit wording.
  const hasServiceRecords = entitiesOfType(graph, 'service').length > 0;
  const property = (e: Entity) => graph.entities[str(e, 'propertyId')];
  const lastVisit = (e: Entity) =>
    entitiesOfType(graph, 'service')
      .filter((s) => str(s, 'equipmentId') === e.id)
      .map((s) => dateOf(s, 'date'))
      .filter((d): d is Date => !!d)
      .sort((a, b) => b.getTime() - a.getTime())[0];

  // Alerts: from POST /api/warranty-attention, not the client-side entity
  // graph — registration deadlines and upsell reasons need the server's
  // brand-rule derivation (warrantyRules.js), which the graph doesn't carry.
  // Skipped in demo mode, which has no backend to call.
  const [attention, setAttention] = useState<AttentionResponse | null>(null);
  const [openCard, setOpenCard] = useState<AlertCardKey | null>(null);
  useEffect(() => {
    if (DEMO_MODE) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/warranty-attention', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
          body: JSON.stringify({}),
        });
        if (!res.ok) return;
        const data = (await res.json()) as AttentionResponse;
        if (!cancelled) setAttention(data);
      } catch {
        /* Alerts are a bonus on this screen, not load-bearing — fail quiet. */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [draftedId, setDraftedId] = useState<string | null>(null);
  const draftOutreach = (item: AttentionItem) => {
    void navigator.clipboard
      .writeText(outreachDraft(item))
      .then(() => {
        setDraftedId(item.entityId);
        window.setTimeout(() => setDraftedId((id) => (id === item.entityId ? null : id)), 1500);
      })
      .catch(() => {
        /* clipboard unavailable — nothing to fall back to here */
      });
  };
  // "View customer": /api/warranty-attention (agent-backend's file, out of
  // scope here) carries a unit's customerName as free text, not a customer
  // id, so this looks the name up against GET /api/v1/customers on demand —
  // only when clicked, never prefetched for the whole alert list — and only
  // navigates on an exact (normalized) name match, since a fuzzy hit here
  // would send someone to the wrong customer's profile.
  const [customerLookup, setCustomerLookup] = useState<Record<string, 'loading' | 'notfound'>>({});
  const viewCustomer = async (item: AttentionItem) => {
    if (!item.customerName) return;
    setCustomerLookup((m) => ({ ...m, [item.entityId]: 'loading' }));
    try {
      const rows = await customerClient.list({ q: item.customerName, sort: 'name', limit: 5 });
      const match = rows.find((r) => r.name && normalize(r.name) === normalize(item.customerName as string));
      if (match) {
        setCustomerLookup((m) => { const n = { ...m }; delete n[item.entityId]; return n; });
        openCustomer(match.id);
      } else {
        setCustomerLookup((m) => ({ ...m, [item.entityId]: 'notfound' }));
        window.setTimeout(() => setCustomerLookup((m) => { const n = { ...m }; delete n[item.entityId]; return n; }), 2500);
      }
    } catch {
      setCustomerLookup((m) => { const n = { ...m }; delete n[item.entityId]; return n; });
    }
  };

  const copyLink = (entityId: string) => {
    void navigator.clipboard
      .writeText(deepLinkFor({ entityId }))
      .then(() => {
        setCopiedId(entityId);
        window.setTimeout(() => setCopiedId((id) => (id === entityId ? null : id)), 1500);
      })
      .catch(() => {
        /* clipboard unavailable (permissions, insecure context) — nothing to fall back to here */
      });
  };

  // Client-side, independent of /api/warranty-attention: that endpoint only
  // ever returns actionable rows (see its own filter), so tier:'ok' units and
  // units with no derivable warranty never appear in `attention.items` at
  // all — there is nothing there to build a "Covered" or "no warranty on
  // file" list from. Both are cheap to derive from what's already loaded.
  const coveredUnits = units.filter((e) => warrantyStatus(dateOf(e, 'warrantyExpiry'), now).status === 'active');
  // Genuinely actionable, unlike a computed alert: the shop can fix this by
  // registering the unit or simply entering the install date on file.
  const noWarrantyUnits = units.filter((e) => warrantyStatus(dateOf(e, 'warrantyExpiry'), now).status === 'unknown');

  const byExpiry = [...units].sort((a, b) => {
    const da = dateOf(a, 'warrantyExpiry');
    const db = dateOf(b, 'warrantyExpiry');
    if (!da && !db) return 0;
    if (!da) return 1;
    if (!db) return -1;
    return da.getTime() - db.getTime();
  });
  const upcoming = byExpiry.filter((e) => {
    const d = dateOf(e, 'warrantyExpiry');
    return !!d && d >= now;
  });
  const atRisk = units
    .map((e) => {
      const info = warrantyStatus(dateOf(e, 'warrantyExpiry'), now);
      const last = lastVisit(e);
      const monthsSince = last ? Math.floor((now.getTime() - last.getTime()) / (30 * DAY)) : null;
      const reasons: string[] = [];
      if (info.status === 'expiring') reasons.push(info.label);
      if (info.status === 'unknown') reasons.push('No warranty on file');
      // Same honesty gate as the "Last service" line below: "Never serviced"
      // is a claim about this unit's history, which nothing backs when the
      // system tracks no service visits at all.
      if (hasServiceRecords) {
        if (monthsSince === null) reasons.push('Never serviced');
        else if (monthsSince >= 12) reasons.push(`Last service ${monthsSince} months ago`);
      }
      if (info.status === 'expired' && monthsSince !== null && monthsSince >= 6) reasons.push('Out of warranty and overdue');
      return { e, reasons, info, last };
    })
    .filter((x) => x.reasons.length > 0)
    .sort((a, b) => b.reasons.length - a.reasons.length);

  const exportSelected = (ids: string[]) => {
    clearExportSelection();
    for (const id of ids) toggleSelectForExport(id);
    setCurrentScreen('warranty-export');
  };

  return (
    <AppShell>
      <div className="space-y-10">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1>Dashboard</h1>
            <p className="text-ink-2 mt-1">Every row is a question. Click one and your records answer it.</p>
          </div>
          <button type="button" className="dw-btn-primary" onClick={() => setCurrentScreen('ask')}>
            Ask a question <ArrowRight className="w-4 h-4" aria-hidden="true" />
          </button>
        </header>

        <DataHealthStrip />

        {!DEMO_MODE && total === 0 ? (
          <section aria-labelledby="alerts-heading" className="space-y-3">
            <h2 id="alerts-heading" className="dw-label">Alerts</h2>
            <div className="dw-card p-6 flex flex-wrap items-center justify-between gap-4">
              <p className="text-ink-2">Your warranty alerts will show up here once you've added a few documents.</p>
              <button type="button" className="dw-btn-primary shrink-0" onClick={() => { setCurrentScreen('ingest'); setInboxTab('add'); }}>
                <Upload className="w-4 h-4" aria-hidden="true" /> Add documents
              </button>
            </div>
          </section>
        ) : !DEMO_MODE && (
          <section aria-labelledby="alerts-heading" className="space-y-3">
            <h2 id="alerts-heading" className="dw-label">Alerts</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              {ALERT_CARDS.map(({ key, title }) => {
                const count = itemsForCard(attention?.items ?? [], key).length;
                const isOpen = openCard === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setOpenCard((k) => (k === key ? null : key))}
                    className={`dw-card p-4 text-left hover:shadow-lift transition-shadow duration-quick ${isOpen ? 'ring-2 ring-accent' : ''}`}
                    aria-expanded={isOpen}
                  >
                    <div className="flex items-start justify-between">
                      <p className="text-caption text-ink-3">{title}</p>
                      <ClipboardList className="w-4 h-4 text-ink-3" aria-hidden="true" />
                    </div>
                    <div className="flex items-end justify-between mt-1">
                      <p className="font-display text-h1">{count}</p>
                      <span className="flex items-center gap-0.5 text-caption text-ink-3">
                        View list <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
            {openCard && (
              <ul className="space-y-2">
                {itemsForCard(attention?.items ?? [], openCard).map((item) => (
                  <li key={item.entityId} className="dw-card p-3 flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-mono text-data text-ink">{item.serialNumber ?? '—'}</p>
                      <p className="text-ink">
                        {[item.manufacturer, item.model].filter(Boolean).join(' ') || 'Unknown unit'}
                        {item.customerName ? ` · ${item.customerName}` : ''}
                        {item.serviceAddress ? ` · ${item.serviceAddress}` : ''}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <WarrantyStatusBadge warranty={{ warrantyExpiry: null }} tier={item.tier} />
                        <span className="text-body text-ink-3">
                          {item.tier === 'unregistered-window-closing'
                            ? item.registrationDeadline
                              ? `Register by ${item.registrationDeadline}`
                              : 'Registration due soon'
                            : item.expires
                              ? `Expires ${item.expires}`
                              : 'No expiry on file'}
                        </span>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <div className="flex gap-1.5">
                        {item.customerName && (
                          <button
                            type="button"
                            onClick={() => void viewCustomer(item)}
                            disabled={customerLookup[item.entityId] === 'loading'}
                            className="dw-btn-tertiary !min-h-[36px] !py-1"
                          >
                            {customerLookup[item.entityId] === 'loading' ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <User className="w-3.5 h-3.5" aria-hidden="true" />}
                            View customer
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => askQuestion(item.serialNumber ? `Is ${item.serialNumber} under warranty?` : 'Which units are out of warranty?')}
                          className="dw-btn-tertiary !min-h-[36px] !py-1"
                        >
                          Ask about this unit
                        </button>
                        <button type="button" onClick={() => draftOutreach(item)} className="dw-btn-secondary !min-h-[36px] !py-1">
                          {draftedId === item.entityId ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : null}
                          {draftedId === item.entityId ? 'Copied' : 'Draft outreach'}
                        </button>
                      </div>
                      {customerLookup[item.entityId] === 'notfound' && (
                        <span className="text-caption text-ink-3">No customer profile found.</span>
                      )}
                    </div>
                  </li>
                ))}
                {itemsForCard(attention?.items ?? [], openCard).length === 0 && (
                  <li className="text-body text-ink-3">{ALERT_EMPTY_LABEL[openCard]}</li>
                )}
              </ul>
            )}

            {/* Always visible (not gated on there being anything to act on) so
                the owner can see the feature is actually looking at their
                units, not just silent. Derived client-side — see the
                comment on coveredUnits/noWarrantyUnits above. */}
            <details className="dw-card p-3">
              <summary className="cursor-pointer text-body text-ink-2">
                Covered · {coveredUnits.length} unit{coveredUnits.length === 1 ? '' : 's'}
              </summary>
              <ul className="mt-2 space-y-1.5">
                {coveredUnits.map((e) => (
                  <li key={e.id} className="flex items-center justify-between gap-3 text-body text-ink-3">
                    <button type="button" onClick={() => openEntity(e.id)} className="font-mono text-data underline decoration-line-2 underline-offset-4 hover:decoration-forest-700 truncate">
                      {str(e, 'serial')}
                    </button>
                    <span>{[str(e, 'manufacturer'), str(e, 'model')].filter(Boolean).join(' ')} · expires {formatYmd(dateOf(e, 'warrantyExpiry'))}</span>
                  </li>
                ))}
                {coveredUnits.length === 0 && <li className="text-body text-ink-3">None yet.</li>}
              </ul>
            </details>

            {noWarrantyUnits.length > 0 && (
              <div className="dw-card p-3 space-y-2">
                <p className="text-body text-ink-2 font-medium">No warranty on file — needs install date · {noWarrantyUnits.length}</p>
                <ul className="space-y-1.5">
                  {noWarrantyUnits.map((e) => (
                    <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 text-body text-ink-3">
                      <span className="font-mono text-data">{str(e, 'serial')}</span>
                      <span className="min-w-0 flex-1">{[str(e, 'manufacturer'), str(e, 'model')].filter(Boolean).join(' ') || 'Unknown unit'}</span>
                      <button type="button" className="dw-btn-tertiary !min-h-[32px] !py-0.5" onClick={() => openEntity(e.id)}>Add install date</button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}

        <section aria-label="Overview" className="grid grid-cols-2 gap-3">
          {[
            { label: 'Documents', value: total, sub: `${counts.verified} checked`, Icon: FileText, onClick: () => setCurrentScreen('browse') },
            { label: 'Units on record', value: units.length, sub: `${upcoming.length} under warranty`, Icon: ShieldCheck, onClick: () => askQuestion('Which units are out of warranty?') },
          ].map(({ label, value, sub, Icon, onClick }) => (
            <button key={label} type="button" onClick={onClick} className="dw-card p-4 text-left hover:shadow-lift transition-shadow duration-quick">
              <div className="flex items-start justify-between">
                <p className="text-caption text-ink-3">{label}</p>
                <Icon className="w-4 h-4 text-ink-3" aria-hidden="true" />
              </div>
              <p className="font-display text-h1 mt-1">{value}</p>
              <p className="text-body text-ink-3">{sub}</p>
            </button>
          ))}
        </section>

        <section aria-labelledby="expiry-heading" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="expiry-heading" className="dw-label">Warranty expiry · next to expire first</h2>
            <div className="flex gap-2">
              <button type="button" className="dw-btn-tertiary !min-h-[36px] !py-1" onClick={() => askQuestion('Which warranties expire in the next 12 months?')}>Ask: next 12 months</button>
              <button type="button" className="dw-btn-secondary !min-h-[36px] !py-1" onClick={() => exportSelected(upcoming.slice(0, 3).map((e) => e.id))}>Prepare claim packet</button>
            </div>
          </div>
          <div className="relative overflow-x-auto border border-line rounded-lg bg-surface">
            <table className="w-full text-body-lg">
              <thead className="text-left text-label text-ink-3 uppercase bg-surface-2">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">Unit</th>
                  <th scope="col" className="px-4 py-2 font-medium">Location</th>
                  <th scope="col" className="px-4 py-2 font-medium">Expires</th>
                  <th scope="col" className="px-4 py-2 font-medium">Status</th>
                  <th scope="col" className="px-4 py-2"><span className="sr-only">Ask</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {byExpiry.map((e) => {
                  const p = property(e);
                  const q = `Is ${str(e, 'serial')} under warranty?`;
                  return (
                    <tr key={e.id} className="hover:bg-surface-2 cursor-pointer" onClick={() => askQuestion(q)}>
                      <td className="px-4 py-3">
                        <button type="button" onClick={(ev) => { ev.stopPropagation(); openEntity(e.id); }} className="font-mono text-data text-ink underline decoration-line-2 underline-offset-4">{str(e, 'serial')}</button>
                        <span className="block text-body text-ink-3">{str(e, 'manufacturer')} {str(e, 'equipmentType')} · {str(e, 'model')}</span>
                      </td>
                      <td className="px-4 py-3 text-ink-2">{p ? str(p, 'address') : '—'}</td>
                      <td className="px-4 py-3 text-ink-2">{dateOf(e, 'warrantyExpiry') ? formatYmd(dateOf(e, 'warrantyExpiry')) : '—'}</td>
                      <td className="px-4 py-3"><WarrantyStatusBadge warranty={{ warrantyExpiry: dateOf(e, 'warrantyExpiry') }} /></td>
                      <td className="px-4 py-3 text-right">
                        <div className="inline-flex gap-1.5">
                          <button type="button" onClick={(ev) => { ev.stopPropagation(); copyLink(e.id); }} className="dw-btn-tertiary !min-h-[36px] !py-1" aria-label={`Copy link to ${str(e, 'serial')}`}>
                            {copiedId === e.id ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
                            {copiedId === e.id ? 'Copied' : 'Copy link'}
                          </button>
                          <button type="button" onClick={(ev) => { ev.stopPropagation(); askQuestion(q); }} className="dw-btn-tertiary !min-h-[36px] !py-1" aria-label={q}>Ask <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" /></button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section aria-labelledby="risk-heading" className="space-y-3">
          <h2 id="risk-heading" className="dw-label">Equipment at risk · {atRisk.length}</h2>
          <ul className="grid md:grid-cols-2 gap-3">
            {atRisk.map(({ e, reasons, last }) => {
              const p = property(e);
              const q = p ? `${str(p, 'address')}` : str(e, 'serial');
              return (
                <li key={e.id} className="relative">
                  <button
                    type="button"
                    onClick={(ev) => { ev.stopPropagation(); copyLink(e.id); }}
                    aria-label={`Copy link to ${str(e, 'serial')}`}
                    className="absolute top-3 right-3 z-10 dw-btn-tertiary !min-h-[32px] !py-1 !px-2 bg-surface"
                  >
                    {copiedId === e.id ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
                  </button>
                  <button type="button" onClick={() => askQuestion(q)} className="w-full text-left dw-card p-4 hover:shadow-lift transition-shadow duration-quick">
                    <div className="flex items-start justify-between gap-3 pr-8">
                      <div className="min-w-0">
                        <p className="font-mono text-data text-ink">{str(e, 'serial')}</p>
                        <p className="text-ink">{str(e, 'manufacturer')} {str(e, 'equipmentType')} · {p ? str(p, 'address') : ''}</p>
                      </div>
                      <WarrantyStatusBadge warranty={{ warrantyExpiry: dateOf(e, 'warrantyExpiry') }} />
                    </div>
                    <ul className="mt-2 flex flex-wrap gap-1.5">
                      {reasons.map((r) => <li key={r} className="dw-pill-warn">{r}</li>)}
                    </ul>
                    <p className="mt-2 text-body text-ink-3">
                      {hasServiceRecords ? `Last service: ${last ? formatYmd(last) : 'none on record'}` : 'Service visits: not tracked yet'} · Ask about this property <ArrowRight className="inline w-3.5 h-3.5" aria-hidden="true" />
                    </p>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </AppShell>
  );
}
