import type { WorkFilterChoice } from '../core/workFilter';

/**
 * "My work / Everyone" segmented control (owner brief 2026-09-21). Only
 * meant to render for an org tenant (`useWorkFilter().hasShop`) — a solo
 * shop has no coworkers to filter out. Ask/Donovan is never filtered this
 * way; `showHint` says so once, the first time a browser sees this control.
 */
export function WorkFilterControl({
  choice,
  onChange,
  showHint,
}: {
  choice: WorkFilterChoice;
  onChange: (c: WorkFilterChoice) => void;
  showHint?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div role="tablist" aria-label="Show whose work" className="flex flex-wrap gap-1.5">
        {(
          [
            { id: 'mine' as const, label: 'My work' },
            { id: 'everyone' as const, label: 'Everyone' },
          ]
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={choice === t.id}
            onClick={() => onChange(t.id)}
            className={[
              'dw-btn !min-h-[36px] !py-1 !px-3 text-body',
              choice === t.id
                ? 'bg-forest-700 text-stone-0 dark:bg-brass-300 dark:text-forest-950'
                : 'bg-surface border border-line text-ink-2 hover:bg-surface-2',
            ].join(' ')}
          >
            {t.label}
          </button>
        ))}
      </div>
      {showHint && <p className="text-caption text-ink-3">Donovan answers from everyone's records.</p>}
    </div>
  );
}
