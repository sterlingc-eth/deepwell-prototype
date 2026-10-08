// R3 harness: two organizations (A = the golden export, B = the same shape with every customer renamed to names that share no word with A's) and a model stub that always returns a WRONG answer.
import * as F from "./r40-fixture.mjs";
import { installScriptedModel } from "./r40-model-stub.mjs";
const FIRST = ["Orson", "Perdita", "Lucian", "Marguerite", "Osric", "Thessaly", "Caspian", "Isolde", "Barnaby", "Ottoline", "Percival", "Rosalind", "Tobias", "Wilhelmina", "Fitzroy", "Annika", "Leopold", "Cordelia", "Ignatius", "Philippa"];
const LAST = ["Vexley", "Thornquist", "Ravenscroft", "Delacourt", "Pennywhistle", "Blackwood", "Fairweather", "Gallowglass", "Hollingsworth", "Ironside", "Jessamine", "Kingsley", "Lockhart", "Moonstone", "Nightingale", "Oakhurst", "Quillfeather", "Rosewater", "Silverthorne", "Underhill", "Wetherby", "Yarrowby", "Zephyrine", "Ashcombe", "Bellweather", "Crestwood", "Dunmore", "Elderflower", "Foxglove", "Greystone"];
export const WRONG = { kind: "answer", text: "Zebediah Crane owes $3,407.00.", facts: [{ label: "Customer", value: "Zebediah Crane", sources: [] }, { label: "Total", value: "$3,407.00", sources: [] }], sources: [], confidence: 0.9 };
export function renamed(d) {
  const aTok = new Set(d.entities.filter((e) => e.entity_type === "customer").flatMap((e) => e.data.customer_name.toLowerCase().split(/\s+/)));
  const FI = FIRST.filter((x) => !aTok.has(x.toLowerCase())), LA = LAST.filter((x) => !aTok.has(x.toLowerCase()));
  const names = d.entities.filter((e) => e.entity_type === "customer").map((e) => e.data.customer_name);
  let s = JSON.stringify(d); const map = {};
  names.forEach((n, i) => { const nn = n.split(/\s+/).length === 2 ? `${FI[i % FI.length]} ${LA[i % LA.length]}${i >= LA.length ? "x".repeat(Math.floor(i / LA.length)) : ""}` : `${LA[i % LA.length]} Holdings ${i}`; map[n] = nn; });
  for (const [n, nn] of Object.entries(map).sort((a, b) => b[0].length - a[0].length)) s = s.split(n).join(nn);
  const o = JSON.parse(s); o.tenantKey = "r3-orgB"; o.tenantName = "r3-orgB"; return { data: o, map };
}
export async function makeOrgs(off) {
  const stub = await installScriptedModel();
  const prev = process.env.ASK_HELPGATE_IN_SCORECARD; process.env.ASK_HELPGATE_IN_SCORECARD = "1";
  const { askViaHandler } = await import("../../api/_lib/scorecard/askCall.js");
  const { default: askHandler } = await import("../../api/ask.js");
  const dA = F.loadGolden(); dA.tenantKey = "r3-orgA"; dA.tenantName = "r3-orgA";
  const { data: dB, map } = renamed(F.loadGolden());
  const orgs = {};
  for (const [k, d] of [["A", dA], ["B", dB]]) {
    const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
    const ctx = (await off.loadExportIntoNewTenant(lite, d, { tenantKey: `offline:r3-org${k}`, tenantName: `r3-org${k}` })).ctx;
    orgs[k] = { lite, ctx, key: `r3-org${k}`, customers: d.entities.filter((e) => e.entity_type === "customer").map((e) => e.data.customer_name) };
  }
  const ask = async (org, question, fn = () => WRONG) => {
    const o = orgs[org]; await off.setActiveDatabase(o.lite); stub.fn = fn; stub.calls = 0;
    const r = await askViaHandler({ handler: askHandler, auth: { tenantId: o.ctx.tenantKey, orgId: o.key, userId: null }, question, today: "2026-10-07" });
    const facts = r.data?.facts ?? [];
    return { kind: r.data?.kind, text: String(r.data?.text ?? ""), calls: stub.calls, facts, chips: (r.data?.didYouMean ?? []).map((c) => c.text), shown: `${r.data?.text ?? ""}\n${facts.map((f) => `${f.label} ${f.value}`).join("\n")}\n${(r.data?.didYouMean ?? []).map((c) => c.text).join("\n")}\n${r.data?.interpretation ?? ""}` };
  };
  return { ask, orgs, map, restore: () => { if (prev === undefined) delete process.env.ASK_HELPGATE_IN_SCORECARD; else process.env.ASK_HELPGATE_IN_SCORECARD = prev; } };
}
