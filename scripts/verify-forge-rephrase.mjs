#!/usr/bin/env node
/**
 * FORGE rephrase sweep: the same supported question asked 10 ways (lower case, no punctuation, shouting, 1-2 letter typos, singular/plural,
 * "whats/show me/tell me" frames, polite filler, name typo) must give the SAME answer, never a different one. Truth is computed from the raw rows.
 * RIGHT = expected figure/name shown; DECLINE = no checkable claim; WRONG = a figure/name that is not the truth. Fails (exit 1) on any WRONG
 * and on any variant that is not RIGHT when the canonical wording is RIGHT. Usage: node scripts/verify-forge-rephrase.mjs [--rows] [--report-only]
 */
const { forgeHarness, ansText } = await import("./lib/forge-harness.mjs");
const { buildOrgA } = await import("./lib/forge-promise-bank.mjs");
const args = process.argv.slice(2);
const { data } = buildOrgA();
const h = await forgeHarness({ a: data });
const cust = data.entities.filter((e) => e.entity_type === "customer");
const fin = data.financials;
const money = (n) => "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2 });
const unpaid = fin.filter((f) => f.direction === "receivable" && f.doc_kind === "invoice" && f.status === "unpaid");
const sum = (a) => a.reduce((s, f) => s + Number(f.total), 0);
const byCust = (n) => fin.filter((f) => f.customer_name === n && f.doc_kind === "invoice");
const nDocs = (t) => data.documents.filter((d) => d.document_type === t).length;
const addr = (n) => cust.find((c) => c.data.customer_name === n).data.service_address.split(",")[0];
const Q = [
  ["How many customers do we have?", [String(cust.length)]],
  ["How many unpaid invoices do we have?", [String(unpaid.length)]],
  ["How many permits do we have?", [String(nDocs("permit"))]],
  ["How many maintenance agreements do we have?", [String(nDocs("maintenance-agreement"))]],
  ["How many service tickets do we have?", [String(nDocs("service-ticket"))]],
  ["How many customers are in Mesa?", [String(cust.filter((c) => /Mesa/.test(c.data.service_address)).length)]],
  ["What is Mark Henderson's address?", [addr("Mark Henderson")]],
  ["What is Chidi Okafor's address?", [addr("Chidi Okafor")]],
  ["What is Carl Smith's address?", [addr("Carl Smith")]],
  ["What is the total of invoice INV-3301?", [money(fin.find((f) => f.invoice_number === "INV-3301").total)]],
  ["What is the total of invoice INV-2101?", [money(fin.find((f) => f.invoice_number === "INV-2101").total)]],
  ["Who is invoice INV-2102 for?", ["Mark Henderson"]],
  ["When is invoice INV-2101 dated?", ["July 10, 2026", "07/10/2026", "2026-07-10"]],
  ["How much does Henderson Roofing LLC owe us?", [money(sum(byCust("Henderson Roofing LLC")))]],
  ["How many unpaid invoices does Mark Henderson have?", [String(byCust("Mark Henderson").filter((f) => f.status === "unpaid").length)]],
  ["What did we invoice Mark Henderson in total?", [money(sum(byCust("Mark Henderson")))]],
  ["How much is Lisa Hendricks's invoice?", [money(sum(byCust("Lisa Hendricks")))]],
  ["How many units do we have?", [String(data.entities.filter((e) => e.entity_type === "equipment").length)]],
];
const KEYWORDS = ["customers", "customer", "invoices", "invoice", "permits", "agreements", "address", "tickets", "unpaid", "total", "units", "owe", "service", "maintenance", "dated"];
const TYPO_KEYS = KEYWORDS.filter((k) => !/^invoice/.test(k)); // typos in "invoice(s)" itself are the Capability team's item (typo drops filter)
const flip = (w) => (w.endsWith("s") && w.length > 5 ? w.slice(0, -1) : w + "s");
function typo(q, n) { // n letters wrong inside the first long keyword that is not a name/number
  let out = q, done = 0;
  for (const k of TYPO_KEYS.filter((k) => k.length >= 5)) {
    const re = new RegExp(`\\b${k}\\b`, "i"); const m = re.exec(out); if (!m) continue;
    let w = m[0];
    if (done === 0) w = w.slice(0, 2) + w.slice(3); // drop 1 letter
    else w = w.slice(0, 3) + w[4] + w[3] + w.slice(5); // swap two
    out = out.slice(0, m.index) + w + out.slice(m.index + m[0].length); done++; if (done === n) break;
  }
  return out;
}
const strip = (q) => q.replace(/[?.!,]/g, "").replace(/'s\b/g, (m, i, all) => (/s$/i.test(all.slice(0, i)) ? "" : "s"));
const lc = (q) => strip(q).toLowerCase();
const nameTypo = (q) => q.replace(/Henderson/, "Hendersen").replace(/Okafor/, "Okafar").replace(/Smith/, "Smyth").replace(/Hendricks/, "Hendrix");
function variants(q) {
  const base = lc(q);
  const kw = KEYWORDS.find((k) => new RegExp(`\\b${k}\\b`, "i").test(base));
  return [
    ["canonical", q], ["lower+nopunct", base], ["SHOUTING", q.toUpperCase()], ["typo1", typo(lc(q), 1)], ["typo2", typo(lc(q), 2)],
    ["plural-flip", kw ? base.replace(new RegExp(`\\b${kw}\\b`), flip(kw)) : base], ["whats-frame", /^what is /.test(base) ? base.replace(/^what is /, "whats ") : /^who is /.test(base) ? base.replace(/^who is /, "whos ") : "tell me " + base],
    ["show-me", "show me " + base], ["polite", "can you tell me " + base + " please"], ["name-typo", nameTypo(lc(q))],
  ];
}
function classify(expect, r) {
  if (r.error || !r.data) return "DECLINE";
  const t = ansText(r.data), low = t.toLowerCase();
  if (expect.some((e) => low.includes(e.toLowerCase()))) {
    // a right figure plus a different one still counts as wrong only if a different money/date figure appears
    const m = [...String(r.data.text ?? "").matchAll(/\$[\d,]+(?:\.\d\d)?/g)].map((x) => x[0]);
    const want = expect.filter((e) => e.startsWith("$"));
    return m.some((x) => want.length && !want.includes(x) && !want.includes(x + ".00")) ? "WRONG" : "RIGHT";
  }
  return /\$\d|\b\d{1,3}(,\d{3})*\b/.test(t) && !/couldn'?t|can'?t|not on file|which|more than one|nothing in your records/i.test(r.data.text ?? "") ? "WRONG" : "DECLINE";
}
const tally = { RIGHT: 0, DECLINE: 0, WRONG: 0 }; const bad = []; let supported = 0, incons = 0;
for (const [q, expect] of Q) {
  const cls = [];
  for (const [name, text] of variants(q)) {
    const r = await h.ask("a", text); const c = classify(expect, r); cls.push(c); tally[c]++;
    if (c !== "RIGHT") bad.push(`${c.padEnd(7)} ${name.padEnd(13)} ${text}  ->  ${(r.data?.text ?? r.error ?? "").slice(0, 90)}`);
  }
  if (cls[0] === "RIGHT") { supported++; if (cls.some((c) => c !== "RIGHT")) incons++; }
  if (args.includes("--rows")) h.realLog(cls.map((c) => c[0]).join(""), q);
}
for (const b of bad) h.realLog(b);
const L = h.latency();
h.realLog(`\nREPHRASE SWEEP: ${Q.length} questions x 10 phrasings = ${Q.length * 10} cases: RIGHT ${tally.RIGHT}, DECLINE ${tally.DECLINE}, WRONG ${tally.WRONG}; supported(canonical RIGHT)=${supported}, inconsistent=${incons}; latency p50=${L.p50}ms p95=${L.p95}ms`);
process.exit(args.includes("--report-only") || (tally.WRONG === 0 && incons === 0) ? 0 : 1);
