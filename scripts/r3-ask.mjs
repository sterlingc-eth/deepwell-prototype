#!/usr/bin/env node
// Ask Donovan questions offline against organization A (golden export) or B (renamed copy). Usage: ORG=A node scripts/r3-ask.mjs questions.txt   (one question per line) ; prints "Q => [kind] text | cards | chips (model calls)"
import fs from "node:fs";
const off = await import("./offline-exam.mjs");
const realLog = console.log; console.log = (...a) => { if (typeof a[0] === "string" && /^\{"(route|event|claimCheck)/.test(a[0])) return; realLog(...a); }; console.warn = () => {}; console.error = () => {};
await off.installPgHarness(); await off.installModelBlock();
const { makeOrgs } = await import("./lib/r3-harness.mjs");
const h = await makeOrgs(off);
const org = process.env.ORG || "A";
if (process.env.LIST) { realLog(h.orgs[org].customers.join("\n")); process.exit(0); }
for (const q of fs.readFileSync(process.argv[2], "utf8").split("\n").map((x) => x.trim()).filter(Boolean)) {
  const r = await h.ask(org, q);
  realLog(`${q}\n   => [${r.kind}] ${r.text.slice(0, 400)}${r.facts.length ? ` | ${r.facts.slice(0, 4).map((f) => `${f.label}=${f.value}`).join("; ")}` : ""}${r.chips.length ? ` | chips: ${r.chips.join(" / ")}` : ""} (model calls ${r.calls})`);
}
process.exit(0);
