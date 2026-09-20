import { useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { AlertTriangle, Loader2, ShieldCheck, Sparkles } from 'lucide-react';
import { isAdminRole } from '../services/teamClient';
import { ALL_INTEGRITY_FIXES, reviewClient, isIntegrityFixDebounced, type IntegrityFixApplied, type IntegrityScanResult } from '../services/reviewClient';

const SUMMARY_ROWS: { key: keyof IntegrityScanResult['counts']; label: string }[] = [
  { key: 'duplicateCustomers', label: 'Duplicate customers' },
  { key: 'unlinkedDocuments', label: 'Unlinked documents' },
  { key: 'equipmentWithoutCustomer', label: 'Units without a customer' },
  { key: 'multiUnitDocsUnderLinked', label: 'Multi-unit docs under-linked' },
  { key: 'shopContactLeaks', label: 'Shop phone/email on a customer' },
  { key: 'mismatchedNameLinks', label: 'Wrong-name links' },
  { key: 'splitLinkDocuments', label: 'Split customer links' },
  { key: 'ambiguousNameOnlyLinks', label: 'Ambiguous name-only links' },
];

/**
 * "Check records" (owner request 2026-09-20, item 3) — shared between the
 * Customers tab and Dashboard's data-health strip so the copy and behavior
 * never drift between the two spots. Read-only scan is open to anyone; the
 * one-click fix is admin-only in the UI (the server enforces the same rule
 * again, same as deleteDocuments).
 */
export function IntegrityPanel({ onApplied }: { onApplied?: () => void }) {
  const { orgRole } = useAuth();
  const isAdmin = isAdminRole(orgRole ?? null);

  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<IntegrityScanResult | null>(null);
  const [scanErr, setScanErr] = useState<string | null>(null);
  const [fixing, setFixing] = useState(false);
  const [fixResult, setFixResult] = useState<IntegrityFixApplied | null>(null);
  const [fixErr, setFixErr] = useState<string | null>(null);

  // Review fix (2026-09-20, reviewer NO-GO item 2): relinkMismatchedNames
  // repoints a document from one customer to another, so it is its own
  // reviewable action — never part of "Fix everything" — with its own
  // explicit confirm and its own busy/result state.
  const [relinking, setRelinking] = useState(false);
  const [relinkResult, setRelinkResult] = useState<IntegrityFixApplied | null>(null);
  const [relinkErr, setRelinkErr] = useState<string | null>(null);

  const runScan = async () => {
    setScanning(true);
    setScanErr(null);
    try {
      setResult(await reviewClient.integrityScan());
    } catch (e) {
      setScanErr(e instanceof Error ? e.message : 'Could not check your records.');
    } finally {
      setScanning(false);
    }
  };

  const runFix = async () => {
    setFixing(true);
    setFixErr(null);
    setFixResult(null);
    try {
      const r = await reviewClient.integrityFix(ALL_INTEGRITY_FIXES, false);
      // The 10-minute server debounce only ever applies to a link-only sweep
      // (linkDocuments/linkEquipmentCustomers alone, e.g. the Inbox auto-fix)
      // — this button always sends ALL_INTEGRITY_FIXES, so it never actually
      // hits it, but the return type is still the shared union.
      if (isIntegrityFixDebounced(r)) {
        setFixErr('A fix already ran recently — try again in a few minutes.');
      } else {
        setFixResult(r);
        await runScan();
        onApplied?.();
      }
    } catch (e) {
      setFixErr(e instanceof Error ? e.message : 'Could not fix those records.');
    } finally {
      setFixing(false);
    }
  };

  const runRelink = async () => {
    setRelinking(true);
    setRelinkErr(null);
    setRelinkResult(null);
    try {
      // Explicit dryRun:false — relinkMismatchedNames treats anything else
      // (including simply omitting it) as preview-only.
      const r = await reviewClient.integrityFix(['relinkMismatchedNames'], false);
      if (isIntegrityFixDebounced(r)) {
        setRelinkErr('A fix already ran recently — try again in a few minutes.');
      } else {
        setRelinkResult(r);
        await runScan();
        onApplied?.();
      }
    } catch (e) {
      setRelinkErr(e instanceof Error ? e.message : 'Could not relink those documents.');
    } finally {
      setRelinking(false);
    }
  };

  const total = result ? Object.values(result.counts).reduce((a, b) => a + b, 0) : null;
  const mismatchedCount = result?.mismatchedNameLinks.length ?? 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="dw-btn-secondary !min-h-[36px] !py-1.5" disabled={scanning} onClick={() => void runScan()}>
          <ShieldCheck className="w-4 h-4" aria-hidden="true" /> {scanning ? 'Checking…' : 'Check records'}
        </button>
        {scanErr && <span role="alert" className="flex items-center gap-1 text-caption text-warn-ink dark:text-brass-200"><AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" /> {scanErr}</span>}
      </div>

      {result && (
        <div className="dw-card p-4 space-y-3">
          <p className="text-body text-ink-2">
            {total === 0 ? 'Everything checks out — nothing needs fixing right now.' : `Found ${total} thing${total === 1 ? '' : 's'} worth a look.`}
          </p>
          {(total ?? 0) > 0 && (
            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {SUMMARY_ROWS.map(({ key, label }) => (
                <div key={key}>
                  <dt className="text-caption text-ink-3">{label}</dt>
                  <dd className="font-display text-h3">{result.counts[key]}</dd>
                </div>
              ))}
            </dl>
          )}
          {(total ?? 0) > 0 && (
            isAdmin ? (
              <div className="space-y-2">
                <button type="button" className="dw-btn-primary" disabled={fixing} onClick={() => void runFix()}>
                  {fixing ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Sparkles className="w-4 h-4" aria-hidden="true" />} {fixing ? 'Fixing…' : 'Fix everything Donovan is sure about'}
                </button>
                {fixErr && <p role="alert" className="text-caption text-warn-ink dark:text-brass-200">{fixErr}</p>}
                {fixResult && (
                  <p className="text-caption text-ink-3">
                    Merged {fixResult.merged.length} duplicate{fixResult.merged.length === 1 ? '' : 's'} · linked {fixResult.documentsLinked.length} document{fixResult.documentsLinked.length === 1 ? '' : 's'} to a customer ·
                    linked {fixResult.equipmentLinked.length} unit{fixResult.equipmentLinked.length === 1 ? '' : 's'} to a customer · created {fixResult.unitsCreated.length} missing unit{fixResult.unitsCreated.length === 1 ? '' : 's'} ·
                    stripped {fixResult.shopContactStripped.length} shop contact field{fixResult.shopContactStripped.length === 1 ? '' : 's'}.
                  </p>
                )}
                {mismatchedCount > 0 && (
                  <div className="space-y-2 pt-2 border-t border-line">
                    <p className="text-body text-ink-2">
                      {mismatchedCount} document{mismatchedCount === 1 ? '' : 's'} {mismatchedCount === 1 ? 'is' : 'are'} linked to a customer whose name doesn't match what the document itself says — repointing this moves the document (and any equipment only it introduced) to the right customer.
                    </p>
                    <button type="button" className="dw-btn-secondary !min-h-[36px] !py-1.5" disabled={relinking} onClick={() => void runRelink()}>
                      {relinking ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Sparkles className="w-4 h-4" aria-hidden="true" />} {relinking ? 'Relinking…' : `Relink ${mismatchedCount} document${mismatchedCount === 1 ? '' : 's'} Donovan is sure about`}
                    </button>
                    {relinkErr && <p role="alert" className="text-caption text-warn-ink dark:text-brass-200">{relinkErr}</p>}
                    {relinkResult && (
                      <p className="text-caption text-ink-3">
                        Relinked {relinkResult.mismatchedNamesRelinked.length} document{relinkResult.mismatchedNamesRelinked.length === 1 ? '' : 's'} to the right customer.
                      </p>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <p className="text-caption text-ink-3">Ask an admin to apply fixes.</p>
            )
          )}
        </div>
      )}
    </div>
  );
}
