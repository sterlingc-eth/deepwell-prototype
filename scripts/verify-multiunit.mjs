/**
 * Multi-unit document grouping — pure function checks, no database.
 *
 * Live finding (2026-09-19): a maintenance agreement covering more than one
 * piece of equipment (Plaza Dental's two Trane rooftop units) had its 2nd+
 * unit's serial/model/install-date silently discarded by dedupe(), because
 * every non-repeatable field used to collapse to ONE value per field_key for
 * the whole document, no matter how many physical units it named.
 *
 * groupFieldsByUnit() (extractFields.js) is what extractDocument.js now
 * calls to turn a flat, unit_index-tagged fields array back into one bucket
 * per unit plus a shared bucket — this is that function's own coverage.
 *
 *   node scripts/verify-multiunit.mjs
 */
import {
  normalizeFields,
  groupFieldsByUnit,
  collapseDuplicateValues,
  MAX_UNITS_PER_DOCUMENT,
} from '../api/_lib/extractFields.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* ------------------------------------------------------- three real units */

{
  // Three rooftop units on one maintenance agreement, plus facts that apply
  // to the whole document regardless of which unit they're near on the page.
  const raw = [
    { key: 'customer_name', value: 'Plaza Dental', page_no: 1, confidence: 0.95 },
    { key: 'service_address', value: '100 Main St', page_no: 1, confidence: 0.95 },
    { key: 'agreement_term', value: '01/01/2025 - 12/31/2025', page_no: 1, confidence: 0.9 },

    { key: 'serial_number', value: 'RTU-1-SN', page_no: 1, confidence: 0.9, unit_index: 1 },
    { key: 'model', value: 'TRANE-XL', page_no: 1, confidence: 0.9, unit_index: 1 },
    { key: 'manufacturer', value: 'Trane', page_no: 1, confidence: 0.9, unit_index: 1 },
    { key: 'installation_date', value: '06/2021', page_no: 1, confidence: 0.9, unit_index: 1 },

    { key: 'serial_number', value: 'RTU-2-SN', page_no: 1, confidence: 0.9, unit_index: 2 },
    { key: 'model', value: 'TRANE-XL', page_no: 1, confidence: 0.9, unit_index: 2 }, // same model, different unit
    { key: 'manufacturer', value: 'Trane', page_no: 1, confidence: 0.9, unit_index: 2 },
    { key: 'installation_date', value: '06/2021', page_no: 1, confidence: 0.9, unit_index: 2 },

    { key: 'serial_number', value: 'RTU-3-SN', page_no: 1, confidence: 0.9, unit_index: 3 },
    { key: 'model', value: 'CARRIER-50', page_no: 1, confidence: 0.9, unit_index: 3 },
    { key: 'manufacturer', value: 'Carrier', page_no: 1, confidence: 0.9, unit_index: 3 },
    { key: 'installation_date', value: '2022-03-15', page_no: 1, confidence: 0.9, unit_index: 3 },
  ];

  const { fields } = normalizeFields(raw, { pageCount: 1 });
  const serials = fields.filter((f) => f.field_key === 'serial_number');
  eq('all three distinct serials survive normalizeFields', serials.length, 3);

  const { shared, units } = groupFieldsByUnit(fields);
  eq('three units grouped', units.length, 3);
  eq('unit indices in order', units.map((u) => u.index), [1, 2, 3]);

  eq('shared facts carry customer_name', shared.customer_name, 'Plaza Dental');
  eq('shared facts carry agreement_term', shared.agreement_term, '01/01/2025 - 12/31/2025');

  eq('unit 1 gets its own serial', units[0].facts.serial_number, 'RTU-1-SN');
  eq('unit 2 gets its own serial', units[1].facts.serial_number, 'RTU-2-SN');
  eq('unit 3 gets its own serial', units[2].facts.serial_number, 'RTU-3-SN');
  eq('unit 3 gets its own manufacturer', units[2].facts.manufacturer, 'Carrier');
  eq('unit 1 keeps month-precision install date', units[0].facts.installation_date, '2021-06');
  eq('unit 3 keeps day-precision install date', units[2].facts.installation_date, '2022-03-15');

  check('every unit inherits the shared customer_name',
    units.every((u) => u.facts.customer_name === 'Plaza Dental'));
  check('every unit inherits the shared agreement_term',
    units.every((u) => u.facts.agreement_term === '01/01/2025 - 12/31/2025'));

  // Two units sharing an identical model string — the exact collision that
  // would make replaceDocumentFields' (field_key, value) join fan out if the
  // write path did not collapse it. Confirmed collapsed here at the field
  // level (extractDocument.js does this immediately before the DB write).
  const collapsedForWrite = collapseDuplicateValues(fields);
  const modelRows = collapsedForWrite.filter((f) => f.field_key === 'model' && f.value === 'TRANE-XL');
  eq('shared model value written once, not once per unit', modelRows.length, 1);
  // But grouping itself (used to decide which entities to create) still saw
  // both units' model facts before collapsing:
  eq('grouping still saw unit 1\'s model before the write-path collapse', units[0].facts.model, 'TRANE-XL');
  eq('grouping still saw unit 2\'s model before the write-path collapse', units[1].facts.model, 'TRANE-XL');
}

/* --------------------------------------------------------- ordinary case */

{
  // No unit_index anywhere -> exactly one synthetic unit, byte-for-byte the
  // pre-multi-unit behavior. This is nearly every document in production.
  const { fields } = normalizeFields(
    [
      { key: 'serial_number', value: 'ONE-SN', page_no: 1, confidence: 0.9 },
      { key: 'customer_name', value: 'Solo Customer', page_no: 1, confidence: 0.9 },
    ],
    { pageCount: 1 }
  );
  const { units } = groupFieldsByUnit(fields);
  eq('single-unit document yields exactly one synthetic unit', units.length, 1);
  eq('synthetic unit is index 1', units[0].index, 1);
  eq('carries the serial', units[0].facts.serial_number, 'ONE-SN');
  eq('carries the shared customer_name too', units[0].facts.customer_name, 'Solo Customer');
}

/* ------------------------------------------------------------------- cap */

{
  // A garbled extraction (or a hallucinating model) tagging unit_index 1..40
  // must not fan out into 40 equipment entities. Capped at
  // MAX_UNITS_PER_DOCUMENT; normalizeFields itself already nulls any
  // unit_index above the cap (verify-extract.mjs covers that), so this
  // confirms groupFieldsByUnit's own cap holds even if it were ever called
  // with more surviving indices than that.
  const raw = [];
  for (let i = 1; i <= 40; i++) {
    raw.push({ field_key: 'serial_number', value: `SN-${i}`, confidence: 0.9, unit_index: i });
  }
  const { units } = groupFieldsByUnit(raw);
  check(`grouping caps at MAX_UNITS_PER_DOCUMENT (${MAX_UNITS_PER_DOCUMENT})`,
    units.length <= MAX_UNITS_PER_DOCUMENT, `got ${units.length} units`);
  eq('cap keeps the lowest-indexed units, not an arbitrary subset',
    units.map((u) => u.index), Array.from({ length: MAX_UNITS_PER_DOCUMENT }, (_, i) => i + 1));
}

/* --------------------------------------------------------------- inputs */

eq('non-array input is safe', groupFieldsByUnit(null).units.length, 1);
eq('empty array yields one empty unit', groupFieldsByUnit([]).units[0].facts, {});
eq('collapseDuplicateValues handles null/undefined safely', collapseDuplicateValues(undefined), []);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll multi-unit grouping checks passed.');
process.exit(failures ? 1 : 0);
