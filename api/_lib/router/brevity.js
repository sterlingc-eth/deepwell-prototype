/**
 * R35 (owner decision 2026-10-01, "blue-collar brevity") — answer text leads with the answer and stays short.
 *
 * capInlineNameList(data): a list answer whose sentence spells out every name ("23 customers were serviced this month: Amy Larkin,
 * Barbara Ellison, ... and Thomas Nakamura.") ALSO carries one fact per name (the rows the card shows) and one citation per record.
 * The sentence then only needs the first few names: "23 customers were serviced this month: Amy Larkin, Barbara Ellison,
 * Betty Zimmerman, Charles Whitford, David Prentiss, and 18 more." Nothing is dropped from the answer — every name is still a fact
 * row and a cited record.
 *
 * Fires only when ALL hold (else the text is left exactly as computed):
 *   - kind 'answer'; the text has ONE "<head>: a, b, c ... (and|, and) z." list of more than MAX_INLINE + 2 items;
 *   - every listed item is present (case-insensitive, whole value) among the answer's fact values or labels.
 * Pure; idempotent (a capped list has MAX_INLINE names before its "and N more" tail, too few to fire again).
 * Kill switch: DONOVAN_BREVITY=0.
 */
export const MAX_INLINE = 5;

const LIST_RE = /:\s((?:[^,:.;\n]{2,80},\s){2,}[^,:.;\n]{2,80}?(?:,?\s(?:and)\s[^,:.;\n]{2,80}?)?)\.(\s|$)/;

export function capInlineNameList(data) {
  if (process.env.DONOVAN_BREVITY === "0") return false;
  if (!data || typeof data !== "object" || data.kind !== "answer" || typeof data.text !== "string") return false;
  const facts = Array.isArray(data.facts) ? data.facts : [];
  if (facts.length < MAX_INLINE + 3) return false;
  const m = LIST_RE.exec(data.text);
  if (!m) return false;
  const items = m[1].split(/,\s(?:and\s)?|\sand\s/).map((s) => s.trim()).filter(Boolean);
  // an already-shortened list ("..., and 4 more") keeps its tail count
  let extra = 0;
  const tail = /^(\d+) more$/.exec(items[items.length - 1] ?? "");
  if (tail) { extra = Number(tail[1]); items.pop(); }
  if (items.length <= MAX_INLINE + 2) return false;
  const have = new Set();
  for (const f of facts) {
    if (!f || typeof f !== "object") continue;
    for (const v of [f.value, f.label]) if (v != null) have.add(String(v).trim().toLowerCase());
  }
  if (!items.every((it) => have.has(it.toLowerCase()))) return false;
  const kept = items.slice(0, MAX_INLINE).join(", ");
  const capped = `: ${kept}, and ${items.length - MAX_INLINE + extra} more.${m[2]}`;
  data.text = data.text.slice(0, m.index) + capped + data.text.slice(m.index + m[0].length);
  return true;
}
