import { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, ChevronDown, ChevronRight, Download, ExternalLink, Loader2, Paperclip, Pencil, Plus, Receipt, Sparkles, Trash2, Upload, X } from 'lucide-react';
import {
  EXPENSE_CATEGORIES,
  addExpense,
  deleteExpense,
  exportExpensesCsv,
  extractReceipt,
  fetchExpenseTotals,
  fetchMonthlyLog,
  fetchReceiptViewUrl,
  listExpenses,
  requestReceiptUploadUrl,
  seedInitialExpenses,
  updateExpense,
  uploadReceiptBytes,
  type ExpenseCategory,
  type ExpenseExportScope,
  type ExpenseFieldsInput,
  type ExpenseMonthlyLog,
  type ExpenseRangeKind,
  type ExpenseRow,
  type ExpenseTotals,
} from '../services/expensesClient';

/**
 * DeepWell's own business expenses — rendered ONLY by the standalone
 * expenses site (expenses/index.html -> src/expenses/main.tsx), never by the
 * customer app. The site gates on the server-confirmed operator status
 * before mounting this; every data call is also 403'd server-side for a
 * non-operator (api/_lib/routes/expenses.js), so that gate is the UX, not the
 * security boundary.
 */
function centsToDisplay(cents: number, currency = 'USD'): string {
  const n = cents / 100;
  return n.toLocaleString('en-US', { style: 'currency', currency });
}

const RANGE_LABEL: Record<ExpenseRangeKind, string> = {
  month: 'This month',
  year: 'This year',
  ytd: 'Year to date',
  custom: 'Custom',
};

const CATEGORY_BAR_COLORS = [
  'bg-forest-700', 'bg-brass-300', 'bg-info-ink', 'bg-ok-ink', 'bg-warn-ink',
  'bg-bad-ink', 'bg-ink-3', 'bg-forest-800', 'bg-forest-500', 'bg-ink-2', 'bg-line-2',
];


const RECEIPT_TYPE_RE = /^(application\/pdf|image\/(jpeg|png|gif|webp))$/;
const MAX_RECEIPT_BYTES = 24 * 1024 * 1024;
const FILE_ACCEPT = 'image/*,application/pdf';

function unsupportedReason(file: File): string | null {
  if (RECEIPT_TYPE_RE.test(file.type)) {
    return file.size > MAX_RECEIPT_BYTES ? 'This file is over 24 MB. Try a smaller photo or PDF.' : null;
  }
  const heic = /heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name);
  return heic
    ? "HEIC photos can't be read. Re-save it as a JPG or PDF (on iPhone: Settings > Camera > Formats > Most Compatible), then add it again."
    : 'This file type is not supported. Use a JPG, PNG, WebP or PDF.';
}

function newDraft(): ExpenseFieldsInput {
  return { occurredOn: new Date().toISOString().slice(0, 10), vendor: '', amount: '', category: 'Other', note: '' };
}

function monthLabel(ym: string): string {
  const [y = 1970, m = 1] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function rowToFields(row: ExpenseRow): ExpenseFieldsInput {
  return {
    occurredOn: row.occurred_on,
    vendor: row.vendor,
    amountCents: row.amount_cents,
    category: row.category,
    note: row.note ?? '',
    receiptKey: row.receipt_key,
    receiptFilename: row.receipt_filename,
    source: row.source,
  };
}

/** The editable fields, shared by the add form, the review queue and inline edit. */
function ExpenseFields({ draft, onChange }: { draft: ExpenseFieldsInput; onChange: (d: ExpenseFieldsInput) => void }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <label className="block space-y-1">
        <span className="dw-label">Date</span>
        <input type="date" className="dw-input" value={draft.occurredOn} onChange={(e) => onChange({ ...draft, occurredOn: e.target.value })} />
      </label>
      <label className="block space-y-1">
        <span className="dw-label">Vendor</span>
        <input type="text" className="dw-input" value={draft.vendor} onChange={(e) => onChange({ ...draft, vendor: e.target.value })} />
      </label>
      <label className="block space-y-1">
        <span className="dw-label">Amount (USD)</span>
        <input
          type="text"
          inputMode="decimal"
          className="dw-input"
          placeholder="21.66"
          value={draft.amountCents != null ? (draft.amountCents / 100).toFixed(2) : (draft.amount ?? '')}
          onChange={(e) => onChange({ ...draft, amount: e.target.value, amountCents: undefined })}
        />
      </label>
      <label className="block space-y-1">
        <span className="dw-label">Category</span>
        <select className="dw-input" value={draft.category} onChange={(e) => onChange({ ...draft, category: e.target.value as ExpenseCategory })}>
          {EXPENSE_CATEGORIES.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </label>
      <label className="block space-y-1 sm:col-span-2">
        <span className="dw-label">Note</span>
        <input type="text" className="dw-input" value={draft.note ?? ''} onChange={(e) => onChange({ ...draft, note: e.target.value })} />
      </label>
    </div>
  );
}

interface QueueItem {
  id: string;
  file: File;
  status: 'waiting' | 'uploading' | 'reading' | 'ready' | 'saving' | 'error';
  message?: string;
  draft: ExpenseFieldsInput;
}

const QUEUE_STATUS_LABEL: Record<QueueItem['status'], string> = {
  waiting: 'Waiting…',
  uploading: 'Uploading…',
  reading: 'Reading receipt…',
  ready: 'Ready to review',
  saving: 'Saving…',
  error: 'Needs attention',
};

interface ListActions {
  editingId: string | null;
  editDraft: ExpenseFieldsInput | null;
  saving: boolean;
  viewingId: string | null;
  attachingId: string | null;
  onEdit: (row: ExpenseRow) => void;
  onEditChange: (d: ExpenseFieldsInput) => void;
  onEditSave: () => void;
  onEditCancel: () => void;
  onDelete: (id: string) => void;
  onView: (id: string) => void;
  onAttach: (row: ExpenseRow, file: File) => void;
}

/** One list used everywhere (all-expenses view and each month's expansion) —
 *  stacks on a phone, aligns in columns from md up. */
function ExpenseList({ rows, a }: { rows: ExpenseRow[]; a: ListActions }) {
  return (
    <ul className="divide-y divide-line">
      {rows.map((row) =>
        a.editingId === row.id && a.editDraft ? (
          <li key={row.id} className="p-3 space-y-3">
            <ExpenseFields draft={a.editDraft} onChange={a.onEditChange} />
            <div className="flex items-center gap-2">
              <button type="button" className="dw-btn-primary" disabled={a.saving} onClick={a.onEditSave}>
                {a.saving ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : null} Save
              </button>
              <button type="button" className="dw-btn-secondary" onClick={a.onEditCancel}>Cancel</button>
            </div>
          </li>
        ) : (
          <li key={row.id} className="p-3 grid grid-cols-[1fr_auto] md:grid-cols-[6.5rem_1fr_7rem_auto] gap-x-3 gap-y-1 items-start">
            <span className="text-caption text-ink-3 whitespace-nowrap md:pt-0.5">{row.occurred_on}</span>
            <span className="text-body text-ink text-right md:order-3 md:text-right font-medium whitespace-nowrap">{centsToDisplay(row.amount_cents, row.currency)}</span>
            <div className="col-span-2 md:col-span-1 md:order-2 min-w-0 space-y-1">
              <p className="text-body text-ink break-words">{row.vendor}</p>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="dw-pill-muted">{row.category}</span>
                {row.note && <span className="text-caption text-ink-2 break-words">{row.note}</span>}
              </div>
            </div>
            <div className="col-span-2 md:col-span-1 md:order-4 flex items-center gap-1.5 flex-wrap md:justify-end">
              {row.receipt_key ? (
                <button type="button" className="dw-btn-tertiary !min-h-[36px] !py-0.5" disabled={a.viewingId === row.id} onClick={() => a.onView(row.id)} title={row.receipt_filename ?? 'Receipt'}>
                  {a.viewingId === row.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />} View
                </button>
              ) : null}
              <label className={`dw-btn-tertiary !min-h-[36px] !py-0.5 cursor-pointer ${a.attachingId === row.id ? 'opacity-60 pointer-events-none' : ''}`}>
                {a.attachingId === row.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Paperclip className="w-3.5 h-3.5" aria-hidden="true" />}
                {row.receipt_key ? 'Replace' : 'Attach receipt'}
                <input
                  type="file"
                  accept={FILE_ACCEPT}
                  className="sr-only"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (f) a.onAttach(row, f);
                  }}
                />
              </label>
              <button type="button" className="dw-btn-tertiary !min-h-[36px] !py-0.5" onClick={() => a.onEdit(row)} aria-label={`Edit ${row.vendor}`}>
                <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
              <button type="button" className="dw-btn-tertiary !min-h-[36px] !py-0.5" onClick={() => a.onDelete(row.id)} aria-label={`Delete ${row.vendor}`}>
                <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </div>
            {row.receipt_filename && <span className="col-span-2 md:col-start-2 md:order-5 text-caption text-ink-3 truncate">Receipt: {row.receipt_filename}</span>}
          </li>
        )
      )}
    </ul>
  );
}

export function ExpensesScreen() {
  const thisYear = new Date().getUTCFullYear();
  const [view, setView] = useState<'log' | 'all'>('log');
  const [year, setYear] = useState(thisYear);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [range, setRange] = useState<ExpenseRangeKind>('ytd');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  const [items, setItems] = useState<ExpenseRow[] | null>(null);
  const [totals, setTotals] = useState<ExpenseTotals | null>(null);
  const [monthly, setMonthly] = useState<ExpenseMonthlyLog | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [draft, setDraft] = useState<ExpenseFieldsInput>(newDraft);
  const [saving, setSaving] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<ExpenseFieldsInput | null>(null);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [attachingId, setAttachingId] = useState<string | null>(null);

  const [queue, setQueue] = useState<QueueItem[]>([]);
  const removedRef = useRef<Set<string>>(new Set());
  const pendingRef = useRef<{ id: string; file: File }[]>([]);
  const runningRef = useRef(false);

  const [seeding, setSeeding] = useState(false);
  const [exporting, setExporting] = useState(false);

  const rangeArgs = useMemo(
    () => (range === 'custom' ? { range, from: customFrom || undefined, to: customTo || undefined } : { range }),
    [range, customFrom, customTo]
  );

  const load = () => {
    setLoading(true);
    setError(null);
    const p =
      view === 'log'
        ? fetchMonthlyLog(year).then((m) => setMonthly(m))
        : Promise.all([listExpenses(rangeArgs), fetchExpenseTotals(rangeArgs)]).then(([l, t]) => {
            setItems(l.items);
            setTotals(t);
          });
    p.catch((e) => setError(e instanceof Error ? e.message : 'Could not load expenses.')).finally(() => setLoading(false));
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [view, year, range, customFrom, customTo]);

  const fail = (e: unknown, fallback: string) => setError(e instanceof Error ? e.message : fallback);

  /* ---- manual add ---- */

  const submitAdd = async () => {
    setSaving(true);
    setError(null);
    try {
      await addExpense({ ...draft, source: 'manual' });
      setDraft(newDraft());
      setShowAddForm(false);
      load();
    } catch (e) {
      fail(e, 'Could not save this expense.');
    } finally {
      setSaving(false);
    }
  };

  /* ---- receipt capture: sequential upload + extract into a review queue ---- */

  const patchQueue = (id: string, p: Partial<QueueItem>) => setQueue((q) => q.map((i) => (i.id === id ? { ...i, ...p } : i)));

  const processQueue = async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    try {
      while (pendingRef.current.length > 0) {
        const { id, file } = pendingRef.current.shift()!;
        if (removedRef.current.has(id)) continue;
        try {
          patchQueue(id, { status: 'uploading' });
          const type = file.type;
          const { receiptKey, uploadUrl } = await requestReceiptUploadUrl(file.name, type);
          await uploadReceiptBytes(uploadUrl, file);
          const base = { receiptKey, receiptFilename: file.name, source: 'receipt' as const };
          if (removedRef.current.has(id)) continue;
          patchQueue(id, { status: 'reading', draft: { ...newDraft(), ...base } });
          try {
            const { draft: x } = await extractReceipt(receiptKey, type);
            setQueue((q) =>
              q.map((i) =>
                i.id !== id
                  ? i
                  : {
                      ...i,
                      status: 'ready',
                      draft: {
                        ...i.draft,
                        vendor: x.vendor || '',
                        occurredOn: x.occurredOn ?? i.draft.occurredOn,
                        amountCents: x.amountCents ?? undefined,
                        amount: '',
                        category: (x.category as ExpenseCategory) ?? 'Other',
                      },
                    }
              )
            );
          } catch {
            patchQueue(id, { status: 'ready', message: "Couldn't read this receipt automatically. The file is saved; fill in the details below." });
          }
        } catch (e) {
          patchQueue(id, { status: 'error', message: e instanceof Error ? e.message : 'Upload failed.' });
        }
      }
    } finally {
      runningRef.current = false;
    }
  };

  const enqueueFiles = (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setShowAddForm(true);
    const entries: QueueItem[] = list.map((file) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const reason = unsupportedReason(file);
      if (!reason) pendingRef.current.push({ id, file });
      return { id, file, status: reason ? 'error' : 'waiting', message: reason ?? undefined, draft: newDraft() };
    });
    setQueue((q) => [...q, ...entries]);
    void processQueue();
  };

  const skipQueueItem = (id: string) => {
    removedRef.current.add(id);
    setQueue((q) => q.filter((i) => i.id !== id));
  };

  const saveQueueItem = async (item: QueueItem) => {
    patchQueue(item.id, { status: 'saving', message: undefined });
    try {
      await addExpense(item.draft);
      setQueue((q) => q.filter((i) => i.id !== item.id));
      load();
    } catch (e) {
      patchQueue(item.id, { status: 'ready', message: e instanceof Error ? e.message : 'Could not save this expense.' });
    }
  };

  /* ---- existing rows ---- */

  const attachReceipt = async (row: ExpenseRow, file: File) => {
    const reason = unsupportedReason(file);
    if (reason) return setError(reason);
    setAttachingId(row.id);
    setError(null);
    try {
      const { receiptKey, uploadUrl } = await requestReceiptUploadUrl(file.name, file.type);
      await uploadReceiptBytes(uploadUrl, file);
      await updateExpense(row.id, { ...rowToFields(row), receiptKey, receiptFilename: file.name });
      load();
    } catch (e) {
      fail(e, 'Could not attach this receipt.');
    } finally {
      setAttachingId(null);
    }
  };

  const viewReceipt = async (id: string) => {
    setViewingId(id);
    setError(null);
    // Open the tab synchronously so a popup blocker allows it, then point it at the signed URL.
    const w = window.open('', '_blank');
    try {
      const { url } = await fetchReceiptViewUrl(id);
      if (w) {
        w.opener = null;
        w.location.href = url;
      } else {
        window.location.href = url;
      }
    } catch (e) {
      w?.close();
      fail(e, 'Could not open this receipt.');
    } finally {
      setViewingId(null);
    }
  };

  const saveEdit = async () => {
    if (!editingId || !editDraft) return;
    setSaving(true);
    setError(null);
    try {
      await updateExpense(editingId, editDraft);
      setEditingId(null);
      setEditDraft(null);
      load();
    } catch (e) {
      fail(e, 'Could not save changes.');
    } finally {
      setSaving(false);
    }
  };

  const removeRow = async (id: string) => {
    if (!window.confirm('Delete this expense? This cannot be undone.')) return;
    setError(null);
    try {
      await deleteExpense(id);
      load();
    } catch (e) {
      fail(e, 'Could not delete this expense.');
    }
  };

  const doSeed = async () => {
    setSeeding(true);
    setError(null);
    try {
      await seedInitialExpenses();
      load();
    } catch (e) {
      fail(e, 'Could not seed starter entries.');
    } finally {
      setSeeding(false);
    }
  };

  const doExport = async (scope: ExpenseExportScope, filename: string) => {
    setExporting(true);
    setError(null);
    try {
      await exportExpensesCsv(scope, filename);
    } catch (e) {
      fail(e, 'Could not export CSV.');
    } finally {
      setExporting(false);
    }
  };

  const toggleMonth = (m: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(m)) next.delete(m);
      else next.add(m);
      return next;
    });

  const actions: ListActions = {
    editingId,
    editDraft,
    saving,
    viewingId,
    attachingId,
    onEdit: (row) => { setEditingId(row.id); setEditDraft(rowToFields(row)); },
    onEditChange: setEditDraft,
    onEditSave: () => void saveEdit(),
    onEditCancel: () => { setEditingId(null); setEditDraft(null); },
    onDelete: (id) => void removeRow(id),
    onView: (id) => void viewReceipt(id),
    onAttach: (row, file) => void attachReceipt(row, file),
  };

  const maxCategoryCents = totals?.byCategory[0]?.totalCents ?? 0;
  const yearOptions = Array.from({ length: 6 }, (_, i) => thisYear - i);
  const isEmpty = view === 'log' ? monthly !== null && monthly.months.length === 0 : items !== null && items.length === 0;
  const queueActive = queue.filter((i) => i.status === 'waiting' || i.status === 'uploading' || i.status === 'reading').length;

  return (
    <>
      <div className="space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <h1 className="text-h2 text-ink flex items-center gap-2">
            <Receipt className="w-5 h-5" aria-hidden="true" /> Expenses
          </h1>
          <div className="flex items-center gap-2 flex-wrap">
            <label className="dw-btn-secondary cursor-pointer sm:hidden">
              <Camera className="w-4 h-4" aria-hidden="true" /> Snap receipt
              <input
                type="file"
                accept={FILE_ACCEPT}
                capture="environment"
                className="sr-only"
                onChange={(e) => {
                  if (e.target.files) enqueueFiles(e.target.files);
                  e.target.value = '';
                }}
              />
            </label>
            <button
              type="button"
              className="dw-btn-primary"
              onClick={() => {
                setDraft(newDraft());
                setShowAddForm((v) => !v);
              }}
            >
              <Plus className="w-4 h-4" aria-hidden="true" /> Add expense
            </button>
          </div>
        </div>

        {error && <p role="alert" className="text-body text-bad-ink">{error}</p>}

        {/* Add: receipts (one or many) and/or manual entry */}
        {(showAddForm || queue.length > 0) && (
          <div className="dw-card p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-body font-medium text-ink">Add expenses</h2>
              <button type="button" onClick={() => setShowAddForm(false)} className="text-ink-3 hover:text-ink p-2 -m-2" aria-label="Close">
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <label className="dw-btn-secondary cursor-pointer">
                <Camera className="w-4 h-4" aria-hidden="true" /> Take photo
                <input
                  type="file"
                  accept={FILE_ACCEPT}
                  capture="environment"
                  className="sr-only"
                  onChange={(e) => {
                    if (e.target.files) enqueueFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
              </label>
              <label className="dw-btn-secondary cursor-pointer">
                <Upload className="w-4 h-4" aria-hidden="true" /> Upload receipts
                <input
                  type="file"
                  accept={FILE_ACCEPT}
                  multiple
                  className="sr-only"
                  onChange={(e) => {
                    if (e.target.files) enqueueFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
              </label>
              <span className="text-caption text-ink-3">Pick several at once. Each is read for you to review; nothing saves until you confirm.</span>
            </div>

            {queue.length > 0 && (
              <div className="space-y-3">
                <p className="text-caption text-ink-3" aria-live="polite">
                  {queueActive > 0 ? `Processing receipts: ${queue.length - queueActive} of ${queue.length} ready…` : `${queue.length} to review`}
                </p>
                {queue.map((item, idx) => (
                  <div key={item.id} className="rounded-lg border border-line p-3 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-caption text-ink-2 truncate">{idx + 1}. {item.file.name}</span>
                      <span className={`text-caption whitespace-nowrap flex items-center gap-1.5 ${item.status === 'error' ? 'text-bad-ink' : item.status === 'ready' ? 'text-ok-ink' : 'text-ink-3'}`}>
                        {(item.status === 'uploading' || item.status === 'reading' || item.status === 'saving') && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
                        {item.status === 'ready' && <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />}
                        {QUEUE_STATUS_LABEL[item.status]}
                      </span>
                    </div>
                    {item.message && <p className={`text-caption ${item.status === 'error' ? 'text-bad-ink' : 'text-warn-ink'}`}>{item.message}</p>}
                    {(item.status === 'ready' || item.status === 'saving') && (
                      <>
                        <ExpenseFields draft={item.draft} onChange={(d) => patchQueue(item.id, { draft: d })} />
                        <div className="flex items-center gap-2">
                          <button type="button" className="dw-btn-primary" disabled={item.status === 'saving'} onClick={() => void saveQueueItem(item)}>Save</button>
                          <button type="button" className="dw-btn-secondary" disabled={item.status === 'saving'} onClick={() => skipQueueItem(item.id)}>Skip</button>
                        </div>
                      </>
                    )}
                    {item.status === 'error' && (
                      <button type="button" className="dw-btn-secondary" onClick={() => skipQueueItem(item.id)}>Dismiss</button>
                    )}
                    {(item.status === 'waiting' || item.status === 'uploading' || item.status === 'reading') && (
                      <button type="button" className="dw-btn-tertiary" onClick={() => skipQueueItem(item.id)}>Skip</button>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="border-t border-line pt-4 space-y-3">
              <h3 className="text-caption text-ink-3 uppercase">Or enter one by hand</h3>
              <ExpenseFields draft={draft} onChange={setDraft} />
              <button type="button" className="dw-btn-primary" disabled={saving} onClick={() => void submitAdd()}>
                {saving ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : null} Save expense
              </button>
            </div>
          </div>
        )}

        {/* View toggle */}
        <div className="flex items-center gap-2 flex-wrap">
          <button type="button" onClick={() => setView('log')} className={view === 'log' ? 'dw-btn-primary !min-h-[36px] !py-1' : 'dw-btn-secondary !min-h-[36px] !py-1'}>Monthly log</button>
          <button type="button" onClick={() => setView('all')} className={view === 'all' ? 'dw-btn-primary !min-h-[36px] !py-1' : 'dw-btn-secondary !min-h-[36px] !py-1'}>All expenses</button>
        </div>

        {/* Empty state */}
        {isEmpty && !loading && (
          <div className="dw-card p-5 space-y-3">
            <h2 className="text-body font-medium text-ink">{view === 'log' ? `No expenses logged in ${year}` : 'No expenses in this range'}</h2>
            <p className="text-body text-ink-2">
              To start your log: tap Add expense, then take a photo of a receipt or upload several at once. DeepWell reads the vendor, date and total for you to
              confirm, and the receipt stays attached for tax time. Each month builds up here automatically, and you can export any month or the whole year as a CSV.
            </p>
            <button type="button" className="dw-btn-secondary" disabled={seeding} onClick={() => void doSeed()}>
              {seeding ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : null} Seed starter entries
            </button>
          </div>
        )}
        {loading && <p className="text-body text-ink-3 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Loading…</p>}

        {/* Monthly log */}
        {view === 'log' && monthly && monthly.months.length > 0 && (
          <div className="space-y-3">
            <div className="dw-card p-4 flex items-center justify-between flex-wrap gap-3">
              <div>
                <label className="flex items-center gap-2">
                  <span className="dw-label">Year</span>
                  <select className="dw-input !min-h-[36px] !py-1 w-auto" value={year} onChange={(e) => setYear(Number(e.target.value))}>
                    {yearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
                  </select>
                </label>
                <p className="text-h3 text-ink mt-2">{centsToDisplay(monthly.yearTotalCents)}</p>
                <p className="text-caption text-ink-3">{monthly.yearCount} expense{monthly.yearCount === 1 ? '' : 's'} in {monthly.year}</p>
              </div>
              <button type="button" className="dw-btn-secondary" disabled={exporting} onClick={() => void doExport({ year: String(year) }, `deepwell-expenses-${year}.csv`)}>
                {exporting ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Download className="w-4 h-4" aria-hidden="true" />} Export {year} CSV
              </button>
            </div>

            {monthly.months.map((m) => {
              const open = expanded.has(m.month);
              return (
                <div key={m.month} className="dw-card overflow-hidden">
                  <button type="button" className="w-full text-left p-4 flex items-start gap-3" aria-expanded={open} onClick={() => toggleMonth(m.month)}>
                    {open ? <ChevronDown className="w-4 h-4 mt-1 shrink-0" aria-hidden="true" /> : <ChevronRight className="w-4 h-4 mt-1 shrink-0" aria-hidden="true" />}
                    <span className="flex-1 min-w-0 space-y-1">
                      <span className="flex items-baseline justify-between gap-3">
                        <span className="text-body font-medium text-ink">{monthLabel(m.month)}</span>
                        <span className="text-body text-ink font-medium whitespace-nowrap">{centsToDisplay(m.totalCents)}</span>
                      </span>
                      <span className="block text-caption text-ink-3">{m.count} expense{m.count === 1 ? '' : 's'}</span>
                      <span className="flex flex-wrap gap-x-3 gap-y-1">
                        {m.topCategories.map((c) => (
                          <span key={c.category} className="text-caption text-ink-2">{c.category} {centsToDisplay(c.totalCents)}</span>
                        ))}
                      </span>
                    </span>
                  </button>
                  {open && (
                    <div className="border-t border-line">
                      <ExpenseList rows={m.items} a={actions} />
                      <div className="p-3 border-t border-line">
                        <button type="button" className="dw-btn-secondary" disabled={exporting} onClick={() => void doExport({ month: m.month }, `deepwell-expenses-${m.month}.csv`)}>
                          <Download className="w-4 h-4" aria-hidden="true" /> Export {monthLabel(m.month)} CSV
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {view === 'log' && monthly && monthly.months.length === 0 && !loading && (
          <label className="flex items-center gap-2">
            <span className="dw-label">Year</span>
            <select className="dw-input !min-h-[36px] !py-1 w-auto" value={year} onChange={(e) => setYear(Number(e.target.value))}>
              {yearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </label>
        )}

        {/* All expenses */}
        {view === 'all' && (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              {(['month', 'year', 'ytd', 'custom'] as ExpenseRangeKind[]).map((r) => (
                <button key={r} type="button" onClick={() => setRange(r)} className={r === range ? 'dw-btn-primary !min-h-[36px] !py-1' : 'dw-btn-secondary !min-h-[36px] !py-1'}>
                  {RANGE_LABEL[r]}
                </button>
              ))}
              {range === 'custom' && (
                <span className="flex items-center gap-2 flex-wrap">
                  <input type="date" className="dw-input !min-h-[36px] !py-1 w-auto" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} aria-label="From date" />
                  <span className="text-ink-3">to</span>
                  <input type="date" className="dw-input !min-h-[36px] !py-1 w-auto" value={customTo} onChange={(e) => setCustomTo(e.target.value)} aria-label="To date" />
                </span>
              )}
              <button type="button" className="dw-btn-secondary !min-h-[36px] !py-1 sm:ml-auto" disabled={exporting} onClick={() => void doExport(rangeArgs, 'deepwell-expenses.csv')}>
                {exporting ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Download className="w-4 h-4" aria-hidden="true" />} Export CSV
              </button>
            </div>

            {totals && totals.byCategory.length > 0 && (
              <div className="dw-card p-4 space-y-4">
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="text-body font-medium text-ink">Totals: {RANGE_LABEL[range]}</h2>
                  <span className="text-h3 text-ink">{centsToDisplay(totals.grandTotalCents)}</span>
                </div>
                <div className="space-y-2">
                  {totals.byCategory.map((c, i) => (
                    <div key={c.category} className="flex items-center gap-3">
                      <span className="w-28 sm:w-40 shrink-0 text-caption text-ink-2 truncate" title={c.category}>{c.category}</span>
                      <div className="flex-1 h-3 rounded-full bg-surface-2 overflow-hidden">
                        <div
                          className={`h-full rounded-full ${CATEGORY_BAR_COLORS[i % CATEGORY_BAR_COLORS.length]}`}
                          style={{ width: maxCategoryCents ? `${Math.max(2, (c.totalCents / maxCategoryCents) * 100)}%` : '0%' }}
                        />
                      </div>
                      <span className="w-20 sm:w-24 shrink-0 text-caption text-ink text-right">{centsToDisplay(c.totalCents)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {items && items.length > 0 && !loading && (
              <div className="dw-card overflow-hidden">
                <ExpenseList rows={items} a={actions} />
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
