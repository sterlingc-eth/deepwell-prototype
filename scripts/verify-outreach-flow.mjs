/**
 * End-to-end check of Customer outreach against a real Postgres (PGlite) with the real route handler:
 * who is picked and why, who is left out and why, the drafted message, the preview, the approve gate, the send
 * step, and the sent log. Email is STUBBED: the Resend endpoint is intercepted in-process (scripts/lib/t5-harness.mjs),
 * so nothing is ever sent and no real key is used.
 *
 *   node scripts/verify-outreach-flow.mjs
 */
import { startHarness, seedCustomer, seedEquipment } from './lib/t5-harness.mjs';

let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const h = await startHarness();
const account = (await import('../api/account.js')).default;
const admin = h.clerkToken();
const member = h.clerkToken({ sub: 'user_tech', org_role: 'org:member' });
const op = (body, token = admin) => h.call(account, { method: 'POST', query: { action: 'outreach' }, body, token });

const u = (k, n) => `${k}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const unit = (n, cust, name, mfr, model, serial, expiresInDays, termYears = 10) => seedEquipment(h, {
  id: u('e', n), customerId: u('c', cust), mfr, model, serial, type: 'condenser', installed: day(expiresInDays - termYears * 365),
  address: '1 Main St', customerName: name,
  warranty: { installDate: day(expiresInDays - termYears * 365), expires: day(expiresInDays), expiresBasis: 'printed', termYears, registrationOnFile: day(expiresInDays - termYears * 365 + 30) },
});

// ---- the shop's customers ----
await seedCustomer(h, { id: u('c', 1), number: 'C-00001', name: 'Carol Rios', address: '412 Elm St, Mesa, AZ 85201', email: 'carol.rios@example.com' });
await seedCustomer(h, { id: u('c', 2), number: 'C-00002', name: 'Harbor Point Apartments', address: '5600 W Camelback Rd, Phoenix, AZ', email: 'office@harborpoint.example.com' });
await seedCustomer(h, { id: u('c', 3), number: 'C-00003', name: 'Nguyen Family', address: '88 Palm Ln, Tempe, AZ', email: 'nguyen@example.com' });
await seedCustomer(h, { id: u('c', 4), number: 'C-00004', name: 'Desert Sky Dental', address: '300 N Gilbert Rd, Gilbert, AZ' }); // no email
await seedCustomer(h, { id: u('c', 5), number: 'C-00005', name: 'Mesa Pines HOA', address: '9 Pine Ct, Mesa, AZ', email: 'board@mesapines.example.com', optedOut: true });
await seedCustomer(h, { id: u('c', 6), number: 'C-00006', name: 'Tempe Family Pharmacy', address: '20 University Dr, Tempe, AZ', email: 'rx@tempepharm.example.com' });
await unit(1, 1, 'Carol Rios', 'Trane', 'XR16', 'TR2306A1234', 40);
await unit(2, 2, 'Harbor Point Apartments', 'Carrier', '24ACC636', 'CA1807B7788', -100);
await unit(3, 3, 'Nguyen Family', 'Goodman', 'GSX140361', 'GD2011C5521', 20);
await unit(4, 4, 'Desert Sky Dental', 'Lennox', 'XC21', 'LX1905D9090', 25);
await unit(5, 5, 'Mesa Pines HOA', 'Trane', 'XR14', 'TR1909E4411', 15);
await unit(6, 6, 'Tempe Family Pharmacy', 'Rheem', 'RA1436', 'RH2012F3030', 80); // 80 days: outside a 60-day window
await unit(7, 1, 'Carol Rios', 'Trane', 'XL20i', 'TR3001G7070', 3000); // far from expiry: never a candidate

/* ------------------------------------------------------------ 1. settings */
{
  const r = await op({ op: 'settings' });
  eq('settings: starts OFF in review mode', [r.body.enabled, r.body.mode, r.body.migrationPending], [false, 'review', false]);
  check('settings: auto-send is an add-on (not entitled)', r.body.outreachAutoEntitled === false);
  const denied = await op({ op: 'saveSettings', settings: { enabled: true } }, member);
  eq('a non-admin cannot change settings', denied.statusCode, 403);
  const auto = await op({ op: 'saveSettings', settings: { mode: 'auto' } });
  eq('auto mode is refused without the add-on (402)', auto.statusCode, 402);
  const saved = await op({ op: 'saveSettings', settings: { shopName: 'Desert Peak HVAC', shopPhone: '(480) 555-0199', fromName: 'Dana', replyTo: 'service@desertpeak.example.com', leadDays: 60 } });
  eq('settings saved', [saved.statusCode, saved.body.shopName, saved.body.leadDays, saved.body.enabled], [200, 'Desert Peak HVAC', 60, false]);
}

/* ------------------------------------------- 2. generate: who and why not */
let drafts;
{
  const r = await op({ op: 'generate' });
  eq('generate: 200', r.statusCode, 200);
  eq('generate: three customers get a draft (expiring 40d, expiring 20d, expired)', r.body.created, 3);
  eq('generate: counters', [r.body.needsEmail, r.body.optedOut, r.body.outsideLeadWindow, r.body.alreadyDrafted], [1, 1, 1, 0]);
  const by = Object.fromEntries((r.body.notDrafted ?? []).map((n) => [n.customerName, n]));
  eq('not drafted: Desert Sky Dental, no email', by['Desert Sky Dental']?.reason, 'no-email');
  eq('not drafted: Mesa Pines HOA, opted out', by['Mesa Pines HOA']?.reason, 'opted-out');
  check('not drafted: Tempe Family Pharmacy, outside the 60 day window', by['Tempe Family Pharmacy']?.reason === 'outside-window' && [80, 81].includes(by['Tempe Family Pharmacy']?.daysLeft), JSON.stringify(by['Tempe Family Pharmacy']));
  check('the unit 3000 days out is not even considered', !(r.body.notDrafted ?? []).some((n) => n.customerName === 'Carol Rios'));
  const again = await op({ op: 'generate' });
  eq('generate again: nothing duplicated', [again.body.created, again.body.alreadyDrafted], [0, 3]);
}

/* ----------------------------------------------- 3. the review queue */
{
  const r = await op({ op: 'list' });
  drafts = r.body.items;
  eq('list: three drafts, all status draft', drafts.map((d) => d.status), ['draft', 'draft', 'draft']);
  const carol = drafts.find((d) => d.customerName === 'Carol Rios');
  eq('draft names the customer, number, unit and recipient', [carol.customerNumber, carol.unit, carol.toEmail], ['C-00001', 'Trane XR16', 'carol.rios@example.com']);
  eq('draft shows the serial masked', carol.serialLast4, '••••1234');
  eq('draft carries the warranty end date that put her on the list', carol.warrantyExpires, day(40));
  eq('tiers', Object.fromEntries(drafts.map((d) => [d.customerName, d.tier])), { 'Carol Rios': 'expiring-90', 'Harbor Point Apartments': 'expired', 'Nguyen Family': 'expiring-30' });
  eq('subject names the shop', carol.subject, 'Your HVAC warranty is expiring soon — Desert Peak HVAC');

  const full = await op({ op: 'preview', id: carol.id });
  const body = full.body.bodyText;
  check('preview: greets the customer by name', body.startsWith('Hi Carol Rios,'));
  check('preview: states the unit and the end date', body.includes('Trane XR16') && body.includes(day(40)));
  check('preview: signed by the sender, with a way to reply', body.includes('— Dana') && body.includes('service@desertpeak.example.com') && body.includes('(480) 555-0199'));
  check('preview: opt-out line present', /Reply STOP to opt out/.test(body));
  check('preview: the full serial never appears', !body.includes('TR2306A1234'));
}

/* ---------------------------------- 4. nothing goes out while outreach is off */
{
  const a = await op({ op: 'approve', all: true });
  eq('approve while OFF is refused (409)', [a.statusCode, a.body.error], [409, 'Turn on Customer outreach in settings first']);
  const s = await op({ op: 'sendApproved' });
  eq('send while OFF is refused (409)', s.statusCode, 409);
  eq('no email left the building', h.sentEmails.length, 0);
}

/* ---------------------------------------- 5. approve, confirm, send (stubbed) */
{
  await op({ op: 'saveSettings', settings: { enabled: true } });
  const none = await op({ op: 'sendApproved' });
  eq('send with nothing approved sends nothing', [none.body.sent, none.body.attempted], [0, 0]);
  const skipOne = drafts.find((d) => d.customerName === 'Nguyen Family');
  const sk = await op({ op: 'skip', ids: [skipOne.id] });
  eq('skip one draft', sk.body.skipped, 1);
  const ap = await op({ op: 'approve', all: true });
  eq('approve all: the two remaining drafts', ap.body.approved, 2);
  const sent = await op({ op: 'sendApproved' });
  eq('send: two sent, none failed', [sent.body.sent, sent.body.failed, sent.body.attempted], [2, 0, 2]);
  eq('stubbed provider received exactly the approved two', h.sentEmails.map((e) => e.to[0]).sort(), ['carol.rios@example.com', 'office@harborpoint.example.com']);
  check('the skipped customer received nothing', !h.sentEmails.some((e) => e.to[0] === 'nguyen@example.com'));
  check('sent text carries the opt-out line and a masked serial only', h.sentEmails.every((e) => /Reply STOP/.test(e.text) && !/TR2306A1234|CA1807B7788/.test(e.text)));
  const log = await op({ op: 'list', status: 'sent' });
  eq('sent log has both', log.body.items.map((i) => i.status), ['sent', 'sent']);
  const resend = await op({ op: 'sendApproved' });
  eq('sending twice does not email anyone twice', [resend.body.sent, h.sentEmails.length], [0, 2]);
}

/* ------------------------------- 6. opted out between approve and send */
{
  await seedCustomer(h, { id: u('c', 7), number: 'C-00007', name: 'Sunrise Dental', address: '5 Sun Way, Mesa, AZ', email: 'front@sunrise.example.com' });
  await unit(8, 7, 'Sunrise Dental', 'Trane', 'XR15', 'TR2101H6060', 10);
  const g = await op({ op: 'generate' });
  eq('a new unit gets a new draft', g.body.created, 1);
  const l = await op({ op: 'list', status: 'draft' });
  await op({ op: 'approve', ids: [l.body.items[0].id] });
  await op({ op: 'optOut', customerId: u('c', 7) });
  const before = h.sentEmails.length;
  const s = await op({ op: 'sendApproved' });
  eq('opted out after approval: skipped, not sent', [s.body.sent, s.body.skippedOptOut, h.sentEmails.length - before], [0, 1, 0]);
}

/* ------------------------------------- 7. provider not configured: honest */
{
  await seedCustomer(h, { id: u('c', 9), number: 'C-00009', name: 'Lakeview Dental', address: '7 Lake Rd, Mesa, AZ', email: 'hello@lakeview.example.com' });
  await unit(10, 9, 'Lakeview Dental', 'Trane', 'XR17', 'TR2202J1212', 12);
  await op({ op: 'generate' });
  await op({ op: 'approve', all: true });
  const key = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  const s = await op({ op: 'sendApproved' });
  process.env.RESEND_API_KEY = key;
  eq('no email provider: the send fails visibly', [s.body.sent, s.body.failed], [0, 1]);
  const f = await op({ op: 'list', status: 'failed' });
  check('failed row says why in plain words', /not configured/i.test(f.body.items[0]?.error ?? ''), f.body.items[0]?.error);
}

/* ------------------------- 8. the nightly sweep (review mode) uses the shop's details */
{
  await seedCustomer(h, { id: u('c', 11), number: 'C-00011', name: 'Ocotillo Bakery', address: '2 Ocotillo Way, Chandler, AZ', email: 'orders@ocotillo.example.com' });
  await unit(12, 11, 'Ocotillo Bakery', 'Trane', 'XR13', 'TR2303K5050', 9);
  const { runOutreachSweep } = await import('../api/_lib/routes/outreach.js');
  const sum = await runOutreachSweep({});
  eq('sweep: checked the one enabled shop and drafted the new unit', [sum.tenantsChecked, sum.drafted, sum.errors.length], [1, 1, 0]);
  const l = await op({ op: 'list', status: 'draft' });
  const d = l.body.items.find((i) => i.customerName === 'Ocotillo Bakery');
  check('sweep draft carries the shop name in its subject (needs migration 21 to apply cleanly)', d?.subject.endsWith('Desert Peak HVAC'), d?.subject);
  const n = await h.lite.query("SELECT title FROM notifications WHERE kind = 'outreach'");
  check('sweep leaves an in-app note that a draft is waiting', n.rows.length === 1, JSON.stringify(n.rows));
}

{
  const fs = await import('node:fs');
  const ui = fs.readFileSync(new URL('../src/screens/OutreachScreen.tsx', import.meta.url), 'utf8');
  check('screen: Approve, Approve all and Send approved are disabled while outreach is off, with the banner wording as the reason',
    (ui.match(/outreachOff/g) ?? []).length >= 7 && ui.includes('Customer outreach is off. Turn it on in Settings to approve and send.') && ui.includes('id="outreach-off-reason"'));
}

console.log('');
if (failures) { console.log(`${failures} check(s) FAILED, ${passes} passed.`); process.exit(1); }
console.log(`All outreach flow checks passed (${passes}).`);
process.exit(0);
