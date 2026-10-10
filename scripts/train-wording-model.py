#!/usr/bin/env python3
"""
Offline trainer for Donovan's wording model (OFFLINE ONLY; the runtime is plain JS in api/_lib/wording/index.js).

  python3 scripts/train-wording-model.py [--corpus DIR] [--catalog FILE] [--golden FILE]

Pipeline
  1. slot masking   mask(text, lex) -> tokens.  Rules live in api/_lib/wording/maskspec.json (shared with JS, so the two
                    languages run the very same regexes); roster names (technicians, customers, brands, cities) and the
                    capitalised-unknown-name rule are mirrored by hand in index.js.
  2. features       word uni/bigrams + char 3-5 grams (word-bounded) + a slot-type bag, binary, L2-scaled over the exported vocab.
  3. classifier     multinomial logistic regression over 169 template ids + "none"; features pruned to the top-K per class;
                    the pruned model is what is evaluated and exported (so JS == what was measured).
  4. slot words     word -> slot value mappings mined from aligned paraphrase pairs ("jobs" -> "service tickets"),
                    kept only at >=3 sightings and >=95% consistency.
  5. threshold      calibrated on para/test + near/test for >=99% precision.
  6. export         api/_lib/wording/model.json, slotwords.json, parity.json
"""
import argparse, glob, json, math, os, random, re, sys, collections
import numpy as np
from scipy import sparse
from sklearn.linear_model import LogisticRegression

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "api/_lib/wording")
SPEC = json.load(open(os.path.join(OUT, "maskspec.json")))
PLACEHOLDERS = {r["t"] for r in SPEC["rules"]} | {"zztech", "zzcust", "zzbrand", "zzcity"}
RULES = [(r["t"], re.compile(r["re"], re.I), r["g"]) for r in SPEC["rules"]]
TOKEN = re.compile(r"[A-Za-z0-9]+")


# ---------------------------------------------------------------- masking (mirrored in index.js)
def build_lex(techs=(), customers=(), brands=(), cities=()):
    """roster -> {token-tuple: type}.  Full names; last names (and first names of technicians) when >=4 letters and unique."""
    lex = {}
    def add(phrase, typ):
        k = tuple(t.lower() for t in TOKEN.findall(phrase))
        if k and k not in lex:
            lex[k] = typ
    singles = collections.defaultdict(set)
    for typ, names, part in (("zztech", techs, True), ("zzcust", customers, False)):
        for n in names:
            toks = [t.lower() for t in TOKEN.findall(n)]
            add(n, typ)
            if len(toks) >= 2:
                singles[toks[-1]].add((typ, tuple(toks)))
                if part:
                    singles[toks[0]].add((typ, tuple(toks)))
    for w, owners in singles.items():
        if len(w) >= 4 and len({o[1] for o in owners}) == 1:
            lex.setdefault((w,), next(iter(owners))[0])
    for b in list(SPEC["brands"]) + list(brands): add(b, "zzbrand")
    for c in list(SPEC["cities"]) + list(cities): add(c, "zzcity")
    return lex


def mask(text, lex, common):
    """-> (tokens, found) ; tokens are lowercase words with placeholder tokens (zz*); found = [(type, raw)] in text order."""
    s = text.replace("’", "'").replace("‘", "'")
    s = re.sub(r"[^\x00-\x7f]", " ", s)
    raws = []
    for typ, rx, g in RULES:
        out, last = [], 0
        for m in rx.finditer(s):
            a, b = m.span(g)
            if a < 0 or a == b:
                continue
            raws.append(s[a:b]); out.append(s[last:a]); out.append(" %s%d " % (typ, len(raws) - 1)); last = b
        out.append(s[last:]); s = "".join(out)
    toks = TOKEN.findall(s)
    res, found, i, n = [], [], 0, len(toks)
    ph = re.compile(r"^(zz[a-z]+)(\d+)$")
    while i < n:
        t = toks[i]; low = t.lower(); m = ph.match(low)
        if m:
            res.append(m.group(1)); found.append((m.group(1), raws[int(m.group(2))])); i += 1; continue
        hit = None
        for L in (6, 5, 4, 3, 2, 1):
            if i + L <= n:
                k = tuple(x.lower() for x in toks[i:i + L])
                if k in lex and not any(ph.match(x) for x in k):
                    hit = (L, lex[k]); break
        if hit:
            L, typ = hit
            res.append(typ); found.append((typ, " ".join(toks[i:i + L]))); i += L; continue
        # unknown capitalised name-like span (never a known word)
        if len(t) >= 3 and t[0].isupper() and t[1:].islower() and low not in common:
            j = i + 1
            while j < n and len(toks[j]) >= 3 and toks[j][0].isupper() and toks[j][1:].islower() and toks[j].lower() not in common and not ph.match(toks[j].lower()):
                j += 1
            # a trailing possessive "s" is its own token already
            res.append("zzcust"); found.append(("zzcust", " ".join(toks[i:j]))); i = j; continue
        res.append(low); i += 1
    return res, found


def feats(tokens):
    f = set()
    seq = ["^"] + tokens + ["$"]
    for t in seq: f.add("w:" + t)
    for i in range(len(seq) - 1): f.add("b:" + seq[i] + " " + seq[i + 1])
    cnt = collections.Counter()
    for t in tokens:
        if t in PLACEHOLDERS:
            cnt[t] += 1; continue
        w = " " + t + " "
        for n in (3, 4, 5):
            for i in range(len(w) - n + 1): f.add("c:" + w[i:i + n])
    for k, v in cnt.items(): f.add("g:%s:%d" % (k, min(v, 3)))
    return f


# ---------------------------------------------------------------- model scoring on the exported structure (mirrored in index.js)
def score(model, tokens):
    fs = [x for x in feats(tokens) if x in model["feats"]]
    n = len(fs)
    sc = list(model["b"])
    if n:
        sc_ = np.array(sc, dtype=np.float64); inv = 1.0 / math.sqrt(n)
        for x in fs:
            e = model["feats"][x]
            for j in range(0, len(e), 2): sc_[e[j]] += e[j + 1] * inv
        sc = sc_
    sc = np.array(sc, dtype=np.float64)
    sc -= sc.max(); p = np.exp(sc); p /= p.sum()
    k = int(p.argmax())
    return k, float(p[k])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", default="/home/claude/work/train/corpus")
    ap.add_argument("--catalog", default="/home/claude/work/train/catalog.json")
    ap.add_argument("--golden", default=os.path.join(ROOT, "scripts/golden/golden-export.json"))
    ap.add_argument("--topk", type=int, default=250)
    ap.add_argument("--C", type=float, default=300.0)
    ap.add_argument("--mindf", type=int, default=2)
    ap.add_argument("--dry", action="store_true")
    a = ap.parse_args()
    random.seed(7); np.random.seed(7)

    cat = json.load(open(a.catalog))
    rows = [json.loads(l) for f in sorted(glob.glob(a.corpus + "/g*.jsonl")) for l in open(f)]
    gold = json.load(open(a.golden))
    customers = [(e.get("data") or {}).get("customer_name") for e in gold["entities"] if e.get("entity_type") == "customer"]
    customers = [c for c in customers if c]
    techs = sorted({x["value"] for x in gold["extractions"] if x.get("field_key") == "technician"})
    for r in rows:
        for k, v in r["slots"].items():
            if k.startswith("customer") and v not in customers: customers.append(v)
    lex = build_lex(techs, customers)

    # common words: lowercase tokens seen >=2 times in corpus texts, minus any name tokens
    name_toks = {t.lower() for n in customers + techs for t in TOKEN.findall(n)}
    cc = collections.Counter()
    for r in rows:
        if r["kind"] != "para" or r["split"] != "train": continue   # near-miss and test wording never make a word "known"
        for t in TOKEN.findall(r["text"]):
            if t == t.lower(): cc[t] += 1
    for c in cat:
        for t in TOKEN.findall(c["canonical"].lower()): cc[t] += 2
    common = {w for w, n in cc.items() if n >= 1 and w not in name_toks and not w.isdigit()}
    common |= {w for w in ("how", "what", "which", "who", "when", "where", "show", "list", "give", "tell", "pull", "get", "the", "and", "invoices", "customers")}

    classes = [c["id"] for c in cat] + ["none"]
    cidx = {c: i for i, c in enumerate(classes)}

    # ---- training data
    def label(r): return r["template"] if r["template"] in cidx else "none"
    train = [(r["text"], label(r)) for r in rows if r["split"] == "train"]
    test = [r for r in rows if r["split"] == "test"]
    # clean exemplars: catalog examples + a few canonical fills
    for c in cat:
        for e in c.get("examples", []): train.append((e, c["id"]))
        for _ in range(4):
            q = c["canonical"]
            for s in re.findall(r"\{(\w+)\}", c["canonical"]):
                vals = c["slots"].get(s) or [""]
                q = q.replace("{%s}" % s, random.choice(vals), 1)
            train.append((q, c["id"]))
    tok_train = [mask(t, lex, common)[0] for t, _ in train]
    y = np.array([cidx[l] for _, l in train])
    F = [feats(t) for t in tok_train]
    df = collections.Counter(x for f in F for x in f)
    vocab = sorted(x for x, n in df.items() if n >= a.mindf)
    print("train rows", len(train), "classes", len(classes), "vocab", len(vocab))

    def design(Fs, vidx):
        ind, ptr, val = [], [0], []
        for f in Fs:
            ids = [vidx[x] for x in f if x in vidx]
            inv = 1.0 / math.sqrt(len(ids)) if ids else 0.0
            ind += ids; val += [inv] * len(ids); ptr.append(len(ind))
        return sparse.csr_matrix((val, ind, ptr), shape=(len(Fs), len(vidx)))

    def fit(vocab_list):
        vidx = {x: i for i, x in enumerate(vocab_list)}
        X = design(F, vidx)
        clf = LogisticRegression(C=a.C, max_iter=400, solver="lbfgs")
        clf.fit(X, y)
        return vidx, clf

    # pass 1: pick features by per-class weight magnitude
    vidx, clf = fit(vocab)
    W = np.zeros((len(classes), len(vocab))); W[clf.classes_] = clf.coef_
    keep = set()
    for ci in range(len(classes)):
        top = np.argsort(-np.abs(W[ci]))[: a.topk]
        keep.update(int(j) for j in top if abs(W[ci][j]) > 1e-6)
    vocab2 = sorted(vocab[j] for j in keep)
    print("pass-1 union vocab", len(vocab2))
    # pass 2: retrain on the union vocab, prune per class again, quantise
    vidx2, clf2 = fit(vocab2)
    W2 = np.zeros((len(classes), len(vocab2))); W2[clf2.classes_] = clf2.coef_
    b = np.full(len(classes), -20.0); b[clf2.classes_] = clf2.intercept_
    feats_out = {x: [] for x in vocab2}
    for ci in range(len(classes)):
        top = np.argsort(-np.abs(W2[ci]))[: a.topk]
        for j in top:
            w = round(float(W2[ci][j]), 2)
            if w != 0: feats_out[vocab2[j]].extend([ci, w])
    model = {"v": 1, "classes": classes, "b": [round(float(x), 2) for x in b], "feats": feats_out}
    # vocab for normalisation = every feature that has at least one weight left
    print("exported features", len(feats_out))

    # ---- evaluation on test (pruned model, exactly as JS runs it)
    def pred(text):
        t, _ = mask(text, lex, common)
        return score(model, t)
    ev = []
    for r in test:
        k, p = pred(r["text"])
        ev.append((r, classes[k], p))
    fupc = lambda t: t.startswith("fup_")
    def stats(th, skip_fup=True):
        acc = tot = emit = right = 0
        for r, pc, p in ev:
            gold_t = label(r)
            tot += 1; acc += pc == gold_t
            if pc == "none" or p < th or (skip_fup and fupc(pc)): continue
            emit += 1; right += pc == gold_t
        return emit, right
    print("raw top-1 accuracy (all test): %.4f" % (sum(1 for r, pc, p in ev if pc == label(r)) / len(ev)))
    nonfup = [e for e in ev if not fupc(label(e[0])) or True]
    cand = None
    print("th     emit  right  prec    coverage(of non-none non-fup gold)")
    gold_n = sum(1 for r, _, _ in ev if label(r) != "none" and not fupc(label(r)))
    for th in [0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.93, 0.95, 0.97, 0.98, 0.99]:
        e, rt = stats(th)
        print("%.2f %6d %6d  %.4f  %.4f" % (th, e, rt, rt / e if e else 1, rt / gold_n))
        if cand is None and e and rt / e >= 0.995: cand = th
    th = cand if cand is not None else 0.99
    # choose smallest threshold with precision >=0.99 AND stays >=0.99 for all higher thresholds
    chosen = None
    for t in [x / 100 for x in range(30, 100)]:
        e, rt = stats(t)
        if e and rt / e >= 0.995: chosen = t; break
    th = chosen if chosen is not None else 0.99
    e, rt = stats(th)
    print("THRESHOLD", th, "emit", e, "right", rt, "precision %.4f" % (rt / e), "coverage %.4f" % (rt / gold_n))
    # confusion pairs
    conf = collections.Counter((label(r), pc) for r, pc, p in ev if pc != label(r))
    print("top confusions (gold -> pred):", conf.most_common(15))
    wrongs = [(label(r), pc, round(p, 3), r["text"]) for r, pc, p in ev if pc != label(r) and p >= th and pc != "none" and not fupc(pc)]
    print("wrong above threshold:", wrongs)
    # per-split numbers
    for kind in ("para", "near"):
        sub = [(r, pc, p) for r, pc, p in ev if r["kind"] == kind]
        a1 = sum(1 for r, pc, p in sub if pc == label(r)) / len(sub)
        em = [(r, pc, p) for r, pc, p in sub if pc != "none" and p >= th and not fupc(pc)]
        print(kind, "n", len(sub), "top1 %.4f" % a1, "emitted", len(em), "right", sum(1 for r, pc, p in em if pc == label(r)))

    # ---- slot words (aligned pairs)
    slotwords = mine_slot_words(rows, cat, lex, common)

    if a.dry:
        return
    # ---- per-template word knowledge (the "does this template know this word" guard): words seen in that template's paraphrases,
    #      words shared by >=2 templates of a family, and generic filler words used across >=8 templates
    cw = sorted(common); wid = {w: i for i, w in enumerate(cw)}
    fam_of = {c["id"]: c["family"] for c in cat}
    seen = collections.defaultdict(set)
    for r in rows:
        if r["kind"] != "para" or r["split"] != "train" or r["template"] not in fam_of: continue
        for t in mask(r["text"], lex, common)[0]:
            if t in wid: seen[r["template"]].add(t)
    tdf = collections.Counter(w for ws in seen.values() for w in ws)
    generic = {w for w, n in tdf.items() if n >= 8}
    famcnt = collections.defaultdict(collections.Counter)
    for tid, ws in seen.items():
        for w in ws: famcnt[fam_of[tid]][w] += 1
    fw = {f: sorted(wid[w] for w, n in c.items() if n >= 2 and w not in generic) for f, c in famcnt.items()}
    tw = {tid: sorted(wid[w] for w in ws if w not in generic) for tid, ws in seen.items()}
    # ---- export
    model["threshold"] = th
    model["common"] = cw
    model["generic"] = sorted(wid[w] for w in generic)
    model["tw"] = tw
    model["fw"] = fw
    model["lex"] = {"brands": SPEC["brands"], "cities": SPEC["cities"]}
    json.dump(model, open(os.path.join(OUT, "model.json"), "w"), separators=(",", ":"))
    json.dump(slotwords, open(os.path.join(OUT, "slotwords.json"), "w"), indent=0, sort_keys=True)
    docvals = sorted({v for c in cat for k, vs in c["slots"].items() if k.startswith("doctype") for v in vs if v.endswith("s")})
    json.dump({"docvalues": docvals, "templates": [{"id": c["id"], "family": c["family"], "canonical": c["canonical"]} for c in cat]}, open(os.path.join(OUT, "templates.json"), "w"), separators=(",", ":"))
    # parity fixture: 200 corpus lines + python's own prediction
    sample = random.sample(rows, 200)
    par = []
    for r in sample:
        k, p = pred(r["text"])
        par.append({"text": r["text"], "cls": classes[k], "prob": round(p, 6), "tokens": mask(r["text"], lex, common)[0]})
    json.dump({"techs": techs, "customers": customers, "lines": par}, open(os.path.join(ROOT, "scripts/wording-parity.json"), "w"), separators=(",", ":"))
    json.dump({"threshold": th, "emit": e, "right": rt, "precision": rt / e, "coverage": rt / gold_n}, open(os.path.join(ROOT, "scripts/wording-eval-classifier.json"), "w"))
    sz = os.path.getsize(os.path.join(OUT, "model.json"))
    print("model.json bytes", sz)


# ---------------------------------------------------------------- slot-word mining
DOC_KINDS = {"doctype", "doctype_dated", "doctype_money", "doctype_cust", "doctype2", "doctype3", "doctype_cust2"}
DOC_ALIASES = {"service ticket": "service tickets"}

def plural_doc(v):
    v = v.lower().strip()
    if v.endswith("s"): return v
    return v + "s"

def mine_slot_words(rows, cat, lex, common):
    canon = {c["id"]: set(re.findall(r"[a-z]+", re.sub(r"\{\w+\}", " ", c["canonical"]).lower())) for c in cat}
    stop = set("the a an of in on for to and or is are was were be do does did we our us you your i my me it its that this these those with by at as from about any all".split())
    groups = {"doctype": DOC_KINDS, "tickettype": {"tickettype"}}
    out = {}
    for gname, kinds in groups.items():
        co = collections.Counter(); den = collections.Counter(); literal_vals = set()
        for r in rows:
            if r["kind"] != "para" or r["template"] not in canon: continue
            vs = {plural_doc(v) if gname == "doctype" else v.lower() for k, v in r["slots"].items() if k in kinds}
            if len(vs) != 1: continue
            v = next(iter(vs)); literal_vals.add(v)
            toks, _ = mask(r["text"], lex, common)
            low = " ".join(toks)
            words = [t for t in toks if not t.startswith("zz") and t not in stop and t not in canon[r["template"]]]
            ngrams = set(words)
            for i in range(len(toks) - 1):
                if toks[i] in stop or toks[i + 1] in stop or toks[i].startswith("zz") or toks[i + 1].startswith("zz"): continue
                if toks[i] in canon[r["template"]] or toks[i + 1] in canon[r["template"]]: continue
                ngrams.add(toks[i] + " " + toks[i + 1])
            lit = v in low or v[:-1] in low or (gname == "tickettype" and v in low)
            vw = set(re.findall(r"[a-z]+", v)) | {x.rstrip("s") for x in re.findall(r"[a-z]+", v)}
            for g in ngrams:
                if set(g.split()) <= vw: continue   # part of the literal value itself
                den[g] += 1
                if not lit: co[(g, v)] += 1
        m = {}
        for (g, v), n in co.items():
            if n >= 3 and n / den[g] >= 0.95 and g not in literal_vals and g.rstrip("s") != v.rstrip("s"):
                m[g] = v
        # drop mappings that are subsumed (a bigram whose unigram part already maps to the same value)
        for g in list(m):
            if " " in g and all(w in m and m[w] == m[g] for w in g.split() if w in m) and any(w in m for w in g.split()): del m[g]
        out[gname] = m
    return out


if __name__ == "__main__":
    main()
