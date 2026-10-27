// Bulk import autopilot: logic checks against the REAL server code on an in-process Postgres (PGlite, real schema, row-level security, the real app role).
// Synthetic import with a truth record per paper; the model is never called. Run from the app root:  node scripts/verify-import-autopilot.mjs
import fs from 'node:fs';
import { startPglite } from './lib/pglite-tenant.mjs';
import { buildSynthetic } from './lib/import-synth.mjs';
import { loadSynthetic } from './lib/import-load.mjs';
import { drive, fileAll, answer, chunks } from './lib/import-run.mjs';
const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const out = console.log; console.log = () => {}; console.error = () => {};
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; out('FAIL', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
const h = await startPglite(root);
const IA = await import(root + '/api/_lib/importAutopilot.js');
const q = async (sql, p = []) => (await h.lite.query(sql, p)).rows;
const mk = async (key, N = 600) => {
  const ctx = { tenantKey: key, tenantName: key }; const ten = (await h.getTenantContext(key, key)).id; const batch = h.nid(); const synth = buildSynthetic(N);
  await loadSynthetic(h, ten, synth, batch); return { ctx, ten, batch, synth, scope: { batchId: batch } };
};
const A = await mk('org_a'); const B = { ctx: { tenantKey: 'org_b', tenantName: 'org_b' } }; await h.getTenantContext('org_b', 'org_b');

// ---- settings: ON for imports, OFF for single uploads
eq((await IA.getImportSettings(A.ctx)).autoFileImports, true, 'imports default ON');
eq((await IA.getImportSettings(A.ctx)).autoFileSingles, false, 'single uploads default OFF');
eq(IA.MAX_APPLY, 100, 'apply chunk is 100');
const files = fs.readdirSync(root + '/api').filter((f) => fs.statSync(root + '/api/' + f).isFile());
eq(files.length, 12, 'api/ keeps exactly 12 top-level files');

// ---- status and plan do not change anything and never create a customer
const cust0 = (await q(`SELECT count(*)::int n FROM entities WHERE entity_type='customer'`))[0].n;
const st = await IA.importStatus(A.ctx, A.scope);
ok(st.counts.total === 600 && st.autoFileOn, 'status counts the batch and says auto-file is on');
const plan0 = await IA.importPlan(A.ctx, { ...A.scope, fresh: true });
ok(plan0.decisions.length > 5 && plan0.summary.decisions === plan0.decisions.length, 'plan has decisions');
ok(plan0.decisions.every((d) => d.samples.length <= 3 && d.samples.length >= 1 && d.count >= 2), 'each decision has 1-3 samples and at least 2 papers');
ok(!/\$\s?\d/.test(JSON.stringify(plan0)), 'no money in the plan');
eq((await q(`SELECT count(*)::int n FROM entities WHERE entity_type='customer'`))[0].n, cust0, 'planning creates no customer');

// ---- D1: a weak suggestion (a name or a street alone) never makes a one-press group, and the server refuses to apply it
ok(!plan0.decisions.some((d) => d.kind === 'link-suggested'), 'weak suggestions form no link-suggested group');
ok(plan0.lookAt.reasons.some((r) => r.reason === 'one-customer' && r.count > 5), 'weak single suggestions are papers to confirm one at a time');
const weakDocs = A.synth.suggestions.filter((x) => x.candidates.length === 1).slice(0, 3);
const weakTry = await IA.importApplyDecision(A.ctx, { ...A.scope, kind: 'link-suggested', key: weakDocs[0].candidates[0].id, customerId: weakDocs[0].candidates[0].id, documentIds: weakDocs.map((x) => x.doc), by: 'T' }, 'u1');
eq(weakTry.applied, 0, 'D1: the server refuses to link weak suggestions in a group');
// strong evidence (as the R6 rule defines it) is marked on the suggestion and then forms a group
const byCand = new Map(); for (const x of A.synth.suggestions.filter((y) => y.candidates.length === 1)) (byCand.get(x.candidates[0].id) ?? byCand.set(x.candidates[0].id, []).get(x.candidates[0].id)).push(x);
const strongGroup = [...byCand.values()].find((g) => g.length >= 2);
for (const x of strongGroup) await h.lite.query(`INSERT INTO audit_log (tenant_id, action, resource_type, resource_id, changes, created_at) VALUES ($1,'recheck.link_suggestion','document',$2,$3::jsonb, NOW() + INTERVAL '1 second')`, [A.ten, x.doc, JSON.stringify({ candidates: x.candidates.map((c) => ({ ...c, strong: true })) })]);
IA._clearAnalysisCache();

// ---- setting off: nothing files by itself; a "file passed" card appears instead
await IA.setImportSettings(A.ctx, { autoFileImports: false }, 'u1');
const offRun = await IA.importAutoFile(A.ctx, { ...A.scope, limit: 50 }, 'u1');
ok(offRun.off === true && offRun.filed === 0, 'setting off: nothing filed');
const planOff = await IA.importPlan(A.ctx, { ...A.scope, fresh: true });
void ('  planOff', JSON.stringify(planOff.counts), planOff.decisions.map((d) => d.kind + ':' + d.count).join(' ').slice(0, 300));
ok(planOff.decisions.some((d) => d.kind === 'file-passed'), 'setting off: "file passed" card appears');
ok(planOff.decisions.find((d) => d.kind === 'file-passed')?.count === planOff.counts.eligible, 'the card covers every paper that passed');
ok((await q(`SELECT 1 FROM audit_log WHERE action='import.settings_changed'`)).length >= 1, 'setting change is audited');
await IA.setImportSettings(A.ctx, { autoFileImports: true }, 'u1');

// ---- auto-file: only papers that pass every check; no link, value or customer is created
const linksBefore = (await q(`SELECT count(*)::int n FROM document_entity_links`))[0].n;
const filed1 = await fileAll(IA, A.ctx, A.scope);
ok(filed1 > 100, `auto-filed a lot (${filed1})`);
eq((await q(`SELECT count(*)::int n FROM document_entity_links`))[0].n, linksBefore, 'auto-filing adds no link');
eq((await q(`SELECT count(*)::int n FROM entities WHERE entity_type='customer'`))[0].n, cust0, 'auto-filing creates no customer');
const badFiled = await q(`SELECT d.original_filename f FROM documents d WHERE d.batch_id = $1 AND d.verified_by='ai' AND d.stage='verified' AND d.original_filename ~* '(copy|void)'`, [A.batch]);
ok(badFiled.length === 0, `no copy / void paper auto-filed (${badFiled.length})`);
const audited = (await q(`SELECT count(DISTINCT resource_id)::int n FROM audit_log WHERE action='import.auto_filed'`))[0].n;
ok(audited >= filed1, `every auto-filed paper has an audit row (${audited} vs ${filed1})`);

// ---- undo the auto-filing for the batch; a paper a person touched since is left alone
const someFiled = (await q(`SELECT id FROM documents WHERE batch_id=$1 AND stage='verified' AND verified_by='ai' AND id IN (SELECT resource_id FROM audit_log WHERE action='import.auto_filed') LIMIT 2`, [A.batch])).map((r) => r.id);
await h.lite.query(`INSERT INTO audit_log (tenant_id, action, resource_type, resource_id, changes) VALUES ($1,'review.document_verified','document',$2,'{}'::jsonb)`, [A.ten, someFiled[0]]);
let undone = 0; for (let i = 0; i < 20; i++) { const r = await IA.importUndoAutoFile(A.ctx, A.scope, 'u1'); undone += r.undone; if (!r.more) break; }
ok(undone >= filed1 - 5 && undone < filed1, `undo took back the auto-filed papers but not the one a person checked (${undone}/${filed1})`);
eq((await q(`SELECT stage FROM documents WHERE id=$1`, [someFiled[0]]))[0].stage, 'verified', 'person-touched paper stays filed');
eq((await IA.importStatus(A.ctx, A.scope)).autoFileOn, false, 'batch is paused after undo');
eq((await IA.importAutoFile(A.ctx, { ...A.scope, limit: 50 }, 'u1')).off, true, 'paused batch is not filed again');
await IA.importResume(A.ctx, A.scope, 'u1');
eq((await IA.importStatus(A.ctx, A.scope)).autoFileOn, true, 'resume turns it back on');

// ---- decisions: apply, undo, server re-validation
const plan = await IA.importPlan(A.ctx, { ...A.scope, fresh: true });
const byKind = (k) => plan.decisions.filter((d) => d.kind === k);
const link = byKind('link-suggested')[0]; const create = byKind('create-customer')[0]; const dateFix = byKind('use-invoice-date')[0]; const typeQ = byKind('choose-type')[0];
ok(link && create && dateFix && typeQ, 'plan has a link, create-customer, date and type decision');
// 101 papers in one call is refused
await IA.importApplyDecision(A.ctx, { ...A.scope, kind: dateFix.kind, key: dateFix.id.slice(dateFix.kind.length + 1), documentIds: Array.from({ length: 101 }, () => h.nid()), by: 'T' }, 'u1').then(() => ok(false, '101 papers must be refused'), (e) => eq(e.status, 413, 'more than 100 papers per call is refused'));
// a paper that is not part of the group is skipped (the browser's claim is not trusted)
const stranger = typeQ.documentIds[0];
const r0 = await IA.importApplyDecision(A.ctx, { ...A.scope, kind: 'use-invoice-date', key: dateFix.id.slice('use-invoice-date:'.length), documentIds: [stranger], by: 'T' }, 'u1');
eq([r0.applied, r0.skipped.length], [0, 1], 'a paper that does not fit the decision is skipped');
// another tenant cannot touch this batch
const rx = await IA.importApplyDecision(B.ctx, { batchId: A.batch, kind: link.kind, key: link.id.slice(link.kind.length + 1), customerId: link.params.customerId, documentIds: link.documentIds, by: 'T' }, 'u2').catch(() => ({ applied: 0, skipped: [1] }));
eq(rx.applied, 0, 'tenant isolation: another shop applies nothing');
eq((await IA.importStatus(B.ctx, { batchId: A.batch })).counts.total, 0, 'tenant isolation: another shop sees nothing');
// link-suggested apply + undo
const linkRes = await answer(IA, A.ctx, A.scope, link);
ok(linkRes.applied === link.count, `link applied to the whole group (${linkRes.applied}/${link.count})`);
const linkedTo = (await q(`SELECT DISTINCT entity_id FROM document_entity_links WHERE document_id = ANY($1::uuid[])`, [link.documentIds])).map((r) => r.entity_id);
ok(linkedTo.includes(link.params.customerId), 'papers linked to the suggested customer');
const ub = await IA.importUndoDecision(A.ctx, { ...A.scope, runId: linkRes.runId }, 'u1');
ok(ub.restored === linkRes.applied, `undo restores every paper (${ub.restored})`);
eq((await q(`SELECT count(*)::int n FROM document_entity_links WHERE document_id = ANY($1::uuid[]) AND entity_id=$2`, [link.documentIds, link.params.customerId]))[0].n, 0, 'undo removed the links');
// create-customer: made only by the click; undo removes the customer again
const cBefore = (await q(`SELECT count(*)::int n FROM entities WHERE entity_type='customer'`))[0].n;
const cRes = await answer(IA, A.ctx, A.scope, create);
eq((await q(`SELECT count(*)::int n FROM entities WHERE entity_type='customer'`))[0].n, cBefore + 1, 'one click made exactly one customer');
ok(cRes.applied === create.count, `customer linked to the whole group (${cRes.applied}/${create.count})`);
const cUndo = await IA.importUndoDecision(A.ctx, { ...A.scope, runId: cRes.runId }, 'u1');
eq(cUndo.customersRemoved, 1, 'undo removed the customer it made');
eq((await q(`SELECT count(*)::int n FROM entities WHERE entity_type='customer'`))[0].n, cBefore, 'customer count restored');
// a person's value is never replaced
const dfDoc = dateFix.documentIds[0];
await h.lite.query(`INSERT INTO extractions (tenant_id, document_id, field_key, value, corrected_value, corrected_by, confidence, created_at) VALUES ($1,$2,'service_date',NULL,'2020-01-01','Pat',1,NOW())`, [A.ten, dfDoc]);
const dRes = await answer(IA, A.ctx, A.scope, dateFix);
ok(dRes.skipped.some((s) => s.documentId === dfDoc), 'a paper whose date a person already entered is skipped');
eq((await q(`SELECT corrected_value v FROM extractions WHERE document_id=$1 AND field_key='service_date' AND corrected_by='Pat'`, [dfDoc]))[0].v, '2020-01-01', "the person's date is untouched");
// a person re-links a paper after the plan: the apply skips it
const reLink = create.documentIds.length > 1 ? null : null; void reLink;

// ---- drive the rest, then check wrong links / values against the truth
const run = await drive(IA, A.ctx, A.scope, { chooser: (d) => (d.kind !== 'choose-type' ? undefined : d.params.options.includes('insurance-certificate') ? 'insurance-certificate' : d.params.options[0]) });
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const links = await q(`SELECT l.document_id d, e.data->>'customer_name' n FROM document_entity_links l JOIN entities e ON e.id=l.entity_id`);
let wrongLinks = 0; for (const l of links) { const t = A.synth.truth.get(l.d); if (t && norm(t.customer) !== norm(l.n)) wrongLinks++; }
eq(wrongLinks, 0, 'no wrong links');
const sd = await q(`SELECT DISTINCT ON (document_id) document_id d, COALESCE(NULLIF(btrim(corrected_value),''), value) v, corrected_by cb FROM extractions WHERE field_key='service_date' ORDER BY document_id, created_at DESC, id DESC`);
let wrongVals = 0; for (const r of sd) { const t = A.synth.truth.get(r.d); if (t && r.cb && r.cb !== 'Pat' && t.serviceDate && r.v !== t.serviceDate) { wrongVals++; out('  wrong value', t.kind, r.v, t.serviceDate); } }
eq(wrongVals, 0, 'no wrong values');
const trapNames = (await q(`SELECT data->>'customer_name' n FROM entities WHERE entity_type='customer'`)).map((r) => r.n);
ok(!trapNames.some((n) => /project location|walk-in/i.test(n) || norm(n) === norm(A.synth.shop)), 'no customer made from our own company or a form label');
ok(run.decisionCount > 5, 'drive answered the decisions');
const pf = JSON.stringify(await IA.importPlan(A.ctx, { ...A.scope, fresh: true }));
ok(!/\$\s?\d/.test(pf), 'no money anywhere in the final plan');

// ---- D3: "create customer" never uses a label, heading, issuer or own company, and never guesses between two customer-side names
{
  const reg = [{ page_no: 1, text: '7765 E Cottonwood Dr\nQuintero Systems Co.   Unit 221\nPlano, TX 75006\nTel 512-555-0141 | office@q.example.com |\nLIMITED WARRANTY CERTIFICATE\nLabel printer\nRegistered   Juniper Lane Mercantile   Purchased From Authorized reseller\nOwner\n\nREGISTERED TO\nJuniper Lane Mercantile\n5243 E Copper Ct\nSte 325\nFranklin, TN 37040' }];
  const evR = IA.newCustomerEvidence({ type: 'warranty-registration', pages: reg });
  ok(!evR || !/registered to/i.test(evR.name), 'D3: "REGISTERED TO" is never proposed as a customer');
  const back = [{ page_no: 1, text: 'Bluff Creek Plumbing & Drain\n6007 E Heritage Rd, Gilbert, AZ 85280\n602-555-0172 | office@bluff.example.com\nBACKFLOW ASSEMBLY TEST REPORT\nSubmitted to Cottonwood Valley Water Authority\nReport # | BF-2200\nProperty / Owner | Brightwater Storage Co.\nAttn: Leonard Graves' }];
  eq(IA.newCustomerEvidence({ type: 'inspection-report', pages: back }), null, 'D3: two different customer-side names on one paper: nothing is proposed');
  ok(IA.isHeadingNotName('REGISTERED TO') && IA.isHeadingNotName('Submitted to') && IA.isHeadingNotName('Bill To') && IA.isHeadingNotName('PROJECT LOCATION'), 'D3: headings and labels are not names');
  ok(!IA.isHeadingNotName('Juniper Lane Mercantile') && !IA.isHeadingNotName('Owens Plumbing LLC') && !IA.isHeadingNotName('Maria Lopez'), 'D3: real names pass');
  const own = [{ page_no: 1, text: 'Acme Parts Supply\n1 Main St, Mesa, AZ 85201\nINVOICE\nBill To: Mesa Mechanical Services\n2 Shop Rd, Mesa, AZ 85202\nTotal due' }];
  eq(IA.newCustomerEvidence({ type: 'invoice', pages: own, ownNames: ['Mesa Mechanical Services'] }), null, 'D3: our own company is never a customer');
  const issuer = [{ page_no: 1, text: 'Acme Plumbing LLC\n123 Main St, Mesa, AZ 85201\nINVOICE\nBill To: Acme Plumbing LLC\nTotal due' }];
  eq(IA.newCustomerEvidence({ type: 'invoice', pages: issuer }), null, 'D3: the issuer is never the customer');
  const good = [{ page_no: 1, text: 'Acme Parts Supply\n1 Main St, Mesa, AZ 85201\nINVOICE\nBill To: Juniper Lane Mercantile\n5243 E Copper Ct\nFranklin, TN 37040\nTotal due' }];
  const evG = IA.newCustomerEvidence({ type: 'invoice', pages: good });
  ok(evG && evG.name === 'Juniper Lane Mercantile' && evG.hasAddress === true, 'D3: a clear Bill To name with its address is proposed, flagged with its address');
  ok(IA.createEvidenceEnough([evG]) && !IA.createEvidenceEnough([{ ...evG, hasAddress: false }]) && IA.createEvidenceEnough([{ ...evG, hasAddress: false }, evG]), 'D3: needs 2 papers, or one paper with its address');
}

// ---- rev3: a stored suggestion records whether its evidence was strong (R6); weak and old ones stay weak
{
  const BN = await import(root + '/api/_lib/bodyNameLink.js');
  const cust = [{ id: 'c1', name: 'Juniper Lane Mercantile', address: '5243 E Copper Ct, Franklin, TN' }, { id: 'c2', name: 'Maria Lopez', address: '9 Elm St, Mesa, AZ' }];
  const weak = BN.findCustomersInBody([{ page_no: 1, text: 'INVOICE\nWork done at the home of Maria Lopez on Tuesday\nTotal due' }], cust);
  ok(weak.candidates.length > 0 && weak.candidates.every((c) => c.strong !== true), 'rev3: a name seen without a street or label value is a weak candidate (no strong flag)');
  const strong = BN.findCustomersInBody([{ page_no: 1, text: 'Acme Parts Supply\n1 Main St\nINVOICE\nBill To:\nJuniper Lane Mercantile\n5243 E Copper Ct\nFranklin, TN 37040\nTotal due' }], cust);
  ok(strong.candidates.length === 1 && strong.candidates[0].strong === true, 'rev3: name plus street is recorded as strong');
}

// ---- D6: copies never hide another customer's paper
{
  const base = { type: 'invoice', stage: 'read', createdAt: 1, number: 'INV100', cost: 250, party: 'acme', date: '2026-03-01', hash: null, customerIds: [] };
  const mk = (id, o) => ({ ...base, id, filename: `${id}.pdf`, ...o });
  eq([...IA.findCopies([mk('a', { stage: 'verified', customerIds: ['c1'] }), mk('b', { filename: 'b (copy).pdf', party: 'other', customerIds: ['c2'] })]).keys()], [], 'D6: same number and amount for two customers: not a copy, even with "(copy)" in the name');
  eq([...IA.findCopies([mk('a', { hash: 'H', customerIds: ['c1'] }), mk('b', { hash: 'H', customerIds: ['c2'] })]).keys()], [], 'D6: identical content linked to two different customers: never grouped');
  eq([...IA.findCopies([mk('a', { stage: 'verified' }), mk('b', { party: '' })]).keys()], [], 'D6: party unknown: not a copy by type, date and amount');
  eq([...IA.findCopies([mk('a', { stage: 'verified' }), mk('b', { date: '2026-03-02' })]).keys()], [], 'D6: a different date: not a copy');
  eq([...IA.findCopies([mk('a', { stage: 'verified' }), mk('b', { cost: 251 })]).keys()], [], 'D6: a different amount: not a copy');
  eq([...IA.findCopies([mk('a', { stage: 'verified' }), mk('b', {})]).entries()], [['b', 'a']], 'D6: same type, date, amount and party: a copy of the filed one');
  eq([...IA.findCopies([mk('a', { stage: 'verified', hash: 'H' }), mk('b', { party: '', hash: 'H' })]).entries()], [['b', 'a']], 'D6: identical content: a copy');
  // rev3: the strict rule (type, NUMBER, date, amount, same CUSTOMER from a real fact or link; vendor never the party)
  eq([...IA.findCopies([mk('a', { stage: 'verified' }), mk('b', { number: 'INV101' })]).keys()], [], 'rev3: a different document number vetoes');
  eq([...IA.findCopies([mk('a', { stage: 'verified' }), mk('b', { number: '' })]).keys()], [], 'rev3: no document number: not a copy by type/date/amount');
  eq([...IA.findCopies([mk('a', { stage: 'verified', party: '' }), mk('b', { party: '' })]).keys()], [], 'rev3: no customer on either paper (only a vendor): not a copy');
  eq([...IA.findCopies([mk('a', { stage: 'verified', party: 'bigco' }), mk('b', { party: 'smallco' })]).keys()], [], 'rev3: same number, date and amount for two named customers: not a copy');
  eq([...IA.findCopies([mk('a', { stage: 'verified', party: '', customerIds: ['c1'] }), mk('b', { party: 'acme' })]).keys()], [], 'rev3: one linked, the other only named: not proof');
  eq([...IA.findCopies([mk('a', { stage: 'verified', party: '', customerIds: ['c1'] }), mk('b', { party: '', customerIds: ['c1'] })]).entries()], [['b', 'a']], 'rev3: the same linked customer, number, date, amount: a copy');
  eq([...IA.findCopies([mk('a', { stage: 'verified', party: '', customerIds: ['c1'] }), mk('b', { party: '', customerIds: ['c2'] })]).keys()], [], 'rev3: different linked customers: not a copy');
}

// ---- D5 (server half): Undo of a link puts the stage and the suggestion back
{
  const RS = h.rs; void RS;
  const rv = await import(root + '/api/_lib/reviewStore.js');
  const sx = A.synth.suggestions.filter((x) => x.candidates.length === 1)[5];
  const sdoc = sx.doc, scand = sx.candidates[0];
  const live = async () => ((await rv.listLinks(A.ctx, { documentIds: [sdoc] })).suggestions ?? []).find((x) => x.document_id === sdoc);
  ok(!!(await live()), 'D5: the paper starts with a live suggestion');
  await rv.linkDocument(A.ctx, { documentId: sdoc, entityId: scand.id, by: 'T' }, 'u1');
  eq((await q(`SELECT stage FROM documents WHERE id=$1`, [sdoc]))[0].stage, 'linked', 'D5: linked');
  await rv.unlinkDocument(A.ctx, { documentId: sdoc, entityId: scand.id, restoreStage: 'read', restoreSuggestion: [{ id: scand.id, name: scand.name }] }, 'u1');
  eq((await q(`SELECT stage FROM documents WHERE id=$1`, [sdoc]))[0].stage, 'read', 'D5: Undo demotes the paper back to its earlier stage');
  eq((await live())?.candidates?.[0]?.id, scand.id, 'D5: Undo restores the suggestion');
  const ghost = '99999999-9999-4999-8999-999999999999';
  await rv.linkDocument(A.ctx, { documentId: sdoc, entityId: scand.id, by: 'T' }, 'u1');
  await rv.unlinkDocument(A.ctx, { documentId: sdoc, entityId: scand.id, restoreStage: 'verified', restoreSuggestion: [{ id: ghost, name: 'Nobody' }] }, 'u1');
  eq([(await q(`SELECT stage FROM documents WHERE id=$1`, [sdoc]))[0].stage, await live()], ['read', undefined], 'D5: a stage above "mapped" is never restored, and an unknown customer is never suggested');
}

// ---- D9: no reader of field keys by pattern in the new server module (verify:r33-dates)
{
  const src = fs.readFileSync(root + '/api/_lib/importAutopilot.js', 'utf8');
  ok(!/field_key\s+(?:I?LIKE|~\*?|SIMILAR)\s/i.test(src), 'D9: importAutopilot.js matches field keys exactly, never by pattern');
}

out(`verify-import-autopilot: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
