/**
 * R32 (Team M): the DETERMINISTIC dossier summariser. Replaces the per-document Haiku "dossier_sentences" call with
 * sentences composed from the labelled fields extractFromText() already reads off the page text. Every sentence is
 * built only from values printed on the cited page (no inference), and carries that page number. A document the
 * text extractor does not explain contributes no sentences (the agent falls back to searchKnowledge for those).
 */
import { extractFromText } from './textExtract.js';
import { classifyDateForField } from '../extractFields.js';

const TYPE_LABEL = {
  invoice: 'Invoice', 'service-ticket': 'Service ticket', 'work-order': 'Work order', 'warranty-registration': 'Warranty registration',
  'startup-sheet': 'Startup sheet', 'maintenance-agreement': 'Maintenance agreement', 'proposal-quote': 'Proposal/quote',
  'inspection-report': 'Inspection report', 'equipment-record': 'Equipment record', permit: 'Permit',
};

/** @returns {{text:string, citations:{documentId:string,page:number}[]}[]} at most 4 sentences */
export function deterministicDossierSentences(doc, { today = new Date().toISOString().slice(0, 10) } = {}) {
  let r;
  try { r = extractFromText(doc.pages ?? [], { skipInstallGuard: true }); } catch { return []; }
  if (!r?.accepted) return [];
  const f = {};
  for (const x of r.toolInput.fields) if (!(x.key in f)) f[x.key] = x;
  const v = (k) => f[k]?.value;
  const pageOf = (...keys) => keys.map((k) => f[k]?.page_no).find((p) => Number.isInteger(p)) ?? 1;
  const out = [];
  const push = (text, ...keys) => out.push({ text: text.slice(0, 300), citations: [{ documentId: doc.id, page: pageOf(...keys) }] });
  const label = TYPE_LABEL[r.type] ?? r.type;
  const num = v('invoice_number') ?? v('permit_number');
  // R33: a printed date beyond its field's window (service_date 10/19/2028 read on 2026-09-30) is quoted with an explicit
  // caveat, never as a plain fact — the agent must not answer "last serviced Oct 19, 2028" from an unconfirmed reading.
  const caveat = (key, d) => (d && classifyDateForField(key, d, today).status === 'far_future' ? `${d} (printed date is in the future; unconfirmed)` : d);
  const whenKey = ['service_date', 'installation_date', 'warranty_registered_date'].find((k) => v(k));
  const when = whenKey ? caveat(whenKey, v(whenKey)) : r.docDate;
  const head = [label, num ? `${num}` : null, when ? `dated ${when}` : null, v('technician') ? `by ${v('technician')}` : null].filter(Boolean).join(' ');
  const svc = v('service_type');
  push(`${head}${svc ? ` (${svc})` : ''}${v('status') ? `, status ${v('status')}` : ''}.`, 'invoice_number', 'permit_number', 'service_date', 'installation_date');
  const eq = [v('manufacturer'), v('model')].filter(Boolean).join(' ');
  if (eq || v('serial_number')) push(`Unit: ${eq || 'unit'}${v('serial_number') ? `, serial ${v('serial_number')}` : ''}${v('installation_date') && r.type !== 'startup-sheet' ? `, installed ${caveat('installation_date', v('installation_date'))}` : ''}.`, 'serial_number', 'model', 'manufacturer');
  const work = (r.workItems ?? []).filter(Boolean).join('; ');
  if (work) push(`Work: ${work}.`, 'work_performed');
  else if (v('notes')) push(`Notes: ${v('notes')}`, 'notes');
  if (v('cost') && ['invoice', 'proposal-quote', 'maintenance-agreement'].includes(r.type)) push(`Amount: $${v('cost')}.`, 'cost');
  return out.slice(0, 4);
}
