/**
 * R31 (Team A, loop 3) — TECHNICIAN JOB-COUNT lookups, entity-first.
 *
 * WHY: analytics/detPlan.js only recognizes technician counts in a few literal wordings ("how many jobs did NAME
 * run/close out", "how many jobs has NAME done"); every other way a dispatcher asks ("job count for NAME",
 * "NAME's jobs in Tempe", "has NAME ever done a repair", "does A have more calls than B", "A plus B, total jobs",
 * "does every tech have at least 50") went to a paid model call, and one came back WRONG ("You have 10 customers"
 * for "count of Ray Sutton visits in Phoenix"). Here the entity comes first: a technician whose full name (from the
 * tenant's own extractions) appears verbatim in the question, plus at most one city / one service type, from closed
 * vocabularies; the answer is one indexed read over the extractions table.
 *
 * CLOSED-WORLD PRECISION GUARD (same idea as slotFill.js): once the technician name(s), the city, the service type
 * and the numeric threshold are accounted for, EVERY remaining word must be chatter or a count/relation word from
 * TLEX. Anything else — a time window ("last month", "2024"), a money / document / equipment word, a negation, an
 * unknown place ("Suite 110"), a second condition — returns null so the question falls to the existing planner /
 * model exactly as before. Also null: an unknown or ambiguous name, 3+ technicians, "and" between two names with no
 * combining word (a per-person breakdown is a different question).
 *
 * Counting rule = the one the exam oracle and analytics already use: one job per technician extraction
 * (extractions.field_key = 'technician'); city = the linked customer's service address city; service type = the
 * same document's service_type extraction.
 */
import { KNOWN_AZ_CITY_NAMES, KNOWN_US_CITY_NAMES } from "../analytics.js";
import { attachCitations, documentRecord } from "../citations/records.js";
import { stripConversationalFrame } from "../router/frame.js";
import { TENANT_SQL } from "../scope.js";
import { LEX } from "./lexicon.js";

const TLEX = new Set([
  ...[...LEX].filter((w) => !["no.", "nr", "num", "#", "ph"].includes(w)),
  ..."how many much number count counts total totals overall combined together plus both and or jobs job visits visit calls call logged log been done did does do run ran had been on ever any more busier than fewer less higher greater lighter technician technicians tech techs every each all at least above below over under minimum min or more done jobs work worked handled handle made completed complete finished far only ahead behind tally record anyone anybody under were was busy trail trails trailing lead leads leading".split(/\s+/),
]);
const TYPE_PHRASES = [
  [/\bpreventa?tive maintenance\b|\bpreventive\b|\bpreventative\b/, "Preventive Maintenance"],
  [/\bmaintenance\b|\bpm\b/, "Preventive Maintenance"],
  [/\brepairs?\b/, "Repair"],
];
const CITY_NAMES = [...new Set([...KNOWN_AZ_CITY_NAMES, ...KNOWN_US_CITY_NAMES].map((c) => String(c).toLowerCase()))].sort((a, b) => b.length - a.length);
const COUNT_NOUN = /\b(?:jobs?|visits?|calls?|service calls?)\b/;
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const norm = (s) => String(s ?? "").toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9'+ ]+/g, " ").replace(/\s+/g, " ").trim();

/** @returns {{kind:'total'|'city'|'ever'|'compare'|'sum'|'threshold', techs:string[], city?:string, type?:string, min?:number, dir?:'more'|'fewer'}|null} */
export function parseTechnician(question, tenantVocab) {
  const names = tenantVocab?.technicians?.phrases;
  if (!Array.isArray(names) || !names.length) return null;
  const raw = String(question ?? "").trim();
  if (!raw || raw.length > 200) return null;
  let t = norm(stripConversationalFrame(raw) ?? raw);
  if (!t || (t.match(/\?/g) ?? []).length > 1) return null;

  // 1. technician names (exact full names, verbatim in the question; possessive "'s" allowed)
  const hits = [];
  const t0 = t;
  for (const nm of names) {
    const re = new RegExp(`\\b${esc(norm(nm)).replace(/\s+/g, "\\s+")}(?:'s)?\\b`);
    const m = re.exec(t0);
    if (m) { hits.push({ nm: String(nm), at: m.index }); t = t.replace(re, " ").replace(/\s+/g, " "); }
  }
  if (hits.length > 2) return null;
  const found = hits.sort((x, y) => x.at - y.at).map((h) => h.nm); // question order (matters for "does A have more than B")

  // 2. numeric threshold ("at least 56", "at or above 50", "40+", "50 or more")
  let min = null;
  const thr = t.match(/\b(?:at least|at or above|minimum of|min)\s+(\d{1,4})\b|\b(\d{1,4})\s*\+|\b(\d{1,4})\s+or more\b/);
  let below = false;
  if (thr) { min = Number(thr[1] ?? thr[2] ?? thr[3]); t = t.replace(thr[0], " ").replace(/\s+/g, " "); }
  else {
    const thb = t.match(/\b(?:under|below|fewer than|less than)\s+(\d{1,4})\b/); // "is any technician under 56 jobs"
    if (thb) { min = Number(thb[1]); below = true; t = t.replace(thb[0], " ").replace(/\s+/g, " "); }
  }

  // 3. service type
  let type = null;
  for (const [re, label] of TYPE_PHRASES) {
    const m = t.match(re);
    if (m) { if (type && type !== label) return null; type = label; t = t.replace(re, " ").replace(/\s+/g, " "); }
  }

  // 4. city (one, from the closed AZ/US vocabulary)
  let city = null;
  for (const c of CITY_NAMES) {
    const re = new RegExp(`\\b${esc(c).replace(/\s+/g, "\\s+")}\\b`);
    if (re.test(t)) { if (city) return null; city = c; t = t.replace(re, " ").replace(/\s+/g, " "); }
  }

  // 5. closed-world guard over what is left
  const words = t.split(" ").filter(Boolean);
  if (!words.length || words.length > 24) return null;
  if (words.some((w) => !TLEX.has(w) || /n't$/.test(w))) return null;
  const has = (re) => re.test(t);
  if (!has(COUNT_NOUN) && !has(/\b(?:busier|busy|work|worked)\b/)) return null;
  if (has(/\bnot\b|\bnever\b|\bnone\b/)) return null;

  if (found.length === 0) {
    if (min !== null && !city && !type && has(/\b(?:tech|techs|technician|technicians)\b/)) {
      if (!below && has(/\b(?:every|each|all)\b/)) return { kind: "threshold", techs: [], min };
      if (below && has(/\b(?:any|anyone|anybody)\b/) && !has(/\b(?:every|each|all)\b/)) return { kind: "anyBelow", techs: [], min };
    }
    if (min !== null && below && !city && !type && has(/\b(?:anyone|anybody)\b/)) return { kind: "anyBelow", techs: [], min };
    return null;
  }
  if (min !== null) return null;
  if (found.length === 2) {
    if (city || type) return null;
    if (has(/\bthan\b/) || has(/\b(?:ahead|behind|trail|trails|trailing|lead|leads|leading)\b/)) {
      const fewer = has(/\b(?:fewer|less|lighter|behind|trail|trails|trailing)\b/), more = has(/\b(?:more|busier|higher|greater|ahead|lead|leads|leading)\b/);
      if (fewer === more) return null;
      return { kind: "compare", techs: found, dir: more ? "more" : "fewer" };
    }
    if (has(/\b(?:combined|together|plus|both)\b|\btotal of\b/)) return { kind: "sum", techs: found };
    return null;
  }
  if (has(/\bthan\b|\bmore\b|\bfewer\b|\bless\b|\bbusier\b|\bcombined\b|\bplus\b|\bboth\b|\bbelow\b|\bover\b|\bunder\b|\bahead\b|\bbehind\b|\bhigher\b|\bgreater\b|\btrail\w*|\blead(?:s|ing)?\b/)) return null;
  if (type) {
    if (city) return null;
    if (has(/\b(?:how many|number|count|total)\b/) && !has(/\bever\b|\bany\b/)) return { kind: "typeCount", techs: found, type };
    return { kind: "ever", techs: found, type };
  }
  if (has(/\bever\b|\bany\b/)) return null;
  return city ? { kind: "city", techs: found, city } : { kind: "total", techs: found };
}

const TECH_CTE = `SELECT x.id, x.document_id, coalesce(nullif(x.corrected_value, ''), x.value) AS tech
                    FROM extractions x WHERE x.field_key = 'technician' AND ${TENANT_SQL}`;

async function techRows(db, techs, { city = null, type = null } = {}) {
  const params = [techs];
  let joins = "";
  if (city) { params.push(`%, ${city.replace(/[\\%_]/g, "\\$&")},%`); joins += ` JOIN document_entity_links l ON l.document_id = t.document_id JOIN entities c ON c.id = l.entity_id AND c.entity_type = 'customer' AND c.merged_into IS NULL AND c.data->>'service_address' ILIKE $${params.length}`; }
  if (type) { params.push(type); joins += ` JOIN extractions s ON s.document_id = t.document_id AND s.field_key = 'service_type' AND lower(s.value) = lower($${params.length})`; }
  const { rows } = await db.raw(
    `SELECT DISTINCT t.id, t.tech, t.document_id, d.original_filename FROM (${TECH_CTE}) t LEFT JOIN documents d ON d.id = t.document_id ${joins}
       WHERE t.tech = ANY($1::text[])`,
    params
  );
  return rows;
}

const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
function answer(text, facts, rows, basis) {
  const seen = new Set();
  const records = [];
  for (const r of rows) {
    if (!r.document_id || seen.has(r.document_id)) continue;
    seen.add(r.document_id);
    records.push(documentRecord({ id: r.document_id, original_filename: r.original_filename }, { label: r.original_filename ?? "Service record", sublabel: r.tech }));
  }
  return attachCitations(
    { kind: "answer", text, facts, sources: [], confidence: 1, verifiedCount: facts.length, unverifiedCount: 0, closest: [] },
    { records, total: records.length, basis }
  );
}

export async function runTechnician(db, parsed) {
  const { kind, techs } = parsed;
  if (kind === "threshold" || kind === "anyBelow") {
    const { rows } = await db.raw(`SELECT tech, count(*)::int AS n FROM (${TECH_CTE}) t GROUP BY tech ORDER BY n ASC, tech ASC`, []);
    if (!rows.length) return null;
    const low = rows[0];
    if (kind === "anyBelow") {
      const under = rows.filter((r) => r.n < parsed.min);
      const txt = under.length
        ? `Yes — ${under.map((r) => `${r.tech} has ${r.n}`).join(", ")}, under ${parsed.min}.`
        : `No — nobody is under ${parsed.min}; the lowest is ${low.tech} with ${low.n} jobs.`;
      const docsB = await techRows(db, rows.map((r) => r.tech));
      return answer(txt, rows.map((r) => ({ label: r.tech, value: `${r.n} jobs`, sources: [] })), docsB, `Counted the technician entries on every service record, per technician (${rows.length} technicians).`);
    }
    const ok = rows.every((r) => r.n >= parsed.min);
    const text = ok
      ? `Yes — every technician has at least ${parsed.min} jobs on file; the lowest is ${low.tech} with ${low.n}.`
      : `No — ${rows.filter((r) => r.n < parsed.min).map((r) => `${r.tech} has ${r.n}`).join(", ")}, below ${parsed.min}. The lowest is ${low.tech}.`;
    const docs = await techRows(db, rows.map((r) => r.tech));
    return answer(text, rows.map((r) => ({ label: r.tech, value: `${r.n} jobs`, sources: [] })), docs, `Counted the technician entries on every service record, per technician (${rows.length} technicians).`);
  }
  const rows = await techRows(db, techs, { city: parsed.city, type: parsed.type });
  const per = new Map(techs.map((n) => [n, rows.filter((r) => r.tech === n).length]));
  const [a, b] = techs;
  const fact = (n) => ({ label: n, value: String(per.get(n)), sources: [] });
  if (kind === "compare") {
    const na = per.get(a), nb = per.get(b);
    const yes = parsed.dir === "more" ? na > nb : na < nb;
    return answer(`${yes ? "Yes" : "No"} — ${a} has ${plural(na, "job")} on file and ${b} has ${plural(nb, "job")}.`, [fact(a), fact(b)], rows, `Counted the technician entries on service records for ${a} and ${b}.`);
  }
  if (kind === "sum") {
    const total = per.get(a) + per.get(b);
    return answer(`${plural(total, "job")} combined — ${a} ${per.get(a)}, ${b} ${per.get(b)}.`, [{ label: "Combined jobs", value: String(total), sources: [] }, fact(a), fact(b)], rows, `Added the technician entries on service records for ${a} and ${b}.`);
  }
  const n = per.get(a);
  if (kind === "ever") {
    const label = parsed.type.toLowerCase();
    return answer(n > 0 ? `Yes — ${a} has ${plural(n, `${label} visit`)} on file.` : `No — nothing on file: ${a} has no ${label} visits.`, [fact(a)], rows, `Looked for ${label} service records with ${a} as technician.`);
  }
  if (kind === "typeCount") {
    const label = parsed.type.toLowerCase();
    return answer(`${a} has ${plural(n, `${label} visit`)} on file.`, [{ label: `${a} ${label} visits`, value: String(n), sources: [] }], rows, `Counted ${label} service records with ${a} as technician.`);
  }
  if (kind === "city") {
    const c = parsed.city.replace(/\b\w/g, (m) => m.toUpperCase());
    return answer(`${a} has ${plural(n, "job")} in ${c} on file.`, [{ label: `${a} jobs in ${c}`, value: String(n), sources: [] }], rows, `Counted service records with ${a} as technician at a customer whose service address is in ${c}.`);
  }
  return answer(`${a} has ${plural(n, "job")} on file.`, [{ label: `${a} jobs`, value: String(n), sources: [] }], rows, `Counted the service records with ${a} as technician.`);
}

/** The tenant's own technician names, as a tenantVocab-shaped bag — only used when the caller did not thread one. */
export async function loadTechnicianVocab(db) {
  const { rows } = await db.raw(`SELECT DISTINCT coalesce(nullif(corrected_value, ''), value) AS v FROM extractions WHERE field_key = 'technician' AND ${TENANT_SQL} AND coalesce(value, '') <> '' LIMIT 500`, []);
  return { technicians: { phrases: rows.map((r) => String(r.v).trim()).filter(Boolean) } };
}
