import { FileX2 } from 'lucide-react';

/** 'not-on-file' layout: an explicit, unambiguous label — an honest zero must never read like a
 *  vague failure. What IS on file follows immediately below (SourceList's "Closest documents"). */
export function NotOnFileBadge() {
  return (
    <span className="dw-pill-muted">
      <FileX2 className="w-3.5 h-3.5" aria-hidden="true" />
      Not on file
    </span>
  );
}
