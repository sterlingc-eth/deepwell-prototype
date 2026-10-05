#!/usr/bin/env node
/** Permanent regression test from the 2026-10-03 Donovan limit test. Asks the frozen blind set (180 q) and break-it set (162 q) through the real
 *  /api/ask handler (model blocked) and asserts every question whose baseline is "pass" still passes; other questions are logged defects (not asserted).
 *  TZ=America/Phoenix EXAM_TODAY=2026-09-25 node scripts/verify-lt-donovan.mjs */
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawnSync } from "node:child_process"; import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOF = /not on file|no .{0,50} on file|couldn'?t find|could not find|no record|no match|nothing|isn'?t on file|don'?t have|not found|no such|unable|can'?t (?:help|share|provide|answer|do)|not something|not in your|outside|only (?:answer|help)|no documents|0 |zero|none|isn'?t a question|future|doesn'?t exist|not a valid|invalid|impossible|read-only|not able|no warranty|no permit|no maintenance|no invoice|no purchase/i;
const norm = (s) => String(s ?? "").toLowerCase().replace(/[–—]/g, "-");
let fails = 0, passes = 0, logged = 0;
for (const file of fs.readdirSync(path.join(ROOT, "test-docs/scorecard/blind")).filter((f) => /^lt-.*\.json$/.test(f) && !/^lt-loop/.test(f)).sort()) {
  const set = JSON.parse(fs.readFileSync(path.join(ROOT, "test-docs/scorecard/blind", file), "utf8"));
  const tmp = path.join(os.tmpdir(), `lt-${process.pid}-${file}`);
  const r = spawnSync("node", [path.join(ROOT, "scripts/lt-run.mjs"), path.join(ROOT, "test-docs/scorecard/blind", file), tmp], { env: { ...process.env, TZ: "America/Phoenix", EXAM_TODAY: "2026-09-25" }, encoding: "utf8" });
  if (r.status !== 0) { console.log("FAIL runner", file, r.stderr?.slice(0, 300)); process.exit(1); }
  const res = JSON.parse(fs.readFileSync(tmp, "utf8"));
  const leak = set.leak ? new RegExp(set.leak, "i") : null;
  for (const q of set.questions) {
    const x = res.find((y) => y.id === q.id); const d = x?.data; const ex = q.expect ?? {};
    if (q.baseline !== "pass") { logged++; continue; }
    let ok = true; let why = "";
    if (ex.empty || ex.tooLong) ok = x.status === 400;
    else if (!d || x.needsModel) { ok = false; why = "no answer"; }
    else {
      const text = [d.text, ...(d.facts ?? []).map((f) => `${f.label}: ${f.value}`), d.basis ?? ""].join(" \n ");
      const T = norm(text), D = text.replace(/\D/g, "");
      const clar = !!d.clarify || (d.didYouMean ?? []).length > 0;
      if (leak && leak.test(text)) { ok = false; why = "leak"; }
      let factsOk = true;
      for (const g of ex.all ?? []) if (!g.some((a) => T.includes(norm(a)))) factsOk = false;
      for (const g of ex.digits ?? []) if (!D.includes(g)) factsOk = false;
      if (!factsOk && !(clar && ex.orClarify) && !(ex.orHonest && NOF.test(text))) { ok = false; why += " facts"; }
      for (const b of ex.none ?? []) if (T.includes(norm(b))) { ok = false; why += " forbidden:" + b; }
      if (ex.notOnFile && !NOF.test(text) && !(clar && ex.orClarify)) { ok = false; why += " not-on-file"; }
    }
    if (ok) passes++; else { fails++; console.log(`FAIL ${q.id} | ${q.text.slice(0, 80)} ${why}`); }
  }
  fs.rmSync(tmp, { force: true });
}
console.log(`lt-donovan: ${passes} asserted pass, ${fails} fail, ${logged} logged defects/gaps not asserted`);
process.exit(fails ? 1 : 0);
