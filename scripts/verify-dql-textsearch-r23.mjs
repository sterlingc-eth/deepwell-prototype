/**
 * verify:dql-textsearch-r23 - round 23: a zero from the stored fields is never said as "No ... mention"; quoted words and line-item conditions are never dropped as filler.
 *   node scripts/verify-dql-textsearch-r23.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
let failures = 0; let passes = 0;
const check = (name, ok, detail = '') => { if (ok) passes++; else failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${String(detail).slice(0, 500)}`}`); };

delete process.env.ANTHROPIC_API_KEY;
delete process.env.DONOVAN_DQL;
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && /^\{"/.test(a[0])) return; realLog(...a); };
console.warn = () => {}; console.error = () => {};

const off = await import('./offline-exam.mjs');
await off.installPgHarness(); await off.installModelBlock();
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/golden/golden-export.json'), 'utf8'));
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const ctx = (await off.loadExportIntoNewTenant(lite, data, { tenantKey: 'offline:dql-textsearch-r23', tenantName: 'dql-textsearch-r23' })).ctx;
const { withTenant, getTenantContext } = await import('../api/_lib/recordsStore.js');
const { getTenantVocab } = await import('../api/_lib/vocab/tenantVocab.js');
const { packForTenant } = await import('../api/_lib/industry/index.js');
const { parseDql, runDql } = await import('../api/_lib/dql/index.js');
const { allFamilies } = await import('../api/_lib/dql/registry.js');
const { classifyAll } = await import('../api/_lib/router/classifyAll.js');
const { runDecompose } = await import('../api/_lib/decompose/index.js');

const TODAY = '2026-10-07';
const ctxArg = { tenantKey: ctx.tenantKey, tenantName: 'dql-textsearch-r23' };
const pack = await packForTenant({ withTenant, ctxArg });
const tv = await withTenant(ctxArg, (db) => getTenantVocab(db, ctx.tenantKey, pack));

/* ------------------------------------------------------------------ the independent oracle (plain JS over the raw export rows) */
const eff = (x) => (x.corrected_value && x.corrected_value !== '' ? x.corrected_value : x.value);
const valuesOf = new Map(); // doc id -> field -> [every value]
for (const x of data.extractions) {
  if (!valuesOf.has(x.document_id)) valuesOf.set(x.document_id, {});
  const m = valuesOf.get(x.document_id);
  (m[x.field_key] ??= []).push(eff(x));
}
const last = (id, k) => { const v = valuesOf.get(id)?.[k]; return v ? v[v.length - 1] : null; };
const finOf = new Map(data.financials.map((f) => [f.document_id, f]));
const ents = new Map(data.entities.map((e) => [e.id, e]));
const custOfDoc = new Map();
for (const l of data.document_entity_links) {
  const e = ents.get(l.entity_id); if (!e) continue;
  const cid = e.entity_type === 'customer' ? e.id : e.customer_id;
  if (cid && ents.get(cid)) { if (!custOfDoc.has(l.document_id)) custOfDoc.set(l.document_id, new Set()); custOfDoc.get(l.document_id).add(cid); }
}
const hr = new Set(data.documents.filter((d) => String(d.document_type).replace(/_/g, '-') === 'hr-letter').map((d) => d.id));
const internal = new Set(data.documents.filter((d) => last(d.id, '_audience') === 'internal').map((d) => d.id));
const docs = data.documents.filter((d) => !hr.has(d.id) && !internal.has(d.id)).map((d) => ({ ...d, type: String(d.document_type).replace(/_/g, '-') }));
const docIds = new Set(docs.map((d) => d.id));
const lines = data.financial_lines.filter((l) => docIds.has(l.document_id));
const customers = data.entities.filter((e) => e.entity_type === 'customer' && !e.merged_into);
const units = data.entities.filter((e) => e.entity_type === 'equipment' && !e.merged_into);
const int = (n) => n.toLocaleString('en-US');
const money = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const textsOf = (d) => [...(valuesOf.get(d.id)?.work_performed ?? []), ...(valuesOf.get(d.id)?.notes ?? []), ...lines.filter((l) => l.document_id === d.id).map((l) => l.description)];
const mentions = (re, filter = () => true) => docs.filter((d) => filter(d) && textsOf(d).some((t) => re.test(t)));
const NEG = /\b(?:no|not|without|none|never)\b[^,;.]{0,24}\b(?:leak|leaks|leaking)\b/i;


/* R23: text and line-item phrase searches. A zero from searching the stored fields is only a lower bound (the papers' page text is not in the snapshot),
   so "No ... mention" is never said; a quoted word or a line-item condition is never dropped as filler. Releases are never wrong. */
async function ask(q) {
  const debug = {};
  const intent = parseDql(q, { tenantVocab: tv, pack, today: TODAY, debug });
  if (!intent) return { intent: null, data: null, why: debug.why };
  let out = null;
  try { out = await withTenant(ctxArg, (db) => runDql(db, intent, { today: TODAY })); } catch (e) { out = null; }
  return { intent, data: out };
}
const said = (r) => String(r.data?.text ?? '');
const noMention = (r) => !/I read the text of (?:all|every)/i.test(said(r)) && /\bNo\b[^.]{0,80}\b(?:mention|have a line|has a line)/i.test(said(r));
const released = async (name, q) => { const r = await ask(q); check(`release :: ${name}`, !r.data, `${r.intent?.plan?.op ?? 'no plan'} | ${said(r)}`); return r; };
const neverNo = async (name, q) => { const r = await ask(q); check(`no false none :: ${name}`, !noMention(r), said(r)); return r; };

// 1. a term that is not in the stored fields: never "No ... mention"
const absent = ['water damage', 'zebra', 'flamingo', 'gasket', 'wallpaper', 'tractor', 'pineapple', 'umbrella', 'violin', 'lantern'];
for (const w of absent) await neverNo(`documents mention ${w}`, `how many documents mention ${w}`);
for (const w of absent.slice(0, 5)) await neverNo(`which invoices mention ${w}`, `which invoices mention ${w}`);
for (const w of absent.slice(0, 4)) await neverNo(`any notes about ${w}`, `any notes mentioning ${w}`);
for (const w of absent.slice(0, 4)) await neverNo(`lines with ${w}`, `all lines that say ${w}`);
for (const w of absent.slice(0, 3)) await neverNo(`talking about ${w}`, `how many tickets are talking about ${w}`);
for (const w of absent.slice(0, 3)) await neverNo(`reference ${w}`, `any invoices that reference ${w}`);
for (const w of absent.slice(0, 3)) await neverNo(`total billed for ${w}`, `total of invoices with a line mentioning ${w}`);

// 2. line-item / quoted conditions in yes/no questions: never answered without the condition
const lineYn = [
  'is there any po placed with home supply co of at most 2500 dollars that include wiper',
  'is there any invoice that includes wiper',
  'is there any purchase order that include "wiper"',
  'are there any invoices that have "barrel" as a line',
  'did we have any POs that have "wiper" as a line this year',
  'any invoices with a "filter" line item',
  'is there an estimate that includes a capacitor line item',
  'do we have any invoices above 500 dollars that have "gasket" as a line',
  'is there any quote that include "wiper" from last year',
  'tell me if there are any invoices with a heads line item',
];
for (const q of lineYn) {
  const r = await ask(q);
  const ok = !r.data || r.intent?.plan?.op === 'line_search' || r.intent?.plan?.op === 'page_find' || r.intent?.plan?.op === 'text_search';
  check(`yes/no keeps its line-item condition :: ${q}`, ok && !(r.intent?.plan?.op === 'exists_yes_no' && r.data), `${r.intent?.plan?.op} | ${said(r)}`);
}

// 3. filler after a phrase is not part of the phrase; quoted words are
for (const q of ['how many documents mention capacitor asap', 'how many documents mention capacitor please', 'how many documents mention capacitor if possible']) {
  const r = await ask(q);
  check(`filler trimmed :: ${q}`, !r.data || !/possible|asap|please/i.test(said(r).replace(/if possible/i, '')), said(r));
}
{
  const r = await ask('how many documents mention "capacitor asap"');
  check('quoted words stay in the phrase', !r.data || !noMention(r) , said(r));
}

// 4. real hits are still answered with the number the independent reading gives
const cap = mentions(/capacitor/i);
let r = await ask('how many documents mention a capacitor');
check('hit :: documents that mention a capacitor are counted', cap.length > 0 && r.data && said(r).includes(int(cap.length)), said(r));
const l454 = lines.filter((l) => /r-?454b/i.test(l.description));
r = await ask('all lines that say R-454B');
check('hit :: line items that mention R-454B are counted', r.data && l454.length > 0 && said(r).includes(int(new Set(l454.map((l) => l.document_id)).size)), said(r));
const tr = lines.filter((l) => /trane/i.test(l.description) && /install/i.test(l.description));
r = await ask('how much have we billed for Trane installs');
check('hit :: billed for Trane installs adds up the matching lines', tr.length > 0 && r.data && said(r).includes(money(sum(tr.map((l) => Number(l.amount))))), said(r));

// 5. yes/no and counts without a text condition are not touched
for (const q of ['is there any invoice over 500 dollars', 'how many invoices are on file', 'did we have any service tickets in 2024', 'are there any purchase orders']) {
  const r2 = await ask(q);
  check(`unchanged :: ${q}`, !r2.intent || r2.intent.plan.op !== 'line_search', `${r2.intent?.plan?.op} | ${said(r2)}`);
}

// 6. wiring: the new guard lives in the DQL parser; the api folder keeps 12 files
const apiTop = fs.readdirSync(path.join(ROOT, 'api')).filter((f) => fs.statSync(path.join(ROOT, 'api', f)).isFile());
check('wiring :: api/ keeps exactly 12 top-level files', apiTop.length === 12, String(apiTop.length));

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
