/**
 * /api/account?action=demo-try   "Try your own documents" on the public demo page (/demo/). No account, no sign-in.
 *
 *   GET/POST {op:'status'}                   is the feature switched on, and the limits to show (no cost, no counter)
 *   POST {op:'presign', sid, files:[...]}    count the upload against every cap, check the daily budget, return one-use upload
 *                                            links to TEMPORARY storage + a signed ticket
 *   POST {op:'read', sid, ticket, names}     read the uploaded files once (text layer -> license barcode -> Haiku vision for scans),
 *                                            return type + fields + summary per file + a signed question context, then DELETE the files
 *   POST {op:'ask', sid, question, ctx}      one Donovan answer about the visitor's own (masked) text; 5 per browser session
 *   GET  {op:'sweep'}                        cron only: delete temporary files older than 45 minutes
 *
 * What it never does: write to any table (the only database touch is the shared counter function behind limits.js), keep a file past
 * its read, log a file name / text / value, show a dollar amount, or call a model that is not Haiku. Everything is injectable
 * (createRoute(deps)) so scripts/verify-demo-tryown.ts drives it with a stubbed model, an in-memory store and counters.
 */
import { handleCors } from '../../claude.js';
import { LIMITS, TEXT, resolveConfig, worstCaseReadUsd, worstCaseAskUsd, usdFor, DEFAULTS } from './config.js';
import { createLimiter, clientIp, validSessionId } from './limits.js';
import { sign, verify, newId } from './token.js';
import { createR2Store, sweepTemp, isTempKey } from './tempStore.js';
import { maskPages, maskText } from './mask.js';

const NAME_MAX = 120;
const CTX_CHARS_TOTAL = 24_000;
const QUESTION_MAX = 300;

const cleanName = (n) => String(n ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);

/** Counters and outcomes only. NEVER a file name, a value, text, a key or an IP. */
function logEvent(op, ok, extra = {}) {
  console.log(JSON.stringify({ route: 'demo-tryown', op, ok, ...extra }));
}

function friendly(code) {
  switch (code) {
    case 'empty': return TEXT.emptyFile;
    case 'too-big': return TEXT.tooBig;
    case 'heic': return TEXT.heic;
    case 'wrong-type': return TEXT.wrongType;
    case 'unreadable': return TEXT.unreadable;
    case 'too-many-pages': return TEXT.tooManyPages;
    default: return TEXT.generic;
  }
}
const limitMessage = (reason, forQuestions = false) =>
  reason === 'daily-cap' || reason === 'daily-global' ? TEXT.capReached
    : reason === 'slow-down' ? (forQuestions ? TEXT.slowDownQuestions : TEXT.slowDown)
    : reason === 'questions-used' ? TEXT.noQuestionsLeft
    : TEXT.unavailable;

/** @param {{limiter?: object, store?: object, now?: () => number, env?: object, loadReader?: () => Promise<object>, makeModel?: Function, analyze?: Function, classify?: Function}} [deps] */
export function createRoute(deps = {}) {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => Date.now());
  const limiter = deps.limiter ?? createLimiter({ env, now });
  const store = deps.store ?? createR2Store();
  const budgetMs = deps.budgetMs ?? DEFAULTS.requestBudgetMs;
  const sweepChance = deps.sweepChance ?? 1; // sweep on every upload request and every read: the cron may only run hourly on some plans
  const loadReader = deps.loadReader ?? (() => import('./readFile.js'));
  const loadAnalyze = deps.analyze ? async () => deps.analyze : async () => (await import('./analyze.js')).analyzePages;
  const loadSummary = async () => (await import('./analyze.js')).summarize;
  const makeModel = deps.makeModel ?? (async (o) => (await import('./model.js')).createModel(o));
  const classify = deps.classify ?? (async (q) => { try { return (await import('../../router/safetyGate.js')).classifySafety(q); } catch { return null; } });

  const out = (res, req, status, body, extraHeaders = {}) => {
    const r = typeof res.setHeader === 'function' ? res : res;
    try { r.setHeader?.('Cache-Control', 'no-store'); for (const [k, v] of Object.entries(extraHeaders)) r.setHeader?.(k, v); } catch { /* headers are best effort */ }
    return handleCors(res, req).status(status).json(body);
  };
  const refuse = (res, req, status, message, extra = {}, headers = {}) => out(res, req, status, { ok: false, error: message, ...extra }, headers);

  /* ---------------------------------------------------------------- status */
  async function status(req, res) {
    const cfg = resolveConfig(env);
    const enabled = cfg.enabled && !!cfg.secret;
    return out(res, req, 200, {
      ok: true, enabled,
      limits: { files: LIMITS.maxFiles, pages: LIMITS.maxPagesTotal, fileMb: LIMITS.maxFileBytes / 1048576, questions: LIMITS.maxQuestions, types: LIMITS.types },
      ...(enabled ? {} : { message: TEXT.unavailable }),
    });
  }

  /* ---------------------------------------------------------------- presign */
  async function presign(req, res, body) {
    const cfg = resolveConfig(env);
    if (!cfg.enabled || !cfg.secret) return refuse(res, req, 503, TEXT.unavailable, { code: 'off' });
    const sid = body?.sid;
    if (!validSessionId(sid)) return refuse(res, req, 400, TEXT.generic, { code: 'bad-session' });
    const files = Array.isArray(body?.files) ? body.files : [];
    if (files.length < 1 || files.length > LIMITS.maxFiles) return refuse(res, req, 400, TEXT.tooManyFiles, { code: 'too-many-files' });
    for (const f of files) {
      const size = Number(f?.size);
      if (!Number.isInteger(size) || size < 1) return refuse(res, req, 400, TEXT.emptyFile, { code: 'empty' });
      if (size > LIMITS.maxFileBytes) return refuse(res, req, 413, TEXT.tooBig, { code: 'too-big' });
      const t = String(f?.type ?? '').toLowerCase();
      if (t === 'image/heic' || t === 'image/heif') return refuse(res, req, 415, TEXT.heic, { code: 'heic' });
      if (!LIMITS.types.includes(t)) return refuse(res, req, 415, TEXT.wrongType, { code: 'wrong-type' });
    }
    // 1) the budget first (it costs nothing to ask), 2) every rate cap
    const gate = await limiter.peekSpend(worstCaseReadUsd(files.length, env));
    if (!gate.ok) { logEvent('presign', false, { why: gate.reason }); return refuse(res, req, gate.reason === 'unavailable' ? 503 : 429, limitMessage(gate.reason), { code: gate.reason }); }
    const rate = await limiter.checkUpload({ req, sid });
    if (!rate.ok) { logEvent('presign', false, { why: rate.reason }); return refuse(res, req, rate.reason === 'unavailable' ? 503 : 429, limitMessage(rate.reason), { code: rate.reason }, { 'Retry-After': String(rate.retryAfterSec) }); }

    if (Math.random() < sweepChance) await sweepTemp(store, { now: now(), maxAgeMs: DEFAULTS.tempMaxAgeMs });

    let uploads;
    const keys = [];
    try {
      uploads = files.map((f) => {
        const key = store.newKey();
        keys.push({ key, size: Number(f.size) });
        return { url: store.putUrl(key, Number(f.size), DEFAULTS.uploadUrlSeconds), expiresIn: DEFAULTS.uploadUrlSeconds };
      });
    } catch {
      return refuse(res, req, 503, TEXT.unavailable, { code: 'storage' });
    }
    const ticket = sign(cfg.secret, 'ticket', { v: 1, sid, nonce: newId(12), exp: now() + (DEFAULTS.uploadUrlSeconds + 60) * 1000, files: keys });
    logEvent('presign', true, { files: files.length });
    return out(res, req, 200, { ok: true, ticket, uploads });
  }

  /* ---------------------------------------------------------------- read */
  async function read(req, res, body) {
    const cfg = resolveConfig(env);
    if (!cfg.enabled || !cfg.secret) return refuse(res, req, 503, TEXT.unavailable, { code: 'off' });
    const t = verify(cfg.secret, 'ticket', body?.ticket, now());
    if (!t || !validSessionId(body?.sid) || t.sid !== body.sid || !Array.isArray(t.files) || t.files.length < 1 || t.files.length > LIMITS.maxFiles
      || !t.files.every((f) => isTempKey(f.key))) return refuse(res, req, 400, TEXT.expired, { code: 'expired' });
    const keys = t.files.map((f) => f.key);
    // The temporary files are deleted whatever happens from here on.
    const cleanup = async () => {
      let failed = 0;
      for (const k of keys) {
        try { await store.del(k); } catch { try { await store.del(k); } catch { failed++; } } // one retry; the sweep is the last net
      }
      if (failed) logEvent('cleanup', false, { failed });
    };
    let reservation = null;
    let spentMicro = 0;
    let workStarted = false; // no model call can have happened before this
    let workDone = false; // every model call has finished (not timed out, not crashed)
    let erroredFiles = 0; // files that ended in an error: a model call may have been BILLED without its usage ever being reported back
    try {
      if (!(await limiter.claimTicket(t.nonce))) return refuse(res, req, 400, TEXT.expired, { code: 'used' });
      const gate = await limiter.reserve(worstCaseReadUsd(keys.length, env));
      reservation = gate;
      if (!gate.ok) { logEvent('read', false, { why: gate.reason }); return refuse(res, req, gate.reason === 'unavailable' ? 503 : 429, limitMessage(gate.reason), { code: gate.reason }); }

      const startedAt = now();
      const deadlineAt = startedAt + budgetMs;
      const names = Array.isArray(body?.names) ? body.names.map(cleanName) : [];

      // 1) fetch into memory
      let buffers;
      try {
        buffers = await Promise.all(t.files.map((f) => store.get(f.key, LIMITS.maxFileBytes + 1)));
      } catch (err) {
        logEvent('read', false, { why: 'fetch', status: Number(err?.status) || 0 });
        return refuse(res, req, 410, TEXT.expired, { code: 'expired' });
      }

      // 2) validate every file BEFORE any model call
      const reader = await loadReader();
      const checked = [];
      let totalPages = 0;
      for (let i = 0; i < buffers.length; i++) {
        try {
          const info = reader.inspectFile(buffers[i]);
          checked.push({ i, ...info });
          totalPages += info.pages;
        } catch (err) {
          if (err?.name === 'RejectError') { logEvent('read', false, { why: err.code }); return refuse(res, req, 422, friendly(err.code), { code: err.code, file: i }); }
          throw err;
        }
      }
      if (totalPages > LIMITS.maxPagesTotal) { logEvent('read', false, { why: 'too-many-pages' }); return refuse(res, req, 422, TEXT.tooManyPages, { code: 'too-many-pages' }); }

      // 3) read each file (text layer -> barcode -> Haiku vision for scans), then fields + summary
      const onUsage = async (u) => { spentMicro += Math.round(usdFor(u, env) * 1e6); };
      const model = await makeModel({ model: cfg.model, onUsage, deadlineAt, now });
      const analyzePages = await loadAnalyze();
      const summarize = await loadSummary();
      const pack = await packFor(body?.pack);

      workStarted = true;
      const work = checked.map(async (c) => {
        try {
          const r = await reader.readBytes(buffers[c.i], c.type, { model: cfg.model, onUsage }, startedAt);
          const a = await analyzePages({ pages: r.pages, filename: names[c.i] ?? '', pack, extract: (q) => model.extract(q) });
          const masked = maskPages(r.pages, { id: a.idDoc });
          return { i: c.i, pages: c.pages, how: r.how, a, masked };
        } catch (err) {
          if (err?.name === 'RejectError') return { i: c.i, error: err.code };
          if (err?.name === 'DemoModelError') return { i: c.i, error: err.code === 'timeout' ? 'timeout' : 'generic' };
          return { i: c.i, error: 'generic', errName: String(err?.name ?? 'Error').slice(0, 40), errStatus: Number(err?.status) || 0 };
        }
      });
      const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), Math.max(1_000, deadlineAt - now())).unref?.());
      const results = await Promise.race([Promise.all(work), timeout]);
      for (let i = 0; i < buffers.length; i++) buffers[i] = null; // drop the bytes
      erroredFiles = results === 'timeout' ? 0 : results.filter((r) => r.error).length;
      workDone = results !== 'timeout'; // a timed-out read may still be spending: it keeps the whole reservation
      if (results === 'timeout') { logEvent('read', false, { why: 'timeout' }); return refuse(res, req, 504, TEXT.busy, { code: 'timeout' }); }

      // 4) shape what the browser gets: masked fields, a summary, and a signed context of the MASKED text for questions
      const docs = [];
      const ctxDocs = [];
      const perDoc = Math.floor(CTX_CHARS_TOTAL / Math.max(1, results.filter((r) => !r.error).length));
      for (const r of results) {
        if (r.error) { docs.push({ i: r.i, ok: false, error: r.error === 'timeout' ? TEXT.busy : friendly(r.error) }); continue; }
        const shown = r.a.shown;
        docs.push({
          i: r.i, ok: true, pages: r.pages, type: r.a.type, typeLabel: r.a.typeLabel, how: r.how, readHow: TEXT.readHow[r.how] ?? TEXT.readHow.text,
          fields: shown.map((f) => ({ label: f.label, value: f.value, masked: f.masked })),
          summary: summarize({ typeLabel: r.a.typeLabel, shown, pageCount: r.pages }),
        });
        const text = r.masked.map((p) => `[page ${p.page_no}]\n${p.text}`).join('\n\n').slice(0, perDoc);
        ctxDocs.push({ i: r.i, typeLabel: r.a.typeLabel, text });
      }
      const okCount = docs.filter((d) => d.ok).length;
      const ctxToken = okCount ? sign(cfg.secret, 'ctx', { v: 1, sid: body.sid, exp: now() + DEFAULTS.ctxTtlMs, docs: ctxDocs }) : null;
      logEvent('read', okCount > 0, { files: docs.length, ok: okCount, pages: totalPages, usdMicro: spentMicro, ms: now() - startedAt });
      return out(res, req, 200, { ok: okCount > 0, docs, ctx: ctxToken, notice: TEXT.notice, questionsLeft: LIMITS.maxQuestions });
    } finally {
      await cleanup(); // right after the read, on every path
      if (Math.random() < sweepChance) await sweepTemp(store, { now: now(), maxAgeMs: DEFAULTS.tempMaxAgeMs }); // never throws; catches other visitors' abandoned uploads
      try { // What to keep: nothing before any model call; the reported usage when every file read cleanly; and for a file that ended in an error
      // (a provider timeout or a cut-off answer is billed but never reported) that file's whole share of the reservation. A timeout keeps it all.
      const keepMicro = !workStarted ? 0 : !workDone ? null
        : Math.min(reservation?.micro ?? 0, spentMicro + erroredFiles * Math.ceil((reservation?.micro ?? 0) / Math.max(1, keys.length)));
      await limiter.settle(reservation, keepMicro == null ? null : keepMicro / 1e6); } catch { /* the reservation stays: fail closed */ }
    }
  }

  async function packFor(id) {
    try {
      const { PACK_IDS, getPack } = await import('../../industry/index.js');
      return typeof id === 'string' && PACK_IDS.includes(id) ? getPack(id) : null;
    } catch { return null; }
  }

  /* ---------------------------------------------------------------- ask */
  async function ask(req, res, body) {
    const cfg = resolveConfig(env);
    if (!cfg.enabled || !cfg.secret) return refuse(res, req, 503, TEXT.unavailable, { code: 'off' });
    const sid = body?.sid;
    const question = String(body?.question ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!validSessionId(sid) || !question) return refuse(res, req, 400, TEXT.generic, { code: 'bad-request' });
    if (question.length > QUESTION_MAX) return refuse(res, req, 400, TEXT.generic, { code: 'too-long' });
    const c = verify(cfg.secret, 'ctx', body?.ctx, now());
    if (!c || c.sid !== sid || !Array.isArray(c.docs) || !c.docs.length) return refuse(res, req, 400, TEXT.expired, { code: 'expired' });

    const rate = await limiter.checkQuestion({ req, sid });
    if (!rate.ok) { logEvent('ask', false, { why: rate.reason }); return refuse(res, req, rate.reason === 'unavailable' ? 503 : 429, limitMessage(rate.reason, true), { code: rate.reason, questionsLeft: 0 }, { 'Retry-After': String(rate.retryAfterSec) }); }
    const left = Math.max(0, rate.left); // the limiter has already counted this question

    // $0 declines first (injection, birth date / SSN / card asks ...)
    const hit = await classify(question);
    if (hit) {
      const text = TEXT.declined[hit.kind] ?? TEXT.declined.other;
      logEvent('ask', true, { declined: hit.kind });
      return out(res, req, 200, { ok: true, answer: text, found: false, sources: [], questionsLeft: left });
    }
    const gate = await limiter.reserve(worstCaseAskUsd(env));
    if (!gate.ok) { logEvent('ask', false, { why: gate.reason }); return refuse(res, req, gate.reason === 'unavailable' ? 503 : 429, limitMessage(gate.reason), { code: gate.reason, questionsLeft: left }); }

    const { ASK_SYSTEM, buildAskPrompt, verifyEvidence } = await import('./model.js');
    const startedAt = now();
    const deadlineAt = startedAt + budgetMs;
    let spentMicro = 0;
    const model = await makeModel({ model: cfg.model, onUsage: async (u) => { spentMicro += Math.round(usdFor(u, env) * 1e6); }, deadlineAt, now });
    let result;
    try {
      result = await model.ask({ system: ASK_SYSTEM, user: buildAskPrompt(c.docs, question) });
      await limiter.settle(gate, spentMicro / 1e6);
    } catch (err) {
      await limiter.settle(gate, null); // a failed call may still have been billed: keep the whole reservation
      logEvent('ask', false, { why: String(err?.code ?? err?.name ?? 'error').slice(0, 30), status: Number(err?.status) || 0 });
      return refuse(res, req, err?.code === 'timeout' ? 504 : 502, err?.code === 'timeout' ? TEXT.busy : TEXT.generic, { code: 'model', questionsLeft: left });
    }
    const evidence = result?.found ? verifyEvidence(result.evidence, c.docs) : [];
    const answered = !!(result?.found && evidence.length && String(result.answer ?? '').trim());
    logEvent('ask', true, { found: answered, usdMicro: spentMicro, ms: now() - startedAt });
    return out(res, req, 200, {
      ok: true, found: answered,
      answer: answered ? maskText(String(result.answer).trim().slice(0, 700)) : TEXT.notFound,
      sources: evidence.map((e) => ({ doc: c.docs[e.doc].i, quote: maskText(e.quote) })),
      questionsLeft: left,
    });
  }

  /* ---------------------------------------------------------------- sweep (cron) */
  async function sweep(req, res) {
    const { isValidCronAuth } = await import('../../routes/cron-sweep.js');
    if (!isValidCronAuth(req.headers?.authorization, env.CRON_SECRET)) return res.status(401).json({ error: 'Unauthorized' });
    const removed = await sweepTemp(store, { now: now(), maxAgeMs: DEFAULTS.tempMaxAgeMs });
    logEvent('sweep', true, { removed });
    return res.status(200).json({ ok: true, removed });
  }

  return async function handler(req, res) {
    if (req.method === 'OPTIONS') return handleCors(res, req).status(204).end();
    const op = String(req.body?.op ?? req.query?.op ?? '');
    try {
      if (op === 'sweep') return await sweep(req, res);
      if (op === 'status' || (req.method === 'GET' && !op)) return await status(req, res);
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      if (op === 'presign') return await presign(req, res, body);
      if (op === 'read') return await read(req, res, body);
      if (op === 'ask') return await ask(req, res, body);
      return res.status(400).json({ error: 'Unknown op', ops: ['status', 'presign', 'read', 'ask'] });
    } catch (err) {
      // Never echo the error: it can carry a value from the document. Name + status only.
      logEvent(op || 'unknown', false, { why: 'exception', errName: String(err?.name ?? 'Error').slice(0, 40), errStatus: Number(err?.status) || 0 });
      return refuse(res, req, 500, TEXT.generic, { code: 'error' });
    }
  };
}

const handler = createRoute();
export default handler;
export { clientIp };
