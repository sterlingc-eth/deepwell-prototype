/**
 * verify:dql-vocabcard-r25 - the company's vocabulary card knows which nouns name a kind of PAPER and which name a VISIT / EVENT (card.js nounVocab, nounVeto.js).
 *   - derived only from the company's own rows: no word list per company
 *   - an event word that is also the name of a kind of paper, where the visits are not exactly those papers, is flagged ambiguous and the question is released
 *   - a paper word ("reports", "agreements") is never flagged; a phrase that names the whole kind ("compounded rx fills") is never flagged
 *   - roleVocabulary() exports the card for the learned reader's slot filler
 *   - the old behaviour returns with R25_NOUNS=0; end to end on the golden HVAC export
 *   node scripts/verify-dql-vocabcard-r25.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0; let passes = 0;
const check = (name, ok, detail = '') => { if (ok) passes++; else failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${String(detail).slice(0, 400)}`}`); };
delete process.env.ANTHROPIC_API_KEY; delete process.env.R25_NOUNS;
const realLog = console.log; console.log = (...a) => { if (typeof a[0] === 'string' && /^\{"/.test(a[0])) return; realLog(...a); }; console.warn = () => {}; console.error = () => {};

const { buildCard, nounKey, roleVocabulary, PAPER_FORM } = await import('../api/_lib/dql/card.js');
const { nounVeto } = await import('../api/_lib/dql/nounVeto.js');

// ---- three invented companies, built only as rows {k, t, v}
const rows = []; const docTypes = [];
const add = (t, n, fn) => { docTypes.push({ id: t, n }); for (let i = 0; i < n; i++) fn(i, t); };
const day = (i) => `2024-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 27)).padStart(2, '0')}`;
// A: a pharmacy. fills and compounding records carry the dispense date; agreements and manifests do not.
add('compounded-rx-fill', 40, (i, t) => { rows.push({ k: 'dispensed_on', t, v: day(i) }, { k: 'pharmacist', t, v: ['Ann Lee', 'Bo Wu', 'Cy Fox'][i % 3] + ' ' }); });
add('batch-compounding-record', 20, (i, t) => rows.push({ k: 'dispensed_on', t, v: day(i) }, { k: 'pharmacist', t, v: ['Ann Lee', 'Bo Wu'][i % 2] }));
add('clinic-supply-agreement', 10, (i, t) => rows.push({ k: 'term_note', t, v: 'annual supply of saline and gloves ' + i }));
add('delivery-manifest', 12, (i, t) => rows.push({ k: 'driver_note', t, v: 'left at the dock door ' + i }));
const cardA = buildCard({ rows, docTypes, custNames: [], nDocs: 82 });
// B: every paper of the one kind is a visit, and it is the only kind with a visit date
const rowsB = []; const dtB = [];
dtB.push({ id: 'showing-feedback-form', n: 30 }); for (let i = 0; i < 30; i++) rowsB.push({ k: 'showed_on', t: 'showing-feedback-form', v: day(i) }, { k: 'agent', t: 'showing-feedback-form', v: ['Dee Roe', 'Ed Poe'][i % 2] });
dtB.push({ id: 'listing-agreement', n: 9 }); for (let i = 0; i < 9; i++) rowsB.push({ k: 'clause', t: 'listing-agreement', v: 'exclusive right to sell ' + i });
const cardB = buildCard({ rows: rowsB, docTypes: dtB, custNames: [], nDocs: 39 });
// C: no visit date anywhere
const rowsC = []; const dtC = [{ id: 'delivery-dispute-note', n: 12 }, { id: 'delivery-ticket', n: 20 }];
for (let i = 0; i < 12; i++) rowsC.push({ k: 'dispute_text', t: 'delivery-dispute-note', v: 'short load ' + i });
for (let i = 0; i < 20; i++) rowsC.push({ k: 'ticket_text', t: 'delivery-ticket', v: 'dock ' + i });
const cardC = buildCard({ rows: rowsC, docTypes: dtC, custNames: [], nDocs: 32 });
// D: two visit kinds, each fully dated, and both carry the word
const rowsD = []; const dtD = [{ id: 'dental-exam-record', n: 10 }, { id: 'dental-exam-followup', n: 6 }];
for (let i = 0; i < 10; i++) rowsD.push({ k: 'seen_on', t: 'dental-exam-record', v: day(i) });
for (let i = 0; i < 6; i++) rowsD.push({ k: 'seen_on', t: 'dental-exam-followup', v: day(i) });
const cardD = buildCard({ rows: rowsD, docTypes: dtD, custNames: [], nDocs: 16 });

// ---- 1. the card
check('A: visit date key found', cardA.visit?.key === 'dispensed_on', JSON.stringify(cardA.visit));
check('A: visit kinds are the two dated kinds', JSON.stringify(cardA.visit.kinds.slice().sort()) === JSON.stringify(['batch-compounding-record', 'compounded-rx-fill']));
check('A: 60 visits', cardA.visit.n === 60);
check('A: fill is an event word', !!cardA.nouns[nounKey('fills')]);
check('A: fill is ambiguous (the visits are more than the fills)', cardA.nouns[nounKey('fill')].ambiguous === true);
check('A: fill carries a reason and a confidence below 1', cardA.nouns[nounKey('fill')].conf < 1 && cardA.nouns[nounKey('fill')].why.length > 10);
check('A: compounding / compounded meet on one key and name both visit kinds', cardA.nouns[nounKey('compounding')].kinds.length === 2 && cardA.nouns[nounKey('compounding')].exact === true);
check('A: manifest is a paper word, not an event word', !cardA.nouns[nounKey('manifest')]);
check('A: agreement is a paper word', !cardA.nouns[nounKey('agreement')]);
check('A: record is a paper word', !cardA.nouns[nounKey('record')]);
check('A: supply is an event-like word but not dated', cardA.nouns[nounKey('supply')]?.visitKinds.length === 0);
check('A: staff key found', cardA.roles.technician?.key === 'pharmacist');
check('A: entity kinds list the staff key', cardA.entityKinds.staff.keys.includes('pharmacist'));
check('A: field labels cover every key', Object.keys(cardA.fields).every((k) => cardA.fieldLabels[k]?.label));
check('A: field label reads the key', cardA.fieldLabels.dispensed_on.label === 'dispensed on');
check('A: field label carries the shape', cardA.fieldLabels.dispensed_on.shape === 'date');
check('B: showing is an event word, and the visits are exactly the showing papers', cardB.nouns[nounKey('showings')].exact === true && cardB.nouns[nounKey('showings')].ambiguous === false);
check('B: showing has confidence 1', cardB.nouns[nounKey('showing')].conf === 1);
check('B: feedback is exact too', cardB.nouns[nounKey('feedback')].exact === true);
check('B: listing is not dated, so not exact', cardB.nouns[nounKey('listing')].exact === false);
check('C: no visit date key', cardC.visit.key === null);
check('C: nothing is claimed exact without a visit date', Object.values(cardC.nouns).every((n) => !n.exact));
check('C: delivery is ambiguous (names the work, not only the paper)', cardC.nouns[nounKey('deliveries')].ambiguous === true);
check('D: dental exam is ambiguous only when the visits are not exactly the papers', cardD.nouns[nounKey('exam')].exact === true);
check('nounKey folds plurals', nounKey('deliveries') === nounKey('delivery') && nounKey('deliverys') === nounKey('delivery'));
check('nounKey folds install / installs / installation', nounKey('installs') === nounKey('installation'));
check('nounKey ignores short words', nounKey('rx') === '' && nounKey('a') === '');
check('PAPER_FORM has report and form, not fill', PAPER_FORM.has('report') && PAPER_FORM.has('form') && !PAPER_FORM.has('fill'));
check('card version 2', cardA.version === 2);
check('typeN counts documents per kind', cardA.fields.dispensed_on.typeN['compounded-rx-fill'] === 40);

// ---- 2. the veto (pure)
const V = (q, card, plan = { entity: 'document', docType: 'x', visit: false }, names) => nounVeto(q, card, plan, names ?? {});
check('release: "how many fills"', !!V('how many fills did we log', cardA));
check('release: "of all fills, what percent"', !!V('of all fills, what percent were over $800', cardA));
check('release: count and fills in one ask', !!V('G\'day - total count, fills', cardA));
// a company that is not the HVAC shop (industryKind set): the shared paper tables (delivery ticket ...) were tuned on an HVAC shop and only it keeps them
check('release: misspelled plural (deliverys)', !!V('how many deliverys did we log', cardC, undefined, { industryKind: 'construction' }));
check('release: "deliveries"', !!V('how many deliveries last year', cardC, undefined, { industryKind: 'construction' }));
check('answer: compounding on its own (the visits are exactly the papers that carry it)', V('how many compounding last year', cardA) === null);
check('answer: "fill records" names the paper (next word is a paper word)', V('how many fill records', cardA) === null);
check('answer: "compounded rx fills" names the whole kind', V('how many compounded rx fills', cardA) === null);
check('answer: "batch compounding records"', V('how many batch compounding records', cardA) === null);
check('answer: supply agreements', V('how many clinic supply agreements', cardA) === null);
check('answer: delivery manifests', V('how many delivery manifests', cardA) === null);
check('answer: showings when the visits are exactly the showing papers', V('how many showings last month', cardB) === null);
check('answer: dental exams when exact', V('how many exams in 2024', cardD) === null);
check('answer: a plan that reads a visit is left alone', V('how many fills', cardA, { entity: 'document', visit: true }) === null);
check('answer: a multi plan with a visit part is left alone', V('count and last date of fills', cardA, { op: 'multi', parts: [{ visit: true }] }) === null);
check('answer: a name that holds the word is left alone', V('papers for Fills Hardware', cardA, undefined, { nameWords: new Set(['fills', 'hardware']) }) === null);
check('answer: a city that holds the word', V('papers in Fills', cardA, undefined, { cityWords: new Set(['fills']) }) === null);
check('answer: no card, no veto', V('how many fills', null) === null);
check('answer: question with no event word', V('how many estimates in 2024', cardA) === null);
check('answer: a customer lookup', V('what is the phone number for Ann Lee', cardA) === null);
check('release: plural and singular alike', !!V('how many fill', cardA) && !!V('how many fills', cardA));
check('release: mixed case', !!V('HOW MANY FILLS DID WE LOG', cardA));
process.env.R25_NOUNS = '0';
check('kill switch R25_NOUNS=0 turns the veto off', V('how many fills did we log', cardA) === null);
delete process.env.R25_NOUNS;

// ---- 3. role vocabulary for the learned reader's slot filler
const rv = roleVocabulary(cardA);
check('role vocabulary: kind labels are document-type words', rv.doc['compounded rx fill']?.kind === 'compounded-rx-fill' && rv.doc['batch compounding records']?.kind === 'batch-compounding-record');
check('role vocabulary: fills is flagged ambiguous', rv.visit.fills?.ambiguous === true && rv.ambiguous.includes('fills'));
check('role vocabulary: confidence is carried', rv.visit.fills.conf < 1);
check('role vocabulary: exact event word is not ambiguous', roleVocabulary(cardB).visit.showings.ambiguous === false);
check('role vocabulary: staff and field labels are carried', Array.isArray(rv.staff) && rv.fieldLabels.pharmacist?.label === 'pharmacist');
check('role vocabulary: JSON round trip', JSON.stringify(JSON.parse(JSON.stringify(rv))) === JSON.stringify(rv));
check('role vocabulary: empty card', Object.keys(roleVocabulary(null).doc).length === 0);

// ---- 4. end to end on the golden HVAC export (PGlite): ordinary paper questions still answer
const off = await import('./offline-exam.mjs');
await off.installPgHarness(); await off.installModelBlock();
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/golden/golden-export.json'), 'utf8'));
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const lctx = (await off.loadExportIntoNewTenant(lite, data, { tenantKey: 'offline:r25card', tenantName: 'r25card' })).ctx;
const { withTenant } = await import('../api/_lib/recordsStore.js');
const { getTenantVocab } = await import('../api/_lib/vocab/tenantVocab.js');
const { packForTenant } = await import('../api/_lib/industry/index.js');
const { parseDql } = await import('../api/_lib/dql/index.js');
const ctxArg = { tenantKey: lctx.tenantKey, tenantName: 'r25card' };
const pack = await packForTenant({ withTenant, ctxArg });
const tv = await withTenant(ctxArg, (db) => getTenantVocab(db, lctx.tenantKey, pack));
const card = tv?.dql?.card;
check('golden: the card has the noun table', !!card && card.version === 2 && typeof card.nouns === 'object');
check('golden: every noun entry carries its flags', Object.values(card?.nouns ?? {}).every((n) => typeof n.ambiguous === 'boolean' && Array.isArray(n.kinds)));
const TODAY = '2026-10-07';
const ask = (q) => parseDql(q, { tenantVocab: tv, pack, today: TODAY, original: q });
const kinds = Object.keys(card?.kinds ?? {});
const paperKind = kinds.find((k) => /(?:invoice|estimate|agreement|permit|certificate|report)$/.test(k));
if (paperKind) { const w = card.kinds[paperKind].plural; const r = ask(`how many ${w} do we have`); check(`golden: "${w}" still reads (a paper word is never flagged)`, !!r && !!r.plan, JSON.stringify(r)?.slice(0, 200)); }
const amb = Object.values(card?.nouns ?? {}).find((n) => n.ambiguous);
if (amb) { const r = ask(`how many ${amb.w}s did we log`); check(`golden: the ambiguous word "${amb.w}s" is released`, !r || r.plain || (r.plan?.visit === true) || r.plan?.entity !== 'document', JSON.stringify(r)?.slice(0, 200)); }
else check('golden: no ambiguous noun in this export (nothing to release)', true);
check('golden: greeting g\'day does not become "yesterday"', !/yesterday/i.test(JSON.stringify(ask("g'day - how many customers do we have")?.plan?.time ?? '')));
check('golden: "did we log" reads as "did we have"', (() => { const a = ask('how many invoices did we log'); const b = ask('how many invoices did we have'); return JSON.stringify(a?.plan ?? null) === JSON.stringify(b?.plan ?? null); })());

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
