/**
 * R42 - multi-condition COUNTS read entirely from the asking organization's OWN data.
 *   "Bradford Whites out in Tucson, how many"      brand + city        -> units of that make at customers in that city
 *   "how many 40 gallon Rheem heaters do we have"  gallons + brand     -> units
 *   "water softener installs 2012?" / "Moen installs 2020?"  equipment kind or make + install year -> units
 *   "how many invoices went out under Tom Kessler in 2012"   technician + document type + year -> documents
 *   "how many slow drain in kitchen calls came from Marana"  service type + city / year           -> tickets
 *   "backflow certs from 2014?" / "how many failed backflows has Marcus Bell run"                  -> certificates
 * Every vocabulary item (make, equipment kind, gallons, city, technician, service type, document type) is read from THIS tenant's
 * rows by SQL; there is no built-in list. A make / technician that this organization does not have answers an honest 0 ("none on file"),
 * never the shop total. Anything not fully resolved (a leftover word, an ambiguous kind, two years) returns null and the lane steps aside.
 * Kill switch: DONOVAN_TENANT_COUNT=0.      pure gate: parseTenantCount     db: runTenantCount
 */
import { attachCitations } from "../citations/records.js";
import { customerRecordsFor, documentRecordsFor } from "../citations/enrich.js";
import { TENANT_SQL, answerEnvelope } from "../scope.js";

const VAL = (a) => `COALESCE(NULLIF(${a}.corrected_value, ''), ${a}.value)`;
const COUNT_CUE = /\b(?:how\s+many|number\s+of|count|total|tally)\b/i;
const SHAPE_CUE = /\b(?:units?|heaters?|installs?|installed|tickets?|calls?|jobs?|certs?|certificates?|tests?|invoic\w*|backflows?|fail\w*|softeners?|gal\w*|systems?|equipment)\b|\b(?:19|20)\d\d\b/i;

/** Pure cheap gate. @returns {kind:"tenant-count", question} or null. */
export function parseTenantCount(question) {
  if (process.env.DONOVAN_TENANT_COUNT === "0") return null;
  const raw = String(question ?? "").replace(/[’`]/g, "'").trim();
  if (!raw || raw.length > 160) return null;
  if (!COUNT_CUE.test(raw) && !/\b(?:19|20)\d\d\b/.test(raw) && !/\bcount\b/i.test(raw)) return null;
  if ((raw.match(/\b(?:19|20)\d\d\b/g) ?? []).some((y) => Number(y) > new Date().getFullYear())) return null;
  if (!SHAPE_CUE.test(raw) && !/\bin\s+[A-Z]/.test(raw)) return null;
  if (/\b(?:who|which|list|show|what|when|where|why|average|avg|most|least|oldest|newest|last|next|older|than|over|under \$|less)\b/i.test(raw) && !/\bunder\s+[A-Z]/.test(raw)) return null;
  return { kind: "tenant-count", question: raw };
}

/* ------------------------------------------------------------------ words */
const FILLER = new Set(`hey yo ok okay so um hmm hang on real quick one sorry more alright please lol thanks thx pls for me how many do we have did does go went out under came from get got
  count number of total tally are is there in at the a an to and or was were been has had it that this our all any ever on file by with run ran s unit units heater heaters install installs installed installation
  ticket tickets call calls job jobs test tests cert certs certificate certificates invoice invoices invoiced invoicing fail failed fails failing failures backflow backflows gallon gallons gal system systems equipment who i you us
  put done did made written wrote under per each then just`.split(/\s+/));
const GENERIC_TYPE_WORD = new Set("report certificate test inspection scope camera sheet record order quote ticket service job document paperwork line".split(" "));

const norm = (s) => String(s ?? "").toLowerCase().replace(/[’`]/g, "'").replace(/'s\b/g, "").replace(/\./g, "").replace(/[()]/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
const canon = (w) => w.replace(/s+$/, "");

/** Optimal-string-alignment distance. */
function osa(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[m][n];
}
/** Same word, allowing a plural / possessive and (for words of 5+ letters) one typo. */
function eq(a, b) {
  const x = canon(a), y = canon(b);
  if (x === y) return true;
  if (x.length < 5 || y.length < 5) return false;
  return osa(x, y) <= 1;
}
const fillerWord = (w) => FILLER.has(w) || FILLER.has(canon(w)) || (w.length >= 5 && [...FILLER].some((f) => f.length >= 5 && osa(canon(w), canon(f)) <= 1)) || /^(?:inv\w{3,}|fail\w*|gal\w+|gla\w+)$/.test(w) && w.length >= 5;

/** Index of a run of question words matching phrase words (unused only), or -1. */
function findSpan(qw, used, pw) {
  if (!pw.length) return -1;
  for (let i = 0; i + pw.length <= qw.length; i++) {
    let ok = true;
    for (let k = 0; k < pw.length; k++) if (used[i + k] || !eq(qw[i + k], pw[k])) { ok = false; break; }
    if (ok) return i;
  }
  return -1;
}
const mark = (used, i, n) => { for (let k = 0; k < n; k++) used[i + k] = true; };

/** Longest-first match of the question against a list of vocabulary values; returns {values, len} of the winners, marking the words used. */
function matchVocab(qw, used, values, keysOf) {
  let best = null;
  for (const v of values) {
    for (const key of keysOf(v)) {
      const pw = key.split(" ").filter(Boolean);
      const i = findSpan(qw, used, pw);
      if (i < 0) continue;
      if (!best || pw.length > best.len) best = { values: [v], len: pw.length, at: i };
      else if (pw.length === best.len && best.at === i && !best.values.includes(v)) best.values.push(v);
      else if (pw.length === best.len && best.at !== i && !best.values.includes(v)) best.values.push(v);
    }
  }
  if (best) mark(used, best.at, best.len);
  return best;
}

const typeKeys = (t) => {
  const m = /^(.*?)\s*\((.*?)\)\s*$/.exec(String(t));
  const base = norm(m ? m[1] : t), qual = m ? norm(m[2]) : "";
  return [...new Set([qual ? `${qual} ${base}` : null, qual ? `${base} ${qual}` : null, base].filter(Boolean))];
};

/* ------------------------------------------------------------------ vocabulary (this tenant's own rows) */
async function loadVocab(db) {
  const q = (sql, p = []) => db.raw(sql, p).then((r) => r.rows);
  const [brands, types, gallons, cities, techs, svcs, docTypes] = await Promise.all([
    q(`SELECT DISTINCT data->>'manufacturer' AS v FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT_SQL} AND data->>'manufacturer' IS NOT NULL`),
    q(`SELECT DISTINCT data->>'equipment_type' AS v FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT_SQL} AND data->>'equipment_type' IS NOT NULL`),
    q(`SELECT DISTINCT data->>'gallons' AS v FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT_SQL} AND data->>'gallons' IS NOT NULL`),
    q(`SELECT DISTINCT substring(data->>'service_address' from ',\\s*([^,]+),\\s*[A-Z]{2}') AS v FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL}`),
    q(`SELECT DISTINCT ${VAL("x")} AS v FROM extractions x WHERE x.field_key = 'technician' AND x.${TENANT_SQL}`),
    q(`SELECT DISTINCT ${VAL("x")} AS v FROM extractions x WHERE x.field_key = 'service_type' AND x.${TENANT_SQL}`),
    q(`SELECT DISTINCT document_type AS v FROM documents WHERE ${TENANT_SQL} AND document_type IS NOT NULL`),
  ]);
  const col = (rows) => rows.map((r) => r.v).filter((v) => v && String(v).trim()).map((v) => String(v).trim());
  return { brands: col(brands), types: col(types), gallons: col(gallons), cities: col(cities), techs: col(techs), svcs: col(svcs), docTypes: col(docTypes) };
}

/** Document type named by the question's remaining words, or {type:null}/ambiguous. */
function matchDocType(qw, used, docTypes) {
  const cands = docTypes.map((t) => {
    const tw = t.toLowerCase().split(/[-_ ]+/).filter(Boolean);
    const hits = [];
    for (const w of tw) {
      const idx = qw.findIndex((x, i) => !used[i] && (eq(x, w) || (x.length >= 4 && w.length >= 4 && (w.startsWith(canon(x)) || canon(x).startsWith(w)) && Math.min(x.length, w.length) >= 4) || [`${w}d`, `${w}ed`, `${w}ing`].some((f) => osa(canon(x), f) <= 1 && x.length >= 6)));
      if (idx >= 0) hits.push({ w, idx });
    }
    const distinct = hits.filter((h) => !GENERIC_TYPE_WORD.has(h.w));
    return { t, hits, distinct: distinct.length, frac: hits.length / tw.length, tw };
  }).filter((c) => c.hits.length && (c.distinct > 0 || c.tw.every((w) => GENERIC_TYPE_WORD.has(w))));
  if (!cands.length) return null;
  cands.sort((a, b) => b.distinct - a.distinct || b.frac - a.frac);
  if (cands[1] && cands[1].distinct === cands[0].distinct && cands[1].frac === cands[0].frac) return { ambiguous: true };
  for (const h of cands[0].hits) used[h.idx] = true;
  return { type: cands[0].t };
}

const empty = (text, basis) => attachCitations(answerEnvelope({ text, facts: [{ label: "Count", value: "0", sources: [] }], extra: { fastIntent: "tenant_count" } }), { records: [], total: 0, claimedCount: 0, basis });
const likeEsc = (s) => String(s).replace(/[\\%_]/g, "\\$&");

/** DB: the whole lane. @returns an answer envelope or null (step aside). */
export async function runTenantCount(db, intent) {
  const raw = intent.question;
  const yearM = raw.match(/\b(?:19|20)\d\d\b/g) ?? [];
  if (new Set(yearM).size > 1) return null;
  const year = yearM[0] ?? null;
  if (year && Number(year) > new Date().getFullYear()) return null; // a future year is a scheduling question, not a count of what is on file
  const countCue = COUNT_CUE.test(raw);
  const vocab = await loadVocab(db);

  // tokens of the question (apostrophe-s dropped), keep original-case for the capitalised-unknown check
  const rawToks = raw.replace(/'s\b/g, "").replace(/\./g, "").split(/[^A-Za-z0-9]+/).filter(Boolean);
  const qw = rawToks.map((t) => t.toLowerCase());
  const cap = rawToks.map((t) => /^[A-Z][a-z]/.test(t)); // R43: Title-case only; an ALL-CAPS word ("MANAGE") is shouting, not a name
  const poss = rawToks.map((t) => new RegExp(`\\b${t}'s\\b`).test(raw));
  const used = qw.map(() => false);
  if (year) { const yi = qw.indexOf(year); if (yi >= 0) used[yi] = true; }

  // gallons: "40 gallon", "50 galloners", "75 glalon"
  let gallonsVal = null;
  for (let i = 0; i + 1 < qw.length; i++) {
    if (/^\d{2,3}$/.test(qw[i]) && /^g[a-z]{3,9}$/.test(qw[i + 1]) && /^(?:gal|gla)/.test(qw[i + 1])) {
      const hits = vocab.gallons.filter((g) => (g.match(/\d+/) ?? [])[0] === qw[i]);
      if (hits.length !== 1) return null;
      gallonsVal = hits[0]; mark(used, i, 2);
    }
  }

  const svc = matchVocab(qw, used, vocab.svcs, (v) => [norm(v)]);
  if (svc && svc.values.length !== 1) return null;
  const techFull = matchVocab(qw, used, vocab.techs, (v) => [norm(v)]);
  if (techFull && techFull.values.length !== 1) return null;
  let tech = techFull?.values[0] ?? null;
  if (!tech) {
    const firsts = new Map();
    for (const t of vocab.techs) { const f = norm(t).split(" ")[0]; firsts.set(f, [...(firsts.get(f) ?? []), t]); }
    for (let i = 0; i < qw.length; i++) {
      if (used[i]) continue;
      const hit = [...firsts.entries()].filter(([f]) => eq(qw[i], f) && (cap[i] || poss[i] || qw[i] === f));
      // R43: a lone first name is never silently widened to the one technician who has it (verify:r39 'how many invoices did Dana do'): the older lanes decline or ask
      if (hit.length === 1 && hit[0][1].length === 1 && !FILLER.has(qw[i])) return null;
      if (hit.length === 1 && hit[0][1].length > 1) return null;
    }
  }
  const cityM = matchVocab(qw, used, vocab.cities, (v) => [norm(v)]);
  if (cityM && cityM.values.length !== 1) return null;
  const city = cityM?.values[0] ?? null;
  const brandM = matchVocab(qw, used, vocab.brands, (v) => [norm(v)]);
  if (brandM && brandM.values.length !== 1) return null;
  const brand = brandM?.values[0] ?? null;
  const typeM = matchVocab(qw, used, vocab.types, typeKeys);
  const typeAmb = !!typeM && typeM.values.length !== 1;
  const eqType = typeM && !typeAmb ? typeM.values[0] : null;
  const failCue = qw.some((w, i) => !used[i] && /^fail(?:ed|s|ing|ures?)?$/.test(w));
  let docType = null;
  if (!svc && !brand && !eqType) {
    const dm = matchDocType(qw, used, vocab.docTypes);
    if (dm?.ambiguous) return null;
    docType = dm?.type ?? null;
  }

  // what is left must be nothing but filler, or ONE unknown capitalised name (a make / technician this organization does not have)
  const left = qw.map((_w, i) => i).filter((i) => !used[i] && !fillerWord(qw[i]));
  let unknown = null, unknownCity = null;
  if (left.length) {
    const runs = [];
    for (const i of left) { const r = runs[runs.length - 1]; if (r && i === r[r.length - 1] + 1) r.push(i); else runs.push([i]); }
    if (runs.length > 2 || runs.some((r) => r.length > 2 || !r.every((i) => cap[i]) || r.some((i) => /^\d/.test(qw[i])))) return null;
    for (const r of runs) {
      const needle = r.map((i) => canon(qw[i])).join(" ");
      const { rows } = await db.raw(`SELECT count(*)::int AS n FROM entities WHERE merged_into IS NULL AND ${TENANT_SQL} AND lower(data::text) LIKE $1`, [`%${likeEsc(needle)}%`]);
      if (rows[0].n) return null; // the word is in this organization's records (a customer, street, model...): not ours to call unknown
      const item = { text: r.map((i) => rawToks[i]).join(" "), possessive: r.some((i) => poss[i]) };
      if (/^(?:in|from|at|near|around)$/.test(qw[r[0] - 1] ?? "") && !unknownCity) unknownCity = item; else if (!unknown) unknown = item; else return null;
    }
  }

  const equipWords = qw.some((w) => /^(?:units?|heaters?|installs?|installed|systems?|equipment|softeners?|haeters?|gal\w*)$/.test(w) || (w.length >= 5 && ["heaters", "installs", "installed", "equipment"].some((f) => osa(canon(w), canon(f)) <= 1)));
  if (!countCue && !year) return null;
  if (typeAmb && !(unknown || unknownCity)) return null;

  // ---- A. equipment units: make / kind / gallons (+ city, + install year)
  if ((brand || eqType || gallonsVal || (unknown && !unknown.possessive)) && !tech && !svc && !docType && !failCue) {
    if (!brand && !eqType && !gallonsVal && !unknown && !equipWords) return null;
    if (!city && !unknownCity && !year && !gallonsVal) return null;
    if (year && !qw.some((w) => /^install/.test(w) || (w.length > 6 && osa(w, "installs") <= 1) || (w.length > 6 && osa(w, "installed") <= 1))) return null;
    const label = [gallonsVal, brand ?? unknown?.text, eqType, year ? `installed ${year}` : null, city ? `in ${city}` : null].filter(Boolean).join(" ");
    if (unknownCity && !year && (brand || eqType || gallonsVal || unknown)) return empty(`0 units. No customer on file has a service address in ${unknownCity.text}, so there is nothing to count there.`, `Checked the service address of every customer on file for the city ${unknownCity.text}; none is there.`);
    if (unknown) {
      return empty(`0 units. This organization has no "${unknown.text}" make on file${city ? ` (checked ${city})` : ""}, so there is nothing to count.`, `Checked every make on this organization's equipment records for "${unknown.text}"; none is on file.`);
    }
    const p = []; const w = [];
    const add = (v) => { p.push(v); return `$${p.length}`; };
    if (brand) w.push(`lower(e.data->>'manufacturer') = lower(${add(brand)})`);
    if (eqType) w.push(`e.data->>'equipment_type' = ${add(eqType)}`);
    if (gallonsVal) w.push(`e.data->>'gallons' = ${add(gallonsVal)}`);
    if (year) w.push(`e.data->>'installation_date' LIKE ${add(`${year}-%`)}`);
    if (city) w.push(`c.data->>'service_address' ILIKE ${add(`%, ${likeEsc(city)}, %`)}`);
    const join = city ? `JOIN entities c ON c.id = e.customer_id AND c.merged_into IS NULL AND c.${TENANT_SQL}` : "";
    const { rows } = await db.raw(`SELECT e.id FROM entities e ${join} WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.${TENANT_SQL} AND ${w.join(" AND ")}`, p);
    const n = rows.length;
    return attachCitations(
      answerEnvelope({ text: n ? `${n} unit${n === 1 ? "" : "s"}: ${label} on file.` : `0 units: none on file for ${label}.`, facts: [{ label: `Count of units: ${label}`, value: String(n), entityIds: rows.slice(0, 20).map((r) => r.id), sources: [] }], extra: { fastIntent: "tenant_count" } }),
      { records: await customerRecordsFor(db, rows.map((r) => r.id)), total: n, claimedCount: n, basis: `Counted the equipment records matching ${label}, read from this organization's own data.` });
  }

  // ---- B. service type (+ year | + city)
  if (svc && !tech && !brand && !eqType && !gallonsVal && !failCue && !unknown && !unknownCity && !(year && city)) {
    const sv = svc.values[0];
    if (year) {
      const { rows } = await db.raw(`SELECT a.document_id FROM extractions a JOIN extractions s ON s.document_id = a.document_id AND s.field_key = 'service_date' AND s.${TENANT_SQL}
        WHERE a.field_key = 'service_type' AND a.${TENANT_SQL} AND ${VAL("a")} = $1 AND ${VAL("s")} LIKE $2`, [sv, `${year}-%`]);
      return docCount(db, rows.map((r) => r.document_id), `"${sv}" calls in ${year}`, `Counted the service records whose service type is "${sv}" and whose service date is in ${year}.`);
    }
    const { rows: tys } = await db.raw(`SELECT DISTINCT d.document_type AS t FROM extractions a JOIN documents d ON d.id = a.document_id AND d.${TENANT_SQL} WHERE a.field_key = 'service_type' AND a.${TENANT_SQL} AND ${VAL("a")} = $1`, [sv]);
    if (tys.length !== 1) return null;
    const p = [sv, tys[0].t]; let cityJoin = "";
    if (city) { p.push(`%, ${likeEsc(city)}, %`); cityJoin = `JOIN document_entity_links l ON l.document_id = d.id AND l.${TENANT_SQL} JOIN entities c ON c.id = l.entity_id AND c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL} AND c.data->>'service_address' ILIKE $3`; }
    const { rows } = await db.raw(`SELECT DISTINCT d.id AS document_id FROM documents d ${cityJoin} JOIN extractions a ON a.document_id = d.id AND a.field_key = 'service_type' AND a.${TENANT_SQL}
      WHERE d.${TENANT_SQL} AND d.document_type = $2 AND ${VAL("a")} = $1`, p);
    return docCount(db, rows.map((r) => r.document_id), `"${sv}" calls${city ? ` from ${city}` : ""}`, `Counted the ${tys[0].t.replace(/[-_]/g, " ")} documents whose service type is "${sv}"${city ? ` and whose customer's service address is in ${city}` : ""}.`);
  }

  // ---- C. a name this organization does not have, asked with a year: an honest zero
  if (unknownCity) return null;
  if (unknown?.possessive && year && !brand && !eqType && !svc && !gallonsVal && !tech) {
    return empty(`0. No technician named ${unknown.text} is on file in this organization's records, so there are no ${year} jobs to count.`, `Checked every technician name recorded on this organization's documents for "${unknown.text}"; none.`);
  }
  if (unknown) return null;

  // ---- D. documents of one kind: technician / failed result / year
  if (docType && !brand && !eqType && !gallonsVal && !svc && (tech || (year && (failCue || !/invoice|bill|credit/.test(norm(docType)))))) { // R43: an INVOICE kind + year alone ("how many invoices in 2025") belongs to the financial lanes, which word it and handle direction/credits
    const label = docType.replace(/[-_]/g, " ");
    const { rows: keys } = await db.raw(`SELECT x.field_key, count(DISTINCT x.document_id)::int AS n FROM extractions x JOIN documents d ON d.id = x.document_id AND d.${TENANT_SQL} WHERE x.${TENANT_SQL} AND d.document_type = $1 GROUP BY 1`, [docType]).then((r) => ({ rows: r.rows.filter((k) => String(k.field_key).endsWith("_date")) }));
    const stem = norm(docType).split(" ")[0];
    const dateKey = year ? (keys.find((k) => k.field_key.startsWith(stem)) ?? keys.find((k) => k.field_key === "service_date") ?? (keys.length === 1 ? keys[0] : null))?.field_key : null;
    if (year && !dateKey) return null;
    if (failCue) {
      if (!tech) return null;
      const { rows: rk } = await db.raw(`SELECT DISTINCT x.field_key FROM extractions x JOIN documents d ON d.id = x.document_id AND d.${TENANT_SQL} WHERE x.${TENANT_SQL} AND d.document_type = $1 AND ${VAL("x")} ILIKE 'fail%'`, [docType]).then((r) => ({ rows: r.rows.filter((k) => String(k.field_key).includes("result")) }));
      if (rk.length !== 1) return null;
      const { rows } = await db.raw(`SELECT DISTINCT a.document_id FROM extractions a JOIN extractions b ON b.document_id = a.document_id AND b.field_key = $2 AND b.${TENANT_SQL} JOIN documents d ON d.id = a.document_id AND d.${TENANT_SQL}
        WHERE a.field_key = 'technician' AND a.${TENANT_SQL} AND d.document_type = $3 AND lower(${VAL("a")}) = lower($1) AND ${VAL("b")} ILIKE 'fail%'${year ? ` AND EXISTS (SELECT 1 FROM extractions s WHERE s.document_id = a.document_id AND s.field_key = '${dateKey}' AND ${VAL("s")} LIKE $4 AND s.${TENANT_SQL})` : ""}`, year ? [tech, rk[0].field_key, docType, `${year}-%`] : [tech, rk[0].field_key, docType]);
      return docCount(db, rows.map((r) => r.document_id), `failed ${label}s run by ${tech}${year ? ` in ${year}` : ""}`, `Counted the ${label} documents ${tech} is recorded on whose result starts with "fail".`);
    }
    if (failCue) return null;
    const p = []; const add = (v) => { p.push(v); return `$${p.length}`; };
    const parts = [`d.document_type = ${add(docType)}`];
    if (tech) parts.push(`EXISTS (SELECT 1 FROM extractions a WHERE a.document_id = d.id AND a.field_key = 'technician' AND a.${TENANT_SQL} AND lower(${VAL("a")}) = lower(${add(tech)}))`);
    if (year) parts.push(`EXISTS (SELECT 1 FROM extractions s WHERE s.document_id = d.id AND s.field_key = ${add(dateKey)} AND s.${TENANT_SQL} AND ${VAL("s")} LIKE ${add(`${year}-%`)})`);
    const { rows } = await db.raw(`SELECT d.id AS document_id FROM documents d WHERE d.${TENANT_SQL} AND ${parts.join(" AND ")}`, p);
    return docCount(db, rows.map((r) => r.document_id), `${label}s${tech ? ` under ${tech}` : ""}${year ? ` in ${year}` : ""}`, `Counted the ${label} documents${tech ? ` that name ${tech} as technician` : ""}${year ? ` dated ${year} (${dateKey.replace(/_/g, " ")})` : ""}.`);
  }
  return null;
}

async function docCount(db, ids, label, basis) {
  const uniq = [...new Set(ids)];
  const n = uniq.length;
  if (!n) return empty(`0: no ${label} on file.`, basis);
  const src = uniq.slice(0, 40).map((documentId) => ({ documentId, location: { field: "service_type" } }));
  return attachCitations(
    answerEnvelope({ text: `${n} ${label}.`, facts: [{ label: label, value: String(n), sources: src.slice(0, 1) }], sources: src, extra: { fastIntent: "tenant_count" } }),
    { records: await documentRecordsFor(db, uniq.slice(0, 40)), total: n, claimedCount: n, basis });
}
