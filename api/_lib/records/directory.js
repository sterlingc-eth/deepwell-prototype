/**
 * RECORDS-FIRST field directory: the ONE list of every fact Donovan stores, and the everyday words people use for it.
 *
 * Every entry says where the fact lives (table + column / extraction field_key), what kind of value it is (money, date, text, number, name),
 * what it belongs to (customer, document, unit, line), and the words people ask with. The look-up lane (lane.js) is driven ONLY by this list:
 * a new fact is added here, not as a new special case in ask.js. directoryCoverage() is what the tests call so a new extraction field_key,
 * a new financials column or a new entity data key cannot be silently unanswerable: it must have an entry here, be an alias of one, or be listed
 * in NOT_ASKABLE with a reason.
 *
 * source: 'extraction' (extractions.field_key, corrections applied), 'financials' (document_financials column), 'lines' (document_financial_lines),
 *         'customer' (entities.data of a customer), 'unit' (entities.data of an equipment unit), 'derived' (computed from stored rows only).
 */
export const KINDS = Object.freeze(["money", "date", "text", "number", "name"]);
export const BELONGS = Object.freeze(["customer", "document", "unit", "line"]);

/** "the guy who handled it", "tech that fixed it", "who took care of it": a person-word + a doing-word, generated so the list stays short and complete */
const PERSON_WORDS = ["guy", "guys", "tech", "techs", "technician", "technicians", "person", "man", "one", "crew", "team", "fella", "fellow", "people", "men", "employee", "worker", "workers", "staff member"];
const DOING_WORDS = ["handled", "ran", "worked", "fixed", "serviced", "repaired", "went out", "came out", "was on", "was out", "was there", "responded", "showed up", "took care of", "did the work", "did the job", "did that", "did it", "did this", "performed", "attended", "covered", "did the service", "did the repair", "was assigned", "got assigned", "was sent", "got sent", "did the call", "took the call", "did the visit"];
const TECH_PHRASES = [...PERSON_WORDS.flatMap((n) => DOING_WORDS.flatMap((v) => [`${n} who ${v}`, `${n} that ${v}`])), ...DOING_WORDS.map((v) => `who ${v}`)];

const E = (id, label, source, key, kind, belongs, words, extra = {}) => Object.freeze({ id, label, source, key, kind, belongs, words: Object.freeze(words), ...extra });

export const FACTS = Object.freeze([
  // ---- what was done, by whom, when (extractions) ----
  E("work_performed", "Work performed", "extraction", "work_performed", "text", "document", ["work performed", "work done", "what work", "what did we do", "what did you do", "what we did", "what was done", "what was performed", "what happened", "what they did", "services performed", "service performed", "job done", "work on", "work",
    "what did we fix", "what we fixed", "what was fixed", "what did they fix", "what did we repair", "what we repaired", "what was repaired", "what did we replace", "what we replaced", "what was replaced", "what repairs", "repairs", "what did we work on", "what did the tech do", "what did the technician do", "what did he do", "what did she do", "what did they do", "what was done to", "what got done", "what got fixed", "what got replaced", "what was the repair"], { multi: true }),
  E("technician", "Technician", "extraction", "technician", "name", "document", ["technician", "technicians", "tech", "techs", "who worked on", "who did the job", "who did the work", "who serviced", "who was the tech", "who went out", "who performed", "who handled", "who fixed", "who came out", "worked on it", "assigned to",
    "who did that one", "who did that", "who did it", "who did this", "who did those", "who ran", "who ran it", "who took care of", "who was on it", "who was on that", "who was on", "who was out", "who was there", "who showed up", "who responded", "who went", "who worked", "who worked at", "worked at", "worked on", "which tech", "which technician", "which techs", "which guy", "which guys", "which of our guys", "which of the guys", "which of our techs", "which of our technicians", "which of the techs", "crew member", "crew members", "team member", "team members", "who from the crew", "who from our crew", "who from our team", "who on the crew", "who on the team", "what tech", "what technician", "name of the guy", "name of the tech", "name of the technician", "name of tech", "tech name", "technician name", "tech who", "technician who", "the guy who", "guy who", "guys who", "the guy", "the guys", "our guys", "guys", "guy", "crew", "who was the guy", "who was the person", "who was responsible", ...TECH_PHRASES]),
  E("service_date", "Service date", "extraction", "service_date", "date", "document", ["service date", "date of service", "date of the service", "when was it serviced", "when did we service", "when was the service", "serviced on", "visit date", "date of the visit", "when did we visit", "when was the visit", "when was the last visit"]),
  E("service_type", "Service type", "extraction", "service_type", "text", "document", ["service type", "type of service", "visit type", "type of visit", "kind of service", "kind of visit", "type of job", "job type", "what kind of visit", "what kind of service"]),
  E("labor_hours", "Labor hours", "extraction", "labor_hours", "number", "document", ["labor hours", "hours of labor", "labor time", "how many hours", "hours", "hrs", "time spent", "man hours", "labor hrs", "duration", "how much time", "time on the job", "hours spent", "time we spent", "hours we spent", "hours we put", "length of the job", "length of the visit", "how many man hours"]),
  E("notes", "Notes", "extraction", "notes", "text", "document", ["notes", "note", "comments", "comment", "remarks", "observations", "technician notes"]),
  E("job_status", "Job status", "extraction", "status", "text", "document", ["job status", "work status", "ticket status", "visit status", "permit status", "was it completed", "was it finished", "status of the job", "status of the work", "status of the visit", "status of the ticket", "status of the permit"]),
  E("permit_number", "Permit number", "extraction", "permit_number", "text", "document", ["permit number", "permit no", "permit #", "permit"]),
  E("agreement_term", "Agreement term", "extraction", "agreement_term", "text", "document", ["agreement term", "contract term", "agreement period", "agreement dates", "maintenance agreement term", "term of the agreement", "how long is the agreement", "agreement"]),
  E("part_number", "Part numbers", "extraction", "part_number", "text", "document", ["part number", "part numbers", "part no", "part #", "parts numbers"], { multi: true }),
  E("equipment_id", "Unit ID", "extraction", "equipment_id", "text", "unit", ["unit id", "equipment id", "unit number", "asset id", "asset number"]),
  // ---- unit facts (equipment record first, extraction as fallback) ----
  E("manufacturer", "Manufacturer", "unit", "manufacturer", "text", "unit", ["manufacturer", "make", "brand", "who makes", "made by", "who manufactures"], { alsoExtraction: "manufacturer" }),
  E("model", "Model", "unit", "model", "text", "unit", ["model number", "model no", "model #", "model"], { alsoExtraction: "model" }),
  E("serial_number", "Serial number", "unit", "serial_number", "text", "unit", ["serial number", "serial no", "serial #", "serial", "seriel", "s/n", "sn"], { alsoExtraction: "serial_number" }),
  E("equipment_type", "Equipment type", "unit", "equipment_type", "text", "unit", ["equipment type", "type of equipment", "type of unit", "kind of unit", "kind of equipment", "what type of unit"], { alsoExtraction: "equipment_type" }),
  E("tonnage", "Tonnage", "unit", "tonnage", "text", "unit", ["tonnage", "tonage", "capacity", "how many tons", "tons", "size of the unit", "btu"], { alsoExtraction: "tonnage" }),
  E("refrigerant", "Refrigerant", "unit", "refrigerant", "text", "unit", ["refrigerant", "refridgerant", "refrigerent", "refrigeration type", "freon", "coolant"], { alsoExtraction: "refrigerant" }),
  E("installation_date", "Installation date", "unit", "installation_date", "date", "unit", ["installation date", "install date", "date installed", "when was it installed", "when installed", "when was it put in", "installed on", "installed", "install", "installation"], { alsoExtraction: "installation_date" }),
  E("warranty_registered_date", "Warranty registered", "unit", "warranty_registered_date", "date", "unit", ["warranty registration", "warranty registered", "registered date", "registration date", "when was the warranty registered", "warrenty registered"], { alsoExtraction: "warranty_registered_date", elsewhere: true }),
  E("warranty_term", "Warranty term", "extraction", "warranty_term", "text", "unit", ["warranty term", "warranty length", "how long is the warranty", "warranty terms", "warrenty term"], { elsewhere: true }),
  E("warranty_expires", "Warranty expiry as printed", "extraction", "warranty_expires", "date", "unit", ["warranty expiry", "warranty expires", "warranty expire", "when does the warranty expire", "when does the warranty end", "when does it expire", "warranty end", "expiration", "expires"], { elsewhere: true }),
  // computed or never stored: this lane steps aside so the older lanes (which compute warranty status from dates and rules) answer exactly as before
  E("warranty_status", "Warranty status", "derived", "warranty", "text", "unit", ["warranty status", "warrenty status", "is it under warranty", "under warranty", "still under warranty", "in warranty", "is the warranty active", "is the warranty still good", "warranty active", "warranty good", "warranty expired", "covered under warranty", "is it covered", "warranty coverage status"], { elsewhere: true }),
  E("installer", "Installed by", "none", "installed_by", "name", "unit", ["who installed", "who installed the", "installed by", "installed at", "installed for", "who put in", "who put it in", "who did the install", "who did the installation", "installer"], { elsewhere: true }),
  E("equipment_list", "Equipment on file", "derived", "equipment", "text", "customer", ["equipment", "units", "systems", "hvac", "what do they have", "what is installed", "installed equipment", "equipment on file", "what unit", "which unit", "what system", "what units"]),
  // ---- customer facts (the customer record) ----
  E("customer_address", "Service address", "customer", "service_address", "text", "customer", ["service address", "address", "where do they live", "where is the unit", "where does", "location", "street"]),
  E("customer_phone", "Phone", "customer", "phone", "text", "customer", ["phone number", "phone", "telephone", "cell number", "cell", "number to call", "contact number"], { alsoExtraction: "customer_phone" }),
  E("customer_email", "Email", "customer", "email", "text", "customer", ["email address", "e-mail", "email", "emailed", "email on file"], { alsoExtraction: "customer_email" }),
  E("customer_number", "Customer number", "customer", "customer_number", "text", "customer", ["customer number", "account number", "customer id", "account no", "customer #"]),
  E("customer_name", "Customer", "financials", "customer_name", "name", "document", ["customer", "customer name", "who is", "whos", "who is the", "who is this", "who is that", "who did we bill", "who did we invoice", "who did we charge", "who did we sell", "who we billed", "who we invoiced", "who we charged", "who is it for", "who was it for", "who was it billed to", "billed to", "bill to", "whose invoice", "who is the customer", "who was the customer", "whose", "who owns", "who owns the", "belong to", "belongs to", "owner", "name"]),
  // ---- money documents (document_financials) ----
  E("invoice_number", "Document number", "financials", "invoice_number", "text", "document", ["invoice number", "invoice no", "invoice #", "ticket number", "work order number", "wo number", "document number", "what number", "number of the invoice"], { alsoExtraction: "invoice_number" }),
  E("invoice_date", "Invoice date", "financials", "invoice_date", "date", "document", ["invoice date", "date of the invoice", "date on the invoice", "when was it invoiced", "invoiced on", "when was it billed", "invoice dated", "when was the invoice"], { alsoExtraction: "invoice_date" }),
  E("po_number", "PO number", "financials", "po_number", "text", "document", ["po number", "po #", "po no", "purchase order number", "purchase order"], { alsoExtraction: "po_number" }),
  E("vendor_name", "Vendor", "financials", "vendor_name", "name", "document", ["vendor", "supplier", "vendor name", "who is it from", "ordered from", "bought from"], { alsoExtraction: "vendor_name" }),
  E("subtotal", "Subtotal", "financials", "subtotal", "money", "document", ["subtotal", "sub total", "sub-total", "before tax", "pre tax"]),
  E("tax", "Tax", "financials", "tax", "money", "document", ["sales tax", "tax"]),
  E("total", "Total", "financials", "total", "money", "document", ["invoice total", "grand total", "total", "how much was", "how much is", "how much did", "how much", "what did it cost", "what was the cost", "the cost", "cost", "price", "amount", "charge", "charged", "bill"], { alsoExtraction: "cost" }),
  E("balance_due", "Balance due", "financials", "balance_due", "money", "document", ["balance due", "balance", "amount due", "owe", "owed", "outstanding", "remaining balance"]),
  E("amount_paid", "Amount paid", "financials", "amount_paid", "money", "document", ["amount paid", "paid amount", "payments", "payment received", "how much was paid"]),
  E("payment_status", "Payment status", "financials", "status", "text", "document", ["payment status", "paid", "unpaid", "is it paid", "has it been paid", "was it paid"]),
  E("due_date", "Due date", "financials", "due_date", "date", "document", ["due date", "when is it due", "when was it due", "due"]),
  E("doc_kind", "Document kind", "financials", "doc_kind", "text", "document", ["document type", "type of document", "what kind of document", "kind of document", "what kind of invoice"]),
  E("direction", "Receivable or payable", "financials", "direction", "text", "document", ["receivable", "payable"]),
  E("agreement_term_fin", "Agreement term (money record)", "financials", "agreement_term", "text", "document", ["agreement term on the invoice"], { hidden: true }),
  // ---- line items (document_financial_lines) ----
  E("line_items", "Line items", "lines", "description", "text", "line", ["line items", "line item", "items", "itemized", "what was on it", "what was on the invoice", "what was on the bill", "breakdown", "parts used", "parts", "materials", "charges", "what was charged for", "invoice lines", "itemization"], { multi: true }),
  E("line_qty", "Quantities", "lines", "qty", "number", "line", ["quantity", "quantities", "qty"], { viewOf: "line_items" }),
  E("line_unit_price", "Unit prices", "lines", "unit_price", "money", "line", ["unit price", "unit prices", "price each", "rate"], { viewOf: "line_items" }),
  E("line_amount", "Line amounts", "lines", "amount", "money", "line", ["line amount", "line amounts"], { viewOf: "line_items" }),
  E("line_category", "Line categories", "lines", "category_guess", "text", "line", ["line category", "category"], { viewOf: "line_items" }),
  E("labor_charge", "Labor charge", "derived", "labor", "money", "line", ["labor charge", "labor charges", "labor cost", "labor amount", "labor fee", "labor price", "labor dollars", "cost of labor", "charge for labor", "charged for labor", "labour charge", "labour cost", "labor"], { derivedFrom: "lines" }),
  E("parts_charge", "Parts charge", "derived", "parts", "money", "line", ["parts charge", "parts cost", "parts amount", "cost of parts", "charge for parts", "parts total"], { derivedFrom: "lines" }),
]);

/** Field keys the model can store that are deliberately not customer-subject look-ups (with the reason). Every key must be in FACTS (as key or alsoExtraction), an ALIAS, or here. */
export const NOT_ASKABLE = Object.freeze({
  shop_address: "the contractor's own letterhead address, not about a customer",
  shop_phone: "the contractor's own letterhead phone, not about a customer",
  shop_email: "the contractor's own letterhead email, not about a customer",
  reminder_text: "a staff reminder; the reminders lane owns it",
  reminder_customer_name: "a staff reminder; the reminders lane owns it",
  reminder_trigger: "a staff reminder; the reminders lane owns it",
});
/** extraction keys stored under another name in the directory */
export const ALIASES = Object.freeze({ vendor: "vendor_name", cost: "total", service_address: "customer_address", customer_name: "customer_name", customer_phone: "customer_phone", customer_email: "customer_email" });

/** columns of document_financials / lines / entity data that are plumbing, not facts a person asks for */
export const NOT_A_FACT = Object.freeze(new Set([
  "id", "tenant_id", "document_id", "financial_id", "created_at", "updated_at", "extracted_at", "currency", "period_start", "period_end", "confidence", "flags", "evidence", "corrections",
  "corrected_by", "corrected_at", "verified_by", "verified_at", "model", "job_key", "job_key_source", "job_confidence", "job_raw", "line_no", "page_no", "merged_into", "customer_id", "entity_type",
  "warranty", "service_address_source", "created_by", "updated_by",
]));

/**
 * Everyday paraphrases rewritten (on the lower-cased, de-punctuated question) into words the directory knows. Every replacement target is checked by the tests
 * to contain a directory phrase, so a paraphrase can never point at a fact that does not exist. Kept as data, not as code in the lane.
 */
export const PARAPHRASES = Object.freeze([
  // "last time we were at X" / "the last time we went to X" -> "last visit at X"
  [/\b(?:the |our )?(?:last|latest|most recent|previous) time\b(?: that)?(?: we| i)?(?: were| was| went| got| came| came out| drove)?(?: out)?(?: at| to| over at)?\b/g, "last visit at"],
  [/\bwhen we (?:were|went|got|came)(?: out)?(?: at| to| over at)\b/g, "at"],
  // "how long did it take", "how long were we there": the labor hours on the record (only when the sentence is about the time a job took)
  [/\bhow long\b(?!\s+(?:is|are|was|were|does|do|has|have)\s+(?:the |an? |their |his |her )?(?:agreement|warranty|contract|term|coverage))(?=[^?]*\b(?:take|took|taking|spend|spent|spending|work|worked|working|need|needed|required?|run|ran|there|stay|stayed|job|visit|call|ticket|[a-z]{1,4}-\d{3,}|(?:invoice|inv|wo|po)\s*#?\d{3,})\b)/g, "labor hours"],
  // "WO-40005 how long": a document number earlier in the sentence makes "how long" the time the job took
  [/(?<=(?:\b[a-z]{1,4}-\d{3,}|\b(?:invoice|inv|wo|po)\s*#?\d{3,})[^?]*)\bhow long\b(?!\s+(?:is|are|was|were|does|do|has|have)\s+(?:the |an? |their |his |her )?(?:agreement|warranty|contract|term|coverage))/g, "labor hours"],
  // a closing "how long" / "who" about a job, visit, call or invoice ("carol rios last job who", "the invoice for carol rios how long")
  [/(?<=\b(?:job|visit|call|invoice|ticket|service|work)\b[^?]*)\bhow long\s*\??\s*$/g, "labor hours"],
  [/(?<=\b(?:job|visit|call|invoice|ticket|service|work)\b[^?]*)\bwho\s*\??\s*$/g, "who worked on"],
]);
export const PARAPHRASE_FACT_TARGETS = Object.freeze(["labor hours"]); // the replacements that stand for a fact (the others only tidy the sentence); each must be a directory phrase

const byId = new Map(FACTS.map((f) => [f.id, f]));
export const factById = (id) => byId.get(id) ?? null;
export const askableFacts = () => FACTS.filter((f) => !f.hidden);

/** every phrase -> fact id, longest phrase first (so "labor hours" wins over "labor", "payment status" over "status") */
export const PHRASES = (() => {
  const out = [];
  for (const f of FACTS) { if (f.hidden) continue; for (const w of f.words) out.push([w, f.id]); }
  out.sort((a, b) => b[0].length - a[0].length || (a[0] < b[0] ? -1 : 1));
  return Object.freeze(out);
})();

/** does a stored extraction field_key / financials column / entity data key have a directory entry? ({ok, via}) */
export function directoryCoverage(source, key) {
  const base = String(key).replace(/_unconfirmed$/, "");
  if (NOT_ASKABLE[base]) return { ok: true, via: "not-askable", reason: NOT_ASKABLE[base] };
  if (source === "extraction") {
    const f = FACTS.find((x) => (x.source === "extraction" && x.key === base) || x.alsoExtraction === base);
    if (f) return { ok: true, via: f.id };
    if (ALIASES[base] && byId.get(ALIASES[base])) return { ok: true, via: ALIASES[base] };
    return { ok: false };
  }
  if (NOT_A_FACT.has(base)) return { ok: true, via: "plumbing" };
  const f = FACTS.find((x) => x.source === source && x.key === base);
  return f ? { ok: true, via: f.id } : { ok: false };
}
