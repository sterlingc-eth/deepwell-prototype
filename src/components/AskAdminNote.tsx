import { ASK_ADMIN } from '../hooks/useCanAdmin';

/** Visible (not tooltip-only, so it works on touch and for screen readers) reason a control is disabled for a member. */
export function AskAdminNote({ id, className }: { id?: string; className?: string }) {
  return (
    <span id={id} data-testid="ask-admin-note" className={['text-caption text-ink-3', className].filter(Boolean).join(' ')}>
      {ASK_ADMIN}
    </span>
  );
}
