/**
 * RECORDS-FIRST look-up lane. ONE lane driven by directory.js:
 *   <fact(s)> for <customer | invoice / document number | unit serial | address>  [in <time window>]
 * is answered from the stored rows of THIS organization, each value with its source page. No model call. The order of preference for an answer:
 *   1. a stored fact that fits       -> the value, the document it came from, the page
 *   2. a fact that is NOT stored     -> exactly that ("not stored"), plus what IS stored about the same thing; never a different fact in its place
 *   3. nothing this lane can read    -> null (the caller carries on: older lanes, then the grounded model path, then an honest decline)
 * Several documents: each is listed with its date, newest first, capped at CAP, and the rest are counted. Two customers with the same name are named, never merged.
 * Turn it off with DONOVAN_RECORDS_FIRST=0 (no redeploy of code needed beyond the environment setting).
 */
import { parseRecordsQuestion, findFacts, tokensOf, MAY_HAVE_WINDOW, alnum, STOP } from "./parse.js";
import { FACTS, factById } from "./directory.js";
import * as store from "./store.js";
import { nameTokens, tokenSame } from "../lookups/nameMatch.js";
import { isNonNameWord, isGivenName, isRealWordOrName } from "../lookups/commonWords.js";
import { attachCitations, documentRecord, customerRecord, unitRecord } from "../citations/records.js";

export const CAP = 5;
const RESIDUAL_OK = /^(?:invoice|invoices|inv|ticket|tickets|permit|job|jobs|visit|visits|house|home|place|property|site|customer|customers|last|latest|first|oldest|newest|recent|all|every|each|please|thanks|unit|units|doc|docs|document|documents|record|records|file|files|number|numbers|date|dates|way|exactly|today|them|they|their|theirs|his|her|hers|he|she|summarize|summarise|summary|recap|rundown|overview|detail|details|happened|everything|story|visit|service|call|ticket|work|system|systems)$/;
/** words that never ask for a fact (RECORDS-R2): they are the glue of a spoken sentence, so they must not make the lane refuse a question it can read */
const FILLER = /^(?:january|february|march|april|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec|take|took|taking|taken|spend|spent|spending|them|ever|always|again|there|over|time|times|ones?|thing|things|stuff|done|got|gets|put|came|went|were|was|been|being|know|need|needed|want|wanted|like|really|actually|exactly|anything|something|everything|ago|back|once|twice|whole|entire|total)$/;
export function recordsFirstEnabled() { return !/^(?:0|false|off|no)$/i.test(String(process.env.DONOVAN_RECORDS_FIRST ?? "1").trim()); }

/** facts the older lanes already answer correctly or that are computed elsewhere: answered by this lane only as a late safety net (after the older lanes declined) */
const LATE_ONLY = new Set(["payment_status", "balance_due", "amount_paid", "due_date", "warranty_expires", "direction", "doc_kind"]);
/** with a CUSTOMER as the subject, a question made only of these is a list-of-invoices question (with sums): the older money lane owns it */
const CUSTOMER_MONEY_ONLY = new Set(["total", "invoice_number", "invoice_date", "customer_name", "subtotal", "tax"]);

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const isoOf = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? "")); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };
export const humanDate = (v) => { const i = isoOf(v); return i ? `${MONTHS[Number(i.slice(5, 7)) - 1]} ${Number(i.slice(8, 10))}, ${i.slice(0, 4)}` : null; };
export const fmtMoney = (v) => { const n = Number(v); return Number.isFinite(n) ? `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : String(v); };
const plural = (n, a, b) => `${n} ${n === 1 ? a : (b ?? `${a}s`)}`;
const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const TYPE_LABEL = { invoice: "invoice", "service-ticket": "service ticket", "work-order": "work order", "warranty-registration": "warranty registration", "startup-sheet": "startup sheet", "proposal-quote": "quote", permit: "permit", "dispatch-note": "dispatch note", "inspection-report": "inspection report", "equipment-record": "equipment record", correspondence: "correspondence", "maintenance-agreement": "maintenance agreement", "purchase-order": "purchase order", "nameplate-photo": "nameplate photo", other: "document" };
const typeLabel = (t) => TYPE_LABEL[t] ?? String(t ?? "document").replace(/-/g, " ");
const JOB_TYPES = new Set(["service-ticket", "work-order", "dispatch-note", "inspection-report", "invoice", "startup-sheet"]);

function showValue(fact, raw) {
  const v = clean(raw);
  if (fact.kind === "money") return fmtMoney(v);
  if (fact.kind === "date") return humanDate(v) ?? v;
  if (fact.id === "labor_hours") { const n = Number(v); return Number.isFinite(n) ? `${n} ${n === 1 ? "hour" : "hours"}` : v; }
  if (fact.id === "payment_status") return v;
  return v;
}

/* ---------------------------------------------------------------------------------------------- subject */

function matchCustomers(tokens, customers, skip) {
  const q = tokens.map((t, i) => ({ t, i })).filter(({ t, i }) => !skip.has(i) && t.length > 0);
  const qt = q.map((x) => x.t);
  const full = [];
  for (const c of customers) {
    const ct = nameTokens(c.name); if (!ct.length) continue;
    const idx = [];
    const ok = ct.every((t) => { const hit = q.find((x) => x.t === t || tokenSame(x.t, t) === "exact"); if (hit) idx.push(hit.i); return Boolean(hit); });
    if (ok) full.push({ c, idx, size: ct.length });
  }
  let best = [];
  if (full.length) { const mx = Math.max(...full.map((f) => f.size)); best = full.filter((f) => f.size === mx); }
  // a customer whose whole name is contained in a longer matched name ("Mark Henderson" inside "Mark Henderson Jr") is not a second person: keep the longest only (done above by size)
  if (best.length) return { kind: "full", hits: best };
  // no whole name: customers sharing a name word with the question (a bare surname). Only words that are not plain English words count.
  const part = [];
  for (const c of customers) {
    const ct = nameTokens(c.name);
    const shared = ct.filter((t) => t.length >= 3 && qt.some((x) => x === t || tokenSame(x, t) === "exact") && !STOP.has(t) && !(isNonNameWord(t)));
    if (shared.length) part.push({ c, shared });
  }
  return part.length ? { kind: "partial", hits: part } : { kind: "none", hits: [] };
}

/* ---------------------------------------------------------------------------------------------- observations */

function pageFor(doc, bundle, value) {
  const pages = bundle.pages.filter((p) => p.document_id === doc.document_id);
  const needle = clean(value).toLowerCase(); if (!needle) return null;
  const hit = pages.find((p) => clean(p.text).toLowerCase().includes(needle));
  if (hit) return hit.page_no;
  if (/^-?\d+(\.\d+)?$/.test(needle)) { const n = Number(needle); const alts = [n.toFixed(2), n.toLocaleString("en-US", { minimumFractionDigits: 2 }), String(n)]; for (const a of alts) { const h = pages.find((p) => clean(p.text).includes(a)); if (h) return h.page_no; } }
  return pages.length === 1 ? pages[0].page_no : null;
}

function extractionValues(doc, bundle, key, unitId) {
  const seen = new Set(); const out = [];
  for (const r of bundle.facts) {
    if (r.document_id !== doc.document_id || r.field_key !== key || (unitId && r.entity_id && r.entity_id !== unitId)) continue;
    const v = clean(r.value); if (!v || seen.has(v.toLowerCase())) continue; seen.add(v.toLowerCase());
    out.push({ value: v, page: r.page_no ?? pageFor(doc, bundle, v) });
  }
  return out;
}

/** all stored values of one fact on one document: [{value, page}]. [] means "not stored on this document". */
function observe(fact, doc, bundle) {
  const fin = bundle.fin.get(doc.document_id);
  const lines = bundle.lines.filter((l) => l.document_id === doc.document_id);
  const total = (v, page) => (v == null || v === "" ? [] : [{ value: String(v), page: page ?? pageFor(doc, bundle, v) }]);
  switch (fact.source) {
    case "extraction": return extractionValues(doc, bundle, fact.key);
    case "unit": return fact.alsoExtraction ? extractionValues(doc, bundle, fact.alsoExtraction) : [];
    case "financials": {
      if (!fin) return fact.alsoExtraction ? extractionValues(doc, bundle, fact.alsoExtraction) : [];
      const raw = fin[fact.key];
      if (fact.id === "payment_status") return raw && raw !== "unknown" ? total(raw, null) : [];
      if (fact.id === "total") return raw == null ? [] : [{ value: String(raw), page: fin.total_page ?? pageFor(doc, bundle, raw) }];
      if (raw != null && raw !== "") return total(raw);
      return fact.alsoExtraction ? extractionValues(doc, bundle, fact.alsoExtraction) : [];
    }
    case "lines": {
      if (fact.id === "line_items" && bundle.partsOnly) {
        const parts = lines.length > 1 ? lines.filter((l) => l.category_guess !== "labor" && !/\blabou?r\b/i.test(l.description ?? "")) : [];
        return parts.map((l) => ({ value: clean(`${l.description ?? "item"}${l.qty != null && Number(l.qty) !== 1 ? ` (qty ${Number(l.qty)})` : ""}${l.amount != null ? `, ${fmtMoney(l.amount)}` : ""}`), page: l.page_no ?? null }));
      }
      if (fact.id === "line_items") return lines.map((l) => ({ value: clean(`${l.description ?? "item"}${l.qty != null && Number(l.qty) !== 1 ? ` (qty ${Number(l.qty)})` : ""}${l.amount != null ? `, ${fmtMoney(l.amount)}` : ""}`), page: l.page_no ?? null, raw: l }));
      const col = { line_qty: "qty", line_unit_price: "unit_price", line_amount: "amount", line_category: "category_guess" }[fact.id];
      return lines.filter((l) => l[col] != null && l[col] !== "").map((l) => ({ value: `${clean(l.description)}: ${col === "unit_price" || col === "amount" ? fmtMoney(l[col]) : clean(l[col])}`, page: l.page_no ?? null }));
    }
    case "derived": {
      if (fact.id === "labor_charge" || fact.id === "parts_charge") {
        const want = fact.id === "labor_charge" ? (l) => l.category_guess === "labor" || /\blabou?r\b/i.test(l.description ?? "") : (l) => l.category_guess === "parts";
        const pick = lines.filter((l) => l.amount != null && want(l));
        if (!pick.length) return [];
        const cents = pick.reduce((a, l) => a + Math.round(Number(l.amount) * 100), 0);
        return [{ value: String(cents / 100), page: pick[0].page_no ?? null, lines: pick.length }];
      }
      return [];
    }
    default: return [];
  }
}

function docDate(doc, bundle) {
  const fin = bundle.fin.get(doc.document_id);
  const sd = extractionValues(doc, bundle, "service_date")[0]?.value;
  return isoOf(sd) ?? isoOf(fin?.doc_date) ?? isoOf(extractionValues(doc, bundle, "invoice_date")[0]?.value) ?? isoOf(doc.created_at);
}
function docNumber(doc, bundle) {
  const fin = bundle.fin.get(doc.document_id);
  return fin?.invoice_number || fin?.po_number || extractionValues(doc, bundle, "invoice_number")[0]?.value || extractionValues(doc, bundle, "po_number")[0]?.value || extractionValues(doc, bundle, "permit_number")[0]?.value || null;
}
function docHead(doc, bundle) { const t = docTitle(doc, bundle); return `${t.replace(/^./, (c) => c.toUpperCase())} (${[doc.customer_name, humanDate(docDate(doc, bundle))].filter(Boolean).join(", ")})`; }
function docTitle(doc, bundle) { const n = docNumber(doc, bundle); return `${typeLabel(doc.document_type)}${n ? ` ${n}` : ""}`; }

/* ---------------------------------------------------------------------------------------------- answer assembly */

const sourceOf = (doc, page) => ({ documentId: doc.document_id, location: page != null ? { page: Number(page) } : { field: "document" } });

function envelope({ text, cards, sources, records, total, basis, closest }) {
  const data = { kind: "answer", text, facts: cards, sources, confidence: 1, verifiedCount: cards.length, unverifiedCount: 0, closest: closest ?? [], recordsLane: true };
  return attachCitations(data, { records, total: total ?? records.length, basis });
}

/** what IS stored on a document, as short labels (offered when the asked-for fact is not stored) */
function storedLabels(doc, bundle, exceptIds = []) {
  const labels = [];
  for (const f of FACTS) {
    if (f.hidden || f.viewOf || exceptIds.includes(f.id) || f.belongs === "customer") continue;
    if (observe(f, doc, bundle).length) labels.push(f.label.toLowerCase());
  }
  return labels;
}

function notStoredText(fact, doc, bundle, who) {
  const title = docTitle(doc, bundle);
  if (fact.id === "labor_charge") {
    const hrs = observe(factById("labor_hours"), doc, bundle)[0]; const tot = observe(factById("total"), doc, bundle)[0];
    return `${hrs ? `Labor hours: ${showValue(factById("labor_hours"), hrs.value)}. ` : ""}The ${typeLabel(doc.document_type)} does not record a separate labor charge${tot ? `; the total was ${fmtMoney(tot.value)}` : ""}.`;
  }
  if (fact.id === "parts_charge") {
    const li = observe(factById("line_items"), doc, bundle); const tot = observe(factById("total"), doc, bundle)[0];
    return `The ${typeLabel(doc.document_type)} does not record a separate parts charge${li.length ? ` (it has ${plural(li.length, "line item")}: ${li.slice(0, 3).map((x) => x.value).join("; ")})` : ""}${tot ? `; the total was ${fmtMoney(tot.value)}` : ""}.`;
  }
  const have = storedLabels(doc, bundle, [fact.id]).slice(0, 6);
  return `${fact.label} is not stored for ${who ? `${who}'s ` : "this "}${title}.${have.length ? ` What is stored on it: ${have.join(", ")}.` : ""}`;
}

/** the answer for a set of documents (a document number, or the documents of a customer / unit) */
/** documents whose amount is NOT what a job cost: a quote is a price proposed for work not yet done, an agreement is a yearly fee, a purchase order is what we bought. Never listed as the job's cost unless the question asks for that kind. */
const NOT_A_COST = { "proposal-quote": { what: "a proposed price, not a billed amount", asked: /\b(?:quotes?|quoted|estimates?|estimated|proposals?|bids?)\b/ }, "maintenance-agreement": { what: "a plan fee, not a billed job", asked: /\b(?:agreements?|contracts?|plans?|memberships?)\b/ }, "purchase-order": { what: "an order to a supplier, not a billed job", asked: /\b(?:purchase orders?|pos?|suppliers?|vendors?|ordered)\b/ } };
function answerForDocs({ docs: allDocs, bundle, factsWanted, who, order, all, scopeLabel, customerRec, unitRecs, win, askText = "" }) {
  const wanted = factsWanted.map(factById).filter(Boolean);
  // RECORDS-R2 cause 5: with several documents in scope, a money question is answered from the billed documents; quotes / agreements / purchase orders are set aside and named as what they are
  const moneyAsked = wanted.some((f) => f.kind === "money" || ["line_items", "labor_charge", "parts_charge"].includes(f.id));
  const setAside = moneyAsked && allDocs.length > 1 ? allDocs.filter((d) => NOT_A_COST[d.document_type] && !NOT_A_COST[d.document_type].asked.test(askText)) : [];
  const docs = setAside.length ? allDocs.filter((d) => !setAside.includes(d)) : allDocs;
  const dated = docs.map((d) => ({ d, date: docDate(d, bundle) })).sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || String(b.d.created_at).localeCompare(String(a.d.created_at)));
  const withObs = dated.map((x) => ({ ...x, obs: wanted.map((f) => ({ f, o: observe(f, x.d, bundle) })) })).filter((x) => x.obs.some((y) => y.o.length));
  const asideNote = () => {
    const parts = setAside.map((d) => ({ d, t: observe(factById("total"), d, bundle)[0] })).filter((x) => x.t);
    if (!parts.length) return "";
    return ` Not counted: ${parts.slice(0, 3).map((x) => `${docTitle(x.d, bundle)}${humanDate(docDate(x.d, bundle)) ? `, ${humanDate(docDate(x.d, bundle))}` : ""} (${fmtMoney(x.t.value)}) is ${NOT_A_COST[x.d.document_type].what}`).join("; ")}.`;
  };
  const cards = [], sources = [], records = []; const addRec = (d, page) => { const r = documentRecord({ id: d.document_id, document_type: d.document_type, original_filename: d.filename }, { label: docTitle(d, bundle), sublabel: [humanDate(docDate(d, bundle)), d.customer_name].filter(Boolean).join(" · "), page }); if (r) records.push(r); };
  const label = scopeLabel;
  if (order && dated.length > 1 && withObs.length) {
    // "the last invoice" means THAT document: if the fact is not stored on it, say so (never quietly answer from an older one)
    const pool = dated.filter((x) => JOB_TYPES.has(x.d.document_type)); const cand = pool.length ? pool : dated;
    const t = order === "oldest" ? cand[cand.length - 1] : cand[0];
    if (!withObs.some((x) => x.d.document_id === t.d.document_id)) {
      const names = wanted.map((f) => f.label.toLowerCase()).join(" / "); addRec(t.d, null);
      const have = storedLabels(t.d, bundle, wanted.map((f) => f.id));
      // the newest (or oldest) document that DOES carry the fact is added, dated and labelled as its own document (never as the asked-for document's value)
      const alt = (order === "oldest" ? [...withObs].reverse() : withObs).find((x) => cand.includes(x)) ?? (order === "oldest" ? withObs[withObs.length - 1] : withObs[0]);
      const altBits = [], altSources = [];
      for (const { f, o } of alt.obs) {
        if (!o.length) continue;
        const vals = o.slice(0, f.multi ? 6 : 1).map((y) => showValue(f, y.value));
        altBits.push(`${f.label.toLowerCase()}: ${vals.join("; ")}`);
        for (const y of o.slice(0, f.multi ? 6 : 1)) altSources.push(sourceOf(alt.d, y.page));
        cards.push({ label: `${f.label} · ${docTitle(alt.d, bundle)}${humanDate(alt.date) ? ` · ${humanDate(alt.date)}` : ""}`, value: vals.join("; "), status: "ok", sources: [sourceOf(alt.d, o[0].page)] });
      }
      addRec(alt.d, alt.obs.flatMap((y) => y.o)[0]?.page ?? null);
      const altText = ` The ${order === "oldest" ? "oldest" : "newest"} document that does carry it is ${docTitle(alt.d, bundle)}${humanDate(alt.date) ? `, ${humanDate(alt.date)}` : ""} (that document's own value, not the ${order === "oldest" ? "oldest" : "newest"} one's): ${altBits.join("; ")}.`;
      return envelope({ text: clean(`${label}, the ${order === "oldest" ? "oldest" : "newest"} one is ${docTitle(t.d, bundle)}${humanDate(t.date) ? `, ${humanDate(t.date)}` : ""}: ${names} is not stored on it.${have.length ? ` What is stored on it: ${have.join(", ")}.` : ""}${altText}${asideNote()}`),
        cards, sources: [sourceOf(t.d, null), ...altSources], records, total: 1 + 1, basis: `Read the stored record of ${docTitle(t.d, bundle)}; ${names} is not stored on it. Also read ${docTitle(alt.d, bundle)}, the ${order === "oldest" ? "oldest" : "newest"} document that has it.` });
    }
  }
  if (!withObs.length) {
    // nothing stored on any of the documents: say so, and say what IS stored (never another fact in its place)
    const first = dated[0]?.d;
    const names = wanted.map((f) => f.label.toLowerCase()).join(" / ");
    if (docs.length === 1 && first) { const t = notStoredText(wanted[0], first, bundle, null); addRec(first, null); return envelope({ text: `${label}: ${t}`, cards, sources: [sourceOf(first, null)], records, basis: `Read the stored record of ${docTitle(first, bundle)}; ${names} is not stored on it.` }); }
    const tally = {}; for (const x of dated) tally[typeLabel(x.d.document_type)] = (tally[typeLabel(x.d.document_type)] ?? 0) + 1;
    const have = [...new Set(dated.flatMap((x) => storedLabels(x.d, bundle, wanted.map((f) => f.id))))].slice(0, 8);
    dated.slice(0, CAP).forEach((x) => addRec(x.d, null));
    return envelope({ text: `No ${names} is stored for ${label}${win ? ` in ${win.label}` : ""}. ${dated.length ? `${plural(dated.length, "document")} on file (${Object.entries(tally).map(([k, v]) => plural(v, k)).join(", ")}) ${dated.length === 1 ? "does" : "do"} not carry it.` : "No documents are on file."}${have.length ? ` What is stored: ${have.join(", ")}.` : ""}${asideNote()}`,
      cards, sources: [], records, total: dated.length, basis: `Checked the ${plural(dated.length, "stored document")} for ${label}; none has ${names}.` });
  }
  let shown = withObs;
  if (order === "oldest") shown = [withObs[withObs.length - 1]]; else if (order === "newest") shown = [withObs[0]];
  const more = order ? 0 : Math.max(0, withObs.length - CAP);
  shown = shown.slice(0, CAP);
  const docScope = docs.length === 1; // a document number: say plainly what is and is not stored on that one document
  const multiFact = wanted.length > 1;
  const parts = [];
  for (const x of shown) {
    const bits = [];
    for (const { f, o } of x.obs) {
      if (!o.length) { if (docScope) bits.push(`${f.label}: not stored`); continue; }
      const vals = o.slice(0, f.multi ? 6 : 1).map((y) => showValue(f, y.value));
      bits.push(multiFact || docScope || f.multi ? `${f.label.toLowerCase().replace(/^./, (c) => (docScope ? f.label[0] : c))}: ${vals.join("; ")}` : vals.join("; "));
      for (const y of o.slice(0, f.multi ? 6 : 1)) sources.push(sourceOf(x.d, y.page));
      cards.push({ label: `${f.label} · ${docTitle(x.d, bundle)}${humanDate(x.date) ? ` · ${humanDate(x.date)}` : ""}`, value: vals.join("; "), status: "ok", sources: [sourceOf(x.d, o[0].page)] });
    }
    addRec(x.d, x.obs.flatMap((y) => y.o)[0]?.page ?? null);
    parts.push({ head: `${humanDate(x.date) ? `${humanDate(x.date)}, ` : ""}${docTitle(x.d, bundle)}${x.d.customer_name && !who ? ` (${x.d.customer_name})` : ""}`, body: bits.join("; ") });
  }
  const lead = wanted.map((f) => f.label.toLowerCase()).join(", ");
  let text;
  if (docScope) text = `${label} — ${parts[0].body}.`;
  else if (parts.length === 1 && more === 0) text = `${label}, ${lead} (${parts[0].head}): ${parts[0].body}.`;
  else text = `${label}, ${lead}${win ? ` in ${win.label}` : ""} — ${plural(withObs.length, "document")}${order ? "" : ", newest first"}: ${parts.map((p) => `${p.head}: ${p.body}`).join("; ")}${more > 0 ? `; and ${more} more` : ""}.`;
  // facts asked for that none of the shown documents carries: say so once, with what IS stored
  const absentEverywhere = wanted.filter((f) => !shown.some((x) => x.obs.find((y) => y.f.id === f.id)?.o.length));
  if (absentEverywhere.length) {
    if (docScope) text += ` ${absentEverywhere.map((f) => notStoredText(f, shown[0].d, bundle, null)).join(" ")}`;
    else text += ` ${absentEverywhere.map((f) => f.label).join(" and ")} ${absentEverywhere.length === 1 ? "is" : "are"} not stored on ${shown.length === 1 ? "that document" : "those documents"}.`;
  }
  text += asideNote();
  return envelope({ text: clean(text), cards: cards.slice(0, 12), sources, records: [...(customerRec ? [customerRec] : []), ...records], total: withObs.length + (customerRec ? 1 : 0), basis: `Read ${wanted.map((f) => f.label.toLowerCase()).join(" and ")} from the stored records of ${label}${order === "newest" ? " (the newest document that has it)" : ""}; each value is cited to its document and page.` });
}

function entityText(c, key) { return clean(c[key]); }

/* ---------------------------------------------------------------------------------------------- lane */

/** skips that mean "the subject was found but the question's facts could not be read": in the late phase these end in a stored-record answer, never a decline */
const SUBJECT_FOUND_SKIPS = new Set(["no-fact", "no-fact-after-name", "no-fact-after-subject", "unread-words-with-document-number", "unread-words-with-customer", "summary-nothing", "pointless", "customer-of-a-document-owned-by-older-lane", "yes-no-question", "unresolved-name-words", "whole-card-owned-by-older-lane", "several-customers-named"]);
const EXISTENCE_ASK = /\b(?:any|anything|there|have|has|had|got|on file|recorded|stored|listed)\b/;

export async function runRecordsLane(db, question, opts = {}) {
  if (!recordsFirstEnabled()) return null;
  const phase = opts.phase ?? "early";
  const state = {};
  const r = await runCore(db, question, opts, state);
  if (phase !== "late") return r;
  if (r?.data?.kind === "answer" && state.yesNo) {
    // a yes/no question about a stored fact: say yes or no from the rows (only when the question asks whether it exists; a value check just gets the stored values)
    const has = (r.data.facts ?? []).length > 0;
    if (state.yesNo.existence && state.yesNo.n === 1) r.data.text = has ? `Yes: ${r.data.text}` : `No. ${r.data.text}`;
  }
  if (r?.skip && SUBJECT_FOUND_SKIPS.has(r.skip)) {
    try { const f = await storedRecordFallback(db, question, opts); if (f) return f; } catch (err) { console.error("Records fallback failed:", err?.message); }
  }
  return r;
}

async function runCore(db, question, { today, phase = "early", customers = null } = {}, state = {}) {
  let periodFn = null;
  const lower = String(question ?? "").toLowerCase();
  if (MAY_HAVE_WINDOW.test(lower)) { try { periodFn = (await import("../financials/answers.js")).parsePeriod; } catch { periodFn = null; } }
  const p = parseRecordsQuestion(question, { today, parsePeriodFn: periodFn });
  if (p.stepAside) return { skip: p.stepAside };
  if (p.softVeto && phase !== "late") return { skip: "aggregate-or-howto" };
  p.serials = p.serials.filter((sn) => !p.docNumbers.some((d) => d.alnum === sn));
  if (!p.facts.length && !p.summary && !(p.docNumbers.length && /\bstatus\b/.test(p.text))) return { skip: "no-fact" };
  // a yes/no question ("do we have a maintenance agreement on file for ...", "is the technician Ray?") is answered yes or no by the older lanes, never with a list of values
  if (/^(?:do|does|did|is|are|was|were|has|have|had|can|could|will|would|should)\s/.test(p.text) && !/^(?:can|could|would|will) (?:you|u) /.test(p.text)) {
    if (phase !== "late") return { skip: "yes-no-question" };
    state.yesNo = { existence: EXISTENCE_ASK.test(p.text) };
  }
  if (/\b(?:isnt|isn t|is not|arent|not|never|no longer|except|without|other than|besides|excluding|instead of)\b/.test(p.text)) return { skip: "negation" };
  if (p.facts.some((id) => factById(id)?.elsewhere)) return { skip: "owned-by-older-lane" };
  if (phase === "early" && !p.docNumbers.length && p.facts.some((id) => LATE_ONLY.has(id))) return { skip: "late-only-fact" };
  if (p.summary && /\b(?:everything|all about|tell me about)\b/.test(p.text) && !/\b(?:job|jobs|visit|visits|service|call|work|invoice|ticket|last|latest|first)\b/.test(p.text)) return { skip: "whole-card-owned-by-older-lane" };
  if (/\b(?:bills?|vendors?|suppliers?)\b/.test(p.text) && !p.docNumbers.length) return { skip: "vendor-side-owned-by-money-lane" };
  if (/\b(?:arriv\w*|what time|gate code|eta|on ?site|how long)\b|\btech(?:nician)?s?\s+(?:phone|email|number|address|cell)\b/.test(p.text)) return { skip: "asks-for-something-the-directory-does-not-hold" };
  if (/\b(?:staff|internal|private|confidential|secret|hidden|admin|office only|owner only)\b/.test(p.text)) return { skip: "restricted-wording" };

  // ---- subject: a document number / serial first, else a customer by name, else an address
  const cust = customers ?? await store.loadCustomers(db);
  const codes = [...p.docNumbers];
  for (const s of p.serials) if (!codes.some((c) => c.alnum === s)) codes.push({ raw: s, alnum: s, digits: s.replace(/\D/g, ""), prefixed: true });
  let docHits = codes.length ? await store.docsByNumber(db, codes) : [];
  let unitHits = p.serials.length ? await store.unitsBySerial(db, p.serials) : [];
  const nameSkip = new Set(); // token positions used by code tokens
  p.tokens.forEach((t, i) => { if (codes.some((c) => c.alnum === alnum(t))) nameSkip.add(i); });
  const nm = matchCustomers(p.tokens, cust, new Set([...nameSkip]));
  if (nm.kind === "full" && nm.hits.length > 1) return { skip: "several-customers-named" };
  const named = nm.kind === "full" ? nm.hits[0] : null;
  const nameIdx = new Set(named ? named.idx : []);
  // facts again, with the customer's own name words masked ("Rios Heating" must not read "heating" as a fact)
  const f2 = findFacts(p.tokens, { exclude: new Set([...nameIdx, ...nameSkip]) });
  let factIds = f2.ids;
  if (factIds.some((id) => factById(id)?.elsewhere)) return { skip: "owned-by-older-lane" };
  // the thing the question GIVES is not the thing it ASKS for ("whose unit has serial X" gives the serial)
  if (p.serials.length || codes.length) factIds = factIds.filter((id) => !(id === "serial_number" && p.serials.length) && !(id === "invoice_number" && p.docNumbers.length && !/\bnumber|\bno\b|#/.test(p.text.replace(p.docNumbers.map((n) => n.raw).join("|"), ""))));
  if (/\bstatus\b/.test(p.text) && docHits.length && docHits.every((d) => d.document_type !== "invoice")) factIds = [...factIds.filter((id) => id !== "payment_status"), ...(factIds.includes("job_status") ? [] : ["job_status"])];
  if (factIds.includes("customer_name") && factIds.some((id) => ["customer_phone", "customer_email", "customer_address", "customer_number"].includes(id))) factIds = factIds.filter((id) => id !== "customer_name");
  if (factIds.includes("labor_charge") && factIds.includes("line_items") && /\b(?:how much|cost|amount|charge|total)\b/.test(p.text) && /\bparts?\b/.test(p.text)) factIds = [...factIds.filter((id) => id !== "line_items"), "parts_charge"];
  // "what did we charge X for parts" / "how much were the parts": the money for the parts, not a list of parts next to the invoice total
  else if (factIds.includes("line_items") && /\bparts?\b/.test(p.text) && (/\b(?:how much|cost|costs|amount|price|priced|spent)\b/.test(p.text) || /\b(?:charge|charged|billed|bill)\b.*\bfor (?:the )?parts?\b/.test(p.text)) && !/\b(?:total|line items?|itemi[sz]ed|which|what parts)\b/.test(p.text)) factIds = [...factIds.filter((id) => id !== "line_items" && id !== "total"), "parts_charge"];
  // a money part of the invoice ("labor", "parts") asked with a general money word ("bill", "charge", "how much") is about THAT part, never about the invoice total
  if ((factIds.includes("labor_charge") || factIds.includes("parts_charge")) && factIds.includes("total") && !/\b(?:total|grand total|invoice total)\b/.test(p.text)) factIds = factIds.filter((id) => id !== "total");
  // "name of the guy who handled it" asks for the technician; the word "name" alone is not the customer
  if (factIds.includes("technician") && factIds.includes("customer_name") && !/\b(?:customer|whose|owner|billed|bill to|client|homeowner)\b/.test(p.text)) factIds = factIds.filter((id) => id !== "customer_name");
  if (!factIds.length && !p.summary) return { skip: "no-fact-after-name" };
  if (state.yesNo) state.yesNo.n = factIds.length;
  if (p.summary && /\b(?:dispatch|proposal|quote|estimate|permit|agreement|warranty|startup|start up|inspection|purchase order|nameplate|correspondence|memo|email)\b/.test(p.text) && !p.docNumbers.length) return { skip: "summary-of-a-document-type" };
  if (phase === "early" && !codes.length && factIds.some((id) => LATE_ONLY.has(id))) return { skip: "late-only-fact" };
  // customer-record and unit facts (address, phone, serial, refrigerant ...) are answered by the older lanes when they claim the question; this lane only takes them after those lanes declined
  if (phase === "early" && !codes.length && factIds.some((id) => ["customer_name", "customer_address", "customer_phone", "customer_email", "equipment_list"].includes(id))) return { skip: "entity-fact-owned-by-older-lane" };
  // residual words that look like another person's name: the question is about someone we did not resolve
  const used = new Set([...nameIdx, ...nameSkip]); f2.used.forEach((u, i) => { if (u) used.add(i); });
  const residualNames = p.tokens.filter((t, i) => !used.has(i) && /^[a-z]{3,}$/.test(t) && !STOP.has(t) && !isNonNameWord(t) && !RESIDUAL_OK.test(t) && !FILLER.test(t));

  let scope = null; // {kind, who, label, docs, customer, units}
  let scopes = null;
  if (docHits.length) {
    // "purchase order 5120" names a purchase order: a document of another kind that happens to share the number is not what was asked for
    if (/\b(?:purchase order|po)\s*#?\s*(?:no\.?\s*)?[a-z]*-?\d/i.test(p.text) && !/\b(?:invoice|inv|ticket|permit|work order)\b/i.test(p.text) && docHits.some((d) => d.document_type !== "purchase-order")) return { skip: "purchase-order-number-on-another-kind" };
    // words the directory does not know ("city", "expire", "inspection") mean the question asks for something this lane cannot read: step aside, never answer a different fact
    const ownerWords = new Set(docHits.flatMap((d) => String(d.customer_name ?? "").toLowerCase().split(/[^a-z]+/).filter(Boolean)));
    const leftover = p.tokens.filter((t, i) => !used.has(i) && !ownerWords.has(t) && !(t === "status" && factIds.includes("job_status")) && /^[a-z]{3,}$/.test(t) && !STOP.has(t) && !RESIDUAL_OK.test(t) && !FILLER.test(t) && !/^(?:order|purchase|pls|number|no|po|wo|inv|invoice|ticket|permit|worked|performed|completed|did|listed|stored|printed|written|recorded|say|says|said|shows|show|there|been|got|gets|was|were|tell|give|get|charge|charged|cost|bill|billed|spend|spent|how|much|many|long)$/.test(t));
    if (leftover.length) return { skip: "unread-words-with-document-number" };
    if (factIds.includes("line_items") && docHits.some((d) => d.document_type === "purchase-order")) return { skip: "purchase-order-parts-owned-by-older-lane" };
    if (factIds.length === 1 && factIds[0] === "customer_name" && !docHits.some((d) => d.document_type === "proposal-quote") && p.docNumbers.every((n) => n.prefixed)) return { skip: "customer-of-a-document-owned-by-older-lane" };
    if (named && docHits.every((d) => d.customer_id !== named.c.id)) return { skip: "number-not-under-named-customer" };
    const docs = named ? docHits.filter((d) => d.customer_id === named.c.id) : docHits;
    const owners = [...new Set(docs.map((d) => d.customer_id).filter(Boolean))];
    scope = { kind: "doc", docs, who: null, label: docs.length === 1 ? null : "That number", customer: owners.length === 1 ? cust.find((c) => c.id === owners[0]) ?? null : null };
  } else if (unitHits.length) {
    if (unitHits.length > 1) return { skip: "serial-on-several-units" };
    const u = unitHits[0]; const c = cust.find((x) => x.id === u.customer_id);
    scope = { kind: "unit", unit: u, customer: c, docs: await store.docsForUnit(db, u.id), who: c?.name ?? null, label: `Unit ${u.data?.serial_number ?? ""}${c ? ` (${c.name})` : ""}`.trim() };
  } else if (named) {
    if (residualNames.length) return { skip: "unresolved-name-words" };
    scope = { kind: "customer", customer: named.c, who: named.c.name, label: named.c.name, byName: true };
  } else if (nm.kind === "partial") {
    // a bare surname/first name: the customers that hold that word. One -> that customer. Several (2-4) -> an answer for EACH, labelled with the full name (never merged);
    // more than that -> a list to choose from.
    const distinct = [...new Map(nm.hits.map((h) => [h.c.id, h.c])).values()];
    const sharedWords = new Set(nm.hits.flatMap((h) => h.shared));
    p.tokens.forEach((t, i) => { if ([...sharedWords].some((w) => w === t || tokenSame(t, w) === "exact")) used.add(i); });
    const residual2 = p.tokens.filter((t, i) => !used.has(i) && !nameSkip.has(i) && /^[a-z]{3,}$/.test(t) && !STOP.has(t) && !isNonNameWord(t) && !RESIDUAL_OK.test(t) && !FILLER.test(t));
    if (residual2.length) return { skip: "unresolved-name-words" };
    if (distinct.length === 1) scopes = [{ kind: "customer", customer: distinct[0], who: distinct[0].name, label: distinct[0].name, byName: true }];
    else if (distinct.length <= 4) scopes = distinct.map((c) => ({ kind: "customer", customer: c, who: c.name, label: c.name, byName: true }));
    else if (distinct.length <= 8) {
      const list = distinct.map((c) => c.name); const askFor = factIds.map((id) => factById(id)?.label.toLowerCase()).find(Boolean) ?? "summary";
      return { data: attachCitations({ kind: "no-answer", text: `More than one customer matches that name: ${list.join(", ")}. Which one did you mean?`, facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [], clarify: true, clarifyReason: "name-share",
        didYouMean: list.slice(0, 3).map((n) => ({ text: p.summary ? `summarize the last job for ${n}` : `${askFor} for ${n}` })), recordsLane: true }, { records: distinct.map((c) => customerRecord({ id: c.id, name: c.name, service_address: c.address })).filter(Boolean), total: distinct.length, kind: "searched", basis: "Several customers share that name, so nothing was looked up until you pick one." }), lane: "records", detail: "name-share-clarify" };
    } else return { skip: "partial-name" };
  } else if (p.address) {
    const hits = await store.customersByAddress(db, p.address);
    if (hits.length !== 1) return { skip: hits.length ? "address-several" : "no-subject" };
    const c = cust.find((x) => x.id === hits[0].id); if (!c) return { skip: "no-subject" };
    if (residualNames.length) return { skip: "unresolved-name-words" };
    scope = { kind: "customer", customer: c, who: c.name, label: c.name };
  } else return { skip: "no-subject" };

  // words the directory does not know ("city", "term", "expires") mean the question asks for something this lane cannot read: step aside rather than answer a different fact
  if (named || scope?.kind === "customer") {
    const nameWords = new Set(cust.flatMap((c) => String(c.name).toLowerCase().split(/[^a-z]+/).filter(Boolean)));
    const unread = p.tokens.filter((t, i) => !used.has(i) && /^[a-z]{4,}$/.test(t) && !STOP.has(t) && !RESIDUAL_OK.test(t) && !FILLER.test(t) && !nameWords.has(t) && !/^(?:order|purchase|pls|number|worked|performed|completed|did|listed|stored|printed|written|recorded|say|says|said|shows|show|there|been|got|gets|was|were|tell|give|charge|charged|cost|bill|billed|spend|spent|much|many|long|how|latest|last|first|oldest|newest|earliest|recent|most|account|customer|accounts|invoice|invoices|ticket|tickets|list|lists|items|item)$/.test(t));
    if (unread.length && !p.summary) return { skip: "unread-words-with-customer" };
  }
  const answerFor = async (scope) => {
  let fIds = factIds;
    if (fIds.includes("customer_name") && scope.kind === "customer" && scope.byName) fIds = fIds.filter((id) => id !== "customer_name"); // the question already names the customer
    if (!fIds.length && !p.summary) return { skip: "no-fact-after-subject" };
    const nameIsEntityFact = fIds.includes("customer_name") && (scope.kind === "customer" || scope.kind === "unit");
    if ((scope.kind === "customer" || scope.kind === "multi") && fIds.some((id) => LATE_ONLY.has(id))) return { skip: "money-state-across-documents-owned-by-money-lane" };
    if (scope.kind === "customer" && phase === "early" && !p.summary && !p.order && fIds.every((id) => CUSTOMER_MONEY_ONLY.has(id))) return { skip: "customer-money-list-owned-by-money-lane" };
    if (scope.kind === "customer" && fIds.length === 1 && fIds[0] === "customer_name") return { skip: "pointless" };

    // ---- customer-level facts (the customer record itself)
    const customerFacts = fIds.filter((id) => (factById(id).belongs === "customer" && id !== "equipment_list") || (id === "customer_name" && nameIsEntityFact));
    const unitFacts = fIds.filter((id) => factById(id).belongs === "unit" || id === "equipment_list");
    const docFacts = fIds.filter((id) => !customerFacts.includes(id) && !unitFacts.includes(id));

    const customerRec = scope.customer ? customerRecord({ id: scope.customer.id, name: scope.customer.name, service_address: scope.customer.address }) : null;
    const trace = (detail) => ({ lane: "records", detail });

    // customer record facts + equipment: answered from the customer / unit records first
    if (scope.kind === "customer" && (customerFacts.length || unitFacts.length) && !docFacts.length && !p.summary) {
      p.phase = phase; const ef = await answerEntityFacts(db, scope, customerFacts, unitFacts, customerRec, p);
      if (p.mixedUnits) return { skip: "mixed-unit-values-owned-by-older-lane" };
      return { data: ef, ...trace("entity-facts") };
    }
    if (scope.kind === "unit" && (unitFacts.length || customerFacts.length) && !docFacts.length && !p.summary) {
      return { data: await answerEntityFacts(db, { kind: "unit-direct", unit: scope.unit, customer: scope.customer, who: scope.who, label: scope.label }, customerFacts, unitFacts, customerRec, p), ...trace("unit-facts") };
    }

    // ---- documents in scope
    let docs;
    if (scope.kind === "doc" || scope.kind === "unit") docs = scope.docs;
    else docs = await store.docsForCustomer(db, scope.customer.id);
    if (!docs.length) {
      if (scope.kind === "customer") {
        const rec = [customerRec].filter(Boolean);
        return { data: envelope({ text: `${scope.label} is on file, but no stored document is linked to ${scope.label} yet, so there is no ${fIds.map((id) => factById(id).label.toLowerCase()).join(" / ") || "job"} to read.`, cards: [], sources: [], records: rec, total: 1, basis: "Checked the documents linked to this customer; none." }), ...trace("no-documents") };
      }
      return { skip: "no-docs" };
    }
    const bundle = await store.loadBundle(db, docs.map((d) => d.document_id));
    bundle.partsOnly = /\bparts?\b/.test(p.text) && !/\b(?:line items?|itemi[sz]ed|everything|all items)\b/.test(p.text);
    let scoped = docs;
    if (p.window) {
      const inWin = (iso) => iso && (!p.window.from || iso >= p.window.from) && (!p.window.to || iso <= p.window.to);
      scoped = docs.filter((d) => inWin(docDate(d, bundle)));
      if (!scoped.length) return { data: envelope({ text: `No stored document for ${scope.label ?? "that number"} is dated in ${p.window.label}.`, cards: [], sources: [], records: [customerRec].filter(Boolean), total: 1, basis: `Checked the dates of the ${plural(docs.length, "stored document")} for ${scope.label ?? "that number"}; none falls in ${p.window.label}.` }), ...trace("window-empty") };
    }

    if (scope.kind === "customer" || scope.kind === "multi") {
      const kindWanted = /\binvoices?\b/.test(p.text) ? ["invoice"] : /\b(?:tickets?|work orders?|service calls?)\b/.test(p.text) ? ["service-ticket", "work-order"] : null;
      if (kindWanted && !p.docNumbers.length) { const k = scoped.filter((d) => kindWanted.includes(d.document_type)); if (k.length) scoped = k; else return { skip: "no-document-of-the-asked-kind" }; }
    }
    if (p.summary) {
      const data = answerSummary({ scope, docs: scoped, bundle, fIds, customerRec, order: p.order, win: p.window });
      return data ? { data, ...trace("summary") } : { skip: "summary-nothing" };
    }
    if (customerFacts.length || unitFacts.length) {
      // mixed asks (a document fact together with a customer / unit fact): the document part from the documents, the rest from the records, in one answer
      if (!docFacts.length && scope.kind === "doc" && scope.customer) {
        const only = await answerEntityFacts(db, { ...scope, kind: "customer", who: scope.customer.name, label: scope.customer.name }, customerFacts, unitFacts, customerRec, p);
        if (only?.text && scoped.length === 1) only.text = clean(`${docHead(scoped[0], bundle)} — ${only.text}`);
        return { data: only, ...trace("document-entity-facts") };
      }
      const base = answerForDocs({ docs: scoped, bundle, factsWanted: docFacts, who: scope.who, order: p.order, all: p.all, askText: p.text, scopeLabel: scope.label ?? (scoped.length === 1 ? docHead(scoped[0], bundle) : "That number"), customerRec, win: p.window });
      const extra = await answerEntityFacts(db, scope.kind === "customer" ? scope : { ...scope, kind: "customer", who: scope.customer?.name ?? null, label: scope.customer?.name ?? null }, customerFacts, unitFacts, customerRec, p).catch(() => null);
      if (base && extra) { base.text = `${base.text} ${extra.text}`; base.facts = [...base.facts, ...extra.facts]; base.sources = [...base.sources, ...extra.sources]; }
      return { data: base, ...trace("mixed") };
    }
    const data = answerForDocs({ docs: scoped, bundle, factsWanted: docFacts, who: scope.who, order: p.order, all: p.all, askText: p.text, scopeLabel: scope.kind === "doc" ? (scoped.length === 1 ? docHead(scoped[0], bundle) : "That number") : scope.label, customerRec, win: p.window });
    return { data, ...trace(scope.kind === "doc" ? "document-facts" : "customer-document-facts") };
  };
  if (!scopes) scopes = [scope];
  if (scopes.length === 1) return answerFor(scopes[0]);
  // several customers share the word: entity-only facts and summaries stay with the older lanes / a pick-one list; only document facts (which they cannot read) are answered for each
  if (p.summary) return { skip: "several-customers-summary" };
  if (!factIds.some((id) => !["customer", "unit"].includes(factById(id).belongs))) {
    return { skip: "several-customers-entity-facts" };
    const list = scopes.map((x) => x.customer.name);
    return { data: attachCitations({ kind: "no-answer", text: `More than one customer matches that name: ${list.join(", ")}. Which one did you mean?`, facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [], clarify: true, clarifyReason: "name-share",
      didYouMean: list.slice(0, 3).map((n) => ({ text: `summarize the last job for ${n}` })), recordsLane: true }, { records: scopes.map((x) => customerRecord({ id: x.customer.id, name: x.customer.name, service_address: x.customer.address })).filter(Boolean), total: scopes.length, kind: "searched", basis: "Several customers share that name, so nothing was looked up until you pick one." }), lane: "records", detail: "name-share-clarify" };
  }
  const outs = [];
  for (const sc of scopes) { const o = await answerFor(sc); if (!o?.data || o.data.kind !== "answer") return { skip: "multi-customer-part-failed" }; outs.push(o); }
  const first = outs[0].data;
  const merged = { ...first, text: `I found ${outs.length} customers that match that name. ${outs.map((o) => o.data.text).join(" ")}`, facts: outs.flatMap((o) => o.data.facts ?? []), sources: outs.flatMap((o) => o.data.sources ?? []), recordsLane: true };
  return { data: attachCitations(merged, { records: outs.flatMap((o) => o.data.records ?? []), total: outs.reduce((a, o) => a + (o.data.recordsTotal ?? 0), 0), basis: "Several customers share that name; each is answered separately from its own records." }), lane: "records", detail: "name-share-each" };
}

/* ---------------------------------------------------------------------------------------------- customer / unit record answers */

async function answerEntityFacts(db, scope, customerFacts, unitFacts, customerRec, p) {
  const c = scope.customer; const who = scope.who ?? scope.label;
  const parts = [], cards = [], sources = [], records = [customerRec].filter(Boolean);
  // citation: the newest document whose page text carries the value (the record itself has no page)
  let docsCache = null, bundleCache = null;
  const cite = async (value) => {
    if (!value || !c) return null;
    docsCache ??= await store.docsForCustomer(db, c.id);
    bundleCache ??= await store.loadBundle(db, docsCache.slice(0, 40).map((d) => d.document_id));
    for (const d of docsCache.slice(0, 40)) { const pg = pageFor(d, bundleCache, value); if (pg != null && bundleCache.pages.some((x) => x.document_id === d.document_id && clean(x.text).toLowerCase().includes(clean(value).toLowerCase()))) return { d, pg }; }
    return null;
  };
  for (const id of customerFacts) {
    const f = factById(id); const raw = c ? entityText(c, { customer_address: "address", customer_phone: "phone", customer_email: "email", customer_number: "customer_number", customer_name: "name" }[id]) : "";
    if (!raw) { parts.push(`${f.label} is not stored for ${who ?? "that record"}.`); continue; }
    const hit = await cite(raw);
    parts.push(id === "customer_name" ? (scope.kind === "unit-direct" ? `That unit${scope.unit?.data?.serial_number ? ` (serial ${scope.unit.data.serial_number})` : ""} belongs to ${raw}.` : `That is ${raw}.`) : `${who}'s ${f.label.toLowerCase()} is ${raw}.`);
    const src = hit ? [sourceOf(hit.d, hit.pg)] : [];
    cards.push({ label: f.label, value: raw, status: "ok", entityId: c.id, sources: src }); sources.push(...src);
    if (hit) records.push(documentRecord({ id: hit.d.document_id, document_type: hit.d.document_type, original_filename: hit.d.filename }, { label: typeLabel(hit.d.document_type), page: hit.pg }));
  }
  if (unitFacts.length) {
    const units = scope.kind === "unit-direct" ? [scope.unit] : await store.unitsForCustomer(db, c.id);
    if (!units.length) parts.push(`No equipment is stored for ${who}.`);
    else {
      const fact1 = unitFacts.filter((id) => id !== "equipment_list").map(factById);
      const describe = (u) => clean([u.data?.manufacturer, u.data?.model].filter(Boolean).join(" ")) || "Unit";
      if (unitFacts.includes("equipment_list")) {
        parts.push(`${who} has ${plural(units.length, "piece of equipment", "pieces of equipment")} on file: ${units.map((u) => `${describe(u)}${u.data?.serial_number ? ` (serial ${u.data.serial_number})` : ""}${u.data?.tonnage ? `, ${u.data.tonnage}` : ""}`).join("; ")}.`);
        units.forEach((u) => records.push(unitRecord({ id: u.id, manufacturer: u.data?.manufacturer, equipment_type: u.data?.equipment_type, model: u.data?.model, serial_number: u.data?.serial_number, customer_id: u.customer_id })));
      }
      for (const f of fact1) {
        const rowsTxt = [];
        for (const u of units.slice(0, 6)) {
          let raw = clean(u.data?.[f.key]);
          if (!raw && f.alsoExtraction && units.length === 1) { // the unit record has no value: the newest stored reading for this unit
            const x = (await store.loadBundle(db, (await store.docsForUnit(db, u.id)).slice(0, 20).map((d) => d.document_id))).facts.filter((r) => r.entity_id === u.id && r.field_key === f.alsoExtraction && clean(r.value));
            raw = clean(x[x.length - 1]?.value);
          }
          rowsTxt.push({ u, raw });
        }
        const showUnit = (u) => `${describe(u)}${u.data?.serial_number ? ` (serial ${u.data.serial_number})` : ""}`;
        if (units.length === 1) {
          const { u, raw } = rowsTxt[0];
          if (raw) { parts.push(`${who}'s ${describe(u).toLowerCase() === "unit" ? "unit" : `${describe(u)} unit`} — ${f.label.toLowerCase()}: ${showValue(f, raw)}.`); cards.push({ label: f.label, value: showValue(f, raw), status: "ok", entityId: u.id, sources: [] }); }
          else parts.push(`${f.label} is not on file for ${who}'s ${showUnit(u)}.`);
        } else {
          if (p.phase === "early" && rowsTxt.some((r) => r.raw) && rowsTxt.some((r) => !r.raw)) p.mixedUnits = true; // some units carry the value and some do not: the older lane decides, then this lane answers if it declined
          parts.push(`${f.label} by unit for ${who}: ${rowsTxt.map(({ u, raw }) => `${showUnit(u)} — ${raw ? showValue(f, raw) : "not on file"}`).join("; ")}.`);
          rowsTxt.filter((r) => r.raw).forEach(({ u, raw }) => cards.push({ label: `${f.label} · ${showUnit(u)}`, value: showValue(f, raw), status: "ok", entityId: u.id, sources: [] }));
        }
        units.forEach((u) => records.push(unitRecord({ id: u.id, manufacturer: u.data?.manufacturer, equipment_type: u.data?.equipment_type, model: u.data?.model, serial_number: u.data?.serial_number, customer_id: u.customer_id })));
      }
    }
  }
  return envelope({ text: clean(parts.join(" ")), cards, sources, records: records.filter(Boolean), total: records.length, basis: `Read the stored ${[...customerFacts, ...unitFacts].map((id) => factById(id).label.toLowerCase()).join(", ")} from the records of ${who}.` });
}

/* ---------------------------------------------------------------------------------------------- summaries */

function answerSummary({ scope, docs, bundle, factIds, customerRec, order, win }) {
  const dated = docs.map((d) => ({ d, date: docDate(d, bundle) })).sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  let pick;
  if (scope.kind === "doc") pick = dated.length === 1 ? dated[0] : null;
  else { const jobs = dated.filter((x) => JOB_TYPES.has(x.d.document_type)); pick = order === "oldest" ? jobs[jobs.length - 1] : jobs[0]; }
  if (!pick) return null;
  const { d, date } = pick;
  const g = (id) => observe(factById(id), d, bundle);
  const bits = []; const cards = [], sources = [], records = [];
  const add = (id, text) => { const o = g(id); if (!o.length) return; const f = factById(id); const v = o.slice(0, f.multi ? 6 : 1).map((y) => showValue(f, y.value)); bits.push(text(v)); for (const y of o.slice(0, f.multi ? 6 : 1)) sources.push(sourceOf(d, y.page)); cards.push({ label: f.label, value: v.join("; "), status: "ok", sources: [sourceOf(d, o[0].page)] }); };
  add("service_type", (v) => `visit type ${v[0]}`); add("technician", (v) => `technician ${v[0]}`); add("work_performed", (v) => `work performed: ${v.join("; ")}`); add("labor_hours", (v) => `labor ${v[0]}`);
  add("line_items", (v) => `line items: ${v.join("; ")}`); add("subtotal", (v) => `subtotal ${v[0]}`); add("tax", (v) => `tax ${v[0]}`); add("total", (v) => `total ${v[0]}`); add("notes", (v) => `notes: ${v[0]}`); add("job_status", (v) => `status ${v[0]}`); add("permit_number", (v) => `permit ${v[0]}`);
  const missing = ["technician", "work_performed", "total"].filter((id) => !g(id).length).map((id) => factById(id).label.toLowerCase());
  const who = scope.who ?? d.customer_name ?? null;
  const rec = documentRecord({ id: d.document_id, document_type: d.document_type, original_filename: d.filename }, { label: docTitle(d, bundle), sublabel: [humanDate(date), who].filter(Boolean).join(" · "), page: sources[0]?.location?.page ?? null }); if (rec) records.push(rec);
  let text = `${scope.kind === "doc" ? "" : `${order === "oldest" ? "First" : "Last"} job for ${who}: `}${docTitle(d, bundle)}${humanDate(date) ? `, ${humanDate(date)}` : ""}${scope.kind === "doc" && who ? ` (${who})` : ""} — ${bits.length ? bits.join("; ") : "nothing else is stored on it"}.${missing.length ? ` Not stored on it: ${missing.join(", ")}.` : ""}`;
  // "how much was it": the job document may be a ticket with no money; offer the newest invoice, dated, as its own record (never as the ticket's price)
  if (scope.kind !== "doc" && !g("total").length) {
    const inv = dated.find((x) => x.d.document_type === "invoice" && bundle.fin.get(x.d.document_id)?.total != null);
    if (inv) { const t = observe(factById("total"), inv.d, bundle)[0]; text += ` The newest invoice on file is ${docTitle(inv.d, bundle)}, ${humanDate(inv.date)}, total ${fmtMoney(t.value)}.`; sources.push(sourceOf(inv.d, t.page)); cards.push({ label: `Total · ${docTitle(inv.d, bundle)}`, value: fmtMoney(t.value), status: "ok", sources: [sourceOf(inv.d, t.page)] }); const r2 = documentRecord({ id: inv.d.document_id, document_type: "invoice", original_filename: inv.d.filename }, { label: docTitle(inv.d, bundle), sublabel: humanDate(inv.date), page: t.page }); if (r2) records.push(r2); }
  }
  return envelope({ text: clean(text), cards, sources, records: [customerRec, ...records].filter(Boolean), total: records.length + (customerRec ? 1 : 0), basis: `Assembled from the stored fields of ${docTitle(d, bundle)}${win ? ` (${win.label})` : ""}; each part is cited to its document and page.` });
}


/* ---------------------------------------------------------------------------------------------- stored-record fallback (late phase) */

const FALLBACK_SKIP_WORDS = /\b(?:isnt|isn t|is not|arent|not|never|no longer|except|without|other than|besides|excluding|instead of)\b/;
/** every fact that is stored on one document, in directory order (the facts a person can ask a document for; plumbing and the document's own number / customer are in its heading) */
const DOC_DUMP_SKIP = new Set(["customer_name", "invoice_number", "doc_kind", "direction", "equipment_list", "po_number", "vendor_name"]);
const CUSTOMER_DUMP = ["service_type", "work_performed", "technician", "labor_hours", "notes", "total"];

/**
 * LATE PHASE ONLY, after the older lanes declined: the question named exactly one subject (a document number, a unit serial or a customer's full name) but its wording
 * did not name a fact this lane can read. Instead of declining, show what is stored about that subject (values only from stored rows, each cited). Steps aside (null)
 * for anything that is not a single resolved subject: aggregates, time windows, negation, restricted wording, several or partial names, a number that does not exist.
 */
async function storedRecordFallback(db, question, { today, customers = null } = {}) {
  const p = parseRecordsQuestion(question, { today });
  if (p.stepAside || FALLBACK_SKIP_WORDS.test(p.text)) return null;
  if (p.window) return null;
  if (!p.docNumbers.length && /\b(?:worst|best|longest|shortest|fastest|slowest|better|worse|compar\w*|difference|rank\w*|sort\w*|trend\w*|total of|sum)\b/.test(p.text)) return null; // a ranking or comparison is not "everything on file"
  if (/\b(?:arriv\w*|what time|gate code|eta|on ?site)\b|\btech(?:nician)?s?\s+(?:phone|email|number|address|cell)\b/.test(p.text)) return null;
  if (/\b(?:staff|internal|private|confidential|secret|hidden|admin|office only|owner only)\b/.test(p.text)) return null;
  if (/\b(?:bills?|vendors?|suppliers?)\b/.test(p.text) && !p.docNumbers.length) return null;
  if (/\b(?:warranty|agreement|expire\w*|due|balance|owe\w*|paid|unpaid|overdue)\b/.test(p.text) && !p.docNumbers.length && !p.serials.length) return null; // money state / coverage across a customer's documents belongs to the older lanes
  p.serials = p.serials.filter((sn) => !p.docNumbers.some((d) => d.alnum === sn));
  const cust = customers ?? await store.loadCustomers(db);
  const codes = [...p.docNumbers];
  for (const s of p.serials) if (!codes.some((c) => c.alnum === s)) codes.push({ raw: s, alnum: s, digits: s.replace(/\D/g, ""), prefixed: true });
  const nameSkip = new Set(); p.tokens.forEach((t, i) => { if (codes.some((c) => c.alnum === alnum(t))) nameSkip.add(i); });
  const nm = matchCustomers(p.tokens, cust, nameSkip);
  if (nm.kind === "partial") return null;
  const several = nm.kind === "full" && nm.hits.length > 1;
  if (several && (codes.length || nm.hits.length > 3 || new Set(nm.hits.map((h) => h.c.id)).size !== nm.hits.length || nm.hits.some((h) => cust.filter((c) => c.name === h.c.name).length > 1))) return null;
  const named = nm.kind === "full" && !several ? nm.hits[0] : null;
  // a second person in the question: a given name, a surname or any customer's name word that is not part of the one resolved name; a capitalised word that is not a fact word; or two names joined by a conjunction
  const nameIdx = new Set(several ? nm.hits.flatMap((h) => h.idx) : named ? named.idx : []);
  const f2 = findFacts(p.tokens, { exclude: new Set([...nameIdx, ...nameSkip]) });
  const onFile = new Set(cust.flatMap((c) => nameTokens(c.name)));
  const unused = p.tokens.filter((t, i) => !nameIdx.has(i) && !nameSkip.has(i) && !f2.used[i] && /^[a-z]{3,}$/.test(t) && !STOP.has(t) && !RESIDUAL_OK.test(t) && !FILLER.test(t));
  const usedWords = new Set(p.tokens.filter((_, i) => f2.used[i] || nameIdx.has(i)));
  const rawWords = String(question ?? "").match(/[A-Za-z][A-Za-z'’-]*/g) ?? [];
  const suspects = [
    ...unused.filter((t) => onFile.has(t) || isGivenName(t) || (isRealWordOrName(t) && !isNonNameWord(t))),
    ...rawWords.slice(1).filter((w) => /^[A-Z][a-z]{2,}$/.test(w) && !usedWords.has(w.toLowerCase()) && !STOP.has(w.toLowerCase()) && !RESIDUAL_OK.test(w.toLowerCase()) && !FILLER.test(w.toLowerCase()) && ![...(several ? nm.hits : named ? [named] : [])].some((h) => nameTokens(h.c.name).includes(w.toLowerCase()))).map((w) => w.toLowerCase()),
  ];
  if ((named || several) && /\b(?:and|or|plus|both)\b|&/.test(p.text) && unused.length) return null;

  let docHits = codes.length ? await store.docsByNumber(db, codes) : [];
  const unitHits = p.serials.length ? await store.unitsBySerial(db, p.serials) : [];
  if (codes.length && !docHits.length && !unitHits.length) return null; // a number that is not on file stays an honest not-found elsewhere, never another record
  if (docHits.length) {
    const ids = [...new Set(docHits.map((d) => d.document_id))];
    if (ids.length !== 1) return null;
    const d = docHits[0];
    if (named && d.customer_id !== named.c.id) return null;
    const cr = d.customer_id ? cust.find((c) => c.id === d.customer_id) : null;
    const bundle = await store.loadBundle(db, [d.document_id]);
    // a name in the question that is a value stored on this very document (a technician being checked) is not a second customer
    const hay = bundle.facts.map((f) => String(f.value ?? "")).join(" ").toLowerCase();
    if (suspects.some((t) => onFile.has(t) && !hay.includes(t))) return null; // another customer's name word; a person's name that is not on file is just a word in the question
    return documentDump(d, bundle, cr, p);
  }
  if (suspects.length) return null;
  if (unitHits.length) {
    if (unitHits.length > 1) return null;
    const u = unitHits[0]; const c = cust.find((x) => x.id === u.customer_id);
    const docs = await store.docsForUnit(db, u.id);
    const what = clean([u.data?.manufacturer, u.data?.model, u.data?.tonnage].filter(Boolean).join(" ")) || "equipment";
    return docListDump({ docs, db, label: `unit ${u.data?.serial_number ?? ""}${c ? ` (${c.name})` : ""}`.trim(), intro: `Unit on file: ${what}${u.data?.serial_number ? `, serial ${u.data.serial_number}` : ""}.`, customer: c, unit: u });
  }
  if (named) return docListDump({ docs: await store.docsForCustomer(db, named.c.id), db, label: named.c.name, customer: named.c });
  if (several) {
    // two or three customers named: each one's stored record, separately and labelled (never merged, never one invoice line for each)
    const outs = [];
    for (const h of nm.hits) { const o = await docListDump({ docs: await store.docsForCustomer(db, h.c.id), db, label: h.c.name, customer: h.c }); if (!o?.data) return null; outs.push(o.data); }
    const merged = { ...outs[0], text: clean(`You named ${outs.length} customers, so each one is answered separately. ${outs.map((d) => d.text).join(" ")}`), facts: outs.flatMap((d) => d.facts ?? []), sources: outs.flatMap((d) => d.sources ?? []), recordsLane: true };
    return { data: attachCitations(merged, { records: outs.flatMap((d) => d.records ?? []), total: outs.reduce((a, d) => a + (d.recordsTotal ?? 0), 0), basis: "Several customers were named; each is answered separately from its own stored records." }), lane: "records", detail: "stored-record-customers" };
  }
  return null;
}

function factsOnDoc(doc, bundle, ids = null) {
  return FACTS.filter((f) => !f.hidden && !f.viewOf && (ids ? ids.includes(f.id) : !DOC_DUMP_SKIP.has(f.id) && f.belongs !== "customer") && observe(f, doc, bundle).length).map((f) => f.id);
}

function documentDump(d, bundle, customer, p) {
  const askText = p.text;
  const ids = factsOnDoc(d, bundle);
  const customerRec = customer ? customerRecord({ id: customer.id, name: customer.name, service_address: customer.address }) : null;
  const head = docHead(d, bundle);
  if (!ids.length) {
    const rec = documentRecord({ id: d.document_id, document_type: d.document_type, original_filename: d.filename }, { label: docTitle(d, bundle) });
    return { data: envelope({ text: `Here is everything on file for ${head}: nothing beyond its heading is stored on it.`, cards: [], sources: [sourceOf(d, null)], records: [customerRec, rec].filter(Boolean), basis: `Read the stored record of ${docTitle(d, bundle)}; no facts are stored on it.` }), lane: "records", detail: "stored-record-document" };
  }
  const base = answerForDocs({ docs: [d], bundle, factsWanted: ids, who: null, order: null, all: true, askText, scopeLabel: `Here is everything on file for ${head}`, customerRec });
  base.text = clean(base.text.replace(" — ", ": "));
  if (p.facts.includes("customer_name") && d.customer_name) base.text = clean(`${docTitle(d, bundle).replace(/^./, (c) => c.toUpperCase())} is for ${d.customer_name}. ${base.text}`);
  // a fact the question named that is not stored on this document is said plainly (a yes/no question gets the plain yes / no first)
  const asked = p.facts.map(factById).filter((f) => f && !f.elsewhere && f.belongs !== "customer" && !DOC_DUMP_SKIP.has(f.id));
  const absent = asked.filter((f) => !observe(f, d, bundle).length && f.id !== "labor_charge" && f.id !== "parts_charge");
  const yn = /^(?:do|does|did|is|are|was|were|has|have|had|can|could|will|would|should)\s/.test(p.text);
  if (absent.length && absent.length === asked.length && yn) base.text = clean(`No, ${absent.map((f) => f.label.toLowerCase()).join(" and ")} ${absent.length === 1 ? "is" : "are"} not stored on ${docTitle(d, bundle)}. ${base.text}`);
  else if (absent.length) base.text = clean(`${base.text} Not stored on it: ${absent.map((f) => f.label.toLowerCase()).join(", ")}.`);
  else if (yn && asked.length && EXISTENCE_ASK.test(p.text)) base.text = `Yes: ${base.text}`;
  // a labor / parts money question is never answered with the total: say whether a separate charge is stored
  for (const [word, id] of [["labor|labour", "labor_charge"], ["parts?", "parts_charge"]]) {
    if (new RegExp(`\\b(?:${word})\\b`).test(askText) && !ids.includes(id)) base.text = clean(`${base.text} ${notStoredText(factById(id), d, bundle, null)}`);
  }
  return { data: base, lane: "records", detail: "stored-record-document" };
}

async function docListDump({ docs, db, label, intro = "", customer, unit = null }) {
  const customerRec = customer ? customerRecord({ id: customer.id, name: customer.name, service_address: customer.address }) : null;
  if (!docs.length) return { data: envelope({ text: `${label} is on file, but no stored document is linked to it yet.`, cards: [], sources: [], records: [customerRec].filter(Boolean), total: 1, basis: "Checked the documents linked to this record; none." }), lane: "records", detail: "stored-record-no-documents" };
  const bundle = await store.loadBundle(db, docs.map((x) => x.document_id));
  const dated = docs.map((x) => ({ d: x, date: docDate(x, bundle) })).sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || String(b.d.created_at).localeCompare(String(a.d.created_at)));
  const withFacts = dated.map((x) => ({ ...x, ids: factsOnDoc(x.d, bundle, CUSTOMER_DUMP) })).filter((x) => x.ids.length);
  const shown = withFacts.slice(0, CAP); const more = withFacts.length - shown.length;
  const cards = [], sources = [], records = [];
  const pieces = [];
  for (const x of shown) {
    const one = answerForDocs({ docs: [x.d], bundle, factsWanted: x.ids, who: label, order: null, all: true, askText: "", scopeLabel: `${docTitle(x.d, bundle)}${humanDate(x.date) ? `, ${humanDate(x.date)}` : ""}`, customerRec: null });
    pieces.push(one.text); cards.push(...(one.facts ?? [])); sources.push(...(one.sources ?? [])); records.push(...(one.records ?? []));
  }
  const none = dated.length - withFacts.length;
  const text = clean(`Here is everything on file for ${label}:${intro ? ` ${intro}` : ""} ${plural(withFacts.length, "document")} with details, newest first. ${pieces.map((x) => x.replace(/^./, (c) => c.toUpperCase())).join(" ")}${more > 0 ? ` And ${more} more.` : ""}${!withFacts.length ? ` ${plural(dated.length, "document")} on file, none with work, technician, hours, notes or total stored.` : ""}${withFacts.length && none ? ` ${plural(none, "other document")} on file carry none of these.` : ""}`);
  return { data: envelope({ text, cards: cards.slice(0, 12), sources, records: [customerRec, ...records].filter(Boolean), total: dated.length + (customerRec ? 1 : 0), basis: `Listed the stored details of the ${plural(shown.length, "newest document")} for ${label}; each value is cited to its document and page.` }), lane: "records", detail: unit ? "stored-record-unit" : "stored-record-customer" };
}
