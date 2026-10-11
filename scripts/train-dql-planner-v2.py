#!/usr/bin/env python3
"""Train Donovan's learned planner, round 2 (api/_lib/dql/learned/model.json, version 2). Fixed seed; no model API anywhere.

Reproduce (the factory lives outside the repo: /home/claude/work/factory):
  1. node /home/claude/work/factory/questions/generate.mjs --bank 2 --per 20000        # round-2 wording bank -> questions/out2 (templates2/: 921 hand-written
                                                                                       #  kernels + persona wrappers + operator-synonym frames from the taxonomy)
  2. for sp in train dev: node scripts/gen-dql-training.mjs --split $sp --qdir <factory>/questions/out2 --out /tmp/claude-0/lp2/$sp --tenants <the ten>
     (and the same without --qdir for the round-1 bank into /tmp/claude-0/lp/$sp; the HVAC dev questions are read by the first run into <out>/hvac.train.jsonl)
  3. python3 scripts/train-dql-planner-v2.py --train /tmp/claude-0/lp/train,/tmp/claude-0/lp2/train --dev /tmp/claude-0/lp/dev,/tmp/claude-0/lp2/dev \
        --out api/_lib/dql/learned/model.json --report /tmp/claude-0/lp2/report.json --parity /tmp/claude-0/lp2/parity.json --prune 0.1 --topk 5 --tg-prune 0.25 --tg-min 8
     (about 10-25 minutes, peak memory about 3 GB: run it when the machine is quiet; --only-tg --base-model <model.json> retrains just tok + verify)

Rows come from scripts/gen-dql-training.mjs (the factory TRAIN splits of the round-1 and round-2 wording banks, plus the HVAC dev questions).
Round 2 (see api/_lib/dql/learned/features.js):
  * heads read hashed features (crc32 buckets) of: word 1-3-grams of the slot-masked view, char 2-5-grams of each word, slot-masked skip-grams,
    and 1-3-grams / skip-grams over WORD CLUSTERS (PPMI + SVD word vectors computed from this corpus, k-means; exported as a small word->cluster table);
    a head keeps its N most useful features and is fine-tuned on them (model JSON under 4 MB, inference about 0.35 ms);
  * the HVAC dev groups money / customers / assets / docs are trained on (real human wording, weighted); a fixed slice of them is kept as HVAC-dev for
    calibration; timeops and xind are NEVER trained on (held-out report);
  * words the wording bank added around a question (persona, politeness, "my accountant is asking ...") are filler by construction: they label the token head;
  * tok (per-word role) and verify (the gate: is the answer right once the unexplained words are ignored, given the plan the families built) are retrained
    on the larger corpus; verify replaces the round-1 gate and sees the plan's own reading.
"""
import argparse, gc, glob, json, math, os, random, sys, zlib, hashlib
from collections import Counter, defaultdict
import numpy as np
import scipy.sparse as sp
from scipy.optimize import minimize_scalar
from scipy.sparse.linalg import svds
from sklearn.cluster import MiniBatchKMeans
from sklearn.linear_model import LogisticRegression

ap = argparse.ArgumentParser()
ap.add_argument('--train', required=True); ap.add_argument('--dev', required=True); ap.add_argument('--out', required=True)
ap.add_argument('--seed', type=int, default=7); ap.add_argument('--min-count', type=int, default=4)
ap.add_argument('--prune', type=float, default=0.12); ap.add_argument('--topk', type=int, default=6)
ap.add_argument('--report', default=None); ap.add_argument('--hvac-w', type=float, default=4.0); ap.add_argument('--hvac-dev-frac', type=float, default=0.2)
ap.add_argument('--grid-h', default='1.5'); ap.add_argument('--grid-t', default='16'); ap.add_argument('--k1', type=int, default=96); ap.add_argument('--k2', type=int, default=384)
ap.add_argument('--parity', default=None)
ap.add_argument('--epochs', type=int, default=12); ap.add_argument('--lr', type=float, default=0.06); ap.add_argument('--l2', type=float, default=3e-6)
ap.add_argument('--nfeat', default='op=30000,measure=12000,entity=5000,doc=5000,group=7000'); ap.add_argument('--ft-epochs', type=int, default=4); ap.add_argument('--tg-prune', type=float, default=0.2); ap.add_argument('--tg-min', type=int, default=8)
ap.add_argument('--only-tg', action='store_true'); ap.add_argument('--base-model', default=None); ap.add_argument('--gate-th', type=float, default=None)
ap.add_argument('--vc', type=float, default=16.0); ap.add_argument('--vfeat', type=int, default=40000); ap.add_argument('--verify-th', type=float, default=None); ap.add_argument('--tok-th', type=float, default=0.9)
ap.add_argument('--svd-dim', type=int, default=48); ap.add_argument('--max-iter', type=int, default=150)
args = ap.parse_args()
GRID_H = [float(x) for x in args.grid_h.split(',')]; GRID_T = [float(x) for x in args.grid_t.split(',')]
random.seed(args.seed); np.random.seed(args.seed)
HEADS = ['op', 'measure', 'entity', 'doc', 'group']
NB = 1 << 22
HV_HOLD = ('timeops', 'xind')

def rows_of(d):
    for f in sorted(glob.glob(os.path.join(d, '*.jsonl'))):
        with open(f) as fh:
            for l in fh:
                if l.strip(): yield json.loads(l)

PH_NUM, PH_SLOT = '<n>', '<s>'
def view_of(tk, opwords):
    out = []
    for w, k in tk:
        if k != 'E': out.append(w)
        elif any(c.isdigit() for c in w): out.append(PH_NUM)
        else: out.append(w if w in opwords else PH_SLOT)
    return out

# ---- round-1 feature sets (still used by tok; the verify gate extends head_feats)
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
CLX = None  # coarse word-cluster table, set once the clusters exist (tok / gate use it: unseen words that cluster with known fillers read as fillers)
def kc(w): return cl_of(CLX, 0, w) if CLX else '?'
def tok_feats(v, i):
    w = v[i]; p1 = v[i - 1] if i > 0 else '^'; p2 = v[i - 2] if i > 1 else '^'; n1 = v[i + 1] if i + 1 < len(v) else '$'; n2 = v[i + 2] if i + 2 < len(v) else '$'
    f = {'w:' + w, 'p:' + p1, 'n:' + n1, 'p2:' + p2, 'n2:' + n2, 'pw:' + p1 + ' ' + w, 'wn:' + w + ' ' + n1, 'pwn:' + p1 + ' ' + w + ' ' + n1}
    f |= chargrams(w)
    if CLX: f.add('kw:' + kc(w)); f.add('kp:' + kc(p1) + ' ' + kc(w)); f.add('kn:' + kc(w) + ' ' + kc(n1))
    return f
# ---- round-2 head features (mirrored by headFeats2 in api/_lib/dql/learned/features.js)
def cl_of(CL, level, w):
    if w in ('^', '$', PH_SLOT, PH_NUM): return w
    c = CL[level].get(w)
    return ('a%d' if level == 0 else 'b%d') % c if c is not None else '?'
def head_feats2(v, CL):
    seq = ['^'] + v + ['$']
    f = set('w:' + t for t in seq)
    for i in range(len(seq) - 1): f.add('b:' + seq[i] + ' ' + seq[i + 1])
    for i in range(len(seq) - 2): f.add('t:' + ' '.join(seq[i:i + 3]))
    for i in range(len(seq) - 2): f.add('sk:' + seq[i] + '_' + seq[i + 2])
    for i in range(len(seq) - 3): f.add('sk3:' + seq[i] + '_' + seq[i + 3])
    for t in v:
        if len(t) >= 3 and t[0] != '<':
            s = ' ' + t + ' '
            for n in (2, 3, 4, 5):
                for i in range(len(s) - n + 1): f.add('hc:' + s[i:i + n])
    for lv, tag in ((0, 'ka'), (1, 'kb')):
        c = [cl_of(CL, lv, t) for t in seq]
        for t in c: f.add(tag + '1:' + t)
        for i in range(len(c) - 1): f.add(tag + '2:' + c[i] + ' ' + c[i + 1])
        if lv == 0:
            for i in range(len(c) - 2): f.add('ka3:' + ' '.join(c[i:i + 3]))
            for i in range(len(c) - 2): f.add('kas:' + c[i] + '_' + c[i + 2])
    f.add('len:%d' % min(len(v), 14))
    return f
def hid(s): return zlib.crc32(s.encode('utf-8')) & (NB - 1)

# ------------------------------------------------------------------ load
TKC = {}
def load(d, src):
    rows = []
    for r in rows_of(d):
        if 'tk' not in r: continue
        r = {'id': r['id'], 'tn': r['tn'], 'tk': [TKC.setdefault((t['w'], t['k']), (sys.intern(t['w']), t['k'])) for t in r['tk']], 'h': r['h'], 'cat': r.get('cat'), 'force': r.get('force'), 'base': r.get('base'), 'dh': r.get('dh'), 'grp': r.get('grp'), 'fw': frozenset(r['fw']) if r.get('fw') else None, 'src': src}
        if r['dh'] is None: del r['dh']
        rows.append(r)
    return rows
print('loading ...', file=sys.stderr)
train = []
for i, d in enumerate(args.train.split(',')): train += load(d, 'train%d' % (i + 1))
dev = []
for i, d in enumerate(args.dev.split(',')): dev += load(d, 'dev%d' % (i + 1))
hv_hold = [r for r in train if r['tn'] == 'hvac' and r.get('grp') in HV_HOLD]
hv_all = [r for r in train if r['tn'] == 'hvac' and r.get('grp') not in HV_HOLD]
hv_dev = [r for r in hv_all if (int(hashlib.md5(r['id'].encode()).hexdigest(), 16) % 1000) < args.hvac_dev_frac * 1000]
hv_dev_ids = set(r['id'] for r in hv_dev)
train = [r for r in train if r['tn'] != 'hvac' or (r.get('grp') not in HV_HOLD and r['id'] not in hv_dev_ids)]
for r in train:
    r['w'] = args.hvac_w if r['tn'] == 'hvac' else 1.0
print('train rows', len(train), 'dev rows', len(dev), 'hvac dev', len(hv_dev), 'hvac held out', len(hv_hold), file=sys.stderr)

ten_of = defaultdict(set); cnt = Counter()
for r in train:
    for w, k in r['tk']:
        if k == 'E' and not any(c.isdigit() for c in w): ten_of[w].add(r['tn']); cnt[w] += 1
opwords = sorted(w for w in cnt if len(ten_of[w]) >= 3 and cnt[w] >= 30)
OPW = set(opwords)
print('opwords', len(opwords), file=sys.stderr)

def head_set(rows):
    wt = Counter()
    for r in rows:
        v = tuple(view_of(r['tk'], OPW)); key = (v,) + tuple(r['h'][h] for h in HEADS)
        wt[key] += r.get('w', 1.0)
    return wt
WT_TRAIN = head_set(train)

# ------------------------------------------------------------------ word clusters (PPMI + SVD over the training views)
def build_clusters():
    uv = Counter({k[0]: n for k, n in WT_TRAIN.items()})
    wc = Counter()
    for v, n in uv.items():
        for t in set(v): wc[t] += 1
    vocab = sorted(w for w, n in wc.items() if n >= 3 and w not in (PH_SLOT, PH_NUM))
    ix = {w: i for i, w in enumerate(vocab)}; V = len(vocab)
    M = sp.csr_matrix((V, V), dtype=np.float64); ra = []; ca = []; va = []
    def flush():
        nonlocal M, ra, ca, va
        if ra: M = M + sp.coo_matrix((np.array(va), (np.array(ra), np.array(ca))), shape=(V, V)).tocsr(); ra = []; ca = []; va = []
    for v, n in uv.items():
        ids = [ix.get(t, -1) for t in v]
        for i, a_ in enumerate(ids):
            if a_ < 0: continue
            for j in range(max(0, i - 3), min(len(ids), i + 4)):
                b_ = ids[j]
                if j == i or b_ < 0: continue
                ra.append(a_); ca.append(b_); va.append(1.0 / abs(j - i))
        if len(ra) > 1500000: flush()
    flush()
    tot = M.sum(); rs = np.asarray(M.sum(1)).ravel(); cs = np.asarray(M.sum(0)).ravel() ** 0.75; cs = cs / cs.sum()
    M = M.tocoo(); pmi = np.log(np.maximum(M.data / tot, 1e-12) / (np.maximum(rs[M.row] / tot, 1e-12) * np.maximum(cs[M.col], 1e-12)))
    pp = sp.csr_matrix((np.maximum(pmi, 0), (M.row, M.col)), shape=(V, V))
    k = min(args.svd_dim, V - 2)
    U, S, _ = svds(pp, k=k, random_state=args.seed)
    E = U * np.sqrt(S); E = E / np.maximum(np.linalg.norm(E, axis=1, keepdims=True), 1e-9)
    CL = []
    for K in (args.k1, args.k2):
        km = MiniBatchKMeans(n_clusters=K, random_state=args.seed, n_init=3, batch_size=2048).fit(E)
        CL.append({w: int(km.labels_[i]) for i, w in enumerate(vocab)})
    print('clusters: vocab', V, 'k', args.k1, args.k2, file=sys.stderr)
    return CL, E, vocab
CL, EMB, VOCAB = build_clusters()
CLX = CL
def neighbours(w, n=6):
    i = VOCAB.index(w) if w in VOCAB else None
    if i is None: return []
    s = EMB @ EMB[i]; o = np.argsort(-s)[1:n + 1]; return [VOCAB[j] for j in o]
for w in ('average', 'invoices', 'wondering', 'owe', 'many', 'latest', 'tonnage'): print('  near', w, neighbours(w), file=sys.stderr)

# ------------------------------------------------------------------ token roles (round-1 features)
class Vocab:
    def __init__(self): self.idx = {}
    def build(self, featsets, min_count):
        c = Counter()
        for fs, wt in featsets:
            for f in fs: c[f] += wt
        keepf = sorted(f for f, n in c.items() if n >= min_count); self.idx = {f: i for i, f in enumerate(keepf)}
    def matrix(self, featsets):
        indptr = [0]; indices = []; data = []
        for fs, _ in featsets:
            ids = sorted(self.idx[f] for f in fs if f in self.idx); n = len(ids); v = 1.0 / math.sqrt(n) if n else 0.0
            indices += ids; data += [v] * n; indptr.append(len(indices))
        return sp.csr_matrix((data, indices, indptr), shape=(len(featsets), len(self.idx)), dtype=np.float32)
def export_lr(vocab, coef, intercept, classes, prune):
    feats = {}
    for f, j in vocab.idx.items():
        col = coef[:, j]; ent = []
        for c in range(coef.shape[0]):
            if abs(col[c]) >= prune: ent += [c, round(float(col[c]), 2)]
        if ent: feats[f] = ent
    return {'classes': classes, 'b': [round(float(x), 3) for x in intercept], 'feats': feats}
def score_exported(m, featsets):
    K = len(m['classes']); out = np.zeros((len(featsets), K)) + np.array(m['b'])
    for r, (fs, _) in enumerate(featsets):
        known = [f for f in fs if f in m['feats']]; n = len(known)
        if not n: continue
        inv = 1.0 / math.sqrt(n)
        for f in known:
            e = m['feats'][f]
            for j in range(0, len(e), 2): out[r, e[j]] += e[j + 1] * inv
    return out
def tok_role(k, w, hint):
    if k == 'E': return 'slot' if w in (PH_NUM, PH_SLOT) else 'op'
    if k == 'F': return 'filler'
    return hint
def tok_rows(rows, cap_easy):
    agg = Counter(); rnd = random.Random(args.seed)
    for r in rows:
        v = view_of(r['tk'], OPW); L = [i for i, (w, k) in enumerate(r['tk']) if k == 'L']; hint = None
        if r.get('cat') == 'left':
            fv = r.get('force')
            if fv == 'right': hint = 'filler'
            elif fv in ('wrong',) and len(L) == 1: hint = 'condition'
        fw = r.get('fw')
        for i, (w, k) in enumerate(r['tk']):
            if k != 'L' and rnd.random() > cap_easy: continue
            lab = tok_role(k, v[i], hint)
            if k == 'L' and fw and ''.join(c for c in w if c.isalnum()) in fw: lab = 'filler'  # words the wording bank added around the core are filler by construction
            if lab is None: continue
            agg[(tuple(sorted(tok_feats(v, i))), lab)] += 1
    return agg

def verify_feats(v, tk, dh):
    """The verify gate (round 2): after the families built a plan with the unexplained words ignored, is that answer right? Features: the view's n-grams,
    each unexplained word (own, in context, its cluster, its char-grams), and the plan's own reading (op / measure / entity / doc / group) alone and
    conjoined with those words and with the view's bigrams."""
    f = head_feats(v)
    L = [i for i, (w, k) in enumerate(tk) if k == 'L']
    f.add('nL:%d' % min(len(L), 4))
    for i in L:
        w = v[i]; p1 = v[i - 1] if i > 0 else '^'; n1 = v[i + 1] if i + 1 < len(v) else '$'
        f.add('L:' + w); f.add('Lp:' + p1 + ' ' + w); f.add('Ln:' + w + ' ' + n1)
        f.add('Lk:' + kc(w)); f.add('Lkp:' + kc(p1) + ' ' + kc(w)); f.add('Lkn:' + kc(w) + ' ' + kc(n1))
        f |= set('L' + c for c in chargrams(w))
        for h in ('op', 'entity', 'doc'): f.add('PL:%s:%s:%s' % (h, dh.get(h), kc(w)))
    for h in ('op', 'measure', 'entity', 'doc', 'group'): f.add('P:%s:%s' % (h, dh.get(h)))
    f.add('P:' + '|'.join(str(dh.get(h)) for h in ('op', 'entity', 'doc')))
    for i in range(len(v) - 1): f.add('PB:%s:%s %s' % (dh.get('op'), v[i], v[i + 1]))
    return f
def vrows(rows):
    out = []
    for r in rows:
        if r.get('cat') != 'left' or r.get('force') not in ('right', 'wrong', 'declined', 'loose', 'unclear') or not r.get('dh'): continue
        v = view_of(r['tk'], OPW)
        out.append((np.unique(np.fromiter((hid(x) for x in verify_feats(v, r['tk'], r['dh'])), dtype=np.uint32)), 1 if r['force'] == 'right' else 0, r.get('src')))
    return out
comp = defaultdict(Counter)
for r in train:
    if (r.get('base') == 'right' or r.get('force') == 'right') and 'dh' in r:
        for h in HEADS:
            if r['h'][h] != r['dh'][h]: comp[h][(r['h'][h], r['dh'][h])] += 1
COMPAT = {h: [list(k) for k, n in c.items() if n >= 3] for h, c in comp.items()}

trn = [r for r in train if r['tn'] != 'hvac']
tr_tok = tok_rows(trn, 0.06); vtr = vrows(trn)
del train, trn
import gc; gc.collect()

def softmax(z, T=1.0):
    z = z / T; z = z - z.max(1, keepdims=True); e = np.exp(z); return e / e.sum(1, keepdims=True)
def fit_temperature(logits, y, w):
    def nll(T):
        z = logits / T; z = z - z.max(1, keepdims=True); lp = z - np.log(np.exp(z).sum(1, keepdims=True))
        return -(lp[np.arange(len(y)), y] * w).sum() / w.sum()
    return float(minimize_scalar(nll, bounds=(0.3, 8.0), method='bounded').x)
def fit_platt(z, y, w):
    lr = LogisticRegression(C=1e4, max_iter=200); lr.fit(z.reshape(-1, 1), y, sample_weight=w)
    return float(lr.coef_[0][0]), float(lr.intercept_[0])


if not args.only_tg:
    # ------------------------------------------------------------------ hashed head matrices
    def hashed(v):
        return np.unique(np.fromiter((hid(s) for s in head_feats2(list(v), CL)), dtype=np.uint32))
    def build(wt):
        keys = list(wt.keys()); ids = [hashed(k[0]) for k in keys]
        return keys, ids, np.array([wt[k] for k in keys], dtype=np.float32)
    print('hashing train ...', file=sys.stderr)
    ktr, idtr, Wtr = build(WT_TRAIN)
    df = np.zeros(NB, dtype=np.float64)
    for ids, w in zip(idtr, Wtr): df[ids] += w
    keep = np.nonzero(df >= args.min_count)[0]; colmap = -np.ones(NB, dtype=np.int64); colmap[keep] = np.arange(len(keep))
    print('unique head views train', len(ktr), 'features kept', len(keep), file=sys.stderr)
    def matrix(idl):
        indptr = [0]; ind = []; dat = []
        for ids in idl:
            c = colmap[ids]; c = c[c >= 0]; n = len(ids); ind.append(c.astype(np.int32)); dat.append(np.full(len(c), 1.0 / math.sqrt(n), dtype=np.float32)); indptr.append(indptr[-1] + len(c))
        return sp.csr_matrix((np.concatenate(dat), np.concatenate(ind), np.array(indptr)), shape=(len(idl), len(keep)), dtype=np.float32)
    Mtr = matrix(idtr)
    print('nnz per row', Mtr.nnz / Mtr.shape[0], file=sys.stderr)
    YTR = {h: [k[HEADS.index(h) + 1] for k in ktr] for h in HEADS}
    PAR = [{'v': list(k[0]), 'ids': sorted(int(i) for i in ids)} for k, ids in random.Random(args.seed).sample(list(zip(ktr, idtr)), 120)]
    DFK = df[keep].copy(); KEEP = keep.copy()
    del idtr, ktr, WT_TRAIN, df; gc.collect()
    NFEAT = {kv.split('=')[0]: int(kv.split('=')[1]) for kv in args.nfeat.split(',')}
    def evalset(rows):
        wt = head_set([dict(r, w=1.0) for r in rows]); k, ids, w = build(wt); return k, ids, w, matrix(ids)
    EV = {}
    for name, rows in (('dev1', [r for r in dev if r['src'] == 'dev1']), ('dev2', [r for r in dev if r['src'] == 'dev2']), ('hvac_dev', hv_dev), ('hvac_heldout', hv_hold)):
        if rows: EV[name] = evalset(rows); print('eval set', name, len(rows), 'unique', len(EV[name][0]), file=sys.stderr)

    def export_lr2(coef, intercept, classes, kb):
        # coef: K x ncols (compact); features keyed by hash bucket; top-k classes per feature by |w|
        feats = {}
        absmax = np.abs(coef).max(0)
        for j in np.nonzero(absmax >= args.prune)[0]:
            col = coef[:, j]; order = np.argsort(-np.abs(col))[:args.topk]; ent = []
            for c in order:
                if abs(col[c]) >= args.prune: ent += [int(c), round(float(col[c]), 2)]
            if ent: feats[str(int(kb[j]))] = ent
        return {'classes': classes, 'b': [round(float(x), 3) for x in intercept], 'feats': feats}
    def score2(model, ids_list):
        K = len(model['classes']); out = np.zeros((len(ids_list), K)) + np.array(model['b'])
        F = model['feats']
        for r, ids in enumerate(ids_list):
            inv = 1.0 / math.sqrt(len(ids))
            for i in ids:
                e = F.get(str(int(i)))
                if e:
                    for j in range(0, len(e), 2): out[r, e[j]] += e[j + 1] * inv
        return out
    def fit_softmax(X, y, w, K, evalf, epochs, bs=2048, lr=0.06, l2=3e-6, seed=7, init=None, patience=2):
        """Multinomial logistic regression by lazy-Adam minibatches over the sparse hashed features (memory-light: the weight matrix is ncols x K floats).
        evalf(W, b) -> score (higher is better); the best epoch is kept (early stopping on the DEV sets, which are never fitted)."""
        rnd = np.random.RandomState(seed); n, d = X.shape
        W = np.zeros((d, K), dtype=np.float32) if init is None else init[0].copy(); b = np.zeros(K, dtype=np.float32) if init is None else init[1].copy()
        m = np.zeros_like(W); v = np.zeros_like(W); mb = np.zeros_like(b); vb = np.zeros_like(b)
        t = 0; best = (-1, None, None, 0); b1, b2, eps = 0.9, 0.999, 1e-8
        for ep in range(epochs):
            perm = rnd.permutation(n)
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
            sc = evalf(W, b); print('   epoch', ep, 'dev score', round(sc, 4), file=sys.stderr)
            if sc > best[0]: best = (sc, W.copy(), b.copy(), ep)
            elif ep - best[3] >= patience: break
        return best

    report = {}
    model = {'version': 2, 'seed': args.seed, 'opwords': opwords, 'hash': {'bits': 22, 'fn': 'crc32'}, 'clusters': [CL[0], CL[1]]}
    model['heads'] = {}
    model['compat'] = COMPAT
    for h in HEADS:
        hi = HEADS.index(h) + 1
        classes = sorted(set(YTR[h])); ci = {c: i for i, c in enumerate(classes)}
        ytr = np.array([ci[c] for c in YTR[h]])
        K = len(classes)
        def evalf(W, bb, hi=hi, ci=ci):
            acc = 0.0; tw = 0
            for nm in ('dev1', 'dev2', 'hvac_dev'):
                if nm not in EV: continue
                k, ids, w, M = EV[nm]; y = np.array([ci.get(kk[hi], -1) for kk in k]); ok = y >= 0
                pr = (M @ W + bb).argmax(1); acc += float((((pr == y) & ok) * w).sum() / w.sum()); tw += 1
            return acc / tw
        sc, Wb, bb, bep = fit_softmax(Mtr, ytr, Wtr, K, evalf, args.epochs, lr=args.lr, l2=args.l2, seed=args.seed)
        print(h, 'best epoch', bep, 'mean dev acc', round(sc, 4), file=sys.stderr)
        C = {'epochs': bep + 1, 'lr': args.lr, 'l2': args.l2, 'nfeat': NFEAT.get(h)}
        # keep the N most useful features of this head (|weight| x sqrt(document frequency)) and fine-tune on them (a small model, not a pruned big one)
        nsel = NFEAT.get(h)
        if nsel and nsel < Wb.shape[0]:
            imp = np.abs(Wb).max(1) * np.sqrt(DFK); sel = np.sort(np.argsort(-imp)[:nsel])
            remap = -np.ones(Wb.shape[0], dtype=np.int64); remap[sel] = np.arange(len(sel))
            nz = remap[Mtr.indices]; msk = nz >= 0
            rowid = np.repeat(np.arange(Mtr.shape[0]), np.diff(Mtr.indptr))[msk]
            indptr2 = np.concatenate([[0], np.cumsum(np.bincount(rowid, minlength=Mtr.shape[0]))])
            Msub = sp.csr_matrix((Mtr.data[msk], nz[msk].astype(np.int32), indptr2), shape=(Mtr.shape[0], len(sel)), dtype=np.float32)
            del rowid, nz, msk
            EVs = {}
            for nm, (k, ids, w, M) in EV.items():
                nz = remap[M.indices]; mk = nz >= 0; rid = np.repeat(np.arange(M.shape[0]), np.diff(M.indptr))[mk]
                ip = np.concatenate([[0], np.cumsum(np.bincount(rid, minlength=M.shape[0]))]); EVs[nm] = sp.csr_matrix((M.data[mk], nz[mk].astype(np.int32), ip), shape=(M.shape[0], len(sel)), dtype=np.float32)
            def evalf2(W, bb, hi=hi, ci=ci):
                acc = 0.0; tw = 0
                for nm in ('dev1', 'dev2', 'hvac_dev'):
                    if nm not in EV: continue
                    k, ids, w, M = EV[nm]; y = np.array([ci.get(kk[hi], -1) for kk in k]); ok = y >= 0
                    pr = (EVs[nm] @ W + bb).argmax(1); acc += float((((pr == y) & ok) * w).sum() / w.sum()); tw += 1
                return acc / tw
            sc2, Wb2, bb2, bep2 = fit_softmax(Msub, ytr, Wtr, K, evalf2, args.ft_epochs, lr=args.lr * 0.5, l2=args.l2, seed=args.seed + 1, init=(Wb[sel], bb), patience=3)
            print(h, 'fine-tuned on', len(sel), 'features: mean dev acc', round(sc2, 4), file=sys.stderr)
            Wb, bb = Wb2, bb2; colsel = KEEP[sel]; del Msub, EVs
        else:
            colsel = KEEP
        coef = Wb.T; icp = bb
        exp = export_lr2(coef, icp, classes, colsel)
        # temperature: fit on pooled dev (dev1, dev2) and hvac_dev, each source weighted equally
        Z = []; Y = []; Wt = []
        for nm in ('dev1', 'dev2', 'hvac_dev'):
            if nm not in EV: continue
            k, ids, w, M = EV[nm]; y = np.array([ci.get(kk[hi], -1) for kk in k]); ok = y >= 0
            z = score2(exp, ids)[ok]; Z.append(z); Y.append(y[ok]); Wt.append(w[ok] / w[ok].sum())
        T = fit_temperature(np.vstack(Z), np.concatenate(Y), np.concatenate(Wt)); exp['T'] = round(T, 3)
        model['heads'][h] = exp
        rep = {'C': C, 'T': exp['T'], 'n_feats': len(exp['feats'])}
        for nm, (k, ids, w, M) in EV.items():
            y = np.array([ci.get(kk[hi], -1) for kk in k]); ok = y >= 0
            pr = softmax(score2(exp, ids), exp['T']); pred = pr.argmax(1); conf = pr.max(1)
            a = float((((pred == y) & ok) * w).sum() / w.sum()); rep[nm] = a
            if h == 'op' and nm.startswith('hvac'):
                am = np.array([kk[hi] not in ('clarify', 'other') for kk in k]); rep[nm + '_answerable'] = float((((pred == y) & ok & am) * w).sum() / w[am].sum())
            if nm != 'hvac_heldout':
                rep[nm + '_by_th'] = {str(th): {'coverage': float(w[conf >= th].sum() / w.sum()), 'precision': float((((pred == y) & ok & (conf >= th)) * w).sum() / max(w[conf >= th].sum(), 1e-9))} for th in (0.5, 0.8, 0.9, 0.95, 0.98, 0.99)}
            else:
                rep[nm + '_by_th'] = {str(th): {'coverage': float(w[conf >= th].sum() / w.sum()), 'precision': float((((pred == y) & ok & (conf >= th)) * w).sum() / max(w[conf >= th].sum(), 1e-9))} for th in (0.5, 0.8, 0.9, 0.95, 0.98, 0.99)}
        report[h] = rep
        print(h, 'T', exp['T'], 'feats', len(exp['feats']), {nm: round(rep[nm], 4) for nm in EV}, file=sys.stderr)

else:
    _b = json.load(open(args.base_model)); report = {}
    model = {'version': 2, 'seed': args.seed, 'opwords': _b['opwords'], 'hash': _b['hash'], 'clusters': _b['clusters'], 'heads': _b['heads'], 'compat': _b['compat']}
    report['note'] = 'heads copied from ' + args.base_model

dv_tok = tok_rows(dev, 0.08)
Xt = [(set(k[0]), n) for k, n in tr_tok.items()]; yt_lab = [k[1] for k in tr_tok]; Wt_ = np.array(list(tr_tok.values()), dtype=np.float32)
Xd = [(set(k[0]), n) for k, n in dv_tok.items()]; yd_lab = [k[1] for k in dv_tok]; Wd = np.array(list(dv_tok.values()), dtype=np.float32)
VT = Vocab(); VT.build(Xt, args.tg_min); Mt = VT.matrix(Xt); Md = VT.matrix(Xd)
tcls = ['filler', 'slot', 'op', 'condition']; tci = {c: i for i, c in enumerate(tcls)}
yt = np.array([tci[c] for c in yt_lab]); yd = np.array([tci[c] for c in yd_lab])
best = None
for C in GRID_T:
    lr = LogisticRegression(C=C, max_iter=300); lr.fit(Mt, yt, sample_weight=Wt_)
    acc = float(((lr.predict(Md) == yd) * Wd).sum() / Wd.sum()); print('tok C', C, acc, file=sys.stderr)
    if best is None or acc > best[0]: best = (acc, C, lr)
acc, C, lr = best
full = np.zeros((len(tcls), len(VT.idx)), dtype=np.float32); full[lr.classes_] = lr.coef_
bfull = np.full(len(tcls), -8.0); bfull[lr.classes_] = lr.intercept_
exp = export_lr(VT, full, bfull, tcls, args.tg_prune)
z = score_exported(exp, Xd); T = fit_temperature(z, yd, Wd); exp['T'] = round(T, 3); pr = softmax(z, exp['T']); pred = pr.argmax(1)
model['tok'] = exp
report['tok'] = {'C': C, 'dev_acc': float(((pred == yd) * Wd).sum() / Wd.sum()), 'T': exp['T'], 'per_class_recall': {c: float(((pred == i) & (yd == i)).astype(np.float32).dot(Wd) / max(Wd[yd == i].sum(), 1)) for c, i in tci.items()}}
print('tok', report['tok'], file=sys.stderr)

# ------------------------------------------------------------------ verify gate (replaces the round-1 gate)
vdv = vrows(dev)
def vmatrix(rows, colmap_):
    ip = [0]; ind = []; dat = []
    for ids, y, src in rows:
        c = colmap_[ids]; c = c[c >= 0]; ind.append(c.astype(np.int32)); dat.append(np.full(len(c), 1.0 / math.sqrt(len(ids)), dtype=np.float32)); ip.append(ip[-1] + len(c))
    return sp.csr_matrix((np.concatenate(dat), np.concatenate(ind), np.array(ip)), shape=(len(rows), int((colmap_ >= 0).sum())), dtype=np.float32)
dfv = np.zeros(NB, dtype=np.float64)
for ids, y, src in vtr: dfv[ids] += 1
keepv = np.nonzero(dfv >= 3)[0]; cmv = -np.ones(NB, dtype=np.int64); cmv[keepv] = np.arange(len(keepv))
yv = np.array([y for _, y, _ in vtr]); yvd = np.array([y for _, y, _ in vdv]); srcv = np.array([s_ for _, _, s_ in vdv])
print('verify rows train', len(vtr), 'dev', len(vdv), 'positive rate', float(yv.mean()), 'columns', len(keepv), file=sys.stderr)
Mv = vmatrix(vtr, cmv); Mvd = vmatrix(vdv, cmv)
lrv = LogisticRegression(C=args.vc, max_iter=400); lrv.fit(Mv, yv)
sel = np.sort(np.argsort(-(np.abs(lrv.coef_[0]) * np.sqrt(dfv[keepv])))[:args.vfeat])
cm2 = -np.ones(NB, dtype=np.int64); cm2[keepv[sel]] = np.arange(len(sel))
Mv2 = vmatrix(vtr, cm2); Mvd2 = vmatrix(vdv, cm2)
lrv2 = LogisticRegression(C=args.vc, max_iter=400); lrv2.fit(Mv2, yv)
rawd = Mvd2 @ lrv2.coef_[0] + lrv2.intercept_[0]
a, b = fit_platt(rawd, yvd, np.ones(len(yvd)))
pv = 1 / (1 + np.exp(-(a * rawd + b)))
wv = {str(int(keepv[sel[j]])): round(float(lrv2.coef_[0][j]), 2) for j in range(len(sel)) if abs(lrv2.coef_[0][j]) >= 0.02}
model['verify'] = {'b': round(float(lrv2.intercept_[0]), 3), 'platt': [round(a, 3), round(b, 3)], 'feats': wv}
tab = {}
for nm in ('dev1', 'dev2'):
    mk0 = srcv == nm
    for th in (0.8, 0.9, 0.95, 0.97, 0.98, 0.99):
        m = mk0 & (pv >= th); tab['%s@%s' % (nm, th)] = {'n': int(m.sum()), 'right': int((m & (yvd == 1)).sum()), 'wrong': int((m & (yvd == 0)).sum()), 'positives': int((mk0 & (yvd == 1)).sum())}
vth = args.verify_th or 0.98
gth = vth
if args.gate_th: gth = args.gate_th
# hook B: the op/measure heads may SUPPLY a missing trigger only above the lowest threshold whose precision on HVAC-dev + dev is >= 0.99
hookb = {'op': 0.99, 'measure': 0.99}
for hname in (() if args.only_tg else ('op', 'measure')):
    r = report[hname]
    for th in ('0.8', '0.9', '0.95', '0.98', '0.99'):
        ok = True
        for nm in ('dev1', 'dev2', 'hvac_dev'):
            t = r.get(nm + '_by_th', {}).get(th)
            if t and t['coverage'] > 0 and t['precision'] < 0.985: ok = False
        if ok: hookb[hname] = float(th); break
if args.gate_th: gth = args.gate_th
if args.only_tg: hookb = _b['thresholds']['hookB']
model['thresholds'] = {'verify': gth, 'tok': args.tok_th, 'head': 0.9, 'hookB': hookb}
report['verify'] = {'by_threshold': tab, 'chosen': gth, 'platt': model['verify']['platt'], 'n_feats': len(wv)}
print('verify', json.dumps(tab), 'chosen', gth, 'hookB', hookb, file=sys.stderr)

if args.parity:
    with open(args.parity, 'w') as fh: json.dump(PAR, fh)
with open(args.out, 'w') as fh: json.dump(model, fh, separators=(',', ':'))
print('wrote', args.out, os.path.getsize(args.out), 'bytes', file=sys.stderr)
if args.report:
    with open(args.report, 'w') as fh: json.dump(report, fh, indent=1)
