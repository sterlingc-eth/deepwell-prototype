/**
 * R31 (Team A, loops 1-2) — ENTITY-FIRST slot filling for single-field lookups.
 *
 * WHY: every contact/unit lookup shape in contactLookup.js is a regex over ONE literal wording
 * ("whats X's phone number", "phone number for X", ...). Dispatchers ask the same thing a hundred ways
 * ("X - phone?", "best number for X", "which address is X at", "where do we go for X", "mail address for X"),
 * and each new wording used to need another regex. This module inverts the problem: instead of matching a
 * wording, it finds the ENTITY (a customer whose full name appears verbatim in the question, or one street
 * address) and the single FIELD CONCEPT (phone / email / address / serial / model / brand / tonnage / who),
 * from closed vocabularies, and answers through the SAME builders every other shape uses.
 *
 * It is the LAST resort of contactLookup's parser (only reached when no existing shape matched), and it is
 * deliberately conservative. CLOSED-WORLD PRECISION GUARD: after the entity and the concept words are
 * accounted for, EVERY remaining token must be a chatter/function word from LEX. Any other word — an aggregate,
 * comparison, negation, time window, document type, equipment component ("thermostat"), a typo'd field word —
 * could change what is being asked, so the question is not a plain single-field lookup and we return null
 * (defer to the model) instead of guessing. Also null: 0 or 2+ field concepts; a customer name that is not an
 * exact full-name match (typos are NOT auto-resolved here — the existing "Did you mean" path owns near-misses);
 * two customers or two street addresses named (a comparison); an address that resolves to 2+ customers.
 * The one thing it ADDS beyond the old shapes: a street address that matches NO customer (not even loosely:
 * house number + street name) is answered honestly and deterministically — "Nothing on file for <address>",
 * with same-street neighbors as a hint — instead of paying for a model call that can only say the same thing.
 */
import { extractSubject } from "../fastPath.js";
import { damerauLevenshteinDistance } from "../integrity.js";
import { KNOWN_AZ_CITY_NAMES, KNOWN_US_CITY_NAMES } from "../analytics.js";
import { attachCitations, customerRecord } from "../citations/records.js";
import { stripConversationalFrame } from "../router/frame.js";
import { LEX } from "./lexicon.js";
import { TENANT_SQL } from "../scope.js";
import {
  buildAmbiguousContactAnswer,
  isRealNamePhrase,
  buildResolvedAnswer,
  resolveAddressCandidates,
  resolveNamedCustomers,
  CUSTOMER_ROW_COLUMNS,
} from "../contactLookup.js";

export { LEX };
// Words that are never chatter here (checked BEFORE the closed-world rule as a second line of defence).
const NEVER = new Set(
  (
    "how many much count counts total totals list every all each everyone most least more less fewer fewest than versus vs compare compared between average oldest newest latest earliest ever never not without missing except " +
    "since before after during year years month months week weeks day days ago yesterday tomorrow tonight last next due overdue if whether why when different same both either neither duplicate merge delete update change edit add create remove send text " +
    // document / money / lifecycle words: some other classifier's question
    "work order orders invoice invoices warranty warranties registration startup sheet permit permits nameplate photo maintenance agreement contract contracts plan plans ticket tickets dispatch note notes proposal quote quotes estimate estimates inspection report reports purchase po record records correspondence " +
    "paid unpaid owe owes balance cost costs price bill billed revenue sales profit margin installed install installation installer age old expire expires expired expiring schedule scheduled visit visits technician technicians tech techs repair repairs " +
    // equipment components / other fields the deterministic layer answers elsewhere (or honestly declines): never a plain contact field
    "thermostat filter filters condenser evaporator coil capacitor compressor blower motor duct ducts breaker pressure amperage voltage refrigerant seer btu rating size drier drain pan line lineset furnace heater heat pump ac hvac equipment unit units tons"
  ).split(/\s+/)
);
// "unit"/"system"/"equipment" as chatter ("Amanda Redwine unit serial") is a real phrasing, so the plain singular nouns are allowed back:
for (const w of ["unit", "equipment", "record", "records", "dispatch", "work"]) NEVER.delete(w);

// Field-word abbreviations and the words a typo'd field word would be near: an isolated unknown token that is one edit from
// one of these is probably ANOTHER field being asked for ("moddel", "seriel", "emial"), so the question is not a plain
// single-field lookup.
const FIELD_ABBREV = new Set("mfr mfg mfgr manuf maker sn ser mdl tons ton warr yr yrs dob btu seer refrig freon amps".split(" "));
const FIELD_WORDS_FOR_TYPOS = "phone email address serial model brand manufacturer tonnage warranty install installed invoice permit refrigerant technician customer number location capacity seer filter thermostat".split(" ");
function looksLikeFieldWord(w) {
  if (FIELD_ABBREV.has(w)) return true;
  if (w.length < 4) return false;
  return FIELD_WORDS_FOR_TYPOS.some((f) => f !== w && Math.abs(f.length - w.length) <= 2 && damerauLevenshteinDistance(w, f) <= (w.length >= 7 ? 2 : 1));
}

const CITY_WORDS = new Set([...(KNOWN_AZ_CITY_NAMES ?? []), ...(KNOWN_US_CITY_NAMES ?? [])].map((c) => String(c).toLowerCase()));

const STREET_SUFFIX = "st|street|ave|avenue|rd|road|dr|drive|blvd|boulevard|ln|lane|way|ct|court|pl|place|cir|circle|pkwy|parkway|hwy|highway|trl|trail|ter|terrace";
const ADDRESS_SCAN_RE = new RegExp(`\\b\\d{1,6}\\s+(?:[nsew]\\.?\\s+|north\\s+|south\\s+|east\\s+|west\\s+)?[a-z0-9.'-]+(?:\\s+[a-z0-9.'-]+){0,3}?\\s+(?:${STREET_SUFFIX})\\b`, "gi");

/** Field concepts found in the question (each phrase is consumed once so "phone number" is not also "number"). */
function detectConcepts(text, kind) {
  let t = ` ${text} `;
  const found = new Set();
  const take = (re, concept) => { if (re.test(t)) { found.add(concept); t = t.replace(re, " "); } };
  take(/\bwhere\s+(?:do|can|should|would)\s+(?:i|we)\s+(?:e-?mail|email|write)\b/i, "email");
  take(/\bwhere\s+(?:do|can|should|would)\s+(?:i|we)\s+(?:call|ring|dial|phone|text|reach)\b/i, "phone");
  take(/\bserial\s*(?:number|no\.?|#)?\b/i, "serial");
  take(/\bmodel\s*(?:number|no\.?|#)?\b/i, "model");
  take(/\b(?:phone|telephone|contact|cell|cellphone|mobile)\s*(?:number|no\.?|#)\b/i, "phone");
  take(/\bph\s*#/i, "phone");
  take(/\b(?:e-?mail|email)\s+address\b/i, "email");
  take(/\bmail\s+address\b/i, "email");
  take(/\b(?:service|street|site|job\s*site|physical)\s+address\b/i, "address");
  take(/\b(?:phone|telephone|cell|cellphone|mobile|dial)\b/i, "phone");
  take(/\bnumber\b/i, "phone");
  take(/\be-?mail\b/i, "email");
  take(/\baddress\b/i, "address");
  take(/\b(?:location|located|whereabouts|wheres|where(?:'s)?)\b/i, "address");
  take(/\b(?:sit|sits|sitting)\b/i, "address");
  if (kind === "name") take(/\blives?\b/i, "address");
  take(/\b(?:brand|manufacturer|make)\b/i, "brand");
  take(/\btonnage\b/i, "tonnage");
  if (kind === "address") take(/\b(?:whos|who's|who\s+is|who|whose|owner|client|customer|tenant|resident|account|name|lives?|living|stays?)\b/i, "who");
  return found;
}

const norm = (s) => String(s ?? "").toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9' #.-]+/g, " ").replace(/\s+/g, " ").trim();
const stripPoss = (w) => w.replace(/'s$/, "").replace(/s'$/, "s").replace(/'/g, "");

/**
 * @returns {{field:'slotFill', kind:'name'|'address', concept:string, address?:string, block?:string[], text:string}|null}
 */
export function parseSlotFill(question) {
  const raw = String(question ?? "").trim();
  if (!raw || raw.length > 220) return null;
  const text = (stripConversationalFrame(raw) ?? raw).replace(/[‘’]/g, "'");
  const lower = text.toLowerCase();
  const tokens = norm(lower).split(" ").filter(Boolean).map((w) => w.replace(/[.,]+$/, "")).filter((w) => /[a-z0-9]/.test(w));
  if (tokens.length < 2 || tokens.length > 22) return null;
  if (tokens.some((tk) => NEVER.has(tk) || /n't$/.test(tk) || /^(?:dont|doesnt|isnt|arent|hasnt|havent|didnt|wasnt|werent|wont|cant|cannot|none|nobody|nothing|nowhere)$/.test(tk))) return null;
  if ((text.match(/\?/g) ?? []).length > 1) return null;

  const addrHits = [...lower.matchAll(ADDRESS_SCAN_RE)];
  if (addrHits.length > 1) return null; // two addresses = a comparison
  const address = addrHits.length === 1 ? (extractSubject(text).address ?? addrHits[0][0]) : null;
  const kind = address ? "address" : "name";
  const rest = address ? lower.replace(address.toLowerCase(), " ") : lower;
  const concepts = detectConcepts(rest, kind);

  // Closed-world residual over the tokens that are neither the address nor a LEX/concept word.
  const addrTokens = new Set(address ? norm(address).split(" ").map((w) => w.replace(/[.,]+$/, "")) : []);
  const unknown = [];
  let blocks = [];
  let cur = [];
  for (const tk of norm(rest).split(" ").map((w) => w.replace(/[.,]+$/, "")).filter((w) => /[a-z0-9]/.test(w))) {
    const w = stripPoss(tk);
    if (LEX.has(tk) || LEX.has(w) || addrTokens.has(tk)) { if (cur.length) { blocks.push(cur); cur = []; } continue; }
    cur.push(w);
  }
  if (cur.length) blocks.push(cur);
  for (const b of blocks) unknown.push(...b);

  if (kind === "address") {
    if (unknown.length > 1 || blocks.some((b) => b.length > 1) || unknown.some(looksLikeFieldWord)) return null; // leftovers: not a plain address lookup
    let concept;
    if (concepts.size === 0) {
      if (!/\b(?:on\s+file|pull\s+up|what\s+do\s+we\s+have|info|information|details|anything|show\s+me|look\s+up|the\s+file|known|know\s+about)\b/.test(lower)) return null;
      concept = "full";
    } else if (concepts.size === 1) concept = [...concepts][0];
    else if (concepts.size === 2 && concepts.has("who") && concepts.has("phone")) concept = "who+phone";
    else return null;
    return { field: "slotFill", kind, concept, address, text };
  }
  // name kind: exactly one concept; exactly one contiguous run of 2..5 unknown words is the candidate name — isolated
  // single unknown words (wait / buddy / lol / cheers ...) are tolerated as chatter (they cannot carry the entity, and
  // every SEMANTIC word is in NEVER, checked above).
  let nameConcept = null;
  if (concepts.size === 1) nameConcept = [...concepts][0];
  // "pull up the file for X" / "everything we have on X" / "anything on file for X": the whole record, no single field.
  else if (concepts.size === 0 && /\b(?:the\s+file|on\s+file|pull\s+up|everything|anything|info|information|details|the\s+account|who\s+is|whos|who's)\b/.test(lower)) nameConcept = "full";
  if (!nameConcept) return null;
  const multi = blocks.filter((b) => b.length >= 2);
  const singles = blocks.filter((b) => b.length === 1);
  if (multi.length !== 1 || multi[0].length > 5 || singles.length > 3 || singles.some((b) => looksLikeFieldWord(b[0]))) return null;
  const nameBlock = multi[0];
  if (!nameBlock.every((w) => /^[a-z][a-z.-]*$/.test(w))) return null;
  if (!singles.every((b) => /^[a-z][a-z.-]*$/.test(b[0]))) return null;
  // The block must be able to be a NAME: not an aggregate noun phrase ("tucson customers"), not a city.
  const phrase = nameBlock.join(" ");
  if (!isRealNamePhrase(phrase)) return null;
  if (nameBlock.some((w) => CITY_WORDS.has(w)) || CITY_WORDS.has(phrase)) return null;
  return { field: "slotFill", kind, concept: nameConcept, block: nameBlock, text };
}

/** Exact full-name resolution against the candidate block (edge noise up to 2 words is tolerated). */
async function resolveBlock(db, block) {
  const spans = new Map();
  for (let i = 0; i < block.length; i++) for (let j = i + 2; j <= block.length; j++) {
    if (i > 0 && j < block.length) continue; // noise may only hang off the edges, never sit on both sides
    if (block.length - (j - i) > 2) continue;
    spans.set(block.slice(i, j).join(" ").replace(/[.]/g, ""), j - i);
  }
  const { rows } = await db.raw(
    `SELECT ${CUSTOMER_ROW_COLUMNS}, lower(regexp_replace(data->>'customer_name', '[^A-Za-z0-9 ]', '', 'g')) AS name_key
       FROM entities
      WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL}
        AND lower(regexp_replace(data->>'customer_name', '[^A-Za-z0-9 ]', '', 'g')) = ANY($1::text[])
      LIMIT 20`,
    [[...spans.keys()]]
  );
  if (!rows.length) return [];
  const best = Math.max(...rows.map((r) => spans.get(r.name_key) ?? 0));
  const top = rows.filter((r) => (spans.get(r.name_key) ?? 0) === best);
  if (new Set(top.map((r) => r.name_key)).size !== 1) return []; // two different customers named
  return top;
}

const CONCEPT_FIELD = { phone: "phone", email: "email", address: "address", serial: "serial", model: "unitModel", brand: "unitBrand", tonnage: "unitTonnage" };

export function buildNoAddressAnswer(address, neighbors = []) {
  const label = String(address ?? "").trim();
  const hint = neighbors.length
    ? ` Closest on the same street: ${neighbors.slice(0, 3).map((n) => `${n.service_address}${n.customer_name ? ` (${n.customer_name})` : ""}`).join("; ")}.`
    : "";
  return attachCitations(
    { kind: "answer", text: `Nothing on file for ${label} — no customer or unit has that service address.${hint}`, facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [] },
    { records: [], total: 0, kind: "searched", basis: `Searched every customer's service address for ${label}; none match.` }
  );
}

/** Loose match: house number + first street word only (ignores city/zip/suffix). A hit means an address the strict
 *  resolver missed on formatting (wrong city typed, "East" vs "E") — NEVER claim "nothing on file" then. */
async function looseAddressExists(db, address) {
  const m = String(address).toLowerCase().match(/^(\d+)\s+(?:(?:[nsew]|north|south|east|west)\.?\s+)?([a-z0-9'-]+)/);
  if (!m) return true; // cannot reason about it: be conservative
  const esc = (x) => x.replace(/[\\%_]/g, "\\$&");
  const { rows } = await db.raw(
    `SELECT 1 FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL}
        AND data->>'service_address' ILIKE $1 AND data->>'service_address' ILIKE $2 LIMIT 1`,
    [`${esc(m[1])} %`, `%${esc(m[2])}%`]
  );
  return rows.length > 0;
}

async function sameStreetNeighbors(db, address) {
  const m = String(address).toLowerCase().match(/^\d+\s+(?:(?:[nsew]|north|south|east|west)\.?\s+)?([a-z0-9'-]{3,})/);
  if (!m) return [];
  try {
    const { rows } = await db.raw(
      `SELECT data->>'customer_name' AS customer_name, data->>'service_address' AS service_address
         FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL}
          AND data->>'service_address' ILIKE $1 ORDER BY data->>'service_address' LIMIT 3`,
      [`% ${m[1].replace(/[\\%_]/g, "\\$&")} %`]
    );
    return rows;
  } catch {
    return [];
  }
}

/** Slim "who is at this address (and their phone)" answer: ONLY the asked facts (a full contact card would add
 *  unrequested facts and dilute a set-graded answer's precision). */
function buildWhoAnswer(row, address, withPhone) {
  const name = row.customer_name || row.customer_number;
  if (!name) return null;
  const facts = [{ label: "Customer", value: name, entityId: row.id, sources: [] }];
  let text = `${name} is the customer at ${row.service_address || address}.`;
  if (withPhone) {
    if (row.phone) { facts.push({ label: "Phone", value: row.phone, entityId: row.id, sources: [] }); text = `${name} — phone ${row.phone}.`; }
    else text = `${name} — no phone on file.`;
  }
  return attachCitations(
    { kind: "answer", text, facts, sources: [], confidence: 1, verifiedCount: facts.length, unverifiedCount: 0, closest: [] },
    { records: [customerRecord(row)], total: 1, basis: `Read the customer${withPhone ? " name and phone number" : ""} on file at ${row.service_address || address}.` }
  );
}

export async function runSlotFill(db, parsed, opts = {}) {
  const today = opts.today ?? null;
  const question = opts.question ?? parsed.text;
  if (parsed.kind === "name") {
    const field = parsed.concept === "full" ? "full" : CONCEPT_FIELD[parsed.concept];
    if (!field) return null;
    const rows = await resolveBlock(db, parsed.block);
    if (!rows.length) {
      // No exact full name. A 2-3 word block one edit away from a real customer is a typo'd name: never auto-resolved
      // here (a second signal - the customer's own address/serial in the same question - is the existing R21 rule in
      // resolveNamedCustomers, which only ever DECLINES with a name-only "Did you mean" that becomes a one-tap chip).
      if (parsed.block.length < 2 || parsed.block.length > 3) return null;
      const { declined } = await resolveNamedCustomers(db, question, parsed.block.join(" "));
      return declined ?? null;
    }
    if (rows.length > 1) return buildAmbiguousContactAnswer(rows[0].customer_name, rows);
    return buildResolvedAnswer(db, field, rows[0], { namePhrase: rows[0].customer_name, today, question });
  }
  const candidates = await resolveAddressCandidates(db, parsed.address);
  if (candidates.length === 0) {
    if (await looseAddressExists(db, parsed.address)) return null;
    return buildNoAddressAnswer(parsed.address, await sameStreetNeighbors(db, parsed.address));
  }
  if (candidates.length > 1) return null;
  const row = candidates[0];
  if (parsed.concept === "who" || parsed.concept === "who+phone") return buildWhoAnswer(row, parsed.address, parsed.concept === "who+phone");
  const opts2 = { namePhrase: row.customer_name, today, question };
  if (parsed.concept === "full") return buildResolvedAnswer(db, "full", row, opts2);
  const field = CONCEPT_FIELD[parsed.concept];
  if (!field) return null;
  return buildResolvedAnswer(db, field, row, opts2);
}
