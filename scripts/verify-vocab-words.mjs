/**
 * Vocabulary round 1 (B2): everyday words for document types and people, derived from the type slugs plus a few noun classes.
 *   node scripts/verify-vocab-words.mjs
 */
delete process.env.ANTHROPIC_API_KEY;
console.warn = () => {};
let fails = 0, passes = 0;
const check = (name, ok, detail = '') => { if (ok) passes++; else fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`); };

const { DOCUMENT_TYPE_SYNONYMS_ALL: DOCUMENT_TYPE_SYNONYMS, docTypeFromWord, DOCTYPE_TRIGGER_WORDS } = await import('../api/_lib/documentTypes.js');
const { canonicalizeWordClasses } = await import('../api/_lib/lookups/lexicon.js');
const { detectAnalyticsPlan } = await import('../api/_lib/analytics/detPlan.js');
const canon = canonicalizeWordClasses;

// derived aliases from slugs
for (const [w, id] of [['dispatch ticket', 'dispatch-note'], ['dispatch tickets', 'dispatch-note'], ['nameplate pics', 'nameplate-photo'], ['nameplate picture', 'nameplate-photo'],
  ['inspection form', 'inspection-report'], ['inspections', 'inspection-report'], ['startup form', 'startup-sheet'], ['maintenance program', 'maintenance-agreement']])
  check(`alias "${w}" -> ${id}`, docTypeFromWord(w) === id, `got ${docTypeFromWord(w)}`);
// hand-written mappings win: the most specific type is kept
check('"service ticket" stays a service ticket', docTypeFromWord('service ticket') === 'service-ticket');
check('"work order" stays a work order', docTypeFromWord('work order') === 'work-order');
check('generic modifiers are not bare aliases', docTypeFromWord('service') === null && docTypeFromWord('work') === null && docTypeFromWord('price') === null);
check('derived aliases do not feed typo-correction targets', !DOCTYPE_TRIGGER_WORDS.includes('pics'));
check('every derived phrase maps to exactly one type', (() => { const seen = new Map(); for (const [id, ws] of Object.entries(DOCUMENT_TYPE_SYNONYMS)) for (const w of ws) { if (seen.has(w) && seen.get(w) !== id) return false; seen.set(w, id); } return true; })());

// respelling
const eq = (q, want) => check(`"${q}" -> "${want}"`, canon(q) === want, `got "${canon(q)}"`);
eq('count of dispatch tickets', 'count of dispatch notes');
eq('how many nameplate pics do we have', 'how many nameplate photos do we have');
eq('how many inspections have been done', 'how many inspection reports have been done');
eq("who's our busiest serviceman", "who's our busiest technician");
eq('how many vendor POs', 'how many purchase orders');
eq('how many bills did we send out in 2023', 'how many invoices did we send out in 2023');
eq('how many bills do we have', 'how many bills do we have');
eq('what bills are due', 'what bills are due');
eq('how many overdue bills', 'how many overdue bills');
eq('total of contracts with Linda Fitzgerald', 'total of maintenance agreements with Linda Fitzgerald');
eq('total value of contracts signed in 2025', 'total value of maintenance agreements signed in 2025');
eq('total of all our contracts in Mesa', 'total of all our maintenance agreements in Mesa');
eq('how many condensers/units are in the system', 'how many condensers units are in the system');
eq('total of all our service agreements', 'total agreement fees');
eq('total number of agreements', 'total number of agreements');
eq('when does Acme Co service agreement run through', 'when does Acme Co service agreement expire');
eq('service tickets so far this month', 'service tickets this month');
eq('warranty registrations in the past 30 days?', 'how many warranty registrations in the past 30 days?');
eq('did we pull any permits in 2026, how many', 'how many permits in 2026');
// things that must NOT be respelled
eq('who dispatches the techs', 'who dispatches the technicians');
eq('what is our electric bills total', 'what is our electric bills total');
eq('how many bill of lading', 'how many bill of lading');
eq('is the POS system down', 'is the POS system down');
eq('inspections report', 'inspections report');
eq('and/or', 'and/or');
eq('runs through 2027', 'runs through 2027');

// the number-one parse bug: an auxiliary is never a technician's name
const plan = detectAnalyticsPlan('how many inspection reports have been done', undefined, '2026-10-07');
check('"have been done" does not read "Been" as a technician', !JSON.stringify(plan ?? {}).includes('"technician"'), JSON.stringify(plan));
const plan2 = detectAnalyticsPlan('how many jobs has Kevin Pratt done', undefined, '2026-10-07');
check('a real technician name still parses', JSON.stringify(plan2 ?? {}).includes('Kevin Pratt'), JSON.stringify(plan2));

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
