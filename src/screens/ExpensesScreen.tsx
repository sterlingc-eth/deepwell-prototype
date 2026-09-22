import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Download, Loader2, Pencil, Plus, Receipt, Sparkles, Trash2, X } from 'lucide-react';
import { AppShell } from '../components/AppShell';
import { useAppStore } from '../store/appStore';
import {
  EXPENSE_CATEGORIES,
  addExpense,
  deleteExpense,
  exportExpensesCsv,
  extractReceipt,
  fetchExpenseTotals,
  fetchExpensesOperatorStatus,
  listExpenses,
  requestReceiptUploadUrl,
  seedInitialExpenses,
  updateExpense,
  uploadReceiptBytes,
  type ExpenseCategory,
  type ExpenseFieldsInput,
  type ExpenseRangeKind,
  type ExpenseRow,
  type ExpenseTotals,
} from '../services/expensesClient';

/**
 * Owners-only expense tracker (handoffs/EXPENSES_2026-09-22.md): DeepWell's
 * own business expenses — never a tenant's data, never reachable by one.
 * Reached from AppShell's "Expenses" nav item, which only renders once the
 * server has confirmed isPlatformOperator (App.tsx fetches that once on
 * sign-in). This screen ALSO checks it itself on mount, the same
 * self-guarding idiom DonovanLearningCard.tsx uses for a card instead of a
 * screen — a deep link (`?screen=expenses`, or public/expense-tracker.html's
 * redirect) can land here before that App.tsx-level fetch has resolved, and
 * every actual data call is 403'd server-side regardless, so this is belt
 * and suspenders, not the real boundary.
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

const EMPTY_DRAFT: ExpenseFieldsInput = {
  occurredOn: new Date().toISOString().slice(0, 10),
  vendor: '',
  amount: '',
  category: 'Other',
  note: '',
};

const CATEGORY_BAR_COLORS = [
  'bg-forest-700', 'bg-brass-300', 'bg-info-ink', 'bg-ok-ink', 'bg-warn-ink',
  'bg-bad-ink', 'bg-ink-3', 'bg-forest-800', 'bg-forest-500', 'bg-ink-2', 'bg-line-2',
];

export function ExpensesScreen() {
  const setCurrentScreen = useAppStore((s) => s.setCurrentScreen);

  const [checked, setChecked] = useState(false);
  const [isOperator, setIsOperator] = useState(false);

  const [range, setRange] = useState<ExpenseRangeKind>('ytd');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  const [items, setItems] = useState<ExpenseRow[] | null>(null);
  const [totals, setTotals] = useState<ExpenseTotals | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [draft, setDraft] = useState<ExpenseFieldsInput>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<ExpenseFieldsInput | null>(null);

  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [receiptBusy, setReceiptBusy] = useState(false);
  const [receiptKey, setReceiptKey] = useState<string | null>(null);
  const [receiptFilename, setReceiptFilename] = useState<string | null>(null);

  const [seeding, setSeeding] = useState(false);
  const [exporting, setExporting] = useState(false);

  const rangeArgs = useMemo(
    () => (range === 'custom' ? { range, from: customFrom || undefined, to: customTo || undefined } : { range }),
    [range, customFrom, customTo]
  );

  useEffect(() => {
    fetchExpensesOperatorStatus()
      .then((r) => setIsOperator(r.isOperator))
      .catch(() => setIsOperator(false))
      .finally(() => setChecked(true));
  }, []);

  const load = () => {
    if (!isOperator) return;
    setLoading(true);
    setError(null);
    Promise.all([listExpenses(rangeArgs), fetchExpenseTotals(rangeArgs)])
      .then(([l, t]) => {
        setItems(l.items);
        setTotals(t);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load expenses.'))
      .finally(() => setLoading(false));
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [isOperator, range, customFrom, customTo]);

  if (checked && !isOperator) {
    return (
      <AppShell>
        <div className="max-w-content mx-auto py-16 text-center space-y-4">
          <p className="text-body-lg text-ink">This page is restricted to DeepWell platform operators.</p>
          <button type="button" className="dw-btn-secondary" onClick={() => setCurrentScreen('ask')}>
            <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Back
          </button>
        </div>
      </AppShell>
    );
  }

  const resetAddForm = () => {
    setDraft(EMPTY_DRAFT);
    setReceiptFile(null);
    setReceiptKey(null);
    setReceiptFilename(null);
  };

  const submitAdd = async () => {
    setSaving(true);
    setError(null);
    try {
      await addExpense({ ...draft, receiptKey: receiptKey ?? undefined, receiptFilename: receiptFilename ?? undefined, source: receiptKey ? 'receipt' : 'manual' });
      resetAddForm();
      setShowAddForm(false);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save this expense.');
    } finally {
      setSaving(false);
    }
  };

  const onReceiptFileChosen = async (file: File) => {
    setReceiptFile(file);
    setReceiptBusy(true);
    setError(null);
    try {
      const { receiptKey: key, uploadUrl } = await requestReceiptUploadUrl(file.name, file.type || 'application/octet-stream');
      await uploadReceiptBytes(uploadUrl, file);
      const { draft: extracted } = await extractReceipt(key, file.type || 'application/octet-stream');
      setReceiptKey(key);
      setReceiptFilename(file.name);
      setDraft((prev) => ({
        ...prev,
        vendor: extracted.vendor || prev.vendor,
        occurredOn: extracted.occurredOn ?? prev.occurredOn,
        amountCents: extracted.amountCents ?? undefined,
        amount: extracted.amountCents == null ? prev.amount : undefined,
        category: (extracted.category as ExpenseCategory) ?? prev.category,
      }));
      setShowAddForm(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read this receipt.');
    } finally {
      setReceiptBusy(false);
    }
  };

  const startEdit = (row: ExpenseRow) => {
    setEditingId(row.id);
    setEditDraft({
      occurredOn: row.occurred_on,
      vendor: row.vendor,
      amountCents: row.amount_cents,
      category: row.category,
      note: row.note ?? '',
      receiptKey: row.receipt_key,
      receiptFilename: row.receipt_filename,
    });
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
      setError(e instanceof Error ? e.message : 'Could not save changes.');
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
      setError(e instanceof Error ? e.message : 'Could not delete this expense.');
    }
  };

  const doSeed = async () => {
    setSeeding(true);
    setError(null);
    try {
      await seedInitialExpenses();
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not seed starter entries.');
    } finally {
      setSeeding(false);
    }
  };

  const doExport = async () => {
    setExporting(true);
    setError(null);
    try {
      await exportExpensesCsv(rangeArgs);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not export CSV.');
    } finally {
      setExporting(false);
    }
  };

  const maxCategoryCents = totals?.byCategory[0]?.totalCents ?? 0;

  return (
    <AppShell>
      <div className="space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <h1 className="text-h2 text-ink flex items-center gap-2">
            <Receipt className="w-5 h-5" aria-hidden="true" /> Expenses
          </h1>
          <div className="flex items-center gap-2">
            <button type="button" className="dw-btn-secondary" disabled={exporting} onClick={() => void doExport()}>
              {exporting ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Download className="w-4 h-4" aria-hidden="true" />}
              Export CSV
            </button>
            <button
              type="button"
              className="dw-btn-primary"
              onClick={() => {
                resetAddForm();
                setShowAddForm((v) => !v);
              }}
            >
              <Plus className="w-4 h-4" aria-hidden="true" /> Add expense
            </button>
          </div>
        </div>

        {error && <p role="alert" className="text-body text-bad-ink">{error}</p>}

        {/* Range toggle */}
        <div className="flex items-center gap-2 flex-wrap">
          {(['month', 'year', 'ytd', 'custom'] as ExpenseRangeKind[]).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={r === range ? 'dw-btn-primary !min-h-[36px] !py-1' : 'dw-btn-secondary !min-h-[36px] !py-1'}
            >
              {RANGE_LABEL[r]}
            </button>
          ))}
          {range === 'custom' && (
            <span className="flex items-center gap-2">
              <input type="date" className="dw-input !min-h-[36px] !py-1 w-auto" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
              <span className="text-ink-3">to</span>
              <input type="date" className="dw-input !min-h-[36px] !py-1 w-auto" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
            </span>
          )}
        </div>

        {/* Add expense form */}
        {showAddForm && (
          <div className="dw-card p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-body font-medium text-ink">New expense</h2>
              <button type="button" onClick={() => setShowAddForm(false)} className="text-ink-3 hover:text-ink" aria-label="Close">
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>

            <label className="block space-y-1">
              <span className="dw-label">Add from receipt</span>
              <input
                type="file"
                accept="application/pdf,image/jpeg,image/png,image/gif,image/webp"
                disabled={receiptBusy}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onReceiptFileChosen(f);
                }}
                className="block text-body text-ink-2"
              />
              {receiptBusy && (
                <span className="flex items-center gap-1.5 text-caption text-ink-3">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> Reading receipt…
                </span>
              )}
              {receiptFile && !receiptBusy && receiptKey && (
                <span className="flex items-center gap-1.5 text-caption text-ok-ink">
                  <Sparkles className="w-3.5 h-3.5" aria-hidden="true" /> Prefilled from {receiptFile.name} — review before saving.
                </span>
              )}
            </label>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block space-y-1">
                <span className="dw-label">Date</span>
                <input type="date" className="dw-input" value={draft.occurredOn} onChange={(e) => setDraft({ ...draft, occurredOn: e.target.value })} />
              </label>
              <label className="block space-y-1">
                <span className="dw-label">Vendor</span>
                <input type="text" className="dw-input" value={draft.vendor} onChange={(e) => setDraft({ ...draft, vendor: e.target.value })} />
              </label>
              <label className="block space-y-1">
                <span className="dw-label">Amount</span>
                <input
                  type="text"
                  className="dw-input"
                  placeholder="21.66"
                  value={draft.amountCents != null ? (draft.amountCents / 100).toFixed(2) : (draft.amount ?? '')}
                  onChange={(e) => setDraft({ ...draft, amount: e.target.value, amountCents: undefined })}
                />
              </label>
              <label className="block space-y-1">
                <span className="dw-label">Category</span>
                <select className="dw-input" value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value as ExpenseCategory })}>
                  {EXPENSE_CATEGORIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1 sm:col-span-2">
                <span className="dw-label">Note</span>
                <input type="text" className="dw-input" value={draft.note ?? ''} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
              </label>
            </div>

            <button type="button" className="dw-btn-primary" disabled={saving} onClick={() => void submitAdd()}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : null} Save expense
            </button>
          </div>
        )}

        {/* Totals */}
        {totals && (
          <div className="dw-card p-4 space-y-4">
            <div className="flex items-baseline justify-between">
              <h2 className="text-body font-medium text-ink">Totals — {RANGE_LABEL[range]}</h2>
              <span className="text-h3 text-ink">{centsToDisplay(totals.grandTotalCents)}</span>
            </div>
            <div className="space-y-2">
              {totals.byCategory.length === 0 && <p className="text-body text-ink-3">No expenses in this range.</p>}
              {totals.byCategory.map((c, i) => (
                <div key={c.category} className="flex items-center gap-3">
                  <span className="w-40 shrink-0 text-caption text-ink-2 truncate">{c.category}</span>
                  <div className="flex-1 h-3 rounded-full bg-surface-2 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${CATEGORY_BAR_COLORS[i % CATEGORY_BAR_COLORS.length]}`}
                      style={{ width: maxCategoryCents ? `${Math.max(2, (c.totalCents / maxCategoryCents) * 100)}%` : '0%' }}
                    />
                  </div>
                  <span className="w-24 shrink-0 text-caption text-ink text-right">{centsToDisplay(c.totalCents)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Seed button */}
        {items && items.length === 0 && !loading && (
          <div className="dw-card p-4 flex items-center justify-between flex-wrap gap-2">
            <p className="text-body text-ink-3">No expenses recorded yet.</p>
            <button type="button" className="dw-btn-secondary" disabled={seeding} onClick={() => void doSeed()}>
              {seeding ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : null} Seed starter entries
            </button>
          </div>
        )}

        {/* Table */}
        <div className="dw-card overflow-x-auto">
          {loading && <p className="p-4 text-body text-ink-3 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Loading…</p>}
          {!loading && items && items.length > 0 && (
            <table className="w-full text-body">
              <thead>
                <tr className="text-left text-caption text-ink-3 uppercase border-b border-line">
                  <th className="p-3">Date</th>
                  <th className="p-3">Vendor</th>
                  <th className="p-3">Amount</th>
                  <th className="p-3">Category</th>
                  <th className="p-3">Note</th>
                  <th className="p-3">Receipt</th>
                  <th className="p-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {items.map((row) =>
                  editingId === row.id && editDraft ? (
                    <tr key={row.id}>
                      <td className="p-2"><input type="date" className="dw-input !min-h-[36px] !py-1" value={editDraft.occurredOn} onChange={(e) => setEditDraft({ ...editDraft, occurredOn: e.target.value })} /></td>
                      <td className="p-2"><input type="text" className="dw-input !min-h-[36px] !py-1" value={editDraft.vendor} onChange={(e) => setEditDraft({ ...editDraft, vendor: e.target.value })} /></td>
                      <td className="p-2">
                        <input
                          type="text"
                          className="dw-input !min-h-[36px] !py-1 w-24"
                          value={editDraft.amountCents != null ? (editDraft.amountCents / 100).toFixed(2) : (editDraft.amount ?? '')}
                          onChange={(e) => setEditDraft({ ...editDraft, amount: e.target.value, amountCents: undefined })}
                        />
                      </td>
                      <td className="p-2">
                        <select className="dw-input !min-h-[36px] !py-1" value={editDraft.category} onChange={(e) => setEditDraft({ ...editDraft, category: e.target.value as ExpenseCategory })}>
                          {EXPENSE_CATEGORIES.map((c) => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </select>
                      </td>
                      <td className="p-2"><input type="text" className="dw-input !min-h-[36px] !py-1" value={editDraft.note ?? ''} onChange={(e) => setEditDraft({ ...editDraft, note: e.target.value })} /></td>
                      <td className="p-2 text-caption text-ink-3">{row.receipt_filename ?? '—'}</td>
                      <td className="p-2 flex items-center gap-1.5 justify-end">
                        <button type="button" className="dw-btn-tertiary !min-h-[32px] !py-0.5" disabled={saving} onClick={() => void saveEdit()}>Save</button>
                        <button type="button" className="dw-btn-tertiary !min-h-[32px] !py-0.5" onClick={() => { setEditingId(null); setEditDraft(null); }}>Cancel</button>
                      </td>
                    </tr>
                  ) : (
                    <tr key={row.id}>
                      <td className="p-3 whitespace-nowrap">{row.occurred_on}</td>
                      <td className="p-3">{row.vendor}</td>
                      <td className="p-3 whitespace-nowrap">{centsToDisplay(row.amount_cents, row.currency)}</td>
                      <td className="p-3"><span className="dw-pill-muted">{row.category}</span></td>
                      <td className="p-3 text-ink-2 max-w-xs truncate" title={row.note ?? ''}>{row.note ?? ''}</td>
                      <td className="p-3 text-ink-2">{row.receipt_filename ?? '—'}</td>
                      <td className="p-3">
                        <div className="flex items-center gap-1.5 justify-end">
                          <button type="button" className="dw-btn-tertiary !min-h-[32px] !py-0.5" onClick={() => startEdit(row)} aria-label="Edit">
                            <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                          <button type="button" className="dw-btn-tertiary !min-h-[32px] !py-0.5" onClick={() => void removeRow(row.id)} aria-label="Delete">
                            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </AppShell>
  );
}
