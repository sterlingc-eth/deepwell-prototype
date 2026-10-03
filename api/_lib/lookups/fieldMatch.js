/**
 * Field match: the field asked must be the field returned. A question about ONE named customer asking for
 *   - the installer ("who installed X's AC") is answered from the install record (an invoice whose work starts "Install", else a start-up
 *     sheet) - never the last service technician;
 *   - an invoice number returns invoice numbers - never a phone number; a phone number question returns the phone - never an invoice number.
 * Customer = a stored customer name appearing whole in the question; no/ambiguous match or no data -> null (falls through to the normal chain).
 * Kill switch: DONOVAN_FIELD_MATCH=0.
 * pure: parseFieldQuestion     db: runFieldMatch
 */
import { attachCitations } from "../citations/records.js";
import { documentRecordsFor } from "../citations/enrich.js";
import { TENANT_SQL, answerEnvelope } from "../scope.js";

const INSTALL_W = String.raw`(?:inst+a+l+\w*|installd|put\s+in|set\s+up|setup)`;
const INSTALLER_RE = new RegExp(String.raw`\b(?:who(?:'?s)?\b.*\b${INSTALL_W}|(?:which|what)\s+(?:tech\w*|guy|crew|company|contractor)\b.*\b${INSTALL_W}|\b${INSTALL_W}\s+by\b|installers?\b|inst+a+l+\s+tech\w*|install\s+guy|inst+a+l+\w*\s+(?:tech\w*|guy|crew)\b)`, "i");
const INSTALL_DATE_RE = /\b(?:when|date|what\s+day|how\s+long|how\s+old|year)\b/i;
const INVNUM_RE = /\b(?:(?:inv\w*|bill)\s*(?:number|num|no\.?|nbr|#)(?![a-z0-9])|(?:number|num|nbr|#)\s*(?:of|for|on)\s+(?:the\s+)?(?:inv\w*|bill)|which\s+inv\w*)/i;
const PHONE_RE = /\b(?:fone|phne|cell|mobile|telephone|how\s+(?:do|can|should)\s+i\s+call|number\s+to\s+call)\b/i;
const BRAND_RE = /\b(?:trane|carrier|goodman|lennox|rheem|ruud|york|daikin|amana|bryant|payne|american standard|mitsubishi|fujitsu|heil|tempstar|coleman|nordyne|armstrong|maytag|ducane|comfortmaker|miller|janitrol)\b|\b\d{3,}\b|\b(?:isn'?t|not|never|wasn'?t|without|no)\b/i;
const SKIP_RE = /\b(?:how many|count|list|all|every|total|sum|average|avg|most|least|vs|versus|compared?|anyone|any|last|recent|latest|email|e-mail|address|quote|estimate)\b|\b[A-Z]{1,4}-\d{3,}\b/i;

/** Pure. @returns {question, field: 'installer'|'invoice_number'|'phone'} or null. */
export function parseFieldQuestion(question) {
  if (process.env.DONOVAN_FIELD_MATCH === "0") return null;
  const raw = String(question ?? "").replace(/[’`]/g, "'").trim();
  if (!raw || raw.length > 200) return null;
  if (INSTALLER_RE.test(raw) && !BRAND_RE.test(raw) && !INSTALL_DATE_RE.test(raw) && !/\b(?:how many|count|list|all|every)\b/i.test(raw)) return { question: raw, field: "installer" };
  if (SKIP_RE.test(raw.replace(/\blast\b/gi, ""))) return null;
  if (INVNUM_RE.test(raw)) return { question: raw, field: "invoice_number" };
  if (PHONE_RE.test(raw) && !/\binv\w*|\bbill\b|\bpo\b/i.test(raw)) return { question: raw, field: "phone" };
  return null;
}

const norm = (s) => String(s ?? "").toLowerCase().replace(/'s\b/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const dateLabel = (d) => { const x = new Date(`${String(d ?? "").slice(0, 10)}T12:00:00Z`); return Number.isNaN(+x) ? null : x.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }); };

export async function runFieldMatch(db, intent) {
  const { rows: ents } = await db.raw(
    `SELECT id, data->>'customer_name' AS n, data->>'phone' AS phone FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL} AND length(coalesce(data->>'customer_name','')) >= 5`, []);
  const q = ` ${norm(intent.question)} `;
  const hits = ents.filter((r) => q.includes(` ${norm(r.n)} `));
  const keys = [...new Set(hits.map((r) => norm(r.n)))].filter((a, _, all) => !all.some((b) => b !== a && b.includes(a)));
  if (keys.length !== 1) return null;
  const mine = hits.filter((r) => norm(r.n) === keys[0]);
  const display = mine[0].n;
  const ids = mine.map((r) => r.id);

  if (intent.field === "phone") {
    const phones = [...new Set(mine.map((r) => r.phone).filter(Boolean))];
    if (phones.length !== 1) return null;
    const { rows: docs } = await db.raw(`SELECT DISTINCT document_id FROM document_entity_links WHERE entity_id = ANY($1::uuid[]) AND ${TENANT_SQL} LIMIT 3`, [ids]);
    return attachCitations(answerEnvelope({ text: `${display}'s phone is ${phones[0]}.`, facts: [{ label: "Phone", value: phones[0], sources: [] }], extra: { fastIntent: "field_match" } }),
      { records: docs.length ? await documentRecordsFor(db, docs.map((r) => r.document_id)) : [], total: docs.length, basis: `Read the customer record for ${display}.` });
  }

  if (intent.field === "invoice_number") {
    const { rows } = await db.raw(
      `SELECT f.document_id, f.invoice_number AS no, f.invoice_date::text AS d FROM document_financials f JOIN documents d ON d.id = f.document_id AND d.${TENANT_SQL}
        WHERE f.${TENANT_SQL} AND d.document_type = 'invoice' AND f.invoice_number IS NOT NULL AND regexp_replace(lower(f.customer_name), '[^a-z0-9 ]+', ' ', 'g') = $1
        ORDER BY f.invoice_date DESC NULLS LAST`, [keys[0]]);
    if (!rows.length) return null;
    const line = (r) => `${r.no}${dateLabel(r.d) ? ` (${dateLabel(r.d)})` : ""}`;
    const text = rows.length === 1 ? `${display}'s invoice number is ${line(rows[0])}.` : `${display} has ${rows.length} invoices on file: ${rows.slice(0, 8).map(line).join("; ")}.`;
    return attachCitations(answerEnvelope({ text, facts: rows.slice(0, 20).map((r) => ({ label: "Invoice number", value: line(r), sources: [{ documentId: r.document_id, location: { field: "invoice_number" } }] })), extra: { fastIntent: "field_match" } }),
      { records: await documentRecordsFor(db, rows.map((r) => r.document_id)), total: rows.length, basis: `Read the invoice numbers on ${display}'s invoices.` });
  }

  // installer: the install record = a document linked to the customer whose work starts "Install" (invoice) or a start-up sheet.
  const { rows } = await db.raw(
    `SELECT DISTINCT d.id AS document_id, d.document_type, t.value AS tech, coalesce(i.value, sd.value) AS dt
       FROM document_entity_links l JOIN documents d ON d.id = l.document_id AND d.${TENANT_SQL}
       JOIN extractions t ON t.document_id = d.id AND t.field_key = 'technician' AND t.${TENANT_SQL}
       LEFT JOIN extractions w ON w.document_id = d.id AND w.field_key = 'work_performed' AND w.${TENANT_SQL}
       LEFT JOIN extractions i ON i.document_id = d.id AND i.field_key = 'installation_date' AND i.${TENANT_SQL}
       LEFT JOIN extractions sd ON sd.document_id = d.id AND sd.field_key = 'service_date' AND sd.${TENANT_SQL}
      WHERE l.entity_id = ANY($1::uuid[]) AND l.${TENANT_SQL}
        AND ((d.document_type = 'invoice' AND w.value ~* '^\\s*install') OR d.document_type = 'startup-sheet')
      ORDER BY dt NULLS LAST`, [ids]);
  const inv = rows.filter((r) => r.document_type === "invoice");
  const use = inv.length ? inv : rows;
  if (!use.length) {
    return attachCitations({ kind: "no-answer", text: `No install record on file for ${display}, so I can't say who installed it.`, facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [] },
      { records: [], total: 0, kind: "searched", basis: `Looked for an install invoice or start-up sheet for ${display}; none on file.` });
  }
  const seen = new Set(); const uniq = use.filter((r) => { const k = `${r.tech}|${String(r.dt).slice(0, 10)}`; return seen.has(k) ? false : (seen.add(k), true); });
  const line = (r) => `${r.tech}${dateLabel(r.dt) ? ` (${dateLabel(r.dt)})` : ""}`;
  const text = uniq.length === 1 ? `${display}'s system was installed by ${line(uniq[0])}.` : `${display} has ${uniq.length} install records: ${uniq.slice(0, 6).map(line).join("; ")}.`;
  return attachCitations(answerEnvelope({ text, facts: uniq.slice(0, 20).map((r) => ({ label: "Installed by", value: line(r), sources: [{ documentId: r.document_id, location: { field: "technician" } }] })), extra: { fastIntent: "field_match" } }),
    { records: await documentRecordsFor(db, uniq.map((r) => r.document_id)), total: uniq.length, basis: `Read the install record for ${display}; later service visits were not used.` });
}
