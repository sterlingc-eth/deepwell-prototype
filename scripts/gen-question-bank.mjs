#!/usr/bin/env node
/**
 * Generates test-docs/question-bank/bank.json from the synthetic-business
 * answer key (handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md, Day 1). Zero
 * model calls — every base question and every value in it is derived
 * directly from test-docs/business-small/ANSWER_KEY.json, and every
 * sloppiness variant is a pure, deterministic (seeded) text transform.
 *
 * Output: test-docs/question-bank/bank.json (sorted by id, stable across
 * runs) and test-docs/question-bank/SUMMARY.md (counts per category/variant).
 *
 *   node scripts/gen-question-bank.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { HVAC_PERSONA_QUESTIONS } from '../test-docs/question-bank/hvac-personas.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ANSWER_KEY_PATH = join(ROOT, 'test-docs', 'business-small', 'ANSWER_KEY.json');
const OUT_DIR = join(ROOT, 'test-docs', 'question-bank');

const key = JSON.parse(readFileSync(ANSWER_KEY_PATH, 'utf8'));

/* ============================================================ tiny deterministic PRNG
 * A seed string (always the base question's own `id`, so the SAME base always
 * gets the SAME typo/filler/trailer no matter when this script runs) hashes
 * to a 32-bit int; mulberry32 then produces reproducible [0,1) floats from it.
 */
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ============================================================ variant transforms */

const ABBREVIATE_PAIRS = [
  ['air conditioners', 'acs'], ['air conditioner', 'ac'],
  ['technicians', 'techs'], ['technician', 'tech'],
  ['customers', 'custs'], ['customer', 'cust'],
  ['phone number', 'ph#'], ['arizona', 'az'], ['nevada', 'nv'],
  ['years', 'yrs'], ['year', 'yr'], ['month', 'mo'],
  ['quantity', 'qty'], ['address', 'addy'], ['people', 'ppl'],
  ['without', 'w/o'], ['email', 'e-mail'],
];

function stripEndPunct(s) {
  return s.replace(/[?!.]+$/, '').trim();
}

function toAbbreviated(base) {
  let q = stripEndPunct(base).toLowerCase();
  for (const [word, abbr] of ABBREVIATE_PAIRS) {
    q = q.replace(new RegExp(`\\b${word}\\b`, 'g'), abbr);
  }
  return q;
}

/** One deterministic edit (adjacent transposition, deletion, insertion, or
 *  substitution) on one eligible (>=5 letters, pure-alpha) word, chosen and
 *  positioned entirely from `seed` — reproducible run to run. Returns the
 *  input unchanged if no word is eligible. */
function applyOneTypo(base, seed) {
  const rng = mulberry32(hashStr(seed));
  const q = stripEndPunct(base).toLowerCase();
  const words = q.split(' ');
  const eligible = [];
  words.forEach((w, i) => { if (/^[a-z]+$/.test(w) && w.length >= 5) eligible.push(i); });
  if (!eligible.length) return q;
  const wi = eligible[Math.floor(rng() * eligible.length)];
  const word = words[wi];
  const pos = Math.floor(rng() * (word.length - 1));
  const op = rng();
  let newWord;
  if (op < 0.25) {
    const chars = word.split('');
    [chars[pos], chars[pos + 1]] = [chars[pos + 1], chars[pos]];
    newWord = chars.join('');
  } else if (op < 0.5) {
    newWord = word.slice(0, pos) + word.slice(pos + 1);
  } else if (op < 0.75) {
    newWord = word.slice(0, pos) + word[pos] + word.slice(pos);
  } else {
    const chars = word.split('');
    chars[pos] = chars[pos] === 'z' ? 'a' : String.fromCharCode(chars[pos].charCodeAt(0) + 1);
    newWord = chars.join('');
  }
  words[wi] = newWord;
  return words.join(' ');
}

const STATEMENT_PREFIXES = ['show me ', 'pull up ', 'list ', 'need the '];
function toStatementForm(base, seed) {
  const idx = hashStr(`${seed}:stmt`) % STATEMENT_PREFIXES.length;
  return STATEMENT_PREFIXES[idx] + stripEndPunct(base).toLowerCase();
}

function toVoiceStyle(base) {
  let q = stripEndPunct(base).toLowerCase();
  q = q
    .replace(/do we have\b/g, 'we got')
    .replace(/are there\b/g, 'we got')
    .replace(/what's/g, 'whats')
    .replace(/who's/g, 'whos')
    .replace(/'/g, '');
  return q;
}

const FILLER_PHRASES = ['hey ', 'quick question, ', 'real quick, ', 'can you tell me ', 'i need to know ', 'could you '];
function toFillerPrefix(base, seed) {
  const idx = hashStr(`${seed}:filler`) % FILLER_PHRASES.length;
  return FILLER_PHRASES[idx] + stripEndPunct(base).toLowerCase();
}

const TRAILERS = [' so I can call them', ' for the newsletter', ', thanks', ' before end of day', ' for the file'];
function toTrailingContext(base, seed) {
  const idx = hashStr(`${seed}:trail`) % TRAILERS.length;
  return stripEndPunct(base) + TRAILERS[idx];
}

function toLowercaseNoPunct(base) {
  return stripEndPunct(base).toLowerCase().replace(/,/g, '');
}

const VARIANTS = [
  ['canonical', (b) => b],
  ['lowercase-no-punct', toLowercaseNoPunct],
  ['abbreviated', toAbbreviated],
  ['typo', applyOneTypo],
  ['statement-form', toStatementForm],
  ['voice-style', toVoiceStyle],
  ['filler-prefix', toFillerPrefix],
  ['trailing-context', toTrailingContext],
];

/* ============================================================ base question builder */

const bases = []; // { category, base, expect }
function add(category, base, expect) {
  bases.push({ category, base, expect });
}

/* ---- derived facts from the answer key --------------------------------- */
const customers = key.customers;
const cities = Object.entries(key.totals.byCity); // [name, count]
const counties = Object.entries(key.totals.byCounty);
const states = Object.entries(key.totals.byState);
const brands = Object.entries(key.equipmentByBrand);
const warrantyLabel = {
  expired: 'out of warranty', active: 'still under warranty',
  expiring: 'expiring soon', unknown: 'an unknown warranty status',
};
const DOC_TYPE_LABEL = {
  invoice: 'invoices', 'service-ticket': 'service tickets', 'work-order': 'work orders',
  'warranty-registration': 'warranty registrations', 'equipment-record': 'equipment records',
  permit: 'permits', 'proposal-quote': 'proposal quotes', 'dispatch-note': 'dispatch notes',
  'inspection-report': 'inspection reports', 'maintenance-agreement': 'maintenance agreements',
  'purchase-order': 'purchase orders', 'nameplate-photo': 'nameplate photos',
  correspondence: 'correspondence', 'startup-sheet': 'startup sheets',
};
const zipCounts = {};
for (const c of customers) zipCounts[c.zip] = (zipCounts[c.zip] ?? 0) + 1;
const withEmail = customers.filter((c) => c.email);
const withoutEmail = customers.filter((c) => !c.email);
const withPhone = customers.filter((c) => c.phone);
const withoutPhone = customers.filter((c) => !c.phone);

const TODAY = '2026-09-21';

/* ---- 1. counts: geo -------------------------------------------------- */
for (const [city, n] of cities) {
  add('counts-geo', `How many customers do we have in ${city}?`, {
    route: 'analytics', entity: 'customers', filters: [{ field: 'city', op: 'eq', value: city }],
    answerValue: n,
  });
  add('counts-geo', `How many customers in ${city}?`, {
    route: 'analytics', entity: 'customers', filters: [{ field: 'city', op: 'eq', value: city }],
    answerValue: n,
  });
}
for (const [county, n] of counties) {
  add('counts-geo', `How many customers do we have in ${county} County?`, {
    route: 'analytics', entity: 'customers', filters: [{ field: 'county', op: 'eq', value: county }],
    conditionsOnly: ['county'], answerValue: n,
  });
  add('counts-geo', `How many customers in ${county} County?`, {
    route: 'analytics', entity: 'customers', filters: [{ field: 'county', op: 'eq', value: county }],
    conditionsOnly: ['county'], answerValue: n,
  });
}
add('counts-geo', 'How many customers do we have in Yuma County?', {
  route: 'analytics', entity: 'customers', filters: [{ field: 'county', op: 'eq', value: 'Yuma' }],
  conditionsOnly: ['county'], answerValue: 0,
});
for (const [state, n] of states) {
  const name = state === 'AZ' ? 'Arizona' : state === 'NV' ? 'Nevada' : state;
  add('counts-geo', `How many customers do we have in ${name}?`, {
    route: 'analytics', entity: 'customers', filters: [{ field: 'state', op: 'eq', value: state }],
    answerValue: n,
  });
  add('counts-geo', `How many customers in ${name}?`, {
    route: 'analytics', entity: 'customers', filters: [{ field: 'state', op: 'eq', value: state }],
    answerValue: n,
  });
}
for (const [zip, n] of Object.entries(zipCounts)) {
  add('counts-geo', `How many customers do we have in ${zip}?`, {
    route: 'analytics', entity: 'customers', filters: [{ field: 'zip', op: 'eq', value: zip }],
    answerValue: n,
  });
  add('lists', `List customers in ${zip}`, {
    route: 'analytics', entity: 'customers', filters: [{ field: 'zip', op: 'eq', value: zip }],
    answerValue: n,
  });
}
add('counts-geo', 'How many customers do we have in total?', {
  route: 'analytics', entity: 'customers', filters: [], answerValue: key.totals.customers,
});

/* ---- 2. counts: brand -------------------------------------------------- */
for (const [brand, n] of brands) {
  add('counts-brand', `How many ${brand} units do we have?`, {
    route: 'analytics', entity: 'equipment', filters: [{ field: 'brand', op: 'eq', value: brand }],
    conditionsOnly: ['brand'], answerValue: n,
  });
  add('counts-brand', `How many units do we have that are ${brand}?`, {
    route: 'analytics', entity: 'equipment', filters: [{ field: 'brand', op: 'eq', value: brand }],
    conditionsOnly: ['brand'], answerValue: n,
  });
  add('counts-brand', `How many ${brand} units are there?`, {
    route: 'analytics', entity: 'equipment', filters: [{ field: 'brand', op: 'eq', value: brand }],
    conditionsOnly: ['brand'], answerValue: n,
  });
}

/* ---- 3. counts: warranty status ---------------------------------------- */
for (const [status, n] of Object.entries(key.warrantyStatusCounts)) {
  const phrase = warrantyLabel[status] ?? status;
  add('counts-warranty', `How many units are ${phrase}?`, {
    route: 'analytics', entity: 'warranties', filters: [{ field: 'warrantyStatus', op: 'eq', value: status }],
    answerValue: n,
  });
  add('counts-warranty', `How many units have ${phrase}?`, {
    route: 'analytics', entity: 'warranties', filters: [{ field: 'warrantyStatus', op: 'eq', value: status }],
    answerValue: n,
  });
}

/* ---- 4. counts: documents ----------------------------------------------- */
add('counts-docs', 'How many documents do we have?', { route: 'analytics', entity: 'documents', answerValue: key.totalDocuments });
add('counts-docs', 'How many units do we have?', { route: 'analytics', entity: 'equipment', answerValue: key.totalUnits });
for (const [type, label] of Object.entries(DOC_TYPE_LABEL)) {
  const n = key.documentsByType[type];
  add('counts-docs', `How many ${label} do we have?`, {
    route: 'analytics', entity: 'documents', filters: [{ field: 'documentType', op: 'eq', value: type }],
    answerValue: n,
  });
  add('counts-docs', `List all our ${label}`, {
    route: 'analytics', entity: 'documents', filters: [{ field: 'documentType', op: 'eq', value: type }],
    answerValue: n,
  });
  add('counts-docs', `How many ${label} are there?`, {
    route: 'analytics', entity: 'documents', filters: [{ field: 'documentType', op: 'eq', value: type }],
    answerValue: n,
  });
}

/* ---- 5. counts/data-hygiene: hasEmail/hasPhone -------------------------- */
add('data-hygiene', 'How many customers have an email on file?', {
  route: 'analytics', entity: 'customers', filters: [{ field: 'hasEmail', op: 'eq', value: true }],
  conditionsOnly: ['email'], answerValue: withEmail.length,
});
add('data-hygiene', 'How many customers are missing an email address?', {
  route: 'analytics', entity: 'customers', filters: [{ field: 'hasEmail', op: 'eq', value: false }],
  conditionsOnly: ['email'], answerValue: withoutEmail.length,
});
add('data-hygiene', 'How many customers have a phone number on file?', {
  route: 'analytics', entity: 'customers', filters: [{ field: 'hasPhone', op: 'eq', value: true }],
  conditionsOnly: ['phone'], answerValue: withPhone.length,
});
add('data-hygiene', 'How many customers are missing a phone number?', {
  route: 'analytics', entity: 'customers', filters: [{ field: 'hasPhone', op: 'eq', value: false }],
  conditionsOnly: ['phone'], answerValue: withoutPhone.length,
});
add('data-hygiene', 'List customers missing an email address', {
  route: 'analytics', entity: 'customers', filters: [{ field: 'hasEmail', op: 'eq', value: false }],
  conditionsOnly: ['email'], answerValue: withoutEmail.length,
});
add('data-hygiene', 'List customers missing a phone number', {
  route: 'analytics', entity: 'customers', filters: [{ field: 'hasPhone', op: 'eq', value: false }],
  conditionsOnly: ['phone'], answerValue: withoutPhone.length,
});

/* ---- 6. lists ------------------------------------------------------------ */
for (const [city] of cities) {
  const names = customers.filter((c) => c.city === city).map((c) => c.canonicalName);
  add('lists', `List customers in ${city}`, {
    route: 'analytics', entity: 'customers', filters: [{ field: 'city', op: 'eq', value: city }],
    answerValue: names.length,
  });
}
for (const [county] of counties) {
  const names = customers.filter((c) => c.county === county).map((c) => c.canonicalName);
  add('lists', `List customers in ${county} County`, {
    route: 'analytics', entity: 'customers', filters: [{ field: 'county', op: 'eq', value: county }],
    conditionsOnly: ['county'], answerValue: names.length,
  });
}
for (const [brand] of brands) {
  add('lists', `Which customers have ${brand} units?`, {
    route: 'analytics', entity: 'customers', filters: [{ field: 'brand', op: 'eq', value: brand }],
    conditionsOnly: ['brand'],
  });
}

/* ---- 7. lookups (per real customer, from the answer key) ---------------- */
for (const c of customers) {
  const unit = c.units?.[0];
  if (unit) {
    add('lookups', `What's the serial number of the unit at ${c.address}?`, {
      route: 'lookup', singleRecord: true, answerValue: unit.serial,
    });
    add('lookups', `Who makes the unit at ${c.address}?`, {
      route: 'lookup', singleRecord: true, answerValue: unit.brand,
    });
    add('lookups', `What's the model number of the unit at ${c.address}?`, {
      route: 'lookup', singleRecord: true, answerValue: unit.model,
    });
    add('lookups', `When was the unit at ${c.address} installed?`, {
      route: 'lookup', singleRecord: true, answerValue: unit.installDate,
    });
    add('warranty', `Is the unit at ${c.address} still under warranty?`, {
      route: 'lookup', singleRecord: true, answerValue: unit.warrantyStatus,
    });
  }
  if (c.phone) {
    add('lookups', `What's the phone number on file for ${c.canonicalName}?`, {
      route: 'lookup', answerValue: c.phone,
    });
  }
  if (c.email) {
    add('lookups', `What's the email for ${c.canonicalName}?`, {
      route: 'lookup', answerValue: c.email,
    });
  }
}

/* ---- 8. history (single-record, address based) -------------------------- */
for (const c of customers) {
  add('history', `When did we last service the unit at ${c.address}?`, {
    route: 'lookup', singleRecord: true, answerValue: null,
  });
}

/* ---- 8b. counts: unit age (installYear threshold) ------------------------ */
const allUnits = customers.flatMap((c) => c.units ?? []);
for (const years of [5, 10, 15]) {
  const cutoff = new Date(TODAY).getUTCFullYear() - years;
  const n = allUnits.filter((u) => Number(String(u.installDate).slice(0, 4)) < cutoff).length;
  add('counts-age', `How many units are older than ${years} years?`, {
    route: 'analytics', entity: 'equipment', filters: [{ field: 'installYear', op: 'lt', value: cutoff }],
    answerValue: n,
  });
  add('counts-age', `How many units older than ${years} years do we have?`, {
    route: 'analytics', entity: 'equipment', filters: [{ field: 'installYear', op: 'lt', value: cutoff }],
    answerValue: n,
  });
}

/* ---- 9. maintenance-due (aggregate, no filter support yet -> honest fallback) */
add('maintenance-due', 'Which customers are overdue for maintenance?', {
  route: 'analytics', entity: 'customers', unsupported: true, note: 'no last-service-date filter in the closed vocabulary',
});
add('maintenance-due', 'Which customers have not had service in 12 months?', {
  route: 'analytics', entity: 'customers', unsupported: true, note: 'no last-service-date filter in the closed vocabulary',
});
add('maintenance-due', 'List customers due for a tune-up', {
  route: 'analytics', entity: 'customers', unsupported: true, note: 'no last-service-date filter in the closed vocabulary',
});

/* ---- 10. technician (no ground truth in this corpus; classification only) */
for (const phrase of [
  'How many jobs did each technician do this month?',
  'Show me a breakdown by technician',
  'Which technician did the most jobs this year?',
  'How many service calls did our technicians make?',
  'List jobs by technician',
  'How many visits did each tech make last month?',
]) {
  add('technician', phrase, { route: 'analytics', entity: 'serviceVisits', answerValue: null, note: 'no technician ground truth in this corpus' });
}

/* ---- 11. comparisons / trends -------------------------------------------- */
add('comparisons', 'Group equipment by brand', { route: 'analytics', entity: 'equipment', groupBy: 'brand', answerValue: key.equipmentByBrand });
add('comparisons', 'Show me a breakdown of units by brand', { route: 'analytics', entity: 'equipment', groupBy: 'brand', answerValue: key.equipmentByBrand });
add('comparisons', 'Group customers by county', { route: 'analytics', entity: 'customers', groupBy: 'county', answerValue: key.totals.byCounty });
add('comparisons', 'Show me a breakdown of customers by city', { route: 'analytics', entity: 'customers', groupBy: 'city', answerValue: key.totals.byCity });
add('comparisons', 'Group documents by month', { route: 'analytics', entity: 'documents', groupBy: 'month', answerValue: null });
add('comparisons', 'Show me a breakdown of jobs by month', { route: 'analytics', entity: 'serviceVisits', groupBy: 'month', answerValue: null });
add('comparisons', 'Group units by warranty status', { route: 'analytics', entity: 'warranties', groupBy: 'warrantyStatus', answerValue: key.warrantyStatusCounts });
add('comparisons', 'Show me a breakdown of customers by state', { route: 'analytics', entity: 'customers', groupBy: 'state', answerValue: key.totals.byState });

/* ---- 12. money (flagged unsupported — needs invoice totals) -------------- */
for (const phrase of [
  "What's the total invoice amount for this year?",
  'How much did we invoice last month?',
  "What's the total we billed in invoices this year?",
  "Who's our biggest customer by revenue?",
  'How much revenue came from Trane invoices?',
  "What's the total dollar amount of our open invoices?",
]) {
  add('money', phrase, { route: 'analytics', entity: 'documents', unsupported: true, note: 'needs invoice totals; sum op has no real currency support yet', answerValue: null });
}

/* ---- 13. time / month resolution ----------------------------------------- */
add('time', 'How many documents did we add this month?', { route: 'analytics', entity: 'documents', timeRange: { from: '2026-09', to: '2026-09' }, conditionsOnly: ['month'], answerValue: key.totalDocuments });
add('time', 'How many documents did we add last month?', { route: 'analytics', entity: 'documents', timeRange: { from: '2026-08', to: '2026-08' }, conditionsOnly: ['month'], answerValue: null });
add('time', 'How many jobs did we do in August?', { route: 'analytics', entity: 'serviceVisits', timeRange: { from: '2026-08', to: '2026-08' }, conditionsOnly: ['month'], answerValue: null });
add('time', 'How many service calls did we make in September?', { route: 'analytics', entity: 'serviceVisits', timeRange: { from: '2026-09', to: '2026-09' }, conditionsOnly: ['month'], answerValue: null });
add('time', 'How many jobs did we do in December?', { route: 'analytics', entity: 'serviceVisits', timeRange: { from: '2025-12', to: '2025-12' }, conditionsOnly: ['month'], answerValue: null });
add('time', 'How many invoices did we complete in August 2024?', { route: 'analytics', entity: 'documents', timeRange: { from: '2024-08', to: '2024-08' }, conditionsOnly: ['month'], answerValue: null });
add('time', 'How many visits did we have this week?', { route: 'analytics', entity: 'serviceVisits', answerValue: null });
add('time', 'How many documents did we add this year?', { route: 'analytics', entity: 'documents', answerValue: key.totalDocuments });

/* ---- 14. live misses (2026-09-21 270-question production sample) -------
 * Regression pins for the four real miss clusters fixed this session:
 *   1. contact lookup by (often lowercase) customer name -> contactLookup.js
 *   2. money/dollar-total questions -> honest fallback, never "$0.00"
 *   3. maintenance-due synonyms -> honest fallback, never an unfiltered count
 *   4. street-name typos in a single-record address -> streetVocab.js
 * These are literal phrasings from the live sample, not templated over the
 * synthetic corpus's own customers/addresses, so `route`/`conditionsOnly`/
 * `singleRecord` are the only expectations verify-question-bank.mjs can
 * check with no database (see that script's own doc comment) — the DB-
 * backed behavior itself (contactLookup.js, the money/maintenance honest
 * fallbacks, streetVocab.js's correction) is unit-tested directly in
 * scripts/verify-analytics.mjs.
 */
const LIVE_MISSES_2026_09_21 = [
  // 1. contact lookup by name — must NOT route to analytics; a lowercase
  // name with no HVAC anchor also never matches fastPath's own gates, so
  // 'lookup' here means "contactLookup.js or plain retrieval", never analytics.
  { q: "what's the phone number on file for donna thornton", expect: { route: 'lookup' } },
  { q: "what's the email for sandra wyckoff", expect: { route: 'lookup' } },
  { q: "what's the ph# on file for brian chavez", expect: { route: 'lookup' } },
  { q: 'whats the phone numbr for thomas mercer', expect: { route: 'lookup' } },
  { q: "what's the email on file for linda alvarez", expect: { route: 'lookup' } },
  { q: "what's the service address for james patterson", expect: { route: 'lookup' } },
  { q: 'phone number for maria gutierrez', expect: { route: 'lookup' } },
  { q: 'email on file for robert kim', expect: { route: 'lookup' } },

  // 2. money questions — the honest fallback, never a fabricated dollar
  // figure. conditionsOnly is documentation here (verified directly against
  // detectedConditions/isMoneyQuestion in verify-analytics.mjs); this script
  // only checks it when expect.route is 'analytics'.
  { q: "What's the total dollar amount of our open invoices?", expect: { route: 'analytics', entity: 'documents', unsupported: true, conditionsOnly: ['money'] } },
  { q: "What's the total we billed in invoices this year?", expect: { route: 'analytics', entity: 'documents', unsupported: true, conditionsOnly: ['money'] } },
  { q: "Who's our biggest customer by revenue?", expect: { route: 'analytics', entity: 'customers', unsupported: true, conditionsOnly: ['money'] } },
  { q: 'how much did we invoice last month', expect: { route: 'lookup', conditionsOnly: ['money'] } },
  { q: 'Are we owed any money?', expect: { route: 'lookup', conditionsOnly: ['money'] } },
  { q: 'How much have we billed year to date?', expect: { route: 'lookup', conditionsOnly: ['money'] } },

  // 3. maintenance-due synonyms — the honest fallback, never an unfiltered
  // "49 customers." "not had service in 12 months" already fell through to
  // retrieval before this fix (a 2+ digit number trips
  // suspiciousUnfilteredCustomerPlan); it's included here so detectedConditions
  // stays correct for it too.
  { q: 'Which customers are overdue for maintenance?', expect: { route: 'analytics', entity: 'customers', unsupported: true, conditionsOnly: ['maintenance'] } },
  { q: 'List customers due for a tune-up', expect: { route: 'analytics', entity: 'customers', unsupported: true, conditionsOnly: ['maintenance'] } },
  { q: 'Which customers have not had service in 12 months?', expect: { route: 'analytics', entity: 'customers', unsupported: true, conditionsOnly: ['maintenance'] } },

  // 4. street-name typos in a single-record address — corrected against the
  // tenant's own street vocabulary (streetVocab.js), never against a general
  // word list. singleRecord: true pins that these keep being recognized as
  // one-record lookups (never analytics) despite the typo.
  { q: 'when was the unit at 766 n val ivsta dr, tucson installed', expect: { route: 'lookup', singleRecord: true } },
  { q: "what's the serial number of the unit at 248 w huard rd", expect: { route: 'lookup', singleRecord: true } },
  { q: 'model number of the unit at 174 n collehe av', expect: { route: 'lookup', singleRecord: true } },
];
for (const { q, expect } of LIVE_MISSES_2026_09_21) {
  add('live-misses-2026-09-21', q, expect);
}

/* ============================================================ live miss:
 * "which units had services this month" (2026-09-21) — the owner asked
 * Donovan this live and got no answer at all. Root cause: entity choice for
 * a "did this get serviced" question was left to the model, which either
 * picked equipment/customers (neither carries a service_date column, so the
 * plan's own timeRange was silently ignored downstream) or produced a plan
 * validatePlan/the executor rejected outright, falling all the way through to
 * retrieval's "Nothing in your records answers that" — a wrong answer, since
 * this tenant's synthetic data has zero service visits in September 2026 and
 * the honest answer is a real zero WITH context, never "nothing answers that".
 * Fixed with a deterministic entity/op override (resolveServiceVisitsOverride,
 * analytics.js) that never depends on the model recognizing this shape —
 * see that function's own doc comment. Every phrasing here expects entity
 * 'serviceVisits' and a timeRange resolveQuestionTimeRange itself would
 * compute for the same text (verify-question-bank.mjs checks the timeRange
 * expectation directly with no model call; the override/entity choice itself
 * is checked in scripts/verify-analytics.mjs, which the bank has no way to
 * exercise with no database).
 */
const LIVE_MISSES_2026_09_21b = [
  { q: 'Which units had services this month?', expect: { route: 'analytics', entity: 'serviceVisits', timeRange: { from: '2026-09', to: '2026-09' } } },
  { q: 'What units were serviced this month?', expect: { route: 'analytics', entity: 'serviceVisits', timeRange: { from: '2026-09', to: '2026-09' } } },
  { q: 'Which units did we service in September?', expect: { route: 'analytics', entity: 'serviceVisits', timeRange: { from: '2026-09', to: '2026-09' } } },
  { q: 'List the units we serviced last month', expect: { route: 'analytics', entity: 'serviceVisits', timeRange: { from: '2026-08', to: '2026-08' } } },
  { q: 'What equipment got serviced this month?', expect: { route: 'analytics', entity: 'serviceVisits', timeRange: { from: '2026-09', to: '2026-09' } } },
  { q: 'Which customers did we service this month?', expect: { route: 'analytics', entity: 'serviceVisits', timeRange: { from: '2026-09', to: '2026-09' } } },
  { q: 'How many service calls this month?', expect: { route: 'analytics', entity: 'serviceVisits', timeRange: { from: '2026-09', to: '2026-09' } } },
];
for (const { q, expect } of LIVE_MISSES_2026_09_21b) {
  add('live-misses-2026-09-21b', q, expect);
}

/* ============================================================ expand into the bank */

const catSlug = (c) => c.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
const seqByCat = {};
const bank = [];
for (const { category, base, expect } of bases) {
  const slug = catSlug(category);
  const seq = (seqByCat[slug] = (seqByCat[slug] ?? 0) + 1);
  const baseId = `${slug}-${String(seq).padStart(4, '0')}`;
  for (const [variant, fn] of VARIANTS) {
    const text = fn(base, baseId);
    bank.push({
      id: `${baseId}-${variant}`,
      base,
      text,
      variant,
      category,
      expect,
    });
  }
}

/* ---- HVAC persona bases (test-docs/question-bank/hvac-personas.mjs) -----
 * Same 8-variant pipeline as every other base, deterministic ids keyed by
 * persona so they never collide with (and are trivially distinguishable
 * from) the category-keyed ids above: `hvac-<persona>-NNNN-<variant>`.
 * persona/tags carry through to the emitted bank entry so
 * verify-question-bank.mjs and SUMMARY.md can report on them directly.
 */
const seqByPersona = {};
for (const { persona, category, base, tags, expect } of HVAC_PERSONA_QUESTIONS) {
  const seq = (seqByPersona[persona] = (seqByPersona[persona] ?? 0) + 1);
  const baseId = `hvac-${persona}-${String(seq).padStart(4, '0')}`;
  for (const [variant, fn] of VARIANTS) {
    const text = fn(base, baseId);
    bank.push({
      id: `${baseId}-${variant}`,
      base,
      text,
      variant,
      category,
      persona,
      tags,
      expect,
    });
  }
}

bank.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'bank.json'), JSON.stringify(bank, null, 2) + '\n');

/* ============================================================ summary */

const perCategory = {};
const perVariant = {};
const perPersona = {};
const perTag = {};
for (const e of bank) {
  perCategory[e.category] = (perCategory[e.category] ?? 0) + 1;
  perVariant[e.variant] = (perVariant[e.variant] ?? 0) + 1;
  if (e.persona) perPersona[e.persona] = (perPersona[e.persona] ?? 0) + 1;
  for (const t of e.tags ?? []) perTag[t] = (perTag[t] ?? 0) + 1;
}
const numBases = bases.length + HVAC_PERSONA_QUESTIONS.length;
let summary = `# Question bank summary\n\n`;
summary += `Generated: ${new Date().toISOString()}\n\n`;
summary += `- Base questions: ${numBases} (${bases.length} core + ${HVAC_PERSONA_QUESTIONS.length} HVAC persona)\n`;
summary += `- Variants per base: ${VARIANTS.length}\n`;
summary += `- Total entries: ${bank.length}\n\n`;
summary += `## Per category\n\n| category | entries |\n|---|---|\n`;
for (const [c, n] of Object.entries(perCategory).sort()) summary += `| ${c} | ${n} |\n`;
summary += `\n## Per variant\n\n| variant | entries |\n|---|---|\n`;
for (const [v, n] of Object.entries(perVariant).sort()) summary += `| ${v} | ${n} |\n`;
summary += `\n## Per persona (HVAC bank only)\n\n| persona | entries |\n|---|---|\n`;
for (const [p, n] of Object.entries(perPersona).sort()) summary += `| ${p} | ${n} |\n`;
summary += `\n## Per tag (HVAC bank only)\n\n| tag | entries |\n|---|---|\n`;
for (const [t, n] of Object.entries(perTag).sort()) summary += `| ${t} | ${n} |\n`;
writeFileSync(join(OUT_DIR, 'SUMMARY.md'), summary);

console.log(`Generated ${numBases} base questions -> ${bank.length} entries.`);
console.log(`Wrote ${join(OUT_DIR, 'bank.json')}`);
console.log(`Wrote ${join(OUT_DIR, 'SUMMARY.md')}`);
