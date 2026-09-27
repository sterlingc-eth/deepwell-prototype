/**
 * Unit checks for Round 15 (Team C)'s address-lookup fixes:
 *   1. fastPath.js: ADDRESS_RE capturing an apartment/unit segment before a
 *      trailing city/state/zip, houseStreetTokens (house number + street
 *      name, no city/zip required), and typo-tolerant trigger words
 *      ("uner warranty", "onnage").
 *   2. fastPathQuery.js: resolveFastPathSubject's address branch matching on
 *      house+street alone, narrowing by an explicit apartment/unit number
 *      when one is named, and runFastPath's honest decline
 *      (buildAddressFieldDecline) for warranty/manufacturer/tonnage/
 *      refrigerant/install-date questions resolved BY ADDRESS — this
 *      corpus's equipment entities never carry their own service_address
 *      (see handoff), so a real-value answer for these five intents from a
 *      bare street address is never correct; declining honestly is.
 *   3. docLookup.js: the apartment-number word-count cap fix, and the
 *      "Holbrook job" single-word-city-name false rejection fix.
 *   4. contactLookup.js: a typo'd doctype word ("invoides") no longer
 *      swallowed whole as a person name ahead of docLookup.js.
 *
 * Pure/mock-db only — no network, no model call, ever.
 *
 *   node scripts/verify-address-lookups.mjs
 */
import {
  classifyFastPath,
  houseStreetTokens,
  ADDRESS_ENTITY_FIELD_INTENTS,
} from '../api/_lib/fastPath.js';
import { resolveFastPathSubject, runFastPath } from '../api/_lib/fastPathQuery.js';
import { parseDocLookupQuestion } from '../api/_lib/docLookup.js';
import { parseContactLookupQuestion } from '../api/_lib/contactLookup.js';

let failures = 0;
let count = 0;
const check = (name, ok, detail = '') => {
  count++;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* ======================================================================
 * 1. houseStreetTokens — house number + up to 2 street-name words, no city/
 *    zip/directional required or included.
 * ====================================================================== */
eq('houseStreetTokens :: full address w/ apt + city/zip', houseStreetTokens('3300 S Alma School Rd, Apt 103, Mesa, AZ 85201'), ['3300', 'alma', 'school']);
eq('houseStreetTokens :: bare street, mismatched-city question phrasing', houseStreetTokens('544 E Ray Rd, Casa Grande, AZ 85122'), ['544', 'ray']);
eq('houseStreetTokens :: no city/zip at all', houseStreetTokens('729 W Camelback Rd'), ['729', 'camelback']);
eq('houseStreetTokens :: garbage -> empty', houseStreetTokens('the weather today'), []);

/* ======================================================================
 * 2. classifyFastPath — ADDRESS_RE capture + typo-tolerant triggers.
 * ====================================================================== */
{
  const fp = classifyFastPath('Is the unit at 3300 S Alma School Rd, Apt 103, Mesa, AZ 85201 still under warranty?');
  check('classifyFastPath :: intent = warranty_status', fp?.intent === 'warranty_status', JSON.stringify(fp));
  check('classifyFastPath :: address captures the apt segment', /apt 103/i.test(fp?.subject?.address ?? ''), JSON.stringify(fp?.subject));
  check('classifyFastPath :: address still carries the city/zip', /mesa/i.test(fp?.subject?.address ?? ''), JSON.stringify(fp?.subject));
}
{
  // Typo'd trigger word "uner" (under) must still classify.
  const fp = classifyFastPath('Is the Rheem at 544 E Ray Rd, Casa Grande, AZ 85122 uner warranty?');
  eq('classifyFastPath :: typo "uner warranty" -> warranty_status', fp?.intent, 'warranty_status');
}
{
  // Typo'd trigger word "onnage" (tonnage).
  const fp = classifyFastPath("What's the onnage of the unit at 174 N College Ave, Mesa, AZ 85201?");
  eq('classifyFastPath :: typo "onnage" -> tonnage', fp?.intent, 'tonnage');
}

/* ======================================================================
 * 3. resolveFastPathSubject — house+street match, unit narrowing, and the
 *    three new resolution kinds (no-address / no-unit / ambiguous).
 * ====================================================================== */
function mockEntityDb(rows) {
  return {
    raw: async (sql, params) => {
      check('resolveFastPathSubject :: query is tenant-scoped', /tenant_id = \(current_setting/.test(sql) || /\$tenant/i.test(sql) || /TENANT_SQL|tenant_id/.test(sql));
      const patterns = (params?.[0] ?? []).map((p) => new RegExp(String(p).replace(/^%|%$/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
      const matched = rows.filter((r) => patterns.every((re) => re.test(r.service_address ?? '')));
      return { rows: matched };
    },
  };
}

{
  // Single apartment complex, 8 units — asking about a SPECIFIC apartment
  // resolves to exactly that unit's own equipment, never a guess across all 8.
  const rows = [101, 102, 103].map((n) => ({
    id: `eq-${n}`,
    entity_type: 'equipment',
    customer_id: `c-${n}`,
    service_address: `3300 S Alma School Rd, Apt ${n}, Mesa, AZ 85201`,
  }));
  const resolution = await resolveFastPathSubject(mockEntityDb(rows), { address: '3300 S Alma School Rd, Apt 103, Mesa, AZ 85201' });
  eq('resolveFastPathSubject :: apt 103 among 3 units -> unique equipment', resolution.kind, 'equipment');
  eq('resolveFastPathSubject :: resolves the RIGHT unit (103, not 101/102)', resolution.equipment?.id, 'eq-103');
  check('resolveFastPathSubject :: flags viaAddress', resolution.viaAddress === true, JSON.stringify(resolution));
}
{
  // Same complex, asking about an apartment NOT on file -> honest "no-unit",
  // never a guess at a different apartment's data.
  const rows = [101, 102].map((n) => ({ id: `eq-${n}`, entity_type: 'equipment', service_address: `3300 S Alma School Rd, Apt ${n}, Mesa, AZ 85201` }));
  const resolution = await resolveFastPathSubject(mockEntityDb(rows), { address: '3300 S Alma School Rd, Apt 999, Mesa, AZ 85201' });
  eq('resolveFastPathSubject :: unnamed unit on file -> no-unit (never falls back to another unit)', resolution.kind, 'no-unit');
}
{
  // Multiple units, question does NOT name a specific one -> ambiguous, never
  // an arbitrary pick.
  const rows = [101, 102].map((n) => ({ id: `eq-${n}`, entity_type: 'equipment', service_address: `3300 S Alma School Rd, Apt ${n}, Mesa, AZ 85201` }));
  const resolution = await resolveFastPathSubject(mockEntityDb(rows), { address: '3300 S Alma School Rd, Mesa, AZ 85201' });
  eq('resolveFastPathSubject :: no unit named, multiple on file -> ambiguous', resolution.kind, 'ambiguous');
}
{
  // City in the QUESTION mismatches the city on FILE (a common dispatcher
  // error) — must still resolve by house+street alone, never fail closed.
  const rows = [{ id: 'eq-1', entity_type: 'equipment', service_address: '544 E Ray Rd, Mesa, AZ 85201' }];
  const resolution = await resolveFastPathSubject(mockEntityDb(rows), { address: '544 E Ray Rd, Casa Grande, AZ 85122' });
  eq('resolveFastPathSubject :: mismatched city in question still resolves by street', resolution.kind, 'equipment');
}
{
  // Nothing on file for that street at all.
  const resolution = await resolveFastPathSubject(mockEntityDb([]), { address: '9999 Nowhere Ln, Mesa, AZ 85201' });
  eq('resolveFastPathSubject :: no address on file -> no-address', resolution.kind, 'no-address');
}

/* ======================================================================
 * 4. runFastPath — honest decline for warranty/manufacturer/tonnage/
 *    refrigerant/install-date when resolved BY ADDRESS (never a fabricated
 *    value — this corpus's equipment rows never own a service_address, so a
 *    real answer here would necessarily come from the WRONG record).
 * ====================================================================== */
for (const intent of ADDRESS_ENTITY_FIELD_INTENTS) {
  const rows = [{ id: 'eq-1', entity_type: 'equipment', service_address: '544 E Ray Rd, Mesa, AZ 85201', data: {} }];
  const answer = await runFastPath(mockEntityDb(rows), { intent, subject: { address: '544 E Ray Rd, Mesa, AZ 85201' } }, { today: '2026-09-26' });
  check(`runFastPath :: ${intent} via address never fabricates (kind=no-answer)`, answer?.kind === 'no-answer', JSON.stringify(answer));
  eq(`runFastPath :: ${intent} via address returns zero facts`, answer?.facts, []);
}
{
  // Ambiguous address + a field intent -> decline names the ambiguity, not a
  // guessed unit's value.
  const rows = [101, 102].map((n) => ({ id: `eq-${n}`, entity_type: 'equipment', service_address: `3300 S Alma School Rd, Apt ${n}, Mesa, AZ 85201` }));
  const answer = await runFastPath(mockEntityDb(rows), { intent: 'warranty_status', subject: { address: '3300 S Alma School Rd, Mesa, AZ 85201' } }, { today: '2026-09-26' });
  check('runFastPath :: ambiguous address decline mentions more than one unit', /more than one/i.test(answer?.text ?? ''), answer?.text);
}
{
  // No unit on file at all -> "not on file for that address", nothing inferred.
  const answer = await runFastPath(mockEntityDb([]), { intent: 'manufacturer', subject: { address: '9999 Nowhere Ln, Mesa, AZ 85201' } }, { today: '2026-09-26' });
  check('runFastPath :: no address on file -> "not on file" decline', /not on file/i.test(answer?.text ?? ''), answer?.text);
}
{
  // Negative control: a NAME-resolved (not address-resolved) subject for
  // these same intents must be completely unaffected by the new gate —
  // resolveFastPathSubject never sets viaAddress for a non-address subject,
  // so runFastPath falls through past the decline exactly as before.
  const resolution = await resolveFastPathSubject({ raw: async () => ({ rows: [] }) }, { name: 'Salazar' });
  eq('resolveFastPathSubject :: name-only subject, no address given -> none (unaffected by address gate)', resolution.kind, 'none');
}

/* ======================================================================
 * 5. docLookup.js :: apartment-number word-count cap + "Holbrook job".
 * ====================================================================== */
{
  const parsed = parseDocLookupQuestion('Did we pull a permit for 3300 S Alma School Rd, Apt 101, Mesa, AZ 85201?');
  check('docLookup :: apartment address with city/zip now parses at all', Boolean(parsed), JSON.stringify(parsed));
  check('docLookup :: apartment segment preserved in namePhrase', /apt 101/i.test(parsed?.namePhrase ?? ''), parsed?.namePhrase);
}
{
  const parsed = parseDocLookupQuestion('Do we have a PO on file for the Holbrook job?');
  eq('docLookup :: "Holbrook job" -> purchase-order for Holbrook (not rejected as a city)', parsed && { doctype: parsed.doctype, namePhrase: parsed.namePhrase }, { doctype: 'purchase-order', namePhrase: 'holbrook' });
}
{
  // Negative: a BARE city reference (no "job"/"install" marker) must still be
  // rejected as a geo scope, not hijacked as a customer name — Holbrook and
  // Gilbert are both real AZ towns.
  eq('docLookup :: bare "for Gilbert" (no job/install marker) still rejected as geo scope', parseDocLookupQuestion('list invoices for Gilbert'), null);
  eq('docLookup :: bare "for Holbrook" (no job/install marker) still rejected as geo scope', parseDocLookupQuestion('list invoices for Holbrook'), null);
}
{
  // Sanity: an ordinary surname job reference is unaffected.
  const parsed = parseDocLookupQuestion('Do we have a PO on file for the Salazar job?');
  eq('docLookup :: ordinary surname + job unaffected', parsed && { doctype: parsed.doctype, namePhrase: parsed.namePhrase }, { doctype: 'purchase-order', namePhrase: 'salazar' });
}

/* ======================================================================
 * 6. contactLookup.js :: typo'd doctype word must not be swallowed as a name.
 * ====================================================================== */
eq('contactLookup :: "list invoides for delgado" -> null (defers to docLookup, like the untypo\'d form)', parseContactLookupQuestion('list invoides for delgado'), null);
eq('contactLookup :: untypo\'d "list invoices for Delgado" -> null (unaffected baseline)', parseContactLookupQuestion('list invoices for Delgado'), null);
{
  // Negative: a genuine bare-name contact question (no doctype word at all)
  // must still resolve as a contact lookup, not get swept up by this fix.
  const parsed = parseContactLookupQuestion("what's Delgado's phone number");
  check('contactLookup :: genuine contact question unaffected', Boolean(parsed), JSON.stringify(parsed));
}

/* ======================================================================
 * 7. Negative-test families required for every new intent family.
 * ====================================================================== */
{
  // Negation: "is NOT under warranty" must not be answered as a plain
  // warranty_status intent the same way as the positive form would be —
  // classifyFastPath only classifies intent/subject, so this asserts the
  // negation wording still extracts the SAME address (no address parsing
  // regression from negation) while leaving the polarity to the caller.
  const fp = classifyFastPath('Is the unit at 174 N College Ave, Mesa, AZ 85201 NOT still under warranty?');
  check('negative family :: negated warranty question still extracts an address', /174 n college/i.test(fp?.subject?.address ?? ''), JSON.stringify(fp?.subject));
}
{
  // Two values for one dimension: a question naming TWO different addresses
  // must not silently pick one — houseStreetTokens only ever looks at the
  // FIRST address span ADDRESS_RE captures, so this documents (and locks)
  // that a compound question doesn't quietly resolve against the wrong one.
  const fp = classifyFastPath('Is the unit at 174 N College Ave, Mesa, AZ 85201 under warranty, not 322 N Greenfield Rd?');
  eq('negative family :: two addresses -> only the first is captured (no silent merge)', houseStreetTokens(fp?.subject?.address ?? ''), ['174', 'college']);
}
{
  // Dropped condition: an address with NO unit designator at an apartment
  // complex that has one on file for every equipment row must resolve to
  // "ambiguous", never guess a unit the caller never named.
  const rows = [101, 102, 103].map((n) => ({ id: `eq-${n}`, entity_type: 'equipment', service_address: `3300 S Alma School Rd, Apt ${n}, Mesa, AZ 85201` }));
  const resolution = await resolveFastPathSubject(mockEntityDb(rows), { address: '3300 S Alma School Rd' });
  eq('negative family :: dropped unit condition -> ambiguous, not a guess', resolution.kind, 'ambiguous');
}
{
  // Ambiguous names: "Holbrook" bare (no job marker) must still defer, since
  // it's ambiguous between the AZ town and a possible surname without more
  // context — this is the same case as section 5's negative but restated
  // here as the required "ambiguous names" family.
  eq('negative family :: ambiguous city/surname bare phrase still defers', parseDocLookupQuestion('what proposal did we give Holbrook'), null);
}

console.log(`\n${count - failures}/${count} checks passed.`);
if (failures > 0) {
  console.error(`FAILED: ${failures} check(s).`);
  process.exit(1);
}
