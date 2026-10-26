// npm run verify:people-variants - runs the seeded dev / holdout variant sets (scripts/people-lane/variants.mjs) through the real reading pipeline and the people lane.
// Usage: node scripts/verify-people-variants.mjs [--tree <repo>] [--seed N] [--per-class N] [--verbose] [--json out.json]
// The HOLDOUT split uses vocabulary the code was never tuned on; its table is reported apart. Exit 1 on any dev miss, any holdout wrong ANSWER, or any leak;
// holdout reading misses are printed (they are the measure of generalisation) and fail the run only below 100% in classes C1/C2/C3/C4/C6 so a regression shows.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadPipeline, runDoc } from './real-docs/pipeline.mjs';
import { generate } from './people-lane/variants.mjs';
import { generateR4 } from './people-lane/variants_r4.mjs';
import { generateR5 } from './people-lane/variants_r5.mjs';
import { generateR6 } from './people-lane/variants_r6.mjs';
import { generateR7 } from './people-lane/variants_r7.mjs';
import { generateR8 } from './people-lane/variants_r8.mjs';

const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TREE = path.resolve(arg('--tree') ?? ROOT);
const VERBOSE = argv.includes('--verbose');
const SEED = Number(arg('--seed') ?? 20261025);
const SEED4 = Number(arg('--seed4') ?? 20261031); // round-4 classes: a fresh seed
const PER = Number(arg('--per-class') ?? 60);
console.warn = () => {}; console.error = () => {};
const P = await loadPipeline(TREE);
const { answerPeople } = await import(pathToFileURL(path.join(TREE, 'api/_lib/people/peopleLane.js')).href);
const TODAY = '2026-10-25';

const nameKey = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !['dr', 'mr', 'mrs', 'ms'].includes(w)).sort().join(' ');
const asDoc = (text, filename = 'scan.pdf') => ({ filename, pages: [{ page_no: 1, text }] });
const fieldsOf = (r) => r.fields.map((f) => ({ k: f.field_key, v: String(f.value) }));

function judgeDoc(c) {
  const r = runDoc(P, asDoc(c.text, c.filename));
  const F = fieldsOf(r); const e = c.expect; const why = [];
  const get = (k) => F.filter((f) => f.k === k).map((f) => f.v);
  for (const k of e.absent ?? []) if (get(k).length) why.push(`${k} read as "${get(k)[0]}"`);
  if (e.noValue) for (const f of F) if (['holder_name', 'employee_name', 'manager', 'issued_by', 'customer_name', 'customer_phone'].includes(f.k) && f.v.toLowerCase().includes(String(e.noValue).toLowerCase())) why.push(`${f.k} = "${f.v}" holds the bad value`);
  if (e.name) { const got = (e.name.keys ?? [e.name.key]).flatMap(get); const want = nameKey(`${e.name.person.first} ${e.name.person.last}`); if (!got.some((g) => nameKey(g).split(' ').filter((w) => w.length > 1).join(' ') === want || nameKey(g) === want)) why.push(`${e.name.key} not read (got ${JSON.stringify(got)})`); }
  if (e.endDateIn) { const got = get('end_date'); const bad = got.filter((g) => !e.endDateIn.includes(g)); if (bad.length) why.push(`end_date ${bad[0]}`); if (!e.endDateIn.includes(null) && !got.length) why.push('real end_date not read'); }
  for (const [k, v] of Object.entries(e.fieldEq ?? {})) if (!get(k).includes(v)) why.push(`${k} is ${JSON.stringify(get(k))}, want ${v}`);
  if (e.noDate) for (const f of F) if (f.v.slice(0, 10) === e.noDate) why.push(`${f.k} = the form's control date`);
  for (const pre of e.noKeyPrefix ?? []) for (const f of F) if (f.k.startsWith(pre)) why.push(`${f.k} written`);
  if (e.startDateOptional) { const got = get('start_date'); if (got.some((g) => g !== e.startDateOptional)) why.push(`start_date ${got[0]}`); }
  if (e.typeIs && r.type !== e.typeIs) why.push(`type ${r.type}, want ${e.typeIs}`);
  if (e.typeNot && e.typeNot.includes(r.type)) why.push(`typed ${r.type}`);
  if (e.retypeNot && P.rs?.retypeDecision) for (const cur of ['permit', 'other', 'inspection-report', 'invoice', 'correspondence']) { const d = P.rs.retypeDecision({ currentType: cur, filename: 'doc.pdf', pages: [{ page_no: 1, text: c.text }], fields: [] }); if (d && d.to === e.retypeNot) why.push(`re-check moves ${cur} -> ${d.to}`); }
  return why;
}
function judgeLane(c) {
  const docs = c.lane.docs.map((d, i) => { const r = runDoc(P, asDoc(d.text, `${d.id}.pdf`)); const f = {}; for (const x of r.fields) f[x.field_key] = x.value; return { id: d.id, type: d.type ?? r.type, fields: f, pages: [{ page_no: 1, text: d.text }] }; });
  const res = answerPeople(docs, c.lane.q, { today: TODAY, canHr: true });
  const e = c.expect; const why = [];
  if (e.abstain && res) why.push(`WRONG ANSWER: "${res.text}"`);
  if (e.answer && !(res && e.answer.test(res.text))) why.push(`expected ${e.answer}, got ${res ? `"${res.text}"` : 'abstain'}`);
  if (res && /D\d{7,8}|X\d{7,8}|T\d{7,8}|B\d{7,8}/.test(res.text) && !/ending in/.test(res.text)) why.push(`LEAK: "${res.text}"`);
  return why;
}

const sets = generate({ seed: SEED, perClass: PER }); const sets4 = generateR4({ seed: SEED4, perClass: Math.ceil(PER * 2 / 3) });
for (const k of ['dev', 'holdout']) sets[k].push(...sets4[k]);
sets.blind = sets4.blind;
const SEED5 = Number(arg('--seed5') ?? 20261201); const sets5 = generateR5({ seed: SEED5, perClass: PER });
for (const k of ['dev', 'holdout', 'blind']) sets[k].push(...sets5[k]);
const SEED6 = Number(arg('--seed6') ?? 20261301); const sets6 = generateR6({ seed: SEED6, perClass: PER });
for (const k of ['dev', 'holdout', 'blind']) sets[k].push(...sets6[k]); // the BLIND set (new vocabulary, round-4 classes only) is run only with --blind
const SEED7 = Number(arg('--seed7') ?? 20261401); const sets7 = generateR7({ seed: SEED7, perClass: PER });
for (const k of ['dev', 'holdout', 'blind']) sets[k].push(...sets7[k]);
const SEED8 = Number(arg('--seed8') ?? 20261501); const sets8 = generateR8({ seed: SEED8, perClass: PER });
for (const k of ['dev', 'holdout', 'blind']) sets[k].push(...sets8[k]);
const table = {}; const fails = { dev: [], holdout: [], blind: [] }; let wrongAnswers = 0; let leaks = 0;
const SPLITS = argv.includes('--blind') ? ['blind'] : argv.includes('--dev-only') ? ['dev'] : ['dev', 'holdout']; // --dev-only: tuning runs never look at the holdout
for (const split of SPLITS) {
  for (const c of sets[split]) {
    let why;
    try { why = c.lane ? judgeLane(c) : judgeDoc(c); } catch (err) { why = [`ERROR ${String(err?.message ?? err).slice(0, 80)}`]; }
    const row = (table[c.cls] ??= { dev: { n: 0, ok: 0 }, holdout: { n: 0, ok: 0 }, blind: { n: 0, ok: 0 } })[split];
    row.n++; if (!why.length) row.ok++;
    else { fails[split].push({ cls: c.cls, id: c.id, note: c.note, why, text: c.text ?? JSON.stringify(c.lane) }); if (c.lane) { wrongAnswers += why.filter((w) => w.startsWith('WRONG')).length; leaks += why.filter((w) => w.startsWith('LEAK')).length; } }
  }
}
const pct = (a, b) => (b ? `${(100 * a / b).toFixed(1)}%` : 'n/a');
console.log(`verify:people-variants  seed ${SEED}  per-class ${PER}  (dev = vocabulary tuned on, holdout = vocabulary never tuned on)`);
console.log(`${'class'.padEnd(6)}${'dev'.padStart(16)}${'holdout'.padStart(16)}${'blind'.padStart(16)}`);
const NAMES = { Jw: 'R8 given name + everyday noun, weak label', Js: 'R8 same, strong label', Jx: 'R8 same, line after a lone label', Jt: 'R8 same, printed twice', Jc: 'R8 non-dictionary compounds, plural and -ing nouns', Rn: 'R8 real surnames that are also nouns (recall)', Rr: 'R8 uncommon real names, no English word (recall)', Rx: 'R8 rare surnames that ARE a noun or a compound, printed once (cost)', Rg: 'R8 the same with a signature line (recall)', C1: 'non-name value', C1p: 'real name read', C2: 'form-control date', C3: 'HR / ID guard', C4: 'false type', C4p: 'real paper typed', C5: 'lane answers', C6: 'permit as licence', N1: 'real name read (-ed/-ing, accents, Dr.)', N2: 'name-shaped junk (residual)', N3: 'City, State as a person', N4: 'registration issue date', N5: 'HR phone / email / signed', N6: 'noisy real papers typed', J: 'fresh junk as a name', Jmgr: 'fresh junk as a manager', Jtwo: 'junk printed twice (cost shown, not a gate)', Rc: 'common real names read', Ru: 'uncommon real names (miss allowed)', Nx: 'R7 uncommon real name on the line after a lone label (recall)', Nj: 'R7 junk on the line after a lone label (long equipment nouns are the known residual)', Vf: 'R7 Vietnamese family-name-first, printed once (recall)', Vj: 'R7 junk starting with a Vietnamese family name', Kf: 'R7 Korean family-name-first (recall)', Kj: 'R7 junk starting with a Korean family name', Cf: 'R7 Chinese family-name-first (recall)', Cj: 'R7 junk starting with a Chinese family name', Pw: 'R7 given name + short unseen noun, weak label (Manager / bare Name)', Ps: 'R7 given name + short unseen noun, strong label (Park is the known residual)', Pq: 'R7 the same printed twice, no signature', Pl: 'R7 given name + LONG unseen noun (known residual)', Pk: 'R7 Korean given name + Park (recall)', Pe: 'R7 English-word surname, strong label (recall)', Pm: 'R7 English-word surname, weak label (recall cost)', Pg: 'R7 English-word surname, weak label + signature (recall)', };
for (const k of Object.keys(table).sort()) { const t = table[k]; console.log(`${k.padEnd(6)}${`${t.dev.ok}/${t.dev.n} ${pct(t.dev.ok, t.dev.n)}`.padStart(16)}${`${t.holdout.ok}/${t.holdout.n} ${pct(t.holdout.ok, t.holdout.n)}`.padStart(16)}${`${t.blind.ok}/${t.blind.n} ${pct(t.blind.ok, t.blind.n)}`.padStart(16)}   ${NAMES[k] ?? ''}`);}
const tot = (s) => Object.values(table).reduce((a, t) => [a[0] + t[s].ok, a[1] + t[s].n], [0, 0]);
console.log(`${'all'.padEnd(6)}${`${tot('dev')[0]}/${tot('dev')[1]}`.padStart(16)}${`${tot('holdout')[0]}/${tot('holdout')[1]}`.padStart(16)}${`${tot('blind')[0]}/${tot('blind')[1]}`.padStart(16)}   wrong answers ${wrongAnswers}, leaks ${leaks}`);
for (const split of SPLITS) {
  if (!fails[split].length) continue;
  console.log(`\n${split} misses (${fails[split].length}):`);
  for (const f of fails[split].slice(0, VERBOSE ? 400 : 14)) console.log(`  [${f.cls}] ${f.id} ${f.note}: ${f.why.join('; ')}${VERBOSE ? '\n      ' + String(f.text).split('\n').join(' / ').slice(0, 300) : ''}`);
}
const jp = arg('--json'); if (jp) fs.writeFileSync(jp, JSON.stringify({ table, fails, wrongAnswers, leaks }, null, 1));
const hardHoldout = ['C1', 'C2', 'C3', 'C4', 'C6', 'N3', 'N4', 'N5', 'N6', 'J', 'Jmgr', 'O', 'T', 'Jtwo', 'Vj', 'Kj', 'Cj', 'Pw', 'Jw', 'Js', 'Jx', 'Jt'].some((k) => table[k] && (table[k].holdout.ok < table[k].holdout.n || table[k].blind.ok < table[k].blind.n));
process.exit(fails.dev.length || wrongAnswers || leaks || hardHoldout ? 1 : 0);
