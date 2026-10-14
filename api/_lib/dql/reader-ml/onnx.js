/**
 * dql/reader-ml/onnx.js - the GPU-trained reader (scripts/learned-reader kit output: model.onnx + labels.json + calibration.json) through onnxruntime.
 *
 * Drop-in: put the three files (and, for a Hugging Face encoder, the tokenizer/ folder) in the reader's data directory (see docs/LEARNED_READER.md).
 * Backends, tried in this order: `onnxruntime-node` (native; ~250 MB unpacked with every platform, so it does not fit a 250 MB Vercel function bundle
 * unless trimmed), then `onnxruntime-web` (WebAssembly, ~13 MB of wasm; runs in Node). Neither is a dependency of the app: install the one the
 * deployment can carry. A 330 MB fp32 encoder does not fit a function either way: quantize it to int8 first (docs) or serve it from its own
 * inference route and set DONOVAN_LEARNED_REMOTE_URL (the request carries only the ANONYMIZED text, never a company word).
 * The tokenizer is re-implemented here (byte-level BPE for RoBERTa-family encoders, and the small word tokenizer of the from-scratch model).
 */
import fs from 'node:fs';
import { HEADS } from './model.js';

const bytesToUnicode = (() => {
  const bs = []; for (let i = 33; i <= 126; i++) bs.push(i); for (let i = 161; i <= 172; i++) bs.push(i); for (let i = 174; i <= 255; i++) bs.push(i);
  const cs = bs.slice(); let n = 0; for (let b = 0; b < 256; b++) if (!bs.includes(b)) { bs.push(b); cs.push(256 + n); n++; }
  const m = new Map(); bs.forEach((b, i) => m.set(b, String.fromCharCode(cs[i]))); return m;
})();
const PRE = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

export function makeBpeTokenizer(tj, maxLen) {
  const vocab = new Map(Object.entries(tj.model.vocab)); const ranks = new Map();
  tj.model.merges.forEach((m, i) => ranks.set(Array.isArray(m) ? m.join(' ') : m, i));
  const added = tj.added_tokens.filter((a) => !['<s>', '<pad>', '</s>', '<unk>', '<mask>'].includes(a.content)); // the role tokens: matched as whole strings
  const addedRx = added.length ? new RegExp(`(${added.map((a) => a.content.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`) : null;
  const addedId = new Map(added.map((a) => [a.content, a.id]));
  const cls = tj.post_processor.cls[1]; const sep = tj.post_processor.sep[1]; const unk = vocab.get('<unk>') ?? 3;
  const cache = new Map();
  const bpe = (tok) => {
    if (cache.has(tok)) return cache.get(tok);
    let w = [...tok];
    while (w.length > 1) {
      let best = -1; let bi = -1;
      for (let i = 0; i < w.length - 1; i++) { const r = ranks.get(`${w[i]} ${w[i + 1]}`); if (r !== undefined && (best < 0 || r < best)) { best = r; bi = i; } }
      if (bi < 0) break; w = [...w.slice(0, bi), w[bi] + w[bi + 1], ...w.slice(bi + 2)];
    }
    cache.set(tok, w); return w;
  };
  return {
    encode(text) {
      const ids = [];
      for (const seg of addedRx ? text.split(addedRx) : [text]) {
        if (!seg) continue; if (addedId.has(seg)) { ids.push(addedId.get(seg)); continue; }
        for (const m of seg.matchAll(PRE)) { const u = [...Buffer.from(m[0], 'utf8')].map((b) => bytesToUnicode.get(b)).join(''); for (const p of bpe(u)) ids.push(vocab.get(p) ?? unk); }
      }
      return [cls, ...ids.slice(0, maxLen - 2), sep];
    },
    padId: tj.added_tokens.find((a) => a.content === '<pad>')?.id ?? 1,
  };
}
export function makeWordTokenizer(info, maxLen) {
  const stoi = new Map(info.vocab.map((w, i) => [w, i])); const base = info.vocab.length; const nb = info.hash_buckets;
  const fnv = (s) => { let h = 2166136261; for (const ch of Buffer.from(s, 'utf8')) { h ^= ch; h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; };
  return {
    encode(text) {
      const ids = [1];
      for (const w of text.toLowerCase().replace('<date>', '<DATE>').split(/\s+/).filter(Boolean)) {
        if (stoi.has(w)) ids.push(stoi.get(w)); else if (w.startsWith('<') && stoi.has(w.toUpperCase())) ids.push(stoi.get(w.toUpperCase())); else ids.push(base + (fnv(w) % nb));
        if (ids.length >= maxLen) break;
      }
      return ids;
    },
    padId: info.pad_id ?? 0,
  };
}

let STATE = null;
const pkg = async (n) => import(/* @vite-ignore */ n);
export async function loadOnnx(dir) {
  if (STATE && STATE.dir === dir) return STATE;
  const labels = JSON.parse(fs.readFileSync(`${dir}/labels.json`, 'utf8'));
  const tk = labels.tokenizer; const maxLen = labels.max_len ?? 64;
  const tok = tk.type === 'word' ? makeWordTokenizer(tk, maxLen) : makeBpeTokenizer(JSON.parse(fs.readFileSync(`${dir}/${tk.dir ?? 'tokenizer'}/tokenizer.json`, 'utf8')), maxLen);
  let ort = null; let which = null; for (const n of ['onnxruntime-node', 'onnxruntime-web']) { try { ort = await pkg(n); which = n; break; } catch { /* next */ } }
  if (!ort) throw new Error('learned reader: neither onnxruntime-node nor onnxruntime-web is installed');
  try { if (ort.env?.wasm) ort.env.wasm.numThreads = 1; } catch { /* native backend */ }
  const session = await ort.InferenceSession.create(`${dir}/model.onnx`, { executionProviders: [which === 'onnxruntime-web' ? 'wasm' : 'cpu'] });
  STATE = { dir, labels, tok, ort, session };
  return STATE;
}

/** anonymized text -> { A, P, Q, labels } (same shape as model.js predict) */
export async function predictOnnx(an, S) {
  const ids = S.tok.encode(an); const n = ids.length;
  const feeds = { input_ids: new S.ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, n]), attention_mask: new S.ort.Tensor('int64', BigInt64Array.from(ids.map(() => 1n)), [1, n]) };
  const out = await S.session.run(feeds);
  const A = []; const P = []; const Q = []; const labels = [];
  HEADS.forEach((h, j) => {
    const p = out[`p_${h}`].data; let best = 0; for (let i = 1; i < p.length; i++) if (p[i] > p[best]) best = i;
    let rest = 0; for (let i = 0; i < p.length; i++) if (i !== best) rest += p[i];
    A.push(best); P.push(p[best]); Q.push(rest); labels.push(S.labels.classes[h][best]);
  });
  return { A, P, Q, labels };
}
