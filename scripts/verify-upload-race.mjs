// E2: simultaneous-upload cap checks (documents cap, monthly page cap, staff import, v1-ingest, rate-limit refund bound).
// Same checks as scripts/limit-test-b/upload-race.mjs; this entry point just loads the Clerk test stub first.
//   npm run verify:upload-race
import './limit-test-b/register.mjs';
await import('./limit-test-b/upload-race.mjs');
