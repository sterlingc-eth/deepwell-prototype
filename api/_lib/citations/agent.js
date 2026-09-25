/**
 * Citations for the Donovan agent (api/_lib/agent). Two halves:
 *
 *   collectQueryIdentities(db, rows, columns)   called from tools.js's run_query, INSIDE the same
 *       tenant transaction, on the rows the SQL actually returned: captures the customer / unit /
 *       document each row IS (by its customer_id / equipment_id / document_id column), labelled from
 *       the tenant's own rows. The model is told (VIEW_DOCS) to select those id columns for every
 *       list or count so there is something to capture.
 *
 *   citeAgentData({withTenant, ctxArg, data, ledger, input})   called once after the answer is
 *       shaped: attaches records + recordsTotal + basis. Preference order:
 *         1. the identities of the run_query that produced the answer (same rows as the number),
 *         2. the customers / documents the answer's own facts point at,
 *         3. an honest zero: the documents / customers that were actually searched,
 *         4. the documents the agent actually read.
 *
 * Never logs question text or row values.
 */
import { documentTypeLabel } from '../documentTypes.js';
import { MAX_RECORDS, attachCitations, customerRecord, unitRecord, documentRecord, defaultBasis } from './records.js';
import { money } from './finance.js';
import { labelDocuments, labelEntities, enrichCitations, documentRecordsFor } from './enrich.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
const str = (v) => (v == null ? undefined : String(v));

const VIEW_NOUN = {
  customers: 'customer records', equipment: 'equipment records', documents_v: 'documents', facts: 'extracted fields',
  doc_links: 'document links', financials: 'financial documents', invoice_lines: 'invoice line items',
};

/** The identity a row carries: document > unit > customer. */
function rowIdentity(r) {
  const docId = r.document_id ?? r.documentId ?? (r.filename !== undefined || r.document_type !== undefined ? r.id : undefined);
  if (isUuid(docId)) return { kind: 'document', id: docId.toLowerCase() };
  if (isUuid(r.equipment_id)) return { kind: 'unit', id: r.equipment_id.toLowerCase() };
  if (isUuid(r.customer_id)) return { kind: 'customer', id: r.customer_id.toLowerCase() };
  return null;
}

/**
 * @returns {Promise<{hasIds: boolean, records: object[], total: number, capped: boolean}>}
 */
export async function collectQueryIdentities(db, rows, { maxRows = 100 } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const seen = new Map();
  for (const r of list) {
    const idn = rowIdentity(r);
    if (!idn) continue;
    const key = `${idn.kind}:${idn.id}`;
    const group = str(r.group_key);
    // one record per identity (a customer with three matching units is still one customer)
    if (!seen.has(key)) seen.set(key, { ...idn, row: r, group });
  }
  if (!seen.size) return { hasIds: false, records: [], total: 0, capped: false };

  const entries = [...seen.values()].slice(0, MAX_RECORDS);
  await db.raw('SAVEPOINT agent_ident', []);
  let docs = new Map();
  let ents = new Map();
  try {
    [docs, ents] = await Promise.all([
      labelDocuments(db, entries.filter((e) => e.kind === 'document').map((e) => e.id)),
      labelEntities(db, entries.filter((e) => e.kind !== 'document').map((e) => e.id)),
    ]);
    await db.raw('RELEASE SAVEPOINT agent_ident', []);
  } catch {
    await db.raw('ROLLBACK TO SAVEPOINT agent_ident', []).catch(() => {});
  }
  const records = [];
  for (const e of entries) {
    const r = e.row;
    if (e.kind === 'document') {
      const d = docs.get(e.id);
      if (!d) continue; // not this tenant's document: never cite it
      const isInvoice = d.document_type === 'invoice' || r.doc_kind === 'invoice';
      const page = Number(r.total_page ?? r.page_no);
      records.push(documentRecord(d, {
        type: isInvoice ? 'invoice' : undefined, group: e.group,
        label: `${r.invoice_number ? `Invoice #${r.invoice_number} · ` : `${documentTypeLabel(d.document_type)} · `}${r.customer_name ?? d.original_filename ?? e.id}`,
        sublabel: [r.total != null ? money(r.total) : null, str(r.service_date ?? r.invoice_date ?? r.doc_date)?.slice(0, 10)].filter(Boolean).join(' · ') || undefined,
        page: Number.isFinite(page) && page > 0 ? page : undefined,
      }));
    } else {
      const ent = ents.get(e.id);
      if (!ent) continue;
      records.push(ent.entity_type === 'equipment' ? unitRecord(ent, { group: e.group }) : customerRecord(ent, { group: e.group }));
    }
  }
  const capped = list.length >= maxRows;
  const totalCol = Number(list[0]?.total_count);
  const total = Number.isFinite(totalCol) && totalCol >= records.length ? totalCol : seen.size;
  return { hasIds: records.length > 0, records, total, capped };
}

/** Remember one query's identities on the ledger (tools.js calls this with what runQuery got back). */
export function noteQueryIdentities(ledger, identities, { purpose = '', views = [], rowCount = 0 } = {}) {
  if (!ledger.identityQueries) ledger.identityQueries = [];
  if (!ledger.queryLog) ledger.queryLog = [];
  const p = purpose === 'recipe' ? '' : String(purpose ?? '').slice(0, 60);
  ledger.queryLog.push({ purpose: p, views: [...views], rowCount });
  if (!identities?.hasIds) return;
  ledger.identityQueries.push({ ...identities, purpose: p, views: [...views], rowCount });
}

/** Remember one search_documents call (what was searched) on the ledger. */
export function noteSearch(ledger, s) {
  if (!ledger.searches) ledger.searches = [];
  ledger.searches.push({ query: String(s.query ?? '').slice(0, 80), scopeName: s.scopeName ?? null, docIds: (s.docIds ?? []).slice(0, MAX_RECORDS), results: s.results ?? 0, unscopedDocs: s.unscopedDocs ?? null });
}

const digits = (s) => (String(s).toLowerCase().match(/[a-z0-9$#][a-z0-9$#.,:/-]*/g) ?? []).map((t) => t.replace(/[.,:/-]+$/, '')).filter((t) => /\d/.test(t));

// Owner report (2026-09-25): the model's own `basis` field ("Counted distinct customer_id from
// equipment where warranty_current = true.") passed the digit-grounding check above but read as raw
// SQL/schema — it was parroting the column names agent/tools.js's system prompt shows it
// (warranty_current, customer_id, equipment_id, ...). Rejected here so those fall back to the
// deterministic, always-human queryBasis()/viewsPhrase() wording instead. A false positive just means
// an honest generic sentence where the model's own (still fine) one might have worked — never wrong,
// see this file's basisOk pattern throughout.
const SQL_JARGON_RE = /\b[a-z][a-z]*_[a-z][a-z_]*\b|=\s*(?:true|false)\b|\b(?:select|distinct|inner join|left join|group by|order by|where)\b/i;
const looksLikeSqlJargon = (s) => SQL_JARGON_RE.test(String(s ?? ''));

function viewsPhrase(views) {
  const nouns = [...new Set(views.map((v) => VIEW_NOUN[v]).filter(Boolean))];
  return nouns.length ? nouns.join(' and ') : 'your records';
}

function queryBasis(q, total, capped) {
  const purpose = q.purpose ? ` (${q.purpose.replace(/[.\s]+$/, '')})` : '';
  const cap = capped && total <= q.rowCount ? ' The query result was capped at 100 rows, so there may be more.' : '';
  return `Computed from ${total} matching record${total === 1 ? '' : 's'} returned by a read-only query over your ${viewsPhrase(q.views ?? [])}${purpose}.${cap}`;
}

/**
 * Attach the citation contract to an agent answer (mutates and returns `data`).
 * `withTenant` is only touched when facts point at records that still need labels (case 2/3).
 */
export async function citeAgentData({ withTenant, ctxArg, data, ledger, input }) {
  if (!data || typeof data !== 'object') return data;
  try {
    const iq = ledger.identityQueries ?? [];
    const factNums = (data.facts ?? []).length === 1 && /^\d+$/.test(String(data.facts[0].value).trim()) && String(data.text ?? '').includes(String(data.facts[0].value).trim())
      ? Number(String(data.facts[0].value).trim()) : null;
    // the model may add its own one-sentence basis, but only if every number in it is real evidence
    const modelBasis = typeof input?.basis === 'string' ? input.basis.trim().replace(/\s+/g, ' ') : '';
    const evidence = ledger.corpus ?? '';
    const basisOk = modelBasis && modelBasis.length <= 240 && !looksLikeSqlJargon(modelBasis) &&
      digits(modelBasis).every((t) => evidence.includes(t) || evidence.includes(t.replace(/,/g, '')) || String(data.text).toLowerCase().includes(t));

    if (iq.length) {
      const chosen = (factNums != null ? [...iq].reverse().find((q) => q.total === factNums) : null) ?? iq[iq.length - 1];
      return attachCitations(data, {
        records: chosen.records, total: chosen.total,
        claimedCount: factNums != null && !chosen.capped ? factNums : null,
        basis: basisOk ? modelBasis : queryBasis(chosen, chosen.total, chosen.capped),
      });
    }

    // Facts that point at customers / units / documents: label them from the tenant's own rows.
    const pointsAtRecords = (data.facts ?? []).some((f) => f.entityId || (f.sources ?? []).length) || (data.sources ?? []).length;
    if (pointsAtRecords) {
      await withTenant(ctxArg, (db) => enrichCitations(db, data, basisOk ? { basis: modelBasis } : {}));
      return data;
    }

    // Honest zero: cite what was searched.
    const searches = ledger.searches ?? [];
    const scoped = [...searches].reverse().find((s) => s.docIds?.length);
    if (scoped) {
      const searched = await withTenant(ctxArg, (db) => documentRecordsFor(db, scoped.docIds));
      return attachCitations(data, {
        records: searched, total: scoped.docIds.length, kind: 'searched',
        basis: `Searched ${scoped.docIds.length} document${scoped.docIds.length === 1 ? '' : 's'}${scoped.scopeName ? ` linked to ${scoped.scopeName}` : ''} for “${scoped.query}”${scoped.results ? '' : ' — none mention it'}.`,
      });
    }
    const last = searches[searches.length - 1];
    if (last) {
      return attachCitations(data, {
        records: [], total: 0, kind: 'searched',
        basis: basisOk ? modelBasis : `Searched the text of ${last.unscopedDocs != null ? `all ${last.unscopedDocs} of your` : 'your'} documents for “${last.query}”${last.results ? '' : '; nothing matched'}.`,
      });
    }

    // Documents the agent actually read.
    const read = [...(ledger.docStage?.keys?.() ?? [])].slice(0, MAX_RECORDS);
    if (read.length) {
      const recs = read.map((id) => documentRecord({ id }, { label: ledger.docName?.get(id) ? `Document · ${ledger.docName.get(id)}` : 'Document' }));
      return attachCitations(data, { records: recs, total: read.length, basis: basisOk ? modelBasis : `Drawn from ${read.length} document${read.length === 1 ? '' : 's'} Donovan read while answering.` });
    }
    const lastQuery = (ledger.queryLog ?? [])[(ledger.queryLog ?? []).length - 1];
    if (lastQuery) {
      const none = data.kind === 'answer' && !(data.facts ?? []).length;
      return attachCitations(data, {
        records: [], total: 0, kind: 'searched',
        basis: basisOk ? modelBasis : `${none ? 'Searched' : 'Computed by a read-only query over'} your ${viewsPhrase(lastQuery.views)}${lastQuery.purpose ? ` (${lastQuery.purpose.replace(/[.\s]+$/, '')})` : ''}${none ? '; nothing matched.' : '; it returned totals only, so no individual records could be listed.'}`,
      });
    }
    return attachCitations(data, {
      records: [], total: 0, kind: 'searched',
      basis: basisOk ? modelBasis : `Donovan ran ${ledger.dataCalls ?? 0} read-only lookup${ledger.dataCalls === 1 ? '' : 's'} over your records${data.kind === 'answer' && !(data.facts ?? []).length ? '; none returned a match' : ''}.`,
    });
  } catch (err) {
    console.error('Agent citation step failed, answer sent with derived citations only:', err?.message);
    return data;
  }
}

export { defaultBasis };
