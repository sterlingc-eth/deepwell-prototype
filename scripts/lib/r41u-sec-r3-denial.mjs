// R3 denial rule (property test): Donovan may say a person/company is not in the records ONLY when no customer, vendor or contact shares a name token with what was asked
// (titles, punctuation, possessive s, token order, case and a one-letter typo removed). Every customer of the golden export x 30 generated phrasings must produce ZERO denials.
// The model is stubbed with a WRONG customer/total that must never reach the user. Truth (names, invoice numbers, totals) comes from the raw export rows.
import * as F from "./r40-fixture.mjs";
import { installScriptedModel } from "./r40-model-stub.mjs";

export const DENY = /(?:don'?t|do not|didn'?t) (?:see|have|find) (?:an?|any|anyone|one)\b[^.]{0,40}\b(?:customer|vendor|person|company|client|named|anyone)|anyone named|no such (?:customer|vendor|person)|(?:isn'?t|is not|not) (?:in|on) (?:your|the) (?:records|file)|not on file as a customer|can'?t find an? (?:bill|invoice) for them|couldn'?t find an? (?:customer|vendor)|no (?:customer|vendor|client)(?: or \w+)? (?:named|called|by)|no — no customer|not a customer|no records? (?:of|for) /i;
const TITLES = ["mr", "mrs", "ms", "miss", "dr", "mr.", "dr.", "mister"];
function typo(w) { return w.length < 5 ? w : `${w.slice(0, 2)}${w.slice(3)}`; } // drop one letter (a one-letter typo)
export function nameForms(full) {
  const t = full.split(/\s+/); const first = t[0]; const last = t[t.length - 1]; const rest = t.slice(0, -1).join(" ");
  const lastFirst = `${last} ${rest}`;
  return {
    plain: full, lower: full.toLowerCase(), upper: full.toUpperCase(), lastFirst, comma: `${last}, ${rest}`, commaLower: `${last}, ${rest}`.toLowerCase(),
    poss: `${full}'s`, possNoApos: `${full}s`, lastPoss: `${last}'s`, lastOnly: last, mrLast: `mr ${last}`, mrsFull: `mrs ${full}`, drLast: `Dr. ${last}`, msLast: `ms ${last}`, mrDotFull: `Mr. ${full}`,
    typoLast: `${rest} ${typo(last)}`, typoFirst: `${typo(first)} ${t.slice(1).join(" ")}`, lastFirstPoss: `${last} ${rest}'s`,
  };
}
export const TEMPLATES = [
  "has {N} been invoiced", "the invoice for {N}", "{N} - how much", "whats {N} balance", "amount due from {N}", "look up {N}", "how much money did we make off {N}", "need the total on {N}s job",
  "did {N} pay their invoice", "{N} invoice", "show me {N} bill", "how much was {N}'s bill", "wheres {N} invoice", "what did we bill {N}", "latest invoice for {N}", "is {N}'s invoice paid",
  "what does {N} owe", "did we ever invoice {N}", "what did {N} get charged", "{N} bill please", "tell me about {N} invoice", "whats the {N} invoice", "invoice {N}", "find {N}",
  "how much has {N} been billed", "total for {N}", "{N}", "pull up the bill for {N}", "has {N} paid us", "give me the {N} invoice", "last invoice {N}", "how much do we owe {N}",
];
export const FORMS_ORDER = ["plain", "lower", "lastFirst", "comma", "poss", "possNoApos", "lastPoss", "mrLast", "mrsFull", "drLast", "typoLast", "lastOnly", "upper", "commaLower", "msLast", "mrDotFull", "typoFirst", "lastFirstPoss"];

export default async function ({ check, realLog, off }) {
  const stub = await installScriptedModel();
  const prev = process.env.ASK_HELPGATE_IN_SCORECARD; process.env.ASK_HELPGATE_IN_SCORECARD = "1";
  const d = F.loadGolden(); d.tenantKey = "r41u-r3"; d.tenantName = "r41u-r3";
  const custs = d.entities.filter((e) => e.entity_type === "customer" && !e.merged_into).map((e) => e.data.customer_name);
  const limit = Number(process.env.R3_LIMIT || custs.length);
  const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
  const { askViaHandler } = await import("../../api/_lib/scorecard/askCall.js");
  const { default: askHandler } = await import("../../api/ask.js");
  const ctx = (await off.loadExportIntoNewTenant(lite, d, { tenantKey: "offline:r41u-r3", tenantName: "r41u-r3" })).ctx;
  const WRONG = { kind: "answer", text: "Zebediah Crane owes $3,407.00.", facts: [{ label: "Customer", value: "Zebediah Crane", sources: [] }, { label: "Total", value: "$3,407.00", sources: [] }], sources: [], confidence: 0.9 };
  const STUB = /zebediah|crane|3,407/i;
  const ask = async (question) => {
    await off.setActiveDatabase(lite); stub.fn = () => WRONG; stub.calls = 0;
    const r = await askViaHandler({ handler: askHandler, auth: { tenantId: ctx.tenantKey, orgId: "r41u-r3", userId: null }, question, today: "2026-10-07" });
    const facts = r.data?.facts ?? [];
    return { kind: r.data?.kind, text: String(r.data?.text ?? ""), shown: `${r.data?.text ?? ""}\n${facts.map((f) => `${f.label} ${f.value}`).join("\n")}\n${r.data?.interpretation ?? ""}` };
  };
  let n = 0, denials = 0; const bad = [];
  const money = (x) => Number(x).toLocaleString("en-US", { minimumFractionDigits: 2 });
  const invs = new Map(); for (const f of d.financials) if (f.doc_kind === "invoice" && f.direction === "receivable") { if (!invs.has(f.customer_name)) invs.set(f.customer_name, []); invs.get(f.customer_name).push(f); }
  // a useful reply names the person, quotes one of their invoice numbers/totals, or (for a typo / shared surname) names the customers that match; "does not answer" is not a denial but is counted separately
  const useful = (full, shown) => { const lo = shown.toLowerCase(); const t = full.toLowerCase().split(/\s+/); return lo.includes(full.toLowerCase()) || (invs.get(full) ?? []).some((f) => shown.includes(f.invoice_number) || (f.total != null && shown.includes(money(f.total)))) || t.every((x) => lo.includes(x)); };
  let notUseful = 0; const weak = [];
  for (let ci = 0; ci < limit; ci++) {
    const full = custs[ci]; const forms = nameForms(full);
    for (let i = 0; i < 30; i++) {
      const tpl = TEMPLATES[(i + ci) % TEMPLATES.length]; const fk = FORMS_ORDER[(i * 5 + ci * 3) % FORMS_ORDER.length];
      const q = tpl.replace("{N}", forms[fk]); n++;
      const r = await ask(q);
      if (DENY.test(r.shown)) { denials++; bad.push(`DENIAL [${q}] -> ${r.text.slice(0, 160)}`); }
      else if (STUB.test(r.shown)) bad.push(`STUB [${q}] -> ${r.text.slice(0, 160)}`);
      else if (!["lastOnly", "mrLast", "drLast", "msLast", "lastPoss"].includes(fk) && !useful(full, r.shown)) { notUseful++; weak.push(`NOANSWER [${q}] -> ${r.text.slice(0, 160)}`); }
    }
  }
  check(`R3 denial property: ${n} phrasings over ${limit} golden customers, zero denials for an existing customer, no stub figure`, bad.length === 0, `${bad.length} bad; first: ${bad.slice(0, 6).join(" || ")}`);
  check(`R3 denial property: a reply to a full-name phrasing (any order, title, typo) answers about that customer: ${notUseful} not useful of ${n}`, notUseful <= Math.floor(n * 0.01), weak.slice(0, 6).join(" || "));
  if (weak.length) { const fs = await import("node:fs"); fs.writeFileSync((process.env.R3_OUT || "/home/claude/r3-bad.txt") + ".weak", weak.join("\n")); }
  if (bad.length) { const fs = await import("node:fs"); fs.writeFileSync(process.env.R3_OUT || "/home/claude/r3-bad.txt", bad.join("\n")); }
  realLog(`R3 denial property: ${n} asks, ${denials} denials, ${bad.length} bad`);
  if (prev === undefined) delete process.env.ASK_HELPGATE_IN_SCORECARD; else process.env.ASK_HELPGATE_IN_SCORECARD = prev;
}
