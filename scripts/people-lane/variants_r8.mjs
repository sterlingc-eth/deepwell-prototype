// Round 8 variants. SYNTHETIC. Fixed seeds; dev / holdout / blind use disjoint vocabularies (the code was tuned on dev only).
//   Jw / Js / Jx / Jt   a given name + an everyday NOUN that is no surname ("John Forklift", "Maria Playground", "Dallas Warehouse"), on a WEAK label (Manager, Supervisor, bare Name),
//                       a STRONG label (Driver's Name, Employee Name), on the line AFTER a lone label, and printed twice (header + body, no signature). Must read NOTHING.
//   Jc                  the same with a noun the dictionary does not hold (compounds: "Trenchbox", "Swingset") and plural / -ing nouns ("Girders", "Scaffolding"). Must read NOTHING.
//   Rn                  real surnames that are also nouns ("Anna Park", "Tom Stone", "Eli Hill" ... Wood Baker Mills Fields Rivers Green Black Young King Bird Fox Lane). Recall.
//   Rr                  uncommon real names that are no English word (Spanish, Navajo, Vietnamese given-first, Polish, Welsh, Nigerian ...). Recall.
//   Rx                  rare real surnames that ARE a dictionary noun or a compound of two ("Larkspur", "Thorndike"): the cost of the rule when printed once. Recall (allowed to fall).
//   Rg                  the same rare surnames with a signature line (printed twice, second in a signature position). Recall.
import { rng } from './variants.mjs';
const pick = (r, a) => a[Math.floor(r() * a.length)];
const mec = (lines, extra = [], tail = []) => ["Medical Examiner's Certificate", ...extra, ...lines, "Driver's License Number", 'X1234567', 'Date of Examination 05/05/2024', "Medical Examiner's Certificate Expiration Date 05/05/2026", ...tail].join('\n');
const hr = (lines, extra = [], tail = [], noSup = false) => ['New Hire Checklist', ...extra, ...lines, 'Position', 'Field Technician', 'Start Date 06/03/2025', ...(noSup ? [] : ['Supervisor', 'Dana Sample']), ...tail].join('\n');
const sheet = (k, lines, extra, tail) => (k === 'holder' ? mec(lines, extra, tail) : hr(lines, extra, tail, lines.some((l) => /^(?:Supervisor|Reports To|Manager)\b/.test(l))));
const KEY = (k) => (k === 'holder' ? 'holder_name' : 'employee_name');
const ANYKEY = ['holder_name', 'employee_name', 'manager'];
const WEAK_HR = [(v) => [`Supervisor: ${v}`], (v) => [`Reports To: ${v}`], (v) => [`Manager: ${v}`], (v) => [`Name: ${v}`]];
const weakFr = [(v, k, r) => (k === 'holder' ? [`Name: ${v}`] : WEAK_HR[Math.floor(r() * WEAK_HR.length)](v))];
const strongFr = [(v, k) => k === 'holder' ? [`Driver's Name: ${v}`] : [`Employee Name: ${v}`], (v, k) => k === 'holder' ? [`Holder: ${v}`] : [`New Hire Name: ${v}`], (v, k) => k === 'holder' ? ["Driver's Name", v] : ['Employee Name', v]];
const nextFr = [(v, k) => k === 'holder' ? ["Driver's Name", v] : ['Employee Name', v], (v, k) => k === 'holder' ? ['Licensee', v] : ['New Hire Name', v], (v, k) => k === 'holder' ? ['Holder', v] : ['Employee Name', v]];
const SIG = [(v) => [`Employee Signature: ${v}`], (v) => ['Printed Name', v], (v) => ['__________________', v], (v) => [`Signed: ${v}`]];

const GIVEN = {
  dev: ['John', 'Maria', 'Dallas', 'Grace', 'Robert', 'Linda', 'Austin', 'Susan', 'Carlos', 'Emily', 'Derek', 'Nora', 'Paul', 'Ines'],
  holdout: ['James', 'Sofia', 'Houston', 'Karen', 'Daniel', 'Teresa', 'Marcus', 'Heather', 'Victor', 'Alicia', 'Greg', 'Rachel', 'Omar', 'Beth'],
  blind: ['Michael', 'Elena', 'Phoenix', 'Laura', 'Kevin', 'Diana', 'Andre', 'Megan', 'Hector', 'Janet', 'Brian', 'Priya', 'Tyler', 'Wendy'],
};
const NOUN = {
  dev: ['Forklift', 'Backhoe', 'Scaffold', 'Conveyor', 'Playground', 'Warehouse', 'Compressor', 'Excavator', 'Pavilion', 'Greenhouse', 'Workbench', 'Jackhammer', 'Stockroom', 'Crankshaft', 'Gantry', 'Hydrant', 'Culvert', 'Turbine', 'Bulldozer', 'Sawhorse', 'Toolbox', 'Boardwalk', 'Cafeteria', 'Laundromat', 'Mezzanine', 'Hangar', 'Foundry', 'Brewery', 'Sawmill', 'Gazebo'],
  holdout: ['Elevator', 'Escalator', 'Generator', 'Humidifier', 'Dehumidifier', 'Ductwork', 'Pipeline', 'Shipyard', 'Quarry', 'Fairground', 'Basement', 'Bleachers', 'Stairwell', 'Catwalk', 'Mudroom', 'Crawlspace', 'Carport', 'Driveway', 'Doorway', 'Skylight', 'Rafters', 'Thermostat', 'Manifold', 'Actuator', 'Breaker', 'Extinguisher', 'Respirator', 'Harness', 'Lanyard', 'Pallet'],
  blind: ['Trailer', 'Dolly', 'Winch', 'Bracket', 'Flange', 'Gasket', 'Grommet', 'Spillway', 'Overpass', 'Underpass', 'Breezeway', 'Atrium', 'Rotunda', 'Annex', 'Locker', 'Cubicle', 'Reservoir', 'Cistern', 'Wellhead', 'Wharf', 'Smokestack', 'Chimney', 'Fireplace', 'Skidsteer', 'Cherrypicker', 'Lowboy', 'Sandbox', 'Doghouse', 'Shopvac', 'Pipewrap'],
};
// nouns the dictionary does not hold, plural and -ing nouns
const ODD = {
  dev: ['Trenchbox', 'Swingset', 'Ductbank', 'Rebar', 'Girders', 'Pallets', 'Scaffolding', 'Plumbing', 'Dozers', 'Flooring'],
  holdout: ['Toolcrib', 'Wirepull', 'Hosereel', 'Tiebacks', 'Fittings', 'Sprinklers', 'Shingles', 'Roofing', 'Welding', 'Footings'],
  blind: ['Leadscrew', 'Pumpjack', 'Cableway', 'Jointers', 'Fixtures', 'Cabinets', 'Trusses', 'Decking', 'Piping', 'Insulation'],
};
const NOUNLIKE = ['Park', 'Stone', 'Hill', 'Wood', 'Baker', 'Mills', 'Fields', 'Rivers', 'Green', 'Black', 'Young', 'King', 'Bird', 'Fox', 'Lane'];
const RS = {
  dev: [...NOUNLIKE.slice(0, 8), 'Moon', 'Glass', 'Hammer', 'Pike', 'Castle', 'Silver', 'Swan', 'Crow', 'Hunter', 'Sharp', 'Fisher', 'Carpenter', 'Archer', 'Marsh'],
  holdout: [...NOUNLIKE, 'Frost', 'Lamb', 'Wolf', 'Banks', 'Brooks', 'Woods', 'Bishop', 'Cook', 'Butler', 'Weaver', 'Mason', 'Porter', 'Shepherd', 'Knight', 'Rose', 'Ward', 'Hart', 'Stewart'],
  blind: [...NOUNLIKE, 'Sparrow', 'Finch', 'Crane', 'Hawk', 'Eagle', 'Day', 'Hall', 'Wells', 'Bell', 'Ford', 'Steele', 'Fuller', 'Sawyer', 'Tanner', 'Miller', 'Fletcher', 'Draper', 'Cooper'],
};
const RU = {
  dev: ['Zavala', 'Mondragon', 'Kowalczyk', 'Oyelaran', 'Nakamura', 'Begay', 'Yazzie', 'Penhallow', 'Abernathy', 'Villanueva', 'Szymanski', 'Okonkwo', 'Hartwell', 'Whitfield', 'Ashworth', 'Blackwood'],
  holdout: ['Echeverria', 'Zielinski', 'Adeyemi', 'Tsosie', 'Benally', 'Llewellyn', 'Pennington', 'Hollister', 'Ainsworth', 'Wolfenden', 'Fairbanks', 'Greenwood', 'Lockhart', 'Bradshaw', 'Fenwick', 'Kirkpatrick'],
  blind: ['Barraza', 'Wojciechowski', 'Okafor', 'Etsitty', 'Nez', 'Tidwell', 'Harrington', 'Thistlewaite', 'Dunwoody', 'Applegate', 'Ravenscroft', 'Hargreaves', 'Winslow', 'Cromwell', 'Ellsworth', 'Stanhope'],
};
const RX = {
  dev: ['Larkspur', 'Tamarack', 'Thorndike', 'Wolfram', 'Hawthorn', 'Snowden', 'Marigold', 'Peppercorn'],
  holdout: ['Goldsmith', 'Longfellow', 'Lilac', 'Birdsong', 'Honeycutt', 'Sandstone', 'Starling', 'Wildflower'],
  blind: ['Silverstein', 'Cloverdale', 'Oakenshield', 'Brightwater', 'Rosewood', 'Eaglestone', 'Thornberry', 'Fernandez Moss'],
};
const FIRST_OK = ['Anna', 'Eli', 'Sara', 'Lisa', 'Peter', 'Julia', 'Frank', 'Nina', 'Scott', 'Alice', 'Raul', 'Irene', 'Glenn', 'Joyce', 'Carla', 'Ruth'];


// FRESH vocabulary (round 8 final check): written after the code was frozen, used only through generateR8({ fresh: true }), where it REPLACES the blind pools.
const FRESH = {
  given: ['Jeff', 'Rosa', 'Tucker', 'Hannah', 'Leon', 'Vanessa', 'Ray', 'Gloria', 'Dwight', 'Tamara', 'Nolan', 'Bianca', 'Wade', 'Celia', 'Sidney', 'Charlotte'],
  noun: ['Bandsaw', 'Trencher', 'Silo', 'Fieldhouse', 'Roundhouse', 'Ballfield', 'Pontoon', 'Skylift', 'Treadmill', 'Powerhouse', 'Stockyard', 'Wheelbarrow', 'Crossbeam', 'Spreader', 'Aqueduct', 'Plenum', 'Cleanout', 'Hardhat', 'Tailgate', 'Boardroom', 'Breakroom', 'Lunchroom', 'Anvil', 'Pulley', 'Sprocket', 'Camshaft', 'Pushcart', 'Tarmac', 'Trellis', 'Gutter', 'Downspout', 'Firewall', 'Subfloor', 'Drywall', 'Plywood', 'Mortar', 'Sealant', 'Respirator', 'Forklifts', 'Outbuilding', 'Greensward', 'Parkade', 'Bunkhouse', 'Slipway', 'Gearbox', 'Tubing', 'Rigging', 'Netting', 'Crating', 'Ironworks', 'Datacenter', 'Switchgear', 'Busway', 'Raceway', 'Wireway', 'Minibus', 'Hardscape', 'Backflow'],
  odd: ['Stairlift', 'Hoistway', 'Swingarm', 'Dripline', 'Shopfront', 'Lathes', 'Tractors', 'Bearings', 'Cladding', 'Sheeting', 'Grating', 'Mullions', 'Soffits', 'Corbels', 'Joists', 'Purlins', 'Formwork', 'Falsework', 'Shoring', 'Hoarding'],
  rs: ['Hunt', 'Cross', 'Ball', 'Lord', 'Rice', 'Price', 'Gill', 'Dean', 'Page', 'Barber', 'Marshall', 'Chase', 'Rush', 'Frost', 'Hayes', 'Stark', 'Rose', 'Gray', 'Wells', 'Lake', 'Park'],
  ru: ['Calderon', 'Montoya', 'Kozlowski', 'Chukwu', 'Tsinajinnie', 'Nguyen', 'Haskell', 'Prewitt', 'Gallagher', 'Langford', 'Whitlock', 'Ashcroft', 'Thornton', 'Redfern', 'Strickland', 'Bannister'],
  rx: ['Quicksilver', 'Moonstone', 'Windham', 'Gooseberry', 'Cornflower', 'Sunderland', 'Ironside', 'Hummingbird'],
  first: ['Alan', 'Beth', 'Cora', 'Dean', 'Erin', 'Gary', 'Hope', 'Ivan'],
};

// FINAL vocabulary: written after the FRESH check and the code change that followed it; generateR8({ final: true }) uses it in place of the blind pools. Run once.
const FINAL = {
  given: ['Curtis', 'Monica', 'Elliot', 'Yvonne', 'Roman', 'Tasha', 'Floyd', 'Lorena', 'Quentin', 'Dolores', 'Arturo', 'Sheila', 'Milo', 'Gretchen', 'Raymond', 'Alma'],
  noun: ['Grinder', 'Pressroom', 'Boilerhouse', 'Coldstorage'.replace('Coldstorage', 'Freezer'), 'Smokehouse', 'Drydock', 'Loadout', 'Windmill', 'Watertower'.replace('Watertower', 'Standpipe'), 'Crossover', 'Fairway', 'Greenbelt', 'Overhang', 'Underfloor', 'Mainframe', 'Switchboard', 'Handrail', 'Guardrail', 'Stepladder', 'Sidewalk', 'Crosswalk', 'Bikeway', 'Footbridge', 'Treeline', 'Tollbooth', 'Turnstile', 'Concourse', 'Vestibule', 'Colonnade', 'Belvedere', 'Gymnasium', 'Planetarium', 'Aquarium', 'Observatory', 'Conservatory', 'Dormitory', 'Cathedral', 'Courthouse', 'Firehouse', 'Jailhouse', 'Bathhouse', 'Henhouse', 'Gatehouse', 'Storehouse', 'Cookhouse', 'Millrace', 'Bypass', 'Cloverleaf', 'Roundabout', 'Cul-de-sac'.replace('Cul-de-sac', 'Causeway'), 'Breakwater', 'Seawall', 'Jetty', 'Marina', 'Boathouse', 'Dockyard', 'Shipwright'.replace('Shipwright', 'Drydocks')],
  odd: ['Skidplate', 'Dumpbox', 'Rollcage', 'Cabletray', 'Pipehanger', 'Beamclamp', 'Ductwrap', 'Pumpskid', 'Valvebox', 'Fuelcell', 'Hoists', 'Winches', 'Pulleys', 'Couplers', 'Reducers', 'Retaining', 'Backfilling', 'Grading', 'Paving', 'Trenching'],
  rs: ['Hunter', 'Mason', 'Dale', 'Wade', 'Lamb', 'Rowe', 'Combs', 'Nash', 'Goss', 'Tate', 'Dyer', 'Poole', 'Slade', 'Ryder', 'Shaw', 'Hale', 'Parks', 'Bird', 'Fox', 'Lane', 'Young', 'King'],
  ru: ['Cordero', 'Maldonado', 'Piotrowski', 'Eze', 'Chee', 'Vu', 'Pemberton', 'Radcliffe', 'Hollingsworth', 'Cavanaugh', 'Brannigan', 'Trevino', 'Aldridge', 'Moorehouse', 'Kettering', 'Dunham'],
  rx: ['Lightfoot', 'Quartermain', 'Springfield', 'Wintergreen', 'Hornblower', 'Firebrand', 'Goldfinch', 'Peacock'],
  first: ['Claire', 'Dennis', 'Fiona', 'Glenda', 'Harold', 'Joanne', 'Lyle', 'Marta'],
};

// FINAL2 vocabulary: a last unseen pool, written after FINAL and the code change that followed it. generateR8({ final2: true }); run once.
const FINAL2 = {
  given: ['Bruce', 'Camila', 'Trent', 'Valerie', 'Gordon', 'Selena', 'Lance', 'Marlene', 'Ellis', 'Josefina', 'Warren', 'Nadia', 'Clint', 'Pilar', 'Stuart', 'Imani'],
  noun: ['Telehandler', 'Skidder', 'Trommel', 'Hopper', 'Auger', 'Mixer', 'Rototiller', 'Paver', 'Roller', 'Grader', 'Scraper', 'Loader', 'Dredge', 'Pontoons', 'Gangway', 'Gangplank', 'Boatyard', 'Smokestacks', 'Baghouse', 'Cleanroom', 'Darkroom', 'Mailroom', 'Schoolyard', 'Barnyard', 'Junkyard', 'Brickyard', 'Playhouse', 'Greenhouse', 'Coffeehouse', 'Penthouse', 'Wheelhouse', 'Workhouse', 'Warehouses', 'Outhouse', 'Mudflap', 'Fender', 'Bumper', 'Chassis', 'Axle', 'Differential', 'Transmission', 'Radiator', 'Alternator', 'Carburetor', 'Muffler', 'Odometer', 'Speedometer', 'Dashboard', 'Windshield', 'Taillight', 'Headlamp', 'Floodlight', 'Spotlight', 'Streetlamp', 'Lamppost', 'Signpost', 'Guidepost', 'Bollard', 'Barricade', 'Median', 'Roundel'],
  odd: ['Forkpocket', 'Tiltbed', 'Dumpbed', 'Grabrail', 'Kickplate', 'Toeboard', 'Midrail', 'Lanyards', 'Carabiners', 'Slings', 'Shackles', 'Eyebolts', 'Turnbuckles', 'Clevises', 'Sheaves', 'Draining', 'Dewatering', 'Compacting', 'Excavating', 'Surveying'],
  rs: ['Hale', 'Cross', 'Ward', 'Marsh', 'Brooks', 'Banks', 'Woods', 'Fields', 'Hills', 'Rivers', 'Mills', 'Black', 'Green', 'White', 'Brown', 'Gray', 'Wolfe', 'Swift', 'Hart', 'Park'],
  ru: ['Escobedo', 'Varela', 'Kaminski', 'Nwosu', 'Begaye', 'Pham', 'Ellington', 'Tennyson', 'Fitzgerald', 'Macdonald', 'Whitaker', 'Underhill', 'Goodrich', 'Ravenel', 'Satterfield', 'Pruitt'],
  rx: ['Whitehorse', 'Dragonfly', 'Starfish', 'Seabright', 'Kingfisher', 'Nightingale', 'Waterfall', 'Cherrywood'],
  first: ['Anita', 'Bernard', 'Colleen', 'Duane', 'Edith', 'Felix', 'Gwen', 'Howard'],
};

// FINAL3 vocabulary: written last, after the code was frozen; generateR8({ final3: true }); run once, no code change after it.
const FINAL3 = {
  given: ['Gilbert', 'Marisol', 'Preston', 'Noelle', 'Ernesto', 'Brenda', 'Lamar', 'Tricia', 'Rodrigo', 'Joy', 'Marvin', 'Kelsey', 'Abel', 'Dawn', 'Ulysses', 'Naomi'],
  noun: ['Sprinkler', 'Tractor', 'Combine', 'Harvester', 'Baler', 'Granary', 'Corral', 'Kennel', 'Aviary', 'Auditorium', 'Stadium', 'Velodrome', 'Racetrack', 'Speedway', 'Highway', 'Freeway', 'Expressway', 'Tunnel', 'Viaduct', 'Trestle', 'Embankment', 'Refinery', 'Distillery', 'Tannery', 'Bakery', 'Creamery', 'Laundry', 'Pharmacy', 'Armory', 'Barracks', 'Cabana', 'Gondola', 'Funicular', 'Monorail', 'Turnpike', 'Railcar', 'Boxcar', 'Caboose', 'Locomotive', 'Handcart', 'Wheelchair', 'Stretcher', 'Defibrillator', 'Ventilator', 'Nebulizer', 'Syringe', 'Scalpel', 'Stethoscope', 'Microscope', 'Telescope', 'Periscope', 'Barometer', 'Toolchest', 'Jobsite', 'Worksite', 'Substation', 'Transformer', 'Capacitor', 'Resistor', 'Breakerbox', 'Junctionbox'],
  odd: ['Laydown', 'Staging', 'Mobilization', 'Backhauling', 'Pressurewash', 'Lockbox', 'Wrenchset', 'Tiedown', 'Chokers', 'Spreaders'],
  rs: ['Park', 'Stone', 'Hill', 'Wood', 'Baker', 'Mills', 'Fields', 'Rivers', 'Green', 'Black', 'Young', 'King', 'Bird', 'Fox', 'Lane', 'Wells', 'Hunter', 'Porter', 'Rowe', 'Lamb'],
  ru: ['Alvarado', 'Dominguez', 'Nowakowski', 'Obi', 'Nakai', 'Tran', 'Lockridge', 'Haverford', 'Caldecott', 'Wetherby', 'Kingsley', 'Ormsby', 'Prescott', 'Radford', 'Tolliver', 'Ashby'],
  rx: ['Lilyflower', 'Raincrow', 'Heartwood', 'Fernwood', 'Honeybee', 'Meadowlark', 'Thistledown', 'Bluebird'],
  first: ['Cynthia', 'Gavin', 'Heidi', 'Jared', 'Kendra', 'Lloyd', 'Monica', 'Neil'],
};

export function generateR8({ seed = 20261501, perClass = 60, fresh = false, final = false, final2 = false, final3 = false } = {}) {
  const V = (split) => (final3 && split === 'blind' ? { GIVEN: FINAL3.given, NOUN: FINAL3.noun, ODD: FINAL3.odd, RS: FINAL3.rs, RU: FINAL3.ru, RX: FINAL3.rx, FIRST: FINAL3.first } : final2 && split === 'blind' ? { GIVEN: FINAL2.given, NOUN: FINAL2.noun, ODD: FINAL2.odd, RS: FINAL2.rs, RU: FINAL2.ru, RX: FINAL2.rx, FIRST: FINAL2.first } : final && split === 'blind' ? { GIVEN: FINAL.given, NOUN: FINAL.noun, ODD: FINAL.odd, RS: FINAL.rs, RU: FINAL.ru, RX: FINAL.rx, FIRST: FINAL.first } : fresh && split === 'blind' ? { GIVEN: FRESH.given, NOUN: FRESH.noun, ODD: FRESH.odd, RS: FRESH.rs, RU: FRESH.ru, RX: FRESH.rx, FIRST: FRESH.first } : { GIVEN: GIVEN[split], NOUN: NOUN[split], ODD: ODD[split], RS: RS[split], RU: RU[split], RX: RX[split], FIRST: split === 'dev' ? FIRST_OK.slice(0, 8) : split === 'holdout' ? FIRST_OK.slice(4, 12) : FIRST_OK.slice(8) });
  const out = { dev: [], holdout: [], blind: [] };
  const add = (split, cls, id, text, expect, note) => out[split].push({ cls, split, id: `${cls.toLowerCase()}-${id}`, text, expect, note });
  for (const split of ['dev', 'holdout', 'blind']) {
    const W = V(split);
    const r = rng(seed + (split === 'holdout' ? 15485863 : split === 'blind' ? 32452843 : 0));
    const kind = (i) => (i % 2 ? 'holder' : 'emp');
    const junk = (cls, nouns, frames, n, { twice = false } = {}) => {
      for (let i = 0; i < n; i++) { const v = `${pick(r, W.GIVEN)} ${pick(r, nouns)}`; const k = kind(i); const f = pick(r, frames)(v, k, r); add(split, cls, i, twice ? sheet(k, f, [v], [v]) : sheet(k, f), { noValue: v }, `${cls} "${v}" (${k})`); }
    };
    const names = (cls, list, frames, n, { sig = false, anyKey = true } = {}) => {
      for (let i = 0; i < n; i++) {
        const last = pick(r, list); const first = pick(r, W.FIRST); const nm = `${first} ${last}`; const k = kind(i); const f = pick(r, frames)(nm, k, r);
        add(split, cls, i, sheet(k, f, [], sig ? pick(r, SIG)(nm) : []), { name: { key: KEY(k), keys: anyKey ? ANYKEY : null, person: { first, last } } }, `${cls} "${nm}" (${k})`);
      }
    };
    junk('Jw', W.NOUN, weakFr, perClass * 3);
    junk('Js', W.NOUN, strongFr, perClass * 3);
    junk('Jx', W.NOUN, nextFr, perClass * 2);
    junk('Jt', W.NOUN, [...weakFr, ...strongFr], perClass * 2, { twice: true });
    junk('Jc', W.ODD, [...weakFr, ...strongFr, ...nextFr], perClass * 3);
    names('Rn', W.RS, [...weakFr, ...strongFr], perClass * 2);
    names('Rr', W.RU, [...weakFr, ...strongFr, ...nextFr], perClass * 2);
    names('Rx', W.RX, [...weakFr, ...strongFr], perClass);
    names('Rg', W.RX, [...weakFr, ...strongFr], perClass, { sig: true });
  }
  return out;
}
