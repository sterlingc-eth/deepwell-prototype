#!/usr/bin/env python3
"""Synthetic line-item documents with KNOWN gold rows, and degraded copies of them (tables lane, 2026-10-24).

Everything here is invented ("Sample" companies, people and amounts; each page carries a SAMPLE banner). No real customer
document is used or imitated. Never use for Donovan training.

Base documents (born-digital PDFs with a text layer, drawn with reportlab): invoices, receipts, rent rolls, pay applications
(AIA-style schedule of values) and work orders with multi-row line-item tables whose gold rows and totals are known.
Degraded copies (own PIL / numpy / OpenCV script - BSD/MIT/Apache tools only; Augraphy is MIT but is not installed in this
container so it is not used): phone photo (perspective, blur, shadow, JPEG), low-resolution scan, rotated scan with noise,
coffee stain + stamp, handwriting-style fields (jittered italic drawn over a few cells).
Then each image is read by tesseract (stand-in for the paid vision transcription) and its word boxes are turned into layout
text (3+ spaces between columns), the same shape the app's own readers produce.

usage: python3 make-degraded-tables.py <work dir>      writes <work>/clean/*.pdf, <work>/img/*.jpg, <work>/tables-raw.json
"""
import json, math, os, random, subprocess, sys
import numpy as np
import cv2
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter

WORK = sys.argv[1]
for d in ('clean', 'img'):
    os.makedirs(os.path.join(WORK, d), exist_ok=True)
rnd = random.Random(20261024)
W, H = letter  # 612 x 792 pt

def money(c):
    return f"${c/100:,.2f}"

def cents(x):
    return int(round(x * 100))

# ------------------------------------------------------------------------------------------------ invented data pools
VENDORS = ['Sample Mesa Air Supply Co', 'Sample Desert Pipe & Fitting Inc', 'Sample Saguaro Electric Wholesale', 'Sample Copper State Hardware',
           'Sample Red Mountain Builders Supply', 'Sample Tempe Parts Depot']
CUSTOMERS = ['Sample Palo Verde Dental', 'Sample Agave Property Group', 'Sample Roosevelt Bakery', 'Sample Ironwood Auto Care',
             'Sample Dobson Ranch Church', 'Sample Lehi Self Storage']
HVAC = [('Capacitor 45/5 MFD 440V', 18.5), ('Contactor 2-pole 30A', 24.75), ('Condenser fan motor 1/4 HP', 142.0), ('Filter drier 3/8 flare', 21.3),
        ('Refrigerant R-410A 25 lb cylinder', 189.0), ('Thermostat programmable 7-day', 64.95), ('Line set 3/8 x 3/4 x 25 ft', 118.4),
        ('Condensate pump 115V', 79.5), ('Blower wheel 10x8', 56.2), ('Disconnect box 60A fused', 33.15), ('Copper elbow 3/4 (box of 10)', 27.6),
        ('Run capacitor 35 MFD', 16.4), ('Float switch', 12.85), ('Whip 6 ft 3/4 in', 14.9), ('Pad 36 x 36 composite', 41.0), ('Gas valve 24V', 96.25)]
HARD = [('Interior latex paint 1 gal', 32.99), ('Roller cover 9 in', 6.49), ('Painters tape 1.5 in', 5.79), ('Drywall screws 1 lb', 7.25), ('LED bulb 4-pack', 11.97),
        ('Duct tape', 4.99), ('Work gloves', 9.5), ('Extension cord 25 ft', 18.75), ('Caulk white', 5.35), ('Utility knife blades', 6.2), ('Sandpaper assorted', 8.45)]
LABOR = [('Diagnostic visit', 85.0), ('System start-up and checkout', 140.0), ('Duct repair', 95.0), ('Pad leveling', 70.0), ('Drain line flush', 65.0)]
TENANTS = ['Sample Cactus Cafe', 'Sample Rivera Law', 'Sample Nova Nails', 'Sample Peak Physical Therapy', 'Sample Bright Tutors', 'Sample Mesa Mobile',
           'Sample Orbit Games', 'Sample Terra Dental', 'Sample Vega Insurance', 'Sample Wells Tax Prep', 'Sample Yoga Loft', 'Sample Zen Barber']
SOV = [('Mobilization', 18500), ('Demolition', 42000), ('Concrete footings', 76500), ('Structural steel', 128000), ('Framing', 94000),
       ('Roofing', 61000), ('Mechanical rough-in', 87500), ('Electrical rough-in', 72000), ('Drywall and finish', 58000), ('Flooring', 33500)]

# ------------------------------------------------------------------------------------------------ layout engine
class Page:
    """Collects drawable cells so the SAME layout can be redrawn (handwriting) and gold cell boxes are known."""
    def __init__(self, c, no):
        self.c, self.no, self.cells = c, no, []
    def text(self, x, y, s, size=9.5, bold=False, align='l', tag=None):
        f = 'Helvetica-Bold' if bold else 'Helvetica'
        c = self.c
        c.setFont(f, size)
        w = c.stringWidth(s, f, size)
        x0 = x - w if align == 'r' else x
        c.drawString(x0, H - y, s)
        self.cells.append({'page': self.no, 'x': x0, 'y': y, 'w': w, 'size': size, 'text': s, 'tag': tag, 'bold': bold})
    def rule(self, y, x1=54, x2=558):
        self.c.setLineWidth(0.6); self.c.line(x1, H - y, x2, H - y)

def banner(p, vendor, title, lines):
    p.text(54, 38, 'SAMPLE - synthetic test document, not a real record', 7.5)
    p.text(54, 66, vendor, 15, True)
    p.text(54, 82, '1200 Sample Way, Mesa, AZ 85201', 8.5)
    p.text(558, 66, title, 15, True, 'r')
    y = 100
    for l in lines:
        p.text(558, y, l, 9, align='r'); y += 12

def make_invoice(c, k, rnd, rows_n, tax_rate=0.086, ship=0, disc=0, pages=1, kind='invoice'):
    vendor, cust = VENDORS[k % len(VENDORS)], CUSTOMERS[k % len(CUSTOMERS)]
    pool = HVAC if kind == 'invoice' else HARD
    picks = rnd.sample(pool, min(rows_n, len(pool)))
    while len(picks) < rows_n:
        picks.append(rnd.choice(pool))
    rows = []
    for i, (d, u) in enumerate(picks):
        q = rnd.choice([1, 1, 2, 3, 4, 6, 10, 12]) if kind == 'invoice' else rnd.choice([1, 1, 1, 2, 3])
        if i == 0 and kind == 'invoice': d = d + ('' if rnd.random() < .5 else ' - 5 ton')
        u_c = cents(u); rows.append({'description': d, 'qty': q, 'unit': u_c, 'amount': u_c * q})
    sub = sum(r['amount'] for r in rows)
    tax = int(round(sub * tax_rate)) if kind == 'invoice' else int(round(sub * 0.081))
    tot = sub + tax + cents(ship) - cents(disc)
    num = (4400 if kind == 'invoice' else 7100) + k * 17
    labels = ('Description', 'Qty', 'Unit Price', 'Amount') if kind == 'invoice' else ('Item', 'Qty', 'Price', 'Total')
    per_page = [rows[i:i + math.ceil(len(rows) / pages)] for i in range(0, len(rows), math.ceil(len(rows) / pages))]
    cellpages, gold_rows = [], []
    for pi, chunk in enumerate(per_page):
        p = Page(c, pi + 1)
        banner(p, vendor, 'INVOICE' if kind == 'invoice' else 'RECEIPT',
               [f"{'Invoice' if kind == 'invoice' else 'Receipt'} #: {num}", f"Date: 03/{10 + k:02d}/2026", f"Page {pi + 1} of {len(per_page)}"] )
        p.text(54, 128, 'Bill To: ' + cust if kind == 'invoice' else 'Customer: ' + cust, 9.5)
        y = 160
        p.text(54, y, labels[0], 9.5, True); p.text(340, y, labels[1], 9.5, True, 'r'); p.text(440, y, labels[2], 9.5, True, 'r'); p.text(552, y, labels[3], 9.5, True, 'r')
        p.rule(y + 5); y += 20
        for r in chunk:
            p.text(54, y, r['description'], 9.5, tag=('desc', len(gold_rows)))
            p.text(340, y, str(r['qty']), 9.5, align='r', tag=('qty', len(gold_rows)))
            p.text(440, y, money(r['unit']), 9.5, align='r', tag=('unit', len(gold_rows)))
            p.text(552, y, money(r['amount']), 9.5, align='r', tag=('amount', len(gold_rows)))
            gold_rows.append({'page': pi + 1, 'label': r['description'], 'values': [r['qty'], r['unit'] / 100, r['amount'] / 100]})
            y += 16
        if pi == len(per_page) - 1:
            p.rule(y - 4); y += 12
            def tl(label, val, bold=False):
                nonlocal y
                p.text(440, y, label, 9.5, bold, 'r'); p.text(552, y, val, 9.5, bold, 'r'); y += 15
            tl('Subtotal', money(sub))
            if ship: tl('Shipping', money(cents(ship)))
            if disc: tl('Discount', '-' + money(cents(disc)))
            tl(f'Sales Tax ({tax_rate * 100 if kind == "invoice" else 8.1:.1f}%)', money(tax))
            tl('Total Due' if kind == 'invoice' else 'Total', money(tot), True)
        else:
            p.text(552, y + 10, 'Continued on next page', 8.5, align='r')
        cellpages.append(p); c.showPage()
    gold = {'kind': kind, 'invoice_number': str(num), 'customer_name': cust, 'vendor': vendor, 'cost': f"{tot/100:.2f}"}
    return {'rows': gold_rows, 'totals': {'subtotal': sub / 100, 'tax': tax / 100, 'shipping': ship, 'discount': -disc if disc else 0, 'total': tot / 100}, 'header': gold, 'cellpages': cellpages}

def make_workorder(c, k, rnd):
    vendor, cust = VENDORS[k % len(VENDORS)], CUSTOMERS[(k + 2) % len(CUSTOMERS)]
    parts = [{'description': d, 'qty': rnd.choice([1, 1, 2, 3]), 'unit': cents(u)} for d, u in rnd.sample(HVAC, 5)]
    for r in parts: r['amount'] = r['qty'] * r['unit']
    labor = [{'description': d, 'qty': rnd.choice([1.0, 1.5, 2.0, 2.5, 3.0]), 'unit': cents(u)} for d, u in rnd.sample(LABOR, 3)]
    for r in labor: r['amount'] = int(round(r['qty'] * r['unit']))
    ps, ls = sum(r['amount'] for r in parts), sum(r['amount'] for r in labor)
    tax = int(round(ps * 0.086)); tot = ps + ls + tax
    p = Page(c, 1)
    num = 7300 + k
    banner(p, vendor, 'WORK ORDER', [f'WO #: {num}', f'Date: 04/{5 + k:02d}/2026', 'Status: Completed'])
    p.text(54, 128, 'Customer: ' + cust, 9.5)
    y = 160; gold_rows = []
    p.text(54, y, 'Part / Description', 9.5, True); p.text(340, y, 'Qty', 9.5, True, 'r'); p.text(440, y, 'Unit Price', 9.5, True, 'r'); p.text(552, y, 'Amount', 9.5, True, 'r')
    p.rule(y + 5); y += 20
    for r in parts:
        p.text(54, y, r['description'], 9.5, tag=('desc', len(gold_rows))); p.text(340, y, str(r['qty']), 9.5, align='r', tag=('qty', len(gold_rows)))
        p.text(440, y, money(r['unit']), 9.5, align='r', tag=('unit', len(gold_rows))); p.text(552, y, money(r['amount']), 9.5, align='r', tag=('amount', len(gold_rows)))
        gold_rows.append({'page': 1, 'label': r['description'], 'values': [r['qty'], r['unit'] / 100, r['amount'] / 100]}); y += 16
    p.rule(y - 4); y += 12
    p.text(440, y, 'Parts Subtotal', 9.5, False, 'r'); p.text(552, y, money(ps), 9.5, align='r'); y += 30
    p.text(54, y, 'Labor Description', 9.5, True); p.text(340, y, 'Hours', 9.5, True, 'r'); p.text(440, y, 'Rate', 9.5, True, 'r'); p.text(552, y, 'Amount', 9.5, True, 'r')
    p.rule(y + 5); y += 20
    for r in labor:
        p.text(54, y, r['description'], 9.5, tag=('desc', len(gold_rows))); p.text(340, y, f"{r['qty']:.1f}", 9.5, align='r', tag=('qty', len(gold_rows)))
        p.text(440, y, money(r['unit']), 9.5, align='r', tag=('unit', len(gold_rows))); p.text(552, y, money(r['amount']), 9.5, align='r', tag=('amount', len(gold_rows)))
        gold_rows.append({'page': 1, 'label': r['description'], 'values': [r['qty'], r['unit'] / 100, r['amount'] / 100]}); y += 16
    p.rule(y - 4); y += 12
    p.text(440, y, 'Labor Subtotal', 9.5, False, 'r'); p.text(552, y, money(ls), 9.5, align='r'); y += 20
    p.text(440, y, 'Sales Tax (8.6%)', 9.5, False, 'r'); p.text(552, y, money(tax), 9.5, align='r'); y += 15
    p.text(440, y, 'Total', 9.5, True, 'r'); p.text(552, y, money(tot), 9.5, True, 'r')
    c.showPage()
    return {'rows': gold_rows, 'totals': {'subtotal': (ps + ls) / 100, 'tax': tax / 100, 'total': tot / 100}, 'cellpages': [p],
            'header': {'kind': 'work-order', 'invoice_number': str(num), 'customer_name': cust, 'vendor': vendor, 'cost': f"{tot/100:.2f}"}}

def make_rentroll(c, k, rnd, n):
    prop = ['Sample Palm Court Plaza', 'Sample Hohokam Business Park'][k % 2]
    p = Page(c, 1)
    banner(p, prop, 'RENT ROLL', [f'As of 03/31/2026', 'Prepared for: Sample Agave Property Group'])
    y = 140
    p.text(54, y, 'Unit', 9.5, True); p.text(110, y, 'Tenant', 9.5, True); p.text(380, y, 'Sq Ft', 9.5, True, 'r'); p.text(470, y, 'Monthly Rent', 9.5, True, 'r'); p.text(558, y, 'Past Due', 9.5, True, 'r')
    p.rule(y + 5); y += 20
    tenants = rnd.sample(TENANTS, n); gold_rows = []; sf = rent = due = 0
    for i, t in enumerate(tenants):
        sq = rnd.choice([850, 1200, 1500, 1800, 2400, 3100]); r = cents(sq * rnd.choice([1.5, 1.75, 2.0, 2.25])); pdv = rnd.choice([0, 0, 0, r, cents(125.0)])
        sf += sq; rent += r; due += pdv
        unit = f'{100 + (i + 1) * 5}'
        p.text(54, y, unit, 9.5, tag=('desc', i)); p.text(110, y, t, 9.5, tag=('desc', i)); p.text(380, y, f'{sq:,}', 9.5, align='r', tag=('qty', i))
        p.text(470, y, money(r), 9.5, align='r', tag=('unit', i)); p.text(558, y, money(pdv), 9.5, align='r', tag=('amount', i))
        gold_rows.append({'page': 1, 'label': f'{unit} {t}', 'values': [sq, r / 100, pdv / 100]}); y += 16
    p.rule(y - 4); y += 12
    p.text(54, y, 'TOTAL', 9.5, True); p.text(380, y, f'{sf:,}', 9.5, True, 'r'); p.text(470, y, money(rent), 9.5, True, 'r'); p.text(558, y, money(due), 9.5, True, 'r')
    c.showPage()
    return {'rows': gold_rows, 'totals': {'columns': [sf, rent / 100, due / 100]}, 'cellpages': [p],
            'header': {'kind': 'rent-roll', 'vendor': prop}}

def make_payapp(c, k, rnd, n):
    contractor = ['Sample Ironclad Construction', 'Sample Summit Builders'][k % 2]
    p = Page(c, 1)
    banner(p, contractor, 'APPLICATION FOR PAYMENT', [f'Application No. {k + 3}', 'Period to: 03/31/2026', 'Project: Sample Clinic Remodel'])
    y = 140; xs = [54, 76, 330, 400, 456, 516, 558]
    hdr = ['Item', 'Description of Work', 'Scheduled Value', 'Previous', 'This Period', 'Completed', 'Balance']
    p.text(54, y, 'Item', 8.5, True); p.text(76, y, 'Description of Work', 8.5, True)
    for x, h in zip([260, 330, 392, 460, 558], ['Scheduled Value', 'Previous', 'This Period', 'Completed', 'Balance']):
        p.text(x, y, h, 8.5, True, 'r')
    p.rule(y + 5); y += 20
    items = SOV[:n]; gold_rows = []; sums = [0, 0, 0, 0, 0]
    for i, (d, sv) in enumerate(items):
        prev = cents(sv * rnd.choice([0, .2, .4, .6])); cur = cents(sv * rnd.choice([.1, .2, .3])); sc = sv * 100
        done = prev + cur; bal = sc - done
        vals = [sc, prev, cur, done, bal]
        for j in range(5): sums[j] += vals[j]
        p.text(54, y, str(i + 1), 8.5, tag=('desc', i)); p.text(76, y, d, 8.5, tag=('desc', i))
        for x, v in zip([260, 330, 392, 460, 558], vals): p.text(x, y, f'{v/100:,.2f}', 8.5, align='r', tag=('amount', i))
        gold_rows.append({'page': 1, 'label': f'{i + 1} {d}', 'values': [v / 100 for v in vals]}); y += 16
    p.rule(y - 4); y += 12
    p.text(54, y, 'TOTAL', 8.5, True)
    for x, v in zip([260, 330, 392, 460, 558], sums): p.text(x, y, f'{v/100:,.2f}', 8.5, True, 'r')
    c.showPage()
    return {'rows': gold_rows, 'totals': {'columns': [v / 100 for v in sums]}, 'cellpages': [p], 'header': {'kind': 'pay-application', 'vendor': contractor}}

BASES = []
def build_all():
    r = random.Random(7)
    plan = [
        ('invoice-A', lambda c: make_invoice(c, 0, r, 6)),
        ('invoice-B', lambda c: make_invoice(c, 1, r, 9, ship=45.0)),
        ('invoice-C', lambda c: make_invoice(c, 2, r, 8, disc=25.0)),
        ('invoice-D-2pg', lambda c: make_invoice(c, 3, r, 16, pages=2)),
        ('receipt-A', lambda c: make_invoice(c, 4, r, 6, kind='receipt')),
        ('receipt-B', lambda c: make_invoice(c, 5, r, 9, kind='receipt')),
        ('receipt-C', lambda c: make_invoice(c, 6, r, 5, kind='receipt')),
        ('rentroll-A', lambda c: make_rentroll(c, 0, r, 8)),
        ('rentroll-B', lambda c: make_rentroll(c, 1, r, 10)),
        ('payapp-A', lambda c: make_payapp(c, 0, r, 8)),
        ('payapp-B', lambda c: make_payapp(c, 1, r, 10)),
        ('workorder-A', lambda c: make_workorder(c, 0, r)),
        ('workorder-B', lambda c: make_workorder(c, 1, r)),
        ('workorder-C', lambda c: make_workorder(c, 2, r)),
    ]
    for name, fn in plan:
        path = os.path.join(WORK, 'clean', f'Sample {name}.pdf')
        c = canvas.Canvas(path, pagesize=letter); c.setTitle('Sample ' + name)
        d = fn(c); c.save()
        d['name'] = name; d['pdf'] = path; BASES.append(d)

# ------------------------------------------------------------------------------------------------ degradations
DPI = 150
def rasterize(pdf, dpi=DPI):
    base = pdf[:-4]
    subprocess.run(['pdftoppm', '-r', str(dpi), '-png', pdf, base], check=True)
    out = sorted(f for f in os.listdir(os.path.dirname(pdf)) if f.startswith(os.path.basename(base)) and f.endswith('.png'))
    imgs = [Image.open(os.path.join(os.path.dirname(pdf), f)).convert('RGB') for f in out]
    for f in out: os.remove(os.path.join(os.path.dirname(pdf), f))
    return imgs

def jpeg(img, q):
    import io
    b = io.BytesIO(); img.save(b, 'JPEG', quality=q); b.seek(0); return Image.open(b).convert('RGB')

def persp(img, rr):
    w, h = img.size; a = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    j = lambda m: rr.uniform(0.01, m)
    b = np.float32([[w * j(.05), h * j(.03)], [w * (1 - j(.03)), h * j(.015)], [w * (1 - j(.02)), h * (1 - j(.03))], [w * j(.02), h * (1 - j(.015))]])
    M = cv2.getPerspectiveTransform(a, b)
    return Image.fromarray(cv2.warpPerspective(np.array(img), M, (w, h), borderValue=(88, 82, 76)))

def shadow(img, rr):
    w, h = img.size; a = np.array(img).astype(np.float32)
    xx = np.linspace(0, 1, w)[None, :]; yy = np.linspace(0, 1, h)[:, None]
    ang = rr.uniform(0, math.pi); g = 0.62 + 0.38 * (0.5 + 0.5 * np.cos(ang + 2.4 * (xx * math.cos(ang) + yy * math.sin(ang))))
    return Image.fromarray(np.clip(a * g[..., None], 0, 255).astype(np.uint8))

def noise(img, rr, s=9):
    a = np.array(img).astype(np.float32); n = np.random.RandomState(rr.randint(0, 99999)).normal(0, s, a.shape[:2])[..., None]
    return Image.fromarray(np.clip(a + n, 0, 255).astype(np.uint8))

def rotate(img, deg):
    return img.rotate(deg, resample=Image.BICUBIC, expand=True, fillcolor=(210, 210, 206))

def stain(img, rr):
    w, h = img.size; lay = Image.new('RGBA', img.size, (0, 0, 0, 0)); d = ImageDraw.Draw(lay)
    cx, cy = int(w * rr.uniform(.55, .85)), int(h * rr.uniform(.05, .22)); R = int(w * 0.075)
    for k in range(3):
        o = rr.randint(-6, 6)
        d.ellipse([cx - R + o, cy - R + o, cx + R + o, cy + R + o], outline=(120, 74, 30, 120 - k * 25), width=7 - 2 * k, fill=(150, 100, 52, 38))
    lay = lay.filter(ImageFilter.GaussianBlur(2.2))
    out = Image.alpha_composite(img.convert('RGBA'), lay)
    # a PAID / RECEIVED stamp near the totals, partly crossing the page (tilted, translucent red)
    st = Image.new('RGBA', img.size, (0, 0, 0, 0)); sd = ImageDraw.Draw(st)
    f = ImageFont.truetype('/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf', int(w * 0.055))
    bx, by = int(w * 0.07), int(h * 0.60)
    sd.rounded_rectangle([bx, by, bx + int(w * 0.34), by + int(w * 0.095)], 8, outline=(190, 30, 30, 150), width=5)
    sd.text((bx + int(w * 0.03), by + int(w * 0.018)), 'RECEIVED', font=f, fill=(190, 30, 30, 150))
    st = st.rotate(rr.choice([-9, 8]), resample=Image.BICUBIC, center=(bx, by))
    return Image.alpha_composite(out, st).convert('RGB')

def hand_overwrite(img, base, pageno, rr):
    """Handwriting-style: white out a few cells and write the same value in a jittered italic (qty and one amount per page)."""
    cells = [c for c in base['cellpages'][pageno].cells if c['tag'] and c['tag'][0] in ('qty', 'amount')]
    if not cells: return img
    pick = rr.sample(cells, min(3, len(cells)))
    d = ImageDraw.Draw(img); s = DPI / 72.0
    fp = '/usr/share/fonts/truetype/liberation/LiberationSerif-Italic.ttf'
    for c in pick:
        x0, y1 = c['x'] * s, c['y'] * s; w = c['w'] * s; sz = int(c['size'] * s * 1.32)
        d.rectangle([x0 - 4, y1 - sz * 0.95, x0 + w + 6, y1 + sz * 0.3], fill=(250, 250, 247))
        f = ImageFont.truetype(fp, sz); x = x0
        for ch in c['text']:
            g = Image.new('RGBA', (sz * 2, sz * 2), (0, 0, 0, 0)); gd = ImageDraw.Draw(g)
            gd.text((sz * 0.4, sz * 0.4), ch, font=f, fill=(20, 30, 110, 235))
            g = g.rotate(rr.uniform(-9, 9), resample=Image.BICUBIC)
            img.paste(g, (int(x - sz * 0.4), int(y1 - sz * 1.25 + rr.uniform(-3, 3))), g)
            x += f.getlength(ch) * rr.uniform(.98, 1.1)
    return img

VARIANTS = ['photo', 'lowres', 'rotated', 'stained', 'handwriting']
def degrade(img, variant, base, pageno, rr):
    if variant == 'photo':
        return jpeg(noise(shadow(persp(img, rr).filter(ImageFilter.GaussianBlur(1.1)), rr), rr, 5), 55)
    if variant == 'lowres':
        w, h = img.size; s = img.resize((int(w * 0.64), int(h * 0.64)), Image.BILINEAR)
        return jpeg(noise(s.filter(ImageFilter.GaussianBlur(0.5)), rr, 12), 28)
    if variant == 'rotated':
        return jpeg(noise(rotate(img, rr.choice([-3.6, 4.2])).filter(ImageFilter.GaussianBlur(0.6)), rr, 10), 50)
    if variant == 'stained':
        return jpeg(stain(img, rr).filter(ImageFilter.GaussianBlur(0.5)), 60)
    if variant == 'handwriting':
        return jpeg(hand_overwrite(img.copy(), base, pageno, rr), 70)

# ------------------------------------------------------------------------------------------------ OCR -> layout text
def ocr_layout(path):
    tsv = subprocess.run(['tesseract', path, 'stdout', '--psm', '6', '-c', 'preserve_interword_spaces=1', 'tsv'], capture_output=True, text=True).stdout
    lines = {}
    for row in tsv.splitlines()[1:]:
        f = row.split('\t')
        if len(f) < 12 or f[0] != '5' or not f[11].strip(): continue
        key = (int(f[2]), int(f[3]), int(f[4]))
        lines.setdefault(key, []).append((int(f[6]), int(f[6]) + int(f[8]), int(f[7]), int(f[9]), f[11].strip()))
    out = []
    for key in sorted(lines, key=lambda k: (min(w[2] for w in lines[k]) // 1, k)):
        ws = sorted(lines[key]); txt = ''; last = None
        medh = sorted(w[3] for w in ws)[len(ws) // 2]
        for x1, x2, y, h, t in ws:
            if last is not None:
                gap = x1 - last
                txt += '   ' if gap > 1.6 * medh else ' '
            txt += t; last = x2
        out.append((min(w[2] for w in ws), txt))
    out.sort(key=lambda t: t[0])
    return '\n'.join(t for _, t in out)

def main():
    build_all()
    docs = []
    for base in BASES:
        imgs = rasterize(base['pdf'])
        docs.append({'filename': os.path.basename(base['pdf']), 'source': base['name'], 'variant': 'clean-pdf', 'kind': base['header']['kind'],
                     'gold_rows': base['rows'], 'gold_totals': base['totals'], 'gold': {k: v for k, v in base['header'].items() if k != 'kind'}, 'image': None})
        for vi, v in enumerate(VARIANTS):
            rr = random.Random(f"{base['name']}-{v}")
            pages = []
            outs = []
            for pn, im in enumerate(imgs):
                dg = degrade(im, v, base, pn, rr)
                p = os.path.join(WORK, 'img', f"Sample {base['name']} [{v}] p{pn + 1}.jpg")
                dg.save(p, 'JPEG', quality=60 if v != 'lowres' else 30, optimize=True)
                outs.append(p); pages.append({'page_no': pn + 1, 'text': ocr_layout(p)})
            docs.append({'filename': f"Sample {base['name']} [{v}].jpg", 'source': base['name'], 'variant': v, 'kind': base['header']['kind'], 'route': 'ocr-standin',
                         'pages': pages, 'gold_rows': base['rows'], 'gold_totals': base['totals'], 'gold': {k: v2 for k, v2 in base['header'].items() if k != 'kind'}, 'image': [os.path.basename(x) for x in outs]})
    json.dump({'about': 'Synthetic ("Sample") line-item documents + degraded copies; tesseract word boxes turned into layout text. Never for Donovan training.', 'docs': docs},
              open(os.path.join(WORK, 'tables-raw.json'), 'w'), indent=1)
    print(len(BASES), 'base docs,', len(docs), 'documents')

main()
