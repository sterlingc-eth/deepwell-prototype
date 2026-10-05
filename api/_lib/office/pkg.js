/** Small helpers shared by docx.js and xlsx.js for OOXML packages (relationships, part paths). */
import { parseXml, xmlBytesToString } from "./xml.js";
import { OfficeError } from "./errors.js";

/** Resolve a relationship target against the folder of its source part. null when it escapes the package root. */
export function resolveTarget(baseDir, target) {
  if (typeof target !== "string" || !target || target.includes("\\") || target.includes("\0")) return null;
  const clean = target.split("#")[0];
  const parts = clean.startsWith("/") ? [] : baseDir.split("/").filter(Boolean);
  for (const seg of clean.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { if (!parts.length) return null; parts.pop(); } else parts.push(seg);
  }
  return parts.join("/");
}

/** Read a .rels part into [{id, type, target, external}]. A missing part gives []. */
export function readRels(zip, partPath, clock) {
  if (!zip.has(partPath)) return [];
  const out = [];
  parseXml(xmlBytesToString(zip.read(partPath, 4 * 1024 * 1024)), {
    clock,
    onOpen(name, a) {
      if (name === "Relationship" && a.Id) {
        out.push({ id: a.Id, type: String(a.Type ?? ""), target: a.Target ?? "", external: String(a.TargetMode ?? "").toLowerCase() === "external" });
      }
    },
  });
  return out;
}

export const relsPathFor = (part) => {
  const i = part.lastIndexOf("/");
  return `${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`;
};
export const dirOf = (part) => part.slice(0, part.lastIndexOf("/") + 1);

export function mustRead(zip, path, cap) {
  if (!zip.has(path)) throw new OfficeError(422, "bad-package", `This file is missing a required part ("${path.slice(0, 60)}"), so it is damaged or not a real Word/Excel file. Re-save it from Word or Excel and upload again.`);
  return zip.read(path, cap);
}
