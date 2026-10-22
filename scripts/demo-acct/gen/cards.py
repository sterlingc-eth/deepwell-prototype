#!/usr/bin/env python3
""""Try asking..." cards (one page per Wave 1 industry) and the one-page presenter guide, as print- and iPad-friendly PDFs.

  python3 scripts/demo-acct/gen/cards.py --docs <generated docs dir> --out <dir>

Cards use the 5 questions marked "card" in each industry's questions.json (the QA-checked starter list).
"""
import argparse
import json
import os

from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import letter
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

FONT_DIR = os.environ.get("DEMO_FONT_DIR", "/home/claude/work/demoacct/fonts")
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
LOGO_SRC = os.path.join(REPO, "brand", "deepwell-logo-horizontal.png")


def cropped_logo():
    """The horizontal logo without its wide white margins (so it reads at card size)."""
    from PIL import Image, ImageChops
    im = Image.open(LOGO_SRC).convert("RGB")
    bbox = ImageChops.difference(im, Image.new("RGB", im.size, (255, 255, 255))).getbbox()
    out = os.path.join(os.environ.get("TMPDIR", "/tmp"), "deepwell-logo-cropped.png")
    im.crop(bbox).save(out)
    return out, im.crop(bbox).size

FOREST_700 = HexColor("#163C2C")
FOREST_50 = HexColor("#EEF4F0")
FOREST_100 = HexColor("#D8E6DC")
BRASS_300 = HexColor("#D9B57A")
BRASS_700 = HexColor("#7A572C")
INK = HexColor("#16201B")
INK_2 = HexColor("#3D4A43")
INK_3 = HexColor("#5F6B65")
W, H = letter


def fonts():
    pdfmetrics.registerFont(TTFont("Plex", os.path.join(FONT_DIR, "IBMPlexSans-Regular.ttf")))
    pdfmetrics.registerFont(TTFont("PlexSemi", os.path.join(FONT_DIR, "IBMPlexSans-SemiBold.ttf")))
    pdfmetrics.registerFont(TTFont("PlexBold", os.path.join(FONT_DIR, "IBMPlexSans-Bold.ttf")))
    pdfmetrics.registerFont(TTFont("Serif", os.path.join(FONT_DIR, "Newsreader.ttf")))


def wrap(c, text, font, size, width):
    words, out, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if c.stringWidth(t, font, size) > width and cur:
            out.append(cur)
            cur = w
        else:
            cur = t
    if cur:
        out.append(cur)
    return out


def header(c, subtitle):
    c.setFillColor(FOREST_700)
    c.rect(0, H - 118, W, 118, stroke=0, fill=1)
    c.setFillColor(HexColor("#FFFFFF"))
    c.roundRect(40, H - 96, 210, 68, 10, stroke=0, fill=1)
    logo, (lw, lh) = cropped_logo()
    h = 44
    c.drawImage(logo, 54, H - 84, width=h * lw / lh, height=h, mask="auto")
    c.setFillColor(BRASS_300)
    c.roundRect(W - 132, H - 74, 92, 26, 13, stroke=0, fill=1)
    c.setFillColor(FOREST_700)
    c.setFont("PlexSemi", 12)
    c.drawCentredString(W - 86, H - 65, subtitle)


def footer(c, text):
    c.setStrokeColor(FOREST_100)
    c.setLineWidth(1)
    c.line(40, 58, W - 40, 58)
    c.setFillColor(INK_3)
    c.setFont("Plex", 9.5)
    c.drawString(40, 40, text)
    c.drawRightString(W - 40, 40, "deepwelltechnology.com")


def card(c, label, company, questions):
    header(c, "DEMO")
    c.setFillColor(INK)
    c.setFont("Serif", 44)
    c.drawString(40, H - 190, "Try asking…")
    c.setFillColor(BRASS_700)
    c.setFont("PlexSemi", 15)
    c.drawString(40, H - 220, label.upper())
    c.setFillColor(INK_2)
    c.setFont("Plex", 13)
    c.drawString(40, H - 240, f"Sample company: {company}")
    y = H - 272
    for i, q in enumerate(questions[:5]):
        lines = wrap(c, q, "PlexSemi", 16, W - 80 - 76)
        box_h = 26 + 20 * len(lines)
        c.setFillColor(FOREST_50)
        c.setStrokeColor(FOREST_100)
        c.roundRect(40, y - box_h, W - 80, box_h, 12, stroke=1, fill=1)
        c.setFillColor(FOREST_700)
        c.circle(70, y - box_h / 2, 14, stroke=0, fill=1)
        c.setFillColor(HexColor("#FFFFFF"))
        c.setFont("PlexBold", 14)
        c.drawCentredString(70, y - box_h / 2 - 5, str(i + 1))
        c.setFillColor(INK)
        c.setFont("PlexSemi", 16)
        ty = y - box_h / 2 + (len(lines) - 1) * 10 - 5.5
        for ln in lines:
            c.drawString(100, ty, ln)
            ty -= 20
        y -= box_h + 12
    assert y > 160, f"questions run into the footer area ({y})"
    # how it works (fixed band above the footer)
    y = 150
    c.setFillColor(INK)
    c.setFont("PlexSemi", 13)
    c.drawString(40, y, "How it works")
    y -= 22
    steps = [("Ask in your own words.", "Type or say a question, the way you would ask your office manager."),
             ("See the proof.", "Every answer shows the document and page it came from. Tap it to open the page."),
             ("Try your own paper.", "Scan one of your documents with the camera and ask about it right away.")]
    col_w = (W - 80 - 24) / 3
    for i, (t, d) in enumerate(steps):
        x = 40 + i * (col_w + 12)
        c.setFillColor(BRASS_700)
        c.setFont("PlexSemi", 11.5)
        c.drawString(x, y, t)
        c.setFillColor(INK_2)
        c.setFont("Plex", 10.5)
        yy = y - 15
        for ln in wrap(c, d, "Plex", 10.5, col_w):
            c.drawString(x, yy, ln)
            yy -= 13.5
    footer(c, "Sample company and documents are fictional, made for this demonstration.")


def guide(c, industries):
    header(c, "GUIDE")
    c.setFillColor(INK)
    c.setFont("Serif", 32)
    c.drawString(40, H - 172, "Presenting the DeepWell demo")
    c.setFillColor(INK_2)
    c.setFont("Plex", 12)
    c.drawString(40, H - 192, "One page for the person holding the iPad. About 10 minutes with a prospect.")
    sections = [
        ("Before the meeting", [
            "Open deepwelltechnology.com/app on the iPad and sign in as demo@deepwelltechnology.com (password in the team password manager).",
            "On the industry screen, tap “Check all demos”. Every industry should show a green check. If one does not, use another industry or the website “Try it” section.",
            "Charge the iPad, turn on Do Not Disturb, and set the screen to stay on.",
        ]),
        ("Pick the industry", [
            "Tap the prospect's industry. Their sample company opens on Donovan's Ask screen.",
            f"Built so far: {', '.join(industries)}.",
            "“Switch industry” in the top bar goes back to the list at any time.",
        ]),
        ("Ask and show the proof", [
            "Start with a “Try asking” question on screen or on the printed card, then let the prospect ask their own.",
            "Tap the source under an answer to open the exact page it came from. That is the moment that sells it.",
            "Ask the last card question on purpose: Donovan says when something is not in the records instead of guessing.",
        ]),
        ("The live scan", [
            "Tap Inbox, then Add files, and choose Take Photo. Photograph one of the prospect's own documents, with their permission.",
            "Give it a minute to read, then ask about it on the Ask screen.",
        ]),
        ("After the meeting", [
            "Tap “Clear my scans” (eraser icon, top bar) and confirm. The prospect's document is deleted; the sample paperwork stays.",
            "Every night the demo also resets itself to the original sample paperwork.",
        ]),
        ("If the Wi-Fi is weak", [
            "Use the iPad's personal hotspot or a phone hotspot first.",
            "No connection at all: open deepwelltechnology.com and use the “Try it” section, which runs the industry demo right in the browser.",
            "The printed “Try asking…” card still shows what Donovan answers.",
        ]),
    ]
    y = H - 222
    for title, items in sections:
        c.setFillColor(FOREST_700)
        c.setFont("PlexSemi", 12.5)
        c.drawString(40, y, title)
        y -= 16
        for it in items:
            lines = wrap(c, it, "Plex", 10.4, W - 80 - 16)
            c.setFillColor(BRASS_700)
            c.circle(46, y + 3.5, 2.3, stroke=0, fill=1)
            c.setFillColor(INK_2)
            c.setFont("Plex", 10.4)
            for ln in lines:
                c.drawString(56, y, ln)
                y -= 13.6
            y -= 2
        y -= 6
    footer(c, "Demo companies and documents are fictional.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--docs", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    fonts()
    os.makedirs(a.out, exist_ok=True)
    order = ["realestate", "propmgmt", "hvac", "plumbing", "electrical", "contractors"]
    labels = []
    all_c = canvas.Canvas(os.path.join(a.out, "Try asking cards - Wave 1 (all industries).pdf"), pagesize=letter)
    all_c.setTitle("Try asking - DeepWell industry demos")
    for slug in order:
        d = json.load(open(os.path.join(a.docs, slug, "questions.json")))
        meta = d["meta"]
        qs = [q["q"] for q in d["questions"] if q.get("card")]
        nir = [q["q"] for q in d["questions"] if q.get("notInRecords")]
        picks = qs[:4] + nir[:1]
        assert len(picks) == 5, (slug, picks)
        labels.append(meta["label"])
        fn = os.path.join(a.out, f"Try asking - {meta['label']}.pdf")
        c = canvas.Canvas(fn, pagesize=letter)
        c.setTitle(f"Try asking - {meta['label']}")
        card(c, meta["label"], meta["company"], picks)
        c.showPage()
        c.save()
        card(all_c, meta["label"], meta["company"], picks)
        all_c.showPage()
        print("card", fn)
    all_c.save()
    g = canvas.Canvas(os.path.join(a.out, "Presenter guide - DeepWell demo.pdf"), pagesize=letter)
    g.setTitle("Presenter guide - DeepWell demo")
    guide(g, labels)
    g.showPage()
    g.save()
    print("guide done")


if __name__ == "__main__":
    main()
