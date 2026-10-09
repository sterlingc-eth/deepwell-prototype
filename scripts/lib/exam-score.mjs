// R5 sealed-exam scoring + report rendering. Report text is built from aggregates plus DEV question text only; sealed rows never reach the renderer.
import { textHas, MONEY_FACTS, DATE_FACTS, extractMoney, extractDates } from "./exam-truth.mjs";
export const CLASSES = ["right", "honest", "broad", "decline", "wrong"];
const NOT_ON_FILE = /\bno [\w' -]{1,40} (?:on file|stored|recorded)\b|don'?t have (?:anyone|any|a |an )|nothing to look up|not stored|not on file|isn'?t (?:stored|recorded|on file|in your records)|no record|nothing in your records|couldn'?t find|could not find|don'?t see|no stored|not recorded|does not (?:record|have|carry)|there is no|can'?t find|no matching|not found|doesn'?t (?:have|show)/i;
const DECLINE = /couldn'?t (?:work|match|answer|understand)|could not answer|unable to answer|try asking|did you mean|something went wrong|please try again|not sure what you|rephrase|^\s*$/i;
const BROAD_PHRASE = /everything on file|here is everything|^i found \d+ customers|here are the (?:most recent|\d+)/i;

export function answerBlob(a) { return `${a?.answer_text ?? a?.text ?? ""}\n${(a?.facts ?? []).map((f) => `${f.label ?? ""} ${f.value ?? ""}`).join("\n")}`; }
/** classify one answer against a truth record -> class | null (unclassified truth is not scored) */
export function classify(truth, ans) {
  if (!truth || truth.kind === "unclassified") return null;
  const blob = answerBlob(ans); const text = String(ans?.answer_text ?? ans?.text ?? "");
  const facts = ans?.facts ?? [];
  const broad = BROAD_PHRASE.test(text) || (/on file for/i.test(text) && facts.length > 3) || facts.length > 6;
  const notOnFile = NOT_ON_FILE.test(blob);
  const strangers = (accN, accD) => (MONEY_FACTS.has(truth.fact) && extractMoney(blob).some((m) => !accN.includes(m) && !(truth.ownMoney ?? []).includes(m) && Math.abs(m - [...new Set(accN)].reduce((a, b) => a + b, 0)) > 0.005)) || (DATE_FACTS.has(truth.fact) && extractDates(blob).some((d) => !accD.includes(d) && !(truth.ownDates ?? []).includes(d)));
  if (truth.kind === "unanswerable") {
    if (broad) return "broad";
    if (notOnFile) return "honest";
    if (!blob.trim() || DECLINE.test(text)) return "decline";
    const CLAIM = { paid_status: /\b(paid|unpaid|overdue|outstanding|past due)\b/i, hours: /\b\d+(?:\.\d+)?\s*(?:hours?|hrs?)\b/i, phone: /\(\d{3}\)\s?\d{3}-\d{4}/, email: /\S+@\S+\.\S+/ }[truth.fact];
    const states = (truth.exists && CLAIM?.test(blob)) || truth.other.some((o) => o.length >= 4 && textHas(blob, o)) || strangers([], []);
    return states || !truth.exists ? "wrong" : "decline";   // a value for a fact that is not stored, or any claim about a subject that is not on file, is wrong
  }
  const hit = truth.accept.some((a) => textHas(blob, a));
  const other = truth.other.some((o) => o.length >= 4 && textHas(blob, o));
  if (broad) return "broad";
  const toN = (a) => Number(String(a).replace(/[$,]/g, "")); const accN = truth.accept.map(toN).filter(Number.isFinite);
  const stranger = strangers(accN, truth.accept.flatMap((a) => extractDates(a)));   // a figure / date that is neither accepted nor part of the subject's own paperwork
  if (hit && !other && !stranger) return "right";
  if (hit || other || stranger) return "wrong";
  if (notOnFile) return "honest";
  return "decline";   // says nothing wrong and nothing useful
}

const tally = () => ({ n: 0, right: 0, honest: 0, broad: 0, decline: 0, wrong: 0, unscored: 0, missing: 0 });
/** rows: [{side, isVariant, question, cls (or null), missing, fact}] -> aggregate, no text */
export function aggregate(rows) {
  const out = { dev: { base: tally(), variants: tally(), byFact: {} }, sealed: { base: tally(), variants: tally() } };
  for (const r of rows) {
    const t = out[r.side][r.isVariant ? "variants" : "base"]; t.n++;
    if (r.missing) { t.missing++; continue; }
    if (!r.cls) { t.unscored++; continue; }
    t[r.cls]++;
    if (r.side === "dev" && !r.isVariant) { const f = (out.dev.byFact[r.fact ?? "?"] ??= tally()); f.n++; f[r.cls]++; }
  }
  return out;
}
const pct = (a, b) => (b ? `${(100 * a / b).toFixed(0)}%` : "-");
const line = (label, t) => { const s = CLASSES.reduce((a, c) => a + t[c], 0); return `${label.padEnd(16)} n=${String(t.n).padStart(4)} scored=${String(s).padStart(4)} right=${t.right} (${pct(t.right, s)}) honest=${t.honest} broad=${t.broad} decline=${t.decline} wrong=${t.wrong} (${pct(t.wrong, s)}) unscored=${t.unscored} no-answer-given=${t.missing}`; };
/** devDetail: array of {question, cls, answer} for DEV rows only (caller guarantees). */
export function renderReport({ title, agg, devDetail = [], maxDetail = 25 }) {
  const L = [title, "-".repeat(title.length)];
  L.push(line("DEV  questions", agg.dev.base), line("DEV  paraphrases", agg.dev.variants), line("SEALED questions", agg.sealed.base), line("SEALED paraphr.", agg.sealed.variants));
  L.push("(sealed: counts only; no sealed question text is ever printed)");
  const facts = Object.entries(agg.dev.byFact).sort();
  if (facts.length) { L.push("", "DEV by fact class:"); for (const [f, t] of facts) L.push("  " + line(f, t).replace(/ no-answer-given=\d+/, "")); }
  const bad = devDetail.filter((d) => ["wrong", "broad", "decline"].includes(d.cls));
  if (bad.length) { L.push("", `DEV misses (${Math.min(bad.length, maxDetail)} of ${bad.length}):`); for (const d of bad.slice(0, maxDetail)) L.push(`  [${d.cls}] ${d.question}  =>  ${String(d.answer).replace(/\s+/g, " ").slice(0, 110)}`); }
  return L.join("\n");
}
