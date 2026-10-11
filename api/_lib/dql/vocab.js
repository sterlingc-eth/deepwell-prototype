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
  for (const t of tv?.dql?.docTypes ?? []) {
    v.docTypesInUse.set(t.id, t.n);
    const base = t.id.replace(/-/g, ' ');
    const parts = t.id.split('-'); const half = parts.length > 2 ? `${parts.slice(0, -1).join('-')} ${parts[parts.length - 1]}` : base; // "move-in inspection"
    for (const p of [base, `${base}s`, t.id, `${t.id}s`, half, `${half}s`]) if (!v.docPhrases.has(p)) v.docPhrases.set(p, t.id);
  }
  // the everyday word for a kind of paper in this kind of business ("estimate", "pledge", "repair order"): only when it means ONE of the kinds this organization has
  v.otherIndustry = Boolean(tv?.industryKind) && String(tv.industryKind).toLowerCase() !== 'hvac';
  // the shared everyday words of other kinds of business apply to an organization that chose one at sign-up (an HVAC shop, or no choice, keeps the words it always had)
  const aliases = v.otherIndustry ? resolveDocAliases(v.docTypesInUse.keys(), tv?.industryKind) : Object.assign(new Map(), { scoped: new Set() });
  v.scopedPhrases = aliases.scoped;
  for (const [p, id] of aliases) { const cur = v.docPhrases.get(p); if (!cur || (cur !== id && !v.docTypesInUse.has(cur))) v.docPhrases.set(p, id); }
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
  v.known = (w) => targets.has(w) || FILLER.has(w) || NEG_FORMS.has(w) || common().has(w) || v.nameWords.has(w);
  if (tv) cache.set(tv, v);
  return v;
}
