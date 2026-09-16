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
import { isPlaceholderSerial } from '../api/_lib/recordsStore.js';
import { isTransientError } from '../api/_lib/readDocument.js';
import { deriveWarranty } from '../api/_lib/warrantyRules.js';
import { isQueueEnabled } from '../api/_lib/queue.js';

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

/* ------------------------------------------------------------------ done */

console.log('');
if (failures) {
  console.log(`${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log('All checks passed.');
