/**
 * R32b (loop A) — the UNKNOWN-NAME gate: a record question about a person/business whose name exists NOWHERE in the tenant (no customer or
 * other entity, no page text, and no close spelling of any customer name) is an honest "not on file", answered without a model.
 *
 *   extractNamePhrase(question)                       pure: the name a record question is about, or null
 *   buildUnknownNameDecline(db, question, ctx)        db: the decline answer, or null (name exists / not a name question / unsure)
 *
 * Why this is safe: it only declines when (a) the question has a record cue (phone, email, serial, warranty, last serviced, invoices, ...) and
 * matches one of the closed name shapes below, (b) the captured name has at least one token that is not a real word / vocabulary word, (c) every
 * such token is absent from entities AND the full text of every document page (full-text index), and (d) no customer-name word is within 2 edits
 * of it (a typo of a real customer keeps the existing Did-you-mean / auto-resolve path). Anything else returns null and behaves as before.
 * Kill switch: DONOVAN_UNKNOWN_NAME_DECLINE=0.
 */
import { denyOr } from "./nameMatch.js";
import { attachCitations } from "../citations/records.js";
import { stripConversationalFrame } from "../router/frame.js";
import { isNonNameWord } from "./commonWords.js";
import { damerauLevenshteinDistance } from "../integrity.js";
import { isNicknamePair, formalsOf } from "../vocab/nicknames.js";
import { buildNoAnchorDecline } from "./tenantWord.js";

export const unknownNameEnabled = () => process.env.DONOVAN_UNKNOWN_NAME_DECLINE !== "0";

const TENANT_SQL = "tenant_id = (current_setting('app.tenant_id', true))::uuid";
const NAME = String.raw`([A-Za-z][A-Za-z'’-]{2,}(?:\s+[A-Za-z][A-Za-z'’-]{2,}){0,2})`;
const FIELD = String.raw`(?:phone(?:\s+number)?|number|e-?mail(?:\s+address)?|address|file|account|invoices?|history|records?|paperwork|quotes?|estimates?|documents?|notes?|contact(?:\s+info)?|info(?:rmation)?)`;
const UNITF = String.raw`(?:serial(?:\s+(?:number|#))?|s/n|model(?:\s+(?:number|#))?|brand|make|manufacturer|tonnage|size|warranty(?:\s+status)?|coverage|install(?:ation)?\s+date|age|refrigerant|seer(?:\s+rating)?|filter(?:\s+size)?)`;
const POSS = String.raw`(?:['’]s?)?`;
const TAIL = String.raw`(?:\s+(?:unit|units|system|systems|furnace|ac|a/c|equipment|account|file|place|house|site|job|jobs))?`;
const SHAPES = [
  new RegExp(String.raw`\b${FIELD}\s+(?:on\s+file\s+)?(?:for|on|about|of)\s+(?:the\s+)?${NAME}${POSS}${TAIL}\s*$`, "i"),
  new RegExp(String.raw`^(?:pull\s+up|look\s+up|open|show\s+me|find|get\s+me|bring\s+up)\s+(?:the\s+)?(?:file\s+(?:on|for)\s+)?${NAME}${POSS}${TAIL}\s*$`, "i"),
  new RegExp(String.raw`\bwhat\s+(?:do\s+we|have\s+we|do\s+you)\s+(?:have|got)\s+(?:on\s+file\s+)?(?:for|on)\s+${NAME}\s*$`, "i"),
  new RegExp(String.raw`\b${UNITF}\s+(?:on|for|of|at)\s+(?:the\s+)?${NAME}${POSS}${TAIL}\s*$`, "i"),
  new RegExp(String.raw`\bwhat\s+(?:brand|make|model|size|tonnage)\s+(?:is|are)\s+(?:the\s+)?${NAME}${POSS}\s+(?:unit|system|furnace|ac|a/c|equipment)\s*$`, "i"),
  new RegExp(String.raw`\b(?:is|does)\s+(?:the\s+)?${NAME}${POSS}\s+(?:unit|system|furnace|ac|a/c|equipment)\s+(?:still\s+)?(?:under\s+warranty|covered|have\s+a\s+warranty)\s*$`, "i"),
  new RegExp(String.raw`\bwhen\s+(?:was|did\s+we\s+last\s+(?:service|visit|see|go\s+(?:to|out\s+to)))\s+(?:the\s+)?${NAME}${POSS}(?:\s+last\s+(?:serviced|visited))?\s*$`, "i"),
  new RegExp(String.raw`\b(?:last\s+(?:service|visit)|who\s+(?:was\s+)?(?:the\s+)?last\s+tech(?:nician)?)\s+(?:at|for|to\s+visit|to\s+service)\s+(?:the\s+)?${NAME}${POSS}\s*$`, "i"),
  new RegExp(String.raw`\b(?:last\s+time\s+we\s+(?:serviced|visited|saw|went\s+(?:to|out\s+to))|where\s+does)\s+(?:the\s+)?${NAME}(?:\s+live)?\s*$`, "i"),
  new RegExp(String.raw`\bwhat\s+(?:brand|make|model|size|tonnage|kind\s+of\s+(?:unit|system|furnace|ac))\s+(?:does|do)\s+(?:the\s+)?${NAME}\s+(?:have|use|own|run|got)\s*$`, "i"),
  new RegExp(String.raw`^${NAME}['’]s\s+(?:unit|system|account|phone(?:\s+number)?|e-?mail|address|warranty|serial|model|furnace|file)\s*$`, "i"),
  // R35 loop 3: "who is X" / "tell me about X" / "is X a customer" (still only declined when X is nowhere in the records; see WHO_SHAPES)
  new RegExp(String.raw`^(?:who\s+is|who['’]s|whos|who\s+was)\s+${NAME}\s*$`, "i"),
  new RegExp(String.raw`^(?:tell\s+me\s+about|anything\s+on|any\s+info\s+on|info\s+on|what\s+about)\s+${NAME}\s*$`, "i"),
  new RegExp(String.raw`^(?:is|was)\s+${NAME}\s+(?:a|one\s+of\s+our|our)\s+(?:customer|client|tech|technician|vendor)s?\s*$`, "i"),
];
/** R3 not-on-file: more record-question shapes for a name that exists nowhere (possessive "what is X's phone", "X phone", "how many jobs for X",
 *  "details on X", "customer X", "owed by X", "when did X last have service"). Same gate as above (name must be absent everywhere). Kill switch DONOVAN_NOTONFILE=0. */
const NF_FIELD = String.raw`(?:phone(?:\s+number)?|number|cell|e-?mail(?:\s+address)?|address|contact(?:\s+info)?|account|file|history|invoices?|balance)`;
const NF_SHAPES = [
  new RegExp(String.raw`^(?:what(?:['’]s|\s+is|\s+was)\s+)?(?:the\s+)?${NAME}['’]s?\s+${NF_FIELD}\s*$`, "i"),
  new RegExp(String.raw`^${NAME}\s+${NF_FIELD}\s*$`, "i"),
  new RegExp(String.raw`^(?:how\s+many\s+(?:jobs|visits|invoices|documents|units)|(?:details|info|information|history|records?)|total\s+(?:owed|due))\s+(?:for|on|about|from|by|of)\s+(?:the\s+)?${NAME}\s*$`, "i"),
  new RegExp(String.raw`^(?:customer|client)\s+${NAME}\s*$`, "i"),
  new RegExp(String.raw`^when\s+did\s+${NAME}\s+last\s+(?:have|get|had)\s+(?:a\s+)?(?:service|serviced|visit|job)\s*$`, "i"),
];
const NF_BAD = /^(?:the|our|my|your|how|what|who|when|where|why|list|show|all|any|every|each|total|customer|customers|client|clients|tech|techs|technician|technicians|unit|units|invoice|invoices|serial|phone|email|address)\b/i;
const nfEnabled = () => process.env.DONOVAN_NOTONFILE !== "0";

/** R35: the bare "who is X" shapes (the last three above) only take a phrase that reads as a person's name, never a role or a ranking
 *  ("whos our busiest technician", "who is the owner", "who is our best customer" go on to their own routes). */
const WHO_SHAPES = new Set(SHAPES.slice(-3));
const NOT_A_PERSON_RE = /\b(?:our|the|my|your|their|this|that|best|worst|busiest|top|most|least|newest|oldest|last|first|next|new|biggest|largest|main|lead|head|tech|techs|technician|technicians|customer|customers|client|clients|guy|owner|manager|boss|vendor|vendors|supplier|dispatcher|office|admin|installer|crew|team|everyone|anyone|somebody|someone|nobody|busiest|biggest|largest|highest|lowest|latest|earliest|fastest|slowest|cheapest|newest|oldest)\b/i;
const TAIL_WORDS = new Set(["unit", "units", "system", "systems", "furnace", "ac", "equipment", "account", "file", "place", "house", "site", "job", "jobs"]);
const FILLER_TAIL = /\s+(?:for\s+me|please|pls|thanks|thx|real\s+quick|when\s+you\s+get\s+a\s+sec|asap|right\s+now|again|today|now)\s*[?.!]*$/i;
const CUE_WORDS = ["serial", "number", "model", "brand", "tonnage", "warranty", "address", "phone", "email", "invoices", "invoice", "serviced", "service", "visit", "technician", "account", "refrigerant", "install", "installation", "manufacturer", "coverage", "contact", "paperwork", "history", "records", "estimate", "estimates", "quote", "quotes", "system", "furnace", "equipment", "customer", "unit", "documents", "when", "last", "what", "whats", "pull", "show", "file", "does", "under", "still", "covered", "have"];
const CUE_SET = new Set(CUE_WORDS);
/** "seriel numbr on the smith unit" -> "serial number on the smith unit": one-edit repairs of record cue words only (never of the name). */
function repairCueTypos(q) {
  return q.replace(/#/g, " number ").replace(/\s+/g, " ").split(" ").map((w) => {
    const lw = w.toLowerCase().replace(/[^a-z]/g, "");
    if (lw.length < 5 || CUE_SET.has(lw)) return w;
    const hit = CUE_WORDS.find((c) => c.length >= 5 && Math.abs(c.length - lw.length) <= 1 && damerauLevenshteinDistance(lw, c) === 1);
    return hit ? w.replace(/[A-Za-z]+/, hit) : w;
  }).join(" ");
}
const STOP = new Set(["the", "a", "an", "my", "our", "this", "that", "his", "her", "their", "customer", "client", "account"]);

/** The name phrase the record question is about (shape-gated), or null. Pure. */
export function extractNamePhrase(question) {
  let q = String(question ?? "").trim();
  if (!q || q.length > 160) return null;
  q = repairCueTypos(String(stripConversationalFrame(q) ?? q).trim().replace(/[?!.]+$/, "").replace(FILLER_TAIL, "").replace(FILLER_TAIL, "").trim());
  for (const re of SHAPES) {
    const m = re.exec(q);
    if (!m) continue;
    if (WHO_SHAPES.has(re) && NOT_A_PERSON_RE.test(m[1])) continue;
    const tokens = m[1].split(/\s+/).map((t) => t.replace(/['’]s?$/i, "")).filter((t) => t && !STOP.has(t.toLowerCase()) && !TAIL_WORDS.has(t.toLowerCase()));
    if (!tokens.length || tokens.length > 3) continue;
    return tokens.join(" ");
  }
  if (nfEnabled()) for (const re of NF_SHAPES) {
    const m = re.exec(q);
    if (!m || NF_BAD.test(m[1].trim())) continue;
    const parts = m[1].trim().split(/\s+/);
    if (parts.length < 2 || parts.length > 3 || !parts.every((t) => /^[A-Z][A-Za-z'’-]+$/.test(t))) continue; // capitalised full name only
    return parts.map((t) => t.replace(/['’]s?$/i, "")).join(" ");
  }
  return null;
}

/** Tokens that make a phrase "an unknown name": not a real non-name word, 4+ letters. */
// A hyphenated name ("Abernethy-Cole") stays ONE token (its halves are not names on their own: "abernethy" is one edit from the real "Abernathy").
const candidateTokens = (phrase) => String(phrase).toLowerCase().split(/\s+/).map((t) => t.replace(/[^a-z-]/g, "").replace(/^-+|-+$/g, "")).filter((t) => t.length >= 4 && !isNonNameWord(t));

async function tokenExists(db, token) {
  const like = `%${token}%`;
  const ent = await db.raw(`SELECT 1 FROM entities WHERE ${TENANT_SQL} AND data::text ILIKE $1 LIMIT 1`, [like]);
  if (ent.rows.length) return true;
  await db.raw("SAVEPOINT unknown_name_scan", []);
  try {
    const r = await db.raw(`SELECT 1 FROM document_pages WHERE ${TENANT_SQL} AND tsv @@ plainto_tsquery('english', $1) LIMIT 1`, [token]);
    await db.raw("RELEASE SAVEPOINT unknown_name_scan", []);
    if (r.rows.length) return true;
    // the index stems and splits words; a stem miss can still be a literal substring hit (possessives, hyphenated names): confirm cheaply
    return false;
  } catch {
    await db.raw("ROLLBACK TO SAVEPOINT unknown_name_scan", []).catch(() => {});
    const r = await db.raw(`SELECT 1 FROM document_pages WHERE ${TENANT_SQL} AND text ILIKE $1 LIMIT 1`, [like]);
    return r.rows.length > 0;
  }
}

export function buildUnknownNameAnswer(phrase) {
  return attachCitations(
    {
      kind: "no-answer",
      text: `I don't have anyone named "${phrase}" on file or in any document — nothing to look up.`, // R35 brevity
      facts: [], sources: [], confidence: 0, verifiedCount: 0, unverifiedCount: 0, closest: [],
    },
    { records: [], total: 0, kind: "searched", basis: `Searched every customer and entity record and the full text of every document page for "${phrase}"; nothing matches.` }
  );
}

/**
 * R35: a contact-detail question (phone / email / address) about one of the shop's own TECHNICIANS ("phone for Danny Ochoa", "address for
 * Raymond Sutton", "phone for Dan Ochoa") — the records carry customers' contact details, never a technician's. Honest decline at $0; the
 * name only has to be the technician's (same surname, same or nickname-related first name). Never fires when a customer has that name.
 */
const CONTACT_FIELD_RE = /\b(?:phone|number|cell|e-?mail|address|contact|reach)\b/i;
const related = (a, b) => a === b || isNicknamePair(a, b) || formalsOf(a).some((f) => f === b || isNicknamePair(f, b) || formalsOf(b).includes(f));
async function technicianContactDecline(db, question, phrase) {
  if (!CONTACT_FIELD_RE.test(question)) return null;
  const toks = phrase.toLowerCase().split(/\s+/);
  if (toks.length !== 2) return null;
  // a customer the typed name can mean (same surname, same or nickname-related first name) keeps the customer paths
  const { rows: cust } = await db.raw(`SELECT data->>'customer_name' AS n FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL} AND lower(data->>'customer_name') LIKE $1 LIMIT 50`, [`% ${toks[1]}`]);
  if (cust.some((c) => { const t = String(c.n ?? "").toLowerCase().split(/\s+/); return t.length === 2 && t[1] === toks[1] && related(toks[0], t[0]); })) return null;
  const { rows } = await db.raw(
    `SELECT DISTINCT COALESCE(NULLIF(corrected_value, ''), value) AS name FROM extractions
      WHERE field_key = 'technician' AND ${TENANT_SQL} AND lower(COALESCE(NULLIF(corrected_value, ''), value)) LIKE $1 LIMIT 20`,
    [`% ${toks[1]}`]
  );
  const hits = rows.map((r) => String(r.name ?? "").trim()).filter((n) => { const t = n.toLowerCase().split(/\s+/); return t.length === 2 && t[1] === toks[1] && related(toks[0], t[0]); });
  const uniq = [...new Set(hits)];
  if (uniq.length !== 1) return null;
  return attachCitations(
    { kind: "no-answer", text: `${uniq[0]} is one of your technicians — no technician contact details are on file.`, facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [] },
    { records: [], total: 0, kind: "searched", basis: `Matched "${phrase}" to the technician ${uniq[0]} named on your documents; customer records carry contact details, technician records do not.` }
  );
}

/**
 * R45: the honest decline for a question this tenant's records cannot be about. First the specific "unknown name" shapes below; then the GENERAL
 * rule (lookups/tenantWord.js): no tenant entity, no tenant-vocabulary word and not a help question. Same hook point, still before any model.
 * @returns the honest decline, or null when anything exists / is unsure.
 */
export async function buildUnknownNameDecline(db, question) {
  return (await declineUnknownName(db, question)) ?? (await buildNoAnchorDecline(db, question));
}

/** @returns the honest decline, or null when the name exists / is not an unknown-name question / anything is unsure. */
async function declineUnknownName(db, question) {
  if (!unknownNameEnabled()) return null;
  const phrase = extractNamePhrase(question);
  if (!phrase) return null;
  const tech = await technicianContactDecline(db, question, phrase);
  if (tech) return tech;
  const tokens = candidateTokens(phrase);
  if (!tokens.length) return null;
  const { rows: custs } = await db.raw(`SELECT data->>'customer_name' AS n FROM entities WHERE entity_type = 'customer' AND ${TENANT_SQL}`, []);
  const words = new Set();
  for (const r of custs) for (const w of String(r.n ?? "").toLowerCase().split(/\s+/)) if (w.length >= 3) { const c = w.replace(/[^a-z-]/g, ""); words.add(c); for (const part of c.split("-")) if (part.length >= 3) words.add(part); }
  for (const t of tokens) for (const w of words) if (damerauLevenshteinDistance(t, w) <= 2) return null; // a typo of a real name: the near-miss paths own it
  for (const t of tokens) if (await tokenExists(db, t)) return null;
  return denyOr(db, phrase, buildUnknownNameAnswer(phrase)); // R3 denial rule: never denied when any customer/vendor shares a name word
}
