import { useEffect, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { authHeader } from '../services/authToken';

interface Item { kind: 'expired' | 'expiring' | 'overdue' | 'due' | 'unreadable'; category: 'credential' | 'test'; label: string; date: string; days: number; note?: string }

const when = (i: Item) => (i.kind === 'unreadable' ? 'date unreadable' : i.days < 0 ? `${i.kind === 'overdue' ? 'overdue' : 'expired'} ${-i.days} day${i.days === -1 ? '' : 's'} ago` : i.days === 0 ? 'today' : `in ${i.days} day${i.days === 1 ? '' : 's'}`);

/** Electrical companies only: credentials and tests that need attention. Shows nothing for every other industry and on any failure. */
export function IndustryAttentionCard({ onAsk }: { onAsk?: (q: string) => void }) {
  const industry = useAppStore((s) => s.industry?.industry ?? 'hvac');
  const [items, setItems] = useState<Item[]>([]);
  useEffect(() => {
    if (industry !== 'electrical') return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/account?action=industry', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeader()) }, body: JSON.stringify({ op: 'attention' }) });
        if (!res.ok) return;
        const data = (await res.json()) as { items?: Item[] };
        if (!cancelled) setItems(Array.isArray(data.items) ? data.items : []);
      } catch { /* a bonus card: fail quiet */ }
    })();
    return () => { cancelled = true; };
  }, [industry]);
  if (industry !== 'electrical' || items.length === 0) return null;
  return (
    <section aria-labelledby="industry-attention-heading" className="dw-card p-4 space-y-2">
      <h2 id="industry-attention-heading" className="text-base font-semibold">Needs attention</h2>
      <ul className="space-y-1">
        {items.slice(0, 8).map((i, n) => (
          <li key={`${i.label}-${n}`} className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
            <span className="min-w-0 break-words">{i.label}{i.note ? <span className="text-ink-2"> ({i.note})</span> : null}</span>
            <span className={i.kind === 'unreadable' ? 'text-warn-ink' : i.days < 0 ? 'text-bad font-medium' : 'text-ink-2'}>{when(i)}</span>
          </li>
        ))}
      </ul>
      {onAsk && <button type="button" className="dw-btn-secondary" onClick={() => onAsk('Which licenses, insurance or bonds expire in the next 60 days?')}>Ask about these</button>}
    </section>
  );
}
