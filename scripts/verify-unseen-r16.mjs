/**
 * verify:unseen-r16 - Donovan reads companies it has never seen, through short forms of the company's own paper names, its own customer word, and the chatter people put round a question.
 *
 * Six companies from kinds of business no DeepWell list names (a gym, a hair salon, a self-storage site, a tutoring centre, a photo studio, a feed store) plus three from round 15 are loaded with NO industry
 * setting. For each, counts by a short form of a paper name ("session logs" for pt-session-log, "lab orders" for print-lab-order, "tuition receipts" for payment-receipt-tuition) are checked against an
 * independent count of the export, as are the same questions with lead-ins and tails round them. A short form two kinds could share, a word no paper has, and a customer word that is the staff's word
 * are released, never guessed.
 *
 *   node scripts/verify-unseen-r16.mjs
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
const { dqlFrame } = await import('../api/_lib/dql/frame.js');

const TODAY = '2026-10-07';
// per company: short forms and the kind each must reach (the engine is never told these), words that must be released, and the staff word that must not be taken as the customer word
const COMPANIES = {
  gym: { dir: 'r16', short: [['session logs', 'pt-session-log'], ['dues statements', 'monthly-dues-statement'], ['membership agreements', 'membership-agreement'], ['injury waivers', 'injury-waiver']], release: ['how many flibbertigibbet logs'], cust: ['members'] },
  salon: { dir: 'r16', short: [['color cards', 'color-consultation-card'], ['allergy waivers', 'client-allergy-waiver'], ['license copies', 'cosmetology-license-copy']], release: ['how many shampoo vouchers'], cust: ['guests'] },
  storage: { dir: 'r16', short: [['rent bills', 'monthly-rent-bill'], ['walkthrough sheets', 'unit-walkthrough-sheet'], ['rental agreements', 'unit-rental-agreement'], ['lien notices', 'lien-sale-notice'], ['rent receipts', 'payment-receipt-rent']], release: ['how many auction flyers'], cust: ['renters'] },
  tutoring: { dir: 'r16', short: [['session notes', 'session-note'], ['tuition receipts', 'payment-receipt-tuition'], ['enrollment forms', 'enrollment-form'], ['media releases', 'media-release-slip']], release: ['how many homework stickers'], cust: ['student families'] },
  photostudio: { dir: 'r16', short: [['package invoices', 'photo-package-invoice'], ['lab orders', 'print-lab-order'], ['booking sheets', 'shoot-booking-sheet'], ['usage licenses', 'usage-license']], release: ['how many backdrop rentals'], cust: [] },
  feedstore: { dir: 'r16', short: [['mill orders', 'mill-purchase-order'], ['soil tests', 'pasture-soil-test'], ['monthly statements', 'account-statement-month'], ['credit applications', 'credit-application']], release: ['how many salt licks'], cust: [] },
  trucking: { dir: 'r15', short: [['freight bills', 'freight-bill'], ['fuel receipts', 'fuel-receipt']], release: [], cust: ['shippers'] },
  petgroom: { dir: 'r15', short: [['boarding slips', 'boarding-stay-slip'], ['intake sheets', 'pet-intake-sheet']], release: [], cust: [] },
  church: { dir: 'r15', short: [['pledge cards', 'pledge-card'], ['volunteer signups', 'volunteer-signup-form']], release: [], cust: ['members'] },
};

async function company(key) {
  const spec = COMPANIES[key];
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden', spec.dir, `${key}.json`), 'utf8'));
  const loaded = await off.loadExportIntoNewTenant(lite, data, { tenantKey: `offline:r16-${key}`, tenantName: key });
  const ctxArg = { tenantKey: loaded.ctx.tenantKey, tenantName: key };
  const pack = await packForTenant({ withTenant, ctxArg });
  const tv = await withTenant(ctxArg, (db) => getTenantVocab(db, loaded.ctx.tenantKey, pack));
  const counts = new Map();
  for (const d of data.documents) { if (d.audience === 'internal') continue; const t = String(d.document_type).replace(/_/g, '-'); counts.set(t, (counts.get(t) ?? 0) + 1); }
  const ask = async (q) => {
    const intent = parseDql(q, { tenantVocab: tv, pack, today: TODAY, original: q });
    if (!intent) return { intent: null, text: null };
    const ans = await withTenant(ctxArg, (db) => runDql(db, intent, { today: TODAY }));
    return { intent, text: ans ? String(ans.text) : null };
  };
  return { key, spec, counts, ask };
}
const hasN = (text, n) => text != null && new RegExp(`(?<![\\d,.])${n}(?![\\d,]|\\.\\d)`).test(text);

for (const key of Object.keys(COMPANIES)) {
  const c = await company(key); const s = c.spec;
  for (const [phrase, kind] of s.short) {
    const n = c.counts.get(kind) ?? 0;
    let r = await c.ask(`how many ${phrase}`);
    check(`${key}: "${phrase}" is ${kind} (${n})`, hasN(r.text, n), r.text);
    // the same ask with chatter round it (who is asking, where, how fast, a little Spanish)
    r = await c.ask(`owner here - on site and can't scroll - how many ${phrase} do we have, thanks in advance`);
    check(`${key}: lead-in and tail round "${phrase}"`, hasN(r.text, n), r.text);
  }
  for (const q of s.release) { const r = await c.ask(q); check(`${key}: "${q}" is released`, r.text == null, r.text); }
  // the company's own customer word reads as the customers, with the same number
  const base = await c.ask('how many customers');
  for (const w of s.cust) {
    const r = await c.ask(`how many ${w}`);
    check(`${key}: "${w}" reads as the customers`, base.text != null && r.text != null && (r.text.match(/\d[\d,]*/) ?? [])[0] === (base.text.match(/\d[\d,]*/) ?? [])[0], `${base.text} | ${r.text}`);
  }
}

// the chatter alone: pure frame checks
check('frame: persona lead-in and qualifier tail come off', dqlFrame("my bookkeeper is asking: how many invoices from what's in the system, thanks in advance").trim() === 'how many invoices', dqlFrame("my bookkeeper is asking: how many invoices from what's in the system, thanks in advance"));
check('frame: a Spanish head is read as English', /^how many\b/.test(dqlFrame('buenas, cuántos invoices por favor')), dqlFrame('buenas, cuántos invoices por favor'));
check('frame: a condition is never chatter', /last 30 days/.test(dqlFrame('owner here - how many invoices in the last 30 days')), dqlFrame('owner here - how many invoices in the last 30 days'));

console.log = realLog;
console.log(`${failures ? 'FAIL' : 'PASS'}  verify:unseen-r16  ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
