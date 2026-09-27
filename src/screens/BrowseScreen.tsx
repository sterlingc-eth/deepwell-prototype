import { useState } from 'react';
import { Download, FolderOpen, Grid3x3, Loader2, Network, Trash2, Users } from 'lucide-react';
import { downloadExportCsv } from '../services/exportClient';
import { AppShell } from '../components/AppShell';
import { DocumentPreview } from '../components/DocumentPreview';
import { KnowledgeGraph } from '../components/KnowledgeGraph';
import { useGraph } from '../core/entityGraph';
import { deleteDocuments } from '../services/documentClient';
import { CustomersScreen } from './CustomersScreen';
import { useAppStore } from '../store/appStore';
import { RecordsBrowser } from '../components/records/RecordsBrowser';
import { GridView } from '../components/grid/GridView';

/**
 * Documents tab: the records browser (round 12 contract — server-side
 * filter/sort/search/facets/paging, no 500 cap; see RecordsBrowser.tsx and
 * api/_lib/recordsStore.js's browseDocuments), plus CSV export and the typed
 * "empty this shop" wipe carried over from the previous client-side table.
 *
 * Row-level multi-select delete (the previous table's checkbox column) is
 * NOT carried over: it doesn't compose with server-side paging (a checked
 * row can scroll out of the loaded page) — "Empty this shop" below still
 * covers the one bulk-delete case the owner actually asked for. A single
 * document still deletes from inside its own preview (DocumentPreview,
 * rendered in place below — see the round 13 note on `previewDocId`).
 */
function DocumentsTab() {
  const docs = useGraph((s) => s.docs);
  const removeDoc = useGraph((s) => s.removeDoc);
  const openDocument = useAppStore((s) => s.openDocument);

  // Round 13 (H3): a Records Browse row can name a document past
  // usePostgresSync's 500-doc sync cap (see appStore.ts's openDocument /
  // entityGraph.ts's ensureDocLoaded+upsertDoc), so opening it navigates
  // nowhere — it renders in place, same pattern as CustomerProfileScreen's
  // "opens in place" fix (owner defect report, 2026-09-22), rather than
  // routing into the Inbox's review queue, whose "no doc selected -> jump to
  // queue[0]" effect (ReviewScreen.tsx) would otherwise hijack a document
  // that has no reason to be in that queue at all (e.g. it's already verified).
  const [previewDocId, setPreviewDocId] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [emptyText, setEmptyText] = useState('');
  const [emptying, setEmptying] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportErr, setExportErr] = useState<string | null>(null);
  const runExport = async () => {
    setExporting(true);
    setExportErr(null);
    try {
      await downloadExportCsv('documents');
    } catch (e) {
      setExportErr(e instanceof Error ? e.message : 'Could not download that export.');
    } finally {
      setExporting(false);
    }
  };

  const onOpenDocument = (id: string) => { openDocument(id); setPreviewDocId(id); };

  const runEmpty = async () => {
    setEmptying(true);
    setError(null);
    try {
      const ids = Object.keys(docs);
      await deleteDocuments(ids);
      for (const id of ids) removeDoc(id);
      setEmptyText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed.');
    } finally {
      setEmptying(false);
    }
  };

  const totalCount = Object.keys(docs).length;

  return (
    <div className="space-y-4">
      {error && <p role="alert" className="text-body text-warn-ink dark:text-brass-200">{error}</p>}
      {exportErr && <p role="alert" className="text-body text-warn-ink dark:text-brass-200">{exportErr}</p>}

      <div className="flex justify-end">
        <button type="button" className="dw-btn-secondary !min-h-[36px] !py-1" disabled={exporting} onClick={() => void runExport()}>
          {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Download className="w-3.5 h-3.5" aria-hidden="true" />} Export CSV
        </button>
      </div>

      <RecordsBrowser onOpenDocument={onOpenDocument} />

      {totalCount > 0 && (
        <div className="dw-card p-4 space-y-2 border-bad/30">
          <p className="font-medium text-bad-ink flex items-center gap-2"><Trash2 className="w-4 h-4" aria-hidden="true" /> Empty this shop's documents</p>
          <p className="text-body text-ink-2">
            Permanently deletes all {totalCount} document{totalCount === 1 ? '' : 's'} in this shop, along with their extracted fields and links. This can't be undone.
            Type <span className="font-mono">DELETE</span> to confirm.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="empty-confirm-input" className="sr-only">Type DELETE to confirm</label>
            <input
              id="empty-confirm-input"
              className="dw-input max-w-[10rem]"
              value={emptyText}
              onChange={(e) => setEmptyText(e.target.value)}
              placeholder="DELETE"
              autoComplete="off"
            />
            <button
              type="button"
              className="dw-btn-primary !bg-bad hover:!bg-bad"
              disabled={emptyText !== 'DELETE' || emptying}
              onClick={() => void runEmpty()}
            >
              {emptying ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Trash2 className="w-4 h-4" aria-hidden="true" />}
              {emptying ? 'Deleting…' : 'Empty documents'}
            </button>
          </div>
        </div>
      )}

      {previewDocId && <DocumentPreview documentId={previewDocId} onClose={() => setPreviewDocId(null)} />}
    </div>
  );
}

/**
 * Records — Documents (records browser), Customers, Grid and Graph tabs.
 *
 * Round 17 (U2 top fix #7): used to be 5 tabs (Documents/Customers/Search/
 * Grid/Graph). "Search" was a generic client-side filter over property/
 * equipment/service/technician entities that overlapped what Documents'
 * and Customers' own search boxes already do — and, per the audit, never
 * even covered customers, the one kind people search for most. It's gone
 * now, folded into two places that together cover strictly more than it
 * did: the Documents/Customers tabs' own search boxes for those two kinds,
 * and the new ⌘K command palette (src/components/command/CommandPalette.tsx)
 * for a keyboard, app-wide jump to a customer, address, unit (by serial),
 * service visit, or technician — the exact four kinds Search covered, plus
 * customers, from anywhere, not only from here.
 */
export function BrowseScreen() {
  // Customers first (owner, 2026-09-20): the shop's people are the entry point; documents hang off them.
  const [mainTab, setMainTab] = useState<'documents' | 'customers' | 'grid' | 'graph'>('customers');

  return (
    <AppShell>
      <div className="space-y-6">
        <header>
          <h1>Records</h1>
          <p className="text-ink-2 mt-1">Every property, unit, and document you have on file. Press ⌘K to jump straight to one.</p>
        </header>

        <div role="tablist" aria-label="Records view" className="flex flex-wrap gap-1.5">
          {([
            { id: 'documents' as const, label: 'Documents', Icon: FolderOpen },
            { id: 'customers' as const, label: 'Customers', Icon: Users },
            { id: 'grid' as const, label: 'Grid', Icon: Grid3x3 },
            { id: 'graph' as const, label: 'Graph', Icon: Network },
          ]).map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={mainTab === t.id}
              onClick={() => setMainTab(t.id)}
              className={['dw-btn !min-h-[40px] !py-1.5 !px-3', mainTab === t.id ? 'bg-forest-700 text-stone-0 dark:bg-brass-300 dark:text-forest-950' : 'bg-surface border border-line text-ink-2 hover:bg-surface-2'].join(' ')}
            >
              <t.Icon className="w-4 h-4" aria-hidden="true" /> {t.label}
            </button>
          ))}
        </div>

        {mainTab === 'documents' ? (
          <DocumentsTab />
        ) : mainTab === 'customers' ? (
          <CustomersScreen />
        ) : mainTab === 'grid' ? (
          <GridView />
        ) : (
          <KnowledgeGraph showSearch heading="DeepWell knowledge graph" />
        )}
      </div>
    </AppShell>
  );
}
