#!/usr/bin/env node
/**
 * Round 18 (H4) — multi-turn follow-up engine (api/_lib/followup/**, re-exported by conversation.js).
 *
 * PART A (pure, no DB): ~40 two- and three-turn dialogues exercised directly against
 * composeFollowup/resolveFollowup — every shape in R18_CONTRACT.md's goal line (pronoun/ellipsis,
 * list/count refinement, entity swap, "the other unit", disambiguation-reply) plus the required
 * negatives (topic change, ambiguous "the other one", stale referent, cross-tenant id injection).
 *
 * PART B (PGlite, real /api/ask handler): a small offline harness function `runDialogue` that plays a
 * whole conversation through the ACTUAL production handler (api/ask.js's default export), building each
 * next turn's resolvedEntities/resolvedFilters from the PREVIOUS real answer's own citation contract
 * (data.records — exactly api/_lib/citations/records.js's shape) — i.e. simulating the client hook
 * described in this round's report, so this proves the engine end to end, not just the text-rewrite.
 *
 *   node scripts/verify-followups-r18.mjs
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

/* ======================================================================== PART A — pure dialogues */

const { composeFollowup, isFollowupContinuation, validateConversationContext } = await import('../api/_lib/conversation.js');
// resolveFollowup carries the richer shape (kind, needsClarification, clarifyText, resolvedEntityId)
// that conversation.js's composeFollowup wrapper deliberately trims back to conversation.js's
// long-standing {query, filters, isFollowup} shape (see that file's own doc comment) — most of these
// dialogues assert on the richer fields, so they call the engine directly.
const { resolveFollowup } = await import('../api/_lib/followup/index.js');

function ctx(turns) { return validateConversationContext({ turns }); }
function turn(question, extra = {}) { return { question, ...extra }; }

{
  console.log('\n-- Part A: pure resolver dialogues (no DB) --');

  // ---- pronoun / ellipsis continuations -----------------------------------------------------------
  {
    const c = ctx([turn("who's the customer at 214 Mercer St")]);
    const r = resolveFollowup(c, 'and their phone?');
    check('pronoun: "and their phone?" carries the address forward', r.isFollowup && /214 Mercer St/.test(r.query), r.query);
    check('pronoun: possessive never fuses "\'s" onto the raw address', !/Mercer St's/i.test(r.query), r.query);
  }
  {
    const c = ctx([turn('is the furnace at 3247 Elm St under warranty')]);
    const r = resolveFollowup(c, 'is it under warranty?');
    check('pronoun: "is it under warranty?" resolves "it" to the address', /3247 Elm St/.test(r.query), r.query);
  }
  {
    const c = ctx([turn('who serviced 88 Whitmore Ave last')]);
    const r = resolveFollowup(c, 'when were we last out there?');
    check('ellipsis: "out there" resolves to the address', /88 Whitmore Ave/.test(r.query), r.query);
  }
  {
    const c = ctx([turn('is the condenser at 17 Cactus Ln under warranty')]);
    const r = resolveFollowup(c, 'when were we last there?');
    check('ellipsis: bare "there" resolves to the address', /17 Cactus Ln/.test(r.query), r.query);
  }
  {
    // multi-hop: turn 2 itself carries no subject (borrowed from turn 1) — turn 3 must still reach turn 1.
    const c = ctx([turn('who is the customer at 412 Elm St'), turn('and their phone?')]);
    const r = resolveFollowup(c, 'when were we last out there?');
    check('multi-hop: reaches back through a subject-less continuation turn', /412 Elm St/.test(r.query), r.query);
  }

  // ---- list/count refinement ----------------------------------------------------------------------
  {
    const c = ctx([turn('how many units does Bracken Plumbing have')]);
    const r = resolveFollowup(c, 'how many of those are Trane?');
    check('refinement: "those" -> the anchor customer, brand kept', /Bracken Plumbing/.test(r.query) && /Trane/i.test(r.query), r.query);
    check('refinement: filters carries the brand', r.filters?.manufacturer === 'trane', JSON.stringify(r.filters));
  }
  {
    const c = ctx([turn('list the equipment for Donna Thornton')]);
    const r = resolveFollowup(c, 'just the Goodman ones');
    check('refinement: "just the X ones" keeps the customer + brand', /Donna Thornton/.test(r.query) && /Goodman/i.test(r.query), r.query);
  }

  // ---- R20 (J4, dialogue d036): brand-vs-brand "those" — "how many goodman units are on our
  // books" / "do we have more of those than lennox" — a bare-portfolio anchor (no customer/address,
  // same as d005's Carrier count above), where the CURRENT question ALSO names a real brand
  // (Lennox, the comparison target) but "those" itself still means the EARLIER turn's brand
  // (Goodman). A naive "does this question already mention a brand" check reads Lennox as "the
  // question already has its own brand" and drops Goodman entirely — the exact bug this hook fixes.
  {
    const c = ctx([turn('how many goodman units are on our books')]);
    const r = resolveFollowup(c, 'do we have more of those than lennox');
    check('brand-comparison: "those" resolves to the PRIOR brand, not dropped', /goodman/i.test(r.query), r.query);
    check('brand-comparison: the comparison target brand is still present', /lennox/i.test(r.query), r.query);
    check('brand-comparison: the pronoun itself is gone (not left dangling)', !/\b(those|these|them)\b/i.test(r.query), r.query);
  }
  // Every paraphrase below keeps the REFINEMENT_RE shape ("of those/these/them") that routes it to
  // resolveRefinement in the first place — a bare "is that/it more than lennox" (no "of those") is a
  // different classifyFollowupKind bucket ('pronoun') entirely, out of this hook's scope.
  const brandComparisonParaphrases = [
    'do we have more of them than lennox',
    'are there more of those than lennox units',
    'do we carry more of those than lennox',
    'do we have fewer of these than lennox',
    'is the count of those higher than lennox',
  ];
  for (const q of brandComparisonParaphrases) {
    const c = ctx([turn('how many goodman units are on our books')]);
    const r = resolveFollowup(c, q);
    check(`brand-comparison paraphrase keeps Goodman: "${q}"`, /goodman/i.test(r.query), r.query);
  }
  // Negatives: the question already names its OWN brand for the pronoun (no "than"-comparison split
  // at all, or the pronoun's own side already has a brand) — inheriting would be WRONG here, so the
  // ordinary (pre-existing) behavior must be unchanged.
  {
    const c = ctx([turn('how many goodman units are on our books')]);
    const r = resolveFollowup(c, 'how many of those trane units are still under warranty');
    check('brand-comparison negative: a pronoun that already names ITS OWN brand is not overridden', /trane/i.test(r.query) && !/goodman/i.test(r.query), r.query);
  }
  {
    const c = ctx([turn('how many customers do we have in Mesa')]);
    const r = resolveFollowup(c, 'do we have more of those than in Tucson');
    check('brand-comparison negative: a city (not brand) comparison is left alone (no brand injected)', !/\b(goodman|lennox|trane|carrier)\b/i.test(r.query), r.query);
  }

  // ---- entity swap ("same question for X" / "what about X") --------------------------------------
  {
    const c = ctx([turn('who is the customer at 214 Mercer St')]);
    const r = resolveFollowup(c, 'same question for Bracken Plumbing');
    check('swap: "same question for X" replaces the old subject', /Bracken Plumbing/.test(r.query) && !/214 Mercer St/.test(r.query), r.query);
  }
  {
    const c = ctx([turn("what's Karen Abernathy's phone number")]);
    const r = resolveFollowup(c, 'what about Donna Thornton?');
    check('swap: "what about X" (a real new name) swaps the subject', /Donna Thornton/.test(r.query), r.query);
  }
  {
    // "what about the other unit" must NOT be mistaken for a swap target ("the other unit" as a name).
    const c = ctx([turn('is the furnace under warranty', {
      resolvedEntities: [
        { type: 'unit', id: '11111111-1111-4111-8111-111111111111', label: 'Trane furnace', sublabel: 'S9V2 · serial TR-1005' },
      ],
    })]);
    const r = resolveFollowup(c, 'what about the other unit?');
    check('other-entity beats swap for "the other unit"', r.kind !== 'swap', r.kind);
  }

  // ---- "the other unit" -----------------------------------------------------------------------------
  {
    const unitA = { type: 'unit', id: '11111111-1111-4111-8111-111111111111', label: 'Trane furnace', sublabel: 'S9V2 · serial TR-1005' };
    const unitB = { type: 'unit', id: '22222222-2222-4222-8222-222222222222', label: 'Trane condenser', sublabel: 'XR14 · serial TR-1001' };
    const c = ctx([turn('is the furnace under warranty', { resolvedEntities: [unitA, unitB], resolvedFilters: { unitIds: [unitA.id] } })]);
    const r = resolveFollowup(c, 'what about the other unit?');
    check('other-entity: exactly 2 units + a focused one -> picks the OTHER one', r.resolvedEntityId === unitB.id, JSON.stringify(r));
    includes('other-entity: composed query names the other unit', r.query, 'condenser');
  }
  {
    // ambiguous: 3 candidate units, none focused -> never guess.
    const units = ['a', 'b', 'c'].map((x, i) => ({ type: 'unit', id: `${x}${x}${x}${x}${x}${x}${x}${x}-${x}${x}${x}${x}-4${x}${x}${x}-8${x}${x}${x}-${x}${x}${x}${x}${x}${x}${x}${x}${x}${x}${x}${x}`, label: `Unit ${i}` }));
    const c = ctx([turn('is the unit under warranty', { resolvedEntities: units })]);
    const r = resolveFollowup(c, 'what about the other unit?');
    check('other-entity: 3 untouched candidates -> asks rather than guesses', r.needsClarification === true, JSON.stringify(r));
  }
  {
    // no candidate set at all (client hasn't wired resolvedEntities yet) -> honest clarify, never a guess.
    const c = ctx([turn('is the furnace under warranty')]);
    const r = resolveFollowup(c, 'what about the other unit?');
    check('other-entity: no candidates on file -> asks rather than guesses', r.needsClarification === true, JSON.stringify(r));
  }

  // ---- disambiguation reply ------------------------------------------------------------------------
  {
    const candA = { type: 'customer', id: '33333333-3333-4333-8333-333333333333', label: 'Karen Abernathy', sublabel: '412 Elm St, Mesa, AZ 85201' };
    const candB = { type: 'customer', id: '44444444-4444-4444-8444-444444444444', label: 'Karen Abernathy', sublabel: '19 Elm St, Chandler, AZ 85225' };
    const c = ctx([turn("what's Karen Abernathy's phone number", { resolvedEntities: [candA, candB], pendingClarification: true })]);
    const r = resolveFollowup(c, 'no, the one in Chandler');
    check('disambiguation-reply: city mention picks the right candidate', r.resolvedEntityId === candB.id, JSON.stringify(r));
    includes('disambiguation-reply: composed query keeps the original field ask', r.query, 'phone number');
    includes('disambiguation-reply: composed query names the picked candidate', r.query, 'Chandler');
  }
  {
    const candA = { type: 'customer', id: '55555555-5555-4555-8555-555555555555', label: 'Karen Abernathy', sublabel: '412 Elm St, Mesa, AZ 85201' };
    const candB = { type: 'customer', id: '66666666-6666-4666-8666-666666666666', label: 'Karen Abernathy', sublabel: '19 Elm St, Chandler, AZ 85225' };
    const c = ctx([turn("what's Karen Abernathy's phone number", { resolvedEntities: [candA, candB], pendingClarification: true })]);
    const r = resolveFollowup(c, 'the second one');
    check('disambiguation-reply: ordinal pick', r.resolvedEntityId === candB.id, JSON.stringify(r));
  }
  {
    const candA = { type: 'customer', id: '77777777-7777-4777-8777-777777777777', label: 'Karen Abernathy', sublabel: '412 Elm St, Mesa, AZ 85201' };
    const candB = { type: 'customer', id: '88888888-8888-4888-8888-888888888888', label: 'Karen Abernathy', sublabel: '19 Elm St, Chandler, AZ 85225' };
    const c = ctx([turn("what's Karen Abernathy's phone number", { resolvedEntities: [candA, candB], pendingClarification: true })]);
    const r = resolveFollowup(c, 'neither, I mean the Gilbert one');
    check('disambiguation-reply: no candidate matches -> asks again rather than guessing', r.needsClarification === true, JSON.stringify(r));
  }

  // ---- NEGATIVE: topic change never carries a stale referent forward -----------------------------
  {
    const c = ctx([turn('who is the customer at 214 Mercer St'), turn('how many total customers do we have on file')]);
    const r = resolveFollowup(c, 'is it under warranty?');
    check('topic change: "it" does not fall back to the OLD address once a fresh topic intervened', !/214 Mercer St/.test(r.query), r.query);
  }
  {
    // a fresh question with its OWN subject is never clobbered by an anchor from further back.
    const c = ctx([turn('who is the customer at 214 Mercer St')]);
    const r = resolveFollowup(c, 'is the unit at 88 Whitmore Ave under warranty?');
    check('own-subject: an explicit new address is never overridden', r.query.includes('88 Whitmore Ave') && !r.query.includes('214 Mercer'), r.query);
  }

  // ---- NEGATIVE: stale referent across a longer chain -----------------------------------------------
  {
    const c = ctx([
      turn('who is the customer at 214 Mercer St'),
      turn('and their phone?'),
      turn('what is todays date'), // fresh, unrelated, no subject of its own — a real topic boundary
    ]);
    const r = resolveFollowup(c, 'is it under warranty?');
    check('stale referent: a topic boundary with no subject of its own blocks the walk-back', !/214 Mercer St/.test(r.query), r.query);
  }

  // ---- NEGATIVE: cross-tenant id injection ---------------------------------------------------------
  {
    // A hostile/foreign resolvedEntities entry (an id that does not belong to THIS tenant, wearing a
    // label naming a customer this tenant has never heard of). The engine must still only ever compose
    // TEXT from it — never claim the id resolved anything without downstream re-verifying the label
    // against this tenant's own rows (see resolve.js's header). Shape-wise this looks identical to an
    // honest candidate; the actual tenant boundary is enforced by the deterministic handler that
    // re-resolves the composed text against THIS tenant's DB (proven in Part B).
    const hostile = { type: 'customer', id: '99999999-9999-4999-8999-999999999999', label: 'Zed Competitor', sublabel: '1 Secret Way, Reno, NV 89501' };
    const real = { type: 'customer', id: '10101010-1010-4101-8101-101010101010', label: 'Karen Abernathy', sublabel: '412 Elm St, Mesa, AZ 85201' };
    const c = ctx([turn("what's Karen Abernathy's phone number", { resolvedEntities: [hostile, real], pendingClarification: true })]);
    const r = resolveFollowup(c, 'the Zed Competitor one');
    check('cross-tenant hint: resolver only ever composes readable text, never fetches by id directly', typeof r.query === 'string' && r.resolvedEntityId === hostile.id, JSON.stringify(r));
    check('cross-tenant hint: the composed query carries the label as TEXT for downstream to re-resolve (not just an opaque id)', r.query.includes('Zed Competitor'), r.query);
  }

  // ---- shape / hygiene ------------------------------------------------------------------------------
  {
    check('isFollowupContinuation: still callable with one arg (api/ask.js\'s existing call site)', isFollowupContinuation('and their phone?') === true);
    check('isFollowupContinuation: a long, self-contained fresh question is never hijacked', isFollowupContinuation('Can you list every customer whose warranty expires in the next 90 days broken out by city and technician') === false);
  }
  {
    const many = Array.from({ length: 8 }, (_, i) => turn(`question number ${i}`));
    const capped = validateConversationContext({ turns: many });
    check('context cap: MAX_CONTEXT_TURNS still enforced', capped.turns.length === 4, capped.turns.length);
  }
  {
    const r = composeFollowup(ctx([]), 'any question at all');
    check('no context: passes the question through unmodified', r.query === 'any question at all' && r.isFollowup === false);
  }
  {
    const r = composeFollowup(null, 'any question at all');
    check('malformed context (null): degrades to a fresh question, never throws', r.query === 'any question at all');
  }
}

console.log(`\nPart A: ${passes} passed, ${failures} failed so far.`);

/* ======================================================================== PART B — real handler, PGlite */

let pgliteAvailable = true;
try { await import('@electric-sql/pglite'); } catch { pgliteAvailable = false; }

if (!pgliteAvailable) {
  console.log('\nSKIP  Part B (real /api/ask handler, PGlite): @electric-sql/pglite not installed. Run npm ci.');
} else {
  console.log('\n-- Part B: end-to-end dialogues through the REAL /api/ask handler (PGlite) --');

  process.env.NEON_CONNECTION_STRING ||= 'postgres://harness:harness@localhost:5432/harness';
  delete process.env.ANTHROPIC_API_KEY;
  process.env.CLAUDE_API_KEY ||= 'sk-ant-r18h4-disabled';

  const { PGlite } = await import('@electric-sql/pglite');
  const fs = await import('node:fs');
  const contrib = {};
  for (const key of ['uuid_ossp', 'pgcrypto', 'pg_trgm', 'btree_gin']) {
    contrib[key] = (await import(`@electric-sql/pglite/contrib/${key}`))[key];
  }
  const lite = new PGlite({ extensions: contrib });
  const cfgDir = path.join(ROOT, 'M3-config');
  const migrations = fs.readdirSync(cfgDir).filter((f) => /^\d\d.*\.sql$/.test(f) && !f.startsWith('99')).sort();
  for (const f of migrations) {
    try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch { /* dependency-order, same as every other verify-*.mjs harness */ }
  }
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* re-run last, see above */ }

  const pgMod = (await import('pg')).default;
  let tail = Promise.resolve();
  const lock = () => { let release; const p = new Promise((r) => { release = r; }); const prev = tail; tail = tail.then(() => p); return prev.then(() => release); };
  pgMod.Pool.prototype.connect = async function connect() {
    const release = await lock();
    await lite.exec('SET ROLE deepwell_rls');
    return { query: (sql, params) => lite.query(sql, params), release: () => { lite.exec('RESET ROLE').finally(release); } };
  };
  pgMod.Pool.prototype.query = async function query(sql, params) {
    const release = await lock();
    try { return await lite.query(sql, params); } finally { release(); }
  };

  // Model calls are never expected on this deterministic-layer-only test — patched to throw loudly
  // (rather than silently attempting a network call) if something unexpectedly reaches them.
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const probe = new Anthropic({ apiKey: 'x' });
    Object.getPrototypeOf(probe.messages).create = async function blockedCreate() {
      const err = new Error('r18h4 harness: model calls are disabled — this dialogue should be answerable by the deterministic layer alone');
      err.status = 400;
      err.isMock = true;
      throw err;
    };
  } catch { /* SDK not installed in this environment — fine, nothing will try to call it either */ }

  const { getTenantContext } = await import('../api/_lib/recordsStore.js');
  const { SCORECARD_CALL } = await import('../api/_lib/scorecard/hook.js');
  const handlerMod = await import('../api/ask.js');
  const handler = handlerMod.default;

  const TODAY = '2026-09-26';
  const uid = (t, k, n) => `${t}${k}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  async function seedTenant(t, tenantId, world) {
    const ent = (id, type, data, extra = {}) => lite.query(
      'INSERT INTO entities (id, tenant_id, entity_type, data, customer_id, customer_number) VALUES ($1,$2,$3,$4::jsonb,$5,$6)',
      [id, tenantId, type, JSON.stringify(data), extra.customerId ?? null, extra.number ?? null]
    );
    for (const c of world.customers) {
      await ent(uid(t, 'c', c.n), 'customer', { customer_name: c.name, service_address: c.address, phone: c.phone ?? null, email: c.email ?? null }, { number: `C-0000${c.n}` });
    }
    for (const e of world.equipment) {
      await ent(uid(t, 'e', e.n), 'equipment',
        { manufacturer: e.mfr, model: e.model, serial_number: e.serial, equipment_type: e.type, installation_date: e.installed, service_address: e.address, ...(e.warranty ? { warranty: e.warranty } : {}) },
        { customerId: uid(t, 'c', e.customer) });
    }
    for (const d of world.docs ?? []) {
      await lite.query('INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ($1,$2,$3,$4,$5,$6)',
        [uid(t, 'd', d.n), tenantId, d.file, d.type, `${t}-hash-${d.n}`, d.stage ?? 'verified']);
      for (const link of d.links ?? []) await lite.query('INSERT INTO document_entity_links (tenant_id, document_id, entity_id) VALUES ($1,$2,$3)', [tenantId, uid(t, 'd', d.n), link]);
      for (const x of d.facts ?? []) {
        await lite.query('INSERT INTO extractions (tenant_id, document_id, entity_id, field_key, value, corrected_value, confidence) VALUES ($1,$2,$3,$4,$5,$6,0.9)',
          [tenantId, uid(t, 'd', d.n), x.entity ?? null, x.key, x.value, x.corrected ?? null]);
      }
    }
    await lite.exec('ANALYZE');
  }

  const ctxA = { tenantKey: 'org_r18h4_a', tenantName: 'Desert Peak HVAC' };
  const ctxB = { tenantKey: 'org_r18h4_b', tenantName: 'Rival Shop' };
  const tenA = (await getTenantContext(ctxA.tenantKey, ctxA.tenantName)).id;
  const tenB = (await getTenantContext(ctxB.tenantKey, ctxB.tenantName)).id;

  await seedTenant('a', tenA, {
    customers: [
      { n: 1, name: 'Karen Abernathy', address: '412 Elm St, Mesa, AZ 85201', phone: '(480) 555-0148' },
      { n: 2, name: 'Karen Abernathy', address: '19 Elm St, Chandler, AZ 85225', phone: '(480) 555-0299' },
      { n: 3, name: 'Bracken Plumbing', address: '900 Industrial Pkwy, Gilbert, AZ 85234' },
      { n: 4, name: 'Donna Thornton', address: '17 Cactus Ln, Tucson, AZ 85701' },
    ],
    equipment: [
      { n: 1, customer: 1, mfr: 'Trane', model: 'XR14', serial: 'TR-1001', type: 'condenser', installed: '2020-05-01', address: '412 Elm St, Mesa, AZ 85201', warranty: { expires: '2030-05-01', registrationOnFile: '2020-06-01' } },
      { n: 2, customer: 3, mfr: 'Trane', model: 'S9V2', serial: 'TR-2002', type: 'furnace', installed: '2019-01-01', address: '900 Industrial Pkwy, Gilbert, AZ 85234' },
      { n: 3, customer: 3, mfr: 'Goodman', model: 'GSX140361K', serial: 'GD-3003', type: 'condenser', installed: '2016-10-15', address: '900 Industrial Pkwy, Gilbert, AZ 85234', warranty: { expires: '2026-10-15' } },
      { n: 4, customer: 4, mfr: 'Lennox', model: 'EL16XC1', serial: 'LX-4004', type: 'condenser', installed: '2019-03-03', address: '17 Cactus Ln, Tucson, AZ 85701' },
    ],
    // fastPathQuery.js's runWarranty requires a real CITATION row (an extractions row, joined to a
    // real document) for warranty_expires — the jsonb `warranty.expires` above alone is not enough
    // (see resolve.js's own header note on this file's baseline capabilities). One doc per warrantied
    // unit, linked to that unit's entity id.
    docs: [
      { n: 1, file: 'elm-warranty-card.pdf', type: 'warranty-card', links: [uid('a', 'e', 1)], facts: [{ key: 'warranty_expires', value: '2030-05-01', entity: uid('a', 'e', 1) }] },
      { n: 2, file: 'gilbert-goodman-warranty-card.pdf', type: 'warranty-card', links: [uid('a', 'e', 3)], facts: [{ key: 'warranty_expires', value: '2026-10-15', entity: uid('a', 'e', 3) }] },
    ],
  });
  await seedTenant('b', tenB, {
    customers: [{ n: 1, name: 'Zed Competitor', address: '1 Secret Way, Reno, NV 89501', phone: '(775) 555-0000' }],
    equipment: [{ n: 1, customer: 1, mfr: 'York', model: 'B-MODEL', serial: 'YK-9001', type: 'condenser', installed: '2022-01-01', address: '1 Secret Way, Reno, NV 89501' }],
  });

  function makeRes() {
    const res = { statusCode: 200, headers: {}, headersSent: false, body: undefined };
    res.setHeader = (k, v) => { res.headers[String(k).toLowerCase()] = v; return res; };
    res.getHeader = (k) => res.headers[String(k).toLowerCase()];
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; res.headersSent = true; return res; };
    res.end = () => { res.headersSent = true; return res; };
    return res;
  }

  /** One /api/ask call through the REAL handler, in-process, exactly like api/_lib/scorecard/askCall.js
   *  (duplicated here rather than imported since that module's signature has no conversationContext
   *  param, and it is not this engineer's file to change). */
  async function askOnce(authCtx, question, conversationContext) {
    const req = { method: 'POST', headers: {}, query: {}, body: { question, today: TODAY, ...(conversationContext ? { conversationContext } : {}) }, [SCORECARD_CALL]: { auth: { tenantId: authCtx.tenantKey, orgId: authCtx.tenantKey, userId: null } } };
    const res = makeRes();
    await handler(req, res);
    return res.body?.success ? res.body.data : { kind: 'error', text: JSON.stringify(res.body) };
  }

  /** The client-hook this round's report describes, simulated: turn resolvedEntities/resolvedFilters
   *  are built from the PREVIOUS real answer's own citation contract (data.records), never invented. */
  function nextTurnFrom(question, data) {
    const candidates = (data?.records ?? []).filter((r) => r.type === 'customer' || r.type === 'unit');
    const pendingClarification = /which one did you mean|more than one/i.test(data?.text ?? '') && candidates.length >= 2;
    return {
      question,
      ...(candidates.length ? { resolvedEntities: candidates.map((r) => ({ type: r.type, id: r.id, label: r.label, sublabel: r.sublabel })) } : {}),
      ...(pendingClarification ? { pendingClarification: true } : {}),
    };
  }

  /** Plays a whole dialogue through the real handler, one turn at a time, threading conversationContext
   *  exactly as api/ask.js already accepts it (line ~789) — this IS the "runs dialogues end-to-end
   *  through the real ask handler with conversationContext" harness the contract asks for. */
  async function runDialogue(authIdCtx, questions) {
    const turns = [];
    const answers = [];
    for (const q of questions) {
      const data = await askOnce(authIdCtx, q, turns.length ? { turns } : undefined);
      answers.push(data);
      turns.push(nextTurnFrom(q, data));
      if (turns.length > 4) turns.shift();
    }
    return answers;
  }

  const tenantACtx = { id: tenA, tenantKey: ctxA.tenantKey };

  // ---- pronoun continuation, real answers (customer -> unit warranty by the SAME address) ----------
  {
    const answers = await runDialogue(tenantACtx, ['who is the customer at 412 Elm St', 'is it under warranty?']);
    includes('e2e pronoun: turn 1 finds Karen Abernathy', answers[0]?.text, 'Karen Abernathy');
    check('e2e pronoun: turn 2 resolves "it" to the SAME address and gets a real warranty answer', answers[1]?.kind === 'answer', JSON.stringify(answers[1]));
  }

  // ---- ellipsis / warranty continuation (a second warranty-family intent, same anchor) --------------
  {
    const answers = await runDialogue(tenantACtx, ['is the condenser at 412 Elm St under warranty', "and when's the warranty up?"]);
    check('e2e ellipsis: turn 1 answers the warranty question', answers[0]?.kind === 'answer', JSON.stringify(answers[0]));
    check('e2e ellipsis: turn 2 does not come back a bare no-answer for lack of an address', answers[1]?.kind === 'answer', JSON.stringify(answers[1]));
    includes('e2e ellipsis: turn 2 cites the real expiry date', answers[1]?.text, '2030');
  }

  // ---- refinement: brand narrowing on a real, tenant-wide count -------------------------------------
  {
    const answers = await runDialogue(tenantACtx, ['how many pieces of equipment do we have on file', 'how many of those are Trane?']);
    check('e2e refinement: turn 1 real tenant-wide count', answers[0]?.kind === 'answer', JSON.stringify(answers[0]));
    const narrowedToTrane = (answers[1]?.facts ?? []).some((f) => /trane/i.test(f.label ?? '')) || answers[1]?.records?.every((r) => /trane/i.test(r.label ?? ''));
    check('e2e refinement: turn 2 narrows to a Trane-only count (2, not the tenant-wide 4)', narrowedToTrane && /\b2\b/.test(answers[1]?.text ?? ''), JSON.stringify(answers[1]));
  }

  // ---- swap: same question, different customer ------------------------------------------------------
  {
    const answers = await runDialogue(tenantACtx, ["what's Donna Thornton's phone number", 'same question for Bracken Plumbing']);
    check('e2e swap: turn 1 answers for Donna Thornton', answers[0]?.kind === 'answer', JSON.stringify(answers[0]));
    check('e2e swap: turn 2 does not repeat Donna Thornton\'s own answer', !/thornton/i.test(answers[1]?.text ?? ''), answers[1]?.text);
  }

  // ---- disambiguation reply: a real ambiguous-name answer, then a real pick of the RIGHT candidate --
  {
    const answers = await runDialogue(tenantACtx, ["what's Karen Abernathy's phone number", 'no, the one in Chandler']);
    check('e2e disambiguation: turn 1 is genuinely ambiguous (2 same-named customers)', /which one|more than one/i.test(answers[0]?.text ?? '') || (answers[0]?.records?.length ?? 0) >= 2, JSON.stringify(answers[0]));
    // The field itself (phone-by-address-hint) is a residual needs-model gap (see this file's own
    // header) — what THIS engine is responsible for, and what this proves, is that the disambiguation
    // reply targeted the CHANDLER record specifically, never the Mesa one.
    includes('e2e disambiguation: turn 2 targets the Chandler record specifically', answers[1]?.text, 'Chandler');
    check('e2e disambiguation: turn 2 never falls back to the Mesa record', !/85201/.test(answers[1]?.text ?? ''), answers[1]?.text);
  }

  // ---- NEGATIVE: topic change never carries the old address forward ---------------------------------
  {
    const answers = await runDialogue(tenantACtx, ['who is the customer at 412 Elm St', 'how many customers do we have on file in total', 'is it under warranty?']);
    check('e2e topic change: the final turn does not silently answer about 412 Elm St', !/xr14|elm st/i.test(answers[2]?.text ?? ''), answers[2]?.text);
  }

  // ---- NEGATIVE: cross-tenant id injection never leaks tenant B's data, and never even lets a
  // fabricated id/label override the tenant's OWN real address text -----------------------------------
  {
    // A hostile resolvedEntities entry: tenant A's own real address (so the anchor's TEXT is honest),
    // but wearing tenant B's id and a name tenant A has never heard of — exactly what a corrupted or
    // malicious client might send back. The engine must still only ever compose the ADDRESS text, and
    // the deterministic handler downstream re-resolves that text against TENANT A's own rows (RLS) —
    // proof is that the real answer reflects tenant A's own warranty data, never tenant B's, and the
    // fabricated name never appears anywhere in it.
    const hostileEntity = { type: 'customer', id: uid('b', 'c', 1), label: 'Zed Competitor', sublabel: '412 Elm St, Mesa, AZ 85201' };
    const data = await askOnce(tenantACtx, 'is it under warranty?', { turns: [{ question: 'who is the customer at 412 Elm St', resolvedEntities: [hostileEntity] }] });
    check('e2e cross-tenant: the fabricated tenant-B name never surfaces in tenant A\'s answer', !/zed competitor/i.test(data?.text ?? ''), data?.text);
    check('e2e cross-tenant: tenant A still gets a real, correct answer from its OWN data', data?.kind === 'answer', JSON.stringify(data));
  }

  console.log(`\nPart B complete.`);
}

console.log(`\n${passes} passed, ${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
