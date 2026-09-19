/**
 * Unit checks for the DELETE and OPEN ORIGINAL contracts
 * (handoffs/TEAM_BRIEF_2026-09-19.md). No database, no network — pure
 * validation logic and the presign() call shape, same spirit as
 * verify-sigv4.mjs and verify-review.mjs.
 *
 *   node scripts/verify-docaccess.mjs
 */
import { validateDocumentIds } from '../api/_lib/routes/document-delete.js';
import { ReviewError } from '../api/_lib/reviewStore.js';
import { getOriginalUrl, DocumentGetError } from '../api/upload-url.js';
import { presign } from '../api/_lib/r2.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const UUID_A = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const UUID_B = '11111111-2222-3333-4444-555555555555';

/* ------------------------------------------------------- validateDocumentIds */

eq('a single valid uuid passes through', validateDocumentIds([UUID_A]), [UUID_A]);
eq('duplicates are deduped', validateDocumentIds([UUID_A, UUID_A]), [UUID_A]);
eq('several distinct uuids all survive', validateDocumentIds([UUID_A, UUID_B]).length, 2);

{
  let threw = false;
  try { validateDocumentIds([]); } catch (err) { threw = err instanceof ReviewError && err.status === 400; }
  check('empty array is rejected (400)', threw);
}
{
  let threw = false;
  try { validateDocumentIds(null); } catch (err) { threw = err instanceof ReviewError && err.status === 400; }
  check('non-array is rejected (400)', threw);
}
{
  let threw = false;
  try { validateDocumentIds([UUID_A, 'not-a-uuid']); } catch (err) { threw = err instanceof ReviewError && err.status === 400; }
  check('a non-uuid entry is rejected (400)', threw);
}
{
  const tooMany = Array.from({ length: 101 }, (_, i) => `${String(i).padStart(8, '0')}-0000-0000-0000-000000000000`);
  let threw = false;
  try { validateDocumentIds(tooMany); } catch (err) { threw = err instanceof ReviewError && err.status === 413; }
  check('more than 100 ids is rejected (413)', threw);
}
{
  const exactly100 = Array.from({ length: 100 }, (_, i) => `${String(i).padStart(8, '0')}-0000-0000-0000-000000000000`);
  eq('exactly 100 ids is allowed', validateDocumentIds(exactly100).length, 100);
}

/* -------------------------------------------------------------- getOriginalUrl */

{
  let ok = false;
  try {
    await getOriginalUrl({ tenantId: 'user_x', orgId: null }, undefined);
  } catch (err) {
    ok = err instanceof DocumentGetError && err.status === 400;
  }
  check('getOriginalUrl rejects a missing documentId before touching the database (400)', ok);
}
{
  let ok = false;
  try {
    await getOriginalUrl({ tenantId: 'user_x', orgId: null }, '   ');
  } catch (err) {
    ok = err instanceof DocumentGetError && err.status === 400;
  }
  check('getOriginalUrl rejects a blank documentId (400)', ok);
}
{
  // A malformed (non-uuid) documentId must never reach the ::uuid-cast SQL —
  // Postgres raising "invalid input syntax for type uuid" from inside a
  // catch-all is what turned this into a bare 500 in production.
  let ok = false;
  let message = null;
  try {
    await getOriginalUrl({ tenantId: 'user_x', orgId: null }, 'not-a-uuid');
  } catch (err) {
    ok = err instanceof DocumentGetError && err.status === 400;
    message = err.message;
  }
  check('getOriginalUrl rejects a non-uuid-shaped documentId (400, not 500)', ok, message);
  eq('the rejection message names the expected shape', message, 'documentId must be a uuid');
}

/* --------------------------------------------------- presign() GET URL shape */

Object.assign(process.env, {
  R2_ACCOUNT_ID: 'acct123',
  R2_ACCESS_KEY_ID: 'AKIDEXAMPLE',
  R2_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  R2_BUCKET_NAME: 'deepwell-docs',
});
const fixed = new Date('2026-01-01T00:00:00Z');
const key = 'tenant-uuid/ab/abc123';
const url = presign('GET', key, 900, {
  'response-content-disposition': 'inline; filename="invoice.pdf"',
}, fixed);
const parsed = new URL(url);

check('GET presign hits the R2 host', parsed.host, 'acct123.r2.cloudflarestorage.com');
check('GET presign path is bucket + key', parsed.pathname, `/deepwell-docs/${key}`);
check('GET presign expires in 900s', parsed.searchParams.get('X-Amz-Expires'), '900');
check(
  'GET presign carries a signed content-disposition override',
  parsed.searchParams.get('response-content-disposition'),
  'inline; filename="invoice.pdf"'
);
check('GET presign is signed', /^[0-9a-f]{64}$/.test(parsed.searchParams.get('X-Amz-Signature') ?? ''));

console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
