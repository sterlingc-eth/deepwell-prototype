"""HVAC - Coppervane Heating & Air (fictional). Wave 1 sample paperwork."""
from builders import *

SLUG = "hvac"
LABEL = "HVAC"
CO = {"name": "Coppervane Heating & Air", "address": "2150 W Juniper Ave, Mesa, AZ 85201", "phone": "(480) 555-0142",
      "license": "ROC #339112 (sample)", "pack": "hvac"}
CITY = {"name": "City Building Department", "address": "20 E Main St, Mesa, AZ 85201", "phone": "(480) 555-0100"}
SUPPLY = {"name": "Valley Comfort Supply", "address": "880 S Country Club Dr, Mesa, AZ 85210", "phone": "(480) 555-0177"}
COIL = {"name": "Desert Coil Distributors", "address": "4410 E University Dr, Phoenix, AZ 85034", "phone": "(602) 555-0163"}

TECHS = ["Rosa Delgado", "Mateo Kwiatkowski", "Dale Pruitt"]
TAX = 0.0825

WHIT = ("Harlan Whitcombe", "1847 E Ocotillo Dr, Mesa, AZ 85203")
OKA = ("Maribel Okafor", "9 W Kiowa Cir, Mesa, AZ 85210")
SALT = ("Saltbush Self Storage", "3300 S Power Rd, Mesa, AZ 85212")
BRAND = ("Ignatius Brandvold", "1120 N Lindsay Rd, Gilbert, AZ 85234")
ACHT = ("Corinne Achterberg", "655 W Fairway Dr, Mesa, AZ 85201")
FILLER = [
    ("Tobias Ruehl", "2231 E Hermosa Vista Dr, Mesa, AZ 85213"),
    ("Priya Venkataraman", "418 S Ashbrook Ln, Gilbert, AZ 85296"),
    ("Delphine Marchetti", "7720 E Sierra Morena St, Mesa, AZ 85207"),
    ("Augustin Ferreira-Lowe", "1502 W Grove Ave, Mesa, AZ 85202"),
    ("Wendell Okonkwo", "3311 N Recker Rd, Mesa, AZ 85215"),
    ("Juniper Ridge Montessori", "960 N Higley Rd, Gilbert, AZ 85234"),
    ("Lorna Haverkamp", "5126 E Downing St, Mesa, AZ 85205"),
    ("Casimir Oyelaran", "829 W Laguna Azul Ave, Mesa, AZ 85210"),
]


# Rendered as messy paper (office scan / phone photo) instead of a clean PDF.
MESSY = {"Service ticket SV-4541 Ruehl.pdf": ("photo", "IMG_4541.jpg"), "Desert Coil invoice DCD-55021.pdf": ("scan", "scan_0827.pdf")}


def build(rng):
    docs = []

    def add(file, pages, kind="pdf", facts=None):
        docs.append({"file": file, "kind": kind, "pages": pages, "facts": facts or {}})

    # ---- Harlan Whitcombe: install (2023) -> warranty -> maintenance agreement -> tune-ups -> unpaid repair (2026)
    p, f = invoice(CO, "CV-21408", "2023-06-12", *WHIT, [
        ("Aeroline 3-ton heat pump AHP-36S, serial 23K418877", 1, 7480.00),
        ("Matching air handler AAH-36V", 1, 2350.00),
        ("Installation labor, line set, pad, disconnect", 1, 1650.00)], tech="Dale Pruitt",
        notes="New heat pump system installed and started up. 10-year parts warranty registered.")
    add("Invoice CV-21408 Whitcombe install.pdf", p, facts=f)
    add("Warranty registration Whitcombe heat pump.pdf", warranty_reg(CO, *WHIT, "Aeroline", "AHP-36S", "23K418877", "2023-06-12", "2033-06-12",
        notes="10-year parts warranty. Labor warranty ended 06/12/2025.", equipment="Heat pump"))
    add("Startup sheet Whitcombe 2023.pdf", [letterhead(CO) + [("title", "STARTUP SHEET"), ("kv", "Customer", WHIT[0]), ("kv", "Service Address", WHIT[1]),
        ("kv", "Startup Date", "06/12/2023"), ("kv", "Technician", "Dale Pruitt"), ("kv", "Brand", "Aeroline"), ("kv", "Model", "AHP-36S"),
        ("kv", "Serial", "23K418877"), ("kv", "Refrigerant", "R-410A"), ("kv", "Tonnage", "3 ton"),
        ("kv", "Notes", "Supply air 54 F, return air 75 F. Charge verified by subcooling.")]])
    add("Maintenance agreement MA-2025-031 Whitcombe.pdf", maint_agreement(CO, "MA-2025-031", *WHIT, "2025-05-01", "2026-04-30", 219.00,
        notes="Two precision tune-ups per year (spring cooling, fall heating), priority scheduling, 15% off repairs."))
    add("Service ticket SV-4410 Whitcombe tune-up.pdf", service_ticket(CO, "SV-4410", "2025-05-19", *WHIT, "Mateo Kwiatkowski", "Tune-up",
        "Cleaned outdoor coil, replaced 16x25x1 filter, checked refrigerant charge, all readings normal"))
    add("Service ticket SV-4862 Whitcombe tune-up.pdf", service_ticket(CO, "SV-4862", "2025-11-03", *WHIT, "Rosa Delgado", "Tune-up",
        "Checked defrost board and heat strips, tightened electrical connections",
        findings="Dual run capacitor weak: 39 MFD on a 45 MFD rating"))
    p, f = invoice(CO, "CV-24117", "2026-03-14", *WHIT, [("Replaced failed dual run capacitor 45/5 MFD; diagnostic and repair labor", 1, 286.00)],
                   tech="Rosa Delgado", paid=0.0, style="work", notes="Outdoor unit not starting. Capacitor replaced, system cooling normally. 15% agreement discount applied.")
    add("Invoice CV-24117 Whitcombe.pdf", p, facts=f)

    # ---- Maribel Okafor: proposal -> deposit -> permit -> install -> final invoice (unpaid); phone note
    p, f = proposal(CO, "Q-2601", "2026-01-20", *OKA, [("Northwind Comfort 4-ton split system NC-48A with gas furnace NG-80", 1, 11900.00),
        ("Remove and dispose of old 4-ton system", 1, 650.00), ("Installation labor, new line set, thermostat", 1, 1700.00)], style="work",
        scope="Replace 18-year-old 4-ton split system with Northwind Comfort NC-48A and gas furnace NG-80", status="Accepted by customer on 01/24/2026")
    add("Proposal Q-2601 Okafor system replacement.pdf", p, facts=f)
    p, f = invoice(CO, "CV-23861", "2026-01-26", *OKA, [("50% deposit on accepted proposal Q-2601", 1, 7125.00)], tech="Dale Pruitt", style="work",
                   notes="Deposit toward the system replacement in proposal Q-2601.")
    add("Invoice CV-23861 Okafor deposit.pdf", p, facts=f)
    add("Mechanical permit MP-26-01882 Okafor.pdf", permit_simple(CITY, "Mechanical", "MP-26-01882", "2026-02-03", OKA[0], OKA[1], CO["name"],
        "Replace 4 ton split system", status="Finaled", notes="Rough inspection passed 02/16/2026. Final inspection passed 02/24/2026."))
    p, f = invoice(CO, "CV-23990", "2026-02-18", *OKA, [("Remaining 50% balance, system replacement per proposal Q-2601", 1, 7125.00)],
                   tech="Dale Pruitt", paid=0.0, style="work", due_days=30,
                   notes="System installed 02/18/2026. Deposit of $7,125.00 paid on invoice CV-23861.")
    add("Invoice CV-23990 Okafor final.pdf", p, facts=f)
    add("Warranty registration Okafor system.pdf", warranty_reg(CO, *OKA, "Northwind Comfort", "NC-48A", "NW2602A11873", "2026-02-18", "2036-02-18",
        notes="10-year parts warranty. Labor warranty through 02/18/2027.", equipment="Split system"))
    add("Phone message Okafor.jpg", [], kind="handwritten", facts={"lines": [
        "Phone msg  10/06  4:15pm", "Mrs. Okafor - 9 W Kiowa Cir", "upstairs bedroom not cooling", "since Sat. Prefers Tues morning.",
        "Gate code 4417", "call back (480) 555-0186", "- took msg: Jen"]})

    # ---- Saltbush Self Storage: commercial agreement, RTU work, quarterly billing
    add("Maintenance agreement MA-2024-007 Saltbush.pdf", maint_agreement(CO, "MA-2024-007", *SALT, "2025-01-01", "2026-12-31", 3960.00,
        notes="Quarterly maintenance on 4 rooftop units (RTU-1 to RTU-4) and the office mini-split, billed $990.00 per quarter. Site contact Gwendolyn Esparza.",
        title="PREVENTIVE MAINTENANCE AGREEMENT"))
    add("Service ticket SV-5108 Saltbush RTU-3.pdf", service_ticket(CO, "SV-5108", "2026-07-08", *SALT, "Mateo Kwiatkowski", "Repair",
        "Replaced compressor contactor, repaired leak at service valve, recharged 3 lb R-410A", findings="RTU-3 compressor contactor failed and charge low"))
    for q, (dt, no) in enumerate([("2026-01-02", "CV-23512"), ("2026-04-01", "CV-24233"), ("2026-07-01", "CV-24701"), ("2026-10-01", "CV-25296")]):
        p, f = invoice(CO, no, dt, *SALT, [(f"Quarterly maintenance, Q{q + 1} 2026, agreement MA-2024-007", 1, 990.00)], tech="Mateo Kwiatkowski",
                       paid=None if q < 3 else 0.0, style="work")
        add(f"Invoice {no} Saltbush Q{q + 1}.pdf", p, facts=f)
    p, f = invoice(CO, "CV-24766", "2026-07-08", *SALT, [("RTU-3 repair: contactor, leak repair at service valve, 3 lb refrigerant, 2 hours labor", 1, 677.00)],
                   tech="Mateo Kwiatkowski", style="work", notes="See service ticket SV-5108.")
    add("Invoice CV-24766 Saltbush RTU-3 repair.pdf", p, facts=f)

    # ---- Corinne Achterberg: inspection found cracked heat exchanger; proposal declined
    add("Inspection report Achterberg furnace.pdf", inspection(CO, "2025-12-09", *ACHT, "Rosa Delgado",
        "Cracked heat exchanger on the 2009 gas furnace, carbon monoxide 38 ppm at the supply register",
        notes="Furnace shut off and red-tagged for safety. Replace before further use."))
    p, f = proposal(CO, "Q-2588", "2025-12-10", *ACHT, [("Northwind Comfort 80,000 BTU gas furnace NG-80 with venting and labor", 1, 4600.00)], style="work",
                    scope="Replace red-tagged gas furnace with Northwind Comfort NG-80", status="Declined by customer on 12/18/2025")
    add("Proposal Q-2588 Achterberg furnace.pdf", p, facts=f)

    # ---- Ignatius Brandvold: duct cleaning + signed ticket (phone photo)
    p, f = invoice(CO, "CV-24390", "2026-05-06", *BRAND, [("Whole-home duct cleaning, 14 vents, and dryer vent cleaning", 1, 584.00)], tech="Dale Pruitt", style="work")
    add("Invoice CV-24390 Brandvold duct cleaning.pdf", p, facts=f)
    add("IMG_5521.jpg", service_ticket(CO, "SV-5521", "2026-09-15", *BRAND, "Rosa Delgado", "Repair",
        "Replaced blown 3 amp fuse on control board, repaired rubbed thermostat wire in attic", findings="Thermostat blank, no cooling",
        phone="(480) 555-0149"), kind="photo")

    # ---- supplier paperwork
    p, f = receipt_from_vendor(SUPPLY, "VCS-118733", "2026-03-12", CO["name"], [("Dual run capacitor 45/5 MFD", 4, 31.50),
        ("Contactor 40A 2-pole", 3, 24.95), ("Filter 16x25x1 (case of 12)", 2, 54.00), ("Condensate pan tablets", 1, 18.99)], tax_rate=TAX)
    add("scan_0312.pdf", p, kind="scan", facts=f)
    p, f = purchase_order(CO, "PO-1187", "2026-08-20", COIL["name"], [("Northwind Comfort 3-ton condenser NC-36A", 2, 3420.00)],
                          CO["address"], needed_by="2026-08-28", buyer="Dale Pruitt")
    add("Purchase order PO-1187 Desert Coil.pdf", p, facts=f)
    p, f = vendor_invoice(COIL, "DCD-55021", "2026-08-27", CO["name"], [("Northwind Comfort 3-ton condenser NC-36A", 2, 3420.00)], paid=0.0)
    add("Desert Coil invoice DCD-55021.pdf", p, facts=f)

    # ---- everyday volume: tune-ups and repairs for repeat customers across 2024-2026
    jobs = [
        ("Tune-up", 129.00, "Cooling tune-up: cleaned coil, replaced filter, all readings normal"),
        ("Repair", 351.00, "Replaced seized condenser fan motor 1/4 HP"),
        ("Repair", 210.00, "Cleared clogged condensate drain and installed float switch"),
        ("Repair", 289.00, "Replaced failed thermostat with a new smart thermostat and programmed it"),
        ("Repair", 640.00, "Sealed disconnected attic duct and two leaking boots"),
        ("Tune-up", 119.00, "Heating tune-up: cleaned burners, checked flame sensor and heat exchanger"),
    ]
    dates = ["2024-06-11", "2024-08-02", "2024-11-14", "2025-03-27", "2025-06-30", "2025-08-19", "2025-10-08", "2026-01-15", "2026-04-22",
             "2026-06-09", "2026-08-12", "2026-09-29"]
    inv_no, sv_no = 24000, 4500
    for i, dt in enumerate(dates):
        cust = FILLER[i % len(FILLER)]
        stype, price, work = jobs[i % len(jobs)]
        tech = TECHS[i % 3]
        inv_no += 37 + i
        p, f = invoice(CO, f"CV-{inv_no}", dt, *cust, [(work, 1, price)], tech=tech, style="work", paid=0.0 if i == 10 else None)
        add(f"Invoice CV-{inv_no} {cust[0].split()[-1]}.pdf", p, facts=f)
        if i % 3 == 0:
            sv_no += 41
            add(f"Service ticket SV-{sv_no} {cust[0].split()[-1]}.pdf", service_ticket(CO, f"SV-{sv_no}", dt, *cust, tech, stype, work))
    p, f = proposal(CO, "Q-2614", "2026-09-02", *FILLER[1], [("Ductless mini-split 1.5-ton for converted garage gym, installed", 1, 4280.00)], style="work",
                    scope="Add a 1.5-ton ductless mini-split to cool the converted garage gym")
    add("Proposal Q-2614 Venkataraman mini-split.pdf", p, facts=f)
    add("Maintenance agreement MA-2026-012 Ruehl.pdf", maint_agreement(CO, "MA-2026-012", *FILLER[0], "2026-03-01", "2027-02-28", 219.00,
        notes="Two precision tune-ups per year, priority scheduling, 15% off repairs."))
    return docs


QUESTIONS = [
    {"q": "When does Harlan Whitcombe's maintenance agreement expire?", "expect": ["04/30/2026|April 30, 2026|2026-04-30|Apr 30, 2026"], "file": "Maintenance agreement MA-2025-031 Whitcombe.pdf", "page": 1, "type": "expiration", "card": True},
    {"q": "What is the serial number of the heat pump at 1847 E Ocotillo Dr?", "expect": ["23K418877"], "file": "Warranty registration Whitcombe heat pump.pdf|Invoice CV-21408 Whitcombe install.pdf|Startup sheet Whitcombe 2023.pdf", "page": 1, "type": "lookup", "card": True},
    {"q": "When does the warranty on Harlan Whitcombe's heat pump expire?", "expect": ["06/12/2033|June 12, 2033|2033-06-12|Jun 12, 2033"], "file": "Warranty registration Whitcombe heat pump.pdf", "page": 1, "type": "expiration"},
    {"q": "Who was the technician on invoice CV-24117?", "expect": ["Rosa Delgado"], "file": "Invoice CV-24117 Whitcombe.pdf", "page": 1, "type": "who", "card": True},
    {"q": "How much does Maribel Okafor still owe?", "expect": ["@Invoice CV-23990 Okafor final.pdf:balance"], "file": "Invoice CV-23990 Okafor final.pdf", "page": 1, "type": "unpaid"},
    {"q": "Which invoices are unpaid?", "expect": ["CV-24117", "CV-23990"], "file": "Invoice CV-24117 Whitcombe.pdf|Invoice CV-23990 Okafor final.pdf", "page": 1, "type": "unpaid", "card": True},
    {"q": "What is the permit number for the job at 9 W Kiowa Cir?", "expect": ["MP-26-01882"], "file": "Mechanical permit MP-26-01882 Okafor.pdf", "page": 1, "type": "lookup"},
    {"q": "How much did we quote Maribel Okafor for the new system?", "expect": ["@Proposal Q-2601 Okafor system replacement.pdf:total"], "file": "Proposal Q-2601 Okafor system replacement.pdf", "page": 1, "type": "total"},
    {"q": "What's the gate code at the Okafor house?", "expect": ["4417"], "file": "Phone message Okafor.jpg", "page": 1, "type": "handwritten"},
    {"q": "How much did we spend at Valley Comfort Supply in March 2026?", "expect": ["@scan_0312.pdf:total"], "file": "scan_0312.pdf", "page": 1, "type": "total"},
    {"q": "When does the Saltbush Self Storage maintenance agreement expire?", "expect": ["12/31/2026|December 31, 2026|2026-12-31|Dec 31, 2026"], "file": "Maintenance agreement MA-2024-007 Saltbush.pdf", "page": 1, "type": "expiration", "card": True},
    {"q": "What did the inspection find at Corinne Achterberg's house?", "expect": ["cracked heat exchanger"], "file": "Inspection report Achterberg furnace.pdf", "page": 1, "type": "lookup"},
    {"q": "What was the total on invoice CV-21408?", "expect": ["@Invoice CV-21408 Whitcombe install.pdf:total"], "file": "Invoice CV-21408 Whitcombe install.pdf", "page": 1, "type": "total"},
    {"q": "Who was the technician at 1120 N Lindsay Rd on September 15, 2026?", "expect": ["Rosa Delgado"], "file": "IMG_5521.jpg", "page": 1, "type": "who"},
    {"q": "What is Harlan Whitcombe's email address?", "expect": [], "notInRecords": True, "type": "not-in-records"},
]
