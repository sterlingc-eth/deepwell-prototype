// npm run verify:inbox-counts
// Inbox filters, row reasons and Data health counts: one source per tile (checked <= total), verified documents are not
// problems, "Hard to read", "Choose a document type", "Might be a copy", hidden empty chips, Ready lists only substantive docs.
import { readFileSync, existsSync } from 'node:fs';
import * as React from 'react';
(globalThis as unknown as { React: typeof React }).React = React;
import { copyStem, findPossibleCopies, gapDocs, needsTypeChoice, recomputeIssues, unlinkedDocs, withPossibleCopies, type GraphSnapshot } from '../src/core/entityGraph';
import { healthTiles } from '../src/core/healthTiles';
import { hvacSchema } from '../src/domains/hvac/schema';
import { docsMatchingFilter, isAttention } from '../src/screens/ReviewScreen';
import { needInfo, sectionsFor } from '../src/screens/reviewGrouping';
import type { Doc, DocumentId } from '../src/core/types';

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`); }
}
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
console.log('verify:inbox-counts');

const field = (name: string, value: string, confidence = 0.9) => ({ name, value, confidence, location: {} });
const doc = (id: string, o: Partial<Doc> = {}): Doc => recomputeIssues({
  id, filename: `${id}.pdf`, fileType: 'pdf', pages: 1, batchId: 'b1', source: 'drive', receivedAt: new Date('2026-01-01'),
  typeId: null, stage: 'linked', extracted: [], linkedEntityIds: ['c1'], linkConfidence: 1, issues: [], preview: 'text', ...o,
} as Doc, hvacSchema);
const graphOf = (docs: Doc[], serverCounts?: GraphSnapshot['serverCounts']): GraphSnapshot => ({
  schema: hvacSchema, entities: {}, batches: {}, docs: withPossibleCopies(Object.fromEntries(docs.map((d) => [d.id, d]))), conflicts: {}, lastError: null, serverCounts,
});
const ids = (g: GraphSnapshot, f: Parameters<typeof docsMatchingFilter>[1]) => docsMatchingFilter(g, f).map((d) => d.id).sort();

// ---- 1. health tiles: one source, checked <= total ----
{
  // The live bug: the graph held 724 documents but the server said 661. Everything must come from the server's 661.
  const many = Array.from({ length: 724 }, (_, i) => doc(`v${i}`, { typeId: 'invoice', stage: i < 700 ? 'verified' : 'linked', verifiedBy: i < 300 ? 'ai' : 'user', extracted: [field('cost', '10')] }));
  const g = graphOf(many);
  const t = healthTiles(g, { total: 661, byStage: { received: 0, read: 10, mapped: 5, linked: 5, verified: 641 }, verified: 641, needsReview: 20, aiVerified: 300 });
  check('checked never exceeds total (graph larger than the server count)', t.checked <= t.total && t.checkedPct <= 100, JSON.stringify([t.total, t.checked, t.checkedPct]));
  eq('total, checked and AI count come from the server', [t.total, t.checked, t.aiVerified], [661, 641, 300]);
  eq('stage bar comes from the server and sums to the total', Object.values(t.stages).reduce((a, b) => a + b, 0), 661);
  const bad = healthTiles(g, { total: 100, byStage: { received: 0, read: 0, mapped: 0, linked: 0, verified: 400 }, verified: 400, needsReview: 0, aiVerified: 900 });
  check('a server answer with checked > total is clamped', bad.checked <= bad.total && bad.aiVerified <= bad.checked && bad.checkedPct <= 100);
  const none = healthTiles(g, null);
  check('with no server answer the tiles count the graph and still obey checked <= total', none.checked <= none.total && none.total === 724);
  const sc = healthTiles({ ...g, serverCounts: { documents: 800, verified: 750, needsReview: 50, byStage: { received: 0, read: 20, mapped: 10, linked: 20, verified: 750 }, needsReviewNotLoaded: 30 } }, null);
  eq('the sync-stored server counts stand in when the fresh summary has not arrived', [sc.total, sc.checked], [800, 750]);
}
{
  // Unverified tiles: graph only, verified excluded, "N+" when the graph did not load every unverified document.
  const docs = [
    doc('gap1', { typeId: 'invoice', stage: 'classified', extracted: [field('cost', '9')] }),
    doc('gap-v', { typeId: 'invoice', stage: 'verified', extracted: [field('cost', '9')] }),
    doc('unl1', { typeId: 'work-order', stage: 'extracted', linkedEntityIds: [], extracted: [field('service_date', '2026-01-02'), field('service_address', '1 Main'), field('work_performed', 'x')] }),
    doc('unl-v', { typeId: 'work-order', stage: 'verified', linkedEntityIds: [], extracted: [field('service_date', '2026-01-02'), field('service_address', '1 Main'), field('work_performed', 'x')] }),
  ];
  const g = graphOf(docs);
  check('gapDocs ignores verified documents', gapDocs(g).every((d) => d.stage !== 'verified') && gapDocs(g).some((d) => d.id === 'gap1'));
  check('unlinkedDocs ignores verified documents', unlinkedDocs(g).every((d) => d.stage !== 'verified') && unlinkedDocs(g).some((d) => d.id === 'unl1'));
  const full = healthTiles(g, { total: 4, byStage: { received: 0, read: 0, mapped: 2, linked: 0, verified: 2 }, verified: 2, needsReview: 2 });
  eq('complete graph: plain numbers', [full.gaps.text, full.unlinked.text, full.partial], ['1', '1', false]);
  const part = healthTiles(g, { total: 50, byStage: { received: 0, read: 0, mapped: 40, linked: 0, verified: 10 }, verified: 10, needsReview: 40 });
  eq('graph missing unverified documents: "N+"', [part.gaps.text, part.unlinked.text, part.partial], ['1+', '1+', true]);
  eq('a zero stays "0" even when partial', [part.conflicts.text, part.duplicates.text], ['0', '0']);
}

// ---- 2. nothing read: "Hard to read" ----
{
  const bookkeepingOnly = doc('bk', { typeId: 'price-list', extracted: [field('_audience_notified', 'yes')] });
  const real = doc('real', { typeId: 'price-list', extracted: [field('vendor', 'Beacon')] });
  const marked = doc('marked', { typeId: 'price-list', extracted: [field('vendor', 'Beacon'), field('_nothing_read', '1')] });
  const inv = doc('inv0', { typeId: 'invoice', extracted: [] });
  const g = graphOf([bookkeepingOnly, real, marked, inv]);
  check('underscore rows do not count as facts', bookkeepingOnly.issues.some((i) => i.kind === 'nothing-read'));
  check('a document with real facts is not "nothing read"', !real.issues.some((i) => i.kind === 'nothing-read'));
  check('the marker alone marks a document nothing read', marked.issues.some((i) => i.kind === 'nothing-read'));
  check('nothing-read documents leave Ready to verify', !ids(g, 'ready').includes('bk') && !ids(g, 'ready').includes('marked') && ids(g, 'ready').includes('real'));
  check('nothing-read documents need a person', isAttention(bookkeepingOnly) && isAttention(inv));
  eq('row reason is the approved label', needInfo(inv, ['cost']).text, 'Hard to read');
  eq('they share one group', sectionsFor([bookkeepingOnly, inv].map((d) => ({ doc: d, need: needInfo(d, []), typeLabel: 'x' })), 'attention').map((s) => [s.label, s.items.length]), [['Hard to read', 2]]);
}

// ---- 3. "Other" with no facts asks for a type ----
{
  const other0 = doc('o0', { typeId: 'other', stage: 'extracted', linkedEntityIds: [], extracted: [] });
  const other1 = doc('o1', { typeId: 'other', stage: 'extracted', linkedEntityIds: [], extracted: [field('customer_name', 'Acme')] });
  const g = graphOf([other0, other1]);
  check('Other with no facts needs a type choice', needsTypeChoice(other0) && !needsTypeChoice(other1));
  eq('its reason asks for a type (proposed wording)', needInfo(other0, []).text, 'Choose a document type');
  check('it is no longer listed under Needs linking', !ids(g, 'unlinked').includes('o0') && ids(g, 'unlinked').includes('o1'));
  check('it still needs a person', ids(g, 'attention').includes('o0'));
}

// ---- 4. "Might be a copy" ----
{
  eq('stem: (copy)', copyStem('Patel INV-96101 (copy).pdf'), { stem: 'patel inv-96101', marked: true });
  eq('stem: (2)', copyStem('Rhodes SI-62336 (2).pdf'), { stem: 'rhodes si-62336', marked: true });
  eq('stem: v2', copyStem('Estimate E-4118 Campos v2.pdf'), { stem: 'estimate e-4118 campos', marked: true });
  eq('stem: plain name is not marked', copyStem('Invoice 24332 - Perkins.pdf').marked, false);
  const patelA = doc('pa', { filename: 'Patel INV-96101.docx', typeId: 'invoice', extracted: [field('invoice_number', 'INV-96101'), field('cost', '286.54')] });
  const patelB = doc('pb', { filename: 'Patel INV-96101 (copy).pdf', typeId: 'invoice', extracted: [field('invoice_number', 'INV-96101'), field('cost', '286.54')] });
  const r1 = doc('r1', { filename: 'Receipt R-20120.pdf', typeId: 'invoice', extracted: [field('invoice_number', 'R-20120'), field('cost', '55.50')] });
  const r2 = doc('r2', { filename: 'Receipt R-20120 (copy).pdf', typeId: 'invoice', extracted: [field('invoice_number', 'R-20120'), field('cost', '55.50')] });
  const e1 = doc('e1', { filename: 'Estimate E-4118 Campos.pdf', typeId: 'proposal-quote', stage: 'linked', extracted: [field('invoice_number', 'E-4118'), field('cost', '393.25')] });
  const e2 = doc('e2', { filename: 'Estimate E-4118 Campos v2.pdf', typeId: 'proposal-quote', stage: 'linked', extracted: [field('invoice_number', 'E-4118'), field('cost', '459.49')] });
  const n1 = doc('n1', { filename: 'Rhodes SI-62336.pdf', typeId: 'invoice', extracted: [field('cost', '10')] });
  const n2 = doc('n2', { filename: 'Rhodes SI-62336 (2).pdf', typeId: 'invoice', extracted: [field('cost', '99')] });
  const vv = doc('vv', { filename: 'Gift (copy).pdf', typeId: 'invoice', stage: 'verified', extracted: [field('invoice_number', 'G1')] });
  const vo = doc('vo', { filename: 'Gift.pdf', typeId: 'invoice', extracted: [field('invoice_number', 'G1')] });
  const g = graphOf([patelA, patelB, r1, r2, e1, e2, n1, n2, vv, vo]);
  const copies = findPossibleCopies(Object.values(g.docs));
  eq('flagged copies', [...copies.keys()].sort(), ['pb', 'r2']);
  check('a v2 with a different cost is a revision, not a copy', !copies.has('e2'));
  check('a (2) with a different cost is not a copy', !copies.has('n2'));
  check('a verified document is never flagged', !copies.has('vv'));
  check('the original is not flagged', !copies.has('pa') && !copies.has('r1'));
  check('flagged copies appear under Duplicates', ids(g, 'duplicates').join() === 'pb,r2');
  eq('their row reason is "Might be a copy"', needInfo(g.docs['pb']!, []).text, 'Might be a copy');
  check('a flagged copy is not in Ready to verify', !ids(g, 'ready').includes('pb'));
  check('withPossibleCopies is stable (same object when nothing changes)', withPossibleCopies(g.docs) === g.docs);
}

// ---- 5. Ready lists only substantive documents; no verify-all ----
{
  const inboxSrc = readFileSync(new URL('../src/screens/InboxScreen.tsx', import.meta.url), 'utf8');
  const reviewSrc = readFileSync(new URL('../src/screens/ReviewScreen.tsx', import.meta.url), 'utf8');
  check('the Ready filter requires something to have been read', /case 'ready':[^\n]*!isNothingRead\(doc\)/.test(reviewSrc));
  check('there is no verify-all button in the Needs you list', !/verify all|approve all|verifyAll|approveAll/i.test(reviewSrc + inboxSrc));
  check('Conflicts and Duplicates chips are hidden at zero', /f\.id !== 'conflicts'/.test(inboxSrc) && /f\.id !== 'duplicates'/.test(inboxSrc));
  check('customer duplicates page through every customer, not the first 200', !/listFull\(\{ sort: 'recent', limit: 200 \}\)/.test(reviewSrc) && /listPage\(\{ sort: 'recent', limit: CUSTOMER_PAGE_SIZE, cursor \}\)/.test(reviewSrc));
  const eg = readFileSync(new URL('../src/core/entityGraph.ts', import.meta.url), 'utf8');
  check('isCompanyFileDoc uses isCompanyFile from companyFiles.ts', /from '\.\/companyFiles'/.test(eg) && /return isCompanyFile\(/.test(eg) && !/TODO\(merge\): swap/.test(eg));
  const store = readFileSync(new URL('../api/_lib/recordsStore.js', import.meta.url), 'utf8');
  check('reviewSummary returns aiVerified', /ai_verified/.test(store) && /aiVerified: Math\.min/.test(store));
}

// ---- 6. the real export, when it is there ----
const EXPORT = '/home/claude/work/inbox/export.json';
if (existsSync(EXPORT)) {
  const d = JSON.parse(readFileSync(EXPORT, 'utf8')) as { documents: { id: string; original_filename: string; stage: string }[] };
  const names = d.documents.filter((x) => x.stage !== 'verified').map((x) => x.original_filename);
  check('export: Patel INV-96101 (copy) is in the data', names.includes('Patel INV-96101 (copy).pdf'));
}
void (null as unknown as DocumentId);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
