/**
 * Answer ONE-FACT questions from verified document records, with no model call. Strictly stricter-only: it returns null (so the existing
 * chain, then Claude, handles the question) unless exactly one verified value answers it with a verbatim span. It never says "not on file".
 *   - the record must be found by a printed identifier or a party name in the question,
 *   - the asked fact must match a verified row's printed label (or the generic "total" meaning),
 *   - two documents that disagree on the value, a failed reconcile on a money question, or any tie = abstain.
 * Generic: the vocabulary below is document-agnostic (total, date, who, number), not industry-specific.
 */
import { norm, alnum, num } from "./core.js";

const STOP = new Set("what whats is the a an of on for to in at by with and or was were did does do who which when where how much many this that it its me my our us we you your please tell show give find on file stored listed document documents invoice number no".split(" "));
const AGG_RE = /\b(all|every|each|list|how many|compare|between|more than|less than|most|least|average|sum of|together|combined|older|newer|latest|earliest|oldest|newest|versus|vs)\b/i;
const MONEY_Q = /\b(total|amount|how much|cost|price|balance|due|owe|owed|paid|subtotal|tax|charge|fee|rent|payment|pay)\b/i;
const DATE_Q = /\b(when|date|dated|expire|expires|expiry|expiration|due date|issued|effective|starts?|ends?|began|begin|until|through)\b/i;
const WHO_Q = /\b(who|whom|billed to|bill to|issued to|issued by|signed by|sent to|from whom|which (?:customer|client|vendor|company|person|party))\b/i;
const NUM_Q = /\b(what(?:'s| is)? the (?:\w+ )?(?:number|no|id|reference|ref)|which (?:number|id))\b/i;
const TOTAL_LABEL = /\b(grand total|total due|amount due|balance due|total amount|invoice total|total)\b/i;
const stem = (w) => w.replace(/(ing|ed|es|s)$/, "");
const toks = (s) => norm(s).replace(/[^a-z0-9 ]/g, " ").split(" ").filter((w) => w && !STOP.has(w)).map(stem);
const fmtMoney = (n) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const fmtDate = (iso) => { const [y, m, d] = iso.split("-").map(Number); return `${MONTHS[m - 1]} ${d}, ${y}`; };

function idTokens(question) {
  const out = new Set();
  for (const m of String(question).matchAll(/[A-Za-z]{0,8}[-#]?\d[\w-]*/g)) { const a = alnum(m[0]); if (a.length >= 4 && /\d/.test(a)) out.add(a); }
  return out;
}

function findRecords(question, entries) {
  const ids = idTokens(question);
  if (ids.size) return { by: "identifier", ids, hits: entries.filter((e) => (e.record.identifiers ?? []).some((i) => i.ok && ids.has(alnum(i.value)))) };
  const q = ` ${norm(question).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ")} `;
  const hits = entries.filter((e) => (e.record.parties ?? []).some((p) => { const n = norm(p.name).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim(); return p.ok && n.length >= 5 && q.includes(` ${n} `); }));
  return { by: "party", ids, hits };
}

function pickRows(question, rec, ids) {
  const qt = new Set(toks(question).filter((t) => !/\d/.test(t)));
  const overlap = (label) => toks(label).filter((t) => qt.has(t)).length;
  const money = MONEY_Q.test(question), date = DATE_Q.test(question), who = WHO_Q.test(question), numq = NUM_Q.test(question);
  const ok = (a) => (a ?? []).filter((r) => r.ok);
  let rows = [];
  if (money) {
    rows = [...ok(rec.totals), ...ok(rec.amounts)].map((r) => ({ type: "money", label: r.label, value: num(r.amount), row: r, score: overlap(r.label) * 2 + (/\b(total|amount|how much|cost|balance|due|owe)\b/i.test(question) && TOTAL_LABEL.test(r.label) ? 1 : 0) }));
  } else if (date) {
    rows = ok(rec.dates).map((r) => ({ type: "date", label: r.label, value: r.iso, row: r, score: overlap(r.label) }));
  } else if (who) {
    rows = ok(rec.parties).map((r) => ({ type: "party", label: r.role, value: r.name, row: r, score: overlap(r.role) }));
  } else if (numq) {
    rows = ok(rec.identifiers).map((r) => ({ type: "id", label: r.label, value: r.value, row: r, score: overlap(r.label) }));
  } else {
    rows = ok(rec.fields).map((r) => ({ type: "text", label: r.label, value: r.value, row: r, score: overlap(r.label) }));
  }
  if ((date || who || numq) && rows.length === 1 && !money) rows[0].score = Math.max(rows[0].score, 1); // the only date/party/number on the record is unambiguous
  rows = rows.filter((r) => r.score > 0);
  if (!rows.length) return null;
  const top = Math.max(...rows.map((r) => r.score));
  const best = rows.filter((r) => r.score === top);
  const vals = new Set(best.map((r) => String(r.value)));
  return vals.size === 1 ? best[0] : null; // a tie between different values = abstain
}

/** @param {string} question @param {{documentId:string,name?:string,record:object}[]} entries verified records only */
export function answerFromRecords(question, entries) {
  if (!question || !entries?.length || AGG_RE.test(question)) return null;
  const { by, ids, hits } = findRecords(question, entries);
  if (!hits.length) return null;
  if (by === "party" && hits.length > 3) return null;
  const picks = [];
  for (const e of hits) {
    const p = pickRows(question, e.record, ids);
    if (!p) return null; // a matched document that cannot answer cleanly => do not answer from the others
    if (p.type === "money" && e.record.reconcile?.status === "fail") return null;
    picks.push({ e, p });
  }
  if (new Set(picks.map((x) => String(x.p.value))).size !== 1) return null; // documents disagree (e.g. a revised copy) => abstain
  const { e, p } = picks[0];
  const shown = p.type === "money" ? fmtMoney(p.value) : p.type === "date" ? fmtDate(p.value) : String(p.value);
  const where = `page ${p.row.page} of ${e.name ?? "the document"}`;
  const text = `${p.label}: ${shown} (${where}, printed as "${String(p.row.span).trim()}").` + (picks.length > 1 ? ` ${picks.length} stored copies state the same value.` : "");
  return {
    kind: "answer", text, facts: [{ label: p.label, value: shown }],
    sources: picks.map((x) => ({ documentId: x.e.documentId, location: { page: Number(x.p.row.page) } })),
    confidence: 1, verifiedCount: 1, unverifiedCount: 0, closest: [], docRecords: true,
  };
}
