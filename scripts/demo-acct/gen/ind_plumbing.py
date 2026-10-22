"""Plumbing - Bluegill Plumbing Co. (fictional). Wave 1 sample paperwork."""
from builders import *

SLUG = "plumbing"
LABEL = "Plumbing"
CO = {"name": "Bluegill Plumbing Co.", "address": "1420 N Arizona Ave, Chandler, AZ 85225", "phone": "(480) 555-0121",
      "license": "ROC #318804 (sample)", "pack": "plumbing"}
CITY = {"name": "City Development Services", "address": "215 E Buffalo St, Chandler, AZ 85225", "phone": "(480) 555-0102"}
SUPPLY = {"name": "Saguaro Pipe & Supply", "address": "6020 W Chandler Blvd, Chandler, AZ 85226", "phone": "(480) 555-0174"}
TECHS = ["Marcus Feld", "Yolanda Briggs-Ortiz", "Teo Halvorsen"]
TAX = 0.078

BRAN = ("Ottilie Brannagh", "77 S Cholla St, Chandler, AZ 85226")
FERN = ("Fernhollow Apartments", "2400 W Ray Rd, Chandler, AZ 85224")
HEND = ("Bram Hendricks", "1903 E Fairview St, Chandler, AZ 85225")
ACKZ = ("Rosalind Achebe-Kurtz", "650 N Dobson Rd, Chandler, AZ 85224")
FILLER = [
    ("Wilhelmina Szabo", "2715 W Kesler Ln, Chandler, AZ 85224"),
    ("Desmond Achterlonie", "1180 E Kaibab Pl, Chandler, AZ 85249"),
    ("Paloma Recinos", "4331 S Camellia Pl, Chandler, AZ 85248"),
    ("Thaddeus Mwangi", "902 W Commonwealth Ave, Chandler, AZ 85225"),
    ("Cottonwood Learning Center", "3501 S Arizona Ave, Chandler, AZ 85248"),
    ("Linnea Faircloth", "1846 E Sagebrush St, Gilbert, AZ 85296"),
    ("Grigor Petrosyan", "530 N Alma School Rd, Chandler, AZ 85224"),
]


# Rendered as messy paper (office scan / phone photo) instead of a clean PDF.
MESSY = {"Saguaro Pipe invoice SPS-41377.pdf": ("scan", "scan_0930.pdf")}


def build(rng):
    docs = []

    def add(file, pages, kind="pdf", facts=None):
        docs.append({"file": file, "kind": kind, "pages": pages, "facts": facts or {}})

    # ---- Ottilie Brannagh: water heater (2024) -> warranty -> repipe proposal (2026) -> unpaid slab leak repair
    p, f = invoice(CO, "BP-3021", "2024-05-14", *BRAN, [("Tidewell 50-gal gas water heater TW-50G, serial TW2405-88213", 1, 1395.00),
        ("Expansion tank and earthquake straps", 1, 145.00), ("Haul away old heater, install labor", 1, 455.00)], tech="Marcus Feld",
        notes="Replaced leaking 12-year-old water heater. Manufacturer tank warranty 6 years.")
    add("Invoice BP-3021 Brannagh water heater.pdf", p, facts=f)
    add("Warranty registration Brannagh water heater.pdf", warranty_reg(CO, *BRAN, "Tidewell", "TW-50G", "TW2405-88213", "2024-05-14", "2030-05-14",
        notes="6-year tank warranty, 1-year parts. Installed by Marcus Feld.", equipment="50-gallon gas water heater"))
    p, f = proposal(CO, "BQ-118", "2026-09-08", *BRAN, [("Whole-house PEX repipe, 2 bath / 1 kitchen / laundry", 1, 7650.00),
        ("Drywall patch and texture at access points", 1, 1250.00)], prepared_by="Yolanda Briggs-Ortiz",
        scope="Replace original galvanized supply lines with PEX after the slab leak.", status="Pending customer decision")
    add("Proposal BQ-118 Brannagh repipe.pdf", p, facts=f)
    p, f = invoice(CO, "BP-3388", "2026-08-21", *BRAN, [("Slab leak detection (electronic)", 1, 325.00), ("Reroute hot line through attic, 38 ft PEX", 1, 915.00)],
                   tech="Yolanda Briggs-Ortiz", paid=0.0, notes="Hot water slab leak under the kitchen rerouted overhead.")
    add("Invoice BP-3388 Brannagh slab leak.pdf", p, facts=f)

    # ---- Fernhollow Apartments: backflow testing + jetting agreement + customer PO
    add("Backflow test certificate BT-2026-044 Fernhollow.pdf", [letterhead(CO) + [("title", "BACKFLOW TEST CERTIFICATE"), ("kv", "Certificate #", "BT-2026-044"),
        ("kv", "Customer", FERN[0]), ("kv", "Service Address", FERN[1]), ("kv", "Test Date", "03/10/2026"), ("kv", "Tester", "Teo Halvorsen"),
        ("kv", "Device", "Reduced pressure assembly, 2 in."), ("kv", "Device Serial", "RP2-554190"), ("kv", "Result", "Passed"),
        ("kv", "Next Test Due", "03/10/2027"), ("kv", "Notes", "Check valve 1 held at 5.8 psid. Relief valve opened at 2.6 psid.")]])
    add("Backflow test certificate BT-2025-031 Fernhollow.pdf", [letterhead(CO) + [("title", "BACKFLOW TEST CERTIFICATE"), ("kv", "Certificate #", "BT-2025-031"),
        ("kv", "Customer", FERN[0]), ("kv", "Service Address", FERN[1]), ("kv", "Test Date", "03/12/2025"), ("kv", "Tester", "Teo Halvorsen"),
        ("kv", "Device", "Reduced pressure assembly, 2 in."), ("kv", "Device Serial", "RP2-554190"), ("kv", "Result", "Failed, repaired and retested - Passed"),
        ("kv", "Next Test Due", "03/12/2026")]])
    add("Service agreement SA-2026-03 Fernhollow.pdf", maint_agreement(CO, "SA-2026-03", *FERN, "2026-02-01", "2027-01-31", 2880.00,
        notes="Quarterly hydro-jetting of the 6 building main lines and annual backflow test. Billed $720.00 per quarter. Contact: Imelda Varga, community manager.",
        title="SERVICE AGREEMENT"))
    for q, (dt, no) in enumerate([("2026-02-03", "BP-3190"), ("2026-05-04", "BP-3274"), ("2026-08-03", "BP-3361")]):
        p, f = invoice(CO, no, dt, *FERN, [(f"Quarterly hydro-jetting, 6 building mains (agreement SA-2026-03), Q{q + 1}", 1, 720.00)], tech="Teo Halvorsen")
        add(f"Invoice {no} Fernhollow Q{q + 1}.pdf", p, facts=f)
    p, f = purchase_order({"name": FERN[0], "address": FERN[1], "phone": "(480) 555-0137"}, "FA-7781", "2026-06-17", CO["name"],
                          [("Replace 3 failed shutoff valves, Building C laundry room", 1, 864.00)], FERN[1], buyer="Imelda Varga")
    add("Fernhollow purchase order FA-7781.pdf", p, facts=f)
    p, f = invoice(CO, "BP-3317", "2026-06-24", *FERN, [("Replace 3 failed 3/4 in. shutoff valves, Building C laundry room", 1, 864.00)], tech="Marcus Feld",
                   notes="Per Fernhollow purchase order FA-7781.")
    add("Invoice BP-3317 Fernhollow valves.pdf", p, facts=f)

    # ---- Bram Hendricks: camera inspection -> proposal -> permit -> repair invoice; handwritten note
    add("Sewer camera report Hendricks.pdf", [letterhead(CO) + [("title", "SEWER CAMERA INSPECTION REPORT"), ("kv", "Customer", HEND[0]),
        ("kv", "Service Address", HEND[1]), ("kv", "Inspection Date", "01/09/2026"), ("kv", "Technician", "Yolanda Briggs-Ortiz"),
        ("kv", "Line Inspected", "4 in. clay main, cleanout to city tap, 96 ft"),
        ("kv", "Findings", "Root intrusion and offset joint at 42 ft; belly holding water from 55 to 61 ft"),
        ("kv", "Recommendation", "Spot repair at 42 ft with PVC; re-scope after repair")]])
    p, f = proposal(CO, "BQ-097", "2026-01-12", *HEND, [("Excavate and spot-repair 6 ft of 4 in. sewer main at 42 ft, PVC SDR-35", 1, 2850.00),
        ("Permit, backfill and compaction", 1, 600.00)], prepared_by="Yolanda Briggs-Ortiz", status="Accepted 01/14/2026")
    add("Proposal BQ-097 Hendricks sewer repair.pdf", p, facts=f)
    add("Plumbing permit PP-26-00417 Hendricks.pdf", permit(CITY, "Plumbing", "PP-26-00417", "2026-01-20", "2026-07-19", CO["name"], HEND[0], HEND[1],
        "Sewer spot repair, 6 ft of 4 in. building sewer", status="Final inspection passed 01/29/2026", fee=96.00,
        inspections=[["Underground / open trench", "01/27/2026", "Passed"], ["Final", "01/29/2026", "Passed"]]))
    p, f = invoice(CO, "BP-3166", "2026-01-28", *HEND, [("Excavate and spot-repair 6 ft of 4 in. sewer main at 42 ft, PVC SDR-35", 1, 2850.00),
        ("Permit, backfill and compaction", 1, 600.00)], tech="Yolanda Briggs-Ortiz", notes="Work per proposal BQ-097. Post-repair camera inspection clear.")
    add("Invoice BP-3166 Hendricks sewer repair.pdf", p, facts=f)
    add("Note Hendricks.jpg", [], kind="handwritten", facts={"lines": [
        "HENDRICKS - 1903 E Fairview", "Main water shutoff is in the", "garage behind the chest freezer.", "Dog is friendly (Biscuit).",
        "Use side gate, not front.", "Bram cell (480) 555-0192"]})

    # ---- Rosalind Achebe-Kurtz: after-hours burst pipe, unpaid
    p, f = invoice(CO, "BP-3402", "2026-09-27", *ACKZ, [("After-hours emergency call (Saturday 9:40 pm)", 1, 225.00),
        ("Repair burst 1/2 in. copper line in hall closet wall", 1, 387.50)], tech="Teo Halvorsen", paid=0.0, terms="Due on receipt",
        notes="Water shut off at meter on arrival. Wall left open to dry.")
    add("Invoice BP-3402 Achebe-Kurtz burst pipe.pdf", p, facts=f)
    add("IMG_2207.jpg", work_order(CO, "WO-2207", "2026-09-27", *ACKZ, "Teo Halvorsen", "Water spraying inside hall closet wall",
        "Shut off main at meter, opened drywall, replaced 14 in. of burst 1/2 in. copper with PEX and brass fittings", phone="(480) 555-0158"), kind="photo")

    # ---- supplier paperwork
    p, f = receipt_from_vendor(SUPPLY, "SPS-40981", "2026-08-20", CO["name"], [("PEX-A 3/4 in. x 100 ft coil", 2, 118.00), ("Expansion rings 3/4 in. (bag)", 2, 21.50),
        ("Brass ball valve 3/4 in.", 6, 14.25), ("Pipe insulation 3/4 in. x 6 ft", 8, 3.40)], tax_rate=TAX)
    add("scan_0820.pdf", p, kind="scan", facts=f)
    p, f = vendor_invoice(SUPPLY, "SPS-41377", "2026-09-30", CO["name"], [("Tidewell 50-gal gas water heater TW-50G", 3, 1010.00), ("Water heater pan 24 in.", 3, 28.00)], paid=0.0)
    add("Saguaro Pipe invoice SPS-41377.pdf", p, facts=f)

    # ---- everyday volume across 2024-2026
    jobs = [
        ("Cleared main line stoppage from cleanout with cable machine", 229.00),
        ("Replaced toilet fill valve and flapper, reset wax ring", 184.00),
        ("Installed new kitchen faucet supplied by customer", 165.00),
        ("Repaired leaking hose bib and installed vacuum breaker", 142.00),
        ("Replaced garbage disposal 3/4 HP", 389.00),
        ("Water heater flush and anode rod replacement", 215.00),
        ("Replaced pressure regulator at main, set to 60 psi", 468.00),
    ]
    dates = ["2024-07-09", "2024-10-22", "2025-01-30", "2025-04-16", "2025-07-08", "2025-09-25", "2025-12-03", "2026-02-19", "2026-04-28", "2026-07-15",
             "2026-09-10", "2026-10-14", "2024-12-12", "2025-05-29", "2025-11-11", "2026-06-02"]
    n = 2900
    for i, dt in enumerate(dates):
        cust = FILLER[i % len(FILLER)]
        work, price = jobs[i % len(jobs)]
        n += 31 + i
        p, f = invoice(CO, f"BP-{n}", dt, *cust, [(work, 1, price)], tech=TECHS[i % 3], tax_rate=0.0)
        add(f"Invoice BP-{n} {cust[0].split()[-1]}.pdf", p, facts=f)
        if i % 4 == 1:
            add(f"Work order WO-{n - 700} {cust[0].split()[-1]}.pdf", work_order(CO, f"WO-{n - 700}", dt, *cust, TECHS[i % 3], "Customer called in", work))
    p, f = proposal(CO, "BQ-121", "2026-10-05", *FILLER[4], [("Replace 2 commercial 75-gal water heaters", 1, 9480.00)], prepared_by="Marcus Feld")
    add("Proposal BQ-121 Cottonwood water heaters.pdf", p, facts=f)
    return docs


QUESTIONS = [
    {"q": "When was the water heater at 77 S Cholla St installed?", "expect": ["05/14/2024|May 14, 2024|2024-05-14|May 14 2024"], "file": "Warranty registration Brannagh water heater.pdf|Invoice BP-3021 Brannagh water heater.pdf", "page": 1, "type": "date", "card": True},
    {"q": "What is the serial number of Ottilie Brannagh's water heater?", "expect": ["TW2405-88213"], "file": "Warranty registration Brannagh water heater.pdf|Invoice BP-3021 Brannagh water heater.pdf", "page": 1, "type": "lookup"},
    {"q": "When does the tank warranty on Ottilie Brannagh's water heater expire?", "expect": ["05/14/2030|May 14, 2030|2030-05-14"], "file": "Warranty registration Brannagh water heater.pdf", "page": 1, "type": "expiration", "card": True},
    {"q": "How much did we quote Ottilie Brannagh for the repipe?", "expect": ["@Proposal BQ-118 Brannagh repipe.pdf:total"], "file": "Proposal BQ-118 Brannagh repipe.pdf", "page": 1, "type": "total"},
    {"q": "Which invoices are unpaid?", "expect": ["BP-3388", "BP-3402"], "file": "Invoice BP-3388 Brannagh slab leak.pdf|Invoice BP-3402 Achebe-Kurtz burst pipe.pdf", "page": 1, "type": "unpaid", "card": True},
    {"q": "How much does Rosalind Achebe-Kurtz owe us?", "expect": ["@Invoice BP-3402 Achebe-Kurtz burst pipe.pdf:balance"], "file": "Invoice BP-3402 Achebe-Kurtz burst pipe.pdf", "page": 1, "type": "unpaid"},
    {"q": "Who was the technician on invoice BP-3402?", "expect": ["Teo Halvorsen"], "file": "Invoice BP-3402 Achebe-Kurtz burst pipe.pdf|IMG_2207.jpg", "page": 1, "type": "who", "card": True},
    {"q": "When is the next backflow test due at Fernhollow Apartments?", "expect": ["03/10/2027|March 10, 2027|2027-03-10"], "file": "Backflow test certificate BT-2026-044 Fernhollow.pdf", "page": 1, "type": "date", "card": True},
    {"q": "What did the sewer camera inspection find at 1903 E Fairview St?", "expect": ["root"], "file": "Sewer camera report Hendricks.pdf", "page": 1, "type": "lookup"},
    {"q": "What is the permit number for the sewer repair at 1903 E Fairview St?", "expect": ["PP-26-00417"], "file": "Plumbing permit PP-26-00417 Hendricks.pdf", "page": 1, "type": "lookup"},
    {"q": "Where is the main water shutoff at the Hendricks house?", "expect": ["garage", "freezer"], "file": "Note Hendricks.jpg", "page": 1, "type": "handwritten"},
    {"q": "How much did we spend at Saguaro Pipe & Supply on August 20, 2026?", "expect": ["@scan_0820.pdf:total"], "file": "scan_0820.pdf", "page": 1, "type": "total"},
    {"q": "What was the total on invoice BP-3166?", "expect": ["@Invoice BP-3166 Hendricks sewer repair.pdf:total"], "file": "Invoice BP-3166 Hendricks sewer repair.pdf", "page": 1, "type": "total"},
    {"q": "When does the Fernhollow Apartments service agreement expire?", "expect": ["01/31/2027|January 31, 2027|2027-01-31"], "file": "Service agreement SA-2026-03 Fernhollow.pdf", "page": 1, "type": "expiration"},
    {"q": "When does our liability insurance policy expire?", "expect": [], "notInRecords": True, "type": "not-in-records"},
]
