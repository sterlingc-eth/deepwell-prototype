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
  ["who", /\b(?:who|whose|whos|who's|customer|client|for whom|homeowner|account)\b/i],
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
  return { typed, kind, digitsOnly, focus, question: q };
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
    [documentId, ["invoice_date", "service_date", "work_performed", "technician", "service_type"]]
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
    const { rows } = await db.raw(`SELECT total, invoice_date::text AS invoice_date, customer_name, status, balance_due, amount_paid, doc_kind, direction FROM document_financials WHERE document_id = $1 AND ${TENANT_SQL} LIMIT 1`, [documentId]);
    fin = rows[0] ?? null;
  } catch { fin = null; }
  const dateRaw = fin?.invoice_date || get("invoice_date")[0] || get("service_date")[0] || null;
  return {
    customers: cust.length ? cust : (fin?.customer_name ? [{ id: null, customer_name: fin.customer_name }] : []),
    total: fin?.total != null && Number.isFinite(Number(fin.total)) ? Number(fin.total) : null,
    date: dateRaw && /^\d{4}-\d{2}-\d{2}/.test(dateRaw) ? dateRaw.slice(0, 10) : null,
    work: get("work_performed").slice(0, 3),
    technician: get("technician")[0] ?? null,
    status: fin?.status && !/^unknown$/i.test(String(fin.status)) ? String(fin.status) : null,
    docKind: fin?.doc_kind ?? null, direction: fin?.direction ?? null,
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
  const who = det.customers.map((c) => c.customer_name).filter(Boolean).join(" and ") || null;
  const when = det.date ? humanDate(det.date) : null;
  const src = [{ documentId: d.document_id, location: { field: d.field_key } }];
  if (intent.focus === "status" && !det.status) {
    // paid / open can't be told from this document: an honest "not on file", never a guess (the total is context, not the answer)
    return attachCitations(
      { kind: "no-answer", text: `${label} has no payment status on file${det.total != null ? ` (total ${money(det.total)})` : ""}${who ? ` — ${who}` : ""}.`, facts: [], sources: src, confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [] },
      { records: await documentRecordsFor(db, [d.document_id]), total: 1, kind: "searched", basis: `Read ${label}; it prints no paid / unpaid status or balance due.` }
    );
  }
  // a bare number that is also the TOTAL of invoices: say so (and honour a customer name typed in the question), never let a PO stand in for "the invoice"
  let alsoTotal = "";
  const notInvoice = tl !== "Invoice";
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
  switch (intent.focus) {
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
    ...(who ? [{ label: "Customer", value: who, sources: src }] : []),
    ...(det.total != null ? [{ label: "Total", value: money(det.total), sources: src }] : []),
    ...(when ? [{ label: "Date", value: when, sources: src }] : []),
    ...(det.work.length ? [{ label: "Work performed", value: det.work.join("; "), sources: src }] : []),
  ];
  const records = [...await documentRecordsFor(db, [d.document_id]), ...det.customers.filter((c) => c.id).map((c) => customerRecord(c))];
  return attachCitations(answerEnvelope({ text, facts, sources: src, extra: { fastIntent: "doc_number_lookup" } }), {
    records, total: records.length,
    basis: `Matched ${intent.typed} to the number printed on one ${String(d.document_type ?? "document").replace(/-/g, " ")}; read that document's own customer, date${det.total != null ? ", total" : ""} and work performed.`,
  });
}
