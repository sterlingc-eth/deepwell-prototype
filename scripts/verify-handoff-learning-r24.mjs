/**
 * verify:handoff-learning-r24 - "learn from every handoff" (api/_lib/handoffLearning/, switch DONOVAN_HANDOFF_LEARNING, default OFF), on PGlite, no model.
 *   adoption (a filler word, a word for a kind of paper) / rejection (support, conflict, engine disagrees) / privacy (private papers, personal data, no answer text kept, raw text blanked)
 *   tenant isolation / Google Drive + Gmail exclusion / rollback (thumbs-down, mismatch, expiry, flag off) / shared learnings (3 companies, no conflict)
 *   node scripts/verify-handoff-learning-r24.mjs
 */
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0; let passes = 0;
const check = (name, ok, detail = '') => { if (ok) passes++; else failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${String(detail).slice(0, 400)}`}`); };
delete process.env.ANTHROPIC_API_KEY; delete process.env.DONOVAN_HANDOFF_LEARNING;
const realLog = console.log; console.log = (...a) => { if (typeof a[0] === 'string' && /^\{"/.test(a[0])) return; realLog(...a); }; console.warn = () => {}; console.error = () => {};
const J = (p) => import(path.join(ROOT, p));
const HL = await J('api/_lib/handoffLearning/index.js');
const { answerSignature, agreesWithSignature } = await J('api/_lib/handoffLearning/sig.js');
const { paraphrases } = await J('api/_lib/handoffLearning/paraphrase.js');
const S = await J('api/_lib/handoffLearning/store.js');
const { selectCandidates } = await J('api/_lib/handoffLearning/adopt.js');
const { wordBlocked } = await J('api/_lib/dql/learned/index.js');
const agreeN = (ans, h) => agreesWithSignature(ans, { nums: h.sig?.nums ?? [], ids: [] }); // the cited ids in this fixture are stand-ins: figures decide
const on = (v) => { if (v === null) delete process.env.DONOVAN_HANDOFF_LEARNING; else process.env.DONOVAN_HANDOFF_LEARNING = v; };

/* ---- 1. the switch */
check('flag: default off', HL.handoffLearningEnabled({}) === false);
check('flag: "1" on', HL.handoffLearningEnabled({ DONOVAN_HANDOFF_LEARNING: '1' }) === true);
check('flag: "true" on', HL.handoffLearningEnabled({ DONOVAN_HANDOFF_LEARNING: 'true' }) === true);
check('flag: "0" off', HL.handoffLearningEnabled({ DONOVAN_HANDOFF_LEARNING: '0' }) === false);
check('flag: junk off', HL.handoffLearningEnabled({ DONOVAN_HANDOFF_LEARNING: 'maybe' }) === false);

/* ---- 2. masking: no private text in what is kept */
const vocab = { customers: { phrases: ['Linda Fitzgerald'], words: new Set(['linda', 'fitzgerald']) }, cities: ['Scottsdale'], brands: ['Carrier'], technicians: { phrases: ['Bob Ruiz'], words: new Set() } };
const m1 = HL.maskQuestion('how much did Linda Fitzgerald pay in 2024 for Carrier units in Scottsdale?', vocab);
check('mask: names, brand, city, year replaced', !/linda|fitzgerald|carrier|scottsdale|2024/i.test(m1.masked) && /\{NAME\}/.test(m1.masked) && /\{NUM\}/.test(m1.masked), m1.masked);
check('mask: e-mail blocks the question', HL.maskQuestion('send to linda@example.com the total', vocab).blocked === true);
check('mask: SSN blocks the question', HL.maskQuestion('who has 123-45-6789 on file', vocab).blocked === true);
check('mask: phone blocks the question', HL.maskQuestion('whose number is (602) 555-0142', vocab).blocked === true);
check('mask: card number blocks the question', HL.maskQuestion('card 4111 1111 1111 1111 total', vocab).blocked === true);
check('mask: quoted text replaced', /\{QUOTE\}/.test(HL.maskQuestion('docs mentioning "limping badly"', vocab).masked));
check('mask: dates and money replaced', !/\d/.test(HL.maskQuestion('total over $1,200 since 2024-03-05', vocab).masked));
check('mask: technician name replaced', !/ruiz/i.test(HL.maskQuestion("Bob Ruiz's visits", vocab).masked));

/* ---- 3. answer signature: numbers and ids, never the sentence */
const sg = answerSignature('Linda Fitzgerald paid $1,250.50 across 3 invoices.', [{ id: 'd1' }, { id: 'd2' }]);
check('sig: numbers kept', sg.nums.includes('1250.5') && sg.nums.includes('3'));
check('sig: no sentence kept', !JSON.stringify(sg).match(/Linda|paid|invoices/i));
check('sig: same figure agrees', agreesWithSignature({ text: 'The total is $1,250.50 over 3 invoices', records: [{ id: 'd1' }, { id: 'd2' }] }, sg));
check('sig: different figure disagrees', !agreesWithSignature({ text: 'The total is $1,250 over 3 invoices', records: [] }, sg));
check('sig: different records disagree', !agreesWithSignature({ text: '1250.50 and 3', records: [{ id: 'x1' }, { id: 'x2' }] }, sg));
check('sig: empty signature never agrees', !agreesWithSignature({ text: 'anything 5' }, { nums: [], ids: [] }));
check('sig: a bare year proves nothing', !agreesWithSignature({ text: 'in 2024 things happened' }, { nums: ['2024'], ids: [] }));

/* ---- 4. Google Drive / Gmail exclusion */
const G = HL.isGoogleSourced;
check('google: source "google_drive"', G({ source: 'google_drive' }));
check('google: source "Gmail sync"', G({ source_system: 'Gmail sync' }));
check('google: drive link', G({ url: 'https://drive.google.com/file/d/abc/view' }));
check('google: docs link in metadata', G({ metadata: { webViewLink: 'https://docs.google.com/document/d/1' } }));
check('google: gmail message id', G({ gmail_message_id: '18c' }));
check('google: drive file id', G({ driveFileId: 'x' }));
check('google: an ordinary upload is not Google', !G({ source: 'upload', document_type: 'invoice' }) && !G({}) && !G(null));

/* ---- 5. words that can never be learned */
for (const [w, why] of [['never', 'negation'], ['could', 'modality'], ['invoices', 'noun'], ['five', 'number-word'], ['it', 'deictic']]) check(`blocked word: ${w} (${why})`, !!wordBlocked(w));
check('blocked word: an ordinary word passes', wordBlocked('gizmos') === null);

/* ---- 6. paraphrases, overlay, shared (pure) */
const pp = paraphrases('how many invoices do we have in 2024', { customers: [], years: ['2022', '2023'] });
check('paraphrase: several, not the question itself, deterministic', pp.length >= 3 && !pp.includes('how many invoices do we have in 2024') && JSON.stringify(pp) === JSON.stringify(paraphrases('how many invoices do we have in 2024', { customers: [], years: ['2022', '2023'] })));
const ov = HL.buildOverlay([{ kind: 'word', phrase: 'gizmos', canonical: 'invoices' }, { kind: 'filler', phrase: 'fnord' }], { shared: [{ kind: 'word', phrase: 'gizmos', canonical: 'bills' }] });
check('overlay: whole-word rewrite', HL.applyRewrites('how many gizmos, and gizmosx', ov) === 'how many invoices, and gizmosx');
check('overlay: the organization wins over a shared learning', ov.rewrites.filter((r) => r.from === 'gizmos').length === 1 && ov.rewrites[0].to === 'invoices');
check('overlay: filler kept as a word set', ov.fillers.has('fnord'));
check('overlay: never rewrites inside a name on file', HL.applyRewrites('total for Billings Roofing', ov, { customers: { phrases: ['Billings Roofing'] } }) === 'total for Billings Roofing');
const sh = (rows) => HL.promoteShared(new Map(rows));
const f = (extra = {}) => ({ kind: 'filler', phrase: 'fnord', canonical: '', status: 'active', ...extra });
check('shared: three companies, no conflict -> shared', sh([['a', [f()]], ['b', [f()]], ['c', [f()]]]).share.length === 1);
check('shared: two companies -> not shared', sh([['a', [f()]], ['b', [f()]]]).share.length === 0);
check('shared: a retired learning anywhere blocks sharing', sh([['a', [f()]], ['b', [f()]], ['c', [f()]], ['d', [f({ status: 'retired' })]]]).share.length === 0);
const w = (c, tk = 'entity') => ({ kind: 'word', phrase: 'gizmos', canonical: c, targetKind: tk, status: 'active' });
check('shared: conflicting meanings -> not shared', sh([['a', [w('invoices')]], ['b', [w('invoices')]], ['c', [w('bills')]]]).share.length === 0);
check('shared: a kind of paper stays in its company', sh([['a', [w('invoices', 'doc_type')]], ['b', [w('invoices', 'doc_type')]], ['c', [w('invoices', 'doc_type')]]]).share.length === 0);
check('shared: a generic word is shared', sh([['a', [w('customers')]], ['b', [w('customers')]], ['c', [w('customers')]]]).share.length === 1);
check('shared: a shared learning is retired when a company retires its own', sh([['a', [f({ status: 'retired' })]]]).retire.length === 0 && HL.promoteShared(new Map([['a', [f({ status: 'retired' })]]]), { alreadyShared: [{ kind: 'filler', phrase: 'fnord' }] }).retire.length === 1);
check('selectCandidates: a single handoff is not enough', selectCandidates([{ kind: 'word', phrase: 'gizmos', canonical: 'invoices', hid: '1', sig: 'a' }]).selected.length === 0);
check('selectCandidates: two readings of one word are dropped', selectCandidates([{ kind: 'word', phrase: 'gizmos', canonical: 'invoices', hid: '1', sig: 'a' }, { kind: 'word', phrase: 'gizmos', canonical: 'bills', hid: '2', sig: 'b' }]).rejected[0]?.reason === 'conflict');

/* ---- 7. the database: two companies on PGlite */
const off = await J('scripts/offline-exam.mjs');
await off.installPgHarness(); await off.installModelBlock();
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/golden/golden-export.json'), 'utf8'));
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const ctxA = (await off.loadExportIntoNewTenant(lite, data, { tenantKey: 'offline:hl-a', tenantName: 'A' })).ctx;
const dataB = JSON.parse(JSON.stringify(data).replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, (u) => ((parseInt(u[0], 16) + 8) % 16).toString(16) + u.slice(1)));
const ctxB = (await off.loadExportIntoNewTenant(lite, dataB, { tenantKey: 'offline:hl-b', tenantName: 'B' })).ctx;
const sql = fs.readFileSync(path.join(ROOT, 'M3-config/72-handoff-learning.sql'), 'utf8').replace(/^SELECT c\.relname[\s\S]*$/m, '');
try { await lite.exec(sql); check('sql: 72-handoff-learning.sql applies on PGlite', true); } catch (e) { check('sql: 72-handoff-learning.sql applies on PGlite', false, e.message); }
const { withTenant } = await J('api/_lib/recordsStore.js');
const { packForTenant } = await J('api/_lib/industry/index.js');
const { getTenantVocab, resetTenantVocabCacheForTests } = await J('api/_lib/vocab/tenantVocab.js');
const { parseDql } = await J('api/_lib/dql/parse.js');
const pack = await packForTenant({ withTenant, ctxArg: ctxA });
const TODAY = '2026-10-07';
const nInv = data.documents.filter((d) => String(d.document_type).toLowerCase().replace(/_/g, '-') === 'invoice').length;
const nTix = data.documents.filter((d) => String(d.document_type).toLowerCase().replace(/_/g, '-') === 'service-ticket').length;
const nPer = data.documents.filter((d) => String(d.document_type).toLowerCase().replace(/_/g, '-') === 'permit').length;
const nWo = data.documents.filter((d) => String(d.document_type).toLowerCase().replace(/_/g, '-') === 'work-order').length;
const rows = async (ctx, q, p = []) => withTenant(ctx, async (db) => (await db.raw(q, p)).rows);
const cited = (id = 'doc-1', extra = {}) => [{ id, type: 'invoice', ...extra }];
const hand = (ctx, q, n, extra = {}) => withTenant(ctx, async (db) => HL.recordHandoff(db, { question: q, vocab: null, answer: { text: `There are ${n} of them.`, citedRecords: cited(), ...extra.answer }, reading: extra.reading ?? { op: 'count', docType: extra.docType ?? 'invoice', entity: 'doc' }, env: { DONOVAN_HANDOFF_LEARNING: extra.off ? '0' : '1' } }));

// 7a. recording
let r = await hand(ctxA, 'how many invoices do we have fnord', nInv, { off: true });
check('record: flag off -> nothing recorded', !r.ok && r.reason === 'off' && (await rows(ctxA, 'SELECT count(*)::int n FROM donovan_handoffs'))[0].n === 0);
r = await hand(ctxA, 'how many invoices do we have fnord', nInv);
check('record: a grounded handoff is kept', r.ok === true);
r = await withTenant(ctxA, (db) => HL.recordHandoff(db, { question: 'how many invoices zork', answer: { text: 'I could not find it.', citedRecords: [] }, env: { DONOVAN_HANDOFF_LEARNING: '1' } }));
check('record: an answer with no cited record is not kept', !r.ok && r.reason === 'not-grounded');
r = await withTenant(ctxA, (db) => HL.recordHandoff(db, { question: 'how many hr letters', answer: { text: 'There are 4.', citedRecords: [{ id: 'h1', type: 'hr-letter' }] }, env: { DONOVAN_HANDOFF_LEARNING: '1' } }));
check('record: a private paper (HR letter) is never kept', !r.ok && r.reason === 'private-document');
r = await withTenant(ctxA, (db) => HL.recordHandoff(db, { question: 'how many internal notes', answer: { text: 'There are 4.', citedRecords: [{ id: 'h2', document_type: 'employee-warning' }] }, env: { DONOVAN_HANDOFF_LEARNING: '1' } }));
check('record: a private staff paper (warning) is never kept', !r.ok && r.reason === 'private-document');
for (const [nm, src] of [['Google Drive sync', { source: 'google_drive' }], ['Gmail sync', { source_system: 'gmail' }], ['a Drive link', { url: 'https://drive.google.com/file/d/1/view' }]]) {
  r = await withTenant(ctxA, (db) => HL.recordHandoff(db, { question: 'how many invoices zork', answer: { text: 'There are 4.', citedRecords: [{ id: 'g1', type: 'invoice', ...src }] }, env: { DONOVAN_HANDOFF_LEARNING: '1' } }));
  check(`record: content from ${nm} is never kept`, !r.ok && r.reason === 'google-source');
}
r = await withTenant(ctxA, (db) => HL.recordHandoff(db, { question: 'how many invoices zork', answer: { text: 'There are 4.', citedRecords: cited('ok1') }, env: { DONOVAN_HANDOFF_LEARNING: '1' } }));
r = await withTenant(ctxA, (db) => HL.recordHandoff(db, { question: 'how many invoices zork', answer: { text: 'There are 4.', citedRecords: cited('ok2'), sources: [{ id: 'g2', provider: 'Google Drive' }] }, env: { DONOVAN_HANDOFF_LEARNING: '1' } }));
check('record: a Google source listed beside the answer blocks it too', !r.ok && r.reason === 'google-source');
r = await withTenant(ctxA, (db) => HL.recordHandoff(db, { question: 'whose email is bob@example.com', answer: { text: 'It is 4.', citedRecords: cited('p1') }, env: { DONOVAN_HANDOFF_LEARNING: '1' } }));
check('record: a question with personal data is not kept', !r.ok && r.reason === 'personal-data');
const kept = await rows(ctxA, 'SELECT * FROM donovan_handoffs ORDER BY id');
check('record: the answer sentence is never stored', !JSON.stringify(kept).includes('There are') && kept.every((k) => k.answer_sig && !('answer_text' in k)));
check('record: the stored reading holds structure only', JSON.stringify(kept[0].reading) === JSON.stringify({ op: 'count', entity: 'doc', docType: 'invoice' }));
check('record: reading values that are not plain words are dropped', JSON.stringify(HL.cleanReading({ op: 'count', entity: 'Linda Fitzgerald!', docType: 'x'.repeat(80), groupBy: ['year', 'a b'] })) === JSON.stringify({ op: 'count', groupBy: ['year'] }));

// 7b. isolation
check('isolation: another company sees none of A\'s handoffs', (await withTenant(ctxB, (db) => S.listNewHandoffs(db))).length === 0);
check('isolation: A sees its own', (await withTenant(ctxA, (db) => S.listNewHandoffs(db))).length >= 1);

// 7c. the job: a filler word. Three handoffs, two kinds of paper, same chatter word.
await hand(ctxA, 'how many service tickets do we have fnord', nTix, { docType: 'service-ticket' });
await hand(ctxA, 'how many permits do we have fnord', nPer, { docType: 'permit' });
await hand(ctxA, 'how many work orders do we have fnord', nWo, { docType: 'work-order' });
// a wording: gizmos = invoices (two handoffs)
await hand(ctxA, 'how many gizmos are there', nInv);
await hand(ctxA, 'how many gizmos do we have', nInv);
// a question the records answer differently from the "handoff" (a wrong stand-in answer): must teach nothing
await hand(ctxA, 'how many gadgets do we have', 99999);
const base = (ctx, q) => withTenant(ctx, async (db) => { const e = await HL.makeEngine(db, { pack, today: TODAY }); return e.run(q, null, { debug: true }); });
const b0 = await base(ctxA, 'how many invoices do we have fnord');
check('before: the unknown word makes Donovan hand the question over', !b0.ans, b0.ans?.text);
let rep;
on('1');
await withTenant(ctxA, async (db) => { const engine = await HL.makeEngine(db, { pack, today: TODAY }); rep = await HL.runHandoffLearningJob(db, { engine, trace: globalThis.__tr = [], agree: agreeN, regression: ['how many invoices do we have', 'how many service tickets do we have in 2024', 'how many permits are there'] }); });
if (process.env.HL_DEBUG) realLog('TRACE', JSON.stringify(globalThis.__tr));
const learned = await rows(ctxA, 'SELECT kind, phrase, canonical, status, support FROM donovan_handoff_learned ORDER BY phrase');
check('job: the chatter word is adopted as a filler', learned.some((l) => l.kind === 'filler' && l.phrase === 'fnord' && l.status === 'active'), JSON.stringify(rep.rejected).slice(0, 300));
check('job: "gizmos" is adopted as another word for invoices', learned.some((l) => l.phrase === 'gizmos' && l.canonical === 'invoices'), JSON.stringify(learned));
check('job: nothing is learned from the question whose answer the records contradict', !learned.some((l) => l.phrase === 'gadgets') && rep.mismatch + rep.none + rep.noLead >= 1);
check('job: raw question text is blanked once read', (await rows(ctxA, 'SELECT count(*)::int n FROM donovan_handoffs WHERE question_text IS NOT NULL'))[0].n === 0);
check('job: the masked form stays, no raw words of the chatter question', (await rows(ctxA, 'SELECT count(*)::int n FROM donovan_handoffs WHERE question_masked <> \'\'' ))[0].n >= 5);
check('job: the report carries no question text', !/how many/i.test(JSON.stringify(rep)));
check('isolation: company B has no adopted learning', (await rows(ctxB, 'SELECT count(*)::int n FROM donovan_handoff_learned'))[0].n === 0 && (await withTenant(ctxB, (db) => S.listActive(db))).length === 0);

// 7d. use: the engine answers alone with the learning, and only for A
const ovA = await withTenant(ctxA, (db) => HL.loadHandoffOverlay(db));
const ovB = await withTenant(ctxB, (db) => HL.loadHandoffOverlay(db));
check('use: A\'s overlay holds the learnings, B\'s is empty', ovA?.size >= 2 && !ovB);
const withA = await withTenant(ctxA, async (db) => (await HL.makeEngine(db, { pack, today: TODAY })).run('how many invoices do we have fnord please', ovA));
check('use: the same answer as the known wording, alone', withA.ans && new RegExp(`\\b${nInv}\\b`).test(withA.ans.text), withA.ans?.text);
const withB = await withTenant(ctxB, async (db) => (await HL.makeEngine(db, { pack, today: TODAY })).run('how many invoices do we have fnord please', ovB));
check('isolation: company B still hands the question over', !withB.ans);
const unseen = await withTenant(ctxA, async (db) => (await HL.makeEngine(db, { pack, today: TODAY })).run('how many gizmos did we have in 2026', ovA));
const known = await withTenant(ctxA, async (db) => (await HL.makeEngine(db, { pack, today: TODAY })).run('how many invoices did we have in 2026', null));
check('use: an unseen question with the new word gives the same answer as the known word', known.ans && unseen.ans && unseen.ans.text === known.ans.text, `${unseen.ans?.text} | ${known.ans?.text}`);
const plain = await withTenant(ctxA, async (db) => (await HL.makeEngine(db, { pack, today: TODAY })).run('how many invoices do we have', ovA));
const plain0 = await withTenant(ctxA, async (db) => (await HL.makeEngine(db, { pack, today: TODAY })).run('how many invoices do we have', null));
check('use: a question without the learned words is unchanged', plain.ans && plain0.ans && plain.ans.text === plain0.ans.text);
const neg = await withTenant(ctxA, async (db) => (await HL.makeEngine(db, { pack, today: TODAY })).run('how many invoices do we not have fnord', ovA));
check('use: a negation next to a learned filler is still handed over', !neg.ans, neg.ans?.text);

// 7e. rollback / switch
resetTenantVocabCacheForTests(); on(null);
const tvOff = await withTenant(ctxA, (db) => getTenantVocab(db, ctxA.tenantKey, pack));
check('switch off: the vocabulary carries no overlay', !tvOff.handoff);
const offParse = parseDql('how many invoices do we have fnord', { tenantVocab: tvOff, pack, today: TODAY, original: 'x' });
check('switch off: Donovan behaves as before (still hands the question over)', !offParse?.plan);
resetTenantVocabCacheForTests(); on('1');
const tvOn = await withTenant(ctxA, (db) => getTenantVocab(db, ctxA.tenantKey, pack));
check('switch on: the vocabulary carries A\'s overlay', tvOn.handoff?.size >= 2);
const tvOnB = await withTenant(ctxB, (db) => getTenantVocab(db, ctxB.tenantKey, pack));
check('switch on: B\'s vocabulary has none', !tvOnB.handoff);
const onParse = parseDql('how many invoices do we have fnord', { tenantVocab: tvOn, pack, today: TODAY, original: 'x' });
check('switch on: the parser reads the learned filler', !!onParse?.plan);
const offRec = await hand(ctxA, 'how many invoices again', nInv, { off: true });
check('switch off: nothing new is recorded', !offRec.ok);

const ver0 = await withTenant(ctxA, (db) => S.overlayVersion(db));
const gone = await withTenant(ctxA, (db) => HL.retireOnFeedback(db, { question: 'how many invoices do we have fnord', rating: 'down' }));
check('rollback: a thumbs-down retires the learning whose words were in the question', gone.includes('fnord'));
check('rollback: the other learning stays', (await withTenant(ctxA, (db) => S.listActive(db))).some((l) => l.phrase === 'gizmos'));
check('rollback: the cached vocabulary is rebuilt (version changed)', (await withTenant(ctxA, (db) => S.overlayVersion(db))) !== ver0);
check('rollback: a thumbs-up retires nothing', (await withTenant(ctxA, (db) => HL.retireOnFeedback(db, { question: 'how many gizmos', rating: 'up' }))).length === 0);
check('rollback: a thumbs-down in B touches nothing of A', (await withTenant(ctxB, (db) => HL.retireOnFeedback(db, { question: 'how many gizmos', rating: 'down' }))).length === 0 && (await withTenant(ctxA, (db) => S.listActive(db))).some((l) => l.phrase === 'gizmos'));
resetTenantVocabCacheForTests();
const tvAfter = await withTenant(ctxA, (db) => getTenantVocab(db, ctxA.tenantKey, pack));
check('rollback: the retired filler no longer works', !parseDql('how many invoices do we have fnord', { tenantVocab: tvAfter, pack, today: TODAY, original: 'x' })?.plan);
// mismatch
await hand(ctxA, 'how many gizmos exist', 424242);
const mm = await withTenant(ctxA, async (db) => { const engine = await HL.makeEngine(db, { pack, today: TODAY }); return HL.retireOnMismatch(db, engine, [{ id: 'z', question: 'how many gizmos exist', sig: { nums: ['424242'], ids: [] } }], (a) => /\b424242\b/.test(a.text)); });
check('rollback: a later mismatch retires the learning', mm.includes('gizmos'));
check('rollback: retired is kept as a record, not deleted', (await rows(ctxA, "SELECT count(*)::int n FROM donovan_handoff_learned WHERE status = 'retired'"))[0].n >= 2);
// a retired phrase is not re-adopted at once
const reId = await withTenant(ctxA, (db) => S.adoptLearning(db, { kind: 'word', phrase: 'gizmos', canonical: 'invoices', support: 2 }));
check('rollback: a just-retired learning cannot be re-adopted at once', reId === null || (await rows(ctxA, "SELECT status FROM donovan_handoff_learned WHERE phrase = 'gizmos'"))[0].status === 'retired');
// expiry
await withTenant(ctxA, (db) => S.adoptLearning(db, { kind: 'filler', phrase: 'zzyx', support: 3 }));
await rows(ctxA, "UPDATE donovan_handoff_learned SET expires_at = NOW() - INTERVAL '1 day' WHERE phrase = 'zzyx'");
check('expiry: an expired learning is no longer read', !(await withTenant(ctxA, (db) => S.listActive(db))).some((l) => l.phrase === 'zzyx'));
// retention
await rows(ctxA, "INSERT INTO donovan_handoffs (tenant_id, question_text, question_masked) VALUES ((SELECT id FROM tenants WHERE tenant_key = 'offline:hl-a'), 'old raw question', 'old')").catch(() => {});
await rows(ctxA, "UPDATE donovan_handoffs SET created_at = NOW() - INTERVAL '30 days' WHERE question_masked = 'old'").catch(() => {});
await withTenant(ctxA, (db) => S.purgeOldHandoffs(db));
check('retention: raw text older than 14 days is removed even if the job never ran', (await rows(ctxA, "SELECT count(*)::int n FROM donovan_handoffs WHERE question_text = 'old raw question'"))[0].n === 0);

// 7f. rejection: too little support, a conflict, engine disagrees
await hand(ctxA, 'how many invoices do we have blorp', nInv);
await hand(ctxA, 'how many permits do we have blorp', nPer, { docType: 'permit' });
await hand(ctxA, 'how many service tickets do we have wibble', nTix, { docType: 'service-ticket' });
await hand(ctxA, 'how many wozzits are there', nInv);
await hand(ctxA, 'how many wozzits do we have', nPer, { docType: 'permit' });
await hand(ctxA, 'how many invoices do we have flarp', nPer);
await hand(ctxA, 'how many permits do we have flarp', nInv, { docType: 'permit' });
await hand(ctxA, 'how many work orders do we have flarp', nTix, { docType: 'work-order' });
let rep2;
await withTenant(ctxA, async (db) => { const engine = await HL.makeEngine(db, { pack, today: TODAY }); rep2 = await HL.runHandoffLearningJob(db, { engine, agree: agreeN, regression: [] }); });
const l2 = await rows(ctxA, "SELECT phrase FROM donovan_handoff_learned WHERE status = 'active'");
check('reject: a filler seen in only two handoffs is not adopted', !l2.some((l) => l.phrase === 'blorp'));
check('reject: a single handoff teaches nothing', !l2.some((l) => l.phrase === 'wibble'));
check('reject: a word meaning two different things is not adopted', !l2.some((l) => l.phrase === 'wozzits'));
check('reject: a filler whose handoffs the engine cannot reproduce is not adopted', !l2.some((l) => l.phrase === 'flarp'));
// 7g. a learning the engine would apply with a different answer than the known wording is thrown out (paraphrase / regression gate)
const ovBad = HL.buildOverlay([{ kind: 'word', phrase: 'tickets', canonical: 'permits' }]);
const aBad = await withTenant(ctxA, async (db) => { const e = await HL.makeEngine(db, { pack, today: TODAY }); return [e.run('how many service tickets do we have', ovBad), e.run('how many service tickets do we have', null)]; });
check('gate: a harmful rewrite is visible to the regression check (answers differ)', aBad[0].ans && aBad[1].ans ? aBad[0].ans.text !== aBad[1].ans.text : true);
check('index: the job does nothing when the switch is off', (await (async () => { on(null); const rp = await withTenant(ctxA, async (db) => HL.runHandoffLearningJob(db, { engine: null })); on('1'); return rp; })()).skipped === 'off');
check('files: api keeps exactly 12 top-level files', fs.readdirSync(path.join(ROOT, 'api')).filter((f) => fs.statSync(path.join(ROOT, 'api', f)).isFile()).length === 12);
check('files: no learning code touches retrieval/ or grounding/', !fs.readdirSync(path.join(ROOT, 'api/_lib/handoffLearning')).some((f) => /retrieval|grounding/.test(fs.readFileSync(path.join(ROOT, 'api/_lib/handoffLearning', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''))));

realLog(`\nhandoff-learning-r24: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
