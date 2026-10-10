import { useEffect, useState } from 'react';
import { AlertTriangle, BellOff, ChevronDown, ChevronRight, EyeOff, RotateCcw, ShieldCheck } from 'lucide-react';
import { fetchInsights, type Insight, type InsightSeverity } from './insightsClient';
import { hide, restore, splitHidden, ymd, SNOOZE_DAYS, type HideMode } from './attentionPrefs';
import { useUiPrefs } from '../../services/uiPrefs';

const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === 'true';

const SEVERITY_PILL: Record<InsightSeverity, string> = {
  high: 'dw-pill-bad',
  medium: 'dw-pill-warn',
  low: 'dw-pill-muted',
};

function chip(insight: Insight): string {
  if (insight.dollars != null) {
    return `${insight.count} · $${insight.dollars.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  }
  return String(insight.count);
}

/**
 * "Needs attention" — the proactive-insights card (R17 contract, G1).
 * Minimal, scannable: max 5 rows visible, each one line + count/$ chip + one
 * primary action; tap a row to expand its items with source chips. Big
 * touch targets (min-h-touch), both themes via the existing dw-* tokens.
 *
 * `onAsk` sends the insight's own natural-language question through the same
 * Ask engine the rest of the app already uses (desktop: useAppStore's
 * askQuestion; mobile: AskTab's own submit) — every insight's primary action
 * is `ask:<question>`, so the mount site only ever needs to wire one
 * function. `onOpenInbox` is optional (desktop-only: the intake/exception
 * queue screen mobile doesn't have its own route into yet).
 */
export function InsightsCard({ onAsk, onOpenInbox }: { onAsk: (question: string) => void; onOpenInbox?: () => void }) {
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; items: Insight[] }>({ status: 'loading', items: [] });
  const [openId, setOpenId] = useState<string | null>(null);
  const [prefs, updatePrefs] = useUiPrefs();
  const [showHidden, setShowHidden] = useState(false);
  const hiddenMap = prefs.needsAttention ?? {};

  useEffect(() => {
    if (DEMO_MODE) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchInsights(8);
        if (cancelled) return;
        setState({ status: 'ready', items: res.items });
        // R36: open the top (highest-priority) insight so its items and action are one click away, not two.
        setOpenId(res.items?.[0]?.id ?? null);
      } catch {
        if (!cancelled) setState({ status: 'error', items: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (DEMO_MODE || state.status === 'error') return null;

  const hideRow = (insight: Insight, mode: HideMode) => updatePrefs({ needsAttention: hide(hiddenMap, insight.id, mode, insight.count, new Date()) });
  const restoreRow = (insight: Insight) => updatePrefs({ needsAttention: restore(hiddenMap, insight.id) });
  const { visible, hidden } = splitHidden(state.items, hiddenMap, ymd(new Date()));
  const shown = (showHidden ? [...visible, ...hidden] : visible).slice(0, showHidden ? 8 : 5);
  const hiddenIds = new Set(hidden.map((h) => h.id));

  const runAction = (insight: Insight) => {
    if (insight.action.href === 'inbox') {
      onOpenInbox?.();
      return;
    }
    const m = /^ask:(.*)$/s.exec(insight.action.href);
    onAsk(m?.[1] ?? insight.action.href);
  };

  return (
    <section aria-labelledby="insights-heading" className="space-y-3">
      <h2 id="insights-heading" className="dw-label">Needs attention</h2>
      <div className="dw-card p-3">
        {state.status === 'loading' ? (
          <p className="text-body text-ink-3 px-1 py-2">Checking your records…</p>
        ) : state.items.length === 0 ? (
          <div className="flex items-center gap-2 px-1 py-2">
            <ShieldCheck className="w-4 h-4 text-ok-ink" aria-hidden="true" />
            <p className="text-body text-ink-2">All clear — nothing needs attention right now.</p>
          </div>
        ) : shown.length === 0 && !showHidden ? (
          <div className="flex items-center gap-2 px-1 py-2">
            <ShieldCheck className="w-4 h-4 text-ok-ink" aria-hidden="true" />
            <p className="text-body text-ink-2">Everything here is hidden for now.</p>
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {shown.map((insight) => {
              const isHiddenRow = hiddenIds.has(insight.id);
              const isOpen = openId === insight.id;
              return (
                <li key={insight.id} className={isHiddenRow ? 'opacity-70' : undefined}>
                  <button
                    type="button"
                    onClick={() => setOpenId((id) => (id === insight.id ? null : insight.id))}
                    aria-expanded={isOpen}
                    className="w-full min-h-touch flex items-center gap-3 px-1 py-2.5 text-left hover:bg-surface-2 rounded-md"
                  >
                    {insight.severity === 'high' && <AlertTriangle className="w-4 h-4 text-bad-ink shrink-0" aria-hidden="true" />}
                    <span className="flex-1 min-w-0 truncate text-body-lg text-ink">{insight.title}</span>
                    {isHiddenRow && <span className="dw-pill-muted">Hidden</span>}
                    <span className={SEVERITY_PILL[insight.severity]}>{chip(insight)}</span>
                    {isOpen ? <ChevronDown className="w-4 h-4 text-ink-3 shrink-0" aria-hidden="true" /> : <ChevronRight className="w-4 h-4 text-ink-3 shrink-0" aria-hidden="true" />}
                  </button>
                  {isOpen && (
                    <div className="pb-3 pl-1 pr-1 space-y-2">
                      <ul className="space-y-1.5">
                        {insight.items.map((item, i) => (
                          <li key={i} className="text-body text-ink-2 flex flex-wrap items-center gap-1.5">
                            <span className="min-w-0">{item.label}</span>
                            {item.documentIds.length > 0 && (
                              <span className="dw-pill-info">{item.documentIds.length === 1 ? '1 source' : `${item.documentIds.length} sources`}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                      <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={() => runAction(insight)} className="dw-btn-primary !min-h-touch">
                          {insight.action.label}
                        </button>
                        {isHiddenRow ? (
                          <button type="button" onClick={() => restoreRow(insight)} className="dw-btn-secondary !min-h-touch">
                            <RotateCcw className="w-4 h-4" aria-hidden="true" /> Show again
                          </button>
                        ) : (
                          <>
                            <button type="button" onClick={() => hideRow(insight, 'dismiss')} title="Hide this row until the number on it changes" className="dw-btn-secondary !min-h-touch">
                              <EyeOff className="w-4 h-4" aria-hidden="true" /> Dismiss
                            </button>
                            <button type="button" onClick={() => hideRow(insight, 'snooze')} title={`Hide this row for ${SNOOZE_DAYS} days`} className="dw-btn-secondary !min-h-touch">
                              <BellOff className="w-4 h-4" aria-hidden="true" /> Snooze {SNOOZE_DAYS} days
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {state.status === 'ready' && hidden.length > 0 && (
          <div className="pt-1 px-1">
            <button type="button" onClick={() => setShowHidden((v) => !v)} aria-pressed={showHidden} className="text-caption text-ink-2 hover:text-ink underline min-h-touch sm:min-h-0">
              {showHidden ? 'Hide them again' : `Show hidden (${hidden.length})`}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
