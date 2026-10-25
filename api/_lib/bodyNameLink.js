/**
 * Link a document to a customer named in its BODY - deterministic, no model, no cost.
 *
 * Owner-reported defect (2026-09-23): an internal memo / piece of correspondence such as "Reminder logged for
 * David Prentiss's account: confirm filter size on next visit" showed "Missing required field: Customer" and
 * "Not linked to any record", because extraction only sets customer_name from a printed field and the
 * memo's body never had one.
 *
 * For a document with NO customer link, scan its page text for the FULL name (first + last, or a business
 * name of 2+ words) or the street address of the tenant's EXISTING customers, with strict rules (owner rule:
 * near-misses go to review, never auto):
 *
 *   exactly one distinct customer matches (by full name and/or address)     -> LINK it: fills the missing
 *       customer_name extraction and writes a document_entity_links row with linked_by = 'name-in-body'
 *       (the UI shows "Linked from name in document - confirm"; it is non-blocking, and nothing else in the
 *       integrity code ever re-points a 'name-in-body' link automatically);
 *   two or more customers match (a repeated full name, a name and an address that disagree)  -> 'ambiguous':
 *       NEVER auto - reported as "Needs your review" with the candidates;
 *   no full-name/address match but a capitalized surname of exactly one/several customers appears -> 'partial':
 *       NEVER auto - reported as "Needs your review".
 *
 * Re-check-all round 2 (2026-10-25) safety rules, applied on EVERY path that calls this (ingest, "Fix everything", the nightly
 * sweep, Re-check this document, Verify with AI, Re-check all open papers):
 *   - the tenant's own company (any Inc / LLC / "The" variation) is never a customer (loadOwnNames / ownCompany.js);
 *   - only the CUSTOMER side of the paper counts: text under Bill to / Ship to / Sold to / Service address / Customer ... (also in
 *     multi-column layouts). The vendor, remit-to, "From" blocks and the letterhead are ignored; a name or street that also appears
 *     in the vendor block is ambiguous and never links;
 *   - a link never contradicts the paper's own printed customer_name fact (a person's correction wins over the read value);
 *   - a VOID paper, a copy and any other set-aside paper is never linked.
 *
 * Only ever matches the calling tenant's own customers (every read runs through withTenant + RLS). Never
 * creates a customer. A document a person explicitly unlinked (review.document_unlinked) is left alone.
 * Runs at ingest (extractDocument.js, after extraction) and as the `linkBodyNames` integrity fix
 * (the "Fix everything" button and the nightly sweep).
 */
import { withTenant, linkDocumentToCustomer } from "./recordsStore.js";
import { loadOwnNames, isOwnName } from "./modelAvoidance/ownCompany.js";
import { COMPANY_FOLDER_FIELD_KEY, HR_FOLDER_ID } from "./companyFiles.js";
import { isVoidMarked, isLikelyCopyName, isLabelValue, normalizeDocumentType } from "./documentTypes.js";

export const BODY_NAME_LINKED_BY = "name-in-body";
const CUSTOMER_CAP = 5000;
const DOC_BATCH = 200;
const MIN_SURNAME_LEN = 4;

const TENANT = "(current_setting('app.tenant_id', true))::uuid";

/* ------------------------------------------------------------------ pure matching */

/** Lowercase alnum tokens; possessives dropped ("Prentiss's" -> "prentiss"), punctuation to spaces. */
export function nameTokens(s) {
  return String(s ?? "")
    .replace(/[’']s\b/gi, "")
    .toLowerCase()
    .replace(/[^a-z0-9À-ɏ]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

const norm = (s) => nameTokens(s).join(" ");
const contains = (hay, needle) => needle.length > 0 && ` ${hay} `.includes(` ${needle} `);

/** "Customer at 412 Elm St" style placeholders carry no real name. */
const isPlaceholderName = (c) => c.nameSource === "address" || /^customer at\b/i.test(c.name ?? "");

/** The house-number + street part of an address ("412 Elm St, Mesa, AZ 85201" -> "412 elm st"), or "" if none. */
export function streetOf(address) {
  const first = String(address ?? "").split(",")[0];
  const t = nameTokens(first);
  return t.length >= 3 && /^\d/.test(t[0]) ? t.join(" ") : "";
}

/* ---- customer-side zones ------------------------------------------------------------------------------------------ */

// Party labels. STRONG labels are phrases that are labels wherever they stand ("Bill To", "Service Address"); WEAK labels are ordinary words
// ("Customer", "From", "Owner", "Company") and count as a label only when followed by a colon, a dash, the end of the line or a column gap -
// so "Customer Service: Jane" and "Client Signature:" are not labels.
const STRONG_CUSTOMER = String.raw`bill(?:ed)?\s*to|invoice\s*to|ship(?:ped)?\s*to|sold\s*to|deliver(?:ed)?\s*to|received\s*from|service\s*(?:address|location|site)|job\s*(?:site|address|location)|work\s*(?:address|location|site)|site\s*address|install(?:ation)?\s*address|property\s*address|project\s*(?:location|address|site)|billing\s*address|submitted\s*(?:to|for)|prepared\s*for|customer\s*(?:name|address)|client\s*name|account\s*(?:holder|name)|property\s*/?\s*owner|registered\s*owner|registrant|purchaser|home\s*owner|homeowner|end\s*user|credit\s*to|facturar\s*a|vendido\s*a|enviar\s*a|direcci[o\u00f3]n\s*de\s*servicio`;
const STRONG_VENDOR = String.raw`bill\s*from|ship(?:ped)?\s*from|remit(?:tance)?\s*(?:to|address|payment)|pay(?:ment)?\s*to|make\s*(?:checks?|cheques?)\s*payable\s*to|payable\s*to|issued\s*by|sold\s*by|billed\s*by|serviced\s*by|performed\s*by|mail\s*payments?\s*to|servicing\s*company|install(?:ing|er)\s*(?:dealer|contractor|company)|installer|selling\s*dealer|servicing\s*dealer|dealer\s*name|distributor|manufacturer`;
const WEAK_CUSTOMER = String.raw`customer|client|owner|to|grantee|cliente|para`;
const WEAK_VENDOR = String.raw`from|vendor|supplier|seller|remit|contractor|technician|company|merchant|payee|funder|grantor|proveedor|emisor|de`;
const KIND_CUSTOMER_RE = new RegExp(String.raw`^(?:${STRONG_CUSTOMER}|${WEAK_CUSTOMER})$`, "i");
const WEAK_END = String.raw`(?=[ \t]*:|[ \t]*[-–][ \t]|[ \t]*$|[ \t]{2,}|\t|[ \t]*\|)`;
const HDR_RE = new RegExp(String.raw`(?<=^|\s\s|\t|\|)\s*((?:${STRONG_CUSTOMER}|${STRONG_VENDOR})\b|(?:${WEAK_CUSTOMER}|${WEAK_VENDOR})\b${WEAK_END})[ \t]*(?::|[-–](?=\s))?[ \t]*`, "gi");
// Collapsed OCR lines ("Bill To Walk-in From John Smith Heating"): after the first label, any further party label splits the line, single space or not.
const INLINE_RE = new RegExp(String.raw`(?:^|\s)((?:${STRONG_CUSTOMER}|${STRONG_VENDOR})\b|(?:from|vendor|supplier|seller|remit|contractor|technician|payee|merchant)\b|(?:customer|client|owner|company)(?=[ \t]*:))[ \t]*(?::|[-–](?=\s))?[ \t]*`, "gi");
const GENERIC_LABEL_RE = /^\s*(?!attn\b|attention\b)[A-Za-z][A-Za-z #./&]{1,28}:\s/i;
const LETTERHEAD_RE = /(?:\(?\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}|@[a-z0-9.-]+\.[a-z]{2,}|www\.|https?:|\b(?:inc|llc|l\.l\.c|ltd|corp|co\.|heating|cooling|air|hvac|plumbing|mechanical|electric|electrical|services?|roofing|refrigeration|contractors?)\b|\b\d{1,6}\s+[A-Za-z0-9 .]{2,30}\b(?:st|street|rd|road|ave|avenue|blvd|dr|drive|ln|lane|way|ct|court|pkwy|hwy)\b)/i;
const FOOTER_VENDOR_RE = /\b(?:remit|payable\s+to|make\s+(?:checks?|cheques?)|pay\s+to|mail\s+payments?)\b/i;
/** Real US state codes (upper case only: "Co" / "LP" / "Inc" are not states). */
const STATE_RE = "(?:A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])";
const STREET_WORD = "(?:st|street|rd|road|ave|avenue|blvd|boulevard|dr|drive|ln|lane|way|ct|court|pkwy|parkway|hwy|highway|cir|circle|pl|place|ter|terrace|trl|trail|loop|run|row|pike)";
const COMPANY_WORD_RE = /\b(?:inc|incorporated|llc|l\.l\.c|ltd|corp|corporation|co|lp|llp|pllc|heating|cooling|air|hvac|plumbing|mechanical|electric|electrical|services?|supply|supplies|roofing|refrigeration|contractors?|construction|group|company)\b/i;
const ADDRESS_STREET_RE = new RegExp(`^\\s*\\d{1,6}[A-Za-z]?\\s+[\\w .'#-]*?\\b${STREET_WORD}\\b\\.?(?:[ ,]|$)`, "i");
const ADDRESS_CITY_RE = new RegExp(`^[A-Z][A-Za-z .'-]+,?\\s+${STATE_RE}\\s+\\d{5}(?:-\\d{4})?\\s*$|^[A-Z][A-Za-z .'-]+,\\s*${STATE_RE}\\.?\\s*$`);
const ADDRESS_UNIT_RE = /^\s*(?:p\.?\s?o\.?\s*box\s*\d+|(?:suite|ste|unit|apt|apartment|bldg|building|floor|fl)\.?\s*#?\w+|#\s*\w+)\b/i;
/** A line that may follow a party label's value as part of the SAME address: street, unit / PO box, "City, ST zip". Never a line with a company word. */
export function isAddressContinuation(line) {
  const t = String(line ?? "").trim();
  if (!t || t.length > 80) return false;
  if (ADDRESS_UNIT_RE.test(t)) return true;
  if (COMPANY_WORD_RE.test(t)) return false;
  return ADDRESS_STREET_RE.test(t) || ADDRESS_CITY_RE.test(t);
}
/** "Customer Service: ...", "Client Signature: ...": role phrases that begin with a party word but are not party labels. Never read as a customer. */
const FALSE_LABEL_RE = /^\s*(?:customer|client)s?\s+(?:service|services|care|support|signature|relations|satisfaction|rep|representative|copy|agreement|acknowledg\w*|initials|notes?|comments?)\b/i;
const PHONE_WEB_RE = /(?:\(?\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}|@[a-z0-9.-]+\.[a-z]{2,}|www\.|https?:)/i;
const ATTN_RE = /^\s*(?:attn|attention)\b/i;
const ZONE_LINES = 4;

// Labels that are ordinary short words ("To", "De", "Para"): a label only when it is the FIRST thing on the line.
const LINE_START_ONLY = new Set(["to", "de", "para"]);
// OCR confusions inside the label words, same length so every index still lines up: "BiII To", "Bi11", "B1LL", "Sold T0", "Sh1p To", "Rem1t".
const OCR_FIXES = [[/\bB[iI1lL!|]{3}(?=\s*[T7]\w)/g, "Bill"], [/\bS[o0]ld(?=\s*[T7])/gi, "Sold"], [/\bSh[i1!]p(?=\s*[T7])/gi, "Ship"], [/\bRem[i1!]t(?=\s*[T7])/gi, "Remit"], [/\bT0\b/g, "To"], [/\bt0\b/g, "to"]];
/** The text label detection runs on: same length as `line`; leading bullets / "Row 5 |" / table pipes blanked, OCR look-alikes fixed. */
function detectionForm(line) {
  let t = line.replace(/^(\s*)(?:Row\s+\d+\s*\|\s*|[\u2022*\u00b7\u25ba>\-\u2013]\s+|\|\s*)/i, (m) => " ".repeat(m.length));
  for (const [re, to] of OCR_FIXES) t = t.replace(re, (m) => (to.length === m.length ? to : m));
  return t;
}

function headersOf(rawLine) {
  const line = detectionForm(rawLine);
  const out = [];
  HDR_RE.lastIndex = 0;
  let m;
  while ((m = HDR_RE.exec(line))) {
    const labelAt = m.index + m[0].indexOf(m[1]);
    const lbl = m[1].toLowerCase().replace(/\s+/g, " ").trim();
    if (LINE_START_ONLY.has(lbl) && line.slice(0, labelAt).trim() !== "") { if (m[0].length === 0) HDR_RE.lastIndex++; continue; }
    out.push({ index: m.index, end: HDR_RE.lastIndex, kind: KIND_CUSTOMER_RE.test(m[1].toLowerCase().replace(/\s+/g, " ").trim()) ? "customer" : "vendor" });
    if (m[0].length === 0) HDR_RE.lastIndex++;
  }
  if (out.length) {
    INLINE_RE.lastIndex = 0;
    while ((m = INLINE_RE.exec(line))) {
      const at = m.index + (m[0].length - m[0].trimStart().length);
      if (at < out[0].end || out.some((h) => at >= h.index && at < h.end)) { if (m[0].length === 0) INLINE_RE.lastIndex++; continue; }
      out.push({ index: at, end: INLINE_RE.lastIndex, kind: KIND_CUSTOMER_RE.test(m[1].toLowerCase().replace(/\s+/g, " ").trim()) ? "customer" : "vendor" });
    }
    out.sort((x, y) => x.index - y.index);
  }
  return out;
}

/** Word/DOCX tables come out as one line: "TO / Harborlight Neighbors Alliance / Attn: Gordon Patel / 7714 N Aspen Way". When the first piece is only a party
 *  label, the pieces are really separate lines. */
function expandTableLines(lines) {
  const out = [];
  for (const l of lines) {
    if (l.includes(" / ")) {
      const parts = l.split(" / ").map((x) => x.trim());
      const hs = parts[0] ? headersOf(parts[0]) : [];
      if (hs.length === 1 && hs[0].index === 0 && parts[0].slice(hs[0].end).trim() === "") { out.push(...parts.filter(Boolean)); continue; }
    }
    out.push(l);
  }
  return out;
}

/**
 * Pure: split a paper's page text into the customer side, the vendor/issuer side and everything else.
 * Returns {customer: string[], vendor: string[], free: string[], structured: boolean}. A paper with NO party label at all (a memo, a letter)
 * is "free text": its body counts, minus the issuer (a first line that is only a name, and the address / phone lines right under it), any
 * letterhead and remit footers. A paper with any party label counts ONLY its customer zones.
 * A label's block is its same-line value plus, when that is empty, the next line; after that only address-looking lines
 * (house number, PO box, suite, "City, ST 85201") - so "Bill To: Walk-in" followed by a vendor name never reads the vendor as the customer.
 * Multi-column layouts ("BILL TO    SHIP TO" over two columns): a row of cells is read column by column; a row whose cells do not line up
 * with the headers is dropped (safe side).
 * @param {{page_no: number, text: string}[]} pages
 */
export function splitPartyZones(pages) {
  const customer = [], vendor = [], free = [], customerValues = [], wrapped = [];
  let structured = false;
  pages.forEach((p, pi) => {
    const lines = expandTableLines(String(p.text ?? "").split(/\r?\n/));
    let state = null; // {kinds:[...], left:n, filled:bool, blankUsed:bool}
    let seenNonEmpty = 0;
    let lastWasIssuer = false;
    for (let li = 0; li < lines.length; li++) {
      const raw = lines[li];
      const line = raw.replace(/\s+$/, "");
      if (!line.trim()) {
        // A label's value is on its own line or the very next one. One blank line is forgiven only after a customer label that is alone on its line
        // (scans put a gap there); the value must still BE the customer's name, so a vendor line after the gap cannot link.
        if (state && !state.filled && !state.blankUsed && state.kinds.length === 1 && state.kinds[0] === "customer") state.blankUsed = true; else state = null;
        lastWasIssuer = false;
        continue;
      }
      const hs = headersOf(line);
      seenNonEmpty++;
      if (hs.length) {
        structured = true;
        let filled = false;
        hs.forEach((h, i) => {
          const text = line.slice(h.end, i + 1 < hs.length ? hs[i + 1].index : undefined).replace(/^[\s|]+|[\s|]+$/g, "");
          if (text) { (h.kind === "customer" ? customer : vendor).push(text); if (h.kind === "customer") {
            customerValues.push(text);
            const first = text.split(/\s{2,}|\t|\|/)[0]?.trim(); // "Client   Jerem Thornton   Client ID   C-1034": the value is the first cell
            if (first && first !== text) customerValues.push(first);
          }
          filled = true; }
        });
        // R6.2: a labelled "Customer: Maria" whose value wraps onto the next line ("Lopez") is the same label's value. Only a bare, short, letters-only
        // continuation counts, and the joined text must still BE the customer's whole name to link (lineIsName), so nothing weaker gets through.
        if (hs.length === 1 && hs[0].kind === "customer" && lines[li + 1] !== undefined) {
          const v0 = line.slice(hs[0].end).replace(/^[\s|]+|[\s|]+$/g, ""), nx = lines[li + 1].trim();
          const WORDS = /^[A-Za-z][A-Za-z.'\u2019-]*(?:\s+[A-Za-z][A-Za-z.'\u2019-]*){0,2}$/;
          if (v0 && nx && WORDS.test(v0) && v0.split(/\s+/).length <= 2 && WORDS.test(nx) && !headersOf(nx).length && !ATTN_RE.test(nx) && !FALSE_LABEL_RE.test(nx) && !isAddressContinuation(nx)) { customerValues.push(`${v0} ${nx}`); wrapped.push({ first: v0, joined: `${v0} ${nx}` }); }
        }
        state = { kinds: hs.map((h) => h.kind), left: ZONE_LINES, filled, blankUsed: false };
        lastWasIssuer = false;
        continue;
      }
      if (state && state.left > 0) {
        // A generic "Label: value" line ("Invoice #: 5", "Date: ...") closes the zone.
        if (GENERIC_LABEL_RE.test(line)) state = null;
        else if (state.kinds.length === 1) {
          // A name followed (within two lines) by a phone, e-mail or web line is a letterhead, not a customer block.
          const letterheadBlock = !state.filled && [lines[li + 1], lines[li + 2]].some((x) => x !== undefined && x.trim() !== "" && PHONE_WEB_RE.test(x));
          if (letterheadBlock) { vendor.push(line.trim()); state = null; lastWasIssuer = false; continue; }
          if (!state.filled || isAddressContinuation(line)) {
            const isValue = !state.filled;
            state.filled = true; state.left--;
            if (!ATTN_RE.test(line)) { // an "Attn: <contact>" line names a person AT the customer, not another customer
              (state.kinds[0] === "customer" ? customer : vendor).push(line.trim());
              if (isValue && state.kinds[0] === "customer") {
                customerValues.push(line.trim());
                const first = line.trim().split(/\s{2,}|\t|\|/)[0]?.trim(); // "Maria Lopez    C-1009" (a Client ID column beside the name)
                if (first && first !== line.trim()) customerValues.push(first);
              }
            }
            continue;
          }
          state = null; // a name after an already-filled value belongs to something else (usually the vendor)
        } else {
          state.left--;
          const cells = line.trim().split(/\s{2,}|\t|\|/).map((c) => c.trim()).filter(Boolean);
          if (cells.length === state.kinds.length) {
            const isValue = !state.filled;
            state.filled = true;
            cells.forEach((c, i) => { if (!ATTN_RE.test(c)) { (state.kinds[i] === "customer" ? customer : vendor).push(c); if (isValue && state.kinds[i] === "customer") customerValues.push(c); } });
          }
          // else: cannot tell whose column it is - dropped on purpose.
          continue;
        }
      }
      // The first line of an unlabelled paper is the issuer when it is short (a name in ANY case, as OCR gives it); a long sentence is a memo.
      const issuerLine = pi === 0 && seenNonEmpty === 1 && !/[:.!?]\s*$/.test(line.trim()) && line.trim().split(/\s+/).length <= 6;
      const letterhead = pi === 0 && seenNonEmpty <= 5 && LETTERHEAD_RE.test(line);
      const underIssuer = lastWasIssuer && (isAddressContinuation(line) || ADDRESS_UNIT_RE.test(line));
      if (FALSE_LABEL_RE.test(line)) { lastWasIssuer = false; continue; }
      if (issuerLine || letterhead || underIssuer || FOOTER_VENDOR_RE.test(line)) { vendor.push(line.trim()); lastWasIssuer = issuerLine || letterhead || underIssuer; }
      else { free.push(line.trim()); lastWasIssuer = false; }
    }
  });
  return { customer, customerValues, vendor, free, structured, wrapped };
}

/** Does the printed customer name `printed` belong to the customer named `custName`? Equal, one inside the other (2+ words), or same surname + first initial. */
export function printedNameMatches(printed, custName) {
  const a = nameTokens(printed), b = nameTokens(custName);
  if (!a.length || !b.length) return false;
  if (a.join(" ") === b.join(" ")) return true;
  const ka = nameKeyOf(printed), kb = nameKeyOf(custName);
  if (ka && ka === kb) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 2 && contains(long.join(" "), short.join(" "))) return true;
  if (a.length >= 2 && b.length >= 2 && a[a.length - 1] === b[b.length - 1] && a[0][0] === b[0][0] && (a[0].length === 1 || b[0].length === 1)) return true;
  return false;
}
const nameKeyOf = (s) => nameTokens(s).filter((t) => !/^(?:inc|incorporated|llc|ltd|limited|corp|corporation|co|company|the|lp|llp|pllc|pc)$/.test(t)).join(" ");

/** A paper the Inbox sets aside on its own: VOID, or a copy by its file name. The server's twin of the browser's isSetAside. */
export function isSetAsidePaper({ filename = null, title = null, text = null } = {}) {
  return isVoidMarked({ filename, title, text }) || isLikelyCopyName(filename) || isLikelyCopyName(title);
}

const LEGAL_WORDS = new Set(["inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation", "co", "company", "lp", "llp", "pllc", "pc", "the"]);

/** Is `line` (a party label's VALUE) just this customer's name - optionally followed by a legal suffix or an inline street address? */
function lineIsName(line, nameKey) {
  const t = nameTokens(line), k = nameKey.split(" ");
  if (t.length < k.length) return false;
  for (let i = 0; i < k.length; i++) if (t[i] !== k[i]) return false;
  const rest = t.slice(k.length);
  return rest.length === 0 || rest.every((x) => LEGAL_WORDS.has(x)) || /^\d/.test(rest[0]);
}

/**
 * Pure: which customers does the paper name on its CUSTOMER side? Returns
 * {status: 'unique'|'ambiguous'|'partial'|'none', matches: [{customerId, name, basis}], candidates: [{customerId, name}], page?, refused?}
 *
 * ROUND 4 PRINCIPLE - auto-link only on STRONG evidence; anything weaker is "partial" (listed for a person, never linked):
 *   (a) the customer's name IS the value of a customer label ("Bill To: Maria Lopez", or the label alone and the name on the very next
 *       line; a legal suffix or an inline street address may follow) - not merely a name somewhere in the text; or
 *   (b) the customer's name AND street address both appear on the customer side (the labelled zones, or the body of a paper with no
 *       labels at all, which is never its first short line, letterhead or remit footer).
 * Any other customer found on the customer side (a second name, a street of someone else) makes it 'ambiguous'. A name or street that
 * also sits in the vendor block never links. A missed link costs a click in "Needs linking"; a wrong one costs trust.
 * `refused` names the safety rule that stopped a link ('own-company' | 'printed-name' | 'vendor-shared').
 * `pages` is [{page_no, text}]; the first page with a match is reported.
 * @param {{page_no: number, text: string}[]} pages
 * @param {{id: string, name: string, address?: string, nameSource?: string}[]} customers
 * @param {{ownNames?: string[], printedName?: string|null, zones?: boolean}} [opts] zones:false = the pre-round-2 whole-page behaviour (statistics only)
 */
export function findCustomersInBody(pages, customers, opts = {}) {
  const ownNames = opts.ownNames ?? [];
  const legacy = opts.zones === false;
  const zonesEarly = legacy ? null : splitPartyZones(pages);
  let printed = opts.printedName && !isLabelValue(opts.printedName) && !isOwnName(opts.printedName, ownNames) ? String(opts.printedName) : null;
  // R6.2: the read value of a wrapped "Customer: Maria" / "Lopez" is only its first line; the label's whole value is the two lines joined.
  if (printed && zonesEarly?.wrapped?.length) {
    const w = zonesEarly.wrapped.find((x) => nameTokens(x.first).join(" ") === nameTokens(printed).join(" "));
    if (w) printed = w.joined;
  }
  const usable = customers.filter((c) => !isOwnName(c.name, ownNames) && (!printed || printedNameMatches(printed, c.name)));
  let refused = null;
  if (usable.length < customers.length) refused = customers.some((c) => isOwnName(c.name, ownNames)) ? "own-company" : "printed-name";

  let scanLines, valueLines = [], vendorHay = "";
  const firstWith = pages.find((p) => norm(p.text));
  const pageNo = firstWith?.page_no ?? pages[0]?.page_no ?? 1;
  if (legacy) {
    scanLines = pages.map((p) => p.text ?? "");
  } else {
    const z = zonesEarly;
    scanLines = z.structured ? z.customer : z.free;
    valueLines = z.structured ? z.customerValues : [];
    vendorHay = norm(z.vendor.join("\n"));
  }
  const hay = norm(scanLines.join("\n"));

  const named = usable.filter((c) => !isPlaceholderName(c)).map((c) => ({ c, key: nameTokens(c.name).join(" ") })).filter((x) => nameTokens(x.c.name).length >= 2);
  const weak = new Map();   // id -> {customerId, name, nameHit, addrHit, valueHit}
  const touch = (c) => { if (!weak.has(c.id)) weak.set(c.id, { customerId: c.id, name: c.name, nameHit: false, addrHit: false, valueHit: false }); return weak.get(c.id); };
  if (hay) {
    for (const x of named) {
      if (contains(hay, x.key)) touch(x.c).nameHit = true;
      if (valueLines.some((v) => lineIsName(v, x.key))) touch(x.c).valueHit = true;
    }
    for (const c of usable) {
      const st = streetOf(c.address);
      if (st && contains(hay, st)) touch(c).addrHit = true;
    }
  }
  // A name or street that ALSO sits in the vendor / issuer block cannot be told apart from the issuer: never a link.
  if (vendorHay) {
    for (const [id, m] of [...weak]) {
      const c = usable.find((x) => x.id === id);
      const st = streetOf(c.address);
      if ((m.nameHit && contains(vendorHay, nameTokens(c.name).join(" "))) || (m.addrHit && st && contains(vendorHay, st))) { weak.delete(id); refused = "vendor-shared"; }
    }
  }
  const all = [...weak.values()];
  const strong = legacy ? all : all.filter((m) => m.valueHit || (m.nameHit && m.addrHit));
  const basisOf = (m) => (m.valueHit && m.addrHit ? "name-value+address" : m.valueHit ? "name-value" : m.nameHit && m.addrHit ? "name+address" : m.nameHit ? "full-name" : "address");
  const toMatch = (m) => ({ customerId: m.customerId, name: m.name, basis: legacy ? (m.nameHit && m.addrHit ? "full-name+address" : m.nameHit ? "full-name" : "address") : basisOf(m), page: pageNo });
  const cand = (list) => list.map(({ customerId, name }) => ({ customerId, name }));
  if (legacy) {
    if (all.length === 1) return { status: "unique", matches: all.map(toMatch), candidates: cand(all), page: pageNo };
    if (all.length > 1) return { status: "ambiguous", matches: all.map(toMatch), candidates: cand(all), page: pageNo };
  } else if (strong.length === 1 && all.length === 1) {
    return { status: "unique", matches: strong.map(toMatch), candidates: cand(strong), page: pageNo };
  } else if (strong.length >= 1) {
    return { status: "ambiguous", matches: all.map(toMatch), candidates: cand(all), page: pageNo, ...(refused ? { refused } : {}) };
  } else if (all.length) {
    // Weak evidence only (a name or a street, not both, not the label's value): listed for a person, never linked.
    return { status: "partial", weak: true, matches: [], candidates: cand(all), page: pageNo, ...(refused ? { refused } : {}) };
  }

  // Partial: a capitalized surname of a real customer appears on its own. Never auto.
  const partial = new Map();
  for (const text of scanLines) {
    const words = new Set((String(text ?? "").replace(/[’']s\b/g, "").match(/\b[A-Z][a-z]{3,}\b/g) ?? []).map((w) => w.toLowerCase()));
    if (!words.size) continue;
    for (const x of named) {
      const parts = x.key.split(" ");
      const surname = parts[parts.length - 1];
      if (surname.length >= MIN_SURNAME_LEN && words.has(surname) && !partial.has(x.c.id)) partial.set(x.c.id, { customerId: x.c.id, name: x.c.name, page: pageNo });
    }
  }
  if (partial.size) {
    const candidates = [...partial.values()];
    return { status: "partial", matches: [], candidates: cand(candidates), page: pageNo, ...(refused ? { refused } : {}) };
  }
  return { status: "none", matches: [], candidates: [], ...(refused ? { refused } : {}) };
}

/* ------------------------------------------------------------------ suggestions for a person */

/** Where a weak-evidence candidate list is kept for a person: an APPEND-ONLY audit_log row (action below, resource = the document, changes = {candidates:[{id,name}]}).
 *  It is NOT an extraction (a fact): no fact listing, search, export, Donovan lookup or editable field can ever see it, and it needs no migration.
 *  A suggestion is live only while the paper has no customer link and no person has linked or unlinked it since (see reviewStore.listLinks);
 *  an empty candidates row means "cleared". */
export const LINK_SUGGESTION_ACTION = "recheck.link_suggestion";

/** Idempotent: writes a row only when the newest one differs. Empty/null candidates write a "cleared" row only if a live suggestion exists. */
export async function setLinkSuggestion(db, documentId, candidates) {
  const list = (candidates ?? []).slice(0, 3).map((c) => ({ id: c.customerId ?? c.id, name: c.name }));
  const next = JSON.stringify(list);
  const cur = await db.raw(`SELECT changes FROM audit_log WHERE resource_id = $1::uuid AND action = $2::text AND tenant_id = ${TENANT} ORDER BY created_at DESC LIMIT 1`, [documentId, LINK_SUGGESTION_ACTION]);
  const last = cur.rows?.[0] ? JSON.stringify(cur.rows[0].changes?.candidates ?? []) : "[]";
  if (last === next) return false;
  await db.raw(`INSERT INTO audit_log (tenant_id, action, resource_type, resource_id, changes, created_at) VALUES (${TENANT}, $1::text, 'document', $2::uuid, $3::jsonb, NOW())`, [LINK_SUGGESTION_ACTION, documentId, JSON.stringify({ candidates: list })]);
  return true;
}

/** A name that is only a form label ("PROJECT LOCATION") is junk data, never a customer to link or suggest. */
const JUNK_WORDS = new Set("project job site service location address name customer client owner property bill ship to from date number no phone email work order invoice unknown none tbd na n/a contact".split(" "));
export function isJunkCustomerName(name) {
  const words = String(name ?? "").toLowerCase().replace(/[^a-z/ ]+/g, " ").split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => JUNK_WORDS.has(w));
}

/** The issuer's own signer ("Development Director: Colin Dunn", a closing signature) is not the customer: a candidate whose full name
 *  appears in the page only on such lines is not suggested. */
const ISSUER_ROLE_RE = /\b(director|manager|president|vice president|ceo|cfo|coo|founder|supervisor|coordinator|representative|estimator|technician|foreman|superintendent|account executive|administrator|signed|signature|sincerely|regards|prepared by|issued by|submitted by)\b/i;
export function isIssuerSigner(name, text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const needle = String(name ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!needle) return false;
  let seen = 0, roleOnly = 0;
  lines.forEach((ln, i) => {
    if (!ln.toLowerCase().replace(/\s+/g, " ").includes(needle)) return;
    seen++;
    const closing = [lines[i - 1], lines[i - 2]].some((p) => /^\s*(sincerely|regards|best regards|warm regards|respectfully|thank you|signed)\b/i.test(p ?? ""));
    if (ISSUER_ROLE_RE.test(ln) || closing) roleOnly++;
  });
  return seen > 0 && seen === roleOnly;
}

/* ------------------------------------------------------------------ data access */

async function loadCustomers(db) {
  const { rows } = await db.raw(
    `SELECT id, data->>'customer_name' AS name, data->>'service_address' AS address, data->>'name_source' AS name_source
       FROM entities
      WHERE entity_type = 'customer' AND merged_into IS NULL AND tenant_id = ${TENANT}
      ORDER BY created_at LIMIT ${CUSTOMER_CAP}`, []);
  return rows.filter((r) => (r.name || r.address) && !isJunkCustomerName(r.name)).map((r) => ({ id: r.id, name: r.name ?? "", address: r.address ?? "", nameSource: r.name_source ?? null }));
}

/** Documents with no customer link, page text present, never explicitly unlinked by a person. */
async function loadDocuments(db, documentId) {
  const { rows } = await db.raw(
    `SELECT d.id AS document_id, d.original_filename AS filename, d.document_type AS document_type
       FROM documents d
      WHERE d.tenant_id = ${TENANT} AND ($1::uuid IS NULL OR d.id = $1)
        AND NOT EXISTS (SELECT 1 FROM document_entity_links l JOIN entities e ON e.id = l.entity_id
                         WHERE l.document_id = d.id AND e.entity_type = 'customer' AND e.merged_into IS NULL AND l.tenant_id = ${TENANT})
        AND regexp_replace(lower(btrim(COALESCE(d.document_type, ''))), '[[:space:]_]+', '-', 'g') NOT IN ('hr-letter', 'license-certification')
        AND NOT EXISTS (SELECT 1 FROM extractions hx WHERE hx.document_id = d.id AND hx.tenant_id = ${TENANT} AND hx.field_key = '${COMPANY_FOLDER_FIELD_KEY}' AND hx.value = '${HR_FOLDER_ID}')
        AND EXISTS (SELECT 1 FROM document_pages p WHERE p.document_id = d.id AND p.tenant_id = ${TENANT} AND length(p.text) > 0)
        AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.resource_id = d.id AND a.action = 'review.document_unlinked' AND a.tenant_id = ${TENANT})
      ORDER BY d.created_at DESC LIMIT ${DOC_BATCH}`, [documentId ?? null]);
  // Employees are not customers. The SQL above drops the plain spellings; this drops any legacy spelling that normalizes to the same types.
  return rows
    .filter((r) => { const t = normalizeDocumentType(r.document_type); return t !== "hr-letter" && t !== "license-certification"; })
    .map((r) => ({ id: r.document_id, filename: r.filename ?? null }));
}

/** The paper's own printed customer_name fact per document (a person's correction wins over the read value). */
async function loadPrintedNames(db, documentIds) {
  const by = new Map();
  if (!documentIds.length) return by;
  const { rows } = await db.raw(
    `SELECT document_id, value, corrected_value, confidence FROM extractions
      WHERE tenant_id = ${TENANT} AND field_key = 'customer_name' AND document_id = ANY($1::uuid[])
      ORDER BY (corrected_value IS NOT NULL AND corrected_value <> '') DESC, confidence DESC NULLS LAST`, [documentIds]);
  for (const r of rows) {
    const v = String((r.corrected_value && String(r.corrected_value).trim()) || r.value || "").trim();
    if (v && !by.has(r.document_id)) by.set(r.document_id, v);
  }
  return by;
}

async function loadPages(db, documentIds) {
  if (!documentIds.length) return new Map();
  const { rows } = await db.raw(
    `SELECT document_id, page_no, text FROM document_pages
      WHERE tenant_id = ${TENANT} AND document_id = ANY($1::uuid[]) ORDER BY document_id, page_no`, [documentIds]);
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.document_id)) by.set(r.document_id, []);
    by.get(r.document_id).push({ page_no: r.page_no, text: r.text ?? "" });
  }
  return by;
}

/**
 * Plan (and, unless dryRun, apply) body-name links inside ONE tenant transaction.
 * @returns {Promise<{linked: {documentId, customerId, name, basis, page}[], review: {documentId, kind: 'ambiguous'|'partial', candidates: {customerId, name}[]}[]}>}
 */
export async function planBodyNameLinks(db, { documentId = null, dryRun = false, shared = null, explain = false, known = null } = {}) {
  const out = { linked: [], review: [], refused: [] };
  const docs = await loadDocuments(db, documentId);
  if (!docs.length) return out;
  const docIds = docs.map((d) => d.id);
  // `shared` lets a batch (Re-check all) load the customer list and own names once instead of once per paper.
  const loaded = shared?.customers ? shared : null;
  const [customers, pagesByDoc, printedByDoc, ownNames] = await Promise.all([
    loaded ? loaded.customers : loadCustomers(db),
    known && documentId ? new Map([[documentId, known.pages]]) : loadPages(db, docIds),
    known && documentId ? new Map(known.printedName ? [[documentId, String(known.printedName)]] : []) : loadPrintedNames(db, docIds),
    loaded?.ownNames ? loaded.ownNames : loadOwnNames(db, {}).catch(() => []),
  ]);
  if (shared && !loaded) { shared.customers = customers; shared.ownNames = ownNames; }
  if (!customers.length) return out;

  for (const { id, filename } of docs) {
    const pages = pagesByDoc.get(id) ?? [];
    // A VOID paper, a copy and any other set-aside paper is never linked (the Inbox keeps them out of every count).
    if (isSetAsidePaper({ filename, text: pages.slice(0, 2).map((p) => p.text).join("\n") })) { out.refused.push({ documentId: id, reason: "set-aside" }); continue; }
    const verdict = findCustomersInBody(pages, customers, { ownNames, printedName: printedByDoc.get(id) ?? null });
    if (explain || verdict.refused) {
      // What the whole-page rule would have done: the statistic behind "links refused because of these fixes".
      const old = findCustomersInBody(pages, customers, { zones: false });
      if (old.status === "unique" && !(verdict.status === "unique" && verdict.matches[0].customerId === old.matches[0].customerId)) {
        out.refused.push({ documentId: id, reason: verdict.refused ?? "customer-side", customerId: old.matches[0].customerId });
      }
    }
    if (verdict.status === "none") continue;
    if (verdict.status !== "unique") {
      const bodyText = pages.map((p) => p.text ?? "").join("\n");
      const shown = verdict.candidates.filter((c) => !isJunkCustomerName(c.name) && !isIssuerSigner(c.name, bodyText));
      out.review.push({ documentId: id, kind: verdict.status, weak: (verdict.status === "ambiguous" || verdict.weak === true) && shown.length > 0, candidates: shown.slice(0, 5) });
      continue;
    }
    const m = verdict.matches[0];
    if (dryRun) { out.linked.push({ documentId: id, customerId: m.customerId, name: m.name, basis: m.basis, page: m.page }); continue; }

    // Fill the missing customer_name (only when the document has none), so "Missing required field: Customer" clears.
    const has = await db.raw(`SELECT 1 FROM extractions WHERE document_id = $1 AND field_key = 'customer_name' AND tenant_id = ${TENANT} LIMIT 1`, [id]);
    if (!has.rows.length) {
      const facet = await db.createFacet({
        document_id: id, page_no: m.page, segment_id: "body-name-link", label_raw: "Customer named in document",
        value_raw: m.name, value_type_guess: "text", confidence: 0.6,
      });
      await db.createExtraction({ document_id: id, entity_id: null, field_key: "customer_name", value: m.name, confidence: 0.6, source_facet_id: facet?.id ?? null });
    }
    const didLink = await linkDocumentToCustomer(db, { documentId: id, customerId: m.customerId, confidence: 0.6, linkedBy: BODY_NAME_LINKED_BY });
    if (didLink) {
      await db.logAction({
        action: "integrity.link_body_name", resource_type: "document", resource_id: id,
        changes: { customer_id: m.customerId, basis: m.basis, page: m.page },
      });
      out.linked.push({ documentId: id, customerId: m.customerId, name: m.name, basis: m.basis, page: m.page });
    }
  }
  return out;
}

/**
 * Integrity-fix entry point: every unlinked document in the tenant (bounded), or one document.
 * dryRun previews (also what integrityScan reports). Never throws; an unexpected error returns empty lists.
 */
export async function applyBodyNameLinks(ctx, { documentId = null, dryRun = false } = {}) {
  try {
    return await withTenant(ctx, (db) => planBodyNameLinks(db, { documentId, dryRun }));
  } catch (err) {
    console.error("bodyNameLink: pass failed (non-fatal):", err?.message);
    return { linked: [], review: [], refused: [] };
  }
}
