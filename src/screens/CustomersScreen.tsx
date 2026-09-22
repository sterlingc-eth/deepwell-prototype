import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Download, GitMerge, Loader2, Plus, Search, Users2, X } from 'lucide-react';
import { formatYmd } from '../core/answer';
import { customerClient, CustomerAddressConflictError, type CreateCustomerInput, type CustomerDuplicatePair, type CustomerSummary } from '../services/customerClient';
import {
  ACTIVITY_OPTIONS,
  ALERTS_OPTIONS,
  CUSTOMER_SORT_OPTIONS,
  DEFAULT_CUSTOMER_FILTERS,
  EQUIPMENT_OPTIONS,
  alertsTooltip,
  cityOptions,
  defaultSortDirection,
  describeActiveFilters,
  matchesCustomerFilters,
  matchesSearch,
  sortCustomers,
  type AlertsFilter,
  type CustomerFilters,
  type CustomerSortBy,
  type CustomerSortDirection,
  type EquipmentFilter,
  type LastActivityFilter,
} from '../core/customerFilters';
import { defaultKeepId, pairKey, reduceDuplicates, visibleDuplicates } from '../core/duplicates';
import { downloadExportCsv } from '../services/exportClient';
import { IntegrityPanel } from '../components/IntegrityPanel';
import { Tooltip } from '../components/Tooltip';
import { useAppStore } from '../store/appStore';

/** A "Sort:" header cell's clickable label + ▲/▼ direction indicator.
 *  `aria-sort` belongs on the enclosing `<th>` (WAI-ARIA table sort
 *  pattern), not here — the caller sets it. */
function SortHeaderButton({
  label, active, dir, onClick, align = 'left',
}: { label: string; active: boolean; dir: CustomerSortDirection; onClick: () => void; align?: 'left' | 'right' }) {
  return (
    <button
      type="button"
      className={[
        'inline-flex items-center gap-1 font-medium hover:text-ink',
        align === 'right' ? 'flex-row-reverse' : '',
        active ? 'text-ink' : 'text-ink-3',
      ].join(' ')}
      onClick={onClick}
    >
      {label}
      <span aria-hidden="true" className="inline-block w-2.5 text-[10px] leading-none">
        {active ? (dir === 'asc' ? '▲' : '▼') : ''}
      </span>
    </button>
  );
}

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

  // Search, the four filter dropdowns, and sort are three independent pieces
  // of state on purpose (owner requirement: "changing a filter must never
  // reset the search text or the sort") — none of the handlers below ever
  // touches more than one of them.
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<CustomerSortBy>('recent');
  const [sortDir, setSortDir] = useState<CustomerSortDirection>('desc');
  const [rows, setRows] = useState<CustomerSummary[]>([]);
  const [duplicates, setDuplicates] = useState<CustomerDuplicatePair[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Every dropdown, the search box, and sort all operate client-side over
  // this one fetched page (see core/customerFilters.ts's file comment) — the
  // full semantics (phone/email in search, a padded "C-3" match, surname
  // sort, per-tier alert breakdown) need real app logic no ILIKE query can
  // do, and this screen already caps at 200 rows either way. So there is
  // exactly one network fetch, on mount and after anything that changes the
  // underlying data (create/merge) — never on a keystroke or a filter change.
  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    return customerClient
      .listFull({ sort: 'recent', limit: 200 })
      .then((data) => {
        setRows(data.customers);
        setDuplicates(data.duplicates ?? []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load customers.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<CreateCustomerInput>({ name: '' });
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  // Owner defect report (2026-09-22): "Add customer" used to create a second
  // record outright at an address that already had one on file — this is the
  // "A customer already exists at this address: <name> — Open it / Add
  // anyway" prompt (api/_lib/reviewStore.js's createCustomer 409).
  const [addressConflict, setAddressConflict] = useState<{ id: string; name: string | null } | null>(null);

  const runCreate = async (confirmDuplicate = false) => {
    if (!draft.name.trim()) return;
    setCreateBusy(true);
    setCreateErr(null);
    setAddressConflict(null);
    try {
      const { customer } = await customerClient.create({
        name: draft.name.trim(),
        serviceAddress: draft.serviceAddress?.trim() || undefined,
        phone: draft.phone?.trim() || undefined,
        email: draft.email?.trim() || undefined,
        confirmDuplicate,
      });
      setCreating(false);
      setDraft({ name: '' });
      openCustomer(customer.id);
    } catch (e) {
      if (e instanceof CustomerAddressConflictError) {
        setAddressConflict({ id: e.existingCustomerId, name: e.existingCustomerName });
      } else {
        setCreateErr(e instanceof Error ? e.message : 'Could not create that customer.');
      }
    } finally {
      setCreateBusy(false);
    }
  };

  // ------------------------------------------------------------- duplicates
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [mergingKey, setMergingKey] = useState<string | null>(null);
  const [mergeAllBusy, setMergeAllBusy] = useState(false);
  const [mergeErr, setMergeErr] = useState<string | null>(null);
  // Which side of each pair the person picked to keep, overriding the
  // fuller-name default below (owner feedback 2026-09-20: "give me an
  // option on which account to merge into the other"). Keyed by pairKey.
  const [chosenKeep, setChosenKeep] = useState<Record<string, string>>({});
  const customerById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const visibleDups = useMemo(() => visibleDuplicates(duplicates, dismissed), [duplicates, dismissed]);
  // "Merge all" only ever sweeps the tier the backend would also auto-merge
  // unattended (owner "strict rules" follow-up 2026-09-20) — a suggest-tier
  // pair (e.g. matching name/address but phone confirmed on only one side)
  // always waits for a person to look at it individually.
  const autoDups = useMemo(() => visibleDups.filter((p) => p.tier === 'auto'), [visibleDups]);

  /** The id to keep for this pair: the person's explicit pick if they made
   *  one, else the fuller-name default (more name tokens; tie -> lower
   *  customer number — same rule the backend's nightly auto-merge uses). */
  const keepIdFor = (p: CustomerDuplicatePair): string => {
    const picked = chosenKeep[pairKey(p)];
    if (picked === p.keepId || picked === p.dropId) return picked;
    const a = customerById.get(p.keepId);
    const b = customerById.get(p.dropId);
    return a && b ? defaultKeepId(a, b) : p.keepId;
  };

  const dismissPair = (p: CustomerDuplicatePair) => setDismissed((d) => reduceDuplicates(d, { type: 'dismiss', ...p }));

  const mergePair = async (p: CustomerDuplicatePair) => {
    const keepId = keepIdFor(p);
    const dropId = keepId === p.keepId ? p.dropId : p.keepId;
    setMergingKey(pairKey(p));
    setMergeErr(null);
    try {
      await customerClient.merge(keepId, dropId);
      setDismissed((d) => reduceDuplicates(d, { type: 'merge', ...p }));
      await load();
    } catch (e) {
      setMergeErr(e instanceof Error ? e.message : 'Could not merge those customers.');
    } finally {
      setMergingKey(null);
    }
  };

  const mergeAll = async () => {
    if (!window.confirm(`Merge all ${autoDups.length} matching pair${autoDups.length === 1 ? '' : 's'}? Keeps the record with the fuller name for each pair. This can't be undone.`)) {
      return;
    }
    setMergeAllBusy(true);
    setMergeErr(null);
    try {
      // Only the auto tier — name, address, and phone/email (where present)
      // all agree with no conflicting field. A suggest-tier pair is never
      // swept in bulk, however high its score.
      // Always the fuller-name default here, ignoring any per-pair pick —
      // "Merge all" is a bulk action, not a review of each choice.
      for (const p of autoDups) {
        const keepId = defaultKeepId(customerById.get(p.keepId) ?? { id: p.keepId, name: null }, customerById.get(p.dropId) ?? { id: p.dropId, name: null });
        const dropId = keepId === p.keepId ? p.dropId : p.keepId;
        await customerClient.merge(keepId, dropId);
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

  // --------------------------------------------------------- filter/sort/search
  // Pipeline order: search -> the four dropdowns (AND'd) -> sort. Sort never
  // hides a row, so it runs last, over whatever the first two steps left.
  // City's own option list is built from the raw fetched page, not from
  // whatever's already narrowed by search/the other dropdowns — a facet
  // control's own choices shouldn't shrink or reorder just because a sibling
  // filter (or the box itself) is mid-edit.
  const cities = useMemo(() => cityOptions(rows), [rows]);
  const searched = useMemo(() => rows.filter((r) => matchesSearch(r, query)), [rows, query]);
  const filtered = useMemo(() => searched.filter((r) => matchesCustomerFilters(r, filters)), [searched, filters]);
  const shown = useMemo(() => sortCustomers(filtered, sortBy, sortDir), [filtered, sortBy, sortDir]);

  // Column headers and the "Sort:" dropdown share this one pair of state —
  // picking from the dropdown always resets to that mode's natural
  // direction; clicking the already-active header flips it; clicking a
  // different header switches to it at its natural direction, same as the
  // dropdown would.
  const clickSort = (col: CustomerSortBy) => {
    if (sortBy === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(col);
      setSortDir(defaultSortDirection(col));
    }
  };
  const ariaSortFor = (col: CustomerSortBy) => (sortBy === col ? (sortDir === 'asc' ? 'ascending' as const : 'descending' as const) : undefined);

  const activeChips = useMemo(() => describeActiveFilters(filters), [filters]);
  const searchActive = query.trim().length > 0;
  const anyActive = searchActive || activeChips.length > 0;
  const activeCount = activeChips.length + (searchActive ? 1 : 0);
  const clearOne = (key: keyof CustomerFilters) => setFilters({ ...filters, [key]: DEFAULT_CUSTOMER_FILTERS[key] });
  const clearAll = () => { setFilters(DEFAULT_CUSTOMER_FILTERS); setQuery(''); };

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
          {addressConflict && (
            <div role="alert" className="rounded-lg border border-warn/40 bg-warn-bg dark:bg-forest-800 p-3 space-y-2">
              <p className="text-caption text-warn-ink dark:text-brass-200">
                A customer already exists at this address: {addressConflict.name || 'Unnamed'}.
              </p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="dw-btn-secondary !min-h-[32px] !py-1" onClick={() => { const id = addressConflict.id; setCreating(false); setAddressConflict(null); openCustomer(id); }}>
                  Open it
                </button>
                <button type="button" className="dw-btn-tertiary !min-h-[32px] !py-1" disabled={createBusy} onClick={() => void runCreate(true)}>
                  Add anyway
                </button>
              </div>
            </div>
          )}
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
            <button type="button" className="dw-btn-primary" disabled={!draft.name.trim() || createBusy} onClick={() => void runCreate(false)}>
              {createBusy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Plus className="w-4 h-4" aria-hidden="true" />} Create
            </button>
            <button type="button" className="dw-btn-tertiary" onClick={() => { setCreating(false); setCreateErr(null); setAddressConflict(null); }}>
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
            {/* Only ever sweeps the auto tier — a suggest-tier pair (partial
               phone/email confirmation) always needs a person's own click. */}
            {autoDups.length > 0 && (
              <button type="button" className="dw-btn-secondary !min-h-[36px] !py-1" disabled={mergeAllBusy} onClick={() => void mergeAll()}>
                {mergeAllBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <GitMerge className="w-3.5 h-3.5" aria-hidden="true" />} Merge all ({autoDups.length})
              </button>
            )}
          </div>
          {mergeErr && <p role="alert" className="text-caption text-warn-ink dark:text-brass-200">{mergeErr}</p>}
          <ul className="space-y-3">
            {visibleDups.map((p) => {
              const key = pairKey(p);
              const options = [customerById.get(p.keepId), customerById.get(p.dropId)].filter((c): c is CustomerSummary => !!c);
              const keepId = keepIdFor(p);
              const keptName = options.find((c) => c.id === keepId)?.name || options.find((c) => c.id === keepId)?.customerNumber || 'Unnamed';
              return (
                <li key={key} className="border border-line rounded-lg p-3 space-y-2.5">
                  <p className="text-caption text-ink-3">
                    {p.reason} · {Math.round(p.score * 100)}% match
                    {p.tier === 'suggest' && <span className="dw-pill-warn inline-flex ml-2 !py-0">Needs your review</span>}
                  </p>
                  <div className="grid sm:grid-cols-2 gap-2">
                    {options.map((c) => (
                      <label
                        key={c.id}
                        className={[
                          'flex items-start gap-2 rounded-lg border p-2.5 cursor-pointer',
                          keepId === c.id ? 'border-forest-700 dark:border-brass-300 bg-surface-2' : 'border-line',
                        ].join(' ')}
                      >
                        <input
                          type="radio"
                          name={`keep-${key}`}
                          className="mt-1 shrink-0"
                          checked={keepId === c.id}
                          onChange={() => setChosenKeep((cur) => ({ ...cur, [key]: c.id }))}
                        />
                        <span className="min-w-0 text-body">
                          <span className="block text-caption font-medium text-ink-3">Keep this one</span>
                          <span className="block font-medium text-ink">{c.name || 'Unnamed'}</span>
                          <span className="block text-caption text-ink-3 font-mono">{c.customerNumber ?? '—'}</span>
                          <span className="block text-caption text-ink-2">{c.serviceAddress ?? 'No address on file'}</span>
                          <span className="block text-caption text-ink-3">
                            {c.documentCount} doc{c.documentCount === 1 ? '' : 's'} · {c.equipmentCount} unit{c.equipmentCount === 1 ? '' : 's'}
                          </span>
                          {(c.phone || c.email) && (
                            <span className="block text-caption text-ink-3">{[c.phone, c.email].filter(Boolean).join(' · ')}</span>
                          )}
                        </span>
                      </label>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <button type="button" className="dw-btn-secondary !min-h-[32px] !py-1" disabled={mergingKey === key} onClick={() => void mergePair(p)}>
                      {mergingKey === key ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <GitMerge className="w-3.5 h-3.5" aria-hidden="true" />} Merge into {keptName}
                    </button>
                    <button type="button" className="dw-btn-tertiary !min-h-[32px] !py-1" onClick={() => dismissPair(p)}>Not the same</button>
                  </div>
                </li>
              );
            })}
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
          {/* Hidden outright below 2 distinct cities — nothing to filter by. */}
          {cities.length >= 2 && (
            <>
              <label className="sr-only" htmlFor="filter-city">City</label>
              <select id="filter-city" className="dw-input !w-auto !min-h-[36px] !py-1" value={filters.city ?? ''} onChange={(e) => setFilters({ ...filters, city: e.target.value || null })}>
                <option value="">Any city</option>
                {cities.map((c) => <option key={c.city} value={c.city}>{c.city} ({c.count})</option>)}
              </select>
            </>
          )}
          <label className="sr-only" htmlFor="filter-activity">Last activity</label>
          <select id="filter-activity" className="dw-input !w-auto !min-h-[36px] !py-1" value={String(filters.lastActivity)} onChange={(e) => setFilters({ ...filters, lastActivity: (e.target.value === 'any' ? 'any' : Number(e.target.value)) as LastActivityFilter })}>
            {ACTIVITY_OPTIONS.map((o) => <option key={String(o.id)} value={o.id}>{o.label}</option>)}
          </select>
          <span className="w-px self-stretch bg-line mx-1" aria-hidden="true" />
          <label className="sr-only" htmlFor="customer-sort">Sort by</label>
          <select
            id="customer-sort"
            className="dw-input !w-auto !min-h-[36px] !py-1"
            value={sortBy}
            onChange={(e) => {
              const next = e.target.value as CustomerSortBy;
              setSortBy(next);
              setSortDir(defaultSortDirection(next));
            }}
          >
            {CUSTOMER_SORT_OPTIONS.map((o) => <option key={o.id} value={o.id}>Sort: {o.label}</option>)}
          </select>
        </div>

        {anyActive && (
          <div className="flex flex-wrap items-center gap-1.5">
            {searchActive && (
              <button type="button" className="dw-pill-muted inline-flex items-center gap-1" onClick={() => setQuery('')}>
                Search: "{query.trim()}" <X className="w-3 h-3" aria-hidden="true" />
              </button>
            )}
            {activeChips.map((chip) => (
              <button key={chip.key} type="button" className="dw-pill-muted inline-flex items-center gap-1" onClick={() => clearOne(chip.key)}>
                {chip.label} <X className="w-3 h-3" aria-hidden="true" />
              </button>
            ))}
            <button type="button" className="dw-btn-tertiary !min-h-[28px] !py-0.5 !px-2 text-caption" onClick={clearAll}>
              Clear all
            </button>
          </div>
        )}
      </div>

      {error && <p role="alert" className="text-body text-warn-ink dark:text-brass-200">{error}</p>}

      <div className="overflow-x-auto border border-line rounded-lg bg-surface">
        <table className="w-full text-left text-body">
          <thead>
            <tr className="border-b border-line text-caption text-ink-3">
              <th className="px-3 py-2">Number</th>
              <th className="px-3 py-2" aria-sort={ariaSortFor('name')}>
                <SortHeaderButton label="Name" active={sortBy === 'name'} dir={sortDir} onClick={() => clickSort('name')} />
              </th>
              <th className="px-3 py-2" aria-sort={ariaSortFor('address')}>
                <SortHeaderButton label="Address" active={sortBy === 'address'} dir={sortDir} onClick={() => clickSort('address')} />
              </th>
              <th className="px-3 py-2 text-right" aria-sort={ariaSortFor('docs')}>
                <SortHeaderButton label="Docs" active={sortBy === 'docs'} dir={sortDir} onClick={() => clickSort('docs')} align="right" />
              </th>
              <th className="px-3 py-2 text-right" aria-sort={ariaSortFor('equipment')}>
                <SortHeaderButton label="Equipment" active={sortBy === 'equipment'} dir={sortDir} onClick={() => clickSort('equipment')} align="right" />
              </th>
              <th className="px-3 py-2" aria-sort={ariaSortFor('recent')}>
                <SortHeaderButton label="Last activity" active={sortBy === 'recent'} dir={sortDir} onClick={() => clickSort('recent')} />
              </th>
              <th className="px-3 py-2 text-right" aria-sort={ariaSortFor('alerts')}>
                <SortHeaderButton label="Alerts" active={sortBy === 'alerts'} dir={sortDir} onClick={() => clickSort('alerts')} align="right" />
              </th>
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
                    <Tooltip label={alertsTooltip(c.alerts)}>
                      <span className="dw-pill-warn inline-flex"><AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" /> {c.warrantyAlerts}</span>
                    </Tooltip>
                  ) : (
                    <span className="text-ink-3">—</span>
                  )}
                </td>
              </tr>
            ))}
            {!loading && shown.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-ink-3">
                  <p>{anyActive ? 'No customers match these filters.' : 'No customers yet. They appear automatically as documents come in, or add one above.'}</p>
                  {anyActive && (
                    <button type="button" className="dw-btn-tertiary !min-h-[32px] !py-1 mt-2" onClick={clearAll}>
                      Clear all
                    </button>
                  )}
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
        {anyActive
          ? `${shown.length} of ${rows.length} customer${rows.length === 1 ? '' : 's'} · ${activeCount} filter${activeCount === 1 ? '' : 's'}`
          : `${rows.length} customer${rows.length === 1 ? '' : 's'}`}
        {rows.length === 200 ? ' (first 200)' : ''}
      </p>
    </div>
  );
}
