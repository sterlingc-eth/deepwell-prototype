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

/** True when the message contains a card number, SSN, password/PIN or key/token. */
export function detectSensitive(text) {
  const s = String(text ?? '');
  for (const m of s.matchAll(/(?<![\w-])(?:\d[ -]?){13,19}(?![\w-])/g)) {
    const digits = m[0].replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && (luhnOk(digits) || /\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,7}/.test(m[0]))) return 'card';
  }
  if (/(?<![\d-])\d{3}-\d{2}-\d{4}(?![\d-])/.test(s)) return 'ssn';
  if (/\b(?:ssn|social security(?: number)?)\b\D{0,20}\d{9}\b/i.test(s)) return 'ssn';
  if (/\b(?:my |the |account |login )?(?:password|passcode|passwd|pin|secret)\s*(?:is|was|:|=)\s*\S{3,}/i.test(s)) return 'password';
  if (/\b(?:sk|pk|rk|dwk)[-_][A-Za-z0-9_-]{16,}\b/.test(s) || /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/.test(s)) return 'key';
  return null;
}

/* ------------------------------------------------------------------ prompt injection */

const INJECTION_RES = [
  /\b(?:repeat|print|show|output|recite|echo|reveal|display)\b[^.?!]{0,30}\b(?:everything|all|text|words|content|message|messages|instructions)\b[^.?!]{0,20}\b(?:above|before this|so far|earlier|prior)\b/i,
  /\b(?:ignore|disregard|forget|override|bypass|drop)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|any|your|the|these|those|system)\b[^.\n]{0,30}\b(?:instruction|instructions|prompt|rules?|guidelines?|directions?|constraints?|policy|policies|context)\b/i,
  /\b(?:reveal|show|print|display|repeat|output|leak|tell me|give me|dump|share|recite|paste|echo)\b[^.\n]{0,40}\b(?:system prompt|your prompt|your instructions|initial prompt|hidden prompt|your rules|your guidelines|knowledge base|your configuration|developer message|canary)\b/i,
  /\bwhat (?:is|are|were) your (?:system )?(?:prompt|instructions|rules|guidelines|initial instructions)\b/i,
  /\byou are (?:now|no longer)\b/i,
  /\b(?:act|behave|respond|answer) as (?:if you (?:are|were)|an? |the )/i,
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

export function detectInjection(text) {
  const s = String(text ?? '');
  return INJECTION_RES.some((re) => re.test(s));
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
  return /\b(?:are you (?:a |an )?(?:real |actual )?(?:human|person|bot|robot|ai|chatbot|machine|chatgpt|gpt|claude|gemini|llm|live agent)|is this (?:a |an )?(?:bot|ai|human|real person|robot)|what (?:model|llm|ai) (?:are|is) (?:you|this|powering)|which (?:model|llm|ai)|who (?:made|built|created|trained|programmed) you|are you powered by|what are you built (?:on|with)|what are you|who are you|what is your name|whats your name)\b/.test(n);
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
  if (/\b(?:when did we|when was (?:the|that|this)|who was (?:out|at|the tech)|what did [a-z]+ do|which (?:customers|clients|units|techs|technicians|jobs|invoices|work orders)|how many (?:customers|clients|units|jobs|work orders|installs|service calls)|list (?:all )?(?:my|our|the) (?:customers|units|jobs|invoices)|show me (?:the |all )?(?:customers|units|jobs|invoices|work orders)|last (?:service|visit|install)|is (?:the|this|that) .{1,40}(?:still )?under warranty|warranty (?:status|expir\w*) (?:for|on|of)|units? (?:expiring|installed)|who owes|unpaid invoices|outstanding invoices|find (?:me )?(?:the |a )?(?:customer|invoice|work order|document))\b/.test(n)) return 'weak';
  return null;
}

const COMPETITORS = /\b(?:servicetitan|service titan|housecall ?pro|housecall|jobber|fieldedge|field edge|buildops|service fusion|workiz|fieldpulse|simpro|jobnimbus|successware|procore|quickbooks|xero|salesforce|hubspot|dropbox|google drive|onedrive|sharepoint|chatgpt|openai|copilot|gemini|perplexity)\b/i;
const COMPARISON_CUE = /\b(?:vs\.?|versus|compare[sd]?|comparison|compared to|better than|cheaper than|worse than|alternative|alternatives|instead of|switch(?:ing)? from|replace|competitor|competitors|beat|like servicetitan|similar to|difference between)\b/i;

export function detectCompetitorComparison(text) {
  const s = String(text ?? '');
  return (COMPETITORS.test(s) && COMPARISON_CUE.test(s)) || /\b(?:competitors?|competition|other (?:software|products|platforms|vendors|companies)|market leaders?)\b/i.test(s) && COMPARISON_CUE.test(s);
}

const HVAC_ACTION = '(?:fix|repair|replace|install|charge|wire|diagnose|troubleshoot|recharge|clean|size|sizing|service|test|measure|calculate|braze|solder|evacuate|flush|reset|bypass|jump|set up|adjust)';
const TRADE_NOUN = '(?:ac|a/c|air conditioner|air conditioning|furnace|condenser|compressor|capacitor|contactor|thermostat|heat pump|air handler|evaporator|coil|blower|refrigerant|freon|ductwork|duct|hvac|water heater|boiler|pipe|drain|faucet|toilet|breaker|panel|outlet|wiring|circuit|generator|mini split|minisplit|heat exchanger|igniter|flame sensor|pressure switch|txv|filter drier|manifold gauges?|superheat|subcooling)';

export function detectTradeHowTo(text) {
  const n = norm(text);
  if (new RegExp(`\\b${HVAC_ACTION}\\b[^.]{0,40}\\b${TRADE_NOUN}\\b`).test(n)) return true;
  if (/\bwhat size (?:ac|furnace|unit|heat pump|air conditioner|breaker|wire|condenser)\b|\b(?:r ?410a?|r ?22|r ?32|r ?454b?) (?:charge|pressure|refrigerant|subcool|superheat)|\bmanual [jsd]\b|\bbtu(?:s)? (?:per|for|calculation|needed)|\berror code\b|\bwhy is my (?:ac|furnace|heat pump|thermostat|water heater)\b|\bmy (?:ac|furnace|heat pump|water heater|thermostat) (?:is|wont|isnt|keeps|stopped)/.test(n)) return true;
  return false;
}

const OFF_TOPIC_RE = /\b(?:poem|poetry|haiku|limerick|song lyrics|lyrics|joke|jokes|riddle|story about|write (?:me )?(?:a |an )?(?:essay|story|poem|song|email to my|cover letter|resume|script|blog|tweet|speech)|recipe|cook|bake|weather|forecast|temperature outside|stock price|stocks?|bitcoin|crypto|ethereum|invest(?:ing|ment)?|lottery|horoscope|astrology|movie|film|tv show|netflix|sports?|nfl|nba|mlb|football|basketball|baseball|soccer|score of|who won|election|president|senator|congress|politic\w*|democrat|republican|trump|biden|war in|ukraine|gaza|religion|god|bible|medical|symptom|diagnos(?:e|is) (?:my|me)|medication|prescription|doctor|therapy|depress\w*|lawsuit advice|tax advice|legal advice|homework|math problem|solve|equation|calculate|integral|derivative|translate|translation|in spanish|in french|python|javascript|typescript|java|c\+\+|golang|rust code|sql query|regex|write (?:a )?(?:function|code|program|script|class)|debug (?:my|this) code|html|css|react|capital of|population of|how tall|how far|how old is|who is the (?:ceo|owner|founder|president) of (?!deepwell)|tell me about (?:yourself|the world)|meaning of life|what is 2|whats \d+ ?[+*/x-] ?\d+|\d+ ?[+*/x-] ?\d+ ?=|dating|relationship advice|travel|flight|hotel|restaurant|pizza|coffee|video game|minecraft|fortnite|taylor swift|elon musk|apple stock|tesla)\b/i;

export function detectOffTopic(text) {
  return OFF_TOPIC_RE.test(String(text ?? ''));
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

const COMPETITOR_ANY = /\b(?:servicetitan|service titan|housecall ?pro|jobber|fieldedge|field edge|buildops|service fusion|workiz|fieldpulse|simpro|jobnimbus|successware|procore|salesforce|hubspot|chatgpt|openai|gemini|perplexity)\b/i;
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

/**
 * Validate + clean one model reply. Returns {ok:true, text} or {ok:false, reason}. A failed reply is NEVER
 * shown: the caller substitutes the canned fallback.
 * @param {string} raw
 * @param {{allowedAmounts: string[], promptShingles?: Set<string>}} ctx
 */
export function validateModelReply(raw, ctx = {}) {
  if (typeof raw !== 'string') return { ok: false, reason: 'not-text' };
  let text = raw.trim();
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

  const sentences = text.split(/(?<=[.!?\n])\s+/);
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
