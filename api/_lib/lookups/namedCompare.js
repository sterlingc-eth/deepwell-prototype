/**
 * R32b (loop B) — NAMED-PAIR comparisons ("has Rebecca Montoya had more documents on file than Charles Montoya", "who has more files, A or B",
 * "have we bought more from Baker Distributing or Watsco Supply, by PO count", "do we do more repair work or more preventive maintenance").
 * comparison.js handled only whole-kind sides (doc types, brands, cities); every named side fell through to a model (or, worse, to a count of the
 * wrong thing: "Yes, you have 35 customers"). Same contract as comparison.js: count each side separately, say which is bigger with BOTH numbers,
 * cite the counted records, and return null (carry on down the chain) whenever a side does not resolve to exactly one customer / vendor.
 *
 *   parseNamedCompare(q)          pure: lowercase question -> { kind, form, direction, noun, a, b } | null
 *   runNamedCompare(db, intent)   db: answer | null
 *
 * Count definitions (stated in every answer): documents / files / paperwork / jobs = distinct documents linked to the customer (jobs follow the exam's
 * convention for a customer: a job is a document on file); invoices = linked documents whose type is invoice; units = equipment entities;
 * purchase orders = documents of type purchase order by vendor name; service types = documents whose service type is that value.
 */
import { unframe } from "./unframe.js";
import { attachCitations, customerRecord, documentRecord } from "../citations/records.js";
import { answerEnvelope, TENANT_SQL, typeSql, docTypeAliases } from "../scope.js";

const NOUN_RE = String.raw`(documents?|docs?|files?|paperwork|jobs?|work|invoices?|bills?|units?|equipment|systems?|visits?|calls?|tickets?)`;
const NOUN_KEY = (w) => (/^invoice|^bill/.test(w) ? "invoices" : /^unit|^equip|^system/.test(w) ? "units" : /^visit|^call|^ticket/.test(w) ? "visits" : "documents");
const MORE_RE = String.raw`(more|fewer|less)`;
const NAME = String.raw`([a-z][a-z'’.&-]*(?:\s+[a-z][a-z'’.&-]*){0,4}?)`;
const ON_FILE = String.raw`(?:\s+(?:on\s+file|in\s+our\s+records|on\s+record|in\s+the\s+system))?`;
const mkRe = (s) => new RegExp(s, "i");

const NAMED_SHAPES = [
  // yes/no: "has A had more documents on file than B", "does A have fewer jobs than B", "have we got more paperwork on A than on B"
  { form: "yesno", re: mkRe(String.raw`^(?:has|have|does|do|did)\s+${NAME}\s+(?:had|have|got|has|done|logged|worked|been\s+out\s+on|run|been\s+on)\s+${MORE_RE}\s+${NOUN_RE}${ON_FILE}\s+than\s+(?:on\s+|for\s+)?${NAME}$`), map: [1, 2, 3, 4] },
  { form: "yesno", re: mkRe(String.raw`^(?:have|do|did)\s+we\s+(?:got|have|had)\s+${MORE_RE}\s+${NOUN_RE}${ON_FILE}\s+(?:on|for)\s+${NAME}\s+than\s+(?:on\s+|for\s+)?${NAME}$`), map: [3, 1, 2, 4], swap: true },
  // which: "who has more files, A or B", "which customer has more jobs: A or B", "does A or B have more documents", "between A and B, who has more files"
  { form: "which", re: mkRe(String.raw`^(?:who|which\s+(?:customer|one|account|client|tech|technician))\s+(?:has|have|had)(?:\s+(?:done|logged|worked|run))?\s+${MORE_RE}\s+${NOUN_RE}${ON_FILE}[,:]?\s*(?:between\s+)?${NAME}\s+(?:or|vs\.?|versus)\s+${NAME}$`), map: [2, 3, 1, 4], swap: true },
  { form: "which", re: mkRe(String.raw`^(?:does|do|did)\s+${NAME}\s+or\s+${NAME}\s+(?:have|has|had)\s+${MORE_RE}\s+${NOUN_RE}${ON_FILE}$`), map: [3, 4, 1, 2] },
  { form: "which", re: mkRe(String.raw`^between\s+${NAME}\s+and\s+${NAME}[,:]?\s*(?:who|which(?:\s+one)?)\s+(?:has|have|had)\s+${MORE_RE}\s+${NOUN_RE}${ON_FILE}$`), map: [3, 4, 1, 2] },
  // technicians: "is A ahead of B", "is A behind B on job count", "which is busier, A or B"
  { form: "yesno", re: mkRe(String.raw`^(?:is|are)\s+${NAME}\s+(ahead\s+of|behind)\s+${NAME}(?:\s+(?:in|on)\s+(?:job|visit|call)s?(?:\s+count)?)?$`), map: [1, 2, 3, 4] },
  { form: "which", re: mkRe(String.raw`^which\s+is\s+(busier|more\s+busy)[,:]?\s*${NAME}\s+(?:or|vs\.?|versus)\s+${NAME}$`), map: [2, 3, 1, 4] },
];
// map = [indexOf more/fewer, indexOf noun, indexOf A, indexOf B] expressed through capture positions; resolved below by shape order
const SHAPE_GROUPS = [
  (m) => ({ a: m[1], dir: m[2], noun: m[3], b: m[4] }),
  (m) => ({ dir: m[1], noun: m[2], a: m[3], b: m[4] }),
  (m) => ({ dir: m[1], noun: m[2], a: m[3], b: m[4] }),
  (m) => ({ a: m[1], b: m[2], dir: m[3], noun: m[4] }),
  (m) => ({ a: m[1], b: m[2], dir: m[3], noun: m[4] }),
  (m) => ({ a: m[1], b: m[3], dir: /^ahead/.test(m[2]) ? "more" : "fewer", noun: "jobs", tech: true }),
  (m) => ({ a: m[2], b: m[3], dir: "more", noun: "jobs", tech: true }),
];

// vendors / purchase orders
const VENDOR_SHAPES = [
  mkRe(String.raw`^(?:have|did|do)\s+we\s+(?:bought|buy|order|ordered|purchase|purchased|placed\s+more\s+orders)\s+${MORE_RE}\s+from\s+${NAME}\s+or\s+(?:from\s+)?${NAME}(?:[,\s]+(?:by|in\s+terms\s+of)\s+(?:po|pos|purchase\s+order)s?(?:\s+count)?)?$`),
  mkRe(String.raw`^(?:do|have)\s+we\s+(?:order|ordered|buy|bought)\s+${MORE_RE}\s+from\s+${NAME}\s+or\s+(?:from\s+)?${NAME}(?:[,\s]+by\s+(?:po|pos|purchase\s+order)s?(?:\s+count)?)?$`),
  mkRe(String.raw`^which\s+vendor\s+do\s+we\s+have\s+${MORE_RE}\s+(?:pos|purchase\s+orders)\s+with[,:]?\s*${NAME}\s+or\s+${NAME}$`),
  mkRe(String.raw`^${MORE_RE}\s+(?:pos|purchase\s+orders)\s+(?:with|from)\s+${NAME}\s+(?:than|or|vs\.?|versus)\s+(?:with\s+|from\s+)?${NAME}$`),
];

const SERVICE_TYPES = [
  { key: "Repair", re: /^(?:repairs?|repair\s+(?:work|jobs?|calls?|visits?|tickets?))$/ },
  { key: "Preventive Maintenance", re: /^(?:preventive\s+maintenance(?:\s+(?:work|jobs?|calls?|visits?|tickets?))?|pm(?:\s+(?:work|jobs?|calls?|visits?|tickets?))?|preventative\s+maintenance(?:\s+(?:work|jobs?|calls?|visits?))?|maintenance\s+(?:work|jobs?|calls?|visits?)|tune-?ups?)$/ },
];
export const serviceType = (phrase) => SERVICE_TYPES.find((t) => t.re.test(String(phrase ?? "").trim().replace(/^(?:more\s+)?/, "")))?.key ?? null;
const STYPE_SIDE = String.raw`((?:preventive|preventative)\s+maintenance(?:\s+\w+)?|maintenance\s+\w+|pm(?:\s+\w+)?|repairs?(?:\s+\w+)?|tune-?ups?)`;
const STYPE_SHAPES = [
  // "do we do more repair work or more preventive maintenance", "are there more repair calls than preventive maintenance visits", "have we done more PM visits than repair jobs"
  { form: "choose", re: mkRe(String.raw`^(?:do|does|did|have|are|is)\s+(?:we\s+(?:do|done|get|got|have)\s+|there\s+)?${MORE_RE}\s+${STYPE_SIDE}\s+(?:or|than|vs\.?|versus)\s+(?:more\s+)?${STYPE_SIDE}(?:[,\s]+by\s+(?:volume|count))?$`) },
  { form: "choose", re: mkRe(String.raw`^(?:are|is)\s+${STYPE_SIDE}\s+or\s+${STYPE_SIDE}\s+${MORE_RE}\s+common(?:\s+for\s+us)?(?:[,\s]+by\s+(?:volume|count))?$`), tail: true },
  { form: "choose", re: mkRe(String.raw`^which\s+is\s+(?:bigger|larger|more\s+common)(?:\s+for\s+us)?[,:]?\s*${STYPE_SIDE}\s+or\s+${STYPE_SIDE}(?:[,\s]+by\s+(?:volume|count))?$`), bigger: true },
];

const clean = (s) => String(s ?? "").replace(/\s+/g, " ").replace(/[?.!]+$/, "").trim();
const stripName = (s) => clean(s).replace(/^(?:the|our|customer|client)\s+/, "").replace(/['’]s$/, "");

/** Pure. */
export function parseNamedCompare(question) {
  const q = clean(unframe(question).toLowerCase());
  if (!q || q.length > 200 || !/\b(?:more|fewer|less|between|bigger|larger|ahead|behind|busier)\b/.test(q)) return null;
  for (let i = 0; i < VENDOR_SHAPES.length; i++) {
    const m = VENDOR_SHAPES[i].exec(q);
    if (!m) continue;
    const a = stripName(m[2]); const b = stripName(m[3]);
    if (!a || !b || a === b) return null;
    return { kind: "vendor", form: /^which/.test(q) || / or /.test(q) ? "which" : "yesno", direction: m[1] === "more" ? "more" : "fewer", noun: "purchase orders", a: { phrase: a }, b: { phrase: b } };
  }
  for (const sh of STYPE_SHAPES) {
    const m = sh.re.exec(q);
    if (!m) continue;
    const dir = sh.bigger ? "more" : sh.tail ? m[3] : m[1];
    const a = serviceType(sh.tail || sh.bigger ? m[1] : m[2]); const b = serviceType(sh.tail || sh.bigger ? m[2] : m[3]);
    if (!a || !b || a === b) return null;
    const yn = /\bthan\b/.test(q);
    return { kind: "servicetype", form: yn ? "yesno" : "choose", direction: /^(?:more|fewer|less)$/.test(dir) ? (dir === "more" ? "more" : "fewer") : "more", noun: "service visits", a: { key: a, label: a }, b: { key: b, label: b } };
  }
  for (let i = 0; i < NAMED_SHAPES.length; i++) {
    const m = NAMED_SHAPES[i].re.exec(q);
    if (!m) continue;
    const g = SHAPE_GROUPS[i](m);
    const a = stripName(g.a); const b = stripName(g.b);
    if (!a || !b || a === b || a.split(" ").length > 4 || b.split(" ").length > 4) return null;
    // the entities must look like names/businesses, never a document-kind word ("more invoices than documents")
    if (/^(?:invoices?|documents?|jobs?|files?|customers?|units?|tickets?|quotes?|permits?)$/.test(a) || /^(?:invoices?|documents?|jobs?|files?|customers?|units?|tickets?|quotes?|permits?)$/.test(b)) return null;
    return { kind: "named", form: NAMED_SHAPES[i].form, direction: g.dir === "more" ? "more" : "fewer", noun: NOUN_KEY(g.noun), nounWord: g.noun, techOnly: Boolean(g.tech), a: { phrase: a }, b: { phrase: b } };
  }
  return null;
}

const titleCase = (s) => String(s).replace(/\b([a-z])/g, (c) => c.toUpperCase());

async function resolveCustomer(db, phrase) {
  const { rows } = await db.raw(
    `SELECT id, data->>'customer_name' AS name, data->>'service_address' AS address FROM entities
      WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL} AND lower(data->>'customer_name') = lower($1) LIMIT 3`, [phrase]);
  if (rows.length === 1) return rows[0];
  if (rows.length > 1) return null; // two customers share that exact name: never pick
  const like = await db.raw(
    `SELECT id, data->>'customer_name' AS name, data->>'service_address' AS address FROM entities
      WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL} AND data->>'customer_name' ILIKE $1 LIMIT 3`, [`%${String(phrase).replace(/[%_\\]/g, " ")}%`]);
  return like.rows.length === 1 ? like.rows[0] : null;
}

async function customerSide(db, noun, c) {
  if (noun === "units") {
    const { rows } = await db.raw(`SELECT id, data->>'manufacturer' AS m, data->>'model' AS model, data->>'equipment_type' AS et FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL AND customer_id = $1 AND ${TENANT_SQL} LIMIT 200`, [c.id]);
    return { n: rows.length, docs: [] };
  }
  const typeFilter = noun === "invoices" ? `AND ${typeSql("d.document_type")} = ANY($2::text[])` : "";
  const params = noun === "invoices" ? [c.id, docTypeAliases("invoice")] : [c.id];
  const { rows } = await db.raw(
    `SELECT DISTINCT d.id, d.document_type, d.original_filename, d.created_at FROM document_entity_links l JOIN documents d ON d.id = l.document_id AND d.${TENANT_SQL}
      WHERE l.entity_id = $1 AND l.${TENANT_SQL} ${typeFilter} ORDER BY d.created_at DESC`, params);
  return { n: rows.length, docs: rows };
}

const plural = (n, w) => `${n} ${n === 1 ? w : w === "documents" ? "documents" : w}`;

function verdict({ form, direction }, na, nb, nameA, nameB, nounLabel, basisNote) {
  const aWins = direction === "more" ? na > nb : na < nb;
  const bWins = direction === "more" ? nb > na : nb < na;
  const nums = `${nameA} has ${na} ${nounLabel}, ${nameB} has ${nb}`;
  if (na === nb) return { text: form === "yesno" ? `No — they're tied: ${nums}. ${basisNote}` : `They're tied: ${nums}. ${basisNote}`, tie: true };
  if (form === "yesno") return { text: `${aWins ? "Yes" : "No"} — ${nums}. ${basisNote}` };
  const winner = aWins ? nameA : nameB;
  return { text: `${winner} has ${direction === "more" ? "more" : "fewer"} ${nounLabel}: ${nameA} ${na}, ${nameB} ${nb}. ${basisNote}` };
}

/** @returns the answer or null (a side did not resolve to exactly one customer / vendor / service type). */
export async function runNamedCompare(db, intent) {
  if (intent.kind === "servicetype") {
    const side = async (v) => (await db.raw(
      `SELECT DISTINCT d.id, d.document_type, d.original_filename, d.created_at FROM documents d JOIN extractions x ON x.document_id = d.id AND x.field_key = 'service_type' AND x.value = $1
        WHERE d.${TENANT_SQL} ORDER BY d.created_at DESC`, [v])).rows;
    const [da, dbb] = [await side(intent.a.key), await side(intent.b.key)];
    const [na, nb] = [da.length, dbb.length];
    if (!na && !nb) return null;
    const label = (k) => (k === "Repair" ? "repair" : "preventive maintenance");
    const note = "Counted by the service type printed on each visit's document, across all dates.";
    const v = verdict({ form: intent.form === "yesno" ? "yesno" : "which", direction: intent.direction }, na, nb, titleCase(label(intent.a.key)), titleCase(label(intent.b.key)), "visits", note);
    // yes/no keeps the long-standing "Yes, you have 85 Repair visits and 35 Preventive Maintenance visits." wording (same numbers, same verdict)
    const text = intent.form === "yesno" && !v.tie
      ? `${v.text.startsWith("Yes") ? "Yes" : "No"}, you have ${na} ${titleCase(label(intent.a.key))} visits and ${nb} ${titleCase(label(intent.b.key))} visits. ${note}`
      : v.text;
    return attachCitations(answerEnvelope({ text, facts: [{ label: titleCase(label(intent.a.key)), value: String(na), sources: [] }, { label: titleCase(label(intent.b.key)), value: String(nb), sources: [] }], extra: { comparison: true } }),
      { records: [...da.map((r) => documentRecord(r, { group: titleCase(label(intent.a.key)) })), ...dbb.map((r) => documentRecord(r, { group: titleCase(label(intent.b.key)) }))], total: na + nb, claimedCount: na + nb, kind: "searched", basis: `Counted ${na} ${label(intent.a.key)} and ${nb} ${label(intent.b.key)} visits by service type; every counted record is listed.` });
  }
  if (intent.kind === "vendor") {
    const { rows: vendors } = await db.raw(`SELECT DISTINCT value AS v FROM extractions WHERE field_key = 'vendor_name' AND value IS NOT NULL AND ${TENANT_SQL}`, []);
    const find = (phrase) => { const hit = vendors.filter((r) => String(r.v).toLowerCase() === phrase || String(r.v).toLowerCase().startsWith(phrase)); return hit.length === 1 ? hit[0].v : null; };
    const va = find(intent.a.phrase); const vb = find(intent.b.phrase);
    if (!va || !vb || va === vb) return null;
    const side = async (v) => (await db.raw(
      `SELECT d.id, d.document_type, d.original_filename, d.created_at FROM documents d JOIN extractions x ON x.document_id = d.id AND x.field_key = 'vendor_name' AND x.value = $1
        WHERE ${typeSql("d.document_type")} = ANY($2::text[]) AND d.${TENANT_SQL} ORDER BY d.created_at DESC`, [v, docTypeAliases("purchase-order")])).rows;
    const [da, db2] = [await side(va), await side(vb)];
    const v = verdict(intent, da.length, db2.length, va, vb, "purchase orders", "Counted the purchase orders on file by vendor name.");
    return attachCitations(answerEnvelope({ text: v.text, facts: [{ label: va, value: String(da.length), sources: [] }, { label: vb, value: String(db2.length), sources: [] }], extra: { comparison: true } }),
      { records: [...da.map((r) => documentRecord(r, { group: va })), ...db2.map((r) => documentRecord(r, { group: vb }))], total: da.length + db2.length, claimedCount: da.length + db2.length, basis: `Counted ${va} (${da.length}) and ${vb} (${db2.length}) purchase orders; every counted record is listed.` });
  }
  // named customers (technicians when the shape is technician-only, or when the names are not both customers)
  const [ca, cb] = intent.techOnly ? [null, null] : [await resolveCustomer(db, intent.a.phrase), await resolveCustomer(db, intent.b.phrase)];
  if ((!ca || !cb) && intent.noun !== "invoices" && intent.noun !== "units") {
    const tech = await runTechCompare(db, intent);
    if (tech) return tech;
  }
  if (intent.noun === "visits" || intent.techOnly) return null; // "visits"/"ahead of" are technician words; never read as a customer's document count
  if (!ca || !cb || ca.id === cb.id) return null;
  const [sa, sb] = [await customerSide(db, intent.noun, ca), await customerSide(db, intent.noun, cb)];
  const nounLabel = intent.noun === "invoices" ? "invoices" : intent.noun === "units" ? "units" : "documents";
  const note = intent.noun === "documents"
    ? `Counted the distinct documents linked to each customer${/job|work/.test(intent.nounWord) ? " (a job is a document on file)" : ""}.`
    : intent.noun === "invoices" ? "Counted the invoices linked to each customer." : "Counted the equipment units on each customer's file.";
  const v = verdict(intent, sa.n, sb.n, ca.name, cb.name, nounLabel, note);
  const records = [customerRecord({ id: ca.id, customer_name: ca.name, service_address: ca.address }, { group: ca.name }), customerRecord({ id: cb.id, customer_name: cb.name, service_address: cb.address }, { group: cb.name }),
    ...sa.docs.slice(0, 80).map((r) => documentRecord(r, { group: ca.name })), ...sb.docs.slice(0, 80).map((r) => documentRecord(r, { group: cb.name }))];
  return attachCitations(answerEnvelope({ text: v.text, facts: [{ label: ca.name, value: String(sa.n), sources: [] }, { label: cb.name, value: String(sb.n), sources: [] }], extra: { comparison: true } }),
    { records, total: records.length, basis: `Counted ${nounLabel} for ${ca.name} (${sa.n}) and ${cb.name} (${sb.n}); the customers and the counted records are listed.`, kind: "searched" });
}

/* ------------------------------------------------------------------ per-customer COUNTS ("how many documents does X have", "document count for X") */
import { docTypeFromWord, documentTypeLabel, docTypeSynonymAlternation } from "../documentTypes.js";

const GENERIC_NOUN = /^(?:documents?|docs?|files?|paperwork|jobs?)$/;
const TYPED_NOUN = docTypeSynonymAlternation();
const COUNT_NOUN = String.raw`(documents?|docs?|files?|paperwork|jobs?|${TYPED_NOUN})`;
const COUNT_NAME = String.raw`([a-z][a-z'’.&-]*(?:\s+[a-z][a-z'’.&-]*){0,4}?)`;
const COUNT_AUX = String.raw`(?:do\s+we\s+have|have\s+we\s+(?:done|got|had|on\s+file)|are\s+there|we\s+(?:have|did)|did\s+we\s+do|do\s+we\s+have\s+on\s+file)`;
const COUNT_SHAPES = [
  mkRe(String.raw`^(?:how\s+many|number\s+of|count\s+of|total)\s+${COUNT_NOUN}(?:\s+${COUNT_AUX})?(?:\s+on\s+file)?\s+(?:for|on|with|from|at)\s+(?:the\s+)?${COUNT_NAME}$`),
  mkRe(String.raw`^how\s+many\s+${COUNT_NOUN}\s+(?:does|did|has|have)\s+(?:the\s+)?${COUNT_NAME}\s+(?:have|had|got)(?:\s+on\s+file)?$`),
  mkRe(String.raw`^${COUNT_NOUN}\s+count\s+(?:for|on)\s+(?:the\s+)?${COUNT_NAME}$`),
  mkRe(String.raw`^how\s+many\s+${COUNT_NOUN}\s+${COUNT_AUX}\s+(?:for|on)\s+(?:the\s+)?${COUNT_NAME}$`),
];

/** Pure: "how many documents does X have" -> { noun, typeId|null, phrase } (typed nouns except invoices, which the money route owns). */
export function parseCustomerCount(question) {
  const q = clean(unframe(question).toLowerCase());
  if (!q || q.length > 160) return null;
  for (const re of COUNT_SHAPES) {
    const m = re.exec(q);
    if (!m) continue;
    const noun = m[1].replace(/\s+/g, " ");
    const phrase = stripName(m[2]);
    if (!phrase || /^(?:us|me|file|record|records|all|everyone|each|the|this|last|year|month|week|today)$/.test(phrase) || phrase.split(" ").length > 4) return null;
    if (/\b(?:last|this|past|since|before|after|during|ago|year|month|week|quarter|today|yesterday)\b/.test(phrase)) return null;
    if (GENERIC_NOUN.test(noun)) return { noun, typeId: null, phrase };
    const typeId = docTypeFromWord(noun) ?? docTypeFromWord(noun.replace(/s$/, ""));
    if (!typeId || (typeId === "invoice" && !/^(?:number|count)\s+of\b/.test(q))) return null; // "how many invoices ..." is the money route's (customer-scoped since R32b)
    return { noun, typeId, phrase };
  }
  return null;
}

/** @returns the answer, or null when the name does not resolve to exactly one customer. */
export async function runCustomerCount(db, intent) {
  const c = await resolveCustomer(db, intent.phrase);
  if (!c && intent.typeId === "purchase-order") return runVendorPoCount(db, intent);
  if (!c) return null;
  const typeFilter = intent.typeId ? `AND ${typeSql("d.document_type")} = ANY($2::text[])` : "";
  const params = intent.typeId ? [c.id, docTypeAliases(intent.typeId)] : [c.id];
  const { rows } = await db.raw(
    `SELECT DISTINCT d.id, d.document_type, d.original_filename, d.created_at FROM document_entity_links l JOIN documents d ON d.id = l.document_id AND d.${TENANT_SQL}
      WHERE l.entity_id = $1 AND l.${TENANT_SQL} ${typeFilter} ORDER BY d.created_at DESC`, params);
  const label = intent.typeId ? documentTypeLabel(intent.typeId).toLowerCase() : "document";
  const lab = (n) => `${label}${n === 1 ? "" : label.endsWith("s") ? "" : "s"}`;
  const jobNote = /^jobs?$/.test(intent.noun) ? " (a job is a document on file)" : "";
  const text = rows.length
    ? `${c.name} has ${rows.length} ${lab(rows.length)} on file${jobNote}.`
    : `No ${lab(2)} are on file for ${c.name}.`;
  return attachCitations(
    answerEnvelope({ text, facts: [{ label: `${c.name} — ${lab(2)}`, value: String(rows.length), sources: rows.slice(0, 25).map((r) => ({ documentId: r.id, location: {} })) }] }),
    { records: [customerRecord({ id: c.id, customer_name: c.name, service_address: c.address }), ...rows.slice(0, 150).map((r) => documentRecord(r))], total: rows.length + 1, kind: "searched",
      basis: `Counted the distinct ${intent.typeId ? lab(2) : "documents"} linked to ${c.name}; every counted record is listed.` }
  );
}

/** "number of purchase orders for Baker Distributing" -> the vendor's PO count (listed); null unless exactly one vendor matches. */
async function runVendorPoCount(db, intent) {
  const { rows: vendors } = await db.raw(`SELECT DISTINCT value AS v FROM extractions WHERE field_key = 'vendor_name' AND value IS NOT NULL AND ${TENANT_SQL}`, []);
  const hit = vendors.filter((r) => String(r.v).toLowerCase() === intent.phrase || String(r.v).toLowerCase().startsWith(intent.phrase));
  if (hit.length !== 1) return null;
  const v = hit[0].v;
  const { rows } = await db.raw(
    `SELECT d.id, d.document_type, d.original_filename, d.created_at FROM documents d JOIN extractions x ON x.document_id = d.id AND x.field_key = 'vendor_name' AND x.value = $1
      WHERE ${typeSql("d.document_type")} = ANY($2::text[]) AND d.${TENANT_SQL} ORDER BY d.created_at DESC`, [v, docTypeAliases("purchase-order")]);
  const text = rows.length ? `${v} has ${rows.length} purchase order${rows.length === 1 ? "" : "s"} on file.` : `No purchase orders are on file for ${v}.`;
  return attachCitations(answerEnvelope({ text, facts: [{ label: `${v} — purchase orders`, value: String(rows.length), sources: rows.slice(0, 25).map((r) => ({ documentId: r.id, location: {} })) }] }),
    { records: rows.map((r) => documentRecord(r, { group: v })), total: rows.length, claimedCount: rows.length, kind: "searched", basis: `Counted the purchase orders on file by vendor name (${v}); every counted record is listed.` });
}

/* ------------------------------------------------------------------ technicians: pair comparison over the technician rows ("a job" = a document naming the technician; the r31-technician convention) */
export async function resolveTechnician(db, phrase) {
  const { rows } = await db.raw(`SELECT DISTINCT value AS v FROM extractions WHERE field_key = 'technician' AND coalesce(value, '') <> '' AND ${TENANT_SQL}`, []);
  const p = String(phrase ?? "").toLowerCase().trim();
  if (!p) return null;
  const exact = rows.filter((r) => String(r.v).toLowerCase() === p);
  if (exact.length === 1) return exact[0].v;
  if (/\s/.test(p)) return null; // a two-word phrase must be an exact technician name
  const part = rows.filter((r) => String(r.v).toLowerCase().split(/\s+/).includes(p));
  return part.length === 1 ? part[0].v : null;
}

async function runTechCompare(db, intent) {
  const [ta, tb] = [await resolveTechnician(db, intent.a.phrase), await resolveTechnician(db, intent.b.phrase)];
  if (!ta || !tb || ta === tb) return null;
  const side = async (t) => (await db.raw(`SELECT x.document_id AS id, d.original_filename, d.document_type, d.created_at FROM extractions x JOIN documents d ON d.id = x.document_id AND d.${TENANT_SQL} WHERE x.field_key = 'technician' AND x.value = $1 AND x.${TENANT_SQL} ORDER BY d.created_at DESC`, [t])).rows;
  const [da, dbb] = [await side(ta), await side(tb)];
  const v = verdict(intent, da.length, dbb.length, ta, tb, "jobs", "Counted every document on file that names the technician (a job is a document).");
  return attachCitations(answerEnvelope({ text: v.text, facts: [{ label: ta, value: String(da.length), sources: [] }, { label: tb, value: String(dbb.length), sources: [] }], extra: { comparison: true } }),
    { records: [...da.map((r) => documentRecord(r, { group: ta })), ...dbb.map((r) => documentRecord(r, { group: tb }))], total: da.length + dbb.length, claimedCount: da.length + dbb.length, kind: "searched", basis: `Counted the documents naming ${ta} (${da.length}) and ${tb} (${dbb.length}) as technician; every counted record is listed.` });
}
