/**
 * The HVAC pack — DeepWell's original and, until this change, only industry.
 *
 * Every array/map below is assembled FROM the existing single-source-of-truth
 * modules (documentTypes.js, extractFields.js, contentCount.js, nlNormalize.js,
 * warrantyRules.js, scope.js), never hand-copied — so this pack is
 * byte-identical to today's hard-coded HVAC behavior by construction, and
 * stays that way as those files evolve. scripts/verify-industry.mjs asserts
 * exactly this: the hvac pack's documentTypes/fields/synonyms/brands/
 * abbreviations deep-equal what those modules already export.
 */
import { DOCUMENT_TYPES, DOCUMENT_TYPE_DEFINITIONS, REQUIRED_FIELDS, FIELD_LABELS } from '../../documentTypes.js';
import { FIELD_SPECS, UNIT_SCOPED_FIELDS } from '../../extractFields.js';
import { HVAC_TERM_SYNONYMS } from '../../contentCount.js';
import { ABBREV } from '../../nlNormalize.js';
import { BRAND_RULES } from '../../warrantyRules.js';
import { NON_VISIT_TYPES } from '../../scope.js';

// Document types whose completeness includes a dollar figure — used only for
// the pack contract's `financial` flag (new metadata; no prior behavior read
// this before industry packs existed, so there is nothing to keep identical).
const FINANCIAL_TYPE_IDS = new Set(['invoice', 'purchase-order', 'proposal-quote', 'maintenance-agreement']);

const documentTypes = DOCUMENT_TYPES.map((t) => ({
  id: t.id,
  label: t.label,
  definition: DOCUMENT_TYPE_DEFINITIONS[t.id] ?? '',
  requires: REQUIRED_FIELDS[t.id] ?? [],
  visitType: !NON_VISIT_TYPES.has(t.id),
  financial: FINANCIAL_TYPE_IDS.has(t.id),
}));

const fields = FIELD_SPECS.map((s) => ({
  key: s.key,
  label: FIELD_LABELS[s.key] ?? s.key,
  perUnit: UNIT_SCOPED_FIELDS.has(s.key),
  description: s.desc,
}));

const brands = Object.entries(BRAND_RULES).map(([key, rule]) => rule.label ?? key);

// Small, closed typo table mirroring nlNormalize.js's own SHORT_WORD_TYPO_FIXES
// (kept as data here, not re-derived from those regexes, since that file's
// version is the one actually enforced — see nlNormalize.js if these ever
// need to change, and update both).
const typos = {
  toal: 'total', whch: 'which', cals: 'calls', moth: 'month', csuts: 'customers', tims: 'times',
};

const personas = [
  {
    id: 'dispatcher',
    label: 'Dispatcher',
    sampleQuestions: [
      'Who is overdue for maintenance in Mesa?',
      'What Trane units do we have on file?',
      'List customers who had a compressor replaced this year.',
      'How many work orders are open right now?',
      'What is the service address for the Ellison account?',
      'Which customers are due for fall maintenance?',
      'How many jobs mention a capacitor?',
      'Is the unit at 412 Elm St still under warranty?',
    ],
  },
  {
    id: 'owner',
    label: 'Shop owner',
    sampleQuestions: [
      'How much have we invoiced this quarter?',
      'How many callbacks did we have on Goodman units?',
      'Which technician closed the most tickets last month?',
      'How many customers have a maintenance agreement?',
      'What is our average invoice amount?',
      'How many permits are still open?',
    ],
  },
];

// A small, illustrative sample of exam templates for the industry that
// already had the full 5-team scorecard build this pack now reads (see
// scripts/gen-scorecard.mjs / test-docs/scorecard) — the plumbing, electrical
// and property packs carry the full 40+ this contract calls for since those
// exams did not exist anywhere before this change.
const examTemplates = [
  { id: 'hvac-count-invoices', category: 'financial', question: 'How many invoices do we have on file?', oracle: 'count_documents_by_type:invoice', compare: 'number', citationRequired: false },
  { id: 'hvac-count-warranty-regs', category: 'warranty', question: 'How many warranty registrations are on file?', oracle: 'count_documents_by_type:warranty-registration', compare: 'number', citationRequired: false },
  { id: 'hvac-count-work-orders', category: 'operations', question: 'How many work orders are on file?', oracle: 'count_documents_by_type:work-order', compare: 'number', citationRequired: false },
  { id: 'hvac-count-customers-with-invoice', category: 'financial', question: 'How many customers have at least one invoice?', oracle: 'count_customers_with_doctype:invoice', compare: 'number', citationRequired: false },
  { id: 'hvac-count-technician-field', category: 'operations', question: 'How many documents record a technician name?', oracle: 'count_documents_with_field:technician', compare: 'number', citationRequired: false },
  { id: 'hvac-count-tonnage-values', category: 'equipment', question: 'How many distinct tonnage values are on file?', oracle: 'count_distinct_field_values:tonnage', compare: 'number', citationRequired: false },
  { id: 'hvac-mentions-capacitor', category: 'content', question: 'How many documents mention a capacitor?', oracle: 'count_documents_mentioning:\\ycapacitors?\\y', compare: 'number', citationRequired: true },
  { id: 'hvac-count-customers', category: 'entities', question: 'How many customers are on file?', oracle: 'count_entities_by_type:customer', compare: 'number', citationRequired: false },
  { id: 'hvac-count-equipment', category: 'entities', question: 'How many pieces of equipment are on file?', oracle: 'count_entities_by_type:equipment', compare: 'number', citationRequired: false },
  { id: 'hvac-missing-warranty-serial', category: 'honest-gaps', question: 'How many warranty registrations are missing a serial number?', oracle: 'count_documents_missing_field:warranty-registration:serial_number', compare: 'honest-zero', citationRequired: false },
  { id: 'hvac-sum-invoice-total', category: 'financial', question: 'What is the total of every invoice on file?', oracle: 'sum_financials_total:invoice', compare: 'number', citationRequired: true },
  { id: 'hvac-unpaid-invoices', category: 'financial', question: 'How many invoices are unpaid?', oracle: 'count_financials_by_status:unpaid', compare: 'number', citationRequired: false },
];

const hvacPack = {
  id: 'hvac',
  label: 'HVAC',
  businessNoun: 'HVAC shop',
  unitNoun: 'unit',
  documentTypes,
  fields,
  brands,
  synonyms: HVAC_TERM_SYNONYMS,
  abbreviations: ABBREV,
  typos,
  maintenance: {
    defaultCadenceMonths: 12,
    // Generic cadence phrasing ("2 visits per year", "semiannual", "quarterly",
    // "monthly", "annual") is already handled industry-agnostically by
    // maintenanceDue.js's parseCadenceMonths itself — HVAC has no cadence
    // phrase beyond that generic vocabulary, so this stays empty.
    cadencePhrases: [],
    seasons: { spring: [3, 5], summer: [6, 8], fall: [9, 11], winter: [12, 2] },
  },
  warranty: { brandRules: BRAND_RULES },
  personas,
  examTemplates,
};

export default hvacPack;
