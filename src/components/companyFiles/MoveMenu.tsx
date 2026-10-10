import { useEffect, useRef, useState } from 'react';
import { OVERRIDE_CUSTOMER, type CompanyFolderId } from '../../core/companyFiles';
import type { CfDoc } from '../../services/companyFilesClient';

/**
 * "Move to…": the seven folders (People and HR only when the server listed it for this person) and the customer side.
 * "Always file {vendor} here" is on by default and applies to the next paper from that vendor.
 */
export function MoveMenu({ doc, folders, onMove }: {
  doc: CfDoc;
  folders: { id: CompanyFolderId; label: string }[];
  onMove: (doc: CfDoc, to: string, alwaysFile: boolean) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [always, setAlways] = useState(true);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey, true); };
  }, [open]);

  const choose = (to: string) => { setOpen(false); void onMove(doc, to, always); };

  return (
    <div className="relative" ref={root}>
      <button type="button" className="dw-btn-secondary !min-h-[44px] !py-1.5 !px-3" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Move to…
      </button>
      {open && (
        <div role="menu" aria-label="Move to…" className="absolute right-0 top-full mt-1 z-30 w-72 max-w-[calc(100vw-2rem)] dw-card shadow-lift p-1.5 space-y-0.5" data-testid="cf-move-menu">
          {folders.filter((f) => f.id !== doc.folder).map((f) => (
            <button key={f.id} type="button" role="menuitem" className="w-full min-h-[44px] px-3 rounded-md text-left hover:bg-surface-2" onClick={() => choose(f.id)}>{f.label}</button>
          ))}
          <button type="button" role="menuitem" className="w-full min-h-[44px] px-3 rounded-md text-left hover:bg-surface-2" onClick={() => choose(OVERRIDE_CUSTOMER)}>A customer</button>
          {doc.vendor && (
            <label className="flex items-center gap-3 min-h-[44px] px-3 border-t border-line cursor-pointer">
              <input type="checkbox" className="w-5 h-5 accent-forest-700" checked={always} onChange={(e) => setAlways(e.target.checked)} />
              <span className="text-caption">Always file {doc.vendor} here</span>
            </label>
          )}
        </div>
      )}
    </div>
  );
}
