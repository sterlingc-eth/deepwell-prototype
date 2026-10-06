/**
 * R38 (second-tenant generalization). "How many Navien units" / "how many customers in Sahuarita" / "how many invoices did Dana Whitfield do":
 * counts filtered by a brand, city or technician taken from THIS tenant's own data (vocab/tenantVocab.js), not a fixed HVAC list.
 * Before this, a brand/city/technician outside the built-in lists was silently dropped and the whole-shop total came back as the answer (a confident
 * wrong number). Closed shape only: count words + exactly one vocab entity + a noun + filler; anything else returns null (older path / model).
 * Kill switch: DONOVAN_VOCAB_COUNT=0.   pure: parseVocabCount(question, vocab)    db: runVocabCount
 */
import { attachCitations } from "../citations/records.js";
import { customerRecordsFor } from "../citations/enrich.js";
import { TENANT_SQL, answerEnvelope } from "../scope.js";
import { deriveGeo } from "../analytics.js";
import { VOCAB as SYSTEM_VOCAB } from "../nlNormalize.js";
import { properNameTokens, casingCarriesInformation, tokenize as rawTokenize } from "../router/leftover.js";

const norm = (s) => ` ${String(s ?? "").toLowerCase().replace(/[’`]/g, "'").replace(/'s\b/g, "").normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
const FILLER = new Set("any how many mny number of count the our all we do have has are there is on file in total installed that with a an and or got you your us it from by made brand make customers customer clients client homes people live living located based on".split(" "));
const UNIT_NOUNS = /\b(?:units?|systems?|equipment|devices?|heaters?|water|tankless|tank|pumps?|sump|softeners?|backflow|preventers?|preventer)\b/g;
const COUNT_RE = /\b(?:how many|number of|count of|total)\b/;
// R39: "do we have any customers in Sahuarita" / "are there any Navien units" - the same count, asked as yes/no (ask.js's existence wrapper adds the Yes/No lead).
const EXIST_RE = /^\s*(?:do|does|did|is|are|have|has)\s+(?:we|you|there|our shop)\b[^?]*\bany\b/;
const INV_WORDS = new Set("invoices invoice did does has have do done write wrote written invoiced handle handled complete completed work worked ".trim().split(" "));

function firstLast(name) { const w = norm(name).trim().split(" "); return w; }


/* ------------------------------------------------------------------ R39: the organization's own KINDS of equipment ("sump pump", "water heater (tankless)")
 * "how many sump pumps do we have" / "how many tankless water heaters have we installed" / "how many Navien tankless units": the noun is a value of the
 * unit record's equipment_type, taken from THIS organization's own data (vocab.equipmentTypes). A type phrase that is not one of the organization's types
 * is never guessed at; it declines (the leftover-condition check in router/leftover.js then keeps the whole-shop total from being printed). */
const GENERIC_UNIT = new Set(["unit", "units", "system", "systems", "equipment", "device", "devices", "machine", "machines", "piece", "pieces", "of"]);
const TYPE_FILLER = new Set(["installed", "install", "tracking", "tracked", "track", "put", "weve", "got", "carrying", "carry", "stock", "hand", "serviced", "sold", "currently", "right", "now", "ever", "up", "running", "active", "own", "keep", "keeping", "kept", "managing", "manage", "maintain", "maintaining", "registered", "recorded", "logged", "files", "file", "records", "record", "system", "database", "books", "customers", "customer"]);
/** "water heater (tankless)" -> "tankless water heater" (the organization's own value, read the way an owner says it). */
const typeLabel = (t) => { const m = /^(.*?)\s*\((.*?)\)\s*$/.exec(String(t)); return m ? `${m[2]} ${m[1]}`.trim() : String(t); };
const typeBase = (t) => String(t).replace(/\s*\(.*\)\s*$/, "").trim();
const typeLabels = (ts) => (ts.length > 1 && new Set(ts.map(typeBase)).size === 1 ? typeBase(ts[0]) : ts.map(typeLabel).join(" or "));
const singular = (w) => (w.length > 3 ? w.replace(/ies$/, "y").replace(/(?<![s])s$/, "") : w);
function typeKeys(typeValue) {
  const m = /^(.*?)\s*\((.*?)\)\s*$/.exec(String(typeValue));
  const base = norm(m ? m[1] : typeValue).trim();
  const qual = norm(m ? m[2] : "").trim();
  const keys = new Set([base]);
  if (qual) { keys.add(`${qual} ${base}`); keys.add(`${base} ${qual}`); }
  return new Set([...keys].filter(Boolean).map((k) => k.split(" ").map(singular).join(" ")));
}
/** The org's equipment_type values the typed words name, or []. */
function matchEquipmentTypes(words, vocab) {
  const key = words.map(singular).join(" ");
  if (!key || !vocab?.equipmentTypes?.length) return [];
  const exact = vocab.equipmentTypes.filter((t) => typeKeys(t).has(key));
  if (exact.length) return exact;
  // the head noun alone ("softener", "pump") when exactly one of the organization's types ends with it
  const byHead = vocab.equipmentTypes.filter((t) => { const m = /^(.*?)\s*(?:\(.*\))?\s*$/.exec(String(t)); const b = norm(m?.[1] ?? t).trim().split(" "); return b.map(singular)[b.length - 1] === key; });
  if (byHead.length === 1) return byHead;
  // the qualifier alone ("tankless", "tank") names a kind when exactly ONE of the organization's types carries it
  const byQual = vocab.equipmentTypes.filter((t) => { const m = /\(([^)]*)\)\s*$/.exec(String(t)); return m && norm(m[1]).trim().split(" ").map(singular).join(" ") === key; });
  return byQual.length === 1 ? byQual : [];
}
function parseTypeCount(q, vocab) {
  if (!vocab?.equipmentTypes?.length) return null;
  const customers = /\b(?:customers?|clients?|homes|people|owners)\b/.test(q);
  const words = q.split(/\s+/).filter(Boolean).filter((w) => !FILLER.has(w) && !GENERIC_UNIT.has(w) && !TYPE_FILLER.has(w));
  if (!words.length || words.length > 4) return null;
  const types = matchEquipmentTypes(words, vocab);
  return types.length ? { kind: "etype", value: words.join(" "), types, customers } : null;
}

/* ------------------------------------------------------------------ R39: a NAMED thing this organization has never heard of
 * "how many Navien units" / "how many customers in Sahuarita" / "how many invoices did Dana Whitfield do" / "how many customers named Smythe":
 * when the one unexplained phrase in a closed count shape is name-like (capitalized or carries a digit in the question as typed) and is NOT
 * close to anything this organization's own data holds (decided from the tenant vocabulary, never a built-in list), the true answer is zero /
 * "none on file" - not the whole-shop total. If it IS close to something on file (a misspelling, a first name, a substring) the lane declines
 * (returns null) so the clarify / model path can ask which one was meant. runVocabCount re-verifies against the rows themselves. */
const LOC_PREP = new Set(["in", "at", "near", "around"]);
const CUST_WORDS = new Set(["customers", "customer", "clients", "client", "homes", "people", "owners"]);
const UNIT_WORD = new Set(["units", "unit", "systems", "system", "equipment", "devices", "device", "heaters", "heater", "pumps", "pump", "softeners", "softener", "preventers", "preventer", "machines", "machine"]);
const JOB_NOUNS = new Set(["invoices", "invoice", "jobs", "job", "visits", "visit", "calls", "call", "tickets", "ticket", "orders", "order", "service", "work"]);
const PERSON_VERBS = new Set(["do", "done", "does", "did", "write", "wrote", "written", "handle", "handled", "complete", "completed", "work", "worked", "close", "closed", "have", "has", "make", "made", "send", "sent", "invoiced", "invoice", "bill", "billed", "finish", "finished", "run", "ran", "perform", "performed", "log", "logged", "ticket", "tickets", "job", "jobs", "visits", "visit", "calls", "call", "invoices"]);
const RUN_STOP = new Set(["named", "called", "name", "last", "first", "surname", "with", "the"]);

function lev(a, b, max) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], prev[j - 2] ?? Infinity, cur[j]);
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
/** A token is "close" to a known word when it is the same, a one/two-letter slip away (by length), or one contains the other (4+ letters). */
function closeWord(t, k) {
  if (t === k) return true;
  // an abbreviation / prefix of a word on file ("Mitsu", "Carr", "Whit") is that word, not a stranger
  if (t.length >= 2 && k.length > t.length && k.startsWith(t)) return true;
  if (k.length >= 3 && t.length > k.length && t.startsWith(k)) return true;
  const m = Math.min(t.length, k.length);
  if (m >= 4 && (t.includes(k) || k.includes(t))) return true;
  const max = m >= 7 ? 2 : m >= 4 ? 1 : 0;
  if (max > 0 && lev(t, k, max) <= max) return true;
  return nearGenerous(t, k);
}
/** Optimal-string-alignment (Damerau) distance: a swapped pair of letters counts as ONE edit. */
function osa(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
const isSubseq = (s, w) => { let i = 0; for (const c of w) if (i < s.length && c === s[i]) i++; return i === s.length; };
/** R39 round 6: "near" for the purpose of a truthful zero is generous. A name that might be a misspelling of something this organization has is never reported as 0:
 *  edit distance <= 2 (Damerau; <= 3 for 8+ letters), or the typed word is a subsequence of a word on file with the same first letter ("Trn" / "Trane", "Mrer" / "Mercer"),
 *  or same first letter, lengths within 2 and at least 60% of the letters shared. */
function nearGenerous(t, k) {
  if (!t || !k || !/^[a-z]/.test(t) || !/^[a-z]/.test(k)) return false;
  const m = Math.min(t.length, k.length), M = Math.max(t.length, k.length);
  const max = M >= 8 ? 3 : m >= 4 ? 2 : 1;
  if (osa(t, k, max) <= max) return true;
  // a short typed word with one wrong letter whose remaining letters appear in order in a longer word on file ("Yra" / "Trane")
  if (/\s/.test(t) || /\s/.test(k)) return false; // only word-to-word: a phrase on file is compared by edit distance alone
  if (t.length >= 3 && t.length <= 4 && t.length < k.length && t.split("").some((_, i) => isSubseq(t.slice(0, i) + t.slice(i + 1), k))) return true;
  if (t[0] !== k[0]) return false;
  if (M - m <= 2 && m >= 4) {
    const pool = k.split(""); let shared = 0;
    for (const c of t) { const i = pool.indexOf(c); if (i >= 0) { shared++; pool.splice(i, 1); } }
    if (shared / M >= 0.6) return true;
  }
  return false;
}
function knownWords(lists) {
  const out = new Set();
  for (const l of lists) for (const v of l ?? []) for (const w of norm(v).trim().split(" ")) if (w.length >= 2) out.add(w);
  return out;
}
function nearAny(tokens, known, whole) {
  const joined = tokens.join(" ");
  for (const k of known) {
    for (const t of tokens) if (t.length >= 4 && closeWord(t, k)) return true;
  }
  if (whole) for (const w of whole) { const n = norm(w).trim(); if (n && (n === ` ${joined} `.trim() || closeWord(joined, n))) return true; }
  return false;
}
/** The typed (original-casing) words that make up the normalized run, or null when the run cannot be located after the first word of the question. */
function findRawRun(raw, run) {
  const rts = rawTokenize(raw).map((t) => t.text);
  const flat = [];
  rts.forEach((rt, ri) => { for (const w of norm(rt).trim().split(" ").filter(Boolean)) flat.push({ w, ri }); });
  for (let a = 1; a + run.length <= flat.length; a++) {
    if (run.every((w, k) => flat[a + k].w === w)) {
      const ris = [...new Set(flat.slice(a, a + run.length).map((f) => f.ri))];
      if (ris[0] === 0) return null;
      return ris.map((ri) => rts[ri]);
    }
  }
  return null;
}
/** Initials of every multi-word entry on file, so "AO" / "BW" / "GV" / "KP" are recognised as short forms of something this organization HAS. */
function initialsOf(phrases) {
  const out = new Set();
  for (const ph of phrases ?? []) {
    const w = norm(ph).trim().split(" ").filter(Boolean);
    if (w.length >= 2) out.add(w.map((x) => x[0]).join(""));
  }
  return out;
}
/** Is any typed word a spelling slip, prefix, containment or initialism of ANYTHING this organization's data holds (any kind: brand, model, city, person)? */
function nearEverything(run, vocab) {
  const lists = [vocab.brands, vocab.models, vocab.cities, vocab.technicians?.phrases, vocab.customers?.phrases, vocab.equipmentTypes];
  const known = knownWords(lists);
  const inits = initialsOf(lists.flat());
  for (const t of run) {
    if (inits.has(t) || [...inits].some((i) => i.startsWith(t) && t.length >= 2)) return true;
    for (const k of known) if (closeWord(t, k)) return true;
  }
  const joined = run.join(" ");
  for (const l of lists) for (const w of l ?? []) { const n = norm(w).trim(); if (n && (n === joined || closeWord(joined, n))) return true; }
  return false;
}
/** A person is "close to" a known full name when EVERY typed word is the same as / a slip away from a word of that one name (a typo or a short form of
 *  somebody on file), or the whole phrase is a slip away from it. Sharing only a surname or only a first name with someone is NOT close. A single typed word
 *  is close to any known word of 4+ letters it nearly matches. */
function nearPerson(run, phrases) {
  const joined = run.join(" ");
  for (const ph of phrases ?? []) {
    const pw = norm(ph).trim().split(" ").filter(Boolean);
    if (!pw.length) continue;
    if (closeWord(joined, pw.join(" "))) return true;
    if (run.length === 1) { if (run[0].length >= 3 && pw.some((k) => closeWord(run[0], k))) return true; continue; }
    if (run.every((t) => pw.some((k) => t === k || (t.length >= 4 && closeWord(t, k))))) return true;
  }
  return false;
}

function parseUnknownName(raw, q, vocab) {
  const toks = q.split(/\s+/).filter(Boolean);
  if (toks.length > 12) return null;
  const hasCust = toks.some((t) => CUST_WORDS.has(t));
  const hasUnit = toks.some((t) => UNIT_WORD.has(t) || /^(?:water|tankless|tank|sump|backflow)$/.test(t));
  const hasJobNoun = toks.some((t) => JOB_NOUNS.has(t));
  const GRAMMAR = new Set([...FILLER, ...CUST_WORDS, ...UNIT_WORD, "named", "called", "name", "near", "around", "tank", "water", "tankless", "sump", "backflow"]);
  // the one run of tokens that is neither grammar nor a count/job noun
  const run = []; let runStart = -1; let breaks = 0;
  for (let i = 0; i < toks.length; i++) {
    const w = toks[i];
    const isGrammar = GRAMMAR.has(w) || (hasJobNoun && (JOB_NOUNS.has(w) || PERSON_VERBS.has(w)));
    if (!isGrammar) { if (runStart < 0) runStart = i; else if (run.length && runStart + run.length !== i) breaks++; run.push(w); }
  }
  if (!run.length || run.length > 3 || breaks) return null;
  if (run.some((w) => w.length < 2 || RUN_STOP.has(w))) return null;
  // POSITIVE evidence the owner typed a specific proper name (capitalized, letters only, not English / trade / street / calendar words, not an initialism),
  // read from the question as typed. Anything else (a year, "Q3", "HVAC", "Active", "Good Standing", "Zone 3", "KP") is not a name: decline.
  if (!casingCarriesInformation(raw)) return null;
  const rawRun = findRawRun(raw, run);
  if (!rawRun || !properNameTokens(rawRun)) return null;
  // a word the system itself already reads as geography / a brand / a month (states, counties, built-in cities and brands) belongs to the lanes that
  // own that reading ("customers in Nevada" is a state count): never claim it here as an unknown name.
  if (run.some((w) => SYSTEM_VOCAB.has(w))) return null;
  const prev = toks[runStart - 1] ?? "";
  const after = toks.slice(runStart + run.length);
  const value = rawRun.map((w) => w.replace(/[.,;:!?'’]+$/g, "")).join(" ");
  // technician / person invoices ("how many invoices did Dana Whitfield do")
  if (hasJobNoun && !hasUnit && !hasCust && ["did", "does", "has", "have", "by", "do"].includes(prev) && after.every((w) => PERSON_VERBS.has(w) || FILLER.has(w))) {
    if (nearPerson(run, [...(vocab.technicians?.phrases ?? []), ...(vocab.customers?.phrases ?? [])])) return null;
    const noun = toks.some((t) => t === "invoices" || t === "invoice") ? "invoice" : "job";
    return { kind: "person", value, noun, missing: true, customers: false };
  }
  // customers named / called X
  if (hasCust && !hasUnit && (prev === "named" || prev === "called") && after.every((w) => FILLER.has(w))) {
    const exact = run.length === 1 && knownWords([vocab.customers?.phrases]).has(run[0]);
    if (exact) return { kind: "cname", value, missing: false, customers: true };
    if (nearPerson(run, vocab.customers?.phrases)) return null;
    return { kind: "cname", value, missing: true, customers: true };
  }
  // customers / units in <city>
  if ((hasCust || hasUnit) && (LOC_PREP.has(prev) || (prev === "from" && hasCust)) && after.every((w) => FILLER.has(w) || w === "live" || w === "located")) {
    if (nearEverything(run, vocab)) return null;
    return { kind: "city", value, missing: true, customers: hasCust && !hasUnit, units: hasUnit };
  }
  // <Brand> units / units that are <Brand> / units made by <Brand>
  // closed shapes only: "<Brand> units", "units are / made by / from <Brand>". A name after "on / at / in / near / for / with..." is not a manufacturer.
  const nextTok = toks[runStart + run.length] ?? "";
  const prev2 = toks[runStart - 2] ?? "";
  const brandShape = UNIT_WORD.has(nextTok) || ["are", "is", "make", "brand", "manufacturer", "were", "be"].includes(prev)
    || ((prev === "by" || prev === "from") && ["made", "manufactured", "built", "brand", "make"].includes(prev2))
    || (prev === "from" && UNIT_WORD.has(prev2));
  if (hasUnit && brandShape && !LOC_PREP.has(prev) && !hasJobNoun) {
    if (nearEverything(run, vocab)) return null;
    return { kind: "brand", value, missing: true, customers: hasCust };
  }
  return null;
}

/** Pure. @returns {kind:'brand'|'city'|'tech', value:string, customers:boolean} | null */
export function parseVocabCount(question, vocab) {
  let r;
  try { r = parseVocabCountInner(question, vocab); } catch { return null; } // fail CLOSED: a malformed vocabulary never throws into the router, the question is just not answered here
  return r && EXIST_RE.test(norm(question)) && !COUNT_RE.test(norm(question)) ? { ...r, existence: true } : r;
}
function parseVocabCountInner(question, vocab) {
  if (process.env.DONOVAN_VOCAB_COUNT === "0" || !vocab) return null;
  const raw = String(question ?? "").trim();
  if (!raw || raw.length > 120) return null;
  let q = norm(raw);
  const existence = !COUNT_RE.test(q) && EXIST_RE.test(q);
  if (!COUNT_RE.test(q) && !existence) return null;
  q = q.replace(COUNT_RE, " ");
  const wantsCustomers = /\bcustomers?\b|\bclients?\b|\bhomes\b|\bpeople\b/.test(q);
  const hits = [];
  for (const kind of ["brand", "city", "tech"]) {
    const list = kind === "brand" ? vocab.brands : kind === "city" ? vocab.cities : vocab.technicians?.phrases;
    for (const v of list ?? []) {
      const n = norm(v);
      if (n.trim().length < 3) continue;
      if (q.includes(n)) hits.push({ kind, value: v, n });
    }
  }
  // longest match wins when one vocab value contains another (e.g. "Green Valley" vs "Valley"); two different entities = not a closed shape
  hits.sort((a, b) => b.n.length - a.n.length);
  if (!hits.length) return parseTypeCount(q, vocab) ?? parseUnknownName(raw, q, vocab);
  const top = hits[0];
  if (hits.some((h) => h !== top && !top.n.includes(h.n))) return null;
  const rest = q.replace(top.n, " ").split(/\s+/).filter(Boolean);
  if (top.kind === "brand") {
    if (!UNIT_NOUNS.test(` ${rest.join(" ")} `) && !wantsCustomers) { UNIT_NOUNS.lastIndex = 0; return null; }
    UNIT_NOUNS.lastIndex = 0;
    // a kind of equipment typed next to the brand ("Navien tankless units", "Rheem sump pumps") is a SECOND condition: apply it from the organization's own
    // types, or decline - never count every unit of the brand as if the kind had not been said.
    const kindWords = rest.filter((w) => !FILLER.has(w) && !GENERIC_UNIT.has(w) && !TYPE_FILLER.has(w));
    let types = null;
    if (kindWords.some((w) => /^(?:heaters?|water|tankless|tank|pumps?|sump|softeners?|backflow|preventers?)$/.test(w) || !FILLER.has(w))) {
      types = matchEquipmentTypes(kindWords, vocab);
      if (!types.length) return null;
    }
    const left = rest.join(" ").replace(UNIT_NOUNS, " ").split(/\s+/).filter(Boolean);
    if (!types && left.some((w) => !FILLER.has(w))) return null;
    return { kind: "brand", value: top.value, customers: wantsCustomers, ...(types ? { types } : {}) };
  }
  if (top.kind === "city") {
    if (!wantsCustomers) return null;
    if (rest.some((w) => !FILLER.has(w))) return null;
    return { kind: "city", value: top.value, customers: true };
  }
  if (!rest.some((w) => w === "invoices" || w === "invoice")) return null;
  if (rest.some((w) => !FILLER.has(w) && !INV_WORDS.has(w))) return null;
  return { kind: "tech", value: top.value, customers: false };
}

async function linkedEntityIds(db, docIds) {
  if (!docIds.length) return [];
  const { rows } = await db.raw(`SELECT DISTINCT l.entity_id FROM document_entity_links l WHERE l.document_id = ANY($1::uuid[]) AND l.${TENANT_SQL} LIMIT 200`, [docIds]);
  return rows.map((r) => r.entity_id);
}

/** "how many sump pumps do we have": units whose equipment_type is one the typed words name (the organization's own types). */
async function runEquipmentTypeCount(db, intent) {
  const types = [...new Set(intent.types.map((t) => String(t).toLowerCase()))];
  const label = typeLabels(intent.types);
  const typeWhere = `lower(coalesce(e.data->>'equipment_type','')) = ANY($1::text[])`;
  const owned = `FROM entities e JOIN entities cu ON cu.id = e.customer_id AND cu.entity_type = 'customer' AND cu.merged_into IS NULL AND cu.${TENANT_SQL} WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.${TENANT_SQL} AND ${typeWhere}`;
  if (intent.customers) {
    // "how many customers have a tankless water heater": DISTINCT customers who own at least one unit of that type
    const { rows: [c] } = await db.raw(`SELECT count(*)::int AS total FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL}`, []);
    const { rows: [o] } = await db.raw(`SELECT count(DISTINCT e.customer_id)::int AS n ${owned}`, [types]);
    const { rows: owners } = o.n > 0 ? await db.raw(`SELECT DISTINCT e.customer_id AS id ${owned} ORDER BY 1 LIMIT 200`, [types]) : { rows: [] };
    return attachCitations(
      answerEnvelope({ text: `${o.n} of ${c?.total ?? 0} customers have ${label} (by the equipment type on their unit records).`, facts: [{ label: `Customers with ${label}`, value: String(o.n), entityIds: owners.slice(0, 20).map((r) => r.id), sources: [] }], extra: { fastIntent: "vocab_equipment_type_count" } }),
      { records: await customerRecordsFor(db, owners.map((r) => r.id)), total: o.n, claimedCount: o.n, basis: `Counted the customers who own at least one unit of that type.` });
  }
  const { rows: [c] } = await db.raw(`SELECT count(*)::int AS total, count(*) FILTER (WHERE lower(coalesce(data->>'equipment_type','')) = ANY($1::text[]))::int AS n ${UNIT_BASE}`, [types]);
  const { rows: ids } = c.n > 0 ? await db.raw(`SELECT id ${UNIT_BASE} AND lower(coalesce(data->>'equipment_type','')) = ANY($1::text[]) ORDER BY id LIMIT 200`, [types]) : { rows: [] };
  return attachCitations(
    answerEnvelope({ text: `${c.n} of ${c.total} units are ${label} (by the equipment type on each unit record).`, facts: [{ label: `Units ${label}`, value: String(c.n), entityIds: ids.slice(0, 20).map((u) => u.id), sources: [] }], extra: { fastIntent: "vocab_equipment_type_count" } }),
    { records: await customerRecordsFor(db, ids.map((u) => u.id)), total: c.n, claimedCount: c.n, basis: `Read the equipment type on each of the ${c.total} units.` });
}

const likeEsc = (v) => `%${String(v).replace(/[\\%_]/g, " ").trim()}%`;

/** R39: the zero / "none on file" answers, each re-verified against the rows themselves. Returns null (decline) the moment the data contradicts the
 *  "never heard of it" reading, so a vocabulary that was stale or a name hiding in another field can never produce a confident wrong zero. */
async function runMissingName(db, intent) {
  const v = intent.value;
  const pat = likeEsc(v);
  const zero = (text, label, basis, fastIntent) => attachCitations(
    answerEnvelope({ text, facts: [{ label, value: "0", entityIds: [], sources: [] }], extra: { fastIntent } }),
    { records: [], total: 0, claimedCount: 0, basis });
  if (intent.kind === "brand") {
    const { rows: [c] } = await db.raw(`SELECT count(*)::int AS total, count(*) FILTER (WHERE data::text ILIKE $1)::int AS seen FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT_SQL}`, [pat]);
    if (!c || c.seen > 0 || c.total === 0) return null;
    const text = intent.customers
      ? `0 customers have ${v} equipment (by the manufacturer on each unit record). I don't see ${v} on any unit record.`
      : `0 of ${c.total} units are ${v} (by the manufacturer on each unit record). I don't see ${v} on any unit record.`;
    return zero(text, intent.customers ? `Customers with ${v}` : `Units ${v}`, `Read the manufacturer, model and type on each of the ${c.total} units; none mentions ${v}.`, "vocab_brand_count");
  }
  if (intent.kind === "city") {
    const { rows: [c] } = await db.raw(`SELECT count(*)::int AS total, count(*) FILTER (WHERE data->>'service_address' ILIKE $1)::int AS seen FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL}`, [pat]);
    if (!c || c.seen > 0 || c.total === 0) return null;
    if (intent.units) {
      const { rows: [u] } = await db.raw(`SELECT count(*)::int AS total, count(*) FILTER (WHERE data->>'service_address' ILIKE $1)::int AS seen FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT_SQL}`, [pat]);
      if (!u || u.seen > 0 || u.total === 0) return null;
      return zero(`0 of ${u.total} units are in ${v} (by the service address on file). I don't see ${v} on any customer or unit address.`, `Units in ${v}`, `Read the service address on each of the ${c.total} customers and ${u.total} units; none is in ${v}.`, "vocab_city_count");
    }
    return zero(`0 of ${c.total} customers are in ${v} (by the service address on file). I don't see ${v} on any customer's address.`, `Customers in ${v}`, `Read the service address city on each of the ${c.total} customers; none is in ${v}.`, "vocab_city_count");
  }
  if (intent.kind === "cname" && intent.missing === false) {
    const w = norm(v).trim();
    const { rows: [c] } = await db.raw(`SELECT count(*)::int AS total, count(*) FILTER (WHERE regexp_split_to_array(lower(data->>'customer_name'), '[^[:alnum:]]+') @> ARRAY[$1::text])::int AS n FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL}`, [w]);
    const { rows: hit } = await db.raw(`SELECT id FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL} AND regexp_split_to_array(lower(data->>'customer_name'), '[^[:alnum:]]+') @> ARRAY[$1::text] LIMIT 200`, [w]);
    if (!c || !c.total) return null;
    return attachCitations(
      answerEnvelope({ text: `${c.n} of ${c.total} customers have ${v} in their name.`, facts: [{ label: `Customers named ${v}`, value: String(c.n), entityIds: hit.slice(0, 20).map((r) => r.id), sources: [] }], extra: { fastIntent: "vocab_name_count" } }),
      { records: await customerRecordsFor(db, hit.map((r) => r.id)), total: c.n, claimedCount: c.n, basis: `Read the name on each of the ${c.total} customers.` });
  }
  if (intent.kind === "cname") {
    const { rows: [c] } = await db.raw(`SELECT count(*)::int AS total, count(*) FILTER (WHERE data->>'customer_name' ILIKE $1)::int AS seen FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL}`, [pat]);
    if (!c || c.seen > 0 || c.total === 0) return null;
    return zero(`0 of ${c.total} customers are named ${v}. I don't see ${v} in any customer name on file.`, `Customers named ${v}`, `Read the name on each of the ${c.total} customers; none contains ${v}.`, "vocab_name_count");
  }
  if (intent.kind === "person") {
    const toks = v.toLowerCase().split(/\s+/).filter(Boolean);
    const { rows: [t] } = await db.raw(`SELECT count(*)::int AS seen FROM extractions x WHERE x.field_key = 'technician' AND x.${TENANT_SQL} AND ${toks.map((_, i) => `lower(COALESCE(NULLIF(x.corrected_value, ''), x.value)) LIKE $${i + 1}`).join(" AND ")}`, toks.map((w) => likeEsc(w)));
    const { rows: [c] } = await db.raw(`SELECT count(*)::int AS total, count(*) FILTER (WHERE ${toks.map((_, i) => `lower(data->>'customer_name') LIKE $${i + 1}`).join(" AND ")})::int AS seen FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL}`, toks.map((w) => likeEsc(w)));
    if (!t || !c || t.seen > 0 || c.seen > 0) return null;
    const noun = intent.noun === "invoice" ? "invoices" : "jobs";
    return zero(`0 ${noun} list ${v} as the technician. I don't see ${v} as a technician or as a customer on file.`, `${intent.noun === "invoice" ? "Invoices" : "Jobs"} by ${v}`, `Read the technician on every record that names one; none is ${v}.`, "vocab_tech_invoice_count");
  }
  return null;
}

export async function runVocabCount(db, intent) {
  if (!intent || typeof intent !== "object") return null;
  const out = await runVocabCountInner(db, intent);
  // "do we have any ..." is a yes/no question: lead with Yes / No and keep the count behind it.
  if (out && intent.existence && typeof out.text === "string" && !/^(?:yes|no)\b/i.test(out.text)) {
    const n = Number(out.facts?.[0]?.value ?? 0);
    out.text = `${n > 0 ? "Yes" : "No"}, ${out.text.charAt(0).toLowerCase()}${out.text.slice(1)}`.replace(/^((?:Yes|No), )(\d)/, "$1$2");
  }
  return out;
}

/** At most this many distinct groups are read to count in memory; a bigger answer set is declined rather than guessed. */
const GROUP_LIMIT = 20000;
const UNIT_BASE = `FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT_SQL}`;

async function runVocabCountInner(db, intent) {
  if (intent.missing || intent.kind === "cname") return runMissingName(db, intent);
  if (intent.kind === "etype") return runEquipmentTypeCount(db, intent);
  if (intent.kind === "brand") {
    // exact counts by SQL aggregation: the groups (manufacturer x equipment type) are tiny, never one row per unit
    const { rows: groups } = await db.raw(`SELECT lower(coalesce(data->>'manufacturer','')) AS mfr, lower(coalesce(data->>'equipment_type','')) AS etype, count(*)::int AS n ${UNIT_BASE} GROUP BY 1, 2 LIMIT ${GROUP_LIMIT + 1}`, []);
    if (groups.length > GROUP_LIMIT) return null;
    const total = groups.reduce((a, g) => a + g.n, 0);
    const want = norm(intent.value).trim();
    const typeSet = intent.types ? new Set(intent.types.map((t) => String(t).toLowerCase())) : null;
    const hitGroups = groups.filter((g) => norm(g.mfr).trim() === want && (!typeSet || typeSet.has(g.etype)));
    const hitCount = hitGroups.reduce((a, g) => a + g.n, 0);
    const mfrs = [...new Set(hitGroups.map((g) => g.mfr))], etypes = [...new Set(hitGroups.map((g) => g.etype))];
    const hitWhere = `lower(coalesce(data->>'manufacturer','')) = ANY($1::text[]) AND lower(coalesce(data->>'equipment_type','')) = ANY($2::text[])`;
    let n = hitCount, ids = [];
    if (hitCount > 0) {
      ({ rows: ids } = await db.raw(`SELECT id ${UNIT_BASE} AND ${hitWhere} ORDER BY id LIMIT 200`, [mfrs, etypes]));
      if (intent.customers) ({ rows: [{ n }] } = await db.raw(`SELECT count(DISTINCT customer_id)::int AS n ${UNIT_BASE} AND ${hitWhere}`, [mfrs, etypes]));
    }
    const kindText = typeSet ? ` ${typeLabels(intent.types)}` : "";
    const how = `by the manufacturer${typeSet ? " and equipment type" : ""} on each unit record`;
    const text = intent.customers ? `${n} customer${n === 1 ? "" : "s"} ha${n === 1 ? "s" : "ve"} ${intent.value}${kindText} equipment (${how}).` : `${hitCount} of ${total} units are ${intent.value}${kindText} (${how}).`;
    return attachCitations(
      answerEnvelope({ text, facts: [{ label: intent.customers ? `Customers with ${intent.value}` : `Units ${intent.value}`, value: String(n), entityIds: ids.slice(0, 20).map((u) => u.id), sources: [] }], extra: { fastIntent: "vocab_brand_count" } }),
      { records: await customerRecordsFor(db, ids.map((u) => u.id)), total: hitCount, claimedCount: n, basis: `Read the manufacturer on each of the ${total} units.` });
  }
  if (intent.kind === "city") {
    const { rows: groups } = await db.raw(`SELECT data->>'service_address' AS addr, count(*)::int AS n FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL} GROUP BY 1 LIMIT ${GROUP_LIMIT + 1}`, []);
    if (groups.length > GROUP_LIMIT) return null;
    const total = groups.reduce((a, g) => a + g.n, 0);
    const want = norm(intent.value).trim();
    const hitAddrs = groups.filter((g) => norm(deriveGeo(g.addr ?? "").city).trim() === want);
    const hitCount = hitAddrs.reduce((a, g) => a + g.n, 0);
    let ids = [];
    if (hitCount > 0) ({ rows: ids } = await db.raw(`SELECT id FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL} AND data->>'service_address' = ANY($1::text[]) ORDER BY id LIMIT 200`, [hitAddrs.map((g) => g.addr ?? "")]));
    return attachCitations(
      answerEnvelope({ text: `${hitCount} of ${total} customers are in ${intent.value} (by the service address on file).`, facts: [{ label: `Customers in ${intent.value}`, value: String(hitCount), entityIds: ids.slice(0, 20).map((u) => u.id), sources: [] }], extra: { fastIntent: "vocab_city_count" } }),
      { records: await customerRecordsFor(db, ids.map((u) => u.id)), total: hitCount, claimedCount: hitCount, basis: `Read the service address city on each of the ${total} customers.` });
  }
  const { rows: [t] } = await db.raw(
    `SELECT count(DISTINCT x.document_id)::int AS n FROM extractions x JOIN documents d ON d.id = x.document_id AND d.${TENANT_SQL}
      WHERE x.field_key = 'technician' AND lower(COALESCE(NULLIF(x.corrected_value, ''), x.value)) = lower($1) AND x.${TENANT_SQL} AND lower(replace(d.document_type, '_', '-')) = 'invoice'`, [intent.value]);
  const { rows: docs } = t.n > 0 ? await db.raw(
    `SELECT DISTINCT x.document_id FROM extractions x JOIN documents d ON d.id = x.document_id AND d.${TENANT_SQL}
      WHERE x.field_key = 'technician' AND lower(COALESCE(NULLIF(x.corrected_value, ''), x.value)) = lower($1) AND x.${TENANT_SQL} AND lower(replace(d.document_type, '_', '-')) = 'invoice' LIMIT 200`, [intent.value]) : { rows: [] };
  return attachCitations(
    answerEnvelope({ text: `${t.n} invoice${t.n === 1 ? "" : "s"} list ${intent.value} as the technician.`, facts: [{ label: `Invoices by ${intent.value}`, value: String(t.n), entityIds: [], sources: [] }], extra: { fastIntent: "vocab_tech_invoice_count" } }),
    { records: await customerRecordsFor(db, await linkedEntityIds(db, docs.map((r) => r.document_id))), total: t.n, claimedCount: t.n, basis: `Counted invoice documents whose technician is ${intent.value}.` });
}

