/**
 * A PARTIAL business/organization name resolves to the ONE customer it can only mean ("the Sunrise Valley Elementary invoice" ->
 * "Sunrise Valley Elementary School"), instead of the question falling through to a company-wide total.
 * Rule (general): a run of >=2 consecutive words in the question equals a run of consecutive words inside the stored name of a
 * customer with >=3 words (organizations; "First Last" people keep their own resolvers), and is not itself a whole stored name.
 *   exactly one customer has that run -> the question text is rewritten to the stored full name (announced like a nickname fix)
 *   several customers share the longest run -> nothing is guessed: a "which one do you mean" answer lists them
 * Kill switch: DONOVAN_PARTIAL_NAMES=0.
 */
const STOP = new Set(["the", "a", "an", "of", "and", "for", "to", "in", "on", "at", "is", "was", "how", "much", "what", "do", "we", "have", "our", "my", "their", "with"]);
const MONEY_Q_RE = /\b(?:invoices?|invoiced|bills?|billed|balance|owe[sd]?|paid|pay|quotes?|estimates?|how much|total|amount|cost|price|charged?)\b/i;
const lc = (s) => String(s ?? "").toLowerCase();
const words = (s) => [...String(s ?? "").matchAll(/[A-Za-z][A-Za-z'’&-]*/g)].map((m) => ({ w: lc(m[0]).replace(/['’]s$/, ""), i: m.index, len: m[0].length }));

/** Pure. @returns {question, note:{typed,resolved}} | {ambiguous:{typed,names}} | null */
export function resolvePartialNameInQuestion(question, vocab) {
  if (process.env.DONOVAN_PARTIAL_NAMES === "0") return null;
  // Scoped to money questions: that is where an unresolved name falls back to a company-wide total. Other shapes (units, contact, address)
  // already resolve a partial organization name themselves.
  const r = MONEY_Q_RE.test(String(question ?? "")) ? resolvePartial(question, vocab) : null;
  if (r?.ambiguous) return r;
  const base = r?.question ?? String(question ?? "");
  const q2 = nameBeforeInvoiceNoun(base, vocab);
  if (!r && q2 === base) return null;
  return { question: q2, note: r?.note ?? null };
}

/** "the Thomas Mercer invoice" / "Copper Sky Dental bill" -> "the invoice for Thomas Mercer": a stored customer name used as a modifier of the money noun. */
function nameBeforeInvoiceNoun(q, vocab) {
  let out = q;
  for (const n of vocab?.customers?.phrases ?? []) {
    const nm = String(n).trim(); if (!nm) continue;
    const esc = nm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    const re = new RegExp(`((?:\\bthe\\s+)?)(?<![A-Za-z'’])${esc}(?![A-Za-z'’])\\s+(invoices?|bills?)\\b`, "i");
    const m = re.exec(out);
    if (!m) continue;
    const pre = out.slice(0, m.index); const noun = m[2].toLowerCase();
    if (/\b(?:for|to|from|of|with)\s*$/i.test(pre)) continue;
    const post = out.slice(m.index + m[0].length);
    // a bare lead-in ("what's the X bill", "X invoice amount") asks how much: say so in the shape the money router reads
    if (/^\W*(?:(?:what(?:'s|’s| is| was)?|tell me|show me|give me|i need|need|get me)\s+)?(?:the\s+)?$/i.test(pre) && /^\W*(?:(?:amount|total|cost|price|balance)\W*)?$/i.test(post)) { out = `how much was the invoice for ${nm}`; break; }
    out = `${pre}the ${noun} for ${nm}${post}`;
    break;
  }
  return out;
}

function resolvePartial(question, vocab) {
  const q = String(question ?? "");
  const names = (vocab?.customers?.phrases ?? []).filter((n) => words(n).length >= 3);
  if (!names.length || /["“”]/.test(q)) return null;
  const all = new Set((vocab?.customers?.phrases ?? []).map(lc));
  const covered = [];
  for (const n of vocab.customers.phrases) { const re = new RegExp(`(?<![A-Za-z])${n.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}(?![A-Za-z])`, "ig"); for (const m of q.matchAll(re)) covered.push([m.index, m.index + m[0].length]); }
  const qw = words(q).map((x) => ({ ...x, w: covered.some(([a, b]) => x.i >= a && x.i < b) ? "\u0000" : x.w }));
  const bw = names.map((n) => ({ n, t: words(n).map((x) => x.w) }));
  let best = null; // longest run; earliest on ties
  for (let s = 0; s < qw.length; s++) {
    for (const b of bw) {
      for (let k = 0; k < b.t.length; k++) {
        let L = 0;
        while (s + L < qw.length && k + L < b.t.length && qw[s + L].w === b.t[k + L]) L++;
        if (L < 2 || L >= b.t.length && k === 0) continue; // a whole stored name is already a full mention
        if (qw.slice(s, s + L).every((x) => STOP.has(x.w))) continue;
        if (!best || L > best.L) best = { s, L };
      }
    }
  }
  if (!best) return null;
  const run = qw.slice(best.s, best.s + best.L).map((x) => x.w);
  const hits = bw.filter((b) => b.t.join(" ").includes(run.join(" "))).filter((b) => ` ${b.t.join(" ")} `.includes(` ${run.join(" ")} `));
  const start = qw[best.s].i; const end = qw[best.s + best.L - 1].i + qw[best.s + best.L - 1].len;
  const typed = q.slice(start, end);
  if (all.has(lc(typed))) return null;
  const uniq = [...new Set(hits.map((h) => h.n))];
  if (uniq.length === 1) {
    // the run must not also sit inside the full name already written right there (e.g. "Sunrise Valley Elementary School")
    if (lc(q.slice(start)).startsWith(lc(uniq[0]))) return null;
    return { question: `${q.slice(0, start)}${uniq[0]}${q.slice(end)}`, note: { typed, resolved: uniq[0] } };
  }
  if (uniq.length > 1) return { ambiguous: { typed, names: uniq.slice(0, 6), question: q, start, end } };
  return null;
}

export function buildPartialNameClarify(a) {
  return {
    kind: "no-answer",
    text: `"${a.typed}" matches more than one customer (${a.names.join(", ")}). Which one do you mean? I won't guess whose record it is. Tap one, or ask by full name.`,
    facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
    clarify: true, clarifyReason: "ambiguous-partial-name",
    didYouMean: a.names.slice(0, 3).map((n) => ({ text: `${a.question.slice(0, a.start)}${n}${a.question.slice(a.end)}` })),
  };
}
