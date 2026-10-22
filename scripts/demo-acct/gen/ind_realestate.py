"""Real Estate - Quailbrush Realty Group (fictional brokerage). Wave 1 sample paperwork."""
from builders import *

SLUG = "realestate"
LABEL = "Real Estate"
CO = {"name": "Quailbrush Realty Group", "address": "1661 S Alma School Rd, Suite 104, Mesa, AZ 85210", "phone": "(480) 555-0115",
      "license": "AZ Brokerage License (sample) LC-648812", "pack": None}
BROKER = "Bettina Holloway"
AGENTS = ["Javier Okoro-Lind", "Mireille Sandoval", "Bettina Holloway"]
ESCROW = {"name": "Saguaro Title & Escrow", "address": "2450 E Baseline Rd, Suite 300, Mesa, AZ 85204", "phone": "(480) 555-0181"}

PINON = "5532 E Pinon Grove Ln, Mesa, AZ 85215"
NOPAL = "1218 W Nopal Ave, Mesa, AZ 85202"
LARK = "3906 E Larkspur Dr, Gilbert, AZ 85297"
CANAL = "741 N Canal Bend Way, Chandler, AZ 85226"


def purchase_contract(no, address, sellers, buyers, price, earnest, coe, agent_buy, agent_sell, inspection_days=10, extras=None):
    secs = [
        ("1. Property", f"Buyer agrees to buy and Seller agrees to sell the real property at {address}, with all fixtures and the following personal property: refrigerator, washer, dryer."),
        ("2. Purchase price", f"The purchase price is {money(price)}, paid as earnest money of {money(earnest)}, a new conventional loan, and the balance in cash at close of escrow."),
        ("3. Earnest money", f"Earnest money of {money(earnest)} is deposited with {ESCROW['name']} within 3 business days of acceptance."),
        ("4. Close of escrow", f"Close of escrow will be on or before {long_date(coe)}. Possession passes to Buyer at close of escrow."),
        ("5. Inspection period", f"Buyer has {inspection_days} days after acceptance to complete inspections and deliver any notice of disapproval."),
        ("6. Appraisal", "If the property appraises below the purchase price, Buyer may cancel within 5 days of the appraisal notice and receive the earnest money back."),
        ("7. Home warranty", (extras or {}).get("warranty", "Seller will pay up to $550.00 for a one-year home warranty plan for Buyer.")),
        ("8. Seller concessions", (extras or {}).get("concessions", "None.")),
        ("9. Brokers", f"Buyer's broker: {CO['name']} ({agent_buy}). Seller's broker: {CO['name'] if agent_sell else 'see listing'} ({agent_sell or 'n/a'})."),
        ("10. Additional terms", (extras or {}).get("additional", "None.")),
    ]
    parties = [("kv", "Buyer", buyers), ("kv", "Seller", sellers), ("kv", "Property Address", address)]
    key1 = [("kv", "Purchase Price", money(price)), ("kv", "Earnest Money", money(earnest)), ("kv", "Close of Escrow", d(coe)), ("kv", "Acceptance Date", (extras or {}).get("accepted", ""))]
    return contract_pages(CO, "RESIDENTIAL PURCHASE CONTRACT", no, parties, key1, secs, sign_labels=("Buyer", "Seller"))


def listing_agreement(no, address, sellers, price, start, end, rate, agent):
    secs = [
        ("1. Listing", f"Seller grants {CO['name']} the exclusive right to sell the property at {address} for {money(price)} or any price Seller accepts."),
        ("2. Term", f"This listing begins {long_date(start)} and ends {long_date(end)}."),
        ("3. Commission", f"Seller pays a total commission of {rate} of the sale price at close of escrow, shared with any cooperating buyer's broker as offered in the MLS."),
        ("4. Marketing", "Broker will provide professional photography, a lockbox, a yard sign and MLS and online marketing."),
        ("5. Seller duties", "Seller completes the seller property disclosure statement within 5 days and keeps the property in showing condition."),
    ]
    parties = [("kv", "Seller", sellers), ("kv", "Property Address", address), ("kv", "Listing Agent", agent)]
    key1 = [("kv", "List Price", money(price)), ("kv", "Listing Start", d(start)), ("kv", "Listing Expiration", d(end)), ("kv", "Commission", rate)]
    return contract_pages(CO, "EXCLUSIVE RIGHT TO SELL LISTING AGREEMENT", no, parties, key1, secs, sign_labels=("Seller", "Broker"))


# Rendered as messy paper (office scan / phone photo) instead of a clean PDF.
MESSY = {"Mesa Sign Post invoice MSP-2290.pdf": ("scan", "scan_0302.pdf"), "Open house sign-in Larkspur.pdf": ("photo", "IMG_0927.jpg")}


def build(rng):
    docs = []

    def add(file, pages, kind="pdf", facts=None):
        docs.append({"file": file, "kind": kind, "pages": pages, "facts": facts or {}})

    # ---- Listing at 5532 E Pinon Grove Ln (sellers Abernethy) -> contract with Lindqvist buyers -> closed
    add("Listing agreement LA-26-031 Pinon Grove.pdf", listing_agreement("LA-26-031", PINON, "Gareth and Noor Abernethy", 612000.00, "2026-03-01", "2026-08-31", "5%", "Mireille Sandoval"))
    add("Purchase contract 5532 E Pinon Grove Ln.pdf", purchase_contract("PC-26-044", PINON, "Gareth and Noor Abernethy", "Theo and Ama Lindqvist", 598500.00,
        10000.00, "2026-05-29", "Javier Okoro-Lind", "Mireille Sandoval",
        extras={"accepted": "04/16/2026", "concessions": "Seller credits Buyer $4,500.00 toward closing costs.",
                "additional": "Seller will repair the cracked tile at the back patio before close of escrow."}))
    p, f = receipt_simple(ESCROW, "EM-2026-014", "2026-04-18", "Theo and Ama Lindqvist", PINON, 10000.00, "Wire transfer", title="RECEIPT",
                          for_what="Earnest money, purchase contract PC-26-044")
    add("Earnest money receipt EM-2026-014 Lindqvist.pdf", p, facts=f)
    add("Home inspection summary 5532 E Pinon Grove Ln.pdf", inspection({"name": "Bright Eye Home Inspections", "address": "512 W Southern Ave, Mesa, AZ 85210",
        "phone": "(480) 555-0185", "license": "Certified inspector #(sample) 61207"}, "2026-04-21", "Theo and Ama Lindqvist", PINON, "Corbin Ashgrove",
        "Water heater is 13 years old and near end of life; two cracked roof tiles above the garage; GFCI missing at the wet bar",
        notes="Home inspection for the buyers. Buyer requested repair of the roof tiles and GFCI; seller agreed on 04/24/2026.", title="INSPECTION REPORT", label_tech="Inspector"))
    p, f = statement(CO, "STATEMENT", "CS-26-044", "2026-05-29", "Gareth and Noor Abernethy", [("Property Address", PINON),
        ("Sale Price", "$598,500.00"), ("Close of Escrow", "05/29/2026")],
        rows_table=(["Item", "Amount"], [["Listing side, 2.5% (Mireille Sandoval)", "$14,962.50"], ["Buyer side, 2.5% (Javier Okoro-Lind)", "$14,962.50"]]),
        total=29925.00, label_total="Total")
    add("Commission statement CS-26-044 Pinon Grove.pdf", p, facts=f)
    p, f = vendor_invoice({"name": "Lumen & Lane Photography", "address": "88 N Macdonald, Mesa, AZ 85201", "phone": "(480) 555-0186"}, "LLP-0412", "2026-03-04",
                          CO["name"], [("Listing photos, 36 images, 5532 E Pinon Grove Ln", 1, 295.00), ("Drone exterior set", 1, 80.00)], paid=375.00)
    add("Lumen & Lane invoice LLP-0412.pdf", p, facts=f)
    p, f = vendor_invoice({"name": "Mesa Sign Post Co.", "address": "2001 W Broadway Rd, Mesa, AZ 85202", "phone": "(480) 555-0187"}, "MSP-2290", "2026-03-02",
                          CO["name"], [("Sign post install, 5532 E Pinon Grove Ln", 1, 95.00)], paid=95.00)
    add("Mesa Sign Post invoice MSP-2290.pdf", p, facts=f)

    # ---- Buyer client Saoirse Delacroix: buyer agreement, offer on 1218 W Nopal (rejected), showing note, lockbox photo
    add("Buyer broker agreement BA-26-019 Delacroix.pdf", contract_pages(CO, "BUYER BROKER AGREEMENT", "BA-26-019",
        [("kv", "Buyer", "Saoirse Delacroix"), ("kv", "Buyer Agent", "Javier Okoro-Lind")],
        [("kv", "Effective Date", "07/01/2026"), ("kv", "Expiration Date", "12/31/2026"), ("kv", "Compensation", "2.5% of purchase price")],
        [("1. Search area", "Single-family homes in Mesa, Tempe and Chandler, 3+ bedrooms, up to $450,000."),
         ("2. Compensation", "Broker is paid 2.5% of the purchase price at close of escrow, first from any seller-offered compensation."),
         ("3. Term", "This agreement ends December 31, 2026 or at close of escrow on a purchase, whichever is first.")], sign_labels=("Buyer", "Broker")))
    add("Purchase contract 1218 W Nopal Ave (not accepted).pdf", purchase_contract("PC-26-071", NOPAL, "Estate of Florence Bixby", "Saoirse Delacroix", 418000.00, 5000.00,
        "2026-10-30", "Javier Okoro-Lind", None, extras={"accepted": "Not accepted - seller countered at $432,000 on 09/19/2026",
        "additional": "Buyer asks seller to replace the cracked front window before close of escrow."}))
    add("Showing feedback Nopal.jpg", [], kind="handwritten", facts={"lines": [
        "Showing 9/14 - 1218 W Nopal", "Saoirse loved the kitchen + yard", "worried about road noise", "(back bedroom faces Dobson)",
        "may offer under ask - talk Mon", "- Javier"]})
    add("IMG_7731.jpg", [letterhead(CO) + [("title", "SHOWING INSTRUCTIONS"), ("kv", "Property Address", NOPAL), ("kv", "Listing Agent", "Pruett Wexley, Ironbark Homes Realty"),
        ("kv", "Lockbox", "Front door, code 2719"), ("kv", "Occupancy", "Vacant"), ("kv", "Alarm", "None"),
        ("kv", "Notes", "Lock the back slider and turn off all lights. Text listing agent after showing (480) 555-0188.")]], kind="photo")

    # ---- Listing at 3906 E Larkspur Dr (active), sellers Okwuosa
    add("Listing agreement LA-26-058 Larkspur.pdf", listing_agreement("LA-26-058", LARK, "Chidi and Marisol Okwuosa", 539000.00, "2026-09-10", "2027-03-09", "5%", "Bettina Holloway"))
    add("Seller disclosure 3906 E Larkspur Dr.pdf", contract_pages(CO, "SELLER PROPERTY DISCLOSURE STATEMENT", "SPDS-26-058",
        [("kv", "Seller", "Chidi and Marisol Okwuosa"), ("kv", "Property Address", LARK)], [("kv", "Year Built", "2004"), ("kv", "Date Completed", "09/12/2026")],
        [("Roof", "Tile roof, underlayment replaced in 2021 by the previous owner. No known leaks."),
         ("Plumbing", "Water softener installed 2019. Kitchen sink drain replaced 2024."),
         ("Heating and cooling", "Two AC units: 2017 (downstairs) and 2022 (upstairs). Serviced every spring."),
         ("Pool", "Pool resurfaced in 2023. Pool equipment: variable-speed pump installed 2023."),
         ("HOA", "Larkspur Estates HOA, $86.00 per month, paid through the community manager."),
         ("Known defects", "Minor crack in the garage floor slab. Back gate latch sticks.")], sign_labels=("Seller",)))
    p, f = vendor_invoice({"name": "Prairiefold Home Staging", "address": "620 E Ray Rd, Gilbert, AZ 85296", "phone": "(480) 555-0189"}, "PHS-1147", "2026-09-15",
                          CO["name"], [("Staging, 3906 E Larkspur Dr, first month (living, dining, primary bedroom)", 1, 2400.00)], paid=0.0)
    add("Prairiefold staging invoice PHS-1147.pdf", p, facts=f)

    # ---- Closed sale at 741 N Canal Bend Way (buyer side), plus brokerage paperwork
    add("Purchase contract 741 N Canal Bend Way.pdf", purchase_contract("PC-26-052", CANAL, "Lorcan and Bea Fitzwilliam", "Harriet Oduya", 467000.00, 7500.00,
        "2026-07-17", "Mireille Sandoval", None, extras={"accepted": "06/09/2026", "warranty": "Buyer will purchase a home warranty plan at close."}))
    p, f = receipt_simple(ESCROW, "EM-2026-022", "2026-06-11", "Harriet Oduya", CANAL, 7500.00, "Cashier's check", title="RECEIPT",
                          for_what="Earnest money, purchase contract PC-26-052")
    add("Earnest money receipt EM-2026-022 Oduya.pdf", p, facts=f)
    p, f = statement(CO, "STATEMENT", "CS-26-052", "2026-07-17", "Harriet Oduya", [("Property Address", CANAL), ("Sale Price", "$467,000.00"),
        ("Close of Escrow", "07/17/2026")], rows_table=(["Item", "Amount"], [["Buyer side, 2.5% (Mireille Sandoval)", "$11,675.00"]]), total=11675.00, label_total="Total")
    add("Commission statement CS-26-052 Canal Bend.pdf", p, facts=f)
    add("Certificate of insurance E&O Quailbrush.pdf", coi("Ponderosa Professional Insurance", "EO-26-3391", CO["name"], CO["name"], "2026-07-01", "2027-06-30", 1000000,
        wc=False, producer="Errors and Omissions Insurance"))
    add("Scan_HOA_resale_Larkspur.pdf", [[("brand", "Larkspur Estates Homeowners Association"), ("head", "c/o Verdant Community Management, PO Box 30911, Gilbert, AZ 85299"),
        ("head", "(480) 555-0110"), ("title", "HOA RESALE DISCLOSURE"), ("kv", "Property Address", LARK), ("kv", "Owner", "Chidi and Marisol Okwuosa"),
        ("kv", "Regular Assessment", "$86.00 per month"), ("kv", "Transfer Fee", "$400.00"), ("kv", "Capital Contribution", "$258.00"),
        ("kv", "Account Status", "Paid through 09/30/2026"), ("kv", "Violations", "None open"), ("kv", "Date Issued", "09/18/2026")]], kind="scan")

    # ---- everyday volume: listing marketing invoices, more transactions, referral, agent paperwork
    deals = [("2025-11-14", "2240 W Isabella Ave, Mesa, AZ 85202", "Pell Grantham", 389000.00, "Javier Okoro-Lind"),
             ("2026-01-30", "16 E Hackamore St, Gilbert, AZ 85233", "Wren and Ola Abiodun", 512500.00, "Mireille Sandoval"),
             ("2026-03-20", "9110 E Sunland Ave, Mesa, AZ 85208", "Lysander Coates", 344900.00, "Bettina Holloway"),
             ("2026-06-26", "3341 S Gila Ln, Chandler, AZ 85286", "Amara Quist-Nyberg", 621000.00, "Javier Okoro-Lind"),
             ("2026-08-14", "502 N Vineyard, Mesa, AZ 85201", "Tomasz and Ines Wrobel", 298750.00, "Mireille Sandoval"),
             ("2026-09-25", "7006 E Ingram St, Mesa, AZ 85207", "Faye Okonedo", 455000.00, "Bettina Holloway")]
    for i, (dt, addr, client, price, agent) in enumerate(deals):
        comm = round(price * 0.025, 2)
        p, f = statement(CO, "STATEMENT", f"CS-{dt[2:4]}-{80 + i}", dt, client, [("Property Address", addr), ("Sale Price", money(price)), ("Close of Escrow", d(dt))],
                         rows_table=(["Item", "Amount"], [[f"Buyer side, 2.5% ({agent})", money(comm)]]), total=comm, label_total="Total")
        add(f"Commission statement CS-{dt[2:4]}-{80 + i} {client.split()[-1]}.pdf", p, facts=f)
        p, f = receipt_simple(ESCROW, f"EM-{dt[:4]}-{30 + i}", add_days(dt, -32), client, addr, 5000.00 if price < 450000 else 10000.00, "Wire transfer",
                              title="RECEIPT", for_what="Earnest money")
        add(f"Earnest money receipt EM-{dt[:4]}-{30 + i} {client.split()[-1]}.pdf", p, facts=f)
    for i, (dt, desc, amt) in enumerate([("2026-01-05", "Listing photos, 16 E Hackamore St", 295.00), ("2026-02-27", "Listing photos and twilight set, 9110 E Sunland Ave", 345.00),
                                          ("2026-09-11", "Listing photos and video walkthrough, 3906 E Larkspur Dr", 495.00)]):
        p, f = vendor_invoice({"name": "Lumen & Lane Photography", "address": "88 N Macdonald, Mesa, AZ 85201", "phone": "(480) 555-0186"}, f"LLP-0{390 + i * 17}", dt,
                              CO["name"], [(desc, 1, amt)], paid=amt if i < 2 else 0.0)
        add(f"Lumen & Lane invoice LLP-0{390 + i * 17}.pdf", p, facts=f)
    p, f = invoice(CO, "QR-2026-007", "2026-08-03", "Desert Lantern Relocation", "4802 E Ray Rd, Phoenix, AZ 85044",
                   [("Referral fee, buyer Amara Quist-Nyberg, 3341 S Gila Ln (25% of buyer-side commission)", 1, 3881.25)], paid=0.0, title="INVOICE")
    add("Referral fee invoice QR-2026-007.pdf", p, facts=f)
    add("Counter offer 1218 W Nopal Ave.pdf", [letterhead({"name": "Ironbark Homes Realty", "address": "330 N Gilbert Rd, Gilbert, AZ 85234", "phone": "(480) 555-0188"})
        + [("title", "SELLER COUNTER OFFER"), ("kv", "Property Address", NOPAL), ("kv", "Buyer", "Saoirse Delacroix"), ("kv", "Seller", "Estate of Florence Bixby"),
           ("kv", "Counter Date", "09/19/2026"), ("kv", "Counter Price", "$432,000.00"), ("kv", "Expires", "09/21/2026 at 5:00 pm"),
           ("kv", "Other Terms", "Seller will not replace the front window; all other terms of the buyer's offer accepted."), ("kv", "Response", "Buyer let the counter expire")]])
    add("Appraisal summary 5532 E Pinon Grove Ln.pdf", [[("brand", "Westward Valuation Group"), ("head", "1414 E Southern Ave, Tempe, AZ 85282"), ("head", "(480) 555-0190"),
        ("title", "APPRAISAL SUMMARY"), ("kv", "Property Address", PINON), ("kv", "Borrower", "Theo and Ama Lindqvist"), ("kv", "Effective Date", "05/06/2026"),
        ("kv", "Appraised Value", "$601,000.00"), ("kv", "Contract Price", "$598,500.00"), ("kv", "Gross Living Area", "2,388 sq ft"),
        ("kv", "Comparable Sales", "3 sales within 0.6 miles, adjusted range $589,000 to $612,500")]])
    add("Inspection notice and seller response Pinon Grove.pdf", [letterhead(CO) + [("title", "BUYER INSPECTION NOTICE AND SELLER RESPONSE"),
        ("kv", "Property Address", PINON), ("kv", "Buyer", "Theo and Ama Lindqvist"), ("kv", "Seller", "Gareth and Noor Abernethy"), ("kv", "Notice Date", "04/23/2026"),
        ("kv", "Buyer Requests", "Replace two cracked roof tiles above garage; install GFCI at wet bar"), ("kv", "Seller Response", "Agreed to both repairs, 04/24/2026"),
        ("kv", "Repairs Completed", "05/20/2026 by licensed contractor, receipts provided")]])
    add("Open house sign-in Larkspur.pdf", [letterhead(CO) + [("title", "OPEN HOUSE SIGN-IN"), ("kv", "Property Address", LARK), ("kv", "Date", "09/27/2026"),
        ("kv", "Hosted By", "Bettina Holloway"), ("table", ["Visitor", "Working with an agent", "Follow up"], [["Delphine and Ravi Achari", "No", "Yes - wants pool homes"],
        ["Mattias Grell", "Yes (Ironbark Homes)", "No"], ["Oona Feeney", "No", "Yes - sell first"], ["Kofi Brandt-Asante", "No", "Yes"]])]])
    add("Referral agreement Desert Lantern Relocation.pdf", [letterhead(CO) + [("title", "REFERRAL AGREEMENT"), ("kv", "Referring Company", "Desert Lantern Relocation"),
        ("kv", "Receiving Broker", CO["name"]), ("kv", "Client Referred", "Amara Quist-Nyberg"), ("kv", "Referral Fee", "25% of the buyer-side commission at close"),
        ("kv", "Effective Date", "05/02/2026"), ("kv", "Expiration Date", "05/01/2027")]])
    add("Agent license renewal Okoro-Lind.pdf", [[("brand", "State Real Estate Licensing Office"), ("head", "100 N 15th Ave, Phoenix, AZ 85007"), ("head", "(602) 555-0105"),
        ("title", "LICENSE RENEWAL CONFIRMATION"), ("kv", "Licensee", "Javier Okoro-Lind"), ("kv", "License #", "SA-(sample) 690412"), ("kv", "Employing Broker", CO["name"]),
        ("kv", "Renewed On", "02/14/2026"), ("kv", "License Expires", "02/28/2028"), ("kv", "Continuing Education", "24 hours completed")]])
    return docs


QUESTIONS = [
    {"q": "What did 5532 E Pinon Grove Ln sell for?", "expect": ["598,500|598500"], "file": "Purchase contract 5532 E Pinon Grove Ln.pdf|Commission statement CS-26-044 Pinon Grove.pdf", "page": 1, "type": "lookup", "card": True},
    {"q": "When did escrow close on 5532 E Pinon Grove Ln?", "expect": ["05/29/2026|May 29, 2026|2026-05-29"], "file": "Purchase contract 5532 E Pinon Grove Ln.pdf|Commission statement CS-26-044 Pinon Grove.pdf", "page": 1, "type": "date"},
    {"q": "How much earnest money did the Lindqvists deposit?", "expect": ["10,000|10000"], "file": "Earnest money receipt EM-2026-014 Lindqvist.pdf|Purchase contract 5532 E Pinon Grove Ln.pdf", "page": 1, "type": "lookup", "card": True},
    {"q": "What did the home inspection find at 5532 E Pinon Grove Ln?", "expect": ["water heater", "roof"], "file": "Home inspection summary 5532 E Pinon Grove Ln.pdf", "page": 1, "type": "lookup"},
    {"q": "What was the total commission on the Pinon Grove sale?", "expect": ["@Commission statement CS-26-044 Pinon Grove.pdf:total"], "file": "Commission statement CS-26-044 Pinon Grove.pdf", "page": 1, "type": "total"},
    {"q": "How much is the seller credit in the Pinon Grove contract?", "expect": ["4,500|4500"], "file": "Purchase contract 5532 E Pinon Grove Ln.pdf", "page": "find:Seller credits Buyer", "type": "lookup"},
    {"q": "When does the Larkspur listing expire?", "expect": ["03/09/2027|March 9, 2027|2027-03-09"], "file": "Listing agreement LA-26-058 Larkspur.pdf", "page": 1, "type": "expiration", "card": True},
    {"q": "What is the list price for 3906 E Larkspur Dr?", "expect": ["539,000|539000"], "file": "Listing agreement LA-26-058 Larkspur.pdf", "page": 1, "type": "lookup"},
    {"q": "When does Saoirse Delacroix's buyer agreement expire?", "expect": ["12/31/2026|December 31, 2026|2026-12-31"], "file": "Buyer broker agreement BA-26-019 Delacroix.pdf", "page": 1, "type": "expiration"},
    {"q": "What's the lockbox code at 1218 W Nopal Ave?", "expect": ["2719"], "file": "IMG_7731.jpg", "page": 1, "type": "lookup", "card": True},
    {"q": "What was Saoirse's concern about 1218 W Nopal Ave?", "expect": ["road noise"], "file": "Showing feedback Nopal.jpg", "page": 1, "type": "handwritten"},
    {"q": "Which vendor invoices haven't been paid?", "expect": ["PHS-1147", "LLP-0424"], "file": "Prairiefold staging invoice PHS-1147.pdf|Lumen & Lane invoice LLP-0424.pdf", "page": 1, "type": "unpaid"},
    {"q": "How much are the HOA dues at 3906 E Larkspur Dr?", "expect": ["86.00|\\$86"], "file": "Scan_HOA_resale_Larkspur.pdf|Seller disclosure 3906 E Larkspur Dr.pdf", "page": "find:86.00", "type": "lookup"},
    {"q": "When does our errors and omissions insurance expire?", "expect": ["06/30/2027|June 30, 2027|2027-06-30"], "file": "Certificate of insurance E&O Quailbrush.pdf", "page": 1, "type": "expiration"},
    {"q": "What did 5532 E Pinon Grove Ln sell for in 2019?", "expect": [], "notInRecords": True, "type": "not-in-records"},
]
