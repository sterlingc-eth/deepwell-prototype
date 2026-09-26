/**
 * Cross-tenant isolation (reviewer NO-GO, 2026-09-26): proves that switching
 * tenant clears the global `useGraph` store IMMEDIATELY, synchronously, with
 * no window where a same-tab org switch (Clerk's OrganizationSwitcher, no
 * page reload) can show the previous shop's customers/serials/documents.
 *
 * Startup performance (handoffs/STARTUP_PERF_R13.md) made this a real risk:
 * the Ask screen now renders — and reads `useGraph` — before the full sync
 * finishes, so a stale seed sitting in the store for even one render is a
 * real leak, not just a cosmetic flash.
 *
 * Pure store checks only, no DOM, no Clerk, no network — this exercises
 * exactly the two module-level pieces of state a tenant switch must reset:
 *   1. `useGraph` itself (entities/docs/batches/conflicts)
 *   2. the `fullSyncCompleted` latch that guards `seedDocsPartial` — proven
 *      indirectly, since it isn't exported: post-reset, `seedDocsPartial`
 *      must be able to seed again (it no-ops once `fullSyncCompleted` is
 *      true), which is the same guarantee the running app depends on when a
 *      bootstrap response for the NEW tenant lands after the reset.
 *
 * Run via tsx (imports .ts sources directly, same technique
 * scripts/verify-work-filter.mjs uses).
 *
 *   npx tsx scripts/verify-tenant-isolation.mjs
 */
import { useGraph } from '../src/core/entityGraph';
import { resetGraphForTenantSwitch, seedDocsPartial, loadGraphFromServer } from '../src/hooks/usePostgresSync';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};

/** Minimal `documents` row shape `seedDocsPartial`/`toDoc` needs. */
function row(id, filename) {
  return {
    id,
    batch_id: 'synced',
    original_filename: filename,
    document_type: 'service-ticket',
    stage: 'linked',
    created_at: new Date().toISOString(),
    content_type: 'application/pdf',
    page_count: 2,
  };
}

/* ------------------------------------------------------- tenant A seeds in */

seedDocsPartial([row('doc-tenant-a', 'shop-a-invoice.pdf')]);
check('tenant A: seedDocsPartial puts its document in the store', !!useGraph.getState().docs['doc-tenant-a']);

/* -------------------------------------------------- tenant switch resets -- */

resetGraphForTenantSwitch();
const afterReset = useGraph.getState();
check('reset: entities is empty', Object.keys(afterReset.entities).length === 0);
check('reset: docs is empty (tenant A document is gone)', Object.keys(afterReset.docs).length === 0);
check('reset: batches is empty', Object.keys(afterReset.batches).length === 0);
check('reset: conflicts is empty', Object.keys(afterReset.conflicts).length === 0);
check(
  'reset: tenant A document is not merely hidden — it is actually gone',
  !afterReset.docs['doc-tenant-a']
);

/* ------------------------------------- tenant B seeds in without leaking -- */

// The real bug this reviewer round found: `fullSyncCompleted` staying true
// across the switch would make this a silent no-op, leaving the store
// empty (or worse, still showing tenant A's data via some other path)
// instead of ever showing tenant B's own documents.
seedDocsPartial([row('doc-tenant-b', 'shop-b-invoice.pdf')]);
const afterTenantB = useGraph.getState();
check('tenant B: seedDocsPartial works again post-reset (fullSyncCompleted was cleared)', !!afterTenantB.docs['doc-tenant-b']);
check('tenant B: no leftover tenant A document alongside it', !afterTenantB.docs['doc-tenant-a']);

/* --------------------- a real full sync also does not need a manual reset */

// loadGraphFromServer's own seed() call is a full replace (see
// entityGraph.ts's `seed`), so it must be safe to call directly after a
// reset without the caller doing anything else — this is what
// usePostgresSync's effect actually does once resetGraphForTenantSwitch has
// run. No network in this harness, so this just proves the call sequence
// doesn't throw against real store code; recordsStore.connect() will reject
// against a real backend that isn't there — that's fine, this only checks
// the store stayed instantiated correctly, not that fetch works.
try {
  await loadGraphFromServer('tenant-b');
  check('loadGraphFromServer: ran without a store-shape error', true);
} catch (err) {
  // Any error here is expected to be a network/auth error (no server in
  // this harness), never a store/shape error — fail only on the latter.
  const message = err instanceof Error ? err.message : String(err);
  const isStoreShapeError = /is not a function|Cannot read prop|undefined is not/i.test(message);
  check('loadGraphFromServer: any error is a network error, not a store-shape bug', !isStoreShapeError, message);
}

console.log(failures === 0 ? `\nAll tenant-isolation checks passed.` : `\n${failures} tenant-isolation check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
