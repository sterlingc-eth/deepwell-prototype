/**
 * handoffLearning/mine.js - turns ONE handed-off question into candidate learnings, by asking Donovan's own engine.
 *
 * The question was released (the parser had words it could not explain). Claude answered it from the records. For each way of explaining the unexplained words
 * (they carry no condition: filler; or they are another wording of something the engine already understands: an entity, a kind of paper, a dimension, an operator)
 * the engine reads the question again with that one learning and the answer is compared with Claude's. Only readings that give the SAME answer become candidates.
 * The reading Claude's answer was based on (op, entity, kind of paper, grouping) only narrows which explanations are tried; it is never trusted on its own.
 */
import { buildOverlay } from './overlay.js';
import { wordBlocked } from '../dql/learned/index.js';
import { FILLER, LOADED } from '../dql/lex.js';
import { LIMITS } from './flag.js';
import { nameWordSet } from './overlay.js';

const plural = (w) => (/(?:s|x|ch|sh)$/.test(w) ? `${w}es` : /[^aeiou]y$/.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`);
const ENTITY_CANON = { customer: 'customers', visit: 'visits', doc: 'documents', document: 'documents', unit: 'units', tech: 'technicians', technician: 'technicians' };
const OP_CANON = { count: ['how many'], sum: ['total'], avg: ['average'], median: ['median'], max: ['highest'], min: ['lowest'], latest: ['latest'], first: ['earliest'], list: ['list'], count_distinct: ['how many different'] };
const DIM_CANON = { year: 'year', month: 'month', quarter: 'quarter', city: 'city', customer: 'customer', tech: 'technician', vendor: 'vendor', status: 'status', brand: 'brand', weekday: 'weekday' };

export function tokensOf(question) {
  return (String(question).toLowerCase().replace(/[’‘`]/g, "'").match(/[a-z][a-z'-]*/g) ?? []).map((w) => w.replace(/'s$/, ''));
}

/** The explanations worth trying, narrowed by the reading when there is one. [{targetKind, targetValue, canonical}] */
export function targetsFor(reading, tv) {
  const out = [];
  const r = reading ?? {};
  const ents = r.entity ? [ENTITY_CANON[r.entity]].filter(Boolean) : Object.values(ENTITY_CANON).filter((v, i, a) => a.indexOf(v) === i);
  for (const e of ents) out.push({ targetKind: 'entity', targetValue: e, canonical: e });
  const types = (tv?.dql?.docTypes ?? []).filter((t) => t.n > 0).map((t) => t.id);
  const useTypes = r.docType ? types.filter((t) => t === String(r.docType).replace(/_/g, '-')) : types.slice(0, 14);
  for (const id of useTypes) { const parts = id.split('-'); parts[parts.length - 1] = plural(parts[parts.length - 1]); out.push({ targetKind: 'doc_type', targetValue: id, canonical: parts.join(' ') }); }
  const ops = r.op ? (OP_CANON[r.op] ?? []) : Object.values(OP_CANON).flat();
  for (const o of ops) out.push({ targetKind: 'operator', targetValue: o, canonical: o });
  for (const g of r.groupBy ?? []) if (DIM_CANON[g]) out.push({ targetKind: 'dimension', targetValue: g, canonical: DIM_CANON[g] });
  return out;
}

/** contiguous runs (<= maxWords) of the question's own words whose first and last words are unexplained. */
export function spansOf(question, left, maxWords = LIMITS.maxPhraseWords) {
  const L = new Set((left ?? []).map((x) => String(x?.w ?? x).toLowerCase().replace(/'s$/, '')));
  const qt = tokensOf(question);
  const out = [];
  for (let i = 0; i < qt.length; i++) {
    if (!L.has(qt[i])) continue;
    for (let j = i; j < Math.min(qt.length, i + maxWords); j++) {
      if (!L.has(qt[j])) continue;
      const mid = qt.slice(i, j + 1);
      if (mid.every((w) => L.has(w) || FILLER.has(w))) out.push(mid.join(' '));
    }
  }
  return [...new Set(out)];
}

const ok = (words, names) => words.every((w) => !wordBlocked(w) && !LOADED.has(w) && !names.has(w) && w.length >= 2);

/**
 * @param engine  makeEngine(...) result
 * @param h       {id, question, reading, sig?}
 * @param agree   (engineAns, h) => boolean   Claude's answer vs the engine's
 * @returns {{status:'already'|'mismatch'|'no-lead'|'none'|'found', cands:[], runs:number}}
 */
export function mineHandoff(engine, h, agree, { maxRuns = 140, base = [] } = {}) {
  let runs = 0;
  const baseRows = base.map((c) => ({ kind: c.kind === 'filler' ? 'filler' : 'word', phrase: c.phrase, canonical: c.canonical }));
  const withBase = (rows) => buildOverlay([...baseRows, ...rows]);
  const run = (rows) => { runs++; return engine.run(h.question, withBase(rows), { debug: false }); };
  const r0 = engine.run(h.question, baseRows.length ? withBase([]) : null, { debug: true }); runs++;
  if (r0.ans) return { status: agree(r0.ans, h) ? 'already' : 'mismatch', cands: [], runs };
  const left = r0.left ?? [];
  if (!left.length) return { status: 'no-lead', cands: [], runs, why: r0.why };
  const names = nameWordSet(engine.tv);
  const lw = [...new Set(left.map((x) => String(x?.w ?? x).toLowerCase().replace(/'s$/, '')))];
  const sig = JSON.stringify([h.reading?.op ?? '', h.reading?.entity ?? '', h.reading?.docType ?? '']);
  const cands = [];
  // 1. every unexplained word is chatter
  if (ok(lw, names)) {
    const a = run(lw.map((w) => ({ kind: 'filler', phrase: w })));
    if (a.ans && agree(a.ans, h)) for (const w of lw) cands.push({ kind: 'filler', phrase: w, canonical: '', targetKind: 'filler', targetValue: '', sig, hid: h.id });
  }
  if (cands.length) return { status: 'found', cands, runs };
  // 2. a run of unexplained words is another wording of something the engine knows
  const tg = targetsFor(h.reading, engine.tv);
  for (const span of spansOf(h.question, left)) {
    const sw = span.split(' ');
    if (!ok(sw, names)) continue;
    const hits = [];
    for (const t of tg) {
      if (runs >= maxRuns) break;
      if (t.canonical === span) continue;
      const rest = lw.filter((w) => !sw.includes(w));
      for (const withFiller of rest.length && ok(rest, names) ? [false, true] : [false]) {
        const rows = [{ kind: 'word', phrase: span, canonical: t.canonical }, ...(withFiller ? rest.map((w) => ({ kind: 'filler', phrase: w })) : [])];
        const a = run(rows);
        if (a.ans && agree(a.ans, h)) { hits.push({ t, withFiller, rest }); break; }
      }
    }
    // two different explanations of the same words that both reproduce Claude's answer: not told apart, nothing learned from this question
    const distinct = new Map(hits.map((x) => [x.t.canonical, x]));
    if (distinct.size === 1) {
      const { t, withFiller, rest } = [...distinct.values()][0];
      cands.push({ kind: sw.length > 1 || t.targetKind === 'operator' ? 'wording' : 'word', phrase: span, canonical: t.canonical, targetKind: t.targetKind, targetValue: t.targetValue, sig, hid: h.id });
      if (withFiller) for (const w of rest) cands.push({ kind: 'filler', phrase: w, canonical: '', targetKind: 'filler', targetValue: '', sig, hid: h.id, joint: true });
    }
  }
  return { status: cands.length ? 'found' : 'none', cands, runs };
}
