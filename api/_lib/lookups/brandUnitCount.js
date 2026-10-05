/**
 * "How many Carrier units" / "how many R410A systems" / "trane or lennox equipment" - a count of units by the manufacturer and/or refrigerant
 * on the unit record. The answer names what it counted (brand, refrigerant) and how many units have no refrigerant on file. Closed shape only:
 * count words, one or more brands and/or one refrigerant, an equipment noun, filler. A customer, date, tonnage, address or other
 * condition leaves the question to the older planner. Kill switch: DONOVAN_BRAND_UNITS=0.
 * pure: parseBrandUnitCount     db: runBrandUnitCount
 */
import { attachCitations } from "../citations/records.js";
import { customerRecordsFor } from "../citations/enrich.js";
import { TENANT_SQL, answerEnvelope } from "../scope.js";

const BRANDS = ["carrier", "trane", "lennox", "rheem", "york", "goodman", "daikin", "mitsubishi"];
const LABEL = { carrier: "Carrier", trane: "Trane", lennox: "Lennox", rheem: "Rheem", york: "York", goodman: "Goodman", daikin: "Daikin", mitsubishi: "Mitsubishi" };
const REFRIG_RE = /\br[\s-]?(410a|22|454b|407c|134a|32)\b/g;
const EQUIP_RE = /\b(?:units?|systems?|equipment|air\s+conditioners?|a\/c|acs?|heat\s+pumps?|condensers?|furnaces?|rtus?|machines?|hvac|unts?|untis|sytems?|systms?)\b/g;
const FILLER = new Set("how many mny number of count the our all we do have has are there is on file in total installed that with a an and or got you your us it units from by made brand make manufactured manufacturer using use uses run runs running refrigerant type".split(" "));
const MAXLEN = 100;
const lev1 = (a, b) => { if (a === b) return true; if (Math.abs(a.length - b.length) > 1) return false; let i = 0; while (i < a.length && a[i] === b[i]) i++; const x = a.slice(i), y = b.slice(i); return x.slice(1) === y || x === y.slice(1) || x.slice(1) === y.slice(1); };

/** Pure. @returns {brands:string[], refrig:string|null} or null. */
export function parseBrandUnitCount(question) {
  if (process.env.DONOVAN_BRAND_UNITS === "0") return null;
  const raw = String(question ?? "").replace(/[’`]/g, "'").trim();
  if (!raw || raw.length > MAXLEN || !/\b(?:how\s+(?:many|mny|mnay)|number\s+of|count(?:\s+of)?|total)\b/i.test(raw)) return null;
  let q = " " + raw.toLowerCase().replace(/[?!,]+|\.(?!\d)/g, " ").replace(/\s+/g, " ").trim() + " ";
  let refrig = null;
  const rm = [...q.matchAll(REFRIG_RE)];
  if (rm.length > 1) return null;
  if (rm.length) { refrig = rm[0][1]; q = q.replace(REFRIG_RE, " "); }
  const brands = [];
  const words = q.split(/\s+/).filter(Boolean);
  const rest = [];
  for (const w0 of words) {
    const w = w0.replace(/'s$/, "");
    const b = BRANDS.find((x) => w === x || (w.length >= 5 && lev1(w, x)));
    if (b) { if (!brands.includes(b)) brands.push(b); } else rest.push(w0);
  }
  if (!brands.length && !refrig) return null;
  const left = rest.join(" ").replace(EQUIP_RE, " ").replace(/\ba\/c\b/g, " ");
  if (!EQUIP_RE.test(" " + rest.join(" ") + " ")) { EQUIP_RE.lastIndex = 0; return null; }
  EQUIP_RE.lastIndex = 0;
  if (left.split(/\s+/).filter(Boolean).some((w) => !FILLER.has(w))) return null;
  return { brands, refrig };
}

export async function runBrandUnitCount(db, intent) {
  const { rows: units } = await db.raw(`SELECT id, lower(coalesce(data->>'manufacturer','')) AS mfr, regexp_replace(lower(coalesce(data->>'refrigerant','')), '[^a-z0-9]', '', 'g') AS rf FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT_SQL}`, []);
  if (!units.length) return null;
  const rf = intent.refrig ? `r${intent.refrig}` : null;
  const hits = units.filter((u) => (!intent.brands.length || intent.brands.includes(u.mfr)) && (!rf || u.rf === rf));
  const pool = intent.brands.length ? units.filter((u) => intent.brands.includes(u.mfr)) : units;
  const noRf = rf ? pool.filter((u) => !u.rf).length : 0;
  const bl = intent.brands.map((b) => LABEL[b]).join(" or ");
  const what = [bl, rf ? `R-${intent.refrig.toUpperCase()}` : ""].filter(Boolean).join(" ");
  const text = `${hits.length} of ${units.length} units are ${what}${intent.brands.length && !rf ? " (by the manufacturer on each unit record)" : ""}.${noRf ? ` ${noRf} ${intent.brands.length ? `${bl} ` : ""}unit${noRf === 1 ? " has" : "s have"} no refrigerant on file, so ${noRf === 1 ? "it isn't" : "they aren't"} counted.` : ""}`;
  return attachCitations(
    answerEnvelope({ text, facts: [{ label: `Units ${what}`, value: String(hits.length), entityIds: hits.slice(0, 20).map((u) => u.id), sources: [] }], extra: { fastIntent: "brand_unit_count" } }),
    { records: await customerRecordsFor(db, hits.map((u) => u.id)), total: hits.length, claimedCount: hits.length,
      basis: `Read the manufacturer${rf ? " and refrigerant" : ""} on each of the ${units.length} units.` });
}
