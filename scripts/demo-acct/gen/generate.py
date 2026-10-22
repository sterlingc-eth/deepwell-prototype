#!/usr/bin/env python3
"""Generate the Wave 1 demo-account sample paperwork.

  python3 scripts/demo-acct/gen/generate.py --out <dir> [--only hvac,plumbing]

Writes <out>/<slug>/files/* (what gets uploaded), <out>/<slug>/manifest.json (ground truth per document) and
<out>/<slug>/questions.json (starter questions with the expected answer and cited source). Deterministic: the same
seed always produces byte-identical text content (image noise is seeded too).
"""
import argparse
import hashlib
import importlib
import json
import os
import random
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import render  # noqa: E402

INDUSTRIES = ["realestate", "propmgmt", "hvac", "plumbing", "electrical", "contractors"]

# The 4 starter questions per industry shown on the Ask screen and printed on the "Try asking..." card (plus the
# not-in-records question on the card). Chosen after QA: locally verified ones first, then the industry's signature questions.
CARDS = {
    "realestate": [1, 3, 7, 12],
    "propmgmt": [1, 4, 5, 8],
    "hvac": [1, 2, 4, 6],
    "plumbing": [3, 4, 5, 7],
    "electrical": [1, 3, 4, 7],
    "contractors": [1, 2, 7, 8],
}


def money_variants(x):
    s = f"{x:,.2f}"
    return "|".join({s, s.replace(",", ""), f"${s}"})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", default="")
    a = ap.parse_args()
    only = [x for x in a.only.split(",") if x]
    summary = []
    for mod_name in INDUSTRIES:
        mod = importlib.import_module(f"ind_{mod_name}")
        if only and mod.SLUG not in only:
            continue
        rng = random.Random(f"deepwell-demo-{mod.SLUG}-v1")
        docs = mod.build(rng)
        for doc in docs:
            m = getattr(mod, "MESSY", {}).get(doc["file"])
            if m:
                doc["kind"], doc["file"] = m
        root = os.path.join(a.out, mod.SLUG)
        files_dir = os.path.join(root, "files")
        os.makedirs(files_dir, exist_ok=True)
        names = set()
        manifest = []
        for doc in docs:
            fn = doc["file"]
            assert fn not in names, f"duplicate file name {fn}"
            names.add(fn)
            path = os.path.join(files_dir, fn)
            kind = doc["kind"]
            if kind == "pdf":
                render.render_pdf(path, doc["pages"])
                text = render.page_text(doc["pages"])
            elif kind == "scan":
                render.render_scan_pdf(path, doc["pages"], rng)
                text = render.page_text(doc["pages"])
            elif kind == "photo":
                render.render_photo_jpg(path, doc["pages"], rng)
                text = render.page_text(doc["pages"])[:1]
            elif kind == "handwritten":
                render.render_handwritten_jpg(path, doc["facts"]["lines"], rng)
                text = ["\n".join(doc["facts"]["lines"])]
            else:
                raise ValueError(kind)
            with open(path, "rb") as fh:
                sha = hashlib.sha256(fh.read()).hexdigest()
            manifest.append({"file": fn, "kind": kind, "pages": len(text), "sha256": sha, "text": text,
                             "facts": {k: v for k, v in doc["facts"].items() if k != "lines"}})
        by_file = {m["file"]: m for m in manifest}
        questions = []
        for i, q in enumerate(mod.QUESTIONS):
            q = dict(q)
            q["id"] = f"{mod.SLUG}-{i + 1:02d}"
            q["card"] = (i + 1) in CARDS[mod.SLUG]
            exp = []
            for e in q.get("expect", []):
                if e.startswith("@"):
                    fname, fact = e[1:].split(":")
                    exp.append(money_variants(by_file[fname]["facts"][fact]))
                else:
                    exp.append(e)
            q["expect"] = exp
            if not q.get("notInRecords"):
                for f in q["file"].split("|"):
                    assert f in by_file, f"{q['id']}: unknown file {f}"
                if isinstance(q.get("page"), str) and q["page"].startswith("find:"):
                    needle = q["page"][5:]
                    first = by_file[q["file"].split("|")[0]]
                    hits = [i + 1 for i, t in enumerate(first["text"]) if needle in t]
                    assert hits, f"{q['id']}: '{needle}' not found in {first['file']}"
                    q["page"] = hits[0]
            questions.append(q)
        assert len(questions) == 15, f"{mod.SLUG}: {len(questions)} questions"
        assert sum(1 for q in questions if q.get("notInRecords")) >= 1
        meta = {"slug": mod.SLUG, "label": mod.LABEL, "company": mod.CO["name"], "orgName": f"Demo · {mod.LABEL} — {mod.CO['name']}",
                "pack": mod.CO.get("pack"), "documents": len(manifest),
                "kinds": {k: sum(1 for m in manifest if m["kind"] == k) for k in ("pdf", "scan", "photo", "handwritten")}}
        with open(os.path.join(root, "manifest.json"), "w") as fh:
            json.dump({"meta": meta, "documents": manifest}, fh, indent=1)
        with open(os.path.join(root, "questions.json"), "w") as fh:
            json.dump({"meta": meta, "questions": questions}, fh, indent=1)
        summary.append(meta)
        print(f"{mod.SLUG:12s} {len(manifest):3d} docs  {meta['kinds']}  -> {root}")
    with open(os.path.join(a.out, "summary.json"), "w") as fh:
        json.dump(summary, fh, indent=1)


if __name__ == "__main__":
    main()
