/**
 * readOfficeFile(bytes, {filename}) -> {ok:true, kind, pages:[{page_no,text}], notes:[...]}
 *                                   | {ok:false, status, reason, message}
 * kind: 'docx' | 'xlsx' | 'csv'. NEVER throws, never runs anything from the file, never follows an external reference,
 * never writes a file, and stops at the caps in limits.js (the clock too: READ_TIMEOUT_MS). Refuses legacy / protected /
 * macro-enabled / non-Office files with a message that says what the file is and what to do.
 */
import { READ_TIMEOUT_MS } from "./limits.js";
import { OfficeError, makeClock } from "./errors.js";
import { detectPackage, REFUSED_OFFICE_EXT } from "./detect.js";
import { readDocx } from "./docx.js";
import { readXlsx } from "./xlsx.js";
import { readCsv } from "./csv.js";
import { decodeText } from "./decode.js";

export { OfficeError } from "./errors.js";
export { decodeText } from "./decode.js";
export { detectPackage, isOle2, REFUSED_OFFICE_EXT } from "./detect.js";
export * from "./limits.js";

const MACRO_MSG = (what) =>
  `This is ${what}. DeepWell does not open files that can contain macros. In Word or Excel choose File > Save As and pick "Word Document (.docx)" or "Excel Workbook (.xlsx)" (the version without macros), then upload that file.`;

const MACRO_EXT = /^(docm|xlsm|dotm|xltm|pptm|xlsb|xlam)$/;

export const extOf = (filename) => {
  const base = String(filename ?? "").split(/[\\/]/).pop() ?? "";
  const i = base.lastIndexOf(".");
  return i < 0 ? "" : base.slice(i + 1).toLowerCase();
};

function refuse(status, reason, message) { return { ok: false, status, reason, message }; }

/** What the real bytes are, for callers that need to compare with a name: 'docx'|'xlsx'|'ole2'|'macro'|... never throws. */
export function describeRealKind(bytes) {
  try {
    const d = detectPackage(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), { clock: makeClock(READ_TIMEOUT_MS) });
    if (d.family === "ole2") return { family: "ole2", kind: "ole2", label: "an old-format Office file (Word 97-2003 / Excel 97-2003 / PowerPoint, or a password-protected Office file)" };
    if (d.family === "zip") return { family: "zip", kind: d.kind, label: d.label };
    return { family: "other", kind: "other", label: "" };
  } catch (e) {
    if (e instanceof OfficeError) return { family: "zip", kind: "damaged-zip", label: "a damaged ZIP file", error: e };
    return { family: "other", kind: "other", label: "" };
  }
}

export function readOfficeFile(bytes, { filename = "", timeoutMs = READ_TIMEOUT_MS } = {}) {
  try {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
    const ext = extOf(filename);
    if (buf.length === 0) return refuse(422, "empty", "This file is empty (0 bytes), so there is nothing to read. Check the original and upload it again.");
    const clock = makeClock(timeoutMs);
    const pkg = detectPackage(buf, { clock });

    if (pkg.family === "ole2") {
      const o = pkg.ole;
      // Only the EncryptedPackage / EncryptionInfo streams mean "password-protected"; a WordDocument/Workbook stream is a plain old file.
      if (o.encrypted) {
        return refuse(415, "encrypted", "This Word/Excel file is password-protected (encrypted), so it cannot be read. Remove the password (in Word or Excel: File > Info > Protect > Encrypt with Password, then clear it), save, and upload again.");
      }
      const kind = o.word ? "doc" : o.excel ? "xls" : o.powerpoint ? "ppt" : ext;
      if (kind === "doc") return refuse(415, "legacy-office", "This is an old Word (.doc) file, which DeepWell cannot read. Open it in Word and Save As .docx, then upload again.");
      if (kind === "xls") return refuse(415, "legacy-office", "This is an old Excel (.xls) file, which DeepWell cannot read. Open it in Excel and Save As .xlsx, then upload again.");
      if (kind === "ppt") return refuse(415, "legacy-office", "This is an old PowerPoint (.ppt) file, which DeepWell cannot read. Export it as a PDF and upload the PDF.");
      return refuse(415, "legacy-office", "This is an old-format Office file (.doc, .xls or .ppt) that DeepWell cannot read. Open it, use File > Save As to save a copy as .docx (Word) or .xlsx (Excel), or export a PDF, then upload that.");
    }

    if (pkg.family === "zip") {
      switch (pkg.kind) {
        case "macro": return refuse(415, "macro", MACRO_MSG("a macro-enabled Office file"));
        case "xlsb": return refuse(415, "macro", MACRO_MSG("a binary Excel (.xlsb) file"));
        case "template": return refuse(415, "template", "This is an Office template (.dotx/.xltx), not a document. Open it, use File > Save As, save a regular .docx or .xlsx, and upload that.");
        case "pptx": return refuse(415, "pptx", "This is a PowerPoint presentation, which DeepWell cannot read. Export it as a PDF (File > Export > PDF) and upload the PDF.");
        case "zip": return refuse(415, "not-office", `This file is ${pkg.label}, not a Word or Excel document. DeepWell does not open archives or programs. Upload the .docx, .xlsx, PDF or photo itself instead.`);
        case "docx": if (MACRO_EXT.test(ext)) return refuse(415, "macro", MACRO_MSG(REFUSED_OFFICE_EXT[ext])); break;
        case "xlsx": if (MACRO_EXT.test(ext)) return refuse(415, "macro", MACRO_MSG(REFUSED_OFFICE_EXT[ext])); break;
        default: break;
      }
      if (pkg.kind === "docx") { const r = readDocx(pkg.zip, { clock }); return { ok: true, kind: "docx", pages: r.pages, notes: r.notes }; }
      if (pkg.kind === "xlsx") { const r = readXlsx(pkg.zip, { clock }); return { ok: true, kind: "xlsx", pages: r.pages, notes: r.notes }; }
    }

    // Not a package: only CSV/TSV (text) can be read here; anything else named like Office is not what it claims.
    if (ext === "csv" || ext === "tsv") {
      const text = decodeText(buf);
      const r = readCsv(text, { name: filename, ext, clock });
      return { ok: true, kind: "csv", pages: r.pages, notes: r.notes };
    }
    if (REFUSED_OFFICE_EXT[ext]) {
      if (MACRO_EXT.test(ext)) return refuse(415, "macro", MACRO_MSG(REFUSED_OFFICE_EXT[ext]));
      return refuse(415, "not-office", `This file is named like ${REFUSED_OFFICE_EXT[ext]} but its contents are not a real Office file, so it may be damaged or renamed. Open the original, save it as .docx or .xlsx, and upload again.`);
    }
    return refuse(415, "not-office", "This file is not a Word (.docx) or Excel (.xlsx) document. Save it as .docx or .xlsx, or export a PDF, and upload again.");
  } catch (e) {
    if (e instanceof OfficeError) return refuse(e.status, e.reason, e.message);
    if (e instanceof RangeError) {
      return refuse(413, "resource", "This file is too large or too complex to read safely. Split it into smaller files and upload again.");
    }
    return refuse(422, "unreadable", "This file could not be read - it may be damaged or not a normal Word/Excel file. Open it, save a fresh copy as .docx or .xlsx, and upload again.");
  }
}
