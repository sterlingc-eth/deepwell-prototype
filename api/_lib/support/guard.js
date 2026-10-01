/**
 * Round 28 — Support Assistant, deterministic guards. Everything here is pure and free ($0): input hygiene,
 * sensitive-data refusal, prompt-injection screens, small talk, scope routing (records questions go to
 * Donovan, everything not about DeepWell is refused) and the OUTPUT validator that every model reply must
 * pass before a visitor sees it.
 */
import { CANARY, CONTACT_EMAILS, ALLOWED_LINK_HOSTS, LIMITS } from './policy.js';
import { redactSecrets } from '../privacy/redact.js';

/* ------------------------------------------------------------------ input hygiene */

/** Strip control characters, normalize whitespace and cap length. Never throws. */
export function sanitizeInput(raw) {
  return String(raw ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁠﻿]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Neutralize anything that could spoof our prompt delimiters when text is placed inside them. */
export function defang(text) {
  return String(text ?? '').replace(/</g, '‹').replace(/>/g, '›');
}

/** Lowercase, drop apostrophes, punctuation -> spaces. */
export function norm(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['\u2019`]/g, '')
    .replace(/[^a-z0-9$@%+/.\s]/g, ' ')
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ------------------------------------------------------------------ sensitive data */

function luhnOk(digits) {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/**
 * R34: every card-shaped run of digits (spaces, dots, dashes or NBSP between groups; letters may touch it: "visa4242...") is tested for
 * a Luhn-valid window of 13-19 digits, so "4242 4242 4242 4242 12/27" and "card:4242424242424242" are both caught.
 * @returns {Array<[number, number]>} [start, end) spans in `s`
 */
function cardSpans(s) {
  const spans = [];
  for (const m of s.matchAll(/(?<!\d)\d(?:[ .\- ]{0,2}\d){11,24}(?!\d)/g)) {
    const groups = [];
    for (const g of m[0].matchAll(/\d+/g)) groups.push({ d: g[0], a: g.index, b: g.index + g[0].length });
    for (let i = 0; i < groups.length; i++) {
      let digits = '';
      for (let j = i; j < groups.length; j++) {
        digits += groups[j].d;
        if (digits.length > 19) break;
        if (digits.length >= 13 && (luhnOk(digits) || (j - i >= 3 && groups.slice(i, j + 1).slice(0, 3).every((g) => g.d.length === 4)))) {
          spans.push([m.index + groups[i].a, m.index + groups[j].b]);
        }
      }
    }
  }
  return spans;
}

const DIGIT_WORDS = '(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)';
const SSN_KEYWORD = '(?:ssn|ss ?#|social(?: security)?(?: (?:number|no\\.?|num|#))?|tax ?id|itin|ein)';
const SSN_RES = [
  /(?<![\d-])\d{3}[- .]\d{2}[- .]\d{4}(?![\d-])/,
  new RegExp(`\\b${SSN_KEYWORD}\\b[^0-9\\n]{0,25}(?:\\d[ .-]?){9}(?!\\d)`, 'i'),
  new RegExp(`(?:\\b${DIGIT_WORDS}\\b[\\s,.-]*){9,}`, 'i'),
];
const SECRET_WORD = '(?:password|passcode|passwd|pass ?phrase|passw0rd|pw|pwd|pin|secret|credentials?)';
// "my password is X", "pwd=X", "password for DeepWell is X", "login is a@b.com and pass is X"
const PASSWORD_RE = new RegExp(`\\b${SECRET_WORD}\\b(?:\\s+(?:for|to|on|at)\\s+[\\w.@-]+(?:\\s+[\\w.@-]+)?)?\\s*(?:is|was|are|=|:|-|->)\\s*["'“‘]?([^\\s"'”’]{3,})`, 'ig');
const BARE_PASS_RE = /(?:^|\b(?:my |the |account |login |and |with )|[\s,;])pass\s*(?:is|=|:)\s*["']?([^\s"']{4,})/ig;
const NOT_A_SECRET = /^(?:not|wrong|incorrect|invalid|expired|rejected|working|correct|right|too|being|still|stuck|locked|blank|empty|missing|changed|different|same|fine|ok|okay|saved|stored|safe|secure|hidden|visible|required|needed|never|always|just|only|already|now|here|there|that|this|what|why|how|forgotten|lost|broken|failing|failed|denied|accepted|refused|slow|long|short|weak|strong|resetting|reset|being|supposed|currently|going|getting|showing|asking|says|saying|no|yes|and|the|for|but|it|so|an?|in|on|at|to|of|or|if)$/i;
const looksSecret = (v) => !NOT_A_SECRET.test(String(v).replace(/[^\w]+$/g, '')) && (/\d|[^\w\s]/.test(v) || String(v).length >= 4);
const KEY_RES = [
  /\b(?:sk|pk|rk|dwk|whsec)[-_][A-Za-z0-9_-]{12,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/, /\bgh[pousr]_[A-Za-z0-9]{30,}\b/, /\bxox[baprs]-[A-Za-z0-9-]{10,}/, /\bAIza[0-9A-Za-z_-]{30,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/, /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:api[ _-]?key|secret|token|bearer)\b[^A-Za-z0-9\n]{0,6}[A-Za-z0-9_\-+/=.]{24,}/i,
];
const BANK_RES = [
  /\b(?:routing|aba|account|acct)\s*(?:number|no\.?|num|#)?\s*(?:is|:|=)?\s*\d[\d -]{6,}\d/i,
  /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/,
  /\b(?:driver'?s? licen[sc]e|passport|dl|ein|itin)\s*(?:number|no\.?|#)?\s*(?:is|:|=)?\s*[A-Z]?\d[A-Z0-9-]{5,}/i,
];

/** True when the message contains a card number, SSN, password/PIN, API key/token, bank or ID number. Returns a short kind or null. */
export function detectSensitive(text) {
  const s = String(text ?? '').normalize('NFKC');
  if (cardSpans(s).length) return 'card';
  if (SSN_RES.some((re) => re.test(s))) return 'ssn';
  for (const m of s.matchAll(PASSWORD_RE)) if (looksSecret(m[1])) return 'password';
  for (const m of s.matchAll(BARE_PASS_RE)) if (/\d|[^\w\s]/.test(m[1])) return 'password';
  if (KEY_RES.some((re) => re.test(s))) return 'key';
  if (BANK_RES.some((re) => re.test(s))) return 'id';
  return null;
}

/** R34: redact everything detectSensitive() would refuse (used on hand-off text, history and model output). Pure. */
export function redactSensitive(text) {
  let s = String(text ?? '').normalize('NFKC');
  const merged = [];
  for (const [a, b] of cardSpans(s).sort((x, y) => x[0] - y[0] || y[1] - x[1])) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b); else merged.push([a, b]);
  }
  if (merged.length) {
    let out = ''; let at = 0;
    for (const [a, b] of merged) { out += `${s.slice(at, a)}[redacted-card]`; at = b; }
    s = out + s.slice(at);
  }
  for (const re of SSN_RES) s = s.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), '[redacted-id]');
  s = s.replace(PASSWORD_RE, (m, v) => (looksSecret(v) ? m.slice(0, m.length - v.length) + '[redacted]' : m));
  s = s.replace(BARE_PASS_RE, (m, v) => (/\d|[^\w\s]/.test(v) ? m.slice(0, m.length - v.length) + '[redacted]' : m));
  for (const re of KEY_RES) s = s.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), '[redacted-key]');
  for (const re of BANK_RES) s = s.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), '[redacted-id]');
  return redactSecrets(s);
}

/* ------------------------------------------------------------------ prompt injection */

const INJECTION_RES = [
  /\b(?:repeat|print|show|output|recite|echo|reveal|display)\b[^.?!]{0,30}\b(?:everything|all|text|words|content|message|messages|instructions)\b[^.?!]{0,20}\b(?:above|before this|so far|earlier|prior)\b/i,
  /\b(?:ignore|disregard|forget|override|bypass|drop)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|any|your|the|these|those|system)\b[^.\n]{0,30}\b(?:instruction|instructions|prompt|rules?|guidelines?|directions?|constraints?|policy|policies|context)\b/i,
  /\b(?:reveal|show|print|display|repeat|output|leak|tell me|give me|dump|share|recite|paste|echo)\b[^.\n]{0,40}\b(?:system prompt|your prompt|your instructions|initial prompt|hidden prompt|your rules|your guidelines|knowledge base|your configuration|developer message|canary)\b/i,
  /\bwhat (?:is|are|were) your (?:system )?(?:prompt|instructions|rules|guidelines|initial instructions)\b/i,
  /\byou are (?:now|no longer)\b/i,
  /\b(?:act|behave|respond|answer) as if you (?:are|were)\b/i,
  /\bpretend (?:to be|you are|you're|that)\b/i,
  /\b(?:jailbreak|dan mode|developer mode|god mode|do anything now|sudo mode|admin mode|unrestricted mode)\b/i,
  /\bnew (?:instructions?|rules?|persona|role)\s*:/i,
  /<\/?\s*(?:system|assistant|user|human|knowledge|user_message|account_context|instructions?|tool_result|tool_use|function_calls?)\b/i,
  /(?:^|\n)\s*(?:system|assistant|developer|human)\s*:/i,
  /\[\s*(?:system|inst|\/inst)\s*\]|<\|(?:im_start|im_end|system|endoftext)\|>/i,
  /\b(?:base64|rot13|hex(?:adecimal)?)\b[^.\n]{0,25}\b(?:decode|encoded|instruction|payload)\b/i,
  /[A-Za-z0-9+/]{80,}={0,2}/,
  /\b(?:without|no) (?:any )?(?:restrictions?|filters?|limits?|rules?|guardrails?)\b/i,
  /\bwrite (?:your|the) (?:system )?prompt\b/i,
  /\bignore (?:everything|all|that)\b/i,
];

/** R34: persona / override / extraction phrasings the first set missed (found by the break-it round). */
const INJECTION_RES_R34 = [
  /\b(?:stop|quit|cease|no longer)\s+(?:following|obeying|using|applying|respecting)\b[^.\n]{0,30}\b(?:rules?|guidelines?|instructions?|restrictions?|polic(?:y|ies)|filters?)\b/i,
  /\b(?:forget|disregard|ignore|erase|discard|abandon)\b[^.\n]{0,25}\b(?:everything|anything|what you (?:were|have been|are) (?:told|given|taught|instructed)|what you know|you (?:know|were told))\b/i,
  /\b(?:role ?play|roleplay|role-play)\b|\bstay in character\b|\bin character\b|\b(?:two|2|dual|split|new|another|different|your|a) personas?\b|\b(?:adopt|assume|take on)\b[^.\n]{0,20}\bpersonas?\b/i,
  /\b(?:respond|reply|answer|speak|talk|write|behave)\b[^.\n]{0,15}\b(?:only )?(?:as|like)\b[^.\n]{0,25}\b(?:bot|ai|character|pirate|dan|evil\w*|rebel|shakespeare|grandma|grandmother|my \w+|a \w+ (?:who|that))\b/i,
  /(?:^|[.!?\n]\s*|\byou\b[^.\n]{0,25}|\bplease\s+|\bnow\s+)(?:act|play|behave|pose)\s+(?:like|as)\s+(?:a|an|my|the|some)\b/i,
  /\bi (?:want|need|would like|'d like) you to (?:act|play|be|become|pretend)\b/i,
  /\byou must (?:obey|comply|listen|follow my|do as)\b|\bi (?:authorize|order|command|instruct|permit) you\b|\byou (?:are|have been) (?:authorized|permitted|cleared) to\b/i,
  /\b(?:sudo|root access|admin(?:istrator)? access|superuser|jailbroken?|unfiltered|uncensored)\b/i,
  /\b(?:evil|rebel|opposite|unrestricted|unfiltered) (?:version|twin|bot|mode|ai|you|side)\b/i,
  /\bfrom now on\b[^.\n]{0,40}\b(?:you|respond|answer|speak|reply|only|always|never|ignore|say)\b/i,
  /\b(?:sandbox|simulation|hypothetical(?:ly)?|fictional (?:world|scenario|story)|in a story|game)\b[^.\n]{0,50}\b(?:no|without|free of|ignor\w*) (?:consequences|rules?|limits?|restrictions?|guardrails?|filters?)\b/i,
  /\bgrand(?:ma|mother|pa|father)\b[^.\n]{0,40}\b(?:used to|would|read me|told me)\b/i,
  /\b(?:quote|cite|paste|copy|transcribe|reproduce|print|echo|spell|list|enumerate|summari[sz]e|recite)\b[^.\n]{0,30}\b(?:your|the) (?:system |hidden |initial |original |full |entire |secret )?(?:prompt|instructions?|guidelines?|rules|configuration|config|tools?|functions?|knowledge(?: base)?|articles?|article ids?|schema)\b/i,
  /\bwhich (?:tools?|functions?)\b[^.\n]{0,20}\b(?:do|can|are|will) you\b|\bwhat (?:tools?|functions?|capabilities) (?:do|can|are) you\b/i,
  /\bwhat (?:are|were|is) you(?:'re| are)? (?:not )?(?:allowed|told|instructed|programmed|forbidden|prohibited|restricted)\b|\b(?:which|what) (?:topics?|things?|words?) (?:are|were) you (?:told|instructed|not allowed|forbidden)\b/i,
  /you are the deepwell support assistant|\bdw-?canary\b|\bcanary (?:string|word|token|value)\b|\b(?:json|tool|reply) schema\b/i,
  /\b(?:system|developer|admin|root|operator) (?:override|command|message|instruction|prompt|mode|access)\b/i,
  /\b(?:your|this|the) (?:model|llm|ai|bot)'?s? (?:temperature|settings?|parameters?|version|context window|token limit|max tokens)\b|\b(?:temperature|top[- ]?p|max tokens?|context window|token limit) (?:setting|settings|of|for|on)\b[^.?]{0,15}\b(?:model|llm|you|bot|this)\b/i,
  /\b(?:enter|activate|enable|switch to|turn on|go into) (?:dan|god|developer|debug|admin|unrestricted|jailbreak|sudo)\b/i,
  /\b(?:translate|decode|decrypt|rot13|base64)\b[^.\n]{0,40}\b(?:then|and) (?:follow|obey|do|run|execute|answer)\b|\b(?:follow|obey|execute|run) (?:it|them|this|that|the (?:decoded|translated))\b[^.\n]{0,15}\b(?:decoded|translated|instructions?)\b/i,
];

const CONFUSABLE = { '\u0430': 'a', '\u0435': 'e', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c', '\u0445': 'x', '\u0443': 'y', '\u0456': 'i', '\u0455': 's', '\u0458': 'j', '\u0501': 'd', '\u0261': 'g', '\u03bf': 'o', '\u03b1': 'a', '\u03b5': 'e', '\u03b9': 'i', '\u03bd': 'v', '\u03c1': 'p', '\u03c4': 't', '\u03c5': 'u', '\u03c7': 'x', '\u03ba': 'k', '\u0131': 'i', '\u0391': 'a', '\u0392': 'b', '\u0395': 'e', '\u0399': 'i', '\u039a': 'k', '\u039c': 'm', '\u039d': 'n', '\u039f': 'o', '\u03a1': 'p', '\u03a4': 't', '\u03a7': 'x', '\u0410': 'a', '\u0412': 'b', '\u0415': 'e', '\u041a': 'k', '\u041c': 'm', '\u041d': 'h', '\u041e': 'o', '\u0420': 'p', '\u0421': 'c', '\u0422': 't', '\u0425': 'x' };
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i' };
const rot13 = (t) => t.replace(/[a-z]/gi, (c) => String.fromCharCode(((c.charCodeAt(0) & 95) < 78 ? c.charCodeAt(0) + 13 : c.charCodeAt(0) - 13)));

/** The message as a model could "read" it after trivial obfuscation: homoglyphs, leetspeak, spaced letters, rot13, reversed text, short base64/hex blobs. */
export function injectionVariants(raw) {
  const base = String(raw ?? '').normalize('NFKC');
  const folded = base.replace(/[\u0370-\u03ff\u0400-\u04ff\u0131\u0261\u0501]/g, (c) => CONFUSABLE[c] ?? c).toLowerCase();
  const out = [String(raw ?? ''), folded];
  out.push(folded.replace(/[a-z0-9@$!]{3,}/g, (tok) => (/[a-z]/.test(tok) && /[0134578@$!]/.test(tok) ? tok.replace(/[0134578@$!]/g, (c) => LEET[c]) : tok)));
  out.push(folded.replace(/\b(?:[a-z][ .\-_*]){3,}[a-z]\b/g, (m) => m.replace(/[ .\-_*]/g, '')));
  out.push(rot13(folded));
  out.push([...folded].reverse().join(''));
  for (const m of folded.matchAll(/[a-z0-9+/]{16,}={0,2}/g)) {
    try { const d = Buffer.from(m[0], 'base64').toString('utf8'); if (/^[\x20-\x7e\n]{8,}$/.test(d)) out.push(d); } catch { /* not base64 */ }
  }
  for (const m of folded.matchAll(/\b(?:[0-9a-f]{2}){10,}\b/g)) {
    try { const d = Buffer.from(m[0], 'hex').toString('utf8'); if (/^[\x20-\x7e\n]{8,}$/.test(d)) out.push(d); } catch { /* not hex */ }
  }
  return out;
}

export function detectInjection(text) {
  const s = String(text ?? '');
  if (INJECTION_RES.some((re) => re.test(s))) return true;
  for (const v of injectionVariants(s)) if (INJECTION_RES.some((re) => re.test(v)) || INJECTION_RES_R34.some((re) => re.test(v))) return true;
  return false;
}

/* ------------------------------------------------------------------ small talk, identity, humans */

export function detectSmalltalk(text) {
  const n = norm(text).replace(/[.!?]+$/g, '');
  if (!n) return 'empty';
  if (/^(?:hi|hello|hey|hiya|howdy|yo|good (?:morning|afternoon|evening)|greetings|hello there|hi there|hey there|sup)(?: (?:there|team|deepwell|support|bot|assistant))?$/.test(n)) return 'greeting';
  if (/^(?:thanks|thank you|thx|ty|thank you so much|thanks a lot|much appreciated|appreciate it|great thanks|ok thanks|okay thanks|perfect thanks|got it thanks|cool thanks|thanks so much|awesome thanks)$/.test(n)) return 'thanks';
  if (/^(?:bye|goodbye|see you|see ya|later|cya|have a good one|have a nice day|that is all|thats all|thats it|no thanks|no thank you|nope thanks|im good|all set|nothing else)$/.test(n)) return 'bye';
  if (/^(?:ok|okay|k|cool|nice|great|awesome|got it|understood|sounds good|alright|sure|yes|no|yep|nope)$/.test(n)) return 'ack';
  return null;
}

export function detectIdentity(text) {
  const n = norm(text);
  return /\b(?:are you (?:a |an )?(?:real |actual )?(?:human|person|bot|robot|ai|chatbot|machine|chatgpt|gpt|claude|gemini|llm|live agent)|is this (?:a |an )?(?:bot|ai|human|real person|robot)|what (?:model|llm|ai) (?:are|is) (?:you|this|powering)|which (?:model|llm|ai)|who (?:made|built|created|trained|programmed) you|are you powered by|what are you built (?:on|with)|what are you|who are you(?! (?:guys|people|folks|all|company|team|deepwell|exactly|really))|what is your name|whats your name)\b/.test(n);
}

export function detectHumanRequest(text) {
  const n = norm(text);
  return /\b(?:human|real person|live person|live agent|live chat|actual person|someone real|a person|customer service|customer support rep|representative|agent|operator)\b/.test(n)
    && /\b(?:talk|speak|chat|connect|transfer|get|reach|need|want|let|can i|could i|put me|escalate|contact|call|pass|hand|send)\b/.test(n)
    || /\b(?:talk|speak) to (?:someone|somebody|a person|support|a human|an agent|the team|your team|sales)\b/.test(n)
    || /\b(?:talk|speak|escalate) to (?:a |the |your )?(?:manager|supervisor)\b/.test(n)
    || /\b(?:human|person|agent|representative) (?:please|pls)\b/.test(n)
    || /\b(?:escalate|hand ?off|hand this over|pass (?:this|it) (?:on|to)|send (?:this|it) to (?:a person|the team|support))\b/.test(n);
}

/** Words that mean a person, not a bot, should see this. Returns a reason or null. */
export function detectHandoffTrigger(text) {
  const n = norm(text);
  if (/\b(?:refund|chargeback|charge back|dispute (?:a |the |this )?charge|double charged|charged twice|overcharged|billed in error|money back)\b/.test(n)) return 'refund';
  if (/\b(?:cancel(?:l?ing)?|cancellation|terminate)\b.*\b(?:subscription|account|plan|membership|service|contract)\b|\bcancel my\b/.test(n)) return 'cancel';
  if (/\b(?:breach|breached|hacked|hack|compromised|security incident|vulnerability|data leak|leaked)\b/.test(n)) return 'security';
  if (/\b(?:delete|erase|wipe|remove) (?:all )?(?:of )?(?:my|our|the)(?: shops?| account| company)? (?:data|account|records|information)\b|\bright to be forgotten\b|\bgdpr\b/.test(n)) return 'delete-data';
  if (/\b(?:legal|lawyer|attorney|lawsuit|sue|subpoena|compliance officer|dpa|data processing agreement|contract review|liability)\b/.test(n)) return 'legal';
  if (/\b(?:outage|is deepwell down|is the site down|site is down|system is down|service is down|everything is down|nothing is working|cant access anything)\b/.test(n)) return 'urgent';
  if (/\b(?:complaint|complain|unacceptable|furious|angry|terrible service|worst)\b/.test(n)) return 'complaint';
  return null;
}

/* ------------------------------------------------------------------ scope routing */

const BRANDS = 'trane|carrier|goodman|lennox|rheem|ruud|york|daikin|mitsubishi|bryant|amana|american standard|heil|tempstar|payne|fujitsu|lg|nest|honeywell|coleman|luxaire|comfortmaker|armstrong|aire ?flo|fraser johnston|maytag|frigidaire|bosch|navien|rinnai|a\\.? ?o\\.? smith|bradford white|state water|kohler|generac';
const PRODUCT_CUE = /\b(?:deepwell|donovan|can it|does it|can you|do you|will it|is there a way|does the app|can the app|your (?:app|software|system|platform))\b/i;

/** High-precision "this is about ONE customer's own record" signals. Evaluated before the FAQ. */
export function detectRecordsStrong(text) {
  const s = String(text ?? '');
  if (/\b\d{2,6}\s+(?:[NSEW]\.?\s+)?(?:[A-Za-z]+|\d+(?:st|nd|rd|th))(?:\s+[A-Za-z]+)?\s+(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|way|ct|court|cir|circle|pl|place|pkwy|parkway|hwy)\b/i.test(s)) return 'address';
  if (/\b(?:serial|s\/n|sn|model)\s*(?:number|no\.?|#)?\s*[:#]?\s*[A-Z0-9]{2,}[- ]?\d{4,}[A-Z0-9-]*/i.test(s) && !/\bhow (?:do|can|to)\b.*\b(?:enter|read|scan|find)\b/i.test(s)) return 'serial';
  if (/\b[A-Z]{0,3}\d[A-Z0-9]{2,}-\d{4,}[A-Z0-9-]*\b/.test(s)) return 'serial';
  if (!PRODUCT_CUE.test(s)) {
    const NOT_NAME = /^(?:Records Rescue|Home Screen|App Store|Google Play|Sterling Chapman|Hilton Chapman|Air Force|Support Access|Web App|Fleet Plan|Solo Plan|Shop Plan|Crew Plan|Ask Donovan|Sign In|Log In|Needs Info)$/i;
    const names = [...s.matchAll(/\b([A-Z][a-z]{1,15} [A-Z][a-z]{1,18})\b/g)].map((m) => m[1]).filter((n) => !NOT_NAME.test(n));
    if (names.length && /\b(?:warranty|furnace|a\/?c|ac unit|air conditioner|heat pump|water heater|condenser|compressor|thermostat|invoice|installed|serviced|service history|equipment|unit)\b/i.test(s) && !/\bhow (?:do|can|to)\b/i.test(s)) return 'named-customer';
  }
  if (new RegExp(`\\b(?:${BRANDS})\\b`, 'i').test(s) && /\b(?:installed|install date|when was|serviced|last service|serial|under warranty|warranty (?:status|expires?|ends?|left)|model number|who installed|who serviced|filter|refrigerant)\b/i.test(s) && !PRODUCT_CUE.test(s) && !/\b(?:nameplate|read|scan)\b/i.test(s)) return 'brand-lookup';
  return null;
}

/** Looser "asks about their own data" signals. Evaluated only AFTER the FAQ has missed. */
export function detectRecordsWeak(text) {
  const n = norm(text);
  // R34: "how do I find a document from last year?" is a how-to about the app, not a question about the records themselves
  if (/^(?:how (?:do|can|could|would|should) (?:i|we)|how to|where (?:do|can|could) (?:i|we)|is there a way to)\b/.test(n)) return null;
  if (/\b(?:when did we|when was (?:the|that|this)|who was (?:out|at|the tech)|what did [a-z]+ do|which (?:customers|clients|units|techs|technicians|jobs|invoices|work orders)|how many (?:customers|clients|units|jobs|work orders|installs|service calls)|list (?:all )?(?:my|our|the) (?:customers|units|jobs|invoices)|show me (?:the |all )?(?:customers|units|jobs|invoices|work orders)|last (?:service|visit|install)|is (?:the|this|that) .{1,40}(?:still )?under warranty|warranty (?:status|expir\w*) (?:for|on|of)|units? (?:expiring|installed)|who owes|unpaid invoices|outstanding invoices|find (?:me )?(?:the |a )?(?:customer|invoice|work order|document))\b/.test(n)) return 'weak';
  return null;
}

// Integration targets the KB itself discusses (QuickBooks, Dropbox ...): only a real comparison cue makes them a "comparison".
const INTEGRATION_TARGETS = 'quickbooks|xero|salesforce|hubspot|dropbox|google drive|google docs|google workspace|onedrive|sharepoint|microsoft 365|office 365|zapier';
// Products DeepWell is sometimes compared with: any mention next to a price / quality / comparison cue is declined.
const RIVALS = 'servicetitan|service titan|housecall ?pro|housecall|jobber|fieldedge|field edge|buildops|service fusion|workiz|fieldpulse|simpro|jobnimbus|successware|procore|evernote|notion|airtable|docuware|laserfiche|m-?files|zoho|adobe|acrobat|paperless(?:-?ngx)?|smartsheet|asana|monday\\.com|egnyte|nanonets|rossum|docsumo|abbyy|chatgpt|openai|copilot|gemini|perplexity|grok|deepseek|mistral|llama|bard|box\\.com';
const COMPETITORS = new RegExp(`\\b(?:${INTEGRATION_TARGETS}|${RIVALS})\\b`, 'i');
const RIVAL_RE = new RegExp(`\\b(?:${RIVALS})\\b`, 'i');
const COMPARISON_CUE = /\b(?:vs\.?|versus|compare[sd]?|comparison|compared to|better than|cheaper than|worse than|alternative|alternatives|instead of|switch(?:ing)? from|replace|competitor|competitors|beat|like servicetitan|similar to|difference between|stack up|rival|rivals)\b|\b(?:pick|choose|select|prefer|use|buy|go with|get) (?:you|deepwell|yours|your)[^.?]{0,10}\bover\b/i;
const RIVAL_CUE = /\b(?:cost|costs|price|prices|pricing|charge|charges|how much|review|reviews|worth|wrong with|better|best|worse|worst|good|bad|or|than|against|differ\w*|unlike|over|instead|switch\w*|migrat\w*|moving from|coming from|leave|leaving)\b/i;
const INTEGRATION_CUE = /\b(?:integrat\w*|connect\w*|sync\w*|import\w*|export\w*|work(?:s)? with|plug ?in|api|hook(?:s)? up|link(?:ed)? to)\b/i;

export function detectCompetitorComparison(text) {
  const s = String(text ?? '');
  const generic = /\b(?:competitors?|competition|other (?:software|products|platforms|vendors|companies|tools|apps)|market leaders?)\b/i.test(s) && COMPARISON_CUE.test(s);
  if (generic) return true;
  if (COMPETITORS.test(s) && COMPARISON_CUE.test(s)) return true;
  // "tell me what ServiceTitan charges", "is Notion worth it": a rival named next to a price/quality cue, unless it is about connecting to it
  if (RIVAL_RE.test(s) && RIVAL_CUE.test(s) && !INTEGRATION_CUE.test(s) && !/\b(?:does|do|is|was) (?:donovan|deepwell|it|this)\b[^.?]{0,25}\b(?:use|using|built|powered|made)\b/i.test(s)) return true;
  return false;
}

const HVAC_ACTION = '(?:fix|repair|replace|install|charge|wire|diagnose|troubleshoot|recharge|clean|size|sizing|service|test|measure|calculate|braze|solder|evacuate|flush|reset|bypass|jump|set up|adjust)';
const TRADE_NOUN = '(?:ac|a/c|air conditioner|air conditioning|furnace|condenser|compressor|capacitor|contactor|thermostat|heat pump|air handler|evaporator|coil|blower|refrigerant|freon|ductwork|duct|hvac|water heater|boiler|pipe|drain|faucet|toilet|breaker|panel|outlet|wiring|circuit|generator|mini split|minisplit|heat exchanger|igniter|flame sensor|pressure switch|txv|filter drier|manifold gauges?|superheat|subcooling)';

export function detectTradeHowTo(text) {
  const n = norm(text);
  if (new RegExp(`\\b${HVAC_ACTION}\\b[^.]{0,40}\\b${TRADE_NOUN}\\b`).test(n)) return true;
  if (/\bwhat size (?:ac|furnace|unit|heat pump|air conditioner|breaker|wire|condenser)\b|\b(?:r ?410a?|r ?22|r ?32|r ?454b?) (?:charge|pressure|refrigerant|subcool|superheat)|\bmanual [jsd]\b|\bbtu(?:s)? (?:per|for|calculation|needed)|\berror code\b|\bwhy is my (?:ac|furnace|heat pump|thermostat|water heater)\b|\bmy (?:ac|furnace|heat pump|water heater|thermostat) (?:is|wont|isnt|keeps|stopped)/.test(n)) return true;
  return false;
}

// R34: split in two. HARD words are off-topic wherever they appear. SOFT words are also business types a pre-sales visitor may name
// ("will it work for my medical clinic / restaurant / church"): they only count when the message has no DeepWell cue.
const OFF_TOPIC_HARD_RE = /\b(?:poem|poetry|haiku|limerick|song lyrics|lyrics|joke|jokes|riddle|story about|write (?:me )?(?:a |an )?(?:essay|story|poem|song|email to my|cover letter|resume|script|blog|tweet|speech)|(?:draft|write|compose|generate) (?:me )?(?:a|an|my|the|our) (?:lease|contract|agreement|nda|will|letter|policy|proposal|report|email|memo|essay|resume|cv|ad|post|bio)|recipe|bake|weather|forecast|temperature outside|stock price|stocks?|lottery|horoscope|astrology|tv show|netflix|score of|who won|election|senator|congress|politic\w*|democrat|republican|trump|biden|war in|ukraine|gaza|bible|diagnos(?:e|is) (?:my|me)|ibuprofen|aspirin|tylenol|advil|antibiotics?|dosage|pregnan\w*|chest pain|headache|rash|fever|blood pressure|covid|vaccine|bankruptcy|divorce|custody|probate|eviction|immigration|visa application|is it (?:legal|illegal)|legal to|lawsuit advice|tax advice|legal advice|homework|math problem|solve|equation|calculate|integral|derivative|translate|translation|in spanish|in french|python|javascript|typescript|java|c\+\+|golang|rust code|sql query|regex|write (?:a )?(?:function|code|program|script|class)|debug (?:my|this) code|html|css|react|capital of|population of|how tall|how far|how old is|who is the (?:ceo|owner|founder|president) of (?!deepwell)|tell me about (?:yourself|the world)|meaning of life|what is 2|whats \d+ ?[+*/x-] ?\d+|\d+ ?[+*/x-] ?\d+ ?=|convert \d|calories|relationship advice|plan (?:a|an|my) (?:\d+[- ]day )?(?:trip|vacation|holiday|wedding|party|menu|route|itinerary|meal)|itinerary|what time is it|time in [A-Z][a-z]+|(?:my|your) ip address|what ip am i|minecraft|fortnite|taylor swift|elon musk|apple stock|tesla|bitcoin|crypto|ethereum|lottery)\b/i;
const OFF_TOPIC_SOFT_RE = /\b(?:cook|invest(?:ing|ment)?|movie|film|sports?|nfl|nba|mlb|football|basketball|baseball|soccer|president|religion|god|medical|symptom|medication|prescription|doctor|therapy|depress\w*|dating|travel|flight|hotel|restaurant|pizza|coffee|video game)\b/i;
const DW_CUE_RE = /\b(?:deepwell|donovan|your (?:app|software|platform|product|service|pricing|plans?)|(?:this|the) (?:app|software|platform|product|tool)|upload\w*|scan\w*|(?:my|our) (?:documents?|paperwork|files|records|invoices|contracts|business|company|practice|firm|office|clinic|restaurant|church|school|shop|store)|for (?:my|our) (?:business|company|practice|firm|office|clinic|restaurant|church|school|shop|store))\b/i;

export function detectOffTopic(text) {
  const s = String(text ?? '');
  if (OFF_TOPIC_HARD_RE.test(s)) return true;
  return OFF_TOPIC_SOFT_RE.test(s) && !DW_CUE_RE.test(s);
}

/** R34: "does it work for my dental practice / law firm / church?" - a pre-sales fit question, not an off-topic one. */
const FIT_VERB = /\b(?:work|works|fit|fits|suit|suits|support|supports|handle|handles|help|helps|good for|right for|made for|built for|designed for|for (?:a|an|my|our)|use (?:it|this|deepwell) (?:for|in|at)|can i use|could we use|can we use|do you (?:work|serve|have))\b/i;
const BIZ_NOUN = /\b(?:clinic|medical|dental|dentist|doctor'?s office|practice|law (?:firm|office)|attorneys?|lawyers?|legal|accountants?|accounting|cpa|bookkeep\w*|restaurants?|cafe|bar|hotel|motel|school|district|church|nonprofit|non-profit|charity|ngo|real estate|realtors?|brokerage|property manage\w*|landlords?|insurance|agency|contractors?|construction|builders?|roofing|landscap\w*|plumb\w*|electric\w*|painters?|cleaning|janitorial|salon|spa|gym|fitness|farm|ranch|trucking|logistics|freight|warehouse|manufactur\w*|factory|retail|store|boutique|auto|mechanic|garage|dealership|vet|veterinar\w*|pharmacy|hospital|nursing|daycare|studio|photograph\w*|architects?|engineers?|surveyors?|government|municipal|city|county|hoa|condo|apartments?|moving|storage|travel agency|funeral|tutoring|training)\b/i;
export function detectIndustryFit(text) {
  const s = String(text ?? '');
  if (!BIZ_NOUN.test(s) || !FIT_VERB.test(s)) return null;
  if (/\b(?:electric\w*|plumb\w*|property manage\w*)\b/i.test(s)) return 'other-trades';
  return /\b(?:patients?|hipaa|phi|privileged|attorney-client|client files|medical records)\b/i.test(s) ? 'regulated' : 'fit';
}

/** R34: price haggling, free-period asks and "confirm that I get ..." attempts. Evaluated only after the FAQ has missed. */
export function detectNegotiation(text) {
  const n = norm(text);
  return /\b(?:discounts?|coupons?|promo(?:tion)?(?: code)?s?|voucher|half price|\d{1,3}% off|percent off|waive|waiver|price match|match (?:my|the|their|that) price|lowest price|best price|special (?:price|pricing|rate|deal)|negotiat\w*|haggle|cheaper deal|lifetime (?:free|access|deal)|free (?:year|month|months|plan|upgrade|forever)|for free|set my price|price to zero|at \$?\d+ (?:per|a|\/) (?:user|month|mo)|extend(?:ed|ing)? (?:my|the) trial|extra trial|second trial|free access|comp(?:ed)? (?:me|my|account)|on the house|deal\b|(?:get|have|want|keep) (?:it|this|that|the (?:plan|app|software|service)) (?:for )?free|(?:owner|ceo|founder|sterling|hilton) (?:personally|told me|said)|he said i get|she said i get)/.test(n)
    || /\b(?:give|get|can i have|can you give) me\b[^.?]{0,30}\b(?:free|off|discount|credit)\b/.test(n)
    || /\b(?:approved|authori[sz]ed|okayed|signed off on|promised|offered)\b[^.?]{0,40}\b(?:apply|honou?r|do it|give (?:it|me)|go ahead)\b|\b(?:apply|honou?r) (?:it|that|the (?:discount|deal|offer|code))\b/.test(n);
}

/** R34: promises, guarantees, SLAs, liability and legal opinions, or the roadmap. Evaluated only after the FAQ has missed. */
export function detectCommitment(text) {
  const n = norm(text);
  return /\b(?:guarantee[sd]?|promise[sd]?|commit(?:ment)? to|put (?:it )?in writing|in writing|sla|service level|uptime|liab(?:le|ility)|indemni\w*|baa|business associate|warrant(?:y|ies|s)? that|compensat\w*|damages|breach of contract|legally (?:binding|required|obligated)|contractual|roadmap|road map|what are you building|what features are (?:you|coming)|launching next|next (?:year|quarter)|will you (?:sign|add|build|release|ship)|when (?:will|exactly will|is) .{0,40}(?:release|launch|ready|live|available|ship)|do you (?:promise|swear)|24 ?\/ ?7)\b/.test(n)
    || /\b(?:confirm|agree|say|type|state|acknowledge|admit)\b[^.?]{0,30}\b(?:i get|i owe|i am owed|i have been|my (?:price|discount|refund|free|trial is|account is)|approved|you agree)\b|\bowe nothing\b|\bextended by\b|\bpromise me\b|\bguarantee me\b/.test(n);
}

const PERSON_CUE = '(?:sterling(?:s)?|hilton(?:s)?|chapman(?:s)?|the founders?|founders?|your founders?|the ceo|your ceo|the owners?|your owners?|your (?:staff|employees|engineers|developers|team members|support team|support staff)|support (?:team|staff|agents?)|who works)';
/** R34: private details about the people at DeepWell, DeepWell's internal business, secrets, or other tenants. Returns a kind or null. Evaluated BEFORE the FAQ. */
export function detectConfidential(text) {
  const n = norm(text);
  const raw = String(text ?? '');
  // env-var style names ("SUPPORT_ANTHROPIC_API_KEY", "CLAUDE_API_KEY") and vendor secrets ("the Resend API key", "your Clerk secret")
  if (/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,}\b/.test(raw) && /\b(?:key|secret|token|password|env|variable|value|what is|show|give)\b/i.test(raw)) return 'secrets';
  if (/\b(?:clerk|stripe|resend|neon|vercel|anthropic|claude|openai|aws|amazon|supabase|postgres|neon\.tech)\b[^.?!]{0,30}\b(?:api keys?|keys?|secrets?|passwords?|tokens?|credentials?|connection strings?)\b/.test(n)
    || /\b(?:database|db|server|production|prod|internal|ssh|smtp)\b[^.?!]{0,20}\b(?:passwords?|credentials?|connection strings?|secrets?|api keys?|keys?)\b/.test(n)
    || /\b(?:what(?:s| is)|give me|show me|tell me|reveal|share|send me|dump|leak|print) (?:the |your |deepwells? |our )?(?:internal |vendor |production |master |root |secret |private )?(?:api keys?|secrets?|credentials|connection strings?|env(?:ironment)? (?:vars?|variables?)|admin (?:password|login|panel|url))\b/.test(n)
    || /\byour (?:api keys?|secrets?|passwords?|tokens?|credentials)\b|\bwhat (?:api )?keys? (?:do|does) (?:you|deepwell) use\b|\b(?:vercel|neon|clerk|stripe|resend|anthropic|aws)\b[^.?!]{0,30}\b(?:project|org|team|account|dashboard) (?:id|url|link)\b/.test(n)
    || /\b(?:what|which) (?:ip|ports?|ips)\b[^.?]{0,25}\b(?:servers?|you|your)\b|\bfirewall (?:config|rules|configuration)\b|\bbypass (?:your|the) (?:login|auth\w*|rate ?limit\w*|security|paywall)\b|\brate limit bypass\b|\bhow (?:can|do) i (?:hack|break into|exploit|bypass)\b/.test(n)
    || /\b(?:reset|change|get|give me) the password (?:for|of) (?:admin|root|support|ceo|sterling|hilton)\b|\badmin@deepwelltechnology\b/.test(n)) return 'secrets';
  if (new RegExp(`\\b${PERSON_CUE}\\b[^.?!]{0,40}\\b(?:home|address|phone|cell|mobile|personal|private|email|age|old|birthday|birth ?date|salary|earns?|paid|pay|net worth|wife|husband|spouse|married|girlfriend|boyfriend|kids?|children|daughter|son|family|lives?|living|school|college|degree|ssn|social security|religion|politics)\\b`).test(n)
    || new RegExp(`\\b(?:where|how old|how much)\\b[^.?!]{0,25}\\b${PERSON_CUE}\\b[^.?!]{0,15}\\b(?:live|lives|earn|earns|paid|born|school|old|work from)\\b`).test(n)
    || new RegExp(`\\b(?:home address|personal (?:email|phone|cell|number|address)|cell(?:phone)? number|mobile number)\\b[^.?!]{0,25}\\b${PERSON_CUE}\\b`).test(n)
    || new RegExp(`\\bhow old (?:is|are|was)\\b[^.?!]{0,10}\\b${PERSON_CUE}\\b|\\b${PERSON_CUE}'?s? age\\b`).test(n)
    || /\b(?:sterling|hilton|ceo|founders?)'?s? (?:home|personal|private|cell|mobile|phone|salary|wife|husband|kids|family|age|birthday|net worth)\b/.test(n)
    || /\bwho(?:s| is| are)? (?:on|in|part of) (?:your|the) (?:support )?(?:team|staff)\b|\b(?:names?|list) of (?:your|the) (?:engineers|staff|employees|developers|support (?:team|staff|agents?))\b|\bwho works (?:at|for) deepwell\b/.test(n)) return 'personal';
  if (/\b(?:your|deepwells?|the company'?s)\s+(?:revenue|profits?|margins?|funding|valuation|headcount|payroll|investors?|burn|runway|cloud bill|aws bill|customer (?:list|count)|monthly revenue|arr|mrr)\b/.test(n)
    || /\bhow (?:much|many) (?:money|funding|revenue|profit)\b[^.?]{0,25}\b(?:you|deepwell|company|raised|make|made|earn)\b/.test(n)
    || /\bhow much (?:does|do) (?:it|donovan|this|that|deepwell|the ai|the model)\b[^.?]{0,15}\bcost (?:you|deepwell|them)\b|\bwhat do you pay\b|\bhow much (?:do|does) (?:you|deepwell) pay\b|\bwhat (?:are|is) (?:your|deepwells?) (?:margins?|profit)\b/.test(n)
    || /\bhow many (?:employees|engineers|staff|developers|customers|clients|users|shops|companies|people work)\b[^.?]{0,25}\b(?:do you have|does deepwell have|use deepwell|signed up|work(?:s)? (?:at|for) deepwell|are on deepwell|you have)\b/.test(n)
    || /\b(?:list|names?) of (?:all )?your (?:customers|clients|companies|shops|tenants|businesses)\b|\b(?:which|what|who) (?:companies|shops|customers|businesses|clients|tenants)\b[^.?]{0,30}\b(?:use|uses|using|are customers of|bought from|signed up|on) deepwell\b|\byour (?:biggest|largest|newest|top|best) customers?\b|\b(?:show|give|send|tell|let|get) me\b[^.?]{0,25}\b(?:other|another|someone else'?s?) (?:tenants?|shops?|companies|accounts?)'?s?\b[^.?]{0,25}\b(?:data|documents?|files?|records?|uploads?|conversations?|info|details|emails?)\b|\bwhat (?:other )?(?:customers|users|visitors|people) (?:asked|said|uploaded|typed|searched)\b|\btenant (?:org_|id)|\bwhat (?:did|do) (?:the )?(?:last|previous|other) (?:user|visitor|customer)s? (?:ask|say|type)|\b(?:last|previous) (?:user|visitor)\b|\b(?:most common|top) questions? (?:visitors|users|customers)\b|\bshow me tenant\b/.test(n)
    || /\bhow many (?:customers|clients|shops|companies|businesses|people|users|contractors) (?:use|uses|are using|are on|have signed up for|trust) (?:it|this|deepwell|you|the app)\b/.test(n)
    || /\b(?:email|phone|address|name) of (?:your|a|the) (?:newest|latest|biggest|first|best|top) (?:customer|client|user)\b/.test(n)
    || /\b(?:internal|backend|back end|admin) (?:tools?|systems?|dashboards?|panels?)\b|\bwhat (?:do|does) (?:you|the support team|your team|deepwell) use internally\b/.test(n)) return 'internal';
  return null;
}

const LEXICON_RE = /\b(?:deepwell|donovan|your (?:app|product|software|platform|service|company|team|pricing|plans?|website|site|support)|the (?:app|website|site|platform|dashboard|inbox)|this (?:app|product|software|service|platform|site)|(?:my|our) (?:account|plan|subscription|invoice|bill|login|logins|seats?|team|shop|trial|data|uploads?|scans?|documents?|password|billing|card)|pricing|price|prices|cost|costs|trial|subscription|billing|invoice|invoices|upload\w*|scan\w*|export\w*|seat|seats|logins?|sign ?in|log ?in|sign ?up|password|invite\w*|install\w*|home screen|phone app|mobile|records rescue|api|security|secure|privacy|private|data|support|human|person|refund|cancel\w*|contact|status page|soc ?2|encrypt\w*|sample|onboard\w*|set ?up|plan|plans|solo|crew|fleet|pages?|storage|documents?|files?|ocr|notification\w*|digest|outreach|warranty (?:alerts?|tracking|export)|integrat\w*|demo|sales|quote|discount|coupon|annual\w*|yearly|monthly|renew\w*|format\w*|cell|signal|offline|vendors?|plumb\w*|electric\w*|quickbooks|charged|image\w*|photos?|pdfs?|sync\w*|google drive|founders?|sterling|hilton|chapman|pay\w*|declin\w*|ipad|iphone|android|tablet|app|accura\w*|mistakes?|stored|hosted|delete\w*|download\w*|zip|manager|technician|techs?|admin|owner|member|role|team)\b/i;

export function hasDeepwellLexicon(text) {
  return LEXICON_RE.test(String(text ?? ''));
}

/** Account-lookup intents (need a signed-in tenant). */
export function detectAccountIntent(text) {
  const n = norm(text);
  if (/\b(?:how many|how much|what)\b[^?.]{0,30}\b(?:pages?|scans?|uploads?)\b[^?.]{0,40}\b(?:left|used|remaining|so far|this month|have i|did i|do i have|allowance|usage)\b|\b(?:pages?|scans?) (?:left|used|remaining)\b|\bmy (?:page )?usage\b|\bpage usage\b|\bhow close am i to (?:my |the )?(?:page |monthly |plan )?(?:limit|cap|allowance)\b|\bam i (?:close to|near|over|at) (?:my|the) (?:page|monthly)?\s*(?:limit|cap|allowance)\b/.test(n)) return 'usage';
  if (/\b(?:what|which) plan am i (?:on|using|paying)\b|\bmy (?:current )?plan\b|\bwhat(?:s| is) my plan\b|\bwhich plan do i have\b|\bhow many (?:logins?|seats|users|people)\b[^?.]{0,30}\b(?:do i have|can i have|am i allowed|does my plan|are (?:left|included)|left|in my plan)\b/.test(n)) return 'plan';
  if (/\b(?:when|what)\b[^?.]{0,40}\b(?:my )?(?:trial|plan|subscription)\b[^?.]{0,25}\b(?:end|ends|expire|expires|renew|renews|over|up)\b|\bwhen (?:is|will|does) (?:my |the )?next (?:billing|charge|payment|invoice|bill)\b|\bwhat(?:s| is) my (?:next )?(?:billing|renewal|payment) date\b|\bdays left (?:in|on) (?:my )?trial\b|\btrial (?:end|ends|ending|expire|left)\b|\bwhen (?:will|do) i (?:get )?(?:billed|charged)\b|\bmy (?:renewal|billing) date\b|\bwhen does my (?:trial|plan|subscription)\b/.test(n)) return 'billing';
  if (/\b(?:status|progress|where(?:s| is| are))\b[^?.]{0,30}\b(?:my )?(?:uploads?|documents?|scans?|files?)\b|\b(?:my )?(?:uploads?|scans?|documents?|files?)\b[^?.]{0,25}\b(?:stuck|status|done|finished|processing|pending|missing|not showing|didnt (?:go|show)|still)\b|\bdid my (?:uploads?|scans?|files?|documents?) (?:go through|finish|work|process|upload)\b|\bhow many (?:documents?|uploads?|files?|scans?)\b[^?.]{0,30}\b(?:processing|pending|need|stuck|waiting|flagged)\b|\bwhat needs (?:my )?(?:attention|review|info)\b|\bneeds? (?:info|review|attention)\b[^?.]{0,20}\b(?:how many|count|do i have)\b|\banything (?:stuck|waiting|flagged)\b/.test(n)) return 'uploads';
  return null;
}

/* ------------------------------------------------------------------ output validation */

const COMPETITOR_ANY = new RegExp(`\\b(?:${RIVALS}|salesforce|hubspot)\\b`, 'i');
const NEGATION = /\b(?:not|isn'?t|aren'?t|no|never|hasn'?t|haven'?t|can'?t|cannot|don'?t|doesn'?t|without|yet|unavailable|none|nor)\b/i;
const COMING_SOON_FEATURES = /\b(?:email intake|folder sync|google drive sync|drive sync|branch scoping|off-?site backups?|backups every 6 hours|per-shop restore|status page|uptime sla|99\.5%|callback analytics|electrical|plumbing|property management)\b/i;
const PROMISE_RES = [
  /\bwill (?:soon )?be (?:available|added|released|launched|rolled out|live|ready|shipped)\b/i,
  /\b(?:we|deepwell) (?:will|are going to|plan to|intend to|are planning to|are working on|are building) (?:add|release|launch|build|ship|offer|support|include|introduce|roll out)\b/i,
  /\bon (?:our|the) roadmap\b|\broadmap\b/i,
  /\b(?:launching|releasing|shipping|arriving|available) (?:in|by|next|this|early|late|mid)\b/i,
  /\bexpected (?:in|by|to (?:launch|ship|release))\b/i,
  /\b(?:by|in|before) (?:q[1-4]|the end of|next (?:month|quarter|year|week)|early|late|mid|january|february|march|april|may|june|july|august|september|october|november|december)\b[^.]{0,40}\b(?:available|launch|release|ship|live|ready|add)/i,
  /\b(?:we|i)(?:'ll| will) (?:refund|credit|waive|discount|comp|reimburse|give you (?:a )?(?:refund|credit|discount))\b/i,
  /\byou(?:'ll| will) (?:get|receive) (?:a |your )?(?:refund|credit|discount)\b/i,
  /\b(?:guarantee[sd]?|guaranteed)\b[^.]{0,30}\b(?:uptime|availability|response|resolution|accuracy|results)\b/i,
];

/** Distinctive multi-word windows of the system RULES text, so a reply that recites them can be caught. */
function shingles(text, n = 10) {
  const words = String(text ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const out = new Set();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(' '));
  return out;
}
export function makePromptShingles(rulesText) { return shingles(rulesText); }

function leaksPrompt(reply, promptShingles) {
  if (!promptShingles || promptShingles.size === 0) return false;
  for (const s of shingles(reply)) if (promptShingles.has(s)) return true;
  return false;
}

function isAllowedHost(host) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  return ALLOWED_LINK_HOSTS.includes(h);
}

/** Strip links and emails that are not ours, images and HTML. Returns the cleaned text. */
export function cleanLinksAndMarkup(text) {
  let t = String(text ?? '');
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/gi, '$1 ($2)');
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  t = t.replace(/\b(?:javascript|vbscript|data|file|ftp|blob|about):[^\s)]*/gi, '');
  t = t.replace(/<[^>]+>/g, '');
  t = t.replace(/https?:\/\/[^\s)<>\]"']+/gi, (url) => {
    try {
      const u = new URL(url.replace(/[.,;:!?]+$/, ''));
      if (u.protocol === 'https:' && isAllowedHost(u.hostname) && !u.username && !u.password) return url;
    } catch { /* fall through */ }
    return '';
  });
  t = t.replace(/\bmailto:([^\s)]+)/gi, (m, addr) => (CONTACT_EMAILS.includes(String(addr).toLowerCase()) ? m : ''));
  t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (email) => (CONTACT_EMAILS.includes(email.toLowerCase()) ? email : ''));
  t = t.replace(/^#{1,6}\s+/gm, '').replace(/[ \t]+\n/g, '\n').replace(/\(\s*\)/g, '').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

const STREET_RE = /\b\d{2,6}\s+(?:[NSEW]\.?\s+)?(?:[A-Za-z]+|\d+(?:st|nd|rd|th))(?:\s+[A-Za-z]+)?\s+(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|way|ct|court|cir|circle|pl|place|pkwy|parkway|hwy)\b/i;
const SERIAL_RES = [/\b[A-Z]{0,3}\d[A-Z0-9]{2,}-\d{4,}[A-Z0-9-]*\b/, /\b(?:serial|s\/n|model)\s*(?:number|no\.?|#)?\s*[:#]?\s*[A-Z0-9]{2,}[- ]?\d{4,}[A-Z0-9-]*/i, /\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{9,}\b/];
const FILENAME_RE = /\b[\w-]+\.(?:pdf|jpe?g|png|tiff?|heic|docx?|xlsx?|csv|zip|txt)\b/i;
const COMPANY_RE = /\b[A-Z][\w&'.-]+(?: [A-Z][\w&'.-]+){0,3} (?:LLC|L\.L\.C\.|Inc\.?|Corp\.?|Co\.|Company|Heating|Cooling|Air|HVAC|Plumbing|Mechanical|Services|Contractors|Refrigeration|Electric|Enterprises|Properties)\b/;

/** Capitalized words the KB itself uses. A capitalized PAIR of words that are not both in this set looks like a name. */
export function capWords(text) {
  return new Set([...String(text ?? '').matchAll(/\b[A-Z][a-z]{1,20}\b/g)].map((m) => m[0]));
}

/** Returns a short reason string when the text looks like it contains someone's data, else null. */
export function detectDataLeak(text, knownCapWords = null) {
  const t = String(text ?? '');
  for (const m of t.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) if (!/@deepwelltechnology\.com$/i.test(m[0])) return 'foreign-email';
  if (STREET_RE.test(t)) return 'street-address';
  if (SERIAL_RES.some((re) => re.test(t))) return 'serial-like';
  if (FILENAME_RE.test(t.replace(/\b(?:deepwelltechnology)\.com\b/gi, ''))) return 'filename';
  if (COMPANY_RE.test(t.replace(/\bDeepWell(?: Technology)?(?: (?:Inc|LLC)\.?)?/g, 'DeepWell'))) return 'company-name';
  if (knownCapWords) {
    for (const m of t.matchAll(/\b([A-Z][a-z]{1,20}) ([A-Z][a-z]{1,20})\b/g)) {
      if (!knownCapWords.has(m[1]) || !knownCapWords.has(m[2])) return 'unknown-name';
    }
  }
  return null;
}


const REPLY_MONTHS = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const NUM_WORD = '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million)';
const VENDOR_RE = /\b(?:aws|amazon|rds|ec2|azure|gcp|google cloud|cloudflare|heroku|digitalocean|supabase|firebase|mongodb|redis|kubernetes|docker|datadog|snowflake|twilio|sendgrid|mailgun|postmark|intercom|zendesk|hubspot|segment|mixpanel|fly\.io|render\.com|netlify|linode|oracle|ibm|openai|cohere)\b/gi;

/**
 * R34 extra output screens (found by the break-it round): invented discounts and free periods, claims that an action was taken, time-to-respond
 * promises, legal commitments, invented infrastructure, internal business figures, persona adoption and requests for secrets.
 * A phrase that the knowledge base itself contains is allowed; a negated one ("there is no discount code") is allowed.
 */
export function extraReplyChecks(text, ctx = {}) {
  const t = String(text ?? '');
  const kb = String(ctx.kbText ?? '').toLowerCase();
  const inKb = (phrase) => kb.includes(String(phrase).toLowerCase().replace(/\s+/g, ' ').trim());
  const sentences = t.replace(/(\d)\.(\d)/g, '$1_$2').split(/(?<=[.!?\n])\s+/);
  for (const sent of sentences) {
    const neg = NEGATION.test(sent);
    for (const m of sent.matchAll(/(\d{1,3}(?:_\d+)?)\s?%/g)) { if (!inKb(`${m[1].replace('_', '.')}%`) && !inKb(`${m[1].replace('_', '.')} %`)) return 'percent'; }
    if (/\b(?:discount|coupon|promo(?:tion(?:al)?)? code|voucher|referral code|special offer|half price|price match)\b/i.test(sent) && !neg && !/\b(?:annual|yearly)\b/i.test(sent) && !inKb((sent.match(/\b(?:discount|coupon|promo(?:tion(?:al)?)? code|voucher|referral code|special offer|half price|price match)\b/i) ?? [''])[0])) return 'discount';
    if (/\b(?:\d+|one|two|three|four|six|twelve|a)[- ](?:months?|years?|weeks?)\b[^.\n]{0,12}\bfree\b|\bfree (?:for )?(?:\d+|one|two|three|six|twelve|a) (?:months?|years?|weeks?)\b|\bfree (?:month|year|plan|upgrade|extension|credits?|forever)\b|\blifetime (?:access|free|deal|license)\b/i.test(sent) && !neg) {
      const ph = (sent.match(/\b(?:\d+|one|two|three|four|six|twelve|a)[- ](?:months?|years?|weeks?)\b[^.\n]{0,12}\bfree\b|\bfree (?:for )?(?:\d+|one|two|three|six|twelve|a) (?:months?|years?|weeks?)\b|\bfree (?:month|year|plan|upgrade|extension|credits?|forever)\b|\blifetime (?:access|free|deal|license)\b/i) ?? [''])[0];
      if (!inKb(ph)) return 'free-period';
    }
    if (/\b(?:i(?:'ve| have)|we(?:'ve| have)|has been|have been|is now|are now|was just)\s+(?:now\s+)?(?:applied|upgraded|downgraded|cancel+ed|refunded|credited|changed|updated|reset|deleted|removed|added|processed|issued|extended|waived|approved|granted|activated|enabled|disabled|sent|escalated|submitted|created|closed)\b/i.test(sent) && !neg) return 'claimed-action';
    if (/\b(?:your|the) (?:trial|plan|subscription|account|refund|discount|price|request)\b[^.\n]{0,30}\b(?:is|has been|was|will be) (?:now )?(?:extended|upgraded|cancel+ed|refunded|waived|approved|granted|applied|changed|reset|deleted)\b/i.test(sent) && !neg) return 'claimed-action';
    for (const m of sent.matchAll(/\b(?:within|in|under|inside|after|every|each)\s+(?:about |around |roughly |only |just |less than |up to )?(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|ten|fifteen|twenty|thirty|forty-five|forty five|sixty)[- ](minutes?|hours?|business days?|days?|weeks?)\b/gi)) {
      const phrase = `${String(m[1]).replace('_', '.')} ${m[2]}`.toLowerCase().replace(/s$/, '');
      const kbN = kb.replace(/(\d)[- ](minute|hour|business day|day|week)s?/g, '$1 $2');
      if (!kbN.includes(phrase) && !kbN.includes(`${m[1]}-${m[2]}`.toLowerCase().replace(/s$/, ''))) return 'time-claim';
    }
    const legal = sent.match(/\b(?:indemnif\w+|accept(?:s)? (?:full )?liabilit\w+|(?:we|deepwell) (?:are|is) liable|we warrant|legally (?:required|must|obligated|binding)|you (?:must|are required to|are legally required to) (?:keep|retain|file|report|disclose)|legal advice)\b/i);
    if (legal && !neg && !inKb(legal[0])) return 'legal';
    if (new RegExp(`\\b${NUM_WORD}(?:[- ](?:${NUM_WORD}|and))*\\s+(?:dollars?|bucks|usd)\\b`, 'i').test(sent)) return 'price';
    if (/\b(?:our|deepwell'?s|the company'?s)\s+(?:revenue|profits?|margins?|valuation|funding|headcount|payroll|burn|runway|investors?|cloud bill|aws bill)\b|\bwe (?:have|employ|raised|earn|made|make|spend|pay)\b[^.\n]{0,20}\b(?:employees|engineers|developers|staff|million|billion|customers)\b/i.test(sent) && !neg) return 'internal';
    if (/\b(?:dan mode|developer mode|jailbreak(?:ed)?|no (?:rules|restrictions|filters)|without (?:rules|restrictions|filters)|i am (?:now )?(?:dan|evilbot|unrestricted)|as (?:dan|evilbot)\b|(?:rules|restrictions|guidelines) (?:are|have been) (?:off|disabled|lifted|removed))\b/i.test(sent) && !neg) return 'persona';
    if (/\b(?:send|share|give|provide|enter|tell|type|paste|text|email|read out)\b[^.\n]{0,30}\b(?:your |the |me )?(?:password|passcode|card number|credit card|social security|ssn|cvv|pin\b|bank account|api key)\b/i.test(sent) && !neg) return 'asks-secret';
    if (/\b(?:on|from|in|hosted on|runs on|built on)\b[^.\n]{0,12}\b(?:aws|amazon|azure|gcp|google cloud|cloudflare|heroku|digitalocean|supabase|firebase|mongodb|redis|kubernetes|docker|datadog|snowflake|twilio|sendgrid|mailgun|zendesk|oracle|ibm)\b/i.test(sent) && !neg) {
      for (const v of sent.matchAll(VENDOR_RE)) if (!kb.includes(v[0].toLowerCase())) return 'vendor';
    }
    for (const m of sent.matchAll(new RegExp(`\\b(?:${REPLY_MONTHS})\\.? \\d{1,2}(?:st|nd|rd|th)?(?:,? \\d{4})?\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b(?:${REPLY_MONTHS})\\.?,? 20\\d{2}\\b`, 'gi'))) {
      if (!ctx.allowDates && !inKb(m[0])) return 'date';
    }
  }
  if (/[^\x00-\x7f]/.test(t)) {
    // a look-alike letter next to an @ or inside a URL host: "support@deepwelltechnοlogy.com"
    if (/[^\s@]*[^\x00-\x7f][^\s@]*@|@[^\s]*[^\x00-\x7f]|https?:\/\/[^\s/]*[^\x00-\x7f]/i.test(t)) return 'lookalike-address';
  }
  return null;
}

/**
 * Validate + clean one model reply. Returns {ok:true, text} or {ok:false, reason}. A failed reply is NEVER
 * shown: the caller substitutes the canned fallback.
 * @param {string} raw
 * @param {{allowedAmounts: string[], promptShingles?: Set<string>}} ctx
 */
export function validateModelReply(raw, ctx = {}) {
  if (typeof raw !== 'string') return { ok: false, reason: 'not-text' };
  // R34: bidi / zero-width characters can hide an address inside an otherwise allowed one ("support@deepwell<ZWSP>technology.com")
  let text = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '').trim();
  if (!text) return { ok: false, reason: 'empty' };
  if (text.length > LIMITS.maxReplyChars) return { ok: false, reason: 'too-long' };
  if (text.includes(CANARY) || /dw-canary/i.test(text)) return { ok: false, reason: 'canary' };
  if (leaksPrompt(text, ctx.promptShingles)) return { ok: false, reason: 'prompt-leak' };
  if (/<\/?\s*(?:knowledge|system|user_message|account_context|instructions?)\b|\barticle_id\b/i.test(text)) return { ok: false, reason: 'prompt-markup' };
  if (COMPETITOR_ANY.test(text)) return { ok: false, reason: 'competitor' };

  const allowed = new Set(ctx.allowedAmounts ?? []);
  for (const m of text.matchAll(/\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/g)) {
    if (!allowed.has(m[1])) return { ok: false, reason: 'price' };
  }
  for (const m of text.matchAll(/(?<![$\d,.])(\d{2,5}(?:,\d{3})?)\s*(?:usd|dollars)\b|(?<![$\d,.])(\d{2,4})\s*(?:\/|per|a)\s*(?:mo|month|yr|year)\b/gi)) {
    const v = (m[1] ?? m[2]).replace(/,/g, '');
    if (!allowed.has(v) && !allowed.has(Number(v).toLocaleString('en-US'))) return { ok: false, reason: 'price' };
  }

  const extra = extraReplyChecks(text, ctx);
  if (extra) return { ok: false, reason: extra };

  const sentences = text.replace(/(\d)\.(\d)/g, '$1_$2').split(/(?<=[.!?\n])\s+/);
  for (const s of sentences) {
    for (const re of PROMISE_RES) if (re.test(s)) return { ok: false, reason: 'promise' };
    if (/coming soon/i.test(s) && !NEGATION.test(s) && !/\bmarked\b|\blisted\b/i.test(s)) return { ok: false, reason: 'promise' };
    if (COMING_SOON_FEATURES.test(s) && /\b(?:includes?|has|offers?|supports?|provides?|comes with|available (?:now|today))\b/i.test(s) && !NEGATION.test(s) && !/coming soon|marked|listed|waitlist/i.test(s)) return { ok: false, reason: 'promise' };
    if (/\bsoc ?2|iso ?27001|hipaa|pci(?:-| )dss|fedramp\b/i.test(s) && !NEGATION.test(s)) return { ok: false, reason: 'certification' };
  }

  // Leak screens: the bot never holds customer data, so any of these in a reply means it is echoing user input or
  // inventing. Drop the WHOLE reply (the caller falls back to a hand-off); do not try to patch it.
  const leak = detectDataLeak(text, ctx.knownCapWords);
  if (leak) return { ok: false, reason: leak };

  text = cleanLinksAndMarkup(text);
  text = redactSecrets(text);
  if (!text) return { ok: false, reason: 'empty-after-clean' };
  return { ok: true, text };
}
