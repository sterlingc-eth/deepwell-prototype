import { useEffect, useRef, useState } from 'react';
import { X, AlertTriangle, Download, Loader2 } from 'lucide-react';
import type { SourceLocation } from '../core/types';
import { useGraph } from '../core/entityGraph';
import { customerForDocument } from '../core/customer';
import { useAppStore } from '../store/appStore';
import { StagePill } from './StagePill';
import { locationLabel } from './SourceList';
import { getOriginalUrl, type OriginalUrl } from '../services/documentClient';
import { requirementLabel } from '../domains/hvac/schema';
import { documentName, hasFriendlyName, originalFilename } from '../core/documentName';

// Server document ids are Postgres uuids; local ids minted before a sync
// completes look like "doc-<base36>-<base36>" (entityGraph.ts's newId). Only
// a real, synced id can be presigned — see the OPEN ORIGINAL contract.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface DocumentPreviewProps {
  documentId: string;
  location?: SourceLocation;
  onClose: () => void;
}

/**
 * The original, one tap away. Shows the document's extracted text with the
 * cited field highlighted, plus where it sits in the pipeline. Escape closes;
 * focus returns to where it came from.
 */
export function DocumentPreview({ documentId, location, onClose }: DocumentPreviewProps) {
  const doc = useGraph((s) => s.docs[documentId]);
  const batch = useGraph((s) => (doc ? s.batches[doc.batchId] : undefined));
  const schema = useGraph((s) => s.schema);
  const setCurrentScreen = useAppStore((s) => s.setCurrentScreen);
  const openDocument = useAppStore((s) => s.openDocument);
  const openEntity = useAppStore((s) => s.openEntity);
  const openCustomer = useAppStore((s) => s.openCustomer);
  const currentScreen = useAppStore((s) => s.currentScreen);
  const selectedEntityId = useAppStore((s) => s.selectedEntityId);
  const customerRef = useAppStore((s) => s.customerRef);
  const entities = useGraph((s) => s.entities);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  const [original, setOriginal] = useState<OriginalUrl | null>(null);
  const [textBody, setTextBody] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    setOriginal(null);
    setTextBody(null);
    setLoadState('idle');
    setLoadError(null);
    if (!UUID_RE.test(documentId)) return; // not synced yet — nothing to fetch
    let cancelled = false;
    setLoadState('loading');
    getOriginalUrl(documentId)
      .then(async (result) => {
        if (cancelled) return;
        setOriginal(result);
        if (result.contentType === 'text/plain') {
          const r = await fetch(result.url);
          if (cancelled) return;
          setTextBody(await r.text());
        }
        setLoadState('ready');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : 'Could not load the original file.');
        setLoadState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [documentId]);

  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      restoreRef.current?.focus?.();
    };
  }, [onClose]);

  if (!doc) return null;
  const typeLabel = schema.documentTypes.find((t) => t.id === doc.typeId)?.label ?? 'Unclassified';
  const lines = doc.preview.split('\n');
  const highlightField = location?.field?.toLowerCase();

  const bodyCustomerRaw = doc.linkedFromBodyName ? entities[doc.linkedFromBodyName]?.fields?.customer_name : undefined;
  const bodyCustomerName = typeof bodyCustomerRaw === 'string' ? bodyCustomerRaw : '';

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6" role="presentation">
      <button type="button" aria-label="Close preview" onClick={onClose} className="absolute inset-0 bg-stone-950/50 cursor-default" tabIndex={-1} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="preview-title"
        className="relative w-full sm:max-w-2xl max-h-[92vh] sm:max-h-[85vh] flex flex-col bg-surface text-ink rounded-t-xl sm:rounded-xl shadow-modal animate-rise"
      >
        <header className="flex items-start gap-3 px-5 py-4 border-b border-line">
          <div className="min-w-0 flex-1">
            <p className="dw-label">{typeLabel}</p>
            <h2 id="preview-title" className="font-sans font-semibold text-h3 truncate">
              {documentName(doc)}
            </h2>
            {hasFriendlyName(doc) && (
              <p className="text-caption text-ink-3 truncate">{originalFilename(doc)}</p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-2 text-body text-ink-2">
              <StagePill stage={doc.stage} />
              {batch && <span>· {batch.name}</span>}
              <span>· {doc.pages} page{doc.pages === 1 ? '' : 's'}</span>
              {location && locationLabel(location) && <span>· cited at {locationLabel(location)}</span>}
            </div>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close" className="dw-btn-tertiary -mr-2 min-w-touch">
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </header>

        <div className="overflow-y-auto px-5 py-4 space-y-4">
          {doc.issues.length > 0 && (
            <ul className="space-y-1">
              {doc.issues.map((i, idx) => (
                <li key={idx} className="flex items-center gap-2 text-body text-warn-ink dark:text-brass-200">
                  <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
                  {i.kind === 'missing-field' && <span>Missing required field: {requirementLabel(i.field)}</span>}
                  {i.kind === 'unlinked' && <span>Not linked to any record{i.bestGuess ? ` (best guess ${Math.round(i.confidence * 100)}%)` : ''}</span>}
                  {i.kind === 'conflict' && <span>Disagrees with another document — needs a decision</span>}
                  {i.kind === 'duplicate' && <span>Duplicate of a document already in the system</span>}
                  {i.kind === 'ambiguous-name-link' && <span>Two customers named {i.surname} — confirm which one</span>}
                </li>
              ))}
            </ul>
          )}

          {doc.linkedFromBodyName && (
            <p className="flex items-center gap-2 text-body text-ink-2" data-testid="body-name-chip">
              <span className="inline-flex items-center rounded-full border border-line bg-surface-2 px-2.5 py-0.5 text-caption">
                Linked from name in document — confirm
              </span>
              {bodyCustomerName && <span>{bodyCustomerName}</span>}
            </p>
          )}

          {UUID_RE.test(documentId) && (
            <div className="rounded-lg border border-line overflow-hidden">
              {loadState === 'loading' && (
                <div className="flex items-center gap-2 p-4 text-body text-ink-3">
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Loading original file…
                </div>
              )}
              {loadState === 'error' && (
                <p className="p-4 text-body text-warn-ink dark:text-brass-200">{loadError}</p>
              )}
              {loadState === 'ready' && original && (() => {
                const ct = original.contentType ?? '';
                if (ct === 'application/pdf') {
                  return <iframe src={original.url} title={original.filename} className="w-full min-h-[70vh] block" />;
                }
                if (ct.startsWith('image/')) {
                  return <img src={original.url} alt={original.filename} className="w-full h-auto block" />;
                }
                if (ct === 'text/plain') {
                  return (
                    <pre className="p-4 font-mono text-data sm:text-[14px] sm:leading-6 whitespace-pre-wrap max-h-[70vh] overflow-y-auto">
                      {textBody ?? ''}
                    </pre>
                  );
                }
                return (
                  <a
                    href={original.url}
                    download={original.filename}
                    className="dw-btn-secondary m-4 inline-flex"
                  >
                    <Download className="w-4 h-4" aria-hidden="true" /> Download {original.filename}
                  </a>
                );
              })()}
            </div>
          )}

          <div className="rounded-lg border border-line bg-bg p-4 font-mono text-data sm:text-[14px] sm:leading-6 whitespace-pre-wrap">
            {lines.map((line, i) => {
              const key = line.split(':')[0]?.trim().toLowerCase();
              const hit = !!highlightField && !!key && line.includes(':') && (key === highlightField || highlightField.startsWith(key));
              return (
                <div key={i} className={hit ? 'bg-brass-100 dark:bg-forest-700 -mx-2 px-2 rounded-sm text-ink' : ''}>
                  {line || ' '}
                </div>
              );
            })}
          </div>

          {doc.verifiedBy && doc.verifiedAt && (
            <p className="text-caption text-ink-3">
              Verified by {doc.verifiedBy} on {doc.verifiedAt.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}.
            </p>
          )}
        </div>

        <footer className="px-5 py-3 border-t border-line flex flex-wrap gap-2 justify-end">
          {(() => {
            // A linked customer takes priority — that's the record most
            // often worth opening from a document (invoice, warranty card),
            // and it's what CUSTOMER_PROFILES_BRIEF_2026-09-20.md section E
            // asks this link to prefer when one exists. Owner bug
            // (2026-09-20): opened from an equipment page, this pointed at
            // the very record already on screen, so the click "did nothing".
            // Never offer the record the person is already looking at; fall
            // back to a customer matched by name when no link exists.
            const onEntity = currentScreen === 'entity' ? selectedEntityId : null;
            const onCustomer = currentScreen === 'customer' ? customerRef : null;
            // customerForDocument (src/core/customer.ts): direct link, then
            // the linked unit's customer — same rule Browse/Review use, so
            // this button and those screens never disagree about who a
            // document belongs to (handoffs/LINKING_ROOT_CAUSE_2026-09-20.md).
            const linkedCustomer = customerForDocument(doc, entities)?.id;
            const extractedName = doc.extracted.find((f) => f.name === 'customer_name')?.value;
            const byName = !linkedCustomer && extractedName
              ? Object.values(entities).find(
                  (e) => e.type === 'customer' && String(e.fields.customer_name ?? '').trim().toLowerCase() === String(extractedName).trim().toLowerCase()
                )?.id
              : undefined;
            const customerId = linkedCustomer ?? byName;
            const otherEntity = doc.linkedEntityIds.find((id) => id !== onEntity && entities[id]?.type !== 'customer');
            let target: { kind: 'customer' | 'entity'; id: string; label: string } | null = null;
            if (customerId && customerId !== onCustomer) target = { kind: 'customer', id: customerId, label: 'View customer' };
            else if (otherEntity) target = { kind: 'entity', id: otherEntity, label: 'View record' };
            if (!target) return null;
            const t = target;
            return (
              <button
                type="button"
                className="dw-btn-secondary"
                onClick={() => {
                  onClose();
                  if (t.kind === 'customer') openCustomer(t.id);
                  else openEntity(t.id);
                }}
              >
                {t.label}
              </button>
            );
          })()}
          <button
            type="button"
            className="dw-btn-secondary"
            onClick={() => {
              onClose();
              openDocument(doc.id);
              setCurrentScreen('review');
            }}
          >
            Fix this document
          </button>
          <button type="button" className="dw-btn-primary" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
