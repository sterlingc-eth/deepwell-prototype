/** Switches. Both default OFF; byte-identical behaviour when unset. Parity (R79): the loop twin must read the same env names. */
const on = (v) => /^(?:1|true|on|yes)$/i.test(String(v ?? "").trim());
/** extract a record at upload (spends model dollars: one Haiku pass per document, only for documents the free readers did not complete) */
export const recordExtractEnabled = (env = process.env) => on(env.DONOVAN_DOCRECORD_EXTRACT);
/** answer from verified stored records (no model call; stricter-only, falls through otherwise) */
export const recordAnswersEnabled = (env = process.env) => on(env.DONOVAN_DOCRECORD_ANSWERS);
export { RECORD_SEGMENT, RECORD_VERSION } from "./core.js";
export { extractDocRecord, DocRecordError } from "./extract.js";
export { validateRecord } from "./validate.js";
export { answerFromRecords } from "./answer.js";
export { saveRecord, loadRecords } from "./store.js";
