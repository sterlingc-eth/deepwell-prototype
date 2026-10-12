#!/usr/bin/env python3
"""Train Donovan's learned planner, version 3 (api/_lib/dql/learned/model-v3.json): shape heads over slot-masked questions. Fixed seed; no model API.

Reproduce (the factory lives outside the repo: /home/claude/work/factory; under the shared lock for the heavy parts):
  1. node scripts/gen-dql-shape3.mjs --out /tmp/claude-0/r16l/rows        # streams ALL factory train + dev splits (out, out2, out3, out4: ~1.3M questions, 24 companies),
                                                                         # builds each company's vocabulary card, masks its own nouns -> masked rows (never a test split)
  2. /home/claude/work/lockrun python3 scripts/train-dql-shape3.py --rows /tmp/claude-0/r16l/rows --out api/_lib/dql/learned/model-v3.json \
        --report /tmp/claude-0/r16l/report.json [--holdout church,gym,storage,photostudio]   # holdout: company-held-out run (those companies' train rows are dropped)
Heads: pat (the question's pattern, 60 classes), multi (multi-part or not), fu (follow-up intent: none / followup / correct / swap / refine / provenance),
meas (which measure role the question asks for). Peak memory about 1.5 GB (rows are capped per company x pattern, streamed into sparse matrices).
"""
import argparse, glob, json, math, os, random, sys, zlib
from collections import Counter, defaultdict
import numpy as np, scipy.sparse as sp
from scipy.optimize import minimize_scalar

ap = argparse.ArgumentParser()
ap.add_argument('--rows', required=True); ap.add_argument('--out', required=True); ap.add_argument('--report', default=None)
ap.add_argument('--holdout', default=''); ap.add_argument('--cap', type=int, default=500); ap.add_argument('--seed', type=int, default=7)
ap.add_argument('--epochs', type=int, default=8); ap.add_argument('--lr', type=float, default=0.06); ap.add_argument('--l2', type=float, default=3e-6)
ap.add_argument('--prune', type=float, default=0.12); ap.add_argument('--topk', type=int, default=4); ap.add_argument('--nfeat', type=int, default=60000)
ap.add_argument('--pat-topk', type=int, default=8); ap.add_argument('--pat-prune', type=float, default=0.04); ap.add_argument('--pat-nfeat', type=int, default=30000); ap.add_argument('--heads', default='pat,multi,fu,meas')
args = ap.parse_args()
random.seed(args.seed); np.random.seed(args.seed)
HOLD = set(x for x in args.holdout.split(',') if x)
HEADS = args.heads.split(',')
NB = 1 << 21
MASK = NB - 1

def hid(s): return zlib.crc32(s.encode('utf-8')) & MASK
def feats(v):  # mirror of shapeFeats in api/_lib/dql/learned/shape3.js (hash bucket ids, set)
    seq = ['^'] + v + ['$']; f = set('w:' + t for t in seq)
    for i in range(len(seq) - 1): f.add('b:%s %s' % (seq[i], seq[i + 1]))
    for i in range(len(seq) - 2): f.add('t:%s %s %s' % (seq[i], seq[i + 1], seq[i + 2]))
    for i in range(len(seq) - 2): f.add('sk:%s_%s' % (seq[i], seq[i + 2]))
    for t in v:
        if len(t) >= 4 and t[0] != '<':
            s = ' ' + t + ' '
            for n in (3, 4, 5):
                for i in range(len(s) - n + 1): f.add('hc:' + s[i:i + n])
    f.add('len:%d' % min(len(v), 16))
    return np.unique(np.fromiter((hid(x) for x in f), dtype=np.uint32))

def rows(src):
    with open(os.path.join(args.rows, src + '.jsonl')) as fh:
        for l in fh: yield json.loads(l)

# ---- train: cap per (company, pattern) so no frame family dominates (the cap is on distinct masked texts, weighted by their multiplicity up to the cap)
rnd = random.Random(args.seed)
tr = []; seen = defaultdict(int)
for src in ('b1', 'b2', 'b3', 'b4'):
    buf = defaultdict(list)
    for r in rows(src):
        if r['t'] in HOLD: continue
        buf[(r['t'], r['pat'])].append(r)
    for k, L in buf.items():
        rnd.shuffle(L)
        for r in L[:args.cap]: tr.append(r)
    del buf
print('train rows', len(tr), file=sys.stderr)
DEVS = {'dev1': 'b1d', 'dev2': 'b2d', 'dev3': 'b3d', 'dev4': 'b4d'}
dev = {}
for nm, src in DEVS.items():
    L = [r for r in rows(src)]
    dev[nm] = L
if HOLD: dev['dev4_held'] = [r for r in dev['dev4'] if r['t'] in HOLD]
NEW4 = {'petgroom', 'feedstore', 'eventvenue', 'msp', 'tutoring', 'trucking', 'salon', 'restaurant', 'church', 'gym', 'storage', 'photostudio'}
dev['dev4_unseen'] = [r for r in dev['dev4'] if r['t'] in NEW4]

def mat(L, colmap, nc):
    ip = [0]; ind = []
    for r in L:
        ids = feats(r['v'].split()); c = colmap[ids]; c = c[c >= 0]; ind.append(c.astype(np.int32)); ip.append(ip[-1] + len(c))
    ind = np.concatenate(ind); ipa = np.array(ip)
    dat = np.repeat(1.0 / np.sqrt(np.maximum(np.diff(ipa), 1)), np.diff(ipa)).astype(np.float32)
    return sp.csr_matrix((dat, ind, ipa), shape=(len(L), nc), dtype=np.float32)

df = np.zeros(NB, dtype=np.int32)
for r in tr: df[feats(r['v'].split())] += 1
keep = np.nonzero(df >= 4)[0]; colmap = -np.ones(NB, dtype=np.int64); colmap[keep] = np.arange(len(keep))
print('features kept', len(keep), file=sys.stderr)
Xtr = mat(tr, colmap, len(keep)); Wtr = np.array([r['w'] if r['w'] < 3 else 3 for r in tr], dtype=np.float32)
Xdv = {nm: mat(L, colmap, len(keep)) for nm, L in dev.items() if L and nm in ('dev1', 'dev2', 'dev3', 'dev4', 'dev4_held', 'dev4_unseen')}
DFK = df[keep].astype(np.float64)
print('matrices ready', Xtr.shape, Xtr.nnz, file=sys.stderr)

def softmax(z, T=1.0):
    z = z / T; z = z - z.max(1, keepdims=True); e = np.exp(z); return e / e.sum(1, keepdims=True)
def fit_softmax(X, y, w, K, evalf, epochs, bs=2048, lr=0.06, l2=3e-6, seed=7, init=None, patience=2):
    rs = np.random.RandomState(seed); n, d = X.shape
    W = np.zeros((d, K), dtype=np.float32) if init is None else init[0].copy(); b = np.zeros(K, dtype=np.float32) if init is None else init[1].copy()
    m = np.zeros_like(W); v = np.zeros_like(W); mb = np.zeros_like(b); vb = np.zeros_like(b); t = 0; best = (-1, None, None, 0); b1, b2, eps = 0.9, 0.999, 1e-8
    for ep in range(epochs):
        perm = rs.permutation(n)
        for s0 in range(0, n, bs):
            idx = perm[s0:s0 + bs]; Xb = X[idx]; wb = w[idx]
            cols, inv = np.unique(Xb.indices, return_inverse=True)
            Xs = sp.csr_matrix((Xb.data, inv.astype(np.int32), Xb.indptr), shape=(len(idx), len(cols)))
            z = Xs @ W[cols] + b; z -= z.max(1, keepdims=True); p = np.exp(z); p /= p.sum(1, keepdims=True)
            p[np.arange(len(idx)), y[idx]] -= 1.0; p *= (wb / wb.sum())[:, None]
            g = (Xs.T @ p).astype(np.float32) + l2 * W[cols]; gb = p.sum(0).astype(np.float32)
            t += 1; c1 = 1 - b1 ** t; c2 = 1 - b2 ** t
            m[cols] = b1 * m[cols] + (1 - b1) * g; v[cols] = b2 * v[cols] + (1 - b2) * g * g
            W[cols] -= (lr * (m[cols] / c1) / (np.sqrt(v[cols] / c2) + eps)).astype(np.float32)
            mb = b1 * mb + (1 - b1) * gb; vb = b2 * vb + (1 - b2) * gb * gb; b -= (lr * (mb / c1) / (np.sqrt(vb / c2) + eps)).astype(np.float32)
        sc = evalf(W, b); print('   epoch', ep, 'dev', round(sc, 4), file=sys.stderr)
        if sc > best[0]: best = (sc, W.copy(), b.copy(), ep)
        elif ep - best[3] >= patience: break
    return best

# generic words and meta
generic = json.load(open(os.path.join(args.rows, 'generic.json')))
model = {'version': 3, 'seed': args.seed, 'hash': {'bits': 21, 'fn': 'crc32'}, 'generic': generic, 'heads': {}, 'thresholds': {}}
report = {'train_rows': len(tr), 'holdout': sorted(HOLD)}
TUNE = ('dev2', 'dev3', 'dev4')  # calibration sets (never test)
if HOLD: TUNE = ('dev2', 'dev3', 'dev4')
for h in HEADS:
    classes = sorted(set(r[h] for r in tr)); ci = {c: i for i, c in enumerate(classes)}; K = len(classes)
    ytr = np.array([ci[r[h]] for r in tr])
    ydv = {nm: np.array([ci.get(r[h], -1) for r in dev[nm]]) for nm in Xdv}
    def evalf(W, b, Xd=None):
        a = []
        for nm in ('dev2', 'dev3', 'dev4'):
            if nm not in Xdv: continue
            pr = (Xdv[nm] @ W + b).argmax(1) if Xd is None else (Xd[nm] @ W + b).argmax(1); a.append(float(((pr == ydv[nm]) ).mean()))
        return sum(a) / len(a)
    sc, Wb, bb, bep = fit_softmax(Xtr, ytr, Wtr, K, evalf, args.epochs, lr=args.lr, l2=args.l2, seed=args.seed)
    print(h, 'best epoch', bep, 'mean dev acc', round(sc, 4), file=sys.stderr)
    # keep the most useful features of this head (|weight| x sqrt(document frequency)); no refit (it did not help and costs memory)
    imp = np.abs(Wb).max(1) * np.sqrt(DFK); sel = np.sort(np.argsort(-imp)[:min(args.pat_nfeat if h == 'pat' else args.nfeat, Wb.shape[0])])
    PR = args.pat_prune if h == 'pat' else args.prune; TK = args.pat_topk if h == 'pat' else args.topk
    Wb, colsel = Wb[sel], keep[sel]
    feats_out = {}
    absmax = np.abs(Wb).max(1)
    for j in np.nonzero(absmax >= PR)[0]:
        col = Wb[j]; order = np.argsort(-np.abs(col))[:TK]; ent = []
        for c in order:
            if abs(col[c]) >= PR: ent += [int(c), round(float(col[c]), 2)]
        if ent: feats_out[str(int(colsel[j]))] = ent
    exp = {'classes': classes, 'b': [round(float(x), 3) for x in bb], 'feats': feats_out}
    # scoring with the exported (pruned) head, exactly like the runtime
    ids_cache = {}
    def score_exp(L):
        out = np.zeros((len(L), K)) + np.array(exp['b'])
        for r_, r in enumerate(L):
            ids = feats(r['v'].split()); inv = 1.0 / math.sqrt(len(ids))
            for i in ids:
                e = feats_out.get(str(int(i)))
                if e:
                    for j in range(0, len(e), 2): out[r_, e[j]] += e[j + 1] * inv
        return out
    Z = {nm: score_exp(dev[nm]) for nm in Xdv}
    zz = np.vstack([Z[nm] for nm in TUNE]); yy = np.concatenate([ydv[nm] for nm in TUNE]); ok = yy >= 0
    def nll(T):
        z = zz[ok] / T; z = z - z.max(1, keepdims=True); lp = z - np.log(np.exp(z).sum(1, keepdims=True)); return -lp[np.arange(ok.sum()), yy[ok]].mean()
    T = float(minimize_scalar(nll, bounds=(0.3, 8.0), method='bounded').x); exp['T'] = round(T, 3)
    model['heads'][h] = exp
    rep = {'T': exp['T'], 'n_feats': len(feats_out)}
    for nm in Z:
        pr = softmax(Z[nm], exp['T']); pred = pr.argmax(1); conf = pr.max(1); y = ydv[nm]
        rep[nm] = float((pred == y).mean())
        rep[nm + '_by_th'] = {str(th): {'coverage': float((conf >= th).mean()), 'precision': float(((pred == y) & (conf >= th)).sum() / max((conf >= th).sum(), 1))} for th in (0.8, 0.9, 0.95, 0.98, 0.99, 0.995)}
        if h == 'multi':
            cls = classes.index('multi'); m = pred == cls
            rep[nm + '_multi_by_th'] = {str(th): {'n': int((m & (conf >= th)).sum()), 'wrong': int((m & (conf >= th) & (y != cls)).sum()), 'missed': int(((y == cls) & ~(m & (conf >= th))).sum())} for th in (0.9, 0.95, 0.98, 0.99, 0.995, 0.999)}
    report[h] = rep
    print(h, 'T', exp['T'], 'feats', len(feats_out), {nm: round(rep[nm], 4) for nm in Z}, file=sys.stderr)
    del Z, Wb, bb
    import gc; gc.collect()
# thresholds: the multi veto fires only where the model is >= th AND no wrong call on any dev set (dev1-dev4 incl. the unseen companies)
th_multi = 0.999
for th in ('0.9', '0.95', '0.98', '0.99', '0.995', '0.999'):
    if all(report['multi'].get(nm + '_multi_by_th', {}).get(th, {'wrong': 0})['wrong'] == 0 for nm in Xdv): th_multi = float(th); break
model['thresholds'] = {'multi': th_multi, 'fu': 0.99, 'pat': 0.95, 'meas': 0.95}
report['thresholds'] = model['thresholds']
with open(args.out, 'w') as fh: json.dump(model, fh, separators=(',', ':'))
print('wrote', args.out, os.path.getsize(args.out), file=sys.stderr)
if args.report:
    with open(args.report, 'w') as fh: json.dump(report, fh, indent=1)
