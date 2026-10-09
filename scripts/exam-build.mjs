#!/usr/bin/env node
/**
 * R5 SEALED EXAM TOOLING. Builds a dev/sealed question exam for ONE organization from (1) that organization's export file and (2) a log of real questions,
 * computes TRUTH from the raw export rows (never from Donovan), scores answers files, and diffs two answers files. No database, no model, no network.
 *
 *   node scripts/exam-build.mjs build  --export <export.json> --log <questions.jsonl|.json|.txt> [--org <name>] [--out exam-out/<org>] [--seed <s>] [--no-variants]
 *   node scripts/exam-run-offline.mjs  --export <export.json> --out exam-out/<org> --answers exam-out/<org>/answers-base.json     (asks every question through the real handler, model blocked)
 *   node scripts/exam-build.mjs score  --export <export.json> --out exam-out/<org> --answers <answers.json> [--json report.json]
 *   node scripts/exam-build.mjs diff   --export <export.json> --out exam-out/<org> --a <before.json> --b <after.json>
 *   node scripts/exam-build.mjs self-test
 *
 * LOG FILE: JSON lines ({"question": "...", "asked_at": "...", "org": "..."}), a JSON array of such objects, or one question per line. With --org, rows
 *   that carry an org id different from --org are skipped. Duplicates (same normalised text) are dropped.
 * EXPORT FILE: same shape as scripts/golden/golden-export.json (documents, pages, extractions, financials, financial_lines, entities, document_entity_links).
 * ANSWERS FILE: JSON list of {question, answer_text, facts?:[{label,value}]} from any runner.
 *
 * SPLIT: sha256(seed | canonical question) -> [0,1). < 0.60 = DEV, else SEALED (40%). The canonical key drops punctuation, possessives, contractions, wrappers
 *   ("pls", "can you tell me ... please") and sorts the words, so re-wordings of a question land on the same side. Paraphrase variants are generated AFTER the
 *   split and inherit their source's side. SEALED questions go only to <out>/sealed.json (keep it out of git and out of prompts); reports show sealed COUNTS only.
 *
 * TRUTH: a small reader over the raw rows resolves the subject (document number, customer / vendor / employee full name by exact normalised match, a unique
 *   line-item description) and a fact class (phone, email, address, due date, paid status, total, labor charge, technician, work performed, hours, contract end,
 *   fee, hire date, ...), giving the acceptable value strings, or 'unanswerable-from-rows' (expected: an honest "not on file"). Anything it cannot classify is
 *   'unclassified': counted, never scored.
 *
 * SCORES: right (an acceptable value appears, no other record's value does) / honest (says not on file) / broad ("everything on file" dump) / decline / wrong.
 *
 * EXPORTING QUESTIONS (OWNER ONLY, READ-ONLY, NEVER RUN BY THIS TOOL): ask_misses (M3-config/23-ask-misses.sql) holds only the asks that ended honestly
 *   (no answer / fallback), question text truncated to 300 chars; the answered asks are not stored there, so combine it with questions staff remember. In psql,
 *   connected as the organization's own role so row-level security limits it to that organization:
 *     BEGIN READ ONLY;
 *     SELECT json_build_object('question', question, 'asked_at', created_at) FROM ask_misses
 *      WHERE created_at >= now() - interval '90 days' ORDER BY created_at;   -- \t on, \a on, output to questions.jsonl
 *     COMMIT;
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sideOf, parseLog, paraphrases, normQ, canonKey } from "./lib/exam-text.mjs";
import { buildIndex, truthFor } from "./lib/exam-truth.mjs";
import { classify, aggregate, renderReport, CLASSES } from "./lib/exam-score.mjs";

export const DEFAULT_SEED = "deepwell-exam-r5";
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const arg = (a, k, d = null) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);

/** pure: questions -> {dev:[items], sealed:[items]} */
export function buildExam({ exportData, questions, seed = DEFAULT_SEED, variants = true }) {
  const ix = buildIndex(exportData); const out = { dev: [], sealed: [] }; const seenCanon = new Map();
  let n = 0;
  for (const q of questions) {
    const side = sideOf(seed, q.question); const key = canonKey(q.question);
    if (seenCanon.has(key)) continue; seenCanon.set(key, true); // re-wordings that are already in the log collapse into the first one
    const truth = truthFor(ix, q.question);
    out[side].push({ id: `${side[0]}${String(++n).padStart(4, "0")}`, question: q.question, asked_at: q.asked_at ?? null, variants: variants ? paraphrases(q.question, seed).map((v) => ({ question: v.text, kind: v.kind })) : [], truth });
  }
  return out;
}
const kinds = (items) => { const c = { answerable: 0, unanswerable: 0, unclassified: 0 }; for (const i of items) c[i.truth.kind]++; return c; };

/** score answers; returns {agg, devDetail, rows} */
export function scoreAnswers({ dev, sealed, answers }) {
  const lookup = new Map(); // normalised question -> {side, isVariant, truth, source}
  for (const [side, items] of [["dev", dev], ["sealed", sealed]]) for (const it of items) {
    lookup.set(normQ(it.question), { side, isVariant: false, it, q: it.question });
    for (const v of it.variants ?? []) { const k = normQ(v.question); if (!lookup.has(k)) lookup.set(k, { side, isVariant: true, it, q: v.question }); }
  }
  const byQ = new Map(); for (const a of answers) byQ.set(normQ(a.question), a);
  const rows = [];
  for (const [k, meta] of lookup) {
    const a = byQ.get(k); const base = { side: meta.side, isVariant: meta.isVariant, fact: meta.it.truth.fact };
    if (!a) { rows.push({ ...base, missing: true, cls: null }); continue; }
    const cls = classify(meta.it.truth, a); rows.push({ ...base, cls, question: meta.q, answer: a.answer_text ?? a.text ?? "", missing: false });
  }
  const agg = aggregate(rows);
  const devDetail = rows.filter((r) => r.side === "dev" && !r.missing && r.cls).map((r) => ({ question: r.question, cls: r.cls, answer: r.answer }));
  return { agg, devDetail, rows };
}
export function diffAnswers({ dev, sealed, a, b }) {
  const A = scoreAnswers({ dev, sealed, answers: a }), B = scoreAnswers({ dev, sealed, answers: b });
  const idx = (r) => r; const trans = { dev: {}, sealed: {} }; const detail = [];
  // rows are produced in the same lookup order for both runs
  A.rows.forEach((ra, i) => { const rb = B.rows[i]; if (ra.missing || rb.missing || !ra.cls || !rb.cls || ra.cls === rb.cls) return; const k = `${ra.cls}->${rb.cls}`; trans[ra.side][k] = (trans[ra.side][k] ?? 0) + 1; if (ra.side === "dev") detail.push({ question: ra.question, from: ra.cls, to: rb.cls }); });
  return { A: A.agg, B: B.agg, trans, detail };
}
export function renderDiff(d, max = 25) {
  const L = [renderReport({ title: "BEFORE (a)", agg: d.A }), "", renderReport({ title: "AFTER (b)", agg: d.B }), "", "Class changes (a -> b):"];
  for (const s of ["dev", "sealed"]) L.push(`  ${s}: ` + (Object.entries(d.trans[s]).map(([k, v]) => `${k} x${v}`).join(", ") || "none") + (s === "sealed" ? "  (counts only)" : ""));
  const rank = { right: 3, honest: 2, broad: 1, decline: 1, wrong: 0 }; const reg = d.detail.filter((x) => rank[x.to] < rank[x.from]);
  if (reg.length) { L.push("", `DEV regressions (${Math.min(reg.length, max)} of ${reg.length}):`); for (const x of reg.slice(0, max)) L.push(`  ${x.from}->${x.to}  ${x.question}`); }
  return L.join("\n");
}

function loadExam(outDir) {
  const f = (n) => { const p = path.join(outDir, n); return fs.existsSync(p) ? readJson(p).items : []; };
  return { dev: f("dev.json"), sealed: f("sealed.json") };
}
const orgOf = (exp, a) => String(arg(a, "--org") ?? exp.tenantKey ?? "org").replace(/[^A-Za-z0-9_.-]+/g, "_");

async function main(argv) {
  const cmd = argv[0];
  if (!cmd || cmd === "help" || cmd === "--help") { console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("*/")[0].replace(/^#!.*\n\/\*\*?/, "")); return 0; }
  if (cmd === "self-test") { const m = await import("./verify-r5-exam-tooling.mjs"); return m.run({ quiet: false }); }
  if (cmd === "build") {
    const exp = readJson(arg(argv, "--export")); const org = orgOf(exp, argv); const out = arg(argv, "--out", path.join("exam-out", org)); const seed = arg(argv, "--seed", DEFAULT_SEED);
    const qs = parseLog(fs.readFileSync(arg(argv, "--log"), "utf8"), { org: arg(argv, "--org") });
    const ex = buildExam({ exportData: exp, questions: qs, seed, variants: !argv.includes("--no-variants") });
    fs.mkdirSync(out, { recursive: true });
    for (const side of ["dev", "sealed"]) fs.writeFileSync(path.join(out, `${side}.json`), JSON.stringify({ org, seed, side, items: ex[side] }, null, 1));
    const total = ex.dev.length + ex.sealed.length;
    console.log(`exam for ${org}: ${qs.length} log questions -> ${total} unique (${ex.dev.length} dev ${(100 * ex.dev.length / Math.max(1, total)).toFixed(0)}%, ${ex.sealed.length} sealed) seed=${seed}`);
    for (const s of ["dev", "sealed"]) { const k = kinds(ex[s]); console.log(`  ${s}: answerable=${k.answerable} unanswerable-from-rows=${k.unanswerable} unclassified(excluded)=${k.unclassified} variants=${ex[s].reduce((a, i) => a + i.variants.length, 0)}`); }
    console.log(`written: ${path.join(out, "dev.json")} and ${path.join(out, "sealed.json")} (sealed.json is private: keep it out of git, chats and prompts)`);
    return 0;
  }
  if (cmd === "score" || cmd === "diff") {
    const out = arg(argv, "--out"); const { dev, sealed } = loadExam(out);
    if (cmd === "score") {
      const answers = readJson(arg(argv, "--answers")); const r = scoreAnswers({ dev, sealed, answers });
      console.log(renderReport({ title: `EXAM SCORE (${path.basename(arg(argv, "--answers"))})`, agg: r.agg, devDetail: r.devDetail }));
      if (arg(argv, "--json")) fs.writeFileSync(arg(argv, "--json"), JSON.stringify({ agg: r.agg, devDetail: r.devDetail }, null, 1));
    } else console.log(renderDiff(diffAnswers({ dev, sealed, a: readJson(arg(argv, "--a")), b: readJson(arg(argv, "--b")) })));
    return 0;
  }
  console.error("unknown command; run: node scripts/exam-build.mjs help"); return 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => process.exit(c)).catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
