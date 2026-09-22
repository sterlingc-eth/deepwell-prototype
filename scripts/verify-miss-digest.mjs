/**
 * Unit checks for the Donovan miss digest, Tier 1 of the self-learning loop
 * (handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md, api/_lib/missDigest.js).
 * Pure functions only — no DB, no network, no Clerk, matching
 * scripts/verify-notify.mjs's own style for the sibling engine this reuses
 * (email path, tenants.settings idiom).
 *
 *   node scripts/verify-miss-digest.mjs
 */
import {
  redactPII,
  parseCsvEnv,
  parseOwnerAlertEmails,
  isPlatformOperator,
  buildDigestFromRows,
  renderMissDigestEmail,
  shouldRunDigestToday,
  TOP_QUESTIONS_LIMIT,
} from '../api/_lib/missDigest.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* ------------------------------------------------------------- redaction */

eq('redactPII: strips an email address', redactPII('call me at jsmith@example.com please'), 'call me at [redacted-email] please');
eq('redactPII: strips a 10-digit phone, dashed', redactPII('reach 602-555-0134 today'), 'reach [redacted-phone] today');
eq('redactPII: strips a 10-digit phone, parens+space', redactPII('call (602) 555 0134'), 'call [redacted-phone]');
eq('redactPII: strips a leading-+1 phone', redactPII('+1 602-555-0134'), '[redacted-phone]');
eq('redactPII: strips both in one string', redactPII('email jsmith@example.com or call 6025550134'), 'email [redacted-email] or call [redacted-phone]');
eq('redactPII: leaves ordinary text alone', redactPII('how many customers in maricopa county'), 'how many customers in maricopa county');
eq('redactPII: null/undefined -> empty string, never throws', redactPII(undefined), '');

/* --------------------------------------------------------------- env csv */

eq('parseCsvEnv: splits, trims, drops blanks', parseCsvEnv(' a@x.com, b@x.com ,, c@x.com'), ['a@x.com', 'b@x.com', 'c@x.com']);
eq('parseCsvEnv: unset -> empty array, never throws', parseCsvEnv(undefined), []);
eq('parseOwnerAlertEmails: drops junk, caps at 10, same as capRecipients', parseOwnerAlertEmails('ok@x.com, not-an-email, OK@x.com'), ['ok@x.com']);

/* ----------------------------------------------------------- operator gate */

{
  const originalFounder = process.env.DEEPWELL_FOUNDER_TENANT_ID;
  const originalOperators = process.env.DEEPWELL_OPERATOR_USER_IDS;
  process.env.DEEPWELL_FOUNDER_TENANT_ID = 'org_founder';
  process.env.DEEPWELL_OPERATOR_USER_IDS = 'user_abc, user_def';

  check('isPlatformOperator: founder tenant matches -> true', isPlatformOperator({ tenantId: 'org_founder', userId: 'user_zzz' }));
  check('isPlatformOperator: listed operator user id -> true even in a different tenant', isPlatformOperator({ tenantId: 'org_other', userId: 'user_abc' }));
  check('isPlatformOperator: ordinary tenant admin, not listed -> false', !isPlatformOperator({ tenantId: 'org_other', userId: 'user_zzz' }));
  check('isPlatformOperator: no auth at all -> false, never throws', !isPlatformOperator(null) && !isPlatformOperator(undefined));

  delete process.env.DEEPWELL_FOUNDER_TENANT_ID;
  delete process.env.DEEPWELL_OPERATOR_USER_IDS;
  check('isPlatformOperator: neither env var set -> false for everyone', !isPlatformOperator({ tenantId: 'org_founder', userId: 'user_abc' }));

  if (originalFounder !== undefined) process.env.DEEPWELL_FOUNDER_TENANT_ID = originalFounder;
  else delete process.env.DEEPWELL_FOUNDER_TENANT_ID;
  if (originalOperators !== undefined) process.env.DEEPWELL_OPERATOR_USER_IDS = originalOperators;
  else delete process.env.DEEPWELL_OPERATOR_USER_IDS;
}

/* -------------------------------------------------------- once-per-day guard */

check('shouldRunDigestToday: no prior run -> true', shouldRunDigestToday(null, '2026-09-22'));
check('shouldRunDigestToday: already ran today -> false', !shouldRunDigestToday('2026-09-22', '2026-09-22'));
check('shouldRunDigestToday: ran yesterday, new UTC day -> true', shouldRunDigestToday('2026-09-21', '2026-09-22'));

/* --------------------------------------------------------- grouping/aggregation */

function row(tenant, outcome, question, count, first, last, conditions = []) {
  return { tenant_id: tenant, outcome, question_normalized: question, detected_conditions: conditions, count, first_seen: first, last_seen: last };
}

{
  // Same question asked by two different tenants under the same outcome:
  // counts sum, tenantCount is 2, not seen before -> isNew.
  const currentRows = [
    row('tenant-a', 'no-answer', 'how many customers in maricopa', 3, '2026-09-22T01:00:00Z', '2026-09-22T02:00:00Z'),
    row('tenant-b', 'no-answer', 'how many customers in maricopa', 2, '2026-09-22T03:00:00Z', '2026-09-22T04:00:00Z'),
  ];
  const digest = buildDigestFromRows({ currentRows, priorRows: [], since: '2026-09-21T00:00:00Z', now: '2026-09-22T05:00:00Z' });

  eq('buildDigestFromRows: totals.totalMisses sums across tenants', digest.totals.totalMisses, 5);
  eq('buildDigestFromRows: totals.totalTenants counts distinct tenants', digest.totals.totalTenants, 2);
  eq('buildDigestFromRows: totals.totalQuestions is 1 distinct question', digest.totals.totalQuestions, 1);
  eq('buildDigestFromRows: one outcome group with the merged count', digest.groups.length, 1);
  eq('buildDigestFromRows: group.questions[0].tenantCount is 2', digest.groups[0].questions[0].tenantCount, 2);
  check('buildDigestFromRows: question is flagged isNew (no prior rows)', digest.groups[0].questions[0].isNew);
  eq('buildDigestFromRows: totals.newQuestionsCount is 1', digest.totals.newQuestionsCount, 1);
  eq('buildDigestFromRows: topQuestions carries the same merged question', digest.topQuestions[0].count, 5);
  eq('buildDigestFromRows: topQuestions[0].tenantCount is 2', digest.topQuestions[0].tenantCount, 2);
}

{
  // Same question seen in the prior 7-day window -> NOT new.
  const currentRows = [row('tenant-a', 'money-fallback', 'how much did we invoice in q2', 1, '2026-09-22T01:00:00Z', '2026-09-22T01:00:00Z')];
  const priorRows = [row('tenant-a', 'money-fallback', 'how much did we invoice in q2', 4, '2026-09-16T01:00:00Z', '2026-09-20T01:00:00Z')];
  const digest = buildDigestFromRows({ currentRows, priorRows, since: '2026-09-21T00:00:00Z', now: '2026-09-22T05:00:00Z' });
  check('buildDigestFromRows: question seen in the prior 7 days -> NOT new', !digest.groups[0].questions[0].isNew);
  eq('buildDigestFromRows: newQuestionsCount is 0 when the only question was seen before', digest.totals.newQuestionsCount, 0);
}

{
  // A question's PII is redacted before it's grouped/deduped, so two
  // differently-phoned askings of "the same" question still merge.
  const currentRows = [
    row('tenant-a', 'contact-lookup-zero', 'email me at a@x.com when done', 1, '2026-09-22T01:00:00Z', '2026-09-22T01:00:00Z'),
    row('tenant-b', 'contact-lookup-zero', 'email me at b@x.com when done', 1, '2026-09-22T02:00:00Z', '2026-09-22T02:00:00Z'),
  ];
  const digest = buildDigestFromRows({ currentRows, priorRows: [], since: '2026-09-21T00:00:00Z', now: '2026-09-22T05:00:00Z' });
  eq('buildDigestFromRows: redaction runs before grouping (both merge into one question)', digest.totals.totalQuestions, 1);
  check('buildDigestFromRows: the merged question text contains no raw email', !digest.groups[0].questions[0].question.includes('@x.com'));
}

{
  // Top-25 cap and outcome-merge (same question text, different outcome
  // buckets, merges into one topQuestions row keyed on text alone).
  const currentRows = [
    ...Array.from({ length: 30 }, (_, i) => row('tenant-a', 'no-answer', `question number ${i}`, 1, '2026-09-22T01:00:00Z', '2026-09-22T01:00:00Z')),
    row('tenant-a', 'no-answer', 'shared question', 2, '2026-09-22T01:00:00Z', '2026-09-22T01:00:00Z'),
    row('tenant-a', 'analytics-fallthrough', 'shared question', 3, '2026-09-22T01:00:00Z', '2026-09-22T01:00:00Z'),
  ];
  const digest = buildDigestFromRows({ currentRows, priorRows: [], since: '2026-09-21T00:00:00Z', now: '2026-09-22T05:00:00Z' });
  eq('buildDigestFromRows: topQuestions capped at TOP_QUESTIONS_LIMIT', digest.topQuestions.length, TOP_QUESTIONS_LIMIT);
  eq('buildDigestFromRows: the shared question merges across outcomes to 5 total', digest.topQuestions[0].count, 5);
  check('buildDigestFromRows: topQuestions sorted count desc', digest.topQuestions[0].count >= digest.topQuestions[1].count);
}

{
  // Empty input never throws and reports honest zeros.
  const digest = buildDigestFromRows({ currentRows: [], priorRows: [], since: '2026-09-21T00:00:00Z', now: '2026-09-22T05:00:00Z' });
  eq('buildDigestFromRows: empty rows -> all-zero totals, no groups', digest.totals, { totalMisses: 0, totalTenants: 0, totalQuestions: 0, newQuestionsCount: 0 });
  eq('buildDigestFromRows: empty rows -> no groups, no topQuestions', [digest.groups.length, digest.topQuestions.length], [0, 0]);
}

/* ------------------------------------------------------------- rendering */

{
  const digest = buildDigestFromRows({
    currentRows: [row('tenant-a', 'no-answer', 'a question', 4, '2026-09-22T01:00:00Z', '2026-09-22T01:00:00Z')],
    priorRows: [],
    since: '2026-09-21T00:00:00Z',
    now: '2026-09-22T05:00:00Z',
  });
  const rendered = renderMissDigestEmail(digest, '2026-09-22');
  eq('renderMissDigestEmail: subject matches "N new, M total" shape', rendered.subject, 'Donovan misses — 2026-09-22: 1 new, 4 total');
  check('renderMissDigestEmail: text is non-empty plain text', typeof rendered.text === 'string' && rendered.text.includes('a question'));
  check('renderMissDigestEmail: html is a well-formed fragment mentioning the question', rendered.html.includes('a question') && rendered.html.includes('<table'));
}

/* ------------------------------------------------------------------ done */

console.log('');
if (failures) {
  console.log(`${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log('All checks passed.');
