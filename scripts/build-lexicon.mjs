#!/usr/bin/env node
/**
 * Jargon lexicon builder (J1).
 *
 * Reads the five research files in scripts/data/jargon/*.json (term / variants / class / means, plus ambiguous[] and new_concepts[]),
 * curates them and writes ONE compact, deterministic data file: api/_lib/lexicon/jargon.generated.js.
 *
 * WHAT SURVIVES. Only an entry whose `means` maps to a concept Donovan can act on:
 *   RESPELL    variant -> the canonical word the question lanes already read (document types, roles, a few statuses and field words,
 *              equipment types, date phrases the existing date parsers read). Used by router/jargon respell.
 *   UNTRACKED  variant -> a concept id for something DeepWell does not record at all (retainage, commissions, change orders, payroll...).
 *              Used by the early decline: an honest "not in your records" with no model call.
 * Everything else is counted and dropped, by reason. Anything in an `ambiguous` list is NEVER mapped (any term or variant that
 * normalises to an ambiguous term is dropped). A variant of 2 characters or fewer, a plain English word, or a phrase two concepts
 * claim, is dropped too (a short allow-list below names the few single words that are safe).
 *
 * Deterministic: sorted keys, no dates, no randomness. Run: node scripts/build-lexicon.mjs [--check]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = process.env.JARGON_SRC || path.join(ROOT, "scripts/data/jargon");
const OUT = path.join(ROOT, "api/_lib/lexicon/jargon.generated.js");

/* ---------------------------------------------------------------- normalisation (shared with the runtime: api/_lib/lexicon/jargon.js) */
const TOKEN_RE = /[a-z0-9]+(?:'[a-z]+)?/g;
const tokensOf = (s) => (String(s ?? "").toLowerCase().replace(/[’`]/g, "'").match(TOKEN_RE) ?? []).map((t) => t.replace(/'/g, ""));
/** singular form of a LAST token (consistent on both sides, so it only has to be deterministic) */
export function singularToken(w) {
  if (w.length <= 3) return w;
  if (/ies$/.test(w) && w.length > 4) return w.slice(0, -3) + "y";
  if (/(ss|us|is|ous)$/.test(w)) return w;
  if (/(ches|shes|xes|sses|zes)$/.test(w)) return w.slice(0, -2);
  if (/s$/.test(w)) return w.slice(0, -1);
  return w;
}
export function keyOf(s) {
  const t = tokensOf(s);
  if (!t.length) return "";
  t[t.length - 1] = singularToken(t[t.length - 1]);
  return t.join(" ");
}

/* ---------------------------------------------------------------- inputs */
const files = fs.readdirSync(SRC).filter((f) => f.endsWith(".json")).sort();
const entries = [];
const ambiguousKeys = new Set();
const newConceptIds = new Set();
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(path.join(SRC, f), "utf8"));
  const grp = j.group || f.replace(/\.json$/, "");
  for (const e of j.entries ?? []) entries.push({ ...e, group: grp });
  for (const a of j.ambiguous ?? []) { const k = keyOf(a.term); if (k) ambiguousKeys.add(k); }
  for (const c of j.new_concepts ?? []) newConceptIds.add(String(c.id));
}

const { COMMON_WORDS } = await import(path.join(ROOT, "api/_lib/router/lexicon.generated.js"));
const COMMON = new Set(COMMON_WORDS.split(/\s+/));
const dt = await import(path.join(ROOT, "api/_lib/documentTypes.js"));
const lx = await import(path.join(ROOT, "api/_lib/lookups/lexicon.js"));
const { parsePeriod } = await import(path.join(ROOT, "api/_lib/financials/answers.js"));

// phrases the question lanes already read: mapping them again would change nothing (or fight an existing rule)
const KNOWN = new Set();
// Only phrases the lanes can actually read: every word must be a doc-type trigger word. The newer extra synonyms (pay app,
// proof of insurance, subcontract...) are deliberately NOT trigger words, so the lanes do not read them and they still need respelling.
const TRIGGERS = new Set((dt.DOCTYPE_TRIGGER_WORDS || []).map((w) => String(w).toLowerCase()));
for (const ws of Object.values(dt.DOCUMENT_TYPE_SYNONYMS)) for (const w of ws) {
  if (String(w).toLowerCase().split(/\s+/).every((t) => TRIGGERS.has(t))) KNOWN.add(keyOf(w));
}
for (const ws of Object.values(lx.EXTRA_DOC_TYPE_WORDS)) for (const w of ws) KNOWN.add(keyOf(w));

/* ---------------------------------------------------------------- curation tables */
// single plain-English words that ARE safe because the concept is unmistakable for the tenant's own paperwork
const SINGLE_ALLOW = new Set([
  "plumber", "electrician", "apprentice", "journeyman", "foreman", "handyman", "installer",
  "subcontractor", "supplier", "wholesaler", "distributor",
  "homeowner", "stmt", "recibo",
  "retainage", "commission", "markup", "payroll", "overtime", "paycheck", "paystub", "pto", "garnishment", "withholding",
  "deductible", "premium", "indemnification", "retainer",
]);
const UNTRACKED_SINGLE_ALLOW = new Set(["retainage", "commission", "markup", "payroll", "overtime", "paycheck", "paystub", "pto", "garnishment", "withholding", "indemnification", "subcontract"]);
const DROP_VARIANT = /(^|\s)(who|what|which|when|where|why|how|hasn|hasnt|haven|havent|never|still|did|does|do|is|are|was|were|we|our|my|i)(\s|$)/;

/**
 * RESPELL rules. cls: research `class` values; means: exact ids; canon: the word the lanes read [singular, plural|null];
 * allow: only these entry TERMS (lower case) when given; deny: entry terms never taken; only: a variant must match this regex
 * (it names what a phrase has to look like to mean the concept); denyVariant: a variant matching this is never taken.
 * Names of suppliers, brands, refrigerants and tonnages are deliberately NOT mapped: a respell must never replace a value.
 */
const D = ["doc_type"];
const DOC = [
  { cls: D, means: ["invoice"], canon: ["invoice", "invoices"],
    allow: ["tax invoice", "sales invoice", "recurring invoice", "progress invoice", "final invoice", "amended invoice", "invoce", "inv", "legal invoice", "rental invoice", "pay application", "invoice"],
    only: /^(inv|invs|in?[nv]+[oi]+[a-z]*|pay ?app|pay application|payment application|application (for|and certificate for) payment|progress (bill|billing)|final bill\w*|legal bill|rental bill\w*|draw request|g ?702)$/ },
  { cls: D, means: ["receipt"], canon: ["receipt", "receipts"],
    allow: ["sales receipt", "pos receipt", "proof of purchase", "expense receipt", "deposit receipt", "refund receipt", "donation receipt", "rent receipt", "recibo", "recipt", "receipt"],
    only: /^(e?rec[eiu]+i?p?t|receit|recibo|proof of (purchase|payment)|payment (confirmation|acknowledg\w+|slip)|paid slip|acknowledg\w+ of payment|confirmation of payment|gift acknowledg\w+|till slip)$/ },
  { cls: D, means: ["statement"], canon: ["statement", "statements"], allow: ["stmt", "customer statement", "statement of account"] },
  { cls: D, means: ["purchase-order"], canon: ["purchase order", "purchase orders"],
    allow: ["po", "purchase order construction", "purchase requisition", "vendor order", "office supplies order", "purchase order"],
    only: /^(purchase (ord|request|requisition)|materials? (po|order|request)|parts order|vendor order|supplier order|office (supplies|depot) order|order form|open po|po (log|status|release|revision|change))$/ },
  { cls: D, means: ["delivery-ticket"], canon: ["delivery ticket", "delivery tickets"],
    allow: ["packing list", "proof of delivery", "waybill", "receiving report", "delivery ticket", "pickup ticket"],
    only: /^(packing (list|sheet|slip)|pack ?list|pod slip|delivery (tkt|receipt|confirmation|order)|pick ?up (receipt|slip|order)|receiving (slip|ticket|record|log)|goods received note|drop ?(off )?ticket|counter ticket|haul ticket|way ?bill)$/ },
  { cls: D, means: ["price-list"], canon: ["price list", "price lists"], allow: ["price book", "fee schedule", "msrp list"],
    only: /^(price ?book|price ?list|price (sheet|schedule)|fee sched\w*|rate (book|schedule|card|sheet)|menu pric\w+|pricing sheet|msrp (list|sheet))$/ },
  { cls: D, means: ["hr-letter"], canon: ["hr letter", "hr letters"], allow: ["w-2", "w-4", "i-9", "payroll register"] },
  { cls: D, means: ["insurance-certificate", "certificate-of-insurance"], canon: ["insurance certificate", "insurance certificates"],
    allow: ["certificate of insurance", "coi", "professional liability", "general liability", "workers comp", "renters insurance"], denyVariant: /\bcard\b/ },
  { cls: D, means: ["proposal-quote"], canon: ["quote", "quotes"], deny: ["grant application", "bid"], denyVariant: /\b(grant|loi|letter of inquiry|request for)\b/ },
  { cls: D, means: ["maintenance-agreement"], canon: ["maintenance agreement", "maintenance agreements"], deny: ["recurring service"],
    only: /^(comfort (club|plan)|care plan|club membership|member plan|peace of mind plan|pm (agreement|plan)|preventive maintenance plan|tune ?up plan|annual service plan|biomed contract|equipment service contract|maintenance contract equipment|service (agreement|plan) equipment|support (agreement|plan))$/ },
  { cls: D, means: ["work-order"], canon: ["work order", "work orders"], denyVariant: /\b(tenant request|wo shop|mechanic ticket|fix request|maintenance request|repair request|service request)\b/ },
  { cls: D, means: ["service-ticket"], canon: ["service ticket", "service tickets"], deny: ["service call"], denyVariant: /\binvoice\b/ },
  { cls: D, means: ["dispatch-note"], canon: ["dispatch note", "dispatch notes"] },
  { cls: D, means: ["startup-sheet"], canon: ["startup sheet", "startup sheets"], denyVariant: /\b(test and balance|tab report|air balance|system startup)\b/ },
  { cls: D, means: ["inspection-report"], canon: ["inspection report", "inspection reports"], allow: ["inspection sheet"] },
  { cls: D, means: ["warranty-registration"], canon: ["warranty registration", "warranty registrations"], allow: ["equipment registration", "warranty certificate"] },
  { cls: D, means: ["nameplate-photo"], canon: ["nameplate", "nameplates"] },
];
const ROLE = [
  { cls: ["role"], means: ["technician"], canon: ["technician", "technicians"], allow: ["technician", "installer", "apprentice", "plumber", "electrician", "lead tech", "maintenance tech"],
    only: /(^|\s)(tech|techs|technician|technicians|installer|installers|plumber|plumbers|electrician|electricians|apprentice|apprentices|helper|helpers|handyman|foreman|rooter guy|sparky)$|^(crew (lead|chief|leader)|lead tech\w*|install (crew|team|tech)|changeout crew|change out crew)$/ },
  { cls: ["role"], means: ["customer", "customer_name"], canon: ["customer", "customers"], allow: ["homeowner", "commercial customer", "customer"],
    only: /^(home ?owners?|commercial (customers?|accounts?|clients?)|corporate accounts?|business customers?|residential customers?|resi customers?)$/ },
  { cls: ["role"], means: ["vendor"], canon: ["vendor", "vendors"], allow: ["supplier", "supply house", "vendor"],
    only: /^(suppliers?|supply houses?|parts houses?|distributors?|wholesalers?|vendors?|our (vendors?|suppliers?))$/ },
];
const STATUS = [
  { cls: ["status"], means: ["unpaid"], canon: ["unpaid", null], allow: ["unpaid", "outstanding balance", "unpaid pledge"], only: /^(not (yet )?paid|outstanding balance|open balance|awaiting payment)$/ },
  { cls: ["status"], means: ["overdue"], canon: ["overdue", null], allow: ["past due", "overdue notice"], only: /^(past due|pastdue|over due|late (payment|invoice|notice)s?|delinquent invoices?)$/ },
];
const FIELD = [
  { cls: ["field"], means: ["manufacturer"], canon: ["manufacturer", null], only: /^(equipment|unit) brand$/ },
  { cls: ["field"], means: ["warranty_expires"], canon: ["warranty expires", null], only: /^(coverage end|covered until|warranty (end|exp|expiration|expiry|through|valid until))$/ },
  { cls: ["field"], means: ["customer_phone"], canon: ["phone number", null], only: /^(customer|contact|primary|home|callback|call back|best|cell) (phone|number)$/ },
  { cls: ["field"], means: ["customer_email"], canon: ["email address", null], only: /^(customer|contact|billing) email$/ },
];
/** Whole-business measures that no document field or lane produces; written by hand (the research files cover paperwork, not accounting). */
const MANUAL_UNTRACKED = {
  business_ratios: ["cost per lead", "cost per acquisition", "customer acquisition cost", "customer lifetime value", "lifetime value", "lead source", "referral source", "renewal rate", "attrition rate", "churn rate", "inventory turnover", "labor burden", "overhead cost", "days sales outstanding"],
  occupancy: ["occupancy rate", "vacancy", "vacancy rate"],
  rent_income: ["rent roll", "rental income", "rent collected", "monthly rent", "rent increase", "rent payment", "rent due", "late rent"],
  donations: ["donation", "fundraising", "annual fund", "capital campaign", "pledge drive"],
  headcount: ["headcount", "head count", "employee count", "number of employees", "how many employees", "workforce", "staff size", "team size", "employee turnover", "staff turnover"],
  hiring: ["open position", "job opening", "hiring", "job posting", "new hire", "recruiting", "recruitment"],
  mileage: ["mileage", "miles driven", "gas mileage", "fuel cost", "fuel expense", "vehicle log", "fleet mileage"],
  reviews_ratings: ["bad review", "good review", "negative review", "positive review", "star rating", "google review", "online review", "customer review", "yelp", "testimonial", "net promoter", "nps score"],
  payment_status: ["delinquent", "delinquency", "behind on payment", "late payer", "slow payer", "deadbeat", "in collections", "owe more than", "owes more than"],
  financial_statements: ["net income", "net profit", "net earnings", "cash flow", "profit and loss", "p and l", "balance sheet", "ebitda", "break even", "working capital", "operating margin", "cost of goods sold", "cogs", "burn rate", "overhead rate"],
};
/**
 * R3 B1: the everyday nouns of other businesses, mapped to the one word the lanes read. These are written by hand BECAUSE the research
 * marks several of them ambiguous across industries (tenant, member, client, bid, estimate, lease, retainer): for a business that keeps
 * paperwork (this product) each has exactly one reading, and the cases where it does not are listed in GENERIC_HOLD (the word stays as typed).
 * Never mapped on purpose: unit, bill, account, contract (own rule), job site, order, ticket, visit, request, site.
 * The name guard in lexicon/jargon.js still applies: a phrase made of a customer's or technician's own name words is a name.
 */
const GENERIC_FAMILIES = [
  { canon: ["customer", "customers"], variants: ["tenant", "resident", "member", "donor", "supporter", "client", "patient", "patron", "property", "building owner"] },
  { canon: ["technician", "technicians"], variants: ["subcontractor", "sub contractor", "staff member", "team member", "crew member", "field staff", "crew"] },
  { canon: ["quote", "quotes"], variants: ["bid", "estimate", "tender", "bid proposal"] },
  { canon: ["maintenance agreement", "maintenance agreements"], variants: ["lease", "lease agreement", "retainer", "retainer agreement", "service contract", "service plan", "support contract"] },
  { canon: ["service ticket", "service tickets"], variants: ["site visit", "call out", "callout", "maintenance request", "service request", "house call", "truck roll", "trouble call"] },
  { canon: ["repair ticket", "repair tickets"], variants: ["repair request"] },
  { canon: ["permit", "permits"], variants: ["building permit", "construction permit", "electrical permit", "plumbing permit", "mechanical permit", "city permit"] },
  { canon: ["inspection report", "inspection reports"], variants: ["move in inspection", "move out inspection", "site inspection", "safety inspection", "building inspection", "property inspection"] },
  { canon: ["warranty", "warranties"], variants: ["guarantee", "guaranty"] },
  { canon: ["revenue", "revenue"], variants: ["billing"], pluralOnly: true },
  { canon: ["receipt", "receipts"], variants: ["donation receipt", "rent receipt"] },
];
/** "*" marks the word that must stay as typed. A phrase here means something else in a business that keeps paperwork. */
const GENERIC_HOLD = [
  "*tenant improvement", "*tenant allowance", "*member id", "*member number", "*member since", "*member dues", "club *member", "plan *member", "program *member",
  "*client id", "*client portal", "*bid bond", "*bid package", "*bid date", "*lease payment", "*lease rate", "*retainer fee", "*estimate number",
  "*property manager", "*property management", "*property tax", "*property damage", "*property type", "*patient portal", "*patient id",
  "*resident manager", "*guarantee fee", "personal *guarantee", "money back *guarantee",
];
/** A word that is NOT mapped when any of these words appear anywhere in the question (a dental retainer is not an agreement). */
const GENERIC_HOLD_NEAR = { retainer: ["dental", "dentist", "dentistry", "orthodontic", "orthodontics", "orthodontist", "braces", "teeth", "tooth", "patient", "aligner", "invisalign"] };
const RESPELL_RULES = [...DOC, ...ROLE, ...STATUS, ...FIELD];
/**
 * "contract" is NOT one thing. A bare "contract" in a service shop is the maintenance agreement (documentTypes.js), but an employment
 * contract is an HR paper, and a subcontract, vendor contract, prime contract or NDA is another kind of agreement entirely. These are
 * written by hand because the research files give them as agreement/other, which Donovan cannot act on.
 */
const MANUAL_RESPELL = [
  { canon: ["hr letter", "hr letters"], variants: ["employment contract", "employee contract", "employment agreement", "employee agreement", "offer of employment", "employment offer"] },
];

// date phrases: means (prefix) -> the phrase the existing date parsers read (financials/answers.js parsePeriod + timeSpans)
const DATE = [
  ["day:0", "today"], ["day:-1", "yesterday"],
  ["week:previous", "last week"], ["month:current", "this month"], ["month:previous", "last month"],
  ["quarter:current", "this quarter"], ["quarter:previous", "last quarter"],
  ["year:current", "this year"], ["year:previous", "last year"],
  ["rolling:7d", "last 7 days"], ["rolling:30d", "last 30 days"], ["rolling:60d", "last 60 days"], ["rolling:90d", "last 90 days"],
];
const DATE_DROP_VARIANT = /\d$|\b(before|to date|so far|mtd|qtd|ytd|wtd|rolling|over|ago|same|calendar|fiscal|tax|ttm|first|beginning|start|end|night|right now)\b/;

/**
 * UNTRACKED concepts: id -> { means: research ids that belong to it, only: what a phrase must look like }. A phrase must be specific
 * (it has to name the thing), so generic words ("full time", "flat rate", "classification") never get in.
 */
const UNTRACKED_GROUPS = {
  retainage: { means: ["retainage"], only: /retainage|retention (held|money|payable|release|withheld)|release of retention/ },
  commission: { means: ["commission", "tech_commission"], only: /commission/ },
  markup_margin: { means: ["markup_margin", "markup"], only: /^(mark ?up|parts markup|markup percent(age)?|gross margin|gross profit|profit margin|margin percent(age)?)$/ },
  late_fee: { means: ["late_fee", "late-fee"], only: /^(late (fee|charge|penalty|payment fee|interest)|finance charge|interest charge|past due fee|nsf fee|returned payment fee)$/ },
  change_order: { means: ["change-order", "change_order_total"], only: /^((chg|change) (order|directive|request|proposal)\w*( (log|request|total|summary))?|co (log|total)|change order\w*( \w+)?)$/ },
  payroll: { means: ["pay_rate", "overtime_hours", "regular_hours", "gross_pay", "net_pay", "payroll_tax", "payroll_deduction", "pto_balance", "pay_period", "pay_date", "pay_frequency", "probation_period", "wc_class_code", "employee_id", "employment_start_date", "employment_end_date", "employment_type", "job_title", "clock_in", "clock_out", "break_minutes", "reimbursement"],
    only: /payroll|paycheck|pay stub|paystub|pay rate|overtime|^pto( \w+)?$|paid time off|accrued (pto|leave)|gross (pay|earning)|net pay|take home pay|salary|garnishment|withholding|401 ?k|futa|suta|hourly wage|pay period|sick (days|leave)|vacation (days|balance|accrual)|employee (id|number)|double time/ },
  insurance_terms: { means: ["premium", "deductible", "coverage_limit", "coverage_type", "coverage_basis", "loss_date", "claim_number", "waiver_of_subrogation", "primary_noncontributory", "loss_payee", "adjuster", "cancellation_notice", "operations_description"],
    only: /^(insurance )?premium|^deductible|coverage (limit|amount)|aggregate limit|policy limit|loss date|date of loss|claim (number|no|id|ref)|claims? adjuster|loss payee|waiver of subrogation|experience mod/ },
  legal_billing: { means: ["matter", "billing_increment", "realization", "trust_account", "liability_cap", "indemnification", "governing_law", "contingency_fee", "not_to_exceed", "flat_fee", "time_and_materials", "hourly_rate"],
    only: /billing (increment|realization)|^realization|trust account|contingen\w+ fee|not to exceed|liability cap|limitation of liability|indemnif|governing law|blended rate|matter (number|no|name)|iolta|billable hours?/ },
  property_charges: { means: ["cam_charge", "pro_rata_share", "base_year", "square_footage", "rent_psf", "percentage_rent", "ti_allowance", "noi", "management_fee", "hoa_dues", "special_assessment", "reserve_fund", "pet_deposit", "security_deposit", "rent_amount", "lease_start_date", "lease_end_date", "notice_period", "turn_cost"],
    only: /cam (charge|expense|fee|reconciliation)|common area (maintenance|charge)|pro rata share|base year|rent psf|percentage rent|tenant improvement|ti allowance|^noi$|net operating income|management fee|hoa (due|fee)s?|special assessment|reserve fund|pet (deposit|fee|rent)|security deposit|damage deposit|cap rate|triple net|^nnn$/ },
  rental_metrics: { means: ["meter_hours", "odometer", "fuel_level", "damage_waiver", "rental_rate", "utilization", "on_rent_date", "off_rent_date"],
    only: /meter hour|hour meter|odometer|fuel level|damage waiver|rental rate|fleet utilization|dollar utilization|engine hours?|day rate|daily rate|weekly rate/ },
  construction_billing: { means: ["schedule_of_values", "contract_sum", "contract_sum_to_date", "stored_materials", "work_completed"],
    only: /schedule of values|^sov$|g ?70[23]|continuation sheet|contract sum|stored materials|materials (presently )?stored|percent complete|pct complete|guaranteed maximum price|completed (and stored )?to date/ },
  nonprofit_funds: { means: ["fund", "restricted-fund", "unrestricted-fund", "matching-funds", "endowment", "net-assets", "daf", "in-kind-gift", "non-cash-gift", "tribute", "soft-credit", "indirect-costs", "direct-costs", "sponsorship", "membership-dues", "fair-market-value", "deductible-amount", "functional-expense", "grant-drawdown"],
    only: /restricted (fund|gift|donation)|unrestricted|matching (gift|fund)|endowment|net assets|donor advised|^daf|gift in kind|in kind (gift|donation)|soft credit|indirect (cost|rate)|fair market value|functional expense|designated fund/ },
  health_billing: { means: ["allowed-amount", "patient-responsibility", "insurance-paid", "copay", "coinsurance", "oop-max", "annual-maximum", "npi", "member_id", "diagnosis_code", "service_code", "sliding-scale"],
    only: /co ?pay|co ?insurance|out of pocket|^oop|allowed amount|patient responsibility|^npi|cpt code|icd|diagnosis code|member id|insurance id|prior auth|sliding scale|annual max/ },
  accounting_entries: { means: ["accrual", "deferred-revenue", "prepaid-expense", "estimated-tax", "tax-reclaim", "write-off", "gift_card", "store_credit", "rebate", "core_charge", "consignment_split"],
    only: /accrual|accrued (expense|revenue)|deferred (revenue|income)|prepaid expense|bad debt|write ?off|estimated tax|gift card|store credit|rebate|core charge|depreciation|amortization|ebitda/ },
  other_contracts: { means: ["agreement"],
    only: /sub ?contract|prime contract|vendor (agreement|contract)|supplier (agreement|contract)|supply agreement|sales (agreement|contract)|purchase (agreement|contract)|consulting (agreement|contract)|master services? agreement|^msa$|non ?disclosure|^ndas?$|statement of work|^sow$|independent contractor agreement/ },
  business_metrics: { means: ["metric:conversion_rate", "metric:callback_rate", "metric:membership_attach", "metric:revenue_per_tech", "metric:capacity", "first_time_fix"],
    only: /conversion rate|close rate|closing rate|callback rate|comeback rate|first time fix|attach rate|win rate|revenue per (tech|technician)|rev per tech|sales per tech|booking rate|repeat rate|redo rate/ },
};
const UNTRACKED_BY_MEANS = new Map();
for (const [id, g] of Object.entries(UNTRACKED_GROUPS)) for (const m of g.means) UNTRACKED_BY_MEANS.set(m, id);
const UNTRACKED_CLASSES = new Set(["money", "field", "doc_type", "status", "action", "document_label"]);
// phrases the lanes answer anyway (money lane / expiry lane / job costing) -> never declined
const UNTRACKED_DENY_VARIANT = /\b(job cost|costing|invoice|invoices|owe|owed|unpaid|overdue|aging|due date|expire|expires|expiration|work order|purchase order|amount)\b|(?<!\b(?:pto|leave|vacation|sick|off) )\bbalance\b|\d/;

/* ---------------------------------------------------------------- the build */
const dropped = {}; // reason -> count
let dropN = 1;
const drop = (r) => { dropped[r] = (dropped[r] ?? 0) + dropN; };
const dropAll = (r, n) => { dropped[r] = (dropped[r] ?? 0) + n; };
const respell = new Map(); // key -> { canon, cls, src }
const conflicts = new Set();
const untracked = new Map(); // key -> concept id
const untrackedConflict = new Set();
let variantsSeen = 0;

const matchRule = (rules, e) => rules.find((r) => r.cls.includes(e.class) && r.means.includes(e.means));

function filterVariant(raw, { allowSingle, term }) {
  variantsSeen++;
  const toks = tokensOf(raw);
  const flat = toks.join(" ");
  if (!toks.length) return drop("empty"), null;
  if (flat.replace(/\s/g, "").length <= 2) return drop("two chars or fewer"), null;
  if (!/[a-z]/.test(flat)) return drop("no letters"), null;
  if (toks.length > 6) return drop("too long"), null;
  const k = keyOf(raw);
  if (ambiguousKeys.has(k)) return drop("ambiguous term"), null;
  if (DROP_VARIANT.test(flat)) return drop("question/verb phrase"), null;
  if (toks.length === 1) {
    const w = toks[0];
    if (!allowSingle.has(w) && !allowSingle.has(singularToken(w)) && (COMMON.has(w) || COMMON.has(singularToken(w)) || COMMON.has(w.replace(/s$/, "")))) return drop("generic English word"), null;
    if (w.length <= 3 && !allowSingle.has(w)) return drop("short single token (collides with names/abbreviations)"), null;
  } else if (toks.every((t) => t.length <= 2)) return drop("two chars or fewer"), null;
  void term;
  return k;
}

for (const e of entries) {
  const terms = [e.term, ...(e.variants ?? [])];
  const termL = String(e.term ?? "").toLowerCase();
  // ---- date phrases
  if (e.class === "date_phrase") {
    const d = DATE.find(([pre]) => String(e.means).startsWith(pre));
    if (!d) { dropAll("date phrase: no parser form", terms.length); continue; }
    for (const raw of terms) {
      const flat = tokensOf(raw).join(" ");
      // "past quarter" / "past month" is the TRAILING span, not the previous calendar one (the lanes treat them differently)
      if (DATE_DROP_VARIANT.test(flat) || (!/\d/.test(d[1]) && /\bpast\b/.test(flat))) { drop("date phrase: different meaning from its normal form"); continue; }
      const k = filterVariant(raw, { allowSingle: new Set(["today", "yesterday"]), term: termL });
      if (!k) continue;
      if (k === keyOf(d[1]) || keyOf(d[1]).split(" ").every((t) => k.split(" ").includes(t))) { drop("already contains the canonical word"); continue; }
      if (respell.has(k)) { if (respell.get(k).canon[0] === d[1]) drop("duplicate phrase (same concept)"); else conflicts.add(k); continue; }
      respell.set(k, { canon: [d[1], null], cls: "date", src: e.group });
    }
    continue;
  }
  // ---- respell rules
  const rule = matchRule(RESPELL_RULES, e);
  if (rule) {
    if (rule.allow && !rule.allow.includes(termL)) { dropAll("term not curated for this concept", terms.length); continue; }
    if (rule.deny?.includes(termL)) { dropAll("term denied (different document or direction)", terms.length); continue; }
    const canonKeys = new Set(tokensOf(rule.canon[0]).map(singularToken));
    for (const raw of terms) {
      if (rule.denyVariant?.test(tokensOf(raw).join(" "))) { drop("variant denied (direction/qualifier)"); continue; }
      const k = filterVariant(raw, { allowSingle: SINGLE_ALLOW, term: termL });
      if (!k) continue;
      if (rule.only && !rule.only.test(tokensOf(raw).join(" "))) { drop("variant does not name the concept (curated pattern)"); continue; }
      const vt = k.split(" ");
      if (vt.length >= canonKeys.size && [...canonKeys].every((c) => vt.includes(c))) { drop("already contains the canonical word"); continue; }
      if (k === keyOf(rule.canon[0])) { drop("already the canonical word"); continue; }
      if (KNOWN.has(k)) { drop("already read by the existing lanes"); continue; }
      const prev = respell.get(k);
      if (prev && prev.canon[0] === rule.canon[0]) { drop("duplicate phrase (same concept)"); continue; }
      if (prev && prev.canon[0] !== rule.canon[0]) { conflicts.add(k); continue; }
      respell.set(k, { canon: rule.canon, cls: rule.cls[0], src: e.group });
    }
    continue;
  }
  // ---- untracked concepts
  const uid = UNTRACKED_BY_MEANS.get(String(e.means));
  if (uid && UNTRACKED_CLASSES.has(e.class)) {
    for (const raw of terms) {
      if (UNTRACKED_DENY_VARIANT.test(tokensOf(raw).join(" "))) { drop("untracked variant overlaps a tracked concept"); continue; }
      const k = filterVariant(raw, { allowSingle: UNTRACKED_SINGLE_ALLOW, term: termL });
      if (!k) continue;
      if (!UNTRACKED_GROUPS[uid].only.test(tokensOf(raw).join(" "))) { drop("variant does not name the concept (curated pattern)"); continue; }
      if (k.length < 4 && !UNTRACKED_SINGLE_ALLOW.has(k)) { drop("untracked: too short"); continue; }
      if (KNOWN.has(k)) { drop("already read by the existing lanes"); continue; }
      const prev = untracked.get(k);
      if (prev === uid) { drop("duplicate phrase (same concept)"); continue; }
      if (prev && prev !== uid) { untrackedConflict.add(k); continue; }
      untracked.set(k, uid);
    }
    continue;
  }
  dropAll(newConceptIds.has(String(e.means)) ? "no tracked concept and not curated as untracked" : `means "${e.class}" not actionable`, terms.length);
}
for (const m of MANUAL_RESPELL) for (const v of m.variants) { variantsSeen++; respell.set(keyOf(v), { canon: m.canon, cls: "manual", src: "manual" }); }
for (const [id, phrases] of Object.entries(MANUAL_UNTRACKED)) for (const v of phrases) { const k = keyOf(v); if (!untracked.has(k) && !respell.has(k)) untracked.set(k, id); }
// phrases two concepts claim, or that an untracked and respell rule both claim, are never mapped
for (const k of conflicts) { respell.delete(k); drop("conflict: two concepts claim the phrase"); }
for (const k of untrackedConflict) { untracked.delete(k); drop("conflict: two concepts claim the phrase"); }
for (const k of [...untracked.keys()]) if (respell.has(k)) { untracked.delete(k); respell.delete(k); drop("conflict: tracked and untracked"); }

// R3 B1 generic families win over the research (they are written on purpose); a phrase also listed as untracked is a conflict and is dropped from untracked
const pluralOnlyKeys = new Set();
for (const fam of GENERIC_FAMILIES) for (const v of fam.variants) {
  const k = keyOf(v);
  variantsSeen++;
  respell.set(k, { canon: fam.canon, cls: "generic", src: "generic" });
  untracked.delete(k);
  if (fam.pluralOnly) pluralOnlyKeys.add(k);
}

// validate date canons against the real parser
const TODAY = "2026-10-07";
const badDate = new Set();
for (const [, c] of respell) if (c.cls === "date" && !parsePeriod(c.canon[0], TODAY)) badDate.add(c.canon[0]);
for (const [k, c] of [...respell]) if (c.cls === "date" && badDate.has(c.canon[0])) { respell.delete(k); drop("date phrase: canonical form not parsed by the date parser"); }

/* ---------------------------------------------------------------- write */
const byCanon = {};
const plural = {};
for (const [k, c] of respell) { (byCanon[c.canon[0]] ??= []).push(k); if (c.canon[1]) plural[c.canon[0]] = c.canon[1]; }
const dateCanon = {};
for (const [k, c] of respell) if (c.cls === "date") dateCanon[k] = c.canon[0];
const sortObj = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, Array.isArray(o[k]) ? [...o[k]].sort() : o[k]]));
const untrackedBy = {};
for (const [k, id] of untracked) (untrackedBy[id] ??= []).push(k);
const totalTerms = entries.reduce((n, e) => n + 1 + (e.variants ?? []).length, 0);
const stats = {
  entries: entries.length, terms: totalTerms, kept: respell.size + untracked.size,
  respellKeys: respell.size, untrackedKeys: untracked.size,
  ambiguousTerms: ambiguousKeys.size,
  dropped: sortObj(dropped),
};
const body =
  `/**\n * GENERATED by scripts/build-lexicon.mjs from scripts/data/jargon/*.json. Do not edit by hand; run \`node scripts/build-lexicon.mjs\`.\n` +
  ` * RESPELL: canonical word -> normalised phrases people use for it (last word singular). UNTRACKED: concept id -> phrases for things DeepWell does not record.\n` +
  ` * AMBIGUOUS: terms the research marked ambiguous; they are never mapped automatically. Sources are general knowledge, not verified.\n */\n` +
  `export const JARGON_STATS = ${JSON.stringify(stats)};\n` +
  `export const RESPELL = ${JSON.stringify(sortObj(byCanon))};\n` +
  `export const DATE_CANON = ${JSON.stringify([...new Set([...respell.values()].filter((c) => c.cls === "date").map((c) => c.canon[0]))].sort())};\n` +
  `export const CANON_PLURAL = ${JSON.stringify(sortObj(plural))};\n` +
  `export const UNTRACKED = ${JSON.stringify(sortObj(untrackedBy))};\n` +
  `export const AMBIGUOUS = ${JSON.stringify([...ambiguousKeys].sort())};\n` +
  `export const GENERIC_OVERRIDE = ${JSON.stringify([...respell.entries()].filter(([, c]) => c.cls === "generic").map(([k]) => k).filter((k) => ambiguousKeys.has(k)).sort())};\n` +
  `export const PLURAL_ONLY = ${JSON.stringify([...pluralOnlyKeys].sort())};\n` +
  `export const HOLD = ${JSON.stringify(GENERIC_HOLD)};\n` +
  `export const HOLD_NEAR = ${JSON.stringify(GENERIC_HOLD_NEAR)};\n` +
  `export const GENERIC_KEYS = ${JSON.stringify([...respell.entries()].filter(([, c]) => c.cls === "generic").map(([k]) => k).sort())};\n`;

if (process.argv.includes("--check")) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  if (cur !== body) { console.error("jargon.generated.js is out of date: run node scripts/build-lexicon.mjs"); process.exit(1); }
  console.log("jargon.generated.js is up to date");
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, body);
  console.log(`entries ${entries.length}, terms+variants ${totalTerms}`);
  console.log(`kept: respell ${respell.size} phrases -> ${Object.keys(byCanon).length} canonical words; untracked ${untracked.size} phrases -> ${Object.keys(untrackedBy).length} concepts`);
  console.log(`known-but-not-tracked concepts: ${Object.keys(untrackedBy).join(", ")}`);
  console.log(`ambiguous terms held out of mapping: ${ambiguousKeys.size}`);
  const tot = Object.values(dropped).reduce((a, b) => a + b, 0);
  console.log(`dropped ${tot}:`);
  for (const [r, n] of Object.entries(sortObj(dropped)).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${r}`);
}
