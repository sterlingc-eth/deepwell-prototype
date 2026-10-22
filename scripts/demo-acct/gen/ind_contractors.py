"""General Contractors - Stonefield & Pike Builders (fictional). Wave 1 sample paperwork."""
from builders import *

SLUG = "contractors"
LABEL = "General Contractors"
CO = {"name": "Stonefield & Pike Builders", "address": "2210 S Priest Dr, Tempe, AZ 85282", "phone": "(480) 555-0168",
      "license": "ROC #301442 (sample)", "pack": None}
PM = "Corrigan Pike"
SUPER = "Delia Marchbanks"
CITY = {"name": "City Community Development", "address": "31 E 5th St, Tempe, AZ 85281", "phone": "(480) 555-0106"}

OCAMPO = ("Rafael and Lucia Ocampo", "3127 S Los Feliz Dr, Tempe, AZ 85282")
CANYON = ("Canyon Fold Coffee Roasters", "455 W University Dr, Tempe, AZ 85281")
SUBS = {
    "rimrock": {"name": "Rimrock Framing LLC", "address": "4020 S 36th St, Phoenix, AZ 85040", "phone": "(602) 555-0161"},
    "arclight": {"name": "Arclight Tradeworks", "address": "811 W Southern Ave, Tempe, AZ 85282", "phone": "(480) 555-0162"},
    "drywall": {"name": "Desert Drywall Partners", "address": "2333 E University Dr, Mesa, AZ 85213", "phone": "(480) 555-0164"},
    "cabinet": {"name": "Ironwood Mill & Cabinet", "address": "1909 W Broadway Rd, Tempe, AZ 85282", "phone": "(480) 555-0165"},
}
LUMBER = {"name": "Haverline Lumber & Truss", "address": "6100 S Kyrene Rd, Tempe, AZ 85283", "phone": "(480) 555-0167"}


def pay_app(no, dt, owner, address, contract_sum, change_orders, completed_to_date, retain_pct, prev_paid, period_to, paid=False):
    retain = round(completed_to_date * retain_pct, 2)
    earned_less_ret = round(completed_to_date - retain, 2)
    due = round(earned_less_ret - prev_paid, 2)
    rows = letterhead(CO) + [("title", "APPLICATION FOR PAYMENT"), ("kv", "Application #", no), ("kv", "Application Date", d(dt)), ("kv", "Period To", d(period_to)),
                             ("kv", "Bill To", owner), ("kv", "Project Address", address),
                             ("kv", "Original Contract Sum", money(contract_sum)), ("kv", "Net Change by Change Orders", money(change_orders)),
                             ("kv", "Contract Sum to Date", money(contract_sum + change_orders)), ("kv", "Completed and Stored to Date", money(completed_to_date)),
                             ("kv", "Retainage Held", f"{money(retain)} ({int(retain_pct * 100)}%)"), ("kv", "Less Previous Payments", money(prev_paid)),
                             ("kv", "Amount Due", money(due)), ("kv", "Status", "Paid in full" if paid else "Open")]
    return [rows], {"due": due, "retain": retain, "earned": earned_less_ret}


# Rendered as messy paper (office scan / phone photo) instead of a clean PDF.
MESSY = {"Lien waiver Rimrock Framing.pdf": ("scan", "scan_0531.pdf"), "Inspection report framing Ocampo.pdf": ("photo", "IMG_0507.jpg")}


def build(rng):
    docs = []

    def add(file, pages, kind="pdf", facts=None):
        docs.append({"file": file, "kind": kind, "pages": pages, "facts": facts or {}})

    # ---- Ocampo kitchen remodel + addition: contract -> permit -> change orders -> pay apps -> sub paperwork
    add("Construction contract SP-26-07 Ocampo.pdf", contract_pages(CO, "CONSTRUCTION CONTRACT", "SP-26-07",
        [("kv", "Owner", OCAMPO[0]), ("kv", "Project Address", OCAMPO[1]), ("kv", "Project Manager", PM)],
        [("kv", "Contract Sum", "$186,400.00"), ("kv", "Start Date", "03/02/2026"), ("kv", "Substantial Completion", "08/28/2026"), ("kv", "Retainage", "10%")],
        [("1. Scope of work", "Remodel the existing kitchen and add a 420 sq ft family room addition at the rear of the house per plans by Halvard Design Studio dated 01/15/2026, including foundation, framing, roofing tie-in, electrical, plumbing, HVAC extension, drywall, cabinets, counters and finishes."),
         ("2. Contract sum", "Owner pays Contractor $186,400.00, adjusted only by signed change orders."),
         ("3. Payments", "Contractor submits a monthly application for payment. Owner pays within 15 days. Owner holds 10% retainage from each payment until substantial completion and final lien waivers."),
         ("4. Schedule", "Work starts March 2, 2026. Substantial completion is August 28, 2026, extended only for owner changes, weather or permit delays."),
         ("5. Change orders", "No extra work is performed without a signed change order stating the price and any schedule change."),
         ("6. Allowances", "Cabinet allowance $24,000.00; appliance allowance $9,500.00; tile allowance $6,200.00. Overages are billed by change order."),
         ("7. Warranty", "Contractor warrants workmanship for one year from substantial completion. Manufacturer warranties pass to Owner."),
         ("8. Insurance", "Contractor carries general liability of $1,000,000 per occurrence and workers compensation, and requires the same from subcontractors."),
         ("9. Permits", "Contractor obtains and pays for all permits. Permit fees are included in the contract sum."),
         ("10. Dispute resolution", "The parties will first try to resolve any dispute by meeting in person, then by mediation in Maricopa County.")],
        sign_labels=("Owner", "Contractor")))
    add("Building permit BP-26-02231 Ocampo.pdf", permit_simple(CITY, "Building", "BP-26-02231", "2026-02-20", OCAMPO[0], OCAMPO[1], CO["name"],
        "Kitchen remodel and 420 sq ft rear addition", status="Finaled",
        notes="Inspections passed: footings 03/16/2026, framing 05/07/2026, rough MEP 05/21/2026, insulation 05/28/2026, final 09/02/2026. Permit fee $2,184.00."))
    add("Change order CO-1 Ocampo.pdf", [letterhead(CO) + [("title", "CHANGE ORDER"), ("kv", "Change Order #", "CO-1"), ("kv", "Contract #", "SP-26-07"),
        ("kv", "Owner", OCAMPO[0]), ("kv", "Project Address", OCAMPO[1]), ("kv", "Date", "04/03/2026"),
        ("kv", "Description", "Upgrade addition windows to dual-pane low-E with grids (4 windows)"), ("kv", "Change Amount", "$2,640.00"),
        ("kv", "Schedule Change", "None"), ("kv", "New Contract Sum", "$189,040.00")], ])
    add("Change order CO-2 Ocampo.pdf", [letterhead(CO) + [("title", "CHANGE ORDER"), ("kv", "Change Order #", "CO-2"), ("kv", "Contract #", "SP-26-07"),
        ("kv", "Owner", OCAMPO[0]), ("kv", "Project Address", OCAMPO[1]), ("kv", "Date", "05/12/2026"),
        ("kv", "Description", "Replace rotted subfloor found under old kitchen sink, 64 sq ft"), ("kv", "Change Amount", "$1,180.00"),
        ("kv", "Schedule Change", "Add 2 days"), ("kv", "New Contract Sum", "$190,220.00")]])
    add("Change order CO-3 Ocampo.pdf", [letterhead(CO) + [("title", "CHANGE ORDER"), ("kv", "Change Order #", "CO-3"), ("kv", "Contract #", "SP-26-07"),
        ("kv", "Owner", OCAMPO[0]), ("kv", "Project Address", OCAMPO[1]), ("kv", "Date", "06/18/2026"),
        ("kv", "Description", "Relocate pantry wall 30 inches and add walk-in pantry shelving"), ("kv", "Change Amount", "$7,850.00"),
        ("kv", "Schedule Change", "Add 5 days"), ("kv", "New Contract Sum", "$198,070.00")]])
    pays = [("PA-1", "2026-03-31", 38200.00, 0.0, 0.0, True), ("PA-2", "2026-04-30", 82600.00, 2640.00, 34380.00, True),
            ("PA-3", "2026-05-31", 121900.00, 3820.00, 74340.00, True), ("PA-4", "2026-07-31", 176300.00, 11670.00, 109710.00, True),
            ("PA-5", "2026-09-04", 198070.00, 11670.00, 158670.00, False)]
    for no, dt, done, cos, prev, paid in pays:
        p, f = pay_app(no, dt, *OCAMPO, 186400.00, cos, done, 0.10 if no != "PA-5" else 0.0, prev, dt, paid=paid)
        add(f"Pay application {no} Ocampo.pdf", p, facts=f)
    add("Inspection report framing Ocampo.pdf", [[("brand", CITY["name"]), ("head", CITY["address"]), ("head", CITY["phone"]), ("title", "INSPECTION REPORT"),
        ("kv", "Permit #", "BP-26-02231"), ("kv", "Inspection Date", "05/07/2026"), ("kv", "Inspection Type", "Framing"), ("kv", "Job Address", OCAMPO[1]),
        ("kv", "Inspector", "N. Abernathy-Cole"), ("kv", "Result", "Passed"), ("kv", "Comments", "Hold-downs and shear nailing per plan. Approved to cover after rough MEP.")]])
    add("Subcontract Rimrock Framing Ocampo.pdf", contract_pages(CO, "SUBCONTRACT AGREEMENT", "SC-26-07-02",
        [("kv", "Subcontractor", SUBS["rimrock"]["name"]), ("kv", "Project Address", OCAMPO[1])],
        [("kv", "Subcontract Sum", "$28,750.00"), ("kv", "Start Date", "04/06/2026"), ("kv", "Retainage", "10%")],
        [("1. Scope", "Framing of the 420 sq ft addition, roof tie-in framing, kitchen header and pantry wall framing, per plans."),
         ("2. Payment", "Paid monthly on approved progress, less 10% retainage, within 7 days of payment by Owner."),
         ("3. Insurance", "Subcontractor keeps general liability of $1,000,000 and workers compensation and lists Contractor as additional insured.")],
        sign_labels=("Subcontractor", "Contractor")))
    add("Lien waiver Rimrock Framing.pdf", [letterhead(SUBS["rimrock"], with_lic=False) + [("title", "CONDITIONAL WAIVER AND RELEASE ON PROGRESS PAYMENT"),
        ("kv", "Project Address", OCAMPO[1]), ("kv", "Owner", OCAMPO[0]), ("kv", "Customer", CO["name"]), ("kv", "Through Date", "05/31/2026"),
        ("kv", "Payment Amount", "$15,525.00"), ("kv", "Claimant", SUBS["rimrock"]["name"]),
        ("text", "This waiver releases mechanics lien rights for work through the date above, on the condition that the payment amount is received.")]])
    p, f = vendor_invoice(SUBS["cabinet"], "IMC-3307", "2026-07-22", CO["name"], [("Kitchen cabinets, maple shaker, per shop drawings, Ocampo", 1, 23480.00),
        ("Walk-in pantry shelving (CO-3)", 1, 2180.00)], paid=25660.00)
    add("Ironwood Mill invoice IMC-3307.pdf", p, facts=f)
    add("Site note Ocampo.jpg", [], kind="handwritten", facts={"lines": [
        "OCAMPO - site note 6/22", "Lucia wants pantry shelves", "16 in deep (not 12). Confirm", "w/ Ironwood before Thurs.",
        "Dumpster swap Fri AM.", "Tile delivery moved to 6/29.", "- Delia"]})

    # ---- Canyon Fold Coffee Roasters tenant improvement
    p, f = proposal(CO, "SPQ-26-019", "2026-07-08", *CANYON, [("Tenant improvement: demo, framing, roaster exhaust, ADA restroom, finishes", 1, 84200.00),
        ("General conditions, permit, supervision", 1, 8500.00)], prepared_by=PM, scope="Build out 1,850 sq ft retail and roasting space.", status="Accepted 07/15/2026")
    add("Proposal SPQ-26-019 Canyon Fold.pdf", p, facts=f)
    add("Subcontract Arclight Tradeworks Canyon Fold.pdf", contract_pages(CO, "SUBCONTRACT AGREEMENT", "SC-26-19-04",
        [("kv", "Subcontractor", SUBS["arclight"]["name"]), ("kv", "Project Address", CANYON[1])],
        [("kv", "Subcontract Sum", "$18,400.00"), ("kv", "Start Date", "08/10/2026"), ("kv", "Retainage", "10%")],
        [("1. Scope", "Electrical for the coffee roaster (208V 3-phase), lighting, receptacles, restroom and exhaust fan circuits, per plans."),
         ("2. Payment", "Paid monthly on approved progress, less 10% retainage."), ("3. Insurance", "General liability of $1,000,000 and workers compensation.")],
        sign_labels=("Subcontractor", "Contractor")))
    add("Certificate of insurance Arclight Tradeworks.pdf", coi("Copperline Casualty Co.", "C-90233", SUBS["arclight"]["name"], CO["name"], "2026-06-01", "2027-05-31", 1000000))
    add("Certificate of insurance Desert Drywall Partners.pdf", coi("Sonoran Shield Insurance", "C-61870", SUBS["drywall"]["name"], CO["name"], "2025-09-01", "2026-08-31", 1000000))
    add("Certificate of insurance Rimrock Framing.pdf", coi("Cactus Mutual Insurance Co.", "C-48802", SUBS["rimrock"]["name"], CO["name"], "2026-01-15", "2027-01-14", 1000000))
    p, f = invoice(CO, "SP-INV-2611", "2026-09-30", *CANYON, [("Progress billing, 45% complete (proposal SPQ-26-019)", 1, 41715.00)], paid=0.0, title="INVOICE")
    add("Invoice SP-INV-2611 Canyon Fold progress.pdf", p, facts=f)
    add("IMG_4410.jpg", [letterhead(CO) + [("title", "DAILY LOG"), ("kv", "Project Address", CANYON[1]), ("kv", "Date", "09/24/2026"), ("kv", "Superintendent", SUPER),
        ("kv", "Weather", "Clear, 98 F"), ("kv", "Crew On Site", "Arclight Tradeworks (3), Stonefield & Pike (2)"),
        ("kv", "Work Done", "Roaster exhaust curb set on roof; restroom rough plumbing inspected and passed"),
        ("kv", "Issues", "Roaster delivery moved to 10/06/2026 by the equipment supplier")]], kind="photo")

    # ---- supplier paperwork
    p, f = vendor_invoice(LUMBER, "HLT-58812", "2026-04-09", CO["name"], [("Framing package, Ocampo addition (per takeoff)", 1, 13140.00), ("Delivery and boom unload", 1, 1080.00)],
                          paid=0.0, ship_to=OCAMPO[1])
    add("Haverline Lumber invoice HLT-58812.pdf", p, facts=f)
    p, f = receipt_from_vendor({"name": "Tempe Rental Depot", "address": "1330 E Apache Blvd, Tempe, AZ 85281", "phone": "(480) 555-0169"}, "TRD-20944", "2026-05-15",
                               CO["name"], [("Mini excavator rental, 1 day", 1, 365.00), ("Plate compactor rental, 1 day", 1, 85.00), ("Delivery and pickup", 1, 120.00)], tax_rate=0.081)
    add("scan_0515.pdf", p, kind="scan", facts=f)

    # ---- everyday volume: smaller jobs and paperwork
    small = [("2025-10-14", "Ingrid Solberg-Achebe", "1140 E Lemon St, Tempe, AZ 85281", "Bathroom remodel, hall bath", 18650.00),
             ("2025-12-09", "Mateus Kaplan", "2605 S Juniper St, Tempe, AZ 85282", "Covered patio, 14 x 22 ft", 21400.00),
             ("2026-02-11", "Bellwether Dental Lab", "780 W Elliot Rd, Tempe, AZ 85284", "Office reconfiguration, 2 new walls and doors", 9870.00),
             ("2026-04-27", "Juniper Tafoya", "1912 E Huntington Dr, Tempe, AZ 85282", "Garage conversion to studio", 32500.00),
             ("2026-06-30", "Odalys Brennan", "502 W 9th St, Tempe, AZ 85281", "Kitchen refresh, counters and backsplash", 14250.00),
             ("2026-08-26", "Pemberton Street Partners", "1 E 5th St, Tempe, AZ 85281", "Storefront door replacement", 6480.00)]
    for i, (dt, cust, addr, desc, amt) in enumerate(small):
        p, f = invoice(CO, f"SP-INV-{2540 + i * 9}", dt, cust, addr, [(desc, 1, amt)], paid=None if i != 5 else 0.0)
        add(f"Invoice SP-INV-{2540 + i * 9} {cust.split()[-1]}.pdf", p, facts=f)
        if i % 2 == 0:
            p, f = proposal(CO, f"SPQ-{dt[2:4]}-{40 + i}", add_days(dt, -45), cust, addr, [(desc, 1, amt)], prepared_by=PM, status=f"Accepted {d(add_days(dt, -40))}")
            add(f"Proposal SPQ-{dt[2:4]}-{40 + i} {cust.split()[-1]}.pdf", p, facts=f)
    p, f = vendor_invoice(SUBS["drywall"], "DDP-1194", "2026-06-05", CO["name"], [("Hang, tape and texture, Ocampo addition, 3,600 sq ft", 1, 9720.00)], paid=9720.00)
    add("Desert Drywall invoice DDP-1194.pdf", p, facts=f)
    p, f = vendor_invoice(SUBS["rimrock"], "RF-2207", "2026-05-31", CO["name"], [("Framing progress, Ocampo addition, through 05/31/2026", 1, 17250.00),
        ("Less 10% retainage", 1, -1725.00)], paid=15525.00)
    add("Rimrock Framing invoice RF-2207.pdf", p, facts=f)
    add("Certificate of substantial completion Ocampo.pdf", [letterhead(CO) + [("title", "CERTIFICATE OF SUBSTANTIAL COMPLETION"), ("kv", "Contract #", "SP-26-07"),
        ("kv", "Owner", OCAMPO[0]), ("kv", "Project Address", OCAMPO[1]), ("kv", "Date of Substantial Completion", "09/02/2026"),
        ("kv", "Punch List", "Touch-up paint in family room; adjust pantry door; caulk backsplash at range (12 items total)"),
        ("kv", "Warranty Start", "09/02/2026"), ("kv", "Warranty End", "09/01/2027")]])
    add("Warranty letter Ocampo.pdf", letter(CO, "2026-09-10", [OCAMPO[0], OCAMPO[1]], "One-year workmanship warranty", [
        "Thank you for choosing Stonefield & Pike Builders. Your one-year workmanship warranty for the kitchen remodel and family room addition runs from September 2, 2026 through September 1, 2027.",
        "Manufacturer warranties for the windows, appliances and cabinets are in the closeout binder. To request warranty service, call our office at (480) 555-0168."],
        f"{PM}, Project Manager"))
    add("Building permit BP-26-04418 Canyon Fold.pdf", permit(CITY, "Building", "BP-26-04418", "2026-08-03", "2027-08-02", CO["name"], CANYON[0], CANYON[1],
        "Tenant improvement, 1,850 sq ft coffee roastery and retail", status="Issued", fee=1312.00,
        inspections=[["Rough plumbing", "09/24/2026", "Passed"], ["Rough electrical", "09/29/2026", "Passed"]]))
    add("Change order CO-1 Canyon Fold.pdf", [letterhead(CO) + [("title", "CHANGE ORDER"), ("kv", "Change Order #", "CO-1"), ("kv", "Contract #", "SPQ-26-019"),
        ("kv", "Owner", CANYON[0]), ("kv", "Project Address", CANYON[1]), ("kv", "Date", "09/16/2026"),
        ("kv", "Description", "Add grease interceptor at prep sink required by plan review"), ("kv", "Change Amount", "$3,960.00"),
        ("kv", "Schedule Change", "Add 3 days"), ("kv", "New Contract Sum", "$96,660.00")]])
    p, f = vendor_invoice(SUBS["arclight"], "ATW-1088", "2026-09-30", CO["name"], [("Electrical progress, Canyon Fold TI, 50% complete", 1, 9200.00),
        ("Less 10% retainage", 1, -920.00)], paid=0.0)
    add("Arclight Tradeworks invoice ATW-1088.pdf", p, facts=f)
    return docs


QUESTIONS = [
    {"q": "What is the contract amount for the Ocampo remodel?", "expect": ["186,400|186400"], "file": "Construction contract SP-26-07 Ocampo.pdf", "page": 1, "type": "lookup", "card": True},
    {"q": "What was change order CO-3 on the Ocampo job for, and how much?", "expect": ["pantry", "7,850|7850"], "file": "Change order CO-3 Ocampo.pdf", "page": 1, "type": "lookup", "card": True},
    {"q": "What is the contract sum for the Ocampo job after change orders?", "expect": ["198,070|198070"], "file": "Change order CO-3 Ocampo.pdf|Pay application PA-5 Ocampo.pdf", "page": 1, "type": "total"},
    {"q": "How much retainage does the Ocampo contract hold?", "expect": ["10%"], "file": "Construction contract SP-26-07 Ocampo.pdf", "page": 1, "type": "lookup"},
    {"q": "What is the building permit number for 3127 S Los Feliz Dr?", "expect": ["BP-26-02231"], "file": "Building permit BP-26-02231 Ocampo.pdf|IMG_0507.jpg", "page": 1, "type": "lookup"},
    {"q": "When was the Ocampo addition supposed to be substantially complete?", "expect": ["08/28/2026|August 28, 2026|2026-08-28"], "file": "Construction contract SP-26-07 Ocampo.pdf", "page": 1, "type": "date"},
    {"q": "How much is due on pay application PA-5 for the Ocampo job?", "expect": ["@Pay application PA-5 Ocampo.pdf:due"], "file": "Pay application PA-5 Ocampo.pdf", "page": 1, "type": "unpaid", "card": True},
    {"q": "Which invoices are unpaid?", "expect": ["SP-INV-2611", "SP-INV-2585"], "file": "Invoice SP-INV-2611 Canyon Fold progress.pdf|Invoice SP-INV-2585 Partners.pdf", "page": 1, "type": "unpaid"},
    {"q": "How much do we owe Haverline Lumber & Truss?", "expect": ["@Haverline Lumber invoice HLT-58812.pdf:balance"], "file": "Haverline Lumber invoice HLT-58812.pdf", "page": 1, "type": "unpaid"},
    {"q": "When does Arclight Tradeworks' insurance certificate expire?", "expect": ["05/31/2027|May 31, 2027|2027-05-31"], "file": "Certificate of insurance Arclight Tradeworks.pdf", "page": 1, "type": "expiration", "card": True},
    {"q": "When does Desert Drywall Partners' insurance certificate expire?", "expect": ["08/31/2026|August 31, 2026|2026-08-31"], "file": "Certificate of insurance Desert Drywall Partners.pdf", "page": 1, "type": "expiration"},
    {"q": "Who is the framing subcontractor on the Ocampo job, and what is their subcontract amount?", "expect": ["Rimrock Framing", "28,750|28750"], "file": "Subcontract Rimrock Framing Ocampo.pdf", "page": 1, "type": "who"},
    {"q": "How deep does Lucia Ocampo want the pantry shelves?", "expect": ["16"], "file": "Site note Ocampo.jpg", "page": 1, "type": "handwritten"},
    {"q": "When is the coffee roaster being delivered to Canyon Fold?", "expect": ["10/06/2026|October 6, 2026|2026-10-06"], "file": "IMG_4410.jpg", "page": 1, "type": "date"},
    {"q": "Who is the Ocampos' mortgage lender?", "expect": [], "notInRecords": True, "type": "not-in-records"},
]
