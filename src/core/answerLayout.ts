/**
 * Round 12 — how Donovan PRESENTS an answer. Pure, deterministic mapping from the EXISTING /api/ask
 * Answer shape (kind, facts[], records/recordsTotal/recordsKind, basis) to one of a small set of
 * layouts. No API changes, no new server fields, no model calls: everything here is a read of shapes
 * the server already sends (mirrored in scripts/verify-answer-ui.mjs's unit fixtures).
 *
 * Precedence matters — it is what makes this deterministic rather than a pile of overlapping
 * heuristics: not-on-file, then the shapes that need a special hero (money, status), then the two
 * "many rows" shapes (list, timeline), then comparison, then single-fact, then explain, then prose.
 */
import type { Answer, AnswerRecord, Fact } from './types';
import { recordGroups } from './citations';

export type AnswerLayoutKind =
  | 'not-on-file'
  | 'money'
  | 'status'
  | 'list'
  | 'timeline'
  | 'comparison'
  | 'single-fact'
  | 'explain'
  | 'prose';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;
/** A handful of common "printed on a document" date shapes, so a fact whose kind was never tagged
 *  'date' (server sends kind on a best-effort basis) still counts for the timeline heuristic below. */
const DATE_LIKE = /^\d{4}-\d{2}-\d{2}|^[A-Z][a-z]{2,8} \d{1,2},? \d{4}$|^\d{1,2}\/\d{1,2}\/\d{2,4}$/;

function isDateFact(f: Fact): boolean {
  return f.kind === 'date' || ISO_DATE.test(f.value) || DATE_LIKE.test(f.value.trim());
}

function isMoneyFact(f: Fact): boolean {
  return f.kind === 'money';
}

/** Same "no source, no status pill" shape FactGrid.isGroupLikeFact already renders as a dense table —
 *  reused here so the layout decision and the rendering agree about what a breakdown looks like. */
function isGroupLikeFact(f: Fact): boolean {
  return !f.status && f.sources.length === 0;
}

const GROUP_LIST_THRESHOLD = 5;
const RECORD_LIST_THRESHOLD = 6;

/** Records-driven list: several rows of the SAME kind, or a breakdown with 2+ groups — the "long list
 *  of documents/customers" the owner asked to make scannable, not a footnote. */
function isRecordListShaped(records: readonly AnswerRecord[]): boolean {
  if (records.length >= RECORD_LIST_THRESHOLD) return true;
  return records.length >= 3 && recordGroups(records).length >= 2;
}

/** Majority of the facts are dated events (a visit, a service call, a document) — a history, not a
 *  handful of unrelated key/value pairs. Mirrors FactGrid's own majority-vote for a status breakdown. */
function isTimelineShaped(facts: readonly Fact[]): boolean {
  if (facts.length < 3) return false;
  const dated = facts.filter(isDateFact).length;
  return dated >= Math.max(3, Math.ceil(facts.length * 0.6));
}

/** Two or more distinct entities carry a fact with the SAME label ("Model" for unit A and unit B) —
 *  the only structural signal in the existing Fact shape that two things are being set side by side. */
function isComparisonShaped(facts: readonly Fact[]): boolean {
  const byLabel = new Map<string, Set<string>>();
  for (const f of facts) {
    if (!f.entityId) continue;
    if (!byLabel.has(f.label)) byLabel.set(f.label, new Set());
    byLabel.get(f.label)!.add(f.entityId);
  }
  const entityIds = new Set(facts.map((f) => f.entityId).filter(Boolean) as string[]);
  if (entityIds.size < 2) return false;
  for (const ids of byLabel.values()) if (ids.size >= 2) return true;
  return false;
}

type LayoutAnswer = Pick<Answer, 'kind' | 'text' | 'facts' | 'records' | 'recordsTotal' | 'recordsKind' | 'basis'>;

/** "invalid because it was never registered" — the answer's OWN generated prose stating a reason,
 *  never exam question text (this matches an English connective, not any fixed sentence). Only this
 *  explicit cue outranks a status/money reading of the same facts; ordinary reasoned answers with no
 *  such cue still fall through to 'explain' further down via the basis-sentence check. */
function hasReasonCue(text: string | undefined): boolean {
  return typeof text === 'string' && /\b(?:because|due to|as a result of)\b/i.test(text);
}

/**
 * The one place that decides how an answer's shape maps to a layout. Called with the real Answer at
 * render time (AnswerCard, MobileAnswer) and with small fixtures in scripts/verify-answer-ui.mjs.
 */
export function answerLayout(answer: LayoutAnswer): AnswerLayoutKind {
  if (answer.kind === 'no-answer') return 'not-on-file';

  const facts = answer.facts ?? [];
  const records = answer.records ?? [];

  const groupLike = facts.length > GROUP_LIST_THRESHOLD && facts.every(isGroupLikeFact);
  const recordListShaped = isRecordListShaped(records);
  const reasoned = hasReasonCue(answer.text) && facts.length >= 2;

  // An explicitly reasoned answer ("X because Y") with more than one supporting fact reads as an
  // explanation first, even when one of those supporting facts happens to carry a status pill (e.g.
  // "registered? no" as part of the reasoning) — that pill is evidence FOR the reason, not the
  // headline's own subject the way it is in 'status' below.
  if (reasoned && !recordListShaped && !groupLike) return 'explain';

  // Amount-first: the answer's own subject is a dollar figure (an invoice total, a balance, a job's
  // cost) — never buried under a status pill or a list of unrelated rows.
  if (!recordListShaped && !groupLike && facts.some(isMoneyFact) && facts.length <= 6) return 'money';

  // A single entity's state (warranty/maintenance/coverage): one or a few facts, at least one carries
  // a status pill, and it is not actually a breakdown across many entities (that is 'list' below).
  if (!recordListShaped && !groupLike && facts.length <= 5 && facts.some((f) => f.status && f.status !== 'muted')) {
    return 'status';
  }

  // A long list of records (many customers/units/documents) or a breakdown across many of them —
  // exactly the "long list, needs sort/filter/find" case the owner called out.
  if (recordListShaped || groupLike) return 'list';

  if (isTimelineShaped(facts)) return 'timeline';

  if (isComparisonShaped(facts)) return 'comparison';

  if (facts.length === 1 && records.length <= 1) return 'single-fact';

  // A reasoned answer with no explicit connective but still a stated basis and >=2 supporting facts
  // (one fact alone reads better as 'single-fact', handled above).
  if (typeof answer.basis === 'string' && answer.basis.trim() && facts.length >= 2) return 'explain';

  return 'prose';
}

// ---------------------------------------------------------------------------------------------------
// claimCheck — attached by the server (api/_lib/claims) but not declared on core/types.ts's Answer
// (a types.ts change is outside this round's ownership). Read defensively; every caller degrades to
// "no claim-check info" rather than throwing on an older/mocked answer that never set it.
// ---------------------------------------------------------------------------------------------------

export interface ClaimCheckInfo {
  policy: 'agent' | 'deterministic';
  checked: number;
  supported: number;
  unsupported: unknown[];
  rate: number;
  removedSentences?: number;
  removedFacts?: number;
}

export function claimCheckOf(answer: unknown): ClaimCheckInfo | undefined {
  const c = (answer as { claimCheck?: unknown } | null)?.claimCheck;
  if (!c || typeof c !== 'object') return undefined;
  const x = c as Partial<ClaimCheckInfo>;
  if (typeof x.checked !== 'number' || typeof x.supported !== 'number') return undefined;
  return x as ClaimCheckInfo;
}

/** "Checked against 3 documents" — subtle, never shown when there was nothing to check (a bare count
 *  answer with no checkable claims looks identical with or without claim-checking). */
export function claimCheckNote(answer: Answer): string | null {
  const c = claimCheckOf(answer);
  if (!c || c.checked === 0) return null;
  const distinctDocs = new Set(answer.sources.map((s) => s.documentId)).size;
  const n = distinctDocs || c.checked;
  return `Checked against ${n} document${n === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------------------------------
// Sentence citations (R13H1) — attached by the server (api/_lib/citations/sentences.js) but not
// declared on core/types.ts's Answer (a types.ts change is outside this round's ownership, same rule
// claimCheckOf above already follows). Read defensively; an older/cached answer with no `sentences`
// degrades to "render the plain text, no markers" rather than throwing.
// ---------------------------------------------------------------------------------------------------

export interface SentenceCitation {
  documentId: string;
  page?: number;
  quote?: string;
  score: number;
}

export interface AnswerSentence {
  text: string;
  citations: SentenceCitation[];
  supported: boolean;
}

export function sentencesOf(answer: unknown): AnswerSentence[] | undefined {
  const s = (answer as { sentences?: unknown } | null)?.sentences;
  if (!Array.isArray(s) || s.length === 0) return undefined;
  const ok = s.every(
    (x): x is AnswerSentence =>
      Boolean(x) && typeof x === 'object' && typeof (x as AnswerSentence).text === 'string' && Array.isArray((x as AnswerSentence).citations)
  );
  return ok ? (s as AnswerSentence[]) : undefined;
}

/** True only for a MODEL-written answer (the research agent) — the "not found in your records" mark on
 *  an unsupported sentence means something different for a deterministic answer (computed straight from
 *  SQL, never model prose) than for one the agent wrote, so it is shown only here. */
export function isModelWritten(answer: unknown): boolean {
  return claimCheckOf(answer)?.policy === 'agent';
}

/** Assigns each sentence's citations a stable [n] marker number, numbered by unique source (documentId)
 *  in first-appearance order across the WHOLE answer — so citation [1] always means the same document
 *  everywhere it appears, the same convention SourceList's own numbering already uses for `sources`. */
export function numberCitations(sentences: readonly AnswerSentence[]): {
  numbered: { text: string; supported: boolean; citations: (SentenceCitation & { n: number })[] }[];
  order: string[]; // documentId, in [1][2][3]... order
} {
  const order: string[] = [];
  const numbered = sentences.map((s) => ({
    text: s.text,
    supported: s.supported,
    citations: s.citations.map((c) => {
      let n = order.indexOf(c.documentId);
      if (n === -1) {
        order.push(c.documentId);
        n = order.length - 1;
      }
      return { ...c, n: n + 1 };
    }),
  }));
  return { numbered, order };
}

// ---------------------------------------------------------------------------------------------------
// Follow-up chips — deterministic, generated from the answer's own shape (never hard-coded exam text).
// ---------------------------------------------------------------------------------------------------

const LAYOUT_FOLLOWUPS: Record<AnswerLayoutKind, string[]> = {
  'not-on-file': ['Try a different address', 'Search by serial number', 'Search by customer name'],
  money: ['Which invoices are unpaid?', 'Payment history', 'Any open balance?'],
  status: ['Last service?', 'Open work orders?', 'Service history'],
  list: ['Narrow to one customer', 'Sort by date', 'Show only active'],
  timeline: ['Who was the technician?', 'What work was done?', 'Any follow-up needed?'],
  comparison: ['Which one is newer?', 'Show full details for each'],
  'single-fact': ['Warranty status?', 'When was it installed?'],
  explain: ['Show the records behind this', 'What documents support this?'],
  prose: ['Show sources', 'Ask a follow-up'],
};

/** Up to `max` quick-reply chips for the answer just shown, never repeating the question asked and
 *  never repeating a fact label already on screen as a chip (a "Warranty status?" chip is pointless
 *  directly under a fact already labelled "Warranty status"). */
export function followupChips(answer: Answer, question: string, max = 3): string[] {
  const kind = answerLayout(answer);
  const asked = question.trim().toLowerCase();
  const shownLabels = new Set((answer.facts ?? []).map((f) => f.label.trim().toLowerCase()));
  const out: string[] = [];
  for (const chip of LAYOUT_FOLLOWUPS[kind]) {
    const norm = chip.replace(/\?$/, '').trim().toLowerCase();
    if (norm === asked || shownLabels.has(norm)) continue;
    out.push(chip);
    if (out.length >= max) break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Share — a plain-text summary a tech can paste into a text message or a work-order note.
// ---------------------------------------------------------------------------------------------------

/** `resolveDocName` lets the caller show a real document title (documentName()) instead of a bare id;
 *  omitted, the id is used so this still works as a pure function in tests. */
export function shareText(question: string, answer: Answer, resolveDocName?: (documentId: string) => string | undefined): string {
  const lines: string[] = [`Q: ${question.trim()}`, '', answer.text.trim()];
  const facts = (answer.facts ?? []).slice(0, 6);
  if (facts.length) {
    lines.push('');
    for (const f of facts) lines.push(`- ${f.label}: ${f.value}`);
  }
  const docIds = Array.from(new Set((answer.kind === 'no-answer' ? answer.closest : answer.sources).map((s) => s.documentId)));
  if (docIds.length) {
    lines.push('', answer.kind === 'no-answer' ? 'Closest documents:' : 'Sources:');
    for (const id of docIds) lines.push(`- ${resolveDocName?.(id) ?? id}`);
  }
  return lines.join('\n');
}
