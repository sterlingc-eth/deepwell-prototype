/**
 * R3 DENIAL RULE: the ONE place that decides whether Donovan may say "I don't see a customer/vendor named X", and the ONE place that writes that text.
 *
 * Donovan may deny a person or company ONLY when no customer or vendor of THIS organization shares any name token with what was asked, after removing titles
 * (mr, mrs, ms, miss, dr, sr, jr ...), punctuation, possessive s, token order, case, and a one-letter typo. Whenever any entity shares a token the verdict is never "deny":
 *   - exactly one customer/vendor holds ALL the asked tokens (any order): `canonical` = that full name, and the caller re-runs its own lane with it;
 *   - otherwise the caller gets a clarifying answer that names the entities that share a token ("which one did you mean?"). It never asserts one of them is the answer.
 * Every lane that wants to deny calls nameVerdict() and may emit denialText() only when verdict.deny is true. Data is read only inside the asking organization (tenant_id of the session).
 */
import { attachCitations } from "../citations/records.js";
const TENANT = "tenant_id = (current_setting('app.tenant_id', true))::uuid";
export const TITLE_TOKENS = new Set(["mr", "mrs", "ms", "miss", "mx", "dr", "sr", "jr", "mister", "missus", "doctor", "prof", "esq", "ii", "iii", "iv"]);
// words that carry no identity on their own: company suffixes and glue. (A shared "supply" or "heating" still counts: only these are ignored.)
const GLUE = new Set(["inc", "llc", "co", "corp", "company", "ltd", "the", "and", "of", "a", "an", "for", "to", "from", "on", "at", "in", "by", "or", "s"]);

export function nameTokens(raw) {
  return String(raw ?? "").toLowerCase().replace(/[’`´]/g, "'").replace(/'s\b/g, "").replace(/'/g, "").replace(/s'(?=\s|$)/g, "s")
    .split(/[^a-z0-9À-ɏ]+/).filter((t) => t && !TITLE_TOKENS.has(t) && !GLUE.has(t));
}
const isNum = (t) => /^\d+$/.test(t);
/** edit distance <= 1 (substitution, insertion, deletion, adjacent transposition) */
export function withinOne(a, b) {
  if (a === b) return true; const la = a.length, lb = b.length; if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    let d = 0, first = -1; for (let i = 0; i < la; i++) if (a[i] !== b[i]) { d++; if (first < 0) first = i; if (d > 2) return false; }
    if (d === 1) return true;
    return d === 2 && a[first] === b[first + 1] && a[first + 1] === b[first];
  }
  const [s, l] = la < lb ? [a, b] : [b, a]; let i = 0; while (i < s.length && s[i] === l[i]) i++;
  return s.slice(i) === l.slice(i + 1);
}
/** same word: equal, equal after a trailing possessive s, or (length >= 4, not a number) one letter off */
export function tokenSame(a, b) {
  if (a === b) return "exact";
  if (a.length > 2 && b.length > 2 && (a === `${b}s` || b === `${a}s`)) return "exact";
  if (a.length >= 4 && b.length >= 4 && !isNum(a) && !isNum(b) && (withinOne(a, b) || withinOne(a.replace(/s$/, ""), b.replace(/s$/, "")))) return "typo";
  return null;
}

async function loadEntities(db) {
  const out = [];
  const c = await db.raw(`SELECT id, data->>'customer_name' AS n FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT}`, []);
  for (const r of c.rows) if (r.n) out.push({ id: r.id, type: "customer", name: String(r.n) });
  try {
    const v = await db.raw(`SELECT DISTINCT value AS n FROM extractions WHERE field_key = 'vendor_name' AND value IS NOT NULL AND ${TENANT}`, []);
    for (const r of v.rows) if (r.n && String(r.n).trim()) out.push({ id: null, type: "vendor", name: String(r.n).trim() });
  } catch { /* extractions unavailable: customers only */ }
  return out;
}

/** who shares a name token with `raw`, in this organization only. Entities that hold every asked token (any order, exact words) come back as `full`. */
export async function nameVerdict(db, raw) {
  const asked = nameTokens(raw);
  if (!asked.length) return { deny: true, asked, full: [], partial: [] };
  const ents = await loadEntities(db);
  const full = [], partial = [];
  const seen = new Set();
  for (const e of ents) {
    const key = `${e.type}:${e.name.toLowerCase()}`; if (seen.has(key)) continue; seen.add(key);
    const et = nameTokens(e.name); if (!et.length) continue;
    const hits = asked.map((t) => { let best = null; for (const x of et) { const s = tokenSame(t, x); if (s === "exact") return "exact"; if (s) best = "typo"; } return best; });
    if (!hits.some(Boolean)) continue;
    // a share by misspelling alone counts only when it covers at least half of the asked words ("Thmas Mercer", "Kaen Abernathy"); one near-spelled word among several unmatched ones does not
    if (!hits.includes("exact") && hits.filter(Boolean).length * 2 < asked.length) continue;
    const allExact = hits.every((h) => h === "exact");
    (allExact ? full : partial).push({ ...e, exactAll: allExact, covers: hits.every(Boolean), hasExact: hits.includes("exact") });
  }
  // an entity whose own words are ALL among the asked words ("Smith" asked about "Mr Smith") is a full match even when more words were asked
  if (!full.length) {
    for (const e of ents) { /* second chance: every word of the entity's name was asked */
      const et = nameTokens(e.name); if (et.length > 1 && et.every((x) => asked.some((t) => tokenSame(t, x) === "exact")) && !full.some((f) => f.name === e.name)) { full.push({ ...e, exactAll: true, covers: asked.every((t) => et.some((x) => tokenSame(t, x))) }); const i = partial.findIndex((p) => p.name === e.name && p.type === e.type); if (i >= 0) partial.splice(i, 1); }
    }
  }
  if (!full.length && !partial.length) return { deny: true, asked, full, partial };
  // exactly one customer (or, with no customer, one vendor) holds every asked word -> the caller answers about it
  const fc = full.filter((e) => e.type === "customer"), fv = full.filter((e) => e.type === "vendor");
  let canonical = null, type = null;
  if (fc.length === 1) { canonical = fc[0].name; type = "customer"; } else if (!fc.length && fv.length === 1) { canonical = fv[0].name; type = "vendor"; }
  if (!canonical) { const un = [...new Set(full.map((e) => e.name.toLowerCase()))]; if (un.length === 1) { const e = full.find((x) => x.type === "customer") ?? full[0]; canonical = e.name; type = e.type; } }
  return { deny: false, asked, full, partial, canonical, type };
}

/** the clarifying sentence used instead of a denial when entities share a name token but no single one is certain */
export function clarifyText(raw, v, what = "") {
  const list = [...v.full, ...v.partial].slice(0, 6);
  const names = [...new Set(list.map((e) => e.name))];
  const asked = String(raw).trim();
  // some customers share a whole word but none holds every word asked ("Jessica Sandoval" when only other Sandovals exist): the person asked for is not on file as asked
  if (!v.full.length && names.length > 1 && v.partial.some((e) => e.hasExact)) return `I couldn't find "${asked}" as asked${what ? ` for ${what}` : ""}. These share part of that name: ${names.join(", ")}. Did you mean one of them?`;
  if (v.canonical && names.length === 1) return `${v.canonical} is on file as ${v.type === "vendor" ? "a vendor" : "a customer"}. Ask me something specific about ${v.type === "vendor" ? "them" : "them"}, for example "${v.type === "vendor" ? "bills from" : "latest invoice for"} ${v.canonical}".`;
  if (names.length === 1) return `I couldn't match "${asked}" exactly${what ? ` for ${what}` : ""}. Did you mean ${names[0]}? Ask again with that name and I'll answer.`;
  return `I couldn't match "${asked}" to exactly one record${what ? ` for ${what}` : ""}. These share part of that name: ${names.join(", ")}. Which one did you mean?`;
}

/** THE denial text. Only call when nameVerdict(...).deny === true. */
export function denialText({ name, scope = "customer or vendor", ask = "an invoice", tail = "" }) {
  const nm = String(name ?? "").trim();
  if (scope === "customer") return `I don't see a customer named ${nm} on file${tail ? `, ${tail}` : "."}`;
  if (scope === "vendor") return `I don't see a vendor named ${nm} in your records${tail ? `, ${tail}` : "."}`;
  return `I don't see a customer or vendor named ${nm} in your records, so I can't find ${ask} for them. Check the spelling, or ask me for a list of your customers.`;
}

/** the tap-one clarify reply (same shape as lookups/clarify.js) used instead of a denial when entities share part of the name */
export function clarifyEnvelope(raw, v) {
  const ents = [...v.full, ...v.partial].slice(0, 6);
  const names = [...new Set(ents.map((e) => e.name))];
  return attachCitations({
    kind: "no-answer", text: clarifyText(raw, v), facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
    clarify: true, clarifyReason: "name-share", didYouMean: names.slice(0, 3).map((n) => ({ text: `${v.type === "vendor" && v.canonical === n ? "latest bill from" : "latest invoice for"} ${n}` })),
  }, { records: [], total: 0, kind: "searched", basis: `Records share part of "${String(raw).trim()}", so nothing was looked up until you pick one.` });
}
/** Every lane that is about to deny a person/company by name calls this: the denial is returned only when nameVerdict allows it; otherwise the clarifying reply is. */
export async function denyOr(db, name, denial) {
  let v; try { v = await nameVerdict(db, name); } catch { return denial; }
  return v.deny ? denial : clarifyEnvelope(name, v);
}

/** a question that carries a whole customer/vendor name word (4+ letters) of THIS organization: such a question is never classed as off-topic */
export async function questionNamesEntity(db, question) {
  const words = new Set(nameTokens(question).filter((w) => w.length >= 4));
  if (!words.size) return false;
  const ents = await loadEntities(db);
  return ents.some((e) => nameTokens(e.name).some((t) => words.has(t)));
}
