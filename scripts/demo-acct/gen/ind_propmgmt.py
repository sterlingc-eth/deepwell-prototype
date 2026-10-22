"""Property Management - Tallgrass Mesa Property Management (fictional). Wave 1 sample paperwork."""
from builders import *

SLUG = "propmgmt"
LABEL = "Property Management"
CO = {"name": "Tallgrass Mesa Property Management", "address": "300 W Main St, Suite 210, Mesa, AZ 85201", "phone": "(480) 555-0133",
      "license": "AZ Broker License (sample) LC-661204", "pack": "property"}
MANAGER = "Henrietta Valdivia"
MAINT = "Oskar Lindgren"

SADDLE = "412 N Saddleback Rd, Unit 3, Mesa, AZ 85205"
PINYON7 = "1580 E Brown Rd, Unit 7, Mesa, AZ 85203"
PINYON2 = "1580 E Brown Rd, Unit 2, Mesa, AZ 85203"
QUAIL = "2219 S Quail Ridge Ct, Gilbert, AZ 85295"
OWNER_SADDLE = "Celestine Abernathy-Ruiz"
OWNER_PINYON = "Pinyon Court Holdings LLC"
OWNER_QUAIL = "Florian & Mae Duchesne"

VENDORS = {
    "hollis": {"name": "Hollis Appliance Service", "address": "640 W Broadway Rd, Mesa, AZ 85210", "phone": "(480) 555-0171"},
    "greenreach": {"name": "Greenreach Landscape Co.", "address": "2100 N Gilbert Rd, Mesa, AZ 85203", "phone": "(480) 555-0172"},
    "dunmore": {"name": "Dunmore Pool Care", "address": "77 S Val Vista Dr, Mesa, AZ 85204", "phone": "(480) 555-0173"},
    "brightline": {"name": "Brightline Painting & Repair", "address": "1801 E Main St, Mesa, AZ 85203", "phone": "(480) 555-0176"},
}


def lease(no, tenant, premises, owner, start, end, rent, deposit, pets="No pets", extra_tenants=None, renewal_of=None):
    secs = [
        ("1. Parties", f"This Residential Lease Agreement is made between {owner}, by its managing agent {CO['name']} (Landlord), and {tenant}"
                       f"{' and ' + extra_tenants if extra_tenants else ''} (Tenant), for the premises at {premises}."),
        ("2. Term", f"The lease term begins {long_date(start)} and ends {long_date(end)}. Tenant gives 30 days' written notice before move-out."),
        ("3. Rent", f"Monthly rent is {money(rent)}, due on the 1st of each month. Rent paid after the 5th is late and a late fee of $75.00 is charged."),
        ("4. Security deposit", f"Tenant has paid a refundable security deposit of {money(deposit)}, returned within 14 business days after move-out, less lawful deductions."),
        ("5. Utilities", "Tenant pays electricity, gas, internet and trash. Landlord pays water and sewer."),
        ("6. Pets", pets + "."),
        ("7. Maintenance", f"Tenant reports repairs through the online portal or by calling {CO['phone']}. Emergency repairs are handled 24 hours a day."),
        ("8. Entry", "Landlord may enter with 2 days' notice for repairs and inspections, or without notice in an emergency."),
        ("9. Renewal", "This lease renews only by a new written lease. If no new lease is signed, the tenancy continues month to month at the same rent plus 10%."),
    ]
    if renewal_of:
        secs.insert(2, ("Renewal", f"This lease renews lease {renewal_of} for the same premises."))
    parties = [("kv", "Tenant", tenant), ("kv", "Premises", premises), ("kv", "Owner", owner)]
    key1 = [("kv", "Lease Start", d(start)), ("kv", "Lease End", d(end)), ("kv", "Monthly Rent", money(rent)), ("kv", "Security Deposit", money(deposit))]
    return contract_pages(CO, "RESIDENTIAL LEASE AGREEMENT", no, parties, key1, secs, sign_labels=("Tenant", "Landlord / agent"))


# Rendered as messy paper (office scan / phone photo) instead of a clean PDF.
MESSY = {"Hollis Appliance invoice HAS-20877.pdf": ("scan", "scan_0812.pdf"), "Notice of entry Unit 7.pdf": ("photo", "IMG_1014.jpg")}


def build(rng):
    docs = []

    def add(file, pages, kind="pdf", facts=None):
        docs.append({"file": file, "kind": kind, "pages": pages, "facts": facts or {}})

    # ---- 412 N Saddleback Rd Unit 3: Danica Ferreira (lease, renewal, move-in, rent, dishwasher work order, owner statement)
    add("Lease L-2025-114 Ferreira 412 Saddleback Unit 3.pdf", lease("L-2025-114", "Danica Ferreira", SADDLE, OWNER_SADDLE, "2025-08-01", "2026-07-31", 1650.00, 1650.00,
        pets="One cat allowed with a $300.00 pet deposit"))
    add("Lease renewal L-2026-087 Ferreira 412 Saddleback Unit 3.pdf", lease("L-2026-087", "Danica Ferreira", SADDLE, OWNER_SADDLE, "2026-08-01", "2027-07-31", 1725.00, 1650.00,
        pets="One cat allowed with a $300.00 pet deposit", renewal_of="L-2025-114"))
    add("Move-in inspection 412 Saddleback Unit 3.pdf", [letterhead(CO) + [("title", "MOVE-IN INSPECTION"), ("kv", "Tenant", "Danica Ferreira"),
        ("kv", "Property Address", SADDLE), ("kv", "Inspection Date", "08/01/2025"), ("kv", "Inspector", MANAGER),
        ("table", ["Room / item", "Condition", "Notes"], [["Living room carpet", "Good", "Small stain by window"], ["Kitchen", "Good", "Dishwasher tested OK"],
                                                           ["Bath 1", "Fair", "Grout discolored in shower"], ["Bedroom 1", "Good", ""], ["Bedroom 2", "Good", "Blinds bent, 1 slat"]]),
        ("kv", "Smoke Detectors", "3 tested, working"), ("kv", "Keys Issued", "2 door, 1 mailbox, 1 pool fob")]])
    for m, dt in enumerate(["2026-08-01", "2026-09-01", "2026-10-01"]):
        p, f = receipt_simple(CO, f"R-{1009 + m * 41}", dt, "Danica Ferreira", SADDLE, 1725.00, "Online portal (ACH)", title="RENT RECEIPT",
                              for_what=f"Rent for {['August', 'September', 'October'][m]} 2026")
        add(f"Rent receipt R-{1009 + m * 41} Ferreira.pdf", p, facts=f)
    add("Work order WO-5512 412 Saddleback Unit 3.pdf", work_order(CO, "WO-5512", "2026-09-08", "Danica Ferreira", SADDLE, VENDORS["hollis"]["name"],
        "Dishwasher leaking onto kitchen floor", "Replaced door gasket and drain hose clamp; tested two cycles, no leak", label_tech="Assigned Vendor",
        extra=[("Owner", OWNER_SADDLE), ("Approved By", MANAGER)]))
    p, f = vendor_invoice(VENDORS["hollis"], "HAS-20931", "2026-09-09", CO["name"],
                          [("Dishwasher door gasket", 1, 64.00), ("Drain hose clamp and labor", 1, 172.00)], paid=0.0, service_address=SADDLE)
    add("Hollis Appliance invoice HAS-20931.pdf", p, facts=f)
    p, f = statement(CO, "OWNER STATEMENT", "OS-2026-09-ABR", "2026-09-30", OWNER_SADDLE, [("Property", SADDLE), ("Period", "09/01/2026 - 09/30/2026")],
                     rows_table=(["Item", "Amount"], [["Rent collected (Danica Ferreira)", "$1,725.00"], ["Management fee (8%)", "-$138.00"],
                                                     ["Dishwasher repair, Hollis Appliance HAS-20931", "-$236.00"]]), total=1351.00, label_total="Net Paid to Owner")
    add("Owner statement September 2026 Abernathy-Ruiz.pdf", p, facts=f)

    # ---- Pinyon Court Unit 7: Rafferty Osei (late rent, ledger, phone note)
    add("Lease L-2026-041 Osei 1580 Brown Unit 7.pdf", lease("L-2026-041", "Rafferty Osei", PINYON7, OWNER_PINYON, "2026-03-01", "2027-02-28", 1395.00, 1395.00))
    add("Late rent notice Osei Unit 7.pdf", letter(CO, "2026-10-06", ["Rafferty Osei", PINYON7], "Late rent for October 2026", [
        "Our records show that rent of $1,395.00 due on October 1, 2026 has not been received. Under section 3 of your lease, a late fee of $75.00 has been added.",
        "The total now due is $1,470.00. Please pay through the online portal or call our office to make arrangements.",
        "If you have already paid, thank you, and please disregard this notice."], f"{MANAGER}, Property Manager"))
    p, f = statement(CO, "TENANT LEDGER", "TL-OSEI-2026", "2026-10-06", "Rafferty Osei", [("Property Address", PINYON7)],
                     rows_table=(["Date", "Description", "Charge", "Payment"], [["08/01/2026", "August rent", "$1,395.00", ""], ["08/03/2026", "Payment - ACH", "", "$1,395.00"],
                                                                         ["09/01/2026", "September rent", "$1,395.00", ""], ["09/02/2026", "Payment - ACH", "", "$1,395.00"],
                                                                         ["10/01/2026", "October rent", "$1,395.00", ""], ["10/06/2026", "Late fee", "$75.00", ""]]),
                     total=1470.00, label_total="Balance Due")
    add("Tenant ledger Osei Unit 7.pdf", p, facts=f)
    add("Phone message Osei Unit 7.jpg", [], kind="handwritten", facts={"lines": [
        "10/14  Unit 7 - Rafferty Osei", "water heater pilot out, no hot water", "OK to enter Thurs after 10am", "has a cat - keep door closed",
        "cell (480) 555-0195", "- Henrietta"]})

    # ---- Pinyon Court Unit 2 + building items
    add("Lease L-2025-162 Iwasaki 1580 Brown Unit 2.pdf", lease("L-2025-162", "Noriko Iwasaki", PINYON2, OWNER_PINYON, "2025-11-01", "2026-10-31", 1360.00, 1360.00))
    add("Work order WO-5530 1580 Brown Unit 7.pdf", work_order(CO, "WO-5530", "2026-10-15", "Rafferty Osei", PINYON7, MAINT,
        "No hot water", "Relit water heater pilot, replaced thermocouple, hot water restored", label_tech="Assigned To",
        extra=[("Owner", OWNER_PINYON), ("Approved By", MANAGER)]))
    p, f = vendor_invoice(VENDORS["greenreach"], "GRL-8814", "2026-09-30", CO["name"],
                          [("Monthly landscape maintenance, 1580 E Brown Rd, September", 1, 385.00), ("Replace 2 irrigation valves", 2, 64.50)], paid=0.0, service_address="1580 E Brown Rd, Mesa, AZ 85203")
    add("Greenreach invoice GRL-8814.pdf", p, facts=f)
    add("Certificate of insurance Greenreach Landscape.pdf", coi("Cactus Mutual Insurance Co.", "C-77120", VENDORS["greenreach"]["name"], CO["name"],
        "2026-04-01", "2027-03-31", 1000000))
    add("Certificate of insurance Dunmore Pool Care.pdf", coi("Sonoran Shield Insurance", "C-55418", VENDORS["dunmore"]["name"], CO["name"],
        "2025-10-01", "2026-09-30", 1000000))
    p, f = vendor_invoice(VENDORS["dunmore"], "DPC-3305", "2026-08-31", CO["name"], [("Weekly pool service, August 2026, 1580 E Brown Rd", 1, 340.00)], paid=340.00)
    add("Dunmore Pool Care invoice DPC-3305.pdf", p, facts=f)
    add("HOA violation notice Quail Ridge.pdf", letter({"name": "Quail Ridge Community Association", "address": "PO Box 5512, Gilbert, AZ 85299", "phone": "(480) 555-0109"},
        "2026-09-22", [OWNER_QUAIL, f"c/o {CO['name']}", QUAIL], "Courtesy notice - trash containers visible from street",
        ["During the community inspection on September 18, 2026, trash containers at the property were visible from the street on a non-collection day.",
         "Please store containers out of view by October 6, 2026. A fine of $50.00 may be assessed for a second notice."], "Community Manager"))

    # ---- 2219 S Quail Ridge Ct: Duchesne owners, tenant Ambrose Kittredge
    add("Lease L-2026-055 Kittredge 2219 Quail Ridge.pdf", lease("L-2026-055", "Ambrose Kittredge", QUAIL, OWNER_QUAIL, "2026-05-15", "2027-05-14", 2450.00, 2450.00,
        pets="One dog under 40 lb allowed with a $400.00 pet deposit", extra_tenants="Lucia Kittredge"))
    add("Management agreement Duchesne.pdf", contract_pages(CO, "PROPERTY MANAGEMENT AGREEMENT", "PMA-2026-008",
        [("kv", "Owner", OWNER_QUAIL), ("kv", "Property Address", QUAIL)],
        [("kv", "Effective Date", "05/01/2026"), ("kv", "Expiration Date", "04/30/2027"), ("kv", "Management Fee", "8% of rent collected"), ("kv", "Leasing Fee", "50% of first month's rent")],
        [("1. Services", "Manager will advertise, screen applicants, sign leases, collect rent, handle maintenance up to $500 per repair without prior approval, and send monthly owner statements."),
         ("2. Owner funds", "Manager keeps a $500.00 reserve for the property. Net rents are paid to the owner by the 10th of each month."),
         ("3. Term and termination", "Either party may end this agreement with 30 days' written notice after the first 6 months.")],
        sign_labels=("Owner", "Manager")))
    p, f = vendor_invoice(VENDORS["brightline"], "BPR-1290", "2026-05-08", CO["name"],
                          [("Interior repaint before move-in, 3 bed / 2 bath", 1, 2850.00), ("Drywall patch, hallway", 1, 180.00)], paid=3030.00)
    add("Brightline Painting invoice BPR-1290.pdf", p, facts=f)
    p, f = receipt_simple(CO, "R-1006", "2026-05-15", "Ambrose Kittredge", QUAIL, 5300.00, "Cashier's check 004417",
                          title="RECEIPT", for_what="First month's rent $2,450.00, security deposit $2,450.00, pet deposit $400.00")
    add("Move-in funds receipt R-1006 Kittredge.pdf", p, facts=f)

    # ---- scans / photos / volume
    p, f = vendor_invoice({"name": "Mesa Lock & Key Works", "address": "15 N Center St, Mesa, AZ 85201", "phone": "(480) 555-0178"}, "MLK-4471", "2026-09-29",
                          CO["name"], [("Rekey 2 locks after move-out, 1580 E Brown Rd Unit 5", 2, 45.00), ("Service call", 1, 65.00)], paid=0.0)
    add("scan_0929.pdf", p, kind="scan", facts=f)
    add("IMG_0815.jpg", work_order(CO, "WO-5498", "2026-08-15", "Noriko Iwasaki", PINYON2, MAINT, "Bathroom fan noisy",
        "Replaced bathroom exhaust fan motor; cleaned duct", label_tech="Assigned To", extra=[("Owner", OWNER_PINYON)]), kind="photo")
    for m, (dt, tenant, addr, amt) in enumerate([("2026-08-01", "Rafferty Osei", PINYON7, 1395.00), ("2026-09-01", "Rafferty Osei", PINYON7, 1395.00),
                                                ("2026-09-01", "Noriko Iwasaki", PINYON2, 1360.00), ("2026-10-01", "Noriko Iwasaki", PINYON2, 1360.00),
                                                ("2026-09-01", "Ambrose Kittredge", QUAIL, 2450.00), ("2026-10-01", "Ambrose Kittredge", QUAIL, 2450.00)]):
        p, f = receipt_simple(CO, f"R-{1100 + m * 7}", dt, tenant, addr, amt, "Online portal (ACH)", title="RENT RECEIPT", for_what=f"Rent for {['August', 'September'][0 if dt[5:7] == '08' else 1] if dt[5:7] != '10' else 'October'} 2026")
        add(f"Rent receipt R-{1100 + m * 7} {tenant.split()[-1]}.pdf", p, facts=f)
    for m, (owner, prop, rent, extra_cost, extra_label) in enumerate([(OWNER_PINYON, "1580 E Brown Rd (Units 2 and 7)", 2755.00, 725.00, "Landscape and pool"),
                                                                        (OWNER_QUAIL, QUAIL, 2450.00, 0.0, None)]):
        rows_ = [["Rent collected", money(rent)], ["Management fee (8%)", money(-round(rent * 0.08, 2))]]
        if extra_cost:
            rows_.append([extra_label, money(-extra_cost)])
        net = round(rent - rent * 0.08 - extra_cost, 2)
        p, f = statement(CO, "OWNER STATEMENT", f"OS-2026-09-{m + 2:02d}", "2026-09-30", owner, [("Property", prop), ("Period", "09/01/2026 - 09/30/2026")],
                         rows_table=(["Item", "Amount"], rows_), total=net, label_total="Net Paid to Owner")
        add(f"Owner statement September 2026 {owner.split()[0]}.pdf", p, facts=f)
    add("Move-out inspection 1580 Brown Unit 5.pdf", [letterhead(CO) + [("title", "MOVE-OUT INSPECTION"), ("kv", "Tenant", "Bartholomew Nkemelu"),
        ("kv", "Property Address", "1580 E Brown Rd, Unit 5, Mesa, AZ 85203"), ("kv", "Inspection Date", "09/26/2026"), ("kv", "Inspector", MANAGER),
        ("kv", "Findings", "Carpet stain in bedroom 2 beyond normal wear; 2 keys not returned"),
        ("kv", "Deposit Deductions", "Carpet cleaning $145.00; rekey $155.00"), ("kv", "Deposit Refund", "$1,000.00 of $1,300.00")]])
    add("Deposit disposition letter Nkemelu.pdf", letter(CO, "2026-10-08", ["Bartholomew Nkemelu", "88 W Pepper Pl, Mesa, AZ 85201"], "Security deposit, 1580 E Brown Rd, Unit 5", [
        "Your security deposit of $1,300.00 has been reviewed after your move-out on September 26, 2026.",
        "Deductions: carpet cleaning in bedroom 2, $145.00; rekeying for 2 unreturned keys, $155.00. Your refund of $1,000.00 is enclosed as check 2291."], f"{MANAGER}, Property Manager"))
    add("Notice of entry Unit 7.pdf", letter(CO, "2026-10-14", ["Rafferty Osei", PINYON7], "Notice of entry for repair", [
        "Our maintenance technician will enter your unit on Thursday, October 15, 2026 after 10:00 am to repair the water heater.",
        "Please keep your cat secured. Call our office if this time does not work for you."], f"{MANAGER}, Property Manager"))
    add("Renewal offer Iwasaki Unit 2.pdf", letter(CO, "2026-09-02", ["Noriko Iwasaki", PINYON2], "Lease renewal offer", [
        "Your lease for 1580 E Brown Rd, Unit 2 ends on October 31, 2026. We are pleased to offer a 12-month renewal from November 1, 2026 at $1,395.00 per month.",
        "Please sign the renewal through the portal by October 1, 2026, or let us know if you plan to move out."], f"{MANAGER}, Property Manager"))
    p, f = vendor_invoice(VENDORS["hollis"], "HAS-20877", "2026-08-12", CO["name"],
                          [("Refrigerator ice maker valve, 1580 E Brown Rd Unit 2", 1, 148.00)], paid=148.00)
    add("Hollis Appliance invoice HAS-20877.pdf", p, facts=f)
    p, f = vendor_invoice(VENDORS["dunmore"], "DPC-3341", "2026-09-30", CO["name"], [("Weekly pool service, September 2026, 1580 E Brown Rd", 1, 340.00)], paid=340.00)
    add("Dunmore Pool Care invoice DPC-3341.pdf", p, facts=f)
    p, f = vendor_invoice(VENDORS["greenreach"], "GRL-8760", "2026-08-31", CO["name"], [("Monthly landscape maintenance, 1580 E Brown Rd, August", 1, 385.00)], paid=385.00)
    add("Greenreach invoice GRL-8760.pdf", p, facts=f)
    return docs


QUESTIONS = [
    {"q": "When does Danica Ferreira's lease end?", "expect": ["07/31/2027|July 31, 2027|2027-07-31"], "file": "Lease renewal L-2026-087 Ferreira 412 Saddleback Unit 3.pdf", "page": 1, "type": "expiration", "card": True},
    {"q": "What is the monthly rent at 412 N Saddleback Rd Unit 3?", "expect": ["1,725.00|1725"], "file": "Lease renewal L-2026-087 Ferreira 412 Saddleback Unit 3.pdf|Rent receipt R-1091 Ferreira.pdf|Rent receipt R-1050 Ferreira.pdf|Rent receipt R-1009 Ferreira.pdf", "page": 1, "type": "lookup", "card": True},
    {"q": "How much is Danica Ferreira's security deposit?", "expect": ["1,650.00|1650"], "file": "Lease renewal L-2026-087 Ferreira 412 Saddleback Unit 3.pdf|Lease L-2025-114 Ferreira 412 Saddleback Unit 3.pdf", "page": 1, "type": "lookup"},
    {"q": "How much does Rafferty Osei owe?", "expect": ["1,470.00|1470"], "file": "Tenant ledger Osei Unit 7.pdf|Late rent notice Osei Unit 7.pdf", "page": 1, "type": "unpaid", "card": True},
    {"q": "Which vendor invoices are unpaid?", "expect": ["HAS-20931", "GRL-8814"], "file": "Hollis Appliance invoice HAS-20931.pdf|Greenreach invoice GRL-8814.pdf|scan_0929.pdf", "page": 1, "type": "unpaid"},
    {"q": "Who fixed the dishwasher at 412 N Saddleback Rd?", "expect": ["Hollis Appliance"], "file": "Work order WO-5512 412 Saddleback Unit 3.pdf|Hollis Appliance invoice HAS-20931.pdf", "page": 1, "type": "who", "card": True},
    {"q": "How much was paid to Celestine Abernathy-Ruiz for September 2026?", "expect": ["1,351.00|1351"], "file": "Owner statement September 2026 Abernathy-Ruiz.pdf", "page": 1, "type": "total"},
    {"q": "When does Greenreach Landscape's insurance certificate expire?", "expect": ["03/31/2027|March 31, 2027|2027-03-31"], "file": "Certificate of insurance Greenreach Landscape.pdf", "page": 1, "type": "expiration", "card": True},
    {"q": "When does the Dunmore Pool Care insurance certificate expire?", "expect": ["09/30/2026|September 30, 2026|2026-09-30"], "file": "Certificate of insurance Dunmore Pool Care.pdf", "page": 1, "type": "expiration"},
    {"q": "What is the pet policy in the Kittredge lease?", "expect": ["dog"], "file": "Lease L-2026-055 Kittredge 2219 Quail Ridge.pdf", "page": "find:dog under 40 lb", "type": "lookup"},
    {"q": "What's wrong in Unit 7 at 1580 E Brown Rd, and when can we go in?", "expect": ["pilot", "thur"], "file": "Phone message Osei Unit 7.jpg", "page": 1, "type": "handwritten"},
    {"q": "How much of Bartholomew Nkemelu's deposit was refunded?", "expect": ["1,000.00|1000"], "file": "Deposit disposition letter Nkemelu.pdf|Move-out inspection 1580 Brown Unit 5.pdf", "page": 1, "type": "total"},
    {"q": "What is the management fee in the Duchesne management agreement?", "expect": ["8%"], "file": "Management agreement Duchesne.pdf", "page": 1, "type": "lookup"},
    {"q": "When does Noriko Iwasaki's lease end?", "expect": ["10/31/2026|October 31, 2026|2026-10-31"], "file": "Lease L-2025-162 Iwasaki 1580 Brown Unit 2.pdf", "page": 1, "type": "expiration"},
    {"q": "Who is Rafferty Osei's employer?", "expect": [], "notInRecords": True, "type": "not-in-records"},
]
