import fs from "node:fs";
const off = await import("./offline-exam.mjs");
const realLog = console.log; console.log = (...a) => { if (typeof a[0] === "string" && (a[0].startsWith('{"route"') || a[0].startsWith('{"event"'))) return; realLog(...a); };
console.warn = () => {}; if (!process.env.R40_DEBUG) console.error = () => {};
await off.installPgHarness(); const modelCounter = await off.installModelBlock();
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const { askViaHandler } = await import("../api/_lib/scorecard/askCall.js");
const { default: askHandler } = await import("../api/ask.js");
const { installScriptedModel, parsePassages } = await import("./lib/r40-model-stub.mjs");
const stub = await installScriptedModel();
const { liveFixture } = await import("./lib/r40-fixture.mjs");
const ctx = (await off.loadExportIntoNewTenant(lite, liveFixture(), { tenantKey: "offline:r40-live", tenantName: "r40-live" })).ctx;
const auth = { tenantId: ctx.tenantKey, orgId: ctx.tenantName, userId: null };
stub.fn = (prompt) => {
  const ps = parsePassages(prompt); realLog("PROMPT docs:", (prompt.match(/documentId:/g)||[]).length, "T226 in prompt:", /INV-T226/.test(prompt)); realLog("PASSAGES:", ps.map((p) => `${p.file}#${p.page}`).join(", "));
  const t = ps.find((p) => /INV-T226/.test(p.text)) ?? ps[0];
  return { text: "The $3,470.00 invoice is for Ronald Calloway at 3300 S Alma School Rd, Apt 103, Mesa, AZ 85201 — it's invoice INV-T226 dated September 5, 2026, for a seasonal maintenance check on a Lennox condenser (serial LX100030).", confidence: 0.95,
    facts: [{ label: "Cost", value: "$3,470.00", status: "info", sources: [{ documentId: t.documentId, location: { page: t.page } }] }, { label: "Service Date", value: "September 5, 2026", sources: [{ documentId: t.documentId, location: { page: t.page } }] }] };
};
for (const q of process.argv.slice(2)) {
  modelCounter.n = 0;
  const r = await askViaHandler({ handler: askHandler, auth, question: q, today: "2026-10-07" });
  realLog("Q:", q, "\nmodelCalls:", modelCounter.n, "err:", r.error); realLog(JSON.stringify(r.data, null, 1)?.slice(0, 5000)); realLog("DEBUG", JSON.stringify(r.debug)?.slice(0, 800));
}
