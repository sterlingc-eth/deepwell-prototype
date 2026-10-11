/**
 * scripts/gen-dql-training.mjs - training rows for Donovan's learned planner (api/_lib/dql/learned), from the question factory's TRAIN split.
 *
 *   node scripts/gen-dql-training.mjs --split train --out /tmp/claude-0/lp/train [--tenants a,b] [--limit N] [--factory /home/claude/work/factory]
 *   (heavy: run it under `flock /tmp/claude-0/harness.lock`)
 *
 * Per tenant: loads the synthetic company, builds its tenant vocabulary and snapshot, then for every single-turn question
 *   - runs the deterministic parser (learned planner OFF) and records what happened: parsed / left (unexplained words) / nofam (no family) / other;
 *   - for released questions with unexplained words, re-runs with the gate FORCED open (DQL_LEARNED_FORCE=1), executes the plan over the snapshot,
 *     and grades the answer with the factory's own checker - this is the label "were these words ignorable?";
 *   - writes the head labels (op / measure / entity / doc / group) from the written plan table (planmap.js).
 * Only the factory's `train` split is read (override --split dev for tuning data). Never the test split, never the holdouts.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const A = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1]]] : a), []));
const FACTORY = A.factory ?? '/home/claude/work/factory';
const SPLIT = A.split ?? 'train';
if (SPLIT === 'test') throw new Error('the test split is sealed');
const OUT = A.out ?? '/tmp/claude-0/lp/train';
const LIMIT = Number(A.limit ?? 0);
const KEYS = A.tenants ? A.tenants.split(',') : ['property', 'legal', 'medical', 'construction', 'cleaning', 'landscaping', 'nonprofit', 'auto', 'plumbing', 'electrical', 'hvac'];
const HVAC_EXPORT = '/home/claude/work/qa6/export-q6.json'; const HVAC_DEV = '/home/claude/work/deep/dev'; // the HVAC dev questions (NOT the sealed sets)
const TODAY = '2026-10-07';
fs.mkdirSync(OUT, { recursive: true });

delete process.env.ANTHROPIC_API_KEY;
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && /^\{"/.test(a[0])) return; realLog(...a); };
console.warn = () => {}; console.error = () => {};

const off = await import(`${ROOT}/scripts/offline-exam.mjs`);
await off.installPgHarness(); await off.installModelBlock();
const { withTenant } = await import(`${ROOT}/api/_lib/recordsStore.js`);
const { getTenantVocab } = await import(`${ROOT}/api/_lib/vocab/tenantVocab.js`);
const { packForTenant } = await import(`${ROOT}/api/_lib/industry/index.js`);
const { parseDql } = await import(`${ROOT}/api/_lib/dql/parse.js`);
const { answerFromSnapshot } = await import(`${ROOT}/api/_lib/dql/index.js`);
const { loadSnapshot } = await import(`${ROOT}/api/_lib/dql/load.js`);
const { classifyWords } = await import(`${ROOT}/api/_lib/dql/learned/features.js`);
const { factoryHeads, dqlHeads, hvacHeads } = await import(`${ROOT}/api/_lib/dql/learned/planmap.js`);
const { checkRecord, buildLexicon } = await import(`${FACTORY}/questions/check.mjs`);

function* readTenant(k) {
  if (k === 'hvac') {
    for (const g of ['money', 'customers', 'assets', 'timeops', 'docs', 'xind']) {
      for (const l of fs.readFileSync(`${HVAC_DEV}/${g}.jsonl`, 'utf8').split('\n')) if (l) { const r = JSON.parse(l); r.grp = g; r.split = SPLIT; yield r; }
    }
    return;
  }
  const dir = `${FACTORY}/questions/out`;
  for (const f of fs.readdirSync(dir).filter((x) => x.startsWith(`${k}-`)).sort()) {
    for (const l of zlib.gunzipSync(fs.readFileSync(path.join(dir, f))).toString().split('\n')) {
      if (!l) continue;
      const r = JSON.parse(l);
      if (r.split === SPLIT) yield r;
    }
  }
}

/* grading of an HVAC dev answer: the same containment test as work/deep/score.mjs (numbers, dates, names, yes/no, lists) */
const numForms = (n) => { const x = Number(n); if (!Number.isFinite(x)) return []; const f = [String(x), x.toLocaleString('en-US'), x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })]; if (!Number.isInteger(x)) f.push(x.toFixed(1), x.toFixed(2)); return f; };
const normS = (s) => String(s).toLowerCase().replace(/[\s,]+/g, ' ').trim();
function has(text, v) {
  if (v == null) return null;
  if (typeof v === 'boolean') return has(text, v ? 'yes' : 'no');
  if (typeof v === 'number') { if (v === 0 && /\b(none|no|zero|nothing|not any)\b/i.test(text)) return true; const t = text.replace(/\$/g, ''); return numForms(v).some((f) => new RegExp(`(^|[^\\d.])${f.replace(/[.$]/g, '\\$&')}(?![\\d])`).test(t)); }
  if (Array.isArray(v)) { if (!v.length) return /\b(no|none|zero|0|nothing|isn't|aren't|not)\b/i.test(text); const hits = v.filter((e) => has(text, e) === true).length; return hits / v.length >= (v.length > 8 ? 0.8 : 1); }
  if (typeof v === 'object') { const vals = Object.values(v).filter((e) => e != null && typeof e !== 'object'); if (!vals.length) return null; return vals.every((e) => has(text, e) === true); }
  const s = String(v).trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) { const M = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][+iso[2] - 1]; const d = +iso[3]; return [s, `${M} ${d}, ${iso[1]}`, `${M.slice(0, 3)} ${d}, ${iso[1]}`, `${iso[2]}/${iso[3]}/${iso[1]}`, `${+iso[2]}/${d}/${iso[1]}`].some((f) => text.includes(f)); }
  if (/\s/.test(s) && s.split(/\s+/).every((t) => /\d/.test(t))) return s.split(/\s+/).every((t) => has(text, t) === true);
  { const m = /^(-?[\d,.]+)\s+[a-z ]+$/i.exec(s); if (m) return has(text, Number(m[1].replace(/,/g, ''))); }
  if (/^-?[\d,]+(\.\d+)?$/.test(s.replace(/^\$/, ''))) return has(text, Number(s.replace(/[$,]/g, '')));
  if (/^(yes|no)$/i.test(s)) return new RegExp(`^\\W*${s}\\b`, 'i').test(text) || (s.toLowerCase() === 'no' ? /\b(no |none|not |isn't|aren't|don't)\b/i.test(text) : /\byes\b/i.test(text));
  return normS(text).includes(normS(s));
}
const DECL = /(not (tracked|recorded|stored|on file)|isn't (tracked|recorded|stored)|don't (track|have|record|keep)|no record|can't tell|not something|doesn't (track|record)|nothing (stored|on file))/i;
function gradeHvac(rec, text) {
  const decl = DECL.test(text);
  if (rec.answerable === 'untracked') return decl ? 'right' : 'wrong';
  if (rec.answerable === 'ambiguous') return 'wrong';
  if (rec.expect == null) return 'unclear';
  const h = has(text, rec.expect);
  if (decl) return (Array.isArray(rec.expect) && !rec.expect.length) || rec.expect === 0 ? 'right' : 'wrong-decline';
  return h === true ? 'right' : h === false ? 'wrong' : 'unclear';
}

for (const k of KEYS) {
  const t0 = Date.now();
  const data = JSON.parse(fs.readFileSync(k === 'hvac' ? HVAC_EXPORT : `${FACTORY}/tenants/${k}.json`, 'utf8'));
  const lex = k === 'hvac' ? null : buildLexicon(data);
  const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
  const ctx = (await off.loadExportIntoNewTenant(lite, data, { tenantKey: `offline:${k}`, tenantName: k })).ctx;
  const ctxArg = { tenantKey: ctx.tenantKey, tenantName: k };
  const pack = await packForTenant({ withTenant, ctxArg });
  const tv = await withTenant(ctxArg, (db) => getTenantVocab(db, ctx.tenantKey, pack));
  const snap = await withTenant(ctxArg, (db) => loadSnapshot(db, { today: TODAY }));
  const ws = fs.createWriteStream(path.join(OUT, `${k}.${SPLIT}.jsonl`));
  const stats = {};
  let n = 0;
  const grade = (rec, intent) => {
    if (!intent) return { v: 'none' };
    let data_;
    try { data_ = answerFromSnapshot(snap, intent.plan, TODAY); } catch { return { v: 'exec-error' }; }
    if (!data_) return { v: 'abstain' };
    if (k === 'hvac') return { v: gradeHvac(rec, data_.text ?? '') };
    return { v: checkRecord(rec, { text: data_.text ?? '', kind: data_.kind }, lex).v };
  };
  for (const rec of readTenant(k)) {
    if (rec.prior) continue; // follow-up turns need the conversation engine, not the planner
    if (LIMIT && n >= LIMIT) break;
    n++;
    const dbg = {};
    delete process.env.DQL_LEARNED_FORCE;
    const r0 = parseDql(rec.q, { tenantVocab: tv, pack, today: TODAY, debug: dbg });
    let cat = r0 ? 'parsed' : /^unexplained/.test(dbg.why ?? '') ? 'left' : /no family/.test(dbg.why ?? '') ? 'nofam' : 'other';
    const row = { id: rec.id, tn: k, sp: rec.split, q: rec.q, cat, h: k === 'hvac' ? hvacHeads(rec) : factoryHeads(rec), ek: rec.expect?.kind, fam: rec.family, pat: rec.pattern, noise: rec.noise, grp: rec.grp };
    const wk = dbg.feat?.work;
    if (wk) { row.orig = wk.orig.trim(); row.rest = wk.s; row.left = dbg.feat.left ?? []; row.tk = classifyWords(wk.orig, wk.s, row.left); }
    if (r0) { row.base = grade(rec, r0).v; row.dh = dqlHeads(r0.plan); row.dop = r0.plan.op; }
    if (cat === 'nofam') row.ut = dbg.feat?.unusedTriggers ?? null;
    else if (cat === 'left') {
      process.env.DQL_LEARNED_FORCE = '1';
      const d2 = {};
      const r1 = parseDql(rec.q, { tenantVocab: tv, pack, today: TODAY, debug: d2 });
      delete process.env.DQL_LEARNED_FORCE;
      row.force = grade(rec, r1).v;
      if (r1) { row.dh = dqlHeads(r1.plan); row.dop = r1.plan.op; } else row.fwhy = d2.why ?? null;
    }
    const key = `${cat}${row.base ? ':' + row.base : ''}${row.force ? ':f-' + row.force : ''}`;
    stats[key] = (stats[key] ?? 0) + 1;
    ws.write(JSON.stringify(row) + '\n');
  }
  await new Promise((r) => ws.end(r));
  realLog(`${k}: ${n} questions in ${Math.round((Date.now() - t0) / 1000)}s`, JSON.stringify(stats));
  try { await lite.close?.(); } catch { /* ignore */ }
}
process.exit(0);
