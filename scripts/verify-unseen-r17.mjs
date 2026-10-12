/**
 * verify:unseen-r17 - contact asks and head-noun twins for companies Donovan has never seen.
 *
 * Contact asks ("email for X", "where do I email X", "how do I reach X by phone", "where is X located") with the lead-ins and tails people put round them are answered from the customer on file,
 * for the people of a gym, a storage site, a tutoring centre and a feed store. A paper name with the everyday twin of its head noun ("lien letters" for lien-sale-notice) counts the same papers
 * as the stored name; a twin two kinds could share is released.
 *
 *   node scripts/verify-unseen-r17.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let failures = 0; let passes = 0;
const check = (name, ok, detail = '') => { if (ok) passes++; else failures++; if (!ok || process.env.VERBOSE) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${String(detail).slice(0, 400)}`}`); };

delete process.env.ANTHROPIC_API_KEY;
delete process.env.DONOVAN_DQL;
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && /^\{"/.test(a[0])) return; realLog(...a); };
console.warn = () => {}; console.error = () => {};

const off = await import('./offline-exam.mjs');
await off.installPgHarness(); await off.installModelBlock();
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const { withTenant } = await import('../api/_lib/recordsStore.js');
const { getTenantVocab } = await import('../api/_lib/vocab/tenantVocab.js');
const { packForTenant } = await import('../api/_lib/industry/index.js');
const { parseDql, runDql } = await import('../api/_lib/dql/index.js');
const { runContactLookup } = await import('../api/_lib/contactLookup.js');
const { dqlFrame } = await import('../api/_lib/dql/frame.js');


const TODAY = '2026-10-07';
const CUST = ['gym', 'storage', 'tutoring', 'feedstore'];
const TWINS = { storage: [['lien letters', 'lien-sale-notice'], ['rent invoices', 'monthly-rent-bill']] };
for (const key of CUST) {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden', 'r16', `${key}.json`), 'utf8'));
  const loaded = await off.loadExportIntoNewTenant(lite, data, { tenantKey: `offline:r17-${key}`, tenantName: key });
  const ctxArg = { tenantKey: loaded.ctx.tenantKey, tenantName: key };
  const pack = await packForTenant({ withTenant, ctxArg });
  const tv = await withTenant(ctxArg, (db) => getTenantVocab(db, loaded.ctx.tenantKey, pack));
  const custs = data.entities.filter((e) => e.entity_type === 'customer' && !e.merged_into);
  const byName = new Map(); for (const c of custs) { const n = c.data.customer_name; byName.set(n, (byName.get(n) ?? 0) + 1); }
  const uniq = custs.filter((c) => byName.get(c.data.customer_name) === 1 && /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(c.data.customer_name) && c.data.phone && c.data.email && c.data.service_address).slice(0, 3);
  const ask = (q) => withTenant(ctxArg, (db) => runContactLookup(db, q, { tenantVocab: tv, today: TODAY }));
  for (const c of uniq) {
    const nm = c.data.customer_name;
    const forms = [
      [`Training question: how do I reach ${nm} by phone please?`, c.data.phone],
      [`Short on time here: ${nm} - phone, it's been bugging me if that's ok`, c.data.phone],
      [`Email for ${nm} thanks in advance`, c.data.email],
      [`Straight answer please: where do I email ${nm}, if you don't mind - going by what's on file`, c.data.email],
      [`First week here, where is ${nm} located`, c.data.service_address],
      [`Someone just called asking and what's ${nm}'s phone number thx in advance`, c.data.phone],
    ];
    for (const [q, want] of forms) { const a = await ask(q); check(`${key}: "${q.slice(0, 60)}" gives the value on file`, a != null && String(a.text).includes(want), `${a?.text} | want ${want}`); }
    // a name nobody has is not answered with a neighbour
    const miss = await ask(`Email for ${nm.split(' ')[0]} Zzyzxqq thanks in advance`);
    check(`${key}: an unknown name gets no value`, miss == null || !custs.some((x) => String(miss.text).includes(x.data.email)), miss?.text);
  }
  for (const [phrase, kind] of TWINS[key] ?? []) {
    const n = data.documents.filter((d) => d.audience !== 'internal' && String(d.document_type).replace(/_/g, '-') === kind).length;
    const intent = parseDql(`how many ${phrase}`, { tenantVocab: tv, pack, today: TODAY, original: `how many ${phrase}` });
    const ans = intent ? await withTenant(ctxArg, (db) => runDql(db, intent, { today: TODAY })) : null;
    check(`${key}: "${phrase}" is ${kind} (${n})`, ans != null && new RegExp(`(?<![\\d,.])${n}(?![\\d,])`).test(String(ans.text)), ans?.text);
  }
}

// R18: plain-word fields a company keeps no paper field for are declined with the reason; "deposit receipts" stay a paper kind; an everyday twin two kinds share is released, not guessed
{
  const { classifyCoverage } = await import('../api/_lib/router/coverage.js');
  for (const q of ['As the owner, what is our security deposit balance', "Security deposit balance on Elena Lane's account", 'how much deposit is held for Dana Harvey', 'what is the mean time to resolve tickets', 'average time to fix a ticket']) check(`coverage: "${q}" is untracked`, classifyCoverage(q) != null, 'not declined');
  for (const q of ['how many deposit receipts in 2024', 'move-out inspections containing the word deposit', 'security deposit receipts for Dana Harvey', 'how long to fix the ticket for Dana']) check(`coverage: "${q}" is not declined`, classifyCoverage(q) == null, JSON.stringify(classifyCoverage(q)));
  const { compileVocab } = await import('../api/_lib/dql/vocab.js');
  const mk = (ids) => ({ dql: { docTypes: ids.map((id) => ({ id, n: 5 })), card: { kinds: Object.fromEntries(ids.map((id) => [id, { label: id.replace(/-/g, ' '), plural: `${id.replace(/-/g, ' ')}s`, heads: id.split('-') }])), staffNouns: [], fields: {} } } });
  const two = compileVocab(mk(['rent-statement', 'rent-invoice', 'lock-order']), null);
  check('twin: "rent bill" for two kinds is released', !two.docPhrases.has('rent bill') && !two.docPhrases.has('rent bills'));
  const one = compileVocab(mk(['rent-statement', 'lock-order']), null);
  check('twin: "rent bill" for one kind is that kind', one.docPhrases.get('rent bill') === 'rent-statement');
}
check('frame: a contact ask keeps its name', dqlFrame("per the boss, where's Paul Reid at, what city").includes('Paul Reid'), dqlFrame("per the boss, where's Paul Reid at, what city"));

console.log = realLog;
console.log(`${failures ? 'FAIL' : 'PASS'}  verify:unseen-r17  ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
