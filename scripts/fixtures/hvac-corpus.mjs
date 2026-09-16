// hvac-corpus.mjs
//
// Test fixture for DeepWell (HVAC document search). Exports a synthetic
// corpus of 12 scanned-paperwork-style documents and 70 eval questions
// against them.
//
// GROUND-TRUTH RULE: every value inside a question's `expect` block
// (docs, pages, anyOf substrings) must be verifiably present in the
// CORPUS text below. This file's own self-check script asserts that
// automatically -- if you edit either CORPUS or QUESTIONS, re-run the
// self-check before trusting the eval results. A question with a wrong
// expectation is worse than no question at all: it makes the eval lie.
//
// All companies, people, addresses, and document numbers are invented.
// Manufacturer names (Carrier, Trane, Goodman, Lennox, Rheem) are used
// because they are the real product lines that would appear on this
// kind of paperwork; no actual company's documents are reproduced.

export const CORPUS = [
  {
    key: 'invoice-whitmore',
    filename: 'carrier-invoice-8841.pdf',
    documentType: 'invoice',
    pages: [
      {
        page_no: 1,
        text: `STERLING COMFORT SYSTEMS
4410 Industrial Pkwy, Springdale, OH 45501
Phone: (614) 555-0142
INVOICE

Invoice #: 8841
Invoice Date: 03/10/2024
Bill To: Marcus Feld
Service Address: 214 Whitmore Ave, Springdale, OH 45501
Customer Phone: (614) 555-2290

Description                                          Qty   Unit Price     Total
Carrier Performance 16 Condensing Unit, 3 Ton
  Model: 24ACC636A003   Serial: CG-4021-A              1    $3,890.00   $3,890.00
Refrigerant R-410A, 8 lb charge at install                 $18.50/lb     $148.00
Line set replacement, 3/8 x 7/8 copper, 25 ft                            $410.00
Labor - install and commission, 2 techs, 9 hrs             $135.00/hr  $1,215.00
Electrical disconnect and whip, 30A                                     $185.00
Mechanical permit fee, City of Springdale                               $125.00
Disposal and reclaim of old R-22 condensing unit                        $95.00

Subtotal                                                              $6,068.00
Sales Tax (7.25%)                                                       $440.93
Total Due                                                             $6,508.93
Payment Terms: Net 15. Paid via check #4102 on 03/22/2024.

Lead Installer: Wes Okafor. Removed prior R-22 system, original install
year unknown to homeowner, condenser tag illegible. New system startup
readings recorded on warranty registration sheet attached. Thank you
for choosing Sterling Comfort Systems, Dealer #OH-3391.`,
      },
      {
        page_no: 2,
        text: `CARRIER RESIDENTIAL WARRANTY REGISTRATION
(Attachment to Invoice #8841)

Equipment Installed At: 214 Whitmore Ave, Springdale, OH 45501
Model Number: 24ACC636A003
Serial Number: CG-4021-A
Installation Date: 03/10/2024
Homeowner: Marcus Feld

Warranty Type: 10-Year Parts Limited Warranty (registration completed
within 90-day window, standard unregistered coverage would be 5-Year
Parts). Compressor coverage: 10 years from installation date regardless
of registration status.

Warranty Expiration: 2034-03-10

Registered By: Sterling Comfort Systems, Dealer #OH-3391
Startup Readings: Superheat 11F, Subcooling 9F, Static Pressure 0.55 in
wc, all within manufacturer specification.
Notes: Homeowner advised to schedule annual maintenance to preserve
warranty eligibility. Furnace paired with this condenser (Trane
4TTR6036J1000AA) is covered under a separate manufacturer warranty --
see maintenance agreement MA-2024-0031 for full equipment list.`,
      },
    ],
  },
  {
    key: 'warranty-whitmore',
    filename: 'carrier-warranty-card-cr990214.pdf',
    documentType: 'warranty-card',
    pages: [
      {
        page_no: 1,
        text: `CARRIER CORPORATION
Residential Products Warranty Registration Card

Owner Name: Marcus Feld
Installation Address: 214 Whitmore Ave, Springdale, OH 45501
Model Number: 24ACC636A003
Serial Number: CG-4021-A
Date Installed: 03/10/2024
Date Registered: 03/12/2024
Installing Dealer: Sterling Comfort Systems, Dealer #OH-3391

Warranty Coverage Confirmed:
  Compressor: 10 years from installation date
  All Other Parts: 10 years from installation date (registered unit)
  Standard coverage without registration would have been: Parts 5 years

This card confirms your registration was received and processed
successfully. No further action is required. Retain this card with
your closing paperwork and invoice for future service calls.

Certificate #: CR-990214
Registration Method: Online, submitted by dealer on customer's behalf
Customer Service: 1-800-555-9021, reference certificate number above
if calling to verify coverage on a future repair.`,
      },
    ],
  },
  {
    key: 'service-ticket-feld',
    filename: 'sterling-ticket-st25519.pdf',
    documentType: 'service-ticket',
    pages: [
      {
        page_no: 1,
        text: `STERLING COMFORT SYSTEMS - SERVICE TICKET

Ticket #: ST-25519
Date: August 22, 2025
Customer: Marcus Feld
Service Address: 214 Whitmore Ave, Springdale, OH 45501
Unit Serviced: Carrier condenser, Model 24ACC636A003, Serial CG-4021-A
Technician: Ray Doss
Time on Site: 10:15 AM - 11:40 AM

Complaint: Routine annual maintenance visit, no issues reported by
homeowner prior to visit.

Work Performed: Cleaned condenser coil with coil cleaner and rinse,
checked refrigerant charge by subcooling method (10F, within spec),
tightened all electrical lugs at disconnect and contactor, replaced
air filter size 40x25x1, tested run capacitor rated 38/5 MFD, measured
39.1/5.2 MFD (pass), inspected contactor contacts and found minor
pitting, condenser fan motor amp draw 1.1A.

Amp Draw Recorded: Compressor 14.2A (rated 16.5A FLA), Condenser Fan
1.1A. Both within nameplate rating.`,
      },
      {
        page_no: 2,
        text: `Findings and Recommendations

Overall system condition: Good. No refrigerant leaks detected with
electronic leak detector. Accessible ductwork sections show no visible
damage or disconnection.

Recommended Repair: Replace contactor at next visit due to minor
contact pitting observed today. Estimated cost $145.00 parts and
labor. Not an emergency; monitor for chattering or failure to engage.

Customer Response: Declined additional repairs at this time, will
revisit at fall furnace visit.

Maintenance Plan Status: Active, Gold Plan, Agreement MA-2024-0031.
Next visit due: August 2026 (spring AC check).

Total Charged Today: $0.00, visit covered under maintenance agreement.

Office Notes: Customer also has a Trane furnace, Serial 1823H41928, on
the same maintenance agreement at this address, due for its fall
heating-season visit in October 2025.

Technician Signature: Ray Doss`,
      },
    ],
  },
  {
    key: 'maintenance-agreement-feld',
    filename: 'sterling-maint-agreement-ma20240031.pdf',
    documentType: 'maintenance-agreement',
    pages: [
      {
        page_no: 1,
        text: `STERLING COMFORT SYSTEMS
Residential Maintenance Agreement

Agreement #: MA-2024-0031
Customer: Marcus Feld
Service Address: 214 Whitmore Ave, Springdale, OH 45501
Plan Name: Gold Plan
Visits Included: Two annually (one spring cooling check, one fall
heating check)

Effective Date: 2024-04-01
Term: 3 years, renews annually thereafter unless cancelled
Annual Cost: $315.00, billed each April to card on file
Plan Benefits: Priority scheduling ahead of non-plan customers, 15%
discount on repair parts and labor, no overtime or after-hours
surcharge, filter replacement included at every visit (filter size
40x25x1 for the furnace unit at this address).

Payment Method on File: Visa ending 4471, auto-renews annually unless
cancelled in writing 30 days before renewal date.`,
      },
      {
        page_no: 2,
        text: `Covered Equipment

1. Carrier Performance 16 Condensing Unit
   Model: 24ACC636A003   Serial: CG-4021-A   Installed: 03/10/2024

2. Trane XV80 Series Gas Furnace
   Model: 4TTR6036J1000AA   Serial: 1823H41928   Installed: 03/10/2024

Both units were installed the same day as part of a full system
replacement documented on Invoice #8841. This agreement does not cover
ductwork, thermostat batteries, or damage caused by electrical surge
or flooding.

Exclusions: Refrigerant leak repair beyond 1 lb per visit, duct
sealing, and any equipment not listed above.

Signed: Marcus Feld               Date: 2024-04-01
Sterling Comfort Systems Representative: Dana Whitfield`,
      },
    ],
  },
  {
    key: 'invoice-goodman-hillcrest',
    filename: 'apex-invoice-5502.pdf',
    documentType: 'invoice',
    pages: [
      {
        page_no: 1,
        text: `APEX AIR MECHANICAL
102 Foundry St, Fairview, OH 45602
Phone: (614) 555-0388
INVOICE

Invoice #: 5502
Invoice Date: June 14, 2022
Bill To: Linda Torres
Service Address: 88 Hillcrest Rd, Fairview, OH 45602

Description                                                      Total
Goodman GMVC96 Gas Furnace, 110,000 BTU Input, 96% AFUE
  Model: 96G1UH110CE20   Serial: 4021HG3390                  $3,150.00
Flue venting kit, PVC 2 in                                       $95.00
Condensate pump replacement                                     $135.00
Labor - removal and install, 1 technician, 7 hrs                $945.00
Thermostat, Honeywell T6 Pro                                     $165.00
Permit and inspection fee, City of Fairview                      $110.00

Subtotal                                                       $4,600.00
Sales Tax (7.25%)                                                 $333.50
Total Due                                                       $4,933.50
Paid in full via check #2291 on 06/16/2022.

Installing Technician: Priya Nathan. Old furnace was a 1998 Rheem unit,
removed and hauled away same visit. Homeowner requested Goodman brand
specifically for cost. Apex Air Mechanical, Dealer #OH-1187.`,
      },
      {
        page_no: 2,
        text: `GOODMAN MANUFACTURING WARRANTY SUMMARY

Unit Installed At: 88 Hillcrest Rd, Fairview, OH 45602
Model: 96G1UH110CE20
Serial: 4021HG3390
Installation Date: June 14, 2022
Homeowner: Linda Torres

Warranty Type: 5-Year Parts Limited Warranty as manufactured; extends
to 10-Year Parts Limited Warranty when registered within 60 days of
installation.

Registration Status: Registered on file with Goodman Manufacturing,
10-year parts warranty confirmed as applicable to this unit.

Warranty Expiration: 2032-06-14
Heat Exchanger Warranty: Lifetime, original registered owner only, not
transferable to subsequent homeowners.

Installing Dealer: Apex Air Mechanical, Dealer #OH-1187
Customer Service: 1-800-555-4420 for warranty claims, have serial
number and installation date ready when calling.`,
      },
    ],
  },
  {
    key: 'warranty-goodman-hillcrest',
    filename: 'goodman-warranty-card-gm771204.pdf',
    documentType: 'warranty-card',
    pages: [
      {
        page_no: 1,
        text: `GOODMAN MANUFACTURING
Warranty Registration Confirmation

Owner Name: Linda Torres
Installation Address: 88 Hillcrest Rd, Fairview, OH 45602
Model Number: 96G1UH110CE20
Serial Number: 4021HG3390
Date Installed: 06/14/2022
Date Registered: 06/20/2022
Installing Dealer: Apex Air Mechanical, Dealer #OH-1187

Coverage Confirmed:
  Parts: 10 years from installation date
  Heat Exchanger: Lifetime, original registered owner
  Compressor: Not applicable, this is a furnace, no compressor present

Confirmation Number: GM-771204
This card serves as proof of registration in the event of a warranty
dispute or dealer transfer. Keep with your Invoice #5502 and other
closing documents for this address. If Apex Air Mechanical is no
longer in business at time of claim, contact Goodman directly with
confirmation number GM-771204.`,
      },
    ],
  },
  {
    key: 'service-ticket-hillcrest-noheat',
    filename: 'apex-ticket-ax3390.pdf',
    documentType: 'service-ticket',
    pages: [
      {
        page_no: 1,
        text: `APEX AIR MECHANICAL - SERVICE TICKET

Ticket #: AX-3390
Date: 11/02/2023
Customer: Linda Torres
Service Address: 88 Hillcrest Rd, Fairview, OH 45602
Unit: Goodman furnace, Model 96G1UH110CE20, Serial 4021HG3390
Technician: Priya Nathan

Complaint: No heat. Homeowner reports thermostat calls for heat, fan
runs, but burners never ignite. Started overnight, outdoor temp 28F.

Diagnosis: Hot surface igniter failed continuity test, measured 0 ohms
where 40-70 ohms expected, confirming open circuit. Flame sensor also
showed visible corrosion on the sensing rod, likely contributing to
prior intermittent lockouts reported in September.`,
      },
      {
        page_no: 2,
        text: `Repair Performed

Replaced hot surface igniter, part #IG-330, and cleaned flame sensor
rod with fine emery cloth per manufacturer procedure.
Verified ignition sequence with three successful heat cycles observed
before leaving site, each under 5 seconds to light.

Parts: Igniter IG-330                                    $58.00
Labor: 1 hr emergency after-hours service                $165.00
Total Charged: $223.00, paid by credit card ending 5581

Technician Notes: Recommend flame sensor replacement next heating
season if corrosion recurs; sensor itself was cleaned, not replaced,
today. Air filter was dirty, size 16x25x1, replaced at no additional
charge as courtesy.

Technician Signature: Priya Nathan`,
      },
    ],
  },
  {
    key: 'quote-hillcrest-hoa',
    filename: 'bluepoint-quote-q6602.pdf',
    documentType: 'quote',
    pages: [
      {
        page_no: 1,
        text: `BLUEPOINT HVAC SOLUTIONS
900 Meridian Ave, Fairview, OH 45602
Phone: (614) 555-0771
QUOTE

Quote #: Q-6602
Date: 2026-01-15
Prepared For: Hillcrest Commons HOA
Site Address: 1 Hillcrest Rd, Fairview, OH 45602
Contact: Ellen Marsh, Property Manager

Scope of Work: Replace two aging rooftop package units serving the
clubhouse and fitness center buildings. Existing units are original to
1999 construction and no longer supported for parts. This quote does
not cover any individual residential units on Hillcrest Rd; site is
governed under HOA address numbering 1-6 Hillcrest Rd exclusively,
separate from single-family homes further down the same street.`,
      },
      {
        page_no: 2,
        text: `Proposed Equipment

Unit 1 (Clubhouse): Rheem RACA14 Package Unit, 5 Ton
  Model: RQNL-A060JK000
Unit 2 (Fitness Center): Rheem RACA14 Package Unit, 4 Ton
  Model: RQNL-A048JK000

Both units include factory economizer, roof curb adapter plates sized
to existing openings, and BACnet-compatible controls for integration
with the HOA's existing building automation system.

Estimated Combined Tonnage: 9 tons across both units.
Estimated Combined Airflow: approximately 3,600 CFM total.`,
      },
      {
        page_no: 3,
        text: `Pricing

Unit 1 equipment and installation                          $14,200.00
Unit 2 equipment and installation                           $11,800.00
Roof curb adaptation, both units                              $2,100.00
Electrical service upgrades                                   $3,400.00

Total Estimate: $31,500.00

Quote valid for 30 days from date above. Financing available through
Bluepoint's partner program at competitive rates for HOA capital
projects. A 50% deposit is required to order equipment, balance due
upon substantial completion.

Prepared by: Bluepoint HVAC Solutions, Estimator Todd Ryzner.`,
      },
    ],
  },
  {
    key: 'service-ticket-whitmore-logistics',
    filename: 'sterling-ticket-st2187.pdf',
    documentType: 'service-ticket',
    pages: [
      {
        page_no: 1,
        text: `STERLING COMFORT SYSTEMS - SERVICE TICKET

Ticket #: ST-2187
Date: 08/19/2019
Customer: Whitmore Logistics LLC
Service Address: 500 Commerce Dr, Unit 12, Springdale, OH 45501
Unit: Lennox rooftop package unit, Model LGH060H4EM1G, Serial LX-7734-B,
5 Ton, serving warehouse floor
Technician: Ray Doss

Complaint: Unit short cycling repeatedly, warehouse floor temperature
not reaching thermostat setpoint of 68F despite unit running most of
the day. Note: this commercial account, Whitmore Logistics LLC, has no
affiliation with the residential Whitmore Ave address across town; the
shared name is coincidental.`,
      },
      {
        page_no: 2,
        text: `Diagnosis and Repair

Found low refrigerant charge, system uses R-410A. Leak detected at a
brazed joint on the suction line near the service valve using
electronic sniffer and soap bubble confirmation.

Repaired brazed joint, pressure tested to 350 psi with nitrogen, held
30 minutes with no pressure drop. Evacuated system to 500 microns.
Recharged system with 6.5 lb of R-410A per manufacturer charge chart.

Labor: 3.5 hrs                                            $472.50
Refrigerant: 6.5 lb at $22.00/lb                          $143.00
Leak repair kit and brazing materials                      $45.00
Total Charged: $660.50, invoiced to accounts payable, Net 30 terms.

Note: Recommend annual leak check given age of brazed joints throughout
this rooftop unit's refrigerant circuit.`,
      },
    ],
  },
  {
    key: 'permit-feld',
    filename: 'springdale-permit-mp20241187.pdf',
    documentType: 'permit',
    pages: [
      {
        page_no: 1,
        text: `CITY OF SPRINGDALE
Department of Building and Safety
Mechanical Permit

Permit #: MP-2024-1187
Issued: 03/05/2024
Property Address: 214 Whitmore Ave, Springdale, OH 45501
Owner of Record: Marcus Feld
Contractor: Sterling Comfort Systems, License #HVAC-OH-3391
Contractor Phone: (614) 555-0142

Scope of Work: Replace existing R-22 split system condenser and
matching furnace with new equipment. Work includes new refrigerant
line set, duct connections at existing plenum, and new electrical
disconnect. No structural modifications included in this permit.

Permit Type: Mechanical - Residential Replacement
Valuation Declared: $6,500.00`,
      },
      {
        page_no: 2,
        text: `Inspection Record

Rough-In Inspection: 03/08/2024, Inspector J. Ackerman, Result:
Approved, no corrections noted.

Final Inspection: 03/14/2024, Inspector J. Ackerman, Result: Approved,
Passed. Equipment operation verified in both heating and cooling mode
at time of inspection.

Equipment Verified at Final:
  Carrier condenser, Model 24ACC636A003, Serial CG-4021-A
  Trane furnace, Model 4TTR6036J1000AA, Serial 1823H41928

Permit Status: CLOSED
Fee Paid: $125.00, Receipt #7743
Closed By: City of Springdale Building and Safety, 03/14/2024`,
      },
    ],
  },
  {
    key: 'submittal-trane-furnace',
    filename: 'trane-submittal-4ttr6036j1000aa.pdf',
    documentType: 'equipment-submittal',
    pages: [
      {
        page_no: 1,
        text: `SUBMITTAL DATA SHEET

Manufacturer: Trane
Model Number: 4TTR6036J1000AA
Description: XV80 Series Gas Furnace, Upflow Configuration, 60,000 BTU
Input, 80% AFUE

Prepared For: Sterling Comfort Systems
Project: Feld Residence, 214 Whitmore Ave, Springdale, OH 45501
Submittal Date: 2024-02-20
Submitted By: Dana Whitfield, Sterling Comfort Systems

Purpose: Pre-installation equipment approval for full system
replacement project, condenser side documented separately under
Invoice #8841.`,
      },
      {
        page_no: 2,
        text: `Technical Specifications

Nominal Cooling Capacity Match: 3 Ton, pairs with Carrier condenser
Model 24ACC636A003
Heating Input: 60,000 BTU/h
Heating Output: 48,000 BTU/h at 80% AFUE
Blower: Variable-speed ECM motor, 1/2 HP
Cabinet Dimensions: 17.5 in W x 28.5 in H x 33 in D
Filter Size Required: 40x25x1, MERV 8 minimum rating
Gas Connection: 1/2 in NPT
Electrical Requirement: 120V / 60Hz / 1-Phase, dedicated 15A circuit`,
      },
      {
        page_no: 3,
        text: `Approval

Reviewed By: Dana Whitfield, Sterling Comfort Systems
Approved for Installation: Yes
Serial Number Assigned at Install: 1823H41928

Comments: Unit paired with Carrier condenser Serial CG-4021-A per
Invoice #8841. Filter size confirmed to match the specification listed
on Maintenance Agreement MA-2024-0031 for this address. No substitution
requested by homeowner; Trane brand specified to match existing duct
transition already sized for this cabinet width.`,
      },
    ],
  },
  {
    key: 'inspection-hillcrest',
    filename: 'apex-inspection-2024-03-04.pdf',
    documentType: 'inspection-report',
    pages: [
      {
        page_no: 1,
        text: `ANNUAL SAFETY INSPECTION REPORT

Inspection Date: 2024-03-04
Property: 88 Hillcrest Rd, Fairview, OH 45602
Owner: Linda Torres
Unit Inspected: Goodman furnace, Model 96G1UH110CE20, Serial 4021HG3390
Inspector: Priya Nathan, Apex Air Mechanical

Purpose: Annual gas appliance safety check requested by homeowner's
insurance carrier as a condition of policy renewal. This inspection is
separate from and unrelated to any warranty service performed at this
address.`,
      },
      {
        page_no: 2,
        text: `Findings

Combustion Analysis: CO reading 4 ppm at flue outlet, well within the
100 ppm safety limit. Stack temperature 385F, normal for unit age.
Heat Exchanger: No visible cracks or corrosion found using camera
borescope inspection of accessible sections.
Gas Pressure: 3.5 in wc manifold pressure, within manufacturer
specification.
Filter Condition: Size 16x25x1, moderately dirty, replaced during this
visit at no charge.
Venting: PVC venting intact throughout, no blockage or sagging noted.

Overall Result: PASS
Report Filed: March 4, 2024
Next Inspection Due: March 2025
Inspector Signature: Priya Nathan`,
      },
    ],
  },
];

export const QUESTIONS = [
  // -------- warranty (8) --------
  { id: 1, q: 'when does the warranty on the whitmore ave condenser expire', group: 'warranty',
    expect: { docs: ['invoice-whitmore'], pages: [2], anyOf: ['Warranty Expiration: 2034-03-10'] } },
  { id: 2, q: 'is the carrier unit at 214 whitmore ave still under warranty', group: 'warranty',
    expect: { docs: ['invoice-whitmore', 'warranty-whitmore'], anyOf: ['10-Year Parts Limited Warranty', '10 years from installation date'] } },
  { id: 3, q: 'warranty expiration for linda torres furnace', group: 'warranty',
    expect: { docs: ['invoice-goodman-hillcrest'], pages: [2], anyOf: ['Warranty Expiration: 2032-06-14'] } },
  { id: 4, q: 'what confirmation number is on the goodman warranty card', group: 'warranty',
    expect: { docs: ['warranty-goodman-hillcrest'], anyOf: ['GM-771204'] } },
  { id: 5, q: 'certificate number for the carrier warranty registration', group: 'warranty',
    expect: { docs: ['warranty-whitmore'], anyOf: ['CR-990214'] } },
  { id: 6, q: 'does the goodman furnace at 88 hillcrest have a lifetime heat exchanger warranty', group: 'warranty',
    expect: { docs: ['invoice-goodman-hillcrest', 'warranty-goodman-hillcrest'], anyOf: ['Heat Exchanger Warranty: Lifetime', 'Heat Exchanger: Lifetime'] } },
  { id: 7, q: 'was the whitmore ave condenser registered within the 90 day window', group: 'warranty',
    expect: { docs: ['invoice-whitmore'], pages: [2], anyOf: ['registration completed\nwithin 90-day window', 'within 90-day\nwindow', '90-day'] } },
  { id: 8, q: 'what warranty would the goodman furnace have gotten without registration', group: 'warranty',
    expect: { docs: ['invoice-goodman-hillcrest'], pages: [2], anyOf: ['5-Year Parts Limited Warranty'] } },

  // -------- identifiers (12) --------
  { id: 9, q: 'lookup serial CG-4021-A', group: 'identifiers',
    expect: { docs: ['invoice-whitmore', 'warranty-whitmore', 'service-ticket-feld', 'maintenance-agreement-feld', 'permit-feld', 'submittal-trane-furnace'] } },
  { id: 10, q: 'what unit has model number 4TTR6036J1000AA', group: 'identifiers',
    expect: { docs: ['maintenance-agreement-feld', 'permit-feld', 'submittal-trane-furnace'], anyOf: ['Trane'] } },
  { id: 11, q: 'find equipment with model 96G1UH110CE20', group: 'identifiers',
    expect: { docs: ['invoice-goodman-hillcrest', 'warranty-goodman-hillcrest', 'service-ticket-hillcrest-noheat', 'inspection-hillcrest'], anyOf: ['Goodman'] } },
  { id: 12, q: 'serial number 1823H41928 which address is that', group: 'identifiers',
    expect: { docs: ['maintenance-agreement-feld', 'permit-feld', 'submittal-trane-furnace'], anyOf: ['214 Whitmore Ave'] } },
  { id: 13, q: 'what filter size is 40x25x1 used for', group: 'identifiers',
    expect: { docs: ['service-ticket-feld', 'maintenance-agreement-feld', 'submittal-trane-furnace'] } },
  { id: 14, q: 'serial 4021HG3390 lookup', group: 'identifiers',
    expect: { docs: ['invoice-goodman-hillcrest', 'warranty-goodman-hillcrest', 'service-ticket-hillcrest-noheat', 'inspection-hillcrest'] } },
  { id: 15, q: 'model RQNL-A060JK000', group: 'identifiers',
    expect: { docs: ['quote-hillcrest-hoa'], anyOf: ['Rheem'] } },
  { id: 16, q: 'unit with serial LX-7734-B', group: 'identifiers',
    expect: { docs: ['service-ticket-whitmore-logistics'], anyOf: ['Lennox'] } },
  { id: 17, q: 'part number IG-330 what is it', group: 'identifiers',
    expect: { docs: ['service-ticket-hillcrest-noheat'], anyOf: ['igniter'] } },
  { id: 18, q: 'dealer number OH-3391', group: 'identifiers',
    expect: { docs: ['invoice-whitmore', 'warranty-whitmore', 'permit-feld'] } },
  { id: 19, q: 'model 24ACC636A003 what address is it installed at', group: 'identifiers',
    expect: { docs: ['invoice-whitmore', 'maintenance-agreement-feld', 'permit-feld', 'submittal-trane-furnace'], anyOf: ['214 Whitmore Ave'] } },
  { id: 20, q: 'goodman confirmation GM-771204', group: 'identifiers',
    expect: { docs: ['warranty-goodman-hillcrest'] } },

  // -------- service-history (10) --------
  { id: 21, q: 'who serviced the whitmore ave unit last', group: 'service-history',
    expect: { docs: ['service-ticket-feld'], anyOf: ['Ray Doss'] } },
  { id: 22, q: 'what happened on the no heat call at 88 hillcrest rd', group: 'service-history',
    expect: { docs: ['service-ticket-hillcrest-noheat'], anyOf: ['igniter failed continuity test'] } },
  { id: 23, q: 'last maintenance visit for marcus feld', group: 'service-history',
    expect: { docs: ['service-ticket-feld'], anyOf: ['August 22, 2025'] } },
  { id: 24, q: 'ticket ST-25519 what was found', group: 'service-history',
    expect: { docs: ['service-ticket-feld'], anyOf: ['minor\npitting', 'contact pitting'] } },
  { id: 25, q: 'ticket AX-3390 who was the technician', group: 'service-history',
    expect: { docs: ['service-ticket-hillcrest-noheat'], anyOf: ['Priya Nathan'] } },
  { id: 26, q: 'when was the refrigerant leak repaired at commerce dr', group: 'service-history',
    expect: { docs: ['service-ticket-whitmore-logistics'], anyOf: ['08/19/2019'] } },
  { id: 27, q: 'what did ray doss find on ticket ST-2187', group: 'service-history',
    expect: { docs: ['service-ticket-whitmore-logistics'], anyOf: ['low refrigerant charge'] } },
  { id: 28, q: 'contactor pitting found during which visit', group: 'service-history',
    expect: { docs: ['service-ticket-feld'], anyOf: ['contactor'] } },
  { id: 29, q: 'flame sensor corrosion noted on which ticket', group: 'service-history',
    expect: { docs: ['service-ticket-hillcrest-noheat'], anyOf: ['flame sensor'] } },
  { id: 30, q: 'when is the next furnace visit due for marcus feld', group: 'service-history',
    expect: { docs: ['service-ticket-feld'], pages: [2], anyOf: ['fall\nheating-season visit in October 2025', 'October 2025'] } },

  // -------- cost (10) --------
  { id: 31, q: 'how much was invoice 8841', group: 'cost',
    expect: { docs: ['invoice-whitmore'], anyOf: ['Total Due                                                             $6,508.93', '$6,508.93'] } },
  { id: 32, q: 'total cost of the goodman furnace install', group: 'cost',
    expect: { docs: ['invoice-goodman-hillcrest'], anyOf: ['$4,933.50'] } },
  { id: 33, q: 'how much was the emergency igniter repair at hillcrest', group: 'cost',
    expect: { docs: ['service-ticket-hillcrest-noheat'], anyOf: ['Total Charged: $223.00'] } },
  { id: 34, q: 'cost to fix the refrigerant leak at whitmore logistics', group: 'cost',
    expect: { docs: ['service-ticket-whitmore-logistics'], anyOf: ['Total Charged: $660.50'] } },
  { id: 35, q: 'annual cost of the maintenance agreement for marcus feld', group: 'cost',
    expect: { docs: ['maintenance-agreement-feld'], pages: [1], anyOf: ['Annual Cost: $315.00'] } },
  { id: 36, q: 'how much is the hillcrest hoa quote', group: 'cost',
    expect: { docs: ['quote-hillcrest-hoa'], pages: [3], anyOf: ['Total Estimate: $31,500.00'] } },
  { id: 37, q: 'what was the permit fee for the feld job', group: 'cost',
    expect: { docs: ['permit-feld'], pages: [2], anyOf: ['Fee Paid: $125.00'] } },
  { id: 38, q: 'cost of recommended contactor replacement at whitmore ave', group: 'cost',
    expect: { docs: ['service-ticket-feld'], pages: [2], anyOf: ['$145.00'] } },
  { id: 39, q: 'how was invoice 5502 paid', group: 'cost',
    expect: { docs: ['invoice-goodman-hillcrest'], anyOf: ['check #2291'] } },
  { id: 40, q: 'price of unit 2 at the hillcrest commons clubhouse quote', group: 'cost',
    expect: { docs: ['quote-hillcrest-hoa'], pages: [3], anyOf: ['$11,800.00'] } },

  // -------- equipment (12) --------
  { id: 41, q: 'what condenser is installed at 214 whitmore ave', group: 'equipment',
    expect: { docs: ['invoice-whitmore'], anyOf: ['Carrier Performance 16 Condensing Unit'] } },
  { id: 42, q: 'what furnace does marcus feld have', group: 'equipment',
    expect: { docs: ['maintenance-agreement-feld', 'submittal-trane-furnace'], anyOf: ['Trane XV80 Series Gas Furnace', 'XV80 Series Gas Furnace'] } },
  { id: 43, q: 'tonnage of the carrier condenser at whitmore ave', group: 'equipment',
    expect: { docs: ['invoice-whitmore'], anyOf: ['3 Ton'] } },
  { id: 44, q: 'what brand furnace did linda torres get', group: 'equipment',
    expect: { docs: ['invoice-goodman-hillcrest'], anyOf: ['Goodman GMVC96 Gas Furnace'] } },
  { id: 45, q: 'afue rating of the goodman furnace at hillcrest rd', group: 'equipment',
    expect: { docs: ['invoice-goodman-hillcrest'], anyOf: ['96% AFUE'] } },
  { id: 46, q: 'what rooftop units are proposed for hillcrest commons hoa', group: 'equipment',
    expect: { docs: ['quote-hillcrest-hoa'], pages: [2], anyOf: ['Rheem RACA14 Package Unit'] } },
  { id: 47, q: 'what type of rooftop unit is at 500 commerce dr', group: 'equipment',
    expect: { docs: ['service-ticket-whitmore-logistics'], anyOf: ['Lennox rooftop package unit'] } },
  { id: 48, q: 'blower motor spec for the trane furnace', group: 'equipment',
    expect: { docs: ['submittal-trane-furnace'], pages: [2], anyOf: ['Variable-speed ECM motor, 1/2 HP'] } },
  { id: 49, q: 'what refrigerant does the whitmore logistics rooftop unit use', group: 'equipment',
    expect: { docs: ['service-ticket-whitmore-logistics'], anyOf: ['R-410A'] } },
  { id: 50, q: 'thermostat brand installed with the goodman furnace', group: 'equipment',
    expect: { docs: ['invoice-goodman-hillcrest'], anyOf: ['Honeywell T6 Pro'] } },
  { id: 51, q: 'gas connection size required for the trane 4TTR6036J1000AA', group: 'equipment',
    expect: { docs: ['submittal-trane-furnace'], pages: [2], anyOf: ['1/2 in NPT'] } },
  { id: 52, q: 'what filter size does the hillcrest rd furnace take', group: 'equipment',
    expect: { docs: ['service-ticket-hillcrest-noheat', 'inspection-hillcrest'], anyOf: ['16x25x1'] } },

  // -------- cross-document (10, expect.docs has 2+ entries) --------
  { id: 53, q: 'which documents mention marcus feld', group: 'cross-document',
    expect: { docs: ['invoice-whitmore', 'warranty-whitmore', 'service-ticket-feld', 'maintenance-agreement-feld', 'permit-feld', 'submittal-trane-furnace'] } },
  { id: 54, q: 'what jobs did ray doss work on', group: 'cross-document',
    expect: { docs: ['service-ticket-feld', 'service-ticket-whitmore-logistics'], anyOf: ['Ray Doss'] } },
  { id: 55, q: 'everything tied to invoice 8841', group: 'cross-document',
    expect: { docs: ['invoice-whitmore', 'maintenance-agreement-feld', 'submittal-trane-furnace'], anyOf: ['Invoice #8841'] } },
  { id: 56, q: 'what paperwork exists for the unit at 88 hillcrest rd', group: 'cross-document',
    expect: { docs: ['invoice-goodman-hillcrest', 'warranty-goodman-hillcrest', 'service-ticket-hillcrest-noheat', 'inspection-hillcrest'] } },
  { id: 57, q: 'who is priya nathan and what has she worked on', group: 'cross-document',
    expect: { docs: ['invoice-goodman-hillcrest', 'service-ticket-hillcrest-noheat', 'inspection-hillcrest'], anyOf: ['Priya Nathan'] } },
  { id: 58, q: 'is there a permit and a submittal for the same install', group: 'cross-document',
    expect: { docs: ['permit-feld', 'submittal-trane-furnace'], anyOf: ['1823H41928'] } },
  { id: 59, q: 'which records reference maintenance agreement MA-2024-0031', group: 'cross-document',
    expect: { docs: ['service-ticket-feld', 'maintenance-agreement-feld', 'submittal-trane-furnace'], anyOf: ['MA-2024-0031'] } },
  { id: 60, q: 'find every document for dana whitfield', group: 'cross-document',
    expect: { docs: ['maintenance-agreement-feld', 'submittal-trane-furnace'], anyOf: ['Dana Whitfield'] } },
  { id: 61, q: 'documents that mention both the carrier condenser and the trane furnace together', group: 'cross-document',
    expect: { docs: ['maintenance-agreement-feld', 'permit-feld', 'submittal-trane-furnace'], anyOf: ['CG-4021-A'] } },
  { id: 62, q: 'what work was done at 214 whitmore ave and by whom', group: 'cross-document',
    expect: { docs: ['invoice-whitmore', 'service-ticket-feld', 'permit-feld'], anyOf: ['Sterling Comfort Systems'] } },

  // -------- no-answer (exactly 8, expect.docs: []) --------
  { id: 63, q: 'warranty on the unit at 42 birchwood lane', group: 'no-answer',
    expect: { docs: [] } },
  { id: 64, q: 'serial number ZX-9999-Q lookup', group: 'no-answer',
    expect: { docs: [] } },
  { id: 65, q: 'when was the mitsubishi mini split at hillcrest installed', group: 'no-answer',
    expect: { docs: [] } },
  { id: 66, q: 'did the whitmore logistics rooftop unit ever get a full replacement', group: 'no-answer',
    expect: { docs: [] } },
  { id: 67, q: 'invoice number 9999 total due', group: 'no-answer',
    expect: { docs: [] } },
  { id: 68, q: 'who inspected the hillcrest commons hoa rooftop units after install', group: 'no-answer',
    expect: { docs: [] } },
  { id: 69, q: 'what happened to the daikin unit at 214 whitmore ave', group: 'no-answer',
    expect: { docs: [] } },
  { id: 70, q: 'was there ever a burst pipe claim at 88 hillcrest rd', group: 'no-answer',
    expect: { docs: [] } },
];
