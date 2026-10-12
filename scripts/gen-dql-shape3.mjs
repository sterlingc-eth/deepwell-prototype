/**
 * scripts/gen-dql-shape3.mjs - training rows for the version-3 shape heads (api/_lib/dql/learned/shape3.js), streamed from ALL factory train/dev splits.
 *   /home/claude/work/lockrun node scripts/gen-dql-shape3.mjs --out /tmp/claude-0/r16l/rows [--cap 40]
 * Per company: builds the vocabulary card (dql/card.js) from the company's own export, derives the mask lexicon, writes masked rows
 * {s: bank/split, t: tenant, v: masked text, pat, multi, fu, meas}. Never reads a test split. Rows with an identical masked text and labels are merged (weight w).
 */
import fs from 'node:fs'; import zlib from 'node:zlib'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const A = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1]]] : a), []));
const F = '/home/claude/work/factory'; const OUT = A.out ?? '/tmp/claude-0/r16l/rows'; fs.mkdirSync(OUT, { recursive: true });
const { buildCard } = await import(`${ROOT}/api/_lib/dql/card.js`);
const { maskLexicon, maskText } = await import(`${ROOT}/api/_lib/dql/learned/shape3.js`);
const NEW4 = ['petgroom', 'feedstore', 'eventvenue', 'msp', 'tutoring', 'trucking', 'salon', 'restaurant', 'church', 'gym', 'storage', 'photostudio'];
const tenants = [...new Set(fs.readdirSync(`${F}/tenants`).filter((x) => /^[a-z]+\.json$/.test(x)).map((x) => x.slice(0, -5)).concat(NEW4))];
const lexOf = {};
for (const t of tenants) {
  const p = fs.existsSync(`${F}/tenants/${t}.json`) ? `${F}/tenants/${t}.json` : `${F}/tenants4/${t}.json`;
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const typeById = new Map(raw.documents.map((d) => [d.id, String(d.document_type).toLowerCase()]));
  const tc = new Map(); for (const ty of typeById.values()) tc.set(ty, (tc.get(ty) ?? 0) + 1);
  const names = raw.entities.filter((e) => e.entity_type === 'customer').map((e) => e.data?.customer_name).filter(Boolean);
  const card = buildCard({ rows: raw.extractions.map((x) => ({ k: x.field_key, t: typeById.get(x.document_id), v: x.value })).filter((r) => r.v != null && r.t), docTypes: [...tc].map(([id, n]) => ({ id, n })), custNames: names, nDocs: typeById.size });
  lexOf[t] = maskLexicon(card, names);
  console.error(t, 'lexicon', lexOf[t].words.size);
}
// generic = words in the lexicon of >= 5 companies (they name something everywhere: invoice, customer, total ...)
const df = new Map(); for (const l of Object.values(lexOf)) for (const w of l.words) df.set(w, (df.get(w) ?? 0) + 1);
const generic = new Set([...df].filter(([, n]) => n >= 5).map(([w]) => w));
console.error('generic', generic.size);
fs.writeFileSync(`${OUT}/generic.json`, JSON.stringify([...generic].sort()));

const FU = (r) => {
  const pat = r.pattern; const ek = r.expect?.kind;
  if (r.prior == null && ek !== 'cite') return 'none';
  if (ek === 'cite' || /provenance|cite|source/.test(pat)) return 'provenance';
  if (/slot_swap/.test(pat)) return 'swap';
  if (/refine/.test(pat)) return 'refine';
  if (/correct/.test(pat)) return 'correct';
  return r.prior == null ? 'none' : 'followup';
};
const MEAS = (r) => { const m = r.plan?.measure; return m ?? (r.plan?.op === 'multi' ? 'multi' : 'none'); };
const sources = [['b1', `${F}/questions/out`, null], ['b2', `${F}/questions/out2`, null], ['b3', `${F}/questions/out3/train3`, 'train'], ['b3d', `${F}/questions/out3/dev3`, 'dev'], ['b4', `${F}/questions/out4/train4`, 'train'], ['b4d', `${F}/questions/out4/dev4`, 'dev']];
const outs = {};
for (const [tag, dir, fixed] of sources) {
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl.gz')).sort()) {
    const t = f.replace(/-\d+\.jsonl\.gz$/, ''); if (!lexOf[t]) continue;
    const agg = new Map();
    for (const l of zlib.gunzipSync(fs.readFileSync(path.join(dir, f))).toString().split('\n')) {
      if (!l) continue; const r = JSON.parse(l);
      const split = fixed ?? r.split; if (split === 'test') continue;
      const src = (tag.startsWith('b1') || tag === 'b2') ? `${tag}${split === 'dev' ? 'd' : ''}` : tag;
      if (split !== 'train' && split !== 'dev') continue;
      const v = maskText(r.q, lexOf[t], generic).join(' ');
      const key = [src, t, v, r.pattern, r.plan?.op === 'multi' ? 1 : 0, FU(r), MEAS(r)].join('\t');
      agg.set(key, (agg.get(key) ?? 0) + 1);
    }
    for (const [k, w] of agg) { const [src, tt, v, pat, multi, fu, meas] = k.split('\t'); (outs[src] ??= fs.createWriteStream(`${OUT}/${src}.jsonl`)).write(JSON.stringify({ s: src, t: tt, v, pat, multi: multi === '1' ? 'multi' : 'single', fu, meas, w }) + '\n'); }
  }
  console.error('done', tag);
}
for (const o of Object.values(outs)) o.end();
