import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Building2, CalendarDays, ChevronLeft, FileText, FolderOpen, Search, ShieldCheck, ShoppingCart, Store, Users, Wallet, X,
} from 'lucide-react';
import type { ComponentType } from 'react';
import {
  CHECK_REASON_LABEL, folderLabel, monthKey, type CompanyFolderId,
} from '../../core/companyFiles';
import {
  companyFilesFolder, companyFilesHome, companyFilesSearch, moveCompanyFile, setCompanyFilesHrAccess, undoCompanyFileMove,
  type CfDoc, type CfFolderView, type CfHome, type CfMoveResult, type CfSearch,
} from '../../services/companyFilesClient';
import { MoveMenu } from './MoveMenu';

const FOLDER_ICON: Record<CompanyFolderId, ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' }>> = {
  'suppliers-vendors': Store,
  purchasing: ShoppingCart,
  'money-in-out': Wallet,
  'people-hr': Users,
  'insurance-legal': ShieldCheck,
  'company-admin': Building2,
  'schedules-operations': CalendarDays,
};

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtDate(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''));
  if (!m) return '';
  return `${SHORT_MONTHS[Number(m[2]) - 1] ?? ''} ${Number(m[3])}, ${m[1]}`;
}
export function monthTitle(key: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  return m ? `${MONTH_NAMES[Number(m[2]) - 1] ?? ''} ${m[1]}` : 'No date';
}
const fmtMoney = (n: number | null) => (n == null ? '' : n.toLocaleString(undefined, { style: 'currency', currency: 'USD' }));

type Route = { kind: 'home' } | { kind: 'folder'; id: CompanyFolderId } | { kind: 'check' };

interface Props { onOpenDocument: (id: string) => void }

/** Company Files: papers for the business itself (price lists, receipts, leases, schedules...), filed by what they are. */
export function CompanyFilesPanel({ onOpenDocument }: Props) {
  const [route, setRoute] = useState<Route>({ kind: 'home' });
  const [home, setHome] = useState<CfHome | null>(null);
  const [folderData, setFolderData] = useState<CfFolderView | null>(null);
  const [vendorKey, setVendorKey] = useState<string | null>(null);
  const [showAllVendors, setShowAllVendors] = useState(false);
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState<CfSearch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ move: CfMoveResult } | null>(null);
  const seq = useRef(0);

  useEffect(() => { const t = setTimeout(() => setQ(draft.trim()), 250); return () => clearTimeout(t); }, [draft]);

  const loadHome = useCallback(async () => {
    try { setHome(await companyFilesHome()); setError(null); } catch (e) { setError(e instanceof Error ? e.message : 'Could not load Company Files.'); }
  }, []);
  const loadFolder = useCallback(async (id: CompanyFolderId) => {
    const my = ++seq.current;
    try { const d = await companyFilesFolder(id); if (my === seq.current) { setFolderData(d); setError(null); } }
    catch (e) { if (my === seq.current) setError(e instanceof Error ? e.message : 'Could not open that folder.'); }
  }, []);
  const loadSearch = useCallback(async (text: string) => {
    const my = ++seq.current;
    try { const r = await companyFilesSearch(text); if (my === seq.current) { setSearch(r); setError(null); } }
    catch (e) { if (my === seq.current) setError(e instanceof Error ? e.message : 'Search failed.'); }
  }, []);

  useEffect(() => { void loadHome(); }, [loadHome]);
  useEffect(() => {
    if (route.kind === 'folder') { setFolderData(null); setVendorKey(null); setShowAllVendors(false); void loadFolder(route.id); }
  }, [route, loadFolder]);
  useEffect(() => { if (q) void loadSearch(q); else setSearch(null); }, [q, loadSearch]);

  const refresh = useCallback(async () => {
    await loadHome();
    if (route.kind === 'folder') await loadFolder(route.id);
    if (q) await loadSearch(q);
  }, [loadHome, loadFolder, loadSearch, route, q]);

  const onMove = async (doc: CfDoc, to: string, alwaysFile: boolean) => {
    try {
      const res = await moveCompanyFile(doc.id, to, alwaysFile);
      setToast({ move: res });
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not move that.'); }
  };
  const onUndo = async () => {
    if (!toast) return;
    const m = toast.move;
    setToast(null);
    try { await undoCompanyFileMove(m); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : 'Could not undo that.'); }
  };
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 10000);
    return () => clearTimeout(t);
  }, [toast]);

  const folders = home?.folders ?? [];
  const rowProps = { folders, onOpen: onOpenDocument, onMove };

  return (
    <section className="space-y-5" aria-labelledby="cf-title" data-testid="company-files">
      <header className="space-y-1">
        <h2 id="cf-title" className="text-h3">Company Files</h2>
        <p className="text-ink-2">Papers for your business, filed for you. No linking needed.</p>
      </header>

      <div className="relative">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-ink-3" aria-hidden="true" />
        <label htmlFor="cf-search" className="sr-only">Search company files</label>
        <input
          id="cf-search"
          className="dw-input !pl-12"
          placeholder="Search company files"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape' && draft) { e.stopPropagation(); setDraft(''); } }}
          autoComplete="off"
        />
      </div>

      {error && <p role="alert" className="text-body text-warn-ink dark:text-brass-200">{error}</p>}

      {q ? (
        <SearchResults data={search} {...rowProps} />
      ) : route.kind === 'home' ? (
        <Home home={home} onFolder={(id) => setRoute({ kind: 'folder', id })} onCheckAll={() => setRoute({ kind: 'check' })} onHrChange={async (roles) => { await setCompanyFilesHrAccess(roles); await loadHome(); }} {...rowProps} />
      ) : route.kind === 'check' ? (
        <div className="space-y-3">
          <BackButton onClick={() => setRoute({ kind: 'home' })} />
          <h3 className="text-h4">Check these</h3>
          <DocList docs={home?.checkThese.items ?? []} showFolder {...rowProps} />
        </div>
      ) : (
        <FolderView
          data={folderData}
          id={route.id}
          vendorKey={vendorKey}
          onVendor={setVendorKey}
          showAllVendors={showAllVendors}
          onShowAll={() => setShowAllVendors((v) => !v)}
          onBack={() => setRoute({ kind: 'home' })}
          {...rowProps}
        />
      )}

      {toast && (
        <div role="status" className="fixed bottom-4 left-4 right-4 sm:left-auto sm:right-6 sm:w-96 z-40 dw-card shadow-lift p-3 flex items-center gap-3" data-testid="cf-toast">
          <span className="flex-1 text-body">Moved to {toast.move.toLabel}.</span>
          <button type="button" className="dw-btn-tertiary" onClick={() => void onUndo()}>Undo</button>
          <button type="button" className="p-2 min-w-[44px] min-h-[44px] flex items-center justify-center text-ink-3" aria-label="Dismiss" onClick={() => setToast(null)}><X className="w-4 h-4" aria-hidden="true" /></button>
        </div>
      )}
    </section>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="dw-btn-tertiary -ml-3" onClick={onClick}>
      <ChevronLeft className="w-4 h-4" aria-hidden="true" /> Company Files
    </button>
  );
}

interface RowCtx {
  folders: { id: CompanyFolderId; label: string }[];
  onOpen: (id: string) => void;
  onMove: (doc: CfDoc, to: string, alwaysFile: boolean) => void | Promise<void>;
}

/* ------------------------------------------------------------------------------------------------ home */

function Home({ home, onFolder, onCheckAll, onHrChange, ...ctx }: RowCtx & {
  home: CfHome | null; onFolder: (id: CompanyFolderId) => void; onCheckAll: () => void; onHrChange: (roles: string[]) => Promise<void>;
}) {
  if (!home) return <p className="text-ink-3" aria-live="polite">Loading…</p>;
  const empty = home.total === 0;
  return (
    <div className="space-y-6">
      {home.comingUp.count > 0 && <ComingUp strip={home.comingUp} limit={3} {...ctx} />}
      <ul className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3" aria-label="Folders">
        {home.folders.map((f) => {
          const Icon = FOLDER_ICON[f.id] ?? FolderOpen;
          return (
            <li key={f.id}>
              <button
                type="button"
                onClick={() => onFolder(f.id)}
                className="dw-card w-full min-h-[96px] p-4 text-left flex flex-col gap-2 hover:bg-surface-2 transition-colors"
                data-testid={`cf-folder-${f.id}`}
              >
                <span className="flex items-center gap-2 text-ink-2"><Icon className="w-5 h-5 text-forest-700 dark:text-brass-300" aria-hidden="true" /><span className="font-medium text-ink">{f.label}</span></span>
                <span className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-h3 tabular-nums">{f.count.toLocaleString()}</span>
                  {f.check > 0 && <span className="dw-pill-warn">Check these · {f.check}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {empty && <p className="text-ink-3">Nothing here yet. New papers are filed here as they arrive.</p>}
      {home.checkThese.count > 0 && (
        <CheckStrip strip={home.checkThese} limit={3} onAll={onCheckAll} {...ctx} />
      )}
      {home.canEditHrAccess && <HrAccessCard roles={home.hrAccess?.roles ?? []} onChange={onHrChange} />}
    </div>
  );
}

function HrAccessCard({ roles, onChange }: { roles: string[]; onChange: (roles: string[]) => Promise<void> }) {
  const all = roles.includes('member');
  return (
    <fieldset className="dw-card p-4 space-y-1" data-testid="cf-hr-access">
      <legend className="px-1 font-medium">Who can open People and HR</legend>
      {[{ v: false, label: 'Admins only' }, { v: true, label: 'Admins and all team members' }].map((o) => (
        <label key={String(o.v)} className="flex items-center gap-3 min-h-[44px] cursor-pointer">
          <input type="radio" name="cf-hr" className="w-5 h-5 accent-forest-700" checked={all === o.v} onChange={() => void onChange(o.v ? ['member'] : [])} />
          <span>{o.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

/* ------------------------------------------------------------------------------------------------ strips */

function ComingUp({ strip, limit = 30, ...ctx }: RowCtx & { strip: { count: number; items: CfDoc[] }; limit?: number }) {
  return (
    <div className="space-y-2" data-testid="cf-coming-up">
      <h3 className="text-h4">Coming up</h3>
      <DocList docs={strip.items.slice(0, limit)} showFolder {...ctx} />
    </div>
  );
}

function CheckStrip({ strip, limit, onAll, ...ctx }: RowCtx & { strip: { count: number; items: CfDoc[] }; limit: number; onAll?: () => void }) {
  return (
    <div className="space-y-2" data-testid="cf-check">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-h4">Check these <span className="text-ink-3 font-normal">· {strip.count}</span></h3>
        {onAll && strip.count > limit && <button type="button" className="dw-btn-tertiary" onClick={onAll}>Show all {strip.count}</button>}
      </div>
      <DocList docs={strip.items.slice(0, limit)} showFolder {...ctx} />
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ search */

function SearchResults({ data, ...ctx }: RowCtx & { data: CfSearch | null }) {
  if (!data) return <p className="text-ink-3" aria-live="polite">Loading…</p>;
  return (
    <div className="space-y-2" aria-live="polite">
      <p className="text-caption text-ink-3">{data.total.toLocaleString()} result{data.total === 1 ? '' : 's'}</p>
      <DocList docs={data.docs} showFolder {...ctx} />
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ folder */

function FolderView({ data, id, vendorKey, onVendor, showAllVendors, onShowAll, onBack, ...ctx }: RowCtx & {
  data: CfFolderView | null; id: CompanyFolderId; vendorKey: string | null; onVendor: (k: string | null) => void;
  showAllVendors: boolean; onShowAll: () => void; onBack: () => void;
}) {
  const docs = data?.docs ?? [];
  const shown = vendorKey === null ? docs : docs.filter((d) => d.vendorKey === vendorKey);
  const vendors = data?.vendors ?? [];
  const VISIBLE_VENDORS = 8;
  const vendorList = showAllVendors ? vendors : vendors.slice(0, VISIBLE_VENDORS);
  const selected = vendors.find((v) => v.key === vendorKey);

  const groups = useMemo(() => {
    if (!data) return [] as { key: string; title: string; docs: CfDoc[] }[];
    if (data.folder.layout === 'kind') {
      const m = new Map<string, { key: string; title: string; docs: CfDoc[] }>();
      for (const d of docs) { const g = m.get(d.type) ?? { key: d.type, title: d.typeLabel, docs: [] }; g.docs.push(d); m.set(d.type, g); }
      return [...m.values()].sort((a, b) => b.docs.length - a.docs.length);
    }
    if (data.folder.layout === 'month') {
      const m = new Map<string, { key: string; title: string; docs: CfDoc[] }>();
      for (const d of docs) { const k = monthKey(d.date) || 'none'; const g = m.get(k) ?? { key: k, title: monthTitle(k), docs: [] }; g.docs.push(d); m.set(k, g); }
      return [...m.values()].sort((a, b) => b.key.localeCompare(a.key));
    }
    return [];
  }, [data, docs]);

  return (
    <div className="space-y-5">
      <BackButton onClick={onBack} />
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-h3">{data?.folder.label ?? folderLabel(id)}</h3>
        {data && <span className="text-ink-3 tabular-nums">{data.total.toLocaleString()}</span>}
      </div>
      {!data ? <p className="text-ink-3" aria-live="polite">Loading…</p> : (
        <>
          {data.comingUp.count > 0 && <ComingUp strip={data.comingUp} {...ctx} />}
          {data.checkThese.count > 0 && <CheckStrip strip={data.checkThese} limit={5} {...ctx} />}
          {data.total === 0 ? (
            <p className="text-ink-3">Nothing here yet. New papers are filed here as they arrive.</p>
          ) : data.folder.layout === 'vendor' ? (
            <div className="space-y-4">
              <ul className="grid grid-cols-1 min-[520px]:grid-cols-2 lg:grid-cols-4 gap-3" aria-label="Vendors">
                {vendorList.map((v) => (
                  <li key={v.key || 'none'}>
                    <button
                      type="button"
                      aria-pressed={vendorKey === v.key}
                      onClick={() => onVendor(vendorKey === v.key ? null : v.key)}
                      className={['dw-card w-full min-h-[72px] p-3 text-left flex flex-col gap-0.5 transition-colors hover:bg-surface-2', vendorKey === v.key ? '!border-focus ring-1 ring-[var(--dw-focus)]' : ''].join(' ')}
                      data-testid={`cf-vendor-${(v.key || 'none').replace(/\W+/g, '-')}`}
                    >
                      <span className="font-medium truncate">{v.name}</span>
                      <span className="text-caption text-ink-3">{v.count} file{v.count === 1 ? '' : 's'}{v.latest ? ` · ${fmtDate(v.latest)}` : ''}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {vendors.length > VISIBLE_VENDORS && (
                <button type="button" className="dw-btn-tertiary" onClick={onShowAll}>{showAllVendors ? 'Show fewer vendors' : `Show all ${vendors.length} vendors`}</button>
              )}
              <h4 className="text-h4 font-medium">{selected ? selected.name : 'Recent'}</h4>
              <DocList docs={selected ? shown : shown.slice(0, 20)} {...ctx} />
            </div>
          ) : (
            <div className="space-y-5">
              {groups.map((g) => (
                <div key={g.key} className="space-y-2">
                  <h4 className="text-h4 font-medium">{g.title} <span className="text-ink-3 font-normal">· {g.docs.length}</span></h4>
                  <DocList docs={g.docs} {...ctx} />
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ rows */

function DocList({ docs, showFolder = false, ...ctx }: RowCtx & { docs: CfDoc[]; showFolder?: boolean }) {
  if (docs.length === 0) return <p className="text-ink-3">Nothing here yet. New papers are filed here as they arrive.</p>;
  return (
    <ul className="dw-card divide-y divide-line">
      {docs.map((d) => <DocRow key={d.id} doc={d} showFolder={showFolder} {...ctx} />)}
    </ul>
  );
}

function DocRow({ doc, showFolder, folders, onOpen, onMove }: RowCtx & { doc: CfDoc; showFolder: boolean }) {
  const meta = [doc.typeLabel, doc.vendor, fmtDate(doc.date), fmtMoney(doc.amount)].filter(Boolean).join(' · ');
  return (
    <li className="p-3 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3" data-testid="cf-row">
      <button type="button" onClick={() => onOpen(doc.id)} className="flex-1 min-w-0 min-h-[44px] flex items-start gap-3 text-left rounded-md hover:bg-surface-2 px-2 -mx-2 py-1">
        <FileText className="w-5 h-5 mt-0.5 shrink-0 text-ink-3" aria-hidden="true" />
        <span className="min-w-0 space-y-0.5">
          <span className="block font-medium truncate">{doc.name}</span>
          <span className="block text-caption text-ink-3 truncate">{meta}</span>
          {showFolder && !doc.moved && <span className="block text-caption text-ink-3">Filed in {folderLabel(doc.folder)} automatically</span>}
          {showFolder && doc.moved && <span className="block text-caption text-ink-3">{folderLabel(doc.folder)}</span>}
        </span>
      </button>
      <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
        {doc.flags.map((f) => <span key={f} className="dw-pill-warn">{CHECK_REASON_LABEL[f]}</span>)}
        {doc.flags.length === 0 && !doc.older && !doc.replaced && doc.expiryState === null && <span className="dw-pill-ok">Filed</span>}
        {doc.older && <span className="dw-pill-muted">Older</span>}
        {doc.replaced && <span className="dw-pill-muted">Replaced</span>}
        {doc.expiryState === 'expired' && <span className="dw-pill-bad">Expired</span>}
        {doc.expiryState === 'upcoming' && doc.expires && <span className="dw-pill-info">Expires {fmtDate(doc.expires)}</span>}
        <MoveMenu doc={doc} folders={folders} onMove={onMove} />
      </div>
    </li>
  );
}
