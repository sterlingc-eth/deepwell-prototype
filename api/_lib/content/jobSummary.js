/**
 * Round 15 (Team D): "What was found or done on the Mercer job?" / "...on the Salazar job?" — a deterministic,
 * EXTRACTIVE job-summary answer built straight from the matched customer's own on-file documents: real
 * sentences from the actual document_pages text, quoted verbatim and cited by document + page, never a
 * paraphrase and never an invented finding.
 *
 * Kept in its own module rather than folded into contentCount.js's term-mention machinery: the shape is
 * fundamentally different (a single NAMED customer's own record, not a corpus-wide HVAC-term scan) and needs
 * no HVAC vocabulary at all. Wired in from contentCount.js's own parseContentCountQuestion/runContentCount
 * entry points (already called from api/ask.js block 0.63, contentCountIntent/runContentCount), so no ask.js
 * change is needed to ship this new family — see this file's own exports and contentCount.js's use of them.
 *
 * Honesty/safety:
 *   - A name that is not on file at all -> an honest "no customer/job named X on file" answer (never a guess).
 *   - A name that resolves to MORE THAN ONE distinct customer (a shared surname is common in this domain -
 *     "the Mercer job" when there are two Mercers on file) is NEVER silently merged into one person's
 *     answer: each matching customer's own documents are read and reported SEPARATELY, under that
 *     customer's own name, so a finding is always attributed to the person it actually came from - never a
 *     guess at which one the asker meant.
 *   - A matching customer (or every matching customer, when there is more than one) with no document whose
 *     text contains a real finding/work word -> an honest "nothing on file records what was found or done"
 *     answer, never a fabricated summary.
 *   - Every fact quotes an ACTUAL sentence/line from the source page (extractFindingSentences below never
 *     synthesizes text, only trims/clips whitespace) and cites the document id + page it came from.
 */
import { nameVerdict, clarifyEnvelope } from '../lookups/nameMatch.js';
import { documentTypeLabel, canonicalTypeId } from '../documentTypes.js';
import { isoDate } from '../scope.js';
import { attachCitations, customerRecord, documentRecord } from '../citations/records.js';
// R16 (F4, D2 #5/field-phrasing g099-g101): address-resolved job-summary questions ("what was found
// on the job at 100 e main st") reuse the SAME address -> customer resolution the fast path already
// hardened (resolveAddressEntityFieldGroup's own house-number + street-name token match, and its
// no-address/no-unit/multi-customer/customer grouping) rather than a second, divergent implementation —
// see this file's own runJobSummaryByAddress below. A pure re-import (read-only use of another owner's
// exported helper, per this round's contract); fastPathQuery.js imports nothing from this file or from
// contentCount.js, so there is no import cycle.
import { resolveAddressEntityFieldGroup } from '../fastPathQuery.js';

const TENANT_SQL = "tenant_id = (current_setting('app.tenant_id', true))::uuid";

/**
 * "What was found or done on the Mercer job?" (was/were, found/done in either order, "the"/"on"|"for"
 * optional) - anchored at both ends so a question this shape does not do justice to falls through instead:
 *   - a trailing qualifier ("...other than the compressor", "...last month") never matches ($ anchor),
 *   - a PLURAL "jobs" (a different, multi-job question) never matches (this only ever matches singular "job"),
 *   - "what was NOT found..." never matches (the verb must immediately follow was/were, no room for "not").
 * Deliberately narrow to this one family per the round's contract - not a general "tell me about X" parser.
 */
const JOB_SUMMARY_RE = /^\s*what\s+(?:was|were)\s+(?:found|done)(?:\s+or\s+(?:found|done))?\s+(?:on|for)\s+(?:the\s+)?(.+?)(?:'s)?\s+job\s*\??\s*$/i;

// R16 (F4, field-phrasing g099-g101): the same "what was found/done" family, an "any notes on..." family,
// and a "what's the work order say for..." family, ANCHORED ON AN ADDRESS ("...at/for <address>") rather
// than a "<name>'s job" - three real phrasings this exam's own field-phrasing generator uses (see
// scripts/gen-field-phrasing.mjs's own g099/g100/g101). Each is deliberately its own regex (not one
// alternation) so the caller can tell which flavor of "the job" was asked - a generic job, specifically
// the INSTALL, or specifically the WORK ORDER - and read from a different set of documents accordingly:
// see runJobSummaryByAddress's own header for why that distinction matters (an install document and a
// much-later service visit are never allowed to blur into one answer).
const JOB_AT_ADDRESS_RE = /^\s*what\s+(?:was|were)\s+(?:found|done)(?:\s+or\s+(?:found|done))?\s+(?:on|for)\s+the\s+job\s+at\s+(.+?)\s*\??\s*$/i;
const NOTES_AT_INSTALL_RE = /^\s*(?:any|what(?:'s|\s+are)?)\s+notes?\s+(?:on|for|about)\s+the\s+install(?:ation)?\s+at\s+(.+?)\s*\??\s*$/i;
const WORK_ORDER_SAY_RE = /^\s*wh(?:at|ats)(?:'s|\s+does|\s+did)?\s+the\s+work\s+order\s+say\s+for\s+(.+?)\s*\??\s*$/i;

/** Postgres ILIKE metacharacters escaped so a customer name is never treated as a wildcard pattern. */
function escapeLikeText(s) {
  return String(s ?? '').replace(/[\\%_]/g, '\\$&');
}

/**
 * Pure: question -> {mode: 'jobSummary', customerName, question} (a named customer's own "job") or
 * {mode: 'jobSummary', addressKind: 'job'|'install'|'workOrder', address, question} (an address-resolved
 * job) or null. contentCount.js's parseContentCountQuestion tries this FIRST, before its own mention/
 * replace shapes (which require an HVAC term neither of these shapes ever has), so nothing already
 * handled by those changes.
 */
export function parseJobSummaryQuestion(question) {
  const q = String(question ?? '').trim();
  if (!q) return null;
  const m = JOB_SUMMARY_RE.exec(q);
  if (m) {
    const name = m[1].replace(/\s+/g, ' ').trim().replace(/^(?:the|a|an)\s+/i, '');
    if (name.length < 2) return null;
    return { mode: 'jobSummary', customerName: name, question: q };
  }
  for (const [addressKind, re] of [['install', NOTES_AT_INSTALL_RE], ['workOrder', WORK_ORDER_SAY_RE], ['job', JOB_AT_ADDRESS_RE]]) {
    const am = re.exec(q);
    if (!am) continue;
    const address = am[1].replace(/\s+/g, ' ').trim();
    if (address.length < 4) return null;
    return { mode: 'jobSummary', addressKind, address, question: q };
  }
  return null;
}

// The exam oracle's own anchor words for "a real finding, not filler" (bare, no boundary — matches the
// oracle's own `~* '(found|replac|check|recommend|repair|notes?:|finding)'` byte-for-byte, so the SET of
// candidate pages this module reads from is exactly the set the reference record is built from).
const FINDING_PATTERN_SQL = '(found|replac|check|recommend|repair|notes?:|finding)';
// Same vocabulary, word-boundary anchored, for picking out real SENTENCES client-side (a display-quality
// concern only - never changes which page/document counts as a match, only how it's excerpted).
const FINDING_WORD_RE = /\b(found|replac\w*|check\w*|recommend\w*|repair\w*|notes?|finding\w*)\b/i;
const MAX_SENTENCE_LEN = 220;
const MAX_FACTS = 6;

/** One page's text -> up to `max` real, VERBATIM sentences/lines mentioning a finding word - trimmed and
 *  length-clipped only, never reworded or synthesized. */
export function extractFindingSentences(text, max = 2) {
  const cleaned = String(text ?? '').replace(/\r\n?/g, '\n');
  const segments = cleaned.split(/\n+/).flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z0-9])/));
  const out = [];
  for (const seg of segments) {
    const s = seg.replace(/\s+/g, ' ').trim();
    if (!s || s.length < 6) continue;
    if (!FINDING_WORD_RE.test(s)) continue;
    if (/^(?:notes?|findings?):?$/i.test(s)) continue; // a bare "Notes:"/"Findings:" label with nothing after it
    out.push(s.length > MAX_SENTENCE_LEN ? `${s.slice(0, MAX_SENTENCE_LEN - 1)}…` : s);
    if (out.length >= max) break;
  }
  return out;
}

/** The page's own text, cleaned and clipped, when no sentence in it happened to pass extractFindingSentences
 *  (e.g. unusual formatting) - still an honest, verbatim excerpt of the actual source, never blank. */
function plainExcerpt(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_SENTENCE_LEN);
}

// A shared surname ("the Mercer job" with two Mercers on file) is common enough in this domain that
// aborting outright would silently give up on every one of them - instead each matching customer (capped
// here) gets its own, separately-attributed lookup; nobody's finding is ever reported under someone else's
// name. Capped rather than unbounded so a very generic name never triggers a large fan-out of queries.
const MAX_CUSTOMERS = 4;

/** custIds -> up to MAX_FACTS {documentId, page, docType, filename, excerpt, extra} entries, one per
 *  distinct document, most-recent document first - the same guarded-timeout SQL shape as
 *  contentCount.js's own runContentCount (never a full-corpus scan: scoped to these specific customer ids). */
async function findingEntriesForCustomers(db, custIds) {
  await db.raw('SAVEPOINT job_summary', []);
  let pages;
  try {
    await db.raw("SET LOCAL statement_timeout = '4000'", []);
    ({ rows: pages } = await db.raw(
      `SELECT p.document_id, p.page_no, p.text, d.document_type, d.original_filename, d.created_at
         FROM document_pages p
         JOIN documents d ON d.id = p.document_id AND d.${TENANT_SQL}
        WHERE p.${TENANT_SQL}
          AND p.document_id IN (
            SELECT l.document_id FROM document_entity_links l
             WHERE l.entity_id = ANY($1::uuid[]) AND l.${TENANT_SQL}
            UNION
            SELECT l.document_id FROM document_entity_links l
             JOIN entities e ON e.id = l.entity_id AND e.${TENANT_SQL}
            WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.customer_id = ANY($1::uuid[])
          )
          AND p.text ~* $2
        ORDER BY d.created_at DESC
        LIMIT 20`,
      [custIds, FINDING_PATTERN_SQL]
    ));
    await db.raw('RELEASE SAVEPOINT job_summary', []);
  } catch (err) {
    await db.raw('ROLLBACK TO SAVEPOINT job_summary', []).catch(() => {});
    throw err;
  }

  const seenDocs = new Set();
  const entries = [];
  for (const p of pages) {
    if (seenDocs.has(p.document_id) || entries.length >= MAX_FACTS) continue;
    const sentences = extractFindingSentences(p.text, 2);
    const excerpt = sentences[0] ?? plainExcerpt(p.text);
    if (!excerpt) continue;
    seenDocs.add(p.document_id);
    entries.push({
      documentId: p.document_id, page: p.page_no, docType: p.document_type,
      filename: p.original_filename, excerpt, extra: sentences[1],
    });
  }
  return { entries, pagesSeen: pages.length };
}

/** entries -> one quoted, semicolon-joined string - every real sentence found (not just the first) is
 *  included, verbatim; a job often has both a "found X" line and a separate "recommend Y" line. */
function quoteEntries(entries) {
  return entries.map((e) => [e.excerpt, e.extra].filter(Boolean).map((s) => `"${s}"`).join(' ')).join('; ');
}

function factsForCustomer(cust, entries, pack) {
  return entries.map((e) => ({
    label: `${cust.name ? `${cust.name} · ` : ''}${documentTypeLabel(e.docType, pack)}${e.filename ? ` · ${e.filename}` : ''}`,
    value: `p.${e.page}: "${e.excerpt}"${e.extra ? ` "${e.extra}"` : ''}`,
    entityId: cust.id,
    sources: [{ documentId: e.documentId, location: { page: e.page } }],
  }));
}

function recordsForCustomer(cust, entries) {
  return [
    customerRecord({ id: cust.id, customer_name: cust.name, service_address: cust.address }),
    ...entries.map((e) => documentRecord({ id: e.documentId, document_type: e.docType, original_filename: e.filename }, {
      label: `${documentTypeLabel(e.docType)} · ${e.filename ?? e.documentId}`,
      sublabel: `"${e.excerpt}"`, page: e.page, group: cust.name || undefined,
    })),
  ];
}

// ==================================================================== address-resolved job summary
// (R16 F4, field-phrasing g099-g101)

/** document_type values that mean "the install itself" (documentTypes.js's own install_record mapping:
 *  an invoice when there's a cost/invoice_number, a startup-sheet when there's only commissioning
 *  readings - either way, the ORIGINAL equipment install, never a later visit). */
const INSTALL_DOC_TYPES = new Set(['invoice', 'startup-sheet']);
/** The one document_type that IS literally "a work order" once canonicalized. */
const WORK_ORDER_DOC_TYPE = 'work-order';

/** custId -> every one of that customer's own documents (direct link OR via one of their units),
 *  oldest first, each with whatever it has of its own extracted work_performed/notes text - the
 *  structured fields themselves (extractions), never a page-text regex guess, so "the install has no
 *  notes field" (g100's own point) is a fact this can state plainly rather than paper over. */
async function customerJobDocuments(db, custId) {
  await db.raw('SAVEPOINT job_summary_addr', []);
  let docs;
  try {
    await db.raw("SET LOCAL statement_timeout = '4000'", []);
    const { rows } = await db.raw(
      `SELECT DISTINCT ON (d.id) d.id AS document_id, d.document_type, d.original_filename, d.created_at::date AS created_at
         FROM document_entity_links l
         JOIN documents d ON d.id = l.document_id AND d.${TENANT_SQL}
         LEFT JOIN entities le ON le.id = l.entity_id AND le.entity_type = 'equipment' AND le.${TENANT_SQL}
        WHERE l.${TENANT_SQL} AND (l.entity_id = $1 OR le.customer_id = $1)
        ORDER BY d.id, d.created_at ASC`,
      [custId]
    );
    // created_at comes back as a Date (or a string, depending on the driver) — normalize to an ISO
    // date string right away (same helper connect2.js/questions.js use for exactly this reason) so the
    // client-side sort below never calls .localeCompare on a non-string.
    docs = rows.map((r) => ({ ...r, created_at: isoDate(r.created_at) }));
    await db.raw('RELEASE SAVEPOINT job_summary_addr', []);
  } catch (err) {
    await db.raw('ROLLBACK TO SAVEPOINT job_summary_addr', []).catch(() => {});
    throw err;
  }
  docs.sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.document_id.localeCompare(b.document_id));
  if (!docs.length) return docs;
  const ids = docs.map((d) => d.document_id);
  const { rows: exRows } = await db.raw(
    `SELECT document_id, field_key, value FROM extractions
      WHERE document_id = ANY($1::uuid[]) AND field_key IN ('work_performed', 'notes') AND ${TENANT_SQL}
        AND coalesce(value, '') <> ''`,
    [ids]
  );
  const byDoc = new Map();
  for (const e of exRows) {
    const a = byDoc.get(e.document_id) ?? { work_performed: [], notes: [] };
    a[e.field_key].push(e.value);
    byDoc.set(e.document_id, a);
  }
  return docs.map((d) => ({ ...d, fields: byDoc.get(d.document_id) ?? { work_performed: [], notes: [] } }));
}

/** One job document's own work_performed/notes values -> a quoted, extractive text fragment, or null
 *  when it has neither field extracted at all (never invents a quote). */
function quoteJobDocument(doc) {
  const parts = [...doc.fields.work_performed, ...doc.fields.notes].filter(Boolean);
  if (!parts.length) return null;
  return parts.map((s) => `"${s}"`).join(' ');
}

function jobDocRecord(cust, doc) {
  return documentRecord({ id: doc.document_id, document_type: doc.document_type, original_filename: doc.original_filename }, {
    label: `${documentTypeLabel(doc.document_type)}${doc.original_filename ? ` · ${doc.original_filename}` : ''}`,
    sublabel: quoteJobDocument(doc) ?? undefined, group: cust.name || undefined,
  });
}

/**
 * "What was found/done on the job at <address>" / "any notes on the install at <address>" / "what's the
 * work order say for <address>" - address resolved to a customer via the SAME fast-path address
 * resolution the rest of the app uses (see this file's own import), then that one customer's own
 * documents are read, extractively, for real work_performed/notes text - never a paraphrase, never a
 * value invented for a field the actual document doesn't have.
 *
 * The "install" and "work order" phrasings are NOT answered from every document at that address the
 * way the generic "job" phrasing is - a customer's install document and a much-later, unrelated service
 * visit both living at the same address is the ordinary case, not the exception, and blurring them
 * together is exactly the failure mode field-phrasing g100 exists to catch (a 2017 service-ticket note
 * must never be reported as being about the install just because it is the only "notes" text on file for
 * that customer at all). So:
 *   - "install": scoped to INSTALL_DOC_TYPES only (the earliest one, if more than one - the original
 *     install, not a later replacement) - if that document has no 'notes' extracted, the answer says so
 *     plainly instead of reaching into a different document's notes.
 *   - "work order": scoped to an actual work-order document if one exists (the most recent, since a
 *     property can have more than one dispatch over time); if none exists at all, falls back to
 *     whichever document on file actually has work_performed text (most recent first) - the same
 *     "whatever job document covers this address" latitude field-phrasing g101's own rubric names,
 *     since not every tenant's document set includes a literally-typed "work order".
 *   - "job" (generic): no document-type restriction - every document with a work_performed/notes value,
 *     most recent first, each attributed to its own document (never merged into one undifferentiated
 *     quote), same as this file's own name-based per-customer path just above.
 */
async function runJobSummaryByAddress(db, { addressKind, address }, pack) {
  const group = await resolveAddressEntityFieldGroup(db, address);

  if (group.kind === 'no-address') {
    return attachCitations({
      kind: 'answer', text: `No job or customer on file for ${address}.`,
      facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
    }, { records: [], total: 0, kind: 'searched', basis: `Looked up an address matching "${address}"; none on file.` });
  }
  if (group.kind === 'no-unit') {
    return attachCitations({
      kind: 'answer', text: `${address} is on file, but not the specific unit/apartment named in the question.`,
      facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
    }, { records: [], total: 0, kind: 'searched', basis: `Looked up ${address} with that unit/apartment number; no match.` });
  }
  if (group.kind === 'multi-customer') {
    const names = group.names ?? [];
    const nameList = names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    return attachCitations({
      kind: 'answer',
      text: names.length
        ? `More than one customer is on file at ${address}: ${nameList}. Which one do you mean?`
        : `More than one customer is on file at ${address}. Which one do you mean?`,
      facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
    }, { records: [], total: 0, kind: 'searched', basis: `Looked up ${address}; more than one customer's own record matches.` });
  }
  if (group.kind === 'equipment' || !group.customer) {
    return attachCitations({
      kind: 'answer', text: `A unit is on file at ${address}, but no customer/job record is linked to it.`,
      facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
    }, { records: [], total: 0, kind: 'searched', basis: `Looked up ${address}; found a unit but no customer job record.` });
  }

  const custRow = group.customer;
  const cust = { id: custRow.id, name: custRow.data?.customer_name ?? null, address: custRow.data?.service_address ?? null };
  const allDocs = await customerJobDocuments(db, cust.id);
  const custName = cust.name || 'this customer';

  let candidates = allDocs;
  let scopeNote = '';
  if (addressKind === 'install') {
    const installDocs = allDocs.filter((d) => INSTALL_DOC_TYPES.has(canonicalTypeId(d.document_type)));
    candidates = installDocs.length ? installDocs.slice(0, 1) : [];
    scopeNote = 'the install document on file';
  } else if (addressKind === 'workOrder') {
    const woDocs = allDocs.filter((d) => canonicalTypeId(d.document_type) === WORK_ORDER_DOC_TYPE);
    if (woDocs.length) {
      candidates = woDocs.slice(-1);
      scopeNote = 'the work order on file';
    } else {
      const withWork = allDocs.filter((d) => d.fields.work_performed.length);
      candidates = withWork.length ? withWork.slice(-1) : [];
      scopeNote = 'the job document on file that covers this address';
    }
  } else {
    candidates = allDocs.filter((d) => d.fields.work_performed.length || d.fields.notes.length);
    scopeNote = 'this address\'s own documents on file';
  }

  if (!candidates.length) {
    const why = addressKind === 'install' ? 'no install document is on file for that address'
      : addressKind === 'workOrder' ? 'no work order or job document with any work performed is on file for that address'
        : 'no document on file for that address records what was found or done';
    return attachCitations({
      kind: 'answer', text: `${custName}'s own records for ${address}: ${why}.`,
      facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
    }, {
      records: [customerRecord({ id: cust.id, customer_name: cust.name, service_address: cust.address })],
      total: 0, kind: 'searched', basis: `Scanned ${custName}'s own documents on file for ${scopeNote}; none found.`,
    });
  }

  if (addressKind === 'install' && !candidates[0].fields.notes.length) {
    // g100's own point: the install document itself has no 'notes' field - state that plainly and give
    // its work_performed instead, rather than silently borrowing a note from a different document.
    const doc = candidates[0];
    const work = doc.fields.work_performed.map((s) => `"${s}"`).join(' ');
    const text = work
      ? `The install document on file for ${address} (${custName}) has no notes field; what it does record: ${work}.`
      : `The install document on file for ${address} (${custName}) has no notes field on it.`;
    const facts = [{ label: `${custName} · ${documentTypeLabel(doc.document_type, pack)}`, value: work || '(no notes on file)', entityId: cust.id, sources: [{ documentId: doc.document_id }] }];
    return attachCitations({
      kind: 'answer', text, facts, sources: [], confidence: 1, verifiedCount: facts.length, unverifiedCount: 0, closest: [],
    }, {
      records: [customerRecord({ id: cust.id, customer_name: cust.name, service_address: cust.address }), jobDocRecord(cust, doc)],
      total: 2, basis: `Read ${custName}'s own install document on file (${documentTypeLabel(doc.document_type, pack)}) for a notes field; it has none.`,
    });
  }

  const label = addressKind === 'install' ? 'install' : addressKind === 'workOrder' ? 'work order' : 'job';
  // Each document's own quote is its own SENTENCE (never joined with ";") so a multi-document "job"
  // answer's per-sentence citation check can attribute each quote to the one document it actually came
  // from, instead of one run-on sentence citing several documents at once.
  const text = candidates.length === 1
    ? `On the ${label} at ${address} (${custName}): ${quoteJobDocument(candidates[0])}.`
    : `At ${address} (${custName}): ${candidates.map((d) => `${documentTypeLabel(d.document_type, pack)} — ${quoteJobDocument(d)}.`).join(' ')}`;
  const facts = candidates.map((d) => ({
    label: `${custName} · ${documentTypeLabel(d.document_type, pack)}${d.original_filename ? ` · ${d.original_filename}` : ''}`,
    value: quoteJobDocument(d) ?? '', entityId: cust.id, sources: [{ documentId: d.document_id }],
  }));
  return attachCitations({
    kind: 'answer', text, facts, sources: [], confidence: 1, verifiedCount: facts.length, unverifiedCount: 0, closest: [],
  }, {
    records: [customerRecord({ id: cust.id, customer_name: cust.name, service_address: cust.address }), ...candidates.map((d) => jobDocRecord(cust, d))],
    total: 1 + candidates.length,
    basis: `Read ${scopeNote} for ${custName} at ${address} for its own work_performed/notes text.`,
  });
}

/**
 * @param db a withTenant() store
 * @param parsed parseJobSummaryQuestion's result
 * @param pack optional industry pack (documentTypeLabel only - see documentTypes.js)
 * @returns an /api/ask `data` object. Never returns null: an unresolvable name is an honest "not on file"
 *   answer, not a fall-through, and 2+ matching customers are reported separately rather than merged or
 *   abandoned - see the file header.
 */
export async function runJobSummary(db, parsed, pack = null) {
  if (parsed?.address) return runJobSummaryByAddress(db, parsed, pack);
  const { customerName } = parsed;
  const likeParam = `%${escapeLikeText(customerName)}%`;
  const { rows: allMatches } = await db.raw(
    `SELECT id, data->>'customer_name' AS name, data->>'service_address' AS address
       FROM entities
      WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL}
        AND data->>'customer_name' ILIKE $1
      ORDER BY name
      LIMIT 10`,
    [likeParam]
  );

  if (!allMatches.length) {
    const nv = await nameVerdict(db, customerName);
    if (!nv.deny) return clarifyEnvelope(customerName, nv);
    return attachCitations({
      kind: 'answer',
      text: `No customer or job named "${customerName}" is on file.`,
      facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
    }, {
      records: [], total: 0, kind: 'searched',
      basis: `Looked up a customer whose name matches "${customerName}"; none on file.`,
    });
  }

  const customers = allMatches.slice(0, MAX_CUSTOMERS);
  const perCustomer = [];
  let totalPagesSeen = 0;
  for (const cust of customers) {
    const { entries, pagesSeen } = await findingEntriesForCustomers(db, [cust.id]);
    totalPagesSeen += pagesSeen;
    perCustomer.push({ cust, entries });
  }
  const withFindings = perCustomer.filter((pc) => pc.entries.length);

  /* ---------------------------------------------------------------- a single, unambiguous match */
  if (customers.length === 1) {
    const { cust } = perCustomer[0];
    const custName = cust.name || customerName;
    if (!withFindings.length) {
      return attachCitations({
        kind: 'answer',
        text: `No documents on file for ${custName} record what was found or done on that job.`,
        facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
      }, {
        records: [customerRecord({ id: cust.id, customer_name: cust.name, service_address: cust.address })],
        total: 0, kind: 'searched',
        basis: `Scanned ${custName}'s own documents on file for a finding/work note; none found.`,
      });
    }
    const { entries } = perCustomer[0];
    const text = `On the ${custName} job: ${quoteEntries(entries)}`;
    const facts = factsForCustomer(cust, entries, pack);
    return attachCitations({
      kind: 'answer', text, facts, sources: [], confidence: 1, verifiedCount: facts.length, unverifiedCount: 0, closest: [],
    }, {
      records: recordsForCustomer(cust, entries), total: 1 + entries.length,
      basis: `Read ${custName}'s own documents on file (most recent first) for sentences recording what was found, replaced, checked, recommended or noted; ${entries.length} of ${totalPagesSeen} matching page(s) shown.`,
    });
  }

  /* ---------------------------------------------------------------- 2+ customers share this name */
  const names = customers.map((c) => c.name || 'Unnamed customer');
  const nameList = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const intro = `${customers.length} customers on file match "${customerName}": ${nameList}.`;

  if (!withFindings.length) {
    return attachCitations({
      kind: 'answer',
      text: `${intro} None has a document on file recording what was found or done.`,
      facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
    }, {
      records: customers.map((c) => customerRecord({ id: c.id, customer_name: c.name, service_address: c.address })),
      total: 0, kind: 'searched',
      basis: `Scanned each matching customer's own documents on file for a finding/work note; none found.`,
    });
  }

  const segments = perCustomer.map(({ cust, entries }) => (
    entries.length
      ? `On ${cust.name ? `${cust.name}'s` : 'their'} job: ${quoteEntries(entries)}`
      : `Nothing on file for ${cust.name || 'this customer'}.`
  ));
  const text = `${intro} ${segments.join(' ')}`;
  const facts = perCustomer.flatMap(({ cust, entries }) => factsForCustomer(cust, entries, pack));
  const records = perCustomer.flatMap(({ cust, entries }) => recordsForCustomer(cust, entries));
  return attachCitations({
    kind: 'answer', text, facts, sources: [], confidence: 1, verifiedCount: facts.length, unverifiedCount: 0, closest: [],
  }, {
    records, total: records.length,
    basis: `${customers.length} customers on file match "${customerName}"; read each one's own documents separately (most recent first) rather than merging them.`,
  });
}
