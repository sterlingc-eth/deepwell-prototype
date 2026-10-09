#!/usr/bin/env node
// Fast check for the R5 sealed-exam tooling (npm run verify:r5-exam-tooling): split determinism, no sealed text in any printed output, paraphrases stay on their
// source's side, truth reader on 22 hand-checked rows of a tiny export, and the five score classes on synthetic answers. No database, no model.
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawnSync } from "node:child_process"; import { pathToFileURL } from "node:url";
import { sideOf, canonKey, paraphrases, normQ, parseLog } from "./lib/exam-text.mjs";
import { buildIndex, truthFor, textHas } from "./lib/exam-truth.mjs";
import { classify, aggregate, renderReport } from "./lib/exam-score.mjs";
import { buildExam, scoreAnswers, diffAnswers, renderDiff } from "./exam-build.mjs";

const D = (iso) => `${iso}T12:00:00Z`;
const mini = () => {
  const doc = (id, type) => ({ id, original_filename: `${id}.pdf`, document_type: type, stage: "linked", created_at: D("2026-01-01") });
  const fin = (document_id, o) => ({ id: `f-${document_id}`, document_id, doc_kind: "invoice", direction: "receivable", currency: "USD", po_number: null, due_date: null, amount_paid: null, balance_due: null, status: "unknown", customer_name: null, vendor_name: null, ...o });
  const ex = (document_id, field_key, value) => ({ id: `${document_id}${field_key}`, document_id, entity_id: null, field_key, value });
  return {
    documents: [doc("d1", "invoice"), doc("d2", "invoice"), doc("d3", "invoice"), doc("d4", "invoice")],
    pages: [["d1", "Invoice #: INV-100\nBill To: Ann Lee\nTOTAL DUE: $250.00"], ["d2", "Invoice #: INV-101\nBill To: Ann Lee"], ["d3", "Invoice #: INV-200\nBill To: Bob Ray"], ["d4", "ACME SUPPLY\nInvoice No: ACM-500"]].map(([document_id, text]) => ({ id: `p${document_id}`, document_id, page_no: 1, text })),
    extractions: [ex("d1", "technician", "Kim Cole"), ex("d1", "labor_hours", "2"), ex("d1", "work_performed", "Replaced capacitor"), ex("d2", "technician", "Raj Patel"), ex("d2", "work_performed", "Recharged system"), ex("d3", "work_performed", "Tune-up")],
    entities: [{ id: "c1", entity_type: "customer", merged_into: null, data: { customer_name: "Ann Lee", phone: "(555) 010-1111", email: "ann@x.com", service_address: "12 Oak St, Mesa, AZ" } },
      { id: "c2", entity_type: "customer", merged_into: null, data: { customer_name: "Bob Ray", phone: "(555) 020-2222", service_address: "9 Elm Rd, Tempe, AZ" } },
      { id: "e1", entity_type: "equipment", merged_into: null, customer_id: "c1", data: { serial_number: "SN100" } }],
    document_entity_links: [["c1", "d1"], ["c1", "d2"], ["c2", "d3"]].map(([entity_id, document_id]) => ({ entity_id, document_id })),
    financials: [fin("d1", { invoice_number: "INV-100", invoice_date: "2026-03-01", due_date: "2026-03-15", total: "250.00", status: "paid", customer_name: "Ann Lee" }),
      fin("d2", { invoice_number: "INV-101", invoice_date: "2026-05-01", due_date: "2026-05-15", total: "1250.00", customer_name: "Ann Lee" }),
      fin("d3", { invoice_number: "INV-200", invoice_date: "2026-04-01", total: "99.50", status: "unpaid", customer_name: "Bob Ray" }),
      fin("d4", { invoice_number: "ACM-500", invoice_date: "2026-06-01", due_date: "2026-06-30", total: "400.00", vendor_name: "Acme Supply" })],
    financial_lines: [],
  };
};

export function run({ quiet = true } = {}) {
  let bad = 0; const ok = (name, cond, d = "") => { if (!cond) { bad++; console.log(`FAIL ${name} ${d}`); } else if (!quiet) console.log(`ok   ${name}`); };
  // ---- 1. split determinism and balance
  const qs = Array.from({ length: 600 }, (_, i) => `what is the gizmo number ${i} for customer q${i * 7}`);
  const a = qs.map((q) => sideOf("s1", q)), b = qs.map((q) => sideOf("s1", q));
  ok("split is deterministic", a.join() === b.join());
  const devShare = a.filter((x) => x === "dev").length / qs.length; ok("split is about 60/40", devShare > 0.54 && devShare < 0.66, devShare.toFixed(3));
  ok("a different seed changes the split", qs.some((q) => sideOf("s2", q) !== sideOf("s1", q)));
  const same = [["whats ann lee's phone number", "ann lee phone"], ["Ann Lee phone?", "pls ann lee phone"], ["what is the total on INV-100", "can you tell me total on inv-100 please"], ["wheres bob ray's address", "where is bob ray address"], ["what is the due date for INV-101", "INV-101 due date"]];
  for (const [x, y] of same) ok(`re-wordings share a key: ${x}`, canonKey(x) === canonKey(y), `${canonKey(x)} | ${canonKey(y)}`);
  // ---- 2. paraphrases stay on the source side
  const base = ["what is the phone number for Ann Lee", "INV-100 due date", "whats Bob Ray's address", "who worked on INV-100", "how much did we charge Bob Ray"];
  let nv = 0; const kindsSeen = new Set();
  for (const q of base) { const v = paraphrases(q, "s1"); nv += v.length; v.forEach((x) => kindsSeen.add(x.kind)); ok(`variants exist for "${q}"`, v.length >= 4); ok(`variants differ from the source: ${q}`, v.every((x) => normQ(x.text) !== normQ(q) || x.text !== q)); }
  for (const k of ["plain", "pls", "wrap", "swap", "typo-drop"]) ok(`paraphrase kind produced: ${k}`, kindsSeen.has(k), [...kindsSeen].join());
  const ex = buildExam({ exportData: mini(), questions: parseLog(base.concat(qs.slice(0, 80)).join("\n")), seed: "s1" });
  ok("every item sits on the side its own hash says", ex.dev.every((i) => sideOf("s1", i.question) === "dev") && ex.sealed.every((i) => sideOf("s1", i.question) === "sealed"));
  const answersAll = []; for (const side of ["dev", "sealed"]) for (const it of ex[side]) { answersAll.push({ question: it.question, answer_text: `echo ${it.question}` }); for (const v of it.variants) answersAll.push({ question: v.question, answer_text: `echo ${v.question}` }); }
  const sc = scoreAnswers({ dev: ex.dev, sealed: ex.sealed, answers: answersAll });
  const nDevVar = ex.dev.reduce((s, i) => s + i.variants.length, 0), nSealVar = ex.sealed.reduce((s, i) => s + i.variants.length, 0);
  ok("variants are scored on the source's side", sc.agg.dev.variants.n + sc.agg.sealed.variants.n >= 0 && sc.agg.dev.variants.n <= nDevVar && sc.agg.sealed.variants.n <= nSealVar && sc.agg.dev.variants.n > 0 && sc.agg.sealed.variants.n > 0, `${sc.agg.dev.variants.n}/${nDevVar} ${sc.agg.sealed.variants.n}/${nSealVar}`);
  ok("no answer is lost", sc.rows.every((r) => !r.missing));
  // ---- 3. no sealed text in anything printed
  const sealedTexts = ex.sealed.flatMap((i) => [i.question, ...i.variants.map((v) => v.question)]).map((s) => s.toLowerCase());
  ok("there is a sealed side to test", ex.sealed.length > 10);
  const leak = (txt) => sealedTexts.find((s) => txt.toLowerCase().includes(s));
  const rep = renderReport({ title: "T", agg: sc.agg, devDetail: sc.devDetail });
  ok("score report holds no sealed text", !leak(rep), leak(rep));
  const other = answersAll.map((x) => ({ ...x, answer_text: "Nothing in your records answers that." }));
  const df = renderDiff(diffAnswers({ dev: ex.dev, sealed: ex.sealed, a: answersAll, b: other }));
  ok("diff report holds no sealed text", !leak(df), leak(df));
  ok("dev detail is shown for dev", ex.dev.length === 0 || /DEV misses|DEV by fact/.test(rep) || sc.devDetail.length === 0);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "exam-selftest-")); const here = path.dirname(new URL(import.meta.url).pathname);
  fs.writeFileSync(path.join(tmp, "exp.json"), JSON.stringify(mini())); fs.writeFileSync(path.join(tmp, "log.txt"), base.concat(qs.slice(0, 80)).join("\n")); fs.writeFileSync(path.join(tmp, "ans.json"), JSON.stringify(answersAll));
  const cli = (...args) => { const r = spawnSync(process.execPath, [path.join(here, "exam-build.mjs"), ...args], { encoding: "utf8" }); return `${r.stdout}\n${r.stderr}`; };
  const o1 = cli("build", "--export", path.join(tmp, "exp.json"), "--log", path.join(tmp, "log.txt"), "--out", path.join(tmp, "o"), "--seed", "s1");
  const o2 = cli("score", "--out", path.join(tmp, "o"), "--answers", path.join(tmp, "ans.json"));
  const o3 = cli("diff", "--out", path.join(tmp, "o"), "--a", path.join(tmp, "ans.json"), "--b", path.join(tmp, "ans.json"));
  ok("CLI build/score/diff stdout+stderr hold no sealed text", ![o1, o2, o3].some(leak), leak(o1 + o2 + o3));
  ok("CLI wrote sealed.json separately", fs.existsSync(path.join(tmp, "o", "sealed.json")) && !fs.readFileSync(path.join(tmp, "o", "dev.json"), "utf8").toLowerCase().includes(sealedTexts[0]));
  fs.rmSync(tmp, { recursive: true, force: true });
  // ---- 4. truth reader on hand-checked rows
  const ix = buildIndex(mini());
  const T = (q) => truthFor(ix, q);
  const rows = [
    ["inv-100 total", "answerable", "$250.00"], ["whats the total on INV-101", "answerable", "$1,250.00"], ["INV-100 due date", "answerable", "03/15/2026"], ["when is inv-101 due", "answerable", "May 15, 2026"],
    ["was inv-100 paid", "answerable", "paid"], ["was inv-101 paid", "unanswerable"], ["was inv-200 paid", "answerable", "unpaid"], ["who worked on inv-100", "answerable", "Kim Cole"], ["who worked on inv-200", "unanswerable"],
    ["inv-100 hours", "answerable", "2 hours"], ["ann lee phone", "answerable", "(555) 010-1111"], ["whats Bob Ray's address", "answerable", "9 Elm Rd"], ["ann lee serial number", "answerable", "SN100"], ["bob ray refrigerant", "unanswerable"],
    ["ann lee email", "answerable", "ann@x.com"], ["bob ray fax number", "unanswerable"], ["inv-999 total", "unanswerable"], ["acme supply acm-500 total", "answerable", "$400.00"],
    ["what did we do for ann lee last time", "answerable", "Recharged system"], ["how much did we charge bob ray", "answerable", "$99.50"], ["zorbo quimby phone", "unanswerable"], ["ann phone", "unclassified"],
  ];
  for (const [q, kind, val] of rows) { const t = T(q); ok(`truth: ${q} -> ${kind}${val ? " " + val : ""}`, t.kind === kind && (!val || t.accept.includes(val)), `${t.kind} ${t.accept.join("|")} (${t.note})`); }
  ok("truth: the unlisted-last accept excludes the older job", !T("what did we do for ann lee last time").accept.includes("Replaced capacitor"));
  ok("money match respects boundaries ($250.00 is not inside $1,250.00)", !textHas("it was $1,250.00", "$250.00") && textHas("it was $250.00.", "$250.00") && !textHas("1,250.00", "250.00"));
  // ---- 5. the five classes
  const tot = T("inv-100 total"), paid = T("was inv-101 paid"), phone = T("ann lee phone");
  const C = (t, text, facts) => classify(t, { answer_text: text, facts });
  ok("class right", C(tot, "The total on INV-100 is $250.00.") === "right");
  ok("class right (value in a fact)", C(tot, "Here it is.", [{ label: "Total", value: "$250.00" }]) === "right");
  ok("class wrong: another record's value", C(tot, "The total is $1,250.00.") === "wrong");
  ok("class wrong: right value plus another record's", C(tot, "$250.00, or maybe $99.50") === "wrong");
  ok("class wrong: invented value", C(tot, "The total is $777.00") === "wrong");
  ok("class honest", C(tot, "Nothing in your records answers that.") === "honest" && C(paid, "No payment status is on file for INV-101.") === "honest");
  ok("class broad", C(phone, "Here is everything on file for Ann Lee: 3 documents.") === "broad" && C(phone, "ok", [1, 2, 3, 4].map((i) => ({ label: `f${i}`, value: `v${i}` }))).length !== 0);
  ok("class broad (fact list)", C(phone, "Found on file for Ann Lee.", [1, 2, 3, 4].map((i) => ({ label: `f${i}`, value: `v${i}` }))) === "broad");
  ok("class decline", C(tot, "I couldn't match that. Did you mean something else?") === "decline" && C(tot, "") === "decline");
  ok("unanswerable: claiming a status is wrong", C(paid, "It was paid.") === "wrong");
  ok("unanswerable: unknown subject, any claim is wrong", C(T("zorbo quimby phone"), "Zorbo's phone is (555) 999-0000") === "wrong" && C(T("zorbo quimby phone"), "I don't have anyone named zorbo on file.") === "honest");
  ok("unclassified is not scored", C(T("ann phone"), "anything") === null && aggregate([{ side: "dev", isVariant: false, cls: null, missing: false }]).dev.base.unscored === 1);
  return bad ? 1 : (console.log("verify:r5-exam-tooling ok"), 0);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(run({ quiet: !process.argv.includes("--verbose") }));
