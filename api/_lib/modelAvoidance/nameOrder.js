/**
 * People / ID lane, round 7: name ORDER and ambiguous last words.
 *
 * 1. Family-name-FIRST order (Vietnamese "Nguyen Van Minh", Korean "Kim Min-jun", Chinese "Wang Wei"). The given-name path of hasNameEvidence looks at the FIRST
 *    word, so these were read only when printed twice. A family name list plus the SHAPE of what follows (a Vietnamese middle name, Korean syllables, Chinese
 *    syllables) recognises the order. Used only where the caller has strong label evidence (the value sits on a person-name label).
 * 2. Ambiguous LAST words. "Jordan Mill", "Carmen Hardware", "Casey Lead": a given name followed by an ordinary English word that is not a known surname. The
 *    English-word test is the Hunspell en_US list already shipped for the router (lexicon.generated.js: lowercase entries only, so a word that exists only
 *    capitalised, like Whitfield, is not in it). Such a name needs a second print in a signature / printed-name position. "Park" is a real Korean surname and
 *    a place word: it stands on a strong person label, or after a Korean given name, otherwise it needs the second print too.
 * Pure. No I/O. Lower-case, accents removed.
 */
import { COMMON_WORDS } from "../router/lexicon.generated.js";
import { COMMON_SURNAMES, FOREIGN_SURNAMES } from "./firstNames.js";
import { FLORA_FAUNA, NATURE, THING_PARTICIPLES } from "./natureWords.js";
import { CENSUS_TOP5K, CENSUS_TOP1K, CENSUS_ETHNIC, EXTRA_SURNAMES } from "./surnamesCensus.js";

const set = (s) => new Set(s.split(/\s+/).filter(Boolean));

/* ---- Vietnamese: family name first, then a middle name (Van / Thi / Huu ...) and a given name */
export const VN_FAMILY = set("nguyen tran le pham hoang huynh phan vu vo dang bui do ho ngo duong ly truong dinh lam trinh mai luong cao dao doan luu quach thai diep kieu ton tang giang ta ha chu lac to tong");
const VN_MIDDLE = set("van thi huu duc ngoc minh quoc xuan thanh hong kim bao gia hoai thu tuan anh my khanh phuong cong trong the manh nhu diem bich trung quang hai dinh dang viet nhat thien kieu lan");
const VN_GIVEN = set("an anh bao binh chau chi cuong dung dat diep duc giang ha hai han hanh hien hieu hoa hoai hong hung huong huy khanh khoa lan lam linh loan long mai minh my nam nga ngan nghia ngoc nhan nhi nhu nhung phat phong phuc phuong quan quang quyen quyet sang son tam thach thai thang thanh thao thi thinh thu thuan thuy tien tin trang tri trinh trung truc tu tuan tung tuyen uyen van vinh vu vy xuan yen hoang hiep hao huan kiet lien liem luan manh nhat tai tan thien toan trieu trong vien viet vuong ly");
const vnRest = (rest) => {
  if (rest.length < 1 || rest.length > 3) return false;
  if (rest.length >= 2 && VN_MIDDLE.has(rest[0])) return true; // "Van / Thi / Huu ..." in the middle: the last name may be one the list has not seen
  return rest.every((w) => VN_GIVEN.has(w) || VN_MIDDLE.has(w));
};

/* ---- Korean: family name first, then one or two given-name syllables ("Min-jun", "Seoyeon", "Ji Hoon") */
export const KR_FAMILY = set("kim lee park choi jung jeong kang gang cho jo yoon yun jang lim im han oh seo shin kwon hwang ahn song yoo yu hong jeon ko go moon mun yang son bae baek heo huh nam sim noh kwak sung seong cha joo ju woo");
const KR_SYL = ["min", "jun", "joon", "ji", "hoon", "hun", "woo", "seo", "yeon", "yun", "hyun", "hyeon", "sung", "seong", "young", "yeong", "soo", "su", "jin", "eun", "ye", "rin", "ha", "na", "da", "bin", "kyung", "kyoung", "gyeong", "dong", "tae", "hee", "hae", "mi", "sun", "seul", "jae", "jung", "joo", "ju", "chan", "chul", "cheol", "kyu", "gyu", "ho", "hyo", "il", "in", "ae", "ra", "sook", "suk", "shik", "sik", "won", "wook", "uk", "yong", "yoon", "bom", "byung", "beom", "do", "dae", "gun", "geon", "kwang", "gwang", "myung", "myeong", "nam", "sang", "se", "so", "ok", "ah", "a", "bo", "chae", "chang", "eui", "gi", "ki", "hwa", "hwan", "jeong", "jong", "mun", "moon", "mu", "ryu", "yu", "yoo"].sort((a, b) => b.length - a.length);
const KR_RE = new RegExp(`^(?:${KR_SYL.join("|")})+$`);
/** syllable count of a Korean given-name part ("minjun" -> 2), or 0 when the part is not made of Korean syllables */
function krSyllables(part) {
  if (!KR_RE.test(part)) return 0;
  let n = 0; let rest = part;
  while (rest) { const s = KR_SYL.find((x) => rest.startsWith(x)); if (!s) return 0; rest = rest.slice(s.length); n++; if (n > 4) return 0; }
  return n;
}
const krGiven = (tokens) => { let n = 0; for (const t of tokens) for (const p of t.split("-")) { const k = krSyllables(p); if (!k) return 0; n += k; } return n; };

/* ---- Chinese (pinyin): family name first, then one or two given-name syllables */
export const CN_FAMILY = set("wang li zhang liu chen yang huang zhao wu zhou xu sun ma zhu hu guo he gao lin luo zheng liang xie song tang han feng deng cao peng zeng xiao tian dong pan yuan cai jiang yu du ye cheng wei su lu ding ren shen yao cui zhong tan fan jin lei fu shi qian xiong meng yan qin hou");
const CN_SYL = ["wei", "fang", "na", "min", "jing", "li", "yan", "jun", "hui", "ying", "xin", "yong", "zhi", "hao", "jie", "kai", "ming", "peng", "qiang", "rui", "shan", "wen", "xiao", "lei", "tao", "bin", "chao", "dan", "fei", "gang", "guang", "hong", "hua", "jian", "jiao", "juan", "lan", "lian", "ling", "mei", "ning", "ping", "qing", "rong", "shuai", "tian", "ting", "xia", "xiu", "xue", "yi", "yu", "yue", "yun", "zhen", "zhong", "zi", "bo", "cheng", "chun", "dong", "feng", "hai", "he", "jia", "jin", "ke", "lin", "lu", "mu", "pei", "qi", "ru", "sheng", "shu", "si", "song", "tong", "xi", "xing", "yang", "ye", "yin", "you", "yuan", "zhao", "zhou", "zhu", "chen", "guo", "hang", "han", "huan", "jiang", "kun", "liang", "long", "ni", "nan", "qin", "ran", "rou", "shi", "wan", "xuan", "yao", "zhe", "zhuo"].sort((a, b) => b.length - a.length);
const CN_RE = new RegExp(`^(?:${CN_SYL.join("|")}){1,3}$`);
const cnGiven = (tokens) => tokens.length >= 1 && tokens.length <= 2 && tokens.every((t) => t.split("-").every((p) => CN_RE.test(p)));

/**
 * Does this name (lower-case words, accents removed, initials dropped) follow a family-name-first convention?
 * @param {string[]} words
 * @returns {boolean}
 */
export function familyFirstOrder(words) {
  if (words.length < 2 || words.length > 4) return false;
  const f = words[0]; const rest = words.slice(1);
  if (VN_FAMILY.has(f) && vnRest(rest)) return true;
  if (KR_FAMILY.has(f) && rest.length <= 2) { const n = krGiven(rest); if (n >= 2 && n <= 3) return true; }
  if (CN_FAMILY.has(f) && cnGiven(rest)) return true;
  return false;
}
/** Used by nameShape: "Do" is a Vietnamese family name AND a function word; it leads a Vietnamese name only. */
export const vietnameseDoName = (lows) => lows.length >= 2 && lows[0] === "do" && vnRest(lows.slice(1));
/** Given names that are first of all cities and places ("Victoria Park", "Austin Lake", "Savannah Grove"): with a place word after them the strong label is not enough. */
export const PLACE_FIRST = set("austin florence victoria lincoln sydney madison orlando houston sierra camden denver dallas phoenix brooklyn savannah paris");
/** A Korean given name (one or more syllables) in front of Park: "Ji-hoon Park", "Seoyeon Park". */
export const koreanGivenBefore = (words) => words.length >= 2 && krGiven(words.slice(0, -1)) >= 1;

/* ---- ambiguous last words */
let WORDS = null;
const englishWord = (w) => { if (!WORDS) WORDS = new Set(COMMON_WORDS.split(/\s+/)); return WORDS.has(w); };
/** Round 8: a known surname by ANY list: the common / foreign lists, the US Census top 1,000 (a word that is also a noun needs that rank; compounds and other words the top 5,000), the extra Hispanic / Navajo / English-word names, the Vietnamese / Korean / Chinese family names, the English-word surnames below. */
export const knownSurname = (w) => COMMON_SURNAMES.has(w) || FOREIGN_SURNAMES.has(w) || CENSUS_TOP1K.has(w) || CENSUS_ETHNIC.has(w) || EXTRA_SURNAMES.has(w) || VN_FAMILY.has(w) || KR_FAMILY.has(w) || CN_FAMILY.has(w) || SURNAME_WORDS.has(w);
/** Hyphenated Korean given name written the usual way, lower case after the hyphen ("Ji-hoon", "Min-jun", "Seo-yeon"): every part is a Korean syllable group. */
export const koreanHyphenated = (tok) => { const p = String(tok).toLowerCase().split("-"); return p.length >= 2 && p.length <= 3 && p.every((x) => krSyllables(x) > 0); };
/** Placeholder surnames the suite's synthetic papers (and test data in the field) use for a person: never the end of an org or equipment phrase. */
const PLACEHOLDER_SURNAMES = set("example sample tester testing tested sampler person applicant citizen");
/**
 * Place words that are ALSO real surnames (Park, Lake, Grove, Ridge, Brook): junk phrases end in them ("Victoria Park", "Austin Lake"), real people carry them. Believed only on a
 * strong person label, after a Korean given name (Park), or when printed again in a signature position. Participle-looking words (Fielding, Waring) get the same rule.
 */
export const PLACE_SURNAMES = set(`park lake grove ridge pond vale spring rock brook mead heath glen marsh`);
/**
 * English words that are real surnames (Bacon, Bright, Hammer, Silver, Swan, Hayward) but not in the common-surname list: exempt from the short-word rule below.
 * Anything not here and not a known surname is treated as an ordinary word.
 */
const SURNAME_WORDS = set(`hayward berlin muller stanhope priest castle crow pike trinity salter thatcher spicer joiner cutler draper forester gardener gilder lister marshal rider yeoman bacon barrow blessing bloom boon bowler bright bull burrow cage clement crisp dawn deer dove duck eagle fair fern fish flood flower gale gamble garland glass goose grace guest hammer hare hawk hay hedge herring hind holiday hope hough ivory jay jewel judge keen kern kite lance lark law lay leaf leech lord mace major moon oak ogle olive pearl rains rudd ruth sage sands sheep silk silver slate spear stag stern storm swan teal thorn trout vane watt whale wheat wick wild wren zeal carpenter fletcher chandler stringer fiddler gardener forester hart finch crane swift sparrow raven drake fox wolf lamb roe doe heron martin heath fielding browning harding manning banning channing waring whiting pickering gunning dowling darling sterling starling spalding kipling bunting cushing hastings lansing dunning gosling keating golding wilding redding fleming reading`);
/**
 * Round 8. A last word that is an everyday NOUN and no known surname: not evidence of a person by itself, whatever its length ("Forklift", "Playground", "Scaffold",
 * "Girders", "Trenchbox", "Mill", "Foreman"). The signal is structural, not a list of examples: the word (or its singular) is an entry of the Hunspell en_US list (lower case
 * only, so "Whitfield", "Ashworth" are not), OR it is a COMPOUND of two dictionary words whose second part is no place / family suffix (trench+box, swing+set, back+hoe; but
 * white+field, ash+worth, black+wood are surnames), OR it ends in a noun-forming suffix (-ware, -ment, -ation, -ness, -ship, -ium ...). Known surnames (US Census top 5,000,
 * the Hispanic / Vietnamese / Korean / Chinese / Navajo lists, English-word surnames such as Bright or Silver) are exempt, so "Park Stone Hill Wood Baker Mills Fields Rivers
 * Green Black Young King Bird Fox Lane" still read. A word that is neither a dictionary noun nor a compound of two (most uncommon real surnames) keeps the old path.
 * Such a name needs a second print in a signature / printed-name position.
 */
const TOPO = set("field wood ford well worth ton ham hame combe ley ly dale dell wick wich shaw stead ville burn burg berg bury by thorpe thorp hurst land mere mont more moor ridge brook hill stone son sen smith wright wall side croft man mann berry holt hay cliff");
const NOUN_SUFFIX = /(?:ware|ments?|ations?|ness|ships?|ium|iums|ics|ities|ology|ography|izers?|ators?|ifiers?)$/;
const stems = (w) => { const o = [w]; if (/ies$/.test(w)) o.push(`${w.slice(0, -3)}y`); if (/(?:s|x|ch|sh|z)es$/.test(w)) o.push(w.slice(0, -2)); if (/[^s]s$/.test(w)) o.push(w.slice(0, -1)); return o; };
// a dictionary word that is itself a place / family compound (green+wood, black+wood, brook+field) is a surname, not a thing; "well", "ton", "man" are too common inside nouns (stairwell, button, foreman) to vouch
const TOPO_DICT = set("field wood ford worth dale wick shaw burn bury hurst moor ridge brook bridge hill stone smith wright croft berry cliff mere");
const topoCompound = (w) => { for (const t of TOPO_DICT) if (w.length >= t.length + 4 && w.endsWith(t) && englishWord(w.slice(0, -t.length))) return true; return false; };
const natureNoun = (w) => stems(w).some((x) => x.length >= 7 && FLORA_FAUNA.has(x)); // 7+ letters: a short plant or animal word (Weld, Reed, Lark) is as likely a tool or a place // larkspur, tamarack, kingfisher: a plant or an animal is how English surnames are made
const dictionaryNoun = (w) => stems(w).some(englishWord) && !topoCompound(w) && !natureNoun(w);
// the head (last part) of a compound names a THING or a PLACE of work: skylift, busway, fieldhouse, toolroom, switchyard. Surnames end in a topographic part (TOPO), not in one of these.
const THING_HEAD = set("site car cart tool work wash down kit bank board room yard shop works house lift box rack bay dock pit line rail way shed deck gate door pipe tank bed bin lot pad hall out cage stack bar rig");
const compoundNoun = (w) => {
  if (w.length < 7) return false;
  for (let i = 3; i <= w.length - 3; i++) if (stems(w.slice(i)).some((x) => THING_HEAD.has(x)) && englishWord(w.slice(0, i))) return !CENSUS_TOP5K.has(w);
  for (let i = 4; i <= w.length - 3; i++) if (englishWord(w.slice(0, i)) && w.slice(0, i).length >= 4 && FLORA_FAUNA.has(w.slice(0, i))) return false; // alder+shot, lark+spur, wolf+enden: a plant or an animal in front
  for (let i = 4; i <= w.length - 3; i++) {
    const a = w.slice(0, i); const b = w.slice(i);
    if (!((a.length >= 4 && b.length >= 4) || (a.length >= 5 && b.length === 3))) continue; // short fragments are everywhere in a 100k-word list
    if (englishWord(a) && stems(b).some(englishWord) && !stems(b).some((x) => TOPO.has(x) || FLORA_FAUNA.has(x) || NATURE.has(x))) return !CENSUS_TOP5K.has(w);
  }
  return false;
};
// an agent / instrument noun: a dictionary word of 4+ letters plus -er (skid+der, grind+er, hop+per): the doubled consonant is undone. Surnames of that shape (Walker, Parker, Fowler, Hopper) are on the lists above.
const agentNoun = (w) => { const m = /^([a-z]{3,})ers?$/.exec(w); if (!m) return false; const b = m[1]; return (b.length >= 4 && englishWord(b)) || englishWord(`${b}e`) || (b.length >= 4 && b.slice(-1) === b.slice(-2, -1) && englishWord(b.slice(0, -1))); };
const longParticiple = (w) => w.length >= 9 && /(?:ing|ed)$/.test(w); // Scaffolding, Backfilling, Excavating: a gerund that long is work, not a family (Kettering, Pickering are on the lists)
export const ordinaryLastWord = (w) => w.length >= 3 && !w.includes("-") && !knownSurname(w) && !PLACE_SURNAMES.has(w) && !PLACEHOLDER_SURNAMES.has(w) && (/(?:ing|ed)$/.test(w) ? longParticiple(w) || THING_PARTICIPLES.has(w) || compoundNoun(w) : dictionaryNoun(w) || compoundNoun(w) || (agentNoun(w) && !CENSUS_TOP5K.has(w)) || (w.length >= 6 && NOUN_SUFFIX.test(w)));
/** An English-word surname, or a participle-looking word (Fielding, Waring): strong label, Korean given name (Park), or a signature print. */
/** A participle-looking word (-ing / -ed) that no list knows as a surname and is a dictionary word of 6+ letters ("Fielding", "Walking"): a strong person label is enough (round 7). */
const participleWord = (w) => !knownSurname(w) && w.length >= 6 && /(?:ing|ed)$/.test(w) && englishWord(w);
export const placeSurname = (w) => PLACE_SURNAMES.has(w) || participleWord(w);
