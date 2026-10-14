/**
 * dql/proposer/core - the CORE QUESTION EXTRACTOR (R22). Long pasted emails, "context first" questions, greetings, sign-offs and filler wrap one real question.
 * extractCore(q, vocab) returns {core, dropped} when exactly ONE piece of the text asks anything and every piece taken away is provably inert:
 * it holds no digit, no cue word (how many, list, total, when ...), no negation, no time / money / quantity word, and no word of this company's vocabulary
 * (kinds of paper, names, cities, brands, stored categories). Every word of the real question is kept. Otherwise null (the caller proposes on the whole text, as before).
 * Nothing here answers anything; the core still goes through the proposer, the validator's coverage rule and the learned heads.
 */
const CUE = /^(?:how|many|much|count|counts|counted|number|numbers|tally|total|totals|sum|average|avg|mean|median|list|lists|show|give|tell|which|who|whom|whose|what|whats|when|where|why|is|are|was|were|do|does|did|has|have|had|any|ever|can|could|would|will|may|find|pull|get|see|check|look|name|names|latest|earliest|newest|oldest|first|last|most|least|top|bottom|biggest|smallest|largest|highest|lowest|min|max|minimum|maximum|compare|versus|vs|between|since|before|after|during|through|until|from|within|over|under|above|below|more|less|fewer|than|at|on|in|of|for|per|by|each|every|all|only|just|not|no|never|none|nothing|nobody|without|except|but|other|else|also|plus|and|or|same|that|this|those|these|them|they|it|he|she|his|her|their|its)$/;
const KEEP = /^(?:include|including|included|exclude|excluding|excluded|skip|ignore|instead|rather|besides|how|many|much|count|counts|number|numbers|tally|total|totals|sum|average|avg|mean|median|list|show|give|tell|which|who|whom|whose|what|whats|when|where|why|any|ever|find|pull|get|see|check|name|names|latest|earliest|newest|oldest|first|last|most|least|top|bottom|biggest|smallest|largest|highest|lowest|min|max|compare|versus|vs|between|since|before|after|during|through|until|within|over|under|above|below|more|less|fewer|than|per|each|every|all|only|just|not|no|never|none|nothing|nobody|without|except|but|else|also|same|them|they|he|she|his|her|their|its|record|records|file|files|document|documents|paper|papers|entry|entries|visit|visits|order|orders|customer|customers|client|clients|owner|owners|member|members|account|accounts|vendor|vendors|tech|technician|technicians|city|cities|name|email|phone|address|date|dates|amount|amounts|price|cost|costs|balance|status|type|types|kind|kinds|form|forms|page|pages|invoice|invoices|quote|quotes|receipt|receipts|week|weeks|month|months|year|years|day|days|hour|hours|today|yesterday|tomorrow|tonight|now|ago|last|next|this|that|past|current|recent|recently|ytd|quarter|quarters|q[1-4]|dollar|dollars|usd|percent|percentage|half|dozen|couple|few|several|both|either|neither|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|weekend|weekday|morning|noon|evening|night|midnight|christmas|easter|thanksgiving|memorial|labor|independence|new|old|open|closed|paid|unpaid|due|overdue|expired|expiring|active|inactive|pending|late|recent|duplicate|duplicates|missing|incomplete|signed|unsigned|approved|rejected|sold|bought|billed|charged|owed|owe|owes|worth|spent|spend|spending|profit|margin|revenue|sales|income|expense|expenses|tax|taxes|fee|fees|rate|rates|discount|credit|debit|refund|refunds|deposit|deposits|warranty|warranties|service|services|work|job|jobs|repair|repairs|part|parts|item|items|line|lines|product|products|model|models|brand|brands|make|makes|serial|vehicle|vehicles|unit|units|property|properties|location|locations|site|sites|contract|contracts|lease|leases|policy|policies|claim|claims|patient|patients|student|students|case|cases|file|appointment|appointments|inspection|inspections|report|reports|estimate|estimates|bill|bills|payment|payments|check|checks|ticket|tickets|permit|permits|license|licenses|certificate|certificates|agreement|agreements|proposal|proposals|po|pos|ro|ros|wo|wos|id|ids|code|codes|number|phone|mobile|cell|fax|zip|state|street|st|ave|rd|dr)$/;
const NEGATION = /\b(?:not|no|never|none|nothing|nobody|neither|nor|without|except|n't|cannot|cant|dont|doesnt|didnt|isnt|arent|wasnt|werent|wont|wouldnt|shouldnt|couldnt|havent|hasnt|hadnt)\b/i;
const QCUE = /\b(?:how (?:many|much|often|long|old|far)|number of|count|tally|total|sum|average|avg|list|show|which|who|whom|whose|what|what's|whats|when|where|why|is there|are there|do we|did we|does|have we|has|any|latest|earliest|newest|oldest|first|last|most|least|biggest|smallest|highest|lowest|give me|tell me|pull|find|look up|check|name|names|email|phone|address)\b/i;

const STOP = new Set('and the for with from into onto over under per not are was were has had its our your you his her their this that these those who whom what which when where why how can may will'.split(' '));
/** the words of this company that mean something (kinds of paper, names, cities, brands, stored values) */
export function meaningWords(vocab) {
  if (vocab.__meaning) return vocab.__meaning;
  const s = new Set();
  const add = (p) => { for (const w of String(p).toLowerCase().split(/[^a-z0-9]+/)) if (w.length >= 3 && !STOP.has(w)) s.add(w); };
  for (const p of vocab.docPhrases?.keys?.() ?? []) add(p);
  for (const p of vocab.names?.keys?.() ?? []) add(p);
  for (const w of vocab.nameWords ?? []) add(w);
  for (const p of vocab.brands?.keys?.() ?? []) add(p);
  for (const p of vocab.cities?.keys?.() ?? []) add(p);
  for (const p of vocab.models?.keys?.() ?? []) add(p);
  for (const m of Object.values(vocab.cat ?? {})) for (const p of m.keys()) add(p);
  for (const p of vocab.docTypesInUse?.keys?.() ?? []) add(p);
  for (const p of vocab.industry ?? []) add(p);
  Object.defineProperty(vocab, '__meaning', { value: s, enumerable: false });
  return s;
}

/** words that are everyday filler in a sentence of its own ("why I am writing", "when the coffee runs out") - they only count as asking inside the question's own sentence */
const WEAK = new Set('this that all much but nothing not no never none nobody between also why when where what whats who whom whose which any name work job check pull get see find give tell street st ave rd dr zip state code site new old one two three four five six seven eight nine ten half dozen couple few several both every many kind else time times'.split(' '));
const SIDE_QCUE = /\b(?:how (?:many|much|often|long|old|far)|number of|count|tally|total|sum|average|avg|list|is there|are there|do we|did we|have we|latest|earliest|newest|oldest|most|least|biggest|smallest|highest|lowest|give me|tell me|show me)\b/i;
export function inert(text, vocab, { allowNegation = false, side = false } = {}) {
  if (!text.trim()) return true;
  if (/\d/.test(text) || /[$%#@]/.test(text)) return false;
  const negText = text.replace(/\b(?:no|not)\s+(?:rush|worries|hurry|problem|big deal|urgent)\b/gi, ' ');
  if (NEGATION.test(negText) && (!allowNegation || (side && text.trim().split(/\s+/).length < 7))) return false; // a negation alone in a short sentence ("Not the cancelled ones.") could narrow the question
  if (side && /(?:^|[a-z,;]\s+)(?!I\b|DeepWell\b|Donovan\b)[A-Z][a-z]+/.test(text.replace(/^\W*\S+\s*/, '')) && text.trim().split(/\s+/).length > 3) return false; // a capitalised word inside a sentence may be a name the records do not know
  if (side ? (SIDE_QCUE.test(text) || /\?\s*$/.test(text)) : QCUE.test(text)) return false;
  const mw = meaningWords(vocab);
  for (const w of text.toLowerCase().replace(/'/g, '').split(/[^a-z]+/)) { if (!w) continue; if ((KEEP.test(w) && !(side && WEAK.has(w))) || mw.has(w)) { inert.last = w; return false; } }
  return true;
}

/** split one line into clauses: sentences, then a "lead-in:" prefix, then a trailing ", ..." tail */
function sentences(line) { return line.split(/(?<=[.!?])\s+(?=[A-Za-z¿¡"'(])/).map((x) => x.trim()).filter(Boolean); }

export function extractCore(q, vocab) {
  const raw = String(q ?? '');
  if (raw.length < 25) return null;
  const lines = raw.replace(/\r/g, '').split('\n').map((x) => x.trim()).filter(Boolean);
  if (lines.length > 1 && lines.some((l) => /^(?:[a-z]\)|\d+[.)]|q\d+[:.)]|[-*•])\s/i.test(l))) return null; // a list of questions: not one core
  const pieces = [];
  for (const line of lines) { if (/^subject:/i.test(line)) { pieces.push({ t: line.replace(/^subject:\s*/i, ''), subject: true }); continue; } for (const s of sentences(line)) pieces.push({ t: s }); }
  const nonInert = pieces.filter((p) => !inert(p.t, vocab, { allowNegation: true, side: true })); // a negation in a sentence of its own cannot reach the question
  if (nonInert.length !== 1) return null;
  const main = nonInert[0];
  let t = main.t;
  const dropped = pieces.filter((p) => p !== main).map((p) => p.t);
  // a "lead-in:" prefix (greeting, "could you answer this for me", "No, I'm not unsure what I want") when the prefix itself is inert and the rest asks
  for (;;) {
    const m = /^([^:]{3,120}):\s+(.+)$/s.exec(t) ?? /^([^-\u2013\u2014]{3,60})\s[-\u2013\u2014]\s+(.+)$/s.exec(t);
    if (!m) break;
    const [, pre, rest] = m;
    if (/\d{1,2}$/.test(pre) && /^\d/.test(rest)) break; // a clock time
    if (!inert(pre, vocab, { allowNegation: !NEGATION.test(rest), side: true }) || !QCUE.test(rest) && inert(rest, vocab)) break;
    dropped.push(pre); t = rest;
  }
  // leading interjections / Spanish openers / trailing closers separated by a comma, only when inert
  for (let k = 0; k < 4; k++) {
    const m = /^([^,]{2,60}),\s+(.+)$/s.exec(t);
    if (m && inert(m[1], vocab) && !/\?$/.test(m[1])) { dropped.push(m[1]); t = m[2]; continue; }
    const e = /^(.+?),\s+([^,]{2,70}?)([.!?]*)$/s.exec(t);
    if (e && inert(e[2], vocab) && QCUE.test(e[1])) { dropped.push(e[2]); t = e[1] + (e[3] ?? ''); continue; }
    break;
  }
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length < 8 || t === raw.trim()) return null;
  return { core: t, dropped };
}
