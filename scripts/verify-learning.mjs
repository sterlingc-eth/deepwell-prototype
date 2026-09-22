#!/usr/bin/env node
/**
 * Unit checks for Donovan's Tier 2 "learns nightly" LEARNING ENGINE (Part A —
 * handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md). Pure only — no DB, no
 * network, no Anthropic call; api/_lib/learning/store.js (the only impure
 * file in this feature) is exercised by nothing here, same as
 * scripts/verify-miss-digest.mjs leaves its own DB-touching half untested
 * offline.
 *
 * Covers:
 *   1. proposals.js: validateProposal accept/reject cases (>= 25) across all
 *      five kinds.
 *   2. Overlay purity: an empty overlay is a no-op; two different overlay
 *      OBJECTS never leak into each other's compiled tables/regexes, in
 *      either nlNormalize.js or analytics.js, regardless of call order.
 *   3. verify.js's verification engine against a small synthetic routing
 *      bank: a good proposal passes with 0 regressions; a proposal that
 *      hijacks "who is at 1234 Main St" is rejected with a regression
 *      listed; a missing routing bank returns ok:false/'no-routing-bank'.
 *   4. Few-shot overlay cap: buildAnalyticsSystemPrompt caps at 12 items and
 *      at an estimated 500 tokens, and is a pure no-op with no/empty input.
 *   5. overlayFewShotHash: stable, content-based, and distinct per distinct
 *      few-shot set — the value api/_lib/routes/analytics.js mixes into its
 *      cache promptVersion so a newly-approved example busts stale plans.
 *
 *   node scripts/verify-learning.mjs
 */
import { validateProposal, PROPOSAL_KINDS } from '../api/_lib/learning/proposals.js';
import { verifyProposal, overlayFromProposal, loadRoutingBank } from '../api/_lib/learning/verify.js';
import { overlayFewShotHash } from '../api/_lib/learning/overlay.js';
import { normalizeQuestion, withLearnedOverlay as withLearnedOverlayNL } from '../api/_lib/nlNormalize.js';
import { preClassifyAnalytics, withLearnedOverlay as withLearnedOverlayAn, buildAnalyticsSystemPrompt, ANALYTICS_SYSTEM_PROMPT } from '../api/_lib/analytics.js';
// Part B (handoffs/DONOVAN_SELF_LEARNING_2026-09-22.md): the deterministic
// proposer and the decision policy — both pure, no DB, no model.
import { deterministicCandidatesForQuestion, stillHasContactInfo } from '../api/_lib/learning/proposer.js';
import { decidePolicyStatus, parseAutoLearnPolicy } from '../api/_lib/learning/policy.js';
import { shouldRunLearningToday } from '../api/_lib/learning/sweep.js';
import { redactPII } from '../api/_lib/missDigest.js';
import { VOCAB } from '../api/_lib/nlNormalize.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let failures = 0;
let count = 0;
const check = (name, ok, detail = '') => {
  count++;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* ======================================================================
 * 1. proposals.js — validateProposal accept/reject cases.
 * ====================================================================== */

check('PROPOSAL_KINDS has exactly the 5 documented kinds', PROPOSAL_KINDS.length === 5, JSON.stringify(PROPOSAL_KINDS));

const ACCEPT_CASES = [
  ['abbreviation', { from: 'hoas', to: 'homeowners' }, 'new word -> known vocab word'],
  ['abbreviation', { from: 'wo', to: 'warranty' }, 'short new word -> known vocab word'],
  ['typo', { from: 'waranty', to: 'warranty' }, 'typo -> known vocab word'],
  ['typo', { from: 'custmer', to: 'customer' }, 'typo -> known vocab word'],
  ['synonym', { entity: 'equipment', word: 'hvac' }, 'genuinely new noun for a known entity'],
  ['synonym', { entity: 'documents', word: 'paper' }, 'new noun for documents'],
  ['synonym', { entity: 'customers', word: 'clientele' }, 'new noun for customers'],
  ['few_shot', { question: 'how many hoas do we service', plan: { entity: 'customers', op: 'count' } }, 'valid plan, not single-record'],
  ['few_shot', { question: 'jobs per technician this year', plan: { entity: 'serviceVisits', op: 'groupBy', groupBy: 'technician' } }, 'valid groupBy plan'],
  ['capability_gap', { title: 'no invoice totals', example: 'how much did we bill in Q2', note: 'financials layer not built' }, 'informational'],
];
for (const [kind, payload, label] of ACCEPT_CASES) {
  const r = validateProposal(kind, payload);
  check(`accept :: ${kind} (${label})`, r.ok === true, r.reason);
}

const REJECT_CASES = [
  ['bogus_kind', { from: 'x', to: 'y' }, 'unknown kind'],
  ['abbreviation', null, 'null payload'],
  ['abbreviation', {}, 'missing from/to'],
  ['abbreviation', { from: 'AZ', to: 'arizona' }, 'from must be lowercase already (case handled, but az IS vocab)'],
  ['abbreviation', { from: 'az', to: 'arizona' }, 'from already a known vocab word'],
  ['abbreviation', { from: 'customer', to: 'arizona' }, 'from already a known vocab word (entity synonym)'],
  ['abbreviation', { from: 'nv', to: 'nevada' }, 'from is a US state code'],
  ['abbreviation', { from: 'blvd', to: 'arizona' }, 'from is a street-suffix word'],
  ['abbreviation', { from: 'the', to: 'arizona' }, 'from is a stopword'],
  ['abbreviation', { from: 'hoas', to: 'zzzznotaword' }, 'to is not known vocabulary (invented word)'],
  ['abbreviation', { from: 'hoas', to: 'hoas' }, 'from and to must differ'],
  ['abbreviation', { from: 'H', to: 'homeowners' }, 'from too short'],
  ['abbreviation', { from: 'thisistoolongofaword12345678901', to: 'homeowners' }, 'from too long'],
  ['abbreviation', { from: 'ho-as', to: 'homeowners' }, 'from has disallowed characters'],
  ['typo', { from: 'az', to: 'arizona' }, 'typo: from already vocab'],
  ['typo', { from: 'waranty', to: 'zzzinvented' }, 'typo: to not known vocabulary'],
  ['synonym', { entity: 'not_an_entity', word: 'thing' }, 'unknown entity'],
  ['synonym', { entity: 'customers', word: 'customer' }, 'word already a known synonym'],
  ['synonym', { entity: 'customers', word: '' }, 'empty word'],
  ['synonym', { entity: 'customers', word: 'x' }, 'word too short'],
  ['few_shot', { question: '', plan: { entity: 'customers', op: 'count' } }, 'empty question'],
  ['few_shot', { question: 'how many customers do we have', plan: { entity: 'nope', op: 'count' } }, 'invalid plan (bad entity)'],
  ['few_shot', { question: "what's the warranty on the unit at 1234 elm street", plan: { entity: 'customers', op: 'count' } }, 'single-record question'],
  ['few_shot', { question: 'which customer owns serial 4N2119-08772', plan: { entity: 'equipment', op: 'list' } }, 'single-record (identifier token)'],
  ['few_shot', { question: 'how many customers in arizona', plan: null }, 'missing plan'],
  ['capability_gap', { title: '', example: 'x', note: '' }, 'missing title'],
  ['capability_gap', { title: 'x', example: '', note: '' }, 'missing example'],
];
for (const [kind, payload, label] of REJECT_CASES) {
  const r = validateProposal(kind, payload);
  check(`reject :: ${kind} (${label})`, r.ok === false, JSON.stringify(payload));
}

check(
  'accept+reject cases total >= 25 (brief asks for >= 25)',
  ACCEPT_CASES.length + REJECT_CASES.length >= 25,
  String(ACCEPT_CASES.length + REJECT_CASES.length)
);

// Case normalization: a well-formed but mixed-case accepted proposal comes
// back fully lowercased, ready to store/use as an overlay key.
{
  const r = validateProposal('abbreviation', { from: 'HOAS', to: 'Homeowners' });
  eq('accepted abbreviation is normalized to lowercase', r.ok && r.proposal.payload, { from: 'hoas', to: 'homeowners' });
}

/* ======================================================================
 * 2. Overlay purity — empty overlay is a no-op; two overlays never leak.
 * ====================================================================== */

const Q1 = 'how many hoas do we have';
const Q2 = 'how many gizmos are there';

eq('nlNormalize: undefined overlay === explicit {} overlay', normalizeQuestion(Q1, { overlay: {} }).normalized, normalizeQuestion(Q1).normalized);
eq(
  'nlNormalize: empty-but-populated-with-nothing overlay is still a no-op',
  normalizeQuestion(Q1, { overlay: { abbreviations: {}, typos: {}, vocab: [] } }).normalized,
  normalizeQuestion(Q1).normalized
);

{
  const overlayA = { abbreviations: { hoas: 'homeowners' } };
  const overlayB = { abbreviations: { gizmos: 'equipment' } };
  const withA = normalizeQuestion(Q1, { overlay: overlayA }).normalized;
  const withB = normalizeQuestion(Q2, { overlay: overlayB }).normalized;
  // Interleave: A must never see B's word, and vice versa, regardless of order.
  const withA_again = normalizeQuestion(Q1, { overlay: overlayA }).normalized;
  const q1WithB = normalizeQuestion(Q1, { overlay: overlayB }).normalized; // B doesn't know "hoas"
  const q2WithA = normalizeQuestion(Q2, { overlay: overlayA }).normalized; // A doesn't know "gizmos"
  check('nlNormalize overlay purity: A expands its own word', withA.includes('homeowners'));
  check('nlNormalize overlay purity: B expands its own word', withB.includes('equipment'));
  check('nlNormalize overlay purity: A is stable across interleaved calls', withA === withA_again);
  check('nlNormalize overlay purity: B never expands A\'s word', !q1WithB.includes('homeowners'));
  check('nlNormalize overlay purity: A never expands B\'s word', !q2WithA.includes('equipment'));
  check('nlNormalize overlay purity: no overlay at all still sees neither', normalizeQuestion(Q1).normalized === 'how many hoas do we have');
}

eq(
  'analytics: undefined overlay === explicit {} overlay',
  preClassifyAnalytics('how many gizmos do we have', { overlay: {} }),
  preClassifyAnalytics('how many gizmos do we have')
);
{
  const overlayGizmos = { synonyms: { equipment: ['gizmos'] } };
  const overlayWidgets = { synonyms: { equipment: ['widgets'] } };
  const q = 'how many gizmos do we have';
  const qW = 'how many widgets do we have';
  check('analytics overlay: unknown noun does not classify at baseline', preClassifyAnalytics(q) === false);
  check('analytics overlay: learned synonym makes it classify', preClassifyAnalytics(q, { overlay: overlayGizmos }) === true);
  check('analytics overlay purity: a DIFFERENT overlay does not also learn "gizmos"', preClassifyAnalytics(q, { overlay: overlayWidgets }) === false);
  check('analytics overlay purity: "widgets" overlay learns its own word', preClassifyAnalytics(qW, { overlay: overlayWidgets }) === true);
  check('analytics overlay purity: base classifier untouched after both calls', preClassifyAnalytics(q) === false);
}

// withLearnedOverlay is exported from both modules and callable directly.
check('nlNormalize exports withLearnedOverlay', typeof withLearnedOverlayNL === 'function');
check('analytics exports withLearnedOverlay', typeof withLearnedOverlayAn === 'function');
{
  const seenBase = withLearnedOverlayAn(null, (cr) => cr === withLearnedOverlayAn(undefined, (cr2) => cr2));
  check('analytics withLearnedOverlay: null/undefined overlay both resolve to the SAME base regex bag (object identity)', seenBase);
}

/* ======================================================================
 * 3. verify.js — verification engine against a small synthetic bank.
 * ====================================================================== */

const SYNTHETIC_BANK = [
  ['how many hoas do we have', 'A'],
  ['how many customers do we have', 'A'],
  ['list customers in gilbert', 'A'],
  ["what's the phone number for donna thornton", 'L'],
  ['who is at 1234 main st', 'L'],
  ['when did we last service the unit at 100 e main st, mesa, az', 'L'],
  ['which customer owns serial 4N2119-08772', 'R'],
  ['how much did we invoice last month', 'U'],
  ['which customers are overdue for maintenance', 'U'],
];

check('loadRoutingBank returns the real bundled bank (or null if not generated yet)', loadRoutingBank() === null || Array.isArray(loadRoutingBank()));

{
  // A GOOD proposal: teach "hoas" -> the real, already-supported "homeowners"
  // customer synonym. Should pass cleanly with 0 regressions.
  const v = validateProposal('synonym', { entity: 'customers', word: 'hoas' });
  check('synthetic: good synonym proposal validates', v.ok, v.reason);
  const r = verifyProposal(v.proposal, { routingBank: SYNTHETIC_BANK, missQuestions: ['how many hoas do we have'] });
  check('synthetic: good proposal verifies ok', r.ok === true, JSON.stringify(r.reasons));
  eq('synthetic: good proposal has 0 regressions', r.regressions, []);
  eq('synthetic: good proposal fixes its own named miss', r.missFixed, { fixed: 1, total: 1 });
  check('synthetic: good proposal negativesPass', r.negativesPass === true);
}

{
  // A BAD proposal: an abbreviation that corrupts the word "main" — a real
  // street-name component — into an unrelated vocabulary word. Schema-valid
  // (proposals.js has no way to know "main" shows up in street names), but
  // the routing bank must catch the corruption on the two "...main st..."
  // entries and reject it with a regression.
  const v = validateProposal('abbreviation', { from: 'main', to: 'arizona' });
  check('synthetic: bad "main"->"arizona" proposal validates (schema alone can\'t catch this)', v.ok, v.reason);
  const r = verifyProposal(v.proposal, { routingBank: SYNTHETIC_BANK });
  check('synthetic: bad proposal is rejected by verification', r.ok === false);
  check('synthetic: bad proposal lists at least one regression', r.regressions.length >= 1, JSON.stringify(r.regressions));
  check(
    'synthetic: the "who is at 1234 Main St" entry is named in the regressions',
    r.regressions.some((reg) => /main st/i.test(reg.text)),
    JSON.stringify(r.regressions)
  );
}

{
  // A proposal that would hijack a genuine single-record/address question
  // INTO analytics must be caught by the negative set too.
  const v = validateProposal('synonym', { entity: 'customers', word: 'main' });
  check('synthetic: "main" as a customer synonym validates (schema alone can\'t catch this either)', v.ok, v.reason);
  const r = verifyProposal(v.proposal, {
    routingBank: SYNTHETIC_BANK,
    negatives: ['which customers are at 1234 Main St, Mesa AZ?', 'who is at 1234 main st'],
  });
  // This particular word never actually flips classifyRoute's outcome (the
  // single-record/address gate runs before the analytics check either way —
  // the same ordering api/ask.js itself uses) — asserted here as a POSITIVE
  // pin that the ordering holds, not a bug: a bad synonym can corrupt
  // NORMALIZED TEXT (caught by the routing-bank regression check above) but
  // can never, by construction, hijack a real address/serial/named-record
  // question past looksLikeSingleRecordReference into analytics.
  check('synthetic: single-record guard order keeps the negative set clean regardless', r.negativesPass === true);
}

{
  const r = verifyProposal({ kind: 'synonym', payload: { entity: 'customers', word: 'hoas' } }, { routingBank: [] });
  check('verifyProposal: empty routing bank -> ok:false, reason "no-routing-bank"', r.ok === false && r.reasons.includes('no-routing-bank'));
}
{
  const r = verifyProposal(null, { routingBank: SYNTHETIC_BANK });
  check('verifyProposal: no proposal -> ok:false', r.ok === false);
}

check('overlayFromProposal: unknown kind produces an empty overlay', (() => {
  const o = overlayFromProposal({ kind: 'capability_gap', payload: { title: 'x', example: 'y', note: '' } });
  return Object.keys(o.abbreviations).length === 0 && Object.keys(o.typos).length === 0 && Object.keys(o.synonyms).length === 0 && o.fewShot.length === 0;
})());

/* ======================================================================
 * 4. Few-shot overlay cap.
 * ====================================================================== */

eq('buildAnalyticsSystemPrompt: no extraFewShot returns the exact base prompt', buildAnalyticsSystemPrompt(), ANALYTICS_SYSTEM_PROMPT);
eq('buildAnalyticsSystemPrompt: empty array returns the exact base prompt', buildAnalyticsSystemPrompt({ extraFewShot: [] }), ANALYTICS_SYSTEM_PROMPT);

{
  const many = Array.from({ length: 30 }, (_, i) => ({
    question: `how many customers in city number ${i} arizona`,
    plan: { entity: 'customers', op: 'count', filters: [{ field: 'city', op: 'eq', value: `City${i}` }] },
  }));
  const prompt = buildAnalyticsSystemPrompt({ extraFewShot: many });
  const learnedLines = prompt.split('LEARNED EXAMPLES')[1]?.split('\n').filter((l) => l.startsWith('Q:')) ?? [];
  check('buildAnalyticsSystemPrompt: caps at 12 items even when 30 are offered', learnedLines.length <= 12, String(learnedLines.length));
  check('buildAnalyticsSystemPrompt: still starts with the exact base prompt (prefix stable for caching)', prompt.startsWith(ANALYTICS_SYSTEM_PROMPT));
}

{
  // One single giant question forces the 500-token estimate to reject it
  // outright, leaving 0 learned lines (never a truncated/corrupt one).
  const huge = [{ question: 'x'.repeat(4000), plan: { entity: 'customers', op: 'count' } }];
  const prompt = buildAnalyticsSystemPrompt({ extraFewShot: huge });
  eq('buildAnalyticsSystemPrompt: an item alone over the 500-token budget is dropped entirely', prompt, ANALYTICS_SYSTEM_PROMPT);
}

{
  // A mix of small items stops adding once the running total would exceed
  // the token budget, rather than exceeding it.
  const items = Array.from({ length: 12 }, (_, i) => ({
    question: `how many customers in maricopa county filtered by brand goodman number ${i}`.repeat(3),
    plan: { entity: 'customers', op: 'count', filters: [{ field: 'county', op: 'eq', value: 'Maricopa' }] },
  }));
  const prompt = buildAnalyticsSystemPrompt({ extraFewShot: items });
  const block = prompt.split('LEARNED EXAMPLES')[1] ?? '';
  const estTokens = Math.ceil(block.length / 4);
  check('buildAnalyticsSystemPrompt: learned block stays within a reasonable token estimate', estTokens <= 520, String(estTokens));
}

// An invalid plan inside a learned few-shot item is skipped, never crashes
// prompt building and never appears verbatim in the prompt.
{
  const mixed = [
    { question: 'how many customers do we have in pinal county', plan: { entity: 'nope', op: 'count' } },
    { question: 'how many customers do we have in yuma county', plan: { entity: 'customers', op: 'count', filters: [{ field: 'county', op: 'eq', value: 'Yuma' }] } },
  ];
  const prompt = buildAnalyticsSystemPrompt({ extraFewShot: mixed });
  check('buildAnalyticsSystemPrompt: an invalid plan is silently skipped, not thrown', !prompt.includes('pinal'));
  check('buildAnalyticsSystemPrompt: the valid item alongside it still gets in', prompt.includes('yuma'));
}

/* ======================================================================
 * 5. overlayFewShotHash — cache-key ingredient.
 * ====================================================================== */

eq('overlayFewShotHash: no overlay -> the fixed "no-fewshot" constant', overlayFewShotHash(undefined), 'no-fewshot');
eq('overlayFewShotHash: empty fewShot -> the fixed "no-fewshot" constant', overlayFewShotHash({ fewShot: [] }), 'no-fewshot');

{
  const oA = { fewShot: [{ question: 'q1', plan: { entity: 'customers', op: 'count' } }] };
  const oB = { fewShot: [{ question: 'q2', plan: { entity: 'customers', op: 'count' } }] };
  const oA2 = { fewShot: [{ question: 'q1', plan: { entity: 'customers', op: 'count' } }] };
  check('overlayFewShotHash: distinct content -> distinct hash', overlayFewShotHash(oA) !== overlayFewShotHash(oB));
  eq('overlayFewShotHash: identical content -> identical hash (even as a different object)', overlayFewShotHash(oA), overlayFewShotHash(oA2));
  check('overlayFewShotHash: never equal to the empty-overlay constant when items exist', overlayFewShotHash(oA) !== 'no-fewshot');
}

/* ======================================================================
 * 6. proposer.js — deterministic candidate generation (Part B).
 * ====================================================================== */

// Known-good pairs already proven valid by section 1's own ACCEPT_CASES
// above (both "waranty"/"custmer" are real typos of real vocab words) —
// reused here rather than re-deriving them, so this section pins down
// deterministicCandidatesForQuestion's SCANNING logic, not VOCAB content.
{
  const cands = deterministicCandidatesForQuestion('how many units are still under waranty');
  check(
    'proposer: typo candidate found for a real vocab-adjacent misspelling',
    cands.some((c) => c.kind === 'typo' && c.payload.from === 'waranty' && c.payload.to === 'warranty'),
    JSON.stringify(cands)
  );
}
{
  const cands = deterministicCandidatesForQuestion('list every custmer in gilbert');
  check(
    'proposer: typo candidate found for a second real misspelling',
    cands.some((c) => c.kind === 'typo' && c.payload.from === 'custmer' && c.payload.to === 'customer'),
    JSON.stringify(cands)
  );
}
{
  const cands = deterministicCandidatesForQuestion('how many units are under warranty');
  check('proposer: no candidate for a word already in vocab ("warranty")', cands.length === 0, JSON.stringify(cands));
}
{
  const cands = deterministicCandidatesForQuestion("what's the warranty on the unit at 1234 elm street");
  check(
    'proposer: no candidate at all for a single-record/address question',
    cands.length === 0,
    JSON.stringify(cands)
  );
}
{
  // The token right after a number is a street-name component — never a typo
  // candidate, even though "waranty" alone (section above) IS one.
  const cands = deterministicCandidatesForQuestion('who has 5 waranty items');
  check(
    'proposer: no typo candidate for a token immediately after a number',
    !cands.some((c) => c.payload?.from === 'waranty'),
    JSON.stringify(cands)
  );
}
{
  // The token right before a street-suffix word is a street name — never a
  // typo candidate either.
  const cands = deterministicCandidatesForQuestion('who lives on waranty street in mesa');
  check(
    'proposer: no typo candidate for a token immediately before a street suffix',
    !cands.some((c) => c.payload?.from === 'waranty'),
    JSON.stringify(cands)
  );
}
{
  // "which customer owns serial 4n2119-08772" — the serial token itself
  // contains digits (never touched), and the whole question also reads as a
  // single-record reference (belt and suspenders, same guard as above).
  const cands = deterministicCandidatesForQuestion('which customer owns serial 4n2119-08772');
  check('proposer: no candidate for a serial-bearing question', cands.length === 0, JSON.stringify(cands));
}

// Abbreviation candidates: found dynamically against the REAL, current VOCAB
// (rather than a hand-picked prefix that could drift out of date) — an
// unambiguous prefix (<=4 chars, not itself in vocab) of exactly one vocab
// word strictly longer than it.
function findUnambiguousPrefix() {
  for (const w of VOCAB) {
    if (w.length < 5) continue;
    for (let n = 2; n <= 4 && n < w.length; n++) {
      const prefix = w.slice(0, n);
      if (VOCAB.has(prefix)) continue;
      let count = 0;
      for (const w2 of VOCAB) {
        if (w2.length > n && w2.startsWith(prefix)) count++;
        if (count > 1) break;
      }
      if (count === 1) return { prefix, word: w };
    }
  }
  return null;
}
{
  const found = findUnambiguousPrefix();
  check('proposer: an unambiguous vocab prefix exists to test against', Boolean(found), 'VOCAB has none — unexpected');
  if (found) {
    const cands = deterministicCandidatesForQuestion(`how many ${found.prefix} do we have`);
    check(
      `proposer: abbreviation candidate found for real unambiguous prefix "${found.prefix}"`,
      cands.some((c) => c.kind === 'abbreviation' && c.payload.from === found.prefix && c.payload.to === found.word),
      JSON.stringify(cands)
    );
  }
}

/* ======================================================================
 * 7. proposer.js — the redaction gate (build brief item 6).
 * ====================================================================== */

check('proposer: an unredacted email is flagged', stillHasContactInfo('email me at dispatch@acmehvac.com'));
check('proposer: an unredacted phone number is flagged', stillHasContactInfo('call 555-123-4567 for details'));
check('proposer: redacted text has nothing left to flag', !stillHasContactInfo('email me at [redacted-email]'));
check(
  'proposer: redactPII + stillHasContactInfo compose to clear a real email',
  !stillHasContactInfo(redactPII('email me at dispatch@acmehvac.com about this'))
);
check(
  'proposer: redactPII + stillHasContactInfo compose to clear a real phone number',
  !stillHasContactInfo(redactPII('call 555-123-4567 about this'))
);
check('proposer: plain text with no contact info is never flagged', !stillHasContactInfo('how many customers are in arizona'));

/* ======================================================================
 * 8. policy.js — the decision policy matrix (kind x env x verification).
 * ====================================================================== */

const OK = { ok: true, reasons: [] };
const BAD = { ok: false, reasons: ['regressions: 1/10'] };

eq('policy: parseAutoLearnPolicy defaults unset to "vocab"', parseAutoLearnPolicy(undefined), 'vocab');
eq('policy: parseAutoLearnPolicy defaults garbage to "vocab"', parseAutoLearnPolicy('bogus'), 'vocab');
eq('policy: parseAutoLearnPolicy passes through "off"', parseAutoLearnPolicy('off'), 'off');
eq('policy: parseAutoLearnPolicy passes through "all"', parseAutoLearnPolicy('all'), 'all');

const POLICY_CASES = [
  // [kind, tenantCount, count, verification, policy, expectedStatus]
  ['typo', 1, 2, BAD, 'all', 'auto_rejected', 'failed verification always auto_rejected, regardless of policy/kind'],
  ['typo', 1, 2, OK, 'vocab', 'auto_approved', 'typo meets the bar, policy allows vocab kinds'],
  ['abbreviation', 2, 5, OK, 'all', 'auto_approved', 'abbreviation meets the bar, policy allows everything'],
  ['typo', 1, 2, OK, 'off', 'pending', 'policy off never auto-approves anything'],
  ['typo', 0, 5, OK, 'vocab', 'pending', 'tenantCount below the bar (0) stays pending'],
  ['abbreviation', 1, 1, OK, 'all', 'pending', 'count below the bar (1) stays pending'],
  ['synonym', 5, 10, OK, 'vocab', 'pending', 'synonym never auto-approves under "vocab"'],
  ['synonym', 5, 10, OK, 'all', 'auto_approved', 'synonym auto-approves only under "all"'],
  ['few_shot', 5, 10, OK, 'off', 'pending', 'few_shot never auto-approves under "off"'],
  ['few_shot', 5, 10, OK, 'all', 'auto_approved', 'few_shot auto-approves only under "all"'],
  ['capability_gap', 99, 99, OK, 'all', 'pending', 'capability_gap NEVER auto-approves, any policy, any evidence'],
  ['capability_gap', 99, 99, BAD, 'all', 'auto_rejected', 'capability_gap still auto_rejected on failed verification'],
];
for (const [kind, tenantCount, count, verification, policy, expected, label] of POLICY_CASES) {
  const { status } = decidePolicyStatus({ kind, tenantCount, count }, verification, policy);
  check(`policy :: ${kind}/${policy}/tc=${tenantCount}/c=${count} -> ${expected} (${label})`, status === expected, `got ${status}`);
}

/* ======================================================================
 * 9. sweep.js — the once-per-day guard (no-founder-tenant fallback path).
 * ====================================================================== */

check('sweep: first run ever (null last-run) runs today', shouldRunLearningToday(null, '2026-09-22') === true);
check('sweep: same day as last run does not run again', shouldRunLearningToday('2026-09-22', '2026-09-22') === false);
check('sweep: a new day runs again', shouldRunLearningToday('2026-09-21', '2026-09-22') === true);

/* ======================================================================
 * 10. api/review.js — the operator gate on all 5 learning actions.
 * ====================================================================== */

const __dirname2 = dirname(fileURLToPath(import.meta.url));
const reviewSrc = readFileSync(join(__dirname2, '..', 'api', 'review.js'), 'utf8');
const LEARNING_ACTIONS = ['learningList', 'learningDecide', 'learningDeactivate', 'learningRunNow', 'learningExport'];

check(
  'review.js: ACTIONS set lists all 5 learning actions',
  LEARNING_ACTIONS.every((a) => new RegExp(`'${a}'`).test(reviewSrc))
);

for (const action of LEARNING_ACTIONS) {
  const marker = `case '${action}'`;
  const startIdx = reviewSrc.indexOf(marker);
  check(`review.js: a case block exists for '${action}'`, startIdx !== -1);
  if (startIdx === -1) continue;
  const nextCaseIdx = reviewSrc.indexOf("\n      case '", startIdx + marker.length);
  const defaultIdx = reviewSrc.indexOf('\n      default:', startIdx + marker.length);
  const candidates = [nextCaseIdx, defaultIdx].filter((n) => n !== -1);
  const endIdx = candidates.length ? Math.min(...candidates) : reviewSrc.length;
  const block = reviewSrc.slice(startIdx, endIdx);
  check(`review.js: '${action}' calls requireOperator(auth) in its own case block`, block.includes('requireOperator(auth)'), block);
}

console.log(`\n${count - failures}/${count} checks passed.`);
if (failures > 0) {
  console.error(`${failures} FAILURE(S)`);
  process.exit(1);
}
