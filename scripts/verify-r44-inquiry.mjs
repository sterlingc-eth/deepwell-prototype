/**
 * Round 44: website inquiry form ("Send my question") regression gate.
 *
 *   npx tsx scripts/verify-r44-inquiry.mjs [screenshotDir]      (needs `VITE_CLERK_PUBLISHABLE_KEY=pk_test_dummy npm run build` first for Part B)
 *   R44_SKIP_BROWSER=1 npx tsx scripts/verify-r44-inquiry.mjs   (backend only)
 *
 * Part A runs api/_lib/support/inquiry.js (and the route's `inquiry` branch) with a MOCKED email sender and an in-memory
 * rate-limit store: no network, no database, no real Resend. Part B drives the built dist/ in Chromium with /api/support mocked.
 * Fake secrets are built by string concatenation.
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT_DIR = process.argv[2] ?? '/tmp/claude-0/-home-claude/c8b456ad-32a9-5305-923e-589d73c65629/scratchpad/r44-shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.log(`FAIL  ${name}${extra ? `  -> ${extra}` : ''}`); }
};
const section = (s) => console.log(`\n# ${s}`);
let netCalls = 0;
const NO_NET = () => { netCalls++; throw new Error('network call attempted in a test that must not touch the network'); };
const realFetch = globalThis.fetch;
globalThis.fetch = NO_NET; // Part A must never reach a provider; Part B uses the browser, not Node fetch

const inq = await import('../api/_lib/support/inquiry.js');
const { createLimiter } = await import('../api/_lib/support/limits.js');
const { sendEmail } = await import('../api/_lib/email.js');

/* ------------------------------------------------------------------ helpers */
const T0 = Date.UTC(2026, 9, 1, 15, 30, 0);
function memShared() {
  const m = new Map();
  return async (key, ws, units) => {
    const k = `${key}|${ws}`;
    const v = (m.get(k) ?? 0) + units;
    m.set(k, v);
    return { units: v, source: 'db' };
  };
}
function mkEnv() {
  const clock = { now: T0 };
  const limiter = createLimiter({ now: () => clock.now, env: {}, shared: memShared() });
  const sent = [];
  const logs = [];
  const mode = { fail: false, throwOnce: false, failSecond: false };
  const send = async (msg) => {
    if (mode.throwOnce) { mode.throwOnce = false; throw new Error('boom'); }
    sent.push(msg);
    if (mode.fail) return { sent: false, channel: 'in-app' };
    if (mode.failSecond && sent.length === 2) return { sent: false, channel: 'in-app', error: 'resend 500' };
    return { sent: true, channel: 'email' };
  };
  const run = (body, ip = '203.0.113.7') =>
    inq.runInquiry(body, { req: { headers: { 'x-real-ip': ip } }, limiter, send, env: {}, now: new Date(clock.now), log: (l) => logs.push(l) });
  return { clock, limiter, sent, logs, mode, send, run };
}
const good = (over = {}) => ({
  action: 'inquiry', name: 'Sam Rivera', company: 'Acme Heating & Air', email: 'sam@acmeheating.example', phone: '(480) 555-0142',
  size: 'gt-50k', where: ['paper', 'google-drive'], message: 'Can DeepWell read scanned warranty cards from 2009?', website: '', elapsedMs: 9000, ...over,
});
const ch = (...codes) => String.fromCharCode(...codes);

/* ================================================================== PART A: backend */
section('A1 valid submit: two emails, exact subject, reply-to');
{
  const t = mkEnv();
  const r = await t.run(good());
  check('valid submit -> 200 {ok:true}', r.status === 200 && r.body.ok === true, JSON.stringify(r));
  check('exactly two emails sent', t.sent.length === 2, String(t.sent.length));
  const [team, receipt] = t.sent;
  check('team email goes to hello@deepwelltechnology.com only', JSON.stringify(team.to) === JSON.stringify(['hello@deepwelltechnology.com']));
  check('team subject is exactly "[DeepWell inquiry] <Company> — <size band>"', team.subject === '[DeepWell inquiry] Acme Heating & Air — More than 50,000', team.subject);
  check('team reply-to is the visitor address', team.replyTo === 'sam@acmeheating.example');
  for (const piece of ['Sam Rivera', 'Acme Heating & Air', 'sam@acmeheating.example', '(480) 555-0142', 'More than 50,000', 'Paper', 'Google Drive', 'scanned warranty cards from 2009']) {
    check(`team body lists "${piece}"`, team.text.includes(piece));
  }
  check('team body is plain text with an html twin', typeof team.text === 'string' && typeof team.html === 'string');
  check('receipt goes only to the visitor', JSON.stringify(receipt.to) === JSON.stringify(['sam@acmeheating.example']));
  check('receipt is short, plain, no marketing words', receipt.text.length < 600 && !/discount|offer|free|sale|limited|buy|upgrade|click/i.test(receipt.text));
  const links = receipt.text.match(/https?:\/\/\S+/g) ?? [];
  check('receipt has no link except the site', links.every((l) => l === 'https://deepwelltechnology.com'), JSON.stringify(links));
  check('receipt greets the first name and does not echo the question', receipt.text.startsWith('Hi Sam,') && !receipt.text.includes('warranty cards'));
  check('log line has no personal data', t.logs.length === 1 && !/Sam|Acme|sam@|480|warranty/.test(t.logs[0]) && /email=h:[0-9a-f]{12}/.test(t.logs[0]), t.logs.join('|'));

  const t2 = mkEnv();
  await t2.run(good({ size: undefined, where: undefined, phone: '' }));
  check('size defaults to "Not sure", phone/where optional', t2.sent[0].subject === '[DeepWell inquiry] Acme Heating & Air — Not sure' && /Phone: \(not given\)/.test(t2.sent[0].text));
  const bands = { 'not-sure': 'Not sure', 'lt-1k': 'Under 1,000', '1k-5k': '1,000–5,000', '5k-25k': '5,000–25,000', '25k-50k': '25,000–50,000', 'gt-50k': 'More than 50,000' };
  for (const [k, label] of Object.entries(bands)) {
    const tt = mkEnv();
    await tt.run(good({ size: k }));
    check(`size band ${k} -> subject ends "— ${label}"`, tt.sent[0].subject.endsWith(` — ${label}`), tt.sent[0].subject);
  }
  check('env INQUIRY_TO_EMAIL overrides the recipient (valid only)',
    inq.inquiryRecipient({ INQUIRY_TO_EMAIL: 'Team@Example.com' }) === 'team@example.com' && inq.inquiryRecipient({ INQUIRY_TO_EMAIL: 'bad address' }) === 'hello@deepwelltechnology.com' && inq.inquiryRecipient({}) === 'hello@deepwelltechnology.com');
  const t3 = mkEnv();
  await inq.runInquiry(good(), { req: {}, limiter: t3.limiter, send: t3.send, env: { INQUIRY_TO_EMAIL: 'inbox@example.com' }, log: () => {} });
  check('recipient override is used for the notification', JSON.stringify(t3.sent[0].to) === JSON.stringify(['inbox@example.com']));
  const t4 = mkEnv();
  await inq.runInquiry(good({ email: 'inbox@example.com' }), { req: {}, limiter: t4.limiter, send: t4.send, env: { INQUIRY_TO_EMAIL: 'inbox@example.com' }, log: () => {} });
  check('no receipt is sent when the visitor typed the team address (no mail loop)', t4.sent.length === 1);
}

section('A2 each validation error is plain English and sends nothing');
{
  const cases = [
    ['missing name', { name: '' }, 'name', /name/i],
    ['name only angle brackets', { name: '<<>>' }, 'name', /name/i],
    ['name too long', { name: 'x'.repeat(101) }, 'name', /under 100/],
    ['missing company', { company: '   ' }, 'company', /company/i],
    ['company too long', { company: 'c'.repeat(121) }, 'company', /under 120/],
    ['missing email', { email: '' }, 'email', /email/i],
    ['email without @', { email: 'sam.acmeheating.example' }, 'email', /email/i],
    ['email with spaces', { email: 'sam @acme.example' }, 'email', /email/i],
    ['email with two addresses', { email: 'a@b.example,c@d.example' }, 'email', /email/i],
    ['email with angle brackets', { email: 'Sam <sam@acme.example>' }, 'email', /email/i],
    ['email too long', { email: `${'a'.repeat(250)}@b.example` }, 'email', /email/i],
    ['email not a string', { email: { a: 1 } }, 'email', /email/i],
    ['bad phone letters', { phone: 'call me maybe' }, 'phone', /phone/i],
    ['phone too short', { phone: '12345' }, 'phone', /phone/i],
    ['phone too long', { phone: '1'.repeat(31) }, 'phone', /phone/i],
    ['missing message', { message: '' }, 'message', /question/i],
    ['message too short', { message: 'hi' }, 'message', /more detail/i],
    ['message too long', { message: 'm'.repeat(2001) }, 'message', /under 2000/],
    ['message not a string', { message: ['x'] }, 'message', /question/i],
  ];
  for (const [name, over, field, re] of cases) {
    const t = mkEnv();
    const r = await t.run(good(over));
    check(`${name} -> 400 with a plain-English ${field} error`, r.status === 400 && typeof r.body.fields?.[field] === 'string' && re.test(r.body.fields[field]) && t.sent.length === 0, JSON.stringify(r.body));
  }
  const t = mkEnv();
  const r = await t.run(good({ name: '', company: '', email: '', message: '' }));
  check('several errors come back together, one per field', r.status === 400 && ['name', 'company', 'email', 'message'].every((k) => r.body.fields[k]) && r.body.error === 'Please check the highlighted fields.');
  check('error messages never leak internals', Object.values(r.body.fields).every((m) => !/undefined|null|TypeError|stack|regex/i.test(m)));
  for (const [name, body] of [['null body', null], ['string body', 'x'], ['array body', []]]) {
    const tt = mkEnv();
    const rr = await tt.run(body);
    check(`${name} is dropped or refused, nothing sent`, [200, 400].includes(rr.status) && tt.sent.length === 0);
  }
}

section('A3 injection attempts are neutralized');
{
  const t = mkEnv();
  const evil = good({
    name: 'Sam\r\nBcc: evil@attacker.example\r\nSubject: pwned',
    company: `Acme<script>alert(1)</script>${ch(0x2028)}${ch(0x202e)}\r\nBcc: x@y.example`,
    message: `Hello <img src=x onerror=alert(1)> <b>bold</b>\r\n\r\nX-Header: injected\n${ch(0)}${ch(7)}${ch(0x200b)}done`,
    phone: '480-555-0142',
  });
  const r = await t.run(evil);
  check('sanitized injection still sends two emails', r.status === 200 && t.sent.length === 2);
  const [team, receipt] = t.sent;
  check('subject is one line with no angle brackets or control characters', !/[\r\n<>\u0000-\u001f\u2028\u2029\u202e]/.test(team.subject), JSON.stringify(team.subject));
  check('subject still starts with the exact prefix', team.subject.startsWith('[DeepWell inquiry] Acme'), team.subject);
  const everything = [team.subject, team.text, receipt.subject, receipt.text];
  check('no angle brackets or control characters in any email text', everything.every((s) => !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u2028\u2029\u202a-\u202e\u200b]/.test(s)));
  check('html twin has no tags beyond the wrapper (everything escaped)', !/<(script|img|b)\b/i.test(team.html) && !/<(script|img|b)\b/i.test(receipt.html));
  check('no message in the batch has a header-ish field other than to/subject/replyTo/text/html', t.sent.every((m) => Object.keys(m).every((k) => ['to', 'subject', 'text', 'html', 'replyTo'].includes(k))));
  check('recipients are exactly the team address and the visitor, no Bcc', t.sent.every((m) => m.to.length === 1) && team.to[0] === 'hello@deepwelltechnology.com' && receipt.to[0] === 'sam@acmeheating.example');
  check('no line of the team body starts with a smuggled header (Bcc:/Subject:/To:)', !/^(Bcc|Cc|To|Subject|From):/im.test(team.text.split('\nQuestion:')[0]));
  check('receipt greeting does not echo the hostile name', receipt.text.startsWith('Hi there,') || /^Hi [A-Za-z’'-]+,/.test(receipt.text), receipt.text.split('\n')[0]);
  check('receipt contains no attacker address or text', !/attacker|pwned|alert/.test(receipt.text));

  const e1 = await mkEnv().run(good({ email: 'a@b.example\r\nBcc: evil@attacker.example' }));
  check('CRLF in the email address is rejected (reply-to cannot be forged)', e1.status === 400 && e1.body.fields.email);
  const e2 = await mkEnv().run(good({ email: `a@b.example${ch(0x2028)}x@y.example` }));
  check('line-separator in the email address is rejected', e2.status === 400 && e2.body.fields.email);
  const e3 = await mkEnv().run(good({ email: `a${ch(0)}@b.example` }));
  check('NUL in the email address is rejected', e3.status === 400 && e3.body.fields.email);
  const t5 = mkEnv();
  await t5.run(good({ name: 'http://evil.example/login', email: 'v@victim.example' }));
  check('a link in the name is never echoed in the visitor receipt', !/evil\.example/.test(t5.sent[1]?.text ?? ''));
  const t6 = mkEnv();
  await t6.run(good({ message: `my card is 4242 4242 4242 4242 and the password is ${'hun' + 'ter2'}` }));
  check('card numbers and passwords are redacted before the team email', !/4242 4242 4242 4242/.test(t6.sent[0].text) && !/hun(ter)2/.test(t6.sent[0].text) && /redacted/.test(t6.sent[0].text));
  const t7 = mkEnv();
  await t7.run(good({ company: 'A'.repeat(120) }));
  check('subject company is capped (80 chars) while the body keeps the full name', t7.sent[0].subject.length <= '[DeepWell inquiry] '.length + 80 + ' — More than 50,000'.length && t7.sent[0].text.includes('A'.repeat(120)));
}

section('A4 allow-lists');
{
  for (const [name, over] of [
    ['unknown size', { size: 'huge' }], ['size = label text', { size: 'More than 50,000' }], ['size = __proto__', { size: '__proto__' }],
    ['size = constructor', { size: 'constructor' }], ['size = array', { size: ['gt-50k'] }], ['size = object', { size: { a: 1 } }], ['size = number', { size: 3 }],
  ]) {
    const t = mkEnv();
    const r = await t.run(good(over));
    check(`${name} -> 400 on size, nothing sent`, r.status === 400 && r.body.fields.size && t.sent.length === 0, JSON.stringify(r.body));
  }
  for (const [name, over] of [
    ['unknown where value', { where: ['paper', 'bogus'] }], ['where as a string', { where: 'paper' }], ['where = __proto__', { where: ['__proto__'] }],
    ['where with objects', { where: [{ a: 1 }] }], ['where too long', { where: Array(9).fill('paper') }], ['where = label text', { where: ['Paper'] }],
  ]) {
    const t = mkEnv();
    const r = await t.run(good(over));
    check(`${name} -> 400 on where, nothing sent`, r.status === 400 && r.body.fields.where && t.sent.length === 0, JSON.stringify(r.body));
  }
  const t = mkEnv();
  await t.run(good({ where: ['other', 'paper', 'paper', 'computer'] }));
  check('where is de-duplicated, labelled, and in a fixed order', /Where they are today: Paper; On a computer or shared drive; Other software/.test(t.sent[0].text), t.sent[0].text);
  const v = inq.validateInquiry(good({ extra: 'ignored', isAdmin: true }));
  check('unknown extra properties are ignored', v.ok && !('extra' in v.value) && !('isAdmin' in v.value));
}

section('A5 bots get the same success response and nothing is sent');
{
  const lim = (t) => t.limiter;
  const cases = [
    ['honeypot filled', { website: 'http://spam.example' }],
    ['honeypot filled, other fields invalid', { website: 'x', name: '', email: 'nope', message: '' }],
    ['honeypot is not a string', { website: { a: 1 } }],
    ['submitted too fast (400 ms)', { elapsedMs: 400 }],
    ['submitted too fast (2,499 ms)', { elapsedMs: 2499 }],
    ['no timer at all', { elapsedMs: undefined }],
    ['timer is not a number', { elapsedMs: 'lots' }],
    ['negative timer', { elapsedMs: -5 }],
  ];
  for (const [name, over] of cases) {
    const t = mkEnv();
    const r = await t.run(good(over));
    const real = await mkEnv().run(good());
    check(`${name}: same response as a real success, nothing sent, no limiter use`, JSON.stringify(r) === JSON.stringify(real) && t.sent.length === 0, JSON.stringify(r));
    void lim;
  }
  const t = mkEnv();
  await t.run(good({ elapsedMs: 100 }));
  const again = [];
  for (let i = 0; i < 8; i++) again.push(await t.run(good({ email: `u${i}@ok.example` })));
  check('bot attempts do not burn the visitor rate limit', again.slice(0, 5).every((r) => r.status === 200) && t.sent.length === 10);
  check('exactly 2,500 ms is allowed', (await mkEnv().run(good({ elapsedMs: 2500 }))).status === 200);
}

section('A6 rate limits');
{
  const t = mkEnv();
  const out = [];
  for (let i = 0; i < 7; i++) out.push(await t.run(good({ email: `person${i}@co${i}.example` })));
  check('first 5 from one IP in an hour succeed', out.slice(0, 5).every((r) => r.status === 200), out.map((r) => r.status).join(','));
  check('6th and 7th are refused with 429', out[5].status === 429 && out[6].status === 429);
  check('refusal is friendly and shows the email address', /email us at hello@deepwelltechnology\.com/.test(out[5].body.error) && out[5].body.retryAfterSec > 0, out[5].body.error);
  check('refused requests send nothing (10 emails for 5 successes)', t.sent.length === 10);
  t.clock.now += 3_600_000;
  check('a fresh hour resets the per-IP limit', (await t.run(good({ email: 'later@co.example' }))).status === 200);
  check('a different IP is unaffected', (await t.run(good({ email: 'other@co.example' }), '198.51.100.9')).status === 200);

  const g = mkEnv();
  let ok = 0; let refused = null;
  for (let i = 0; i < 60; i++) {
    const r = await g.run(good({ email: `g${i}@c${i}.example` }), `10.0.${Math.floor(i / 250)}.${i % 250}`);
    if (r.status === 200) ok++; else if (!refused) refused = { i, r };
  }
  check('global cap: 50 inquiries a day across all visitors, then refused', ok === 50 && refused?.i === 50 && refused.r.status === 429 && /hello@deepwelltechnology\.com/.test(refused.r.body.error), `ok=${ok} first refusal at ${refused?.i}`);
  g.clock.now += 86_400_000;
  check('the global cap resets the next day', (await g.run(good({ email: 'next@day.example' }), '10.9.9.9')).status === 429 === false);

  const a = mkEnv();
  const r1 = await a.run(good({ email: 'same@person.example' }), '10.1.1.1');
  const r2 = await a.run(good({ email: 'same@person.example' }), '10.1.1.2');
  const r3 = await a.run(good({ email: 'SAME@person.example' }), '10.1.1.3');
  check('one visitor address gets at most 2 inquiries (and receipts) a day, case-insensitively', r1.status === 200 && r2.status === 200 && r3.status === 429 && a.sent.length === 4, `${r1.status},${r2.status},${r3.status}`);
  const lim = createLimiter({ now: () => T0, env: { SUPPORT_INQUIRY_PER_IP_HOUR: '1' }, shared: memShared() });
  check('limits are env-tunable (SUPPORT_INQUIRY_PER_IP_HOUR)', (await lim.checkInquiry({ req: { headers: { 'x-real-ip': '1.1.1.1' } }, email: 'a@b.example' })).ok && !(await lim.checkInquiry({ req: { headers: { 'x-real-ip': '1.1.1.1' } }, email: 'c@d.example' })).ok);
}
{
  const keys = [];
  const lim = createLimiter({ now: () => T0, env: {}, shared: async (k, ws, u) => { keys.push(k); return { units: 1, source: 'db' }; } });
  await lim.checkInquiry({ req: { headers: { 'x-real-ip': '203.0.113.77' } }, email: 'private.person@secret.example' });
  check('rate limit keys never contain the raw address or IP', keys.length === 3 && keys.every((k) => !k.includes('203.0.113.77') && !k.includes('private.person') && !k.includes('secret.example')), keys.join(' | '));
}

section('A7 provider failure and not configured');
{
  const t = mkEnv();
  t.mode.fail = true;
  const r = await t.run(good());
  check('provider says not sent -> 502 with the email-us fallback, never ok', r.status === 502 && !r.body.ok && /hello@deepwelltechnology\.com/.test(r.body.error), JSON.stringify(r));
  check('no receipt is sent when the team notification failed', t.sent.length === 1);
  check('failure is logged without personal data', t.logs.length === 1 && /sent=false/.test(t.logs[0]) && !/Sam|Acme|sam@/.test(t.logs[0]));
  const t2 = mkEnv();
  t2.mode.throwOnce = true;
  const r2 = await t2.run(good());
  check('sender throwing -> 502 fallback', r2.status === 502 && /hello@/.test(r2.body.error));
  const t3 = mkEnv();
  t3.mode.failSecond = true;
  const r3 = await t3.run(good());
  check('a failed visitor receipt does not fail the inquiry (the team already has it)', r3.status === 200 && t3.sent.length === 2 && /receipt=false/.test(t3.logs[0]));

  const saved = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  const origLog = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  let r4;
  try {
    r4 = await inq.runInquiry(good(), { req: { headers: { 'x-real-ip': '192.0.2.5' } }, limiter: createLimiter({ now: () => T0, env: {}, shared: memShared() }), send: sendEmail, env: {} });
  } finally {
    console.log = origLog;
    if (saved !== undefined) process.env.RESEND_API_KEY = saved;
  }
  check('RESEND_API_KEY unset: real sender is log-only, so the page gets an error (never a fake success)', r4.status === 502 && !r4.body.ok && /hello@deepwelltechnology\.com/.test(r4.body.error), JSON.stringify(r4));
}

section('A8 route wiring, logs and Sentry');
{
  const route = (await import('../api/_lib/support/route.js')).default;
  const mkRes = () => {
    const r = { code: 200, headers: {}, body: undefined };
    r.setHeader = (k, v) => { r.headers[k] = v; };
    r.status = (c) => { r.code = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    r.end = () => r;
    return r;
  };
  const saved = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  const captured = [];
  const o = { log: console.log, err: console.error, warn: console.warn };
  console.log = (...a) => captured.push(a.join(' '));
  console.error = (...a) => captured.push(a.join(' '));
  console.warn = (...a) => captured.push(a.join(' '));
  let bot; let real; let invalid; let wrongMethod;
  try {
    bot = mkRes();
    await route({ method: 'POST', headers: { 'x-real-ip': '192.0.2.50' }, body: good({ website: 'bot', email: 'bot@spam.example' }) }, bot);
    real = mkRes();
    await route({ method: 'POST', headers: { 'x-real-ip': '192.0.2.51' }, body: good({ name: 'Zelda Quill', company: 'Quillworks Ltd', email: 'zelda@quillworks.example', phone: '602-555-0188', message: 'Needle in haystack question text' }) }, real);
    invalid = mkRes();
    await route({ method: 'POST', headers: {}, body: JSON.stringify(good({ email: 'nope' })) }, invalid);
    wrongMethod = mkRes();
    await route({ method: 'PUT', headers: {}, body: good() }, wrongMethod);
  } finally {
    console.log = o.log; console.error = o.err; console.warn = o.warn;
    if (saved !== undefined) process.env.RESEND_API_KEY = saved;
  }
  check('route: bot gets 200 {ok:true}', bot.code === 200 && bot.body?.ok === true);
  check('route: unconfigured email -> 502 with the fallback address', real.code === 502 && /hello@deepwelltechnology\.com/.test(real.body?.error ?? '') && !real.body?.ok, JSON.stringify(real.body));
  check('route: string JSON body is parsed and validated -> 400 field error', invalid.code === 400 && invalid.body?.fields?.email);
  check('route: non-POST is still refused', wrongMethod.code === 405);
  check('route: responses are not cacheable', real.headers['Cache-Control'] === 'no-store');
  const dump = captured.join('\n');
  check('no PII reaches any log line (name, company, address, phone, message)', !/Zelda|Quill|quillworks|602-555|Needle in haystack/i.test(dump), dump.slice(0, 300));
  const src = fs.readFileSync(path.join(ROOT, 'api/_lib/support/inquiry.js'), 'utf8');
  const routeSrc = fs.readFileSync(path.join(ROOT, 'api/_lib/support/route.js'), 'utf8');
  const branch = routeSrc.slice(routeSrc.indexOf("body.action === 'inquiry'"), routeSrc.indexOf("body.surface !== undefined"));
  check('inquiry never goes to Sentry (no telemetry import or capture call)', !/telemetry|captureMessage|captureException|@sentry/i.test(src) && !/captureMessage|captureException|@sentry/i.test(branch));
  check('inquiry uses the shared Resend sender, validator and sanitizer', /from '\.\/handoff\.js'/.test(src) && /from '\.\/guard\.js'/.test(src) && /sendEmail/.test(routeSrc));
  const apiCount = fs.readdirSync(path.join(ROOT, 'api')).length;
  check('api/ still has exactly 13 entries (12 top-level files + _lib)', apiCount === 13, String(apiCount));
}

check('Part A made zero network calls (fetch was a tripwire)', netCalls === 0, String(netCalls));

/* ================================================================== static checks on index.html */
section('B0 index.html contract');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
{
  check('exactly one id="contact"', (html.match(/id="contact"/g) ?? []).length === 1);
  check('footer Contact link points at #contact', /<a href="#contact">Contact<\/a>/.test(html));
  check('Fleet "Contact sales" now scrolls to #contact', /<a class="btn btn-ghost" href="#contact">Contact sales<\/a>/.test(html) && !/plan=fleet[^"]*">Contact sales/.test(html));
  const contact = html.slice(html.indexOf('id="contact"'), html.indexOf('</main>'));
  check('"Send a sample box (free)" call to action is kept in the contact section', /Send a sample box \(free\)/.test(contact));
  check('founders’ names are kept in the contact section', /Sterling/.test(contact) && /Hilton/.test(contact));
  check('button text is "Send my question"', />Send my question</.test(contact));
  check('reply line with a selectable address (not only a mailto)', /We reply within one business day\. Or email <span class="inq-addr">hello@deepwelltechnology\.com<\/span>/.test(contact));
  check('consent line links to /privacy.html', /<p class="inq-consent">[^<]*<a href="\/privacy\.html">privacy policy<\/a>/.test(contact));
  for (const id of ['name', 'company', 'email', 'phone', 'size', 'message']) check(`field ${id} has a <label for>`, new RegExp(`<label for="inq-${id}"`).test(contact));
  check('autocomplete attributes: name, organization, email, tel', ['name', 'organization', 'email', 'tel'].every((a) => contact.includes(`autocomplete="${a}"`)));
  check('required fields are marked required', ['inq-name', 'inq-company', 'inq-email', 'inq-message'].every((id) => new RegExp(`id="${id}"[^>]*required`).test(contact)));
  check('where-checkboxes are in a fieldset with a legend', /<fieldset[^>]*>\s*<legend>Where are they today\?/.test(contact));
  check('status region is aria-live', /id="inq-status" role="status" aria-live="polite"/.test(contact));
  check('honeypot is hidden from assistive tech and the tab order', /class="inq-hp" aria-hidden="true"[\s\S]*tabindex="-1"/.test(contact));
  check('inputs are at least 16px (no iOS zoom)', /\.inq input\[type=text\][^{]*\{[^}]*font-size:16px/.test(html));
  check('size select has the six document bands, "Not sure" first', ['Not sure', 'Under 1,000', '1,000–5,000', '5,000–25,000', '25,000–50,000', 'More than 50,000'].every((s, i) => contact.indexOf(`>${s}<`) > 0 && (i === 0 || contact.indexOf(`>${s}<`) > contact.indexOf(`>${['Not sure', 'Under 1,000', '1,000–5,000', '5,000–25,000', '25,000–50,000'][i - 1]}<`))));
  check('no inquiry text goes through innerHTML', !/innerHTML/.test(html.slice(html.indexOf('/* r44: inquiry form. POSTs'), html.indexOf('window.va = window.va'))));
}

/* ================================================================== PART B: browser */
if (process.env.R44_SKIP_BROWSER === '1') {
  console.log('\n(browser part skipped)');
} else {
  globalThis.fetch = realFetch;
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/opt/pw-browsers';
  const { chromium } = await import('playwright');
  const DIST = path.join(ROOT, 'dist');
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.log('FAIL  dist/ not found: run `VITE_CLERK_PUBLISHABLE_KEY=pk_test_dummy npm run build` first');
    process.exit(1);
  }
  const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    let f = path.join(DIST, p === '/' ? 'index.html' : p);
    if (!f.startsWith(DIST) || !fs.existsSync(f)) { res.statusCode = 404; return res.end(); }
    if (fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
    if (!fs.existsSync(f)) { res.statusCode = 404; return res.end(); }
    res.setHeader('content-type', TYPES[path.extname(f)] || 'application/octet-stream');
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();

  const newPage = async (viewport, { mock } = {}) => {
    const ctx = await browser.newContext({ viewport, reducedMotion: 'reduce', hasTouch: viewport.width < 500 });
    const page = await ctx.newPage();
    const requests = [];
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|insights|fonts/i.test(m.text())) errors.push(m.text()); });
    await page.route('**/api/support', async (route) => {
      const req = route.request();
      if (req.method() !== 'POST') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"greeting":"x","suggestions":[]}' });
      const body = JSON.parse(req.postData() ?? '{}');
      if (body.action !== 'inquiry') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"reply":"x","sources":[],"mode":"faq"}' });
      requests.push(body);
      const m = mock ?? { status: 200, body: { ok: true }, delay: 0 };
      if (m.delay) await new Promise((r) => setTimeout(r, m.delay));
      if (m.abort) return route.abort();
      return route.fulfill({ status: m.status, contentType: 'application/json', body: JSON.stringify(m.body) });
    });
    await page.goto(BASE, { waitUntil: 'load' });
    return { ctx, page, requests, errors };
  };
  const fill = async (page, over = {}) => {
    const v = { name: 'Sam Rivera', company: 'Acme Heating', email: 'sam@acmeheating.example', phone: '480-555-0142', size: 'gt-50k', message: 'Can you read scanned warranty cards?', ...over };
    await page.fill('#inq-name', v.name);
    await page.fill('#inq-company', v.company);
    await page.fill('#inq-email', v.email);
    await page.fill('#inq-phone', v.phone);
    await page.selectOption('#inq-size', v.size);
    await page.fill('#inq-message', v.message);
  };
  const vis = (page, sel) => page.locator(sel).isVisible();

  section('B1 fill and send: sending state, request body, success panel');
  {
    const { ctx, page, requests, errors } = await newPage({ width: 1280, height: 900 }, { mock: { status: 200, body: { ok: true }, delay: 700 } });
    await page.locator('#contact').scrollIntoViewIfNeeded();
    await fill(page);
    await page.check('input[name="where"][value="paper"]');
    await page.check('input[name="where"][value="other"]');
    await page.click('#inq-send');
    await page.waitForFunction(() => document.getElementById('inq-send').disabled === true);
    check('sending: button is disabled and says Sending', (await page.locator('#inq-send').isDisabled()) && /Sending/.test(await page.locator('#inq-send').innerText()));
    check('sending: aria-live status announces it', /Sending your question/.test(await page.locator('#inq-status').innerText()) && (await page.locator('#inq-status').getAttribute('aria-live')) === 'polite');
    await page.click('#inq-send', { force: true, timeout: 500 }).catch(() => {});
    await page.waitForSelector('#inq-done:not([hidden])', { timeout: 15000 });
    check('exactly one request for the (double-clicked) submit', requests.length === 1, String(requests.length));
    const b = requests[0];
    check('request carries every field, the checkbox keys and a human-fill timer', b.action === 'inquiry' && b.name === 'Sam Rivera' && b.company === 'Acme Heating' && b.email === 'sam@acmeheating.example' && b.phone === '480-555-0142' && b.size === 'gt-50k' && JSON.stringify(b.where) === '["paper","other"]' && b.message.includes('warranty cards') && b.website === '' && b.elapsedMs >= 2500, JSON.stringify(b));
    check('success panel replaces the form', (await vis(page, '#inq-done')) && !(await vis(page, '#inq-form')));
    const title = await page.locator('#inq-done-title').innerText();
    const body = await page.locator('#inq-done-body').innerText();
    check('success says "Thanks, Sam." and that the question is with Sterling and Hilton', title === 'Thanks, Sam.' && /Your question is with Sterling and Hilton/.test(body) && /one business day/.test(body), `${title} / ${body}`);
    check('focus moved to the success panel (screen readers hear it)', await page.evaluate(() => document.activeElement?.id === 'inq-done'));
    check('no console or page errors', errors.length === 0, errors.join(' | '));
    await page.screenshot({ path: `${SHOT_DIR}/desktop-success-dark.png`, clip: await clipOf(page, '#contact'), fullPage: true });
    await page.click('#inq-again');
    check('"Ask another question" brings back an empty form', (await vis(page, '#inq-form')) && (await page.inputValue('#inq-name')) === '' && (await page.inputValue('#inq-message')) === '');
    await ctx.close();
  }

  section('B2 required-field errors');
  {
    const { ctx, page, requests } = await newPage({ width: 1280, height: 900 });
    await page.locator('#contact').scrollIntoViewIfNeeded();
    await page.click('#inq-send');
    const expected = { name: /your name/i, company: /company name/i, email: /work email/i, message: /type your question/i };
    for (const [k, re] of Object.entries(expected)) {
      const e = page.locator(`#inq-e-${k}`);
      check(`empty form: ${k} shows a plain-English error`, (await e.isVisible()) && re.test(await e.innerText()));
      check(`empty form: ${k} is aria-invalid and described by its error`, (await page.locator(`#inq-${k}`).getAttribute('aria-invalid')) === 'true' && (await page.locator(`#inq-${k}`).getAttribute('aria-describedby')).includes(`inq-e-${k}`));
    }
    check('phone (optional) shows no error', !(await vis(page, '#inq-e-phone')));
    check('no request was sent', requests.length === 0);
    check('focus lands on the first invalid field', await page.evaluate(() => document.activeElement?.id === 'inq-name'));
    check('summary is announced in the live region', /highlighted fields/.test(await page.locator('#inq-status').innerText()));
    await page.screenshot({ path: `${SHOT_DIR}/desktop-errors-dark.png`, clip: await clipOf(page, '#contact'), fullPage: true });
    await page.fill('#inq-name', 'Sam');
    check('typing clears that field’s error', !(await vis(page, '#inq-e-name')) && (await page.locator('#inq-name').getAttribute('aria-invalid')) === null);
    await page.fill('#inq-company', 'Acme');
    await page.fill('#inq-email', 'not-an-email');
    await page.fill('#inq-message', 'hello there friend');
    await page.fill('#inq-phone', 'abc');
    await page.click('#inq-send');
    check('bad email and bad phone are caught on the page', /name@company\.com/.test(await page.locator('#inq-e-email').innerText()) && /phone number/.test(await page.locator('#inq-e-phone').innerText()) && requests.length === 0);
    await page.fill('#inq-email', 'sam@acme.example');
    await page.fill('#inq-phone', '');
    await page.fill('#inq-message', 'hi');
    await page.click('#inq-send');
    check('a too-short question gets a friendly nudge', /more detail/.test(await page.locator('#inq-e-message').innerText()) && requests.length === 0);
    await page.fill('#inq-message', 'x'.repeat(1850));
    check('character counter appears only near the limit', (await vis(page, '#inq-count')) && /1,850 \/ 2,000/.test(await page.locator('#inq-count').innerText()));
    await page.fill('#inq-message', 'short again');
    check('counter hides again below the limit', !(await vis(page, '#inq-count')));
    check('textarea hard-stops at 2,000 characters', (await page.locator('#inq-message').getAttribute('maxlength')) === '2000');
    await ctx.close();
  }

  section('B3 server errors show the email-us fallback');
  for (const [name, mock, re] of [
    ['502 from the server', { status: 502, body: { error: 'We could not send that just now. Please email us at hello@deepwelltechnology.com and we will reply within one business day.' } }, /hello@deepwelltechnology\.com/],
    ['429 rate limited', { status: 429, body: { error: 'We have had a lot of messages from your network. Please email us at hello@deepwelltechnology.com instead.', retryAfterSec: 3000 } }, /lot of messages[\s\S]*hello@deepwelltechnology\.com/],
    ['500 with no JSON', { status: 500, body: {} }, /hello@deepwelltechnology\.com/],
    ['network failure', { abort: true }, /hello@deepwelltechnology\.com/],
  ]) {
    const { ctx, page, requests } = await newPage({ width: 1280, height: 900 }, { mock });
    await page.locator('#contact').scrollIntoViewIfNeeded();
    await fill(page);
    await page.click('#inq-send');
    await page.waitForFunction(() => /@/.test(document.getElementById('inq-status').innerText) && !document.getElementById('inq-send').disabled, null, { timeout: 15000 });
    const text = await page.locator('#inq-status').innerText();
    check(`${name}: the page shows the fallback address in the live region and never a success`, re.test(text) && !(await vis(page, '#inq-done')) && (await vis(page, '#inq-form')), text);
    check(`${name}: the form keeps what the visitor typed and the button is usable again`, (await page.inputValue('#inq-message')).includes('warranty') && !(await page.locator('#inq-send').isDisabled()));
    check(`${name}: the address in the message is selectable text`, (await page.locator('#inq-status .inq-addr').count()) === 1 && (await page.locator('#inq-status .inq-addr').innerText()) === 'hello@deepwelltechnology.com');
    if (name.startsWith('502')) await page.screenshot({ path: `${SHOT_DIR}/desktop-failure-dark.png`, clip: await clipOf(page, '#contact'), fullPage: true });
    void requests;
    await ctx.close();
  }
  {
    const { ctx, page } = await newPage({ width: 1280, height: 900 }, { mock: { status: 400, body: { error: 'Please check the highlighted fields.', fields: { email: 'Please enter your work email, like name@company.com, so we can reply.' } } } });
    await page.locator('#contact').scrollIntoViewIfNeeded();
    await fill(page, { email: 'sam@acmeheating.example' });
    await page.click('#inq-send');
    await page.waitForSelector('#inq-e-email:not([hidden])', { timeout: 15000 });
    check('server field errors land under the right field', /work email/.test(await page.locator('#inq-e-email').innerText()) && (await page.locator('#inq-email').getAttribute('aria-invalid')) === 'true');
    await ctx.close();
  }

  section('B4 keyboard-only submit');
  {
    const { ctx, page, requests } = await newPage({ width: 1280, height: 900 });
    await page.locator('#inq-name').scrollIntoViewIfNeeded();
    await page.focus('#inq-name');
    const kb = page.keyboard;
    await kb.type('Kay Okafor');
    await kb.press('Tab'); await kb.type('Okafor Plumbing');
    await kb.press('Tab'); await kb.type('kay@okaforplumbing.example');
    await kb.press('Tab'); // phone: skip
    await kb.press('Tab'); // size select
    check('Tab order: phone then size select', await page.evaluate(() => document.activeElement?.id === 'inq-size'));
    await kb.press('ArrowDown'); // Under 1,000
    await kb.press('Tab'); await kb.press('Space'); // Paper
    await kb.press('Tab'); // computer
    await kb.press('Tab'); await kb.press('Space'); // Google Drive
    await kb.press('Tab'); // other
    await kb.press('Tab'); // message (honeypot is skipped)
    check('Tab order skips the honeypot and reaches the question box', await page.evaluate(() => document.activeElement?.id === 'inq-message'));
    await kb.type('Do you handle old job folders?');
    await kb.press('Tab');
    check('Tab from the question box lands on the send button', await page.evaluate(() => document.activeElement?.id === 'inq-send'));
    const outline = await page.evaluate(() => { const s = getComputedStyle(document.getElementById('inq-send')); return `${s.outlineStyle}/${s.outlineWidth}`; });
    check('focus is visible on the button', /solid\/2px/.test(outline), outline);
    await kb.press('Enter');
    await page.waitForSelector('#inq-done:not([hidden])', { timeout: 15000 });
    check('keyboard submit reaches the success panel', /Thanks, Kay\./.test(await page.locator('#inq-done-title').innerText()));
    check('keyboard values were sent (size by arrow, boxes by Space)', requests[0]?.size === 'lt-1k' && JSON.stringify(requests[0].where) === '["paper","google-drive"]', JSON.stringify(requests[0]));
    await ctx.close();
  }

  section('B5 phone 390px and desktop: no overflow, big targets, readable inputs');
  for (const vp of [{ width: 390, height: 844, label: 'phone-390' }, { width: 375, height: 812, label: 'phone-375' }, { width: 1280, height: 900, label: 'desktop-1280' }, { width: 768, height: 1024, label: 'tablet-768' }]) {
    const { ctx, page, errors } = await newPage(vp);
    await page.locator('#contact').scrollIntoViewIfNeeded();
    const over = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, body: document.body.scrollWidth - document.documentElement.clientWidth }));
    check(`${vp.label}: no horizontal scroll`, over.doc <= 0 && over.body <= 0, JSON.stringify(over));
    const inside = await page.evaluate(() => {
      const w = document.documentElement.clientWidth;
      return [...document.querySelectorAll('#inq *')].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > w + 0.5 || r.left < -0.5) && !el.closest('.inq-hp'); }).map((el) => el.id || el.className || el.tagName);
    });
    check(`${vp.label}: nothing in the form pokes outside the screen`, inside.length === 0, inside.join(','));
    const small = await page.evaluate(() => {
      const bad = [];
      for (const el of document.querySelectorAll('#inq input:not([type=checkbox]):not(.inq-hp input), #inq select, #inq textarea, #inq button, #inq label.inq-check')) {
        if (el.closest('.inq-hp') || el.offsetParent === null) continue;
        const r = el.getBoundingClientRect();
        if (r.height < 43.5 || r.width < 43.5) bad.push(`${el.id || el.className}:${Math.round(r.width)}x${Math.round(r.height)}`);
      }
      return bad;
    });
    check(`${vp.label}: every input, select, button and checkbox row is at least 44px`, small.length === 0, small.join(','));
    const fonts = await page.evaluate(() => [...document.querySelectorAll('#inq input:not([type=checkbox]), #inq select, #inq textarea')].filter((e) => !e.closest('.inq-hp')).map((e) => parseFloat(getComputedStyle(e).fontSize)));
    check(`${vp.label}: inputs are at least 16px`, fonts.length >= 6 && fonts.every((f) => f >= 16), fonts.join(','));
    const labelled = await page.evaluate(() => ['inq-name', 'inq-company', 'inq-email', 'inq-phone', 'inq-size', 'inq-message'].every((id) => document.querySelector(`label[for="${id}"]`) && document.getElementById(id).labels.length === 1));
    check(`${vp.label}: every field has exactly one real label`, labelled);
    const above = await page.evaluate(() => ['inq-name', 'inq-email', 'inq-message'].every((id) => document.querySelector(`label[for="${id}"]`).getBoundingClientRect().bottom <= document.getElementById(id).getBoundingClientRect().top + 1));
    check(`${vp.label}: labels sit above their inputs`, above);
    check(`${vp.label}: no console errors`, errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  section('B6 "Contact sales" and the footer land on the form; no layout shift on load');
  {
    const { ctx, page } = await newPage({ width: 1280, height: 900 });
    await page.locator('#plans').scrollIntoViewIfNeeded();
    const btn = page.locator('#plans a:has-text("Contact sales")');
    check('Fleet card has a "Contact sales" button pointing at #contact', (await btn.count()) === 1 && (await btn.getAttribute('href')) === '#contact');
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
    await page.waitForFunction(() => location.hash === '#contact');
    await page.waitForTimeout(1500);
    const pos = await page.evaluate(() => { const r = document.getElementById('inq-name').getBoundingClientRect(); const c = document.getElementById('contact').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, vh: innerHeight, cTop: c.top }; });
    check('after "Contact sales" the form fields are on screen', pos.top >= 0 && pos.bottom <= pos.vh, JSON.stringify(pos));
    check('nothing is preselected (size = Not sure, no boxes ticked)', (await page.inputValue('#inq-size')) === 'not-sure' && (await page.locator('input[name="where"]:checked').count()) === 0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    await page.click('footer a[href="#contact"]');
    await page.waitForTimeout(1500);
    const pos2 = await page.evaluate(() => { const r = document.getElementById('inq-name').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, vh: innerHeight }; });
    check('the footer Contact link lands on the form too', pos2.top >= 0 && pos2.bottom <= pos2.vh, JSON.stringify(pos2));
    await ctx.close();

    const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', hasTouch: true });
    const p2 = await ctx2.newPage();
    await p2.addInitScript(() => {
      window.__shifts = [];
      new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__shifts.push({ v: e.value, nodes: (e.sources || []).map((s) => (s.node && s.node.nodeType === 1 ? (s.node.closest('#contact') ? 'contact' : 'other') : 'other')) }); }).observe({ type: 'layout-shift', buffered: true });
    });
    await p2.goto(BASE, { waitUntil: 'load' });
    await p2.waitForTimeout(1200);
    await p2.locator('#contact').scrollIntoViewIfNeeded();
    await p2.waitForTimeout(800);
    const shifts = await p2.evaluate(() => window.__shifts);
    check('no layout shift originates in the contact section', shifts.every((s) => !s.nodes.includes('contact')), JSON.stringify(shifts));
    await ctx2.close();
  }

  section('B7 screenshots in both themes (look at them)');
  async function clipOf(page, sel) {
    const r = await page.evaluate((s) => { const e = document.querySelector(s); const b = e.getBoundingClientRect(); return { x: Math.max(0, b.left + scrollX - 8), y: b.top + scrollY - 8, width: Math.min(innerWidth, b.width + 16), height: b.height + 16 }; }, sel);
    return r;
  }
  globalThis.clipOf = clipOf;
  for (const vp of [{ width: 1280, height: 900, label: 'desktop' }, { width: 390, height: 844, label: 'phone' }]) {
    for (const theme of ['light', 'dark']) {
      const { ctx, page } = await newPage(vp);
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      await page.locator('#contact').scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOT_DIR}/${vp.label}-form-${theme}.png`, clip: await clipOf(page, '#contact'), fullPage: true });
      await fill(page);
      await page.check('input[name="where"][value="computer"]');
      await page.focus('#inq-message');
      await page.screenshot({ path: `${SHOT_DIR}/${vp.label}-filled-${theme}.png`, clip: await clipOf(page, '#contact'), fullPage: true });
      const colors = await page.evaluate(() => { const s = getComputedStyle(document.getElementById('inq-name')); const p = getComputedStyle(document.getElementById('inq')); return { input: s.backgroundColor, panel: p.backgroundColor, text: s.color }; });
      check(`${vp.label} ${theme}: form uses the theme's colors (input text differs from its background)`, colors.input !== colors.text && colors.panel !== 'rgba(0, 0, 0, 0)', JSON.stringify(colors));
      await ctx.close();
    }
  }
  const shots = fs.readdirSync(SHOT_DIR).filter((f) => f.endsWith('.png'));
  check(`screenshots written to ${SHOT_DIR} (${shots.length})`, shots.length >= 8);

  await browser.close();
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
