/**
 * R35 (owner decision 2026-10-01) — NICKNAMES RESOLVE AUTOMATICALLY, VISIBLY, WHEN UNAMBIGUOUS.
 *
 * "phone for Tom Mercer" finds Thomas Mercer; "email for Elizabeth Winslow" finds a customer stored as Betty Winslow.
 * The QUESTION text is rewritten to the stored full name (stored names are never touched) and the answer carries the
 * same visible note a typo correction does: `Showing results for Thomas Mercer (you typed "Tom Mercer").`
 *
 * POLICY (all must hold, else nothing is rewritten and the question goes on exactly as typed):
 *   1. the typed phrase is "<first> <surname>" (optionally possessive), and nobody on file is named exactly that;
 *   2. one side is the FORMAL name and the other one of its listed nicknames, either direction (Tom -> Thomas, Thomas ->
 *      Tom). Nickname-to-nickname (Beth -> Betty, Dan -> Danny) is never assumed: not everyone called Betty answers to Beth;
 *   3. the surname matches a stored surname exactly (case-insensitive) — a mistyped surname is only accepted when the
 *      formal form then clears the existing typo auto-resolve rules (lookups/typoResolve.js decideTypoResolution);
 *   4. EXACTLY ONE person across customers AND technicians matches (two Thomas Mercers, or a customer Thomas Mercer and a
 *      technician Tom Mercer, is ambiguous: nothing is rewritten; contactLookup offers the one-tap "Did you mean" instead), and a
 *      technician is only meant in a question about work done (jobs / visits / calls) — never for contact details;
 *   5. a nickname that is also an ordinary English word (will, bill, pat, sue, rob, mark, ...) is only read as a name
 *      where a name can stand: not right after a question word / pronoun / modal ("when will Garrison's unit ...",
 *      "can rob ...") and never as the first word of the question when it can be a verb ("Will Garrison need ...");
 *   6. not typed in quotes (quoting means "exactly as typed", the same escape hatch the typo chip uses).
 * Kill switch: DONOVAN_NICKNAMES=0.
 */
import { damerauLevenshteinDistance } from '../integrity.js';

/** formal -> nicknames / diminutives (common US usage + common Hispanic diminutives). Lowercase. */
const FORMAL_TO_NICKS = {
  abigail: ['abby', 'abbie', 'gail'], abraham: ['abe'], adam: ['ad'], adrian: ['ade'], albert: ['al', 'bert', 'bertie'],
  alexander: ['alex', 'al', 'xander', 'sandy', 'alec'], alexandra: ['alex', 'alexa', 'sandra', 'sandy', 'lexi', 'allie'],
  alfred: ['al', 'alf', 'alfie', 'fred', 'freddie'], alice: ['allie', 'ally'], allison: ['allie', 'ally'], alvin: ['al'],
  amanda: ['mandy', 'manda'], andrea: ['andi', 'andie'], andrew: ['andy', 'drew'], angela: ['angie', 'angel'], anthony: ['tony', 'ant'],
  antonio: ['tony', 'tono', 'toño', 'nino'], arnold: ['arnie'], arthur: ['art', 'artie'], augustus: ['gus'], august: ['gus'],
  barbara: ['barb', 'barbie', 'babs'], benjamin: ['ben', 'benny', 'benji'], bernard: ['bernie'], beverly: ['bev'],
  bradley: ['brad'], bradford: ['brad'], brandon: ['brandy'], calvin: ['cal'], cameron: ['cam'], carolyn: ['carol', 'carrie'],
  caroline: ['carol', 'carrie', 'caro'], catherine: ['cathy', 'cath', 'kate', 'katie', 'kay', 'cat'], cathleen: ['cathy'],
  charles: ['charlie', 'chuck', 'chaz', 'chas', 'chip'], charlotte: ['charlie', 'lottie'], christina: ['chris', 'christy', 'tina', 'chrissy'],
  christine: ['chris', 'christy', 'tina', 'chrissy'], christopher: ['chris', 'topher', 'kit'], clifford: ['cliff'], clinton: ['clint'],
  cynthia: ['cindy', 'cyndi'], daniel: ['dan', 'danny'], danielle: ['dani'], david: ['dave', 'davey', 'davy'], deborah: ['deb', 'debbie', 'debby'],
  debra: ['deb', 'debbie'], dennis: ['denny'], diana: ['di'], dolores: ['lola', 'lolita', 'dee'], dominic: ['dom'], donald: ['don', 'donnie', 'donny'],
  dorothy: ['dot', 'dottie', 'dory'], douglas: ['doug'], edward: ['ed', 'eddie', 'eddy', 'ned', 'ted', 'teddy'], edwin: ['ed', 'eddie'],
  elizabeth: ['liz', 'lizzie', 'beth', 'betty', 'betsy', 'eliza', 'libby', 'liza', 'bess'], emily: ['em', 'emmy', 'millie'],
  eugene: ['gene'], evelyn: ['evie'], frances: ['fran', 'frannie'], francis: ['frank'], franklin: ['frank'], frederick: ['fred', 'freddie', 'freddy'],
  gabriel: ['gabe'], gabriela: ['gabby', 'gaby'], gabrielle: ['gabby'], gerald: ['gerry', 'jerry'], geraldine: ['gerry'],
  gilbert: ['gil'], gregory: ['greg'], harold: ['hal', 'harry'], henry: ['hank', 'hal', 'harry'], herbert: ['herb'], howard: ['howie'],
  isaac: ['ike'], isabel: ['izzy', 'bella'], isabella: ['izzy', 'bella'], jacob: ['jake'], jacqueline: ['jackie', 'jacky'],
  james: ['jim', 'jimmy', 'jamie', 'jimbo'], janet: ['jan'], jeffrey: ['jeff'], jennifer: ['jen', 'jenny', 'jenn'], jeremiah: ['jerry'],
  jerome: ['jerry'], jessica: ['jess', 'jessie'], joanne: ['jo'], johanna: ['jo', 'hanna'], john: ['johnny', 'jack', 'jon'], jonathan: ['jon', 'jonny'],
  joseph: ['joe', 'joey', 'jo'], josephine: ['jo', 'josie'], joshua: ['josh'], judith: ['judy', 'jude'], julia: ['jules'], katherine: ['kathy', 'kate', 'katie', 'kat', 'kay', 'kitty'],
  kathleen: ['kathy', 'kath', 'kay'], kathryn: ['kathy', 'kate', 'katie'], kenneth: ['ken', 'kenny'], kimberly: ['kim', 'kimmy'],
  lawrence: ['larry'], laurence: ['larry'], leonard: ['leo', 'len', 'lenny'], leslie: ['les'], lillian: ['lily', 'lil'],
  louis: ['lou'], louise: ['lou'], lucille: ['lucy'], margaret: ['maggie', 'peggy', 'meg', 'marge', 'margie', 'greta'],
  marjorie: ['marge', 'margie'], martin: ['marty'], matthew: ['matt', 'matty'], maxwell: ['max'], maximilian: ['max'],
  melissa: ['missy', 'mel', 'mellie'], melvin: ['mel'], michael: ['mike', 'mikey', 'mick', 'mickey'], michelle: ['shelly', 'shelley', 'mich'],
  mitchell: ['mitch'], nathan: ['nate'], nathaniel: ['nate', 'nat'], nicholas: ['nick', 'nicky'], nicole: ['nikki', 'nicky'],
  norman: ['norm'], oliver: ['ollie'], pamela: ['pam'], patricia: ['pat', 'patty', 'patti', 'trish', 'tricia'], patrick: ['pat', 'paddy'],
  peter: ['pete'], philip: ['phil'], phillip: ['phil'], rachel: ['rach'], randall: ['randy'], randolph: ['randy'], raymond: ['ray'],
  rebecca: ['becky', 'becca', 'beck'], richard: ['rick', 'rich', 'dick', 'ricky', 'richie'], robert: ['bob', 'rob', 'bobby', 'robbie', 'bert'],
  rodney: ['rod'], ronald: ['ron', 'ronnie', 'ronny'], rosalind: ['roz'], russell: ['russ'], samantha: ['sam', 'sammy'], samuel: ['sam', 'sammy'],
  sandra: ['sandy', 'sandi'], stanley: ['stan'], stephanie: ['steph', 'stephie'], stephen: ['steve', 'stevie'], steven: ['steve', 'stevie'],
  stuart: ['stu'], susan: ['sue', 'susie', 'suzy'], suzanne: ['sue', 'suzy'], terrence: ['terry'], terence: ['terry'], theodore: ['ted', 'teddy', 'theo'],
  theresa: ['terry', 'tess', 'tessa', 'tere'], teresa: ['terry', 'tess', 'tere'], thomas: ['tom', 'tommy'], timothy: ['tim', 'timmy'],
  tobias: ['toby'], valerie: ['val'], vernon: ['vern'], veronica: ['ronnie', 'vera'], victor: ['vic'], victoria: ['vicky', 'vickie', 'tori'],
  vincent: ['vince', 'vinny'], virginia: ['ginny', 'ginger'], walter: ['walt', 'wally'], wesley: ['wes'], william: ['bill', 'will', 'billy', 'willy', 'willie', 'liam'],
  winifred: ['winnie'], zachary: ['zach', 'zack'],
  // Hispanic diminutives
  'josé': ['pepe', 'chepe'], jose: ['pepe', 'chepe'], francisco: ['paco', 'pancho', 'kiko', 'frank'], guadalupe: ['lupe', 'lupita'],
  'jesús': ['chuy'], jesus: ['chuy'], guillermo: ['memo', 'willy'], ignacio: ['nacho'], eduardo: ['lalo', 'eddie'], roberto: ['beto'],
  alberto: ['beto'], humberto: ['beto'], concepción: ['concha', 'conchita'], concepcion: ['concha', 'conchita'], rosario: ['charo'],
  fernando: ['nando'], enrique: ['quique', 'kike'], rafael: ['rafa'], graciela: ['chela'], 'maría': ['mari'], maria: ['mari'],
  alejandro: ['alex', 'alejo'], alejandra: ['alex', 'ale'], manuel: ['manny', 'manolo'], ramón: ['moncho'], ramon: ['moncho'],
  santiago: ['santi', 'chago'], salvador: ['chava'], gerardo: ['lalo'], jorge: ['coque'], luz: ['lucha'], pilar: ['pili'],
  margarita: ['margo', 'rita'], ricardo: ['ricky', 'richi'], rodrigo: ['rigo'], federico: ['fede'], gonzalo: ['chalo'],
};

/** Nicknames that are also ordinary English words: only read as a name where a name can stand (policy 5). */
const WORDLIKE = new Set(['will', 'bill', 'pat', 'sue', 'rob', 'mark', 'art', 'ray', 'don', 'al', 'ed', 'dick', 'jack', 'rich', 'sandy', 'kit', 'chip',
  'cat', 'dot', 'gene', 'max', 'nick', 'peg', 'rod', 'stan', 'val', 'vic', 'dee', 'di', 'jo', 'cal', 'herb', 'frank', 'chuck', 'angel', 'ginger', 'bert',
  'cliff', 'russ', 'bess', 'kay', 'beck', 'jan', 'les', 'jim', 'tom', 'lou', 'jules', 'hal', 'ike', 'ted', 'kat', 'em', 'ant', 'ad', 'ale', 'mel', 'jen', 'deb']);
/** Words after which a word-like nickname reads as a verb/noun, not a first name. */
const NOT_A_NAME_AFTER = new Set(['when', 'what', 'how', 'who', 'where', 'why', 'which', 'whose', 'i', 'we', 'you', 'they', 'he', 'she', 'it', 'that',
  'this', 'there', 'can', 'could', 'would', 'should', 'may', 'might', 'must', 'shall', 'also', 'to', 'not', "won't", 'will', 'the', 'a', 'an', 'our', 'my',
  'your', 'their', 'his', 'her', 'its', 'next', 'last', 'first', 'final', 'utility', 'electric', 'power', 'gas', 'water']);
/** Word-like nicknames that read as a verb at the very start of a question ("Will Garrison need ...", "Mark Ortega as paid"). */
const VERB_AT_START = new Set(['will', 'mark', 'sue', 'rob', 'pat', 'bill', 'chip', 'chuck', 'max', 'jack', 'ray', 'dot', 'cliff', 'herb', 'stan', 'rod', 'art', 'nick', 'peg']);

const TECH_CONTEXT_RE = /\b(?:jobs?|visits?|calls?|tickets?|work(?:ed|s)?|did|done|tech|techs|technicians?|busy|busiest|hours|assigned|ran|installed|install|serviced|out on)\b/i;

const NICK_TO_FORMALS = new Map();
for (const [formal, nicks] of Object.entries(FORMAL_TO_NICKS)) {
  for (const n of nicks) {
    if (!NICK_TO_FORMALS.has(n)) NICK_TO_FORMALS.set(n, new Set());
    NICK_TO_FORMALS.get(n).add(formal);
  }
}

export function nicknamesEnabled() {
  return process.env.DONOVAN_NICKNAMES !== '0';
}

/** Pure: true when typed first name `a` and stored first name `b` are a formal/nickname pair (either direction). */
export function isNicknamePair(a, b) {
  const x = String(a ?? '').toLowerCase();
  const y = String(b ?? '').toLowerCase();
  if (!x || !y || x === y) return false;
  return Boolean(NICK_TO_FORMALS.get(x)?.has(y) || NICK_TO_FORMALS.get(y)?.has(x));
}

/** Pure: the formal names a typed first name can stand for (empty when it is not a known nickname). */
export function formalsOf(first) {
  return [...(NICK_TO_FORMALS.get(String(first ?? '').toLowerCase()) ?? [])];
}

/** Pure: is `w` any first name in the table (formal or nickname)? */
export function isKnownFirstName(w) {
  const x = String(w ?? '').toLowerCase();
  return NICK_TO_FORMALS.has(x) || Object.prototype.hasOwnProperty.call(FORMAL_TO_NICKS, x);
}

const lc = (s) => String(s ?? '').toLowerCase();
const splitName = (full) => {
  const toks = String(full ?? '').trim().split(/\s+/).filter(Boolean);
  return toks.length === 2 ? { first: toks[0], last: toks[1] } : null;
};

/**
 * Pure: every person (customer or technician) the typed "<first> <last>" can mean by nickname, per the policy above.
 * `people` = [{name, kind}] (kind 'customer' | 'technician'). Returns {exact, matches: [{name, kind}], surnameTypo}.
 */
export function nicknameMatches(typedFirst, typedLast, people) {
  const f = lc(typedFirst);
  const l = lc(typedLast);
  const exact = people.some((p) => lc(p.name) === `${f} ${l}`);
  if (exact) return { exact: true, matches: [] };
  const cands = [];
  for (const p of people) {
    const sp = splitName(p.name);
    if (!sp || lc(sp.last) !== l) continue;
    if (isNicknamePair(f, sp.first)) cands.push(p);
  }
  return { exact: false, matches: dedupe(cands) };
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((p) => { const k = `${p.kind}:${lc(p.name)}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// "<First> <Last>" spans: two letter-words, the second optionally possessive (the "'s" stays outside the span). The first word must be
// a table nickname/formal name (checked below), the second a stored surname.
const PAIR_RE = /(^|[^A-Za-z'’])([A-Za-z]+)(\s+)([A-Za-z][A-Za-z-]*?)(?=(?:['’]s)?(?:$|[^A-Za-z'’-]))/g;

/**
 * Pure: rewrite ONE unambiguous nickname/formal-name mention in `question` to the stored full name.
 * `vocab` = tenantVocab ({customers: {phrases}, technicians: {phrases}}). Returns {question, note: {typed, resolved}} or null.
 */
export function resolveNicknameInQuestion(question, vocab) {
  if (!nicknamesEnabled()) return null;
  const q = String(question ?? '');
  const people = [
    ...(vocab?.customers?.phrases ?? []).map((name) => ({ name, kind: 'customer' })),
    ...(vocab?.technicians?.phrases ?? []).map((name) => ({ name, kind: 'technician' })),
  ];
  if (!people.length) return null;
  const surnames = new Set();
  for (const p of people) { const sp = splitName(p.name); if (sp) surnames.add(lc(sp.last)); }
  PAIR_RE.lastIndex = 0;
  let m;
  while ((m = PAIR_RE.exec(q))) {
    const start = m.index + m[1].length;
    const first = m[2];
    const last = m[4];
    const span = `${first}${m[3]}${last}`;
    const skip = () => { PAIR_RE.lastIndex = start + first.length; };
    const fl = lc(first);
    if (!isKnownFirstName(fl)) { skip(); continue; }
    const before = q.slice(0, start);
    const after = q.slice(start + span.length);
    // policy 6: quoted -> as typed
    if (/["“”]\s*$/.test(before)) { skip(); continue; }
    // policy 5: word-like nicknames only where a name can stand
    if (WORDLIKE.has(fl) && NICK_TO_FORMALS.has(fl)) {
      const prev = lc((before.match(/([A-Za-z']+)[^A-Za-z']*$/) ?? [])[1] ?? '');
      if (!prev && VERB_AT_START.has(fl)) { skip(); continue; }
      if (prev && NOT_A_NAME_AFTER.has(prev)) { skip(); continue; }
    }
    let { exact, matches } = nicknameMatches(first, last, people);
    if (exact) { skip(); continue; }
    let surnameTypo = false;
    if (!matches.length && !surnames.has(lc(last)) && last.length >= 5 && !isKnownFirstName(lc(last))) {
      // policy 3: a mistyped surname: exactly one stored surname within one edit, and the formal form must then be unique.
      const near = [...surnames].filter((s) => Math.abs(s.length - last.length) <= 1 && damerauLevenshteinDistance(s, lc(last)) === 1);
      if (near.length === 1) {
        const viaTypo = nicknameMatches(first, near[0], people);
        if (!viaTypo.exact && viaTypo.matches.length === 1) { matches = viaTypo.matches; surnameTypo = true; }
      }
    }
    if (matches.length !== 1) { skip(); continue; }
    // a technician is only meant when the question is about work done (jobs / visits / calls), never for a customer's contact details
    if (matches[0].kind === 'technician' && !TECH_CONTEXT_RE.test(q)) { skip(); continue; }
    const resolved = matches[0].name;
    return { question: `${before}${resolved}${after}`, note: { typed: span, resolved }, kind: matches[0].kind, surnameTypo };
  }
  return null;
}

/**
 * Pure: the people (from `rows` = customer rows with customer_name) a typed "<first> <last>" phrase can mean by nickname —
 * used by contactLookup for the ambiguous case ("Did you mean Christopher Smith, Christina Smith?").
 */
export function nicknameCandidateRows(namePhrase, rows) {
  if (!nicknamesEnabled()) return [];
  const sp = splitName(String(namePhrase ?? '').replace(/['’]s$/i, ''));
  if (!sp || !isKnownFirstName(sp.first)) return [];
  const out = [];
  for (const r of rows ?? []) {
    const rp = splitName(r.customer_name);
    if (!rp || lc(rp.last) !== lc(sp.last)) continue;
    if (lc(rp.first) === lc(sp.first)) return []; // an exact name exists: not a nickname question
    if (isNicknamePair(sp.first, rp.first)) out.push(r);
  }
  return out;
}

export const NICKNAME_TABLE_SIZE = NICK_TO_FORMALS.size + Object.keys(FORMAL_TO_NICKS).length;
