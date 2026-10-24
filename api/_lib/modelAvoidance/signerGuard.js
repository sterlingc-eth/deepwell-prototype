/**
 * Docread2 round (2026-10-23): a name printed in a SIGNATURE BLOCK is a signer, not a party.
 *
 * THE DEFECT (Ridgeline / Redwood / Westfield event contracts, 5 documents): the closing line
 *   "Venue: Rachel Ibarra Date: ________   Client: Colin Dunn Date: ________"
 * was read as customer_name = "Colin Dunn", while the page's own party clause says "between the Venue and Harborlight
 * Neighbors Alliance (the Client)". A person who signs for a party is not the party.
 *
 * RULE (generic, every industry; never a file name or a phrase of one test file): a name read from a signature-block line
 * ("By:", "Signature", "Authorized representative", "Name / Title", a line printed under a signature rule, or the lines
 * after a "Signatures" / "Accepted and agreed" heading) is NOT a party UNLESS the same name is also printed somewhere that
 * is not a signature block (the party clause, a BILL TO / CLIENT block, a header). Pure functions, no I/O.
 */

const SIGNER_LABEL = /(?<![A-Za-z])(?<!\b(?:pay|paid|prepared|reviewed|submitted|requested|approved|required|issued|billed|ordered|created|sold|serviced|performed|installed|delivered|checked|entered|written|assigned|referred)\s)(?:by|signature|signed|sign|authori[sz]ed\s+(?:representative|signatory|signer|agent|officer)|name\s*\/\s*title|print(?:ed)?\s+name)\s*:/i;
const SIG_HEADING = /^(?:signatures?|in\s+witness\s+whereof|accepted\s+and\s+agreed|agreed\s+and\s+accepted|agreed\s+to\s+and\s+accepted|acknowledged\s+and\s+agreed|executed\s+(?:by|as))\b/i;
const SIG_RULE = /_{8,}/;

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** @param {{t:string}[]} lines  non-empty, whitespace-collapsed lines in reading order. Returns boolean[] (true = signature-block line). */
export function signatureLineFlags(lines) {
  const flags = new Array(lines.length).fill(false);
  let headingAt = -100;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].t;
    if (SIG_HEADING.test(t)) { headingAt = i; flags[i] = true; continue; }
    if (SIGNER_LABEL.test(t)) flags[i] = true;
    else if (i > 0 && SIG_RULE.test(lines[i - 1].t) && !SIG_RULE.test(t.replace(/_/g, "").trim() ? "" : t)) flags[i] = true; // printed under a signature rule
    else if (i - headingAt <= 4) flags[i] = true; // within 4 lines after a "Signatures" heading
    if (SIG_RULE.test(t)) flags[i] = true;
  }
  return flags;
}

/** True when `value` is read from a signature-block line and printed nowhere else. */
export function isSignerOnly(value, line, lines, flags) {
  const v = norm(value).toLowerCase();
  if (!v || v.length < 3) return false;
  const idx = lines.indexOf(line);
  if (idx < 0 || !flags[idx]) return false;
  for (let i = 0; i < lines.length; i++) {
    if (flags[i]) continue;
    if (lines[i].t.toLowerCase().includes(v)) return false; // also printed outside a signature block (party clause, block, header)
  }
  return true;
}

/** Same check from a stored fact: its quote (verbatim) and page. Returns {signer:boolean, quote?} */
export function signerFromQuote(value, quote, pageNo, pages) {
  const lines = [];
  for (const p of pages ?? []) {
    for (const r of String(p?.text ?? "").split(/\r?\n/)) {
      const t = norm(r);
      if (t) lines.push({ t, page: Number(p.page_no) || 1 });
    }
  }
  const q = norm(quote);
  if (!q) return { signer: false };
  const line = lines.find((l) => l.page === (Number(pageNo) || l.page) && (l.t.includes(q) || q.includes(l.t)));
  if (!line) return { signer: false };
  return { signer: isSignerOnly(value, line, lines, signatureLineFlags(lines)), quote: line.t.slice(0, 200) };
}

/** True when every line of the paper that prints `value` is a signature-block line (and at least one does). Returns {signer, quote, page}. */
export function signerOnlyByValue(value, pages) {
  const lines = [];
  for (const p of pages ?? []) {
    for (const r of String(p?.text ?? "").split(/\r?\n/)) { const t = norm(r); if (t) lines.push({ t, page: Number(p.page_no) || 1 }); }
  }
  const v = norm(value).toLowerCase();
  if (!v || v.length < 3) return { signer: false };
  const flags = signatureLineFlags(lines);
  const hits = lines.map((l, i) => ({ l, i })).filter((x) => x.l.t.toLowerCase().includes(v));
  if (!hits.length || !hits.every((x) => flags[x.i])) return { signer: false };
  return { signer: true, quote: hits[0].l.t.slice(0, 200), page: hits[0].l.page };
}
