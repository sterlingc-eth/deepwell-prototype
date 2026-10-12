/**
 * verify:reader-r18 - the extractive reader (api/_lib/search/extractive.js + dql/families/reader.js): quotes what a paper SAYS, with file, date and page.
 * Pure checks (no database): span splitting, topic words, BM25 + the confidence rule (coverage, margin, grounded), and the family end to end over a small
 * snapshot with page text attached (parse -> candidate papers -> quote). Also: private papers are never read, the kill switch, 12 api files.
 *   node scripts/verify-reader-r18.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0; let passes = 0;
const check = (name, ok, detail = '') => { if (ok) passes++; else fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${String(detail).slice(0, 400)}`}`); };
delete process.env.ANTHROPIC_API_KEY; delete process.env.DONOVAN_READER;
const { splitUnits, topicOf, readPages, grounded, stem } = await import('../api/_lib/search/extractive.js');
const { buildSnapshot } = await import('../api/_lib/dql/snapshot.js');
const { answerFromSnapshot } = await import('../api/_lib/dql/index.js');
const { _analyze, readerCandidates, readerShaped } = await import('../api/_lib/dql/families/reader.js');

// ---- units
const PAGE = '1. Termination. Either party may terminate this agreement by giving 30 days written notice.\nPayment Terms: Net 45.\nSigned by: Ann Lee (client) and Bo Ray for Acme on 01/02/2020.';
const us = splitUnits(PAGE);
check('units: one per line, verbatim', us.length === 3 && us.every((u) => PAGE.includes(u.text)));
check('units: labelled line keeps its label', us[1].heading === 'Payment Terms');
check('stems join forms', stem('termination') === stem('terminate') && stem('fees') === stem('fee') && stem('renewal') === stem('renews'));
check('topic: slot words removed', topicOf('what does the agreement say about termination', ['agreement']).concepts.length === 1);
check('topic: synonyms', topicOf('cancellation', []).concepts[0].stems.includes(stem('terminate')));

// ---- confidence rule
const pg = (text, page = 1, docId = 'd1') => ({ docId, filename: 'f.pdf', page, text });
let r = readPages(topicOf('termination', []).concepts, [pg(PAGE)]);
check('reads the termination clause', r.ok && /^1\. Termination\./.test(r.best.text), JSON.stringify(r.why));
r = readPages(topicOf('late fees', []).concepts, [pg(PAGE)]);
check('releases a topic the paper does not state', !r.ok);
r = readPages(topicOf('late fees', []).concepts, [pg('Late Fees. A late fee of 5 percent applies after 30 days.\nLate Fees. A late fee of 9 percent applies after 10 days.')]);
check('releases when two different spans tie (no margin)', !r.ok && /runner-up/.test(r.why), r.why);
r = readPages(topicOf('governing law', []).concepts, [pg('Sagebrush Law Office\nTERMS')]);
check('releases when the top span misses a topic word (governing)', !r.ok);
check('grounded: a span not on the page fails', !grounded({ text: 'Net 99.', pageText: PAGE }));
check('grounded: a number not on the page fails', !grounded({ text: 'Payment Terms: Net 99.', pageText: 'Payment Terms: Net 45.' }));

// ---- the family over a tiny snapshot
const raw = {
  documents: [
    { id: 'a1', original_filename: 'lease-ann.pdf', document_type: 'lease-agreement', created_at: '2020-01-02T12:00:00Z' },
    { id: 'a2', original_filename: 'hr-ann.pdf', document_type: 'hr-letter', created_at: '2020-01-03T12:00:00Z' },
    { id: 'a3', original_filename: 'lease-bob-1.pdf', document_type: 'lease-agreement', created_at: '2019-01-02T12:00:00Z' },
    { id: 'a4', original_filename: 'lease-bob-2.pdf', document_type: 'lease-agreement', created_at: '2021-01-02T12:00:00Z' },
  ],
  extractions: [], links: [
    { document_id: 'a1', entity_id: 'c1' }, { document_id: 'a2', entity_id: 'c1' }, { document_id: 'a3', entity_id: 'c2' }, { document_id: 'a4', entity_id: 'c2' },
  ],
  entities: [{ id: 'c1', entity_type: 'customer', data: { customer_name: 'Ann Lee' } }, { id: 'c2', entity_type: 'customer', data: { customer_name: 'Bob Day' } }],
  financials: [], lines: [],
};
const snap = buildSnapshot(raw, { today: '2026-10-07' });
snap.pageText = new Map([
  ['a1', [{ page: 1, text: 'Lease\nTerm: 12 months' }, { page: 2, text: PAGE }]],
  ['a2', [{ page: 1, text: '1. Termination. Immediate dismissal.' }]],
  ['a3', [{ page: 1, text: '1. Termination. Either party may terminate by giving 30 days written notice.' }]],
  ['a4', [{ page: 1, text: '1. Termination. Either party may terminate by giving 60 days written notice.' }]],
]);
const plan = { v: 1, op: 'read_span', entity: 'document', docType: 'lease-agreement', docWord: 'lease', visit: false, filters: [{ field: 'customer', op: 'eq', value: 'Ann Lee', role: 'customer' }], time: null, measure: null, groupBy: [], limit: null, dir: 'desc', mode: 'quote', code: null, latest: false, concepts: topicOf('termination', []).concepts, topic: 'termination' };
let out = answerFromSnapshot(snap, plan, '2026-10-07');
check('family quotes the clause with file, date and page', out && /lease-ann\.pdf, Jan 2, 2020, page 2\)/.test(out.text) && out.text.includes('“1. Termination. Either party may terminate this agreement by giving 30 days written notice.”'), out?.text);
check('the quote is verbatim on the page', out && PAGE.includes(/“(.+)”/.exec(out.text)[1]));
out = answerFromSnapshot(snap, { ...plan, filters: [{ ...plan.filters[0], value: 'Bob Day' }] }, '2026-10-07');
check('two papers that differ: released (no guess)', out === null);
out = answerFromSnapshot(snap, { ...plan, filters: [{ ...plan.filters[0], value: 'Bob Day' }], latest: true }, '2026-10-07');
check('"latest" picks the newest paper', out && /lease-bob-2\.pdf/.test(out.text) && /60 days/.test(out.text), out?.text);
const c = readerCandidates({ ...plan, docType: null, filters: [plan.filters[0]] }, snap, '2026-10-07');
check('private papers (HR letters) are never candidates', c.docs && !c.docs.some((d) => d.id === 'a2'));
process.env.DONOVAN_READER = '0';
check('kill switch DONOVAN_READER=0 releases', answerFromSnapshot(snap, plan, '2026-10-07') === null && _analyze({ raw: 'what does the lease for Ann Lee say about termination', filters: [{ role: 'customer', value: 'Ann Lee' }], docTypes: ['lease-agreement'] }) === null && !readerShaped('what does the lease say'));
delete process.env.DONOVAN_READER;
const feat = { raw: 'what does the lease for Ann Lee say about termination', filters: [{ field: 'customer', role: 'customer', value: 'Ann Lee' }], docTypes: ['lease-agreement'], docWord: 'lease', times: [] };
check('analyze: a say-about question becomes a read_span plan', _analyze(feat)?.op === 'read_span' && _analyze(feat).mode === 'quote');
check('analyze: a count question is not read', _analyze({ ...feat, raw: 'how many leases does Ann Lee have' }) === null);
check('analyze: no customer or code = not read', _analyze({ ...feat, filters: [] }) === null);
check('analyze: who signed', _analyze({ ...feat, raw: 'who signed the lease for Ann Lee' })?.mode === 'who');
check('analyze: a structured field question is left alone', _analyze({ ...feat, raw: 'what is the total on invoice INV-1234', docTypes: ['invoice'], filters: [] }) === null);

// ---- wiring
const top = fs.readdirSync(path.join(ROOT, 'api')).filter((f) => fs.statSync(path.join(ROOT, 'api', f)).isFile());
check('api/ keeps 12 top-level files', top.length === 12, String(top.length));
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
