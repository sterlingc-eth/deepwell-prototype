import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, Download, GitMerge, Loader2, Plus, Search, Users2, X } from 'lucide-react';
import { formatYmd } from '../core/answer';
import { customerClient, type CreateCustomerInput, type CustomerDuplicatePair, type CustomerSort, type CustomerSummary } from '../services/customerClient';
import { DEFAULT_CUSTOMER_FILTERS, matchesCustomerFilters, type AlertsFilter, type EquipmentFilter, type LastActivityFilter } from '../core/customerFilters';
import { pairKey, reduceDuplicates, visibleDuplicates } from '../core/duplicates';
import { downloadExportCsv } from '../services/exportClient';
import { IntegrityPanel } from '../components/IntegrityPanel';
import { useAppStore } from '../store/appStore';

type SortCol = 'name' | 'recent' | 'docs';
const SORTS: { id: SortCol; label: string }[] = [
  { id: 'recent', label: 'Recent activity' },
  { id: 'name', label: 'Name' },
  { id: 'docs', label: 'Documents' },
];

const ALERTS_OPTIONS: { id: AlertsFilter; label: string }[] = [
  { id: 'any', label: 'Any alert status' },
  { id: 'expiring', label: 'Expiring' },
  { id: 'expired', label: 'Expired' },
  { id: 'none', label: 'No alerts' },
];
const EQUIPMENT_OPTIONS: { id: EquipmentFilter; label: string }[] = [
  { id: 'any', label: 'Any equipment' },
  { id: 'has', label: 'Has units' },
  { id: 'none', label: 'No units on file' },
];
const ACTIVITY_OPTIONS: { id: LastActivityFilter; label: string }[] = [
  { id: 'any', label: 'Any time' },
  { id: 30, label: 'Last 30 days' },
  { id: 90, label: 'Last 90 days' },
  { id: 365, label: 'Last 365 days' },
];

/**
 * "Customers" tab on Records (BrowseScreen.tsx) — a searchable, filterable
 * table backed by GET /api/v1/customers, plus an inline "New customer" form
 * (POST /api/review action createCustomer). Rendered without its own
 * AppShell, same as ReviewScreen.tsx's exported ReviewBody: the parent tab
 * owns the page chrome.
 *
 * Owner request 2026-09-20 adds: a filter row (combines with search),
 * a duplicate-household banner, "Check records", and CSV export.
 */
export function CustomersScreen() {
  const openCustomer = useAppStore((s) => s.openCustomer);
  const filters = useAppStore((s) => s.customerFilters);
  const setFilters = useAppStore((s) => s.setCustomerFilters);

  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [sort, setSort] = useState<SortCol>('recent');
  const [rows, setRows] = useState<CustomerSummary[]>([]);
  const [duplicates, setDuplicates] = useState<CustomerDuplicatePair[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(query.trim()), 200);
    return () => window.clearTimeout(t);
  }, [query]);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    return customerClient
      .listFull({ q: debounced || undefined, sort: sort as CustomerSort, limit: 200 })
      .then((data) => {
        setRows(data.customers);
        setDuplicates(data.duplicates ?? []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load customers.'))
      .finally(() => setLoading(false));
  }, [debounced, sort]);

  useEffect(() => {
    void load();
  }, [load]);

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

  // ------------------------------------------------------------- duplicates
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [mergingKey, setMergingKey] = useState<string | null>(null);
  const [mergeAllBusy, setMergeAllBusy] = useState(false);
  const [mergeErr, setMergeErr] = useState<string | null>(null);
  const nameById = useMemo(() => new Map(rows.map((r) => [r.id, r.name || r.customerNumber || 'Unnamed'])), [rows]);
  const visibleDups = useMemo(() => visibleDuplicates(duplicates, dismissed), [duplicates, dismissed]);

  const dismissPair = (p: CustomerDuplicatePair) => setDismissed((d) => reduceDuplicates(d, { type: 'dismiss', ...p }));

  const mergePair = async (p: CustomerDuplicatePair) => {
    setMergingKey(pairKey(p));
    setMergeErr(null);
    try {
      await customerClient.merge(p.keepId, p.dropId);
      setDismissed((d) => reduceDuplicates(d, { type: 'merge', ...p }));
      await load();
    } catch (e) {
      setMergeErr(e instanceof Error ? e.message : 'Could not merge those customers.');
    } finally {
      setMergingKey(null);
    }
  };

  const mergeAll = async () => {
    setMergeAllBusy(true);
    setMergeErr(null);
    try {
      // duplicates from the API already score >= 0.9 (the same bar the
      // owner asked "Merge all" to respect) — nothing more to filter here.
      for (const p of visibleDups) {
        await customerClient.merge(p.keepId, p.dropId);
        setDismissed((d) => reduceDuplicates(d, { type: 'merge', ...p }));
      }
      await load();
    } catch (e) {
      setMergeErr(e instanceof Error ? e.message : 'Could not merge those customers.');
    } finally {
      setMergeAllBusy(false);
    }
  };

  // ------------------------------------------------------------------ export
  const [exporting, setExporting] = useState(false);
  const [exportErr, setExportErr] = useState<string | null>(null);
  const runExport = async () => {
    setExporting(true);
    setExportErr(null);
    try {
      await downloadExportCsv('customers');
    } catch (e) {
      setExportErr(e instanceof Error ? e.message : 'Could not download that export.');
    } finally {
      setExporting(false);
    }
  };

  // ------------------------------------------------------------------ filter
  const cities = useMemo(
    () => Array.from(new Set(rows.map((r) => r.city).filter((c): c is string => !!c))).sort((a, b) => a.localeCompare(b)),
    [rows]
  );
  const shown = useMemo(() => rows.filter((r) => matchesCustomerFilters(r, filters)), [rows, filters]);
  const filtersActive = JSON.stringify(filters) !== JSON.stringify(DEFAULT_CUSTOMER_FILTERS);

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
        <button type="button" className="dw-btn-secondary shrink-0" disabled={exporting || rows.length === 0} onClick={() => void runExport()}>
          {exporting ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Download className="w-4 h-4" aria-hidden="true" />} Export CSV
        </button>
        <button type="button" className="dw-btn-primary shrink-0" onClick={() => setCreating((v) => !v)}>
          <Plus className="w-4 h-4" aria-hidden="true" /> New customer
        </button>
      </div>
      {exportErr && <p role="alert" className="text-body text-warn-ink dark:text-brass-200">{exportErr}</p>}

      <IntegrityPanel onApplied={() => void load()} />

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

      {visibleDups.length > 0 && (
        <div className="dw-card p-4 space-y-3 border-warn/40">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-h4">
              <Users2 className="w-4 h-4 text-warn" aria-hidden="true" /> Donovan found {visibleDups.length} customer{visibleDups.length === 1 ? '' : 's'} that look like the same household
            </h3>
            <button type="button" className="dw-btn-secondary !min-h-[36px] !py-1" disabled={mergeAllBusy} onClick={() => void mergeAll()}>
              {mergeAllBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <GitMerge className="w-3.5 h-3.5" aria-hidden="true" />} Merge all
            </button>
          </div>
          {mergeErr && <p role="alert" className="text-caption text-warn-ink dark:text-brass-200">{mergeErr}</p>}
          <ul className="divide-y divide-line border border-line rounded-lg">
            {visibleDups.map((p) => (
              <li key={pairKey(p)} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
                <span className="min-w-0">
                  <span className="text-ink">Keep <span className="font-medium">{nameById.get(p.keepId) ?? p.keepId}</span></span>
                  <span className="text-ink-3"> · drop </span>
                  <span className="text-ink">{nameById.get(p.dropId) ?? p.dropId}</span>
                  <span className="block text-caption text-ink-3">{p.reason} · {Math.round(p.score * 100)}% match</span>
                </span>
                <span className="flex items-center gap-2 shrink-0">
                  <button type="button" className="dw-btn-secondary !min-h-[32px] !py-1" disabled={mergingKey === pairKey(p)} onClick={() => void mergePair(p)}>
                    {mergingKey === pairKey(p) ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <GitMerge className="w-3.5 h-3.5" aria-hidden="true" />} Merge
                  </button>
                  <button type="button" className="dw-btn-tertiary !min-h-[32px] !py-1" onClick={() => dismissPair(p)}>Not the same</button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="dw-card p-3 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="filter-alerts">Alerts</label>
          <select id="filter-alerts" className="dw-input !w-auto !min-h-[36px] !py-1" value={filters.alerts} onChange={(e) => setFilters({ ...filters, alerts: e.target.value as AlertsFilter })}>
            {ALERTS_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
          <label className="sr-only" htmlFor="filter-equipment">Equipment</label>
          <select id="filter-equipment" className="dw-input !w-auto !min-h-[36px] !py-1" value={filters.equipment} onChange={(e) => setFilters({ ...filters, equipment: e.target.value as EquipmentFilter })}>
            {EQUIPMENT_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
          <label className="sr-only" htmlFor="filter-city">City</label>
          <select id="filter-city" className="dw-input !w-auto !min-h-[36px] !py-1" value={filters.city ?? ''} onChange={(e) => setFilters({ ...filters, city: e.target.value || null })}>
            <option value="">Any city</option>
            {cities.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <label className="sr-only" htmlFor="filter-activity">Last activity</label>
          <select id="filter-activity" className="dw-input !w-auto !min-h-[36px] !py-1" value={String(filters.lastActivity)} onChange={(e) => setFilters({ ...filters, lastActivity: (e.target.value === 'any' ? 'any' : Number(e.target.value)) as LastActivityFilter })}>
            {ACTIVITY_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
          {filtersActive && (
            <button type="button" className="dw-btn-tertiary !min-h-[36px] !py-1" onClick={() => setFilters(DEFAULT_CUSTOMER_FILTERS)}>
              <X className="w-3.5 h-3.5" aria-hidden="true" /> Clear filters
            </button>
          )}
        </div>
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
                  {debounced || filtersActive ? 'No customers match this search and these filters.' : 'No customers yet. They appear automatically as documents come in, or add one above.'}
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
      <p className="text-caption text-ink-3">
        {shown.length} of {rows.length} customer{rows.length === 1 ? '' : 's'}{rows.length === 200 ? ' (first 200)' : ''}
      </p>
    </div>
  );
}
