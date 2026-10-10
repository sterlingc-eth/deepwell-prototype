/**
 * R35 loop 2 — DOCUMENT-NUMBER LOOKUPS ARE DETERMINISTIC ("invoice INV-20003", "how much was INV-20003", "who is PO-9004 for",
 * "work order WO-40000", "permit BP-2026-10001", "invoice #20003").
 *
 * The number the user typed is matched against the numbers printed on the tenant's own documents (extractions invoice_number /
 * po_number / permit_number; case, dashes, spaces and a leading "#" ignored). One document -> its type, customer, date, total
 * (invoices) and what was done, each read per request from that document and cited. Nothing is hard-coded and nothing is guessed:
 *   - no document carries it: "No invoice INV-29999 on file." (kind no-answer, honest zero)
 *   - digits only ("invoice 20003"): matched to a stored number whose digits are exactly those, only when that is ONE number
 *   - two documents print the same number: both listed, none picked
 * Claimed only when the question names ONE document number (a prefix like INV-/WO-/PO-/BP-, or a document word right before the
 * number) and is not a count / list / money-over-time question.
 * pure: parseDocNumberQuestion     db: runDocNumberLookup
 */
import { attachCitations, customerRecord } from "../citations/records.js";
import { documentRecordsFor } from "../citations/enrich.js";
import { TENANT_SQL, humanDate, answerEnvelope } from "../scope.js";
import { nameTokens, tokenSame, withinOne } from "./nameMatch.js";

const PREFIXES = { INV: "invoice", WO: "work order", PO: "purchase order", BP: "permit", EST: "estimate", Q: "quote", TKT: "ticket" };
const WORD_KIND = [
  [/^(?:invoice|inv|bill)$/i, "invoice"], [/^(?:work\s*order|wo)$/i, "work order"], [/^(?:purchase\s*order|po|p\.o\.)$/i, "purchase order"],
  [/^(?:permit|building\s+permit)$/i, "permit"], [/^(?:estimate|est)$/i, "estimate"], [/^(?:quote)$/i, "quote"], [/^(?:ticket|service\s+ticket)$/i, "ticket"],
];
// prefixed: INV-20003, inv 20003, WO40000, PO-9004, BP-2026-10001 (2+ digits after the prefix; dash/space optional)
const PREFIXED_RE = /(?<![A-Za-z0-9])(INV|WO|PO|BP)\s?[-#]?\s?(\d{2,}(?:-\d{2,})*)(?![A-Za-z0-9])/i;
// keyword + number: "invoice #20003", "invoice number 20003", "work order 40000", "permit no. 2026-10001"
// (a number followed by a street — "invoice 100 E Main St" — is an address, never a document number)
const KEYWORD_RE = /\b(invoice|inv|work\s*order|wo|purchase\s*order|po|p\.o\.|permit|building\s+permit|estimate|quote|ticket|service\s+ticket)\s*(?:number|num|no\.?|nbr)?\s*[:#]?\s*#?\s*(\d{3,}(?:-\d{2,})*)(?![A-Za-z0-9])(?!\s+(?:[nsew]|ne|nw|se|sw|north|south|east|west)\.?\s)(?!\s+[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*)?\s+(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|way|ct|court|pl|place|cir|circle|pkwy|parkway|hwy|highway|trl|trail)\b)/i;
// questions that are about MANY documents or money over time, never one numbered document
const NOT_ONE_DOC_RE = /\b(?:how many|number of|count|total(?:s|ed)? (?:in|for|of) (?:19|20)\d\d|invoices|work orders|permits|purchase orders|tickets|since|between|average|per month|each month|year to date|ytd)\b/i;
const MONEY_RE = /\$\s?\d/;

const kindFromWord = (w) => { for (const [re, k] of WORD_KIND) if (re.test(String(w).trim())) return k; return null; };
export const canonDocNo = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const digitsOf = (s) => String(s ?? "").replace(/\D/g, "");

const FOCUS = [
  ["status", /\b(?:paid|unpaid|pay|payment|open|outstanding|overdue|past\s+due|balance|owe[ds]?|collected|status)\b/i],
  ["total", /\b(?:how much|total|amount|charge[ds]?|cost|price|billed|bill (?:for|was))\b/i],
  // "who" alone is NOT this focus: "who did that one" asks for the technician, not the customer (RECORDS-R2). Only the shapes that ask whom the document is for.
  ["who", /\b(?:whose|whos|who's|customer|client|for whom|homeowner|account|billed to|bill to|sold to)\b|\bwho\s+(?:is|was|are)\b[^?]*\bfor\b|\bwho\s+(?:is|was)\s+(?:it|that|this)\b|\bwho\s+(?:did|do)\s+(?:we|you)\s+(?:bill|invoice|charge|sell)\b/i],
  ["date", /\b(?:when|what date|date[ds]?|day)\b/i],
  ["work", /\b(?:what (?:was|is) (?:it|that|this|[a-z]{2,5}-?\d+) for|what was done|what work|work performed|what did we do|for what|description|job was)\b/i],
];

/** Pure. @returns {typed, kind, digitsOnly, focus, question} or null. */
export function parseDocNumberQuestion(question) {
  const q = String(question ?? "").replace(/[’`]/g, "'").trim();
  if (!q || q.length > 200) return null;
  if (/\bserial\b|\bs\/n\b|\bmodel\b/i.test(q)) return null;
  let typed = null; let kind = null; let digitsOnly = false;
  const pm = PREFIXED_RE.exec(q);
  if (pm) {
    typed = `${pm[1].toUpperCase()}-${pm[2]}`;
    kind = PREFIXES[pm[1].toUpperCase()] ?? "document";
  } else {
    const km = KEYWORD_RE.exec(q);
    if (!km) return null;
    const num = km[2];
    // a bare 4-digit year after the word ("invoices in 2024", "permit 2026") is a period, not a number
    if (/^(?:19|20)\d\d$/.test(num) && !/(?:number|num|no\.?|nbr|#)\s*$/i.test(q.slice(0, km.index + km[0].length - num.length))) return null;
    typed = num; kind = kindFromWord(km[1]) ?? "document"; digitsOnly = true;
  }
  if (MONEY_RE.test(q) || NOT_ONE_DOC_RE.test(q.replace(/\b(?:INV|WO|PO|BP)-?\d+/gi, " "))) return null;
  // a second, different document number makes this a comparison: not this module's
  const all = [...q.matchAll(new RegExp(PREFIXED_RE.source, "gi"))].map((m) => canonDocNo(`${m[1]}${m[2]}`));
  if (new Set(all).size > 1) return null;
  let focus = "default";
  const rest = q.replace(pm ? pm[0] : typed, " ");
  for (const [name, re] of FOCUS) if (re.test(rest)) { focus = name; break; }
  // RECORDS-R2 (cause 1): this lane answers ONE of five things (the customer, the total, the date, the payment status, the work) and says nothing else. A question that
  // carries any other meaningful word ("labor", "technician", "hours", "notes", "who did that one", "how long did it take") asks for something this lane does not read:
  // it must not answer it with the customer or the total. It steps aside (the records lane answers it from the stored row, or the question is declined).
  return { typed, kind, digitsOnly, focus, question: q, unread: unreadWords(rest) };
}

/** words this lane understands: the five FOCUS phrasings, document words, and glue. Anything else is a meaningful word nobody here read. */
const GLUE_WORDS = new Set(("a an the of for to from on at in by with and or but is are was were be been it its this that these those there here do does did done has have had can could would will should me my us our we you your i "
  + "please pls plz tell show give get find look lookup pull up open view see check what whats which when whens where wheres how about as if so then than also just only thanks thank "
  + "details detail info information summary summarize number no num nbr invoice invoices inv bill bills ticket order purchase permit estimate quote work wo po bp service building one ones doc document record "
  + "customer client name names ok okay hey hi donovan paid unpaid pay payment open outstanding overdue past due balance owe owed owes collected status total amount charge charged charges cost price billed "
  + "much date dated day homeowner account").split(/\s+/));
const GLUE_LIST = [...GLUE_WORDS];
const skeleton = (w) => w.replace(/[aeiou]/g, "");
/** a typo or a short form of a word this lane knows ("wht" = what, "tot" = total, "invoce" = invoice) is read; any other word is not */
function looksRead(w) {
  if (GLUE_WORDS.has(w)) return true;
  return GLUE_LIST.some((g) => (w.length >= 4 && g.length >= 4 && withinOne(w, g)) || (w.length >= 3 && g.length >= 5 && g.startsWith(w)) || (w.length >= 3 && g.length >= 3 && skeleton(g).length >= 3 && skeleton(g) === w));
}
export function unreadWords(rest) {
  let t = String(rest).toLowerCase().replace(/[’`]/g, "'");
  for (const [, re] of FOCUS) t = t.replace(new RegExp(re.source, "gi"), " ");
  t = t.replace(/'s\b/g, " ").replace(/'(?:d|ll|ve|re|m|t)\b/g, " ").replace(/\b(?:what|how|who|that|there|it|he|she|where|when)'?(?:s|d|ll)?\b/g, " ");
  return [...new Set((t.match(/[a-z\u00c0-\u024f]{2,}/g) ?? []).filter((w) => !looksRead(w)))];
}

/* ------------------------------------------------------------------ run */

const DOC_FIELDS = ["invoice_number", "po_number", "permit_number"];
const VAL = (a) => `COALESCE(NULLIF(${a}.corrected_value, ''), ${a}.value)`;
const CANON_SQL = (expr) => `upper(regexp_replace(${expr}, '[^A-Za-z0-9]', '', 'g'))`;

async function docsByNumber(db, intent) {
  const params = intent.digitsOnly ? [digitsOf(intent.typed), DOC_FIELDS] : [canonDocNo(intent.typed), DOC_FIELDS];
  const match = intent.digitsOnly
    ? `regexp_replace(${VAL("x")}, '\\D', '', 'g') = $1`
    : `${CANON_SQL(VAL("x"))} = $1`;
  const { rows } = await db.raw(
    `SELECT x.document_id, x.field_key, ${VAL("x")} AS number, d.document_type, d.original_filename
       FROM extractions x JOIN documents d ON d.id = x.document_id AND d.${TENANT_SQL}
      WHERE x.${TENANT_SQL} AND x.field_key = ANY($2::text[]) AND ${match}
      LIMIT 6`,
    params
  );
  return rows;
}

async function docDetails(db, documentId) {
  const { rows: f } = await db.raw(
    `SELECT field_key, ${VAL("x")} AS value FROM extractions x
      WHERE x.document_id = $1 AND x.${TENANT_SQL} AND x.field_key = ANY($2::text[])`,
    [documentId, ["invoice_date", "service_date", "work_performed", "technician", "service_type", "labor_hours", "notes"]]
  );
  const get = (k) => f.filter((r) => r.field_key === k).map((r) => String(r.value ?? "").trim()).filter(Boolean);
  const { rows: cust } = await db.raw(
    `SELECT c.id, c.data->>'customer_name' AS customer_name, c.data->>'service_address' AS service_address
       FROM document_entity_links l
       JOIN entities c ON c.id = l.entity_id AND c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL}
      WHERE l.document_id = $1 AND l.${TENANT_SQL}
      LIMIT 3`,
    [documentId]
  );
  let fin = null;
  try {
    const { rows } = await db.raw(`SELECT total, invoice_date::text AS invoice_date, customer_name, vendor_name, status, balance_due, amount_paid, doc_kind, direction FROM document_financials WHERE document_id = $1 AND ${TENANT_SQL} LIMIT 1`, [documentId]);
    fin = rows[0] ?? null;
  } catch { fin = null; }
  const dateRaw = fin?.invoice_date || get("invoice_date")[0] || get("service_date")[0] || null;
  return {
    customers: cust.length ? cust : (fin?.customer_name ? [{ id: null, customer_name: fin.customer_name }] : []),
    total: fin?.total != null && Number.isFinite(Number(fin.total)) ? Number(fin.total) : null,
    date: dateRaw && /^\d{4}-\d{2}-\d{2}/.test(dateRaw) ? dateRaw.slice(0, 10) : null,
    work: get("work_performed").slice(0, 3),
    technician: get("technician")[0] ?? null,
    hasHours: get("labor_hours").length > 0, hasNotes: get("notes").length > 0, serviceType: get("service_type")[0] ?? null,
    status: fin?.status && !/^unknown$/i.test(String(fin.status)) ? String(fin.status) : null,
    docKind: fin?.doc_kind ?? null, direction: fin?.direction ?? null, vendor: fin?.vendor_name ? String(fin.vendor_name).trim() || null : null,
    balance: fin?.balance_due != null && Number.isFinite(Number(fin.balance_due)) ? Number(fin.balance_due) : null,
  };
}

const money = (n) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const TYPE_LABEL = { invoice: "Invoice", "work-order": "Work order", "purchase-order": "Purchase order", permit: "Permit", "service-ticket": "Service ticket", "proposal-quote": "Quote" };
// a document is called what it IS: a PO is a purchase order, a credit memo a credit memo, a payable invoice a bill (never "Invoice")
function trueLabel(documentType, kindWord, det) {
  if (det.docKind === "po") return "Purchase order";
  if (det.docKind === "credit_memo") return "Credit memo";
  if (det.docKind === "invoice" && det.direction === "payable") return "Bill";
  return TYPE_LABEL[documentType] ?? cap(kindWord);
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** the customer / vendor of THIS organization whose full name the question carries and who is not one of `owners` (null when the question names nobody else) */
async function namedOtherOwner(db, question, owners) {
  const qt = nameTokens(question);
  if (!qt.length) return null;
  const has = (t) => qt.some((x) => x === t || tokenSame(x, t) === "exact");
  let names = [];
  try {
    const { rows } = await db.raw(`SELECT data->>'customer_name' AS n FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL}
      UNION SELECT value FROM extractions WHERE field_key = 'vendor_name' AND value IS NOT NULL AND ${TENANT_SQL}`, []);
    names = [...new Set(rows.map((r) => String(r.n ?? "").trim()).filter(Boolean))];
  } catch { return null; }
  const ownerToks = owners.filter(Boolean).map((o) => nameTokens(o));
  const mine = (nt) => ownerToks.some((ot) => nt.every((t) => ot.some((x) => x === t || tokenSame(x, t) === "exact")) || ot.every((t) => nt.some((x) => x === t || tokenSame(x, t) === "exact")));
  const named = names.map((n) => ({ n, nt: nameTokens(n) }))
    .filter(({ nt }) => nt.length >= 2 || (nt.length === 1 && nt[0].length >= 5 && !looksRead(nt[0])))
    .filter(({ nt }) => nt.every(has));
  if (!named.length || named.some(({ nt }) => mine(nt))) return null;
  return named.sort((a, b) => b.nt.length - a.nt.length)[0].n;
}
/** does the named party have an invoice whose total equals the typed digits ("invoice 3470 for Maria Lopez" names the amount, not a number) */
async function totalBelongsTo(db, digits, name) {
  try {
    const { rows } = await db.raw(`SELECT 1 FROM document_financials WHERE total = $1::numeric AND lower(customer_name) = lower($2) AND ${TENANT_SQL} LIMIT 1`, [Number(digits), name]);
    return rows.length > 0;
  } catch { return false; }
}

/** @returns an /api/ask data object, or null (nothing typed matches and the question was not clearly about a numbered document). */
export async function runDocNumberLookup(db, intent) {
  const rows = await docsByNumber(db, intent);
  const byDoc = new Map();
  for (const r of rows) if (!byDoc.has(r.document_id)) byDoc.set(r.document_id, r);
  let docs = [...byDoc.values()];
  // digits typed after a document word ("invoice #60005") prefer that word's own prefix when both an INV- and a WO- number share the digits
  const KIND_PREFIX = { invoice: "INV", "work order": "WO", "purchase order": "PO", permit: "BP" };
  if (intent.digitsOnly && KIND_PREFIX[intent.kind]) {
    const own = docs.filter((d) => canonDocNo(d.number).startsWith(KIND_PREFIX[intent.kind]));
    if (own.length && new Set(own.map((d) => canonDocNo(d.number))).size === 1) docs = own;
  }
  // digits only: several DIFFERENT stored numbers share those digits -> never pick one
  const distinctNumbers = new Set(docs.map((d) => canonDocNo(d.number)));
  const shownTyped = intent.digitsOnly ? `${intent.kind} ${intent.typed}` : `${intent.kind} ${intent.typed.toUpperCase()}`;
  if (!docs.length) {
    return attachCitations(
      { kind: "no-answer", text: `No ${shownTyped} on file.`, facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [] },
      { records: [], total: 0, kind: "searched", basis: `Searched the invoice, work-order, PO and permit numbers printed on every document for ${intent.typed} (ignoring case, dashes and spaces); none matches.` }
    );
  }
  if (docs.length > 1 && distinctNumbers.size > 1) {
    const list = docs.map((d) => `${TYPE_LABEL[d.document_type] ?? "Document"} ${d.number}`).join(", ");
    return attachCitations(
      { kind: "no-answer", text: `More than one document number on file has those digits: ${list}. Which one?`, facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [] },
      { records: [], total: 0, kind: "searched", basis: `Matched the digits ${intent.typed} to ${docs.length} different document numbers; none is picked.` }
    );
  }
  if (docs.length > 1) {
    const list = docs.map((d) => `${TYPE_LABEL[d.document_type] ?? "Document"} ${d.number} (${d.original_filename ?? "document"})`).join("; ");
    const text = `${docs.length} documents on file print ${docs[0].number}: ${list}.`;
    return attachCitations(answerEnvelope({ text, facts: docs.map((d, i) => ({ label: `Document ${i + 1}`, value: `${TYPE_LABEL[d.document_type] ?? "Document"} ${d.number}`, sources: [{ documentId: d.document_id, location: { field: d.field_key } }] })) }),
      { records: await documentRecordsFor(db, docs.map((d) => d.document_id)), total: docs.length, basis: `Matched ${intent.typed} to the number printed on ${docs.length} documents; all are listed.` });
  }
  const d = docs[0];
  const det = await docDetails(db, d.document_id);
  const tl = trueLabel(d.document_type, intent.kind, det);
  const label = `${tl} ${d.number}`;
  // a payable bill is FROM a vendor: that vendor is who billed us (the stored customer_name on a bill is the bill-to, not the biller)
  const isBill = tl === "Bill" && !!det.vendor;
  const askedVendor = isBill && /\b(?:who|which vendor|what vendor|vendor|supplier|company)\b/i.test(intent.question) && !/\b(?:how much|total|amount|when|date)\b/i.test(intent.question);
  const who = isBill ? `${det.vendor} (vendor)` : det.customers.map((c) => c.customer_name).filter(Boolean).join(" and ") || null;
  const when = det.date ? humanDate(det.date) : null;
  const src = [{ documentId: d.document_id, location: { field: d.field_key } }];
  // R5: a document number given together with ANOTHER customer's (or vendor's) name is a contradiction, not a lookup: say whose document it is and answer nothing as if it were theirs.
  const wrongOwner = await namedOtherOwner(db, intent.question, [...det.customers.map((c) => c.customer_name), det.vendor]);
  if (wrongOwner && !(intent.digitsOnly && /^\d{3,}$/.test(intent.typed) && (await totalBelongsTo(db, intent.typed, wrongOwner)))) {
    const records = [...await documentRecordsFor(db, [d.document_id]), ...det.customers.filter((c) => c.id).map((c) => customerRecord(c))];
    return attachCitations(
      { kind: "no-answer", text: `${label} is on file for ${who ?? det.vendor ?? "someone else"}, not ${wrongOwner}, so I have not answered for ${wrongOwner}. Ask about ${d.number} on its own, or ask for ${wrongOwner}'s own invoices.`, facts: [], sources: src, confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [] },
      { records, total: records.length, kind: "searched", basis: `Matched ${intent.typed} to one document; its customer is ${who ?? det.vendor ?? "a different party"}, which is not the party the question names.` }
    );
  }
  if (intent.focus === "status" && !det.status) {
    // paid / open can't be told from this document: an honest "not on file", never a guess (the total is context, not the answer)
    return attachCitations(
      { kind: "no-answer", text: `${label} has no payment status on file${det.total != null ? ` (total ${money(det.total)})` : ""}${who ? ` — ${who}` : ""}.`, facts: [], sources: src, confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [] },
      { records: await documentRecordsFor(db, [d.document_id]), total: 1, kind: "searched", basis: `Read ${label}; it prints no paid / unpaid status or balance due.` }
    );
  }
  // RECORDS-R2 cause 1: words nobody here read (after removing the customer / vendor names the question may carry): this lane does not answer a different question
  // with the customer or the total. It says plainly that it has no such thing stored for this document, and what IS stored on it.
  if (intent.unread?.length) {
    let rest = intent.unread;
    try {
      const { rows: nm } = await db.raw(`SELECT data->>'customer_name' AS n FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL}
        UNION SELECT value FROM extractions WHERE field_key = 'vendor_name' AND value IS NOT NULL AND ${TENANT_SQL}`, []);
      const known = [...new Set(nm.flatMap((r) => nameTokens(r.n)))];
      rest = rest.filter((w) => !known.some((k) => w === k || tokenSame(w, k) === "exact" || (w.length >= 4 && k.length >= 4 && tokenSame(w, k) === "typo")));
    } catch { /* keep the unread words */ }
    if (rest.length) {
      const have = [who ? "customer" : null, when ? "date" : null, det.total != null ? "total" : null, det.work.length ? "work performed" : null, det.technician ? "technician" : null, det.hasHours ? "labor hours" : null, det.hasNotes ? "notes" : null, det.status ? "payment status" : null].filter(Boolean);
      return attachCitations(
        { kind: "no-answer", text: `I don't have that stored for ${label}${who ? ` (${who})` : ""}: I couldn't match ${rest.slice(0, 4).map((w) => `"${w}"`).join(", ")} to anything on its record.${have.length ? ` What is on file for it: ${have.join(", ")}.` : ""}`, facts: [], sources: src, confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [] },
        { records: await documentRecordsFor(db, [d.document_id]), total: 1, kind: "searched", basis: `Read ${label}; the question asks for something that is not one of its stored facts, so nothing was answered in its place.` }
      );
    }
  }
  // a bare number that is also the TOTAL of invoices: say so (and honour a customer name typed in the question), never let a PO stand in for "the invoice"
  let alsoTotal = "";
  const notInvoice = tl !== "Invoice" && tl !== "Bill";
  if (intent.digitsOnly && /^\d{3,}$/.test(intent.typed) && ["invoice", "bill", "document"].includes(intent.kind)) {
    try {
      const { rows } = await db.raw(
        `SELECT document_id, customer_name, total, invoice_date::text AS invoice_date FROM document_financials
          WHERE doc_kind = 'invoice' AND direction = 'receivable' AND total = $1::numeric AND document_id <> $2 AND ${TENANT_SQL} ORDER BY invoice_date, document_id LIMIT 8`,
        [Number(intent.typed), d.document_id]
      );
      const lowQ = intent.question.toLowerCase();
      const named = rows.filter((r) => r.customer_name && lowQ.includes(String(r.customer_name).toLowerCase()));
      const use = named.length ? named : rows;
      if (use.length) {
        const list = use.slice(0, 5).map((r) => `${r.customer_name ?? "unnamed"} (${r.invoice_date ? humanDate(r.invoice_date.slice(0, 10)) : "undated"})`).join(", ");
        alsoTotal = ` ${use.length === 1 ? "One invoice has" : `${use.length} invoices have`} a total of ${money(Number(intent.typed))}: ${list}. Which did you mean?`;
      }
    } catch { alsoTotal = ""; }
  }
  if (notInvoice && ["invoice", "bill"].includes(intent.kind)) alsoTotal = ` It is not an invoice.${alsoTotal}`;
  let text;
  if (askedVendor) text = `${label} is from ${det.vendor}${when ? ` (${when})` : ""}${det.total != null ? `, ${money(det.total)}` : ""}.`;
  else switch (intent.focus) {
    case "status":
      text = det.status
        ? `${label} is marked ${det.status.replace(/_/g, " ")}${det.balance != null ? ` (balance ${money(det.balance)})` : ""}${who ? ` — ${who}` : ""}.`
        : `${label} has no payment status on file${det.total != null ? ` (total ${money(det.total)})` : ""}${who ? ` — ${who}` : ""}.`;
      break;
    case "total":
      text = det.total != null ? `${label} was ${money(det.total)}${who ? ` (${who})` : ""}.` : `${label} has no total printed${who ? ` (${who})` : ""}.`;
      break;
    case "who": text = who ? `${label} is for ${who}${when ? ` (${when})` : ""}.` : `${label} has no customer linked to it.`; break;
    case "date": text = when ? `${label} is dated ${when}${who ? ` (${who})` : ""}.` : `${label} has no date printed${who ? ` (${who})` : ""}.`; break;
    case "work": text = det.work.length ? `${label}${who ? ` (${who}${when ? `, ${when}` : ""})` : ""}: ${det.work.join("; ")}.` : `${label}${who ? ` (${who})` : ""} has no work description printed.`; break;
    default:
      text = `${label}: ${[who, det.total != null ? money(det.total) : null, when].filter(Boolean).join(", ") || "on file"}.`;
  }
  text += alsoTotal;
  const facts = [
    { label: "Document", value: label, sources: src },
    ...(who ? [{ label: isBill ? "Vendor" : "Customer", value: isBill ? det.vendor : who, sources: src }] : []),
    ...(det.total != null ? [{ label: "Total", value: money(det.total), sources: src }] : []),
    ...(when ? [{ label: "Date", value: when, sources: src }] : []),
    ...(det.work.length ? [{ label: "Work performed", value: det.work.join("; "), sources: src }] : []),
  ];
  const records = [...await documentRecordsFor(db, [d.document_id]), ...(isBill ? [] : det.customers).filter((c) => c.id).map((c) => customerRecord(c))];
  return attachCitations(answerEnvelope({ text, facts, sources: src, extra: { fastIntent: "doc_number_lookup" } }), {
    records, total: records.length,
    basis: `Matched ${intent.typed} to the number printed on one ${String(d.document_type ?? "document").replace(/-/g, " ")}; read that document's own customer, date${det.total != null ? ", total" : ""} and work performed.`,
  });
}
