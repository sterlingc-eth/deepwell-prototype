/**
 * Cost-fix (2026-10-23): FREE-FIRST extraction gate. The extraction model runs ONLY when the free reader leaves a required
 * field empty or a cross-check fails.
 *
 * extractFromText (textExtract.js) accepts a document only when its whole layout is explained, which on the Sonoran test set
 * is ~2% of documents; every other document used to go to the paid extraction model, and the free label-fill that runs
 * AFTER the model then filled whatever it had left empty. The free readers alone (stored-text read -> type -> label fill ->
 * corroboration -> cross-check -> own-company guard) complete ~77% of those documents (0 wrong facts, scripts/real-docs).
 *
 * freeReadCompletes() dry-runs exactly that chain, the same one scripts/real-docs/pipeline.mjs runDoc runs, and answers
 * {skip:true} only when the automatic check would accept the result: no required field empty, a link to a customer or
 * address, no cross-check removal leaving a gap, not VOID / a copy. Anything else returns {skip:false, reason} and the model
 * runs exactly as before. Never throws. EXTRACT_FREE_FIRST=0 (or MODEL_AVOIDANCE=0) switches it off.
 */
import { normalizeFields } from "../extractFields.js";
import { resolveDocumentType, completenessFor, autoCheckDecision, isLabelValue } from "../documentTypes.js";
import { classifyFromText } from "./textExtract.js";
import { planLabelFill, corroborateFields, crossCheckFields } from "./labelFill.js";
import { applyOwnCompanyGuard, issuerNotCustomer } from "./ownCompany.js";
import { planStoredTextRead } from "./storedTextReread.js";
import { retypeDecision } from "./retype.js";

export const isFreeFirstExtractEnabled = (env = process.env) => env?.MODEL_AVOIDANCE !== "0" && env?.EXTRACT_FREE_FIRST !== "0";

/**
 * @param {{pages:{page_no:number,text:string}[], filename?:string|null, ownNames?:string[], pack?:object|null, highestPage?:number, today?:string}} a
 * @returns {{skip:boolean, reason:string, titleType?:string|null, type?:string}}
 */
export function freeReadCompletes({ pages, filename = null, ownNames = [], pack = null, highestPage, today } = {}) {
  try {
    if (pack && pack.id && pack.id !== "hvac") return { skip: false, reason: "non-hvac-pack" };
    const pg = (pages ?? []).map((p) => ({ page_no: p.page_no, text: p.text ?? "" }));
    if (!pg.some((p) => p.text.trim())) return { skip: false, reason: "no-text" };
    const hp = highestPage || pg.reduce((n, p) => Math.max(n, Number(p.page_no) || 0), 0) || 1;
    let titleType = null;
    try { titleType = classifyFromText(pg)?.type ?? null; } catch { titleType = null; }
    let fields = normalizeFields([], { pageCount: hp, pack, ...(today ? { today } : {}) }).fields;
    try { fields = issuerNotCustomer(fields, pg, ownNames).fields; } catch { /* as ingest */ }
    fields = applyOwnCompanyGuard(fields, ownNames).fields;
    const rr = planStoredTextRead({ documentType: null, storedType: null, filename, pages: pg, ownNames, pack, pageCount: hp, ...(today ? { today } : {}) });
    if (rr.add.length) fields = rr.add;
    if (!fields.length) return { skip: false, reason: "nothing-read-free", titleType };
    let facts = Object.fromEntries(fields.map((f) => [f.field_key, f.value]));
    let type = resolveDocumentType({ fields: [], document_type: titleType }, facts, filename, pack).documentType;
    const rt = retypeDecision({ currentType: type, filename, pages: pg, fields });
    if (rt) type = rt.to;
    const plan = planLabelFill({ type, fields, pages: pg, method: "label-fill", pageCount: hp, ownNames, filename, ...(today ? { today } : {}) });
    if (plan.add.length) fields = [...fields, ...plan.add];
    fields = corroborateFields({ type, fields, pages: pg, ownNames }).fields;
    fields = crossCheckFields({ fields, pages: pg }).fields;
    fields = applyOwnCompanyGuard(fields, ownNames).fields;
    fields = fields.filter((f) => !((f.field_key === "customer_name" || f.field_key === "vendor") && isLabelValue(f.value)));
    const text = pg.map((p) => p.text).join("\n").slice(0, 20000);
    const keys = new Set(fields.map((f) => f.field_key));
    const hasLink = keys.has("customer_name") || keys.has("service_address");
    const comp = completenessFor(type, fields, null, { filename });
    if (comp.missing.length) return { skip: false, reason: `missing-required:${comp.missing.join("|")}`, titleType, type };
    const verdict = autoCheckDecision(type, fields, { hasText: true, hasLink, filename, text });
    if (!verdict.ok) return { skip: false, reason: verdict.reason ?? "not-checked", titleType, type };
    return { skip: true, reason: "free-complete", titleType, type };
  } catch (err) {
    return { skip: false, reason: `error:${String(err?.message ?? err).slice(0, 60)}` };
  }
}
