/**
 * R33 (2026-09-30) — "a printed, clearly labelled date must never become missing".
 *
 * Live defect, tenant "Sonoran Comfort Air": 118-service-ticket-c23.pdf prints "Date of Service: 10/19/2028"; the Inbox
 * said "Missing information — Service date" and "Not confident enough yet — this still needs a person". Root cause:
 * extractFields.js DROPPED a service_date more than 18 months ahead of today (isBeyondFutureWindow), so the document
 * then looked like it never stated one. No network, no model, no DATABASE_URL: pure checks + a real Postgres (PGlite,
 * loaded from M3-config/*.sql, queried as the RLS-restricted app role) for the re-check repair path.
 *
 *   1. the exact Sonoran case, end to end from PDF bytes: text layer -> deterministic extractor -> validator ->
 *      completeness -> Inbox wording (value kept, flagged far_future, NOT missing, no model needed)
 *   2. date format + label variant tables (normalizeDate, the text extractor, the label scan), D/M hints, strict refusal
 *   3. the "obvious fields" benchmark (scripts/fixtures/obvious-fields-r33.mjs): required-field recall/precision >= 99.5%
 *   4. downstream consumers: warranty clock, unit grouping, follow-ups, maintenance-due, every SQL reader of the
 *      canonical date keys — none ever sees an unconfirmed far-future date
 *   5. re-check repair on PGlite: idempotent, provenance 'recheck', tenant-isolated, bounded batch, confirm clears,
 *      Verify-with-AI runs it, re-extraction converges, mixed-document tenant
 *   6. wiring: review.js actions, cron sweep step, Inbox buttons, api/ still 12 top-level files
 *
 *   npx tsx scripts/verify-r33-dates.mjs          (package.json: verify:r33-dates)
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.join(ROOT, p);
let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

process.env.NEON_CONNECTION_STRING = 'postgres://harness:harness@localhost:5432/harness';
delete process.env.ANTHROPIC_API_KEY;
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && (a[0].startsWith('{"route"') || a[0].startsWith('{"event"'))) return; realLog(...a); };

const TODAY = '2026-09-30';
const EF = await import(rel('api/_lib/extractFields.js'));
const TE = await import(rel('api/_lib/modelAvoidance/textExtract.js'));
const LF = await import(rel('api/_lib/modelAvoidance/labelFill.js'));
const DT = await import(rel('api/_lib/documentTypes.js'));
const { readPdfTextLayer } = await import(rel('api/_lib/modelAvoidance/pdfText.js'));
const { deriveWarranty } = await import(rel('api/_lib/warrantyRules.js'));

/* ------------------------------------------------------------------ tiny PDF writer (same as verify-r32) */
function makePdf(lines, { flate = false } = {}) {
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };
  add(''); add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const ops = ['BT', '/F1 11 Tf', '13 TL', '50 760 Td'];
  for (const ln of lines) ops.push(`(${esc(ln)}) Tj`, 'T*');
  ops.push('ET');
  const raw = Buffer.from(ops.join('\n'), 'latin1');
  const data = flate ? zlib.deflateSync(raw) : raw;
  const c = add({ stream: data, dict: `<< /Length ${data.length}${flate ? ' /Filter /FlateDecode' : ''} >>` });
  const pg = add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${c} 0 R >>`);
  objs[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[1] = `<< /Type /Pages /Kids [${pg} 0 R] /Count 1 >>`;
  const parts = [Buffer.from('%PDF-1.4\n')]; const offs = []; let len = parts[0].length;
  objs.forEach((o, i) => {
    offs.push(len);
    const b = typeof o === 'string' ? Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`) : Buffer.concat([Buffer.from(`${i + 1} 0 obj\n${o.dict}\nstream\n`), o.stream, Buffer.from('\nendstream\nendobj\n')]);
    parts.push(b); len += b.length;
  });
  parts.push(Buffer.from(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${len}\n%%EOF\n`));
  return Buffer.concat(parts);
}

/* ================================================================== 1. the Sonoran case */
const SONORAN_LINES = [
  'Sonoran Comfort Air', '4410 E Baseline Rd, Mesa, AZ 85206', '(480) 555-0199  |  info@sonorancomfortair.com', '',
  'SERVICE TICKET', 'Date of Service: 10/19/2028', 'Customer: William Quintana', 'Service Address: 951 E Main St, Chandler, AZ 85224',
  'Customer phone: Cell: 480-555-0133', '', 'Equipment: Mitsubishi MUZ-FS40NA  Serial: M100025', 'Visit Type: Repair', '',
  'Work Performed:', '- Checked refrigerant charge', '- Replaced air filter', '', 'Notes: System operating normally after visit',
  'Technician: Marisol Vega', 'Status: Completed',
];
{
  // The local corpus copy of 118-service-ticket-c23.pdf prints 09/21/2026; production's prints 10/19/2028. Same layout:
  // read the real corpus PDF to prove the layout, then the exact production date through real PDF bytes.
  const corpusPdf = rel('test-docs/business/118-service-ticket-c23.pdf');
  if (fs.existsSync(corpusPdf)) {
    const real = readPdfTextLayer(fs.readFileSync(corpusPdf));
    const realText = real.pages?.map((p) => p.text).join('\n') ?? '';
    check('corpus 118-service-ticket-c23.pdf: same form (Sonoran letterhead, William Quintana, MUZ-FS40NA, "Date of Service:")',
      real.ok && /Sonoran Comfort Air/.test(realText) && /William Quintana/.test(realText) && /MUZ-FS40NA/.test(realText) && /^Date of Service: /m.test(realText));
  }
  for (const flate of [false, true]) {
    const pdf = readPdfTextLayer(makePdf(SONORAN_LINES, { flate }));
    check(`Sonoran (${flate ? 'Flate' : 'plain'} PDF): the text layer reads "Date of Service: 10/19/2028"`, pdf.ok && /Date of Service: 10\/19\/2028/.test(pdf.pages[0].text));
    const det = TE.extractFromText(pdf.pages);
    check(`Sonoran (${flate ? 'Flate' : 'plain'}): accepted by the deterministic extractor — no model needed for this typed PDF`, det.accepted && det.type === 'service-ticket', JSON.stringify(det).slice(0, 200));
    const sd = det.toolInput?.fields.find((f) => f.key === 'service_date');
    eq('  extractor reads the printed date exactly', sd?.value, '2028-10-19');
    const { fields, dropped } = EF.normalizeFields(det.toolInput.fields, { today: TODAY, pageCount: 1 });
    const kept = fields.find((f) => EF.baseKeyOf(f.field_key) === 'service_date');
    eq('  validator KEEPS it (nothing dropped), as printed, under service_date_unconfirmed, flagged future+far_future',
      [dropped.length, kept?.field_key, kept?.value, kept?.flags, kept?.unconfirmed_of], [0, 'service_date_unconfirmed', '2028-10-19', ['future', 'far_future'], 'service_date']);
    check('  ...and never as a canonical service_date (warranty/last-service/reminders keep ignoring it)', !fields.some((f) => f.field_key === 'service_date'));
    const comp = DT.completenessFor('service-ticket', fields);
    eq('  completeness: NOT missing; listed as unconfirmed; not auto-verifiable until a person confirms', [comp.missing, comp.unconfirmed, comp.complete], [[], ['service_date'], false]);
  }
  // The model path (a scanned copy of the same ticket): the model returns the date correctly; the validator used to drop it.
  const modelOut = [
    { key: 'service_date', value: '2028-10-19', page_no: 1, confidence: 0.95, verbatim: 'Date of Service: 10/19/2028' },
    { key: 'service_address', value: '951 E Main St, Chandler, AZ 85224', page_no: 1, confidence: 0.95 },
    { key: 'work_performed', value: 'Checked refrigerant charge', page_no: 1, confidence: 0.95 },
  ];
  const m = EF.normalizeFields(modelOut, { today: TODAY, pageCount: 1 });
  eq('Sonoran (model path): the model\'s correct reading survives the validator as unconfirmed, not dropped', [m.dropped.length, m.fields.find((f) => f.field_key === 'service_date_unconfirmed')?.value], [0, '2028-10-19']);
  // A model that MISSED the date entirely: the ingest label-fill finds it on the page.
  const missed = EF.normalizeFields(modelOut.filter((f) => f.key !== 'service_date'), { today: TODAY, pageCount: 1 }).fields;
  const plan = LF.planLabelFill({ type: 'service-ticket', fields: missed, pages: [{ page_no: 1, text: SONORAN_LINES.join('\n') }], today: TODAY, method: 'label-fill', pageCount: 1 });
  eq('Sonoran (model skipped the date): label-fill restores it from "Date of Service:" with provenance label-fill', plan.add.map((f) => [f.field_key, f.value, f.method, f.flags]), [['service_date_unconfirmed', '2028-10-19', 'label-fill', ['future', 'far_future']]]);
  // Within the window it is a plain scheduled date (canonical, flagged 'future'); in the past it carries no flags at all.
  eq('within the 18-month window: canonical service_date flagged future', EF.normalizeFields([{ key: 'service_date', value: '10/19/2027', confidence: 0.9 }], { today: TODAY }).fields.map((f) => [f.field_key, f.flags]), [['service_date', ['future']]]);
  eq('past: canonical, no flags', EF.normalizeFields([{ key: 'service_date', value: '10/19/2025', confidence: 0.9 }], { today: TODAY }).fields.map((f) => [f.field_key, 'flags' in f]), [['service_date', false]]);
  eq('installation_date beyond its 3-month window: kept as installation_date_unconfirmed', EF.normalizeFields([{ key: 'installation_date', value: '03/07/2027', confidence: 0.9 }], { today: TODAY }).fields.map((f) => f.field_key), ['installation_date_unconfirmed']);
  eq('warranty_registered_date keeps its tight rule but still shows the printed value (unconfirmed), never "missing"', EF.normalizeFields([{ key: 'warranty_registered_date', value: '11/27/2026', confidence: 0.9 }], { today: TODAY }).fields.map((f) => [f.field_key, f.value]), [['warranty_registered_date_unconfirmed', '2026-11-27']]);
  eq('warranty_expires (forward-looking) is never flagged', EF.normalizeFields([{ key: 'warranty_expires', value: '03/10/2034', confidence: 0.9 }], { today: TODAY }).fields.map((f) => [f.field_key, 'flags' in f]), [['warranty_expires', false]]);

  // Inbox wording (client modules, run under tsx).
  try {
    const DF = await import(rel('src/core/dateFlags.ts'));
    const CT = await import(rel('src/domains/hvac/documentTypes.ts'));
    const doc = { extracted: [
      { name: 'service_date_unconfirmed', value: '2028-10-19', confidence: 0.95, location: {} },
      { name: 'service_address', value: '951 E Main St, Chandler, AZ 85224', confidence: 0.95, location: {} },
      { name: 'work_performed', value: 'Checked refrigerant charge', confidence: 0.95, location: {} },
    ] };
    eq('Inbox: "Service date 10/19/2028 is in the future — check the year" (not "Missing information")', DF.unconfirmedDates(doc, TODAY).map((u) => [u.fieldKey, u.value, u.note]), [['service_date', '2028-10-19', 'Service date 10/19/2028 is in the future — check the year']]);
    const present = new Set(doc.extracted.map((f) => f.name));
    const met = (r) => r.split('|').some((k) => present.has(k) || present.has(`${k}_unconfirmed`)); // entityGraph.ts isRequirementMet, verbatim
    check('Inbox: the service-ticket requirement "service_date" is met (no missing-field issue, no "Missing information" banner)', met('service_date'));
    const egSrc = fs.readFileSync(rel('src/core/entityGraph.ts'), 'utf8');
    check('entityGraph.ts isRequirementMet accepts the _unconfirmed twin (the rule mirrored above)', /present\.has\(k\) \|\| present\.has\(`\$\{k\}\$\{UNCONFIRMED_SUFFIX\}`\)/.test(egSrc));
    eq('client completenessFor mirrors the server (missing none, unconfirmed service_date, complete false)', (() => { const c = CT.completenessFor('service-ticket', doc.extracted.map((f) => ({ field_key: f.name, value: f.value, confidence: f.confidence }))); return [c.missing, c.unconfirmed, c.complete]; })(), [[], ['service_date'], false]);
    const confirmed = { extracted: [...doc.extracted, { name: 'service_date', value: '', correctedValue: '2028-10-19', confidence: 1, location: {} }] };
    eq('Inbox: once confirmed (canonical value written), the chip goes and the twin row is hidden', [DF.unconfirmedDates(confirmed, TODAY).length, DF.visibleExtracted(confirmed.extracted).some((f) => f.name === 'service_date_unconfirmed')], [0, false]);
    eq('Inbox: an in-window future canonical date still gets a "check the year" chip', DF.futureDateNote('service_date', '2027-01-15', TODAY), 'Service date 01/15/2027 is in the future — check the year');
    eq('Inbox: a past date gets no chip', DF.futureDateNote('service_date', '2025-01-15', TODAY), null);
  } catch (err) {
    check('client modules importable (run this script with tsx)', false, err?.message);
  }
}

/* ================================================================== 2. variant tables */
const FX = await import(rel('scripts/fixtures/obvious-fields-r33.mjs'));
{
  const samples = [[2028, 10, 19], [2026, 1, 5], [2031, 12, 31], [2019, 7, 4], [2000, 2, 29]];
  let ok = 0, total = 0; const bad = [];
  for (const [name, fn] of FX.DATE_FORMATS) for (const [y, m, d] of samples) {
    if (/^(MM|M)[/.-]/.test(name) && m <= 12 && d <= 12 && m !== d) continue; // swappable dates are tested separately below
    total++;
    const got = EF.normalizeDate(fn(y, m, d));
    const want = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (got === want) ok++; else bad.push(`${name}: "${fn(y, m, d)}" -> ${got}`);
  }
  check(`normalizeDate: every US paperwork format in the variant table (${ok}/${total})`, ok === total, bad.join('; '));
  eq('normalizeDate: two-digit years pivot at 69/70', [EF.normalizeDate('10/19/28'), EF.normalizeDate('19-Oct-28'), EF.normalizeDate('6/1/95')], ['2028-10-19', '2028-10-19', '1995-06-01']);
  eq('normalizeDate: swappable date — US default, D/M on a hint, refused under conflicting hints', [EF.normalizeDate('05/11/2028'), EF.normalizeDate('05/11/2028', { order: 'dmy' }), EF.normalizeDate('05/11/2028', { order: 'strict' })], ['2028-05-11', '2028-11-05', null]);
  eq('normalizeDate: still refuses non-dates', [EF.normalizeDate('Unit 3'), EF.normalizeDate('13/45/2028'), EF.normalizeDate('1O/19/2O28'), EF.normalizeDate('Marine 5 2028'), EF.normalizeDate('1.5.25'), EF.normalizeDate('2024-02-31')], [null, null, null, null, null, null]);
  eq('detectDateOrder: US / day-first hint / both', [TE.detectDateOrder('Date: 10/19/2028'), TE.detectDateOrder('05/11/2028 printed 25/09/2026'), TE.detectDateOrder('05/11/2028 25/09/2026 12/25/2028')], ['mdy', 'dmy', 'strict']);

  const base = (labelLine) => ['Sonoran Comfort Air', '4410 E Baseline Rd, Mesa, AZ 85206', '', 'SERVICE TICKET', ...labelLine, 'Customer: William Quintana', 'Service Address: 951 E Main St, Chandler, AZ 85224', 'Work Performed: Checked refrigerant charge', 'Technician: Marisol Vega'].join('\n');
  const badLabels = [];
  for (const label of FX.SERVICE_DATE_LABELS) for (const layout of ['colon', 'nextline', 'nocolon', 'dash']) {
    const lines = layout === 'colon' ? [`${label}: 10/19/2028`] : layout === 'nextline' ? [`${label}:`, '10/19/2028'] : layout === 'nocolon' ? [`${label}    10/19/2028`] : [`${label} - 10/19/2028`];
    const r = TE.scanLabeledValues([{ page_no: 1, text: base(lines) }], { type: 'service-ticket' });
    const got = [...new Set((r.candidates.service_date ?? []).map((c) => c.value))];
    if (got.length !== 1 || got[0] !== '2028-10-19') badLabels.push(`${label}/${layout} -> ${JSON.stringify(got)}`);
  }
  check(`label scan: every service-date label variant x {colon, next line, no colon, dash} (${FX.SERVICE_DATE_LABELS.length * 4})`, !badLabels.length, badLabels.join('; '));
  const colonMissed = FX.SERVICE_DATE_LABELS.filter((l) => !TE.extractFromText([{ page_no: 1, text: base([`${l}: 10/19/2028`]) }]).toolInput?.fields.some((f) => f.key === 'service_date' && f.value === '2028-10-19'));
  check('text extractor: every service-date label variant with a colon is read deterministically', !colonMissed.length, colonMissed.join(', '));
  const otherLeaks = [];
  for (const label of FX.OTHER_DATE_LABELS) {
    const text = base([`${label}: 04/19/2029`]);
    const r = TE.scanLabeledValues([{ page_no: 1, text }], { type: 'service-ticket' });
    if (r.candidates.service_date?.length) otherLeaks.push(`scan:${label}`);
    const d = TE.extractFromText([{ page_no: 1, text }]);
    if (d.accepted && d.toolInput.fields.some((f) => f.key === 'service_date')) otherLeaks.push(`extract:${label}`);
  }
  check('"Next Service Due" / "Printed on" / "Follow-up" / "Scheduled For" ... are NEVER read as the service date', !otherLeaks.length, otherLeaks.join(', '));
  const nb = TE.scanLabeledValues([{ page_no: 1, text: base(['Billing Address: 9 Corporate Dr, Scottsdale, AZ 85251', 'Ship Date: 10/01/2026']) }], { type: 'service-ticket' });
  check('a qualified generic label ("Billing Address:", "Ship Date:") is not the service address/date', !(nb.candidates.service_address ?? []).some((c) => /Corporate/.test(c.value)) && !(nb.candidates.service_date ?? []).length);
  const tbl = TE.scanLabeledValues([{ page_no: 1, text: 'WORK ORDER\nCustomer: Linda Fitzgerald\nDate of Service | Technician | Status\n10/19/2028 | Danny Ochoa | Completed' }], { type: 'work-order' });
  eq('table layout: header row of labels + value row', [tbl.candidates.service_date?.[0]?.value, tbl.candidates.technician?.[0]?.value], ['2028-10-19', 'Danny Ochoa']);
  const dn = TE.scanLabeledValues([{ page_no: 1, text: 'Dispatch note - 12/13/2017\nCustomer: Thomas Mercer\nAddress: 137 W Southern Ave, Phoenix, AZ 85001\nNo cool.' }], { type: 'dispatch-note' });
  eq('dispatch note: the date in its title, the bare "Address:" below it', [dn.candidates.service_date?.[0]?.value, dn.candidates.service_address?.[0]?.value], ['2017-12-13', '137 W Southern Ave, Phoenix, AZ 85001']);
  const po = TE.scanLabeledValues([{ page_no: 1, text: 'PURCHASE ORDER\nPO #: PO-9004\nDate: 06/24/2021\nVendor: Baker Distributing\nFor job at: 248 W Guadalupe Rd, Phoenix, AZ 85001 (Amy Isaacson)\nTotal: $92.00' }], { type: 'purchase-order' });
  eq('purchase order: vendor (new field), job-at address + name, total; its bare Date is NOT a service date', [po.candidates.vendor?.[0]?.value, po.candidates.service_address?.[0]?.value, po.candidates.customer_name?.[0]?.value, po.candidates.cost?.[0]?.value, po.candidates.service_date], ['Baker Distributing', '248 W Guadalupe Rd, Phoenix, AZ 85001', 'Amy Isaacson', '92.00', undefined]);
  check('vendor is a real extraction field now (FIELD_SPECS + the model tool enum)', EF.FIELD_KEYS.includes('vendor') && EF.EXTRACT_TOOL.input_schema.properties.fields.items.properties.key.enum.includes('vendor'));
  check('model prompt: return printed dates as printed, never drop/shift a year; never use Next Service Due / Printed on as service_date', /Never drop, shift or "fix" a printed year/.test(EF.buildExtractPrompt([{ page_no: 1, text: 'x' }], 'service-ticket')) && /Next Service Due/.test(EF.buildExtractPrompt([{ page_no: 1, text: 'x' }], 'service-ticket')));
  const two = LF.planLabelFill({ type: 'service-ticket', fields: [], pages: [{ page_no: 1, text: 'SERVICE TICKET\nDate of Service: 09/14/2026\nService Date: 09/16/2026\nService Address: 1 Main St, Mesa, AZ 85201' }], today: TODAY });
  check('label-fill: two different printed service dates -> not guessed, reported ambiguous', !two.add.some((f) => EF.baseKeyOf(f.field_key) === 'service_date') && two.ambiguous.some((a) => a.key === 'service_date'));
}

/* ================================================================== 3. the obvious-fields benchmark */
const BEFORE_RECORDED = {
  // Measured 2026-09-30 by running this same harness against the pre-R33 modules (extractFields.js /
  // textExtract.js / documentTypes.js as of R32, kept outside the repo). Recorded, not recomputed: the old code is gone.
  deterministicOnly: { recall: 30.87, precision: 100.0, missingShown: 2979, of: 4309 },
  oracleModel: { recall: 93.18, precision: 100.0, missingShown: 294, of: 4309 },
};
const normV = (k, v) => k === 'cost' ? (Number.isFinite(Number(v)) ? Number(v).toFixed(2) : String(v)) : String(v ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
function oracleFields(c) {
  const out = [];
  for (const [k, v] of Object.entries(c.expect)) for (const x of Array.isArray(v) ? v : [v]) out.push({ key: k, value: x, page_no: 1, confidence: 0.9 });
  return out;
}
/** End to end exactly as ingest runs it: text extractor (or the model, here absent / an oracle) -> validator -> label fill. */
function pipeline(c, { oracle }) {
  const det = TE.extractFromText(c.pages);
  const raw = det.accepted ? det.toolInput.fields : (oracle ? oracleFields(c) : []);
  const type = det.accepted ? det.type : c.type;
  let { fields } = EF.normalizeFields(raw, { today: FX.TODAY, pageCount: 1 });
  fields = [...fields, ...LF.planLabelFill({ type, fields, pages: c.pages, today: FX.TODAY, method: 'label-fill', pageCount: 1 }).add];
  return { det, type, fields };
}
function measure(cases, { oracle }) {
  const per = {}; const misses = []; const wrongs = [];
  let total = 0, hit = 0, emitted = 0, correct = 0, missingShown = 0, accepted = 0;
  for (const c of cases) {
    const { det, type, fields } = pipeline(c, { oracle });
    if (det.accepted) accepted++;
    const byBase = new Map();
    for (const f of fields) { const b = EF.baseKeyOf(f.field_key); if (!byBase.has(b)) byBase.set(b, []); byBase.get(b).push(f); }
    const comp = DT.completenessFor(type, fields);
    const reqs = DT.REQUIRED_FIELDS[c.type] ?? [];
    const scored = new Set([...reqs.flatMap((r) => r.split('|')), ...Object.keys(c.mustNotEmit ?? {})]);
    for (const r of reqs) {
      const alts = r.split('|');
      if (!alts.some((k) => c.expect[k] != null) || alts.some((k) => c.recallExempt?.includes(k))) continue;
      const ok = alts.some((k) => {
        const exp = c.expect[k]; if (exp == null) return false;
        const got = (byBase.get(k) ?? []).map((f) => normV(k, f.value));
        return Array.isArray(exp) ? exp.every((e) => got.includes(normV(k, e))) : got.includes(normV(k, exp));
      });
      per[r] ??= { total: 0, hit: 0 }; per[r].total++; total++;
      if (ok) { per[r].hit++; hit++; } else misses.push(`${c.id} ${r}`);
      if (comp.missing.includes(r)) missingShown++;
    }
    for (const [b, list] of byBase) {
      if (!scored.has(b)) continue;
      for (const f of list) {
        const exp = c.expect[b];
        let ok;
        if (exp != null) ok = (Array.isArray(exp) ? exp : [exp]).some((e) => normV(b, e) === normV(b, f.value));
        else if (c.mustNotEmit?.[b]) ok = false;
        else continue;
        emitted++; if (ok) correct++; else wrongs.push(`${c.id} ${f.field_key}=${f.value}`);
      }
    }
  }
  return { total, hit, recall: (100 * hit) / total, emitted, correct, precision: emitted ? (100 * correct) / emitted : 100, missingShown, accepted, per, misses, wrongs };
}
{
  const cases = await FX.buildObviousFieldCases({ root: ROOT });
  const perKey = {};
  for (const c of cases) for (const r of DT.REQUIRED_FIELDS[c.type] ?? []) for (const k of r.split('|')) if (c.expect[k] != null) perKey[k] = (perKey[k] ?? 0) + 1;
  const bySource = cases.reduce((m, c) => ({ ...m, [c.source]: (m[c.source] ?? 0) + 1 }), {});
  realLog(`\nobvious-fields benchmark: ${cases.length} documents ${JSON.stringify(bySource)}; printed required values per field: ${JSON.stringify(perKey)}`);
  const thin = ['service_address', 'service_date', 'work_performed', 'technician', 'cost', 'serial_number', 'model', 'customer_name', 'vendor', 'agreement_term'].filter((k) => (perKey[k] ?? 0) < 120);
  check('benchmark: >= 120 printed cases for every required field key', !thin.length, thin.join(', '));
  check('benchmark: all nine document types present', FX.BENCH_TYPES.every((t) => cases.some((c) => c.type === t)));
  check('benchmark: includes the exact Sonoran case and corpus-derived documents', cases.some((c) => c.id === 'adv-sonoran-118') && cases.some((c) => c.source === 'corpus') && cases.some((c) => c.source === 'corpus-mutated'));
  const det = measure(cases, { oracle: false });
  const orc = measure(cases, { oracle: true });
  realLog(`  BEFORE (recorded)  deterministic-only: recall ${BEFORE_RECORDED.deterministicOnly.recall}%  precision ${BEFORE_RECORDED.deterministicOnly.precision}%  shown "missing" ${BEFORE_RECORDED.deterministicOnly.missingShown}/${BEFORE_RECORDED.deterministicOnly.of}`);
  realLog(`  BEFORE (recorded)  with a perfect model: recall ${BEFORE_RECORDED.oracleModel.recall}%  precision ${BEFORE_RECORDED.oracleModel.precision}%  shown "missing" ${BEFORE_RECORDED.oracleModel.missingShown}/${BEFORE_RECORDED.oracleModel.of}  (the validator dropping far-future dates)`);
  realLog(`  AFTER              deterministic-only: recall ${det.recall.toFixed(2)}% (${det.hit}/${det.total})  precision ${det.precision.toFixed(2)}% (${det.correct}/${det.emitted})  shown "missing" ${det.missingShown}  text-extractor accepted ${det.accepted}/${cases.length}`);
  realLog(`  AFTER              with a perfect model: recall ${orc.recall.toFixed(2)}% (${orc.hit}/${orc.total})  precision ${orc.precision.toFixed(2)}% (${orc.correct}/${orc.emitted})  shown "missing" ${orc.missingShown}`);
  for (const [r, v] of Object.entries(det.per)) realLog(`    ${r.padEnd(32)} recall ${((100 * v.hit) / v.total).toFixed(2).padStart(6)}% (${v.hit}/${v.total})`);
  check('AFTER, no model at all: required-field recall >= 99.5%', det.recall >= 99.5, det.misses.slice(0, 10).join('; '));
  check('AFTER, no model at all: field precision >= 99.5%', det.precision >= 99.5, det.wrongs.slice(0, 10).join('; '));
  check('AFTER, no model: no wrong value on any adversarial case (second dates, billing address, two techs, D/M, typos)', !det.wrongs.length, det.wrongs.slice(0, 10).join('; '));
  check('AFTER, perfect model: recall >= 99.5% and no printed far-future date is lost by the validator', orc.recall >= 99.5 && orc.precision >= 99.5, orc.misses.slice(0, 10).join('; '));
  check('AFTER: improvement over the recorded baseline on both measures', det.recall > BEFORE_RECORDED.deterministicOnly.recall && orc.recall > BEFORE_RECORDED.oracleModel.recall);
}

/* ================================================================== 4. downstream consumers */
{
  // Warranty clock: an unconfirmed far-future install date never becomes a registration deadline / expiry.
  const facts = { serial_number: 'F100002', manufacturer: 'Carrier', installation_date_unconfirmed: '2029-03-07' };
  const w = deriveWarranty(facts, null);
  const wc = deriveWarranty({ ...facts, installation_date: '2024-03-07' }, null);
  check('warranty clock ignores installation_date_unconfirmed (no deadline, no computed expiry)', !w.registrationDeadline && !w.expires && w.expiresBasis !== 'computed', JSON.stringify(w));
  check('...while a canonical install date still drives it (control)', !!wc.registrationDeadline || !!wc.expires, JSON.stringify(wc));
  // Unit grouping (findOrCreateEquipment's facts): the unconfirmed key is shared, never a unit's installation_date.
  const { units } = EF.groupFieldsByUnit([{ field_key: 'serial_number', value: 'A', unit_index: 1 }, { field_key: 'installation_date_unconfirmed', value: '2029-03-07', unit_index: 1 }]);
  check('equipment facts never carry installation_date from an unconfirmed reading', units.every((u) => u.facts.installation_date == null));
  // Follow-ups ask techs for MISSING fields: an unconfirmed date is not missing, so nobody is asked to re-supply it.
  const fu = fs.readFileSync(rel('api/_lib/followups.js'), 'utf8');
  check('follow-ups read completenessFor().missing (unconfirmed dates are excluded from it)', /completenessFor\(doc\?\.document_type, fields\)\.missing/.test(fu) && DT.completenessFor('service-ticket', [{ field_key: 'service_date_unconfirmed', value: '2028-10-19', confidence: 1 }]).missing.indexOf('service_date') === -1);
  // Every SQL reader of the canonical date keys matches the key EXACTLY — so a *_unconfirmed row is invisible to
  // "last service", maintenance-due, analytics, exports, the Donovan lookups (files this round may not edit).
  const offenders = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!/support$/.test(p)) walk(p); } else if (/\.(js|ts)$/.test(e.name)) {
    const src = fs.readFileSync(p, 'utf8');
    if (/field_key\s+(?:I?LIKE|~\*?|SIMILAR)\s/i.test(src) || /(?:LIKE|ILIKE)\s+'%?(?:service_date|installation_date|warranty_registered_date)/i.test(src) || /startsWith\(\s*['"](?:service_date|installation_date|warranty_registered_date)['"]/.test(src)) offenders.push(path.relative(ROOT, p));
  } } };
  walk(rel('api'));
  check('no code reads date keys by prefix/pattern (exact field_key match everywhere) -> unconfirmed rows are invisible downstream', !offenders.length, offenders.join(', '));
  const readers = ['api/_lib/maintenanceDue.js', 'api/_lib/fastPath.js', 'api/_lib/fastPathQuery.js', 'api/_lib/analytics.js', 'api/_lib/routes/analytics.js', 'api/_lib/relations/timeline.js', 'api/_lib/routes/export-csv.js'];
  const exact = readers.filter((f) => fs.existsSync(rel(f))).filter((f) => /'service_date'|"service_date"/.test(fs.readFileSync(rel(f), 'utf8')));
  check(`the main "last service"/maintenance/analytics/export readers reference the canonical key literally (${exact.length} files)`, exact.length >= 4);
  // Donovan's deterministic dossier quotes a far-future printed date only WITH a caveat.
  const { deterministicDossierSentences } = await import(rel('api/_lib/modelAvoidance/dossierText.js'));
  const ds = deterministicDossierSentences({ id: 'd', pages: [{ page_no: 1, text: SONORAN_LINES.join('\n') }] }, { today: TODAY });
  check('dossier sentence for the Sonoran ticket caveats the date ("printed date is in the future; unconfirmed")', /dated 2028-10-19 \(printed date is in the future; unconfirmed\)/.test(ds[0]?.text ?? ''), ds[0]?.text);
  check('extractDocument.js builds equipment facts from normalized fields (where far-future dates are already renamed)', /let facts = Object\.fromEntries\(fields\.map/.test(fs.readFileSync(rel('api/_lib/extractDocument.js'), 'utf8')));
}

/* ================================================================== 5. re-check repair, real Postgres (PGlite) */
let PGlite;
const contrib = {};
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  for (const key of ['uuid_ossp', 'pgcrypto', 'pg_trgm', 'btree_gin']) contrib[key] = (await import(`@electric-sql/pglite/contrib/${key}`))[key];
} catch (err) {
  realLog(`SKIP  database-backed checks: PGlite is not installed (${err?.message}).`);
}
if (PGlite) {
  const lite = new PGlite({ extensions: contrib });
  const cfgDir = rel('M3-config');
  for (const f of fs.readdirSync(cfgDir).filter((x) => /^\d\d.*\.sql$/.test(x) && !x.startsWith('99')).sort()) {
    try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch { /* same tolerance as verify-intake-autofill */ }
  }
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* */ }
  const role = (await lite.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'deepwell_rls'")).rows[0];
  check('harness: queries run as deepwell_rls (no superuser, no RLS bypass)', Boolean(role) && !role.rolsuper && !role.rolbypassrls);

  const pgMod = (await import('pg')).default;
  let tail = Promise.resolve();
  const lock = () => { let release; const p = new Promise((r) => { release = r; }); const prev = tail; tail = tail.then(() => p); return prev.then(() => release); };
  pgMod.Pool.prototype.connect = async function connect() {
    const release = await lock();
    await lite.exec('SET ROLE deepwell_rls');
    return { query: (sql, params) => lite.query(sql, params), release: () => { lite.exec('RESET ROLE').finally(release); } };
  };
  pgMod.Pool.prototype.query = async function query(sql, params) { const release = await lock(); try { return await lite.query(sql, params); } finally { release(); } };

  const { withTenant, getTenantContext } = await import(rel('api/_lib/recordsStore.js'));
  const RC = await import(rel('api/_lib/recheck.js'));
  const RS = await import(rel('api/_lib/reviewStore.js'));

  const ctxA = { tenantKey: 'org_sonoran', tenantName: 'Sonoran Comfort Air' };
  const ctxB = { tenantKey: 'org_other', tenantName: 'Other Shop' };
  const tenA = (await getTenantContext(ctxA.tenantKey, ctxA.tenantName)).id;
  const tenB = (await getTenantContext(ctxB.tenantKey, ctxB.tenantName)).id;
  let seq = 0;
  const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const nid = () => uid(++seq + 1000);
  async function makeEntity(tenantId, type, data) { const id = nid(); await lite.query(`INSERT INTO entities (id, tenant_id, entity_type, data, created_at, updated_at) VALUES ($1,$2,$3,$4::jsonb,NOW(),NOW())`, [id, tenantId, type, JSON.stringify(data)]); return id; }
  async function makeDoc(tenantId, { type, stage = 'linked', text, fields, entityId = null, linkTo = null, createdAt = null }) {
    const id = nid();
    await lite.query(`INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage, created_at) VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz, NOW()))`, [id, tenantId, `doc-${seq}.pdf`, type, `h-${id}`, stage, createdAt]);
    if (text != null) await lite.query(`INSERT INTO document_pages (tenant_id, document_id, page_no, text) VALUES ($1,$2,1,$3)`, [tenantId, id, text]);
    for (const f of fields ?? []) {
      const fid = nid();
      await lite.query(`INSERT INTO facets (id, tenant_id, document_id, page_no, segment_id, label_raw, value_raw, confidence, mapped_field_key, mapping_method, created_at) VALUES ($1,$2,$3,1,'field-extract',$4,$5,$6,$4,'registry',NOW())`, [fid, tenantId, id, f.key, f.value, f.confidence ?? 0.95]);
      await lite.query(`INSERT INTO extractions (id, tenant_id, document_id, entity_id, field_key, value, confidence, source_facet_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`, [nid(), tenantId, id, entityId, f.key, f.value, f.confidence ?? 0.95, fid]);
    }
    if (linkTo) await lite.query(`INSERT INTO document_entity_links (tenant_id, document_id, entity_id, confidence, linked_by, created_at) VALUES ($1,$2,$3,0.9,'ai',NOW())`, [tenantId, id, linkTo]);
    return id;
  }
  const rowsOf = async (tenantId, docId) => (await lite.query(`SELECT x.field_key, x.value, x.corrected_value, f.segment_id FROM extractions x LEFT JOIN facets f ON f.id = x.source_facet_id WHERE x.tenant_id = $1 AND x.document_id = $2 ORDER BY x.field_key`, [tenantId, docId])).rows;
  const stageOf = async (docId) => (await lite.query(`SELECT stage, verified_by FROM documents WHERE id = $1`, [docId])).rows[0];

  // ---- Sonoran Comfort Air, as production had it: the date was DROPPED at ingest, so the extraction has no service_date.
  const quintana = await makeEntity(tenA, 'customer', { customer_name: 'William Quintana', service_address: '951 E Main St, Chandler, AZ 85224' });
  const unit = await makeEntity(tenA, 'equipment', { serial_number: 'M100025', model: 'MUZ-FS40NA', manufacturer: 'Mitsubishi' });
  const ticketFields = [
    { key: 'customer_name', value: 'William Quintana' }, { key: 'service_address', value: '951 E Main St, Chandler, AZ 85224' },
    { key: 'serial_number', value: 'M100025' }, { key: 'work_performed', value: 'Checked refrigerant charge' }, { key: 'work_performed', value: 'Replaced air filter' },
    { key: 'technician', value: 'Marisol Vega' },
  ];
  const sonoran = await makeDoc(tenA, { type: 'service-ticket', text: SONORAN_LINES.join('\n'), fields: ticketFields, entityId: unit, linkTo: quintana, createdAt: '2026-09-29T10:00:00Z' });
  // A second ticket with a PAST date that was also missed (model skipped it) — this one can verify straight away.
  const pastText = SONORAN_LINES.join('\n').replace('10/19/2028', '09/21/2026');
  const pastTicket = await makeDoc(tenA, { type: 'service-ticket', text: pastText, fields: ticketFields, entityId: unit, linkTo: quintana, createdAt: '2026-09-28T10:00:00Z' });
  // Mixed documents in the same tenant: complete already; two different printed technicians (ambiguous); nothing labelled;
  // an invoice whose labelled install date was missed (warranty must re-derive); a verified document (never touched).
  const complete = await makeDoc(tenA, { type: 'work-order', text: 'WORK ORDER\nDate: 09/01/2026\nService Address: 1 A St, Mesa, AZ 85201\nTechnician: Ray Sutton', fields: [{ key: 'service_address', value: '1 A St, Mesa, AZ 85201' }, { key: 'service_date', value: '2026-09-01' }, { key: 'technician', value: 'Ray Sutton' }], entityId: unit, linkTo: quintana });
  const twoTechs = await makeDoc(tenA, { type: 'work-order', text: 'WORK ORDER\nDate of Service: 09/14/2026\nService Address: 2 B St, Mesa, AZ 85201\nTechnician: Danny Ochoa\nTechnician: Kevin Pratt', fields: [{ key: 'service_address', value: '2 B St, Mesa, AZ 85201' }, { key: 'service_date', value: '2026-09-14' }], entityId: unit, linkTo: quintana });
  const nothing = await makeDoc(tenA, { type: 'inspection-report', text: 'INSPECTION REPORT\nCustomer said all good.', fields: [{ key: 'service_address', value: '3 C St, Mesa, AZ 85201' }], entityId: unit, linkTo: quintana });
  const carrier = await makeEntity(tenA, 'equipment', { serial_number: 'CX-9001', manufacturer: 'Carrier' });
  const installInv = await makeDoc(tenA, { type: 'warranty-registration', text: 'WARRANTY REGISTRATION\nManufacturer: Carrier\nModel: 24ACC636A003\nSerial: CX-9001\nInstallation Date: 03/04/2024\nWarranty Term: 10 year parts limited', fields: [{ key: 'serial_number', value: 'CX-9001' }, { key: 'model', value: '24ACC636A003' }, { key: 'manufacturer', value: 'Carrier' }, { key: 'warranty_term', value: '10 year parts limited' }], entityId: carrier, linkTo: quintana });
  const verifiedDoc = await makeDoc(tenA, { type: 'service-ticket', stage: 'verified', text: SONORAN_LINES.join('\n'), fields: ticketFields.slice(0, 2), entityId: unit, linkTo: quintana });
  // Tenant B has the same broken document. It must never be touched by tenant A's re-check.
  const bCust = await makeEntity(tenB, 'customer', { customer_name: 'William Quintana' });
  const bDoc = await makeDoc(tenB, { type: 'service-ticket', text: SONORAN_LINES.join('\n'), fields: ticketFields, linkTo: bCust });

  // -- "Re-check this document" on the Sonoran ticket
  const r1 = await RC.recheckDocument(ctxA, sonoran, { actorClerkId: 'user_owner', source: 'inbox', today: TODAY });
  eq('re-check (Sonoran ticket): restores the printed date as service_date_unconfirmed, flagged far_future, provenance recheck', r1.filled.map((f) => [f.field_key, f.value, f.method, f.flags]), [['service_date_unconfirmed', '2028-10-19', 'recheck', ['future', 'far_future']]]);
  eq('...the document is no longer "missing" anything; the date waits for a confirm; not auto-verified', [r1.missingBefore, r1.completeness.missing, r1.completeness.unconfirmed, r1.aiVerified], [['service_date'], [], ['service_date'], false]);
  const rows1 = await rowsOf(tenA, sonoran);
  check('...written as facet + extraction under segment field-recheck (the provenance marker)', rows1.some((r) => r.field_key === 'service_date_unconfirmed' && r.value === '2028-10-19' && r.segment_id === 'field-recheck'));
  const audit = (await lite.query(`SELECT changes FROM audit_log WHERE tenant_id = $1 AND resource_id = $2 AND action = 'document.fields_rechecked'`, [tenA, sonoran])).rows;
  check('...audited as document.fields_rechecked {method: recheck, recheck_version, filled}', audit.length === 1 && audit[0].changes.method === 'recheck' && audit[0].changes.recheck_version === RC.RECHECK_VERSION && audit[0].changes.filled[0].field_key === 'service_date_unconfirmed');
  const r1b = await RC.recheckDocument(ctxA, sonoran, { today: TODAY });
  const rows1b = await rowsOf(tenA, sonoran);
  check('re-check is idempotent: a second run writes nothing', r1b.filled.length === 0 && rows1b.length === rows1.length);
  check('the unconfirmed far-future date is invisible to the canonical-key readers (SQL: field_key = \'service_date\')', (await lite.query(`SELECT 1 FROM extractions WHERE tenant_id = $1 AND document_id = $2 AND field_key = 'service_date'`, [tenA, sonoran])).rows.length === 0);

  // -- maintenance-due ("last service") on the same tenant: the 2028 reading never becomes the last visit.
  {
    const MD = await import(rel('api/_lib/maintenanceDue.js'));
    const intent = MD.parseMaintenanceDue('which customers are overdue for maintenance');
    const ans = intent ? await withTenant(ctxA, (db) => MD.runMaintenanceDue(db, intent, { today: TODAY })) : null;
    check('maintenance-due / last-visit answers never cite the unconfirmed 2028 date', !JSON.stringify(ans ?? {}).includes('2028-10-19') && !/10\/19\/2028|Oct(?:ober)? 19, 2028/.test(JSON.stringify(ans ?? {})));
  }

  // -- bulk: "Re-check all missing fields" / nightly sweep, mixed documents, bounded + version-skipping
  const bulk = await RC.recheckTenantMissing(ctxA, { limit: 2, today: TODAY, source: 'cron' });
  check(`bulk re-check is bounded (limit 2 of ${bulk.candidates} candidates; ${bulk.leftForNextRun} left for the next run)`, bulk.scanned === 2 && bulk.leftForNextRun === bulk.candidates - 2);
  const bulk2 = await RC.recheckTenantMissing(ctxA, { limit: 50, today: TODAY, source: 'cron' });
  const bulk3 = await RC.recheckTenantMissing(ctxA, { limit: 50, today: TODAY, source: 'cron' });
  check('the next run drains the rest; after that nothing is left to scan (version-skip) — the sweep converges', bulk2.scanned >= 1 && bulk3.candidates === 0, JSON.stringify({ bulk, bulk2, bulk3 }));
  const pastRows = await rowsOf(tenA, pastTicket);
  check('past-dated ticket: canonical service_date restored and the document AI-verifies (complete + linked)', pastRows.some((r) => r.field_key === 'service_date' && r.value === '2026-09-21') && (await stageOf(pastTicket)).verified_by === 'ai');
  check('two different printed technicians: not guessed (technician still missing, no wrong fill)', !(await rowsOf(tenA, twoTechs)).some((r) => r.field_key === 'technician'));
  check('nothing labelled on the page: nothing invented', (await rowsOf(tenA, nothing)).length === 1);
  check('complete document: untouched', (await rowsOf(tenA, complete)).length === 3);
  check('verified document: never re-checked', (await rowsOf(tenA, verifiedDoc)).length === 2);
  const carrierRow = (await lite.query(`SELECT data FROM entities WHERE id = $1`, [carrier])).rows[0];
  check('warranty registration missing its labelled install date: restored, and the unit\'s install date/warranty re-derived (fill-only)', (await rowsOf(tenA, installInv)).some((r) => r.field_key === 'installation_date' && r.value === '2024-03-04') && carrierRow.data.installation_date === '2024-03-04' && !!carrierRow.data.warranty, JSON.stringify(carrierRow.data));
  check('tenant isolation: tenant B\'s identical document was never touched by tenant A\'s sweep', (await rowsOf(tenB, bDoc)).every((r) => r.segment_id !== 'field-recheck'));
  const forced = await RC.recheckTenantMissing(ctxA, { limit: 50, today: TODAY, source: 'inbox-bulk', force: true });
  check('"Re-check all missing fields" (force) re-scans, writes nothing new (idempotent)', forced.fields === 0 && forced.rechecked >= 1, JSON.stringify(forced));
  const bRes = await RC.recheckTenantMissing(ctxB, { limit: 50, today: TODAY });
  check('tenant B\'s own sweep repairs tenant B\'s document', bRes.filled === 1 && (await rowsOf(tenB, bDoc)).some((r) => r.field_key === 'service_date_unconfirmed'));

  // -- Confirm (Inbox): correctField writes the canonical date and clears the parked twin.
  await RS.correctField(ctxA, { documentId: sonoran, fieldKey: 'service_date', value: '2028-10-19', by: 'Owner' }, 'user_owner');
  const rows2 = await rowsOf(tenA, sonoran);
  check('Confirm: canonical service_date = 2028-10-19 (human), the _unconfirmed twin is gone', rows2.some((r) => r.field_key === 'service_date' && r.corrected_value === '2028-10-19') && !rows2.some((r) => r.field_key === 'service_date_unconfirmed'));
  const after = DT.completenessFor('service-ticket', DT.toCompletenessFields(rows2));
  check('...and the document is complete', after.complete && !after.missing.length && !(after.unconfirmed ?? []).length);

  // -- Confirm/fix of a PARKED install date reaches the unit (fill-only) and the warranty clock; a confirmed FUTURE one never does.
  {
    const u1 = await makeEntity(tenA, 'equipment', { serial_number: 'CX-7001', manufacturer: 'Carrier' });
    const d1 = await makeDoc(tenA, { type: 'warranty-registration', text: 'WARRANTY REGISTRATION\nInstallation Date: 03/04/2029', fields: [{ key: 'serial_number', value: 'CX-7001' }, { key: 'model', value: '24ACC636A003' }, { key: 'warranty_term', value: '10 year parts limited' }, { key: 'installation_date_unconfirmed', value: '2029-03-04' }], entityId: u1, linkTo: quintana });
    await RS.correctField(ctxA, { documentId: d1, fieldKey: 'installation_date', value: '2024-03-04', by: 'Owner' }, 'user_owner');
    const data1 = (await lite.query(`SELECT data FROM entities WHERE id = $1`, [u1])).rows[0].data;
    check('fixing the year of a parked install date fills the unit (fill-only) and re-derives its warranty', data1.installation_date === '2024-03-04' && !!data1.warranty && !(await rowsOf(tenA, d1)).some((r) => r.field_key === 'installation_date_unconfirmed'), JSON.stringify(data1));
    const u2 = await makeEntity(tenA, 'equipment', { serial_number: 'CX-7002', manufacturer: 'Carrier' });
    const d2 = await makeDoc(tenA, { type: 'warranty-registration', text: 'x', fields: [{ key: 'serial_number', value: 'CX-7002' }, { key: 'installation_date_unconfirmed', value: '2029-03-04' }], entityId: u2, linkTo: quintana });
    await RS.correctField(ctxA, { documentId: d2, fieldKey: 'installation_date', value: '2029-03-04', by: 'Owner' }, 'user_owner');
    const data2 = (await lite.query(`SELECT data FROM entities WHERE id = $1`, [u2])).rows[0].data;
    check('...but confirming a FUTURE install date never feeds the warranty clock (unit install date stays empty)', !data2.installation_date && !data2.warranty, JSON.stringify(data2));
  }

  // -- "Verify with AI" on a document showing "Missing information" runs the $0 re-check first and explains itself.
  const aiDoc = await makeDoc(tenA, { type: 'service-ticket', text: SONORAN_LINES.join('\n'), fields: ticketFields, entityId: unit, linkTo: quintana });
  const ai = await RS.aiVerifyDocument(ctxA, { documentId: aiDoc }, 'user_owner');
  eq('Verify with AI: re-checks first, then reports the printed future date instead of a generic "needs a person"', [ai.verified, ai.recheck?.filled?.[0]?.field_key, ai.unconfirmedDates], [false, 'service_date_unconfirmed', [{ fieldKey: 'service_date', value: '2028-10-19' }]]);

  // -- a later full re-extraction converges: re-check rows are swept like extractor rows.
  await withTenant(ctxA, (db) => db.replaceDocumentFields(aiDoc, [{ field_key: 'service_address', value: '951 E Main St, Chandler, AZ 85224', confidence: 0.9, page_no: 1 }]));
  check('re-extraction replaces re-check rows (no stale duplicate left behind)', !(await rowsOf(tenA, aiDoc)).some((r) => r.segment_id === 'field-recheck'));

  // -- bad input
  let threw = null; try { await RC.recheckDocument(ctxA, 'not-a-uuid'); } catch (e) { threw = e; }
  check('recheckDocument rejects a non-uuid id with a 400', threw?.status === 400);
}

/* ================================================================== 6. wiring */
{
  const review = fs.readFileSync(rel('api/review.js'), 'utf8');
  check('api/review.js: recheckDocument + recheckMissing actions, rate-limited, bulk is admin-only', /'recheckDocument',/.test(review) && /'recheckMissing',/.test(review) && /case 'recheckMissing':\s*\n\s*requireAdmin\(auth\);/.test(review) && /INTEGRITY_RATE_LIMIT_ACTIONS = new Set\(\['recheckDocument', 'recheckMissing'/.test(review));
  const cron = fs.readFileSync(rel('api/_lib/routes/cron-sweep.js'), 'utf8');
  check('nightly cron sweep runs the bounded per-tenant re-check (deadline-aware, never fails the sweep)', /recheckTenantMissing\(ctx, \{ limit: 25, deadlineAt, source: "cron" \}\)/.test(cron) && /phase: "recheck"/.test(cron));
  const screen = fs.readFileSync(rel('src/screens/ReviewScreen.tsx'), 'utf8');
  check('Inbox: "Re-check this document" on the missing-field banner and admin "Re-check all missing fields"', /Re-check this document/.test(screen) && /Re-check all missing fields/.test(screen) && /disabled=\{recheckAllBusy \|\| !canAdmin\}/.test(screen));
  check('Inbox: "check the year" chip + Confirm button, and the specific Verify-with-AI message', /future-date-chip/.test(screen) && /Confirm \{p\.value\}/.test(screen) && /Confirm it \(or fix the year\) and this document can be verified/.test(screen));
  const apiTop = fs.readdirSync(rel('api')).filter((f) => !f.startsWith('_') && !f.startsWith('.'));
  eq('api/ still has exactly 12 top-level function files', apiTop.length, 12);
  const pkg = JSON.parse(fs.readFileSync(rel('package.json'), 'utf8'));
  check('package.json: verify:r33-dates exists and is part of verify:all', !!pkg.scripts['verify:r33-dates'] && /verify:r33-dates/.test(pkg.scripts['verify:all']));
  const newSql = fs.readdirSync(rel('M3-config')).filter((f) => /^6[2-9]-/.test(f) && !['62-rate-limit-refund-and-owner-overrides.sql', '63-page-count-index.sql', '64-records-search-indexes.sql', '65-scale-donovan-and-customers.sql', '66-staff-import-override.sql'].includes(f)); // R35's and later rounds' own migrations (64-66) are not R33's
  eq('no SQL schema change was needed (provenance rides on facets.segment_id)', newSql, []);
}

realLog('');
if (failures) { realLog(`${failures} check(s) FAILED, ${passes} passed.`); process.exit(1); }
realLog(`All ${passes} R33 date checks passed.`);
process.exit(0);
