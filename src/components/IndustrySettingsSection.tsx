import { useEffect, useRef, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { INDUSTRY_CHOICES, type IndustryId } from '../lib/industry';
import { changeIndustry } from '../services/industryClient';
import { useAppStore } from '../store/appStore';

/**
 * Settings > "Your trade" (Build 2, stage 2E). One company uses one trade today, so this is a single choice, not a
 * set of switches. Tapping another trade asks once ("Switch to Plumbing?") and says plainly what changes (the words
 * and screens) and what does not (every document and record stays). Admin-only: the Settings card is.
 */
export function IndustrySettingsSection() {
  const info = useAppStore((s) => s.industry);
  const setIndustry = useAppStore((s) => s.setIndustry);
  const current: IndustryId = info?.industry ?? 'hvac';
  const [pending, setPending] = useState<IndustryId | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = panelRef.current;
    if (pending && el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [pending]);
  const label = (id: IndustryId) => INDUSTRY_CHOICES.find((c) => c.id === id)?.label ?? id;

  const confirm = async () => {
    if (!pending || saving) return;
    setSaving(true);
    setError(null);
    try {
      const next = await changeIndustry(pending);
      setIndustry(next);
      setDone(`Switched to ${label(next.industry)}.`);
      setPending(null);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not change the trade. Nothing was changed. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2" data-testid="your-trade">
      <h3 className="text-body font-medium text-ink">Your trade</h3>
      <p className="text-caption text-ink-3">
        This sets the words, screens and questions DeepWell uses. Changing it never deletes a document or record.
      </p>
      <div role="radiogroup" aria-label="Your trade" className="grid gap-2">
        {INDUSTRY_CHOICES.map((c) => {
          const on = c.id === current;
          return (
            <div key={c.id} className="space-y-2">
            <button
              type="button"
              role="radio"
              aria-checked={on}
              disabled={saving}
              onClick={() => { setDone(null); setError(null); setPending(on ? null : c.id); }}
              className={`dw-card px-4 py-3 min-h-[44px] flex items-start gap-3 text-left ${on ? 'border-forest-700' : pending === c.id ? 'border-brass-300' : 'border-line'}`}
            >
              <span className="mt-0.5 w-4 shrink-0">{on && <Check className="w-4 h-4 text-forest-700" aria-hidden="true" />}</span>
              <span>
                <span className="block font-medium text-ink">{c.label}{on ? ' (current)' : ''}</span>
                <span className="block text-caption text-ink-3">{c.blurb}</span>
              </span>
            </button>
{pending === c.id && (
    <div ref={panelRef} className="dw-card p-3 space-y-2 border-brass-300" role="group" aria-label={`Switch to ${label(pending)}`}>
      <p className="text-body text-ink">Switch to {label(pending)}?</p>
      <p className="text-caption text-ink-3">
        Screens, questions and wording change to {label(pending)}. Documents already filed stay on file, but they were read under your old trade, so Donovan's answers about them may be missing or mixed up. Run Re-check all documents with AI on the dashboard so they are read as {label(pending)}. You can switch back any time.
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="dw-btn-primary min-h-[44px]" disabled={saving} onClick={() => void confirm()}>
          {saving ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : null} Switch to {label(pending)}
        </button>
        <button type="button" className="dw-btn-secondary min-h-[44px]" disabled={saving} onClick={() => setPending(null)}>
          Keep {label(current)}
        </button>
      </div>
    </div>
  )}
            </div>
          );
        })}
      </div>
      {error && <p role="alert" className="text-body text-warn-ink dark:text-brass-200">{error}</p>}
      {done && <p role="status" className="text-body text-ink-2">{done}</p>}
    </div>
  );
}
