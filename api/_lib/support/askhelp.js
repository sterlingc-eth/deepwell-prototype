/**
 * Round 29 - Donovan's Ask box answers clear "how do I use the app" questions from the signed-in Help KB, at $0.
 *
 * Two pieces, both pure and offline:
 *   helpGate(question)      cheap regex gate, no KB import. True only for a short, clearly how-to question that
 *                           names an app feature AND carries no records signal (serial, address, person, date,
 *                           "who/what did", "how many jobs"...). A false answer here means the Ask box behaves
 *                           exactly as it did before this file existed.
 *   answerHowTo(question)   lazily imports the FAQ matcher (and so the KB) only after the gate passed, then
 *                           requires a strict match: STRICT score, coverage, clear margin over any other article,
 *                           an app how-to entry (audience app, or covers an inventory action).
 * The answer is shaped like every other Ask answer (kind 'answer', no facts/sources) plus a `help` block so the
 * UI can label it "From DeepWell Help: <article>". Records questions are never routed here: when in doubt the
 * question goes to the normal Ask pipeline.
 */

const STRICT_SCORE = 4.2;
const STRICT_COVERAGE = 0.6;
const STRICT_MARGIN = 1.1;
/** Share of the question's content words that the matched entry's own question and keywords must explain. */
const STRICT_EXPLAINED = 0.75;
const entryTokens = new Map();

/** Lowercase, drop apostrophes and punctuation noise so "can't" == "cant" and "where's" == "wheres". */
function norm(q) {
  return String(q ?? '')
    .toLowerCase()
    .replace(/[‘’']/g, '')
    .replace(/[^a-z0-9$/+#.\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// A how-to shape: how do/can/to, where do/is, what does X mean, can I, I can't, why can't/won't, steps to, way to ...
const HOWTO = new RegExp(
  '\\b(' + [
    'how (do|can|could|would|should|to|does|did)',
    'how (i|we) ',
    'where (do|can|is|are|did|would|should|might|to)',
    'wheres',
    'whats the (way|best way|easiest way|fastest way)',
    'what does (the |a |an )?[a-z ]{2,30} (mean|do|show)',
    'what is (the |a |an )?[a-z ]{2,24}\\?*$',
    'whats (the |a |an )?[a-z ]{2,24}\\?*$',
    'steps (to|for)',
    'way to',
    'is there a (way|button|setting|page|screen|tab)',
    'can (i|we|my|our|you) ',
    'cant (i|we) ',
    'i (cant|cannot|couldnt|need to|want to|wanna|am trying to|am unable to|dont know how|dont see|cant find|cant see|do not see)',
    'we (cant|cannot|need to|want to|wanna|dont see|cant find)',
    'why (cant|cannot|wont|wont|is my|is the|does it say|does the|isnt|arent|doesnt|dont)',
    'how come',
    'help me (with|to|add|set|find|fix|change)',
    'need help (with|to)',
    'show me how',
    'tell me how',
    'do i (need|have) to',
    'should i (click|press|tap)',
    'what do i (click|press|tap|do)',
    'which (button|tab|screen|menu)',
    'where.{0,20}(button|tab|screen|menu|setting|option)',
    'how many (logins|seats|users|pages|files) (do|does|have|are|can|is|will|per)',
    'how many (documents|techs|members|customers) (can|could|will) (i|we|my|our|you)',
    'how many (documents|pages|logins|seats) (does|do) (my|our|the) (plan|shop|account)',
    '(it|this|that|the app|deepwell|donovan|phone|upload|scan) (says|said|shows|showed)',
    '(greyed|grayed) out',
    'wont (upload|open|load|work|save|let)',
    '(not|isnt|arent|doesnt|didnt) (showing|working|loading|there|found)',
    '^(add|invite|export|delete|remove|cancel|upgrade|downgrade|change|reset|turn (on|off)|switch|install|scan|upload|merge|link|download|save|share|fix|correct|show me|set up|setup|get) ',
  ].join('|') + ')',
);

// Words that name a feature of the app itself. At least one must appear.
const APP_WORDS = new RegExp(
  '\\b(' + [
    'inbox', 'needs you', 'needs info', 'needs a person', 'records tab', 'records screen', 'the records', 'dashboard', 'billing', 'team screen',
    'team tab', 'team page', 'ask screen', 'ask tab', 'ask box', 'scan tab', 'docs tab', 'this app', 'the app', 'phone app', 'mobile app',
    'invite', 'invites', 'invitation', 'logins?', 'log ?in', 'sign ?in', 'sign ?out', 'log ?out', 'password', 'sign ?up', 'seats?',
    'upload(s|ing|ed)?', 'scan(s|ning)?', 'bulk import', 'zip', 'add files?', 'add a customer', 'new customer',
    'plans?', 'subscription', 'trial', 'invoices?', 'receipts?', 'credit card', 'payment method', 'stripe', 'manage billing', 'cancel', 'upgrade', 'downgrade',
    'export', 'csv', 'download my', 'delete (a |my |this |the |all )?(document|file|shop|data|account)', 'empty (this )?shops? documents',
    'filters?', 'sort(ing)?', 'group by', 'saved views?', 'customers? profile', 'customers? tab', 'documents? tab', 'grid', 'graph',
    'merge', 'duplicates?', 'verify', 'mark (it )?checked', 'looks right', 'document type', 'link (it|a|the|this)? ?(document|doc)?', 'conflict', 'decisions?',
    'install(ing)?', 'home screen', 'add to home', 'qr code', 'api keys?', 'support access', 'access log', 'digest', 'notifications?', 'bell', 'outreach',
    'follow ?ups?', 'claim packet', 'warranty alerts?', 'alert cards?', 'field view', 'office view', 'dark mode', 'light mode', 'palette', 'shortcut', 'ctrl ?k',
    'help chat', 'help button', 'roles?', 'admin', 'members?', 'technicians? (login|account|access)', 'remove (a |my )?(user|tech|technician|member)',
    'switch (shops?|orgs?|organizations?|companies)', 'create (a |my |your )?shop', 'records rescue', 'page allowance', 'page limit',
    'include unverified', 'thumbs (up|down)', 'share (an |the )?answer', 'recent questions', 'example questions', 'follow ?up question', 'serial from photo',
    'donovan (admin|button)', 'answer quality', 'financials?', 'reminders?', 'shop records', 'hide shop records', 'unit page', 'equipment page',
    'status', 'pages?', 'usage', 'documents?', 'files?', 'pdfs?', 'photos?', 'pictures?', 'customers?', 'serial', 'units?', 'answers?', 'questions?', 'alerts?', 'warrant(y|ies)', 'search',
    'tabs?', 'tiles?', 'buttons?', 'screen', 'app', 'donovan', 'deepwell', 'shop', 'techs?', 'technicians?', 'users?', 'account', 'original', 'phone', 'iphone', 'android', 'signal',
    'chips?', 'queue', 'email', 'excel', 'spreadsheet', 'list', 'notes?', 'packet', 'checked', 'verified', 'mark', 'wrong', 'skipped', 'limit', 'sources?', 'ai', 'tech',
  ].join('|') + ')\\b',
);

// Any of these means the question is about the shop's own records; it goes to the normal Ask pipeline.
const RECORDS_VETO = [
  /\b\d{1,6}\s+(n|s|e|w|north|south|east|west)?\.?\s*[a-z]+\s+(st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|way|ct|court|pl|place|cir|circle|hwy|pkwy|trl|terrace)\b/,
  /\b(at|on) \d{2,6}\b/,
  /\b\d{5,}\b/,
  /\b(?=[a-z0-9-]*[a-z])(?=[a-z0-9-]*\d)[a-z0-9-]{5,}\b/, // serial / model-number shaped token (letters and digits mixed)
  /\bwho (installed|serviced|did|was|worked|replaced|fixed|visited|last|has)\b/,
  /\bwhat did\b/,
  /\bwhat (was|were) (the|our|my)\b/,
  /\bwhen (was|did|is|does) (the|it|that|this|my|our)? ?(unit|system|furnace|ac|a c|heat pump|compressor|water heater|warranty|install|service|last|next)/,
  /\bwarranty (on|for|of|status)\b/,
  /\b(last|this|next) (fall|spring|summer|winter|autumn|year|month|week|quarter)\b/,
  /\b(in|during|since|before|after|last|this) (january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/,
  /\bhow many (jobs|units|calls|visits|installs|installations|customers|systems|furnaces|acs|heat pumps|invoices|work orders|tickets|techs|technicians|properties|sites|dollars|hours|times)\b/,
  /\bhow much (did|do|does|have|has|was|were|is|are) (we|i|the|our|my|marcus|[a-z]+) (make|earn|bill|charge|spend|owe|revenue|sales|invoice|collect)\b/,
  /\b(which|what) (customers?|units?|techs?|technicians?|jobs?|properties|sites|brands?|models?|systems?|furnaces?|invoices?|work orders?) (have|has|had|are|were|is|was|did|need|needs|expire|expires|installed|serviced|use|used)\b/,
  /\b(list|show|find|give) (me )?(all|every|the)? ?(customers?|units?|jobs?|invoices?|work orders?|serial numbers?|installs?) (with|for|from|that|who|where|at|by|in|on|older|newer|expiring)\b/,
  /\b(did|does|do|has|have|had|was|were|is|are) (we|they|he|she|the customer|marcus|[a-z]+s) (ever |already |still )?(install|installed|service|serviced|replace|replaced|repair|repaired|pay|paid|owe|call|called|order|ordered|visit|visited|buy|bought)\b/,
  /\b(brand|model|serial|btu|seer|tonnage|refrigerant|compressor|filter size|install date|installed on|serviced on)\b.*\b(of|for|on|at)\b (the|this|that|my|our|a)? ?(unit|system|furnace|ac|customer|house|home|address|site)\b/,
  /\b(customer|client|homeowner|landlord|tenant|mr|mrs|ms|dr)\.? [a-z]+('s)? (unit|system|furnace|ac|house|invoice|warranty|address|phone|number|email)\b/,
  /\b(owe|owes|owed|balance)\b.*\b(customer|client|us|me)\b/,
];

// A capitalised word in the middle of the typed question that is not a product/app word looks like a person or
// street name ("Marcus", "Main St"). Product words are allowed.
const PRODUCT_WORDS = new Set([
  'deepwell', 'donovan', 'stripe', 'iphone', 'ipad', 'android', 'safari', 'chrome', 'google', 'apple', 'csv', 'pdf', 'json', 'qr', 'api', 'ios',
  'ask', 'inbox', 'records', 'dashboard', 'billing', 'team', 'scan', 'docs', 'solo', 'shop', 'crew', 'fleet', 'field', 'office', 'needs', 'you',
  'manage', 'add', 'home', 'screen', 'excel', 'quickbooks', 'rescue', 'customers', 'documents', 'grid', 'graph', 'sign', 'out', 'in', 'help',
  'admin', 'member', 'owner', 'members', 'settings', 'support', 'access', 'log', 'export', 'delete', 'upload', 'files', 'file', 'phone', 'mobile',
  'wifi', 'wi-fi', 'pwa', 'url', 'sms', 'email', 'i', 'im', 'ive', 'id', 'ill', 'utc', 'zip', 'jpg', 'png', 'tiff', 'heic', 'word', 'monthly', 'annual',
  'decisions', 'conflicts', 'duplicates', 'money', 'check', 'checked', 'verify', 'verified', 'ai', 'save', 'view', 'views', 'filters', 'sort', 'group',
  'new', 'batch', 'bulk', 'import', 'choose', 'plan', 'current', 'copy', 'link', 'share', 'try', 'asking', 'recent', 'include', 'unverified',
]);

function hasProperNoun(raw) {
  const words = String(raw ?? '').replace(/[^A-Za-z0-9'’ -]+/g, ' ').split(/\s+/).filter(Boolean);
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (/^[A-Z][a-z]{2,}$/.test(w) && !PRODUCT_WORDS.has(w.toLowerCase())) return true;
  }
  return false;
}

/** Cheap, KB-free gate. True = worth a strict KB match; false = the Ask pipeline handles it, unchanged. */
export function helpGate(question) {
  if (typeof question !== 'string') return false;
  const raw = question.trim();
  if (raw.length < 8 || raw.length > 320) return false;
  const q = norm(raw);
  if (q.split(' ').length > 45) return false;
  if (!HOWTO.test(q)) return false;
  if (!APP_WORDS.test(q)) return false;
  // "how do I reset my email password" / "change my account password" are not about signing in to DeepWell.
  if (/\bpassword\b/.test(q) && (/\b(email|gmail|yahoo|outlook|wifi|wi-fi|router|account|computer|windows|bank)\s+password\b/.test(q) || !/\b(forgot|forgotten|reset|sign ?in|log ?in|login|deepwell|donovan)\b/.test(q) || /\b(my|the) account\b/.test(q))) return false;
  for (const re of RECORDS_VETO) if (re.test(q)) return false;
  if (hasProperNoun(raw)) return false;
  return true;
}

function cleanForAsk(entry) {
  let a = String(entry.a ?? '');
  a = a.replace(/\bI can (send|pass|hand|forward)[^.]*\.\s*/gi, '');
  a = a.replace(/\b(Ask|ask) me or email/g, 'Ask DeepWell Help or email');
  a = a.replace(/\b(Want|Would you like|If you'd like|If you want) a person to handle it\??,?[^.]*\.?/gi, '');
  a = a.replace(/\b(Please d|D)on't type a card number into this chat\./g, "Never type a card number into a question.");
  a = a.replace(/\*\*/g, '').replace(/`/g, '').replace(/[ \t]+/g, ' ').replace(/\s+\n/g, '\n').trim();
  if (entry.handoff) a += '\nNeed a person? Open DeepWell Help (the round button) and choose "Send this to a person".';
  return a;
}

/**
 * Strict KB match for a question that passed helpGate. Returns an Ask-shaped answer or null.
 * @param {string} question
 * @returns {Promise<null | object>}
 */
export async function answerHowTo(question) {
  if (!helpGate(question)) return null;
  const { matchFaq, articleById, tokenize } = await import('./faq.js');
  const r = matchFaq(question, { allowApp: true });
  const best = r?.top?.[0];
  if (!r?.hit || !best || best.entry !== r.hit.entry) return null;
  const entry = r.hit.entry;
  if (!(entry.audience === 'app' || (Array.isArray(entry.covers) && entry.covers.length))) return null;
  // Round 30: the Ask box takes only the matcher's firm outcomes (never a 'narrow' win) and needs the entry's own words to explain the question.
  if (!r.hit.exact && (r.hit.tier === 'narrow' || r.hit.explained < STRICT_EXPLAINED)) return null;
  if (best.score < STRICT_SCORE || best.coverage < STRICT_COVERAGE) return null;
  const rival = r.top.find((x) => x.entry.article !== entry.article);
  if (rival && best.score - rival.score < STRICT_MARGIN) return null;
  const sameArticleRival = r.top.find((x) => x.entry !== entry && x.entry.article === entry.article);
  if (sameArticleRival && best.score - sameArticleRival.score < 0.25) return null;
  // Every content word of the question must be accounted for by the entry's own question or keywords, not merely by its
  // answer text. A stray unexplained word ("pull up the pdf") means the match is a guess, and a guess is not an answer here.
  let ev = entryTokens.get(entry.id);
  if (!ev) { ev = new Set(); for (const src of [entry.q, ...(entry.kw ?? [])]) for (const t of tokenize(src).seq) ev.add(t); entryTokens.set(entry.id, ev); }
  const mt = [...tokenize(question).content];
  if (mt.length < 2 || mt.filter((t) => ev.has(t) || /^\d+$/.test(t)).length / mt.length < STRICT_EXPLAINED) return null;
  const article = articleById(entry.article);
  const title = article?.title ?? 'DeepWell Help';
  const text = cleanForAsk(entry);
  return {
    kind: 'answer',
    text,
    facts: [],
    sources: [],
    confidence: 1,
    verifiedCount: 0,
    unverifiedCount: 0,
    closest: [],
    interpretation: `From DeepWell Help: ${title}`,
    // Pre-filled so ask.js's send() does not run the records claim/citation machinery on a help answer.
    claimCheck: { policy: 'help-kb', checked: 0, supported: 0, unsupported: [], rate: 0, removedSentences: 0, removedFacts: 0 },
    records: [],
    recordsTotal: 0,
    recordsKind: 'basis',
    basis: 'Answered from the DeepWell Help guide, not from your records.',
    sentences: [],
    help: { article: entry.article, title, entry: entry.id, question: entry.q },
  };
}
