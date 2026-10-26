/**
 * People / ID lane, round 8: which everyday English nouns are the kind of word English SURNAMES are made of. Derived from Princeton WordNet 3.1 (WordNet License, https://wordnet.princeton.edu/license-and-commercial-use):
 * the single-word lower-case lemmas of the Hunspell en_US list (router/lexicon.generated.js), 4-16 letters, whose FIRST (commonest) noun sense is
 *   FLORA_FAUNA  a plant or an animal (larkspur, tamarack, hawthorn, kingfisher, nightingale, starfish): the source of many surnames (Lark, Heron, Hawthorn, Rose, Fox);
 *   NATURE       a natural object, a natural phenomenon or a substance (waterfall, weather, hillside, marble): the head of place-name surnames (Bell+weather, Brook+side).
 * A thing someone builds, drives or works in (forklift, playground, warehouse, scaffold, culvert, turbine) is an artifact / location / act in WordNet and is in neither list. Pure data.
 */
const set = (s) => new Set(s.split(/\s+/).filter(Boolean));
export const FLORA_FAUNA = set(`aalii aardvark aardwolf abalone abele abelmosk abies abomasum absinthe abutilon acacia acanthus acarid acarus accentor accipiter achene acidophil
acinus aconite acorn acrodont acrogen actinia actinomycete actinopod actinozoan aculeus acumen addax adenovirus aeciospore aecium aedes aerobe
aerophyte affirmed aftershaft agama agamete agapanthus agaric agave ageratum agouti agrimony agueweed ailanthus akee alder alfalfa alfilaria alga
algae algarroba alkanet allantois allium allspice almond aloe alula alumroot alyssum amadavat amanita amaranth amarelle amaryllis amberjack ambulacrum
ament amnion amoeba amphidiploid amphioxus amphipod anabas anaconda anaerobe anas androecium anemone angelfish angelica angiosperm angleworm angostura
angwantibo anhinga animalcule anise ankylosaur annelid annual anoa anole anopheles anteater antelope anther antheridium antherozoid anthozoan
anthurium antirrhinum antler antlion anuran aoudad apatosaur apatosaurus aphid aphis apomict apophysis apothecium appaloosa apricot apteryx aquatic
aquilegia arachnid araucaria arbor arborvitae arbovirus arbutus archaeornis archegonium archenteron archerfish archespore areca arethusa argal argali
argentine aril arista armadillo armyworm arnica aroid arrowworm artemisia arthropod arthrospore artichoke artiodactyl arugula arum asarum ascidian
ascocarp ascomycete ascomycetes ascospore ascus asparagus aspen aspergillus asphodel aspidistra aster astilbe astragalus aubergine auklet auricula
aurochs autophyte autotroph avadavat avens avocet awlwort axil axolotl axseed azalea azedarach babassu babirusa baboon bacillus bacteria bacterium
bacteroid balata balsa balsam bamboo banana bandicoot baneberry bangtail banian banksia bantam banyan baobab barbel barberry barbet barilla bark
barleycorn barnacle barracuda basenji basidiospore basidium basil bassarisk basset basswood bast batfish batrachian bayberry beagle beak beanstalk
bear bearberry bearcat bearwood bedbug bedder bedstraw beech beechwood beef beefalo beefwood beet beetle beetroot beggarweed begonia belemnite
belladonna bellbird bellflower bellwort beluga belvedere benne bennet benny bergamot betel biddy biennial bigeye bignonia bilberry billfish bindweed
bine binturong biped birch bird birthroot birthwort bison bittern bitternut bitterroot bittersweet bitterweed bivalve blackbird blackcap blackcock
blackfish blackjack blackpoll blacksnake blacktail blackthorn bladdernose bladderwort blade blaeberry blastocoel blastocyst blastoderm blastomere
blastopore blastosphere blastula blennioid blenny blindworm blinks bloodhound bloodroot bloodsucker bloodworm bloomer blossom blowfly bluebell
blueberry bluebill bluebird bluebonnet bluebottle bluefish bluegill bluegrass blueweed blusher boar boarfish boarhound boatbill bobcat bobolink
bobtail bobwhite bogbean boletus boll bollworm boltonia bombycid bonefish boneset bonobo bonsai borage borecole borzoi botfly botulinum botulinus
bough bovid bovine bowerbird bowfin bowhead boxberry boxfish boxthorn boxwood boysenberry brachiopod brachyuran bracken bract bracteole bramble
brambling branchia branchiopod brant brassica breadfruit breadroot brent briarroot briarwood brier brierwood brill briony bristletail broadbill
broccoli brocket bronc bronco brontosaur brontosaurus broodmare broody brooklime brookweed broomcorn bruin bryony bryophyte bryozoan buckeye buckskin
buckthorn buckwheat buddleia budgerigar budgie buffalo bufflehead bugbane bugleweed bugloss bulb bulbil bulbul bull bullace bullbat bulldog bullfrog
bullhead bullock bulrush bumblebee burbot burdock burl burr burro bush bushbuck bushtit bustard butcherbird buteo butterbur buttercup butterfly
butternut butterwort buttonwood buzzard byssus cabbageworm cacao cachalot cacique cackler cacomistle cactus caecilian caiman calabash caladium
calamint calamus calceolaria calendula calf calisaya calla calliopsis caltrop calycle calypso calyptra calyx camass cambium camel camellia camelopard
campanula campion candida candleberry candlenut candlewood candytuft canella cankerworm canna cannabis cantaloupe canvasback capelin caper
capercaillie capitulum caplin caprifig capsicum capsid capybara carabao caracal caracara carambola carangid carapace caraway carcajou carcass cardamom
cardamon cardoon caribou carinate carnation carnauba carnivora carnivore carob carpel carpophore carpospore carrageen carragheen carrion carrot
carthorse caryopsis cascara cascarilla caseworm cashew cassia cassowary catalpa catamount cataphyll catarrhine catbird catchfly catechu caterpillar
catgut catkin catmint catnip cattail cattalo cattle cattleya caudex cauliflower cavalla cavy cayenne cayuse cedar ceiba celandine celeriac celery
celtuce centaury centipede cephalopod ceratodus cercaria cere cereal cereus cero cestode cetacean chacma chaeta chaetognath chaffinch chalaza
chamomile chanterelle chard chardonnay charger charlock charr chatterbox chaulmoogra cheat checkerberry checkerbloom cheetah chelicera chelonian
cherimoya cherry chervil chess chestnut chetah cheviot chevrotain chewink chick chickadee chickpea chickweed chicory chigetai chigger chigoe chimp
chimpanzee chinaberry chinch chinquapin chipmunk chiropteran chive chives chlamys chlorella chlorenchyma chlorophyll chloroplast choanocyte
chokecherry cholla chordate chorion chough chromoplast chrysalis chub chuckwalla chufa cicada cicala cichlid cilantro ciliate cilium cimex cinchona
cineraria cinnamon cinquefoil cirrus citrange civet cladophyll clam clamshell clary claw claytonia cleavers clematis clementine cleome climber
clingfish clintonia clocks clostridium cloudberry clove clover clupeid clypeus cnidarian coachwhip coati cobia cobnut cobra coca cocci coccus
cockateel cockatiel cockatoo cockchafer cocker cockerel cocklebur cockroach cockscomb cockspur coco cocoon cocos codling coelacanth coelenterate
coelenteron cohosh cohune coir cola colchicum cole coleus colewort colicroot collard collie collinsia colobus colt coltsfoot colubrid colugo columbine
colza comatulid comfrey commensal conch condor coneflower conferva congeneric conger conidiophore conidium conifer conium conker conspecific
constrictor convolvulus cony coonhound coontie coot cootie copepod copperhead coreopsis corgi coriander corkwood corm cormorant corn corncrake cornel
cornflower cornhusk cornstalk cornus corolla corydalis corymb costmary cotinga cotoneaster cottonmouth cottonseed cottontail cottonweed cottonwood
cotyledon coucal cougar courgette courlan cowage cowberry cowbird cowfish cowherb cowpea cowrie cows cowslip coyote coypu crab crabgrass crake
cranberry craniate craw crazyweed creamcups creeper cress cricket crinkleroot crinoid critter crocodile crocodilian crocus crop crossbill crossbreed
croton crow crowberry crowfoot crucifer crustacean cryptogam cryptomeria ctenidium ctenophore cubeb cuckooflower cuckoopint cucumber cucurbit cudweed
culex culm cultivar cumin cupule curassow curcuma curlew currajong cushat cutch cuticula cuttle cuttlefish cutworm cycad cyclamen cyclopes cyclostome
cygnet cyme cypress cyprinid cyprinodont cypripedium dabchick dace dachshund daffodil dahl dahlia daikon daisy damselfish damselfly dandelion daphne
darnel darter dasheen dasyure datura dayflower dayfly deadwood dealfish deathwatch decapod deer deerhound defoliator delphinium denticle deodar derris
desmid deutzia devilfish dewberry dhole diamondback dianthus diatom dibranchiate dicentra dickybird dicot dicotyledon digitigrade dihybrid dill dingo
dinosaur diplococcus diplodocus diploid dipteran dittany dobbin doberman dobsonfly dodder dogbane dogfish doggy dogie dogtooth dogwood dollarfish
dolphin dormouse doronicum dotterel dove dovekie dowitcher down dragonet dragonfly dragonhead dromedary drone drosophila drumfish drupe drupelet duck
duckbill duckweed dugong dulse dunlin dunnock duramen durian durmast durra durum dziggetai eagle eaglet earthnut earthstar earthworm earwig echidna
echinacea echinoderm echovirus ectoblast ectoderm ectoparasite ectotherm eddo edelweiss edentate eelgrass eelpout eelworm egger eglantine egret eider
eland elapid elasmobranch elater elaterid elderberry elecampane elemi elephant elkhound elodea elytron embryo emmer emmet endameba endive endoblast
endocarp endoderm endogen endoparasite endosperm endospore entellus enterovirus entire entoblast entoderm entozoon eohippus ephemeral ephemerid
ephemeron epicalyx epicarp epiphyte epizoon equine equisetum erigeron eringo erne eryngo eschalot escolar estragon eucalyptus euglena eukaryote
euonymus eupatorium euphorbia eurypterid eutherian evergreen everlasting exocarp eyas eyra falcon falls feather feeder feeler felid feline female
fennel fenugreek fern ferret fescue fetlock fetus feverfew feverroot ficus fiddlehead fieldfare figwort filaria filbert filefish filly finback finch
fingerling firebird firebrat firefly fireweed fish fishworm fitch flagellate flamboyant flamingo flathead flatworm flea fleabane fleawort flickertail
floret flower floweret flycatcher foal foamflower foliage foraminifer forefoot foreleg forelimb forepaw forewing forsythia foumart fowl foxglove
foxhound foxtail framboise frangipani fraxinella freesia frijol fritillary frog frogfish froghopper frogmouth frond fruit fruitage fuchsia fucoid
fucus fulmar fumitory fungi fungus funicle funiculus furcula furze fuzz gadoid gaillardia galangal galea galingale galleria gallfly gallinacean
gallinule gamecock gametangium gametophore gametophyte gander ganja gannet ganoid garbanzo gardenia garfish garganey garget garlic garpike gaskin
gastropod gastrula gator gaultheria gaur gavial gazelle gean gecko gelding gelsemium gemma gemsbok genip genista gentian gentianella geometrid
geophyte geranium gerbil gerenuk gerfalcon germander geum giant gillyflower ginger ginkgo ginseng giraffe gizzard glad gladiola gladiolus glasswort
globefish globeflower globigerina glochidium glomerule glowworm gloxinia glume gnat gnatcatcher gnawer goat goatfish goatsbeard goatsucker goby godwit
goldcrest goldeneye goldenrod goldenseal goldfields goldfinch goldfish goldilocks goldthread gomuti gonococcus goosander goose gooseberry goosefish
goosefoot gopherwood goral gorilla gorse goshawk gosling grackle grampus granadilla grapefruit grass grasshopper grayback greasewood grebe greenbrier
greenery greenfly greenling greenshank gregarine greyhen greyhound greylag grindelia grison grivet grizzly gromwell grosbeak groundhog groundnut
groundsel grubby grugru guacharo guaiacum guan guanaco guar guava guayule gudgeon guenon guereza guib guillemot guitarfish gulfweed gumwood guppy
gurnard gymnosperm gynoecium gynophore gyps gypsophila gyrfalcon hackberry hackle hadrosaur haematoxylon hagberry hagfish hairstreak hairtail halfbeak
halm halophyte hamster hangbird haploid hare harebell haricot hartebeest harvest harvestman hatchling haulm haustorium hawfinch hawk hawkbill hawkweed
hawthorn hazel hazelnut heartsease heartwood heath heather hedgehog heifer helianthus heliozoan hellbender hellebore helminth hemipode henbane henbit
hepatic hepatica herb herbage herbivore hexapod hibiscus hickory hind hinny hippopotamus hoactzin hoatzin hogfish hogweed holly hollyhock holothurian
homeotherm hominid hominoid honeybee honeypot honeysucker honeysuckle hoof hookworm hoopoe hops horehound hornbeam hornbill hornet hornwort horse
horseback horsefly horseleech horsemint horseradish horsetail horseweed hosta hound housefly houseplant huckleberry hull human humankind humans
humblebee hummingbird husky hydrangea hydrastis hydroid hydrophyte hydrozoan hyena hyla hymenium hymenopteran hyoscyamus hypanthium hypha hypoblast
hypoderma hypodermis hyrax hyssop ibex ibis ichneumon ichthyosaur iguana iguanodon ilex immortelle impala inchworm indusium infusorian inkberry insect
insectivore instar internode invertebrate involucre iris ironweed ironwood isopod ixia jabiru jacamar jacaranda jackal jackdaw jackfruit jackrabbit
jacksmelt jacksnipe jaeger jaguar jaguarundi jalapeno japonica jasmine jaybird jellyfish jennet jerboa jewelweed jewfish jimsonweed jointworm jonquil
jujube junco juniper kail kaki kali kalmia kangaroo kaoliang karakul katydid keeshond kelp kenaf kernel kestrel kiang killdeer killifish kine kingbird
kingcup kingfisher kinglet kingwood kinkajou kitten kittiwake kiwi knapweed knawel knotgrass koala kohlrabi kola koodoo kookaburra krait krill kudu
kudzu kumquat kurrajong kuvasz lablab laburnum lacewing ladanum ladybird ladybug lagomorph lamb lambkin lamella lammergeier lamprey lancelet lancewood
langur lantana lapdog lapwing larch lark larkspur larva launce laurel lavender leadwort leaf leafage leafhopper leafstalk leatherback leatherleaf
leatherwood leech leek legume leishmania lemming lemur lenticel leopardess lepidopteran leporid leporide leveret liana licorice liger ligule lilac
lily limpkin limulus linden ling lingonberry linnet lintwhite lion lioness lionfish liquidambar liriodendron listeria litchi lithophyte livelong
liverwort livestock lizard llama loach lobelia lobworm locoweed locust loganberry logwood loment longan longhorn longicorn loofah looper loosestrife
loquat lorica lorikeet lory lotus louse louvar lovage lovebird lucerne luffa lugworm lumpfish lungfish lupine lychnis lycopodium lyrebird macadamia
macaque macaw macrospore madder mademoiselle madrepore madrona madrono madwort maggot magnolia magpie maguey mahogany maidenhair maiger maize mako
malamute male malemute mallard mallee mallow malvasia mamba mamey mammal mammalian mammoth manatee mandarin mandragora mandrake mandrill mane mango
mangosteen mangrove mankind manna mantis manzanita maple marabou marabout marasca mare margay marguerite marigold marijuana marjoram markhor marlin
marmoset marmot marsupial marten massasauga mastiff mastodon mavis mayapple mayfly mayweed mazzard meadowlark mealie mealworm mealybug medic medick
medlar meerkat megaspore megathere melilot meloid menhaden merganser merino meristem merle merozoite mescal mesenchyme mesoblast mesocarp mesoderm
mesquite metatherian mezereon mezereum microbe micrococcus micropyle microspore midge midrib mignonette milker milkweed milkwort millet millipede milo
mimosa minnow mistletoe miterwort mockingbird moke mola mollusk molly molter monarda moneywort mongoose monkey monkshood monocot moonfish moonseed
moonwort moorfowl moorhen moorwort moose moray morel morello morula mosquito moss moth motherwort motmot mouflon mount mouse mouser mouthpart mucor
mudskipper mulberry mule mullein mung muntjac murine murre muscadine muscat mushroom muskmelon musquash mustang mustard musteline mutt mycelium
mycobacteria myna myosotis myriapod myrica myrobalan myrrh myrtle myxomycete myxomycetes naiad narcissus nardoo narwhal nasturtium natterjack
neanderthal nectarine needle needlefish nekton nematode nemertean neophyte nestling nettle newt nicotiana nightingale nightjar nightshade nightwalker
nilgai nipa noctiluca nostoc notochord notornis nucellus nudibranch numbat numbfish nummulite nuthatch nutlet nutmeg nutria nutshell nylghau nymphaea
nymphalid oarfish ocelot ocotillo octopod oilbird oilseed okapi okra oldwife oleander oleaster oligochaete olive omasum onion oosphere oospore opah
operculum ophidian opossum opuntia orang orangewood orangutan orca orchid oregano oriole ornamental ornithopod orpine orris orthopteran ortolan oryx
oscine oscines osier osprey ostiole ostracod ostracoderm ousel ouzel ovary ovenbird ovipositor ovule owlet oxalis oxen oxheart oxtail oyster pacer
pachyderm pachysandra packhorse padauk paddlefish pademelon paeony palfrey palmetto palomino panda pandanus pangolin panicle pansy panther papaya
papilla papillon pappus paprika parakeet paramecia paramecium parapodium parasite parrot parrotfish parsley parsnip pasqueflower passerine pastern
pasturage patchouli pathogen pawpaw peach peacock peafowl peahen peanut peasecod peba pecan peccary pedicel pedicle peepul peewit pekan peke pekingese
pelage pelargonium pelecypod pelican pellicle pellitory penguin penicillium pennyroyal penstemon peony pepper peppermint peregrine perennial perianth
pericarp peridium peristome perithecium periwinkle persimmon petal petiole petiolule petrel petunia pewee pewit peyote phage phalanger phalarope
phallus phanerogam pheasant philodendron phloem phlox phylloclade phyllode phylloxera pickerelweed piddock pigeon pigfish piggy piglet pignut pigweed
pika pileus pilewort pimento pimiento pimpernel pine pineapple pinfish pinna pinnatiped pinniped pinnule pinon pintail pinto pinwheel pinworm pinyon
pipistrelle pipit pipsissewa pirana pismire pistachio pistil pitanga pith pitta placenta placental planarian plankton plantain plantigrade planula
plasmodium plastid platy platypus plectognath pleopod plesiosaur plesiosaurus plover plum plumage plumcot plumule pneumococcus pochard pogge pogonia
poikilotherm poinciana poinsettia poke pokeweed polecat poler pollard pollen pollinator polliwog polyanthus polychaete polyploid polypody polyzoan
pome pomegranate pomelo pomfret ponderosa pondweed pongid pony pooch poodle poon popcorn poplar poppy porbeagle porcupine porker porpoise portulaca
possum potentilla potoroo potto poultry prancer pratincole pricker prickle primates primrose primula privet proboscidean prokaryote promycelium
pronghorn prosimian prothorax protist protium prototherian protozoa protozoan prunella psalterium pseudocarp pseudopod ptarmigan pteridophyte
pterodactyl pterosaur puccoon puffball puffin puma pumpkin pumpkinseed punkie pupa puppy purebred purslane puttyroot pycnidium pyralid pyrethrum
pyrrhuloxia python pyxidium pyxie quadruped quagga quamash queen quince rabbit rabbitfish racehorse raceme rachis radiolarian ragi ragweed ragwort
rambutan ramie ranunculus rape rapeseed raptor rasher raspberry ratel ratite rattan rattlebox rattler rattlesnake raven razorback razorbill
recombinant redbird redbreast redbud redbug redpoll redroot redshank redstart redwing redwood reed reedbird reeve reindeer relict remora remount
reptile reptilian reseda restharrow retriever retrovirus rhesus rhino rhinoceros rhinovirus rhizobium rhizoid rhizome rhizopod rhododendron ribbonfish
ribbonwood ribwort ricebird rickettsia ridgeling ringdove ringhals ringtail roadkill roadrunner robalo robin robinia roble rocambole rockrose rockweed
rodent roebuck rooster root rootlet rootstock rorqual rose rosebay rosebud rosebush rosemary rosewood rosinweed rotifer rottweiler rowan rudbeckia
rudd ruddles rumen ruminant rump safflower saffron sagebrush saguaro sahuaro saiga sainfoin salamander salientian sallow salmon salmonberry salmonella
salpa salpiglossis salsify saltwort salvia samba sambar samphire sandalwood sandarac sanderling sandfly sandpiper sang sanguinaria sapling sapodilla
saprophyte sapsucker sapwood sargasso sargassum sarracenia sarsaparilla sassaby sassafras satinwood satsuma saturniid saurel saurian saurischian
sauropod saury savory sawfish sawfly saxifrage scabious scad scallion scammony scape scapular scarab scarabaeid scarabaeus schipperke schistosome
schnauzer scilla sclerite scorpaenid scorpaenoid scoter sculpin scut scute scyphozoan seabird seagull seahorse seashell seaweed sedge sedum seed
seedcase seedling seedpod selachian selaginella senega senna sepal sequoia seriema serin serotine serow serpent serranid serval serviceberry sesame
seta sewellel shadbush shaddock shagbark shallot shamrock shanny shark shearwater sheatfish sheep sheepdog sheepshead shelduck shellbark shigella
shiitake shinleaf shipworm shoat shoebill shoot shorebird shorthorn shote shovelhead shrewmouse shrike shrub siamang sidewinder sika sild silicle
siliqua silique silkweed silkworm silurid silverfish silverside silversides silverweed simarouba simian simple siphonophore siskin skink skipjack
skirret skua skylark slater slipperwort sloe slowworm smew smilax snail snailfish snake snakebird snakeroot snapdragon snipe snook snout snowball
snowberry snowbird snowdrop soapberry soapwort solan solanum solidago soma somite songbird sorghum sorgo sorrel sorus soursop sourwood soybean
spadefish spadix spaniel sparid sparrow spathe spawn spawner spearfish spearmint speedwell spermatozoid spermophile sphagnum spiceberry spicebush
spider spiderwort spikelet spinach spirea spirilla spirillum spirochete spirogyra spirula spittlebug spitz spleenwort spoonbill sporangium spore
sporocarp sporophore sporophyll sporophyte sporozoite sprig springbok springtail sprout spruce spurge squama squash squill squirrel stablemate stag
staghound stallion stamen staph starfish starflower starling starwort stayer steed steenbok stegosaur stegosaurus steinbok stele stephanotis sticker
stickleback sticktight stickweed stifle stigma stingray stinkhorn stinkweed stipe stipule stirk stoat stolon stoma stonechat stonecrop stonefish
stonefly stonewort storax stork strangler strawflower strawworm stray strep streptococci strobile strophanthus studhorse stump sturgeon stylet
stylopodium styrax subshrub succory succulent suckerfish sugarcane sumac sumpter sundew sunflower superbug surfbird surfperch surgeonfish suricate
surmullet suslik swan sweetbrier sweetsop swiftlet swine swordtail sycamore syconium syringa tabby tadpole tail tailorbird taipan takin talapoin talon
tamandua tamarack tamarau tamarin tamarind tamarisk tanager tanbark tangelo tangerine tansy tapeworm tapir taproot tarantula taraxacum tardigrade taro
tarpan tarpon tarragon tarsier tarweed tatouay tautog tayra teaberry teak teakwood teasel teleost teliospore tench tendril tenrec tercel teredo
termite tern terrapin terrier testa tetra tetrapod tetraspore thallophyte thallus theca therapsid theropod thickhead thimbleweed thistle thistledown
thoroughwort threadfin thrift thrips thuja thylacine thyme thymus thyrse thyrsus tiercel tigon tigress tilapia tilefish tillandsia tiller timothy
tinamou tineid titi titlark titmouse toad toadfish toadflax toadstool tody tolu tomcat tomtit toothwort topminnow torsk tortoise tortricid toucan
touraco towhee tracheid tradescantia tragopan tree treehopper treetop trefoil trematode trepang treponema triceratops trichina trichomonad trifolium
triggerfish trillium trilobite tripletail troglodytes trogon trophoblast trophozoite trotter truffle trumpets trunk trunkfish tsetse tuatara tuber
tuberose tulip tulipwood tumblebug tumbleweed tuna tunicate tupelo turaco turkey turmeric turnip turnstone turtledove tusker tussah tussore twayblade
twig twinberry twinflower tyrannosaur udder uintathere umbel underfur underpart undershrub underwing unguiculate ungulate univalve urial uropygium
urus valerian vanda vanilla vanillin vedalia veery velum ventriculus verbena verdin verdure veronica vertebrate vervain vervet vespid vetch vetchling
vibrio vibrissa viburnum villus vine vinegarroon viola violet viper vireo virion virus viscacha vitellus vole volva volvox vorticella vulture wader
wagtail wahoo walkingstick wallaby wallflower walrus wapiti warble warrigal warthog wasabi waterbird waterbuck watercress waterfowl watermelon waxwing
waxwork weaverbird webfoot webworm weed weevil weigela weka weld wether wheat wheatear wheatworm whelp whidah whin whinchat whippet whippoorwill
whitefly whitetail whitethorn whitethroat whitewood whooper whortleberry whydah wicopy wigeon wildebeest wildflower wilding willet willow windflower
wing wintergreen wirehair wireworm wisent wishbone wisteria witchgrass withers withy woadwaxen wolf wolffish wolfhound wolfsbane wombat woodbine
woodborer woodchuck woodcock woodlouse woodpecker woodruff woodsia woodwaxen woodworm worm wormseed wormwood wort wrack wrasse wreckfish xerophyte
xylem yarrow yautia yellowbird yellowhammer yellowlegs yellowtail yellowthroat yellowwood young yucca zamia zanthoxylum zebra zebrawood zebu zinfandel
zinnia zooid zoophyte zooplankton zoospore zoril zoysia zucchini zygospore`);
export const NATURE = set(`abaca abiogenesis abradant abrasive absorbent absorber abysm abyss acaricide acceptor acclivity acetal acetaldehyde acetamide acetate acetone acetum
acetyl acetylene achondrite acicula acid acrolein acrylamide acrylic actin actinide actinium actinoid actinolite actinon activator active actomyosin
acyl adamant adduct adenine adenosine adermin adhesive adjunct adobe adsorbate adsorbent adulterant adulterator aerie aerobiosis aerolite aerosol aery
affinity aflatoxin afterdamp aftereffect afterglow aftermath agar agate agent agglomerate agglutinin agglutinogen airstream alabaster alanine alar
albite albumen albumin albuminoid alcahest aldehyde aldol aldose aldosterone aleurone alexandrite algin alizarin alkahest alkali alkaloid alkane
alkene alkyd alkyl alkyne allergen alligator allomorph allotrope allotropy alloy alluvium allyl almandine almandite alpaca alps altocumulus
altostratus alum alumina aluminate aluminum amalgam ambergris amblygonite ambrosia americium amethyst amide amine amino aminoplast ammine ammonia
ammoniac ammonite ammonium amperage amphibole amphibolite amygdalin amygdaloid amyl amylase amyloid amylum andesite andradite androgen androsterone
aneurin anhydride anil aniline anime anion anionic anorthite antacid anthill anthracite antibaryon antibody anticatalyst antifreeze antigen antiknock
antilepton antimatter antimony antineutrino antineutron antioxidant antiparticle antiproton antitoxin antitrades antivenin antlia apatite aphanite
aplite apoenzyme apoptosis aquamarine aquifer aragonite archil archipelago arete argent argentite argil argillite arginine argon arrowroot arroyo
arsenate arsenic arsenical arsenide arsenopyrite arsine asafetida asbestos ascent asparagine asphalt astatine asteroid astrakhan atoll atom attar
attraction augite aureole austenite autogenesis auxin aventurine azide azote azurite babbitt backwash backwater bactericide bacteriostat badlands
bagasse balas baleen ballistics balm bank barf barite barium barm baryon baryta barytes basalt batholith bauxite bayou bdellium beach beachfront
bearskin beaver bedrock beebread beeswax belay benjamin bentonite benzene benzine benzoate benzofuran benzoin benzol benzyl berg berkelium berm beryl
beryllium betaine bicarbonate bichloride bichromate bighorn bilestone bilge bilirubin billabong bimetal binary biocatalyst biomass biotin biotite
birdlime bismuth bister bitartrate bitumen bize blackbody blackdamp blacking blacktop blacktopping blende blizzard bloodstone blotter blubber
bluestone bluff bluing bohrium bole bolide bolt bonanza bond borate borax bornite boron borosilicate boson bottomland botulin boulder brae brainwave
bran brass breccia breeze brickbat brimstone brine briny brisance broadtail bromeosin bromide bromine bromoform bronze brook brooklet brownstone
brucine brushwood bubble buckyball buffer builder burrow butadiene butane butanol butanone butene butte butterfat butyl butylene butyrin byproduct
cabochon cacodyl cadaverine cadmium caffeine cairngorm calamine calciferol calcite calcium calculus caldera calfskin caliche californium calomel calx
camphor canal candlelight cannabin canyon caoutchouc capacitance cape capillarity capsaicin carbamate carbide carbohydrate carbon carbonado carbonate
carbonyl carborundum carbuncle carcinogen cardboard carina carnallite carnelian carnotite carotene carotenoid carrageenan cascade cascades casein
cassava cassiterite castor cataclysm catalase catalyst catechin cation caulk caulking caustic cave cavern cavity celestite celluloid cellulose
cellulosic cement cementite ceresin cerium cerumen ceruse cerussite cesium chabazite chad chaff chalcanthite chalcedony chalcocite chalcopyrite chalk
chalkstone chalybite chamaeleon chamois champaign char charcoal chasm chelate chemical chert chicle chinchilla chinook chip chipboard chitin chlorate
chloride chlorine chlorite chloropicrin chloroprene chokedamp cholesterol choline chondrite chondrule chop chromate chrome chromite chromium chromogen
chromophore chromosphere chrysoberyl chrysolite chrysoprase chrysotile chuckhole chyme cinchonine cinder cinnabar cirque cirrocumulus cirrostratus
citrate citrin citrine clapboard clay cliff climb clinker cloud cloudburst coagulant coagulase coagulator coal coast coastland cobalt cobaltite
cochineal codon coenzyme coke collodion colloid colophony columbite columbium combustible comet compost concentrate concrete condensate conductance
conduction conductivity confluent congener conglomerate conjugate consequence constantan contaminant continent contrail coolant copaiba copal copalite
copolymer copper coprolite cordierite cordovan cordwood cork corkboard cornelian cornflour cornstarch corona corposant corpuscle corrie corrosive
cortisol cortisone corundum cosmos cotton coumarone counterglow cove covering cowhide cowskin crack crackling crag crap crater craton creatine creek
creosol creosote crepe cresol crevasse cristobalite crock crosswind crud crude crush crust crux cryogen cryolite crystal crystallite cudbear
cumulonimbus cumulus cuprite cupronickel curare curium current cutin cyanamide cyanide cyanite cyanogen cyanohydrin cyclosis cymene cysteine cystine
cystolith cytochrome cytolysin cytosine dale damar dammar dander daub daystar debris decalescence declivity deerskin defile defoliant dehiscence dell
delta demantoid denaturant dent dentin deoxyribose depilatory deposit derv desiccant desideratum detergent detritus deuterium deuteron dextrin
dextrose diamagnet diamagnetism diamine diapedesis diatomite diazonium dichloride dichroism dichromate dielectric diffraction digenesis digestive
digitalin digitalis diluent dilution dimer dimorphism dimple dingle diorite dioxide dioxin dipole dirt disaccharide discard dishwater dissolvent
distillate distributary divot doeskin dolomite dopa dopamine dorado dottle downdraft downhill downpour drag draw dregs drier drift driftwood dripstone
drizzle droppings dross drumlin dubbin dubnium dune dung dust duster dyestuff dyewood dysprosium earth earwax easterly ebonite ectoplasm effect
effluent effluvium eggshell einsteinium elastance elastomer electricity electrolyte electron electrum elements eliminator elixir elves emanation
embayment ember emerald emery emmenagogue emulsifier emulsion enantiomorph endorphin endotoxin energy enol enzyme eosin ephedrine epoxy erbium
ergosterol ermine erythrite escarpment esker essential essonite ester estradiol estriol estrogen estrone estuary ethane ethanol ethene ether ethyl
ethylene ethyne eureka europium eutectic evaporite everglades excelsior exchange excrement excreta exfoliation exhalation exhaust exon exosphere
exotoxin extract exudate exudation eyre facula fallout fallow faulting feces fecula feedstock feldspar fell fenland fermion fermium ferricyanide
ferrite ferritin ferrocyanide fertilizer fiber fiberglass fibril fibrin fibrinogen fibrinolysin fieldstone filament filler filling filth filtrate
fireball firebrand firedamp firelight firelighter firestone firestorm firewood fishpond fixative fjord flake flashover flat flavin flavone flax
flaxseed fleck fleece flimsy flint floc floccule floe flood floodplain flotation fluff fluid fluke flume fluor fluorescein fluorescence fluoride
fluorine fluorite fluorocarbon fluorspar flypaper flyspeck foam foehn folacin folium fomentation foothill footwall foreland foreshore formaldehyde
formalin formicary formulation forth fortune fraction fragment francium frankincense freshwater frost froth fructose fuel fullerene fulminate fume
fumes fumigant furan furfural furfuran gabbro gadolinite gadolinium galactagogue galactose galbanum gale galena gallium gallstone galvanism gamboge
garbage gargle garnet garnierite gaslight gasohol gasoline gegenschein gelatin gemstone geode geosphere germanium gesso geyser gibbsite girasol
glacier glass glauconite glen globe globin globule globulin glop glowing glucose glucoside glue gluon glutamate glutamine glutelin glyceride glycerin
glycerite glycerol glyceryl glycine glycogen glycol glycoprotein glycoside glyoxaline gneiss goatskin goethite goldstone gook goop gorge grain granite
granule graphite gravel gravitation graviton gravity grease greaves greening greenockite greensand greensward greenwood greisen grinding grit grot
grotto ground groundmass grout grume guanine guano guck gulch gulf gully gumbo gummite guncotton gunk gunmetal gunpowder gust guyot gypsum hadron
hafnium hahnium hail hailstone hailstorm hairball halide halite halitosis halocarbon halogen halon hammock hardboard hardpan hardwood harmattan
hassium haze hazmat headland headstream headwind heat heliotrope helium hematin hematite heme hemimorphite hemin hemlock hemoglobin hemolysin hemp
henna heptane herbicide heterocyclic heulandite hexane hexose hiddenite hide highland hill hillock hillside histaminase histidine histone hoar
hoarfrost hogback hole holmium holystone honeycomb hornblende hornstone horsehair horsehide horst humectant hummock humus hurricane husk hyacinth
hyaline hydrargyrum hydrate hydrazine hydride hydrocarbon hydrogen hydrosphere hydroxide hydroxyl hyperon hypo hypochlorite hysteresis iceberg icecap
icefall ichor icicle idocrase igniter illuminant ilmenite imidazole imide impedance impetus impregnation impulsion impurity incense incline indene
indigo indigotin indium inducer inductance inessential infusion ingrowth inhalant inhibitor inlet inoculant inoculum inositol insecticide insulator
interleukin intermediate interrupt inulin inundation inversion invertase iodide iodine iodoform iridium iridosmine iron isinglass island isle islet
isoleucine isomer isopropanol isotope isthmus ivory jacinth jade jadeite jaggery jasper junk jute kainite kaolin kaolinite kaon kapok kauri keratin
kernite kerosene ketone ketose khamsin kidskin kieselguhr kieserite kimberlite kinase kindling kinin kino knoll knothole kopje kraft krypton kunzite
kyanite labdanum lachrymator lacquer lacrimator lactalbumin lactase lactate lactoflavin lactose laetrile lagging lagoon lake lakefront lakeside
lambskin lampblack lamplight landfall landfill landmass lanolin lanthanide lanthanum lapin larvicide laterite latex lather latten lava lawrencium
lazuli leak leather leaven lecithin ledge lees lemongrass leopard lepidolite lethe leucine levant levanter leverage levitation levulose lick ligand
light lighter lightning lignin lignite lime limestone limewater limonene limonite linalool lindane lino linoleum linseed lint lipase lipid lipoid
lipoprotein liquid lithium lithosphere litmus llano loam lode lodestar lodestone loess logan lough lowland lube lubricant lubricator luciferin lumber
luminescence lute lutetium luting lysin lysine lysozyme macadam mace macrocosm macula magma magnesia magnesite magnesium magnetism magnetite main
mainland malachite malathion maleate malonylurea maltha maltose manganate manganese manganite manila manioc manure marble maria marl marlite mars
marsh marshland martensite mash massicot massif mastic matchwood material matte meander medulla meerschaum megilp meitnerium melamine melanin
meltwater menadione mendelevium menstruum menthol mephitis mercury mere mesa meson mesosphere mesotron metabolite metagenesis metal meteor meteorite
meteoroid methane methanol methionine methyl methylene mica micelle microwave midstream millboard millerite millpond mineral minium mink mirage mire
mischance mishap mispickel mist mistral mixture mizzle mobile mocha moderator molecule molehill molybdenite molybdenum monad monazite monocline
monoclonal monomer monoxide monsoon moon moonbeam moonlight moonshine moonstone moorland moraine morass mordant morganite mote mountain mountainside
mouthwash mucilage mucin muck mucoid mull muon mush musk muskrat must mutagen myelin myeline myoglobin myosin nacre nanotube napalm naphtha
naphthalene naphthol narrow nebula necessary necrosis nectar negatron neodymium neon neoprene nepheline nephelinite nephrite nephrolith neptunium ness
nest neutrino neutron newsprint niacin nickel nicotine nimbus niobium niter nitramine nitrate nitride nitrile nitrite nitrobenzene nitrogen nobelium
nonconductor nonessential nonmetal nonsteroidal northeaster norther northerly northwester notepad nova nubbin nuclease nucleon nucleoside nucleotide
nugget nylon oakum obliterator obsidian ocean oceanfront octane offshoot ohmage olefin olein oleoresin olibanum oligoclase olivenite olivine olla
onionskin onyx ooze opacity opal opening opsonin ordure organic ormolu ornithine orpiment orthoclase osmium ottar otter outcrop outcropping outgrowth
outpouring overburden overpressure overstrain oxalate oxbow oxidant oxidase oxide oxidizer oxime oxyacetylene oxyacid oxygen ozone ozonide ozonosphere
pacific packing pahoehoe palladium palmitin pancreatin pantile papain paper paperboard papyrus paraffin paraldehyde parallax paraquat parathion
parchment parget pargeting pargetting parhelion paring particle particulate paste pasteboard paving peat pebble pectin peeling pegmatite pelt
peneplain peninsula pentlandite pentose pepsin pepsinogen peptidase peptide peptone perchlorate perchloride percolate peridot peridotite permafrost
permalloy permanganate peroxidase peroxide perspex pesticide petrol petrolatum petroleum pewter phellem phenol phenolic phenylamine pheromone
phlogiston phlogopite phosgene phosphatase phosphate phosphine phospholipid phosphor phosphorus photon photosphere phytohormone piddle pigment pigskin
pinchbeck pinetum ping pinite pion piperine piss pitchblende pitchstone placer plage plagioclase plain planet planetesimal planetoid plank planking
plasmid plasmin plaster plastic plasticine plasticizer plateau platelet platinum pleochroism pleomorphism plumbago pluton plutonium poison
polarization polder polestar pollutant polonium polyamide polyester polyethylene polymer polymerase polymorphism polypeptide polystyrene polythene
polyurethane pond poop porphyrin porphyry positron potash potassium pothole powder praseodymium precipice precipitant precipitate precipitin precursor
prednisone preservative pressure prion progesterone progestin prolactin prolamine proline promethium promontory propane propellant propene propulsion
propylene protactinium protamine protease protein proteinase prothrombin proton provitamin pruning psilomelane ptomaine ptyalin puddle puff pulp
pulpwood pulsar pumice purine putrescine putty pyrene pyridine pyridoxine pyrimidine pyrite pyrites pyrogallol pyrogen pyromorphite pyrope
pyrophyllite pyroxene pyroxylin pyrrhotite quag quagmire quark quartz quartzite quasar quassia quicklime quicksilver quinone quintessence raccoon
raddle radiance radiation radiator radical radiocarbon radioisotope radiopacity radiothorium radium radon raffia raffinose rain rainbow raindrop
rainfall rainier rainstorm rainwater rapid ratsbane rauwolfia raveling ravine rawhide reactance reactant reagent realgar rebirth recycling redshift
reducer reductase reef refraction refrigerant refuse regulus rejuvenation relaxer reluctance remains remover render renin rennet rennin repellent
repercussion represser repressor repulsion requisite residue resin resinoid resistivity resolvent resonance resorcinol response restrainer result
retardant reticulum retinal retinol rhenium rheum rhinestone rhodium rhodolite rhodonite rhyolite ribbon riboflavin ribonuclease ribose ridge rift
rill rime rinse river riverbank riverbed riverside rivulet roan rock rosin rotenone rottenstone roughcast rubber rubbing rubbish rubble rubidium
ruddle runnel rust ruthenium rutile saccharase saccharide saccharose saddleback safranine sago saleratus salicylate saline salol salt saltpeter
saltwater samarium samarskite samiel sand sandbank sandbar sandblast sandpaper sandpit sandstone sandstorm saponin sapphire sapphirine saprolite saran
sard sardius sardonyx sawdust scablands scandium scarp scavenger scheelite schist schorl scissure scorcher scoria scrap scraping scraps scree scurf
seabed seaboard seaborgium seacoast sealant sealer sealskin seamount seashore seaside seawater sediment seine selenium serendipity serine serotonin
settlings sewage sewerage shag shake shale shallow shear sheepskin sheet shellac shingle shingling shit shoal shoddy shore shoreline shortener shuck
siccative siderite sienna sierra silica silicate silicon silicone siloxane silt siltstone silva silver sima simoom sinkhole sirocco sisal sizing skim
slack slag slating sleet slime slipstream sliver slope sludge slurry slush smaltite smoke smut snow snowcap snowdrift snowfall snowfield snowflake
snowstorm snuff soaker soapstone soapsuds soda sodalite sodium softener softwood solder solid solute solution solvent soot sourdough southeaster
souther southerly southwester spall spar spectrum spelter spermaceti sphalerite spica spice spiegeleisen spill spillover spindrift spinel spit splint
splinter splinters spodumene sponge spoondrift spoor spray sprinkle sprites spume spunk squall stabilizer stacte stainless stalactite stalagmite stalk
stannite star starch starlight steam stearin steatite steel steep steppe sternutatory steroid sterol stibnite stiffener stilbestrol stone storm strain
strait stratosphere stratus straw strawboard stream streambed streamer streaming streamlet stressor stretch strip stripper strontianite strontium
strophanthin strychnine stub stubble stucco stuff styrene styrofoam subcontinent sublimate subsoil substrate sucrase sucrose suction suds suede
sulfate sulfide sulfonate sulfur sultriness sunbeam sunburst sundog sunlight sunshine sunspot sunstone supergiant supernatant supernova surfactant
suspension swale swamp swampland sward sylvanite sylvite synthetic syzygy tableland taconite tailwind talc talcum tallow talus tambac tangle tannin
tantalite tantalum tarmac tarmacadam tarn tartar tartrate taurine teargas technetium tektite telluride tellurium tenderizer teratogen terbium terpene
testosterone tetroxide tetryl thallium thermal thermion thermosphere thiamine thiazine thickener thickening thinner thiouracil thorite thorium
threonine thrombin thrombocyte thrust thulium thunderbolt thundercloud thunderhead thunderstorm thus thymine thymol tideland tidewater tideway till
tillage timber timberland tincture tinder titania titanium tocopherol toluene tombac toner topaz tophus topsoil torchlight tornado torque torrent
tossup touchwood tourmaline toxicant toxin toxoid track traction tragacanth trail trajectory tramontane transferase transparency transudate
transudation trash tremolite triazine tributary trichloride trichroism triglyceride trimer triolein trioxide tripalmitin tripoli tritium tropopause
troposphere trough trypsin tryptophan tuberculin tufa tuff tums tundra tungstate tungsten turbulence turd turf turpentine turps turquoise tusk
twinkler twins twister typhoon tyrosine ultramarine ultrasound ultraviolet umber undercut universe unnilquadium updraft upgrade uphill upland upshot
uracil uraninite uranium uranyl urea urease urethane urine urolith vagabond vale valency valine valley vanadate vanadinite vanadium vapor variable
vela vellum venom verdigris vermiculite vesicant vesicatory vesper vesture vesuvian vesuvianite vicuna vinyl viosterol virga viscose vitamin vitriol
volatile volcanism volcano voltage vomit vulcanite wadding wadi wafer wake wallop wallow wallpaper waste wastewater water watercourse waterfall
waterside waterspout waterway wattage weakener weather weatherboard webbing weedkiller wester westerly wetland wetter whalebone whey whiff whinstone
whirlwind whitener whiteout whitewater wicker wind windage windstorm woad wolfram wolframite wollastonite wonderland wood woodland world wormhole
wulfenite xanthate xanthine xanthophyll xenogenesis xenolith xenon xylene xylol yeast ylem ytterbite ytterbium yttrium zeolite zephyr zinc zinkenite
zircon zirconia zirconium zootoxin zymase zymogen`);
/** Gerunds and participles whose commonest sense is a THING (flooring, piping, netting, scaffolding, rigging), as opposed to an act (walking, booking, fielding), which stay readable as the rare surnames they are. */
export const THING_PARTICIPLES = set(`awning baffled bagging basting batwing beading bedding bedspring belting bitewing blacking blacktopping bluing bobsled bowstring bracing braiding
building bullring bunting bushing buttressing caning carpeting carving casing casting catling caulking ceiling cladding clearing clothing clustering
coaming coating coping cornhusking coupling cowling cowshed crackling crocheting curbing cushioning damned daybed defeated disabled discomfited
dogsled doomed drawstring dubbing dwelling earring edging elevated engraving enlightened etching facing fagoting fastening featherbed fencing filling
flagging flatbed flaxseed flooring flowerbed fluting following furnishing gathering gearing gilding governed grating hairdressing hairspring
handicapped hanging headspring hemstitching hoarding hopsacking housewarming housing hundred ironing kindling kindred knitting lading lagging landing
lapping latchstring leading legging limited limning lining linseed loading lodging luting mailing maimed mainspring matting meeting mending meshed
middling milling modeling mooring necking netting nogging nothing oersted ordering outbuilding overcasting overlapping packing padding painting paling
paneling pargeting pargetting parking paving picking piling piping planking plating plaything plumbing quartering quilting railing raveling recording
recycling retarded ribbing rigging roadbed roofing sacking scaffolding scantling scattering schilling seating seedbed seizing setting sheathing
sheeting shilling shingling shirting shoestring shoring sickbed siding sizing slating smattering smocking snipping splicing sprinkling stabling
stocking stopping string suiting swathing tacking taping tatting thickening toweling trapping tubing unemployed vaulting veiling veneering versed
wadding wainscoting watershed weighting wellspring wheeling wiring woodcarving woodshed working worsted wounded wrapping`);
