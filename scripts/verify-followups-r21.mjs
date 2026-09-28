#!/usr/bin/env node
/**
 * Round 21 part 2 (M3) — multi-entity list follow-up narrowing (api/_lib/followup/**,
 * conversation.js, src/components/ask/conversationTurn.ts's own shape).
 *
 * ../r21_blind4_clusters.json's C9 finding: the coordinator/follow-up logic (built in Round 18, H4)
 * only narrowed against a SINGLE-entity prior turn (an address/name resolved to exactly one customer
 * or unit) — a prior turn that resolved to a LIST of several entities (a city-scoped count, a
 * brand-filtered equipment list) had no single name/address to stand in for "those"/"them"/"these", so
 * the whole prior turn's scope was silently dropped and the follow-up was answered company-wide
 * instead. Confirmed via 8/10 dialogues-2 failures (e017-e024), all the same shape: "how many
 * customers do we have in <City>" -> "how many of those have a <Brand> unit".
 *
 * The fix (api/_lib/followup/subject.js's subjectFromEntities/pronounReplacement, resolve.js's
 * findAnchor/own-subject gate): a multi-entity prior turn now derives a `listScope` when every
 * candidate shares one grouping value — the same known-city token in every customer's own sublabel
 * (bare "Tempe" from the simple analytics citation shape, or a full "123 Main St, Tempe, AZ 85281"
 * from the multi-filter decompose citation shape — both recognized), or the same brand in every
 * unit's own label — and that scope is folded into the rewritten question ("those" -> "the customers
 * in Tempe") instead of the bare, unscoped noun the engine produced before. Never guessed from a
 * majority: unanimous agreement across every candidate, or no listScope at all.
 *
 * PART A (pure, no DB): resolveFollowup exercised directly — the core multi-entity-narrowing shape
 * (5 own paraphrases), a two-hop chain (city + brand both still present three turns later), corrections
 * and ordinals over a multi-entity list (already-existing disambiguation-reply machinery, confirmed
 * still reachable from an ordinary count answer's own resolvedEntities, not only a flagged "which one
 * did you mean" prompt), a comparison over a prior list's own scope, and the required negatives (topic
 * switch drops context, a stale referent across an intervening unrelated turn, "those" after TWO
 * different resolved sets picks the MOST RECENT one, and a cross-tenant id injection that can only ever
 * compose text, never leak or trust an id).
 *
 * PART B (PGlite, real /api/ask handler): the same two-hop shape played through the ACTUAL production
 * handler against the golden export tenant (scripts/golden/golden-export.json), models blocked — proves
 * the composed question is not just well-formed text but gets a genuinely narrower, correct answer.
 * City/brand combinations here (Phoenix/Trane, Glendale/York, Peoria/Rheem) are deliberately NOT the
 * ones dialogues-2.json's own e017-e024 use (Tempe/Carrier, Mesa/Carrier & Goodman, Scottsdale/Lennox,
 * Chandler/Rheem & Mitsubishi, Gilbert/Rheem, Tucson/Daikin) — this file's own dialogues, not a copy.
 *
 *   node scripts/verify-followups-r21.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const includes = (name, haystack, needle) => check(name, String(haystack ?? '').toLowerCase().includes(String(needle).toLowerCase()), `got: ${JSON.stringify(haystack)}`);
const excludes = (name, haystack, needle) => check(name, !String(haystack ?? '').toLowerCase().includes(String(needle).toLowerCase()), `got: ${JSON.stringify(haystack)}`);

/* ======================================================================== PART A — pure dialogues */

const { validateConversationContext } = await import('../api/_lib/conversation.js');
const { resolveFollowup } = await import('../api/_lib/followup/index.js');

function ctx(turns) { return validateConversationContext({ turns }); }
function turn(question, extra = {}) { return { question, ...extra }; }

/** A synthetic multi-entity customer list resolved to `city`, one of TWO real citation shapes the
 *  production handler actually emits: `bare` mirrors the simple single-filter analytics path (routes/
 *  analytics.js's shapeCustomerRow — sublabel is just the city name), the default mirrors the
 *  multi-filter decompose path (citations/enrich.js — sublabel is a full street address that merely
 *  CONTAINS the city). Both must drive the same fix. */
function cityCustomerList(city, n = 4, { bare = false } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    type: 'customer',
    id: `00000000-0000-4000-8000-${String(city.length * 1000 + i).padStart(12, '0')}`,
    label: `Customer ${i}`,
    sublabel: bare ? city : `${100 + i} Some St, ${city}, AZ 8520${i}`,
  }));
}

console.log('\n-- Part A: pure resolver dialogues (no DB) --');

// ---- core shape: multi-entity CUSTOMER list narrowed by brand (C9) — 5 own paraphrases -------------
{
  const shapes = [
    { city: 'Tempe', bare: true, q: 'how many of those have a Carrier unit', brand: 'carrier' },
    { city: 'Mesa', bare: false, q: 'which of those are Trane', brand: 'trane' },
    { city: 'Chandler', bare: true, q: 'how many of them have a Lennox unit', brand: 'lennox' },
    { city: 'Gilbert', bare: false, q: 'how many of these have a Rheem unit', brand: 'rheem' },
    { city: 'Scottsdale', bare: true, q: 'how many of those have a York unit installed', brand: 'york' },
  ];
  for (const s of shapes) {
    const list = cityCustomerList(s.city, 5, { bare: s.bare });
    const c = ctx([turn(`how many customers do we have in ${s.city}`, { resolvedEntities: list })]);
    const r = resolveFollowup(c, s.q);
    includes(`multi-entity narrowing keeps the city: "${s.q}" (${s.bare ? 'bare' : 'address'} sublabel)`, r.query, s.city);
    check(`multi-entity narrowing keeps the brand: "${s.q}"`, r.filters?.manufacturer === s.brand || new RegExp(s.brand, 'i').test(r.query), r.query);
    check(`multi-entity narrowing: the pronoun itself is gone (not left dangling): "${s.q}"`, !/\b(those|these|them)\b/i.test(r.query), r.query);
  }
}

// ---- two-hop chain: city AND brand both still present a turn later ---------------------------------
{
  const tempeList = cityCustomerList('Tempe', 4, { bare: true });
  const t1 = turn('how many customers do we have in Tempe', { resolvedEntities: tempeList });
  const narrowed = cityCustomerList('Tempe', 2, { bare: false }); // decompose-shape answer to turn 2
  const t2 = turn('how many of those have a Carrier unit', { resolvedEntities: narrowed });
  const r = resolveFollowup(ctx([t1, t2]), 'and how many of those are past their warranty');
  includes('two-hop chain: turn 3 still carries the city forward', r.query, 'Tempe');
  includes('two-hop chain: turn 3 still carries the brand forward (Carrier)', r.query, 'carrier');
  check('two-hop chain: the pronoun is gone', !/\b(those|these|them)\b/i.test(r.query), r.query);
}

// ---- corrections ("no, I meant the X one") over an ORDINARY count answer's own list, not just a
// flagged "which one did you mean" prompt ------------------------------------------------------------
{
  const paraphrases = [
    { q: 'no, I meant the Chandler one', city: 'Chandler' },
    { q: "sorry, I meant the one in Gilbert", city: 'Gilbert' },
    { q: 'no, the Mesa one', city: 'Mesa' },
  ];
  for (const p of paraphrases) {
    const list = [
      { type: 'customer', id: '00000000-0000-4000-8000-000000000101', label: 'Alice', sublabel: 'Tempe' },
      { type: 'customer', id: '00000000-0000-4000-8000-000000000102', label: 'Bob', sublabel: 'Chandler' },
      { type: 'customer', id: '00000000-0000-4000-8000-000000000103', label: 'Carl', sublabel: 'Gilbert' },
      { type: 'customer', id: '00000000-0000-4000-8000-000000000104', label: 'Dana', sublabel: 'Mesa' },
    ];
    const c = ctx([turn('list our customers across the valley', { resolvedEntities: list })]);
    const r = resolveFollowup(c, p.q);
    includes(`correction over a plain multi-entity list picks the named city: "${p.q}"`, r.query, p.city);
  }
}

// ---- ordinals ("the second one", "the last one") over the SAME kind of plain list -------------------
{
  const list = [
    { type: 'customer', id: '00000000-0000-4000-8000-000000000201', label: 'Eve', sublabel: 'Tempe' },
    { type: 'customer', id: '00000000-0000-4000-8000-000000000202', label: 'Frank', sublabel: 'Chandler' },
    { type: 'customer', id: '00000000-0000-4000-8000-000000000203', label: 'Gina', sublabel: 'Gilbert' },
  ];
  const c = ctx([turn('list our customers across the valley', { resolvedEntities: list })]);
  const r1 = resolveFollowup(c, 'the second one');
  check('ordinal "the second one" picks the 2nd candidate', r1.resolvedEntityId === list[1].id, JSON.stringify(r1));
  const r2 = resolveFollowup(c, 'the last one');
  check('ordinal "the last one" picks the final candidate', r2.resolvedEntityId === list[2].id, JSON.stringify(r2));
  const r3 = resolveFollowup(c, 'the first one');
  check('ordinal "the first one" picks the 1st candidate', r3.resolvedEntityId === list[0].id, JSON.stringify(r3));
}

// ---- comparison over a prior turn's own list scope ---------------------------------------------------
{
  const list = cityCustomerList('Tempe', 3, { bare: true });
  const c = ctx([turn('how many customers do we have in Tempe', { resolvedEntities: list })]);
  const r = resolveFollowup(c, 'do we have more of those than the ones in Mesa');
  includes('comparison over prior list scope: keeps the anchor city (Tempe)', r.query, 'Tempe');
  includes('comparison over prior list scope: keeps the comparison target (Mesa)', r.query, 'Mesa');
  check('comparison over prior list scope: no dangling pronoun', !/\bthose\b/i.test(r.query), r.query);
}

// ---- NEGATIVE: topic switch never carries a multi-entity list's scope forward ----------------------
{
  const list = cityCustomerList('Tempe', 3, { bare: true });
  const c = ctx([turn('how many customers do we have in Tempe', { resolvedEntities: list })]);
  const r = resolveFollowup(c, 'how many total documents do we have on file');
  check('topic switch: a genuinely fresh question is not treated as a follow-up at all', r.isFollowup === false, JSON.stringify(r));
  excludes('topic switch: the old city never leaks into the fresh question', r.query, 'Tempe');
}
{
  // A fresh question that names its OWN new city is never clobbered by an older list's city either.
  const list = cityCustomerList('Tempe', 3, { bare: true });
  const c = ctx([turn('how many customers do we have in Tempe', { resolvedEntities: list })]);
  const r = resolveFollowup(c, 'how many customers do we have in Mesa');
  includes('topic switch (new city named): keeps the NEW city', r.query, 'Mesa');
}

// ---- NEGATIVE: "those" after TWO different resolved sets picks the MOST RECENT one, never blends ----
{
  const tempeList = cityCustomerList('Tempe', 3, { bare: true });
  const mesaList = cityCustomerList('Mesa', 4, { bare: true });
  const c = ctx([
    turn('how many customers do we have in Tempe', { resolvedEntities: tempeList }),
    turn('how many customers do we have in Mesa', { resolvedEntities: mesaList }),
  ]);
  const r = resolveFollowup(c, 'how many of those have a Carrier unit');
  includes('ambiguous "those" after two sets: uses the MOST RECENT set (Mesa)', r.query, 'Mesa');
  excludes('ambiguous "those" after two sets: never blends in the OLDER set (Tempe)', r.query, 'Tempe');
}

// ---- NEGATIVE: stale referent — an intervening, genuinely unrelated turn is a topic boundary --------
{
  const tempeList = cityCustomerList('Tempe', 3, { bare: true });
  const c = ctx([
    turn('how many customers do we have in Tempe', { resolvedEntities: tempeList }),
    turn("what is today's date"), // fresh, unrelated, names no subject of its own
  ]);
  const r = resolveFollowup(c, 'how many of those have a Carrier unit');
  excludes('stale referent: the list from BEFORE the topic boundary is not silently reused', r.query, 'Tempe');
}

// ---- NEGATIVE: cross-tenant id injection — a hostile resolvedEntities list can only ever compose
// readable TEXT, never leak a raw id into the query or be trusted for anything else -------------------
{
  const hostileList = [
    { type: 'customer', id: '99999999-9999-4999-8999-000000000001', label: 'Zed Competitor A', sublabel: 'Tempe' },
    { type: 'customer', id: '99999999-9999-4999-8999-000000000002', label: 'Zed Competitor B', sublabel: 'Tempe' },
  ];
  const c = ctx([turn('how many customers do we have in Tempe', { resolvedEntities: hostileList })]);
  const r = resolveFollowup(c, 'how many of those have a Carrier unit');
  includes('cross-tenant list: still composes the (honest) shared city as text', r.query, 'Tempe');
  check('cross-tenant list: no raw id ever appears in the composed query', !/99999999/.test(r.query), r.query);
  check('cross-tenant list: the fabricated customer name never leaks into the query either (no single name resolved)', !/zed competitor/i.test(r.query), r.query);
}

// ---- shape / hygiene: a mixed (non-unanimous) list never fabricates a scope --------------------------
{
  const mixed = [
    { type: 'customer', id: '00000000-0000-4000-8000-000000000301', label: 'Alice', sublabel: 'Tempe' },
    { type: 'customer', id: '00000000-0000-4000-8000-000000000302', label: 'Bob', sublabel: 'Mesa' },
  ];
  const c = ctx([turn('list our customers', { resolvedEntities: mixed })]);
  const r = resolveFollowup(c, 'how many of those have a Carrier unit');
  check('mixed list (no shared city): never invents a place that not every candidate shares', !/\bTempe\b/i.test(r.query) && !/\bMesa\b/i.test(r.query), r.query);
  includes('mixed list: the brand this question DOES name is still kept', r.query, 'carrier');
}

console.log(`\nPart A: ${passes} passed, ${failures} failed so far.`);

/* ======================================================================== PART B — real handler, PGlite */

let pgliteAvailable = true;
try { await import('@electric-sql/pglite'); } catch { pgliteAvailable = false; }

if (!pgliteAvailable) {
  console.log('\nSKIP  Part B (real /api/ask handler, PGlite): @electric-sql/pglite not installed. Run npm ci.');
} else {
  console.log('\n-- Part B: end-to-end dialogues through the REAL /api/ask handler (golden export, PGlite) --');

  process.env.NEON_CONNECTION_STRING ||= 'postgres://harness:harness@localhost:5432/harness';
  delete process.env.ANTHROPIC_API_KEY;
  process.env.CLAUDE_API_KEY ||= 'sk-ant-r21m3-disabled';

  const offline = await import(path.join(ROOT, 'scripts/offline-exam.mjs'));
  const { installPgHarness, installModelBlock, createPGlite, setActiveDatabase, loadExportIntoNewTenant } = offline;
  const { SCORECARD_CALL } = await import(path.join(ROOT, 'api/_lib/scorecard/hook.js'));
  const { default: askHandler } = await import(path.join(ROOT, 'api/ask.js'));
  const fs = await import('node:fs');

  await installPgHarness();
  const modelCounter = await installModelBlock();
  const lite = await createPGlite();
  await setActiveDatabase(lite);
  const exportData = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/golden/golden-export.json'), 'utf8'));
  const { ctx: tenantCtx } = await loadExportIntoNewTenant(lite, exportData, { tenantKey: 'verify-followups-r21', tenantName: 'Verify Followups R21' });
  const auth = { tenantId: tenantCtx.tenantKey, orgId: tenantCtx.tenantName ?? tenantCtx.tenantKey, userId: null };
  const TODAY = '2026-09-26';

  function makeRes() {
    const res = { statusCode: 200, headers: {}, headersSent: false, body: undefined };
    res.setHeader = (k, v) => { res.headers[String(k).toLowerCase()] = v; return res; };
    res.getHeader = (k) => res.headers[String(k).toLowerCase()];
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; res.headersSent = true; return res; };
    res.end = () => { res.headersSent = true; return res; };
    return res;
  }
  async function askOnce(question, conversationContext) {
    const req = { method: 'POST', headers: {}, query: {}, body: { question, today: TODAY, ...(conversationContext ? { conversationContext } : {}) }, [SCORECARD_CALL]: { auth } };
    const res = makeRes();
    modelCounter.n = 0;
    await askHandler(req, res);
    return { data: res.body?.success ? res.body.data ?? null : null, usedModel: modelCounter.n > 0 };
  }
  function nextTurnFrom(question, data) {
    const candidates = (data?.records ?? [])
      .filter((r) => r && (r.type === 'customer' || r.type === 'unit') && typeof r.id === 'string')
      .slice(0, 20)
      .map((r) => ({ type: r.type, id: r.id, ...(r.label ? { label: String(r.label).slice(0, 200) } : {}), ...(r.sublabel ? { sublabel: String(r.sublabel).slice(0, 200) } : {}) }));
    return { question, ...(candidates.length ? { resolvedEntities: candidates } : {}) };
  }

  // Own city/brand combinations (not e017-e024's) — see this file's own header note.
  const combos = [
    { city: 'Phoenix', brand: 'Trane' },
    { city: 'Glendale', brand: 'York' },
    { city: 'Peoria', brand: 'Rheem' },
  ];
  for (const { city, brand } of combos) {
    const q1 = `how many customers do we have in ${city}`;
    const d1 = await askOnce(q1);
    check(`e2e ${city}/${brand}: turn 1 real city count answers deterministically`, d1.data?.kind === 'answer' && !d1.usedModel, JSON.stringify(d1.data));
    const t1 = nextTurnFrom(q1, d1.data);
    const q2 = `how many of those have a ${brand} unit`;
    const d2 = await askOnce(q2, { turns: [t1] });
    check(`e2e ${city}/${brand}: turn 2 answers deterministically (no model fallback)`, !d2.usedModel && d2.data?.kind === 'answer', JSON.stringify(d2.data));
    includes(`e2e ${city}/${brand}: turn 2's answer still names the city (not a company-wide fallback)`, d2.data?.text, city);
    includes(`e2e ${city}/${brand}: turn 2's answer names the brand`, d2.data?.text, brand);
    // The narrowed count can never exceed the whole city's own count from turn 1.
    const cityCount = Number((d1.data?.text ?? '').match(/\d+/)?.[0] ?? NaN);
    const narrowedCount = Number((d2.data?.text ?? '').match(/\d+/)?.[0] ?? NaN);
    check(`e2e ${city}/${brand}: narrowed count (${narrowedCount}) is <= the whole city's count (${cityCount})`, Number.isFinite(cityCount) && Number.isFinite(narrowedCount) && narrowedCount <= cityCount, `${narrowedCount} vs ${cityCount}`);
  }

  console.log('\nPart B complete.');
}

console.log(`\n${passes} passed, ${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
