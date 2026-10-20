/**
 * Entity safety gate - customers with similar names or addresses are ALWAYS told apart (owner rule, 2026-10-19: "NO room for error").
 *
 *   "John Smith" / "Jon Smith" / "John Smith Jr." / "John A. Smith", two "Maria Lopez" at different addresses, "123 Main St" / "123 Main St Apt 2" /
 *   "123 Main Street", "ABC Plumbing" / "A.B.C. Plumbing LLC" / "ABC Plumbing & Heating", the same street in two cities.
 *
 * Donovan never mixes their records, answers about the wrong one, or merges them. This module is the ONE place that decides, from the question and
 * THIS organization's own customer roster, which customer a question names:
 *   - single:    exactly one customer is named (verbatim, or the only loose match, or the only candidate left once the question's own address / city / phone
 *                narrows it). Any answer is then checked against that customer (verifyAnswer) and shown with distinguishing details when look-alikes exist.
 *   - ambiguous: several customers fit (identical names; a name missing its Jr / middle initial / LLC; a punctuation variant; a street without its unit
 *                or city; a typo with a close runner-up). Donovan asks "which one?" listing address, phone and last job date of each - or hands the question
 *                to Claude (the releaseGate path) - and never guesses.
 *   - typo:      a misspelling resolves only when EXACTLY ONE customer is within 2 edits AND every other customer is at least 3 edits further away.
 *
 * Pure rules + one roster loader. No model, no network. Reads only the asking organization's rows (the tenant predicate every other read carries).
 * Kill switch: DONOVAN_ENTITY_GATE=0 (verification and the pre-lane question both off).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { damerauLevenshteinDistance } from '../integrity.js';
import { extractNamePhrase } from '../lookups/unknownName.js';
import { isNicknamePair } from '../vocab/nicknames.js';

const TENANT_SQL = "tenant_id = (current_setting('app.tenant_id', true))::uuid";
export const entityGateEnabled = (env = process.env) => env?.DONOVAN_ENTITY_GATE !== '0';
/** the "Did you mean...?" suggestions / visible closest-match note (round 2); DONOVAN_ENTITY_SUGGEST=0 keeps only the strict identity rules */
export const entitySuggestEnabled = (env = process.env) => env?.DONOVAN_ENTITY_SUGGEST !== '0';

/** Company suffix words: not part of what makes a name "different" on their own, but they ARE shown and compared verbatim. */
const COMPANY = new Set(['llc', 'inc', 'incorporated', 'co', 'corp', 'corporation', 'company', 'ltd', 'limited', 'pllc', 'pc', 'plc', 'llp', 'lp']);
/** Generation suffixes: ALWAYS distinguishing (a father and son are two customers). */
const GEN = new Set(['jr', 'sr', 'ii', 'iii', 'iv']);
const GLUE = new Set(['and', 'the', 'of']);
const STREET_SUFFIX = { street: 'st', st: 'st', avenue: 'ave', ave: 'ave', road: 'rd', rd: 'rd', drive: 'dr', dr: 'dr', lane: 'ln', ln: 'ln', court: 'ct', ct: 'ct', boulevard: 'blvd', blvd: 'blvd', way: 'way', place: 'pl', pl: 'pl', circle: 'cir', cir: 'cir', parkway: 'pkwy', pkwy: 'pkwy', highway: 'hwy', hwy: 'hwy', terrace: 'ter', ter: 'ter', trail: 'trl', trl: 'trl' };
const UNIT_WORD = { apt: 'apt', apartment: 'apt', unit: 'unit', suite: 'ste', ste: 'ste', '#': 'apt', no: 'apt', number: 'apt', bldg: 'bldg', building: 'bldg', lot: 'lot', space: 'space', spc: 'space' };

const lower = (s) => String(s ?? '').toLowerCase().replace(/[‘’´`]/g, "'");
/** a raw token of the text: letters / digits plus the dots, apostrophes, ampersands and hyphens names carry */
const RAW_TOKEN = /[a-z0-9À-ɏ][a-z0-9À-ɏ.'&-]*|#/gi;
const isInitial = (t) => /^[a-z]$/.test(t);
/** loose form of one raw token: no dots, no apostrophes, no hyphens/ampersand. 'a.b.c.' -> 'abc'; "smith's" -> 'smith' */
const looseTok = (raw) => lower(raw).replace(/'s$/, '').replace(/[.'&-]/g, '');
const rawTokens = (text) => {
  const out = [];
  const s = String(text ?? '');
  for (const m of s.matchAll(RAW_TOKEN)) {
    let raw = m[0].replace(/[.,;:!?]+$/, (x) => (x.length ? x : ''));
    out.push({ raw, loose: looseTok(raw), at: m.index });
  }
  return out.filter((t) => t.loose || t.raw === '#');
};

/** the person / business name as the roster stores it, as comparable pieces */
export function parseName(name) {
  const toks = rawTokens(String(name ?? '').replace(/,/g, ' ')).filter((t) => t.loose && !GLUE.has(t.loose));
  const loose = toks.map((t) => t.loose);
  const core = loose.filter((t) => !COMPANY.has(t) && !isInitial(t));
  const initials = loose.filter(isInitial);
  const gen = loose.filter((t) => GEN.has(t));
  const company = loose.filter((t) => COMPANY.has(t));
  // strict key: case / spacing / commas / trailing "." on Jr, Sr, Inc, a lone initial are ignored; dots INSIDE "A.B.C." are kept (a different spelling)
  const strict = String(name ?? '').toLowerCase().replace(/[‘’]/g, "'").replace(/,/g, ' ').split(/\s+/).filter(Boolean)
    .map((w) => { const bare = w.replace(/\.+$/, ''); const l = looseTok(bare); return (isInitial(l) || GEN.has(l) || COMPANY.has(l)) ? l : bare; })
    .filter((w) => !GLUE.has(w) && w !== '&').join(' ');
  return { loose, core, initials, gen, company, strict, coreKey: [...core].sort().join(' ') };
}

// ------------------------------------------------------------- addresses

/** "123 W Main Street Apt 2, Mesa, AZ 85201" -> {num, street, unit, city, zip}; street is direction + name + canonical suffix; null if no leading house number */
export function parseAddress(raw) {
  const s = lower(raw).replace(/\s+/g, ' ').trim();
  const m = /^(\d{1,6})\s+(.*)$/.exec(s);
  if (!m) return null;
  const parts = m[2].split(',').map((p) => p.trim()).filter(Boolean);
  let line = parts[0] ?? '';
  let unit = '';
  const um = /(?:^|\s)(?:(apt|apartment|unit|suite|ste|bldg|building|lot|space|spc|no|number)\.?\s*#?\s*|#\s*)([a-z0-9-]+)\s*$/.exec(line);
  if (um) { unit = `${UNIT_WORD[um[1] ?? '#'] ?? 'apt'} ${um[2]}`; line = line.slice(0, um.index).trim(); }
  let lw = line.replace(/[.']/g, '').split(' ').filter(Boolean);
  if (lw.length && STREET_SUFFIX[lw[lw.length - 1]]) lw[lw.length - 1] = STREET_SUFFIX[lw[lw.length - 1]];
  const rest = parts.slice(1);
  if (!unit && rest.length >= 2) { const rm = /^(?:(apt|apartment|unit|suite|ste|bldg|building|lot|space|spc)\.?\s*#?\s*|#\s*)([a-z0-9-]+)$/.exec(rest[0]); if (rm) { unit = `${UNIT_WORD[rm[1] ?? '#'] ?? 'apt'} ${rm[2]}`; rest.shift(); } }
  let city = ''; let zip = '';
  if (rest.length) {
    const tail = rest[rest.length - 1];
    const zm = /(\d{5})(?:-\d{4})?/.exec(tail); if (zm) zip = zm[1];
    const toks = tail.replace(/\d{5}(?:-\d{4})?/, '').trim().split(' ').filter(Boolean);
    if (toks.length && /^[a-z]{2}$/.test(toks[toks.length - 1]) && (rest.length > 1 || toks.length > 1)) toks.pop();
    city = toks.join(' ');
    if (!city && rest.length >= 2) city = rest[rest.length - 2];
  }
  return { num: m[1], street: lw.join(' '), unit, city: city.replace(/[.']/g, '').trim(), zip };
}
const unitKey = (u) => String(u ?? '').replace(/^(apt|unit|ste|bldg|lot|space)\s+/, '');

/** full address, shown to people */
export const shownAddress = (c) => String(c.address ?? '').replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------- roster

export function buildRoster(rows) {
  const list = [];
  for (const r of rows ?? []) {
    const name = String(r.name ?? '').trim();
    if (!name) continue;
    const p = parseName(name);
    if (!p.core.length && !p.company.length) continue;
    list.push({ id: r.id, number: r.customer_number ?? null, name, address: r.address ?? '', phone: r.phone ?? '', email: r.email ?? '', parsed: p, addr: parseAddress(r.address) });
  }
  const nameCount = new Map(); for (const c of list) nameCount.set(c.parsed.strict, (nameCount.get(c.parsed.strict) ?? 0) + 1);
  for (const c of list) c.sameNameCount = nameCount.get(c.parsed.strict);
  const byToken = new Map();
  for (const c of list) for (const t of new Set(c.parsed.core.length ? c.parsed.core : c.parsed.loose)) { if (!byToken.has(t)) byToken.set(t, []); byToken.get(t).push(c); }
  const byId = new Map(list.map((c) => [c.id, c]));
  const cities = new Set(list.map((c) => c.addr?.city).filter(Boolean));
  return { list, byToken, byId, cities, size: list.length };
}

const rosterCache = new Map(); // tenantKey -> {at, roster}
const ROSTER_TTL_MS = 10_000;
export function _clearRosterCache() { rosterCache.clear(); }

export async function loadRoster(db, tenantKey = '') {
  const hit = tenantKey ? rosterCache.get(tenantKey) : null;
  if (hit && Date.now() - hit.at < ROSTER_TTL_MS) return hit.roster;
  const { rows } = await db.raw(
    `SELECT id, customer_number, data->>'customer_name' AS name, data->>'service_address' AS address, data->>'phone' AS phone, data->>'email' AS email
       FROM entities
      WHERE entity_type = 'customer' AND merged_into IS NULL AND COALESCE(data->>'is_company', '') <> 'true'
        AND data->>'customer_name' IS NOT NULL AND ${TENANT_SQL}
      LIMIT 20000`, []);
  const roster = buildRoster(rows);
  if (tenantKey) rosterCache.set(tenantKey, { at: Date.now(), roster });
  return roster;
}

/** last paper date per customer (invoice date when a financial row exists, else the document's own date) - shown as "last job" */
export async function loadLastJobDates(db, ids) {
  const out = new Map();
  if (!ids?.length) return out;
  try {
    const { rows } = await db.raw(
      `SELECT l.entity_id AS id, MAX(COALESCE(f.invoice_date::date, d.created_at::date))::text AS last
         FROM document_entity_links l
         JOIN documents d ON d.id = l.document_id AND d.${TENANT_SQL}
         LEFT JOIN document_financials f ON f.document_id = d.id AND f.${TENANT_SQL}
        WHERE l.entity_id = ANY($1::uuid[]) AND l.${TENANT_SQL}
        GROUP BY l.entity_id`, [ids]);
    for (const r of rows) out.set(r.id, r.last);
  } catch { /* the table shape is optional: no date is shown rather than a wrong one */ }
  return out;
}

// ------------------------------------------------------------- name mentions

/** can this token of the question stand in for the stored token `t`? exact, or a typo (>= 4 letters both sides, <= 2 edits) when `fuzzy` */
function tokenDist(q, t) {
  if (q === t) return 0;
  if (q.length < 4 || t.length < 4) return 99;
  if (/\d/.test(q) || /\d/.test(t)) return 99;
  const d = damerauLevenshteinDistance(q, t);
  return d <= 2 ? d : 99;
}

/**
 * Find windows of the question's tokens that spell customer `c`'s core name: its core tokens appear in order (any order allowed for a "Last, First" flip when
 * `anyOrder`), with initials / company words allowed in between. Returns [{i, j, dist, verbatim, text}] (j exclusive).
 */
function windowsFor(c, qt, { fuzzy = false } = {}) {
  const K = c.parsed.core.length ? c.parsed.core : c.parsed.loose;
  const out = [];
  const startsOk = (t) => K.some((k) => (fuzzy ? tokenDist(t, k) < 99 : t === k));
  for (let i = 0; i < qt.length; i++) {
    if (!startsOk(qt[i].loose)) continue;
    const remaining = [...K];
    let j = i; let dist = 0; let ok = true; let last = i;
    while (remaining.length && j < qt.length) {
      const t = qt[j].loose;
      let idx = remaining.findIndex((k) => k === t);
      let d = 0;
      if (idx < 0 && fuzzy) { let best = 99; remaining.forEach((k, n) => { const dd = tokenDist(t, k); if (dd < best) { best = dd; idx = n; } }); d = best; if (best >= 99) idx = -1; }
      if (idx >= 0) { remaining.splice(idx, 1); dist += d; last = j; j += 1; continue; }
      if (j > i && (isInitial(t) || COMPANY.has(t) || GLUE.has(t))) { j += 1; continue; } // skippable between core tokens
      ok = false; break;
    }
    if (!ok || remaining.length) continue;
    // trailing company / initial words that belong to this spelling (e.g. "Sun Valley Auto Inc")
    let end = last + 1;
    while (end < qt.length && (COMPANY.has(qt[end].loose) || isInitial(qt[end].loose))) {
      // a following initial is only part of the name when the stored name ends with it
      if (isInitial(qt[end].loose) && !c.parsed.loose.includes(qt[end].loose)) break;
      end += 1;
    }
    // a name never matches INSIDE a longer one that adds a generation suffix ("John Smith" inside "John Smith Jr")
    const next = qt[end]?.loose; const prev = qt[i - 1]?.loose;
    const winLoose = qt.slice(i, end).map((t) => t.loose);
    if (next && GEN.has(next) && !c.parsed.gen.includes(next)) continue;
    if (prev && GEN.has(prev) && !c.parsed.gen.includes(prev)) continue;
    // a generation suffix in the window the stored name does not have is a different customer; one the stored name has but the window lacks is too
    const winGen = winLoose.filter((t) => GEN.has(t));
    if (winGen.length !== c.parsed.gen.length || winGen.some((g) => !c.parsed.gen.includes(g))) continue;
    const text = qt.slice(i, end).map((t) => t.raw).join(' ');
    const wp = parseName(text);
    out.push({ i, j: end, dist, verbatim: dist === 0 && wp.strict.replace(/'s$/, '') === c.parsed.strict, text });
  }
  return out;
}

/**
 * Names the question mentions. Returns mentions: [{i, j, text, status: 'single'|'ambiguous', targets: [customer], neighbors: [customer], typo: bool, why}]
 *  - verbatim spelling of exactly one customer  -> single (look-alikes become `neighbors`)
 *  - verbatim spelling of several (same name)   -> ambiguous
 *  - no verbatim spelling: the customers whose core name fits -> single if one, else ambiguous
 *  - nothing fits but a misspelling does        -> single only when exactly one is within 2 edits and all others are 3+ further; else ambiguous
 */
export function findNameMentions(question, roster) {
  if (!roster?.size) return [];
  const qt = rawTokens(question);
  if (!qt.length) return [];
  const cand = new Map();
  for (const t of qt) for (const c of roster.byToken.get(t.loose) ?? []) cand.set(c.id, c);
  // exact-ish windows
  let matches = [];
  for (const c of cand.values()) {
    const K = c.parsed.core.length ? c.parsed.core : c.parsed.loose;
    if (K.length < 2 && !(c.parsed.company.length && K.length === 1 && K[0].length >= 4)) continue; // a lone first / last name is not a customer mention
    for (const w of windowsFor(c, qt)) matches.push({ c, ...w });
  }
  matches = pruneContained(matches);
  const mentions = groupMatches(matches, qt, roster);
  // typo windows: only where no exact-ish mention already covers the tokens
  const typo = findTypoMentions(question, qt, roster, mentions);
  // "ABC Plumbing & Haeting": the exact name "ABC Plumbing" is only the front of the misspelt, longer "ABC Plumbing & Heating"
  const keep = mentions.filter((m) => !typo.some((t) => t.i <= m.i && t.j >= m.j && (t.j - t.i) > (m.j - m.i)));
  return [...keep, ...typo].sort((a, b) => a.i - b.i);
}

function pruneContained(matches) {
  return matches.filter((m) => !matches.some((o) => o !== m && o.c.id !== m.c.id && o.i <= m.i && o.j >= m.j && (o.j - o.i) > (m.j - m.i)));
}

function groupMatches(matches, qt, roster) {
  // group by overlapping span
  const groups = [];
  for (const m of [...matches].sort((a, b) => a.i - b.i || b.j - a.j)) {
    const g = groups.find((x) => m.i < x.j && m.j > x.i);
    if (g) { g.items.push(m); g.i = Math.min(g.i, m.i); g.j = Math.max(g.j, m.j); } else groups.push({ i: m.i, j: m.j, items: [m] });
  }
  const out = [];
  for (const g of groups) {
    const verb = g.items.filter((m) => m.verbatim);
    const targetsAll = uniqBy(g.items.map((m) => m.c), (c) => c.id);
    let targets; let why;
    if (verb.length) { targets = uniqBy(verb.map((m) => m.c), (c) => c.id); why = targets.length === 1 ? 'verbatim' : 'same-name'; }
    else { targets = targetsAll; why = targets.length === 1 ? 'only-fit' : 'loose-variants'; }
    const text = qt.slice(g.i, g.j).map((t) => t.raw).join(' ');
    out.push({ i: g.i, j: g.j, text, status: targets.length === 1 ? 'single' : 'ambiguous', targets, neighbors: [], typo: false, why });
  }
  for (const m of out) m.neighbors = lookAlikes(m.targets, roster);
  return out;
}

function findTypoMentions(question, qt, roster, exactMentions) {
  const out = [];
  const covered = new Set(); for (const m of exactMentions) for (let k = m.i; k < m.j; k++) covered.add(k);
  // a fuzzy window may overlap an exact mention only by containing it whole
  const blocked = (w) => exactMentions.some((m) => w.i < m.j && w.j > m.i && !(w.i <= m.i && w.j >= m.j && (w.j - w.i) > (m.j - m.i)));
  const seenSpan = new Set();
  // candidate customers: any whose core token is within 2 edits of some question token
  const tokenIdx = [];
  for (let i = 0; i < qt.length; i++) if (!covered.has(i) && qt[i].loose.length >= 4 && !/\d/.test(qt[i].loose)) tokenIdx.push(i);
  if (!tokenIdx.length) return out;
  const cand = new Map();
  for (const [tok, list] of roster.byToken) {
    if (tok.length < 4) continue;
    for (const i of tokenIdx) { if (Math.abs(tok.length - qt[i].loose.length) <= 2 && tokenDist(qt[i].loose, tok) < 99) { for (const c of list) cand.set(c.id, c); break; } }
  }
  const found = [];
  for (const c of cand.values()) {
    const K = c.parsed.core.length ? c.parsed.core : c.parsed.loose;
    if (K.length < 2) continue;
    for (const w of windowsFor(c, qt, { fuzzy: true })) {
      if (w.dist < 1 || w.dist > 2) continue;
      if (blocked(w)) continue;
      found.push({ c, ...w });
    }
  }
  if (!found.length) return out;
  // group by span
  const spans = [];
  for (const f of found.sort((a, b) => a.i - b.i || b.j - a.j)) {
    const s = spans.find((x) => f.i < x.j && f.j > x.i);
    if (s) { s.items.push(f); s.i = Math.min(s.i, f.i); s.j = Math.max(s.j, f.j); } else spans.push({ i: f.i, j: f.j, items: [f] });
  }
  for (const s of spans) {
    const key = `${s.i}-${s.j}`; if (seenSpan.has(key)) continue; seenSpan.add(key);
    const typed = qt.slice(s.i, s.j).map((t) => t.loose).filter((t) => !COMPANY.has(t) && !isInitial(t)).join(' ');
    // distance from what was typed to EVERY customer's core name (not just the windows found): the runner-up decides
    const scored = [];
    const typedToks = qt.slice(s.i, s.j).map((t) => t.loose);
    const typedGen = typedToks.filter((t) => GEN.has(t)); const typedInit = typedToks.filter(isInitial);
    for (const c of roster.list) {
      const ck = c.parsed.coreKey; if (!ck) continue;
      // an explicit Jr / Sr / middle initial in the question belongs to who is meant: a customer with a different one is not a candidate
      if (typedGen.length && (typedGen.length !== c.parsed.gen.length || typedGen.some((g) => !c.parsed.gen.includes(g)))) continue;
      if (typedInit.length && c.parsed.initials.length && !typedInit.every((i) => c.parsed.initials.includes(i))) continue;
      const a = [...typed.split(' ')].sort().join(' ');
      if (Math.abs(ck.length - a.length) > 5) continue;
      const d = damerauLevenshteinDistance(a, ck);
      if (d <= 6) scored.push({ c, d });
    }
    scored.sort((x, y) => x.d - y.d);
    const best = scored[0]?.d ?? 99;
    if (best < 1 || best > 2) continue;
    const near = scored.filter((x) => x.d <= best + 2 && x.d <= 4);
    const targets = uniqBy(near.map((x) => x.c), (c) => c.id);
    const text = qt.slice(s.i, s.j).map((t) => t.raw).join(' ');
    const single = targets.length === 1;
    out.push({ i: s.i, j: s.j, text, status: single ? 'single' : 'ambiguous', targets, neighbors: [], typo: true, why: single ? 'typo-unique' : 'typo-close-runner-up' });
  }
  for (const m of out) m.neighbors = lookAlikes(m.targets, roster);
  return out;
}

const uniqBy = (arr, f) => { const seen = new Set(); const o = []; for (const x of arr) { const k = f(x); if (!seen.has(k)) { seen.add(k); o.push(x); } } return o; };

/** customers that could be mistaken for any of `targets`: same / contained core name, a one-or-two-edit neighbour, or a name sharing the full set of core words */
export function lookAlikes(targets, roster, { max = 6 } = {}) {
  const ids = new Set(targets.map((t) => t.id));
  const out = new Map();
  for (const t of targets) {
    const tk = t.parsed.coreKey; if (!tk) continue;
    const tset = new Set(t.parsed.core);
    const pool = new Map();
    for (const w of t.parsed.core) for (const c of roster.byToken.get(w) ?? []) pool.set(c.id, c);
    // misspelt neighbours do not share a token: scan the roster for near names (bounded)
    if (roster.size <= 6000) for (const c of roster.list) { if (!pool.has(c.id) && c.parsed.coreKey && Math.abs(c.parsed.coreKey.length - tk.length) <= 2 && damerauLevenshteinDistance(c.parsed.coreKey, tk) <= 2) pool.set(c.id, c); }
    for (const c of pool.values()) {
      if (ids.has(c.id)) continue;
      const cset = new Set(c.parsed.core);
      const [small, big] = cset.size <= tset.size ? [cset, tset] : [tset, cset];
      const contained = small.size >= 2 && [...small].every((w) => big.has(w));
      const near = c.parsed.coreKey && damerauLevenshteinDistance(c.parsed.coreKey, tk) <= 2;
      const sameStreet = t.addr && c.addr && t.addr.num === c.addr.num && t.addr.street === c.addr.street && (parseSameNameFamily(t, c));
      if (contained || near || sameStreet) out.set(c.id, c);
    }
  }
  return [...out.values()].slice(0, max);
}
/** two customers at one house number + street are look-alikes only when their names also share a word, otherwise the address (not the name) is what confuses them - handled by the address gate */
const parseSameNameFamily = (a, b) => a.parsed.core.some((w) => b.parsed.core.includes(w));

// ------------------------------------------------------------- corroboration (the question's own address / city / phone narrows the candidates)

const digitsOf = (s) => String(s ?? '').replace(/\D/g, '');
export function narrowByQuestion(question, cands) {
  if (cands.length < 2) return cands;
  const q = lower(question);
  const qDigits = digitsOf(question);
  const qa = parseAddressFromText(question);
  const scored = cands.map((c) => {
    let hit = 0; let miss = 0;
    const ph = digitsOf(c.phone).slice(-10);
    if (ph.length >= 7 && qDigits.includes(ph.slice(-7))) hit += 2;
    if (c.email && q.includes(lower(c.email))) hit += 2;
    if (qa && c.addr) {
      if (qa.num === c.addr.num && qa.street === c.addr.street) {
        hit += 2;
        if (qa.unit) { if (unitKey(qa.unit) === unitKey(c.addr.unit)) hit += 1; else miss += 1; }
        if (qa.city) { if (qa.city === c.addr.city) hit += 1; else miss += 1; }
      } else miss += 1;
    } else if (c.addr?.city && new RegExp(`(^|[^a-z])${escapeRe(c.addr.city)}([^a-z]|$)`).test(q)) {
      hit += 1; // "Frank Ortiz in Tempe"
    }
    return { c, hit, miss };
  });
  const best = scored.filter((s) => s.hit > 0 && s.miss === 0);
  if (best.length === 1) return [best[0].c];
  const anyHit = scored.some((s) => s.hit > 0);
  if (anyHit) { const keep = scored.filter((s) => s.miss === 0).map((s) => s.c); if (keep.length && keep.length < cands.length && scored.some((s) => s.hit > 0 && s.miss === 0)) return keep; }
  return cands;
}
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** an address typed in the question: "600 Main St Apt 2, Mesa" / "600 Main Street #2 Mesa" */
export function parseAddressFromText(text, cities = null) {
  const s = String(text ?? '').replace(/\s+/g, ' ');
  const m = /\b(\d{1,6})\s+((?:[nsew]\.?\s+)?[a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*){0,3}?)\s+(st|street|ave|avenue|rd|road|dr|drive|ln|lane|ct|court|blvd|boulevard|way|pl|place|cir|circle|pkwy|parkway|hwy|highway|ter|terrace|trl|trail)\b\.?(.*)$/i.exec(s);
  if (!m) return null;
  let tail = m[4] ?? '';
  const street = `${lower(m[2]).replace(/[.']/g, '')} ${STREET_SUFFIX[lower(m[3])]}`.replace(/\s+/g, ' ').trim();
  let unit = '';
  const um = /^[\s,]*(?:(apt|apartment|unit|suite|ste|bldg|building|lot|space)\.?\s*#?\s*|#\s*)([a-z0-9-]+)/i.exec(tail);
  if (um) { unit = `${UNIT_WORD[lower(um[1] ?? '#')] ?? 'apt'} ${lower(um[2])}`; tail = tail.slice(um[0].length); }
  let city = '';
  const cm = /^[\s,]*([a-z][a-z .'-]*?)(?:[\s,]+(?:az|[a-z]{2})\b)?(?:[\s,]+\d{5}(?:-\d{4})?)?\s*[?!.]*\s*(?:please|thanks|asap|pls)?\s*[?!.]*$/i.exec(tail);
  if (cm) { const c = lower(cm[1]).replace(/[.']/g, '').replace(/\s+(please|thanks|asap|pls)$/, '').trim(); if (c && c.split(' ').length <= 3 && !/^(please|thanks|asap|pls|and|for|with)$/.test(c)) city = c; }
  if (cities && city && !cities.has(city)) { // the tail was not a city of this tenant: ignore it
    const first = [...cities].find((x) => city === x || city.startsWith(`${x} `)); city = first ?? '';
  }
  return { num: m[1], street, unit, city };
}

/** customers at the address typed in a SINGULAR identity question ("who lives at 600 Main St"), narrowed by the unit / city the question gave */
export function findAddressMention(question, roster) {
  const q = String(question ?? '');
  if (!/\b(who|whose|which\s+(customer|client)|customer|client|owner|resident|occupant|tenant|lives?|living|staying|name)\b/i.test(q)) return null;
  if (/\b(list|all|every|everyone|everybody|how many|count|each|number of|total)\b/i.test(q)) return null;
  const a = parseAddressFromText(q, roster.cities);
  if (!a) return null;
  const at = roster.list.filter((c) => c.addr && c.addr.num === a.num && c.addr.street === a.street
    && (!a.unit || unitKey(a.unit) === unitKey(c.addr.unit))
    && (!a.city || c.addr.city === a.city));
  if (!at.length) return null;
  // a house with a customer in no unit AND customers in units: "600 Main St" alone cannot say which
  return { address: a, targets: at, status: at.length === 1 ? 'single' : 'ambiguous', why: at.length === 1 ? 'address' : 'address-several', span: addressSpan(q, roster.cities) };
}

const ADDR_HEAD = /\b(\d{1,6})\s+((?:[nsew]\.?\s+)?[a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*){0,3}?)\s+(st|street|ave|avenue|rd|road|dr|drive|ln|lane|ct|court|blvd|boulevard|way|pl|place|cir|circle|pkwy|parkway|hwy|highway|ter|terrace|trl|trail)\b\.?/i;
/** [start, end) of the address as typed in the question (house number .. street suffix, unit, city / state / zip when they follow), or null */
export function addressSpan(question, cities = null) {
  const s = String(question ?? '');
  const m = ADDR_HEAD.exec(s); if (!m) return null;
  let end = m.index + m[0].length;
  const um = /^[\s,]*(?:(?:apt|apartment|unit|suite|ste|bldg|building|lot|space)\.?\s*#?\s*|#\s*)[a-z0-9-]+/i.exec(s.slice(end));
  if (um) end += um[0].length;
  for (const city of [...(cities ?? [])].sort((x, y) => y.length - x.length)) {
    const cm = new RegExp(`^[\\s,]+${escapeRe(city)}\\b(?:[\\s,]+[a-z]{2}\\b)?(?:[\\s,]+\\d{5}(?:-\\d{4})?)?`, 'i').exec(s.slice(end));
    if (cm) { end += cm[0].length; break; }
  }
  return [m.index, end];
}

/**
 * The address typed in a "who is at ..." question matches NO customer exactly, but near ones exist:
 *   - the same house number + street at another unit / in another city (unit and city are part of who: these are only ever SUGGESTED), or
 *   - the same house number with a mistyped street name (<= 2 edits, the question's own unit / city still has to agree): a street typo.
 * St / Street, Ave / Avenue ... are the same street (parseAddress canonicalises the suffix), so they never get here.
 */
export function findNearAddress(question, roster) {
  const q = String(question ?? '');
  if (!/\b(who|whose|which\s+(customer|client)|customer|client|owner|resident|occupant|tenant|lives?|living|staying|name)\b/i.test(q)) return null;
  if (/\b(list|all|every|everyone|everybody|how many|count|each|number of|total)\b/i.test(q)) return null;
  const a = parseAddressFromText(q, roster.cities);
  if (!a) return null;
  const sameHouse = roster.list.filter((c) => c.addr && c.addr.num === a.num);
  const exact = sameHouse.filter((c) => c.addr.street === a.street && (!a.unit || unitKey(a.unit) === unitKey(c.addr.unit)) && (!a.city || c.addr.city === a.city));
  if (exact.length) return null;
  const differs = sameHouse.filter((c) => c.addr.street === a.street); // exact is empty: every one of these has another unit or city
  const streetTypo = sameHouse.filter((c) => c.addr.street !== a.street && a.street.length >= 6 && damerauLevenshteinDistance(c.addr.street, a.street) <= 2
    && (!a.unit || unitKey(a.unit) === unitKey(c.addr.unit)) && (!a.city || c.addr.city === a.city));
  const cands = uniqBy([...streetTypo, ...differs], (c) => c.id);
  if (!cands.length) return null;
  return { address: a, cands, streetTypoOnly: !differs.length && streetTypo.length > 0, span: addressSpan(q, roster.cities), text: String(q).slice(...(addressSpan(q, roster.cities) ?? [0, 0])) };
}

// ------------------------------------------------------------- the analysis

/**
 * What does this question name? {mentions: [...], address: {...}|null, ambiguous: first ambiguous mention|null, singles: [customer], confusable: Set<id>}
 * A mention that is ambiguous is first narrowed by the question's own address / city / phone / email.
 */
export function analyzeQuestion(question, roster) {
  if (!roster?.size) return { mentions: [], address: null, ambiguous: null, singles: [], confusable: new Set(), nearAddress: null, nomatch: null };
  const qtoks = rawTokens(question);
  // a name the person typed IN QUOTES is "as typed" (the "None of these" tap): never auto-corrected, never shown as a closest match
  const quoted = (m) => { const a = qtoks[m.i]; const b = qtoks[m.j - 1]; if (!a || !b) return false; return /["“]/.test(question[a.at - 1] ?? '') && /["”]/.test(question[b.at + b.raw.length] ?? ''); };
  const asTyped = [];
  const mentions = findNameMentions(question, roster).filter((m) => {
    if ((m.typo || m.why === 'only-fit') && quoted(m)) { asTyped.push(m.text); return false; }
    return true;
  }).map((m) => {
    if (m.status === 'ambiguous') {
      const narrowed = narrowByQuestion(question, m.targets);
      if (narrowed.length === 1) return { ...m, status: 'single', targets: narrowed, why: `${m.why}+narrowed`, neighbors: lookAlikes(narrowed, roster) };
      if (narrowed.length < m.targets.length) return { ...m, targets: narrowed };
    }
    return m;
  });
  let address = findAddressMention(question, roster);
  // when a name mention already names who, the address only confirms it
  const named = mentions.filter((m) => m.status === 'single');
  if (address && named.length) address = null;
  const ambiguous = mentions.find((m) => m.status === 'ambiguous') ?? (address?.status === 'ambiguous' ? { ...address, text: `${address.address.num} ${address.address.street}`, kind: 'address' } : null);
  const singles = uniqBy([...named.flatMap((m) => m.targets), ...(address?.status === 'single' ? address.targets : [])], (c) => c.id);
  const confusable = new Set();
  for (const m of mentions) for (const n of m.neighbors ?? []) confusable.add(n.id);
  if (address?.status === 'single') {
    for (const t of address.targets) for (const c of roster.list) if (c.id !== t.id && c.addr && t.addr && c.addr.num === t.addr.num && c.addr.street === t.addr.street) confusable.add(c.id);
    for (const n of lookAlikes(address.targets, roster)) confusable.add(n.id); // a customer who shares a name with another is not identified by the name alone
  }
  for (const s of singles) confusable.delete(s.id);
  const lookAlikeList = [...confusable].map((id) => roster.byId.get(id)).filter(Boolean);
  // "did you mean": an address near no exact one, or a name that matches nobody but has close names on file
  const nearAddress = entitySuggestEnabled() && !mentions.length && !address ? findNearAddress(question, roster) : null;
  let nomatch = null;
  if (!mentions.length && !address && !nearAddress) {
    let phrase = asTyped[0] ?? null;
    if (!phrase) { try { phrase = extractNamePhrase(question); } catch { phrase = null; } }
    if (phrase && entitySuggestEnabled() && rawTokens(phrase).filter((t) => t.loose.length > 1).length >= 2) {   // a full name; one word ("larkin") is a surname lookup owned by the lanes
      const cands = suggestForPhrase(phrase, roster, { max: 3 }).filter((c) => !isNickPair(phrase, c));              // Tom / Thomas, Bill / William: the nickname lane owns those
      if (cands.length) nomatch = { phrase, cands, asTyped: asTyped.length > 0 };
    }
  }
  return { mentions, address, ambiguous, singles, confusable, lookAlikes: lookAlikeList, nearAddress, nomatch, asTyped };
}

/**
 * Customers whose names are CLOSE to a name phrase that matched nobody (a misspelling, a misheard name): the 1-3 closest, never more than
 * 2 edits further than the best. Pure; reads only the asking organization's roster.
 */
/** the phrase's first name and the customer's are a nickname / formal pair (Tom - Thomas): resolved by the nickname lane, not a misspelling */
function isNickPair(phrase, c) {
  const a = rawTokens(phrase).map((t) => t.loose); const b = c.parsed.core;
  try { return !!a[0] && !!b[0] && a[0] !== b[0] && isNicknamePair(a[0], b[0]); } catch { return false; }
}
export function suggestForPhrase(phrase, roster, { exclude = new Set(), max = 3 } = {}) {
  const toks = rawTokens(phrase).map((t) => t.loose).filter((t) => t && !COMPANY.has(t) && !isInitial(t) && !GLUE.has(t) && !GEN.has(t));
  if (!toks.length || !roster?.list) return [];
  const typed = [...toks].sort().join(' ');
  if (typed.length < 4) return [];
  const scored = [];
  for (const c of roster.list) {
    if (exclude.has(c.id)) continue;
    const ck = c.parsed.coreKey; if (!ck) continue;
    if (Math.abs(ck.length - typed.length) > 6) continue;
    let d = damerauLevenshteinDistance(typed, ck);
    // one word typed (a surname): close to one of the customer's words
    if (toks.length === 1 && toks[0].length >= 4) for (const w of c.parsed.core) if (w.length >= 4) d = Math.min(d, damerauLevenshteinDistance(toks[0], w) + 1);
    if (d <= Math.max(2, Math.floor(Math.max(typed.length, ck.length) * 0.3)) && d <= 5) scored.push({ c, d });
  }
  scored.sort((x, y) => x.d - y.d || x.c.name.localeCompare(y.c.name));
  if (!scored.length) return [];
  const best = scored[0].d;
  return uniqBy(scored.filter((x) => x.d <= best + 2).map((x) => x.c), (c) => c.id).slice(0, max);
}

/**
 * What to do with the analysis (pure; ask.js acts on it):
 *   clarify  - ask: "which one?" (several fit), "Did you mean...?" (2-3 close names / a dictated or mistyped name / a near address), or "no customer
 *              by that name" with the closest names. Nothing is answered until the person picks.
 *   note     - exactly one clear match (unique, large margin) that is not the name as stored: answer for that customer and SAY SO, with a one-tap
 *              "Not this customer?"
 *   none     - nothing to add
 * A dictated question (inputMode 'voice') prefers a suggestion to answering on any match that is not the name as stored.
 */
export function decideEntityResponse(analysis, roster, { inputMode = 'typed' } = {}) {
  if (!analysis) return { action: 'none' };
  const voice = inputMode === 'voice';
  const amb = analysis.ambiguous;
  if (amb) {
    const fuzzy = amb.typo === true && amb.kind !== 'address';
    return { action: 'clarify', variant: amb.kind === 'address' ? 'address' : fuzzy ? 'typo' : 'name', mention: amb, cands: fuzzy ? amb.targets.slice(0, 3) : amb.targets };
  }
  if (!entitySuggestEnabled()) return { action: 'none' };
  const closest = (analysis.mentions ?? []).find((m) => m.status === 'single' && m.targets.length === 1 && (m.typo || m.why === 'only-fit'));
  if (closest) {
    const target = closest.targets[0];
    if (voice) return { action: 'clarify', variant: 'confirm', mention: closest, cands: [target, ...suggestForPhrase(closest.text, roster, { exclude: new Set([target.id]), max: 2 })] };
    return { action: 'note', match: { kind: 'name', mention: closest, target, typed: closest.text, others: suggestForPhrase(closest.text, roster, { exclude: new Set([target.id]), max: 2 }) } };
  }
  const na = analysis.nearAddress;
  if (na) {
    if (na.streetTypoOnly && na.cands.length === 1 && !voice) return { action: 'note', match: { kind: 'address', mention: { text: na.text, span: na.span, kind: 'address' }, target: na.cands[0], typed: na.text, others: [], address: na.address } };
    return { action: 'clarify', variant: 'address-near', mention: { text: na.text, span: na.span, kind: 'address' }, cands: na.cands.slice(0, 3) };
  }
  if (analysis.nomatch) return { action: 'clarify', variant: 'nomatch', mention: { text: analysis.nomatch.phrase, phrase: analysis.nomatch.phrase }, cands: analysis.nomatch.cands, asTyped: analysis.nomatch.asTyped };
  return { action: 'none' };
}

// ------------------------------------------------------------- answers shown to people

const fmtDate = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? '')); if (!m) return null; const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m[2] - 1]; return `${mon} ${+m[3]}, ${m[1]}`; };

/** "412 W Palm Ln, Mesa, AZ 85201 - (480) 555-7210 - last job Jul 25, 2026": the distinguishing details of one customer */
export function describeCustomer(c, lastJob = null) {
  const bits = [];
  if (c.address) bits.push(shownAddress(c));
  if (c.phone) bits.push(String(c.phone));
  else if (c.email) bits.push(String(c.email));
  const d = fmtDate(lastJob); if (d) bits.push(`last job ${d}`);
  return bits.join(' · ') || 'no address or phone on file';
}

/** replace [start, end) of the question; a quote mark hugging the span goes with it ("as typed" taps) */
function replaceSpan(question, start, end, text) {
  let a = start; let b = end;
  if (/["“]/.test(question[a - 1] ?? '') && /["”]/.test(question[b] ?? '')) { a -= 1; b += 1; }
  return `${question.slice(0, a)}${text}${question.slice(b)}`.replace(/\s+/g, ' ').trim();
}
/** where the mention sits in the question: [start, end) by its tokens, or its address span, or by finding the phrase's words */
function mentionSpan(question, mention) {
  if (mention?.span) return mention.span;
  const qt = rawTokens(question);
  if (mention?.i != null && qt[mention.i] && qt[mention.j - 1]) return [qt[mention.i].at, qt[mention.j - 1].at + qt[mention.j - 1].raw.length];
  const words = rawTokens(mention?.phrase ?? mention?.text ?? '').map((t) => escapeRe(t.raw));
  if (words.length) { const m = new RegExp(words.join("['’s]*\\s+"), 'i').exec(question); if (m) return [m.index, m.index + m[0].length]; }
  return null;
}

/** the re-ask a tap on one candidate sends: the mention replaced by "Name at <street>, <city>" (or the exact stored address), so the next pass is narrowed by its own address */
function chipQuestion(question, mention, c, siblings) {
  const sp = mentionSpan(question, mention);
  if (mention?.kind === 'address' && sp && c.address) return replaceSpan(question, sp[0], sp[1], shownAddress(c));
  const where = c.addr ? `${shownAddress(c)}` : '';
  const text = where && (c.sameNameCount ?? 2) > 1 ? `${c.name} at ${where}` : c.name; // the stored name alone names ONE customer; "at <address>" only when the name is shared
  return sp ? replaceSpan(question, sp[0], sp[1], text) : `${text}`;
}

const last4 = (c) => { const d = digitsOf(c.phone); return d.length >= 4 ? d.slice(-4) : ''; };
/** what tells two chips apart at a glance: address, last 4 of the phone, last job date */
export function chipDetail(c, lastJob = null) {
  const bits = [];
  if (c.address) bits.push(shownAddress(c));
  const l4 = last4(c); if (l4) bits.push(`phone ending ${l4}`);
  const d = fmtDate(lastJob); if (d) bits.push(`last job ${d}`);
  return bits.join(' · ') || 'no address or phone on file';
}
const choiceFor = (question, mention, c, lastJobs) => ({ text: chipQuestion(question, mention, c), label: c.name, detail: chipDetail(c, lastJobs.get(c.id)) });
/** the question asked again with the name exactly as typed, in quotes: the "Not this customer?" escape */
const asTypedQuestion = (question, mention, typed) => { const sp = mentionSpan(question, mention); return sp ? replaceSpan(question, sp[0], sp[1], `"${typed}"`) : `"${typed}"`; };

/**
 * The "which one?" / "Did you mean...?" answer: names every candidate with address, phone and last job date, and carries the same candidates as
 * tappable chips (entityChoices: label + distinguishing detail; a tap re-asks the question for that customer). kind 'answer' + clarify, the same shape the
 * other ambiguity builders use. `variant`: name | typo | address | confirm | address-near | nomatch
 */
export function buildEntityClarifyAnswer(question, mention, cands, lastJobs = new Map(), variant = null) {
  const v = variant ?? (mention?.kind === 'address' ? 'address' : mention?.typo ? 'typo' : 'name');
  const shown = cands.slice(0, v === 'name' || v === 'address' ? 6 : 3);
  const asked = mention?.text ?? 'that';
  // a suggestion (a guess at who was meant) shows what tells customers apart - address, LAST 4 of the phone, last job - not the whole number
  const guess = v === 'nomatch' || v === 'confirm' || v === 'address-near';
  const lines = shown.map((c, n) => `${n + 1}) ${c.name} - ${guess ? chipDetail(c, lastJobs.get(c.id)) : describeCustomer(c, lastJobs.get(c.id))}`);
  const more = cands.length > shown.length ? ` (+${cands.length - shown.length} more)` : '';
  let head; let tail = ` Tell me the address, phone or unit and I'll answer for that one.`; let reason = 'ambiguous-entity';
  if (v === 'address') head = `More than one customer is on file at "${asked}" (${cands.length}). Which one do you mean?`;
  else if (v === 'typo') head = `I couldn't match "${asked}" to exactly one customer. Did you mean one of these?`;
  else if (v === 'confirm') { const c = shown[0]; head = `Did you mean ${c.name}? I read "${asked}".`; tail = ` Tap the right customer and I'll answer for them.`; reason = 'confirm-entity'; }
  else if (v === 'address-near') { head = `No customer is on file at exactly "${asked}". Did you mean one of these?`; tail = ` A different unit or city is a different customer, so I won't pick one for you.`; reason = 'near-address'; }
  else if (v === 'nomatch') { head = `No customer named "${asked}" was found. Did you mean ${shown.length === 1 ? 'this customer, the closest name' : 'one of these, the closest names'} on file?`; tail = ` Tap one to ask again for that customer.`; reason = 'no-match-suggest'; }
  else head = `I found ${cands.length} customers that fit "${asked}". Which one did you mean?`;
  const choices = shown.map((c) => choiceFor(question, mention, c, lastJobs));
  return {
    kind: 'answer',
    text: v === 'confirm' ? `${head} ${lines[0].replace(/^1\) /, '')}.${tail}` : `${head} ${lines.join('; ')}${more}.${tail}`,
    facts: shown.map((c) => ({ label: c.name, value: guess ? chipDetail(c, lastJobs.get(c.id)) : describeCustomer(c, lastJobs.get(c.id)), entityId: c.id, sources: [] })),
    sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
    clarify: true, clarifyReason: reason, candidateCount: cands.length,
    didYouMean: choices.map(({ text }) => ({ text })),
    entityChoices: { heading: 'Did you mean', chips: choices },
  };
}

/** the question with the mistyped address replaced by the matched customer's exact stored address (so the lanes below look up the real one) */
export function rewriteAddressForMatch(question, match) {
  const sp = match.mention?.span; const c = match.target;
  return sp && c?.address ? replaceSpan(question, sp[0], sp[1], shownAddress(c)) : question;
}

/** "Showing results for Jon Smith, 45 Oak Ave (closest match to "John Smyth")." - the visible statement of a single clear match */
export function buildMatchNote(match) {
  const c = match.target;
  return `Showing results for ${c.name}${c.address ? `, ${shownAddress(c)}` : ''} (closest match to "${match.typed}").`;
}
/** the one-tap "Not this customer?": the other close customers (if any) plus the question asked again with the name exactly as typed */
export function buildMatchChoices(question, match, lastJobs = new Map()) {
  const chips = (match.others ?? []).map((c) => choiceFor(question, match.mention, c, lastJobs));
  chips.push({ text: asTypedQuestion(question, match.mention, match.typed), label: 'None of these', detail: `ask again with "${match.typed}" exactly as typed` });
  return { heading: 'Not this customer?', chips, match: { id: match.target.id, name: match.target.name, address: match.target.address ?? '', typed: match.typed } };
}

/** the footer that tells a person WHICH customer an answer is about and which look-alikes exist */
export function buildIdentityNote(targets, neighbors, lastJobs = new Map()) {
  if (!targets.length) return '';
  const t = targets.slice(0, 2).map((c) => `${c.name} - ${describeCustomer(c, lastJobs.get(c.id))}`).join('; ');
  let s = `\n\nThat is ${t}.`;
  if (neighbors.length) {
    const n = neighbors.slice(0, 4).map((c) => `${c.name} (${c.address ? shownAddress(c) : 'no address on file'}${c.phone ? ', ' + c.phone : ''})`).join('; ');
    s += ` Also on file with a similar name: ${n}${neighbors.length > 4 ? ` (+${neighbors.length - 4} more)` : ''}. Tell me if you meant one of those.`;
  }
  return s;
}

/**
 * The note the Claude path (agent / retrieval + model) gets whenever the question names customers: WHO is meant (with address and phone) and which
 * look-alikes exist, plus the rule to answer only for the named one. Only identifying details of customers of THIS organization are included.
 */
export function buildModelEntityNote(analysis, lastJobs = new Map()) {
  if (!analysis) return '';
  const lines = [];
  const named = analysis.singles ?? [];
  if (named.length) lines.push(`The question names: ${named.slice(0, 4).map((c) => `${c.name} [${describeCustomer(c, lastJobs.get(c.id))}]`).join('; ')}.`);
  const amb = analysis.ambiguous;
  if (amb?.targets?.length) lines.push(`The name or address in the question fits SEVERAL customers: ${amb.targets.slice(0, 6).map((c) => `${c.name} [${describeCustomer(c, lastJobs.get(c.id))}]`).join('; ')}.`);
  const alike = analysis.lookAlikes ?? [];
  if (alike.length) lines.push(`Customers with a similar name or address (a different customer each, never merge them): ${alike.slice(0, 6).map((c) => `${c.name} [${describeCustomer(c, lastJobs.get(c.id))}]`).join('; ')}.`);
  if (!lines.length) return '';
  return `\n\nCUSTOMER IDENTITY (checked against this company's customer list):\n${lines.join('\n')}\nAnswer only from records of the named customer. Treat Jr / Sr / II, middle initials, a unit or suite number and the city as part of who someone is. If the question cannot be tied to exactly one customer, do not pick one: list the customers that fit with their address and phone and ask which one.`;
}

// ------------------------------------------------------------- checking an answer

function answerText(data) {
  const parts = [data?.text];
  for (const f of data?.facts ?? []) parts.push(f?.label, f?.value);
  return parts.filter((x) => typeof x === 'string').join(' \n ');
}

/**
 * Does `data` (an answer about the customers in `analysis.singles`) carry a look-alike's identity - by entity id, by name, by phone / email / address?
 * Returns {ok, conflicts: [customer]}. Look-alikes the answer names inside an explicit "similar names" note are not conflicts.
 */
export function verifyAnswer(data, analysis, roster) {
  if (!data || typeof data !== 'object' || data.kind === 'no-answer' || data.clarify) return { ok: true, conflicts: [] };
  if (!analysis?.singles?.length || !analysis.confusable?.size) return { ok: true, conflicts: [] };
  const allowed = new Set(analysis.singles.map((c) => c.id));
  const body = answerText(data);
  const main = body.split(/\balso on file with a similar name\b/i)[0];
  const conflicts = new Map();
  const confusables = [...analysis.confusable].map((id) => roster.byId.get(id)).filter(Boolean);
  // 1. ids
  const ids = new Set();
  for (const f of data.facts ?? []) if (f?.entityId) ids.add(f.entityId);
  for (const r of data.records ?? []) if (r?.id) ids.add(r.id);
  if (data.entityId) ids.add(data.entityId);
  for (const c of confusables) if (ids.has(c.id)) conflicts.set(c.id, c);
  // 2. values
  const dg = digitsOf(main);
  const low = lower(main);
  for (const c of confusables) {
    // a value the asked-about customer ALSO has (same phone / email / address on file) says nothing about the look-alike
    const ownPhone = (x) => digitsOf(x.phone).slice(-10); const own = analysis.singles;
    const ph = ownPhone(c);
    if (ph.length === 10 && dg.includes(ph) && !own.some((a) => ownPhone(a) === ph)) conflicts.set(c.id, c);
    if (c.email && low.includes(lower(c.email)) && !own.some((a) => lower(a.email) === lower(c.email))) conflicts.set(c.id, c);
    const sa = lower(shownAddress(c)).replace(/\s+/g, ' ');
    if (sa.length > 8 && !own.some((a) => lower(shownAddress(a)).replace(/\s+/g, ' ') === sa)) {
      const at = low.replace(/\s+/g, ' ').indexOf(sa);
      if (at >= 0) conflicts.set(c.id, c);
    }
  }
  // 3. names: the same window finder, run on the answer's own text
  const qt = rawTokens(main);
  const allowedNames = new Set(analysis.singles.map((a) => a.parsed.strict));
  for (const c of confusables) {
    if (conflicts.has(c.id)) continue;
    if (allowedNames.has(c.parsed.strict)) continue; // the same name cannot tell two customers apart: the ids / phone / email / address checks above do
    const K = c.parsed.core.length ? c.parsed.core : c.parsed.loose;
    if (K.length < 2 && !(c.parsed.company.length && K[0]?.length >= 4)) continue;
    const ws = windowsFor(c, qt).filter((w) => w.verbatim);
    if (!ws.length) continue;
    // contained in a longer allowed name's window does not count ("ABC Plumbing" inside "ABC Plumbing & Heating")
    const allowedWins = [];
    for (const a of analysis.singles) for (const w of windowsFor(a, qt)) allowedWins.push(w);
    if (ws.some((w) => !allowedWins.some((o) => o.i <= w.i && o.j >= w.j && (o.j - o.i) > (w.j - w.i)))) conflicts.set(c.id, c);
  }
  for (const id of allowed) conflicts.delete(id);
  return { ok: conflicts.size === 0, conflicts: [...conflicts.values()] };
}


// ------------------------------------------------------------- the hint the lanes read

const hintScope = new AsyncLocalStorage();
/** Called once per request by ask.js: the customers the gate resolved from the question (single mentions only). Cleared with null. */
export function setEntityHint(analysis, tenantKey) {
  if (!analysis) { hintScope.enterWith(null); return; }
  const mentions = (analysis.mentions ?? []).filter((m) => m.status === 'single' && m.targets.length === 1)
    .map((m) => ({ words: new Set(rawTokens(m.text).map((t) => t.loose)), target: m.targets[0], typo: !!m.typo, text: m.text }));
  hintScope.enterWith(mentions.length ? { tenantKey, mentions } : null);
}
/**
 * For a lane that extracted a name phrase from the question: the customer the gate already resolved for it, or null.
 * The phrase must be made only of words the gate's mention spelled (so "ABC Plumbing" extracted from "ABC Plumbing & Heating" resolves to the Heating one).
 */
export function entityHintFor(namePhrase) {
  const h = hintScope.getStore(); if (!h) return null;
  const words = rawTokens(namePhrase).map((t) => t.loose).filter((w) => w && !GLUE.has(w));
  if (!words.length) return null;
  const hit = h.mentions.filter((m) => words.every((w) => m.words.has(w) || m.words.has(w.replace(/s$/, ''))));
  return hit.length === 1 ? hit[0] : null;
}
