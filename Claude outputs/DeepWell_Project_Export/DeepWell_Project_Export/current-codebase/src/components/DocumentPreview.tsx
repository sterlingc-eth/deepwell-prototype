import { useEffect, useMemo, useRef, useState } from 'react';
import { X, AlertTriangle, ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react';
import type { Doc, ExtractedField, Facet, SourceLocation } from '../core/types';
import { useGraph } from '../core/entityGraph';
import { useAppStore } from '../store/appStore';
import { StagePill } from './StagePill';
import { locationLabel } from './SourceList';
import { useFocusTrap } from './useFocusTrap';
import { loadPageRenderings, type FieldBox, type PageRenderings } from './pageRenderings';

interface DocumentPreviewProps {
  documentId: string;
  location?: SourceLocation;
  /**
   * Highlight one facet found by the universal reading pass (see
   * docs/INGEST_API.md) instead of — or in addition to — a cited extracted
   * field. Facet boxes are stored as fractions (0–1) of the page, unlike
   * `FieldBox`'s page-unit boxes, so they're drawn as a percentage of the
   * displayed image directly and need no page-rendering sidecar to line up.
   */
  facetId?: string;
  onClose: () => void;
}

/**
 * Real uploads (M2) hold their page images in memory on the doc itself
 * (`doc.pageImages`, base64 data URLs from the receive pipeline step) rather
 * than as a `/docs/<id>.json` sidecar — see docs/INGEST_API.md, "Pipeline",
 * item 1. Falls back to this when the sidecar fetch resolves to `null`, so a
 * real upload previews just like a seeded document; field boxes stay empty
 * (extracted fields carry no bbox from the mapping pass), which degrades to
 * the extracted-fields list beneath the image exactly as a missing sidecar
 * already does today.
 */
function syntheticRenderingsFromDoc(doc: Doc | undefined): PageRenderings | null {
  if (!doc?.pageImages?.length) return null;
  return { pages: doc.pageImages.map((url) => ({ url, width: 816, height: 1056, fields: {} })) };
}

/** Zoomed page width as a multiple of the dialog width — 13 px print reads at arm's length on a phone. */
const ZOOM = 2.2;

/** Brass highlight + one short "ring" when it appears. Reduced motion is honoured globally (index.css) and here. */
const HIGHLIGHT_CSS = `
@keyframes dw-cite-ring { 0% { box-shadow: 0 0 0 0 rgba(185, 138, 78, 0.6); } 100% { box-shadow: 0 0 0 14px rgba(185, 138, 78, 0); } }
.dw-cite-box { border: 3px solid #B98A4E; background: rgba(185, 138, 78, 0.22); border-radius: 3px; animation: dw-cite-ring 280ms ease-out 1 both; }
@media (prefers-reduced-motion: reduce) { .dw-cite-box { animation: none; } }
`;

/**
 * Which extracted field a citation points at. Citations carry the label as
 * printed ("Serial No.") or a region hint ("nameplate, lower left"); the seed
 * stores that hint in location.field, so match on it first, then by name.
 */
function citedFieldName(doc: Doc, location: SourceLocation | undefined): string | undefined {
  const wanted = location?.field?.trim().toLowerCase();
  if (!wanted) return undefined;
  const samePage = (f: ExtractedField) => location?.page === undefined || (f.location.page ?? 1) === location.page;
  const byLocation = doc.extracted.find((f) => samePage(f) && f.location.field?.toLowerCase() === wanted);
  if (byLocation) return byLocation.name;
  const byName = doc.extracted.find((f) => samePage(f) && f.name.toLowerCase() === wanted);
  if (byName) return byName.name;
  const byPrefix = doc.extracted.find((f) => wanted.startsWith(f.name.toLowerCase()) || f.name.toLowerCase().startsWith(wanted));
  return byPrefix?.name;
}

function boxFor(renderings: PageRenderings | null, field: string | undefined): FieldBox | undefined {
  if (!renderings || !field) return undefined;
  for (const page of renderings.pages) {
    const box = page.fields[field];
    if (box) return box;
  }
  return undefined;
}

/**
 * The original, one tap away. Renders the cited page of the document with the
 * cited field boxed in brass, the fields extracted from that page beneath it,
 * and where the document sits in the pipeline. Escape closes; focus returns to
 * where it came from. When no page rendering exists yet, the extracted text
 * stands in for the page.
 */
export function DocumentPreview({ documentId, location, facetId, onClose }: DocumentPreviewProps) {
  const doc = useGraph((s) => s.docs[documentId]);
  const batch = useGraph((s) => (doc ? s.batches[doc.batchId] : undefined));
  const schema = useGraph((s) => s.schema);
  const setCurrentScreen = useAppStore((s) => s.setCurrentScreen);
  const openDocument = useAppStore((s) => s.openDocument);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);

  // Page renderings, tagged with the document they belong to: undefined while
  // loading (or stale from a previous document), null when the document has none.
  const [loaded, setLoaded] = useState<{ id: string; data: PageRenderings | null } | null>(null);
  const fetched: PageRenderings | null | undefined = loaded?.id === documentId ? loaded.data : undefined;
  // A real upload has no `/docs/<id>.json` sidecar — fall back to the page images the receive step held on the doc itself.
  const renderings: PageRenderings | null | undefined = fetched === null ? syntheticRenderingsFromDoc(doc) : fetched;
  useEffect(() => {
    let live = true;
    void loadPageRenderings(documentId).then((data) => {
      if (live) setLoaded({ id: documentId, data });
    });
    return () => {
      live = false;
    };
  }, [documentId]);

  const facet: Facet | undefined = useMemo(() => (facetId ? (doc?.facets ?? []).find((f) => f.id === facetId) : undefined), [doc, facetId]);
  const citedName = useMemo(() => (doc ? citedFieldName(doc, location) : undefined), [doc, location]);
  const [activeField, setActiveField] = useState<string | undefined>(citedName);
  /** Page the user navigated to; undefined means "the page the citation lives on". */
  const [chosenPage, setChosenPage] = useState<number | undefined>(undefined);
  const [imageReady, setImageReady] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const citedBox = boxFor(renderings ?? null, citedName);
  const page = chosenPage ?? facet?.page ?? citedBox?.page ?? location?.page ?? 1;

  // Focus trap: initial focus on Close, Tab wraps, Escape closes, focus restored on close.
  useFocusTrap(!!doc, dialogRef, { initialFocus: closeRef, onEscape: onClose });

  // Body scroll lock while the preview is open.
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  const activeBox = boxFor(renderings ?? null, activeField);
  const pageCount = renderings?.pages.length ?? doc?.pages ?? 1;
  const currentPage = Math.min(Math.max(page, 1), pageCount);
  const rendering = renderings?.pages[currentPage - 1];
  const showBox = !!activeBox && !!rendering && activeBox.page === currentPage;
  const showFacetBox = !!facet && !!rendering && facet.page === currentPage;

  // Bring the highlighted field or facet into view once the page image has drawn.
  useEffect(() => {
    if ((!showBox && !showFacetBox) || !imageReady) return;
    highlightRef.current?.scrollIntoView({ block: 'center', inline: 'center' });
  }, [showBox, showFacetBox, imageReady, activeField, facet, currentPage, zoomed]);

  if (!doc) return null;
  const typeLabel = schema.documentTypes.find((t) => t.id === doc.typeId)?.label ?? 'Unclassified';
  const fieldsOnPage = doc.extracted.filter((f) => (f.location.page ?? 1) === currentPage);
  const highlightField = activeField?.toLowerCase();

  const goTo = (n: number) => {
    setImageReady(false);
    setChosenPage(Math.min(Math.max(n, 1), pageCount));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6" role="presentation">
      <style>{HIGHLIGHT_CSS}</style>
      <button type="button" aria-label="Close preview" onClick={onClose} className="absolute inset-0 bg-stone-950/50 cursor-default" tabIndex={-1} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="preview-title"
        className="relative w-full sm:max-w-2xl max-h-[92vh] sm:max-h-[85vh] flex flex-col bg-surface text-ink rounded-t-xl sm:rounded-xl shadow-modal animate-rise"
      >
        <header className="flex items-start gap-3 px-5 py-4 border-b border-line">
          <div className="min-w-0 flex-1">
            <p className="dw-label">{typeLabel}</p>
            <h2 id="preview-title" className="font-sans font-semibold text-h3 truncate">
              {doc.filename}
            </h2>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-body text-ink-2">
              <StagePill stage={doc.stage} />
              {batch && <span>· {batch.name}</span>}
              <span>
                · {doc.pages} page{doc.pages === 1 ? '' : 's'}
              </span>
              {location && locationLabel(location) && <span>· cited at {locationLabel(location)}</span>}
            </div>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close" className="dw-btn-tertiary -mr-2 min-w-touch">
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </header>

        <div className="overflow-y-auto overflow-x-hidden px-5 py-4 space-y-4">
          {doc.issues.length > 0 && (
            <ul className="space-y-1">
              {doc.issues.map((i, idx) => (
                <li key={idx} className="flex items-center gap-2 text-body text-warn-ink dark:text-brass-200">
                  <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
                  {i.kind === 'missing-field' && <span>Missing required field: {i.field}</span>}
                  {i.kind === 'unlinked' && (
                    <span>
                      Not linked to any record
                      {i.bestGuess ? ` (best guess ${Math.round(i.confidence * 100)}%)` : ''}
                    </span>
                  )}
                  {i.kind === 'conflict' && <span>Disagrees with another document — needs a decision</span>}
                  {i.kind === 'duplicate' && <span>Duplicate of a document already in the system</span>}
                  {i.kind === 'possible-duplicate' && <span>Looks like a possible duplicate of another document</span>}
                  {i.kind === 'inconsistent-facet' && <span>“{i.labelRaw}” doesn't match another document — not yet a mapped field</span>}
                </li>
              ))}
            </ul>
          )}

          {renderings === undefined && (
            // Neutral skeleton while the page loads: a Letter-shaped block, nothing else.
            <div aria-busy="true" className="w-full rounded-lg border border-line bg-surface-2" style={{ aspectRatio: '816 / 1056' }} />
          )}

          {renderings && rendering && (
            <figure className="m-0">
              <div
                className={`w-full rounded-lg border border-line bg-stone-100 dark:bg-stone-800 ${zoomed ? 'overflow-auto max-h-[60vh] overscroll-contain' : 'overflow-hidden'}`}
              >
                <div className="relative" style={{ width: zoomed ? `${ZOOM * 100}%` : '100%' }}>
                  <img
                    key={rendering.url}
                    src={rendering.url}
                    width={rendering.width}
                    height={rendering.height}
                    alt={`${doc.filename}, page ${currentPage} of ${pageCount}`}
                    className="block w-full h-auto max-w-full select-none"
                    draggable={false}
                    onLoad={() => setImageReady(true)}
                  />
                  {showBox && (
                    // Percent geometry: the box tracks the image at any rendered size, no measuring needed.
                    <div
                      ref={highlightRef}
                      key={`${activeField ?? ''}:${currentPage}`}
                      className="dw-cite-box absolute pointer-events-none"
                      aria-hidden="true"
                      style={{
                        left: `${(activeBox.x / rendering.width) * 100}%`,
                        top: `${(activeBox.y / rendering.height) * 100}%`,
                        width: `${(activeBox.w / rendering.width) * 100}%`,
                        height: `${(activeBox.h / rendering.height) * 100}%`,
                      }}
                    />
                  )}
                  {showFacetBox && facet && (
                    // Facet bboxes (docs/INGEST_API.md) are already fractions (0–1) of the page, so
                    // they're plotted directly as a percentage of the image — no width/height division needed.
                    <div
                      ref={showBox ? undefined : highlightRef}
                      key={`facet:${facet.id}:${currentPage}`}
                      className="dw-cite-box absolute pointer-events-none"
                      aria-hidden="true"
                      style={{
                        left: `${facet.bbox.x * 100}%`,
                        top: `${facet.bbox.y * 100}%`,
                        width: `${facet.bbox.w * 100}%`,
                        height: `${facet.bbox.h * 100}%`,
                      }}
                    />
                  )}
                </div>
              </div>
              <figcaption className="sr-only">
                {activeField && showBox
                  ? `${activeField} is highlighted on page ${currentPage}.`
                  : showFacetBox && facet
                    ? `${facet.labelRaw} is highlighted on page ${currentPage}.`
                    : `Page ${currentPage} of ${pageCount}.`}
              </figcaption>

              <nav aria-label="Pages" className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <button type="button" className="dw-btn-secondary" aria-pressed={zoomed} onClick={() => setZoomed((z) => !z)}>
                  {zoomed ? <ZoomOut className="w-4 h-4" aria-hidden="true" /> : <ZoomIn className="w-4 h-4" aria-hidden="true" />}
                  {zoomed ? 'Full page' : 'Zoom in'}
                </button>
                {pageCount > 1 && (
                  <div className="flex items-center gap-2">
                    <button type="button" className="dw-btn-secondary" onClick={() => goTo(currentPage - 1)} disabled={currentPage <= 1} aria-label="Previous page">
                      <ChevronLeft className="w-4 h-4" aria-hidden="true" />
                      Prev
                    </button>
                    <span className="text-body text-ink-2 tabular-nums px-1" aria-live="polite">
                      {currentPage} / {pageCount}
                      {activeBox && activeBox.page !== currentPage && (
                        <>
                          {' '}
                          ·{' '}
                          <button type="button" className="underline underline-offset-2 text-forest-700 dark:text-brass-300" onClick={() => goTo(activeBox.page)}>
                            cited on page {activeBox.page}
                          </button>
                        </>
                      )}
                    </span>
                    <button type="button" className="dw-btn-secondary" onClick={() => goTo(currentPage + 1)} disabled={currentPage >= pageCount} aria-label="Next page">
                      Next
                      <ChevronRight className="w-4 h-4" aria-hidden="true" />
                    </button>
                  </div>
                )}
              </nav>
            </figure>
          )}

          {renderings && (
            <section aria-labelledby="preview-fields-heading">
              <h3 id="preview-fields-heading" className="dw-label mb-2">
                Extracted from this page <span className="text-ink-3 normal-case font-normal">· {fieldsOnPage.length}</span>
              </h3>
              {fieldsOnPage.length === 0 ? (
                <p className="text-body text-ink-3">Nothing extracted from this page yet.</p>
              ) : (
                <ul className="rounded-lg border border-line divide-y divide-line bg-bg">
                  {fieldsOnPage.map((f) => {
                    const hasBox = !!rendering?.fields[f.name];
                    const isActive = f.name === activeField;
                    const isCited = f.name === citedName;
                    return (
                      <li key={f.name}>
                        <button
                          type="button"
                          disabled={!hasBox}
                          aria-current={isActive ? 'true' : undefined}
                          onClick={() => setActiveField(f.name)}
                          className={`w-full text-left flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2 min-h-touch sm:min-h-0 sm:py-1.5 transition-colors duration-quick disabled:cursor-default ${
                            isActive ? 'bg-brass-100 dark:bg-forest-700 text-ink' : 'hover:bg-surface-2'
                          }`}
                        >
                          <span className="text-body text-ink-3 w-36 shrink-0">{f.name}</span>
                          <span className="font-mono text-data sm:text-[14px] text-ink break-words min-w-0 flex-1">{f.value}</span>
                          {f.correctedValue && (
                            <span className="text-caption text-ink-3">
                              corrected to <span className="font-mono text-ink-2">{f.correctedValue}</span>
                            </span>
                          )}
                          {isCited && <span className="dw-pill bg-brass-100 text-brass-800 dark:bg-forest-700 dark:text-brass-200">Cited</span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}

          {renderings === null && (
            <>
              <p className="text-body text-ink-3">Original page not available for this document.</p>
              <div className="rounded-lg border border-line bg-bg p-4 font-mono text-data sm:text-[14px] sm:leading-6 whitespace-pre-wrap">
                {doc.preview.split('\n').map((line, i) => {
                  const key = line.split(':')[0]?.trim().toLowerCase();
                  const hit = !!highlightField && !!key && line.includes(':') && (key === highlightField || highlightField.startsWith(key));
                  return (
                    <div key={i} className={hit ? 'bg-brass-100 dark:bg-forest-700 -mx-2 px-2 rounded-sm text-ink' : ''}>
                      {line || ' '}
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {doc.verifiedBy && doc.verifiedAt && (
            <p className="text-caption text-ink-3">
              Verified by {doc.verifiedBy} on{' '}
              {doc.verifiedAt.toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
              })}
              .
            </p>
          )}
        </div>

        <footer className="px-5 py-3 border-t border-line flex flex-wrap gap-2 justify-end">
          {doc.stage !== 'verified' && (
            <button
              type="button"
              className="dw-btn-secondary"
              onClick={() => {
                onClose();
                openDocument(doc.id);
                setCurrentScreen('review');
              }}
            >
              Open in review
            </button>
          )}
          <button type="button" className="dw-btn-primary" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
