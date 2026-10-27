/**
 * Page text -> document type + fields + a one-line summary, for the public demo. This is extractDocument.js's own chain with the
 * database taken out (the same functions in the same order, the way scripts/real-docs/pipeline.mjs runs them offline):
 *
 *   1. deterministic text extractor           (no model; accepts a document only when every line is explained)
 *   2. FREE-FIRST gate                        (no model when the free readers already complete the document)
 *   3. otherwise ONE Haiku extraction call    (EXTRACT_TOOL; a value the model gives must quote the page, else it is dropped)
 *   4. stored-text read, retype, label fill, corroboration, cross-check, own-company guard, people / ID guard
 *
 * Then the sensitive-field rule (mask.js) is applied to what the visitor will see. The model, when it is used, is injected
 * (`extract`) so the tests stub it; it is told nothing but the page text, never a tenant, and nothing here reads or writes a database.
 * Never logs a value.
 */
import { extractFromText } from '../../modelAvoidance/textExtract.js';
import { freeReadCompletes } from '../../modelAvoidance/freeFirst.js';
import { planLabelFill, corroborateFields, crossCheckFields } from '../../modelAvoidance/labelFill.js';
import { dropPeopleIdFacts } from '../../modelAvoidance/peopleShape.js';
import { verifyGrounded } from '../../modelAvoidance/groundedFacts.js';
import { retypeDecision } from '../../modelAvoidance/retype.js';
import { applyOwnCompanyGuard, issuerNotCustomer } from '../../modelAvoidance/ownCompany.js';
import { planStoredTextRead } from '../../modelAvoidance/storedTextReread.js';
import { normalizeFields, buildExtractPrompt, buildExtractToolForPack, selectPages, FIELD_SPECS } from '../../extractFields.js';
import { resolveDocumentType, documentTypeDisplayLabel, fieldLabel, isLabelValue, isSyntheticKey, isShopInternalDocument } from '../../documentTypes.js';
import { isFragmentName } from '../../integrity.js';
import { maskField, maskText } from './mask.js';
import { ID_DOC_TYPES } from '../../modelAvoidance/idDocFields.js';
import { hasIdStructure, hasCardData, hasLongIdNumber } from '../../modelAvoidance/peopleShape.js';

const EXTRACT_STATIC_MARKER = 'Read the pages and return every field the text actually states';
/** Same split extractDocument.js makes (the stable half is cacheable); kept here so this file needs no database import. */
export function splitPrompt(full) {
  const text = String(full ?? '');
  const i = text.indexOf(EXTRACT_STATIC_MARKER);
  return i === -1 ? { dynamic: text, stable: '' } : { dynamic: text.slice(0, i).trimEnd(), stable: text.slice(i).trimEnd() };
}

const MAX_FIELDS = 20;
const readableChars = (pages) => (pages ?? []).reduce((n, p) => n + String(p?.text ?? '').replace(/\s+/g, '').length, 0);

/**
 * @param {{pages: {page_no:number,text:string}[], filename?: string, pack?: object|null, today?: string,
 *   extract?: null | ((req: {system: string, user: string, tool: object}) => Promise<{input: object|null}|null>)}} a
 * @returns {Promise<{type: string, typeLabel: string, fields: object[], shown: {key:string,label:string,value:string,masked:boolean}[],
 *   how: 'free'|'model', readable: boolean, modelUsed: boolean}>}
 */
export async function analyzePages({ pages, filename = '', pack = null, today = new Date().toISOString().slice(0, 10), extract = null }) {
  const ownNames = []; // the visitor is nobody's tenant: no "our company" to protect
  const sel = selectPages(pages ?? []);
  const selected = sel.pages;
  const highestPage = (pages ?? []).reduce((n, p) => Math.max(n, Number(p.page_no) || 0), 0) || 1;
  if (readableChars(selected) < 20) return { type: 'other', typeLabel: documentTypeDisplayLabel('other', { filename, pack }), fields: [], shown: [], how: 'free', readable: false, modelUsed: false };

  const det = !sel.truncated ? extractFromText(selected, { pack, ownNames, generic: true }) : null;
  const free = !det?.accepted && !sel.truncated ? freeReadCompletes({ pages: selected, filename: filename || null, ownNames, pack, highestPage, today }) : null;
  let toolInput = null;
  let modelUsed = false;
  if (det?.accepted) toolInput = det.toolInput;
  else if (free?.skip) toolInput = { fields: [], document_type: free.titleType ?? null };
  else if (extract) {
    const tool = buildExtractToolForPack(pack);
    const promptType = undefined;
    const { dynamic, stable } = splitPrompt(buildExtractPrompt(selected, promptType, pack, { ownNames }));
    const r = await extract({ system: stable, user: dynamic, tool });
    if (r?.input) { toolInput = r.input; modelUsed = true; }
  }
  if (!toolInput) toolInput = { fields: [], document_type: null }; // model not available (cap, timeout): the free readers below still run

  let { fields } = normalizeFields(toolInput.fields, { pageCount: highestPage, pack, today });
  if (modelUsed) {
    // a model value is trusted only when the quote it returned is on its page (extractDocument.js, grounding)
    fields = fields.map((f) => {
      const g = verifyGrounded({ field_key: f.field_key, value: f.value, verbatim: f.verbatim, page_no: f.page_no }, selected);
      return g.ok ? f : { ...f, confidence: Math.min(Number(f.confidence) || 0, 0.6), flags: [...(f.flags ?? []), 'ungrounded'] };
    });
  }
  fields = fields.filter((f) => !(f.field_key === 'customer_name' && isFragmentName(f.value)));
  fields = fields.filter((f) => !((f.field_key === 'customer_name' || f.field_key === 'vendor') && isLabelValue(f.value)));
  try { fields = issuerNotCustomer(fields, selected, ownNames).fields; } catch { /* as ingest */ }
  fields = applyOwnCompanyGuard(fields, ownNames).fields;
  if (!fields.length) {
    try {
      const rr = planStoredTextRead({ documentType: null, storedType: null, filename, pages: selected, ownNames, pack, pageCount: highestPage, today });
      if (rr.add.length) fields = rr.add;
    } catch { /* nothing read stays nothing read */ }
  }
  let facts = Object.fromEntries(fields.map((f) => [f.field_key, f.value]));
  let type = isShopInternalDocument(fields) ? 'internal' : resolveDocumentType(toolInput, facts, filename, pack).documentType;
  try { const rt = retypeDecision({ currentType: type, filename: filename || null, pages: selected, fields }); if (rt) type = rt.to; } catch { /* keep type */ }
  try {
    const plan = planLabelFill({ type, fields, pages: selected, method: 'label-fill', pageCount: highestPage, ownNames, filename: filename || null, today });
    if (plan.add.length) fields = [...fields, ...plan.add];
  } catch { /* extraction kept as is */ }
  try { fields = corroborateFields({ type, fields, pages: selected, ownNames }).fields; } catch { /* as is */ }
  try { fields = crossCheckFields({ fields, pages: selected }).fields; } catch { /* as is */ }
  fields = applyOwnCompanyGuard(fields, ownNames).fields;
  fields = dropPeopleIdFacts(type, fields).fields;

  const idDoc = isPersonIdPaper(type, selected);
  return {
    type,
    typeLabel: documentTypeDisplayLabel(type, { filename, pack }),
    fields,
    shown: shownFields(fields, pack, { id: idDoc }),
    idDoc,
    how: modelUsed ? 'model' : 'free',
    readable: true,
    modelUsed,
  };
}

/** A driver license / certification card / HR form / insurance card (by type or by the shape of its text): masked harder (mask.js). */
export function isPersonIdPaper(type, pages) {
  if (ID_DOC_TYPES.has(type) || type === 'hr-letter') return true;
  try {
    const lines = (pages ?? []).flatMap((p) => String(p.text ?? '').split('\n'));
    return hasIdStructure(lines) || hasCardData(lines) || hasLongIdNumber(lines);
  } catch { return false; }
}

/** The fields the visitor sees: confident, grounded, labelled, masked per the sensitive-field rule, capped. Pure. */
export function shownFields(fields, pack = null, opts = {}) {
  const out = [];
  const seen = new Set();
  for (const f of fields ?? []) {
    const key = String(f.field_key ?? '');
    if (!key || isSyntheticKey(key) || key.endsWith('_unconfirmed') || (f.flags ?? []).includes('ungrounded')) continue;
    if ((Number(f.confidence) || 0) < 0.5) continue;
    const raw = String(f.corrected_value ?? f.value ?? '').trim();
    if (!raw) continue;
    const m = maskField(key, raw, opts);
    if (m.value == null) continue; // a birth date is not shown at all
    const sig = `${key}|${m.value}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push({ key, label: LABEL_OVERRIDE[key] ?? fieldLabel(key, pack) ?? key.replace(/_/g, ' '), value: pretty(key, m.value, m.masked).slice(0, 240), masked: m.masked });
    if (out.length >= MAX_FIELDS) break;
  }
  return out;
}

const KIND = new Map(FIELD_SPECS.map((f) => [f.key, f.kind]));
const LABEL_OVERRIDE = { cost: 'Total amount' };
/** Money as $1,284.50 and ISO dates as 14 Mar 2026 (masked values are left exactly as masked). */
function pretty(key, value, masked) {
  if (masked) return value;
  const kind = KIND.get(key);
  if (kind === 'money' && /^-?[\d,]+(?:\.\d+)?$/.test(value)) return money(value) ?? value;
  if (kind === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return niceDate(value);
  return value;
}
const PARTY_KEYS = ['customer_name', 'vendor', 'holder_name', 'employee_name', 'manager'];
const DATE_KEYS = ['service_date', 'invoice_date', 'end_date', 'start_date', 'signed_date'];
const money = (v) => { const n = Number(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : null; };
const niceDate = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) return String(s);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m[2] - 1];
  return mon ? `${+m[3]} ${mon} ${m[1]}` : String(s);
};

/** A short factual summary built only from the masked fields the visitor sees (no model, so no cost and nothing invented). Pure. */
export function summarize({ typeLabel, shown, pageCount }) {
  const by = new Map();
  for (const f of shown ?? []) if (!by.has(f.key)) by.set(f.key, f);
  const party = PARTY_KEYS.map((k) => by.get(k)).find(Boolean);
  const dateKey = DATE_KEYS.find((k) => by.has(k));
  const date = dateKey ? by.get(dateKey) : null;
  const amount = by.get('cost') ? money(by.get('cost').value) : null;
  const number = by.get('invoice_number') ?? by.get('document_number') ?? null;
  const bits = [];
  bits.push(`${/^[aeiou]/i.test(typeLabel) ? 'An' : 'A'} ${String(typeLabel).toLowerCase()}`);
  if (party) bits[0] += ` ${party.key === 'vendor' ? 'from' : party.key === 'customer_name' ? 'for' : 'for'} ${party.value}`;
  if (number) bits[0] += ` (${number.value})`;
  const tail = [];
  if (date) tail.push(`${dateKey === 'end_date' ? 'ends' : dateKey === 'start_date' ? 'starts' : 'dated'} ${niceDate(date.value)}`);
  if (amount) tail.push(`totalling ${amount}`);
  let s = bits[0] + (tail.length ? ', ' + tail.join(', ') : '') + '.';
  const n = (shown ?? []).length;
  s += ` ${n} ${n === 1 ? 'field' : 'fields'} found across ${pageCount} ${pageCount === 1 ? 'page' : 'pages'}.`;
  return maskText(s);
}
