/**
 * Our own company (F1, 2026-10-10). A bill addressed to the tenant's own company created the tenant as a customer 13 times in the
 * live export, and a store letterhead was read as `shop_*` (our company) when it was the issuer. Both need to know who "we" are.
 *
 * Where the tenant's own name lives (no new storage): `tenants.name` and `tenants.settings` (->>'business_name' /
 * 'company_name' / 'shop_name', set by onboarding and the settings screen) and, when migration 18 is pasted,
 * `tenant_outreach_settings.shop_name`. `ctx.tenantName` is the Clerk org id (queue.js falls back to the tenant key), so it
 * is used only when it does not look like an id. Every read is best-effort: a missing table or column just yields fewer names.
 *
 * Pure matching helpers + one reader. No model.
 */

const SUFFIX = /\b(?:incorporated|inc|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|lp|llp|pllc|pc|p\.c|plc|dba|the)\b\.?/gi;

/** Lower-case letters and digits only, legal suffixes removed: "Juniper Lane Mercantile, LLC" -> "juniperlanemercantile". */
export function nameKey(raw) {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/\band\b/g, "&")
    .replace(SUFFIX, " ")
    .replace(/[^a-z0-9&]+/g, "")
    .trim();
}

const looksLikeId = (s) => /^org_[A-Za-z0-9]+$/.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s) || /^[A-Za-z0-9_-]{24,}$/.test(s);

/** Distinct usable own-company names from whatever the caller could read. */
export function cleanOwnNames(list) {
  const out = [];
  const seen = new Set();
  for (const n of list ?? []) {
    const s = String(n ?? "").replace(/\s+/g, " ").trim();
    if (s.length < 3 || s.length > 120 || looksLikeId(s)) continue;
    const k = nameKey(s);
    if (k.length < 3 || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/**
 * True when `name` is (a close variant of) one of our own names: equal after normalising, or one contains the other when the
 * shorter one is at least two words / 8 characters ("Juniper Lane" inside "Juniper Lane Mercantile"). Deliberately not a loose
 * fuzzy match: calling a real customer "us" hides them.
 */
export function isOwnName(name, ownNames) {
  const a = nameKey(name);
  if (a.length < 3) return false;
  for (const o of ownNames ?? []) {
    const b = nameKey(o);
    if (b.length < 3) continue;
    if (a === b) return true;
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    if (short.length >= 8 && long.startsWith(short)) return true;
  }
  return false;
}

/**
 * Read the tenant's own names inside an open tenant transaction (`db` = recordsStore's makeStore, RLS-scoped).
 * Never throws; returns [] when nothing is known.
 */
export async function loadOwnNames(db, ctx = {}) {
  const names = [];
  if (ctx?.tenantName) names.push(ctx.tenantName);
  // Each read runs under a SAVEPOINT: a missing table/column must not abort the caller's tenant transaction.
  const guarded = async (tag, sql, pick) => {
    try {
      await db.raw(`SAVEPOINT own_names_${tag}`, []);
      const { rows } = await db.raw(sql, []);
      await db.raw(`RELEASE SAVEPOINT own_names_${tag}`, []);
      for (const r of rows ?? []) names.push(...pick(r));
    } catch {
      try { await db.raw(`ROLLBACK TO SAVEPOINT own_names_${tag}`, []); } catch { /* not in a transaction */ }
    }
  };
  await guarded("t", "SELECT name, settings->>'business_name' AS b, settings->>'company_name' AS c, settings->>'shop_name' AS s FROM tenants WHERE id = (current_setting('app.tenant_id', true))::uuid", (r) => [r.name, r.b, r.c, r.s]);
  await guarded("o", "SELECT shop_name FROM tenant_outreach_settings WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid", (r) => [r.shop_name]);
  return cleanOwnNames(names);
}

/**
 * Own-company guard over normalized fields ({field_key,value,confidence,...}): we are never the customer, and never the
 * vendor of a document addressed to us. Returns {fields, removed}. A removed customer_name means the OTHER business is the
 * counterparty; if the document had no vendor and a letterhead/"From" vendor was already read it stays.
 */
export function applyOwnCompanyGuard(fields, ownNames) {
  if (!ownNames?.length) return { fields, removed: [] };
  const removed = [];
  const kept = [];
  for (const f of fields ?? []) {
    if ((f?.field_key === "customer_name" || f?.field_key === "vendor") && isOwnName(f.value, ownNames)) {
      removed.push({ field_key: f.field_key, value: f.value });
      continue;
    }
    kept.push(f);
  }
  return { fields: kept, removed };
}

/* ------------------------------------------------------------------ letterhead */
const DOC_WORDS = /\b(?:receipt|invoice|statement|agreement|certificate|ticket|slip|bill|order|quote|estimate|letter|memo|contract|lease|form|report|summary|confirmation|ledger|nda|schedule|policy|proposal|page|copy|original|duplicate|customer|thank|thanks|welcome|total|subtotal|date|paid|cash|visa|mastercard|credit|debit|approved|sale|return|refund|ship|bill|sold|received|donation|tax|deductible|insurance|acord|liability|parties|between|witness|signature|signed|authorized)\b/i;
const BIZ_WORDS = /\b(?:inc|llc|ltd|corp|co|company|lp|llp|pllc|pc|foundation|church|ministries|clinic|center|centre|supply|supplies|hardware|pharmacy|bakery|cafe|restaurant|market|mart|depot|group|partners|associates|law|attorneys|services|service|store|shop|outfitters|stores|repair|construction|properties|management|realty|mercantile|trading|industries|enterprises|systems|solutions|studio|salon|grill|kitchen|brewing|motors|auto|electric|plumbing|heating|cooling|hvac|college|school|academy|association|society|club|fund|trust|bank|credit union|insurance agency|agency)\b/i;
const CONTACT_LINE = /(?:\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}|@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\bwww\.|https?:\/\/|\b[A-Za-z0-9-]+\.(?:com|net|org|biz|us|co)\b|\b[A-Z]{2}\.?\s+\d{5}(?:-\d{4})?\b|^\d{1,6}\s+\S.*(?:\b(?:st|street|ave|avenue|rd|road|blvd|dr|drive|ln|lane|way|ct|court|hwy|pkwy|suite|ste)\b))/i;

/**
 * The business named at the top of the page (a letterhead / store header): a short name-like line before the first
 * "Label: value" line, backed by an address / phone / web line right after it or by a business word in the name. Returns
 * null unless it is clearly a business name AND is not one of ours. `conf` is 0.85 when both signals agree, 0.8 for one.
 * @param {string[]} lines page text lines, top first
 * @param {{ownNames?: string[], isTitleLine?: (t:string)=>boolean, isLabelLine?: (t:string)=>boolean}} opts
 * @returns {{name: string, index: number, conf: number, own: boolean}|null}
 */
export function detectLetterhead(lines, { ownNames = [], isTitleLine = () => false, isLabelLine = () => false } = {}) {
  const top = Math.min(lines.length, 7);
  for (let i = 0; i < top; i++) {
    const t = String(lines[i] ?? "").replace(/\s+/g, " ").trim();
    if (!t) continue;
    if (isLabelLine(t)) return null;           // reached the body
    if (isTitleLine(t)) continue;               // "RECEIPT", "INVOICE"
    if (t.length < 3 || t.length > 60) continue;
    if (/\d{3,}/.test(t) || /[@$:]/.test(t) || CONTACT_LINE.test(t) || DOC_WORDS.test(t)) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9 .,'&!()\/-]{2,59}$/.test(t) || (t.match(/[A-Za-z]/g) ?? []).length < 3) continue;
    const words = t.split(" ");
    if (words.length > 6) continue;
    // a name is capitalised words (or ALL CAPS); a sentence has lowercase words in it
    if (words.some((w) => /^[a-z]/.test(w) && !["&", "and", "of", "the", "de", "la", "y", "at", "for", "n'", "'n'"].includes(w.toLowerCase()))) continue;
    const next = [lines[i + 1], lines[i + 2], lines[i + 3]].map((x) => String(x ?? ""));
    const contact = next.some((n) => CONTACT_LINE.test(n));
    const biz = BIZ_WORDS.test(t);
    if (!contact && !biz) continue;
    const name = t.replace(/[,.;]+$/, "");
    return { name, index: i, conf: contact && biz ? 0.85 : 0.8, own: isOwnName(name, ownNames) };
  }
  return null;
}

/* ------------------------------------------------------------------ agreement parties */
const PARTIES_RE = /^(?:parties|between|by and between|agreement between|agreement is between|contract between)\s*[:\-]?\s*(.+)$/i;
/**
 * "Parties: A and B" / "Between A and B" -> the counterparty, but ONLY when exactly one of the two is one of our own names
 * (otherwise which side is "us" is a guess). Returns the other party's name or null.
 */
export function counterpartyFromParties(line, ownNames) {
  if (!ownNames?.length) return null;
  const m = PARTIES_RE.exec(String(line ?? "").trim());
  if (!m) return null;
  const clean = (x) => x.replace(/\([^)]*\)/g, " ").replace(/,?\s+(?:a|an)\s+[A-Za-z ]+?(?:corporation|company|partnership|limited liability company)\b.*$/i, "").replace(/\s+/g, " ").replace(/[,;]+$/, "").replace(/(?<!\b(?:inc|co|corp|ltd|llc|llp|lp|jr|sr))\.$/i, "").trim();
  const names = m[1].split(/\s+(?:and|&)\s+/i).map(clean).filter(Boolean);
  if (names.length !== 2 || !names.every((n) => /^[A-Za-z][A-Za-z0-9 .,'&\/()-]{2,70}$/.test(n) && !/\d{3,}/.test(n))) return null;
  const own = names.filter((n) => isOwnName(n, ownNames));
  return own.length === 1 ? names.find((n) => !isOwnName(n, ownNames)) : null;
}
