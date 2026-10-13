#!/usr/bin/env python3
"""Train the LOCAL PLAN PROPOSER's skeleton head (api/_lib/dql/learned/proposer.json). Fixed seed; no model API; streams rows into sparse matrices.

Reproduce (the factory lives outside the repo: /home/claude/work/factory; the heavy parts under the shared lock):
  1. node scripts/gen-proposer-rows.mjs --out /tmp/claude-0/r20l/rows --cap 3500 --dev 400    # factory TRAIN + DEV splits only, slot-masked with each company's own vocabulary
  2. /home/claude/work/lockrun python3 scripts/train-dql-proposer.py --rows /tmp/claude-0/r20l/rows --out api/_lib/dql/learned/proposer.json \
        --report /tmp/claude-0/r20l/proposer-report.json [--holdout church,gym,storage,photostudio]     # company-held-out run: those companies' rows are dropped from training AND tuning
One softmax head over the plan skeleton ("op|entity|measure|groupBy|distinct|limit|ask" or "none"); features = hashed word 1-3-grams, skip-grams and char n-grams of the masked
question (the same function as shapeFeats in api/_lib/dql/learned/shape3.js). Temperature-calibrated on the dev rows of the companies that were trained on.
"""
import argparse, json, math, os, random, sys, zlib
from collections import Counter, defaultdict
import numpy as np, scipy.sparse as sp
from scipy.optimize import minimize_scalar

ap = argparse.ArgumentParser()
ap.add_argument('--rows', required=True); ap.add_argument('--out', required=True); ap.add_argument('--report', default=None)
ap.add_argument('--holdout', default=''); ap.add_argument('--seed', type=int, default=7)
ap.add_argument('--epochs', type=int, default=8); ap.add_argument('--lr', type=float, default=0.06); ap.add_argument('--l2', type=float, default=3e-6)
ap.add_argument('--prune', type=float, default=0.10); ap.add_argument('--topk', type=int, default=4); ap.add_argument('--nfeat', type=int, default=90000)
ap.add_argument('--th', type=float, default=0.65); ap.add_argument('--mindf', type=int, default=3); ap.add_argument('--minclass', type=int, default=8)
args = ap.parse_args()
random.seed(args.seed); np.random.seed(args.seed)
HOLD = set(x for x in args.holdout.split(',') if x)
NB = 1 << 21; MASK = NB - 1
def hid(s): return zlib.crc32(s.encode('utf-8')) & MASK
def feats(v):  # mirror of shapeFeats (api/_lib/dql/learned/shape3.js)
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
    p = os.path.join(args.rows, src + '.jsonl')
    if not os.path.exists(p): return
    with open(p) as fh:
        for l in fh: yield json.loads(l)

tr = []
for src in ('b1', 'b2', 'b3', 'b4'):
    for r in rows(src):
        if r['t'] in HOLD: continue
        tr.append(r)
cnt = Counter(r['y'] for r in tr)
keepc = set(c for c, n in cnt.items() if n >= args.minclass)
tr = [r for r in tr if r['y'] in keepc]
print('train rows', len(tr), 'classes', len(keepc), file=sys.stderr)
dev = {}
for nm, src in (('dev1', 'b1d'), ('dev2', 'b2d'), ('dev3', 'b3d'), ('dev4', 'b4d')): dev[nm] = list(rows(src))
dev_seen = {nm: [r for r in L if r['t'] not in HOLD] for nm, L in dev.items()}
dev_held = [r for L in dev.values() for r in L if r['t'] in HOLD]
classes = sorted(keepc); ci = {c: i for i, c in enumerate(classes)}; K = len(classes)

def mat(L, colmap, nc):
    ip = [0]; ind = []
    for r in L:
        ids = feats(r['v'].split()); c = colmap[ids]; c = c[c >= 0]; ind.append(c.astype(np.int32)); ip.append(ip[-1] + len(c))
    ind = np.concatenate(ind) if ind else np.zeros(0, dtype=np.int32); ipa = np.array(ip)
    dat = np.repeat(1.0 / np.sqrt(np.maximum(np.diff(ipa), 1)), np.diff(ipa)).astype(np.float32)
    return sp.csr_matrix((dat, ind, ipa), shape=(len(L), nc), dtype=np.float32)

df = np.zeros(NB, dtype=np.int32)
for r in tr: df[feats(r['v'].split())] += 1
keep = np.nonzero(df >= args.mindf)[0]; colmap = -np.ones(NB, dtype=np.int64); colmap[keep] = np.arange(len(keep))
print('features kept', len(keep), file=sys.stderr)
Xtr = mat(tr, colmap, len(keep)); Wtr = np.array([min(r['w'], 3) for r in tr], dtype=np.float32)
ytr = np.array([ci[r['y']] for r in tr])
DFK = df[keep].astype(np.float64)
tune = [r for nm in ('dev2', 'dev3', 'dev4') for r in dev_seen[nm]] + dev_seen['dev1']
Xtune = mat(tune, colmap, len(keep)); ytune = np.array([ci.get(r['y'], -1) for r in tune])

def fit_softmax(X, y, w, K, evalf, epochs, bs=2048, lr=0.06, l2=3e-6, seed=7, patience=2):
    rs = np.random.RandomState(seed); n, d = X.shape
    W = np.zeros((d, K), dtype=np.float32); b = np.zeros(K, dtype=np.float32)
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
        sc = evalf(W, b); print('   epoch', ep, 'dev acc', round(sc, 4), file=sys.stderr)
        if sc > best[0]: best = (sc, W.copy(), b.copy(), ep)
        elif ep - best[3] >= patience: break
    return best
def evalf(W, b):
    ok = ytune >= 0
    return float(((Xtune @ W + b).argmax(1) == ytune)[ok].mean())
sc, Wb, bb, bep = fit_softmax(Xtr, ytr, Wtr, K, evalf, args.epochs, lr=args.lr, l2=args.l2, seed=args.seed)
print('best epoch', bep, 'tune acc', round(sc, 4), file=sys.stderr)
imp = np.abs(Wb).max(1) * np.sqrt(DFK); sel = np.sort(np.argsort(-imp)[:min(args.nfeat, Wb.shape[0])])
Wb, colsel = Wb[sel], keep[sel]
feats_out = {}; absmax = np.abs(Wb).max(1)
for j in np.nonzero(absmax >= args.prune)[0]:
    col = Wb[j]; order = np.argsort(-np.abs(col))[:args.topk]; ent = []
    for c in order:
        if abs(col[c]) >= args.prune: ent += [int(c), round(float(col[c]), 2)]
    if ent: feats_out[str(int(colsel[j]))] = ent
exp = {'classes': classes, 'b': [round(float(x), 3) for x in bb], 'feats': feats_out}
def score_exp(L):
    out = np.zeros((len(L), K)) + np.array(exp['b'])
    for r_, r in enumerate(L):
        ids = feats(r['v'].split()); inv = 1.0 / math.sqrt(len(ids))
        for i in ids:
            e = feats_out.get(str(int(i)))
            if e:
                for j in range(0, len(e), 2): out[r_, e[j]] += e[j + 1] * inv
    return out
Zt = score_exp(tune); ok = ytune >= 0
def nll(T):
    z = Zt[ok] / T; z = z - z.max(1, keepdims=True); lp = z - np.log(np.exp(z).sum(1, keepdims=True)); return -lp[np.arange(ok.sum()), ytune[ok]].mean()
T = float(minimize_scalar(nll, bounds=(0.3, 8.0), method='bounded').x); exp['T'] = round(T, 3)
def softmax(z, T):
    z = z / T; z = z - z.max(1, keepdims=True); e = np.exp(z); return e / e.sum(1, keepdims=True)
report = {'train_rows': len(tr), 'classes': K, 'holdout': sorted(HOLD), 'T': exp['T'], 'n_feats': len(feats_out)}
def rep(name, L):
    if not L: return
    Z = score_exp(L); pr = softmax(Z, exp['T']); pred = pr.argmax(1); conf = pr.max(1); y = np.array([ci.get(r['y'], -1) for r in L]); w = np.array([r['w'] for r in L], dtype=float)
    nonnone = np.array([classes[p] != 'none' for p in pred])
    d = {'n': len(L), 'acc': float(((pred == y) * w).sum() / w.sum())}
    d['by_th'] = {str(th): {'coverage_nonnone': float(((conf >= th) & nonnone).mean()), 'label_precision': float((((pred == y) & (conf >= th) & nonnone)).sum() / max(((conf >= th) & nonnone).sum(), 1))} for th in (0.8, 0.9, 0.95, 0.98, 0.99)}
    report[name] = d
    print(name, d['n'], 'acc', round(d['acc'], 4), {k: (round(v['coverage_nonnone'], 3), round(v['label_precision'], 4)) for k, v in d['by_th'].items()}, file=sys.stderr)
for nm in ('dev1', 'dev2', 'dev3', 'dev4'): rep(nm, dev_seen[nm])
rep('heldout_companies', dev_held)
model = {'version': 1, 'seed': args.seed, 'hash': {'bits': 21, 'fn': 'crc32'}, 'generic': json.load(open(os.path.join(args.rows, 'generic.json'))), 'head': exp, 'thresholds': {'prob': args.th}}
with open(args.out, 'w') as fh: json.dump(model, fh, separators=(',', ':'))
print('wrote', args.out, os.path.getsize(args.out), file=sys.stderr)
if args.report:
    with open(args.report, 'w') as fh: json.dump(report, fh, indent=1)
