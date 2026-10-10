/**
 * E1: in a property-management organization "units" are RENTAL units (entities of type 'property', each with a unit_number), not pieces of equipment.
 * The analytics lane reads "how many units do we have in Tucson" as an equipment count (452) where the organization means apartments. When the
 * organization's own data holds rental-unit records and the question says plain "units" without naming a kind of equipment, the equipment reading
 * is a guess: the lane declines (model / clarify path) instead of printing a confident number for the wrong thing. Kill switch: DONOVAN_RENTAL_UNITS=0.
 */
import { TENANT_SQL } from "../scope.js";
import { countSubject } from "../understanding/understand.js";

const UNITS_WORD = /\bunits?\b/i;
/** Words that make "units" unambiguous equipment ("water heater units", "AC units", "Rheem units"). */
const EQUIPMENT_WORD = /\b(?:hvac|a\/?c|furnaces?|heaters?|heat pumps?|water|tankless|boilers?|compressors?|condensers?|thermostats?|appliances?|pumps?|softeners?|equipment|systems?|installed|install|installs|brand|made by|manufacturer|model|serial|refrigerant|tonnage|warranty)\b/i;

const UNIT_FIELDS = new Set(["brand", "equipmentType", "model", "refrigerant", "tonnage"]);
const PLACE_FIELDS = new Set(["city", "county", "state", "zip"]);

/** Pure: could this question's plan be a count of "units" read as equipment? */
export function mentionsPlainUnits(question, plan) {
  if (process.env.DONOVAN_RENTAL_UNITS === "0") return false;
  const q = String(question ?? "");
  if (!UNITS_WORD.test(q) || EQUIPMENT_WORD.test(q)) return false;
  if (!plan || plan.op !== "count") return false;
  // a filter on the unit itself (brand, model, kind, refrigerant, age, warranty ...) says these are pieces of equipment; only place filters leave "units" open
  if ((plan.filters ?? []).some((f) => !PLACE_FIELDS.has(f?.field))) return false;
  return plan.entity === "equipment" || plan.countUnits === true || (plan.entity === "customers" && countSubject(q)?.subject === "units");
}

/** Does this organization keep rental-unit records (property entities with a unit_number)? */
export async function tenantHasRentalUnits(db) {
  const { rows } = await db.raw(`SELECT 1 AS x FROM entities WHERE entity_type = 'property' AND merged_into IS NULL AND ${TENANT_SQL} AND data ? 'unit_number' LIMIT 1`, []);
  return rows.length > 0;
}

/**
 * E1: "Maricopa" is both a county and a city in some organizations' data, and the planner added BOTH filters (county = Maricopa AND city = Maricopa), so
 * "customers in Maricopa running Rheem" and even "customers in Maricopa County" printed a confident, wrong 0. The same word as county AND city filter:
 *   - the question says "county" (and not "city") -> keep the county reading only; otherwise the city reading only (a bare name is the
 *     city, as in the shop's own "customers in Maricopa" count lane; the county reading needs the word "county").
 * @returns {object} the plan to run
 */
export function resolveCountyCityTwin(plan, question) {
  // E1: a customers-entity plan that joins the unit's own attributes (brand, kind, model ...) AND carries a time window ("Carrier units installed in 2022 in Phoenix")
  // is executed without the window (the units query has no install-date condition): the year would be silently dropped. Decline instead of printing the undated count.
  if (plan?.entity === "customers" && plan.timeRange && /\binstall/i.test(String(question ?? "")) && (plan.filters ?? []).some((f) => f && !PLACE_FIELDS.has(f.field) && UNIT_FIELDS.has(f.field))) return null;
  const fs = plan?.filters;
  if (!Array.isArray(fs) || fs.length < 2) return plan;
  const key = (v) => String(v ?? "").trim().toLowerCase();
  const county = fs.filter((f) => f?.field === "county" && f.op === "eq");
  const twin = fs.filter((f) => f?.field === "city" && f.op === "eq" && county.some((c) => key(c.value) === key(f.value)));
  if (!county.length || !twin.length) return plan;
  const q = String(question ?? "");
  const saysCounty = /\bcounty\b/i.test(q), saysCity = /\b(?:city|town)\b/i.test(q);
  // neither word: this organization HAS a city of that name, and the shop's own city-count lane (vocabCount) already reads a bare name as the city
  const readCounty = saysCounty && !saysCity;
  const drop = readCounty ? (f) => twin.includes(f) : (f) => county.includes(f) && twin.some((t) => key(t.value) === key(f.value));
  return { ...plan, placeReading: readCounty ? "county" : "city", filters: fs.filter((f) => !drop(f)) };
}

/**
 * E1: "Maricopa units on R-410A, how many" is a count of UNITS, but the customers plan answered with the CUSTOMER count (the number only coincides when every
 * customer owns one matching unit). A customers-count plan for a question that says "units" (never customers / properties / sites) and that the count-subject
 * reader does not itself read as a units count is marked countUnits, so the lane counts and words the units ("N units ..., at M customers").
 * @returns {object} the plan (marked) or the same plan
 */
export function markUnitsAsked(question, plan) {
  if (!plan || plan.op !== "count" || plan.entity !== "customers" || plan.countUnits) return plan;
  const q = String(question ?? "");
  if (!UNITS_WORD.test(q) || /\b(?:customers?|custs?|clients?|homes?|people|owners?|accounts?|propert(?:y|ies)|sites?|locations?|buildings?|addresses|households?)\b/i.test(q)) return plan;
  return countSubject(q)?.subject === "units" ? plan : { ...plan, countUnits: true };
}
