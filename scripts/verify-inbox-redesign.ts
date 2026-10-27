// npm run verify:inbox-redesign (pure half): the rules that decide which group a paper lands in and what may be offered as a
// one-click or bulk action. The browser half is scripts/verify-inbox-redesign-ui.mjs. No database, no model, no network.
import * as React from 'react';
(globalThis as unknown as { React: typeof React }).React = React;
import { recomputeIssues, useGraph } from '../src/core/entityGraph';
import { hvacSchema } from '../src/domains/hvac/schema';
import { needInfo } from '../src/screens/reviewGrouping';
import { todoCount } from '../src/screens/ReviewScreen';
import { requiredFieldsForDoc } from '../src/core/entityGraph';
import { bulkApproveIds, bulkLinkPairs, singleLinkPair, isBulkApprovable, openGroupKey, summaryCounts, triageRow, triageSections, type TriageRow } from '../src/components/inbox/inboxPlan';
import type { QueueRowData } from '../src/components/inbox/NeedsYouList';
import type { Doc, Entity, ExtractedField } from '../src/core/types';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`); } };
console.log('verify:inbox-redesign');

const f = (name: string, value: string, c = 0.95): ExtractedField => ({ name, value, confidence: c, location: { page: 1 } });
const ent = (id: string, name: string): Entity => ({ id, type: 'customer', fields: { name, customer_name: name } });
const entities = { c1: ent('c1', 'Maria Lopez'), c2: ent('c2', 'Priya Roberts') };
const doc = (id: string, o: Partial<Doc> = {}): Doc => recomputeIssues({
  id, filename: `${id}.pdf`, fileType: 'pdf', pages: 1, batchId: 'b', source: 'drive', receivedAt: new Date('2026-01-01'), typeId: 'invoice', stage: 'linked',
  extracted: [f('customer_name', 'Maria Lopez'), f('service_date', '2026-02-02'), f('cost', '100.00')], linkedEntityIds: ['c1'], linkConfidence: 1, issues: [], preview: 't', ...o,
} as Doc, hvacSchema);
const rowOf = (d: Doc): QueueRowData => {
  const t = hvacSchema.documentTypes.find((x) => x.id === d.typeId);
  return { doc: d, name: d.filename, sub: '', typeLabel: t?.label ?? 'Unclassified', need: needInfo(d, requiredFieldsForDoc(d, t)), assignee: null, hasReminder: false, technician: null };
};
const g = { schema: hvacSchema, entities };
const none = new Set<string>();
const tr = (d: Doc, money: Set<string> = none): TriageRow => triageRow(rowOf(d), g, money);

// ---- groups ----
const wo = (id: string, o: Partial<Doc> = {}) => doc(id, { typeId: 'work-order', stage: 'extracted', linkedEntityIds: [], extracted: [f('service_address', '1 Elm St'), f('service_date', '2026-01-01')], ...o });
check('one suggested customer -> "Confirm customer" with that customer', (() => { const r = tr(wo('a', { linkSuggestionIds: ['c1'] })); return r.group === 'confirm' && r.suggestion?.id === 'c1' && r.suggestion.name === 'Maria Lopez'; })());
check('two suggested customers -> "Choose a customer", never one click', tr(wo('b', { linkSuggestionIds: ['c1', 'c2'] })).group === 'pick' && tr(wo('b', { linkSuggestionIds: ['c1', 'c2'] })).suggestion === null);
check('no suggestion -> "Choose a customer"', tr(wo('c')).group === 'pick');
check('a suggestion for a customer that no longer exists is not offered', tr(wo('d', { linkSuggestionIds: ['gone'] })).group === 'pick');
check('complete, linked, nothing open -> "Check and approve"', (() => { const r = tr(doc('e')); return r.group === 'approve' && r.approvable; })());
check('a missing fact -> "Add missing info" with short chips', (() => { const r = tr(doc('f', { extracted: [f('customer_name', 'Maria Lopez'), f('service_date', '2026-02-02')] })); return r.group === 'missing' && r.chips.some((c) => /^No cost/.test(c)) && r.chips.length <= 4; })());
check('nothing read -> "Take a look" (Hard to read), never approvable', (() => { const r = tr(doc('g', { stage: 'received', extracted: [] })); return r.group === 'look' && r.chips.includes('Hard to read') && !r.approvable; })());
check('"Other" with nothing read asks for a type', (() => { const r = tr(doc('h', { typeId: 'other', stage: 'received', extracted: [] })); return r.group === 'look' && r.chips.includes('Pick a type'); })());
check('a value to check blocks approval', (() => { const d = doc('i'); d.issues = [...d.issues, { kind: 'suspect-value', field: 'cost', value: '100.00', rule: 'x', reason: 'r', quote: null, page: 1 }]; const r = tr(d); return r.group === 'look' && !r.approvable && !isBulkApprovable(d, g, none); })());
check('a date to confirm blocks approval', (() => { const d = doc('j', { extracted: [f('customer_name', 'Maria Lopez'), f('service_date_unconfirmed', '2099-01-01'), f('cost', '1')] }); return !isBulkApprovable(d, g, none) && tr(d).group !== 'approve'; })());
check('an amount flagged under "Money to check" blocks approval', (() => { const d = doc('k'); return isBulkApprovable(d, g, none) && !isBulkApprovable(d, g, new Set(['k'])) && tr(d, new Set(['k'])).group === 'look'; })());
check('a disputed value blocks approval', (() => { const d = doc('l'); d.issues = [...d.issues, { kind: 'conflict', conflictId: 'x' }]; return !isBulkApprovable(d, g, none) && tr(d).group === 'look'; })());
check('an already checked paper is never offered', !isBulkApprovable(doc('m', { stage: 'verified' }), g, none));
check('a paper still missing a link is never approvable', !isBulkApprovable(wo('n', { linkSuggestionIds: ['c1'] }), g, none));

// ---- bulk sets ----
const rows = [tr(wo('a1', { linkSuggestionIds: ['c1'], linkSuggestionStrongIds: ['c1'] })), tr(wo('a2', { linkSuggestionIds: ['c2'] })), tr(wo('a3', { linkSuggestionIds: ['c1', 'c2'] })), tr(doc('p1')), tr(doc('p2')), tr(doc('p3', { stage: 'received', extracted: [] }))];
check('D1: "Link all with a clear match" holds only STRONG single-suggestion papers (a weak one is one click at a time)', JSON.stringify(bulkLinkPairs(rows).map((p) => p.docId)) === JSON.stringify(['a1']), JSON.stringify(bulkLinkPairs(rows).map((p) => p.docId)));
check('D1: a weak suggestion is still one click on that paper', singleLinkPair(rows[1]!).length === 1 && singleLinkPair(rows[1]!)[0]!.entityId === 'c2' && rows[1]!.suggestion?.strong === false);
check('D1: a suggestion with no strong mark is weak', tr(wo('w', { linkSuggestionIds: ['c1'] })).suggestion?.strong === false && tr(wo('w2', { linkSuggestionIds: ['c1'], linkSuggestionStrongIds: ['c1'] })).suggestion?.strong === true);
check('"Approve all" holds only papers that passed every check', JSON.stringify(bulkApproveIds(rows)) === JSON.stringify(['p1', 'p2']));
check('bulk sets never mix groups', bulkLinkPairs(rows.filter((r) => r.group !== 'confirm')).length === 0 && bulkApproveIds(rows.filter((r) => r.group !== 'approve')).length === 0);
{
  const secs = triageSections(rows.map((r) => rowOf(r.doc)), g, none);
  check('sections come in the easiest-first order and skip empty ones', secs.map((s) => s.key).join() === 'confirm,approve,pick,look', secs.map((s) => s.key).join());
  const c = summaryCounts(secs);
  check('summary adds up: total = need you + ready', c.total === 6 && c.ready === 2 && c.needYou === 4, JSON.stringify(c));
  // D2: one shared count. The tab badge, the nav badge and the list's "N to clear" read the same function over the same papers.
  const all: Record<string, Doc> = Object.fromEntries(rows.map((r) => [r.doc.id, r.doc]));
  check('D2: todoCount (badge) equals the list total ("N to clear")', todoCount(all) === c.total, `${todoCount(all)} vs ${c.total}`);
  const idsOf = (s: { items: unknown[] }) => (s.items as TriageRow[]).map((r) => r.doc.id);
  check('open group: chosen if still there, else the selected paper\'s group, else the first', openGroupKey(secs, 'look', undefined, idsOf) === 'look' && openGroupKey(secs, 'gone', 'p2', idsOf) === 'approve' && openGroupKey(secs, null, undefined, idsOf) === 'confirm' && openGroupKey([], null, undefined, idsOf) === null);
}
// ---- nothing is changed by reading ----
{
  const before = JSON.stringify(useGraph.getState().docs);
  triageSections(rows.map((r) => rowOf(r.doc)), g, none);
  check('planning reads only: the graph is untouched', JSON.stringify(useGraph.getState().docs) === before);
}

// ---- D4 / D5: bulk Link / Undo are confirmed by the server first, never race, and Undo restores the stage and the suggestion ----
{
  const { linkMany, approveMany, undo, isBulkBusy } = await import('../src/components/inbox/inboxBulk');
  const calls: { action: string; body: Record<string, unknown>; at: number }[] = [];
  let failFor: string | null = null; let delayMs = 0;
  (globalThis as unknown as { fetch: unknown }).fetch = async (_u: string, init: { body: string }) => {
    const body = JSON.parse(init.body); calls.push({ action: body.action, body, at: Date.now() });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (body.action === 'linkDocument' && body.documentId === failFor) return new Response('{"error":"boom"}', { status: 500 });
    return new Response(JSON.stringify({ document: {}, links: [], suggestions: [] }), { status: 200 });
  };
  const wd = (id: string) => wo(id, { linkSuggestionIds: ['c1'], linkSuggestionStrongIds: ['c1'] });
  useGraph.setState({ docs: { u1: wd('u1'), u2: wd('u2'), u3: wd('u3') }, entities });
  delayMs = 40; failFor = 'u3';
  const pending = linkMany([{ docId: 'u1', entityId: 'c1' }, { docId: 'u2', entityId: 'c1' }, { docId: 'u3', entityId: 'c1' }], 'T', '');
  check('D4: a second action while one is saving is refused (no race)', isBulkBusy() && await undo({ kind: 'link', items: [], before: {}, label: '' }).then(() => false, () => true));
  const r = await pending;
  check('D4: the result lists only the papers the server confirmed; the failed one is counted, not claimed', r.action.kind === 'link' && r.action.items.map((i) => i.docId).sort().join() === 'u1,u2' && r.failed === 1, JSON.stringify(r.failed));
  check('D4: the busy lock is released when the action ends', !isBulkBusy());
  // the screen is refreshed from the server after the saves (not before): the Undo precondition is the refreshed state
  useGraph.setState({ docs: { u1: { ...wd('u1'), linkedEntityIds: ['c1'], linkSuggestionIds: undefined, linkSuggestionStrongIds: undefined, stage: 'linked' }, u2: { ...wd('u2'), linkedEntityIds: ['c1'], linkSuggestionIds: undefined, linkSuggestionStrongIds: undefined, stage: 'linked' }, u3: wd('u3') } });
  calls.length = 0; delayMs = 0;
  const u = await undo(r.action);
  const unl = calls.filter((c) => c.action === 'unlinkDocument');
  check('D5: Undo asks the server to put back the stage and the suggestion (name, strength)', unl.length === 2 && unl.every((c) => c.body.restoreStage === 'read' && JSON.stringify(c.body.restoreSuggestion) === JSON.stringify([{ id: 'c1', name: 'Maria Lopez', strong: true }])), JSON.stringify(unl.map((c) => c.body)));
  check('D5: Undo reports what it did', u.restored === 2 && u.failed === 0 && u.leftAlone === 0, JSON.stringify(u));
  // a paper whose value a person corrected since is left alone
  const changed = { ...wd('u1'), linkedEntityIds: ['c1'], extracted: [f('customer_name', 'Maria Lopez'), f('service_date', '2030-01-01')] };
  useGraph.setState({ docs: { u1: changed as Doc } });
  const u2 = await undo({ kind: 'link', items: [{ docId: 'u1', entityId: 'c1' }], before: { u1: wd('u1') }, label: '' });
  check('D4: a paper changed since is left alone by Undo', u2.leftAlone === 1 && u2.restored === 0, JSON.stringify(u2));
  // approve: confirmed by the server before it is reported
  calls.length = 0;
  useGraph.setState({ docs: { p9: doc('p9') } });
  const ap = await approveMany(['p9'], 'T', '');
  check('D4: Approve is saved on the server before it is reported', calls.some((c) => c.action === 'verifyDocument') && ap.action.kind === 'approve' && ap.action.docIds.join() === 'p9' && ap.failed === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
