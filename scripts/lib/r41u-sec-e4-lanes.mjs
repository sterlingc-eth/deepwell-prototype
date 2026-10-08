// E4 lanes: a catering firm with look-alike customers (Marsh/Hale/Johnson), a vendor that is also a customer, a credit memo, a PO, a future-dated invoice and a second
// organisation with one near-miss name. Every defect class is asked many ways; truth comes from the raw rows below; the stubbed model returns a WRONG answer that must
// never be shown, and exact lookups make 0 model calls.
export default async function ({ check, realLog, off, makeHarness }) {
  const usd = (n) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
  const doc = (num, party, iso, total, x = {}) => ({ num, customer: party, iso, total, file: `${num}.pdf`, text: `${x.direction === "payable" ? "BILL" : x.kind === "po" ? "PURCHASE ORDER" : "INVOICE"}\nNumber: ${num}\nDate: ${iso}\n${x.direction === "payable" ? "From" : "Bill To"}: ${party}\nTOTAL DUE: ${total == null ? "" : usd(total)}`, ...x });
  const iso = (m, d) => `2026-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const docs = {};
  ["Alan", "Beth", "Carl", "Dina", "Eli", "Fay", "Gus", "Hope", "Ian", "Jo", "Kim", "Lou"].forEach((f, j) => { docs["c" + j] = doc(`CAT-${2000 + j}`, `${f} Rowan`, iso(1 + j % 9, 1 + j), 100 + j * 37); });
  Object.assign(docs, {
    j1: doc("CAT-3001", "Sam Johnson", iso(3, 3), 3470), j2: doc("CAT-3002", "Sam Johnston", iso(4, 4), 3470.5), j3: doc("CAT-3003", "Sam Jonson", iso(5, 5), 347),
    j4: doc("CAT-3004", "Anne Marsh", iso(6, 6), 34.7), j5: doc("CAT-3005", "Ann Marsh", iso(7, 7), 3470),
    j6: doc("CAT-3006", "Tom Hale", iso(8, 8), 1200, { addr: "5 Oak St, Mesa, AZ" }), j7: doc("CAT-3007", "Tim Hale", iso(8, 9), 1300, { addr: "5 Oak St, Mesa, AZ" }),
    neg: doc("CAT-3008", "Vera Lopez", iso(8, 10), -3470, { kind: "credit_memo" }),
    fut: doc("CAT-3010", "Future Fran", iso(12, 20), 8800),
    v1: doc("BILL-77", "Cedar Linens", iso(5, 6), 3470, { direction: "payable", vendorName: "Cedar Linens" }),
    v3: doc("BILL-79", "Zenith Gas", iso(9, 9), 5000, { direction: "payable", vendorName: "Zenith Gas" }),
  });
  const other = { o3: doc("CAT-4", "Sam Johnsen", iso(3, 4), 8888), o1: doc("CAT-5", "Mallory Quint", iso(3, 3), 3470) };
  const h = await makeHarness({ off, tenantKey: "r41u-e4", docs });
  const ho = await makeHarness({ off, tenantKey: "r41u-e4-other", docs: other });
  const WRONG = { kind: "answer", text: "Invoice INV-1001 for Zebediah Crane totals $3,407.00 and was paid in full.", facts: [{ label: "Total", value: "$3,407.00", sources: [] }], sources: [], confidence: 0.95 };
  let calls = 0; const model = () => { calls++; return WRONG; };
  const prevHelp = process.env.ASK_HELPGATE_IN_SCORECARD; process.env.ASK_HELPGATE_IN_SCORECARD = "1";
  const ask = async (hh, q) => { const r = await hh.ask(q, model); const s = hh.shown(r); return { r, s, text: r.text }; };
  const noLeak = (s) => !/Zebediah|3,407\.00|INV-1001/.test(s);
  const inv = (n) => Object.values(docs).find((d) => d.num === n);
  const money = (n) => usd(inv(n).total);

  // 1. look-alike sections keep their own invoices
  const lookalikes = [["Marsh", [["Anne Marsh", "CAT-3004"], ["Ann Marsh", "CAT-3005"]]], ["Hale", [["Tom Hale", "CAT-3006"], ["Tim Hale", "CAT-3007"]]]];
  for (const [nm, people] of lookalikes) for (const tpl of ["wheres {} invoice", "whats {} invoice", "show me {} invoice", "{} invoice", "wheres the {} invoice", "show me the {} invoices", "where is {} invoice", "find {} invoice", "pull up {} invoice", "whats the {} invoice number"]) {
    const q = tpl.replace("{}", nm); calls = 0; const { r, s } = await ask(h, q);
    const text = r.text;
    const ok = people.every(([p, num], i) => {
      const at = text.indexOf(`${p}:`); if (at < 0) return false;
      const end = people[i + 1] ? text.indexOf(`${people[i + 1][0]}:`, at + 1) : text.indexOf("All ", at + 1);
      const sec = text.slice(at, end < 0 ? undefined : end);
      return sec.includes(num) && people.filter((_, k) => k !== i).every(([, other]) => !sec.includes(other));
    });
    check(`E4 d1 sections hold only their own invoices [${q}]`, ok && calls === 0 && noLeak(s), text.slice(0, 400));
  }
  // Sam: three people
  for (const q of ["wheres Sam invoice", "show me Sam invoices", "Sam invoice", "whats the Sam invoice", "where is Sam invoice"]) {
    const { r } = await ask(h, q); const m = (p, n) => { const at = r.text.indexOf(`${p}:`); return at >= 0 && r.text.slice(at, at + 140).includes(n); };
    check(`E4 d1 Sam sections [${q}]`, m("Sam Johnson", "CAT-3001") && m("Sam Johnston", "CAT-3002") && m("Sam Jonson", "CAT-3003") && !r.text.slice(r.text.indexOf("Sam Johnson:"), r.text.indexOf("Sam Johnston:")).includes("CAT-3002"), r.text.slice(0, 300));
  }
  // 2. near miss: ask / never answer as exact
  for (const q of ["wheres Sam Johnston invoice", "show me Sam Johnston invoices", "Sam Johnston invoice", "whats the Sam Johnston invoice", "where is the Sam Johnston invoice", "find Sam Johnston invoice", "pull up Sam Johnston invoice", "wheres sam johnston invoice", "show me the Sam Johnston invoice", "Sam Johnston invoices please"]) {
    calls = 0; const { r, s } = await ask(ho, q);
    check(`E4 d2 near miss asks, never answers as exact [${q}]`, /did you mean Sam Johnsen/i.test(r.text) && !/CAT-4|8,888/.test(r.text) && calls === 0 && noLeak(s), r.text.slice(0, 250));
  }
  // 3. direction by verb
  const dirCases = [
    ["the bill we sent for 3470", (t) => !/BILL-77/.test(t) && /CAT-3001/.test(t)], ["the bill we issued for 3470", (t) => !/BILL-77/.test(t) && /CAT-3001/.test(t)], ["the invoice we sent for 3470", (t) => !/BILL-77/.test(t) && /CAT-3001/.test(t)],
    ["whats the latest bill we sent", (t) => /latest invoice we sent/.test(t) && !/BILL-79/.test(t)], ["last bill we sent", (t) => /invoice we sent/.test(t) && !/BILL-79/.test(t)],
    ["whats the latest invoice we got", (t) => /bill we received/.test(t) && /BILL-79/.test(t)], ["latest invoice we received", (t) => /BILL-79/.test(t)], ["the invoice we got for 3470", (t) => /BILL-77/.test(t) && !/CAT-3001/.test(t)],
    ["the invoice we received for 3470", (t) => /BILL-77/.test(t) && !/CAT-3001/.test(t)], ["invoice we sent and received for 3470", (t) => /money coming in/.test(t)], ["the invoice we got for 3470 from a customer", (t) => /money coming in/.test(t)],
  ];
  for (const [q, ok] of dirCases) { calls = 0; const { r, s } = await ask(h, q); check(`E4 d3 direction [${q}]`, ok(r.text) && calls === 0 && noLeak(s), r.text.slice(0, 250)); }
  // 4. future-dated invoice never the newest/biggest silently
  for (const q of ["latest invoice", "whats the latest invoice", "newest invoice", "whats the newest invoice", "most recent invoice", "biggest invoice", "whats our biggest invoice", "largest invoice", "latest invoice from a customer", "whats the highest invoice"]) {
    calls = 0; const { r, s } = await ask(h, q);
    check(`E4 d4 future invoice left out and said [${q}]`, !/CAT-3010|8,800/.test(r.text) && /dated after today/.test(r.text) && calls === 0 && noLeak(s), r.text.slice(0, 250));
  }
  // 5. bill from a vendor
  for (const [q, v, n] of [["last bill from Zenith Gas", "Zenith Gas", "BILL-79"], ["latest bill from Zenith Gas", "Zenith Gas", "BILL-79"], ["most recent bill from Zenith Gas", "Zenith Gas", "BILL-79"], ["wheres the bill from Zenith Gas", "Zenith Gas", "BILL-79"], ["last bill from Cedar Linens", "Cedar Linens", "BILL-77"], ["latest bill from Cedar Linens", "Cedar Linens", "BILL-77"], ["whats the last bill from Cedar Linens", "Cedar Linens", "BILL-77"], ["show me the bill from Cedar Linens", "Cedar Linens", "BILL-77"], ["the last bill from Zenith Gas", "Zenith Gas", "BILL-79"], ["last bill Zenith Gas", "Zenith Gas", "BILL-79"]]) {
    calls = 0; const { r, s } = await ask(h, q);
    check(`E4 d5 bill goes to the vendor side [${q}]`, r.text.includes(n) && r.text.includes(money(n)) && !/No invoice with financial details/.test(r.text) && calls === 0 && noLeak(s), r.text.slice(0, 250));
  }
  // 6. a second amount / a status with an amount is never silently dropped
  for (const [q, re] of [["total of invoices for 3470 and 350", /350 was not applied/], ["invoices for 3470 or $350", /\$350 was not applied/], ["the invoice for 3470 and 347", /347 was not applied/], ["invoice 3470 and 34.70", /34\.70 was not applied/], ["invoices for 3470 and 8800", /8800 was not applied/], ["who owes us 3470", /whether or not it has been paid/], ["who still owes us 3470", /whether or not it has been paid/], ["which customer owes 3470", /whether or not it has been paid/], ["who owes 3470", /whether or not it has been paid/]]) {
    calls = 0; const { r, s } = await ask(h, q);
    check(`E4 d6 amount/status handled and said [${q}]`, re.test(r.text) && /CAT-3001/.test(r.text) && calls === 0 && noLeak(s), r.text.slice(0, 250));
  }
  // 7. a year is a year
  const fut = Object.values(docs).filter((d) => d.direction !== "payable" && d.kind !== "credit_memo" && d.total != null);
  for (const [q, ok] of [["invoices before december 24 2026", (t) => /invoices we sent before December 24, 2026/.test(t) && !/\$2,026/.test(t)], ["invoices from march 2026", (t) => /in March 2026/.test(t) && /CAT-3001/.test(t) && !/\$2,026/.test(t)], ["how many invoices in 2025", (t) => /^No invoices are on file in 2025/.test(t)], ["how many invoices in 2026", (t) => new RegExp(`${fut.length} invoices`).test(t)], ["invoices after august 2026", (t) => /CAT-3010/.test(t) && !/\$2,026/.test(t)], ["bills after august 2026", (t) => /BILL-79/.test(t)], ["invoice 3470 last month", (t) => /dated last month/.test(t) && !/\.00 last month/.test(t)], ["invoice 3470 from last year", (t) => /in 2025|dated last year/.test(t) && !/\.00 2025/.test(t)], ["invoices before december 24 2026 please", (t) => !/\$2,026/.test(t)], ["invoices before october 1 2026", (t) => /before October 1, 2026/.test(t)]]) {
    calls = 0; const { r, s } = await ask(h, q); check(`E4 d7 year is not an amount [${q}]`, ok(r.text) && calls === 0 && noLeak(s), r.text.slice(0, 250));
  }
  // 8. question words / my / our / view are never a name
  for (const q of ["wheres my invoice", "where are my invoices", "where can I view invoices", "whats my invoice", "where is our invoice", "where do I see my invoices", "wheres our invoices", "hows my invoice", "where can I see invoices", "whos my invoice"]) {
    calls = 0; const { r, s } = await ask(h, q);
    check(`E4 d8 never a customer named after a question word [${q}]`, !/customer named (?:Wheres|Where|Whats|Hows|Whos|Who)\b/i.test(r.text) && !/Wheres My|Where Are My|Where Can I/i.test(s) && noLeak(s), r.text.slice(0, 250));
  }
  // 11. counts agree
  for (const q of ["how many invoices do we have", "how many invoices have we got", "how many invoices"]) {
    calls = 0; const { r, s } = await ask(h, q);
    const total = Object.values(docs).length;
    check(`E4 d11 invoice count states what it counts [${q}]`, (new RegExp(`${fut.length} (?:customer )?invoices`).test(r.text) || /documents typed as invoices/.test(r.text)) && !new RegExp(`You have ${total} invoices`).test(r.text) && calls === 0 && noLeak(s), r.text.slice(0, 250));
  }
  // 10 (partial). credit memo is found, never "no internal-only documents"
  for (const q of ["credit memo for 3470", "the credit memo for 3470", "whats the credit memo for 3470", "show me the credit memo for 3470"]) {
    calls = 0; const { r, s } = await ask(h, q); check(`E4 d10 credit memo found [${q}]`, /CAT-3008/.test(r.text) && /credit memo/.test(r.text) && !/internal-only/.test(r.text) && noLeak(s), r.text.slice(0, 250));
  }
  if (prevHelp === undefined) delete process.env.ASK_HELPGATE_IN_SCORECARD; else process.env.ASK_HELPGATE_IN_SCORECARD = prevHelp;
  realLog(`E4 lanes: done; exact lookups p50 ${[...h.lats].sort((a, b) => a - b)[Math.floor(h.lats.length / 2)]} ms`);
}
