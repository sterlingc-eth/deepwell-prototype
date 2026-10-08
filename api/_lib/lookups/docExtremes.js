/**
 * Whole-shop extremes on ONE document type: "oldest / newest / most recent invoice", "cheapest / most expensive invoice",
 * "biggest / smallest / newest / oldest quote". Answers from that type only (invoice vs proposal-quote), cites the document,
 * and never reads a superlative as a customer name or a document count. Only bare shapes are claimed (filler words + one
 * extreme word + the document word); anything with a name, date, month, amount or extra clause falls through.
 * A date window ("last month", "in august", "this year", "2025", "since june", "last 90 days") narrows the comparison to documents dated in it; no document in the
 * window says so plainly (never the all-time answer). Kill switches: DONOVAN_DOC_EXTREMES=0, DONOVAN_DOC_EXTREME_DATES=0.
 * pure: parseDocExtreme     db: runDocExtreme
 */
import { attachCitations } from "../citations/records.js";
import { documentRecordsFor } from "../citations/enrich.js";
import { TENANT_SQL, answerEnvelope, todayIso } from "../scope.js";
import { resolveAnyTimeRange } from "../analytics.js";

const FILLER = new Set(["what", "whats", "what's", "which", "who", "whos", "is", "was", "are", "were", "our", "the", "my", "a", "an", "one", "we", "ever", "have", "has", "had", "sent", "made", "written", "on", "file", "show", "me", "tell", "give", "find", "get", "pull", "up", "of", "all", "time", "in", "system", "records", "do", "did", "that", "single", "please", "i", "you", "us", "got", "issued", "out", "overall"]);
const EXT = {
  max: ["biggest", "largest", "highest", "priciest", "top", "most expensive", "greatest", "costliest"],
  min: ["smallest", "cheapest", "lowest", "least expensive", "tiniest"],
  newest: ["newest", "latest", "most recent", "last", "recent"],
  oldest: ["oldest", "earliest", "first"],
};
const KIND = { invoice: /^(?:invoices?|invoce|invoive|invioce)$/, quote: /^(?:quotes?|quoet|qoute|estimates?|proposals?)$/ };

const MON = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const UNIT = "(?:months?|mnths?|years?|yrs?|weeks?|wks?|quarters?|quaters?|days?)";
const DATE_PH = new RegExp(
  `(?:^| )(?:(?:in|during|from|for|of|over|within|since|between)\\s+)?(?:the\\s+)?(?:` +
  `(?:last|this|past|previous|prior)\\s+(?:\\d+\\s+)?${UNIT}` +
  `|(?:between\\s+)?${MON}(?:\\s+\\d{4})?(?:\\s+(?:and|to|through|thru)\\s+${MON}(?:\\s+\\d{4})?)?` +
  `|yesterday|today|ytd|year to date|(?:19|20)\\d\\d)(?= |$)`, "g");

export function parseDocExtreme(question) {
  if (process.env.DONOVAN_DOC_EXTREMES === "0") return null;
  let s = String(question ?? "").toLowerCase().replace(/[’`]/g, "'").replace(/[?!.,]+/g, " ").replace(/\s+/g, " ").trim();
  if (!s || s.length > 80) return null;
  let dated = false;
  if (process.env.DONOVAN_DOC_EXTREME_DATES !== "0") {
    const before = s;
    s = s.replace(DATE_PH, " ").replace(/\s+/g, " ").trim();
    dated = s !== before;
  }
  let dir = null, hit = null;
  for (const [d, words] of Object.entries(EXT)) for (const w of words.sort((a, b) => b.length - a.length)) {
    if (new RegExp(`(?:^| )${w}(?= |$)`).test(s)) { if (dir) return null; dir = d; hit = w; s = s.replace(new RegExp(`(?:^| )${w}(?= |$)`), " "); }
  }
  if (!dir) return null;
  const rest = s.split(" ").filter((t) => t && !FILLER.has(t));
  if (rest.length !== 1) return null;
  const kind = Object.keys(KIND).find((k) => KIND[k].test(rest[0]));
  if (kind === "invoice" && !dated && ["biggest", "largest", "smallest"].includes(hit)) return null; // older financial path already answers these (all-time)
  return kind ? { kind, dir, dated, question: String(question) } : null;
}

const usd = (n) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dateLabel = (d) => { const x = new Date(`${String(d).slice(0, 10)}T12:00:00Z`); return Number.isNaN(+x) ? null : x.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }); };

const pad = (v, end) => { const x = String(v ?? ""); if (/^\d{4}$/.test(x)) return end ? `${x}-12-31` : `${x}-01-01`; if (/^\d{4}-\d{2}$/.test(x)) return end ? new Date(Date.UTC(+x.slice(0, 4), +x.slice(5), 0)).toISOString().slice(0, 10) : `${x}-01`; return /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : null; };

export async function runDocExtreme(db, intent, { today } = {}) {
  let win = null;
  if (intent.dated) {
    const t = todayIso(today), w = resolveAnyTimeRange(String(intent.question).toLowerCase().replace(/\bmnths?\b/g, "month").replace(/\bquaters?\b/g, "quarter").replace(/\bwks?\b/g, "week").replace(/\byrs?\b/g, "year"), t);
    const say = (text, basis) => attachCitations(answerEnvelope({ text, facts: [], extra: { fastIntent: "doc_extreme" } }), { records: [], total: 0, kind: "searched", basis });
    if (!w || w.invalid) return say("I couldn't tell which dates you mean, so I haven't guessed. Try a month and year (\"August 2026\"), \"last month\" or \"this year\".", "The date range in the question could not be read.");
    win = { from: pad(w.from, false) ?? "0001-01-01", to: pad(w.to, true) ?? t, label: w.label };
    if (win.from > t) return say("That's a future date - I have nothing on file for it (every record here is dated on or before today).", "The date range is after today.");
    if (win.to > t) win.to = t;
  }
  const type = intent.kind === "invoice" ? "invoice" : "proposal-quote";
  const label = intent.kind === "invoice" ? "invoice" : "quote";
  const byDate = intent.dir === "newest" || intent.dir === "oldest";
  const order = byDate ? `f.invoice_date ${intent.dir === "newest" ? "DESC" : "ASC"} NULLS LAST, f.total DESC NULLS LAST` : `f.total ${intent.dir === "max" ? "DESC" : "ASC"}, f.invoice_date DESC NULLS LAST`;
  // R41U E4: a document dated after today is never the newest/biggest "on file" without saying so (same rule as the role-word lane).
  const tNow = /^\d{4}-\d{2}-\d{2}$/.test(String(todayIso(today))) ? String(todayIso(today)) : null;
  const notFut = tNow && intent.kind === "invoice" ? ` AND (f.invoice_date IS NULL OR f.invoice_date <= '${tNow}'::date)` : "";
  const where = (byDate ? "f.invoice_date IS NOT NULL" : "f.total IS NOT NULL") + (win ? " AND f.invoice_date >= $2::date AND f.invoice_date <= $3::date" : "") + notFut;
  const { rows } = await db.raw(
    `SELECT f.document_id, f.total, f.customer_name, f.invoice_number, f.invoice_date::text AS d
       FROM document_financials f JOIN documents d ON d.id = f.document_id AND d.${TENANT_SQL}
      WHERE f.${TENANT_SQL} AND d.document_type = $1 AND ${where} ORDER BY ${order} LIMIT 1`, win ? [type, win.from, win.to] : [type]);
  const wp = win ? (() => { const l = String(win.label ?? `${win.from} to ${win.to}`).replace(/^in /, ""); return /^(?:since|the |last|this|past|yesterday|today|ytd|year)/i.test(l) ? l : `in ${l}`; })() : "";
  const inWin = win ? ` dated ${wp}` : "";
  if (!rows.length) {
    if (win) return attachCitations(answerEnvelope({ text: `No ${label}s${inWin} are on file, so I can't say which is the ${intent.dir === "max" ? "biggest" : intent.dir === "min" ? "smallest" : intent.dir}.`, facts: [], extra: { fastIntent: "doc_extreme" } }),
      { records: [], total: 0, kind: "searched", basis: `Looked through every ${label}${inWin}; none was found.` });
    return attachCitations(answerEnvelope({ text: `No ${label}s with ${byDate ? "a date" : "a total"} are on file, so I can't say which is the ${intent.dir === "max" ? "biggest" : intent.dir === "min" ? "smallest" : intent.dir}.`, facts: [], extra: { fastIntent: "doc_extreme" } }),
      { records: [], total: 0, kind: "searched", basis: `Looked through every ${label}; none had ${byDate ? "a date" : "a total"}.` });
  }
  const r = rows[0];
  let futN = 0;
  if (notFut) { const fr = await db.raw(`SELECT count(*)::int AS n FROM document_financials f JOIN documents d ON d.id = f.document_id AND d.${TENANT_SQL} WHERE f.${TENANT_SQL} AND d.document_type = $1 AND f.invoice_date > '${tNow}'::date`, [type]); futN = fr.rows?.[0]?.n ?? 0; }
  const futureNote = futN ? ` I left out ${futN} invoice${futN === 1 ? "" : "s"} dated after today.` : "";
  const word = { max: "biggest", min: "smallest", newest: "newest", oldest: "oldest" }[intent.dir];
  const text = `The ${word} ${label}${win ? ` ${wp}` : ""} is ${r.total != null ? usd(r.total) : "(no total printed)"}${r.invoice_number ? ` (#${r.invoice_number})` : ""}${r.customer_name ? `, for ${r.customer_name}` : ""}${r.d && dateLabel(r.d) ? `, dated ${dateLabel(r.d)}` : ""}. ${intent.kind === "invoice" ? "Invoices only - not quotes or other documents." : "Quotes only - not invoices."}${futureNote}`;
  const facts = [{ label: `${word[0].toUpperCase()}${word.slice(1)} ${label}`, value: r.total != null ? usd(r.total) : "n/a", sources: [{ documentId: r.document_id, location: { field: "total" } }] }];
  return attachCitations(answerEnvelope({ text, facts, extra: { fastIntent: "doc_extreme" } }), {
    records: await documentRecordsFor(db, [r.document_id]), total: 1,
    basis: `Compared every ${label} on file${win ? inWin : ""} by ${byDate ? "date" : "total"}.`,
  });
}
