// Integration seams: the Word/Excel read-time allowance check and the upload gate share ONE page count (countPagesSince), so a
// delete-and-reupload at the cap is refused, an exact fit is admitted, and a refusal quotes the number the gate enforces.
// Same checks as scripts/limit-test-b/integration-seams.mjs; this entry point just loads the Clerk test stub first.
//   npm run verify:integration-seams
import './limit-test-b/register.mjs';
await import('./limit-test-b/integration-seams.mjs');
