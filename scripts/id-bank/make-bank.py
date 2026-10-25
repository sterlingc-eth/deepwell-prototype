#!/usr/bin/env python3
"""Builds the SYNTHETIC people / compliance paperwork regression bank (test-docs/id-bank/).

Every name, number, address, phone and bank detail below is invented. Routing numbers fail the ABA checksum, account numbers are
obviously fake, SSNs sit in the never-issued 9xx range, cards carry a "SYNTHETIC SPECIMEN" footer. Never real documents; never
Donovan training data.

For each of ~60 documents it writes
  files/<id>.<pdf|jpg>     the document the way it arrives: clean text PDF | scanned image-only PDF | phone photo
  truth/<id>.json          ground truth: type (DeepWell id), acceptable types, canonical fields, extra fields, 3-5 questions
and a pages-bank.json cache with the text a reader sees (pdftotext for clean PDFs; tesseract as the stand-in for the paid vision
model on scans and photos, exactly as scripts/real-docs/make-degraded.py does).

usage: python3 scripts/id-bank/make-bank.py [work dir]      (deterministic: seeded)
"""
import json, os, random, subprocess, sys, shutil, datetime as dt
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageEnhance
import numpy as np
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.lib.pagesizes import letter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(ROOT, 'test-docs', 'id-bank')
WORK = sys.argv[1] if len(sys.argv) > 1 else '/tmp/id-bank-work'
for d in ('files', 'truth'):
    shutil.rmtree(os.path.join(OUT, d), ignore_errors=True); os.makedirs(os.path.join(OUT, d))
os.makedirs(WORK, exist_ok=True)
rnd = random.Random(20261025)

F_REG = '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'
F_BOLD = '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'
F_MONO = '/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf'
F_HAND = next((f for f in ['/usr/share/fonts/truetype/freefont/FreeSerifItalic.ttf', '/usr/share/fonts/truetype/freefont/FreeSansOblique.ttf'] if os.path.exists(f)))
font = lambda path, size: ImageFont.truetype(path, size)

# ------------------------------------------------------------------------------------------------ invented people
FIRST = ['Marisol', 'Dwayne', 'Tamsin', 'Oluwaseun', 'Corbin', 'Ilse', 'Rafferty', 'Nadia', 'Hollis', 'Pilar', 'Desmond', 'Yara', 'Emmett', 'Soledad', 'Jarrod',
         'Winona', 'Tobias', 'Lucinda', 'Anselm', 'Brisa', 'Clifton', 'Dalia', 'Everett', 'Fiona', 'Gideon', 'Harlow', 'Imani', 'Joaquin', 'Kestrel', 'Leona',
         'Mateo', 'Noreen', 'Orlando', 'Priya', 'Quentin', 'Rosalba', 'Silas', 'Thalia', 'Ulises', 'Vera', 'Wendell', 'Xiomara', 'Yosef', 'Zelda', 'Abner',
         'Bettina', 'Cyrus', 'Delphine', 'Enrique', 'Farrah', 'Garrett', 'Hana', 'Ignacio', 'Jolene', 'Kendrick', 'Lorna', 'Marcus', 'Nell', 'Osvaldo', 'Paloma']
LAST = ['Quillfeather', 'Barrientos', 'Hollowell', 'Adeyemi', 'Strand', 'Vandermeer', 'Okonkwo-Reyes', 'Castellanos', 'Pemberton', 'Ledesma', 'Thackeray', 'Moreau',
        'Fairbanks', 'Ibarra', 'Nakagawa', 'Whitlock', 'Duarte', 'Lindqvist', 'Marchetti', 'Obregon', 'Penhallow', 'Ruzicka', 'Santibanez', 'Tillman', 'Underhill',
        'Villanueva', 'Wexford', 'Yazzie', 'Zamarripa', 'Ashgrove', 'Brannigan', 'Cordero', 'Dunmore', 'Escalante', 'Fontaine', 'Galvan', 'Hartigan', 'Iglesias',
        'Jernigan', 'Kowalczyk', 'Larkspur', 'Mondragon', 'Nystrom', 'Orteza', 'Prudhomme', 'Quintanilla', 'Rosenthal', 'Sandoval-Pike', 'Trevino', 'Urbina',
        'Valdivia', 'Westbrook', 'Xavier', 'Yoder', 'Zuniga', 'Aldridge', 'Bellweather', 'Crowfoot', 'Dellinger', 'Eckhart']
MIDS = ['A', 'B', 'C', 'D', 'E', 'J', 'L', 'M', 'R', 'T']
STREETS = ['W Palo Brea Ln', 'E Saguaro Vista Dr', 'N Chuparosa Way', 'S Mesquite Hollow Rd', 'W Ironwood Terrace', 'E Cholla Bend Ct', 'N Ocotillo Spur', 'S Verde Alamo Ave',
           'W Sunrise Arroyo St', 'E Tumbleweed Pass']
CITIES = {'AZ': [('Mesa', '85201'), ('Tempe', '85281'), ('Gilbert', '85233')], 'CA': [('Fresno', '93701'), ('Modesto', '95350')], 'TX': [('Waco', '76701'), ('Tyler', '75701')],
          'FL': [('Ocala', '34470'), ('Lakeland', '33801')], 'NY': [('Utica', '13501'), ('Elmira', '14901')], 'OH': [('Akron', '44301'), ('Dayton', '45401')],
          'WA': [('Yakima', '98901'), ('Spokane', '99201')], 'PA': [('Erie', '16501'), ('Altoona', '16601')], 'IL': [('Peoria', '61601'), ('Joliet', '60431')],
          'GA': [('Macon', '31201'), ('Albany', '31701')], 'CO': [('Pueblo', '81001'), ('Greeley', '80631')], 'NV': [('Reno', '89501'), ('Henderson', '89002')]}
_used = set()
def person(state='AZ', packet=None):
    while True:
        f, l = rnd.choice(FIRST), rnd.choice(LAST)
        if (f, l) not in _used: _used.add((f, l)); break
    m = rnd.choice(MIDS)
    city, zp = rnd.choice(CITIES[state])
    return dict(first=f, last=l, mid=m, name=f'{f} {l}', full=f'{f} {m}. {l}', state=state, city=city, zip=zp,
                street=f'{rnd.randint(110, 9890)} {rnd.choice(STREETS)}', phone=f'({rnd.choice(["480", "602", "520", "623"])}) 555-01{rnd.randint(10, 99)}',
                email=f'{f.lower()}.{l.lower().replace("-", "")}@example.com', dob=dt.date(rnd.randint(1962, 2003), rnd.randint(1, 12), rnd.randint(1, 28)),
                ssn=f'987-65-{rnd.randint(1000, 9999)}')
D = lambda y, m, d: dt.date(y, m, d)
def rdate(y0, y1):
    return dt.date(rnd.randint(y0, y1), rnd.randint(1, 12), rnd.randint(1, 28))
def addy(d, years): return dt.date(d.year + years, d.month, d.day)
EMPLOYERS = ['Saguaro Freight Lines', 'Red Mesa Builders', 'Copper State Supply Co', 'Ironwood Cold Storage', 'Blue Agave Catering', 'Kestrel Ridge Plumbing']
NONPROFITS = ['Verde Valley Food Pantry', 'Palo Brea Youth Alliance', 'Desert Bloom Animal Rescue', 'Cottonwood Literacy Project']
TRAINERS = ['Sonoran Safety Training Institute', 'Copperline Safety Academy', 'Arroyo Workforce Training']
MEDEX = ['Dr. Alma Reinholt', 'Dr. Curtis Oyelaran', 'Dr. Priscilla Voss']

def fmt(d, style='mdy'):
    return {'mdy': d.strftime('%m/%d/%Y'), 'dmy': d.strftime('%d %b %Y').upper(), 'iso': d.isoformat(), 'long': d.strftime('%B %d, %Y').replace(' 0', ' '),
            'short': d.strftime('%m/%d/%y')}[style]
def date_variants(d):
    return [d.isoformat(), d.strftime('%m/%d/%Y'), d.strftime('%B %d, %Y').replace(' 0', ' '), d.strftime('%b %d, %Y').replace(' 0', ' '), f'{d.month}/{d.day}/{d.year}',
            d.strftime('%d %b %Y'), d.strftime('%m/%d/%y'), d.strftime('%B %-d, %Y')]

# ------------------------------------------------------------------------------------------------ doc registry
DOCS = []
def add(id, style, kind, type_, ok_types, who, canon, extra, questions, render, pages=1, notes=''):
    """canon = DeepWell field keys expected; extra = other facts printed on the document (checked at the text level only)."""
    DOCS.append(dict(id=id, arrival=style, kind=kind, type=type_, acceptable_types=sorted(set([type_] + ok_types)), person=who['name'] if who else None,
                     fields={k: (v.isoformat() if isinstance(v, dt.date) else v) for k, v in canon.items()},
                     extra={k: (v.isoformat() if isinstance(v, dt.date) else v) for k, v in extra.items()}, questions=questions, render=render, pages=pages, notes=notes))
def Q(q, answer, key, accept=None):
    if isinstance(answer, dt.date): accept = accept or date_variants(answer); answer = answer.isoformat()
    return dict(q=q, answer=answer, key=key, accept=accept or [answer])

# ------------------------------------------------------------------------------------------------ renderers: cards (PIL)
THEMES = {'AZ': ((122, 40, 70), (250, 232, 214)), 'CA': ((24, 74, 140), (232, 240, 250)), 'TX': ((60, 60, 120), (238, 236, 246)), 'FL': ((20, 110, 100), (226, 244, 238)),
          'NY': ((90, 60, 20), (248, 240, 224)), 'OH': ((150, 40, 40), (250, 232, 230)), 'WA': ((20, 90, 60), (226, 242, 232)), 'PA': ((40, 60, 100), (232, 238, 248)),
          'IL': ((100, 30, 100), (244, 230, 246)), 'GA': ((140, 90, 20), (250, 240, 220)), 'CO': ((30, 80, 130), (230, 240, 250)), 'NV': ((30, 100, 150), (232, 242, 250))}
STATE_NAMES = {'AZ': 'ARIZONA', 'CA': 'CALIFORNIA', 'TX': 'TEXAS', 'FL': 'FLORIDA', 'NY': 'NEW YORK', 'OH': 'OHIO', 'WA': 'WASHINGTON', 'PA': 'PENNSYLVANIA', 'IL': 'ILLINOIS', 'GA': 'GEORGIA',
               'CO': 'COLORADO', 'NV': 'NEVADA'}

def draw_card(title_top, title_sub, accent, bg, rows, photo=True, w=1012, h=640, footer='SYNTHETIC SPECIMEN - NOT A REAL DOCUMENT', hdr_h=96):
    """rows: list of (label, value, x, y, size) in card pixels. Returns RGB image."""
    img = Image.new('RGB', (w, h), bg); d = ImageDraw.Draw(img)
    # subtle guilloche-style background lines
    for i in range(0, w, 14): d.line([(i, hdr_h), (i - 120, h)], fill=tuple(min(255, c + 6) for c in bg), width=1)
    d.rectangle([0, 0, w, hdr_h], fill=accent)
    d.text((28, 14), title_top, font=font(F_BOLD, 40), fill=(255, 255, 255)); d.text((30, 62), title_sub, font=font(F_REG, 22), fill=(255, 255, 255))
    if photo:
        d.rectangle([28, hdr_h + 24, 268, hdr_h + 336], fill=(185, 190, 196), outline=(60, 60, 60), width=2)
        d.ellipse([88, hdr_h + 70, 208, hdr_h + 190], fill=(120, 120, 128)); d.rectangle([62, hdr_h + 210, 234, hdr_h + 336], fill=(120, 120, 128))
    for label, value, x, y, size in rows:
        d.text((x, y), label, font=font(F_REG, 15), fill=(70, 70, 80))
        d.text((x, y + 16), value, font=font(F_BOLD, size), fill=(10, 10, 20))
    d.text((28, h - 26), footer, font=font(F_REG, 13), fill=(120, 120, 130))
    d.rectangle([0, 0, w - 1, h - 1], outline=(40, 40, 40), width=3)
    return img

def dl_card(p, st, dln, cls, exp, iss, extra_rows=()):
    acc, bg = THEMES[st]
    rows = [('LN' if st != 'CA' else 'DL', dln, 300, 120, 34), ('DOB', fmt(p['dob']), 300, 205, 26), ('EXP', fmt(exp), 560, 205, 26), ('ISS', fmt(iss), 780, 205, 26),
            ('NAME', f"{p['last'].upper()}, {p['first'].upper()} {p['mid']}", 300, 280, 30), ('ADDRESS', f"{p['street']}", 300, 350, 26),
            ('', f"{p['city'].upper()}, {st} {p['zip']}", 300, 392, 26), ('CLASS', cls, 300, 458, 28), ('SEX', rnd.choice('MF'), 470, 458, 28), ('HGT', f"{rnd.randint(5, 6)}-{rnd.randint(0, 11):02d}", 580, 458, 28),
            ('EYES', rnd.choice(['BRN', 'BLU', 'GRN', 'HAZ']), 720, 458, 28)] + list(extra_rows)
    return draw_card(f'{STATE_NAMES[st]}', 'DRIVER LICENSE' if cls[:1] != 'A' and not cls.startswith('CDL') else 'COMMERCIAL DRIVER LICENSE', acc, bg, rows)

def wallet_card(org, title, rows, accent=(30, 70, 120), bg=(244, 246, 250), photo=False, sub=''):
    return draw_card(org, title if not sub else f'{title}  {sub}', accent, bg, rows, photo=photo, hdr_h=96)

# ------------------------------------------------------------------------------------------------ renderers: forms (reportlab)
class Form:
    """Letter-size form. Value fields are recorded so a handwriting pass can write them over blank boxes."""
    def __init__(self, path, hand=False):
        self.c = rl_canvas.Canvas(path, pagesize=letter); self.hand = hand; self.y = 750; self.pos = []; self.page = 0; self.c.setTitle('form')
    def newpage(self):
        self.c.showPage(); self.page += 1; self.y = 750
    def title(self, t, sub=None, size=17):
        self.c.setFont('Helvetica-Bold', size); self.c.drawString(40, self.y, t); self.y -= size + 4
        if sub:
            self.c.setFont('Helvetica', 9); self.c.drawString(40, self.y, sub); self.y -= 14
        self.c.line(40, self.y, 572, self.y); self.y -= 14
    def section(self, t):
        self.ensure(40); self.c.setFillGray(0.88); self.c.rect(40, self.y - 4, 532, 16, fill=1, stroke=0); self.c.setFillGray(0)
        self.c.setFont('Helvetica-Bold', 10); self.c.drawString(44, self.y, t); self.y -= 24
    def ensure(self, n):
        if self.y < 60 + n: self.newpage()
    def para(self, text, size=9, lead=11.5, width=100):
        import textwrap
        self.c.setFont('Helvetica', size)
        for ln in textwrap.wrap(text, width=width):
            self.ensure(14); self.c.drawString(40, self.y, ln); self.y -= lead
        self.y -= 4
    def row(self, cells):
        """cells: list of (label, value, width). Values are drawn typed, or recorded for handwriting."""
        self.ensure(34); x = 40
        for label, value, w in cells:
            self.c.setFont('Helvetica', 7); self.c.drawString(x + 2, self.y + 3, label.upper())
            self.c.rect(x, self.y - 20, w, 22, stroke=1, fill=0)
            if value not in (None, ''):
                if self.hand: self.pos.append(dict(page=self.page, x=x + 4, y=self.y - 14, w=w - 6, text=str(value)))
                else: self.c.setFont('Helvetica-Bold', 10.5); self.c.drawString(x + 4, self.y - 14, str(value))
            x += w
        self.y -= 36
    def check(self, label, on):
        self.ensure(16); self.c.rect(44, self.y - 2, 9, 9); self.c.setFont('Helvetica', 9); self.c.drawString(60, self.y, label)
        if on:
            if self.hand: self.pos.append(dict(page=self.page, x=44, y=self.y - 1, w=12, text='X'))
            else: self.c.setFont('Helvetica-Bold', 11); self.c.drawString(45, self.y - 1, 'X')
        self.y -= 15
    def line(self): self.y -= 4; self.c.line(40, self.y, 572, self.y); self.y -= 12
    def save(self): self.c.save()

# ------------------------------------------------------------------------------------------------ degradations
def speckle(img, amount=0.01):
    a = np.array(img.convert('L'), dtype=np.uint8); m = np.random.RandomState(rnd.randint(0, 99999)).rand(*a.shape)
    a[m < amount / 2] = 0; a[m > 1 - amount / 2] = 255
    return Image.fromarray(a).convert('RGB')

def gradient_light(img, strength=0.3):
    w, h = img.size; x = np.linspace(0, 1, w)[None, :]; y = np.linspace(0, 1, h)[:, None]
    ang = rnd.uniform(0, 6.28); g = (np.cos(ang) * x + np.sin(ang) * y); g = (g - g.min()) / (g.max() - g.min() + 1e-6)
    f = 1 - strength * g
    return Image.fromarray(np.clip(np.array(img, dtype=float) * f[:, :, None], 0, 255).astype(np.uint8))

def find_coeffs(pa, pb):
    m = []
    for p1, p2 in zip(pa, pb):
        m.append([p1[0], p1[1], 1, 0, 0, 0, -p2[0] * p1[0], -p2[0] * p1[1]]); m.append([0, 0, 0, p1[0], p1[1], 1, -p2[1] * p1[0], -p2[1] * p1[1]])
    return list(np.linalg.solve(np.array(m, dtype=float), np.array(pb, dtype=float).reshape(8)))

def background(w, h):
    base = rnd.choice([(86, 62, 44), (58, 62, 70), (132, 120, 104), (40, 52, 44)])
    arr = np.zeros((h, w, 3), dtype=float) + np.array(base, dtype=float)
    arr += np.random.RandomState(rnd.randint(0, 9999)).randn(h, w, 1) * 9
    for i in range(0, h, rnd.randint(18, 40)): arr[i:i + 2] *= 0.88   # wood-grain / table lines
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))

def glare(img, strength=0.85):
    w, h = img.size; cx, cy = rnd.uniform(0.2, 0.8) * w, rnd.uniform(0.15, 0.7) * h; r = rnd.uniform(0.12, 0.22) * max(w, h)
    yy, xx = np.mgrid[0:h, 0:w]; g = np.exp(-(((xx - cx) / r) ** 2 + ((yy - cy) / (r * 0.6)) ** 2)) * strength
    a = np.array(img, dtype=float); a = a + (255 - a) * g[:, :, None]
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))

def phone_photo(card, canvas_w=1600, canvas_h=1200, scale=0.62, tilt=None):
    """Card (or page) photographed on a table: background, perspective, rotation, uneven light, glare, blur, JPEG."""
    bg = background(canvas_w, canvas_h)
    cw = int(canvas_w * scale); ch = int(card.height * cw / card.width)
    if ch > canvas_h * 0.92: ch = int(canvas_h * 0.9); cw = int(card.width * ch / card.height)
    c = card.resize((cw, ch), Image.LANCZOS); d = lambda: rnd.uniform(0.01, 0.07)
    ox, oy = (canvas_w - cw) // 2 + rnd.randint(-60, 60), (canvas_h - ch) // 2 + rnd.randint(-40, 40)
    src = [(0, 0), (cw, 0), (cw, ch), (0, ch)]
    dst = [(cw * d(), ch * d()), (cw * (1 - d()), ch * d() * 0.6), (cw * (1 - d() * 0.6), ch * (1 - d())), (cw * d() * 0.6, ch * (1 - d() * 0.6))]
    m2 = Image.new('L', c.size, 0); ImageDraw.Draw(m2).polygon(dst, fill=255)
    ang = rnd.uniform(-9, 9) if tilt is None else tilt
    lay = c.transform((cw, ch), Image.PERSPECTIVE, find_coeffs(dst, src), Image.BICUBIC, fillcolor=(0, 0, 0)).convert('RGBA')
    alpha = m2; lay.putalpha(alpha); lay = lay.rotate(ang, resample=Image.BICUBIC, expand=True)
    shadow = Image.new('RGBA', lay.size, (0, 0, 0, 0)); shadow.putalpha(lay.split()[3].point(lambda v: int(v * 0.35)).filter(ImageFilter.GaussianBlur(14)))
    bg = bg.convert('RGBA'); bg.alpha_composite(shadow, (max(0, ox + 10), max(0, oy + 14))); bg.alpha_composite(lay, (max(0, ox - (lay.width - cw) // 2), max(0, oy - (lay.height - ch) // 2)))
    out = gradient_light(bg.convert('RGB'), rnd.uniform(0.2, 0.4)); out = glare(out, rnd.uniform(0.35, 0.8)) if rnd.random() < 0.8 else out
    out = out.filter(ImageFilter.GaussianBlur(rnd.uniform(0.7, 1.4))); out = ImageEnhance.Contrast(out).enhance(rnd.uniform(0.85, 1.05))
    return out

def scan_degrade(img, grey=True, skew=None, res=1.0):
    """Flatbed / copier / phone-scan-app look: skew, grey cast, noise, speckle, a dark scanner edge."""
    if res != 1.0: img = img.resize((int(img.width * res), int(img.height * res)), Image.BILINEAR)
    if grey: img = img.convert('L').convert('RGB')
    ang = skew if skew is not None else rnd.choice([-1, 1]) * rnd.uniform(0.8, 2.6)
    img = img.rotate(ang, resample=Image.BICUBIC, expand=True, fillcolor=(214, 214, 212)).filter(ImageFilter.GaussianBlur(rnd.uniform(0.5, 0.9)))
    a = np.array(img, dtype=float) * rnd.uniform(0.88, 0.96) + np.random.RandomState(rnd.randint(0, 9999)).randn(*np.array(img).shape[:2], 1) * rnd.uniform(6, 14)
    img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)); img = speckle(img, rnd.uniform(0.004, 0.012))
    d = ImageDraw.Draw(img); d.rectangle([0, 0, 5, img.height], fill=(60, 60, 60))
    return img

def img_to_pdf(img, path, dpi=150): img.convert('RGB').save(path, 'PDF', resolution=dpi)

# ------------------------------------------------------------------------------------------------ handwriting overlay
INK = [(24, 36, 100), (20, 20, 24), (30, 60, 130)]
def write_hand(img, pos, scale, ink=None):
    ink = ink or rnd.choice(INK)
    d = img
    for p in pos:
        px, baseline = int(p['x'] * scale), p['ybase']
        size = int(rnd.uniform(15, 18) * scale / 1.0); x = px; maxw = int(p['w'] * scale)
        for ch in p['text']:
            sz = size + rnd.randint(-2, 3); f = font(F_HAND, sz)
            g = Image.new('RGBA', (sz * 2, sz * 2), (0, 0, 0, 0)); ImageDraw.Draw(g).text((sz // 3, sz // 3), ch, font=f, fill=ink + (255,), stroke_width=rnd.choice([0, 0, 1]), stroke_fill=ink + (255,))
            g = g.rotate(rnd.uniform(-10, 10), resample=Image.BICUBIC)
            d.paste(g, (x - sz // 3, baseline - int(sz * 0.9) + rnd.randint(-3, 3)), g)
            x += int(f.getlength(ch) * rnd.uniform(0.9, 1.1)) + rnd.randint(0, 2)
            if x - px > maxw + 25 * scale: break
    return d

# ------------------------------------------------------------------------------------------------ output + OCR
PAGES = {'about': 'Page text for the id-bank documents. clean = text layer (pdftotext, the app reads the text layer); scan/photo = tesseract --psm 4 standing in for the paid vision transcription. Synthetic; never Donovan training.', 'docs': []}
def ocr_img(img_path):
    r = subprocess.run(['tesseract', img_path, 'stdout', '--psm', '4'], capture_output=True, text=True); return r.stdout
def finish(spec, kind, path_pdf=None, img=None, final_pages=None):
    """Write the file the way it arrives and record the reader text."""
    id, style = spec['id'], spec['arrival']
    if style == 'clean':
        fn = f'{id}.pdf'; shutil.copy(path_pdf, os.path.join(OUT, 'files', fn))
        txt = subprocess.run(['pdftotext', '-layout', path_pdf, '-'], capture_output=True, text=True).stdout
        pages = [t.replace('\r', '').rstrip() for t in txt.split('\f')]; pages = [t for i, t in enumerate(pages) if t.strip() or i == 0]
        route = 'text-layer'
    elif style == 'scan':
        fn = f'{id}.pdf'; imgs = final_pages; tmp = []
        for i, im in enumerate(imgs):
            p = os.path.join(WORK, f'{id}_{i}.png'); im.save(p); tmp.append(p)
        imgs[0].convert('RGB').save(os.path.join(OUT, 'files', fn), 'PDF', resolution=150, save_all=True, append_images=[i.convert('RGB') for i in imgs[1:]])
        pages = [ocr_img(p) for p in tmp]; route = 'vision-standin'
    else:
        fn = f'{id}.jpg'; p = os.path.join(OUT, 'files', fn); img.save(p, 'JPEG', quality=rnd.randint(52, 72)); pages = [ocr_img(p)]; route = 'vision-standin'
    PAGES['docs'].append(dict(filename=fn, id=id, route=route, pages=[dict(page_no=i + 1, text=t.rstrip()) for i, t in enumerate(pages)]))
    t = {k: spec[k] for k in ('id', 'arrival', 'kind', 'type', 'acceptable_types', 'person', 'fields', 'extra', 'questions', 'notes')}; t['filename'] = fn
    json.dump(t, open(os.path.join(OUT, 'truth', f'{id}.json'), 'w'), indent=1)

def render_form(spec, build, hand=False):
    """build(form) fills a Form. Clean -> text PDF; scan -> raster + degrade; photo -> raster + phone_photo. hand=True writes values by 'hand'."""
    id, style = spec['id'], spec['arrival']; pdf = os.path.join(WORK, f'{id}.pdf')
    f = Form(pdf, hand=hand or style != 'clean' and False); build(f); f.save()
    if style == 'clean': return finish(spec, 'form', path_pdf=pdf)
    pngs = []
    base = os.path.join(WORK, f'{id}_r'); subprocess.run(['pdftoppm', '-r', '150', '-png', pdf, base], check=True)
    files = sorted(x for x in os.listdir(WORK) if x.startswith(f'{id}_r') and x.endswith('.png'))
    pages = [Image.open(os.path.join(WORK, x)).convert('RGB') for x in files]
    if hand:   # coordinates recorded in PDF points (origin bottom-left) -> pixel baseline
        for p in f.pos:
            pg = pages[p['page']]; p['ybase'] = int(pg.height - p['y'] * 150 / 72)
            pages[p['page']] = write_hand(pg, [p], 150 / 72)
    if style == 'scan':
        out = [scan_degrade(pg, grey=rnd.random() < 0.7) for pg in pages]; return finish(spec, 'form', final_pages=out)
    return finish(spec, 'form', img=phone_photo(pages[0], 1700, 2100, scale=0.78))

def render_card(spec, card):
    style = spec['arrival']
    if style == 'photo': return finish(spec, 'card', img=phone_photo(card))
    if style == 'scan':
        page = Image.new('RGB', (1275, 1650), (255, 255, 255)); c = card.resize((int(card.width * 0.9), int(card.height * 0.9))); page.paste(c, (110, 160))
        return finish(spec, 'card', final_pages=[scan_degrade(page, grey=True)])
    pdf = os.path.join(WORK, spec['id'] + '.pdf'); img_to_pdf(card, pdf, 150); return finish(spec, 'card', path_pdf=pdf)

# ================================================================================================ DOCUMENT DEFINITIONS
SEQ = [0]
def nid(prefix): SEQ[0] += 1; return f'{prefix}-{SEQ[0]:02d}'

# ---- driver licences & CDLs (several state layouts)
def mk_dl(state, style, cdl=False, packet=None):
    p = packet or person(state); exp = rdate(2027, 2031); iss = addy(exp, -8 if not cdl else -4)
    dln = {'AZ': f'D{rnd.randint(10000000, 99999999)}', 'CA': f'I{rnd.randint(1000000, 9999999)}', 'TX': f'{rnd.randint(10000000, 99999999)}',
           'FL': f'{rnd.choice("BCDHKMS")}{rnd.randint(100, 999)}-{rnd.randint(100, 999)}-{rnd.randint(10, 99)}-{rnd.randint(100, 999)}-0',
           'NY': f'{rnd.randint(100, 999)} {rnd.randint(100, 999)} {rnd.randint(100, 999)}', 'OH': f'{rnd.choice(["TG", "RL", "KA"])}{rnd.randint(100000, 999999)}',
           'WA': f'{p["last"][:4].upper().ljust(4, "*")[:4]}{rnd.choice("AB")}{rnd.choice("MJ")}{rnd.randint(100, 999)}{rnd.choice("ZXQ")}{rnd.randint(1, 9)}',
           'PA': f'{rnd.randint(10, 99)} {rnd.randint(100, 999)} {rnd.randint(100, 999)}', 'IL': f'{p["last"][0]}{rnd.randint(100, 999)}-{rnd.randint(1000, 9999)}-{rnd.randint(1000, 9999)}',
           'GA': f'{rnd.randint(100000000, 999999999)}', 'CO': f'{rnd.randint(10, 99)}-{rnd.randint(100000, 999999)}', 'NV': f'{rnd.randint(1000000000, 9999999999)}'}[state]
    cls = rnd.choice(['A', 'B']) if cdl else 'C' if state != 'CA' else 'C'
    cls_txt = f'CLASS {cls}' if not cdl else f'CLASS {cls} CDL'
    end = rnd.choice(['H N', 'T', 'N', 'H T X']) if cdl else rnd.choice(['NONE', 'NONE', 'M'])
    extra_rows = [('END', end, 720, 280 + 0, 22)] if False else []
    rows_extra = [('END', end, 880, 458, 26), ('REST', rnd.choice(['NONE', 'B', 'A']), 880, 350, 22)]
    id = nid(f'dl-{state.lower()}' + ('cdl' if cdl else ''))
    canon = dict(customer_name=p['name'], license_number=dln, end_date=exp, start_date=iss)
    extra = dict(dob=p['dob'], dl_class=cls, state=state, address=p['street'], endorsements=end)
    nm = 'CDL' if cdl else 'driver license'
    qs = [Q(f"When does {p['name']}'s {nm} expire?", exp, 'end_date'), Q(f"What is {p['name']}'s {nm} number?", dln, 'license_number', accept=[dln, dln.replace(' ', ''), dln.replace('-', '')]),
          Q(f"What is {p['name']}'s date of birth?", p['dob'], 'dob'), Q(f"What class is {p['name']}'s {nm}?", f'Class {cls}', 'dl_class', accept=[f'Class {cls}', f'class {cls}'])]
    if cdl: qs.append(Q(f"What endorsements does {p['name']}'s CDL carry?", end, 'endorsements', accept=[end, end.replace(' ', '')]))
    spec = dict(id=id, style=style, p=p)
    add(id, style, 'cdl' if cdl else 'driver-license', 'license-certification', [], p, canon, extra, qs,
        lambda s=None: None)
    DOCS[-1]['_card'] = lambda: dl_card(p, state, dln, cls_txt, exp, iss, rows_extra)
    return p

# ---- DOT medical examiner's certificate (wallet card + certificate + long form)
def mk_med(style, form, packet=None):
    p = packet or person('AZ'); exam = rdate(2025, 2026); months = rnd.choice([12, 24, 24, 3, 6]); exp = exam + dt.timedelta(days=int(months * 30.4))
    ex = rnd.choice(MEDEX); lic = f'AZ-{rnd.randint(100000, 999999)}'; nr = f'{rnd.randint(1000000000, 9999999999)}'
    cdl_no = f'D{rnd.randint(10000000, 99999999)}'; id = nid(f'dotmed-{form}')
    canon = dict(customer_name=p['name'], service_date=exam, end_date=exp, license_number=cdl_no)
    extra = dict(examiner=ex, national_registry=nr, examiner_license=lic, certification_period=f'{months} months', dob=p['dob'])
    qs = [Q(f"When does {p['name']}'s DOT medical card expire?", exp, 'end_date'), Q(f"Who was {p['name']}'s medical examiner?", ex, 'examiner', accept=[ex, ex.replace('Dr. ', '')]),
          Q(f"When was {p['name']}'s DOT physical?", exam, 'service_date'), Q(f"What is the driver license number on {p['name']}'s medical certificate?", cdl_no, 'license_number'),
          Q(f"What is the examiner's national registry number on {p['name']}'s DOT medical certificate?", nr, 'national_registry')]
    add(id, style, 'dot-medical-' + form, 'license-certification', ['hr-letter'], p, canon, extra, qs, None)
    DOCS[-1]['_med'] = dict(p=p, exam=exam, exp=exp, months=months, ex=ex, lic=lic, nr=nr, cdl_no=cdl_no, form=form)
    return p

# ---- HR forms
def mk_i9(style, hand=False):
    p = person('AZ'); emp = rnd.choice(EMPLOYERS); start = rdate(2026, 2026); id = nid('i9')
    docA = rnd.choice([('U.S. Passport', f'A{rnd.randint(10000000, 99999999)}'), ('Permanent Resident Card', f'{rnd.randint(100000000, 999999999)}')])
    canon = dict(customer_name=p['name'], vendor=emp, service_date=start)
    extra = dict(dob=p['dob'], address=p['street'], list_a_document=docA[0], list_a_number=docA[1], ssn=p['ssn'])
    qs = [Q(f"When did {p['name']} start work according to the I-9?", start, 'service_date'), Q(f"What employer is {p['name']}'s I-9 for?", emp, 'vendor'),
          Q(f"What identity document did {p['name']} present for Form I-9?", docA[0], 'list_a_document'), Q(f"What is {p['name']}'s date of birth on the I-9?", p['dob'], 'dob')]
    add(id, style, 'i9', 'hr-letter', ['internal', 'other'], p, canon, extra, qs, None); DOCS[-1]['_i9'] = dict(p=p, emp=emp, start=start, docA=docA, hand=hand)

def mk_w4(style, hand=False):
    p = person('AZ'); emp = rnd.choice(EMPLOYERS); signed = rdate(2026, 2026); id = nid('w4')
    status = rnd.choice(['Single or Married filing separately', 'Married filing jointly', 'Head of household']); dep = rnd.randint(0, 3) * 2000; extra_w = rnd.choice([0, 25, 50])
    canon = dict(customer_name=p['name'], vendor=emp, service_date=signed)
    extra = dict(filing_status=status, dependents_amount=str(dep), extra_withholding=str(extra_w), ssn=p['ssn'], address=p['street'])
    qs = [Q(f"What filing status did {p['name']} choose on the W-4?", status, 'filing_status', accept=[status, status.split(' or ')[0], status.split(' filing')[0]]),
          Q(f"Who is {p['name']}'s employer on the W-4?", emp, 'vendor'), Q(f"When did {p['name']} sign the W-4?", signed, 'service_date'),
          Q(f"How much extra withholding per pay period does {p['name']} want on the W-4?", f'${extra_w}', 'extra_withholding', accept=[f'${extra_w}', f'{extra_w}.00', f' {extra_w} '])]
    add(id, style, 'w4', 'hr-letter', ['internal', 'other'], p, canon, extra, qs, None); DOCS[-1]['_w4'] = dict(p=p, emp=emp, signed=signed, status=status, dep=dep, extra_w=extra_w, hand=hand)

def mk_a4(style, hand=False):
    p = person('AZ'); emp = rnd.choice(EMPLOYERS); signed = rdate(2026, 2026); pct = rnd.choice(['0.5%', '1.0%', '1.5%', '2.0%', '2.7%', '3.6%']); id = nid('az-a4')
    canon = dict(customer_name=p['name'], vendor=emp, service_date=signed)
    extra = dict(withholding_percentage=pct, ssn=p['ssn'], address=p['street'])
    qs = [Q(f"What Arizona withholding percentage did {p['name']} choose on the A-4?", pct, 'withholding_percentage', accept=[pct, pct.replace('%', ''), pct.replace('.0%', '%')]),
          Q(f"Who is {p['name']}'s employer on the Arizona A-4?", emp, 'vendor'), Q(f"When did {p['name']} sign the A-4?", signed, 'service_date')]
    add(id, style, 'az-a4', 'hr-letter', ['internal', 'other'], p, canon, extra, qs, None); DOCS[-1]['_a4'] = dict(p=p, emp=emp, signed=signed, pct=pct, hand=hand)

def mk_newhire(style, hand=False, packet=None):
    p = packet or person('AZ'); emp = rnd.choice(EMPLOYERS); start = rdate(2026, 2026); id = nid('newhire')
    mgr = f'{rnd.choice(FIRST)} {rnd.choice(LAST)}'; pos = rnd.choice(['Delivery Driver', 'Warehouse Associate', 'HVAC Installer', 'Line Cook', 'Dispatcher', 'Yard Jockey']); rate = f'{rnd.randint(17, 36)}.{rnd.choice(["00", "50", "25"])}'
    dept = rnd.choice(['Operations', 'Transportation', 'Field Services', 'Kitchen']); ec = f'{rnd.choice(FIRST)} {rnd.choice(LAST)}'; ecp = f'(480) 555-01{rnd.randint(10, 99)}'
    canon = dict(customer_name=p['name'], vendor=emp, service_date=start, customer_phone=p['phone'], customer_email=p['email'])
    extra = dict(manager=mgr, position=pos, hourly_rate=rate, department=dept, emergency_contact=ec, emergency_phone=ecp, address=p['street'], shirt_size=rnd.choice(['M', 'L', 'XL']))
    qs = [Q(f"Who is {p['name']}'s manager?", mgr, 'manager'), Q(f"What is {p['name']}'s start date?", start, 'service_date'), Q(f"What position was {p['name']} hired for?", pos, 'position'),
          Q(f"What is {p['name']}'s hourly rate?", f'${rate}', 'hourly_rate', accept=[f'${rate}', rate]), Q(f"Who is {p['name']}'s emergency contact?", ec, 'emergency_contact')]
    add(id, style, 'newhire-' + ('handwritten' if hand else 'typed'), 'hr-letter', ['internal', 'other'], p, canon, extra, qs, None)
    DOCS[-1]['_nh'] = dict(p=p, emp=emp, start=start, mgr=mgr, pos=pos, rate=rate, dept=dept, ec=ec, ecp=ecp, hand=hand, packet=packet is not None)

def bad_routing():
    while True:
        r = ''.join(rnd.choice('0123456789') for _ in range(9)); s = sum(int(r[i]) * [3, 7, 1][i % 3] for i in range(9))
        if s % 10 != 0: return r
def mk_dd(style, hand=False):
    p = person('AZ'); emp = rnd.choice(EMPLOYERS); signed = rdate(2026, 2026); id = nid('directdeposit'); bank = rnd.choice(['Example Community Credit Union', 'Sample Desert Bank', 'Test Saguaro Savings'])
    routing = bad_routing(); acct = f'00{rnd.randint(10000000, 99999999)}'; typ = rnd.choice(['Checking', 'Savings'])
    canon = dict(customer_name=p['name'], vendor=emp, service_date=signed)
    extra = dict(bank=bank, routing_number=routing, account_number=acct, account_type=typ)
    qs = [Q(f"What bank does {p['name']} use for direct deposit?", bank, 'bank'), Q(f"What is the routing number on {p['name']}'s direct deposit form?", routing, 'routing_number'),
          Q(f"What is {p['name']}'s direct deposit account number?", acct, 'account_number'), Q(f"Is {p['name']}'s direct deposit account checking or savings?", typ, 'account_type')]
    add(id, style, 'direct-deposit', 'hr-letter', ['internal', 'statement', 'other'], p, canon, extra, qs, None); DOCS[-1]['_dd'] = dict(p=p, emp=emp, signed=signed, bank=bank, routing=routing, acct=acct, typ=typ, hand=hand)

def mk_bg(style):
    p = person('AZ'); co = rnd.choice(EMPLOYERS); signed = rdate(2026, 2026); id = nid('bgcheck'); agency = rnd.choice(['Example Screening Services', 'Sample Verified Background LLC', 'Test Applicant Check Inc'])
    canon = dict(customer_name=p['name'], vendor=co, service_date=signed)
    extra = dict(agency=agency, dob=p['dob'], ssn=p['ssn'], address=p['street'])
    qs = [Q(f"When did {p['name']} sign the background check consent?", signed, 'service_date'), Q(f"Which company is requesting a background check on {p['name']}?", co, 'vendor'),
          Q(f"Which screening agency will run {p['name']}'s background check?", agency, 'agency')]
    add(id, style, 'background-consent', 'hr-letter', ['agreement', 'other'], p, canon, extra, qs, None); DOCS[-1]['_bg'] = dict(p=p, co=co, signed=signed, agency=agency)

def mk_vol(style, hand=False):
    p = person('AZ'); org = rnd.choice(NONPROFITS); signed = rdate(2026, 2026); id = nid('volunteer')
    role = rnd.choice(['Food sorting', 'Youth mentor', 'Kennel assistant', 'Reading tutor', 'Event setup']); avail = rnd.choice(['Saturday mornings', 'Weekday evenings', 'Tuesday and Thursday afternoons'])
    ref = f'{rnd.choice(FIRST)} {rnd.choice(LAST)}'; skills = rnd.choice(['Spanish bilingual', 'Forklift certified', 'First aid / CPR', 'Spreadsheet skills'])
    canon = dict(customer_name=p['name'], vendor=org, service_date=signed, customer_phone=p['phone'], customer_email=p['email'])
    extra = dict(role=role, availability=avail, reference=ref, skills=skills, address=p['street'])
    qs = [Q(f"What volunteer role did {p['name']} apply for?", role, 'role'), Q(f"When is {p['name']} available to volunteer?", avail, 'availability'), Q(f"Who is {p['name']}'s volunteer reference?", ref, 'reference'),
          Q(f"Which organization did {p['name']} apply to volunteer with?", org, 'vendor'), Q(f"What is {p['name']}'s phone number on the volunteer application?", p['phone'], 'customer_phone', accept=[p['phone'], p['phone'].replace('(', '').replace(') ', '-')])]
    add(id, style, 'volunteer-application-' + ('handwritten' if hand else 'typed'), 'hr-letter', ['agreement', 'other', 'internal'], p, canon, extra, qs, None); DOCS[-1]['_vol'] = dict(p=p, org=org, signed=signed, role=role, avail=avail, ref=ref, skills=skills, hand=hand)

# ---- training cards
def mk_card(kind, style):
    p = person('AZ'); org = rnd.choice(TRAINERS); iss = rdate(2024, 2026); id = nid(kind)
    if kind == 'cpr': years, title, num = 2, rnd.choice(['CPR / AED / First Aid', 'Adult CPR and First Aid']), f'CPR-{rnd.randint(100000, 999999)}'
    elif kind == 'forklift': years, title, num = 3, 'Powered Industrial Truck Operator', f'PIT-{rnd.randint(10000, 99999)}'
    else: years, title, num = 0, 'OSHA 10-Hour Construction Outreach', f'{rnd.randint(10, 99)}-{rnd.randint(1000000, 9999999)}'
    exp = addy(iss, years) if years else None
    canon = dict(customer_name=p['name'], license_number=num, start_date=iss, vendor=org);
    if exp: canon['end_date'] = exp
    extra = dict(course=title, issuer=org)
    nm = {'cpr': 'CPR card', 'forklift': 'forklift certification', 'osha10': 'OSHA-10 card'}[kind]
    qs = [Q(f"What is {p['name']}'s {nm} number?", num, 'license_number'), Q(f"Who issued {p['name']}'s {nm}?", org, 'vendor'), Q(f"When was {p['name']}'s {nm} issued?", iss, 'start_date')]
    if exp: qs.insert(0, Q(f"When does {p['name']}'s {nm} expire?", exp, 'end_date'))
    else: qs.append(Q(f"Does {p['name']}'s OSHA-10 card expire?", 'No', 'no_expiry', accept=['does not expire', 'no expiration', 'never expires', 'no expiry', 'not expire']))
    add(id, style, kind + '-card', 'license-certification', [], p, canon, extra, qs, None); DOCS[-1]['_tc'] = dict(p=p, org=org, iss=iss, exp=exp, title=title, num=num, kind=kind)

# ---- vehicle registration / insurance
def mk_reg(style):
    st = rnd.choice(['AZ', 'TX', 'CA', 'FL']); p = person(st); iss = rdate(2025, 2026); exp = addy(iss, 1); id = nid('vehreg'); plate = f'{rnd.choice(["ABC", "XJK", "RTL", "NMQ"])}{rnd.randint(1000, 9999)}'
    vin = ''.join(rnd.choice('ABCDEFGHJKLMNPRSTUVWXYZ0123456789') for _ in range(17)); veh = rnd.choice([('2019', 'Ford', 'F-150'), ('2021', 'Toyota', 'Tacoma'), ('2017', 'Chevrolet', 'Silverado'), ('2022', 'Ram', '2500')])
    canon = dict(customer_name=p['name'], end_date=exp, start_date=iss)
    extra = dict(plate=plate, vin=vin, year=veh[0], make=veh[1], model=veh[2], state=st)
    qs = [Q(f"When does {p['name']}'s vehicle registration expire?", exp, 'end_date'), Q(f"What is the license plate on {p['name']}'s registration?", plate, 'plate'), Q(f"What is the VIN on {p['name']}'s vehicle registration?", vin, 'vin'),
          Q(f"What vehicle is registered to {p['name']}?", f'{veh[0]} {veh[1]} {veh[2]}', 'vehicle', accept=[f'{veh[1]} {veh[2]}', f'{veh[1].lower()} {veh[2].lower()}'])]
    add(id, style, 'vehicle-registration', 'license-certification', ['other', 'internal'], p, canon, extra, qs, None); DOCS[-1]['_reg'] = dict(p=p, st=st, iss=iss, exp=exp, plate=plate, vin=vin, veh=veh)

def mk_ins(style):
    st = rnd.choice(['AZ', 'NV', 'CA']); p = person(st); eff = rdate(2026, 2026); exp = eff + dt.timedelta(days=182); id = nid('insurance-id'); co = rnd.choice(['Example Mutual Auto', 'Sample State Casualty', 'Test Desert Insurance Co'])
    naic = str(rnd.randint(10000, 99999)); pol = f'{rnd.choice(["AZ", "PA", "KV"])}{rnd.randint(100000000, 999999999)}'; vin = ''.join(rnd.choice('ABCDEFGHJKLMNPRSTUVWXYZ0123456789') for _ in range(17)); veh = rnd.choice([('2020', 'Honda', 'Accord'), ('2018', 'Subaru', 'Outback'), ('2023', 'Ford', 'Transit')])
    canon = dict(customer_name=p['name'], policy_number=pol, start_date=eff, end_date=exp, vendor=co)
    extra = dict(vin=vin, year=veh[0], make=veh[1], model=veh[2], naic=naic)
    qs = [Q(f"What is {p['name']}'s auto insurance policy number?", pol, 'policy_number'), Q(f"When does {p['name']}'s auto insurance expire?", exp, 'end_date'), Q(f"Who insures {p['name']}'s vehicle?", co, 'vendor'),
          Q(f"When does {p['name']}'s insurance coverage start?", eff, 'start_date')]
    add(id, style, 'insurance-id-card', 'insurance-certificate', ['license-certification', 'other'], p, canon, extra, qs, None); DOCS[-1]['_ins'] = dict(naic=naic, p=p, eff=eff, exp=exp, co=co, pol=pol, vin=vin, veh=veh)

# ================================================================================================ plan (60 documents)
# driver packets: the same person has a CDL, a DOT medical card and a new-hire sheet (the way a hiring file really looks)
PK = [person('AZ') for _ in range(4)]
for st, sty in [('AZ', 'photo'), ('CA', 'photo'), ('TX', 'scan'), ('FL', 'photo'), ('NY', 'photo'), ('IL', 'photo'), ('CO', 'scan'), ('NV', 'photo')]: mk_dl(st, sty)
for st, sty in [('OH', 'photo'), ('WA', 'scan'), ('PA', 'photo'), ('GA', 'scan')]: mk_dl(st, sty, cdl=True)
mk_dl('AZ', 'photo', cdl=True, packet=PK[0]); mk_dl('TX', 'scan', cdl=True, packet=PK[1]); mk_dl('AZ', 'photo', packet=PK[2]); mk_dl('AZ', 'scan', cdl=True, packet=PK[3])
mk_med('photo', 'card', PK[0]); mk_med('scan', 'card', PK[1]); mk_med('clean', 'cert', PK[2]); mk_med('clean', 'long'); mk_med('scan', 'long', PK[3]); mk_med('photo', 'card')
for sty, hd in [('clean', False), ('scan', False), ('scan', True)]: mk_i9(sty, hd)
for sty, hd in [('clean', False), ('scan', False), ('photo', False)]: mk_w4(sty, hd)
for sty, hd in [('clean', False), ('scan', True)]: mk_a4(sty, hd)
mk_newhire('clean'); mk_newhire('clean', packet=PK[0]); mk_newhire('scan', hand=True, packet=PK[1]); mk_newhire('scan', hand=True); mk_newhire('photo', hand=True); mk_newhire('photo', hand=True, packet=PK[2])
mk_dd('clean'); mk_dd('scan'); mk_dd('photo', hand=True)
for sty in ['clean', 'clean', 'scan']: mk_bg(sty)
for k, sty in [('cpr', 'photo'), ('cpr', 'clean'), ('cpr', 'scan'), ('forklift', 'photo'), ('forklift', 'photo'), ('forklift', 'clean'), ('osha10', 'photo'), ('osha10', 'photo'), ('osha10', 'scan')]: mk_card(k, sty)
for sty in ['clean', 'photo', 'scan']: mk_reg(sty)
for sty in ['clean', 'clean', 'photo']: mk_ins(sty)
for sty, hd in [('clean', False), ('scan', False), ('photo', True), ('scan', True)]: mk_vol(sty, hd)

# ================================================================================================ rendering
def R(spec):
    sty, id = spec['arrival'], spec['id']
    if '_card' in spec: return render_card(spec, spec['_card']())
    if '_tc' in spec and sty == 'clean':
        t = spec['_tc']; p = t['p']
        def b(f):
            f.title(t['org'], {'cpr': 'Certificate of Completion - CPR / AED / First Aid', 'forklift': 'Powered Industrial Truck Operator Certificate', 'osha10': 'OSHA 10-Hour Outreach Training Completion Card'}[t['kind']])
            f.row([('Name', p['name'].upper(), 300), ('Card / certificate no.', t['num'], 232)])
            f.row([('Course', t['title'], 300), ('Date issued', fmt(t['iss']), 120), ('Expires', fmt(t['exp']) if t['exp'] else 'NO EXPIRATION', 112)])
            f.row([('Issued by', t['org'], 300), ('Instructor', f'{rnd.choice(FIRST)} {rnd.choice(LAST)}', 232)])
            f.para('The holder has completed the classroom and practical evaluation required for this certification. (SYNTHETIC SPECIMEN - NOT A REAL DOCUMENT)')
        return render_form(spec, b)
    if '_tc' in spec:
        t = spec['_tc']; p = t['p']
        rows = [('NAME', p['name'].upper(), 40, 130, 34), ('COURSE', t['title'], 40, 215, 26), ('CARD NO.', t['num'], 40, 300, 30), ('ISSUED', fmt(t['iss']), 40, 390, 28)]
        rows.append(('EXPIRES', fmt(t['exp']) if t['exp'] else 'NO EXPIRATION', 420, 390, 28))
        rows.append(('ISSUED BY', t['org'], 40, 480, 24))
        accent = {'cpr': (170, 30, 40), 'forklift': (200, 120, 0), 'osha10': (30, 90, 60)}[t['kind']]
        card = draw_card(t['org'].upper(), {'cpr': 'CERTIFICATION CARD', 'forklift': 'OPERATOR EVALUATION CARD', 'osha10': 'DEPARTMENT OF LABOR  OSHA OUTREACH TRAINING'}[t['kind']], accent, (248, 248, 244), rows, photo=False)
        return render_card(spec, card)
    if '_ins' in spec and sty != 'clean' or ('_ins' in spec and False):
        i = spec['_ins']; p = i['p']
        rows = [('POLICY NUMBER', i['pol'], 40, 120, 30), ('NAMED INSURED', p['name'].upper(), 40, 200, 28), ('EFFECTIVE', fmt(i['eff']), 40, 280, 26), ('EXPIRES', fmt(i['exp']), 330, 280, 26),
                ('VEHICLE', f"{i['veh'][0]} {i['veh'][1].upper()} {i['veh'][2].upper()}", 40, 360, 26), ('VIN', i['vin'], 40, 440, 26), ('INSURER', i['co'], 40, 520, 24)]
        return render_card(spec, draw_card(i['co'].upper(), 'AUTO INSURANCE ID CARD', (20, 70, 110), (240, 246, 250), rows, photo=False))
    if '_med' in spec and spec['_med']['form'] == 'card':
        m = spec['_med']; p = m['p']
        rows = [('DRIVER NAME', p['name'].upper(), 40, 120, 30), ('DRIVER LICENSE NO.', m['cdl_no'], 40, 200, 28), ('MEDICAL EXAMINER', m['ex'].upper(), 40, 280, 26), ('EXAMINER NATIONAL REGISTRY NO.', m['nr'], 40, 355, 26),
                ('DATE OF EXAMINATION', fmt(m['exam']), 40, 430, 28), ('MEDICAL CERTIFICATE EXPIRES', fmt(m['exp']), 400, 430, 28), ('', 'MEETS FMCSA STANDARDS (49 CFR 391.43)  -  NON-EXCEPTED INTERSTATE', 40, 510, 20)]
        return render_card(spec, draw_card('MEDICAL EXAMINER\'S CERTIFICATE', 'U.S. DEPARTMENT OF TRANSPORTATION  -  FMCSA', (20, 50, 100), (252, 252, 246), rows, photo=False))
    # forms
    if '_med' in spec:
        m = spec['_med']; p = m['p']
        def b(f):
            if m['form'] == 'cert':
                f.title("Medical Examiner's Certificate", 'U.S. Department of Transportation - Federal Motor Carrier Safety Administration  (Form MCSA-5876)')
                f.para(f"I certify that I have examined {p['full']} in accordance with the Federal Motor Carrier Safety Regulations (49 CFR 391.41-391.49) and with knowledge of the driving duties, I find this person is qualified under the regulations.", width=100)
                f.row([("Driver's name", p['full'], 266), ("Driver's license no.", m['cdl_no'], 150), ('State', 'AZ', 116)])
                f.row([("Driver's address", f"{p['street']}, {p['city']}, AZ {p['zip']}", 380), ('Date of birth', fmt(p['dob']), 152)])
                f.check('Qualified only for 2 years', m['months'] == 24); f.check('Qualified only for 1 year', m['months'] == 12); f.check('Qualified for 3 months only', m['months'] == 3); f.check('Qualified for 6 months only', m['months'] == 6)
                f.row([("Medical examiner's name", m['ex'], 266), ("Examiner's telephone", '(480) 555-0141', 266)])
                f.row([('Medical examiner license no. and state', m['lic'], 266), ('National Registry no.', m['nr'], 266)])
                f.row([('Date of examination', fmt(m['exam']), 200), ('Medical certificate expiration date', fmt(m['exp']), 332)])
            else:
                f.title("Medical Examination Report for Commercial Driver Medical Certification", 'Form MCSA-5875  -  OMB No. 2126-0006', 15)
                f.section('Section 1. Driver Information (to be completed by the driver)')
                f.row([('Driver name (last, first, middle)', f"{p['last']}, {p['first']} {p['mid']}", 300), ('Date of birth', fmt(p['dob']), 110), ('Phone', p['phone'], 122)])
                f.row([('Address', f"{p['street']}, {p['city']}, AZ {p['zip']}", 340), ("Driver's license no.", m['cdl_no'], 110), ('State', 'AZ', 82)])
                f.row([('Date of examination', fmt(m['exam']), 180), ('Employer', rnd.choice(EMPLOYERS), 352)])
                f.section('Section 2. Health History')
                for cond in ['Head/brain injuries or illnesses', 'Seizures, epilepsy', 'Eye disorders or impaired vision', 'Ear disorders, loss of hearing', 'Heart disease or heart attack', 'High blood pressure', 'Diabetes treated with insulin', 'Sleep disorders, pauses in breathing']:
                    f.check(f'{cond}  -  NO', True)
                f.newpage() if f.y < 330 else None
                f.section('Section 3. Testing (to be completed by the medical examiner)')
                f.row([('Vision right (corrected)', '20/20', 130), ('Vision left (corrected)', '20/25', 130), ('Hearing (forced whisper)', 'PASS', 130), ('Blood pressure', f'{rnd.randint(112, 138)}/{rnd.randint(70, 88)}', 142)])
                f.row([('Pulse rate', str(rnd.randint(58, 88)), 130), ('Urinalysis specific gravity', '1.015', 130), ('Protein', 'neg', 130), ('Blood / Sugar', 'neg / neg', 142)])
                f.section('Section 4. Medical Examiner Certification')
                f.para("I certify that I have examined the driver and that I have completed the Medical Examination Report in accordance with the Federal Motor Carrier Safety Regulations. The driver meets the physical qualification standards in 49 CFR 391.41.")
                f.row([("Medical examiner's name", m['ex'], 266), ('Examiner license no. / state', m['lic'], 160), ('National Registry no.', m['nr'], 106)])
                f.row([('Date of examination', fmt(m['exam']), 180), ('Certification period', f"{m['months']} months", 160), ('Medical certificate expires', fmt(m['exp']), 192)])
        return render_form(spec, b)
    if '_i9' in spec:
        i = spec['_i9']; p = i['p']
        def b(f):
            f.title('Employment Eligibility Verification', 'Form I-9  -  Department of Homeland Security, U.S. Citizenship and Immigration Services  -  OMB No. 1615-0047', 15)
            f.section('Section 1. Employee Information and Attestation (employees must complete and sign Section 1 no later than the first day of employment)')
            f.row([('Last name (family name)', p['last'], 180), ('First name (given name)', p['first'], 180), ('Middle initial', p['mid'], 60), ('Other last names used', 'N/A', 112)])
            f.row([('Address (street number and name)', p['street'], 250), ('City or town', p['city'], 130), ('State', 'AZ', 50), ('ZIP code', p['zip'], 102)])
            f.row([('Date of birth (mm/dd/yyyy)', fmt(p['dob']), 160), ('U.S. social security number', p['ssn'], 140), ("Employee's email address", p['email'], 232)])
            f.check('1. A citizen of the United States', True); f.check('2. A noncitizen national of the United States', False); f.check('3. A lawful permanent resident', False)
            f.section('Section 2. Employer Review and Verification')
            f.row([('List A - Document title', i['docA'][0], 266), ('Document number', i['docA'][1], 150), ('Expiration date', 'N/A', 116)])
            f.row([("First day of employment (mm/dd/yyyy)", fmt(i['start']), 200), ('Employer business or organization name', i['emp'], 332)])
            f.row([('Last name, first name and title of employer representative', f'{rnd.choice(LAST)}, {rnd.choice(FIRST)} - HR Manager', 400), ('Today\'s date', fmt(i['start']), 132)])
        return render_form(spec, b, hand=i['hand'])
    if '_w4' in spec:
        w = spec['_w4']; p = w['p']
        def b(f):
            f.title("Form W-4  Employee's Withholding Certificate", 'Department of the Treasury - Internal Revenue Service  -  Complete Form W-4 so that your employer can withhold the correct federal income tax from your pay.', 15)
            f.section('Step 1: Enter Personal Information')
            f.row([('(a) First name and middle initial', f"{p['first']} {p['mid']}", 220), ('Last name', p['last'], 160), ('(b) Social security number', p['ssn'], 152)])
            f.row([('Address', p['street'], 300), ('City or town, state, and ZIP code', f"{p['city']}, AZ {p['zip']}", 232)])
            f.check('(c) Single or Married filing separately', w['status'].startswith('Single')); f.check('Married filing jointly or Qualifying surviving spouse', w['status'].startswith('Married')); f.check('Head of household', w['status'].startswith('Head'))
            f.section('Steps 2-4 (optional)')
            f.row([('Step 3: Claim dependents - total amount', f"${w['dep']:,}", 200), ('Step 4(c): Extra withholding per pay period', f"${w['extra_w']}", 200)])
            f.section('Step 5: Sign Here')
            f.row([("Employee's signature", p['full'], 330), ('Date', fmt(w['signed']), 202)])
            f.section('Employers Only')
            f.row([("Employer's name and address", f"{w['emp']}, 4200 W Example Blvd, {p['city']}, AZ {p['zip']}", 400), ('Employer identification number (EIN)', '00-0000000', 132)])
        return render_form(spec, b, hand=w['hand'])
    if '_a4' in spec:
        a = spec['_a4']; p = a['p']
        def b(f):
            f.title("Arizona Form A-4  Employee's Arizona Withholding Election", 'Arizona Department of Revenue  -  Choose the percentage of gross taxable wages to be withheld for Arizona income tax.', 15)
            f.row([('Employee name', p['full'], 266), ('Social security number', p['ssn'], 266)])
            f.row([('Home address', f"{p['street']}, {p['city']}, AZ {p['zip']}", 400), ('Employer', a['emp'], 132)])
            f.para('Check the box for the percentage of gross taxable wages to withhold:')
            for pc in ['0.5%', '1.0%', '1.5%', '2.0%', '2.5%', '3.0%', '3.5%']:
                f.check(f'{pc} of gross taxable wages' + ('' if pc != a['pct'] else '') , pc == a['pct'])
            if a['pct'] not in ['0.5%', '1.0%', '1.5%', '2.0%', '2.5%', '3.0%', '3.5%']: f.row([('Other percentage selected', a['pct'], 200)])
            f.row([('Employee signature', p['full'], 330), ('Date', fmt(a['signed']), 202)])
        return render_form(spec, b, hand=a['hand'])
    if '_nh' in spec:
        n = spec['_nh']; p = n['p']
        def b(f):
            f.title(f"{n['emp']}  -  New Hire Information Sheet", 'Please print clearly. Return to HR on your first day.')
            f.section('Employee')
            f.row([('Full name', p['full'], 300), ('Phone', p['phone'], 232)])
            f.row([('Home address', f"{p['street']}, {p['city']}, AZ {p['zip']}", 300), ('Email', p['email'], 232)])
            f.row([('Position', n['pos'], 200), ('Department', n['dept'], 160), ('Start date', fmt(n['start']), 172)])
            f.row([('Reports to / Manager', n['mgr'], 266), ('Hourly rate', f"${n['rate']}", 120), ('Shirt size', 'L', 146)])
            f.section('Emergency contact')
            f.row([('Contact name', n['ec'], 300), ('Contact phone', n['ecp'], 232)])
            f.section('Paperwork received')
            for item in ['I-9 completed', 'W-4 completed', 'AZ A-4 completed', 'Direct deposit form']: f.check(item, True)
        return render_form(spec, b, hand=n['hand'])
    if '_dd' in spec:
        d = spec['_dd']; p = d['p']
        def b(f):
            f.title('Direct Deposit Authorization Form', f"{d['emp']}  -  Payroll Department")
            f.para('I authorize the employer named above to deposit my net pay into the account listed below. This authorization remains in effect until I cancel it in writing. (SAMPLE FORM - routing and account numbers are invented and invalid.)')
            f.row([('Employee name', p['full'], 300), ('Date', fmt(d['signed']), 232)])
            f.row([('Bank name', d['bank'], 300), ('Account type', d['typ'], 232)])
            f.row([('ABA routing number (9 digits)', d['routing'], 266), ('Account number', d['acct'], 266)])
            f.row([('Employee signature', p['full'], 300), ('Phone', p['phone'], 232)])
        return render_form(spec, b, hand=d['hand'])
    if '_bg' in spec:
        g = spec['_bg']; p = g['p']
        def b(f):
            f.title('Disclosure and Authorization for Background Check', f"{g['co']}  -  Human Resources")
            f.para(f"{g['co']} may obtain a consumer report and/or investigative consumer report about you for employment purposes from {g['agency']}. This disclosure is provided under the Fair Credit Reporting Act. The report may contain information about your criminal history, driving record, employment history and education.", width=98)
            f.para('By signing below I authorize the company and its agents to conduct a background investigation and I understand I may request a copy of any report. (SAMPLE FORM, invented data.)', width=98)
            f.row([('Applicant full name', p['full'], 300), ('Date of birth', fmt(p['dob']), 232)])
            f.row([('Social security number', p['ssn'], 200), ('Current address', f"{p['street']}, {p['city']}, AZ", 332)])
            f.row([('Applicant signature', p['full'], 300), ('Date signed', fmt(g['signed']), 232)])
        return render_form(spec, b)
    if '_vol' in spec:
        v = spec['_vol']; p = v['p']
        def b(f):
            f.title(f"{v['org']}  -  Volunteer Application", 'Thank you for offering your time. All volunteers 18 and over complete this form.')
            f.row([('Name', p['full'], 266), ('Phone', p['phone'], 266)])
            f.row([('Address', f"{p['street']}, {p['city']}, AZ {p['zip']}", 300), ('Email', p['email'], 232)])
            f.row([('Volunteer role of interest', v['role'], 266), ('Availability', v['avail'], 266)])
            f.row([('Skills / certifications', v['skills'], 532)])
            f.row([('Reference name', v['ref'], 266), ('Reference phone', f'(480) 555-01{rnd.randint(10, 99)}', 266)])
            f.check('I have never been convicted of a crime against a child', True)
            f.row([('Applicant signature', p['full'], 300), ('Date', fmt(v['signed']), 232)])
        return render_form(spec, b, hand=v['hand'])
    if '_reg' in spec:
        r = spec['_reg']; p = r['p']
        def b(f):
            f.title(f"{STATE_NAMES[r['st']].title()} Vehicle Registration", f"{STATE_NAMES[r['st']].title()} Motor Vehicle Division  -  Registration Receipt (keep in vehicle)")
            f.row([('Registered owner', p['full'], 300), ('License plate', r['plate'], 232)])
            f.row([('Owner address', f"{p['street']}, {p['city']}, {r['st']} {p['zip']}", 400), ('Plate type', 'PASSENGER', 132)])
            f.row([('Year', r['veh'][0], 80), ('Make', r['veh'][1], 160), ('Model', r['veh'][2], 160), ('Body', 'PK', 132)])
            f.row([('Vehicle identification number (VIN)', r['vin'], 300), ('Fee paid', '$ 152.40', 232)])
            f.row([('Registration issued', fmt(r['iss']), 266), ('Registration expires', fmt(r['exp']), 266)])
        return render_form(spec, b)
    if '_ins' in spec:   # clean insurance ID card as the insurer's PDF
        i = spec['_ins']; p = i['p']
        def b(f):
            f.title(f"{i['co']}  -  Auto Insurance Identification Card", 'Keep this card in your vehicle. Show it to the police if asked.')
            f.row([('Policy number', i['pol'], 266), ('Named insured', p['full'], 266)])
            f.row([('Effective date', fmt(i['eff']), 200), ('Expiration date', fmt(i['exp']), 200), ('NAIC', i['naic'], 132)])
            f.row([('Year', i['veh'][0], 80), ('Make', i['veh'][1], 140), ('Model', i['veh'][2], 140), ('VIN', i['vin'], 172)])
            f.para('This card is not proof of coverage until the policy is in force. Report claims to your agent.')
        return render_form(spec, b)
    raise RuntimeError('no renderer for ' + id)

for spec in DOCS:
    R(spec)

json.dump(PAGES, open(os.path.join(OUT, 'pages-bank.json'), 'w'), indent=1)
by = {}
for d in DOCS: by[d['arrival']] = by.get(d['arrival'], 0) + 1
json.dump({'about': 'Synthetic people / compliance paperwork regression bank. Names, numbers, addresses, bank details invented; routing numbers fail the ABA checksum; SSNs in the never-issued 9xx range. Never Donovan training data.',
           'built': dt.date.today().isoformat(), 'count': len(DOCS), 'byArrival': by, 'docs': [d['id'] for d in DOCS]}, open(os.path.join(OUT, 'INDEX.json'), 'w'), indent=1)
print(len(DOCS), 'documents', by)
