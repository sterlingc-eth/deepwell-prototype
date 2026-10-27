/**
 * verify:license-barcode - the AAMVA PDF417 licence-barcode lane (api/_lib/modelAvoidance/licenseBarcode.js). No network, no key, no DB.
 * Every licence here is SYNTHETIC (invented names / numbers / dates, scripts/license-barcode/synth.mjs; barcodes drawn by bwip-js, a test-only devDependency).
 *   A. parser: 9 invented people across 9 states / provinces and AAMVA versions 1-10 -> exact fields; DOB / address / payload never in the page text
 *   B. images: clean, tilted (3..45 deg, 80-100 deg, 180), perspective, blur, glare, noise, small, 12 MP, PNG, JPEG-in-PDF, Flate-in-PDF, mixed PDF
 *   C. corrupt / invalid: bad header, truncated, bad directory, bad dates, expiry < issue, country mismatch, duplicate element, truncated name,
 *      ID-card subfile, unknown element, random payload, physically damaged symbol, blank and noise images -> ZERO barcode values and the
 *      vision path is used exactly as before
 *   D. end to end through readPdfOrImage with a stub model: decoded -> no model call; not decoded -> one model call, unchanged
 *   E. the field readers: page text -> license-certification keys (holder, number masked, class, issue, expiry, state, restrictions, endorsements)
 *   F. no false reads on ordinary pages (repo test documents) and the time cost
 *      node scripts/verify-license-barcode.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from './license-barcode/synth.mjs';
import { createRequire } from 'node:module';
const { parse: aamvaParserParse } = createRequire(import.meta.url)('aamva-parser'); // independent cross-check (MIT, devDependency, never imported by api/)
import { parseAamva, barcodePageText, readLicenseBarcodePages, BARCODE_MARKER } from '../api/_lib/modelAvoidance/licenseBarcode.js';
import * as PP from '../api/_lib/modelAvoidance/pdfPages.js';
import { readPdfOrImage, __setAnthropicClientFactoryForTests } from '../api/_lib/readDocument.js';
import { loadPipeline, runDoc } from './real-docs/pipeline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0, passes = 0;
const check = (name, ok, detail = '') => { if (ok) passes++; else failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${String(detail).slice(0, 500)}`}`); };
delete process.env.ANTHROPIC_API_KEY; delete process.env.LICENSE_BARCODE; delete process.env.MODEL_AVOIDANCE;
console.warn = () => {};
process.env.TRANSCRIBE_MODEL_FAST = 'test-fast'; process.env.TRANSCRIBE_MODEL_STRONG = 'test-strong';
delete process.env.TRANSCRIBE_MODEL; delete process.env.TRANSCRIBE_ESCALATE_BELOW; delete process.env.PDF_TEXT_LAYER;

const P0 = S.PEOPLE[0];
const titled = (p) => `${p.first}${p.mid && p.ver !== 1 ? ' ' + p.mid : p.mid ? ' ' + p.mid : ''} ${p.last}`.toLowerCase();
const want = (p) => ({ holder: titled(p), last4: p.num.replace(/[^A-Z0-9]/g, '').slice(-4), state: p.st, exp: ymd(p.exp), iss: ymd(p.iss) });
const ymd = (a) => `${a[0]}-${String(a[1]).padStart(2, '0')}-${String(a[2]).padStart(2, '0')}`;
const sameAs = (p, f) => f && f.holder_name.toLowerCase() === titled(p) && f.license_last4 === want(p).last4 && f.license_state === p.st && f.end_date === ymd(p.exp) && f.start_date === ymd(p.iss);
const privacyLeaks = (p, text) => {
  const leaks = [];
  const dob = p.dob; const f = p.country === 'CAN' ? [`${dob[0]}${String(dob[1]).padStart(2, '0')}${String(dob[2]).padStart(2, '0')}`] : [`${String(dob[1]).padStart(2, '0')}${String(dob[2]).padStart(2, '0')}${dob[0]}`];
  const dobForms = [...f, ymd(dob), `${String(dob[1]).padStart(2, '0')}/${String(dob[2]).padStart(2, '0')}/${dob[0]}`, String(dob[0])];
  for (const d of dobForms) if (text.includes(d)) leaks.push('dob:' + d);
  if (/INVENTED|EXAMPLETON|LANE|00001|\bDAQ\b|\bDCS\b|ANSI \d|\x1e/i.test(text)) leaks.push('address/payload');
  const solid = p.num.replace(/[^A-Z0-9]/g, ''); if (text.includes(p.num) || text.replace(/[^A-Z0-9]/gi, '').toUpperCase().includes(solid)) leaks.push('full number');
  return leaks;
};

/* ---------------------------------------------------------------- A. parser */
console.log('--- A. parser');
for (const p of S.PEOPLE) {
  const pl = S.payloadFor(p); const r = parseAamva(pl);
  check(`A ${p.st} v${p.ver}: parsed, exact fields`, r.ok && sameAs(p, r.fields), JSON.stringify(r));
  // cross-check against the independent aamva-parser package: where it reads a field, ours must agree
  try {
    const q = aamvaParserParse(pl);
    const lastOk = String(q.lastName ?? '').toUpperCase() === p.last || p.ver === 1;
    const numOk = p.ver === 1 || String(q.driversLicenseId ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').endsWith(want(p).last4);
    // aamva-parser reads every date as MMDDCCYY, so a Canadian CCYYMMDD date comes out as year 0412 / 0323: compared for US cards only (one reason this lane has its own strict parser)
    const expOk = p.country === 'CAN' ? q.expirationDate instanceof Date && q.expirationDate.getUTCFullYear() < 1000 : q.expirationDate instanceof Date && q.expirationDate.toISOString().slice(0, 10) === ymd(p.exp);
    check(`A ${p.st}: agrees with aamva-parser (last name, number tail, US expiry; it misreads Canadian dates, we do not)`, lastOk && numOk && expOk, JSON.stringify({ last: q.lastName, num: q.driversLicenseId?.length, exp: q.expirationDate }));
  } catch (e) { check(`A ${p.st}: aamva-parser cross-check ran`, false, e.message); }
  if (r.ok) {
    const text = barcodePageText(r.fields);
    const lk = privacyLeaks(p, text);
    check(`A ${p.st}: page text has no DOB / address / full number / payload`, lk.length === 0, lk.join(',') + '\n' + text);
    check(`A ${p.st}: marker line first`, text.startsWith(BARCODE_MARKER + '\nDRIVER LICENSE\n'));
    check(`A ${p.st}: class ${p.cls} ${/^[A-D]$/.test(p.cls) ? 'kept' : 'left blank (not a CDL-style A-D class)'}`, /^[A-D]$/.test(p.cls) ? r.fields.license_class === p.cls : r.fields.license_class === null);
  }
}
check('A US dates MMDDCCYY and Canadian CCYYMMDD read to the same ISO form', parseAamva(S.payloadFor(S.PEOPLE[0])).fields.end_date === '2030-06-20' && parseAamva(S.payloadFor(S.PEOPLE[7])).fields.end_date === '2027-04-11');
check('A name suffix / NONE middle / comma first names', (() => { const q = { ...P0, mid: '', first: 'ANA,MARIA' }; const r = parseAamva(S.payloadFor(q)); return r.ok && r.fields.holder_name === 'Ana Maria Testcase'; })());
check('A McNames title-cased', (() => { const q = { ...P0, last: 'MCDONALD', first: 'IAN', mid: '' }; const r = parseAamva(S.payloadFor(q)); return r.ok && r.fields.holder_name === 'Ian McDonald'; })());

/* ---------------------------------------------------------------- C (parser half). corrupt / invalid payloads */
console.log('--- C. corrupt payloads (valid symbol, invalid AAMVA)');
const good = S.payloadFor(P0);
const mut = (f) => f(good);
const bads = {
  'header: no ANSI': mut((s) => s.replace('ANSI ', 'ANSX ')),
  'header: no compliance indicator': mut((s) => s.slice(1)),
  'header: unknown version': mut((s) => s.replace('636000090001DL', '636000990001DL')),
  'truncated mid-subfile': good.slice(0, 90),
  'truncated at header': good.slice(0, 18),
  'directory offset beyond payload': mut((s) => s.replace('DL0031', 'DL9931')),
  'directory length beyond payload': mut((s) => s.replace('0214', '9914')),
  'directory type mismatch': mut((s) => s.replace('DLDAQ', 'XXDAQ')),
  'expiry not a date (month 13)': S.buildAamva({ iin: '636000', version: 9, elements: S.personElements(P0, { overrides: { DBA: '13202030' } }) }),
  'expiry Feb 30': S.buildAamva({ iin: '636000', version: 9, elements: S.personElements(P0, { overrides: { DBA: '02302030' } }) }),
  'expiry before issue': S.buildAamva({ iin: '636000', version: 9, elements: S.personElements(P0, { overrides: { DBA: '06202019' } }) }),
  'DOB not a date': S.buildAamva({ iin: '636000', version: 9, elements: S.personElements(P0, { overrides: { DBB: '99999999' } }) }),
  'state not a jurisdiction': S.buildAamva({ iin: '636000', version: 9, elements: S.personElements(P0, { overrides: { DAJ: 'ZZ' } }) }),
  'country USA with a Canadian province': S.buildAamva({ iin: '636000', version: 9, elements: S.personElements(P0, { overrides: { DAJ: 'ON' } }) }),
  'name truncated flag': S.buildAamva({ iin: '636000', version: 9, elements: S.personElements(P0, { overrides: { DDE: 'T' } }) }),
  'name has digits': S.buildAamva({ iin: '636000', version: 9, elements: S.personElements(P0, { overrides: { DCS: 'TEST4CASE' } }) }),
  'no name': S.buildAamva({ iin: '636000', version: 9, elements: S.personElements(P0, { drop: ['DCS', 'DAC'] }) }),
  'no number': S.buildAamva({ iin: '636000', version: 9, elements: S.personElements(P0, { drop: ['DAQ'] }) }),
  'number too short': S.buildAamva({ iin: '636000', version: 9, elements: S.personElements(P0, { overrides: { DAQ: '12' } }) }),
  'no expiry': S.buildAamva({ iin: '636000', version: 9, elements: S.personElements(P0, { drop: ['DBA'] }) }),
  'two different numbers': S.buildAamva({ iin: '636000', version: 9, elements: [...S.personElements(P0), ['DAQ', 'Z99999999']] }),
  'unknown element line': S.buildAamva({ iin: '636000', version: 9, elements: [...S.personElements(P0), ['', 'garbage line']] }),
  'identification card (ID) subfile, not a licence': good.replace('DLDAQ', 'IDDAQ').replace('DL00310214', 'ID00310214'),
  'random text': 'The quick brown fox ' + 'jumps over the lazy dog. '.repeat(12),
  'empty': '',
};
for (const [name, pl] of Object.entries(bads)) { const r = parseAamva(pl); check(`C parse rejects: ${name}`, r.ok === false, JSON.stringify(r).slice(0, 200)); }

/* ---------------------------------------------------------------- B. images -> decode */
console.log('--- B. rendered images');
const bar0 = S.renderPdf417(good); const card0 = S.cardBack(bar0, { seed: 11 });
const timings = [];
async function readImg(buf, type, p = P0, name = '') {
  const st = {}; const t0 = Date.now();
  const r = await readLicenseBarcodePages(buf, type, { stats: st, ...(type === 'application/pdf' ? { pdfLib: PP } : {}) });
  timings.push({ name, ms: Date.now() - t0 });
  return { r, st };
}
const variants = {
  'clean': card0, 'tilt 3': S.rotate(card0, 3), 'tilt 7': S.rotate(card0, 7), 'tilt -12': S.rotate(card0, -12), 'tilt 25': S.rotate(card0, 25), 'tilt -40': S.rotate(card0, -40),
  'quarter turn 90': S.rotate(card0, 90), 'quarter turn 270': S.rotate(card0, -90), 'near 90 (80)': S.rotate(card0, 80), 'upside down 180': S.rotate(card0, 180),
  'perspective 0.25': S.perspective(card0, 0.25), 'blur r2': S.blur(card0, 2), 'glare hot spot': S.glare(card0, 0.3, 0.55, 0.25, 0.8), 'sensor noise': S.noise(card0, 40),
  'small 900 px': S.scaleTo(card0, 900),
  'photo style: tilt 9 + perspective + glare + noise': S.noise(S.glare(S.rotate(S.perspective(card0, 0.15), 9), 0.5, 0.5, 0.18, 0.5), 22),
  'photo style: tilt -6 + perspective 0.12 + blur 1 + glare + noise': S.noise(S.glare(S.blur(S.rotate(S.perspective(card0, 0.12), -6), 1), 0.35, 0.5, 0.2, 0.55), 16),
};
for (const [name, im] of Object.entries(variants)) {
  const { r } = await readImg(S.toJpeg(im, 78), 'image/jpeg', P0, name);
  check(`B JPEG ${name}: decoded to the exact fields`, !!r && sameAs(P0, r.pages.get(1)?.fields), r ? JSON.stringify(r.pages.get(1)?.fields) : 'no decode');
}
{ const { r } = await readImg(S.toPng(S.scaleTo(card0, 1400)), 'image/png', P0, 'png'); check('B PNG: decoded', !!r && sameAs(P0, r.pages.get(1)?.fields)); }
{ const big = S.cardBack(bar0, { W: 4000, H: 3000, bx: 500, by: 900, seed: 5 }); const { r } = await readImg(S.toJpeg(S.blur(big, 1), 80), 'image/jpeg', P0, '12MP jpeg'); check('B 12 MP JPEG: decoded', !!r && sameAs(P0, r.pages.get(1)?.fields)); }
for (const p of S.PEOPLE) {
  const bar = S.renderPdf417(S.payloadFor(p)); const card = S.cardBack(bar, { seed: 21 + p.ver });
  const { r } = await readImg(S.toJpeg(S.rotate(S.perspective(card, 0.1), 4), 80), 'image/jpeg', p, `person ${p.st}`);
  check(`B ${p.st} v${p.ver} (tilted photo): decoded, exact`, !!r && sameAs(p, r.pages.get(1)?.fields));
}
{ const pdf = S.toPdf([{ img: S.scaleTo(card0, 1500), kind: 'jpeg' }]); const { r } = await readImg(pdf, 'application/pdf', P0, 'pdf jpeg'); check('B photo PDF (JPEG image page): decoded', !!r && sameAs(P0, r.pages.get(1)?.fields)); }
{ const pdf = S.toPdf([{ img: S.scaleTo(card0, 1200), kind: 'flate' }]); const { r } = await readImg(pdf, 'application/pdf', P0, 'pdf flate'); check('B scanned PDF (Flate RGB image page): decoded', !!r && sameAs(P0, r.pages.get(1)?.fields)); }
{ const pdf = S.toPdf([{ text: 'Cover sheet' }, { img: S.scaleTo(S.rotate(card0, 5), 1500), kind: 'jpeg' }, { text: 'Page three' }]); const { r } = await readImg(pdf, 'application/pdf', P0, 'pdf 3 pages'); check('B 3-page PDF: only page 2 decodes', !!r && r.pageCount === 3 && [...r.pages.keys()].join() === '2' && sameAs(P0, r.pages.get(2)?.fields)); }

{ const big = S.cardBack(bar0, { W: 6048, H: 4032, bx: 900, by: 1500, seed: 2 }); const pdf = S.toPdf([{ img: big, kind: 'flate' }]); const { r } = await readImg(pdf, 'application/pdf', P0, '24MP flate pdf'); check('B 24 MP phone-photo PDF (Flate raster, card small in the frame): decoded', !!r && sameAs(P0, r.pages.get(1)?.fields)); }

/* ---------------------------------------------------------------- C. corrupt images */
console.log('--- C. corrupt images');
const noBar = async (name, buf, type = 'image/jpeg') => { const { r, st } = await readImg(buf, type, P0, name); check(`C ${name}: no values`, r === null, JSON.stringify(st)); };
await noBar('symbol physically damaged (a third wiped)', S.toJpeg(S.damage(card0, 0.12, 0.3, 0.5, 0.75), 80));
await noBar('symbol damaged by a heavy blur', S.toJpeg(S.blur(card0, 5), 80));
await noBar('blank card', S.toJpeg(S.cardBack({ w: 10, h: 10, px: new Uint8Array(100).fill(255) }, { seed: 3 }), 80));
await noBar('pure noise', S.toJpeg(S.noise({ w: 1200, h: 800, rgb: new Uint8Array(1200 * 800 * 3).fill(128) }, 120, 9), 80));
for (const [name, pl] of Object.entries({ 'bad header': bads['header: no ANSI'], 'expiry before issue': bads['expiry before issue'], 'ID-card subfile': bads['identification card (ID) subfile, not a licence'], 'truncated name flag': bads['name truncated flag'], 'two numbers': bads['two different numbers'] })) {
  await noBar(`a CLEAN image of an invalid payload (${name})`, S.toJpeg(S.cardBack(S.renderPdf417(pl), { seed: 4 }), 80));
}
// a symbol with a few damaged modules but within error correction still reads exactly (error correction works)
{ const { r } = await readImg(S.toJpeg(S.damage(card0, 0.30, 0.48, 0.33, 0.62), 85), 'image/jpeg', P0, 'small damage'); check('C small damage inside the error correction: still exact or nothing, never wrong', r === null || sameAs(P0, r.pages.get(1)?.fields)); }
// random corruption sweep: flip a patch somewhere; the result is the exact fields or nothing
{ let wrong = 0, exact = 0, none = 0;
  for (let k = 0; k < 12; k++) { const x0 = 0.05 + (k % 6) * 0.13, y0 = 0.32 + (k % 3) * 0.12; const { r } = await readImg(S.toJpeg(S.damage(card0, x0, y0, x0 + 0.09, y0 + 0.14, k % 2 ? 20 : 235), 80), 'image/jpeg', P0, 'sweep'); if (!r) none++; else if (sameAs(P0, r.pages.get(1)?.fields)) exact++; else wrong++; }
  check(`C damage sweep (12 patches): ${exact} exact, ${none} nothing, ${wrong} wrong`, wrong === 0); }

/* ---------------------------------------------------------------- D. end to end with a stub model */
console.log('--- D. readPdfOrImage with a stub model');
const GOOD_TEXT = 'A clean legible transcription of the licence front with plenty of readable words in it.';
async function withStub(fn) {
  const calls = [];
  __setAnthropicClientFactoryForTests(() => ({ messages: { create: async (req) => { calls.push(req); return { stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 50 }, content: [{ type: 'tool_use', name: 'pages', input: { pages: [{ page_no: 1, text: GOOD_TEXT, confidence: 0.95 }, { page_no: 2, text: GOOD_TEXT + ' two', confidence: 0.95 }] } }] }; } } }));
  try { return { result: await fn(), calls }; } finally { __setAnthropicClientFactoryForTests(null); }
}
{
  const jpg = S.toJpeg(S.rotate(card0, 6), 80);
  const { result, calls } = await withStub(() => readPdfOrImage(jpg, 'image/jpeg', {}, Date.now()));
  check('D licence photo: zero model calls', calls.length === 0, `calls ${calls.length}`);
  check('D licence photo: source aamva-barcode, one text page, model aamva-barcode, confidence 1', result.readSource === 'aamva-barcode' && result.method === 'text' && result.pages.length === 1 && result.pages[0].model === 'aamva-barcode' && result.pages[0].confidence === 1);
  const text = result.pages[0].text; check('D stored page text has no DOB / address / payload / full number', privacyLeaks(P0, text).length === 0, text);
}
{
  const { result, calls } = await withStub(() => readPdfOrImage(S.toJpeg(S.damage(card0, 0.12, 0.3, 0.5, 0.75), 80), 'image/jpeg', {}, Date.now()));
  check('D undecodable photo: the vision path runs once, unchanged', calls.length === 1 && result.method === 'model' && result.pages[0].text.startsWith('A clean legible') && !result.pages.some((p) => p.text.includes(BARCODE_MARKER)));
}
{
  const { result, calls } = await withStub(() => readPdfOrImage(S.toJpeg(S.cardBack(S.renderPdf417(bads['expiry before issue']), { seed: 4 }), 80), 'image/jpeg', {}, Date.now()));
  check('D valid symbol, invalid licence data: vision path, zero barcode values', calls.length === 1 && result.pages.every((p) => !p.text.includes(BARCODE_MARKER) && p.model !== 'aamva-barcode'));
}
{
  const pdf = S.toPdf([{ img: S.scaleTo(card0, 1500), kind: 'jpeg' }]);
  const { result, calls } = await withStub(() => readPdfOrImage(pdf, 'application/pdf', {}, Date.now()));
  check('D licence-back PDF: zero model calls, barcode page', calls.length === 0 && result.readSource === 'aamva-barcode' && result.pages.length === 1 && result.pages[0].model === 'aamva-barcode');
}
{
  const pdf = S.toPdf([{ text: 'Cover sheet for the driver file, Sonoran Comfort Air' }, { img: S.scaleTo(card0, 1500), kind: 'jpeg' }]);
  const { result, calls } = await withStub(() => readPdfOrImage(pdf, 'application/pdf', {}, Date.now()));
  check('D digital page + licence-back page: text layer + barcode, zero model calls', calls.length === 0 && result.pages.length === 2 && result.pages[0].model === 'pdf-text-layer' && result.pages[1].model === 'aamva-barcode', JSON.stringify(result.pages.map((p) => p.model)) + ` calls ${calls.length}`);
}
{
  const blank = S.cardBack({ w: 10, h: 10, px: new Uint8Array(100).fill(255) }, { seed: 8 });
  const pdf = S.toPdf([{ img: S.scaleTo(blank, 1200), kind: 'jpeg' }, { img: S.scaleTo(card0, 1500), kind: 'jpeg' }]);
  const { result, calls } = await withStub(() => readPdfOrImage(pdf, 'application/pdf', {}, Date.now()));
  const sent = calls.length === 1;
  check('D scan of the licence front (page 1, no barcode) + back (page 2): page 2 from the barcode, page 1 alone to the model', sent && result.pages.length === 2 && result.pages[1].model === 'aamva-barcode' && result.pages[0].model !== 'aamva-barcode', `calls ${calls.length} ${JSON.stringify(result.pages.map((p) => p.model))}`);
}
{
  process.env.LICENSE_BARCODE = '0';
  const { result, calls } = await withStub(() => readPdfOrImage(S.toJpeg(card0, 80), 'image/jpeg', {}, Date.now()));
  delete process.env.LICENSE_BARCODE;
  check('D LICENSE_BARCODE=0: the lane is off, the vision path runs', calls.length === 1 && result.method === 'model');
}
{
  const { result, calls } = await withStub(() => readPdfOrImage(S.toPdf([{ text: 'An ordinary digital page with enough text to be read from its own text layer, Sonoran Comfort Air invoice.' }]), 'application/pdf', {}, Date.now()));
  check('D digital PDF: text layer, no barcode work, no model call', calls.length === 0 && result.readSource === 'pdf-text-layer');
}

/* ---------------------------------------------------------------- E. field readers */
console.log('--- E. field readers');
const P = await loadPipeline(ROOT);
for (const p of S.PEOPLE) {
  const f = parseAamva(S.payloadFor(p)).fields;
  const out = runDoc(P, { filename: 'scan0001.pdf', pages: [{ page_no: 1, text: barcodePageText(f) }] });
  const k = Object.fromEntries((out.fields || []).map((x) => [x.field_key, x.value]));
  const ok = out.type === 'license-certification' && k.holder_name?.toLowerCase() === titled(p) && k.license_number === `XXXX${want(p).last4}` && k.license_state === p.st && k.end_date === ymd(p.exp) && k.start_date === ymd(p.iss) && (!/^[A-D]$/.test(p.cls) || k.license_class === p.cls) && out.verdict?.ok === true;
  check(`E ${p.st}: type license-certification, keys read, auto-check ok`, ok, JSON.stringify({ type: out.type, k, v: out.verdict }));
  check(`E ${p.st}: no full licence number, DOB or address in any stored field`, privacyLeaks(p, JSON.stringify(k)).length === 0, JSON.stringify(k));
}

/* ---------------------------------------------------------------- F. ordinary pages */
console.log('--- F. ordinary documents (no barcode)');
{
  const dir = path.join(ROOT, 'test-docs');
  const files = [];
  const walk = (d, depth) => { if (depth > 3) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f, depth + 1); else if (/\.(jpe?g|png|pdf)$/i.test(e.name) && fs.statSync(f).size < 12_000_000) files.push(f); } };
  walk(dir, 0);
  files.sort(); const pick = files.filter((_, i) => i % Math.max(1, Math.floor(files.length / 60)) === 0).slice(0, 60);
  let n = 0, hits = 0, maxMs = 0, sumMs = 0, imgPages = 0;
  for (const f of pick) {
    const ext = path.extname(f).toLowerCase(); const type = ext === '.pdf' ? 'application/pdf' : ext === '.png' ? 'image/png' : 'image/jpeg';
    const t0 = Date.now(); const st = {}; const r = await readLicenseBarcodePages(fs.readFileSync(f), type, { stats: st, pdfLib: PP }); const ms = Date.now() - t0;
    n++; sumMs += ms; maxMs = Math.max(maxMs, ms); imgPages += st.tried; if (r) hits++;
  }
  check(`F ${n} repo test documents (${imgPages} images tried): no barcode read, zero false licences`, hits === 0, `${hits} hits`);
  console.log(`      cost on ordinary files: mean ${(sumMs / Math.max(1, n)).toFixed(0)} ms, max ${maxMs} ms per file`);
}

console.log('--- G. packaging');
{
  const vj = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  for (const fn of ['api/read-document.js', 'api/extract.js', 'api/inngest.js']) check(`G vercel.json ships the reader wasm with ${fn}`, /zxing_reader\.wasm/.test(vj.functions?.[fn]?.includeFiles ?? ''));
  check('G the wasm file the includeFiles pattern names exists', fs.existsSync(path.join(ROOT, 'node_modules/zxing-wasm/dist/reader/zxing_reader.wasm')));
  const top = fs.readdirSync(path.join(ROOT, 'api'), { withFileTypes: true }).filter((e) => e.isFile()).length;
  check('G api/ still has exactly 12 top-level files', top === 12, String(top));
  const pk = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  check('G zxing-wasm is a runtime dependency; bwip-js and aamva-parser are devDependencies only (api/ never imports them)', !!pk.dependencies['zxing-wasm'] && !!pk.devDependencies['bwip-js'] && !!pk.devDependencies['aamva-parser'] && !pk.dependencies['bwip-js'] && !pk.dependencies['aamva-parser']);
  const imports = fs.readFileSync(path.join(ROOT, 'api/_lib/modelAvoidance/licenseBarcode.js'), 'utf8');
  check('G licenseBarcode.js imports neither bwip-js nor aamva-parser', !/bwip-js|aamva-parser/.test(imports.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));
}

const med = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log(`\ndecode time per page (synthetic photos, this machine): median ${med(timings.map((t) => t.ms))} ms, max ${Math.max(...timings.map((t) => t.ms))} ms over ${timings.length} reads`);
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
