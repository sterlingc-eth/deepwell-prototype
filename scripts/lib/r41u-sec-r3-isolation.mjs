// R3: each organization's names only inside that organization, and a decline never repeats what the model said.
import { makeOrgs, WRONG } from "./r3-harness.mjs";
import { DENY } from "./r41u-sec-r3-denial.mjs";
export default async function ({ check, realLog, off }) {
  const h = await makeOrgs(off);
  const STUB = /zebediah|crane|3,407/i;
  const A = h.orgs.A.customers.filter((n) => n.split(/\s+/).length === 2).slice(0, 30), B = h.orgs.B.customers.filter((n) => n.split(/\s+/).length === 2).slice(0, 30);
  const toks = (names) => new Set(names.flatMap((n) => n.toLowerCase().split(/\s+/)));
  const tokA = toks(h.orgs.A.customers), tokB = toks(h.orgs.B.customers);
  const leaks = (shown, otherToks) => [...otherToks].filter((t) => t.length > 3 && new RegExp(`\\b${t}\\b`, "i").test(shown));
  const tpl = ["how much was {N} bill", "the invoice for {N}", "has {N} been invoiced", "look up {N}", "whats {N} balance", "{N} - how much"];
  let n = 0; const badDeny = [], badLeak = [];
  for (const [org, mine, other, otherTok] of [["A", A, B, tokB], ["B", B, A, tokA]]) {
    for (const nm of other) for (const t of tpl) {
      n++; const r = await h.ask(org, t.replace("{N}", nm));
      // the other organization's person is nobody here: a denial is correct (nothing shares a name token) and must not contain a clarifying list of anyone
      if (!DENY.test(r.shown) && !/nothing in your records|couldn't work that particular|can't answer that/i.test(r.shown) || /\$\s?\d/.test(r.shown)) badDeny.push(`[${org}] ${t.replace("{N}", nm)} -> ${r.text.slice(0, 120)}`);
      if (STUB.test(r.shown)) badLeak.push(`STUB [${org}] ${nm} -> ${r.text.slice(0, 100)}`);
    }
    for (const nm of mine.slice(0, 15)) for (const t of ["the invoice for mr " + nm.split(" ")[1], "look up " + nm.split(" ").reverse().join(", ")]) {
      n++; const r = await h.ask(org, t); const l = leaks(r.shown, otherTok);
      if (l.length) badLeak.push(`LEAK [${org}] ${t} -> ${l.join(",")} :: ${r.text.slice(0, 100)}`);
    }
  }
  check(`R3 isolation: ${n} cross-organization asks: a name from the other organization is denied (nothing shares a word) and never listed`, badDeny.length === 0 && badLeak.length === 0, [...badDeny.slice(0, 3), ...badLeak.slice(0, 3)].join(" || "));
  // a name the model invents is never repeated by a decline, in either organization
  let m = 0; const echoes = [];
  for (const org of ["A", "B"]) for (const q of ["what does Zebediah Crane owe", "Zebediah Crane - how much", "total for Crane", "how many widgets did the moon order last tuesday", "what is the airspeed of a laden swallow", "has Crane paid us", "look up Zebediah", "show me the Zebediah Crane invoice"]) {
    m++; const r = await h.ask(org, q); if (STUB.test(r.shown.replace(new RegExp(q.replace(/[^a-z ]/gi, ""), "ig"), "")) && !/zebediah|crane/i.test(q)) echoes.push(`${org} ${q} -> ${r.text.slice(0, 100)}`);
    if (/3,407/.test(r.shown)) echoes.push(`FIGURE ${org} ${q} -> ${r.text.slice(0, 100)}`);
  }
  check(`R3 a decline never repeats a model-supplied figure or name (${m} asks, both organizations)`, echoes.length === 0, echoes.slice(0, 4).join(" || "));
  h.restore();
}
