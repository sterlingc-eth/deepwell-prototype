import { useRef, useState } from 'react';
import { ArrowLeft, Download, Plus, X, CheckCircle2, AlertTriangle } from 'lucide-react';
import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';
import { AppShell } from '../components/AppShell';
import { WarrantyStatusBadge } from '../components/WarrantyStatusBadge';
import { entitiesOfType, useGraph } from '../core/entityGraph';
import { dateOf, fmtDate, str } from '../core/answer';
import type { Entity } from '../core/types';
import { useAppStore } from '../store/appStore';
import { buildPacket } from '../core/warrantyPacket';

/**
 * Warranty claim packet. Pulls the selected units from the entity graph
 * (the same records Ask answers from), checks what a manufacturer will need,
 * and renders a printable packet that lists the verified documents behind it.
 */
export function WarrantyExportScreen() {
  const graph = useGraph();
  const setCurrentScreen = useAppStore((s) => s.setCurrentScreen);
  const selectedIds = useAppStore((s) => s.selectedForExport);
  const toggle = useAppStore((s) => s.toggleSelectForExport);
  const clear = useAppStore((s) => s.clearExportSelection);
  const askQuestion = useAppStore((s) => s.askQuestion);
  const pdfRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState('');

  const now = new Date();
  const allUnits = entitiesOfType(graph, 'equipment');
  const units = selectedIds.map((id) => graph.entities[id]).filter((e): e is Entity => !!e && e.type === 'equipment');
  const unselectedUnits = allUnits.filter((u) => !selectedIds.includes(u.id));
  // R17 UX audit fix #2: the only way to add units used to be one
  // dropdown-select + one Add click PER unit (12 units = 24 actions). This
  // adds every remaining unit in one action; `toggle` is the store's
  // existing selectedForExport toggle, so this stays a one-shot batch of
  // synchronous store updates rather than a new store method.
  const selectAll = () => { for (const u of unselectedUnits) toggle(u.id); };
  // Live data has no property entities: the address is on the unit itself or its customer (see warrantyPacket.ts).
  const addressOf = (e: Entity) => buildPacket(graph, e, now).customer.address;

  const readiness = units.map((e) => {
    // The installer's name is worth flagging but not worth blocking on. Everything else still gates the packet: a
    // claim without a serial, an install date, a registered warranty, or a verified claim document behind it isn't
    // one a manufacturer can act on at all. buildPacket (src/core/warrantyPacket.ts) is the single source for this.
    const packet = buildPacket(graph, e, now);
    return { e, packet, info: { status: packet.warranty.status }, missing: packet.missing, missingInstaller: packet.advisories.length > 0, verifiedDocs: { length: packet.documentCount }, ready: packet.ready };
  });
  const allReady = readiness.length > 0 && readiness.every((r) => r.ready);
  // R36: "Download PDF" stays off until every unit is claim-ready, and Dashboard's "select all" includes expired
  // units — so the common path used to dead-end on a greyed button (7 expired units = 7 Remove clicks). Say why,
  // and offer the one-click fix.
  const notReady = readiness.filter((r) => !r.ready);
  const removeNotReady = () => { for (const r of notReady) toggle(r.e.id); };

  const generate = async () => {
    if (!pdfRef.current || !units.length) return;
    setBusy(true);
    try {
      // The preview is fluid on a phone; the PDF is always laid out at sheet width so it reads the same everywhere.
      const el = pdfRef.current;
      const prevStyle = el.style.cssText;
      el.style.width = '720px';
      el.style.maxWidth = 'none';
      let canvas: HTMLCanvasElement;
      try {
        canvas = await html2canvas(el, { backgroundColor: '#ffffff', scale: 2, windowWidth: 1100 });
      } finally {
        el.style.cssText = prevStyle;
      }
      const img = canvas.toDataURL('image/png');
      const pdf = new jsPDF('p', 'mm', 'a4');
      const w = 210;
      const h = (canvas.height * w) / canvas.width;
      let left = h;
      let pos = 0;
      pdf.addImage(img, 'PNG', 0, pos, w, h);
      left -= 297;
      while (left > 0) {
        pos = left - h;
        pdf.addPage();
        pdf.addImage(img, 'PNG', 0, pos, w, h);
        left -= 297;
      }
      pdf.save(`deepwell-warranty-claim-${now.toISOString().slice(0, 10)}.pdf`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell>
      <div className="space-y-8">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <button type="button" onClick={() => setCurrentScreen('dashboard')} className="dw-btn-tertiary -ml-3 mb-1">
              <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Dashboard
            </button>
            <h1>Warranty claim packet</h1>
            <p className="text-ink-2 mt-1">Everything a manufacturer asks for, with the documents behind each fact.</p>
          </div>
          <button type="button" className="dw-btn-primary" onClick={generate} disabled={!allReady || busy}>
            <Download className="w-4 h-4" aria-hidden="true" /> {busy ? 'Preparing…' : 'Download PDF'}
          </button>
        </header>

        {units.length > 0 && !allReady && (
          <div role="status" data-testid="export-not-ready" className="dw-card p-4 flex flex-wrap items-center justify-between gap-3 border-warn/40">
            <p className="text-body text-ink-2 min-w-0">
              <AlertTriangle className="w-4 h-4 text-warn inline mr-1.5 -mt-0.5" aria-hidden="true" />
              {notReady.length} of {units.length} unit{units.length === 1 ? ' is' : 's are'} not ready for a claim (expired warranty, missing details or no verified document). Download turns on once every unit in the packet is ready.
            </p>
            <button type="button" className="dw-btn-secondary !min-h-[40px] !py-1.5 shrink-0" onClick={removeNotReady}>
              <X className="w-4 h-4" aria-hidden="true" /> Remove {notReady.length} not ready
            </button>
          </div>
        )}

        <section aria-labelledby="units-heading" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="units-heading" className="dw-label">Units in this packet · {units.length}</h2>
            <div className="flex flex-wrap gap-2 items-center">
              <label htmlFor="unit-picker" className="sr-only">Add a unit</label>
              <select id="unit-picker" className="dw-input !min-h-[40px] !py-1.5 w-auto max-w-full min-w-0" value={picker} onChange={(e) => setPicker(e.target.value)}>
                <option value="">Add a unit…</option>
                {allUnits.filter((u) => !selectedIds.includes(u.id)).map((u) => (
                  <option key={u.id} value={u.id}>{str(u, 'serial')} · {str(u, 'manufacturer')} {str(u, 'model')} · {addressOf(u)}</option>
                ))}
              </select>
              <button type="button" className="dw-btn-secondary !min-h-[40px] !py-1.5" disabled={!picker} onClick={() => { toggle(picker); setPicker(''); }}>
                <Plus className="w-4 h-4" aria-hidden="true" /> Add
              </button>
              {unselectedUnits.length > 0 && (
                <button type="button" className="dw-btn-secondary !min-h-[40px] !py-1.5" onClick={selectAll}>
                  <Plus className="w-4 h-4" aria-hidden="true" /> Select all {unselectedUnits.length}
                </button>
              )}
              {units.length > 0 && <button type="button" className="dw-btn-tertiary !min-h-[40px] !py-1.5" onClick={clear}>Clear</button>}
            </div>
          </div>

          {units.length === 0 ? (
            <p className="dw-card p-6 text-ink-3">No units selected. Add one above, or start from the Dashboard's warranty table.</p>
          ) : (
            <ul className="divide-y divide-line border border-line rounded-lg bg-surface">
              {readiness.map(({ e, missing, missingInstaller, verifiedDocs, ready, info }) => (
                <li key={e.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <span className="min-w-0 flex-1">
                    <span className="block font-mono text-data text-ink">{str(e, 'serial')}</span>
                    <span className="block text-body text-ink-3">{str(e, 'manufacturer')} {str(e, 'equipmentType')} · {str(e, 'model')} · {addressOf(e)}</span>
                  </span>
                  <WarrantyStatusBadge warranty={{ warrantyExpiry: dateOf(e, 'warrantyExpiry') }} />
                  {ready ? (
                    <span className="dw-pill-ok"><CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" /> Ready · {verifiedDocs.length} verified doc{verifiedDocs.length === 1 ? '' : 's'}</span>
                  ) : (
                    <span className="dw-pill-warn"><AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" /> {info.status === 'expired' ? 'Warranty expired' : missing.length ? `Missing ${missing.join(', ')}` : 'No verified documents'}</span>
                  )}
                  {/* Not a blocker — see the comment on `readiness` above. */}
                  {missingInstaller && (
                    <span className="dw-pill-warn"><AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" /> Installer not on file</span>
                  )}
                  <button type="button" onClick={() => toggle(e.id)} aria-label={`Remove ${str(e, 'serial')}`} className="dw-btn-tertiary !min-h-[40px] min-w-touch"><X className="w-4 h-4" aria-hidden="true" /></button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {units.length > 0 && (
          <section aria-labelledby="packet-heading" className="space-y-3">
            <h2 id="packet-heading" className="dw-label">Packet preview</h2>
            <div>
              <div ref={pdfRef} className="bg-white text-stone-950 p-4 sm:p-8 rounded-lg shadow-card" style={{ colorScheme: 'light' }}>
                <div className="border-b-2 border-stone-200 pb-4 mb-6 flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
                  <div>
                    <p className="text-[11px] tracking-[0.2em] uppercase text-stone-500">Warranty claim</p>
                    <p className="font-display text-[26px] leading-tight mt-1" style={{ color: '#163C2C' }}>DeepWell <span className="font-mono text-[11px] tracking-[0.3em] uppercase align-middle">Technology</span></p>
                  </div>
                  <p className="text-[12px] text-stone-500">Prepared {fmtDate(now)} · {units.length} unit{units.length === 1 ? '' : 's'}</p>
                </div>
                {readiness.map(({ packet }, i) => {
                  const { unit, customer, warranty, documents, serviceHistory } = packet;
                  const label = 'text-[11px] uppercase tracking-wide text-stone-500';
                  const field = (k: string, v: string, mono = false) => (
                    <div key={k}>
                      <dt className={label}>{k}</dt>
                      <dd className={`${mono ? 'font-mono ' : ''}font-medium text-stone-900`}>{v || 'Not on file'}</dd>
                    </div>
                  );
                  const expiryNote = warranty.expiryBasis === 'printed' ? 'As printed on the registration' : warranty.expiryBasis === 'computed' ? 'Calculated from the install date and warranty term' : '';
                  return (
                    <div key={unit.id} data-testid="packet-unit" className={i < readiness.length - 1 ? 'mb-8 pb-8 border-b border-stone-200' : ''}>
                      <h3 className="text-[15px] font-semibold text-stone-900 mb-3">Unit {i + 1} — {unit.manufacturer} {unit.equipmentType}</h3>

                      <p className={`${label} mb-1`}>Customer</p>
                      <dl className="grid grid-cols-1 min-[480px]:grid-cols-2 gap-x-6 gap-y-3 text-[13px] mb-4 [&>div]:min-w-0 [&_dd]:break-words">
                        {field('Name', customer.name)}
                        {field('Service address', customer.address)}
                        {customer.number && field('Customer number', customer.number)}
                        {customer.phone && field('Phone', customer.phone)}
                        {customer.email && field('Email', customer.email)}
                      </dl>

                      <p className={`${label} mb-1`}>Unit</p>
                      <dl className="grid grid-cols-1 min-[480px]:grid-cols-2 gap-x-6 gap-y-3 text-[13px] mb-4 [&>div]:min-w-0 [&_dd]:break-words">
                        {field('Serial number', unit.serial, true)}
                        {field('Model', unit.model)}
                        {field('Manufacturer', unit.manufacturer)}
                        {field('Type', unit.equipmentType)}
                        {field('Installed', unit.installDate)}
                        {field('Installed by', unit.installedBy)}
                      </dl>

                      <p className={`${label} mb-1`}>Warranty terms</p>
                      <dl className="grid grid-cols-1 min-[480px]:grid-cols-2 gap-x-6 gap-y-3 text-[13px] mb-4 [&>div]:min-w-0 [&_dd]:break-words">
                        {field('Status', warranty.statusLabel)}
                        {field('Warranty expires', warranty.expires)}
                        {field('Manufacturer term', warranty.termPrinted || (warranty.termYears ? `${warranty.termYears} years from install` : ''))}
                        {field('Registered with manufacturer', warranty.registeredOn)}
                      </dl>
                      {expiryNote && <p className="text-[11px] text-stone-500 -mt-2 mb-4">Expiry date: {expiryNote.toLowerCase()}.</p>}

                      <p className={`${label} mb-1`}>Supporting documents (verified)</p>
                      {documents.length === 0 ? (
                        <p className="text-[12px] text-stone-700 mb-4">None yet — verify the registration in Intake before submitting.</p>
                      ) : (
                        <div className="mb-4 space-y-2">
                          {documents.map((g) => (
                            <div key={g.role}>
                              <p className="text-[12px] font-semibold text-stone-800">{g.heading}</p>
                              <ul className="text-[12px] text-stone-700 list-disc pl-5 space-y-0.5">
                                {g.docs.map((d) => (
                                  <li key={d.id}>
                                    <span className="font-medium">{d.name}</span>
                                    {d.filename && <span className="font-mono text-stone-500"> ({d.filename})</span>}
                                    {' — '}{d.typeLabel}{d.verifiedOn ? `, verified ${d.verifiedOn}` : ''}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ))}
                        </div>
                      )}

                      <p className={`${label} mb-1`}>Service history</p>
                      {serviceHistory.length === 0 ? (
                        <p className="text-[12px] text-stone-700">No service visits on file for this unit.</p>
                      ) : (
                        <div className="overflow-x-auto"><table className="w-full text-[12px] text-stone-700 border-collapse">
                          <thead>
                            <tr className="text-left text-stone-500 border-b border-stone-200">
                              <th className="py-1 pr-3 font-medium w-[96px]">Date</th>
                              <th className="py-1 pr-3 font-medium">Work performed</th>
                              <th className="py-1 font-medium w-[110px]">Technician</th>
                            </tr>
                          </thead>
                          <tbody>
                            {serviceHistory.map((v, k) => (
                              <tr key={k} className="border-b border-stone-100 align-top">
                                <td className="py-1 pr-3 whitespace-nowrap">{v.date}</td>
                                <td className="py-1 pr-3">{v.work}</td>
                                <td className="py-1">{v.technician || '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table></div>
                      )}
                    </div>
                  );
                })}
                <p className="text-center text-[11px] text-stone-500 pt-6 mt-6 border-t border-stone-200">Every fact above traces to a verified document in DeepWell Technology. Check details against the originals before submitting.</p>
              </div>
            </div>
          </section>
        )}

        {units[0] && (
          <button type="button" className="dw-btn-tertiary -ml-3" onClick={() => askQuestion(`Is ${str(units[0], 'serial')} under warranty?`)}>
            Ask about {str(units[0], 'serial')}
          </button>
        )}
      </div>
    </AppShell>
  );
}
