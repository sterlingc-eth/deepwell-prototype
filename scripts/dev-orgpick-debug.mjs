// dev helper: node scripts/dev-orgpick-debug.mjs <export.json> "question" ... ; prints the stub pick, bind result and the lane result for each question (model is a scripted stand-in)
import fs from "node:fs";
process.env.DONOVAN_MENU_PICK = "1";
const off = await import("./offline-exam.mjs");
const rl = console.log; console.log = () => {}; console.warn = () => {}; console.error = process.env.ORGPICK_DEBUG ? console.error : () => {};
await off.installPgHarness(); await off.installModelBlock();
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const ctx = (await off.loadExportIntoNewTenant(lite, data, { tenantKey: "offline:dbg", tenantName: "dbg" })).ctx;
const { withTenant } = await import("../api/_lib/recordsStore.js");
const OM = await import("../api/_lib/records/orgMenu.js"); const OC = await import("../api/_lib/records/orgPickCall.js"); const lane = await import("../api/_lib/records/lane.js");
const stubs = await import("./lib/orgpick-stubs.mjs");
const names = new Set(); for (const e of data.entities ?? []) if (e.data?.customer_name) names.add(e.data.customer_name); for (const f of data.financials ?? []) { if (f.vendor_name) names.add(f.vendor_name); }
for (const pg of data.pages ?? []) for (const l of OM.pageLabelLines(pg.text)) if (OM.valueKind(l.value) === "name") names.add(l.value);
OC.setOrgPickTransport(process.env.LIAR ? stubs.liar(process.env.LIAR) : stubs.correctStub({ names: [...names] }));
for (const q of process.argv.slice(3)) {
  const got = await OC.requestOrgPick({ withTenant, ctxArg: ctx, question: q });
  let out = { q, pick: got ? { facts: got.pick.facts, subject: got.pick.subject, order: got.pick.order, scope: got.pick.scope } : null };
  if (got) { const r = await withTenant(ctx, (db) => lane.runOrgPicked(db, q, { pick: got.pick, inv: got.inv, today: "2026-10-07" })); out.result = r?.data ? r.data.text.slice(0, 300) : r; }
  rl(JSON.stringify(out));
}
if (process.env.MENU) { const inv = await withTenant(ctx, (db) => OM.loadInventory(db)); rl(OM.menuLines(OM.buildMenu(inv))); rl([...inv.subjects.values()].map((s) => `${s.kind}:${s.name}:${s.docIds.size}`).join("\n")); }
process.exit(0);
