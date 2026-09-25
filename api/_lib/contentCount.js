/**
 * Full-corpus content-count questions (Team E, 2026-09-24): "how many jobs mention a capacitor",
 * "which customers had a coil issue or repair on file", "list jobs where we replaced the compressor",
 * "any complaints about noise". R3 scorecard: search_documents (the agent's own tool) only ever
 * returns its top ~10 passages, so a question that needs to scan EVERY page of the tenant's own
 * corpus was silently undercounting ("how many jobs mention a capacitor" -> 11, oracle 15; "...a
 * refrigerant" -> 39, oracle 103) or missing customers entirely (a "coil issue" search found 5 of the
 * 23 real customers). Both root causes fixed here:
 *   1. a deterministic, no-model-call SQL scan of document_pages.text for every matching page (not a
 *      top-K search), reused both as a pre-router fast path (api/ask.js, block 0.63) and as the
 *      agent's own `count_documents_mentioning` tool (api/_lib/agent/tools.js) for phrasing this
 *      file's own parser does not recognize;
 *   2. an HVAC synonym/morphology map, so "capacitor" also finds "cap"/"dual run cap", "leak" also
 *      finds "leaking", etc. — a term is expanded to its WHOLE group before the corpus is scanned.
 *
 * "jobs" (a completed service call) vs "documents" (everything on file) reuses scope.js's own
 * isVisitType, the same visit/non-visit split maintenanceDue.js and the fast-path date-basis logic
 * already use — never a second, disagreeing definition of "job" in this codebase.
 *
 * pure: expandTerms, buildTermPattern, extractKnownTerms, parseContentCountQuestion, findMatches
 * db:   runContentCount
 */
import { isVisitType } from './scope.js';
import { documentTypeLabel } from './documentTypes.js';
import { attachCitations, customerRecord, documentRecord } from './citations/records.js';

const TENANT_SQL = "tenant_id = (current_setting('app.tenant_id', true))::uuid";

/* ------------------------------------------------------------------ HVAC vocabulary */

/**
 * canonical term -> every word/phrase that counts as a mention of it. The canonical key is always
 * included in its own list. Exported so scripts/verify-content.mjs can exercise expansion directly.
 */
export const HVAC_TERM_SYNONYMS = {
  capacitor: ['capacitor', 'capacitors', 'cap', 'caps', 'dual run cap', 'dual-run cap', 'run capacitor', 'start capacitor'],
  refrigerant: ['refrigerant', 'r-410a', 'r410a', 'r-22', 'r22', 'freon', 'charge', 'recharge', 'refrigerant charge', 'low charge', 'low on refrigerant'],
  // Bare "condenser" is its own component (the outdoor unit), never counted as a coil mention on its own - only the
  // compound phrase "condenser coil" is. Bare "evaporator" IS counted (it almost always refers to the evap coil in
  // dispatcher shorthand, and the task's own domain list names it as its own synonym, not only as a compound).
  coil: ['coil', 'coils', 'evap coil', 'evaporator coil', 'evaporator', 'condenser coil'],
  compressor: ['compressor', 'compressors'],
  contactor: ['contactor', 'contactors'],
  'blower motor': ['blower motor', 'blower', 'blower wheel', 'fan motor', 'fan wheel'],
  thermostat: ['thermostat', 'thermostats', 'tstat'],
  filter: ['filter', 'filters', 'air filter'],
  leak: ['leak', 'leaks', 'leaking', 'leaky'],
  noise: ['noise', 'noisy', 'loud', 'rattle', 'rattling', 'rattles', 'squeal', 'squealing', 'buzzing', 'humming', 'grinding', 'banging'],
};

const TERM_TO_GROUP = new Map();
for (const [group, words] of Object.entries(HVAC_TERM_SYNONYMS)) {
  for (const w of words) TERM_TO_GROUP.set(w.toLowerCase(), group);
}

/** Any recognized variant word/phrase -> its canonical HVAC_TERM_SYNONYMS group key; an unrecognized word passes
 *  through unchanged (expandTerms then falls back to treating it as a literal, single-word term). Used by the
 *  agent tool (tools.js), whose caller (the model) may pass a plural/variant spelling rather than the exact key. */
export function canonicalizeTerm(word) {
  const w = String(word ?? '').trim().toLowerCase();
  return TERM_TO_GROUP.get(w) ?? w;
}

/** canonical group key(s) -> every variant word/phrase, deduplicated. */
export function expandTerms(canonicalKeys) {
  const out = new Set();
  for (const key of canonicalKeys ?? []) {
    const group = HVAC_TERM_SYNONYMS[String(key ?? '').toLowerCase()];
    if (group) for (const w of group) out.add(w.toLowerCase());
    else out.add(String(key ?? '').toLowerCase());
  }
  return [...out].filter(Boolean);
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A single case-insensitive, word-boundary Postgres (ARE) regex matching any of `variants`. */
export function buildTermPattern(variants) {
  const escaped = [...variants].sort((a, b) => b.length - a.length).map(escapeRegex);
  return `\\y(${escaped.join('|')})\\y`;
}

/** The same pattern, as a JS RegExp (global, case-insensitive) — used client-side to build excerpts. */
function buildJsTermRegex(variants) {
  const escaped = [...variants].sort((a, b) => b.length - a.length).map(escapeRegex);
  return new RegExp(`\\b(?:${escaped.join('|')})\\b`, 'gi');
}

/** Every HVAC_TERM_SYNONYMS canonical key whose group has a word/phrase appearing (whole word/phrase) in `q`. */
export function extractKnownTerms(q) {
  const lower = String(q ?? '').toLowerCase();
  const found = [];
  for (const group of Object.keys(HVAC_TERM_SYNONYMS)) {
    const variants = HVAC_TERM_SYNONYMS[group];
    const re = buildJsTermRegex(variants);
    if (re.test(lower)) found.push(group);
  }
  return found;
}

/* ------------------------------------------------------------------ question shape */

const HOW_MANY_SCOPE_RE = /\bhow\s+many\s+(jobs?|documents?)\b/i;
const MENTION_RE = /\bmentions?\b/i;
const CUSTOMERS_HAD_RE = /\bwhich\s+customers?\b/i;
const ISSUE_WORD_RE = /\b(?:issues?|repairs?|problems?|complaints?)\b/i;
const LIST_JOBS_RE = /\b(?:list|which|show(?:\s+me)?|give\s+me)\b.*\bjobs?\b.*\b(?:where|that|which)\b/i;
const REPLACED_WORD_RE = /\b(?:replaced|repaired|fixed|installed|swapped|changed|serviced)\b/i;
const COMPLAINTS_ABOUT_RE = /\bcomplaints?\s+about\b/i;
const JOB_WORD_RE = /\bjobs?\b/i;
const DOCUMENT_WORD_RE = /\bdocuments?\b/i;

/**
 * Pure: question -> {terms, scope, groupBy, mode, question} or null. Deliberately narrow: needs BOTH an anchor phrase
 * ("mention", "issue/repair/complaint", "complaints about", or "jobs ... where ... replaced") AND at least one
 * recognized HVAC term (extractKnownTerms) — a question with neither is left alone (never hijacks an unrelated
 * aggregate/financials question, which has no HVAC term to match anyway).
 */
export function parseContentCountQuestion(question) {
  const q = String(question ?? '').trim();
  if (!q) return null;
  const lower = q.toLowerCase();

  const hasMention = MENTION_RE.test(lower);
  const hasIssue = ISSUE_WORD_RE.test(lower);
  const hasComplaintsAbout = COMPLAINTS_ABOUT_RE.test(lower);
  const hasListJobsWhere = LIST_JOBS_RE.test(lower) && REPLACED_WORD_RE.test(lower);
  if (!hasMention && !hasIssue && !hasComplaintsAbout && !hasListJobsWhere) return null;

  const terms = extractKnownTerms(lower);
  if (!terms.length) return null;

  const scopeMatch = HOW_MANY_SCOPE_RE.exec(lower);
  const scope = scopeMatch
    ? (/^job/.test(scopeMatch[1]) ? 'jobs' : 'documents')
    : (JOB_WORD_RE.test(lower) && !DOCUMENT_WORD_RE.test(lower) ? 'jobs' : 'documents');
  const groupBy = CUSTOMERS_HAD_RE.test(lower) ? 'customer' : null;
  const mode = /^\s*how\s+many\b/.test(lower) ? 'count' : 'list';
  return { terms, scope, groupBy, mode, question: q };
}

/* ------------------------------------------------------------------ db */

/** {documentId -> [{id: customerId, name, address}]} for the given document ids, via a direct link or an equipment's owner. */
async function customersForDocuments(db, docIds) {
  const map = new Map();
  if (!docIds.length) return map;
  const { rows } = await db.raw(
    `WITH linked AS (
       SELECT l.document_id, CASE WHEN e.entity_type = 'customer' THEN e.id ELSE e.customer_id END AS customer_id
         FROM document_entity_links l JOIN entities e ON e.id = l.entity_id AND e.merged_into IS NULL AND e.${TENANT_SQL}
        WHERE l.document_id = ANY($1::uuid[]) AND l.${TENANT_SQL}
       UNION
       SELECT x.document_id, CASE WHEN e.entity_type = 'customer' THEN e.id ELSE e.customer_id END AS customer_id
         FROM extractions x JOIN entities e ON e.id = x.entity_id AND e.merged_into IS NULL AND e.${TENANT_SQL}
        WHERE x.document_id = ANY($1::uuid[]) AND x.entity_id IS NOT NULL AND x.${TENANT_SQL}
     )
     SELECT DISTINCT linked.document_id, c.id AS customer_id, c.data->>'customer_name' AS customer_name,
            c.data->>'service_address' AS service_address
       FROM linked JOIN entities c ON c.id = linked.customer_id AND c.merged_into IS NULL AND c.${TENANT_SQL}
      WHERE linked.customer_id IS NOT NULL`,
    [docIds]
  );
  for (const r of rows) {
    if (!map.has(r.document_id)) map.set(r.document_id, []);
    map.get(r.document_id).push({ id: r.customer_id, name: r.customer_name, address: r.service_address });
  }
  return map;
}

/** One matched page -> {matched: [terms], excerpt}. Never throws; a page with no JS-side match (should not
 *  happen — the SQL WHERE already required one) degrades to a plain excerpt from the start of the text. */
function excerptFor(text, jsRe) {
  jsRe.lastIndex = 0;
  const m = jsRe.exec(String(text ?? ''));
  if (!m) return { excerpt: String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 220) };
  const start = Math.max(0, m.index - 90);
  const end = Math.min(text.length, m.index + m[0].length + 130);
  const excerpt = String(text).slice(start, end).replace(/\s+/g, ' ').trim();
  return { excerpt: (start > 0 ? '…' : '') + excerpt + (end < text.length ? '…' : '') };
}

const MAX_PAGES = 3000;
const MAX_LISTED_FACTS = 40;

/**
 * @param db a withTenant() store
 * @param parsed parseContentCountQuestion's result (or an equivalent object built by the agent tool)
 * @returns an /api/ask `data` object, or null when nothing matched at all is still answered (an honest zero) —
 *   this only returns null when `terms` is empty (a caller bug, never a real question).
 */
export async function runContentCount(db, parsed) {
  const { terms, scope, groupBy } = parsed;
  const variants = expandTerms(terms);
  if (!variants.length) return null;
  const pattern = buildTermPattern(variants);
  const jsRe = buildJsTermRegex(variants);

  // Review r3: a full-corpus regex scan gets its own 4 s statement_timeout (same idea as the agent's run_query guard),
  // inside a savepoint so a timeout never poisons the caller's tenant transaction.
  await db.raw("SAVEPOINT content_count", []);
  let pages;
  try {
    await db.raw("SET LOCAL statement_timeout = '4000'", []);
    ({ rows: pages } = await db.raw(
    `SELECT p.document_id, p.page_no, p.text, d.document_type, d.original_filename, d.created_at
       FROM document_pages p
       JOIN documents d ON d.id = p.document_id AND d.${TENANT_SQL}
      WHERE p.${TENANT_SQL} AND p.text ~* $1
      ORDER BY d.created_at DESC
      LIMIT ${MAX_PAGES}`,
    [pattern]
  ));
    await db.raw("RELEASE SAVEPOINT content_count", []);
  } catch (err) {
    await db.raw("ROLLBACK TO SAVEPOINT content_count", []).catch(() => {});
    throw err;
  }

  const jobFiltered = scope === 'jobs' ? pages.filter((p) => isVisitType(p.document_type)) : pages;

  const byDoc = new Map();
  for (const p of jobFiltered) {
    const cur = byDoc.get(p.document_id) ?? {
      documentId: p.document_id, documentType: p.document_type, filename: p.original_filename, pages: [],
    };
    cur.pages.push({ page: p.page_no, ...excerptFor(p.text, jsRe) });
    byDoc.set(p.document_id, cur);
  }
  const docIds = [...byDoc.keys()];
  const custMap = await customersForDocuments(db, docIds);
  const customersById = new Map();
  for (const list of custMap.values()) for (const c of list) if (c.id && !customersById.has(c.id)) customersById.set(c.id, c);

  const termsLabel = terms.length === 1 ? terms[0] : `${terms.slice(0, -1).join(', ')} or ${terms[terms.length - 1]}`;
  const noun = scope === 'jobs' ? 'job' : 'document';
  const nDocs = docIds.length;
  const nCust = customersById.size;
  const ruleNote = scope === 'jobs' ? ' (jobs = completed service-type documents: service tickets, work orders, invoices, inspections, dispatch notes and startup sheets — not proposals, permits or paperwork with no visit).' : '';

  /* ------------------------------------------------------------ zero */
  if (!nDocs) {
    const scannedNote = scope === 'jobs' ? 'every job on file' : 'every document on file';
    return attachCitations({
      kind: 'answer',
      text: `No ${noun}s on file mention ${termsLabel}.`,
      facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
    }, {
      records: [], total: 0, kind: 'searched',
      basis: `Scanned the text of ${scannedNote} for ${termsLabel}${ruleNote}; none mention it.`,
    });
  }

  /* ------------------------------------------------------------ grouped by customer */
  if (groupBy === 'customer') {
    const names = [...customersById.values()].map((c) => c.name || 'Unnamed customer').sort((a, b) => a.localeCompare(b));
    const shownNames = names.slice(0, 15);
    const text = `${nCust} customer${nCust === 1 ? '' : 's'} ${nCust === 1 ? 'has' : 'have'} a ${noun} on file mentioning ${termsLabel}: ${shownNames.join(', ')}${names.length > shownNames.length ? `, and ${names.length - shownNames.length} more` : ''}.`;
    const facts = [...customersById.values()].slice(0, MAX_LISTED_FACTS).map((c) => {
      const theirDocs = docIds.filter((id) => (custMap.get(id) ?? []).some((x) => x.id === c.id));
      return {
        label: c.name || 'Unnamed customer',
        value: `${theirDocs.length} ${pluralNoun(noun, theirDocs.length)} mention ${termsLabel}`,
        entityId: c.id,
        sources: theirDocs.slice(0, 5).map((id) => ({ documentId: id, location: { field: 'document' } })),
      };
    });
    const records = [
      ...[...customersById.values()].map((c) => customerRecord({ id: c.id, customer_name: c.name, service_address: c.address })),
      ...docIds.map((id) => {
        const d = byDoc.get(id);
        const cust = (custMap.get(id) ?? [])[0];
        return documentRecord({ id, document_type: d.documentType, original_filename: d.filename }, {
          label: `${documentTypeLabel(d.documentType)} · ${d.filename ?? id}`,
          sublabel: d.pages[0] ? `"${d.pages[0].excerpt}"` : undefined,
          page: d.pages[0]?.page, group: cust?.name ?? 'Unlinked',
        });
      }),
    ];
    return attachCitations({
      kind: 'answer', text, facts, sources: [], confidence: 1, verifiedCount: facts.length, unverifiedCount: 0, closest: [],
    }, {
      records, total: records.length, claimedCount: nCust,
      basis: `Counted customers with a ${noun} whose text mentions ${termsLabel}; ${nDocs} ${pluralNoun(noun, nDocs)}, ${nCust} customer${nCust === 1 ? '' : 's'}.${ruleNote}`,
    });
  }

  /* ------------------------------------------------------------ plain document/job count-or-list */
  const text = `${nDocs} ${pluralNoun(noun, nDocs)} on file mention ${termsLabel}, across ${nCust} customer${nCust === 1 ? '' : 's'}.`;
  const facts = docIds.slice(0, MAX_LISTED_FACTS).map((id) => {
    const d = byDoc.get(id);
    const cust = (custMap.get(id) ?? [])[0];
    return {
      label: `${documentTypeLabel(d.documentType)}${cust?.name ? ` · ${cust.name}` : ''}`,
      value: d.pages[0] ? `p.${d.pages[0].page}: "${d.pages[0].excerpt}"` : d.filename ?? id,
      entityId: cust?.id, sources: [{ documentId: id, location: { page: d.pages[0]?.page } }],
    };
  });
  const records = docIds.map((id) => {
    const d = byDoc.get(id);
    const cust = (custMap.get(id) ?? [])[0];
    return documentRecord({ id, document_type: d.documentType, original_filename: d.filename }, {
      label: `${documentTypeLabel(d.documentType)} · ${d.filename ?? id}`,
      sublabel: d.pages[0] ? `"${d.pages[0].excerpt}"` : undefined,
      page: d.pages[0]?.page, group: cust?.name,
    });
  });
  return attachCitations({
    kind: 'answer', text, facts, sources: [], confidence: 1, verifiedCount: facts.length, unverifiedCount: 0, closest: [],
  }, {
    records, total: records.length, claimedCount: nDocs,
    basis: `Counted ${noun}s whose text mentions ${termsLabel}; ${nDocs} ${pluralNoun(noun, nDocs)}, ${nCust} customer${nCust === 1 ? '' : 's'}.${ruleNote}`,
  });
}

function pluralNoun(noun, n) {
  return n === 1 ? noun : `${noun}s`;
}
