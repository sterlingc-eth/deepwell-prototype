#!/usr/bin/env node
/** R45 blind set: technician paraphrases (customers visited / jobs this year / last job / total jobs) + controls.
 *  Truth is computed from the golden export itself. Usage: node scripts/verify-r3-techparaphrase.mjs */
process.env.TZ = "America/Phoenix"; process.env.OFFLINE_EXAM = "1";
import fs from "node:fs";
import { boot, GOLDEN } from "./hunt-r45.mjs";

const g = JSON.parse(fs.readFileSync(GOLDEN, "utf8"));
const today = "2026-09-25";
const custIds = new Set(g.entities.filter((e) => e.entity_type === "customer" && !e.merged_into).map((e) => e.id));
const svc = new Map(); g.extractions.filter((x) => x.field_key === "service_date").forEach((x) => svc.set(x.document_id, String(x.value).slice(0, 10)));
const techs = [...new Set(g.extractions.filter((x) => x.field_key === "technician").map((x) => x.value))];
const T = {};
for (const t of techs) {
  const docs = [...new Set(g.extractions.filter((x) => x.field_key === "technician" && x.value === t && svc.get(x.document_id)).map((x) => x.document_id))];
  const set = new Set(docs);
  const cust = new Set(g.document_entity_links.filter((l) => set.has(l.document_id) && custIds.has(l.entity_id)).map((l) => l.entity_id));
  const dates = docs.map((d) => svc.get(d)).sort();
  T[t] = { jobs: docs.length, cust: cust.size, ytd: docs.filter((d) => svc.get(d).startsWith("2026")).length, last: dates.filter((d) => d <= today).pop() };
}
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const human = (iso) => `${MONTHS[+iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)}, ${iso.slice(0, 4)}`;
const cases = [];
const C = (q, mustHave, extra = {}) => cases.push({ q, mustHave, ...extra });
for (const t of techs) {
  const [f, l] = t.split(" "), x = T[t];
  const nm = [t, t.toLowerCase(), l, l.toLowerCase()];
  C(`which customers did ${t} visit`, String(x.cust));
  C(`which customers did ${nm[1]} service`, String(x.cust));
  C(`how many customers has ${nm[0]} worked for`, String(x.cust));
  C(`how many customers did ${l} visit`, String(x.cust));
  C(`${l} jobs this year`, String(x.ytd));
  C(`how many jobs has ${t} done this year`, String(x.ytd));
  C(`how many jobs did ${nm[1]} do this year`, String(x.ytd));
  C(`${nm[1]}'s last job`, x.last ? human(x.last) : "");
  C(`when did ${t} last work`, x.last ? human(x.last) : "");
  C(`what was ${t}'s latest ticket`, x.last ? human(x.last) : "");
}
// controls: unknown names / customers named like people / non-tech must NOT produce a technician answer
C("which customers did Zed Nonexistent visit", null, { mustNot: /different customers|worked for \d/i });
C("which customers did Linda Fitzgerald visit", null, { mustNot: /worked for \d+ different/i });
C("Nobody Here jobs this year", null, { mustNot: /ran \d+ job/i });
C("Fitzgerald jobs this year", null, { mustNot: /ran \d+ job/i });
C("how many jobs did Zed Nonexistent do this year", null, { mustNot: /ran \d+ job/i });
C("Zed Nonexistent's last job", null, { mustNot: /most recent job was/i });
// regression guards on already-working phrasings
C(`how many jobs did Danny run`, "57");

const { ask } = await boot();
let pass = 0; const fails = [];
for (const c of cases) {
  const r = await ask(c.q);
  const a = r.answer;
  let ok = !r.needsModel && !/processing failed/i.test(a) || (c.mustHave === null);
  if (c.mustHave) ok = ok && a.includes(c.mustHave);
  if (c.mustNot) ok = ok && !c.mustNot.test(a);
  if (c.mustHave === null && !c.mustNot) ok = true;
  if (ok) pass++; else fails.push(`${c.q} -> ${a.slice(0, 90)} [want ${c.mustHave}]`);
}
console.log(`verify-r3-techparaphrase: ${pass}/${cases.length} passed`);
for (const f of fails) console.log("FAIL", f);
process.exit(fails.length ? 1 : 0);
