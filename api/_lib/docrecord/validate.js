/**
 * Deterministic validators for a document record. A model-proposed value is VERIFIED only when every rule below holds; the model's
 * own confidence is never consulted. Anything else is kept for a person to see but flagged ok:false with a reason, and the answer path
 * never uses it (strong-evidence principle: no verbatim span on the stored page = no fact).
 * Generic: no industry vocabulary. Pure.
 */
import { norm, alnum, datesIn, amountsIn, cents, num, INSTRUCTION_RE, LABEL_ONLY, SECTIONS, RECORD_VERSION } from "./core.js";

const MAX_SPAN = 400, MIN_SPAN = 3;

function pageIndex(pages) {
  const m = new Map();
  for (const p of pages ?? []) m.set(Number(p.page_no), norm(p.text));
  return m;
}
/** span must be copied from the stored text of the NAMED page */
export function spanOnPage(span, page, idx) {
  const s = norm(span);
  if (s.length < MIN_SPAN) return "span_too_short";
  if (String(span).length > MAX_SPAN) return "span_too_long";
  if (!Number.isFinite(Number(page)) || !idx.has(Number(page))) return "page_unknown";
  return idx.get(Number(page)).includes(s) ? null : "span_not_on_page";
}

const labelOk = (l) => typeof l === "string" && l.trim().length > 0 && l.length <= 80;

function checkValue(section, row, idx) {
  if (!row || typeof row !== "object") return "not_an_object";
  const why = spanOnPage(row.span, row.page, idx);
  if (why) return why;
  if (INSTRUCTION_RE.test(String(row.span)) || INSTRUCTION_RE.test(String(row.value ?? row.name ?? ""))) return "instruction_like";
  const span = String(row.span);
  switch (section) {
    case "parties": {
      const n = norm(row.name);
      if (n.length < 2 || LABEL_ONLY.has(n)) return "label_not_name";
      return norm(span).includes(n) ? null : "value_not_in_span";
    }
    case "dates": {
      const iso = String(row.iso ?? "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "date_not_iso";
      return datesIn(span).has(iso) ? null : "date_not_in_span";
    }
    case "amounts": case "totals": {
      const a = num(row.amount); if (a === null) return "amount_not_number";
      return amountsIn(span).has(Math.round(Math.abs(a) * 100) / 100) ? null : "amount_not_in_span";
    }
    case "identifiers": {
      const v = alnum(row.value);
      if (v.length < 3 || !/\d/.test(v)) return "identifier_shape";
      return alnum(span).includes(v) ? null : "value_not_in_span";
    }
    case "fields": {
      const v = norm(row.value); if (!v) return "empty_value";
      if (norm(span).includes(v)) return null;
      const a = num(row.value); // a number may be reformatted ("1,200" vs "1200")
      return a !== null && amountsIn(span).has(Math.round(Math.abs(a) * 100) / 100) ? null : "value_not_in_span";
    }
    case "items": {
      if (norm(row.description).length < 2) return "label_not_name";
      if (!norm(span).includes(norm(row.description).slice(0, 40))) return "value_not_in_span";
      const am = amountsIn(span);
      for (const k of ["amount", "unit_price"]) if (row[k] != null && (num(row[k]) === null || !am.has(Math.round(Math.abs(num(row[k])) * 100) / 100))) return `${k}_not_in_span`;
      if (row.qty != null && (num(row.qty) === null)) return "qty_not_number";
      if (row.qty != null && row.unit_price != null && row.amount != null && Math.abs(cents(num(row.qty) * num(row.unit_price)) - cents(num(row.amount))) > 1) return "qty_x_unit_mismatch";
      return null;
    }
    default: return "unknown_section";
  }
}

const TOTAL_RE = /\b(grand total|total due|amount due|balance due|total amount|invoice total|total)\b/i;
const SUBTOTAL_RE = /\bsub[\s-]?total\b/i;
const ADD_RE = /\b(tax|vat|gst|shipping|freight|delivery|fee|surcharge|handling)\b/i;
const SUB_RE = /\b(discount|credit|rebate|deposit|less)\b/i;

/** totals must reconcile with line items. status: pass | fail | n/a (nothing to compare; never counts as a pass) */
export function reconcile(rec) {
  const items = (rec.items ?? []).filter((r) => r.ok && r.amount != null);
  const tots = (rec.totals ?? []).filter((r) => r.ok);
  const total = tots.find((t) => TOTAL_RE.test(t.label) && !SUBTOTAL_RE.test(t.label));
  const sub = tots.find((t) => SUBTOTAL_RE.test(t.label));
  if (items.length < 2 || !(total || sub)) return { status: "n/a", detail: "need >=2 verified items and a printed subtotal or total" };
  const sum = items.reduce((s, r) => s + cents(num(r.amount)), 0);
  const add = tots.filter((t) => ADD_RE.test(t.label) && t !== total && t !== sub).reduce((s, t) => s + cents(num(t.amount)), 0);
  const less = tots.filter((t) => SUB_RE.test(t.label) && t !== total && t !== sub).reduce((s, t) => s + Math.abs(cents(num(t.amount))), 0);
  const near = (a, b) => Math.abs(a - b) <= 1;
  const cands = [];
  const subOk = !sub || near(sum, cents(num(sub.amount))); // a printed subtotal must always equal the item sum
  if (sub && !total) cands.push(["items=subtotal", sum, cents(num(sub.amount))]);
  if (total) {
    const t = cents(num(total.amount));
    if (subOk) { cands.push(["items=total", sum, t]); cands.push(["items+adj=total", sum + add - less, t]); }
  }
  const hit = cands.find(([, a, b]) => near(a, b));
  return hit ? { status: "pass", detail: hit[0] } : { status: "fail", detail: `items sum ${sum / 100}, ${cands.map(([n, a, b]) => `${n}: ${a / 100} vs ${b / 100}`).join("; ")}` };
}

/**
 * @param {object} rec   model-proposed record (shape from schema.js)
 * @param {{page_no:number,text:string}[]} pages  the STORED page text the record must be read from
 * @returns {{record: object, stats: {total:number, ok:number, rejected:{section:string,why:string,span:string}[]}, reconcile: object, usable: boolean}}
 */
export function validateRecord(rec, pages) {
  const idx = pageIndex(pages);
  const out = { v: RECORD_VERSION, kind: typeof rec?.kind === "string" ? rec.kind.toLowerCase().slice(0, 60) : null, kind_confidence: Number(rec?.kind_confidence) || 0 };
  const rejected = []; let total = 0, ok = 0;
  for (const section of [...SECTIONS, "items", "totals"]) {
    out[section] = [];
    for (const row of Array.isArray(rec?.[section]) ? rec[section].slice(0, 200) : []) {
      total++;
      const why = checkValue(section, row, idx);
      const clean = { ...(row && typeof row === "object" ? row : {}), ok: !why };
      if (section !== "items" && !labelOk(clean.label) && section !== "parties") { clean.ok = false; clean.why = "label_missing"; }
      else if (why) clean.why = why;
      if (clean.ok) ok++; else rejected.push({ section, why: clean.why, span: String(row?.span ?? "").slice(0, 80) });
      out[section].push(clean);
    }
  }
  out.reconcile = reconcile(out);
  return { record: out, stats: { total, ok, rejected }, reconcile: out.reconcile, usable: ok > 0 };
}
