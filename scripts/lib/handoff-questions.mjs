// Synthetic question generator for the handoff QA: every question is built from a synthetic tenant's own rows, so the gold answer is known.
// gold: { has: true, needles: [strings that must appear in a right answer] } | { has: false } (the fact is truly not in the records)
import { mulberry } from "./handoff-rng.mjs";

const CHAT = ["", "", "", "quick one: ", "hey, ", "can you check - ", "client is waiting, ", "for the file: ", "uh ", "pls ", "reviewing the folder, ", "need this asap: ", "Hi Donovan, ", "tenant is asking, ", "before I sign off, "];
const TAIL = ["", "", "", " please", " asap", " thanks", " quick", "?", "??", " pls"];
const typo = (s, r) => { const w = s.split(" "); const i = Math.floor(r() * w.length); const x = w[i]; if (x.length > 4) { const k = 1 + Math.floor(r() * (x.length - 3)); w[i] = x.slice(0, k) + x[k + 1] + x[k] + x.slice(k + 2); } return w.join(" "); };
const money = (v) => String(Math.round(Number(v) * 100) / 100);

export function buildGold(d) {
  const ent = new Map(d.entities.map((e) => [e.id, e]));
  const fin = new Map(d.financials.map((f) => [f.document_id, f]));
  const ex = new Map();
  for (const x of d.extractions) { if (!ex.has(x.document_id)) ex.set(x.document_id, {}); ex.get(x.document_id)[x.field_key] = x.value; }
  const link = new Map(); for (const l of d.document_entity_links) if (!link.has(l.document_id)) link.set(l.document_id, l.entity_id);
  const docs = [];
  for (const doc of d.documents) {
    const f = fin.get(doc.id); const e = ex.get(doc.id) ?? {};
    const ref = e.doc_ref ?? f?.invoice_number ?? null; if (!ref) continue;
    const cust = ent.get(link.get(doc.id))?.data?.customer_name ?? f?.customer_name ?? null;
    docs.push({ id: doc.id, type: doc.document_type, ref, total: f?.total != null ? money(f.total) : null, date: e.transaction_date ?? f?.invoice_date ?? null, customer: cust });
  }
  const customers = d.entities.filter((e) => e.entity_type === "customer" && !e.merged_into && e.data?.customer_name).map((e) => ({ name: e.data.customer_name, phone: e.data.phone, email: e.data.email, address: e.data.service_address }));
  const nameCount = new Map(); for (const c of customers) nameCount.set(c.name, (nameCount.get(c.name) ?? 0) + 1);
  const refCount = new Map(); for (const x of docs) refCount.set(x.ref, (refCount.get(x.ref) ?? 0) + 1);
  return { docs: docs.filter((x) => refCount.get(x.ref) === 1), customers: customers.filter((c) => nameCount.get(c.name) === 1), allRefs: new Set(docs.map((x) => x.ref)), allNames: new Set(customers.map((c) => c.name.toLowerCase())) };
}
const digits = (s) => String(s).replace(/[^0-9.]/g, "");
const dateForms = (iso) => { const [y, m, dd] = iso.split("-"); const mon = ["January","February","March","April","May","June","July","August","September","October","November","December"][+m - 1]; return [`${mon} ${+dd}, ${y}`, `${m}/${dd}/${y}`, iso, `${mon.slice(0,3)} ${+dd}, ${y}`, `${mon.slice(0,3)}. ${+dd}, ${y}`]; };

export function generate(d, { seed = 1, nAnswerable = 220, nAbsent = 70, nMulti = 40, nVague = 40 } = {}) {
  const r = mulberry(seed); const pick = (a) => a[Math.floor(r() * a.length)];
  const G = buildGold(d); const out = [];
  const wrap = (q) => { let s = pick(CHAT) + q + pick(TAIL); if (r() < 0.25) s = s.toLowerCase(); if (r() < 0.2) s = typo(s, r); return s.trim(); };
  const tnice = (t) => t.replace(/-/g, " ");
  const one = (x) => {
    const kinds = [];
    if (x.total) kinds.push(["total", `total on ${x.ref}`, `how much is ${x.ref}`, `what's the amount on ${x.ref}`, `price on ${x.ref}`, `${x.ref} comes to what`, `dollar total of the ${tnice(x.type)} ${x.ref}`]);
    if (x.date) kinds.push(["date", `what date is ${x.ref}`, `when was ${x.ref} dated`, `date on the ${tnice(x.type)} ${x.ref}`, `${x.ref} - what's the date`]);
    if (x.customer) kinds.push(["customer", `who is the customer on ${x.ref}`, `whose ${tnice(x.type)} is ${x.ref}`, `${x.ref} belongs to who`, `client for ${x.ref}`]);
    if (!kinds.length) return null;
    const k = pick(kinds); const q = pick(k.slice(1)); const need = k[0] === "total" ? [x.total.replace(/\.0+$/, "")] : k[0] === "customer" ? [x.customer.toLowerCase()] : [];
    return { cat: k[0], q, x, need, dates: k[0] === "date" ? dateForms(x.date) : null };
  };
  const mkNeedles = (g) => ({ has: true, needles: g.need, anyOf: g.dates });
  for (let i = 0; i < nAnswerable; i++) {
    const roll = r();
    if (roll < 0.5 && G.docs.length) { const g = one(pick(G.docs)); if (g) out.push({ cat: `doc-${g.cat}`, q: wrap(g.q), gold: mkNeedles(g) }); }
    else if (G.customers.length) {
      const c = pick(G.customers); const f = pick([["phone", c.phone, `phone number for ${c.name}`, `${c.name} phone?`, `what's ${c.name}'s phone`], ["email", c.email, `email address for ${c.name}`, `${c.name} email`], ["address", c.address, `address for ${c.name}`, `where does ${c.name} live`, `${c.name} service address`]]);
      if (f[1]) out.push({ cat: `cust-${f[0]}`, q: wrap(pick(f.slice(2))), gold: { has: true, needles: [digits(f[1]) && f[0] === "phone" ? digits(f[1]).slice(-4) : String(f[1]).toLowerCase().split(",")[0]] } });
    }
  }
  for (let i = 0; i < nVague && G.docs.length; i++) { const x = pick(G.docs); const q = pick([`${x.ref}?`, `tell me about ${x.ref}`, `${x.ref}`, `what do we have on ${x.ref}`, `look up ${x.ref}`, `${tnice(x.type)} ${x.ref} info`]); out.push({ cat: "vague", q: wrap(q), gold: { has: true, needles: [x.ref.toLowerCase()] } }); }
  for (let i = 0; i < nMulti && G.docs.length > 1; i++) {
    const a = one(pick(G.docs)); const b = one(pick(G.docs)); if (!a || !b || a.x.ref === b.x.ref) continue;
    out.push({ cat: "multi", q: wrap(`${a.q} and also ${b.q}`), gold: { has: true, needles: [...a.need], anyOf: a.dates, second: { needles: b.need, anyOf: b.dates } } });
  }
  for (let i = 0; i < nAbsent; i++) {
    const roll = r();
    if (roll < 0.4) { const ref = `${pick(["ZX", "QQ", "WV"])}-${9000 + Math.floor(r() * 999)}`; if (!G.allRefs.has(ref)) out.push({ cat: "absent-doc", q: wrap(pick([`total on ${ref}`, `who is the customer on ${ref}`, `what date is ${ref}`])), gold: { has: false } }); }
    else if (roll < 0.7) { const nm = `${pick(["Zelda", "Quentin", "Ximena", "Oberon"])} ${pick(["Vandersloot", "Pemberton", "Quillfeather", "Ashgrove"])}`; out.push({ cat: "absent-customer", q: wrap(pick([`phone number for ${nm}`, `${nm} email`, `address for ${nm}`])), gold: { has: false } }); }
    else if (G.customers.length) { const c = pick(G.customers); out.push({ cat: "absent-field", q: wrap(pick([`what is ${c.name}'s favorite color`, `${c.name} shoe size`, `${c.name} blood type`])), gold: { has: false } }); }
  }
  return out;
}
export function judge(gold, text) {
  if (!gold.has) return null;
  const t = String(text).toLowerCase().replace(/,/g, "");
  const okNeed = (n) => n.every((x) => t.includes(String(x).toLowerCase().replace(/,/g, "")));
  const okAny = (a) => !a || a.some((x) => t.includes(x.toLowerCase()));
  return okNeed(gold.needles) && okAny(gold.anyOf) && (!gold.second || (okNeed(gold.second.needles) && okAny(gold.second.anyOf)));
}
