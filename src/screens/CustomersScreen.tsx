import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, Loader2, Plus, Search, X } from 'lucide-react';
import { formatYmd } from '../core/answer';
import { customerClient, type CreateCustomerInput, type CustomerSort, type CustomerSummary } from '../services/customerClient';
import { useAppStore } from '../store/appStore';

type SortCol = 'name' | 'recent' | 'docs';
const SORTS: { id: SortCol; label: string }[] = [
  { id: 'recent', label: 'Recent activity' },
  { id: 'name', label: 'Name' },
  { id: 'docs', label: 'Documents' },
];

/**
 * "Customers" tab on Records (BrowseScreen.tsx) — a searchable table backed
 * by GET /api/v1/customers, plus an inline "New customer" form
 * (POST /api/review action createCustomer). Rendered without its own
 * AppShell, same as ReviewScreen.tsx's exported ReviewBody: the parent tab
 * owns the page chrome.
 */
export function CustomersScreen() {
  const openCustomer = useAppStore((s) => s.openCustomer);

  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [sort, setSort] = useState<SortCol>('recent');
  const [rows, setRows] = useState<CustomerSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(query.trim()), 200);
    return () => window.clearTimeout(t);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void customerClient
      .list({ q: debounced || undefined, sort: sort as CustomerSort, limit: 200 })
      .then((data) => { if (!cancelled) setRows(data); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load customers.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [debounced, sort]);

  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<CreateCustomerInput>({ name: '' });
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);

  const runCreate = async () => {
    if (!draft.name.trim()) return;
    setCreateBusy(true);
    setCreateErr(null);
    try {
      const { customer } = await customerClient.create({
        name: draft.name.trim(),
        serviceAddress: draft.serviceAddress?.trim() || undefined,
        phone: draft.phone?.trim() || undefined,
        email: draft.email?.trim() || undefined,
      });
      setCreating(false);
      setDraft({ name: '' });
      openCustomer(customer.id);
    } catch (e) {
      setCreateErr(e instanceof Error ? e.message : 'Could not create that customer.');
    } finally {
      setCreateBusy(false);
    }
  };

  const shown = useMemo(() => rows, [rows]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[16rem]">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-ink-3" aria-hidden="true" />
          <label htmlFor="customer-search-input" className="sr-only">Search customers</label>
          <input
            id="customer-search-input"
            className="dw-input !pl-12"
            placeholder="Search by name, address, phone, or email…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
          />
        </div>
        <button type="button" className="dw-btn-primary shrink-0" onClick={() => setCreating((v) => !v)}>
          <Plus className="w-4 h-4" aria-hidden="true" /> New customer
        </button>
      </div>

      {creating && (
        <div className="dw-card p-4 space-y-3">
          <h3 className="text-h4">New customer</h3>
          {createErr && <p role="alert" className="text-caption text-warn-ink dark:text-brass-200">{createErr}</p>}
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className="dw-label" htmlFor="new-cust-name">Name</label>
              <input id="new-cust-name" className="dw-input" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} autoFocus />
            </div>
            <div>
              <label className="dw-label" htmlFor="new-cust-address">Address</label>
              <input id="new-cust-address" className="dw-input" value={draft.serviceAddress ?? ''} onChange={(e) => setDraft((d) => ({ ...d, serviceAddress: e.target.value }))} />
            </div>
            <div>
              <label className="dw-label" htmlFor="new-cust-phone">Phone</label>
              <input id="new-cust-phone" className="dw-input" value={draft.phone ?? ''} onChange={(e) => setDraft((d) => ({ ...d, phone: e.target.value }))} />
            </div>
            <div>
              <label className="dw-label" htmlFor="new-cust-email">Email</label>
              <input id="new-cust-email" className="dw-input" value={draft.email ?? ''} onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className="dw-btn-primary" disabled={!draft.name.trim() || createBusy} onClick={() => void runCreate()}>
              {createBusy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Plus className="w-4 h-4" aria-hidden="true" />} Create
            </button>
            <button type="button" className="dw-btn-tertiary" onClick={() => { setCreating(false); setCreateErr(null); }}>
              <X className="w-4 h-4" aria-hidden="true" /> Cancel
            </button>
          </div>
        </div>
      )}

      <div role="tablist" aria-label="Sort customers" className="flex flex-wrap gap-1.5">
        {SORTS.map((s) => (
          <button
            key={s.id}
            role="tab"
            aria-selected={sort === s.id}
            onClick={() => setSort(s.id)}
            className={['dw-btn !min-h-[36px] !py-1 !px-3 text-body', sort === s.id ? 'bg-forest-700 text-stone-0 dark:bg-brass-300 dark:text-forest-950' : 'bg-surface border border-line text-ink-2 hover:bg-surface-2'].join(' ')}
          >
            {sort === s.id ? <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" /> : <ChevronUp className="w-3.5 h-3.5 opacity-0" aria-hidden="true" />} {s.label}
          </button>
        ))}
      </div>

      {error && <p role="alert" className="text-body text-warn-ink dark:text-brass-200">{error}</p>}

      <div className="overflow-x-auto border border-line rounded-lg bg-surface">
        <table className="w-full text-left text-body">
          <thead>
            <tr className="border-b border-line text-caption text-ink-3">
              <th className="px-3 py-2">Number</th>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Address</th>
              <th className="px-3 py-2 text-right">Docs</th>
              <th className="px-3 py-2 text-right">Equipment</th>
              <th className="px-3 py-2">Last activity</th>
              <th className="px-3 py-2 text-right">Alerts</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {shown.map((c) => (
              <tr key={c.id} className="hover:bg-surface-2 cursor-pointer" onClick={() => openCustomer(c.id)}>
                <td className="px-3 py-2 align-top font-mono text-data">{c.customerNumber ?? '—'}</td>
                <td className="px-3 py-2 align-top">
                  <button type="button" className="text-ink underline decoration-line-2 underline-offset-4 hover:decoration-forest-700 text-left" onClick={(ev) => { ev.stopPropagation(); openCustomer(c.id); }}>
                    {c.name ?? 'Unnamed'}
                  </button>
                </td>
                <td className="px-3 py-2 align-top text-ink-2">{c.serviceAddress ?? '—'}</td>
                <td className="px-3 py-2 align-top text-right">{c.documentCount}</td>
                <td className="px-3 py-2 align-top text-right">{c.equipmentCount}</td>
                <td className="px-3 py-2 align-top text-ink-2 whitespace-nowrap">{c.lastActivity ? formatYmd(c.lastActivity) : '—'}</td>
                <td className="px-3 py-2 align-top text-right">
                  {c.warrantyAlerts > 0 ? (
                    <span className="dw-pill-warn inline-flex"><AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" /> {c.warrantyAlerts}</span>
                  ) : (
                    <span className="text-ink-3">—</span>
                  )}
                </td>
              </tr>
            ))}
            {!loading && shown.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-ink-3">
                  {debounced ? 'No customers match this search.' : 'No customers yet. They appear automatically as documents come in, or add one above.'}
                </td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-ink-3">
                  <Loader2 className="w-4 h-4 animate-spin inline mr-2" aria-hidden="true" /> Loading customers…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-caption text-ink-3">{shown.length} customer{shown.length === 1 ? '' : 's'}{shown.length === 200 ? ' (first 200)' : ''}</p>
    </div>
  );
}
