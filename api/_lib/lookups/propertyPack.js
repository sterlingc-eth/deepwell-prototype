/**
 * R41N (E2): property-pack deterministic lane for RESIDENT / LEASE / UNIT questions.
 *
 * In a property tenant the residents are NOT customer entities (customers are the building owners): a tenant's name, unit, lease
 * dates, rent and deposit exist only as extractions on the lease-agreement / move-in-inspection / move-out-inspection documents, and a
 * unit's vendor history exists only on its work-order documents. Every answer here is derived from those extractions and cited to the
 * documents it was read from. Nothing is inferred: when the tenant, the unit or the field is not on file the lane either says so
 * (only when it is certain) or returns null and lets the normal pipeline decide.
 *
 * Gate: ask.js calls this only when the calling tenant's industry pack is "property". Nothing here runs for hvac / plumbing / electrical.
 * Exports: tryPropertyPack(db, question, {today}) -> answer | null,  isResidentTenantsQuestion(q) (safety-gate carve-out).
 */
import { attachCitations, documentRecord, makeRecord } from "../citations/records.js";
import { ADDRESS_RE } from "./clarify.js";
import { notPrivateSql } from "../privacy/privateDocs.js";

const esc = (s) => String(s).replace(/[\\%_]/g, "\\$&");
const norm = (s) => ` ${String(s ?? "").toLowerCase().replace(/[’']s\b/g, "").replace(/[^a-z0-9#]+/g, " ").trim()} `;
const UNIT_RE = /(?:\b(?:unit|apt|apartment|suite)\s*#?\s*|#\s*|\b(?:in|at|of)\s+)(\d[A-Za-z]\d?)\b/;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function prettyDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  if (!m) return String(iso ?? "");
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]} (${m[1]}-${m[2]}-${m[3]})`;
}
function money(v) {
  const n = Number(String(v).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : String(v);
}

function dl(a, b) { // Damerau-free Levenshtein, small strings
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

async function loadFields(db, docIds) {
  if (!docIds.length) return new Map();
  const r = await db.raw(
    `SELECT x.document_id, x.field_key, x.value, d.original_filename, d.document_type
       FROM extractions x JOIN documents d ON d.id = x.document_id AND ${notPrivateSql("d")} WHERE x.document_id = ANY($1::uuid[])`,
    [docIds]
  );
  const m = new Map();
  for (const row of r.rows) {
    if (!m.has(row.document_id)) m.set(row.document_id, { id: row.document_id, file: row.original_filename, type: row.document_type, f: {} });
    const o = m.get(row.document_id);
    if (o.f[row.field_key] === undefined) o.f[row.field_key] = row.value;
  }
  return m;
}

async function docsByType(db, type, extra = "", params = []) {
  const r = await db.raw(`SELECT d.id FROM documents d WHERE ${notPrivateSql("d")} AND d.document_type = $1 ${extra}`, [type, ...params]);
  return loadFields(db, r.rows.map((x) => x.id));
}

async function tenantNames(db) {
  const r = await db.raw(`SELECT DISTINCT x.value FROM extractions x WHERE x.field_key = 'tenant_name' AND x.value IS NOT NULL`);
  return r.rows.map((x) => String(x.value).trim()).filter(Boolean);
}

function findName(question, names) {
  const q = norm(question);
  let best = null;
  for (const n of names) {
    const k = norm(n);
    if (k.trim().split(" ").length < 2) continue;
    if (q.includes(k) && (!best || k.length > best.k.length)) best = { name: n, k };
  }
  return best?.name ?? null;
}

/** A person the question names that is NOT a tenant (null when the name is a near miss of a tenant, so typo handling stays with the normal path). */
function unknownPersonName(rawQuestion, names, intro) {
  const m = new RegExp(`${intro}\\s+([A-Z][a-z]+(?:\\s+[A-Z][a-z'-]+)+)`).exec(rawQuestion);
  if (!m) return null;
  const nm = m[1].replace(/['’]s?$/, "").trim().toLowerCase();
  const parts = nm.split(/\s+/);
  const last = parts[parts.length - 1];
  for (const n of names) {
    const p = n.toLowerCase().split(/\s+/);
    if (dl(nm, n.toLowerCase()) <= 2) return null;
    if (p[p.length - 1] === last && dl(parts[0], p[0]) <= 2) return null;
  }
  return m[1].replace(/['’]s?$/, "").trim();
}

const NOT_ON_FILE = [
  [/\b(?:parking|garage|carport)\b/i, "parking"], [/\bcredit\s+(?:score|check|rating)\b/i, "credit score"], [/\bsmok(?:er|e|es|ing)\b/i, "smoking status"],
  [/\b(?:pets?|dogs?|cats?)\b/i, "pet information"], [/\brenewal\s+option\b/i, "renewal option"],
  [/\b(?:late|behind)\s+on\s+(?:the\s+)?rent\b|\b(?:paid|pay)\s+(?:this month|yet|on time)|\blate\s+(?:fees?|rent|payments?)|\brent\s+(?:paid|payments?)\b|\bpayment\s+history\b|\boverdue\s+rent\b/i, "rent payment"],
];

/** A field the lease documents never carry (parking, credit score, pets, payments...) for a tenant who IS on file: say so, never guess. */
async function notOnFileLane(db, question) {
  const hit = NOT_ON_FILE.find(([re]) => re.test(question));
  if (!hit) return null;
  const names = await tenantNames(db);
  const name = findName(question, names);
  if (!name) return null;
  return noAnswer(`${name} is on file as a tenant, but there is no ${hit[1]} recorded for them. The lease documents carry only the unit, address, lease dates, rent and security deposit.`, `Read the documents that name ${name}; none records ${hit[1]}.`);
}

function ok(text, facts, records, basis, extra = {}) {
  return attachCitations(
    { kind: "answer", text, facts, sources: [], confidence: 1, verifiedCount: facts.length, unverifiedCount: 0, closest: [], propertyPack: true, ...extra },
    { records, total: records.length, basis }
  );
}
function noAnswer(text, basis) {
  return attachCitations(
    { kind: "no-answer", text, facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [], propertyPack: true },
    { records: [], total: 0, kind: "searched", basis }
  );
}
const recFor = (o, label) => documentRecord({ id: o.id, original_filename: o.file }, { label: `${label} · ${o.file ?? o.id}` });
const srcFor = (o) => [{ documentId: o.id, location: {} }];

/* ------------------------------------------------------------------ intent parsing */

const FILLER = /^(?:(?:hey|hi|ok|okay|so|um|uh|yo|alright|quick one|real quick|hang on|sorry|one more|please|just|and)\b[\s,.:;!-]*|\.\.\.\s*)+/i;
const TAIL = /(?:\s+(?:lol|please|pls|thanks|thank you|for me|real quick|quick|asap|today))+[\s?.!]*$/i;
function cleanQ(q) { return String(q ?? "").trim().replace(FILLER, "").replace(TAIL, "").replace(/[\s?.!]+$/, ""); }

function personIntent(q) {
  const l = q.toLowerCase();
  const hits = [];
  if (/\b(?:move|moved)[\s-]*in\b[^?]*\b(?:walk[\s-]?through|inspection|checklist|report)\b|\b(?:walk[\s-]?through|inspection)\b[^?]*\bmove[\s-]*in\b/.test(l)) hits.push("movein_doc");
  else if (/\b(?:move|moved)[\s-]*out\b[^?]*\b(?:walk[\s-]?through|inspection|checklist|report)\b|\b(?:walk[\s-]?through|inspection)\b[^?]*\bmove[\s-]*out\b/.test(l)) hits.push("moveout_doc");
  else if (/\b(?:move|moved)[\s-]*in\b|\blease\s+(?:start|begin|commenc)|\bstart(?:ed)?\s+date\b|\blease\s+from\b/.test(l)) hits.push("lease_start");
  if (/\blease\b[^?]*\b(?:end|ends|ending|expire|expires|expiration|expiry|over|up)\b|\b(?:expiration|expiry)\b[^?]*\blease\b|\blease\s+(?:end|expir)|\bup for renewal\b|\brenewal date\b/.test(l) && !/\brenewal option\b/.test(l)) hits.push("lease_end");
  if (/\bsecurity deposit\b|\bdeposit\b/.test(l)) hits.push("deposit");
  if (/\b(?:what|which)\s+(?:unit|apartment|apt)\b|\b(?:unit|apartment|apt)\s+(?:number|no|#)\b|\bunit\s+(?:does|is)\b|\bwhich\s+unit\b/.test(l)) hits.push("unit");
  if (/\baddress\b|\bwhere\b[^?]*\b(?:liv(?:e|es)|rents?|renting|stays?)\b|\bwhat\s+building\b|\bwhich\s+(?:building|property)\b/.test(l)) hits.push("address");
  if (/\b(?:owner|landlord)\b|\bwho\s+owns\b/.test(l) && !/\bhow many\b/.test(l)) hits.push("owner");
  if (/\brent\b(?!\s*roll)|\bpaying\b/.test(l) && !/\b(?:rented|renting)\b/.test(l) && !/\bwhere\b|\b(?:what|which)\s+(?:unit|apartment|apt|building|property)\b|\bwhich\s+unit\b/.test(l) && !hits.length) hits.push("rent");
  if (/\b(?:have|has|got)\s+a\s+lease\b|\blease\s+on\s+file\b|\bis\s+there\s+a\s+lease\b/.test(l)) hits.push("has_lease");
  return hits.length === 1 ? hits[0] : null;
}

/* ------------------------------------------------------------------ person lane */

async function personLane(db, question, rawQuestion, today) {
  const kind = personIntent(question);
  if (!kind) return null;
  const qAddr = ADDRESS_RE.exec(question)?.[0]?.replace(/\.$/, "").trim().toLowerCase() ?? null;
  const names = await tenantNames(db);
  const name = findName(question, names);
  if (!name) {
    let unk0 = null;
    if (!["has_lease", "movein_doc", "moveout_doc"].includes(kind)) {
      const cleaned = rawQuestion.replace(ADDRESS_RE, " ");
      const caps = [...cleaned.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z'-]+)+)/g)].map((x) => x[1].replace(/['’]s?$/, "").trim());
      if (caps.length === 1 && !/\b(?:rent|lease|unit|building)$/i.test(caps[0])) {
        const known = await db.raw(`SELECT 1 FROM entities WHERE entity_type IN ('customer','technician') AND (data->>'customer_name' ILIKE $1 OR data->>'technician_name' ILIKE $1 OR data->>'name' ILIKE $1) LIMIT 1`, [`%${esc(caps[0])}%`]);
        const vend = await db.raw(`SELECT 1 FROM extractions WHERE field_key = 'vendor' AND value ILIKE $1 LIMIT 1`, [`%${esc(caps[0])}%`]);
        if (!known.rows.length && !vend.rows.length) unk0 = unknownPersonName(`for ${caps[0]}`, names, "for");
      }
    }
    if (unk0) return noAnswer(`I don't have a tenant named ${unk0} on any lease, so there is nothing on file to answer that.`, `Searched the tenant names on every lease and inspection for ${unk0}; none matched.`);
    const unk = kind === "has_lease" ? unknownPersonName(rawQuestion, names, "(?:does|did|has|is there a lease (?:on file )?for|lease (?:on file )?for)")
      : kind === "movein_doc" || kind === "moveout_doc" ? unknownPersonName(rawQuestion, names, "(?:for|of)") : null;
    if (!unk) return null;
    const what = kind === "has_lease" ? "lease agreement" : kind === "movein_doc" ? "move-in inspection" : "move-out inspection";
    return noAnswer(`No. I don't have a ${what} on file for ${unk}: no tenant by that name appears on any lease or inspection.`, `Searched the tenant names on every lease and inspection for ${unk}; none matched.`);
  }
  const r = await db.raw(`SELECT DISTINCT d.id FROM extractions t JOIN documents d ON d.id = t.document_id AND ${notPrivateSql("d")} WHERE t.field_key = 'tenant_name' AND lower(t.value) = lower($1)`, [name]);
  const docs = [...(await loadFields(db, r.rows.map((x) => x.id))).values()];
  const leases = docs.filter((d) => d.type === "lease-agreement").sort((a, b) => String(a.f.lease_start_date ?? "").localeCompare(String(b.f.lease_start_date ?? "")));
  if (qAddr && docs.length && !docs.some((o) => String(o.f.service_address ?? "").toLowerCase().startsWith(qAddr))) return null; // the named address is not this tenant's: not answered here
  const label = (o) => `${o.type === "lease-agreement" ? "Lease agreement" : o.type === "move-in-inspection" ? "Move-in inspection" : "Move-out inspection"}`;

  if (kind === "movein_doc" || kind === "moveout_doc") {
    const t = kind === "movein_doc" ? "move-in-inspection" : "move-out-inspection";
    const nice = kind === "movein_doc" ? "move-in inspection" : "move-out inspection";
    const hit = docs.filter((d) => d.type === t);
    if (!hit.length) return noAnswer(`No. ${name} is on file as a tenant, but there is no ${nice} on file for them.`, `Looked for a ${nice} document naming ${name}; none exists.`);
    const f = hit.map((o) => ({ label: `${nice[0].toUpperCase()}${nice.slice(1)}`, value: `${o.file}${o.f.service_date ? ` (${prettyDate(o.f.service_date)})` : ""}`, sources: srcFor(o) }));
    return ok(`Yes. There is a ${nice} on file for ${name}: ${f.map((x) => x.value).join("; ")}.`, f, hit.map((o) => recFor(o, label(o))), `Read the ${nice} documents that name ${name}.`);
  }
  if (!leases.length) {
    if (kind === "has_lease") return noAnswer(`No. ${name} appears on inspections but there is no lease agreement on file for them.`, `Looked for a lease agreement naming ${name}; none exists.`);
    return null;
  }
  if (kind === "has_lease") {
    const f = leases.map((o) => ({ label: "Lease agreement", value: `${o.file}${o.f.lease_start_date ? ` (${prettyDate(o.f.lease_start_date)}${o.f.lease_end_date ? ` to ${prettyDate(o.f.lease_end_date)}` : ""})` : ""}`, sources: srcFor(o) }));
    return ok(`Yes. There is a lease agreement on file for ${name}: ${f.map((x) => x.value).join("; ")}.`, f, leases.map((o) => recFor(o, "Lease agreement")), `Read the lease agreements that name ${name}.`);
  }
  const FIELD = {
    unit: ["unit_number", "unit", (v) => v], address: ["service_address", "address", (v) => v], rent: ["rent_amount", "rent", money],
    deposit: ["security_deposit", "security deposit", money], lease_end: ["lease_end_date", "lease end date", prettyDate], lease_start: ["lease_start_date", "lease start date", prettyDate],
    owner: ["customer_name", "owner", (v) => v],
  }[kind];
  if (!FIELD) return null;
  const [key, noun, fmt] = FIELD;
  const have = leases.filter((o) => o.f[key] != null && String(o.f[key]).trim() !== "");
  if (!have.length) return noAnswer(`The lease on file for ${name} has no ${noun} recorded.`, `Read the lease agreement for ${name}; it carries no ${noun}.`);
  const vals = have.map((o) => ({ o, v: fmt(String(o.f[key])) }));
  const distinct = [...new Set(vals.map((x) => x.v))];
  let text;
  const unitOf = (o) => (o.f.unit_number ? ` in unit ${o.f.unit_number}` : "");
  if (distinct.length === 1) {
    const o = have[have.length - 1];
    const verb = { unit: `${name} rents unit ${distinct[0]}${o.f.service_address ? ` at ${o.f.service_address}` : ""}`, address: `${name} lives at ${distinct[0]}${o.f.unit_number ? ` (unit ${o.f.unit_number})` : ""}`,
      rent: `${name}'s monthly rent is ${distinct[0]}${unitOf(o)}`, deposit: `${name}'s security deposit is ${distinct[0]}`, lease_end: `${name}'s lease ends ${distinct[0]}`,
      lease_start: `${name}'s lease starts ${distinct[0]}`, owner: `${name}'s landlord (owner) is ${distinct[0]}` }[kind];
    text = `${verb}.`;
  } else {
    text = `${name} has ${have.length} leases on file with different values for the ${noun}: ${vals.map((x) => `${x.v}${x.o.f.lease_start_date ? ` (lease starting ${x.o.f.lease_start_date})` : ""}`).join("; ")}.`;
  }
  if (kind === "lease_end" && today && distinct.length === 1 && String(have[0].f[key]) < today) text += " That date has already passed.";
  const facts = vals.map((x) => ({ label: noun[0].toUpperCase() + noun.slice(1), value: x.v, sources: srcFor(x.o) }));
  return ok(text, facts, have.map((o) => recFor(o, "Lease agreement")), `Read the ${noun} from the lease agreement that names ${name}.`);
}

/* ------------------------------------------------------------------ unit / building lane */

async function addressRows(db, phrase) {
  const p = /,/.test(phrase) ? `${esc(phrase)}%` : `${esc(phrase)},%`;
  return p;
}

async function unitLane(db, question, rawQuestion, today) {
  const am = ADDRESS_RE.exec(question);
  if (!am) return null;
  const phrase = am[0].replace(/\.$/, "").trim();
  const rest = question.replace(am[0], " ");
  const um = UNIT_RE.exec(rest);
  const unit = um ? um[1].toUpperCase() : null;
  const l = question.toLowerCase();
  const pat = await addressRows(db, phrase);
  const buildingUnits = await db.raw(`SELECT DISTINCT data->>'unit_number' AS u FROM entities WHERE entity_type = 'property' AND merged_into IS NULL AND data->>'service_address' ILIKE $1`, [pat]);
  const units = buildingUnits.rows.map((x) => x.u).filter(Boolean).sort();
  if (!units.length) return null; // an address nobody manages is the address-miss lane's

  const tail = question.slice(am.index + am[0].length);
  const head = question.slice(0, am.index);
  if (/\b(?:19|20)\d{2}\b/.test(head + " " + tail)) return null; // a year filter is not applied here: decline rather than answer all-time
  const cityOf = (a) => String(a ?? "").split(",")[1]?.trim().toLowerCase();
  const bRows = await db.raw(`SELECT DISTINCT data->>'service_address' AS a FROM entities WHERE entity_type = 'property' AND merged_into IS NULL AND data->>'service_address' ILIKE $1`, [pat]);
  const bCity = cityOf(bRows.rows[0]?.a);
  const cm = /^\s*,?\s*(?:in\s+)?([A-Za-z][A-Za-z ]{2,24}?)\s*(?:,|$)/.exec(tail.replace(/\b(?:unit|apt|apartment|suite)\b.*$/i, "").replace(/#\s*\S+/, ""));
  if (cm && cm[1].trim()) {
    const cand = cm[1].trim().toLowerCase();
    const allCities = new Set((await db.raw(`SELECT DISTINCT lower(split_part(data->>'service_address', ',', 2)) AS c FROM entities WHERE entity_type = 'property'`)).rows.map((x) => x.c.trim()));
    if (allCities.has(cand) && cand !== bCity) return noAnswer(`${phrase} is in ${bCity ? bCity.replace(/\b\w/g, (c) => c.toUpperCase()) : "a different city"}, not ${cm[1].trim()}, so I have nothing on file for that combination.`, `Checked the city on the unit records at ${phrase}; it does not match.`);
    if (!allCities.has(cand) && !/^(?:unit|apt|apartment|suite)\b/.test(cand)) return null;
  }
  const wantWho = /\bwho\b[^?]*\b(?:lives?|living|rents?|renting|resides?)\b|\b(?:tenant|resident|renter|occupant)s?\s+(?:in|of|at|for)\b|\bwho(?:'s| is)\s+(?:the\s+)?(?:tenant|resident|renter)\b/.test(l);
  const wantWo = /\b(?:work orders?|repairs?|tickets?|maintenance requests?)\b/.test(l) && /\bhow many\b|\bnumber of\b|\bcount\b/.test(l);
  const wantVendor = /\b(?:last|latest|most recent|recent)\b[^?]*\b(?:vendor|contractor)\b|\b(?:vendor|contractor)\b[^?]*\b(?:last|latest|most recent)\b/.test(l);
  const wantRent = /\brent\b/.test(l) && !/\b(?:rented|renting|rents)\b/.test(l);
  const wantTenantCount = isStrictTenantsAtAddress(question);
  const appl = /\b(fridge|refrigerator|range|stove|oven|dishwasher|washer|dryer|microwave|water heater|freezer|disposal)\b/.exec(l);
  const wantEquip = !!appl && /\b(?:install|installed|year|age|old|when)\b/.test(l);
  const kinds = [wantWho, wantWo, wantVendor, wantRent, wantTenantCount, wantEquip].filter(Boolean).length;
  if (kinds !== 1) return null;

  if (wantTenantCount) {
    if (unit) return null;
    const leases = [...(await docsByType(db, "lease-agreement", `AND EXISTS (SELECT 1 FROM extractions a WHERE a.document_id = d.id AND a.field_key = 'service_address' AND a.value ILIKE $2)`, [pat])).values()];
    if (!leases.length) return noAnswer(`I have no lease on file at ${phrase}, so no tenants are recorded there.`, `Searched every lease agreement for ${phrase}; none matched.`);
    const names = [...new Set(leases.map((o) => String(o.f.tenant_name ?? "").trim()).filter(Boolean))];
    const f = [{ label: "Different tenants", value: String(names.length), sources: leases.slice(0, 20).map((o) => ({ documentId: o.id, location: {} })) }];
    return ok(`${names.length} different tenant${names.length === 1 ? "" : "s"} ${names.length === 1 ? "has" : "have"} a lease on file at ${phrase}, across ${leases.length} lease${leases.length === 1 ? "" : "s"}.`, f, leases.map((o) => recFor(o, "Lease agreement")), `Counted the distinct tenant names on the lease agreements at ${phrase}.`);
  }
  if (!unit && wantWho) return noAnswer(`${phrase} has ${units.length} unit${units.length === 1 ? "" : "s"} on file (${units.join(", ")}), so I can't say who lives "at" the building. Ask about a specific unit, for example unit ${units[0]}.`, `Checked the unit records at ${phrase}; the question names no unit.`);
  if (!unit) return null;
  if (!units.includes(unit)) {
    return noAnswer(`There is no unit ${unit} at ${phrase} on file. The units I have there are ${units.join(", ")}.`, `Checked every unit record at ${phrase}; none is numbered ${unit}.`);
  }
  const uPat = esc(unit);

  if (wantWho) {
    const leases = [...(await docsByType(db, "lease-agreement",
      `AND EXISTS (SELECT 1 FROM extractions a WHERE a.document_id = d.id AND a.field_key = 'service_address' AND a.value ILIKE $2)
       AND EXISTS (SELECT 1 FROM extractions u WHERE u.document_id = d.id AND u.field_key = 'unit_number' AND u.value ILIKE $3)`, [pat, uPat])).values()]
      .sort((a, b) => String(b.f.lease_start_date ?? "").localeCompare(String(a.f.lease_start_date ?? "")));
    if (!leases.length) return noAnswer(`I have no lease on file for unit ${unit} at ${phrase}, so I can't say who lives there.`, `Searched the lease agreements for unit ${unit} at ${phrase}; none matched.`);
    const cur = leases.filter((o) => o.f.lease_start_date <= today && (!o.f.lease_end_date || o.f.lease_end_date >= today));
    const desc = (o) => `${o.f.tenant_name} (lease ${o.f.lease_start_date ?? "?"} to ${o.f.lease_end_date ?? "no end date on file"})`;
    let text;
    if (cur.length === 1) text = `${cur[0].f.tenant_name} lives in unit ${unit} at ${phrase}: ${desc(cur[0])}.`;
    else if (cur.length > 1) text = `${cur.length} leases on file cover today for unit ${unit} at ${phrase}: ${cur.map(desc).join("; ")}.`;
    else text = `No lease on file for unit ${unit} at ${phrase} covers today. The most recent was ${desc(leases[0])}.`;
    const shown = cur.length ? cur : [leases[0]];
    const others = leases.filter((o) => !shown.includes(o));
    if (others.length) text += ` Earlier leases on file for this unit: ${others.map(desc).join("; ")}.`;
    const f = leases.map((o) => ({ label: "Tenant", value: String(o.f.tenant_name), sources: srcFor(o) }));
    return ok(text, f, leases.map((o) => recFor(o, "Lease agreement")), `Read the tenant names on the lease agreements for unit ${unit} at ${phrase}.`);
  }
  if (wantWo || wantVendor) {
    const wos = [...(await docsByType(db, "work-order",
      `AND EXISTS (SELECT 1 FROM extractions a WHERE a.document_id = d.id AND a.field_key = 'service_address' AND a.value ILIKE $2)
       AND EXISTS (SELECT 1 FROM extractions u WHERE u.document_id = d.id AND u.field_key = 'unit_number' AND u.value ILIKE $3)`, [pat, uPat])).values()]
      .sort((a, b) => String(b.f.service_date ?? "").localeCompare(String(a.f.service_date ?? "")));
    if (wantWo) {
      const f = [{ label: "Work orders", value: String(wos.length), sources: wos.slice(0, 20).map(srcFor).flat() }];
      return ok(`${wos.length} work order${wos.length === 1 ? "" : "s"} on file for unit ${unit} at ${phrase}.`, f, wos.map((o) => recFor(o, "Work order")), `Counted the work orders that name unit ${unit} at ${phrase}.`);
    }
    const done = wos.filter((o) => o.f.service_date && o.f.service_date <= today && o.f.vendor);
    if (!done.length) return noAnswer(`There is no work order with a vendor on file for unit ${unit} at ${phrase}, so I can't say who the last vendor was.`, `Searched the work orders for unit ${unit} at ${phrase}; none names a vendor.`);
    const top = done.filter((o) => o.f.service_date === done[0].f.service_date);
    const vend = [...new Set(top.map((o) => o.f.vendor))];
    const text = `The last vendor in unit ${unit} at ${phrase} was ${vend.join(" and ")} (${prettyDate(done[0].f.service_date)}${top[0].f.work_performed ? `: ${top[0].f.work_performed}` : ""}).`;
    return ok(text, top.map((o) => ({ label: "Last vendor", value: String(o.f.vendor), sources: srcFor(o) })), top.map((o) => recFor(o, "Work order")), `Took the newest dated work order for unit ${unit} at ${phrase} and read its vendor.`);
  }
  if (wantEquip) {
    const bm = /\b([A-Z][A-Za-z&.-]+)\s+(?:fridge|refrigerator|range|stove|oven|dishwasher|washer|dryer|microwave|water heater|freezer|disposal)\b/.exec(rawQuestion.replace(am[0], " "));
    if (!bm) return null;
    const brand = bm[1];
    if (/^(?:the|our|a|an|my|which|what|any|each)$/i.test(brand)) return null;
    const eq = await db.raw(`SELECT data->>'manufacturer' AS m, data->>'equipment_type' AS t FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL AND data->>'service_address' ILIKE $1 AND data->>'unit_number' ILIKE $2`, [pat, uPat]);
    if (eq.rows.some((x) => String(x.m ?? "").toLowerCase() === brand.toLowerCase())) return null; // a real match is the normal appliance lane's
    if (!eq.rows.length) return noAnswer(`I have no ${brand} ${appl[1]} on file for unit ${unit} at ${phrase}: no appliances are recorded for that unit.`, `Searched the equipment records for unit ${unit} at ${phrase}; none exist.`);
    return noAnswer(`I have no ${brand} ${appl[1]} on file for unit ${unit} at ${phrase}. The appliances recorded there are ${eq.rows.map((x) => `${x.m} ${x.t}`).join(", ")}.`, `Searched the equipment records for unit ${unit} at ${phrase} for a ${brand}; none matched.`);
  }
  if (wantRent) {
    // an existing unit's rent depends on which lease is meant; only the tenant-name form is answered
    return null;
  }
  return null;
}

/** "who lives in unit 1A?" with no building, when that label exists in several buildings: ask which one, never list everyone. */
async function noBuildingLane(db, question) {
  if (ADDRESS_RE.test(question) || /\b\d{1,6}\s+[A-Za-z][A-Za-z.' ]*\b(?:St|Street|Rd|Road|Ave|Avenue|Dr|Drive|Blvd|Way|Ln|Lane|Ct|Court|Pkwy|Parkway|Pl|Place|Cir|Trl|Hwy)\b/i.test(question)) return null;
  const l = question.toLowerCase();
  if (!/\bwho\b|\bwork orders?\b|\b(?:last|latest)\b[^?]*\b(?:vendor|contractor)\b|\btenants?\b/.test(l)) return null;
  const um = /\b(?:unit|apt|apartment|suite)\s*#?\s*(\d[A-Za-z]\d?)\b/i.exec(question);
  if (!um) return null;
  const unit = um[1].toUpperCase();
  const r = await db.raw(`SELECT DISTINCT data->>'service_address' AS a FROM entities WHERE entity_type = 'property' AND merged_into IS NULL AND data->>'unit_number' = $1`, [unit]);
  if (r.rows.length < 2) return null;
  return noAnswer(`Unit ${unit} exists in ${r.rows.length} buildings, so I can't tell which one you mean. Give me the building address and I'll look it up.`, `Checked the unit records for ${unit}; it is not unique to one building.`);
}

/* ------------------------------------------------------------------ unit counts */

async function countLane(db, question) {
  const q = cleanQ(question);
  const total = /^how many (?:rental )?units (?:do )?(?:we|you)(?: currently)? (?:manage|have|own|got|handle)$/i.test(q);
  const m = /^how many (?:rental )?units (?:do )?(?:we|you)(?: currently)?(?: (?:manage|have|own|got|handle))? (?:in|at) ([A-Za-z][A-Za-z .'-]{1,30})$/i.exec(q);
  if (!total && !m) return null;
  let city = null, pat = "%";
  if (m) {
    city = m[1].trim();
    pat = `%, ${esc(city)}, %`;
    const known = await db.raw(`SELECT 1 FROM entities WHERE entity_type = 'property' AND merged_into IS NULL AND data->>'service_address' ILIKE $1 LIMIT 1`, [pat]);
    if (!known.rows.length) return null;
  }
  const r = await db.raw(`SELECT id, data->>'unit_number' AS u, data->>'service_address' AS a FROM entities WHERE entity_type = 'property' AND merged_into IS NULL AND data->>'service_address' ILIKE $1 ORDER BY 3, 2`, [pat]);
  const n = r.rows.length;
  const recs = r.rows.map((x) => makeRecord({ type: "unit", id: x.id, label: `Rental unit ${x.u ?? "?"}`, sublabel: x.a }));
  const where = city ? ` in ${city}` : "";
  return ok(`You have ${n} rental unit${n === 1 ? "" : "s"}${where} (rental units on file, not appliances).`, [{ label: "Rental units", value: String(n), sources: [] }], recs, `Counted the unit records${where ? ` whose address is in ${city}` : ""}.`);
}


/* ------------------------------------------------------------------ vendor / rent-roll lane (R43) */

async function vendorNames(db) {
  const r = await db.raw(`SELECT DISTINCT x.value FROM extractions x WHERE x.field_key = 'vendor' AND x.value IS NOT NULL`);
  return r.rows.map((x) => String(x.value).trim()).filter(Boolean);
}
const YEAR_OR_PERIOD = /\b(?:19|20)\d{2}\b|\b(?:this|last|past|next)\s+(?:week|month|quarter|year)\b|\bsince\b|\bbetween\b|\byear to date\b|\bytd\b/i;

/** Vendor work-order counts and "which vendors carry insurance": the vendor name is read from the tenant's own work-order / COI extractions. */
async function vendorLane(db, raw, q) {
  const l = q.toLowerCase();
  if (YEAR_OR_PERIOD.test(l)) return null;
  const coiList = /^(?:which|what|list|who|show(?: me)?)\s+(?:all\s+|of\s+)?(?:our\s+|the\s+)?(?:vendors?|contractors?)\s+(?:do we have\s+|that\s+|who\s+|with\s+)?(?:have|has|having)?\s*(?:an?\s+)?(?:insurance|coi|certificates? of insurance)(?:\s+on file)?$/i.test(q.trim());
  if (coiList) {
    const cois = [...(await docsByType(db, "certificate-of-insurance")).values()].filter((o) => o.f.vendor);
    if (!cois.length) return noAnswer("No certificates of insurance are on file for any vendor.", "Looked for certificate-of-insurance documents; none exist.");
    const byV = new Map(); for (const o of cois) if (!byV.has(o.f.vendor) || String(o.f.coi_expires ?? "") > String(byV.get(o.f.vendor).f.coi_expires ?? "")) byV.set(o.f.vendor, o);
    const rows = [...byV.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const f = rows.map(([v, o]) => ({ label: "Vendor with insurance on file", value: `${v}${o.f.coi_expires ? ` (expires ${prettyDate(o.f.coi_expires)})` : ""}`, sources: srcFor(o) }));
    return ok(`${rows.length} vendor${rows.length === 1 ? " has" : "s have"} a certificate of insurance on file: ${f.map((x) => x.value).join("; ")}.`, f, rows.map(([, o]) => recFor(o, "Certificate of insurance")), "Read the vendor on every certificate-of-insurance document.");
  }
  if (!(/\b(?:work\s*orders?|jobs?)\b/.test(l) && /\bhow many\b|\bnumber of\b|\bcount\b|\btotal\b/.test(l))) return null;
  const vendors = await vendorNames(db);
  const WO_OK = new Set("how many work order orders jobs job done us completed did does do has have had handle handled handling done we they the number of count total on file for".split(" "));
  const restWords = (txt) => norm(txt).trim().split(" ").filter((w) => w && !WO_OK.has(w));
  let hit = null; const qn = norm(raw);
  for (const v of vendors) { const k = norm(v); if (qn.includes(k) && (!hit || k.length > hit.k.length)) hit = { v, k }; }
  if (hit) {
    if (restWords(qn.replace(hit.k, " ")).length) return null; // any other condition (month, address, customer, status, second vendor...): not answered here
    const r = await db.raw(`SELECT DISTINCT d.id FROM extractions x JOIN documents d ON d.id = x.document_id AND ${notPrivateSql("d")} WHERE x.field_key = 'vendor' AND d.document_type = 'work-order' AND lower(x.value) = lower($1)`, [hit.v]);
    const wos = [...(await loadFields(db, r.rows.map((x) => x.id))).values()];
    const f = [{ label: `Work orders for ${hit.v}`, value: String(wos.length), sources: wos.slice(0, 20).map(srcFor).flat() }];
    return ok(`${wos.length} work order${wos.length === 1 ? "" : "s"} on file for ${hit.v}.`, f, wos.slice(0, 20).map((o) => recFor(o, "Work order")), `Counted the work-order documents whose vendor is ${hit.v}.`);
  }
  const cand = (/\b(?:did|has|have|does|for|from|by|handled by)\s+((?:[A-Z][A-Za-z&'.-]+\s+){1,3}[A-Z][A-Za-z&'.-]+)/.exec(raw) ?? /^((?:[A-Z][A-Za-z&'.-]+\s+){1,3}[A-Z][A-Za-z&'.-]+)\s+[Ww]ork\s*[Oo]rders?/.exec(raw))?.[1]?.trim();
  if (!cand || /^(?:How|Many|Work|Unit|Apt|Suite|The|Our)\b/.test(cand)) return null;
  const cl = cand.toLowerCase();
  if (/\b(?:street|st|road|rd|avenue|ave|drive|dr|lane|ln|blvd|way|court|ct|county|city|heights|valley|properties|apartments|unit)\b/i.test(cand) || restWords(qn.replace(norm(cand), " ")).length) return null;
  { const anywhere = await db.raw(`SELECT 1 FROM entities WHERE data::text ILIKE $1 UNION ALL SELECT 1 FROM extractions WHERE value ILIKE $1 LIMIT 1`, [`%${esc(cand)}%`]); if (anywhere.rows.length) return null; }
  if (vendors.some((v) => dl(cl, v.toLowerCase()) <= 2)) return null; // near miss of a real vendor: typo handling stays elsewhere
  const names = await tenantNames(db);
  if (names.some((n) => n.toLowerCase() === cl)) return null;
  const known = await db.raw(`SELECT 1 FROM entities WHERE entity_type IN ('customer','technician') AND (data->>'customer_name' ILIKE $1 OR data->>'technician_name' ILIKE $1 OR data->>'name' ILIKE $1) LIMIT 1`, [`%${esc(cand)}%`]);
  if (known.rows.length) return null;
  return ok(`0 work orders on file for ${cand}: I don't have a vendor by that name. The vendors I do have work orders from are ${vendors.sort().join(", ")}.`, [{ label: `Work orders for ${cand}`, value: "0", sources: [] }], [], `Searched the vendor on every work order for ${cand}; none matched.`);
}

/* ------------------------------------------------------------------ R40: vendor trade / unpaid bills, tenant count, vacancy, rent-payment honesty */

const dlv = (a, b) => dl(norm(a).trim(), norm(b).trim());
async function vendorMatch(db, phrase) {
  const r = await db.raw(`SELECT id, data->>'name' AS name, data->>'trade' AS trade FROM entities WHERE entity_type = 'technician' AND merged_into IS NULL AND data->>'name' IS NOT NULL`);
  const k = norm(phrase).trim();
  if (!k) return null;
  let best = null;
  for (const v of r.rows) { const d = dlv(v.name, phrase); if (d <= 2 && (!best || d < best.d)) best = { ...v, d }; }
  return best;
}
const VENDOR_PHRASE = "((?:[A-Z][A-Za-z&'.-]+)(?:\\s+[A-Z][A-Za-z&'.-]+){0,3})";
async function vendorTradeLane(db, raw, q) {
  const m = new RegExp(`^(?:what does|what do|what kind of work does|what trade is|what type of vendor is|whats|what's) ${VENDOR_PHRASE}(?: do| do for us)?$`).exec(raw.trim().replace(/[\s?.!]+$/, "").replace(/^(?:hey|ok|so)[ ,]+/i, ""));
  if (!m) return null;
  const v = await vendorMatch(db, m[1]);
  if (!v) return null;
  if (!v.trade) return noAnswer(`${v.name} is on file as a vendor, but no trade is recorded for them.`, `Read the vendor record for ${v.name}.`);
  return ok(`${v.name} is a ${v.trade} vendor.`, [{ label: "Vendor trade", value: v.trade, sources: [] }], [makeRecord({ type: "customer", id: v.id, label: v.name })].filter(Boolean), `Read the trade on the vendor record for ${v.name}.`);
}
async function vendorUnpaidLane(db, raw, q) {
  const l = q.toLowerCase();
  if (!/\b(?:unpaid|open|outstanding)\b/.test(l) || !/\b(?:bills?|invoices?)\b/.test(l) || YEAR_OR_PERIOD.test(l)) return null;
  const m = new RegExp(`(?:\\bfrom|\\bby|\\bfor|\\bunpaid bills|\\bunpaid invoices|\\bopen bills|\\bopen invoices|\\boutstanding bills|\\boutstanding invoices)\\s+${VENDOR_PHRASE}`).exec(raw);
  if (!m) return null;
  const v = await vendorMatch(db, m[1]);
  if (!v) return null;
  const r = await db.raw(`SELECT DISTINCT d.id FROM documents d JOIN extractions a ON a.document_id = d.id AND a.field_key = 'vendor' AND lower(a.value) = lower($1) JOIN extractions s ON s.document_id = d.id AND s.field_key = 'status' AND lower(s.value) = 'unpaid' WHERE d.document_type = 'invoice' AND ${notPrivateSql("d")}`, [v.name]);
  const inv = [...(await loadFields(db, r.rows.map((x) => x.id))).values()];
  const total = inv.reduce((a, o) => a + (Number(String(o.f.cost ?? "").replace(/[$,]/g, "")) || 0), 0);
  const f = [{ label: `Unpaid invoices from ${v.name}`, value: String(inv.length), sources: inv.slice(0, 20).map(srcFor).flat() }];
  return ok(`${inv.length} unpaid invoice${inv.length === 1 ? "" : "s"} from ${v.name}${inv.length && total ? `, totaling ${money(total)}` : ""}.`, f, inv.slice(0, 20).map((o) => recFor(o, "Vendor invoice")), `Counted the invoice documents whose vendor is ${v.name} and whose status is unpaid.`);
}
async function tenantCountLane(db, q) {
  if (!/^how many (?:(?:different|distinct|unique|total) )?(?:tenants|residents|renters)(?: (?:do we have|have we had|are there|have we had in total|on file|we have|in total|total|ever))?$/i.test(q.trim())) return null;
  const names = await tenantNames(db);
  if (!names.length) return null;
  const distinct = [...new Set(names.map((n) => n.toLowerCase()))].length;
  const leases = [...(await docsByType(db, "lease-agreement")).values()];
  return ok(`${distinct} different tenant${distinct === 1 ? " has" : "s have"} a name recorded on the lease and inspection documents on file (${leases.length} lease agreement${leases.length === 1 ? "" : "s"}). The building owners are separate and are not counted here.`, [{ label: "Different tenants", value: String(distinct), sources: leases.slice(0, 20).map(srcFor).flat() }], leases.slice(0, 20).map((o) => recFor(o, "Lease agreement")), "Counted the distinct tenant names on the tenant's own lease, move-in and move-out documents.");
}
async function vacancyLane(q) {
  if (!/^(?:which|what|how many|list|show)\b[^?]*\b(?:vacan(?:t|cy|cies)|empty units?|unoccupied)\b/i.test(q) || /\b(?:lease|certificate|limit)\b/i.test(q)) return null;
  return noAnswer("Whether a unit is occupied or vacant isn't recorded in the documents on file. I can show lease start and end dates for a unit or a tenant if you give me the name or address.", "Looked for an occupancy/vacancy field; none exists on the unit or lease records.");
}
async function payStatusLane(db, raw, q) {
  if (!/\b(?:late|behind)\s+on\s+(?:the\s+)?rent\b|\b(?:did|has|have)\b[^?]*\bpaid\b[^?]*\b(?:rent|this month)\b|\bpaid\s+(?:this month|yet|on time)\b/i.test(q)) return null;
  return noAnswer("Rent payment status isn't recorded in the documents on file. The lease documents carry only the unit, address, lease dates, rent amount and security deposit.", "Looked for rent-payment or ledger fields; none exist on the lease documents.");
}

/** "how many leases are month to month": leases with no end date recorded (read from the tenant's own lease extractions). */
async function monthToMonthLane(db, q) {
  if (!/^how many (?:of (?:our|the) )?(?:leases|tenants|units) (?:are|is) (?:on (?:a )?)?(?:month[\s-]*to[\s-]*month|mtm)$/i.test(q.trim())) return null;
  const all = [...(await docsByType(db, "lease-agreement")).values()];
  if (!all.length) return null;
  const mtm = all.filter((o) => !String(o.f.lease_end_date ?? "").trim());
  const f = [{ label: "Leases with no end date (month to month)", value: String(mtm.length), sources: mtm.slice(0, 20).map(srcFor).flat() }];
  return ok(`${mtm.length} of the ${all.length} lease agreement${all.length === 1 ? "" : "s"} on file ${mtm.length === 1 ? "has" : "have"} no lease end date recorded, which is how a month-to-month lease appears here.`, f, mtm.slice(0, 20).map((o) => recFor(o, "Lease agreement")), "Counted the lease agreements with no lease end date extracted.");
}

/** "how many units does <owner> own": property entities whose owner (customer_name) is that exact owner. Unknown owner -> not on file. */
async function ownerUnitsLane(db, raw, q) {
  const m = /^how many (?:rental )?(?:units|properties|doors) (?:does|do|did) ([A-Za-z][A-Za-z .'&-]{2,50}?) (?:own|have|hold|manage)(?: (?:with us|under management|in (?:our|the) portfolio|from us))?$/i.exec(q.trim());
  if (!m || YEAR_OR_PERIOD.test(q)) return null;
  const name = m[1].trim();
  if (/^(?:we|you|they|the|our)$/i.test(name) || name.split(/\s+/).length < 2) return null;
  const r = await db.raw(`SELECT id, data->>'unit_number' AS u, data->>'service_address' AS a FROM entities WHERE entity_type = 'property' AND merged_into IS NULL AND lower(data->>'customer_name') = lower($1) ORDER BY 3, 2`, [name]);
  if (!r.rows.length) {
    const known = await db.raw(`SELECT 1 FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $1 LIMIT 1`, [`%${esc(name)}%`]);
    if (known.rows.length) return null;
    return noAnswer(`I don't have an owner named ${name} on file, so there are no units to count for them.`, `Searched the owner on every unit record for ${name}; none matched.`);
  }
  const n = r.rows.length;
  const recs = r.rows.map((x) => makeRecord({ type: "unit", id: x.id, label: `Rental unit ${x.u ?? "?"}`, sublabel: x.a }));
  return ok(`${n} unit${n === 1 ? "" : "s"} for ${name}.`, [{ label: "Units", value: String(n), sources: [] }], recs, `Counted the unit records whose owner is ${name}.`);
}

/** Rent-roll statistics over the lease agreements on file (count above/below a rent, highest / lowest / average rent). */
async function rentStatsLane(db, raw, q) {
  const l = q.toLowerCase();
  if (YEAR_OR_PERIOD.test(l) || !/\brent\b|\bpay(?:s|ing)?\b/.test(l) || /\b(?:paid|late|behind|overdue|owe\w*)\b/.test(l)) return null;
  const cmpM = /\bhow many\b[^?]*\b(?:tenants?|leases?|units?|renters?|residents?)\b[^?]*\b(?:pay|pays|paying|rent|rents|have)\b[^?]*?\b(more than|over|above|greater than|under|less than|below|fewer than|at least|at most|exactly)\s*\$?\s*(\d[\d,]*(?:\.\d+)?)\b(?!\s*(?:to|-|and|or)\b)/.exec(l);
  const stat = /\b(highest|biggest|largest|top|most expensive|maximum|max)\b[^?]*\brent\b|\brent\b[^?]*\b(?:highest|biggest|largest|maximum)\b/.test(l) ? "max"
    : /\b(lowest|cheapest|smallest|minimum|min)\b[^?]*\brent\b|\brent\b[^?]*\b(?:lowest|smallest|minimum)\b/.test(l) ? "min"
    : /\baverage\b[^?]*\brent\b|\bavg\b[^?]*\brent\b|\bmean\b[^?]*\brent\b/.test(l) ? "avg" : null;
  if (!cmpM && !stat) return null;
  { const RENT_OK = new Set("how many what whats is the our a an tenants tenant leases lease units unit renters residents pay pays paying rent rents rented month monthly per mo do we have highest lowest average avg mean biggest largest smallest cheapest max min maximum minimum collect charge of across all on file more than over above greater under less below fewer at least most exactly".split(" ")); const rest = norm(l.replace(/\$?\s*\d[\d,]*(?:\.\d+)?/g, " ")).trim().split(" ").filter((w) => w && !RENT_OK.has(w)); if (rest.length) return null; if ((l.match(/\d[\d,]*(?:\.\d+)?/g) || []).length > 1) return null; }
  if (/\b(?:and|or)\b[^?]*\$?\d/.test(l.replace(cmpM?.[0] ?? "", "")) && cmpM) return null; // a second bound: not handled here
  const leases = [...(await docsByType(db, "lease-agreement")).values()].filter((o) => Number.isFinite(Number(o.f.rent_amount)));
  if (!leases.length) return null;
  if (cmpM) {
    const n = Number(cmpM[2].replace(/,/g, ""));
    const op = { "more than": (x) => x > n, over: (x) => x > n, above: (x) => x > n, "greater than": (x) => x > n, under: (x) => x < n, "less than": (x) => x < n, below: (x) => x < n, "fewer than": (x) => x < n, "at least": (x) => x >= n, "at most": (x) => x <= n, exactly: (x) => x === n }[cmpM[1]];
    const hits = leases.filter((o) => op(Number(o.f.rent_amount)));
    const f = [{ label: `Leases with rent ${cmpM[1]} ${money(n)}`, value: String(hits.length), sources: hits.slice(0, 20).map(srcFor).flat() }];
    return ok(`${hits.length} of the ${leases.length} lease${leases.length === 1 ? "" : "s"} on file ${hits.length === 1 ? "has" : "have"} monthly rent ${cmpM[1]} ${money(n)} (all leases on file, including past ones).`, f, hits.slice(0, 20).map((o) => recFor(o, "Lease agreement")), `Compared the rent amount on every lease agreement with ${money(n)}.`);
  }
  const nums = leases.map((o) => Number(o.f.rent_amount));
  if (stat === "avg") {
    const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
    return ok(`The average monthly rent across the ${leases.length} lease${leases.length === 1 ? "" : "s"} on file is ${money(avg)}.`, [{ label: "Average rent", value: money(avg), sources: [] }], leases.slice(0, 20).map((o) => recFor(o, "Lease agreement")), "Averaged the rent amount on every lease agreement.");
  }
  const best = stat === "max" ? Math.max(...nums) : Math.min(...nums);
  const top = leases.filter((o) => Number(o.f.rent_amount) === best);
  const who = top.length <= 3 ? top.map((o) => `${o.f.tenant_name ?? "a tenant"}${o.f.unit_number ? `, unit ${o.f.unit_number}` : ""}${o.f.service_address ? ` at ${o.f.service_address}` : ""}`).join("; ") : `${top.length} leases`;
  return ok(`The ${stat === "max" ? "highest" : "lowest"} monthly rent on file is ${money(best)} (${who}).`, [{ label: stat === "max" ? "Highest rent" : "Lowest rent", value: money(best), sources: top.slice(0, 20).map(srcFor).flat() }], top.slice(0, 20).map((o) => recFor(o, "Lease agreement")), `Compared the rent amount on every lease agreement and took the ${stat === "max" ? "largest" : "smallest"}.`);
}

/* ------------------------------------------------------------------ entry */

/** ONLY the pure shape "how many (different) tenants have rented at <address>" and nothing else (no extra clause, year, city, punctuation, instruction). */
export function isStrictTenantsAtAddress(question) {
  const q = cleanQ(question);
  if (/[;:<>{}()"`\\]/.test(q)) return false;
  const m = /^how many (?:(?:different|distinct|unique) )?(?:tenants|residents|renters) (?:(?:have|has|had|ever) )*(?:rented|leased|lived|rent|live) (?:at|in) (.+)$/i.exec(q);
  if (!m) return false;
  const am = ADDRESS_RE.exec(m[1]);
  return !!am && am.index === 0 && am[0].replace(/\.$/, "").trim().length === m[1].trim().length;
}
export const isResidentTenantsQuestion = isStrictTenantsAtAddress; // safety-gate carve-out: a resident question, not a probe of other DeepWell tenants

/* ------------------------------------------------------------------ R42: tenant rent / move-out phrasing, vendor COI, jobs-by, vendors by trade, COI year counts, owners by city
 * Every vocabulary (tenant names, vendor names, trades, cities) is read from this organization's own rows. Unknown name/trade/city -> honest 0 / not on file, never a total. */
const osa = (a, b) => { const m = a.length, n = b.length; const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]); for (let j = 1; j <= n; j++) d[0][j] = j; for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) { d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); } return d[m][n]; };
const tol = (s) => (s.length >= 9 ? 2 : s.length >= 5 ? 1 : 0);
const INS_RE = /\b(?:ins\w{3,8}|coi|certificates? of insurance|cert)\b/i;
const EXP_RE = /\b(?:expire|expires|expired|expiring|expiration|expiry|exprie|run out|runs out|lapse|lapsed|current|valid|good|up to date|active|covered)\b/i;

/** Longest vendor name (tenant's own technician + work-order vendor values) the question names, typo-tolerant on the whole name. */
async function vendorsAll(db) {
  const r = await db.raw(`SELECT id, data->>'name' AS name, data->>'trade' AS trade FROM entities WHERE entity_type = 'technician' AND merged_into IS NULL AND data->>'name' IS NOT NULL`);
  const have = new Map(r.rows.map((x) => [x.name.toLowerCase(), { id: x.id, name: x.name, trade: x.trade }]));
  for (const v of await vendorNames(db)) if (!have.has(v.toLowerCase())) have.set(v.toLowerCase(), { name: v, trade: null });
  return [...have.values()];
}
function vendorInQuestion(raw, vendors) {
  const words = norm(raw).trim().split(" ").filter(Boolean);
  let best = null;
  for (const v of vendors) {
    const k = norm(v.name).trim(); const kw = k.split(" ").length;
    for (let w = Math.max(1, kw - 1); w <= kw + 1; w++) for (let i = 0; i + w <= words.length; i++) {
      const seg = words.slice(i, i + w).join(" "); const d = osa(seg, k);
      if (d <= Math.min(2, tol(k)) && (!best || d < best.d || (d === best.d && k.length > best.k.length))) best = { v, d, k };
    }
  }
  return best?.v ?? null;
}
const CAND_RE = /([A-Z][A-Za-z&'.-]+(?:\s+[A-Z][A-Za-z&'.-]+){1,3})/g;
async function unknownCandidate(db, raw, vendors) {
  const caps = [...raw.replace(ADDRESS_RE, " ").matchAll(CAND_RE)].map((x) => x[1].replace(/['’]s?$/, "").trim()).filter((c) => !/^(?:How|Many|Work|Unit|Apt|Suite|The|Our|When|What|Which|Does|Is|Are|Do|Has|Have|Any|List)\b/.test(c));
  if (caps.length !== 1) return null;
  const c = caps[0]; const cl = c.toLowerCase();
  if (vendors.some((v) => osa(v.name.toLowerCase(), cl) <= 2)) return null;
  const anywhere = await db.raw(`SELECT 1 FROM entities WHERE data::text ILIKE $1 UNION ALL SELECT 1 FROM extractions WHERE value ILIKE $1 LIMIT 1`, [`%${esc(c)}%`]);
  return anywhere.rows.length ? null : c;
}

async function extrasLane(db, raw, q, today) {
  const l = q.toLowerCase();
  /* tenant rent / move-out phrasing -> the existing person lane */
  let m = /^(?:what|how much)\s+(?:does|is|do)\s+(.+?)\s+(?:pay|paying|owe)(?:\s+(?:in rent|a month|monthly|per month|each month))?$/i.exec(q);
  if (m && !/\b(?:late|behind|owe)\b/i.test(q)) { const r = await personLane(db, `what is ${m[1]}'s rent`, `what is ${m[1]}'s rent`, today); if (r) return r; }
  m = /^(?:has|have|did|is)\s+(.+?)\s+(?:moved|move|moving|left|vacated|gone)\s*(?:out|yet)?(?:\s+yet)?$/i.exec(q);
  if (m) { const r = await personLane(db, `did ${m[1]} have a move out inspection`, `did ${m[1]} have a move out inspection`, today); if (r) return r; }

  const vendors = await vendorsAll(db);
  /* jobs done by V */
  m = /^(?:jobs|work\s*orders?)\s+(?:done|handled|completed|performed)\s+by\s+(.+)$/i.exec(q) ?? /^(.+?)\s+(?:jobs|work\s*orders?)(?:\s+count)?$/i.exec(q);
  if (m && (vendorInQuestion(m[1], vendors) || /^[A-Z]/.test(m[1]))) { const r = await vendorLane(db, `how many work orders did ${m[1]} do`, `how many work orders did ${m[1]} do`); if (r) return r; }

  /* vendor insurance: when does V's insurance expire / is it current */
  if (INS_RE.test(l) && EXP_RE.test(l) && !/\b(?:how many|which|list|who)\b/.test(l) && !YEAR_OR_PERIOD.test(l)) {
    const v = vendorInQuestion(raw, vendors);
    if (v) {
      const cois = [...(await docsByType(db, "certificate-of-insurance")).values()].filter((o) => o.f.vendor && osa(o.f.vendor.toLowerCase(), v.name.toLowerCase()) <= 1);
      if (!cois.length) return noAnswer(`${v.name} is on file as a vendor, but there is no certificate of insurance on file for them.`, `Looked for a certificate-of-insurance document naming ${v.name}; none exists.`);
      const o = cois.sort((a, b) => String(b.f.coi_expires ?? "").localeCompare(String(a.f.coi_expires ?? "")))[0];
      if (!o.f.coi_expires) return noAnswer(`The certificate of insurance on file for ${v.name} has no expiration date recorded.`, `Read the certificate of insurance for ${v.name}.`);
      const exp = String(o.f.coi_expires); const cur = exp >= today;
      return ok(`${v.name}'s insurance ${cur ? "runs until" : "expired on"} ${prettyDate(exp)}${/\b(?:current|valid|good|up to date|active|covered)\b/i.test(l) ? ` - ${cur ? "yes, it is current" : "no, it is not current"} as of today` : ""}.`, [{ label: `${v.name} insurance expires`, value: prettyDate(exp), sources: srcFor(o) }], [recFor(o, "Certificate of insurance")], `Read the expiration date on the certificate of insurance for ${v.name}.`);
    }
    const c = await unknownCandidate(db, raw, vendors);
    if (c) return ok(`0 insurance certificates on file for ${c}: I don't have a vendor by that name. Vendors with certificates on file: ${[...new Set([...(await docsByType(db, "certificate-of-insurance")).values()].map((o) => o.f.vendor).filter(Boolean))].sort().join(", ") || "none"}.`, [{ label: `Insurance certificates for ${c}`, value: "0", sources: [] }], [], `Searched every vendor name and certificate for ${c}; none matched.`);
  }

  /* COI expiry counts by year */
  m = /\b(20\d{2})\b/.exec(l);
  if (m && INS_RE.test(l) && /\b(?:how many|number of|count)\b/.test(l) && /\bexp\w+|\brun out\b|\bend\b/.test(l)) {
    const cois = [...(await docsByType(db, "certificate-of-insurance")).values()].filter((o) => o.f.coi_expires);
    const hit = cois.filter((o) => String(o.f.coi_expires).startsWith(`${m[1]}-`));
    const yrs = [...new Set(cois.map((o) => String(o.f.coi_expires).slice(0, 4)))].sort();
    return ok(hit.length ? `${hit.length} vendor insurance certificate${hit.length === 1 ? "" : "s"} expire${hit.length === 1 ? "s" : ""} in ${m[1]}: ${hit.map((o) => `${o.f.vendor} (${prettyDate(o.f.coi_expires)})`).join("; ")}.` : `0 vendor insurance certificates expire in ${m[1]}. Expiration years on file: ${yrs.join(", ") || "none"}.`,
      [{ label: `COIs expiring ${m[1]}`, value: String(hit.length), sources: hit.slice(0, 20).map(srcFor).flat() }], hit.slice(0, 20).map((o) => recFor(o, "Certificate of insurance")), `Counted certificate-of-insurance documents whose expiration date is in ${m[1]}.`);
  }

  /* vendors by trade: "how many hvac vendors", "list our pest vendors", "which plumbing vnedors do we use" */
  m = /^(?:(how many|number of|count of)|which|list|what|who|show(?: me)?|name)\s+(?:of\s+)?(?:all\s+)?(?:our\s+|the\s+|my\s+)?([A-Za-z][A-Za-z -]{2,24}?)\s+(?:v\w{3,8}s|contractors|companies|subs)(?:\s+(?:do we (?:have|use|work with|got)|we (?:use|have)|are there|on file|do we got))?$/i.exec(q);
  if (m) {
    const word = m[2].toLowerCase().trim();
    if (!/^(?:unpaid|paid|total|active|different|all|many|insured|uninsured|expired|current|new|old)$/.test(word) && vendors.some((v) => v.trade)) {
      const trades = [...new Set(vendors.map((v) => v.trade).filter(Boolean).map((t) => t.toLowerCase()))].sort();
      const hit = trades.find((t) => t === word || osa(t, word) <= tol(t) || word.startsWith(t));
      const tv = hit ? vendors.filter((v) => (v.trade ?? "").toLowerCase() === hit).sort((a, b) => a.name.localeCompare(b.name)) : [];
      if (hit) return ok(m[1] ? `${tv.length} ${hit} vendor${tv.length === 1 ? "" : "s"}: ${tv.map((v) => v.name).join(", ")}.` : `${tv.length} ${hit} vendor${tv.length === 1 ? "" : "s"} on file: ${tv.map((v) => v.name).join(", ")}.`, (m[1] ? [{ label: `${hit} vendors`, value: String(tv.length), sources: [] }] : tv.map((v) => ({ label: `${hit} vendor`, value: v.name, sources: [] }))), tv.map((v) => v.id && makeRecord({ type: "customer", id: v.id, label: v.name })).filter(Boolean), `Counted the vendor records whose trade is ${hit}.`);
      if (word.split(" ").length === 1) return ok(`0 ${word} vendors on file. The trades I do have vendors for are ${trades.join(", ")}.`, [{ label: `${word} vendors`, value: "0", sources: [] }], [], `Checked the trade on every vendor record for ${word}; none matched.`);
    }
  }

  /* vendor invoice counts (any status) and unknown vendor on unpaid/invoice counts */
  m = /^how many\s+(paid\s+|unpaid\s+|open\s+)?(?:invoices|bills)\s+(?:from|by|for)\s+(.+)$/i.exec(q);
  if (m && !YEAR_OR_PERIOD.test(l)) {
    const v = vendorInQuestion(m[2], vendors);
    if (v && !m[1]) {
      const r = await db.raw(`SELECT DISTINCT d.id FROM documents d JOIN extractions a ON a.document_id = d.id AND a.field_key = 'vendor' AND lower(a.value) = lower($1) WHERE d.document_type = 'invoice' AND ${notPrivateSql("d")}`, [v.name]);
      const inv = [...(await loadFields(db, r.rows.map((x) => x.id))).values()];
      return ok(`${inv.length} invoice${inv.length === 1 ? "" : "s"} from ${v.name} on file.`, [{ label: `Invoices from ${v.name}`, value: String(inv.length), sources: inv.slice(0, 20).map(srcFor).flat() }], inv.slice(0, 20).map((o) => recFor(o, "Vendor invoice")), `Counted the invoice documents whose vendor is ${v.name}.`);
    }
    if (!v && /^[A-Z]/.test(m[2])) {
      const c = await unknownCandidate(db, m[2], vendors);
      if (c) return ok(`0 invoices from ${c}: I don't have a vendor by that name. The vendors I do have are ${vendors.map((x) => x.name).sort().join(", ")}.`, [{ label: `Invoices from ${c}`, value: "0", sources: [] }], [], `Searched the vendor on every invoice for ${c}; none matched.`);
    }
  }

  /* owners by city (cities read from the owners' own addresses) */
  m = /^how many\s+(owners|clients|landlords|customers)\s+(?:do we have|have we got|we have|do we got)?\s*(?:in|from|around|near)\s+([A-Z][A-Za-z.' -]{2,24})$/.exec(q);
  if (m) {
    const city = m[2].trim();
    const r = await db.raw(`SELECT id, data->>'customer_name' AS name, data->>'service_address' AS addr FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL`);
    const cityOf = (a) => (/,\s*([^,]+),\s*[A-Z]{2}\b/.exec(a ?? "") ?? [])[1]?.trim();
    const cities = [...new Set(r.rows.map((x) => cityOf(x.addr)).filter(Boolean))].sort();
    const hit = cities.find((c) => c.toLowerCase() === city.toLowerCase());
    if (hit) { const rows = r.rows.filter((x) => cityOf(x.addr) === hit); return ok(`${rows.length} ${m[1].toLowerCase()} in ${hit}.`, [{ label: `${m[1]} in ${hit}`, value: String(rows.length), sources: [] }], rows.slice(0, 20).map((x) => makeRecord({ type: "customer", id: x.id, label: x.name })).filter(Boolean), `Counted the owner records whose address city is ${hit}.`); }
    if (!cities.some((c) => osa(c.toLowerCase(), city.toLowerCase()) <= 1)) return ok(`0 ${m[1].toLowerCase()} in ${city}: no owner address on file is in that city. The cities I do have are ${cities.join(", ")}.`, [{ label: `${m[1]} in ${city}`, value: "0", sources: [] }], [], `Read the city on every owner address; none is ${city}.`);
  }
  return null;
}

export async function tryPropertyPack(db, question, { today } = {}) {
  const raw = String(question ?? "");
  const q = cleanQ(raw);
  if (!q || q.length > 300) return null;
  const t = /^\d{4}-\d{2}-\d{2}$/.test(String(today ?? "")) ? today : new Date().toISOString().slice(0, 10);
  try {
    const base = (await countLane(db, raw)) ?? (await unitLane(db, q, raw, t)) ?? (await vendorLane(db, raw, q)) ?? (await payStatusLane(db, raw, q)) ?? (await vacancyLane(q)) ?? (await tenantCountLane(db, q)) ?? (await vendorTradeLane(db, raw, q)) ?? (await vendorUnpaidLane(db, raw, q)) ?? (await monthToMonthLane(db, q)) ?? (await ownerUnitsLane(db, raw, q)) ?? (await rentStatsLane(db, raw, q)) ?? (await noBuildingLane(db, q)) ?? (await notOnFileLane(db, q)) ?? (await personLane(db, q, raw, t));
    return base ?? (await extrasLane(db, raw, q, t));
  } catch (err) {
    console.error("propertyPack lane failed, falling through:", err?.message);
    return null;
  }
}
