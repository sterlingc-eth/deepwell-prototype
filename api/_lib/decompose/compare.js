/**
 * decompose/compare.js — Round 11, item 1: the "Compare invoices vs POs for the Rios job" shape.
 *
 * Resolves the named job (an address, or a customer/job name) through financials/jobCosting.js's OWN
 * job-key resolution (findJobForAddress/computeJobCosts — the same grouping every job-costing/margin
 * answer in this codebase already trusts, never a second address-matching definition of "which job"),
 * then splits that job's own revenue+cost documents by doc_kind (financials/normalize.js's
 * FINANCIAL_KINDS_BY_TYPE — 'invoice', 'po', 'estimate', ...) to total each side of the comparison.
 *
 * Never fabricates a "0 vs 0": a subject that resolves no job, or a job with neither side represented at
 * all, returns null so ask.js falls through to the normal chain (financials money gate / agent) exactly
 * like every other deterministic router here.
 *
 * db: runComparison. Calls ONLY exported functions from financials/jobCosting.js, financials/store.js and
 * relations/timeline.js — this file never touches document_financials/entities SQL directly, so it can
 * never drift from those modules' own definitions of a job or a customer.
 */
import { tenantHasFinancialRows } from '../financials/store.js';
import { computeJobCosts, findJobForAddress, jobKeyFromQuestionAddress } from '../financials/jobCosting.js';
import { fetchCustomers } from '../relations/timeline.js';
import { attachCitations } from '../citations/records.js';
import { documentRecordsFor } from '../citations/enrich.js';
import { answerEnvelope } from '../scope.js';

/** The one job `subjectRaw` (an address, or a customer/job name with no address at all) means, or null —
 *  never guessed across more than one match. An address-shaped subject goes straight to
 *  findJobForAddress; a name goes through the SAME name -> customer -> on-file address -> job path every
 *  other router in this codebase uses (deterministicRouter.js's resolveScope, relations/questions.js),
 *  requiring exactly one customer name match. */
async function resolveJobForSubject(db, subjectRaw, jobs) {
  const subject = String(subjectRaw ?? '').replace(/^the\s+/i, '').trim();
  if (!subject) return null;
  if (jobKeyFromQuestionAddress(subject)) return findJobForAddress(jobs, subject);
  const customers = await fetchCustomers(db);
  const needle = subject.toLowerCase();
  const cands = customers.filter((c) => c.name && c.name.toLowerCase().includes(needle));
  if (cands.length !== 1 || !cands[0].address) return null;
  return findJobForAddress(jobs, cands[0].address);
}

function fmtUsd(n) {
  return `$${Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * @param db     a withTenant() store
 * @param intent decompose/clauses.js's parseComparison result
 * @returns an /api/ask `data` object, or null (fall through — never a fabricated comparison)
 */
export async function runComparison(db, intent, { today: _today } = {}) {
  if (!(await tenantHasFinancialRows(db))) return null;
  const { jobs } = await computeJobCosts(db, {});
  const job = await resolveJobForSubject(db, intent.subject, jobs);
  if (!job) return null;

  const allDocs = [...job.revenueDocs, ...job.costDocs];
  const aDocs = allDocs.filter((d) => intent.aKinds.includes(d.docKind));
  const bDocs = allDocs.filter((d) => intent.bKinds.includes(d.docKind));
  if (!aDocs.length && !bDocs.length) return null; // nothing on file for either side — never fabricate 0 vs 0

  const sumOf = (docs) => docs.reduce((s, d) => s + Number(d.total ?? 0), 0);
  const aTotal = sumOf(aDocs);
  const bTotal = sumOf(bDocs);
  const label = job.address ?? intent.subject;
  const diff = Math.abs(aTotal - bTotal);
  const cmp = aTotal === bTotal ? `equal to ${intent.bLabel}` : aTotal > bTotal ? `${fmtUsd(diff)} more than ${intent.bLabel}` : `${fmtUsd(diff)} less than ${intent.bLabel}`;

  const text = `For ${label}: ${aDocs.length} ${intent.aLabel} totaling ${fmtUsd(aTotal)} vs ${bDocs.length} ${intent.bLabel} totaling ${fmtUsd(bTotal)} — ${intent.aLabel} total is ${cmp}.`;
  const docIds = [...aDocs, ...bDocs].map((d) => d.documentId);
  return attachCitations(answerEnvelope({
    text,
    facts: [
      { label: `${intent.aLabel}`, value: `${aDocs.length} (${fmtUsd(aTotal)})` },
      { label: `${intent.bLabel}`, value: `${bDocs.length} (${fmtUsd(bTotal)})` },
    ],
  }), {
    records: await documentRecordsFor(db, docIds),
    total: docIds.length,
    claimedCount: docIds.length,
    basis: `Compared every ${intent.aLabel} document against every ${intent.bLabel} document linked to ${label}.`,
  });
}
