/**
 * R43: "what's the water pressure at Sarah Whitaker's house" / "when was the last time we flushed Sarah Whitaker's heater".
 * The customer IS on file, the thing asked about is not something this organization records at all. The older lanes dropped that unexplained
 * word and answered about the customer in general ("everything on file", "last serviced July 7"). This lane answers ONLY when:
 *   - exactly one customer matches the full name,
 *   - the asked-about word (the head noun, or the verb) is not a generic word, not a field/column/document-type/equipment word anywhere in THIS
 *     organization's data, and does not occur in any text recorded on that customer's documents.
 * Then it says plainly what is not on file and what is. Anything else returns null (the other lanes decide). Kill switch: DONOVAN_ATTR_ABSENCE=0.
 *   pure: parseAttrAbsence     db: runAttrAbsence
 */
import { attachCitations, customerRecord } from "../citations/records.js";
import { TENANT_SQL, answerEnvelope } from "../scope.js";
import { notPrivateSql } from "../privacy/privateDocs.js";

const NAME = "([A-Z][A-Za-z'.-]+(?:\\s+[A-Z][A-Za-z'.-]+){1,2})";
const STOP = new Set("a an the of in on at for to by with from and or is are was were what whats which when how this that it its our their his her my your".split(" "));
/** Words that mean a thing every organization records in some form (or a generic word): never "not on file" on the strength of the data alone. */
const GENERIC = new Set(("mail e price cost total balance owe owed amount due date dates time times number numbers name names phone email address addresses serial model brand make age old year years tonnage warranty warranties " +
  "install installed installation invoice invoices quote quotes estimate estimates status payment payments paid unpaid bill bills billing history last first next recent technician tech techs tenant tenants lease leases rent deposit " +
  "unit units equipment type types notes note work job jobs visit visits call calls service services serviced contact customer customers document documents file files record records info information detail details " +
  "agreement agreements plan plans permit permits report reports certificate certificates ticket tickets city state zip street location property house home place").split(/\s+/));
const CLAIM_ATTRS = new Set("pipe pressure psi humidity voltage sqft footage pets pet parking color flow hardness temperature wifi thermostat".split(" "));
const CLAIM_VERBS = new Set("flushed descaled winterized sanitized calibrated".split(" "));
const KNOWN_VERBS = new Set(("serviced service installed install replaced replace repaired repair tested test inspected inspect visited visit called call billed bill invoiced invoice paid pay quoted quote scoped scope checked check seen see " +
  "fixed fix maintained maintain worked work done do did sent send signed sign moved move renewed renew started start ended end expired expire registered register scheduled schedule booked book contacted contact emailed email serviced updated update").split(/\s+/));
const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const stem = (w) => w.replace(/(?:ies)$/, "y").replace(/(?:ing|ed|es|s)$/, (m, i, s) => (s.length - m.length >= 3 ? "" : m));
const content = (s) => norm(s).split(" ").filter((w) => w && !STOP.has(w));

/** Pure. @returns {kind:"attr-absence", name, attr?, verb?, question} or null. */
export function parseAttrAbsence(question) {
  const it = parseAttrAbsenceRaw(question);
  if (!it) return null;
  // a generic word, or a verb every organization records ("serviced", "installed"), is never claimed here: the older lanes keep those questions
  if (it.attr && !content(it.attr).some((w) => CLAIM_ATTRS.has(w) || CLAIM_ATTRS.has(stem(w)))) return null; // only concepts these kinds of records never carry; synonyms of recorded fields stay with the older lanes
  if (it.verb && !CLAIM_VERBS.has(it.verb)) return null;
  if (it.attr && content(it.attr).some((w) => GENERIC.has(w) || GENERIC.has(stem(w)))) return null;
  if (it.verb && (KNOWN_VERBS.has(it.verb) || KNOWN_VERBS.has(stem(it.verb)) || KNOWN_VERBS.has(it.verb.replace(/ed$/, "")))) return null;
  return it;
}
function parseAttrAbsenceRaw(question) {
  if (process.env.DONOVAN_ATTR_ABSENCE === "0") return null;
  const raw = String(question ?? "").replace(/[’`]/g, "'").replace(/[?!.]+\s*$/, "").trim();
  if (!raw || raw.length > 140) return null;
  const body = raw.replace(/^(?:(?:hey|yo|ok(?:ay)?|so|um+|real quick|quick one|alright|please)\b[\s,.:-]*)+/i, "").trim();
  let m = new RegExp(`^(?:what(?:'s| is| are)|whats)\\s+(?:the\\s+)?([a-z][a-z -]{2,30}?)\\s+(?:at|of|for|in)\\s+${NAME}(?:'s)?(?:\\s+(?:house|place|home|property|building|site))?$`).exec(body);
  if (m && /^[A-Z]/.test(m[2])) return { kind: "attr-absence", name: m[2].replace(/'s$/, "").trim(), attr: m[1].trim(), question: raw };
  m = new RegExp(`^(?:what(?:'s| is)|whats)\\s+${NAME}'s\\s+([a-z][a-z -]{2,30})$`).exec(body);
  if (m) return { kind: "attr-absence", name: m[1].trim(), attr: m[2].trim(), question: raw };
  m = new RegExp(`^when\\s+(?:was|did)\\s+(?:the\\s+last\\s+time\\s+)?we\\s+(?:last\\s+)?([a-z]{4,14})\\s+${NAME}'s\\s+([a-z][a-z -]{2,25})$`, "i").exec(body);
  if (m && /^[A-Z]/.test(m[2])) return { kind: "attr-absence", name: m[2].trim(), verb: m[1].toLowerCase(), object: m[3].trim().toLowerCase(), question: raw };
  return null;
}

const empty = (text, basis, records = []) => attachCitations({ kind: "no-answer", text, facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [] }, { records, total: records.length, kind: "searched", basis });

export async function runAttrAbsence(db, it) {
  const asked = it.attr ? content(it.attr) : [it.verb];
  if (!asked.length) return null;
  const head = it.attr ? asked[asked.length - 1] : it.verb;
  if (it.attr && asked.some((w) => GENERIC.has(w) || GENERIC.has(stem(w)))) return null;
  if (it.verb && (KNOWN_VERBS.has(it.verb) || KNOWN_VERBS.has(stem(it.verb)) || KNOWN_VERBS.has(it.verb.replace(/ed$/, "")))) return null;
  const { rows: cs } = await db.raw(`SELECT id, data->>'customer_name' AS customer_name, data->>'service_address' AS service_address FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL} AND lower(data->>'customer_name') = lower($1)`, [it.name]);
  if (cs.length !== 1) return null;
  const cust = cs[0];
  // the organization's own vocabulary: extraction field keys, document types, entity data keys, equipment makes/types
  const [{ rows: keys }, { rows: types }, { rows: ekeys }, { rows: eqv }] = await Promise.all([
    db.raw(`SELECT DISTINCT field_key AS k FROM extractions WHERE ${TENANT_SQL}`),
    db.raw(`SELECT DISTINCT document_type AS k FROM documents WHERE ${TENANT_SQL} AND document_type IS NOT NULL`),
    db.raw(`SELECT DISTINCT jsonb_object_keys(data) AS k FROM entities WHERE ${TENANT_SQL} AND merged_into IS NULL`),
    db.raw(`SELECT DISTINCT lower(data->>'manufacturer') AS m, lower(data->>'equipment_type') AS t FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT_SQL}`),
  ]);
  const schema = new Set(); // words of the organization's own field keys, document types and entity data keys
  for (const r of [...keys, ...types, ...ekeys]) for (const w of norm(String(r.k).replace(/[-_]/g, " ")).split(" ")) if (w) { schema.add(w); schema.add(stem(w)); }
  const vocab = new Set(schema); // plus the makes and kinds of equipment it records
  for (const r of eqv) for (const w of norm(`${r.m ?? ""} ${r.t ?? ""}`).split(" ")) if (w) { vocab.add(w); vocab.add(stem(w)); }
  // every other word of the asked-about phrase must not be a field of this organization either ("refrigerant situation": refrigerant IS a field)
  if (it.attr && asked.slice(0, -1).some((w) => schema.has(w) || schema.has(stem(w)))) return null;
  const probe = it.verb ? [it.verb, stem(it.verb)] : [head, stem(head)];
  if (probe.some((w) => vocab.has(w))) return null;
  // text recorded on this customer's own documents (the word may be written there even though no field is named after it)
  const { rows: vals } = await db.raw(
    `SELECT DISTINCT x.value AS v FROM extractions x WHERE x.${TENANT_SQL} AND x.document_id IN (SELECT l.document_id FROM document_entity_links l JOIN entities e ON e.id = l.entity_id WHERE e.id = $1 OR e.customer_id = $1) AND length(x.value) > 3`, [cust.id]).catch(() => ({ rows: null }));
  if (!vals) return null;
  const own = new Set(); for (const r of vals) for (const w of norm(r.v).split(" ")) if (w) { own.add(w); own.add(stem(w)); }
  if (probe.some((w) => own.has(w))) return null;
  const { rows: dt } = await db.raw(`SELECT d.document_type AS t, count(*)::int AS n FROM documents d WHERE ${TENANT_SQL} AND ${notPrivateSql("d")} AND d.id IN (SELECT l.document_id FROM document_entity_links l JOIN entities e ON e.id = l.entity_id WHERE e.id = $1 OR e.customer_id = $1) GROUP BY 1 ORDER BY 2 DESC`, [cust.id]);
  const have = dt.length ? ` What is on file for ${cust.customer_name}: ${dt.map((r) => `${r.n} ${String(r.t).replace(/[-_]/g, " ")}${r.n === 1 ? "" : "s"}`).join(", ")}.` : "";
  const what = it.attr ? it.attr : `any record of "${it.verb}" on ${it.object ? `their ${it.object}` : "their equipment"}`;
  return empty(`There is no ${what} recorded for ${cust.customer_name}: that is not something these records capture.${have}`,
    `Checked the fields, document types and recorded text for ${cust.customer_name}; nothing mentions ${it.attr ? it.attr : it.verb}.`, [customerRecord(cust)]);
}
