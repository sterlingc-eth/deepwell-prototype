#!/usr/bin/env node
/**
 * Round 2 (B1) — follow-up slot carry-over (api/_lib/followup/slots.js).
 * Pure: resolveFollowup / slotRewrite only, no DB, no model.
 *   node scripts/verify-followup-slots.mjs
 */
import { resolveFollowup, slotRewrite } from '../api/_lib/followup/index.js';
import { isFollowupContinuation } from '../api/_lib/conversation.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) pass++; else { fail++; console.log('FAIL', name, extra); } };
const rw = (prior, q, ent) => resolveFollowup({ turns: [{ question: prior, ...(ent ? { resolvedEntities: ent } : {}) }] }, q);
const eq = (name, prior, q, want, ent) => { const r = rw(prior, q, ent); ok(name, r.kind === 'slot' && r.query === want, `got ${r.kind} | ${r.query}`); };
const none = (name, prior, q, ent) => { const r = rw(prior, q, ent); ok(name, r.kind !== 'slot', `rewrote to ${r.query}`); };

// period
eq('year swap', 'how many invoices in 2023', 'and in 2022?', 'how many invoices in 2022?');
eq('year swap no lead-in verb', 'how many proposals did we send in 2024', 'what about 2025', 'how many proposals did we send in 2025?');
eq('year swap on total', 'total billed in 2022', 'and 2023?', 'total billed in 2023?');
eq('quarter swap keeps year', 'how many invoices came in Q1 2025', 'and Q3?', 'how many invoices came in Q3 2025?');
eq('second half keeps year', 'how many tickets in the first half of 2026', 'and the second half?', 'how many tickets from July through December 2026?');
eq('bare year keeps the quarter', 'how many invoices in Q2 2025', 'and 2024?', 'how many invoices in Q2 2024?');
// person
eq('tech swap', 'how many invoices did Denise Ford write', 'and Marisol Vega?', 'how many invoices did Marisol Vega write?');
eq('tech swap same for', 'how many service tickets did Danny Ochoa handle', 'same for Wyatt Coburn', 'how many service tickets did Wyatt Coburn handle?');
// city / brand / doc type / threshold
eq('city swap', 'how many customers do we have in Tucson', 'and Gilbert?', 'how many customers do we have in Gilbert?');
eq('city swap what about', 'how many customers are in Phoenix', 'what about Scottsdale', 'how many customers are in Scottsdale?');
eq('brand swap', 'how many Rheem units do we have', 'and Lennox?', 'how many Lennox units do we have?');
eq('doc type swap', 'how many permits do we have', 'and dispatch notes?', 'how many dispatch notes do we have?');
eq('doc type swap restated measure', 'how many inspection reports are there', 'how many work orders?', 'how many work orders are there?');
eq('threshold swap', 'how many invoices were over $4000', 'and over $7000?', 'how many invoices were over $7000?');
eq('threshold comparator swap', 'how many invoices were over $4000', 'and under $2000?', 'how many invoices were under $2000?');
// measure
eq('count to total', 'how many invoices did we do in 2025', 'and the total?', 'what is the total of invoices in 2025?');
eq('count to total dollar', 'how many proposals in 2026', "and what's the dollar total?", 'what is the total of proposals in 2026?');
eq('count to total keeps threshold', 'how many invoices were over $4000', 'and the total?', 'what is the total of invoices over $4000?');
eq('count to average', 'how many invoices in 2025', 'and the average?', 'what is the average of invoices in 2025?');
eq('total to count', 'total billed in 2022', 'and how many?', 'how many invoices in 2022?');
eq('average to biggest', 'average invoice amount', "what's the biggest?", 'biggest invoice amount?');
eq('list to count', 'which customers are in Marana', 'how many is that', 'how many customers are in Marana?');
eq('most to count via entity', 'who has the most invoices', 'how many is that?', 'how many invoices does Ray Sutton have?', [{ type: 'customer', id: '11111111-1111-1111-1111-111111111111', label: 'Ray Sutton' }]);
// field of same record
eq('record field: date', 'what did invoice INV-20100 come to', 'what day was it issued', 'what is the date of invoice INV-20100?');
eq('record field: customer', 'invoice INV-20079 amount', 'whose job was that?', 'whose job was invoice INV-20079?');
eq('record field: total', 'which customer is invoice INV-20102 for', 'and how much was it?', 'how much was invoice INV-20102?');
eq('contact field, other wording', 'phone number for Kenneth Fenwick', 'and where do they live', 'what is the address for Kenneth Fenwick?');

// relative periods resolve against the prior period
eq('previous year', 'how many invoices in 2025', 'and the previous year?', 'how many invoices in 2024?');
eq('last year', 'how many invoices in 2025', 'and last year?', 'how many invoices in 2024?');
eq('next year', 'how many invoices in 2025', 'and next year?', 'how many invoices in 2026?');
eq('year before', 'how many invoices in 2025', 'and the year before?', 'how many invoices in 2024?');
eq('previous quarter wraps', 'how many invoices in Q1 2025', 'and the previous quarter?', 'how many invoices in Q4 2024?');
eq('next month', 'how many invoices in March 2025', 'and next month?', 'how many invoices in April 2025?');
none('relative word unresolvable (this year)', 'how many invoices in 2025', 'and this year?');
none('relative unit mismatch', 'how many invoices in 2025', 'and last month?');
none('previous month without a year across a wrap', 'how many invoices in January', 'and the previous month?');
// negation is never inherited silently
none('negated prior', 'how many invoices not from 2025', 'and 2024?');
eq('negated both', 'how many invoices not from 2025', 'and not 2024?', 'how many invoices not from 2024?');
// month stays visible
eq('month kept visible', 'how many invoices in March', 'and 2024?', 'how many invoices in March 2024?');

// must NOT rewrite
none('two candidate slots in the follow-up', 'how many invoices in 2023', 'and Lennox in 2022?');
none('two candidate periods in the prior', 'how many invoices between 2022 and 2023', 'and 2024?');
none('two people in the prior', 'how many invoices did Denise Ford write for Ray Sutton', 'and Marisol Vega?');
none('prior lacks the slot (never invent scope)', 'how many invoices do we have', 'and in 2022?');
none('prior lacks a person', 'how many invoices in 2023', 'and Marisol Vega?');
none('long fresh sentence starting with and', 'how many invoices in 2023', 'and while you are at it can you tell me how many proposals we sent to people in Mesa last year');
none('restated measure with other prior slots', 'how many invoices in 2023', 'how many proposals?');
none('different measure plus new slot', 'how many invoices in 2023', 'and the total in 2022?');
none('unexplained words', 'how many invoices in 2023', 'and the weather in 2022?');
none('who-most without a single entity', 'who has the most invoices', 'how many is that?');
none('technician of a numbered document is left as typed', 'what did invoice INV-20033 come to', 'who was the technician');
none('measure the prior cannot be re-asked', 'which customers are in Marana', 'and the total?');
none('count to total with an unexplained prior verb', 'how many invoices did Denise Ford write', 'and the total?');
none('ordinary pronoun follow-up is untouched', 'phone for Jason Zamora', 'and the email?');
none('fresh question with its own scope', 'how many invoices in 2023', 'how many proposals in 2022?');
// R3 (F2): total of that, the other end of a ranking, a service-type qualifier
eq('what did that come to', 'how many invoices in 2025', 'what did that come to', 'what is the total of invoices in 2025?');
eq('what does that add up to', 'how many proposals in 2024', 'and what does that add up to?', 'what is the total of proposals in 2024?');
none('total of a count of non-money documents', 'how many service tickets in 2024', 'what did that come to');
none('total of a count with a threshold', 'how many invoices over $4000', 'what did that come to');
none('total of a count with a person', 'how many invoices did Denise Ford write', 'what did that come to');
none('total after a non-count prior', 'which customers are in Marana', 'what did that come to');
eq('the fewest', 'who wrote the most invoices', 'and the fewest?', 'who wrote the fewest invoices?');
eq('the lowest', 'which customer has the highest balance', 'and the lowest?', 'which customer has the lowest balance?');
none('same end of the ranking again', 'who wrote the most invoices', 'and the most?');
none('superlative with no ranking in the prior', 'how many invoices in 2025', 'and the fewest?');
none('superlative against a prior with two', 'who has the most or fewest invoices', 'and the least?');
eq('only the repair ones', 'how many service tickets in 2024', 'only the repair ones', 'how many repair tickets in 2024?');
eq('just the repair ones, no period', 'how many service tickets do we have', 'just the repair ones', 'how many repair tickets?');
none('qualifier that is not a known service type', 'how many service tickets in 2024', 'only the urgent ones');
none('qualifier on a prior that is not tickets', 'how many invoices in 2024', 'only the repair ones');
none('qualifier on a prior with a city', 'how many service tickets in Mesa', 'only the repair ones');

ok('slotRewrite is pure on junk', slotRewrite('', '') === null && slotRewrite(null, undefined) === null);

// continuation gate used by api/ask.js
ok('ask.js gate sees slot follow-up', isFollowupContinuation('and in 2022?', { turns: [{ question: 'how many invoices in 2023' }] }) === true);
ok('ask.js gate ignores fresh', isFollowupContinuation('how many invoices in 2022?', { turns: [{ question: 'how many invoices in 2023' }] }) === false);

// chain
{
  const r = resolveFollowup({ turns: [{ question: 'how many invoices in 2023' }, { question: 'and in 2022?' }] }, 'and 2021?');
  ok('chain', r.kind === 'slot' && r.query === 'how many invoices in 2021?', r.query);
}

console.log(`verify:followup-slots ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
