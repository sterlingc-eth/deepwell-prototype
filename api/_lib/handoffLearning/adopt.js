/**
 * handoffLearning/adopt.js - the gate every candidate learning must pass before it is used. Pure over an engine (engine.js).
 *
 *   selectCandidates(cands, {existing})   support, variety and conflicts (the same words explained two ways are dropped)
 *   verifyCandidates(engine, sel, ...)    the engine, using the learnings, must (1) re-derive Claude's answer for each question they came from, (2) give the SAME answer as the
 *                                         known wording on automatic paraphrases of those questions (wrappers, another customer, another year) and never a different one,
 *                                         (3) leave every other known question that holds those words with exactly the answer it had before.
 *                                         A learning that fails any of these is discarded, together with whatever else shared the failing question; the rest are checked again.
 */
import { buildOverlay } from './overlay.js';
import { paraphrases, removeWord } from './paraphrase.js';
import { answerKey } from './engine.js';
import { LIMITS } from './flag.js';

const keyOf = (c) => `${c.kind === 'filler' ? 'filler' : 'rewrite'}|${c.phrase}`;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasPhrase = (text, phrase) => new RegExp(`(?<![\\w'-])${esc(phrase).replace(/\s+/g, '\\s+')}(?![\\w-])`, 'i').test(text);

export function selectCandidates(cands, { existing = [], limits = LIMITS } = {}) {
  const by = new Map();
  for (const c of cands) {
    const k = keyOf(c);
    const e = by.get(k) ?? { phrase: c.phrase, isFiller: c.kind === 'filler', targets: new Map() };
    const t = e.targets.get(c.canonical) ?? { c, hids: new Set(), sigs: new Set() };
    t.hids.add(c.hid); t.sigs.add(c.sig); e.targets.set(c.canonical, t); by.set(k, e);
  }
  // the same words learned as a filler in one place and as a wording in another: told apart by nothing, dropped
  const phraseKinds = new Map();
  for (const [, e] of by) { const s = phraseKinds.get(e.phrase) ?? new Set(); s.add(e.isFiller ? 'f' : 'r'); phraseKinds.set(e.phrase, s); }
  const selected = []; const rejected = [];
  for (const [, e] of by) {
    if (phraseKinds.get(e.phrase).size > 1) { rejected.push({ phrase: e.phrase, reason: 'filler-and-wording' }); continue; }
    if (e.targets.size > 1) { rejected.push({ phrase: e.phrase, reason: 'conflict' }); continue; }
    const t = [...e.targets.values()][0];
    const need = e.isFiller ? limits.minSupportFiller : limits.minSupportWord;
    if (t.hids.size < need) { rejected.push({ phrase: e.phrase, reason: 'support' }); continue; }
    if (e.isFiller && t.sigs.size < 2) { rejected.push({ phrase: e.phrase, reason: 'variety' }); continue; }
    const old = existing.find((x) => x.phrase === e.phrase);
    if (old && ((old.kind === 'filler') !== e.isFiller || (old.canonical ?? '') !== (t.c.canonical ?? ''))) { rejected.push({ phrase: e.phrase, reason: 'conflicts-with-adopted' }); continue; }
    selected.push({ ...t.c, support: t.hids.size, hids: [...t.hids] });
  }
  return { selected, rejected };
}

/** The question written in words the engine already knows: every selected wording replaced by its canonical form, every selected filler removed. */
function canonicalOf(text, sel) {
  let t = text;
  for (const c of [...sel].sort((a, b) => b.phrase.length - a.phrase.length)) {
    if (c.kind === 'filler') t = removeWord(t, c.phrase);
    else t = t.replace(new RegExp(`(?<![\\w'-])${esc(c.phrase).replace(/\s+/g, '\\s+')}(?![\\w-])`, 'gi'), c.canonical);
  }
  return t;
}

export function verifyCandidates(engine, selected, { handoffs, agree, regression = [], limits = LIMITS, maxSupportQs = 4, maxRegression = 40, base = [] }) {
  let sel = selected.slice(); const rejected = []; const stats = new Map();
  const customers = engine.tv?.customers?.phrases ?? [];
  const years = [...new Set((engine.snap?.documents ?? []).map((d) => String(d.date ?? d.serviceDate ?? '').slice(0, 4)).filter((y) => /^20\d\d$/.test(y)))];
  const rowsOf = (list) => list.map((c) => ({ kind: c.kind === 'filler' ? 'filler' : 'word', phrase: c.phrase, canonical: c.canonical }));
  const drop = (list, why) => { for (const c of list) { rejected.push({ phrase: c.phrase, reason: why }); } sel = sel.filter((x) => !list.includes(x)); };
  for (let round = 0; round < 6 && sel.length; round++) {
    const ov = buildOverlay(rowsOf([...base, ...sel])); const ovBase = base.length ? buildOverlay(rowsOf(base)) : null; const bad = new Set(); const agreeN = new Map(sel.map((c) => [c, 0]));
    for (const c of sel) {
      for (const hid of c.hids.slice(0, maxSupportQs)) {
        const h = handoffs.get(hid); if (!h) continue;
        // (1) the question it came from: the engine, using the learnings, gets Claude's answer
        const a0 = engine.run(h.question, ov);
        if (!(a0.ans && agree(a0.ans, h))) { bad.add(c); continue; }
        // (2) automatic paraphrases against the same paraphrase in known words
        for (const p of paraphrases(h.question, { customers, years })) {
          if (!sel.some((x) => hasPhrase(p, x.phrase))) continue; // the learning's words were rewritten away by the wrapper: nothing to test
          const A = engine.run(p, ov); const B = engine.run(canonicalOf(p, [...base, ...sel]), null);
          if (!B.ans) continue;
          if (!A.ans) continue; // released: safe, not counted as agreement
          if (answerKey(A.ans) !== answerKey(B.ans)) { for (const x of sel) if (hasPhrase(p, x.phrase)) bad.add(x); } else agreeN.set(c, agreeN.get(c) + 1);
        }
      }
      // (3) every other known question that holds these words keeps its answer
      const rg = regression.filter((q) => hasPhrase(q, c.phrase)).slice(0, maxRegression);
      for (const q of rg) {
        const B = engine.run(q, ovBase); if (!B.ans) continue;
        const A = engine.run(q, ov);
        if (!A.ans || answerKey(A.ans) !== answerKey(B.ans)) for (const x of sel) if (hasPhrase(q, x.phrase)) bad.add(x);
      }
    }
    const weak = sel.filter((c) => !bad.has(c) && agreeN.get(c) < limits.minParaphrases);
    for (const c of sel) stats.set(c.phrase, { paraphraseAgree: agreeN.get(c), regressionChecked: Math.min(maxRegression, regression.filter((q) => hasPhrase(q, c.phrase)).length) });
    if (!bad.size && !weak.length) break;
    drop([...bad], 'engine-disagrees'); drop(weak.filter((c) => sel.includes(c)), 'too-few-paraphrases');
  }
  return { adopted: sel.map((c) => ({ ...c, evidence: stats.get(c.phrase) ?? {} })), rejected };
}
