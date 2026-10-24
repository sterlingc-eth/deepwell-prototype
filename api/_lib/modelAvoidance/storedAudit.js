/**
 * Docread2 round (2026-10-23): READ-ONLY audit of values ALREADY STORED.
 *
 * Re-check is insert-only (it never overwrites a stored value), so a wrong value saved by an older reader stays wrong.
 * This module re-runs the NEW cross-checks over the stored values and says which ones look wrong and why. It never changes
 * a value, never un-checks a paper. The caller (storedAuditStore.js) records the verdict in audit_log and the Inbox shows
 * "Please check this value" with the evidence quote and page.
 *
 * Rules (generic, every industry; never a file name or a phrase of one test file):
 *   period    stored start / end date differs from the one period the page states (a COI's policy effective / expires vs
 *             the certificate date; "a term of N months beginning X and ending Y").
 *   term      the stored term does not add up: start + N months/years != end, or its dates are not the stored start / end.
 *   total     stored cost differs from the page's total (exact total labels, subtotal + tax = total), or the page's own
 *             subtotal + tax does not equal its total.
 *   label     a stored party name is a printed label / column title ("SERVICE LOCATION", "OWNER CONTRACTOR").
 *   signer    a stored party name is printed only in a signature block ("By:", "Signature", "Client: X Date: ____").
 * A person's corrected value is skipped entirely. Pure: no I/O.
 */
import { scanProseFacts, monthsBetweenOk } from "./proseFacts.js";
import { crossCheckFields, isHeaderRow } from "./labelFill.js";
import { detectDateOrder } from "./textExtract.js";
import { signerOnlyByValue } from "./signerGuard.js";
import { isLabelValue } from "../documentTypes.js";
import { normalizeDate } from "../extractFields.js";

export const AUDIT_RULE_VERSION = 1;
export const AUDIT_RULES = ["period", "term", "total", "label", "signer"];
/** The only plain words the Inbox shows for these flags (for owner approval). */
export const SUSPECT_LABEL = "Please check this value";

const collapse = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const live = (f) => f && f.corrected_value == null && f.value != null && String(f.value).trim() !== "";

function pageLines(pages) {
  const lines = [];
  for (const p of pages ?? []) for (const r of String(p?.text ?? "").split(/\r?\n/)) { const t = collapse(r); if (t) lines.push({ t, page: Number(p.page_no) || 1 }); }
  return lines;
}
/** The first line of the paper that contains `needle` (case-insensitive); {quote, page} or null. */
function locate(lines, needle) {
  const n = collapse(needle).toLowerCase();
  if (!n) return null;
  const l = lines.find((x) => x.t.toLowerCase().includes(n));
  return l ? { quote: l.t.slice(0, 200), page: l.page } : null;
}
const sameDate = (a, b, order) => (normalizeDate(String(a), { order }) ?? String(a)) === (normalizeDate(String(b), { order }) ?? String(b));

/**
 * @param {{pages:{page_no:number,text:string}[], fields:{field_key:string,value:unknown,corrected_value?:unknown,verbatim?:string|null,page_no?:number|null}[]}} input
 * @returns {{field_key:string, value:string, rule:string, reason:string, quote:string|null, page:number|null, expected?:string}[]}
 */
export function auditStoredFacts({ pages, fields }) {
  const rows = (fields ?? []).filter(live);
  if (!rows.length || !(pages ?? []).some((p) => String(p?.text ?? "").trim())) return [];
  const lines = pageLines(pages);
  const flags = [];
  const flag = (f, rule, reason, ev, expected) => flags.push({ field_key: f.field_key, value: String(f.value), rule, reason, quote: ev?.quote ?? null, page: ev?.page ?? (f.page_no ?? null), ...(expected ? { expected: String(expected) } : {}) });
  const get = (k) => rows.find((f) => f.field_key === k);
  const order = (() => { try { const o = detectDateOrder(pages.map((p) => String(p?.text ?? "")).join("\n")); return o === "dmy" ? "dmy" : "mdy"; } catch { return "mdy"; } })();

  let pf = null;
  try { pf = scanProseFacts(pages, { keys: ["cost", "start_date", "end_date", "agreement_term"], order }); } catch { pf = null; }
  const evOf = (c) => (c ? { quote: collapse(c.verbatim).slice(0, 200), page: c.page_no } : null);

  // ---- period: the one period the page states
  if (pf) {
    for (const [key, word] of [["start_date", "starts"], ["end_date", "ends"]]) {
      const f = get(key);
      const cs = pf.candidates[key] ?? [];
      const distinct = [...new Set(cs.map((c) => normalizeDate(c.value, { order }) ?? c.value))];
      if (!f || distinct.length !== 1) continue; // two different periods on the page (several policies): not ours to judge
      if (!sameDate(f.value, distinct[0], order)) flag(f, "period", `The page says the period ${word} ${distinct[0]}.`, evOf(cs[0]), distinct[0]);
    }
  }

  // ---- term: start + length = end, and the term's own dates are the stored start / end
  {
    const t = get("agreement_term"), s = get("start_date"), e = get("end_date");
    if (t) {
      const tv = String(t.value);
      const len = /(\d{1,3})\s*(month|year|yr|mo)/i.exec(tv);
      const dts = [...tv.matchAll(/\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|[A-Za-z]{3,9}\.? \d{1,2},? \d{4}|\d{1,2} [A-Za-z]{3,9}\.? \d{4}/g)].map((m) => normalizeDate(m[0], { order })).filter(Boolean);
      const ev = locate(lines, tv.replace(/\s*\(.*$/, "")) ?? locate(lines, "term");
      if (dts.length >= 2 && s && e && (!sameDate(s.value, dts[0], order) || !sameDate(e.value, dts[dts.length - 1], order))) {
        flag(t, "term", `The stored term runs ${dts[0]} to ${dts[dts.length - 1]} but the stored start / end are ${s.value} / ${e.value}.`, ev);
      } else if (len && s && e) {
        const n = Number(len[1]); const unit = len[2].toLowerCase().startsWith("y") ? "y" : "m";
        const sd = normalizeDate(String(s.value), { order }), ed = normalizeDate(String(e.value), { order });
        if (sd && ed && !monthsBetweenOk(sd, n, unit, ed)) flag(t, "term", `Start ${sd} plus ${n} ${unit === "y" ? "year(s)" : "month(s)"} does not land on the stored end ${ed}.`, ev);
      }
    }
  }

  // ---- total: stored cost vs the page's total (reuses the upload cross-check), and the page's own subtotal + tax
  {
    const c = get("cost");
    if (c) {
      let removed = [];
      try { removed = crossCheckFields({ fields: [{ field_key: "cost", value: c.value, corrected_value: null }], pages }).removed; } catch { removed = []; }
      if (removed.length) {
        const cand = pf?.candidates.cost?.[0];
        const amb = pf?.ambiguous.find((a) => a.key === "cost" && a.reason !== "zero amount");
        const ev = evOf(cand) ?? locate(lines, String(c.value)) ?? (amb ? locate(lines, "total") : null);
        flag(c, "total", `The stored amount does not match the page: ${removed[0].reason}.`, ev, cand?.value);
      }
    }
  }

  // ---- label / signer: a stored party name
  for (const key of ["customer_name", "vendor"]) {
    const f = get(key);
    if (!f) continue;
    const v = String(f.value);
    if (isLabelValue(v) || (f.verbatim && isHeaderRow(f.verbatim) && /^[A-Z0-9 &/.-]+$/.test(v) && v === v.toUpperCase() && /\s/.test(v))) {
      flag(f, "label", `"${v}" is a printed label, not a name.`, locate(lines, v));
      continue;
    }
    const sg = signerOnlyByValue(v, pages);
    if (sg.signer) flag(f, "signer", `"${v}" is printed only where the paper is signed, so it is the signer, not the party.`, { quote: sg.quote, page: sg.page });
  }
  return flags;
}
