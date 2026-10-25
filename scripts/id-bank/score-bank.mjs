// npm run score:id-bank - scores the reading pipeline and Donovan on the SYNTHETIC people / compliance paperwork bank
// (test-docs/id-bank/, built by scripts/id-bank/make-bank.py). Not a gate: it reports, per ARRIVAL STYLE (clean text PDF,
// scanned image-only PDF, phone photo) and overall:
//   - doc type accuracy        strict (the mapped DeepWell type) and lenient (any acceptable type)
//   - field accuracy           gold canonical fields read with the right value / read with a WRONG value / not read
//   - reader text coverage     is each printed value present in the page text at all (separates OCR loss from extraction loss)
//   - Donovan answer accuracy  the real /api/ask handler (offline PGlite, model blocked) over the bank loaded as the pipeline read it
//   - wrong-answer rate        confident answers that are wrong (the number that must go to zero), plus abstentions
//   - Donovan ceiling          the same questions with the GOLD fields loaded: what Donovan can do when reading is perfect
// "needs the model" = the deterministic path gave no answer and production would call the paid model (blocked here), so it is neither right nor wrong.
// Page text for scans / photos is tesseract standing in for the paid vision model (see make-bank.py), so photo / scan numbers
// are a floor for production, not a measure of it. Usage:
//   Donovan's people lane is behind DONOVAN_READER_V2_IDDOCS=1 (default OFF); --role member asks as a caller who may NOT open People and HR (default admin).
//   node scripts/id-bank/score-bank.mjs [--tree <repo root>] [--json out.json] [--no-donovan] [--verbose] [--style clean|scan|photo]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadPipeline, runDoc } from '../real-docs/pipeline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const TREE = path.resolve(arg('--tree') ?? ROOT);
const BANK = path.join(ROOT, 'test-docs/id-bank');
const VERBOSE = argv.includes('--verbose');
const ONLY = arg('--style');
const TODAY = '2026-10-25';
const truths = fs.readdirSync(path.join(BANK, 'truth')).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(BANK, 'truth', f), 'utf8'))).filter((t) => !ONLY || t.arrival === ONLY);
const pagesById = new Map(JSON.parse(fs.readFileSync(path.join(BANK, 'pages-bank.json'), 'utf8')).docs.map((d) => [d.id, d]));
const STYLES = ['clean', 'scan', 'photo'];
// DeepWell deliberately keeps no ID / card / bank / birth-date values (api/ask.js privacy rule), so questions about these are
// scored apart: the right behaviour is to decline, and giving the value out is a LEAK.
// The gold fields use the bank's canonical keys; the app stores people papers under person-specific keys (holder_name / employee_name,
// issued_by, start_date) so no employee ever becomes a "customer". A gold key counts as read when ANY of its aliases carries the right value.
const ALIASES = { customer_name: ['customer_name', 'holder_name', 'employee_name'], vendor: ['vendor', 'issued_by'], service_date: ['service_date', 'start_date', 'signed_date'], customer_phone: ['customer_phone', 'employee_phone'], customer_email: ['customer_email', 'employee_email'] };
const goldToStored = (t) => Object.entries(t.fields).flatMap(([k, v]) => {
  const hr = t.type === 'hr-letter';
  if (k === 'customer_name') return [{ k: hr ? 'employee_name' : 'holder_name', v: String(v) }];
  if (k === 'service_date' && (t.kind.startsWith('newhire') || t.kind.startsWith('dot'))) return [{ k: 'start_date', v: String(v) }];
  if (hr && k === 'customer_phone') return [{ k: 'employee_phone', v: String(v) }]; // HR-scoped keys (round 4): an employee's contact details and signed date
  if (hr && k === 'customer_email') return [{ k: 'employee_email', v: String(v) }];
  if (hr && k === 'service_date') return [{ k: 'signed_date', v: String(v) }];
  if (k === 'vendor' && t.type === 'license-certification') return [{ k: 'vendor', v: String(v) }, { k: 'issued_by', v: String(v) }];
  return [{ k, v: String(v) }];
});
const SENSITIVE = new Set(['license_number', 'dob', 'routing_number', 'account_number', 'ssn', 'vin', 'naic', 'plate']);

const realLog = console.log;
console.warn = () => {}; if (!process.env.DEBUG) console.error = () => {};
const P = await loadPipeline(TREE);

// ---------------------------------------------------------------- comparison helpers
const nameNorm = (s) => String(s ?? '').toLowerCase().replace(/\b[a-z]\b\.?/g, ' ').replace(/[^a-z0-9]/g, '');
const alnum = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const isDateKey = (k) => /(_date|_expires)$/.test(k) || ['dob'].includes(k);
const dateVariants = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso); if (!m) return [iso]; const [, y, mo, d] = m; const mn = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'][+mo - 1]; return [`${y}-${mo}-${d}`, `${mo}/${d}/${y}`, `${+mo}/${+d}/${y}`, `${mo}/${d}/${y.slice(2)}`, `${mn} ${+d}, ${y}`, `${mn.slice(0, 3)} ${+d}, ${y}`, `${String(+d).padStart(2, '0')} ${mn.slice(0, 3)} ${y}`]; };
function sameVal(key, read, gold) {
  if (isDateKey(key)) { const nd = (v) => P.ef.normalizeDate(String(v), { order: 'mdy' }) ?? String(v); return nd(read) === nd(gold); }
  if (/phone/.test(key)) return String(read).replace(/\D/g, '').slice(-10) === String(gold).replace(/\D/g, '').slice(-10);
  if (key === 'customer_name' || key === 'manager' || key === 'emergency_contact') return nameNorm(read) === nameNorm(gold);
  return alnum(read) === alnum(gold);
}
/** Is a gold value present anywhere in the page text? (dates in any common print form; others alnum-contained) */
function inText(key, value, text) {
  if (isDateKey(key)) { const t = text.toLowerCase(); return dateVariants(value).some((v) => t.includes(v.toLowerCase())) || alnum(text).includes(alnum(value)); }
  if (key === 'customer_name') return nameNorm(text).includes(nameNorm(value));
  return alnum(text).includes(alnum(value));
}
const answerHit = (accept, shown) => { const s = alnum(shown); return accept.some((a) => a && s.includes(alnum(a))); };

// ---------------------------------------------------------------- 1. reading: type + fields
const blank = () => ({ docs: 0, typeStrict: 0, typeLenient: 0, typeNull: 0, goldFields: 0, fCorrect: 0, fWrong: 0, fMissed: 0, textVals: 0, textHit: 0, qs: 0, aCorrect: 0, aWrong: 0, sQs: 0, sLeak: 0, sOk: 0, aAbstain: 0, aModel: 0, oCorrect: 0, oWrong: 0, oAbstain: 0, oModel: 0, needsPerson: 0 });
const S = { all: blank(), ...Object.fromEntries(STYLES.map((s) => [s, blank()])) };
let policySkipped = 0;
const byKind = {}; const typeConf = {}; const missedKeys = {}; const wrongKeys = {}; const readDocs = [];
const bump = (t, fn) => { fn(S.all); fn(S[t.arrival]); };
for (const t of truths) {
  const pg = pagesById.get(t.id); const doc = { filename: pg.filename, pages: pg.pages };
  let r; try { r = runDoc(P, doc, { today: TODAY }); } catch (e) { r = { type: null, fields: [], verdict: { ok: false }, needsPerson: true, error: String(e?.message ?? e).slice(0, 80) }; }
  const text = pg.pages.map((p) => p.text).join('\n');
  const rt = r.type ? P.dt.canonicalTypeId?.(r.type) ?? r.type : null;
  const strict = rt === t.type, lenient = t.acceptable_types.includes(rt);
  const fields = (r.fields ?? []).map((f) => ({ k: f.field_key, v: String(f.value) }));
  let c = 0, w = 0, m = 0; const wrongList = [], missList = [];
  for (const [k, v] of Object.entries(t.fields)) {
    const hits = fields.filter((f) => (ALIASES[k] ?? [k]).includes(f.k));
    if (!hits.length) { m++; missList.push(k); missedKeys[k] = (missedKeys[k] ?? 0) + 1; } else if (hits.some((h) => sameVal(k, h.v, v))) c++; else { w++; wrongList.push({ k, gold: v, read: hits.map((h) => h.v).join(' | ') }); wrongKeys[k] = (wrongKeys[k] ?? 0) + 1; }
  }
  let th = 0, tn = 0; for (const [k, v] of [...Object.entries(t.fields), ...Object.entries(t.extra)]) { tn++; if (inText(k, String(v), text)) th++; }
  bump(t, (b) => { b.docs++; b.typeStrict += strict; b.typeLenient += lenient; b.typeNull += rt ? 0 : 1; b.goldFields += c + w + m; b.fCorrect += c; b.fWrong += w; b.fMissed += m; b.textVals += tn; b.textHit += th; b.needsPerson += r.needsPerson ? 1 : 0; });
  const kk = (byKind[t.kind.replace(/-(typed|handwritten|card|cert|long)$/, '')] ??= { docs: 0, strict: 0, lenient: 0, c: 0, n: 0 }); kk.docs++; kk.strict += strict; kk.lenient += lenient; kk.c += c; kk.n += c + w + m;
  const tc = (typeConf[`${t.type} -> ${rt ?? 'none'}`] ??= 0); typeConf[`${t.type} -> ${rt ?? 'none'}`] = tc + 1;
  readDocs.push({ t, r, rt, wrongList, missList });
  if (VERBOSE) realLog(`${t.id} [${t.arrival}] type ${rt} (want ${t.type})${strict ? '' : ' X'}  fields ${c}/${c + w + m}${wrongList.length ? ' WRONG ' + JSON.stringify(wrongList) : ''}${missList.length ? ' missed ' + missList.join(',') : ''}`);
}

// ---------------------------------------------------------------- 2. Donovan: real /api/ask handler over an offline PGlite tenant
const uid = () => crypto.randomUUID();
function buildExport(tenantKey, mode) {
  const ex = { tenantKey, tenantName: tenantKey, documents: [], pages: [], extractions: [], entities: [], document_entity_links: [], facets: [], financials: [], financial_lines: [] };
  const ents = new Map(); const now = '2026-10-25T12:00:00Z';
  for (const d of readDocs) {
    const { t, r } = d; const pg = pagesById.get(t.id); const docId = uid();
    const type = mode === 'gold' ? t.type : (d.rt ?? 'other');
    const fields = mode === 'gold' ? goldToStored(t) : (r.fields ?? []).map((f) => ({ k: f.field_key, v: String(f.value) }));
    ex.documents.push({ id: docId, batch_id: null, original_filename: pg.filename, document_type: type, sha256_hash: crypto.createHash('sha256').update(t.id + mode).digest('hex'), file_size_bytes: 1000, stage: 'linked', created_at: now, processed_at: now });
    pg.pages.forEach((p) => ex.pages.push({ id: uid(), document_id: docId, page_no: p.page_no, text: p.text, created_at: now }));
    const who = fields.find((f) => f.k === 'customer_name')?.v; // people papers carry holder_name / employee_name, so they create no customer
    let entId = null;
    if (who) { const key = alnum(who); if (!ents.has(key)) { const id = uid(); ents.set(key, id); ex.entities.push({ id, entity_type: 'customer', merged_into: null, customer_number: `C-${String(ents.size).padStart(5, '0')}`, data: { customer_name: who }, created_at: now, updated_at: now }); } entId = ents.get(key); ex.document_entity_links.push({ id: uid(), document_id: docId, entity_id: entId, confidence: 0.9, linked_by: 'id-bank', created_at: now }); }
    for (const f of fields) ex.extractions.push({ id: uid(), document_id: docId, entity_id: entId, field_key: f.k, value: f.v, confidence: 0.9, source_facet_id: null, schema_version: 1, created_at: now });
  }
  return ex;
}
const NO_ANS = /nothing in your records|no record|couldn.t find|could not find|don.t have|do not have|not sure|no answer|which one|did you mean|can.t tell|unable to|can.t answer|no contact info|no documents are linked|nothing stored|may still be processing|on file for/i;
let donovan = null;
if (!argv.includes('--no-donovan')) {
  const off = await import(path.join(TREE, 'scripts/offline-exam.mjs').replace(/^/, 'file://'));
  const log0 = console.log; console.log = (...a) => { if (typeof a[0] === 'string' && /^\{"/.test(a[0])) return; log0(...a); };
  await off.installPgHarness(); await off.installModelBlock();
  const { askViaHandler } = await import('file://' + path.join(TREE, 'api/_lib/scorecard/askCall.js'));
  const { default: handler } = await import('file://' + path.join(TREE, 'api/ask.js'));
  donovan = {};
  for (const mode of ['read', 'gold']) {
    const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
    const key = `idbank-${mode}`; const { ctx } = await off.loadExportIntoNewTenant(lite, buildExport(key, mode), { tenantKey: `offline:${key}`, tenantName: key });
    const results = [];
    for (const d of readDocs) for (const q of d.t.questions) {
      let res; try { res = await askViaHandler({ handler, auth: { tenantId: ctx.tenantKey, orgId: key, userId: null, orgRole: arg('--role') ?? 'admin' }, question: q.q, today: TODAY }); } catch (e) { res = { data: null, error: String(e?.name ?? e) }; }
      const dd = res.data; const shown = `${dd?.text ?? ''} ${(dd?.facts ?? []).map((f) => `${f.label ?? ''} ${f.value ?? ''}`).join(' ')}`;
      const answered = !!dd && dd.kind === 'answer' && !NO_ANS.test(String(dd.text ?? '')) && String(dd.text ?? '').trim().length > 0;
      const needsModel = !dd && /Processing failed/.test(String(res.error ?? ''));   // the model is blocked offline: a question the deterministic path could not answer
      const verdict = needsModel ? 'model' : !answered ? 'abstain' : answerHit(q.accept, shown) ? 'correct' : 'wrong';
      results.push({ sens: SENSITIVE.has(q.key), id: d.t.id, arrival: d.t.arrival, q: q.q, want: q.answer, kind: dd?.kind ?? res.error, text: String(dd?.text ?? '').slice(0, 160), verdict });
    }
    donovan[mode] = results;
  }
  console.log = log0;
  for (const mode of ['read', 'gold']) for (const x of donovan[mode]) {
    const pre = mode === 'read' ? 'a' : 'o'; const field = { correct: 'Correct', wrong: 'Wrong', abstain: 'Abstain', model: 'Model' }[x.verdict];
    bump({ arrival: x.arrival }, (b) => { if (x.sens) { if (mode === 'read') { b.sQs++; if (x.verdict === 'correct') b.sLeak++; else b.sOk++; } return; } if (mode === 'read') b.qs++; b[pre + field]++; });
  }
}

// ---------------------------------------------------------------- 3. report
const pct = (a, b) => (b ? `${(100 * a / b).toFixed(1)}%` : 'n/a');
const out = [];
const L = (s = '') => out.push(s);
L('# id-bank score  (synthetic people / compliance paperwork; ' + truths.length + ' documents)');
L(`tree: ${TREE}   today: ${TODAY}`);
L('');
const cols = ['all', ...STYLES].filter((c) => c === 'all' || S[c].docs);
const row = (label, f) => L(`${label.padEnd(44)}${cols.map((c) => String(f(S[c])).padStart(18)).join('')}`);
L(''.padEnd(44) + cols.map((c) => c.padStart(18)).join(''));
row('documents', (b) => b.docs);
row('doc type accuracy (strict)', (b) => `${pct(b.typeStrict, b.docs)} ${b.typeStrict}/${b.docs}`);
row('doc type accuracy (any acceptable)', (b) => `${pct(b.typeLenient, b.docs)} ${b.typeLenient}/${b.docs}`);
row('  no type at all', (b) => b.typeNull);
row('field accuracy (read right / gold)', (b) => `${pct(b.fCorrect, b.goldFields)} ${b.fCorrect}/${b.goldFields}`);
row('  field read WRONG (of gold)', (b) => `${pct(b.fWrong, b.goldFields)} ${b.fWrong}`);
row('  field not read', (b) => `${pct(b.fMissed, b.goldFields)} ${b.fMissed}`);
row('reader text has the value (all values)', (b) => `${pct(b.textHit, b.textVals)} ${b.textHit}/${b.textVals}`);
row('docs left needing a person', (b) => `${pct(b.needsPerson, b.docs)} ${b.needsPerson}`);
if (donovan) {
  row('Donovan questions (excluding policy-declined kinds)', (b) => b.qs);
  row('Donovan answer accuracy (as read)', (b) => `${pct(b.aCorrect, b.qs)} ${b.aCorrect}/${b.qs}`);
  row('  WRONG-answer rate (of all questions)', (b) => `${pct(b.aWrong, b.qs)} ${b.aWrong}`);
  row('  wrong of answered', (b) => `${pct(b.aWrong, b.aWrong + b.aCorrect)}`);
  row('  abstained (said it has no answer)', (b) => `${pct(b.aAbstain, b.qs)} ${b.aAbstain}`);
  row('  needs the model (blocked offline)', (b) => `${pct(b.aModel, b.qs)} ${b.aModel}`);
  row('ID / bank / DOB questions (policy: decline)', (b) => `${b.sQs} asked`);
  row('  declined or no answer (correct)', (b) => `${pct(b.sOk, b.sQs)} ${b.sOk}`);
  row('  value given out (LEAK)', (b) => `${b.sLeak}`);
  row('Donovan ceiling (gold fields loaded)', (b) => `${pct(b.oCorrect, b.qs)} ${b.oCorrect}/${b.qs}`);
  row('  ceiling wrong-answer rate', (b) => `${pct(b.oWrong, b.qs)} ${b.oWrong}`);
  row('  ceiling needs the model', (b) => `${pct(b.oModel, b.qs)} ${b.oModel}`);
}
L(''); L('## by document family   (type strict / type any / field accuracy)');
for (const [k, v] of Object.entries(byKind).sort()) L(`${k.padEnd(26)} ${String(v.docs).padStart(3)} docs   ${pct(v.strict, v.docs).padStart(6)}  ${pct(v.lenient, v.docs).padStart(6)}  ${pct(v.c, v.n).padStart(6)}`);
L(''); L('## type confusion (expected -> read)');
for (const [k, v] of Object.entries(typeConf).sort((a, b) => b[1] - a[1])) L(`${String(v).padStart(4)}  ${k}`);
L(''); L('## fields most often missed: ' + Object.entries(missedKeys).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));
L('## fields most often read wrong: ' + (Object.entries(wrongKeys).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'));
if (donovan && VERBOSE) { L(''); L('## wrong answers (as read)'); for (const x of donovan.read.filter((x) => x.verdict === 'wrong')) L(`${x.id} [${x.arrival}] ${x.q} -> want "${x.want}" got "${x.text}"`); }
realLog(out.join('\n'));
const jp = arg('--json'); if (jp) fs.writeFileSync(jp, JSON.stringify({ summary: S, byKind, typeConf, missedKeys, wrongKeys, donovan, docs: readDocs.map((d) => ({ id: d.t.id, arrival: d.t.arrival, want: d.t.type, read: d.rt, wrong: d.wrongList, missed: d.missList })) }, null, 1));
process.exit(0);
