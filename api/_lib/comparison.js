/**
 * "Do we have more X or more Y?" — an explicit, deterministic comparison (Team A, 2026-09-24).
 *
 * Scorecard: comparisons 4/12. "do we have more invoices or more service tickets on file" answered "You have 68
 * documents." — the analytics planner collapsed the two document types into one `in` filter and counted both together,
 * so neither number nor the comparison ever reached the owner. This module counts each side separately and says which
 * is bigger, with both numbers; for document types it also lists every type on file (a complete breakdown, one fact per
 * type) so the comparison can be checked at a glance.
 *
 * Sides may be document types (invoices, service tickets, permits ...), equipment brands (Trane, Carrier ...), cities
 * (Mesa, Tucson ...) or whole-record kinds (customers, units, documents). Both sides must be the same kind; anything
 * else is left to the agent (which runs on the stronger model for comparisons — see agent/escalation.js).
 *
 * pure: parseComparison, buildComparisonAnswer      db: runComparison (tenant-scoped reads, no model call)
 */
import { docTypeFromWord, DOCUMENT_TYPES, documentTypeLabel } from './documentTypes.js';
import { deriveGeo, brandMatches, KNOWN_AZ_CITY_NAMES, KNOWN_US_CITY_NAMES } from './analytics.js';
import { TENANT_SQL, typeSql, normalizeTypeId, docTypeAliases, answerEnvelope } from './scope.js';
// TEAM C: the records behind both counts (same rows), listed under the answer with their side as the group.
import { attachCitations, customerRecord, unitRecord, documentRecord } from './citations/records.js';
import { comparisonCitations } from './citations/history.js';

const BRANDS = ['trane', 'carrier', 'goodman', 'lennox', 'rheem', 'york', 'daikin', 'mitsubishi'];
const CITY_SET = new Set([...KNOWN_AZ_CITY_NAMES, ...KNOWN_US_CITY_NAMES].map((c) => String(c).toLowerCase()));
const ENTITY_WORDS = {
  customers: 'customers', customer: 'customers', clients: 'customers', client: 'customers', accounts: 'customers',
  units: 'equipment', unit: 'equipment', equipment: 'equipment', systems: 'equipment', condensers: 'equipment',
  documents: 'documents', document: 'documents', paperwork: 'documents', files: 'documents',
};

const clean = (s) => String(s ?? '').toLowerCase()
  .replace(/\b(?:on file|in our records|in the system|do we have|we have|of them|do we|are there|there are|we've got|we got)\b/g, ' ')
  .replace(/\b(?:more|fewer|less|greater|a|an|the|our|of|for|jobs?|on)\b/g, ' ')
  .replace(/[?.!,]/g, ' ').replace(/\s+/g, ' ').trim();

/** One side of the comparison -> {kind, key, label} or null. */
function classifySide(phrase) {
  const p = clean(phrase);
  if (!p) return null;
  const firstBrand = BRANDS.find((b) => new RegExp(`^${b}(?:\\s+(?:units?|systems?|equipment))?$`).test(p));
  if (firstBrand) return { kind: 'brand', key: firstBrand, label: firstBrand[0].toUpperCase() + firstBrand.slice(1) };
  const noDocWord = p.replace(/\s+(?:documents?|docs?)$/, '');
  const dt = docTypeFromWord(noDocWord) ?? docTypeFromWord(noDocWord.replace(/s$/, ''));
  if (dt) return { kind: 'doctype', key: dt, label: documentTypeLabel(dt) };
  const pc = p.replace(/\s+customers?$/, '');
  if (CITY_SET.has(pc)) return { kind: 'city', key: pc, label: pc.replace(/\b\w/g, (c) => c.toUpperCase()) };
  if (ENTITY_WORDS[p]) return { kind: 'entity', key: ENTITY_WORDS[p], label: ENTITY_WORDS[p] === 'equipment' ? 'Units' : ENTITY_WORDS[p][0].toUpperCase() + ENTITY_WORDS[p].slice(1) };
  return null;
}

const SHAPES = [
  /\b(?:more|fewer|less|greater)\s+([a-z][a-z /&-]{1,40}?)\s+(?:or|vs\.?|versus)\s+(?:more\s+|fewer\s+|less\s+)?([a-z][a-z /&-]{1,40}?)(?:\s+(?:on file|in our records|in the system|do we have|are there|we have)\b.*)?\s*\??$/,
  /\bwhich\s+(?:do we have|have we got|is there|are there)\s+(?:more|fewer|less)\s+(?:of\s*)?,?\s*([a-z][a-z /&-]{1,40}?)\s+(?:or|vs\.?|versus)\s+([a-z][a-z /&-]{1,40}?)\s*\??$/,
  /\b(?:compare|comparison of)\s+([a-z][a-z /&-]{1,40}?)\s+(?:and|to|with|vs\.?|versus)\s+([a-z][a-z /&-]{1,40}?)\s*\??$/,
  /^\s*([a-z][a-z /&-]{1,40}?)\s+(?:vs\.?|versus)\s+([a-z][a-z /&-]{1,40}?)\s*\??$/,
];

/**
 * Pure: question -> {kind, a, b, direction} or null. `direction` is 'fewer' when the question asks which is smaller.
 * Both sides must classify to the SAME kind, else null (the agent takes it).
 */
export function parseComparison(question) {
  const q = String(question ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!q || !/\b(?:more|fewer|less|greater|compare|comparison|vs\.?|versus)\b/.test(q) || !/\b(?:or|vs\.?|versus|and|to|with)\b/.test(q)) return null;
  for (const re of SHAPES) {
    const m = re.exec(q);
    if (!m) continue;
    const a = classifySide(m[1]);
    const b = classifySide(m[2]);
    if (a && b && a.kind === b.kind && a.key !== b.key) {
      return { kind: a.kind, a, b, direction: /\b(?:fewer|less)\b/.test(q) ? 'fewer' : 'more' };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ answer (pure) */

const plural = (label, n) => {
  const l = String(label).toLowerCase();
  if (n === 1) return l;
  if (/s$|equipment$/.test(l)) return l;
  return l.endsWith('y') && !/[aeiou]y$/.test(l) ? `${l.slice(0, -1)}ies` : `${l}s`;
};

/**
 * @param {{kind, a, b, direction}} intent
 * @param {{a: number, b: number, breakdown?: Array<{label: string, count: number}>, records?: object[]}} counts
 */
export function buildComparisonAnswer(intent, counts) {
  const { a, b } = intent;
  const na = counts.a;
  const nb = counts.b;
  const nounA = intent.kind === 'city' ? `customers in ${a.label}` : intent.kind === 'brand' ? `${a.label} units` : plural(a.label, na);
  const nounB = intent.kind === 'city' ? `customers in ${b.label}` : intent.kind === 'brand' ? `${b.label} units` : plural(b.label, nb);
  const winner = na === nb ? null : (na > nb) === (intent.direction !== 'fewer') ? a : b;
  let head;
  if (na === nb) head = `They're equal: ${na} ${nounA} and ${nb} ${nounB}.`;
  else if (intent.direction === 'fewer') head = `Fewer ${winner === a ? nounA : nounB}: ${na} ${nounA} vs ${nb} ${nounB}.`;
  else head = `More ${winner === a ? nounA : nounB}: ${na} ${nounA} vs ${nb} ${nounB}.`;
  const facts = [
    { label: a.label, value: String(na), sources: [] },
    { label: b.label, value: String(nb), sources: [] },
  ];
  let text = head;
  if (intent.kind === 'doctype' && counts.breakdown?.length) {
    const others = counts.breakdown.filter((r) => r.id !== a.key && r.id !== b.key);
    for (const r of others) facts.push({ label: r.label, value: String(r.count), sources: [] });
    const total = counts.breakdown.reduce((s, r) => s + r.count, 0);
    text += ` Full breakdown of the ${total} documents on file by type is listed below.`;
  }
  return attachCitations(answerEnvelope({ text, facts, extra: { comparison: true } }), comparisonCitations(intent, counts)); // TEAM C
}

/* ------------------------------------------------------------------ db */

/** canonical type id for a stored (possibly legacy / underscored) document_type. */
const CANON = new Map();
for (const t of DOCUMENT_TYPES) for (const alias of docTypeAliases(t.id)) CANON.set(alias, t.id);
const canonicalType = (raw) => CANON.get(normalizeTypeId(raw)) ?? normalizeTypeId(raw);

export async function runComparison(db, intent) {
  if (intent.kind === 'doctype') {
    const { rows } = await db.raw(
      `SELECT ${typeSql('document_type')} AS t, count(*)::int AS n FROM documents WHERE ${TENANT_SQL} GROUP BY 1`, []);
    const byId = new Map();
    for (const r of rows) byId.set(canonicalType(r.t), (byId.get(canonicalType(r.t)) ?? 0) + Number(r.n));
    const breakdown = [...byId.entries()].map(([id, count]) => ({ id, label: documentTypeLabel(id), count }))
      .sort((x, y) => y.count - x.count || x.label.localeCompare(y.label));
    // TEAM C: list the documents of BOTH sides (newest first, capped), grouped by side.
    const side = async (s) => (await db.raw(
      `SELECT id, document_type, original_filename, created_at FROM documents
        WHERE ${typeSql('document_type')} = ANY($1::text[]) AND ${TENANT_SQL} ORDER BY created_at DESC LIMIT 200`, [docTypeAliases(s.key)])).rows
      .map((r) => documentRecord(r, { label: `${s.label} · ${r.original_filename ?? r.id}`, sublabel: `uploaded ${String(r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at ?? '').slice(0, 10)}`, group: s.label }));
    const records = [...(await side(intent.a)), ...(await side(intent.b))];
    return buildComparisonAnswer(intent, { a: byId.get(intent.a.key) ?? 0, b: byId.get(intent.b.key) ?? 0, breakdown, records });
  }
  if (intent.kind === 'brand') {
    const { rows } = await db.raw(
      `SELECT id, customer_id, data->>'manufacturer' AS m, data->>'model' AS model, data->>'equipment_type' AS et FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT_SQL} LIMIT 20000`, []);
    const count = (k) => rows.filter((r) => brandMatches(r.m, k)).length;
    const of = (s) => rows.filter((r) => brandMatches(r.m, s.key)).map((r) => unitRecord({ id: r.id, manufacturer: r.m, equipment_type: r.et, model: r.model, customer_id: r.customer_id }, { group: s.label }));
    return buildComparisonAnswer(intent, { a: count(intent.a.key), b: count(intent.b.key), records: [...of(intent.a), ...of(intent.b)] });
  }
  if (intent.kind === 'city') {
    const { rows } = await db.raw(
      `SELECT id, data->>'customer_name' AS name, data->>'service_address' AS a FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL} LIMIT 20000`, []);
    const inCity = (k) => rows.filter((r) => String(deriveGeo(r.a).city ?? '').toLowerCase() === k);
    const count = (k) => inCity(k).length;
    const of = (s) => inCity(s.key.toLowerCase()).map((r) => customerRecord({ id: r.id, customer_name: r.name, service_address: r.a }, { group: s.label }));
    return buildComparisonAnswer(intent, { a: count(intent.a.key), b: count(intent.b.key), records: [...of(intent.a), ...of(intent.b)] });
  }
  if (intent.kind === 'entity') {
    const q = {
      customers: `SELECT count(*)::int AS n FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL}`,
      equipment: `SELECT count(*)::int AS n FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT_SQL}`,
      documents: `SELECT count(*)::int AS n FROM documents WHERE ${TENANT_SQL}`,
    };
    const [ra, rb] = await Promise.all([db.raw(q[intent.a.key], []), db.raw(q[intent.b.key], [])]);
    // TEAM C: a sample of each side (records are capped at 200 per answer; recordsTotal carries the true counts).
    const list = {
      customers: `SELECT id, data->>'customer_name' AS name, data->>'service_address' AS addr FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL} ORDER BY created_at DESC LIMIT 100`,
      equipment: `SELECT id, customer_id, data->>'manufacturer' AS m, data->>'model' AS model, data->>'equipment_type' AS et FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT_SQL} ORDER BY created_at DESC LIMIT 100`,
      documents: `SELECT id, document_type, original_filename FROM documents WHERE ${TENANT_SQL} ORDER BY created_at DESC LIMIT 100`,
    };
    const asRecord = (k, s) => (r) => (k === 'customers' ? customerRecord({ id: r.id, customer_name: r.name, service_address: r.addr }, { group: s.label })
      : k === 'equipment' ? unitRecord({ id: r.id, manufacturer: r.m, equipment_type: r.et, model: r.model, customer_id: r.customer_id }, { group: s.label })
        : documentRecord(r, { group: s.label }));
    const [la, lb] = await Promise.all([db.raw(list[intent.a.key], []), db.raw(list[intent.b.key], [])]);
    return buildComparisonAnswer(intent, {
      a: Number(ra.rows[0]?.n ?? 0), b: Number(rb.rows[0]?.n ?? 0),
      records: [...la.rows.map(asRecord(intent.a.key, intent.a)), ...lb.rows.map(asRecord(intent.b.key, intent.b))],
    });
  }
  return null;
}
