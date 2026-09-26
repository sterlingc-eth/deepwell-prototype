import { useEffect, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronUp, Loader2, RefreshCw, Users2, XCircle } from 'lucide-react';
import {
  fetchDuplicateClusters,
  acceptDuplicateCluster,
  rejectDuplicateCluster,
  undoDuplicateMerge,
  type DuplicateCluster,
} from '../services/entityMergeClient';

/**
 * Admin-only "Possible duplicate customers" card (Round 11, entity-resolution
 * clustering — M3-config/39-entity-resolution.sql, api/_lib/entities/{similarity,
 * resolve}.js) — Team screen, mirrors DonovanMissesCard/FollowupsCard's
 * collapsed-by-default dw-card styling exactly.
 *
 * Distinct from CustomersScreen's own per-customer duplicate banner: this
 * scans the WHOLE tenant, clusters (not just pairs — 3+ records than name the
 * same person/company all group together), and shows every reason a cluster
 * was flagged plus the evidence documents behind it, so an admin can decide
 * without opening each customer individually. NEVER auto-merges: every
 * cluster here is a suggestion until Accept is clicked.
 */
function reasonLine(reasons: string[]): string {
  const first = reasons[0];
  if (!first) return 'Possible duplicate';
  return first.charAt(0).toUpperCase() + first.slice(1);
}

function ClusterRow({
  cluster, busy, onAccept, onReject,
}: {
  cluster: DuplicateCluster;
  busy: boolean;
  onAccept: (cluster: DuplicateCluster) => void;
  onReject: (cluster: DuplicateCluster) => void;
}) {
  return (
    <li className="dw-card p-3 space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-body text-ink font-medium">{reasonLine(cluster.reasons)}</p>
          {cluster.reasons.length > 1 && (
            <p className="text-caption text-ink-3">{cluster.reasons.slice(1).join(' · ')}</p>
          )}
        </div>
        <div className="flex gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => onAccept(cluster)}
            disabled={busy}
            className="dw-btn-primary !min-h-[32px] !py-0.5"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />}
            Merge
          </button>
          <button
            type="button"
            onClick={() => onReject(cluster)}
            disabled={busy}
            className="dw-btn-tertiary !min-h-[32px] !py-0.5"
          >
            <XCircle className="w-3.5 h-3.5" aria-hidden="true" /> Not the same
          </button>
        </div>
      </div>
      <ul className="divide-y divide-line">
        {cluster.entities.map((e) => (
          <li key={e.id} className="py-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
            <div className="min-w-0">
              <span className="text-body text-ink">{e.name ?? 'Unnamed customer'}</span>
              {e.id === cluster.suggestedKeepId && <span className="dw-pill-muted ml-2">Keeps this record</span>}
              <p className="text-caption text-ink-3 truncate">
                {[e.customerNumber, e.address, e.phone, e.email].filter(Boolean).join(' · ') || 'No contact details on file'}
              </p>
            </div>
            {e.documents.length > 0 && (
              <span className="text-caption text-ink-3 shrink-0">
                {e.documents.length} document{e.documents.length === 1 ? '' : 's'}
              </span>
            )}
          </li>
        ))}
      </ul>
    </li>
  );
}

export function DuplicateCustomersCard() {
  const [clusters, setClusters] = useState<DuplicateCluster[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyClusterId, setBusyClusterId] = useState<string | null>(null);
  const [undoState, setUndoState] = useState<{ suggestionId: string; label: string } | null>(null);
  const [undoing, setUndoing] = useState(false);

  const load = () => {
    setLoading(true);
    setError(null);
    fetchDuplicateClusters()
      .then((res) => setClusters(res.clusters.filter((c) => c.status === 'pending')))
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load possible duplicates.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (open && clusters === null && !loading) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const acceptCluster = async (cluster: DuplicateCluster) => {
    setBusyClusterId(cluster.clusterId);
    setError(null);
    try {
      const keep = cluster.entities.find((e) => e.id === cluster.suggestedKeepId);
      const result = await acceptDuplicateCluster(cluster.entityIds, {
        keepId: cluster.suggestedKeepId,
        suggestionId: cluster.id ?? undefined,
        clusterId: cluster.clusterId,
      });
      setClusters((cur) => (cur ?? []).filter((c) => c.clusterId !== cluster.clusterId));
      if (result.id) {
        setUndoState({ suggestionId: result.id, label: `Merged into ${keep?.name ?? 'the surviving record'}.` });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not merge these customers.');
    } finally {
      setBusyClusterId(null);
    }
  };

  const rejectCluster = async (cluster: DuplicateCluster) => {
    setBusyClusterId(cluster.clusterId);
    setError(null);
    try {
      await rejectDuplicateCluster(cluster.entityIds, cluster.clusterId);
      setClusters((cur) => (cur ?? []).filter((c) => c.clusterId !== cluster.clusterId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save that decision.');
    } finally {
      setBusyClusterId(null);
    }
  };

  const undo = async () => {
    if (!undoState) return;
    setUndoing(true);
    try {
      await undoDuplicateMerge(undoState.suggestionId);
      setUndoState(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not undo that merge.');
    } finally {
      setUndoing(false);
    }
  };

  const count = clusters?.length ?? 0;

  return (
    <div className="dw-card p-4 space-y-3">
      <button type="button" className="w-full flex items-center justify-between text-left" onClick={() => setOpen((v) => !v)}>
        <span className="text-body font-medium text-ink flex items-center gap-2">
          <Users2 className="w-4 h-4" aria-hidden="true" />
          Possible duplicate customers
          {clusters !== null && <span className={count > 0 ? 'dw-pill-warn' : 'dw-pill-muted'}>{count}</span>}
        </span>
        {open ? <ChevronUp className="w-4 h-4" aria-hidden="true" /> : <ChevronDown className="w-4 h-4" aria-hidden="true" />}
      </button>

      {open && (
        <div className="space-y-3 pt-1">
          <p className="text-caption text-ink-3">
            Customer records that look like the same person or company — matched on name, phone, email or address.
            Nothing merges on its own; review each group and choose Merge or Not the same.
          </p>

          {error && <p role="alert" className="text-caption text-bad-ink">{error}</p>}

          {undoState && (
            <div role="status" className="dw-card border-ok/40 px-3 py-2 flex items-center justify-between gap-3 flex-wrap">
              <span className="text-caption text-ink-2">{undoState.label}</span>
              <button type="button" onClick={() => void undo()} disabled={undoing} className="dw-btn-tertiary !min-h-[28px] !py-0 underline">
                {undoing ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : null} Undo
              </button>
            </div>
          )}

          {loading && clusters === null && (
            <p className="text-body text-ink-3 flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Scanning for duplicates…
            </p>
          )}

          {clusters && clusters.length === 0 && (
            <p className="text-body text-ink-3">No possible duplicates found.</p>
          )}

          {clusters && clusters.length > 0 && (
            <ul className="space-y-2">
              {clusters.map((c) => (
                <ClusterRow
                  key={c.clusterId}
                  cluster={c}
                  busy={busyClusterId === c.clusterId}
                  onAccept={(cl) => void acceptCluster(cl)}
                  onReject={(cl) => void rejectCluster(cl)}
                />
              ))}
            </ul>
          )}

          <button type="button" onClick={load} disabled={loading} className="dw-btn-tertiary !min-h-[32px] !py-0.5">
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />}
            Refresh
          </button>
        </div>
      )}
    </div>
  );
}
