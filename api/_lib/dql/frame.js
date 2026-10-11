/**
 * dql/frame.js - the chatter around a question ("hey Donovan, I was wondering ...", "... (need it for the books)", "when you get a chance").
 *
 * Pure. It removes only words that carry no condition: a clause in front of a comma or dash is dropped only when EVERY word of it is chatter, a
 * parenthetical or a trailing tag only when every word is chatter, and a leading request phrase ("I need you to", "do you know") is dropped as a whole phrase.
 * A number, a name, a negation, a comparison or a question word is never in these lists; anything else left in the question still has to be explained
 * by the parser's coverage rule, so a clause that is not pure chatter stays and the question is released.
 */

const CHATTER = new Set((
  "i id ill im ive was am wondering wonder looking look looked through the a an files file couldnt cant tell we got get into argument about this that at office boss bosses wants wanted know to quick question one hey hi hello donovan ok okay " +
  "please pls just curious my accountant keeps asking me and need it for books trying settle something in bugging all week find myself help out go ahead can you could do check if possible when chance thanks thx asap would like so also really " +
  "meeting tomorrow taxes ready getting prepare preparing review reviewing report reports call team week uh um er hm well actually anyway sorry bug time real again sure thing thing's whats up on with some day again customer wants says said told is are be mind forgot remember on-hand sec second moment minute let lets see us our team coworker coworkers manager " +
  "should shouldnt but didnt dont not doesnt tried try figure figured out there here being very bit little too any ever these those quickly soon later today this-one right away immediately now yet still then").split(/\s+/));
// words that would change the meaning of what follows are never chatter even if they appear above by accident
for (const w of ['not', 'dont', 'didnt', 'doesnt', 'cant', 'couldnt', 'shouldnt', 'now', 'today', 'any', 'ever', 'still', 'yet', 'then', 'this', 'that', 'there', 'here', 'later', 'soon']) { if (['dont', 'didnt', 'doesnt', 'cant', 'not', 'shouldnt'].includes(w)) CHATTER.delete(w); }
for (const w of ['now', 'today', 'any', 'ever', 'still', 'yet', 'then', 'later', 'soon']) CHATTER.delete(w);

import { COMMON_WORDS } from '../router/lexicon.generated.js';
import { editDistance } from './text.js';

const STRUCT = 'already second since before after during between thanks please question curious individual quick basic sorry wondering looking tomorrow accountant argument office basically actually really'.split(' ');
let COMMON = null;
const common = () => (COMMON ??= new Set(String(COMMON_WORDS).split(/\s+/)));
const TYPO_TARGETS = () => STRUCT.filter((w) => w.length >= 4);
let TT = null;
/** A mistyped chatter or structure word ("thaks", "pllease", "qestion") put back to the one word it is closest to; only words that are not real words, never a capitalised word. */
function fixTypos(q) {
  TT ??= TYPO_TARGETS();
  return q.replace(/[A-Za-z]{4,}/g, (w, off) => {
    const lw = w.toLowerCase();
    if (common().has(lw) || STRUCT.includes(lw)) return w;
    if (/^[A-Z][a-z]+$/.test(w) && off > 0) return w; // a capitalised word inside the sentence is a name
    const max = lw.length >= 8 ? 2 : 1;
    let best = null; let bd = max + 1; let tie = false;
    for (const t of TT) { if (Math.abs(t.length - lw.length) > max) continue; const d = editDistance(lw, t, max); if (d < bd) { bd = d; best = t; tie = false; } else if (d === bd && best !== t) tie = true; }
    return best && !tie && bd <= max ? best : w;
  });
}

const words = (s) => s.toLowerCase().replace(/[’‘`]/g, "'").replace(/'/g, '').split(/[^a-z0-9-]+/).filter(Boolean);
const pureChatter = (s) => { const w = words(s); return w.length > 0 && w.length <= 16 && w.every((x) => CHATTER.has(x)); };

const LEAD = [
  /^(?:sorry\s+if\s+this\s+is\s+basic\s+but|i\s+know\s+i\s+should\s+know\s+this\s+but|this\s+is\s+for\s+a\s+meeting\s+tomorrow\s+so|the\s+boss\s+(?:wants\s+to\s+know|asked)|my\s+accountant\s+keeps\s+asking\s+me\s+this\s+and)\b[\s,.:;-]*/i,
  /^(?:hey|hi|hello|ok|okay|so|well|oh|um|uh|and|donovan|please|pls)\b[\s,.:;-]*/i,
  /^(?:i\s+was\s+wondering|i\s+am\s+wondering|i\s+wonder|just\s+wondering|wondering)(?:\s+(?:if|whether)(?:\s+(?:you|u)\s+(?:could|can)\s+(?:tell|show|give)\s+me)?)?\b[\s,.:;-]*/i,
  /^(?:i\s+(?:need|want)\s+to\s+know|i(?:'|’)?d\s+like\s+to\s+know|i\s+would\s+like\s+to\s+know|i\s+(?:need|want)\s+you\s+to|i\s+(?:need|want)\s+a|i(?:'|’)?d\s+like\s+a|i\s+need|do\s+you\s+know|do\s+you\s+happen\s+to\s+know|any\s+idea)\b[\s,.:;-]*/i,
  /^(?:can|could|would|will)\s+(?:you|u)\s+(?:please\s+)?(?:just\s+)?(?:go\s+ahead\s+and\s+)?(?:tell\s+me\s+|let\s+me\s+know\s+|check\s+(?=how\s+many|what|which|who|if\s+we\s+have)|find\s+out\s+(?=how\s+many|what|which|who)|look\s+up\s+(?=how\s+many|what|which|who))?/i,
  /^(?:go\s+ahead\s+and|help\s+me\s+out|just\s+curious|quick\s+(?:one|question|q)|real\s+quick|tell\s+me|let\s+me\s+know|i\s+was\s+looking\s+(?:for|at|up)|curious)\b[\s,.:;-]*/i,
];
const TRAIL = [
  /[\s,.;:-]*\b(?:when\s+you\s+(?:get\s+a\s+(?:chance|sec|minute|moment)|can|have\s+(?:a\s+)?(?:chance|time|moment))|if\s+you\s+(?:can|could|don'?t\s+mind)|if\s+possible|for\s+me|thanks?(?:\s+a\s+lot)?|thx|asap|please|pls|right\s+away|whenever)\s*[?.!]*$/i,
  /[\s,.;:-]*\b(?:i\s+)?(?:looked|checked)\s+and\s+couldn'?t\s+find\s+it\s+myself\s*[?.!]*$/i,
  /[\s,.;:-]*\bit'?s\s+been\s+bugging\s+me\s+(?:all\s+(?:week|day)|for\s+days)\s*[?.!]*$/i,
  /[\s,.;:-]*\btrying\s+to\s+settle\s+(?:something|a\s+bet|an\s+argument)(?:\s+in\s+the\s+office)?\s*[?.!]*$/i,
];

export function dqlFrame(text) {
  let q = String(text ?? '').replace(/[’‘]/g, "'").trim();
  if (!q) return q;
  q = fixTypos(q);
  // parentheticals that are only chatter ("(need it for the books)")
  q = q.replace(/\(([^()]*)\)/g, (m, inner) => (pureChatter(inner) ? ' ' : m));
  // a clause in front of a comma / dash / colon that is only chatter ("I was looking through the files and couldn't tell - ")
  for (let i = 0; i < 3; i++) {
    const m = /^([^,:;]{1,140}?)(?:,|\s+-+\s+|\s+—\s+|:|;|\s+and\s+|\s+so\s+)\s*(.+)$/i.exec(q);
    if (m && pureChatter(m[1])) q = m[2]; else break;
  }
  // leading request phrases, then the same for a tail ("... when you get a chance")
  for (let i = 0; i < 6; i++) { const before = q; for (const re of LEAD) q = q.replace(re, '').trim(); if (q === before) break; }
  for (let i = 0; i < 4; i++) { const before = q; for (const re of TRAIL) q = q.replace(re, '').trim(); q = q.replace(/\s*\(\s*\)\s*$/, '').trim(); if (q === before) break; }
  // "need it for the books" / "for my accountant" left at the end without brackets
  q = q.replace(/[\s,.;:-]*\b(?:(?:i\s+)?need\s+it\s+for\s+(?:the\s+books|my\s+accountant|the\s+file|my\s+records|taxes))\s*[?.!]*$/i, '').trim();
  // "Donovan" anywhere is the assistant's name
  q = q.replace(/\bdonovan\b[\s,.:;-]*/gi, ' ').replace(/\s+/g, ' ').trim();
  if (!/\b(?:employees?|staff|workforce|team|payroll|hir(?:e|es|ed|ing)|workers?|techs?|technicians?|crew|salary|wages?|turnover)\b/i.test(q)) q = q.replace(/\bhead\s?count(?:\s+of)?(?=\s+\w)/gi, 'number of');
  return q;
}

/**
 * Meaning-preserving respellings of everyday phrasings into the forms the parser reads. Each rule changes the words, never the condition:
 * "exist", "came through", "located" and "belonging to" add nothing beside the slot they sit next to (a city, a name, a kind of paper).
 */
const ABBREV = [[/(?<![\w-])amt(?![\w-])/gi, 'amount'], [/(?<![\w-])tot(?![\w-])/gi, 'total'], [/(?<![\w-])invs?(?![\w-])/gi, (m) => (/s$/i.test(m) ? 'invoices' : 'invoice')], [/(?<![\w-])ests?(?![\w-])/gi, (m) => (/s$/i.test(m) ? 'estimates' : 'estimate')], [/(?<![\w-])custs?(?![\w-])/gi, (m) => (/s$/i.test(m) ? 'customers' : 'customer')], [/(?<![\w-])appts?(?![\w-])/gi, (m) => (/s$/i.test(m) ? 'appointments' : 'appointment')]];
const PARAPHRASE = [
  [/\s*[-–—,]\s*who\s+(?:are|were)\s+(?:they|those|these)\s*(?:please|asap|for me)?\s*\??$/i, ''],
  [/^(?!.*(?:\$\s*\d|\bdollars?\b|\bover\b|\bunder\b|\babove\b|\bbelow\b|at most|at least|more than|less than|no more|no less))(.+?)\s*[-–—,]\s*which\s+((?:customers|clients|patients|tenants|residents|owners|donors|supporters|members|accounts|homeowners|cities|vendors|suppliers|technicians|status(?:es)?)(?:\s+of\s+service)?)\s+(?:are|were)\s+(?:those|they|these)\s*(?:please|asap|for me)?\s*\??$/i, 'which $2 have $1'],
  [/\b(median|average|mean|avg)\s+(?:amount|total|value|dollar)\s+per\s+([a-z][a-z -]*?)(?=\s+(?:from|for|in|of|on|at|during|between|since|before|after|bought|with|where|that|back)\b|[,.?]|$)/gi, '$1 $2 total'],
  [/\boverall\s+(amount|total)\b/gi, 'total amount'],
  [/\bas\s+well\s+as\b/gi, 'and'],
  [/\bwhat\s+(?:do|does|did)\s+(?:the\s+|our\s+)?(.+?)\s+come\s+to(?:\s+in\s+dollars)?\s*\??$/gi, 'what is the total amount of $1'],
  [/\b(?:which|what)\s+(customers?|clients?|patients?|tenants?|residents?|owners?|donors?|supporters?|members?|accounts?|cit(?:y|ies)|brands?|vendors?)\s+comes?\s+out\s+on\s+top\s+by\b/gi, 'top $1 by'],
  [/\bwhich\s+(year|month|quarter)\s+stands\s+out\s+as\s+the\s+(?:heaviest|busiest|biggest)\b/gi, 'busiest $1'],
  [/\b(look|pull|bring|call)\s+up\b/gi, '$1'],
  [/\bearlier\s+than\b/gi, 'before'],
  [/\blater\s+than\b/gi, 'after'],
  [/\btotal\s+dollar\s+(?:value|amount|total)\b/gi, 'total amount'],
  [/\bdollar\s+(?:value|amount|total)\b/gi, 'total amount'],
  [/[-–—,]?\s*(?:so\s+)?when\s+(?:was|is)\s+it(?:\s+for\s+me)?\s*\??$/gi, ''],
  [/\b(?:on\s+)?what\s+(?:date|day)\s+(?:was|is)\s+(?:the\s+|our\s+)?(?=(?:very\\s+)?(?:latest|most\\s+recent|newest|last|first|earliest|oldest))/gi, ''],
  [/\bwhen(?:'s|s)\s+(?:the\s+|our\s+)?(?=(?:very\\s+)?(?:latest|most\\s+recent|newest|last|first|earliest|oldest))/gi, ''],
  [/\b(?:what(?:'s|\s+is|\s+was)?\s+)?(?:the\s+)?(?:dollar\s+amount|amount|value)\s+of\s+(?:the\s+|our\s+)?(?=(?:very\\s+)?(?:latest|most\\s+recent|newest|last|first|earliest|oldest))/gi, 'how much was the '],
  [/\bwhat\s+(?:did|does)\s+(?:the\s+|our\s+)?((?:very\\s+)?(?:latest|most\\s+recent|newest|last|first|earliest|oldest)\b.+?)\s+come\s+to\b/gi, 'how much was the $1'],
  [/\bwho\s+was\s+assigned\s+(?:the\s+|our\s+)?(?=(?:very\\s+)?(?:latest|most\\s+recent|newest|last|first|earliest|oldest))/gi, 'who did the '],
  [/\bwhich\s+(customers?|clients?|patients?|tenants?|residents?|owners?|donors?|supporters?|members?|accounts?|homeowners?)\s+(?:had|has|got|gets)\s+(?:the\s+|our\s+)?(?=(?:very\\s+)?(?:latest|most\\s+recent|newest|last|first|earliest|oldest))/gi, 'name the $1 with the '],
  [/\bwhat\s+(customers?|clients?|patients?|tenants?|residents?|owners?|donors?|supporters?|members?|accounts?|homeowners?)\s+is\s+on\s+(?:the\s+|our\s+)?(?=(?:very\\s+)?(?:latest|most\\s+recent|newest|last|first|earliest|oldest))/gi, 'name the $1 with the '],
  [/\b(?:which|what)\s+number\s+is\s+(?:the\s+|our\s+)?(?=(?:very\\s+)?(?:latest|most\\s+recent|newest|last|first|earliest|oldest))/gi, 'the '],
  [/\bwhat(?:'s|\s+is)\s+the\s+number\s+of\s+(?:the\s+|our\s+)?(?=(?:very\\s+)?(?:latest|most\\s+recent|newest|last|first|earliest|oldest))/gi, 'the '],
  [/\b(?:had|have|has)\s+(?:their|ther|his|her|its)\s+last\s+(.+?)\s+(?:before|prior\s+to|earlier\s+than)\s+(.+)$/i, 'with no $1 since $2'],
  [/\bhave\s+gone\s+quiet\s*[-–—:,]?\s*they\s+had\s+(?:an?\s+|any\s+)?(.+?)\s+before\s+but\s+not\s+since\s+(.+)$/i, 'with no $1 since $2'],
  [/\bhad\s+(?:an?\s+|any\s+)?(.+?)\s+at\s+some\s+point\s+but\s+(?:none|nothing|not\s+one)\s+since\s+(.+)$/i, 'with no $1 since $2'],
  [/\b(?:haven'?t|have\s+not|hasn'?t|has\s+not)\s+had\s+(?:an?\s+|any\s+)?(.+?)\s+since\s+(.+?)\s*\(?\s*but\s+did\s+before\s*\)?$/i, 'with no $1 since $2'],
  [/\b(?:is\s+it\s+true\s+(?:that\s+)?we\s+have|do\s+(?:we\s+)?have\s+(?:even\s+one|at\s+least\s+one)|did\s+we\s+(?:get|have)\s+any|is\s+there\s+(?:even\s+|at\s+least\s+)(?:one|1)|has\s+there\s+been\s+any|can\s+you\s+check\s+any|check\s+any)\b/gi, 'are there any'],
  [/\b(?:who|that)\s+(?:came|come|returned|return)\s+back\s+for\s+(?:a|an|the)\s+(?:second|2nd|another|repeat)\s+/gi, 'with at least 2 '],
  [/\b(completed|cancelled|canceled|rescheduled|pending|approved)\s+((?:[a-z-]+\s+){0,2}?(?:jobs?|visits?|appointments?|tickets?|orders?|inspections?|events?|calls?|meetings?|permits?))\b/gi, '$2 with status $1'],
  [/\b(?:assigned|given|allocated)\s+to\b/gi, 'by'],
  [/\b(?:(?:has|have|had)\s+)?already\s+(?:run|ran)\s+out\b|\b(?:has|have|had)\s+(?:run|ran)\s+out\b/gi, 'already expired'],
  [/\bpast\s+(?:their|its)\s+(?:end|expiry|expiration)\s+date\b/gi, 'already expired'],
  [/\b(?:have\s+|has\s+)?(?:ended|expired)\s+already\b|\b(?:are|were|is|have|has)\s+(?:already\s+)?(?:expired|ended)\b/gi, 'already expired'],
  [/\bwithin\s+the\s+(?:next|coming)\b|\bwithin\s+(?=\d)|\bin\s+the\s+coming\b|\bin\s+next\b/gi, 'in the next '],
  [/\bon\s+or\s+after\b/gi, 'since'],
  [/\bhow\s+many\s+dollars\b/gi, 'how much'],
  [/\b(lines?(?:\s+items?)?)\s+across\b/gi, '$1 on'],
  [/\bcombined\s+(amount|total)\s+of\b/gi, 'total amount of'],
  [/\b(?:that\s+|which\s+)?(?:include|includes|have|has|contain|contains|with)\s+("[^"]+"|[a-z]+)\s+as\s+(?:a|an|the)\s+line(?:\s+item)?\b/gi, 'with a $1 line'],
  [/\$(?!\s*\d)/g, ' dollars '],
  [/\b(?:from|on|for)\s+([a-z][a-z .'-]*?)'?s\s+work\b/gi, 'by $1'],
  [/\b(?:labell?ed|typed\s+as|tagged(?:\s+as)?|of\s+type|calls?\s+typed|visits?\s+typed)\s+(?=[a-z])/gi, ' '],
  [/(?<!\b(?:not|never|no|isn'?t|wasn'?t|aren'?t|weren'?t|without)\s)\b(?:marked|flagged\s+as)\s+(?=(?:completed|cancelled|canceled|open|scheduled|rescheduled|pending|approved|closed|in progress)\b)/gi, 'with status '],
  [/\b(?:typical\s+)?mid+le\s+val\w*\s+(?:of\s+)?/gi, 'median '],
  [/\bin\s+the\s+(\$?[\d,.]+)\s*-\s*(\$?[\d,.]+)\s+range\b/gi, 'between $1 and $2'],
  [/^for\s+every\s+(.+?),?\s+how\s+many\s+(.+?)((?:\s+(?:in|during|for|since|between|from|before|after|over)\b.*)?)$/i, '$2 per $1$3'],
  [/^(?:so\s+)?(?:is|are)\s+(?:the\s+)?(?:amount\s+of\s+)?(?:how\s+many\s+)?(.+?)(?:\s+we\s+get)?\s+going\s+up\s+or\s+down\s*[-–—:,]?\s*(?:show\s+(?:it|them)\s+)?by\s+(year|month|quarter)\b(.*)$/i, '$1 by $2$3'],
  [/\b(distinct|different|unique)\s+([a-z]+(?:\s+[a-z]+)?)\s+across\b/gi, '$1 $2 for'],
  [/\btotal\s+(?:number|#)\s+of\s+(?=(?:distinct|different|unique)\b)/gi, 'how many '],
  [/\b(?:the\s+)?(?:heaviest|biggest|largest|top)\s+(year|month|quarter|day\s+of\s+the\s+week|weekday)\b/gi, 'busiest $1'],
  [/\b(?:the\s+)?(?:lightest|quietest|slowest|smallest)\s+(year|month|quarter|day\s+of\s+the\s+week|weekday)\b/gi, 'slowest $1'],
  [/\bday\s+of\s+the\s+week\b/gi, 'weekday'],
  [/^(?:the\s+)?(.+?)\s+(?:was|were|is)\s+(?:done|handled|performed|worked|completed)\s+by\s+(?:who|whom)$/i, 'name the technician with the $1'],
  [/\bback\s+(?=(?:in|before|during|around|then)\b)/gi, ''],
  [/\bwhose\s+status\s+(?:is|was)\s+/gi, 'with status '],
  [/\bwhose\s+(?:address|city)\s+is\s+in\b/gi, 'in'],
  [/\bwhere\s+the\s+(?:customer|client|patient|tenant|resident|owner|donor|account|member|supporter)\s+is\s+(?:located\s+)?in\b/gi, 'in'],
  [/\b(?:that|which)\s+(?:are|were|is|was)\s+(?=(?:completed|cancelled|canceled|open|scheduled|rescheduled|pending|approved|closed)\b)/gi, 'with status '],
  [/\bfrom\s+((?:19|20)\d\d)\s+(?:on|onward|onwards|forward|and\s+(?:on|later|after))\b/gi, 'since $1'],
  [/\b((?:19|20)\d\d)\s+(?:onward|onwards)\b/gi, 'since $1'],
  [/\bfrom\s+((?:[a-z]+\s+\d{1,2},?\s+)?(?:[a-z]+\s+)?\d{1,4}(?:[/-]\d{1,2}(?:[/-]\d{2,4})?)?(?:,?\s*\d{4})?)\s+(?:until|till|to|through|thru)\s+(?:now|today|present|date)\b/gi, 'since $1'],
  [/\b(how\s+many|number\s+of|count\s+of|#\s*of)\s+(?:files|pieces\s+of\s+paperwork|papers)\b/gi, '$1 documents'],
  [/\b(how\s+many\b[^?]*?)\s+exists?\b/i, '$1'],
  [/\b(?:came|come|comes|coming)\s+(?:through|in)\b/gi, ' '],
  [/\b(?:located|based|situated)\s+(?=(?:in|at|near|around)\b)/gi, ''],
  [/\b(?:belonging\s+to|tied\s+to|associated\s+with|linked\s+to|connected\s+to|listed\s+under|attached\s+to)\b/gi, 'for'],
  [/\bon\s+(?:the\s+)?([a-z][a-z .'&-]*?)(?:'s|s')\s+account\b/gi, 'for $1'],
  [/\bbreak(?:ing)?\s+down\s+(?:the\s+)?(?:number|count|total)(?:\s+of)?\b/gi, 'number of'],
  [/\b(?:split|broken)\s+(?:out|up)\s+(?=by\b|per\b)/gi, ''],
  [/,?\s*-?\s*for\s+which\s+(?:tenants?|clients?|customers?|vendors?|suppliers?|patients?|donors?|accounts?|members?)(?:\s+please)?\s*\??$/gi, ''],
  [/\bbreak(?:ing)?\s+down\b(?![^.?]*\b(?:line\s+items?|what\s+they\s+were\s+for|costs?)\b)/gi, ' '],
  [/\b(?:a\s+)?rundown\s+of\b/gi, 'list the'],
  [/\bfor\s+each\s+([a-z]+)\s+and\s+([a-z ]+?)\s+combination\b/gi, 'by $1 and $2'],
  [/\b(?:what(?:'s|\s+is|\s+was)?\s+)?(?:the\s+)?date\s+of\s+(?:our\s+|the\s+|my\s+)?((?:very\s+)?(?:latest|most\s+recent|newest|last|first|earliest|oldest)\b)/gi, '$1'],
  [/\bwhen\s+(?:was|is)\s+(?:our\s+|the\s+)?((?:very\s+)?(?:latest|most\s+recent|newest|last|first|earliest|oldest)\b)/gi, '$1'],
  [/\b(?:it'?s|its)\s+been\s+how\s+many\s+days\s+since\b/gi, 'days since'],
  [/\bhow\s+many\s+days\s+since\b/gi, 'days since'],
  [/\b([a-z]+)\s+whose\s+(?:last|latest|most\s+recent)\s+(.+?)\s+was\s+(?:before|prior\s+to|earlier\s+than)\s+(.+)$/i, '$1 with no $2 since $3'],
];
const MONTH_NUM = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
export function dqlParaphrase(text) {
  let q = String(text ?? '');
  // "May 28, 2026" / "28 May 2026" -> 5/28/2026: the one day-level date form every span reader (single, from-to, between) understands
  q = q.replace(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+((?:19|20)\d\d)\b/gi, (m, mo, d, y) => `${MONTH_NUM[mo.slice(0, 3).toLowerCase()]}/${d}/${y}`);
  q = q.replace(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?,?\s+((?:19|20)\d\d)\b/gi, (m, d, mo, y) => `${MONTH_NUM[mo.slice(0, 3).toLowerCase()]}/${d}/${y}`);
  // "visits for customers in Chandler": the customers are where the visits happened, not a second thing counted
  q = q.replace(new RegExp(`(?<!\\b(?:percent|percentage|share|proportion|fraction|number|count|list|many|total|ratio|which|what)\\s)\\b(?:for|of|from)\\s+(?:the\\s+|our\\s+|all\\s+)?${CUSTW}\\s+(?=(?:in|at|located|based)\\b)`, 'gi'), '');
  q = compareRewrite(numbersRewrite(perEntityRewrite(rankRewrite(q.replace(/\s+/g, ' ').trim()))));
  for (const [re, to] of PARAPHRASE) q = q.replace(re, to);
  // "which tenants have leases ending ...": who holds the papers is what the answer lists; the question is about the papers
  if (/\b(?:expire|expires|expiring|expired|ending|ends|ended|run\s+out)\b/i.test(q)) q = q.replace(new RegExp(`\\b(?:which|what|list(?:\\s+the)?|name(?:\\s+the)?|show(?:\\s+me)?(?:\\s+the)?|who|for\\s+which)\\s+(?:of\\s+our\\s+)?(?:${CUSTW}|vendors?|suppliers?)\\s+(?:whose|that\\s+have|who\\s+have|with|have|has)\\s+(?:an?\\s+)?`, 'gi'), '').replace(/\bwho\s+(?:has|have)\s+(?:an?\s+)?/gi, '').replace(/,?\s*(?:for\s+which\s+(?:tenants?|clients?|customers?|vendors?|suppliers?|patients?|donors?))\s*\??$/i, '');
  for (const [re, to] of ABBREV) q = q.replace(re, to);
  // "days since X's latest invoice": the time reader says "last"
  if (/\b(?:days?|weeks?|months?|years?|long)\s+(?:since|ago)\b/i.test(q)) q = q.replace(/\b(?:latest|most\s+recent|newest)\b/gi, 'last');
  return q.replace(/\s+/g, ' ').trim();
}

/* ---------------------------------------------------------------- rankings written the other way round */

const NUMWORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const numOf = (w) => (w == null ? null : /^\d+$/.test(w) ? Number(w) : NUMWORDS[String(w).toLowerCase()] ?? null);
const DIMW = '(?:customers?|clients?|patients?|tenants?|residents?|owners?|donors?|supporters?|members?|accounts?|homeowners?|cit(?:y|ies)|towns?|brands?|manufacturers?|vendors?|suppliers?|technicians?|techs?|attorneys?|lawyers?|providers?|doctors?|foremen|foreman|mechanics?|crew\\s+leads?|supervisors?|coordinators?|plumbers?|electricians?|status(?:es)?|service\\s+types?|types?\\s+of\\s+service|document\\s+types?|years?|months?)';
const TOPW = '(?:top|best|biggest|largest|highest|most)'; const BOTW = '(?:bottom|worst|smallest|lowest|least|fewest)';
const HEAD = new RegExp(`^(?:(?:list|name|show|give\\s+me|tell\\s+me)\\s+)?(?:(?:our|the)\\s+)?(?:(${TOPW}|${BOTW})\\s+(?:(\\d+|one|two|three|four|five|six|seven|eight|nine|ten)\\s+)?|(\\d+|one|two|three|four|five|six|seven|eight|nine|ten)\\s+(${TOPW}|${BOTW})\\s+)(${DIMW})\\s+by\\s+(.+)$`, 'i');
const WHICH = new RegExp(`^which\\s+(?:(\\d+|one|two|three|four|five|six|seven|eight|nine|ten)\\s+)?(${DIMW})\\s+(?:have|has|had|got|gets|bring|brings)\\s+the\\s+(${TOPW}|${BOTW})\\s+(.+)$`, 'i');
function measureOf(tail) {
  let m;
  if ((m = /^(?:the\s+)?(?:total\s+)?(?:number|count)\s+of\s+(.+)$/i.exec(tail))) return { docs: m[1], money: false };
  if ((m = /^how\s+many\s+(.+?)(?:\s+(?:they|it)\s+(?:have|has|got|had))?(\s+(?:assigned|during|in|for|since|between|from|over|whose|with|marked|before|after|on)\b.*)?$/i.exec(tail))) return { docs: m[1] + (m[2] ?? ''), money: false };
  if ((m = /^(?:the\s+)?(?:dollar\s+total|total\s+(?:dollar\s+)?(?:amount|value)|total\s+dollars?|total|dollars?|amount|value)\s+(?:of|on|for)\s+(.+)$/i.exec(tail))) return { docs: m[1], money: true };
  if ((m = /^(?:the\s+)?total\s+(.+?)\s+(?:amount|dollars|value|total)\b(.*)$/i.exec(tail))) return { docs: m[1] + (m[2] ?? ''), money: true };
  if ((m = /^(.+?)\s+count\b(.*)$/i.exec(tail))) return { docs: m[1] + (m[2] ?? ''), money: false };
  if ((m = /^(.+?)\s+(?:dollars|amount|total|value)\b(.*)$/i.exec(tail))) return { docs: m[1] + (m[2] ?? ''), money: true };
  return null;
}
export function rankRewrite(q) {
  let m = HEAD.exec(q);
  if (m) {
    const w = (m[1] ?? m[4]).toLowerCase(); const n = numOf(m[2] ?? m[3]) ?? 1; const dir = new RegExp(`^${BOTW}$`, 'i').test(w) ? 'bottom' : 'top';
    const me = measureOf(m[6]);
    if (!me) return q;
    return `${dir} ${n} ${me.docs}${me.money ? ' dollars' : ''} by ${m[5]}`;
  }
  m = WHICH.exec(q);
  if (m) {
    const dir = new RegExp(`^${BOTW}$`, 'i').test(m[3]) ? 'bottom' : 'top'; const n = numOf(m[1]) ?? 1;
    const tail = m[4]; const money = /\b(?:dollars?|amount|total|value)\b/i.test(tail);
    return `${dir} ${n} ${tail.replace(/\b(?:dollars?|amount|total|value)\b/gi, ' ')}${money ? ' dollars' : ''} by ${m[2]}`.replace(/\s+/g, ' ');
  }
  return q;
}

/* ---------------------------------------------------------------- "for a typical client" averages */

const CUSTW = '(?:customers?|clients?|patients?|tenants?|residents?|owners?|donors?|supporters?|members?|accounts?|homeowners?)';
const PER_ENTITY = [
  // which clients are counted: every one, or only those that have any
  [new RegExp(`,?\\s*(?:counting|only\\s+counting|only\\s+among|among\\s+just|just\\s+among|only\\s+for)\\s+(?:just\\s+|only\\s+)?(?:the\\s+)?${CUSTW}\\s+(?:who|that)\\s+(?:have|has|had|got)\\s+(?:any|at\\s+least\\s+one|one\\s+or\\s+more|some)\\b`, 'gi'), ' who have any '],
  [new RegExp(`,?\\s*(?:counting|including)\\s+(?:every|all)\\s+(?:the\\s+|our\\s+)?${CUSTW}(?:\\s+we\\s+have(?:\\s+on\\s+file)?|\\s+have\\s+on\\s+file)?`, 'gi'), ' '],
  [new RegExp(`,?\\s*across\\s+all\\s+(?:our\\s+)?${CUSTW},?\\s*including\\s+ones\\s+(?:with|that\\s+have)\\s+(?:none|nothing|no\\s+\\w+(?:\\s+\\w+)?)\\s*`, 'gi'), ' '],
  [new RegExp(`\\b(?:what(?:'s|\\s+is)?\\s+)?(?:the\\s+)?(?:average|avg|mean)\\s+(?:number\\s+of\\s+|how\\s+many\\s+)?(.+?)\\s+(?:for|per)\\s+an?\\s+typical\\s+(${CUSTW})\\b`, 'gi'), 'average number of $1 per $2'],
  [new RegExp(`\\b(?:what(?:'s|\\s+is)?\\s+)?how\\s+many\\s+(.+?)\\s+on\\s+(?:avg|average)\\s+for\\s+an?\\s+typical\\s+(${CUSTW})\\b`, 'gi'), 'average number of $1 per $2'],
  
];
export function perEntityRewrite(q) {
  if (!/\btypical\b/i.test(q) && !/\bwho have any\b/i.test(q)) return q;
  let out = q;
  for (const [re, to] of PER_ENTITY) out = out.replace(re, to);
  return out.replace(/\s+/g, ' ').trim();
}

/* ---------------------------------------------------------------- "the invoice numbers of invoices ..." */

const KEEP_BEFORE = new Set('list show me give pull up which what whats are name tell the all our us find get a an'.split(' '));
/** "list the permit numbers of permits in 2025" asks for the permits (their numbers are in the answer): the word "numbers" and the kind of paper in front of it are dropped. */
export function numbersRewrite(q) {
  const t = q.split(/\s+/);
  const i = t.findIndex((w, k) => (/^numbers$/i.test(w) && /^(?:of|on|for|are)$/i.test(t[k + 1] ?? '')) || (/^number$/i.test(w) && /^on$/i.test(t[k + 1] ?? '') && /^the$/i.test(t[k + 2] ?? '')));
  if (i < 0) return q;
  let a = i;
  for (let n = 0; n < 2 && a > 0 && !KEEP_BEFORE.has(t[a - 1].toLowerCase().replace(/[^a-z]/g, '')); n++) a--;
  let out = [...t.slice(0, a), ...t.slice(i + 2)].join(' ');
  if (/^numbers$/i.test(t[i]) && !/^(?:list|show|pull|give|name|find)\b/i.test(out)) out = `list ${out.replace(/^(?:which|what)\s+(?:are\s+)?(?:the\s+)?/i, '')}`; // the papers are listed, their numbers come with them
  return out;
}

/* ---------------------------------------------------------------- two things compared, asked the long way */

const CMPW = '(?:more|higher|bigger|greater|larger|fewer|less|lower|smaller)';
const MEAS = '(?:number\\s+of\\s+|count\\s+of\\s+|total\\s+(?:number\\s+of\\s+)?|amount\\s+of\\s+|dollar\\s+total\\s+of\\s+)?';
const CMP_FORMS = [
  [new RegExp(`^compare\\s+(.+?)\\s+(?:and|with|to)\\s+(.+?):\\s*which\\s+(?:one\\s+)?(?:had|has)\\s+(?:an?\\s+)?${CMPW}\\s+(${MEAS})(.+)$`, 'i'), (m) => `${m[3]}${m[4]} ${m[1]} versus ${m[2]}`],
  [new RegExp(`^(?:yes\\s+or\\s+no[:,]?\\s*)?is\\s+the\\s+(${MEAS})(.+?)\\s+${CMPW}\\s+for\\s+(.+?)\\s+than\\s+(?:for\\s+)?(.+)$`, 'i'), (m) => `${m[1]}${m[2]} ${m[3]} versus ${m[4]}`],
  [new RegExp(`^(?:yes\\s+or\\s+no[:,]?\\s*)?(?:does|did|do|is|was|has|have)\\s+(.+?)\\s+(?:have|has|had|got|get)\\s+(?:an?\\s+)?${CMPW}\\s+(${MEAS})(.+?)\\s+than\\s+(.+)$`, 'i'), (m) => `${m[2]}${m[3]} ${m[1]} versus ${m[4]}`],
  [new RegExp(`^(?:yes\\s+or\\s+no[:,]?\\s*)(.+?)\\s+(?:has|have|had)\\s+(?:an?\\s+)?${CMPW}\\s+(${MEAS})(.+?)\\s+than\\s+(.+)$`, 'i'), (m) => `${m[2]}${m[3]} ${m[1]} versus ${m[4]}`],
  [new RegExp(`^(?:yes\\s+or\\s+no[:,]?\\s*)?was\\s+the\\s+(${MEAS})(.+?)\\s+${CMPW}\\s+for\\s+(.+?)\\s+than\\s+(.+)$`, 'i'), (m) => `${m[1]}${m[2]} ${m[3]} versus ${m[4]}`],
  [new RegExp(`^which\\s+(?:one\\s+)?(?:has|have|had|is|was)\\s+(?:an?\\s+)?${CMPW}\\s+(${MEAS})(.+?),\\s*(.+?)\\s+or\\s+(.+)$`, 'i'), (m) => `${m[1]}${m[2]} ${m[3]} versus ${m[4]}`],
  [new RegExp(`^(?:what(?:'s|\\s+is)?\\s+|how\\s+big\\s+is\\s+)?(?:the\\s+)?(?:gap|difference)\\s+(?:in|of)\\s+(?:the\\s+)?(${MEAS})(.+?)\\s+between\\s+(.+?)\\s+and\\s+(.+)$`, 'i'), (m) => `${m[1]}${m[2]} ${m[3]} versus ${m[4]}`],
  [new RegExp(`^(?:what(?:'s|\\s+is)?\\s+|how\\s+big\\s+is\\s+)?(?:the\\s+)?(?:gap|difference)\\s+between\\s+(.+?)\\s+and\\s+(.+?)\\s+in\\s+(?:the\\s+)?(${MEAS})(.+)$`, 'i'), (m) => `${m[3]}${m[4]} ${m[1]} versus ${m[2]}`],
];
export function compareRewrite(q) {
  for (const [re, fn] of CMP_FORMS) { const m = re.exec(q.trim()); if (m) return fn(m).replace(/\s+/g, ' ').trim(); }
  return q;
}
