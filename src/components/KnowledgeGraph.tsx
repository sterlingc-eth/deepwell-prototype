import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { AlertTriangle, Loader2, Search } from 'lucide-react';
// cytoscape's own @types ship style/layout option unions far too narrow for
// data()-mapped styles ("shape": "data(shape)" isn't a valid NodeShape
// literal in its eyes even though the library reads it fine at runtime) — so,
// same as bulkImport.ts's jszip import, only the well-behaved `Core` shape is
// typed here; style/layout/event payloads are cast at the boundary instead of
// fighting a third-party .d.ts that doesn't model cytoscape's own mapper
// syntax.
import type { Core, ElementDefinition } from 'cytoscape';
import { graphClient, type GraphDepth, type GraphEdge, type GraphNode } from '../services/graphClient';
import { useAppStore } from '../store/appStore';
import { DocumentPreview } from './DocumentPreview';
import type { SourceLocation } from '../core/types';

/**
 * Obsidian-style "second brain" view of one tenant's data: pick (or land on)
 * a node, see its neighborhood out to 1–3 hops, click anything to recenter,
 * double-click a document to open the original at the page it was cited
 * from. Cytoscape.js does the canvas rendering; it's dynamic-imported below
 * so the ~300 KB library only ever loads when this component actually
 * mounts, never as part of the main /app bundle.
 */

/* ------------------------------------------------------------- node ids -- */
// entityNodeId / customerNodeId (mapping a local record to its graph node
// id) live in core/graphNodeId.ts, not here — see that file's doc comment.

function documentIdFromNode(nodeId: string): string {
  return nodeId.startsWith('document:') ? nodeId.slice('document:'.length) : nodeId;
}

/* --------------------------------------------------------- type styling -- */

const TYPE_LABEL: Record<string, string> = {
  customer: 'Customer',
  unit: 'Equipment',
  document: 'Document',
  tech: 'Technician',
  site: 'Property',
  visit: 'Service visit',
  invoice: 'Invoice',
  warranty: 'Warranty',
  agreement: 'Agreement',
};

function typeLabel(type: string): string {
  return TYPE_LABEL[type] ?? humanize(type);
}

function humanize(s: string): string {
  const words = s.replace(/[_:]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || s;
}

/** Shape per node type — theme-independent, so it stays a stable visual cue
 *  as Office/Field is toggled. */
const NODE_SHAPE: Record<string, string> = {
  customer: 'ellipse',
  unit: 'round-rectangle',
  document: 'rectangle',
  tech: 'diamond',
  site: 'hexagon',
  visit: 'triangle',
  invoice: 'tag',
  warranty: 'round-diamond',
  agreement: 'pentagon',
};

/** Fill per node type, one palette per view so every type stays legible
 *  against both Office's dark forest background and Field's light one —
 *  drawn from the brand tokens in tailwind.config.ts / index.css rather than
 *  new colors. */
const NODE_COLOR_DARK: Record<string, string> = {
  customer: '#7FA0C6', // navy-300
  unit: '#86AE93', // forest-300
  document: '#C2CCC5', // stone-300
  tech: '#D9B57A', // brass-300
  site: '#4F7BAB', // navy-400
  visit: '#5A8C6C', // forest-400
  invoice: '#B98A4E', // brass-500
  warranty: '#b9e6c9', // dark-mode "ok" pill tint (index.css .dark .dw-pill-ok)
  agreement: '#c3d8ef', // dark-mode "info" pill tint (index.css .dark .dw-pill-info)
};
const NODE_COLOR_LIGHT: Record<string, string> = {
  customer: '#123D6B', // navy-600
  unit: '#3A6B4D', // forest-500
  document: '#6E7C72', // stone-500
  tech: '#9B7039', // brass-600
  site: '#2B5A8C', // navy-500
  visit: '#245239', // forest-600
  invoice: '#B98A4E', // brass-500
  warranty: '#1E7A46', // ok.DEFAULT
  agreement: '#123D6B', // info.DEFAULT
};
const DEFAULT_COLOR_DARK = '#97A59B'; // stone-400
const DEFAULT_COLOR_LIGHT = '#525E56'; // stone-600

function colorFor(type: string, dark: boolean): string {
  const palette = dark ? NODE_COLOR_DARK : NODE_COLOR_LIGHT;
  return palette[type] ?? (dark ? DEFAULT_COLOR_DARK : DEFAULT_COLOR_LIGHT);
}

function shapeFor(type: string): string {
  return NODE_SHAPE[type] ?? 'ellipse';
}

function sizeFor(degree: number | undefined, isCenter: boolean): number {
  const base = 28 + Math.min(20, Math.max(0, degree ?? 0) * 2.5);
  return isCenter ? base + 10 : base;
}

/** Theme literals for the handful of style properties that aren't
 *  data-driven per node (label color, default border, canvas-adjacent
 *  label backing) — same hex values index.css sets on :root / .dark. */
const THEME = {
  dark: { ink: '#f6f8f6', line: '#245239', line2: '#3a6b4d', surface: '#0a1b14' },
  light: { ink: '#0d110e', line: '#dce3de', line2: '#c2ccc5', surface: '#ffffff' },
};

function buildStyle(dark: boolean): unknown[] {
  const t = dark ? THEME.dark : THEME.light;
  return [
    {
      selector: 'node',
      style: {
        'background-color': 'data(color)',
        shape: 'data(shape)',
        width: 'data(size)',
        height: 'data(size)',
        label: 'data(label)',
        color: t.ink,
        'font-size': 10,
        'font-family': '"IBM Plex Sans", system-ui, sans-serif',
        'text-valign': 'bottom',
        'text-halign': 'center',
        'text-margin-y': 6,
        'text-wrap': 'ellipsis',
        'text-max-width': '90px',
        'text-background-color': t.surface,
        'text-background-opacity': 0.85,
        'text-background-shape': 'roundrectangle',
        'text-background-padding': '2px',
        'border-width': 1,
        'border-color': t.line2,
        'border-opacity': 1,
      },
    },
    { selector: 'node[?center]', style: { 'border-width': 3, 'border-color': t.ink } },
    {
      selector: 'edge',
      style: {
        width: 'data(lineWidth)',
        'line-color': t.line2,
        'target-arrow-color': t.line2,
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.7,
        'curve-style': 'bezier',
        opacity: 0.8,
      },
    },
  ];
}

function buildElements(nodes: GraphNode[], edges: GraphEdge[], centerId: string, dark: boolean): ElementDefinition[] {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const nodeEls: ElementDefinition[] = nodes.map((n) => ({
    data: {
      id: n.id,
      label: n.label,
      type: n.type,
      subtitle: n.subtitle ?? '',
      color: colorFor(n.type, dark),
      shape: shapeFor(n.type),
      size: sizeFor(n.degree, n.id === centerId),
      center: n.id === centerId,
    },
  }));
  // Defensive: never hand cytoscape an edge whose endpoint the API didn't
  // also list as a node — it would throw building the graph.
  const edgeEls: ElementDefinition[] = edges
    .filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to))
    .map((e) => ({
      data: {
        id: e.id,
        source: e.from,
        target: e.to,
        type: e.type,
        weight: e.weight ?? 1,
        lineWidth: Math.max(1, Math.min(5, e.weight ?? 1.5)),
        documentId: e.source?.documentId ?? '',
        page: e.source?.page ?? undefined,
      },
    }));
  return [...nodeEls, ...edgeEls];
}

/* --------------------------------------------------------------- panel --- */

interface EdgeGroupEntry {
  edge: GraphEdge;
  other: GraphNode;
}

function groupEdges(edges: GraphEdge[], nodesById: Map<string, GraphNode>, centerId: string, direction: 'in' | 'out'): Map<string, EdgeGroupEntry[]> {
  const groups = new Map<string, EdgeGroupEntry[]>();
  for (const e of edges) {
    const matches = direction === 'in' ? e.to === centerId : e.from === centerId;
    if (!matches) continue;
    const otherId = direction === 'in' ? e.from : e.to;
    const other = nodesById.get(otherId);
    if (!other) continue;
    const list = groups.get(e.type) ?? [];
    list.push({ edge: e, other });
    groups.set(e.type, list);
  }
  return groups;
}

function EdgeGroupList({ title, groups, onOpen }: { title: string; groups: Map<string, EdgeGroupEntry[]>; onOpen: (nodeId: string) => void }) {
  const total = [...groups.values()].reduce((n, l) => n + l.length, 0);
  return (
    <section aria-label={title}>
      <h3 className="dw-label mb-2">
        {title} <span className="text-ink-3 normal-case font-normal">· {total}</span>
      </h3>
      {total === 0 ? (
        <p className="text-caption text-ink-3">None.</p>
      ) : (
        <div className="space-y-3">
          {[...groups.entries()].map(([type, entries]) => (
            <div key={type}>
              <p className="text-caption text-ink-3 mb-1">{humanize(type)}</p>
              <ul className="divide-y divide-line border border-line rounded-lg bg-surface">
                {entries.map(({ edge, other }) => (
                  <li key={edge.id}>
                    <button
                      type="button"
                      onClick={() => onOpen(other.id)}
                      className="w-full text-left flex items-center gap-2 px-3 py-2 min-h-touch hover:bg-surface-2 transition-colors duration-quick"
                    >
                      <span className="dw-pill-muted shrink-0 text-caption">{typeLabel(other.type)}</span>
                      <span className="min-w-0 flex-1 truncate text-body text-ink">{other.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Legend({ dark }: { dark: boolean }) {
  const types = Object.keys(NODE_SHAPE);
  return (
    <details className="mt-2 text-caption text-ink-3">
      <summary className="cursor-pointer select-none">Legend</summary>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
        {types.map((t) => (
          <li key={t} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="inline-block w-2.5 h-2.5 shrink-0"
              style={{
                backgroundColor: colorFor(t, dark),
                borderRadius: NODE_SHAPE[t] === 'ellipse' || NODE_SHAPE[t] === 'round-diamond' ? '999px' : '2px',
              }}
            />
            {typeLabel(t)}
          </li>
        ))}
      </ul>
    </details>
  );
}

/* ------------------------------------------------------------ component -- */

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

export interface KnowledgeGraphProps {
  /** Seeds the view directly at this node id (a customer or entity's own
   *  graph id). Omit to start from the search box instead. */
  seedNodeId?: string;
  /** Shows the "search to pick a start node" box (the standalone Graph
   *  screen inside Records). Entry points that already know their node
   *  (customer profile, entity screen) leave this off. */
  showSearch?: boolean;
  /** aria-label for the whole widget; defaults to "Knowledge graph". */
  heading?: string;
}

export function KnowledgeGraph({ seedNodeId, showSearch = false, heading = 'Knowledge graph' }: KnowledgeGraphProps) {
  const fieldMode = useAppStore((s) => s.fieldMode); // true = Field (light); false = Office (dark)
  const dark = !fieldMode;

  const [centerId, setCenterId] = useState<string | null>(null);
  const [depth, setDepth] = useState<GraphDepth>(2);
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<GraphNode[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [preview, setPreview] = useState<{ documentId: string; location: SourceLocation } | null>(null);
  const [hoverEdge, setHoverEdge] = useState<{ x: number; y: number; label: string } | null>(null);
  const [liveMessage, setLiveMessage] = useState('');

  const abortRef = useRef<AbortController | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const tapTimerRef = useRef<number | null>(null);
  const [cyReady, setCyReady] = useState(false);

  const [reducedMotion, setReducedMotion] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  );
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReducedMotion(mq.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  const load = useCallback((nodeId: string, d: GraphDepth) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoadState('loading');
    setError(null);
    graphClient
      .get(nodeId, d, controller.signal)
      .then((res) => {
        setCenterId(res.center);
        setNodes(res.nodes);
        setEdges(res.edges);
        setTruncated(res.truncated);
        setLoadState('ready');
        const label = res.nodes.find((n) => n.id === res.center)?.label ?? res.center;
        setLiveMessage(`Centered on ${label}. ${res.nodes.length} record${res.nodes.length === 1 ? '' : 's'} shown.`);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Could not load the graph.');
        setLoadState('error');
      });
  }, []);

  // Seed (or re-seed, if a caller hands this a different node id later —
  // e.g. the customer profile navigating to a different customer while its
  // Graph tab stays mounted) always starts fresh at depth 2.
  useEffect(() => {
    if (!seedNodeId) return;
    setDepth(2);
    load(seedNodeId, 2);
  }, [seedNodeId, load]);

  // A depth change reloads the CURRENT center — guarded on centerId so this
  // never fires a redundant first request before the seed effect above has
  // set one.
  const firstDepthRun = useRef(true);
  useEffect(() => {
    if (firstDepthRun.current) {
      firstDepthRun.current = false;
      return;
    }
    if (centerId) load(centerId, depth);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depth]);

  const recenter = useCallback((nodeId: string) => { load(nodeId, depth); }, [load, depth]);

  const runSearch = async (e?: FormEvent) => {
    e?.preventDefault();
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setSearchError(null);
    try {
      const res = await graphClient.search(q);
      setSearchResults(res.nodes);
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'Search failed.');
      setSearchResults(null);
    } finally {
      setSearching(false);
    }
  };

  const pickSearchResult = (nodeId: string) => {
    setSearchResults(null);
    setQuery('');
    setDepth(2);
    load(nodeId, 2);
  };

  const findCitedPage = useCallback(
    (docNodeId: string): number | undefined => {
      const docId = documentIdFromNode(docNodeId);
      for (const e of edges) {
        if (e.source?.documentId === docId && e.source.page) return e.source.page;
      }
      return undefined;
    },
    [edges]
  );

  const openDocumentPreview = useCallback(
    (docNodeId: string) => {
      const documentId = documentIdFromNode(docNodeId);
      const page = findCitedPage(docNodeId);
      setPreview({ documentId, location: page ? { page } : {} });
    },
    [findCitedPage]
  );

  /* --------------------------------------------------- cytoscape mount --- */

  // Refs so the stable cytoscape event handlers below (registered once, on
  // mount) always call the CURRENT recenter/openDocumentPreview closures —
  // otherwise they'd capture depth=2 (etc.) forever from the first render.
  const recenterRef = useRef(recenter);
  recenterRef.current = recenter;
  const openDocPreviewRef = useRef(openDocumentPreview);
  openDocPreviewRef.current = openDocumentPreview;

  useEffect(() => {
    let cancelled = false;
    let cy: Core | null = null;
    (async () => {
      // See the import comment at the top of this file: cast at the
      // boundary rather than fighting cytoscape's own (CommonJS `export =`)
      // module typing for a dynamic import.
      const mod: unknown = await import('cytoscape');
      const cytoscape = (mod as { default: (opts: unknown) => Core }).default;
      if (cancelled || !canvasRef.current) return;
      cy = cytoscape({
        container: canvasRef.current,
        elements: [],
        style: buildStyle(dark),
        wheelSensitivity: 0.25,
        minZoom: 0.2,
        maxZoom: 3,
      });
      cyRef.current = cy;

      const on = cy.on.bind(cy) as unknown as (evt: string, selector: string, handler: (e: any) => void) => void;

      on('tap', 'node', (evt) => {
        const id = evt.target.id() as string;
        if (tapTimerRef.current) window.clearTimeout(tapTimerRef.current);
        tapTimerRef.current = window.setTimeout(() => {
          recenterRef.current(id);
          tapTimerRef.current = null;
        }, 260);
      });
      on('dbltap', 'node', (evt) => {
        if (tapTimerRef.current) {
          window.clearTimeout(tapTimerRef.current);
          tapTimerRef.current = null;
        }
        const node = evt.target;
        const id = node.id() as string;
        if (node.data('type') === 'document') openDocPreviewRef.current(id);
        else recenterRef.current(id);
      });
      on('mouseover', 'edge', (evt) => {
        const edge = evt.target;
        const rect = canvasRef.current?.getBoundingClientRect();
        const p = evt.renderedPosition as { x: number; y: number };
        const type = humanize(String(edge.data('type')));
        const docId = edge.data('documentId') as string;
        const page = edge.data('page') as number | undefined;
        const source = docId ? ` · ${page ? `p. ${page} of ` : ''}source document` : '';
        setHoverEdge({ x: (rect?.left ?? 0) + p.x, y: (rect?.top ?? 0) + p.y, label: `${type}${source}` });
      });
      on('mouseout', 'edge', () => setHoverEdge(null));
      on('mousemove', 'edge', (evt) => {
        const rect = canvasRef.current?.getBoundingClientRect();
        const p = evt.renderedPosition as { x: number; y: number };
        setHoverEdge((prev) => (prev ? { ...prev, x: (rect?.left ?? 0) + p.x, y: (rect?.top ?? 0) + p.y } : prev));
      });

      setCyReady(true);
    })();
    return () => {
      cancelled = true;
      if (tapTimerRef.current) window.clearTimeout(tapTimerRef.current);
      cy?.destroy();
      cyRef.current = null;
    };
    // Mount once. Theme (`dark`) changes are applied to the live instance in
    // the style-rebuild effect below, not by tearing this down and redoing it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rebuild elements + style whenever the data, theme, or reduced-motion
  // preference changes, and lay it out again (no animation when the viewer
  // has asked for reduced motion).
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !cyReady) return;
    (cy.style as any)(buildStyle(dark)).update();
    cy.elements().remove();
    if (centerId && nodes.length) {
      cy.add(buildElements(nodes, edges, centerId, dark));
      const layout = (cy.layout as any)({
        name: nodes.length > 1 ? 'cose' : 'grid',
        animate: !reducedMotion,
        animationDuration: 350,
        fit: true,
        padding: 24,
        randomize: false,
        // Labels sit below each node (see buildStyle's text-valign: bottom),
        // so cose needs to know about that extra bounding-box height or it
        // packs nodes close enough that neighboring labels overlap once a
        // view has more than a handful of records (owner-visible in the
        // first ~20-node screenshot pass).
        nodeDimensionsIncludeLabels: true,
        nodeRepulsion: 12000,
        idealEdgeLength: 110,
        edgeElasticity: 100,
        gravity: 60,
      });
      layout.run();
    }
  }, [nodes, edges, centerId, dark, reducedMotion, cyReady]);

  // Keep the canvas sized to its container (side panel stacking under it on
  // narrow screens changes the canvas's own width, not just the window's).
  useEffect(() => {
    if (!canvasRef.current || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => cyRef.current?.resize());
    ro.observe(canvasRef.current);
    return () => ro.disconnect();
  }, []);

  const nodesById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const centerNode = centerId ? nodesById.get(centerId) : undefined;
  const backlinks = useMemo(() => (centerId ? groupEdges(edges, nodesById, centerId, 'in') : new Map()), [edges, nodesById, centerId]);
  const links = useMemo(() => (centerId ? groupEdges(edges, nodesById, centerId, 'out') : new Map()), [edges, nodesById, centerId]);

  const showEmptyStart = !centerId && loadState === 'idle';

  return (
    <section aria-label={heading} className="space-y-3">
      {showSearch && (
        <form onSubmit={runSearch} className="space-y-2">
          <div className="relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-ink-3" aria-hidden="true" />
            <label htmlFor="graph-search-input" className="sr-only">Search records to start exploring</label>
            <input
              id="graph-search-input"
              className="dw-input !pl-12"
              placeholder="Search a customer, unit, technician, document…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
            />
          </div>
          {searchError && <p role="alert" className="text-body text-warn-ink dark:text-brass-200">{searchError}</p>}
          {searching && <p className="text-ink-3 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Searching…</p>}
          {searchResults && (
            <ul className="divide-y divide-line border border-line rounded-lg bg-surface max-h-64 overflow-y-auto" aria-label="Search results">
              {searchResults.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => pickSearchResult(n.id)}
                    className="w-full text-left flex items-center gap-2 px-3 py-2 min-h-touch hover:bg-surface-2 transition-colors duration-quick"
                  >
                    <span className="dw-pill-muted shrink-0 text-caption">{typeLabel(n.type)}</span>
                    <span className="min-w-0 flex-1 truncate text-body text-ink">{n.label}</span>
                    {n.subtitle && <span className="text-caption text-ink-3 truncate">{n.subtitle}</span>}
                  </button>
                </li>
              ))}
              {searchResults.length === 0 && <li className="px-4 py-6 text-center text-ink-3">No matches.</li>}
            </ul>
          )}
        </form>
      )}

      {showEmptyStart && showSearch && <p className="text-ink-3">Search above to start exploring your knowledge graph.</p>}
      {showEmptyStart && !showSearch && <p className="text-ink-3">Nothing to graph yet.</p>}

      {centerId && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="dw-label">Centered on</p>
              <p className="font-medium text-ink truncate">{centerNode?.label ?? centerId}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <label htmlFor="graph-depth" className="text-caption text-ink-3">Depth</label>
              <select
                id="graph-depth"
                className="dw-input !w-auto !min-h-[36px] !py-1"
                value={depth}
                onChange={(e) => setDepth(Number(e.target.value) as GraphDepth)}
              >
                <option value={1}>1</option>
                <option value={2}>2</option>
                <option value={3}>3</option>
              </select>
            </div>
          </div>

          {truncated && loadState === 'ready' && (
            <p role="status" className="text-caption text-warn-ink dark:text-brass-200 flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" /> Showing a partial view — reduce depth or search for a narrower start point to see everything.
            </p>
          )}
          {loadState === 'loading' && (
            <p className="text-ink-3 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Loading graph…</p>
          )}
          {loadState === 'error' && (
            <p role="alert" className="text-warn-ink dark:text-brass-200 flex flex-wrap items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" /> {error}
              <button type="button" className="dw-btn-tertiary !min-h-[32px] !py-1" onClick={() => centerId && load(centerId, depth)}>Retry</button>
            </p>
          )}
          {loadState === 'ready' && nodes.length === 0 && <p className="text-ink-3">No connections found for this record.</p>}

          <div aria-live="polite" className="sr-only">{liveMessage}</div>

          <div className="flex flex-col sm:flex-row gap-4 min-w-0">
            <div className="relative flex-1 min-w-0">
              <div
                ref={canvasRef}
                role="img"
                aria-label={`Graph centered on ${centerNode?.label ?? centerId}, ${nodes.length} record${nodes.length === 1 ? '' : 's'} shown`}
                className="h-[420px] w-full rounded-lg border border-line bg-surface"
              />
              {hoverEdge && (
                <div
                  aria-hidden="true"
                  style={{ position: 'fixed', left: hoverEdge.x, top: hoverEdge.y }}
                  className="pointer-events-none z-20 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md bg-stone-900 text-stone-50 text-caption px-2.5 py-1.5 shadow-lift"
                >
                  {hoverEdge.label}
                </div>
              )}
              <Legend dark={dark} />
            </div>
            <aside className="sm:w-72 shrink-0 space-y-5 min-w-0" aria-label="Related records (screen-reader list)">
              <EdgeGroupList title="Backlinks" groups={backlinks} onOpen={recenter} />
              <EdgeGroupList title="Links" groups={links} onOpen={recenter} />
            </aside>
          </div>
        </>
      )}

      {preview && <DocumentPreview documentId={preview.documentId} location={preview.location} onClose={() => setPreview(null)} />}
    </section>
  );
}
