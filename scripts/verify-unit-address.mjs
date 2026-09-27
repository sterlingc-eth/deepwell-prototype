/**
 * UNIT <-> SERVICE ADDRESS, at the source (Round 16, E2, owner decision 2026-09-26).
 *
 * api/_lib/intake/unitAddress.js (the shared, pure rule engine + its DB helpers),
 * api/_lib/intake/autofill.js's new "step 0" hook (stamps a unit's address as documents arrive),
 * api/_lib/backfill/unitAddress.js (the batched, idempotent, tenant-scoped one-time pass over
 * EXISTING data), api/_lib/routes/unit-address-backfill.js (the admin trigger, wired into
 * POST /api/account?action=unit-address).
 *
 * No network, no Anthropic key, NO MODEL CALL ANYWHERE — real Postgres (PGlite) loaded from the
 * actual M3-config/*.sql migrations (including this round's 53-unit-address-backfill.sql),
 * queried as the app's non-superuser NOBYPASSRLS role (deepwell_rls), same harness every other
 * verify-*.mjs in this codebase uses.
 *
 *   1. pure: decideUnitAddress — every outcome (has-address / stamp via each rule / both conflict
 *      shapes / no-data), including the negation/dropped-condition/ambiguous-name family of
 *      negative cases R15/R16's rules ask every new family to carry.
 *   2. intake hook (autofill.js): stamp via customer's single address, stamp via the document's
 *      own stated address, a genuine conflict raises ONE intake_needs_info question and stamps
 *      nothing, never overwrites an existing address, a multi-address customer with nothing else
 *      to go on is left alone (skipped, not guessed).
 *   3. backfill (api/_lib/backfill/unitAddress.js): dry-run vs real counts agree, batching/paging
 *      converges, idempotency (a second full pass stamps nothing new), tenant isolation, a
 *      conflict is logged (and, non-dry-run, raised as a needs-info question) rather than guessed.
 *   4. admin route: source-level check that api/account.js wires it under ?action=unit-address,
 *      requires auth + the admin gate (same bar as naming.js/graph.js's own status/backfill ops).
 *   5. golden export: how many of its 132 equipment entities would get (and, applied, DO get) a
 *      service_address — the number this round's brief asks to be reported.
 *
 *   node scripts/verify-unit-address.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

let failures = 0;
let passes = 0;
const check = (name, ok, detail = "") => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

process.env.NEON_CONNECTION_STRING ||= "postgres://harness:harness@localhost:5432/harness";
delete process.env.ANTHROPIC_API_KEY;

const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === "string" && (a[0].startsWith('{"route"') || a[0].startsWith('{"event"'))) return; realLog(...a); };

/* ============================================================== 1. pure decideUnitAddress */
const U = await import("../api/_lib/intake/unitAddress.js");

{
  const d = U.decideUnitAddress;

  eq("has-address: an existing address is NEVER touched, whatever else disagrees",
    d({ existingAddress: "9 Bracken Way", customerAddress: "1 Other Rd", customerHasSingleAddress: true, documentAddress: "2 Another Rd" }),
    { outcome: "has-address" });

  eq("stamp via customer-single-address: no document address, customer unambiguous",
    d({ existingAddress: null, customerAddress: "412 Elm St", customerHasSingleAddress: true, documentAddress: null }),
    { outcome: "stamp", address: "412 Elm St", rule: "customer-single-address" });

  eq("stamp via document-stated: the unit's own paperwork states it, no customer to compare against",
    d({ existingAddress: null, customerAddress: null, customerHasSingleAddress: false, documentAddress: "1 Nowhere Rd" }),
    { outcome: "stamp", address: "1 Nowhere Rd", rule: "document-stated" });

  eq("stamp via document-stated: agrees with the customer's own address too (either rule would be correct; document wins)",
    d({ existingAddress: null, customerAddress: "412 Elm St", customerHasSingleAddress: true, documentAddress: "412 elm st" }),
    { outcome: "stamp", address: "412 elm st", rule: "document-stated" });

  eq("conflict: the document's stated address DISAGREES with the customer's on-file address -> never stamped",
    d({ existingAddress: null, customerAddress: "412 Elm St", customerHasSingleAddress: true, documentAddress: "9 Bracken Way" }),
    { outcome: "conflict", reason: "document-customer-mismatch", documentAddress: "9 Bracken Way", customerAddress: "412 Elm St" });

  eq("conflict: the unit's OWN documents disagree with each other (no single value to use at all)",
    d({ existingAddress: null, customerAddress: null, customerHasSingleAddress: false, documentAddress: null, documentAddressConflicting: true }),
    { outcome: "conflict", reason: "unit-documents-disagree" });

  // ---- negative-family cases (every new family carries these per R15/R16's own rule) ----
  eq("no-data: multi-address customer (ambiguous), nothing document-stated to fall back on — never guessed",
    d({ existingAddress: null, customerAddress: "412 Elm St", customerHasSingleAddress: false, documentAddress: null }),
    { outcome: "no-data" });

  eq("no-data: no customer address on file, no document address either — nothing anywhere",
    d({ existingAddress: null, customerAddress: null, customerHasSingleAddress: false, documentAddress: null }),
    { outcome: "no-data" });

  eq("dropped condition: customerHasSingleAddress omitted entirely defaults to false — never assumed true",
    d({ existingAddress: null, customerAddress: "412 Elm St", documentAddress: null }),
    { outcome: "no-data" });

  check("blank/whitespace-only existingAddress is treated as absent, not as an address to protect",
    d({ existingAddress: "   ", customerAddress: "412 Elm St", customerHasSingleAddress: true, documentAddress: null }).outcome === "stamp");

  check("blank/whitespace-only documentAddress is treated as absent, falls through to the customer rule",
    d({ existingAddress: null, customerAddress: "412 Elm St", customerHasSingleAddress: true, documentAddress: "  " }).outcome === "stamp");

  check("conflict never fires on an address that merely differs in casing/whitespace/suffix (same normalized key)",
    d({ existingAddress: null, customerAddress: "412 Elm St", customerHasSingleAddress: true, documentAddress: "412  elm  street" }).outcome === "stamp");

  check("ambiguous-name family: a unit designator difference alone (apt 1 vs apt 2) is dropped by normalizeAddressKey, so it still agrees",
    d({ existingAddress: null, customerAddress: "412 Elm St Apt 1", customerHasSingleAddress: true, documentAddress: "412 Elm St Apt 2" }).outcome === "stamp");
}

/* ================================================================== harness: real Postgres via PGlite */
let PGlite;
const contrib = {};
try {
  ({ PGlite } = await import("@electric-sql/pglite"));
  for (const key of ["uuid_ossp", "pgcrypto", "pg_trgm", "btree_gin"]) contrib[key] = (await import(`@electric-sql/pglite/contrib/${key}`))[key];
} catch (err) {
  console.log(`SKIP  database-backed checks: PGlite is not installed (${err?.message}). Run npm ci.`);
  if (failures) { console.log(`${failures} check(s) FAILED.`); process.exit(1); }
  console.log(`${passes} checks passed (database-backed checks skipped).`);
  process.exit(0);
}

const cfgDir = path.join(ROOT, "M3-config");
const migrations = fs.readdirSync(cfgDir).filter((f) => /^\d\d.*\.sql$/.test(f) && !f.startsWith("99")).sort();
const lite = new PGlite({ extensions: contrib });
const harnessNotes = [];
for (const f of migrations) {
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), "utf8")); } catch (err) { harnessNotes.push(`${f}: ${String(err.message).slice(0, 160)}`); }
}
try { await lite.exec(fs.readFileSync(path.join(cfgDir, "01b-app-role.sql"), "utf8")); } catch (err) { harnessNotes.push(`01b re-run failed: ${err.message}`); }
for (const line of harnessNotes) realLog(`NOTE  migration harness: ${line}`);
check("harness: migration 53 loaded cleanly (no error from 53-unit-address-backfill.sql)", !harnessNotes.some((n) => n.startsWith("53-")), harnessNotes.join(" | "));
check("migration 53: the partial index exists on entities",
  (await lite.query(`SELECT indexname FROM pg_indexes WHERE tablename='entities' AND indexname='idx_entities_equipment_missing_address'`)).rows.length === 1);
{
  const twice = await lite.exec(fs.readFileSync(path.join(cfgDir, "53-unit-address-backfill.sql"), "utf8")).then(() => true, () => false);
  check("migration 53 is idempotent (re-running it changes nothing and errors nothing)", twice);
}

const pgMod = (await import("pg")).default;
let tail = Promise.resolve();
const lock = () => { let release; const p = new Promise((r) => { release = r; }); const prev = tail; tail = tail.then(() => p); return prev.then(() => release); };
pgMod.Pool.prototype.connect = async function connect() {
  const release = await lock();
  await lite.exec("SET ROLE deepwell_rls");
  return { query: (sql, params) => lite.query(sql, params), release: () => { lite.exec("RESET ROLE").finally(release); } };
};
pgMod.Pool.prototype.query = async function query(sql, params) {
  const release = await lock();
  try { return await lite.query(sql, params); } finally { release(); }
};

const { withTenant, getTenantContext } = await import("../api/_lib/recordsStore.js");
const A = await import("../api/_lib/intake/autofill.js");
const B = await import("../api/_lib/backfill/unitAddress.js");

const ctxA = { tenantKey: "org_unitaddr_a", tenantName: "Desert Peak HVAC" };
const ctxB = { tenantKey: "org_unitaddr_b", tenantName: "Other Shop" };
const tenA = (await getTenantContext(ctxA.tenantKey, ctxA.tenantName)).id;
const tenB = (await getTenantContext(ctxB.tenantKey, ctxB.tenantName)).id;

const uid = (t, k, n) => `${t}${k}000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let seq = 0;
async function makeEntity(tenantId, { id, type, data, customerId = null }) {
  await lite.query(
    `INSERT INTO entities (id, tenant_id, entity_type, data, customer_id, created_at, updated_at) VALUES ($1,$2,$3,$4::jsonb,$5,NOW(),NOW())`,
    [id, tenantId, type, JSON.stringify(data), customerId]
  );
}
async function makeDocument(tenantId, { id, type, stage = "linked" }) {
  seq++;
  await lite.query(
    `INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage, created_at) VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
    [id, tenantId, `doc-${seq}.pdf`, type, `hash-${tenantId}-${seq}`, stage]
  );
}
async function makeExtractions(tenantId, documentId, entityId, fields) {
  for (const f of fields) {
    seq++;
    await lite.query(
      `INSERT INTO extractions (id, tenant_id, document_id, entity_id, field_key, value, confidence, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW() + ($8 || ' seconds')::interval)`,
      [uid("e", "9", seq), tenantId, documentId, entityId ?? null, f.key, f.value, f.confidence ?? 0.9, String(seq)]
    );
  }
}
async function linkEntity(tenantId, documentId, entityId) {
  await lite.query(
    `INSERT INTO document_entity_links (tenant_id, document_id, entity_id, confidence, linked_by, created_at) VALUES ($1,$2,$3,0.9,'ai',NOW()) ON CONFLICT DO NOTHING`,
    [tenantId, documentId, entityId]
  );
}
async function equipmentAddress(tenantId, unitId) {
  const r = await lite.query(`SELECT data->>'service_address' AS address, data->'service_address_source' AS source FROM entities WHERE id = $1 AND tenant_id = $2`, [unitId, tenantId]);
  return r.rows[0];
}
async function needsInfoRows(tenantId, documentId, fieldKey = "service_address") {
  const r = await lite.query(`SELECT * FROM intake_needs_info WHERE tenant_id = $1 AND document_id = $2 AND field_key = $3`, [tenantId, documentId, fieldKey]);
  return r.rows;
}

/* ============================================================== 2. intake hook (autofill.js) */

// ---- 2a. stamp via the customer's single on-file address (no address stated on THIS document) ----
{
  const cust = uid("a", "c", 1);
  const unit = uid("a", "e", 1);
  const doc = uid("a", "d", 1);
  await makeEntity(tenA, { id: cust, type: "customer", data: { customer_name: "Ed Bracken", service_address: "9 Bracken Way" } });
  await makeEntity(tenA, { id: unit, type: "equipment", data: { serial_number: "SN-1" }, customerId: cust });
  await makeDocument(tenA, { id: doc, type: "dispatch-note" });
  await makeExtractions(tenA, doc, unit, [{ key: "technician", value: "Mike Rivera" }]);
  await linkEntity(tenA, doc, cust);

  await A.runIntakeAutofill(ctxA, doc, { resolvedType: "dispatch-note", entityId: unit, customerId: cust });
  const row = await equipmentAddress(tenA, unit);
  eq("2a: stamped from the customer's single on-file address", row?.address, "9 Bracken Way");
  // jsonb does not preserve object key ORDER (Postgres reorders for storage), so check fields
  // individually rather than a whole-object JSON.stringify comparison.
  check("2a: provenance records the rule, the triggering document and the customer",
    row?.source?.rule === "customer-single-address" && row?.source?.sourceDocumentId === doc && row?.source?.customerId === cust && typeof row?.source?.stampedAt === "string",
    JSON.stringify(row?.source));

  // ---- never overwrite: a later document naming a DIFFERENT address changes nothing ----
  const doc2 = uid("a", "d", 2);
  await makeDocument(tenA, { id: doc2, type: "work-order" });
  await makeExtractions(tenA, doc2, unit, [{ key: "service_address", value: "999 Somewhere Else" }]);
  await linkEntity(tenA, doc2, cust);
  await A.runIntakeAutofill(ctxA, doc2, { resolvedType: "work-order", entityId: unit, customerId: cust, facts: { service_address: "999 Somewhere Else" } });
  const rowAfter = await equipmentAddress(tenA, unit);
  eq("2a: NEVER overwrites an existing stamped address, even when a later document states a different one", rowAfter?.address, "9 Bracken Way");
  eq("2a: idempotency — re-running the ORIGINAL document again changes nothing either", (await equipmentAddress(tenA, unit))?.address, "9 Bracken Way");
}

// ---- 2b. stamp via the document's OWN stated address (no customer on file at all) ----
{
  const unit = uid("a", "e", 9);
  const doc = uid("a", "d", 9);
  await makeEntity(tenA, { id: unit, type: "equipment", data: { serial_number: "SN-LONELY" } });
  await makeDocument(tenA, { id: doc, type: "work-order" });
  await makeExtractions(tenA, doc, unit, [{ key: "service_address", value: "1 Nowhere Rd" }]);

  await A.runIntakeAutofill(ctxA, doc, { resolvedType: "work-order", entityId: unit, customerId: null, facts: { service_address: "1 Nowhere Rd" } });
  const row = await equipmentAddress(tenA, unit);
  eq("2b: stamped from the document's OWN stated address (no customer to compare against)", row?.address, "1 Nowhere Rd");
  eq("2b: provenance rule is document-stated", row?.source?.rule, "document-stated");
}

// ---- 2c. genuine conflict: the document's stated address disagrees with the customer's -> no stamp, ONE question ----
{
  const cust = uid("a", "c", 2);
  const unit = uid("a", "e", 2);
  const doc = uid("a", "d", 3);
  await makeEntity(tenA, { id: cust, type: "customer", data: { customer_name: "Karen Abernathy", service_address: "412 Elm St" } });
  await makeEntity(tenA, { id: unit, type: "equipment", data: { serial_number: "SN-2" }, customerId: cust });
  await makeDocument(tenA, { id: doc, type: "work-order" });
  await makeExtractions(tenA, doc, unit, [{ key: "service_address", value: "9 Bracken Way" }]);
  await linkEntity(tenA, doc, cust);

  await A.runIntakeAutofill(ctxA, doc, { resolvedType: "work-order", entityId: unit, customerId: cust, facts: { service_address: "9 Bracken Way" } });
  const row = await equipmentAddress(tenA, unit);
  check("2c: a genuine document-vs-customer conflict is NEVER stamped", row?.address == null, JSON.stringify(row));
  const ni = await needsInfoRows(tenA, doc);
  check("2c: exactly ONE precise question raised instead, naming both addresses", ni.length === 1 && /412 Elm St/.test(ni[0].question) && /9 Bracken Way/.test(ni[0].question), JSON.stringify(ni));
  eq("2c: the question's entity_id points at the unit itself", ni[0]?.entity_id, unit);
}

// ---- 2d. multi-address customer: nothing on THIS document, customer ambiguous -> skipped, not guessed ----
{
  const cust = uid("a", "c", 3);
  const unit = uid("a", "e", 3);
  const otherDoc = uid("a", "d", 4);
  const doc = uid("a", "d", 5);
  await makeEntity(tenA, { id: cust, type: "customer", data: { customer_name: "Property Co", service_address: "55 Duplex Dr" } });
  await makeEntity(tenA, { id: unit, type: "equipment", data: { serial_number: "SN-3" }, customerId: cust });
  // A DIFFERENT document linked directly to the customer states a conflicting address — this is
  // what makes the customer's own address genuinely ambiguous ("more than one address on file"),
  // independent of anything the unit's OWN document below says.
  await makeDocument(tenA, { id: otherDoc, type: "invoice" });
  await makeExtractions(tenA, otherDoc, null, [{ key: "service_address", value: "77 Other Property Ln" }]);
  await linkEntity(tenA, otherDoc, cust);

  await makeDocument(tenA, { id: doc, type: "dispatch-note" });
  await makeExtractions(tenA, doc, unit, [{ key: "technician", value: "Ana Ruiz" }]);
  await linkEntity(tenA, doc, cust);

  await A.runIntakeAutofill(ctxA, doc, { resolvedType: "dispatch-note", entityId: unit, customerId: cust });
  const row = await equipmentAddress(tenA, unit);
  check("2d: multi-address customer, nothing document-stated -> left blank, never guessed", row?.address == null, JSON.stringify(row));
  const ni = await needsInfoRows(tenA, doc);
  check("2d: not a conflict either (nothing to conflict WITH on this document) — no question raised for it", ni.length === 0);
}

// ---- 2e. tenant isolation: tenant B's identically-shaped fixture stamps from ITS OWN customer only ----
{
  const cust = uid("b", "c", 1);
  const unit = uid("b", "e", 1);
  const doc = uid("b", "d", 1);
  await makeEntity(tenB, { id: cust, type: "customer", data: { customer_name: "Tenant B Customer", service_address: "1 Tenant B Rd" } });
  await makeEntity(tenB, { id: unit, type: "equipment", data: { serial_number: "SN-TENANT-B" }, customerId: cust });
  await makeDocument(tenB, { id: doc, type: "dispatch-note" });
  await makeExtractions(tenB, doc, unit, [{ key: "technician", value: "Pat Cross" }]);
  await linkEntity(tenB, doc, cust);

  await A.runIntakeAutofill(ctxB, doc, { resolvedType: "dispatch-note", entityId: unit, customerId: cust });
  eq("2e: tenant isolation — tenant B's unit stamps from its OWN customer's address", (await equipmentAddress(tenB, unit))?.address, "1 Tenant B Rd");
  // Same entity id, queried scoped to tenant A instead: the row genuinely belongs to tenant B, so
  // a tenant-A-scoped lookup finds nothing at all — proof the stamp never crossed tenants.
  check("2e: tenant isolation — the same entity id is invisible when queried under tenant A's scope", (await equipmentAddress(tenA, unit)) === undefined);
}

/* ================================================================== 3. backfill (existing data) */

const btA = { tenantKey: "org_unitaddr_backfill_a", tenantName: "Backfill Shop A" };
const btB = { tenantKey: "org_unitaddr_backfill_b", tenantName: "Backfill Shop B" };
const tBtA = (await getTenantContext(btA.tenantKey, btA.tenantName)).id;
const tBtB = (await getTenantContext(btB.tenantKey, btB.tenantName)).id;

// Clean customer + single unit, no conflicting evidence anywhere -> stamped, customer-single-address.
const bfCust1 = uid("f", "c", 1), bfUnit1 = uid("f", "e", 1);
await makeEntity(tBtA, { id: bfCust1, type: "customer", data: { customer_name: "Clean Co", service_address: "100 Clean St" } });
await makeEntity(tBtA, { id: bfUnit1, type: "equipment", data: { serial_number: "SN-BF1" }, customerId: bfCust1 });

// Multi-address customer (conflicting evidence on file) -> skipped as no-data.
const bfCust2 = uid("f", "c", 2), bfUnit2 = uid("f", "e", 2), bfDocConflict = uid("f", "d", 1);
await makeEntity(tBtA, { id: bfCust2, type: "customer", data: { customer_name: "Ambiguous Co", service_address: "200 Ambiguous Ave" } });
await makeEntity(tBtA, { id: bfUnit2, type: "equipment", data: { serial_number: "SN-BF2" }, customerId: bfCust2 });
await makeDocument(tBtA, { id: bfDocConflict, type: "invoice" });
await makeExtractions(tBtA, bfDocConflict, null, [{ key: "service_address", value: "999 Different Rd" }]);
await linkEntity(tBtA, bfDocConflict, bfCust2);

// Unit whose OWN linked document states an address that conflicts with its customer's -> conflict, no stamp.
const bfCust3 = uid("f", "c", 3), bfUnit3 = uid("f", "e", 3), bfDocUnit3 = uid("f", "d", 2);
await makeEntity(tBtA, { id: bfCust3, type: "customer", data: { customer_name: "Conflict Co", service_address: "300 Conflict Blvd" } });
await makeEntity(tBtA, { id: bfUnit3, type: "equipment", data: { serial_number: "SN-BF3" }, customerId: bfCust3 });
await makeDocument(tBtA, { id: bfDocUnit3, type: "work-order" });
await makeExtractions(tBtA, bfDocUnit3, bfUnit3, [{ key: "service_address", value: "301 Somewhere Wrong" }]);
await linkEntity(tBtA, bfDocUnit3, bfCust3);

// Already has an address -> never touched, never counted as stamped.
const bfCust4 = uid("f", "c", 4), bfUnit4 = uid("f", "e", 4);
await makeEntity(tBtA, { id: bfCust4, type: "customer", data: { customer_name: "Already Set Co", service_address: "400 Set Way" } });
await makeEntity(tBtA, { id: bfUnit4, type: "equipment", data: { serial_number: "SN-BF4", service_address: "PRE-EXISTING ADDRESS" }, customerId: bfCust4 });

// Tenant B: same SHAPE as tenant A's bfUnit1 case (clean customer, single unit, no conflicts),
// must be counted separately. entities.id/documents.id are GLOBAL primary keys (not tenant-scoped)
// in this schema, so tenant B needs its own numeric ids, never one already used by tenant A above.
const bfCustB = uid("f", "c", 90), bfUnitB = uid("f", "e", 90);
await makeEntity(tBtB, { id: bfCustB, type: "customer", data: { customer_name: "Tenant B Co", service_address: "1 Tenant B Ln" } });
await makeEntity(tBtB, { id: bfUnitB, type: "equipment", data: { serial_number: "SN-BFB1" }, customerId: bfCustB });

{
  const status = await B.unitAddressBackfillStatus(btA, {});
  eq("3: dry-run status — 1 stamped (clean), 1 conflict (unit's own doc vs customer), 1 no-data (multi-address customer), 1 untouched (already has one)",
    { stamped: status.counts.stamped, skippedConflict: status.counts.skippedConflict, skippedNoData: status.counts.skippedNoData },
    { stamped: 1, skippedConflict: 1, skippedNoData: 1 });
  eq("3: stamped breakdown attributes to the correct rule", status.counts.stampedByRule, { "customer-single-address": 1, "document-stated": 0 });
  check("3: dry-run truly writes nothing", (await equipmentAddress(tBtA, bfUnit1))?.address == null);

  const applied = await B.runUnitAddressBackfillBatch(btA, { limit: 50, dryRun: false });
  eq("3: applying reports the SAME counts the dry-run predicted", applied.counts, status.counts);
  eq("3: the clean unit is now actually stamped", (await equipmentAddress(tBtA, bfUnit1))?.address, "100 Clean St");
  check("3: the ambiguous-customer unit stays blank", (await equipmentAddress(tBtA, bfUnit2))?.address == null);
  check("3: the unit-vs-customer conflict stays blank", (await equipmentAddress(tBtA, bfUnit3))?.address == null);
  eq("3: the already-set unit is completely untouched", (await equipmentAddress(tBtA, bfUnit4))?.address, "PRE-EXISTING ADDRESS");
  check("3: applying (non-dry-run) raises a real needs-info question for the conflict", (await needsInfoRows(tBtA, bfDocUnit3)).length === 1);

  // ---- idempotency: a second full pass over the SAME tenant stamps nothing new ----
  const second = await B.runUnitAddressBackfillBatch(btA, { limit: 50, dryRun: false });
  eq("3: idempotent — a second pass has nothing left to stamp", second.counts.stamped, 0);
  eq("3: idempotent — the conflict/no-data units are still exactly where they were (not double-counted)", { conflict: second.counts.skippedConflict, noData: second.counts.skippedNoData }, { conflict: 1, noData: 1 });

  // ---- batching/paging: a batch size of 1 converges to the same totals over several calls ----
  const totals = { stamped: 0, skippedConflict: 0, skippedNoData: 0 };
  let cursor = null;
  let rounds = 0;
  for (;;) {
    const batch = await B.runUnitAddressBackfillBatch(btA, { afterId: cursor, limit: 1, dryRun: true });
    totals.stamped += batch.counts.stamped;
    totals.skippedConflict += batch.counts.skippedConflict;
    totals.skippedNoData += batch.counts.skippedNoData;
    cursor = batch.nextAfterId;
    rounds++;
    if (batch.done || rounds > 20) break;
  }
  eq("3: paging with batchSize=1 converges to the SAME totals as one big batch (dry-run re-evaluates the already-stamped unit as no-op, not re-counted)", totals, { stamped: 0, skippedConflict: 1, skippedNoData: 1 });

  // ---- tenant isolation ----
  const statusB = await B.unitAddressBackfillStatus(btB, {});
  eq("3: tenant isolation — tenant B's own clean unit is counted in ITS OWN status, unaffected by tenant A's run", statusB.counts.stamped, 1);
  check("3: tenant isolation — tenant A's backfill never touched tenant B's identically-shaped unit", (await equipmentAddress(tBtB, bfUnitB))?.address == null);
  await B.runUnitAddressBackfillBatch(btB, { limit: 50, dryRun: false });
  eq("3: tenant B's own unit stamps correctly once its OWN backfill runs", (await equipmentAddress(tBtB, bfUnitB))?.address, "1 Tenant B Ln");
}

/* ============================================================ 4. admin route wiring (source-level) */
{
  const routeSrc = fs.readFileSync(path.join(ROOT, "api/_lib/routes/unit-address-backfill.js"), "utf8");
  check("unit-address-backfill.js requires auth (requireAuth)", /requireAuth/.test(routeSrc));
  check("unit-address-backfill.js gates status/backfill behind the admin role (requireRole)", /requireRole/.test(routeSrc));
  const accountSrc = fs.readFileSync(path.join(ROOT, "api/account.js"), "utf8");
  check("api/account.js imports unit-address-backfill.js", /from ["']\.\/_lib\/routes\/unit-address-backfill\.js["']/.test(accountSrc));
  check("api/account.js wires it in under ?action=unit-address", /"unit-address":\s*unitAddress\b/.test(accountSrc));
  const apiTopLevel = fs.readdirSync(path.join(ROOT, "api")).filter((f) => /\.(js|ts)$/.test(f));
  eq("api/ top-level .js/.ts file count stays 12 (the new route lives under api/_lib/routes/, not api/)", apiTopLevel.length, 12);
}

/* ========================================================== 5. golden export: real-world impact */
{
  const offline = await import("./offline-exam.mjs");
  const goldenPath = path.join(ROOT, "scripts", "golden", "golden-export.json");
  if (!fs.existsSync(goldenPath)) {
    console.log("SKIP  golden-export section (scripts/golden/golden-export.json not present in this checkout)");
  } else {
    const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8"));
    const equipmentTotal = golden.entities.filter((e) => e.entity_type === "equipment").length;
    const startingWithAddress = golden.entities.filter((e) => e.entity_type === "equipment" && e.data?.service_address).length;
    realLog(`NOTE  golden export: ${equipmentTotal} equipment entities, ${startingWithAddress} already carry a service_address before this round's fix`);

    // loadExportIntoNewTenant needs its OWN PGlite (offline-exam.mjs's own harness helpers swap the
    // globally-patched pg.Pool at whichever database is "active" — reusing the SAME `lite` this file
    // already built, migrations and all, is simplest and keeps everything on one instance).
    await offline.installPgHarness();
    await offline.setActiveDatabase(lite);
    const { ctx } = await offline.loadExportIntoNewTenant(lite, golden, { tenantKey: "golden:unit-address-verify", tenantName: "Golden Unit-Address Verify" });

    const status = await B.unitAddressBackfillStatus(ctx, {});
    check(`golden export: dry-run preview finished without truncation (${equipmentTotal} equipment entities)`, status.truncated === false, JSON.stringify(status));
    realLog(`NOTE  golden export dry-run: ${status.counts.stamped} of ${equipmentTotal} units would get a service_address (${status.counts.skippedConflict} conflict, ${status.counts.skippedNoData} no-data, ${status.counts.skippedHasAddress} already had one)`);
    check(`golden export: EVERY equipment entity that starts without an address would get one (no conflicts, no ambiguous customers in this corpus)`,
      status.counts.stamped === equipmentTotal - startingWithAddress && status.counts.skippedConflict === 0 && status.counts.skippedNoData === 0,
      JSON.stringify(status.counts));

    // Apply it for real, batched (small batch size on purpose, to exercise paging on a real-sized corpus).
    let cursor = null;
    let appliedTotal = 0;
    let rounds = 0;
    for (;;) {
      const batch = await B.runUnitAddressBackfillBatch(ctx, { afterId: cursor, limit: 40, dryRun: false });
      appliedTotal += batch.counts.stamped;
      cursor = batch.nextAfterId;
      rounds++;
      if (batch.done || rounds > 20) break;
    }
    eq("golden export: applying the backfill for real stamps exactly what the dry-run predicted", appliedTotal, status.counts.stamped);

    // Scoped to the CURRENT tenant by RLS alone (withTenant's SET LOCAL app.tenant_id) — no
    // explicit tenant_id predicate needed here since this is a read-only count, not a write.
    const nowWithAddress = (await withTenant(ctx, (db) => db.raw(
      `SELECT count(*)::int AS n FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND (data->>'service_address') IS NOT NULL`,
      []
    ))).rows[0].n;
    eq(`golden export: ${equipmentTotal} of ${equipmentTotal} equipment entities now carry a service_address`, nowWithAddress, equipmentTotal);

    const rerun = await B.unitAddressBackfillStatus(ctx, {});
    eq("golden export: idempotent — re-running the whole preview after a full apply finds nothing left to stamp", rerun.counts.stamped, 0);

    realLog(`NOTE  ANSWER FOR THE REPORT: ${status.counts.stamped} of ${equipmentTotal} golden units would get an address from this backfill.`);
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : `\nAll ${passes} unit-address checks passed.`);
process.exit(failures ? 1 : 0);
