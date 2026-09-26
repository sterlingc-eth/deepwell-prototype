/**
 * DeepWell core types — domain-neutral.
 *
 * Nothing in this file knows about HVAC. A domain adapter (see
 * src/domains/*) declares entity types, document types, required fields and
 * question patterns; the core handles the pipeline, the entity graph, and the
 * answer shape. That is what lets DeepWell sit on top of other applications:
 * host apps supply entities and documents, and get back cited answers.
 */

export type EntityId = string;
export type DocumentId = string;
export type BatchId = string;

export type FieldValue = string | number | Date | null;
export type FieldKind = 'text' | 'date' | 'money' | 'serial' | 'number' | 'ref';

// ---------------------------------------------------------------------------
// Domain schema (declared by the adapter)
// ---------------------------------------------------------------------------

export interface FieldSpec {
  /** Key on Entity.fields */
  key: string;
  label: string;
  kind: FieldKind;
  /** For kind 'ref': which entity type the value points at */
  refType?: string;
}

export interface EntityTypeSpec {
  id: string;
  label: string;
  labelPlural: string;
  fields: FieldSpec[];
  /** Field whose value is the human label for the entity (address, name, serial) */
  labelField: string;
}

export interface DocumentTypeSpec {
  id: string;
  label: string;
  /** Extracted field names that must be present (and non-empty) before a document counts as Extracted */
  requiredFields: string[];
}

export interface DomainSchema {
  id: string;
  label: string;
  entityTypes: EntityTypeSpec[];
  documentTypes: DocumentTypeSpec[];
  /** Type id used when classification cannot decide */
  fallbackDocumentType: string;
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface Entity {
  id: EntityId;
  type: string;
  fields: Record<string, FieldValue>;
}

// ---------------------------------------------------------------------------
// Documents & the intake pipeline
// ---------------------------------------------------------------------------

export const PIPELINE_STAGES = ['received', 'classified', 'extracted', 'linked', 'verified'] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const INTAKE_SOURCES = ['cabinet', 'email', 'drive', 'truck'] as const;
export type IntakeSource = (typeof INTAKE_SOURCES)[number];

export type FileType = 'pdf' | 'image' | 'spreadsheet' | 'text';

export interface SourceLocation {
  page?: number;
  /** Field label as printed on the document ("Serial No.", "Total due") */
  field?: string;
  /** Free-text region hint ("nameplate, lower left") */
  region?: string;
}

/** Where an extracted value should land in the entity graph. */
export interface FieldTarget {
  entityId: EntityId;
  field: string;
}

export interface ExtractedField {
  /** Field name as we extracted it */
  name: string;
  value: string;
  /** 0–1 */
  confidence: number;
  location: SourceLocation;
  target?: FieldTarget;
  correctedValue?: string;
  correctedBy?: string;
  correctedAt?: Date;
  /** Which physical unit (1, 2, 3, …) this field belongs to, for a document
   *  covering more than one piece of equipment — undefined for document-level
   *  fields and for any document extracted before unit_index was surfaced to
   *  the browser (see src/domains/hvac/units.ts's groupExtractionsByUnit,
   *  which degrades gracefully when this is never set). */
  unitIndex?: number;
}

/** Required-field completeness for one document, as api/_lib/documentTypes.js's
 *  completenessFor computes it (mirrored in src/domains/hvac/documentTypes.ts).
 *  `required`/`missing` entries may be `a|b` alternatives. */
export interface DocCompleteness {
  type: string;
  required: string[];
  present: string[];
  missing: string[];
  minConfidence: number;
  complete: boolean;
}

export type DocumentIssue =
  | { kind: 'missing-field'; field: string }
  | { kind: 'unlinked'; bestGuess?: EntityId; confidence: number }
  | { kind: 'conflict'; conflictId: string }
  | { kind: 'duplicate'; of: DocumentId }
  // Limit-test defect D (2026-09-20): this document was linked to its
  // customer by name alone (no address to disambiguate), and that surname
  // now matches 2+ other non-merged customers — order-dependent at the time
  // it was linked, invisible after. `candidateIds` includes the currently-
  // linked customer. Computed client-side in usePostgresSync.ts from each
  // link's `linked_by` (server value 'ai:name-only' or 'ai:name-mention') plus the already-synced
  // customer entities — no extra round trip.
  | { kind: 'ambiguous-name-link'; surname: string; candidateIds: EntityId[] };

export interface Doc {
  id: DocumentId;
  filename: string;
  /** Human-readable name set once the document is classified, e.g. "Warranty · Carol Rios · Trane XR16 · Jun 12, 2025"
   *  (server documents.display_name, M3-config/41). Always render via documentName() in src/core/documentName.ts,
   *  never this field directly — it falls back to a client-derived name, then the original filename. */
  displayName?: string;
  fileType: FileType;
  pages: number;
  batchId: BatchId;
  source: IntakeSource;
  receivedAt: Date;
  /** Clerk user id of whoever uploaded this document (documents.uploaded_by,
   *  M3-config/20), undefined for a document uploaded before that column
   *  existed or via an API key. Drives the "My work · Everyone" filter
   *  (src/core/workFilter.ts) and the uploader chip shown in Everyone view. */
  uploadedBy?: string;
  /** Domain document type id, null until classified */
  typeId: string | null;
  stage: PipelineStage;
  extracted: ExtractedField[];
  linkedEntityIds: EntityId[];
  /** 0–1 confidence of the strongest link */
  linkConfidence: number;
  issues: DocumentIssue[];
  /** Set when the document was linked to this customer because its BODY names them (server linked_by
   *  'name-in-body', api/_lib/bodyNameLink.js). Drives the non-blocking "Linked from name in document - confirm"
   *  chip in the preview; deliberately NOT a DocumentIssue so it never counts as needing attention. */
  linkedFromBodyName?: EntityId;
  /** Display name of a human verifier, or the literal 'ai' for an automated
   *  AI verification (see the AI VERIFICATION CONTRACT in the team brief). */
  verifiedBy?: string;
  verifiedAt?: Date;
  /** Server-computed required-field completeness, when known. */
  completeness?: DocCompleteness;
  /** Short plain-text rendering used by the document preview */
  preview: string;
}

export interface Batch {
  id: BatchId;
  name: string;
  source: IntakeSource;
  dateRange: { from: Date; to: Date };
  createdAt: Date;
  createdBy: string;
  documentIds: DocumentId[];
}

export interface ConflictCandidate {
  value: string;
  documentId: DocumentId;
  location: SourceLocation;
}

export interface Conflict {
  id: string;
  entityId: EntityId;
  field: string;
  candidates: ConflictCandidate[];
  resolvedValue?: string;
  resolvedBy?: string;
  resolvedAt?: Date;
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

export interface SourceRef {
  documentId: DocumentId;
  location: SourceLocation;
  /** The words on the page the fact came from */
  excerpt?: string;
}

export type FactStatus = 'ok' | 'warn' | 'bad' | 'info' | 'muted';

export interface Fact {
  label: string;
  value: string;
  kind?: FieldKind;
  /** Renders as a status pill when set */
  status?: FactStatus;
  /** Link target — the entity this fact belongs to */
  entityId?: EntityId;
  /**
   * 'printed' (default): the value is written on a cited page, or was
   * already extracted from one. 'computed': the value was derived by
   * arithmetic on other evidence (e.g. an install date plus a warranty
   * term, the same distinction `warrantyRules.js` stores as
   * `expiresBasis`) and no page says it directly — the UI must render this
   * differently (no "as stated in document X" framing) so a calculated date
   * is never shown as though a document printed it.
   */
  basis?: 'printed' | 'computed';
  /** Every fact carries at least one source. */
  sources: SourceRef[];
}

/**
 * One row an answer was computed from (or, for an honest zero, searched). Carried by EVERY /api/ask
 * response (api/_lib/citations/records.js): the drill-down behind "You have 19 customers in Mesa".
 */
export type AnswerRecordType = 'customer' | 'unit' | 'document' | 'invoice';
export interface AnswerRecord {
  type: AnswerRecordType;
  id: string;
  label: string;
  sublabel?: string;
  /** document / invoice: the document to open (defaults to id) */
  documentId?: string;
  /** document / invoice: the cited page */
  page?: number;
  /** unit: the customer that owns it (opens their profile) */
  customerId?: string;
  /** breakdown answers: the group key (matches the breakdown row's label) */
  group?: string;
}

export interface Answer {
  kind: 'answer' | 'no-answer';
  /** 1–3 plain-English sentences */
  text: string;
  facts: Fact[];
  /** Union of fact sources, de-duplicated, in citation order */
  sources: SourceRef[];
  /** 0–1 */
  confidence: number;
  /** Primary entity the answer is about, when there is one */
  entityId?: EntityId;
  /** How many verified vs. unverified documents contributed */
  verifiedCount: number;
  unverifiedCount: number;
  /** For no-answer: the closest documents we could find */
  closest: SourceRef[];
  /** How the question was interpreted — shown as a small caption */
  interpretation?: string;
  /** Citation contract (api/_lib/citations): the exact rows behind the answer, capped server-side. */
  records?: AnswerRecord[];
  /** True number of rows behind the answer (>= records.length when the list was capped). */
  recordsTotal?: number;
  /** 'basis' = rows the answer is computed from; 'searched' = rows searched with no match (honest zero). */
  recordsKind?: 'basis' | 'searched';
  /** One short sentence: how the answer was computed. */
  basis?: string;
}

/**
 * One prior turn in the current AskScreen thread, as the client remembers it —
 * the same shape api/_lib/conversation.js validates server-side (TEAM T2,
 * 2026-09-25). "New question" simply means the caller sends no context at all.
 */
export interface ConversationTurn {
  question: string;
  askedAt?: string;
}
export interface ConversationContext {
  turns: ConversationTurn[];
}

export interface AskOptions {
  includeUnverified?: boolean;
  /** Injected clock so "expiring in 90 days" is testable */
  now?: Date;
  /**
   * Research agent v2 streaming UX (2026-09-25): when set, the Claude-backed provider asks the server
   * to stream progress ("Searching invoices for Plaza Dental…", "Reading 6 documents…") and calls this
   * for each step as it arrives, before the final Answer resolves the promise as usual. A provider that
   * cannot stream (the mock provider, or a server that answered instantly from the deterministic fast
   * layer) simply never calls it — this is cosmetic only, never load-bearing for the answer itself.
   */
  onStep?: (step: { message: string }) => void;
  /** The prior turns in this thread, so a follow-up like "and last year?" composes with them. */
  conversationContext?: ConversationContext;
  /** Cancels the in-flight request (the mobile app's slow-network timeout). */
  signal?: AbortSignal;
}

/** The seam. Mock today; Claude-backed tomorrow; same UI either way. */
export interface AnswerProvider {
  ask(question: string, opts?: AskOptions): Promise<Answer>;
}
