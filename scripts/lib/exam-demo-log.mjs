// R5 demo question logs: messy office wordings written as templates, filled from a fixture's raw rows. `node scripts/lib/exam-demo-log.mjs` writes scripts/golden/exam-demo/*.jsonl and exam-out/demo/*-export.json (run from the repo root).
import fs from "node:fs";
import { buildRecordsFixture } from "./records-fixture.mjs";
import { buildOfficeFixture } from "./office-fixture-r4.mjs";
const T_CUST = ["{l} phone", "whats {n}'s number", "how do i call {l}", "{n} email addr", "where does {l} live", "address for {n} pls", "can u tell me what we did for {n} last time", "{l} last job", "how much did we charge {l}", "what was {n}s bill", "{l} serial number", "what refrigerant does {n} have", "phone number for {n}?", "{n}: email", "{l} service address", "what is {n} phone"];
const T_DOC = ["{d} total", "whats the total on {d}", "{d} due date", "when is {d} due", "was {d} paid", "{d} tech", "who worked on {d}", "can you tell me hours on {d} please", "{d} what work was done", "labor charge on {d}", "when was {d} done", "how much was {d} for", "any notes on {d}", "{d}  date"];
const T_CLIENT = ["when does {l} agreement expire", "{n} contract end date", "monthly fee for {n}?", "how much does {l} pay us a month", "what is the agreement number for {n}", "{l} phone", "where is {n} located", "when are we resurfacing the lot for {n}", "{l} lot estimate", "whats {n}'s email"];
const T_VENDOR = ["what do we owe {v} on {d}", "{d} amount due", "due date for {v} invoice {d}", "{v} bill total", "when is {d} due pls", "was {d} paid", "{v} {d} date"];
const T_EMP = ["when did {n} start", "{l} hire date", "whats {n}'s hourly rate", "how much does {l} make per hour", "{n} job title", "{l} position", "who does {n} report to", "{l} supervisor", "{n} phone number", "what is {n}s home address"];
const NOANS = ["{n} fax number", "what is the favorite color of {n}", "blood type for {n}", "{l} social security number", "{n} birthday", "{l} salary history"];
const GHOST = ["Zebulon Pemberthwaite", "Quentin Ashgrove", "Marigold Bakery", "Wilhelmina Strutt", "Orlando Vexley", "Tamsin Hartigan", "Canary Zeta", "Zelda Quillfeather"];
const GHOST_T = ["what is the phone number for {n}", "{l} address", "when does {l} agreement expire", "how much did we charge {n}", "what did we do for {n} last time", "{l} email"];
const GHOST_DOC = ["total on INV-99999", "who worked on WO-77777", "{x}-88123 due date", "was INV-77001 paid", "hours on INV-91000"];
const fill = (t, o) => t.replace(/\{n\}/g, o.n ?? "").replace(/\{l\}/g, (o.n ?? "").toLowerCase()).replace(/\{d\}/g, o.d ?? "").replace(/\{v\}/g, o.v ?? "").replace(/\{x\}/g, o.x ?? "INV");
export function demoQuestions(kind, d) {
  const out = []; const add = (tpl, o) => out.push(fill(tpl, o));
  const custs = d.entities.filter((e) => e.entity_type === "customer" && e.data?.customer_name).map((e) => e.data.customer_name);
  const docs = d.financials.filter((f) => f.invoice_number);
  if (kind === "hvac") {
    custs.slice(0, 27).forEach((n, i) => { for (let k = 0; k < 4; k++) add(T_CUST[(i * 3 + k * 5) % T_CUST.length], { n }); });
    docs.filter((_, i) => i % 2 === 0).slice(0, 32).forEach((f, i) => { for (let k = 0; k < 3; k++) add(T_DOC[(i * 2 + k * 5) % T_DOC.length], { d: f.invoice_number }); });
    // traps: first names alone, surname alone, one-letter-off names
    for (const q of ["linda phone", "delgado address", "what did marcus do last time", "barbara delgado vs marcus delgado phone", "donna phone number", "total on est 701"]) out.push(q);
  } else {
    custs.forEach((n, i) => { for (let k = 0; k < 6; k++) add(T_CLIENT[(i * 2 + k * 3) % T_CLIENT.length], { n }); });
    docs.filter((f) => f.vendor_name).forEach((f, i) => { for (let k = 0; k < 3; k++) add(T_VENDOR[(i + k * 2) % T_VENDOR.length], { v: f.vendor_name, d: f.invoice_number }); });
    const emps = d.pages.map((p) => p.text.match(/^Employee:\s*(.+)$/m)?.[1]).filter(Boolean);
    emps.forEach((n, i) => { for (let k = 0; k < 4; k++) add(T_EMP[(i + k * 3) % T_EMP.length], { n }); });
    for (const q of ["how much does Ridgeline Landscaping say we owe for May mowing", "ridgeline may mowing payment due", "rid-99999 total", "gordon pike phone", "what is the monthly fee for aldridge", "whos priya"]) out.push(q);
  }
  const subj = custs.slice(0, 3); const empN = kind === "office" ? d.pages.map((p) => p.text.match(/^Employee:\s*(.+)$/m)?.[1]).filter(Boolean).slice(0, 2) : [];
  [...subj, ...empN].forEach((n, i) => NOANS.forEach((t, k) => { if ((i + k) % 2 === 0) add(t, { n }); }));
  GHOST.forEach((n, i) => { for (let k = 0; k < 2; k++) add(GHOST_T[(i + k * 3) % GHOST_T.length], { n }); });
  GHOST_DOC.forEach((t) => add(t, { x: kind === "hvac" ? "INV" : "BIL" }));
  return out;
}
if (process.argv[1]?.endsWith("exam-demo-log.mjs")) {
  const dir = new URL("../golden/exam-demo/", import.meta.url).pathname;
  for (const [kind, ex] of [["hvac", buildRecordsFixture({ variant: "A", extraCustomers: 14 }).export], ["office", buildOfficeFixture({ variant: "A" }).export]]) {
    const qs = demoQuestions(kind, ex); fs.writeFileSync(`${dir}${kind}-questions.jsonl`, qs.map((q, i) => JSON.stringify({ question: q, asked_at: `2026-09-${String(1 + (i % 28)).padStart(2, "0")}T14:00:00Z` })).join("\n") + "\n");
    fs.mkdirSync("exam-out/demo", { recursive: true }); fs.writeFileSync(`exam-out/demo/${kind}-export.json`, JSON.stringify(ex)); console.log(kind, qs.length, "questions");
  }
}
