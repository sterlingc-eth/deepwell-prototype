import { useMemo, useState } from 'react';
import { ArrowRight, AlertTriangle, Check, Copy, FileText, Link2, ShieldCheck } from 'lucide-react';
import { AppShell } from '../components/AppShell';
import { WarrantyStatusBadge, warrantyStatus } from '../components/WarrantyStatusBadge';
import { docCountsByStage, entitiesOfType, openConflicts, unlinkedDocs, useGraph } from '../core/entityGraph';
import { dateOf, fmtDate, str } from '../core/answer';
import type { Entity } from '../core/types';
import { deepLinkFor } from '../hooks/useDeepLink';
import { useAppStore } from '../store/appStore';

const DAY = 86400000;

/**
 * The office view. Every row is a question — click it and the Ask screen
 * answers it with sources. Warranty expiry and at-risk sections read the
 * entity graph, so they change when review changes the records.
 */
export function DashboardScreen() {
  const graph = useGraph();
  const askQuestion = useAppStore((s) => s.askQuestion);
  const openEntity = useAppStore((s) => s.openEntity);
  const setCurrentScreen = useAppStore((s) => s.setCurrentScreen);
  const toggleSelectForExport = useAppStore((s) => s.toggleSelectForExport);
  const clearExportSelection = useAppStore((s) => s.clearExportSelection);

  const now = new Date();
  const counts = docCountsByStage(graph);
  const total = Object.values(graph.docs).length;
  const unlinked = unlinkedDocs(graph).length;
  const conflicts = openConflicts(graph).length;

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

  const [copiedId, setCopiedId] = useState<string | null>(null);
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

        <section aria-label="Overview" className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            { label: 'Documents', value: total, sub: `${counts.verified} verified`, Icon: FileText, onClick: () => setCurrentScreen('records') },
            { label: 'Units on record', value: units.length, sub: `${upcoming.length} under warranty`, Icon: ShieldCheck, onClick: () => askQuestion('Which units are out of warranty?') },
            { label: 'Unlinked inbox', value: unlinked, sub: unlinked ? 'Target is zero' : 'Clear', Icon: Link2, onClick: () => setCurrentScreen('review') },
            { label: 'Conflicts open', value: conflicts, sub: conflicts ? 'Need a decision' : 'Clear', Icon: AlertTriangle, onClick: () => setCurrentScreen('review') },
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
                      <td className="px-4 py-3 text-ink-2">{dateOf(e, 'warrantyExpiry') ? fmtDate(dateOf(e, 'warrantyExpiry')) : '—'}</td>
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
                      {hasServiceRecords ? `Last service: ${last ? fmtDate(last) : 'none on record'}` : 'Service visits: not tracked yet'} · Ask about this property <ArrowRight className="inline w-3.5 h-3.5" aria-hidden="true" />
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
