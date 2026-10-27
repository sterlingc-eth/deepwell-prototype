// Round 9 variants. SYNTHETIC. Fixed seeds; dev / holdout / blind use disjoint vocabularies (the code was tuned on dev only; blind is looked at once).
//   Jj  a given name + trade jargon the dictionary does not hold ("Rebar", "Gunite", "Telehandler", "Paver", "Planogram", "Aquastat")
//   Jh  a given name + a run-together compound that ends in a thing / place word ("Thriftstore", "Returnsdesk", "Jobtrailer", "Endcap", "Barcode")
//   Jg  a given name + a gerund that names work ("Mowing", "Shelving", "Hauling")
//   Jd  a given name + an ordinary noun of the trades, retail, medicine, schools (dictionary words)
//   Rk  real COMPOUND surnames (Hightower, Blackwell, Whitfield, Underwood, Woodward, Fairchild, Goldberg, Newman, Stonebridge ...). Recall.
//   Rn  real noun-like surnames (Park Stone Hill Wood Baker Mills Fields Rivers Green Black Young King Bird Fox Lane ...). Recall.
//   Rr  uncommon real names that are no English word. Recall.
//   Rc  the real surname Crane / Mason / Bell on a STRONG label. Recall.
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
  blind: ['Gilbert', 'Marisol', 'Preston', 'Noelle', 'Ernesto', 'Brenda', 'Lamar', 'Tricia', 'Rodrigo', 'Joy', 'Marvin', 'Kelsey', 'Abel', 'Dawn', 'Ulysses', 'Naomi'],
};
const JARGON = {
  dev: ['Rebar', 'Gunite', 'Shotcrete', 'Telehandler', 'Paver', 'Geogrid', 'Geotextile', 'Planogram', 'Polybag', 'Aquastat', 'Flexduct', 'Lineset', 'Pressurestat', 'Subcooling', 'Superheat', 'Skidsteer', 'Mudjacking', 'Waterstop', 'Firestop', 'Backerrod'],
  holdout: ['Rototiller', 'Bondbreaker', 'Kneewall', 'Lagbolt', 'Freezestat', 'Zonevalve', 'Sleeper', 'Screed', 'Formliner', 'Scarifier', 'Cleanout', 'Downspout', 'Facings', 'Shelftalker', 'Endcap', 'Dunnage', 'Swagelok', 'Tieback', 'Ductstat', 'Slipform'],
  blind: ['Hydrovac', 'Bobcat', 'Backfill', 'Rebound', 'Tremie', 'Fireblock', 'Weephole', 'Thinset', 'Knockout', 'Leadscrew', 'Crosscut', 'Zipcode', 'Shrinkwrap', 'Pricegun', 'Hangtag', 'Kickstand', 'Tagout', 'Lockout', 'Pigtail', 'Disconnect'],
};
const HEADC = {
  dev: ['Thriftstore', 'Returnsdesk', 'Jobtrailer', 'Barcode', 'Salesfloor', 'Backroom', 'Tollbooth', 'Giftshop', 'Pricetag', 'Cashwrap', 'Dumpbin', 'Valvebox', 'Toolcart', 'Partsbin', 'Loadingdock', 'Servicedesk', 'Tooltruck', 'Lunchtruck'],
  holdout: ['Walkathon', 'Fieldoffice', 'Gatehouse', 'Checkstand', 'Stockyard', 'Pumphouse', 'Breakroom', 'Shopfloor', 'Cabinetshop', 'Weighstation', 'Camptrailer', 'Wastebin', 'Pipecart', 'Ductshop', 'Fittingstore', 'Helpdesk', 'Cashdrawer', 'Tailgate'],
  blind: ['Garageroom', 'Dispatchdesk', 'Receivingdock', 'Cullbin', 'Supplycage', 'Jobshack', 'Warrantydesk', 'Pickuplane', 'Drivethru', 'Fuelstation', 'Scalehouse', 'Cuttingtable', 'Layoutbench', 'Wrapstation', 'Gaskettable', 'Returncage', 'Marketstall', 'Salvageyard'],
};
const GERUND = {
  dev: ['Mowing', 'Shelving', 'Hauling', 'Framing', 'Staging', 'Pruning', 'Trimming', 'Stocking', 'Bagging', 'Scanning'],
  holdout: ['Mulching', 'Edging', 'Sanding', 'Caulking', 'Tarping', 'Grading', 'Draining', 'Welding', 'Surveying', 'Folding'],
  blind: ['Raking', 'Sweeping', 'Mopping', 'Bundling', 'Tagging', 'Wrapping', 'Pouring', 'Sealing', 'Binding', 'Shipping'],
};
const NOUNS = {
  dev: ['Forklift', 'Backhoe', 'Scaffold', 'Conveyor', 'Playground', 'Warehouse', 'Compressor', 'Excavator', 'Pavilion', 'Greenhouse', 'Workbench', 'Jackhammer', 'Stockroom', 'Crankshaft', 'Gantry', 'Hydrant'],
  holdout: ['Elevator', 'Escalator', 'Generator', 'Dehumidifier', 'Ductwork', 'Pipeline', 'Shipyard', 'Quarry', 'Basement', 'Stairwell', 'Catwalk', 'Mudroom', 'Carport', 'Driveway', 'Skylight', 'Thermostat'],
  blind: ['Sprinkler', 'Tractor', 'Combine', 'Harvester', 'Baler', 'Granary', 'Kennel', 'Aviary', 'Stadium', 'Highway', 'Tunnel', 'Refinery', 'Bakery', 'Pharmacy', 'Armory', 'Stethoscope'],
};
const RK = {
  dev: ['Hightower', 'Blackwell', 'Whitfield', 'Underwood', 'Woodward', 'Fairchild', 'Goldberg', 'Newman', 'Stonebridge', 'Winterbottom', 'Longbottom', 'Merriweather'],
  holdout: ['Tattersall', 'Hargreaves', 'Applegate', 'Haverford', 'Rosenthal', 'Brightman', 'Stillwell', 'Wedgwood', 'Northcott', 'Southgate', 'Westbrook', 'Cavendish', 'Hollingsworth', 'Ashworth', 'Bradshaw', 'Kirkland'],
  blind: ['Lockhart', 'Silverman', 'Goldstein', 'Greenberg', 'Cartwright', 'Wainwright', 'Hathaway', 'Callaway', 'Lightfoot', 'Eastwood', 'Sutherland', 'Beaumont', 'Whittaker', 'Pickering', 'Sherwood', 'Fairbanks'],
};
const NOUNLIKE = ['Park', 'Stone', 'Hill', 'Wood', 'Baker', 'Mills', 'Fields', 'Rivers', 'Green', 'Black', 'Young', 'King', 'Bird', 'Fox', 'Lane'];
const RN = {
  dev: [...NOUNLIKE, 'Moon', 'Glass', 'Hammer', 'Pike', 'Castle', 'Silver', 'Swan'],
  holdout: [...NOUNLIKE, 'Frost', 'Lamb', 'Wolf', 'Banks', 'Brooks', 'Woods', 'Bishop', 'Cook', 'Butler'],
  blind: [...NOUNLIKE, 'Sparrow', 'Finch', 'Hawk', 'Day', 'Hall', 'Wells', 'Bell', 'Ford', 'Fuller'],
};
const RR = {
  dev: ['Zavala', 'Mondragon', 'Kowalczyk', 'Oyelaran', 'Nakamura', 'Begay', 'Yazzie', 'Penhallow', 'Abernathy', 'Villanueva', 'Szymanski', 'Okonkwo'],
  holdout: ['Echeverria', 'Zielinski', 'Adeyemi', 'Tsosie', 'Benally', 'Llewellyn', 'Pennington', 'Hollister', 'Ainsworth', 'Wolfenden', 'Lindqvist', 'Ramanathan'],
  blind: ['Barraza', 'Wojciechowski', 'Okafor', 'Etsitty', 'Tidwell', 'Harrington', 'Thistlewaite', 'Dunwoody', 'Ravenscroft', 'Winslow', 'Cromwell', 'Stanhope'],
};
const RC = { dev: ['Crane', 'Mason', 'Bell'], holdout: ['Crane', 'Cook', 'Ford'], blind: ['Crane', 'Mills', 'Post'] };
GIVEN.fresh = ['Henry', 'Lucia', 'Tyler', 'Monica', 'Walter', 'Diane', 'Ivan', 'Tanya', 'Curtis', 'Elena', 'Brent', 'Alma'];
JARGON.fresh = ['Sonotube', 'Romex', 'Unistrut', 'Tyvek', 'Durock', 'Sheetrock', 'Wirenut', 'Tapcon', 'Setscrew', 'Pugmill', 'Zamak', 'Jackstand'];
HEADC.fresh = ['Tirebay', 'Palletrack', 'Binroom', 'Pickline', 'Salesfloor', 'Cartcorral', 'Fitroom', 'Greeterstand', 'Layawaydesk', 'Garagelift', 'Cashwrap', 'Checkstand'];
GERUND.fresh = ['Sanding', 'Hauling', 'Grinding', 'Painting', 'Stocking', 'Dusting', 'Trimming', 'Welding', 'Drilling', 'Pruning'];
NOUNS.fresh = ['Jackhammer', 'Wheelbarrow', 'Scoreboard', 'Turnstile', 'Dumpster', 'Gazebo', 'Cafeteria', 'Escalator', 'Bulldozer', 'Pallet', 'Compressor', 'Generator', 'Conveyor', 'Canopy'];
RK.fresh = ['Underhill', 'Ashworth', 'Goodwin', 'Blakemore', 'Whitaker', 'Longfellow', 'Hollingsworth', 'Armstrong', 'Thornton', 'Goldsmith', 'Fairweather', 'Hargreaves', 'Birkenhead'];
RN.fresh = ['Hunter', 'Carpenter', 'Miller', 'Porter', 'Marsh', 'Lake', 'Banks', 'Peacock', 'Wolf', 'Knight', 'Frost', 'Rice', 'Bush'];
RR.fresh = ['Zuniga', 'Szymanski', 'Nakamura', 'Abernathy', 'Delacroix', 'Kowalczyk', 'Vandenberg', 'Pennington', 'Tolliver', 'Grimaldi', 'Yarborough', 'Oyelaran'];
RC.fresh = ['Crane', 'Hammer', 'Sparks'];
const FIRST_OK = ['Anna', 'Eli', 'Sara', 'Lisa', 'Peter', 'Julia', 'Frank', 'Nina', 'Scott', 'Alice', 'Raul', 'Irene', 'Glenn', 'Joyce', 'Carla', 'Ruth'];

export function generateR9({ seed = 20261601, perClass = 60 } = {}) {
  const out = { dev: [], holdout: [], blind: [], fresh: [] };
  const add = (split, cls, id, text, expect, note) => out[split].push({ cls, split, id: `${cls.toLowerCase()}-${id}`, text, expect, note });
  for (const split of ['dev', 'holdout', 'blind', 'fresh']) {
    const r = rng(seed + (split === 'holdout' ? 15485863 : split === 'blind' ? 32452843 : split === 'fresh' ? 49979687 : 0));
    const kind = (i) => (i % 2 ? 'holder' : 'emp');
    const FIRST = split === 'dev' ? FIRST_OK.slice(0, 8) : split === 'holdout' ? FIRST_OK.slice(4, 12) : split === 'fresh' ? FIRST_OK.slice(2, 10) : FIRST_OK.slice(8);
    const junk = (cls, nouns, frames, n, { twice = false } = {}) => {
      for (let i = 0; i < n; i++) { const v = `${pick(r, GIVEN[split])} ${pick(r, nouns)}`; const k = kind(i); const f = pick(r, frames)(v, k, r); add(split, cls, i, twice ? sheet(k, f, [v], [v]) : sheet(k, f), { noValue: v }, `${cls} "${v}" (${k})`); }
    };
    const names = (cls, list, frames, n, { sig = false } = {}) => {
      for (let i = 0; i < n; i++) {
        const last = pick(r, list); const first = pick(r, FIRST); const nm = `${first} ${last}`; const k = kind(i); const f = pick(r, frames)(nm, k, r);
        add(split, cls, i, sheet(k, f, [], sig ? pick(r, SIG)(nm) : []), { name: { key: KEY(k), keys: ANYKEY, person: { first, last } } }, `${cls} "${nm}" (${k})`);
      }
    };
    const all = [...weakFr, ...strongFr, ...nextFr];
    junk('Jj', JARGON[split], all, perClass * 4);
    junk('Jh', HEADC[split], all, perClass * 4);
    junk('Jg', GERUND[split], all, perClass * 3);
    junk('Jd', NOUNS[split], all, perClass * 3);
    names('Rk', RK[split], [...weakFr, ...strongFr], perClass * 3);
    names('Rn', RN[split], [...weakFr, ...strongFr], perClass * 2);
    names('Rr', RR[split], all, perClass * 2);
    names('Rc', RC[split], strongFr, perClass);
  }
  return out;
}
