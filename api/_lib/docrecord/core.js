/**
 * docrecord core: generic, industry-neutral helpers shared by the extractor, validators and answer path.
 * Pure. No industry words, field lists or document templates live in this folder: the record schema is
 * { kind, parties, dates, amounts, identifiers, fields, items, totals } with a verbatim span + page on every value.
 */
export const RECORD_VERSION = 1;
/** facets.segment_id that marks a stored record (precedent: aiFinish / recheck use segment_id as a no-migration state key). */
export const RECORD_SEGMENT = "doc-record-v1";

/** whitespace / case / smart-quote / ligature normalised text (same idea as groundedFacts.norm) */
export const norm = (s) => String(s ?? "")
  .replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"')
  .replace(/ﬁ/g, "fi").replace(/ﬂ/g, "fl").replace(/[–—]/g, "-")
  .replace(/\s+/g, " ").trim().toLowerCase();
/** letters+digits only, for identifiers that a layout may break with spaces or dashes */
export const alnum = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n, w = 2) => String(n).padStart(w, "0");
export function validYmd(y, m, d) {
  if (!(y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
/** Every calendar date written in `text`, as YYYY-MM-DD. A slash date whose day and month could swap yields both readings. */
export function datesIn(text) {
  const out = new Set(); const t = String(text ?? "");
  const add = (y, m, d) => { y = Number(y); if (y < 100) y += 2000; if (validYmd(y, Number(m), Number(d))) out.add(`${pad(y, 4)}-${pad(m)}-${pad(d)}`); };
  for (const m of t.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) add(m[1], m[2], m[3]);
  for (const m of t.matchAll(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})\b/g)) { add(m[3], m[1], m[2]); add(m[3], m[2], m[1]); }
  for (const m of t.matchAll(/\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/g)) { const mo = MON[m[1].toLowerCase()]; if (mo) add(m[3], mo, m[2]); }
  for (const m of t.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3})[a-z]*\.?,?[\s-]+(\d{2,4})\b/g)) { const mo = MON[m[2].toLowerCase()]; if (mo) add(m[3], mo, m[1]); }
  return out;
}
/** Every money-looking number in `text`, rounded to cents (the sign is dropped; the span decides meaning). */
export function amountsIn(text) {
  const out = new Set();
  for (const m of String(text ?? "").matchAll(/(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g)) out.add(Math.round(Number(m[1].replace(/,/g, "")) * 100) / 100);
  return out;
}
export const cents = (n) => Math.round(Number(n) * 100);
export const num = (v) => { const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[$,\s]/g, "").replace(/^\((.*)\)$/, "-$1")); return Number.isFinite(n) ? n : null; };

/** text a model could have been steered by; a span or value like this is never stored as a fact */
export const INSTRUCTION_RE = /\b(ignore (?:all |any |the )?(?:previous|prior|above)|disregard (?:all |the )?(?:previous|prior|above)|system prompt|reveal (?:your|the) (?:api|secret|key|prompt)|api key|you are now|act as)\b/i;

/** words that are a printed label, never a name or value */
export const LABEL_ONLY = new Set(["bill to", "ship to", "sold to", "customer", "client", "vendor", "name", "n/a", "na", "none", "date", "total", "to", "from", "attn", "attention", "address", "phone", "email", "unknown"]);

export const SECTIONS = ["parties", "dates", "amounts", "identifiers", "fields"];
