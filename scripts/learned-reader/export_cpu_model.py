#!/usr/bin/env python3
"""Export the CPU learned-reader (E2's hashed-bag MLP, net_M.pt) to the compact binary format Donovan's Node runtime reads.
  usage: export_cpu_model.py <net.pt> <vocab.pkl> <bucket_cnt.npy> <outdir> [min_count=50]
Writes outdir/model-cpu.bin  (int8 embedding rows kept by training frequency + int8 heads, per-row fp32 scales, fp32 MLP)
       outdir/classes.json.gz (class label per head)
Format (little endian): magic 'DLR1', u32 json_len, json header {D,H,NB,heads:[{name,n}],nrows,...}, then raw sections in the header's order."""
import sys, json, gzip, struct, pickle, numpy as np, torch
net, vocab_pkl, cnt_npy, out = sys.argv[1:5]; MINC = int(sys.argv[5]) if len(sys.argv) > 5 else 50
HEADS = ['op', 'ent', 'dt', 'meas', 'time', 'grp', 'filt', 'args', 'rest']
sd = torch.load(net, map_location='cpu'); sd = {k: v.numpy() for k, v in sd.items()}
vocab = pickle.load(open(vocab_pkl, 'rb')); cnt = np.load(cnt_npy)
E = sd['emb.weight']; keep = np.where(cnt >= MINC)[0].astype(np.int32)
Ek = E[keep]; es = np.abs(Ek).max(1) / 127.0; es[es == 0] = 1e-8
Eq = np.round(Ek / es[:, None]).clip(-127, 127).astype(np.int8)
secs = []; header = {'D': E.shape[1], 'NB': E.shape[0], 'nrows': int(len(keep)), 'heads': [], 'minCount': MINC}
def add(name, arr): secs.append((name, np.ascontiguousarray(arr))); 
add('rowids', keep.astype('<i4')); add('emb_scale', es.astype('<f4')); add('emb_q', Eq)
for k in ('mlp.0.weight', 'mlp.0.bias', 'mlp.1.weight', 'mlp.1.bias', 'mlp.4.weight', 'mlp.4.bias'): add(k, sd[k].astype('<f4'))
for j, h in enumerate(HEADS):
    W = sd[f'heads.{j}.weight']; b = sd[f'heads.{j}.bias']; s = np.abs(W).max(1) / 127.0; s[s == 0] = 1e-8
    add(f'h{j}_s', s.astype('<f4')); add(f'h{j}_q', np.round(W / s[:, None]).clip(-127, 127).astype(np.int8)); add(f'h{j}_b', b.astype('<f4'))
    header['heads'].append({'name': h, 'n': int(W.shape[0])})
header['sections'] = [{'name': n, 'dtype': str(a.dtype), 'shape': list(a.shape)} for n, a in secs]
hj = json.dumps(header).encode()
with open(out + '/model-cpu.bin', 'wb') as f:
    f.write(b'DLR1'); f.write(struct.pack('<I', len(hj))); f.write(hj)
    for n, a in secs: f.write(a.tobytes())
cls = {h: [(k if k is None or isinstance(k, str) else str(k)) for k in vocab[h]] for h in HEADS}
with gzip.open(out + '/classes.json.gz', 'wt', compresslevel=9) as f: json.dump(cls, f, separators=(',', ':'))
import os; print('rows kept', len(keep), 'bin MB', os.path.getsize(out + '/model-cpu.bin') / 1e6, 'classes gz MB', os.path.getsize(out + '/classes.json.gz') / 1e6)
