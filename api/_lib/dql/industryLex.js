/**
 * dql/industryLex.js - the everyday nouns of businesses other than an HVAC shop, in one closed table.
 *
 * DeepWell stores every business the same way: a "customer" entity, documents that carry a service date (visits), a person who did the work
 * (the technician field) and a kind of paper (document type). What differs between a law office, a clinic, a nonprofit and a repair shop is only
 * the WORD people use for those four things. This file holds those words; it never decides what a word means for one organization:
 *
 *   - customer / staff / visit nouns name the same things in every organization, so they are plain synonyms of the generic entity words;
 *   - a paper noun ("letter", "estimate", "pledge", "repair order") may stand for different kinds of paper in different organizations, so it
 *     is only taken when EXACTLY ONE of the kinds it can mean is actually in use in THIS organization's own records (resolveDocAliases below).
 *     Two candidates in use -> the word is left unexplained and the question is released (the coverage rule).
 */

const pl = (s) => (/(?:s|x|ch|sh)$/.test(s) ? `${s}es` : /[^aeiou]y$/.test(s) ? `${s.slice(0, -1)}ies` : `${s}s`);
const both = (list) => list.flatMap((w) => [w, pl(w)]);

export const CUSTOMER_NOUNS = both(['patient', 'tenant', 'resident', 'owner', 'donor', 'supporter', 'member', 'account', 'homeowner', 'guest', 'student']);
export const STAFF_NOUNS = [
  ...both(['attorney', 'lawyer', 'provider', 'doctor', 'physician', 'nurse', 'mechanic', 'supervisor', 'coordinator', 'plumber', 'electrician', 'inspector', 'cleaner', 'installer', 'caseworker', 'crew lead', 'crew leader', 'site lead', 'staff member', 'maintenance tech']),
  'foreman', 'foremen', 'staff', 'crew leads',
];
export const VISIT_NOUNS = both(['appointment', 'consultation', 'session', 'hearing', 'meeting', 'event', 'shop visit', 'repair visit']);

/** phrase -> the kinds of paper it can stand for. Only kinds in use in the organization's own records are ever taken (resolveDocAliases). */
const A = {
  invoice: ['bill', 'patient bill', 'tenant charge', 'repair invoice', 'sponsor invoice', 'pay application'],
  'proposal-quote': ['estimate', 'bid', 'proposal', 'quote', 'quotation'],
  'purchase-order': ['po', 'purchase order', 'material order', 'expense order'],
  'work-order': ['repair order', 'maintenance request', 'work order'],
  'service-ticket': ['service ticket', 'maintenance ticket', 'job ticket', 'service report'],
  'maintenance-agreement': ['service contract', 'maintenance contract', 'service agreement', 'maintenance agreement', 'contract'],
  agreement: ['engagement letter', 'retainer agreement', 'retainer', 'consent form', 'signed form', 'signed contract', 'contract', 'agreement'],
  permit: ['permit', 'building permit'],
  'inspection-report': ['inspection', 'quality inspection', 'inspection report'],
  correspondence: ['letter', 'notice', 'referral', 'referral letter', 'thank you letter', 'thank-you letter', 'email', 'correspondence'],
  receipt: ['payment receipt', 'copay receipt', 'receipt'],
  statement: ['statement'],
  'insurance-certificate': ['insurance card', 'insurance record', 'insurance certificate', 'certificate of insurance', 'coi'],
  'certificate-of-insurance': ['certificate of insurance', 'coi'],
  schedule: ['schedule entry', 'schedule entries', 'event schedule', 'schedule'],
  other: ['filing', 'court filing', 'lab result', 'test result'],
  'dispatch-note': ['crew dispatch', 'dispatch note'],
  'delivery-ticket': ['delivery', 'delivery ticket'],
  'lease-agreement': ['lease', 'lease agreement'],
  'equipment-record': ['vehicle record', 'equipment record', 'appliance record'],
  'warranty-registration': ['parts warranty', 'warranty registration'],
};
/** Words that a business of one kind uses for a paper, and that mean nothing (or something else) to the others. Taken only when the organization's industry setting says so. */
const SCOPED = {
  construction: { 'work-order': ['change order'] },
  nonprofit: { receipt: ['donation', 'gift', 'donation receipt', 'gift receipt'], agreement: ['pledge', 'pledge agreement'], statement: ['donor statement'] },
};
const ALIAS = new Map(); // phrase -> Set(type ids)
for (const [id, ph] of Object.entries(A)) for (const p of ph) for (const form of /s$|ies$/.test(p) ? [p] : [p, pl(p)]) { if (!ALIAS.has(form)) ALIAS.set(form, new Set()); ALIAS.get(form).add(id); }

/** phrase -> type id for the phrases that mean exactly one kind of paper among those the organization has. */
export function resolveDocAliases(typesInUse, industryKind = null) {
  const inUse = new Set(typesInUse);
  const out = new Map();
  for (const [phrase, ids] of ALIAS) {
    const have = [...ids].filter((i) => inUse.has(i));
    if (have.length === 1) out.set(phrase, have[0]);
  }
  const kind = String(industryKind ?? '').toLowerCase().replace(/-admin$/, '');
  const scoped = new Set();
  for (const [id, ph] of Object.entries(SCOPED[kind] ?? {})) {
    if (!inUse.has(id)) continue;
    for (const p of ph) for (const form of [p, pl(p)]) { out.set(form, id); scoped.add(form); }
  }
  out.scoped = scoped;
  return out;
}

/** Words that keep their meaning only when the organization's own data does not use them as a field (a property manager's "tenant" is a lease party, not the customer). */
export const FIELD_CLAIMED_NOUNS = { tenant_name: ['tenant', 'tenants'], patient_name: ['patient', 'patients'] };

/** Regex source (word-boundary free) for every everyday word for a visit, for the families that read the sentence with their own patterns. */
export const VISIT_ALT = VISIT_NOUNS.map((w) => w.replace(/\s+/g, '\\s+')).sort((a, b) => b.length - a.length).join('|');

/** Words only other kinds of business use for these things (jargon.js already folds patient / tenant / donor ... into "customer" for everyone). An HVAC shop, or an organization with no industry chosen, does not read them. */
export const FOREIGN_WORDS = new Set([
  ...['attorney', 'lawyer', 'provider', 'doctor', 'physician', 'nurse', 'mechanic', 'supervisor', 'coordinator', 'inspector', 'cleaner', 'caseworker', 'owner', 'account', 'guest', 'student', 'consultation', 'session', 'hearing', 'meeting', 'event'].flatMap((w) => [w, pl(w)]),
  'foremen',
]);
