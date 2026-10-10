/**
 * J1 - jargon dictionary. No network, no real model, PGlite golden data.
 *   tsx scripts/verify-jargon.ts            (add --probe "question" ... to see one answer)
 *
 * Generic made-up questions across industries (trades, property, construction, retail, nonprofit, legal, medical, fleet). Nothing here is
 * keyed to an exam wording: each case is a phrase the dictionary should or should not touch.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
delete process.env.ANTHROPIC_API_KEY;
let failed = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : detail ? `  -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); if (!ok) failed++; };
const realLog = console.log;
console.log = (...a: any[]) => { if (typeof a[0] === 'string' && a[0].startsWith('{"')) return; realLog(...a); };
if (!process.argv.includes('--probe')) { console.warn = () => {}; console.error = () => {}; }

// @ts-ignore plain JS
const J: any = await import(path.join(root, 'api/_lib/lexicon/jargon.js'));
// @ts-ignore
const G: any = await import(path.join(root, 'api/_lib/lexicon/jargon.generated.js'));
// @ts-ignore
const LX: any = await import(path.join(root, 'api/_lib/lookups/lexicon.js'));
// @ts-ignore
const ED: any = await import(path.join(root, 'api/_lib/router/earlyDecline.js'));
// @ts-ignore
const { classifyAll } = await import(path.join(root, 'api/_lib/router/classifyAll.js'));

const TODAY = '2026-10-07';

/* ---------- 1. correct respelling: a jargon phrase becomes the word the lanes read, in any industry */
const RESPELL: Array<[string, string]> = [
  ['show me the pay apps for the Hill project', 'invoices for the Hill project'],            // construction
  ['how many comfort club members do we have', 'maintenance agreement members'],              // HVAC
  ['where is the packing sheet for the Smith delivery', 'delivery ticket for the Smith'],      // supply
  ['any receiving slips this week', 'delivery tickets this week'],
  ['how many price books do we have', 'price lists'],
  ['how many invioces went out', 'invoices went out'],                                         // typo
  ['list the apprentices', 'technicians'],                                                     // trades
  ['which plumbers worked last month', 'technicians worked last month'],
  ['how many commercial accounts do we have', 'customers do we have'],                         // sales
  ['show me the wage statements', 'hr letters'],                                               // HR
  ['do we have workers comp on file', 'insurance certificate on file'],                        // insurance
  ['any proof of insurance expiring soon', 'insurance certificate expiring'],
  ['how many service reports last month', 'service tickets last month'],
  ['legal bills for the Tran matter', 'invoices for the Tran matter'],                         // legal
  ['rental billing for the lift', 'invoice for the lift'],                                     // rental
  ['show me the receit', 'receipt'],                                                           // typo
  ['invoices from the prior month', 'invoices from the last month'],                               // dates
  ['calls in the trailing 30 days', 'calls in the last 30 days'],
  ['revenue for the current year', 'revenue for this year'],
  ['invoices from the previous quarter', 'invoices from the last quarter'],
  ['how many job cards do we have', 'service tickets'],
];
for (const [q, expect] of RESPELL) {
  const r = J.respellJargon(q);
  check(`respell: ${q}`, !!r && r.text.includes(expect), r);
}

/* ---------- 2. ambiguous terms are NOT auto-mapped; names are never jargon */
const AMBIG = ['how many PM visits did we do', 'who is the owner of record', 'what is the policy number', 'how many subs do we use', 'list the units', 'what is the total', 'show the deposit', 'how many leads came in', 'the balance on the Kim account', 'what is the tenant improvement allowance'];
for (const q of AMBIG) check(`ambiguous word stays as typed: ${q}`, J.respellJargon(q) === null, J.respellJargon(q));
for (const t of ['pm', 'sub', 'owner', 'contract', 'unit', 'balance', 'deposit', 'policy']) check(`marked ambiguous by the research: ${t}`, J.isAmbiguousJargon(t));
check('a customer named like jargon is a name, not jargon', J.respellJargon('invoices for Foreman Supply', { tenantVocab: { customers: { words: new Set(['foreman', 'supply']) } } }) === null);

/* ---------- 3. "contract" depends on context */
check('contract alone is the maintenance agreement', LX.canonicalizeWordClasses('how many contracts do we have') === 'how many maintenance agreements do we have');
check('service contract is the maintenance agreement', LX.canonicalizeWordClasses('active service contracts') === 'active maintenance agreements');
for (const q of ['how many employment contracts', 'list vendor contracts', 'the subcontract for Hill', 'construction contract total', 'rental contract end date'])
  check(`contract not rewritten to a maintenance agreement: ${q}`, !/maintenance agreement/.test(LX.canonicalizeWordClasses(q)), LX.canonicalizeWordClasses(q));
check('employment contract is an HR paper', J.respellJargon('how many employment contracts do we have')?.text === 'how many hr letters do we have');
check('vendor contracts are known but not tracked', J.untrackedConcept('how many vendor contracts do we have')?.id === 'other_contracts');


/* ---------- 3b. R3 B1: cross-industry noun families (one positive and one release case each) and untracked concepts */
const FAMILIES: Array<[string, string]> = [
  ['how many tenants do we have', 'customers do we have'], ['how many donors are in Mesa', 'customers are in Mesa'], ['members in Tempe', 'customers in Tempe'],
  ['total of all our bids', 'total of all our quotes'], ['how many estimates did we send', 'quotes did we send'],
  ['how many leases do we hold', 'maintenance agreements do we hold'], ['total value of our retainers', 'maintenance agreements'], ['active service contracts', 'maintenance agreements'],
  ['number of site visits in 2025', 'service tickets in 2025'], ['how many call-outs did we go on', 'service tickets did we go on'], ['maintenance requests in 2024', 'service tickets in 2024'],
  ['how many repair requests do we have', 'repair tickets do we have'],
  ['how many building permits are on file', 'permits are on file'],
  ['how many subcontractors worked on our jobs', 'technicians worked on our jobs'], ['how many staff members are in the service records', 'technicians are in the service records'],
  ['how many move-in inspections are on file', 'inspection reports are on file'], ['guarantees registered in 2024', 'warranties registered in 2024'],
  ['what were our billings in 2024', 'what were our revenue in 2024'],
];
for (const [q, expect] of FAMILIES) { const r = J.respellJargon(q); check(`family respell: ${q}`, !!r && r.text.includes(expect), r); }
const REPAIR = J.respellJargon('how many repair requests do we have');
check('a repair request keeps the repair type (never a work order)', !!REPAIR && !/work order/.test(REPAIR.text) && /repair ticket/.test(REPAIR.text), REPAIR);
const HELD = ['what is the tenant improvement allowance', 'show the member id for Kim', 'list the unit numbers', 'what is the billing address', 'send the billing email to Kim', 'who is the property manager', 'is there a bid bond', 'how many club members', 'show the account balance', 'the biggest bill we sent', 'what is the job site address'];
for (const q of HELD) { const r = J.respellJargon(q); check(`word stays as typed: ${q}`, r === null || !/customer|quote|maintenance agreement|revenue|service ticket/.test(r.text), r); }
check('a name made of a family word is a name', J.respellJargon('invoices for Tenant Services Inc', { tenantVocab: { customers: { words: new Set(['tenant', 'services', 'inc']) } } }) === null);
check('a technician named Crew is a name', J.respellJargon('invoices by Crew Johnson', { tenantVocab: { technicians: { words: new Set(['crew', 'johnson']) } } }) === null);
const NEW_UNTRACKED = [
  "what's the occupancy rate across our properties", 'what is our vacancy rate', "what's the monthly rent roll", 'how much did we collect in donations', 'how many open positions are we hiring for',
  "what's the mileage on the service trucks", 'which customers left us a bad review', 'list the delinquent accounts', 'which tenants are behind on payments', 'what is our headcount',
];
for (const q of NEW_UNTRACKED) { const d = ED.classifyEarlyDecline(q); check(`new untracked family declines: ${q}`, d?.kind === 'off_domain' && !!d.untracked, d); }
for (const q of ['how many donation receipts do we have', 'what is the billing address for Kim', 'who is hiring a technician for 1420 W Main St', 'how many tenants do we have', 'how many technicians do we have', 'what is the review date on invoice #4411'])
  check(`not declined as untracked: ${q}`, !ED.classifyEarlyDecline(q, { hasConversation: true })?.untracked, ED.classifyEarlyDecline(q));
check('a donation receipt is still a receipt', J.respellJargon('how many donation receipts do we have')?.text === 'how many receipts do we have' && J.untrackedConcept('how many donation receipts do we have') === null, J.respellJargon('how many donation receipts do we have'));


/* ---------- 3c. R3 QA fixes: names, retainer, team member */
for (const q of ['did we lease anything to Donor', 'show me Donor', 'did we bid for Tenant', 'any estimates with Member']) check(`a typed name is never dropped by a generic respell: ${q}`, J.respellJargon(q) === null, J.respellJargon(q));
check('a known technician name still lets the family respell', J.respellJargon('how many call-outs did Ray Sutton go on', { tenantVocab: { technicians: { words: new Set(['ray', 'sutton']) } } })?.text.includes('service tickets'));
check('a place filter does not block the family respell', J.respellJargon('how many tenants in Mesa and Chandler')?.text === 'how many customers in Mesa and Chandler');
for (const q of ['retainer for dental patient', 'orthodontic retainer fee for Kim', 'who wore a retainer after braces']) check(`dental retainer is not an agreement: ${q}`, !/maintenance agreement/.test(J.respellJargon(q)?.text ?? ''), J.respellJargon(q));
check('a retainer without dental words is the agreement', J.respellJargon('total value of our retainers')?.text.includes('maintenance agreements'));
for (const q of ['how many team members', 'list the team member for Kim', 'team members in Tempe']) check(`team member is a technician, never a customer: ${q}`, !/customer/.test(J.respellJargon(q)?.text ?? ''), J.respellJargon(q));

/* ---------- 4. untracked concepts decline with no model */
const UNTRACKED = [
  'what is our retainage held', 'what commissions did we pay last quarter', 'how many change orders do we have', 'how much overtime did the crew log',
  'what late fees did we charge', 'what is our net income this year', 'what is our gross margin', 'what is the pto balance for the team',
  'show CAM charges by tenant', 'how many co-pays were collected', 'what is our cost per lead', 'how many subcontracts do we have', 'how many open purchase orders do we have',
];
for (const q of UNTRACKED) { const d = ED.classifyEarlyDecline(q); check(`declined without a model: ${q}`, d?.kind === 'off_domain' && !!d.untracked, d); }
const NOT_DECLINED = [
  ['how do I track retainage in DeepWell', 'a how-to question goes to help'],
  ['what is the retainage on invoice #4411', 'a named record may hold it'],
  ['what commissions were paid at 1420 W Main St', 'a street address is a record handle'],
  ['how many invoices do we have', 'plain wording'],
  ['who is our biggest customer', 'plain wording'],
  ['list unpaid invoices over $500', 'plain wording'],
];
for (const [q, why] of NOT_DECLINED) check(`not declined (${why}): ${q}`, !ED.classifyEarlyDecline(q, { hasConversation: true }) || ED.classifyEarlyDecline(q, { hasConversation: true }).untracked === undefined, ED.classifyEarlyDecline(q));

/* ---------- 5. the router adopts a respell only when a lane claims it */
{
  const a = await classifyAll('how many pay apps are there', { today: TODAY });
  check('pay apps -> invoices count is claimed', !!a.winner && /invoices/.test(a.effectiveQuestion) && !!a.jargon, { w: a.winner?.name, e: a.effectiveQuestion });
  const b = await classifyAll('how many invoices do we have', { today: TODAY });
  check('plain wording is not respelled', !b.jargon && b.effectiveQuestion === 'how many invoices do we have', b.effectiveQuestion);
  const c = await classifyAll('what is the weather like', { today: TODAY });
  check('no jargon, no claim, no change', !c.jargon && c.effectiveQuestion === 'what is the weather like', c.effectiveQuestion);
}

/* ---------- 6. end to end (golden data): same answer as the plain wording, no model */
// @ts-ignore
const off: any = await import(path.join(root, 'scripts/offline-exam.mjs'));
await off.installPgHarness();
await off.installModelBlock();
// @ts-ignore
const { default: Anthropic } = await import(path.join(root, 'node_modules/@anthropic-ai/sdk/index.mjs'));
const proto = Object.getPrototypeOf(new Anthropic({ apiKey: 'x' }).messages);
const blocked = proto.create;
let modelCalls = 0;
proto.create = async function (...a: any[]) { modelCalls++; return blocked.apply(this, a); };
// @ts-ignore
const { askViaHandler } = await import(path.join(root, 'api/_lib/scorecard/askCall.js'));
// @ts-ignore
const { default: askHandler } = await import(path.join(root, 'api/ask.js'));
const data = JSON.parse(fs.readFileSync(path.join(root, 'scripts/golden/golden-export.json'), 'utf8'));
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const ctx = (await off.loadExportIntoNewTenant(lite, data, { tenantKey: 'offline:jg', tenantName: 'jg' })).ctx;
async function ask(q: string) {
  modelCalls = 0;
  const r = await askViaHandler({ handler: askHandler, auth: { tenantId: ctx.tenantKey, orgId: 'jg', userId: null }, question: q, today: TODAY });
  return { kind: r?.data?.kind as string | undefined, text: String(r?.data?.text ?? ''), model: modelCalls > 0 };
}
if (process.argv.includes('--probe')) { for (const q of process.argv.slice(3)) realLog(JSON.stringify({ q, ...(await ask(q)) })); process.exit(0); }
const num = (t: string) => Number((t.match(/(\d[\d,]*)/) ?? [])[1]?.replace(/,/g, ''));
const PAIRS: Array<[string, string]> = [
  ['how many pay apps are there', 'how many invoices are there'],
  ['how many comfort club memberships do we have', 'how many maintenance agreements do we have'],
  ['how many job cards do we have', 'how many service tickets do we have'],
  ['how many techs and installers do we have', 'how many technicians do we have'],
];
for (const [jar, plain] of PAIRS) {
  const a = await ask(jar), b = await ask(plain);
  check(`same number as plain wording (no model): ${jar}`, !a.model && a.kind === 'answer' && num(a.text) === num(b.text), { a, b });
}
for (const q of ['what is our retainage held', 'what is our net income this year', 'how many change orders do we have', 'how many POs are open']) {
  const a = await ask(q);
  check(`honest decline, no model, nothing made up: ${q}`, !a.model && a.kind === 'no-answer' && /not in your business records/.test(a.text), a);
}
for (const [jar, plain] of [['how many tenants do we have', 'how many customers do we have'], ['how many bids did we submit in 2023', 'how many quotes did we submit in 2023'], ['how many pay applications went out in 2022', 'how many invoices went out in 2022'], ['how many subcontractors worked on our jobs', 'how many technicians worked on our jobs']] as Array<[string, string]>) {
  const a = await ask(jar), b = await ask(plain);
  check(`R3 same number as plain wording (no model): ${jar}`, !a.model && a.kind === 'answer' && num(a.text) === num(b.text), { a, b });
}
for (const q of ["what's the occupancy rate across our properties", 'how many open positions are we hiring for']) {
  const a = await ask(q);
  check(`R3 honest decline, no model: ${q}`, !a.model && a.kind === 'no-answer' && /not in your business records/.test(a.text), a);
}
{
  const a = await ask('how many repair requests do we have'), b = await ask('how many repair tickets do we have');
  check('repair requests are the repair tickets, not all work orders', !a.model && num(a.text) === num(b.text) && !/work order/.test(a.text), { a, b });
}
{
  const a = await ask('how many employment contracts do we have');
  check('employment contracts are not counted as maintenance agreements', !/maintenance agreement/.test(a.text), a);
  const v = await ask('how many vendor contracts do we have');
  check('vendor contracts decline without a model', !v.model && v.kind === 'no-answer', v);
  const k = await ask('how many contracts do we have');
  check('a bare contract is still the maintenance agreement', /maintenance agreement/.test(k.text), k);
}

/* ---------- 6b. records first: decline only when the tenant's own data has no trace of the concept */
{
  // @ts-ignore
  const { withTenant } = await import(path.join(root, 'api/_lib/recordsStore.js'));
  const t = { tenantKey: ctx.tenantKey, tenantName: 'jg' };
  const before = await withTenant(t, async (db: any) => ED.tenantHasTrace(db, 'retainage'));
  check('tenant without retainage text: trace check is empty (declined)', before === false);
  const d1 = await ask('what is our retainage held');
  check('tenant without retainage text: declined, no model', d1.kind === 'no-answer' && !d1.model && /not in your business records/.test(d1.text), d1);
  await withTenant(t, async (db: any) => db.raw(`INSERT INTO entities (tenant_id, entity_type, data, created_at, updated_at) VALUES ((current_setting('app.tenant_id', true))::uuid, 'customer', $1::jsonb, now(), now())`, [JSON.stringify({ customer_name: 'Okafor Builders', note: 'Retainage held at 10 percent until closeout' })]));
  const after = await withTenant(t, async (db: any) => ED.tenantHasTrace(db, 'retainage'));
  check('tenant with retainage text: trace found', after === true);
  const d2 = await ask('what is our retainage held');
  check('tenant with retainage text: not declined by the dictionary', !/not in your business records/.test(d2.text), d2);
}

/* ---------- 7. the data file ---------- */
try { execFileSync('node', [path.join(root, 'scripts/build-lexicon.mjs'), '--check'], { stdio: 'pipe' }); check('jargon.generated.js is up to date with the research files', true); }
catch (e: any) { check('jargon.generated.js is up to date with the research files', false, String(e?.stderr ?? e)); }
{
  const resp = new Map<string, string>();
  for (const [c, ks] of Object.entries<string[]>(G.RESPELL)) for (const k of ks) resp.set(k, c);
  const unt = new Map<string, string>();
  for (const [c, ks] of Object.entries<string[]>(G.UNTRACKED)) for (const k of ks) unt.set(k, c);
  check('no phrase is both respelled and untracked', [...unt.keys()].every((k) => !resp.has(k)));
  check('no phrase of 2 characters or fewer', [...resp.keys(), ...unt.keys()].every((k) => k.replace(/\s/g, '').length > 2));
  check('no ambiguous term is mapped (except the deliberate cross-industry families)', G.AMBIGUOUS.every((k: string) => G.GENERIC_OVERRIDE.includes(k) || (!resp.has(k) && !unt.has(k))));
  check('tokenising matches the builder for every phrase', [...resp.entries()].every(([k, c]) => J.canonicalFor(k) === c) && [...unt.keys()].every((k) => J.untrackedConcept(k)?.id === unt.get(k)));
  check('the counts are reported', G.JARGON_STATS.entries > 1000 && G.JARGON_STATS.kept === resp.size + unt.size, G.JARGON_STATS);
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
