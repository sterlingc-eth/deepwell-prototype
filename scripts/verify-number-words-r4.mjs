// DONOVAN-R4: a bare "number" is a phone request only when it is not the number OF something else; found by hostile review, kept as a regression test (general rule, many nouns).
import assert from "node:assert/strict";
import { parseContactLookupQuestion as parse } from "../api/_lib/contactLookup.js";
import { matchNamedCustomers } from "../api/_lib/retrieval/subject.js";
const phone = (q) => { const r = parse(q); return r && (r.field === "phone" || r.concept === "phone" || r.concept === "who+phone"); };
const OTHER = ["receipt","statement","chart","matter","policy","confirmation","check","po box","suite","gate code","vin","parcel","fax","pager","tax","license","badge","employee","invoice","permit","ticket","quote","case","lot","tracking","engagement letter","mrn","folio","claim","reference","routing","member","serial","docket","registration","loan","lease","unit"];
for (const w of OTHER) for (const q of [`${w} number for Donna Thornton`, `Donna Thornton ${w} number`, `what is the ${w} number for Dale Whitcomb`]) assert.ok(!phone(q), `must not be a phone request: ${q}`);
for (const q of ["best number for Donna Thornton", "what's Donna Thornton's number", "number for Donna Thornton", "do we have a callback number for Stephanie Nakamura", "phone number for Donna Thornton", "wats the fone # for amy isacson", "Donna Thornton number"]) assert.ok(phone(q), `must be a phone request: ${q}`);
const C = (name, id) => ({ id, name });
const cs = [C("Linda Fitzgerald", 1), C("Sorensen Roofing", 2), C("Acme Holdings", 3), C("Acme Holdings West", 4)];
const names = (q) => matchNamedCustomers(q, cs).map((c) => c.name).sort().join("|");
assert.equal(names("Linda Fitzgerald vs Sorensen Roofing totals"), "Linda Fitzgerald|Sorensen Roofing", "two separate customers are both kept");
assert.equal(names("balance for Acme Holdings West"), "Acme Holdings West", "the longer name wins over the name it contains");
console.log("ok   number-word and subject-resolution regressions");
