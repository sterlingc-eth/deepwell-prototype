/**
 * dql/multi.js - one question that asks for two measures of the SAME set of papers ("how many invoices in 2022 and what was the total",
 * "total and average of POs", "how many receipts in 2025 and when was the first one").
 *
 * The parser has already read the whole sentence into slots (company, period, place, kind of paper ...). Here the two measure words are split:
 * the slots are copied twice, each copy keeping only ONE of the measure triggers, and each copy goes through the same family detectors a
 * single-measure question goes through. Both copies share every slot by construction, so both parts answer for exactly the same papers.
 *
 * Release rule: when the sentence shows two measures and either part is not claimed by exactly one family with the op that measure should
 * have, or the two parts do not describe the same set of papers, the WHOLE question is released (never one half of it).
 * Pure: no database, no model.
 */
import { detectPlan } from './registry.js';
import { CUSTOMER_NOUNS } from './industryLex.js';

const JOINER = /(?:\b(?:and|plus|also|then|along\s+with|as\s+well\s+as|with)\b|&|[,;:])/i;
const MONEY_WORD = /\b(?:total|totals|tot|sum|dollars?|amount|amt|how\s+much|add(?:s|ed)?\s+up|come\s+to|came\s+to|worth|altogether|combined)\b/i;
const deep = (o, seen = new Map()) => {
  if (!o || typeof o !== 'object') return o; // numbers, strings, functions: shared
  if (seen.has(o)) return seen.get(o);
  if (Array.isArray(o)) { const r = []; seen.set(o, r); for (const x of o) r.push(deep(x, seen)); return r; }
  if (o instanceof Set || o instanceof Map) return o; // lookup tables are only read
  if (Object.getPrototypeOf(o) === Object.prototype) { const r = {}; seen.set(o, r); for (const k of Object.keys(o)) r[k] = deep(o[k], seen); return r; }
  return o;
};
const copy = (f) => { const { vocab, work, ...rest } = f; return { ...deep(rest), vocab, work }; };
const moneyOn = (t) => Boolean(t.total || t.howMuch || t.money?.length);
const moneyOff = (t) => { t.total = false; t.howMuch = false; t.money = []; };
const scopeOf = (p) => JSON.stringify({ e: p.entity, d: p.docType, v: p.visit, f: p.filters, t: p.time, w: p.docWord });

/** @returns {null | 'release' | {v:1, op:'multi', parts:object[]}}  null = this is not a two-measure sentence. */
export function multiPlan(feat, vocab) {
  const t = feat?.trig;
  if (!t || !feat.work) return null;
  const raw = String(feat.raw ?? feat.work.text ?? '');
  if (!JOINER.test(raw)) return null;
  const others = ['negation', 'missing', 'share', 'versus', 'median', 'exists', 'distinct', 'topN', 'argmax', 'max', 'min'].some((k) => t[k]);
  const money = moneyOn(t) && MONEY_WORD.test(raw);
  const ext = Boolean(t.latest) !== Boolean(t.earliest);
  let kind = null;
  const rankW = Boolean(t.argmax && !t.topN);
  const namesW = /\b(?:names?\s+of|who\s+(?:are|were)|which\s+\w+)\b/i.test(raw);
  if (t.versus && t.howMany && money && !t.avg && !t.latest && !t.earliest && !['negation', 'missing', 'share', 'median', 'exists', 'distinct', 'topN', 'argmax', 'max', 'min'].some((k) => t[k])) kind = 'versus+count+sum';
  else if (t.howMany && rankW && !money && !t.avg && !t.latest && !t.earliest && !['negation', 'missing', 'share', 'versus', 'median', 'exists', 'distinct', 'topN', 'max', 'min'].some((k) => t[k]) && feat.nouns.customer && feat.docTypes.length === 1) kind = 'count+rank';
  else if (t.howMany && !others && !money && !t.avg && !t.latest && !t.earliest && namesW && feat.nouns.customer && feat.docTypes.length === 1 && !feat.docGroup) kind = 'count+names';
  else if (t.howMany && !others && !money && !t.avg && !t.latest && !t.earliest && feat.docTypes.length === 2 && !feat.docGroup && !feat.nouns.customer && (raw.match(/\b(?:how\s+many|number\s+of|count)\b/gi) ?? []).length >= 2) kind = 'count+count'; // one count word for each kind of paper (a shared "how many invoices and permits" may mean the two together)
  else if (!others && t.howMany && money && !t.avg && !t.latest && !t.earliest) kind = 'count+sum';
  else if (!others && t.avg && money && !t.howMany && !t.latest && !t.earliest) kind = 'sum+avg';
  else if (!others && t.howMany && ext && !money && !t.avg) kind = 'count+ext';
  if (!kind) return twoMeasureSignal(raw) ? 'release' : null; // two measures asked, but not a pair this engine answers together: never answer one of them alone
  if (process.env.MULTI_DEBUG) process.stderr.write('MULTI-kind ' + kind + ' ' + JSON.stringify({ sets: !!feat.sets, timeq: !!feat.timeq, links: !!feat.links, dims: feat.dims, dd: feat.distinctDim, rn: feat.recentN, each: feat.flags?.each }) + '\n');
  if (feat.sets || feat.timeq || feat.links || (feat.dims?.length ?? 0) || feat.distinctDim || (feat.recentN && !(kind === 'count+ext' && feat.recentN === 1)) || feat.flags?.each) return 'release';
  const a = copy(feat); const b = copy(feat);
  if (!a || !b) return 'release';
  let want;
  a.recentN = null; b.recentN = null; // "the first one": one paper, not a list of one
  if (kind === 'count+sum' || kind === 'versus+count+sum') { moneyOff(a.trig); b.trig.howMany = false; want = kind === 'count+sum' ? [['count'], ['sum']] : [['compare_two_values'], ['compare_two_values']]; }
  else if (kind === 'sum+avg') { a.trig.avg = false; b.trig.total = false; b.trig.howMuch = false; want = [['sum'], ['avg']]; }
  else if (kind === 'count+ext') { a.trig.latest = false; a.trig.earliest = false; b.trig.howMany = false; want = [['count'], ['latest', 'first_ever']]; }
  else if (kind === 'count+rank') { a.trig.argmax = null; a.nouns.customer = false; b.trig.howMany = false; want = [['count'], ['top_n']]; }
  else if (kind === 'count+names') { a.nouns.customer = false; b.nouns.customer = false; b.trig.howMany = false; b.distinctDim = 'customer'; want = [['count'], ['list']]; }
  else { a.docTypes = [feat.docTypes[0]]; b.docTypes = [feat.docTypes[1]]; a.docWord = null; b.docWord = null; want = [['count'], ['count']]; }
  let pa = null; let pb = null;
  try { pa = detectPlan(a, { vocab }); pb = detectPlan(b, { vocab }); } catch (e) { if (process.env.MULTI_DEBUG) process.stderr.write('MULTI-throw ' + e.message + '\n'); return 'release'; }
  if (process.env.MULTI_DEBUG) process.stderr.write(['MULTI', kind, JSON.stringify(pa)?.slice(0, 200), JSON.stringify(pb)?.slice(0, 200), a.unusedTriggers, b.unusedTriggers].join(' ') + '\n');
  if (!pa || !pb || !want[0].includes(pa.op) || !want[1].includes(pb.op)) return 'release';
  if (kind === 'versus+count+sum' && (pa.measure || !pb.measure || JSON.stringify(pa.compare) !== JSON.stringify(pb.compare))) return 'release';
  if (kind === 'count+names' && pb.distinct !== 'customer') return 'release';
  if (kind === 'count+count') { if (pa.docType === pb.docType || !pa.docType || !pb.docType) return 'release'; if (scopeOf({ ...pa, docType: null, docWord: null }) !== scopeOf({ ...pb, docType: null, docWord: null })) return 'release'; }
  else if (kind === 'count+names') { if (scopeOf(pa) !== scopeOf({ ...pb })) return 'release'; }
  else if (scopeOf(pa) !== scopeOf(pb)) return 'release';
  return { v: 1, op: 'multi', entity: pa.entity, docType: pa.docType, parts: [pa, pb] };
}

/** "... and the client with the most" asks for the top customer of the same papers: respelled to the form the parser reads ("and who is the top client"). */
const CW = [...new Set(['client', 'customer', 'account', ...CUSTOMER_NOUNS.map((x) => String(x).toLowerCase().replace(/s$/, ''))])].filter((x) => /^[a-z]{3,}$/.test(x));
const TOP_RE = new RegExp(`\\b(?:and|plus|&|,)\\s+(?:also\\s+)?(?:the\\s+)?(${CW.join('|')})s?\\s+with\\s+the\\s+(?:most|highest|largest|biggest)\\b`, 'gi');
export function multiRespell(q) { return String(q).replace(TOP_RE, 'and who is the top $1'); }

/**
 * Pure wording test on the typed question: does it ask for TWO measures at once ("how many ... and what was the total", "total plus the average",
 * "how many ... and when was the first one", "how many ... and who is the top client")? Used by the router to keep an older lane from answering
 * one half of such a question as if it were the whole answer when DQL cannot read both halves.
 */
export function twoMeasureSignal(question) {
  const q = ` ${String(question ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')} `.replace(/\s+/g, ' ')
    .replace(/\btotal(?:s|ing)?\s+(?:is\s+|are\s+)?(?:over|above|under|below|more|less|greater|exceed\w*|at\s+least|at\s+most|of\s+\$?\d|\$?\d)|\b(?:in|a)\s+total\b|\btotal\s+(?:number|count)\b|\bnumber\s+in\s+total\b|,\s*(?:in\s+)?total\s*[?.!]*\s*$/g, ' '); // \"how many calls has X been out on, total\": a trailing \", total\" is emphasis on the count, not a second measure
  if (!/(?:\b(?:and|plus|also|then)\b|&|[,;])/.test(q)) return false;
  const count = /\b(?:how\s+many|number\s+of|count\s+of|the\s+count|cuantos|cuantas|tally)\b/.test(q) || /\bcount\b/.test(q);
  const total = /\b(?:total|totals|tot|sum|how\s+much|dollar\s+(?:total|amount)|dollars|add(?:s)?\s+up|altogether|grand\s+total)\b/.test(q);
  const avg = /\b(?:average|avg|mean)\b/.test(q);
  const ext = /\bwhen\s+(?:was|is|did)\b[^?]*\b(?:first|earliest|last|latest|oldest|newest|most\s+recent)\b|\bthe\s+(?:first|earliest|last|latest)\s+one\b/.test(q);
  const who = /\b(?:client|customer|patient|tenant|resident|owner|member|donor|account)s?\s+with\s+the\s+most\b|\bwho\s+(?:is|has|was)\s+the\s+(?:top|biggest|largest)\b|\bnames?\s+of\s+the\b/.test(q);
  if (/\bhow\s+many\b[^?]*(?:\band\b|[,;&])[^?]*\bhow\s+many\b/.test(q) && !/\bof\s+(?:those|them|these|that)\b/.test(q)) return true; // "how many customers in Pinal County -- and of those, how many are out of warranty" narrows the first set: not two measures
  if (count && total && !avg) return true;
  if (total && avg && !count) return true;
  if (count && ext && !total) return true;
  if (count && who) return true;
  return false;
}

/** "this year versus last" -> "this year versus last year" (the bare "last" would be read as the latest paper). */
export function respellVersusLast(q) {
  return String(q).replace(/\b(this\s+year)(\b[^?]*?\b(?:versus|vs\.?|against|compared\s+(?:to|with))\s+(?:the\s+)?(?:whole\s+of\s+)?last)(?=\s*[?.!]*\s*$|\s*,)/i, '$1$2 year');
}
