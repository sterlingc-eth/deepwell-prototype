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
       FROM extractions x JOIN documents d ON d.id = x.document_id WHERE x.document_id = ANY($1::uuid[])`,
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
  const r = await db.raw(`SELECT d.id FROM documents d WHERE d.document_type = $1 ${extra}`, [type, ...params]);
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
  [/\b(?:paid|pay)\s+(?:this month|yet|on time)|\blate\s+(?:fees?|rent|payments?)|\brent\s+(?:paid|payments?)\b|\bpayment\s+history\b|\boverdue\s+rent\b/i, "rent payment"],
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
  const r = await db.raw(`SELECT DISTINCT d.id FROM extractions t JOIN documents d ON d.id = t.document_id WHERE t.field_key = 'tenant_name' AND lower(t.value) = lower($1)`, [name]);
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

export async function tryPropertyPack(db, question, { today } = {}) {
  const raw = String(question ?? "");
  const q = cleanQ(raw);
  if (!q || q.length > 300) return null;
  const t = /^\d{4}-\d{2}-\d{2}$/.test(String(today ?? "")) ? today : new Date().toISOString().slice(0, 10);
  try {
    return (await countLane(db, raw)) ?? (await unitLane(db, q, raw, t)) ?? (await noBuildingLane(db, q)) ?? (await notOnFileLane(db, q)) ?? (await personLane(db, q, raw, t));
  } catch (err) {
    console.error("propertyPack lane failed, falling through:", err?.message);
    return null;
  }
}
