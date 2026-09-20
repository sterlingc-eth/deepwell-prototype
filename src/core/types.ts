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
  // link's `linked_by` (server value 'ai:name-only') plus the already-synced
  // customer entities — no extra round trip.
  | { kind: 'ambiguous-name-link'; surname: string; candidateIds: EntityId[] };

export interface Doc {
  id: DocumentId;
  filename: string;
  fileType: FileType;
  pages: number;
  batchId: BatchId;
  source: IntakeSource;
  receivedAt: Date;
  /** Domain document type id, null until classified */
  typeId: string | null;
  stage: PipelineStage;
  extracted: ExtractedField[];
  linkedEntityIds: EntityId[];
  /** 0–1 confidence of the strongest link */
  linkConfidence: number;
  issues: DocumentIssue[];
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
}

export interface AskOptions {
  includeUnverified?: boolean;
  /** Injected clock so "expiring in 90 days" is testable */
  now?: Date;
}

/** The seam. Mock today; Claude-backed tomorrow; same UI either way. */
export interface AnswerProvider {
  ask(question: string, opts?: AskOptions): Promise<Answer>;
}
