// Generates the Demo-mode industry workspaces from the industry packs.
//   node scripts/demo/gen-industry-demos.mjs --packs <v2loop>/packs,<v2loop>/patches_ready/packs [--only realty,electrical] [--all]
// Writes, per industry that passes every check:
//   src/demo/fixtures/<slug>.demo.json              what the demo page shows (documents, dashboard numbers, suggested questions + Donovan's answers)
//   scripts/fixtures/industry-demo/<slug>.records.json  the same workspace in the reader's record format (verify:industry-demo re-asks every question against it)
//   src/demo/fixtures/index.json                    the industry list for the picker
// Every answer shown in the demo is the real Donovan reader's answer over these records (api/_lib/dql/reader-v2), checked against a gold
// answer computed from the records. Synthetic data only: invented names, 555-01xx phones, example.com e-mail. Never written anywhere the training loop reads.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { buildWorkspace, candidateQuestions, misspell, goldMatches, labelOf, hum, cap, acro, polish, fmtMoney, DEMO_TODAY } from './demoData.mjs';
import { CORE, LABELS, FAMILY_LABELS } from './industries.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_UI = path.join(ROOT, 'src', 'demo', 'fixtures'); const OUT_REC = path.join(ROOT, 'scripts', 'fixtures', 'industry-demo');
const a = process.argv.slice(2); const arg = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
const packDirs = String(arg('packs', '')).split(',').filter(Boolean);
if (!packDirs.length) { console.error('usage: --packs <dir>[,<dir>] [--only a,b] [--all]'); process.exit(2); }
const only = arg('only', '') ? arg('only').split(',') : null; const ALL = a.includes('--all');
const findPack = (id) => { for (const d of packDirs) { const p = path.join(d, id, 'pack.json'); if (fs.existsSync(p)) return { pack: JSON.parse(fs.readFileSync(p, 'utf8')), file: p }; } return null; };

let specs = CORE.map((c) => ({ ...c }));
if (ALL) { const ids = new Set(); for (const d of packDirs) for (const id of fs.readdirSync(d)) if (fs.existsSync(path.join(d, id, 'pack.json'))) ids.add(id);
  const coreIds = new Set(CORE.map((c) => c.pack));
  for (const id of [...ids].sort()) if (!coreIds.has(id) && id !== 'clinicexample' && id !== 'realty' && id !== 'realtybroker') specs.push({ slug: id, pack: id }); }
if (only) specs = specs.filter((s) => only.includes(s.slug));
const SKIP_DONE = a.includes('--resume');
const tried = path.join(OUT_REC, '.tried.json'); const triedSet = new Set(SKIP_DONE && fs.existsSync(tried) ? JSON.parse(fs.readFileSync(tried, 'utf8')) : []);
const inIndex = new Set((fs.existsSync(path.join(OUT_UI, 'index.json')) ? JSON.parse(fs.readFileSync(path.join(OUT_UI, 'index.json'), 'utf8')).industries : []).map((x) => x.slug));
if (SKIP_DONE) specs = specs.filter((s) => !inIndex.has(s.slug) && !triedSet.has(s.slug));

const { loadReaderV2, buildIndex } = await import('../../api/_lib/dql/reader-v2/index.js');
const { decide } = await import('../../api/_lib/dql/reader-v2/pipeline.js');
const R = await loadReaderV2();
const L = console.log; const VERBOSE = a.includes('--verbose'); const MAX_TRIES = +arg('max-tries', '6'); const ask = async (ix, q) => { console.log = () => {}; const t0 = Date.now(); try { return await decide(ix, q, R.M); } catch (e) { return { answered: false, text: '', docs: [], reason: 'error' }; } finally { console.log = L; if (VERBOSE) L(`  ${Date.now() - t0}ms  ${q}`); } };
const headlineOf = (t) => { const m = /^([^()]{1,80}?: [^()]+?) \(/.exec(t); return m ? m[1] : null; };

fs.mkdirSync(OUT_UI, { recursive: true }); fs.mkdirSync(OUT_REC, { recursive: true });
const index = fs.existsSync(path.join(OUT_UI, 'index.json')) ? JSON.parse(fs.readFileSync(path.join(OUT_UI, 'index.json'), 'utf8')) : { schema: 1, industries: [] };
const report = [];
for (const s of specs) {
  const found = findPack(s.pack); if (!found) { report.push({ slug: s.slug, ok: false, why: 'pack not found' }); continue; }
  const { pack } = found; const label = s.label ?? LABELS[s.slug] ?? labelOf(pack);
  let ws; try { ws = buildWorkspace({ slug: s.slug, pack, variants: s.variants }); } catch (e) { report.push({ slug: s.slug, ok: false, why: 'build: ' + e.message }); continue; }
  const ix = buildIndex(ws.records, 'demo-' + s.slug); const types = [...new Set(ws.docs.map((d) => d.type))];
  const qs = []; const misses = [];
  for (const c of candidateQuestions(ws)) {
    let kept = null;
    const taken = new Set(qs.map((q) => q.customer).filter(Boolean));
    const opts = [...c.options.filter((o) => !taken.has(o.customer)), ...c.options.filter((o) => taken.has(o.customer))];
    let tries = 0; outer: for (const o of opts) for (const q of o.phrasings) { if (++tries > MAX_TRIES) break outer; const g = await ask(ix, q); if (g.answered && goldMatches(o.gold, g.text, g.docs)) { kept = { q, g, o }; break outer; } }
    if (!kept) { misses.push(c.intent); continue; }
    c.gold = kept.o.gold; c.customer = kept.o.customer;
    const text = polish(kept.g.text, types);
    qs.push({ id: 'q' + (qs.length + 1), intent: c.intent, label: c.label, q: acro(cap(kept.q)), customer: c.customer, gold: c.gold, answer: { text, headline: headlineOf(text), docs: [...new Set(kept.g.docs ?? [])], page: kept.g.page ?? null } });
  }
  // the "did you mean" example: a misspelled customer name, offered back as the right one
  let dym = null; const base = qs.find((q) => q.intent === 'latest');
  if (base) { const typo = misspell(base.customer); const tq = base.q.split(base.customer).join(typo); const g = await ask(ix, tq); dym = { q: tq, typed: typo, suggestion: base.customer, corrected: base.q, answerOf: base.id, readerAnsweredTypoDirectly: Boolean(g.answered && goldMatches(base.gold, g.text, g.docs)) }; }
  const ok = qs.length >= 4 && !!dym;
  report.push({ slug: s.slug, ok, questions: qs.length, misses, why: ok ? '' : `only ${qs.length} questions passed${dym ? '' : ', no near-name example'}` });
  if (!ok) { L(`SKIP  ${s.slug}  ${report.at(-1).why}`); triedSet.add(s.slug); fs.writeFileSync(tried, JSON.stringify([...triedSet])); continue; }
  const fkLabel = (k) => cap(hum(k)).replace(/^Invoice number$/, 'Number').replace(/^Po number$/, 'PO number');
  const documents = ws.docs.map((d) => ({
    id: d.id, type: d.type, typeLabel: acro(cap(hum(d.type))), name: `${acro(cap(hum(d.type)))}${d.num ? ' ' + d.num : ''}${d.cust ? ' — ' + d.cust.name : d.ext.vendor_name ? ' — ' + d.ext.vendor_name : ''}`,
    file: ws.records.documents.find((x) => x.id === d.id).original_filename, date: d.date, number: d.num, customer: d.cust?.name ?? null, vendor: d.ext.vendor_name ?? null,
    total: d.total, direction: d.spec.fin?.[1] ?? null, kind: d.spec.fin?.[0] ?? null, status: d.ext.status ?? null, pay: d.pay ?? null, endsOn: d.endsOn ?? null,
    fields: Object.entries(d.ext).filter(([k]) => !['work_performed', 'notes'].includes(k)).map(([k, v]) => [fkLabel(k), d.moneyKeys.includes(k) ? fmtMoney(v) : v]),
    billable: d.billable, lines: d.lines, subtotal: d.subtotal, tax: d.tax, taxRate: d.taxRate, taxLabel: d.taxLabel,
    pages: d.pages,
  }));
  const customers = ws.custs.map((c) => ({ id: c.id, name: c.name, address: c.addr, phone: c.phone, email: c.email, docs: ws.docs.filter((d) => d.cust === c).length }));
  const fixture = { schema: 1, synthetic: true, slug: s.slug, label, family: pack.team_family ?? 'other', familyLabel: FAMILY_LABELS[pack.team_family] ?? 'More industries', pack: { id: pack.id, version: pack.pack_version ?? '1.0', variants: s.variants ?? [Object.keys(pack.variants)[0]] },
    company: ws.company, customerNoun: ws.custNoun, staffNoun: ws.staffNoun, staff: ws.staff, demoToday: DEMO_TODAY, documents, customers, questions: qs.map(({ gold, ...q }) => q), didYouMean: dym,
    gold: Object.fromEntries(qs.map((q) => [q.id, q.gold])) };
  fs.writeFileSync(path.join(OUT_UI, s.slug + '.demo.json'), JSON.stringify(fixture) + '\n');
  fs.writeFileSync(path.join(OUT_REC, s.slug + '.records.json'), JSON.stringify(ws.records) + '\n');
  index.industries = index.industries.filter((x) => x.slug !== s.slug);
  index.industries.push({ slug: s.slug, label, family: fixture.family, familyLabel: fixture.familyLabel, company: ws.company, core: CORE.some((c) => c.slug === s.slug) });
  saveIndex();   // after every industry, so a long run that stops part-way keeps what it made
  L(`PASS  ${s.slug}`);
}
function saveIndex() {
  const coreOrder = CORE.map((c) => c.slug);
  index.industries.sort((x, y) => (coreOrder.includes(x.slug) ? coreOrder.indexOf(x.slug) : 99) - (coreOrder.includes(y.slug) ? coreOrder.indexOf(y.slug) : 99) || x.label.localeCompare(y.label));
  fs.writeFileSync(path.join(OUT_UI, 'index.json'), JSON.stringify(index, null, 1) + '\n');
}
saveIndex();
for (const x of report) L(`${x.ok ? 'PASS' : 'SKIP'}  ${x.slug}${x.ok ? `  (${x.questions} questions${x.misses.length ? '; dropped: ' + x.misses.join(', ') : ''})` : '  ' + x.why}`);
L(`${report.filter((x) => x.ok).length} of ${report.length} industries written; index has ${index.industries.length}`);
