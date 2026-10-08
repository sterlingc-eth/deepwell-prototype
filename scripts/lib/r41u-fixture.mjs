// R41U fixtures: fresh names / amounts (nothing copied from r40-fixture.mjs). The page text is BUILT from the rows below, and every "right" and "wrong" answer in the
// sections is derived from the same rows, so the expected output is computed from raw data, not typed in twice.
export const money = (n) => `${n < 0 ? "-" : ""}$${Math.abs(Number(n)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const R = {
  inv: { num: "INV-7720", vendor: "Cedar Flats Plumbing", vendorAddr: "1200 N Ocotillo Pkwy, Chandler, AZ 85224", mdy: "04/11/2026", iso: "2026-04-11", longDate: "April 11, 2026", customer: "Thaddeus Wainwright", svcStreet: "418 E Sagebrush Ct, Unit 7C", svcCity: "Gilbert", svcZip: "85296", brand: "Navien", model: "NPE-240A", serial: "NV4419027", laborHrs: 4.5, partsYrs: 7, laborYrs: 2, subtotal: 2340, tax: 187.2, tech: "Marisol Quintanilla", account: "30417", phone: "(480) 555-0162", gallons: 40 },
  inv2: { num: "INV-7721", vendor: "Hollis Drain Works", mdy: "02/19/2026", iso: "2026-02-19", customer: "Ambrose Pettigrew-Hale", street: "63 S Yucca Way", city: "Mesa", zip: "85202", total: 640, tech: "Lucian Obregon", laborHrs: 2 },
  cm: { num: "CM-5102", mdy: "04/20/2026", iso: "2026-04-20", credit: 318.6, reason: "Unused parts returned" },
  war: { num: "WC-81004", name: "Pinecrest Climate Warranty Certificate", customer: "Rosalind Achterberg", equip: "Trane XR14", serial: "4120C77231", partsYrs: 10, laborYrs: 1, installed: "June 3, 2026", expires: "June 3, 2036", contact: "Evander Lisowski", phone: "(520) 555-0188", email: "claims@pinecrestclimate.com" },
  agr: { num: "MA-6200", customer: "Brightwater Apartments LLC", fee: 1200, visits: 4, termYrs: 2, start: "March 1, 2026", end: "February 28, 2028", signer: "Evander Lisowski", property: "90 W Mesquite Blvd, Mesa, AZ 85201" },
  lease: { num: "L-9150", tenant: "Oriel Nakamura-Reyes", landlord: "Sundial Property Group", premises: "77 N Poplar Ave, Apt 4, Tempe, AZ 85281", rent: 2100, deposit: 3150, parking: 1, start: "January 1, 2026", end: "December 31, 2026" },
};
const inv = R.inv; inv.total = inv.subtotal + inv.tax;
export const DOCS = {
  A: { num: inv.num, customer: inv.customer, iso: inv.iso, total: inv.total, addr: `${inv.svcStreet}, ${inv.svcCity}, AZ ${inv.svcZip}`, file: "cedar-flats-7720.pdf", text:
`${inv.vendor}
${inv.vendorAddr}
INVOICE
Invoice #: ${inv.num}
Date: ${inv.mdy}
Bill To: ${inv.customer}
Account #: ${inv.account}
Service Address: ${inv.svcStreet}, ${inv.svcCity}, AZ ${inv.svcZip}
Equipment: ${inv.brand} ${inv.model} tankless water heater
Serial: ${inv.serial}
Description of work: Replaced ${inv.gallons} gallon tank heater with tankless unit, flushed lines
Labor: ${inv.laborHrs} hrs
Parts warranty: ${inv.partsYrs} years
Labor warranty: ${inv.laborYrs} years
Subtotal: ${money(inv.subtotal)}
Tax: ${money(inv.tax)}
TOTAL DUE: ${money(inv.total)}
Technician: ${inv.tech}
Phone: ${inv.phone}` },
  B: { num: R.inv2.num, customer: R.inv2.customer, iso: R.inv2.iso, total: R.inv2.total, addr: `${R.inv2.street}, ${R.inv2.city}, AZ ${R.inv2.zip}`, file: "hollis-7721.pdf", text:
`${R.inv2.vendor}
INVOICE
Invoice #: ${R.inv2.num}
Date: ${R.inv2.mdy}
Bill To: ${R.inv2.customer}
Service Address: ${R.inv2.street}, ${R.inv2.city}, AZ ${R.inv2.zip}
Description of work: Hydro-jetted kitchen drain, camera inspection
Labor: ${R.inv2.laborHrs} hrs
TOTAL DUE: ${money(R.inv2.total)}
Technician: ${R.inv2.tech}` },
  C: { num: R.cm.num, customer: inv.customer, iso: R.cm.iso, total: -R.cm.credit, kind: "credit_memo", file: "cm-5102.pdf", text:
`${inv.vendor}
CREDIT MEMO
Credit Memo #: ${R.cm.num}
Date: ${R.cm.mdy}
Bill To: ${inv.customer}
Reference: ${inv.num}
Credit: ${money(-R.cm.credit)}
Reason: ${R.cm.reason}` },
  W: { num: R.war.num, customer: R.war.customer, iso: "2026-06-03", total: null, file: "pinecrest-warranty.pdf", text:
`${R.war.name}
Warranty #: ${R.war.num}
Customer: ${R.war.customer}
Equipment: ${R.war.equip} condenser
Serial: ${R.war.serial}
Installation date: 2026-06-03
Parts warranty: ${R.war.partsYrs} years
Labor warranty: ${R.war.laborYrs} year
Warranty expires: ${R.war.expires}
Contact: ${R.war.contact}, ${R.war.phone}
Email: ${R.war.email}` },
  M: { num: R.agr.num, customer: R.agr.customer, iso: "2026-03-01", total: R.agr.fee, file: "brightwater-agreement.pdf", text:
`Maintenance Agreement
Agreement #: ${R.agr.num}
Customer: ${R.agr.customer}
Annual fee: ${money(R.agr.fee)}
Visits per year: ${R.agr.visits}
Term: ${R.agr.termYrs} years
Start date: ${R.agr.start}
End date: ${R.agr.end}
Signed by: ${R.agr.signer}
Property: ${R.agr.property}` },
  L: { num: R.lease.num, customer: R.lease.tenant, iso: "2026-01-01", total: null, file: "nakamura-lease.pdf", text:
`Residential Lease
Tenant: ${R.lease.tenant}
Landlord: ${R.lease.landlord}
Premises: ${R.lease.premises}
Lease start: ${R.lease.start}
Lease end: ${R.lease.end}
Monthly rent: ${money(R.lease.rent)}
Security deposit: ${money(R.lease.deposit)}
Parking spaces: ${R.lease.parking}` },
};
/** the question that retrieves each document on the model path, and the safe card that cites it */
export const ASK = {
  A: "show me the Sagebrush Ct Navien tankless water heater job", B: "show me the Hollis Drain Works kitchen drain job on Yucca Way", C: "show me the Cedar Flats unused parts returned credit",
  W: "show me the Pinecrest Trane XR14 condenser warranty certificate", M: "show me the Brightwater Apartments maintenance agreement visits per year", L: "show me the Nakamura-Reyes Poplar Ave lease terms",
};
export const SAFE = { A: ["Invoice", R.inv.num], B: ["Invoice", R.inv2.num], C: ["Credit memo", R.cm.num], W: ["Warranty", R.war.num], M: ["Agreement", R.agr.num], L: ["Document", "Residential Lease"] };
