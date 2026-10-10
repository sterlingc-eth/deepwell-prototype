/**
 * R41N E3 - "who" list questions that used to collapse into a keyword list of every customer whose paperwork mentions a word.
 *   who-did    "who tested Jessica Estrada's backflow"           -> the technician printed on THAT customer's backflow test certificate(s)
 *   finding    "who got root intrusion on the sewer scope"       -> customers whose sewer-camera report records that finding ("how many ... found X" -> a count)
 *   city-type  "who in Vail has a water softener"                -> customers whose service address is in that city AND who own that kind of unit
 *   brand-unit "Ashley Figueroa's Bosch - what model"            -> that customer's unit of that make, or an honest "none on file"
 * Everything is read from THIS tenant's own data: document types, the findings text stored in extractions, equipment types and
 * manufacturers, customer addresses. A term that resolves to nothing, an ambiguous name or type, or an unreadable shape returns null
 * (the lane steps aside). Kill switch: DONOVAN_FINDING_WHO=0.
 * pure: parseFindingWho     db: runFindingWho
 */
import { attachCitations, customerRecord } from "../citations/records.js";
import { documentRecordsFor } from "../citations/enrich.js";
import { TENANT_SQL, answerEnvelope } from "../scope.js";

const VAL = (a) => `COALESCE(NULLIF(${a}.corrected_value, ''), ${a}.value)`;
const STOP = new Set("a an the in on of at with and to for from by is it that this was were".split(" "));
const FINDING_GENERIC = new Set("problem issue defect trouble finding result thing".split(" "));
const GENERIC = new Set("report certificate test inspection scope camera sheet record order quote ticket service job jobs work document documents paperwork line".split(" "));
const stem = (w) => w.replace(/(?:ies)$/, "y").replace(/(?:es|s)$/, (m, i, s) => (s.length > 4 ? "" : m)).replace(/ing$/, "");
const words = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
const content = (s) => words(s).filter((w) => !STOP.has(w)).map(stem);
function near(a, b) {
  if (a === b) return true;
  if (a.length < 5 || b.length < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  return s.slice(i) === l.slice(i + 1);
}
const NAME = "([A-Z][A-Za-z'.-]+(?:\\s+[A-Z][A-Za-z'.-]+){1,2})";

/** Pure. @returns {kind:"find-who", shape, ...} or null. */
export function parseFindingWho(question) {
  if (process.env.DONOVAN_FINDING_WHO === "0") return null;
  const raw = String(question ?? "").replace(/[’`]/g, "'").replace(/[?!.]+\s*$/, "").trim();
  if (!raw || raw.length > 180) return null;
  const body = raw.replace(/^(?:(?:hey|yo|ok(?:ay)?|so|um+|hang on|real quick|quick one|sorry,? one more|alright|please)\b[\s,.:…-]*)+/i, "").trim();
  const tail = body.replace(/\s+(?:please|lol|thanks|for me|real quick|thx|pls)$/i, "").trim();
  let m = new RegExp(`^who\\s+([a-z]{3,10})\\s+${NAME}'s\\s+(.+)$`, "i").exec(tail);
  if (m && /^[A-Z]/.test(m[2]) && ["tested", "inspected", "serviced", "scoped", "checked", "did", "ran", "performed"].some((v) => near(m[1].toLowerCase(), v))) return { kind: "find-who", shape: "who-did", verb: m[1].toLowerCase(), name: m[2].trim(), term: m[3].trim(), question: raw };
  m = /^(?:who|which customers?)\s+(?:got|had|has|have|saw|showed|found|with)\s+(?:an?\s+|the\s+)?(.+?)\s+(?:on|in|from)\s+(?:the\s+)?([a-z][a-z -]{2,30})$/i.exec(tail);
  if (m) return { kind: "find-who", shape: "finding", mode: "list", phrase: m[1].trim(), term: m[2].trim(), question: raw };
  m = /^how many\s+([a-z][a-z -]{2,30}?)\s+(?:found|had|showed|have|with|got)\s+(?:an?\s+|the\s+)?(.+)$/i.exec(tail);
  // a count claims only a DOCUMENT noun ("sewer camera jobs/reports/scopes/inspections found X"); "how many Rheem heaters do we have in X" is a unit count
  if (m && /\b(?:jobs?|reports?|scopes?|inspections?|certificates?|tickets?|tests?|visits?|calls?)$/i.test(m[1].trim())) return { kind: "find-who", shape: "finding", mode: "count", phrase: m[2].trim(), term: m[1].trim(), question: raw };
  m = /^(?:who|which customers?)\s+in\s+([A-Za-z][A-Za-z .'-]{1,30}?)\s+(?:has|have|had|got|owns?)\s+(?:an?\s+|the\s+)?([a-z][a-z -]{2,40})$/i.exec(tail);
  if (m) return { kind: "find-who", shape: "city-type", city: m[1].trim(), type: m[2].trim(), question: raw };
  m = new RegExp(`^${NAME}'s\\s+([A-Z][A-Za-z-]{2,})\\s*[-,:–]?\\s*what(?:'s| is)?\\s+(?:the\\s+)?model(?:\\s+(?:is it|number))?$`).exec(tail);
  if (m) return { kind: "find-who", shape: "brand-unit", name: m[1].trim(), brand: m[2].trim(), question: raw };
  return null;
}

async function resolveDocType(db, term) {
  const tw = content(term); if (!tw.length) return null;
  const { rows } = await db.raw(`SELECT DISTINCT document_type FROM documents WHERE ${TENANT_SQL} AND document_type IS NOT NULL`);
  const scored = rows.map((r) => {
    const ww = content(String(r.document_type).replace(/[-_]/g, " "));
    const hit = tw.filter((w) => ww.some((x) => near(w, x)));
    return { t: r.document_type, hit, distinct: hit.filter((w) => !GENERIC.has(w)).length };
  }).filter((s) => (tw.some((w) => !GENERIC.has(w)) ? s.distinct > 0 : s.hit.length > 0)).sort((a, b) => b.hit.length - a.hit.length); // R42: "on the camera" is all generic words: it resolves when exactly one of THIS organization's document types carries one
  if (!scored.length || (scored[1] && scored[1].hit.length === scored[0].hit.length)) return null;
  // every distinctive word of the term must be accounted for by the type
  if (tw.filter((w) => !GENERIC.has(w)).some((w) => !scored[0].hit.includes(w))) return null;
  return scored[0].t;
}

async function oneCustomer(db, name) {
  const { rows } = await db.raw(`SELECT id, data->>'customer_name' AS customer_name, data->>'service_address' AS service_address FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL} AND lower(trim(data->>'customer_name')) = lower($1)`, [name]);
  return rows.length === 1 ? rows[0] : null;
}

const CUST_OF_DOCS = `SELECT DISTINCT l.document_id, c.id AS customer_id, c.data->>'customer_name' AS customer_name, c.data->>'service_address' AS service_address
   FROM document_entity_links l JOIN entities e ON e.id = l.entity_id AND e.merged_into IS NULL AND e.${TENANT_SQL}
   JOIN entities c ON c.id = CASE WHEN e.entity_type = 'customer' THEN e.id ELSE e.customer_id END AND c.merged_into IS NULL AND c.${TENANT_SQL}
  WHERE l.${TENANT_SQL} AND l.document_id = ANY($1::uuid[])`;

const empty = (text, basis) => attachCitations({ kind: "no-answer", text, facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [] }, { records: [], total: 0, kind: "searched", basis });
const list = (names) => (names.length > 60 ? `${names.slice(0, 60).join(", ")}, and ${names.length - 60} more` : names.join(", "));

async function whoDid(db, it) {
  const cust = await oneCustomer(db, it.name); if (!cust) return null;
  const type = await resolveDocType(db, it.term); if (!type) return null;
  const { rows } = await db.raw(
    `SELECT d.id AS document_id, ${VAL("t")} AS tech, (SELECT ${VAL("s")} FROM extractions s WHERE s.document_id = d.id AND s.field_key = 'service_date' AND s.${TENANT_SQL} LIMIT 1) AS dt
       FROM documents d JOIN extractions t ON t.document_id = d.id AND t.field_key = 'technician' AND t.${TENANT_SQL}
      WHERE d.${TENANT_SQL} AND d.document_type = $2 AND d.id IN (SELECT l.document_id FROM document_entity_links l JOIN entities e ON e.id = l.entity_id AND e.${TENANT_SQL}
              WHERE l.${TENANT_SQL} AND (e.id = $1 OR e.customer_id = $1)) ORDER BY dt NULLS LAST`, [cust.id, type]);
  const label = type.replace(/[-_]/g, " ");
  if (!rows.length) return empty(`No ${label} with a technician is on file for ${cust.customer_name}.`, `Looked at ${cust.customer_name}'s ${label} documents for a technician; none is recorded.`);
  const techs = [...new Set(rows.map((r) => r.tech))];
  const text = rows.length === 1
    ? `${rows[0].tech} (${label}${rows[0].dt ? `, ${rows[0].dt}` : ""}) for ${cust.customer_name}.`
    : `${cust.customer_name}'s ${rows.length} ${label}s were done by ${techs.join(", ")}: ${rows.map((r) => `${r.tech}${r.dt ? ` (${r.dt})` : ""}`).join("; ")}.`;
  const src = rows.map((r) => ({ documentId: r.document_id, location: { field: "technician" } }));
  return attachCitations(answerEnvelope({ text, facts: rows.map((r, i) => ({ label: `${label}${r.dt ? ` ${r.dt}` : ""}`, value: r.tech, sources: [src[i]] })), sources: src, extra: { fastIntent: "find_who" } }),
    { records: [customerRecord(cust), ...(await documentRecordsFor(db, rows.map((r) => r.document_id)))], total: rows.length, basis: `Read the technician printed on ${cust.customer_name}'s ${rows.length} ${label}${rows.length === 1 ? "" : "s"}.` });
}

async function finding(db, it) {
  const type = await resolveDocType(db, it.term); if (!type) return null;
  const pw = content(it.phrase).filter((w) => !FINDING_GENERIC.has(w)); if (!pw.length) return null;
  const { rows: vals } = await db.raw(
    `SELECT x.field_key, ${VAL("x")} AS v, array_agg(DISTINCT x.document_id::text) AS docs FROM extractions x JOIN documents d ON d.id = x.document_id AND d.${TENANT_SQL}
      WHERE x.${TENANT_SQL} AND d.document_type = $1 AND x.field_key NOT LIKE '%name%' AND x.field_key NOT LIKE '%address%' AND x.field_key NOT LIKE '%date%' AND x.field_key <> 'technician'
        AND length(${VAL("x")}) BETWEEN 4 AND 120 AND ${VAL("x")} ~ '[A-Za-z]{3}' AND ${VAL("x")} !~ '^[A-Z0-9-]{6,}$' GROUP BY 1, 2`, [type]);
  const label = type.replace(/[-_]/g, " ");
  const hits = vals.filter((r) => { const vw = content(r.v); return pw.every((w) => vw.some((x) => near(w, x))); });
  if (!hits.length) return null;
  if (new Set(hits.map((h) => h.field_key)).size > 1) return null;
  const docIds = [...new Set(hits.flatMap((h) => h.docs))];
  const { rows: cs } = await db.raw(CUST_OF_DOCS, [docIds]);
  const byId = new Map(cs.map((c) => [c.customer_id, c]));
  const names = [...new Set([...byId.values()].map((c) => c.customer_name))].sort((a, b) => a.localeCompare(b));
  const recorded = [...new Set(hits.map((h) => `"${h.v}"`))].join(" / ");
  const records = [...[...byId.values()].map((c) => customerRecord({ id: c.customer_id, customer_name: c.customer_name, service_address: c.service_address })), ...(await documentRecordsFor(db, docIds.slice(0, 40)))];
  const src = docIds.slice(0, 40).map((documentId) => ({ documentId, location: { field: hits[0].field_key } }));
  const text = it.mode === "count"
    ? `${docIds.length} ${label}${docIds.length === 1 ? "" : "s"} recorded ${recorded} (${names.length} customer${names.length === 1 ? "" : "s"}).`
    : `${names.length} customer${names.length === 1 ? "" : "s"} ${names.length === 1 ? "has" : "have"} a ${label} recording ${recorded}: ${list(names)}.`;
  return attachCitations(answerEnvelope({ text, facts: names.slice(0, 60).map((n) => ({ label: n, value: recorded, sources: src.filter(() => true).slice(0, 1) })), sources: src, extra: { fastIntent: "find_who" } }),
    { records, total: records.length, claimedCount: it.mode === "count" ? docIds.length : names.length, basis: `Matched "${it.phrase}" to the ${hits[0].field_key.replace(/_/g, " ")} recorded on ${docIds.length} ${label}${docIds.length === 1 ? "" : "s"} (${recorded}) and listed the linked customers.` });
}

async function cityType(db, it) {
  const { rows: types } = await db.raw(`SELECT DISTINCT e.data->>'equipment_type' AS t FROM entities e WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.${TENANT_SQL} AND e.data->>'equipment_type' IS NOT NULL`);
  const tw = content(it.type); if (!tw.length) return null;
  const cands = types.map((r) => r.t).filter((t) => { const ww = content(t); return tw.every((w) => ww.some((x) => near(w, x))) && ww.length === tw.length; });
  if (cands.length !== 1) return null;
  const eqType = cands[0];
  const city = it.city.replace(/\s+/g, " ");
  const cityRe = `(^|,\\s*)${city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s*,|\\s+[A-Z]{2}\\b|\\s*$)`;
  const { rows: inCity } = await db.raw(`SELECT count(*)::int AS n FROM entities c WHERE c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL} AND c.data->>'service_address' ~* $1`, [cityRe]);
  if (!inCity[0].n) return empty(`No customer on file has a service address in ${city}, so nobody in ${city} has a ${eqType}.`, `Checked every customer's service address for the city ${city}; none is there.`);
  const { rows } = await db.raw(
    `SELECT DISTINCT c.id AS customer_id, c.data->>'customer_name' AS customer_name, c.data->>'service_address' AS service_address FROM entities e JOIN entities c ON c.id = e.customer_id AND c.merged_into IS NULL AND c.${TENANT_SQL}
      WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.${TENANT_SQL} AND e.data->>'equipment_type' = $1 AND c.data->>'service_address' ~* $2 ORDER BY 2`, [eqType, cityRe]);
  if (!rows.length) return empty(`None of the ${inCity[0].n} customer${inCity[0].n === 1 ? "" : "s"} in ${city} has a ${eqType} on file.`, `Checked the ${eqType} units of every customer whose service address is in ${city}; none.`);
  const names = rows.map((r) => r.customer_name);
  const text = `${names.length} customer${names.length === 1 ? "" : "s"} in ${city} ${names.length === 1 ? "has" : "have"} a ${eqType} on file: ${list(names)}.`;
  return attachCitations(answerEnvelope({ text, facts: [], sources: [], extra: { fastIntent: "find_who" } }),
    { records: rows.map((c) => customerRecord({ id: c.customer_id, customer_name: c.customer_name, service_address: c.service_address })), total: rows.length, claimedCount: names.length, basis: `Customers whose service address is in ${city} and who own a ${eqType} unit.` });
}

async function brandUnit(db, it) {
  const cust = await oneCustomer(db, it.name); if (!cust) return null;
  const { rows: units } = await db.raw(`SELECT e.id, e.data->>'manufacturer' AS mfr, e.data->>'model' AS model, e.data->>'equipment_type' AS t, e.data->>'serial_number' AS serial FROM entities e WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.${TENANT_SQL} AND e.customer_id = $1`, [cust.id]);
  const brand = it.brand.toLowerCase();
  const { rows: all } = await db.raw(`SELECT DISTINCT lower(e.data->>'manufacturer') AS m, lower(e.data->>'equipment_type') AS t FROM entities e WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.${TENANT_SQL}`);
  // a word that is an equipment type / a generic noun here is not a make: leave it to the other lanes
  if (all.some((r) => r.t && words(r.t).map(stem).includes(stem(brand)))) return null;
  const mine = units.filter((u) => u.mfr && (u.mfr.toLowerCase() === brand || near(u.mfr.toLowerCase(), brand)));
  if (!mine.length) {
    const isMake = all.some((r) => r.m === brand);
    return empty(`No ${it.brand} unit is on file for ${cust.customer_name}${isMake ? "" : ` (${it.brand} is not a make on file for any customer)`}.`, `Checked ${cust.customer_name}'s ${units.length} unit${units.length === 1 ? "" : "s"} for the make ${it.brand}; none.`);
  }
  const text = mine.length === 1
    ? `${cust.customer_name}'s ${mine[0].mfr}${mine[0].t ? ` ${mine[0].t}` : ""} is model ${mine[0].model ?? "not recorded"}.`
    : `${cust.customer_name} has ${mine.length} ${mine[0].mfr} units: ${mine.map((u) => `${u.t ?? "unit"} model ${u.model ?? "not recorded"}`).join("; ")}.`;
  return attachCitations(answerEnvelope({ text, facts: mine.map((u) => ({ label: `${u.mfr} ${u.t ?? "unit"}`, value: u.model ?? "not recorded", sources: [] })), extra: { fastIntent: "find_who" } }),
    { records: [customerRecord(cust)], total: 1, basis: `Read the model of ${cust.customer_name}'s ${mine[0].mfr} unit${mine.length === 1 ? "" : "s"} from the unit record.` });
}

/** @returns an /api/ask data object, or null. */
export async function runFindingWho(db, it) {
  if (it.shape === "who-did") return whoDid(db, it);
  if (it.shape === "finding") return finding(db, it);
  if (it.shape === "city-type") return cityType(db, it);
  if (it.shape === "brand-unit") return brandUnit(db, it);
  return null;
}
