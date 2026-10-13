/**
 * verify:reader-r21 - the extractive reader, round 21: possessive and "have ... in their agreement" phrasings, "payment terms on invoice N",
 * a one-day "dated" paper, follow-ups that stay on the same paper ("who signed it"), and a failed reader question that never becomes a count.
 *   node scripts/verify-reader-r21.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0; let passes = 0;
const check = (name, ok, detail = '') => { if (ok) passes++; else fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${String(detail).slice(0, 400)}`}`); };
delete process.env.ANTHROPIC_API_KEY; delete process.env.DONOVAN_READER;
const { clauseAsk, readerShaped, readerTopicAsk, _analyze } = await import('../api/_lib/dql/families/reader.js');
const { readerFollowup, paperOf } = await import('../api/_lib/followup/readerfu.js');
const { topicOf, readPages } = await import('../api/_lib/search/extractive.js');

// ---- phrasings
const ca = (q) => clauseAsk(q.toLowerCase());
check('have: "does X have a deposit clause in their agreement"', ca('does Ann Lee have a deposit clause in their agreement')?.topicSrc === 'deposit');
check('have: no article', ca('does Ann Lee have renewal in their lease')?.topicSrc === 'renewal');
check('there: "is there a retainer clause in X\'s agreement"', ca("is there a retainer clause in Ann Lee's agreement")?.mode === 'yesno');
check('part of: "are late fees part of X\'s agreement"', ca("are late fees part of Ann Lee's agreement")?.topicSrc === 'late fees');
check('bare: "warranty in X\'s agreement"', ca("warranty in Ann Lee's agreement")?.topicSrc === 'warranty');
check('how long: "how long is the warranty in X\'s lease"', ca("how long is the warranty in Ann Lee's lease")?.topicSrc === 'warranty');
check('read me: "read me the insurance part of X\'s agreement"', ca("read me the insurance part of Ann Lee's agreement")?.topicSrc === 'insurance');
check('whats: "whats the governing law in the contract with X"', ca('whats the governing law in the contract with Ann Lee')?.topicSrc === 'governing law');
check('payment terms on invoice N', ca('payment terms on invoice INV-1459')?.topicSrc === 'payment terms');
check('a plain field is not a clause ask', ca('what is the address on the lease for Ann Lee') === null && ca('total in the invoice for Ann Lee') === null);
check('readerShaped sees the new phrasings', readerShaped("is there a retainer clause in Ann Lee's agreement") && readerShaped('does Ann Lee have deposit in their lease'));

const feat = (raw, over = {}) => ({ raw, filters: [{ field: 'customer', role: 'customer', value: 'Ann Lee' }], docTypes: ['lease-agreement'], docWord: 'lease', times: [], time: null, ...over });
check('analyze: possessive clause ask becomes read_span', _analyze(feat("is there a retainer clause in Ann Lee's lease"))?.op === 'read_span');
check('analyze: have-in-their ask is a yes/no read', _analyze(feat('does Ann Lee have deposit in their lease'))?.mode === 'yesno');
check('analyze: invoice number + payment terms', _analyze({ ...feat('payment terms on invoice INV-1459'), filters: [], docTypes: ['invoice'], docWord: 'invoice' })?.code === 'INV-1459');
const day = { field: 'date', from: '2023-07-08', to: '2023-07-08', label: 'July 8, 2023' };
check('analyze: one exact day picks the paper', _analyze(feat('what does the lease for Ann Lee dated 8 July 2023 say about termination', { time: day, times: [day] }))?.time?.from === '2023-07-08');
check('analyze: a period is not a single paper', _analyze(feat('what does the lease for Ann Lee in 2023 say about termination', { time: { ...day, to: '2023-12-31' }, times: [{ ...day, to: '2023-12-31' }] })) === null);

check('readerTopicAsk: a topic ask yes, "what does line 1 say" no', readerTopicAsk('does the lease for Ann Lee mention renewal') && !readerTopicAsk('what does line 1 of invoice INV-20003 say'));

// ---- follow-ups stay on the paper
const t1 = [{ question: 'what does the lease for Joyce Ward say about termination' }];
check('follow-up: who signed it', readerFollowup(t1, 'who signed it')?.query === 'who signed the lease for Joyce Ward');
check('follow-up: and what about late fees', readerFollowup(t1, 'and what about late fees')?.query === 'what does the lease for Joyce Ward say about late fees');
check('follow-up: which page is that on', readerFollowup(t1, 'which page is that on')?.query === t1[0].question);
check('follow-up: after a follow-up, the source ask rebuilds it', readerFollowup([...t1, { question: 'who signed it' }], 'where did that come from')?.query === 'who signed the lease for Joyce Ward');
check('follow-up: have-in-their prior', readerFollowup([{ question: 'does Joyce Ward have deposit in their lease' }], 'who signed it')?.query === 'who signed the lease for Joyce Ward');
check('follow-up: a count prior is left alone', readerFollowup([{ question: 'how many invoices in 2022' }], 'who signed it') === null);
check('paperOf: the paper in its own words', paperOf('does the agreement for Ann Lee mention renewal') === 'the agreement for Ann Lee');

// ---- the reader still releases what the paper does not state, and reads "payment terms" from a due line
const pg = (text) => ({ docId: 'd1', filename: 'f.pdf', page: 1, text });
check('payment terms read from "Payment is due net 30 days"', readPages(topicOf('payment terms', []).concepts, [pg('Beer should be served within 86 days.\nPayment is due net 30 days; kegs remain brewery property.\nKeg deposit is $45 per half barrel.')]).ok);
check('a topic the paper never states is released', !readPages(topicOf('renewal', []).concepts, [pg('Keg deposit is $45 per half barrel.\nPayment is due net 30 days.')]).ok);

// ---- wiring: a reader question has no older fall-through (never a count), and the records lane does not dump the customer
const arb = fs.readFileSync(path.join(ROOT, 'api/_lib/router/classifyAll.js'), 'utf8');
check('router: a read_span claim drops the older fall-through lanes', /intent\.plan\?\.nth \|\| intent\.plan\?\.op === "read_span"/.test(arb));
const lane = fs.readFileSync(path.join(ROOT, 'api/_lib/records/lane.js'), 'utf8');
check('records lane: a reader question is not answered with everything stored', /SUBJECT_FOUND_SKIPS\.has\(r\.skip\) && readerTopicAsk\(question\)/.test(lane));
const top = fs.readdirSync(path.join(ROOT, 'api')).filter((f) => fs.statSync(path.join(ROOT, 'api', f)).isFile());
check('api/ keeps 12 top-level files', top.length === 12, String(top.length));
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
