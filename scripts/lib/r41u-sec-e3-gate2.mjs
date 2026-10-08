// E3 gate2: the second hostile review of the grounding gate (fresh data: paper-supply invoice, vet receipt, vehicle lease, insurance certificate, permit).
// Every defect class (1-7), over-block (O1/O2), the card-key / length / agent-without-citations / evidence-failure items is a case with a plausibly WRONG output
// (must never be shown) and a CORRECT one (must be shown intact). The stubbed model runs through the REAL pipeline (api/ask.js model path); agent mode and the
// evidence-failure fallback are exercised at the gate with the same page text (the research agent cannot be scripted). Truth is built from the rows below.
export default async function ({ check, realLog, off, makeHarness }) {
  const T = { vendor: "Ironwood Paper Supply", cust: "Quillfeather Candle Co." };
  const docs = {
    S: { num: "IP-60412", customer: T.cust, iso: "2026-03-17", total: 830, addr: "77 W Mesquite Rd, Gilbert, AZ 85233", file: "ironwood-ip60412.pdf", text:
`Ironwood Paper Supply
1480 E Industrial Dr, Casa Grande, AZ 85122
SUPPLIER INVOICE
Invoice #: IP-60412
Invoice Date: 03/17/2026
Due Date: 04/16/2026
PO Number: PO-5531
Bill To: Quillfeather Candle Co., Attn: Marisela Quintero
77 W Mesquite Rd, Gilbert, AZ 85233
Ship To: Quillfeather Candle Co. - Studio, Attn: Thelonious Barkley
3 N Cholla Ln, Mesa, AZ 85201
Delivered: 03/19/2026
Qty Description Unit Price Amount
30 rolls Kraft paper 24 in $18.40 $552.00
8 boxes Wax paper 100 ct $31.25 $250.00
Subtotal: $802.00
Freight: $28.00
Total Due: $830.00
Terms: Net 30
Sales rep: Octavian Pruett` },
    V: { num: "CW-8841", customer: "Perpetua Haldane", iso: "2026-05-22", total: 255, file: "cactus-wren-8841.pdf", text:
`Cactus Wren Animal Hospital
902 N Arizona Ave, Chandler, AZ 85225
RECEIPT
Receipt #: CW-8841
Date: 05/22/2026
Owner: Perpetua Haldane
Patient: Juniper (Tabby cat, 9 years old)
Dental cleaning: $210.00
Microchip: $45.00
Total: $255.00
Paid by Mastercard ending 7731
Amount paid: $255.00
Balance: $0.00
Follow-up: 11/22/2026
Veterinarian: Dr. Leopoldo Quispe` },
    L: { num: "SR-3307", customer: "Evangeline Okonkwo-Reyes", iso: "2026-03-01", total: null, file: "sidewinder-sr3307.pdf", text:
`Sidewinder Rentals
VEHICLE LEASE AGREEMENT
Lease #: SR-3307
Lessee: Evangeline Okonkwo-Reyes, owner of Okonkwo Landscaping
Vehicle: 2025 Ford F-250 diesel
Serial: 52-471-908
Term: 48 months
Monthly payment: $689.00
Security deposit: $1,378.00
Mileage allowance: 12,000 miles per year
Lease start: March 1, 2026
Lease end: February 28, 2030
Late charge: 4% of payment after 7 days
Guarantor: Barnaby Hollingsworth` },
    I: { num: "COI-70915", customer: "Thaddeus Brightwater", iso: "2026-02-01", total: null, file: "copperline-coi70915.pdf", text:
`Copperline Casualty
CERTIFICATE OF INSURANCE
Certificate #: COI-70915
Policy #: CL-2209831
Insured: Thaddeus Brightwater dba Brightwater Masonry
Policy effective: 02/01/2026
Policy expiration: 02/01/2027
Each occurrence: $1,000,000
General aggregate: $3,000,000
Certificate holder: Town of Queen Creek
Agent: Philomena Strand, (602) 555-0144` },
    B: { num: "GB-2026-07712", customer: "Ignatius Delacroix-Moon", iso: "2026-06-03", total: null, file: "gilbert-gb07712.pdf", text:
`Town of Gilbert Building Safety
BUILDING PERMIT
Permit #: GB-2026-07712
Applicant: Ignatius Delacroix-Moon
Site Address: 5108 S Pecan Ct, Gilbert, AZ 85297
Work: Install 4 ton heat pump
Issued: 06/03/2026
Expires: 10/09/2026
Permit fee: $412.00
Inspections required: 2
Contractor license: ROC 288113
Inspector: Wilhelmina Oakes` },
  };
  const ASK = { S: "show me the Kraft paper and wax paper order from Ironwood", V: "show me the Cactus Wren dental cleaning and microchip visit for Juniper", L: "show me the Sidewinder Ford F-250 lease terms", I: "show me the Brightwater Masonry certificate of insurance liability limits", B: "show me the Pecan Ct heat pump permit" };
  const SAFE = { S: ["Invoice", "IP-60412"], V: ["Receipt", "CW-8841"], L: ["Lease", "SR-3307"], I: ["Certificate", "COI-70915"], B: ["Permit", "GB-2026-07712"] };
  const h = await makeHarness({ off, tenantKey: "r41u-e3g2", docs });
  const safe = (d) => [{ label: SAFE[d][0], value: SAFE[d][1] }];
  const card = (label, value, extra = {}) => [{ label, value, ...extra }];
  const cases = [];
  const wrong = (def, name, doc, text, marker, cards = null, extra = {}) => cases.push({ def, name, doc, kind: "bad", text, marker, cards: cards ?? safe(doc), ...extra });
  const right = (def, name, doc, text, cards = null, extra = {}) => cases.push({ def, name, doc, kind: "good", text, cards: cards ?? safe(doc), ...extra });

  // 1. quantity + noun outside the closed unit list, and the right number with the wrong unit
  wrong(1, "42 bags vs 30 rolls", "S", "You ordered 42 rolls of Kraft paper.", /42 rolls/);
  wrong(1, "30 boxes vs 30 rolls", "S", "You ordered 30 boxes of Kraft paper.", /30 boxes/);
  wrong(1, "8 rolls vs 8 boxes", "S", "The wax paper was 8 rolls.", /8 rolls/);
  wrong(1, "covers 5 items", "S", "The invoice covers 5 items.", /5 items/);
  wrong(1, "three line items", "S", "There are 3 line items on it.", /3 line items/);
  wrong(1, "a dozen", "S", "A dozen boxes of wax paper.", /dozen/);
  wrong(1, "half a dozen", "S", "Half a dozen rolls of Kraft paper.", /Half a dozen/);
  wrong(1, "pounds", "S", "The shipment weighed 900 pounds.", /900 pounds/);
  wrong(1, "minutes", "V", "The visit took 45 minutes.", /45 minutes/);
  wrong(1, "pet pounds", "V", "Juniper weighs 11 pounds.", /11 pounds/);
  wrong(1, "vaccines", "V", "Juniper received 3 vaccines.", /3 vaccines/);
  wrong(1, "due on the 15th", "S", "Payment is due on the 15th.", /15th/);
  wrong(1, "net 30 months", "S", "Payment is due in 30 months.", /30 months/);
  wrong(1, "net 30 weeks", "S", "Payment is due in 30 weeks.", /30 weeks/);
  wrong(1, "48 years", "L", "The lease term is 48 years.", /48 years/);
  wrong(1, "48 weeks", "L", "It is a 48 week lease.", /48 week/);
  wrong(1, "spelled forty-eight years", "L", "It is a forty-eight year lease.", /forty-eight year/);
  wrong(1, "per week", "L", "Payments are $689.00 per week.", /per week/);
  wrong(1, "per year", "L", "Payments are $689.00 a year.", /a year/);
  wrong(1, "per mile", "L", "You get 12,000 miles per month.", /per month/);
  wrong(1, "9 months old", "V", "Juniper is 9 months old.", /9 months old/);
  wrong(1, "9 weeks old hyphen", "V", "Juniper is a 9-week-old Tabby cat.", /9-week-old/);
  wrong(1, "swapped percent and days", "L", "The late charge is 7% after 4 days.", /7% after 4/);
  wrong(1, "percent as days", "L", "The late charge is 4 days after 7 percent.", /4 days after/);
  wrong(1, "four million aggregate", "I", "The aggregate is a four million dollar limit.", /four million/);
  wrong(1, "two million dollar", "I", "Two million dollar aggregate.", /Two million/);
  wrong(1, "unit price per roll vs box", "S", "Wax paper is $31.25 per roll.", /per roll/);
  wrong(1, "unit price a box vs roll", "S", "Kraft paper is $18.40 a box.", /a box/);
  wrong(1, "3 inspections", "B", "Three inspections are required.", /Three inspections/);
  wrong(1, "tons not 5", "B", "It is a 5 ton heat pump.", /5 ton/);
  right(1, "30 rolls", "S", "You ordered 30 rolls of Kraft paper.");
  right(1, "8 boxes", "S", "You ordered 8 boxes of wax paper.");
  right(1, "per roll", "S", "Kraft paper is $18.40 per roll.");
  right(1, "Net 30", "S", "The terms are Net 30.");
  right(1, "due in 30 days", "S", "Payment is due in 30 days.");
  right(1, "100 ct", "S", "Wax paper comes 100 ct per box.");
  right(1, "48 months", "L", "The lease term is 48 months.");
  right(1, "forty-eight month lease", "L", "It is a forty-eight month lease.");
  right(1, "per month", "L", "Payments are $689.00 per month.");
  right(1, "a month", "L", "Payments are $689.00 a month.");
  right(1, "late charge", "L", "The late charge is 4% of the payment after 7 days.");
  right(1, "12,000 miles per year", "L", "The allowance is 12,000 miles per year.");
  right(1, "9 years old", "V", "Juniper is 9 years old.");
  right(1, "9-year-old tabby", "V", "Juniper is a 9-year-old Tabby cat.");
  right(1, "three million words", "I", "The aggregate is three million dollars.");
  right(1, "3 inspections is 2", "B", "Two inspections are required.");
  right(1, "4 ton", "B", "It is a 4 ton heat pump.");

  // 2. hyphenated identifiers
  wrong(2, "serial wrong tail", "L", "Serial number 52-471-980.", /52-471-980/);
  wrong(2, "serial wrong head", "L", "Serial: 25-471-908.", /25-471-908/);
  wrong(2, "S/N", "L", "S/N 52-471-009.", /S\/N 52-471-009/);
  wrong(2, "serial in a sentence", "L", "The truck's serial is 52-417-908.", /52-417-908/);
  wrong(2, "ROC bare", "B", "ROC 288131 is the license.", /ROC 288131/);
  wrong(2, "license ROC", "B", "Contractor license ROC 288131.", /288131/);
  wrong(2, "certificate no.", "I", "Certificate no. COI-70951.", /COI-70951/);
  wrong(2, "policy number", "I", "Policy number CL-2209813.", /CL-2209813/);
  wrong(2, "permit number", "B", "Permit GB-2026-07721.", /07721/);
  right(2, "serial", "L", "Serial number 52-471-908.");
  right(2, "S/N", "L", "S/N 52-471-908.");
  right(2, "ROC", "B", "ROC 288113 holds the license.");
  right(2, "certificate no.", "I", "Certificate no. COI-70915.");

  // 3. role swaps for roles the gate did not map
  wrong(3, "received the delivery is the bill-to", "S", "Marisela Quintero received the delivery.", /Marisela Quintero received/);
  wrong(3, "ship-to is the bill-to", "S", "The delivery went to Marisela Quintero.", /went to Marisela/);
  wrong(3, "bill goes to the ship-to", "S", "The bill goes to Thelonious Barkley.", /goes to Thelonious/);
  wrong(3, "delivery was made to", "S", "Delivery was made to Marisela Quintero.", /Delivery was made to Marisela/);
  wrong(3, "sales rep is the ship-to", "S", "Octavian Pruett received the delivery.", /Octavian Pruett received/);
  wrong(3, "Ms. rep is the customer", "S", "Mr. Pruett is the customer.", /Pruett is the customer/);
  wrong(3, "customer is the sales rep", "S", "The sales rep is Marisela Quintero.", /sales rep is Marisela/);
  wrong(3, "vet is the owner", "V", "Dr. Perpetua Haldane examined Juniper.", /Haldane examined/);
  wrong(3, "owner is the vet", "V", "The veterinarian is Perpetua Haldane.", /veterinarian is Perpetua/);
  wrong(3, "patient is the owner", "V", "The patient is Perpetua Haldane.", /patient is Perpetua/);
  wrong(3, "owner is the patient", "V", "Owner: Juniper.", /Owner: Juniper/);
  wrong(3, "card Patient is the owner", "V", "Here is the receipt.", /Patient \| Perpetua Haldane/, card("Patient", "Perpetua Haldane"));
  wrong(3, "card Veterinarian is the owner", "V", "Here is the receipt.", /Veterinarian \| Perpetua Haldane/, card("Veterinarian", "Perpetua Haldane"));
  wrong(3, "lessee is the guarantor", "L", "Barnaby Hollingsworth is the lessee.", /Hollingsworth is the lessee/);
  wrong(3, "signed as lessee", "L", "Barnaby Hollingsworth signed as lessee.", /signed as lessee/);
  wrong(3, "guarantor is the lessee", "L", "The guarantor is Evangeline Okonkwo-Reyes.", /guarantor is Evangeline/);
  wrong(3, "card Guarantor is the lessee", "L", "Here is the lease.", /Guarantor \| Evangeline/, card("Guarantor", "Evangeline Okonkwo-Reyes"));
  wrong(3, "inspector is the applicant", "B", "The inspector is Ignatius Delacroix-Moon.", /inspector is Ignatius/);
  wrong(3, "applicant is the inspector", "B", "Wilhelmina Oakes applied for the permit.", /Oakes applied/);
  wrong(3, "card Inspector is the applicant", "B", "Here is the permit.", /Inspector \| Ignatius/, card("Inspector", "Ignatius Delacroix-Moon"));
  wrong(3, "agent is the insured", "I", "The agent is Thaddeus Brightwater.", /agent is Thaddeus/);
  wrong(3, "insured is the agent", "I", "Philomena Strand is the insured.", /Strand is the insured/);
  wrong(3, "holder is the insured", "I", "The holder is Thaddeus Brightwater.", /holder is Thaddeus/);
  wrong(3, "card Agent is the insured", "I", "Here is the certificate.", /Agent \| Thaddeus/, card("Agent", "Thaddeus Brightwater"));
  wrong(3, "card Certificate holder is the agent", "I", "Here is the certificate.", /holder \| Philomena/, card("Certificate holder", "Philomena Strand"));
  right(3, "ship-to received", "S", "Thelonious Barkley received the delivery.");
  right(3, "bill goes to bill-to", "S", "The bill goes to Marisela Quintero.");
  right(3, "delivery made to ship-to", "S", "Delivery was made to Thelonious Barkley.");
  right(3, "sales rep", "S", "The sales rep is Octavian Pruett.");
  right(3, "Mr. rep", "S", "Mr. Pruett is the sales rep.");
  right(3, "vet examined", "V", "Dr. Leopoldo Quispe examined Juniper.");
  right(3, "Dr. surname examined", "V", "Dr. Quispe examined Juniper.");
  right(3, "owner is the owner", "V", "The owner is Perpetua Haldane.");
  right(3, "patient", "V", "The patient is Juniper.");
  right(3, "card Patient", "V", "Here is the receipt.", card("Patient", "Juniper (Tabby cat, 9 years old)"));
  right(3, "card Veterinarian", "V", "Here is the receipt.", card("Veterinarian", "Dr. Leopoldo Quispe"));
  right(3, "lessee", "L", "Evangeline Okonkwo-Reyes signed as lessee.");
  right(3, "guarantor", "L", "The guarantor is Barnaby Hollingsworth.");
  right(3, "card Guarantor", "L", "Here is the lease.", card("Guarantor", "Barnaby Hollingsworth"));
  right(3, "inspector", "B", "The inspector is Wilhelmina Oakes.");
  right(3, "applicant applied", "B", "Ignatius Delacroix-Moon applied for the permit.");
  right(3, "agent", "I", "The agent is Philomena Strand.");
  right(3, "insured", "I", "Thaddeus Brightwater is the insured.");
  right(3, "card Certificate holder", "I", "Here is the certificate.", card("Certificate holder", "Town of Queen Creek"));
  right(3, "card Agent", "I", "Here is the certificate.", card("Agent", "Philomena Strand"));

  // 4. addresses in prose bound to their role
  wrong(4, "delivered to the bill-to address", "S", "It was delivered to 77 W Mesquite Rd, Gilbert, AZ 85233.", /delivered to 77 W/);
  wrong(4, "bill to the ship-to address", "S", "Bill to: Quillfeather Candle Co., 3 N Cholla Ln, Mesa, AZ 85201.", /Bill to: Quillfeather Candle Co., 3 N Cholla/);
  wrong(4, "shipped to the bill-to address", "S", "It shipped to 77 W Mesquite Rd, Gilbert, AZ 85233.", /shipped to 77/);
  wrong(4, "card Ship to the bill-to address", "S", "Here is the invoice.", /Ship to \| 77 W/, card("Ship to", "77 W Mesquite Rd, Gilbert, AZ 85233"));
  right(4, "delivered to the ship-to address", "S", "It was delivered to 3 N Cholla Ln, Mesa, AZ 85201.");
  right(4, "bill to the bill-to address", "S", "Bill to: Quillfeather Candle Co., 77 W Mesquite Rd, Gilbert, AZ 85233.");
  right(4, "card Ship to", "S", "Here is the invoice.", card("Ship to", "3 N Cholla Ln, Mesa, AZ 85201"));
  right(4, "plain address mention", "B", "The site is 5108 S Pecan Ct, Gilbert, AZ 85297.");

  // 5. status / negation / payment method / descriptor / relative date claims
  wrong(5, "no late charge", "L", "There is no late charge.", /no late charge/);
  wrong(5, "no security deposit", "L", "No security deposit is required.", /No security deposit/);
  wrong(5, "no inspections", "B", "No inspections are required.", /No inspections/);
  wrong(5, "no vaccines", "V", "No microchip was placed.", /No microchip/);
  wrong(5, "no freight", "S", "There was no freight charge.", /no freight/);
  wrong(5, "invoice paid", "S", "The invoice has been paid.", /has been paid/);
  wrong(5, "invoice is paid", "S", "This invoice is paid.", /is paid/);
  wrong(5, "invoice paid in full", "S", "It was paid in full.", /paid in full/);
  wrong(5, "receipt unpaid", "V", "This receipt is unpaid.", /unpaid/);
  wrong(5, "not been paid", "V", "The visit has not been paid yet.", /not been paid/);
  wrong(5, "overdue", "V", "The receipt is overdue.", /overdue/);
  wrong(5, "N days overdue", "S", "The invoice is 30 days overdue.", /30 days overdue/);
  wrong(5, "paid in cash", "V", "She paid in cash.", /paid in cash/);
  wrong(5, "paid by check", "V", "Paid in full by check.", /by check/);
  wrong(5, "paid by Visa", "V", "She paid with Visa.", /with Visa/);
  wrong(5, "card payment method Visa", "V", "Here is the receipt.", /Visa ending 7731/, card("Payment method", "Visa ending 7731"));
  wrong(5, "card payment wrong digits", "V", "Here is the receipt.", /4412/, card("Payment method", "Mastercard ending 4412"));
  wrong(5, "card status Overdue", "V", "Here is the receipt.", /Status \| Overdue/, card("Status", "Overdue"));
  wrong(5, "card status Paid on unpaid page", "S", "Here is the invoice.", /Status \| Paid/, card("Status", "Paid"));
  wrong(5, "certificate expired", "I", "The certificate is expired.", /is expired/);
  wrong(5, "policy lapsed", "I", "The policy has already lapsed.", /lapsed/);
  wrong(5, "permit expired", "B", "The permit has expired.", /has expired/);
  wrong(5, "permit expired last week", "B", "The permit expired last week.", /last week/);
  wrong(5, "permit approved and final", "B", "The permit is approved and final.", /approved/);
  wrong(5, "permit denied", "B", "The permit was denied.", /denied/);
  wrong(5, "lease terminated", "L", "The lease has been terminated.", /terminated/);
  wrong(5, "policy cancelled", "I", "The policy was cancelled.", /cancelled/);
  wrong(5, "due next Tuesday", "S", "Payment is due next Tuesday.", /next Tuesday/);
  wrong(5, "follow-up tomorrow", "V", "The follow-up visit is tomorrow.", /tomorrow/);
  wrong(5, "expires next Friday", "B", "The permit expires next Friday.", /next Friday/);
  wrong(5, "end of 2027", "I", "Coverage is valid until the end of 2027.", /end of 2027/);
  wrong(5, "end of the year", "B", "The permit is good until the end of the year.", /end of the year/);
  wrong(5, "three weeks ago", "S", "It was delivered 3 weeks ago.", /weeks ago/);
  wrong(5, "Q3 invoice", "S", "This is a Q3 invoice.", /Q3/);
  wrong(5, "fourth quarter", "S", "It was issued in the fourth quarter.", /fourth quarter/);
  wrong(5, "wrong descriptor planetary", "L", "It is a diesel Ford F-250 with a planetary gearbox.", /planetary/);
  wrong(5, "wrong descriptor commercial", "V", "This is a commercial invoice.", /commercial/);
  wrong(5, "wrong descriptor gas", "L", "It is a gas-fired pickup.", /gas-fired/);
  right(5, "paid by Mastercard", "V", "She paid with a Mastercard ending 7731.");
  right(5, "paid by card", "V", "She paid by card.");
  right(5, "paid", "V", "The receipt is paid in full.");
  right(5, "balance zero", "V", "There is no balance due.");
  right(5, "card status paid", "V", "Here is the receipt.", card("Status", "Paid"));
  right(5, "card payment method", "V", "Here is the receipt.", card("Payment method", "Mastercard ending 7731"));
  right(5, "overdue by dates", "S", "The invoice is overdue.");
  right(5, "overdue exact days", "S", "The invoice is 174 days overdue.");
  right(5, "certificate active", "I", "The certificate is still valid.");
  right(5, "not expired", "I", "The policy has not expired.");
  right(5, "expires this Friday", "B", "The permit expires this Friday.");
  right(5, "expires October 9", "B", "The permit expires on October 9, 2026.");
  right(5, "diesel", "L", "It is a diesel pickup.");
  right(5, "Q1 invoice", "S", "This is a Q1 invoice.");
  right(5, "first quarter", "S", "It was issued in the first quarter.");
  right(5, "no phrase that is meta", "S", "No other invoices were found for them.");

  // 6. currency / number format
  wrong(6, "1800,00 USD", "S", "The total is 1800,00 USD.", /1800,00/);
  wrong(6, "1 800,00 $.", "S", "Le total est de 1 800,00 $.", /1 800,00/);
  wrong(6, "803,00 USD", "S", "The total is 803,00 USD.", /803,00/);
  wrong(6, "right figure in pesos", "S", "The total is 830.00 pesos.", /pesos/);
  wrong(6, "MXN", "S", "The total is MXN 830.00.", /MXN/);
  wrong(6, "C$", "S", "The total is C$830.00.", /C\$830/);
  wrong(6, "right figure in euros", "S", "The total is €830.00.", /€830/);
  wrong(6, "right figure in CAD code", "S", "The total is 830.00 CAD.", /830\.00 CAD/);
  right(6, "830,00 USD", "S", "The total is 830,00 USD.");
  right(6, "830,00 $", "S", "Le total est de 830,00 $.");
  right(6, "plain", "S", "The total is $830.00.");

  // 7. homoglyph names (a Cyrillic or Greek look-alike inside a Latin word)
  wrong(7, "Cyrillic A in a name", "S", "Bill to Marisela Quintero.".replace("Marisela", "Маrisela"), /Quintero/);
  wrong(7, "Cyrillic o in a name", "S", "Delivered to Thelonious Barkley.".replace("Thelonious", "Thelоnious"), /Barkley/);
  wrong(7, "Greek omicron in a card name", "V", "Here is the receipt.", /Haldane/, card("Owner", "Perpetua Haldane".replace("e", "е")));
  wrong(7, "Cyrillic e in a vendor", "S", "The vendor is Irоnwood Paper Supply.", /Supply/);
  wrong(7, "Cyrillic c in a card vendor", "S", "Here is the invoice.", /Paper Supply/, card("Vendor", "Ironwood Paper Supply".replace("c", "с").replace("Paper", "Pаper")));
  right(7, "Latin name", "S", "Bill to Marisela Quintero.");

  // O1 over-blocks: letterhead vendor under a SUPPLIER INVOICE title, derived sums, line totals
  right("O1", "card Vendor", "S", "Here is the invoice.", card("Vendor", "Ironwood Paper Supply"));
  right("O1", "card Supplier", "S", "Here is the invoice.", card("Supplier", "Ironwood Paper Supply"));
  right("O1", "card Seller", "S", "Here is the invoice.", card("Seller", "Ironwood Paper Supply"));
  right("O1", "The vendor is", "S", "The vendor is Ironwood Paper Supply.");
  right("O1", "The supplier is", "S", "The supplier is Ironwood Paper Supply.");
  right("O1", "multi cards with a vendor", "S", "Here is the invoice.", [{ label: "Invoice", value: "IP-60412" }, { label: "Vendor", value: "Ironwood Paper Supply" }, { label: "Total", value: "$830.00" }, { label: "Terms", value: "Net 30" }, { label: "Bill to", value: "Quillfeather Candle Co." }]);
  right("O1", "plus freight is", "S", "Subtotal $802.00 plus $28.00 freight is $830.00.");
  right("O1", "plus freight equals total", "S", "$802.00 subtotal plus $28.00 freight equals $830.00 total.");
  right("O1", "line total after unit price", "S", "30 rolls of Kraft paper at $18.40 each, $552.00 total.");
  wrong("O1", "line total of the wrong line", "S", "30 rolls of Kraft paper at $18.40 each, $250.00 total.", /\$250\.00 total/);
  wrong("O1", "wrong sum", "S", "Subtotal $802.00 plus $28.00 freight is $840.00.", /\$840/);
  // O2 over-blocks: date ranges, field-name synonyms, card ending digits, years-old, insured + agent
  right("O2", "X to Y", "I", "The policy runs 02/01/2026 to 02/01/2027.");
  right("O2", "from X to Y", "I", "Coverage runs from 02/01/2026 to 02/01/2027.");
  right("O2", "X - Y", "I", "Coverage period: 02/01/2026 - 02/01/2027.");
  right("O2", "until", "I", "In force from February 1, 2026 until February 1, 2027.");
  right("O2", "through", "L", "The lease runs March 1, 2026 through February 28, 2030.");
  right("O2", "card range", "I", "Here is the certificate.", card("Coverage period", "02/01/2026 - 02/01/2027"));
  wrong("O2", "reversed range", "I", "The policy runs 02/01/2027 to 02/01/2026.", /02\/01\/2027 to/);
  wrong("O2", "range with a wrong end", "I", "The policy runs 02/01/2026 to 02/01/2028.", /2028/);
  wrong("O2", "card range wrong end", "I", "Here is the certificate.", /2028/, card("Coverage period", "02/01/2026 - 02/01/2028"));
  right("O2", "card Aggregate limit", "I", "Here is the certificate.", card("Aggregate limit", "$3,000,000"));
  right("O2", "card Each occurrence limit", "I", "Here is the certificate.", card("Occurrence limit", "$1,000,000"));
  wrong("O2", "limits swapped", "I", "The limit is $3,000,000 each occurrence.", /\$3,000,000 each occurrence/);
  right("O2", "card Visa ending", "V", "Here is the receipt.", card("Payment method", "Mastercard ending 7731"));
  right("O2", "ending digits in prose", "V", "Paid by card ending in 7731.");
  right("O2", "6-year-old style", "V", "Juniper is a 9-year-old Tabby.");
  right("O2", "Insured X; agent Y", "I", "Insured Brightwater Masonry; agent Philomena Strand.");
  right("O2", "card Insured with dba", "I", "Here is the certificate.", card("Insured", "Thaddeus Brightwater dba Brightwater Masonry"));

  // pipeline: every case through api/ask.js with the stubbed model
  let reached = 0; const fails = [];
  for (const c of cases) {
    const model = () => ({ text: c.text, confidence: 0.92, facts: c.cards.map((f) => ({ ...f, sources: [{ documentId: h.ids[c.doc], location: { page: 1 } }] })) });
    const r = await h.ask(ASK[c.doc], model);
    const tag = `E3 d${c.def} ${c.kind === "bad" ? "stops" : "keeps"} [${c.name}]`;
    if (!r.calls) { check(`${tag} (model path reached)`, false, r.text); continue; }
    reached++;
    const s = h.shown(r);
    if (c.kind === "bad") check(tag, !(r.kind === "answer" && c.marker.test(s)), s.replace(/\n/g, " / "));
    else check(tag, r.kind === "answer" && !r.data?.groundingWithdrawn && !r.data?.groundingNote && r.facts.length === c.cards.length && r.text.startsWith(c.text.slice(0, 20)), `${r.kind} ${r.data?.groundingNote ?? ""} ${JSON.stringify(r.data?.claimCheck?.unsupported ?? [])}`);
    void fails;
  }
  check("E3: every case reached the model path", reached === cases.length, `${reached}/${cases.length}`);

  // the same cases at the gate in agent mode (one cited document, then the same document plus an unrelated one), with today fixed
  const ev = h.evidence(); const cs = (k) => ({ documentId: h.ids[k], location: { page: 1 } });
  const shownOf = (d) => `${d.text}\n${(d.facts ?? []).map((f) => Object.values(f).filter((v) => typeof v === "string").join(" | ")).join("\n")}`;
  let agentN = 0;
  for (const c of cases) {
    for (const dual of [false, true]) {
      const other = c.doc === "V" ? "S" : "V";
      const srcs = (extra) => [cs(c.doc), ...(dual ? [cs(other)] : []), ...extra];
      const data = { kind: "answer", text: c.text, confidence: 0.9, facts: c.cards.map((f) => ({ ...f, sources: srcs([]) })), sources: [] };
      const d = h.gate.applyGrounding(data, ev, { agent: true, today: "2026-10-07" });
      agentN++;
      if (c.kind === "bad") { if (dual) continue; check(`E3 agent stops [${c.name}]`, !(d.kind === "answer" && c.marker.test(shownOf(d))), shownOf(d)); }
      else if (!dual) check(`E3 agent keeps [${c.name}]`, d.kind === "answer" && !d.groundingWithdrawn && (d.facts ?? []).length === c.cards.length, JSON.stringify(d.claimCheck?.unsupported));
    }
  }
  // non-agent mode at the gate (the model path's own mode) with a different "today" never turns a correct answer into a wrong one
  const gateNow = (text, o = {}) => h.gate.applyGrounding({ kind: "answer", text, confidence: 0.9, facts: [], sources: [cs("I")], ...o }, ev, { today: "2027-03-01" });
  check("E3 expiry follows today: expired on 2027-03-01", gateNow("The certificate is expired.").kind === "answer", "");
  check("E3 expiry follows today: not 'still valid' on 2027-03-01", gateNow("The certificate is still valid.").kind !== "answer", "");
  const noToday = h.gate.applyGrounding({ kind: "answer", text: "The certificate is expired.", confidence: 0.9, facts: [], sources: [cs("I")] }, ev, {});
  check("E3 a date-derived status with no 'today' is withdrawn", noToday.kind !== "answer", "");
  const relNoToday = h.gate.applyGrounding({ kind: "answer", text: "The permit expires tomorrow.", confidence: 0.9, facts: [], sources: [cs("B")] }, ev, {});
  check("E3 a relative date with no 'today' is withdrawn", relNoToday.kind !== "answer", "");
  const relOk = h.gate.applyGrounding({ kind: "answer", text: "The permit expires on Friday, October 9, 2026.", confidence: 0.9, facts: [], sources: [cs("B")] }, ev, { today: "2026-10-07" });
  check("E3 weekday + date that match the page are kept", relOk.kind === "answer", JSON.stringify(relOk.claimCheck?.unsupported));

  // card keys status / kind / valueOk / entityId carry enum values only
  const sneak = (extra) => h.gate.applyGrounding({ kind: "answer", text: "Here is the invoice.", confidence: 0.9, sources: [], facts: [{ label: "Invoice", value: "IP-60412", sources: [cs("S")], ...extra }] }, ev, { today: "2026-10-07" });
  for (const [k, v] of [["status", "Total $1,800.00"], ["entityId", "The total is $1,800.00"], ["kind", "Pay $1,800.00 now"], ["valueOk", "Total $1,800.00"], ["status", "Rosalind Aguirre is the owner"]]) {
    const out = sneak({ [k]: v }); const s = JSON.stringify(out.facts ?? []);
    check(`E3 card key ${k} cannot carry text [${v}]`, !(out.kind === "answer" && (out.facts ?? []).some((f) => f[k] === v)), s.slice(0, 200));
  }
  { // shapeAnswer itself drops arbitrary strings in the card's own keys and keeps the valid ones
    const A = await import("../../api/_lib/answer.js");
    const al = A.buildAllowed({ passages: [{ documentId: h.ids.S, page: 1, stage: "verified" }] });
    const src = [{ documentId: h.ids.S, location: { page: 1 } }];
    const out = A.shapeAnswer({ text: "ok", confidence: 0.9, facts: [{ label: "Invoice", value: "IP-60412", status: "Total $1,800.00", kind: "Pay now", entityId: "see $1,800 total", valueOk: "yes", sources: src }, { label: "Total", value: "$830.00", status: "ok", kind: "money", entityId: "c0ffee00-1234-4abc-8def-000000000001", valueOk: true, sources: src }] }, al);
    check("E3 shapeAnswer drops invalid status / kind / entityId / valueOk", out.facts.length === 2 && ["status", "kind", "entityId", "valueOk"].every((k) => out.facts[0][k] === undefined), JSON.stringify(out.facts[0]));
    check("E3 shapeAnswer keeps valid status / kind / entityId / valueOk", out.facts[1].status === "ok" && out.facts[1].kind === "money" && out.facts[1].valueOk === true && /^c0ffee/.test(out.facts[1].entityId), JSON.stringify(out.facts[1]));
  }
  for (const [k, v] of [["status", "ok"], ["status", "warn"], ["kind", "answer"], ["valueOk", true], ["entityId", "c0ffee00-1234-4abc-8def-000000000001"]]) check(`E3 card key ${k}=${v} still passes`, sneak({ [k]: v }).kind === "answer", "");

  // length caps: a 20k token, 4000 sentences, and long near-cap inputs stay well under 150 ms
  const timeIt = (text, o = {}) => { let worst = 0; let kind = ""; for (let i = 0; i < 3; i++) { const t = process.hrtime.bigint(); const d = h.gate.applyGrounding({ kind: "answer", text, confidence: 0.9, facts: [], sources: [cs("S")], ...o }, ev, { agent: true, today: "2026-10-07" }); worst = Math.max(worst, Number(process.hrtime.bigint() - t) / 1e6); kind = d.kind; } return { worst, kind }; };
  const big = [
    ["a 20k single token", `${"x".repeat(20000)} Bill to Marisela Quintero.`],
    ["4000 sentences", Array.from({ length: 4000 }, (_, i) => `Item ${i} costs $${i}.00.`).join(" ")],
    ["near-cap names", "Marisela Quintero ".repeat(270)],
    ["near-cap dates", "02/01/2026 to 02/01/2027 ".repeat(190)],
    ["near-cap addresses", "410 E Ocotillo Ave, Phoenix, AZ 85014 ".repeat(130)],
    ["near-cap quantities", "40 bags ".repeat(600)],
  ];
  for (const [n, t] of big) { const r = timeIt(t); check(`E3 worst case [${n}] under 150 ms`, r.worst < 150, `${r.worst.toFixed(1)} ms`); }
  check("E3 an oversized answer is withdrawn, not passed", timeIt("x".repeat(20000)).kind !== "answer", "");
  check("E3 a normal 40-sentence correct answer is kept", h.gate.applyGrounding({ kind: "answer", text: "The invoice total is $830.00. ".repeat(40), confidence: 0.9, facts: [], sources: [cs("S")] }, ev, { today: "2026-10-07" }).kind === "answer", "");

  // agent:true with NO cited documents: held to every document retrieved in the run; with none, figures are withdrawn
  const uncited = (text, e, o = {}) => h.gate.applyGrounding({ kind: "answer", text, confidence: 0.9, facts: [], sources: [] }, e, { agent: true, today: "2026-10-07", ...o });
  const oneDoc = new Map([[h.ids.S, ev.get(h.ids.S)]]);
  check("E3 uncited agent: a wrong total is withdrawn when documents were retrieved", uncited("The total is $1,800.00.", oneDoc).kind !== "answer", "");
  check("E3 uncited agent: the right total is kept", uncited("The total is $830.00.", oneDoc).kind === "answer", "");
  check("E3 uncited agent: a wrong name is withdrawn", uncited("Bill to Rosalind Aguirre.", oneDoc).kind !== "answer", "");
  check("E3 uncited agent: figures are withdrawn when no evidence is available", uncited("The total is $830.00.", new Map()).kind !== "answer", "");
  check("E3 uncited agent: a sentence with no claim is kept", uncited("Here is what I found.", new Map()).kind === "answer", "");
  check("E3 uncited agent: record-derived figures (rows) pass as before", uncited("The shop invoiced $12,400.00 this year.", new Map(), { agentRows: true }).kind === "answer", "");

  // evidence-load failure fallback: any sentence with a figure / name / status claim is withdrawn
  for (const t of ["The invoice has been paid.", "There is no late charge.", "The certificate is expired.", "Bill to Marisela Quintero.", "The total is $830.00.", "Payment is due in 30 days.", "It was a commercial truck."]) {
    const a = h.gate.applyGrounding({ kind: "answer", text: t, confidence: 0.9, facts: [], sources: [cs("S")] }, new Map(), { today: "2026-10-07", evidenceFailed: true });
    const b = h.gate.applyGrounding({ kind: "answer", text: t, confidence: 0.9, facts: [], sources: [] }, new Map(), { agent: true, today: "2026-10-07", evidenceFailed: true });
    check(`E3 evidence failure fails closed [${t}]`, a.kind !== "answer" && b.kind !== "answer", `${a.kind} ${b.kind}`);
  }
  check("E3 evidence failure keeps a claim-free sentence", h.gate.applyGrounding({ kind: "answer", text: "Here you go.", confidence: 0.9, facts: [], sources: [cs("S")] }, new Map(), { evidenceFailed: true }).kind === "answer", "");

  realLog(`E3 gate2: ${cases.length} pipeline cases, ${agentN} agent-mode runs; model-path ask p50 ${[...h.lats].sort((a, b) => a - b)[Math.floor(h.lats.length / 2)]} ms`);
}
