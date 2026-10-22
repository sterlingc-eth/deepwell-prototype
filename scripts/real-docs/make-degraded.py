#!/usr/bin/env python3
"""Degraded copies of real Sonoran test documents, plus handwriting-style notes, each with a KNOWN gold answer.

Owner decision 2026-10-22: no real customer documents; the gate adds synthetic documents degraded to look real.
  - photo:    phone-photo perspective, 4 degree tilt, uneven light, blur, JPEG
  - lowres:   ~96 dpi scan, speckle noise, heavy JPEG
  - skew:     8 degree rotation, grey background, mild blur
  - handwriting: a short service note drawn glyph by glyph (jittered italic, uneven baseline, ink weight) on lined paper,
                 then photographed (photo degradation); its gold facts are the values written on it.
Then every image is read by tesseract (a stand-in for the app's vision transcription, which needs a paid model key) and the
text is stored in test-docs/real-docs/pages-degraded.json together with the gold facts. Synthetic test data only; never
Donovan training.

usage: python3 scripts/real-docs/make-degraded.py <dir with the original test PDFs> <work dir for images>
"""
import json, os, random, subprocess, sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageEnhance

SRC, WORK = sys.argv[1], sys.argv[2]
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
os.makedirs(WORK, exist_ok=True)
rnd = random.Random(20261022)

# Source documents and their gold facts: taken from test-docs/real-docs/INDEPENDENT_GOLD_30.json (written by hand from the
# page) and the live-screenshot lease. Only text-layer PDFs (so the source text is exact).
indep = {d['filename']: d for d in json.load(open(os.path.join(ROOT, 'test-docs/real-docs/INDEPENDENT_GOLD_30.json')))['docs']}
SOURCES = [
    'Ortega Invoice A86698.pdf', 'Jacobs INV-21004.pdf', 'Receipt R-2026-1028 Mercer.pdf', 'Lease - Suite 300 (signed).pdf',
    'MOU - Beacon (Youth).pdf', 'Consignment Agreement - Little Kiln Studio II.pdf', 'COI - Hendrix 2025.pdf', 'Receipt R-20131.pdf',
    'WO 7316 - Bridgeway.pdf', 'Packing Slip PS-48434 Desert.pdf', 'Inspection Sign-off Underground Graves.pdf', 'Credit Memo CM-4500 Patel.pdf',
]
EXTRA_GOLD = {'Lease - Warehouse and Office (signed).pdf': {'facts': {'agreement_term': '60 months (02/10/2023 - 02/09/2028)', 'start_date': '2023-02-10', 'end_date': '2028-02-09', 'vendor': 'Zamora Property Holdings Company', 'customer_name': 'Harborlight Neighbors Alliance'}}}
SOURCES.append('Lease - Warehouse and Office (signed).pdf')

def render(pdf, out_prefix, dpi=150):
    subprocess.run(['pdftoppm', '-r', str(dpi), '-f', '1', '-l', '1', '-png', pdf, out_prefix], check=True)
    for f in sorted(os.listdir(os.path.dirname(out_prefix))):
        if f.startswith(os.path.basename(out_prefix)) and f.endswith('.png'):
            return Image.open(os.path.join(os.path.dirname(out_prefix), f)).convert('RGB')
    raise RuntimeError('render failed: ' + pdf)

def light_gradient(img, strength=0.35):
    w, h = img.size
    grad = Image.linear_gradient('L').resize((w, h)).rotate(rnd.choice([0, 90, 180, 270]), expand=False)
    grad = ImageEnhance.Brightness(grad.convert('RGB')).enhance(1.0)
    return Image.blend(img, Image.composite(img, ImageEnhance.Brightness(img).enhance(1 - strength), grad.convert('L')), 1.0)

def perspective(img):
    w, h = img.size
    d = lambda: rnd.uniform(0.01, 0.04)
    # map output corners to slightly inset input corners (a photo taken at an angle)
    coeffs = find_coeffs([(0, 0), (w, 0), (w, h), (0, h)], [(w * d(), h * d()), (w * (1 - d()), h * d() * 0.5), (w * (1 - d() * 0.5), h * (1 - d())), (w * d() * 0.5, h * (1 - d() * 0.5))])
    return img.transform((w, h), Image.PERSPECTIVE, coeffs, Image.BICUBIC, fillcolor=(90, 85, 80))

def find_coeffs(pa, pb):
    import numpy as np
    m = []
    for p1, p2 in zip(pa, pb):
        m.append([p1[0], p1[1], 1, 0, 0, 0, -p2[0] * p1[0], -p2[0] * p1[1]])
        m.append([0, 0, 0, p1[0], p1[1], 1, -p2[1] * p1[0], -p2[1] * p1[1]])
    A = np.array(m, dtype=float); B = np.array(pb, dtype=float).reshape(8)
    return list(np.linalg.solve(A, B))

def speckle(img, amount=0.015):
    px = img.load(); w, h = img.size
    for _ in range(int(w * h * amount)):
        x, y = rnd.randrange(w), rnd.randrange(h); v = rnd.choice([0, 255]); px[x, y] = (v, v, v)
    return img

def degrade(img, kind):
    if kind == 'photo':
        img = perspective(img).rotate(rnd.uniform(-4, 4), resample=Image.BICUBIC, expand=True, fillcolor=(90, 85, 80))
        img = light_gradient(img).filter(ImageFilter.GaussianBlur(1.1))
        return img, 55
    if kind == 'lowres':
        w, h = img.size
        img = img.resize((int(w * 0.64), int(h * 0.64)), Image.BILINEAR).convert('L').convert('RGB')
        return speckle(img), 30
    if kind == 'skew':
        img = img.rotate(rnd.choice([-8, 8]), resample=Image.BICUBIC, expand=True, fillcolor=(200, 200, 200)).filter(ImageFilter.GaussianBlur(0.7))
        return img, 60
    raise ValueError(kind)

def ocr(path):
    r = subprocess.run(['tesseract', path, 'stdout', '--psm', '4'], capture_output=True, text=True)
    return r.stdout

# ---- handwriting-style notes (generated content with known values)
FONT = next((f for f in ['/usr/share/fonts/truetype/freefont/FreeSansOblique.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf'] if os.path.exists(f)), None)
PEOPLE = ['Rosa Delgado', 'Martin Okafor', 'Helen Brandt', 'Victor Salas']
STREETS = ['4127 E Juniper Ave', '885 N Cholla Dr', '2290 W Mesquite St', '7716 S Ocotillo Ln']
def handwriting(i):
    cust, addr = PEOPLE[i], STREETS[i]
    month, day = rnd.randint(1, 12), rnd.randint(1, 28)
    date = f'{month}/{day}/2026'
    amount = f'{rnd.randint(95, 640)}.{rnd.choice(["00", "50", "25"])}'
    lines = ['SERVICE TICKET', f'Customer: {cust}', f'Service Address: {addr}', f'Date of Service: {date}', 'Work: replaced run capacitor, cleaned coil', f'Total: ${amount}']
    W, H = 1240, 1000
    img = Image.new('RGB', (W, H), (247, 244, 236)); d = ImageDraw.Draw(img)
    for y in range(120, H, 70): d.line([(40, y), (W - 40, y)], fill=(170, 190, 215), width=2)
    y = 70
    for ln in lines:
        x = 70 + rnd.randint(-8, 8)
        for ch in ln:
            size = rnd.randint(38, 46)
            f = ImageFont.truetype(FONT, size)
            glyph = Image.new('RGBA', (size * 2, size * 2), (0, 0, 0, 0))
            ImageDraw.Draw(glyph).text((size // 3, size // 3), ch, font=f, fill=(25, 35, 90, 255), stroke_width=rnd.choice([0, 1]), stroke_fill=(25, 35, 90, 255))
            glyph = glyph.rotate(rnd.uniform(-9, 9), resample=Image.BICUBIC)
            img.paste(glyph, (x, y + rnd.randint(-4, 4)), glyph)
            x += int(f.getlength(ch) * rnd.uniform(0.92, 1.08)) + 1
        y += 70
    gold = {'customer_name': cust, 'service_address': addr, 'service_date': f'2026-{month:02d}-{day:02d}', 'cost': amount}
    return img, gold

out = {'about': 'Degraded copies of real Sonoran test documents and handwriting-style notes; page text from tesseract (stand-in for the vision transcription). gold = the facts the page states.', 'docs': []}
for name in SOURCES:
    gold = (indep.get(name) or EXTRA_GOLD.get(name))
    base = render(os.path.join(SRC, name), os.path.join(WORK, 'src_' + str(SOURCES.index(name))))
    for kind in ['photo', 'lowres', 'skew']:
        img, q = degrade(base.copy(), kind)
        fn = f'{os.path.splitext(name)[0]} [{kind}].jpg'
        p = os.path.join(WORK, fn); img.save(p, 'JPEG', quality=q)
        out['docs'].append({'filename': fn, 'source': name, 'variant': kind, 'route': 'ocr-standin', 'pages': [{'page_no': 1, 'text': ocr(p)}],
                            'gold': gold['facts'], 'partyAnyOf': gold.get('partyAnyOf')})
for i in range(4):
    img, gold = handwriting(i)
    img, q = degrade(img, 'photo')
    fn = f'Handwritten service note {i + 1} [handwriting].jpg'
    p = os.path.join(WORK, fn); img.save(p, 'JPEG', quality=q)
    out['docs'].append({'filename': fn, 'source': None, 'variant': 'handwriting', 'route': 'ocr-standin', 'pages': [{'page_no': 1, 'text': ocr(p)}], 'gold': gold})
json.dump(out, open(os.path.join(ROOT, 'test-docs/real-docs/pages-degraded.json'), 'w'), indent=1)
print(len(out['docs']), 'degraded documents written')
