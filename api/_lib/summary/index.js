/**
 * Summary lane (round 2, B2): "rundown on X", "recap X", "what do we have on file for X", "tell me about our purchase orders".
 *
 * parse.js decides whether the question is a summary of ONE subject and which kind; this file resolves the subject against the records
 * and builds the answer from stored facts only (text.js), cited with the documents / units / customers it was read from. No model call.
 *
 * runSummary returns:
 *   { answer }              a finished, cited answer
 *   { release: "legacy" }   the subject is a name the records do not resolve: the older name lookup may still answer or decline honestly
 *   { release: "none" }     the lane makes no claim (unresolved or ambiguous subject, nothing to say)
 */
import { parseSummaryQuestion, summaryEnabled } from "./parse.js";
import {
  loadDocuments, documentIdsOfType, allDocumentIds, customerDocIds, visibleDocumentIds, technicianNames, technicianDocIds, equipmentRows, customerBase,
} from "./read.js";
import {
  buildCustomerSummary, buildDocTypeSummary, buildAllDocsSummary, buildTechnicianSummary, buildBrandSummary, buildCustomerBaseSummary,
} from "./text.js";
import { attachCitations } from "../citations/records.js";
import { fetchFileData, buildFileSummary } from "../customerFile.js";
import { todayIso, TENANT_SQL } from "../scope.js";
import { canonicalBrandLabel } from "../analytics/brandCanon.js";
import { resolveNamedCustomers, buildAmbiguousContactAnswer, buildNearMissDeclineAnswer } from "../contactLookup.js";

export { parseSummaryQuestion, summaryEnabled };

const done = (built) => {
  const answer = attachCitations(built.answer, { records: built.records, total: built.total, basis: built.basis });
  return { answer };
};

const inPeriod = (docs, period) => (period ? docs.filter((d) => d.date && d.date >= period.from && d.date <= period.to) : docs);

export async function runSummary(db, question, { today: todayArg = null } = {}) {
  const today = todayIso(todayArg);
  const intent = parseSummaryQuestion(question, { today });
  if (!intent) return { release: "none" };

  if (intent.kind === "docType") {
    if (intent.docType === "hr-letter") return { release: "none" }; // People and HR papers are never listed or summarised here
    const ids = await documentIdsOfType(db, intent.docType);
    const docs = await loadDocuments(db, ids);
    if (!docs) return { release: "none" };
    return done(buildDocTypeSummary({ typeId: intent.docType, period: intent.period, docs: inPeriod(docs, intent.period), today }));
  }

  if (intent.kind === "allDocs") {
    const docs = await loadDocuments(db, await allDocumentIds(db));
    if (!docs) return { release: "none" };
    return done(buildAllDocsSummary({ period: intent.period, docs: inPeriod(docs, intent.period), today }));
  }

  if (intent.kind === "customers") {
    const customers = await customerBase(db);
    if (!customers.length) return { release: "none" };
    const units = await equipmentRows(db);
    return done(buildCustomerBaseSummary({ customers, unitCount: units.length }));
  }

  if (intent.kind === "brand") {
    const units = await equipmentRows(db);
    const want = canonicalBrandLabel(intent.phrase).toLowerCase();
    const mine = units.filter((u) => u.manufacturer && canonicalBrandLabel(u.manufacturer).toLowerCase() === want);
    if (!mine.length) return { release: "legacy" }; // "the Rios unit" names a customer's unit, not a brand: the older lookup may read it
    return done(buildBrandSummary({ brand: canonicalBrandLabel(mine[0].manufacturer), units: mine }));
  }

  // a name: a customer, or a technician
  const phrase = intent.phrase;
  const techOf = async () => {
    const hit = (await technicianNames(db)).find((t) => t.replace(/\s+/g, " ").toLowerCase() === phrase);
    return hit ?? null;
  };
  const techAnswer = async (name) => {
    const docs = await loadDocuments(db, await technicianDocIds(db, name));
    if (!docs) return { release: "none" };
    const built = buildTechnicianSummary({ name, docs, personVerb: intent.personVerb && !intent.upTo, today });
    // the same person may also be a customer: one line pointing to that view
    try {
      const { rows } = await db.raw(`SELECT id, data->>'customer_name' AS customer_name, data->>'service_address' AS service_address FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL} AND lower(data->>'customer_name') = lower($1) LIMIT 2`, [name]);
      if (rows.length === 1 && docs.length) {
        const n = (await loadDocuments(db, await customerDocIds(db, rows[0])))?.length ?? 0;
        if (n) built.answer.text += ` ${name} is also a customer, with ${n} ${n === 1 ? "document" : "documents"} on file.`;
      }
    } catch { /* optional line */ }
    return done(built);
  };
  if (intent.personVerb) {
    const t = await techOf();
    if (t) return techAnswer(t);
  }
  const resolved = await resolveNamedCustomers(db, question, phrase);
  if (resolved.declined) return { answer: resolved.declined };
  // whole names or whole words only ("Nora" is not inside "Sonoran")
  const want = phrase.split(/\s+/).filter(Boolean);
  const wholeWords = (n) => { const w = String(n ?? "").toLowerCase().split(/[^a-z0-9']+/).filter(Boolean); return want.every((t) => w.includes(t)); };
  // a name the records only match after a spelling fix is asked about first, never answered (checked before the whole-word filter, which a misspelling cannot pass)
  if (resolved.typoResolved && resolved.candidates.length) {
    const a = buildNearMissDeclineAnswer(phrase, resolved.candidates);
    a.typoResolution = { typed: phrase, resolved: resolved.candidates[0].customer_name }; // marks it so the lookup's "Showing results for" note is not put in front of a question
    return { answer: a };
  }
  const candidates = resolved.candidates.filter((c) => wholeWords(c.customer_name) || String(c.customer_name ?? "").toLowerCase() === phrase);
  if (candidates.length > 1) return { answer: ambiguous(phrase, candidates) };
  if (candidates.length === 1) {
    const customer = candidates[0];
    const [ids, equipment] = await Promise.all([customerDocIds(db, customer), equipmentRows(db, { customerId: customer.id })]);
    const docs = await loadDocuments(db, ids);
    if (!docs) return { release: "none" };
    // the customer file reader's own lines (last service visit by its past date, warranty status, maintenance agreement, open reminders)
    let fileLines = [], fileFacts = [];
    try {
      const fd = await fetchFileData(db, customer);
      const ok = await visibleDocumentIds(db, (fd.docs ?? []).map((d) => d.id));
      fd.docs = (fd.docs ?? []).filter((d) => ok.has(String(d.id)));
      fd.visits = (fd.visits ?? []).filter((v) => ok.has(String(v.documentId)));
      const file = buildFileSummary(customer, fd, today);
      fileLines = file.lines.filter((l) => !/^\d+ documents? on file/.test(l) && l !== "No documents are linked to this customer yet." && l !== "No open reminders.");
      fileFacts = file.facts.filter((f) => /^(?:Last service visit|Visits on file|Warranty status|Maintenance agreement|Reminder)/.test(f.label) && !/^\d+(?: · latest .*)?$/.test(f.value) || f.label === "Visits on file");
    } catch { /* the file lines are an enrichment: the summary stands without them */ }
    const built = buildCustomerSummary({ customer, docs, equipment, today, fileLines, fileFacts });
    const t2 = await techOf();
    if (t2) {
      const n = (await loadDocuments(db, await technicianDocIds(db, t2)))?.length ?? 0;
      if (n) built.answer.text += ` ${customer.customer_name} is also the technician on ${n} ${n === 1 ? "document" : "documents"}.`;
    }
    return done(built);
  }
  const t = await techOf();
  if (t) {
    const r = await techAnswer(t);
    return r;
  }
  return { release: "legacy" };
}

/** Several customers share the name: each option carries a detail that tells them apart (city, else customer number, else the address). */
function ambiguous(phrase, rows) {
  const city = (r) => { const p = String(r.service_address ?? "").split(",").map((x) => x.trim()).filter(Boolean); return p.length >= 3 ? p[p.length - 2] : (p.length === 2 ? p[0] : ""); };
  const bits = rows.map((r) => [city(r), r.customer_number ? `customer ${r.customer_number}` : "", r.service_address ?? ""].filter(Boolean));
  const pick = (i, level) => bits[i][Math.min(level, bits[i].length - 1)] ?? "";
  let level = 0;
  while (level < 2 && new Set(rows.map((_, i) => `${rows[i].customer_name}|${pick(i, level)}`)).size < rows.length) level++;
  const label = (r, i) => (pick(i, level) ? `${r.customer_name} (${pick(i, level)})` : String(r.customer_name));
  const a = buildAmbiguousContactAnswer(phrase, rows);
  a.text = `I found more than one match for "${phrase}": ${rows.map(label).join(", ")}. Which one did you mean?`;
  a.facts = a.facts.map((f, i) => ({ ...f, label: label(rows[i], i) }));
  return a;
}
