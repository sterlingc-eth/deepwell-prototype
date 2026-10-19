// node scripts/handoff-run.mjs [--out file.jsonl] [--companies a,b,c] [--v2 0|1] [--per N]
import fs from "node:fs";
import { boot, loadCompany, loadExpected } from "./lib/handoff-harness.mjs";
import { generate, judge } from "./lib/handoff-questions.mjs";
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
const companies = arg("companies", "pg_re0_title,pn_re1_commercial,pf_ot0_upholstery,pg_ot2_weightloss").split(",");
const out = arg("out", "/home/claude/work/handoff_run.jsonl"); const perV2 = Number(arg("per", 120));
const H = await boot({ v2: arg("v2", "1") !== "0", release: arg("release", "1") !== "0" });
const expected = loadExpected(); const rows = [];
let seed = 7;
for (const key of companies) {
  const d = loadCompany(key); await H.addTenant(key, d);
  const qs = generate(d, { seed: seed++ });
  const ref = expected.filter((e) => e.key === key && e.a === 1); const step = Math.max(1, Math.floor(ref.length / perV2));
  for (let i = 0; i < ref.length && qs.length < 900; i += step) if (qs.filter((q) => q.cat === "v2ref").length < perV2) qs.push({ cat: "v2ref", q: ref[i].q, gold: { has: true, needles: [], refText: ref[i].t, docs: ref[i].d } });
  for (const q of qs) {
    const r = await H.ask(key, q.q);
    const right = q.gold.has ? (q.cat === "v2ref" ? null : judge(q.gold, r.text)) : null;
    rows.push({ key, cat: q.cat, q: q.q, gold: q.gold.has, path: r.path, kind: r.kind, mc: r.modelCalls, lane: r.lane, det: r.detail, rel: r.release, unfit: r.unfit, v2: r.v2 ? { m: r.v2.mode, a: r.v2.v2?.answered, r: r.v2.v2?.reason, sk: r.v2.skipped, er: r.v2.error } : null, right, text: r.text.slice(0, 200), err: r.err });
  }
  H.realLog(key, "done", rows.length);
}
fs.writeFileSync(out, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
const c = {}; for (const r of rows) { const k = `${r.gold ? "answerable" : "absent"}|${r.path}`; c[k] = (c[k] ?? 0) + 1; }
H.realLog(JSON.stringify({ total: rows.length, ...c }, null, 1));
process.exit(0);
