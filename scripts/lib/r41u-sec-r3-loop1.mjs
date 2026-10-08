// R3 hostile review loop 1 regressions (phrasings found by reviewers who did not write the code): every one names a real customer or vendor of the golden export.
import { makeOrgs } from "./r3-harness.mjs";
import { DENY } from "./r41u-sec-r3-denial.mjs";
export default async function ({ check, realLog, off }) {
  const h = await makeOrgs(off);
  const STUB = /zebediah|crane|3,407/i, SHOP = /572,212|120 invoices in total/;
  const GENERIC = /^nothing in your records answers that|couldn't work that particular question|that's not in your business records|documents may still be processing/i;
  const named = [
    ["Mercer, Thomas - statement", /Mercer/], ["Thomas Mercers job", /Mercer/], ["Ms Fitzgerald paid?", /Fitzgerald/], ["whats fitzgerald owe", /Fitzgerald/], ["Mr Garrison owe", /Garrison/], ["Salazars account", /Salazar/],
    ["Whats the story with Fitzgerald", /Fitzgerald/], ["Whitfield balance", /Whitfield/], ["MR MERCER BALANCE", /Mercer/], ["Hutchins balance", /Hutchins/], ["Winslow balance", /Winslow/], ["Garrisons balance", /Garrison/],
    ["biggest invoice for Joseph Ortega", /Ortega/], ["smallest invoice for Linda Fitzgerald", /Fitzgerald/], ["largest invoice for Karen Bracken", /Bracken/], ["Karen Bracken revenue", /Bracken/], ["Copper Sky Dental total billed", /Copper Sky/],
    ["Cactus Rose Restaurant revenue", /Cactus Rose/], ["copper sky dental past due", /Copper Sky/], ["sonoran grill past due", /Sonoran/], ["Mrs. Mercers invoice", /Mercer/], ["Dr. Ellison invoice", /Ellison/],
    ["Baker Distributing bill", /Baker Distributing/], ["how much do we owe Baker Distributing", /Baker Distributing/], ["Watsco Supply bill", /Watsco Supply/], ["Watsco owe", /Watsco/], ["latest bill from Watsco Supply", /Watsco Supply/],
    ["Donna Winslow total billed", /3,380/], ["Linda Fitzgerald account", /Fitzgerald/], ["Linda Fitzgerald unpaid", /Fitzgerald/],
  ];
  let bad = [];
  for (const [q, must] of named) {
    const r = await h.ask("A", q);
    if (DENY.test(r.shown) || STUB.test(r.shown) || SHOP.test(r.shown) || GENERIC.test(r.text) || !must.test(r.shown) || /Did you mean Baker Distributing|Did you mean Watsco Supply/.test(r.shown)) bad.push(`[${q}] -> ${r.text.slice(0, 140)}`);
  }
  check(`R3 loop-1 regressions: ${named.length} reviewer phrasings answer about the named customer/vendor (no denial, no shop-wide figure, no generic dead end)`, bad.length === 0, bad.slice(0, 5).join(" || "));
  // loop 2: bare surnames, surname + condition, two names, wrong-person fuzzy answers
  const l2 = [["Mercer", /Thomas Mercer.*Laura Mercer|Laura Mercer.*Thomas Mercer/s], ["what about Jarvis", /Paul Jarvis/], ["Salazar over $4000", /Salazar/], ["Mercer under 500", /Mercer/], ["compare Karen Abernathy and Kevin Abernathy", /4,170[\s\S]*6,779/],
    ["Thomas Mercer between 2016 and 2020", /did not apply/], ["Bracken Ronald total owed", /Bracken/], ["Daniel Keller payable", /Keller/]];
  const bad2 = [];
  for (const [q, must] of l2) { const r = await h.ask("A", q); if (DENY.test(r.shown) || STUB.test(r.shown) || GENERIC.test(r.text) || !must.test(r.shown)) bad2.push(`[${q}] -> ${r.text.slice(0, 120)}`); }
  const rr = await h.ask("A", "Bracken Ronald total owed"); if (/Calloway|Dominguez|Fenwick/.test(rr.shown)) bad2.push(`[Bracken Ronald total owed] lists other Ronalds`);
  for (const q of ["Latest invoice for Carlos Rios", "Latest invoice for Holy Cross Church"]) { const r = await h.ask("A", q); if (!/Did you mean/.test(r.text) || /most recent invoice/.test(r.text)) bad2.push(`[${q}] answered a look-alike: ${r.text.slice(0, 100)}`); }
  const ai = await h.ask("A", "Amy Isaacson, Paul Jarvis"); if (/Amy Jarvis/.test(ai.shown) || !/Isaacson/.test(ai.shown) || !/Paul Jarvis/.test(ai.shown)) bad2.push(`[Amy Isaacson, Paul Jarvis] ${ai.text.slice(0, 120)}`);
  check(`R3 loop-2 regressions (${l2.length + 4} shapes): no denial, no dropped name or condition, no look-alike answered as the person asked for`, bad2.length === 0, bad2.slice(0, 5).join(" || "));
  const r = await h.ask("A", "phone number for Jessica Sandoval");
  check("R3 an invented first name with a real surname: clarifying list, not a confident answer", /couldn.t (find|match)/i.test(r.text) && /Sandoval/.test(r.text) && !STUB.test(r.shown), r.text.slice(0, 200));
  h.restore();
}
