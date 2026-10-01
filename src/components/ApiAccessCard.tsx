import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import { keysClient, type ApiKeyRow } from '../services/keysClient';
import { hasApiAccess, type BillingPlanId } from '../services/billingClient';
import { useCanAdmin } from '../hooks/useCanAdmin';
import { AskAdminNote } from './AskAdminNote';

/**
 * API access (Round 26): Fleet-only. Every other plan sees an upgrade prompt; Fleet gets a small key manager
 * (list / create / revoke) backed by /api/keys. The server enforces the same rule — this card is presentation.
 */
export function ApiAccessCard({ plan, onUpgrade }: { plan: BillingPlanId | null; onUpgrade: () => void }) {
  const allowed = hasApiAccess(plan);
  const canAdmin = useCanAdmin();
  return (
    <section className="dw-card p-5 space-y-3" aria-labelledby="api-access-heading">
      <h2 id="api-access-heading" className="text-h3 flex items-center gap-2">
        <KeyRound className="w-4 h-4" aria-hidden="true" />
        API access
      </h2>
      {allowed && !canAdmin ? (
        <p className="text-ink-2">
          API keys are managed by a company admin. <AskAdminNote />
        </p>
      ) : allowed ? (
        <KeyManager />
      ) : (
        <>
          <p className="text-ink-2">API access is included on the Fleet plan. Upgrade to connect your own systems to DeepWell with API keys.</p>
          <button type="button" className="dw-btn-secondary" onClick={onUpgrade}>
            See Fleet
          </button>
        </>
      )}
    </section>
  );
}

function KeyManager() {
  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);

  const [tick, setTick] = useState(0);
  const load = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    let live = true;
    keysClient
      .list()
      .then((k) => { if (live) setKeys(k); })
      .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : 'Could not load keys.'); });
    return () => { live = false; };
  }, [tick]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const made = await keysClient.create(name.trim() || 'API key', ['read', 'ingest', 'ask']);
      setFresh(made.key);
      setName('');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the key.');
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await keysClient.revoke(id);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not revoke the key.');
    } finally {
      setBusy(false);
    }
  };

  const live = (keys ?? []).filter((k) => !k.revoked);
  return (
    <div className="space-y-3">
      <p className="text-ink-2">Keys let your own systems call the DeepWell API. A key is shown once, when you create it.</p>
      {fresh && (
        <p role="status" className="dw-card px-3 py-2 text-body break-all">
          Copy your new key now — it will not be shown again: <code>{fresh}</code>
        </p>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="dw-label block mb-1.5">Key name</span>
          <input className="dw-input w-56" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder="e.g. Dispatch system" />
        </label>
        <button type="button" className="dw-btn-primary" disabled={busy} onClick={() => void create()}>
          {busy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
          Create key
        </button>
      </div>
      {error && <p role="alert" className="text-caption text-bad-ink">{error}</p>}
      {keys && live.length === 0 && <p className="text-caption text-ink-3">No active keys.</p>}
      <ul className="divide-y divide-line">
        {live.map((k) => (
          <li key={k.id} className="py-2 flex items-center justify-between gap-2 text-body">
            <span>
              {k.name} <span className="text-ink-3">· dw_live_{k.keyPrefix}…</span>
            </span>
            <button type="button" className="underline text-caption" disabled={busy} onClick={() => void revoke(k.id)}>
              Revoke
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
