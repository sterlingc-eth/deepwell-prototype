/**
 * dql/vocab.js - compiles the organization's own vocabulary (vocab/tenantVocab.js, already fetched by ask.js once per request) into the
 * lookup tables the parser needs: names, brands, cities, models, categorical values, document-type phrases.
 * Pure. Cached per tenantVocab object, so a request pays for it once.
 */
import { BRAND_RULES } from '../warrantyRules.js';
import { COMMON_WORDS } from '../router/lexicon.generated.js';
import { docTypePhraseMap, ENTITY_WORDS, DIM_WORDS, MONEY_WORDS, FILLER, LOADED } from './lex.js';
import { indexByLen } from './text.js';
import { RESPELL } from '../lexicon/jargon.generated.js';
import { resolveDocAliases } from './industryLex.js';

const cache = new WeakMap();
let commonSet = null;
const common = () => (commonSet ??= new Set(COMMON_WORDS.split(/\s+/)));

const lowerWords = (s) => String(s ?? '').toLowerCase().replace(/[’‘`]/g, "'").replace(/'s\b/g, '').replace(/[^a-z0-9$#. -]+/g, ' ').replace(/\s+/g, ' ').trim();
export const normName = (s) => lowerWords(s).replace(/\./g, '');

/** Words the parser's own tables use (these are the repair targets and the "already known" set). */
function lexiconWords() {
  const out = new Set();
  const addPhrase = (p) => { for (const w of String(p).toLowerCase().split(/[^a-z0-9]+/)) if (w.length >= 3) out.add(w); };
  for (const v of Object.values(ENTITY_WORDS)) v.forEach(addPhrase);
  for (const v of Object.values(DIM_WORDS)) v.forEach(addPhrase);
  for (const [p] of MONEY_WORDS) addPhrase(p);
  for (const [p] of docTypePhraseMap()) addPhrase(p);
  for (const w of LOADED) if (w.length >= 3) out.add(w);
  for (const w of ('how many number count total sum average median highest lowest largest smallest biggest cheapest expensive latest newest oldest earliest recent first last ' +
    'versus compare compared percent percentage share proportion between through during before after since until between older newer younger bigger larger smaller ' +
    'invoiced billed billings revenue spent spend quoted placed filed issued installed installation expired expiring expires warranty registered scanned uploaded created ' +
    'january february march april june july august september october november december year years month months week weeks quarter quarters today yesterday tomorrow ' +
    'visits visited serviced customers customer units technician technicians vendor vendors brand brands hours labor tonnage refrigerant ' +
    'distinct unique different separate average mean typical combined altogether overall everything anything per each across breakdown group grouped sorted ranked ' +
    'there exist exists named called ever never ton tons dollars dollar days day since ago latest newest rundown headcount appointments appointment').split(' ')) out.add(w);
  return out;
}
let LEXW = null;
export const lexWords = () => (LEXW ??= lexiconWords());

const plw = (s) => (/(?:s|x|ch|sh)$/.test(s) ? `${s}es` : /[^aeiou]y$/.test(s) ? `${s.slice(0, -1)}ies` : `${s}s`);
const HEAD_BLOCK = new Set('list other name names note notes form forms record records sheet sheets date dates type types file files data info line lines item items entry entries report reports'.split(' '));
const HEAD_TAIL = new Set('report record sheet note letter form entry'.split(' '));
/** head nouns of the stored type ids: word -> Set(ids). */
export function typeHeads(ids) {
  const heads = new Map();
  const add = (w, id) => { if (w.length < 4 || HEAD_BLOCK.has(w)) return; if (!heads.has(w)) heads.set(w, new Set()); heads.get(w).add(id); };
  for (const id of ids) {
    const parts = id.split('-').filter((x) => x.length > 1);
    if (parts.length < 2) continue;
    add(parts[parts.length - 1], id);
    if (HEAD_TAIL.has(parts[parts.length - 1])) add(parts[0], id);
  }
  return heads;
}
function learnTypeWords(v) {
  const ids = [...v.docTypesInUse.keys()];
  if (!ids.length) return;
  const nouns = new Set(Object.values(ENTITY_WORDS).flat());
  for (const [w, set] of typeHeads(ids)) {
    const list = [...set];
    for (const form of [w, plw(w)]) {
      if (nouns.has(form)) continue;
      const cur = v.docPhrases.get(form);
      if (list.length === 1) {
        if (!cur || (cur !== list[0] && !v.docTypesInUse.has(cur))) v.docPhrases.set(form, list[0]);
      } else if (!cur || !v.docTypesInUse.has(cur)) {
        v.docPhrases.delete(form); v.docGroups.set(form, list);
      }
    }
  }
}


/** R15: words from the company's vocabulary card (dql/card.js). A word that names exactly one stored kind of paper is that kind; a word shared by several is a group; the staff noun is one more word for the technician. */
function learnCard(v, card) {
  v.nounExtra = {};
  if (!card || process.env.DONOVAN_CARD === '0') return;
  const nouns = new Set(Object.values(ENTITY_WORDS).flat());
  const kinds = Object.entries(card.kinds ?? {});
  const wordKinds = new Map(); // word -> Set(type ids)
  const addW = (w, id) => { if (w.length < 3 || HEAD_BLOCK.has(w) || /^\d+$/.test(w)) return; if (!wordKinds.has(w)) wordKinds.set(w, new Set()); wordKinds.get(w).add(id); };
  const staffW = new Set((card.staffNouns ?? []).map((x) => String(x).toLowerCase()));
  const lexW = lexWords();
  for (const [id, k] of kinds) {
    const hs = k.heads ?? [];
    hs.forEach((w, i) => {
      if (staffW.has(w) || staffW.has(plw(w)) || lexW.has(w)) return;
      const modifier = !(i === hs.length - 1 && String(id).endsWith(`-${w}`));
      if (modifier && (w.length < 6 || common().has(w))) return; // a first word ("service", "equipment") is too ordinary to name a kind
      addW(w, id);
    });
  }
  // initials of a long kind name ("bill-of-lading" -> BOL, "driver-qualification-file" -> DQ file): one more word for it, only when it names ONE kind
  const initials = new Map();
  for (const [id] of kinds) {
    const parts = id.split('-').filter(Boolean);
    if (parts.length < 3) continue;
    for (const ph of [parts.map((p) => p[0]).join(''), `${parts.slice(0, -1).map((p) => p[0]).join('')} ${parts[parts.length - 1]}`]) { if (ph.replace(/\s/g, '').length < 3 || nouns.has(ph)) continue; if (!initials.has(ph)) initials.set(ph, new Set()); initials.get(ph).add(id); }
  }
  for (const [ph, set] of initials) if (set.size === 1) for (const form of [ph, plw(ph)]) if (!v.docPhrases.has(form)) v.docPhrases.set(form, [...set][0]);
  for (const [id, k] of kinds) {
    const phrases = [k.label, k.plural, `${k.label}s`];
    for (const p of phrases) { const cur = v.docPhrases.get(p); if (!cur || (cur !== id && !v.docTypesInUse.has(cur))) v.docPhrases.set(p, id); }
  }
  for (const [w, set] of wordKinds) {
    const list = [...set];
    for (const form of [w, plw(w)]) {
      if (nouns.has(form) || v.docPhrases.has(form) && v.docTypesInUse.has(v.docPhrases.get(form)) && v.docPhrases.get(form) !== list[0]) continue;
      if (list.length === 1) { v.docPhrases.set(form, list[0]); v.docGroups?.delete(form); }
      else if (!v.docPhrases.has(form) || !v.docTypesInUse.has(v.docPhrases.get(form))) { v.docPhrases.delete(form); v.docGroups?.set(form, list); }
    }
  }
  // R16: short forms of a kind's name ("lab order" for print-lab-order, "facility request" for facility-use-request, "rent bill", "rate con", "mill PO", "monthly statement"): two words of the
  // type id, in order or reversed, a word cut short, "po" for purchase order; only when the short form names exactly ONE stored kind. Anything two kinds could share stays unknown (released).
  const HEAD_SYN = { notice: ['letter'], letter: ['notice'], bill: ['invoice', 'statement'], invoice: ['bill'], statement: ['bill'], request: ['application'], application: ['request'], contract: ['agreement'], agreement: ['contract'], log: ['record'], sheet: ['form'], form: ['sheet'] };
  if (process.env.R16_SHORT !== '0') { const STOP = new Set(['of', 'for', 'the', 'and', 'a', 'to', 'in']);
    const forms = (t) => { const o = new Set([t]); if (/ing$/.test(t) && t.length > 6) o.add(t.slice(0, -3)); if (['month', 'year', 'week', 'quarter'].includes(t)) o.add(`${t}ly`); if (t === 'purchase') o.add('po'); return [...o]; };
    const cut = (t) => (t.length >= 8 ? [t.slice(0, 3), t.slice(0, 4)] : []);
    const cand = new Map(); // phrase -> Set(ids)
    const put = (ph, id) => { if (!cand.has(ph)) cand.set(ph, new Set()); cand.get(ph).add(id); };
    for (const [id] of kinds) {
      const tk = String(id).split('-').filter((x) => x && !STOP.has(x));
      for (let i = 0; i < tk.length; i++) for (let j = 0; j < tk.length; j++) {
        if (i === j || tk[i].length < 3 || tk[j].length < 3) continue;
        const ordered = i < j;
        const as = forms(tk[i]); const bs = forms(tk[j]).concat(ordered || j === tk.length - 1 ? cut(tk[j]) : []).concat(ordered && j === tk.length - 1 && process.env.R17_HEADSYN !== '0' ? (HEAD_SYN[tk[j]] ?? []) : []); // R17: the head noun's everyday twin ("lien letter" for lien-sale-notice, "tuition bill" for tuition-statement)
        for (const a of as) for (const b of bs) {
          if (a === 'po' && b === 'order') continue;
          if (!ordered && !(j === tk.length - 1 || i === tk.length - 1)) continue; // reversed only when the head noun of the id leads ("tuition receipt" for payment-receipt-tuition)
          put(`${a} ${b}`, id);
        }
      }
      // a purchase order is also a "po": "mill po", "equipment po"
      if (tk.includes('purchase') && tk.includes('order')) for (const w of tk) if (w !== 'purchase' && w !== 'order' && w.length >= 3) put(`${w} po`, id);
    }
    for (const [ph, set] of cand) {
      if (set.size !== 1) continue;
      const ws = ph.split(' ');
      if (ws.some((w) => FILLER.has(w) || LOADED.has(w) || staffW.has(w) || staffW.has(plw(w)))) continue;
      const id = [...set][0];
      for (const form of [ph, `${ws.slice(0, -1).join(' ')} ${plw(ws[ws.length - 1])}`]) {
        if (nouns.has(form) || [...nouns].some((n) => form === `${n}` )) continue;
        const cur = v.docPhrases.get(form);
        if (!cur || (cur !== id && !v.docTypesInUse.has(cur))) v.docPhrases.set(form, id);
      }
    }
  }
  // the company's own word for the people who do the work ("groomer", "driver"): one more word for the technician, and a filter the card recognises
  const sn = (card.staffNouns ?? []).filter((x) => x && !nouns.has(x));
  if (sn.length) v.nounExtra.technician = sn;
  // R16: the company's word for the people it bills, when it is none of the shared ones (shipper, renter, family, pet parent ...). A word the company already uses for its staff, or in a field that holds
  // something other than the customers (a vendor, a staff member), is not taken: it is then asked, not guessed.
  if (process.env.R16_CUST !== '0') { const EXTRA = ['shipper', 'renter', 'subscriber', 'parishioner', 'pet parent', 'pet owner', 'student family', 'catering client', 'farm account', 'rancher', 'camper', 'boarder', 'lessee', 'consignor'];
    const fieldWords = new Set(Object.entries(card.fields ?? {}).filter(([, f]) => f.shape !== 'person' || (f.custShare ?? 0) < 0.8).flatMap(([k]) => k.toLowerCase().split(/[^a-z0-9]+/)));
    const kindWords = new Set(Object.keys(card.kinds ?? {}).flatMap((id) => id.split('-')));
    const custForms = [];
    for (const w of EXTRA) {
      const last = w.split(' ').pop();
      if (staffW.has(w) || staffW.has(plw(w)) || fieldWords.has(last) || (kindWords.has(last) && !(card.customerKeys ?? []).length)) continue;
      if (nouns.has(w)) continue;
      const pl2 = w === 'family' || w === 'student family' ? w.replace(/family$/, 'families') : plw(w);
      custForms.push(w, pl2);
    }
    if (custForms.length) v.nounExtra.customer = custForms;
  }
  v.cardStaffNoun = card.staffNoun ?? null;
  v.dualNames = new Set((card.staffDual ?? []).map((n) => normName(n))); // on file as a customer AND as the staff: a question that speaks of the work they did is asked, not guessed
  v.card = card;
}

export function compileVocab(tv, pack) {
  if (tv && cache.has(tv)) return cache.get(tv);
  const v = { names: new Map(), nameWords: new Set(), maxNameWords: 1, brands: new Map(), cities: new Map(), models: new Map(), cat: {}, docPhrases: new Map(), industry: new Set(), docTypesInUse: new Map(), customerNames: new Set(), techNames: new Set() };
  const addName = (display, role) => {
    const k = normName(display);
    if (!k || k.length < 3) return;
    const cur = v.names.get(k) ?? { display, customer: false, tech: false, vendor: false };
    cur[role] = true;
    v.names.set(k, cur);
    v.maxNameWords = Math.max(v.maxNameWords, k.split(' ').length);
    for (const w of k.split(' ')) v.nameWords.add(w);
  };
  for (const n of tv?.customers?.phrases ?? []) { addName(n, 'customer'); v.customerNames.add(normName(n)); }
  for (const n of tv?.technicians?.phrases ?? []) { addName(n, 'tech'); v.techNames.add(normName(n)); }
  if (process.env.DONOVAN_CARD !== '0') for (const n of tv?.dql?.card?.staffNames ?? []) { addName(n, 'tech'); v.techNames.add(normName(n)); } // R15: the staff the company's own card found (the older lanes keep the glossary they always had)
  for (const n of tv?.dql?.categorical?.vendor ?? []) addName(n, 'vendor');

  const addBrand = (raw, label) => { const k = lowerWords(raw); if (k) v.brands.set(k, label ?? raw); };
  for (const b of tv?.brands ?? []) addBrand(b, b);
  for (const [key, rule] of Object.entries(BRAND_RULES)) {
    addBrand(key, rule.label ?? key);
    for (const a of rule.aliases ?? []) addBrand(a, rule.label ?? key);
  }
  for (const c of tv?.cities ?? []) v.cities.set(lowerWords(c), c);
  for (const m of tv?.models ?? []) {
    const base = String(m).split(/\s+serial\s*:/i)[0].trim();
    const k = lowerWords(base);
    if (k && /\d/.test(k) && !k.includes(' ')) v.models.set(k, base);
  }
  for (const [field, vals] of Object.entries(tv?.dql?.categorical ?? {})) {
    if (field === 'vendor') continue;
    v.cat[field] = new Map(vals.map((x) => [lowerWords(x), x]));
  }
  // document types: shared tables, plus the organization's own labels, plus any type id actually in use
  for (const [p, id] of docTypePhraseMap()) v.docPhrases.set(p, id);
  for (const t of tv?.docTypePhrases ?? []) if (t.phrase && !v.docPhrases.has(t.phrase)) v.docPhrases.set(t.phrase, t.id);
  for (const t of tv?.dql?.docTypes ?? []) v.docTypesInUse.set(t.id, t.n);
  for (const t of tv?.dql?.docTypes ?? []) {
    const base = t.id.replace(/-/g, ' ');
    const parts = t.id.split('-'); const half = parts.length > 2 ? `${parts.slice(0, -1).join('-')} ${parts[parts.length - 1]}` : base; // "move-in inspection"
    // the company's own id for a kind of paper is its word for it: it wins over a shared-table phrase that points at a kind this company does not keep ("agreements" in an office with agreement papers and no maintenance agreements)
    for (const p of [base, plw(base), `${base}s`, t.id, `${t.id}s`, half, `${half}s`]) { const cur = v.docPhrases.get(p); if (!cur || (cur !== t.id && !v.docTypesInUse.has(cur))) v.docPhrases.set(p, t.id); }
  }
  // R13: the company's own paper words, learned from the type ids it stores (a head noun that names exactly one stored kind is that kind; one that names several is a group; one the static tables
  // tie to a kind this company does not keep is re-pointed to the kinds it does keep). Nothing here depends on which industry the company is.
  v.docGroups = new Map();
  learnTypeWords(v);
  // R15: the company's vocabulary card: its own words for kinds of paper (every word of the type id, singular and plural) and for its staff
  learnCard(v, tv?.dql?.card);
  // the everyday word for a kind of paper in this kind of business ("estimate", "pledge", "repair order"): only when it means ONE of the kinds this organization has
  v.industryKind = tv?.industryKind ?? null;
  v.otherIndustry = true; // R13: nothing switches on for one kind of business any more; the industry setting is only a hint (scoped words, the answer's word for the people)
  // the shared everyday words of other kinds of business apply to an organization that chose one at sign-up (an HVAC shop, or no choice, keeps the words it always had)
  const aliases = v.otherIndustry ? resolveDocAliases(v.docTypesInUse.keys(), tv?.industryKind) : Object.assign(new Map(), { scoped: new Set() });
  v.scopedPhrases = aliases.scoped;
  for (const [p, id] of aliases) { const cur = v.docPhrases.get(p); if (!cur || (cur !== id && (aliases.scoped.has(p) || !v.docTypesInUse.has(cur) || (id === 'lease-agreement' && !v.docTypesInUse.has(id))))) v.docPhrases.set(p, id); } // a lease is not a generic agreement: with no lease papers on file the answer is none
  // a phrase for a kind of paper this organization does not keep, that is also an everyday noun for a visit or a customer ("site visit"), is that noun
  { const nouns = new Set(Object.values(ENTITY_WORDS).flat()); for (const [p, id] of [...v.docPhrases]) if (!v.docTypesInUse.has(id) && nouns.has(p)) v.docPhrases.delete(p); }
  for (const w of tv?.industryWords ?? []) v.industry.add(String(w).toLowerCase());

  // repair targets: lexicon + brands + cities (names are deliberately NOT repair targets)
  const targets = new Set(lexWords());
  for (const p of v.docPhrases.keys()) for (const w of p.split(' ')) if (w.length >= 4) targets.add(w);
  for (const keys of Object.values(RESPELL)) for (const k of keys) if (!k.includes(' ') && k.length >= 4) targets.add(k);
  for (const k of v.brands.keys()) for (const w of k.split(' ')) if (w.length >= 4) targets.add(w);
  for (const k of v.cities.keys()) for (const w of k.split(' ')) if (w.length >= 4) targets.add(w);
  for (const k of Object.values(v.cat)) for (const key of k.keys()) for (const w of key.split(' ')) if (w.length >= 4) targets.add(w);
  v.repairByLen = indexByLen([...targets].filter((w) => w.length >= 4));
  // a misspelling is never repaired INTO a filler word (that would silently drop it), and a negation contraction is never repaired at all
  // neutral verbs (filler) a misspelling may be repaired into: they carry no condition, so nothing is lost
  for (const w of 'sent issued written placed filed generated made created pulled raised signed booked scheduled performed'.split(' ')) targets.add(w);
  const NEG_FORMS = new Set('dont doesnt didnt isnt arent wasnt werent havent hasnt hadnt wont cant cannot aint shouldnt couldnt wouldnt nothing nobody neither'.split(' '));
  for (const w of v.nounExtra?.technician ?? []) targets.add(w);
  for (const w of v.nounExtra?.customer ?? []) for (const x of w.split(' ')) targets.add(x);
  v.known = (w) => targets.has(w) || FILLER.has(w) || NEG_FORMS.has(w) || common().has(w) || v.nameWords.has(w);
  if (tv) cache.set(tv, v);
  return v;
}
