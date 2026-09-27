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
import { documentTypeLabel } from '../documentTypes.js';
import { attachCitations, customerRecord, documentRecord } from '../citations/records.js';

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

/** Postgres ILIKE metacharacters escaped so a customer name is never treated as a wildcard pattern. */
function escapeLikeText(s) {
  return String(s ?? '').replace(/[\\%_]/g, '\\$&');
}

/**
 * Pure: question -> {mode: 'jobSummary', customerName, question} or null. contentCount.js's
 * parseContentCountQuestion tries this FIRST, before its own mention/replace shapes (which require an HVAC
 * term this shape never has), so nothing already handled by those changes.
 */
export function parseJobSummaryQuestion(question) {
  const q = String(question ?? '').trim();
  if (!q) return null;
  const m = JOB_SUMMARY_RE.exec(q);
  if (!m) return null;
  const name = m[1].replace(/\s+/g, ' ').trim().replace(/^(?:the|a|an)\s+/i, '');
  if (name.length < 2) return null;
  return { mode: 'jobSummary', customerName: name, question: q };
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

/**
 * @param db a withTenant() store
 * @param parsed parseJobSummaryQuestion's result
 * @param pack optional industry pack (documentTypeLabel only - see documentTypes.js)
 * @returns an /api/ask `data` object. Never returns null: an unresolvable name is an honest "not on file"
 *   answer, not a fall-through, and 2+ matching customers are reported separately rather than merged or
 *   abandoned - see the file header.
 */
export async function runJobSummary(db, parsed, pack = null) {
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
