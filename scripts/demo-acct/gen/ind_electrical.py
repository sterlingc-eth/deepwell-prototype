"""Electrical - Kestrel Line Electric (fictional). Wave 1 sample paperwork."""
from builders import *

SLUG = "electrical"
LABEL = "Electrical"
CO = {"name": "Kestrel Line Electric", "address": "3055 S Gilbert Rd, Gilbert, AZ 85295", "phone": "(480) 555-0158",
      "license": "ROC #327760 (sample)", "pack": "electrical"}
TOWN = {"name": "Town Permit Center", "address": "90 E Civic Center Dr, Gilbert, AZ 85296", "phone": "(480) 555-0104"}
SUPPLY = {"name": "Arcwell Electrical Supply", "address": "1250 W Warner Rd, Gilbert, AZ 85233", "phone": "(480) 555-0179"}
TECHS = ["Ezra Vandermolen", "Kiri Tamahori", "Luis Carbajal-Reyes"]
TAX = 0.078

STRAND = ("Philippa Strand", "2788 E Merrill Ave, Gilbert, AZ 85234")
HARROW = ("Harrow & Finch Furniture", "1188 N Gilbert Rd, Gilbert, AZ 85234")
MOREAU = ("Dashiell Moreau", "4419 S Ranger Trl, Gilbert, AZ 85297")
CAST = ("Imogen Castellanos", "905 W Elliot Rd, Chandler, AZ 85224")
FILLER = [
    ("Barnaby Oyelowo-Pratt", "1622 E Page Ave, Gilbert, AZ 85234"),
    ("Soledad Ferrante", "3370 S Joshua Tree Ln, Gilbert, AZ 85297"),
    ("Quentin Ashdown", "807 W Guadalupe Rd, Gilbert, AZ 85233"),
    ("Mesquite Hollow Brewing", "45 W Page Ave, Gilbert, AZ 85233"),
    ("Annelise Kowalczyk", "2911 E Cullumber St, Gilbert, AZ 85234"),
    ("Rufus Tandingan", "5540 S Sossaman Rd, Mesa, AZ 85212"),
    ("Greer Holmstrom", "1430 N Val Vista Dr, Gilbert, AZ 85234"),
]


# Rendered as messy paper (office scan / phone photo) instead of a clean PDF.
MESSY = {"Purchase order PO-4402 Arcwell.pdf": ("scan", "scan_0922.pdf")}


def build(rng):
    docs = []

    def add(file, pages, kind="pdf", facts=None):
        docs.append({"file": file, "kind": kind, "pages": pages, "facts": facts or {}})

    # ---- Philippa Strand: 200A panel upgrade: proposal -> permit -> correction -> pass -> invoice (paid)
    p, f = proposal(CO, "KQ-2207", "2026-02-02", *STRAND, [("Replace 100A Federal-type panel with 200A main panel, 40 spaces", 1, 3650.00),
        ("New meter base, grounding electrode system, bonding", 1, 850.00), ("Utility coordination and permit", 1, 350.00)],
        prepared_by="Ezra Vandermolen", scope="Upgrade service from 100A to 200A to support a future EV charger and heat pump.", status="Accepted 02/06/2026")
    add("Proposal KQ-2207 Strand panel upgrade.pdf", p, facts=f)
    add("Electrical permit EP-26-1193 Strand.pdf", permit(TOWN, "Electrical", "EP-26-1193", "2026-02-11", "2026-08-10", CO["name"], STRAND[0], STRAND[1],
        "Service upgrade 100A to 200A, replace main panel", status="Final inspection passed 03/04/2026", fee=135.00,
        inspections=[["Service / panel", "02/26/2026", "Correction: missing bonding jumper at water heater"], ["Re-inspection", "03/04/2026", "Passed"]]))
    add("Inspection correction notice Strand.pdf", [[("brand", TOWN["name"]), ("head", TOWN["address"]), ("head", TOWN["phone"]),
        ("title", "CORRECTION NOTICE"), ("kv", "Permit #", "EP-26-1193"), ("kv", "Inspection Date", "02/26/2026"), ("kv", "Job Address", STRAND[1]),
        ("kv", "Contractor", CO["name"]), ("kv", "Inspector", "R. Tellefsen"), ("kv", "Result", "Correction required"),
        ("kv", "Item 1", "Install bonding jumper across water heater cold/hot lines per NEC 250.104"), ("kv", "Item 2", "Label new panel circuits")]])
    p, f = invoice(CO, "KL-6120", "2026-03-05", *STRAND, [("Replace 100A panel with 200A main panel, 40 spaces", 1, 3650.00),
        ("New meter base, grounding electrode system, bonding", 1, 850.00), ("Utility coordination and permit", 1, 350.00)], tech="Ezra Vandermolen",
        notes="Work per proposal KQ-2207. Final inspection passed 03/04/2026.")
    add("Invoice KL-6120 Strand panel.pdf", p, facts=f)
    add("Panel schedule Strand.pdf", [letterhead(CO) + [("title", "PANEL SCHEDULE"), ("kv", "Customer", STRAND[0]), ("kv", "Service Address", STRAND[1]),
        ("kv", "Panel", "Main 200A, 40 spaces, installed 03/03/2026"), ("table", ["Circuit", "Breaker", "Load"], [["1-3", "40A 2P", "Range"], ["2-4", "30A 2P", "Dryer"],
        ["5-7", "30A 2P", "Water heater"], ["6-8", "50A 2P", "Spare for EV charger"], ["9", "20A", "Kitchen counters"], ["10", "20A", "Kitchen counters"],
        ["11", "15A", "Bedrooms 1-2"], ["12", "20A", "Laundry"], ["13", "15A", "Garage lights"], ["14", "20A", "Bathrooms GFCI"]])]])
    add("Note Strand.jpg", [], kind="handwritten", facts={"lines": [
        "Strand - 2788 E Merrill", "Panel is in the hall closet", "(behind the coats).", "Dog in backyard - keep gate shut.",
        "Text before arriving", "(480) 555-0193", "- Kiri"]})

    # ---- Harrow & Finch Furniture: LED retrofit + lighting maintenance agreement
    p, f = invoice(CO, "KL-6044", "2026-01-22", *HARROW, [("LED retrofit, 64 showroom fixtures (fixtures supplied)", 64, 118.00),
        ("Lift rental, 3 days", 1, 690.00), ("Occupancy sensors, back office and restrooms", 6, 85.00)], tech="Luis Carbajal-Reyes",
        notes="Lighting retrofit completed over three nights to keep the showroom open.")
    add("Invoice KL-6044 Harrow & Finch LED retrofit.pdf", p, facts=f)
    add("Lighting maintenance agreement KM-26-04 Harrow & Finch.pdf", maint_agreement(CO, "KM-26-04", *HARROW, "2026-02-01", "2027-01-31", 1440.00,
        notes="Monthly lighting walk-through, emergency and exit light test, replacement of failed lamps and drivers (parts billed). Billed $120.00 per month.",
        title="SERVICE AGREEMENT"))
    p, f = invoice(CO, "KL-6298", "2026-10-02", *HARROW, [("Monthly lighting service, October 2026 (agreement KM-26-04)", 1, 120.00),
        ("LED driver replaced, fixture 17", 1, 96.00)], tech="Luis Carbajal-Reyes", paid=0.0)
    add("Invoice KL-6298 Harrow & Finch October.pdf", p, facts=f)

    for m, (dt, no) in enumerate([("2026-02-27", "KL-6106"), ("2026-03-30", "KL-6131"), ("2026-04-29", "KL-6159"), ("2026-05-29", "KL-6184"),
                                  ("2026-06-30", "KL-6214"), ("2026-07-30", "KL-6243"), ("2026-08-31", "KL-6262"), ("2026-09-30", "KL-6281")]):
        mon = ["February", "March", "April", "May", "June", "July", "August", "September"][m]
        p, f = invoice(CO, no, dt, *HARROW, [(f"Monthly lighting service, {mon} 2026 (agreement KM-26-04)", 1, 120.00)], tech="Luis Carbajal-Reyes")
        add(f"Invoice {no} Harrow & Finch {mon}.pdf", p, facts=f)

    # ---- Dashiell Moreau: EV charger install (unpaid) + permit
    p, f = invoice(CO, "KL-6201", "2026-06-18", *MOREAU, [("Install customer-supplied VoltNest VN-48 Level 2 EV charger, serial VN48-221907", 1, 890.00),
        ("New 60A 2-pole circuit, 45 ft 6 AWG in EMT", 1, 640.00), ("Permit and inspection", 1, 160.00)], tech="Kiri Tamahori", paid=0.0,
        notes="Charger set to 48A continuous. Final inspection passed 06/24/2026.")
    add("Invoice KL-6201 Moreau EV charger.pdf", p, facts=f)
    add("Electrical permit EP-26-1342 Moreau.pdf", permit(TOWN, "Electrical", "EP-26-1342", "2026-06-12", "2026-12-09", CO["name"], MOREAU[0], MOREAU[1],
        "New 60A branch circuit for Level 2 EV charger", status="Final inspection passed 06/24/2026", fee=74.00))

    # ---- Imogen Castellanos: standby generator + warranty + annual service
    p, f = invoice(CO, "KL-5871", "2025-11-20", *CAST, [("Brightfield Power 22 kW standby generator BP-22S, serial BF22-90417", 1, 6950.00),
        ("200A automatic transfer switch", 1, 1180.00), ("Pad, gas tie-in coordination, wiring, startup", 1, 2240.00)], tech="Ezra Vandermolen")
    add("Invoice KL-5871 Castellanos generator.pdf", p, facts=f)
    add("Warranty registration Castellanos generator.pdf", warranty_reg(CO, *CAST, "Brightfield Power", "BP-22S", "BF22-90417", "2025-11-20", "2030-11-20",
        notes="5-year limited warranty, parts and labor.", equipment="22 kW standby generator"))
    add("IMG_3318.jpg", service_ticket(CO, "ST-3318", "2026-09-30", *CAST, "Ezra Vandermolen", "Maintenance",
        "Annual generator service: oil and filter, spark plugs, air filter, battery load test, exercised under load 20 minutes",
        notes="Next annual service due 09/2027.", phone="(480) 555-0166"), kind="photo")

    # ---- supplier paperwork
    p, f = receipt_from_vendor(SUPPLY, "AES-77215", "2026-06-17", CO["name"], [("6 AWG THHN copper, 500 ft", 1, 412.00), ("3/4 in. EMT, 10 ft", 6, 9.80),
        ("60A 2-pole breaker", 1, 38.50), ("NEMA 14-50 receptacle, industrial grade", 1, 27.90)], tax_rate=TAX)
    add("scan_0617.pdf", p, kind="scan", facts=f)
    p, f = purchase_order(CO, "PO-4402", "2026-09-22", SUPPLY["name"], [("200A 40-space main breaker panel", 2, 489.00), ("Surge protective device, whole home", 2, 156.00)],
                          CO["address"], needed_by="2026-09-29", buyer="Ezra Vandermolen")
    add("Purchase order PO-4402 Arcwell.pdf", p, facts=f)

    # ---- everyday volume
    jobs = [
        ("Replaced 6 failed GFCI receptacles in kitchen and baths", 312.00),
        ("Installed 4 recessed LED lights in living room on dimmer", 548.00),
        ("Traced and repaired tripping garage circuit, replaced damaged receptacle", 236.00),
        ("Installed ceiling fan with new fan-rated box", 285.00),
        ("Added 20A dedicated circuit for garage freezer", 410.00),
        ("Replaced exterior motion flood lights (2)", 264.00),
        ("Whole-home surge protector installed at main panel", 395.00),
    ]
    dates = ["2024-05-21", "2024-09-12", "2025-01-07", "2025-03-19", "2025-06-03", "2025-08-27", "2025-10-30", "2026-01-13", "2026-03-24", "2026-05-27",
             "2026-08-05", "2026-09-17"]
    n = 5700
    for i, dt in enumerate(dates):
        cust = FILLER[i % len(FILLER)]
        work, price = jobs[i % len(jobs)]
        n += 29 + i
        p, f = invoice(CO, f"KL-{n}", dt, *cust, [(work, 1, price)], tech=TECHS[i % 3])
        add(f"Invoice KL-{n} {cust[0].split()[-1]}.pdf", p, facts=f)
        if i % 4 == 2:
            add(f"Work order WO-{n - 2000} {cust[0].split()[-1]}.pdf", work_order(CO, f"WO-{n - 2000}", dt, *cust, TECHS[i % 3], "Customer request", work))
    add("Infrared inspection Mesquite Hollow Brewing.pdf", inspection(CO, "2026-04-14", *FILLER[3], "Luis Carbajal-Reyes",
        "Hot spot 41 F above ambient on the B-phase lug of the walk-in cooler disconnect; all other gear within normal range",
        notes="Lug re-torqued and re-scanned the same day; temperature normal afterward.", title="INFRARED INSPECTION REPORT"))
    p, f = proposal(CO, "KQ-2241", "2026-10-06", *FILLER[3], [("Brewhouse 480V 3-phase circuit for new 15 bbl kettle", 1, 7420.00)], prepared_by="Luis Carbajal-Reyes")
    add("Proposal KQ-2241 Mesquite Hollow Brewing.pdf", p, facts=f)
    return docs


QUESTIONS = [
    {"q": "How much was the panel upgrade at 2788 E Merrill Ave?", "expect": ["@Invoice KL-6120 Strand panel.pdf:total"], "file": "Invoice KL-6120 Strand panel.pdf|Proposal KQ-2207 Strand panel upgrade.pdf", "page": 1, "type": "total", "card": True},
    {"q": "What is the permit number for Philippa Strand's panel upgrade?", "expect": ["EP-26-1193"], "file": "Electrical permit EP-26-1193 Strand.pdf|Inspection correction notice Strand.pdf", "page": 1, "type": "lookup"},
    {"q": "What correction did the inspector ask for at the Strand house?", "expect": ["bonding"], "file": "Inspection correction notice Strand.pdf|Electrical permit EP-26-1193 Strand.pdf", "page": 1, "type": "lookup", "card": True},
    {"q": "Which invoices are unpaid?", "expect": ["KL-6201", "KL-6298"], "file": "Invoice KL-6201 Moreau EV charger.pdf|Invoice KL-6298 Harrow & Finch October.pdf", "page": 1, "type": "unpaid", "card": True},
    {"q": "How much does Dashiell Moreau owe?", "expect": ["@Invoice KL-6201 Moreau EV charger.pdf:balance"], "file": "Invoice KL-6201 Moreau EV charger.pdf", "page": 1, "type": "unpaid"},
    {"q": "Who installed the EV charger at 4419 S Ranger Trl?", "expect": ["Kiri Tamahori"], "file": "Invoice KL-6201 Moreau EV charger.pdf", "page": 1, "type": "who"},
    {"q": "What is the serial number of Imogen Castellanos' generator?", "expect": ["BF22-90417"], "file": "Warranty registration Castellanos generator.pdf|Invoice KL-5871 Castellanos generator.pdf", "page": 1, "type": "lookup", "card": True},
    {"q": "When does the warranty on the Castellanos generator expire?", "expect": ["11/20/2030|November 20, 2030|2030-11-20"], "file": "Warranty registration Castellanos generator.pdf", "page": 1, "type": "expiration"},
    {"q": "When does the Harrow & Finch Furniture service agreement expire?", "expect": ["01/31/2027|January 31, 2027|2027-01-31"], "file": "Lighting maintenance agreement KM-26-04 Harrow & Finch.pdf", "page": 1, "type": "expiration"},
    {"q": "How much was the LED retrofit at Harrow & Finch Furniture?", "expect": ["@Invoice KL-6044 Harrow & Finch LED retrofit.pdf:total"], "file": "Invoice KL-6044 Harrow & Finch LED retrofit.pdf", "page": 1, "type": "total"},
    {"q": "Where is the electrical panel at the Strand house?", "expect": ["hall closet"], "file": "Note Strand.jpg", "page": 1, "type": "handwritten"},
    {"q": "How much did we spend at Arcwell Electrical Supply on June 17, 2026?", "expect": ["@scan_0617.pdf:total"], "file": "scan_0617.pdf", "page": 1, "type": "total"},
    {"q": "When was the generator at 905 W Elliot Rd last serviced?", "expect": ["09/30/2026|September 30, 2026|2026-09-30"], "file": "IMG_3318.jpg", "page": 1, "type": "date"},
    {"q": "What is on purchase order PO-4402?", "expect": ["panel"], "file": "scan_0922.pdf", "page": 1, "type": "lookup"},
    {"q": "What is Philippa Strand's email address?", "expect": [], "notInRecords": True, "type": "not-in-records"},
]
