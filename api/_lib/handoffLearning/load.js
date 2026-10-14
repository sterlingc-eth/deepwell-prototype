/** handoffLearning/load.js - reads this organization's adopted learnings (plus the shared ones) once, for the vocabulary the parser reads. Never throws; null = nothing learned. */
import { listActive, listShared, overlayVersion } from './store.js';
import { buildOverlay } from './overlay.js';
import { handoffLearningEnabled } from './flag.js';

export async function loadHandoffOverlay(db) {
  if (!handoffLearningEnabled()) return null;
  try {
    const [own, shared] = await Promise.all([listActive(db), listShared(db)]);
    const o = buildOverlay(own, { shared });
    return o.size ? o : null;
  } catch { return null; }
}
export async function handoffVersion(db) {
  if (!handoffLearningEnabled()) return '';
  try { return await overlayVersion(db); } catch { return ''; }
}
