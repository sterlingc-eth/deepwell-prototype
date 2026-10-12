/**
 * verify:convo-r17 - follow-ups for any company (api/_lib/followup/convo.js, wired through dqlMergeRewrite).
 * A follow-up carries the previous scope and adds or replaces exactly what the new turn says; anything uncertain is released (null).
 *   node scripts/verify-convo-r17.mjs
 */
import { dqlMergeRewrite, dqlMergeFollowup } from '../api/_lib/followup/dqlmerge.js';
import { convoRewrite } from '../api/_lib/followup/convo.js';

let failures = 0; let passes = 0;
const check = (name, ok, detail = '') => { if (ok) passes++; else failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${String(detail).slice(0, 300)}`}`); };
const q = (p, f) => dqlMergeRewrite(p, f)?.query ?? null;

// another measure of the same scope, with a company's own words
check('count -> total', q('how many invoices for Smith', 'what was the total') === 'what is the total amount of invoices for Smith?', q('how many invoices for Smith', 'what was the total'));
check('count -> average', /^what is the average amount of pledge cards in 2023\?$/.test(q('how many pledge cards in 2023', 'and on average?') ?? ''));
check('count -> list names', q('Total number of tenants in Peoria', 'whcih ones - names please?') === 'list tenants in Peoria?' && q('how many invoices in Tucson for 2023', 'which ones - names please') === 'list customers with invoices in Tucson for 2023?');
check('trailing count phrase', q('tenant charges for paul carr - how many', 'How much was that year altogether?') === 'what is the total amount of tenant charges for paul carr?');
check('which customers after a count of papers releases', q('figure out how many rate cons belonging to Saguaro Beverage', 'Can u tell me which custs right now?') === null);
check('which supporters after a count of people', q('give me a count of the supporters in boulder', 'Can you tell me which supporters? right now?') === 'list supporters in boulder?');
check('give me the number of: lead peeled', q('Give me the number of invoices for accounts located in Boulder City', 'Which ones were they?') === 'list invoices for accounts located in Boulder City?');
check('did we get: released', q('How many work orders did we get Judith George worked on during 2022?', 'Which ones - names please') === null);
// one more condition
check('threshold added', /3 months over \$650\?$/.test(q('fuel receipt paperwork ordered in the last 3 months', 'only over $650 according to the files') ?? ''));
check('named scope released', q('what is the count of invoices of Neon Medical Centre', 'And in 2024?') === null);
check('unresolved prior released', q('AND HOW MANY WORK ORDERS IS THAT IF IT IS IN THERE', 'when was their last work order') === null);
check('part-of released', q("what's our average invoice amount?", 'how much of that is tax') === null);
check('ordering released', q('how many units are older than 15 years', 'list them oldest first') === null);
check('clause scope released', q('how many agreements expire this year?', 'who are they') === null);
check('comparison released', q('how many docs are from 2026', 'is that more than 2025') === null);
check('value narrowed', /Tucson\?$/.test(q('Hey, back in 2024, what is the min freight bill', 'tucson only, it is bugging me') ?? ''));
check('lead-in prior still merges', q('Hey, how many pledge cards in 2023', 'which ones - names please') === 'list customers with pledge cards in 2023?');
// releases
check('release: negation', q('how many invoices for Smith', 'what was the total except Jones') === null);
check('release: extra condition word', convoRewrite('how many invoices for Smith', 'total for Jones', {}) === null);
check('release: same measure', q('how many invoices for Smith', 'how many?') === null);
check('release: ranked prior', q('what is the biggest invoice for Smith', 'and the average') !== 'what is the average amount of invoice for Smith?');
check('release: bare fragment prior', q('and in 2022', 'what was the total') === null);
check('chain of two turns', dqlMergeFollowup([{ question: 'how many invoices for Smith' }, { question: 'and in 2022?' }], 'what was the total')?.query != null);
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
