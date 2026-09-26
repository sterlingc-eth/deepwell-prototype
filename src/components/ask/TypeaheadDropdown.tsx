import { useEffect, useRef } from 'react';
import type { TypeaheadItem } from '../../core/suggestions';

/**
 * The typeahead completion list under the Ask box (Round 14 K1) — answerable question templates filled
 * with this tenant's own real vocabulary, ranked by prefix/fuzzy match against what's currently typed.
 * Fully keyboard-navigable (Up/Down/Enter) so it works one-handed with gloves on, same as the rest of the
 * composer; the composer itself owns `activeIndex` and Enter/Escape handling (see AskScreen/AskTab) so
 * this stays a plain, controlled list.
 */
export function TypeaheadDropdown({
  items,
  activeIndex,
  onHover,
  onSelect,
}: {
  items: TypeaheadItem[];
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (text: string) => void;
}) {
  const activeRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (!items.length) return null;
  return (
    <ul
      role="listbox"
      aria-label="Suggested questions"
      className="absolute left-0 right-0 top-full mt-1.5 z-20 max-h-64 overflow-y-auto rounded-lg border border-line bg-surface shadow-lg py-1"
    >
      {items.map((item, i) => (
        <li key={item.id} ref={i === activeIndex ? activeRef : null} role="option" aria-selected={i === activeIndex}>
          <button
            type="button"
            // Mousedown (not click) fires before the textarea's blur, so tapping a suggestion never
            // races the composer closing the dropdown out from under the tap.
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(item.text);
            }}
            onMouseEnter={() => onHover(i)}
            className={`w-full min-h-11 text-left px-3.5 py-2 text-body truncate ${
              i === activeIndex ? 'bg-surface-2 text-ink' : 'text-ink-2'
            }`}
          >
            {item.text}
          </button>
        </li>
      ))}
    </ul>
  );
}
