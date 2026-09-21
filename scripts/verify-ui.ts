/**
 * Unit checks for the frontend truth-pass: the "Try asking" suggestion
 * builder, the deep-link URL parser, and the fetch-failure copy mapper. No
 * DOM, no network, no store — every function under test here is pure.
 *
 *   npx tsx scripts/verify-ui.ts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
import { buildSuggestions } from '../src/core/suggestions';
import { formatYmd } from '../src/core/answer';
import { parseDeepLink, resolveDeepLinkRedirectPath, freshPersistedDeepLinkSearch, DEEP_LINK_TTL_MS } from '../src/hooks/useDeepLink';
import {
  annualPrice,
  billingBannerFor,
  daysUntil,
  isValidPlanId,
  recordsRescueTotalCents,
  resolveRecordsRescueQuantity,
  RECORDS_RESCUE_MIN_PAGES,
  type BillingStatus,
} from '../src/services/billingClient';
import { describeFetchFailure, NETWORK_ERROR_MESSAGE, chunkIds, pollDocumentStatusChunked } from '../src/services/ingestClient';
import { messageFromResponse, parseRetryAfterSeconds, isDailyCap, type ResponseLike } from '../src/services/httpError';
import { truncateForDisplay, summarizeProgress, type BulkFileState } from '../src/services/bulkImport';
import { conflictDocs, gapDocs, maxStageFor, recomputeIssues, unlinkedDocs, type GraphSnapshot } from '../src/core/entityGraph';
import { isValidCustomerNumber, isUuid, refKind } from '../src/services/customerClient';
import { sortTimelineDesc } from '../src/screens/CustomerProfileScreen';
import { hvacSchema } from '../src/domains/hvac/schema';
import * as hvacDocTypes from '../src/domains/hvac/documentTypes';
import type { Doc, Entity } from '../src/core/types';
import { STAGE_LABEL } from '../src/components/StagePill';
import { PIPELINE_STAGES } from '../src/core/types';
import { NAV } from '../src/components/AppShell';
import { isAdminRole, seatStatus } from '../src/services/teamClient';
import { unreadBadgeLabel, parseNotificationLink } from '../src/services/notifyClient';
import { sentThisMonth, type OutreachMessage } from '../src/services/outreachClient';
import { docsMatchingFilter } from '../src/screens/ReviewScreen';
import { selectIngestProgress } from '../src/store/appStore';
import type { IngestProgress } from '../src/services/ingestClient';
import {
  DEFAULT_CUSTOMER_FILTERS,
  cityOptions,
  customerSortName,
  describeActiveFilters,
  matchesCustomerFilters,
  matchesSearch,
  sortCustomers,
  type CustomerFilters,
} from '../src/core/customerFilters';
import { pairKey, reduceDuplicates, visibleDuplicates, nameTokenCount, defaultKeepId } from '../src/core/duplicates';
import { groupExtractionsByUnit } from '../src/domains/hvac/units';
import type { CustomerSummary } from '../src/services/customerClient';
// The real source of truth (handoffs/TEAM_BRIEF_2026-09-19.md) — agent-backend
// owns this file. src/domains/hvac/documentTypes.ts is a hand-mirrored copy
// (src/ cannot import api/, different tsconfig root); this import exists only
// to assert the two never drift apart silently.
import * as backendDocTypes from '../api/_lib/documentTypes.js';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name: string, got: unknown, want: unknown): void =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* -------------------------------------------------------- buildSuggestions */

{
  const property = (id: string, address: string, customerName?: string): Entity => ({
    id,
    type: 'property',
    fields: { address, customerName: customerName ?? null },
  });
  const equipment = (id: string, serial: string): Entity => ({
    id,
    type: 'equipment',
    fields: { serial },
  });

  eq('no entities → no suggestions', buildSuggestions([]), []);

  const one = buildSuggestions([property('p1', '123 Main St')]);
  check('one property → one address question', one.length === 1 && one[0]!.includes('123 Main St'), JSON.stringify(one));

  const withCustomer = buildSuggestions([property('p1', '123 Main St', 'Jane Diaz')]);
  check(
    'a customer name produces a customer question, not just the address one',
    withCustomer.some((q) => q.includes('Jane Diaz')),
    JSON.stringify(withCustomer),
  );

  const withEquipment = buildSuggestions([equipment('e1', 'SN-1234')]);
  check('one equipment → a serial question', withEquipment.some((q) => q.includes('SN-1234')), JSON.stringify(withEquipment));
  check(
    'any equipment present → the generic warranty-expiry question is offered',
    withEquipment.includes('Which warranties expire in the next 12 months?'),
  );

  const noRealData = buildSuggestions([{ id: 'p1', type: 'property', fields: { address: null } }]);
  eq('a property with no address contributes nothing fabricated', noRealData, []);

  const many = Array.from({ length: 10 }, (_, i) => property(`p${i}`, `${i} Elm St`));
  check('never more than max (default 5)', buildSuggestions(many).length <= 5);
  check('respects a smaller explicit max', buildSuggestions(many, 2).length <= 2);

  const dup = [property('p1', 'Same St'), property('p2', 'Same St')];
  eq('duplicate questions are not repeated', buildSuggestions(dup), ['When were we last at Same St?']);
}

/* ------------------------------------------------------------ parseDeepLink */

{
  eq('empty search → nothing', parseDeepLink(''), {});
  eq('bare ? → nothing', parseDeepLink('?'), {});
  eq('entity param', parseDeepLink('?entity=eq-42'), { entityId: 'eq-42' });
  eq('doc param', parseDeepLink('?doc=doc-7'), { docId: 'doc-7' });
  eq('a valid screen is accepted', parseDeepLink('?screen=dashboard'), { screen: 'dashboard' });
  eq('an unknown screen is dropped, not passed through', parseDeepLink('?screen=not-a-real-screen'), {});
  eq(
    'entity + doc + screen together',
    parseDeepLink('?entity=eq-1&doc=doc-2&screen=review'),
    { entityId: 'eq-1', docId: 'doc-2', screen: 'review' },
  );
  eq('leading "?" is optional (URLSearchParams tolerates it either way)', parseDeepLink('entity=eq-1'), { entityId: 'eq-1' });
  eq('an empty value is treated as absent', parseDeepLink('?entity=&doc=doc-1'), { docId: 'doc-1' });
  eq('q param', parseDeepLink('?q=How much was the Henderson install?'), { question: 'How much was the Henderson install?' });
  eq('a blank q is treated as absent', parseDeepLink('?q=%20%20'), {});
  eq('q is trimmed', parseDeepLink(`?q=${encodeURIComponent('  hello  ')}`), { question: 'hello' });
  {
    const long = 'a'.repeat(2500);
    const got = parseDeepLink(`?q=${long}`).question;
    check('q is capped at 2000 chars', got?.length === 2000 && got === 'a'.repeat(2000), `got length ${got?.length}`);
  }

  // ?plan= / ?interval= — the marketing site's pricing buttons and the
  // Records Rescue CTA (index.html) land here; see useDeepLink.ts's
  // isValidPlanId gate and handoffs/STRIPE_BRIEF_2026-09-20.md.
  eq('a valid plan defaults interval to month', parseDeepLink('?plan=shop'), { plan: 'shop', interval: 'month' });
  eq('a valid plan with interval=year is kept', parseDeepLink('?plan=solo&interval=year'), { plan: 'solo', interval: 'year' });
  eq('an unrecognized interval falls back to month', parseDeepLink('?plan=crew&interval=biweekly'), { plan: 'crew', interval: 'month' });
  eq('an invalid plan id is dropped entirely, including interval', parseDeepLink('?plan=enterprise&interval=year'), {});
  eq('an empty plan is dropped', parseDeepLink('?plan=&interval=year'), {});
  check('isValidPlanId accepts exactly the four catalog ids', ['solo', 'shop', 'crew', 'fleet'].every(isValidPlanId) && !isValidPlanId('enterprise') && !isValidPlanId(null) && !isValidPlanId(undefined));

  // ?customer= — a customer's uuid or its 'C-00012' display number
  // (handoffs/CUSTOMER_PROFILES_BRIEF_2026-09-20.md section E's deep link).
  // Parsing itself doesn't classify which one it is (that's customerClient's
  // job — see refKind below); it just carries the trimmed, capped string.
  eq('a customer uuid is carried through', parseDeepLink('?customer=3fa85f64-5717-4562-b3fc-2c963f66afa6'), { customerRef: '3fa85f64-5717-4562-b3fc-2c963f66afa6' });
  eq('a customer number is carried through', parseDeepLink('?customer=C-00012'), { customerRef: 'C-00012' });
  eq('an empty customer value is treated as absent', parseDeepLink('?customer=&doc=doc-1'), { docId: 'doc-1' });
  eq('customer is trimmed', parseDeepLink(`?customer=${encodeURIComponent('  C-00012  ')}`), { customerRef: 'C-00012' });
  {
    const longRef = 'C-'.repeat(50);
    const got = parseDeepLink(`?customer=${longRef}`).customerRef;
    check('customer ref is capped at 64 chars', got?.length === 64, `got length ${got?.length}`);
  }

  // ?screen=outreach&equipment= — Dashboard's "Open in Outreach" button and
  // handoffs/OUTREACH_2026-09-20.md's deep link.
  eq('outreach is a valid screen', parseDeepLink('?screen=outreach'), { screen: 'outreach' });
  eq(
    'outreach screen with an equipment id to preselect',
    parseDeepLink('?screen=outreach&equipment=eq-9'),
    { screen: 'outreach', outreachEquipmentId: 'eq-9' },
  );
  eq('an empty equipment value is treated as absent', parseDeepLink('?screen=outreach&equipment='), { screen: 'outreach' });

  // Follow-up messages' own deep link (api/_lib/followups.js's FOLLOWUP_INBOX_LINK).
  eq('screen=inbox is an alias for the review (Needs a person) screen', parseDeepLink('?screen=inbox'), { screen: 'review' });
  eq('work=mine is carried through alongside screen=inbox', parseDeepLink('?screen=inbox&work=mine'), { screen: 'review', workFilter: 'mine' });
  eq('an unrecognized work value is dropped', parseDeepLink('?screen=inbox&work=everyone'), { screen: 'review' });
  eq('work with no screen is still carried through', parseDeepLink('?work=mine'), { workFilter: 'mine' });
}

/* ------------------------------------------------- resolveDeepLinkRedirectPath */

{
  // A Clerk OAuth sign-in or CreateOrganization submit does a real page
  // navigation to this URL — the fix for the "pricing CTA loses ?plan=
  // before Clerk loads" bug (handoffs/QA_APP_API_2026-09-21.md).
  eq('no live and no persisted params → bare app root', resolveDeepLinkRedirectPath('', ''), '/app/');
  eq('bare "?" on both sides → bare app root', resolveDeepLinkRedirectPath('?', '?'), '/app/');
  eq(
    'live params are used as-is',
    resolveDeepLinkRedirectPath('?plan=solo&interval=month', ''),
    '/app/?plan=solo&interval=month',
  );
  eq(
    'falls back to the persisted copy when the live URL is bare (the address bar was already scrubbed)',
    resolveDeepLinkRedirectPath('', '?plan=solo&interval=month'),
    '/app/?plan=solo&interval=month',
  );
  eq(
    'live params win over a stale persisted copy',
    resolveDeepLinkRedirectPath('?screen=dashboard', '?plan=solo'),
    '/app/?screen=dashboard',
  );
  eq(
    'a persisted value missing its leading "?" still gets one',
    resolveDeepLinkRedirectPath('', 'plan=solo'),
    '/app/?plan=solo',
  );
}

/* ------------------------------------------------- freshPersistedDeepLinkSearch */

{
  // Reviewer NO-GO (2026-09-21): a persisted deep link must not resurrect on
  // a later, UNRELATED bare `/app/` visit in the same tab (e.g. someone
  // abandons signup, comes back an hour later via a bookmark). Fixed with a
  // timestamp + TTL on the persisted entry — these cases cover that
  // boundary directly, with a fixed clock so nothing here depends on
  // wall-clock time.
  const now = 1_700_000_000_000;
  const entry = (search: string, ageMs: number) => JSON.stringify({ search, ts: now - ageMs });

  eq(
    'within TTL — a bare reload mid-redirect (OAuth/org-creation round trip) still gets the pending plan',
    freshPersistedDeepLinkSearch(entry('?plan=solo&interval=month', 5 * 60 * 1000), now),
    '?plan=solo&interval=month',
  );
  eq(
    'past TTL — an abandoned signup never resurrects its plan on a later bare visit',
    freshPersistedDeepLinkSearch(entry('?plan=solo', 20 * 60 * 1000), now),
    '',
  );
  eq('exactly at the TTL boundary is still honored (inclusive)', freshPersistedDeepLinkSearch(entry('?plan=solo', DEEP_LINK_TTL_MS), now), '?plan=solo');
  eq('one ms past the TTL boundary is not', freshPersistedDeepLinkSearch(entry('?plan=solo', DEEP_LINK_TTL_MS + 1), now), '');
  eq('nothing persisted -> nothing', freshPersistedDeepLinkSearch(null, now), '');
  eq('corrupt JSON never throws, just reads as nothing persisted', freshPersistedDeepLinkSearch('not json', now), '');
  eq('a timestamp in the future (clock skew) is treated as stale, not honored', freshPersistedDeepLinkSearch(entry('?plan=solo', -1000), now), '');
  eq(
    'the pre-TTL plain-string format (no {search,ts} wrapper) is dropped rather than honored forever',
    freshPersistedDeepLinkSearch('?plan=solo', now),
    '',
  );

  // "Consumed once -> a second render gets nothing": useDeepLink's
  // ready-gated effect (and App.tsx's billing-active effect) both call
  // clearPersistedDeepLinkSearch() the moment the link is actually
  // consumed — simulated here by reading again with the entry gone.
  {
    const raw = entry('?plan=solo&interval=month', 1000);
    const first = freshPersistedDeepLinkSearch(raw, now);
    check('consumed once: the first read applies the pending plan', first === '?plan=solo&interval=month');
    const second = freshPersistedDeepLinkSearch(null, now);
    check('consumed once: a second read after clearing gets nothing', second === '');
  }
}

/* ---------------------------------------------------------------- formatYmd */

{
  check('formatYmd formats a YYYY-MM-DD string without a timezone shift', formatYmd('2024-03-14') === 'Mar 14, 2024', formatYmd('2024-03-14'));
  // The exact bug this guards: `new Date('2024-03-14')` parses as UTC
  // midnight, and toLocaleDateString on that under a negative UTC offset
  // (America/Phoenix) used to render "Mar 13, 2024" — a day early. Run this
  // script under both TZ=America/Phoenix and TZ=UTC; formatYmd's output must
  // not change either way.
  check('formatYmd formats the equivalent Date the same way, in this process\'s TZ', formatYmd(new Date('2024-03-14')) === 'Mar 14, 2024', `TZ=${process.env.TZ ?? '(unset)'} got ${formatYmd(new Date('2024-03-14'))}`);
  eq('formatYmd of null/undefined is empty', [formatYmd(null), formatYmd(undefined)], ['', '']);
}

/* -------------------------------------------------- document-status chunking */

{
  eq('chunkIds splits 250 ids into 100/100/50', chunkIds(Array.from({ length: 250 }, (_, i) => `id-${i}`)).map((c) => c.length), [100, 100, 50]);
  eq('chunkIds of exactly one chunk stays one call', chunkIds(Array.from({ length: 50 }, (_, i) => `id-${i}`)).map((c) => c.length), [50]);
  eq('chunkIds of empty input is no chunks', chunkIds([]), []);

  // One failed chunk must not block the others' documents from settling —
  // a bulk import tracking >100 docs whose 2nd request drops must still see
  // the 1st and 3rd chunks' results. Top-level await: this file is run
  // directly by tsx as an ES module, and every check below must finish (and
  // increment `failures`) before the pass/fail summary prints at the bottom.
  {
    const calls: string[][] = [];
    const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`);
    const rows = await pollDocumentStatusChunked(ids, async (c) => {
      calls.push(c);
      if (calls.length === 2) throw new Error('simulated dropped request');
      return c.map((id) => ({ id, original_filename: id, stage: 'verified', page_count: 1, extracted_at: 'x', extract_error: null, field_count: 1 }));
    });
    eq('pollDocumentStatusChunked: fetcher is called once per chunk (3 calls for 250 ids)', calls.length, 3);
    eq('pollDocumentStatusChunked: the failed chunk\'s ids are missing, the other two chunks\' are not', rows.map((r) => r.id).sort(), [...ids.slice(0, 100), ...ids.slice(200, 250)].sort());
  }
}

/* ------------------------------------------------------- describeFetchFailure */

{
  eq(
    'a JSON body with an error message is passed through verbatim',
    describeFetchFailure(JSON.stringify({ error: 'That file is too large.' })),
    'That file is too large.',
  );
  eq('an HTML error page (a raw Vercel 500) falls back to plain language', describeFetchFailure('<html><body>Internal Server Error</body></html>'), NETWORK_ERROR_MESSAGE);
  eq('an empty body falls back to plain language', describeFetchFailure(''), NETWORK_ERROR_MESSAGE);
  eq('JSON with no "error" key falls back to plain language', describeFetchFailure(JSON.stringify({ ok: false })), NETWORK_ERROR_MESSAGE);
  eq('JSON with a blank "error" string falls back to plain language', describeFetchFailure(JSON.stringify({ error: '   ' })), NETWORK_ERROR_MESSAGE);
  check('the fallback message is plain language, never a raw status line', !/^\d{3}\s/.test(NETWORK_ERROR_MESSAGE));
}

/* ------------------------------------------------------------ messageFromResponse */
//
// Shared 429 message builder every service client's postJson uses
// (ingestClient, answerService.claude, reviewClient, documentClient) — see
// src/services/httpError.ts's file comment for the two response shapes
// api/_lib/rateLimit.js actually sends.
{
  const res = (status: number, retryAfter: string | null): ResponseLike => ({
    status,
    headers: { get: (name: string) => (name === 'Retry-After' ? retryAfter : null) },
  });

  eq(
    'messageFromResponse: numeric Retry-After appends a seconds hint',
    messageFromResponse(res(429, '42'), { error: 'Too many requests', details: 'More than 30 ask units in the last minute.', scope: 'per-minute' }, 'fallback'),
    'Too many requests — More than 30 ask units in the last minute. Try again in 42 s.',
  );

  {
    const fixedNow = Date.parse('2026-09-19T12:00:00Z');
    const httpDate = new Date(fixedNow + 15_000).toUTCString();
    // messageFromResponse has no `now` parameter (it measures from the real
    // clock, same as a live Retry-After header would be), so this checks
    // against the actual wall clock rather than `fixedNow`.
    const realNow = Date.now();
    const liveHttpDate = new Date(realNow + 15_000).toUTCString();
    eq(
      'messageFromResponse: an HTTP-date Retry-After is converted to seconds-from-now',
      messageFromResponse(res(429, liveHttpDate), { error: 'Too many requests' }, 'fallback'),
      'Too many requests Try again in 15 s.',
    );
    eq('parseRetryAfterSeconds: HTTP-date form, computed against a fixed now', parseRetryAfterSeconds(httpDate, fixedNow), 15);
    eq('parseRetryAfterSeconds: numeric form ignores now', parseRetryAfterSeconds('7', fixedNow), 7);
    eq('parseRetryAfterSeconds: missing header is undefined', parseRetryAfterSeconds(null), undefined);
    eq('parseRetryAfterSeconds: garbage header is undefined', parseRetryAfterSeconds('not-a-date-or-number', fixedNow), undefined);
  }

  eq(
    'messageFromResponse: a scope:"per-day" body says "tomorrow", not a seconds count, even with Retry-After set',
    messageFromResponse(res(429, '86399'), { error: 'Too many requests', details: 'Daily limit of 2000 ingest units reached for this tenant.', scope: 'per-day' }, 'fallback'),
    'Too many requests — Daily limit of 2000 ingest units reached for this tenant. Try again tomorrow.',
  );
  check('isDailyCap: scope "per-day" is a daily cap', isDailyCap({ scope: 'per-day' }));
  check('isDailyCap: scope "per-minute" is not', !isDailyCap({ scope: 'per-minute' }));

  eq(
    'messageFromResponse: the daily model-spend budget body (no scope, "resumes tomorrow") also says "tomorrow"',
    messageFromResponse(res(429, '3600'), { error: 'Daily AI budget reached — resumes tomorrow' }, 'fallback'),
    'Daily AI budget reached — resumes tomorrow Try again tomorrow.',
  );
  check('isDailyCap: recognizes the daily-budget wording with no scope field', isDailyCap({ error: 'Daily AI budget reached — resumes tomorrow' }));

  eq(
    'messageFromResponse: a plain 500 with no error/details body falls back to the caller-supplied fallback, untouched',
    messageFromResponse(res(500, null), null, '500 Internal Server Error'),
    '500 Internal Server Error',
  );
  eq(
    'messageFromResponse: a 429 with no Retry-After header and no daily indication appends nothing',
    messageFromResponse(res(429, null), { error: 'Too many requests' }, 'fallback'),
    'Too many requests',
  );
}

/* ------------------------------------------------------ bulk import UI helpers */
//
// The archive-walk/uploader logic itself (classifyEntry, backoff, concurrency,
// batch presign shaping) is covered by scripts/verify-bulk.mjs. What belongs
// here is the two functions IntakeScreen's bulk-import panel calls directly
// to render: the row-count cap and the total/uploaded/queued/skipped/failed
// summary.
{
  const state = (status: BulkFileState['status'], overrides: Partial<BulkFileState> = {}): BulkFileState => ({
    path: `f-${status}`,
    name: `f-${status}`,
    sizeBytes: 100,
    status,
    attempt: 0,
    ...overrides,
  });

  const { shown, hiddenCount } = truncateForDisplay(Array.from({ length: 250 }, (_, i) => i));
  check('truncateForDisplay caps at 200 rows by default', shown.length === 200 && hiddenCount === 50);
  eq('truncateForDisplay does not truncate under the cap', truncateForDisplay([1, 2, 3]), { shown: [1, 2, 3], hiddenCount: 0 });
  eq('truncateForDisplay respects an explicit max', truncateForDisplay([1, 2, 3, 4], 2), { shown: [1, 2], hiddenCount: 2 });

  const summary = summarizeProgress([
    state('done'),
    state('queued'),
    state('queued'),
    state('skipped'),
    state('failed'),
    state('cancelled'),
    state('uploading'),
  ]);
  eq('summarizeProgress counts each bucket correctly, with queued files counted as uploaded too', summary, {
    total: 7,
    uploaded: 3, // 1 done + 2 queued
    queued: 2,
    skipped: 1,
    failed: 2, // failed + cancelled
    pending: 1, // uploading
  });
  eq('summarizeProgress on an empty run', summarizeProgress([]), { total: 0, uploaded: 0, queued: 0, skipped: 0, failed: 0, pending: 0 });
}

/* ------------------------------------------------- documentTypes parity */
//
// src/domains/hvac/documentTypes.ts is a hand-mirrored copy of the real
// source of truth, api/_lib/documentTypes.js (agent-backend's file — src/
// cannot import api/, different tsconfig root/build). This is the check the
// team brief asks for: import the JS module directly (tsx runs plain .js
// fine) and assert the two agree, so an edit to one that isn't mirrored to
// the other fails CI instead of silently reintroducing "Unclassified".
{
  eq('DOCUMENT_TYPES ids match the backend exactly', hvacDocTypes.DOCUMENT_TYPES.map((t) => t.id), backendDocTypes.DOCUMENT_TYPES.map((t: { id: string }) => t.id));
  eq('DOCUMENT_TYPES labels match the backend exactly', hvacDocTypes.DOCUMENT_TYPES.map((t) => t.label), backendDocTypes.DOCUMENT_TYPES.map((t: { label: string }) => t.label));
  eq('there are exactly the 15 canonical types the brief lists', hvacDocTypes.DOCUMENT_TYPES.length, 15);
  eq('REQUIRED_FIELDS matches the backend exactly, including a|b alternatives', hvacDocTypes.REQUIRED_FIELDS, backendDocTypes.REQUIRED_FIELDS);
  eq('FIELD_LABELS matches the backend exactly', hvacDocTypes.FIELD_LABELS, backendDocTypes.FIELD_LABELS);
  eq('AI_VERIFY_MIN_CONFIDENCE matches the backend', hvacDocTypes.AI_VERIFY_MIN_CONFIDENCE, backendDocTypes.AI_VERIFY_MIN_CONFIDENCE);

  const cases: [string, Record<string, unknown>?][] = [
    ['warranty', undefined],
    ['service_ticket', undefined],
    ['install_record', { cost: '100' }],
    ['install_record', {}],
    ['equipment_record', undefined],
    ['document', undefined],
    ['unclassified', undefined],
    ['', undefined],
    ['work-order', undefined],
    ['Not A Real Type', undefined],
  ];
  for (const [raw, facts] of cases) {
    eq(
      `normalizeDocumentType(${JSON.stringify(raw)}) matches the backend`,
      hvacDocTypes.normalizeDocumentType(raw, facts),
      backendDocTypes.normalizeDocumentType(raw, facts),
    );
  }
}

/* --------------------------------------- maxStageFor / recomputeIssues */
//
// Required fields can be `a|b` alternatives (CANONICAL REQUIRED FIELDS in the
// team brief) — either extracted field key must satisfy the requirement, and
// this is the one thing entityGraph.ts's stage math has to get right or every
// document sits "Blocked at Classified" despite having what it needs.
{
  const baseDoc = (overrides: Partial<Doc> = {}): Doc => ({
    id: 'doc-1',
    filename: 'test.pdf',
    fileType: 'pdf',
    pages: 1,
    batchId: 'b1',
    source: 'drive',
    receivedAt: new Date('2026-01-01'),
    typeId: null,
    stage: 'received',
    extracted: [],
    linkedEntityIds: [],
    linkConfidence: 0,
    issues: [],
    preview: '',
    ...overrides,
  });
  const field = (name: string, value = 'x', confidence = 0.95) => ({ name, value, confidence, location: {} });

  // warranty-registration requires serial_number, model, warranty_expires|warranty_term
  const onlyTerm = baseDoc({
    typeId: 'warranty-registration',
    extracted: [field('serial_number'), field('model'), field('warranty_term')],
    linkedEntityIds: ['prop-1'],
  });
  eq('maxStageFor: warranty_term alone satisfies warranty_expires|warranty_term', maxStageFor(onlyTerm, hvacSchema), 'verified');

  const neitherAlt = baseDoc({
    typeId: 'warranty-registration',
    extracted: [field('serial_number'), field('model')],
    linkedEntityIds: ['prop-1'],
  });
  eq('maxStageFor: neither alternative present stays Blocked at Classified', maxStageFor(neitherAlt, hvacSchema), 'classified');

  const expiresAlt = baseDoc({
    typeId: 'warranty-registration',
    extracted: [field('serial_number'), field('model'), field('warranty_expires')],
  });
  eq('maxStageFor: the other alternative (warranty_expires) also satisfies it', maxStageFor(expiresAlt, hvacSchema), 'extracted');

  // A correction with an empty value does not count as satisfying a requirement
  const blankCorrection = baseDoc({
    typeId: 'startup-sheet', // requires serial_number, service_date
    extracted: [{ ...field('serial_number'), correctedValue: '  ' }, field('service_date')],
  });
  eq('maxStageFor: a blank correction does not satisfy a requirement', maxStageFor(blankCorrection, hvacSchema), 'classified');

  // recomputeIssues: a synced document (no issues yet) with a real gap gets a
  // missing-field issue naming the still-unsatisfied requirement, and an
  // unlinked issue since nothing has linked it — exactly what Records' health
  // tiles and Review's filters read.
  const synced = baseDoc({
    typeId: 'warranty-registration',
    extracted: [field('serial_number'), field('model')],
    issues: [],
  });
  const recomputed = recomputeIssues(synced, hvacSchema);
  check('recomputeIssues: flags the unsatisfied a|b requirement as missing', recomputed.issues.some((i) => i.kind === 'missing-field' && i.field === 'warranty_expires|warranty_term'), JSON.stringify(recomputed.issues));
  check('recomputeIssues: flags an unattached classified document as unlinked', recomputed.issues.some((i) => i.kind === 'unlinked'), JSON.stringify(recomputed.issues));

  const linkedComplete = baseDoc({
    typeId: 'warranty-registration',
    extracted: [field('serial_number'), field('model'), field('warranty_expires')],
    linkedEntityIds: ['prop-1'],
    issues: [],
  });
  eq('recomputeIssues: nothing to flag once complete and linked', recomputeIssues(linkedComplete, hvacSchema).issues, []);

  // A demo-seeded bestGuess unlinked issue is preserved, not replaced by a bare one
  const seeded = baseDoc({
    typeId: 'work-order',
    extracted: [field('service_address'), field('service_date'), field('technician')],
    issues: [{ kind: 'unlinked', bestGuess: 'prop-9', confidence: 0.6 }],
  });
  const seededRecomputed = recomputeIssues(seeded, hvacSchema);
  eq('recomputeIssues: preserves a seeded unlinked issue instead of duplicating it', seededRecomputed.issues.length, 1);
  check('recomputeIssues: the preserved issue keeps its bestGuess', seededRecomputed.issues[0]?.kind === 'unlinked' && seededRecomputed.issues[0].bestGuess === 'prop-9');
}

/* ---------------------------------------------- UX flow / copy truth-pass */
//
// The 2026-09-19 UX flow spec (handoffs/UX_FLOW_SPEC_2026-09-19.md) retired a
// batch of internal pipeline jargon from the UI, renamed the five pipeline
// stages for display, and cut the nav down to exactly four items. These are
// static checks — no DOM, no store — so a later edit that reintroduces the
// jargon (or drifts the stage/nav shape) fails CI instead of shipping quietly.

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFilesRecursive(full));
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

{
  const RETIRED_JARGON = ['Unlinked inbox', 'Blocked at Classified', 'Required-field gaps', 'can reach', 'Reclassify & verify'];
  const scanned = [...listFilesRecursive(join(SCRIPT_DIR, '..', 'src', 'screens')), ...listFilesRecursive(join(SCRIPT_DIR, '..', 'src', 'components'))];
  check(`scanned at least one screen and one component file (${scanned.length} files)`, scanned.length > 5);
  for (const term of RETIRED_JARGON) {
    const hits = scanned.filter((f) => readFileSync(f, 'utf8').includes(term));
    check(`no retired jargon "${term}" in src/screens or src/components`, hits.length === 0, hits.join(', '));
  }
}

{
  eq('STAGE_LABEL maps all five pipeline stages to their plain-language display names', STAGE_LABEL, {
    received: 'Uploaded',
    classified: 'Sorted',
    extracted: 'Read',
    linked: 'Matched',
    verified: 'Checked',
  });
  check('STAGE_LABEL has an entry for every PipelineStage value, no more, no fewer', PIPELINE_STAGES.every((s) => s in STAGE_LABEL) && Object.keys(STAGE_LABEL).length === PIPELINE_STAGES.length);
}

{
  eq('the primary nav is exactly Ask, Dashboard, Inbox, Records, in that order (owner 2026-09-20: Dashboard beside Ask)', NAV.map((n) => n.label), ['Ask', 'Dashboard', 'Inbox', 'Records']);
  check('the nav array has exactly 4 items', NAV.length === 4);
}

/* ------------------------------------- Review queue vs. tile-count agreement */
//
// Reviewer NO-GO fix: ReviewScreen's filter predicate and DataHealthStrip's
// tile counts must always agree on which documents count as "unlinked" /
// "gaps" / "conflicts" — both now read the exact same entityGraph.ts helpers
// (unlinkedDocs/gapDocs/conflictDocs). This builds one fixture graph and
// checks ReviewScreen's exported docsMatchingFilter returns the identical
// document-id set as the bare helper, for every filter that's shared.
{
  const doc = (id: string, overrides: Partial<Doc> = {}): Doc => ({
    id,
    filename: `${id}.pdf`,
    fileType: 'pdf',
    pages: 1,
    batchId: 'b1',
    source: 'drive',
    receivedAt: new Date('2026-01-01'),
    typeId: null,
    stage: 'classified',
    extracted: [],
    linkedEntityIds: [],
    linkConfidence: 0,
    issues: [],
    preview: '',
    ...overrides,
  });

  const fixture: GraphSnapshot = {
    schema: hvacSchema,
    entities: {},
    batches: {},
    docs: {
      unlinkedDoc: doc('unlinkedDoc', { issues: [{ kind: 'unlinked', confidence: 0 }] }),
      gapDoc: doc('gapDoc', { issues: [{ kind: 'missing-field', field: 'serial_number' }] }),
      conflictDoc: doc('conflictDoc', { stage: 'linked' }),
      cleanDoc: doc('cleanDoc', { stage: 'verified' }),
    },
    conflicts: {
      c1: { id: 'c1', entityId: 'prop-1', field: 'address', candidates: [{ value: 'a', documentId: 'conflictDoc', location: {} }] },
    },
    lastError: null,
  };

  const ids = (list: Doc[]) => list.map((d) => d.id).sort();
  const shared: [string, (g: GraphSnapshot) => Doc[]][] = [
    ['unlinked', unlinkedDocs],
    ['gaps', gapDocs],
    ['conflicts', conflictDocs],
  ];
  for (const [filterId, helper] of shared) {
    eq(
      `ReviewScreen's "${filterId}" filter matches DataHealthStrip's helper on a fixture graph`,
      ids(docsMatchingFilter(fixture, filterId as Parameters<typeof docsMatchingFilter>[1])),
      ids(helper(fixture)),
    );
  }
}

/* ------------------------------------------- ingest progress idle detection */
//
// Reviewer NO-GO fix: selectIngestProgress (appStore.ts) derives the AppShell
// header's "Processing N of M…" indicator straight from store state, so it
// must go idle (null) exactly when every in-flight upload/bulk item has
// settled, and never sit stuck non-null just because a component unmounted.
{
  const upload = (status: IngestProgress['status']): IngestProgress => ({ filename: `${status}.pdf`, status });
  // No server-side processing tracked, for every case that isn't testing it.
  const noProcessing = { processingPending: [] as string[], processingTotal: 0, processingStalled: false };

  eq('selectIngestProgress: no uploads, no bulk run → idle', selectIngestProgress({ uploads: {}, bulkRunning: false, bulkStates: [], ...noProcessing }), null);

  eq(
    'selectIngestProgress: one upload still hashing → not idle',
    selectIngestProgress({ uploads: { a: upload('hashing') }, bulkRunning: false, bulkStates: [], ...noProcessing }),
    { current: 0, total: 1 },
  );

  eq(
    'selectIngestProgress: every upload settled (done/error/pending) → idle',
    selectIngestProgress({
      uploads: { a: upload('done'), b: upload('error'), c: upload('pending') },
      bulkRunning: false,
      bulkStates: [],
      ...noProcessing,
    }),
    null,
  );

  eq(
    'selectIngestProgress: one upload still in flight among settled ones → not idle',
    selectIngestProgress({
      uploads: { a: upload('done'), b: upload('uploading') },
      bulkRunning: false,
      bulkStates: [],
      ...noProcessing,
    }),
    { current: 1, total: 2 },
  );

  const bulkState = (status: BulkFileState['status']): BulkFileState => ({ path: status, name: status, sizeBytes: 1, status, attempt: 0 });
  eq(
    'selectIngestProgress: bulkRunning true → reflects bulk summary, not idle',
    selectIngestProgress({ uploads: {}, bulkRunning: true, bulkStates: [bulkState('done'), bulkState('uploading')], ...noProcessing }),
    { current: 1, total: 2 },
  );

  eq(
    'selectIngestProgress: bulkRunning flips to false after completion → idle even with stale settled bulkStates',
    selectIngestProgress({ uploads: {}, bulkRunning: false, bulkStates: [bulkState('done'), bulkState('failed')], ...noProcessing }),
    null,
  );

  // Fix for QA FAIL #4: the client-side transfer settling must not hide
  // server-side classify/extract/link/verify processing that is still going.
  eq(
    'selectIngestProgress: transfer done, server-side docs still pending → shows processing',
    selectIngestProgress({ uploads: { a: upload('done') }, bulkRunning: false, bulkStates: [], processingPending: ['doc-1', 'doc-2'], processingTotal: 3, processingStalled: false }),
    { current: 1, total: 3, stalled: false },
  );

  eq(
    'selectIngestProgress: nothing uploaded this session, no server-side docs pending → idle',
    selectIngestProgress({ uploads: {}, bulkRunning: false, bulkStates: [], ...noProcessing }),
    null,
  );

  eq(
    'selectIngestProgress: past the ten-minute cap → stalled, not idle',
    selectIngestProgress({ uploads: {}, bulkRunning: false, bulkStates: [], processingPending: ['doc-1'], processingTotal: 2, processingStalled: true }),
    { current: 1, total: 2, stalled: true },
  );
}

/* ---------------------------------------------------- billing: status reducer */
//
// billingClient.ts's daysUntil/billingBannerFor drive AppShell's global
// banner and BillingScreen's trial countdown — see handoffs/BILLING_RULES.md.
// Pure functions, tested here with a fixed `now` so the checks never flake
// near a day boundary.
{
  const NOW = new Date('2026-09-20T12:00:00Z');

  eq('daysUntil: null/undefined input is null', [daysUntil(null, NOW), daysUntil(undefined, NOW)], [null, null]);
  eq('daysUntil: an unparseable date is null', daysUntil('not-a-date', NOW), null);
  eq('daysUntil: exactly 3 days out rounds to 3', daysUntil('2026-09-23T12:00:00Z', NOW), 3);
  eq('daysUntil: 3 days + 1 hour rounds UP to 4 (never undercounts a trial)', daysUntil('2026-09-23T13:00:00Z', NOW), 4);
  eq('daysUntil: a past date clamps to 0, never negative', daysUntil('2026-09-01T00:00:00Z', NOW), 0);
  eq('daysUntil: 30 minutes out still rounds up to 1', daysUntil('2026-09-20T12:30:00Z', NOW), 1);

  const status = (overrides: Partial<BillingStatus> = {}): BillingStatus => ({
    plan: null,
    status: 'none',
    trialEndsAt: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    limits: {},
    usage: { documentsStored: 0, pagesThisMonth: 0 },
    ...overrides,
  });

  eq('billingBannerFor: null status → no banner', billingBannerFor(null, NOW), null);
  eq('billingBannerFor: active, under cap → no banner', billingBannerFor(status({ plan: 'solo', status: 'active' }), NOW), null);
  eq(
    'billingBannerFor: trialing shows a pluralized days-left count',
    billingBannerFor(status({ plan: 'solo', status: 'trialing', trialEndsAt: '2026-09-23T12:00:00Z' }), NOW),
    { kind: 'trialing', message: 'Your free trial ends in 3 days.' },
  );
  eq(
    'billingBannerFor: exactly 1 day left is singular, not "1 days"',
    billingBannerFor(status({ plan: 'solo', status: 'trialing', trialEndsAt: '2026-09-21T12:00:00Z' }), NOW),
    { kind: 'trialing', message: 'Your free trial ends in 1 day.' },
  );
  eq(
    'billingBannerFor: a trial whose end has already passed says "ends today", not a negative count',
    billingBannerFor(status({ plan: 'solo', status: 'trialing', trialEndsAt: '2026-09-01T00:00:00Z' }), NOW),
    { kind: 'trialing', message: 'Your free trial ends today.' },
  );
  eq(
    'billingBannerFor: past_due always warns, regardless of usage',
    billingBannerFor(status({ plan: 'shop', status: 'past_due' }), NOW),
    { kind: 'past_due', message: 'Your last payment failed. Update billing to keep uploading.' },
  );
  eq(
    'billingBannerFor: never-subscribed under the free-preview cap → no banner',
    billingBannerFor(status({ status: 'none', usage: { documentsStored: 2, pagesThisMonth: 0 } }), NOW),
    null,
  );
  eq(
    'billingBannerFor: never-subscribed at the free-preview cap → the trial nudge',
    billingBannerFor(status({ status: 'none', usage: { documentsStored: 3, pagesThisMonth: 0 } }), NOW),
    { kind: 'cap', message: 'Free preview used up. Start your 30-day trial to keep going.' },
  );
  eq('billingBannerFor: canceled shows no banner (upload/ask already hard-block with their own 402)', billingBannerFor(status({ status: 'canceled' }), NOW), null);

  eq('annualPrice: one month free is 11x monthly, for every catalog price', [annualPrice(99), annualPrice(199), annualPrice(399), annualPrice(899)], [1089, 2189, 4389, 9889]);
}

/* --------------------------------------------------- billing: Records Rescue */
//
// resolveRecordsRescueQuantity/recordsRescueTotalCents must match
// api/_lib/billing.js's identical functions exactly — this is the number
// BillingScreen shows the person before checkout charges the real thing.
{
  eq('resolveRecordsRescueQuantity: below the minimum clamps up to it', resolveRecordsRescueQuantity(100), RECORDS_RESCUE_MIN_PAGES);
  eq('resolveRecordsRescueQuantity: exactly the minimum is unchanged', resolveRecordsRescueQuantity(RECORDS_RESCUE_MIN_PAGES), RECORDS_RESCUE_MIN_PAGES);
  eq('resolveRecordsRescueQuantity: above the minimum is unchanged', resolveRecordsRescueQuantity(10_000), 10_000);
  eq('resolveRecordsRescueQuantity: a fractional page count truncates', resolveRecordsRescueQuantity(5000.9), 5000);
  eq('resolveRecordsRescueQuantity: garbage input (NaN/negative) clamps to the minimum', [resolveRecordsRescueQuantity(NaN), resolveRecordsRescueQuantity(-50)], [RECORDS_RESCUE_MIN_PAGES, RECORDS_RESCUE_MIN_PAGES]);

  eq('recordsRescueTotalCents: at the minimum is ~$500 (4,167 * $0.12)', recordsRescueTotalCents(RECORDS_RESCUE_MIN_PAGES), 50_004);
  eq('recordsRescueTotalCents: below the minimum is still priced at the minimum', recordsRescueTotalCents(1), 50_004);
  eq('recordsRescueTotalCents: 10,000 pages at $0.12/page', recordsRescueTotalCents(10_000), 120_000);
}

/* ------------------------------------------------------ customer profiles */
//
// customerClient.ts's number/uuid classification and CustomerProfileScreen's
// timeline sort — see handoffs/CUSTOMER_PROFILES_BRIEF_2026-09-20.md section
// E. isValidCustomerNumber mirrors api/_lib/routes/customers.js's
// CUSTOMER_NUMBER_RE exactly (src/ can't import api/ — see the
// documentTypes-parity block above for why that's a hand-mirrored copy here
// too), so this is the check that keeps the two from drifting silently.
{
  check('isValidCustomerNumber accepts the canonical C-00001..C-99999 shape', isValidCustomerNumber('C-00001') && isValidCustomerNumber('C-99999'));
  check(
    'isValidCustomerNumber rejects anything else',
    !isValidCustomerNumber('c-00001') && // lowercase
      !isValidCustomerNumber('C-1') && // too few digits
      !isValidCustomerNumber('C-000001') && // too many digits
      !isValidCustomerNumber('C00001') && // missing dash
      !isValidCustomerNumber('') &&
      !isValidCustomerNumber(null) &&
      !isValidCustomerNumber(undefined),
  );

  check('isUuid accepts a real uuid, case-insensitively', isUuid('3fa85f64-5717-4562-b3fc-2c963f66afa6') && isUuid('3FA85F64-5717-4562-B3FC-2C963F66AFA6'));
  check('isUuid rejects a customer number and garbage', !isUuid('C-00012') && !isUuid('not-a-uuid') && !isUuid(null));

  eq('refKind: a uuid is classified as "id"', refKind('3fa85f64-5717-4562-b3fc-2c963f66afa6'), 'id');
  eq('refKind: a C-00012 is classified as "number"', refKind('C-00012'), 'number');
  eq('refKind: neither shape is null', refKind('bob smith'), null);

  const entry = (date: string, title: string): ReturnType<typeof sortTimelineDesc>[number] => ({ date, kind: 'document', title, documentId: null });
  eq(
    'sortTimelineDesc: most recent first',
    sortTimelineDesc([entry('2025-01-01', 'oldest'), entry('2026-06-01', 'newest'), entry('2025-06-01', 'middle')]).map((e) => e.title),
    ['newest', 'middle', 'oldest'],
  );
  eq(
    'sortTimelineDesc: a full ISO timestamp and a bare YYYY-MM-DD day sort correctly against each other',
    sortTimelineDesc([entry('2026-01-01', 'day'), entry('2026-01-01T23:00:00Z', 'timestamp same day')]).map((e) => e.title),
    ['timestamp same day', 'day'],
  );
  eq('sortTimelineDesc: empty input stays empty', sortTimelineDesc([]), []);
  eq('sortTimelineDesc: does not mutate its input', (() => { const input = [entry('2025-01-01', 'a'), entry('2026-01-01', 'b')]; sortTimelineDesc(input); return input.map((e) => e.title); })(), ['a', 'b']);
}

/* --------------------------------------------------------- org invites / Team */
//
// handoffs/ORG_INVITES_AUDIT.md: TeamScreen.tsx and AppShell.tsx's admin-only
// "Team" button both gate on teamClient.ts's isAdminRole, and the seat
// display comes from teamClient.ts's seatStatus. Both are pure — no Clerk
// SDK, no DOM — so role→UI-visibility and seats math are checked here the
// same way every other pure function in this file is.
{
  check('isAdminRole: bare "admin" is admin', isAdminRole('admin'));
  check('isAdminRole: v1-shaped "org:admin" is admin', isAdminRole('org:admin'));
  check('isAdminRole: case-insensitive', isAdminRole('Admin') && isAdminRole('ADMIN'));
  check('isAdminRole: "member" is not admin', !isAdminRole('member'));
  check('isAdminRole: "org:member" is not admin', !isAdminRole('org:member'));
  check('isAdminRole: an unrecognized custom role is not admin (least privilege, same as the server)', !isAdminRole('org:billing_manager'));
  check('isAdminRole: null/undefined/empty is not admin', !isAdminRole(null) && !isAdminRole(undefined) && !isAdminRole(''));

  eq('seatStatus: under cap is not at cap, "N of M seats" label', seatStatus(3, 4), { count: 3, cap: 4, atCap: false, label: '3 of 4 seats' });
  eq('seatStatus: exactly at cap IS at cap', seatStatus(4, 4), { count: 4, cap: 4, atCap: true, label: '4 of 4 seats' });
  eq('seatStatus: over cap (a seat removed on Clerk\'s side after billing downgraded) is still at cap, not negative', seatStatus(5, 4), { count: 5, cap: 4, atCap: true, label: '5 of 4 seats' });
  eq('seatStatus: null cap (Fleet, uncapped) is never at cap', seatStatus(50, null), { count: 50, cap: null, atCap: false, label: '50 members' });
  eq('seatStatus: undefined cap (billing status not loaded yet) behaves like null', seatStatus(2, undefined), { count: 2, cap: null, atCap: false, label: '2 members' });
  eq('seatStatus: singular "1 of 1 seat" / "1 member" wording', [seatStatus(1, 1).label, seatStatus(1, null).label], ['1 of 1 seat', '1 member']);
  eq('seatStatus: zero members on a solo plan', seatStatus(0, 1), { count: 0, cap: 1, atCap: false, label: '0 of 1 seat' });

  // The primary nav stays exactly 4 items (checked above) — Team is
  // deliberately NOT one of them; it lives in the account-area row next to
  // Billing (AppShell.tsx), gated on isAdminRole, same as this check assumes.
  check('Team is not one of the 4 primary nav destinations', !NAV.some((n) => n.screen === 'team'));
}

/* ----------------------------------------------------------- notifications */
//
// handoffs/NOTIFICATIONS.md: the bell icon's badge math and its in-app-link
// parsing (NotificationsPanel.tsx), both pure so they're checked here with
// no DOM.
{
  eq('unreadBadgeLabel: zero is blank (no badge rendered)', unreadBadgeLabel(0), '');
  eq('unreadBadgeLabel: negative (should never happen) is also blank', unreadBadgeLabel(-1), '');
  eq('unreadBadgeLabel: small counts render exactly', unreadBadgeLabel(1), '1');
  eq('unreadBadgeLabel: 9 renders exactly', unreadBadgeLabel(9), '9');
  eq('unreadBadgeLabel: 10+ caps at "9+"', unreadBadgeLabel(10), '9+');
  eq('unreadBadgeLabel: a large count still caps at "9+"', unreadBadgeLabel(200), '9+');

  eq('parseNotificationLink: extracts the entity id', parseNotificationLink('/app/?entity=abc-123'), { entityId: 'abc-123' });
  eq('parseNotificationLink: null link -> nothing', parseNotificationLink(null), {});
  eq('parseNotificationLink: a link with no recognized params -> nothing', parseNotificationLink('/app/?bogus=1'), {});
  // Regression: these two used to fall through to "-> nothing" (and
  // NotificationsPanel then sent the click to the Dashboard) because the old
  // parser only ever looked for `?entity=`. outreach.js and followups.js
  // both write real notification rows with exactly these link shapes.
  eq('parseNotificationLink: the outreach route\'s link carries its screen', parseNotificationLink('/app/?screen=outreach'), { screen: 'outreach' });
  eq(
    'parseNotificationLink: a follow-up\'s absolute link carries screen + work filter',
    parseNotificationLink('https://deepwelltechnology.com/app/?screen=inbox&work=mine'),
    { screen: 'review', workFilter: 'mine' },
  );
}

/* ----------------------------------------------------------------- outreach */
//
// handoffs/OUTREACH_2026-09-20.md: the Dashboard card's "sent this month"
// count. api/_lib/outreach.js's own pure logic (template rendering, tier
// mapping, dedupe, opt-out, batching) is checked in scripts/verify-outreach.mjs
// instead — this file only covers the one bit of outreach logic that lives
// in src/.
{
  const msg = (over: Partial<OutreachMessage>): OutreachMessage => ({
    id: 'm1', tier: 'expiring-90', equipmentId: 'eq-1', toEmail: 'a@example.com', subject: 's', preview: 'p',
    status: 'sent', customerNumber: null, customerName: null, unit: null, serialLast4: null,
    createdAt: '2026-09-01T00:00:00Z', approvedAt: null, sentAt: '2026-09-05T00:00:00Z', error: null, ...over,
  });
  const now = new Date('2026-09-20T12:00:00Z');
  eq('sentThisMonth: counts a sent message from this month', sentThisMonth([msg({})], now), 1);
  eq('sentThisMonth: ignores a draft (not sent)', sentThisMonth([msg({ status: 'draft', sentAt: null })], now), 0);
  eq('sentThisMonth: ignores a message sent last month', sentThisMonth([msg({ sentAt: '2026-08-30T00:00:00Z' })], now), 0);
  eq('sentThisMonth: ignores a failed send even if sentAt is set', sentThisMonth([msg({ status: 'failed' })], now), 0);
  eq('sentThisMonth: sums multiple sent messages this month', sentThisMonth([msg({ id: 'a' }), msg({ id: 'b' })], now), 2);
}

/* --------------------------------------------------------- customer filters
 * Owner feedback 2026-09-20: "the filters don't fully work as they should —
 * seems like you just threw those filters in and didn't logically set them
 * up." One 6-customer fixture, built to hit every branch of every function
 * in core/customerFilters.ts, used across all the blocks below. */
{
  type C = CustomerSummary;
  const c1: C = { id: 'c1', customerNumber: 'C-00001', name: 'Ray Castillo', serviceAddress: '1 Main St', city: 'Sterling', phone: '555-123-4567', email: 'ray@example.com', documentCount: 3, equipmentCount: 2, lastActivity: '2026-09-15', warrantyAlerts: 1, alerts: { expiring: 1, expired: 0 }, mergedInto: null };
  const c2: C = { id: 'c2', customerNumber: 'C-00002', name: 'Acme HVAC LLC', serviceAddress: null, city: 'Sterling', phone: null, email: null, documentCount: 1, equipmentCount: 0, lastActivity: null, warrantyAlerts: 1, alerts: { expiring: 0, expired: 1 }, mergedInto: null };
  const c3: C = { id: 'c3', customerNumber: 'C-00003', name: 'Jane Diaz', serviceAddress: '2 Oak Ave', city: 'Reston', phone: null, email: 'jane@example.com', documentCount: 10, equipmentCount: 5, lastActivity: '2026-01-01', warrantyAlerts: 2, alerts: { expiring: 1, expired: 1 }, mergedInto: null };
  const c4: C = { id: 'c4', customerNumber: 'C-00004', name: 'Bob Smith', serviceAddress: '4 Pine Ln', city: null, phone: '555-999-8888', email: null, documentCount: 1, equipmentCount: 1, lastActivity: '2026-09-19', warrantyAlerts: 0, alerts: { expiring: 0, expired: 0 }, mergedInto: null };
  const c5: C = { id: 'c5', customerNumber: 'C-00005', name: 'Zach Young', serviceAddress: null, city: 'Reston', phone: null, email: null, documentCount: 0, equipmentCount: 0, lastActivity: null, warrantyAlerts: 0, alerts: { expiring: 0, expired: 0 }, mergedInto: null };
  const c6: C = { id: 'c6', customerNumber: 'C-00006', name: 'Desert Comfort Cooling', serviceAddress: null, city: 'Tempe', phone: null, email: null, documentCount: 2, equipmentCount: 3, lastActivity: '2026-09-18', warrantyAlerts: 0, alerts: { expiring: 0, expired: 0 }, mergedInto: null };
  const all: C[] = [c1, c2, c3, c4, c5, c6];
  const now = new Date('2026-09-20T00:00:00Z');
  const ids = (rows: C[]) => rows.map((r) => r.id);

  /* ---- matchesCustomerFilters: alerts (any/expiring/expired/attention/none) */
  check('alerts=any matches everyone', all.every((c) => matchesCustomerFilters(c, DEFAULT_CUSTOMER_FILTERS, now)));
  eq('alerts=expiring keeps only expiring>0', all.filter((c) => matchesCustomerFilters(c, { ...DEFAULT_CUSTOMER_FILTERS, alerts: 'expiring' }, now)).map((c) => c.id), ['c1', 'c3']);
  eq('alerts=expired keeps only expired>0', all.filter((c) => matchesCustomerFilters(c, { ...DEFAULT_CUSTOMER_FILTERS, alerts: 'expired' }, now)).map((c) => c.id), ['c2', 'c3']);
  eq('alerts=attention keeps either>0 (union, not just both)', all.filter((c) => matchesCustomerFilters(c, { ...DEFAULT_CUSTOMER_FILTERS, alerts: 'attention' }, now)).map((c) => c.id), ['c1', 'c2', 'c3']);
  eq('alerts=none keeps only both-zero', all.filter((c) => matchesCustomerFilters(c, { ...DEFAULT_CUSTOMER_FILTERS, alerts: 'none' }, now)).map((c) => c.id), ['c4', 'c5', 'c6']);

  /* ---- equipment (any/has/none) */
  eq('equipment=has keeps equipmentCount>0', all.filter((c) => matchesCustomerFilters(c, { ...DEFAULT_CUSTOMER_FILTERS, equipment: 'has' }, now)).map((c) => c.id), ['c1', 'c3', 'c4', 'c6']);
  eq('equipment=none keeps equipmentCount===0', all.filter((c) => matchesCustomerFilters(c, { ...DEFAULT_CUSTOMER_FILTERS, equipment: 'none' }, now)).map((c) => c.id), ['c2', 'c5']);

  /* ---- city (case-insensitive; null row never matches a chosen city) */
  eq('city=Sterling (typed lowercase) keeps only Sterling rows', all.filter((c) => matchesCustomerFilters(c, { ...DEFAULT_CUSTOMER_FILTERS, city: 'sterling' }, now)).map((c) => c.id), ['c1', 'c2']);
  check('a null-city row never matches a chosen city', !matchesCustomerFilters(c4, { ...DEFAULT_CUSTOMER_FILTERS, city: 'Sterling' }, now));

  /* ---- lastActivity (default never hides for missing activity; a window does) */
  check('lastActivity=any never excludes for missing activity', matchesCustomerFilters(c2, DEFAULT_CUSTOMER_FILTERS, now));
  eq('lastActivity=30 keeps only activity within 30 days, excludes null', all.filter((c) => matchesCustomerFilters(c, { ...DEFAULT_CUSTOMER_FILTERS, lastActivity: 30 }, now)).map((c) => c.id), ['c1', 'c4', 'c6']);
  eq('lastActivity=90 widens the window but still excludes null and the Jan 1 row', all.filter((c) => matchesCustomerFilters(c, { ...DEFAULT_CUSTOMER_FILTERS, lastActivity: 90 }, now)).map((c) => c.id), ['c1', 'c4', 'c6']);
  eq('lastActivity=365 finally includes the stale Jan 1 row, still excludes null', all.filter((c) => matchesCustomerFilters(c, { ...DEFAULT_CUSTOMER_FILTERS, lastActivity: 365 }, now)).map((c) => c.id), ['c1', 'c3', 'c4', 'c6']);

  /* ---- combined AND, not OR */
  const combo: CustomerFilters = { alerts: 'any', equipment: 'has', city: 'Reston', lastActivity: 'any' };
  eq('every criterion ANDs together', all.filter((c) => matchesCustomerFilters(c, combo, now)).map((c) => c.id), ['c3']);

  /* ---- describeActiveFilters: chips */
  eq('defaults produce no chips', describeActiveFilters(DEFAULT_CUSTOMER_FILTERS), []);
  eq(
    'one chip per non-default dropdown, in a stable order',
    describeActiveFilters({ alerts: 'expired', equipment: 'any', city: 'Reston', lastActivity: 90 }),
    [{ key: 'alerts', label: 'Expired' }, { key: 'city', label: 'City: Reston' }, { key: 'lastActivity', label: 'Last 90 days' }],
  );

  /* ---- cityOptions: distinct, sorted, counted; hidden below 2 */
  eq('cityOptions: distinct non-null cities, sorted, with counts', cityOptions(all), [{ city: 'Reston', count: 2 }, { city: 'Sterling', count: 2 }, { city: 'Tempe', count: 1 }]);
  eq('cityOptions: a single-city subset -> length 1 (screen hides the control)', cityOptions([c1, c2]).length, 1);
  eq('cityOptions: no cities at all -> empty', cityOptions([c4]), []);

  /* ---- customerSortName: surname for a person, full name for a company */
  eq('customerSortName: a person sorts by surname', customerSortName('Ray Castillo'), 'castillo');
  eq('customerSortName: a company (business-marker word) sorts by its full name', customerSortName('Acme HVAC LLC'), 'acme hvac llc');
  eq('customerSortName: blank/null -> empty key', [customerSortName(null), customerSortName('')], ['', '']);

  /* ---- sortCustomers: never filters, only reorders; every mode */
  eq('sortCustomers never drops or adds a row', sortCustomers(all, 'recent').length, all.length);
  eq('sort=name: surname/company-name A-Z', ids(sortCustomers(all, 'name')), ['c2', 'c1', 'c6', 'c3', 'c4', 'c5']);
  eq('sort=docs: most documents first, ties keep original order', ids(sortCustomers(all, 'docs')), ['c3', 'c1', 'c6', 'c2', 'c4', 'c5']);
  eq('sort=equipment: most equipment first', ids(sortCustomers(all, 'equipment')), ['c3', 'c6', 'c1', 'c4', 'c2', 'c5']);
  eq('sort=alerts: highest combined alert count first', ids(sortCustomers(all, 'alerts')), ['c3', 'c1', 'c2', 'c4', 'c5', 'c6']);
  eq('sort=recent: most recent activity first, no-activity rows always last (in original order)', ids(sortCustomers(all, 'recent')), ['c4', 'c6', 'c1', 'c3', 'c2', 'c5']);

  /* ---- matchesSearch: name/number/address/phone/email, case/punctuation-insensitive, padded number */
  check('matchesSearch: empty query matches everyone', all.every((c) => matchesSearch(c, '')));
  check('matchesSearch: matches by name, case-insensitively', matchesSearch(c1, 'castillo') && matchesSearch(c1, 'CASTILLO'));
  check('matchesSearch: matches by street address', matchesSearch(c1, 'main st') && !matchesSearch(c3, 'main st'));
  check('matchesSearch: matches by phone', matchesSearch(c1, '123-4567') && !matchesSearch(c4, '123-4567'));
  check('matchesSearch: matches by email', matchesSearch(c3, 'jane@example') && !matchesSearch(c1, 'jane@example'));
  check('matchesSearch: "C-3" matches the zero-padded "C-00003"', matchesSearch(c3, 'C-3') && !matchesSearch(c1, 'C-3'));
  check('matchesSearch: "c-00003" (already padded) still matches, case-insensitively', matchesSearch(c3, 'c-00003'));
  check('matchesSearch: no match anywhere -> false', !matchesSearch(c1, 'nonexistent-zzz'));
}

/* ------------------------------------------------------- duplicates banner
 * Owner request 2026-09-20, item 2: dismiss ("Not the same") and merge both
 * remove a pair from the banner for the rest of the session. */
{
  const pair = { keepId: 'k1', dropId: 'd1' };
  const other = { keepId: 'k2', dropId: 'd2' };
  eq('pairKey: joins keep/drop', pairKey(pair), 'k1:d1');

  const original: Set<string> = new Set();
  const afterDismiss = reduceDuplicates(original, { type: 'dismiss', ...pair });
  check('reduceDuplicates: dismiss adds the pair\'s key', afterDismiss.has('k1:d1'));
  check('reduceDuplicates: never mutates the set passed in', original.size === 0);
  const afterMerge = reduceDuplicates(afterDismiss, { type: 'merge', ...other });
  check('reduceDuplicates: merge adds without disturbing an earlier dismiss', afterMerge.has('k1:d1') && afterMerge.has('k2:d2'));

  eq('visibleDuplicates: hides a dismissed pair, keeps the rest', visibleDuplicates([pair, other], new Set(['k1:d1'])), [other]);
  eq('visibleDuplicates: an untouched set hides nothing', visibleDuplicates([pair, other], new Set()), [pair, other]);
}

/* -------------------------------------------------- duplicates keep-chooser
 * Owner feedback 2026-09-20: "give me an option on which account to merge
 * into the other; I wanted to keep the one with both their names ('Ray &
 * Linda Castillo') instead of just the last name ('Castillo')". */
{
  eq('nameTokenCount: "Ray & Linda Castillo" is 3 tokens ("&" is a separator)', nameTokenCount('Ray & Linda Castillo'), 3);
  eq('nameTokenCount: a surname alone is 1 token', nameTokenCount('Castillo'), 1);
  eq('nameTokenCount: blank/null -> 0', nameTokenCount(null), 0);

  const fuller = { id: 'full', name: 'Ray & Linda Castillo', customerNumber: 'C-00004' };
  const surnameOnly = { id: 'surname', name: 'Castillo', customerNumber: 'C-00003' };
  check('defaultKeepId: the fuller name wins even with the higher customer number', defaultKeepId(fuller, surnameOnly) === 'full');
  check('defaultKeepId: order of arguments does not matter', defaultKeepId(surnameOnly, fuller) === 'full');

  const lower = { id: 'lower', name: 'Ray Castillo', customerNumber: 'C-00002' };
  const higher = { id: 'higher', name: 'Ray Castillo', customerNumber: 'C-00009' };
  check('defaultKeepId: equal name fullness falls back to the lower customer number', defaultKeepId(higher, lower) === 'lower');
}

/* ---------------------------------------------------------- unit grouping
 * Owner request 2026-09-20, item 4: a multi-unit document's fields grouped
 * per unit instead of ReviewScreen rendering duplicate flat rows. */
{
  type F = { name: string; value: string; correctedValue?: string; unitIndex?: number; target?: { entityId: string; field: string } };
  const f = (name: string, value: string, over: Partial<F> = {}): F => ({ name, value, ...over });

  // No unit_index anywhere, no equipment fields at all -> everything shared, no units.
  eq(
    'groupExtractionsByUnit: an invoice with no equipment fields has no unit sections',
    groupExtractionsByUnit([f('customer_name', 'Ray Castillo'), f('cost', '450')]),
    { shared: [f('customer_name', 'Ray Castillo'), f('cost', '450')], units: [] },
  );

  // No unit_index, but equipment fields present -> one implicit unit.
  {
    const fields = [f('customer_name', 'Ray Castillo'), f('serial_number', 'ABC123'), f('model', 'YSC060'), f('manufacturer', 'Trane')];
    const g = groupExtractionsByUnit(fields);
    eq('groupExtractionsByUnit: no unit_index but equipment fields -> shared keeps only document-level fields', g.shared, [f('customer_name', 'Ray Castillo')]);
    eq('groupExtractionsByUnit: no unit_index -> exactly one implicit unit', g.units.length, 1);
    eq('groupExtractionsByUnit: implicit unit label joins manufacturer/model/serial', g.units[0]?.label, 'Unit 1 · Trane YSC060 · serial ABC123');
  }

  // Real unit_index tagging -> two separate unit sections, shared fields kept out of both.
  {
    const fields = [
      f('customer_name', 'Plaza Dental'),
      f('equipment_id', 'RTU-1', { unitIndex: 1 }),
      f('serial_number', '21341ABCD', { unitIndex: 1, target: { entityId: 'eq-1', field: 'serial' } }),
      f('manufacturer', 'Trane', { unitIndex: 1 }),
      f('model', 'YSC060E3RHA', { unitIndex: 1 }),
      f('equipment_id', 'RTU-2', { unitIndex: 2 }),
      f('serial_number', '99887766', { unitIndex: 2 }),
    ];
    const g = groupExtractionsByUnit(fields);
    eq('groupExtractionsByUnit: shared fields exclude every unit-tagged field', g.shared, [f('customer_name', 'Plaza Dental')]);
    eq('groupExtractionsByUnit: one group per distinct unit_index, in order', g.units.map((u) => u.unitIndex), [1, 2]);
    eq('groupExtractionsByUnit: full label — tag, nameplate, serial', g.units[0]?.label, 'Unit 1 · RTU-1 · Trane YSC060E3RHA · serial 21341ABCD');
    eq('groupExtractionsByUnit: a unit with a linked extraction reports its equipment entity id', g.units[0]?.equipmentEntityId, 'eq-1');
    check('groupExtractionsByUnit: a unit with no linked extraction reports no equipment entity id', g.units[1]?.equipmentEntityId === null);
    eq('groupExtractionsByUnit: a corrected value wins over the raw one in the label', groupExtractionsByUnit([f('equipment_id', 'x', { unitIndex: 1 }), f('serial_number', 'raw', { unitIndex: 1, correctedValue: 'fixed' })]).units[0]?.label, 'Unit 1 · x · serial fixed');
  }
}

/* ------------------------------------------------------------------ done */

console.log('');
if (failures) {
  console.log(`${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log('All checks passed.');
