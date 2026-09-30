/**
 * R31 (Team A, P1 roadmap item 4 "brand canonicalization for distinct lists/counts").
 *
 * WHY: "how many different brands do we service" / "list every brand" / "breakdown by brand" grouped units by the raw
 * `manufacturer` text, so one manufacturer printed three ways on three pieces of paperwork ("Carrier", "CARRIER",
 * "Carrier Corp.", "Carrier Air Conditioning") counted as three brands. A filter ("how many Carrier units") already
 * canonicalized through warrantyRules.normalizeBrand; the group-by never did.
 *
 * canonicalBrandLabel(raw) -> the display label of the ONE brand the text names, or the trimmed text itself when it
 * names no known brand (never a guess: an unrecognized manufacturer stays its own group). Recognition order:
 *   1. warrantyRules.normalizeBrand (exact spelling / alias / corporate suffix), the SAME rule the filters use;
 *   2. the text is a known brand's own name (or alias) followed ONLY by generic corporate/product filler words
 *      ("international", "air conditioning", "heating & cooling", "hvac", "systems", "technologies", "north america" ...).
 *      "Carrier Air Conditioning" -> Carrier. But "Carrier Rheem Hybrid" (a second brand word) or "Carrier Xyzzy" stays as typed.
 * Pure, no I/O.
 */
import { normalizeBrand, BRAND_RULES } from "../warrantyRules.js";

const FILLER = new Set(
  ("international intl industries industrial comfort heating cooling air conditioning conditioner conditioners hvac hvacr refrigeration systems system " +
    "technologies technology residential commercial home inc incorporated corp corporation co company llc ltd limited mfg manufacturing group america american usa us north " +
    "electric global brands brand products product equipment and the of dba unit units").split(/\s+/)
);

const norm = (s) => String(s ?? "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

let names = null; // longest-first [normalized name, label]
function knownNames() {
  if (names) return names;
  const out = [];
  for (const [key, rule] of Object.entries(BRAND_RULES)) {
    out.push([norm(key), rule.label ?? key]);
    for (const a of rule.aliases ?? []) out.push([norm(a), rule.label ?? key]);
  }
  names = out.sort((a, b) => b[0].length - a[0].length);
  return names;
}

export function canonicalBrandLabel(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return text;
  const key = normalizeBrand(text);
  if (key) return BRAND_RULES[key]?.label ?? text;
  const t = norm(text);
  for (const [nm, label] of knownNames()) {
    if (!nm || !(t === nm || t.startsWith(`${nm} `))) continue;
    const rest = t.slice(nm.length).trim();
    if (!rest || rest.split(" ").every((w) => FILLER.has(w))) return label;
  }
  return text;
}
