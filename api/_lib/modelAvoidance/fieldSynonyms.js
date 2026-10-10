/**
 * ONE field-label synonym table (F1, 2026-10-10): the same meaning written in different words.
 *
 * WHY: "the information is there but it is stated differently and Donovan is unable to understand it". A donation
 * receipt prints "RECEIVED FROM Martin Duarte / Date Received: Aug 29, 2025 / Amount Received $500.00 / Receipt #
 * R-2025-1009" and was flagged as missing its customer, date and cost, because the label dictionaries and the model
 * prompt only knew service-trade wording ("Bill To", "Date of Service", "Total Due").
 *
 * This table is the single source for BOTH readers, so they cannot drift apart:
 *   - the deterministic label scanners (textExtract.js scanLabeledValues and labelledExtract.js) build their regexes
 *     from it with labelSrc();
 *   - the model prompt (extractFields.js) prints it with synonymGuide().
 *
 * General and multi-industry on purpose (retail, nonprofit, property, legal, insurance, trades). A synonym is added only
 * when the label unambiguously names that role; a generic word that would also head a line-item column ("amount",
 * "item") is NOT here. Adding a label never loosens the safety rules the scanners apply to the value (a date must parse,
 * a name must look like a name, two different values mean "ambiguous, leave it").
 *
 * Pure data + two tiny helpers. No imports (extractFields.js, textExtract.js and labelledExtract.js all import this).
 */

/** Label phrases, lower case, per role. Spaces match any run of whitespace; "#" matches "#", "no", "no.", "number". */
export const FIELD_SYNONYMS = {
  /** The other party we dealt with: who paid us, who was billed, who bought, who donated, who rents. */
  customer: [
    "bill to", "billed to", "sold to", "invoice to", "bill-to", "customer", "customer name", "client", "client name",
    "account name", "account holder", "homeowner", "property owner",
    "received from", "payment received from", "payer", "paid by", "remitted by", "received by payer",
    "donor", "donor name", "contributor", "tenant", "tenant name", "resident", "resident name", "lessee", "renter",
    "patron", "member", "member name", "purchaser", "buyer", "patient", "patient name", "student", "student name",
    "employee", "employee name", "candidate", "candidate name", "receiving party", "party b", "second party",
  ],
  /** Delivery destinations (a delivery ticket's customer). */
  customerDelivery: ["ship to", "shipped to", "deliver to", "delivered to", "consignee", "recipient"],
  /** The business that issued the paper or that was paid / sold the goods and services. */
  vendor: [
    "vendor", "vendor name", "supplier", "supplier name", "distributor", "ordered from", "purchased from", "bought from",
    "sold by", "seller", "merchant", "store", "store name", "payee", "pay to", "payable to", "remit to", "remittance to",
    "issued by", "billed by", "landlord", "lessor", "provider", "service provider", "law firm", "firm", "attorney",
    "insurance company", "insurer", "disclosing party", "party a", "first party",
  ],
  /** Weak vendor labels: fine in the validated-label extractor (it checks the whole page), too loose for the fill scan. */
  vendorWeak: ["from"],
  /** A certificate of insurance: the entity the policy covers is the supplier whose cover we hold. */
  insured: ["insured", "insured name", "named insured", "name of insured"],
  /** The day the work was performed (an explicit service date). */
  serviceDate: [
    "date of service", "service date", "date serviced", "serviced on", "service performed on", "service performed",
    "svc date", "serv date", "srv date", "service dt", "dos", "visit date", "date of visit", "date performed",
    "performed on", "work date", "date of work", "job date", "date completed", "completed on", "completion date", "completed",
    "inspection date", "date of inspection", "inspected on", "start-up date", "startup date", "commissioning date", "commissioned on",
  ],
  /** The date the DOCUMENT is about when no service date is printed (a receipt, invoice, statement ...). */
  invoiceDate: ["invoice date", "billing date", "bill date", "date issued", "issue date", "date of issue", "credit date", "credit memo date"],
  receiptDate: [
    "receipt date", "transaction date", "date of transaction", "purchase date", "date of purchase", "payment date",
    "date of payment", "date paid", "paid on", "paid date", "sale date", "date of sale", "date received", "received on",
    "received date", "date of receipt", "donation date", "date of donation", "gift date", "date of gift", "order placed",
  ],
  poDate: ["po date", "p.o. date", "order date", "purchase order date", "date ordered"],
  statementDate: ["statement date", "as of", "statement period ending", "period ending"],
  deliveryDate: [
    "delivery date", "date of delivery", "date delivered", "pick-up date", "pickup date", "date of pick-up", "date of pickup",
    "date picked up",
  ],
  /** Only a delivery ticket's own date; on any other paperwork a ship date is NOT the document date. */
  shipDate: ["ship date", "shipped date", "shipping date", "date shipped"],
  agreementDate: ["agreement date", "date of agreement", "effective date", "effective", "lease date", "contract date", "date signed", "signed on", "execution date", "commencement date", "start date", "lease start", "lease commencement"],
  quoteDate: ["quote date", "estimate date", "proposal date"],
  letterDate: ["letter date", "date of letter", "offer date"],
  certificateDate: ["certificate date", "date of certificate", "date of issue"],
  /** The document total, in dollars. A label that names a paid/received amount counts: it is the document's amount. */
  cost: [
    "grand total", "invoice total", "order total", "total due", "amount due", "balance due", "net due", "total amount due",
    "please pay", "total amount", "total owed", "amount owed", "total payable", "total charges", "total charge", "total",
    "total fees", "total fee", "fee total", "amount charged", "total billed", "credit total", "total credit",
  ],
  /** The amount actually paid / received / donated. The document's amount when no total is printed; a total outranks it. */
  costPaid: [
    "amount received", "total received", "payment received", "amount paid", "total paid", "payment amount", "amount of payment",
    "donation amount", "amount of donation", "donation", "gift amount", "contribution amount", "contribution", "rent paid",
    "rent received", "amount tendered",
  ],
  /** A document number: receipt, invoice, ticket, reference. */
  documentNumber: [
    "receipt #", "receipt number", "receipt no", "invoice #", "invoice number", "invoice no", "inv #", "inv no",
    "ticket #", "ticket number", "ticket no", "pickup ticket", "pick-up ticket", "reference #", "reference number", "ref #", "ref no",
    "confirmation #", "confirmation number", "transaction #", "transaction id", "order #", "order number", "order no",
    "statement #", "document #", "document number", "bill #", "bill number", "check #", "check number",
  ],
  /** Start / end of an agreement, lease or policy. */
  termStart: ["effective date", "effective", "start date", "commencement date", "lease start", "policy effective date", "policy effective", "policy start", "term begins"],
  termEnd: [
    "end date", "expiration date", "expiry date", "termination date", "expires", "expiration", "expiry", "lease end", "lease expires",
    "policy expiration date", "policy expiration", "policy expiry", "policy expires", "policy end date", "term ends",
  ],
  /** A stated term / period (free text): "12 months", "01/01/2025 - 12/31/2025". */
  term: [
    "agreement term", "agreement period", "lease term", "lease period", "rental term", "rental period", "contract term",
    "contract period", "term of agreement", "term of the agreement", "term of lease", "term of the lease", "coverage period",
    "policy period", "policy term", "term",
  ],
  /** Where a policy ends: used for the insurance expiry field. */
  policyExpiry: ["policy expiration date", "policy expiration", "policy expiry", "policy expires", "policy end date", "expiration date", "expires", "expiry date"],
  /** The two sides of an agreement printed as a single line: "Parties: A and B", "Between A and B". */
  parties: ["parties", "between", "by and between", "agreement between", "agreement is between", "contract between"],
  /** Labels the old scanner threw away that are in fact amounts or dates of the document. NOT ignorable. */
  notIgnorable: ["amount paid", "invoice date", "order date", "deposit"],
};

// BEGIN GENERATED LABELS (scripts/build-field-labels.mjs)
// Generated 5 research files, 277 field/document_label entries. Do not edit by hand: re-run the script.
const GENERATED_LABELS = {
  cost: ["pay this amount","due now","job total","legal fees","please remit","repair total","ticket total","amount payable","invoice amount","amount invoiced","professional fees","total professional fees"],
  costPaid: ["gift total","paid amount","amount donated","amount of gift"],
  customer: ["billing name","name of donor","contributor name"],
  documentNumber: ["doc #","cm #","cn #","ro #","cm no","cn no","req #","rma #","tkt #","txn #","conf #","doc no","draw #","rcpt #","req no","rma no","sale #","slip #","stmt #","txn id","award #","bill no","claim #","draw no","gift id","inv no.","our ref","rcpt no","sale no","slip no","stmt no","trans #","award no","claim id","claim no","refund #","return #","your ref","pay app #","return no","delivery #","invoice id","pay app no","receipt id","rma number","delivery no","document no","donation id","draw number","gift number","invoice no.","invoice num","pack slip #","sale number","claim number","debit memo #","reference no","statement no","application #","credit memo #","credit note #","debit memo no","refund number","requisition #","application no","credit memo no","credit note no","packing slip #","pay app number","transaction no","delivery number","packing slip no","sales receipt #","delivery note no","statement number","confirmation code","work order number","application number","credit memo number","credit note number","requisition number","transaction number"],
  insured: ["first named insured"],
  invoiceDate: ["pay app date","application date","date of application"],
  receiptDate: ["contribution date"],
  serviceDate: ["date svc","encounter date","treatment date","date of procedure"],
  term: ["plan term","grant term","plan length","plan period","award period","grant period","lease length","policy dates","rental length","coverage dates","funding period","lease duration","project period","contract length","membership term","rental duration","agreement length","membership length","performance period","period of coverage","length of agreement","period of performance"],
  termEnd: ["coi expires","coi expiration","exp date","term end","lease exp","lease ends","policy end","policy exp","rental end","end of term","policy ends","vacate date","valid until","cert expires","good through","coverage ends","date off rent","move-out date","off hire date","off rent date","off-rent date","valid through","lease end date","coverage expires","insurance expiry","lease expiration","end date of rental","insurance expiration"],
  termStart: ["eff date","policy eff","term start","lease begins","move-in date","on hire date","on rent date","on-rent date","rental start","policy begins","start of term","inception date","occupancy date","coverage begins","possession date","start of rental","lease start date","policy inception","policy start date","rental start date","coverage effective"],
  vendor: ["make checks payable to","check payable to","checks payable to"],
};
/** Per role, generated labels from most to least widely listed in the research (the prompt takes the head of each list). */
export const LABEL_RANK = GENERATED_LABELS;
/** Generated labels that 2+ research entries list: the candidates for the compact model prompt (extractFields.js via synonymGuide). */
export const LABEL_COMMON = {"cost":["pay this amount"],"documentNumber":["doc #"],"termEnd":["coi expires","coi expiration"],"vendor":["make checks payable to"]};
for (const [role, list] of Object.entries(GENERATED_LABELS)) {
  FIELD_SYNONYMS[role] = [...new Set([...(FIELD_SYNONYMS[role] ?? []), ...list])];
}
// END GENERATED LABELS

const ESC = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One phrase -> regex source (no anchors, no colon). "#" accepts #, no, no., number, num. */
export function phraseSrc(phrase) {
  const trimmed = String(phrase).trim().toLowerCase();
  let out = "";
  const parts = trimmed.split(/(\s+|#)/).filter((p) => p !== "");
  for (const p of parts) {
    if (/^\s+$/.test(p)) out += "\\s+";
    else if (p === "#") out += "(?:#|no\\.?|number|num\\.?)";
    else out += ESC(p).replace(/-/g, "[-\\s]?");
  }
  return out;
}

/** Longest phrases first so "customer name" wins over "customer" in an alternation. */
export function labelSrc(...groups) {
  const phrases = [...new Set(groups.flatMap((g) => (Array.isArray(g) ? g : FIELD_SYNONYMS[g] ?? [])))];
  phrases.sort((a, b) => b.length - a.length);
  return phrases.map(phraseSrc).join("|");
}

const title = (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
const quoteList = (arr) => arr.map((x) => `"${title(x)}"`).join(", ");

/**
 * The plain-language block the model prompt carries: which printed labels mean which field. Built from the same table
 * the scanners use. Kept short on purpose: it is part of every extraction call.
 */
/** Up to `n` extra labels for the prompt: generated labels that several research entries list (LABEL_COMMON), skipping
 *  any in `skip`. PO labels never go in the prompt: a PO number is not the number of an invoice that quotes it. */
function extra(role, n, skip = []) {
  return (LABEL_COMMON[role] ?? []).filter((p) => !skip.includes(p) && !/^(p\.?o\.?|purchase order)\b/.test(p)).slice(0, n);
}

export function synonymGuide() {
  return [
    `- customer_name = the other party the paperwork is about, however labelled: ${quoteList(["bill to", "sold to", "received from", "payer", "paid by", "donor", "tenant", "client", "patron", "member", "purchaser", "patient", "student"])}.`,
    `- vendor = the business that issued the paper or was paid / supplied the goods or services: ${quoteList(["vendor", "supplier", "sold by", "seller", "merchant", "store", "payee", "pay to", "remit to", "issued by", "landlord", "provider", "law firm", "insured"])}, or the business name printed as the letterhead at the top of the page (when it is not our own company).`,
    `- service_date = the date the document is about: ${quoteList(["date of service", "invoice date", "date received", "date paid", "payment date", "date of sale", "transaction date", "statement date", "delivery date", "pickup date", "effective date", "issue date"])} (a lone "Date:" counts too). Never a due date, expiry, next-service or printed-on date.`,
    `- cost = the document's amount in dollars, however labelled: ${quoteList(["total", "total due", "amount due", "balance due", "amount received", "amount paid", "total paid", "payment amount", "donation amount", ...extra("cost", 2)])}. Prefer the total over line items, subtotals and tax.`,
    `- invoice_number = any document number: ${quoteList(["receipt #", "invoice #", "ticket #", "reference #", "confirmation #", "transaction id", "order #", ...extra("documentNumber", 2)])}.`,
    `- agreement_term = the agreement, lease or policy period: ${quoteList(["term", "agreement period", "lease term", "policy period", "effective date to end date", ...extra("term", 1), ...extra("termStart", 1)])}; for an agreement, "Parties" / "Between" name the customer_name and vendor.`,
  ].join("\n");
}

/** Plain words for the own-company rule, shared by the prompt and the readers. */
export const OWN_COMPANY_RULE =
  "Our own company is never the customer and never the vendor of a bill addressed to us: when a bill, receipt or agreement is addressed TO our own company, leave customer_name out and put the OTHER business (the one that issued it or was paid) in vendor.";
