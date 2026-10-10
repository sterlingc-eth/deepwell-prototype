// R42 tenantCount verify: runs the plumbing blind set and requires the multi-condition count shapes to be correct.
// usage: TZ=America/Phoenix EXAM_TODAY=2026-09-25 node scripts/verify-r42-count.mjs   (generate tenants first: node scripts/gen-plumbing-tenant.mjs)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
const out = "/tmp/verify-r42-count.json";
spawnSync("node", ["scripts/run-tenant-exam.mjs", "test-docs/tenants/plumbing/export.json", "test-docs/scorecard/blind/plumb-2026-10-09.json", "plumbing", "--json", out], { stdio: "ignore" });
const bank = JSON.parse(fs.readFileSync("test-docs/scorecard/blind/plumb-2026-10-09.json", "utf8")).questions;
const res = new Map(JSON.parse(fs.readFileSync(out, "utf8")).map((r) => [r.id, r]));
const SHAPES = /brand_city|gal_brand|type_install|tech_invoices|problem_city|problem_year|backflow_year|backflow_fail|drop_brand_year|drop_tech_year|drop_brand_city/;
let bad = 0, n = 0;
for (const q of bank) {
  if (!SHAPES.test(q.shape)) continue;
  n++;
  const r = res.get(q.id);
  if (r?.status !== "correct") { bad++; console.log(r?.status, q.text); }
}
console.log(`${n - bad}/${n} count-shape questions correct`);
process.exit(bad > 0 ? 1 : 0);
