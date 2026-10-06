/**
 * Property management question lanes (Build 2, stage 2D): answers the questions a property manager actually asks, straight from
 * the extracted paperwork, with the source page, and NO model. Mirrors the plumbing lane.
 *
 *   classifyProperty(question, {today}) -> intent | null      (pure)
 *   runProperty(db, intent, {today})    -> answer envelope | null
 *   propertyAttention(db, {today, withinDays}) -> {items}      (dashboard card: same definitions as the lane)
 *
 * null always means "not sure": the normal path (and its model) takes over. Legal and compliance judgement questions get the
 * fixed decline text. Every fact cites {documentId, location:{field, page}}. Definitions (literal and short):
 *   - A vendor's CURRENT certificate of insurance (COI) is the one with the LATEST expiry; older certificates are history and
 *     never feed an expired / expiring / insured answer. The expiry is the earliest policy expiry printed (coverage first lapses).
 *   - EXPIRED: date < today. Expires today is not expired. WITHIN N DAYS: today <= date <= today + N (inclusive both ends).
 *   - A unit's CURRENT lease is the latest-starting lease on file for that unit; a unit with no lease on file is read from the
 *     rent roll. A lease with printed status month-to-month is month-to-month. An expired lease is only called expired when it is
 *     the unit's latest lease.
 *   - A work order is OPEN unless its status says completed / closed / cancelled. OVERDUE: open and its printed scheduled date
 *     is before today. The same work order printed twice counts once (latest copy); copies that disagree about open/closed return null.
 *   - Invoices count once per vendor + invoice number (copies that disagree return null). UNPAID: status is not paid.
 *     OVERDUE: unpaid and its printed due date is before today (or its status says overdue). No due date is never computed.
 *   - A reinspection is NEEDED when an inspection prints a reinspection date and no later inspection of the same property /
 *     unit / type is on file. FAILED: the printed result says failed.
 *   - An answer that depends on a value we cannot read, two readings that disagree, or a question we do not fully understand
 *     returns null (the normal path) rather than a guess.
 * Company isolation: every query runs inside the caller's tenant transaction (row-level security).
 */
import { answerEnvelope } from '../../scope.js';
import { parseDate } from '../plumbing/extract.js';

const TENANT = "tenant_id = (current_setting('app.tenant_id', true))::uuid";

export const DECLINE = {
  legal: "I can't give legal advice about leases, evictions, deposits or fair housing. I can show what your documents say, with the page.",
  compliance: "I can't judge whether a vendor's coverage, a contract or an inspection meets your requirements or the law. I can show what the document says, with the page. Ask me about a specific vendor, unit or document.",
};

/* ------------------------------------------------------------------ text helpers */
const norm = (s) => String(s ?? '').toLowerCase().replace(/&/g, ' and ').replace(/['’]s\b/g, '').replace(/['’]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
const toks = (s) => norm(s).split(' ').filter(Boolean);
const alnum = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const okIso = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d ?? '');
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const addMonths = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1 + n, 1)); const dim = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate(); return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(d, dim))).toISOString().slice(0, 10); };
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const humanDate = (iso) => { const m = String(iso ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? `${MONTHS_LONG[+m[2] - 1]} ${+m[3]}, ${m[1]}` : String(iso ?? ''); };
const num = (v) => { const n = Number(String(v ?? '').replace(/[$,]/g, '')); return Number.isFinite(n) && String(v ?? '').trim() !== '' ? n : null; };
const money = (v) => { const n = num(v); return n == null ? String(v ?? '') : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; };
const agree = (n, head) => (n === 1 ? head.replace(/^(need|have|renew)\b/, (m) => ({ need: 'needs', have: 'has', renew: 'renews' })[m]) : head);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const dayWord = (n) => `${n} day${n === 1 ? '' : 's'}`;

const TYPOS = { insurence: 'insurance', insurnce: 'insurance', insured: 'insured', certficate: 'certificate', certifcate: 'certificate', certificat: 'certificate', expries: 'expires', expirs: 'expires', expird: 'expired', expierd: 'expired', experied: 'expired', tennant: 'tenant', tennat: 'tenant', tenat: 'tenant', moneth: 'month', lese: 'lease', leas: 'lease', vaccant: 'vacant', vacent: 'vacant', invioce: 'invoice', invoce: 'invoice', unpiad: 'unpaid', overdeu: 'overdue', ovedue: 'overdue', contrat: 'contract', contarct: 'contract', insepction: 'inspection', inspecion: 'inspection', reinspction: 'reinspection', deposite: 'deposit', depost: 'deposit', vender: 'vendor', vendr: 'vendor', vendors: 'vendors', leasse: 'lease', pest: 'pest' };
function prep(question) {
  let s = norm(question).split(' ').map((w) => TYPOS[w] ?? w).join(' ');
  s = s.replace(/\bwo ?(\d{3,7})\b/g, 'work order $1');
  s = s.replace(/\bcoi\b|\bcois\b|\bc o i\b/g, (m) => (m === 'cois' ? 'coi' : 'coi')).replace(/\bmtm\b/g, 'month to month').replace(/\bm to m\b/g, 'month to month').replace(/\bw o\b|\bwos\b/g, (m) => (m === 'wos' ? 'work orders' : 'work order')).replace(/\bwo\b/g, 'work order').replace(/\bpm\b/g, 'property manager');
  s = s.replace(/\bmonth ?to ?month\b/g, 'month to month').replace(/\bmonthtomonth\b/g, 'month to month').replace(/\bre ?inspect/g, 'reinspect').replace(/\bre inspection/g, 'reinspection').replace(/\bauto ?renew\w*/g, (m) => (m.endsWith('s') ? 'autorenew' : 'autorenew')).replace(/\bauto renew\w*/g, 'autorenew').replace(/\brenews? automatically\b|\bautomatically renews?\b|\bautomatic renewals?\b/g, 'autorenew').replace(/\bcertificates? of insurance\b|\binsurance certificates?\b|\binsurance certs?\b|\bcertificates\b|\bcertificate\b|\bcerts?\b/g, 'coi');
  return s;
}

const STREET_SUF = 'st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|way|ct|court|cir|circle|pl|place|pkwy|parkway|hwy|highway|ter|terrace|trl|trail|loop';
const SUF_CANON = { street: 'st', avenue: 'ave', road: 'rd', drive: 'dr', lane: 'ln', court: 'ct', boulevard: 'blvd', circle: 'cir', place: 'pl', parkway: 'pkwy', terrace: 'ter', trail: 'trl', highway: 'hwy' };
const DIR_CANON = { north: 'n', south: 's', east: 'e', west: 'w' };
const SUF_SET = new Set([...Object.keys(SUF_CANON), ...Object.values(SUF_CANON), 'way', 'loop']);
const canonTok = (w) => DIR_CANON[w] ?? SUF_CANON[w] ?? w;
/** The street part only, suffix and directions canonical, nothing after the suffix. */
function addrBase(raw) {
  const t = norm(String(raw ?? '').split(',')[0]).split(' ').filter(Boolean).map(canonTok);
  const i = t.findIndex((w, k) => k > 0 && SUF_SET.has(w));
  return (i >= 0 ? t.slice(0, i + 1) : t).join(' ');
}

/* ------------------------------------------------------------------ data */
const DATE_KEY = /^(?:coi_expires|policy_expiry|lease_start_date|lease_end_date|contract_start|contract_end|invoice_date|invoice_due|reinspection_due|opened_date|completed_date|service_date)$/;
const LATE_KEY = /^(?:coi_expires|policy_expiry|lease_end_date|contract_end|invoice_due|reinspection_due)$/;
/** Every document with its extracted values and the page each value came from (corrected values win). */
async function loadDocs(db) {
  const { rows } = await db.raw(
    `SELECT d.id, d.original_filename AS filename, d.document_type AS type, d.created_at,
            x.field_key AS key, COALESCE(x.corrected_value, x.value) AS value, f.page_no AS page
       FROM documents d
       LEFT JOIN extractions x ON x.document_id = d.id AND x.${TENANT}
       LEFT JOIN facets f ON f.id = x.source_facet_id
      WHERE d.${TENANT}
      ORDER BY d.created_at, d.id, x.created_at, x.id`, []);
  const map = new Map(); let order = 0;
  for (const r of rows) {
    let d = map.get(r.id);
    if (!d) { d = { id: r.id, filename: r.filename, type: r.type ? String(r.type).replace(/_/g, '-') : '', fields: {}, all: {}, order: order++ }; map.set(r.id, d); }
    if (r.key && r.value != null && String(r.value).trim() !== '') {
      let v = String(r.value);
      if (DATE_KEY.test(r.key) && !/^\d{4}-\d{2}-\d{2}$/.test(v)) { const iso = parseDate(v); if (iso) v = iso; }
      if (LATE_KEY.test(r.key) && /^\d{4}-\d{2}$/.test(v)) { const [yy, mm] = v.split('-').map(Number); v = new Date(Date.UTC(yy, mm, 0)).toISOString().slice(0, 10); }
      (d.all[r.key] ??= []).push({ value: v, page: r.page ?? 1 });
      d.fields[r.key] ??= { value: v, page: r.page ?? 1 };
    }
  }
  return [...map.values()];
}
const f = (d, k) => d?.fields?.[k]?.value ?? null;
const src = (d, k, page) => ({ documentId: d.id, location: { field: k, page: page ?? d.fields?.[k]?.page ?? 1 } });
const fact = (label, value, d, k, page) => ({ label, value, sources: [src(d, k, page)] });
/** A fact built from several fields of one document: one source per field that is actually on the document, each with its own page. */
const factM = (label, value, d, keys) => ({ label, value, sources: (Array.isArray(d) ? d : [d]).flatMap((x) => [...new Set(keys)].filter((k) => x.fields?.[k]).flatMap((k) => [...new Set((x.all?.[k] ?? [{ page: x.fields[k].page }]).map((e) => e.page))].map((pg) => src(x, k, pg)))) });
const lastBy = (arr, key) => [...arr].sort((a, b) => String(key(a) ?? '').localeCompare(String(key(b) ?? '')) || a.order - b.order).pop();

/* ------------------------------------------------------------------ places, vendors, units */
const GENERIC_PLACE = new Set(['apartments', 'apartment', 'villas', 'villa', 'townhomes', 'townhome', 'plaza', 'property', 'properties', 'building', 'buildings', 'complex', 'center', 'centre', 'court', 'condos', 'condominiums', 'estates', 'the', 'at', 'of', 'and', 'llc', 'inc', 'homes', 'community', 'hoa', 'association', 'tower', 'towers', 'lofts', 'terrace', 'park', 'commons']);
const CORP = new Set(['llc', 'inc', 'corp', 'ltd', 'co', 'company', 'lp', 'llp', 'incorporated']);
// corporate filler only: no trade or industry words here. Which other words are "generic" is worked out from the organization's own records (see orgGenericTokens).
const GENERIC_VENDOR = new Set([...CORP, 'services', 'service', 'the', 'and', 'of', 'group', 'solutions', 'systems', 'enterprises', 'associates', 'bros', 'brothers', 'sons']);
const TRAIL_GENERIC = new Set([...CORP, 'service', 'services']);
/** Punctuation, dots ("L.L.C."), apostrophes, legal suffixes and trailing generic words ("Services") never make a different vendor. */
const vendorKey = (s) => {
  const t = norm(s).replace(/\bl l c\b/g, 'llc').replace(/\bl l p\b/g, 'llp').replace(/\bi n c\b/g, 'inc').replace(/\bl t d\b/g, 'ltd').split(' ').filter((x) => x && !CORP.has(x));
  while (t.length > 1 && TRAIL_GENERIC.has(t[t.length - 1])) t.pop();
  return t.join(' ');
};
/** A looser reading (plural / possessive "s" folded): two different strict keys with one loose key MAY be one vendor, so nothing is declared about them. */
const looseKey = (k) => k.split(' ').map((x) => (x.length >= 4 && x.endsWith('s') && !x.endsWith('ss') ? x.slice(0, -1) : x)).join(' ');
const ambigCache = new WeakMap();
function ambiguousVendors(docs) {
  if (ambigCache.has(docs)) return ambigCache.get(docs);
  const by = new Map();
  for (const d of docs) { const v = f(d, 'vendor'); if (!v) continue; const k = vendorKey(v); const l = looseKey(k); (by.get(l) ?? by.set(l, new Set()).get(l)).add(k); }
  const out = new Set(); for (const set of by.values()) if (set.size > 1) for (const k of set) out.add(k);
  ambigCache.set(docs, out); return out;
}

/** Union-find over the property names and street addresses that appear together on a document. */
function placeModel(docs) {
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const add = (x) => { if (!parent.has(x)) parent.set(x, x); return x; };
  const union = (a, b) => { const ra = find(add(a)); const rb = find(add(b)); if (ra !== rb) parent.set(ra, rb); };
  const keysOf = (d) => {
    const nm = f(d, 'property_name'); const ak = addrBase(f(d, 'service_address'));
    return { n: nm ? `n:${norm(nm)}` : null, a: ak ? `a:${ak}` : null };
  };
  for (const d of docs) { const { n, a } = keysOf(d); if (n) add(n); if (a) add(a); if (n && a) union(n, a); }
  const groups = new Map();
  for (const d of docs) {
    const { n, a } = keysOf(d); const k = n ?? a; if (!k) continue;
    const root = find(k);
    let g = groups.get(root); if (!g) { g = { id: root, names: new Map(), addrs: new Map() }; groups.set(root, g); }
    if (n) g.names.set(norm(f(d, 'property_name')), f(d, 'property_name'));
    if (a) { g.addrs.set(addrBase(f(d, 'service_address')), String(f(d, 'service_address')).split(',')[0].trim()); const cityRaw = String(f(d, 'service_address')).split(',')[1]; const city = norm(String(cityRaw ?? '').replace(/\b[A-Z]{2}\b.*$/, '')); if (city) { (g.cities ??= new Set()).add(city); if (!g.cityDoc) { g.cityDoc = d; g.cityRaw = String(cityRaw).trim(); } } }
    if (n && a) g.both ??= d;
  }
  for (const g of groups.values()) { g.name = [...g.names.values()][0] ?? ''; g.addr = [...g.addrs.values()][0] ?? ''; g.label = g.name || g.addr; }
  const propOf = (d) => { const { n, a } = keysOf(d); const k = n ?? a; return k ? find(k) : null; };
  return { groups, propOf };
}

const wordIn = (hay, phrase) => phrase && ` ${hay} `.includes(` ${phrase} `);
/** Which properties, vendors and unit the question names. Anything it can't place is reported, never guessed. */
function resolve(docs, M, rawQ, q, t0) {
  const canonQ = ` ${norm(rawQ).split(' ').map(canonTok).join(' ')} `;
  const out = { props: new Set(), vendors: new Set(), units: new Set(), tokens: new Set(), unknown: false, unitUnknown: false, any: false };
  // properties
  for (const g of M.groups.values()) {
    let hit = false;
    for (const nm of g.names.keys()) {
      const full = nm; const dist = nm.split(' ').filter((t) => !GENERIC_PLACE.has(t)).join(' ');
      if (wordIn(q, full) || (dist && wordIn(q, dist))) { hit = true; (dist || full).split(' ').forEach((t) => out.tokens.add(t)); full.split(' ').forEach((t) => out.tokens.add(t)); }
    }
    if (!hit) { const dist = [...g.names.keys()].flatMap((nm) => nm.split(' ').filter((t) => !GENERIC_PLACE.has(t))); const others = [...M.groups.values()].filter((o) => o !== g).flatMap((o) => [...o.names.keys(), ...o.addrs.keys()].flatMap((nm) => nm.split(' '))); const vtoks = new Set(docs.flatMap((d) => (f(d, 'vendor') ? toks(f(d, 'vendor')) : []))); for (const t of dist) if (t.length >= 5 && !others.includes(t) && !vtoks.has(t) && wordIn(q, t)) { hit = true; out.tokens.add(t); } }
    for (const b of g.addrs.keys()) if (b && (canonQ.includes(` ${b} `) || (b.split(' ').length > 2 && /^\d/.test(b) && canonQ.includes(` ${b.split(' ').slice(0, -1).join(' ')} `)))) { hit = true; b.split(' ').forEach((t) => { out.tokens.add(t); if (t === 'st') out.tokens.add('street'); }); }
    for (const city of g.cities ?? []) if (new RegExp(`\\b${city} (?:property|properties|apartments|complex|community|location|building)\\b`).test(q)) { hit = true; out.tokens.add(city); }
    if (hit) out.props.add(g.id);
  }
  // a street address typed that matches nothing we know is never guessed
  const phrases = String(rawQ).match(new RegExp(`\\b\\d{1,6}\\s+(?:[A-Za-z0-9]+\\s+){0,3}(?:${STREET_SUF})\\b`, 'gi')) ?? [];
  const bases = [...M.groups.values()].flatMap((g) => [...g.addrs.keys()]);
  for (const ph of phrases) { const cp = ` ${norm(ph).split(' ').map(canonTok).join(' ')} `; if (!bases.some((b) => b && (cp.includes(` ${b} `) || ` ${b} `.includes(cp)))) out.unknown = true; }
  // vendors
  const vs = new Map();
  for (const d of docs) { const v = f(d, 'vendor'); if (v && !vs.has(vendorKey(v))) vs.set(vendorKey(v), v); }
  const distCount = new Map();
  for (const k of vs.keys()) for (const t of new Set(k.split(' ').filter((x) => !GENERIC_VENDOR.has(x)))) distCount.set(t, (distCount.get(t) ?? 0) + 1);
  const propToks = new Set([...M.groups.values()].flatMap((g) => [...g.names.keys(), ...g.addrs.keys()].flatMap((x) => x.split(' '))));
  // words this organization uses for something other than a vendor (its inspection kinds): never enough on their own to name a vendor
  const kindToks = new Set(docs.flatMap((d) => (d.all.inspection_type ?? []).flatMap((x) => norm(x.value).split(' '))));
  for (const [k, raw] of vs) {
    const all = k.split(' '); const dist = all.filter((t) => !GENERIC_VENDOR.has(t));
    let hit = wordIn(q, k) || (dist.length > 0 && wordIn(q, dist.join(' ')));
    // one distinctive word of a name is enough only when it is not one of the lane's own words ("open", "late", "paid"...)
    if (!hit && dist.length > 1) hit = dist.some((t) => t.length >= 4 && distCount.get(t) === 1 && !propToks.has(t) && !kindToks.has(t) && !LANE_WORDS.has(t) && wordIn(q, t));
    if (!hit && dist.length === 1) hit = wordIn(q, dist[0]) && distCount.get(dist[0]) === 1 && !LANE_WORDS.has(dist[0]);
    if (hit) { out.vendors.add(k); all.forEach((t) => out.tokens.add(t)); void raw; }
  }
  // a trade named instead of a vendor ("the plumber's COI"): only through a word in this organization's own vendor names (same word stem), and only when exactly one vendor has it
  if (!out.vendors.size) {
    const stem = (w) => String(w).replace(/s$/, '').replace(/(?:ers?|ing|ion|ial|or)$/, '').replace(/e$/, '');
    const qWords = q.split(' ').filter((w) => w.length >= 4);
    const byStem = new Map();
    for (const [k] of vs) for (const t of new Set(k.split(' ').filter((x) => x.length >= 4 && !GENERIC_VENDOR.has(x) && !propToks.has(x) && !kindToks.has(x) && !LANE_WORDS.has(x)))) { const st = stem(t); if (st.length >= 4) (byStem.get(st) ?? byStem.set(st, new Set()).get(st)).add(k); }
    for (const w of qWords) {
      const hits = byStem.get(stem(w));
      if (!hits || hits.size !== 1) continue;
      out.vendors.add([...hits][0]); out.tokens.add(w);
      if (/(?:er|ers|or|ors)(?:'s)?$/.test(w)) out.tokens.add(w.replace(/'s$/, ''));
      for (const x of ['company', 'contractor', 'vendor', 'service', 'companys']) out.tokens.add(x);
    }
  }
  // unit
  const known = new Set(); for (const d of docs) { const u = f(d, 'unit_number'); if (u) known.add(alnum(u)); for (const r of d.all.rent_roll_row ?? []) { const m = String(r.value).match(/unit=([^;]+)/); if (m) known.add(alnum(m[1])); } }
  const take = (t) => { const u = alnum(t); if (known.has(u)) { out.units.add(u); out.tokens.add(t); return true; } return false; };
  for (const m of q.matchAll(/\b(?:unit|apt|apartment|suite|ste|number)\s+#?\s*([a-z0-9]{1,5})\b/g)) { if (!take(m[1]) && /\d/.test(m[1])) out.unitUnknown = true; if (/\d/.test(m[1]) || known.has(alnum(m[1]))) out.tokens.add('unit'); }
  for (const t of q.split(' ')) if (/^\d{1,3}[a-z]$/.test(t) || /^[a-z]\d{1,3}$/.test(t)) { if (!take(t)) out.unitUnknown = true; }
  for (const m of q.matchAll(/\b(?:lives in|living in|live in|tenant of|tenant in|renter in|rent for|rent on|rent of|rent at|deposit for|deposit on|deposit at|resident of|resident in|occupant of|occupying|who is in|whos in)\s+(?:the\s+)?(?:unit\s+)?#?\s*(\d{1,4})\b/g)) { if (!take(m[1])) out.unitUnknown = true; }
  // tenants (by name) -> the unit they currently hold
  out.tenantKeys = new Set(); out.tenantMentioned = false;
  const curUnits = currentUnits(unitModel(docs, M), t0);
  const nameParts = (nm) => String(nm ?? '').split(/\s+(?:and|&)\s+|,\s*/i).map((x) => norm(x)).filter((x) => x.split(' ').length >= 2);
  // a tenant is known by the lease they hold now, or by a lease that has not started yet (kept apart: a future tenant does not live there yet)
  const entries = [];
  for (const u of curUnits) {
    if (!u.futureOnly) for (const part of nameParts(u.tenant)) entries.push({ u, part, fut: null });
    for (const fl of u.future) for (const part of nameParts(fl.tenant)) entries.push({ u, part, fut: fl });
  }
  out.tenantCur = new Set(); out.tenantFut = new Map();
  const tokUnits = new Map();
  for (const { u, part } of entries) for (const t of new Set(part.split(' '))) (tokUnits.get(t) ?? tokUnits.set(t, new Set()).get(t)).add(u.key);
  for (const { u, part, fut } of entries) {
    const pt = part.split(' '); const last = pt[pt.length - 1];
    const full = wordIn(q, part) || (pt.length === 2 && last.length >= 4 && tokUnits.get(last)?.size === 1 && !propToks.has(last) && wordIn(q, last) && pt.some((t) => t.length >= 3 && wordIn(q, t) && t !== last));
    if (full) {
      out.tenantKeys.add(u.key); part.split(' ').forEach((t) => out.tokens.add(t));
      if (fut) { const a = out.tenantFut.get(u.key) ?? out.tenantFut.set(u.key, []).get(u.key); if (!a.includes(fut)) a.push(fut); } else out.tenantCur.add(u.key);
    }
  }
  // work order and invoice numbers typed in the question
  out.woNums = new Set(); for (const m of q.matchAll(/\bwork order\s+#?\s*(\d{3,7})\b/g)) { out.woNums.add(m[1]); out.tokens.add(m[1]); }
  out.invNos = new Set();
  const invNos = new Map(); for (const d of docs) if (d.type === 'invoice' && f(d, 'invoice_number')) invNos.set(alnum(f(d, 'invoice_number')), f(d, 'invoice_number'));
  const rawWords = String(rawQ).split(/\s+/).filter(Boolean);
  for (let i = 0; i < rawWords.length; i++) {
    const w = alnum(rawWords[i]); const pair = i + 1 < rawWords.length ? w + alnum(rawWords[i + 1]) : null;
    for (const [forms, words] of [[w, [rawWords[i]]], [pair, pair ? [rawWords[i], rawWords[i + 1]] : []]]) {
      if (forms && forms.length >= 3 && /\d/.test(forms) && invNos.has(forms) && (!/^\d+$/.test(forms) || /\binvoices?\b/.test(q))) { out.invNos.add(forms); words.forEach((x) => norm(x).split(' ').forEach((t) => out.tokens.add(t))); }
    }
  }
  out.any = out.props.size > 0 || out.vendors.size > 0 || out.units.size > 0 || out.tenantKeys.size > 0;
  out.vendorNames = [...out.vendors].map((k) => vs.get(k));
  return out;
}

/* ------------------------------------------------------------------ models */
const MTM = /month[\s-]*to[\s-]*month|\bmtm\b|\bm2m\b/i;
/** A lease marked terminated, or with notice to vacate / a move-out date, is not a running lease. */
const TERMINATED = /\bterminat|notice to vacate|notice given|\bmove[\s-]*out\b|\bvacating\b|\bmoved out\b/i;
function parseRows(d) {
  return (d.all.rent_roll_row ?? []).map((r) => {
    const o = { page: r.page };
    for (const part of String(r.value).split(';')) { const i = part.indexOf('='); if (i > 0) o[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
    return o;
  }).filter((o) => o.unit);
}
/** One record per unit-source: leases and rent roll rows, tied to a property. */
function unitModel(docs, M) {
  const recs = [];
  for (const d of docs.filter((x) => x.type === 'lease-agreement')) {
    const u = f(d, 'unit_number'); if (!u) continue;
    recs.push({ src: 'lease', d, prop: M.propOf(d), unit: alnum(u), unitRaw: u, tenant: f(d, 'tenant_name'), start: f(d, 'lease_start_date'), end: f(d, 'lease_end_date'), rent: f(d, 'rent_amount'), dep: f(d, 'security_deposit'), status: f(d, 'status'), mtm: MTM.test(String(f(d, 'status') ?? '')), term: TERMINATED.test(String(f(d, 'status') ?? '')), page: (k) => d.fields[k]?.page ?? 1, order: d.order });
  }
  for (const d of docs.filter((x) => x.type === 'rent-roll')) {
    for (const r of parseRows(d)) recs.push({ src: 'roll', d, prop: M.propOf(d), unit: alnum(r.unit), unitRaw: r.unit, tenant: r.tenant ?? null, start: r.lease_start ?? null, end: r.lease_end ?? null, rent: r.rent ?? null, dep: r.deposit ?? null, status: r.status ?? null, vacant: /vacant/i.test(r.status ?? ''), mtm: MTM.test(r.status ?? ''), term: TERMINATED.test(r.status ?? ''), page: () => r.page ?? 1, order: d.order, key: 'rent_roll_row' });
  }
  return recs;
}
/** Per (property, unit): the current lease, else the rent roll row. Conflicts are flagged. */
function currentUnits(recs, t0) {
  const by = new Map();
  for (const r of recs) { const k = `${r.prop ?? ''}|${r.unit}`; (by.get(k) ?? by.set(k, []).get(k)).push(r); }
  // a lease or roll row whose property could not be read joins the only property that has that unit
  const unitProps = new Map(); for (const r of recs) if (r.prop) (unitProps.get(r.unit) ?? unitProps.set(r.unit, new Set()).get(r.unit)).add(r.prop);
  for (const [k, list] of [...by]) { if (k.startsWith('|')) { const ps = unitProps.get(list[0].unit); if (ps?.size === 1) { const kk = `${[...ps][0]}|${list[0].unit}`; by.get(kk).push(...list); by.delete(k); } } }
  const units = [];
  for (const [key, list] of by) {
    const leases = list.filter((r) => r.src === 'lease'); const rolls = list.filter((r) => r.src === 'roll');
    // the current lease is the latest one that has STARTED (start <= today); a lease starting later is a future lease and answers nothing about who lives there now
    const started = (r) => !t0 || !okIso(r.start) || r.start <= t0;
    const live = leases.filter(started); const future = leases.filter((r) => !started(r)).sort((a, b) => String(a.start).localeCompare(String(b.start)) || a.order - b.order);
    const lease = live.length ? lastBy(live, (r) => r.start) : null;
    const sameStart = lease ? live.filter((r) => (r.start ?? '') === (lease.start ?? '')) : [];
    const rollLatest = rolls.length ? lastBy(rolls, () => '') : null;
    const cur = lease ?? rollLatest ?? future[0];
    const futureOnly = !lease && !rollLatest;
    // a signed renewal: a lease on file that starts the day after (or before) the current one ends
    const backToBack = cur?.end && okIso(cur.end) ? future.filter((r) => okIso(r.start) && r.start <= addDays(cur.end, 1)) : [];
    const renewal = backToBack.find((r) => cur.tenant && r.tenant && sameName(cur.tenant, r.tenant)) ?? null; // only the SAME tenant renews
    const newLease = renewal ? null : backToBack.find((r) => r.tenant) ?? null; // a different tenant's lease is a new lease, not a renewal
    const diff = (arr, fn) => new Set(arr.map(fn)).size > 1;
    // each kind of disagreement only matters to the answers that read that value
    const conflictEnd = (rolls.length > 1 && (diff(rolls, (r) => r.end) || diff(rolls, (r) => r.status))) || !!(lease && rollLatest && lease.end && rollLatest.end && lease.end !== rollLatest.end) || (sameStart.length > 1 && (diff(sameStart, (r) => r.end) || diff(sameStart, (r) => norm(r.status))));
    const conflictRent = (rolls.length > 1 && (diff(rolls, (r) => num(r.rent)) || diff(rolls, (r) => num(r.dep)))) || !!(lease && rollLatest && lease.start && rollLatest.start && lease.start === rollLatest.start && ((lease.rent && rollLatest.rent && num(lease.rent) !== num(rollLatest.rent)) || (lease.dep && rollLatest.dep && num(lease.dep) !== num(rollLatest.dep)))) || (sameStart.length > 1 && (diff(sameStart, (r) => num(r.rent)) || diff(sameStart, (r) => num(r.dep))));
    // a lease that names a tenant while the rent roll says the unit is vacant (or names someone else) is two stories: neither is chosen
    const conflictVacant = !!(lease && rollLatest?.vacant);
    const conflictTenant = (rolls.length > 1 && diff(rolls, (r) => norm(r.tenant))) || !!(lease && rollLatest?.tenant && lease.tenant && !sameName(lease.tenant, rollLatest.tenant)) || conflictVacant || (sameStart.length > 1 && diff(sameStart, (r) => norm(r.tenant)));
    const conflict = conflictEnd || conflictRent || conflictTenant;
    units.push({ key, prop: list[0].prop ?? (list.find((r) => r.prop)?.prop ?? null), unit: list[0].unit, unitRaw: cur.unitRaw, list, lease, roll: rollLatest, cur, future, futureOnly, renewal, newLease, terminated: !!cur.term, conflict, conflictEnd, conflictRent, conflictTenant, conflictVacant, tenant: cur.tenant, end: cur.end, start: cur.start, rent: cur.rent, dep: cur.dep, status: cur.status, mtm: !!cur.mtm, vacant: !lease && !!rollLatest?.vacant });
  }
  return units;
}
const sameName = (a, b) => { if (norm(a) && norm(a) === norm(b)) return true; const x = new Set(toks(a).filter((t) => t.length >= 3)); if (toks(b).some((t) => t.length >= 3 && x.has(t))) return true; const y = new Set(toks(a)); return toks(b).filter((t) => y.has(t)).length >= 2; };

/* work orders / invoices / contracts / inspections / COIs */
const WO_DONE = /^(?:completed?|closed|closed out|resolved|cancel+ed|done|finished|void|voided)$/i;
const WO_OPEN = /^(?:open|opened|in progress|scheduled|on hold|pending|assigned|new|waiting|started|dispatched|awaiting parts|waiting on parts|approved|in process|requested)$/i;
const statusText = (s) => String(s ?? '').trim().replace(/[^A-Za-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
function workOrders(docs, M) {
  const byNo = new Map(); let solo = 0;
  const wdocs = docs.filter((x) => x.type === 'work-order' && Object.keys(x.fields).length);
  const noProps = new Map(); for (const d of wdocs) { const n = alnum(f(d, 'work_order_number')); if (n && M.propOf(d)) (noProps.get(n) ?? noProps.set(n, new Set()).get(n)).add(M.propOf(d)); }
  // one number filed at two properties is two work orders (a copy with no readable property is kept apart: which one is it?)
  for (const d of wdocs) { const n = alnum(f(d, 'work_order_number')); const multi = n && noProps.get(n)?.size > 1; const k = n ? (multi ? `${n}|${M.propOf(d) ?? `?${solo++}`}` : n) : `solo${solo++}`; (byNo.get(k) ?? byNo.set(k, []).get(k)).push(d); }
  return [...byNo.values()].map((list) => {
    const d = lastBy(list, () => '');
    const st = statusText(f(d, 'status'));
    const cls = (x) => (WO_DONE.test(statusText(f(x, 'status'))) ? 'done' : WO_OPEN.test(statusText(f(x, 'status'))) ? 'open' : 'other');
    const classes = new Set(list.map(cls));
    let state = cls(d);
    if (classes.size > 1) state = 'other'; // copies disagree about open / closed
    if (state === 'open' && f(d, 'completed_date')) state = 'other';
    if (state === 'done' && st && /^cancel/i.test(st)) state = 'done';
    const sched = f(d, 'service_date') && f(d, 'service_date') !== f(d, 'opened_date') ? f(d, 'service_date') : null;
    return { d, list, no: f(d, 'work_order_number'), state, status: f(d, 'status'), prop: M.propOf(d), unit: alnum(f(d, 'unit_number')), unitRaw: f(d, 'unit_number'), vendor: f(d, 'vendor'), opened: f(d, 'opened_date'), sched, completed: f(d, 'completed_date'), work: (d.all.work_performed ?? []).map((x) => x.value).join('; '), cost: f(d, 'cost') };
  });
}
const INV_UNPAID = /\b(?:unpaid|open|due|overdue|outstanding|pending|past due|balance due|not paid|partial\w*|invoiced|sent)\b/i;
const INV_PAID = /^(?:paid|paid in full|settled|closed|payment received|paid check|paid ach)$/i;
function invoices(docs, M, today) {
  const byKey = new Map(); let solo = 0;
  for (const d of docs.filter((x) => x.type === 'invoice' && Object.keys(x.fields).length)) { const no = alnum(f(d, 'invoice_number')); const k = no ? `${vendorKey(f(d, 'vendor') ?? '')}|${no}` : `solo${solo++}`; (byKey.get(k) ?? byKey.set(k, []).get(k)).push(d); }
  return [...byKey.values()].map((list) => {
    const d = lastBy(list, () => '');
    const sig = (x) => `${num(f(x, 'cost'))}|${statusText(f(x, 'status')).toLowerCase()}|${f(x, 'invoice_due')}`;
    const conflict = new Set(list.map(sig)).size > 1;
    const st = statusText(f(d, 'status'));
    const cls = INV_PAID.test(st) ? 'paid' : /\bunpaid\b|\bnot paid\b/i.test(st) || (INV_UNPAID.test(st) && !/\bpaid\b/i.test(st)) ? 'unpaid' : 'other';
    const due = f(d, 'invoice_due');
    const overdue = cls === 'unpaid' && (/\boverdue\b|\bpast due\b/i.test(st) || (okIso(due) && today && due < today));
    return { d, list, conflict, no: f(d, 'invoice_number'), vendor: f(d, 'vendor'), cls, overdue, due, date: f(d, 'invoice_date'), cost: num(f(d, 'cost')), prop: M.propOf(d), unit: alnum(f(d, 'unit_number')), unitRaw: f(d, 'unit_number'), status: f(d, 'status') };
  });
}
function contracts(docs, M) {
  const seen = new Map();
  for (const d of docs.filter((x) => x.type === 'vendor-contract' && Object.keys(x.fields).length)) { const k = `${vendorKey(f(d, 'vendor') ?? '')}|${norm(f(d, 'contract_scope') ?? '')}|${f(d, 'contract_start')}|${f(d, 'contract_end')}`; seen.set(k, d); }
  return [...seen.values()].map((d) => ({ d, vendor: f(d, 'vendor'), vk: vendorKey(f(d, 'vendor') ?? ''), scope: f(d, 'contract_scope'), start: f(d, 'contract_start'), end: f(d, 'contract_end'), auto: f(d, 'auto_renew') ? String(f(d, 'auto_renew')).toLowerCase() : null, monthly: num(f(d, 'monthly_amount')), prop: M.propOf(d) }));
}
const INSP_TYPES = new Set(['inspection-report', 'move-in-inspection', 'move-out-inspection']);
function inspections(docs, M) {
  const label = (d) => (d.type === 'move-in-inspection' ? 'move-in' : d.type === 'move-out-inspection' ? 'move-out' : String(f(d, 'inspection_type') ?? 'inspection').toLowerCase().replace(/\s+inspections?$/, '').trim() || 'inspection');
  const all = docs.filter((x) => INSP_TYPES.has(x.type) && Object.keys(x.fields).length).map((d) => ({ d, prop: M.propOf(d), unit: alnum(f(d, 'unit_number')), unitRaw: f(d, 'unit_number'), kind: label(d), date: f(d, 'service_date'), result: f(d, 'inspection_result'), reinspect: f(d, 'reinspection_due'), defs: (d.all.deficiency ?? []).map((x) => x.value) }));
  const FOLLOW = /re-?inspection|follow[- ]?up/;
  for (const i of all) {
    // only the LATEST inspection of a unit (or of the property when no unit is printed) says whether it failed now
    const group = all.filter((o) => o.prop === i.prop && o.unit === i.unit && (i.unit || o.kind === i.kind));
    const later = group.filter((o) => o !== i && okIso(o.date) && okIso(i.date) && o.date > i.date);
    i.superseded = later.length > 0;
    i.unsure = group.length > 1 && (!okIso(i.date) || group.some((o) => o !== i && (!okIso(o.date) || (o.date === i.date && /\bfail/i.test(o.result ?? '') !== /\bfail/i.test(i.result ?? '')))));
    i.failedText = /\bfail/i.test(i.result ?? '');
    i.failed = i.failedText && !i.superseded;
    i.cleared = !!i.reinspect && all.some((o) => o !== i && o.prop === i.prop && o.unit === i.unit && (o.kind === i.kind || FOLLOW.test(o.kind)) && okIso(o.date) && okIso(i.date) && o.date > i.date);
    i.needsRe = !!i.reinspect && okIso(i.reinspect) && !i.cleared;
  }
  return all;
}
const inspLabel = (i, props) => `${i.kind[0].toUpperCase()}${i.kind.slice(1)} inspection${i.unitRaw ? ` · unit ${i.unitRaw}` : ''}${props.get(i.prop)?.label ? ` · ${props.get(i.prop).label}` : ''}`;
function cois(docs) {
  const byV = new Map();
  for (const d of docs.filter((x) => x.type === 'certificate-of-insurance' && f(x, 'vendor'))) { const k = vendorKey(f(d, 'vendor')); (byV.get(k) ?? byV.set(k, []).get(k)).push(d); }
  return [...byV.entries()].map(([k, list]) => {
    const dated = list.filter((d) => okIso(f(d, 'coi_expires')));
    const cur = dated.length ? lastBy(dated, (d) => f(d, 'coi_expires')) : null;
    return { key: k, vendor: f(list[0], 'vendor'), cur, exp: cur ? f(cur, 'coi_expires') : null, docs: list, undated: list.filter((d) => !okIso(f(d, 'coi_expires'))) };
  });
}
const allVendors = (docs) => { const m = new Map(); for (const d of docs) { const v = f(d, 'vendor'); if (v && ['certificate-of-insurance', 'invoice', 'work-order', 'vendor-contract'].includes(d.type) && !m.has(vendorKey(v))) m.set(vendorKey(v), v); } return m; };

/* ------------------------------------------------------------------ classification (pure) */
const TIME_BLOCK = /\b(?:this|last|next|past|previous|coming)\s+(?:week|month|quarter|year)\b|\b(?:since|before|after|during|between|until|through|ago|yesterday|tomorrow|older|newer|oldest|newest|average|avg|mean|median|most|least|top|biggest|largest|smallest|highest|lowest|cheapest|expensive|compare|compared|trend|than|rank|breakdown|percent|percentage|by month|by year|per year|each month|annually|weekly)\b|\bin (?:january|february|march|april|may|june|july|august|september|october|november|december|20\d\d)\b|\b20\d\d\b|\blast \d|\bpast \d/;
const STOP = new Set(('a an the of for at on in to is are was were be been am do does did has have had how many much what whats which who whom whose when where why show shows list lists tell give me us we our my your their his her its any every all each still now yet ever and or with from by about this that these those there theres it into out over under per as then so if can could would should will shall may might must also please thanks currently right today next last first latest recent ve i d need needs needed want see look find get got check up here one ones them they you he she t only just really yes anything anyone everything s file on record records document documents paperwork there whats whos property properties building complex community apartments apartment company companys contractor').split(/\s+/));
const VOCAB = {
  coi: 'carry carries have got hold carrier insurer underwriter insures limit each occurrence policy number numbers types type name coi insurance insured coverage covered expire expires expired expiring expiration expiry expirations lapse lapsed lapsing current valid good active on file vendor vendors contractor contractors liability certificate policy policies renew renewed renewal soon upcoming due coming out ran date dates still end ends ending ended gl general workers comp compensation limit liability insurer carrier'.split(' '),
  lease: 'run runs end date dates is lease leases leased expire expires expired expiring expiration end ends ending ended month to up soon upcoming renewal renew renewed renewing coming due tenant tenants resident residents rent rented renting unit units mtm start started begins date dates term current active agreement agreements whose out ran running'.split(' '),
  who: 'live lives living lived tenant tenants resident residents renter renters occupant occupants occupying occupied unit units in of at lease leases name names'.split(' '),
  rent: 'rent monthly rental price charge charged paying pay pays amount cost much unit monthly per month a lease asking listed deposit security deposits deposit held hold holding'.split(' '),
  vacant: 'apartments apartment asking vacant vacancy vacancies empty units unit open available rent roll rentroll occupied listed property properties building'.split(' '),
  wo: 'who number assigned priority opened open work order orders open opened overdue outstanding pending late completed complete closed done finished status scheduled hold progress repair repairs maintenance requests request tickets assigned vendor vendors unit units property properties still being fixed handled by past due'.split(' '),
  contract: 'start started begin began does do what cover covers our contract contracts vendor vendors agreement agreements service end ends ending ended expire expires expired expiring expiration soon upcoming autorenew renew renews renewing renewal renewals coming due term monthly amount cost pay paying paid charge charges month per much fee payment fees our'.split(' '),
  insp: 'done conducted performed condition conditions noted date when was inspection inspections inspected failed fail failing failure failures passed pass result results deficiency deficiencies deficient reinspect reinspection reinspections needing need needs needed due repair repairs found issues issue problems violations violation move in out hoa re unit units property properties scheduled upcoming overdue late find'.split(' '),
  inv: 'goes sent sent from has been what was for amount status number invoice invoices billed bill bills billing paid unpaid overdue outstanding due open late past total totals spent spend spending cost costs amount sum owed owe unit units property properties vendor vendors per by each all how much pending payable payables received'.split(' '),
  attn: 'attention due soon upcoming expiring expired overdue coming anything needs need review look action items things stuff matters important urgent coming up expire expires lapsing ending'.split(' '),
};
/** the lane's own words (grammar + intent cues): never enough on their own to name a vendor, property or tenant */
const LANE_WORDS = new Set([...STOP, ...Object.values(VOCAB).flat()]);
/** a word with digits in the raw question that could be an invoice number */
const rawHasId = (raw) => String(raw).split(/\s+/).some((w) => { const a = alnum(w); return a.length >= 3 && /\d/.test(a) && !/^\d{1,3}[A-Z]$/.test(a) && !/^(?:19|20)\d\d$/.test(a); });
function windowOf(q) {
  const m = q.match(/\b(?:in|within|over|during|for)?\s*(?:the\s+)?(?:next|coming|following)\s+(\d{1,3})\s+(days?|weeks?|months?)\b/) || q.match(/\bwithin\s+(?:the\s+)?(?:next\s+)?(\d{1,3})\s+(days?|weeks?|months?)\b/) || q.match(/\bin\s+(\d{1,3})\s+(days?|weeks?|months?)\b/) || q.match(/\b(\d{1,3})\s+(days?|weeks?|months?)\b/);
  if (m) return { n: +m[1], unit: m[2].startsWith('month') ? 'month' : m[2].startsWith('week') ? 'week' : 'day', text: m[0] };
  if (/\b(?:soon|upcoming|coming up|about to|expiring soon|coming due)\b/.test(q)) return { n: 60, unit: 'day', text: '', implicit: true };
  return null;
}
const windowEnd = (today, w) => (w.unit === 'month' ? addMonths(today, w.n) : addDays(today, w.n * (w.unit === 'week' ? 7 : 1)));
const windowLabel = (w) => (w.implicit ? '60 days' : `${w.n} ${w.unit}${w.n === 1 ? '' : 's'}`);
const rest = (q, vocab, drop = '') => { const v = new Set(vocab); return (drop ? q.replace(drop, ' ') : q).split(' ').filter(Boolean).filter((x) => !STOP.has(x) && !v.has(x) && !/^(?:days?|weeks?|months?)$/.test(x)); };

const TOPICS = [
  ['coi', /\bcoi\b|\binsurance\b|\binsured\b|\buninsured\b|\binsures\b|\binsurer\b|\bcarrier\b|\bpolicy\b|\bworkers comp\w*\b/],
  ['lease', /\bleases?\b|\bmonth to month\b|\bleased\b/],
  ['who', /\bwho (?:lives|is living|lived|rents|is renting|occupies|is in|is the tenant|has)\b|\btenants? (?:of|in|for)\b|\bresidents? (?:of|in)\b|\bwho s in\b|\bwhos in\b|\bwho is the (?:tenant|resident|renter|occupant)\b/],
  ['rent', /\brents?\b(?! roll)|\bdeposits?\b|\bpays? (?:a|per|each) month\b|\bpaying (?:a|per|each) month\b|\bpays? monthly\b/],
  ['vacant', /\bvacant\b|\bvacancy\b|\bvacancies\b|\bempty (?:units?|apartments?)\b|\brent rolls?\b|\boccupied\b/],
  ['wo', /\bwork orders?\b|\bmaintenance requests?\b/],
  ['contract', /\bcontracts?\b|\bautorenew\b|\bagreements?\b/],
  ['insp', /\binspections?\b|\bdeficienc\w+\b|\breinspect\w*\b/],
  ['inv', /\binvoices?\b|\bbills?\b|\bbilled\b|\bspent\b|\bspend\w*\b|\bunpaid\b|\bowed?\b/],
];
const COUNT_TYPES = [
  ['inspection-report', /\binspection reports?\b/, 'inspection report'],
  ['certificate-of-insurance', /\bcoi\b/, 'certificate of insurance', 'certificates of insurance'], ['lease-agreement', /\bleases?\b/, 'lease'], ['work-order', /\bwork orders?\b/, 'work order'], ['invoice', /\binvoices?\b/, 'invoice'], ['vendor-contract', /\bcontracts?\b/, 'vendor contract'], ['rent-roll', /\brent rolls?\b/, 'rent roll'],
];

function classifyInner(question, { today } = {}) {
  void today;
  const raw = String(question ?? '');
  if (!raw.trim() || raw.length > 400) return null;
  let q = prep(raw);
  // ---- judgement questions are never answered, never sent to a model
  if (/\b(?:evict\w*|sue|sued|suing|lawsuit|liable|liability for|negligen\w*|legal advice|fair housing|discriminat\w*)\b/.test(q) || (/\b(?:legal|legally|illegal)\b/.test(q) && /\b(?:is|are|can|could|do|does|to|allowed|permitted)\b/.test(q))) return { kind: 'decline', which: 'legal' };
  if (/\b(?:meet|meets|meeting|comply|complies|complying|compliant|(?:in|out of) compliance|satisfy|satisfies|adequate|sufficient|enough)\b/.test(q) && /\b(?:requirements?|requirement|required|code|law|laws|standard|standards|policy|coverage|insurance|coi|contract|lease|inspection|regulations?|minimums?)\b/.test(q)) return { kind: 'decline', which: 'compliance' };
  if (/\bshould (?:we|i|it|they|the)\b.*\b(?:renew|terminate|cancel|fire|drop|evict|raise|lower|hire|replace|pay|approve|reject|keep)\b/.test(q)) return { kind: 'decline', which: 'compliance' };
  // idiom for "has none": handled before the negation gate
  const noCoi = /\bvendors?\b.*\b(?:with no|without|missing|lacking|no)\b.*\bcoi\b|\bwhich vendors? (?:do not|dont|does not|doesnt|have not|havent|has not|hasnt|have no|has no)\b.*\bcoi\b|\bwho (?:has|have) no coi\b|\bno coi on file\b|\bmissing (?:a )?coi\b|\bcoi (?:is |are )?missing\b|\bvendors? (?:with|that have) no (?:insurance|coi)\b|\bwhich vendors? (?:have|has) no\b.*\bcoi\b|\bwithout (?:a )?coi\b/.test(q);
  if (noCoi) {
    // a second negation or an expiry word ("don't have expired COIs", "no COI that is not expired") is a different question
    if (/\b(?:expir\w*|lapse\w*|out of date)\b/.test(q) || (q.match(/\b(?:not|no|dont|doesnt|havent|hasnt|without|never|isnt|arent)\b/g) ?? []).length > 1) return null;
    // "do not have workers comp on their certificate" asks about a coverage, not about a missing certificate: never read as "no COI on file"
    if (/\b(?:workers|worker|comp|compensation|wc|liability|gl|general|auto|automobile|umbrella|excess|coverage|coverages|policy|policies|limit|limits|professional|property|pollution)\b/.test(q)) return null;
    // "no current COI": a certificate that is on file but expired does not count
    const current = /\b(?:current|valid|active|unexpired|in date|up to date)\b/.test(q);
    const r = rest(q, [...VOCAB.coi, 'no', 'without', 'missing', 'lacking', 'dont', 'doesnt', 'havent', 'hasnt', 'not', 'have', 'has', 'unexpired', 'in', 'date', 'up', 'to']);
    return { kind: 'coi_missing', current, rest: r };
  }
  // negation / exclusion / "first, earlier" asks are read by the normal path
  if (/\b(?:not|no|never|without|except|besides|excluding|neither|nor|none|isnt|arent|wasnt|werent|dont|doesnt|didnt|cant|wont|couldnt|shouldnt|hasnt|havent|hadnt)\b|\bother than\b/.test(q)) return null;
  if (/\b(?:first|earlier|previous|previously|original|originally|prior|oldest|initial|initially|before that|old|older|renewed|history|historical)\b/.test(q)) return null;
  if (TIME_BLOCK.test(q.replace(new RegExp(`\\b\\d{1,6}\\s+(?:[a-z0-9]+\\s+){0,3}(?:${STREET_SUF})\\b`, 'g'), ' ').replace(/\bin (?:the )?next \d{1,3} (?:days?|weeks?|months?)\b|\bnext \d{1,3} (?:days?|weeks?|months?)\b|\bwithin (?:the )?next \d{1,3} (?:days?|weeks?|months?)\b/g, ' '))) return null;
  if (/\b(?:and then|as well as|plus|also)\b|\b(?:and|but)\s+(?:which|what|how many|who)\b/.test(q)) return null;
  const present = TOPICS.filter(([, re]) => re.test(q)).map(([n]) => n);
  const grp = (n) => (n === 'who' || n === 'rent' ? 'unit' : n);
  const groups = new Set(present.map(grp));
  // lease + rent / who are one family ("rent on the lease for unit 4B"); everything else is one ask only
  if (groups.has('lease') && groups.has('unit')) { groups.delete('lease'); }
  if (groups.size > 1) return null;
  if (/\b(?:and|or)\b/.test(q) && /\b(?:expired?|expiring|overdue|unpaid|failed|open|completed|vacant)\b.*\b(?:and|or)\b.*\b(?:expired?|expiring|overdue|unpaid|failed|open|completed|vacant)\b/.test(q) && !/\bexpire\w* or expired\b/.test(q)) return null;
  if (/\bever\b|\boverdue by\b|\b\d+\s*(?:days?|weeks?|months?)\s+(?:overdue|late|past due)\b|\bover \d+\s*(?:days?|weeks?|months?)\b|\b\d+\s*\+/.test(q)) return null;

  const win = windowOf(q);
  const qw = win?.text ? q.replace(win.text, ' ') : q;
  const how = /\bhow many\b(?! (?:years?|months?|days?)\b)/.test(q);
  const listCue = /\b(?:which|show|list|any|every|all|anything|anyone|what)\b/.test(q);
  const single = /^(?:is|are|was|were|did|does|do|has|have|when|what|whats|who|whos|how)\b/.test(q);
  const expiredW = /\bexpired\b|\blapsed\b|\bran out\b|\bout of date\b/.test(q);
  const expiringW = /\bexpir(?:e|es|ing|ation)\b|\bending\b|\bends\b|\bend\b|\bcoming up\b|\bcoming due\b|\bup for renewal\b|\brenew\w*\b|\bsoon\b|\bupcoming\b|\bdue\b/.test(q.replace(/\bexpired\b/g, ' '));
  const topic = [...groups][0] ?? null;

  /* ---- attention list */
  if (!topic && (/\bneed\w*\s+(?:my |our |your )?(?:attention|a look|action)\b|\bwhats due\b|\bwhat is due\b|\bdue soon\b|\bcoming due\b|\bcoming up\b|\bexpiring soon\b|\bwhat should i (?:look at|check|follow up)\b|\bany(?:thing)? (?:expiring|overdue|due)\b|\bwhat (?:s|is) (?:expiring|overdue|late)\b|\bwhat needs\b/.test(q))) {
    const r = rest(q, VOCAB.attn);
    const only = /\b(?:overdue|late)\b/.test(q) && !/\b(?:attention|due soon|coming due|expiring|expired|expire|soon|needs?)\b/.test(q) ? 'overdue' : null;
    return { kind: 'attn_all', win: win?.n ? win : null, only, rest: r };
  }
  if (!topic && /\baddress (?:of|for)\b/.test(q) && !how && !win) return { kind: 'prop_addr', rest: rest(q, ['address', 'property', 'properties', 'apartments', 'building']) };
  if (!topic) return null;

  /* ---- counts of documents on file */
  if (how && ['coi', 'lease', 'wo', 'inv', 'contract', 'vacant', 'insp'].includes(topic) && !/\b(?:expir\w*|overdue|unpaid|open|completed|closed|failed|vacant|month to month|late|due|soon|upcoming|past|current|active|ending)\b/.test(q)) {
    const ts = COUNT_TYPES.filter(([, re]) => re.test(q));
    if (ts.length === 1 && /\b(?:on file|do we have|have we got|we have)\b/.test(q)) return { kind: 'count_type', type: ts[0][0], noun: ts[0][2], nouns: ts[0][3], hoa: /\bhoa\b/.test(q), rest: rest(qw, [...VOCAB.coi, ...VOCAB.lease, ...VOCAB.wo, ...VOCAB.inv, ...VOCAB.contract, ...VOCAB.insp, 'compliance', 'report', 'reports', 'rent', 'roll', 'rolls', 'we', 'have']) };
    return null;
  }

  /* ---- certificates of insurance */
  if (topic === 'coi') {
    const r0 = rest(qw, VOCAB.coi);
    const expired = expiredW; const expiring = expiringW;
    if (/\bworkers comp\w*\b/.test(q) && /^(?:does|do|is|are|has|have)\b/.test(q) && !win && !how) return { kind: 'coi_vendor', attr: 'workers', rest: r0 };
    if (expiring && /\btoday\b/.test(q) && (listCue || how) && !win) return { kind: 'coi_list', mode: 'today', count: how, rest: rest(q.replace(/\btoday\b/g, ' '), VOCAB.coi) };
    if (/\bneed\w* (?:my |our )?attention\b/.test(q) && !win && !how) return { kind: 'coi_list', mode: 'attn', rest: rest(q, [...VOCAB.coi, 'need', 'needs', 'attention']) };
    if (expired && expiring && !/\bexpire\w* or expired\b/.test(q)) return null;
    if ((listCue || how) && !/^(?:is|are|does|do|has|have|did|was)\b/.test(q) && !/\bwhen\b|\bwho\b/.test(q)) {
      if (expired) return { kind: 'coi_list', mode: 'expired', count: how, rest: r0 };
      if (expiring && win) return { kind: 'coi_list', mode: 'expiring', win, count: how, rest: rest(qw, [...VOCAB.coi, 'soon']) };
      if (/\bexpiring\b|\bexpire\b|\bexpires\b/.test(q) && !win) return null;
    }
    const attr0 = /\bcarrier\b|\binsurer\b|\binsured (?:with|by)\b|\binsures\b|\bunderwriter\b|\binsurance company\b|\bwho (?:is|are) .*\binsured (?:with|by)\b/.test(q) ? 'insurer' : /\blimit\b|\beach occurrence\b/.test(q) ? 'limit' : /\bpolicy (?:number|no)\b|\bpolicy\b/.test(q) ? 'policy' : /\bcoverage types?\b|\bwhat (?:coverage|policies)\b|\bwhich coverage\b|\bcovered for\b/.test(q) ? 'coverage' : null;
    // a policy or limit for a coverage other than general liability is not stored: never answered with the general liability one
    const attr = (attr0 === 'policy' || attr0 === 'limit') && /\b(?:workers|auto|automobile|umbrella|excess|professional|property|pollution|wc)\b/.test(q) ? undefined : attr0;
    if (attr === undefined) return null;
    if (attr && !win && !how) return { kind: 'coi_vendor', attr, rest: r0 };
    if (/\bwhen\b.*\b(?:expire\w*|renew\w*|end\w*|lapse\w*|due)\b|\b(?:is|are|does|do|did|has)\b.*\b(?:insured|insurance|coi|current|valid|expired|good|active|covered)\b|\bexpiration\b|\bexpiry\b|\bexpire\b|\bexpires\b/.test(q)) return { kind: 'coi_vendor', attr: /\bwhen\b|\bexpir\w*\b|\brenew\w*\b|\bend\w*\b|\blapse\w*\b/.test(q) ? 'when' : 'status', rest: r0 };
    if (/\bcoi\b/.test(q) && /\b(?:for|from|by)\b/.test(q) && (listCue || /\bwhat\b/.test(q))) return { kind: 'coi_vendor', attr: 'when', rest: r0 };
    // a bare "<vendor> coi" asks for that vendor's certificate: its expiry (the vendor must resolve to exactly one, or it goes to the normal path)
    if (/\bcoi\b/.test(q) && !listCue && !how && !win && !expired && !expiring) return { kind: 'coi_vendor', attr: 'when', rest: r0 };
    return null;
  }

  /* ---- who lives in / rent / deposit for a unit */
  if (topic === 'unit' && present.includes('who') && present.includes('rent')) return null;
  if (topic === 'unit' && present.includes('who')) {
    if (how || win) return null;
    return { kind: 'unit_fact', attr: 'tenant', rest: rest(qw, VOCAB.who) };
  }
  if (topic === 'unit') {
    if (how || win) return null;
    const dep = /\bdeposits?\b/.test(q);
    if (dep && /\brent\b/.test(q.replace(/\brent roll\b/g, ''))) return null;
    return { kind: 'unit_fact', attr: dep ? 'deposit' : 'rent', rest: rest(qw, [...VOCAB.rent, ...VOCAB.who]) };
  }

  /* ---- leases and the rent roll */
  if (topic === 'vacant') {
    if (win) return null;
    const isQ = /^(?:is|are|was|does)\b/.test(q);
    if (/\boccupied\b/.test(q) && !/\bunit\b/.test(q) && !isQ) return null;
    if (isQ || (/\bunit\b/.test(q) && !listCue && !how)) return { kind: 'unit_fact', attr: 'occupancy', rest: rest(qw, [...VOCAB.vacant, ...VOCAB.who]) };
    if (/\bvacant\b|\bvacancy\b|\bvacancies\b|\bempty\b/.test(q)) return { kind: 'vacant_list', count: how, rest: rest(qw, VOCAB.vacant) };
    return null;
  }
  if (topic === 'lease') {
    const r0 = rest(qw, VOCAB.lease);
    if (/\bmonth to month\b/.test(q) && /^(?:is|are|does|do|has|did)\b/.test(q) && !/\b(?:which|any|all|list|how many)\b/.test(q) && !win) return { kind: 'unit_fact', attr: 'mtm', rest: rest(qw.replace(/\bmonth to month\b/g, ' '), [...VOCAB.lease, ...VOCAB.who]) };
    if (/\bmonth to month\b/.test(q)) { if (win) return null; return { kind: 'lease_list', mode: 'mtm', count: how, rest: rest(qw.replace(/\bmonth to month\b/g, ' '), VOCAB.lease) }; }
    if ((/\bwhen\b|\bwhat date\b|\b(?:end|expiration|expiry|start) date\b/.test(q)) && /\b(?:end|ends|expire|expires|start|starts|began|begin|begins|up|date|run out|runs out)\b/.test(q) && !/\bwhich\b/.test(q) && !win && !how) return { kind: 'unit_fact', attr: /\bstart|\bbegin/.test(q) ? 'start' : 'end', rest: rest(qw, [...VOCAB.lease, ...VOCAB.who]) };
    if (/\bneed\w* (?:my |our )?attention\b/.test(q) && !win && !how) return { kind: 'lease_list', mode: 'attn', rest: rest(q, [...VOCAB.lease, 'need', 'needs', 'attention']) };
    if ((listCue || how) && expiredW && !expiringW) return { kind: 'lease_list', mode: 'expired', count: how, rest: r0 };
    if ((listCue || how) && expiringW && win) return { kind: 'lease_list', mode: 'expiring', win, count: how, rest: rest(qw, [...VOCAB.lease, 'soon']) };
    return null;
  }

  /* ---- work orders */
  if (topic === 'wo') {
    const r0 = rest(qw, VOCAB.wo);
    if (win) return null;
    if (/\bwork order \d{3,7}\b/.test(q) && !/\bwhich work orders?\b|\bhow many\b/.test(q)) {
      const cues = [['who', /\bwho\b|\bassigned\b|\bvendor\b|\bcontractor\b|\bhandling\b/], ['opened', /\bopened\b|\bwhen was\b.*\b(?:open\w*|created|submitted|reported)\b|\bwhen (?:did|was)\b/], ['priority', /\bpriority\b|\burgent\b/], ['done', /\bwhen\b.*\b(?:completed|finished|closed|done)\b/], ['status', /\bstatus\b|\bopen\b|\bcompleted\b|\bclosed\b|\bdone\b/], ['work', /\bwhat work\b|\bwork performed\b|\bwhat (?:is|was) (?:it|that) for\b|\babout\b|\bwhat is\b.*\bfor\b|\bdescription\b/], ['cost', /\bcost\b|\bhow much\b|\bprice\b|\bamount\b|\btotal\b/], ['sched', /\bscheduled\b|\bwhen is\b/]];
      const hit = cues.filter(([, re]) => re.test(q)).map(([a]) => a);
      const hit1 = hit.includes('done') ? ['done'] : hit;
      if (hit1.length === 1) return { kind: 'wo_fact', attr: hit1[0], rest: rest(qw, [...VOCAB.wo, 'priority', 'cost', 'total', 'scheduled', 'created', 'submitted', 'reported', 'about', 'description', 'handling', 'work']) };
      return null;
    }
    const overdue = /\boverdue\b|\bpast due\b|\blate\b/.test(q);
    const stat = /\bon hold\b/.test(q) ? 'on hold' : /\bin progress\b/.test(q) ? 'in progress' : /\bscheduled\b/.test(q) && !/\bscheduled date\b/.test(q) ? 'scheduled' : null;
    if (stat && !/\bopen\b|\boverdue\b|\bcompleted?\b|\bclosed\b/.test(q)) return { kind: 'wo_list', mode: 'status', stat, count: how, rest: r0 };
    const open = /\bopen\b|\boutstanding\b|\bpending\b|\bstill\b|\bnot done\b|\bunresolved\b|\bneed\w* to be done\b/.test(q);
    const done = /\bcompleted?\b|\bclosed\b|\bfinished\b|\bdone\b|\bresolved\b/.test(q);
    if (open && done) return null;
    if (overdue && done) return null;
    if (overdue || open || done) {
      if (single && !listCue && !how && !/\bwhat\b/.test(q) && !/^(?:are|is)\b.*\b(?:any|there)\b/.test(q)) return null;
      return { kind: 'wo_list', mode: overdue ? 'overdue' : done ? 'done' : 'open', count: how, rest: r0 };
    }
    if (listCue || how || /^work orders?\b/.test(q)) return { kind: 'wo_list', mode: 'all', count: how, rest: r0 };
    return null;
  }

  /* ---- vendor contracts */
  if (topic === 'contract') {
    const r0 = rest(qw, VOCAB.contract);
    if (/\bnotice\b|\bdeadline\b|\bcancel\w*\b/.test(q)) return null; // notice periods and deadlines are not stored
    const monthly = /\bmonthly\b|\bper month\b|\ba month\b|\bhow much\b.*\b(?:pay|paying|cost|charge)\b|\bwhat do we pay\b|\bmonthly (?:amount|fee|cost|payment)\b|\bmonth\b/.test(q);
    if (monthly && !win && !/\bwhich\b|\bexpir\w*\b|\bend\w*\b/.test(q)) return { kind: 'contract_vendor', attr: 'monthly', rest: r0 };
    if (/\b(?:start|started|begin|began)\b/.test(q) && !win && !listCue || /\bwhen did\b.*\bstart\b|\bstart date\b/.test(q)) return { kind: 'contract_vendor', attr: 'start', rest: r0 };
    if (/\bautorenew\b/.test(q) && !win && /\b(?:which|list|all|any|every)\b/.test(q) && !/\bsoon\b|\bupcoming\b/.test(q)) return { kind: 'contract_list', mode: 'autorenewing', count: how, rest: r0 };
    if (/\bautorenew\b/.test(q)) {
      if (win && (listCue || how)) return { kind: 'contract_list', mode: 'autorenew', win, count: how, rest: rest(qw, [...VOCAB.contract, 'soon']) };
      if (!win && /\bsoon\b|\bupcoming\b/.test(q)) return { kind: 'contract_list', mode: 'autorenew', win: { n: 60, unit: 'day', text: '', implicit: true }, count: how, rest: rest(qw, [...VOCAB.contract, 'soon']) };
      if (!listCue && !how) return { kind: 'contract_vendor', attr: 'auto', rest: r0 };
      return null;
    }
    if (/\bneed\w* (?:my |our )?attention\b/.test(q) && !win && !how) return { kind: 'contract_list', mode: 'attn', rest: rest(q, [...VOCAB.contract, 'need', 'needs', 'attention']) };
    if ((listCue || how) && expiredW && !expiringW) return { kind: 'contract_list', mode: 'ended', count: how, rest: r0 };
    if ((listCue || how) && expiringW && win) return { kind: 'contract_list', mode: 'ending', win, count: how, rest: rest(qw, [...VOCAB.contract, 'soon']) };
    if (/\bwhen\b/.test(q) && /\b(?:end|ends|expire|expires|up)\b/.test(q) && !listCue) return { kind: 'contract_vendor', attr: 'end', rest: r0 };
    if (/\bwhat\b.*\b(?:cover|covers|scope|for)\b/.test(q) && !win) return { kind: 'contract_vendor', attr: 'scope', rest: r0 };
    return null;
  }

  /* ---- inspections */
  if (topic === 'insp') {
    const r0 = rest(qw, VOCAB.insp);
    const failed = /\bfail\w*\b|\bdid not pass\b/.test(q);
    if (/\bwhat (?:failed|was wrong|went wrong|did (?:it|they) fail)\b/.test(q)) return { kind: 'insp_defs', rest: r0 };
    const strictList = /\b(?:which|list|how many|any|all|every)\b/.test(q);
    if (!strictList && !win) {
      if (/\breinspect\w*\b/.test(q) && /\bwhen\b|\bwhat date\b|\bdate\b/.test(q)) return { kind: 'insp_fact', attr: 'reinspect', rest: r0 };
      if (/\bresult\b|\bhow did\b|\bpass(?:ed)?\b|\bfail(?:ed)?\b/.test(q) && !/\bdeficienc\w+\b/.test(q) && !/\bwhat (?:failed|was wrong)\b/.test(q)) return { kind: 'insp_fact', attr: 'result', rest: r0 };
      if (/\bwhen\b|\bwhat date\b|\bdate\b/.test(q) && !/\breinspect\w*\b/.test(q)) return { kind: 'insp_fact', attr: 'date', rest: r0 };
    }
    const re = /\breinspect\w*\b/.test(q);
    const defs = /\bdeficienc\w+\b|\bissues?\b|\bproblems?\b|\bviolations?\b/.test(q);
    if (re) {
      if (win && (listCue || how || /\bdue\b|\bneed\w*\b/.test(q))) return { kind: 'insp_list', mode: 'reinspect_due', win, count: how, rest: rest(qw, [...VOCAB.insp, 'soon']) };
      if (/\boverdue\b|\blate\b|\bpast due\b/.test(q)) return { kind: 'insp_list', mode: 'reinspect_overdue', count: how, rest: r0 };
      if (listCue || how || /\bneed\w*\b/.test(q)) { if (win) return null; return { kind: 'insp_list', mode: 'reinspect', count: how, rest: r0 }; }
      return null;
    }
    if (failed && (listCue || how) && !win) return { kind: 'insp_list', mode: 'failed', count: how, rest: r0 };
    if (defs && !win && !how) return { kind: 'insp_defs', rest: r0 };
    return null;
  }

  /* ---- invoices */
  if (topic === 'inv') {
    const r0 = rest(qw, VOCAB.inv);
    if (win) return null;
    const unpaid = /\bunpaid\b|\boutstanding\b|\bowe\b|\bowed\b|\bpayable\b|\bnot paid\b/.test(q);
    const overdue = /\boverdue\b|\bpast due\b|\blate\b/.test(q);
    const paid = /\bpaid\b/.test(q.replace(/\bunpaid\b/g, ' '));
    const idLike = rawHasId(raw);
    if (idLike && !how && !/\bwhich invoices\b|\blist\b|\ball\b|\bevery\b/.test(q)) {
      const cues = [['status', /\bstatus\b|\bpaid\b|\bunpaid\b|\boverdue\b/], ['amount', /\bamount\b|\btotal\b|\bhow much\b|\bcost\b|\bcharge\w*\b/], ['due', /\bdue\b/], ['prop', /\bwhich (?:property|unit|building)\b|\bwhere\b|\bwhat (?:property|unit)\b/], ['work', /\bwhat (?:was|is) (?:it|that|the invoice|invoice)\b.*\bfor\b|\bwhat for\b|\bwhat work\b|\bwhat did\b|\bwhat does\b.*\bcover\b/], ['vendor', /\bwho (?:sent|is|was|billed|issued)\b|\bwhich vendor\b|\bfrom whom\b|\bwho\b/], ['date', /\binvoice date\b|\bwhen was\b|\bdated\b/]];
      const hit = cues.filter(([, re]) => re.test(q)).map(([a]) => a);
      const a = hit.length === 1 ? hit[0] : hit.length === 2 && hit.includes('due') && hit.includes('status') ? 'due' : null;
      if (a) return { kind: 'inv_fact', attr: a, rest: rest(qw, [...VOCAB.inv, 'due', 'date', 'dated', 'when', 'where', 'work', 'cover', 'charged', 'charge', 'sent', 'issued', 'billed']) };
      return null;
    }
    if (paid) return null;
    if (/\bspent\b|\bspend\w*\b|\btotal\b|\bhow much\b|\bsum\b/.test(q) && !unpaid && !overdue) return { kind: 'inv_total', rest: r0 };
    if (unpaid && !overdue && /\bhow much\b|\btotal\b|\bsum\b/.test(q)) return { kind: 'inv_total', mode: 'unpaid', rest: r0 };
    if (overdue || unpaid) {
      if (overdue && unpaid) return null;
      if (/\bhow much\b|\btotal\b/.test(q)) return null;
      return { kind: 'inv_list', mode: overdue ? 'overdue' : 'unpaid', count: how, rest: r0 };
    }
    if ((listCue || how || /^(?:invoices?|bills?)\b/.test(q)) && !/\bhow much\b/.test(q)) return { kind: 'inv_list', mode: 'all', count: how, rest: r0 };
    return null;
  }
  return null;
}

export function classifyProperty(question, opts = {}) {
  const i = classifyInner(question, opts);
  return i ? { ...i, raw: String(question ?? '') } : null;
}

/* ------------------------------------------------------------------ run */
function clarifyEnv(options, label) {
  const places = [...new Set(options)].filter(Boolean).slice(0, 6);
  return answerEnvelope({ text: `More than one ${label} matches that. Which one do you mean: ${places.join('; ')}?`, facts: [], extra: { clarify: true, clarifyOptions: places } });
}

/** Names from this organization's own records (vendors, properties, tenants) found in the question, replaced by a neutral word so that a status word inside a name ("Open Door Locks", "Late Night Locksmith") is never read as an intent cue. */
function maskEntities(raw, docs) {
  const names = new Set();
  for (const d of docs) for (const k of ['vendor', 'tenant_name', 'property_name']) for (const x of d.all[k] ?? []) for (const part of String(x.value).split(/\s+(?:and|&)\s+|,\s*/i)) { const n = norm(part); if (n) names.add(n); }
  const phr = new Set();
  for (const n of names) {
    const toks = n.split(' ');
    phr.add(n);
    const core = toks.filter((t, i) => !(CORP.has(t) || (i === toks.length - 1 && (t === 'service' || t === 'services'))));
    if (core.length) phr.add(core.join(' '));
    for (let l = 2; l < core.length; l++) phr.add(core.slice(0, l).join(' '));
  }
  let q = norm(raw); let hit = false;
  for (const ph of [...phr].filter((x) => x.length >= 3).sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(?<![a-z0-9])${ph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`, 'g');
    if (re.test(q) && LANE_WORDS_IN(ph)) { q = q.replace(re, ' entityx '); hit = true; }
  }
  return hit ? q.replace(/\s+/g, ' ').trim() : null;
}
// masking is only needed when a name contains one of the lane's own words; other names cannot change the reading
const LANE_WORDS_IN = (ph) => ph.split(' ').some((w) => LANE_WORDS.has(w));
/** A count is never a bare total when some documents on file could not be classified at all: they would be missing from it. */
export async function runProperty(db, intent, opts = {}) {
  const meta = {};
  const env = await runPropertyInner(db, intent, opts, meta);
  const isInv = /^inv_/.test(String(intent?.kind)) || (intent?.kind === 'count_type' && intent.type === 'invoice');
  if (env && !env.clarify && !env.decline && meta.untyped?.length && isInv) {
    const un = meta.untyped;
    env.text = `${env.text} This only counts invoices that were read into your records; ${plural(un.length, 'other document')} on file ${un.length === 1 ? 'is' : 'are'} not typed and may include invoices (${un.slice(0, 5).map((d) => d.filename).join(', ')}).`;
    env.facts = [...(env.facts ?? []), ...un.slice(0, 10).map((d) => ({ label: `${d.filename} · not typed`, value: 'check the document', sources: [{ documentId: d.id, location: { field: 'document_type', page: 1 } }] }))];
  } else if (env && !env.clarify && !env.decline && meta.untyped?.length && (intent?.count || intent?.kind === 'count_type')) {
    const un = meta.untyped;
    env.text = `${env.text} ${plural(un.length, 'other document')} on file could not be read or classified (${un.slice(0, 5).map((d) => d.filename).join(', ')}), so ${un.length === 1 ? 'it is' : 'they are'} not in this count.`;
    env.facts = [...(env.facts ?? []), ...un.slice(0, 10).map((d) => ({ label: `${d.filename} · not readable`, value: 'check the document', sources: [{ documentId: d.id, location: { field: 'document_type', page: 1 } }] }))];
  }
  return env;
}
async function runPropertyInner(db, intent0, { today } = {}, meta = {}) {
  let intent = intent0;
  if (!intent) return null;
  if (intent.kind === 'decline') return answerEnvelope({ text: DECLINE[intent.which], facts: [], extra: { decline: true, declineKind: intent.which } });
  const docs = await loadDocs(db);
  meta.untyped = docs.filter((d) => !d.type || /^(?:other|unknown|unclassified)$/.test(d.type));
  const t0 = today && okIso(today) ? today : null;
  // entity names first: the question is read again with this organization's names masked out, so a status word inside a name never sets the mode
  const maskedQ = maskEntities(intent.raw ?? '', docs);
  if (maskedQ) { const i2 = classifyInner(maskedQ, { today }); if (!i2 || i2.kind === 'decline') return null; intent = { ...i2, raw: intent.raw }; }
  const M = placeModel(docs);
  const R = resolve(docs, M, intent.raw ?? '', prep(intent.raw ?? ''), t0);
  if (maskedQ) { if (!(R.vendors.size || R.props.size || R.units.size || R.tenantKeys?.size || R.woNums?.size || R.invNos?.size)) return null; R.tokens.add('entityx'); }
  const ctx = { docs, M, R, t0, intent };
  const k0 = intent.kind;
  if (R.unknown || R.unitUnknown || R.units.size > 1) return null;
  // anything in the question we could not place (a vendor, property or word we do not know) is never guessed
  const kindToks = k0.startsWith('insp_') ? new Set(inspKindWords(inspections(docs, M))) : new Set();
  const covered = (r) => r.every((t) => CORP.has(t) || kindToks.has(t) || R.tokens.has(t) || R.tokens.has(canonTok(t)) || /^(?:unit|apt|apartment|suite)$/.test(t) || (R.units.size && [...R.units].some((u) => alnum(t) === u)));
  if (!covered(intent.rest ?? [])) return null;
  const k = intent.kind;
  // nothing of the kind this list reads has ever been filed: say so, instead of claiming "none" about documents we do not have
  const NEED = { coi_list: [['certificate-of-insurance'], 'vendor certificates of insurance'], lease_list: [['lease-agreement', 'rent-roll'], 'leases or rent rolls'], vacant_list: [['rent-roll'], 'rent rolls'], wo_list: [['work-order'], 'work orders'], contract_list: [['vendor-contract'], 'vendor contracts'], insp_list: [['inspection-report', 'move-in-inspection', 'move-out-inspection'], 'inspection reports'], inv_list: [['invoice'], 'invoices'], inv_total: [['invoice'], 'invoices'] }[k];
  if (k === 'attn_all' && !docs.some((d) => ['certificate-of-insurance', 'lease-agreement', 'rent-roll', 'vendor-contract', 'inspection-report', 'move-in-inspection', 'move-out-inspection', 'invoice', 'work-order'].includes(d.type))) return answerEnvelope({ text: 'No vendor certificates, leases, vendor contracts, inspections, invoices or work orders are on file yet, so there is nothing to check.', facts: [] });
  if (NEED && k === 'vacant_list' && intent.count && !docs.some((d) => d.type === 'rent-roll')) return answerEnvelope({ text: "There are no rent rolls on file yet, so I can't count vacant units.", facts: [] });
  if (NEED && !docs.some((d) => NEED[0].includes(d.type))) return answerEnvelope({ text: `No ${NEED[1]} are on file yet, so there is nothing to list from your records.`, facts: [] });
  if (k === 'count_type') return addUnread(runCountType(ctx), docs, [intent.type], 'document');
  if (k === 'attn_all') return runAttnAll(ctx);
  if (k.startsWith('coi_')) return /^coi_(?:list|missing)$/.test(k) ? addUnread(runCoi(ctx), docs, ['certificate-of-insurance'], 'certificate') : runCoi(ctx);
  if (k === 'lease_list' || k === 'vacant_list') return addUnread(runUnits(ctx), docs, k === 'vacant_list' ? ['rent-roll'] : ['lease-agreement', 'rent-roll'], 'lease or rent roll document');
  if (k === 'unit_fact') return runUnits(ctx);
  if (k === 'wo_list') return addUnread(runWorkOrders(ctx), docs, ['work-order'], 'work order document');
  if (k === 'contract_list') return addUnread(runContracts(ctx), docs, ['vendor-contract'], 'vendor contract document');
  if (k === 'contract_vendor') return runContracts(ctx);
  if (k === 'insp_list') return addUnread(runInspections(ctx), docs, ['inspection-report', 'move-in-inspection', 'move-out-inspection'], 'inspection document');
  if (k.startsWith('insp_')) return runInspections(ctx);
  if (k === 'wo_fact') return runWoFact(ctx);
  if (k === 'prop_addr') return runPropAddr(ctx);
  if (k === 'inv_list' || k === 'inv_total') return addUnread(runInvoices(ctx), docs, ['invoice'], 'invoice document');
  if (k.startsWith('inv_')) return runInvoices(ctx);
  return null;
}

const propLabel = (M, id) => M.groups.get(id)?.label ?? '';
const unitWhere = (M, u) => `unit ${u.unitRaw}${propLabel(M, u.prop) ? ` at ${propLabel(M, u.prop)}` : ''}`;
const scopeProp = (R, prop) => !R.props.size || R.props.has(prop);
const scopeVendor = (R, v) => !R.vendors.size || R.vendors.has(vendorKey(v ?? ''));
const scopeUnit = (R, u) => !R.units.size || R.units.has(u);

function runCountType({ docs, intent }) {
  const ds = docs.filter((d) => d.type === intent.type && (!intent.hoa || /\bhoa\b/i.test(`${f(d, 'inspection_type') ?? ''} ${d.filename}`)));
  return answerEnvelope({ text: `${ds.length} ${ds.length === 1 ? intent.noun : (intent.nouns ?? `${intent.noun}s`)} on file${intent.hoa ? ' for HOA compliance (an inspection type that says HOA)' : ''}.`, facts: ds.slice(0, 40).map((d) => ({ label: d.filename, value: intent.noun, sources: [{ documentId: d.id, location: { field: 'document_type', page: 1 } }] })) });
}

/** Documents of these types that came in with no readable values at all: lists are built without them, and the answer says so. */
function addUnread(env, docs, types, noun) {
  if (!env || env.clarify || env.decline) return env;
  const un = docs.filter((d) => types.includes(d.type) && !Object.keys(d.fields).length);
  if (!un.length) return env;
  env.text = `${env.text} ${plural(un.length, noun)} on file could not be read (${un.slice(0, 5).map((d) => d.filename).join(', ')}); check ${un.length === 1 ? 'it' : 'them'}.`;
  env.facts = [...env.facts, ...un.slice(0, 10).map((d) => ({ label: `${d.filename} · not readable`, value: 'check the document', sources: [{ documentId: d.id, location: { field: 'document_type', page: 1 } }] }))];
  env.sources = [...new Map([...(env.sources ?? []), ...un.slice(0, 10).map((d) => ({ documentId: d.id, location: { field: 'document_type', page: 1 } }))].map((x) => [x.documentId, x])).values()];
  return env;
}

/* ---- certificates ---- */
function runCoi({ docs, M, R, t0, intent }) {
  if (!t0) return null;
  const list = cois(docs);
  const k = intent.kind;
  const amb = ambiguousVendors(docs); // names that may or may not be one vendor ("Charlie's" / "Charlies"): nothing is declared expired or uninsured for them
  if (k === 'coi_missing') {
    if (R.props.size || R.units.size) return null;
    if ([...allVendors(docs).keys()].some((key) => amb.has(key) && (!R.vendors.size || R.vendors.has(key)))) return null;
    const have = new Set(list.map((c) => c.key));
    const vs = [...allVendors(docs)].filter(([key]) => !have.has(key) && (!R.vendors.size || R.vendors.has(key)));
    const srcDoc = (key) => docs.find((d) => d.fields.vendor && vendorKey(f(d, 'vendor')) === key && ['invoice', 'work-order', 'vendor-contract'].includes(d.type));
    if (intent.current) {
      // no certificate at all, or the current (latest) one has expired; a vendor whose only certificates have no readable expiry is never decided
      const pool = list.filter((c) => !R.vendors.size || R.vendors.has(c.key));
      if (pool.some((c) => !c.cur)) return null;
      const exp = pool.filter((c) => c.exp < t0);
      const all = [...vs.map(([key, v]) => ({ v, none: true, key })), ...exp.map((c) => ({ v: c.vendor, c }))];
      if (R.vendors.size && !all.length && !pool.length) return null;
      const phrase = (x) => (x.none ? `${x.v} (no certificate on file)` : `${x.v} (expired ${humanDate(x.c.exp)})`);
      return answerEnvelope({ text: all.length ? `${plural(all.length, 'vendor')} ${all.length === 1 ? 'has' : 'have'} no current certificate of insurance: ${all.map(phrase).join('; ')}.` : 'None. Every vendor on file has a current certificate of insurance.', facts: all.slice(0, 40).map((x) => (x.none ? fact(`${x.v} · no certificate of insurance on file`, 'no certificate of insurance on file', srcDoc(x.key), 'vendor') : factM(`${x.v} · certificate expired`, `expired ${humanDate(x.c.exp)}`, x.c.cur, ['coi_expires', 'vendor']))) });
    }
    if (R.vendors.size && !vs.length) return null;
    return answerEnvelope({ text: vs.length ? `${plural(vs.length, 'vendor')} ${vs.length === 1 ? 'has' : 'have'} no certificate of insurance on file: ${vs.map(([, v]) => v).join(', ')}.` : 'None. Every vendor on file has a certificate of insurance.', facts: vs.slice(0, 40).map(([key, v]) => { const d = srcDoc(key); return fact(`${v} · no certificate of insurance on file`, 'no certificate of insurance on file', d, 'vendor'); }) });
  }
  if (k === 'coi_list') {
    if (R.props.size || R.units.size) return null;
    const pool = list.filter((c) => !R.vendors.size || R.vendors.has(c.key));
    if (pool.some((c) => amb.has(c.key))) return null;
    let sel; let head;
    if (intent.mode === 'expired') { sel = pool.filter((c) => c.exp && c.exp < t0); head = 'expired'; } else if (intent.mode === 'attn') { const end = windowEnd(t0, { n: 60, unit: 'day' }); sel = pool.filter((c) => c.exp && c.exp <= end); head = 'expired or expiring within 60 days'; } else if (intent.mode === 'today') { sel = pool.filter((c) => c.exp === t0); head = 'expiring today'; } else { const end = windowEnd(t0, intent.win); sel = pool.filter((c) => c.exp && c.exp >= t0 && c.exp <= end); head = `expiring within ${windowLabel(intent.win)}`; }
    sel.sort((a, b) => a.exp.localeCompare(b.exp));
    const undated = pool.filter((c) => !c.cur && c.undated.length);
    const note = undated.length ? ` ${plural(undated.length, 'vendor')} ${undated.length === 1 ? 'has' : 'have'} a certificate with no readable expiry date (${undated.map((c) => c.vendor).join(', ')}); check ${undated.length === 1 ? 'it' : 'them'}.` : '';
    const facts = sel.slice(0, 40).map((c) => factM(c.vendor, `${c.exp < t0 ? 'expired' : 'expires'} ${humanDate(c.exp)}${c.exp < t0 ? ` (${dayWord(-daysBetween(t0, c.exp))} ago)` : ` (${c.exp === t0 ? 'today' : `in ${dayWord(daysBetween(t0, c.exp))}`})`}`, c.cur, ['coi_expires', 'vendor']));
    if (undated.length) for (const c of undated.slice(0, 10)) facts.push(fact(`${c.vendor} · expiry date unreadable`, 'check the document', c.undated[0], 'vendor'));
    if (intent.count) return answerEnvelope({ text: `${plural(sel.length, 'vendor certificate')} ${head}.${note}`, facts });
    return answerEnvelope({ text: sel.length ? `${plural(sel.length, 'vendor certificate')} ${head}: ${sel.map((c) => `${c.vendor} (${humanDate(c.exp)})`).join('; ')}.${note}` : `None. No vendor certificate of insurance is ${head}.${note}`, facts });
  }
  // one vendor
  if (R.vendors.size !== 1 || R.props.size || R.units.size) return null;
  const c = list.find((x) => R.vendors.has(x.key));
  if (!c || amb.has(c.key)) return null;
  if (!c.cur) return null; // only certificates with no readable expiry: never guessed
  const live = c.exp >= t0;
  const dd = daysBetween(t0, c.exp);
  const when = live ? (dd === 0 ? 'expires today' : `expires ${humanDate(c.exp)} (in ${dayWord(dd)})`) : `expired ${humanDate(c.exp)} (${dayWord(-dd)} ago)`;
  const a = intent.attr;
  if (a === 'workers') {
    const d = c.cur; const has = (d.all.coverage_type ?? []).some((x) => /workers/i.test(x.value)) || !!f(d, 'workers_comp');
    return answerEnvelope({ text: has ? `Yes. Workers compensation is listed on ${c.vendor}'s certificate of insurance.` : `Workers compensation is not listed on ${c.vendor}'s certificate of insurance.`, facts: [factM(`${c.vendor} · coverage`, (d.all.coverage_type ?? []).map((x) => x.value).join(', ') || 'none listed', d, ['coverage_type', 'workers_comp', 'vendor'])] });
  }
  if (a === 'insurer' || a === 'limit' || a === 'policy' || a === 'coverage') {
    const d = c.cur; const key = a === 'insurer' ? 'insurer' : a === 'limit' ? 'gl_limit' : a === 'policy' ? 'policy_number' : 'coverage_type';
    const vals = (d.all[key] ?? []).map((x) => x.value); if (!vals.length) return null;
    const v = a === 'limit' ? money(vals[0]) : vals.join(', ');
    const lbl = { insurer: 'insurer', limit: 'general liability limit', policy: 'policy number', coverage: 'coverage' }[a];
    const text = a === 'insurer' ? `${c.vendor} is insured with ${v}.` : a === 'limit' ? `The general liability limit on ${c.vendor}'s certificate is ${v}.` : a === 'policy' ? `The policy number on ${c.vendor}'s certificate is ${v}.` : `${c.vendor}'s certificate shows ${v}.`;
    return answerEnvelope({ text, facts: [fact(`${c.vendor} · ${lbl}`, v, d, key)] });
  }
  const pdates = [...new Set((c.cur.all.policy_expiry ?? []).map((x) => x.value).filter(okIso))].sort();
  const spread = pdates.length > 1 ? ` Its policies expire on different dates (${pdates.map(humanDate).join('; ')}); the date above is the earliest, when coverage first lapses.` : '';
  const text = (intent.attr === 'when'
    ? `${c.vendor}'s certificate of insurance ${when}.`
    : live ? `Yes. ${c.vendor}'s certificate of insurance is current; it ${when}.` : `No. ${c.vendor}'s certificate of insurance ${when}.`) + spread;
  return answerEnvelope({ text, facts: [factM(`${c.vendor} · certificate expires`, humanDate(c.exp), c.cur, ['coi_expires', 'vendor'])] });
}

/* ---- units, leases, rent roll ---- */
function runUnits({ docs, M, R, t0, intent }) {
  const recs = unitModel(docs, M);
  const units = currentUnits(recs, t0);
  const k = intent.kind;
  const rollSrc = (r) => [{ documentId: r.d.id, location: { field: 'rent_roll_row', page: r.page() } }];
  const curSrc = (u, keys) => (u.cur.src === 'roll' ? rollSrc(u.cur) : [...new Set(keys)].filter((k) => u.cur.d.fields[k]).map((k) => src(u.cur.d, k)));
  const fct = (u, key, label, value) => ({ label, value, sources: curSrc(u, [key, 'tenant_name', 'unit_number']) });
  if (k === 'unit_fact') {
    if (R.tenantKeys.size > 1 || (R.tenantKeys.size === 1 && R.units.size > 1)) return null;
    let cand;
    if (R.tenantKeys.size === 1) { cand = units.filter((u) => R.tenantKeys.has(u.key)); if (R.units.size === 1 && cand.some((u) => !R.units.has(u.unit))) return null; }
    else { if (R.units.size !== 1) return null; const u0 = [...R.units][0]; cand = units.filter((u) => u.unit === u0 && scopeProp(R, u.prop)); }
    if (!cand.length) return null;
    if (cand.length > 1) return clarifyEnv(cand.map((u) => propLabel(M, u.prop) || 'an unnamed property'), `unit ${cand[0].unitRaw}`);
    const u = cand[0];
    const where = unitWhere(M, u);
    const a = intent.attr;
    // a lease that has not started yet: it can tell when it starts / ends, never who lives there, the rent or the deposit
    const futN = R.tenantFut?.get(u.key) ?? [];
    if ((futN.length && !R.tenantCur?.has(u.key)) || u.futureOnly) {
      const L = futN.length ? (futN.length === 1 ? futN[0] : null) : (u.future.length === 1 ? u.future[0] : null);
      if (!L || (a !== 'start' && a !== 'end') || !t0) return null;
      const v = a === 'start' ? L.start : L.end; if (!okIso(v) || v <= t0 && a === 'start') return null;
      if (a === 'end' && L.mtm) return null;
      return answerEnvelope({ text: `${L.tenant ? `${L.tenant}'s lease` : 'The lease'} for ${where} ${v > t0 ? (a === 'start' ? 'starts' : 'ends') : 'ended'} ${humanDate(v)}; that lease is not in effect yet.`, facts: [{ label: `${where} · lease ${a} (future lease)`, value: humanDate(v), sources: [src(L.d, a === 'start' ? 'lease_start_date' : 'lease_end_date')] }] });
    }
    if (a === 'start' && u.future.length) return null; // the current lease or the coming one?
    if (u.terminated) return null; // terminated / notice to vacate / move-out date: not a running lease, the normal path reads it
    if ((a === 'rent' || a === 'deposit') ? (u.conflictRent || u.conflictEnd || u.conflictTenant) : a === 'tenant' ? u.conflictTenant : u.conflictEnd || u.conflictTenant) return null;
    if (a === 'mtm') {
      if (u.vacant || !u.cur) return null;
      const known = u.mtm || okIso(u.end); if (!known) return null;
      return answerEnvelope({ text: u.mtm ? `Yes. ${u.tenant ? `${u.tenant}'s` : `The`} lease for ${where} is month-to-month.` : `No. ${u.tenant ? `${u.tenant}'s` : `The`} lease for ${where} is not month-to-month; it ${t0 && u.end < t0 ? 'ended' : 'ends'} ${humanDate(u.end)}.`, facts: [fct(u, u.mtm ? 'status' : 'lease_end_date', `${where} · ${u.mtm ? 'status' : 'lease end'}`, u.mtm ? u.status : humanDate(u.end))] });
    }
    if (a === 'occupancy') {
      if (!u.roll) return null;
      const st = u.roll.status; if (!st) return null;
      if (u.conflictTenant) return null;
      return answerEnvelope({ text: `Unit ${u.unitRaw}${propLabel(M, u.prop) ? ` at ${propLabel(M, u.prop)}` : ''} is listed as ${st} on the rent roll${u.tenant && !u.vacant ? `; the tenant is ${u.tenant}` : ''}.`, facts: [{ label: `${where} · status`, value: st, sources: [{ documentId: u.roll.d.id, location: { field: 'rent_roll_row', page: u.roll.page() } }] }] });
    }
    if (a === 'tenant') {
      if (u.vacant) return answerEnvelope({ text: `Unit ${u.unitRaw}${propLabel(M, u.prop) ? ` at ${propLabel(M, u.prop)}` : ''} is vacant on the rent roll.`, facts: [{ label: `${where} · status`, value: 'Vacant', sources: [{ documentId: u.roll.d.id, location: { field: 'rent_roll_row', page: u.roll.page() } }] }] });
      if (!u.tenant) return null;
      if (u.lease && u.roll?.tenant && !sameName(u.lease.tenant, u.roll.tenant)) return null; // lease and rent roll name different people
      const ended = !u.mtm && okIso(u.end) && t0 && u.end < t0;
      if (ended && !u.roll) return answerEnvelope({ text: `${u.tenant} is the tenant on the latest lease on file for ${where}; that lease ended ${humanDate(u.end)}.`, facts: [fct(u, 'tenant_name', `${where} · tenant`, u.tenant)] });
      return answerEnvelope({ text: `${u.tenant} is the tenant of ${where}${u.mtm ? ' (month-to-month)' : ended ? `; the lease on file ended ${humanDate(u.end)}` : okIso(u.end) ? ` (lease through ${humanDate(u.end)}${u.renewal ? `; a renewal starting ${humanDate(u.renewal.start)} is on file` : u.newLease ? `; a new lease for ${u.newLease.tenant} starts ${humanDate(u.newLease.start)}` : ''})` : ''}.`, facts: [fct(u, 'tenant_name', `${where} · tenant`, u.tenant)] });
    }
    const endedLease = !u.mtm && okIso(u.end) && t0 && u.end < t0 && u.cur.src === 'lease' && !u.renewal;
    if (a === 'rent') { if (num(u.rent) == null) return null; if (endedLease) return answerEnvelope({ text: `The lease for ${where} ended ${humanDate(u.end)}; the rent on that lease was ${money(u.rent)} a month.`, facts: [fct(u, 'rent_amount', `${where} · rent (as of the lease that ended ${humanDate(u.end)})`, money(u.rent))] }); return answerEnvelope({ text: `Rent for ${where} is ${money(u.rent)} a month${u.vacant ? ' (listed rent; the unit is vacant)' : ''}.`, facts: [fct(u, 'rent_amount', `${where} · rent`, money(u.rent))] }); }
    if (a === 'deposit') { if (num(u.dep) == null) return null; if (endedLease) return answerEnvelope({ text: `The lease for ${where} ended ${humanDate(u.end)}; the security deposit on that lease was ${money(u.dep)}.`, facts: [fct(u, 'security_deposit', `${where} · security deposit (as of the lease that ended ${humanDate(u.end)})`, money(u.dep))] }); return answerEnvelope({ text: `The security deposit for ${where} is ${money(u.dep)}.`, facts: [fct(u, 'security_deposit', `${where} · security deposit`, money(u.dep))] }); }
    if (a === 'end' || a === 'start') {
      const v = a === 'end' ? u.end : u.start; if (u.mtm && a === 'end') return answerEnvelope({ text: `The lease for ${where} is month-to-month; it has no end date.`, facts: [fct(u, 'status', `${where} · status`, u.status)] });
      if (!okIso(v)) return null;
      return answerEnvelope({ text: `The lease for ${where} ${a === 'end' ? (t0 && v < t0 ? 'ended' : 'ends') : (t0 && v > t0 ? 'starts' : 'started')} ${humanDate(v)}${a === 'end' && u.renewal ? `; a renewal starting ${humanDate(u.renewal.start)} is on file` : a === 'end' && u.newLease ? `; a new lease for ${u.newLease.tenant} starts ${humanDate(u.newLease.start)}` : ''}.`, facts: [fct(u, a === 'end' ? 'lease_end_date' : 'lease_start_date', `${where} · lease ${a}`, humanDate(v))] });
    }
    return null;
  }
  if (k === 'vacant_list') {
    if (R.units.size || R.vendors.size || !t0) return null;
    const rollDocs = docs.filter((d) => d.type === 'rent-roll');
    const partialV = rollDocs.filter((d) => d.fields.rent_roll_unread && (!R.props.size || R.props.has(M.propOf(d)))); // a rent roll with unread rows is never presented as complete
    const byProp = new Map(); for (const d of rollDocs) (byProp.get(M.propOf(d)) ?? byProp.set(M.propOf(d), []).get(M.propOf(d))).push(d);
    for (const [p, ds] of byProp) if (ds.length > 1 && (!R.props.size || R.props.has(p))) return null; // two rent rolls for one property: which is current?
    if (R.props.size && ![...R.props].every((p) => byProp.has(p))) return null;
    if (units.some((u) => u.conflictVacant && scopeProp(R, u.prop))) return null; // a lease names a tenant for a unit the rent roll calls vacant: which is right?
    const vac = units.filter((u) => u.roll && u.roll.vacant && !u.lease && scopeProp(R, u.prop)).sort((a, b) => propLabel(M, a.prop).localeCompare(propLabel(M, b.prop)) || a.unitRaw.localeCompare(b.unitRaw, undefined, { numeric: true }));
    // units of a property the rent roll does not cover are unknown, never "occupied" or "none vacant"
    if (partialV.length && (intent.count || !vac.length)) return null; // rows were not read or lost their status: never "none" / a count
    const noRoll = [...new Set(units.filter((u) => u.prop && !byProp.has(u.prop) && scopeProp(R, u.prop)).map((u) => u.prop))];
    if (noRoll.length && !vac.length) return null;
    const facts = vac.slice(0, 40).map((u) => ({ label: `Unit ${u.unitRaw}${propLabel(M, u.prop) ? ` · ${propLabel(M, u.prop)}` : ''}`, value: `Vacant${num(u.rent) != null ? `, listed ${money(u.rent)}` : ''}`, sources: [{ documentId: u.roll.d.id, location: { field: 'rent_roll_row', page: u.roll.page() } }] }));
    const scope = R.props.size ? ` at ${[...R.props].map((p) => propLabel(M, p)).join(', ')}` : '';
    const noteR = noRoll.length ? ` Note: no rent roll is on file for ${noRoll.map((p) => propLabel(M, p) || 'an unnamed property').join(', ')}, so vacancies there are not covered.` : '';
    const noteV = noteR + (partialV.length ? ` Note: ${plural(partialV.length, 'rent roll')} had unit rows that could not be read (${partialV.map((d) => d.filename).join(', ')}), so vacancies there may be missing.` : '');
    for (const d of partialV.slice(0, 6)) facts.push({ label: `${d.filename} · rows not read`, value: `${d.fields.rent_roll_unread.value} unit row(s)`, sources: [{ documentId: d.id, location: { field: 'rent_roll_unread', page: d.fields.rent_roll_unread.page } }] });
    if (intent.count) return answerEnvelope({ text: `${plural(vac.length, 'vacant unit')}${scope} on the rent roll.${noteV}`, facts });
    return answerEnvelope({ text: vac.length ? `${plural(vac.length, 'vacant unit')}${scope} on the rent roll: ${vac.map((u) => `${u.unitRaw}${R.props.size ? '' : propLabel(M, u.prop) ? ` (${propLabel(M, u.prop)})` : ''}`).join(', ')}.${noteV}` : `None. No vacant units${scope} on the rent roll.${noteV}`, facts });
  }
  if (k === 'lease_list') {
    if (R.units.size || R.vendors.size || !t0) return null;
    const partial = docs.filter((d) => d.type === 'rent-roll' && d.fields.rent_roll_unread && (!R.props.size || R.props.has(M.propOf(d))));
    const pool = units.filter((u) => scopeProp(R, u.prop) && !u.vacant && !u.futureOnly && !u.terminated);
    const renewed = intent.mode === 'expiring' ? pool.filter((u) => u.renewal) : [];
    const clash = pool.filter((u) => u.conflictEnd || u.conflictTenant);
    let sel; let head; const mkv = (u) => (u.mtm ? 'month-to-month' : `${t0 && u.end < t0 ? 'ended' : 'ends'} ${humanDate(u.end)}`);
    if (intent.mode === 'mtm') { sel = pool.filter((u) => u.mtm); head = 'on file'; }
    else if (intent.mode === 'expired') { sel = pool.filter((u) => !u.mtm && okIso(u.end) && u.end < t0 && !u.future.length); head = 'expired (latest lease for the unit has ended)'; }
    else if (intent.mode === 'attn') { sel = pool.filter((u) => !u.mtm && okIso(u.end) && !u.conflictEnd && !u.renewal && !(u.future.length && u.end < t0) && Math.abs(daysBetween(t0, u.end)) <= 60); head = 'need attention'; }
    else { const end = windowEnd(t0, intent.win); sel = pool.filter((u) => !u.mtm && okIso(u.end) && u.end >= t0 && u.end <= end); head = `ending within ${windowLabel(intent.win)}`; }
    if (intent.mode !== 'attn') sel = sel.filter((u) => !clash.includes(u) && !renewed.includes(u));
    sel.sort((a, b) => (a.end ?? '').localeCompare(b.end ?? '') || a.unitRaw.localeCompare(b.unitRaw, undefined, { numeric: true }));
    const facts = sel.slice(0, 40).map((u) => ({ label: `${unitWhere(M, u)}${u.tenant ? ` · ${u.tenant}` : ''}`, value: mkv(u), sources: curSrc(u, [u.mtm ? 'status' : 'lease_end_date', 'tenant_name', 'unit_number']) }));
    const noun = intent.mode === 'mtm' ? 'month-to-month lease' : 'lease';
    const noteParts = [];
    const noEnd = intent.mode === 'expiring' || intent.mode === 'attn' || intent.mode === 'expired' ? pool.filter((u) => !u.mtm && !okIso(u.end) && !u.conflictEnd) : [];
    if (noEnd.length) { noteParts.push(`${plural(noEnd.length, 'lease')} (${noEnd.slice(0, 6).map((u) => u.unitRaw).join(', ')}) ${noEnd.length === 1 ? 'has' : 'have'} a missing or unreadable end date, so ${noEnd.length === 1 ? 'it' : 'they'} can't be checked`); for (const u of noEnd.slice(0, 6)) facts.push({ label: `${unitWhere(M, u)} · no end date`, value: 'check the document', sources: curSrc(u, ['lease_end_date', 'tenant_name', 'unit_number']) }); }
    if (renewed.length) noteParts.push(`${plural(renewed.length, 'unit')} (${renewed.slice(0, 6).map((u) => `${u.unitRaw}${propLabel(M, u.prop) ? ` at ${propLabel(M, u.prop)}` : ''}, renewal starting ${humanDate(u.renewal.start)}`).join('; ')}) ${renewed.length === 1 ? 'has' : 'have'} a renewal on file, so ${renewed.length === 1 ? 'it is' : 'they are'} not listed as ending`);
    if (clash.length) { noteParts.push(`${plural(clash.length, 'unit')} (${clash.slice(0, 6).map((u) => u.unitRaw).join(', ')}) ${clash.length === 1 ? 'has' : 'have'} records that disagree about the lease, so ${clash.length === 1 ? 'it is' : 'they are'} not listed; check ${clash.length === 1 ? 'it' : 'them'}`); for (const u of clash.slice(0, 6)) facts.push({ label: `${unitWhere(M, u)} · records disagree`, value: 'check the documents', sources: curSrc(u, ['lease_end_date', 'tenant_name', 'unit_number']) }); }
    if (partial.length) { noteParts.push(`${plural(partial.length, 'rent roll')} had unit rows that could not be read (${partial.map((d) => d.filename).join(', ')}), so units there may be missing`); for (const d of partial.slice(0, 6)) facts.push({ label: `${d.filename} · rows not read`, value: `${d.fields.rent_roll_unread.value} unit row(s)`, sources: [{ documentId: d.id, location: { field: 'rent_roll_unread', page: d.fields.rent_roll_unread.page } }] }); }
    const note = noteParts.length ? ` Note: ${noteParts.join('; ')}.` : '';
    if (intent.count) return answerEnvelope({ text: `${plural(sel.length, noun)} ${head}.${note}`, facts });
    const ul = (u) => `${u.unitRaw}${propLabel(M, u.prop) && !R.props.size ? ` (${propLabel(M, u.prop)})` : ''}${u.tenant ? ` ${u.tenant}` : ''}${u.mtm ? '' : ` ${humanDate(u.end)}`}`;
    if (intent.mode === 'attn') return answerEnvelope({ text: sel.length ? `${plural(sel.length, noun)} ${head} (within 60 days): ${sel.filter((u) => u.end >= t0).length ? `ending: ${sel.filter((u) => u.end >= t0).map(ul).join('; ')}` : ''}${sel.some((u) => u.end >= t0) && sel.some((u) => u.end < t0) ? '. ' : ''}${sel.some((u) => u.end < t0) ? `Already ended: ${sel.filter((u) => u.end < t0).map(ul).join('; ')}` : ''}.${note}` : `None. No ${noun}s ${head} within 60 days.${note}`, facts });
    return answerEnvelope({ text: sel.length ? `${plural(sel.length, noun)} ${head}: ${sel.map(ul).join('; ')}.${note}` : `None. No ${noun}s ${head}.${note}`, facts });
  }
  return null;
}

/* ---- work orders ---- */
function runWorkOrders({ docs, M, R, t0, intent }) {
  const all = workOrders(docs, M);
  const pool = all.filter((w) => scopeProp(R, w.prop) && scopeVendor(R, w.vendor) && scopeUnit(R, w.unit));
  if (R.units.size && !R.props.size) { const ps = new Set(all.filter((w) => R.units.has(w.unit)).map((w) => w.prop)); const unitProps = new Set(unitModel(docs, M).filter((r) => R.units.has(r.unit)).map((r) => r.prop)); if (new Set([...ps, ...unitProps]).size > 1) return clarifyEnv([...new Set([...ps, ...unitProps])].map((p) => propLabel(M, p) || 'an unnamed property'), `unit ${[...R.units][0]}`); }
  if (!t0 || pool.some((w) => w.state === 'other')) return null;
  if (R.vendors.size && !all.some((w) => R.vendors.has(vendorKey(w.vendor ?? '')))) return null;
  const mode = intent.mode;
  if (mode === 'all' && !R.any) return null;
  let sel; let head;
  if (mode === 'all') { sel = pool; head = 'on file'; }
  else if (mode === 'status') { sel = pool.filter((w) => statusText(w.status).toLowerCase() === intent.stat); head = `with status ${intent.stat}`; }
  else if (mode === 'open') { sel = pool.filter((w) => w.state === 'open'); head = 'open'; }
  else if (mode === 'done') { sel = pool.filter((w) => w.state === 'done'); head = 'completed or closed'; }
  else { sel = pool.filter((w) => w.state === 'open' && okIso(w.sched) && w.sched < t0); head = 'overdue (open, and the scheduled date has passed)'; }
  sel.sort((a, b) => String(a.opened ?? '').localeCompare(String(b.opened ?? '')));
  const scopeTxt = [R.props.size ? `at ${[...R.props].map((p) => propLabel(M, p)).join(', ')}` : '', R.units.size ? `for unit ${[...R.units].map((u) => pool.find((w) => w.unit === u)?.unitRaw ?? u).join(', ')}` : '', R.vendors.size ? `assigned to ${R.vendorNames.join(', ')}` : ''].filter(Boolean).join(' ');
  const facts = sel.slice(0, 40).map((w) => factM(`${w.no ?? 'Work order'}${w.unitRaw ? ` · unit ${w.unitRaw}` : ''}${propLabel(M, w.prop) ? ` · ${propLabel(M, w.prop)}` : ''}`, `${w.status ?? ''}${w.work ? ` · ${w.work}` : ''}${w.vendor ? ` · ${w.vendor}` : ''}`, w.list, ['work_order_number', 'status', 'vendor', 'unit_number', 'work_performed']));
  const noun = 'work order';
  const noProp = R.props.size ? all.filter((w) => !w.prop && scopeVendor(R, w.vendor) && scopeUnit(R, w.unit)) : [];
  const pn = noProp.length ? ` ${plural(noProp.length, 'work order')} on file ${noProp.length === 1 ? 'has' : 'have'} no property, so ${noProp.length === 1 ? 'it is' : 'they are'} not counted for a property (${noProp.slice(0, 5).map((w) => w.no ?? 'unnumbered').join(', ')}).` : '';
  if (intent.count) return answerEnvelope({ text: `${plural(sel.length, noun)} ${head}${scopeTxt ? ` ${scopeTxt}` : ''}.${pn}`, facts });
  return answerEnvelope({ text: sel.length ? `${plural(sel.length, noun)} ${head}${scopeTxt ? ` ${scopeTxt}` : ''}: ${sel.map((w) => `${w.no ?? 'work order'}${w.unitRaw ? ` (unit ${w.unitRaw})` : ''} ${w.status ?? ''}`.trim()).join('; ')}.${pn}` : `None. No ${noun}s are ${head}${scopeTxt ? ` ${scopeTxt}` : ''}.${pn}`, facts });
}

function runWoFact({ docs, M, R, intent }) {
  if (R.woNums.size !== 1) return null;
  const n = [...R.woNums][0];
  const ws = workOrders(docs, M).filter((w) => alnum(w.no).replace(/^WO/, '').replace(/^0+/, '') === n.replace(/^0+/, ''));
  const scoped = R.props.size ? ws.filter((w) => R.props.has(w.prop)) : ws;
  if (scoped.length > 1) {
    // the same number is on file at more than one property: only an identical, stated status is answered
    const where = scoped.map((w) => propLabel(M, w.prop) || 'an unnamed property');
    const sameSt = scoped.every((w) => w.state !== 'other' && w.prop && statusText(w.status).toLowerCase() === statusText(scoped[0].status).toLowerCase());
    if (intent.attr === 'status' && sameSt) return answerEnvelope({ text: `${scoped[0].no} is ${scoped[0].status} at each property where it is on file (${where.join('; ')}).`, facts: scoped.map((w) => factM(`${w.no} · ${propLabel(M, w.prop)} · status`, w.status, w.list, ['status', 'work_order_number'])) });
    return clarifyEnv(where, `property for work order ${scoped[0].no}`);
  }
  if (scoped.length !== 1) return null;
  const w = scoped[0]; if (w.state === 'other' && intent.attr !== 'who' && intent.attr !== 'opened' && intent.attr !== 'priority' && intent.attr !== 'work' && intent.attr !== 'cost' && intent.attr !== 'sched') return null;
  const a = intent.attr; const F = (label, value, keys) => factM(`${w.no} · ${label}`, value, w.list, keys);
  const tail = `${w.unitRaw ? `unit ${w.unitRaw}` : ''}`;
  void tail;
  if (a === 'who') { if (!w.vendor) return null; return answerEnvelope({ text: `${w.no} is assigned to ${w.vendor}.`, facts: [F('assigned to', w.vendor, ['vendor', 'work_order_number'])] }); }
  if (a === 'opened') { if (!okIso(w.opened)) return null; return answerEnvelope({ text: `${w.no} was opened ${humanDate(w.opened)}.`, facts: [F('opened', humanDate(w.opened), ['opened_date', 'work_order_number'])] }); }
  if (a === 'priority') { const v = f(w.d, 'priority'); if (!v) return null; return answerEnvelope({ text: `${w.no} is priority ${v}.`, facts: [F('priority', v, ['priority', 'work_order_number'])] }); }
  if (a === 'status') { if (!w.status || w.state === 'other') return null; return answerEnvelope({ text: `${w.no} is ${w.status}.`, facts: [F('status', w.status, ['status', 'work_order_number'])] }); }
  if (a === 'work') { if (!w.work) return null; return answerEnvelope({ text: `${w.no} is for: ${w.work}.`, facts: [F('work', w.work, ['work_performed', 'work_order_number'])] }); }
  if (a === 'cost') { if (num(w.cost) == null) return null; return answerEnvelope({ text: `${w.no} cost ${money(w.cost)}.`, facts: [F('cost', money(w.cost), ['cost', 'work_order_number'])] }); }
  if (a === 'done') { if (!okIso(w.completed)) return null; return answerEnvelope({ text: `${w.no} was completed ${humanDate(w.completed)}.`, facts: [F('completed', humanDate(w.completed), ['completed_date', 'work_order_number'])] }); }
  if (a === 'sched') { if (!okIso(w.sched)) return null; return answerEnvelope({ text: `${w.no} is scheduled for ${humanDate(w.sched)}.`, facts: [F('scheduled', humanDate(w.sched), ['service_date', 'work_order_number'])] }); }
  return null;
}
function runPropAddr({ M, R }) {
  if (R.props.size !== 1 || R.units.size || R.vendors.size) return null;
  const g = M.groups.get([...R.props][0]); if (!g?.both || !g.name || !g.addr) return null;
  let full = String(f(g.both, 'service_address')).trim();
  const docsUsed = [g.both];
  if (!full.includes(',') && g.cityRaw) { full = `${full}, ${g.cityRaw}`; if (g.cityDoc !== g.both) docsUsed.push(g.cityDoc); }
  return answerEnvelope({ text: `${g.name} is at ${full}.`, facts: [factM(`${g.name} · address`, full, docsUsed, ['service_address', 'property_name'])] });
}

/* ---- vendor contracts ---- */
function runContracts({ docs, M, R, t0, intent }) {
  const all = contracts(docs, M);
  const k = intent.kind;
  if (k === 'contract_vendor') {
    if (R.vendors.size !== 1 || R.props.size || R.units.size) return null;
    const cs = all.filter((c) => R.vendors.has(c.vk));
    if (!cs.length) return null;
    const a = intent.attr;
    const facts = []; const lines = [];
    for (const c of cs) {
      if (a === 'monthly') { if (c.monthly == null) return null; lines.push(`${money(c.monthly)} a month${c.scope && cs.length > 1 ? ` (${c.scope})` : ''}`); facts.push(factM(`${c.vendor} contract · monthly amount`, money(c.monthly), c.d, ['monthly_amount', 'vendor'])); }
      else if (a === 'end') { if (!okIso(c.end)) return null; lines.push(`${t0 && c.end < t0 ? 'ended' : /^(?:yes|y|true)/.test(c.auto ?? '') ? 'current term ends' : 'ends'} ${humanDate(c.end)}${/^(?:yes|y|true)/.test(c.auto ?? '') && !(t0 && c.end < t0) ? '; it auto-renews' : ''}`); facts.push(factM(`${c.vendor} contract · end date`, humanDate(c.end), c.d, ['contract_end', 'vendor'])); }
      else if (a === 'start') { if (!okIso(c.start)) return null; lines.push(`started ${humanDate(c.start)}`); facts.push(factM(`${c.vendor} contract · start date`, humanDate(c.start), c.d, ['contract_start', 'vendor'])); }
      else if (a === 'auto') { if (!c.auto) return null; lines.push(/^(?:yes|y|true)/.test(c.auto) ? 'automatically renews' : 'does not automatically renew'); facts.push(factM(`${c.vendor} contract · auto-renew`, c.auto, c.d, ['auto_renew', 'vendor'])); }
      else if (a === 'scope') { if (!c.scope) return null; lines.push(c.scope); facts.push(factM(`${c.vendor} contract · scope`, c.scope, c.d, ['contract_scope', 'vendor'])); }
    }
    const name = cs[0].vendor;
    const text = a === 'start' ? `The ${name} contract ${lines.join('; ')}.` : a === 'monthly' ? `The ${name} contract is ${lines.join('; ')}.` : a === 'end' ? `The ${name} contract ${lines.join('; ')}.` : a === 'auto' ? `The ${name} contract ${lines.join('; ')}.` : `The ${name} contract covers: ${lines.join('; ')}.`;
    return answerEnvelope({ text, facts });
  }
  if (!t0 || R.units.size || R.vendors.size && false) return null;
  const pool = all.filter((c) => scopeProp(R, c.prop) && scopeVendor(R, c.vendor));
  if (R.props.size && pool.some((c) => !c.prop)) return null;
  const noEnd = pool.filter((c) => !okIso(c.end));
  const mode = intent.mode; let sel; let head;
  if (mode === 'autorenewing') { if (pool.some((c) => !c.auto)) return null; sel = pool.filter((c) => /^(?:yes|y|true)/.test(c.auto)); head = agree(sel.length, 'renew automatically'); sel.sort((a, b) => String(a.end ?? '').localeCompare(String(b.end ?? ''))); const fs0 = sel.slice(0, 40).map((c) => factM(`${c.vendor}${c.scope ? ` · ${c.scope}` : ''}`, `auto-renew yes${okIso(c.end) ? ` · ends ${humanDate(c.end)}` : ''}`, c.d, ['auto_renew', 'contract_end', 'vendor'])); return answerEnvelope({ text: intent.count ? `${plural(sel.length, 'vendor contract')} ${head}.` : sel.length ? `${plural(sel.length, 'vendor contract')} ${head}: ${sel.map((c) => `${c.vendor}${okIso(c.end) ? ` (${humanDate(c.end)})` : ''}`).join('; ')}.` : `None. No vendor contracts ${head}.`, facts: fs0 }); }
  if (mode === 'ended') { sel = pool.filter((c) => okIso(c.end) && c.end < t0); head = 'ended'; }
  else if (mode === 'attn') { sel = pool.filter((c) => okIso(c.end) && Math.abs(daysBetween(t0, c.end)) <= 60); head = 'need attention'; }
  else { const end = windowEnd(t0, intent.win); const inWin = pool.filter((c) => okIso(c.end) && c.end >= t0 && c.end <= end); sel = mode === 'autorenew' ? inWin.filter((c) => /^(?:yes|y|true)/.test(c.auto ?? '')) : inWin; head = mode === 'autorenew' ? `ending and renewing automatically within ${windowLabel(intent.win)}` : `ending within ${windowLabel(intent.win)}`; if (mode === 'autorenew' && inWin.some((c) => !c.auto)) return null; }
  sel.sort((a, b) => a.end.localeCompare(b.end));
  const note = noEnd.length ? ` ${plural(noEnd.length, 'contract')} on file ${noEnd.length === 1 ? 'has' : 'have'} no end date, so ${noEnd.length === 1 ? 'it' : 'they'} can't be checked.` : '';
  const facts = sel.slice(0, 40).map((c) => factM(`${c.vendor}${c.scope ? ` · ${c.scope}` : ''}`, `${c.end < t0 ? 'ended' : 'ends'} ${humanDate(c.end)}${c.auto ? ` · auto-renew ${/^(?:yes|y|true)/.test(c.auto) ? 'yes' : 'no'}` : ''}${c.monthly != null ? ` · ${money(c.monthly)} a month` : ''}`, c.d, ['contract_end', 'vendor', 'auto_renew', 'monthly_amount']));
  if (intent.count) return answerEnvelope({ text: `${plural(sel.length, 'vendor contract')} ${head}.${note}`, facts });
  if (mode === 'attn') { const up = sel.filter((c) => c.end >= t0); const gone = sel.filter((c) => c.end < t0); const cl = (c) => `${c.vendor} (${humanDate(c.end)}${/^(?:yes|y|true)/.test(c.auto ?? '') && c.end >= t0 ? '; auto-renews, so it continues unless cancelled' : ''})`; return answerEnvelope({ text: sel.length ? `${plural(sel.length, 'vendor contract')} ${head} (within 60 days): ${up.length ? `ending: ${up.map(cl).join('; ')}` : ''}${up.length && gone.length ? '. ' : ''}${gone.length ? `Already ended: ${gone.map(cl).join('; ')}` : ''}.${note}` : `None. No vendor contracts ${head} within 60 days.${note}`, facts }); }
  return answerEnvelope({ text: sel.length ? `${plural(sel.length, 'vendor contract')} ${head}: ${sel.map((c) => `${c.vendor} (${humanDate(c.end)}${/^(?:yes|y|true)/.test(c.auto ?? '') && c.end >= t0 ? '; auto-renews, so it continues unless cancelled' : ''})`).join('; ')}.${note}` : `None. No vendor contracts ${head}.${note}`, facts });
}

/* ---- inspections ---- */
const inspKindWords = (all) => [...new Set(all.flatMap((i) => String(i.kind).toLowerCase().split(/[^a-z0-9]+/)).filter((t) => t.length >= 3 && !/^(?:inspections?|move|hoa)$/.test(t) && !VOCAB.insp.includes(t) && !STOP.has(t)))];
function runInspections({ docs, M, R, t0, intent }) {
  const all = inspections(docs, M);
  const props = M.groups;
  // the kind of inspection named in the question is one of THIS organization's own kinds (never a fixed list); two different kinds, or a kind word it does not have, is not guessed
  const qn = prep(intent.raw);
  const kindsHit = inspKindWords(all).filter((t) => wordIn(qn, t));
  const kw = /\bmove in\b/.test(qn) ? 'move-in' : /\bmove out\b/.test(qn) ? 'move-out' : kindsHit.length === 1 ? kindsHit[0] : null;
  if (kindsHit.length > 1 && !/\bmove (?:in|out)\b/.test(qn)) return null;
  const hoaQ = /\bhoa\b/.test(qn);
  const pool = all.filter((i) => scopeProp(R, i.prop) && scopeUnit(R, i.unit) && (!kw || i.kind.split(/[^a-z0-9]+/).includes(kw) || (kw.includes('-') && i.kind.includes(kw))) && (!hoaQ || /\bhoa\b/i.test(`${i.kind} ${i.d.filename}`)));
  if (R.vendors.size) return null;
  if (R.units.size && !R.props.size) { const ps = new Set(all.filter((i) => R.units.has(i.unit)).map((i) => i.prop)); if (ps.size > 1) return clarifyEnv([...ps].map((p) => propLabel(M, p) || 'an unnamed property'), `unit ${[...R.units][0]}`); }
  const k = intent.kind;
  const scopeTxt = [R.props.size ? `at ${[...R.props].map((p) => propLabel(M, p)).join(', ')}` : '', R.units.size ? `for unit ${pool[0]?.unitRaw ?? [...R.units][0]}` : ''].filter(Boolean).join(' ');
  if (k === 'insp_fact') {
    if (!R.props.size && !R.units.size) return null;
    if (pool.length !== 1) return null; // more than one inspection matches: never guessed
    const i = pool[0]; const a = intent.attr; const lab = inspLabel(i, props);
    if (a === 'result') { if (!i.result) return null; return answerEnvelope({ text: `The ${lab.split(' · ')[0].toLowerCase()}${i.unitRaw ? ` for unit ${i.unitRaw}` : ''}${propLabel(M, i.prop) ? ` at ${propLabel(M, i.prop)}` : ''} came back ${i.result}${okIso(i.date) ? ` (${humanDate(i.date)})` : ''}.`, facts: [factM(`${lab} · result`, i.result, i.d, ['inspection_result', 'service_date'])] }); }
    if (a === 'date') { if (!okIso(i.date)) return null; return answerEnvelope({ text: `The ${lab.split(' · ')[0].toLowerCase()}${i.unitRaw ? ` for unit ${i.unitRaw}` : ''}${propLabel(M, i.prop) ? ` at ${propLabel(M, i.prop)}` : ''} was done ${humanDate(i.date)}.`, facts: [factM(`${lab} · date`, humanDate(i.date), i.d, ['service_date', 'inspection_result'])] }); }
    if (!okIso(i.reinspect)) return null;
    return answerEnvelope({ text: `The reinspection for the ${lab.split(' · ')[0].toLowerCase()}${i.unitRaw ? ` for unit ${i.unitRaw}` : ''}${propLabel(M, i.prop) ? ` at ${propLabel(M, i.prop)}` : ''} ${t0 && i.reinspect < t0 ? 'was due' : 'is due'} ${humanDate(i.reinspect)}${i.cleared ? '; a later inspection is on file' : ''}.`, facts: [factM(`${lab} · reinspection due`, humanDate(i.reinspect), i.d, ['reinspection_due', 'inspection_result', 'service_date'])] });
  }
  if (k === 'insp_defs') {
    if (!R.props.size && !R.units.size) return null;
    const withDefs = pool.filter((i) => i.defs.length);
    if (!pool.length) return null;
    const facts = []; for (const i of withDefs) for (const dd of i.defs) facts.push({ label: `${inspLabel(i, props)} · deficiency`, value: dd, sources: [{ documentId: i.d.id, location: { field: 'deficiency', page: (i.d.all.deficiency ?? []).find((x) => x.value === dd)?.page ?? 1 } }] });
    // "none listed" still cites the inspection(s) it was read from
    if (!facts.length) for (const i of pool.slice(0, 10)) facts.push(factM(`${inspLabel(i, props)} · deficiencies`, 'none listed', i.d, ['inspection_result', 'service_date']));
    return answerEnvelope({ text: facts.length && withDefs.length ? `${plural(facts.length, 'deficiency', 'deficiencies')} listed ${scopeTxt}: ${facts.map((x) => `${x.value} (${x.label.split(' · ')[0].toLowerCase()})`).join('; ')}.` : `None. No deficiencies are listed on the inspections on file ${scopeTxt}.`, facts: facts.slice(0, 40) });
  }
  if (!t0) return null;
  let sel; let head; const mode = intent.mode;
  if (mode === 'failed') { if (pool.some((i) => i.failedText && i.unsure)) return null; sel = pool.filter((i) => i.failed); head = 'failed (the latest inspection of the unit)'; }
  else if (mode === 'reinspect') { sel = pool.filter((i) => i.needsRe); head = 'need a reinspection (a reinspection date is printed and no later inspection is on file)'; }
  else if (mode === 'reinspect_overdue') { sel = pool.filter((i) => i.needsRe && i.reinspect < t0); head = 'have a reinspection date that has passed with no later inspection on file'; }
  else { const end = windowEnd(t0, intent.win); sel = pool.filter((i) => i.needsRe && i.reinspect >= t0 && i.reinspect <= end); head = `have a reinspection due within ${windowLabel(intent.win)}`; }
  if (mode !== 'failed' && pool.some((i) => i.reinspect && !okIso(i.reinspect))) return null;
  head = agree(sel.length, head);
  sel.sort((a, b) => String(a.reinspect ?? a.date ?? '').localeCompare(String(b.reinspect ?? b.date ?? '')));
  const factOf = (i) => (mode === 'failed'
    ? { label: inspLabel(i, props), value: `${i.result}${okIso(i.date) ? ` · ${humanDate(i.date)}` : ''}${i.reinspect ? ` · reinspection ${humanDate(i.reinspect)}` : ''}`, sources: ['inspection_result', 'service_date', 'reinspection_due', 'deficiency'].filter((k) => i.d.fields[k]).map((k) => src(i.d, k)) }
    : { label: inspLabel(i, props), value: `reinspection ${i.reinspect < t0 ? 'was due' : 'due'} ${humanDate(i.reinspect)}${i.result ? ` · result ${i.result}` : ''}`, sources: ['reinspection_due', 'inspection_result', 'service_date'].filter((k) => i.d.fields[k]).map((k) => src(i.d, k)) });
  const facts = sel.slice(0, 40).map(factOf);
  const noResult = mode === 'failed' ? pool.filter((i) => !i.result) : [];
  const note = noResult.length ? ` ${plural(noResult.length, 'inspection')} on file ${noResult.length === 1 ? 'has' : 'have'} no readable result (${noResult.map((i) => `${i.kind}${i.unitRaw ? ` unit ${i.unitRaw}` : ''}`).join(', ')}); check ${noResult.length === 1 ? 'it' : 'them'}.` : '';
  for (const i of noResult.slice(0, 10)) facts.push({ label: `${inspLabel(i, props)} · result unreadable`, value: 'check the document', sources: [{ documentId: i.d.id, location: { field: 'service_date', page: i.d.fields.service_date?.page ?? 1 } }] });
  const noun = 'inspection';
  const line = (i) => `${i.kind === 'inspection' ? 'inspection' : `${i.kind} inspection`}${i.unitRaw ? ` unit ${i.unitRaw}` : ''}${!R.props.size && propLabel(M, i.prop) ? ` (${propLabel(M, i.prop)})` : ''}${mode === 'failed' ? '' : ` ${humanDate(i.reinspect)}`}`;
  if (intent.count) return answerEnvelope({ text: `${plural(sel.length, noun)} ${mode === 'failed' ? head : head}${scopeTxt ? ` ${scopeTxt}` : ''}.${note}`, facts });
  return answerEnvelope({ text: sel.length ? `${plural(sel.length, noun)} ${head}${scopeTxt ? ` ${scopeTxt}` : ''}: ${sel.map(line).join('; ')}.${note}` : `None. No inspections ${mode === 'failed' ? 'show a failed result as the latest for their unit' : head}${scopeTxt ? ` ${scopeTxt}` : ''}.${note}`, facts });
}

/* ---- invoices ---- */
function runInvoices({ docs, M, R, t0, intent }) {
  const all = invoices(docs, M, t0);
  if (R.units.size && !R.props.size) { const ps = new Set(all.filter((v) => R.units.has(v.unit)).map((v) => v.prop)); const up = new Set(unitModel(docs, M).filter((r) => R.units.has(r.unit)).map((r) => r.prop)); if (new Set([...ps, ...up]).size > 1) return clarifyEnv([...new Set([...ps, ...up])].map((p) => propLabel(M, p) || 'an unnamed property'), `unit ${[...R.units][0]}`); }
  const pool = all.filter((v) => scopeProp(R, v.prop) && scopeVendor(R, v.vendor) && scopeUnit(R, v.unit));
  if (R.vendors.size && !all.some((v) => R.vendors.has(vendorKey(v.vendor ?? '')))) return null;
  if (pool.some((v) => v.conflict)) return null;
  // a credit memo (negative invoice) changes what is owed and spent: totals and owed / overdue lists go to the normal path rather than silently ignoring it
  if (pool.some((v) => v.cost != null && v.cost < 0) && intent.kind !== 'inv_fact' && !(intent.kind === 'inv_list' && intent.mode === 'all')) return null;
  const k = intent.kind;
  const scopeTxt = [R.props.size ? `at ${[...R.props].map((p) => propLabel(M, p)).join(', ')}` : '', R.units.size ? `for unit ${pool[0]?.unitRaw ?? [...R.units][0]}` : '', R.vendors.size ? `from ${R.vendorNames.join(', ')}` : ''].filter(Boolean).join(' ');
  const iFact = (v) => factM(`${v.vendor ?? 'Invoice'} · ${v.no ?? 'invoice'}${v.unitRaw ? ` · unit ${v.unitRaw}` : ''}${propLabel(M, v.prop) ? ` · ${propLabel(M, v.prop)}` : ''}`, `${v.cost != null ? money(v.cost) : 'amount unreadable'}${v.status ? ` · ${v.status}` : ''}${okIso(v.due) ? ` · due ${humanDate(v.due)}` : ''}`, v.list, ['invoice_number', 'cost', 'status', 'invoice_due', 'vendor']);
  if (k === 'inv_fact') {
    if (R.invNos.size !== 1) return null;
    const v = all.find((x) => R.invNos.has(alnum(x.no)) && (!R.vendors.size || R.vendors.has(vendorKey(x.vendor ?? ''))));
    if (!v || v.conflict || all.filter((x) => alnum(x.no) === alnum(v.no)).length > 1 && !R.vendors.size) return null;
    const a = intent.attr; const nm = `invoice ${v.no}${v.vendor ? ` from ${v.vendor}` : ''}`;
    const F = (label, value, keys) => factM(`${v.vendor ?? 'Invoice'} · ${v.no} · ${label}`, value, v.list, keys);
    if (a === 'amount') { if (v.cost == null) return null; return answerEnvelope({ text: `The total on ${nm} is ${money(v.cost)}.`, facts: [F('total', money(v.cost), ['cost', 'invoice_number'])] }); }
    if (a === 'status') { if (!v.status) return null; return answerEnvelope({ text: `${nm[0].toUpperCase()}${nm.slice(1)} is marked ${v.status}${v.overdue ? ' and is past its due date' : ''}.`, facts: [F('status', v.status, ['status', 'invoice_due', 'invoice_number'])] }); }
    if (a === 'due') { if (!okIso(v.due)) return null; return answerEnvelope({ text: `${nm[0].toUpperCase()}${nm.slice(1)} is due ${humanDate(v.due)}.`, facts: [F('due date', humanDate(v.due), ['invoice_due', 'invoice_number'])] }); }
    if (a === 'date') { if (!okIso(v.date)) return null; return answerEnvelope({ text: `${nm[0].toUpperCase()}${nm.slice(1)} is dated ${humanDate(v.date)}.`, facts: [F('invoice date', humanDate(v.date), ['invoice_date', 'invoice_number'])] }); }
    if (a === 'vendor') { if (!v.vendor) return null; return answerEnvelope({ text: `Invoice ${v.no} is from ${v.vendor}.`, facts: [F('vendor', v.vendor, ['vendor', 'invoice_number'])] }); }
    if (a === 'prop') { const pl = propLabel(M, v.prop); if (!pl) return null; return answerEnvelope({ text: `Invoice ${v.no} is for ${pl}${v.unitRaw ? `, unit ${v.unitRaw}` : ''}.`, facts: [F('property', pl, ['property_name', 'service_address', 'unit_number', 'invoice_number'])] }); }
    const work = (v.d.all.work_performed ?? []).map((x) => x.value); if (!work.length) return null;
    return answerEnvelope({ text: `Invoice ${v.no}${v.vendor ? ` from ${v.vendor}` : ''} is for: ${work.join('; ')}${v.cost != null ? `; total ${money(v.cost)}` : ''}.`, facts: [F('work', work.join('; '), ['work_performed', 'invoice_number']), ...(v.cost != null ? [F('total', money(v.cost), ['cost', 'invoice_number'])] : [])] });
  }
  if (k === 'inv_total') {
    if (intent.mode === 'unpaid') {
      if (pool.some((v) => v.cls === 'other') || R.units.size) return null;
      const un = pool.filter((v) => v.cls === 'unpaid'); if (un.some((v) => v.cost == null)) return null;
      const sum = un.reduce((x, v) => x + v.cost, 0);
      return answerEnvelope({ text: `${money(sum)} across ${plural(un.length, 'unpaid invoice')}${scopeTxt ? ` ${scopeTxt}` : ''}.`, facts: un.slice(0, 40).map((v) => iFact(v)) });
    }
    if (R.units.size) return null;
    if (pool.some((v) => v.cost == null)) return null;
    if (R.props.size || R.vendors.size) {
      const sum = pool.reduce((s, v) => s + v.cost, 0);
      if (!pool.length) return null;
      return answerEnvelope({ text: `${money(sum)} across ${plural(pool.length, 'invoice')} ${scopeTxt} (a copy of the same invoice counts once).`, facts: pool.slice(0, 40).map((v) => iFact(v)) });
    }
    const by = new Map(); for (const v of pool) by.set(v.prop, (by.get(v.prop) ?? 0) + v.cost);
    if (by.has(null)) return null;
    const rows = [...by.entries()].sort((a, b) => propLabel(M, a[0]).localeCompare(propLabel(M, b[0])));
    const total = pool.reduce((s, v) => s + v.cost, 0);
    return answerEnvelope({ text: `${money(total)} invoiced in total: ${rows.map(([p, s]) => `${propLabel(M, p)} ${money(s)}`).join('; ')} (a copy of the same invoice counts once).`, facts: pool.slice(0, 40).map((v) => iFact(v)) });
  }
  if (pool.some((v) => v.cls === 'other')) return null;
  let sel; let head; const mode = intent.mode;
  if (mode === 'unpaid') { sel = pool.filter((v) => v.cls === 'unpaid'); head = 'unpaid'; }
  else if (mode === 'overdue') { if (!t0) return null; sel = pool.filter((v) => v.overdue); head = 'overdue (unpaid and past the due date printed on the invoice)'; }
  else { if (!R.any) return null; sel = pool; head = 'on file'; }
  if (mode === 'overdue' || mode === 'unpaid') sel.sort((a, b) => (okIso(a.due) ? 0 : 1) - (okIso(b.due) ? 0 : 1) || String(a.due ?? '').localeCompare(String(b.due ?? '')) || (b.cost ?? 0) - (a.cost ?? 0));
  else sel.sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')));
  const facts = sel.slice(0, 40).map((v) => iFact(v));
  const noun = 'invoice';
  const line = (v) => `${R.vendors.size ? '' : (v.vendor ?? 'invoice')} ${v.no ?? ''} ${v.cost != null ? money(v.cost) : ''}`.replace(/\s+/g, ' ').trim();
  if (intent.count) return answerEnvelope({ text: `${plural(sel.length, noun)} ${head}${scopeTxt ? ` ${scopeTxt}` : ''}.`, facts });
  return answerEnvelope({ text: sel.length ? `${plural(sel.length, noun)} ${head}${scopeTxt ? ` ${scopeTxt}` : ''}: ${sel.slice(0, 10).map(line).join('; ')}${sel.length > 10 ? `; and ${sel.length - 10} more` : ''}.` : `None. No ${noun}s ${head}${scopeTxt ? ` ${scopeTxt}` : ''}.`, facts });
}

/* ------------------------------------------------------------------ attention list */
function attentionItems(docs, today, withinDays) {
  const M = placeModel(docs);
  const items = []; const props = M.groups;
  const push = (i) => items.push(i);
  const amb = ambiguousVendors(docs);
  for (const c of cois(docs)) {
    if (!c.exp || amb.has(c.key)) continue;
    const dd = daysBetween(today, c.exp);
    if (dd <= withinDays) push({ kind: dd < 0 ? 'expired' : 'expiring', category: 'coi', label: `${c.vendor} · certificate of insurance`, date: c.exp, days: dd, documentId: c.cur.id, page: c.cur.fields.coi_expires?.page ?? 1 });
  }
  const units = currentUnits(unitModel(docs, M), today);
  for (const u of units) {
    if (u.vacant || u.futureOnly || u.terminated || u.renewal || u.mtm || !okIso(u.end) || u.conflictEnd) continue;
    if (u.future.length && u.end < today) continue; // already re-leased
    const dd = daysBetween(today, u.end);
    if (dd > withinDays || dd < -withinDays) continue;
    push({ kind: dd < 0 ? 'expired' : 'expiring', category: 'lease', label: `Lease · ${unitWhere(M, u)}${u.tenant ? ` · ${u.tenant}` : ''}`, date: u.end, days: dd, documentId: u.cur.d.id, page: u.cur.page(u.cur.src === 'roll' ? '' : 'lease_end_date') });
  }
  for (const c of contracts(docs, M)) {
    if (!okIso(c.end)) continue;
    const dd = daysBetween(today, c.end);
    if (dd > withinDays || dd < -withinDays) continue;
    push({ kind: dd < 0 ? 'expired' : 'expiring', category: 'contract', label: `${c.vendor} contract${c.scope ? ` · ${c.scope}` : ''}`, date: c.end, days: dd, documentId: c.d.id, page: c.d.fields.contract_end?.page ?? 1, note: /^(?:yes|y|true)/.test(c.auto ?? '') ? 'renews automatically' : undefined });
  }
  for (const i of inspections(docs, M)) {
    if (!i.needsRe) continue;
    const dd = daysBetween(today, i.reinspect);
    if (dd <= withinDays) push({ kind: dd < 0 ? 'overdue' : 'due', category: 'inspection', label: `Reinspection · ${inspLabel(i, props)}`, date: i.reinspect, days: dd, documentId: i.d.id, page: i.d.fields.reinspection_due?.page ?? 1 });
  }
  for (const v of invoices(docs, M, today)) {
    if (!v.overdue || v.conflict) continue;
    const dd = okIso(v.due) ? Math.min(-1, daysBetween(today, v.due)) : -1;
    push({ kind: 'overdue', category: 'invoice', label: `Invoice ${v.no ?? ''} · ${v.vendor ?? ''}${v.cost != null ? ` · ${money(v.cost)}` : ''}`.replace(/\s+/g, ' '), date: okIso(v.due) ? v.due : '', days: dd, documentId: v.d.id, page: v.d.fields.invoice_due?.page ?? v.d.fields.status?.page ?? 1 });
  }
  for (const w of workOrders(docs, M)) {
    if (w.state !== 'open' || !okIso(w.sched) || w.sched >= today) continue;
    push({ kind: 'overdue', category: 'workorder', label: `Work order ${w.no ?? ''}${w.unitRaw ? ` · unit ${w.unitRaw}` : ''}${propLabel(M, w.prop) ? ` · ${propLabel(M, w.prop)}` : ''}${w.vendor ? ` · ${w.vendor}` : ''}`.replace(/\s+/g, ' ').trim(), date: w.sched, days: daysBetween(today, w.sched), documentId: w.d.id, page: w.d.fields.service_date?.page ?? 1 });
  }
  items.sort((a, b) => (a.days < 0 ? 0 : 1) - (b.days < 0 ? 0 : 1) || (a.days < 0 ? b.days - a.days : a.days - b.days) || a.label.localeCompare(b.label));
  return items;
}
/** Past-due invoices whose payment status could not be read: not listed as overdue, but counted (a plain number, safe in JSON). */
const unreadableWorkOrders = (docs, today) => workOrders(docs, placeModel(docs)).filter((w) => w.state === 'other' && okIso(w.sched) && w.sched < today).length;
const leasesWithoutEnd = (docs, today) => { const M = placeModel(docs); return currentUnits(unitModel(docs, M), today).filter((u) => !u.vacant && !u.futureOnly && !u.terminated && !u.mtm && !okIso(u.end) && !u.conflictEnd).length; };
const unreadableInvoices = (docs, today) => invoices(docs, placeModel(docs), today).filter((v) => v.cls === 'other' && okIso(v.due) && v.due < today).length;
function runAttnAll({ docs, t0, R, intent }) {
  if (!t0 || R.any) return null;
  const withinDays = intent.win?.unit === 'day' ? intent.win.n : intent.win ? Math.round(daysBetween(t0, windowEnd(t0, intent.win))) : 60;
  const all0 = attentionItems(docs, t0, withinDays);
  const items = intent.only === 'overdue' ? all0.filter((i) => i.kind === 'overdue') : all0;
  const expiredOther = intent.only === 'overdue' ? all0.length - items.length : 0;
  const by = (c) => items.filter((i) => i.category === c).length;
  const nUnread = unreadableInvoices(docs, t0);
  const unread = nUnread ? ` Also, ${plural(nUnread, 'invoice')} past the due date ${nUnread === 1 ? 'has' : 'have'} a payment status that could not be read, so ${nUnread === 1 ? 'it is' : 'they are'} not listed here.` : '';
  const nNoEnd = leasesWithoutEnd(docs, t0); const nWo = unreadableWorkOrders(docs, t0);
  const unread2 = unread + (nWo ? ` ${plural(nWo, 'work order')} ${nWo === 1 ? 'has' : 'have'} an unreadable status and a scheduled date that has passed, so ${nWo === 1 ? 'it is' : 'they are'} not listed here.` : '') + (nNoEnd ? ` ${plural(nNoEnd, 'lease')} ${nNoEnd === 1 ? 'has' : 'have'} a missing or unreadable end date, so ${nNoEnd === 1 ? 'it' : 'they'} can't be checked for expiry.` : '');
  const when = (i) => (i.days < 0 ? `${i.kind === 'overdue' ? 'overdue' : 'expired'} ${i.date ? humanDate(i.date) : ''}${i.date ? ` (${dayWord(-i.days)} ago)` : ''}`.trim() : i.days === 0 ? `today, ${humanDate(i.date)}` : `${humanDate(i.date)} (${dayWord(i.days)})`);
  if (intent.only === 'overdue') {
    const oth = expiredOther ? ` (${plural(expiredOther, 'other item')} on the attention list ${expiredOther === 1 ? 'is' : 'are'} expired or expiring rather than overdue; ask "What needs attention?" for all of them.)` : '';
    return answerEnvelope({ text: items.length ? `${plural(items.length, 'item')} ${items.length === 1 ? 'is' : 'are'} overdue: ${[[by('workorder'), 'overdue work order', 'overdue work orders'], [by('inspection'), 'reinspection', 'reinspections'], [by('invoice'), 'overdue invoice', 'overdue invoices']].filter((x) => x[0]).map((x) => plural(x[0], x[1], x[2])).join(', ')}.${oth}${unread2}` : `None. No invoice, work order or reinspection is overdue.${oth}${unread2}`, facts: items.slice(0, 40).map((i) => ({ label: i.label, value: when(i), sources: [{ documentId: i.documentId, location: { field: ({ inspection: 'reinspection_due', invoice: 'invoice_due', workorder: 'service_date' })[i.category] ?? 'document_type', page: i.page } }] })) });
  }
  return answerEnvelope({
    text: items.length ? `${plural(items.length, 'item')} ${items.length === 1 ? 'needs' : 'need'} attention (within ${dayWord(withinDays)}): ${[[by('coi'), 'vendor certificate of insurance', 'vendor certificates of insurance'], [by('lease'), 'lease', 'leases'], [by('contract'), 'vendor contract', 'vendor contracts'], [by('inspection'), 'reinspection', 'reinspections'], [by('invoice'), 'overdue invoice', 'overdue invoices'], [by('workorder'), 'overdue work order', 'overdue work orders']].filter((x) => x[0]).map((x) => plural(x[0], x[1], x[2])).join(', ')}.${unread2}` : `None. No vendor certificate, lease, vendor contract, reinspection, invoice or work order needs attention within ${dayWord(withinDays)}.${unread2}`,
    facts: items.slice(0, 40).map((i) => ({ label: i.label, value: when(i), sources: [{ documentId: i.documentId, location: { field: ({ coi: 'coi_expires', lease: 'lease_end_date', contract: 'contract_end', inspection: 'reinspection_due', invoice: 'invoice_due', workorder: 'service_date' })[i.category], page: i.page } }] })),
  });
}
export async function propertyAttention(db, { today, withinDays = 60 } = {}) {
  if (!today) return { items: [], unreadableInvoices: 0, leasesWithoutEnd: 0, unreadableWorkOrders: 0 };
  const docs = await loadDocs(db);
  return { items: attentionItems(docs, today, withinDays), unreadableInvoices: unreadableInvoices(docs, today), leasesWithoutEnd: leasesWithoutEnd(docs, today), unreadableWorkOrders: unreadableWorkOrders(docs, today) };
}
