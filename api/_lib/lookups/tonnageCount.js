/**
 * "How many 5 ton units" - a count by nameplate tonnage. Counting only the unit's own tonnage field undercounts (about half the units have
 * none), so a unit also counts when every linked document that states a tonnage ("Install 3 ton Carrier system") states the same one.
 * The answer says how many came from each source and how many units have no tonnage on file anywhere. Closed shape only: one tonnage,
 * an equipment noun, optional over/under/or-more, nothing else (a customer, brand, address or date is left to the older planner).
 * Kill switch: DONOVAN_TONNAGE_COUNT=0.
 * pure: parseTonnageCount     db: runTonnageCount
 */
import { attachCitations } from "../citations/records.js";
import { customerRecordsFor } from "../citations/enrich.js";
import { TENANT_SQL, answerEnvelope } from "../scope.js";

const NUMW = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20 };
const NUM = String.raw`\d+(?:\.\d+)?|${Object.keys(NUMW).join("|")}`;
const TON_RE = new RegExp(String.raw`(?:^|[^\w.])(${NUM})(?:\s*-\s*|\s+)?(?:tons?\b|t\b(?!\w))`, "gi");
const OPS = [
  [/\b(?:or\s+(?:more|larger|bigger|greater|above|up)|and\s+(?:up|above|over)|plus|\+)\b|\+/g, ">=", "at least"],
  [/\b(?:or\s+(?:less|smaller|under|below|fewer)|and\s+(?:under|below|smaller))\b/g, "<=", "at most"],
  [/\b(?:at\s+least|no\s+less\s+than|minimum\s+of)\b/g, ">=", "at least"],
  [/\b(?:at\s+most|no\s+more\s+than|up\s+to|maximum\s+of)\b/g, "<=", "at most"],
  [/\b(?:over|above|more\s+than|greater\s+than|bigger\s+than|larger\s+than|exceed(?:s|ing)?)\b/g, ">", "over"],
  [/\b(?:under|below|less\s+than|smaller\s+than|lower\s+than)\b/g, "<", "under"],
];
const EQUIP = /\b(?:units?|systems?|equipment|air\s+conditioners?|a\/c|ac|acs|heat\s+pumps?|condensers?|furnaces?|rtus?|machines?|hvac)\b/;
const FILLER = new Set("how many number of count the our all we do have has are there is on file in total installed that with a an and or got you your us it".split(" "));
const MAXLEN = 120;

/** Pure. @returns {op, label, tons} or null. */
export function parseTonnageCount(question) {
  if (process.env.DONOVAN_TONNAGE_COUNT === "0") return null;
  const raw = String(question ?? "").replace(/[’`]/g, "'").trim();
  if (!raw || raw.length > MAXLEN || !/\b(?:how\s+many|number\s+of|count(?:\s+of)?)\b/i.test(raw)) return null;
  let q = " " + raw.toLowerCase().replace(/[?!,]+|\.(?!\d)/g, " ").replace(/\s+/g, " ").trim() + " ";
  let op = "=", label = null;
  for (const [re, o, l] of OPS) { if (re.test(q)) { if (label) return null; op = o; label = l; q = q.replace(re, " "); } re.lastIndex = 0; }
  const ms = [...q.matchAll(TON_RE)];
  if (ms.length !== 1) return null;
  const tons = /^\d/.test(ms[0][1]) ? Number(ms[0][1]) : NUMW[ms[0][1].toLowerCase()];
  if (!(tons > 0 && tons <= 100)) return null;
  q = q.replace(ms[0][0], " ");
  if (!EQUIP.test(q)) return null;
  const left = q.replace(EQUIP, " ").replace(/\b(?:units?|systems?|equipment|air\s+conditioners?|acs?|heat\s+pumps?|condensers?|furnaces?|rtus?|machines?|hvac)\b/g, " ").replace(/\ba\/c\b/g, " ").split(/\s+/).filter(Boolean);
  if (left.some((w) => !FILLER.has(w))) return null;
  return { op, label, tons };
}

const num = (s) => { const m = /(\d+(?:\.\d+)?)/.exec(String(s ?? "")); return m ? Number(m[1]) : null; };
const test = (op, t, n) => ({ "=": t === n, ">": t > n, ">=": t >= n, "<": t < n, "<=": t <= n })[op];

export async function runTonnageCount(db, intent) {
  const { rows: units } = await db.raw(`SELECT id, data->>'tonnage' AS tonnage FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT_SQL}`, []);
  if (!units.length) return null;
  const val = new Map(), fromDoc = new Map();
  const need = [];
  for (const u of units) { const t = num(u.tonnage); if (t != null) val.set(u.id, t); else need.push(u.id); }
  if (need.length) {
    const { rows } = await db.raw(
      `SELECT l.entity_id, l.document_id, p.text FROM document_entity_links l JOIN document_pages p ON p.document_id = l.document_id AND p.${TENANT_SQL}
        WHERE l.entity_id = ANY($1::uuid[]) AND l.${TENANT_SQL}`, [need]);
    const seen = new Map();
    for (const r of rows) {
      const s = seen.get(r.entity_id) ?? seen.set(r.entity_id, new Map()).get(r.entity_id);
      for (const m of String(r.text ?? "").matchAll(/(?:^|[^\w.])(\d{1,2}(?:\.\d)?)\s*-?\s*tons?\b/gi)) { const t = Number(m[1]); if (!s.has(t)) s.set(t, r.document_id); }
    }
    for (const [id, s] of seen) if (s.size === 1) { const [[t, doc]] = [...s]; val.set(id, t); fromDoc.set(id, doc); }
  }
  const total = units.length, unknown = total - val.size;
  const hits = units.filter((u) => val.has(u.id) && test(intent.op, val.get(u.id), intent.tons));
  const own = hits.filter((u) => !fromDoc.has(u.id)).length, viaDoc = hits.length - own;
  const what = intent.op === "=" ? `${intent.tons} ton` : `${intent.label} ${intent.tons} ton${intent.tons === 1 ? "" : "s"}`;
  const parts = viaDoc ? ` (${own} recorded on the unit, ${viaDoc} more from a linked document that states the size)` : "";
  const text = `${hits.length} of ${total} units are ${what}${parts}.${unknown ? ` ${unknown} unit${unknown === 1 ? " has" : "s have"} no tonnage on file, so ${unknown === 1 ? "it isn't" : "they aren't"} counted.` : ""}`;
  const docIds = [...new Set(hits.filter((u) => fromDoc.has(u.id)).map((u) => fromDoc.get(u.id)))];
  return attachCitations(
    answerEnvelope({ text, facts: [{ label: `Units ${what}`, value: String(hits.length), entityIds: hits.slice(0, 20).map((u) => u.id), sources: docIds.slice(0, 20).map((d) => ({ documentId: d, location: {} })) }], extra: { fastIntent: "tonnage_count" } }),
    { records: await customerRecordsFor(db, hits.map((u) => u.id)), total: hits.length, claimedCount: hits.length,
      basis: `Read the tonnage on each of the ${total} units, and for units with none the tonnage stated in their linked documents.` });
}
