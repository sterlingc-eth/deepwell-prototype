#!/usr/bin/env node
/**
 * Merge the jargon research (document_label + field entries) into api/_lib/modelAvoidance/fieldSynonyms.js.
 *
 * Reads  /home/claude/work/jargon/*.json  (or $JARGON_DIR)
 * Writes the block between "BEGIN GENERATED LABELS" and "END GENERATED LABELS" in fieldSynonyms.js
 * (GENERATED_LABELS per role + LABEL_RANK for the prompt). The hand-written table above it is never touched.
 *
 * Rules:
 *  - keyed by EXISTING roles of FIELD_SYNONYMS only (customer, vendor, cost, costPaid, serviceDate, invoiceDate,
 *    receiptDate, documentNumber, term, termStart, termEnd, insured; policy expiry labels go to termEnd, which the scanners
 *    only apply to agreements and insurance certificates). Research entries whose "means" is
 *    not mapped below are counted as dropped:unmapped (a pack field with no role in the label table).
 *  - everything in the research "ambiguous" list is dropped.
 *  - a label is a LABEL: 2-4 words (or an allowlisted single word), letters only (plus # . ' / & -), no question words.
 *    The scanners that read this table still demand a colon / tab / table-header form after the label; this script
 *    never changes that, so a label inside a sentence is not picked up.
 *  - "policyholder" / "the insured" are NOT mapped: on an EOB or an insurer letter they name the customer, and the vendor scan
 *    reads insured labels on every document type.
 *  - generic words that also head a line-item column or occur in prose are on STOP.
 *  - ranking for the prompt: number of distinct research entries (across groups/industries) that list the phrase;
 *    ties by shorter phrase. Only the top PROMPT_PER_ROLE per role not already in the hand-picked prompt list are printed.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = process.env.JARGON_DIR || "/home/claude/work/jargon";
const TARGET = path.join(ROOT, "api/_lib/modelAvoidance/fieldSynonyms.js");
const BEGIN = "// BEGIN GENERATED LABELS (scripts/build-field-labels.mjs)";
const END = "// END GENERATED LABELS";

const STOP = new Set([
  "amount", "amt", "total", "price", "cost", "charges", "charged", "billed", "revenue", "sales", "gross", "invoiced", "balance",
  "fee", "fees", "name", "date", "from", "to", "number", "description", "item", "period", "term", "begins", "beginning", "through",
  "thru", "dated", "exp", "expires", "starts", "start", "end", "ends", "paid", "received", "tendered", "member", "student", "patient",
  "contact name", "caller", "ordered by", "requested by",
]);
const SINGLE_OK = new Set(["policyholder", "payee", "supplier", "homeowner", "donor", "contributor", "consignee", "lessee", "lessor", "insurer"]);

const rx = (s) => new RegExp(s, "i");
// means -> [{role, allow, deny}]  (first matching rule wins; no match = dropped:rule)
const RULES = {
  customer_name: [{ role: "customer", allow: rx("^(bill(ed|ing)? to|billing name|sold to|customer|client|account name|homeowner|property owner|donor( name)?|name of donor|contributor( name)?|received from)$") }],
  vendor: [{ role: "vendor", allow: rx("^(supplier|payee|sold by|payable to|(make )?checks? payable to|pay to( the order of)?|remit to|remittance to)$") }],
  cost: [{ role: "cost", allow: rx("(balance due|amount due|total due|grand total|amount owed|due now|please remit|pay this amount|amount payable|total amount due|please pay|(invoice|job|ticket|repair|order) total|invoice amount|amount invoiced|(professional|legal) fees|total fees|fee total)"), deny: rx("^(invoice total|total|grand total)$|how much") }],
  _costPaid: [{ role: "costPaid", allow: rx("^(amount donated|amount of gift|gift total|gift amount|donation amount|contribution amount|paid amount|amount of payment)$") }],
  service_date: [
    { role: "receiptDate", allow: rx("^(gift date|date of gift|donation date|date of donation|contribution date)$") },
    { role: "invoiceDate", allow: rx("^(application date|date of application|pay app date)$") },
    { role: "serviceDate", allow: rx("^(date of service|svc date|job date|visit date|date completed|completion date|completed on|date serviced|work date|dos|date svc|date of visit|date of procedure|encounter date|treatment date)$") },
  ],
  invoice_number: [{ role: "documentNumber", allow: rx("^(invoice (no|num|id|#)\\.?|inv ?(#|no)\\.?|bill (no|number|#)|doc(ument)? (no|number|#)\\.?|rcpt ?(#|no)|receipt id|sales receipt #|sale (#|no|number)|transaction (#|no|number)|txn (#|id)|trans #|ticket (#|no)|tkt #|slip (#|no)|ref(erence)? (#|no)\\.?|your ref|our ref|confirmation (#|number|code)|conf #|credit (memo|note) (#|no|number)|cm (#|no)|cn (#|no)|debit memo (#|no)|packing slip (#|no)|pack slip #|delivery (#|no|number|note no)|statement (#|no|number)|stmt (#|no)|pay app (#|number|no)|application (#|no|number)|draw (#|no|number)|requisition (#|number)|req (#|no)|claim (#|no|number|id)|work order number|wo ?#|ro #|rma (#|number|no)|return (#|no)|refund (#|number)|gift id|donation id|gift number|award (#|no))$") }],
  agreement_term: [{ role: "term", allow: rx("^(plan term|plan length|membership term|membership length|contract (length|term|period)|agreement (length|period|term)|coverage period|plan period|term of agreement|length of agreement|lease (term|length|period|duration)|term of lease|rental (period|term|duration|length)|policy (term|period|dates)|period of coverage|grant (period|term)|period of performance|project period|funding period|performance period|award period|coverage dates)$") }],
  term_start: [{ role: "termStart", allow: rx("^(policy (effective date|eff|inception|start date|begins)|eff date|inception date|coverage (begins|effective))$") }],
  lease_start_date: [{ role: "termStart", allow: rx("^(lease (start|start date|begins)|commencement date|move-?in date|possession date|occupancy date|term start|start of term)$") }],
  on_rent_date: [{ role: "termStart", allow: rx("^(on[- ]rent date|date on rent|on[- ]hire date|rental start( date)?|start of rental)$") }],
  lease_end_date: [{ role: "termEnd", allow: rx("^(lease (end|end date|expiration|expires|exp|ends)|term end|end of term|move-?out date|vacate date)$") }],
  off_rent_date: [{ role: "termEnd", allow: rx("^(off[- ]rent date|date off rent|off[- ]hire date|end date of rental|rental end)$") }],
  coi_expires: [
    { role: "termEnd", allow: rx("^(policy (exp|expiry|end|expires|ends)|exp date|coverage (ends|expires)|valid (through|until)|good through|coi (expiration|expires)|cert expires|insurance (expiration|expiry))$") },
  ],
  insured: [{ role: "insured", allow: rx("^(named insured|first named insured|name of insured|insured name)$") }],
};
RULES.cost.push(...RULES._costPaid); delete RULES._costPaid;
// research entries "means" cost for gift amounts need the costPaid rule too; handled since rules are tried in order.

const norm = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim().replace(/[:;]+$/, "");
const okShape = (p) => /^[a-z][a-z .'#\/&-]*$/.test(p) && p.length >= 3 && p.length <= 34 && p.split(" ").length <= 4 && !/\b(how|what|which|when)\b/.test(p);

const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json"));
const ambiguous = new Set();
const entries = [];
for (const f of files) {
  const d = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
  for (const a of d.ambiguous ?? []) ambiguous.add(norm(a.term));
  for (const e of d.entries ?? []) if (e.class === "field" || e.class === "document_label") entries.push({ ...e, file: f });
}

// existing table (hand-written part only): import with the generated block cleared so a re-run is stable
const src = fs.readFileSync(TARGET, "utf8");
const handBase = src.includes(BEGIN) ? src.slice(0, src.indexOf(BEGIN)) : null;
const baseSynonyms = await (async () => {
  const tmp = path.join(path.dirname(TARGET), `.fs-base-${process.pid}.mjs`);
  const body = src.includes(BEGIN) ? src.slice(0, src.indexOf(BEGIN)) + "\nexport { FIELD_SYNONYMS as __BASE };\n" : src.replace("export const FIELD_SYNONYMS", "const FIELD_SYNONYMS") + "\nexport { FIELD_SYNONYMS as __BASE };\n";
  fs.writeFileSync(tmp, body);
  try { return (await import(tmp + "?" + Date.now())).__BASE; } finally { fs.unlinkSync(tmp); }
})();

const stats = { kept: 0, dropped: { ambiguous: 0, stop: 0, shape: 0, single: 0, unmapped: 0, rule: 0, duplicate: 0 } };
const byRole = {}; const count = {};
const unmappedMeans = {};
for (const e of entries) {
  const rules = RULES[e.means];
  const phrases = [...new Set([e.term, ...(e.variants ?? [])].map(norm))];
  for (const p of phrases) {
    if (!rules) { stats.dropped.unmapped++; unmappedMeans[e.means] = (unmappedMeans[e.means] ?? 0) + 1; continue; }
    if (ambiguous.has(p)) { stats.dropped.ambiguous++; continue; }
    if (STOP.has(p)) { stats.dropped.stop++; continue; }
    if (!okShape(p)) { stats.dropped.shape++; continue; }
    if (!/[ -]/.test(p) && !SINGLE_OK.has(p) && p !== "dos") { stats.dropped.single++; continue; }
    const rule = rules.find((r) => r.allow.test(p) && !(r.deny && r.deny.test(p)));
    if (!rule) { stats.dropped.rule++; continue; }
    const have = baseSynonyms[rule.role] ?? [];
    const k = `${rule.role}\u0000${p}`;
    count[k] = (count[k] ?? 0) + 1;
    if (have.includes(p)) { if (count[k] === 1) stats.dropped.duplicate++; continue; }
    if (count[k] === 1) { (byRole[rule.role] ??= []).push(p); stats.kept++; }
  }
}
const rank = {};
for (const [role, list] of Object.entries(byRole)) {
  list.sort((a, b) => count[`${role}\u0000${b}`] - count[`${role}\u0000${a}`] || a.length - b.length || a.localeCompare(b));
  rank[role] = list;
}
const roles = Object.keys(rank).sort();
// "most common": listed by 2+ separate research entries. These (capped, a few per role) are the only generated labels the model prompt prints.
const common = {};
for (const r of roles) { const c = rank[r].filter((p) => count[`${r}\u0000${p}`] >= 2); if (c.length) common[r] = c; }
const block = [
  BEGIN,
  `// Generated ${files.length} research files, ${entries.length} field/document_label entries. Do not edit by hand: re-run the script.`,
  "const GENERATED_LABELS = {",
  ...roles.map((r) => `  ${r}: ${JSON.stringify(rank[r])},`),
  "};",
  "/** Per role, generated labels from most to least widely listed in the research (the prompt takes the head of each list). */",
  "export const LABEL_RANK = GENERATED_LABELS;",
  "/** Generated labels that 2+ research entries list: the candidates for the compact model prompt (extractFields.js via synonymGuide). */",
  `export const LABEL_COMMON = ${JSON.stringify(common)};`,
  "for (const [role, list] of Object.entries(GENERATED_LABELS)) {",
  "  FIELD_SYNONYMS[role] = [...new Set([...(FIELD_SYNONYMS[role] ?? []), ...list])];",
  "}",
  END,
].join("\n");

let out;
if (src.includes(BEGIN)) out = src.slice(0, src.indexOf(BEGIN)) + block + src.slice(src.indexOf(END) + END.length);
else {
  // insert right after the FIELD_SYNONYMS object literal ("};" followed by the ESC helper)
  const marker = "\nconst ESC = ";
  const i = src.indexOf(marker);
  if (i < 0) throw new Error("marker not found in fieldSynonyms.js");
  out = src.slice(0, i) + "\n" + block + "\n" + src.slice(i);
}
if (process.argv.includes("--dry")) console.log(block);
else fs.writeFileSync(TARGET, out);
console.log(JSON.stringify({ researchEntries: entries.length, kept: stats.kept, dropped: stats.dropped, perRole: Object.fromEntries(roles.map((r) => [r, rank[r].length])) }));
console.log("unmapped pack fields (entries):", Object.keys(unmappedMeans).length);
