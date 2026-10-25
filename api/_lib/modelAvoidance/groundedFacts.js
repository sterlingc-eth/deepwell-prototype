/**
 * Docread round (2026-10-22): "a value is used only when its quote is on the page and the value comes from the quote".
 *
 * Shared by every reader that writes a fact: the labelled scan and the prose reader (labelFill.js, before anything is written)
 * and the extraction model at upload (extractDocument.js, on the `verbatim` quote the model returns with each field).
 *   1. the quote must appear on its page (whitespace / case / smart quotes / ligatures normalised; any page when no page given);
 *   2. the value must be derivable from the quote: a date must be one of the quote's dates, an amount one of its amounts
 *      (to the cent), a name / number / text must appear in the quote.
 * Pure.
 */
import { normalizeDate, normalizeNumber } from "../extractFields.js";
import { DATE_SRC } from "./proseFacts.js";

export const norm = (s) => String(s ?? "")
  .replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"')
  .replace(/ﬁ/g, "fi").replace(/ﬂ/g, "fl").replace(/[–—]/g, "-")
  .replace(/\s+/g, " ").trim().toLowerCase();

const DATE_KEYS = /(?:_date|_expires|installation_date|warranty_registered_date)$/;
const MONEY_KEYS = new Set(["cost"]);
const NUMBER_KEYS = new Set(["labor_hours"]);
const PERSON_KEYS = new Set(["holder_name", "employee_name", "manager", "issued_by"]);

/** Every date in `text`, normalised, both readings when day/month could swap. */
function datesIn(text, order) {
  const out = new Set();
  // every segment of the quote on its own ("Service Performed: 22-Nov-21", "DATE | 3-Nov-31"), then every date-shaped run
  for (const seg of String(text).split(/\s{2,}|\s*\|\s*|:\s+|\s+…\s+/)) { const d = normalizeDate(seg.trim(), { order }); if (d) out.add(d); }
  for (const m of String(text).matchAll(new RegExp(DATE_SRC, "gi"))) {
    const d = normalizeDate(m[0], { order });
    if (d) out.add(d);
  }
  return out;
}
const amountsIn = (text) => new Set([...String(text).matchAll(/-?\$?\s*\(?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\)?/g)].map((m) => normalizeNumber(m[1], { money: true })).filter((x) => x != null).map((x) => Math.round(Number(x) * 100)));

/**
 * @param {{field_key:string, value:unknown, verbatim?:string|null, page_no?:number|null}} field
 * @param {{page_no:number, text:string}[]} pages
 * @returns {{ok:boolean, reason:string|null}}  reason: no-quote | quote-not-on-page | value-not-in-quote
 */
export function verifyGrounded(field, pages, { order = "mdy" } = {}) {
  const quote = norm(field?.verbatim);
  if (!quote) return { ok: false, reason: "no-quote" };
  const onPage = (pages ?? []).filter((p) => field?.page_no == null || Number(p.page_no) === Number(field.page_no));
  // A quote may join two lines of one page with " … " (a start date and an end date printed on different lines).
  const parts = quote.split(/\s*…\s*/).filter(Boolean);
  if (!onPage.some((p) => { const t = norm(p.text); return parts.every((q) => t.includes(q)); })) return { ok: false, reason: "quote-not-on-page" };
  const key = String(field?.field_key ?? "").replace(/_unconfirmed$/, "");
  const value = String(field?.value ?? "");
  if (DATE_KEYS.test(key) || key === "service_date") {
    const want = normalizeDate(value, { order }) ?? value;
    const have = datesIn(field.verbatim, order);
    if (have.has(want)) return { ok: true, reason: null };
    // a month-only reading ("2021-06") of a printed month
    if (/^\d{4}-\d{2}$/.test(want) && [...have].some((d) => d.startsWith(want))) return { ok: true, reason: null };
    const swapped = datesIn(field.verbatim, order === "dmy" ? "mdy" : "dmy");
    return swapped.has(want) ? { ok: true, reason: null } : { ok: false, reason: "value-not-in-quote" };
  }
  if (MONEY_KEYS.has(key) || NUMBER_KEYS.has(key)) {
    const n = normalizeNumber(value, { money: true });
    if (n == null) return { ok: false, reason: "value-not-in-quote" };
    return amountsIn(field.verbatim).has(Math.round(Number(n) * 100)) ? { ok: true, reason: null } : { ok: false, reason: "value-not-in-quote" };
  }
  if (key === "agreement_term" || key === "warranty_term") {
    // A period: every date it names is one of the quote's dates, and its length ("60 months") is printed in the quote.
    const vd = datesIn(value, order);
    const qd = datesIn(field.verbatim, order);
    const len = /(\d{1,3})\s*(month|year|yr|mo)/i.exec(value);
    const datesOk = [...vd].every((d) => qd.has(d));
    const lenOk = !len || new RegExp(`\\b${len[1]}\\b|\\(${len[1]}\\)`).test(field.verbatim) || /[a-z]+\s*\(\d+\)/i.test(field.verbatim) || quote.includes(norm(value));
    if ((vd.size || len) && datesOk && lenOk) return { ok: true, reason: null };
  }
  const v = norm(value).replace(/[.,]+$/, "");
  if (!v) return { ok: false, reason: "value-not-in-quote" };
  // People-forms round: a person's name printed "Last, First M" or in separate first / last cells is read in natural order; every word of it must still be in the quote.
  if (PERSON_KEYS.has(key)) {
    const words = (t) => norm(t).replace(/[.,]/g, " ").split(/\s+/).filter(Boolean);
    const qw = new Set(words(field.verbatim));
    const vw = words(value);
    if (vw.length && vw.every((w) => qw.has(w))) return { ok: true, reason: null };
  }
  const q = quote.replace(/[.,]/g, "");
  return q.includes(v.replace(/[.,]/g, "")) || quote.includes(v) ? { ok: true, reason: null } : { ok: false, reason: "value-not-in-quote" };
}
