/**
 * Docread round (2026-10-22): facts a page states IN SENTENCES or in a layout the labelled scan does not read.
 *
 * THE DEFECT (Sonoran Comfort Air, live): "Lease - Warehouse and Office (signed).pdf" says "for a term of 60 months beginning
 * 02/10/2023 and ending 02/09/2028" in its first clause, yet the Inbox said "Missing required field: Agreement term or
 * Service date" and Re-check answered "Nothing labelled for the missing field on this document". textExtract.js's
 * scanLabeledValues only reads "Label: value" lines. This module is the second reader, shared by upload (label-fill),
 * Re-check (single, bulk, nightly), "Read the page again" and the stored-text re-read, through labelFill.js planLabelFill.
 *
 * What it reads (generic, every industry; never a file name or a phrasing of one test file):
 *   - agreement terms:  "a term of N months|years beginning|commencing X and ending|through Y", "commencing on X and
 *                       ending on Y", "from X through Y" (in a sentence about a term / lease / agreement / coverage),
 *                       "effective (as of) X", "expires|terminates on Y"
 *   - parties:          "between X (Landlord) and Y (Tenant)", "by and between X ("Client") and Y ("Consultant")";
 *                       a two-column block header "BILL TO   REMIT TO" / "BILL TO / Name / ..." whose first column names the
 *                       party under the label
 *   - amounts:          the document total on a "Balance Due / Amount Due / Total Due / Total / Balance / ... Received" line
 *   - period labels:    "Policy Effective / Policy Expires", "License No. / Expires / Date Issued", "Policy #"
 *
 * Every candidate carries the exact text it was read from (`verbatim`) and its page and line, so groundedFacts.js can prove
 * the quote is on the page and the value comes from the quote. Precision first: two different readings of one fact, a term
 * whose start + length does not land on its end, or a total that does not equal subtotal + tax return NOTHING for that fact
 * (it is reported in `ambiguous` and left for a person).
 *
 * Pure. No clock, no I/O.
 */
import { normalizeDate, normalizeNumber } from "../extractFields.js";

const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
export const DATE_SRC = `(?:\\d{1,2}[-\\s]${MONTH}\\.?[-\\s,]+'?\\d{2,4}|${MONTH}\\.?\\s+\\d{1,2},?\\s+'\\d{2}|\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[/.-]\\d{1,2}[/.-](?:\\d{4}|\\d{2})|${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:day\\s+of\\s+)?${MONTH}\\.?,?\\s+\\d{4})`;
const D = DATE_SRC;
const NUMWORD = "(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|eighteen|twenty[- ]?four|thirty[- ]?six|forty[- ]?eight|sixty)";
const WORD_N = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, eighteen: 18, twentyfour: 24, thirtysix: 36, fortyeight: 48, sixty: 60 };

/** Party roles: who supplies (vendor) and who receives (customer) under the agreement. Unknown roles are not read. */
const VENDOR_ROLES = /^(?:landlord|lessor|licensor|seller|vendor|supplier|provider|service\s+provider|contractor|consultant|consignee|grantor|funder|company|agency|firm|manager|property\s+manager|owner'?s?\s+agent)$/i;
const CUSTOMER_ROLES = /^(?:tenant|lessee|licensee|buyer|purchaser|client|customer|owner|property\s+owner|consignor|grantee|recipient|member|resident|subscriber|organization|partner)$/i;
const PARTY_HEAD = /^(?:bill(?:ed)?\s+to|credit\s+to|sold\s+to|submitted\s+to|prepared\s+for|customer|client|received\s+from|tenant|lessee|donor|member|patient|account|owner)\s*:?$/i;
const COLUMN_HEAD = /^(?:bill(?:ed)?\s+to|credit\s+to|sold\s+to|submitted\s+to|prepared\s+for|ship(?:ped)?\s+to|remit\s+(?:to|payment\s+to)|service\s+(?:location|address|site)|project(?:\s+(?:location|site|address))?|job\s*(?:site|location|address)?|(?:pickup|return|delivery|drop[-\s]?off|billing|mailing|shipping|work)\s+(?:location|address|site)|property|premises|deliver(?:ed|y)?\s+to|customer|client|received\s+from|tenant|landlord|owner|insured|certificate\s+holder|vendor|from|to|location|site)\s*:?$/i;

/** Total-line labels, by priority tier (lower = stronger). A label must be the WHOLE segment, so "Total Completed to Date"
 *  or "Subcontract Sum" are never read as the document total. */
const TOTAL_TIERS = [
  [1, /^(?:balance\s+due|amount\s+due(?:\s+this\s+(?:application|period|invoice|statement))?|total\s+due|current\s+(?:payment|amount)\s+due|payment\s+due|total\s+amount\s+due|amount\s+now\s+due|net\s+amount\s+due|please\s+pay(?:\s+this\s+amount)?|pay\s+this\s+amount)$/i],
  [2, /^(?:grand\s+total|invoice\s+total|total\s+current\s+charges|total\s+amount|total\s+invoice|total\s+price|total\s+charges|total\s+(?:refund|credit)|credit\s+(?:total|amount)|refund\s+total|total)$/i],
  [3, /^(?:balance|payment\s+amount|amount\s+(?:paid|received|tendered)|total\s+(?:paid|received)|payment\s+received|(?:security\s+)?(?:deposit|donation|gift|retainer|rent|fee)\s+(?:received|paid)|paid)$/i],
];
const SUBTOTAL = /^(?:sub[-\s]?total|subtotal)$/i;
const TAX = /^(?:(?:sales\s+)?tax(?:es)?|gst|hst|vat)(?:\s*\(?[\d.]+\s*%\)?)?$/i;
const ADJUST = /\b(?:less|retainage|previous|payments?|deposit|credit|discount|adjust|paid\s+to\s+date|shipping|freight|fees?)\b/i;

const LABELS = {
  license_number: /^(?:licen[cs]e|lic\.?|certificate|cert\.?|card|registration|credential)\s*(?:no\.?|number|#|num\.?)$/i,
  service_address: /^(?:site\s+address|service\s+address|job\s*(?:site|address)|property\s+address|project\s+address|premises|service\s+location)$/i,
  serial_number: /^(?:serial(?:\s*(?:no\.?|number|#))?|s\/n|ser\.?\s*no\.?)$/i,
  model: /^(?:model(?:\s*(?:no\.?|number|#))?|m\/n)$/i,
  warranty_term: /^(?:parts\s+warranty|warranty\s+term|manufacturer(?:'s)?\s+warranty|limited\s+warranty)$/i,
  policy_number: /^policy\s*(?:no\.?|number|#)$/i,
  permit_number: /^(?:permit|building\s+permit|mechanical\s+permit|electrical\s+permit|plumbing\s+permit)\s*(?:no\.?|number|#)$/i,
  // This paper's own number (never a referenced PO / account / customer number - those are other papers' numbers).
  invoice_number: /^(?:invoice|inv\.?|report|receipt|packing\s+slip|slip|delivery\s+ticket|ticket|estimate|quote|bid|proposal|credit\s+memo|memo|statement|pay\s+app(?:lication)?|application)\s*(?:no\.?|number|#|num\.?)$/i,
  start_date: /^(?:policy\s+effective(?:\s+date)?|effective\s+date|date\s+issued|issue\s+date|issued(?:\s+on)?|date\s+of\s+issue|license\s+issued|coverage\s+begins|policy\s+period\s+start|start\s+date|commencement\s+date)$/i,
  // The date a money paper is dated, under a bare or document-date label. Only read for money / order papers (DOC_DATE_TYPES).
  service_date: /^(?:date|invoice\s+date|date\s+issued|issue\s+date|issued(?:\s+on)?|bill(?:ing)?\s+date|statement\s+date|receipt\s+date|order\s+date|date\s+of\s+invoice|po\s+date|quote\s+date|estimate\s+date|bid\s+date|proposal\s+date|date\s+received|payment\s+date|date\s+paid|ship\s+date|date\s+shipped|delivery\s+date|date\s+delivered|inspected|inspection\s+date|date\s+inspected|contract\s+date|agreement\s+date)$/i,
  end_date: /^(?:policy\s+expires|policy\s+expiration(?:\s+date)?|expires(?:\s+on)?|expiration(?:\s+date)?|exp\.?\s+date|expiry(?:\s+date)?|valid\s+(?:through|thru|until)|coverage\s+ends|end\s+date|termination\s+date|renewal\s+date)$/i,
};

const DOC_DATE_TYPES = new Set(["invoice", "receipt", "statement", "proposal-quote", "purchase-order", "delivery-ticket", "inspection-report", "agreement"]);
const ROLE_HEAD = /^(?:landlord|tenant|lessor|lessee|contractor|subcontractor|consultant|owner|property\s+owner|manager|agent|funder|grantor|grantee|licensor|licensee|seller|buyer|purchaser|vendor|supplier|provider|client|customer|claimant|consignor|consignee|shop|company|member|recipient)\s*:?$/i;
const SERVICE_HEAD = /^(?:service\s+(?:address|location|site)|project\s+location|job\s*site|site\s+address|premises|property(?:\s+address)?)\s*:?$/i;
const STREET = /^\d{1,6}\s+(?:[NSEW]\.?\s+)?[A-Za-z0-9][A-Za-z0-9'.-]*(?:\s+[A-Za-z0-9'.-]+){0,5}$/;
const collapse = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const cleanName = (s) => collapse(s).replace(/,?\s+(?:doing\s+business\s+as|d\/b\/a|dba)\s+.*$/i, "").replace(/^(?:the\s+)/i, "").replace(/[,;:.\s]+$/, "").replace(/^["“'(]+|["”')]+$/g, "");

/** Lines of the document, with the page and the 1-based line number on that page. */
function toLines(pages) {
  const out = [];
  for (const p of pages ?? []) {
    const rows = String(p?.text ?? "").split(/\r?\n/);
    rows.forEach((t, i) => out.push({ page: Number(p?.page_no) || 1, line: i + 1, t }));
  }
  return out;
}
/** A line's segments: split on 2+ spaces, tabs and table pipes. */
const segmentsOf = (t) => {
  const segs = String(t).split(/\s{2,}|\t|\s*\|\s*/).map((s) => s.trim()).filter(Boolean);
  // A spreadsheet row as the office reader prints it ("Row 31 | Item #: Total Due | Description: $1,988.39"): the cells are the
  // values after each column header.
  if (/^Row \d+$/.test(segs[0] ?? "") && segs.slice(1).some((x) => /^[^:]{1,40}:\s/.test(x))) return segs.slice(1).map((x) => x.replace(/^[^:]{1,40}:\s+/, ""));
  // Verifier round: a label and its amount separated by one space ("Total $180.00", "Tax (8%) $8.00") are two segments.
  return segs.flatMap((x) => { const m = /^([A-Za-z][A-Za-z ()%.#/&-]{1,40}?)\s+(\(?-?(?:USD\s*|US\$\s*)?\$\s*[\d,]+\.\d{2}\)?|\(?-?USD\s*[\d,]+\.\d{2}\)?)$/.exec(x); return m && !/:\s*$/.test(m[1]) ? [m[1], m[2]] : [x]; });
};

function monthsBetweenOk(startYmd, n, unit, endYmd) {
  const s = new Date(`${startYmd}T00:00:00Z`);
  const e = new Date(`${endYmd}T00:00:00Z`);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return false;
  const months = unit.startsWith("y") ? n * 12 : n;
  const exact = new Date(s); exact.setUTCMonth(exact.getUTCMonth() + months);
  const dayBefore = new Date(exact); dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
  const iso = (d) => d.toISOString().slice(0, 10);
  return iso(exact) === endYmd || iso(dayBefore) === endYmd;
}

/**
 * @param {{page_no:number, text:string}[]} pages
 * @param {{keys?: string[], type?: string|null, order?: 'mdy'|'dmy'|'strict'}} [opts]
 * @returns {{candidates: Record<string, {value:string, page_no:number, line:number, verbatim:string, label:string, strength:'prose', conf:number, checks?:string[]}[]>, ambiguous: {key:string, reason:string, values?:string[]}[]}}
 */
export function scanProseFacts(pages, opts = {}) {
  const want = opts.keys ? new Set(opts.keys) : null;
  const order = opts.order ?? "mdy";
  const parseDate = (v) => normalizeDate(v, { order });
  const out = {};
  const ambiguous = [];
  const push = (key, c) => { if (!want || want.has(key)) (out[key] ??= []).push({ strength: "prose", conf: 0.88, ...c }); };

  // ---------- sentences (page text flattened: newline -> space keeps every offset, so a match maps back to its line)
  for (const p of pages ?? []) {
    const raw = String(p?.text ?? "");
    if (!raw.trim()) continue;
    const flat = raw.replace(/\r?\n/g, " ");
    const lineAt = (idx) => raw.slice(0, idx).split(/\n/).length;
    const page = Number(p?.page_no) || 1;
    const quote = (m) => collapse(m[0]);

    // "a term of 60 months beginning 02/10/2023 and ending 02/09/2028" / "for a period of twelve (12) months commencing on ..."
    const termRe = new RegExp(`\\b(?:term|period)\\s+(?:of|is)\\s+(?:(${NUMWORD})\\s*)?\\(?(\\d{1,3})?\\)?\\s*(months?|years?)\\b[^.;]{0,60}?\\b(?:beginning|commencing|starting|effective|from)\\s+(?:on\\s+)?(${D})(?:[^.;]{0,40}?\\b(?:and\\s+)?(?:ending|expiring|terminating|through|until|to)\\s+(?:on\\s+)?(${D}))?`, "gi");
    for (const m of flat.matchAll(termRe)) {
      const n = m[2] ? Number(m[2]) : WORD_N[String(m[1] ?? "").toLowerCase().replace(/[- ]/g, "")];
      if (!n) continue;
      const unit = m[3].toLowerCase();
      const s = parseDate(m[4]);
      const e = m[5] ? parseDate(m[5]) : null;
      if (!s) continue;
      const base = { page_no: page, line: lineAt(m.index), verbatim: quote(m), label: "term sentence" };
      const len = `${n} ${unit.startsWith("y") ? (n === 1 ? "year" : "years") : (n === 1 ? "month" : "months")}`;
      if (e) {
        if (!monthsBetweenOk(s, n, unit, e)) { ambiguous.push({ key: "agreement_term", reason: "start + term does not equal end", values: [m[4], len, m[5]] }); continue; }
        push("agreement_term", { ...base, value: `${len} (${collapse(m[4])} - ${collapse(m[5])})`, conf: 0.9, checks: ["start+term=end"] });
        push("start_date", { ...base, value: collapse(m[4]), conf: 0.9, checks: ["start+term=end"] });
        push("end_date", { ...base, value: collapse(m[5]), conf: 0.9, checks: ["start+term=end"] });
      } else {
        push("agreement_term", { ...base, value: `${len} from ${collapse(m[4])}` });
        push("start_date", { ...base, value: collapse(m[4]) });
      }
    }
    // "has an initial term of 12 months" with no dates in that sentence: the length alone is the term.
    const lenRe = new RegExp(`\\b(?:initial\\s+|original\\s+|lease\\s+|contract\\s+)?term\\s+(?:of|is)\\s+(?:(${NUMWORD})\\s*)?\\(?(\\d{1,3})?\\)?\\s*(months?|years?)\\b(?![^.;]{0,60}?\\b(?:beginning|commencing|starting|effective|from)\\s)`, "gi");
    for (const m of flat.matchAll(lenRe)) {
      // a renewal / extension term ("may renew for one additional term of 36 months") is not the agreement's term
      if (/\b(?:additional|renewal|renew(?:s|ed)?|extension|extend(?:ed)?|successive|option)\b[^.;]{0,40}$/i.test(flat.slice(Math.max(0, m.index - 60), m.index))) continue;
      const n = m[2] ? Number(m[2]) : WORD_N[String(m[1] ?? "").toLowerCase().replace(/[- ]/g, "")];
      if (!n) continue;
      const unit = m[3].toLowerCase().startsWith("y") ? (n === 1 ? "year" : "years") : (n === 1 ? "month" : "months");
      push("agreement_term", { page_no: page, line: lineAt(m.index), verbatim: quote(m), label: "term length sentence", value: `${n} ${unit}`, conf: 0.86 });
    }
    // "commencing on X and ending on Y" / "from X through Y" in a sentence about a term, lease, agreement or coverage.
    const spanRe = new RegExp(`\\b(?:commenc(?:es|ing)|begin(?:s|ning)|start(?:s|ing)|effective|from)\\s+(?:on\\s+)?(${D})\\s*,?\\s+(?:and\\s+)?(?:ending|ends|expiring|expires|terminating|terminates|through|until|to|thru)\\s+(?:on\\s+)?(${D})`, "gi");
    for (const m of flat.matchAll(spanRe)) {
      const sentenceStart = Math.max(flat.lastIndexOf(".", m.index), 0);
      const ctx = flat.slice(sentenceStart, m.index);
      if (!/\b(?:term|lease|agreement|contract|coverage|period|policy|rental|tenancy|license|grant|engagement|service)\b/i.test(ctx)) continue;
      if (/\bterm\s+of\s+/i.test(ctx.slice(-120))) continue; // already read by termRe
      const s = parseDate(m[1]); const e = parseDate(m[2]);
      if (!s || !e || e <= s) continue;
      const base = { page_no: page, line: lineAt(m.index), verbatim: quote(m), label: "period sentence" };
      push("agreement_term", { ...base, value: `${collapse(m[1])} - ${collapse(m[2])}` });
      push("start_date", { ...base, value: collapse(m[1]) });
      push("end_date", { ...base, value: collapse(m[2]) });
    }
    // "effective as of X" / "is effective X" / "made and entered into as of X"
    const effRe = new RegExp(`\\b(?:effective\\s+(?:as\\s+of\\s+|on\\s+)?|(?:beginning|commencing|begins|starts|commences)\\s+(?:on\\s+)?|entered\\s+into\\s+(?:as\\s+of|on)\\s+|dated\\s+(?:as\\s+of\\s+)?)(${D})`, "gi");
    for (const m of flat.matchAll(effRe)) {
      const after = flat.slice(m.index + m[0].length, m.index + m[0].length + 25);
      if (/^\s*,?\s*(?:and\s+)?(?:ending|through|until|to|thru)\b/i.test(after)) continue; // a span, read above
      if (!parseDate(m[1])) continue;
      push("start_date", { page_no: page, line: lineAt(m.index), verbatim: quote(m), label: /^(?:beginning|commencing|begins|starts|commences)/i.test(m[0]) ? "begin sentence" : "effective sentence", value: collapse(m[1]) });
    }
    const expRe = new RegExp(`\\b(?:expires|expiring|terminates|shall\\s+(?:expire|terminate|end)|ends)\\s+(?:on\\s+)?(${D})`, "gi");
    for (const m of flat.matchAll(expRe)) {
      if (!parseDate(m[1])) continue;
      push("end_date", { page_no: page, line: lineAt(m.index), verbatim: quote(m), label: "expiry sentence", value: collapse(m[1]) });
    }
    // Parties: "between X (Landlord) and Y (Tenant)" / 'by and between X ("Client") and Y ("Consultant")'
    const NAME = "([A-Z][A-Za-z0-9&.,'’\\- ]{1,90}?)";
    const ROLE = "\\(\\s*(?:the\\s+|hereinafter\\s+(?:called\\s+|referred\\s+to\\s+as\\s+)?)?[\"“”']?([A-Za-z' ]{3,30}?)[\"“”']?\\s*\\)";
    const partyRe = new RegExp(`\\bbetween\\s+${NAME}\\s*,?\\s*${ROLE}\\s*,?\\s*and\\s+${NAME}\\s*,?\\s*${ROLE}`, "g");
    for (const m of flat.matchAll(partyRe)) {
      const base = { page_no: page, line: lineAt(m.index), verbatim: quote(m), label: "parties sentence" };
      for (const [nameRaw, roleRaw] of [[m[1], m[2]], [m[3], m[4]]]) {
        const name = cleanName(nameRaw);
        const role = collapse(roleRaw);
        if (name.split(/\s+/).length > 9 || name.length < 3) continue;
        if (VENDOR_ROLES.test(role)) push("vendor", { ...base, value: name, label: `parties sentence (${role.toLowerCase()})` });
        else if (CUSTOMER_ROLES.test(role)) push("customer_name", { ...base, value: name, label: `parties sentence (${role.toLowerCase()})` });
      }
    }
  }

  // ---------- layout: column headers, total lines, period/number labels
  const lines = toLines(pages);
  const totals = [];
  const subs = { sub: [], tax: [], adjust: false };
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    const segs = segmentsOf(L.t);
    if (!segs.length) continue;

    // Two-column block header: "BILL TO   REMIT TO" (every segment is a column title, the first one names a party), the
    // first column of the next non-empty line is that party. Slash form "BILL TO / Cardinal Ridge Construction / Attn ..".
    const slash = /^\s*((?:bill(?:ed)?|sold|submitted)\s+to|prepared\s+for|customer|client|received\s+from)\s*\/\s*([^/]{3,80}?)\s*\//i.exec(L.t);
    const vslash = /^\s*(vendor|supplier|remit\s+to)\s*\/\s*([^/]{3,80}?)\s*\//i.exec(L.t);
    if (vslash) push("vendor", { page_no: L.page, line: L.line, verbatim: collapse(vslash[0]), label: `${vslash[1].toLowerCase()} block`, value: cleanName(vslash[2]) });
    // Role blocks in the slash form ("OWNER / Summit Dental Co. / ... | CONTRACTOR / Cardinal Ridge Construction / ..."): each role
    // names its party. Only when the roles map to different sides (one customer role, one vendor role).
    if (!slash && !vslash && /\s\/\s/.test(L.t)) {
      const blocks = L.t.split(/\s*\|\s*/).map((b) => /^\s*([A-Za-z' ]{3,30}?)\s*\/\s*([^/]{3,80}?)\s*(?:\/|$)/.exec(b)).filter(Boolean);
      const mapped = blocks.map((m) => ({ role: collapse(m[1]), name: cleanName(m[2]), quote: collapse(m[0]) }))
        .map((b) => ({ ...b, key: CUSTOMER_ROLES.test(b.role) ? "customer_name" : VENDOR_ROLES.test(b.role) ? "vendor" : null }))
        .filter((b) => b.key && /^[A-Z][A-Za-z0-9&.,'’ -]{2,80}$/.test(b.name));
      const keys = new Set(mapped.map((b) => b.key));
      if (mapped.length >= 2 && keys.size === mapped.length) for (const b of mapped) push(b.key, { page_no: L.page, line: L.line, verbatim: b.quote, label: `${b.role.toLowerCase()} block`, value: b.name });
    }
    if (slash) push("customer_name", { page_no: L.page, line: L.line, verbatim: collapse(slash[0]), label: `${slash[1].toLowerCase()} block`, value: cleanName(slash[2]) });
    else if (segs.length >= 2 && segs.every((s) => COLUMN_HEAD.test(s) || ROLE_HEAD.test(s))) {
      let j = i + 1;
      while (j < lines.length && !lines[j].t.trim() && lines[j].page === L.page) j++;
      const next = lines[j];
      if (next && next.page === L.page) {
        const ns = segmentsOf(next.t);
        const nameLike = (v) => v && /^[A-Z][A-Za-z0-9&.,'’ -]{2,80}$/.test(v) && !COLUMN_HEAD.test(v) && !ROLE_HEAD.test(v) && !/^\d/.test(v) && !/^attn\b/i.test(v);
        if (ns.length === segs.length) {
          // Aligned columns ("OWNER   CONTRACTOR   PROJECT SITE" / "LANDLORD   TENANT"): each role column names its party.
          segs.forEach((h, k) => {
            const head = h.replace(/[:\s]+$/, "");
            const key = PARTY_HEAD.test(head) || CUSTOMER_ROLES.test(head) ? "customer_name" : (VENDOR_ROLES.test(head) || /^remit\s+(?:to|payment\s+to)$/i.test(head)) ? "vendor" : null;
            if (key && nameLike(ns[k])) push(key, { page_no: next.page, line: next.line, verbatim: collapse(next.t), label: `${head.toLowerCase()} column`, value: cleanName(ns[k]) });
          });
        } else if (PARTY_HEAD.test(segs[0]) && ns.length >= 2 && nameLike(ns[0])) {
          // The block's next line is columnar but wraps differently: only the first (party) column is trusted.
          push("customer_name", { page_no: next.page, line: next.line, verbatim: collapse(next.t), label: `${segs[0].toLowerCase()} column`, value: cleanName(ns[0]) });
        }
      }
    }

    // A service-address column ("CUSTOMER   SERVICE ADDRESS"): the street printed in that column on the aligned lines below.
    {
      const k = segs.length >= 2 && segs.every((x) => COLUMN_HEAD.test(x)) ? segs.findIndex((x) => SERVICE_HEAD.test(x)) : -1;
      if (k >= 0) {
        for (let j = i + 1; j < Math.min(lines.length, i + 7) && lines[j].page === L.page && lines[j].t.trim(); j++) {
          const ns = segmentsOf(lines[j].t);
          if (ns.length !== segs.length) continue;
          if (STREET.test(ns[k])) { push("service_address", { page_no: lines[j].page, line: lines[j].line, verbatim: collapse(lines[j].t), label: `${segs[k].toLowerCase()} column`, value: collapse(ns[k]).replace(/[,;]+$/, "") }); break; }
        }
      }
      const sl = /^(.*?\|\s*)?\s*(service\s+(?:address|location|site)|project\s+location|job\s*site|site\s+address|premises)\s*\/\s*([^|]+)/i.exec(L.t);
      if (sl) {
        const street = sl[3].split("/").map((x) => x.trim()).find((x) => STREET.test(x));
        if (street) push("service_address", { page_no: L.page, line: L.line, verbatim: collapse(L.t), label: `${sl[2].toLowerCase()} block`, value: collapse(street) });
      }
    }

    // A party label alone on its line ("BILL TO" / "RECEIVED FROM"), the party's name on the next line.
    if (segs.length === 1 && PARTY_HEAD.test(segs[0])) {
      let j = i + 1;
      while (j < lines.length && !lines[j].t.trim() && lines[j].page === L.page) j++;
      const next = lines[j];
      const v = next && next.page === L.page ? segmentsOf(next.t)[0] : null;
      if (v && /^[A-Z][A-Za-z0-9&.,'’ -]{2,80}$/.test(v) && !COLUMN_HEAD.test(v) && !/^attn\b/i.test(v) && !/\d{3,}/.test(v)) {
        push("customer_name", { page_no: next.page, line: next.line, verbatim: collapse(next.t), label: `${segs[0].toLowerCase()} block`, value: cleanName(v) });
      }
    }
    // A party label and its value side by side ("Bill To | Cardinal Ridge Construction", a spreadsheet row).
    for (let s2 = 0; s2 + 1 < segs.length; s2++) {
      if (!/^(?:bill(?:ed)?\s+to|sold\s+to|customer|client|received\s+from|tenant|donor|submitted\s+to|prepared\s+for)\s*:?$/i.test(segs[s2])) continue;
      const v = segs[s2 + 1];
      if (/^[A-Z][A-Za-z0-9&.,'’ -]{2,80}$/.test(v) && !COLUMN_HEAD.test(v) && !/^attn\b/i.test(v) && !/\d{3,}/.test(v)) push("customer_name", { page_no: L.page, line: L.line, verbatim: collapse(L.t), label: segs[s2].toLowerCase(), value: cleanName(v) });
    }

    // Labelled pairs within segments: "License No.   JP-860244", "Policy Expires:  June 23, 2026".
    for (let s = 0; s < segs.length; s++) {
      let label = segs[s].replace(/[:#]\s*$/, (x) => (x.trim() === "#" ? "#" : "")).trim();
      let value = segs[s + 1];
      const inline = /^([^:]{3,40}):\s*(.+)$/.exec(segs[s]);
      if (inline) { label = inline[1].trim(); value = inline[2].trim(); }
      if (!value) continue;
      // A job / work-order number is this paper's own number only on a work order or service ticket.
      const jobNo = /^(?:job|wo|work\s+order)\s*(?:no\.?|number|#)$/i.test(label) && ["work-order", "service-ticket"].includes(String(opts.type ?? ""));
      for (const [key, re] of Object.entries(LABELS)) {
        if (!re.test(label) && !(key === "invoice_number" && jobNo)) continue;
        if (key === "service_date" && !DOC_DATE_TYPES.has(String(opts.type ?? ""))) continue;
        if (key === "service_date" && String(opts.type ?? "") === "agreement" && !/^(?:date|contract\s+date|agreement\s+date)$/i.test(label)) continue;
        if (key === "service_date" && String(opts.type ?? "") !== "agreement" && /^(?:contract|agreement)\s+date$/i.test(label)) continue;
        if (key === "service_date" && String(opts.type ?? "") === "inspection-report" && !/inspect/i.test(label)) continue;
        if (key === "service_address" && !STREET.test(String(value).split(",")[0].trim())) continue;
        // "Date Issued" starts a licence; on any other paper it is the paper's own date, never the start of a period.
        if (key === "start_date" && /issu/i.test(label) && String(opts.type ?? "") !== "license-certification") continue;
        if (key.endsWith("_date")) {
          const dm = new RegExp(`^(${D})`, "i").exec(value);
          if (!dm || !parseDate(dm[1])) continue;
          value = dm[1];
        } else if (key === "service_address") {
          value = String(value).split(",")[0].trim(); // the street; the city may wrap onto the next line
        } else if (key === "warranty_term") {
          if (!/\b\d{1,2}\s*(?:-\s*)?(?:years?|yrs?|months?)\b/i.test(value)) continue;
        } else {
          if (key === "serial_number") value = String(value).replace(/^(?:s\/n[:#\s]*|sn[:#\s]+)/i, "");
          if (!/^[A-Z0-9][A-Z0-9-]{2,24}$/i.test(value) || !/\d/.test(value)) continue;
        }
        push(key, { page_no: L.page, line: L.line, verbatim: collapse(L.t), label: label.toLowerCase(), value: collapse(value), conf: 0.9 });
      }
      // Totals
      const lab = label.replace(/[:.]+$/, "").trim();
      const money = /^\(?-?(?:USD|US\$|\$)?\s*\$?\s*(-?[\d,]+\.\d{2})\)?$/i.exec(String(value).replace(/\s+(?:USD)$/i, "").trim());
      if (money) {
        if (SUBTOTAL.test(lab)) subs.sub.push({ v: normalizeNumber(money[1], { money: true }), page: L.page });
        else if (TAX.test(lab)) subs.tax.push({ v: normalizeNumber(money[1], { money: true }), page: L.page });
        else if (ADJUST.test(lab) && !TOTAL_TIERS.some(([, re]) => re.test(lab))) subs.adjust = true;
        const negative = /^\s*(?:\(|-|(?:USD|US\$|\$)\s*-)/i.test(String(value)) || /^-/.test(money[1]);
        if (negative && !/credit|refund/i.test(lab)) { subs.adjust = true; continue; }
        for (const [tier, re] of TOTAL_TIERS) {
          if (re.test(lab)) { totals.push({ tier, label: lab.toLowerCase(), raw: money[1], v: normalizeNumber(money[1], { money: true }), L }); break; }
        }
      }
    }
  }
  // "THIS IS NOT A BILL" (an explanation of benefits, a statement of account for information): no amount is the paper's total.
  const notABill = (pages ?? []).some((p) => /\bthis\s+is\s+not\s+a\s+bill\b/i.test(String(p?.text ?? "")));
  if (totals.length && !notABill && (!want || want.has("cost"))) {
    const best = Math.min(...totals.map((t) => t.tier));
    const top = totals.filter((t) => t.tier === best);
    const distinct = [...new Set(top.map((t) => t.v))];
    // A stronger and a weaker total that disagree, with no adjustment line between them, is two readings of one fact.
    const tier2 = totals.filter((t) => t.tier === 2 && t.tier !== best);
    if (distinct.length !== 1) ambiguous.push({ key: "cost", reason: "two different totals", values: distinct });
    else if (best === 1 && tier2.some((t) => t.v !== distinct[0]) && !(subs.adjust && new Set(tier2.map((t) => t.v)).size === 1)) ambiguous.push({ key: "cost", reason: "total and amount due disagree", values: [distinct[0], ...tier2.map((t) => t.v)] });
    else {
      // A total and a smaller amount due with payments / deposits / credits printed between them: the paper's amount is the total.
      const useTotal = best === 1 && tier2.length && tier2.every((t) => t.v !== distinct[0]) && subs.adjust;
      const t = useTotal ? tier2[tier2.length - 1] : top[top.length - 1];
      const checks = [];
      // subtotal + tax = total (only when the page prints exactly one of each and no adjustment line)
      if (subs.sub.length === 1 && subs.tax.length === 1 && !subs.adjust && best <= 2) {
        const sum = Math.round((Number(subs.sub[0].v) + Number(subs.tax[0].v)) * 100);
        if (Math.abs(sum - Math.round(Number(t.v) * 100)) > 1) { ambiguous.push({ key: "cost", reason: "subtotal + tax does not equal total", values: [subs.sub[0].v, subs.tax[0].v, t.v] }); }
        else checks.push("subtotal+tax=total");
      }
      // A zero balance after payments is not the paper's amount: left for a person.
      if (Number(t.v) === 0) ambiguous.push({ key: "cost", reason: "zero amount", values: [t.raw] });
      if (!ambiguous.some((a) => a.key === "cost")) push("cost", { page_no: t.L.page, line: t.L.line, verbatim: collapse(t.L.t), label: t.label, value: t.raw, conf: checks.length ? 0.9 : 0.88, ...(checks.length ? { checks } : {}) });
    }
  }

  // An amendment / addendum may change the term: the original sentence is not the current term. Left for a person.
  if (/^\s*(?:(?:first|second|third|fourth|fifth|\d+(?:st|nd|rd|th)?)\s+)?(?:amendment|addendum)\b|\bhereby\s+(?:amend|modif)\w*|\bparties\s+amend\b/im.test((pages ?? []).map((p) => p?.text ?? "").join("\n"))) {
    for (const k of ["agreement_term", "start_date", "end_date"]) if (out[k]?.length) { ambiguous.push({ key: k, reason: "amendment present", values: out[k].map((c) => c.value) }); delete out[k]; }
  }
  // "begins X" names the start; an "entered into on" / "dated" date alongside it is only when the paper was signed.
  if (out.start_date?.some((c) => c.label === "begin sentence")) out.start_date = out.start_date.filter((c) => c.label === "begin sentence");
  // One fact, one value: candidates for a key that disagree are left for a person.
  const result = {};
  for (const [key, list] of Object.entries(out)) {
    const norm = (c) => (key.endsWith("_date") ? parseDate(c.value) : key === "cost" ? normalizeNumber(c.value, { money: true }) : key === "agreement_term" ? c.value.replace(/\s+/g, " ").toLowerCase().replace(/\s*\(.*$/, "") : c.value.toLowerCase());
    const distinct = [...new Set(list.map(norm))];
    if (key === "agreement_term") {
      // A full "N months (X - Y)" reading wins over a partial reading of the same sentence.
      const full = list.filter((c) => c.checks?.includes("start+term=end"));
      const pick = full.length ? full : list;
      if (new Set(pick.map((c) => c.value.toLowerCase())).size === 1) { result[key] = [pick[0]]; continue; }
      ambiguous.push({ key, reason: "two different terms", values: [...new Set(pick.map((c) => c.value))] });
      continue;
    }
    if (distinct.length === 1) result[key] = [list.find((c) => c.checks) ?? list[0]];
    else ambiguous.push({ key, reason: "two different values", values: [...new Set(list.map((c) => c.value))] });
  }
  return { candidates: result, ambiguous };
}
