/**
 * privacy/privateDocs.js - ONE definition of "a private paper", imported by every lane that counts, lists, looks up, searches or cites documents.
 *
 * Private papers are People / HR papers (document type hr-letter). Only an admin sees them in the app; Donovan never counts, names,
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

export function isPrivateDocType(t) { return PRIVATE_DOC_TYPES.has(normType(t)); }
export function isPrivateDoc(doc) { return !!doc && isPrivateDocType(doc.document_type ?? doc.documentType ?? doc.type); }
export function dropPrivate(rows) { return Array.isArray(rows) ? rows.filter((r) => !isPrivateDoc(r)) : rows; }

const typesSql = () => [...PRIVATE_DOC_TYPES].map((t) => `'${t}'`).join(', ');
export function notPrivateSql(alias = 'd') {
  const a = alias ? `${alias}.` : '';
  return `replace(lower(COALESCE(${a}document_type, '')), '_', '-') NOT IN (${typesSql()})`;
}
export function notPrivateIdSql(col = 'document_id') {
  return `(${col} IS NULL OR ${col} NOT IN (SELECT pd.id FROM documents pd WHERE pd.${TENANT} AND replace(lower(COALESCE(pd.document_type, '')), '_', '-') IN (${typesSql()})))`;
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
export function isPrivateDocAsk(question) {
  const q = String(question ?? '');
  if (q.length > 300) return false;
  return ASK_RES.some((re) => re.test(q));
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
