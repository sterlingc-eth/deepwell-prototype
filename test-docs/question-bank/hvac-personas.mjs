/**
 * HVAC persona question corpus for Donovan.
 *
 * Every base question here is written the way an owner, office
 * manager/dispatcher, field tech, or bookkeeper at a 4-12 tech Phoenix/Tucson
 * HVAC company would actually type or say it -- not textbook phrasing. Every
 * fact used (names, addresses, brands, cities, zips, serials, phone/email,
 * install dates, warranty status, which document types a customer has on
 * file) is read live from test-docs/business-small/ANSWER_KEY.json, and every
 * derivable count/boolean answerValue is COMPUTED from that same data at
 * import time -- never hand-typed -- so it can't drift from the corpus.
 *
 * This file does NOT do the sloppiness-variant expansion
 * (typo/abbreviated/voice-style/...) that scripts/gen-question-bank.mjs does
 * for its own bases -- these ARE the bases. `tags` records which phrasing
 * style is already baked into a given base's text (half-sentence, voice,
 * typo, abbrev, follow-up, time-window-unsupported); the downstream generator
 * still runs its own 8 variants on top of each entry's `base` text.
 *
 * Zero model calls. No product code touched.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const key = JSON.parse(
  readFileSync(join(__dirname, '..', 'business-small', 'ANSWER_KEY.json'), 'utf8')
);

const customers = key.customers;
const TODAY_YEAR = 2026; // matches key.generatedAt = 2026-09-21
const TECHS = ['Danny Ochoa', 'Marisol Vega', 'Kevin Pratt', 'Denise Ford', 'Ray Sutton', 'Wyatt Coburn'];

/* ---------------------------------------------------------------- helpers */
const lastName = (name) => name.trim().split(/\s+/).slice(-1)[0];
const unitOf = (c) => c.units?.[0];
const installYear = (c) => Number(String(unitOf(c).installDate).slice(0, 4));
const hasDoc = (c, typeSlug) => c.docs.some((d) => d.includes(typeSlug));
const monthRange = (year, month) => {
  const y = String(year);
  const m = String(month).padStart(2, '0');
  return { from: `${y}-${m}`, to: `${y}-${m}` };
};
// Resolves a bare month name the same way analytics.js's own
// resolveQuestionTimeRange does: current year unless that month is still in
// the future relative to TODAY (2026-09), in which case it means last year's.
const CURRENT_MONTH = 9;
const bareMonthRange = (monthNum) => {
  const year = monthNum > CURRENT_MONTH ? TODAY_YEAR - 1 : TODAY_YEAR;
  return monthRange(year, monthNum);
};
const THIS_MONTH_RANGE = monthRange(TODAY_YEAR, CURRENT_MONTH); // September 2026
const LAST_MONTH_RANGE = monthRange(TODAY_YEAR, CURRENT_MONTH - 1); // August 2026

const byCity = {};
const byCounty = {};
const byBrand = {};
const zipCounts = {};
for (const c of customers) {
  (byCity[c.city] ??= []).push(c);
  (byCounty[c.county] ??= []).push(c);
  const u = unitOf(c);
  if (u) (byBrand[u.brand] ??= []).push(c);
  zipCounts[c.zip] = (zipCounts[c.zip] ?? 0) + 1;
}

/* ---------------------------------------------------------------- collector */
export const HVAC_PERSONA_QUESTIONS = [];
function add(persona, category, base, expect, tags = []) {
  HVAC_PERSONA_QUESTIONS.push({ persona, category, base, tags, expect });
}

/* ================================================================ OWNER ===
 * Fleet health and exposure -- someone who thinks in totals, trends and risk,
 * not single records.
 */

// -- fleet age exposure --------------------------------------------------
for (const years of [15, 20]) {
  const cutoff = TODAY_YEAR - years;
  const n = customers.filter((c) => installYear(c) < cutoff).length;
  add(
    'owner', 'counts-age',
    `How many of our customers are running units older than ${years} years?`,
    { route: 'analytics', entity: 'equipment', filters: [{ field: 'installYear', op: 'lt', value: cutoff }], answerValue: n }
  );
}

// -- brand exposure --------------------------------------------------------
{
  const top = Object.entries(key.equipmentByBrand).sort((a, b) => b[1] - a[1])[0];
  add('owner', 'counts-brand', 'Which brand do we have the most of?', {
    route: 'analytics', entity: 'equipment', groupBy: 'brand', answerValue: { brand: top[0], count: top[1] },
  });
}
for (const brand of Object.keys(key.equipmentByBrand)) {
  const n = (byBrand[brand] ?? []).filter((c) => installYear(c) >= 2020).length;
  add('owner', 'two-condition', `How many ${brand} installs have we done since 2020?`, {
    route: 'analytics', entity: 'equipment',
    filters: [{ field: 'brand', op: 'eq', value: brand }, { field: 'installYear', op: 'gte', value: 2020 }],
    answerValue: n,
  });
}
for (const brand of Object.keys(key.equipmentByBrand)) {
  const n = (byBrand[brand] ?? []).filter((c) => unitOf(c).warrantyStatus === 'expired').length;
  add('owner', 'two-condition', `How many ${brand} units are out of warranty right now?`, {
    route: 'analytics', entity: 'equipment',
    filters: [{ field: 'brand', op: 'eq', value: brand }, { field: 'warrantyStatus', op: 'eq', value: 'expired' }],
    answerValue: n,
  });
}
{
  // every warrantyStatus:'unknown' unit in this corpus happens to be a York --
  // a real gap-exposing "which brands" question with a genuinely interesting answer.
  const unknownBrands = [...new Set(customers.filter((c) => unitOf(c).warrantyStatus === 'unknown').map((c) => unitOf(c).brand))];
  add('owner', 'counts-warranty', 'Which brands are our unknown-warranty units? We should chase those down.', {
    route: 'analytics', entity: 'equipment', filters: [{ field: 'warrantyStatus', op: 'eq', value: 'unknown' }], groupBy: 'brand',
    answerValue: unknownBrands,
  });
}

// -- geo comparisons ---------------------------------------------------------
add('owner', 'comparisons', "What's our customer count by city?", {
  route: 'analytics', entity: 'customers', groupBy: 'city', answerValue: key.totals.byCity,
});
add('owner', 'comparisons', 'How many customers do we have in Pinal County vs Maricopa County?', {
  route: 'analytics', entity: 'customers', groupBy: 'county',
  answerValue: { Pinal: key.totals.byCounty.Pinal, Maricopa: key.totals.byCounty.Maricopa },
});
for (const county of Object.keys(key.totals.byCounty)) {
  add('owner', 'counts-geo', `How many accounts do we run out in ${county} County these days?`, {
    route: 'analytics', entity: 'customers', filters: [{ field: 'county', op: 'eq', value: county }],
    answerValue: key.totals.byCounty[county],
  });
}
for (const city of Object.keys(key.totals.byCity)) {
  const cutoff = TODAY_YEAR - 10;
  const n = (byCity[city] ?? []).filter((c) => installYear(c) < cutoff).length;
  add('owner', 'two-condition', `How many customers in ${city} have units older than 10 years?`, {
    route: 'analytics', entity: 'equipment',
    filters: [{ field: 'city', op: 'eq', value: city }, { field: 'installYear', op: 'lt', value: cutoff }],
    answerValue: n,
  });
}
for (const city of Object.keys(key.totals.byCity)) {
  const n = (byCity[city] ?? []).filter((c) => c.email).length;
  add('owner', 'two-condition', `How many customers do we have an email on file for in ${city}?`, {
    route: 'analytics', entity: 'customers',
    filters: [{ field: 'city', op: 'eq', value: city }, { field: 'hasEmail', op: 'eq', value: true }],
    answerValue: n,
  });
}
{
  const names = (byCity['Las Vegas'] ?? []).map((c) => c.canonicalName);
  add('owner', 'lists', 'Who are our customers in Las Vegas?', {
    route: 'analytics', entity: 'customers', filters: [{ field: 'city', op: 'eq', value: 'Las Vegas' }],
    answerValue: names.length,
  });
}

// -- warranty exposure two-condition ------------------------------------------
{
  const cutoff = TODAY_YEAR - 10;
  const n = customers.filter((c) => unitOf(c).warrantyStatus === 'expired' && installYear(c) < cutoff).length;
  add('owner', 'two-condition', 'Which customers have an expired warranty AND a unit over 10 years old?', {
    route: 'analytics', entity: 'customers',
    filters: [{ field: 'warrantyStatus', op: 'eq', value: 'expired' }, { field: 'installYear', op: 'lt', value: cutoff }],
    answerValue: n,
  });
}
{
  const n = (byCity['Tucson'] ?? []).filter((c) => unitOf(c).warrantyStatus === 'active').length;
  add('owner', 'two-condition', 'How many active warranties do we have in Tucson?', {
    route: 'analytics', entity: 'customers',
    filters: [{ field: 'city', op: 'eq', value: 'Tucson' }, { field: 'warrantyStatus', op: 'eq', value: 'active' }],
    answerValue: n,
  });
}
add('owner', 'counts-warranty', 'How many warranties expire in the next 90 days?', {
  route: 'analytics', entity: 'warranties', timeRange: null,
  note: 'no relative day-window time support; nearest is warrantyStatus=expiring',
}, ['time-window-unsupported']);

// -- yes/no --------------------------------------------------------------
add('owner', 'yes-no', 'Do we service anything in Nevada?', {
  route: 'analytics', entity: 'customers', filters: [{ field: 'state', op: 'eq', value: 'NV' }],
  answerValue: key.totals.byState.NV > 0,
});
add('owner', 'yes-no', 'Have we ever installed a Daikin?', {
  route: 'analytics', entity: 'equipment', filters: [{ field: 'brand', op: 'eq', value: 'Daikin' }],
  answerValue: key.equipmentByBrand.Daikin > 0,
});
{
  const n = (byBrand['Daikin'] ?? []).filter((c) => c.city === 'Tucson').length;
  add('owner', 'yes-no', 'Do we have any Daikin customers in Tucson?', {
    route: 'analytics', entity: 'customers',
    filters: [{ field: 'brand', op: 'eq', value: 'Daikin' }, { field: 'city', op: 'eq', value: 'Tucson' }],
    answerValue: n > 0,
  });
}
add('owner', 'yes-no', 'Do we have any commercial accounts?', {
  route: 'analytics', entity: 'customers', unsupported: true,
  note: 'no commercial/residential classification field in the schema',
});
add('owner', 'yes-no', 'Have we ever done a commercial job?', {
  route: 'analytics', entity: 'documents', unsupported: true,
  note: 'no commercial/residential classification field in the schema',
});
{
  const n = customers.filter((c) => !c.phone && !c.email).length;
  add('owner', 'two-condition', 'How many customers have no phone AND no email on file?', {
    route: 'analytics', entity: 'customers',
    filters: [{ field: 'hasPhone', op: 'eq', value: false }, { field: 'hasEmail', op: 'eq', value: false }],
    answerValue: n,
  });
}

// -- coverage ---------------------------------------------------------------
add('owner', 'coverage', 'What zip codes do we serve?', {
  route: 'analytics', entity: 'customers', groupBy: 'zip', answerValue: zipCounts,
});
add('owner', 'coverage', 'How many different zip codes do we cover?', {
  route: 'analytics', entity: 'customers', groupBy: 'zip', answerValue: Object.keys(zipCounts).length,
});
add('owner', 'coverage', 'How many customers do we have per zip code?', {
  route: 'analytics', entity: 'customers', groupBy: 'zip', answerValue: zipCounts,
});
add('owner', 'coverage', 'What counties do we cover?', {
  route: 'analytics', entity: 'customers', groupBy: 'county', answerValue: key.totals.byCounty,
});
add('owner', 'coverage', 'Do we have customers outside Arizona?', {
  route: 'analytics', entity: 'customers', filters: [{ field: 'state', op: 'neq', value: 'AZ' }],
  answerValue: key.totals.byState.NV,
});
add('owner', 'coverage', 'Do we serve zip code 85122?', {
  route: 'analytics', entity: 'customers', filters: [{ field: 'zip', op: 'eq', value: '85122' }],
  answerValue: (zipCounts['85122'] ?? 0) > 0,
});

// -- technician load ----------------------------------------------------------
add('owner', 'technician', 'Who did the most jobs in August?', {
  route: 'analytics', entity: 'serviceVisits', timeRange: bareMonthRange(8), answerValue: null,
  note: 'no technician ground truth in this corpus',
});
add('owner', 'technician', 'How many jobs per tech this quarter?', {
  route: 'analytics', entity: 'serviceVisits', timeRange: null, answerValue: null,
  note: 'no technician ground truth in this corpus; "this quarter" also has no time-range support',
}, ['time-window-unsupported']);
add('owner', 'technician', 'Which technician handled the most calls last month?', {
  route: 'analytics', entity: 'serviceVisits', timeRange: LAST_MONTH_RANGE, answerValue: null,
  note: 'no technician ground truth in this corpus',
});
add('owner', 'technician', 'How many jobs did each technician close out this year?', {
  route: 'analytics', entity: 'serviceVisits', timeRange: null, answerValue: null,
  note: 'no technician ground truth in this corpus; "this year" also has no time-range support',
}, ['time-window-unsupported']);
for (const tech of TECHS.slice(0, 4)) {
  add('owner', 'technician', `How many jobs did ${tech} run this month?`, {
    route: 'analytics', entity: 'serviceVisits', filters: [{ field: 'technician', op: 'eq', value: tech }],
    timeRange: THIS_MONTH_RANGE, answerValue: null, note: 'no technician ground truth in this corpus',
  });
}

// -- trends / time windows ------------------------------------------------
add('owner', 'time', 'How many new customers have we picked up this year?', {
  route: 'analytics', entity: 'customers', timeRange: null,
  note: 'no customer signup/creation-date field in the schema',
}, ['time-window-unsupported']);
for (const base of [
  'How many jobs did we do this quarter?',
  'How many jobs did we do last quarter?',
  'How many documents have we added year to date?',
  'How many installs have we done since 2022?',
  'How many service calls have we made in the last 90 days?',
]) {
  add('owner', 'time', base, {
    route: 'analytics', entity: /install/.test(base) ? 'equipment' : /document/.test(base) ? 'documents' : 'serviceVisits',
    timeRange: null, note: 'time window not in resolveQuestionTimeRange support',
  }, ['time-window-unsupported']);
}
add('owner', 'time', 'How many service calls did the crew run in August?', {
  route: 'analytics', entity: 'serviceVisits', timeRange: bareMonthRange(8), answerValue: null,
});

// -- documents / data-hygiene -----------------------------------------------
{
  const n = customers.filter((c) => hasDoc(c, 'maintenance-agreement')).length;
  add('owner', 'counts-docs', 'How many maintenance plans do we have running?', {
    route: 'analytics', entity: 'documents', filters: [{ field: 'documentType', op: 'eq', value: 'maintenance-agreement' }],
    answerValue: n,
  });
}
add('owner', 'maintenance-due', "How many customers are on a maintenance plan but haven't been serviced this year?", {
  route: 'analytics', entity: 'customers', unsupported: true,
  note: 'no last-service-date filter combined with maintenance-agreement in the closed vocabulary',
});
add('owner', 'data-hygiene', "How many customers don't have a warranty registration on file?", {
  route: 'analytics', entity: 'customers', unsupported: true,
  note: 'no "missing document type" filter in the closed vocabulary -- documentType only matches existence, not absence',
});
add('owner', 'data-hygiene', 'Which customers got a proposal but never signed a maintenance agreement?', {
  route: 'analytics', entity: 'customers', unsupported: true,
  note: 'cross-document-type filter not in the closed vocabulary',
});
{
  const inv = key.documentsByType.invoice;
  const tix = key.documentsByType['service-ticket'];
  add('owner', 'comparisons', 'Do we have more invoices or more service tickets on file?', {
    route: 'analytics', entity: 'documents', groupBy: 'documentType', answerValue: { invoice: inv, 'service-ticket': tix },
  });
}

/* ================================================================ OFFICE ===
 * Office manager / dispatcher -- phone rings, someone needs a record fast.
 */
const OFFICE_TEMPLATES = [
  (c) => ({
    category: 'lookups',
    base: `What's the phone number for the ${lastName(c.canonicalName)} account?`,
    expect: { route: 'lookup', answerValue: c.phone ?? null, note: c.phone ? undefined : 'no phone on file for this customer' },
  }),
  (c) => ({
    category: 'lookups', tags: ['half-sentence'],
    base: `Pull up ${lastName(c.canonicalName)}`,
    expect: { route: 'retrieval', singleRecord: true, answerValue: null },
  }),
  (c) => ({
    category: 'lookups',
    base: `Who's at ${c.address}?`,
    expect: { route: 'lookup', singleRecord: true, answerValue: c.canonicalName },
  }),
  (c) => ({
    category: 'history',
    base: `What do we have on file for ${c.canonicalName}?`,
    expect: { route: 'retrieval', singleRecord: true, answerValue: null },
  }),
  (c) => ({
    category: 'history',
    base: `When were we last at ${lastName(c.canonicalName)}'s?`,
    expect: { route: 'lookup', singleRecord: true, answerValue: null, note: 'no service-visit history in this corpus' },
  }),
  (c) => ({
    category: 'warranty',
    base: `Is the ${lastName(c.canonicalName)} unit still under warranty?`,
    expect: { route: 'lookup', singleRecord: true, answerValue: unitOf(c).warrantyStatus },
  }),
  (c) => ({
    category: 'lookups',
    base: `What's the serial on the ${lastName(c.canonicalName)} unit?`,
    expect: { route: 'lookup', singleRecord: true, answerValue: unitOf(c).serial },
  }),
  (c) => ({
    category: 'lookups',
    base: `Does ${lastName(c.canonicalName)} have a maintenance agreement?`,
    expect: { route: 'lookup', singleRecord: true, answerValue: hasDoc(c, 'maintenance-agreement') },
  }),
  (c) => ({
    category: 'lookups',
    base: `Did we send ${lastName(c.canonicalName)} a quote?`,
    expect: { route: 'lookup', singleRecord: true, answerValue: hasDoc(c, 'proposal-quote') },
  }),
  (c) => ({
    category: 'lookups',
    base: `Show me all the invoices for ${lastName(c.canonicalName)}`,
    expect: { route: 'retrieval', singleRecord: true, answerValue: c.docs.filter((d) => d.includes('invoice')).length },
  }),
  (c) => ({
    category: 'lookups',
    base: `Do we have the permit for the ${c.city} install at ${c.address}?`,
    expect: { route: 'lookup', singleRecord: true, answerValue: hasDoc(c, 'permit') },
  }),
  (c) => ({
    category: 'history',
    base: `What proposal did we give ${c.canonicalName}?`,
    expect: { route: 'retrieval', singleRecord: true, answerValue: null, note: hasDoc(c, 'proposal-quote') ? 'has a proposal-quote on file; content not in answer key' : 'no proposal-quote on file for this customer' },
  }),
];
const OFFICE_SAMPLE_IDX = [1, 2, 4, 6, 7, 9, 11, 12, 14, 17, 19, 21];
OFFICE_SAMPLE_IDX.forEach((custIdx, sampleIdx) => {
  const c = customers[custIdx];
  const templateOffsets = [0, 3, 6, 9].map((off) => (sampleIdx + off) % OFFICE_TEMPLATES.length);
  for (const ti of templateOffsets) {
    const t = OFFICE_TEMPLATES[ti](c);
    add('office', t.category, t.base, t.expect, t.tags ?? []);
  }
});

// -- data hygiene ----------------------------------------------------------
{
  const n = customers.filter((c) => !c.email).length;
  add('office', 'data-hygiene', 'Which customers have no email so I know who to call instead of emailing?', {
    route: 'analytics', entity: 'customers', filters: [{ field: 'hasEmail', op: 'eq', value: false }], answerValue: n,
  });
}
{
  const n = customers.filter((c) => !c.phone && !c.email).length;
  add('office', 'data-hygiene', "Which customers don't have any contact info on file at all?", {
    route: 'analytics', entity: 'customers',
    filters: [{ field: 'hasPhone', op: 'eq', value: false }, { field: 'hasEmail', op: 'eq', value: false }],
    answerValue: n,
  });
}
add('office', 'data-hygiene', "Which customers' addresses might need double checking?", {
  route: 'analytics', entity: 'customers', unsupported: true, note: 'no address-quality/verification field in the schema',
});

// -- warranty for calling -----------------------------------------------
add('office', 'warranty', 'List customers with warranties expiring this year so I can call them', {
  route: 'analytics', entity: 'warranties', timeRange: null,
  note: '"this year" has no time-range support; warrantyStatus=expiring is the nearest supported filter',
}, ['time-window-unsupported']);
add('office', 'warranty', 'Customers whose warranty expires in the next 90 days?', {
  route: 'analytics', entity: 'warranties', timeRange: null, note: 'no relative day-window time support',
}, ['time-window-unsupported']);
{
  const n = (byCity['Mesa'] ?? []).filter((c) => unitOf(c).warrantyStatus === 'expired').length;
  add('office', 'two-condition', 'Which customers have an expired warranty in Mesa?', {
    route: 'analytics', entity: 'customers',
    filters: [{ field: 'city', op: 'eq', value: 'Mesa' }, { field: 'warrantyStatus', op: 'eq', value: 'expired' }],
    answerValue: n,
  });
}
{
  const n = (byCity['Tucson'] ?? []).filter((c) => unitOf(c).warrantyStatus === 'expired').length;
  add('office', 'two-condition', 'Give me the Tucson customers whose warranty already lapsed', {
    route: 'analytics', entity: 'customers',
    filters: [{ field: 'city', op: 'eq', value: 'Tucson' }, { field: 'warrantyStatus', op: 'eq', value: 'expired' }],
    answerValue: n,
  });
}

// -- maintenance-due ---------------------------------------------------------
add('office', 'maintenance-due', "Who's due for fall maintenance?", {
  route: 'analytics', entity: 'customers', unsupported: true, note: 'no last-service-date filter in the closed vocabulary',
});
add('office', 'maintenance-due', 'Which customers are on a maintenance plan?', {
  route: 'analytics', entity: 'customers', filters: [{ field: 'documentType', op: 'eq', value: 'maintenance-agreement' }],
  answerValue: customers.filter((c) => hasDoc(c, 'maintenance-agreement')).length,
});

// -- two-condition brand+city --------------------------------------------
for (const [brand, city] of [['Trane', 'Casa Grande'], ['Goodman', 'Tucson'], ['Rheem', 'Mesa']]) {
  const n = (byBrand[brand] ?? []).filter((c) => c.city === city).length;
  add('office', 'two-condition', `Do we have any ${brand} customers in ${city}?`, {
    route: 'analytics', entity: 'customers',
    filters: [{ field: 'brand', op: 'eq', value: brand }, { field: 'city', op: 'eq', value: city }],
    answerValue: n > 0,
  });
}

// -- follow-up style ---------------------------------------------------------
{
  const tucsonTrane = (byCity['Tucson'] ?? []).filter((c) => unitOf(c).brand === 'Trane').length;
  add('office', 'follow-up', 'Customers in Tucson -- and how many of those have Trane units?', {
    route: 'analytics', entity: 'customers',
    filters: [{ field: 'city', op: 'eq', value: 'Tucson' }, { field: 'brand', op: 'eq', value: 'Trane' }],
    answerValue: tucsonTrane,
  }, ['follow-up']);
}
{
  const mesaExpired = (byCity['Mesa'] ?? []).filter((c) => unitOf(c).warrantyStatus === 'expired').length;
  add('office', 'follow-up', 'Expired warranties -- what about just the Mesa ones?', {
    route: 'analytics', entity: 'customers',
    filters: [{ field: 'warrantyStatus', op: 'eq', value: 'expired' }, { field: 'city', op: 'eq', value: 'Mesa' }],
    answerValue: mesaExpired,
  }, ['follow-up']);
}
{
  const mesaWithEmail = (byCity['Mesa'] ?? []).filter((c) => c.email).length;
  add('office', 'follow-up', 'Mesa customers -- and how many of those have email on file?', {
    route: 'analytics', entity: 'customers',
    filters: [{ field: 'city', op: 'eq', value: 'Mesa' }, { field: 'hasEmail', op: 'eq', value: true }],
    answerValue: mesaWithEmail,
  }, ['follow-up']);
}
{
  const cgGoodman = (byCity['Casa Grande'] ?? []).filter((c) => unitOf(c).brand === 'Goodman').length;
  add('office', 'follow-up', 'Casa Grande customers -- now just the ones with Goodman units', {
    route: 'analytics', entity: 'customers',
    filters: [{ field: 'city', op: 'eq', value: 'Casa Grande' }, { field: 'brand', op: 'eq', value: 'Goodman' }],
    answerValue: cgGoodman,
  }, ['follow-up']);
}
{
  const pinalExpired = (byCounty['Pinal'] ?? []).filter((c) => unitOf(c).warrantyStatus === 'expired').length;
  add('office', 'follow-up', 'How many customers in Pinal County -- and of those, how many are out of warranty?', {
    route: 'analytics', entity: 'customers',
    filters: [{ field: 'county', op: 'eq', value: 'Pinal' }, { field: 'warrantyStatus', op: 'eq', value: 'expired' }],
    answerValue: pinalExpired,
  }, ['follow-up']);
}
add('office', 'follow-up', 'Customers missing an email -- and how many of those are in Tucson?', {
  route: 'analytics', entity: 'customers',
  filters: [{ field: 'hasEmail', op: 'eq', value: false }, { field: 'city', op: 'eq', value: 'Tucson' }],
  answerValue: (byCity['Tucson'] ?? []).filter((c) => !c.email).length,
}, ['follow-up']);

// -- half-sentence / voice-to-text / typo / abbreviation ---------------------
{
  const t = customers[2]; // Donna Thornton, Mesa
  add('office', 'lookups', 'thornton phone', { route: 'lookup', answerValue: t.phone }, ['half-sentence']);
  add('office', 'lookups', 'donna thornton email', { route: 'lookup', answerValue: t.email }, ['half-sentence']);
  add('office', 'lookups', 'hey what\'s the number for donna thornton', { route: 'lookup', answerValue: t.phone }, ['voice']);
  add('office', 'lookups', 'whats the phone numbr for thonton', { route: 'lookup', answerValue: t.phone }, ['typo']);
}
{
  const b = customers[3]; // Ronald Bracken, Mesa
  add('office', 'lookups', 'bracken serial', { route: 'lookup', answerValue: unitOf(b).serial }, ['half-sentence']);
  add('office', 'lookups', "whats bracken's serial", { route: 'lookup', answerValue: unitOf(b).serial }, ['voice']);
}
{
  const e = customers[7]; // Steven Ellison, Mesa
  add('office', 'history', 'ellison last visit', { route: 'lookup', singleRecord: true, answerValue: null }, ['half-sentence']);
}
{
  const w = customers[6]; // Sandra Wyckoff, 322 N Greenfield Rd
  add('office', 'lookups', 'uh pull up the guy on greenfield road', { route: 'lookup', singleRecord: true, answerValue: w.canonicalName }, ['voice']);
  add('office', 'lookups', 'addr for wyckoff', { route: 'lookup', answerValue: w.address }, ['abbrev', 'half-sentence']);
}
{
  const iss = customers[4]; // Amy Isaacson
  add('office', 'lookups', 'ph# for isaacson', { route: 'lookup', answerValue: iss.phone }, ['abbrev', 'half-sentence']);
}
add('office', 'counts-geo', 'mesa customers', {
  route: 'analytics', entity: 'customers', filters: [{ field: 'city', op: 'eq', value: 'Mesa' }],
  answerValue: key.totals.byCity.Mesa,
}, ['half-sentence']);
add('office', 'counts-geo', 'custs in mesa az', {
  route: 'analytics', entity: 'customers', filters: [{ field: 'city', op: 'eq', value: 'Mesa' }],
  answerValue: key.totals.byCity.Mesa,
}, ['abbrev']);
add('office', 'counts-geo', 'tuc customers', {
  route: 'analytics', entity: 'customers', filters: [{ field: 'city', op: 'eq', value: 'Tucson' }],
  answerValue: key.totals.byCity.Tucson,
}, ['abbrev', 'half-sentence']);
add('office', 'counts-geo', 'cg customers', {
  route: 'analytics', entity: 'customers', filters: [{ field: 'city', op: 'eq', value: 'Casa Grande' }],
  answerValue: key.totals.byCity['Casa Grande'],
}, ['abbrev', 'half-sentence']);
add('office', 'two-condition', 'expired warranties tucson', {
  route: 'analytics', entity: 'customers',
  filters: [{ field: 'warrantyStatus', op: 'eq', value: 'expired' }, { field: 'city', op: 'eq', value: 'Tucson' }],
  answerValue: (byCity['Tucson'] ?? []).filter((c) => unitOf(c).warrantyStatus === 'expired').length,
}, ['half-sentence']);
add('office', 'counts-geo', 'customers in 85201', {
  route: 'analytics', entity: 'customers', filters: [{ field: 'zip', op: 'eq', value: '85201' }],
  answerValue: zipCounts['85201'] ?? 0,
}, ['half-sentence']);
add('office', 'counts-geo', 'customers in 85122', {
  route: 'analytics', entity: 'customers', filters: [{ field: 'zip', op: 'eq', value: '85122' }],
  answerValue: zipCounts['85122'] ?? 0,
}, ['half-sentence']);

/* ================================================================= TECH ===
 * Field tech standing at the unit -- needs the record for THIS address, fast.
 */
const TECH_TEMPLATES = [
  (c) => ({ category: 'lookups', base: `What model is at ${c.address}?`, expect: { route: 'lookup', singleRecord: true, answerValue: unitOf(c).model } }),
  (c) => ({ category: 'lookups', tags: ['half-sentence'], base: `Serial for the unit at ${c.address}`, expect: { route: 'lookup', singleRecord: true, answerValue: unitOf(c).serial } }),
  (c) => ({ category: 'lookups', base: `When was this unit installed, ${c.address}?`, expect: { route: 'lookup', singleRecord: true, answerValue: unitOf(c).installDate } }),
  (c) => ({ category: 'history', base: `What did we do last time at ${c.address}?`, expect: { route: 'lookup', singleRecord: true, answerValue: null, note: 'no service-history log in this corpus' } }),
  (c) => ({ category: 'notes', base: `Any notes on the ${lastName(c.canonicalName)} unit?`, expect: { route: 'retrieval', singleRecord: true, answerValue: null } }),
  (c) => ({ category: 'notes', base: `What refrigerant does the ${unitOf(c).brand} at ${c.address} use?`, expect: { route: 'retrieval', singleRecord: true, answerValue: null, note: 'refrigerant not captured in the answer key' } }),
  (c) => ({ category: 'warranty', base: `Is the ${unitOf(c).brand} at ${c.address} under warranty?`, expect: { route: 'lookup', singleRecord: true, answerValue: unitOf(c).warrantyStatus } }),
  (c) => ({ category: 'history', base: `Who installed the ${unitOf(c).brand} at ${c.address}?`, expect: { route: 'retrieval', singleRecord: true, answerValue: null, note: 'installing tech not tracked per unit in this corpus' } }),
  (c) => ({ category: 'notes', base: `Has this unit had a compressor replaced? ${c.address}`, expect: { route: 'retrieval', unsupported: true, note: 'no repair/parts-replaced history field' } }),
  (c) => ({ category: 'history', base: `What was the last service ticket for ${lastName(c.canonicalName)}?`, expect: { route: 'lookup', singleRecord: true, answerValue: null } }),
  (c) => ({ category: 'notes', base: `What's the tonnage of the unit at ${c.address}?`, expect: { route: 'retrieval', singleRecord: true, answerValue: null, note: 'tonnage not captured in the answer key' } }),
  (c) => ({ category: 'lookups', base: `Startup sheet for the ${lastName(c.canonicalName)} install?`, expect: { route: 'lookup', singleRecord: true, answerValue: hasDoc(c, 'startup-sheet') } }),
  (c) => ({ category: 'lookups', base: `Show me the nameplate photo for ${c.address}`, expect: { route: 'lookup', singleRecord: true, answerValue: hasDoc(c, 'nameplate-photo') } }),
  (c) => ({ category: 'notes', base: `What filter size at ${lastName(c.canonicalName)}'s?`, expect: { route: 'retrieval', unsupported: true, note: 'filter size not tracked in this corpus' } }),
  (c) => ({ category: 'lookups', base: `Did we pull a permit for ${c.address}?`, expect: { route: 'lookup', singleRecord: true, answerValue: hasDoc(c, 'permit') } }),
  (c) => ({ category: 'warranty', base: `What was the warranty registration date for serial ${unitOf(c).serial}?`, expect: { route: 'lookup', singleRecord: true, answerValue: null, note: 'registration date not captured in the answer key (only expires/status)' } }),
  (c) => ({ category: 'lookups', tags: ['half-sentence'], base: `Customer at ${c.address}?`, expect: { route: 'lookup', singleRecord: true, answerValue: c.canonicalName } }),
  (c) => ({ category: 'history', base: `Last 3 visits at ${lastName(c.canonicalName)}'s?`, expect: { route: 'lookup', singleRecord: true, answerValue: null } }),
];
customers.forEach((c, idx) => {
  const templateOffsets = [0, 6, 12].map((off) => (idx + off) % TECH_TEMPLATES.length);
  for (const ti of templateOffsets) {
    const t = TECH_TEMPLATES[ti](c);
    add('tech', t.category, t.base, t.expect, t.tags ?? []);
  }
});

/* ============================================================ BOOKKEEPER ===
 * Invoices, quotes, purchase orders, and every money question -- these are
 * the ones that exercise the honest fallback (financials layer not built).
 */
for (const base of [
  "What's the total amount we've invoiced?",
  'How much revenue came in last month?',
  'Which customer has brought in the most revenue?',
  'Do we have any unpaid invoices?',
  "What's our average ticket size?",
  'How many invoices are still outstanding?',
  "What's the total we've collected in maintenance agreement fees?",
  'What did we bill Bracken for his last job?',
]) {
  add('bookkeeper', 'money', base, {
    route: 'analytics', entity: 'documents', unsupported: true, note: 'financials layer',
  });
}
for (const base of [
  'How many invoices did we send this year vs last year?',
  'How many quotes did we send this quarter?',
  'How many invoices have we sent year to date?',
  'How many quotes have we sent since 2022?',
]) {
  add('bookkeeper', 'time', base, {
    route: 'analytics', entity: 'documents', timeRange: null, note: 'time window not in resolveQuestionTimeRange support',
  }, ['time-window-unsupported']);
}
add('bookkeeper', 'time', 'How many invoices did we send in August?', {
  route: 'analytics', entity: 'documents', filters: [{ field: 'documentType', op: 'eq', value: 'invoice' }],
  timeRange: bareMonthRange(8), answerValue: null, note: 'no per-document date breakdown by month in the answer key',
});
add('bookkeeper', 'time', 'How many invoices did we send last month?', {
  route: 'analytics', entity: 'documents', filters: [{ field: 'documentType', op: 'eq', value: 'invoice' }],
  timeRange: LAST_MONTH_RANGE, answerValue: null, note: 'no per-document date breakdown by month in the answer key',
});
add('bookkeeper', 'time', 'How many invoices did we complete in December?', {
  route: 'analytics', entity: 'documents', filters: [{ field: 'documentType', op: 'eq', value: 'invoice' }],
  timeRange: bareMonthRange(12), answerValue: null, note: 'no per-document date breakdown by month in the answer key',
});
for (const base of [
  'Which customers have an invoice but no service ticket?',
  'Which customers have a proposal but no invoice?',
  'Which customers got a proposal that never turned into a signed job?',
  'Which customers have a maintenance agreement but no proposal on file?',
]) {
  add('bookkeeper', 'data-hygiene', base, {
    route: 'analytics', entity: 'customers', unsupported: true,
    note: 'no cross-document-type (has-X-but-not-Y) filter in the closed vocabulary',
  });
}
{
  const n = customers.filter((c) => hasDoc(c, 'maintenance-agreement')).length;
  add('bookkeeper', 'counts-docs', 'How many customers are locked into a maintenance agreement?', {
    route: 'analytics', entity: 'documents', filters: [{ field: 'documentType', op: 'eq', value: 'maintenance-agreement' }],
    answerValue: n,
  });
}
{
  const n = key.documentsByType['purchase-order'];
  add('bookkeeper', 'counts-docs', 'How many purchase orders are on file with us?', {
    route: 'analytics', entity: 'documents', filters: [{ field: 'documentType', op: 'eq', value: 'purchase-order' }],
    answerValue: n,
  });
}
{
  const holders = customers.filter((c) => hasDoc(c, 'maintenance-agreement'));
  const byCityCount = {};
  for (const c of holders) byCityCount[c.city] = (byCityCount[c.city] ?? 0) + 1;
  add('bookkeeper', 'comparisons', 'How many maintenance agreements do we have per city?', {
    route: 'analytics', entity: 'documents', filters: [{ field: 'documentType', op: 'eq', value: 'maintenance-agreement' }], groupBy: 'city',
    answerValue: byCityCount,
  });
}
// per-customer invoice/PO lookups
const BOOKKEEPER_SAMPLE_IDX = [0, 3, 4, 7, 9, 11, 14, 17, 19, 23];
for (const idx of BOOKKEEPER_SAMPLE_IDX) {
  const c = customers[idx];
  add('bookkeeper', 'lookups', `List invoices for ${lastName(c.canonicalName)}`, {
    route: 'retrieval', singleRecord: true, answerValue: c.docs.filter((d) => d.includes('invoice')).length,
  });
}
const PO_SAMPLE_IDX = [1, 4, 7, 9, 11, 15];
for (const idx of PO_SAMPLE_IDX) {
  const c = customers[idx];
  add('bookkeeper', 'lookups', `Do we have a PO on file for the ${lastName(c.canonicalName)} job?`, {
    route: 'lookup', singleRecord: true, answerValue: hasDoc(c, 'purchase-order'),
  });
}

/* ---------------------------------------------------------------- owner: more */
{
  const n = customers.filter((c) => hasDoc(c, 'maintenance-agreement') && unitOf(c).warrantyStatus === 'active').length;
  add('owner', 'two-condition', 'How many customers have both a maintenance agreement and an active warranty?', {
    route: 'analytics', entity: 'customers',
    filters: [{ field: 'documentType', op: 'eq', value: 'maintenance-agreement' }, { field: 'warrantyStatus', op: 'eq', value: 'active' }],
    answerValue: n,
  });
}
add('owner', 'notes', "What's the oldest unit we're still servicing?", {
  route: 'analytics', entity: 'equipment', unsupported: true, note: 'no min/max op in the closed vocabulary (only count/list/groupBy/sum)',
});
add('owner', 'notes', "What's the newest unit we've installed?", {
  route: 'analytics', entity: 'equipment', unsupported: true, note: 'no min/max op in the closed vocabulary (only count/list/groupBy/sum)',
});
{
  const topZip = Object.entries(zipCounts).sort((a, b) => b[1] - a[1])[0];
  add('owner', 'coverage', 'Which zip code has the most customers?', {
    route: 'analytics', entity: 'customers', groupBy: 'zip', answerValue: { zip: topZip[0], count: topZip[1] },
  });
}
{
  const topCounty = Object.entries(key.totals.byCounty).sort((a, b) => b[1] - a[1])[0];
  add('owner', 'coverage', 'Which county has the most customers?', {
    route: 'analytics', entity: 'customers', groupBy: 'county', answerValue: { county: topCounty[0], count: topCounty[1] },
  });
}
for (const brand of ['Trane', 'Rheem']) {
  const total = (byBrand[brand] ?? []).reduce((sum, c) => sum + c.docs.length, 0);
  add('owner', 'two-condition', `How many documents do we have for our ${brand} customers?`, {
    route: 'analytics', entity: 'documents', filters: [{ field: 'brand', op: 'eq', value: brand }], answerValue: total,
  });
}
add('owner', 'technician', 'How many jobs did Ray Sutton do in August?', {
  route: 'analytics', entity: 'serviceVisits', filters: [{ field: 'technician', op: 'eq', value: 'Ray Sutton' }],
  timeRange: bareMonthRange(8), answerValue: null, note: 'no technician ground truth in this corpus',
});
add('owner', 'technician', 'How many jobs did Wyatt Coburn do last month?', {
  route: 'analytics', entity: 'serviceVisits', filters: [{ field: 'technician', op: 'eq', value: 'Wyatt Coburn' }],
  timeRange: LAST_MONTH_RANGE, answerValue: null, note: 'no technician ground truth in this corpus',
});
add('owner', 'time', 'How many units have we installed since January?', {
  route: 'analytics', entity: 'equipment', timeRange: null, note: '"since January" (no year) has no time-range support',
}, ['time-window-unsupported']);
{
  const cutoff = TODAY_YEAR - 5;
  const n = customers.filter((c) => installYear(c) >= cutoff).length;
  add('owner', 'counts-age', 'How many customers have a unit newer than 5 years old?', {
    route: 'analytics', entity: 'equipment', filters: [{ field: 'installYear', op: 'gte', value: cutoff }], answerValue: n,
  });
}

/* ---------------------------------------------------------------- office: more */
{
  const d = customers[14]; // Barbara Delgado, 618 N Power Rd, Casa Grande
  add('office', 'history', 'which tech was at 618 N Power Rd last time', {
    route: 'lookup', singleRecord: true, answerValue: null, note: 'no service-visit history in this corpus',
  }, ['half-sentence']);
  add('office', 'lookups', 'customer at 618 n power rd casa grande', {
    route: 'lookup', singleRecord: true, answerValue: d.canonicalName,
  }, ['typo', 'half-sentence']);
}
{
  const iss = customers[4]; // Amy Isaacson
  add('office', 'lookups', "what's the service address for Amy Isaacson", { route: 'lookup', singleRecord: true, answerValue: iss.address });
}
{
  const p = customers[5]; // David Prentiss
  add('office', 'warranty', 'is the Prentiss unit still under warranty', { route: 'lookup', singleRecord: true, answerValue: unitOf(p).warrantyStatus });
}
{
  const w = customers[6]; // Sandra Wyckoff
  add('office', 'lookups', "what's the serial on the Wyckoff unit", { route: 'lookup', singleRecord: true, answerValue: unitOf(w).serial });
}
add('office', 'lookups', 'do we have the permit for the tucson install', {
  route: 'retrieval', answerValue: null, note: 'question names no specific address; multiple Tucson customers have a permit on file',
});
add('office', 'maintenance-due', "which customers haven't had a tune-up this year", {
  route: 'analytics', entity: 'customers', unsupported: true, note: 'no last-service-date filter in the closed vocabulary',
});
{
  const n = customers.filter((c) => !c.phone).length;
  add('office', 'data-hygiene', 'list customers with missing phone numbers so I can update our records', {
    route: 'analytics', entity: 'customers', filters: [{ field: 'hasPhone', op: 'eq', value: false }], answerValue: n,
  });
}
{
  const e = customers[7]; // Steven Ellison
  add('office', 'maintenance-due', "when's Ellison due for his next filter change", {
    route: 'retrieval', unsupported: true, note: 'no maintenance-schedule field in this corpus',
  });
}
{
  const m = customers[1]; // Thomas Mercer
  add('office', 'lookups', 'does Mercer have a maintenance agreement or just a one-time invoice', {
    route: 'lookup', singleRecord: true, answerValue: hasDoc(m, 'maintenance-agreement'),
  });
}

/* ------------------------------------------------------------ bookkeeper: more */
add('bookkeeper', 'money', 'Who did we buy the most parts from this year?', {
  route: 'analytics', entity: 'documents', unsupported: true, note: 'vendor is free text on the purchase-order doc, not a structured filter field',
});
{
  const n = key.documentsByType.correspondence;
  add('bookkeeper', 'counts-docs', 'How many customer letters have gone out?', {
    route: 'analytics', entity: 'documents', filters: [{ field: 'documentType', op: 'eq', value: 'correspondence' }], answerValue: n,
  });
}
add('bookkeeper', 'data-hygiene', 'How many quotes converted to a signed job this quarter?', {
  route: 'analytics', entity: 'documents', unsupported: true,
  note: 'no cross-document (proposal-to-invoice conversion) filter, and "this quarter" also has no time-range support',
}, ['time-window-unsupported']);
add('bookkeeper', 'money', "What's the average invoice amount for our Trane jobs?", {
  route: 'analytics', entity: 'documents', unsupported: true, note: 'financials layer',
});
add('bookkeeper', 'money', "Which customers still owe us for last month's work?", {
  route: 'analytics', entity: 'customers', unsupported: true, note: 'financials layer',
});
add('bookkeeper', 'data-hygiene', 'How many work orders do we have open right now?', {
  route: 'analytics', entity: 'documents', unsupported: true, note: 'no job-status field in the closed vocabulary',
});
for (const idx of [2, 6, 10, 13, 18]) {
  const c = customers[idx];
  add('bookkeeper', 'lookups', `List invoices for ${lastName(c.canonicalName)}`, {
    route: 'retrieval', singleRecord: true, answerValue: c.docs.filter((d) => d.includes('invoice')).length,
  });
}
for (const idx of [3, 19]) {
  const c = customers[idx];
  add('bookkeeper', 'lookups', `Do we have a PO on file for the ${lastName(c.canonicalName)} job?`, {
    route: 'lookup', singleRecord: true, answerValue: hasDoc(c, 'purchase-order'),
  });
}

/* ================================================================ dedupe
 * Defense in depth: drop any base whose text exactly matches (case/space
 * insensitive) another entry already in this file. Cross-file duplication
 * against scripts/gen-question-bank.mjs's own bases was checked by hand
 * against that script's literal template strings while writing the sections
 * above (different phrasing/entity/persona angle throughout).
 */
{
  const seen = new Set();
  for (let i = HVAC_PERSONA_QUESTIONS.length - 1; i >= 0; i--) {
    const norm = HVAC_PERSONA_QUESTIONS[i].base.trim().toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(norm)) HVAC_PERSONA_QUESTIONS.splice(i, 1);
    else seen.add(norm);
  }
}

/* ============================================================== summary === */
export const HVAC_PERSONA_SUMMARY = (() => {
  const byPersona = {};
  const byCategory = {};
  let derivable = 0;
  let unsupported = 0;
  let timeWindowUnsupported = 0;
  for (const e of HVAC_PERSONA_QUESTIONS) {
    byPersona[e.persona] = (byPersona[e.persona] ?? 0) + 1;
    byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
    if (e.expect.answerValue !== undefined && e.expect.answerValue !== null) derivable++;
    if (e.expect.unsupported) unsupported++;
    if (e.tags.includes('time-window-unsupported')) timeWindowUnsupported++;
  }
  return {
    total: HVAC_PERSONA_QUESTIONS.length,
    byPersona,
    byCategory,
    derivableAnswerValue: derivable,
    unsupported,
    timeWindowUnsupported,
  };
})();
