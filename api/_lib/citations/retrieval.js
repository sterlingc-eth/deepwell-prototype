/**
 * Citations for the retrieval + model path (answer.js's shapeAnswer output). The cited pages are
 * already in `sources`; this labels them with the filenames retrieval returned and states, in one
 * sentence, what the answer was selected from. A no-answer cites what was searched instead.
 * Pure: takes the mapped passages/extractions api/ask.js already holds.
 */
import { documentTypeLabel } from '../documentTypes.js';
import { documentRecord, attachCitations } from './records.js';

/**
 * @param data        shapeAnswer's output (mutated + returned)
 * @param evidence    {passages: [{documentId, filename, documentType, page}], extractions: [{documentId, filename, field}]}
 */
export function attachRetrievalCitations(data, { passages = [], extractions = [] } = {}) {
  const meta = new Map();
  for (const p of passages) if (!meta.has(p.documentId)) meta.set(p.documentId, { filename: p.filename, type: p.documentType });
  for (const x of extractions) if (!meta.has(x.documentId)) meta.set(x.documentId, { filename: x.filename, type: null });
  const label = (id) => {
    const m = meta.get(id);
    return `${m?.type ? `${documentTypeLabel(m.type)} · ` : ''}${m?.filename ?? 'Document'}`;
  };
  const nDocs = meta.size;
  const scope = `the ${passages.length} page${passages.length === 1 ? '' : 's'} and ${extractions.length} extracted field${extractions.length === 1 ? '' : 's'} the search returned across ${nDocs} document${nDocs === 1 ? '' : 's'}`;

  if (data?.kind === 'no-answer') {
    const searched = [...meta.keys()].map((id) => documentRecord({ id, document_type: meta.get(id).type }, { label: label(id) }));
    return attachCitations(data, {
      records: searched, total: searched.length, kind: 'searched',
      basis: nDocs ? `Searched ${scope}; none of them answers the question.` : 'Searched your documents; nothing matched the question.',
    });
  }

  const refs = [...(data?.sources ?? []), ...(data?.facts ?? []).flatMap((f) => f.sources ?? [])];
  const records = [];
  for (const s of refs) {
    const page = Number(s?.location?.page);
    records.push(documentRecord({ id: s.documentId, document_type: meta.get(s.documentId)?.type }, {
      label: label(s.documentId), page: Number.isFinite(page) && page > 0 ? page : undefined,
      sublabel: s?.location?.field && s.location.field !== 'document' ? String(s.location.field).replace(/_/g, ' ') : undefined,
    }));
  }
  const cited = new Set(records.map((r) => `${r.id}:${r.page ?? ''}`)).size;
  const citedDocs = new Set(records.map((r) => r.documentId)).size;
  return attachCitations(data, {
    records, total: cited,
    basis: `Answered from ${cited} cited page${cited === 1 ? '' : 's'} in ${citedDocs} document${citedDocs === 1 ? '' : 's'}, selected from ${scope}.`,
  });
}
