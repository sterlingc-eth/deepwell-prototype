/**
 * Summary lane - PURE answer builders. Every sentence below is a template over stored facts: a count, a date, a stored total, a stored
 * contact field. No adjectives, no judgement ("healthy", "doing well"), no estimate. Customer-visible wording lives ONLY in this file so it
 * can be listed for approval in one place (see scripts/verify-summary.mjs, which prints every template).
 */
import { documentTypeLabel } from "../documentTypes.js";
import { humanDate } from "../scope.js";
import { documentRecord, customerRecord, unitRecord } from "../citations/records.js";

export const usd = (n) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The document type's own name as the app shows it ("Work order" -> "work order"), singular or plural. */
const NOUNS = {
  "proposal-quote": ["proposal / quote", "proposals / quotes"],
  agreement: ["agreement / contract", "agreements / contracts"],
  "delivery-ticket": ["delivery / pickup ticket", "delivery / pickup tickets"],
  "hr-letter": ["HR / employment letter", "HR / employment letters"],
  correspondence: ["correspondence item", "correspondence items"],
  internal: ["company record", "company records"],
  other: ["other document", "other documents"],
};
export function typeNoun(typeId, n = 2) {
  const fixed = NOUNS[typeId];
  if (fixed) return n === 1 ? fixed[0] : fixed[1];
  const sing = String(documentTypeLabel(typeId) ?? typeId).toLowerCase();
  return n === 1 ? sing : `${sing}s`;
}
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const noun = (n, sing, plur) => `${n} ${n === 1 ? sing : plur}`;
const list = (parts) => parts.join(", ");

function periodPhrase(period) {
  if (!period) return "";
  const l = String(period.label ?? "").trim();
  if (/^(?:in|during|for|from|since|between|last|this|past|previous|prior|next|yesterday|today)\b/i.test(l)) return l;
  return `in ${l}`;
}

function countsByType(docs) {
  const m = new Map();
  for (const d of docs) m.set(d.type, (m.get(d.type) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function dateSpan(docs) {
  const ds = docs.map((d) => d.date).filter(Boolean).sort();
  return ds.length ? { first: ds[0], last: ds[ds.length - 1], dated: ds.length } : null;
}

/** Documents dated after today are on file but are not "the newest": they are counted and named, never part of the span. */
const isFuture = (d, today) => Boolean(today && d.date && d.date > today);
function futureSentence(docs, today) {
  const fut = docs.filter((d) => isFuture(d, today));
  if (!fut.length) return null;
  const dates = [...new Set(fut.map((d) => d.date))].sort().slice(0, 3).map(humanDate);
  return `${fut.length} ${fut.length === 1 ? "document is" : "documents are"} dated after today (${list(dates)}).`;
}

/** Stored totals, by document type: only types where at least one document has a stored USD total. */
function totalsByType(docs) {
  const m = new Map();
  for (const d of docs) {
    const e = m.get(d.type) ?? { n: 0, k: 0, sum: 0 };
    e.n++;
    if (d.total != null) { e.k++; e.sum += d.total; }
    m.set(d.type, e);
  }
  return [...m.entries()].filter(([, e]) => e.k > 0).sort((a, b) => b[1].sum - a[1].sum || a[0].localeCompare(b[0]))
    .map(([type, e]) => ({ type, n: e.n, k: e.k, sum: Math.round(e.sum * 100) / 100 }));
}

function tally(docs, key) {
  const m = new Map();
  for (const d of docs) if (d[key]) m.set(d[key], (m.get(d[key]) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

function docLabel(d) {
  if (d.displayName) return d.displayName;
  if (d.number) return `${capital(typeNoun(d.type, 1))} ${d.number}`;
  if (d.date) return `${capital(typeNoun(d.type, 1))} dated ${humanDate(d.date)}`;
  return d.filename || capital(typeNoun(d.type, 1));
}

function sentenceBits(docs, today, { skipTotalsFor = null } = {}) {
  const out = { sentences: [], facts: [] };
  const span = dateSpan(docs.filter((d) => !isFuture(d, today)));
  if (span) {
    const t = span.first === span.last ? `Dated ${humanDate(span.first)}.` : `Dated ${humanDate(span.first)} to ${humanDate(span.last)}.`;
    out.sentences.push(t);
    out.facts.push({ label: "Date range", value: span.first === span.last ? humanDate(span.first) : `${humanDate(span.first)} to ${humanDate(span.last)}` });
  }
  const fut = futureSentence(docs, today);
  if (fut) out.sentences.push(fut);
  for (const t of totalsByType(docs)) {
    if (skipTotalsFor === t.type) continue;
    const base = `${capital(typeNoun(t.type, 2))} on file total ${usd(t.sum)}`;
    out.sentences.push(t.k === t.n ? `${base}.` : `${base} (${t.k} of ${t.n} have a stored total).`);
    out.facts.push({ label: `${capital(typeNoun(t.type, 2))} total`, value: usd(t.sum) });
  }
  return out;
}

function documentRecords(docs, group) {
  return docs
    .slice()
    .sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")))
    .map((d) =>
      documentRecord(
        { id: d.id, document_type: d.type },
        { label: docLabel(d), sublabel: [capital(typeNoun(d.type, 1)), d.date ? humanDate(d.date) : null, d.total != null ? usd(d.total) : null, d.tech, d.status].filter(Boolean).join(" · "), group }
      )
    )
    .filter(Boolean);
}

function envelope(text, facts) {
  const full = facts.map((f) => ({ sources: [], ...f }));
  const sources = [...new Map(full.flatMap((f) => f.sources ?? []).map((x) => [x.documentId, x])).values()];
  return { kind: "answer", text, facts: full, sources, confidence: 1, verifiedCount: full.filter((f) => f.sources.length).length, unverifiedCount: 0, closest: [] };
}

function newestOldest(docs, today) {
  const dated = docs.filter((d) => d.date && !isFuture(d, today)).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  if (dated.length < 2) return [];
  const o = dated[0], n = dated[dated.length - 1];
  const at = (d) => (d.displayName || d.number ? `${docLabel(d)}, ${humanDate(d.date)}` : docLabel(d));
  return [`Newest: ${at(n)}.`, `Oldest: ${at(o)}.`];
}

function statusSentence(docs) {
  const t = tally(docs, "status");
  if (!t.length) return null;
  const none = docs.length - t.reduce((a, [, k]) => a + k, 0);
  return `Status on file: ${list(t.map(([s, k]) => `${k} ${String(s).toLowerCase()}`))}.${none > 0 ? ` ${none} ${none === 1 ? "has" : "have"} no status.` : ""}`;
}

/* ------------------------------------------------------------------------------------------------ builders */

/** One customer: contact details, documents by type, date span, stored totals, equipment. */
export function buildCustomerSummary({ customer, docs, equipment, today, fileLines = [], fileFacts = [] }) {
  const name = customer.customer_name || "This customer";
  const facts = [];
  const sentences = [];
  let lead;
  if (!docs.length) lead = `${name} has no documents on file.`;
  else lead = `${name} has ${noun(docs.length, "document", "documents")} on file: ${list(countsByType(docs).map(([t, k]) => `${k} ${typeNoun(t, k)}`))}.`;
  sentences.push(lead);
  if (docs.length) facts.push({ label: "Documents", value: String(docs.length) });
  const bits = sentenceBits(docs, today);
  sentences.push(...bits.sentences); facts.push(...bits.facts);
  if (equipment.length) {
    const brands = tally(equipment.map((e) => ({ b: e.manufacturer })), "b");
    sentences.push(`Equipment on file: ${noun(equipment.length, "unit", "units")}${brands.length ? ` (${list(brands.map(([b, k]) => `${k} ${b}`))})` : ""}.`);
    facts.push({ label: "Equipment", value: String(equipment.length) });
  }
  // the customer file reader's own lines: last service visit (never a future one), warranty status, maintenance agreement, open reminders
  sentences.push(...fileLines);
  facts.push(...fileFacts);
  const contact = [];
  if (customer.phone) { contact.push(`Phone ${customer.phone}`); facts.push({ label: "Phone", value: customer.phone }); }
  if (customer.email) { contact.push(`email ${customer.email}`); facts.push({ label: "Email", value: customer.email }); }
  if (customer.service_address) { contact.push(`address ${customer.service_address}`); facts.push({ label: "Address", value: customer.service_address }); }
  sentences.push(contact.length ? `${capital(contact.join(", "))}.` : "No phone, email or address is on file.");
  const answer = envelope(sentences.join(" "), facts.map((f) => ({ ...f, entityId: customer.id })));
  const records = [...documentRecords(docs), ...(docs.length ? [] : [customerRecord(customer)])];
  return { answer, records, total: records.length, basis: `Read from ${name}'s customer record and the ${noun(docs.length, "document", "documents")} linked to them; totals are the stored document totals.` };
}

/** One document type (optionally within one period). */
export function buildDocTypeSummary({ typeId, period, docs, today }) {
  const when = periodPhrase(period);
  const plural = typeNoun(typeId, 2);
  if (!docs.length) {
    const a = envelope(`No ${plural} are on file${when ? ` ${when}` : ""}.`, []);
    return { answer: a, records: [], total: 0, basis: `Counted the ${plural} on file${when ? ` ${when}` : ""}.` };
  }
  const lead = `${noun(docs.length, typeNoun(typeId, 1), plural)} on file${when ? `, dated ${when}` : ""}.`;
  const facts = [{ label: capital(plural), value: String(docs.length) }];
  const bits = sentenceBits(docs, today);
  const sentences = [lead, ...(when ? bits.sentences.filter((s) => !s.startsWith("Dated ")) : bits.sentences)];
  facts.push(...(when ? bits.facts.filter((f) => f.label !== "Date range") : bits.facts));
  const st = statusSentence(docs);
  if (st) sentences.push(st);
  const techs = tally(docs, "tech").slice(0, 3);
  if (techs.length) { sentences.push(`Technicians on these: ${list(techs.map(([t, k]) => `${t} (${k})`))}.`); }
  sentences.push(...newestOldest(docs, today));
  return { answer: envelope(sentences.join(" "), facts), records: documentRecords(docs), total: docs.length, basis: `Counted the ${plural} on file${when ? ` ${when}` : ""}; totals are the stored document totals.` };
}

/** Every document, optionally within one period. */
export function buildAllDocsSummary({ period, docs, today }) {
  const when = periodPhrase(period);
  if (!docs.length) return { answer: envelope(`No documents are on file${when ? ` ${when}` : ""}.`, []), records: [], total: 0, basis: "Counted the documents on file." };
  const sentences = [`${noun(docs.length, "document", "documents")} on file${when ? `, dated ${when}` : ""}: ${list(countsByType(docs).map(([t, k]) => `${k} ${typeNoun(t, k)}`))}.`];
  const bits = sentenceBits(docs, today);
  sentences.push(...(when ? bits.sentences.filter((s) => !s.startsWith("Dated ")) : bits.sentences));
  const facts = [{ label: "Documents", value: String(docs.length) }, ...(when ? bits.facts.filter((f) => f.label !== "Date range") : bits.facts)];
  return { answer: envelope(sentences.join(" "), facts), records: documentRecords(docs), total: docs.length, basis: `Counted the documents on file${when ? ` ${when}` : ""}; totals are the stored document totals.` };
}

/** One technician (by the technician stored on documents). */
export function buildTechnicianSummary({ name, docs, personVerb, today }) {
  const sentences = [];
  if (personVerb) sentences.push("Your records do not rate performance, so here is the work on file.");
  if (!docs.length) return { answer: envelope(`${name} is not named as technician on any document on file.`, []), records: [], total: 0, basis: `Counted the documents that name ${name} as technician.` };
  sentences.push(`${name} is the technician on ${noun(docs.length, "document", "documents")} on file: ${list(countsByType(docs).map(([t, k]) => `${k} ${typeNoun(t, k)}`))}.`);
  const bits = sentenceBits(docs, today);
  sentences.push(...bits.sentences);
  const st = statusSentence(docs);
  if (st) sentences.push(st);
  const facts = [{ label: "Documents as technician", value: String(docs.length) }, ...bits.facts];
  return { answer: envelope(sentences.join(" "), facts), records: documentRecords(docs), total: docs.length, basis: `Counted the documents that name ${name} as technician.` };
}

/** One equipment brand. */
export function buildBrandSummary({ brand, units }) {
  const customers = new Set(units.map((u) => u.customer_id).filter(Boolean)).size;
  const sentences = [`${noun(units.length, `${brand} unit`, `${brand} units`)} on file${customers ? `, at ${noun(customers, "customer", "customers")}` : ""}.`];
  const installed = units.map((u) => String(u.installed ?? "").slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (installed.length) sentences.push(installed[0] === installed[installed.length - 1] ? `Installed ${humanDate(installed[0])}.` : `Installed ${humanDate(installed[0])} to ${humanDate(installed[installed.length - 1])}.`);
  const sizes = tally(units.map((u) => ({ s: u.tonnage })), "s");
  if (sizes.length) sentences.push(`Sizes: ${list(sizes.map(([s, k]) => `${s} (${k})`))}.`);
  const facts = [{ label: `${brand} units`, value: String(units.length) }];
  if (customers) facts.push({ label: "Customers with them", value: String(customers) });
  const records = units.map((u) => unitRecord({ id: u.id, manufacturer: u.manufacturer, equipment_type: u.equipment_type, model: u.model, serial_number: u.serial_number, customer_id: u.customer_id }, { sublabel: [u.model, u.serial_number ? `serial ${u.serial_number}` : null, u.tonnage, u.installed ? `installed ${String(u.installed).slice(0, 10)}` : null].filter(Boolean).join(" · ") })).filter(Boolean);
  return { answer: envelope(sentences.join(" "), facts), records, total: units.length, basis: `Counted the ${brand} equipment on file.` };
}

/** The whole customer base. */
export function buildCustomerBaseSummary({ customers, unitCount }) {
  const n = customers.length;
  const have = (k) => customers.filter((c) => c[k]).length;
  const sentences = [`${noun(n, "customer", "customers")} on file.`];
  const parts = [["phone", have("phone"), "a phone number"], ["email", have("email"), "an email address"], ["address", have("service_address"), "a service address"]];
  sentences.push(`${parts[0][1]} of them have ${parts[0][2]}, ${parts[1][1]} have ${parts[1][2]}, and ${parts[2][1]} have ${parts[2][2]}.`);
  if (unitCount) sentences.push(`${noun(unitCount, "piece of equipment", "pieces of equipment")} on file.`);
  const facts = [{ label: "Customers", value: String(n) }, { label: "With a phone number", value: String(parts[0][1]) }, { label: "With an email address", value: String(parts[1][1]) }, { label: "With a service address", value: String(parts[2][1]) }];
  if (unitCount) facts.push({ label: "Equipment", value: String(unitCount) });
  const records = customers.map((c) => customerRecord(c)).filter(Boolean);
  return { answer: envelope(sentences.join(" "), facts), records, total: n, basis: "Counted the customers on file." };
}

/** Every template, for the approval list (the verify script prints this). */
export const TEMPLATES = [
  "{Name} has {n} documents on file: {k} {type}, ... .",
  "{Name} has no documents on file.",
  "Dated {first date} to {last date}.   |   Dated {date}.",
  "{Types} on file total {$}.   |   {Types} on file total {$} ({k} of {n} have a stored total).",
  "Equipment on file: {n} units ({k} {brand}, ...).",
  "Phone {phone}, email {email}, address {address}.   |   No phone, email or address is on file.",
  "{n} {types} on file[, dated in {period}].",
  "No {types} are on file[ in {period}].",
  "Status on file: {k} {status}, ... . {k} have no status.",
  "{Name} is also the technician on {n} documents.   |   {Name} is also a customer, with {n} documents on file.",
  "I found more than one match for \"{name}\": {Name} ({city or customer number}), ... . Which one did you mean?",
  "Technicians on these: {name} ({k}), ... .",
  "Newest: {label}, {date}.   Oldest: {label}, {date}.",
  "{k} document is dated after today ({dates}).   |   {k} documents are dated after today ({dates}).",
  "(customers) the customer file lines already shown by the customer file view: Last service visit: {date} ({what}); {k} visits on file.   Warranty: {k} active, ... .   Maintenance agreement on file ({term}).   {k} open reminders: ... .   No service visits on file.",
  "{n} documents on file[, dated in {period}]: {k} {type}, ... .   |   No documents are on file[ in {period}].",
  "Your records do not rate performance, so here is the work on file.",
  "{Name} is the technician on {n} documents on file: {k} {type}, ... .",
  "{Name} is not named as technician on any document on file.",
  "{n} {Brand} units on file, at {c} customers.   Installed {date} to {date}.   Sizes: {size} ({k}), ... .",
  "{n} customers on file.   {k} of them have a phone number, {k} have an email address, and {k} have a service address.",
  "{n} pieces of equipment on file.",
];
