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
  const { rows: units } = await db.raw(`SELECT id, lower(coalesce(data->>'manufacturer','')) AS mfr, regexp_replace(lower(coalesce(data->>'refrigerant','')), '[^a-z0-9]', '', 'g') AS rf, lower(btrim(coalesce(data->>'serial_number',''))) AS sn FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT_SQL}`, []);
  if (!units.length) return null;
  const rf = intent.refrig ? `r${intent.refrig}` : null;
  const brandOk = (u) => !intent.brands.length || intent.brands.includes(u.mfr);
  const recHits = units.filter((u) => brandOk(u) && (!rf || u.rf === rf));
  // A unit whose own record has no refrigerant but whose filed paperwork states one (e.g. "Install 4 ton Mitsubishi system, R-454B charge") is
  // counted too and the split is stated, so the total matches what the paperwork says (2026-10 lt-ct-145). Only units with an EMPTY record
  // refrigerant are looked up, and only the refrigerant the paperwork names (never a different one) counts.
  let paperHits = []; let paperAny = 0;
  if (rf) {
    const empty = units.filter((u) => brandOk(u) && !u.rf);
    if (empty.length) {
      const { rows } = await db.raw(
        `SELECT l.entity_id AS id, lower(p.text) AS t FROM document_entity_links l JOIN document_pages p ON p.document_id = l.document_id
          WHERE l.entity_id = ANY($1::uuid[]) AND l.${TENANT_SQL} AND p.${TENANT_SQL}`, [empty.map((u) => u.id)]);
      const named = new Map(); // unit id -> set of refrigerants named on a page that is about THAT unit
      // A page counts for a unit only when it prints that unit's serial (>= 4 chars) and no other unit's serial, and names the refrigerant itself: a ticket
      // linked to two units ("Unit 1 recharged R-22. Unit 2 no refrigerant work") says nothing certain about either one.
      // A usable serial is >= 5 characters with at least one digit, matched as a whole token (never "none" / "2026" / a fragment of a longer word or number).
      const SN_MIN = 5;
      const goodSn = (sn) => sn.length >= SN_MIN && /\d/.test(sn);
      const printsSn = (t, sn) => { const e = sn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); return new RegExp(`(?<![a-z0-9])${e}(?![a-z0-9])`).test(t); };
      const byId = new Map(units.map((u) => [u.id, u]));
      const otherSerials = (u) => [...new Set(units.filter((o) => o.id !== u.id && goodSn(o.sn) && o.sn !== u.sn).map((o) => o.sn))];
      const othersCache = new Map();
      for (const r of rows) {
        const u = byId.get(r.id); const t = String(r.t);
        if (!u || !goodSn(u.sn) || !printsSn(t, u.sn)) continue;
        if (!othersCache.has(u.id)) othersCache.set(u.id, otherSerials(u));
        if (othersCache.get(u.id).some((o) => printsSn(t, o))) continue;
        for (const m of t.matchAll(/\br[\s-]?(410a|22|454b|407c|134a|32)\b/g)) { if (!named.has(r.id)) named.set(r.id, new Set()); named.get(r.id).add(`r${m[1]}`); }
      }
      // only a unit whose paperwork names exactly this refrigerant counts; one naming a different one too is ambiguous and stays uncounted
      paperHits = empty.filter((u) => { const n = named.get(u.id); return n && n.size === 1 && n.has(rf); });
      paperAny = empty.filter((u) => named.has(u.id)).length;
    }
  }
  const hits = [...recHits, ...paperHits];
  const pool = intent.brands.length ? units.filter((u) => intent.brands.includes(u.mfr)) : units;
  const noRf = rf ? pool.filter((u) => !u.rf).length - paperAny : 0;
  const bl = intent.brands.map((b) => LABEL[b]).join(" or ");
  const what = [bl, rf ? `R-${intent.refrig.toUpperCase()}` : ""].filter(Boolean).join(" ");
  const text = `${hits.length} of ${units.length} units are ${what}${intent.brands.length && !rf ? " (by the manufacturer on each unit record)" : ""}.${paperHits.length ? ` ${recHits.length} say so on the unit record and ${paperHits.length} more say so in their paperwork.` : ""}${noRf ? ` ${noRf} ${intent.brands.length ? `${bl} ` : ""}unit${noRf === 1 ? " has" : "s have"} no refrigerant on file${paperAny ? " or in their paperwork" : ""}, so ${noRf === 1 ? "it isn't" : "they aren't"} counted.` : ""}`;
  return attachCitations(
    answerEnvelope({ text, facts: [{ label: `Units ${what}`, value: String(hits.length), entityIds: hits.slice(0, 20).map((u) => u.id), sources: [] }], extra: { fastIntent: "brand_unit_count" } }),
    { records: await customerRecordsFor(db, hits.map((u) => u.id)), total: hits.length, claimedCount: hits.length,
      basis: `Read the manufacturer${rf ? " and refrigerant" : ""} on each of the ${units.length} units.` });
}
