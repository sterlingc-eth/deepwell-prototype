/**
 * Typed client for POST /api/review — the review screen's six actions,
 * persisted server-side. Follows ingestClient.ts's postJson + error-parsing
 * shape (a plain fetch helper, not recordsStoreClient.ts's class) because
 * this is a handful of narrow, already-typed calls rather than an interface
 * with 24 differently-shaped actions to implement.
 */

import { authHeader } from './authToken';
import { messageFromResponse } from './httpError';

const API_URL = '/api/review';

async function postJson<T>(body: unknown): Promise<T> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // A 500 (or a Vercel platform error) can come back as an HTML page, so
    // .json() would throw a SyntaxError and hide the real status. Read as
    // text and try to parse, same as ingestClient.ts and recordsStoreClient.ts.
    const raw = await res.text().catch(() => '');
    let message = `${res.status} ${res.statusText}`;
    let parsedBody: unknown = null;
    try {
      parsedBody = JSON.parse(raw);
      const parsed = parsedBody as { error?: string };
      if (parsed?.error) message = parsed.error;
    } catch {
      /* not JSON — keep the status */
    }
    if (res.status === 429) message = messageFromResponse(res, parsedBody, message);
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

/** The subset of a `documents` row every review action hands back, so the
 *  caller can reconcile local state with what the server actually wrote. */
export interface ReviewDocument {
  id: string;
  stage: 'received' | 'read' | 'mapped' | 'linked' | 'verified';
  document_type: string | null;
  verified_by: string | null;
  verified_at: string | null;
  [key: string]: unknown;
}

export interface ReviewExtraction {
  id: string;
  field_key: string;
  value: string | null;
  corrected_value: string | null;
  corrected_by?: string | null;
  corrected_at?: string | null;
}

export interface DocumentLink {
  document_id: string;
  entity_id: string;
  confidence: number | null;
  linked_by: string | null;
  created_at: string;
}

export interface Correction {
  document_id: string;
  field_key: string;
  corrected_value: string;
  corrected_by: string | null;
  corrected_at: string | null;
}

export interface ReviewCompleteness {
  type: string;
  required: string[];
  present: string[];
  missing: string[];
  minConfidence: number;
  complete: boolean;
}

export interface ReclassifyChange {
  documentId: string;
  from: string | null;
  to: string;
}

/** One document extractReminders (below) actually found a reminder on. */
export interface ReminderExtractChange {
  documentId: string;
  reminderText: string;
}

export interface ReviewEntity {
  id: string;
  entity_type: string;
  data: Record<string, unknown>;
  merged_into: string | null;
  [key: string]: unknown;
}

/* ---------------------------------------------------------- integrity check
 * handoffs/DATA_INTEGRITY_2026-09-20.md's integrityScan/integrityFix actions
 * (owner request 2026-09-20, item 3). Same POST /api/review dispatch as
 * everything else in this file. */

export interface IntegrityDuplicateCustomer { keepId: string; dropId: string; score: number; reason: string }
export interface IntegrityUnlinkedDocument { documentId: string; hasCustomerName: boolean; hasAddress: boolean; hasSerial: boolean; suggestedCustomerId: string | null }
export interface IntegrityEquipmentWithoutCustomer { equipmentId: string; suggestedCustomerId: string | null }
export interface IntegrityMultiUnitUnderLinked { documentId: string; unitsExtracted: number; unitsLinked: number }
export interface IntegrityOrphanEquipment { equipmentId: string }
/** A normalized address the shop-address guard flagged as the contractor's
 *  own letterhead (or the tenant's address on file) rather than a customer's
 *  — see api/_lib/integrity.js's isLikelyShopAddress. `placeholderCustomerId`
 *  is set when an address-only "Customer at ..." placeholder already exists
 *  at that address (a candidate for the `retireShopCustomers` fix below). */
export interface IntegritySuspectedShopAddress {
  addressKey: string;
  shopAddressDocs: number;
  serviceAddressDocs: number;
  distinctCustomerNames: number;
  viaTenantAddress?: boolean;
  placeholderCustomerId?: string | null;
}

/** Limit-test defect A (2026-09-20): a customer whose phone/email is a
 *  likely shop (contractor letterhead) value — see api/_lib/integrity.js's
 *  isLikelyShopPhone/isLikelyShopEmail. stripShopContact's target list. */
/** `rederivedTo` (round-3 fix, 2026-09-21) is set only on a `stripShopContact`
 *  fix result, never on the scan's own `shopContactLeaks` list: the real
 *  value stripShopContact found on the customer's own documents once the
 *  shop leak was removed, if any (see api/_lib/routes/integrity.js's
 *  rederiveCustomerContact). */
export interface IntegrityShopContactLeak { customerId: string; field: 'phone' | 'email'; value: string; rederivedTo?: string }
/** Limit-test defect C (2026-09-20): a document whose direct customer link
 *  disagrees at the name level with its own extracted customer_name —
 *  relinkMismatchedNames' target list. */
export interface IntegrityMismatchedNameLink { documentId: string; customerId: string; docCustomerName: string }
/** Limit-test defect B, item 3 (2026-09-20): a document whose direct
 *  customer differs from its linked unit's customer — needs a person,
 *  never auto-fixed. */
export interface IntegritySplitLinkDocument { documentId: string; directCustomerId: string | null; unitCustomerId: string | null }
/** Limit-test defect D (2026-09-20): a document linked to its customer by
 *  name alone, whose surname now matches 2+ non-merged customers — needs a
 *  person, never auto-fixed. */
export interface IntegrityAmbiguousNameOnlyLink { documentId: string; customerId: string; candidates: string[] }
/** Owner defect report (2026-09-22): a same-normalized-address, different-
 *  name pair (api/_lib/routes/customers.js's planPossibleDuplicates) — never
 *  proposed for auto-merge, so it carries no `tier`/`score` the way
 *  IntegrityDuplicateCustomer does. `reason` is 'same address, different
 *  name' or 'likely typo' (a Damerau <=1 surname match, e.g. Sorensen/
 *  Sorenson). `keepId`/`dropId` are only the default suggestion for the
 *  Merge action's fuller-name pick — either side can still be merged into
 *  the other. */
export interface IntegrityPossibleDuplicate { aId: string; bId: string; keepId: string; dropId: string; reason: 'same address, different name' | 'likely typo' }

export interface IntegrityScanResult {
  duplicateCustomers: IntegrityDuplicateCustomer[];
  possibleDuplicates: IntegrityPossibleDuplicate[];
  unlinkedDocuments: IntegrityUnlinkedDocument[];
  equipmentWithoutCustomer: IntegrityEquipmentWithoutCustomer[];
  multiUnitDocsUnderLinked: IntegrityMultiUnitUnderLinked[];
  orphanEquipment: IntegrityOrphanEquipment[];
  suspectedShopAddresses: IntegritySuspectedShopAddress[];
  shopContactLeaks: IntegrityShopContactLeak[];
  mismatchedNameLinks: IntegrityMismatchedNameLink[];
  splitLinkDocuments: IntegritySplitLinkDocument[];
  ambiguousNameOnlyLinks: IntegrityAmbiguousNameOnlyLink[];
  /** 2026-09-23: memos/correspondence whose body names exactly one existing customer (would be linked by the
   *  linkBodyNames fix) and those with an ambiguous/partial match (never automatic - "Needs your review"). */
  bodyNameLinks?: { documentId: string; customerId: string; name: string; basis: string; page: number }[];
  bodyNameReview?: { documentId: string; kind: 'ambiguous' | 'partial'; candidates: { customerId: string; name: string }[] }[];
  counts: {
    duplicateCustomers: number;
    possibleDuplicates: number;
    unlinkedDocuments: number;
    equipmentWithoutCustomer: number;
    multiUnitDocsUnderLinked: number;
    orphanEquipment: number;
    suspectedShopAddresses: number;
    shopContactLeaks: number;
    mismatchedNameLinks: number;
    splitLinkDocuments: number;
    ambiguousNameOnlyLinks: number;
    bodyNameLinks: number;
    bodyNameReview: number;
  };
}

export type IntegrityApplyAction =
  | 'mergeDuplicates' | 'linkDocuments' | 'linkEquipmentCustomers' | 'createMissingUnits'
  | 'healMergedSurvivors' | 'retireShopCustomers' | 'stripShopContact' | 'relinkMismatchedNames'
  | 'healSplitUnits' | 'refillCustomerContacts' | 'absorbAddressPlaceholders' | 'linkBodyNames';

// Review fix (2026-09-20, reviewer NO-GO item 2): relinkMismatchedNames is
// deliberately NOT in this list. It repoints a document from one customer to
// another — not merely adding a link or filling a blank the way every other
// action here does — so "Fix everything" never applies it unattended.
// IntegrityPanel surfaces it as its own reviewable action instead, from the
// scan's `mismatchedNameLinks` list, with its own explicit confirm.
// stripShopContact stays in this list: it is safe by construction (its
// target already cleared the 3+ distinct-address floor, or matches the
// tenant's own configured contact exactly — never a judgement call).
export const ALL_INTEGRITY_FIXES: IntegrityApplyAction[] = [
  'mergeDuplicates', 'linkDocuments', 'linkEquipmentCustomers', 'createMissingUnits', 'healMergedSurvivors',
  'stripShopContact',
  // Round 4 (2026-09-21): both safe/additive like healMergedSurvivors above —
  // healSplitUnits only moves a unit when every document naming its serial
  // unanimously agrees on a different customer; refillCustomerContacts only
  // ever fills an EMPTY phone/email, never overwrites one.
  'healSplitUnits', 'refillCustomerContacts',
  // Round 2 gap 4 (2026-09-21): also safe/additive — only ever merges a
  // placeholder into an UNAMBIGUOUSLY matched named customer at the same
  // address (see planAddressPlaceholderAbsorptions in api/_lib/integrity.js).
  'absorbAddressPlaceholders',
  // 2026-09-23: deterministic, additive - links a memo whose BODY names exactly one existing customer
  // (api/_lib/bodyNameLink.js); ambiguous/partial matches are only reported, never applied.
  'linkBodyNames',
];

/** The ordinary result of an integrityFix call. */
export interface IntegrityFixApplied {
  dryRun: boolean;
  merged: { keepId: string; dropId: string; score: number }[];
  documentsLinked: { documentId: string; customerId: string; alreadyLinked?: boolean }[];
  equipmentLinked: { equipmentId: string; customerId: string }[];
  unitsCreated: { documentId: string; equipmentId: string; serial: string }[];
  survivorsHealed: { survivorId: string }[];
  shopCustomersRetired: { customerId: string; addressKey: string; documentIds: string[] }[];
  shopContactStripped: IntegrityShopContactLeak[];
  mismatchedNamesRelinked: { documentId: string; fromCustomerId: string; toCustomerId: string | null }[];
  /** Round 3 (2026-09-21): units move as a GROUP, not per document — a unit
   *  only moves once every document that named its serial under the old
   *  customer got relinked into the same new one. One entry per
   *  (fromCustomerId -> toCustomerId) pair actually relinked this run. */
  unitsMovedByGroup: { fromCustomerId: string; toCustomerId: string; documentIds: string[]; unitsMoved: number }[];
  /** Round 4 (2026-09-21): healSplitUnits — a unit whose serial's documents
   *  unanimously point at a different customer than the unit currently has. */
  splitUnitsHealed: { equipmentId: string; from: string; to: string }[];
  /** Round 4 (2026-09-21): refillCustomerContacts — a customer whose phone/
   *  email was empty, filled from that customer's own documents. */
  customerContactsFilled: { customerId: string; field: 'phone' | 'email'; value: string }[];
  /** Round 2 gap 4 (2026-09-21): absorbAddressPlaceholders — a placeholder
   *  customer (data.name_source='address') merged into the one named
   *  customer at the identical normalized address. keepId is the survivor
   *  (the named customer); dropId (the placeholder) ends up merged_into it. */
  addressPlaceholdersAbsorbed: { keepId: string; dropId: string }[];
  /** 2026-09-23: linkBodyNames - documents linked because their body names one existing customer, and those left
   *  for review (ambiguous/partial). */
  bodyNamesLinked?: { documentId: string; customerId: string; name: string; basis: string; page: number }[];
  bodyNamesForReview?: { documentId: string; kind: 'ambiguous' | 'partial'; candidates: { customerId: string; name: string }[] }[];
  skipped: { documentId: string | null; reason: string }[];
}

/** Returned instead of IntegrityFixApplied when a link-only sweep
 *  (linkDocuments/linkEquipmentCustomers, e.g. the Inbox auto-fix in
 *  usePostgresSync.ts) is server-side debounced: one already ran for this
 *  tenant within the last 10 minutes. `skipped` is a literal `true` here —
 *  deliberately not the `skipped` ARRAY field name IntegrityFixApplied uses,
 *  so callers must check which shape they got before touching either. */
export interface IntegrityFixDebounced {
  skipped: true;
  reason: 'recent';
}

export type IntegrityFixResult = IntegrityFixApplied | IntegrityFixDebounced;

/** True when `result` is the debounced ("skipped, ran recently") shape
 *  rather than an ordinary applied-fix result. Narrows the union — prefer
 *  this over inspecting `result.skipped` directly, since that field means
 *  two different things in the two branches. */
export function isIntegrityFixDebounced(result: IntegrityFixResult): result is IntegrityFixDebounced {
  return result.skipped === true;
}

/* ---- Donovan Scorecard (operator only; api/_lib/routes/scorecard.js) ------------------------------ */

export interface ScorecardRun {
  id: string;
  source: 'operator' | 'nightly' | 'retry';
  examVersion: string | null;
  status: 'running' | 'complete' | 'stopped';
  stopReason: string | null;
  totalQuestions: number;
  answered: number;
  passed: number;
  /** 0-1, null until something has been graded. */
  score: number | null;
  /** 0-1 share whose VALUE was right, citations aside (the status action derives it from the per-question results). */
  valueScore?: number | null;
  /** Of the answers that needed a citation, how many carried one. */
  citation?: { required: number; cited: number; coverage: number | null };
  byCategory: Record<string, { passed: number; total: number; score: number; valueScore?: number; citationCoverage?: number | null }>;
  costUsd: number;
  models: string[];
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ScorecardFailing {
  questionId: string;
  category: string;
  question: string;
  expected: string | null;
  got: string | null;
  models?: string[];
  persona?: string;
  /** false = the value itself was wrong; true with cited=false = right but no source. */
  valueOk?: boolean;
  cited?: boolean;
  citationRequired?: boolean;
  retry?: { model: string; passed: boolean; got?: string };
  error?: string;
}

/** ROUND 14: the AI provider account is currently marked unavailable (out of credits, a bad/revoked
 *  key, or overloaded past its retries — api/_lib/claude.js's classifyProviderError). `since` is when
 *  it was FIRST seen, not the most recent request that hit it. Absent/null = not currently unavailable. */
export interface ProviderOutageStatus {
  reason: 'credits' | 'auth' | 'overloaded';
  detail: string | null;
  since: string;
}

export interface ScorecardStatus {
  backend: 'tables' | 'audit' | 'memory';
  exam: { version: string; questions: number; categories: Record<string, number>; personas?: Record<string, number> };
  budgetUsd: number;
  /** Why a failure here means Donovan was wrong (the answer key is audited; see test-docs/scorecard/ADJUDICATION.md). */
  adjudicationNote?: string;
  run: ScorecardRun | null;
  previous: { id: string; score: number; startedAt: string | null; answered: number; valueScore?: number | null; citationCoverage?: number | null } | null;
  runs: { id: string; source: string; status: string; score: number | null; answered: number; startedAt: string | null; costUsd: number }[];
  failing: ScorecardFailing[];
  /** ROUND 14: set whenever the AI provider is currently unavailable, even between runs. */
  providerStatus?: ProviderOutageStatus | null;
}

export interface ScorecardPage {
  error?: string;
  message?: string;
  runId: string;
  backend: string;
  nextOffset: number | null;
  done: boolean;
  stopped: string | null;
  total: number;
  spentUsd: number;
  run: ScorecardRun | null;
}

/** One outcome bucket in a miss report — see api/_lib/missStore.js's
 *  MISS_OUTCOMES for the codes ('no-answer', 'money-fallback',
 *  'maintenance-fallback', 'unsupported-condition', 'contact-lookup-zero',
 *  'contact-lookup-ambiguous', 'analytics-fallthrough'). */
export interface MissReportGroup {
  outcome: string;
  count: number;
  topQuestions: { text: string; count: number; replay?: MissReplay }[];
}

/** What happened when Donovan re-ran a miss (api/_lib/learning/replay.js): answered now (with the
 *  answer it gave) or still failing (with why). Absent = never replayed. */
export interface MissReplay {
  outcome: 'answered_now' | 'still_failing';
  reason: string | null;
  answer: { text?: string; facts?: { label: string; value: string }[] } | null;
  note: string | null;
  replayedAt: string;
}

export interface MissReport {
  total: number;
  groups: MissReportGroup[];
  /** True when the signed-in caller is a DeepWell platform operator (the
   *  founder tenant, or a Clerk user id on the operator allowlist) — never
   *  hardcoded client-side, always trusted from the server's own gate. Drives
   *  whether DonovanMissesCard shows "Send digest now". */
  isOperator: boolean;
  /** Distinct missed questions by replay status (server-computed). */
  replaySummary?: { answeredNow: number; stillFailing: number; notReplayed: number };
}

/** One question in a miss-digest group or its overall top-25 list — see
 *  api/_lib/missDigest.js's buildDigestFromRows. */
export interface MissDigestQuestion {
  question: string;
  outcome?: string;
  count: number;
  tenantCount: number;
  isNew: boolean;
  firstSeen: string;
  lastSeen: string;
}

export interface MissDigestGroup {
  outcome: string;
  count: number;
  questions: MissDigestQuestion[];
}

/** Cross-tenant platform digest (handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md,
 *  Tier 1 self-learning loop) — operator-only, never a tenant-facing shape. */
export interface MissDigest {
  since: string;
  now: string;
  totals: {
    totalMisses: number;
    totalTenants: number;
    totalQuestions: number;
    newQuestionsCount: number;
  };
  groups: MissDigestGroup[];
  topQuestions: MissDigestQuestion[];
  /** ROUND 14 (brief item 5): set whenever the AI provider was unavailable at digest-build time. */
  providerStatus?: ProviderOutageStatus | null;
}

export interface MissDigestResult {
  digest: MissDigest;
  emailed?: boolean;
  notified?: boolean;
  skippedReason?: string;
}

/** One row of scripts/miss-review.mjs's / the question bank's export shape. */
export interface MissExportItem {
  text: string;
  suggestedRoute: string;
}

/* -------------------------------------------------------- self-learning loop
 * Tier 2 Part B (handoffs/DONOVAN_SELF_LEARNING_2026-09-22.md) — the nightly
 * learner's proposal queue. Operator-only, same as MissDigest above (the
 * server 403s anyone who isn't a platform operator). See
 * api/_lib/learning/proposals.js's PROPOSAL_KINDS for `kind`, and
 * M3-config/26-donovan-learning.sql for the `status` lifecycle. */

export type LearningProposalKind = 'abbreviation' | 'typo' | 'synonym' | 'few_shot' | 'capability_gap' | 'recipe';
export type LearningProposalStatus = 'pending' | 'approved' | 'rejected' | 'auto_rejected' | 'auto_approved';

/** api/_lib/learning/verify.js's verifyProposal/verifyProposalLive result,
 *  stored verbatim on the proposal row at the time it was decided (or, for a
 *  still-pending one, the check the sweep already ran before leaving it
 *  pending). */
export interface LearningVerification {
  ok: boolean;
  reasons: string[];
  missFixed: { fixed: number; total: number };
  bankPass: number;
  bankTotal: number;
  regressions: unknown[];
  negativesPass: boolean;
}

export interface LearningProposal {
  id: string;
  kind: LearningProposalKind;
  payload: Record<string, unknown>;
  evidence: { questions?: string[]; count?: number; tenantCount?: number; seen?: number; thumbsUp?: number };
  verification: LearningVerification;
  status: LearningProposalStatus;
  reason: string | null;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
  /** capability_gap only: the replay outcome of its example question, when one exists. */
  replay?: MissReplay;
  /** ROUND 14 (brief item 4, dedupe by normalized title): capability_gap only. When several pending
   *  proposals share the same normalized title, the server folds them into one row and reports how
   *  many (`groupCount`) plus every id in the group (`groupIds`, this row's own id included) — used by
   *  "Reject all" for that group. Absent/1 = not part of a group. */
  groupCount?: number;
  groupIds?: string[];
}

/** api/_lib/learning/replay.js's replayMisses() summary. */
export interface ReplaySummary {
  attempted: number;
  answeredNow: number;
  stillFailing: number;
  remaining: number;
  costUsd: number;
  stopped: string | null;
  recipes: { pending: number; live: number; notEligible: number };
  items: { question: string; outcome: 'answered_now' | 'still_failing'; reason?: string; recipe?: string; answer?: MissReplay['answer'] }[];
}

/** The honest counts the Learning card leads with. */
export interface LearningSummary {
  recipesActive: number;
  answeredNow: number;
  stillFailing: number;
  notReplayed: number;
}

export interface LearningRunSummary {
  totalMissGroups?: number;
  modelCallsMade?: number;
  estimatedCostUsd?: number;
  byStatus?: Record<string, number>;
  byKind?: Record<string, number>;
  skipped?: string;
  error?: string;
  replay?: Partial<ReplaySummary> & { skipped?: string; error?: string };
  /** ROUND 14 (brief item 4): capability_gap proposals whose example question was re-checked this run. */
  gapAutoResolve?: { checked: number; resolved: number; stillOpen: number; stopped: string | null; skipped?: string; error?: string };
  /** ROUND 14 (brief item 3): set to a plain, human-readable line whenever the AI provider is unavailable. */
  providerStatus?: string;
}

/** One row of donovan_learned (M3-config/26-donovan-learning.sql) — an
 *  ACTIVE learned item, deactivatable by `id`. */
export interface LearningLearnedItem {
  id: string;
  kind: LearningProposalKind;
  key: string;
  value: Record<string, unknown>;
  created_at: string;
}

export interface LearningExportItem {
  id: string;
  kind: LearningProposalKind;
  payload: Record<string, unknown>;
  status: LearningProposalStatus;
  decidedAt: string | null;
  decidedBy: string | null;
  createdAt: string;
}

/* -------------------------------------------------------- autonomous per-tenant learning loop
 * TEAM H (2026-09-24): api/_lib/learning/autopilot.js's nightly per-tenant run — operator-only,
 * cross-tenant summary (counts + cost only, never a customer's question text). */

export interface AutopilotTenantSummary {
  tenantKey: string;
  replayed: number;
  answeredNow: number;
  examAnswered: number;
  examPassed: number;
  vocabMined: number;
  vocabPromoted: number;
  demoted: number;
  costUsd: number;
  skipped: string | null;
  at: string;
}

export interface AutopilotStatus {
  tenantsEligible: number;
  perTenant: AutopilotTenantSummary[];
  platformSpentUsd: number;
  nextTenant: { tenantKey: string; tenantName?: string } | null;
  gapReportWeekStart: string | null;
}

export interface GapCluster {
  capability: string;
  count: number;
  tenantCount: number;
  industries: string[];
  examples: string[];
  fixSpec: string;
}

export interface GapReport {
  weekStart: string;
  generatedAt?: string;
  totalFailures: number;
  clusters: GapCluster[];
}

/** Search-by-meaning progress (api/_lib/search/store.js semanticStatus). */
export interface SemanticStatus {
  configured: boolean;
  ready: boolean;
  /** why it is not ready: no VOYAGE_API_KEY, or M3-config/31 not pasted yet */
  reason?: 'not-configured' | 'migration-pending';
  model: string;
  rerank: boolean;
  pagesTotal?: number;
  pagesEmbedded?: number;
  pagesRemaining?: number;
  chunks?: number;
  tokensToday?: number;
  tokenBudget?: number;
}
export interface SemanticBackfillResult {
  stoppedBy: 'done' | 'deadline' | 'budget' | 'off' | 'no-schema' | 'error';
  pagesDone: number;
  chunksDone: number;
  tokens: number;
  status: SemanticStatus;
}

export const reviewClient = {
  /** Owner/admin: how many pages are searchable by meaning. */
  semanticStatus() {
    return postJson<SemanticStatus>({ action: 'semanticStatus' });
  },

  /** Owner/admin: embed existing pages for ~30 s; call again until stoppedBy is not 'deadline'. */
  semanticBackfill() {
    return postJson<SemanticBackfillResult>({ action: 'semanticBackfill' });
  },

  /** Correct an extracted field, or add one that was never extracted. */
  correctField(documentId: string, fieldKey: string, value: string, by: string) {
    return postJson<{ document: ReviewDocument; extraction: ReviewExtraction }>({
      action: 'correctField',
      documentId,
      fieldKey,
      value,
      by,
    });
  },

  classifyDocument(documentId: string, documentType: string) {
    return postJson<{ document: ReviewDocument }>({
      action: 'classifyDocument',
      documentId,
      documentType,
    });
  },

  linkDocument(documentId: string, entityId: string, by: string) {
    return postJson<{ document: ReviewDocument; links: DocumentLink[] }>({
      action: 'linkDocument',
      documentId,
      entityId,
      by,
    });
  },

  unlinkDocument(documentId: string, entityId: string) {
    return postJson<{ document: ReviewDocument }>({
      action: 'unlinkDocument',
      documentId,
      entityId,
    });
  },

  verifyDocument(documentId: string, by: string) {
    return postJson<{ document: ReviewDocument }>({
      action: 'verifyDocument',
      documentId,
      by,
    });
  },

  unverifyDocument(documentId: string) {
    return postJson<{ document: ReviewDocument }>({
      action: 'unverifyDocument',
      documentId,
    });
  },

  mergeEntities(keepId: string, dropId: string) {
    return postJson<{ keep: ReviewEntity; dropped: ReviewEntity }>({
      action: 'mergeEntities',
      keepId,
      dropId,
    });
  },

  /** Bulk fetch for usePostgresSync: every document_entity_links row for a
   *  batch of documents in one round trip. */
  listLinks(documentIds: string[]) {
    if (!documentIds.length) return Promise.resolve<{ links: DocumentLink[] }>({ links: [] });
    return postJson<{ links: DocumentLink[] }>({ action: 'listLinks', documentIds });
  },

  /** Bulk fetch for usePostgresSync: every corrected field for a batch of
   *  documents in one round trip. */
  listCorrections(documentIds: string[]) {
    if (!documentIds.length) return Promise.resolve<{ corrections: Correction[] }>({ corrections: [] });
    return postJson<{ corrections: Correction[] }>({ action: 'listCorrections', documentIds });
  },

  /** AI VERIFICATION CONTRACT: recomputes completeness from stored
   *  extractions and promotes to verified (verified_by 'ai') if complete and
   *  confident enough. No-op (verified:false) otherwise — never an error. */
  aiVerify(documentId: string) {
    return postJson<{ document: ReviewDocument; completeness: ReviewCompleteness; verified: boolean }>({
      action: 'aiVerify',
      documentId,
    });
  },

  /** Batch reclassification of legacy/unknown/'other' document_type values
   *  (≤100 ids; may make a few cheap model calls for stubborn ones). `remaining`
   *  is how many of THESE ids are still 'other' after this pass — the caller
   *  loops, resubmitting only the still-'other' ids, until it hits 0. */
  reclassify(documentIds: string[]) {
    if (!documentIds.length) return Promise.resolve<{ changes: ReclassifyChange[]; remaining: number }>({ changes: [], remaining: 0 });
    return postJson<{ changes: ReclassifyChange[]; remaining: number }>({ action: 'reclassify', documentIds });
  },

  /** Backfill for documents extracted before the CUSTOMER REMINDERS build
   *  (2026-09-22): one Haiku call per eligible document (≤20 per batch,
   *  billing-gated server-side), reading reminder_text/reminder_customer_name/
   *  reminder_trigger off its already-read page text with no re-extraction of
   *  anything else. `remaining` is how many of these ids still need another
   *  pass, same "loop, resubmitting only what's left, until it hits 0"
   *  contract as reclassify above. */
  extractReminders(documentIds: string[]) {
    if (!documentIds.length) return Promise.resolve<{ changes: ReminderExtractChange[]; remaining: number }>({ changes: [], remaining: 0 });
    return postJson<{ changes: ReminderExtractChange[]; remaining: number }>({ action: 'extractReminders', documentIds });
  },

  /** "Check records" — duplicate customers, unlinked documents, equipment
   *  without a customer, under-linked multi-unit documents. Read-only. */
  integrityScan() {
    return postJson<IntegrityScanResult>({ action: 'integrityScan' });
  },

  /** "Fix everything Donovan is sure about" — admin-only in the UI (the
   *  server itself also requires admin when the tenant is a Clerk org).
   *  Idempotent: safe to call again after a partial failure. */
  integrityFix(apply: IntegrityApplyAction[] = ALL_INTEGRITY_FIXES, dryRun = false) {
    return postJson<IntegrityFixResult>({ action: 'integrityFix', apply, dryRun });
  },

  /** Donovan misses (handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md) — up to
   *  the last 200 ask_misses rows for this tenant, grouped by outcome.
   *  `days`, when passed, additionally restricts to the last N days (the
   *  Team screen's card passes 7). Owner/admin only (the server enforces
   *  this too). */
  missReport(days?: number) {
    return postJson<MissReport>({ action: 'missReport', days });
  },

  /** Same underlying table, shaped for the question bank instead of the
   *  review card: {text, suggestedRoute} per distinct normalized question. */
  exportMisses() {
    return postJson<{ items: MissExportItem[] }>({ action: 'exportMisses' });
  },

  /** Platform-operator-only: the cross-tenant miss digest (Tier 1 of the
   *  self-learning loop). `send: true` also emails/notifies the DeepWell
   *  owners; omitted (or false), it just returns the digest to look at. The
   *  server 403s anyone who isn't a platform operator — DonovanMissesCard
   *  only shows the button when MissReport.isOperator says so. */
  missDigest(opts?: { since?: string; send?: boolean }) {
    return postJson<MissDigestResult>({ action: 'missDigest', since: opts?.since, send: opts?.send });
  },

  /** Platform-operator-only: the nightly learner's proposal queue AND the
   *  currently-active learned items, in one round trip. `status` omitted
   *  returns every proposal status; the server caps `limit` at 1000. */
  learningList(opts?: { status?: LearningProposalStatus; limit?: number }) {
    return postJson<{ items: LearningProposal[]; activeLearned: LearningLearnedItem[]; summary?: LearningSummary }>({
      action: 'learningList',
      status: opts?.status,
      limit: opts?.limit,
    });
  },

  /** Approve or reject one pending proposal. An approve RE-VERIFIES against
   *  the current routing bank/vocabulary server-side first — a stale
   *  proposal (something changed since it was proposed) comes back as a 409,
   *  not a silently-applied learned row. */
  learningDecide(id: string, decision: 'approved' | 'rejected') {
    return postJson<{
      ok: boolean; status: LearningProposalStatus; verification?: LearningVerification;
      /** Approving a "Can't do yet" note replays its example question; this is what came back. */
      replay?: { replayed: boolean; outcome?: 'answered_now' | 'still_failing'; reason?: string; answer?: MissReplay['answer']; recipe?: string; stopped?: string };
    }>({
      action: 'learningDecide',
      id,
      decision,
    });
  },

  /** Retires one ACTIVE donovan_learned row (soft-delete — its history and
   *  the proposal it came from are kept). */
  learningDeactivate(learnedId: string) {
    return postJson<{ ok: boolean }>({ action: 'learningDeactivate', learnedId });
  },

  /** ROUND 14 (brief item 4): bulk-reject pending "Can't do yet" (capability_gap) notes — every one
   *  currently pending, or (from a dedupe group's "Reject all") just the given `ids`. */
  learningRejectAllGaps(opts?: { ids?: string[] }) {
    return postJson<{ rejected: number }>({ action: 'learningRejectAllGaps', ids: opts?.ids });
  },

  /** Runs the nightly learning sweep on demand ("Run learning now"). Same
   *  work as the cron step, no once-per-day guard, but still a REAL billed
   *  model call (up to DONOVAN_LEARN_MAX_CALLS Haiku calls) — the server
   *  rate-limits this action for exactly that reason. */
  learningRunNow() {
    return postJson<LearningRunSummary>({ action: 'learningRunNow' });
  },

  /** Operator: re-run this shop's open misses through Donovan now (up to 15 per call; call again while
   *  `remaining` > 0). Records answered-now / still-failing per miss and creates recipe proposals. */
  learningReplay(opts?: { questions?: string[]; force?: boolean }) {
    return postJson<ReplaySummary>({ action: 'learningReplay', questions: opts?.questions, force: opts?.force });
  },

  /** Operator: last night's per-tenant autopilot summary (counts + cost only), spend vs. the daily
   *  caps, and which tenant runs next in tonight's fair rotation. */
  learningAutopilotStatus() {
    return postJson<AutopilotStatus>({ action: 'learningAutopilotStatus' });
  },

  /** Operator: the weekly cross-tenant gap report — capability clusters with counts, affected
   *  industries and a proposed fix-spec paragraph each. `rebuild: true` recomputes it live instead of
   *  returning the last one the nightly cron stored. */
  learningGapReport(opts?: { rebuild?: boolean }) {
    return postJson<GapReport>({ action: 'learningGapReport', rebuild: opts?.rebuild });
  },

  /** Operator: latest Donovan Scorecard run, trend vs the previous one, per-category scores and the failing list. */
  scorecardStatus(runId?: string) {
    return postJson<ScorecardStatus>({ action: 'scorecardStatus', ...(runId ? { runId } : {}) });
  },

  /** Operator: ONE page (about 6 questions) of a scorecard run. Pass back `runId` + `nextOffset` for the next page. */
  scorecardRun(payload: { scope?: 'full' | 'slice' | 'category' | 'ids'; runId?: string; offset?: number; retryOfRunId?: string; category?: string }) {
    return postJson<ScorecardPage>({ action: 'scorecardRun', ...payload });
  },

  /** Thumbs on an answer. Up confirms the recipe behind it; down records a correction miss, retires any
   *  live shortcut for that question and re-asks Donovan once, with the note as a hint. */
  askFeedback(question: string, rating: 'up' | 'down', note?: string) {
    return postJson<{
      ok: boolean; status?: string; retired?: boolean; budget?: boolean;
      replay?: { outcome: 'answered_now' | 'still_failing'; reason: string | null; answer: MissReplay['answer'] } | null;
    }>({ action: 'askFeedback', question, rating, note });
  },

  /** approved + auto_approved items as JSON, for folding into the repo's
   *  vocab/bank by the weekly Claude Code session (handoffs/
   *  DONOVAN_SELF_LEARNING_2026-09-22.md's "weekly repo-sync step"). */
  learningExport() {
    return postJson<{ items: LearningExportItem[] }>({ action: 'learningExport' });
  },
};

/** Replays every open miss (operator only): calls learningReplay until nothing is left, a budget/cost stop
 *  is reported, or `maxRounds` is hit. `onProgress` gets the running totals after each round. */
export async function replayAllMisses(
  onProgress?: (totals: { attempted: number; answeredNow: number; stillFailing: number; remaining: number; stopped: string | null }) => void,
  maxRounds = 30,
) {
  const totals = { attempted: 0, answeredNow: 0, stillFailing: 0, remaining: 0, stopped: null as string | null, recipesLive: 0 };
  for (let round = 0; round < maxRounds; round++) {
    const r = await reviewClient.learningReplay();
    totals.attempted += r.attempted;
    totals.answeredNow += r.answeredNow;
    totals.stillFailing += r.stillFailing;
    totals.remaining = r.remaining;
    totals.stopped = r.stopped;
    totals.recipesLive += r.recipes?.live ?? 0;
    onProgress?.(totals);
    if (r.stopped === 'model-budget' || r.stopped === 'cost-ceiling' || r.stopped === 'agent-disabled' || r.remaining <= 0 || r.attempted === 0) break;
  }
  return totals;
}

/** Runs a whole scorecard (operator only), one server page at a time, until the exam is done, the spend budget is
 *  reached, or `maxPages` is hit. `onProgress` gets {answered, total} after each page. */
export async function runScorecardAll(
  opts: { scope?: 'full' | 'slice'; retryOfRunId?: string } = {},
  onProgress?: (p: { offset: number; total: number; spentUsd: number }) => void,
  maxPages = 80,
): Promise<ScorecardPage> {
  let runId: string | undefined;
  let offset = 0;
  let last: ScorecardPage | null = null;
  for (let page = 0; page < maxPages; page++) {
    last = await reviewClient.scorecardRun({ ...opts, ...(runId ? { runId } : {}), offset });
    if (last.error) throw new Error(last.message ?? last.error);
    runId = last.runId;
    onProgress?.({ offset: last.nextOffset ?? last.total, total: last.total, spentUsd: last.spentUsd });
    if (last.done || last.nextOffset == null) break;
    offset = last.nextOffset;
  }
  if (!last) throw new Error('The scorecard did not start.');
  return last;
}
