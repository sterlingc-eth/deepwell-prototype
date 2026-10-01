/**
 * R32 — "is this token a real word / a real given name / a real surname / a brand / a street or city word?" for the
 * typo auto-resolve policy (typoResolve.js). A token that IS a real word or a real name is never treated as a misspelling
 * of something else: "Rob Smith" is not a typo of "Bob Smith", "Mark Rose" is not a typo of "Mark Ross", "Miller" is not a
 * typo of "Millar". Deliberately generous (a false "real word" only costs the friendly auto-resolve and falls back to the
 * existing one-tap "Did you mean" chips; a false "not a word" could silently resolve the wrong person).
 * Pure data + set lookups, no I/O.
 */
import { VOCAB } from "../nlNormalize.js";
import { KNOWN_AZ_CITY_NAMES, KNOWN_US_CITY_NAMES } from "../analytics.js";

const words = (s) => s.toLowerCase().split(/\s+/).filter(Boolean);

const COMMON_WORDS = new Set(words(`
about above across after again against all almost alone along already also always among another answer any anyone area around
arrive ask away back bad bank bar base bay bear beat beach bed bell best better big bill bird bit black blue board boat body bond bone book
born both bottom box boy branch brave bread break bridge bright bring broad brook brown build burn bush busy call calm camp can car card care
carry case cash cast cat catch cause cell center chain chair chance change charge chase check chief child church circle city claim class clay
clean clear clerk climb clock close cloud club coal coast coat cold color come cook cool copper corn cost cotton count court cover cow crack
craft cross crow crown cry cup curl daily dance dare dark date dawn day dead deal dear deep deer desk dew dime dirt dish dive dock doll door
dove down draft dream dress drift drive drop dry duck dust duty each eagle early earth east easy edge eight else end enough even ever every
exact extra face fact fair faith fall false fame farm fast fat father fear feast feed feel fell fence few field fight fill film final find fine
finger fire firm first fish fit five flag flame flat flow fly foam fog fold food fool foot force ford forest fork form fort forty forward found
four fox frame free fresh friend front frost fruit full fun gain game gap garden gate gift girl give glad glass glen goal goat gold good grace
grade grain grand grant grass gray great green grey grill grim ground group grove grow guard guess guest guide hair half hall hand hang happy
hard hare harm hat hawk hay head heart heat heavy hedge held hell help hen herd hero high hill hint hit hold hole holy home honey hood hook
hope horn horse host hot hour house huge hunt hurt ice idea inch iron island jack jar jay jest job join joy judge jump just keen keep key kick
kid kind king kiss kit knee knife knight knot know lace lake lamb lamp land lane large last late law lead leaf lean learn least leave left leg
less let level lie life lift light like lime line link lion list little live load loan lock lodge log lone long look loop lord lose lost lot
loud love low luck lump lunch mad main make man many maple march mark market marsh mason master match may meal mean meat meet mild mill mind
mine mint miss mist moon more morning most moss mother mount mouse mouth move much mud must nail name near neat neck need nest net new next
nice night nine noble noon north nose note noun now nut oak oat ocean odd off often oil old once one only open orange order other out over
owl pace pack page paid pain paint pair palm pan paper park part past path pause peace peach pearl pen penny pet pick pie piece pig pile pin
pine pink pipe pit place plain plan plant plate play plum plus point pole pond pool poor port post pot pound power press price pride prime
prince print proof proud pull pump pure push put quick quiet quite race rack rail rain raise ranch range rank rare rat rate raw ray reach read
ready real red reed rest rice rich ride ridge right ring rise risk river road roast rob rock rod roll roof room root rope rose rough round row
royal rule run rush rust sad safe sage sail salt same sand save saw say scale school sea seal seat second seed seem sell send sense set seven
shade shadow shake shall shape share sharp shed sheep sheet shell shine ship shirt shoe shop shore short show shut sick side sight sign silk
silver simple sing sink sit six size skin sky slate sleep slide slow small smart smile smith smoke snake snow soft soil sold some son song soon
sorry sort soul sound south space spare speak speed spend spin spoke sport spot spring square stack staff stage stair stamp stand star start
state stay steam steel steep stem step stick still stock stone stop store storm story straw stream street strip strong such sugar summer sun
sure swan sweet swift swim sword table tail take tale talk tall tank tap tape task taste tea teach team tell ten tent term test thick thin
thing think third thorn three throw thumb tide tie tiger till time tin tip tire title toe told tone tool top total touch tower town toy trace
track trade trail train trap tree trial trick trip true trust try tub tune turn twin two under unit until upon use vale valley vast very view
vine voice wage wagon waist wait walk wall want war warm wash watch water wave wax way weak wear web week weigh well west wet whale wheat
wheel when where which while white whole wide wild will win wind wine wing winter wire wise wish wit wolf wood wool word work world worth wrap
wren write wrong yard year yellow yes yet young zone
about after again being below could every first found great house large learn never other place plant point right small sound spell still
study their there these thing think three water where which world would write
air ac heat heater furnace filter duct coil fan vent unit system repair service ticket invoice permit quote warranty install maintenance
compressor condenser thermostat freon tonnage serial model brand address customer phone email account job visit tech technician dispatch
today tomorrow yesterday week month year monday tuesday wednesday thursday friday saturday sunday january february april june july august
september october november december
`));

const GIVEN_NAMES = new Set(words(`
aaron abby abigail adam adrian aidan alan albert alex alexander alexis alice alicia alison allan allen alyssa amanda amber amy andrea andrew
andy angela angie ann anna anne annie anthony antonio april arthur ashley austin barbara barry beau ben benjamin bernard beth betty beverly bill
billy blake bob bobby bonnie brad bradley brandon brenda brent brett brian bridget brittany bruce bryan bryce caleb calvin cameron carl carla
carlos carmen carol caroline carrie casey cassandra catherine cathy chad charles charlie charlotte chase chelsea cheryl chloe chris christian
christina christine christopher cindy claire clara clarence claude clay clifford clint cody colin connie connor corey courtney craig crystal
curtis cynthia dale dan dana daniel danielle danny darlene darrell darren dave david dawn dean deanna debbie deborah debra denise dennis derek
diana diane dianne dick dolores don donald donna doris dorothy doug douglas drew duane dustin dwayne dylan earl ed eddie edgar edith edna
edward edwin eileen elaine eleanor elijah elizabeth ella ellen elliot emily emma eric erica erik erin ernest ethan eugene eva evan evelyn
faith fay felicia fern florence frances francis frank fred frederick gabriel gail garrett gary gavin gene geoffrey george gerald geraldine
gerard gilbert gina ginger glen glenn gloria gordon grace grant greg gregory gwen hailey hannah harold harry harvey hazel heather heidi helen
henry herbert holly howard hunter ian irene isaac isabel isabella jack jackie jacob jacqueline jake james jamie jan jane janet janice jared
jason jean jeff jeffrey jenna jennifer jenny jeremy jerry jesse jessica jill jim jimmy joan joann joanne jodi joe joel john johnny jon jonathan
jordan joseph josh joshua joy joyce juan judith judy julia julie june justin karen karl kate katherine kathleen kathryn kathy katie kay kayla
keith kelly ken kenneth kevin kim kimberly kirk kris kristen kristin kyle lance larry laura lauren laurie lee leo leon leonard leslie lewis
lila lillian linda lindsay lisa lloyd logan lois loretta lori lorraine louis louise lucas lucy luis luke lydia lynn mabel madison mae marc
marcus margaret maria marie marilyn marion marjorie mark marlene marsha martha martin marvin mary mason matt matthew maureen max maxine megan
melanie melinda melissa michael michele michelle mike mildred miles mitchell molly monica morgan nancy naomi natalie nathan neil nicholas
nick nicole nina noah noel nora norma norman olivia oscar owen pam pamela pat patricia patrick patsy paul paula pauline pearl peggy penny
peter phil philip phillip phyllis rachel ralph ramon randall randy raymond rebecca regina renee rhonda ricardo rich richard rick ricky rita
rob robert roberta robin rod rodney roger ron ronald ronnie rosa rose ross roy ruby russell ruth ryan sabrina sally sam samantha samuel sandra
sandy sara sarah scott sean sergio seth shane shannon sharon shawn sheila shelley sherri sherry shirley sidney simon sonia sophia spencer
stacey stacy stan stanley stella stephanie stephen steve steven stuart sue susan suzanne sylvia tamara tammy tanya tara ted terence teresa
terri terry theodore theresa thomas tiffany tim timothy tina todd tom tommy toni tony tracey tracy travis trevor tricia troy tyler valerie
vanessa vera vernon veronica vicki vickie victor victoria vincent viola violet virginia vivian wade walter wanda warren wayne wendy wesley
whitney william willie wilma wyatt yvonne zachary zoe
`));

const SURNAMES = new Set(words(`
adams alexander allen alvarez anderson bailey baker barnes bell bennett brooks brown bryant butler campbell carter castillo chavez clark cole
collins cook cooper cox cruz davis diaz edwards evans fisher flores ford foster garcia gomez gonzales gonzalez gray green griffin gutierrez
hall hamilton harris hayes henderson hernandez hill howard hughes jackson james jenkins johnson jones jordan kelly kennedy kim king lee lewis
long lopez martin martinez mason mendoza miller mitchell moore morales morgan morris murphy myers nelson nguyen ortiz owens parker patel
patterson perez perry peterson phillips powell price ramirez ramos reed reyes reynolds richardson rivera roberts robinson rodriguez rogers
rose ross russell sanchez sanders scott shaw simmons smith snyder stewart sullivan taylor thomas thompson torres tucker turner walker wallace
ward washington watson west white williams wilson wood woods wright young
`));

const NON_NAME = new Set([...(VOCAB ?? [])].map((w) => String(w).toLowerCase()));
for (const c of [...(KNOWN_AZ_CITY_NAMES ?? []), ...(KNOWN_US_CITY_NAMES ?? [])]) for (const t of String(c).toLowerCase().split(/\s+/)) if (t.length >= 3) NON_NAME.add(t);

const STREET_WORDS = new Set(words("street st avenue ave road rd drive dr lane ln boulevard blvd court ct circle cir way place pl trail trl parkway pkwy highway hwy terrace suite apt unit north south east west"));

/** True when `token` is a real English word, a common given name or surname, a brand/city/vocabulary word, or a street word. */
/** R35: a common given name ("Amy", "Gary") — used to tell "<first name> <surname on file>" from other two-word phrases. */
export function isGivenName(token) {
  return GIVEN_NAMES.has(String(token ?? "").toLowerCase());
}

export function isRealWordOrName(token) {
  const t = String(token ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (!t) return true;
  return COMMON_WORDS.has(t) || GIVEN_NAMES.has(t) || SURNAMES.has(t) || NON_NAME.has(t) || STREET_WORDS.has(t);
}

/** R32b: a real English / vocabulary / city / street word that is NOT also a given name or surname ("unit", "phone", "everyone"; but "smith" is a NAME). */
export function isNonNameWord(token) {
  const t = String(token ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (!t) return true;
  return (COMMON_WORDS.has(t) || NON_NAME.has(t) || STREET_WORDS.has(t)) && !SURNAMES.has(t) && !GIVEN_NAMES.has(t);
}
