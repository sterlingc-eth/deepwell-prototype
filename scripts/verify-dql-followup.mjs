/**
 * verify:dql-followup - the follow-up merge for the Donovan query engine (api/_lib/followup/dqlmerge.js) on the golden export.
 *
 * A follow-up ("and Chandler?", "what about 2024", "only the repair ones", "by month", "list them", "make it top 3") becomes a standalone
 * question. Every positive case checks that the merged question (a) reads exactly like the question the person meant, and (b) is explained
 * by the DQL parser to the SAME plan as that question typed out in full, and (c) where the engine answers it, gives the same answer.
 * Releases are checked too: an uncertain merge (two candidates, an unexplained word, a negation, a bare fragment, a name that cannot be
 * located) leaves the follow-up exactly as typed, and a new customer never inherits the old one.
 *
 *   node scripts/verify-dql-followup.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0; let passes = 0;
const check = (name, ok, detail = '') => { if (ok) passes++; else failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${String(detail).slice(0, 400)}`}`); };

delete process.env.ANTHROPIC_API_KEY;
delete process.env.DONOVAN_DQL;
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && /^\{"/.test(a[0])) return; realLog(...a); };
console.warn = () => {}; console.error = () => {};

const off = await import('./offline-exam.mjs');
await off.installPgHarness(); await off.installModelBlock();
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/golden/golden-export.json'), 'utf8'));
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const ctx = (await off.loadExportIntoNewTenant(lite, data, { tenantKey: 'offline:dqlfu', tenantName: 'dqlfu' })).ctx;
const { withTenant } = await import('../api/_lib/recordsStore.js');
const { getTenantVocab } = await import('../api/_lib/vocab/tenantVocab.js');
const { packForTenant } = await import('../api/_lib/industry/index.js');
const { parseDql, runDql } = await import('../api/_lib/dql/index.js');
const { composeFollowup, isFollowupContinuation, validateConversationContext } = await import('../api/_lib/conversation.js');
const { dqlMergeRewrite } = await import('../api/_lib/followup/dqlmerge.js');

const TODAY = '2026-10-07';
const ctxArg = { tenantKey: ctx.tenantKey, tenantName: 'dqlfu' };
const pack = await packForTenant({ withTenant, ctxArg });
const tv = await withTenant(ctxArg, (db) => getTenantVocab(db, ctx.tenantKey, pack));
const customers = data.entities.filter((e) => e.entity_type === 'customer').map((e) => e.data.customer_name);
const [A, B, C] = [customers[0], customers[1], customers[3]];

const norm = (s) => String(s).toLowerCase().replace(/[?.!]+$/g, '').replace(/\s+/g, ' ').trim();
const turns = (...qs) => validateConversationContext({ turns: qs.map((question) => ({ question })) });
const merge = (prior, follow) => {
  const c = turns(prior);
  return { cont: isFollowupContinuation(follow, c), query: composeFollowup(c, follow).query };
};
async function answer(q) {
  const intent = parseDql(q, { tenantVocab: tv, pack, today: TODAY });
  if (!intent) return { intent: null, text: null };
  const out = await withTenant(ctxArg, (db) => runDql(db, intent, { today: TODAY }));
  return { intent, text: out?.text ?? null };
}

/* ================================================================== positives: the merge reads like the question meant, and DQL explains it the same */
const POS = [
  // slot swaps
  ['how many invoices in 2024', 'and 2023?', 'how many invoices in 2023'],
  ['total invoiced in 2025', 'what about 2024', 'total invoiced in 2024'],
  ['service tickets in 2024', 'and 2023', 'service tickets in 2023'],
  ['how many invoices does ' + A + ' have', 'and ' + B + '?', 'how many invoices does ' + B + ' have'],
  ['how much have we billed ' + A, 'same for ' + C, 'how much have we billed ' + C],
  ['how many customers in Mesa', 'and Gilbert?', 'how many customers in Gilbert'],
  ['how many Trane units do we have', 'and Carrier?', 'how many Carrier units do we have'],
  ['service tickets in the last 30 days', 'what about the last 90', 'service tickets in the last 90 days'],
  ['how many units are older than 15 years', 'now 20', 'how many units are older than 20 years'],
  ['how many invoices in 2024', 'and in March', 'how many invoices in March 2024'],
  // narrowing: a slot the prior lacks
  ['how many units are older than 15 years', 'just the Mesa ones', 'how many units are older than 15 years in Mesa'],
  // operator changes
  ['how many customers in Mesa', 'list them', 'list customers in Mesa'],
  ['list all tenants in Mesa', 'how many', 'how many tenants in Mesa'],
  ['show me the latest 5 invoices', 'show 10 instead', 'show me the latest 10 invoices'],
  ['top 5 customers by invoiced total', 'make it top 3', 'top 3 customers by invoiced total'],
  ['average invoice in 2026', 'and median', 'median invoice in 2026'],
  ['smallest invoice we ever sent', 'hey and the biggest', 'biggest invoice we ever sent'],
  ['how many Trane units do we have', 'average age', 'average age of Trane units'],
  ['installs per year', 'just Mesa', 'installs per year for Mesa'],
  // the sets family now explains this merged text (a customer set with a service-visit condition and a city)
  ['customers not serviced since 2024', 'which of those are in Casa Grande', 'customers not serviced since 2024 in Casa Grande'],
];
for (const [prior, follow, intended] of POS) {
  const m = merge(prior, follow);
  const same = norm(m.query) === norm(intended);
  check(`merge :: "${prior}" + "${follow}"`, m.cont && same, `got "${m.query}" want "${intended}"`);
  const a = parseDql(m.query, { tenantVocab: tv, pack, today: TODAY });
  const b = parseDql(intended, { tenantVocab: tv, pack, today: TODAY });
  check(`  plan :: same plan as the full question`, JSON.stringify(a?.plan ?? null) === JSON.stringify(b?.plan ?? null), JSON.stringify([a?.plan, b?.plan]));
  if (b) {
    const ra = await answer(m.query); const rb = await answer(intended);
    check(`  answer :: same answer as the full question`, ra.text === rb.text, JSON.stringify([ra.text, rb.text]));
  }
}

/* ================================================================== a new customer never inherits the old one */
{
  const m = merge('how much have we billed ' + A, 'ok now ' + B);
  check('stale :: the old customer is cut out of the merged question', !m.query.includes(A) && m.query.includes(B), m.query);
  const m2 = merge('what is the phone number for ' + A, 'and for ' + B + '?');
  check('stale :: a swap in a contact question', !m2.query.includes(A) && m2.query.includes(B), m2.query);
  const m3 = merge('how many units does Sunrise Valley Elementary School have', 'what about Holy Trinity Church?');
  check('stale :: a long business name leaves no half of the old name behind', !/Sunrise|Valley|Elementary|School/.test(m3.query) && /Holy Trinity Church/.test(m3.query), m3.query);
  const withEntity = validateConversationContext({ turns: [{ question: 'how many invoices does ' + A + ' have', resolvedEntities: [{ type: 'customer', id: '00000000-0000-4000-8000-000000000001', label: A }] }] });
  const q = composeFollowup(withEntity, 'and ' + B + '?').query;
  check('stale :: the resolved entity of the earlier answer does not come back', !q.includes(A) && q.includes(B), q);
  const two = merge('compare ' + A + ' and ' + B, 'and ' + C + '?');
  check('stale :: two names in the prior is uncertain, so the follow-up is left as typed', !two.query.includes(A) && !two.query.includes(B), two.query);
}

/* ================================================================== releases */
const REL = [
  ['how many quotes turned into an invoice', 'just from this year'],   // a word nothing explains in the prior
  ['units older than 12 years', 'excluding York'],                     // a negation in the follow-up
  ['how many invoices in 2024', 'how many are paid'],                  // payment status is not tracked
  ['and April?', 'same thing for 2024'],                               // the prior is itself a bare fragment
  ['customers in Mesa and Gilbert', 'and Chandler?'],                  // two places in the prior
  ['how many invoices in 2024', 'what was it for'],                    // nothing to merge, only a pronoun
  ['average age by brand', 'by city instead'],                         // the engine does not group that by city
  ['how many units are older than 15 years', 'and which brands'],      // a grouped lane would drop the age condition
  ['how many agreements expire this year', 'and next year?'],          // two readings from today
  ['top 3 customers by billed amount', 'and Betty?'],                  // a partial name is a question, not a swap
  ['how many customers have no phone number', 'are any of them businesses'], // a pronoun with no plain scope
  ['how many units do we have in Gilbert', 'how many are Rheem'],      // adding a brand: measured to lose conditions in the lanes that read it
  ['how many tickets did Kevin Pratt do', 'only repairs'],             // adding a service type: same
  ['list estimates from 2026', 'only the ones over $3000'],            // adding a threshold: same
  ['how many R-410A units', 'how many of those are over 10 years'],    // adding an age: same
  ['top 5 customers by revenue', 'just this year'],                    // adding a period: same
  ['units older than 12 years', 'only trane'],
  ['total labor hours in 2025', 'break that down by technician'],      // grouping a question: the grouped lanes drop conditions
  ['how many units were installed in 2024', 'which brands were those'],
  ['how many invoices does ' + A + ' have', 'ok now ' + B.toLowerCase()], // a lower-case name is not guessed at
];
for (const [prior, follow] of REL) {
  const r = dqlMergeRewrite(prior, follow);
  check(`release :: "${prior}" + "${follow}"`, r === null, r?.query);
}

/* ================================================================== the merge is pure and bounded */
check('pure :: an empty follow-up releases', dqlMergeRewrite('how many invoices in 2024', '') === null);
check('pure :: a very long follow-up releases', dqlMergeRewrite('how many invoices in 2024', 'and '.repeat(80) + '2023') === null);
check('pure :: a follow-up that merges to the prior itself releases', dqlMergeRewrite('how many invoices in 2024', 'and 2024?') === null);

/* ================================================================== the hand-off to the router */
{
  const { isMerged, isReleased } = await import('../api/_lib/followup/handoff.js');
  const q = composeFollowup(turns('how many customers are on a maintenance agreement'), 'list them').query;
  check('hand-off :: a merged follow-up is marked, so DQL (not an older lane that drops a condition) answers it', isMerged(q), q);
  const q2 = composeFollowup(turns('how many customers have no phone number'), 'are any of them businesses').query;
  check('hand-off :: a pronoun with no safe referent is marked released, so no lane answers it', isReleased(q2), q2);
  const q3 = composeFollowup(turns('warranties expiring in 2027'), 'how many are Trane').query;
  check('hand-off :: a fragment with no subject of its own carries the earlier question and is released', isReleased(q3) && /warranties expiring in 2027/.test(q3), q3);
  check('hand-off :: an ordinary question is not marked', !isMerged('how many invoices in 2031') && !isReleased('how many invoices in 2031'));
}

console.log(`\nverify:dql-followup ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
