/**
 * The ingestion pipeline runner. Orchestrates the pure step functions in
 * this directory, in order, and applies each step's output through
 * `useGraph`'s actions (src/core/entityGraph.ts), which write through to
 * the RecordsStore themselves — see docs/INGEST_API.md, "Pipeline".
 *
 * `read` and `map` have bespoke graph actions (`ingestRead`/`ingestMap`)
 * because their output needs the shared present-fields/stage logic in
 * entityGraph.ts. Every other step returns a plain `Partial<Doc>` patch
 * (plus any new facets/proposals it minted), applied through the generic
 * `applyPipelinePatch` action. This keeps every step a pure, testable
 * function and keeps the runner the only thing that mutates.
 */
import type { Conflict, Doc, DocumentId, Entity, Facet, Proposal, BatchId, IntakeSource } from '../types';
import type { GraphSnapshot } from '../entityGraph';
import { useGraph } from '../entityGraph';
import type { RecordsStore } from '../recordsStore';
import type { DomainAdapter } from '../../domains/hvac/adapter';
import { receive, type ReceivedFile } from './receive';
import { read } from './read';
import { map } from './map';
import { propose } from './propose';
import { resolve } from './resolve';
import { dedupe } from './dedupe';
import { conflicts as conflictsStep } from './conflicts';
import { autoVerify } from './autoverify';
import { index as indexStep } from './index';

let idCounter = 1;
/** Same shape as entityGraph.ts's private id generator — duplicated intentionally, these are separate modules by design (see docs/INGEST_API.md file ownership). */
export const newId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

export interface PipelineContext {
  adapter: DomainAdapter;
  store: RecordsStore;
  /** Current registry version — bumped by proposal confirmations (see entityGraph.ts's `confirmProposal`). */
  schemaVersion: number;
  now: Date;
  /** A fresh snapshot of the graph, re-read by the runner before every step. */
  graph: GraphSnapshot;
}

/** The shape every pipeline step but `read`/`map` returns — see docs/INGEST_API.md, "Pipeline". */
export type StepPatch = Partial<Doc> & {
  newFacets?: Facet[];
  newProposals?: Proposal[];
  /** propose.ts only: proposals that met an auto-promote threshold (synonym @2 occurrences, field @≥3 docs/≥2 batches) and should be confirmed by the system, not left pending for Review. */
  autoPromote?: Proposal[];
  /** resolve.ts only: provisional entities created because no existing entity matched but enough key fields were present to stand up a new one. */
  newEntities?: Entity[];
  /** conflicts.ts only: hard conflicts newly detected on this doc's linked entities. */
  newConflicts?: Conflict[];
};

async function makeContext(adapter: DomainAdapter, store: RecordsStore): Promise<PipelineContext> {
  const versions = await store.all<{ version: number }>('schemaVersions');
  const schemaVersion = versions.reduce((max, r) => Math.max(max, r.version), 0);
  return { adapter, store, now: new Date(), schemaVersion, graph: useGraph.getState() };
}

/** Applies a generic step patch through the graph's write-through actions, then returns the doc as the graph now has it. */
function applyStepPatch(docId: DocumentId, patch: StepPatch): Doc {
  const { newFacets, newProposals, autoPromote, newEntities, newConflicts, ...rest } = patch;
  if (newEntities?.length) useGraph.getState().registerEntities(newEntities);
  if (newFacets?.length) useGraph.getState().registerFacets(newFacets);
  if (newProposals?.length) useGraph.getState().registerProposals(newProposals);
  if (newConflicts?.length) useGraph.getState().registerConflicts(newConflicts);
  for (const p of autoPromote ?? []) useGraph.getState().autoPromoteProposal(p);
  useGraph.getState().applyPipelinePatch(docId, rest);
  const doc = useGraph.getState().docs[docId];
  if (!doc) throw new Error(`pipeline: doc ${docId} vanished mid-run`);
  return doc;
}

export interface IngestInput {
  documentId: DocumentId;
  filename: string;
  fileType: Doc['fileType'];
  bytes: ArrayBuffer;
  batchId: BatchId;
  source: IntakeSource;
}

function newDoc(input: IngestInput, now: Date): Doc {
  return {
    id: input.documentId,
    filename: input.filename,
    fileType: input.fileType,
    pages: 1,
    batchId: input.batchId,
    source: input.source,
    receivedAt: now,
    typeId: null,
    stage: 'received',
    extracted: [],
    linkedEntityIds: [],
    linkConfidence: 0,
    issues: [],
    preview: `${input.filename}\n\nReceived. Not yet read.`,
    facets: [],
    aspects: [],
  };
}

/**
 * Runs receive → read → map → propose → resolve → dedupe → conflicts →
 * autoVerify → index for one uploaded file. Stops early after `receive`
 * when the file is an exact duplicate — no further model calls or store
 * writes beyond flagging the dup.
 */
export async function runIngestPipeline(input: IngestInput, adapter: DomainAdapter, store: RecordsStore): Promise<Doc> {
  let doc = newDoc(input, new Date());
  useGraph.setState((s) => ({ docs: { ...s.docs, [doc.id]: doc } }));
  void store.put('docs', doc);

  const receiveFile: ReceivedFile = { documentId: doc.id, filename: input.filename, fileType: input.fileType, bytes: input.bytes };

  let ctx = await makeContext(adapter, store);
  doc = applyStepPatch(doc.id, await receive(doc, receiveFile, ctx));
  if (doc.issues.some((i) => i.kind === 'duplicate')) return doc;

  ctx = await makeContext(adapter, store);
  const readResult = await read(doc, ctx);
  useGraph.getState().ingestRead(doc.id, readResult.facets, readResult.segments);
  doc = useGraph.getState().docs[doc.id] ?? doc;

  ctx = await makeContext(adapter, store);
  const mapResult = await map(doc, ctx);
  useGraph.getState().ingestMap(doc.id, mapResult);
  doc = useGraph.getState().docs[doc.id] ?? doc;

  ctx = await makeContext(adapter, store);
  doc = applyStepPatch(doc.id, await propose(doc, ctx));

  ctx = await makeContext(adapter, store);
  doc = applyStepPatch(doc.id, await resolve(doc, ctx));

  ctx = await makeContext(adapter, store);
  doc = applyStepPatch(doc.id, await dedupe(doc, ctx));

  ctx = await makeContext(adapter, store);
  doc = applyStepPatch(doc.id, await conflictsStep(doc, ctx));

  ctx = await makeContext(adapter, store);
  doc = applyStepPatch(doc.id, await autoVerify(doc, ctx));

  ctx = await makeContext(adapter, store);
  doc = applyStepPatch(doc.id, await indexStep(doc, ctx));

  return doc;
}
