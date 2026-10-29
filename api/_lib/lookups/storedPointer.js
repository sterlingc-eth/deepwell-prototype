/**
 * LOWRISK-1 (stress fixes, 2026-10-29) - generic, stricter-only helpers. Nothing here produces a new answer or a value: each helper only lets a caller
 * replace a false denial ("No X on file", "not an invoice", "has no total printed") with a pointer to the stored paperwork, or withhold one value when a newer
 * version of the same paper is stored. No industry, vendor or document-type names are used. Every helper fails SAFE: on any error it reports "nothing found"
 * so the caller keeps its previous behaviour. Disable everything with DONOVAN_LOWRISK1=0.
 */
import { TENANT_SQL } from "../scope.js";
import { notPrivateSql } from "../privacy/privateDocs.js";

export const lowrisk1On = () => process.env.DONOVAN_LOWRISK1 !== "0";
const esc = (s) => String(s).replace(/[\\%_]/g, "\\$&");

/** LIKE patterns for a typed document number in every common spelling (dash / space / none) */
function numberLikes(typed) {
  const raw = String(typed ?? "").trim();
  const flat = raw.replace(/[^A-Za-z0-9]/g, "");
  if (flat.length < 4) return { likes: [], flat: "" };
  const m = /^([A-Za-z]*)(\d+(?:-\d+)*)$/.exec(raw.replace(/\s+/g, ""));
  const likes = [`%${esc(raw)}%`];
  if (m && m[1]) likes.push(`%${esc(m[1])}-${esc(m[2])}%`, `%${esc(m[1])} ${esc(m[2])}%`, `%${esc(m[1])}${esc(m[2])}%`);
  return { likes: [...new Set(likes)], flat };
}

/** stored documents whose page text or file name carries the typed number: [{ id, name }] (at most 3). [] on doubt or error. */
export async function storedDocsMentioning(db, typed, { excludeId = null } = {}) {
  if (!lowrisk1On()) return [];
  try {
    const { likes, flat } = numberLikes(typed);
    if (!likes.length) return [];
    const { rows } = await db.raw(
      `SELECT DISTINCT d.id, d.original_filename AS name, d.created_at FROM documents d
        WHERE d.${TENANT_SQL} AND ${notPrivateSql("d")} AND ($2::text IS NULL OR d.id::text <> $2::text)
          AND (upper(regexp_replace(coalesce(d.original_filename, ''), '[^A-Za-z0-9]', '', 'g')) LIKE '%' || upper($3::text) || '%'
            OR EXISTS (SELECT 1 FROM document_pages p WHERE p.document_id = d.id AND p.${TENANT_SQL} AND p.text ILIKE ANY ($1::text[])))
        ORDER BY d.created_at DESC LIMIT 3`,
      [likes, excludeId, flat]
    );
    return rows.map((r) => ({ id: r.id, name: r.name || "a stored document" }));
  } catch { return []; }
}

/** wording for a number that is not an extracted field but IS written in stored paperwork: points at it and claims no value */
export function mentionedPointerText(shown, docs) {
  const names = docs.map((d) => d.name).join("; ");
  return `I could not find ${shown} among the details I have read, but ${docs.length === 1 ? "a stored document" : `${docs.length} stored documents`} mention${docs.length === 1 ? "s" : ""} it: ${names}. Its details have not been read into answers yet, so open ${docs.length === 1 ? "that document" : "those documents"} to see what it says.`;
}

/** true when the stored text of document `docId` contains a word matching `re` (false on error, so a caller that WITHHOLDS only on true stays safe) */
export async function pageTextHas(db, docId, re) {
  if (!lowrisk1On()) return false;
  try {
    const { rows } = await db.raw(`SELECT 1 FROM document_pages p WHERE p.document_id = $1 AND p.${TENANT_SQL} AND p.text ~* $2 LIMIT 1`, [docId, re.source.replace(/\\b/g, "\\y")]);
    return rows.length > 0;
  } catch { return false; }
}

const REV_WORD = "(?:supersed\\w*|replac\\w*|revis\\w*|amend\\w*|reissu\\w*|re-issu\\w*)";
/** regex (Postgres ARE, case-insensitive) that is true only when a revision word sits within ~120 characters of the number on one line */
function revisionRegex(typed) {
  const num = (String(typed ?? "").match(/[A-Za-z]+|\d+/g) ?? []).join("[- ]?");
  return `(${REV_WORD}[^\\n]{0,120}${num}|${num}[^\\n]{0,120}${REV_WORD})`;
}
/** OTHER stored documents that print the same number and say they revise / supersede / replace it: [{ id, name }]. [] when none or on error. */
export async function newerVersionsOf(db, typed, docId) {
  const ids = (Array.isArray(docId) ? docId : [docId]).map(String);
  if (!lowrisk1On()) return [];
  try {
    const { likes } = numberLikes(typed);
    if (!likes.length) return [];
    const { rows } = await db.raw(
      `SELECT DISTINCT d.id, d.original_filename AS name, d.created_at FROM documents d
        WHERE d.${TENANT_SQL} AND ${notPrivateSql("d")} AND NOT (d.id::text = ANY($2::text[]))
          AND EXISTS (SELECT 1 FROM document_pages p WHERE p.document_id = d.id AND p.${TENANT_SQL} AND p.text ILIKE ANY ($1::text[]) AND p.text ~* $3)
        ORDER BY d.created_at DESC LIMIT 3`,
      [likes, ids, revisionRegex(typed)]
    );
    return rows.map((r) => ({ id: r.id, name: r.name || "a stored document" }));
  } catch { return []; }
}

const NOT_NAME_WORDS = new Set(("a an the of for to from in on at by with and or but is are was were be do does did has have had what which who whom whose when where why how list show give tell find get count many much all any every each my our your their its it this that these those me us we you i customer customers client clients unit units equipment job jobs visit visits invoice invoices document documents paper papers record records vendor vendors contact phone number address email name names city county state zip arizona az nevada nv texas california new").split(/\s+/));
const ENTITY_SUFFIX = /^(?:inc|llc|ltd|co|corp|company|group|pllc|lp|llp|associates|services|systems|partners|holdings)\.?$/i;
/**
 * LOWRISK-1 (F2): true when a place word of a city / county filter is really the first or last word of a business name written in the question
 * ("Mesa Mechanical Systems Inc.", "Phoenix Roofing"): the place word is adjacent to another capitalised word that is not a place, state, filter value or common word,
 * or to a company suffix. Only used to WITHHOLD an answer ("I could not find that"); never to build one.
 */
export function placeWordInsideName(question, plan) {
  if (!lowrisk1On()) return false;
  try {
    const fs = (plan?.filters ?? []).filter((f) => ["city", "county"].includes(f.field) && typeof f.value === "string");
    if (!fs.length) return false;
    const other = new Set((plan.filters ?? []).filter((f) => typeof f.value === "string").flatMap((f) => String(f.value).toLowerCase().split(/\s+/)));
    const toks = String(question ?? "").replace(/[?!,;:()"]/g, " ").split(/\s+/).filter(Boolean);
    const low = toks.map((t) => t.replace(/['\u2019]s$/i, "").replace(/\.$/, "").toLowerCase());
    const cap = (t) => /^[A-Z][a-z]/.test(t);
    for (const f of fs) {
      const pw = String(f.value).toLowerCase().split(/\s+/);
      for (let i = 0; i + pw.length <= low.length; i++) {
        if (!pw.every((w, k) => low[i + k] === w)) continue;
        if (!cap(toks[i])) continue;
        const prev = i > 0 ? toks[i - 1] : null, next = toks[i + pw.length] ?? null;
        const adj = (t, isPrev) => {
          if (!t) return false;
          const w = t.replace(/['\u2019]s$/i, "").replace(/\.$/, "");
          if (ENTITY_SUFFIX.test(w)) return !isPrev;
          if (!cap(w) || NOT_NAME_WORDS.has(w.toLowerCase()) || other.has(w.toLowerCase())) return false;
          if (isPrev && toks.indexOf(t) === 0) return false; // sentence-initial question word
          return true;
        };
        if (adj(prev, true) || adj(next, false)) return true;
      }
    }
    return false;
  } catch { return false; }
}
