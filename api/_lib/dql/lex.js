/**
 * dql/lex.js - the curated, closed vocabulary of the DQL parser.
 *
 * Only HIGH-PRECISION triggers live here (the research taxonomy in work/deep/ops_taxonomy.json was model-written; every phrase below was
 * kept by hand). The coverage rule (parse.js) means a word that is in none of these tables, none of the slot vocabularies and none of the
 * organization's own vocabulary makes the parser release the question, so a missing phrase costs coverage, never correctness.
 *
 * Nothing in here names a business, a brand, a city or a person. Those come from the organization's own data (tenantVocab).
 */
import { DOCUMENT_TYPE_SYNONYMS_ALL } from '../documentTypes.js';
import { EXTRA_DOC_TYPE_WORDS } from '../lookups/lexicon.js';

/** Pure grammar: carries no condition. NEVER put a quantity, a comparison, a negation, a name or a date word here. */
export const FILLER = new Set((
  'a an the this that of in on at for to from with into onto about as is are was were be been being am do does did done doing have has had having ' +
  'get gets got gotten can could would should will shall may might must please pls plz thanks thank hey hi hello ok okay so just also still now currently ' +
  'there here me my mine our ours we us you your yours i what whats which who ' +
  'need want like let lets know weve ive youve theyve thats theres im youre hes shes ' +
  'file files record records recorded system database ' +
  'all any every some and or if then too very really actually ever ' +
  // verbs that only say "this paper was produced"; the date they might point at is read from the time span, never from the verb
  'sent issued written placed filed generated made created pulled raised signed booked scheduled performed'
).split(/\s+/).filter(Boolean));

/** Words that are never filler even though they look like it: the parser must consume them with a trigger or release the question. */
export const LOADED = new Set(('not no never none without except excluding exclude only more less fewer fewest most least top bottom best worst biggest smallest largest highest lowest first last next previous before after since until over under above below between each per by than at least many much total ago but when where how whose whom one ones').split(/\s+/));

/* ------------------------------------------------------------------ entity nouns */

export const ENTITY_WORDS = {
  customer: ['customer', 'customers', 'client', 'clients'],
  unit: ['unit', 'units', 'piece of equipment', 'pieces of equipment', 'equipment', 'system', 'systems', 'machine', 'machines', 'asset', 'assets', 'condenser', 'condensers', 'furnace', 'furnaces'],
  install: ['install', 'installs', 'installation', 'installations'],
  visit: ['visit', 'visits', 'service call', 'service calls', 'site visit', 'site visits', 'service visit', 'service visits', 'call out', 'callout', 'callouts'],
  document: ['document', 'documents', 'doc', 'docs', 'paperwork', 'paper', 'papers'],
  technician: ['technician', 'technicians', 'tech', 'techs'],
};

/** Words for document types, from the shared tables (documentTypes.js + lexicon.js). phrase -> type id. */
export function docTypePhraseMap() {
  const out = new Map();
  for (const [id, ph] of Object.entries(DOCUMENT_TYPE_SYNONYMS_ALL)) for (const p of ph) if (!out.has(p)) out.set(p, id);
  for (const [id, ph] of Object.entries(EXTRA_DOC_TYPE_WORDS)) for (const p of ph) if (!out.has(p)) out.set(p, id);
  // a few everyday forms the shared tables do not carry
  // "contract" is too loose a word (a service contract, a subcontract, a lease): left unexplained so the question is released
  for (const w of ['contract', 'contracts']) out.delete(w);
  const add = (p, id) => { if (!out.has(p)) out.set(p, id); };
  for (const [p, id] of [['pos', 'purchase-order'], ['work orders', 'work-order'], ['tickets', 'service-ticket'], ['service calls tickets', 'service-ticket'], ['quotes', 'proposal-quote'], ['bids', 'proposal-quote'], ['bid', 'proposal-quote'],
    ['start up sheet', 'startup-sheet'], ['start up sheets', 'startup-sheet'], ['start-up sheet', 'startup-sheet'], ['start-up sheets', 'startup-sheet'], ['startups', 'startup-sheet'], ['startup', 'startup-sheet'],
    ['inspections', 'inspection-report'], ['inspection', 'inspection-report'], ['registrations', 'warranty-registration'], ['warranty registrations', 'warranty-registration'],
    ['dispatches', 'dispatch-note'], ['letters', 'correspondence'], ['emails', 'correspondence'], ['permits', 'permit'], ['permit filings', 'permit']]) add(p, id);
  return out;
}

/* ------------------------------------------------------------------ measures */

/** What a money word means: which kind of document its amount is read from. null = the document type must be named. */
export const MONEY_WORDS = [
  // phrase, doc type the total comes from
  ['billed', 'invoice'], ['billings', 'invoice'], ['billing', 'invoice'], ['invoiced', 'invoice'], ['revenue', 'invoice'], ['sales', 'invoice'], ['earned', 'invoice'], ['income', 'invoice'],
  ['bill', 'invoice'], ['charged', 'invoice'], ['collected', null],
  ['spent', 'purchase-order'], ['spend', 'purchase-order'], ['spending', 'purchase-order'],
  ['quoted', 'proposal-quote'], ['bid', 'proposal-quote'], ['bids', 'proposal-quote'],
  ['worth', null], ['value', null], ['amount', null], ['amounts', null], ['dollars', null], ['money', null], ['cost', null], ['costs', null], ['price', null], ['prices', null],
];

/* ------------------------------------------------------------------ dimensions (group-by / argmax) */

/** dimension id -> phrases (singular/plural/by-forms). The entity decides which dimensions exist (exec.js DIMENSIONS). */
export const DIM_WORDS = {
  year: ['year', 'years', 'yearly', 'annual', 'annually'],
  month: ['month', 'months', 'monthly'],
  quarter: ['quarter', 'quarters', 'quarterly'],
  type: ['type', 'types', 'kind', 'kinds', 'document type', 'document types', 'doc type', 'doc types', 'category', 'categories'],
  tech: ['technician', 'technicians', 'tech', 'techs'],
  city: ['city', 'cities', 'town', 'towns'],
  brand: ['brand', 'brands', 'manufacturer', 'manufacturers', 'make', 'makes'],
  customer: ['customer', 'customers', 'client', 'clients'],
  vendor: ['vendor', 'vendors', 'supplier', 'suppliers'],
  status: ['status', 'statuses'],
  serviceType: ['service type', 'service types', 'type of service', 'types of service'],
  refrigerant: ['refrigerant', 'refrigerants'],
  tonnage: ['tonnage', 'size', 'sizes'],
  model: ['model', 'models'],
};

/* ------------------------------------------------------------------ operators */

export const CMP_WORDS = [
  [/\bat least\b/, 'gte'], [/\bat most\b/, 'lte'], [/\bno more than\b/, 'lte'], [/\bno less than\b/, 'gte'],
  [/\b(?:more than|greater than|bigger than|larger than|higher than|exceeding|exceeds|over|above)\b/, 'gt'],
  [/\b(?:less than|fewer than|smaller than|lower than|cheaper than|under|below)\b/, 'lt'],
];

export const NEG_RE = /\b(?:not|no|never|without|except|excluding|exclude|other than|besides|apart from|aside from|but not)\b/;
