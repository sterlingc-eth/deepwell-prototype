/**
 * End-to-end check of the retrieval path against a real Postgres with RLS on.
 *
 * Covers the two things that must never regress:
 *   1. a question finds the passages that answer it, across pages and documents
 *   2. a tenant's question can never retrieve another tenant's pages
 *
 * Usage:  NEON_CONNECTION_STRING=postgres://... node scripts/verify-retrieval.mjs
 * Point it at a scratch database — it writes rows.
 */
import { withTenant } from '../api/_lib/recordsStore.js';
import { buildPrompt } from '../api/_lib/answer.js';

if (!process.env.NEON_CONNECTION_STRING) {
  console.error('Set NEON_CONNECTION_STRING to a scratch database first.');
  process.exit(2);
}

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};

const stamp = Date.now();
const A = { tenantKey: `org_verify_a_${stamp}`, tenantName: 'Verify Acme' };
const B = { tenantKey: `org_verify_b_${stamp}`, tenantName: 'Verify Rival' };

const seed = async (ctx, filename, sha, pages) => {
  const doc = await withTenant(ctx, (db) => db.createDocument({ original_filename: filename, sha256_hash: sha }));
  await withTenant(ctx, (db) => db.upsertPages(doc.id, pages));
  return doc.id;
};

const invoiceId = await seed(A, 'carrier-invoice.pdf', `a1-${stamp}`, [
  { page_no: 1, text: 'INVOICE 8841. Installed a Carrier 24ABC6 condenser, serial CG-4021-A, at 118 Whitmore Ave on March 4 2024. Labor 6 hours. Total $4,280.00.' },
  { page_no: 2, text: 'Warranty: 10 year parts limited warranty registered 2024-03-10, expires 2034-03-10. Refrigerant R-410A charge 8 lbs.' },
]);
await seed(A, 'service-ticket.pdf', `a2-${stamp}`, [
  { page_no: 1, text: 'Service call at 118 Whitmore Ave. Replaced capacitor on unit CG-4021-A. Tech: Dan Reyes. No charge, under warranty.' },
]);
await seed(B, 'rival-pricing.pdf', `b1-${stamp}`, [
  { page_no: 1, text: 'Confidential Rival Corp pricing. Carrier condenser serial CG-4021-A margin 42%. Whitmore Ave account.' },
]);

// 1. Terms spread across two pages of one document must both come back. This is
//    the case that fails under AND semantics, which is what we shipped first.
const warranty = await withTenant(A, (db) => db.searchPassages('when does the warranty on the Whitmore Ave condenser expire'));
check('question spanning two pages retrieves both', new Set(warranty.map((p) => p.page_no)).size >= 2,
  `pages: ${warranty.map((p) => p.page_no).join(',') || 'none'}`);
check('top hit is from the right document', warranty.some((p) => p.document_id === invoiceId));

// 2. Identifiers. The english text search config mangles "CG-4021-A"; the
//    identifier pass is what makes serial lookups work.
const serial = await withTenant(A, (db) => db.searchPassages('what do we know about serial CG-4021-A'));
check('serial number finds both documents', new Set(serial.map((p) => p.document_id)).size === 2,
  `docs: ${serial.length}`);

// 3. Isolation. The same serial exists in B's corpus; A must never see it, and
//    B must never see A's.
const bSide = await withTenant(B, (db) => db.searchPassages('what do we know about serial CG-4021-A'));
check('tenant B sees only its own page', bSide.every((p) => p.original_filename === 'rival-pricing.pdf'),
  bSide.map((p) => p.original_filename).join(', '));
check('tenant A never sees rival-pricing.pdf', serial.every((p) => p.original_filename !== 'rival-pricing.pdf'));

// 4. No answer is better than a wrong one.
const nonsense = await withTenant(A, (db) => db.searchPassages('purple monkey dishwasher'));
check('unrelated question retrieves nothing', nonsense.length === 0, `got ${nonsense.length}`);

// 5. The prompt must carry the documentId the model is required to cite, and
//    must not carry markup from ts_headline.
const prompt = buildPrompt({
  question: 'when does the warranty expire',
  today: '2026-09-14',
  passages: warranty.map((p) => ({ documentId: p.document_id, filename: p.original_filename, documentType: p.document_type, page: p.page_no, excerpt: p.excerpt })),
  extractions: [],
});
check('prompt includes the citable documentId', prompt.includes(invoiceId));
check('prompt has no highlight markup', !/<\/?b>/.test(prompt));
check('prompt states the no-invention rule', prompt.includes('Never invent a document'));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll retrieval checks passed.');
process.exit(failures ? 1 : 0);
