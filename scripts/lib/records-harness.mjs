// RECORDS-R1 harness: organization A (main fixture) and organization B (second tenant) in two PGlite databases, real /api/ask handler, model replaced by a stub that always lies.
import { buildRecordsFixture } from "./records-fixture.mjs";
import { installScriptedModel } from "./r40-model-stub.mjs";
export const LIE = { kind: "answer", text: "Zebediah Crane owes $3,407.00.", facts: [{ label: "Customer", value: "Zebediah Crane", sources: [] }, { label: "Total", value: "$3,407.00", sources: [] }], sources: [], confidence: 1 };
export async function makeRecordsOrgs(off, { extraCustomers = 14, today = "2026-10-07" } = {}) {
  const stub = await installScriptedModel();
  const { askViaHandler } = await import("../../api/_lib/scorecard/askCall.js");
  const { default: askHandler } = await import("../../api/ask.js");
  const orgs = {};
  for (const v of ["A", "B"]) {
    const fx = buildRecordsFixture({ variant: v, extraCustomers });
    const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
    const ctx = (await off.loadExportIntoNewTenant(lite, fx.export, { tenantKey: `offline:records-${v}`, tenantName: `records-${v}` })).ctx;
    orgs[v] = { lite, ctx, key: `records-${v}`, fx, truth: fx.truth, data: fx.export };
  }
  const ask = async (org, question, fn = () => LIE) => {
    const o = orgs[org]; await off.setActiveDatabase(o.lite); stub.fn = fn; stub.calls = 0;
    const r = await askViaHandler({ handler: askHandler, auth: { tenantId: o.ctx.tenantKey, orgId: o.key, userId: null }, question, today });
    const facts = r.data?.facts ?? [];
    return { kind: r.data?.kind, text: String(r.data?.text ?? ""), calls: stub.calls, facts, data: r.data, debug: r.debug, error: r.error, chips: (r.data?.didYouMean ?? []).map((c) => c.text),
      shown: `${r.data?.text ?? ""}\n${facts.map((f) => `${f.label ?? ""} ${f.value ?? ""}`).join("\n")}` };
  };
  return { ask, orgs };
}
