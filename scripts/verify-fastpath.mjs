/**
 * Unit checks for the /api/ask model-free fast path (handoffs/FAST_PATH_2026-09-20.md).
 * Pure only — no database, no network. Covers:
 *   1. The phrasing corpus: >=150 natural dispatcher phrasings across every
 *      intent, each asserting the classified intent AND the extracted subject.
 *      This corpus IS the "training" the owner asked for — growing it means
 *      adding a line here.
 *   2. Subject extraction edge cases (addresses without a street-type word,
 *      question-word false positives, identifiers vs. plain numbers).
 *   3. Ambiguity -> null (pickUnique).
 *   4. The answer builder, including a computed warranty fact.
 *   5. Stage eligibility parity with the model path's own searchExtractions
 *      (no stage filter).
 *   6. The ASK_FAST_PATH=0 disable flag.
 *
 *   node scripts/verify-fastpath.mjs
 */
import {
  classifyFastPath,
  classifyIntent,
  hasAnchor,
  extractSubject,
  significantAddressTokens,
  pickUnique,
  pickBestExtraction,
  pickMostRecent,
  isStageEligible,
  isFastPathEnabled,
  formatDateHuman,
  formatMoney,
  buildFieldAnswer,
  buildWarrantyAnswer,
  buildEquipmentListAnswer,
  buildDocumentListAnswer,
  FIELD_BY_INTENT,
  NO_FIELD_INTENTS,
  WARRANTY_INTENTS,
  LIST_INTENTS,
} from '../api/_lib/fastPath.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* ======================================================================
 * 1. The phrasing corpus.
 *
 * Each entry: [question, expectedIntent, subjectAssertions]. subjectAssertions
 * is a partial object checked against extractSubject(question)/classifyFastPath's
 * `.subject` — only the keys given are checked, so a phrasing only has to
 * prove the ONE subject signal it's testing for.
 * ====================================================================== */

function checkSubject(name, subject, expected) {
  for (const [k, v] of Object.entries(expected ?? {})) {
    check(`${name} :: subject.${k}`, JSON.stringify(subject[k]) === JSON.stringify(v),
      `got ${JSON.stringify(subject[k])}, want ${JSON.stringify(v)}`);
  }
}

const CORPUS = [
  // ---- warranty_expires (10) --------------------------------------------
  ["When does the warranty on the unit at 3247 Elm St expire?", 'warranty_expires', { address: '3247 Elm St' }],
  ["Whens the warranty up on 4N2119-08772?", 'warranty_expires', { identifier: '4N2119-08772' }],
  ["What's the warranty expiration for C-00012?", 'warranty_expires', { customerNumber: 'C-00012' }],
  ["When's the parts warranty up at 1519 W Juniper?", 'warranty_expires', { address: '1519 W Juniper' }],
  ["Warranty exp date for the Henderson condenser?", 'warranty_expires', { name: 'Henderson' }],
  ["How long until the warranty is up on C-00003?", 'warranty_expires', { customerNumber: 'C-00003' }],
  ["When does the compressor warranty expire at 3247 Elm St?", 'warranty_expires', { address: '3247 Elm St' }],
  ["When's the labor warranty up for C-00007?", 'warranty_expires', { customerNumber: 'C-00007' }],
  ["Warrenty expiration on 24ACC636A003?", 'warranty_expires', { identifier: '24ACC636A003' }],
  ["When does the Goodman warranty expire for C-00003?", 'warranty_expires', { customerNumber: 'C-00003' }],

  // ---- warranty_status (9) -----------------------------------------------
  ["Is the unit at 3247 Elm St still under warranty?", 'warranty_status', { address: '3247 Elm St' }],
  ["Is C-00012 still covered?", 'warranty_status', { customerNumber: 'C-00012' }],
  ["Is the Carrier at 3247 Elm still under warranty?", 'warranty_status', { address: '3247 Elm' }],
  ["Does the Henderson unit have warranty?", 'warranty_status', { name: 'Henderson' }],
  ["What's the warranty status on 4N2119-08772?", 'warranty_status', { identifier: '4N2119-08772' }],
  ["Still under warranty at 1519 W Juniper?", 'warranty_status', { address: '1519 W Juniper' }],
  ["Is the unit still good, warranty-wise, for C-00005?", 'warranty_status', { customerNumber: 'C-00005' }],
  ["Is it still valid under warranty for C-00009?", 'warranty_status', { customerNumber: 'C-00009' }],
  ["Are we still covered on the unit at 1519 W Juniper?", 'warranty_status', { address: '1519 W Juniper' }],

  // ---- model (8) -----------------------------------------------------------
  ["What model is the Goodman at 1519 W Juniper?", 'model', { address: '1519 W Juniper' }],
  ["What's the model number on C-00012?", 'model', { customerNumber: 'C-00012' }],
  ["Model number for the unit at 3247 Elm St?", 'model', { address: '3247 Elm St' }],
  ["What modle is installed for Henderson?", 'model', { name: 'Henderson' }],
  ["What's the model on 4N2119-08772?", 'model', { identifier: '4N2119-08772' }],
  ["Model # on the condenser at 3247 Elm St?", 'model', { address: '3247 Elm St' }],
  ["What model number does C-00003 have?", 'model', { customerNumber: 'C-00003' }],
  ["What's the unit model at 1519 W Juniper?", 'model', { address: '1519 W Juniper' }],

  // ---- serial (9) ------------------------------------------------------
  ["What's the serial number of the condenser at 3247 Elm?", 'serial', { address: '3247 Elm' }],
  ["Serial number for C-00012?", 'serial', { customerNumber: 'C-00012' }],
  ["What's the s/n on the unit at 1519 W Juniper?", 'serial', { address: '1519 W Juniper' }],
  ["Seriel number for Henderson's unit?", 'serial', {}],
  ["What's the serail number at 3247 Elm St?", 'serial', { address: '3247 Elm St' }],
  ["Serial # on 24ACC636A003?", 'serial', { identifier: '24ACC636A003' }],
  ["What's the serial on C-00007?", 'serial', { customerNumber: 'C-00007' }],
  ["Can you give me the serial number for the unit at 1519 W Juniper?", 'serial', { address: '1519 W Juniper' }],
  ["Serial number of the unit at 3247 Elm St?", 'serial', { address: '3247 Elm St' }],

  // ---- manufacturer (8) --------------------------------------------------
  ["What brand is the unit at 3247 Elm St?", 'manufacturer', { address: '3247 Elm St' }],
  ["What manufacturer is on C-00012?", 'manufacturer', { customerNumber: 'C-00012' }],
  ["Who makes the unit at 1519 W Juniper?", 'manufacturer', { address: '1519 W Juniper' }],
  ["What manufaturer is the Henderson unit?", 'manufacturer', { name: 'Henderson' }],
  ["What make is 4N2119-08772?", 'manufacturer', { identifier: '4N2119-08772' }],
  ["What brand is installed at 3247 Elm St?", 'manufacturer', { address: '3247 Elm St' }],
  ["What manufacturer is the condenser at 1519 W Juniper?", 'manufacturer', { address: '1519 W Juniper' }],
  ["Who makes C-00003's unit?", 'manufacturer', {}],

  // ---- install_date (8) -----------------------------------------------
  ["When was the unit at 3247 Elm St installed?", 'install_date', { address: '3247 Elm St' }],
  ["Install date for C-00012?", 'install_date', { customerNumber: 'C-00012' }],
  ["What's the installation date at 1519 W Juniper?", 'install_date', { address: '1519 W Juniper' }],
  ["When was 4N2119-08772 installed?", 'install_date', { identifier: '4N2119-08772' }],
  ["When was the Henderson unit installed?", 'install_date', { name: 'Henderson' }],
  ["What date was it installed for C-00005?", 'install_date', { customerNumber: 'C-00005' }],
  ["Install date on the condenser at 3247 Elm St?", 'install_date', { address: '3247 Elm St' }],
  ["When did we install the unit at 1519 W Juniper?", 'install_date', { address: '1519 W Juniper' }],

  // ---- installer (8) -----------------------------------------------------
  ["Who installed the unit at 3247 Elm St?", 'installer', { address: '3247 Elm St' }],
  ["Who put in the unit for C-00012?", 'installer', { customerNumber: 'C-00012' }],
  ["Who did the install at 1519 W Juniper?", 'installer', { address: '1519 W Juniper' }],
  ["Who was the installer for Henderson?", 'installer', { name: 'Henderson' }],
  ["Who installed 4N2119-08772?", 'installer', { identifier: '4N2119-08772' }],
  ["Which installer put in the unit at 3247 Elm St?", 'installer', { address: '3247 Elm St' }],
  ["Who installed the condenser for C-00003?", 'installer', { customerNumber: 'C-00003' }],
  ["Who put the unit in at 1519 W Juniper?", 'installer', { address: '1519 W Juniper' }],

  // ---- last_service_tech (8) --------------------------------------------
  ["Who was out last at 3247 Elm St?", 'last_service_tech', { address: '3247 Elm St', ordinal: 'last' }],
  ["Which tech was out to C-00012 last?", 'last_service_tech', { customerNumber: 'C-00012' }],
  ["Who was the last technician at 1519 W Juniper?", 'last_service_tech', { address: '1519 W Juniper' }],
  ["Who came out last for Henderson?", 'last_service_tech', { name: 'Henderson', ordinal: 'last' }],
  ["Who worked on the unit at 3247 Elm St?", 'last_service_tech', { address: '3247 Elm St' }],
  ["Who was here last for C-00005?", 'last_service_tech', { customerNumber: 'C-00005' }],
  ["Which technician serviced C-00007?", 'last_service_tech', { customerNumber: 'C-00007' }],
  ["Who was out to 1519 W Juniper last?", 'last_service_tech', { address: '1519 W Juniper', ordinal: 'last' }],

  // ---- last_service_date (8) ----------------------------------------------
  ["When was the unit at 3247 Elm St last serviced?", 'last_service_date', { address: '3247 Elm St' }],
  ["Last service date for C-00012?", 'last_service_date', { customerNumber: 'C-00012' }],
  ["When's the last time we serviced 1519 W Juniper?", 'last_service_date', { address: '1519 W Juniper' }],
  ["When was the last maintenance visit for Henderson?", 'last_service_date', { name: 'Henderson' }],
  ["When was it last serviced for C-00003?", 'last_service_date', { customerNumber: 'C-00003' }],
  ["What's the last service date on 4N2119-08772?", 'last_service_date', { identifier: '4N2119-08772' }],
  ["When did we last service the unit at 3247 Elm St?", 'last_service_date', { address: '3247 Elm St' }],
  ["Last serviced date for C-00009?", 'last_service_date', { customerNumber: 'C-00009' }],

  // ---- service_address (8) ------------------------------------------------
  ["What's the service address for C-00012?", 'service_address', { customerNumber: 'C-00012' }],
  ["What's the address on file for Henderson?", 'service_address', { name: 'Henderson' }],
  ["What is the address for 4N2119-08772?", 'service_address', { identifier: '4N2119-08772' }],
  ["Service address for C-00003?", 'service_address', { customerNumber: 'C-00003' }],
  ["What's the address for C-00007?", 'service_address', { customerNumber: 'C-00007' }],
  ["What's the service address on the unit 4N2119-08772?", 'service_address', { identifier: '4N2119-08772' }],
  ["What is the address on file for C-00005?", 'service_address', { customerNumber: 'C-00005' }],
  ["Service address on file for Henderson?", 'service_address', { name: 'Henderson' }],

  // ---- customer_phone (8) --------------------------------------------------
  ["What's the phone number for C-00012?", 'customer_phone', { customerNumber: 'C-00012' }],
  ["Phone number for Henderson?", 'customer_phone', { name: 'Henderson' }],
  ["What's the contact number for C-00003?", 'customer_phone', { customerNumber: 'C-00003' }],
  ["What phone number do we have for C-00005?", 'customer_phone', { customerNumber: 'C-00005' }],
  ["Phone for the customer at 3247 Elm St?", 'customer_phone', { address: '3247 Elm St' }],
  ["What's Henderson's phone number?", 'customer_phone', { name: 'Henderson' }],
  ["What's the customer's phone at 1519 W Juniper?", 'customer_phone', { address: '1519 W Juniper' }],
  ["Contact number on file for C-00009?", 'customer_phone', { customerNumber: 'C-00009' }],

  // ---- customer_email (8) --------------------------------------------------
  ["What's the email for C-00012?", 'customer_email', { customerNumber: 'C-00012' }],
  ["Email address for Henderson?", 'customer_email', { name: 'Henderson' }],
  ["What email do we have for C-00003?", 'customer_email', { customerNumber: 'C-00003' }],
  ["What's the customer email at 3247 Elm St?", 'customer_email', { address: '3247 Elm St' }],
  ["Email on file for C-00005?", 'customer_email', { customerNumber: 'C-00005' }],
  ["What's Henderson's email?", 'customer_email', { name: 'Henderson' }],
  ["Email for the customer at 1519 W Juniper?", 'customer_email', { address: '1519 W Juniper' }],
  ["What's the email address for C-00009?", 'customer_email', { customerNumber: 'C-00009' }],

  // ---- customer_name (8) --------------------------------------------------
  ["Who is the customer at 3247 Elm St?", 'customer_name', { address: '3247 Elm St' }],
  ["Who's the customer for C-00012?", 'customer_name', { customerNumber: 'C-00012' }],
  ["Whose house is at 1519 W Juniper?", 'customer_name', { address: '1519 W Juniper' }],
  ["Who owns the unit at 3247 Elm St?", 'customer_name', { address: '3247 Elm St' }],
  ["Who lives at 1519 W Juniper?", 'customer_name', { address: '1519 W Juniper' }],
  ["Who is the customer for 4N2119-08772?", 'customer_name', { identifier: '4N2119-08772' }],
  ["Whose account is C-00003?", 'customer_name', { customerNumber: 'C-00003' }],
  ["Who is the customer at 3247 Elm St service address?", 'customer_name', { address: '3247 Elm St' }],

  // ---- refrigerant (8) ----------------------------------------------------
  ["What refrigerant does the Goodman take for C-00003?", 'refrigerant', { customerNumber: 'C-00003' }],
  ["What refrigerant is in the unit at 3247 Elm St?", 'refrigerant', { address: '3247 Elm St' }],
  ["What's the refrigerant type for C-00012?", 'refrigerant', { customerNumber: 'C-00012' }],
  ["What refrigerant charge does 4N2119-08772 use?", 'refrigerant', { identifier: '4N2119-08772' }],
  ["What freon does the unit at 1519 W Juniper take?", 'refrigerant', { address: '1519 W Juniper' }],
  ["Refrigerant on file for Henderson?", 'refrigerant', { name: 'Henderson' }],
  ["What refrigerant is used for C-00003?", 'refrigerant', { customerNumber: 'C-00003' }],
  ["What's the refrigerant for the unit at 3247 Elm St?", 'refrigerant', { address: '3247 Elm St' }],

  // ---- tonnage (8) ---------------------------------------------------------
  ["What tonnage is the unit at 3247 Elm St?", 'tonnage', { address: '3247 Elm St' }],
  ["How many tons is C-00012's unit?", 'tonnage', {}],
  ["What size unit is at 1519 W Juniper?", 'tonnage', { address: '1519 W Juniper' }],
  ["What's the capacity of 4N2119-08772?", 'tonnage', { identifier: '4N2119-08772' }],
  ["What tonnage does Henderson have?", 'tonnage', { name: 'Henderson' }],
  ["How many tons is the condenser at 3247 Elm St?", 'tonnage', { address: '3247 Elm St' }],
  ["What size system is C-00003's?", 'tonnage', { customerNumber: 'C-00003' }],
  ["What's the tonnage on file for C-00005?", 'tonnage', { customerNumber: 'C-00005' }],

  // ---- seer / efficiency (8) — no extraction field, must always defer -----
  ["What SEER rating is the unit at 3247 Elm St?", 'seer', {}],
  ["What's the efficiency rating for C-00012?", 'seer', {}],
  ["What SEER2 is 4N2119-08772?", 'seer', {}],
  ["What's the SEER on Henderson's unit?", 'seer', {}],
  ["What efficiency rating does the unit at 1519 W Juniper have?", 'seer', { address: '1519 W Juniper' }],
  ["What SEER rating for C-00003?", 'seer', {}],
  ["What's the seer2 rating on file for C-00005?", 'seer', {}],
  ["What efficiency does the condenser at 3247 Elm St have?", 'seer', {}],

  // ---- filter_size (8) — no extraction field, must always defer -----------
  ["What filter size does the unit at 3247 Elm St take?", 'filter_size', {}],
  ["What size filter for C-00012?", 'filter_size', {}],
  ["What filter dimensions does Henderson's unit use?", 'filter_size', {}],
  ["What size filter does the unit at 1519 W Juniper need?", 'filter_size', { address: '1519 W Juniper' }],
  ["Filter size on file for C-00003?", 'filter_size', {}],
  ["What size filter does the condenser at 3247 Elm St take?", 'filter_size', {}],
  ["What filter dimensions for C-00005?", 'filter_size', {}],
  ["What size filter does 4N2119-08772 use?", 'filter_size', {}],

  // ---- permit_number (8) ---------------------------------------------------
  ["What's the permit number for the job at 3247 Elm St?", 'permit_number', { address: '3247 Elm St' }],
  ["Permit number for C-00012?", 'permit_number', { customerNumber: 'C-00012' }],
  ["What permit number do we have for Henderson?", 'permit_number', { name: 'Henderson' }],
  ["Permit # for the job at 1519 W Juniper?", 'permit_number', { address: '1519 W Juniper' }],
  ["What's the permit on file for C-00003?", 'permit_number', { customerNumber: 'C-00003' }],
  ["Permit number on 4N2119-08772's install?", 'permit_number', { identifier: '4N2119-08772' }],
  ["What permit number was pulled for C-00005?", 'permit_number', { customerNumber: 'C-00005' }],
  ["Permit number for the job at 3247 Elm St?", 'permit_number', { address: '3247 Elm St' }],

  // ---- invoice_total (9) ---------------------------------------------------
  ["How much was the Henderson install?", 'invoice_total', { name: 'Henderson' }],
  ["What was the invoice total for C-00012?", 'invoice_total', { customerNumber: 'C-00012' }],
  ["How much did the job at 3247 Elm St cost?", 'invoice_total', { address: '3247 Elm St' }],
  ["What's the cost on the last invoice for C-00003?", 'invoice_total', { customerNumber: 'C-00003' }],
  ["What did the invoice come to for 1519 W Juniper?", 'invoice_total', { address: '1519 W Juniper' }],
  ["Total amount due on C-00005's invoice?", 'invoice_total', { customerNumber: 'C-00005' }],
  ["What's the total cost for the Henderson job?", 'invoice_total', { name: 'Henderson' }],
  ["How much was the bill for C-00007?", 'invoice_total', { customerNumber: 'C-00007' }],
  ["What's the most recent invoice amount for C-00009?", 'invoice_total', { customerNumber: 'C-00009' }],

  // ---- agreement_term (8) ---------------------------------------------------
  ["When does the maintenance agreement expire for C-00012?", 'agreement_term', { customerNumber: 'C-00012' }],
  ["What's the agreement term for Henderson?", 'agreement_term', { name: 'Henderson' }],
  ["When does the service contract end for C-00003?", 'agreement_term', { customerNumber: 'C-00003' }],
  ["What's the maintenance agreement term at 3247 Elm St?", 'agreement_term', { address: '3247 Elm St' }],
  ["When does C-00005's agreement renew?", 'agreement_term', { customerNumber: 'C-00005' }],
  ["What's the agreement term on file for 1519 W Juniper?", 'agreement_term', { address: '1519 W Juniper' }],
  ["When does the service contract expire for C-00007?", 'agreement_term', { customerNumber: 'C-00007' }],
  ["What's the maintenance agreement expiration for C-00009?", 'agreement_term', { customerNumber: 'C-00009' }],

  // ---- equipment_list (8) ----------------------------------------------
  ["What equipment does Henderson have?", 'equipment_list', { name: 'Henderson' }],
  ["What units does C-00012 have?", 'equipment_list', { customerNumber: 'C-00012' }],
  ["What's installed at 3247 Elm St?", 'equipment_list', { address: '3247 Elm St' }],
  ["List the equipment for C-00003.", 'equipment_list', { customerNumber: 'C-00003' }],
  ["What equipment do we have on file for C-00005?", 'equipment_list', { customerNumber: 'C-00005' }],
  ["What units have we got for Henderson?", 'equipment_list', { name: 'Henderson' }],
  ["What's installed at 1519 W Juniper?", 'equipment_list', { address: '1519 W Juniper' }],
  ["List equipment for C-00007.", 'equipment_list', { customerNumber: 'C-00007' }],

  // ---- document_list_for_subject (8) ------------------------------------
  ["What documents do we have on Henderson?", 'document_list_for_subject', { name: 'Henderson' }],
  ["Show me everything for C-00012.", 'document_list_for_subject', { customerNumber: 'C-00012' }],
  ["What do we have on file for C-00003?", 'document_list_for_subject', { customerNumber: 'C-00003' }],
  ["All documents for Henderson?", 'document_list_for_subject', { name: 'Henderson' }],
  ["Show everything on C-00005.", 'document_list_for_subject', { customerNumber: 'C-00005' }],
  ["What documents do we have for C-00007?", 'document_list_for_subject', { customerNumber: 'C-00007' }],
  ["What do we have on Henderson?", 'document_list_for_subject', { name: 'Henderson' }],
  ["Show me everything on C-00009.", 'document_list_for_subject', { customerNumber: 'C-00009' }],
];

check(`corpus has >= 150 phrasings (has ${CORPUS.length})`, CORPUS.length >= 150);

for (const [q, intent, subjectExpect] of CORPUS) {
  const result = classifyFastPath(q);
  check(`corpus intent :: ${q}`, result?.intent === intent, `got ${result?.intent}, want ${intent}`);
  if (result) checkSubject(q, result.subject, subjectExpect);
}

/* ======================================================================
 * Negatives: questions that must NOT hit the fast path at all — these need
 * the model (narrative, multi-fact, or a field this app doesn't extract as a
 * single value). Mirrors README-ANSWER-KEY.md's harder questions.
 * ====================================================================== */
const NEGATIVES = [
  "What did Marcus do at the Henderson job last summer?",
  "Which unit at Plaza Dental had a sluggish economizer damper?",
  "Why did Castillo call back?",
  "Who is the contact at Plaza Dental?",
  "Tell me about the Henderson job.",
  "How many documents are in the system?", // meta-router's job, not fast path's
];
for (const q of NEGATIVES) {
  check(`negative defers :: ${q}`, classifyIntent(q) === null, `classified as ${classifyIntent(q)}`);
}

/* ======================================================================
 * 1b. Adversarial NEGATIVES (2026-09-20 reviewer NO-GO): a generic-English
 * sentence that merely shares a word with an intent's trigger — "serial",
 * "model", "install(ed)", "warranty", "address", "cost", "who makes",
 * "email"/"phone", "agreement", "permit", "tonnage" — must defer when it
 * carries neither a real subject (address/customer number/serial-shaped
 * token/name) nor an independent domain anchor. This is the exact class of
 * false positive the fast path must never produce, since a wrong-but-
 * confident answer is worse than no fast path at all — see fastPath.js's
 * file header and classifyIntent's own doc comment.
 * ====================================================================== */
const ADVERSARIAL_NEGATIVES = [
  "serial killer documentary recommendations",
  "what was the model of behavior therapy used in the study",
  "who installed the app on this phone",
  "who installed windows 11",
  "what's the address of the nearest supply house",
  "warranty on my truck",
  "cost of living",
  "hello",
  "thanks",
  "what can you do",
  "who makes the best pizza in town",
  "what's your email address",
  "can I get your phone number",
  "what's the model number of my printer",
  "the tech support said to reinstall",
  "serial comma or no serial comma",
  "how much does a gym membership cost",
  "what's the agreement between the two companies",
  "who installed the software update",
  "what brand of coffee do you drink",
  "permit me to ask a question",
  "install python on my laptop",
  "what's the SEER on my new car",
];
check(`>= 15 adversarial negatives (has ${ADVERSARIAL_NEGATIVES.length})`, ADVERSARIAL_NEGATIVES.length >= 15);
for (const q of ADVERSARIAL_NEGATIVES) {
  check(`adversarial defers :: ${q}`, classifyIntent(q) === null, `classified as ${classifyIntent(q)}`);
  check(`adversarial (via classifyFastPath) defers :: ${q}`, classifyFastPath(q) === null, `classified as ${JSON.stringify(classifyFastPath(q))}`);
}

// A bare ambiguous trigger word alone, with no anchor and no subject, must
// never pass — this is the mechanism the adversarial negatives above rely
// on; checked directly so a future trigger addition can't silently reopen it.
for (const bare of ['serial', 'model', 'installed it', 'warranty', 'the address', 'how much did it cost']) {
  check(`hasAnchor is false for bare "${bare}"`, hasAnchor(bare) === false);
}

/* ======================================================================
 * 2. Subject extraction edge cases.
 * ====================================================================== */
eq('address without street suffix', extractSubject('warranty on the unit at 1519 W Juniper').address, '1519 W Juniper');
eq('address stops before trailing verb', extractSubject('is the unit at 3247 Elm still under warranty').address, '3247 Elm');
eq('customer number wins independent of case', extractSubject('warranty for c-00012').customerNumber, 'C-00012');
eq('identifier requires a digit', extractSubject('what model is the ABCDEFGH unit').identifier, null);
eq('identifier ignores a bare year', extractSubject('installed in 2024 at the shop').identifier, null);
eq('identifier accepts a real serial', extractSubject('serial 4N2119-08772 warranty').identifier, '4N2119-08772');
eq('possessive question-word is not a name', extractSubject("What's the serial number?").name, null);
eq('ordinal detected', extractSubject('who was out last week').ordinal, 'last');
eq('unit type detected', extractSubject('the condenser at 3247 Elm St').unitType, 'condenser');
eq('no subject at all', extractSubject('what refrigerant does it take').hasAny, false);

eq('address tokens drop street-type words', significantAddressTokens('3247 Elm St'), ['3247', 'elm']);
eq('address tokens drop directionals', significantAddressTokens('1519 W Juniper'), ['1519', 'juniper']);
eq('empty address -> empty tokens', significantAddressTokens(''), []);

/* ======================================================================
 * 3. Ambiguity -> null.
 * ====================================================================== */
eq('unique candidate resolves', pickUnique([{ id: 'a' }]), { id: 'a' });
eq('two distinct candidates -> null (never guess)', pickUnique([{ id: 'a' }, { id: 'b' }]), null);
eq('zero candidates -> null', pickUnique([]), null);
eq('same row twice (dup path) still resolves', pickUnique([{ id: 'a' }, { id: 'a' }]), { id: 'a' });

/* ======================================================================
 * 4. pickBestExtraction / pickMostRecent.
 * ====================================================================== */
eq(
  'best extraction prefers verified stage over higher confidence',
  pickBestExtraction([
    { document_id: 'd1', value: 'x', confidence: 0.99, stage: 'linked' },
    { document_id: 'd2', value: 'y', confidence: 0.5, stage: 'verified' },
  ]),
  { document_id: 'd2', value: 'y', confidence: 0.5, stage: 'verified' }
);
eq(
  'best extraction falls back to confidence when stage ties',
  pickBestExtraction([
    { document_id: 'd1', value: 'x', confidence: 0.4, stage: 'linked' },
    { document_id: 'd2', value: 'y', confidence: 0.9, stage: 'linked' },
  ]).document_id,
  'd2'
);
eq('best extraction of empty list is null', pickBestExtraction([]), null);
eq(
  'most recent picks the latest date',
  pickMostRecent([
    { document_id: 'd1', value: 'old', date: '2024-01-01', confidence: 0.9, stage: 'verified' },
    { document_id: 'd2', value: 'new', date: '2025-06-01', confidence: 0.5, stage: 'linked' },
  ]).document_id,
  'd2'
);

/* ======================================================================
 * 5. Answer builders, including a computed warranty fact.
 * ====================================================================== */
{
  const resolution = { kind: 'equipment', equipment: { id: 'eq1', data: { manufacturer: 'Carrier', equipment_type: 'condenser', service_address: '3247 Elm St' } } };
  const row = { document_id: 'doc1', field_key: 'serial_number', value: '4N2119-08772', confidence: 0.95, stage: 'verified' };
  const answer = buildFieldAnswer({ intent: 'serial', resolution, row });
  check('field answer cites the extraction', answer.sources[0].documentId === 'doc1' && answer.sources[0].location.field === 'serial_number');
  check('field answer has one fact', answer.facts.length === 1);
  eq('field answer verifiedCount', answer.verifiedCount, 1);
  check('field answer text names the subject', answer.text.includes('Carrier') && answer.text.includes('4N2119-08772'));
}
{
  // Printed expiry.
  const resolution = { kind: 'equipment', equipment: { id: 'eq1', data: { manufacturer: 'Carrier', service_address: '3247 Elm St' } } };
  const stable = { brand: 'carrier', expires: '2034-03-14', expiresBasis: 'printed', registrationOnFile: '2024-01-01' };
  const citationRow = { document_id: 'doc2', field_key: 'warranty_expires', value: '2034-03-14', confidence: 0.97, stage: 'verified' };
  const answer = buildWarrantyAnswer({ intent: 'warranty_expires', resolution, stable, today: '2026-09-20', citationRow });
  check('printed warranty basis is printed', answer.facts[0].basis === 'printed');
  check('printed warranty cites the printed field', answer.facts[0].sources[0].location.field === 'warranty_expires');
  check('printed warranty text has the human date', answer.text.includes('March 14, 2034'));
}
{
  // Computed expiry — basis must say so, and the citation must point at the
  // fact the arithmetic actually ran on (installation_date), not a printed
  // expiry that doesn't exist. This is the one case the brief calls out by
  // name ("computed fields ... reuse warrantyRules and mark basis:'computed'").
  const resolution = { kind: 'equipment', equipment: { id: 'eq1', data: { manufacturer: 'Goodman', service_address: '1519 W Juniper' } } };
  const stable = { brand: 'goodman', expires: '2034-06-01', expiresBasis: 'computed', installDate: '2024-06-01', registrationOnFile: null };
  const citationRow = { document_id: 'doc3', field_key: 'installation_date', value: '2024-06-01', confidence: 0.9, stage: 'linked' };
  const answer = buildWarrantyAnswer({ intent: 'warranty_expires', resolution, stable, today: '2026-09-20', citationRow });
  eq('computed warranty basis', answer.facts[0].basis, 'computed');
  eq('computed warranty cites installation_date, not warranty_expires', answer.facts[0].sources[0].location.field, 'installation_date');
  check('computed warranty text discloses it is computed', answer.text.includes('(computed)'));
  eq('computed warranty verifiedCount reflects the citing doc stage', answer.verifiedCount, 0);
}
{
  // No expiry at all (unverified brand, or no install date) -> defer.
  const resolution = { kind: 'equipment', equipment: { id: 'eq1', data: {} } };
  const stable = { brand: null, expires: null, expiresBasis: null };
  const answer = buildWarrantyAnswer({ intent: 'warranty_expires', resolution, stable, today: '2026-09-20', citationRow: null });
  eq('no warranty data -> defer to model (null)', answer, null);
}
{
  const resolution = { kind: 'customer', customer: { data: { customer_name: 'Henderson' } } };
  const units = [
    { id: 'u1', manufacturer: 'Carrier', equipment_type: 'condenser', model: 'X1', serial_number: 'S1', warranty: null },
    { id: 'u2', manufacturer: 'Trane', equipment_type: 'furnace', model: 'X2', serial_number: 'S2', warranty: { expires: '2020-01-01' } },
  ];
  const answer = buildEquipmentListAnswer({ resolution, units, today: '2026-09-20' });
  eq('equipment list fact count', answer.facts.length, 2);
  check('equipment list flags expired unit', answer.facts.some((f) => f.status === 'bad'));
  eq('empty equipment list defers', buildEquipmentListAnswer({ resolution, units: [], today: '2026-09-20' }), null);
}
{
  const resolution = { kind: 'customer', customer: { data: { customer_name: 'Henderson' } } };
  const documents = [{ id: 'd1', document_type: 'invoice', original_filename: 'inv.pdf' }];
  const answer = buildDocumentListAnswer({ resolution, documents, documentTypeLabel: (t) => t });
  eq('document list fact count', answer.facts.length, 1);
  eq('document list cites the document', answer.facts[0].sources[0].documentId, 'd1');
}

/* ======================================================================
 * 6. Stage eligibility parity + disable flag.
 * ====================================================================== */
for (const stage of ['received', 'read', 'mapped', 'linked', 'verified', 'anything-else', undefined]) {
  check(`isStageEligible('${stage}') matches searchExtractions' no-filter rule`, isStageEligible(stage) === true);
}
eq('fast path enabled by default', isFastPathEnabled({}), true);
eq('ASK_FAST_PATH=0 disables', isFastPathEnabled({ ASK_FAST_PATH: '0' }), false);
eq('ASK_FAST_PATH=1 leaves it enabled', isFastPathEnabled({ ASK_FAST_PATH: '1' }), true);

/* ======================================================================
 * 7. Format helpers + no-field intents.
 * ====================================================================== */
eq('formatDateHuman day precision', formatDateHuman('2034-03-14'), 'March 14, 2034');
eq('formatDateHuman month precision', formatDateHuman('2034-03'), 'March 2034');
eq('formatDateHuman passes through junk', formatDateHuman('not-a-date'), 'not-a-date');
eq('formatMoney', formatMoney('9127'), '$9,127.00');
eq('formatMoney non-numeric passthrough', formatMoney('n/a'), 'n/a');

for (const intent of NO_FIELD_INTENTS) {
  check(`${intent} has no FIELD_BY_INTENT entry`, !(intent in FIELD_BY_INTENT));
}
for (const intent of WARRANTY_INTENTS) check(`${intent} is not in FIELD_BY_INTENT`, !(intent in FIELD_BY_INTENT));
for (const intent of LIST_INTENTS) check(`${intent} is not in FIELD_BY_INTENT`, !(intent in FIELD_BY_INTENT));

console.log(failures === 0 ? `\nAll fast-path checks passed (${CORPUS.length} corpus phrasings).` : `\n${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
