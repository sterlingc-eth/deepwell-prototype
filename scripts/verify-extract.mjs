/**
 * Unit checks for the extraction layer's pure functions.
 *
 * No database, no network, no model — so this runs in a second on any machine
 * and there is no excuse for skipping it before a push.
 *
 * What it is guarding: everything here decides what gets WRITTEN to
 * `extractions`, and a bad value in that table is worse than a missing one.
 * A missing warranty date shows as "we don't know"; a wrong one shows as a
 * fact, on a screen, next to a citation.
 *
 *   node scripts/verify-extract.mjs
 */
import {
  normalizeDate,
  normalizeNumber,
  normalizeFields,
  selectPages,
  stripControlChars,
  buildExtractPrompt,
  EXTRACT_TOOL,
  FIELD_KEYS,
} from '../api/_lib/extractFields.js';
import { sniff, sniffMagicBytes, chunkText } from '../api/_lib/readDocument.js';
import { DOCUMENT_TYPES, DOCUMENT_TYPE_IDS, resolveDocumentType } from '../api/_lib/documentTypes.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* ---------------------------------------------------------------- dates */

eq('ISO date passes through', normalizeDate('2024-03-04'), '2024-03-04');
eq('US slash date', normalizeDate('03/04/2024'), '2024-03-04');
eq('day-first when month > 12', normalizeDate('13/04/2024'), '2024-04-13');
eq('written month', normalizeDate('March 4, 2024'), '2024-03-04');
eq('abbreviated month', normalizeDate('Mar. 4 2024'), '2024-03-04');
eq('day then month', normalizeDate('4 March 2024'), '2024-03-04');
eq('single-digit padding', normalizeDate('2024-3-4'), '2024-03-04');
eq('impossible day rejected', normalizeDate('2024-02-31'), null);
eq('month 13 rejected', normalizeDate('2024-13-01'), null);
eq('prose rejected', normalizeDate('sometime next spring'), null);
eq('empty rejected', normalizeDate(''), null);
// The reason this is not `new Date(s)`: a bare ISO date parses as UTC midnight,
// which in Mesa prints as the day before.
eq('no timezone slippage', normalizeDate('2024-01-01'), '2024-01-01');

/* --------------------------------------------------------------- numbers */

eq('money strips symbols', normalizeNumber('$4,280.00', { money: true }), '4280.00');
eq('money pads cents', normalizeNumber('4280', { money: true }), '4280.00');
eq('hours suffix stripped', normalizeNumber('6 hrs', { money: false }), '6');
eq('decimal hours', normalizeNumber('6.5', { money: false }), '6.5');
eq('prose rejected', normalizeNumber('about six', { money: false }), null);
eq('empty rejected', normalizeNumber('', { money: true }), null);

// Bug 2a: three concatenated line-item numbers are not a $15M fact.
eq('malformed comma grouping rejected, not coerced', normalizeNumber('150,200,75', { money: true }), null);
eq('correct thousands grouping still accepted', normalizeNumber('$150,200.75', { money: true }), '150200.75');
eq('single stray comma (2-digit group) rejected', normalizeNumber('12,3', { money: true }), null);
eq('leading zero group rejected', normalizeNumber('1,0345', { money: true }), null);

// Bug 2b: huge magnitudes must never reach toFixed's exponential-notation
// range, and are suspicious long before they get there.
eq('absurd magnitude rejected outright', normalizeNumber('100000000000000000000000000', { money: true }), null);
check('never emits exponential notation',
  !/e/i.test(normalizeNumber('999999999999999999999999999', { money: true }) ?? ''));
eq('large-but-plausible cost still accepted', normalizeNumber('482000.50', { money: true }), '482000.50');
eq('negative absurd magnitude rejected', normalizeNumber('-100000000000000000000', { money: true }), null);
eq('magnitude boundary itself rejected (1e8)', normalizeNumber(String(1e8), { money: true }), null);
eq('just under the boundary accepted', normalizeNumber(String(1e8 - 1), { money: true }), '99999999.00');
// The ceiling used to be 1e15, which was the toFixed-safety margin wearing the
// word "plausible": a garbled extraction could store a cost of nearly one
// quadrillion dollars as a legitimate fact. These two bracket the real bound.
eq('a quadrillion-dollar cost is not a cost', normalizeNumber('999999999999999', { money: true }), null);
eq('a large commercial job is still a cost', normalizeNumber('87450.00', { money: true }), '87450.00');
eq('a big rooftop unit replacement is still a cost', normalizeNumber('$1,250,000.00', { money: true }), '1250000.00');
eq('negative zero normalizes cleanly', normalizeNumber('-0', { money: true }), '0.00');

// Adversarial: a value with a toString() must not be coerced into a number —
// only a real string or number from the model's tool call is a value.
eq('object with numeric-looking toString rejected', normalizeNumber({ toString: () => '4280' }, { money: true }), null);
eq('array input rejected', normalizeNumber(['4280'], { money: true }), null);

/* ---------------------------------------------------------------- fields */

{
  const { fields, dropped } = normalizeFields(
    [
      { key: 'serial_number', value: ' CG-4021-A ', page_no: 1, confidence: 0.9 },
      { key: 'warranty_expires', value: '03/10/2034', page_no: 2, confidence: 0.8 },
      { key: 'cost', value: '$4,280.00', page_no: 1, confidence: 0.95 },
      { key: 'not_a_field', value: 'x', page_no: 1, confidence: 1 },
      { key: 'installation_date', value: 'next spring', page_no: 1, confidence: 0.4 },
      { key: 'model', value: '   ', page_no: 1, confidence: 0.9 },
    ],
    { pageCount: 2 }
  );
  const by = Object.fromEntries(fields.map((f) => [f.field_key, f.value]));
  eq('serial trimmed', by.serial_number, 'CG-4021-A');
  eq('date normalized', by.warranty_expires, '2034-03-10');
  eq('money normalized', by.cost, '4280.00');
  check('unknown key dropped', !('not_a_field' in by));
  check('unparseable date dropped', !('installation_date' in by));
  check('blank value dropped', !('model' in by));
  eq('three drops recorded', dropped.length, 3);
}

{
  // A page number outside the document is a hallucinated citation. Keep the
  // value, drop the citation — an uncited fact beats a falsely cited one.
  const { fields } = normalizeFields(
    [{ key: 'model', value: '24ABC6', page_no: 99, confidence: 0.9 }],
    { pageCount: 2 }
  );
  eq('out-of-range page cleared', fields[0].page_no, null);
  eq('value survives', fields[0].value, '24ABC6');
}

{
  const { fields } = normalizeFields(
    [{ key: 'model', value: 'A', page_no: 1, confidence: 5 },
     { key: 'technician', value: 'B', page_no: 1, confidence: -2 },
     { key: 'status', value: 'C', page_no: 1 }],
    { pageCount: 1 }
  );
  const by = Object.fromEntries(fields.map((f) => [f.field_key, f.confidence]));
  eq('confidence clamped high', by.model, 1);
  eq('confidence clamped low', by.technician, 0);
  eq('missing confidence defaults', by.status, 0.5);
}

{
  // Non-repeatable: highest confidence wins. Repeatable: every distinct value
  // is kept, because a service report legitimately lists several work items.
  const { fields } = normalizeFields(
    [
      { key: 'model', value: 'WRONG', page_no: 3, confidence: 0.4 },
      { key: 'model', value: 'RIGHT', page_no: 1, confidence: 0.95 },
      { key: 'work_performed', value: 'replaced capacitor', page_no: 1, confidence: 0.9 },
      { key: 'work_performed', value: 'Replaced Capacitor', page_no: 2, confidence: 0.9 },
      { key: 'work_performed', value: 'flushed condensate line', page_no: 1, confidence: 0.9 },
    ],
    { pageCount: 3 }
  );
  const models = fields.filter((f) => f.field_key === 'model');
  eq('one model kept', models.length, 1);
  eq('highest confidence wins', models[0].value, 'RIGHT');
  const work = fields.filter((f) => f.field_key === 'work_performed');
  eq('repeatable keeps distinct values', work.length, 2);
  check('case-duplicate collapsed', !work.some((w) => w.value === 'Replaced Capacitor'));
}

{
  // Tie on confidence goes to the earlier page: on HVAC paperwork the plate
  // data is printed before the summary that restates it.
  const { fields } = normalizeFields(
    [{ key: 'serial_number', value: 'LATE', page_no: 9, confidence: 0.8 },
     { key: 'serial_number', value: 'EARLY', page_no: 1, confidence: 0.8 }],
    { pageCount: 9 }
  );
  eq('tie breaks to earlier page', fields[0].value, 'EARLY');
}

eq('garbage input yields nothing', normalizeFields(null, { pageCount: 1 }).fields, []);
eq('non-array input yields nothing', normalizeFields('nope', { pageCount: 1 }).fields, []);

{
  // A model returning a nested object instead of a string must not become the
  // literal text "[object Object]" stored as a fact.
  const { fields, dropped } = normalizeFields(
    [
      { key: 'model', value: { nested: 'oops' }, page_no: 1, confidence: 0.9 },
      { key: 'notes', value: ['a', 'b'], page_no: 1, confidence: 0.9 },
      { key: 'labor_hours', value: 6, page_no: 1, confidence: 0.9 }, // a bare number is fine
    ],
    { pageCount: 1 }
  );
  check('object value dropped, not stringified', !fields.some((f) => f.value === '[object Object]'));
  check('array value dropped, not stringified', !fields.some((f) => f.value.includes('a,b')));
  const hours = fields.find((f) => f.field_key === 'labor_hours');
  eq('numeric raw value still accepted', hours?.value, '6');
  check('two non-string drops recorded', dropped.filter((d) => d.reason.includes('non-string value')).length === 2);
}

{
  // NUL and other C0 controls must never reach a value or citation string —
  // NUL is fatal to Postgres TEXT outright.
  const { fields } = normalizeFields(
    [{ key: 'serial_number', value: 'CG-\x00-4021\x07A', page_no: 1, confidence: 0.9, verbatim: 'S/N:\x00 CG-4021-A' }],
    { pageCount: 1 }
  );
  eq('control chars stripped from value', fields[0].value, 'CG--4021A');
  eq('control chars stripped from verbatim', fields[0].verbatim, 'S/N: CG-4021-A');
}

eq('stripControlChars removes NUL and other C0 controls', stripControlChars('a\x00b\x01c\x1fd'), 'abcd');
eq('stripControlChars keeps tab/newline/CR', stripControlChars('a\tb\nc\rd'), 'a\tb\nc\rd');

{
  // A dunder-shaped key is just an unknown field key here — normalizeFields
  // looks it up in a Map, never assigns onto a plain object, so there is no
  // prototype-pollution path. Confirms it's dropped like any other unknown key.
  const { fields, dropped } = normalizeFields([{ key: '__proto__', value: 'x', page_no: 1, confidence: 1 }], { pageCount: 1 });
  eq('dunder key produces no fields', fields, []);
  eq('dunder key dropped as unknown field', dropped[0]?.reason, 'unknown field');
}

/* ----------------------------------------------------------- page budget */

{
  const small = [
    { page_no: 1, text: 'alpha' },
    { page_no: 2, text: 'beta' },
    { page_no: 3, text: '   ' },
  ];
  const { pages, truncated } = selectPages(small, 1000);
  eq('blank pages dropped', pages.length, 2);
  check('short document not truncated', truncated === false);
}

{
  // Over budget: the page carrying the serial must survive even though it is
  // page 37 and the prose pages came first.
  const filler = (n) => ({ page_no: n, text: 'general terms and conditions '.repeat(40) });
  const long = [];
  for (let i = 1; i <= 36; i++) long.push(filler(i));
  long.push({ page_no: 37, text: 'Serial: CG-4021-A  Warranty expires 2034-03-10  $4,280.00' });

  const { pages, truncated } = selectPages(long, 3000);
  check('long document reports truncation', truncated === true);
  check('identifier page survives the cut', pages.some((p) => p.page_no === 37),
    `kept pages: ${pages.map((p) => p.page_no).join(',')}`);
  const order = pages.map((p) => p.page_no);
  check('kept pages stay in order', JSON.stringify(order) === JSON.stringify([...order].sort((a, b) => a - b)));
  const used = pages.reduce((n, p) => n + p.text.length, 0);
  check('budget respected', used <= 3000, `used ${used}`);
}

eq('empty input is safe', selectPages([], 100).pages, []);
eq('null input is safe', selectPages(null, 100).pages, []);

/* ------------------------------------------------------------ tool schema */

{
  const enumKeys = EXTRACT_TOOL.input_schema.properties.fields.items.properties.key.enum;
  check('tool enum matches the field registry',
    JSON.stringify(enumKeys) === JSON.stringify(FIELD_KEYS),
    'the model can only return keys the normalizer accepts');
  const required = EXTRACT_TOOL.input_schema.properties.fields.items.required;
  check('page_no is required of the model', required.includes('page_no'));
  check('no duplicate field keys', new Set(FIELD_KEYS).size === FIELD_KEYS.length);
}

/* ----------------------------------------------------- document_type parsing */

{
  const typeEnum = EXTRACT_TOOL.input_schema.properties.document_type.enum;
  eq('document_type enum matches the canonical list', typeEnum, DOCUMENT_TYPES.map((t) => t.id));
  check('document_type is required of the model', EXTRACT_TOOL.input_schema.required.includes('document_type'));
  check('permit_number is now an extractable field (needed for the permit type)', FIELD_KEYS.includes('permit_number'));
}

{
  const prompt = buildExtractPrompt([{ page_no: 1, text: 'hello' }], 'invoice');
  check('prompt lists every canonical type id', DOCUMENT_TYPES.every((t) => prompt.includes(t.id)));
  check('prompt tells the model to pick exactly one', /exactly the one id/i.test(prompt));
}

{
  // Robust parsing: a valid model answer is trusted; junk falls back to the
  // deterministic heuristic. See verify-doctypes.mjs for the heuristic's own
  // coverage — this just confirms extractDocument.js's entry point wires up.
  const good = resolveDocumentType({ document_type: 'work-order', document_type_confidence: 0.8 }, { service_date: '2024-01-01', technician: 'Bob' }, 'x.pdf');
  eq('valid tool output is used as-is', good.documentType, 'work-order');

  const junk = resolveDocumentType({ document_type: 'not-a-type', document_type_confidence: 'NaN' }, { cost: '5' }, 'x.pdf');
  check('junk tool output falls back to a canonical id, never null', DOCUMENT_TYPE_IDS.has(junk.documentType));

  const missing = resolveDocumentType(null, {}, 'x.pdf');
  eq('missing tool_use input falls back to "other" via the heuristic', missing.documentType, 'other');
}

/* --------------------------------------------------------- media-type sniffing */

// Bug 3: HEIC magic bytes (ISO-BMFF 'ftyp' box + brand) must be recognized,
// not just PDF/JPEG/PNG/GIF.
{
  const heicBox = Buffer.concat([
    Buffer.from([0, 0, 0, 24]),               // box size (arbitrary, unchecked)
    Buffer.from('ftyp', 'latin1'),
    Buffer.from('heic', 'latin1'),             // major brand
    Buffer.from([0, 0, 0, 0]),                 // minor version
  ]);
  eq('HEIC ftyp/heic brand detected', sniffMagicBytes(heicBox), 'image/heic');

  const heifSeq = Buffer.concat([
    Buffer.from([0, 0, 0, 20]),
    Buffer.from('ftyp', 'latin1'),
    Buffer.from('mif1', 'latin1'),
    Buffer.from([0, 0, 0, 0]),
  ]);
  eq('HEIF mif1 brand detected', sniffMagicBytes(heifSeq), 'image/heic');

  eq('HEIC by extension when bytes are inconclusive', sniff(Buffer.from('not a real image'), 'IMG_0001.heic'), 'image/heic');
}

{
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
  eq('JPEG still detected by magic bytes', sniffMagicBytes(jpeg), 'image/jpeg');
  const webp = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP', 'latin1')]);
  eq('WEBP detected by magic bytes', sniffMagicBytes(webp), 'image/webp');
  eq('inconclusive bytes sniff to null', sniffMagicBytes(Buffer.from('hello world')), null);
  eq('too-short buffer is safe', sniffMagicBytes(Buffer.from([1, 2])), null);
  eq('empty buffer is safe', sniffMagicBytes(Buffer.alloc(0)), null);
}

{
  // Adversarial: truncated/malformed boxes must fail closed (null), never throw
  // and never misidentify.
  eq('truncated ftyp box is safe', sniffMagicBytes(Buffer.from([0, 0, 0, 0x18, 0x66, 0x74])), null);
  eq('ftyp with brand cut off is safe', sniffMagicBytes(Buffer.from('\x00\x00\x00\x18ftyphe', 'latin1')), null);
  const genericMp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp', 'latin1'), Buffer.from('isom', 'latin1')]);
  eq('ftyp with an unrelated brand (video, not HEIC) is not misidentified', sniffMagicBytes(genericMp4), null);
  eq('truncated PDF header is safe', sniffMagicBytes(Buffer.from('%PD')), null);
  eq('truncated PNG header is safe', sniffMagicBytes(Buffer.from([0x89, 0x50, 0x4e, 0x47])), null);

  // Bug 3's core guarantee: real JPEG bytes must win over a lying .heic
  // extension, and real bytes must win over a lying .jpg extension too.
  const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
  eq('JPEG bytes beat a .heic extension', sniff(jpegBytes, 'fake.heic'), 'image/jpeg');
  const heicBytes = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp', 'latin1'), Buffer.from('heic', 'latin1')]);
  eq('HEIC bytes beat a .jpg extension', sniff(heicBytes, 'vacation.jpg'), 'image/heic');
}

{
  // chunkText still produces sane pages; unrelated to the HEIC fix but cheap
  // to guard since ingestDocument's control-char stripping runs on its output.
  eq('chunkText handles empty input', chunkText(''), [{ page_no: 1, text: '' }]);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll extraction checks passed.');
process.exit(failures ? 1 : 0);
