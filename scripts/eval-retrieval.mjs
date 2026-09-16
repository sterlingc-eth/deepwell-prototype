/**
 * Retrieval eval: does a question find the pages that answer it?
 *
 * This is the missing measurement. `npm run eval` scores the ANSWER layer
 * against mock data and a hand-built graph — useful, but it never touches
 * Postgres, so it cannot tell you whether a change to `searchPassages` made
 * retrieval better or worse. Every tuning decision so far has been an argument
 * rather than a number.
 *
 * What it reports, and why each one:
 *   recall@k       — did the page that answers the question come back at all?
 *                    The only metric that matters for correctness: the model
 *                    cannot cite what retrieval never handed it.
 *   MRR            — how far down the list it was. Passages are truncated into
 *                    the prompt, so rank 1 and rank 11 are not the same thing.
 *   false-positive — on questions with no answer in the corpus, did we return
 *                    something anyway? A confident wrong page is worse than
 *                    "nothing in your records answers that".
 *
 * No model is called. Retrieval quality is measured on its own, so a run is
 * free, repeatable, and cannot be flattered by a model covering for a bad
 * passage set.
 *
 * Usage:
 *   NEON_CONNECTION_STRING=postgres://... node scripts/eval-retrieval.mjs
 *   ... --verbose          show every question
 *   ... --group=warranty   run one group
 *   ... --k=8              cut the result list at k (default 12)
 *   ... --keep             leave the seeded tenant behind for inspection
 *
 * Point it at a SCRATCH database. It writes rows.
 */
import { withTenant } from '../api/_lib/recordsStore.js';
import { CORPUS, QUESTIONS } from './fixtures/hvac-corpus.mjs';

if (!process.env.NEON_CONNECTION_STRING) {
  console.error('Set NEON_CONNECTION_STRING to a scratch database first.');
  process.exit(2);
}

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const verbose = process.argv.includes('--verbose');
const keep = process.argv.includes('--keep');
const K = Number(arg('k', 12));
const groupFilter = arg('group', null);

/* ------------------------------------------------------------------- seed */

const stamp = Date.now();
const ctx = { tenantKey: `org_eval_${stamp}`, tenantName: 'Retrieval Eval' };

// A second tenant holding the same corpus. Every question is also asked as this
// tenant's neighbour to prove the isolation boundary holds under real query
// load, not just in the one hand-written case verify-retrieval.mjs covers.
const neighbour = { tenantKey: `org_eval_rival_${stamp}`, tenantName: 'Eval Rival' };

console.log(`Seeding ${CORPUS.length} documents (${CORPUS.reduce((n, d) => n + d.pages.length, 0)} pages)…`);

const docIdByKey = new Map();

for (const doc of CORPUS) {
  const row = await withTenant(ctx, (db) =>
    db.createDocument({
      original_filename: doc.filename,
      document_type: doc.documentType ?? null,
      sha256_hash: `eval-${stamp}-${doc.key}`,
    })
  );
  await withTenant(ctx, (db) => db.upsertPages(row.id, doc.pages));
  docIdByKey.set(doc.key, row.id);
}

// One document for the neighbour, deliberately the most-referenced one, so a
// leak would be unmistakable rather than subtle.
const leakDoc = CORPUS[0];
const leakId = await withTenant(neighbour, async (db) => {
  const row = await db.createDocument({
    original_filename: `NEIGHBOUR-${leakDoc.filename}`,
    document_type: leakDoc.documentType ?? null,
    sha256_hash: `eval-rival-${stamp}-${leakDoc.key}`,
  });
  await db.upsertPages(row.id, leakDoc.pages);
  return row.id;
});

const keyByDocId = new Map([...docIdByKey].map(([k, v]) => [v, k]));

/* -------------------------------------------------------------------- run */

const cases = QUESTIONS.filter((c) => !groupFilter || c.group === groupFilter);
if (!cases.length) {
  console.error(`No questions in group "${groupFilter}".`);
  process.exit(2);
}

const results = [];
let leaked = 0;

for (const c of cases) {
  const hits = await withTenant(ctx, (db) => db.searchPassages(c.q, K));

  const gotKeys = hits.map((h) => keyByDocId.get(h.document_id)).filter(Boolean);
  const gotPages = hits.map((h) => h.page_no);
  const blob = hits.map((h) => String(h.excerpt ?? '')).join(' \n ').toLowerCase();

  if (hits.some((h) => h.document_id === leakId)) leaked++;

  const wantDocs = c.expect?.docs ?? [];
  const wantPages = c.expect?.pages ?? null;
  const anyOf = c.expect?.anyOf ?? null;

  const failures = [];
  let rank = null;

  if (!wantDocs.length) {
    // A no-answer case. Anything returned is a false positive.
    if (hits.length) failures.push(`expected nothing, got ${hits.length} passage(s) from ${[...new Set(gotKeys)].join(', ') || '?'}`);
  } else {
    for (const key of wantDocs) {
      if (!gotKeys.includes(key)) failures.push(`missed document ${key}`);
    }
    // Rank of the first expected document: what decides whether it survives
    // the cut into the prompt.
    const idx = gotKeys.findIndex((k) => wantDocs.includes(k));
    rank = idx === -1 ? null : idx + 1;

    if (wantPages) {
      for (const p of wantPages) {
        if (!gotPages.includes(p)) failures.push(`missed page ${p}`);
      }
    }
    if (anyOf && !anyOf.some((s) => blob.includes(String(s).toLowerCase()))) {
      failures.push(`no excerpt contained any of: ${anyOf.map((s) => `"${s}"`).join(', ')}`);
    }
  }

  results.push({ c, hits: hits.length, failures, pass: failures.length === 0, rank, gotKeys });
}

/* ----------------------------------------------------------------- report */

const answerable = results.filter((r) => (r.c.expect?.docs ?? []).length > 0);
const noAnswer = results.filter((r) => (r.c.expect?.docs ?? []).length === 0);

const recall = answerable.length
  ? answerable.filter((r) => r.rank !== null).length / answerable.length
  : 0;
const mrr = answerable.length
  ? answerable.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / answerable.length
  : 0;
const falsePositives = noAnswer.filter((r) => r.hits > 0).length;

for (const r of results) {
  if (r.pass && !verbose) continue;
  console.log(`${r.pass ? '✓' : '✗'} ${String(r.c.id).padStart(3)} [${r.c.group}] ${r.c.q}`);
  if (verbose && r.pass) console.log(`      rank ${r.rank ?? '—'} · ${r.hits} passage(s) · ${[...new Set(r.gotKeys)].join(', ')}`);
  for (const f of r.failures) console.log(`      ✗ ${f}`);
}

const byGroup = new Map();
for (const r of results) {
  const g = byGroup.get(r.c.group) ?? { pass: 0, total: 0 };
  g.total++;
  if (r.pass) g.pass++;
  byGroup.set(r.c.group, g);
}

console.log('\n─────────────────────────────────────────────');
console.log(`k = ${K}`);
for (const [g, v] of [...byGroup].sort()) {
  console.log(`  ${g.padEnd(16)} ${String(v.pass).padStart(3)}/${String(v.total).padEnd(3)}  ${pct(v.pass / v.total)}`);
}
console.log('─────────────────────────────────────────────');
console.log(`  recall@${K}        ${pct(recall)}   (${answerable.filter((r) => r.rank !== null).length}/${answerable.length} answerable questions found their document)`);
console.log(`  MRR              ${mrr.toFixed(3)}`);
console.log(`  false positives  ${falsePositives}/${noAnswer.length}   (no-answer questions that returned something)`);
console.log(`  cross-tenant     ${leaked === 0 ? 'clean' : `LEAKED on ${leaked} question(s)`}`);
if (groupFilter) {
  console.log(`  NOTE: --group=${groupFilter} ran ${cases.length} of ${QUESTIONS.length} questions.`);
  console.log('        The isolation result above covers only those. Run without --group before trusting it.');
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} questions passed`);

if (keep) {
  console.log(`\nSeeded rows left in place. Tenants: ${ctx.tenantKey}, ${neighbour.tenantKey}`);
} else {
  // Cascades to document_pages, facets and extractions through their FKs.
  for (const id of docIdByKey.values()) {
    await withTenant(ctx, (db) => db.deleteDocument(id)).catch(() => {});
  }
  await withTenant(neighbour, (db) => db.deleteDocument(leakId)).catch(() => {});
}

function pct(x) {
  return `${(x * 100).toFixed(1)}%`.padStart(6);
}

// Cross-tenant leakage is never acceptable; everything else is a number to
// improve, so a failing question alone must not block a commit.
process.exit(leaked === 0 ? 0 : 1);
