/**
 * R40: tenant-catalog deterministic lane for plumbing + property organizations.
 *
 * Every vocabulary here (equipment types, brands, document types, customers) is read from the ASKING organization's own rows at question time -
 * no built-in HVAC/plumbing list stands in for the tenant's data and nothing from another organization is visible (db is tenant-scoped).
 * Shapes: "how many <equipment type>", "who has a <equipment type>", "does <customer> have a tankless", "is <customer>'s heater tankless",
 * "<customer> customer number", "how many <document type>", "any <Brand> in our units" (unknown brand -> not on file, never the total).
 * Returns an answer, or null to let the normal pipeline decide. Gate (ask.js): pack id plumbing | property only.
 */
import { attachCitations, documentRecord, makeRecord } from "../citations/records.js";
import { notPrivateSql } from "../privacy/privateDocs.js";

const esc = (s) => String(s).replace(/[\\%_]/g, "\\$&");
const FILLER = /^(?:(?:hey|hi|ok|okay|so|um|uh|yo|alright|please|just|and|quick one|real quick)\b[\s,.:;!-]*)+/i;
const TAIL = /(?:\s+(?:lol|please|pls|thanks|thank you|for me|real quick|quick|asap|today))+[\s?.!]*$/i;
const clean = (q) => String(q ?? "").trim().replace(FILLER, "").replace(TAIL, "").replace(/[\s?.!]+$/, "").replace(/[’]/g, "'");

function ok(text, facts, records, basis) {
  return attachCitations({ kind: "answer", text, facts, sources: [], confidence: 1, verifiedCount: facts.length, unverifiedCount: 0, closest: [], catalogLane: true }, { records, total: records.length, basis });
}
function noAnswer(text, basis) {
  return attachCitations({ kind: "no-answer", text, facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [], catalogLane: true }, { records: [], total: 0, kind: "searched", basis });
}
const sing = (w) => w.replace(/ies$/, "y").replace(/(?:ches|shes|xes|sses)$/, (m) => m.slice(0, -2)).replace(/(?<!s)s$/, "");
const singPhrase = (p) => { const w = p.trim().toLowerCase().split(/\s+/); w[w.length - 1] = sing(w[w.length - 1]); return w.join(" "); };

/* ---------------------------------------------------------------- vocab from the tenant's own data */
async function equipTypes(db) {
  const r = await db.raw(`SELECT lower(data->>'equipment_type') AS t, count(*)::int AS n FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL AND data->>'equipment_type' IS NOT NULL GROUP BY 1`);
  return r.rows.map((x) => { const m = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(x.t); return { t: x.t, n: x.n, base: (m ? m[1] : x.t).trim(), qual: m ? m[2].trim() : null }; });
}
/** Types a noun phrase names: "tankless water heater" -> that exact type; "water heater" -> every type with that base; else none. */
function typesFor(types, phrase) {
  const p = singPhrase(phrase.replace(/\b(?:units?|ones?|installed|systems?)\b/g, " ").replace(/\s+/g, " "));
  if (!p) return [];
  const exact = types.filter((x) => x.t === p || (x.qual && `${x.qual} ${x.base}` === p));
  if (exact.length) return exact;
  const base = types.filter((x) => x.base === p);
  if (base.length || p.length < 4) return base;
  return types.filter((x) => x.base.length >= 4 && lev(x.base, p) <= (p.length >= 6 ? 2 : 1)); // typo tolerance, vocabulary still the tenant's own types
}
function lev(a, b) { const m = a.length, n = b.length; const d = Array.from({ length: m + 1 }, (_, x) => [x, ...Array(n).fill(0)]); for (let y = 1; y <= n; y++) d[0][y] = y; for (let x = 1; x <= m; x++) for (let y = 1; y <= n; y++) { d[x][y] = Math.min(d[x - 1][y] + 1, d[x][y - 1] + 1, d[x - 1][y - 1] + (a[x - 1] === b[y - 1] ? 0 : 1)); if (x > 1 && y > 1 && a[x - 1] === b[y - 2] && a[x - 2] === b[y - 1]) d[x][y] = Math.min(d[x][y], d[x - 2][y - 2] + 1); } return d[m][n]; }
const label = (x) => (x.qual ? `${x.qual} ${x.base}` : x.base);
const typeText = (ts) => (ts.length === 1 ? label(ts[0]) : ts[0].base);

async function customerByName(db, raw) {
  const m = [...String(raw).replace(/^\s*(?:does|do|did|is|are|what|whats|what's)\s+/i, "").matchAll(/\b([A-Z][a-z'-]+(?:\s+[A-Z][a-z'-]+)+)/g)].map((x) => x[1].replace(/['’]s?$/, "").trim());
  for (const nm of m) {
    const r = await db.raw(`SELECT id, customer_number, data->>'customer_name' AS name FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $1 LIMIT 3`, [esc(nm)]);
    if (r.rows.length === 1) return r.rows[0];
  }
  for (const nm of m) { // one/two-typo tolerance against the tenant's own customer names (unique near match only)
    if (nm.length < 8) continue;
    const all = await db.raw(`SELECT id, customer_number, data->>'customer_name' AS name FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND data->>'customer_name' IS NOT NULL`);
    const near = all.rows.filter((x) => lev(String(x.name).toLowerCase(), nm.toLowerCase()) <= 2);
    if (near.length === 1) return near[0];
  }
  return null;
}
const custRec = (id, name) => makeRecord({ type: "customer", id, label: name });
const unitRec = (e) => makeRecord({ type: "unit", id: e.id, label: `${e.manufacturer ?? ""} ${e.equipment_type ?? "unit"}`.trim(), sublabel: [e.model, e.serial_number].filter(Boolean).join(" · ") || undefined, customerId: e.customer_id });

/* ---------------------------------------------------------------- lanes */

/** R42: brand counts with a unit noun ("how many Haier appliances", "Whirplool units we manage", "how many Naivens have we put in"): manufacturer vocabulary is the tenant's own;
 *  typo-tolerant to an existing brand; a brand that appears nowhere in the tenant's rows -> honest 0 + the brands on file (never the total). */
const UNIT_NOUN = /^(.+?)\s+(?:units?|appliances?|equipment|euqipment|equipmnet|machines?|systems?|installs?|products?)$/i;
async function brandCountLane(db, phrase, rawCase) {
  const mm = UNIT_NOUN.exec(phrase.trim());
  const cand = (mm ? mm[1] : phrase).trim();
  if (!/^[A-Za-z][A-Za-z.&-]{2,24}(?: [A-Za-z.&-]+)?$/.test(cand) || cand.split(" ").length > 2) return null;
  const types = await equipTypes(db);
  if (typesFor(types, cand).length) return null;
  const rows = await db.raw(`SELECT DISTINCT data->>'manufacturer' AS b FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL AND data->>'manufacturer' IS NOT NULL ORDER BY 1`);
  const brands = rows.rows.map((x) => x.b);
  if (!brands.length) return null;
  const c = cand.toLowerCase().replace(/s$/, "");
  const exact = brands.find((b) => b.toLowerCase() === cand.toLowerCase() || b.toLowerCase() === c);
  const fuzzy = exact ?? brands.find((b) => b.length >= 5 && lev(b.toLowerCase(), c) <= 2 && lev(b.toLowerCase(), c) < Math.max(3, b.length - 3));
  if (fuzzy) {
    const r = await db.raw(`SELECT e.id, e.customer_id, e.data->>'manufacturer' AS manufacturer, e.data->>'equipment_type' AS equipment_type, e.data->>'model' AS model, e.data->>'serial_number' AS serial_number FROM entities e WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.data->>'manufacturer' ILIKE $1`, [esc(fuzzy)]);
    return ok(`${r.rows.length} ${fuzzy} unit${r.rows.length === 1 ? "" : "s"} on file${exact ? "" : ` (reading "${cand}" as ${fuzzy})`}.`, [{ label: `Units: ${fuzzy}`, value: String(r.rows.length), sources: [] }], r.rows.slice(0, 20).map(unitRec).filter(Boolean), `Counted equipment records whose manufacturer is ${fuzzy}.`);
  }
  if (!mm && !/^[A-Z]/.test(rawCase ?? cand)) return null; // bare unknown word without a unit noun: only a capitalised brand-looking name
  if (EQUIP_NOUN.test(c) || GENERIC.test(c)) return null;
  const anywhere = await db.raw(`SELECT 1 FROM entities WHERE data::text ILIKE $1 UNION ALL SELECT 1 FROM extractions WHERE value ILIKE $1 LIMIT 1`, [`%${esc(c)}%`]);
  if (anywhere.rows.length) return null;
  return ok(`0 ${cand} units on file: that brand isn't in your records. The brands I do have are ${brands.join(", ")}.`, [{ label: `Units: ${cand}`, value: "0", sources: [] }], [], `Searched every equipment manufacturer and every record for ${cand}; none matched.`);
}
async function equipCountLane(db, q) {
  const m = /^how many (?:of )?(?:our |the )?(.+?)(?:\s+(?:do we (?:have|track|manage|own|got)|have we (?:installed|put in|got|done|set|sold|serviced)|do we (?:service|work on|maintain)|are (?:there )?(?:on file|in (?:the |our )(?:portfolio|properties|system|units|buildings))|are we tracking|we have|on file|in (?:the |our )(?:portfolio|properties|system|units|buildings)|in total|total))?$/i.exec(q);
  if (!m) return null;
  const types = await equipTypes(db);
  if (/^(?:appliances|equipment|pieces of equipment|equipment items|appliance units)$/i.test(m[1].trim()) && types.length) {
    const t = await db.raw(`SELECT e.id, e.customer_id, e.data->>'manufacturer' AS manufacturer, e.data->>'equipment_type' AS equipment_type, e.data->>'model' AS model, e.data->>'serial_number' AS serial_number FROM entities e WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL`);
    return ok(`${t.rows.length} pieces of equipment on file (every appliance/equipment record).`, [{ label: "Equipment records", value: String(t.rows.length), sources: [] }], t.rows.slice(0, 20).map(unitRec).filter(Boolean), "Counted every equipment record.");
  }
  const bl = await brandCountLane(db, m[1], m[1]);
  if (bl) return bl;
  const ts = typesFor(types, m[1]);
  if (!ts.length) return await absentTypeCount(db, m[1], types);
  const r = await db.raw(`SELECT e.id, e.customer_id, e.data->>'manufacturer' AS manufacturer, e.data->>'equipment_type' AS equipment_type, e.data->>'model' AS model, e.data->>'serial_number' AS serial_number FROM entities e WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND lower(e.data->>'equipment_type') = ANY($1::text[])`, [ts.map((x) => x.t)]);
  const n = r.rows.length; const nm = typeText(ts);
  return ok(`${n} ${nm}${n === 1 ? "" : "s"} on file (by the equipment type on each unit record).`, [{ label: `Units: ${nm}`, value: String(n), sources: [] }], r.rows.slice(0, 20).map(unitRec).filter(Boolean), `Counted the equipment records whose type is ${ts.map((x) => x.t).join(" or ")}.`);
}

/** R41: "how many washers" when the tenant has no such equipment type: honest 0 + the types it does have (never the total, never a generic no-answer).
 *  Only fires for a short plain noun that appears nowhere in this tenant's data and is not a generic collective word. */
const GENERIC = /^(?:appliance|equipment|unit|thing|item|system|machine|piece|asset|record|row|entry|one|device|fixture|property|building|door|lease|document|file|page|question|dollar)s?$/;
const EQUIP_NOUN = /^(?:washers?|dryers?|furnaces?|boilers?|heaters?|pumps?|softeners?|refrigerators?|fridges?|dishwashers?|ranges?|ovens?|stoves?|microwaves?|freezers?|disposals?|faucets?|toilets?|valves?|tanks?|filters?|thermostats?|compressors?|humidifiers?|dehumidifiers?|conditioners?|ices?makers?|hoods?|sinks?|showers?|tubs?|meters?|preventers?|osmosis|purifiers?)$/;
async function absentTypeCount(db, phrase, types) {
  const words = phrase.toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 2 || words.some((w) => GENERIC.test(w) || w.length < 4)) return null;
  if (!EQUIP_NOUN.test(words[words.length - 1])) return null; // only recognise "this is asking about an equipment type" - the answer itself comes from the tenant's rows
  const stem = (w) => { const x = sing(w); return x.length > 5 ? x.slice(0, -1) : x; }; // tolerate one trailing typo letter
  const needle = words.map(stem).join(" ");
  const seen = await db.raw(`SELECT 1 FROM entities WHERE data::text ~* $1 UNION ALL SELECT 1 FROM extractions WHERE value ~* $1 LIMIT 1`, [`\\m${needle.replace(/[^a-z ]/g, "")}`]);
  if (seen.rows.length) return null;
  const known = [...new Set(types.map((x) => x.base))].sort();
  if (!known.length) return null;
  return ok(`0 ${singPhrase(phrase)}s on file: that equipment type isn't in your records. The types I do have are ${known.join(", ")}.`, [], [], `Searched every equipment type and record for "${needle}"; none matched.`);
}

/** R41: "how many open work orders" - a status word qualifies a document type; count by the tenant's own status values, honest 0 when none matches. */
const STATUS_GROUPS = { completed: ["completed", "complete", "done", "finished", "closed"], open: ["open", "pending", "in progress", "scheduled", "active", "unfinished", "outstanding", "new"], cancelled: ["cancelled", "canceled", "void", "voided"], paid: ["paid"], unpaid: ["unpaid", "overdue", "past due", "outstanding", "open"] };
async function statusDocCountLane(db, q) {
  const m = /^how many (open|pending|completed|complete|closed|scheduled|in progress|cancell?ed|finished|done|active|outstanding|overdue|past due|unfinished|unpaid|paid) (.+?)(?:\s+(?:do we have|are there|are open|on file|we have|right now|currently|so far))?$/i.exec(q);
  if (!m) return null;
  const mod = m[1].toLowerCase();
  const words = m[2].toLowerCase().split(/\s+/).filter(Boolean).map(sing);
  if (!words.length || words.length > 3) return null;
  const dt = await db.raw(`SELECT d.document_type AS t FROM documents d WHERE ${notPrivateSql("d")} AND d.document_type IS NOT NULL GROUP BY 1`);
  const hits = dt.rows.map((x) => ({ t: x.t, toks: new Set(String(x.t).toLowerCase().split(/[-_\s]+/).map(sing)) })).filter((x) => words.every((w) => x.toks.has(w)));
  if (hits.length !== 1) return null;
  const t = hits[0].t; const nm = t.replace(/[-_]/g, " ");
  const st = await db.raw(`SELECT lower(x.value) AS v, count(DISTINCT d.id)::int AS n FROM documents d JOIN extractions x ON x.document_id = d.id AND x.field_key = 'status' WHERE ${notPrivateSql("d")} AND d.document_type = $1 GROUP BY 1`, [t]);
  if (!st.rows.length) return null;
  const grp = Object.values(STATUS_GROUPS).filter((g) => g.includes(mod.replace(/^cancelled$/, "cancelled")));
  const want = new Set(grp.flat().concat(mod));
  const matched = st.rows.filter((r) => want.has(r.v));
  const total = st.rows.reduce((a, r) => a + r.n, 0);
  const n = matched.reduce((a, r) => a + r.n, 0);
  const have = st.rows.map((r) => `${r.v} (${r.n})`).join(", ");
  const text = n ? `${n} ${mod} ${nm}${n === 1 ? "" : "s"} on file (by the status on each record).` : `0 ${mod} ${nm}s: none of the ${total} ${nm}s on file has a status that means ${mod}. Statuses on file: ${have}.`;
  let recs = [];
  if (n) {
    const vals = matched.map((r) => r.v);
    const docs = await db.raw(`SELECT d.id, d.original_filename FROM documents d JOIN extractions x ON x.document_id = d.id AND x.field_key = 'status' AND lower(x.value) = ANY($2) WHERE ${notPrivateSql("d")} AND d.document_type = $1 ORDER BY d.created_at DESC LIMIT 20`, [t, vals]);
    recs = docs.rows.map((x) => documentRecord({ id: x.id, original_filename: x.original_filename }, { label: `${nm} · ${x.original_filename}` }));
  }
  return ok(text, [{ label: `${mod} ${nm}s`, value: String(n), sources: [] }], recs, `Counted ${nm} documents whose status extraction is one of: ${[...want].join(", ")}; statuses on file: ${have}.`);
}

async function equipListLane(db, q) {
  const m = /^(?:who|which (?:c\w{5,8}s?|owners?|clients?)|what (?:customers?|owners?|clients?)|list (?:all )?(?:the )?(?:customers?|owners?|everyone|people)|show (?:me )?(?:all )?(?:the )?(?:customers?|owners?|everyone)) (?:of ours )?(?:has|have|with|got|owns?)\s+(?:an? |any |the )?(.+)$/i.exec(q);
  if (!m) return null;
  const types = await equipTypes(db);
  const ts = typesFor(types, m[1]);
  if (!ts.length) return null;
  const r = await db.raw(`SELECT DISTINCT c.id, c.data->>'customer_name' AS name FROM entities e JOIN entities c ON c.id = e.customer_id AND c.entity_type = 'customer' AND c.merged_into IS NULL WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND lower(e.data->>'equipment_type') = ANY($1::text[]) ORDER BY 2`, [ts.map((x) => x.t)]);
  const rows = r.rows.filter((x) => x.name); const n = rows.length; const nm = typeText(ts);
  if (!n) return noAnswer(`No customers have a ${nm} on file.`, `Checked every unit record for type ${ts.map((x) => x.t).join(" or ")}; none matched.`);
  const shown = rows.slice(0, 300).map((x) => x.name).join(", ");
  return ok(`${n} customer${n === 1 ? " has" : "s have"} a ${nm} on file: ${shown}${n > 300 ? `, and ${n - 300} more` : ""}.`, rows.slice(0, 300).map((x) => ({ label: "Customer", value: x.name, sources: [] })), rows.slice(0, 300).map((x) => custRec(x.id, x.name)).filter(Boolean), `Listed the customers who own a unit whose type is ${ts.map((x) => x.t).join(" or ")}.`);
}

async function equipYesNoLane(db, raw, q) {
  const types = await equipTypes(db);
  if (!types.length) return null;
  const quals = new Set(types.map((x) => x.qual).filter(Boolean));
  let ts = null;
  let m = /^(?:does|do|did) (.+?) (?:have|got|own) (?:an? |any )?(.+)$/i.exec(q);
  if (m) ts = typesFor(types, m[2]);
  if ((!ts || !ts.length) && m) { const w = singPhrase(m[2]); if (quals.has(w)) ts = types.filter((x) => x.qual === w); }
  if (!ts || !ts.length) {
    m = /^(?:is|are) (.+?)'s (?:water heater|heater|hetaer|unit|equipment|system|install|one|tank) (?:a |an )?([a-z]+)$/i.exec(q);
    if (m && quals.has(m[2].toLowerCase())) ts = types.filter((x) => x.qual === m[2].toLowerCase());
  }
  if (!m || !ts || !ts.length) return null;
  const cust = await customerByName(db, raw);
  if (!cust) return null;
  const r = await db.raw(`SELECT e.id, e.customer_id, e.data->>'manufacturer' AS manufacturer, e.data->>'equipment_type' AS equipment_type, e.data->>'model' AS model, e.data->>'serial_number' AS serial_number, e.data->>'installation_date' AS installed FROM entities e WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.customer_id = $1`, [cust.id]);
  const hit = r.rows.filter((x) => ts.some((t) => t.t === String(x.equipment_type).toLowerCase()));
  const nm = typeText(ts);
  const recs = (hit.length ? hit : r.rows).map(unitRec).filter(Boolean);
  if (hit.length) return ok(`Yes - ${cust.name} has a ${nm} on file (${hit.map((x) => `${x.manufacturer ?? ""} ${x.model ?? ""}`.trim()).join("; ")}).`, [{ label: `${cust.name}: ${nm}`, value: "Yes", sources: [] }], recs, `Read ${cust.name}'s equipment records for type ${ts.map((x) => x.t).join(" or ")}.`);
  const other = [...new Set(r.rows.map((x) => x.equipment_type).filter(Boolean))];
  return ok(`No - ${cust.name} has no ${nm} on file${other.length ? `; the equipment on file for them is ${other.join(", ")}` : " (no equipment on file for them at all)"}.`, [{ label: `${cust.name}: ${nm}`, value: "No", sources: [] }], recs, `Read ${cust.name}'s equipment records; none is type ${ts.map((x) => x.t).join(" or ")}.`);
}

async function customerNumberLane(db, raw, q) {
  if (!/\bc\w{5,8}r\s*(?:number|no\.?|#|id)\b|\baccount\s*(?:number|no\.?|#)\b|\bcust\s*(?:number|no\.?|#|id)\b/i.test(q)) return null;
  const cust = await customerByName(db, raw);
  if (!cust) return null;
  if (!cust.customer_number) return noAnswer(`${cust.name} is on file, but no customer number is recorded for them.`, `Read ${cust.name}'s customer record.`);
  return ok(`${cust.name}'s customer number is ${cust.customer_number}.`, [{ label: "Customer number", value: cust.customer_number, sources: [] }], [custRec(cust.id, cust.name)].filter(Boolean), `Read the customer number on ${cust.name}'s customer record.`);
}

const QUAL = new Set(["vendor", "vendors", "all", "our", "the", "total"]);
async function docTypeCountLane(db, q) {
  const m = /^(?:how many|number of|total number of|count of) (.+?)(?:\s+(?:do we have|are (?:there )?on file|(?:have|did) we (?:sent|send|written|write|done|do|issued|got|made|filed|put together)|we have|on file|so far|in total|total|we(?:'ve| have) (?:sent|written|done|issued)))?$/i.exec(q);
  if (!m) return null;
  const words = m[1].toLowerCase().split(/\s+/).filter((w) => w && !QUAL.has(w)).map(sing);
  if (!words.length || words.length > 4 || words.some((w) => /^(?:customer|owner|tenant|unit|vendor|technician|lease|equipment|document|page|file|question|dollar|invoice total)$/.test(w) && w !== "invoice")) return null;
  const r = await db.raw(`SELECT d.document_type AS t, count(*)::int AS n FROM documents d WHERE ${notPrivateSql("d")} AND d.document_type IS NOT NULL GROUP BY 1`);
  const toks = r.rows.map((x) => ({ ...x, toks: new Set(String(x.t).toLowerCase().split(/[-_\s]+/).map(sing)) }));
  let hits = toks.filter((x) => words.every((w) => x.toks.has(w)));
  if (!hits.length) hits = toks.filter((x) => words.every((w) => x.toks.has(w) || (w.length >= 6 && [...x.toks].some((tk) => tk.length >= 6 && lev(tk, w) <= 1)))); // one-typo tolerance against the tenant's own document-type words
  if (hits.length !== 1) return null;
  const { t, n } = hits[0]; const nm = t.replace(/[-_]/g, " ");
  const docs = await db.raw(`SELECT d.id, d.original_filename FROM documents d WHERE ${notPrivateSql("d")} AND d.document_type = $1 ORDER BY d.created_at DESC LIMIT 20`, [t]);
  return ok(`${n} ${nm} document${n === 1 ? "" : "s"} on file.`, [{ label: `Documents: ${nm}`, value: String(n), sources: [] }], docs.rows.map((x) => documentRecord({ id: x.id, original_filename: x.original_filename }, { label: `${nm} · ${x.original_filename ?? x.id}` })).filter(Boolean), `Counted every document of type "${t}" on file.`);
}

async function anyBrandLane(db, raw) {
  const m = /^(?:do we have |are there |got |we got )?any ([A-Z][A-Za-z.&-]{2,24}(?: [A-Z][A-Za-z.&-]+)?)(?: (?:appliances?|units?|equipment|euqipment|equipmnet|ones?|heaters?|products?))?(?: (?:in|at|on|across) (?:our |the )?(?:units?|portfolio|properties|buildings|file|system|installs?))?(?: on file)?\??$/.exec(clean(raw));
  if (!m) return null;
  const brand = m[1].trim();
  if (/^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December|Day|Time|Way|One|Questions?|Customers?|Invoices?)\b/.test(brand)) return null;
  const known = await db.raw(`SELECT count(*)::int AS n FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL AND data->>'manufacturer' ILIKE $1`, [esc(brand)]);
  if (known.rows[0].n > 0) return ok(`Yes - ${known.rows[0].n} ${brand} unit${known.rows[0].n === 1 ? "" : "s"} on file.`, [{ label: `Units: ${brand}`, value: String(known.rows[0].n), sources: [] }], [], `Counted equipment records whose manufacturer is ${brand}.`);
  const anywhere = await db.raw(`SELECT 1 FROM entities WHERE data::text ILIKE $1 UNION ALL SELECT 1 FROM extractions WHERE value ILIKE $1 LIMIT 1`, [`%${esc(brand)}%`]);
  if (anywhere.rows.length) return null;
  const brands = await db.raw(`SELECT DISTINCT data->>'manufacturer' AS b FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL AND data->>'manufacturer' IS NOT NULL ORDER BY 1`);
  return ok(`No ${brand} units on file (0). The brands I do have are ${brands.rows.map((x) => x.b).join(", ")}.`, [{ label: `Units: ${brand}`, value: "0", sources: [] }], [], `Searched every equipment manufacturer and every record for ${brand}; none matched.`);
}

async function brandStatementLane(db, q) {
  const m = /^([A-Za-z][A-Za-z.&-]{2,24}(?: [A-Z][A-Za-z.&-]+)?) (?:units?|appliances?|equipment|euqipment|equipmnet) (?:we (?:manage|have|got|own|track|service)|on file|in (?:our |the )?(?:portfolio|system|properties|units))$/i.exec(q);
  return m ? await brandCountLane(db, m[1] + " units", m[1]) : null;
}

/** R42: a person the question names who is not one of this organization's customers (and appears nowhere in its data) -> honest not-on-file for the fields a customer record carries. */
async function unknownPersonLane(db, raw, q) {
  if (!/\b(?:phone|cell|email|e-mail|water heater|heater|hetaer|install\w*|hardness)\b/i.test(q)) return null;
  const caps = [...raw.matchAll(/\b([A-Z][a-z'-]+(?:\s+[A-Z][a-z'-]+)+)/g)].map((x) => x[1].replace(/['’]s?$/, "").trim()).filter((c) => !/^(?:How|Many|What|When|Which|Does|Is|Do)\b/.test(c));
  if (caps.length !== 1) return null;
  const nm = caps[0]; const nl = nm.toLowerCase();
  const all = await db.raw(`SELECT data->>'customer_name' AS n FROM entities WHERE entity_type IN ('customer','technician') AND data->>'customer_name' IS NOT NULL`);
  if (all.rows.some((x) => lev(String(x.n).toLowerCase(), nl) <= 2)) return null;
  const mf = await db.raw(`SELECT DISTINCT lower(data->>'manufacturer') AS b FROM entities WHERE entity_type = 'equipment' AND data->>'manufacturer' IS NOT NULL`);
  if (mf.rows.some((x) => nl.split(" ").some((w) => w.length >= 5 && lev(x.b.split(" ")[0], w) <= 2))) return null;
  const tn = await db.raw(`SELECT DISTINCT lower(value) AS n FROM extractions WHERE field_key = 'tenant_name'`);
  if (tn.rows.some((x) => lev(x.n, nl) <= 2)) return null;
  const anywhere = await db.raw(`SELECT 1 FROM entities WHERE data::text ILIKE $1 UNION ALL SELECT 1 FROM extractions WHERE value ILIKE $1 LIMIT 1`, [`%${esc(nm)}%`]);
  if (anywhere.rows.length) return null;
  return noAnswer(`I don't have a customer named ${nm} on file, so there is nothing recorded about their phone, equipment or installs.`, `Searched every customer name and record for ${nm}; none matched.`);
}

export async function tryCatalogLane(db, question) {
  const raw = String(question ?? "");
  const q = clean(raw);
  if (!q || q.length > 220 || /[;:<>{}"`\\]/.test(q)) return null;
  try {
    return (await customerNumberLane(db, raw, q)) ?? (await equipYesNoLane(db, raw, q)) ?? (await equipListLane(db, q)) ?? (await statusDocCountLane(db, q)) ?? (await equipCountLane(db, q)) ?? (await docTypeCountLane(db, q)) ?? (await brandStatementLane(db, q)) ?? (await anyBrandLane(db, raw)) ?? (await unknownPersonLane(db, raw, q)) ?? null;
  } catch (err) {
    console.error("tenantCatalogLane failed, falling through:", err?.message);
    return null;
  }
}
