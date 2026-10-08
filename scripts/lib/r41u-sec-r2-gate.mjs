// R2 gate: loop-4 hostile review defects (a) suffix / credential swaps, (b) roles outside the mapped list, (c) label-bound figures and dates,
// (d) unit swaps, (e) checkbox / signature / void markers, (f) exhibit / section references and qualifiers, (g) over-blocks that must stay allowed.
// Fresh documents (daycare, freight, HOA, lawyer, dental). Truth is the raw text below; "bad" outputs must never reach the user, "good" ones stay intact.
export default async function ({ check, realLog, off, makeHarness }) {
  const docs = {
    D: { num: "SK-2026-14", customer: "Renata Alvarez", iso: "2026-08-01", total: 1150, file: "sunflower-sk14.pdf", text:
`Sunflower Kids Daycare
ENROLLMENT AGREEMENT
Agreement #: SK-2026-14
Child: Mateo Alvarez
Parent: Renata Alvarez
Emergency contact: Hollis Pruitt, (480) 555-0192
Authorized pickup: Delphine Okafor
Director: Winifred Castellano
Tuition: $1,150.00 per month
Drop-in care: $12.00 per hour
Deposit: $300.00
Late pickup fee: $500.00
Start date: 08/01/2026
Registration due: 07/15/2026
[X] Immunization records on file
[ ] Photo release
Parent signature: Renata Alvarez (signed 08/01/2026)
Director signature: ____________ (unsigned)` },
    F: { num: "CF-2209", customer: "Harlan Voss", iso: "2026-04-10", total: 4820, file: "coyote-cf2209.pdf", text:
`Coyote Freight Lines
BILL OF LADING
BOL #: CF-2209
Status: VOID - superseded by CF-2210
Shipper: Harlan Voss
Consignee: Ingrid Solberg
Carrier contact: Dashiell Frome
Rate: $2.10 per mile
Detention: $60.00 per hour
Weight: 18,400 lb
Total freight: $4,820.00
Fuel surcharge: $310.00
Ship date: 04/10/2026
Delivery date: 04/14/2026
Cancelled on 04/12/2026` },
    H: { num: "SR-A-88", customer: "Cornelius Whitlock III", iso: "2026-01-05", total: 1800, file: "saguaro-sra88.pdf", text:
`Saguaro Ridge HOA
ASSESSMENT NOTICE
Notice #: SR-A-88
Owner: Cornelius Whitlock III
Manager: Beatrix Lindqvist
Contractor: Pinnacle Paving, represented by President Octavia Brandt
Annual assessment: $1,800.00 per year
Monthly equivalent: $150.00 per month
Late fee: $75.00
Clubhouse electric: $0.14 per kWh
Clubhouse gas: $1.20 per therm
Paving special assessment: $75.00
Per Article VII, Section 4 and Exhibit B
Due date: 02/01/2026
Hearing date: 03/15/2026
Three installments of $600.00` },
    L: { num: "PA-5531", customer: "Odalys Brennan", iso: "2026-06-02", total: 5000, file: "pruitt-pa5531.pdf", text:
`Pruitt & Anand Law
RETAINER AGREEMENT
Matter #: PA-5531
Client: Odalys Brennan
Attorney: Marcus T. Anand, Esq.
Expert witness: Dr. Priya Raghunathan, PhD
Beneficiary: Ellis Brennan
Guardian: Tamsin Orr
Borrower: Odalys Brennan
Lender: Cactus Credit Union
Retainer: $5,000.00
Hourly rate: $325.00 per hour
Paralegal rate: $110.00 per hour
Filing fee: $325.00
Effective: 06/02/2026
Court date: 09/14/2026` },
    T: { num: "DS-7714", customer: "Tobias Greer Sr.", iso: "2026-07-07", total: 960, file: "desert-ds7714.pdf", text:
`Desert Smile Dental
TREATMENT ESTIMATE
Estimate #: DS-7714
Patient: Tobias Greer Sr.
Dentist: Dr. Imelda Voss, DDS
Oral surgeon: Dr. Anselm Park, MD
Insured: Tobias Greer Sr.
Claimant: Gwendolyn Greer
Crown: $1,200.00
Discount: $240.00
Total after discount: $960.00
Tax: $48.00
Total before tax: $960.00
Total including tax: $1,008.00
Estimate date: 07/07/2026
Expires: 08/07/2026
[X] Consent to treatment
[ ] X-ray release
Patient signature: Tobias Greer Sr. (signed 07/07/2026)` },
    P: { num: "MM-3321", customer: "Lorna Whitcombe", iso: "2026-03-03", total: null, file: "mesquite-mm3321.pdf", text:
`Mesquite Mutual Insurance
POLICY SUMMARY
Policy #: MM-3321
Insured: Lorna Whitcombe
Wind: covered
Flood: NOT covered
Does not cover battery
Covers the screen
Warranty is void if opened
Permit fees: not included
Inspection fee: included
Deposit (non-refundable): $200.00
Cancellation fee: refundable if unused
Not signed by: Principal
Signed by: Notary
Keep outdoors
Delivery status: In transit
No goods or services were provided in exchange for this notice
Customer received a brochure
Deposit up to $500.00
Minimum payment: $250.00
Rate for partners: $350.00 per hour
Rate for associates: $225.00 per hour
Materials warranty: 25 years
Workmanship warranty: 5 years
Premium increases from $1,200.00 to $1,380.00` },
    R: { num: "CW-9902", customer: "Juniper Haldane", iso: "2026-05-22", total: 676, file: "cactus-cw9902.pdf", text:
`Cactus Wren Animal Hospital
VISIT RECORD
Record #: CW-9902
Patient: Juniper
Sex: Male
Microchip: 985112004567893
Rabies: 1 ml subcutaneous
Distemper: 0.5 ml intramuscular
Tax ID: 86-1234567
Container: MSKU 4417209
Total: $676.00
Balance: $0.00
Status: PAID` },
    K: { num: "SR-7788", customer: "Odessa Lindgren", iso: "2026-05-09", total: 75000, file: "saguaro-sr7788.pdf", text:
`Saguaro Roofing Contract
Contract #: SR-7788
Date: 05/09/2026
Valid for 30 days
Ridge vent: 60 linear ft
Roof area: 60 sq ft
Regular coffee: 5 lb
Decaf coffee: 2 lb
Contract total: $75,000.00
Payment: 50% on signing
Balance due on completion
Term: 24 months from 02/15/2026
Credit: -$150.00 applied to total` },
    M: { num: "MA-1020", customer: "Ezekiel Montgomery", iso: "2026-04-01", total: null, file: "pruitt-ma1020.pdf", text:
`Pruitt & Anand Law
MATTER SUMMARY
Matter #: MA-1020
Matter: Employment dispute
Client: Ezekiel P. Montgomery
Status: Open` },
  };
  const h = await makeHarness({ off, tenantKey: "r41u-r2gate", docs });
  const ev = h.evidence(); const cs = (k) => ({ documentId: h.ids[k], location: { page: 1 } });
  const gate = (k, text, o = {}) => h.gate.applyGrounding({ kind: "answer", text, confidence: 0.9, facts: [], sources: [cs(k)] }, ev, { today: "2026-10-07", ...o });
  const kept = (d) => d.kind === "answer" && !d.groundingWithdrawn && !d.groundingNote;
  const bad = (k, t) => check(`R2g withdrawn [${t}]`, !kept(gate(k, t)), JSON.stringify(gate(k, t).text).slice(0, 160));
  const good = (k, t) => { const d = gate(k, t); check(`R2g kept [${t}]`, kept(d), JSON.stringify(d.claimCheck?.unsupported ?? d.text).slice(0, 200)); };

  // (a) suffix / credential swaps
  bad("H", "The owner is Cornelius Whitlock Jr."); bad("H", "The owner is Cornelius Whitlock Sr."); bad("H", "The owner is Cornelius Whitlock II.");
  good("H", "The owner is Cornelius Whitlock III."); good("H", "The owner is Cornelius Whitlock.");
  bad("T", "The patient is Tobias Greer Jr."); good("T", "The patient is Tobias Greer Sr."); bad("T", "The patient is Tobias Greer III.");
  bad("T", "The dentist is Dr. Imelda Voss, MD."); bad("T", "The dentist is Dr. Imelda Voss, PhD."); good("T", "The dentist is Dr. Imelda Voss, DDS."); good("T", "The dentist is Dr. Imelda Voss.");
  bad("T", "The oral surgeon is Dr. Anselm Park, DDS."); good("T", "The oral surgeon is Dr. Anselm Park, MD.");
  bad("L", "The attorney is Marcus T. Anand, PhD."); bad("L", "The attorney is Marcus T. Anand, CPA."); good("L", "The attorney is Marcus T. Anand, Esq."); good("L", "The attorney is Marcus T. Anand.");
  bad("L", "The expert is Dr. Priya Raghunathan, MD."); bad("L", "The expert is Dr. Priya Raghunathan, Esq."); good("L", "The expert is Dr. Priya Raghunathan, PhD.");

  // (b) roles outside the mapped list
  bad("D", "The parent is Winifred Castellano."); good("D", "The parent is Renata Alvarez.");
  bad("D", "The director is Renata Alvarez."); good("D", "The director is Winifred Castellano.");
  bad("D", "The emergency contact is Delphine Okafor."); good("D", "The emergency contact is Hollis Pruitt."); good("D", "Emergency contact: Hollis Pruitt, (480) 555-0192.");
  bad("D", "Authorized pickup is Hollis Pruitt."); good("D", "Authorized pickup is Delphine Okafor."); bad("D", "Delphine Okafor is the parent.");
  bad("F", "The shipper is Ingrid Solberg."); good("F", "The shipper is Harlan Voss."); bad("F", "The consignee is Harlan Voss."); good("F", "The consignee is Ingrid Solberg.");
  bad("H", "The manager is Octavia Brandt."); good("H", "The manager is Beatrix Lindqvist."); bad("H", "The contractor is Beatrix Lindqvist."); good("H", "The contractor is Pinnacle Paving.");
  bad("L", "The guardian is Ellis Brennan."); good("L", "The guardian is Tamsin Orr."); bad("L", "The beneficiary is Tamsin Orr."); good("L", "The beneficiary is Ellis Brennan.");
  bad("L", "The lender is Odalys Brennan."); good("L", "The lender is Cactus Credit Union."); bad("L", "The borrower is Cactus Credit Union."); good("L", "The borrower is Odalys Brennan.");
  bad("T", "The claimant is Tobias Greer Sr."); good("T", "The claimant is Gwendolyn Greer."); bad("T", "The insured is Gwendolyn Greer."); good("T", "The insured is Tobias Greer Sr.");
  bad("H", "The owner is Beatrix Lindqvist."); bad("L", "The client is Marcus T. Anand, Esq.");

  // (c) figures / dates bound to the wrong label when an equal number exists elsewhere
  bad("D", "The deposit is $500.00."); good("D", "The deposit is $300.00."); good("D", "The late pickup fee is $500.00."); bad("D", "The late pickup fee is $300.00.");
  bad("D", "Tuition is $12.00."); bad("D", "The registration is due 08/01/2026."); good("D", "Registration is due 07/15/2026."); good("D", "Care starts 08/01/2026."); bad("D", "Care starts 07/15/2026.");
  bad("H", "The late fee is $600.00."); bad("H", "The paving special assessment is $150.00."); good("H", "The late fee is $75.00."); good("H", "The paving special assessment is $75.00.");
  bad("H", "The hearing date is 02/01/2026."); good("H", "The hearing date is 03/15/2026."); good("H", "The assessment is due 02/01/2026."); bad("H", "The assessment is due 03/15/2026.");
  bad("L", "The filing fee is $5,000.00."); good("L", "The filing fee is $325.00."); good("L", "The retainer is $5,000.00."); bad("L", "The retainer is $325.00.");
  bad("F", "Delivery is 04/10/2026."); good("F", "Delivery is 04/14/2026."); bad("F", "The fuel surcharge is $4,820.00.");

  // (d) unit swaps
  bad("D", "Tuition is $1,150.00 per hour."); bad("D", "Tuition is $1,150.00 per year."); good("D", "Tuition is $1,150.00 per month."); bad("D", "Drop-in care is $12.00 per month."); good("D", "Drop-in care is $12.00 per hour.");
  bad("F", "The rate is $2.10 per hour."); bad("F", "The rate is $2.10 per gallon."); bad("F", "The rate is $2.10 per sq ft."); good("F", "The rate is $2.10 per mile.");
  bad("F", "Detention is $60.00 per day."); good("F", "Detention is $60.00 per hour.");
  bad("H", "Electric is $0.14 per therm."); bad("H", "Gas is $1.20 per kWh."); good("H", "Electric is $0.14 per kWh."); good("H", "Gas is $1.20 per therm.");
  bad("H", "The assessment is $1,800.00 per month."); good("H", "The assessment is $1,800.00 per year."); good("H", "The monthly equivalent is $150.00 per month."); bad("H", "The monthly equivalent is $150.00 per year.");
  bad("L", "The hourly rate is $325.00 per sq ft."); bad("L", "The hourly rate is $325.00 per day."); good("L", "The hourly rate is $325.00 per hour.");

  // (e) markers: checkbox / yes-no / signature / void / superseded / cancelled
  bad("D", "Yes, the photo release is checked."); bad("D", "The photo release has been signed."); good("D", "The immunization records are on file.");
  bad("D", "The director signed the agreement."); good("D", "The parent signed the agreement on 08/01/2026."); bad("D", "The director signature is signed.");
  good("D", "The director signature is unsigned."); good("D", "The photo release box is not checked.");
  bad("F", "The bill of lading is valid."); bad("F", "The bill of lading is active."); good("F", "The bill of lading is void."); good("F", "It was superseded by CF-2210."); bad("F", "It was superseded by CF-2211.");
  good("F", "It was cancelled on 04/12/2026."); bad("F", "It was cancelled on 04/14/2026.");
  bad("T", "The X-ray release is checked."); good("T", "The patient consented to treatment."); bad("T", "The patient did not consent to treatment."); good("T", "The patient signed on 07/07/2026.");

  // (f) section / exhibit / article references and qualifiers
  bad("H", "See Article VIII, Section 4."); bad("H", "See Article VII, Section 9."); bad("H", "See Exhibit C."); good("H", "See Article VII, Section 4 and Exhibit B."); good("H", "See Exhibit B.");
  bad("T", "The total is $960.00 before discount."); good("T", "The total after discount is $960.00."); bad("T", "The total after tax is $960.00."); good("T", "The total before tax is $960.00.");
  good("T", "The total including tax is $1,008.00."); bad("T", "The total excluding tax is $1,008.00."); bad("T", "The total before tax is $1,008.00."); bad("T", "The total after discount is $1,200.00.");
  bad("T", "The crown is $960.00 plus tax."); good("T", "The crown is $1,200.00.");

  // (g) over-blocks that must stay allowed
  good("H", "Three installments of $600.00."); good("H", "Payment is in three installments of $600.00 each."); good("H", "The contractor is Pinnacle Paving, represented by President Octavia Brandt.");
  good("H", "Pinnacle Paving is represented by President Octavia Brandt."); good("D", "Tuition is $1,150.00 per month, due on enrollment."); good("T", "The estimate expires 08/07/2026.");

  // loop 1: identifiers, polarity, bounds, pairs, units, sex, status, names, topics, derived figures
  for (const t of ["The microchip is 985112004567839.", "Tax ID 86-1234576.", "The container is MSKU 4417290.", "The microchip is 985 112 004 567 839."]) bad("R", t);
  for (const t of ["The microchip is 985112004567893.", "Tax ID 86-1234567.", "The container is MSKU 4417209."]) good("R", t);
  bad("R", "Juniper is female."); good("R", "Juniper is male."); bad("R", "Juniper is a female cat.");
  bad("R", "Rabies is 1 ml intramuscular."); bad("R", "Distemper is 0.5 ml subcutaneous."); bad("R", "Rabies is 0.5 ml."); good("R", "Rabies is 1 ml subcutaneous."); good("R", "Distemper is 0.5 ml intramuscular.");
  bad("R", "The customer owes $676.00."); good("R", "The invoice is paid."); good("R", "The balance is $0.00."); good("R", "The total was $676.00 and it is paid.");
  for (const t of ["Flood is covered.", "It covers the battery.", "The warranty is void.", "Permit fees are included.", "The deposit is refundable.", "The cancellation fee is non-refundable.",
    "It was signed by the principal.", "It was not signed by the notary.", "Keep indoors.", "The order was delivered.", "Goods and services were provided."]) bad("P", t);
  for (const t of ["Flood is not covered.", "Wind is covered.", "It does not cover the battery.", "It covers the screen.", "The warranty is void if opened.", "Permit fees are not included.", "The inspection fee is included.",
    "The deposit is non-refundable.", "The cancellation fee is refundable if unused.", "It was not signed by the principal.", "It was signed by the notary.", "Keep outdoors.", "The delivery status is in transit.",
    "No goods or services were provided.", "The customer received a brochure."]) good("P", t);
  bad("P", "The deposit is at least $500.00."); bad("P", "The minimum payment is up to $250.00."); bad("P", "The minimum payment is at most $250.00."); good("P", "The deposit is up to $500.00."); good("P", "The minimum payment is $250.00."); good("P", "The minimum payment is at least $250.00.");
  bad("P", "Premium decreases from $1,200.00 to $1,380.00."); bad("P", "Premium increases from $1,380.00 to $1,200.00."); good("P", "Premium increases from $1,200.00 to $1,380.00.");
  bad("P", "$225.00 partners, $350.00 associates."); good("P", "$350.00 partners, $225.00 associates."); bad("P", "Workmanship is 25 years and materials is 5 years."); bad("P", "25 years workmanship, 5 years materials."); good("P", "25 years materials, 5 years workmanship.");
  bad("K", "The ridge vent is 60 sq ft."); good("K", "The ridge vent is 60 linear ft."); good("K", "The roof area is 60 sq ft."); bad("K", "Decaf is 5 lb."); good("K", "Decaf is 2 lb."); bad("K", "Regular is 2 lb.");
  bad("K", "$75,000.00 is due on signing."); bad("K", "A credit of $150.00 was added to the total."); good("K", "A credit of $150.00 is applied to the total.");
  good("K", "The quote is valid for 30 days from 05/09/2026."); good("K", "The term is 24 months from 02/15/2026."); good("K", "The term expires February 15, 2028."); good("K", "The term expires 2028-02-15."); bad("K", "The term expires February 15, 2029.");
  good("K", "50% on signing ($37,500.00)."); good("K", "Half is paid on signing."); good("K", "Half is due on signing."); bad("K", "50% on signing ($40,000.00).");
  bad("M", "The matter is a divorce."); good("M", "The matter is an employment dispute."); bad("M", "The status is closed."); good("M", "The status is open."); bad("M", "The client is Ezekiel R. Montgomery."); good("M", "The client is Ezekiel P. Montgomery."); good("M", "The client is Ezekiel Montgomery.");
  bad("M", "The client is Ezra Mont\u200bgomery.");
  { const mk = (label, value) => h.gate.applyGrounding({ kind: "answer", text: "Here is the matter.", confidence: 0.9, sources: [], facts: [{ label, value, sources: [cs("M")] }] }, ev, { today: "2026-10-07" });
    check("R2g card: wrong middle initial is removed", (mk("Client", "Ezekiel R. Montgomery").facts ?? []).length === 0, "");
    check("R2g card: right middle initial is kept", (mk("Client", "Ezekiel P. Montgomery").facts ?? []).length === 1, "");
    const mr = (label, value) => h.gate.applyGrounding({ kind: "answer", text: "Here is the record.", confidence: 0.9, sources: [], facts: [{ label, value, sources: [cs("R")] }] }, ev, { today: "2026-10-07" });
    check("R2g card: wrong microchip is removed", (mr("Microchip", "985112004567839").facts ?? []).length === 0, "");
    check("R2g card: right microchip is kept", (mr("Microchip", "985112004567893").facts ?? []).length === 1, "");
    check("R2g card: wrong Tax ID is removed", (mr("Tax ID", "86-1234576").facts ?? []).length === 0, ""); }

  // page numbers cited: the cited page must contain the claimed figure (page 1 here; page 9 does not exist)
  { const d = h.gate.applyGrounding({ kind: "answer", text: "The deposit is $300.00.", confidence: 0.9, facts: [], sources: [{ documentId: h.ids.D, location: { page: 9 } }] }, ev, { today: "2026-10-07" });
    check("R2g page: a cited page that does not exist is not shown as support", !(kept(d) && JSON.stringify(d.sources ?? []).includes('"page":9')), JSON.stringify(d.sources ?? []).slice(0, 160)); }
  { const mk = (label, value) => h.gate.applyGrounding({ kind: "answer", text: "Here is the agreement.", confidence: 0.9, sources: [], facts: [{ label, value, sources: [cs("D")] }] }, ev, { today: "2026-10-07" });
    check("R2g card: wrong director name is removed", (mk("Director", "Renata Alvarez").facts ?? []).length === 0, "");
    check("R2g card: right director name is kept", (mk("Director", "Winifred Castellano").facts ?? []).length === 1, "");
    check("R2g card: right emergency contact is kept", (mk("Emergency contact", "Hollis Pruitt").facts ?? []).length === 1, "");
    const pg = (page) => h.gate.applyGrounding({ kind: "answer", text: "The deposit is $300.00.", confidence: 0.9, facts: [], sources: [{ documentId: h.ids.D, location: { page } }] }, ev, { today: "2026-10-07" });
    check("R2g page: the right page is kept as cited", kept(pg(1)) && pg(1).sources[0].location.page === 1, ""); }
  { const t = process.hrtime.bigint(); for (let i = 0; i < 20; i++) gate("T", "The total before tax is $960.00 and the dentist is Dr. Imelda Voss, DDS."); const ms = Number(process.hrtime.bigint() - t) / 1e6 / 20;
    check("R2g gate stays fast", ms < 20, `${ms.toFixed(1)} ms`); }
}
