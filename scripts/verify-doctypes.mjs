/**
 * Unit checks for the canonical document-type/classification/completeness
 * layer. No database, no network, no model.
 *
 *   node scripts/verify-doctypes.mjs
 */
import {
  DOCUMENT_TYPES,
  DOCUMENT_TYPE_IDS,
  REQUIRED_FIELDS,
  FIELD_LABELS,
  AI_VERIFY_MIN_CONFIDENCE,
  normalizeDocumentType,
  isLegacyOrUnknownType,
  isReclassifiable,
  inferDocumentType,
  inferTypeFromFilename,
  resolveDocumentType,
  completenessFor,
  toCompletenessFields,
  isShopInternalDocument,
} from '../api/_lib/documentTypes.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* --------------------------------------------------------- canonical list */

eq('every REQUIRED_FIELDS type is a canonical id', Object.keys(REQUIRED_FIELDS).every((k) => DOCUMENT_TYPE_IDS.has(k)), true);
eq('every canonical id has a REQUIRED_FIELDS entry', DOCUMENT_TYPES.every((t) => t.id in REQUIRED_FIELDS), true);
check('AI_VERIFY_MIN_CONFIDENCE is 0.85', AI_VERIFY_MIN_CONFIDENCE === 0.85);

/* ------------------------------------------------------ normalizeDocumentType */

eq('canonical id passes through', normalizeDocumentType('invoice'), 'invoice');
eq('legacy warranty maps to warranty-registration', normalizeDocumentType('warranty'), 'warranty-registration');
eq('legacy service_ticket maps to service-ticket', normalizeDocumentType('service_ticket'), 'service-ticket');
eq('legacy equipment_record maps to equipment-record', normalizeDocumentType('equipment_record'), 'equipment-record');
eq('legacy document maps to other', normalizeDocumentType('document'), 'other');
eq('install_record with cost maps to invoice', normalizeDocumentType('install_record', { cost: '100.00' }), 'invoice');
eq('install_record with invoice_number maps to invoice', normalizeDocumentType('install_record', { invoice_number: 'INV-1' }), 'invoice');
eq('install_record with neither maps to startup-sheet', normalizeDocumentType('install_record', {}), 'startup-sheet');
eq('install_record with no facts arg maps to startup-sheet', normalizeDocumentType('install_record'), 'startup-sheet');
eq('free text with spaces normalizes', normalizeDocumentType('Work Order'), 'work-order');
eq('unknown free text falls back to other', normalizeDocumentType('some random label'), 'other');
eq('null falls back to other', normalizeDocumentType(null), 'other');
eq('undefined falls back to other', normalizeDocumentType(undefined), 'other');
eq('empty string falls back to other', normalizeDocumentType(''), 'other');
check('normalizeDocumentType never returns something outside the canonical set',
  DOCUMENT_TYPES.concat([{ id: 'warranty' }, { id: 'garbage' }, { id: null }])
    .every((t) => DOCUMENT_TYPE_IDS.has(normalizeDocumentType(t.id))));

/* --------------------------------------------------------- isReclassifiable */

eq('null is reclassifiable', isReclassifiable(null), true);
eq('empty string is reclassifiable', isReclassifiable(''), true);
eq('legacy warranty is reclassifiable', isReclassifiable('warranty'), true);
eq('canonical "other" IS reclassifiable — the bug this build fixes', isReclassifiable('other'), true);
eq('"Other" (mixed case) is reclassifiable', isReclassifiable('Other'), true);
eq('canonical invoice is NOT reclassifiable', isReclassifiable('invoice'), false);
eq('canonical service-ticket is NOT reclassifiable', isReclassifiable('service-ticket'), false);

/* ------------------------------------------------------ isLegacyOrUnknownType */

eq('null is legacy/unknown', isLegacyOrUnknownType(null), true);
eq('empty string is legacy/unknown', isLegacyOrUnknownType(''), true);
eq('legacy warranty is legacy/unknown', isLegacyOrUnknownType('warranty'), true);
eq('free text is legacy/unknown', isLegacyOrUnknownType('whatever'), true);
eq('canonical invoice is NOT legacy/unknown', isLegacyOrUnknownType('invoice'), false);
eq('canonical other is NOT legacy/unknown', isLegacyOrUnknownType('other'), false);

/* -------------------------------------------------------------- inferDocumentType */

eq('warranty registration date infers warranty-registration', inferDocumentType({ warranty_registered_date: '2024-01-01' }), 'warranty-registration');
eq('permit_number infers permit', inferDocumentType({ permit_number: 'P-1' }), 'permit');
eq('term + customer + address + no serial infers maintenance-agreement',
  inferDocumentType({ warranty_term: '10 year', customer_name: 'Jane', service_address: '1 Main St' }), 'maintenance-agreement');
eq('term + serial infers warranty-registration (not an agreement)',
  inferDocumentType({ warranty_term: '10 year', serial_number: 'ABC123' }), 'warranty-registration');
eq('cost infers invoice', inferDocumentType({ cost: '100.00' }), 'invoice');
eq('work_performed infers service-ticket', inferDocumentType({ work_performed: 'replaced capacitor' }), 'service-ticket');
eq('service_date + technician infers work-order', inferDocumentType({ service_date: '2024-01-01', technician: 'Bob' }), 'work-order');
eq('installation_date alone infers startup-sheet', inferDocumentType({ installation_date: '2024-01-01' }), 'startup-sheet');
eq('service_date alone infers inspection-report', inferDocumentType({ service_date: '2024-01-01' }), 'inspection-report');
eq('serial + photo filename infers nameplate-photo', inferDocumentType({ serial_number: 'ABC' }, 'IMG_001.jpg'), 'nameplate-photo');
eq('serial + non-photo filename infers equipment-record', inferDocumentType({ serial_number: 'ABC' }, 'scan.pdf'), 'equipment-record');
eq('customer_name alone infers correspondence', inferDocumentType({ customer_name: 'Jane' }), 'correspondence');
eq('nothing at all infers other', inferDocumentType({}), 'other');
eq('undefined facts is safe and infers other', inferDocumentType(undefined), 'other');
check('inferDocumentType always returns a canonical id', DOCUMENT_TYPE_IDS.has(inferDocumentType({})));

/* ------------------------------------------------------- inferTypeFromFilename */
// The specific production bug: 'other'-typed docs whose facts alone don't say
// enough must still be caught by a strong filename match.

eq('service-ticket filename', inferTypeFromFilename('03-service-ticket-3247-elm-capacitor.pdf'), 'service-ticket');
eq('dispatch note filename', inferTypeFromFilename('07-dispatch-note-2025-11-03.txt'), 'dispatch-note');
eq('dispatch note filename, different naming', inferTypeFromFilename('08-dispatch-note-rosa-delgado.txt'), 'dispatch-note');
eq('work-order filename', inferTypeFromFilename('work-order-4521.pdf'), 'work-order');
eq('invoice filename', inferTypeFromFilename('invoice_9981.pdf'), 'invoice');
eq('warranty filename', inferTypeFromFilename('warranty-card.pdf'), 'warranty-registration');
eq('warranty filename, plural', inferTypeFromFilename('warranties-2024.pdf'), 'warranty-registration');
eq('permit filename', inferTypeFromFilename('city-permit-2201.pdf'), 'permit');
eq('nameplate filename', inferTypeFromFilename('nameplate_photo.jpg'), 'nameplate-photo');
eq('data plate filename', inferTypeFromFilename('data-plate.jpg'), 'nameplate-photo');
eq('maintenance agreement filename', inferTypeFromFilename('maintenance-agreement-2024.pdf'), 'maintenance-agreement');
eq('service agreement filename', inferTypeFromFilename('service_agreement.pdf'), 'maintenance-agreement');
eq('proposal filename', inferTypeFromFilename('proposal-elm-st.pdf'), 'proposal-quote');
eq('quote filename', inferTypeFromFilename('quote_9981.pdf'), 'proposal-quote');
eq('inspection filename', inferTypeFromFilename('inspection-report-elm.pdf'), 'inspection-report');
eq('purchase order filename, spelled out', inferTypeFromFilename('purchase-order-771.pdf'), 'purchase-order');
eq('purchase order filename, PO- number', inferTypeFromFilename('PO-4521.pdf'), 'purchase-order');
eq('unmatched filename returns null', inferTypeFromFilename('scan.pdf'), null);
eq('empty filename returns null', inferTypeFromFilename(''), null);
eq('null filename returns null', inferTypeFromFilename(null), null);
eq('case-insensitive match', inferTypeFromFilename('DISPATCH-NOTE.TXT'), 'dispatch-note');

// inferDocumentType: the filename fallback fires exactly for the failing
// production docs, but never overrides a stronger extracted fact.
eq('dispatch-note doc with weak facts (service_date only) resolved by filename',
  inferDocumentType({ service_address: '3247 Elm St', service_date: '2025-11-03' }, '07-dispatch-note-2025-11-03.txt'),
  'dispatch-note');
eq('service-ticket doc with no work_performed extracted still resolved by filename',
  inferDocumentType({ service_address: '3247 Elm St' }, '03-service-ticket-3247-elm-capacitor.pdf'),
  'service-ticket');
eq('a real cost still wins over a conflicting filename', inferDocumentType({ cost: '150.00' }, '07-dispatch-note.txt'), 'invoice');
eq('work_performed still wins over a conflicting filename', inferDocumentType({ work_performed: 'replaced capacitor' }, 'invoice-draft.pdf'), 'service-ticket');
eq('permit_number still wins over a conflicting filename', inferDocumentType({ permit_number: 'P-1' }, 'invoice.pdf'), 'permit');

/* ------------------------------------------------------------ resolveDocumentType */

{
  const r = resolveDocumentType({ document_type: 'invoice', document_type_confidence: 0.9 }, { cost: '10' }, 'x.pdf');
  eq('model classification used when valid', r.documentType, 'invoice');
  eq('model confidence carried through', r.confidence, 0.9);
  eq('source is model', r.source, 'model');
}
{
  const r = resolveDocumentType({ document_type: 'not-a-real-type' }, { cost: '10' }, 'x.pdf');
  eq('invalid model type falls back to heuristic', r.documentType, 'invoice');
  eq('fallback source is heuristic', r.source, 'heuristic');
}
{
  const r = resolveDocumentType({}, { work_performed: 'flushed line' }, 'x.pdf');
  eq('missing model type falls back to heuristic', r.documentType, 'service-ticket');
}
{
  const r = resolveDocumentType({ document_type_confidence: 1.5 }, {}, 'x.pdf');
  eq('out-of-range confidence never used verbatim (heuristic path has its own default)', r.confidence, 0.5);
}

/* -------------------------------------------------------------- completenessFor */

{
  const c = completenessFor('invoice', [
    { field_key: 'service_address', value: '123 Main St', confidence: 0.95 },
    { field_key: 'cost', value: '100.00', confidence: 0.9 },
  ]);
  eq('invoice complete with both required fields', c.complete, true);
  eq('invoice minConfidence is the lower of the two', c.minConfidence, 0.9);
  eq('invoice required list', c.required, ['service_address', 'cost']);
  eq('invoice present list', c.present.sort(), ['cost', 'service_address']);
  eq('invoice missing list is empty', c.missing, []);
}

{
  const c = completenessFor('invoice', [{ field_key: 'service_address', value: '123 Main St', confidence: 0.95 }]);
  eq('invoice missing cost is incomplete', c.complete, false);
  eq('invoice reports cost missing', c.missing, ['cost']);
}

{
  // Alternatives: warranty_expires|warranty_term — either satisfies.
  const withExpires = completenessFor('warranty-registration', [
    { field_key: 'serial_number', value: 'SN1', confidence: 0.9 },
    { field_key: 'model', value: 'M1', confidence: 0.9 },
    { field_key: 'warranty_expires', value: '2030-01-01', confidence: 0.8 },
  ]);
  eq('warranty-registration complete via warranty_expires alone', withExpires.complete, true);
  check('present names the field that actually satisfied it', withExpires.present.includes('warranty_expires'));

  const withTerm = completenessFor('warranty-registration', [
    { field_key: 'serial_number', value: 'SN1', confidence: 0.9 },
    { field_key: 'model', value: 'M1', confidence: 0.9 },
    { field_key: 'warranty_term', value: '10 year', confidence: 0.8 },
  ]);
  eq('warranty-registration complete via warranty_term alone', withTerm.complete, true);

  const withNeither = completenessFor('warranty-registration', [
    { field_key: 'serial_number', value: 'SN1', confidence: 0.9 },
    { field_key: 'model', value: 'M1', confidence: 0.9 },
  ]);
  eq('warranty-registration incomplete with neither alternative', withNeither.complete, false);
  eq('missing reports the whole alternative group', withNeither.missing, ['warranty_expires|warranty_term']);
}

{
  // Blank / whitespace-only values do not count as present.
  const c = completenessFor('correspondence', [{ field_key: 'customer_name', value: '   ', confidence: 0.9 }]);
  eq('whitespace-only value does not satisfy a requirement', c.complete, false);
}

{
  // Highest-confidence duplicate wins when a field_key appears twice.
  const c = completenessFor('correspondence', [
    { field_key: 'customer_name', value: 'Jane', confidence: 0.4 },
    { field_key: 'customer_name', value: 'Jane', confidence: 0.95 },
  ]);
  eq('duplicate field_key uses the higher confidence', c.minConfidence, 0.95);
}

{
  const c = completenessFor('other', []);
  eq('other has no required fields', c.required, []);
  eq('other is always complete', c.complete, true);
  eq('other has minConfidence 1 (nothing to be unsure about)', c.minConfidence, 1);
}

{
  // A legacy/raw type id is normalized before its requirements are looked up.
  const c = completenessFor('warranty', [
    { field_key: 'serial_number', value: 'SN1', confidence: 0.9 },
    { field_key: 'model', value: 'M1', confidence: 0.9 },
    { field_key: 'warranty_term', value: '10 year', confidence: 0.9 },
  ]);
  eq('legacy type id resolved before checking requirements', c.type, 'warranty-registration');
  eq('legacy-typed document can still be complete', c.complete, true);
}

eq('malformed fields array is safe', completenessFor('invoice', null).required, ['service_address', 'cost']);
eq('non-array fields is safe', completenessFor('invoice', 'nope').complete, false);

/* -------------------------------------------------------- AI-verify threshold */

{
  const c = completenessFor('startup-sheet', [
    { field_key: 'serial_number', value: 'SN1', confidence: 0.9 },
    { field_key: 'service_date', value: '2024-01-01', confidence: 0.86 },
  ]);
  check('complete + minConfidence above threshold clears AI verification',
    c.complete && c.minConfidence >= AI_VERIFY_MIN_CONFIDENCE);
}
{
  const c = completenessFor('startup-sheet', [
    { field_key: 'serial_number', value: 'SN1', confidence: 0.9 },
    { field_key: 'service_date', value: '2024-01-01', confidence: 0.7 },
  ]);
  check('complete but under threshold does NOT clear AI verification',
    c.complete && !(c.minConfidence >= AI_VERIFY_MIN_CONFIDENCE));
}
{
  const c = completenessFor('startup-sheet', [{ field_key: 'serial_number', value: 'SN1', confidence: 0.99 }]);
  check('incomplete never clears AI verification regardless of confidence',
    !c.complete);
}

/* ------------------------------------------------------------ toCompletenessFields */

{
  const rows = [
    { field_key: 'cost', value: '50.00', confidence: 0.4, corrected_value: '75.00' },
    { field_key: 'service_address', value: '123 Main St', confidence: 0.9, corrected_value: null },
  ];
  const fields = toCompletenessFields(rows);
  const byKey = Object.fromEntries(fields.map((f) => [f.field_key, f]));
  eq('a human correction wins over the original value', byKey.cost.value, '75.00');
  eq('a corrected field is treated as fully confident', byKey.cost.confidence, 1);
  eq('an uncorrected field keeps its own confidence', byKey.service_address.confidence, 0.9);
}
eq('toCompletenessFields is safe on null', toCompletenessFields(null), []);
eq('toCompletenessFields is safe on undefined', toCompletenessFields(undefined), []);

/* --------------------------------------------------- isShopInternalDocument */
// Round 4 (2026-09-21): a document whose only facts are its own shop_*
// letterhead fields plus notes/status names no customer at all and must be
// routed to the 'internal' type (Shop record), not left waiting in the human
// review queue for a link that will never come.

{
  const f = (key, value) => ({ field_key: key, value });

  // The three examples from the live corpus.
  check('a bare parts count (shop letterhead + a note) is shop-internal',
    isShopInternalDocument([f('shop_address', '2210 E Main St, Mesa AZ'), f('notes', 'Counted 40 capacitors in stock')]));
  check('a truck dispatch note (shop phone + status) is shop-internal',
    isShopInternalDocument([f('shop_phone', '(480) 555-0199'), f('status', 'Dispatched')]));
  check('an internal memo to all techs (shop email + note) is shop-internal',
    isShopInternalDocument([f('shop_email', 'dispatch@desertpeakhvac.com'), f('notes', 'All techs: new PPE policy effective Monday')]));

  // Any customer/job/unit signal disqualifies it, even alongside shop facts.
  check('customer_name disqualifies it', !isShopInternalDocument([f('shop_address', 'x'), f('customer_name', 'Plaza Dental')]));
  check('service_address disqualifies it', !isShopInternalDocument([f('shop_address', 'x'), f('service_address', '412 Elm St')]));
  check('serial_number disqualifies it', !isShopInternalDocument([f('shop_address', 'x'), f('serial_number', 'SN1')]));
  check('model disqualifies it', !isShopInternalDocument([f('shop_address', 'x'), f('model', 'GSX140361K')]));
  check('invoice_number disqualifies it', !isShopInternalDocument([f('shop_address', 'x'), f('invoice_number', 'INV-1')]));
  check('permit_number disqualifies it', !isShopInternalDocument([f('shop_address', 'x'), f('permit_number', 'BP-1')]));
  check('a technician name disqualifies it (not "shop_* + notes/status only")',
    !isShopInternalDocument([f('shop_address', 'x'), f('technician', 'D. Ramirez')]));
  check('a cost figure disqualifies it', !isShopInternalDocument([f('shop_address', 'x'), f('cost', '412.50')]));

  // Edge cases.
  check('no facts at all is not shop-internal (just unclassified)', !isShopInternalDocument([]));
  check('notes/status alone with no shop_* fact is not shop-internal', !isShopInternalDocument([f('notes', 'reminder')]));
  check('an empty-string shop_address does not count as a shop fact', !isShopInternalDocument([f('shop_address', '  '), f('notes', 'x')]));
  check('null/undefined input is safe', !isShopInternalDocument(null) && !isShopInternalDocument(undefined));
  check('a normal invoice (customer + cost, no shop facts) is not shop-internal',
    !isShopInternalDocument([f('customer_name', 'Plaza Dental'), f('cost', '412.50')]));

  check('"internal" is a canonical document type', DOCUMENT_TYPE_IDS.has('internal'));
  eq('the "internal" type has no required fields (always AI-verifiable)', REQUIRED_FIELDS.internal, []);
}

/* -------------------------------------------------------------- FIELD_LABELS */

check('FIELD_LABELS covers every field_key used in REQUIRED_FIELDS',
  Object.values(REQUIRED_FIELDS).flat().every((req) => req.split('|').every((k) => k in FIELD_LABELS)));

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
