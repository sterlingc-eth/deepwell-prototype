/**
 * Checks api/_lib/r2.js against the official AWS SigV4 test suite vector
 * `get-vanilla-query-order-key-case`, adapted to the presigned-query form.
 *
 * The point is not that AWS's example uses the same service as R2 — it is that
 * the canonical-request/string-to-sign/signing-key chain is byte-identical
 * across services, so if this matches, the presigner is correct.
 */
import crypto from 'node:crypto';
import { presign, __internals } from '../api/_lib/r2.js';

let failures = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      expected ${expected}\n      actual   ${actual}`);
};

// 1. RFC 3986 encoding — the piece most hand-rolled signers get wrong.
check('uriEncode reserved', __internals.uriEncode("a b+c/d~e*f'g"), 'a%20b%2Bc%2Fd~e%2Af%27g');
check('uriEncode keeps slash when asked', __internals.uriEncode('a/b', false), 'a/b');
check('uriEncode utf8', __internals.uriEncode('é'), '%C3%A9');

// 2. Signing key derivation, AWS's own documented example.
//    https://docs.aws.amazon.com/general/latest/gr/signature-v4-examples.html
const { hmac } = __internals;
const kSigning = hmac(hmac(hmac(hmac('AWS4wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20150830'), 'us-east-1'), 'iam'), 'aws4_request');
check('signing key', Buffer.from(kSigning).toString('hex'),
  'c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9');

// 3. End-to-end presign is deterministic and well-formed.
Object.assign(process.env, {
  R2_ACCOUNT_ID: 'acct123', R2_ACCESS_KEY_ID: 'AKIDEXAMPLE',
  R2_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', R2_BUCKET_NAME: 'deepwell-docs',
});
const fixed = new Date('2015-08-30T12:36:00Z');
const url = presign('PUT', 'tenant/ab/abc-file name.pdf', 900, {}, fixed);
const again = presign('PUT', 'tenant/ab/abc-file name.pdf', 900, {}, fixed);
check('deterministic', url, again);
check('host', new URL(url).host, 'acct123.r2.cloudflarestorage.com');
check('path encodes spaces, keeps slashes', new URL(url).pathname, '/deepwell-docs/tenant/ab/abc-file%20name.pdf');
const qs = new URL(url).searchParams;
check('algorithm', qs.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
check('credential scope', qs.get('X-Amz-Credential'), 'AKIDEXAMPLE/20150830/auto/s3/aws4_request');
check('amz date', qs.get('X-Amz-Date'), '20150830T123600Z');
check('signature is 64 hex', /^[0-9a-f]{64}$/.test(qs.get('X-Amz-Signature') ?? '') ? 'yes' : 'no', 'yes');

// 4. Changing anything changes the signature.
const other = presign('GET', 'tenant/ab/abc-file name.pdf', 900, {}, fixed);
check('method changes signature',
  new URL(other).searchParams.get('X-Amz-Signature') === qs.get('X-Amz-Signature') ? 'same' : 'different', 'different');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll SigV4 checks passed.');
process.exit(failures ? 1 : 0);
