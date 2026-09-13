import { useRef, useState } from 'react';
import { ArrowLeft, Download, Plus, X, CheckCircle2, AlertTriangle } from 'lucide-react';
import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';
import { AppShell } from '../components/AppShell';
import { WarrantyStatusBadge, warrantyStatus } from '../components/WarrantyStatusBadge';
import { docsLinkedTo, entitiesOfType, useGraph } from '../core/entityGraph';
import { dateOf, fmtDate, str } from '../core/answer';
import type { Entity } from '../core/types';
import { useAppStore } from '../store/appStore';

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

  const allUnits = entitiesOfType(graph, 'equipment');
  const units = selectedIds.map((id) => graph.entities[id]).filter((e): e is Entity => !!e && e.type === 'equipment');
  const property = (e: Entity) => graph.entities[str(e, 'propertyId')];
  const now = new Date();

  const readiness = units.map((e) => {
    const info = warrantyStatus(dateOf(e, 'warrantyExpiry'), now);
    const missing: string[] = [];
    if (!str(e, 'serial')) missing.push('serial');
    if (!dateOf(e, 'installDate')) missing.push('install date');
    if (!str(e, 'installedByName')) missing.push('installer');
    if (!dateOf(e, 'warrantyExpiry')) missing.push('warranty registration');
    const verifiedDocs = docsLinkedTo(graph, e.id).filter((d) => d.stage === 'verified');
    const ready = missing.length === 0 && info.status !== 'expired' && verifiedDocs.length > 0;
    return { e, info, missing, verifiedDocs, ready };
  });
  const allReady = readiness.length > 0 && readiness.every((r) => r.ready);

  const generate = async () => {
    if (!pdfRef.current || !units.length) return;
    setBusy(true);
    try {
      const canvas = await html2canvas(pdfRef.current, { backgroundColor: '#ffffff', scale: 2 });
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

        <section aria-labelledby="units-heading" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="units-heading" className="dw-label">Units in this packet · {units.length}</h2>
            {/* The select's options are long; a fixed max-width (not a percentage) is what
                keeps its intrinsic width from pushing the page wider than 390px. */}
            <div className="flex flex-wrap gap-2 items-center w-full sm:w-auto min-w-0">
              <label htmlFor="unit-picker" className="sr-only">Add a unit</label>
              <select id="unit-picker" className="dw-input min-h-[40px] dark:min-h-touch !py-1.5 w-full sm:w-auto sm:max-w-sm min-w-0" value={picker} onChange={(e) => setPicker(e.target.value)}>
                <option value="">Add a unit…</option>
                {allUnits.filter((u) => !selectedIds.includes(u.id)).map((u) => (
                  <option key={u.id} value={u.id}>{str(u, 'serial')} · {str(u, 'manufacturer')} {str(u, 'model')} · {str(property(u), 'address')}</option>
                ))}
              </select>
              <button type="button" className="dw-btn-secondary min-h-[40px] !py-1.5" disabled={!picker} onClick={() => { toggle(picker); setPicker(''); }}>
                <Plus className="w-4 h-4" aria-hidden="true" /> Add
              </button>
              {units.length > 0 && <button type="button" className="dw-btn-tertiary min-h-[40px] !py-1.5" onClick={clear}>Clear</button>}
            </div>
          </div>

          {units.length === 0 ? (
            <p className="dw-card p-6 text-ink-3">No units selected. Add one above, or start from the Dashboard's warranty table.</p>
          ) : (
            <ul className="divide-y divide-line border border-line rounded-lg bg-surface">
              {readiness.map(({ e, missing, verifiedDocs, ready, info }) => (
                <li key={e.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <span className="min-w-0 flex-1">
                    <span className="block font-mono text-data text-ink">{str(e, 'serial')}</span>
                    <span className="block text-body text-ink-3">{str(e, 'manufacturer')} {str(e, 'equipmentType')} · {str(e, 'model')} · {str(property(e), 'address')}</span>
                  </span>
                  <WarrantyStatusBadge warranty={{ warrantyExpiry: dateOf(e, 'warrantyExpiry') }} />
                  {ready ? (
                    <span className="dw-pill-ok"><CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" /> Ready · {verifiedDocs.length} verified doc{verifiedDocs.length === 1 ? '' : 's'}</span>
                  ) : (
                    <span className="dw-pill-warn"><AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" /> {info.status === 'expired' ? 'Warranty expired' : missing.length ? `Missing ${missing.join(', ')}` : 'No verified documents'}</span>
                  )}
                  <button type="button" onClick={() => toggle(e.id)} aria-label={`Remove ${str(e, 'serial')}`} className="dw-btn-tertiary min-h-[40px] min-w-touch"><X className="w-4 h-4" aria-hidden="true" /></button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {units.length > 0 && (
          <section aria-labelledby="packet-heading" className="space-y-3">
            <h2 id="packet-heading" className="dw-label">Packet preview</h2>
            <div className="overflow-x-auto">
              <div ref={pdfRef} className="bg-white text-stone-950 p-8 rounded-lg shadow-card min-w-[640px]" style={{ colorScheme: 'light' }}>
                <div className="border-b-2 border-stone-200 pb-4 mb-6 flex items-end justify-between">
                  <div>
                    <p className="text-[11px] tracking-[0.2em] uppercase text-stone-500">Warranty claim</p>
                    <p className="font-display text-[26px] leading-tight mt-1" style={{ color: '#163C2C' }}>DeepWell</p>
                  </div>
                  <p className="text-[12px] text-stone-500">Prepared {fmtDate(now)} · {units.length} unit{units.length === 1 ? '' : 's'}</p>
                </div>
                {readiness.map(({ e, verifiedDocs }, i) => {
                  const p = property(e);
                  return (
                    <div key={e.id} className={i < readiness.length - 1 ? 'mb-8 pb-8 border-b border-stone-200' : ''}>
                      <h3 className="text-[15px] font-semibold text-stone-900 mb-3">Unit {i + 1} — {str(e, 'manufacturer')} {str(e, 'equipmentType')}</h3>
                      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-[13px]">
                        {[
                          ['Serial number', str(e, 'serial'), true],
                          ['Model', str(e, 'model'), false],
                          ['Manufacturer', str(e, 'manufacturer'), false],
                          ['Type', str(e, 'equipmentType'), false],
                          ['Installed', fmtDate(dateOf(e, 'installDate')), false],
                          ['Installed by', str(e, 'installedByName'), false],
                          ['Warranty expires', fmtDate(dateOf(e, 'warrantyExpiry')) || 'Not on file', false],
                          ['Service address', p ? `${str(p, 'address')}, ${str(p, 'city')}, ${str(p, 'state')} ${str(p, 'zip')}` : '—', false],
                          ['Customer', p ? str(p, 'customerName') : '—', false],
                        ].map(([k, v, mono]) => (
                          <div key={String(k)}>
                            <dt className="text-[11px] uppercase tracking-wide text-stone-500">{k}</dt>
                            <dd className={`${mono ? 'font-mono' : ''} font-medium text-stone-900`}>{v}</dd>
                          </div>
                        ))}
                      </dl>
                      <p className="text-[11px] uppercase tracking-wide text-stone-500 mt-4 mb-1">Supporting documents (verified)</p>
                      <ol className="text-[12px] text-stone-700 list-decimal pl-5 space-y-0.5">
                        {verifiedDocs.map((d) => (
                          <li key={d.id}><span className="font-mono">{d.filename}</span> — {graph.schema.documentTypes.find((t) => t.id === d.typeId)?.label ?? 'Document'}{d.verifiedAt ? `, verified ${fmtDate(d.verifiedAt)}` : ''}</li>
                        ))}
                        {verifiedDocs.length === 0 && <li>None yet — verify the registration in Intake before submitting.</li>}
                      </ol>
                    </div>
                  );
                })}
                <p className="text-center text-[11px] text-stone-500 pt-6 mt-6 border-t border-stone-200">Every fact above traces to a verified document in DeepWell. Check details against the originals before submitting.</p>
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
