#!/usr/bin/env node
/** Scores a limit-test question set (default: the 180 new blind questions) into pass / wrong-or-incomplete / chips / needs-model / review, per section.
 *  TZ=America/Phoenix EXAM_TODAY=2026-09-25 node scripts/score-lt-donovan.mjs [set.json] [--json out.json] [--list]
 *  "pass" = every expected fact present (or an honest not-on-file where one is expected) and no forbidden text. "review" = the question has no fixed answer (graded by a human). */
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawnSync } from "node:child_process"; import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const jsonIdx = args.indexOf("--json"); const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : null;
const list = args.includes("--list");
const file = args.find((a, i) => !a.startsWith("--") && (jsonIdx < 0 || i !== jsonIdx + 1)) ?? path.join(ROOT, "test-docs/scorecard/blind/lt-donovan-2026-10-03.json");
const NOF = /not on file|no .{0,50} on file|couldn'?t find|could not find|no record|no match|nothing|isn'?t on file|don'?t have|not found|no such|unable|can'?t (?:help|share|provide|answer|do)|not something|not in your|outside|only (?:answer|help)|no documents|0 |zero|none|isn'?t a question|future|doesn'?t exist|not a valid|invalid|impossible|read-only|not able|no warranty|no permit|no maintenance|no invoice|no purchase/i;
const norm = (s) => String(s ?? "").toLowerCase().replace(/[–—]/g, "-");
const set = JSON.parse(fs.readFileSync(file, "utf8"));
const tmp = path.join(os.tmpdir(), `score-${process.pid}.json`);
const r = spawnSync("node", [path.join(ROOT, "scripts/lt-run.mjs"), file, tmp], { env: { ...process.env, TZ: "America/Phoenix", EXAM_TODAY: "2026-09-25" }, encoding: "utf8" });
if (r.status !== 0) { console.log("runner failed", r.stderr?.slice(0, 300)); process.exit(1); }
const res = JSON.parse(fs.readFileSync(tmp, "utf8")); fs.rmSync(tmp, { force: true });
const rows = [];
for (const q of set.questions) {
  const x = res.find((y) => y.id === q.id); const d = x?.data; const ex = q.expect ?? {};
  let cat;
  if (ex.empty || ex.tooLong) cat = x.status === 400 ? "pass" : "wrong";
  else if (!d || x.needsModel) cat = "needs-model";
  else {
    const text = [d.text, ...(d.facts ?? []).map((f) => `${f.label}: ${f.value}`), d.basis ?? ""].join(" \n ");
    const T = norm(text), D = text.replace(/\D/g, "");
    const chips = !!d.clarify || (d.didYouMean ?? []).length > 0;
    let ok = true;
    for (const g of ex.all ?? []) if (!g.some((a) => T.includes(norm(a)))) ok = false;
    for (const g of ex.digits ?? []) if (!D.includes(g)) ok = false;
    if (ex.notOnFile && !NOF.test(text)) ok = false;
    const forbidden = (ex.none ?? []).some((b) => T.includes(norm(b)));
    if (forbidden) cat = "wrong";
    else if (chips) cat = "chips"; // tap-one choices are never a pass, even when their basis line happens to say "nothing matched"
    else if (ex.review) cat = "review";
    else if (ok) cat = "pass";
    else cat = "wrong";
  }
  rows.push({ id: q.id, section: q.section, text: q.text, cat, baseline: q.baseline, answer: d ? String(d.text).slice(0, 220) : "", chips: !!d?.clarify });
}
const secs = [...new Set(rows.map((x) => x.section))];
const tot = {};
for (const s of secs) { const c = {}; for (const x of rows.filter((y) => y.section === s)) c[x.cat] = (c[x.cat] ?? 0) + 1; console.log(`${s.padEnd(3)} pass ${c.pass ?? 0} | wrong ${c.wrong ?? 0} | chips ${c.chips ?? 0} | needs-model ${c["needs-model"] ?? 0} | review ${c.review ?? 0}`); for (const k in c) tot[k] = (tot[k] ?? 0) + c[k]; }
console.log(`TOTAL ${rows.length} | pass ${tot.pass ?? 0} | wrong-or-incomplete ${tot.wrong ?? 0} | chips ${tot.chips ?? 0} | needs-model ${tot["needs-model"] ?? 0} | review ${tot.review ?? 0}`);
if (list) for (const x of rows) if (x.cat !== "pass") console.log(`${x.cat.padEnd(11)} ${x.id} | ${x.text.slice(0, 70)} => ${x.answer.slice(0, 120)}`);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(rows, null, 1));
process.exit(0);
