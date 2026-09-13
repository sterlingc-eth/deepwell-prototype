// Retrieval for /api/ask — deterministic, pure, no model involved.
//
// retrieve(question, body) → {
//   entities:     ExportedRecord[]  top-8 seeds + one hop via `related`, capped at ~24k chars
//   docIds:       Set<string>       documents cited anywhere in the retrieved context
//   closest:      SourceRef[]       top-5 docs by score, excerpt = plain-English why
//   retrievalIds: string[]          entity ids in context order
//   mentions:     { serials, models, addresses, names }
//   seeds:        string[]          the top-ranked entity ids before expansion
//   prompt:       { records, refs, refField, omitted }  what the model reads (see buildPromptContext)
// }

export const CONTEXT_CHAR_BUDGET = 24000;
const TOP_K = 8;
const MAX_SOURCES_PER_FIELD = 2;

const STOPWORDS = new Set(
  "a an the and or of to in on at for by with is are was were be been do does did has have had what when where which who whom whose how why is it its this that these those we our us you your i me my they them their he she his her from as into about over under still any all some there here up out off than then also just only more most much many can could would should will shall may might must not no yes if so".split(
    " ",
  ),
);

const STREET_SUFFIXES = new Set(
  "rd road st street ave avenue blvd boulevard dr drive ln lane ct court pl place way pkwy parkway hwy highway cir circle ter terrace trl trail loop".split(" "),
);
const DIRECTIONALS = new Set("n s e w ne nw se sw north south east west".split(" "));
const NAME_NOISE = new Set("family residence inc llc corp co ltd the".split(" "));

const WARRANTY_WORDS = /\b(warrant(y|ies)|expir(e|es|ed|ing|y)|cover(ed|age)?|register(ed)?)\b/i;
const SERVICE_WORDS = /\b(visit(s|ed)?|servic(e|ed|es|ing)|last|cost|charg(e|ed)|paid|pay|spent|spend|bill(ed)?|invoice|repair(ed|s)?|replac(ed|ement)|maintenance|did|done|work(ed)?)\b/i;
const INSTALL_WORDS = /\b(install(ed|ation)?)\b/i;
const EQUIPMENT_NOUNS = /\b(unit|units|equipment|furnace|boiler|heat pump|heat pumps|ac|air conditioner|condenser|thermostat|water heater|chiller|rooftop|handler)\b/i;

// Words that name a category or a time frame rather than a particular record.
// They drive type boosts but never decide which records of a category to keep.
const GENERIC_TERMS = new Set(
  "unit units equipment warranty warranties expire expires expired expiring expiry covered coverage cover registered visit visits visited service serviced services servicing last cost charge charged paid pay spent spend bill billed invoice repair repaired repairs replace replaced replacement maintenance did done work worked install installed installation next year years month months day days week weeks soon recent recently ago within today now current currently show everything anything something things have has had which what when who how many much sn serial model number".split(
    " ",
  ),
);

// ---------------------------------------------------------------------------
// Normalisers
// ---------------------------------------------------------------------------

const CONFUSABLES = { O: "0", I: "1", S: "5", B: "8" };

/** Uppercase, alphanumerics only, O/0 I/1 S/5 B/8 collapsed. */
export function serialKey(s) {
  return String(s)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/[OISB]/g, (c) => CONFUSABLES[c]);
}

const alnumKey = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, "");

export function tokenize(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const looksLikeSerial = (v) => /^[A-Z]{1,4}-?[A-Z]{2,4}-?\d{5,8}$/i.test(String(v).trim());
const looksLikeModel = (v) => {
  const s = String(v).trim();
  return s.length >= 3 && s.length <= 20 && /^[A-Z0-9]+(-[A-Z0-9]+)*$/i.test(s) && /\d/.test(s) && /[A-Z]/i.test(s);
};

/** "4521 E Camelback Rd" → { number: "4521", street: ["camelback"] } */
export function parseAddress(v) {
  const m = /^\s*(\d{1,6})\s+(.+)$/.exec(String(v));
  if (!m) return null;
  const words = tokenize(m[2].split(",")[0]).filter((w) => !DIRECTIONALS.has(w) && !STREET_SUFFIXES.has(w) && !/^\d+(st|nd|rd|th)$/.test(w));
  // Ordinal streets ("24th St") keep their ordinal as the street token.
  const ordinal = tokenize(m[2]).find((w) => /^\d+(st|nd|rd|th)$/.test(w));
  if (ordinal) words.unshift(ordinal);
  return { number: m[1], street: words };
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

function fieldValues(rec) {
  const out = [];
  for (const [key, f] of Object.entries(rec.fields ?? {})) {
    const v = f && typeof f === "object" && "value" in f ? f.value : f;
    if (v === null || v === undefined || v === "") continue;
    out.push({ key, value: String(v) });
  }
  return out;
}

function indexRecord(rec) {
  const values = fieldValues(rec);
  const serials = [];
  const models = [];
  const addresses = [];
  const nameTokens = new Set();
  const names = [];
  for (const { key, value } of values) {
    const k = key.toLowerCase();
    if (k.includes("serial") || looksLikeSerial(value)) serials.push(value);
    else if (k.includes("model") || (k !== "zip" && looksLikeModel(value))) models.push(value);
    if (k.includes("address")) {
      const a = parseAddress(value);
      if (a) addresses.push({ raw: value, ...a });
    }
    if (/name|customer|technician|installedby/.test(k) && !/id$/.test(k) && !/^[A-Z]+\d+$/i.test(value)) {
      names.push(value);
      for (const t of tokenize(value)) if (t.length >= 3 && !NAME_NOISE.has(t)) nameTokens.add(t);
    }
  }
  if (rec.type === "customer" || rec.type === "technician") {
    names.push(rec.label ?? "");
    for (const t of tokenize(rec.label)) if (t.length >= 3 && !NAME_NOISE.has(t)) nameTokens.add(t);
  }
  if (rec.type === "property" && rec.label) {
    const a = parseAddress(rec.label);
    if (a && !addresses.some((x) => x.raw === rec.label)) addresses.push({ raw: rec.label, ...a });
  }
  const text = [rec.label ?? "", ...values.map((v) => v.value)].join(" ");
  const terms = new Map();
  for (const t of tokenize(text)) if (!STOPWORDS.has(t)) terms.set(t, (terms.get(t) ?? 0) + 1);
  return { rec, serials, models, addresses, names, nameTokens, terms, text: text.toLowerCase() };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function scoreRecord(ix, q, idf, hits) {
  let score = 0;
  const why = [];
  const kinds = new Set(); // serial | model | address | fullName | partialName

  for (const s of ix.serials) {
    const key = serialKey(s);
    if (key.length >= 6 && q.serialBlob.includes(key)) {
      score += 100;
      why.push(s);
      kinds.add("serial");
      hits.serials.add(s);
    }
  }
  for (const m of ix.models) {
    const key = alnumKey(m);
    if (key.length >= 3 && q.alnumTokens.has(key)) {
      score += 80;
      why.push(m);
      kinds.add("model");
      hits.models.add(m);
    }
  }
  for (const a of ix.addresses) {
    const numberHit = q.tokens.has(a.number);
    const streetHits = a.street.filter((w) => q.tokens.has(w) || (w.length > 4 && q.tokens.has(w.replace(/s$/, ""))));
    if (numberHit && streetHits.length) {
      score += 60 + 10 * streetHits.length;
      why.push(a.raw);
      kinds.add("address");
      hits.addresses.add(a.raw);
    } else if (streetHits.length) {
      score += 25 + 10 * (streetHits.length - 1);
      why.push(a.raw);
      kinds.add("address");
      hits.addresses.add(a.raw);
    } else if (numberHit) {
      score += 10;
    }
  }
  if (ix.nameTokens.size) {
    const matched = [...ix.nameTokens].filter((t) => q.tokens.has(t));
    if (matched.length) {
      const full = ix.names.find((n) => {
        const toks = tokenize(n).filter((t) => !NAME_NOISE.has(t));
        return toks.length > 1 && toks.every((t) => q.tokens.has(t));
      });
      score += full ? 50 : 35;
      const shown = full ?? ix.names.find((n) => tokenize(n).some((t) => matched.includes(t))) ?? matched[0];
      why.push(shown);
      kinds.add(full ? "fullName" : "partialName");
      hits.names.add(shown);
      if (full) hits.fullNames.add(full);
    }
  }

  // BM25-ish overlap for everything else (manufacturer, equipment type, work performed…)
  let lexical = 0;
  for (const t of q.terms) {
    const tf = ix.terms.get(t) ?? (t.length > 4 ? ix.terms.get(t.replace(/s$/, "")) ?? 0 : 0);
    if (!tf) continue;
    lexical += (idf.get(t) ?? 1) * ((tf * 2.2) / (tf + 1.2));
  }
  lexical = Math.min(lexical, 40);
  score += lexical;

  // Type boosts from question intent.
  const type = ix.rec.type;
  if (q.warranty && type === "equipment") score += 15;
  if (q.service && type === "service") score += 15;
  if (q.install && (type === "service" || type === "equipment")) score += 10;

  return { score, why, lexical, kinds };
}

// ---------------------------------------------------------------------------
// Context shaping
// ---------------------------------------------------------------------------

/** Prompt-side record: label + fields with ≤2 sources each and no excerpt (re-attached after the call). */
export function compactRecord(rec) {
  const fields = {};
  for (const [key, f] of Object.entries(rec.fields ?? {})) {
    if (!f || typeof f !== "object") continue;
    const sources = (f.sources ?? []).slice(0, MAX_SOURCES_PER_FIELD).map((s) => ({ documentId: s.documentId, location: s.location ?? {} }));
    fields[key] = { value: f.value, sources };
  }
  return { entityId: rec.entityId, type: rec.type, label: rec.label, fields };
}

function recordChars(rec) {
  return JSON.stringify(compactRecord(rec)).length;
}

const hasValues = (rec) => fieldValues(rec).length > 0;

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad2 = (n) => String(n).padStart(2, "0");

/** "Nov 22, 2029" / "22 Nov 2029" / "2029-11-22" / "11/22/2029" → "2029-11-22", else null. Whole-value dates only. */
export function isoDate(value) {
  const s = String(value ?? "").trim();
  let m;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) return `${m[3]}-${pad2(m[1])}-${pad2(m[2])}`;
  if ((m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(s))) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    return mo ? `${m[3]}-${pad2(mo)}-${pad2(m[2])}` : null;
  }
  if ((m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(s))) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    return mo ? `${m[3]}-${pad2(mo)}-${pad2(m[1])}` : null;
  }
  return null;
}

const dayNumber = (iso) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86400000);
const DAY_MS = 86400000;
const isoOf = (d) => d.toISOString().slice(0, 10);

/**
 * The relative windows a dispatcher asks about, as inclusive ISO ranges from `today`.
 * Every date field in the prompt lists the windows it falls inside (`within`), and the
 * message prints the same table, so "next 12 months" or "last fall" is a string match
 * for the model rather than calendar arithmetic. Seasons are meteorological.
 */
export function dateWindows(today) {
  const t = new Date(`${isoDate(today) ?? ""}T00:00:00Z`);
  if (Number.isNaN(t.getTime())) return [];
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth() + 1;
  const plusDays = (n) => isoOf(new Date(t.getTime() + n * DAY_MS));
  const plusMonths = (n) => isoOf(new Date(Date.UTC(y, t.getUTCMonth() + n, t.getUTCDate())));
  const summerYear = m >= 6 ? y : y - 1; // the most recent summer that has started
  const fallYear = y - 1; // the most recent complete fall (fall = Sep–Nov)
  const winterYear = y - 1; // the winter that began Dec of the previous year
  const springYear = m >= 3 ? y : y - 1;
  return [
    { name: "next 30 days", from: plusDays(1), to: plusDays(30) },
    { name: "next 90 days", from: plusDays(1), to: plusDays(90) },
    { name: "next 6 months", from: plusDays(1), to: plusMonths(6) },
    { name: "next 12 months", from: plusDays(1), to: plusMonths(12) },
    { name: "next 2 years", from: plusDays(1), to: plusMonths(24) },
    { name: "past 90 days", from: plusDays(-90), to: plusDays(-1) },
    { name: "past 12 months", from: plusMonths(-12), to: plusDays(-1) },
    { name: "this year", from: `${y}-01-01`, to: `${y}-12-31` },
    { name: "last year", from: `${y - 1}-01-01`, to: `${y - 1}-12-31` },
    { name: "next year", from: `${y + 1}-01-01`, to: `${y + 1}-12-31` },
    { name: "this summer", from: `${summerYear}-06-01`, to: `${summerYear}-08-31` },
    { name: "last summer", from: `${summerYear - 1}-06-01`, to: `${summerYear - 1}-08-31` },
    { name: "this fall", from: `${m >= 9 ? y : y - 1}-09-01`, to: `${m >= 9 ? y : y - 1}-11-30` },
    { name: "last fall", from: `${fallYear}-09-01`, to: `${fallYear}-11-30` },
    { name: "last winter", from: `${winterYear}-12-01`, to: `${winterYear + 1}-02-29` },
    { name: "this spring", from: `${springYear}-03-01`, to: `${springYear}-05-31` },
    { name: "last spring", from: `${springYear - 1}-03-01`, to: `${springYear - 1}-05-31` },
  ];
}

const UNIT_DAYS = { day: 1, week: 7 };

/**
 * The date windows a question asks about, as inclusive ISO ranges: named ones
 * ("last fall"), rolling ones ("next 18 months", "past 2 years"), "soon" /
 * "recently", and explicit years ("in 2025"). Deterministic; used to tell the
 * model exactly which records fall inside.
 */
export function detectWindows(question, today) {
  const q = String(question ?? "").toLowerCase();
  const all = dateWindows(today);
  const t = new Date(`${isoDate(today) ?? ""}T00:00:00Z`);
  if (Number.isNaN(t.getTime())) return [];
  const out = [];
  const seen = new Set();
  const add = (w) => {
    if (w && !seen.has(w.name)) {
      seen.add(w.name);
      out.push(w);
    }
  };
  const shift = (n, unit, sign) => {
    if (UNIT_DAYS[unit]) return isoOf(new Date(t.getTime() + sign * n * UNIT_DAYS[unit] * DAY_MS));
    const months = unit === "year" ? 12 * n : n;
    return isoOf(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + sign * months, t.getUTCDate())));
  };
  let m;
  const rolling = /\b(next|coming|past|last|previous)\s+(\d{1,3})\s+(day|week|month|year)s?\b/g;
  while ((m = rolling.exec(q))) {
    const n = Number(m[2]);
    const unit = m[3];
    const future = m[1] === "next" || m[1] === "coming";
    const name = `${future ? "next" : "past"} ${n} ${unit}${n === 1 ? "" : "s"}`;
    add(future ? { name, from: shift(1, "day", 1), to: shift(n, unit, 1) } : { name, from: shift(n, unit, -1), to: shift(1, "day", -1) });
  }
  for (const w of all) if (q.includes(w.name)) add(w);
  if (/\b(soon|expiring|about to expire|coming up|upcoming)\b/.test(q) && !out.some((w) => w.name.startsWith("next"))) add(all.find((w) => w.name === "next 90 days"));
  if (/\b(recently|lately)\b/.test(q)) add(all.find((w) => w.name === "past 90 days"));
  const year = /\b(?:in|during|for|of|since)\s+((?:19|20)\d\d)\b/g;
  while ((m = year.exec(q))) add({ name: m[1], from: `${m[1]}-01-01`, to: `${m[1]}-12-31` });
  return out;
}

/**
 * What the model actually reads. Each distinct source (documentId + location)
 * becomes a short ref ("s12") so the model cites by ref instead of copying
 * long ids — fewer output tokens, no copy errors. Date fields get `iso` and
 * `when` ("in 238 days" / "546 days ago", relative to `today`) so the model
 * compares plain numbers instead of doing calendar arithmetic. Records with no field values are left out unless
 * they are people (a technician or customer record is the entity the answer
 * points at; an empty service record only leaks a date from a held-back
 * document through its label).
 *
 * buildPromptContext(entities, today) → { records, refs: Map<ref, SourceRef>, refField: Map<ref, {entityId, field, days?, empty}>, omitted: string[] }
 */
export function buildPromptContext(entities, today, allRecords = entities) {
  const refs = new Map();
  const refField = new Map(); // ref → { entityId, field, days? } of the first field that cited it
  const byKey = new Map();
  const todayIso = isoDate(today);
  const todayDay = todayIso ? dayNumber(todayIso) : null;
  const windows = dateWindows(today);
  const labelOf = new Map(allRecords.map((r) => [r.entityId, r]));
  const refFor = (s, owner) => {
    const loc = s.location ?? {};
    const key = `${s.documentId}|${loc.page ?? ""}|${loc.field ?? ""}`;
    let ref = byKey.get(key);
    if (!ref) {
      ref = `s${refs.size + 1}`;
      byKey.set(key, ref);
      const out = { documentId: s.documentId, location: {} };
      if (typeof loc.page === "number") out.location.page = loc.page;
      if (typeof loc.field === "string" && loc.field) out.location.field = loc.field;
      if (typeof s.excerpt === "string" && s.excerpt) out.excerpt = s.excerpt;
      refs.set(ref, out);
      refField.set(ref, owner);
    }
    return ref;
  };
  const records = [];
  const keep = (rec) => rec.type === "customer" || rec.type === "technician" || hasValues(rec);
  const omitted = entities.filter((r) => !keep(r)).map((r) => r.entityId);
  // Ids of omitted records must not appear anywhere: "SVC-20260808-001" alone is enough to invent a visit from.
  const inContext = new Set(entities.filter(keep).map((r) => r.entityId));
  for (const rec of entities) {
    if (!keep(rec)) continue;
    const fields = {};
    for (const [key, f] of Object.entries(rec.fields ?? {})) {
      if (!f || typeof f !== "object") continue;
      const field = { value: f.value };
      const iso = isoDate(f.value);
      let days;
      if (iso) {
        field.iso = iso;
        if (todayDay !== null) {
          days = dayNumber(iso) - todayDay;
          field.when = days < 0 ? `${-days} days ago` : days === 0 ? "today" : `in ${days} days`;
          // Every date says which named windows it falls inside, so "next 12 months" or "last fall" is a string match, not arithmetic.
          field.within = windows.filter((w) => iso >= w.from && iso <= w.to).map((w) => w.name);
        }
      }
      const owner = { entityId: rec.entityId, field: key, empty: f.value === "" || f.value === null || f.value === undefined };
      if (days !== undefined) owner.days = days;
      const sources = (f.sources ?? []).filter((s) => s && typeof s.documentId === "string").slice(0, MAX_SOURCES_PER_FIELD).map((s) => refFor(s, owner));
      if (sources.length) field.src = sources;
      fields[key] = field;
    }
    const out = { id: rec.entityId, type: rec.type, label: rec.label, fields };
    // Service and equipment records carry no address of their own: say which property (and unit) they belong to in words,
    // and keep `related` for the ids.
    const relatedAll = Array.isArray(rec.related) ? rec.related : [];
    if (rec.type === "service" || rec.type === "equipment") {
      const prop = relatedAll.map((id) => labelOf.get(id)).find((r) => r && r.type === "property");
      if (prop?.label) out.at = prop.label;
      if (rec.type === "service") {
        const unit = relatedAll.map((id) => labelOf.get(id)).find((r) => r && r.type === "equipment");
        if (unit?.label) out.unit = unit.label;
      }
    }
    const related = relatedAll.filter((id) => id !== rec.entityId && inContext.has(id));
    if (related.length) out.related = related;
    records.push(out);
  }
  // Group by type so the model scans like a person would: places, units, then visits newest first, then people.
  const order = { property: 0, customer: 1, equipment: 2, service: 3, technician: 4 };
  const dateOf = (r) => r.fields?.date?.iso ?? "";
  records.sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9) || (a.type === "service" ? dateOf(b).localeCompare(dateOf(a)) : 0));
  return { records, refs, refField, omitted };
}

function docsOfRecord(rec) {
  const ids = new Set();
  for (const f of Object.values(rec.fields ?? {})) for (const s of f?.sources ?? []) if (s?.documentId) ids.add(s.documentId);
  return ids;
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

const SERIAL_MENTION = /\b[A-Z]{1,4}-?[A-Z]{2,4}-?\d{5,8}\b/gi;

export function analyzeQuestion(question) {
  const raw = String(question ?? "");
  const tokens = new Set(tokenize(raw));
  // Pieces of a serial ("sn", "rhe", "456789") are matched exactly by the serial
  // scorer; as lexical terms they would pull in every sibling serial.
  const serialParts = new Set((raw.match(SERIAL_MENTION) ?? []).flatMap(tokenize));
  // Lexical terms: no stopwords, no 1–2 digit numbers ("12 Main St" must not match "Jan 12").
  const terms = [...tokens].filter((t) => !STOPWORDS.has(t) && !/^\d{1,2}$/.test(t) && !serialParts.has(t));
  const alnumTokens = new Set(raw.split(/[\s,;:!?()"]+/).map(alnumKey).filter(Boolean));
  const distinguishing = terms.filter((t) => !GENERIC_TERMS.has(t) && !/^\d+$/.test(t));
  return {
    raw,
    tokens,
    terms,
    distinguishing,
    alnumTokens,
    serialBlob: serialKey(raw),
    warranty: WARRANTY_WORDS.test(raw),
    service: SERVICE_WORDS.test(raw),
    install: INSTALL_WORDS.test(raw),
    equipmentNoun: EQUIPMENT_NOUNS.test(raw),
  };
}

export function retrieve(question, body = {}) {
  const records = Array.isArray(body.records) ? body.records.filter((r) => r && typeof r.entityId === "string") : [];
  const catalog = Array.isArray(body.docs) ? body.docs : [];
  const q = analyzeQuestion(question);
  const empty = { entities: [], docIds: new Set(), closest: [], retrievalIds: [], mentions: { serials: [], models: [], addresses: [], names: [] }, seeds: [] };
  if (!records.length) return empty;

  const indexed = records.map(indexRecord);
  const byId = new Map(indexed.map((ix) => [ix.rec.entityId, ix]));

  // idf over the records
  const df = new Map();
  for (const ix of indexed) for (const t of ix.terms.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const N = indexed.length;
  const idf = new Map();
  for (const [t, d] of df) idf.set(t, Math.log(1 + (N - d + 0.5) / (d + 0.5)));

  const hits = { serials: new Set(), models: new Set(), addresses: new Set(), names: new Set(), fullNames: new Set() };
  const scored = indexed.map((ix) => ({ ix, ...scoreRecord(ix, q, idf, hits) }));
  scored.sort((a, b) => b.score - a.score || a.ix.rec.entityId.localeCompare(b.ix.rec.entityId));

  const specific = hits.serials.size + hits.models.size + hits.addresses.size + hits.names.size > 0;

  // Bidirectional adjacency from `related`.
  const adj = new Map();
  const link = (a, b) => {
    if (!byId.has(a) || !byId.has(b) || a === b) return;
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a).add(b);
  };
  for (const r of records) for (const rel of r.related ?? []) {
    link(r.entityId, rel);
    link(rel, r.entityId);
  }

  // Seeds: top-8 with a positive score. Category questions with no specific
  // mention ("Which heat pump warranties expire next year?") take every record
  // of the boosted type instead — ~15 equipment records fit the budget.
  let seeds = scored.filter((s) => s.score > 0);
  let anchored = false;
  if (specific) {
    // Something concrete was named: keep the records that name it, plus lexical
    // matches strong enough to mean something ("compressor replacement"); type
    // boosts alone (+15 service, +10 install) do not qualify.
    seeds = seeds.filter((s) => s.why.length > 0 || s.lexical >= 20);
    // "David Chen" was named in full: a record that only shares the first name
    // ("David Martinez") is not a match.
    if (hits.fullNames.size) seeds = seeds.filter((s) => !(s.kinds.size === 1 && s.kinds.has("partialName")) || s.lexical >= 20);
    // A place was named ("Maria at 3210 E Broadway", "David at the Johnson place",
    // "Van Buren"): it anchors the answer even when it scores below a person's
    // visits, and that person's visits and installs elsewhere are noise.
    const isPlace = (s) => (s.ix.rec.type === "property" || s.ix.rec.type === "customer") && (s.kinds.has("address") || s.kinds.has("fullName") || s.kinds.has("partialName"));
    const anchors = seeds.filter(isPlace);
    if (anchors.length) {
      const near = new Set(anchors.map((s) => s.ix.rec.entityId));
      for (const a of [...near]) for (const n of adj.get(a) ?? []) near.add(n);
      const nearPlace = (id) => near.has(id) || [...(adj.get(id) ?? [])].some((n) => near.has(n));
      const keep = (s) => s.kinds.has("serial") || s.kinds.has("model") || s.ix.rec.type === "technician" || nearPlace(s.ix.rec.entityId);
      seeds = [...anchors, ...seeds.filter((s) => !isPlace(s) && keep(s))];
      anchored = true;
    }
    seeds = seeds.slice(0, TOP_K);
  } else if (missingCategory(q, indexed) || addressLike(q.raw)) {
    // The question names a place or a kind of equipment that no record has
    // ("the boiler at 12 Main St"): do not widen to a whole category.
    seeds = [];
  } else {
    seeds = seeds.slice(0, TOP_K);
    const types = new Set();
    if (q.warranty || q.equipmentNoun) types.add("equipment");
    if (q.service && !q.warranty) types.add("service");
    if (q.install) types.add("equipment");
    if (types.size) {
      const category = scored.filter((s) => types.has(s.ix.rec.type));
      // If the question names a make/type ("Rheem", "heat pump"), keep only the records that mention it.
      const mentioned = category.filter((s) => q.distinguishing.some((t) => hasTerm(s.ix, t)));
      seeds = mentioned.length ? mentioned : category;
    }
  }

  const seedIds = seeds.map((s) => s.ix.rec.entityId);
  const seedScore = new Map(seeds.map((s) => [s.ix.rec.entityId, s.score]));
  const hop = new Map(); // id → priority
  // When a place anchors the question, the technician seed stays for its id but does not pull in their visits elsewhere.
  const hopFrom = anchored ? seedIds.filter((id) => byId.get(id).rec.type !== "technician") : seedIds;
  for (const id of hopFrom) {
    for (const n of adj.get(id) ?? []) {
      if (seedScore.has(n)) continue;
      const base = (seedScore.get(id) ?? 0) * 0.5 + (byId.get(n).rec.type === "property" ? 5 : 0) + (byId.get(n).rec.type === "service" && q.service ? 5 : 0);
      hop.set(n, Math.max(hop.get(n) ?? 0, base));
    }
  }
  const hopIds = [...hop.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id);

  // Budget.
  const entities = [];
  let chars = 2;
  for (const id of [...seedIds, ...hopIds]) {
    const rec = byId.get(id).rec;
    const c = recordChars(rec) + 1;
    if (chars + c > CONTEXT_CHAR_BUDGET) {
      if (entities.length === 0) entities.push(rec); // never return nothing when something matched
      continue;
    }
    chars += c;
    entities.push(rec);
  }

  const docIds = new Set();
  for (const rec of entities) for (const d of docsOfRecord(rec)) docIds.add(d);

  // Closest docs: score each doc by the entities it touches.
  const entityScore = new Map(scored.map((s) => [s.ix.rec.entityId, s]));
  const docEntities = new Map();
  for (const d of catalog) if (d && d.documentId) docEntities.set(d.documentId, new Set(d.entityIds ?? []));
  for (const rec of records) for (const d of docsOfRecord(rec)) {
    if (!docEntities.has(d)) docEntities.set(d, new Set());
    docEntities.get(d).add(rec.entityId);
  }
  const docScores = [];
  for (const [documentId, ids] of docEntities) {
    let score = 0;
    const why = new Set();
    for (const id of ids) {
      const s = entityScore.get(id);
      if (!s) continue;
      score += s.score;
      for (const w of s.why) why.add(w);
    }
    if (score <= 0) continue;
    docScores.push({ documentId, score, why: [...why], ids });
  }
  docScores.sort((a, b) => b.score - a.score || a.documentId.localeCompare(b.documentId));

  const missingNoun = missingCategory(q, indexed);
  const closest = docScores.slice(0, 5).map(({ documentId, why, ids }) => {
    const parts = [];
    if (why.length) parts.push(`mentions ${why.slice(0, 3).join(", ")}`);
    else parts.push(`related to ${[...ids].map((id) => byId.get(id)?.rec.label ?? id).slice(0, 2).join(", ")}`);
    if (missingNoun) parts.push(`no ${missingNoun} on file`);
    return { documentId, location: firstLocation(documentId, ids, byId), excerpt: parts.join("; ") };
  });

  return {
    entities,
    docIds,
    closest,
    retrievalIds: entities.map((r) => r.entityId),
    mentions: { serials: [...hits.serials], models: [...hits.models], addresses: [...hits.addresses], names: [...hits.names] },
    seeds: seedIds,
    prompt: buildPromptContext(entities, body.today, records),
  };
}

/** "12 Main St" → true; "90 days" / "2 years" → false. */
export function addressLike(text) {
  const re = /\b(\d{1,6})\s+(?:[NSEW]\.?\s+)?([A-Za-z][A-Za-z']+)/g;
  let m;
  while ((m = re.exec(String(text)))) {
    const word = m[2].toLowerCase();
    if (!GENERIC_TERMS.has(word) && !STOPWORDS.has(word) && !DIRECTIONALS.has(word)) return true;
  }
  return false;
}

/** Does the indexed record contain the term (or its singular)? */
function hasTerm(ix, t) {
  if (ix.terms.has(t)) return true;
  return t.length > 4 && t.endsWith("s") && ix.terms.has(t.slice(0, -1));
}

function firstLocation(documentId, ids, byId) {
  for (const id of ids) {
    const rec = byId.get(id)?.rec;
    if (!rec) continue;
    for (const f of Object.values(rec.fields ?? {})) for (const s of f?.sources ?? []) if (s.documentId === documentId) return s.location ?? {};
  }
  return {};
}

/** An equipment noun in the question that appears in no record at all → "no boiler on file". */
function missingCategory(q, indexed) {
  const m = EQUIPMENT_NOUNS.exec(q.raw);
  if (!m) return null;
  const noun = m[1].toLowerCase();
  if (noun === "unit" || noun === "units" || noun === "equipment") return null;
  const stem = noun.replace(/s$/, "");
  return indexed.some((ix) => ix.text.includes(stem)) ? null : noun;
}
