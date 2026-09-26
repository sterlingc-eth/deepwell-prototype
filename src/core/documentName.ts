import type { Doc } from './types';

/**
 * The ONE place the UI decides what to call a document (round 12 contract).
 * Priority: server display_name (documents.display_name, set after classification) →
 * a client-derived name from the classified type + key extracted fields → the original filename.
 * Every screen/component that shows a document title must call documentName(doc) and may show
 * the original filename as secondary text via originalFilename(doc).
 */
export function documentName(doc: Pick<Doc, 'filename' | 'typeId' | 'extracted'> & { displayName?: string | null }): string {
  const server = typeof doc.displayName === 'string' ? doc.displayName.trim() : '';
  if (server) return server;
  const derived = deriveName(doc);
  return derived ?? doc.filename;
}

/** True when the title shown differs from the uploaded filename (so the UI can show the filename underneath). */
export function hasFriendlyName(doc: Pick<Doc, 'filename' | 'typeId' | 'extracted'> & { displayName?: string | null }): boolean {
  return documentName(doc) !== doc.filename;
}

export function originalFilename(doc: Pick<Doc, 'filename'>): string {
  return doc.filename;
}

/**
 * Mirrors api/_lib/naming/engine.js's TYPE_LABELS/segmentsFor — a smaller subset (no linked-entity
 * fallback, since this runs before a round trip could supply one), used only until the SERVER's
 * displayName arrives (or forever, on a database that hasn't applied migration 41). The two are
 * not required to produce byte-identical strings; documentName() always prefers server data.
 */
const TYPE_LABELS: Record<string, string> = {
  invoice: 'Invoice',
  'work-order': 'Work order',
  'service-ticket': 'Service ticket',
  'service-report': 'Service report',
  'dispatch-note': 'Dispatch note',
  'inspection-report': 'Inspection report',
  'startup-sheet': 'Startup sheet',
  'warranty-registration': 'Warranty',
  'warranty-certificate': 'Warranty',
  warranty: 'Warranty',
  'maintenance-agreement': 'Maintenance agreement',
  'proposal-quote': 'Quote',
  'purchase-order': 'Purchase order',
  permit: 'Permit',
  'nameplate-photo': 'Nameplate photo',
  'equipment-record': 'Equipment record',
  'install-record': 'Install record',
  correspondence: 'Correspondence',
  internal: 'Shop record',
};

const MAX_LEN = 70;

function typeLabel(typeId: string | null | undefined): string | null {
  if (!typeId) return null;
  if (TYPE_LABELS[typeId]) return TYPE_LABELS[typeId];
  if (typeId === 'other') return null;
  const words = typeId.replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : null;
}

function field(doc: Pick<Doc, 'extracted'>, ...keys: string[]): string | null {
  for (const key of keys) {
    const f = (doc.extracted ?? []).find((x) => x.name === key && String(x.correctedValue ?? x.value ?? "").trim() !== "");
    if (f) return String(f.correctedValue ?? f.value).trim();
  }
  return null;
}

function shortDate(value: string | null): string | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (m) {
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  }
  const monthOnly = /^(\d{4})-(\d{2})$/.exec(value);
  if (monthOnly) {
    const d = new Date(Date.UTC(Number(monthOnly[1]), Number(monthOnly[2]) - 1, 1));
    return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  }
  return value.length <= 12 ? value : null;
}

function formatMoney(value: string | null): string | null {
  if (!value) return null;
  const n = Number(String(value).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n)) return null;
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}$${abs}`;
}

/** "Carol Rios" -> "Rios" — used only where brevity beats a full name (maintenance agreements,
 *  matching api/_lib/naming/engine.js's own choice there). */
function surname(name: string | null): string | null {
  if (!name) return null;
  const words = name.trim().split(/\s+/);
  return words[words.length - 1] ?? null;
}

/** Drops trailing segments (never the label) until the name fits MAX_LEN; hard-truncates as a
 *  last resort. Same shape as engine.js's assembleWithTruncation, kept independent (no shared
 *  import — this file must stay a plain client module with no api/_lib dependency). */
function assembleWithTruncation(segments: (string | null)[]): string | null {
  const clean = segments.filter((s): s is string => !!s && s.trim() !== '');
  if (clean.length < 2) return null;
  // Never collapses below "label + one detail" — see engine.js's own assembleWithTruncation for
  // why the search stops at keep >= 2 instead of falling through to a label-only result.
  for (let keep = clean.length; keep >= 2; keep--) {
    const candidate = clean.slice(0, keep).join(' · ');
    if (candidate.length <= MAX_LEN) return candidate;
  }
  const joined = clean.slice(0, 2).join(' · ');
  return `${joined.slice(0, MAX_LEN - 1)}…`;
}

function deriveName(doc: Pick<Doc, 'typeId' | 'extracted'>): string | null {
  const label = typeLabel(doc.typeId);
  if (!label) return null;
  const who = field(doc, 'customer_name', 'customer', 'vendor_name');
  const address = field(doc, 'service_address', 'address');
  const equipment = [field(doc, 'manufacturer', 'brand'), field(doc, 'model', 'model_number')].filter(Boolean).join(' ') || null;
  const cost = formatMoney(field(doc, 'cost', 'total'));
  const invoiceNumber = field(doc, 'invoice_number');
  const permitNumber = field(doc, 'permit_number');
  const when = shortDate(field(doc, 'service_date', 'installation_date', 'install_date', 'invoice_date', 'date'));

  switch (doc.typeId) {
    case 'invoice':
    case 'purchase-order':
      return assembleWithTruncation([invoiceNumber ? `${label} #${invoiceNumber}` : label, who, cost, when]);
    case 'permit':
      return assembleWithTruncation([permitNumber ? `${label} #${permitNumber}` : label, address ?? who, when]);
    case 'work-order':
    case 'inspection-report':
      return assembleWithTruncation([label, address ?? who, when]);
    case 'warranty-registration':
    case 'warranty-certificate':
    case 'warranty':
    case 'startup-sheet':
    case 'equipment-record':
    case 'nameplate-photo':
      return assembleWithTruncation([label, who, equipment, when]);
    case 'maintenance-agreement':
      return assembleWithTruncation([label, surname(who), when]);
    case 'proposal-quote':
      return assembleWithTruncation([label, who, cost, when]);
    default:
      return assembleWithTruncation([label, who, equipment, when]);
  }
}
