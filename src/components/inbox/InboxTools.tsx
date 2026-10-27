import { ChevronDown, ChevronRight, SlidersHorizontal } from 'lucide-react';

/** PROPOSED wording, awaiting owner approval (INBOX_REDESIGN_REPORT.md lists every string). */
const TOOLS_LABEL = 'Tools and filters';

/**
 * Inbox redesign: the rarely used controls (My work / Everyone, Hide company files, Sort my documents, Re-check all open
 * papers, the set-aside note) are folded away behind this one quiet button instead of sitting open above the list. The
 * controls themselves are not changed: ReviewBody only hides the row that holds them until this is pressed.
 */
export function InboxToolsToggle({ open, onToggle, controls }: { open: boolean; onToggle: () => void; controls: string }) {
  return (
    <button type="button" aria-expanded={open} aria-controls={controls} onClick={onToggle} className="dw-btn-tertiary !min-h-[44px] !py-1.5 !px-2 self-start">
      <SlidersHorizontal className="w-4 h-4" aria-hidden="true" /> {TOOLS_LABEL}
      {open ? <ChevronDown className="w-4 h-4" aria-hidden="true" /> : <ChevronRight className="w-4 h-4" aria-hidden="true" />}
    </button>
  );
}
