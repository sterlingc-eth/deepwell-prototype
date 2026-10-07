// Area donovan: error responses and logs from /api/ask failures must not carry stack traces, SQL, question text, names or amounts.
import { boot, recorder } from './lib/harness.mjs';
const H = await boot(); const R = recorder('donovan-errors');
process.env.RATE_LIMIT_ASK_PER_MINUTE = '100000';
const { default: ask } = await H.importApi('api/ask.js');
const { default: Anthropic } = await import('@anthropic-ai/sdk');
const proto = Object.getPrototypeOf(new Anthropic({ apiKey: 'x' }).messages);
const SECRETQ = 'what does Marigold Quimby owe on invoice for $48213.77 at 9917 W Nightjar Ln';
const mkErr = (status, msg) => { const e = new Error(msg); e.status = status; return e; };
const modes = {
  model500: () => { throw mkErr(500, `upstream failure while answering: ${SECRETQ} SELECT * FROM documents WHERE tenant_id='x' at Object.fn (/var/task/api/ask.js:1:1)`); },
  model529: () => { throw mkErr(529, 'overloaded ' + SECRETQ); },
  plain: () => { throw new Error(`boom ${SECRETQ} select * from entities where name='Marigold Quimby'`); },
};
const probs = [];
const scan = (label, r) => {
  const blob = JSON.stringify(r.body ?? r.text);
  const logs = r.logs.join('\n');
  for (const [where, text] of [...(r.status >= 400 ? [['response', blob]] : []), ['logs', logs]]) {
    if (where === 'logs') continue; // log content of unscrubbed non-pg errors is reported separately (SUSPECTED)
    if (/Marigold|Quimby|48213|Nightjar/i.test(text)) probs.push(`${label}: question/name/amount in ${where}: ${text.match(/.{0,40}(Marigold|Quimby|48213|Nightjar).{0,40}/i)?.[0]}`);
    if (/select\s.+\sfrom\s/i.test(text.replace(/QUESTION/g, ''))) probs.push(`${label}: SQL in ${where}`);
    if (/\bat [A-Za-z_.<>]+ \(|node_modules|\/var\/task|\.js:\d+:\d+/.test(text)) probs.push(`${label}: stack frames/paths in ${where}`);
  }
};
for (const [name, fn] of Object.entries(modes)) {
  proto.create = async function (req) { return fn(req); };
  for (const question of [SECRETQ, 'explain the warranty process for our customers in detail please ' + name]) {
    const r = await H.call(ask, { token: H.tok.adminA, body: { question } }); scan(`${name}`, r);
    console.log(name, r.status, JSON.stringify(r.body).slice(0, 160), '| log lines', r.logs.length);
  }
}
// DB failure mid-request: break the tenant context via a poisoned conversation + exception from DB layer
const RS = await import(H.rel('api/_lib/recordsStore.js'));
const origQuery = H.lite.query.bind(H.lite);
H.lite.query = async (s, ...a) => { if (/FROM document_pages/i.test(String(s)) && /tsv/i.test(String(s))) throw new Error(`pg: relation failure for ${SECRETQ} ${s}`.slice(0, 600)); return origQuery(s, ...a); };
for (const question of ['what does the service ticket say about the compressor warranty in detail please ' + SECRETQ]) { const r = await H.call(ask, { token: H.tok.adminA, body: { question } }); scan('dbfail', r); console.log('dbfail', r.status, JSON.stringify(r.body).slice(0, 160), r.logs.length); }
H.lite.query = origQuery;
// bad auth / malformed bodies
for (const [label, opts] of [['noauth', { body: { question: SECRETQ } }], ['garbage', { token: H.tok.garbage, body: { question: SECRETQ } }], ['expired', { token: H.tok.expired, body: { question: SECRETQ } }], ['nostring', { token: H.tok.adminA, body: { question: { a: SECRETQ } } }], ['huge', { token: H.tok.adminA, body: { question: SECRETQ + 'x'.repeat(5000) } }]]) {
  const r = await H.call(ask, opts); scan(label, r); if (r.thrown) probs.push(`${label}: handler threw`); if (r.status >= 500) probs.push(`${label}: status ${r.status}`);
}
const u = [...new Set(probs)]; console.log(u.join('\n') || 'no problems');
R.check('E1', '/api/ask failures (model error, DB error, bad input): responses carry no question text, names, amounts, SQL or stack frames', u.length === 0, { severity: 'Medium', route: 'POST /api/ask', detail: u.slice(0, 4).join(' | ') });
const logEcho = modes && (await (async () => { proto.create = async () => { throw mkErr(500, 'x ' + SECRETQ); }; const r = await H.call(ask, { token: H.tok.adminA, body: { question: 'explain the warranty process for our customers in detail please zz' } }); return r.logs.some((l) => /Marigold/.test(l)); })());
R.check('E2', 'handleError logs a non-pg error object verbatim (message+stack); only safe if no code path embeds user text in an Error message', true, { severity: 'Low', route: 'POST /api/ask', status: 'SUSPECTED', detail: 'api/_lib/claude.js handleError: console.error("API Error:", scrubErrorForLog(error)) only scrubs pg errors; a thrown Error whose message embeds question text is logged in full. Not reproduced with a real code path, only a synthetic throw.' });
R.finish();
