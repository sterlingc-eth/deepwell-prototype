// R5 sealed-exam truth reader. Reads RAW export rows only (documents, pages, extractions, financials, financial_lines, entities, links). Independent of api/ and of Donovan.
// truthFor(index, question) -> { kind: 'answerable'|'unanswerable'|'unclassified', fact, subject, accept:[strings], other:[strings], note }
const MON = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const norm = (s) => String(s ?? "").toLowerCase().replace(/[‘’]/g, "'").replace(/'s\b/g, " ").replace(/[^a-z0-9$#/@.-]+/g, " ").replace(/(?<![a-z0-9])[.-]+|[.-]+(?![a-z0-9])/g, " ").replace(/\s+/g, " ").trim();
const money = (v) => { const n = Number(v); if (!Number.isFinite(n)) return []; const c = n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); const f = [`$${c}`, c, n.toFixed(2)]; if (Number.isInteger(n)) f.push(`$${n.toLocaleString("en-US")}`); return [...new Set(f)]; };
export function dateForms(iso) {
  const m = String(iso ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/); if (!m) return [];
  const [y, mo, d] = [m[1], +m[2], +m[3]]; const p = (n) => String(n).padStart(2, "0");
  return [...new Set([`${p(mo)}/${p(d)}/${y}`, `${mo}/${d}/${y}`, `${MON[mo - 1]} ${d}, ${y}`, `${MON[mo - 1].slice(0, 3)} ${d}, ${y}`, `${MON[mo - 1]} ${d} ${y}`, `${y}-${p(mo)}-${p(d)}`])];
};
const usDate = (s) => { const m = String(s ?? "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null; };

export function buildIndex(d) {
  const docs = new Map(d.documents.map((x) => [x.id, x]));
  const ext = new Map(), pages = new Map(), fin = new Map(), lines = new Map(), links = new Map();
  for (const e of d.extractions ?? []) { const v = String(e.value ?? "").trim(); if (!v) continue; if (!ext.has(e.document_id)) ext.set(e.document_id, {}); (ext.get(e.document_id)[e.field_key] ??= []).push(v); }
  for (const p of [...(d.pages ?? [])].sort((a, b) => a.page_no - b.page_no)) pages.set(p.document_id, `${pages.get(p.document_id) ?? ""}\n${p.text ?? ""}`);
  for (const f of d.financials ?? []) fin.set(f.document_id, f);
  for (const l of d.financial_lines ?? []) { if (!lines.has(l.document_id)) lines.set(l.document_id, []); lines.get(l.document_id).push(l); }
  for (const l of d.document_entity_links ?? []) { if (!links.has(l.entity_id)) links.set(l.entity_id, new Set()); links.get(l.entity_id).add(l.document_id); }
  const ix = { d, docs, ext, pages, fin, lines, links, parties: [], numbers: new Map(), vocab: new Set(), lineDescs: [] };
  const docDate = (id) => String(ext.get(id)?.service_date?.[0] ?? fin.get(id)?.invoice_date ?? ext.get(id)?.invoice_date?.[0] ?? docs.get(id)?.created_at ?? "").slice(0, 10);
  ix.docDate = docDate;
  const addParty = (kind, name, props) => { const n = norm(name); if (n.length >= 5) ix.parties.push({ kind, name, n, ...props }); };
  // customers
  const custDocs = new Map();
  for (const e of d.entities ?? []) {
    if (e.merged_into) continue;
    if (e.entity_type === "customer" && e.data?.customer_name) { const ids = new Set(links.get(e.id) ?? []); custDocs.set(norm(e.data.customer_name), ids); addParty("customer", e.data.customer_name, { ent: e, docs: ids }); }
  }
  const units = (d.entities ?? []).filter((e) => e.entity_type === "equipment" && !e.merged_into);
  for (const p of ix.parties) if (p.kind === "customer") p.units = units.filter((u) => u.customer_id === p.ent.id);
  // financial names (vendors, customers without an entity)
  const byVendor = new Map(), byCust = new Map();
  for (const f of fin.values()) {
    if (f.vendor_name) (byVendor.get(f.vendor_name) ?? byVendor.set(f.vendor_name, new Set()).get(f.vendor_name)).add(f.document_id);
    if (f.customer_name) (byCust.get(f.customer_name) ?? byCust.set(f.customer_name, new Set()).get(f.customer_name)).add(f.document_id);
  }
  for (const [id, x] of ext) for (const v of x.vendor_name ?? []) (byVendor.get(v) ?? byVendor.set(v, new Set()).get(v)).add(id);
  for (const [name, ids] of byVendor) addParty("vendor", name, { docs: ids });
  for (const [name, ids] of byCust) { const hit = ix.parties.find((p) => p.kind === "customer" && p.n === norm(name)); if (hit) ids.forEach((i) => hit.docs.add(i)); else addParty("customer", name, { ent: null, docs: ids, units: [] }); }
  // employees: page text only ("Employee: Name")
  for (const [id, t] of pages) { const m = t.match(/^\s*Employee:\s*(.+)$/im); if (m) addParty("employee", m[1].trim(), { docs: new Set([id]) }); }
  // document numbers: owners first (financial / extraction), then any "XXX-123" in page text
  const num = (k, id, owner) => { const n = norm(k); if (!/^[a-z]{1,6}-\d{2,}$/.test(n)) return; const cur = ix.numbers.get(n); if (!cur || (owner && !cur.owner)) ix.numbers.set(n, { id, owner }); else if (cur.owner === owner && cur.id !== id) cur.multi = true; };
  for (const f of fin.values()) { if (f.invoice_number) num(f.invoice_number, f.document_id, true); if (f.po_number) num(f.po_number, f.document_id, false); }
  for (const [id, x] of ext) for (const key of ["invoice_number", "permit_number", "agreement_number"]) for (const v of x[key] ?? []) num(v, id, true);
  for (const [id, t] of pages) for (const m of t.matchAll(/\b([A-Za-z]{1,6}-\d{2,})\b/g)) num(m[1], id, false);
  for (const l of d.financial_lines ?? []) { const n = norm(l.description); if (n.split(" ").length >= 2 && n.length >= 8) ix.lineDescs.push({ n, doc: l.document_id }); }
  for (const t of pages.values()) for (const w of norm(t).split(" ")) ix.vocab.add(w);
  for (const e of d.entities ?? []) for (const v of Object.values(e.data ?? {})) for (const w of norm(v).split(" ")) ix.vocab.add(w);
  ix.parties.sort((a, b) => b.n.length - a.n.length);
  return ix;
}

const UNSTORED = /\b(fax|favou?rite|blood type|ssn|social security|salary history|birthday|birth ?date|date of birth|religion|password|license plate|shoe size|nickname|middle name|spouse|maiden|credit score|net worth)\b/;
const RULES = [ // first match wins
  ["unstored", UNSTORED],
  ["labor_charge", /\blabou?r (charge|cost|total|amount|fee)|charge for labou?r|labou?r\b.*\$|how much (was|is) labou?r/],
  ["rate", /\b(hourly|pay rate|per hour|an hour|rate of pay)\b/],
  ["hours", /\bhours?\b|\bhrs?\b|how long did/],
  ["contract_end", /\b(expire|expires|expiry|expiration|end date|renew|renewal|signed with|term of|agreement end|contract end)\b|how long is .*(signed|contract|agreement)/],
  ["agreement_number", /\b(agreement|contract) (number|no|#)\b|\b(agreement|contract) num/],
  ["contract_fee", /\b(monthly|management|annual) (management )?fee\b|\bfee\b/],
  ["resurface_date", /\b(resurfac\w*|lot)\b.*\b(when|date|schedule\w*|day)\b|\b(when|date)\b.*\b(resurfac\w*|lot)\b/],
  ["resurface_cost", /\b(resurfac\w*|lot)\b.*\b(cost|estimate|price|quote)\b|\b(cost|estimate|price|quote)\b.*\b(resurfac\w*|lot)\b/],
  ["hire", /\b(start(ed)?|hire|hired|hire date|start date|joined)\b/],
  ["boss", /\breport(s)? to\b|\bsupervisor\b|\bboss\b|\bmanager is\b/],
  ["role", /\b(job title|title|position|role)\b/],
  ["serial", /\bserial\b/], ["refrigerant", /\brefrigerant\b|\br-?410a?\b/], ["model", /\bmodel\b/], ["manufacturer", /\b(manufacturer|brand|make of)\b/],
  ["email", /\be-?mail\b/],
  ["phone", /\b(phone|cell|mobile|telephone|number to reach)\b|how (do|can) i (call|reach|contact)/],
  ["address", /\b(address|located|location)\b|where (does|do) .* live/],
  ["total", /\bamount due\b|\bhow much is due\b/],
  ["paid_status", /\b(paid|unpaid|outstanding|overdue|past due|balance|settled)\b/],
  ["due_date", /\bdue\b/],
  ["technician", /\b(tech|technician|who worked|who did|who came|who serviced|who ran|who handled)\b/],
  ["notes", /\b(notes?|comments?|wrote down)\b/],
  ["work", /\bwhat (we|i|he|she|they) did\b|\bwe did\b|\blast (job|visit|time)\b|\b(work|done|did we do|job|performed|repair\w*|fix\w*|install\w*|replace\w*|service\w* on)\b/],
  ["owe", /\bowe\b/],
  ["total", /\b(total|how much|amount|cost|charge[ds]?|bill|price|estimate)\b/],
  ["date", /\b(date|when|what day)\b/],
  ["phone", /\bnumber\b/],
];
export const FACT_CLASSES = RULES.map((r) => r[0]);
export function factOf(qn) { for (const [c, re] of RULES) if (re.test(qn)) return c; return null; }

const has = (text, needle) => needle && new RegExp(`(?<![a-z0-9]|\\d[,.])${String(needle).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9]|[,.]\\d)`).test(String(text).toLowerCase().replace(/\s+/g, " "));
export { has as textHas };

export const MONEY_FACTS = new Set(["total", "labor_charge", "contract_fee", "rate", "resurface_cost"]);
export const DATE_FACTS = new Set(["due_date", "date", "contract_end", "hire", "resurface_date"]);
export const extractMoney = (t) => [...String(t ?? "").matchAll(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)/g)].map((m) => Number(m[1].replace(/,/g, "")));
export function extractDates(t) {
  const s = String(t ?? ""), out = [];
  for (const m of s.matchAll(/(?<!\d)(\d{1,2})\/(\d{1,2})\/(\d{4})/g)) out.push(`${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`);
  for (const m of s.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)) out.push(m[0]);
  for (const m of s.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/gi)) out.push(`${m[3]}-${String("janfebmaraprmayjunjulaugsepoctnovdec".indexOf(m[1].toLowerCase()) / 3 + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`);
  return out;
}
function ownFilter(f, own, vals) {
  const dates = DATE_FACTS.has(f) ? new Set(extractDates(own)) : null, nums = MONEY_FACTS.has(f) ? new Set(extractMoney(own)) : null;
  return vals.filter((v) => !has(own, v) && !(dates && extractDates(v).some((d) => dates.has(d))) && !(nums && nums.has(Number(String(v).replace(/[$,]/g, "")))));
}
const pageField = (ix, id, re) => { const m = String(ix.pages.get(id) ?? "").match(re); return m ? m[1].trim() : null; };
/** accepted display strings of one document-level fact; null = not stored on that document */
function docFact(ix, id, fact) {
  const f = ix.fin.get(id), x = ix.ext.get(id) ?? {}; const L = ix.lines.get(id) ?? [];
  switch (fact) {
    case "total": { const v = f?.total ?? pageField(ix, id, /(?:AMOUNT DUE|TOTAL DUE|TOTAL):\s*\$?([\d,]+\.\d{2})/i)?.replace(/,/g, ""); return v != null ? money(v) : null; }
    case "due_date": { const v = f?.due_date ?? usDate(pageField(ix, id, /Due Date:\s*(.+)/i)); return v ? dateForms(String(v)) : null; }
    case "date": { const v = x.service_date?.[0] ?? f?.invoice_date ?? x.invoice_date?.[0] ?? usDate(pageField(ix, id, /^Date:\s*(.+)/im)); return v ? dateForms(String(v)) : null; }
    case "hours": { const v = x.labor_hours?.[0] ?? pageField(ix, id, /Labor:\s*([\d.]+)\s*hrs?/i); if (v == null) return null; const n = Number(v); return Number.isFinite(n) ? [`${n} hours`, `${n} hour`, `${n} hrs`, `${n} hr`, `${n.toFixed(1)} hours`] : null; }
    case "technician": { const v = x.technician?.[0] ?? pageField(ix, id, /Technician:\s*(.+)/i); return v ? [v] : null; }
    case "work": { const v = [...(x.work_performed ?? []), ...L.map((l) => l.description).filter(Boolean)]; return v.length ? [...new Set(v)] : null; }
    case "notes": return x.notes?.length ? x.notes : null;
    case "labor_charge": { const l = L.filter((l) => /labou?r/i.test(l.description ?? "") && l.amount != null); return l.length ? [...new Set(l.flatMap((q) => money(q.amount)))] : null; }
    case "paid_status": {
      if (!f) return null; const s = String(f.status ?? "unknown").toLowerCase();
      const paid = s === "paid" || (f.amount_paid != null && f.total != null && Number(f.amount_paid) >= Number(f.total) && Number(f.total) > 0);
      const unpaid = ["unpaid", "open", "overdue", "partial", "partially paid", "sent", "due"].includes(s) || (f.balance_due != null && Number(f.balance_due) > 0);
      const pg = String(ix.pages.get(id) ?? ""); const pagePaid = /\bPAID\b|paid in full/.test(pg), pageDue = /BALANCE DUE:\s*\$?[1-9]/i.test(pg);
      if (!paid && !unpaid) return pagePaid ? ["paid"] : pageDue ? ["unpaid", "not paid", "outstanding", "overdue", "past due", "open", "balance"] : null;
      return paid ? ["paid"] : unpaid ? ["unpaid", "not paid", "outstanding", "overdue", "past due", "open", "balance"] : null;
    }
    case "contract_end": { const t = f?.agreement_term ?? x.agreement_term?.[0]; const ds = [...String(t ?? "").matchAll(/\d{1,2}\/\d{1,2}\/\d{4}/g)].map((m) => m[0]); const e = ds.length > 1 ? ds[ds.length - 1] : usDate(pageField(ix, id, /Expires:\s*(.+)/i)) ? pageField(ix, id, /Expires:\s*(.+)/i) : null; return e ? dateForms(usDate(e)) : null; }
    case "contract_fee": { const v = f?.doc_kind === "agreement" ? f.total : null; return v != null ? money(v) : null; }
    case "agreement_number": { const v = f?.doc_kind === "agreement" ? f.invoice_number : null; return v ? [v] : null; }
    case "resurface_date": { const v = usDate(pageField(ix, id, /resurface[^.]*? on (\d{1,2}\/\d{1,2}\/\d{4})/i)); return v ? dateForms(v) : null; }
    case "resurface_cost": { const v = pageField(ix, id, /Estimated cost[^$]*\$([\d,]+\.\d{2})/i); return v ? money(v.replace(/,/g, "")) : null; }
    default: return null;
  }
}
const EMP = { hire: [/Hire Date:\s*(\S+)/i, (v) => dateForms(usDate(v))], rate: [/Hourly Rate:\s*\$?([\d.,]+)/i, (v) => money(v.replace(/,/g, ""))], role: [/Position:\s*(.+)/i, (v) => [v.trim()]], boss: [/Reports to:\s*(.+)/i, (v) => [v.trim()]] };
const isKind = (id, ix, kinds) => { const d = ix.docs.get(id), f = ix.fin.get(id); return kinds.some((k) => d?.document_type === k || f?.doc_kind === k); };

/** every value of this fact class across ALL records (for the "another record's value appears" check) */
export function allValues(ix, fact) {
  const out = new Set(); const add = (a) => (a ?? []).forEach((v) => out.add(v));
  const docFacts = ["total", "due_date", "date", "technician", "work", "contract_end", "contract_fee", "agreement_number", "resurface_date", "resurface_cost", "labor_charge"];
  const alias = { contract_fee: "total", labor_charge: "total" };
  const f = alias[fact] ?? fact;
  if (docFacts.includes(f)) for (const id of ix.docs.keys()) add(docFact(ix, id, f));
  if (f === "date") for (const id of ix.docs.keys()) add(docFact(ix, id, "due_date"));
  if (f === "due_date") for (const id of ix.docs.keys()) add(docFact(ix, id, "date"));
  for (const e of ix.d.entities ?? []) {
    const dt = e.data ?? {};
    if (fact === "phone" && dt.phone) out.add(dt.phone);
    if (fact === "email" && dt.email) out.add(dt.email);
    if (fact === "address" && dt.service_address) out.add(dt.service_address.split(",")[0]);
    if (fact === "serial" && dt.serial_number) out.add(dt.serial_number);
    if (fact === "model" && dt.model) out.add(dt.model);
  }
  if (["hire", "rate", "boss"].includes(fact)) for (const [id, t] of ix.pages) { if (!/Employee:/i.test(t)) continue; const [re, fn] = EMP[fact]; const m = t.match(re); if (m) add(fn(m[1])); }
  return out;
}

function containsWhole(qn, n) { const t = ` ${qn} `; return t.includes(` ${n} `) || t.includes(` ${n}s `); } // "fenwicks bill" = possessive typed without the apostrophe
function partyMatches(ix, qn) {
  const hits = ix.parties.filter((p) => containsWhole(qn, p.n));
  const keep = hits.filter((p) => !hits.some((o) => o !== p && o.n.length > p.n.length && o.n.includes(p.n)));
  const uniq = new Map(keep.map((p) => [`${p.kind}:${p.n}`, p]));
  return [...uniq.values()];
}

export function truthFor(ix, question) {
  const qn = norm(question); const un = (note, fact = null, subject = null) => ({ kind: "unclassified", fact, subject, accept: [], other: [], note });
  const fact = factOf(qn);
  const none = (note, f = fact, subject = null, docIds = []) => {
    const own = docIds.map((id) => `${ix.pages.get(id) ?? ""}`).join("\n") + (ctxEnt ? JSON.stringify(ctxEnt.data ?? {}) : "");
    const exists = docIds.length > 0 || /^(fact|field|no unit|no matching|not on employee|not stored for)/.test(note);
    return { kind: "unanswerable", fact: f, subject, accept: [], note, exists, other: exists && f !== "unstored" ? ownFilter(f, own, [...allValues(ix, f)]) : [],
      ownMoney: MONEY_FACTS.has(f) ? [...new Set(extractMoney(own))] : [], ownDates: DATE_FACTS.has(f) ? [...new Set(extractDates(own))] : [] };
  };
  const ok = (accept, f, subject, note = "", docIds = []) => {
    const own = docIds.map((id) => `${ix.pages.get(id) ?? ""}`).join("\n") + (ctxEnt ? JSON.stringify(ctxEnt.data ?? {}) : "");
    const A = [...new Set(accept)];
    return { kind: "answerable", fact: f, subject, accept: A, note,
      other: ownFilter(f, own, [...allValues(ix, f)].filter((v) => !A.some((a) => String(a).toLowerCase() === String(v).toLowerCase()))),
      ownMoney: MONEY_FACTS.has(f) ? [...new Set(extractMoney(own))] : [], ownDates: DATE_FACTS.has(f) ? [...new Set(extractDates(own))] : [] };
  };
  let ctxEnt = null;
  if (!fact) return un("no fact class");
  if (fact === "owe") return un("'owe' is ambiguous between a total and a balance");
  // 1. document number
  const nums = [...qn.matchAll(/(?<![a-z0-9])([a-z]{1,6}-\d{2,})(?![a-z0-9])/g)].map((m) => m[1]);
  if (nums.length > 1) return un("several document numbers");
  if (fact === "unstored") return none("fact never stored", "unstored", nums[0] ?? null);
  if (nums.length) {
    const hit = ix.numbers.get(nums[0]); if (!hit) return none("document number not in rows", fact, nums[0]);
    if (hit.multi) return un("document number shared by several documents");
    if (["phone", "email", "address", "serial", "refrigerant", "model", "manufacturer", "hire", "rate", "role", "boss"].includes(fact)) return un("party fact asked via document number");
    const acc = docFact(ix, hit.id, fact); return acc ? ok(acc, fact, nums[0], "", [hit.id]) : none("fact not on that document", fact, nums[0], [hit.id]);
  }
  // 2. party
  const ps = partyMatches(ix, qn);
  if (ps.length > 1) return un("several parties named");
  if (!ps.length) {
    const lineHit = ix.lineDescs.filter((l) => containsWhole(qn, l.n)); const docs = [...new Set(lineHit.map((l) => l.doc))];
    if (docs.length === 1) { const acc = docFact(ix, docs[0], fact); return acc ? ok(acc, fact, "line-item", "", [docs[0]]) : none("fact not on that document", fact, "line-item", [docs[0]]); }
    // unknown subject: residual tokens that appear nowhere in the rows -> a name that is not on file
    const resid = qn.split(" ").filter((w) => /^[a-z]{4,}$/.test(w) && !ix.vocab.has(w) && !RULES.some(([, re]) => re.test(w)));
    const generic = new Set(["what", "when", "where", "which", "from", "this", "that", "tell", "please", "number", "much", "have", "does", "last", "time", "about", "agreement", "contract", "invoice", "total", "phone", "email", "address", "favorite", "color", "type", "blood", "fax", "address", "work", "worked", "bill", "billed", "expire", "expires", "done", "date", "call", "does", "they"]);
    const names = resid.filter((w) => !generic.has(w));
    if (names.length >= 1 && qn.split(" ").length >= 3) return none("subject not in rows", fact, names.join(" "));
    return un("subject not resolved");
  }
  const p = ps[0]; const docsSorted = [...(p.docs ?? [])].filter((id) => ix.docs.has(id)).sort((a, b) => ix.docDate(b).localeCompare(ix.docDate(a)));
  const last = /\b(last|latest|recent|newest|most recent)\b/.test(qn);
  const subj = `${p.kind}:${p.name}`;
  if (p.kind === "employee") {
    if (EMP[fact]) { const m = String(ix.pages.get([...p.docs][0])).match(EMP[fact][0]); return m ? ok(EMP[fact][1](m[1]), fact, subj, "", [...p.docs]) : none("not on employee form", fact, subj); }
    if (["address", "email", "serial", "refrigerant", "model", "manufacturer", "total", "due_date", "paid_status"].includes(fact)) return none("not stored for employees", fact, subj);
    return un("employee fact unknown", fact, subj);
  }
  if (["phone", "email", "address"].includes(fact)) {
    const v = p.ent?.data?.[fact === "address" ? "service_address" : fact]; if (!v) return p.kind === "customer" ? none("field empty on customer", fact, subj) : un("vendor contact fact");
    ctxEnt = p.ent; return ok(fact === "address" ? [v, v.split(",")[0]] : [v], fact, subj, "", docsSorted);
  }
  if (["serial", "refrigerant", "model", "manufacturer"].includes(fact)) {
    const key = { serial: "serial_number", refrigerant: "refrigerant", model: "model", manufacturer: "manufacturer" }[fact]; const vals = (p.units ?? []).map((u) => u.data?.[key]).filter(Boolean);
    ctxEnt = p.ent; return vals.length ? ok(vals, fact, subj, "", docsSorted) : none("no unit value", fact, subj);
  }
  if (["hire", "rate", "boss", "role"].includes(fact)) return un("employee fact on non-employee", fact, subj);
  let cand = docsSorted;
  const lineHit = ix.lineDescs.filter((l) => containsWhole(qn, l.n) && cand.includes(l.doc)); if (lineHit.length) cand = [...new Set(lineHit.map((l) => l.doc))];
  const kindDocs = fact.startsWith("contract") || fact === "agreement_number" ? cand.filter((id) => isKind(id, ix, ["agreement", "maintenance-agreement"])) : fact.startsWith("resurface") ? cand.filter((id) => /resurfac/i.test(ix.pages.get(id) ?? "")) : cand;
  if (!kindDocs.length) return none("no matching document for that party", fact, subj);
  const per = kindDocs.map((id) => docFact(ix, id, fact)).filter(Boolean);
  if (!per.length) return none("fact not on any of that party's documents", fact, subj, kindDocs);
  const acc = last ? per[0] : per.flat();
  return ok(acc, fact, subj, kindDocs.length > 1 && !last ? "several documents: any accepted" : "", kindDocs);
}
