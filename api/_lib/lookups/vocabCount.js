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

const norm = (s) => ` ${String(s ?? "").toLowerCase().replace(/[’`]/g, "'").replace(/'s\b/g, "").replace(/[^a-z0-9]+/g, " ").trim()} `;
const FILLER = new Set("how many mny number of count the our all we do have has are there is on file in total installed that with a an and or got you your us it from by made brand make customers customer clients client homes people live living located based on".split(" "));
const UNIT_NOUNS = /\b(?:units?|systems?|equipment|devices?|heaters?|water|tankless|tank|pumps?|sump|softeners?|backflow|preventers?|preventer)\b/g;
const COUNT_RE = /\b(?:how many|number of|count of|total)\b/;
const INV_WORDS = new Set("invoices invoice did does has have do done write wrote written invoiced handle handled complete completed work worked ".trim().split(" "));

function firstLast(name) { const w = norm(name).trim().split(" "); return w; }

/** Pure. @returns {kind:'brand'|'city'|'tech', value:string, customers:boolean} | null */
export function parseVocabCount(question, vocab) {
  if (process.env.DONOVAN_VOCAB_COUNT === "0" || !vocab) return null;
  const raw = String(question ?? "").trim();
  if (!raw || raw.length > 120) return null;
  let q = norm(raw);
  if (!COUNT_RE.test(q)) return null;
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
  if (!hits.length) return null;
  const top = hits[0];
  if (hits.some((h) => h !== top && !top.n.includes(h.n))) return null;
  const rest = q.replace(top.n, " ").split(/\s+/).filter(Boolean);
  if (top.kind === "brand") {
    if (!UNIT_NOUNS.test(` ${rest.join(" ")} `) && !wantsCustomers) { UNIT_NOUNS.lastIndex = 0; return null; }
    UNIT_NOUNS.lastIndex = 0;
    const left = rest.join(" ").replace(UNIT_NOUNS, " ").split(/\s+/).filter(Boolean);
    if (left.some((w) => !FILLER.has(w))) return null;
    return { kind: "brand", value: top.value, customers: wantsCustomers };
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

export async function runVocabCount(db, intent) {
  if (intent.kind === "brand") {
    const { rows } = await db.raw(`SELECT id, customer_id, lower(coalesce(data->>'manufacturer','')) AS mfr FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT_SQL}`, []);
    const want = norm(intent.value).trim();
    const hits = rows.filter((u) => norm(u.mfr).trim() === want);
    const n = intent.customers ? new Set(hits.map((u) => u.customer_id ?? u.id)).size : hits.length;
    const text = intent.customers ? `${n} customer${n === 1 ? "" : "s"} ha${n === 1 ? "s" : "ve"} ${intent.value} equipment (by the manufacturer on each unit record).` : `${hits.length} of ${rows.length} units are ${intent.value} (by the manufacturer on each unit record).`;
    return attachCitations(
      answerEnvelope({ text, facts: [{ label: intent.customers ? `Customers with ${intent.value}` : `Units ${intent.value}`, value: String(n), entityIds: hits.slice(0, 20).map((u) => u.id), sources: [] }], extra: { fastIntent: "vocab_brand_count" } }),
      { records: await customerRecordsFor(db, hits.map((u) => u.id)), total: hits.length, claimedCount: n, basis: `Read the manufacturer on each of the ${rows.length} units.` });
  }
  if (intent.kind === "city") {
    const { rows } = await db.raw(`SELECT id, data->>'service_address' AS addr FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL}`, []);
    const want = norm(intent.value).trim();
    const hits = rows.filter((r) => norm(deriveGeo(r.addr ?? "").city).trim() === want);
    return attachCitations(
      answerEnvelope({ text: `${hits.length} of ${rows.length} customers are in ${intent.value} (by the service address on file).`, facts: [{ label: `Customers in ${intent.value}`, value: String(hits.length), entityIds: hits.slice(0, 20).map((u) => u.id), sources: [] }], extra: { fastIntent: "vocab_city_count" } }),
      { records: await customerRecordsFor(db, hits.map((u) => u.id)), total: hits.length, claimedCount: hits.length, basis: `Read the service address city on each of the ${rows.length} customers.` });
  }
  const { rows } = await db.raw(
    `SELECT DISTINCT x.document_id FROM extractions x JOIN documents d ON d.id = x.document_id AND d.${TENANT_SQL}
      WHERE x.field_key = 'technician' AND lower(COALESCE(NULLIF(x.corrected_value, ''), x.value)) = lower($1) AND x.${TENANT_SQL} AND lower(replace(d.document_type, '_', '-')) = 'invoice'`, [intent.value]);
  return attachCitations(
    answerEnvelope({ text: `${rows.length} invoice${rows.length === 1 ? "" : "s"} list ${intent.value} as the technician.`, facts: [{ label: `Invoices by ${intent.value}`, value: String(rows.length), entityIds: [], sources: [] }], extra: { fastIntent: "vocab_tech_invoice_count" } }),
    { records: await customerRecordsFor(db, await linkedEntityIds(db, rows.map((r) => r.document_id))), total: rows.length, claimedCount: rows.length, basis: `Counted invoice documents whose technician is ${intent.value}.` });
}
