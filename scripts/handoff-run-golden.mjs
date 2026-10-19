// golden HVAC tenant + the question bank (test-docs/question-bank/bank.json, gold = expect.answerValue). node scripts/handoff-run-golden.mjs [--step 8] [--out f]
import fs from "node:fs";
import path from "node:path";
import { boot } from "./lib/handoff-harness.mjs";
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
const H = await boot({ v2: arg("v2", "1") !== "0", release: arg("release", "1") !== "0" });
const ROOT = H.ROOT; const d = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/golden/golden-export.json"), "utf8"));
await H.addTenant("golden", d);
const bank = JSON.parse(fs.readFileSync(path.join(ROOT, "test-docs/question-bank/bank.json"), "utf8"));
const step = Number(arg("step", 8)); const off = Number(arg("offset", 0)); const rows = [];
for (let i = off; i < bank.length; i += step) {
  const b = bank[i]; const r = await H.ask("golden", b.text, "2026-09-25");
  rows.push({ key: "golden", id: b.id, cat: b.category, variant: b.variant, q: b.text, gold: b.expect.answerValue != null, route: b.expect.route, path: r.path, kind: r.kind, mc: r.modelCalls, lane: r.lane, det: r.detail, rel: r.release, unfit: r.unfit, v2: r.v2 ? { m: r.v2.mode, a: r.v2.v2?.answered, r: r.v2.v2?.reason, sk: r.v2.skipped, er: r.v2.error } : null, text: r.text.slice(0, 200), err: r.err });
}
fs.writeFileSync(arg("out", "/home/claude/work/handoff_golden.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
const c = {}; for (const r of rows) { const k = `${r.gold ? "gold" : "nogold"}|${r.path}`; c[k] = (c[k] ?? 0) + 1; }
H.realLog(JSON.stringify({ total: rows.length, ...c }, null, 1));
process.exit(0);
