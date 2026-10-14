#!/usr/bin/env python3
"""R22 trainer (TRAIN splits of banks 1-5 only; company-fold out-of-company calibration; no dev rows). Train the LOCAL PLAN PROPOSER's skeleton head (api/_lib/dql/learned/proposer.json). Fixed seed; no model API; streams rows into sparse matrices.

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
ap.add_argument('--th', type=float, default=0.65); ap.add_argument('--folds', type=int, default=2); ap.add_argument('--keep', type=float, default=0.5); ap.add_argument('--mindf', type=int, default=3); ap.add_argument('--minclass', type=int, default=8)
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
for src in ('b1', 'b2', 'b3', 'b4', 'b5'):
    for r in rows(src):
        if r['t'] in HOLD: continue
        if args.keep < 1 and (zlib.crc32((r['t'] + r['v'] + r['y']).encode()) % 1000) >= args.keep * 1000: continue  # deterministic subsample (cost)
        tr.append(r)
cnt = Counter(r['y'] for r in tr)
keepc = set(c for c, n in cnt.items() if n >= args.minclass)
tr = [r for r in tr if r['y'] in keepc]
classes = sorted(keepc); ci = {c: i for i, c in enumerate(classes)}; K = len(classes)
print('train rows', len(tr), 'classes', K, file=sys.stderr)
tenants = sorted(set(r['t'] for r in tr))
fold_of = {t: (zlib.crc32(t.encode()) + 0) % args.folds for t in tenants}
# balance folds: round-robin over tenants sorted by crc
order = sorted(tenants, key=lambda t: zlib.crc32(t.encode())); fold_of = {t: i % args.folds for i, t in enumerate(order)}

def mat(L, colmap, nc):
    ip = [0]; ind = []
    for r in L:
        ids = feats(r['v'].split()); c = colmap[ids]; c = c[c >= 0]; ind.append(c.astype(np.int32)); ip.append(ip[-1] + len(c))
    ind = np.concatenate(ind) if ind else np.zeros(0, dtype=np.int32); ipa = np.array(ip)
    dat = np.repeat(1.0 / np.sqrt(np.maximum(np.diff(ipa), 1)), np.diff(ipa)).astype(np.float32)
    return sp.csr_matrix((dat, ind, ipa), shape=(len(L), nc), dtype=np.float32)

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
        sc = evalf(W, b); print('   epoch', ep, 'tune acc', round(sc, 4), file=sys.stderr)
        if sc > best[0]: best = (sc, W.copy(), b.copy(), ep)
        elif ep - best[3] >= patience: break
    return best

def build(trL, tuneL):
    """fit on trL (early stop on tuneL); return (colmap, pruned sparse W, b, exported dict)"""
    df = np.zeros(NB, dtype=np.int32)
    for r in trL: df[feats(r['v'].split())] += 1
    keep = np.nonzero(df >= args.mindf)[0]; colmap = -np.ones(NB, dtype=np.int64); colmap[keep] = np.arange(len(keep))
    Xtr = mat(trL, colmap, len(keep)); Wtr = np.array([min(r['w'], 3) for r in trL], dtype=np.float32); ytr = np.array([ci[r['y']] for r in trL])
    Xtu = mat(tuneL, colmap, len(keep)); ytu = np.array([ci[r['y']] for r in tuneL])
    sc, Wb, bb, bep = fit_softmax(Xtr, ytr, Wtr, K, lambda W, b: float(((Xtu @ W + b).argmax(1) == ytu).mean()), args.epochs, lr=args.lr, l2=args.l2, seed=args.seed)
    DFK = df[keep].astype(np.float64)
    imp = np.abs(Wb).max(1) * np.sqrt(DFK); sel = np.sort(np.argsort(-imp)[:min(args.nfeat, Wb.shape[0])])
    Wb2, colsel = Wb[sel], keep[sel]
    feats_out = {}; Wp = np.zeros_like(Wb); absmax = np.abs(Wb2).max(1)
    for j in np.nonzero(absmax >= args.prune)[0]:
        col = Wb2[j]; order_ = np.argsort(-np.abs(col))[:args.topk]; ent = []
        for c in order_:
            if abs(col[c]) >= args.prune: ent += [int(c), round(float(col[c]), 2)]; Wp[sel[j], c] = round(float(col[c]), 2)
        if ent: feats_out[str(int(colsel[j]))] = ent
    return colmap, sp.csr_matrix(Wp), np.round(bb, 3), {'classes': classes, 'b': [round(float(x), 3) for x in bb], 'feats': feats_out}, bep

def scores(L, colmap, Wp, b):
    X = mat(L, colmap, Wp.shape[0]); return np.asarray((X @ Wp).todense()) + b

# --- company-fold out-of-company predictions (the calibration set): every train row is scored by a model that never saw its company
Z_oof = np.zeros((len(tr), K), dtype=np.float32); y_all = np.array([ci[r['y']] for r in tr]); fold_idx = np.array([fold_of[r['t']] for r in tr])
rs = random.Random(args.seed)
for f in range(args.folds):
    trL = [r for r, fi in zip(tr, fold_idx) if fi != f]; teL = [r for r, fi in zip(tr, fold_idx) if fi == f]
    # early stopping on a slice of the fold's own held-out companies would leak; use a random 5% of the TRAINING rows instead
    rs.shuffle(trL); cut = len(trL) // 20; tuneL = trL[:cut]; fitL = trL[cut:]
    colmap, Wp, bb, _, bep = build(fitL, tuneL)
    Z_oof[fold_idx == f] = scores(teL, colmap, Wp, bb)
    print('fold', f, 'rows', len(teL), 'best epoch', bep, 'oof acc', round(float((Z_oof[fold_idx == f].argmax(1) == y_all[fold_idx == f]).mean()), 4), file=sys.stderr)

# --- final model on all companies
allL = list(tr); rs.shuffle(allL); cut = len(allL) // 20
colmap, Wp, bb, exp, bep = build(allL[cut:], allL[:cut])
def nll(T):
    z = Z_oof / T; z = z - z.max(1, keepdims=True); lp = z - np.log(np.exp(z).sum(1, keepdims=True)); return -lp[np.arange(len(tr)), y_all].mean()
T = float(minimize_scalar(nll, bounds=(0.3, 8.0), method='bounded').x); exp['T'] = round(T, 3)
def softmax(z, T):
    z = z / T; z = z - z.max(1, keepdims=True); e = np.exp(z); return e / e.sum(1, keepdims=True)
P = softmax(Z_oof, T); pred = P.argmax(1); conf = P.max(1)
none_i = classes.index('none')
# best plannable reading, as the runtime takes it
Pm = P.copy(); Pm[:, none_i] = -1; bi = Pm.argmax(1); bconf = Pm.max(1)
report = {'train_rows': len(tr), 'classes': K, 'T': exp['T'], 'n_feats': len(exp['feats']), 'oof': {}}
w = np.array([min(r['w'], 3) for r in tr], dtype=float)
for th in (0.8, 0.9, 0.95, 0.97, 0.98, 0.99, 0.995):
    sel = (bconf >= th) & (bi != none_i)
    wrong_none = float(((y_all == none_i) & sel).sum()); right = float(((bi == y_all) & sel).sum()); n_sel = float(sel.sum())
    report['oof'][str(th)] = {'coverage': n_sel / len(tr), 'label_precision': right / max(n_sel, 1), 'on_none_rows': wrong_none, 'n': n_sel}
    print('oof th', th, 'cov', round(n_sel / len(tr), 4), 'label precision', round(right / max(n_sel, 1), 5), 'none-as-plan', int(wrong_none), file=sys.stderr)
np.save(os.path.join(os.path.dirname(os.path.abspath(args.out)), 'oof_P.npy'), P.astype(np.float16))
model = {'version': 2, 'seed': args.seed, 'hash': {'bits': 21, 'fn': 'crc32'}, 'generic': json.load(open(os.path.join(args.rows, 'generic.json'))), 'head': exp, 'thresholds': {'prob': args.th}}
with open(args.out, 'w') as fh: json.dump(model, fh, separators=(',', ':'))
print('wrote', args.out, os.path.getsize(args.out), file=sys.stderr)
if args.report:
    with open(args.report, 'w') as fh: json.dump(report, fh, indent=1)
