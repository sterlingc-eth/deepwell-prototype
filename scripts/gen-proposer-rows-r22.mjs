/**
 * scripts/gen-proposer-rows.mjs - training rows for the LOCAL PLAN PROPOSER (api/_lib/dql/proposer, model api/_lib/dql/learned/proposer.json).
 *   node scripts/gen-proposer-rows.mjs --out /tmp/claude-0/r20l/rows [--cap 4000] [--dev 500] [--tenants a,b]
 * Streams the factory's TRAIN splits (out, out2: split=="train"; out3/train3; out4/train4) plus DEV splits (dev3, dev4, out/out2 split=="dev") of every company.
 * Each question is slot-masked with the company's own vocabulary (compileVocab + detectSlots + maskView, the SAME code the runtime runs) and labelled with the
 * plan SKELETON mapped from the factory plan: op|entity|measure|groupBy|distinct|limit|ask, or "none" (a question the proposer must not plan:
 * follow-ups, comparisons, pairs, unsupported filters ...). Never reads a test split. Fixed seed: a rolling hash picks the sample, no RNG state.
 * Writes {t, s, id, v, y, w} per line to <out>/<source>.jsonl and <out>/generic.json.
 */
import fs from 'node:fs'; import zlib from 'node:zlib'; import path from 'node:path';
import { loadTenant, tenantListAll, F, ROOT, TODAY } from './lib/proposer-env.mjs';
const A = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1]]] : a), []));
const OUT = A.out ?? '/tmp/claude-0/r22c/rows'; fs.mkdirSync(OUT, { recursive: true });
const CAP = Number(A.cap ?? 4000); const DEVN = Number(A.dev ?? 500);
const { compileVocab } = await import(`${ROOT}/api/_lib/dql/vocab.js`);
const { questionTokens } = await import(`${ROOT}/api/_lib/dql/translator/validate.js`);
const { detectSlots, maskView, maskLexicon } = await import(`${ROOT}/api/_lib/dql/proposer/slots.js`);
const { skeletonOf } = await import(`${ROOT}/api/_lib/dql/proposer/skeleton.js`);
const tenants = A.tenants ? A.tenants.split(',') : tenantListAll();
const sources = [['b1', `${F}/questions/out`, null], ['b2', `${F}/questions/out2`, null], ['b3', `${F}/questions/out3/train3`, 'train'], ['b4', `${F}/questions/out4/train4`, 'train'], ['b5', `${F}/questions/out5/train5`, 'train']]; // R22: TRAIN splits only - no dev rows are ever written
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

// pass 1: the company environments (vocab + lexicon)
const env = {}; const lexOf = {};
for (const t of tenants) {
  const T = await loadTenant(t, { snapshot: false });
  const vocab = compileVocab(T.tv, T.pack);
  env[t] = { vocab }; lexOf[t] = maskLexicon(vocab.card, vocab.customerNames);
  try { await T.lite.close(); } catch { /* ignore */ }
  console.error(t, 'names', vocab.names.size, 'lex', lexOf[t].words.size);
}
const df = new Map(); for (const l of Object.values(lexOf)) for (const w of l.words) df.set(w, (df.get(w) ?? 0) + 1);
const generic = new Set([...df].filter(([, n]) => n >= Math.min(5, Math.ceil(tenants.length / 4))).map(([w]) => w));
fs.writeFileSync(`${OUT}/generic.json`, JSON.stringify([...generic].sort()));

const outs = {};
for (const [tag, dir, fixed] of sources) {
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl.gz')).sort()) {
    const t = f.replace(/-\d+\.jsonl\.gz$/, ''); if (!env[t]) continue;
    const { vocab } = env[t]; const lex = lexOf[t];
    const agg = new Map(); const picked = [];
    const isDev = tag.endsWith('d');
    for (const l of zlib.gunzipSync(fs.readFileSync(path.join(dir, f))).toString().split('\n')) {
      if (!l) continue; const r = JSON.parse(l);
      const split = fixed ?? r.split; if (split === 'test') continue;
      const wantDev = false; const wantTrain = split === 'train';
      if (!wantDev && !wantTrain) continue;
      picked.push({ r, dev: wantDev });
    }
    // deterministic sample: lowest hash per (dev|train)
    const lim = (d) => (d ? DEVN : CAP);
    for (const d of [false, true]) {
      const L = picked.filter((x) => x.dev === d).sort((a, b) => hash(a.r.id) - hash(b.r.id)).slice(0, lim(d));
      for (const { r } of L) {
        const qt = questionTokens(r.q, vocab);
        const sl = detectSlots(qt, vocab, TODAY);
        const v = maskView(qt, sl, lex, generic).join(' ');
        const y = skeletonOf(r);
        const src = (tag.startsWith('b1') || tag === 'b2') ? `${tag}${d ? 'd' : ''}` : tag;
        const key = [src, t, v, y, d ? r.id : ''].join('\t');
        agg.set(key, (agg.get(key) ?? 0) + 1);
      }
    }
    for (const [k, w] of agg) { const [src, tt, v, y, id] = k.split('\t'); (outs[src] ??= fs.createWriteStream(`${OUT}/${src}.jsonl`)).write(`${JSON.stringify({ s: src, t: tt, id, v, y, w })}\n`); }
  }
  console.error('done', tag);
}
await Promise.all(Object.values(outs).map((o) => new Promise((r) => o.end(r))));
process.exit(0);
