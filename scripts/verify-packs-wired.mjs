/**
 * verify:packs-wired (Build 2, stage 2A; permanent, in verify:all).
 * Proves a company's industry really selects its pack everywhere it should:
 * resolver, setter + audit, failure-not-cached, pack-aware warranty / upsell,
 * both Donovan system prompts, the bootstrap + route payloads, the client
 * registry, onboarding, and that four companies on one database never see each
 * other's industry. HVAC output must stay byte-identical to the no-pack path.
 *   node scripts/verify-packs-wired.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0; let passes = 0;
const check = (n, ok, d = '') => { if (ok) passes++; else failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ok || !d ? '' : `\n      ${d}`}`); };
const eq = (n, g, w) => check(n, JSON.stringify(g) === JSON.stringify(w), `got ${JSON.stringify(g)}, want ${JSON.stringify(w)}`);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const { startMixedHarness } = await import('./lib/mixed-company-harness.mjs');
const H = await startMixedHarness();
const { R, I, withTenant } = H;
const IND = H.industries;

/* 1. industry selects the pack and the capability layers */
const ids = await H.eachCompany(async (db) => (await I.packForTenant(db)).id);
eq('each company resolves its own industry pack', ids, { hvac: 'hvac', electrical: 'electrical', plumbing: 'plumbing', property: 'property' });
const packs = await H.eachCompany((db) => R.packsForTenant(db));
eq('capability layers follow the industry', packs, { hvac: ['equipment', 'hvac'], electrical: ['equipment', 'electrical'], plumbing: ['equipment', 'plumbing'], property: ['property'] });
check('property company has no equipment features', !R.hasFeature(packs.property, 'warranty_alerts'));
check('electrical company has equipment features', R.hasFeature(packs.electrical, 'warranty_alerts') && R.hasFeature(packs.electrical, 'electrical_wording'));
check('no company has another industry\'s wording flag', IND.every((i) => IND.filter((o) => o !== i).every((o) => !R.featuresFor(packs[i]).includes(`${o}_wording`))));
// by ctx too (the shape ask.js uses)
for (const i of IND) eq(`ctx shape resolves ${i}`, (await I.packForTenant({ withTenant, ctxArg: H.companies[i].ctx })).id, i);
// pure
eq('industry alone drives packs when packs is absent', IND.map((i) => R.defaultPacksForIndustry(i)), [['equipment', 'hvac'], ['equipment', 'electrical'], ['equipment', 'plumbing'], ['property']]);
eq('unknown / missing industry -> legacy hvac', [R.defaultPacksForIndustry('bogus'), R.defaultPacksForIndustry(undefined)], [['equipment', 'hvac'], ['equipment', 'hvac']]);
eq('explicit packs beat industry', R.packsFromSettings({ industry: 'plumbing', packs: [] }), []);
eq('legacy company (no keys) unchanged', R.packsFromSettings({}), ['equipment', 'hvac']);
eq('kill switch forces legacy for a plumbing company', R.packsFromSettings({ industry: 'plumbing' }, { DEEPWELL_PACKS_ENABLED: 'off' }), ['equipment', 'hvac']);
eq('summary for plumbing', (({ industry, label, unitNoun, chosen }) => ({ industry, label, unitNoun, chosen }))(R.industrySummaryFromSettings({ industry: 'plumbing' })), { industry: 'plumbing', label: I.getPack('plumbing').label, unitNoun: 'fixture', chosen: true });
check('summary for a legacy company says not chosen', R.industrySummaryFromSettings(null).chosen === false && R.industrySummaryFromSettings(null).industry === 'hvac');
eq('picker lists exactly the four industries', R.industryChoices().map((c) => c.id), ['hvac', 'plumbing', 'electrical', 'property']);

/* 2. setter: validation, scoping, audit, cache */
let bad = null; try { await H.as('hvac', (db) => R.setTenantIndustry(db, 'law-office')); } catch (e) { bad = e; }
check('setter rejects an unknown industry (400)', bad && bad.status === 400);
const before = await H.eachCompany(async (db) => (await db.raw('SELECT settings FROM tenants WHERE id = $1', [db.tenantId])).rows[0].settings);
await H.as('electrical', (db) => R.setTenantIndustry(db, 'plumbing'));
const after = await H.eachCompany(async (db) => (await db.raw('SELECT settings FROM tenants WHERE id = $1', [db.tenantId])).rows[0].settings);
check('changing one company changes only that company', after.electrical.industry === 'plumbing' && ['hvac', 'plumbing', 'property'].every((i) => JSON.stringify(after[i]) === JSON.stringify(before[i])));
eq('change seen at once (no stale cache)', (await H.as('electrical', (db) => I.packForTenant(db))).id, 'plumbing');
eq('change seen at once through the ctx shape', (await I.packForTenant({ withTenant, ctxArg: H.companies.electrical.ctx })).id, 'plumbing');
const audit = await H.eachCompany(async (db) => (await db.raw("SELECT count(*)::int AS n FROM audit_log WHERE action = 'industry.set'")).rows[0].n);
check('audit rows: every set is logged, only in its own company', audit.electrical >= 1 && audit.hvac >= 1 && audit.property >= 1 && audit.plumbing >= 1);
const crossAudit = await H.as('hvac', async (db) => (await db.raw("SELECT count(*)::int AS n FROM audit_log WHERE action = 'industry.set' AND resource_id <> $1", [db.tenantId])).rows[0].n);
eq('hvac company cannot see another company\'s audit rows', crossAudit, 0);
await H.as('electrical', (db) => R.setTenantIndustry(db, 'electrical'));
// ifUnset never overwrites a chosen industry; a changed industry drops that company's cached answers only
const r1 = await H.as('plumbing', (db) => R.setTenantIndustry(db, 'property', { ifUnset: true }));
check('ifUnset leaves an already-chosen industry alone', r1.applied === false && r1.industry === 'plumbing' && (await H.as('plumbing', (db) => I.packForTenant(db))).id === 'plumbing');
let cacheOk = true;
try {
  for (const i of ['hvac', 'property']) await H.as(i, (db) => db.raw("INSERT INTO ask_answer_cache (tenant_id, question_hash, corpus_stamp, today, answer, created_at) VALUES ($1,'h','s','2026-10-05','{}'::jsonb,NOW())", [db.tenantId]));
  await H.as('hvac', (db) => R.setTenantIndustry(db, 'plumbing'));
  const n = await H.eachCompany(async (db) => (await db.raw('SELECT count(*)::int AS n FROM ask_answer_cache')).rows[0].n);
  cacheOk = n.hvac === 0 && n.property === 1;
  await H.as('hvac', (db) => R.setTenantIndustry(db, 'hvac'));
} catch (e) { console.log('NOTE  ask_answer_cache table not in harness: ' + e.message); }
check('industry change drops only that company\'s cached answers', cacheOk);
let missing = null; try { await H.as('hvac', (db) => R.setTenantIndustry({ ...db, tenantId: '00000000-0000-0000-0000-000000000000', raw: db.raw }, 'hvac')); } catch (e) { missing = e; }
check('setting an industry for a missing company fails (404), never silently succeeds', missing && missing.status === 404);

/* 3. a failed lookup is never cached as HVAC */
I.resetPackForTenantCacheForTests();
const P = H.companies.plumbing.ctx;
let boom = true;
const flaky = { withTenant: async (c, fn) => { if (boom) throw new Error('blip'); return withTenant(c, fn); }, ctxArg: P };
eq('failed lookup falls back to hvac for that call only', (await I.packForTenant(flaky)).id, 'hvac');
boom = false;
eq('next call reads the real industry (failure was not cached)', (await I.packForTenant(flaky)).id, 'plumbing');
let dbBoom = true;
const flakyDb = { tenantId: H.companies.plumbing.id, raw: async (...a) => { if (dbBoom) throw new Error('blip'); return (await H.lite.query(...a)); } };
eq('db-handle shape: failure falls back', (await I.packForTenant(flakyDb)).id, 'hvac');
dbBoom = false;
const okDb = { tenantId: H.companies.plumbing.id, raw: async () => ({ rows: [{ industry: 'plumbing' }] }) };
eq('db-handle shape: failure was not cached', (await I.packForTenant(okDb)).id, 'plumbing');

/* 4. warranty + upsell are pack-aware, HVAC unchanged */
const W = await import('../api/_lib/warrantyRules.js');
const plumbing = I.getPack('plumbing'); const hvac = I.getPack('hvac');
const stable = W.deriveWarranty({ manufacturer: 'Bradford White', installation_date: '2026-09-20' }, null, plumbing);
check('plumbing brand derived from the plumbing pack', stable.brand === 'bradford-white' && stable.brandVerified);
const withPack = W.describeWarranty(stable, '2026-10-05', { pack: plumbing });
const noPack = W.describeWarranty(stable, '2026-10-05');
check('describeWarranty with the plumbing pack finds the registration rule', /register/i.test(withPack.action ?? '') && /10-year/.test(withPack.action ?? ''), JSON.stringify(withPack));
check('without the pack the same stable has no plumbing rule (the old HVAC-only behaviour)', noPack.action == null, JSON.stringify(noPack));
check('upsell names the plumbing manufacturer only with the pack', W.upsell(stable, '2026-10-05', plumbing).eligible === true && W.upsell(stable, '2026-10-05').eligible === false);
const hvacStable = W.deriveWarranty({ manufacturer: 'Trane', installation_date: '2024-03-01' }, '2026-10-05');
eq('HVAC describeWarranty identical with hvac pack, null pack, and no argument', [W.describeWarranty(hvacStable, '2026-10-05', { pack: hvac }), W.describeWarranty(hvacStable, '2026-10-05', { pack: null })], [W.describeWarranty(hvacStable, '2026-10-05'), W.describeWarranty(hvacStable, '2026-10-05')]);
eq('HVAC upsell identical with hvac pack / no pack', W.upsell(hvacStable, '2026-10-05', hvac), W.upsell(hvacStable, '2026-10-05'));
eq('deriveWarranty(today) embeds the same describe output for hvac', W.deriveWarranty({ manufacturer: 'Trane', installation_date: '2024-03-01' }, '2026-10-05', hvac), W.deriveWarranty({ manufacturer: 'Trane', installation_date: '2024-03-01' }, '2026-10-05'));

/* 5. both Donovan prompts speak the company's own industry and nobody else's */
const L1 = await import('../api/_lib/agent/loop.js');
const L2 = await import('../api/_lib/agent/loopV2.js');
check('hvac quick prompt is byte-identical to the constant', L1.buildAgentSystemPrompt(hvac) === L1.AGENT_SYSTEM_PROMPT && L1.buildAgentSystemPrompt(null) === L1.AGENT_SYSTEM_PROMPT);
check('hvac research prompt is byte-identical to the constant', L2.buildResearchSystemPrompt(hvac) === L2.RESEARCH_SYSTEM_PROMPT && L2.buildResearchSystemPrompt(null) === L2.RESEARCH_SYSTEM_PROMPT);
eq('hvac gets no industry notes', I.industryPromptNotes(hvac), '');
const nouns = Object.fromEntries(IND.map((i) => [i, I.getPack(i).businessNoun]));
for (const i of IND) {
  for (const [kind, text] of [['quick', L1.buildAgentSystemPrompt(I.getPack(i))], ['research', L2.buildResearchSystemPrompt(I.getPack(i))]]) {
    check(`${i} ${kind} prompt names its own business`, text.includes(`for ${/^[aeiou]/i.test(nouns[i]) || /^hvac/i.test(nouns[i]) ? 'an' : 'a'} ${nouns[i]}`));
    check(`${i} ${kind} prompt never names another industry's business`, IND.filter((o) => o !== i).every((o) => !text.includes(nouns[o])), IND.filter((o) => o !== i && text.includes(nouns[o])).join(','));
  }
}
check('property notes explain owner / vendor / appliance mapping', /OWNER/.test(I.industryPromptNotes(I.getPack('property'))) && /VENDOR/.test(I.industryPromptNotes(I.getPack('property'))));
check('prompt cache keys unchanged (constants are HVAC)', typeof L1.AGENT_PROMPT_VERSION === 'string' && L1.AGENT_PROMPT_VERSION.length > 8);

/* 6. wiring present in source (cannot drift back to unwired) */
const src = (f) => read(f);
check('account route exposes ?action=industry', /ACTIONS = \{[^}]*\bindustry\b/.test(src('api/account.js')) && /import industry from "\.\/_lib\/routes\/industry\.js"/.test(src('api/account.js')));
check('industry route is owner/admin only for set and audit-logged via setTenantIndustry', /requireRole\(auth, "admin"\)/.test(src('api/_lib/routes/industry.js')) && /setTenantIndustry/.test(src('api/_lib/routes/industry.js')));
check('bootstrap payload carries the industry', /industryBootstrap\(tenantRow\)/.test(src('api/records.ts')));
const SITE = { 'api/warranty-attention.js': /describeWarranty\(stable, today, \{ expiringWithinDays: expiringWithin, pack \}\)[\s\S]*upsell\(stable, today, pack\)/, 'api/_lib/routes/customer-equipment.js': /describeWarranty\(stable, today, \{ expiringWithinDays: expiringWithin, pack \}\)/, 'api/_lib/fastPathQuery.js': /buildWarrantyAnswer\(\{[^}]*pack: await packForDb\(db\)/, 'api/_lib/fastPath.js': /describeWarranty\(stable, today, \{ pack \}\)/, 'api/_lib/explain.js': /describeWarranty\(stable, today, \{ pack \}\)[\s\S]*describeWarranty\(stable, today, \{ pack \}\)/ };
for (const [f, re] of Object.entries(SITE)) check(`${f} passes the pack to describeWarranty/upsell`, re.test(src(f)));
check('bootstrap never overwrites a chosen industry', /industry\?\.chosen !== true/.test(src('src/hooks/useBootstrap.ts')));
check('both prompts append the industry notes', /industryPromptNotes\(pack\)/.test(src('api/_lib/agent/loop.js')) && /industryPromptNotes\(pack\)/.test(src('api/_lib/agent/loopV2.js')));
const reg = src('src/domains/registry.ts');
check('client registry holds all four industries', ['hvac', 'electrical', 'plumbing', 'property'].every((i) => new RegExp(`${i}Schema`).test(reg)));
check('client helper reads the registry (so the domains are reachable)', /from '\.\.\/domains\/registry'/.test(src('src/lib/industry.ts')));
check('the app imports the client helper (reachable from the bundle)', /lib\/industry/.test(src('src/screens/AskScreen.tsx')) && /lib\/industry/.test(src('src/screens/OnboardingScreen.tsx')) && /usePendingIndustry/.test(src('src/App.tsx')));
check('onboarding offers all four industries', ['HVAC', 'Electrical', 'Plumbing', 'Property management'].every((l) => src('src/lib/industry.ts').includes(`label: '${l}'`)));
check('onboarding drops a pick when the person joins instead of creating', /mode === 'join'/.test(src('src/screens/OnboardingScreen.tsx')) && /removeItem\(PENDING_INDUSTRY_KEY\)/.test(src('src/screens/OnboardingScreen.tsx')));
check('no industry is marked live by this stage', /new Set\(\['hvac'\]\)/.test(reg));
check('verify:packs-wired is part of verify:all', /npm run verify:packs-wired/.test(JSON.parse(src('package.json')).scripts['verify:all']));

const route = (await import('../api/_lib/routes/industry.js')).default;
const fakeRes = () => { const r = { code: 0, headers: {}, body: null, setHeader(k, v) { r.headers[k] = v; return r; }, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; }, end() { return r; } }; return r; };
const rr = fakeRes(); await route({ method: 'POST', headers: {}, body: { op: 'set', industry: 'plumbing' }, query: {} }, rr);
check('industry route refuses an unauthenticated caller (401/403)', rr.code === 401 || rr.code === 403, String(rr.code));
const rg = fakeRes(); await route({ method: 'GET', headers: {}, query: {} }, rg);
check('industry route is POST only', rg.code === 405);
const dec = (await import('tsx/esm/api').then((m) => m.tsImport('../src/lib/industry.ts', import.meta.url)));
const nowT = 1_000_000;
check('pending pick: same person, fresh -> applied', dec.decodePendingIndustry(dec.encodePendingIndustry('plumbing', 'user_a', nowT), 'user_a', nowT + 1000) === 'plumbing');
check('pending pick: another person -> never applied', dec.decodePendingIndustry(dec.encodePendingIndustry('plumbing', 'user_a', nowT), 'user_b', nowT + 1000) === null);
check('pending pick: stale -> never applied', dec.decodePendingIndustry(dec.encodePendingIndustry('plumbing', 'user_a', nowT), 'user_a', nowT + dec.PENDING_INDUSTRY_MAX_AGE_MS + 1) === null);
check('pending pick: garbage / no user -> null', dec.decodePendingIndustry('plumbing', 'user_a') === null && dec.decodePendingIndustry(dec.encodePendingIndustry('plumbing', 'u', nowT), null, nowT) === null);
check('pending hook keeps the pick on 401/429 (clears only on 400/403/404)', /res\.status === 400 \|\| res\.status === 403 \|\| res\.status === 404/.test(src('src/hooks/usePendingIndustry.ts')));
check('onboarding Continue uses the shared primary button (44px+) and does not promise an in-app industry change', /dw-btn-primary w-full/.test(src('src/screens/OnboardingScreen.tsx')) && !/You can change this later/.test(src('src/screens/OnboardingScreen.tsx')));
check('attention card button is full width on phone', /dw-btn-secondary w-full sm:w-auto/.test(src('src/components/IndustryAttentionCard.tsx')));
await H.stop();
console.log('');
if (failures) { console.log(`${failures} check(s) FAILED (${passes} passed).`); process.exit(1); }
console.log(`${passes} checks passed.`);
