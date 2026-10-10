// npm run verify:company-files-ui
// Company files in the UI: pipeline labels, no "Advance to Matched", Needs you membership, chip label, counts.
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import * as React from 'react';
import { createElement } from 'react';
(globalThis as unknown as { React: typeof React }).React = React;
import { StagePill, stageLabel } from '../src/components/StagePill';
import { companyFileReasons, gapDocs, isCompanyFileDoc, maxStageFor, recomputeIssues, unlinkedDocs, type GraphSnapshot } from '../src/core/entityGraph';
import { hvacSchema } from '../src/domains/hvac/schema';
import { FILTERS } from '../src/screens/reviewFilters';
import { docsMatchingFilter, isAttention } from '../src/screens/ReviewScreen';
import { needInfo } from '../src/screens/reviewGrouping';
import type { Doc, PipelineStage } from '../src/core/types';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`); }
}
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
console.log('verify:company-files-ui');

const field = (name: string, value: string) => ({ name, value, confidence: 0.9, location: {} });
const doc = (id: string, o: Partial<Doc> = {}): Doc => recomputeIssues({
  id, filename: `${id}.pdf`, fileType: 'pdf', pages: 1, batchId: 'b1', source: 'drive', receivedAt: new Date('2026-01-01'),
  typeId: null, stage: 'extracted', extracted: [], linkedEntityIds: [], linkConfidence: 0, issues: [], preview: 'text', ...o,
} as Doc, hvacSchema);

const PRICE = doc('price', { typeId: 'price-list', extracted: [field('vendor', 'Beacon')] });
const PO_NO_VENDOR = doc('po-gap', { typeId: 'purchase-order', extracted: [field('cost', '90')] });
const RECEIPT_NO_TOTAL = doc('rcpt-nototal', { typeId: 'purchase-order', extracted: [field('vendor', 'Desert Supply')] });
const STATEMENT_BLANK = doc('blank', { typeId: 'statement', extracted: [], preview: '' });
const COPY = doc('copy', { typeId: 'price-list', extracted: [field('vendor', 'Beacon')], issues: [{ kind: 'duplicate', of: 'price' }] });
const WORK_ORDER = doc('wo', { typeId: 'work-order', extracted: [field('service_date', '2026-09-01')] });
const CLEAN_DONE = doc('done', { typeId: 'schedule', stage: 'verified' });

// 1. stage display
eq('Matched reads "Not needed" for a company file', stageLabel('linked', true), 'Not needed');
eq('Matched still reads "Matched" for a customer file', stageLabel('linked', false), 'Matched');
eq('other stages unchanged for company files', (['received', 'classified', 'extracted', 'verified'] as PipelineStage[]).map((s) => stageLabel(s, true)), ['Uploaded', 'Sorted', 'Read', 'Checked']);
check('StagePill renders "Not needed" for a company file at the skipped step', renderToStaticMarkup(createElement(StagePill, { stage: 'linked', companyFile: true })).includes('Not needed'));
check('StagePill renders "Matched" for a customer file', renderToStaticMarkup(createElement(StagePill, { stage: 'linked' })).includes('Matched'));

// 2. never "Advance to Matched" for a company file
const nexts = new Set<string>();
for (const d of [PRICE, PO_NO_VENDOR, RECEIPT_NO_TOTAL, CLEAN_DONE]) {
  check(`${d.id} is a company file`, isCompanyFileDoc(d, hvacSchema));
  nexts.add(stageLabel(maxStageFor(d, hvacSchema), true));
}
check('no company file ever has "Matched" as its next step label', ![...nexts].includes('Matched'));
const review = readFileSync(new URL('../src/screens/ReviewScreen.tsx', import.meta.url), 'utf8');
check('Review footer labels the button with stageLabel(next, companyFile), never the raw STAGE_LABEL', review.includes('`Advance to ${stageLabel(next, companyFile)}`') && !review.includes('STAGE_LABEL['));
check('Review blocks advancing a company file to the skipped step', review.includes("!(companyFile && next === 'linked')"));
check('a customer file is not a company file', !isCompanyFileDoc(WORK_ORDER, hvacSchema));

// 3. Needs you membership
eq('reasons: price list with a vendor needs nothing', companyFileReasons(PRICE, hvacSchema), []);
eq('reasons: purchase order missing a vendor is still fine', companyFileReasons(PO_NO_VENDOR, hvacSchema), []);
eq('reasons: purchase order without a total', companyFileReasons(RECEIPT_NO_TOTAL, hvacSchema), ['no-total']);
eq('reasons: blank statement', companyFileReasons(STATEMENT_BLANK, hvacSchema), ['hard-to-read', 'no-total']);
eq('reasons: possible copy', companyFileReasons(COPY, hvacSchema), ['copy']);
const lowConf = doc('lowconf', { typeId: 'insurance-certificate', extracted: [field('vendor', 'Acme Ins')], completeness: { type: 'insurance-certificate', required: [], present: ['vendor'], missing: [], minConfidence: 0.3, complete: true } });
eq('reasons: low-confidence type', companyFileReasons(lowConf, hvacSchema), ['unsure-folder']);

const docs = [PRICE, PO_NO_VENDOR, RECEIPT_NO_TOTAL, STATEMENT_BLANK, COPY, lowConf, WORK_ORDER, CLEAN_DONE];
const g: GraphSnapshot = { schema: hvacSchema, entities: {}, batches: {}, docs: Object.fromEntries(docs.map((d) => [d.id, d])), conflicts: {}, lastError: null };
const ids = (f: Parameters<typeof docsMatchingFilter>[1]) => docsMatchingFilter(g, f).map((d) => d.id).sort();
eq('Company files chip lists only company files that need a look', ids('shop-records'), ['blank', 'copy', 'lowconf', 'rcpt-nototal']);
check('clean company files are not in Needs a person', !ids('attention').includes('price') && !ids('attention').includes('po-gap') && !ids('attention').includes('done'));
check('company files with a real issue ARE in Needs a person', ['blank', 'copy', 'lowconf', 'rcpt-nototal'].every((i) => ids('attention').includes(i)));
check('a clean company file is not in Missing info or Needs linking', ![...ids('gaps'), ...ids('unlinked')].some((i) => ['price', 'po-gap', 'done'].includes(i)));
check('a company file with no total still shows in Missing info (a real issue)', ids('gaps').includes('rcpt-nototal'));
check('customer paper keeps its Missing info row', ids('gaps').includes('wo') || WORK_ORDER.issues.some((i) => i.kind === 'missing-field') === ids('gaps').includes('wo'));
eq('Dashboard tiles read the same helpers (unlinked)', unlinkedDocs(g).map((d) => d.id).sort(), ids('unlinked'));
eq('Dashboard tiles read the same helpers (gaps)', gapDocs(g).map((d) => d.id).sort(), ids('gaps'));
check('isAttention is false for a clean company file', !isAttention(PRICE));

// 4. chip label and row reasons
eq('chip label', FILTERS.find((f) => f.id === 'shop-records')?.label, 'Company files');
check('no "Company records" chip remains', !FILTERS.some((f) => f.label === 'Company records'));
eq('row reason: no total', needInfo(RECEIPT_NO_TOTAL, ['vendor|customer_name', 'cost']).text, 'No total found');
eq('row reason: hard to read + no total', needInfo(STATEMENT_BLANK, []).text, 'Hard to read, No total found');
eq('row reason: copy', needInfo(COPY, []).text, 'Might be a copy');
eq('row reason: unsure folder', needInfo(lowConf, []).text, 'Not sure this is the right folder');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
