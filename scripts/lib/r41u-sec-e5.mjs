// E5: lookups by bare document number (a PO is never an "invoice"; a number that is also an invoice total is said so) and gate over/under-blocks
// (name suffixes and credentials, PO Box addresses, "three installments of $X", quoted nicknames, title words, prior balance). Fresh data.
export default async function ({ check, realLog, off, makeHarness }) {
  const usd = (n) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
  const inv = (num, party, iso, total, x = {}) => ({ num, customer: party, iso, total, file: `${num}.pdf`, text: `${x.direction === "payable" ? "BILL" : x.kind === "po" ? "PURCHASE ORDER" : "INVOICE"}\nNumber: ${num}\nDate: ${iso}\n${x.direction === "payable" ? "From" : "Bill To"}: ${party}\nTOTAL DUE: ${usd(total)}`, ...x });
  const docs = {
    a: inv("ZK-11", "Lena Brandt", "2026-02-02", 5120), b: inv("ZK-12", "Otis Wren", "2026-03-03", 5120), c: inv("ZK-13", "Pia Dorn", "2026-04-04", 5120.5),
    po: inv("5120", "Fennel Supply", "2026-05-05", 640, { direction: "payable", vendorName: "Fennel Supply", kind: "po" }),
    cm: inv("CM-9", "Rosa Vance", "2026-06-06", -75, { kind: "credit_memo" }),
    G: { num: "TX-77", customer: "Quillon Roofing", iso: "2026-07-01", total: 48000, file: "tx77.pdf", text:
`Quillon Roofing Contract
Crew lead: Anselmo Ruiz Jr.
Inspector: Dr. Lucinda Pham, MD
Salesperson: Reginald "Reggie" Thackeray
Signed for the owner by: Barnaby Quillfeather, President
Billing address: PO Box 4412, Mesa, AZ 85211
Prior balance: $15.00
Payment is in three installments.
Installment 1: $16,000.00
Installment 2: $16,000.00
Installment 3: $16,000.00
Total: $48,000.00` },
  };
  const h = await makeHarness({ off, tenantKey: "r41u-e5", docs });
  const prevHelp = process.env.ASK_HELPGATE_IN_SCORECARD; process.env.ASK_HELPGATE_IN_SCORECARD = "1";
  const WRONG = { kind: "answer", text: "Zebediah Crane owes $1.23.", facts: [], sources: [], confidence: 0.9 };
  const ask = async (q) => { const r = await h.ask(q, () => WRONG); return { r, s: h.shown(r) }; };

  // (a) bare number: a PO is a purchase order, and the invoices totalling that number are named
  for (const q of ["pull up invoice #5120", "invoice 5120", "show me invoice 5120 from Lena Brandt"]) {
    const { r, s } = await ask(q);
    check(`E5 a [${q}] PO is never called an invoice`, !/Invoice 5120/.test(r.text) && !/Fennel/.test(r.text.replace(/Purchase order 5120[^.]*\./, "")), s.slice(0, 300));
    check(`E5 a [${q}] names the invoices that total that number`, /\$5,120\.00/.test(r.text) && /Lena Brandt/.test(r.text) && !/Pia Dorn/.test(r.text) && (/Otis Wren/.test(r.text) || /Lena/.test(q)), r.text);
  }
  { const { r } = await ask("purchase order 5120"); check("E5 a purchase order asked by name stays a purchase order", /Purchase order 5120/.test(r.text) && !/Invoice 5120/.test(r.text), r.text); }

  // (b) gate
  const ev = h.evidence(); const src = [{ documentId: h.ids.G, location: { page: 1 } }];
  const gate = (text) => h.gate.applyGrounding({ kind: "answer", text, confidence: 0.9, facts: [], sources: src }, ev, { today: "2026-10-07" });
  const kept = (d) => d.kind === "answer" && !d.groundingWithdrawn && !d.groundingNote;
  for (const t of ["The crew lead is Anselmo Ruiz Jr.", "The inspector is Dr. Lucinda Pham, MD.", "The inspector is Dr. Lucinda Pham.",
    "Billing address is PO Box 4412, Mesa, AZ 85211.", "Three installments of $16,000.00.",
    "The salesperson is Reginald Thackeray.", "Reginald Thackeray, known as Reggie, is the salesperson.",
    "The prior balance is $15.00."]) check(`E5 b kept [${t}]`, kept(gate(t)), JSON.stringify(gate(t).text) + " " + JSON.stringify(gate(t).claimCheck?.unsupported ?? ""));
  check("E5 b wrong prior balance withdrawn", !kept(gate("The prior balance is $25.00.")), "");
  if (prevHelp === undefined) delete process.env.ASK_HELPGATE_IN_SCORECARD; else process.env.ASK_HELPGATE_IN_SCORECARD = prevHelp;
}
