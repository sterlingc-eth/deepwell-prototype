/**
 * R32 (Team M): the kill switches for every model-avoidance path. DEFAULT = the deterministic path is ON.
 *
 *   MODEL_AVOIDANCE=0            master off — every switch below behaves as if set to its "old behaviour" value.
 *   PDF_TEXT_LAYER=0             always send PDFs to the vision model to be read (pre-R32).
 *   EXTRACT_DETERMINISTIC=0      always run the extraction model on stored page text (pre-R32).
 *   EXTRACT_GENERIC=0            keep the strict HVAC-template extractor only: do not read receipts, statements, POs,
 *                                agreements ... from their labelled lines (labelledExtract.js) or accept non-HVAC packs.
 *   CLASSIFY_DETERMINISTIC=0     reclassify: skip the title-line classifier, go straight to the model.
 *   FINANCIALS_DETERMINISTIC=0   always run the financials model on money documents (pre-R32).
 *   ASK_NONQUESTION_GATE=0       let greetings / gibberish / off-topic text reach retrieval + the agent (pre-R32).
 *   DOSSIER_MODEL=1              OPT-IN: summarise a document into a customer/unit dossier with a model (pre-R32
 *                                default was ON). Off = a deterministic, field-derived summary.
 *   DONOVAN_AUTOPILOT_MODEL=1    OPT-IN: the nightly per-tenant learning loop may spend model dollars (replay, exam
 *                                slice, vocabulary labelling). Off = the step is skipped (pre-R32 default was ON, capped
 *                                at $0.25/tenant/night).
 *
 *   TABLE_ROWS_READER=1          OPT-IN (default OFF, tables lane 2026-10-24): read the printed line-item table of an invoice /
 *                                receipt with tableRows.js and give the VERIFIED rows to the financials pipeline (invoice_lines).
 *                                Rows are kept only when qty x unit = amount and the rows add up to the printed subtotal / total.
 *
 * Pure functions of an env object so verify scripts can flip them without touching process.env.
 */
const off = (env, name) => env?.MODEL_AVOIDANCE === "0" || env?.[name] === "0";
const optIn = (env, name) => env?.MODEL_AVOIDANCE === "0" ? true : env?.[name] === "1"; // master off restores the old (model) default for opt-in paths

export const isTextLayerReadEnabled = (env = process.env) => !off(env, "PDF_TEXT_LAYER");
export const isDeterministicExtractEnabled = (env = process.env) => !off(env, "EXTRACT_DETERMINISTIC");
export const isGenericExtractEnabled = (env = process.env) => !off(env, "EXTRACT_GENERIC");
export const isDeterministicClassifyEnabled = (env = process.env) => !off(env, "CLASSIFY_DETERMINISTIC");
export const isDeterministicFinancialsEnabled = (env = process.env) => !off(env, "FINANCIALS_DETERMINISTIC");
export const isNonQuestionGateEnabled = (env = process.env) => !off(env, "ASK_NONQUESTION_GATE");
export const isDossierModelEnabled = (env = process.env) => optIn(env, "DOSSIER_MODEL");
export const isAutopilotModelEnabled = (env = process.env) => optIn(env, "DONOVAN_AUTOPILOT_MODEL");
/** Tables lane: strictly opt-in; the master MODEL_AVOIDANCE=0 does not turn it on. */
export const isTableRowsReaderEnabled = (env = process.env) => env?.TABLE_ROWS_READER === "1";
