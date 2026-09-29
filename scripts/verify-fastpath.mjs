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
  buildWarrantyUnknownAnswer,
  buildWarrantyNoExpiryDecline,
  buildAmbiguousNameFieldDecline,
  isNamedUnitPhrasing,
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
  // R18 (H1, field-phrasing g035/g039/g043): a bare surname, no leading "the ... unit" noun and no
  // address — NAME_HINT_RE's "on <Name>" shape, distinct from the address/customerNumber/identifier
  // subjects every other warranty_status entry above uses.
  ["warranty status on Winslow", 'warranty_status', { name: 'Winslow' }],

  // ---- warranty_out (3, R18 H1 field-phrasing g036/g040/g044) ------------
  // "is <Name> out of warranty YET" — the INVERTED framing of warranty_status (a "Yes" here means
  // the warranty HAS expired, never "yes, still covered") — see buildWarrantyAnswer's own doc
  // comment on why this needs its own intent/template rather than reusing warranty_status's.
  ["is Matthew Whitfield out of warranty yet", 'warranty_out', { name: 'Matthew Whitfield' }],
  ["is Robert Thornton out of warranty yet", 'warranty_out', { name: 'Robert Thornton' }],
  ["is Richard Pruitt out of warranty yet", 'warranty_out', { name: 'Richard Pruitt' }],

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

  // ---- invoice_total, order-independent phrasing (R24) ---------------------
  ["What's the total on Henderson's invoice?", 'invoice_total', { name: 'Henderson' }],
  ["What's the total on C-00012's invoice?", 'invoice_total', { customerNumber: 'C-00012' }],

  // ---- po_total (R24, 4) ----------------------------------------------------
  ["How much does purchase order PO-1029 total?", 'po_total', { poNumber: 'PO-1029' }],
  ["Total for purchase order PO-2200?", 'po_total', { poNumber: 'PO-2200' }],
  ["What's the total on the purchase order for Henderson, PO-4471?", 'po_total', { poNumber: 'PO-4471', name: 'Henderson' }],
  ["What's the purchase order total for Henderson's PO-6673?", 'po_total', { poNumber: 'PO-6673' }],

  // ---- agreement_cost (R24, 5) -----------------------------------------------
  ["What's the annual cost of Henderson's maintenance agreement?", 'agreement_cost', { name: 'Henderson' }],
  ["How much is the yearly fee on C-00012's agreement?", 'agreement_cost', { customerNumber: 'C-00012' }],
  ["What's the annual price on the maintenance agreement for C-00003?", 'agreement_cost', { customerNumber: 'C-00003' }],
  ["What's the annual cost on C-00005's maintenance agreement?", 'agreement_cost', { customerNumber: 'C-00005' }],
  ["How much is the yearly cost on C-00007's maintenance agreement?", 'agreement_cost', { customerNumber: 'C-00007' }],

  // ---- equipment_age (R24, 6) ------------------------------------------------
  ["How old is the unit at 3247 Elm St?", 'equipment_age', { address: '3247 Elm St' }],
  ["How old is Henderson's system?", 'equipment_age', { name: 'Henderson' }],
  ["How old is C-00012's equipment?", 'equipment_age', { customerNumber: 'C-00012' }],
  ["How old is the unit for C-00003?", 'equipment_age', { customerNumber: 'C-00003' }],
  ["How old is the system at 1519 W Juniper?", 'equipment_age', { address: '1519 W Juniper' }],
  ["How old is the equipment for C-00005?", 'equipment_age', { customerNumber: 'C-00005' }],

  // ---- brand_match (R24, 5) --------------------------------------------------
  ["Is the unit at 3247 Elm St a Trane?", 'brand_match', { address: '3247 Elm St', askedBrand: 'trane' }],
  ["Does C-00012 have a Lennox?", 'brand_match', { customerNumber: 'C-00012', askedBrand: 'lennox' }],
  ["Is the unit for C-00003 a Rheem?", 'brand_match', { customerNumber: 'C-00003', askedBrand: 'rheem' }],
  ["Do we have a Goodman installed at 1519 W Juniper?", 'brand_match', { address: '1519 W Juniper', askedBrand: 'goodman' }],
  ["Is C-00005's unit an American Standard?", 'brand_match', { customerNumber: 'C-00005', askedBrand: 'american standard' }],
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
/* ======================================================================
 * R18 (H1, field-phrasing g036/g040/g044): warranty_out — the INVERTED framing of
 * warranty_status. Decoy test: the SAME equipment/stable fixture fed to both intents must produce
 * OPPOSITE leading Yes/No words (never the same word misapplied to the other question's meaning).
 * ====================================================================== */
{
  // Expired: warranty_out says "Yes" (it IS out), warranty_status says "No" (NOT still under warranty).
  const resolution = { kind: 'equipment', equipment: { id: 'eq1', data: { manufacturer: 'Mitsubishi', service_address: '1247 W Baseline Rd' } } };
  const stable = { brand: 'mitsubishi', expires: '2015-12-28', expiresBasis: 'computed', installDate: '2005-12-28' };
  const citationRow = { document_id: 'doc1', field_key: 'installation_date', value: '2005-12-28', confidence: 0.9, stage: 'linked' };
  const out = buildWarrantyAnswer({ intent: 'warranty_out', resolution, stable, today: '2026-09-20', citationRow });
  const status = buildWarrantyAnswer({ intent: 'warranty_status', resolution, stable, today: '2026-09-20', citationRow });
  check('warranty_out on an EXPIRED unit leads "Yes" (it IS out of warranty)', /^Yes\b/.test(out.text), out.text);
  check('warranty_status on the SAME expired unit leads "No" (opposite framing, same fact)', /^No\b/.test(status.text), status.text);
}
{
  // Not yet expired: warranty_out says "No" (it's NOT out), warranty_status says "Yes" (still covered).
  const resolution = { kind: 'equipment', equipment: { id: 'eq1', data: { manufacturer: 'Lennox', service_address: '2283 W Thomas Rd' } } };
  const stable = { brand: 'lennox', expires: '2031-08-28', expiresBasis: 'computed', installDate: '2021-08-28' };
  const citationRow = { document_id: 'doc1', field_key: 'installation_date', value: '2021-08-28', confidence: 0.9, stage: 'linked' };
  const out = buildWarrantyAnswer({ intent: 'warranty_out', resolution, stable, today: '2026-09-20', citationRow });
  const status = buildWarrantyAnswer({ intent: 'warranty_status', resolution, stable, today: '2026-09-20', citationRow });
  check('warranty_out on an ACTIVE unit leads "No" (it is NOT out of warranty yet)', /^No\b/.test(out.text), out.text);
  check('warranty_status on the SAME active unit leads "Yes" (opposite framing, same fact)', /^Yes\b/.test(status.text), status.text);
}
/* ======================================================================
 * R18 (H1, field-phrasing g038/g046/warranty-0006-canonical): the equipment's own warranty object
 * exists (a brand rule matched) but no expiry was ever computed — a real "unknown", not "nothing on
 * file". warranty_status gets a cited "unknown" answer; every other warranty intent gets an
 * uncited, empty-facts decline (never a fabricated date/yes-no).
 * ====================================================================== */
{
  const resolution = { kind: 'equipment', equipment: { id: 'eq1', customer_id: 'c1', data: { manufacturer: 'Rheem', service_address: '9 Test Rd' } } };
  const statusAnswer = buildWarrantyUnknownAnswer({ intent: 'warranty_status', resolution });
  check('warranty_status unknown-expiry answer is a real "answer", not a bare decline', statusAnswer.kind === 'answer');
  check('warranty_status unknown-expiry answer says "unknown"', /unknown/i.test(statusAnswer.text));
  check('warranty_status unknown-expiry answer is cited to the unit', statusAnswer.sources.length > 0 || (statusAnswer.facts?.[0]?.value === 'Unknown'));
  eq('warranty_status unknown-expiry has no equipment -> null (never guesses)', buildWarrantyUnknownAnswer({ intent: 'warranty_status', resolution: {} }), null);

  for (const intent of ['warranty_expires', 'warranty_out']) {
    const decline = buildWarrantyNoExpiryDecline({ intent, resolution });
    eq(`${intent} unknown-expiry is an honest no-answer (never a fabricated date/yes-no)`, decline.kind, 'no-answer');
    eq(`${intent} unknown-expiry has zero facts (compareHonestZero/compareValue's empty-alts pass condition)`, decline.facts.length, 0);
  }
}
/* ======================================================================
 * R18 (H1, field-phrasing g035/g039/g043): a bare surname resolves to MORE THAN ONE customer — never
 * guess which one, but name them (a bare no-answer fails the exam's own `set` comparator).
 * ====================================================================== */
{
  const customers = [
    { id: 'cu1', customer_name: 'Betty Winslow' },
    { id: 'cu2', customer_name: 'Matthew Winslow' },
    { id: 'cu3', customer_name: 'Donna Winslow' },
  ];
  const decline = buildAmbiguousNameFieldDecline({ intent: 'warranty_status', name: 'Winslow', customers });
  check('ambiguous-name decline is a real "answer", not a bare no-answer (set comparator needs it)', decline.kind === 'answer');
  for (const c of customers) {
    check(`ambiguous-name decline names "${c.customer_name}"`, decline.text.includes(c.customer_name));
  }
  check('ambiguous-name decline never picks/states one specific candidate\'s warranty value (never guesses)', !/\b(?:active|expired|expiring)\b/i.test(decline.text));
  eq('ambiguous-name decline with zero candidates still returns a (degenerate) answer, never throws', buildAmbiguousNameFieldDecline({ intent: 'warranty_status', name: 'Nobody', customers: [] }).kind, 'answer');
}
/* ======================================================================
 * R18 (H1): isNamedUnitPhrasing — must recognize contactLookup.js's OWN "the <Name> unit/account/..."
 * surface form (so runFastPath's ambiguous-name decline never intercepts it ahead of contactLookup's
 * own richer per-candidate warranty listing — see this function's doc comment), and must NOT
 * false-positive on the two shapes THIS round's own ambiguous-name decline exists for.
 * ====================================================================== */
check('isNamedUnitPhrasing: "Is the Salazar unit still under warranty?" (contactLookup.js\'s own shape) -> true', isNamedUnitPhrasing('Is the Salazar unit still under warranty?') === true);
check('isNamedUnitPhrasing: "the Henderson account" -> true', isNamedUnitPhrasing('What is the warranty status on the Henderson account?') === true);
check('isNamedUnitPhrasing: "warranty status on Winslow" (bare surname, no noun) -> false', isNamedUnitPhrasing('warranty status on Winslow') === false);
check('isNamedUnitPhrasing: "is Matthew Whitfield out of warranty yet" (full name, no noun) -> false', isNamedUnitPhrasing('is Matthew Whitfield out of warranty yet') === false);
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

/* ======================================================================
 * R23 (D1, fp-5 k029/k067/k071/k075/k079/k083): own paraphrases + negatives for two trigger fixes
 * this round's blind measurement caught — see fastPath.js's own comments next to each regex.
 * ====================================================================== */
const MODEL_AND_SERIAL_PLUS = [
  'whats the model plus serial on file for 100 e main st',
  'model plus serial number for the unit at 803 e pecos rd',
  'can I get the serial plus model for the unit at 951 e main st',
  'model plus serial for Amy Isaacson please',
  'quick one, serial plus model for Amy Isaacson',
];
for (const q of MODEL_AND_SERIAL_PLUS) {
  eq(`model_and_serial (positive, "plus") :: "${q}"`, classifyFastPath(q)?.intent, 'model_and_serial');
}
const MODEL_AND_SERIAL_PLUS_NEGATIVES = [
  'whats the serial number for 100 e main st', // serial only, no "plus"/"and" with model
  'whats the model number for 100 e main st', // model only
  'plus is the unit still under warranty', // "plus" present but no model/serial pairing at all
  'whats 2 plus 2', // arithmetic, not a field pairing
  'model number for the unit, and by the way is it under warranty', // "and" links model to an unrelated field, not serial
];
for (const q of MODEL_AND_SERIAL_PLUS_NEGATIVES) {
  check(`model_and_serial (negative) :: "${q}" not model_and_serial`, classifyFastPath(q)?.intent !== 'model_and_serial', JSON.stringify(classifyFastPath(q)));
}

const WARRANTY_OUT_EXPIRED_YET = [
  "has Amy Isaacson's warranty expired yet",
  "has the warranty on the unit at 951 e main st expired",
  "had Gary Villegas's warranty already expired",
  "has Amy Isaacson's warranty already expired",
  "has Amy Isaacson's warranty expired yet or is she still covered",
];
for (const q of WARRANTY_OUT_EXPIRED_YET) {
  eq(`warranty_out (positive, "expired yet") :: "${q}"`, classifyFastPath(q)?.intent, 'warranty_out');
}
const WARRANTY_OUT_EXPIRED_YET_NEGATIVES = [
  'when does the warranty expire for this unit', // asks WHEN, a date, not yes/no
  'when does the compressor warranty expire at 3247 Elm St',
  'whens the warranty up on this account',
  'does the Goodman warranty expire this year', // "does...expire" — a date question, not "has...expired"
  'is the unit still under warranty', // ordinary warranty_status, no "expired" at all
];
for (const q of WARRANTY_OUT_EXPIRED_YET_NEGATIVES) {
  check(`warranty_out (negative) :: "${q}" not warranty_out`, classifyFastPath(q)?.intent !== 'warranty_out', JSON.stringify(classifyFastPath(q)));
}

// Adversarial-review fix (Round 23 D1, post-integration): "did X's warranty expire yet" is the
// grammatically NORMAL way to ask this with "did" (the auxiliary already carries the past tense, so
// the main verb stays bare — "did it expire", never "did it expiRED", exactly like "did it happen"
// is never "did it happened"). The original round's own trigger required literal "expired" after
// "did" too, so this extremely ordinary phrasing silently fell through to the bare-date
// warranty_expires trigger instead — the exact bug this whole intent exists to prevent, for the one
// verb its own leading-verb list already claimed to cover. Confirmed via a direct r23base A/B: this
// exact phrasing produced the SAME unfixed bare-date answer on both branches before this fix.
const WARRANTY_OUT_DID_EXPIRE = [
  "did Thomas Mercer's warranty expire yet",
  "did the warranty on the unit at 137 w southern ave expire yet",
  "did Amy Isaacson's warranty already expire",
  "did Gary Villegas's warranty expire yet for that account",
  "did Robert Thornton's warranty expire yet",
];
for (const q of WARRANTY_OUT_DID_EXPIRE) {
  eq(`warranty_out (positive, "did ... expire yet") :: "${q}"`, classifyFastPath(q)?.intent, 'warranty_out');
}
// "did...expired" (the ungrammatical but sometimes-typed past-participle form) must keep working too
// — the fix accepts either verb form after "did", never REQUIRES the bare one.
eq('warranty_out (positive, "did ... expired" ungrammatical form still works) :: "did Amy Isaacson\'s warranty expired yet"', classifyFastPath("did Amy Isaacson's warranty expired yet")?.intent, 'warranty_out');
// "does" must stay fully excluded — this is the exact collision an earlier draft of this trigger
// introduced and scripts/verify-fastpath.mjs's own pinned corpus caught (see WARRANTY_OUT_EXPIRED_YET_NEGATIVES
// above); re-asserted here specifically for the bare-verb form this fix adds, so a future edit that
// widens "did" into "does" (or merges the two) gets caught immediately.
check('warranty_out (negative) :: "does the warranty expire yet" not warranty_out (case sensitive to the earlier does/expire? regression)', classifyFastPath('does the warranty expire yet')?.intent !== 'warranty_out', JSON.stringify(classifyFastPath('does the warranty expire yet')));

/* ======================================================================
 * R24: regression guards for the families closed this round. Own wording,
 * never copied from the exam corpus.
 * ====================================================================== */

// manufacturer must NOT claim a thermostat/filter brand question — the unit's
// overall manufacturer is not necessarily the thermostat's or filter's brand,
// and contactLookup's own decline for these untracked fields must run instead.
const MANUFACTURER_UNTRACKED_FIELD_NEGATIVES = [
  "What brand is the thermostat at Henderson's place?",
  "What brand is the filter on C-00012's unit?",
  "What brand thermostat does the Henderson job have?",
  "What filter brand is installed at 3247 Elm St?",
];
for (const q of MANUFACTURER_UNTRACKED_FIELD_NEGATIVES) {
  check(`manufacturer excludes thermostat/filter :: "${q}"`, classifyFastPath(q)?.intent !== 'manufacturer', `got ${classifyFastPath(q)?.intent}`);
}

// equipment_age must NOT claim a portfolio-wide oldest/newest superlative —
// that's analytics.js's job (it scans every unit, not one resolved subject).
const EQUIPMENT_AGE_SUPERLATIVE_NEGATIVES = [
  "How old is the oldest unit we've got, in years?",
  "How old is the newest system on file?",
  "What's the age of our oldest piece of equipment?",
];
for (const q of EQUIPMENT_AGE_SUPERLATIVE_NEGATIVES) {
  check(`equipment_age excludes oldest/newest :: "${q}"`, classifyFastPath(q)?.intent !== 'equipment_age', `got ${classifyFastPath(q)?.intent}`);
}

// invoice_total must classify regardless of "total"/"invoice" word order.
eq('invoice_total order-independent :: "What\'s the total on Henderson\'s invoice?"', classifyFastPath("What's the total on Henderson's invoice?")?.intent, 'invoice_total');

// po_total requires a PO number; a bare "purchase order" mention with no
// number must defer rather than guess which one.
check('po_total defers with no PO number :: "What is the total on the purchase order?"', classifyFastPath('What is the total on the purchase order?')?.intent !== 'po_total', `got ${classifyFastPath('What is the total on the purchase order?')?.intent}`);

// brand_match requires exactly one recognized brand word; a question naming
// two brands is ambiguous about which one is being asked about, so
// extractAskedBrand must come back null even though the trigger itself still
// fires on "is/are ... unit ... a <brand>" — runBrandMatch (fastPathQuery.js)
// treats a null askedBrand as an automatic defer (`if (!askedBrand) return null;`).
check('brand_match: two brands named -> askedBrand is null (ambiguous, must defer downstream) :: "Is the Henderson unit a Trane or a Carrier?"', classifyFastPath('Is the Henderson unit a Trane or a Carrier?')?.subject.askedBrand === null, `got ${JSON.stringify(classifyFastPath('Is the Henderson unit a Trane or a Carrier?')?.subject.askedBrand)}`);

console.log(failures === 0 ? `\nAll fast-path checks passed (${CORPUS.length} corpus phrasings).` : `\n${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
