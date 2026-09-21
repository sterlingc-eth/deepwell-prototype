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

bank.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'bank.json'), JSON.stringify(bank, null, 2) + '\n');

/* ============================================================ summary */

const perCategory = {};
const perVariant = {};
for (const e of bank) {
  perCategory[e.category] = (perCategory[e.category] ?? 0) + 1;
  perVariant[e.variant] = (perVariant[e.variant] ?? 0) + 1;
}
const numBases = bases.length;
let summary = `# Question bank summary\n\n`;
summary += `Generated: ${new Date().toISOString()}\n\n`;
summary += `- Base questions: ${numBases}\n`;
summary += `- Variants per base: ${VARIANTS.length}\n`;
summary += `- Total entries: ${bank.length}\n\n`;
summary += `## Per category\n\n| category | entries |\n|---|---|\n`;
for (const [c, n] of Object.entries(perCategory).sort()) summary += `| ${c} | ${n} |\n`;
summary += `\n## Per variant\n\n| variant | entries |\n|---|---|\n`;
for (const [v, n] of Object.entries(perVariant).sort()) summary += `| ${v} | ${n} |\n`;
writeFileSync(join(OUT_DIR, 'SUMMARY.md'), summary);

console.log(`Generated ${numBases} base questions -> ${bank.length} entries.`);
console.log(`Wrote ${join(OUT_DIR, 'bank.json')}`);
console.log(`Wrote ${join(OUT_DIR, 'SUMMARY.md')}`);
