// ingest1 - drop-in ingest improvements for the text-extraction path. Not wired into readDocument.js (flag INGEST1 default OFF); see MANIFEST / README in the patch.
//   ingestBytes(bytes, filename, { ocr })  -> [{ page_no, text }]   native xlsx/docx (merged cells), images (needs sharp + an injected OCR engine)
//   repairText(text)                      -> text layer repair: type-checked character-confusion repair + arithmetic reconcile (use on PDF text layers / OCR text)
export { repairText, passesToPage, mergePasses, gridText, reconcile, repairToken, repairId, tableRows } from "./ingest_ocr.js";
export { xlsxPages, docxText } from "./ingest_native.js";
export const ingest1On = () => process.env.INGEST1 === "1";
export async function ingestBytes(bytes, filename, opt = {}) {
  const ext = String(filename).toLowerCase().split(".").pop();
  if (ext === "xlsx") { const { xlsxPages } = await import("./ingest_native.js"); return xlsxPages(bytes); }
  if (ext === "docx") { const { docxText } = await import("./ingest_native.js"); return [{ page_no: 1, text: await docxText(bytes) }]; }
  if (["png", "jpg", "jpeg", "tif", "tiff", "webp"].includes(ext)) { if (!opt.ocr) throw new Error("ingestBytes: an OCR engine is required for images"); const { ocrImage } = await import("./ingest_image.js"); const r = await ocrImage(bytes, opt.ocr, opt); return [{ page_no: 1, text: r.text, meta: r.meta }]; }
  throw new Error("ingestBytes: unsupported type " + ext);
}
