/**
 * People / ID lane, round 8: surname lists used ONLY by the "is this last word a person's name or an everyday noun" test in nameOrder.js.
 * CENSUS_TOP5K: the 5,000 most common US surnames of the 2010 US Census (public domain, ranks 1-5000), lower case, A-Z only. It already holds the Hispanic, Vietnamese,
 * Korean, Chinese and Native American names the census ranks that high. EXTRA_SURNAMES adds the ones below the cut that are also everyday English words, plus Navajo (Diné)
 * and Hispanic names: those are exactly the words the noun test would otherwise take for equipment. Pure data.
 */
const set = (s) => new Set(s.split(/\s+/).filter(Boolean));
export const CENSUS_TOP5K = set(`smith johnson williams brown jones garcia miller davis rodriguez martinez hernandez lopez gonzalez wilson anderson thomas taylor moore jackson martin
lee perez thompson white harris sanchez clark ramirez lewis robinson walker young allen king wright scott torres nguyen hill flores green adams nelson
baker hall rivera campbell mitchell carter roberts gomez phillips evans turner diaz parker cruz edwards collins reyes stewart morris morales murphy
cook rogers gutierrez ortiz morgan cooper peterson bailey reed kelly howard ramos kim cox ward richardson watson brooks chavez wood james bennett gray
mendoza ruiz hughes price alvarez castillo sanders patel myers long ross foster jimenez powell jenkins perry russell sullivan bell coleman butler
henderson barnes gonzales fisher vasquez simmons romero jordan patterson alexander hamilton graham reynolds griffin wallace moreno west cole hayes
bryant herrera gibson ellis tran medina aguilar stevens murray ford castro marshall owens harrison fernandez mcdonald woods washington kennedy wells
vargas henry chen freeman webb tucker guzman burns crawford olson simpson porter hunter gordon mendez silva shaw snyder mason dixon munoz hunt hicks
holmes palmer wagner black robertson boyd rose stone salazar fox warren mills meyer rice schmidt garza daniels ferguson nichols stephens soto weaver
ryan gardner payne grant dunn kelley spencer hawkins arnold pierce vazquez hansen peters santos hart bradley knight elliott cunningham duncan
armstrong hudson carroll lane riley andrews alvarado ray delgado berry perkins hoffman johnston matthews pena richards contreras willis carpenter
lawrence sandoval guerrero george chapman rios estrada ortega watkins greene nunez wheeler valdez harper burke larson santiago maldonado morrison
franklin carlson austin dominguez carr lawson jacobs obrien lynch singh vega bishop montgomery oliver jensen harvey williamson gilbert dean sims
espinoza howell li wong reid hanson le mccoy garrett burton fuller wang weber welch rojas lucas marquez fields park yang little banks padilla day
walsh bowman schultz luna fowler mejia davidson acosta brewer may holland juarez newman pearson curtis cortez douglas schneider joseph barrett navarro
figueroa keller avila wade molina stanley hopkins campos barnett bates chambers caldwell beck lambert miranda byrd craig ayala lowe frazier powers
neal leonard gregory carrillo sutton fleming rhodes shelton schwartz norris jennings watts duran walters cohen mcdaniel moran parks steele vaughn
becker holt deleon barker terry hale leon hail benson haynes horton miles lyons pham graves bush thornton wolfe warner cabrera mckinney mann zimmerman
dawson lara fletcher page mccarthy love robles cervantes solis erickson reeves chang klein salinas fuentes baldwin daniel simon velasquez hardy
higgins aguirre lin cummings chandler sharp barber bowen ochoa dennis robbins liu ramsey francis griffith paul blair oconnor cardenas pacheco cross
calderon quinn moss swanson chan rivas khan rodgers serrano fitzgerald rosales stevenson christensen manning gill curry mclaughlin harmon mcgee gross
doyle garner newton burgess reese walton blake trujillo adkins brady goodman roman webster goodwin fischer huang potter delacruz montoya todd wu hines
mullins castaneda malone cannon tate mack sherman hubbard hodges zhang guerra wolf valencia saunders franco rowe gallagher farmer hammond hampton
townsend ingram wise gallegos clarke barton schroeder maxwell waters logan camacho strickland norman person colon parsons frank harrington glover
osborne buchanan casey floyd patton ibarra ball tyler suarez bowers orozco salas cobb gibbs andrade bauer conner moody escobar mcguire lloyd mueller
hartman french kramer mcbride pope lindsey velazquez norton mccormick sparks flynn yates hogan marsh macias villanueva zamora pratt stokes owen
ballard lang brock villarreal charles drake barrera cain patrick pineda burnett mercado santana shepherd bautista ali shaffer lamb trevino mckenzie
hess beil olsen cochran morton nash wilkins petersen briggs shah roth nicholson holloway lozano rangel flowers hoover short arias mora valenzuela
bryan meyers weiss underwood bass greer summers houston carson morrow clayton whitaker decker yoder collier zuniga carey wilcox melendez poole
roberson larsen conley davenport copeland massey lam huff rocha cameron jefferson hood monroe anthony pittman huynh randall singleton kirk combs
mathis christian skinner bradford richard galvan wall boone kirby wilkinson bridges bruce atkinson velez meza roy vincent york hodge villa abbott
allison tapia gates chase sosa sweeney farrell wyatt dalton horn barron phelps yu dickerson heath foley atkins mathews bonilla acevedo benitez zavala
hensley glenn cisneros harrell shields rubio huffman choi boyer garrison arroyo bond kane hancock callahan dillon cline wiggins grimes arellano melton
oneill savage ho beltran pitts parrish ponce rich booth koch golden ware brennan mcdowell marks cantu humphrey baxter sawyer clay tanner hutchinson
kaur berg wiley gilmore russo villegas hobbs keith wilkerson ahmed beard mcclain montes mata rosario vang walter henson oneal mosley mcclure beasley
stephenson snow huerta preston vance barry johns eaton blackwell dyer prince macdonald solomon guevara stafford english hurst woodard cortes shannon
kemp nolan mccullough merritt murillo moon salgado strong kline cordova barajas roach rosas winters jacobson lester knox bullock kerr leach meadows
orr davila whitehead pruitt kent conway mckee barr david dejesus marin berger mcintyre blankenship gaines palacios cuevas bartlett durham dorsey
mccall odonnell stein browning stout lowery sloan mclean hendricks calhoun sexton chung gentry hull duarte ellison nielsen gillespie buck middleton
sellers leblanc esparza hardin bradshaw mcintosh howe livingston frost glass morse knapp herman stark bravo noble spears weeks corona frederick
buckley mcfarland hebert enriquez hickman quintero randolph schaefer walls trejo house reilly pennington michael conrad giles benjamin crosby
fitzpatrick donovan mays mahoney valentine raymond medrano hahn mcmillan small bentley felix peck lucero boyle hanna pace rush hurley harding
mcconnell bernal nava ayers everett ventura avery pugh mayer bender shepard mcmahon landry case sampson moses magana blackburn dunlap gould duffy
vaughan herring mckay espinosa rivers farley bernard ashley friedman potts truong costa correa blevins nixon clements fry delarosa best benton lugo
portillo dougherty crane haley phan villalobos blanchard horne finley quintana lynn esquivel bean dodson mullen xiong hayden cano levy huber richmond
moyer lim frye sheppard mccarty avalos booker waller parra woodward jaramillo krueger rasmussen brandt peralta donaldson stuart faulkner maynard
galindo coffey estes sanford burch maddox vo oconnell vu andersen spence mcpherson church schmitt stanton leal cherry compton dudley sierra pollard
alfaro hester proctor lu hinton novak good madden mccann terrell jarvis dickson reyna cantrell mayo branch hendrix rollins rowland whitney duke odom
daugherty travis tang archer haas galloway bray nieves petty mcgrath kaufman holden krause baird riggs braun werner quinones saldana mercer hatfield
mcneil irwin hooper hays joyce mcknight gamble downs pierre haney forbes saenz davies vera levine mooney john rosa riddle key cho kaiser holder bird
bonner ferrell cotton dotson mcgowan barlow shea ewing bright becerra lindsay ritter cooley fritz cooke delaney amaya chaney kidd velasco ngo cheng
newell frey carney barrios bolton holman tovar cardona dailey merrill cowan slater albert justice osborn carver lancaster goff zapata fulton kang
sears lehman byers snider law tan lake lutz costello gay guthrie gallardo workman mcfadden blanco gorman katz kuhn noel valle marino hong springer
pickett aguilera witt carrasco donahue kinney donnelly britt craft odell daly winter abraham baez rodrigues wooten hartley ng kendall cleveland
crowley pearce dillard wilder lange shoemaker flanagan bruno segura beach castellanos tillman alford finch mcleod mackey dodd emerson minor muniz
alston maloney childers mcdermott moser vogel mccabe dang alonso saucedo starr do hurtado kirkland hendrickson holley cordero franks guillen welsh
ratliff sweet talley whitfield crowe goldstein england pereira ly joyner richter farris tracy bacon han gibbons mayfield hoang elder lau dale camp
connolly hewitt cramer goldberg morin sutherland kaplan mcallister byrne osorio cash haines meeks wynn gilliam vigil hickey connor pate zepeda hatcher
escobedo arredondo hyde christopher mobley kessler britton ritchie romano oneil tyson bui hilton caballero downing sharpe guy holcomb rankin godfrey
chamberlain fink hollis foreman carranza sharma kern chu knowles ma madison childs belcher wills womack dye arthur grace baca rutherford sorensen
mccray hastings pierson chacon renteria mohamed nicholas kendrick ferreira lockhart boggs pryor doherty sargent kenney tuttle denton magee jamison
lyon locke puckett coronado olvera sykes manuel burks chin quiroz hopper mcgill dolan mckenna head montano paredes delatorre langley sinclair dwyer
shirley muller courtney slaughter polk lemus covington madrigal clemons rosado broussard mcginnis hatch sheehan rutledge corbin dempsey garland
carmona bowling burris whitley hamm bland bermudez stinson pike orellana downey varela harden couch dickinson cassidy rucker gabriel herron mcnamara
rouse burt battle gustafson herbert dunbar webber boyce dewitt rosenberg simms woodruff brandon romo hutchins kirkpatrick corbett granados rossi goss
lott leyva hinojosa gil crabtree grady mcclellan kumar fraser rico bingham soriano sterling fonseca madrid emery singer aragon aquino elmore worley
simons quezada ott ocampo aviles nieto ervin gore shafer weston xu plummer michel paz yanez gregg abrams smart beatty serna meier robison swartz
seymour gleason vela padgett ackerman heller ziegler vinson eldridge pina schumacher akers roe tomlinson mayes zheng albright burgos swain manley
helton song quick leslie stern givens tipton coffman greenwood curran childress fish elkins daley lowry angel solano duong edmonds gomes buckner
walden hutchison griggs nix clifton thomson yarbrough mccauley elias jacob meredith mcelroy groves uribe hoskins bowden tatum schafer field bustamante
stover teague gunter burrell funk crowder schulz sanderson canales tolbert lund blue kay draper shapiro whalen navarrete gamez swift inman crews kurtz
stroud blanton reece liang francisco crow bloom sun tompkins jung nance anaya mckinley olivares newsome thurman helms metcalf goldman schmitz crouch
mcmanus arevalo horner conklin holbrook neely hollingsworth clement devine crockett benavides bullard louis steiner coates drew bowles payton chappell
amos hagen phipps self larkin poe pritchard masters gunn jeffries dooley pagan mcghee post montalvo zhou prado heard lord thao connelly driscoll
dubois feldman coker dickey pollock kimball rainey ivey gee butts maher jewell barragan machado rubin reynoso wesley hidalgo cabral samuel lacy gallo
egan aldridge swenson swan stratton hinkle butcher ornelas forrest colbert aleman rodriquez arrington goins whaley esposito neff mead casillas lilly
biggs yeager godwin sprague rosen quintanilla otto billings connell temple boswell colvin koenig erwin tellez norwood milligan ames purcell ludwig
souza huggins amador dunham goode kauffman piper oleary cuellar steward winn gary zhao sewell browne ramey davison clifford stahl ybarra samuels dukes
sheridan snell vickers cartwright link blackmon bunch grimm meade silver ojeda geiger dodge kraft lujan babcock hand winkler painter regan bragg engel
valadez carbajal redmond jarrett bolden wolff thorpe hassan hadley healy mcdonough shin grove block peacock ohara hammer feliciano winston betancourt
beaver godinez kilgore mcgraw dahl diamond pimentel cornell arreola siegel hankins raines thacker sadler sotelo dugan cote bower miner brantley sheets
sherwood pinto doss stiles willard waddell stanford latham zhu irvin matos gagnon carlton tidwell lovell hoyt spivey jean land patino marrero hager
hurt ash hagan brito lanier zarate major escamilla otero henley dick voss greenberg finn venegas mcneal metzger coulter beal crump jorgensen maurer
kearney cummins ferris milton timmons palma escalante cahill schaffer guidry yee kruse mcmullen hurd castle valdes mcwilliams leung holliday houser
bassett thomason sapp tripp galvez eubanks hilliard crocker caruso alonzo barnard deal metz carlisle hargrove keenan north dasilva ledesma messer
westbrook root hackett posey fountain cornelius benoit barnhart rendon hannah pedersen stubbs starks sizemore epps olivas bergeron roper hightower
paige urban boucher fontenot washburn farr melvin cullen hu mccollum betts coyle trotter wilhelm blount murdock street lockwood hinson rudolph waiters
sepulveda duvall smiley casas doan mcqueen langston sheffield tackett locklear linares polanco marroquin connors trent carmichael toth rushing cody
gamboa brewster shipley mena prieto gifford oliva layton gaston goodrich prater burger toledo lovett gipson arce wiseman dobson ledbetter arteaga penn
jiang whitman burkett koehler christiansen sheldon pritchett paulson eddy rock roland aranda mccracken hyatt hanley arriaga engle story valentin yost
langford herndon napier lai reeder mcneill levin landers mims brand delossantos vallejo lima cronin muhammad fitch gupta oliveira mccain medeiros
kraus stacy pettit bateman pulido roche tobin zaragoza isaac spaulding keys sylvester nowak weir darling barrientos ogden mcclendon araujo sumner
saavedra gillis landis caudill jacobsen overton diehl alarcon hedrick toney cheung darby thorne mansfield kyle dietz smallwood adair gold laird lacey
christie pack vidal kiser peoples waite beyer desai banuelos spangler mondragon fair rizzo sands queen ledford allred bledsoe rhoades ricks spicer
ordonez chavarria bryson hutton dobbs lay abel keen woody luke mchugh negron cope triplett hathaway salcedo presley ernst haywood putnam najera
stapleton batista wilkes lopes richey oh keyes dill humphries youngblood capps cates covarrubias addison ha mcrae cao dickens judd barbosa hawley
rahman crenshaw lackey varner staley kowalski kincaid moya vogt kimble barraza hay platt fernandes abreu doty crum yi corley flaherty drummond
bernstein darnell hwang fong mccord akins bergman delong moreland lorenzo longoria pelletier sneed skaggs alcala munson eason keene paris shearer
cerda lo marcus crain cagle bauman friend crespo calvert corcoran cornejo omalley albrecht mallory cavanaugh jaimes culver hope begay argueta granger
grover michaels champion whittington aldrich heredia denny fagan waldron oakes hanks grossman neumann ashby vernon crowell blum jeffers mccormack mai
dumas kenny ceja okeefe shultz cormier bain madsen cavazos burrows busch burroughs schuster bagley montero stringer whitt stallings eckert mcgovern
boykin saldivar woodson oakley currie whittaker huddleston hoff staples mireles mohr ambrose bellamy mclain greco zimmer moseley quigley atwood
brunson coon mott zambrano dinh hirsch keating chow dutton ferrer flood hooks read hobson bustos benedict vandyke troyer ham prescott shaver hoffmann
lunsford grayson finney bueno cottrell whitlock bello frias knutson hussain hsu comer hawk hamlin ransom schwab gauthier haskins stovall rooney coe
corral barrow torrez dupree eastman crandall nunn light almeida hawthorne pendleton naylor gerber schrader burnette maguire doran calloway bartley
kohler purvis acuna ulrich chau german schulte conroy hooker thayer gage nevarez jansen alaniz mcnair honeycutt baer rosenthal pickens balderas
giordano pappas henning malloy schilling duff carrera burkhart adamson arnett reagan anguiano lincoln tamayo perdue easley hogue orourke rincon
abernathy altman huston foote ennis whiting chadwick adler barney ontiveros ring rider joiner goldsmith baum ruffin laughlin rader baron trimble hare
russ ahmad parr montanez aaron clinton woodall marcum dowling stoner mattson means london adame bynum farias brannon cazares brenner ladd willoughby
kinsey dozier hairston holguin shook faust deluca lyles dias felton mcnally schreiber earl berman schaeffer cheek fenton sams saylor robledo espino
hauser cleary nugent boudreaux nickerson sorenson rowell coats yoon mast espinal ibrahim dietrich bruner valdivia jernigan schwarz gale chapa prather
seals wetzel mock parham stjohn hutson aponte jolly stauffer goodson boston scruggs stoltzfus giron mccloud titus burnham grubbs redding tilley royal
busby hillman cornett burr luu mosher coley hayward naranjo henriquez skelton cutler vergara mcgregor kerns goddard lombardo brunner rowley shipman
corey craven talbot anders reaves hough iverson monahan beavers julian ceballos leary burk borden nagy chatman dow carlos antonio mckinnon tabor
tinsley driver dawkins sauer elizondo vann wray trinh ruff sousa mahan leone he bartholomew hinds call dowell kellogg horvath whitmore bianco jack
pantoja negrete hearn thurston watt roque pyle kitchen guillory chong lemon kearns mohammed purdy lentz falcon flint delgadillo wagoner fajardo
briones conn her armenta dobbins chester banda urbina mattingly beckman solorzano ruth starkey lind waggoner gannon meek puente bail isaacs brower
yazzie strange boles mares wilburn malik priest michaud tejada irving farrar power gentile dent douglass lundy fay beebe chavis rea griffiths ireland
marion lira schuler unger mojica rudd demarco hummel almanza merchant monroy grubb harman durbin gaytan baumann salter silverman meehan dennison knott
perales francois mulligan stclair bliss wakefield kahn barth parnell dove noriega cloud stearns nagel weldon handy lorenz crook loomis laws salmon
centeno roark hostetler herrington higginbotham carnes tobias soria limon diggs parish luong resendiz kelsey echols worthington barbour coles fournier
starnes randle reardon coughlin vick jacques heim staton garay lawler bowser harms fierro pederson collazo mcmahan hershberger linton ogle mehta
mayberry barger alley oswald stoddard mcdonnell shelley newcomb blackman augustine mark creech stump chance tejeda clemens baughman ryder lombardi
weiner mota villasenor breen gant kong way kaminski vanhorn lockett elam maier gruber angeles trahan irizarry rapp foss mcclelland kilpatrick daigle
burdick weathers gavin winslow whitten deaton seay squires estep arndt satterfield early moua heck fairchild rowan ouellette beam high sebastian
donohue moeller luther lofton kruger myles humphreys renner alves forrester coy dykes branham grier pfeiffer whipple thibodeaux strauss braswell
heaton linder hills hamby callaway ellsworth mathew lovelace valles weller upton andrew estrella tharp parrott christy singletary mateo gunderson
coburn minton duenas mackenzie briscoe lawton sarmiento brinkley keener askew storey ferrara chastain harp manzo sherrill medley hacker bonds pruett
mccartney hitchcock tierney braden devries crouse dowd suggs pickering adam cheney mesa yancey morrissey weinstein jarrell rector loyd solorio garvin
jaime stamper ivy edmondson pool bearden roldan hemphill emmons mcnulty newberry valerio trinidad dowdy guajardo hook aparicio scherer darden joy
tirado robb templeton rinehart goetz rhoads bock slack carrier william asher shell layne gilliland alba shank traylor holm tam bales bourgeois
carrington jasso ko stockton graf noonan spear pressley felder jameson wahl archuleta nesbitt seaman myrick kwon byler herrmann yoo vitale loera
parson marlow jeter tong lyle scales segovia burleson chiu witherspoon barfield fabian bouchard chun markham zeigler ulloa leavitt ely martino lance
dubose redd pringle padron damico condon wiles garibay culp santillan westfall willey lassiter willett graff bachman barkley blank croft baltazar
salisbury easter burden redman salvador schell devlin woo steen leggett girard su gann lytle nobles bolin fuchs radford foy epstein lipscomb carreon
pease regalado oldham belanger alcantar looney kenyon reich epperson aguayo beaty ricketts cheatham lusk mabry millard shen thrasher danielson ebert
tubbs gilchrist cardoza andres willingham ragland aiken caron snodgrass gaffney babb denney schofield jauregui main tavares barone trout rees pedraza
crisp gillette stock baggett messina killian angulo amato wendt parris hammonds steinberg breaux east mcarthur grey wisniewski pan guardado benavidez
garber lazo lerma alcantara houck seitz schubert munguia reddy huntley wing adcock slade matlock longo orlando hein trammell guinn will muse clancy
caraballo baugh crawley wheatley linn shockley chisholm dong mccurdy bertrand spann preciado cooney berrios zelaya jaeger smalls clevenger durant
bollinger armendariz denson mixon geary montiel santamaria mcafee donald foust sisk rockwell ferraro still casper cintron overstreet borges concepcion
lemons matson brinson shelby ralston altamirano swann alicea broughton oglesby caceres braxton ashton lomeli begum scarborough dewey alfonso duggan
nadeau churchill loya ragsdale mace brubaker riggins curley graber mccrary farnsworth herrick oates nunes harley robert talbert hopson waterman gao
lantz hamrick cornwell nye reis birch milner slone spurlock tolliver almonte razo masterson porras moulton monk pence hatton rust duckworth frantz
oreilly bundy bethea reinhardt sam guo littlejohn carlin kimbrough low stoll landrum champagne forte dyson jett bach streeter christman brink herr
falk beverly wylie fallon billingsley stack chowdhury pascual qualls persaud christianson fortner gilman cecil france turpin greenfield mize selby
cotter new fontaine valladares edgar forman hannon reedy galvin doughty fraley beckwith allan beauchamp viera moffett stuckey brumfield lankford cyr
bolanos shanks osullivan delvalle hite arenas tomlin cardwell milam bowie halverson speer amaro mcmillian ponder beckett applegate larue hudgins
paxton martins fortune bair dorman neville rains smalley lamar holton patten harlow vue marx sommers kolb morrell havens brice finnegan soares godoy
carl hildebrand merino rawls rao mello blakely mcalister lyman harkins sommer mchenry cason faulk wharton bigelow helm bull dockery thai matias boland
spain jain cowart brothers fine alcaraz pulliam benner scanlon nolasco menendez wallis jacobo branson simpkins ramon whatley lewandowski quinonez
cepeda watters botello barclay grissom cadena canfield edge cota perrin mcadams haro keeler perea menard ricci burkholder poindexter coyne shackelford
ellington krieger ridley troutman tello nielson cary irby ruelas grigsby paulino maciel steffen blalock levesque forsythe newby lor sample barbee
butterfield franz keane gooch baumgartner devore hyman wenzel janssen lauer gresham fennell vest schmid grogan rupp corrigan breeden gossett causey
waugh roush zamudio mancini withers sisson pepper choate tolentino whelan yan mcneely corrales murrell brownlee fultz harlan lindquist gooden
whiteside gardiner rodas haggerty shuler garvey cardoso carman nettles burdette villagomez apodaca royer colby daily hammons pemberton wellman
montague gaspar paulsen harwood castellano victor stanfield bronson ruvalcaba newsom shipp wren dao sage brockman nino parent lenz keck houghton noe
bunn south kopp snowden martell bruns boyles camarena moe herzog kiefer clary ayres amin warden muir samson ezell switzer pardo mullin eller infante
kroll rivero sauceda zielinski jeffrey ragan bostic krebs camarillo urena peek seeley strand wyman grooms beers barba freitas byrnes ness estevez
alanis morley keefe llamas brackett lively leahy sell mortensen domingo fanning palumbo hartmann dial pino needham wheat tsai nagle sifuentes hamel
landeros massie pedroza morey larios dees brant carvalho miguel agee elrod mclemore kuntz pak otoole hardwick skidmore seibert worrell briseno nolen
hardesty pauley haddad reiter dunaway van robins laney custer gaither vicente wolford danner gatlin dunning salcido wilde somers delagarza plunkett
mccloskey mendiola medlin millan boehm marr drury lennon march horan christenson arana jose beaulieu bone feng eng farrow islam stowe olguin younger
toro kitchens libby clawson crider newkirk malcolm montenegro gulley maples galarza wenger zeller carbone maxey narvaez peng pichardo stepp florez
terrazas ahn mcintire pullen phelan parry charlton vail schrock hiller iglesias bayer sager kinder koontz cedillo villatoro oshea kimmel conti turley
behrens acker crist kemper currier broderick waldrop lemke snead seifert ratcliff ingle flannery olivo winchester judge serrato ambriz gandy sales
fogle paez jin brinkman conde monson etheridge vieira griswold gaskins mcclanahan westmoreland seward chao rand poston anglin severson windham
comstock hubert grantham fugate noll lafferty mcmillen garnett healey burge aldana kozlowski keegan turk tom reichert deguzman paniagua dupont skipper
venable higgs karr bagwell wicker liles fang carrion maya ferry marvin quinlan minter cosby barksdale tisdale meador sikes hanlon easton peyton rojo
motley ballesteros lindley caputo steed penny luciano hiatt israel crooks searcy logsdon culbertson glaser weems mccallum neil leger wayne leigh
mendenhall hollins dorn tavarez sowers andrus glick everhart deluna ahrens chapin hodgson niles lanham mendes weiler lindberg valdovinos murry colwell
earley culpepper broome shore barreto correia mcduffie betz alderman tice desantis ashworth tafoya pfeifer boudreau mattox dexter isom box montez
martens son joshi moffitt schweitzer kasper caro vines dehart perdomo eggleston shi bills allard kirchner faber layman calvillo sanborn harter tuck
mauldin nilson blaylock moriarty luo colburn starling haller mears thorn bahena curiel stine catalano beckham ashcraft haag kunz abney albertson
littleton hallman cone mcnabb stephen free upchurch wadsworth partridge osman hawes wirth gilley isbell chamberlin olmos storm quach groff mackay
thiel agnew aceves jay mccarter lebron schott kuykendall ye chou caswell weinberg zook mcmurray musser canada haskell witte johansen delrio guenther
taggart renfro schindler huey clemente lomax reddick chaffin broyles coombs quarles lucio gable fisk echevarria parkinson jeffery albers sutter
lindstrom higdon badillo thatcher weis doll dix keeton whitworth majors dover card latimer cha melo keaton handley syed ledezma olivarez binder xie
kelleher counts mancuso noyes colson heckman mosqueda littlefield tinoco luce kohn legg horowitz harder bess bohannon willson mayorga gall artis saleh
rawlings stpierre wynne luttrell jasper camargo hedges brandenburg straub bernier villareal tyree sowell manzano knoll paquette fiore bivens frick
homan ong madera taveras wei fulmer amaral shull koehn truitt keefer echeverria mccune cable freed loveless wilbur stacey gracia ostrander mangum
staggs curtin saxton gagne hackney findley holtz glynn scroggins packard antoine wicks kunkel guest vaught close feeney smyth sibley fairbanks
cockrell haugen mcclung poirier perryman mahon cosgrove salerno mundy timm swisher lafleur hardman toler cohn seaton ashford dallas batchelor cedeno
calvin lavoie deloach vuong neill irvine jolley resendez noland cousins mull hasan jacoby edmond swafford derrick martines abarca woodworth deutsch
thigpen andre mcgrew scholl tarver clough hennessy rosenbaum stull bolen reno mcfarlane hulsey seal roby ripley palomino mcwhorter rafferty harry
jurado lumpkin kohl toscano bratcher bratton evers fahey gaona keeney trapp ocasio neeley wiese maas joe furman whitson bohn bourne hanes ruggiero
fitzsimmons luis bobo rueda headley horst sturm reinhart mcnutt mccutcheon tu galicia javier demers biddle brill hoppe shay farrington landon coble
laster proffitt beall wheaton collado casanova islas bader hoy sweat hofmann hoyle peter maki bowens stutzman lea klinger florence buss hussey smoot
dugger bittner soliz runyon pitt blocker ainsworth calkins gaddis strom mcclintock worden dube mccombs zink schiller jerome rickard ling burney volk
jang gantt avina cordell gingerich forster olivera melgar knudsen slocum smail hoke leong lawless mariano ruby sander buford mayhew merriman cady see
tully glasgow gerard breedlove register kovacs davey redden goad goebel lazaro erb putman martel eads reimer pickard borders pond gallant kee packer
greenlee taft nunley jonas shuman belton barnhill kovach moreira moreau halstead fredrickson sanabria goble crutchfield loza sturgeon kidwell nicolas
clarkson mullis beattie sigler neuman sevilla pollack ridgeway bourque wilks rauch jankowski simonson kwan evangelista rau lozada canady faircloth
batson popp dunne keeling teal hamblin greiner holly to yun aiello baptiste grice freedman bergstrom clausen chew haase ammons outlaw sabo deng
teixeira lapointe colley galbraith miramontes carvajal cranford strain stubblefield partida grabowski vickery loy marte rodarte burnside hermann
wofford fleck magallanes mathias duval weatherford ricker mcvey ritchey barahona peebles peace chiang fung hutchings himes frame creel fortin bedford
dodds clouse merrell bartels southard basham dangelo raney lehmann worthy langdon jara flanders showalter robinette meeker moy cathey craddock kirsch
back arsenault spring winstead mount munn iniguez marquardt szymanski scully conte provost conover buffington marquis valverde belt goforth mazur
durand wimberly bunting kish geer foltz peak santoro lanning plascencia burkhardt autry sarabia slattery testa tennant santoyo peterman clapp pannell
keel coppola embry howland shorter earle brittain kelso gurley samples boothe freeland fusco parada sorrell bannister hawks prasad romeo lightfoot
sells tenorio merrick kaye tijerina akin atwell menjivar gilbertson meraz shanahan ibanez cruse hernandes garrido spalding deanda calabrese matheny
yuan harbin molnar gough bandy moncada chavira doucette slagle welker teran gainey heinrich vetter carden meneses trice mccallister koss shifflett
burley fries jobe rayburn hundley mccorkle boss wozniak asbury mosier petrie elliot arguello fullerton sharkey schulze shumaker couture bontrager
hargis varney siddiqui paine barboza gonsalves dayton louie candelaria liao barnette batts montelongo casteel lemay wasson cartagena coons pagano
riddick gillen kersey gorham cai griego mclendon forsyth pinkerton sturgill purnell fan hylton begley easterling macedo baeza seidel snipes sandlin
sherrod herbst monge sandberg swope covey ketchum blackwood almaraz salem hutto delrosario pelayo palacio weidner leighton desimone rausch dion cade
aguiar cave dagostino haggard wentz armijo piazza prewitt fu covert bertram mariscal houle hales nemeth gatewood archibald wingate hennessey cochrane
damron williford lovejoy lister gaddy southerland wick jewett logue hailey siler scarbrough blunt parisi eagle wilhite whitcomb camara hauck hutcheson
faison turnbull melchor burchett colin abdullah orosco coffin fuqua heinz shumate griffis battaglia ballinger vanmeter scoggins lieberman nathan
mccreary cato maestas partin lovato galan nickel pinkston casto bianchi samaniego jaquez rousseau landa bracken santacruz conaway withrow true furr
creamer dell chism bear mccue martz fogarty mcculloch prosser derosa poore oden ives winfield sprouse kirkwood mowery ahern rhea wild greathouse
castleberry deangelo heil settle spearman wertz monaco redmon sides leiva wegner guyton atchison mccaffrey dupuis valenti tallman bradbury seiler
menchaca caudle loftus palermo ulmer wilt leclair sammons an knowlton denham tillery stallworth ralph tracey schreiner mercier oviedo stinnett ferrari
schoen armour moen nutter chaves robson velarde dupre ridenour strunk hardison frasier tilton pendergrass fain ramsay manriquez fort troy wilbanks
clem montemayor wilke bazan hynes holcombe hefner enos maness neri buckingham ginn cromwell mcvay morel mahaffey criswell denning rey collett quevedo
lum duque lathrop royster weimer cornish martinson canty clegg mclaurin zayas rosser mazza kingsley marek castellon dellinger leo shinn bogan
steinmetz budd harrelson wentworth staten olmstead whitlow sledge ta pulley lacroix goncalves tremblay tanaka sisco hendrick weed badger vaca magnuson
keyser allman durkin alvarenga sayre segal earnest monaghan nall clanton geyer bounds pettigrew lundberg bostick magdaleno jenson hutchens tiller
cromer fincher loper sumpter fellows blythe urias haddock appel rupert mcinnis alam buxton chestnut eggers armstead gayle muro jeanbaptiste clemmons
dykstra mancilla grande thibodeau beeler eaves picard grasso tamez roller macleod meister hibbard garman alcorn sanches gunther ethridge arriola
heilman prentice swearingen milburn guess quesada mei etienne hyland lemaster ballew riordan fredericks volpe conlon veal servin mertz stephan flora
unruh travers swank ascencio devito johnsen loredo krug samuelson donato villalpando brent mckoy orta yount teel hair vanwinkle caldera deboer bricker
treadway deangelis buchholz luckett pitman wooldridge augustin taber vargo kremer basile yeung lilley poling talavera choe barrows dvorak raynor
alejandro rash keim hitt lapp towns sperry leroy deyoung schoonover rinaldi ashe herrin brogan lung ordaz rohrer poland coronel plante lavender frazer
barela southern jackman bahr bickford angelo kraemer angell mauro coggins goolsby batten worth kling hazel wojcik kehoe sayers romine getz gaitan
battles abrego whyte ovalle everson bristol shores yuen fontana spruill hofer eck grijalva fenner szabo pyles castanon tomas boren lerner olds
isaacson manson flick omar janes nakamura moye thomsen morehead schenk savoy lear flanigan drayton mckeever pastor reuter steadman whiteman pang
driggers fortier stroup spellman windsor mather halsey thames borja sparrow martini mcewen heflin sparkman zeng reitz mcfall silvers osuna morrill
folsom sena boling sessions spires hammett mccurry donley cassell jester matheson markley minnick cass bunker valente stidham saxon bethel pearl
timmerman lemieux du henke avelar carpio graziano damon gearhart larose jorgenson osburn otis mosby frausto yamamoto wooden schramm nutt burrow
holloman toliver hazen puentes laporte kress fryer ehlers marques linville berryman langlois nair friesen toomey ault parikh langer lei maclean bolt
berlin diallo levi peeples kozak pogue newland eden mattison abdi whited manzanares palomo usher jablonski hecht freund piatt cloutier schlegel so
derr posada pointer brannan shirk pizarro smothers vanegas warfield toussaint restrepo stegall favela wallen beale lindner yager kuo mcdevitt carnahan
falcone grim bucher ching whitehurst lew hintz fiedler upshaw cushman moorman pellegrino jenks desmond gerlach mcmichael baskin talbott utley koester
boatwright pleasant pomeroy dabney duckett mcreynolds shane bettencourt miley crites pinson sung spooner franke irons mckeown spradlin pettis juan
keiser button abell jamieson irish wickham reiss germain thornhill pippin bristow horning zamarripa mulder luster garris johnstone bosch thornburg
stamps whittle guffey huntington ogrady nelms lindgren tibbs bare das lowman mckeon creighton knudson walling chi ferro sasser sherry gladden gilson
hildreth hornsby mickelson mckenney cupp christ raber mccool ries mcdaniels speed bernhardt frankel deltoro place voigt falls sachs guan molloy tenney
kester harwell knotts bobbitt rosenberger michels sturdivant hammock simone walz bussey bosley gorski gurrola stillwell verdugo fazio neel urrutia
amezcua rutter lavigne schlosser ivory lundgren raya laplante held yao salmeron sandhu randazzo almond oaks hussein kuehn whitmire gabel pride
encarnacion null strother binkley blodgett garrity phung rambo napolitano goodin matteson au shade carreno rana woodbury spriggs snook peltier macklin
casarez mcdougal oxendine hung loving barros bocanegra ridge nail moll roddy nation rigsby zimmermann gooding vandenberg hogg mcdade wilkie wainwright
steel rainwater enright ackley bankston westphal nesmith welborn trowbridge araiza sato hague suh hannan feller palomares oropeza lagunas huskey
turcios slayton rudy guido doe comeaux backus destefano marler puga tobar kuhns damian spurgeon saul brumley brownell mckelvey palm gaskin roderick
hargrave dimas paterson kinard archie bickel wallin sipes giddens kingston seo hartwell
`);
/** The 1,000 commonest of them: a surname that is ALSO an everyday noun counts as a surname only this high up (Moon, Glass, Bright, House), not further down (Bolt, Foreman, Pool, Stack). */
export const CENSUS_TOP1K = new Set([...CENSUS_TOP5K].slice(0, 1000));
/** Names below the census cut that are also everyday English or Spanish words, or compounds of them (Navajo / Diné names built of colours and animals, Hispanic place and nature words). */
export const EXTRA_SURNAMES = set(`mesa vega luna cruz sol rosa salas valle costa mora mata roca campo bravo cano plaza puente rios silva cabello gallo lobo toro vaca paloma blanco negro rubio bueno rivas palma villa pinto casa canales mendez montes pozo roble fresno nogales olivas pino cerda cueva
 goldtooth yellowhair yellowhorse redhouse blackgoat blackhorse whitehorse whitesinger manygoats bitsoi silversmith longhair tallman redhorse greyeyes blueeyes whitethorne begaye begody tohee notah wauneka hosteen cly peaches singer curley charley largo todacheenie billie`);
/** US Census 2010 surnames of rank 1-5000 that are borne mostly by Hispanic (>= 50%), Asian / Pacific Islander (>= 50%) or American Indian / Alaska Native (>= 20%) people: the Hispanic, Vietnamese, Korean, Chinese and Navajo names, whatever English word they also are (Barrios, Quinones, Solano, Chin, Tam, Begay). */
export const CENSUS_ETHNIC = set(`garcia rodriguez martinez hernandez lopez gonzalez perez sanchez ramirez torres nguyen flores rivera gomez diaz cruz reyes morales gutierrez ortiz
ramos kim chavez mendoza ruiz alvarez castillo patel jimenez gonzales vasquez romero moreno herrera tran medina aguilar castro fernandez vargas chen
guzman mendez silva munoz salazar garza soto vazquez santos alvarado delgado pena contreras sandoval guerrero rios estrada ortega nunez valdez
santiago maldonado dominguez singh vega espinoza li wong le wang rojas marquez park yang padilla luna mejia acosta juarez cortez navarro figueroa
avila molina campos miranda ayala carrillo duran deleon leon pham cabrera lara robles cervantes solis chang salinas fuentes velasquez aguirre lin
ochoa liu cardenas pacheco calderon chan rivas khan serrano rosales trujillo roman huang delacruz montoya wu castaneda zhang guerra valencia franco
gallegos camacho colon ibarra suarez orozco salas andrade escobar velazquez macias villanueva zamora villarreal barrera pineda mercado santana
bautista trevino shah lozano rangel arias mora valenzuela zuniga melendez lam rocha huynh galvan velez meza villa tapia sosa yu bonilla acevedo
benitez zavala cisneros rubio choi arroyo arellano ho beltran ponce cantu kaur villegas ahmed montes mata rosario vang huerta guevara cortes murillo
salgado cordova barajas rosas davila dejesus marin palacios cuevas chung duarte esparza bravo corona enriquez quintero trejo medrano felix lucero
bernal nava ventura magana espinosa truong correa delarosa lugo portillo phan villalobos quintana esquivel xiong cano lim avalos parra jaramillo
peralta galindo vo vu leal sierra alfaro lu reyna tang nieves quinones saldana saenz vera rosa cho becerra amaya velasco ngo cheng barrios tovar
cardona zapata kang tan gallardo blanco valle hong aguilera carrasco baez ng segura castellanos muniz dang alonso saucedo do hurtado cordero guillen
ly han hoang lau osorio vigil zepeda escobedo arredondo bui caballero carranza sharma chu ma baca chacon renteria coronado olvera chin quiroz montano
paredes delatorre lemus madrigal rosado carmona bermudez orellana varela romo granados leyva hinojosa gil kumar rico soriano fonseca madrid aragon
aquino quezada ocampo aviles nieto xu paz yanez serna vela pina zheng burgos song angel solano duong elias uribe bustamante canales navarrete gamez
liang sun jung anaya olivares arevalo benavides pagan montalvo zhou prado thao barragan machado reynoso hidalgo ornelas aleman rodriquez casillas
quintanilla tellez amador cuellar zhao ybarra ojeda lujan valadez carbajal shin feliciano betancourt godinez pimentel arreola sotelo zhu matos patino
marrero brito zarate escamilla otero venegas palma escalante yee valdes leung galvez alonzo ledesma rendon olivas hu sepulveda casas doan locklear
linares polanco marroquin gamboa mena prieto oliva toledo arce arteaga jiang aranda arriaga valentin lai delossantos vallejo gupta pulido zaragoza
barrientos araujo saavedra alarcon cheung vidal desai banuelos mondragon ordonez chavarria negron salcedo najera batista oh covarrubias ha cao barbosa
rahman moya barraza abreu yi hwang fong lorenzo longoria alcala cerda lo crespo cornejo jaimes begay argueta heredia mai ceja cavazos montero saldivar
mireles zambrano dinh chow ferrer bustos bueno bello frias hussain hsu corral torrez acuna chau nevarez alaniz balderas carrera anguiano tamayo rincon
ontiveros ahmad montanez adame farias cazares holguin robledo espino yoon espinal valdivia chapa aponte giron luu naranjo henriquez vergara ceballos
carlos antonio elizondo trinh he pantoja negrete roque chong falcon delgadillo fajardo briones her armenta banda urbina solorzano puente yazzie mares
malik tejada chavis lira mojica almanza monroy gaytan perales noriega centeno soria limon luong resendiz garay fierro collazo mehta tejeda mota
villasenor kong angeles irizarry moua mathew valles estrella mateo duenas sarmiento manzo mesa solorio jaime roldan valerio trinidad guajardo aparicio
tirado alba tam jasso ko archuleta kwon yoo loera tong segovia chiu chun ulloa padron garibay santillan baltazar salvador woo su carreon regalado
alcantar aguayo shen cardoza jauregui pedraza angulo pan guardado benavidez lazo lerma alcantara munguia reddy caraballo dong preciado berrios zelaya
armendariz montiel santamaria cintron concepcion altamirano alicea caceres lomeli begum alfonso loya gao almonte razo porras guo chowdhury pascual
persaud valladares viera bolanos delvalle arenas amaro vue godoy merino rao thai matias jain alcaraz nolasco menendez jacobo ramon quinonez cepeda
botello cadena cota haro perea tello ruelas paulino maciel lor zamudio yan corrales rodas cardoso villagomez apodaca gaspar ruvalcaba dao nino
camarena amin pardo infante rivero sauceda camarillo urena barba estevez alanis llamas domingo pino tsai sifuentes landeros pedroza larios miguel pak
briseno van vicente salcido delagarza mendiola millan arana feng eng islam olguin toro montenegro galarza narvaez peng pichardo florez terrazas ahn
iglesias cedillo villatoro olivo serrato ambriz paez jin conde chao aldana tom deguzman paniagua fang carrion maya rojo ballesteros luciano tavarez
deluna valdovinos barreto tafoya montez son joshi caro perdomo shi calvillo luo bahena curiel olmos quach aceves lebron ye chou delrio lucio
echevarria badillo cha melo syed ledezma olivarez xie mosqueda tinoco mayorga camargo villareal manzano ong madera taveras wei echeverria gracia
cedeno vuong resendez martines abarca palomino jurado toscano gaona ocasio joe luis rueda tu galicia javier collado casanova islas soliz ling jang
avina olivera melgar leong lazaro moreira sanabria loza sevilla kwan lozada to yun deng miramontes carvajal partida marte rodarte magallanes barahona
chiang fung jara moy iniguez valverde plascencia sarabia santoyo parada prasad tenorio tijerina menjivar meraz ibanez hernandes garrido deanda yuan
moncada chavira teran meneses arguello siddiqui barboza louie candelaria liao montelongo cartagena cai griego fan macedo baeza monge almaraz
delrosario pelayo palacio armijo fu mariscal melchor colin orosco maestas lovato galan samaniego jaquez landa santacruz leiva menchaca an oviedo
chaves velarde manriquez montemayor bazan neri morel rey quevedo lum duque zayas castellon ta tanaka vaca alvarenga magdaleno urias alam muro mancilla
tamez sanches arriola quesada mei servin ascencio loredo villalpando orta caldera yeung talavera choe alejandro ordaz coronel barela gaitan abrego
ovalle yuen grijalva castanon tomas nakamura pang borja zeng osuna sena du avelar carpio frausto yamamoto puentes nair parikh lei manzanares palomo so
posada pizarro vanegas restrepo favela kuo ching lew sung juan zamarripa das chi deltoro guan gurrola verdugo urrutia amezcua raya yao salmeron sandhu
encarnacion phung au carreno rana casarez oxendine hung bocanegra araiza sato suh palomares oropeza lagunas turcios puga tobar damian dimas seo`);
