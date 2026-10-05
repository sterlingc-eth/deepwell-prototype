/**
 * THE upload allow-list (Sterling's decision, 2026-10-03): what DeepWell accepts, in one place. Every path that can create a
 * document row (api/upload-url.js single + batch, /api/v1-ingest, records.ts createDocument) calls checkUploadFile() BEFORE
 * any row or signed URL exists, so a refused file costs nothing and leaves nothing behind. Pure: no imports except the shared
 * limits, so the browser-side mirror (src/services/uploadTypes.ts) can be tested against this file for drift.
 *
 * This is the REQUEST-time check (file name + declared type + declared size). The READ-time check of the real bytes
 * (signatures, passwords, zip bombs) belongs to the readers (readDocument.js / api/_lib/office).
 */
import { MAX_OFFICE_UPLOAD_BYTES, MAX_SHEET_TEXT_UPLOAD_BYTES } from "./office/limits.js";

export const ACCEPTED_TYPES_SENTENCE =
  "PDFs, photos (JPEG, PNG, GIF, WebP), Word (.docx) and Excel (.xlsx) files, CSV, and plain text";

/** Extension (lowercase, no dot) -> kind. Anything else is refused. */
export const EXT_KIND = {
  pdf: "pdf", jpg: "image", jpeg: "image", png: "image", gif: "image", webp: "image",
  txt: "text", md: "text", csv: "sheet-text", tsv: "sheet-text", json: "text",
  docx: "docx", xlsx: "xlsx",
};

export const DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Extension -> content types a browser legitimately declares for it. The FIRST is canonical: it is what is stored on the
 * document row (so the reader and the page estimate see one spelling whatever the browser said). Windows browsers declare
 * .csv as application/vnd.ms-excel (Excel owns the extension), text/csv or text/plain; .md as text/markdown or text/x-markdown.
 */
export const EXT_CONTENT_TYPES = {
  pdf: ["application/pdf", "application/x-pdf"],
  jpg: ["image/jpeg", "image/jpg", "image/pjpeg"],
  jpeg: ["image/jpeg", "image/jpg", "image/pjpeg"],
  png: ["image/png", "image/x-png"],
  gif: ["image/gif"],
  webp: ["image/webp"],
  txt: ["text/plain"],
  md: ["text/markdown", "text/x-markdown", "text/plain"],
  csv: ["text/csv", "application/vnd.ms-excel", "text/plain", "application/csv", "text/x-csv", "application/x-csv", "text/comma-separated-values"],
  tsv: ["text/tab-separated-values", "text/tsv", "text/plain", "text/csv"],
  json: ["application/json", "text/json"],
  docx: [DOCX_CONTENT_TYPE],
  xlsx: [XLSX_CONTENT_TYPE],
};

/** The <input accept> value every upload screen uses (extensions only: type strings differ per OS). */
export const ACCEPT_ATTRIBUTE = Object.keys(EXT_KIND).map((e) => `.${e}`).join(",");

// Size caps by KIND (decided by the extension, never by the declared type: a file with no type or octet-stream is capped like
// the kind its name says; defect L-2). Same numbers the old per-content-type checks used; Office and sheet-text come from limits.js.
export const MAX_ABSOLUTE_BYTES = 100 * 1024 * 1024;
export const MAX_MODEL_READ_BYTES = 24 * 1024 * 1024; // pdf + photos
export const KIND_CAP_BYTES = {
  pdf: MAX_MODEL_READ_BYTES,
  image: MAX_MODEL_READ_BYTES,
  text: MAX_SHEET_TEXT_UPLOAD_BYTES,
  "sheet-text": MAX_SHEET_TEXT_UPLOAD_BYTES,
  docx: MAX_OFFICE_UPLOAD_BYTES,
  xlsx: MAX_OFFICE_UPLOAD_BYTES,
};

// Wording. Plain language, always ending with what to do. Existing size wording is kept exactly (verify scripts quote it).
export const SIZE_ABSOLUTE_MESSAGE = "File is larger than 100 MB";
export const SIZE_TEXT_MESSAGE =
  "Text and spreadsheet files have to be under 20 MB. Split this into smaller files and upload them separately.";
export const SIZE_MODEL_MESSAGE =
  "PDFs and photos have to be under 24 MB to be read. Split this into smaller files, or scan at a lower resolution, and upload again.";
export const SIZE_OFFICE_MESSAGE =
  "Word and Excel files have to be under 20 MB. Split this into smaller files (or save it as a PDF) and upload them separately.";
export const HEIC_MESSAGE =
  "HEIC/HEIF photos (the iPhone's default format) can't be uploaded as they are. DeepWell converts them automatically on iPhone and in Safari; " +
  "otherwise open the photo, export or share it as a JPEG, or on iPhone choose Settings > Camera > Formats > Most Compatible, then upload again.";
export const NO_EXTENSION_MESSAGE =
  `This file has no file type at the end of its name (like .pdf or .docx), so DeepWell can't tell what it is. Rename it with the right ending and upload again. DeepWell accepts ${ACCEPTED_TYPES_SENTENCE}.`;

const LEGACY_OFFICE = new Set(["doc", "xls", "ppt", "dot", "xlt", "pps", "rtf", "odt", "ods", "pages", "numbers", "key"]);
const MACRO_OFFICE = new Set(["docm", "xlsm", "xlsb", "dotm", "xltm", "xltx", "dotx", "pptm", "potm", "ppsm", "xlam", "xla"]);
const ARCHIVES = new Set(["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "iso", "dmg", "cab"]);
const PROGRAMS = new Set(["exe", "msi", "dll", "bat", "cmd", "com", "scr", "js", "mjs", "vbs", "vbe", "ps1", "sh", "jar", "apk", "app", "lnk", "reg", "hta", "pif", "cpl", "msc", "wsf", "py", "php", "pl"]);

/** Plain-language refusal for an extension that is not on the list. Never mentions anything being run or opened. */
export function refusalForExtension(ext) {
  const e = String(ext).toLowerCase();
  if (e === "heic" || e === "heif") return HEIC_MESSAGE;
  if (e === "doc" || e === "xls" || e === "ppt" || e === "dot" || e === "xlt" || e === "pps") {
    return `Old Microsoft Office files (.${e}) can't be read. Open it in Word, Excel or PowerPoint, choose Save As and pick .docx (Word) or .xlsx (Excel) (or save it as a PDF), then upload the new file.`;
  }
  if (MACRO_OFFICE.has(e)) {
    return `Files that can contain macros (.${e}) are not accepted. Open it, choose Save As, pick the plain .docx (Word) or .xlsx (Excel) format without macros (or save it as a PDF), then upload that copy.`;
  }
  if (LEGACY_OFFICE.has(e)) {
    return `.${e} files can't be read. Export or save the file as a PDF, .docx or .xlsx, then upload that copy.`;
  }
  if (ARCHIVES.has(e)) {
    return e === "zip"
      ? "A .zip file can't be uploaded as a single document. On the desktop, use Add files and drop the .zip there (DeepWell unzips it on your computer and uploads the files inside), or unzip it yourself and upload the files."
      : `Archive files (.${e}) can't be uploaded. Unzip it on your computer and upload the files inside.`;
  }
  if (PROGRAMS.has(e)) {
    return `Programs and scripts (.${e}) are never accepted. If this was meant to be a document, save it as a PDF, .docx or .xlsx and upload that. DeepWell accepts ${ACCEPTED_TYPES_SENTENCE}.`;
  }
  if (e === "tif" || e === "tiff" || e === "bmp" || e === "svg" || e === "avif") {
    return `.${e} images can't be read yet. Save or export the page as a PDF, JPEG or PNG and upload that. DeepWell accepts ${ACCEPTED_TYPES_SENTENCE}.`;
  }
  return `.${e.slice(0, 20)} files are not accepted. DeepWell accepts ${ACCEPTED_TYPES_SENTENCE}. Convert the file to one of these and upload again.`;
}

/**
 * The extension a file name really ends in, lowercase, no dot; "" when it has none. Handles a path, trailing dots / spaces
 * (Windows ignores them: "a.pdf." is "a.pdf"), invisible and right-to-left control characters, full-width dots (NFKC), and
 * upper case. Only the LAST extension counts, so "invoice.pdf.exe" is ".exe" (refused) and "report.exe.pdf" is a PDF.
 */
export function extensionOf(filename) {
  if (typeof filename !== "string") return "";
  // eslint-disable-next-line no-control-regex -- stripping control characters from a file name is the point
  let s = filename.normalize("NFKC").replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}\u2028\u2029]/gu, "").replace(/\\/g, "/");
  s = s.slice(s.lastIndexOf("/") + 1).replace(/[\s.\u00a0]+$/u, "");
  const dot = s.lastIndexOf(".");
  if (dot <= 0) return ""; // no dot, or only a leading dot (".pdf" is a hidden file with no name, not a PDF)
  return s.slice(dot + 1).toLowerCase(); // an inner space ("a. pdf") keeps the space, so it is NOT "pdf" (Windows agrees)
}

function normalizeDeclared(raw) {
  if (typeof raw !== "string") return null;
  const t = raw.split(";")[0].trim().toLowerCase();
  return t || null;
}

/**
 * @param {{filename: unknown, contentType?: unknown, sizeBytes?: unknown}} f
 * @returns {{ok: true, kind: string, contentType: string, ext: string} | {ok: false, status: number, message: string}}
 *   `contentType` is the canonical type for the extension, to be stored. A size that is not a positive integer is not judged
 *   here (the callers say "size required" / "empty file" in their own words); a valid size is checked against its kind's cap.
 */
export function checkUploadFile({ filename, contentType, sizeBytes } = {}) {
  const ext = extensionOf(filename);
  if (!ext) return { ok: false, status: 415, message: NO_EXTENSION_MESSAGE };
  const kind = Object.prototype.hasOwnProperty.call(EXT_KIND, ext) ? EXT_KIND[ext] : null;
  if (!kind) return { ok: false, status: 415, message: refusalForExtension(ext) };

  const declared = normalizeDeclared(contentType);
  const allowed = EXT_CONTENT_TYPES[ext];
  if (declared && declared !== "application/octet-stream" && declared !== "binary/octet-stream" && !allowed.includes(declared)) {
    if (declared === "image/heic" || declared === "image/heif" || declared === "image/heic-sequence" || declared === "image/heif-sequence") {
      return { ok: false, status: 415, message: HEIC_MESSAGE };
    }
    return {
      ok: false, status: 415,
      message: `This file is named .${ext} but was sent as "${declared.slice(0, 60)}", so it was not uploaded. Open the file and save it again as a real .${ext} (or export it as a PDF), then upload again. DeepWell accepts ${ACCEPTED_TYPES_SENTENCE}.`,
    };
  }

  if (typeof sizeBytes === "number" && Number.isFinite(sizeBytes) && sizeBytes > 0) {
    if (sizeBytes > MAX_ABSOLUTE_BYTES) return { ok: false, status: 413, message: SIZE_ABSOLUTE_MESSAGE };
    if (sizeBytes > KIND_CAP_BYTES[kind]) {
      const message = kind === "docx" || kind === "xlsx" ? SIZE_OFFICE_MESSAGE : kind === "pdf" || kind === "image" ? SIZE_MODEL_MESSAGE : SIZE_TEXT_MESSAGE;
      return { ok: false, status: 413, message };
    }
  }
  return { ok: true, kind, contentType: allowed[0], ext };
}
