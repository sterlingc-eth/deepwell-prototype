/**
 * citations/provenance.js - "where did that come from" for every answer the code gives (round 19).
 *
 *   resolveProvenance(db, data)   after a lane has produced an answer: for every cited paper, set the page that really holds the figure /
 *                                 date / name the record stands for (the first page that contains it, checked in code), and drop a page
 *                                 number that does not hold it. An answer about one customer's stored phone / email / address that cites
 *                                 only the customer gets the papers (and pages) that print that value.
 *   pageNeedles / pageHolds       the pure checks (verify:cite-r19 runs them without a database).
 * A page number is only ever set or kept when its text contains the value; otherwise the paper is cited without a page. Never throws.
 */
import { isPrivateDoc, notPrivateIdSql } from '../privacy/privateDocs.js';
import { visibleDocSql } from '../audience/visible.js';
import { documentTypeLabel } from '../documentTypes.js';
import { numbersIn, canonNumber } from '../grounding/gate.js';

const TENANT = "tenant_id = (current_setting('app.tenant_id', true))::uuid";
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const fold = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** every calendar day a text prints, as YYYY-MM-DD (numeric, ISO and month-name forms) */
export function datesIn(t) {
  const s = new Set(); const p = (y, m, d) => { if (y < 100) y += 2000; if (m >= 1 && m <= 12 && d >= 1 && d <= 31) s.add(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`); };
  const x = String(t ?? '');
  for (const m of x.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)) p(+m[1], +m[2], +m[3]);
  for (const m of x.matchAll(/(?<![\d-])(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?![\d-])/g)) p(+m[3], +m[1], +m[2]);
  for (const m of x.matchAll(/\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/g)) { const mo = MON[m[1].toLowerCase()]; if (mo) p(+m[3], mo, +m[2]); }
  for (const m of x.matchAll(/\b(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})/g)) { const mo = MON[m[2].toLowerCase()]; if (mo) p(+m[3], mo, +m[1]); }
  return s;
}

/** What a cited record stands for, in checkable form: {amounts:[canon], dates:[iso], names:[folded]} from its sublabel. */
export function pageNeedles(rec) {
  const sub = String(rec?.sublabel ?? '');
  const amounts = [...sub.matchAll(/\$\s?([\d,]+(?:\.\d+)?)/g)].map((m) => canonNumber(m[1]));
  const dates = [...datesIn(sub)];
  const names = sub.split(' · ').map((x) => x.trim()).filter((x) => x.length > 3 && !/\$|\d{4}/.test(x) && !/^[A-Z][a-z]+ \d/.test(x)).map(fold).filter((x) => x.split(' ').length >= 2 || x.length > 5);
  return { amounts, dates, names };
}

/** Does this page text hold the value the record stands for? null when the record names nothing checkable. */
export function pageHolds(text, needles) {
  const { amounts, dates, names } = needles;
  if (!amounts.length && !dates.length && !names.length) return null;
  if (amounts.length) { const nums = numbersIn(text); if (!amounts.every((a) => nums.has(a))) return false; return true; }
  const dd = dates.length ? datesIn(text) : null; const nt = fold(text);
  return (dates.length && dates.some((d) => dd.has(d))) || names.some((n) => nt.includes(n));
}

const digits = (s) => String(s ?? '').replace(/\D/g, '');
/** Does a page print a stored value (phone by its digits, anything else by its words)? */
export function pagePrints(text, value) {
  const v = String(value ?? '').trim(); if (!v) return false;
  if (digits(v).length >= 7 && /^[\d\s()+.\-x#ext]+$/i.test(v)) return digits(text).includes(digits(v));
  const f = fold(v); if (f.length < 4) return false;
  return fold(text).includes(f);
}

async function loadPages(db, ids) {
  if (!ids.length) return new Map();
  const { rows } = await db.raw(`SELECT p.document_id, p.page_no, p.text FROM document_pages p WHERE p.document_id = ANY($1::uuid[]) AND p.${TENANT} AND ${notPrivateIdSql('p.document_id')} ORDER BY p.document_id, p.page_no`, [ids]);
  const m = new Map();
  for (const r of rows ?? []) { const k = String(r.document_id).toLowerCase(); (m.get(k) ?? m.set(k, []).get(k)).push({ page: Number(r.page_no), text: String(r.text ?? '') }); }
  return m;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveProvenance(db, data) {
  try {
    if (!data || typeof data !== 'object' || data.kind !== 'answer' || !Array.isArray(data.records) || process.env.DONOVAN_PROVENANCE === '0') return data;
    const docRecs = data.records.filter((r) => r?.documentId && UUID.test(String(r.documentId)));
    if (docRecs.length) {
      const pages = await loadPages(db, [...new Set(docRecs.map((r) => String(r.documentId).toLowerCase()))]);
      for (const r of docRecs) {
        const ps = pages.get(String(r.documentId).toLowerCase()) ?? [];
        const nd = pageNeedles(r);
        const holds = (p) => pageHolds(p.text, nd);
        if (r.page) { const cur = ps.find((p) => p.page === r.page); if (cur && holds(cur) !== false) continue; delete r.page; } // a page that lacks the value is dropped, never kept
        const hit = ps.find((p) => holds(p) === true);
        if (hit) r.page = hit.page;
      }
    }
    // an answer that rests on a customer's stored phone / email / address / name but cites no paper: cite the papers that print it
    const custs = data.records.filter((r) => r?.type === 'customer' && UUID.test(String(r.id)));
    if (!docRecs.length && custs.length && custs.length <= 5 && Array.isArray(data.facts) && data.facts.length) {
      const vals = data.facts.filter((f) => f && f.entityId && typeof f.value === 'string' && f.value.length >= 4 && !/^[\d,.$%\s]+$/.test(f.value) || (f && f.entityId && digits(f.value).length >= 7)).map((f) => ({ id: String(f.entityId).toLowerCase(), v: String(f.value) }));
      if (vals.length) {
        const ids = [...new Set(vals.map((x) => x.id))].filter((x) => UUID.test(x));
        const aud = await visibleDocSql(db, 'd');
        const { rows } = await db.raw(`SELECT DISTINCT d.id, d.document_type, d.original_filename, d.created_at, l.entity_id FROM documents d JOIN document_entity_links l ON l.document_id = d.id AND l.${TENANT} WHERE l.entity_id = ANY($1::uuid[]) AND d.${TENANT} AND (${aud}) AND ${notPrivateIdSql('d.id')} ORDER BY d.created_at DESC LIMIT 60`, [ids]);
        const pages = await loadPages(db, [...new Set((rows ?? []).map((r) => String(r.id).toLowerCase()))]);
        const added = []; const per = new Map();
        for (const d of rows ?? []) {
          if (isPrivateDoc(d)) continue;
          const eid = String(d.entity_id).toLowerCase(); if ((per.get(eid) ?? 0) >= 3) continue;
          const mine = vals.filter((x) => x.id === eid); if (!mine.length) continue;
          const ps = pages.get(String(d.id).toLowerCase()) ?? [];
          const hit = ps.find((p) => mine.every((x) => pagePrints(p.text, x.v))) ?? ps.find((p) => mine.some((x) => pagePrints(p.text, x.v)));
          if (!hit) continue;
          per.set(eid, (per.get(eid) ?? 0) + 1);
          added.push({ type: d.document_type === 'invoice' ? 'invoice' : 'document', id: String(d.id), documentId: String(d.id), label: `${documentTypeLabel(d.document_type)} · ${d.original_filename ?? d.id}`, ...(hit.page ? { page: hit.page } : {}), sublabel: custs.find((c) => String(c.id).toLowerCase() === eid)?.label });
        }
        if (added.length) {
          data.records = [...data.records, ...added];
          if (!Number.isFinite(data.recordsTotal) || data.recordsTotal < data.records.length) data.recordsTotal = data.records.length;
          data.basis = `${String(data.basis ?? '').replace(/[.\s]+$/, '')}${data.basis ? '. ' : ''}The value is printed on the cited paper${added.length === 1 ? '' : 's'}.`.replace(/^\. /, '');
        }
      }
    }
  } catch (err) { console.error('provenance resolve failed, answer sent as it was:', err?.message); }
  return data;
}
