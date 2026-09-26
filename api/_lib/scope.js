/**
 * Shared, deterministic building blocks for Donovan's "history" style answers (Team A, 2026-09-24):
 * resolve an ADDRESS (or unit) to every customer/unit that lives there, gather the documents those records own,
 * and read their service visits with correct date semantics.
 *
 * Why this exists (scorecard failures, history 1/14): fastPath resolved "the unit at <address>" to ONE unit or gave up
 * (two units / apartments -> "ambiguous" -> retrieval -> a model answer about whatever page scored best), took the
 * newest service_date it saw INCLUDING dates in the future (a typo like 2027-11-14 became "last service"), and cited
 * one field. Everything here is pure SQL + arithmetic, no model call, tenant-scoped, parameterized.
 *
 * TIME SEMANTICS (the one rule every caller shares):
 *   - "added / uploaded / received / scanned / filed"  -> documents.created_at   (see dateBasisOf)
 *   - "serviced / visited / job / work done / installed" -> extractions.service_date / installation_date
 *   - A service_date AFTER today is never a "last" visit: it is a scheduled visit or a typo. splitFuture() separates
 *     them so the answer can mention it instead of reporting it.
 *
 * No question text or row values are ever logged here.
 */
import { significantAddressTokens, formatDateHuman } from './fastPath.js';
import { documentTypeLabel, DOCUMENT_TYPE_ALIASES } from './documentTypes.js';

export const TENANT_SQL = "tenant_id = (current_setting('app.tenant_id', true))::uuid";

/* ------------------------------------------------------------------ dates */

/** 'YYYY-MM-DD' (first 10 chars) when `v` starts with a real calendar date, else null. */
export function isoDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? '').trim());
  if (!m) return null;
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** Today as YYYY-MM-DD (falls back to the real clock when the caller passed nothing usable). */
export function todayIso(today) {
  return isoDate(today) ?? new Date().toISOString().slice(0, 10);
}

/** "Aug 2, 2017" style, via the same formatter fastPath uses ("August 2, 2017"). */
export function humanDate(v) {
  const iso = isoDate(v);
  return iso ? formatDateHuman(iso) : String(v ?? 'an unknown date');
}

/** Adds whole months to a YYYY-MM-DD date (clamps the day), returns YYYY-MM-DD. */
export function addMonths(iso, months) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  if (!m) return null;
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + Math.trunc(months);
  const y = Math.floor(total / 12);
  const mo = (total % 12) + 1;
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const day = Math.min(Number(m[3]), last);
  return `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Adds whole days to a YYYY-MM-DD date (UTC), returns YYYY-MM-DD. Round 7 (maintenanceDue.js): the scorecard
 *  oracle's own cutoff is a literal `$1::date - 365`, a day count, not a calendar-month one - addMonths(x, -12)
 *  can drift a day from that across some dates, so the flat-cadence overdue rule uses this instead. */
export function addDays(iso, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + Math.trunc(days)));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Splits dated rows into those on/before `today` and those after it. A date after today is a scheduled visit or a
 * data-entry typo; it must never be reported as the last/most recent one.
 * @param {Array<{date: string}>} rows
 */
export function splitFuture(rows, today) {
  const t = todayIso(today);
  const past = [];
  const future = [];
  for (const r of rows ?? []) {
    const d = isoDate(r?.date);
    if (!d) continue;
    (d > t ? future : past).push({ ...r, date: d });
  }
  past.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  future.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { past, future };
}

/** One sentence about dated-in-the-future records, or ''. */
export function futureNote(future, today) {
  if (!future?.length) return '';
  const t = todayIso(today);
  const first = future[0];
  const others = future.length > 1 ? ` (and ${future.length - 1} more like it)` : '';
  return ` There's also a record dated ${humanDate(first.date)}${others}, which is after today (${humanDate(t)}) — it looks like a typo or a scheduled visit, so I left it out.`;
}

/**
 * Which date a question is about, decided from its wording (never left to a model):
 *   'uploaded' -> documents.created_at ("added / uploaded / received / scanned / filed / imported ...")
 *   'service'  -> the work date (service_date / installation_date)
 *   null       -> no stated basis (callers keep their default, the service date)
 * "Uploaded" wins over "service" when both appear ("documents we uploaded for service calls").
 */
const UPLOAD_WORD_RE = /\b(?:added|add|adding|uploaded|upload|uploading|received|receive|scanned|scan|filed|imported|ingested|entered into|put into|loaded|logged into)\b/i;
const SERVICE_WORD_RE = /\b(?:serviced|service[ds]?|visited|visits?|jobs?|work(?:ed)?\s+done|installed|installs?|installation|completed|performed|ran|run|did)\b/i;
export function dateBasisOf(question) {
  const q = String(question ?? '');
  if (UPLOAD_WORD_RE.test(q)) return 'uploaded';
  if (SERVICE_WORD_RE.test(q)) return 'service';
  return null;
}

/** The phrase an answer uses to say which date it counted by. */
export function dateBasisPhrase(basis) {
  return basis === 'uploaded' ? 'by upload date' : 'by service date';
}

/* ------------------------------------------------------------- doc types */

/** Types whose service_date is NOT a visit (a contract date, a quote date, a registration date ...). */
export const NON_VISIT_TYPES = new Set([
  'maintenance-agreement', 'maintenance-plan', 'warranty-registration', 'warranty', 'proposal-quote', 'proposal', 'quote',
  'purchase-order', 'permit', 'nameplate-photo', 'nameplate', 'correspondence', 'internal',
]);

export const normalizeTypeId = (t) => String(t ?? '').trim().toLowerCase().replace(/_/g, '-');
export const isVisitType = (t) => !NON_VISIT_TYPES.has(normalizeTypeId(t));

/** Every stored spelling that means the canonical type (legacy ids, underscores). Same aliases the scorecard oracle
 *  uses — sourced from documentTypes.js (the single source of truth for this table; see its own doc comment) so
 *  this file and documentTypeLabel's own alias-canonicalization can never drift apart. */
export function docTypeAliases(id) {
  const n = normalizeTypeId(id);
  return DOCUMENT_TYPE_ALIASES[n] ?? [n];
}
/** SQL expression that normalizes a stored document_type the same way (lower-case, '_' -> '-'). */
export const typeSql = (col) => `lower(replace(${col}, '_', '-'))`;

/* -------------------------------------------------------------- addresses */

const SUFFIX_RE = '(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|way|ct|court|pl|place|cir|circle|pkwy|parkway|hwy|highway)';
const DIRECTIONAL = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', 'north', 'south', 'east', 'west']);
const ADDR_HEAD_RE = new RegExp(`(\\d{1,6})\\s+((?:[A-Za-z0-9.']+\\s+){0,4}?[A-Za-z0-9.']+?)\\s+${SUFFIX_RE}\\b`, 'i');

/** "3300 S Alma School Rd, Apt 104, Mesa" -> {house:'3300', words:['alma','school']} or null. */
export function parseStreetAddress(text) {
  const m = ADDR_HEAD_RE.exec(String(text ?? ''));
  if (m) {
    const words = m[2].toLowerCase().split(/\s+/).map((w) => w.replace(/[.']/g, '')).filter((w) => w && !DIRECTIONAL.has(w));
    if (words.length) return { house: m[1], words: words.slice(0, 3) };
  }
  // No suffix word ("3247 Elm"): the house number plus the significant tokens that follow.
  const tokens = significantAddressTokens(text);
  const house = tokens.find((t) => /^\d+$/.test(t));
  const rest = tokens.filter((t) => !/^\d+$/.test(t));
  if (house && rest.length) return { house, words: rest.slice(0, 2) };
  return null;
}

/** "Apt 104" / "Unit B" / "#12" / "Suite 200" named in the question -> "104" | "B" | "12" | "200", else null. */
export function extractUnitDesignator(text) {
  const t = String(text ?? '');
  const m = /\b(?:apt|apartment|suite|ste|unit|no|number)\.?\s*#?\s*(\d+[A-Za-z]?)\b/i.exec(t)
    ?? /\b(?:apt|apartment|suite|ste)\.?\s*#?\s*([A-Za-z])\b/i.exec(t)
    ?? /#\s*(\d+[A-Za-z]?)\b/.exec(t);
  return m ? m[1].toLowerCase() : null;
}

const escapeLike = (s) => String(s ?? '').replace(/[\\%_]/g, '\\$&');

/** Does an address string carry this unit designator ("... Apt 104, Mesa")? */
export function addressHasUnit(address, unit) {
  if (!unit) return true;
  const re = new RegExp(`(?:apt|apartment|suite|ste|unit|#)\\.?\\s*#?\\s*${unit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  return re.test(String(address ?? ''));
}

/**
 * Everything on file at one street address: the customers and units, plus every document that names them or
 * carries that service_address. `unit` (from extractUnitDesignator) narrows an apartment complex to one door when the
 * stored addresses carry the designator; when none do, the whole address is returned with `unitNarrowed: false`.
 * @returns {Promise<{customers: object[], equipment: object[], entityIds: string[], addressPatterns: string[], unitNarrowed: boolean}>}
 */
export async function resolveAddressScope(db, addressText, { unit = null, limit = 60 } = {}) {
  const parsed = parseStreetAddress(addressText);
  const empty = { customers: [], equipment: [], entityIds: [], addressPatterns: [], unitNarrowed: false };
  if (!parsed) return empty;
  const patterns = [`${escapeLike(parsed.house)} %`, ...parsed.words.map((w) => `%${escapeLike(w)}%`)];

  const { rows } = await db.raw(
    `SELECT id, entity_type, customer_id, customer_number, data->>'customer_name' AS customer_name,
            data->>'service_address' AS service_address, data
       FROM entities
      WHERE merged_into IS NULL AND ${TENANT_SQL} AND entity_type IN ('customer', 'equipment')
        AND data->>'service_address' ILIKE ALL($1::text[])
      LIMIT ${Math.max(1, Math.min(200, limit))}`,
    [patterns]
  );
  let customers = rows.filter((r) => r.entity_type === 'customer');
  let equipment = rows.filter((r) => r.entity_type === 'equipment');

  // Units with no address of their own hang off a matched customer; customers of a matched unit join the scope.
  const custIds = customers.map((c) => c.id);
  if (custIds.length) {
    const { rows: more } = await db.raw(
      `SELECT id, entity_type, customer_id, data->>'service_address' AS service_address, data
         FROM entities
        WHERE entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT_SQL} AND customer_id = ANY($1::uuid[])`,
      [custIds]
    );
    const seen = new Set(equipment.map((e) => e.id));
    for (const e of more) if (!seen.has(e.id)) equipment.push(e);
  }
  const missingCust = [...new Set(equipment.map((e) => e.customer_id).filter((id) => id && !custIds.includes(id)))];
  if (missingCust.length) {
    const { rows: more } = await db.raw(
      `SELECT id, entity_type, customer_id, customer_number, data->>'customer_name' AS customer_name,
              data->>'service_address' AS service_address, data
         FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL} AND id = ANY($1::uuid[])`,
      [missingCust]
    );
    customers = customers.concat(more);
  }

  let unitNarrowed = false;
  if (unit) {
    const custHit = new Set(customers.filter((c) => addressHasUnit(c.service_address, unit)).map((c) => c.id));
    const equipHit = equipment.filter((e) => addressHasUnit(e.service_address, unit) || custHit.has(e.customer_id));
    for (const e of equipHit) if (e.customer_id) custHit.add(e.customer_id);
    if (custHit.size || equipHit.length) {
      customers = customers.filter((c) => custHit.has(c.id));
      equipment = equipHit;
      unitNarrowed = true;
    }
  }
  const entityIds = [...new Set([...customers.map((c) => c.id), ...equipment.map((e) => e.id)])];
  return { customers, equipment, entityIds, addressPatterns: patterns, unitNarrowed };
}

/** Scope for already-resolved customer rows (name lookups): their units and every id worth searching documents by. */
export async function scopeFromCustomers(db, customerRows) {
  const customers = (customerRows ?? []).filter(Boolean);
  const ids = customers.map((c) => c.id);
  let equipment = [];
  if (ids.length) {
    const { rows } = await db.raw(
      `SELECT id, entity_type, customer_id, data->>'service_address' AS service_address, data
         FROM entities
        WHERE entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT_SQL} AND customer_id = ANY($1::uuid[])`,
      [ids]
    );
    equipment = rows;
  }
  return { customers, equipment, entityIds: [...ids, ...equipment.map((e) => e.id)], addressPatterns: [], unitNarrowed: false };
}

/**
 * Every document id reachable from a scope: direct links, unit links, the primary-unit extraction link, and
 * (address scopes) any document whose extracted service_address matches the address. Deduped.
 */
export async function scopeDocumentIds(db, scope) {
  const ids = new Set();
  if (scope.entityIds?.length) {
    const { rows } = await db.raw(
      `SELECT document_id FROM document_entity_links WHERE entity_id = ANY($1::uuid[]) AND ${TENANT_SQL}
       UNION
       SELECT document_id FROM extractions WHERE entity_id = ANY($1::uuid[]) AND ${TENANT_SQL}`,
      [scope.entityIds]
    );
    for (const r of rows) ids.add(r.document_id);
  }
  if (scope.addressPatterns?.length && !scope.unitNarrowed) {
    const { rows } = await db.raw(
      `SELECT document_id FROM extractions
        WHERE field_key = 'service_address' AND value ILIKE ALL($1::text[]) AND ${TENANT_SQL}
        LIMIT 500`,
      [scope.addressPatterns]
    );
    for (const r of rows) ids.add(r.document_id);
  }
  return [...ids];
}

/* ----------------------------------------------------------------- visits */

/**
 * Service visits among `documentIds`: one row per (document, service_date) that is a visit-type document.
 * `corrected_value` (a human's fix) wins over the extracted value, like the agent views do.
 * @returns {Promise<Array<{documentId, date, documentType, filename, technician, serviceType, customerName, createdAt}>>}
 */
export async function fetchVisits(db, documentIds) {
  const ids = [...new Set(documentIds ?? [])];
  if (!ids.length) return [];
  const { rows } = await db.raw(
    `SELECT x.document_id, COALESCE(NULLIF(x.corrected_value, ''), x.value) AS service_date,
            d.document_type, d.original_filename, d.created_at,
            (SELECT COALESCE(NULLIF(t.corrected_value, ''), t.value) FROM extractions t
              WHERE t.document_id = x.document_id AND t.field_key = 'technician' AND t.${TENANT_SQL}
              ORDER BY t.created_at DESC LIMIT 1) AS technician,
            (SELECT COALESCE(NULLIF(s.corrected_value, ''), s.value) FROM extractions s
              WHERE s.document_id = x.document_id AND s.field_key = 'service_type' AND s.${TENANT_SQL}
              ORDER BY s.created_at DESC LIMIT 1) AS service_type,
            (SELECT c.data->>'customer_name'
               FROM document_entity_links l
               JOIN entities en ON en.id = l.entity_id AND en.merged_into IS NULL AND en.${TENANT_SQL}
               JOIN entities c ON c.id = CASE WHEN en.entity_type = 'customer' THEN en.id ELSE en.customer_id END
                                AND c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL}
              WHERE l.document_id = x.document_id AND l.${TENANT_SQL}
              ORDER BY l.created_at DESC LIMIT 1) AS customer_name
       FROM extractions x JOIN documents d ON d.id = x.document_id
      WHERE x.field_key = 'service_date' AND x.document_id = ANY($1::uuid[]) AND x.${TENANT_SQL}
      LIMIT 2000`,
    [ids]
  );
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const date = isoDate(r.service_date);
    if (!date || !isVisitType(r.document_type)) continue;
    const key = `${r.document_id}|${date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      documentId: r.document_id, date, documentType: r.document_type, filename: r.original_filename ?? null,
      technician: r.technician ?? null, serviceType: r.service_type ?? null, customerName: r.customer_name ?? null,
      createdAt: r.created_at ?? null,
    });
  }
  return out;
}

/** Short description of one visit for answer text: "service ticket, tech D. Ramirez". */
export function describeVisit(v) {
  const type = documentTypeLabel(normalizeTypeId(v.documentType)).toLowerCase();
  const tech = v.technician ? `, tech ${v.technician}` : '';
  return `${type}${tech}`;
}

/** Fact for one visit, cited to its document. */
export function visitFact(v, label = 'Visit') {
  return {
    label,
    value: `${humanDate(v.date)} · ${describeVisit(v)}${v.customerName ? ` · ${v.customerName}` : ''}`,
    sources: [{ documentId: v.documentId, location: { field: 'service_date' } }],
  };
}

/** Standard answer envelope (same shape every deterministic route in this codebase returns). */
export function answerEnvelope({ text, facts = [], sources = [], extra = {} }) {
  const allSources = sources.length
    ? sources
    : [...new Map(facts.flatMap((f) => f.sources ?? []).map((s) => [s.documentId, s])).values()];
  return {
    kind: 'answer', text, facts, sources: allSources, confidence: 1,
    verifiedCount: facts.filter((f) => f.sources?.length).length, unverifiedCount: 0, closest: [], ...extra,
  };
}

/** Label for a scope in answer text: the address as typed (trimmed), or the customer's name. */
export function scopeLabel({ addressText, customers }) {
  if (addressText) return String(addressText).replace(/\s+/g, ' ').trim();
  const names = [...new Set((customers ?? []).map((c) => c.customer_name).filter(Boolean))];
  return names.length ? names.slice(0, 2).join(' / ') : 'that customer';
}
