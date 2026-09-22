import type { Doc } from './types';

/**
 * Best-effort technician name off a shop-internal document's own free-text
 * `notes` (owner defect report 2026-09-22, item 4) — "Truck #4 due for oil
 * change, see shop manager. Tech: Kevin Pratt" -> "Kevin Pratt". Mirrors
 * api/_lib/documentTypes.js's extractTechnicianFromNotes exactly — src/
 * cannot import api/ (different tsconfig root/build), so this is
 * duplicated client-side, purely for display: a chip on the Shop records
 * list and something to filter it by. Deliberately NOT the same signal as
 * the `technician` field_key (which names whoever did CUSTOMER work and
 * rightly disqualifies isShopInternalDocument on the backend) — this only
 * ever reads a shop-internal document's own notes.
 */
export function technicianFromNotes(notes: string | null | undefined): string | null {
  const s = String(notes ?? '');
  // Prefix ("Tech:"/"Technician:", any case) located first; the name itself
  // is then read case-SENSITIVELY (each word must start with a capital) so
  // it stops at the next ordinary lowercase word ("Tech: Maria Alvarez
  // completed the count" -> "Maria Alvarez", not swallowing "completed").
  const prefixMatch = s.match(/\btech(?:nician)?s?\s*[:-]\s*/i);
  if (!prefixMatch) return null;
  const rest = s.slice((prefixMatch.index ?? 0) + prefixMatch[0].length);
  const nameMatch = rest.match(/^([A-Z][a-zA-Z'-]*(?:\s+[A-Z][a-zA-Z'-]*){0,2})/);
  if (!nameMatch || !nameMatch[1]) return null;
  return nameMatch[1].replace(/\s+/g, ' ').trim() || null;
}

/** The technician named in a shop-internal document's own notes, if any —
 *  null for any other type (the `technician` field_key on a real job is a
 *  different signal, shown elsewhere in DocPanel already). */
export function shopRecordTechnician(doc: Doc): string | null {
  if (doc.typeId !== 'internal') return null;
  const notesField = doc.extracted.find((f) => f.name === 'notes');
  if (!notesField) return null;
  return technicianFromNotes(notesField.correctedValue ?? notesField.value);
}
