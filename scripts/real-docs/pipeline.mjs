// The real-document pipeline, run offline: the same functions upload (extractDocument.js) and Re-check (recheck.js) call,
// minus the database and the paid model. Used by scripts/verify-real-docs.mjs (the standing gate) and
// scripts/real-docs/independent-check.mjs. `tree` = repo root to load the app code from (lets a baseline copy run too).
//
// Stubs (stated in every report): (1) the vision transcription for photos / PDFs the text-layer reader refuses is replaced
// by test-docs/real-docs/pages.json's stand-in text (pdftotext / tesseract); (2) the extraction model returns no fields
// and, as its type guess, the page's own title line (classifyFromText) - so every fact counted here was read by the
// deterministic reader alone; (3) "linked" = the document names a customer or a service address (the pipeline creates or
// matches a customer from either).
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const TENANT_NAME = 'Sonoran Comfort Air';
export const TODAY = '2026-10-22';

export async function loadPipeline(tree) {
  const lib = (p) => import(pathToFileURL(path.join(tree, 'api/_lib', p)).href);
  const [te, ef, dt, lf, oc, sr] = await Promise.all([
    lib('modelAvoidance/textExtract.js'), lib('extractFields.js'), lib('documentTypes.js'),
    lib('modelAvoidance/labelFill.js'), lib('modelAvoidance/ownCompany.js'), lib('modelAvoidance/storedTextReread.js'),
  ]);
  let rs = null;
  try { rs = await lib('modelAvoidance/retype.js'); } catch { rs = null; } // present after the docread round only
  return { te, ef, dt, lf, oc, sr, rs };
}

/** One document through upload: text reader -> (stub model) -> stored-text read -> type -> label/prose fill -> auto-check. */
export function runDoc(P, doc, { ownNames = [TENANT_NAME], today = TODAY } = {}) {
  const { te, ef, dt, lf, oc, sr, rs } = P;
  const pages = (doc.pages ?? []).map((p) => ({ page_no: p.page_no, text: p.text ?? '' }));
  const filename = doc.filename;
  const highestPage = pages.reduce((n, p) => Math.max(n, p.page_no || 0), 0) || 1;
  const hasText = pages.some((p) => p.text.trim());
  if (!hasText) return { filename, type: null, fields: [], verdict: { ok: false, reason: 'unreadable' }, needsPerson: true };

  const det = te.extractFromText(pages, { pack: null, ownNames, generic: true });
  let toolInput;
  if (det?.accepted) toolInput = det.toolInput;
  else {
    let title = null;
    try { title = te.classifyFromText(pages)?.type ?? null; } catch { title = null; }
    toolInput = { fields: [], document_type: title };
  }
  let { fields } = ef.normalizeFields(toolInput.fields, { pageCount: highestPage, today });
  fields = fields.filter((f) => !((f.field_key === 'customer_name' || f.field_key === 'vendor') && dt.isLabelValue(f.value)));
  try { fields = oc.issuerNotCustomer(fields, pages, ownNames).fields; } catch { /* as ingest */ }
  fields = oc.applyOwnCompanyGuard(fields, ownNames).fields;
  if (!fields.length) {
    const rr = sr.planStoredTextRead({ documentType: null, storedType: null, filename, pages, ownNames, pack: null, pageCount: highestPage, today });
    if (rr.add.length) fields = rr.add;
  }
  let facts = Object.fromEntries(fields.map((f) => [f.field_key, f.value]));
  let type = dt.resolveDocumentType(toolInput, facts, filename, null).documentType;
  // docread round: classification anchors on the page ("ACORD 25", "License No." + board) decide the type when they apply.
  if (rs?.retypeDecision) {
    const next = rs.retypeDecision({ currentType: type, filename, pages, fields });
    if (next) type = next.to;
  }
  const plan = lf.planLabelFill({ type, fields, pages, method: 'label-fill', pageCount: highestPage, ownNames, filename, today });
  if (plan.add.length) fields = [...fields, ...plan.add];
  fields = lf.corroborateFields({ type, fields, pages, ownNames }).fields;
  if (lf.crossCheckFields) fields = lf.crossCheckFields({ fields, pages }).fields; // docread verify round
  fields = oc.applyOwnCompanyGuard(fields, ownNames).fields;
  const text = pages.map((p) => p.text).join('\n').slice(0, 20000);
  const keys = new Set(fields.map((f) => f.field_key));
  const hasLink = keys.has('customer_name') || keys.has('service_address');
  const comp = dt.completenessFor(type, fields, null, { filename });
  const verdict = dt.autoCheckDecision(type, fields, { hasText, hasLink, filename, text });
  const setAside = verdict.reason === 'void' || verdict.reason === 'likely-copy';
  return { filename, type, fields, missing: comp.missing, verdict, needsPerson: !verdict.ok && !setAside, setAside };
}

/** Re-check of a document ALREADY stored with type `storedType` and fields `stored` (what the Inbox buttons run). */
export function recheckDoc(P, doc, { storedType, stored = [], ownNames = [TENANT_NAME], today = TODAY } = {}) {
  const { dt, lf, rs } = P;
  const pages = (doc.pages ?? []).map((p) => ({ page_no: p.page_no, text: p.text ?? '' }));
  let type = dt.normalizeDocumentType(storedType);
  let retyped = null;
  if (rs?.retypeDecision) { const r = rs.retypeDecision({ currentType: type, filename: doc.filename, pages, fields: stored }); if (r) { retyped = r; type = r.to; } }
  const plan = lf.planLabelFill({ type, fields: stored, pages, method: 'recheck', pageCount: pages.length, ownNames, filename: doc.filename, today });
  const after = [...stored, ...plan.add];
  const comp = dt.completenessFor(type, after, null, { filename: doc.filename });
  return { type, retyped, filled: plan.add, missing: comp.missing, required: comp.required };
}

/** Is a read value the same fact as a gold value? (dates normalised, money to the cent, names without case / punctuation,
 *  a period by its dates and length). Shared by the gate and the independent check. */
export function sameFact(P, key, a, b) {
  const date = (v) => P.ef.normalizeDate(String(v), { order: 'mdy' }) ?? String(v);
  const name = (v) => String(v).toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
  if (/(_date|_expires)$/.test(key)) return date(a) === date(b);
  if (key === 'cost') return Math.round(Number(String(a).replace(/[$,]/g, '')) * 100) === Math.round(Number(String(b).replace(/[$,]/g, '')) * 100);
  if (key === 'agreement_term') {
    const ds = (s) => [...String(s).matchAll(/\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Z][a-z]{2,8}\.? \d{1,2},? \d{4}|\d{1,2} [A-Z][a-z]{2,8} \d{4}/g)].map((m) => date(m[0])).sort().join('|');
    const len = (s) => (/(\d+)\s*(month|year)/i.exec(String(s)) ?? []).slice(1, 3).join(' ').toLowerCase();
    // a read period with no dates ("60 months") is judged on its length alone
    if (!ds(a) && len(a)) return len(a) === len(b);
    return ds(a) === ds(b) && (!len(b) || len(a) === len(b));
  }
  return name(a) === name(b);
}

/** Judge one document's read facts against hand-known gold: {correct, wrong:[...], missed:[...]} */
export function judgeDoc(P, readFields, gold, partyAnyOf = null, forbidden = []) {
  const got = (k) => readFields.filter((f) => (f.field_key ?? f.k) === k).map((f) => String(f.value ?? f.v));
  let correct = 0; const wrong = [], missed = [];
  for (const [k, v] of Object.entries(gold ?? {})) {
    const vals = got(k);
    if (!vals.length) missed.push({ key: k, value: v });
    else if (vals.some((x) => sameFact(P, k, x, v))) correct++;
    else wrong.push({ key: k, expected: v, read: vals.join(' | ') });
  }
  for (const k of ['customer_name', 'vendor']) {
    if (gold?.[k] || !partyAnyOf) continue;
    for (const x of got(k)) { if (partyAnyOf.some((p) => sameFact(P, k, x, p))) correct++; else wrong.push({ key: k, expected: partyAnyOf.join(' / '), read: x }); }
  }
  for (const f of forbidden ?? []) if (got(f.key).some((x) => sameFact(P, f.key, x, f.value))) wrong.push({ key: f.key, expected: '(must not be read)', read: f.value });
  return { correct, wrong, missed };
}
