/**
 * Regression checks for the defects found in the September 16 deep audit.
 *
 * Every check here corresponds to a bug that was live in production and that
 * nothing else in the suite would have caught. They are grouped by the failure
 * they prevent, not by the function they call, because the reason each one
 * exists is the point — a future reader deciding whether a check is still
 * needed should be able to see what breaks if it goes.
 *
 * No database, no network.
 *
 *   node scripts/verify-hardening.mjs
 */
import { isPlaceholderSerial, normalizeMatchText, DOCUMENT_UPDATE_COLUMNS } from '../api/_lib/recordsStore.js';
import { isTransientError } from '../api/_lib/readDocument.js';
import { deriveWarranty, isPlausibleToday, isValidYmd } from '../api/_lib/warrantyRules.js';
import { isQueueEnabled } from '../api/_lib/queue.js';
import { normalizeNumber } from '../api/_lib/extractFields.js';
import { buildAllowed, shapeAnswer } from '../api/_lib/answer.js';
import { getApiKey } from '../api/_lib/claude.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* ---------------------------------------------- warranty must not regress */
//
// The bug: deriveWarranty saw only the CURRENT document's fields. An install
// invoice established Goodman + an install date and produced a correct
// registration deadline; the next service ticket for the same serial named
// neither, derived an empty warranty, and setEquipmentWarranty's jsonb merge
// replaced the whole warranty key with it. The unit dropped out of the
// expiring-warranty list with nothing recorded as wrong, and the answer you
// got depended on which document was extracted last.

const INSTALL = { serial_number: 'SN100', manufacturer: 'Goodman', installation_date: '2024-03-04' };
const TICKET = { serial_number: 'SN100', service_date: '2025-06-01', technician: 'J. Ruiz' };

const fromInstall = deriveWarranty(INSTALL);
check('install invoice yields a registration deadline', Boolean(fromInstall.registrationDeadline),
  JSON.stringify(fromInstall));
check('install invoice yields an expiry', Boolean(fromInstall.expires), JSON.stringify(fromInstall));

const fromTicketAlone = deriveWarranty(TICKET);
check('a bare service ticket really does derive nothing (the bug\'s precondition)',
  fromTicketAlone.registrationDeadline === null && fromTicketAlone.expires === null,
  JSON.stringify(fromTicketAlone));

// What extractDocument now does: the entity's accumulated, fill-only data is
// layered OVER this document's facts before deriving.
const merged = deriveWarranty({ ...TICKET, ...INSTALL });
eq('service ticket + entity facts preserves the deadline', merged.registrationDeadline, fromInstall.registrationDeadline);
eq('service ticket + entity facts preserves the expiry', merged.expires, fromInstall.expires);
eq('service ticket + entity facts preserves the brand', merged.brand, fromInstall.brand);

// Order independence is the real property: whichever document lands last, the
// stored warranty must be the same.
const a = deriveWarranty({ ...INSTALL, ...{} });
const b = deriveWarranty({ ...TICKET, ...INSTALL });
eq('extraction order does not change the stored warranty',
  [a.registrationDeadline, a.expires], [b.registrationDeadline, b.expires]);

// A later document that genuinely carries NEW warranty information must still
// be able to update — the fix must not have frozen the value.
const registered = deriveWarranty({ ...INSTALL, warranty_registered_date: '2024-04-01' });
check('a real registration date still changes the derived warranty',
  JSON.stringify(registered) !== JSON.stringify(fromInstall),
  'registration made no difference, so the merge froze the value');

/* -------------------------------------- placeholder serials must not merge */
//
// The bug: findOrCreateEquipment matched on serial alone. "N/A" from an
// illegible nameplate is not an identity, so every unreadable plate in the
// account collapsed into ONE equipment row — a Carrier furnace and a Trane
// condenser at different addresses becoming a single unit carrying one of
// their warranties.

for (const s of ['N/A', 'n/a', 'N.A.', 'NONE', 'none', 'Unknown', 'UNK', 'TBD', 'pending',
                 'illegible', 'unreadable', 'missing', 'not legible', 'not available',
                 'nil', 'null', 'see photo', 'see above', 'see attached', 'test', 'sample']) {
  check(`placeholder serial rejected: ${JSON.stringify(s)}`, isPlaceholderSerial(s));
}
for (const s of ['-', '--', '-----', '0000', 'XXXX', 'xxx', '', '   ', '\t', null, undefined]) {
  check(`filler serial rejected: ${JSON.stringify(s)}`, isPlaceholderSerial(s));
}

// The asymmetry that matters: rejecting a real serial loses a unit's whole
// history, which is worse than the duplicate row a missed placeholder costs.
// These are shapes real HVAC serials actually take.
for (const s of ['4N2119-08772', 'SN100', '1234567890', 'W1234567', 'A-00-1', '0A1',
                 'M0891234567', '1809X12345', 'ARUF37C05', '24ANB160A003', 'L5D2345678',
                 'NAA123456', 'X0N1234567', '000123456789']) {
  check(`real serial kept: ${s}`, !isPlaceholderSerial(s));
}

/* ------------------------------ transient failures must not be recorded */
//
// The bug: the inline ingest path called recordIngestFailure on EVERY error.
// The browser polls document-status and treats any extract_error as terminal,
// so a 429 from Anthropic during a 200-file drop — the most ordinary thing
// that can happen on this path — told the technician their file had failed,
// permanently, when a retry seconds later would have worked.

check('429 is transient', isTransientError({ status: 429 }));
check('500 is transient', isTransientError({ status: 500 }));
check('502 is transient', isTransientError({ status: 502 }));
check('503 is transient', isTransientError({ status: 503 }));
check('504 is transient', isTransientError({ status: 504 }));
check('408 is transient', isTransientError({ status: 408 }));
check('ECONNRESET is transient', isTransientError({ code: 'ECONNRESET' }));
check('ETIMEDOUT is transient', isTransientError({ code: 'ETIMEDOUT' }));
check('EAI_AGAIN is transient', isTransientError({ code: 'EAI_AGAIN' }));
check('APIConnectionError is transient', isTransientError({ name: 'APIConnectionError' }));
check('an IngestError 429 is transient', isTransientError({ name: 'IngestError', status: 429 }));

// The other side of the asymmetry: a document we genuinely cannot read must
// still be recorded, or it sits at 'received' forever with no reason given.
check('415 unsupported type is NOT transient', !isTransientError({ name: 'IngestError', status: 415 }));
check('413 too large is NOT transient', !isTransientError({ name: 'IngestError', status: 413 }));
check('404 missing document is NOT transient', !isTransientError({ name: 'IngestError', status: 404 }));
check('409 not read yet is NOT transient', !isTransientError({ name: 'IngestError', status: 409 }));
check('a plain Error is NOT transient', !isTransientError(new Error('boom')));
check('a TypeError is NOT transient', !isTransientError(new TypeError('x is not a function')));
check('null is NOT transient', !isTransientError(null));
check('undefined is NOT transient', !isTransientError(undefined));

/* ------------------------- a half-configured queue must fall back to inline */
//
// The bug: isQueueEnabled checked only INNGEST_EVENT_KEY. Sending an event
// needs only that key, so enqueue succeeded and read-document answered
// 202 queued — but the callback into /api/inngest is verified against
// INNGEST_SIGNING_KEY and fails closed without it, so the work never ran.
// Every document said "queued" forever and nothing recorded an error.

const saved = [process.env.INNGEST_EVENT_KEY, process.env.INNGEST_SIGNING_KEY];
const setKeys = (ev, sign) => {
  if (ev == null) delete process.env.INNGEST_EVENT_KEY; else process.env.INNGEST_EVENT_KEY = ev;
  if (sign == null) delete process.env.INNGEST_SIGNING_KEY; else process.env.INNGEST_SIGNING_KEY = sign;
};

setKeys(null, null);
check('no keys -> queue off (inline, the documented default)', isQueueEnabled() === false);
setKeys('ev', null);
check('event key ONLY -> queue off, not silently swallowing documents', isQueueEnabled() === false);
setKeys(null, 'sign');
check('signing key only -> queue off', isQueueEnabled() === false);
setKeys('ev', 'sign');
check('both keys -> queue on', isQueueEnabled() === true);
setKeys('', 'sign');
check('empty event key -> queue off', isQueueEnabled() === false);
setKeys('ev', '');
check('empty signing key -> queue off', isQueueEnabled() === false);
setKeys(saved[0], saved[1]);

/* =================================================================== */
/* Round two — 16 September deep audit                                  */
/* =================================================================== */

/* ------------------------- non-Latin names are names */
//
// The bug: normalizeMatchText tested /[A-Za-z0-9]/ — ASCII only. A customer
// named Иванов, 王芳, محمد or Παπαδόπουλος normalized to the empty string, and
// findOrCreateCustomer reads an empty string as "this document names nobody",
// exactly as it reads "---". Those customers silently never got a record and
// their equipment was never linked to them. It failed quietly, every time, for
// an ordinary category of real customer.

for (const [label, name] of [
  ['Cyrillic', 'Иванов'], ['CJK', '王芳'], ['Arabic', 'محمد'],
  ['Hangul', '김철수'], ['Greek', 'Παπαδόπουλος'], ['Hebrew', 'כהן'],
  ['Devanagari', 'शर्मा'], ['Thai', 'สมชาย'], ['accented Latin', 'José Núñez'],
  ['mixed script', 'Ivan Иванов'],
]) {
  eq(`${label} name kept`, normalizeMatchText(name), name);
}

// The boundary the original test was protecting must still hold: a value with
// no letters and no digits is not a name.
for (const [label, junk] of [
  ['punctuation only', '---'], ['em dash only', '—'], ['dots only', '...'],
  ['whitespace only', '   '], ['empty', ''], ['null', null], ['undefined', undefined],
  ['symbols only', '#$%&'],
]) {
  eq(`${label} still rejected`, normalizeMatchText(junk), '');
}

/* ------------------------- a clock value must be plausible, not merely real */
//
// The bug: both warranty routes accept a caller-supplied `today` and validated
// it with isValidYmd, which accepts any real calendar date. Their own comments
// said a malformed value must fail loudly rather than produce nonsense urgency
// — but today='1000-01-01' came back as "Register with Goodman within 374131
// day(s)", which is precisely the nonsense the comment promised to prevent.

check('a normal date is plausible', isPlausibleToday('2026-09-16'));
check('the lower bound is plausible', isPlausibleToday('2000-01-01'));
check('the upper bound is plausible', isPlausibleToday('2100-12-31'));
check('year 1000 is not a clock value', !isPlausibleToday('1000-01-01'));
check('year 0100 is not a clock value', !isPlausibleToday('0100-01-01'));
check('year 9999 is not a clock value', !isPlausibleToday('9999-12-31'));
check('year 1999 is out of range', !isPlausibleToday('1999-12-31'));
check('year 2101 is out of range', !isPlausibleToday('2101-01-01'));
check('a fake calendar date is still rejected', !isPlausibleToday('2026-02-30'));
check('a malformed string is still rejected', !isPlausibleToday('2026-13-40'));
check('not-a-date is rejected', !isPlausibleToday('yesterday'));
check('null is rejected', !isPlausibleToday(null));

// An installation date from decades ago is legitimate and must NOT be bounded
// by this — the guard is only for values standing in for "now".
check('a 1994 install date is still a valid date', isValidYmd('1994-06-01'));

/* ------------------------- a cost is not a quadrillion dollars */
//
// The bug: MAX_MAGNITUDE was 1e15, commented as a plausibility guard but
// actually just the margin before toFixed switches to exponential notation. A
// garbled extraction could store $999,999,999,999,999 as a legitimate cost.

eq('a quadrillion-dollar cost is rejected', normalizeNumber('999999999999999', { money: true }), null);
eq('the boundary itself is rejected', normalizeNumber(String(1e8), { money: true }), null);
eq('a million-dollar commercial job is accepted', normalizeNumber('$1,250,000.00', { money: true }), '1250000.00');
eq('an ordinary service call is accepted', normalizeNumber('$487.50', { money: true }), '487.50');
eq('labor hours are accepted', normalizeNumber('3.5', {}), '3.5');
check('nothing is ever emitted in exponential notation',
  !/e/i.test(normalizeNumber('99999999999999999999999', { money: true }) ?? ''));

/* ------------------------- confidence is a probability */
//
// The bug: ANSWER_TOOL declares confidence as a bare number with no minimum or
// maximum, so a model returning 5 passed schema validation, and the client's
// `?? 0.8` fallback does not catch an out-of-range number either. The type says
// 0-1; now that is true.

{
  const allowed = buildAllowed({
    passages: [{ documentId: 'doc1', page: 1, filename: 'invoice.pdf', excerpt: 'Carrier 59TP6 serial 4N2119' }],
    extractions: [{ documentId: 'doc1', field: 'serial_number', value: '4N2119', filename: 'invoice.pdf' }],
  });
  const shape = (confidence) => shapeAnswer({
    text: 'The serial is 4N2119.',
    confidence,
    facts: [{
      label: 'Serial',
      value: '4N2119',
      sources: [{ documentId: 'doc1', location: { page: 1 } }],
    }],
  }, allowed);

  // Guard the fixture itself: if this stops being a grounded answer the
  // clamp checks below would pass for the wrong reason.
  check('the confidence fixture produces a grounded answer', shape(0.5)?.kind === 'answer');

  check('confidence above 1 is clamped', (shape(5)?.confidence ?? 99) <= 1);
  check('confidence below 0 is clamped', (shape(-3)?.confidence ?? -99) >= 0);
  check('a normal confidence survives unchanged', shape(0.62)?.confidence === 0.62);
  check('a missing confidence gets the default', shape(undefined)?.confidence === 0.8);
  check('NaN confidence gets the default', shape(NaN)?.confidence === 0.8);
  check('Infinity is clamped into range', (shape(Infinity)?.confidence ?? 99) <= 1);
}

/* ------------------------- a placeholder check must not blow the stack */
//
// /^(.)\1*$/ is a backtracking regex that overflows on a multi-megabyte string
// of one repeated character. Unreachable through the pipeline today because
// normalizeFields caps values at 500 characters, but the function is exported
// and a bulk-import path would not go through that cap.

check('a 5MB repeated string does not throw', (() => {
  try { isPlaceholderSerial('1'.repeat(5_000_000)); return true; } catch { return false; }
})());
check('a 20MB repeated string does not throw', (() => {
  try { isPlaceholderSerial('x'.repeat(20_000_000)); return true; } catch { return false; }
})());
check('the length guard does not break normal serials', !isPlaceholderSerial('4N2119-08772'));
check('short filler is still caught after the guard', isPlaceholderSerial('0000'));

/* ------------------------- the state machine stays server-owned */
//
// The bug: api/records.ts passes payload.updates straight to updateDocument,
// whose allowlist covers column NAMES but never values. With `stage` on that
// list an authenticated caller could roll their own document backwards from
// 'mapped' to 'received', defeating the forward-only progression every other
// write path enforces. `storage_key` was worse: the row is tenant-scoped but
// the KEY is not validated against the tenant prefix, so pointing your own
// document at another tenant's key and calling read-document would transcribe
// their file into your account.

check('stage is not client-writable', !DOCUMENT_UPDATE_COLUMNS.includes('stage'));
check('storage_key is not client-writable', !DOCUMENT_UPDATE_COLUMNS.includes('storage_key'));
check('document_type is still writable', DOCUMENT_UPDATE_COLUMNS.includes('document_type'));
check('page_count is still writable', DOCUMENT_UPDATE_COLUMNS.includes('page_count'));

/* ------------------------- a config error is not an auth error */
//
// The bug: getApiKey threw a message naming the env var, and handleError's
// substring match turned it into 401 "Authentication failed" — telling a
// technician their session had expired when the truth was that nobody had set a
// server variable. They would sign out and back in forever and it would never
// help. On the ingestion path that same message was also written onto the
// document row, leaking the variable name into stored data.

{
  const saved = [process.env.CLAUDE_API_KEY, process.env.ANTHROPIC_API_KEY];
  delete process.env.CLAUDE_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  let thrown = null;
  try { getApiKey(); } catch (e) { thrown = e; }
  check('a missing key throws', thrown !== null);
  check('it is a ConfigError, not a generic Error', thrown?.name === 'ConfigError');
  check('the message does not name the env var',
    !/CLAUDE_API_KEY|ANTHROPIC_API_KEY/.test(thrown?.message ?? ''),
    `message was: ${thrown?.message}`);
  check('the message does not leak the key format',
    !/sk-ant/.test(thrown?.message ?? ''));
  check('the message tells the user it is a server problem',
    /server|administrator|configured/i.test(thrown?.message ?? ''));
  check('the real diagnostic is preserved for the log',
    /CLAUDE_API_KEY/.test(String(thrown?.cause ?? '')));
  if (saved[0] != null) process.env.CLAUDE_API_KEY = saved[0];
  if (saved[1] != null) process.env.ANTHROPIC_API_KEY = saved[1];
}

/* ------------------------------------------------------------------ done */

console.log('');
if (failures) {
  console.log(`${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log('All checks passed.');
