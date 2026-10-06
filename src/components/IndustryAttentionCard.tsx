import { useEffect, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { authHeader } from '../services/authToken';

interface Item { kind: 'expired' | 'expiring' | 'overdue' | 'due' | 'unreadable' | 'failed'; category: 'credential' | 'test' | 'backflow' | 'warranty' | 'permit'; label: string; date: string; days: number; note?: string }

const when = (i: Item) => (i.kind === 'unreadable' ? (i.category === 'backflow' ? 'result unreadable' : 'date unreadable') : i.kind === 'failed' ? (i.days >= 0 ? 'failed' : `failed ${-i.days} day${i.days === -1 ? '' : 's'} ago`) : i.days < 0 ? `${i.kind === 'overdue' ? 'overdue' : 'expired'} ${-i.days} day${i.days === -1 ? '' : 's'} ago` : i.days === 0 ? 'today' : `in ${i.days} day${i.days === 1 ? '' : 's'}`);

/** Electrical (credentials, tests) and plumbing (backflow tests, failed tests, heater warranties, permits) companies only. Shows nothing for every other industry and on any failure. */
const ASK: Record<string, (first?: Item, all?: Item[]) => string> = {
  electrical: () => 'Which licenses, insurance or bonds expire in the next 60 days?',
  // one category on the card -> that category's question; a mix -> the general one (the lane answers all of these)
  plumbing: (_first, all = []) => {
    const cats = new Set(all.map((i) => i.category));
    const mixedKinds = new Set(all.map((i) => i.kind === 'failed' ? 'failed' : i.kind === 'unreadable' ? 'unreadable' : i.days < 0 ? 'late' : 'soon'));
    if (cats.size !== 1 || mixedKinds.size > 1) return 'Which backflow tests, water heater warranties or permits need attention?';
    const c = [...cats][0];
    if (c === 'warranty') return 'Which water heater warranties expire in the next 60 days?';
    if (c === 'permit') return all.every((i) => i.kind === 'expired') ? 'Which permits have expired?' : 'Which open permits expire in the next 60 days?';
    return all.every((i) => i.kind === 'failed') ? 'Which backflow tests failed?' : all.some((i) => i.kind === 'unreadable') ? 'Which backflow tests, water heater warranties or permits need attention?' : 'Which backflow tests are overdue or due in the next 60 days?';
  },
};
export function IndustryAttentionCard({ onAsk }: { onAsk?: (q: string) => void }) {
  const industry = useAppStore((s) => s.industry?.industry ?? 'hvac');
  const [items, setItems] = useState<Item[]>([]);
  useEffect(() => {
    if (industry !== 'electrical' && industry !== 'plumbing') return;
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
  if ((industry !== 'electrical' && industry !== 'plumbing') || items.length === 0) return null;
  return (
    <section aria-labelledby="industry-attention-heading" className="dw-card p-4 space-y-2">
      <h2 id="industry-attention-heading" className="text-base font-semibold">Needs attention</h2>
      <ul className="space-y-1">
        {items.slice(0, 8).map((i, n) => (
          <li key={`${i.label}-${n}`} className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
            <span className="min-w-0 break-words">{i.label}{i.note ? <span className="text-ink-2"> ({i.note})</span> : null}{i.date ? <span className="text-ink-2"> · {i.date}</span> : null}</span>
            <span className={i.kind === 'unreadable' ? 'text-warn-ink' : i.days < 0 ? 'text-bad font-medium' : 'text-ink-2'}>{when(i)}</span>
          </li>
        ))}
      </ul>
      {items.length > 8 && <p className="text-sm text-ink-2">and {items.length - 8} more</p>}
      {onAsk && <button type="button" className="dw-btn-secondary w-full sm:w-auto" onClick={() => onAsk(ASK[industry]?.(items[0], items) ?? '')}>Ask about these</button>}
    </section>
  );
}
