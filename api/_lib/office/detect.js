/**
 * What is this file REALLY? Decided from its bytes (signature + package structure), never from its name or declared type.
 * Pure and cheap: the only thing it reads from a zip is [Content_Types].xml and _rels/.rels (both size-capped).
 */
import { openZip, looksLikeZip } from "./zipSafe.js";
import { parseXml, xmlBytesToString } from "./xml.js";

const OLE2_SIG = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
export const isOle2 = (b) => b.length >= 8 && b.subarray(0, 8).equals(OLE2_SIG);
export { looksLikeZip };

const u16 = (str) => Buffer.from(str, "utf16le");
const OLE_ENC = [u16("EncryptedPackage"), u16("EncryptionInfo")];
/** Which streams an OLE2 file holds, by its directory names (UTF-16LE; plain linear Buffer scans, no parsing of the FAT). */
export function ole2Streams(b) {
  const has = (n) => b.indexOf(u16(n)) >= 0;
  return {
    encrypted: OLE_ENC.some((n) => b.indexOf(n) >= 0),
    word: has("WordDocument"),
    excel: has("Workbook") || has("Book"),
    powerpoint: has("PowerPoint Document"),
  };
}

const CT_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const CT_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
const MAX_CT_PART = 4 * 1024 * 1024;

/** Extensions that are Office-ish but not on the accept list, and what they are (for the message). */
export const REFUSED_OFFICE_EXT = {
  doc: "an old Word (.doc) file", xls: "an old Excel (.xls) file", ppt: "an old PowerPoint (.ppt) file",
  docm: "a macro-enabled Word file", xlsm: "a macro-enabled Excel file", xlsb: "a binary/macro Excel file",
  dotm: "a macro-enabled Word template", xltm: "a macro-enabled Excel template", pptm: "a macro-enabled PowerPoint file",
  dotx: "a Word template", xltx: "an Excel template", pptx: "a PowerPoint presentation", ppsx: "a PowerPoint show",
  xla: "an Excel add-in", xlam: "an Excel add-in", odt: "an OpenDocument text file", ods: "an OpenDocument spreadsheet",
  rtf: "a Rich Text file", pages: "an Apple Pages file", numbers: "an Apple Numbers file",
};

/**
 * Inspect a ZIP package. Returns {kind, mainPart, hasMacro, label}. kind: 'docx' | 'xlsx' | 'pptx' | 'macro' | 'template'
 * | 'xlsb' | 'zip' (any other archive). Throws OfficeError for a damaged/unsafe/encrypted zip.
 */
export function inspectZip(zip) {
  const names = zip.names;
  const lower = names.map((n) => n.toLowerCase());
  const hasMacro = lower.some((n) => /(^|\/)vbaproject\.bin$/.test(n) || /(^|\/)vbadata\.xml$/.test(n) || /(^|\/)vbaprojectsignature\.bin$/.test(n));
  const types = [];
  if (zip.has("[Content_Types].xml")) {
    const ct = zip.read("[Content_Types].xml", MAX_CT_PART);
    parseXml(xmlBytesToString(ct), {
      onOpen(name, a) {
        if ((name === "Override" || name === "Default") && a.ContentType) types.push(a.ContentType);
      },
    });
  }
  const macroType = types.some((t) => /macroenabled|vbaproject/i.test(t));
  if (hasMacro || macroType) return { kind: "macro", hasMacro: true, label: "a macro-enabled Office file" };
  if (zip.has("xl/workbook.bin")) return { kind: "xlsb", hasMacro: false, label: "a binary Excel (.xlsb) file" };
  if (types.includes(CT_DOCX) && zip.has("word/document.xml")) return { kind: "docx", hasMacro: false, label: "a Word document" };
  if (types.includes(CT_XLSX) && zip.has("xl/workbook.xml")) return { kind: "xlsx", hasMacro: false, label: "an Excel workbook" };
  if (types.some((t) => /wordprocessingml\.template|spreadsheetml\.template/.test(t))) return { kind: "template", hasMacro: false, label: "an Office template" };
  if (types.some((t) => /presentationml/.test(t)) || zip.has("ppt/presentation.xml")) return { kind: "pptx", hasMacro: false, label: "a PowerPoint presentation" };
  if (lower.includes("meta-inf/manifest.mf")) return { kind: "zip", hasMacro: false, label: "a program or Java archive (.jar)" };
  if (lower.includes("androidmanifest.xml")) return { kind: "zip", hasMacro: false, label: "an Android app (.apk)" };
  if (zip.has("mimetype")) return { kind: "zip", hasMacro: false, label: "an OpenDocument file" };
  return { kind: "zip", hasMacro: false, label: "a ZIP archive" };
}

/**
 * Real signature of `bytes`: {family:'ole2'} | {family:'zip', ...inspectZip} | {family:'other'}. Never throws except
 * OfficeError from a damaged zip (the caller turns it into a refusal).
 */
export function detectPackage(bytes, { clock } = {}) {
  if (isOle2(bytes)) return { family: "ole2", ole: ole2Streams(bytes) };
  if (looksLikeZip(bytes)) {
    if (bytes.length >= 4 && bytes[2] === 5 && bytes[3] === 6 && bytes.length <= 22) return { family: "zip", kind: "zip", label: "an empty ZIP archive", zip: null };
    let zip;
    zip = openZip(bytes, { clock });
    return { family: "zip", zip, ...inspectZip(zip) };
  }
  return { family: "other" };
}
