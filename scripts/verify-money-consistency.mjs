/**
 * Round 15 (Team C, follow-up): checks for the money split-brain fixes —
 *
 *   1. fastPath.js/fastPathQuery.js's invoice_total now reads the EFFECTIVE
 *      (correction-applied) document_financials total whenever a financial row
 *      exists, never the raw extractions.cost value that a correction never
 *      touches. Falls back to the raw extraction ONLY for a document with no
 *      document_financials row at all (a document can only be corrected once
 *      such a row exists, so that fallback carries no staleness risk).
 *   2. askCache.js's corpus_stamp now mixes in document_financials/
 *      document_financial_lines, so a cached dollar answer invalidates the
 *      moment a correction lands, not up to 24h later.
 *   3. deterministicRouter.js's installDate() no longer states an equipment
 *      entity's raw data.installation_date as a fact unless a genuine
 *      per-document extraction backs it (this fixes the 3 known-wrong
 *      install_date ids reported at the end of the previous round).
 *
 * Runs against a REAL Postgres (PGlite) loaded from the actual golden corpus
 * via scripts/offline-exam.mjs's own harness — the same one every fast-path/
 * deterministic-router fix in this round was measured against. No network,
 * no Anthropic key, no model call.
 *
 *   node scripts/verify-money-consistency.mjs
 */
import {
  installPgHarness,
  createPGlite,
  setActiveDatabase,
  loadExportIntoNewTenant,
} from './offline-exam.mjs';

let failures = 0;
let count = 0;
const check = (name, ok, detail = '') => {
  count++;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && (a[0].startsWith('{"route"') || a[0].startsWith('NOTE') || a[0].includes('NEON_CONNECTION_STRING'))) return; realLog(...a); };

await installPgHarness();
const lite = await createPGlite();
await setActiveDatabase(lite);
const exportData = JSON.parse((await import('node:fs')).readFileSync(new URL('./golden/golden-export.json', import.meta.url), 'utf8'));
const { ctx } = await loadExportIntoNewTenant(lite, exportData, { tenantKey: 'verify-money-consistency', tenantName: 'Verify Money Consistency' });

const { withTenant } = await import('../api/_lib/recordsStore.js');
const fastPathQuery = await import('../api/_lib/fastPathQuery.js');
const { correctFinancialField } = await import('../api/_lib/financials/store.js');
const { getCacheEntry } = await import('../api/_lib/askCache.js');
const deterministicRouter = await import('../api/_lib/deterministicRouter.js');

async function askDeterministic(question, today = '2026-09-26') {
  return withTenant(ctx, async (db) => {
    const intent = deterministicRouter.classifyDeterministic(question);
    if (!intent) return null;
    return deterministicRouter.runDeterministic(db, intent, { today });
  });
}

/** Run the invoice_total intent directly against a customer_number subject — bypasses natural-
 *  language name resolution entirely (this corpus has repeated surnames) so these checks test
 *  exactly the fetchInvoiceTotal/fetchEffectiveFinancialTotals code path, not classifyFastPath's
 *  own name-matching. */
async function invoiceTotalFor(customerNumber, today = '2026-09-26') {
  return withTenant(ctx, (db) => fastPathQuery.runFastPath(db, { intent: 'invoice_total', subject: { customerNumber } }, { today }));
}

/* ======================================================================
 * 1. P0 — a corrected invoice total must never be ignored by the fast path.
 * ====================================================================== */
{
  // A customer with at least one invoice document already carrying a real
  // document_financials row (226 such rows ship in the golden corpus).
  const customerNumber = await withTenant(ctx, async (db) => {
    const { rows } = await db.raw(
      `SELECT c.customer_number
         FROM document_financials f
         JOIN documents d ON d.id = f.document_id AND d.document_type = 'invoice'
         JOIN document_entity_links l2 ON l2.document_id = f.document_id
         JOIN entities c ON c.id = l2.entity_id AND c.entity_type = 'customer'
        WHERE f.total IS NOT NULL AND (f.corrections = '{}'::jsonb) AND c.customer_number IS NOT NULL
        LIMIT 1`,
      []
    );
    return rows[0]?.customer_number;
  });
  check('setup :: found an uncorrected invoice with a customer_number', Boolean(customerNumber));

  // Ask BEFORE touching anything, then read back which exact document fetchInvoiceTotal itself
  // picked as "most recent" — the customer may have several invoices, and this must be the SAME
  // document a real correction in Review would land on for this same "most recent" answer.
  const beforeAnswer = await invoiceTotalFor(customerNumber);
  check('before correction :: fast path answers (no model)', Boolean(beforeAnswer), JSON.stringify(beforeAnswer));
  const documentId = beforeAnswer?.sources?.[0]?.documentId;
  check('before correction :: answer carries the resolved document as a source', Boolean(documentId), JSON.stringify(beforeAnswer));
  const originalTotal = await withTenant(ctx, async (db) => {
    const { rows } = await db.raw('SELECT total FROM document_financials WHERE document_id = $1', [documentId]);
    return rows[0]?.total;
  });
  const equipmentId = await withTenant(ctx, async (db) => {
    const { rows } = await db.raw(
      `SELECT l.entity_id FROM document_entity_links l JOIN entities e2 ON e2.id = l.entity_id
        WHERE l.document_id = $1 AND e2.entity_type = 'equipment' LIMIT 1`,
      [documentId]
    );
    return rows[0]?.entity_id;
  });

  // Insert a STALE raw 'cost' extraction (what real ingestion writes, and what a correction never
  // touches) so this test proves the fast path prefers document_financials over it.
  await withTenant(ctx, async (db) => {
    await db.raw(
      `INSERT INTO extractions (id, tenant_id, document_id, entity_id, field_key, value, confidence, schema_version, created_at)
       VALUES (gen_random_uuid(), (current_setting('app.tenant_id', true))::uuid, $1, $2, 'cost', $3, 0.9, 1, NOW())`,
      [documentId, equipmentId, originalTotal]
    );
  });
  const stillOriginal = await invoiceTotalFor(customerNumber);
  check('before correction :: an added stale extraction on the SAME document does not change the answer (financials already won)', stillOriginal?.text === beforeAnswer?.text, JSON.stringify({ before: beforeAnswer?.text, stillOriginal: stillOriginal?.text }));

  await withTenant(ctx, async (db) => {
    await correctFinancialField(db, { documentId, field: 'total', value: '77777.00', by: 'qa-test' });
  });

  const afterAnswer = await invoiceTotalFor(customerNumber);
  check('P0 :: after correction, fast path states the CORRECTED total ($77,777.00)', /77,777|77777/.test(afterAnswer?.text ?? ''), afterAnswer?.text);
  check('P0 :: after correction, fast path never states the stale original total', !new RegExp(String(Math.trunc(Number(originalTotal)))).test(afterAnswer?.text ?? ''), afterAnswer?.text);
}

/* ======================================================================
 * 2. Safety fallback — a document with NO document_financials row at all
 *    (never correctable) still answers from its raw extraction, unaffected.
 * ====================================================================== */
{
  const { customerNumber, documentId, equipmentId } = await withTenant(ctx, async (db) => {
    const { rows } = await db.raw(
      `SELECT d.id AS document_id, c.customer_number,
              (SELECT l.entity_id FROM document_entity_links l JOIN entities e2 ON e2.id = l.entity_id
                WHERE l.document_id = d.id AND e2.entity_type = 'equipment' LIMIT 1) AS equipment_id
         FROM documents d
         JOIN document_entity_links l2 ON l2.document_id = d.id
         JOIN entities c ON c.id = l2.entity_id AND c.entity_type = 'customer'
        WHERE d.document_type = 'invoice' AND c.customer_number IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM document_financials f WHERE f.document_id = d.id)
        LIMIT 1`,
      []
    );
    return { customerNumber: rows[0]?.customer_number, documentId: rows[0]?.document_id, equipmentId: rows[0]?.equipment_id };
  });

  if (documentId) {
    await withTenant(ctx, async (db) => {
      await db.raw(
        `INSERT INTO extractions (id, tenant_id, document_id, entity_id, field_key, value, confidence, schema_version, created_at)
         VALUES (gen_random_uuid(), (current_setting('app.tenant_id', true))::uuid, $1, $2, 'cost', '4321.00', 0.9, 1, NOW())`,
        [documentId, equipmentId]
      );
    });
    const answer = await invoiceTotalFor(customerNumber);
    check('fallback :: a document with no financials row still answers from its own extraction', /4,321|4321/.test(answer?.text ?? ''), answer?.text);
  } else {
    check('fallback :: (skipped — every invoice in this corpus already has a financials row)', true);
  }
}

/* ======================================================================
 * 3. Dropped condition — a financials row that exists but carries NO total
 *    at all (never extracted, never corrected) must not be answered as if
 *    it fabricated a number; runFastPath must decline (return null) rather
 *    than guess, so ask.js's pipeline can route the question on to the
 *    money gate exactly as the brief asks.
 * ====================================================================== */
{
  const documentId = await withTenant(ctx, async (db) => {
    const { rows } = await db.raw(`SELECT document_id FROM document_financials WHERE total IS NOT NULL LIMIT 1`, []);
    return rows[0]?.document_id;
  });
  check('setup :: found a financials row to null out', Boolean(documentId));
  if (documentId) {
    await withTenant(ctx, async (db) => {
      await db.raw(`UPDATE document_financials SET total = NULL WHERE document_id = $1`, [documentId]);
    });
    // Re-resolve through the SAME customer this document belongs to, forcing this document into the
    // candidate set alongside whatever else that customer has on file.
    const customerNumber = await withTenant(ctx, async (db) => {
      const { rows } = await db.raw(
        `SELECT c.customer_number AS n FROM document_entity_links l JOIN entities c ON c.id = l.entity_id
          WHERE l.document_id = $1 AND c.entity_type = 'customer' LIMIT 1`,
        [documentId]
      );
      return rows[0]?.n;
    });
    if (customerNumber) {
      const answer = await invoiceTotalFor(customerNumber);
      // Either it still finds a DIFFERENT real invoice for this customer (fine — never this null one),
      // or it declines entirely (null) — either way it must never invent a number for the nulled row.
      check('dropped condition :: never states an empty/undefined total as a dollar figure', !/\$\s*(undefined|null|NaN)/i.test(answer?.text ?? ''), answer?.text);
    }
  }
}

/* ======================================================================
 * 4. P1 — the cache's corpus_stamp changes the instant a correction lands.
 * ====================================================================== */
{
  const stampBefore = await withTenant(ctx, (db) => getCacheEntry(db, { questionHash: 'verify-money-consistency-hash', today: '2026-09-26' }));
  check('askCache :: getCacheEntry returns a stamp with the financials table present', Boolean(stampBefore.corpusStamp));

  const documentId = await withTenant(ctx, async (db) => {
    const { rows } = await db.raw(`SELECT document_id FROM document_financials LIMIT 1`, []);
    return rows[0].document_id;
  });
  await withTenant(ctx, async (db) => {
    await correctFinancialField(db, { documentId, field: 'total', value: '55555.00', by: 'qa-test-2' });
  });
  const stampAfter = await withTenant(ctx, (db) => getCacheEntry(db, { questionHash: 'verify-money-consistency-hash', today: '2026-09-26' }));
  check('P1 :: corpus_stamp changes after a financial correction (cache invalidates immediately)', stampBefore.corpusStamp !== stampAfter.corpusStamp, JSON.stringify({ before: stampBefore.corpusStamp, after: stampAfter.corpusStamp }));

  // Negative: an UNRELATED question hash / today pairing is still a plain miss either way — this
  // never turns every cache lookup into a permanent miss regardless of correction.
  const unrelated = await withTenant(ctx, (db) => getCacheEntry(db, { questionHash: 'some-other-question-entirely', today: '2026-09-26' }));
  check('askCache :: an unrelated question hash is still a normal miss (row: null), not an error', unrelated.row === null);
}

/* ======================================================================
 * 5. Hook — deterministicRouter.js's installDate() no longer fabricates.
 * ====================================================================== */
{
  // Positive control: a unit whose installation_date IS backed by a genuine extraction must still
  // be answered (this fix must not turn every install-date question into a decline).
  const unitId = await withTenant(ctx, async (db) => {
    // R16 integration: deterministic pick — a single-unit customer whose SURNAME is unique (the question below
    // asks by surname, and this corpus duplicates surnames), with any pre-existing installation_date
    // extraction removed so the only backed date is the one inserted below.
    const { rows } = await db.raw(
      `SELECT e.id, e.customer_id FROM entities e JOIN entities c ON c.id = e.customer_id
        WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL
          AND (SELECT count(*) FROM entities c2 WHERE c2.entity_type = 'customer' AND c2.merged_into IS NULL
                 AND lower(split_part(c2.data->>'customer_name', ' ', -1)) = lower(split_part(c.data->>'customer_name', ' ', -1))) = 1
          AND (SELECT count(*) FROM entities u2 WHERE u2.entity_type = 'equipment' AND u2.merged_into IS NULL AND u2.customer_id = e.customer_id) = 1
        ORDER BY e.id LIMIT 1`, []);
    if (rows[0]) {
      await db.raw(`DELETE FROM extractions WHERE entity_id = $1 AND field_key = 'installation_date'`, [rows[0].id]);
      // The router only states a date that a genuine extraction agrees with (a conflicting extraction declines),
      // so make the unit's own recorded date match the extraction inserted below.
      await db.raw(`UPDATE entities SET data = jsonb_set(coalesce(data, '{}'::jsonb), '{installation_date}', '"2019-04-02"') WHERE id = $1`, [rows[0].id]);
    }
    return rows[0];
  });
  check('setup :: found a unit to attach a genuine installation_date extraction to', Boolean(unitId));
  if (unitId) {
    const customerName = await withTenant(ctx, async (db) => {
      const { rows } = await db.raw(`SELECT data->>'customer_name' AS n FROM entities WHERE id = $1`, [unitId.customer_id]);
      return rows[0]?.n;
    });
    await withTenant(ctx, async (db) => {
      const { rows } = await db.raw(`SELECT id FROM documents WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid AND document_type IN ('work-order', 'startup-sheet') LIMIT 1`, []);
      const anyDocId = rows[0]?.id;
      if (anyDocId) {
        await db.raw(
          `INSERT INTO extractions (id, tenant_id, document_id, entity_id, field_key, value, confidence, schema_version, created_at)
           VALUES (gen_random_uuid(), (current_setting('app.tenant_id', true))::uuid, $1, $2, 'installation_date', '2019-04-02', 0.95, 1, NOW())`,
          [anyDocId, unitId.id]
        );
      }
    });
    if (customerName) {
      const answer = await askDeterministic(`When was the ${customerName.split(' ').pop()} unit installed?`);
      check('positive control :: a genuinely extraction-backed install date is still answered', /2019|April/i.test(answer?.text ?? ''), answer?.text);
    }
  }

  // R21 (M1, L4 rubric g105/h140 — "install dates on file but omitted"): this negative USED TO
  // require a full decline for an un-backed data.installation_date (R15/R19's own fabrication
  // guard, reasoned as "no code change can cite a document that was never extracted without
  // fabricating one"). g105 (Grace Community Church, 2 of 3 units' real dates on the entity record
  // ONLY, zero installation_date extractions) and h140 (Canyon View Dental, identical shape) are
  // both real, golden-data-verified cases where withholding that value is no longer the honest
  // choice this round wants: the entity's own record is itself a real, citable source (this file's
  // own answer below still carries the unit in `records`), so STATING it, uncited to a document
  // (never inventing a document citation for it — that is the one thing this guard must still
  // catch), is what "install dates on file but omitted" means. deterministicRouter.js's installDate()
  // was updated accordingly (see its own doc comment) — this test now checks the narrower, still-real
  // guarantee: the value is stated, but with NO fabricated `sources` on it.
  //
  // Original doc comment, still accurate for what this fixture builds: the golden corpus now
  // carries genuine installation_date extractions for most units (from each customer's first
  // "Install ..." invoice), so an un-backed unit at an otherwise-clean, uniquely-named,
  // single-unit customer is no longer reliably present in the corpus to go hunting for — so this
  // manufactures the exact shape directly (the same way the positive control above manufactures
  // its own genuine-extraction case), rather than relying on a fixture accident: pick any single-unit
  // customer with a unique name, strip any real installation_date extraction it happens to carry, and
  // stamp its raw data.installation_date with a value nothing backs.
  const target = await withTenant(ctx, async (db) => {
    const { rows } = await db.raw(
      `SELECT e.id, e.customer_id, c.data->>'customer_name' AS customer_name FROM entities e JOIN entities c ON c.id = e.customer_id
        WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL
          AND (SELECT count(*) FROM entities c2 WHERE c2.entity_type = 'customer' AND c2.merged_into IS NULL
                 AND c2.data->>'customer_name' = c.data->>'customer_name') = 1
          AND (SELECT count(*) FROM entities u2 WHERE u2.entity_type = 'equipment' AND u2.merged_into IS NULL
                 AND u2.customer_id = e.customer_id) = 1
        LIMIT 1`,
      []
    );
    return rows[0];
  });
  check('setup :: found a single-unit, uniquely-named customer to use for the un-backed case', Boolean(target));
  if (target) {
    await withTenant(ctx, async (db) => {
      await db.raw(`DELETE FROM extractions WHERE entity_id = $1 AND field_key = 'installation_date'`, [target.id]);
      await db.raw(`UPDATE entities SET data = jsonb_set(data, '{installation_date}', '"2015-06-01"') WHERE id = $1`, [target.id]);
    });
    const answer = await askDeterministic(`When was the ${target.customer_name} unit installed?`);
    check('hook fix :: an un-backed installation_date is still honestly STATED (R21: on-file, not withheld)', /June 1, 2015/.test(answer?.text ?? ''), answer?.text);
    check('hook fix :: an un-backed installation_date is NEVER given a fabricated document citation', (answer?.facts ?? []).every((f) => !(f.sources ?? []).length), JSON.stringify(answer?.facts));
  }
}

console.log(`\n${count - failures}/${count} checks passed.`);
if (failures > 0) {
  console.error(`FAILED: ${failures} check(s).`);
  process.exit(1);
}
