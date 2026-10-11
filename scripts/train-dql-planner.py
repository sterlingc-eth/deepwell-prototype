#!/usr/bin/env python3
"""Train Donovan's learned planner (api/_lib/dql/learned/model.json).

  python3 scripts/train-dql-planner.py --train /tmp/claude-0/lp/train --dev /tmp/claude-0/lp/dev --out api/_lib/dql/learned/model.json [--seed 7]

Input: the rows written by scripts/gen-dql-training.mjs (one JSON per line; the factory TRAIN split for --train, the DEV split for --dev, which is
used only to tune the regularisation, fit the calibration and choose the thresholds).  Pure sklearn/numpy; reproducible with the fixed seed;
streams the files and de-duplicates identical views so peak memory stays well under 2 GB.  No model API is called anywhere.

Heads (all linear, over word uni/bi/tri-grams of the VIEW of the question - see api/_lib/dql/learned/features.js):
  op, measure, entity, doc, group      the plan heads (labels from the written plan table, learned/planmap.js)
  tok                                   per-word role: filler / slot / op / condition   (leftover words are the hard cases)
  gate                                  P(the answer is still right if the unexplained words are ignored)
Calibration: temperature scaling per multi-class head, Platt scaling for the gate; both fitted on DEV.
"""
import argparse, glob, gzip, json, math, os, random, sys
from collections import Counter, defaultdict
import numpy as np
import scipy.sparse as sp
from scipy.optimize import minimize_scalar
from sklearn.linear_model import LogisticRegression

ap = argparse.ArgumentParser()
ap.add_argument('--train', required=True); ap.add_argument('--dev', required=True); ap.add_argument('--out', required=True)
ap.add_argument('--seed', type=int, default=7); ap.add_argument('--min-count', type=int, default=3)
ap.add_argument('--prune', type=float, default=0.08); ap.add_argument('--report', default=None)
ap.add_argument('--grid-h', default='2'); ap.add_argument('--grid-t', default='16')
args = ap.parse_args()
GRID_H = [float(x) for x in args.grid_h.split(',')]; GRID_T = [float(x) for x in args.grid_t.split(',')]
random.seed(args.seed); np.random.seed(args.seed)
HEADS = ['op', 'measure', 'entity', 'doc', 'group']

def rows_of(d):
    for f in sorted(glob.glob(os.path.join(d, '*.jsonl'))):
        with open(f) as fh:
            for l in fh:
                if l.strip(): yield json.loads(l)

# ------------------------------------------------------------------ feature spec (mirrored in api/_lib/dql/learned/linear.js)
PH_NUM, PH_SLOT = '<n>', '<s>'
def view_of(tk, opwords):
    out = []
    for w, k in tk:
        if k != 'E': out.append(w)
        elif any(c.isdigit() for c in w): out.append(PH_NUM)
        else: out.append(w if w in opwords else PH_SLOT)
    return out

def head_feats(v):
    seq = ['^'] + v + ['$']
    f = set('w:' + t for t in seq)
    for i in range(len(seq) - 1): f.add('b:' + seq[i] + ' ' + seq[i + 1])
    for i in range(len(seq) - 2): f.add('t:' + ' '.join(seq[i:i + 3]))
    return f

def chargrams(w):
    s = ' ' + w + ' '; out = set()
    for n in (3, 4, 5):
        for i in range(len(s) - n + 1): out.add('c:' + s[i:i + n])
    return out

def tok_feats(v, i):
    w = v[i]; p1 = v[i - 1] if i > 0 else '^'; p2 = v[i - 2] if i > 1 else '^'; n1 = v[i + 1] if i + 1 < len(v) else '$'; n2 = v[i + 2] if i + 2 < len(v) else '$'
    f = {'w:' + w, 'p:' + p1, 'n:' + n1, 'p2:' + p2, 'n2:' + n2, 'pw:' + p1 + ' ' + w, 'wn:' + w + ' ' + n1, 'pwn:' + p1 + ' ' + w + ' ' + n1}
    f |= chargrams(w)
    return f

def gate_feats(v, tk):
    f = head_feats(v)
    L = [i for i, (w, k) in enumerate(tk) if k == 'L']
    f.add('nL:%d' % min(len(L), 4))
    for i in L:
        w = v[i]; p1 = v[i - 1] if i > 0 else '^'; n1 = v[i + 1] if i + 1 < len(v) else '$'
        f.add('L:' + w); f.add('Lp:' + p1 + ' ' + w); f.add('Ln:' + w + ' ' + n1)
        f |= set('L' + c for c in chargrams(w))
    return f

# ------------------------------------------------------------------ load
def load(d, with_labels=True):
    rows = []
    for r in rows_of(d):
        if 'tk' not in r: continue
        r['tk'] = [(t['w'], t['k']) for t in r['tk']]
        rows.append(r)
    return rows

print('loading train ...', file=sys.stderr)
train = load(args.train); dev = load(args.dev)
HV_HOLD = ('timeops', 'xind')   # HVAC question groups held out from training (split by group)
hv_hold = [r for r in train if r['tn'] == 'hvac' and r.get('grp') in HV_HOLD]
train = [r for r in train if not (r['tn'] == 'hvac' and r.get('grp') in HV_HOLD)]
print('train rows', len(train), 'dev rows', len(dev), 'hvac held out', len(hv_hold), file=sys.stderr)

# operator words: explained words that recur across organizations (never names)
ten_of = defaultdict(set); cnt = Counter()
for r in train:
    for w, k in r['tk']:
        if k == 'E' and not any(c.isdigit() for c in w): ten_of[w].add(r['tn']); cnt[w] += 1
opwords = sorted(w for w in cnt if len(ten_of[w]) >= 3 and cnt[w] >= 30)
OPW = set(opwords)
print('opwords', len(opwords), file=sys.stderr)

# ------------------------------------------------------------------ generic sparse LR helpers
class Vocab:
    def __init__(self): self.idx = {}
    def build(self, featsets, min_count):
        c = Counter()
        for fs, wt in featsets: 
            for f in fs: c[f] += wt
        keep = sorted(f for f, n in c.items() if n >= min_count)
        self.idx = {f: i for i, f in enumerate(keep)}
    def matrix(self, featsets):
        indptr = [0]; indices = []; data = []
        for fs, _ in featsets:
            ids = sorted(self.idx[f] for f in fs if f in self.idx)
            n = len(ids); v = 1.0 / math.sqrt(n) if n else 0.0
            indices += ids; data += [v] * n; indptr.append(len(indices))
        return sp.csr_matrix((data, indices, indptr), shape=(len(featsets), len(self.idx)), dtype=np.float32)

def fit_temperature(logits, y):
    def nll(T):
        z = logits / T; z = z - z.max(1, keepdims=True); lp = z - np.log(np.exp(z).sum(1, keepdims=True))
        return -lp[np.arange(len(y)), y].mean()
    return float(minimize_scalar(nll, bounds=(0.3, 6.0), method='bounded').x)

def fit_platt(z, y):
    # logistic regression of the label on the raw logit: p = sigmoid(a*z + b)
    lr = LogisticRegression(C=1e4, max_iter=200); lr.fit(z.reshape(-1, 1), y)
    return float(lr.coef_[0][0]), float(lr.intercept_[0])

def export_lr(vocab, coef, intercept, classes, prune):
    feats = {}
    for f, j in vocab.idx.items():
        col = coef[:, j]; ent = []
        for c in range(coef.shape[0]):
            if abs(col[c]) >= prune: ent += [c, round(float(col[c]), 2)]
        if ent: feats[f] = ent
    return {'classes': classes, 'b': [round(float(x), 3) for x in intercept], 'feats': feats}

def score_exported(model, featsets):
    # pure-numpy mirror of the JS scorer (so the exported, pruned model is what gets evaluated)
    K = len(model['classes']); out = np.zeros((len(featsets), K), dtype=np.float64) + np.array(model['b'])
    for r, (fs, _) in enumerate(featsets):
        known = [f for f in fs if f in model['feats']]
        n = len(known)
        if not n: continue
        inv = 1.0 / math.sqrt(n)
        for f in known:
            e = model['feats'][f]
            for j in range(0, len(e), 2): out[r, e[j]] += e[j + 1] * inv
    return out

def softmax(z, T=1.0):
    z = z / T; z = z - z.max(1, keepdims=True); e = np.exp(z); return e / e.sum(1, keepdims=True)

report = {}
model = {'version': 1, 'seed': args.seed, 'opwords': opwords}

# ------------------------------------------------------------------ plan heads
def dedup(rows, key):
    c = Counter(key(r) for r in rows); return c

def head_set(rows):
    X = []; Y = {h: [] for h in HEADS}; W = []
    agg = Counter()
    for r in rows:
        v = tuple(view_of(r['tk'], OPW)); agg[(v,) + tuple(r['h'][h] for h in HEADS)] += 1
    for key, n in agg.items():
        v = list(key[0]); X.append((head_feats(v), n)); W.append(n)
        for i, h in enumerate(HEADS): Y[h].append(key[1 + i])
    return X, Y, np.array(W, dtype=np.float32)

Xtr, Ytr, Wtr = head_set(train); Xdv, Ydv, Wdv = head_set(dev)
print('unique head views train', len(Xtr), 'dev', len(Xdv), file=sys.stderr)
V = Vocab(); V.build(Xtr, args.min_count)
Mtr = V.matrix(Xtr); Mdv = V.matrix(Xdv)
model['heads'] = {}
for h in HEADS:
    classes = sorted(set(Ytr[h])); ci = {c: i for i, c in enumerate(classes)}
    ytr = np.array([ci[c] for c in Ytr[h]]); 
    best = None
    for C in GRID_H:
        lr = LogisticRegression(C=C, max_iter=250, solver='lbfgs'); lr.fit(Mtr, ytr, sample_weight=Wtr)
        ydv = np.array([ci.get(c, -1) for c in Ydv[h]]); ok = ydv >= 0
        acc = float((((lr.predict(Mdv) == ydv) & ok) * Wdv).sum() / Wdv.sum())
        print(h, 'C', C, 'dev acc', round(acc, 4), file=sys.stderr)
        if best is None or acc > best[0]: best = (acc, C, lr)
    acc, C, lr = best
    exp = export_lr(V, lr.coef_ if len(classes) > 2 else np.vstack([-lr.coef_[0] / 2, lr.coef_[0] / 2]), lr.intercept_ if len(classes) > 2 else np.array([-lr.intercept_[0] / 2, lr.intercept_[0] / 2]), classes, args.prune)
    z = score_exported(exp, Xdv); ydv = np.array([ci.get(c, -1) for c in Ydv[h]]); ok = ydv >= 0
    T = fit_temperature(z[ok], ydv[ok]); exp['T'] = round(T, 3)
    pr = softmax(z, T); pred = pr.argmax(1)
    accx = float(((pred == ydv) & ok)[ok].dot(Wdv[ok]) / Wdv[ok].sum()) if ok.any() else 0
    # accuracy above the usable thresholds (coverage / precision)
    conf = pr.max(1); tab = {}
    for th in (0.5, 0.8, 0.9, 0.95, 0.98):
        m = ok & (conf >= th); tab[str(th)] = {'coverage': float(Wdv[m].sum() / Wdv[ok].sum()), 'precision': float(((pred == ydv) & m).astype(np.float32).dot(Wdv) / max(Wdv[m].sum(), 1))}
    model['heads'][h] = exp
    report[h] = {'C': C, 'dev_acc_pruned_calibrated': accx, 'T': exp['T'], 'by_threshold': tab, 'n_feats': len(exp['feats'])}
    print(h, 'exported dev acc', round(accx, 4), 'T', exp['T'], file=sys.stderr)

# label pairs (factory/HVAC label, DQL plan label) that co-occur in CORRECT answers: the plan check treats them as the same thing
comp = defaultdict(Counter)
for r in train:
    if (r.get('base') == 'right' or r.get('force') == 'right') and 'dh' in r:
        for h in HEADS:
            if r['h'][h] != r['dh'][h]: comp[h][(r['h'][h], r['dh'][h])] += 1
model['compat'] = {h: [list(k) for k, n in c.items() if n >= 3] for h, c in comp.items()}
# accuracy on the held-out HVAC groups (never trained on)
if hv_hold:
    Xh = [(head_feats(view_of(r['tk'], OPW)), 1) for r in hv_hold]
    report['hvac_heldout'] = {}
    for h in HEADS:
        z = score_exported(model['heads'][h], Xh); pr = softmax(z, model['heads'][h]['T']); cl = model['heads'][h]['classes']
        pred = [cl[i] for i in pr.argmax(1)]
        report['hvac_heldout'][h] = float(np.mean([p == r['h'][h] for p, r in zip(pred, hv_hold)]))
    print('hvac held-out head accuracy', report['hvac_heldout'], file=sys.stderr)

# ------------------------------------------------------------------ token roles
def tok_role(k, w, label_hint):
    if k == 'E': return 'slot' if w in (PH_NUM, PH_SLOT) else 'op'
    if k == 'F': return 'filler'
    return label_hint  # 'filler' | 'condition' | None

def tok_rows(rows, cap_easy):
    agg = Counter(); rnd = random.Random(args.seed)
    for r in rows:
        v = view_of(r['tk'], OPW)
        L = [i for i, (w, k) in enumerate(r['tk']) if k == 'L']
        hint = None
        if r.get('cat') == 'left':
            fv = r.get('force')
            if fv == 'right': hint = 'filler'
            elif fv in ('wrong',) and len(L) == 1: hint = 'condition'
        for i, (w, k) in enumerate(r['tk']):
            if k != 'L' and rnd.random() > cap_easy: continue
            lab = tok_role(k, v[i], hint)
            if lab is None: continue
            agg[(tuple(sorted(tok_feats(v, i))), lab)] += 1
    return agg

tr_tok = tok_rows(train, 0.08); dv_tok = tok_rows(dev, 0.08)
Xt = [(set(k[0]), n) for k, n in tr_tok.items()]; yt_lab = [k[1] for k in tr_tok]; Wt = np.array(list(tr_tok.values()), dtype=np.float32)
Xd = [(set(k[0]), n) for k, n in dv_tok.items()]; yd_lab = [k[1] for k in dv_tok]; Wd = np.array(list(dv_tok.values()), dtype=np.float32)
VT = Vocab(); VT.build(Xt, args.min_count); Mt = VT.matrix(Xt); Md = VT.matrix(Xd)
classes = ['filler', 'slot', 'op', 'condition']; ci = {c: i for i, c in enumerate(classes)}
yt = np.array([ci[c] for c in yt_lab]); yd = np.array([ci[c] for c in yd_lab])
best = None
for C in GRID_T:
    lr = LogisticRegression(C=C, max_iter=300); lr.fit(Mt, yt, sample_weight=Wt)
    acc = float(((lr.predict(Md) == yd) * Wd).sum() / Wd.sum()); print('tok C', C, acc, file=sys.stderr)
    if best is None or acc > best[0]: best = (acc, C, lr)
acc, C, lr = best
full = np.zeros((len(classes), len(VT.idx)), dtype=np.float32); full[lr.classes_] = lr.coef_
bfull = np.full(len(classes), -8.0); bfull[lr.classes_] = lr.intercept_
exp = export_lr(VT, full, bfull, classes, args.prune)
z = score_exported(exp, Xd); T = fit_temperature(z, yd); exp['T'] = round(T, 3); pr = softmax(z, T); pred = pr.argmax(1)
hard = np.array([lab in ('condition',) or False for lab in yd_lab])
model['tok'] = exp
report['tok'] = {'C': C, 'dev_acc': float(((pred == yd) * Wd).sum() / Wd.sum()), 'T': exp['T'],
                 'per_class_recall': {c: float(((pred == i) & (yd == i)).astype(np.float32).dot(Wd) / max(Wd[yd == i].sum(), 1)) for c, i in ci.items()}}
print('tok', report['tok'], file=sys.stderr)

# ------------------------------------------------------------------ gate: are the unexplained words ignorable?
def gate_rows(rows):
    agg = Counter()  # key: (features, label 1=right / 0=wrong-ish / 2=abstain(neutral))
    for r in rows:
        if r.get('cat') != 'left' or r.get('force') not in ('right', 'wrong', 'declined', 'loose', 'unclear'): continue
        v = view_of(r['tk'], OPW)
        y = 1 if r['force'] == 'right' else 2 if r['force'] == 'abstain' else 0
        agg[(tuple(sorted(gate_feats(v, r['tk']))), y)] += 1
    return agg
gtr = gate_rows(train); gdv = gate_rows(dev)
Xg = [(set(k[0]), n) for k, n in gtr.items()]; yg = np.array([1 if k[1] == 1 else 0 for k in gtr]); Wg = np.array(list(gtr.values()), dtype=np.float32)
Xgd = [(set(k[0]), n) for k, n in gdv.items()]; neutral = np.array([1 if k[1] == 2 else 0 for k in gdv]); ygd = np.array([1 if k[1] == 1 else 0 for k in gdv]); Wgd = np.array(list(gdv.values()), dtype=np.float32)
print('gate rows train', int(Wg.sum()), 'dev', int(Wgd.sum()), 'positive rate', float(Wg[yg == 1].sum() / Wg.sum()), file=sys.stderr)
VG = Vocab(); VG.build(Xg, args.min_count); Mg = VG.matrix(Xg); Mgd = VG.matrix(Xgd)
best = None
for C in GRID_T:
    lr = LogisticRegression(C=C, max_iter=300); lr.fit(Mg, yg, sample_weight=Wg)
    p = lr.predict_proba(Mgd)[:, 1]
    # average precision-style score: precision at 90% of the achievable coverage is what matters; use log loss on dev
    ll = float(-(Wgd * (ygd * np.log(np.clip(p, 1e-6, 1)) + (1 - ygd) * np.log(np.clip(1 - p, 1e-6, 1)))).sum() / Wgd.sum())
    print('gate C', C, 'dev logloss', round(ll, 4), file=sys.stderr)
    if best is None or ll < best[0]: best = (ll, C, lr)
ll, C, lr = best
exp = export_lr(VG, np.vstack([-lr.coef_ / 2, lr.coef_ / 2]), np.array([-lr.intercept_[0] / 2, lr.intercept_[0] / 2]), ['ignore_unsafe', 'ignore_ok'], args.prune)
z = score_exported(exp, Xgd); raw = z[:, 1] - z[:, 0]
a, b = fit_platt(raw, ygd); exp['platt'] = [round(a, 3), round(b, 3)]
p = 1 / (1 + np.exp(-(a * raw + b)))
tab = {}
for th in (0.5, 0.8, 0.9, 0.95, 0.97, 0.98, 0.99, 0.995):
    m = p >= th; tab[str(th)] = {'coverage_of_good': float(Wgd[m & (ygd == 1)].sum() / max(Wgd[ygd == 1].sum(), 1)), 'precision': float(Wgd[m & (ygd == 1)].sum() / max(Wgd[m].sum(), 1)), 'n': float(Wgd[m].sum())}
model['gate'] = exp
gth = 0.999
# a threshold is acceptable when at most 1.5% of the questions it opens are wrong/unclear on DEV (abstains are harmless: they still go to the model)
for th in (0.9, 0.95, 0.97, 0.98, 0.99, 0.995, 0.999):
    m = p >= th
    if m.any() and Wgd[m].sum() >= 20 and Wgd[m & (ygd == 0) & (neutral == 0)].sum() / Wgd[m].sum() <= 0.015: gth = th; break
model['thresholds'] = {'gate': gth, 'tok': 0.97, 'head': 0.9}
report['gate'] = {'C': C, 'dev_logloss': ll, 'platt': exp['platt'], 'pos_rate_dev': float(Wgd[ygd == 1].sum() / Wgd.sum()), 'by_threshold': tab}
print('gate', json.dumps(tab), file=sys.stderr)

with open(args.out, 'w') as fh: json.dump(model, fh, separators=(',', ':'))
print('wrote', args.out, os.path.getsize(args.out), 'bytes', file=sys.stderr)
if args.report:
    with open(args.report, 'w') as fh: json.dump(report, fh, indent=1)
