/**
 * Smoke test for scripts/offline-exam.mjs — the $0/no-model exam runner built for the week the owner's
 * Anthropic credits are exhausted.
 *
 * No network, no real database, no Anthropic key. Two independent PGlite databases in one process, both
 * loaded from the real M3-config/*.sql migrations (offline-exam.mjs's own harness):
 *
 *   DB A ("production") — seeded with a small synthetic shop (business-corpus-style fixtures, same shape
 *   verify-agent.mjs / verify-scorecard.mjs already use), then exported through the REAL
 *   api/_lib/opsStore.js exportTenant — the exact function api/_lib/routes/tenant-export.js's route calls.
 *
 *   DB B ("offline, next week") — completely fresh, empty. The export JSON from DB A is loaded into it under
 *   a new tenant (offline-exam.mjs's loadExportIntoNewTenant), and the full golden exam
 *   (test-docs/scorecard/exam.json) is run against DB B through the real /api/ask handler with the Anthropic
 *   SDK mocked to throw.
 *
 * What this proves, that a unit test of either half alone would not:
 *   1. the export really does carry everything a fresh database needs to reproduce DB A's own answers
 *      (particularly document_entity_links — entirely missing from the export before this build; a
 *      regression here means "customers X owns unit Y" and every fastPath/financials/relations answer that
 *      groups documents by customer would come back empty on the reloaded tenant even though it worked
 *      against the original one) — checked directly against DB B's tables, not just the JSON;
 *   2. the model-block + model-call counter actually distinguishes "answered without a model" from "would
 *      need one" for real exam questions, not just in a hand-written unit case (both buckets must be > 0);
 *   3. the whole 746-question exam finishes fast (this is the one place "fast" is actually timed against the
 *      real question count, not asserted from the docstring).
 *
 *   node scripts/verify-offline-exam.mjs
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
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

process.env.DONOVAN_AGENT_QUERY_TIMEOUT_MS = "3000";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.DONOVAN_ESCALATION;
delete process.env.DONOVAN_SONNET_DAILY_USD;

const realWarn = console.warn; console.warn = () => {};
const realErr = console.error; console.error = () => {};
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === "string" && (a[0].startsWith('{"route"') || a[0].startsWith('{"event"'))) return; realLog(...a); };

let offline;
try {
  offline = await import("./offline-exam.mjs");
} catch (err) {
  realLog(`SKIP  offline-exam.mjs failed to load (${err?.message}). Run npm ci.`);
  process.exit(0);
}
const { installPgHarness, installModelBlock, createPGlite, setActiveDatabase, loadExportIntoNewTenant, runOfflineExam, renderMarkdownReport } = offline;

await installPgHarness();
const modelCounter = await installModelBlock();

/* ================================================================== DB A: seed + real export */
const liteA = await createPGlite();
await setActiveDatabase(liteA);
const { getTenantContext } = await import("../api/_lib/recordsStore.js");
const { exportTenant } = await import("../api/_lib/opsStore.js");

const ctxA = { tenantKey: "org_offline_source", tenantName: "Offline Source Shop" };
const tenA = (await getTenantContext(ctxA.tenantKey, ctxA.tenantName)).id;
const uid = (k, n) => `a${k}000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function ent(id, type, data, extra = {}) {
  await liteA.query(
    "INSERT INTO entities (id, tenant_id, entity_type, data, customer_id, customer_number) VALUES ($1,$2,$3,$4::jsonb,$5,$6)",
    [id, tenA, type, JSON.stringify(data), extra.customerId ?? null, extra.number ?? null]
  );
}

const customers = [
  { n: 1, name: "Karen Abernathy", address: "412 Elm St, Mesa, AZ 85201", phone: "(480) 555-0148", email: "karen@example.com" },
  { n: 2, name: "Bill Whitmore", address: "88 Whitmore Ave, Mesa, AZ 85201" },
  { n: 3, name: "Plaza Dental Group", address: "2210 E Main St, Gilbert, AZ 85234" },
  { n: 4, name: "Donna Thornton", address: "17 Cactus Ln, Tucson, AZ 85701", email: "donna@example.com" },
  { n: 5, name: "Old Timer", address: "5 Oak Rd, Phoenix, AZ 85001" },
];
for (const c of customers) await ent(uid("c", c.n), "customer", { customer_name: c.name, service_address: c.address, phone: c.phone ?? null, email: c.email ?? null }, { number: `C-000${c.n}` });

const equipment = [
  { n: 1, customer: 1, mfr: "Trane", model: "XR14", serial: "TR-1001", type: "condenser", installed: "2020-05-01", address: "412 Elm St, Mesa, AZ 85201", warranty: { expires: "2030-05-01" } },
  { n: 2, customer: 2, mfr: "Goodman", model: "GSX140361K", serial: "GD-2002", type: "condenser", installed: "2016-10-15", address: "88 Whitmore Ave, Mesa, AZ 85201", warranty: { expires: "2026-10-15" } },
  { n: 3, customer: 3, mfr: "Carrier", model: "24ACC636", serial: "CR-3003", type: "condenser", installed: "2014-01-01", address: "2210 E Main St, Gilbert, AZ 85234", warranty: { expires: "2024-01-01" } },
  { n: 4, customer: 4, mfr: "Lennox", model: "EL16XC1", serial: "LX-4004", type: "condenser", installed: "2019-03-03", address: "17 Cactus Ln, Tucson, AZ 85701" },
  { n: 5, customer: 1, mfr: "Trane", model: "S9V2", serial: "TR-1005", type: "furnace", installed: "2021-01-01", address: "412 Elm St, Mesa, AZ 85201", warranty: { expires: "2029-01-01" } },
];
for (const e of equipment) await ent(uid("e", e.n), "equipment", { manufacturer: e.mfr, model: e.model, serial_number: e.serial, equipment_type: e.type, installation_date: e.installed, service_address: e.address, ...(e.warranty ? { warranty: e.warranty } : {}) }, { customerId: uid("c", e.customer) });

const docs = [
  { n: 1, file: "karen-service-sep.pdf", type: "service-ticket", links: [uid("c", 1)], facts: [{ key: "service_date", value: "2026-09-10" }, { key: "technician", value: "D. Ramirez" }], pages: ["Service ticket Karen Abernathy 412 Elm St"] },
  { n: 2, file: "karen-maint-agreement.pdf", type: "maintenance-agreement", links: [uid("c", 1)], facts: [{ key: "agreement_term", value: "01/01/2026 - 12/31/2026" }] },
  { n: 3, file: "whitmore-service-2025.pdf", type: "service-ticket", links: [uid("c", 2)], facts: [{ key: "service_date", value: "2025-11-02" }] },
  { n: 4, file: "whitmore-invoice.pdf", type: "invoice", links: [uid("c", 2)], facts: [{ key: "invoice_number", value: "8841" }] },
  { n: 5, file: "plaza-maint-agreement.pdf", type: "maintenance-agreement", links: [uid("c", 3)] },
  { n: 6, file: "thornton-permit.pdf", type: "permit", links: [uid("c", 4)], facts: [{ key: "permit_number", value: "BP-2024-08841" }], pages: ["City of Tucson building permit BP-2024-08841 issued for 17 Cactus Ln condenser replacement"] },
  { n: 7, file: "plaza-service-sep.pdf", type: "service-ticket", links: [uid("e", 3)], facts: [{ key: "service_date", value: "2026-09-15" }, { key: "technician", value: "D. Ramirez" }] },
  { n: 8, file: "thornton-workorder.pdf", type: "work-order", links: [uid("c", 4)], stage: "read", facts: [{ key: "service_date", value: "2026-03-05" }, { key: "work_performed", value: "Replaced capacitor" }], pages: ["Work order Thornton 17 Cactus Ln. Replaced capacitor."] },
];
let totalLinks = 0;
let totalFacts = 0;
for (const d of docs) {
  await liteA.query(
    "INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ($1,$2,$3,$4,$5,$6)",
    [uid("d", d.n), tenA, d.file, d.type, `a-hash-${d.n}`, d.stage ?? "verified"]
  );
  for (const link of d.links ?? []) {
    await liteA.query("INSERT INTO document_entity_links (tenant_id, document_id, entity_id) VALUES ($1,$2,$3)", [tenA, uid("d", d.n), link]);
    totalLinks++;
  }
  for (const x of d.facts ?? []) {
    await liteA.query("INSERT INTO extractions (tenant_id, document_id, entity_id, field_key, value, confidence) VALUES ($1,$2,$3,$4,$5,0.9)", [tenA, uid("d", d.n), null, x.key, x.value]);
    totalFacts++;
  }
  for (const [i, text] of (d.pages ?? []).entries()) {
    await liteA.query("INSERT INTO document_pages (document_id, tenant_id, page_no, text) VALUES ($1,$2,$3,$4)", [uid("d", d.n), tenA, i + 1, text]);
  }
}
// One document_financials row (invoice #8841), so the financials-export path and financials-answering
// categories both get exercised, not just the base tables.
await liteA.query(
  `INSERT INTO document_financials (tenant_id, document_id, doc_kind, direction, currency, invoice_number, invoice_date, subtotal, tax, total, status, customer_name, confidence)
   VALUES ($1,$2,'invoice','receivable','USD','8841','2026-08-01',100.00,8.25,108.25,'unpaid',$3,0.9)`,
  [tenA, uid("d", 4), "Bill Whitmore"]
);

const seededCounts = { entities: customers.length + equipment.length, documents: docs.length, links: totalLinks, extractions: totalFacts };

/* ================================================================== the real export */
const exported = await exportTenant(ctxA);
check("export: includes document_entity_links (the fix this build made)", Array.isArray(exported.document_entity_links) && exported.document_entity_links.length === totalLinks, `${exported.document_entity_links?.length} vs ${totalLinks}`);
check("export: includes facets (present, empty here — none seeded)", Array.isArray(exported.facets));
eq("export: documents/entities counts match what was seeded", [exported.documents.length, exported.entities.length], [docs.length, seededCounts.entities]);
check("export: financials + financial_lines present (migration 22 applied)", Array.isArray(exported.financials) && exported.financials.length === 1);
check("export: no storage_key on any document row", exported.documents.every((d) => !("storage_key" in d)));
check("export: not truncated for this small tenant", exported.truncated === false);

/* ================================================================== DB B: fresh, load the export, run the exam */
const liteB = await createPGlite();
await setActiveDatabase(liteB);

const { ctx: ctxB, tenantId: tenB, counts } = await loadExportIntoNewTenant(liteB, exported, { tenantKey: "offline-verify", tenantName: "Offline Verify" });
eq("import: entity/document/link/financial counts round-trip into the fresh database", [counts.entities, counts.documents, counts.links, counts.financials], [seededCounts.entities, docs.length, totalLinks, 1]);

// Directly against DB B's own tables (not the JSON) — this is the actual regression check for the missing
// document_entity_links table: before this build's fix, the export never carried these rows at all, so a
// reloaded tenant would show 0 here no matter what the seed had.
const linkCountB = (await liteB.query("SELECT count(*)::int AS n FROM document_entity_links WHERE tenant_id = $1", [tenB])).rows[0].n;
eq("DB B: document_entity_links actually landed in the reloaded database", linkCountB, totalLinks);
const docCountB = (await liteB.query("SELECT count(*)::int AS n FROM documents WHERE tenant_id = $1", [tenB])).rows[0].n;
eq("DB B: documents actually landed in the reloaded database", docCountB, docs.length);
const finCountB = (await liteB.query("SELECT count(*)::int AS n FROM document_financials WHERE tenant_id = $1", [tenB])).rows[0].n;
eq("DB B: document_financials actually landed in the reloaded database", finCountB, 1);

/* ================================================================== the full golden exam, offline */
const { loadExam } = await import("../api/_lib/scorecard/exam.js");
const exam = loadExam();
check("exam.json is present and non-empty (test-docs/scorecard/exam.json)", exam.questions.length > 0, String(exam.questions.length));

if (exam.questions.length) {
  const today = "2026-09-25";
  const runStarted = Date.now();
  const { perQuestion, overall, byCategory } = await runOfflineExam({ ctx: ctxB, questions: exam.questions, today, modelCounter });
  const durationMs = Date.now() - runStarted;

  eq("every exam question produced exactly one result", perQuestion.length, exam.questions.length);
  check(`fast: the full ${exam.questions.length}-question offline exam finished in under 3 minutes (took ${Math.round(durationMs / 1000)}s)`, durationMs < 180_000, `${durationMs}ms`);
  check("some questions were answered entirely without a model (fast path / financials / relations / analytics all work offline)", overall.answeredWithoutModel > 0, JSON.stringify(overall));
  check("some questions genuinely need a model (the mock + counter mechanism actually engages, not a silent no-op)", overall.needsModel > 0, JSON.stringify(overall));
  check("no oracle crashed against the reloaded schema (loader produced a schema-valid, self-consistent database)", overall.oracleError === 0, JSON.stringify(perQuestion.filter((r) => r.status === "oracle-error").slice(0, 5)));
  check("overall counts add up to the total asked", overall.answeredWithoutModel + overall.needsModel + overall.skipped + overall.oracleError === overall.total, JSON.stringify(overall));
  check("byCategory buckets sum to the overall total", Object.values(byCategory).reduce((a, b) => a + b.total, 0) === overall.total);
  check("no wrong answer is reported without an expected/got pair", perQuestion.filter((r) => r.status === "wrong").every((r) => "expected" in r && "got" in r));

  // Report generation itself (used by the CLI) should not throw and should mention both required buckets.
  const md = renderMarkdownReport({ tenantKey: "org_offline_source", examVersion: exam.version, generatedAt: new Date().toISOString(), durationMs, overall, byCategory, perQuestion, counts });
  check("renderMarkdownReport produces a non-empty report mentioning needs-model and needs-grader", typeof md === "string" && md.length > 100 && /needs-model/.test(md) && /needs-grader/.test(md));

  realLog(`NOTE  offline exam: ${JSON.stringify(overall)}`);
}

/* ================================================================== static checks */
{
  const apiFiles = fs.readdirSync(path.join(ROOT, "api"), { withFileTypes: true }).filter((e) => e.isFile()).length;
  eq("api/ still has exactly 12 top-level files (Vercel Hobby function ceiling)", apiFiles, 12);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  check("package.json: verify:offline-exam runs this script", pkg.scripts["verify:offline-exam"] === "node scripts/verify-offline-exam.mjs");
  check("package.json: verify:offline-exam is wired into verify:all", /verify:offline-exam/.test(pkg.scripts["verify:all"] ?? ""));
}

console.log = realLog;
console.warn = realWarn;
console.error = realErr;
console.log("");
console.log(failures ? `${failures} check(s) FAILED.` : `${passes} checks passed.`);
process.exit(failures ? 1 : 0);
