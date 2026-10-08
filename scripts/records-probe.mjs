// usage: node scripts/records-probe.mjs "question 1" "question 2" ...   (org A; prints kind/calls/text)
const off = await import("./offline-exam.mjs");
const realLog = console.log;
let lastSkips = [];
console.log = (...a) => { if (typeof a[0] === "string" && a[0].startsWith('{"route"')) { if (/records_skip|records_first|"lane"|rule|route":"ask","[a-z_]+/.test(a[0]) && process.env.SKIPS) lastSkips.push(a[0].slice(0, 160)); return; } if (typeof a[0] === "string" && (a[0].startsWith('{"route"') || a[0].startsWith('{"event"') || a[0].startsWith('{"claimCheck'))) return; realLog(...a); };
console.warn = () => {}; console.error = () => {};
await off.installPgHarness(); await off.installModelBlock();
const { makeRecordsOrgs } = await import("./lib/records-harness.mjs");
const h = await makeRecordsOrgs(off);
const org = process.env.ORG || "A";
for (const q of process.argv.slice(2)) {
  lastSkips = [];
  const r = await h.ask(org, q);
  realLog(`Q: ${q}\n  [${r.kind}] calls=${r.calls} lane=${r.debug?.lane ?? "-"}/${r.debug?.laneDetail ?? "-"} ${r.text.slice(0, 400).replace(/\n/g, " | ")}${process.env.SKIPS ? "\n    " + lastSkips.join("\n    ") : ""}`);
}
process.exit(0);
