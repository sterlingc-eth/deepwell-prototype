/**
 * dql/nounVeto.js - R25: release when a noun in the question is a VISIT / EVENT word and a kind-of-paper word at once for THIS company (see card.js nounVocab).
 * The company's vocabulary card says which of its own words are ambiguous; the engine does not guess between "the papers of that kind" and "every visit".
 * Pure. Returns a reason string, or null when every event word in the question is safe.
 */
import { nounKey, PAPER_FORM } from './card.js';
import { docTypePhraseMap } from './lex.js';

const words = (q) => String(q ?? '').toLowerCase().replace(/[’']s\b/g, '').split(/[^a-z]+/).filter(Boolean);

const fold = (w) => String(w).replace(/ies$/, 'y').replace(/ys$/, 'y').replace(/(ch|sh|x|ss)es$/, '$1').replace(/([^s])s$/, '$1');

let SHARED = null;
/** the words of the shared paper tables (the older lanes were tuned on an HVAC shop and read these words their own way) */
const sharedWords = () => (SHARED ??= new Set([...docTypePhraseMap().keys()].flatMap((p) => p.split(' ')).map(nounKey).filter(Boolean)));

const HEAD_WORDS = new Set(['visit', 'call', 'date', 'day', 'appointment', 'stop', 'history', 'job', 'run', 'trip']);

export function nounVeto(question, card, plan, { nameWords = null, cityWords = null, industryKind = null } = {}) {
  if (!card?.nouns || process.env.R25_NOUNS === '0' || !plan || plan.visit || (plan.parts ?? []).some((x) => x?.visit)) return null;
  const ws = words(question);
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i]; const key = nounKey(w); const n = key && card.nouns[key]; if (!n || !n.ambiguous) continue;
    if (!industryKind && sharedWords().has(nounKey(w))) continue; // an HVAC shop (no other industry chosen) keeps the shared words it always had
    if (/(?:ed|ing)$/.test(w) && !/(?:ings)$/.test(w)) continue; // a verb (serviced, registered, installed), not the name of an event
    if (nameWords?.has(w) || cityWords?.has(w)) continue; // a word inside a customer's name or a city
    const next = ws[i + 1]; if (next && (PAPER_FORM.has(next) || PAPER_FORM.has(next.replace(/s$/, '')))) continue; // "inspection reports": the head of the phrase is a paper word
    // a neighbouring word that is another word of the same kind's name ("compounded rx fills", "health inspections"): the phrase names the kind itself
    // R25 narrowing: the word is a modifier of another event / field word ("service visits", "service calls", "service date", "last service visit"): the head noun names the thing
    if (next && HEAD_WORDS.has(fold(next))) continue;
    // "certificate of insurance", "report on inspection": the paper word leads, the kind word follows
    if (/^(?:of|for|on)$/.test(ws[i - 1] ?? '') && ws[i - 2] && (PAPER_FORM.has(ws[i - 2]) || PAPER_FORM.has(ws[i - 2].replace(/s$/, '')) || /^cert/.test(ws[i - 2]))) continue;
    // the question names the paper itself elsewhere ("service types for service tickets"): the word is the kind's name here
    if (ws.some((x, j) => j !== i && x === w && ws[j + 1] && (PAPER_FORM.has(ws[j + 1]) || PAPER_FORM.has(ws[j + 1].replace(/s$/, ''))))) continue;
    // one kind carries the word and it has no visit date: there is no second thing "the visits" could mean
    if (n.kinds.length === 1 && !(n.visitKinds ?? []).length) continue;
    const nb = [ws[i - 1], next].filter(Boolean).map(fold);
    if (n.kinds.some((id) => String(id).split('-').some((t) => nb.includes(fold(t))))) continue;
    if (process.env.R25_LOG) { try { (globalThis.process.getBuiltinModule('fs')).appendFileSync(process.env.R25_LOG, JSON.stringify({ q: question, w, kinds: n.kinds, conf: n.conf, vk: n.visitKinds }) + '\n'); } catch { /* ignore */ } }
    return `"${w}" is both a visit word and a kind of paper here: ${n.why}`;
  }
  return null;
}
