/**
 * Vision-lane checks (no network, no key, no DB): the model client is a stub that records exactly which pages / bytes it was handed.
 *   1. a huge single-image PDF (> 24 MB) is no longer refused: its image is re-encoded to <= 2000 px JPEG and ONE small PDF is sent
 *   2. a mixed PDF (digital + scanned pages) reads digital pages from the text layer and sends ONLY the scanned page
 *   3. escalation sends a PDF holding ONLY the flagged pages (their image bytes identical to the original), not the whole file
 *   4. unchanged paths: all-digital -> no model call; small all-scan -> the original bytes; unparseable -> old whole-file + page filter
 *      node scripts/verify-vision-lane.mjs
 */
import { createHash, randomFillSync } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { readPdfOrImage, extractWithClaude, __setAnthropicClientFactoryForTests, MAX_PDF_BYTES, MAX_PDF_SHRINK_BYTES } from '../api/_lib/readDocument.js';
import { openPdf, buildPdfSubset } from '../api/_lib/modelAvoidance/pdfPages.js';
import { readPdfTextLayer } from '../api/_lib/modelAvoidance/pdfText.js';

let failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`); };
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const md5 = (b) => createHash('md5').update(b).digest('hex');

/* ---------------------------------------------------------------- synthetic PDF builder */
function buildPdf(pages, { shared = false, inherit = false, filler = 0, formPage = null } = {}) {
  // pages: [{ text?: string[], image?: {w,h,raw(Buffer, RGB), flate?:true, extra?:string} }]
  const objs = []; // index = obj number - 1 ; strings or {dict, stream}
  const add = (o) => { objs.push(o); return objs.length; };
  const catalog = add(''); const pagesObj = add(''); const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const kids = [];
  let sharedXo = '', sharedRes = 0;
  if (shared || inherit) {
    pages.forEach((pg, i) => { if (pg.image) { const im = add({ dict: `<< /Type /XObject /Subtype /Image /Width ${pg.image.w} /Height ${pg.image.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`, stream: deflateSync(pg.image.raw) }); pg.imNum = im; sharedXo += `/Im${i} ${im} 0 R `; } });
    sharedRes = add(`<< /Font << /F1 ${font} 0 R >> /XObject << ${sharedXo} >> >>`);
  }
  pages.forEach((pg, i) => {
    let content = ''; let xo = '';
    if (shared || inherit) { if (pg.image) content += `q 612 0 0 792 0 0 cm /Im${i} Do Q\n`; }
    else if (pg.image) {
      const data = deflateSync(pg.image.raw);
      const im = add({ dict: `<< /Type /XObject /Subtype /Image /Width ${pg.image.w} /Height ${pg.image.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode ${pg.image.extra ?? ''}`, stream: data });
      xo = `/XObject << /Im0 ${im} 0 R >>`;
      content += `q 612 0 0 792 0 0 cm /Im0 Do Q\n`;
    }
    if (formPage === i) {
      const a = add({ dict: `<< /Type /XObject /Subtype /Image /Width ${pg.image.w} /Height ${pg.image.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`, stream: deflateSync(pg.image.raw) });
      const b = add({ dict: `<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`, stream: deflateSync(Buffer.alloc(192, 7)) });
      const fm = add({ dict: `<< /Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /XObject << /A ${a} 0 R /B ${b} 0 R >> >>`, stream: Buffer.from('q 612 0 0 792 0 0 cm /A Do Q') });
      xo = `/XObject << /Fm0 ${fm} 0 R >>`; content += '/Fm0 Do\n';
    }
    if (pg.text) pg.text.forEach((t, i) => { content += `BT /F1 11 Tf 72 ${720 - i * 16} Td (${t}) Tj ET\n`; });
    const cs = add({ dict: '<<', stream: Buffer.from(content, 'latin1') });
    const resEntry = shared ? `/Resources ${sharedRes} 0 R` : inherit ? '' : `/Resources << /Font << /F1 ${font} 0 R >> ${xo} >>`;
    const pn = add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] ${resEntry} /Contents ${cs} 0 R >>`);
    kids.push(pn);
  });
  if (filler) add({ dict: '<< /Type /Filler', stream: randomFillSync(Buffer.alloc(filler)) });
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} ${inherit ? `/Resources ${sharedRes} 0 R` : ''} >>`;
  const parts = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')]; const offs = [];
  let pos = parts[0].length;
  objs.forEach((o, i) => {
    offs.push(pos);
    const head = typeof o === 'string' ? `${i + 1} 0 obj\n${o}\nendobj\n` : `${i + 1} 0 obj\n${o.dict.endsWith('<<') ? '<<' : o.dict} /Length ${o.stream.length} >>\nstream\n`;
    const b1 = Buffer.from(head, 'latin1'); parts.push(b1); pos += b1.length;
    if (typeof o !== 'string') { const tail = Buffer.concat([o.stream, Buffer.from('\nendstream\nendobj\n')]); parts.push(tail); pos += tail.length; }
  });
  let x = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  parts.push(Buffer.from(x + `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${pos}\n%%EOF\n`));
  return Buffer.concat(parts);
}
const noise = (w, h, seed) => { const b = Buffer.alloc(w * h * 3); let s = seed >>> 0; for (let i = 0; i < b.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; b[i] = ((i % (w * 3)) / 3 + (s >>> 24) / 4 + seed * 40) & 255; } return b; };
const DIGITAL = ['Invoice 1001 for Sonoran Heating and Air', 'Customer: Jane Q Sample, 123 Elm Street, Mesa AZ 85201', 'Equipment: Carrier 24ACC636 condenser, serial 1234567890', 'Installed 2025-03-14 by technician R. Alvarez, labor 4.5 hours', 'Total due: $4,812.50 net 30 days, thank you for your business'];

/* ---------------------------------------------------------------- stub model */
function fakeResponse(pages) { return { stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 50 }, content: [{ type: 'tool_use', name: 'pages', input: { pages } }] }; }
async function withStub(handler, fn) {
  const calls = [];
  __setAnthropicClientFactoryForTests(() => ({ messages: { create: async (req) => {
    const src = req.messages[0].content[0];
    const data = Buffer.from(src.source.data, 'base64');
    const info = { model: req.model, kind: src.type, media: src.source.media_type, bytes: data, text: req.messages[0].content[1].text };
    if (src.source.media_type === 'application/pdf') {
      const p = openPdf(data);
      info.pages = p ? p.pages.length : null;
      info.images = p ? [...p.objs.entries()].filter(([, o]) => o.value?.Subtype === '/Image').map(([n, o]) => ({ w: o.value.Width, h: o.value.Height, filter: o.value.Filter, md5: md5(o.raw) })) : [];
    }
    calls.push(info);
    return handler(info, calls.length);
  } } }));
  try { return { result: await fn(), calls }; } finally { __setAnthropicClientFactoryForTests(null); }
}
process.env.TRANSCRIBE_MODEL_FAST = 'test-fast'; process.env.TRANSCRIBE_MODEL_STRONG = 'test-strong';
delete process.env.TRANSCRIBE_MODEL; delete process.env.TRANSCRIBE_ESCALATE_BELOW; delete process.env.PDF_TEXT_LAYER;
const GOOD = 'A clean legible transcription with plenty of readable words in it.';
const ctx = {};

/* ---------------------------------------------------------------- 1. huge single-image PDF */
{
  const w = 3200, h = 4200; // 40 MB of incompressible-ish RGB -> a PDF well over 24 MB
  const raw = Buffer.alloc(w * h * 3); randomFillSync(raw);
  const pdf = buildPdf([{ image: { w, h, raw } }]);
  check(`fixture: single-image PDF is over the old 24 MB gate (${(pdf.length / 1048576).toFixed(1)} MB)`, pdf.length > MAX_PDF_BYTES && pdf.length < MAX_PDF_SHRINK_BYTES);
  const t0 = Date.now();
  const { result, calls } = await withStub(() => fakeResponse([{ page_no: 1, text: GOOD, confidence: 0.95 }]), () => readPdfOrImage(pdf, 'application/pdf', ctx, Date.now()));
  eq('gets past the size gate: exactly ONE model call', calls.length, 1);
  eq('the call carries a 1-page PDF', [calls[0].kind, calls[0].media, calls[0].pages], ['document', 'application/pdf', 1]);
  check(`the bytes sent are small (${(calls[0].bytes.length / 1024).toFixed(0)} KB, was ${(pdf.length / 1048576).toFixed(0)} MB)`, calls[0].bytes.length < 6 * 1048576 && calls[0].bytes.length < MAX_PDF_BYTES);
  eq('its image is a JPEG with long edge <= 2000 px', [calls[0].images.length, calls[0].images[0].filter, Math.max(calls[0].images[0].w, calls[0].images[0].h)], [1, '/DCTDecode', 2000]);
  eq('aspect ratio preserved (3200x4200 -> 1524x2000)', [calls[0].images[0].w, calls[0].images[0].h], [1524, 2000]);
  eq('page text comes back with page_no 1 via the model', [result.pages.map((p) => p.page_no), result.method], [[1], 'model']);
  check('the prompt asks for the whole (1-page) document, no page filter', !/ONLY page/.test(calls[0].text));
  console.log(`      (shrink ran in ${Date.now() - t0} ms)`);
}
{ // over the 100 MB upload cap, a non-PDF, and an image kind we cannot decode safely are still a clean 413 with no model call
  const fake = Buffer.alloc(MAX_PDF_SHRINK_BYTES + 1); fake.write('%PDF-1.4');
  const { calls } = await withStub(() => fakeResponse([]), async () => {
    for (const [name, b, t] of [['> 100 MB PDF', fake, 'application/pdf'], ['> 24 MB photo', Buffer.alloc(MAX_PDF_BYTES + 1), 'image/jpeg']]) {
      try { await readPdfOrImage(b, t, ctx, Date.now()); check(`${name}: refused`, false); } catch (e) { eq(`${name}: refused with 413`, e.status, 413); }
    }
    const raw = Buffer.alloc(3200 * 4200 * 3); randomFillSync(raw);
    const withMask = buildPdf([{ image: { w: 3200, h: 4200, raw, extra: '/Mask [0 0 0 0 0 0]' } }]);
    try { await readPdfOrImage(withMask, 'application/pdf', ctx, Date.now()); check('huge image with a Mask: refused', false); } catch (e) { eq('huge image we cannot shrink safely (Mask): 413, as before', e.status, 413); }
  });
  eq('none of those reached the model', calls.length, 0);
}

/* ---------------------------------------------------------------- 2. mixed PDF */
const SCAN = (seed) => ({ image: { w: 500, h: 650, raw: noise(500, 650, seed) } });
{
  const pdf = buildPdf([{ text: DIGITAL }, SCAN(1), { text: DIGITAL.map((t) => t + ' page3') }]);
  const per = readPdfTextLayer(pdf, { perPage: true });
  eq('fixture: text layer reads pages 1 and 3, skips page 2', [per.ok, per.mixed, per.pages.map((p) => p.page_no), per.skipped.map((s) => s.page_no)], [true, true, [1, 3], [2]]);
  eq('old all-or-nothing reader still refuses the same file', readPdfTextLayer(pdf).ok, false);
  const { result, calls } = await withStub(() => fakeResponse([{ page_no: 1, text: 'SCANNED PAGE TWO text transcribed by the model, long enough.', confidence: 0.95 }]), () => readPdfOrImage(pdf, 'application/pdf', ctx, Date.now()));
  eq('ONE model call, for a 1-page PDF (not 3)', [calls.length, calls[0].pages], [1, 1]);
  const origImg = [...openPdf(pdf).objs.values()].filter((o) => o.value?.Subtype === '/Image').map((o) => md5(o.raw));
  eq('the single page sent is the scanned page (image bytes identical to the original page 2)', calls[0].images.map((i) => i.md5), origImg);
  check('the call is smaller than the original file', calls[0].bytes.length < pdf.length, `${calls[0].bytes.length} vs ${pdf.length}`);
  eq('merged pages 1,2,3 in order', result.pages.map((p) => p.page_no), [1, 2, 3]);
  eq('page tags: text layer, model, text layer', result.pages.map((p) => p.model), ['pdf-text-layer', 'test-fast', 'pdf-text-layer']);
  check('model text mapped back to real page 2', /SCANNED PAGE TWO/.test(result.pages[1].text));
  check('digital pages keep the exact text-layer text (not the model\'s)', result.pages[0].text === per.pages[0].text && result.pages[2].text === per.pages[1].text);
  eq('source label', result.readSource, 'pdf-mixed:2text+1model');
}
{ // unchanged: all digital -> no model; small all-scan -> the original bytes untouched
  const dig = buildPdf([{ text: DIGITAL }, { text: DIGITAL }]);
  const a = await withStub(() => fakeResponse([]), () => readPdfOrImage(dig, 'application/pdf', ctx, Date.now()));
  eq('all-digital PDF: zero model calls, text-layer source', [a.calls.length, a.result.readSource, a.result.method], [0, 'pdf-text-layer', 'text']);
  const scan = buildPdf([SCAN(2), SCAN(3)]);
  const b = await withStub(() => fakeResponse([{ page_no: 1, text: GOOD, confidence: 0.9 }, { page_no: 2, text: GOOD, confidence: 0.9 }]), () => readPdfOrImage(scan, 'application/pdf', ctx, Date.now()));
  eq('small all-scan PDF: one call with the ORIGINAL bytes, unchanged', [b.calls.length, md5(b.calls[0].bytes) === md5(scan)], [1, true]);
}

/* ---------------------------------------------------------------- 3. escalation page filtering */
{
  const pdf = buildPdf([SCAN(11), SCAN(12), SCAN(13), SCAN(14)]);
  const orig = [...openPdf(pdf).objs.values()].filter((o) => o.value?.Subtype === '/Image').map((o) => md5(o.raw));
  const { result, calls } = await withStub((info, n) => n === 1
    ? fakeResponse([1, 2, 3, 4].map((p) => ({ page_no: p, text: p % 2 === 0 ? '' : GOOD, confidence: p % 2 === 0 ? 0.3 : 0.95 })))
    : fakeResponse([{ page_no: 1, text: 'strong read of the first flagged page', confidence: 0.9 }, { page_no: 2, text: 'strong read of the second flagged page', confidence: 0.9 }]),
  () => extractWithClaude(pdf, 'application/pdf', ctx, Date.now()));
  eq('two calls: fast on the whole file, strong on a subset', calls.map((c) => [c.model, c.pages]), [['test-fast', 4], ['test-strong', 2]]);
  eq('fast call sent the original bytes', md5(calls[0].bytes), md5(pdf));
  eq('strong call holds exactly the flagged pages 2 and 4 (image bytes identical to the original)', calls[1].images.map((i) => i.md5), [orig[1], orig[3]]);
  check('strong call is about half the size of the whole file', calls[1].bytes.length < pdf.length * 0.6, `${calls[1].bytes.length} vs ${pdf.length}`);
  check('strong prompt is NOT the old "ONLY page(s)" instruction (the file already holds only those pages)', !/ONLY page/.test(calls[1].text));
  eq('results renumbered to the real pages 2 and 4', result.filter((p) => p.model === 'test-strong').map((p) => [p.page_no, p.text.slice(0, 18)]), [[2, 'strong read of the'], [4, 'strong read of the']]);
  eq('pages 1 and 3 keep the fast read', result.filter((p) => p.model === 'test-fast').map((p) => p.page_no), [1, 3]);
}
{ // mixed + escalation compose: real page numbers survive both mappings
  const pdf = buildPdf([{ text: DIGITAL }, SCAN(21), { text: DIGITAL }, SCAN(22), SCAN(23)]);
  const orig = [...openPdf(pdf).objs.values()].filter((o) => o.value?.Subtype === '/Image').map((o) => md5(o.raw));
  const { result, calls } = await withStub((info, n) => n === 1
    ? fakeResponse([{ page_no: 1, text: GOOD, confidence: 0.95 }, { page_no: 2, text: '', confidence: 0.2 }, { page_no: 3, text: GOOD, confidence: 0.95 }])
    : fakeResponse([{ page_no: 1, text: 'recovered scan on real page four', confidence: 0.9 }]),
  () => readPdfOrImage(pdf, 'application/pdf', ctx, Date.now()));
  eq('fast call = 3 scanned pages only; strong call = 1 page', calls.map((c) => c.pages), [3, 1]);
  eq('strong call holds the real page-4 image only', calls[1].images.map((i) => i.md5), [orig[1]]);
  eq('final pages 1..5 in order, page 4 from the strong model', result.pages.map((p) => [p.page_no, p.model]), [[1, 'pdf-text-layer'], [2, 'test-fast'], [3, 'pdf-text-layer'], [4, 'test-strong'], [5, 'test-fast']]);
}
{ // unparseable bytes: old behaviour (whole bytes + "ONLY page" instruction) is kept
  const fake = Buffer.from('%PDF-fake');
  const { calls } = await withStub((info, n) => n === 1 ? fakeResponse([{ page_no: 1, text: GOOD, confidence: 0.9 }, { page_no: 2, text: '', confidence: 0.3 }]) : fakeResponse([{ page_no: 2, text: 'strong', confidence: 0.9 }]),
    () => extractWithClaude(fake, 'application/pdf', ctx, Date.now()));
  eq('escalation of an unparseable file sends the same bytes with the page filter', [calls.length, md5(calls[1].bytes) === md5(fake), /ONLY page\(s\) 2\b/.test(calls[1].text)], [2, true, true]);
}

/* ---------------------------------------------------------------- 4. subset writer sanity */
{
  const pdf = buildPdf([{ text: DIGITAL }, SCAN(31), { text: ['third page words here'] }]);
  const r = buildPdfSubset(pdf, [3, 1]);
  eq('subset keeps the requested order and reports the map', [r.ok, r.pageMap], [true, [3, 1]]);
  const back = readPdfTextLayer(r.bytes);
  eq('subset is a valid PDF whose text layer matches the originals', [back.ok, back.pages.length, /third page words/.test(back.pages[0].text), /Invoice 1001/.test(back.pages[1].text)], [true, 2, true, true]);
  eq('out-of-range / empty page lists are refused, not thrown', [buildPdfSubset(pdf, [9]).ok, buildPdfSubset(Buffer.from('nope'), [1]).ok], [false, false]);
}


/* ---------------------------------------------------------------- 5. defect-killers (independent verifier D1-D5) */
const imgsOf = (bytes) => { const p = openPdf(bytes); return [...p.objs.values()].filter((o) => o.value?.Subtype === '/Image').map((o) => md5(o.raw)); };
{ // D1: shared / inherited Resources must not leak other pages' images
  for (const mode of ['shared', 'inherit']) {
    const pdf = buildPdf([SCAN(41), SCAN(42), SCAN(43)], { [mode]: true });
    const all = imgsOf(pdf);
    const r = buildPdfSubset(pdf, [2]);
    eq(`D1 ${mode} Resources: original has 3 images`, all.length, 3);
    eq(`D1 ${mode} Resources: subset of page 2 holds ONLY page 2's image`, [r.ok, imgsOf(r.bytes)], [true, [all[1]]]);
    check(`D1 ${mode} Resources: subset is about a third of the file`, r.bytes.length < pdf.length * 0.5, `${r.bytes.length} vs ${pdf.length}`);
    const { calls } = await withStub((i, n) => n === 1 ? fakeResponse([1, 2, 3].map((p) => ({ page_no: p, text: p === 2 ? '' : GOOD, confidence: p === 2 ? 0.2 : 0.95 }))) : fakeResponse([{ page_no: 1, text: 'strong', confidence: 0.9 }]), () => extractWithClaude(pdf, 'application/pdf', ctx, Date.now()));
    eq(`D1 ${mode} Resources: escalation call carries one image, page 2's`, calls[1].images.map((i) => i.md5), [all[1]]);
  }
  const pdf = buildPdf([SCAN(51), { image: { w: 40, h: 40, raw: noise(40, 40, 9) } }], { formPage: 0 });
  const full = imgsOf(pdf).length;
  const r = buildPdfSubset(pdf, [1]);
  check('D1 form XObject: a form\'s own Resources are pruned to the names its content uses', r.ok && full === 4 && imgsOf(r.bytes).length === 1, `${full} -> ${r.ok && imgsOf(r.bytes).length}`);
  const sub2 = buildPdfSubset(r.bytes, [1]);
  check('D1 pruned subset is itself readable and re-subsettable', sub2.ok && imgsOf(sub2.bytes).length === 1);
}
{ // D2: a big DCT image is refused cleanly BEFORE any decode (no OOM), memory stays bounded for the accepted sizes
  const junk = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomFillSync(Buffer.alloc(26 * 1048576))]);
  const mk = (w, h) => { const b = buildPdf([{ text: ['x'] }]); return b; };
  const pdfText = buildPdf([SCAN(1)]);
  // hand-build: one page, one 60 MP DCT image (stream is junk; the dictionary alone must trigger the refusal)
  const parts = ['%PDF-1.4\n', '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n', '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
    '4 0 obj\n<< /Length 30 >>\nstream\nq 612 0 0 792 0 0 cm /Im0 Do Q\nendstream\nendobj\n'];
  const big = Buffer.concat([Buffer.from(parts.join('') + `5 0 obj\n<< /Type /XObject /Subtype /Image /Width 8000 /Height 7500 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${junk.length} >>\nstream\n`, 'latin1'), junk, Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R /Size 6 >>\n%%EOF\n')]);
  const t = Date.now();
  const { calls } = await withStub(() => fakeResponse([]), async () => { try { await readPdfOrImage(big, 'application/pdf', ctx, Date.now()); check('D2 60 MP DCT image refused', false); } catch (e) { eq('D2 60 MP DCT image: clean 413', e.status, 413); } });
  eq('D2 no model call', calls.length, 0);
  check('D2 refused fast, without decoding', Date.now() - t < 5000, `${Date.now() - t} ms`);
}
{ // D3: an oversize PDF with more than 200 pages is a 413, never silently truncated to 201 pages
  const pages = Array.from({ length: 250 }, () => ({ text: [] }));
  const pdf = buildPdf(pages, { filler: 25 * 1048576 });
  check(`D3 fixture: 250 pages, ${(pdf.length / 1048576).toFixed(0)} MB`, pdf.length > MAX_PDF_BYTES);
  const { calls } = await withStub(() => fakeResponse([]), async () => { try { await readPdfOrImage(pdf, 'application/pdf', ctx, Date.now()); check('D3 250-page oversize PDF refused', false); } catch (e) { eq('D3 250-page oversize PDF: 413', e.status, 413); } });
  eq('D3 no model call', calls.length, 0);
  eq('D3 openPdf refuses > 200 pages (no partial page list)', openPdf(buildPdf(pages)), null);
}
{ // D4: the mixed-PDF split is intentional and has a kill switch
  const pdf = buildPdf([{ text: DIGITAL }, SCAN(61), { text: DIGITAL }]);
  process.env.PDF_PER_PAGE = '0';
  const off = await withStub(() => fakeResponse([1, 2, 3].map((p) => ({ page_no: p, text: GOOD, confidence: 0.9 }))), () => readPdfOrImage(pdf, 'application/pdf', ctx, Date.now()));
  delete process.env.PDF_PER_PAGE;
  eq('D4 PDF_PER_PAGE=0: old behaviour, whole 3-page original sent to the model', [off.calls.length, off.calls[0].pages, md5(off.calls[0].bytes) === md5(pdf)], [1, 3, true]);
  const on = await withStub(() => fakeResponse([{ page_no: 1, text: GOOD, confidence: 0.9 }]), () => readPdfOrImage(pdf, 'application/pdf', ctx, Date.now()));
  eq('D4 default: only the scanned page is sent', [on.calls.length, on.calls[0].pages], [1, 1]);
}
{ // D5: the text-layer scan is reused, not repeated
  const pdf = buildPdf([{ text: DIGITAL }, SCAN(71)]);
  const out = {};
  readPdfTextLayer(pdf, { perPage: true, out });
  const o = openPdf(pdf, { parsed: out.parsed });
  check('D5 openPdf adopts the text-layer parse (same object table, no second scan)', o && o.objs === out.parsed.objs);
  check('D5 adopted parse still builds a valid subset', buildPdfSubset(o, [2]).ok);
}

/* ---------------------------------------------------------------- 6. DCT cap sized from measured memory (R2-1) */
{
  // header-only JPEGs: SOF0 with N components, optional Adobe APP14; the stream body is junk (the refusal must come BEFORE any decode)
  const sof = (n) => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xee, 0x00, 0x0e]), Buffer.from('Adobe\0\x64\0\0\0\0\0\0'), Buffer.from([0xff, 0xc0, 0x00, 8 + 3 * n, 8, 0x10, 0x00, 0x10, 0x00, n]), Buffer.alloc(3 * n)]);
  const sofNoAdobe = (n) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 8 + 3 * n, 8, 0x10, 0x00, 0x10, 0x00, n]), Buffer.alloc(3 * n)]);
  const mkPdf = (w, h, head, cs, extra = '') => {
    const junk = Buffer.concat([head, randomFillSync(Buffer.alloc(25 * 1048576))]);
    const pre = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length 30 >>\nstream\nq 612 0 0 792 0 0 cm /Im0 Do Q\nendstream\nendobj\n';
    return Buffer.concat([Buffer.from(pre + `5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode ${extra}/Length ${junk.length} >>\nstream\n`, 'latin1'), junk, Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R /Size 6 >>\n%%EOF\n')]);
  };
  const cases = [
    ['52 MP RGB JPEG (over the 50 MP cap)', mkPdf(8200, 6300, sof(3), '/DeviceRGB')],
    ['26 MP CMYK JPEG (over the 24 MP CMYK cap)', mkPdf(6200, 4200, sof(4), '/DeviceCMYK', '/Decode [1 0 1 0 1 0 1 0] ')],
    ['CMYK JPEG without an Adobe marker (polarity unknown)', mkPdf(3000, 2000, sofNoAdobe(4), '/DeviceCMYK')],
    ['CMYK JPEG with an unexplained /Decode', mkPdf(3000, 2000, sof(4), '/DeviceCMYK', '/Decode [0 1 0 1 0 1 0 1] ')],
  ];
  for (const [name, pdf] of cases) {
    const { calls } = await withStub(() => fakeResponse([]), async () => { try { await readPdfOrImage(pdf, 'application/pdf', ctx, Date.now()); check(`${name}: refused`, false); } catch (e) { eq(`${name}: clean 413`, e.status, 413); } });
    eq(`${name}: no model call`, calls.length, 0);
  }
  // colour fidelity: an Adobe CMYK JPEG (flat cyan | 78% black) with the inverting /Decode is converted exactly as PIL does
  const cmykJpg = Buffer.from('/9j/7gAOQWRvYmUAZAAAAAAA/9sAQwACAQEBAQECAQEBAgICAgIEAwICAgIFBAQDBAYFBgYGBQYGBgcJCAYHCQcGBggLCAkKCgoKCgYICwwLCgwJCgoK/8AAFAgAQABABEMRAE0RAFkRAEsRAP/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/aAA4EQwBNAFkASwAAPwD+f+v38r9/K/fyiiiiiiiiiiiiv7/KKK/jfoooooooooooor+AOiiv7IKKKKKKKKKKKKK/v8oor+N+iiiiiiiiiiiiv4A6KK/sgoooooooooooor+/yiiv436KKKKKKKKKKKK/gDoor+yCiiiiiiiiiiiiv7/KKK/jfoooooooooooor+AOiiv7IKKKKKKKKKKKKK/v8oor+N+iiiiiiiiiiiiv4A6KK/sgoooooooooooor+/yiiv436KKKKKKKKKKKK/gDoor+yCiiiiiiiiiiiiv7/KKK/jfoooooooooooor+AOiiv7IKKKKKKKKKKKKK/v8oor+N+iiiiiiiiiiiiv//Z', 'base64');
  const small = mkPdf(64, 64, Buffer.alloc(0), '/DeviceCMYK', '/Decode [1 0 1 0 1 0 1 0] ');
  const pre = small.subarray(0, small.indexOf(Buffer.from('5 0 obj')));
  const one = Buffer.concat([pre, Buffer.from(`5 0 obj\n<< /Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceCMYK /BitsPerComponent 8 /Filter /DCTDecode /Decode [1 0 1 0 1 0 1 0] /Length ${cmykJpg.length} >>\nstream\n`), cmykJpg, Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R /Size 6 >>\n%%EOF\n')]);
  const pdf1 = openPdf(one);
  const { shrinkImageObject } = await import('../api/_lib/modelAvoidance/pdfPages.js');
  const r = pdf1 && shrinkImageObject(pdf1.doc, { r: 5 }, 32);
  check('CMYK Adobe JPEG + inverting /Decode shrinks', !!r);
  if (r) {
    const jpeg = (await import('jpeg-js')).default;
    const d = jpeg.decode(r.raw, { useTArray: true, formatAsRGBA: true });
    const px = (x, y) => Array.from(d.data.slice((y * d.width + x) * 4, (y * d.width + x) * 4 + 3));
    const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 8);
    check('colours match the reference conversion (left cyan = 0,255,255; right = 55,55,55)', near(px(2, 2), [0, 255, 255]) && near(px(29, 2), [55, 55, 55]), JSON.stringify([px(2, 2), px(29, 2)]));
  }
}

console.log(failures ? `\n${failures} FAILED` : '\nall vision-lane checks passed');
process.exit(failures ? 1 : 0);
