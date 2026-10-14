// Scores the shipped CPU model on a labelled dev file: per head the top-5 class ids, probabilities and the entropy of the full distribution (the verifier's input),
// the exact miss mass, and the gold labels remapped by label string into the CPU model's class ids.
//   node scripts/learned-reader/score-top5.mjs DEV.jsonl.gz LABELS.json OUT_PREFIX     (writes OUT_PREFIX.bin and OUT_PREFIX.json)
import fs from 'node:fs'; import zlib from 'node:zlib'; import { fileURLToPath } from 'node:url';
import { loadCpuModel, predictTop5, HEADS } from '../../api/_lib/dql/reader-ml/model.js';
const [dev, labelsPath, out] = process.argv.slice(2);
const M = loadCpuModel(fileURLToPath(new URL('../../api/_lib/dql/reader-ml/data', import.meta.url)));
const G = JSON.parse(fs.readFileSync(labelsPath, 'utf8')).classes;
const idx = HEADS.map((h) => new Map(M.classes[h].map((c, i) => [JSON.stringify(c), i])));
const rows = zlib.gunzipSync(fs.readFileSync(dev)).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const n = rows.length; const QQ = new Float64Array(n * 9); const TI = new Int32Array(n * 45), TP = new Float32Array(n * 45), ENT = new Float32Array(n * 9), Y = new Int32Array(n * 9);
const t0 = process.hrtime.bigint();
rows.forEach((r, i) => {
  const pr = predictTop5(r.x, M);
  pr.Q.forEach((q, j) => { QQ[i * 9 + j] = q; });
  pr.top5.forEach((t, j) => { for (let k = 0; k < 5; k++) { TI[i * 45 + j * 5 + k] = t.ix[k]; TP[i * 45 + j * 5 + k] = t.pv[k]; } ENT[i * 9 + j] = t.ent; });
  HEADS.forEach((h, j) => { const g = JSON.stringify(G[h][r.y[j]]); Y[i * 9 + j] = idx[j].get(g) ?? -1; });
});
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
fs.writeFileSync(out + '.bin', Buffer.concat([Buffer.from(TI.buffer), Buffer.from(TP.buffer), Buffer.from(ENT.buffer), Buffer.from(Y.buffer), Buffer.from(QQ.buffer)]));
fs.writeFileSync(out + '.json', JSON.stringify({ n, ms_per_q: ms / n, g: rows.map((r) => r.g), t: rows.map((r) => r.t) }));
console.log('rows', n, 'ms/q', (ms / n).toFixed(3), 'gold missing in CPU classes', Y.filter((v) => v < 0).length);
