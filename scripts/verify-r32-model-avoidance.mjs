/**
 * R32 (Team M) — model-avoidance verify. No network, no database, no model.
 *
 *   node scripts/verify-r32-model-avoidance.mjs
 *
 * 1. LABELLED ACCURACY: >=60 labelled documents (corpus PDFs + real-tool PDFs + generated multi-style PDFs incl. traps).
 *    A deterministic extraction is accepted only at >=99% field-level precision; prints precision/recall per field
 *    and the share of documents/pages that skip the model.
 * 2. Kill switches, non-question gate (incl. zero false positives on the 1,700-question exam bank), deterministic
 *    dossier, financials input, ingest wiring (no model client is touched when the text layer is enough).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.join(root, p);
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : detail ? `  -> ${detail}` : ''}`); if (!ok) failed++; };

const { readPdfTextLayer } = await import(rel('api/_lib/modelAvoidance/pdfText.js'));
const { extractFromText, classifyFromText } = await import(rel('api/_lib/modelAvoidance/textExtract.js'));
const sw = await import(rel('api/_lib/modelAvoidance/switches.js'));
const { classifyNonQuestion } = await import(rel('api/_lib/modelAvoidance/nonQuestion.js'));
const { financialsInputFromText } = await import(rel('api/_lib/modelAvoidance/financialsHook.js'));
const { deterministicDossierSentences } = await import(rel('api/_lib/modelAvoidance/dossierText.js'));

/* ------------------------------------------------------------------ tiny PDF writer (plain or Flate) */
function makePdf(lines, { flate = false, pages = null } = {}) {
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const groups = pages ?? [lines];
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };
  const catalog = add('');            // 1
  const pagesObj = add('');           // 2
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'); // 3
  const kids = [];
  for (const g of groups) {
    let y = 760; const ops = ['BT', '/F1 11 Tf', '13 TL', `50 ${y} Td`];
    for (const ln of g) ops.push(`(${esc(ln)}) Tj`, 'T*');
    ops.push('ET');
    const raw = Buffer.from(ops.join('\n'), 'latin1');
    const data = flate ? zlib.deflateSync(raw) : raw;
    const c = add({ stream: data, dict: `<< /Length ${data.length}${flate ? ' /Filter /FlateDecode' : ''} >>` });
    const pg = add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${c} 0 R >>`);
    kids.push(`${pg} 0 R`);
  }
  objs[catalog - 1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;
  const parts = [Buffer.from('%PDF-1.4\n')]; const offs = [];
  let len = parts[0].length;
  objs.forEach((o, i) => {
    offs.push(len);
    const b = typeof o === 'string' ? Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`) : Buffer.concat([Buffer.from(`${i + 1} 0 obj\n${o.dict}\nstream\n`), o.stream, Buffer.from('\nendstream\nendobj\n')]);
    parts.push(b); len += b.length;
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${len}\n%%EOF\n`;
  parts.push(Buffer.from(xref));
  return Buffer.concat(parts);
}

/* ------------------------------------------------------------------ generated labelled documents */
const SHOP = ['Desert Peak Heating & Cooling', '2210 E Main St, Mesa, AZ 85213', '(480) 555-0199 | dispatch@desertpeakhvac.com'];
const PEOPLE = [
  ['Margaret Henderson', '3247 Elm St, Mesa, AZ 85201', '(480) 555-0148'],
  ['Robert Castillo', '918 W Palm Ln, Tempe, AZ 85281', '(602) 555-0173'],
  ['Priya Natarajan', '77 N Cedar Ct, Gilbert, AZ 85234', '(480) 555-0190'],
  ['Walter O\'Brien', '4501 S Ash Ave, Chandler, AZ 85248', '(480) 555-0122'],
];
const UNITS = [['Carrier', '24ACC636A003', '4N2119-08772'], ['Trane', 'XR14-4TTR4036', '1834ABC77'], ['Goodman', 'GSX160361', '2105556781'], ['Rheem', 'RA1436AJ1NA', 'RH0219Q4471']];
const TECHS = ['Marcus Bell', 'Danny Ochoa', 'Kevin Pratt'];
const mmddyyyy = (iso) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;

function ticket(i, { extra = [], techs = [TECHS[i % 3]], drop = null } = {}) {
  const [name, addr, phone] = PEOPLE[i % 4]; const [brand, model, serial] = UNITS[i % 4]; const date = `2025-0${1 + (i % 9)}-1${i % 9}`;
  const lines = [...SHOP, 'SERVICE TICKET', `Date of Service: ${mmddyyyy(date)}`, `Customer: ${name}`, `Service Address: ${addr}`, `Customer phone: ${phone}`,
    `Equipment: ${brand} ${model} Serial: ${serial}`, 'Visit Type: Repair', 'Work Performed:', '- Replaced capacitor', ...techs.map((t) => `Technician: ${t}`), 'Status: Completed', ...extra];
  const truth = { customer_name: name, service_address: addr, customer_phone: phone, manufacturer: brand, model, serial_number: serial, service_date: date, technician: techs[0], status: 'Completed', service_type: 'Repair' };
  if (drop) { const k = lines.findIndex((l) => l.startsWith(drop)); lines.splice(k, 1); delete truth[{ 'Customer:': 'customer_name', 'Service Address:': 'service_address' }[drop]]; }
  return { lines, truth };
}
function warranty(i) {
  const [name, addr] = PEOPLE[i % 4]; const [brand, model, serial] = UNITS[i % 4]; const inst = `2022-0${1 + (i % 9)}-05`;
  return { lines: [...SHOP, 'WARRANTY REGISTRATION', `Customer: ${name}`, `Service Address: ${addr}`, `Manufacturer: ${brand}`, `Model: ${model}`, `Serial: ${serial}`, `Installation Date: ${mmddyyyy(inst)}`, 'Warranty Term: 10 year parts'],
    truth: { customer_name: name, service_address: addr, manufacturer: brand, model, serial_number: serial, installation_date: inst, warranty_term: '10 year parts' } };
}
function quote(i) {
  const [name, addr] = PEOPLE[i % 4]; const date = `2024-1${i % 3}-2${i % 8}`;
  return { lines: [...SHOP, 'PROPOSAL / QUOTE', `Date: ${mmddyyyy(date)}`, `Customer: ${name}`, `Service Address: ${addr}`, 'Proposed Work: Replace condenser fan motor', `Estimated Cost: $${300 + i * 25}.00`, 'Valid for 30 days.'],
    truth: { customer_name: name, service_address: addr, cost: `${300 + i * 25}.00` } };
}
function invoice(i, { install = false, twoTotals = false } = {}) {
  const [name, addr, phone] = PEOPLE[i % 4]; const [brand, model, serial] = UNITS[i % 4]; const date = `2025-0${1 + (i % 9)}-0${1 + (i % 8)}`;
  const lines = [...SHOP, 'INVOICE', `Invoice #: INV-${31000 + i}`, `Date: ${mmddyyyy(date)}`, `Bill To: ${name}`, `Service Address: ${addr}`, `Phone: ${phone}`, `Equipment: ${brand} ${model}`, `Serial: ${serial}`,
    'Description of work:', install ? 'Install 3 ton system' : 'Replace contactor', `TOTAL DUE: $${180 + i}.50`, ...(twoTotals ? [`TOTAL DUE: $${999 + i}.00`] : []), `Technician: ${TECHS[i % 3]}`, 'Status: Completed'];
  return { lines, truth: { customer_name: name, service_address: addr, customer_phone: phone, invoice_number: `INV-${31000 + i}`, service_date: date, status: 'Completed', cost: `${180 + i}.50`, manufacturer: brand, model, serial_number: serial, technician: TECHS[i % 3] } };
}

const generated = [];
for (let i = 0; i < 4; i++) {
  generated.push({ name: `gen-ticket-${i}`, ...ticket(i), flate: i % 2 === 1, expect: 'accept' });
  generated.push({ name: `gen-warranty-${i}`, ...warranty(i), flate: i % 2 === 0, expect: 'accept' });
  generated.push({ name: `gen-quote-${i}`, ...quote(i), flate: i % 2 === 1, expect: 'accept' });
  generated.push({ name: `gen-invoice-${i}`, ...invoice(i), flate: i % 2 === 0, expect: 'accept' });
}
// TRAPS: every one of these must fall through to the model (reject), never be guessed.
const traps = [
  ['two-technicians', ticket(0, { techs: ['Marcus Bell', 'Danny Ochoa'] })],
  ['unexplained-prose', ticket(1, { extra: ['Customer said the unit also makes a rattling noise at night and asked us to look at the attic fan next visit.'] })],
  ['reminder-language', ticket(2, { extra: ['Please schedule the next filter change in six months.'] })],
  ['conflicting-phone', ticket(3, { extra: ['Customer phone: (480) 555-9999'] })],
  // A service ticket now needs a service address OR a serial number (documentTypes.js REQUIRED_FIELDS), so the trap drops both.
  ['missing-required-address', (() => { const t = ticket(0, { drop: 'Service Address:' }); return { ...t, lines: t.lines.filter((l) => !l.startsWith('Equipment:')) }; })()],
  ['install-invoice', invoice(1, { install: true })],
  ['two-different-totals', invoice(2, { twoTotals: true })],
  ['no-title', { lines: [...SHOP, 'Customer: Robert Castillo', 'Service Address: 918 W Palm Ln, Tempe, AZ 85281', 'Notes: called back'], truth: {} }],
  ['not-a-form', { lines: ['Hey Danny,', 'can you swing by the Castillo place tomorrow morning?', 'Thanks, Marcus'], truth: {} }],
];
for (const [name, d] of traps) generated.push({ name: `trap-${name}`, ...d, flate: false, expect: 'reject' });

/* ------------------------------------------------------------------ run everything */
const labels = JSON.parse(fs.readFileSync(rel('scripts/r32/labels.json'), 'utf8'));
const cases = [];
for (const d of labels.docs) cases.push({ name: d.file, bytes: fs.readFileSync(rel(`scripts/r32/fixtures/${d.file}`)), truth: d.truth, expect: 'any', type: d.type, group: 'corpus' });
for (const d of labels.tools) cases.push({ name: d.file, bytes: fs.readFileSync(rel(`scripts/r32/fixtures/${d.file}`)), truth: d.truth, expect: d.expect, type: d.type, group: 'tools' });
for (const g of generated) cases.push({ name: g.name, bytes: makePdf(g.lines, { flate: g.flate }), truth: g.truth, expect: g.expect, group: g.expect === 'reject' ? 'traps' : 'generated' });

const perField = new Map(); // key -> { emitted, correct, truth, found }
const bump = (k, f) => { const r = perField.get(k) ?? { emitted: 0, correct: 0, truth: 0, found: 0 }; r[f]++; perField.set(k, r); return r; };
const stat = { total: 0, accepted: 0, pagesTotal: 0, pagesSkipped: 0, refusedRead: 0 };
const wrong = [];
const norm = (k, v) => String(v).replace(/\s+/g, ' ').trim().toLowerCase();
for (const c of cases) {
  stat.total++;
  const layer = readPdfTextLayer(c.bytes);
  const nPages = layer.ok ? layer.pages.length : 1;
  stat.pagesTotal += nPages;
  if (!layer.ok) {
    stat.refusedRead++;
    if (c.expect.startsWith('read-refused')) check(`${c.name}: image/OCR PDF refused (${layer.reason})`, layer.reason === c.expect.split(':')[1] || layer.reason.startsWith(c.expect.split(':')[1]), layer.reason);
    else if (c.expect === 'accept') check(`${c.name}: text layer readable`, false, layer.reason);
    else if (c.expect === 'reject') check(`${c.name}: trap rejected`, true);
    continue;
  }
  if (c.expect.startsWith('read-refused')) { check(`${c.name}: image/OCR PDF refused`, false, 'was read as text'); continue; }
  const r = extractFromText(layer.pages);
  if (!r.accepted) {
    if (c.expect === 'accept') check(`${c.name}: accepted`, false, r.reason);
    continue;
  }
  if (c.expect === 'reject' || c.expect === 'reject-any') { check(`${c.name}: trap rejected`, false, 'accepted'); continue; }
  stat.accepted++; stat.pagesSkipped += nPages;
  const seen = new Set();
  for (const f of r.toolInput.fields) {
    if (f.key in c.truth) {
      // a repeatable key (work_performed) is compared only when truth lists it; single-valued keys count the first value
      if (seen.has(f.key)) continue; seen.add(f.key);
      const ok = norm(f.key, f.value) === norm(f.key, c.truth[f.key]);
      bump(f.key, 'emitted'); if (ok) bump(f.key, 'correct'); else wrong.push(`${c.name} ${f.key}: got "${f.value}" want "${c.truth[f.key]}"`);
    }
  }
  for (const k of Object.keys(c.truth)) { bump(k, 'truth'); if (seen.has(k)) bump(k, 'found'); }
  if (c.group === 'generated' || c.group === 'tools') {
    // generated + tool docs are fully labelled: an emitted key outside the truth set is an unexplained extra
    const extra = r.toolInput.fields.filter((f) => !(f.key in c.truth) && !/^shop_|^work_performed$|^notes$/.test(f.key));
    if (extra.length) wrong.push(`${c.name} unlabelled fields: ${extra.map((f) => f.key + '=' + f.value).join(', ')}`);
  }
}
console.log('\nper-field (accepted docs only; precision = correct/emitted, recall = found/truth):');
let E = 0, C = 0;
for (const [k, v] of [...perField].sort()) {
  E += v.emitted; C += v.correct;
  console.log(`  ${k.padEnd(22)} precision ${(v.emitted ? (100 * v.correct / v.emitted).toFixed(1) : '  n/a').padStart(6)}% (${v.correct}/${v.emitted})   recall ${(v.truth ? (100 * v.found / v.truth).toFixed(1) : ' n/a').padStart(6)}% (${v.found}/${v.truth})`);
}
const precision = E ? C / E : 0;
console.log(`\nlabelled documents: ${stat.total}; accepted deterministically: ${stat.accepted} (${(100 * stat.accepted / stat.total).toFixed(1)}%); pages skipping the model: ${stat.pagesSkipped}/${stat.pagesTotal} (${(100 * stat.pagesSkipped / stat.pagesTotal).toFixed(1)}%)`);
console.log(`overall field precision: ${(100 * precision).toFixed(2)}% (${C}/${E})`);
for (const w of wrong.slice(0, 15)) console.log('   wrong:', w);
check('>=60 labelled documents', stat.total >= 60, String(stat.total));
check('field-level precision >= 99%', precision >= 0.99 && wrong.length === 0, `${(100 * precision).toFixed(2)}% wrong=${wrong.length}`);
check('a meaningful share of documents skip the model', stat.accepted / stat.total >= 0.4, String(stat.accepted / stat.total));

/* ------------------------------------------------------------------ classifier */
{
  const layer = (b) => readPdfTextLayer(b).pages;
  const t = classifyFromText(layer(makePdf(ticket(0).lines)));
  check('classifyFromText: title line decides the type', t?.type === 'service-ticket' && t.confidence >= 0.9, JSON.stringify(t));
  check('classifyFromText: no title -> null (model/heuristics decide)', classifyFromText(layer(makePdf(['Hello Danny', 'see attached', 'Customer: X']))) == null);
  check('classifyFromText: a title-like word in prose is not a title', classifyFromText(layer(makePdf(['Please send the invoice by Friday', 'Thanks']))) == null);
}

/* ------------------------------------------------------------------ kill switches */
{
  const on = {}, master = { MODEL_AVOIDANCE: '0' };
  check('switches default ON (deterministic paths)', sw.isTextLayerReadEnabled(on) && sw.isDeterministicExtractEnabled(on) && sw.isDeterministicClassifyEnabled(on) && sw.isDeterministicFinancialsEnabled(on) && sw.isNonQuestionGateEnabled(on));
  check('opt-in model paths default OFF (dossier, autopilot)', !sw.isDossierModelEnabled(on) && !sw.isAutopilotModelEnabled(on));
  check('each per-feature kill switch turns only its own path off', !sw.isTextLayerReadEnabled({ PDF_TEXT_LAYER: '0' }) && sw.isDeterministicExtractEnabled({ PDF_TEXT_LAYER: '0' }) && !sw.isDeterministicExtractEnabled({ EXTRACT_DETERMINISTIC: '0' }) && !sw.isDeterministicClassifyEnabled({ CLASSIFY_DETERMINISTIC: '0' }) && !sw.isDeterministicFinancialsEnabled({ FINANCIALS_DETERMINISTIC: '0' }) && !sw.isNonQuestionGateEnabled({ ASK_NONQUESTION_GATE: '0' }));
  check('MODEL_AVOIDANCE=0 restores pre-R32 behaviour everywhere', !sw.isTextLayerReadEnabled(master) && !sw.isDeterministicExtractEnabled(master) && !sw.isDeterministicClassifyEnabled(master) && !sw.isDeterministicFinancialsEnabled(master) && !sw.isNonQuestionGateEnabled(master) && sw.isDossierModelEnabled(master) && sw.isAutopilotModelEnabled(master));
  check('opt-ins turn on explicitly', sw.isDossierModelEnabled({ DOSSIER_MODEL: '1' }) && sw.isAutopilotModelEnabled({ DONOVAN_AUTOPILOT_MODEL: '1' }));
}

/* ------------------------------------------------------------------ ask non-question gate */
{
  const yes = ['hi', 'Hello there!', 'thanks!', 'thank you', 'good morning', 'ok', 'asdfgh', 'qwerty asdf', '???', '\u{1F600}', 'tell me a joke', "what's the weather", 'who are you', 'write me a poem about love'];
  for (const q of yes) check(`gate answers without a model: ${JSON.stringify(q)}`, classifyNonQuestion(q) != null);
  const no = ['when was the unit at 88 Whitmore Ave installed', 'Smith', 'Ng', 'warranty for Smith', 'hi, when was 88 whitmore installed', 'who serviced the Trane last', 'how many customers do we have', 'C-00012', 'thanks, now show me invoices', 'weather stripping on the rooftop unit', 'what is the serial number', 'tell me about Henderson', 'joke', ''];
  for (const q of no) check(`gate leaves a real question alone: ${JSON.stringify(q)}`, classifyNonQuestion(q) == null);
  let bank = 0, hits = [];
  const files = [rel('test-docs/scorecard/exam.json'), ...(fs.existsSync(rel('test-docs/scorecard/generalization')) ? fs.readdirSync(rel('test-docs/scorecard/generalization')).map((f) => rel(`test-docs/scorecard/generalization/${f}`)) : [])];
  for (const f of files) if (fs.existsSync(f)) for (const q of JSON.parse(fs.readFileSync(f, 'utf8')).questions ?? []) { bank++; const t = q.question ?? q.text ?? q.q; if (classifyNonQuestion(t)) hits.push({ t, oracle: q.shape ?? q.cmp }); }
  check(`gate never fires on a real exam question (${bank} checked; hits only on out_of_domain/honest-zero)`, hits.every((h) => /out_of_domain|honest-zero|refus|decline/i.test(String(h.oracle))), JSON.stringify(hits));
  const src = fs.readFileSync(rel('api/ask.js'), 'utf8');
  check('ask.js wires the gate behind its switch, after help routing and before the router', src.includes('isNonQuestionGateEnabled()') && src.indexOf('classifyNonQuestion(question)') > src.indexOf('answerHowTo(question)') && src.indexOf('classifyNonQuestion(question)') < src.indexOf('await classifyAll('));
}

/* ------------------------------------------------------------------ financials + dossier from text */
{
  const inv = invoice(2);
  const pages = readPdfTextLayer(makePdf(inv.lines)).pages;
  const f = financialsInputFromText(pages, 'invoice');
  check('financialsInputFromText: printed total, number, date, customer, job address', f?.total?.value === inv.truth.cost && f.invoice_number === inv.truth.invoice_number && f.invoice_date === inv.truth.service_date && f.customer_name === inv.truth.customer_name && f.job_address === inv.truth.service_address, JSON.stringify(f));
  check('financialsInputFromText: total carries page + verbatim so normalizeFinancials can verify it', f?.total?.page_no === 1 && /\$182\.50/.test(f?.total?.verbatim ?? ''));
  check('financialsInputFromText: a two-total invoice yields nothing (model decides)', financialsInputFromText(readPdfTextLayer(makePdf(invoice(2, { twoTotals: true }).lines)).pages, 'invoice') == null);
  check('financialsInputFromText: non-money types yield nothing', financialsInputFromText(readPdfTextLayer(makePdf(ticket(0).lines)).pages, 'service-ticket') == null);
  // Golden agreement: every corpus invoice/quote/agreement we accept has the same total the golden template parser stored.
  const g = JSON.parse(fs.readFileSync(rel('scripts/golden/golden-export.json'), 'utf8'));
  const finByDoc = new Map(g.financials.map((x) => [x.document_id, x]));
  const pagesByDoc = new Map(); for (const p of g.pages) (pagesByDoc.get(p.document_id) ?? pagesByDoc.set(p.document_id, []).get(p.document_id)).push({ page_no: p.page_no, text: p.text });
  let n = 0, agree = 0, disagree = [];
  for (const d of g.documents) {
    const fin = finByDoc.get(d.id); if (!fin) continue;
    const inp = financialsInputFromText(pagesByDoc.get(d.id) ?? [], d.document_type); if (!inp) continue;
    n++; if (Number(inp.total.value) === Number(fin.total)) agree++; else disagree.push(d.original_filename);
  }
  check(`financials: deterministic total == golden total on all ${n} accepted money documents`, n > 50 && agree === n, disagree.slice(0, 5).join(','));
  const sents = deterministicDossierSentences({ id: 'doc-1', pages: readPdfTextLayer(makePdf(ticket(1).lines)).pages });
  check('dossier: deterministic sentences are cited (documentId + page) and built only from printed values', sents.length >= 2 && sents.every((s) => s.citations[0].documentId === 'doc-1' && s.citations[0].page === 1) && sents[0].text.includes('Service ticket') && /Serial|serial/.test(sents[1].text), JSON.stringify(sents));
  check('dossier: an unexplained document contributes nothing (never a guess)', deterministicDossierSentences({ id: 'd', pages: readPdfTextLayer(makePdf(traps[1][1].lines)).pages }).length === 0);
}

/* ------------------------------------------------------------------ ingest wiring: no model client when the text layer suffices */
{
  const rd = fs.readFileSync(rel('api/_lib/readDocument.js'), 'utf8');
  const ex = fs.readFileSync(rel('api/_lib/extractDocument.js'), 'utf8');
  check('readDocument: text layer tried before extractWithClaude, behind PDF_TEXT_LAYER', rd.indexOf('readPdfTextLayer(') > 0 && rd.indexOf('isTextLayerReadEnabled(') > 0 && rd.indexOf('readPdfTextLayer(') < rd.indexOf('await extractWithClaude('));
  check('extractDocument: deterministic extraction before the model, behind EXTRACT_DETERMINISTIC', ex.indexOf('extractFromText(') > 0 && ex.indexOf('extractFromText(') < ex.indexOf('await assertModelBudget(ctx)'));
  const q = fs.readFileSync(rel('api/_lib/queue.js'), 'utf8'), e = fs.readFileSync(rel('api/extract.js'), 'utf8');
  check('queue + api/extract use the deterministic-first financials hook', /modelAvoidance\/financialsHook\.js/.test(q) && /modelAvoidance\/financialsHook\.js/.test(e));
  const tops = fs.readdirSync(rel('api')).filter((f) => /\.(js|ts)$/.test(f));
  check('api/ top-level function count unchanged (<= 12 Vercel functions)', tops.length <= 12, String(tops.length));
  const ap = fs.readFileSync(rel('api/_lib/learning/autopilot.js'), 'utf8');
  check('autopilot: nightly model spend is opt-in', ap.includes('isAutopilotModelEnabled(env)'));
  const dz = fs.readFileSync(rel('api/_lib/search/dossier.js'), 'utf8');
  check('dossier: model summaries opt-in, deterministic default', dz.includes('isDossierModelEnabled() && hasApiKey()') && dz.includes('deterministicDossierSentences('));
  const rs = fs.readFileSync(rel('api/_lib/reviewStore.js'), 'utf8');
  check('reclassify: title classifier runs before classifyByModel, behind CLASSIFY_DETERMINISTIC', rs.indexOf('classifyFromText(') > 0 && rs.indexOf('classifyFromText(') < rs.indexOf('await classifyByModel('));
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll R32 model-avoidance checks passed');
process.exit(failed ? 1 : 0);
