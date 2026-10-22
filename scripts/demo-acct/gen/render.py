"""Rendering helpers for the demo-account sample paperwork (Wave 1).

Every document is FICTIONAL and visibly marked "SAMPLE". The stamp and the footer are drawn as raster images, not as
text, so they never become part of the document's text layer (the reader would otherwise read "SAMPLE" as content).

Kinds:
  pdf          born-digital PDF (text layer)                       -> read in-process, no model
  scan         image-only PDF, slightly rotated, grey, speckled     -> needs the vision reader
  photo        phone photo (JPEG) of a printed page on a desk       -> needs the vision reader
  handwritten  phone photo (JPEG) of a handwritten note            -> needs the vision reader
"""
import io
import math
import os
import random
import subprocess
import tempfile

from PIL import Image, ImageDraw, ImageFilter, ImageFont
from reportlab.lib.pagesizes import letter
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

HERE = os.path.dirname(os.path.abspath(__file__))
FONT_DIR = os.environ.get("DEMO_FONT_DIR", "/home/claude/work/demoacct/fonts")
HAND_FONT = os.path.join(FONT_DIR, "Kalam-Regular.ttf")
SANS = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
SANS_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

PAGE_W, PAGE_H = letter
MARGIN = 54


def _stamp_png(text="SAMPLE", w=900, h=260, alpha=46):
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    f = ImageFont.truetype(SANS_BOLD, 150)
    d.rounded_rectangle([6, 6, w - 6, h - 6], radius=28, outline=(180, 40, 40, alpha + 30), width=10)
    tw = d.textlength(text, font=f)
    d.text(((w - tw) / 2, 40), text, font=f, fill=(180, 40, 40, alpha + 30))
    return img.rotate(28, expand=True, resample=Image.BICUBIC)


def _footer_png(text):
    f = ImageFont.truetype(SANS, 26)
    tmp = Image.new("RGBA", (10, 10))
    tw = int(ImageDraw.Draw(tmp).textlength(text, font=f)) + 20
    img = Image.new("RGBA", (tw, 40), (0, 0, 0, 0))
    ImageDraw.Draw(img).text((10, 4), text, font=f, fill=(120, 120, 120, 255))
    return img


_STAMP = None
_FOOTERS = {}


def stamp_reader():
    global _STAMP
    if _STAMP is None:
        b = io.BytesIO()
        _stamp_png().save(b, "PNG")
        b.seek(0)
        _STAMP = ImageReader(b)
    return _STAMP


def footer_reader(text):
    if text not in _FOOTERS:
        b = io.BytesIO()
        _footer_png(text).save(b, "PNG")
        b.seek(0)
        _FOOTERS[text] = (ImageReader(b), _footer_png(text).size)
    return _FOOTERS[text]


# A page is a list of "rows". Row forms:
#   ("brand", text)        letterhead name (large, bold)
#   ("head", text)         letterhead detail line (small)
#   ("title", text)        document title (bold)
#   ("kv", label, value)   "Label: value"
#   ("text", text)         plain line (wrapped)
#   ("table", [cols], [[cells]...])  line-item table, columns separated by wide gaps
#   ("gap",)               blank space
#   ("sig", label)         signature line
def render_pdf(path, pages, footer="Sample document - fictional data for demonstration only"):
    c = canvas.Canvas(path, pagesize=letter, invariant=1)
    c.setTitle(os.path.splitext(os.path.basename(path))[0])
    c.setAuthor("DeepWell sample data")
    c.setSubject("Sample")
    n = len(pages)
    for pi, rows in enumerate(pages):
        y = PAGE_H - MARGIN
        for row in rows:
            kind = row[0]
            if kind == "brand":
                c.setFont("Helvetica-Bold", 17)
                c.drawString(MARGIN, y - 4, row[1])
                y -= 22
            elif kind == "head":
                c.setFont("Helvetica", 9.5)
                c.drawString(MARGIN, y, row[1])
                y -= 13
            elif kind == "title":
                y -= 10
                c.setFont("Helvetica-Bold", 14)
                c.drawString(MARGIN, y, row[1])
                y -= 22
            elif kind == "kv":
                c.setFont("Helvetica-Bold", 10.5)
                lab = f"{row[1]}:"
                c.drawString(MARGIN, y, lab)
                c.setFont("Helvetica", 10.5)
                c.drawString(MARGIN + c.stringWidth(lab, "Helvetica-Bold", 10.5) + 5, y, str(row[2]))
                y -= 15
            elif kind == "text":
                c.setFont("Helvetica", 10.5)
                for line in _wrap(c, row[1], "Helvetica", 10.5, PAGE_W - 2 * MARGIN):
                    c.drawString(MARGIN, y, line)
                    y -= 14
            elif kind == "table":
                cols, cells = row[1], row[2]
                xs = _col_x(len(cols))
                y -= 4
                c.setFont("Helvetica-Bold", 10)
                for x, h in zip(xs, cols):
                    _draw_cell(c, x, y, h, right=(x != xs[0]))
                y -= 4
                c.setLineWidth(0.5)
                c.line(MARGIN, y, PAGE_W - MARGIN, y)
                y -= 12
                c.setFont("Helvetica", 10)
                desc_w = (xs[1] - 70 - MARGIN) if len(xs) > 2 else (PAGE_W - 2 * MARGIN - 120)
                for r in cells:
                    first = _wrap(c, r[0], "Helvetica", 10, desc_w)
                    _draw_cell(c, xs[0], y, first[0])
                    for x, v in zip(xs[1:], r[1:]):
                        _draw_cell(c, x, y, v, right=True)
                    for extra_line in first[1:]:
                        y -= 12
                        _draw_cell(c, xs[0] + 10, y, extra_line)
                    y -= 14
                y -= 4
            elif kind == "gap":
                y -= 10
            elif kind == "sig":
                y -= 18
                c.setLineWidth(0.6)
                c.line(MARGIN, y, MARGIN + 220, y)
                cap, (cw, ch) = footer_reader(row[1])  # raster caption: a form caption is not a fact
                c.drawImage(cap, MARGIN - 3, y - 14, width=cw * 0.34, height=ch * 0.34, mask="auto")
                y -= 24
        # raster-only marks: stamp + footer (never in the text layer)
        st = stamp_reader()
        if pi == 0:
            c.drawImage(st, PAGE_W - 250, PAGE_H - 200, width=190, height=150, mask="auto")
        else:  # later pages: a small stamp (under 2% of the page) so a short signature page still reads as a text PDF
            c.drawImage(st, PAGE_W - 150, PAGE_H - 110, width=100, height=79, mask="auto")
        ft, (fw, fh) = footer_reader(f"{footer}   |   Page {pi + 1} of {n}")
        c.drawImage(ft, MARGIN, 26, width=fw * 0.36, height=fh * 0.36, mask="auto")
        c.showPage()
    c.save()


def _col_x(n):
    if n == 4:
        return [MARGIN, PAGE_W - MARGIN - 190, PAGE_W - MARGIN - 95, PAGE_W - MARGIN]
    if n == 3:
        return [MARGIN, PAGE_W - MARGIN - 110, PAGE_W - MARGIN]
    if n == 2:
        return [MARGIN, PAGE_W - MARGIN]
    step = (PAGE_W - 2 * MARGIN) / max(1, n - 1)
    return [MARGIN + i * step for i in range(n)]


def _draw_cell(c, x, y, v, right=False):
    v = str(v)
    if right:
        c.drawRightString(x, y, v)
    else:
        c.drawString(x, y, v)


def _wrap(c, text, font, size, width):
    words, out, cur = str(text).split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if c.stringWidth(t, font, size) > width and cur:
            out.append(cur)
            cur = w
        else:
            cur = t
    if cur:
        out.append(cur)
    return out or [""]


def pdf_to_images(pdf_path, dpi=150):
    with tempfile.TemporaryDirectory() as td:
        subprocess.run(["pdftoppm", "-r", str(dpi), "-png", pdf_path, os.path.join(td, "p")], check=True)
        files = sorted(f for f in os.listdir(td) if f.endswith(".png"))
        return [Image.open(os.path.join(td, f)).convert("RGB") for f in files]


def roughen_scan(img, rng):
    """Office scanner look: grey cast, slight skew, speckles, softened edges."""
    g = img.convert("L")
    g = g.point(lambda v: int(v * 0.88 + 18))
    angle = rng.uniform(-1.8, 1.8)
    g = g.rotate(angle, expand=True, fillcolor=236, resample=Image.BICUBIC)
    px = g.load()
    w, h = g.size
    for _ in range(int(w * h * 0.0009)):
        x, y = rng.randrange(w), rng.randrange(h)
        px[x, y] = rng.randrange(40, 140)
    g = g.filter(ImageFilter.GaussianBlur(0.6))
    return g


def render_scan_pdf(path, pages, rng, footer=None):
    tmp = path + ".src.pdf"
    render_pdf(tmp, pages, **({"footer": footer} if footer else {}))
    imgs = [roughen_scan(i, rng) for i in pdf_to_images(tmp, dpi=150)]
    os.remove(tmp)
    imgs[0].save(path, "PDF", resolution=150, save_all=True, append_images=imgs[1:])


def _desk(w, h, rng):
    base = Image.new("RGB", (w, h), (122, 92, 66))
    d = ImageDraw.Draw(base)
    for i in range(0, h, 7):  # wood grain
        tone = 110 + int(18 * math.sin(i / 23.0)) + rng.randrange(-6, 6)
        d.line([(0, i), (w, i + rng.randrange(-3, 3))], fill=(tone + 12, tone - 14, tone - 42), width=4)
    return base.filter(ImageFilter.GaussianBlur(1.2))


def photo_of_page(page_img, rng, size=(1500, 2000)):
    """A phone photo of a printed page lying on a desk: perspective, shadow, warm cast, JPEG."""
    W, H = size
    bg = _desk(W, H, rng)
    pw = int(W * 0.82)
    ph = int(pw * page_img.height / page_img.width)
    page = page_img.resize((pw, ph), Image.LANCZOS)
    # perspective: top edge narrower than bottom
    inset = int(pw * rng.uniform(0.03, 0.06))
    dst = [(inset, 0), (pw - inset // 2, int(ph * 0.01)), (pw, ph), (0, ph - int(ph * 0.01))]
    coeffs = _find_coeffs(dst, [(0, 0), (pw, 0), (pw, ph), (0, ph)])
    warped = page.transform((pw, ph), Image.PERSPECTIVE, coeffs, Image.BICUBIC, fillcolor=(0, 0, 0))
    mask = Image.new("L", (pw, ph), 0)
    ImageDraw.Draw(mask).polygon(dst, fill=255)
    ox, oy = (W - pw) // 2 + rng.randrange(-20, 20), (H - ph) // 2 + rng.randrange(-20, 20)
    shadow = Image.new("L", (pw, ph), 0)
    ImageDraw.Draw(shadow).polygon(dst, fill=120)
    bg.paste((40, 30, 20), (ox + 14, oy + 18), shadow.filter(ImageFilter.GaussianBlur(14)))
    bg.paste(warped, (ox, oy), mask)
    bg = bg.rotate(rng.uniform(-2.5, 2.5), resample=Image.BICUBIC, fillcolor=(110, 80, 55))
    # light falloff + warm cast
    grad = Image.linear_gradient("L").resize((W, H)).point(lambda v: int(255 - v * 0.28))
    bg = Image.composite(bg, Image.new("RGB", (W, H), (60, 50, 40)), grad)
    r, g, b = bg.split()
    bg = Image.merge("RGB", (r.point(lambda v: min(255, int(v * 1.04))), g, b.point(lambda v: int(v * 0.93))))
    return bg


def _find_coeffs(pa, pb):
    import numpy as np
    m = []
    for p1, p2 in zip(pa, pb):
        m.append([p1[0], p1[1], 1, 0, 0, 0, -p2[0] * p1[0], -p2[0] * p1[1]])
        m.append([0, 0, 0, p1[0], p1[1], 1, -p2[1] * p1[0], -p2[1] * p1[1]])
    A = np.array(m, dtype=float)
    B = np.array(pb, dtype=float).reshape(8)
    res = np.linalg.solve(A, B)
    return res.tolist()


def render_photo_jpg(path, pages, rng):
    tmp = path + ".src.pdf"
    render_pdf(tmp, pages)
    img = pdf_to_images(tmp, dpi=130)[0]
    os.remove(tmp)
    photo_of_page(img, rng).save(path, "JPEG", quality=82)


def render_handwritten_jpg(path, lines, rng, heading=None):
    """A note on lined paper, written in a handwriting font, photographed."""
    W, H = 1240, 1600
    paper = Image.new("RGB", (W, H), (252, 250, 238))
    d = ImageDraw.Draw(paper)
    for y in range(190, H - 40, 62):
        d.line([(40, y), (W - 40, y)], fill=(170, 200, 230), width=2)
    d.line([(140, 0), (140, H)], fill=(230, 150, 150), width=2)
    hand = ImageFont.truetype(HAND_FONT, 50)
    small = ImageFont.truetype(SANS_BOLD, 30)
    if heading:
        d.text((160, 70), heading, font=small, fill=(60, 60, 140))
    y = 140
    for line in lines:
        x = 165 + rng.randrange(-6, 10)
        d.text((x, y + rng.randrange(-4, 4)), line, font=hand, fill=(25, 35, 95))
        y += 62
    # SAMPLE stamp (raster) in the corner
    st = _stamp_png(w=700, h=200, alpha=60).resize((300, 200))
    paper.paste(st, (W - 340, H - 260), st)
    paper = paper.rotate(rng.uniform(-3, 3), expand=False, fillcolor=(240, 238, 225), resample=Image.BICUBIC)
    photo_of_page(paper, rng, size=(1500, 1900)).save(path, "JPEG", quality=84)


def page_text(pages):
    """Ground-truth text of each page (what a perfect reader would see), for the manifest."""
    out = []
    for rows in pages:
        lines = []
        for row in rows:
            k = row[0]
            if k in ("brand", "head", "title", "text"):
                lines.append(row[1])
            elif k == "kv":
                lines.append(f"{row[1]}: {row[2]}")
            elif k == "table":
                lines.append("   ".join(row[1]))
                lines.extend("   ".join(map(str, r)) for r in row[2])
            elif k == "sig":
                lines.append(row[1])
        out.append("\n".join(lines))
    return out
