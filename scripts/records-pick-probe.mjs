#!/usr/bin/env node
/**
 * RECORDS-R3C probe (for reviewers): ask the real /api/ask handler questions against the records fixture (organization A or B) with the menu pick ON and a SCRIPTED model.
 *   node scripts/records-pick-probe.mjs --fixture            prints the fixture truth (customers, documents, stored facts) so you can judge answers
 *   node scripts/records-pick-probe.mjs cases.json [out.json]   cases = [{ "org": "A", "q": "question", "pick": {..menu_pick input..} | null, "off": false }]
 * "pick" is what the scripted model returns for the menu_pick call (omit or null = the model returns nothing usable). "off": true runs with DONOVAN_MENU_PICK unset.
 * Any other model call gets an always-lying answer (Zebediah Crane / $3,407.00); if that text shows up in an answer, it is a bug.
 */
import fs from "node:fs";
const off = await import("./offline-exam.mjs");
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === "string" && (a[0].startsWith('{"route"') || a[0].startsWith('{"event"') || a[0].startsWith('{"claimCheck') || a[0].startsWith('{"level"') || a[0].startsWith('{"cost_usd"') || a[0].startsWith('{"route":"menu-pick"'))) return; realLog(...a); };
console.warn = () => {}; console.error = () => {};
await off.installPgHarness(); await off.installModelBlock();
const { makeRecordsOrgs, LIE } = await import("./lib/records-harness.mjs");
const T = await import("./lib/records-truth.mjs");
const PC = await import("../api/_lib/records/pickCall.js");
const h = await makeRecordsOrgs(off);
if (process.argv[2] === "--fixture") {
  for (const org of ["A", "B"]) {
    const ix = T.index(h.orgs[org].data); realLog(`\n##### ORGANIZATION ${org}`);
    for (const c of ix.customers) {
      realLog(`CUSTOMER ${c.data.customer_name} | ${c.data.service_address ?? ""} | ${c.data.phone ?? ""}`);
      for (const id of T.customerDocs(ix, c.id)) { const d = ix.docs.get(id); const f = ix.fin.get(id);
        realLog(`  ${d.document_type} ${f?.invoice_number ?? ""} ${T.docDate(ix, id)} :: ` + T.DOC_FACTS.map((k) => { const v = T.docFactValues(ix, id, k); return v?.length ? `${k}=${v.join("|").slice(0, 70)}` : null; }).filter(Boolean).join(" ; ")); }
    }
  }
  process.exit(0);
}
const cases = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const results = [];
for (const c of cases) {
  const org = c.org ?? "A"; let picks = 0, others = 0;
  if (c.off) delete process.env.DONOVAN_MENU_PICK; else process.env.DONOVAN_MENU_PICK = "1";
  PC.clearPickCache();
  const r = await h.ask(org, c.q, (text, req) => { if (req.tools?.some((t) => t.name === "menu_pick")) { picks++; return c.pick ?? "no usable pick"; } others++; return LIE; });
  const row = { org, q: c.q, kind: r.kind, pickCalls: picks, otherModelCalls: others, text: r.text.slice(0, 700), laneDetail: r.debug?.laneDetail ?? null };
  results.push(row);
  realLog(`[${org}] ${c.off ? "(switch off) " : ""}${c.q}\n   -> ${row.kind} pickCalls=${picks} otherModelCalls=${others} lane=${row.laneDetail}\n   ${row.text}`);
}
if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(results, null, 2));
process.exit(0);
