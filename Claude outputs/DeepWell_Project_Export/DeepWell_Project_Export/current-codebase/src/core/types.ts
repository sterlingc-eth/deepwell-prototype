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

export type RegistryTier = 0 | 1 | 2 | 3; // 0 core (shipped) · 1 discovered (auto-promoted) · 2 confirmed (human) · 3 shared (cross-tenant, unused at prototype scale)

/** Extends FieldSpec conceptually — the registry-governance properties every field carries once the open schema (v2) is in play. */
export interface FieldSpecRegistryMeta {
  tier: RegistryTier;
  synonyms: string[];
  observationCount: number;
  addedInSchemaVersion: number;
}

/**
 * How costly it is when this field is wrong — not how confident the model
 * was, but what happens to the customer if the value is trusted and it's
 * mistaken. Drives the consequence-tiered auto-verification gate in
 * `src/core/pipeline/autoverify.ts` (see claude/INGESTION_STRATEGY_AT_SCALE.md,
 * layer 1): 'high' never auto-verifies (a human must look at least once per
 * entity+field, ever); 'medium' auto-verifies only once ≥2 independent
 * documents agree on the same normalized value, or a human already has;
 * 'low' (or unset) behaves as before — auto, always labeled unverified until
 * something else verifies the document. Unset defaults to 'medium', the
 * conservative choice, so a field nobody has classified yet is never treated
 * as consequence-free by accident.
 */
export type FieldConsequence = 'high' | 'medium' | 'low';

export interface FieldSpec extends Partial<FieldSpecRegistryMeta> {
  /** Key on Entity.fields */
  key: string;
  label: string;
  kind: FieldKind;
  /** For kind 'ref': which entity type the value points at */
  refType?: string;
  /** See `FieldConsequence`. Defaults to 'medium' when unset. */
  consequence?: FieldConsequence;
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
// Open schema (v2): universal reading pass, mapping pass, registry, proposals
// See claude/STORAGE_AND_RETRIEVAL_MODEL.md for the design this implements.
// ---------------------------------------------------------------------------

/** x/y/w/h are fractions 0–1 of the page image. */
export interface Bbox {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ValueTypeGuess = 'text' | 'date' | 'money' | 'serial' | 'number' | 'address' | 'name' | 'checkbox' | 'identifier';

export interface Segment {
  id: string;
  documentId: DocumentId;
  page: number;
  kind: 'header' | 'party-block' | 'line-item-table' | 'terms' | 'signature' | 'handwritten-note' | 'stamp' | 'photo-region' | 'other';
  bbox: Bbox;
}

/**
 * A label→value pair (or cell/checkbox/date/amount/identifier/name/address/note)
 * found by the universal reading pass, before any mapping. First-class,
 * citable, searchable regardless of whether it ever maps to a known field.
 */
export interface Facet {
  id: string;
  documentId: DocumentId;
  page: number;
  segmentId?: string;
  labelRaw: string;
  valueRaw: string;
  valueTypeGuess: ValueTypeGuess;
  bbox: Bbox;
  /** 0–1, the reading pass's confidence this is a real label/value pair */
  confidence: number;
  /** Entities on the same page/segment, populated at resolve time regardless of mapping status */
  linkedEntityIds: EntityId[];
  // Set once the mapping pass has run:
  mappedEntityType?: string;
  mappedFieldKey?: string;
  mappingConfidence?: number;
  mappingMethod?: 'registry' | 'synonym' | 'learned' | 'human';
  schemaVersionAtMapping?: number;
  /** Set when this facet is part of a pending proposal */
  proposalId?: string;
}

export type ProposalKind = 'document_type' | 'aspect' | 'field' | 'entity_type' | 'relation' | 'synonym' | 'enum_value';

export interface Proposal {
  id: string;
  kind: ProposalKind;
  /** The raw label being proposed as a field/type/synonym/etc. */
  label: string;
  /** For kind 'field' | 'relation' | 'entity_type' */
  targetEntityType?: string;
  /** For kind 'synonym' | 'enum_value' — the existing field this maps onto */
  targetFieldKey?: string;
  evidence: { facetIds: string[]; documentIds: DocumentId[]; count: number; valueTypeGuess?: ValueTypeGuess };
  status: 'pending' | 'confirmed' | 'rejected';
  createdAt: Date;
  resolvedAt?: Date;
  resolvedBy?: string;
}

export interface SchemaVersionRow {
  version: number;
  changeKind: 'field-added' | 'field-promoted' | 'synonym-added' | 'document-type-added' | 'aspect-added' | 'entity-type-added' | 'enum-value-added';
  description: string;
  createdAt: Date;
  /** Absent = auto-promoted */
  createdBy?: string;
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
}

export type DocumentIssue =
  | { kind: 'missing-field'; field: string }
  | { kind: 'unlinked'; bestGuess?: EntityId; confidence: number }
  | { kind: 'conflict'; conflictId: string }
  | { kind: 'duplicate'; of: DocumentId }
  | { kind: 'possible-duplicate'; of: DocumentId }
  /** Same entity + same unmapped facet label + different value across docs — softer than a hard conflict, non-blocking. */
  | { kind: 'inconsistent-facet'; labelRaw: string; facetIds: string[] }
  /**
   * Otherwise ready to verify (required fields present, linked, no
   * conflicts) but the consequence-tiered auto-verify gate (`autoverify.ts`)
   * won't advance it on its own: either a high-consequence field has never
   * had a human look at it for this entity, or a medium-consequence field's
   * value has no independent corroborating document yet. Non-blocking for
   * every earlier stage — the doc still answers as Unverified — but the
   * "Approve" button (a human looking at the whole document) always clears
   * it, by design.
   */
  | { kind: 'needs-verification'; field: string; reason: 'high-consequence' | 'uncorroborated' };

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
  verifiedBy?: string;
  verifiedAt?: Date;
  /** Short plain-text rendering used by the document preview */
  preview: string;
  /**
   * Every facet found on this document by the universal reading pass, mapped
   * or not. Optional (rather than required, as the contract in
   * docs/INGEST_API.md literally shows it) so M0/M1 documents constructed
   * before the open-schema pipeline existed — see src/domains/hvac/seed.ts,
   * outside this agent's file ownership — keep compiling unchanged; every
   * reader in this codebase treats a missing array as empty (`doc.facets ?? []`).
   */
  facets?: Facet[];
  /** Document type ids this doc matches; typeId remains the primary one for back-compat with existing UI. Same optionality rationale as `facets`. */
  aspects?: string[];
  /** sha256 hex of the original bytes, set by the receive pipeline step. Used for exact-duplicate detection. */
  contentHash?: string;
  /** Page image data URLs produced by the receive step, held in memory (base64) — the runtime equivalent of M1's `public/docs/*.json` sidecars. One entry per rendered page. */
  pageImages?: string[];
  /** Per-page fallback text for pages the receive step could not render visually (spreadsheet rows, a "no visual page" PDF) — fed straight to the map step, skipping the vision call. */
  pageText?: string[];
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
  /** Wall time the provider took, when it reports one */
  latencyMs?: number;
  /** Entity ids the provider retrieved before answering */
  retrievalIds?: EntityId[];
  /** Sentences the provider's validator removed from the prose */
  validatorStrikes?: number;
  /** True when the provider served the answer from its cache */
  cached?: boolean;
}

/** Progress stages a provider reports while answering. */
export type AskStage = 'reading' | 'linking' | 'writing';

export interface AskOptions {
  includeUnverified?: boolean;
  /** Injected clock so "expiring in 90 days" is testable */
  now?: Date;
  /** Progress callback — drives the thinking ticker from real events */
  onStatus?: (stage: AskStage, detail?: Record<string, number>) => void;
}

/** The seam. Mock today; Claude-backed tomorrow; same UI either way. */
export interface AnswerProvider {
  ask(question: string, opts?: AskOptions): Promise<Answer>;
}
