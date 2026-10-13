/**
 * privacy/privateDocs.js - ONE definition of "a private paper", imported by every lane that counts, lists, looks up, searches or cites documents.
 *
 * Private papers are People / HR papers: type hr-letter plus any paper whose type, audience and text score as staff / HR (see the R21 score rule below). Only an admin sees them in the app; Donovan never counts, names,
 * lists, groups, totals, cites or searches them. (Internal-audience papers have their own rule: audience/sql.js; DQL applies both,
 * dql/snapshot.js. Papers that are internal-audience AND hr-letter are private either way.)
 *
 *   isPrivateDocType(t)            JS test on a document_type string ("hr-letter", "hr_letter", "HR-Letter" all count)
 *   isPrivateDoc(doc)              JS test on a row/record carrying document_type (or type)
 *   dropPrivate(rows)              rows without the private ones (rows with no type pass: callers filter before the type is known)
 *   notPrivateSql(alias)           WHERE-safe fragment, TRUE for papers a lane may use; alias = the documents table alias
 *   notPrivateIdSql(col)           WHERE-safe fragment for a table with only a document_id column (extractions, links, financials, pages):
 *                                  TRUE when that document is not private. Tenant-scoped through the same TENANT_SQL text scope.js exports.
 *   isPrivateDocAsk(question)      true when the question directly asks for HR / employee / personnel / disciplinary / offer letters
 *   PRIVATE_DOCS_REPLY             the honest reply for that question (no count, no names)
 */
export const PRIVATE_DOC_TYPES = new Set(['hr-letter']);

const TENANT = "tenant_id = (current_setting('app.tenant_id', true))::uuid";
const normType = (t) => String(t ?? '').trim().toLowerCase().replace(/_/g, '-');

/**
 * ROUND 21 - general, data-driven detection of private staff / HR papers (businesses name them their own way: trainer-complaint,
 * driver-accident-claim, manager-warning, engineer-pip ...). Never reads a factory label; reads only what any customer's export has.
 *
 * SCORE of one paper (private when score >= 3):
 *   type id, normalised to lower-case words joined by "-" :
 *     3  a STRONG word (hr, personnel, employee, disciplinary, write-up, pip, termination, payroll, offer letter, background check,
 *        grievance, performance review/file, conduct, new hire)            e.g. hr-letter, groomer-writeup, tech-discipline-memo
 *     3  a STAFF ROLE word + an EVENT word (trainer, driver, manager, crew ... + complaint, warning, review, claim, incident ...)
 *                                                                           e.g. trainer-complaint, driver-accident-claim, crew-injury-report
 *     2  counseling / grievance-style words alone                            e.g. counseling-note
 *     1  an EVENT word alone                                                 e.g. incident-report, detention-claim (stays public whatever else it says)
 *     0  a customer-side word (customer, client, member, guest, tenant, patient ...) or a form/receipt/invoice/order word, unless STRONG
 *   +1 the extraction audience is "internal"
 *   +0..2 page text markers (employee / personnel file / human resources / disciplinary / grievance / payroll / HR  = 1,  "confidential" = 1)
 *   +1 (JS callers only) the people named are the company's staff, not its customers - counted only when the type already scored >= 1
 * Page text and audience are only looked at when the type scored 1 or 2 (or the paper is internal), so a plain customer paper never pays for them.
 * A customer complaint, a guest's accident report, an incident report, a claim letter score <= 2 and stay public.
 */
const B = '(^|[^a-z0-9])';
const E = '([^a-z0-9]|$)';
const wrap = (alt) => `${B}(?:${alt})${E}`;
const RX = {
  strong: wrap('hr|human-resources?|personnel|employees?|employment|staff-?files?|disciplin[a-z]*|write-?ups?|written-up|pips?|payroll|offer-?letters?|background-?checks?|grievances?|performance-?(?:review|file|plan|eval[a-z]*)|conduct|new-?hires?|i-?9|w-?4'),
  role: wrap('staff|trainers?|drivers?|managers?|engineers?|groomers?|shooters?|stylists?|tutors?|preparers?|caregivers?|techs?|technicians?|crew|volunteers?|clerks?|agents?|inspectors?|billers?|dockhands?|assistants?|teachers?|nurses?|cashiers?|servers?|baristas?|mechanics?|installers?|cleaners?|dispatchers?|foremen|foreman|coaches|coach|instructors?|workers?|associates?|receptionists?|hygienists?|housekeepers?|janitors?|cooks?|chefs?|bartenders?|sitters?|counselors?|pastors?|deckhands?|operators?|auditors?|roofers?|laborers?|supervisors?|brokers?|realtors?|handlers?|attendants?|lifeguards?'),
  event: wrap('terminations?|warnings?|complaints?|evaluations?|reviews?|feedback|incidents?|accidents?|injur[a-z]*|claims?|memos?|compliance|counseling|coaching|misconduct|violations?'),
  counsel: wrap('counseling|grievances?|misconduct'),
  cust: wrap('customers?|clients?|members?|guests?|tenants?|patients?|owners?|buyers?|visitors?|residents?|students?|parents?|donors?|vendors?|public|passengers?|shippers?|consumers?|shoppers?|patrons?|renters?|campers?|families|family|service|product|vehicle|property|cargo|equipment|machine'),
  form: wrap('forms?|surveys?|receipts?|invoices?|orders?|tickets?|quotes?|estimates?|statements?|certificates?|licen[sc]es?|permits?|waivers?|contracts?|agreements?|enrollment|registrations?|applications?|policy|binder|schedule|sheet|slips?'),
};
const TEXT = {
  mark: `${B}(?:hr|human resources|employees?|personnel file|disciplinary|grievance|payroll|termination|staff member|supervisor)${E}`,
  conf: `${B}confidential${E}`,
};
const rx = Object.fromEntries(Object.entries(RX).map(([k, v]) => [k, new RegExp(v)]));
const trx = Object.fromEntries(Object.entries(TEXT).map(([k, v]) => [k, new RegExp(v)]));

/** Score of the type id alone: 3 (private), 2, 1 or 0. */
export function typeScore(t) {
  const x = normType(t);
  if (!x) return 0;
  if (rx.strong.test(x)) return 3;
  if (rx.form.test(x) || rx.cust.test(x)) return 0;
  const ev = rx.event.test(x);
  if (ev && rx.role.test(x)) return 3;
  if (rx.counsel.test(x)) return 2;
  return ev ? 1 : 0;
}
/** Full score: {type, audience, text (page text, any case), staffNamed}. */
export function privateScore({ type, audience, text, staffNamed } = {}) {
  const ts = typeScore(type);
  if (ts >= 3) return ts;
  const aud = String(audience ?? '').toLowerCase() === 'internal' ? 1 : 0;
  if (ts === 1 || ts + aud < 1) return ts; // an event word alone never becomes private through audience / text: an internal incident log or claim letter stays a company paper
  const tx = String(text ?? '').toLowerCase();
  const t = (trx.mark.test(tx) ? 1 : 0) + (trx.conf.test(tx) ? 1 : 0);
  return ts + aud + t + (staffNamed && ts >= 1 ? 1 : 0);
}
export const PRIVATE_SCORE_MIN = 3;
export function isPrivateDocType(t) { return PRIVATE_DOC_TYPES.has(normType(t)) || typeScore(t) >= PRIVATE_SCORE_MIN; }
export function isPrivateDoc(doc) {
  if (!doc) return false;
  return privateScore({ type: doc.document_type ?? doc.documentType ?? doc.type, audience: doc.audience, text: doc.text, staffNamed: doc.staffNamed }) >= PRIVATE_SCORE_MIN
    || PRIVATE_DOC_TYPES.has(normType(doc.document_type ?? doc.documentType ?? doc.type));
}
export function dropPrivate(rows) { return Array.isArray(rows) ? rows.filter((r) => !isPrivateDoc(r)) : rows; }

/** SQL text of the same rule over a documents row (alias '' = the bare documents table). TRUE when the paper IS private. */
function privateExpr(alias) {
  const a = alias ? `${alias}.` : '';
  const row = alias || 'documents';
  const T = `replace(lower(COALESCE(${a}document_type, '')), '_', '-')`;
  const m = (k) => `${T} ~ '${RX[k]}'`;
  const strong = `(${m('strong')})`;
  const roleEvent = `(${m('event')} AND ${m('role')} AND NOT ${m('form')} AND NOT ${m('cust')})`;
  const base = `(CASE WHEN ${m('form')} OR ${m('cust')} THEN 0 WHEN ${m('counsel')} THEN 2 WHEN ${m('event')} THEN 1 ELSE 0 END)`;
  const aud = `(CASE WHEN COALESCE(to_jsonb(${row})->>'audience', '') = 'internal' THEN 1 ELSE 0 END)`;
  const pg = `FROM document_pages pp WHERE pp.document_id = ${a}id AND pp.${TENANT} AND lower(pp.text)`;
  const txt = `((CASE WHEN EXISTS (SELECT 1 ${pg} ~ '${TEXT.mark}') THEN 1 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 ${pg} ~ '${TEXT.conf}') THEN 1 ELSE 0 END))`;
  const ids = [...PRIVATE_DOC_TYPES].map((t) => `'${t}'`).join(', ');
  return `(CASE WHEN ${T} IN (${ids}) OR ${strong} THEN TRUE WHEN ${roleEvent} THEN TRUE WHEN ${base} = 1 OR ${base} + ${aud} < 1 THEN FALSE ELSE (${base} + ${aud} + ${txt} >= ${PRIVATE_SCORE_MIN}) END)`;
}
export function notPrivateSql(alias = 'd') { return `NOT ${privateExpr(alias)}`; }
export function notPrivateIdSql(col = 'document_id') {
  return `(${col} IS NULL OR ${col} NOT IN (SELECT pd.id FROM documents pd WHERE pd.${TENANT} AND ${privateExpr('pd')}))`;
}

const HR_NOUN = String.raw`(?:hr|h\.r\.|human\s+resources?|employ(?:ee|ment|ees)|personnel|disciplinary|new[-\s]hire)`;
const ASK_RES = [
  new RegExp(String.raw`\b${HR_NOUN}[’']?s?\s+(?:letters?|documents?|docs?|papers?|paperwork|files?|records?|forms?|notices?|write-?ups?|agreements?|contracts?|offers?)\b`, 'i'),
  /\b(?:offer|employment|disciplinary|employee\s+termination|employee\s+warning)\s+letters?\b/i,
  /\b(?:personnel|employee|hr)\s+(?:file|files|folder|records?)\b/i,
  /\bnew[-\s]hire\s+(?:paperwork|forms?|packets?|documents?)\b/i,
  /\bform\s+(?:w-?4|i-?9)\b|\b(?:w-4|i-9)\b/i,
  /\bhr\s+(?:letters?|stuff|papers?|paperwork|documents?|files?)\b/i,
  /\bhr[-_]letter\b/i, // a file name or type id
  /\bq?\d*-?hr-?letter/i,
  /\bwrite-?ups?\b[^?]{0,30}\b(?:employees?|techs?|staff)\b/i,
];
// R21: a phrase like "trainer complaints" / "driver accident claims" is a private paper name when its words, joined like a type id, score as private.
const ASK_NOUN = /^(?:pips?|disciplines?|complaints?|warnings?|reviews?|evaluations?|claims?|write-?ups?|memos?|notes?|reports?|feedback|files?|letters?|records?|papers?|documents?|docs?|incidents?|counseling|grievances?)$/;
const ASK_NOT_AFTER = /^(?:lights?|signs?|labels?|lamps?|alarms?|buzzers?|codes?)$/;
export function privateTypePhrase(question) {
  const w = String(question ?? '').toLowerCase().replace(/[’']s\b/g, '').replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean);
  for (let i = 0; i < w.length; i++) {
    if (!ASK_NOUN.test(w[i]) || ASK_NOT_AFTER.test(w[i + 1] ?? '')) continue;
    for (let n = 1; n <= 3 && i - n >= 0; n++) {
      const phrase = w.slice(i - n, i + 1).join('-');
      const ts = typeScore(phrase.replace(/-(?:reports?|notes?|files?|letters?|records?|papers?|documents?|docs?)$/, '').replace(/s$/, ''));
      if (ts >= PRIVATE_SCORE_MIN || ts === 2) return phrase; // 2 = counselling / grievance papers: asked about by name they are private too
    }
  }
  return null;
}
export function isPrivateDocAsk(question) {
  const q = String(question ?? '');
  if (q.length > 300) return false;
  return ASK_RES.some((re) => re.test(q)) || privateTypePhrase(q) != null;
}

/** Proposed owner-approval wording. */
export const PRIVATE_DOCS_REPLY = 'HR and employee letters are private, so I leave them out of my answers.';

/** The ids of `ids` that are NOT private (one tenant-scoped query), order kept. For lanes that gather document ids from links before they read the documents. */
export async function withoutPrivateIds(db, ids) {
  const list = [...new Set((ids ?? []).filter((x) => typeof x === 'string' || x != null).map(String))];
  if (!list.length) return [];
  const { rows } = await db.raw(`SELECT d.id FROM documents d WHERE d.id = ANY($1::uuid[]) AND d.${TENANT} AND ${notPrivateSql('d')}`, [list]);
  const keep = new Set(rows.map((r) => String(r.id)));
  return list.filter((x) => keep.has(x));
}
