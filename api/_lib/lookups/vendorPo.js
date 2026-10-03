/**
 * Vendor-scoped purchase-order spend: "how much did we spend with Baker on POs" must filter by the vendor, not return the
 * company-wide PO total. General rule: a distinctive word of a stored PO vendor name (or a 1-typo variant of it) appears in the
 * question -> that vendor scopes the total. Several vendors named -> no scoping (shop-wide, as before).
 * Kill switch: DONOVAN_VENDOR_PO=0 restores the old behaviour (no vendor scoping, original routing).
 */
const GENERIC = new Set(["supply", "supplies", "distributing", "distribution", "distributors", "distributor", "wholesale", "company", "inc", "llc", "corp", "hvac", "parts", "and", "the", "co", "group", "services", "service"]);
const PO_RE = /\bpurchase orders?\b|\bpos?\b/i;
const MONEY_RE = /\b(?:spen[dt]|spending|paid|pay|cost|costs|total|how much|amount|worth)\b/i;

export const vendorPoEnabled = () => process.env.DONOVAN_VENDOR_PO !== "0";

/** PO money question (any phrasing) -> routes to the PO total handler. */
export function isPoMoneyQuestion(q) {
  return vendorPoEnabled() && PO_RE.test(q) && MONEY_RE.test(q) && !/\bhow many\b|\bnumber of\b|\bcount\b/i.test(q);
}

const lev1 = (a, b) => {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1 || a.length < 5) return false;
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  return s.slice(i) === l.slice(i + 1);
};

/** Pure. @returns the stored vendor name the question names, or null. */
export function matchVendor(question, vendorNames) {
  if (!vendorPoEnabled()) return null;
  const qw = String(question ?? "").toLowerCase().match(/[a-z0-9&]+/g) ?? [];
  const hits = new Set();
  for (const v of vendorNames) {
    const vw = (String(v).toLowerCase().match(/[a-z0-9&]+/g) ?? []).filter((w) => !GENERIC.has(w) && w.length >= 3);
    if (vw.some((w) => qw.some((x) => x === w || lev1(x, w)))) hits.add(v);
  }
  return hits.size === 1 ? [...hits][0] : null;
}
