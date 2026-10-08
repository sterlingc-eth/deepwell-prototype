// E2 A7: look-alike customers never merge; a named subject / typo never drops a filter; a year-less date takes the nearest sensible year; expiry windows come from stored dates vs today.
// Truth is computed from the raw export rows. Every question is deterministic (no model call is made by these lanes).
export default async function ({ check, realLog, off }) {
  const T = await import("./r41u-e2-tenant.mjs");
  const H = await import("./r41u-e2-henderson.mjs");
  const { parseExpiryWindow } = await import("../../api/_lib/lookups/expiryWindow.js");
  const has = (s, x) => String(s).includes(x);
  const base = H.hendersonExport("r41u-e2a7");
  const t = await T.loadTenant(off, base, { key: "r41u-e2a7" });
  const byName = (n) => H.openOf(base, (f) => f.customer_name === n);
  const mark = H.fmt(byName("Mark Henderson")), paula = H.fmt(byName("Paula Henderson")), roof = H.fmt(byName("Henderson Roofing LLC")), merged = H.fmt(H.openOf(base, (f) => /henderson/i.test(f.customer_name))), shop = H.fmt(H.openOf(base, () => true));
  check("A7 fixture: look-alike truths differ", new Set([mark, paula, roof, merged, shop]).size === 5, `${mark} ${paula} ${roof} ${merged} ${shop}`);

  // 1. "the Henderson invoices": every distinct full name with its OWN total, the combined figure only labelled as such, never the shop total
  const hQs = ["What's still unpaid on the Henderson invoices?", "whats still unpaid on the henderson invoices", "whats still unpaid on the henderson invoces", "what is unpaid on henderson invoices", "WHATS STILL UNPAID ON THE HENDERSON INVOICES", "what's outstanding on the Henderson invoices", "show me Henderson invoices unpaid", "Henderson invoces unpaid", "unpaid henderson invoice", "whats unpaid on the henderson invoices?", "what does henderson owe us", "how much is still open on the Henderson invoices"];
  for (const q of hQs) {
    const r = await t.ask(q);
    const ok = r.kind === "answer" && ["Mark Henderson", "Paula Henderson", "Henderson Roofing LLC", mark, paula, roof].every((x) => has(r.shown, x)) && !has(r.shown, shop) && /together/i.test(r.shown) && has(r.shown, merged);
    check(`A7 Henderson look-alikes listed with their own totals [${q}]`, ok, r.shown.replace(/\n/g, " / ").slice(0, 300));
    check(`A7 Henderson answer never presents the merged figure as the only one [${q}]`, !(r.kind === "answer" && has(r.shown, merged) && !has(r.shown, mark)), "");
  }
  // 2. exact full name: only that customer
  for (const q of ["what's still unpaid on the Mark Henderson invoices", "whats unpaid for mark henderson", "mark henderson unpaid invoces", "what does Mark Henderson still owe on invoices"]) {
    const r = await t.ask(q);
    check(`A7 exact name answers for that customer only [${q}]`, r.kind !== "answer" || (has(r.shown, mark) && !has(r.shown, paula) && !has(r.shown, roof) && !has(r.shown, merged) && !has(r.shown, shop)), r.shown.replace(/\n/g, " / ").slice(0, 300));
  }
  const rr = await t.ask("what's still unpaid on the Henderson Roofing LLC invoices");
  check("A7 exact business name answers for that business only", rr.kind !== "answer" || (has(rr.shown, roof) && !has(rr.shown, mark) && !has(rr.shown, paula)), rr.shown.slice(0, 300));
  // 3. a typo never drops the filter: the shop-wide figure must never come back for a question that named a customer
  for (const q of ["whats unpaid on the Ostrowski invoces", "what is unpaid for carla ostrowski invoces", "Ostrowski unpaid invocies", "what's still unpaid on the Zorblatt invoices", "unpaid Zorblatt invoces", "what is unpaid on the Zorblatt invoce"]) {
    const r = await t.ask(q);
    check(`A7 named subject never silently dropped [${q}]`, !(r.kind === "answer" && has(r.shown, shop)), r.shown.replace(/\n/g, " / ").slice(0, 300));
    if (/ostrowski/i.test(q)) check(`A7 Ostrowski is her own $750 [${q}]`, r.kind !== "answer" || has(r.shown, H.fmt(750)), r.shown.slice(0, 200));
  }
  // no subject at all keeps answering the shop-wide figure
  const whole = await t.ask("who owes us money"); check("A7 a question with no name still gets the shop-wide open money", whole.kind === "answer" && has(whole.shown, shop), whole.shown.slice(0, 200));
  // second organization: no Hendersons at all
  const d2 = JSON.parse(JSON.stringify(T.golden())); const t2 = await T.loadTenant(off, d2, { key: "r41u-e2a7b" });
  const o2 = await t2.ask("What's still unpaid on the Henderson invoices?"); check("A7 second organization never sees the first organization's Hendersons", !/Henderson|\$7,140|\$2,140/.test(o2.shown), o2.shown.slice(0, 200));
  const o1 = await t.ask("What's still unpaid on the Henderson invoices?"); check("A7 first organization unaffected", has(o1.shown, mark), "");
  // empty data
  const e = JSON.parse(JSON.stringify(T.golden())); for (const k of ["entities", "document_entity_links", "documents", "pages", "extractions", "financials", "financial_lines"]) e[k] = [];
  const t3 = await T.loadTenant(off, e, { key: "r41u-e2a7c" });
  const em = await t3.ask("What's still unpaid on the Henderson invoices?"); check("A7 empty organization never invents money", !/\$\d/.test(em.shown) || /\$0\.00/.test(em.shown), em.shown.slice(0, 200));

  // 4. year-less dates use the question's own today and the nearest sensible year; the year is stated
  const dq = async (today, q) => (await t.ask(q, today)).shown;
  check("A7 before december 24 on 2026-10-07 -> December 24, 2026", has(await dq("2026-10-07", "how many documents before december 24"), "December 24, 2026"), "");
  check("A7 before december 24 on 2026-01-05 -> December 24, 2025", has(await dq("2026-01-05", "how many documents before december 24"), "December 24, 2025"), "");
  check("A7 before december 24 on 2026-12-30 -> December 24, 2026", has(await dq("2026-12-30", "how many documents before december 24"), "December 24, 2026"), "");
  check("A7 after march 3 on 2026-10-07 -> March 3, 2026 (never a day that has not happened)", has(await dq("2026-10-07", "how many invoices after march 3"), "March 3, 2026"), "");
  check("A7 an explicit year is never changed", has(await dq("2026-10-07", "how many documents before december 24, 2025"), "December 24, 2025"), "");
  for (const q of ["how many documents before December 24", "HOW MANY DOCUMENTS BEFORE DECEMBER 24", "how many documents before dec 24", "how many documents were there before december 24?"]) check(`A7 same year every way [${q}]`, has(await dq("2026-10-07", q), "December 24, 2026"), (await dq("2026-10-07", q)).slice(0, 120));

  // 5. expiry windows from stored dates against today
  const today = "2026-09-25"; const addD = (iso, n) => { const x = new Date(`${iso}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const dU = T.golden(); const eq = dU.entities.filter((x) => x.entity_type === "equipment");
  const setExp = (en, exp) => { en.data.installation_date = `${Number(exp.slice(0, 4)) - 10}${exp.slice(4)}`; en.data.warranty = { ...(en.data.warranty ?? {}), installDate: en.data.installation_date, expires: exp, termYears: 10, expiresBasis: "computed" }; };
  setExp(eq[0], addD(today, 20)); setExp(eq[1], addD(today, 70)); setExp(eq[2], addD(today, 100)); setExp(eq[3], addD(today, -10));
  const truthU = (days) => dU.entities.filter((x) => x.entity_type === "equipment" && !x.merged_into && x.data.warranty?.expires && x.data.warranty.expires >= today && x.data.warranty.expires <= addD(today, days)).length;
  const missU = dU.entities.filter((x) => x.entity_type === "equipment" && !x.merged_into && !x.data.warranty?.expires).length;
  const tu = await T.loadTenant(off, dU, { key: "r41u-e2a7u" });
  for (const days of [30, 90, 120]) {
    for (const q of [`Which units expire in the next ${days} days?`, `which units expire in the next ${days} days`, `how many units expire in the next ${days} days`, `how many units have warranties expiring in the next ${days} days`, `which units have warranties expiring in the next ${days} days`]) {
      const r = await tu.ask(q); const n = truthU(days);
      const count = /^how many/i.test(q);
      const ok = count ? new RegExp(`(?<![\\d,.])${n}\\b`).test(r.text.split("Note:")[0]) : (r.facts.length === n || (n === 0 && /No pieces|0 /.test(r.text)));
      check(`A7 unit expiry window ${days}d truth ${n} [${q}]`, r.kind === "answer" && ok && (missU === 0 || /no warranty end date on file/.test(r.text)), r.text.slice(0, 220));
    }
  }
  // no unit has an end date -> clear decline, not a zero
  const dN = T.golden(); for (const en of dN.entities.filter((x) => x.entity_type === "equipment")) { if (en.data.warranty) en.data.warranty.expires = null; delete en.data.warranty_registered_date; }
  const tn = await T.loadTenant(off, dN, { key: "r41u-e2a7n" }); const nn = await tn.ask("Which units expire in the next 90 days?");
  check("A7 no end dates on file -> clear decline, never 'No pieces of equipment match'", /none of your units has a warranty end date/.test(nn.text), nn.text.slice(0, 200));
  // second org / empty orgs
  const tu2 = await T.loadTenant(off, T.golden(), { key: "r41u-e2a7u2" }); const u2 = await tu2.ask("how many units expire in the next 90 days"); const t2n = T.golden().entities.filter((x) => x.entity_type === "equipment" && x.data.warranty?.expires >= today && x.data.warranty.expires <= addD(today, 90)).length;
  check("A7 second organization gets its own expiry count", new RegExp(`(?<![\\d,.])${t2n}\\b`).test(u2.text.split("Note:")[0]), `${u2.text} truth ${t2n}`);

  // leases
  const dL = T.golden();
  H.addLeases(dL, [["Ann Lee", "1A", addD(today, 25)], ["Bo Chan", "2B", addD(today, 55)], ["Cy Diaz", "3C", addD(today, 200)], ["Di Eng", "4D", null], ["Ed Fox", "5E", addD(today, 5)], ["Fay Gu", "6F", addD(today, -30)]]);
  const tl = await T.loadTenant(off, dL, { key: "r41u-e2a7l" });
  const truthL = (days) => [25, 55, 200, 5, -30].filter((n) => n >= 0 && n <= days).length;
  for (const days of [7, 30, 60, 90]) {
    for (const q of [`which leases expire in ${days} days`, `Which leases expire in the next ${days} days?`, `how many leases expire in the next ${days} days`, `how many leases are expiring within ${days} days`, `which leases are ending in the next ${days} days`, `HOW MANY LEASES EXPIRE IN ${days} DAYS`]) {
      const r = await tl.ask(q); const n = truthL(days); const count = /^how many/i.test(q);
      const ok = n === 0 ? /No leases expire/.test(r.text) : count ? new RegExp(`^${n} lease`).test(r.text) : new RegExp(`^${n} lease`).test(r.text) && r.facts.length === n;
      check(`A7 lease expiry ${days}d truth ${n} [${q}]`, r.kind === "answer" ? ok && /no end date on file/.test(r.text) : n === 0 && /No leases expire/.test(r.text), r.text.slice(0, 200));
    }
  }
  const dLn = T.golden(); H.addLeases(dLn, [["Ann Lee", "1A", null], ["Bo Chan", "2B", null]]);
  const tln = await T.loadTenant(off, dLn, { key: "r41u-e2a7ln" }); const ln = await tln.ask("which leases expire in 60 days");
  check("A7 leases with no end dates -> clear decline", /none of your 2 leases has an end date/.test(ln.text), ln.text);
  const le = await tu2.ask("which leases expire in 60 days"); check("A7 no leases on file -> says so", /No leases on file/.test(le.text), le.text);
  // parser guard rails
  for (const [q, ok] of [["which leases expire in 60 days", true], ["how many leases expire in the next 2 months", true], ["which leases expired last month", false], ["which leases expire in 60 days for Ann Lee", false], ["what is the lease end date for unit 12C", false], ["which leases expire in march", false]]) check(`A7 parseExpiryWindow [${q}]`, Boolean(parseExpiryWindow(q)) === ok, JSON.stringify(parseExpiryWindow(q)));
  realLog(`A7: ${hQs.length} look-alike phrasings + expiry/lease/date matrices; Henderson truths ${mark} / ${paula} / ${roof}, merged ${merged}, shop ${shop}`);
}
