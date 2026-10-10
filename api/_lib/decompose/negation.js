/**
 * decompose/negation.js — negation as polarity: "how many invoices were not over $3000", "service tickets handled by someone other than
 * Danny Ochoa", "invoices that weren't Goodman, how many".
 *
 * The planners read ONE positive condition. A negated question is answered as the complement of that positive reading:
 *     answer = (all of the thing counted) - (the ones the negated condition describes)
 * Both counts come from the lanes that already answer single questions (decompose/compound.js runLanes: no model). The complement is
 * returned only when it is safe to compute:
 *   - both sub-questions resolve to ONE plain count each,
 *   - the positive count is strictly between 0 and the total (a lane that silently dropped the condition returns the total; a lane that
 *     found nothing returns 0: neither can be told apart from a real answer, so both are released),
 * otherwise the question is released (null) to the next lane / the model. Never the positive count.
 *
 * pure: parseNegation     db: runNegation
 */
import { _runLanes } from './compound.js';

const CONTRACTION = { "didn't": 'did', "doesn't": 'does', "don't": 'do', "hasn't": 'has', "haven't": 'have', "hadn't": 'had', "wasn't": 'was', "weren't": 'were', "isn't": 'is', "aren't": 'are', "won't": 'will', "can't": 'can' };
const clean = (s) => String(s ?? '').replace(/[?!.\s]+$/g, '').replace(/\s+/g, ' ').trim();

// one negation marker bound to the slot after it. "no / without / never" are NOT here: those name an absence of a record, which other lanes own.
const NEG_RE = /\b(?:(?:some|any|every)(?:one|body)\s+(?:other\s+than|but|besides|except)|(?:anyone|anybody|everyone|everybody)\s+but|other\s+than|aside\s+from|apart\s+from|excluding|except(?:ing)?|besides|but\s+not|(?:did|does|do|has|have|had|was|were|is|are|will|can)n['’]t|(?:did|does|do|has|have|had|was|were|is|are)\s+not|not)\b/i;
const DOLLAR_RE = /\b(?:dollars?|revenue|worth|dollar\s+value|amount|how\s+much|total\s+(?:value|dollars?|amount)|in\s+total\s+dollars)\b/i;
const COUNT_LEAD_RE = /\b(?:how\s+many|number\s+of|count\s+of|the\s+count)\b/i;

/** Pure. @returns {null | {mode:'compound', negation:true, total:string, positive:string, original:string}} */
export function parseNegation(question) {
  const q = clean(question);
  if (!q || q.length > 200) return null;
  if (!COUNT_LEAD_RE.test(q)) return null; // counts only: a list or a total cannot be complemented from two numbers
  if (DOLLAR_RE.test(q)) return null; // asked in dollars: two counts cannot answer it
  const negs = [...q.matchAll(new RegExp(NEG_RE.source, 'gi'))];
  if (negs.length !== 1) return null; // two negations: ambiguous scope
  const m = negs[0];
  const word = m[0].toLowerCase().replace(/’/g, "'");
  const left = q.slice(0, m.index);
  const right = q.slice(m.index + m[0].length);
  if (!clean(right).replace(/^(?:the|a|an)\s+/i, '')) return null;
  // the positive reading: the same sentence with the negation removed (a contraction keeps its auxiliary: "didn't Ray write" -> "did Ray write")
  let keep = '';
  if (CONTRACTION[word]) keep = CONTRACTION[word];
  else if (/^(?:did|does|do|has|have|had|was|were|is|are)\s+not$/.test(word)) keep = word.split(/\s+/)[0];
  const lef = left.replace(/\b(?:some|any|every)(?:one|body)\s*$/i, '').replace(/\b(?:anyone|anybody|everyone|everybody)\s*$/i, '');
  const positive = clean(`${lef} ${keep} ${right}`);
  // the whole: everything before the negation (minus a dangling auxiliary), with a trailing "how many" moved to the front
  const tailLead = right.match(COUNT_LEAD_RE);
  const DANGLE = /\s+(?:that|which|who|whom|were|was|are|is|did|do|does|have|has|had|being|been|got|get|by|for|from|with|in|on|at|of|to|done|written|made|sent|run|ran|\w{3,}ed)\s*$/i;
  let whole = clean(left);
  for (let k = 0; k < 4 && DANGLE.test(` ${whole}`) && whole.split(/\s+/).length > 3; k++) whole = clean(` ${whole}`.replace(DANGLE, ''));
  if (!COUNT_LEAD_RE.test(whole) && tailLead) whole = clean(`how many ${whole}`);
  if (!COUNT_LEAD_RE.test(whole) || whole.split(/\s+/).length < 3) return null;
  // R3 B2: a window said after the excluded thing ("someone other than Danny Ochoa in 2025") belongs to the whole as well as to the positive reading
  let period = '';
  {
    const rr = clean(right).replace(/,\s*(?:how\s+many|number\s+of|count)\s*$/i, '');
    const pm = rr.match(/\s+((?:in|during|for|of|from)\s+(?:(?:q[1-4]|january|february|march|april|may|june|july|august|september|october|november|december)\s+)?(?:19|20)\d{2})$/i);
    if (pm && /^(?:(?:by|from|for|with)\s+)?[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+$|^(?:over|under|above|below|more than|less than)\s+\$?[\d,]+(?:\.\d+)?k?$/.test(clean(rr.slice(0, pm.index))) && !new RegExp(`\\b${pm[1].replace(/\s+/g, '\\s+')}\\s*$`, 'i').test(whole)) { period = clean(pm[1]); whole = clean(`${whole} ${period}`); }
  }
  // the removed condition has to be non-empty text that is not itself a lead ("not how many")
  if (clean(positive) === clean(whole)) return null;
  let pos = positive.replace(/,\s*(?:how\s+many|number\s+of|count)\s*$/i, '').trim();
  if (!COUNT_LEAD_RE.test(pos)) pos = `how many ${pos}`;
  // mode 'compound' on purpose: the two sub-questions each pass their own lane's checks (the pre-router precision guard treats compound answers that way)
  return { mode: 'compound', negation: true, period, clauses: [whole, pos], total: whole, positive: pos, cond: clean(right).replace(/,\s*(?:how\s+many|number\s+of|count)\s*$/i, ''), original: q };
}

const RATIO_LEAD = String.raw`^(?:what|which)\s+(?:percent(?:age)?|share|fraction|proportion|portion)\s+of\s+(?:our\s+|the\s+|all\s+)?`;
const RATIO_VERB_RE = new RegExp(`${RATIO_LEAD}(.+?)\\s+(?:that\\s+|which\\s+)?(were|are|was|is|have|has|had)\\s+(.+)$`, 'i');
const RATIO_NOVERB_RE = new RegExp(`${RATIO_LEAD}([a-z]+(?:\\s[a-z]+)?)\\s+((?:over|under|above|below|more than|less than|from|with|for|in|during)\\b.+)$`, 'i');
const PERIOD_TAIL_RE = /\s+((?:in|during|for|of|from)\s+(?:(?:the\s+)?(?:first|second)\s+half\s+of\s+|(?:q[1-4]|january|february|march|april|may|june|july|august|september|october|november|december)\s+)?(?:19|20)\d{2}|(?:in|during|for)\s+(?:this|last)\s+(?:year|month|quarter))$/i;
/** Pure. "what percent of invoices were over $5000 in 2025" -> the part ("how many invoices were over $5000 in 2025") over the whole WITH THE SAME WINDOW ("how many invoices in 2025"). */
export function parseRatio(question) {
  const q = clean(question);
  if (!q || q.length > 200) return null;
  if (DOLLAR_RE.test(q)) return null;
  let things, verb, cond;
  let m = q.match(RATIO_VERB_RE);
  if (m) { things = clean(m[1]); verb = m[2].toLowerCase(); cond = clean(m[3]); }
  else if ((m = q.match(RATIO_NOVERB_RE))) { things = clean(m[1]); verb = ''; cond = clean(m[2]); }
  else return null;
  if (!things || !cond || things.split(/\s+/).length > 4) return null;
  // a window said at the end belongs to the whole as well as to the part; any other filter stays on the part only
  let period = '';
  const pm = cond.match(PERIOD_TAIL_RE);
  if (pm && clean(cond.slice(0, pm.index))) { period = clean(pm[1]); cond = clean(cond.slice(0, pm.index)); }
  const withPeriod = (t) => clean(period ? `${t} ${period}` : t);
  const total = withPeriod(`how many ${things}`);
  const positive = withPeriod(`how many ${things}${verb ? ` ${verb}` : ''} ${cond}`);
  return { mode: 'compound', ratio: true, clauses: [total, positive], total, positive, things, verb, cond, period, original: q };
}

const PERIOD = String.raw`(?:(?:the\s+)?(?:first|second)\s+half\s+of\s+|(?:q[1-4]|january|february|march|april|may|june|july|august|september|october|november|december)\s+)?(?:19|20)\d{2}|(?:this|last)\s+(?:year|month|quarter)`;
const NAME = String.raw`[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+`;
const PART = String.raw`(?:issued|logged|written|created|filed|dated|sent|done|made|opened|entered|handled|completed|invoiced|billed)`;
const DID_VERB = { write: 'written by', do: 'done by', handle: 'handled by', complete: 'completed by', issue: 'issued by', send: 'sent by', create: 'created by', log: 'logged by' };
/** The excluded condition as a clean phrase (window, amount, person, or a participle with one of those), else null. */
export function namedCondition(raw) {
  const c = clean(raw).replace(/^(?:that\s+|which\s+)?(?:were|was|are|is)\s+/i, '');
  let m;
  if ((m = c.match(new RegExp(`^(in|from|during|for|of)\\s+(${PERIOD})$`, 'i')))) return `${m[1].toLowerCase() === 'of' ? 'from' : m[1].toLowerCase()} ${m[2]}`;
  if ((m = c.match(/^(over|under|above|below|more than|less than)\s+(\$?[\d,]+(?:\.\d+)?k?)$/i))) return `${m[1].toLowerCase()} ${m[2]}`;
  if ((m = c.match(new RegExp(`^(for|by|from|with)\\s+(${NAME})(?:'s)?$`)))) return `${m[1]} ${m[2]}`;
  if ((m = c.match(new RegExp(`^(${PART})\\s+(in|during|on|for)\\s+(${PERIOD})$`, 'i')))) return `${m[1].toLowerCase()} ${m[2].toLowerCase()} ${m[3]}`;
  if ((m = c.match(new RegExp(`^(${PART})\\s+by\\s+(${NAME})$`, 'i')))) return `${m[1].toLowerCase()} by ${m[2]}`;
  if ((m = c.match(new RegExp(`^did\\s+(${NAME})\\s+(write|do|handle|complete|issue|send|create|log)$`)))) return `${DID_VERB[m[2]]} ${m[1]}`;
  return null;
}

const fmt = (n) => Number(n).toLocaleString('en-US');
/** One plain integer count out of a lane answer, else null. */
function countOf(d) {
  if (!d || d.kind === 'no-answer') return null;
  const text = String(d.text ?? '');
  const stripped = text.replace(/\$\s?[\d,]+(?:\.\d+)?/g, ' ').replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ').replace(/\b(?:19|20)\d{2}\b/g, ' ').replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, ' ');
  const nums = [...stripped.matchAll(/(?<![\w.])(\d[\d,]*)(?![\w.]|,\d)/g)].map((x) => Number(x[1].replace(/,/g, '')));
  if (nums.length !== 1) return null; // a second figure (a note about records missing the field, a share, a split) means the count has caveats a subtraction would hide
  return nums[0];
}

export async function runNegation(db, intent, ctx = {}) {
  const ratio = Boolean(intent.ratio);
  const { today, pack } = ctx;
  let tenantVocab = null;
  try { const { buildTenantVocab } = await import('../vocab/tenantVocab.js'); tenantVocab = await buildTenantVocab(db, pack); } catch { tenantVocab = null; }
  const c = { today, tenantVocab, pack };
  let tot = null, pos = null;
  try {
    tot = await _runLanes(db, intent.total, c);
    pos = await _runLanes(db, intent.positive, c);
    // "were logged in 2026" -> "in 2026": the window phrase without the participle the date readers do not expect
    if (!pos) { const alt = intent.positive.replace(/\b(?:(?:were|was|are|is)\s+)?(?:issued|logged|written|created|filed|dated|sent|done|made|opened|entered)\s+(in|during|on|for)\b/i, '$1'); if (alt !== intent.positive) pos = await _runLanes(db, alt, c); }
  } catch { return null; }
  const nT = countOf(tot), nP = countOf(pos);
  if (nT == null || nP == null) return null;
  // a positive count of 0 is released unless the excluded person is a technician on this organization's own roster (then "nobody else" is the whole)
  const zeroOk = nP === 0 && nT > 0 && !ratio && (() => {
    const nm = String(intent.cond ?? '').match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/)?.[1];
    return Boolean(nm) && (tenantVocab?.technicians?.phrases ?? []).some((t) => String(t).toLowerCase() === nm.toLowerCase());
  })();
  if (!((nP > 0 && nP < nT) || zeroOk)) return null;
  if (ratio) {
    const pct = Math.round((nP / nT) * 1000) / 10;
    const { answerEnvelope: env } = await import('../scope.js');
    const { attachCitations: att } = await import('../citations/records.js');
    const recs = [...(tot.records ?? []), ...(pos.records ?? [])];
    const what = `${intent.things} ${intent.verb ? `${intent.verb} ` : ''}${intent.cond}${intent.period ? ` ${intent.period}` : ''}`;
    const out2 = env({ text: `${pct}% of ${what}: ${fmt(nP)} of ${fmt(nT)} ${intent.things} on file${intent.period ? ` ${intent.period}` : ''}.`, facts: [{ label: 'Share', value: `${pct}%` }, { label: 'Matching', value: String(nP) }, { label: 'All counted', value: String(nT) }], sources: [...(tot.sources ?? []), ...(pos.sources ?? [])] });
    return att(out2, { records: recs, total: recs.length, claimedCount: null, basis: `Counted all the ${intent.things} on file${intent.period ? ` ${intent.period}` : ''} (${fmt(nT)}), counted the ones that match (${fmt(nP)}), and divided.` });
  }
  // plain sentence built from the words that were typed: "<noun> are not <condition>: <all> <noun> on file, minus <matching> <condition>."
  const answer = nT - nP;
  const { answerEnvelope } = await import('../scope.js');
  const { attachCitations } = await import('../citations/records.js');
  const lead = /^(?:how\s+many|number\s+of|count\s+of)\s+/i;
  const noun = intent.total.replace(lead, '').trim();
  const posRest = intent.positive.replace(lead, '').trim();
  const per = intent.period ? new RegExp(`\\s*${intent.period.replace(/\s+/g, '\\s+')}\\s*$`, 'i') : null;
  const nounBase = per ? noun.replace(per, '').trim() : noun;
  const posBase = per ? posRest.replace(per, '').trim() : posRest;
  const cond = namedCondition(posBase.toLowerCase().startsWith(nounBase.toLowerCase()) ? posBase.slice(nounBase.length).trim() : '');
  // the sentence is built only from a condition that can be named cleanly (a window, an amount, a person, a participle with one of those); anything else is released
  if (!cond) return null;
  const text = `${fmt(answer)} ${noun} are not ${cond}: ${fmt(nT)} on file, minus ${fmt(nP)} ${cond}.`;
  const records = [...(tot.records ?? []), ...(pos.records ?? [])];
  const out = answerEnvelope({ text, facts: [{ label: 'Not matching', value: String(answer) }, { label: 'All counted', value: String(nT) }, { label: 'Matching the excluded condition', value: String(nP) }], sources: [...(tot.sources ?? []), ...(pos.sources ?? [])] });
  return attachCitations(out, { records, total: records.length, claimedCount: null, basis: `Counted everything asked about (${fmt(nT)}), counted the ones the excluded condition describes (${fmt(nP)}), and took the difference.` });
}
