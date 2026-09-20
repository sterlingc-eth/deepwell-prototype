import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, Check, FileText, GitMerge, Link2, Loader2, MessageSquareText, Pencil, Search, Wrench, X,
} from 'lucide-react';
import { AppShell } from '../components/AppShell';
import { WarrantyStatusBadge, type AlertTier } from '../components/WarrantyStatusBadge';
import { formatYmd, normalize } from '../core/answer';
import { useGraph } from '../core/entityGraph';
import {
  customerClient,
  type CustomerDetail,
  type CustomerPatch,
  type CustomerTimelineEntry,
} from '../services/customerClient';
import { useAppStore } from '../store/appStore';

/** Chronological, most-recent-first — the same ordering rule the API's own
 *  timeline uses (api/_lib/routes/customers.js's `timeline.sort`), applied
 *  again client-side so this stays true even if a future edit here ever
 *  merges in a locally-known entry the server didn't send. Plain string
 *  comparison works because every `date` is either a YYYY-MM-DD day or a
 *  full ISO timestamp, both lexically ordered the same as chronologically. */
export function sortTimelineDesc(entries: CustomerTimelineEntry[]): CustomerTimelineEntry[] {
  return [...entries].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** Raw `documents.stage` values (received/read/mapped/linked/verified) —
 *  NOT the same five-value PipelineStage src/core/types.ts and StagePill use
 *  (that's a client-derived taxonomy from usePostgresSync.ts's deriveStage;
 *  this API returns the backend column as-is), so this screen labels them
 *  itself rather than misusing StagePill on a mismatched enum. */
const STAGE_TEXT: Record<string, string> = {
  received: 'Uploaded', read: 'Read', mapped: 'Sorted', linked: 'Matched', verified: 'Checked',
};

function viaLabel(via: string): string {
  if (via === 'direct') return 'Linked directly';
  if (via === 'name-match') return 'Matched by name';
  if (via === 'equipment') return 'Via equipment';
  if (via.startsWith('equipment:')) return `Via ${via.slice('equipment:'.length)}`;
  return via;
}

const TIMELINE_LABEL: Record<CustomerTimelineEntry['kind'], string> = {
  service: 'Service', install: 'Install', invoice: 'Invoice', warranty: 'Warranty', document: 'Document',
};

interface EditableFieldProps {
  label: string;
  value: string | null;
  placeholder: string;
  onSave: (value: string) => Promise<void>;
}

/** One inline-editable header field (name/address/phone/email) — click to
 *  edit, Enter or the check to save, Escape or the X to cancel. */
function EditableField({ label, value, placeholder, onSave }: EditableFieldProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) setDraft(value ?? '');
  }, [value, editing]);

  const commit = async () => {
    const v = draft.trim();
    setSaving(true);
    setErr(null);
    try {
      await onSave(v);
      setEditing(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save that.');
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="group inline-flex items-center gap-1.5 text-left hover:text-ink"
        aria-label={`Edit ${label}`}
      >
        <span className={value ? '' : 'text-ink-3 italic'}>{value || placeholder}</span>
        <Pencil className="w-3.5 h-3.5 text-ink-3 opacity-0 group-hover:opacity-100" aria-hidden="true" />
      </button>
    );
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <span className="inline-flex items-center gap-1.5">
        <label className="sr-only" htmlFor={`edit-${label}`}>{label}</label>
        <input
          id={`edit-${label}`}
          autoFocus
          className="dw-input !min-h-[36px] !py-1"
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commit();
            if (e.key === 'Escape') { setEditing(false); setDraft(value ?? ''); }
          }}
          disabled={saving}
        />
        <button type="button" className="dw-btn-tertiary !min-h-[36px] !py-1 !px-2" onClick={() => void commit()} disabled={saving} aria-label="Save">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Check className="w-4 h-4" aria-hidden="true" />}
        </button>
        <button type="button" className="dw-btn-tertiary !min-h-[36px] !py-1 !px-2" onClick={() => { setEditing(false); setDraft(value ?? ''); }} disabled={saving} aria-label="Cancel">
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
      </span>
      {err && <span className="text-caption text-warn-ink dark:text-brass-200">{err}</span>}
    </span>
  );
}

type Tab = 'documents' | 'equipment' | 'timeline' | 'notes';
const TABS: { id: Tab; label: string }[] = [
  { id: 'documents', label: 'Documents' },
  { id: 'equipment', label: 'Equipment' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'notes', label: 'Notes' },
];

/**
 * One customer's full record: contact header, stat tiles, and the four tabs
 * the brief asks for. All data comes from GET /api/v1/customer — nothing
 * here reads the local entity graph except "Assign a document" (which
 * searches already-synced documents by filename, the same source
 * BrowseScreen's Documents tab filters).
 */
export function CustomerProfileScreen() {
  const ref = useAppStore((s) => s.customerRef);
  const setCurrentScreen = useAppStore((s) => s.setCurrentScreen);
  const prefillQuestion = useAppStore((s) => s.prefillQuestion);
  const openDocument = useAppStore((s) => s.openDocument);
  const openEntity = useAppStore((s) => s.openEntity);
  const docs = useGraph((s) => s.docs);

  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('documents');

  const reload = useMemo(
    () => async (r: string) => {
      setLoading(true);
      setLoadError(null);
      try {
        const d = await customerClient.getByRef(r);
        setDetail(d);
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : 'Could not load this customer.');
        setDetail(null);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (ref) void reload(ref);
    else { setDetail(null); setLoadError(null); }
  }, [ref, reload]);

  const saveField = (key: keyof CustomerPatch) => async (value: string) => {
    if (!detail) return;
    const updated = await customerClient.update(detail.customer.id, { [key]: value } as CustomerPatch);
    setDetail((d) => (d ? { ...d, customer: { ...d.customer, ...toRecord(updated.customer) } } : d));
  };

  const [notesDraft, setNotesDraft] = useState('');
  const [notesSaving, setNotesSaving] = useState(false);
  const [notesSaved, setNotesSaved] = useState(false);
  useEffect(() => { setNotesDraft(detail?.customer.notes ?? ''); }, [detail?.customer.notes]);
  const saveNotes = async () => {
    if (!detail) return;
    setNotesSaving(true);
    try {
      await customerClient.update(detail.customer.id, { notes: notesDraft });
      setDetail((d) => (d ? { ...d, customer: { ...d.customer, notes: notesDraft } } : d));
      setNotesSaved(true);
      window.setTimeout(() => setNotesSaved(false), 1500);
    } catch {
      /* the input keeps the unsaved draft; a retry click is the recovery */
    } finally {
      setNotesSaving(false);
    }
  };

  // Assign a document: search already-synced documents by filename.
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignQuery, setAssignQuery] = useState('');
  const [assignBusy, setAssignBusy] = useState<string | null>(null);
  const [assignErr, setAssignErr] = useState<string | null>(null);
  const assignCandidates = useMemo(() => {
    const q = normalize(assignQuery);
    const already = new Set((detail?.documents ?? []).map((d) => d.id));
    return Object.values(docs)
      .filter((d) => !already.has(d.id) && (!q || normalize(d.filename).includes(q)))
      .slice(0, 20);
  }, [docs, assignQuery, detail]);
  const runAssign = async (documentId: string) => {
    if (!detail) return;
    setAssignBusy(documentId);
    setAssignErr(null);
    try {
      await customerClient.assignDocument(documentId, detail.customer.id);
      await reload(detail.customer.customerNumber ?? detail.customer.id);
      setAssignOpen(false);
      setAssignQuery('');
    } catch (e) {
      setAssignErr(e instanceof Error ? e.message : 'Could not assign that document.');
    } finally {
      setAssignBusy(null);
    }
  };

  // Merge duplicates: always keeps THIS profile and drops the picked
  // duplicate, so this screen's own id/url never becomes invalid after a
  // merge — see reviewStore.js's mergeCustomers, which always writes the
  // survivor number onto `keepId`.
  const [mergeBusy, setMergeBusy] = useState<string | null>(null);
  const [mergeErr, setMergeErr] = useState<string | null>(null);
  const runMerge = async (dropId: string) => {
    if (!detail) return;
    setMergeBusy(dropId);
    setMergeErr(null);
    try {
      await customerClient.merge(detail.customer.id, dropId);
      await reload(detail.customer.id);
    } catch (e) {
      setMergeErr(e instanceof Error ? e.message : 'Could not merge those customers.');
    } finally {
      setMergeBusy(null);
    }
  };

  if (!ref) {
    return (
      <AppShell width="ask">
        <p className="text-ink-2">No customer selected.</p>
        <button type="button" className="dw-btn-tertiary mt-3" onClick={() => setCurrentScreen('browse')}>
          <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Back to Records
        </button>
      </AppShell>
    );
  }

  if (loading && !detail) {
    return (
      <AppShell width="ask">
        <div className="flex items-center gap-2 text-ink-2"><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Loading customer…</div>
      </AppShell>
    );
  }

  if (loadError || !detail) {
    return (
      <AppShell width="ask">
        <p role="alert" className="text-warn-ink dark:text-brass-200">{loadError ?? "That customer isn't in your records."}</p>
        <button type="button" className="dw-btn-tertiary mt-3" onClick={() => setCurrentScreen('browse')}>
          <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Back to Records
        </button>
      </AppShell>
    );
  }

  const { customer, equipment, documents, duplicates } = detail;
  const timeline = sortTimelineDesc(detail.timeline);
  const nextExpiry = equipment
    .map((u) => u.warranty.expires)
    .filter((d): d is string => !!d)
    .sort()[0];

  return (
    <AppShell>
      <div className="space-y-6">
        <button type="button" onClick={() => setCurrentScreen('browse')} className="dw-btn-tertiary -ml-3">
          <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Back to Records
        </button>

        <header className="space-y-2">
          <p className="dw-label font-mono">{customer.customerNumber ?? 'No number on file'}</p>
          <h1 className="text-h1">
            <EditableField label="Name" value={customer.name} placeholder="Add a name" onSave={saveField('name')} />
          </h1>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-ink-2">
            <EditableField label="Address" value={customer.serviceAddress} placeholder="Add an address" onSave={saveField('serviceAddress')} />
            <EditableField label="Phone" value={customer.phone} placeholder="Add a phone number" onSave={saveField('phone')} />
            <EditableField label="Email" value={customer.email} placeholder="Add an email" onSave={saveField('email')} />
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              className="dw-btn-secondary !min-h-[40px] !py-1.5"
              onClick={() => prefillQuestion(`${customer.customerNumber ?? customer.name ?? ''}: `)}
            >
              <MessageSquareText className="w-4 h-4" aria-hidden="true" /> Ask about this customer
            </button>
            <button type="button" className="dw-btn-tertiary !min-h-[40px] !py-1.5" onClick={() => setAssignOpen((v) => !v)}>
              <Link2 className="w-4 h-4" aria-hidden="true" /> Assign a document
            </button>
          </div>
        </header>

        {assignOpen && (
          <div className="dw-card p-4 space-y-3">
            <h3 className="text-h4">Assign a document to this customer</h3>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-3" aria-hidden="true" />
              <label htmlFor="assign-doc-search" className="sr-only">Search documents by filename</label>
              <input
                id="assign-doc-search"
                className="dw-input !pl-9"
                placeholder="Search by filename…"
                value={assignQuery}
                onChange={(e) => setAssignQuery(e.target.value)}
                autoComplete="off"
              />
            </div>
            {assignErr && <p role="alert" className="text-caption text-warn-ink dark:text-brass-200">{assignErr}</p>}
            <ul className="divide-y divide-line border border-line rounded-lg max-h-64 overflow-y-auto">
              {assignCandidates.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="font-mono text-data truncate">{d.filename}</span>
                  <button type="button" className="dw-btn-tertiary !min-h-[32px] !py-1 shrink-0" disabled={assignBusy === d.id} onClick={() => void runAssign(d.id)}>
                    {assignBusy === d.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : 'Assign'}
                  </button>
                </li>
              ))}
              {assignCandidates.length === 0 && <li className="px-3 py-4 text-center text-ink-3">No matching documents.</li>}
            </ul>
          </div>
        )}

        {duplicates.length > 0 && (
          <div className="dw-card p-4 space-y-3 border-warn/40">
            <h3 className="flex items-center gap-2 text-h4"><AlertTriangle className="w-4 h-4 text-warn" aria-hidden="true" /> Possible duplicate customers</h3>
            <p className="text-body text-ink-2">These look like the same person. Merging keeps this record and moves everything from the other one into it — nothing is double-counted.</p>
            {mergeErr && <p role="alert" className="text-caption text-warn-ink dark:text-brass-200">{mergeErr}</p>}
            <ul className="divide-y divide-line border border-line rounded-lg">
              {duplicates.map((dup) => (
                <li key={dup.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
                  <span className="min-w-0">
                    <span className="font-mono text-data mr-2">{dup.customerNumber ?? '—'}</span>
                    <span className="text-ink">{dup.name ?? 'Unnamed'}</span>
                    <span className="block text-caption text-ink-3">{dup.serviceAddress ?? '—'} · {dup.reason}</span>
                  </span>
                  <button type="button" className="dw-btn-secondary !min-h-[36px] !py-1 shrink-0" disabled={mergeBusy === dup.id} onClick={() => void runMerge(dup.id)}>
                    {mergeBusy === dup.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <GitMerge className="w-3.5 h-3.5" aria-hidden="true" />}
                    Merge into this customer
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <section aria-label="Overview" className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {[
            { label: 'Documents', value: documents.length },
            { label: 'Equipment', value: equipment.length },
            { label: 'Next warranty expiry', value: nextExpiry ? formatYmd(nextExpiry) : 'None on file' },
          ].map((tile) => (
            <div key={tile.label} className="dw-card p-4">
              <p className="text-caption text-ink-3">{tile.label}</p>
              <p className="font-display text-h2 mt-1">{tile.value}</p>
            </div>
          ))}
        </section>

        <div role="tablist" aria-label="Customer detail" className="flex flex-wrap gap-1.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={['dw-btn !min-h-[40px] !py-1.5 !px-3', tab === t.id ? 'bg-forest-700 text-stone-0 dark:bg-brass-300 dark:text-forest-950' : 'bg-surface border border-line text-ink-2 hover:bg-surface-2'].join(' ')}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'documents' && (
          <ul className="divide-y divide-line border border-line rounded-lg bg-surface" aria-label="Documents">
            {documents.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  onClick={() => { openDocument(d.id); setCurrentScreen('review'); }}
                  className="w-full text-left flex flex-wrap items-center gap-3 px-4 py-3 min-h-touch hover:bg-surface-2 transition-colors duration-quick"
                >
                  <FileText className="w-4 h-4 text-ink-3 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-mono text-data text-ink truncate">{d.filename ?? d.id}</span>
                    <span className="block text-caption text-ink-3">{d.type ?? 'Unclassified'} · {STAGE_TEXT[d.stage] ?? d.stage}</span>
                  </span>
                  <span className="dw-pill-muted shrink-0">{viaLabel(d.via)}</span>
                  <span className="text-body text-ink-3 shrink-0 whitespace-nowrap">{d.serviceDate ? formatYmd(d.serviceDate) : d.createdAt ? formatYmd(d.createdAt) : '—'}</span>
                </button>
              </li>
            ))}
            {documents.length === 0 && <li className="px-4 py-8 text-center text-ink-3">No documents linked to this customer yet.</li>}
          </ul>
        )}

        {tab === 'equipment' && (
          <ul className="grid sm:grid-cols-2 gap-3" aria-label="Equipment">
            {equipment.map((u) => (
              <li key={u.id}>
                <button type="button" onClick={() => openEntity(u.id)} className="w-full text-left dw-card p-4 hover:shadow-lift transition-shadow duration-quick">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-mono text-data text-ink flex items-center gap-1.5"><Wrench className="w-3.5 h-3.5 text-ink-3" aria-hidden="true" /> {u.serial ?? 'No serial on file'}</p>
                      <p className="text-body text-ink-2">{[u.manufacturer, u.model].filter(Boolean).join(' ') || 'Unknown unit'}</p>
                    </div>
                    <WarrantyStatusBadge warranty={{ warrantyExpiry: null }} tier={u.warranty.tier as AlertTier} showLabel={false} />
                  </div>
                  <p className="mt-2 text-caption text-ink-3">
                    {u.installDate ? `Installed ${formatYmd(u.installDate)}` : 'No install date on file'}
                    {u.warranty.expires ? ` · Warranty expires ${formatYmd(u.warranty.expires)}` : ''}
                  </p>
                </button>
              </li>
            ))}
            {equipment.length === 0 && <li className="px-4 py-8 text-center text-ink-3 col-span-full dw-card">No equipment linked to this customer yet.</li>}
          </ul>
        )}

        {tab === 'timeline' && (
          <ul className="divide-y divide-line border border-line rounded-lg bg-surface" aria-label="Timeline">
            {timeline.map((e, i) => (
              <li key={`${e.documentId ?? 'x'}-${i}`}>
                {e.documentId ? (
                  <button type="button" onClick={() => { openDocument(e.documentId as string); setCurrentScreen('review'); }} className="w-full text-left flex items-center gap-3 px-4 py-3 min-h-touch hover:bg-surface-2 transition-colors duration-quick">
                    <span className="dw-pill-muted shrink-0 w-24 justify-center">{TIMELINE_LABEL[e.kind]}</span>
                    <span className="min-w-0 flex-1 truncate">{e.title}</span>
                    <span className="text-body text-ink-3 shrink-0 whitespace-nowrap">{formatYmd(e.date)}</span>
                  </button>
                ) : (
                  <div className="flex items-center gap-3 px-4 py-3">
                    <span className="dw-pill-muted shrink-0 w-24 justify-center">{TIMELINE_LABEL[e.kind]}</span>
                    <span className="min-w-0 flex-1 truncate text-ink-2">{e.title}</span>
                    <span className="text-body text-ink-3 shrink-0 whitespace-nowrap">{formatYmd(e.date)}</span>
                  </div>
                )}
              </li>
            ))}
            {timeline.length === 0 && <li className="px-4 py-8 text-center text-ink-3">Nothing on the timeline yet.</li>}
          </ul>
        )}

        {tab === 'notes' && (
          <div className="dw-card p-4 space-y-3">
            <label className="dw-label" htmlFor="customer-notes">Notes</label>
            <textarea
              id="customer-notes"
              className="dw-input min-h-[10rem]"
              value={notesDraft}
              onChange={(e) => setNotesDraft(e.target.value)}
              placeholder="Anything worth remembering about this customer…"
            />
            <div className="flex items-center gap-2">
              <button type="button" className="dw-btn-primary !min-h-[40px] !py-1.5" onClick={() => void saveNotes()} disabled={notesSaving || notesDraft === (customer.notes ?? '')}>
                {notesSaving ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : notesSaved ? <Check className="w-4 h-4" aria-hidden="true" /> : null}
                {notesSaved ? 'Saved' : 'Save notes'}
              </button>
            </div>
          </div>
        )}

        {customer.formerNumbers.length > 0 && (
          <p className="text-caption text-ink-3">Formerly {customer.formerNumbers.join(', ')} — merged into this record.</p>
        )}
      </div>
    </AppShell>
  );
}

/** Pulls just the editable header fields off an updateCustomer response's
 *  raw `entities` row (id, data, customer_number, …) — that shape doesn't
 *  match GET /api/v1/customer's flattened {customerNumber, name, …}, so this
 *  reshapes it rather than trusting the keys line up. customer_number is
 *  never touched by updateCustomer (see reviewStore.js), so it's
 *  deliberately left out here — nothing to merge back in for it. */
function toRecord(row: Record<string, unknown>): { name: string | null; serviceAddress: string | null; phone: string | null; email: string | null; notes: string | null } {
  const data = (row.data ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    name: str(data.customer_name),
    serviceAddress: str(data.service_address),
    phone: str(data.phone),
    email: str(data.email),
    notes: str(data.notes),
  };
}
