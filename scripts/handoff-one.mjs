import { boot, loadCompany, loadExpected } from "./lib/handoff-harness.mjs";
const key = process.argv[2]; const qs = process.argv.slice(3);
const H = await boot({ v2: process.env.V2 !== "0" });
import fs from "node:fs"; import path from "node:path";
await H.addTenant(key, key === "golden" ? JSON.parse(fs.readFileSync(path.join(H.ROOT, "scripts/golden/golden-export.json"), "utf8")) : loadCompany(key));
for (const q of qs) { const r = await H.ask(key, q, key === "golden" ? "2026-09-25" : "2026-10-07"); H.realLog(JSON.stringify({ q, path: r.path, kind: r.kind, mc: r.modelCalls, lane: r.lane, det: r.detail, text: r.text.slice(0, 300), logs: r.logs.map((l) => JSON.stringify(l).slice(0, 400)) }, null, 1)); }
process.exit(0);
