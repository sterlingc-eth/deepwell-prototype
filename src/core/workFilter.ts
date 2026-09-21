/**
 * "My work / Everyone" — the per-technician work filter (owner brief
 * 2026-09-21, TECH_FILTER_AND_OUTREACH_COPY): "I'd want their work to be
 * specific to them, but then they'd have an option to filter out work to
 * see other people's work also."
 *
 * A document is "theirs" two ways, either is enough:
 *   1. They uploaded it (Doc.uploadedBy === the signed-in Clerk user id —
 *      documents.uploaded_by, M3-config/20, set at presign time).
 *   2. Its extracted `technician` field (api/_lib/extractFields.js) names
 *      them — the person who actually did the work may not be whoever
 *      scanned the paperwork in.
 *
 * Pure, no React/Clerk/store imports — src/hooks/useWorkFilter.ts wires this
 * to the signed-in user's Clerk identity and org membership list; see that
 * file for where `displayName` comes from (never the server — Clerk claims
 * server-side carry only a user id, see api/_lib/auth.js's module header).
 *
 * Tested by scripts/verify-work-filter.mjs.
 */
import type { Doc } from './types';

export type WorkFilterChoice = 'mine' | 'everyone';

export interface WorkFilterUser {
  userId: string | null;
  displayName?: string | null;
}

function normalizeName(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** The technician name a document itself claims (field key 'technician'),
 *  preferring a human's correction over the raw AI-extracted value — null
 *  when the document has nothing on file. */
export function docTechnicianName(doc: Pick<Doc, 'extracted'>): string | null {
  const field = doc.extracted.find((f) => f.name === 'technician');
  const value = (field?.correctedValue ?? field?.value ?? '').trim();
  return value || null;
}

/**
 * True when `technicianName` (whatever a document's own `technician` field
 * says) names the same person as `displayName` (the signed-in user's own
 * name, from Clerk org membership). Case-insensitive, and tolerant of how a
 * technician actually signs paperwork:
 *   - an exact match ("Dana Ramirez" === "Dana Ramirez")
 *   - the display name appearing inside a longer technician string
 *     ("Dana Ramirez - Lead Tech" contains "Dana Ramirez")
 *   - the display name's LAST NAME alone, as its own word, inside the
 *     technician string ("D. Ramirez" contains "Ramirez") — first-name-only
 *     is deliberately NOT matched on its own (too common a false positive
 *     across a shop's roster).
 */
export function technicianNameMatches(technicianName: string | null | undefined, displayName: string | null | undefined): boolean {
  const tech = normalizeName(technicianName);
  const me = normalizeName(displayName);
  if (!tech || !me) return false;
  if (tech === me || tech.includes(me)) return true;

  const meParts = me.split(' ').filter(Boolean);
  const lastName = meParts[meParts.length - 1];
  if (!lastName || lastName.length < 2) return false;
  const techTokens = tech.split(/[^a-z0-9]+/).filter(Boolean);
  return techTokens.includes(lastName);
}

/** True when `doc` is this user's own work — they uploaded it, or its
 *  extracted technician field names them. */
export function isMineDoc(doc: Pick<Doc, 'extracted' | 'uploadedBy'>, user: WorkFilterUser): boolean {
  if (user.userId && doc.uploadedBy && doc.uploadedBy === user.userId) return true;
  if (user.displayName && technicianNameMatches(docTechnicianName(doc), user.displayName)) return true;
  return false;
}

/** Filters `docs` down to the signed-in user's own work for 'mine'; returns
 *  every doc unfiltered for 'everyone' (Ask/Donovan is never filtered this
 *  way at all — see the owner brief — this is only for the Inbox/Records
 *  document lists). */
export function filterDocsForWork<T extends Pick<Doc, 'extracted' | 'uploadedBy'>>(
  docs: T[],
  choice: WorkFilterChoice,
  user: WorkFilterUser
): T[] {
  if (choice === 'everyone') return docs;
  return docs.filter((d) => isMineDoc(d, user));
}

export interface DefaultChoiceInput {
  /** Whether the signed-in user belongs to a real shop (Clerk organization)
   *  at all — a solo tenant has no coworkers to filter out. */
  hasShop: boolean;
  isAdmin: boolean;
  /** How many of the tenant's documents are already attributed to this user
   *  (isMineDoc, over the WHOLE document set — not a sub-filtered view). */
  attributedDocCount: number;
}

/**
 * Default the control to "My work" only for a non-admin org member who
 * already has at least one attributed document — otherwise "Everyone", so a
 * solo owner or a fresh account (no attributed work yet) never lands on an
 * empty screen. See the owner brief's exact wording in this module's header.
 */
export function defaultWorkFilterChoice({ hasShop, isAdmin, attributedDocCount }: DefaultChoiceInput): WorkFilterChoice {
  if (!hasShop || isAdmin) return 'everyone';
  return attributedDocCount >= 1 ? 'mine' : 'everyone';
}
