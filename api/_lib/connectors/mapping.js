/**
 * Per-tenant mapping from a source file to a DeepWell folder label. Pure.
 *   mapping = { defaultFolder?: string, rules?: [{ match: string, folder: string }] }
 * The first rule whose `match` appears (case-insensitive) in the file's path hint or name wins. The label is a HINT stored with the
 * item and the import log; the ingestion pipeline still decides document type and audience (HR papers stay private).
 */
const clean = (v) => String(v ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 120);

export function normalizeMapping(m) {
  const out = { defaultFolder: clean(m?.defaultFolder) || null, rules: [] };
  for (const r of Array.isArray(m?.rules) ? m.rules.slice(0, 50) : []) {
    const match = clean(r?.match).toLowerCase(), folder = clean(r?.folder);
    if (match && folder) out.rules.push({ match, folder });
  }
  return out;
}

export function targetFolder(mapping, item) {
  const m = normalizeMapping(mapping);
  const hay = `${item?.pathHint ?? ""} ${item?.name ?? ""}`.toLowerCase();
  for (const r of m.rules) if (hay.includes(r.match)) return r.folder;
  return m.defaultFolder;
}
