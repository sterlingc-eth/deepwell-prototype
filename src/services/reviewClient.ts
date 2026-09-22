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

export interface IntegrityScanResult {
  duplicateCustomers: IntegrityDuplicateCustomer[];
  unlinkedDocuments: IntegrityUnlinkedDocument[];
  equipmentWithoutCustomer: IntegrityEquipmentWithoutCustomer[];
  multiUnitDocsUnderLinked: IntegrityMultiUnitUnderLinked[];
  orphanEquipment: IntegrityOrphanEquipment[];
  suspectedShopAddresses: IntegritySuspectedShopAddress[];
  shopContactLeaks: IntegrityShopContactLeak[];
  mismatchedNameLinks: IntegrityMismatchedNameLink[];
  splitLinkDocuments: IntegritySplitLinkDocument[];
  ambiguousNameOnlyLinks: IntegrityAmbiguousNameOnlyLink[];
  counts: {
    duplicateCustomers: number;
    unlinkedDocuments: number;
    equipmentWithoutCustomer: number;
    multiUnitDocsUnderLinked: number;
    orphanEquipment: number;
    suspectedShopAddresses: number;
    shopContactLeaks: number;
    mismatchedNameLinks: number;
    splitLinkDocuments: number;
    ambiguousNameOnlyLinks: number;
  };
}

export type IntegrityApplyAction =
  | 'mergeDuplicates' | 'linkDocuments' | 'linkEquipmentCustomers' | 'createMissingUnits'
  | 'healMergedSurvivors' | 'retireShopCustomers' | 'stripShopContact' | 'relinkMismatchedNames'
  | 'healSplitUnits' | 'refillCustomerContacts' | 'absorbAddressPlaceholders';

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

/** One outcome bucket in a miss report — see api/_lib/missStore.js's
 *  MISS_OUTCOMES for the codes ('no-answer', 'money-fallback',
 *  'maintenance-fallback', 'unsupported-condition', 'contact-lookup-zero',
 *  'contact-lookup-ambiguous', 'analytics-fallthrough'). */
export interface MissReportGroup {
  outcome: string;
  count: number;
  topQuestions: { text: string; count: number }[];
}

export interface MissReport {
  total: number;
  groups: MissReportGroup[];
  /** True when the signed-in caller is a DeepWell platform operator (the
   *  founder tenant, or a Clerk user id on the operator allowlist) — never
   *  hardcoded client-side, always trusted from the server's own gate. Drives
   *  whether DonovanMissesCard shows "Send digest now". */
  isOperator: boolean;
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

export const reviewClient = {
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
};
