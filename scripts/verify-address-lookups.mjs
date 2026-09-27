/**
 * Unit checks for Round 15 (Team C)'s address-lookup fixes, PLUS Round 16 (E1)'s owner
 * address-answer policy:
 *   1. fastPath.js: ADDRESS_RE capturing an apartment/unit segment before a
 *      trailing city/state/zip, houseStreetTokens (house number + street
 *      name, no city/zip required), and typo-tolerant trigger words
 *      ("uner warranty", "onnage").
 *   2. fastPathQuery.js: resolveFastPathSubject's address branch matching on
 *      house+street alone, narrowing by an explicit apartment/unit number
 *      when one is named.
 *   3. docLookup.js: the apartment-number word-count cap fix, and the
 *      "Holbrook job" single-word-city-name false rejection fix.
 *   4. contactLookup.js: a typo'd doctype word ("invoides") no longer
 *      swallowed whole as a person name ahead of docLookup.js.
 *   5. R16 (owner product decision 2026-09-26, test-docs/scorecard/ADJUDICATION.md):
 *      ADDRESS_ENTITY_FIELD_INTENTS (warranty/manufacturer/tonnage/refrigerant/install-date)
 *      resolved BY ADDRESS no longer always decline — resolveAddressEntityFieldGroup +
 *      runFastPath's runAddressEntityFieldPolicy resolve address -> customer(s) -> unit(s) and:
 *        - exactly one customer + one unit (or a named brand/model narrows several down to one)
 *          -> answers, with an explicit match-basis sentence + citation.
 *        - one customer, several units, nothing disambiguating -> lists every unit, each with its
 *          own answer + source.
 *        - several customers at the address (apartment complex, no unit #) -> asks which one,
 *          listing names — never picks.
 *        - nothing on file at the address -> "not on file for that address" (unchanged from R15).
 *   6. R16 PART 2 (F1, field-phrasing generalization): a texting numeronym ("4"/"@") ahead of a
 *      house number no longer gets swallowed into the address (fastPath.js's
 *      deslangForAddressMatch); a business named AS the location ("at holy trinity church",
 *      typed lowercase) resolves the SAME as an address would — one customer/unit -> answer,
 *      several units with nothing to narrow them -> an honest decline (never a guessed list,
 *      never a silent merge across units) — see fastPathQuery.js's runCustomerEntityFieldPolicy;
 *      and "model and serial" (or "serial ... and ... model") on ONE already-uniquely-resolved
 *      unit answers both together (runModelAndSerial), never just whichever of the two intents
 *      TRIGGERS happened to match first.
 *
 * Pure/mock-db only — no network, no model call, ever.
 *
 *   node scripts/verify-address-lookups.mjs
 */
import {
  classifyFastPath,
  houseStreetTokens,
  extractSubject,
} from '../api/_lib/fastPath.js';
import { resolveFastPathSubject, runFastPath, resolveAddressEntityFieldGroup } from '../api/_lib/fastPathQuery.js';
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
 * 4. R16 owner address-answer policy — resolveAddressEntityFieldGroup /
 *    runFastPath's runAddressEntityFieldPolicy (test-docs/scorecard/ADJUDICATION.md,
 *    "owner product decision 2026-09-26"). Mock supports the extra raw-SQL shapes this
 *    policy issues (see fastPathQuery.js's own fetchCustomerRowById/fetchCustomerUnits/
 *    fetchFieldRowsByEntity) — dispatch is by recognisable SQL fragment, same style as
 *    section 3's mockEntityDb above.
 * ====================================================================== */
function eqRow({ id, customerId = null, serviceAddress = null, manufacturer = null, model = null, equipmentType = null, serial = null, installDate = null, warranty = null }) {
  return {
    id, entity_type: 'equipment', customer_id: customerId, service_address: serviceAddress,
    data: { manufacturer, model, equipment_type: equipmentType, serial_number: serial, installation_date: installDate, warranty, service_address: serviceAddress },
  };
}
function custRow({ id, name, serviceAddress = null }) {
  return { id, entity_type: 'customer', customer_id: null, service_address: serviceAddress, data: { customer_name: name, service_address: serviceAddress } };
}
function extractionRow({ entityId, documentId, fieldKey, value, confidence = 0.9, stage = 'verified', documentType = 'nameplate-photo' }) {
  return { entity_id: entityId, document_id: documentId, field_key: fieldKey, value, confidence, stage, document_type: documentType };
}
function mockAddressEntityDb({ entities = [], extractions = [] }) {
  return {
    raw: async (sql, params) => {
      check('mockAddressEntityDb :: query is tenant-scoped', /TENANT_SQL|tenant_id/.test(sql) || /current_setting/.test(sql));
      if (/entity_type IN \('customer', 'equipment'\)/.test(sql) && /ILIKE ALL/.test(sql)) {
        const patterns = (params?.[0] ?? []).map((p) => new RegExp(String(p).replace(/^%|%$/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
        return { rows: entities.filter((r) => patterns.every((re) => re.test(r.service_address ?? ''))) };
      }
      // resolveFastPathSubject's own `subject.name` branch (fastPathQuery.js): a plain, single
      // ILIKE %name% against customer_name — needed for section 8's business-name-as-location cases.
      if (/entity_type = 'customer' AND merged_into IS NULL/.test(sql) && /customer_name' ILIKE \$1/.test(sql)) {
        const re = new RegExp(String(params[0]).replace(/^%|%$/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        return {
          rows: entities.filter((r) => r.entity_type === 'customer' && re.test(r.data?.customer_name ?? ''))
            .map((r) => ({ id: r.id, data: r.data, customer_number: r.customer_number ?? null })),
        };
      }
      if (/id = \$1 AND entity_type = 'customer'/.test(sql)) {
        const row = entities.find((r) => r.entity_type === 'customer' && r.id === params[0]);
        return { rows: row ? [{ id: row.id, customer_number: row.customer_number ?? null, data: row.data }] : [] };
      }
      if (/entity_type = 'equipment' AND customer_id = \$1/.test(sql)) {
        return {
          rows: entities.filter((r) => r.entity_type === 'equipment' && r.customer_id === params[0]).map((r) => ({
            id: r.id, customer_id: r.customer_id,
            serial_number: r.data?.serial_number ?? null, model: r.data?.model ?? null,
            manufacturer: r.data?.manufacturer ?? null, equipment_type: r.data?.equipment_type ?? null,
            service_address: r.data?.service_address ?? null, installation_date: r.data?.installation_date ?? null,
            warranty: r.data?.warranty ?? null,
          })),
        };
      }
      if (/x\.entity_id = \$1 AND x\.field_key = \$2/.test(sql)) {
        const [entityId, fieldKey] = params;
        return {
          rows: extractions.filter((x) => x.entity_id === entityId && x.field_key === fieldKey).map((x) => ({
            document_id: x.document_id, field_key: x.field_key, value: x.value, confidence: x.confidence,
            stage: x.stage, document_type: x.document_type, created_at: null, service_date: null,
          })),
        };
      }
      // equipmentDocumentIds (fastPathQuery.js): every document THIS equipment entity is reachable
      // through — a non-unit-scoped citation field (warranty_expires printed) is looked up this way.
      if (/document_entity_links/.test(sql) && /entity_id = \$1/.test(sql)) {
        const entityId = params[0];
        const docIds = [...new Set(extractions.filter((x) => x.entity_id === entityId).map((x) => x.document_id))];
        return { rows: docIds.map((document_id) => ({ document_id })) };
      }
      // fetchFieldRowsByDocumentIds (fastPathQuery.js): the field itself, once the owning
      // document(s) are known.
      if (/x\.document_id = ANY\(\$1::uuid\[\]\) AND x\.field_key = \$2/.test(sql)) {
        const [docIds, fieldKey] = params;
        return {
          rows: extractions.filter((x) => docIds.includes(x.document_id) && x.field_key === fieldKey).map((x) => ({
            document_id: x.document_id, field_key: x.field_key, value: x.value, confidence: x.confidence,
            stage: x.stage, document_type: x.document_type, created_at: null, service_date: null,
          })),
        };
      }
      return { rows: [] };
    },
  };
}

{
  // Single customer, single unit (reached via a CUSTOMER address match — the equipment itself
  // carries no address of its own, the pre-E2-backfill shape) -> answers, match basis + citation.
  const entities = [
    custRow({ id: 'cust-1', name: 'Henderson', serviceAddress: '544 E Ray Rd, Mesa, AZ 85201' }),
    eqRow({ id: 'eq-1', customerId: 'cust-1', manufacturer: 'Trane', equipmentType: 'condenser' }),
  ];
  const extractions = [extractionRow({ entityId: 'eq-1', documentId: 'doc-1', fieldKey: 'manufacturer', value: 'Trane' })];
  const answer = await runFastPath(mockAddressEntityDb({ entities, extractions }),
    { intent: 'manufacturer', subject: { address: '544 E Ray Rd, Mesa, AZ 85201' }, raw: 'Who makes the unit at 544 E Ray Rd, Mesa, AZ 85201?' },
    { today: '2026-09-26' });
  check('single customer/unit :: answers (not a decline)', answer?.kind === 'answer', JSON.stringify(answer));
  check('single customer/unit :: match-basis sentence names the address', /only unit on file for 544 E Ray Rd/i.test(answer?.text ?? ''), answer?.text);
  check('single customer/unit :: match-basis names the customer', /Henderson/.test(answer?.text ?? ''), answer?.text);
  eq('single customer/unit :: cites the real document', answer?.facts?.[0]?.sources?.[0]?.documentId, 'doc-1');
}
{
  // Single unit reached directly BY ITS OWN address (post-E2-backfill shape) -> same policy,
  // warranty_status this time.
  const entities = [
    custRow({ id: 'cust-2', name: 'Alvarez' }),
    eqRow({ id: 'eq-2', customerId: 'cust-2', serviceAddress: '729 W Camelback Rd, Mesa, AZ 85201', manufacturer: 'Carrier', equipmentType: 'furnace', warranty: { expires: '2027-05-01', expiresBasis: 'printed' } }),
  ];
  const extractions = [extractionRow({ entityId: 'eq-2', documentId: 'doc-2', fieldKey: 'warranty_expires', value: '2027-05-01' })];
  const answer = await runFastPath(mockAddressEntityDb({ entities, extractions }),
    { intent: 'warranty_status', subject: { address: '729 W Camelback Rd, Mesa, AZ 85201' }, raw: 'Is the unit at 729 W Camelback Rd, Mesa, AZ 85201 still under warranty?' },
    { today: '2026-09-26' });
  check('single unit via own address :: answers Yes', /^Yes/i.test(answer?.text ?? ''), answer?.text);
  check('single unit via own address :: match basis + customer name', /only unit on file for 729 W Camelback Rd.*Alvarez/i.test(answer?.text ?? ''), answer?.text);
  eq('single unit via own address :: cites the real document', answer?.facts?.[0]?.sources?.[0]?.documentId, 'doc-2');
}
{
  // Several units, a named brand narrows to exactly one -> answers that ONE unit, never the other.
  const entities = [
    custRow({ id: 'cust-3', name: 'Ortiz', serviceAddress: '174 N College Ave, Mesa, AZ 85201' }),
    eqRow({ id: 'eq-3a', customerId: 'cust-3', manufacturer: 'Trane', equipmentType: 'condenser' }),
    eqRow({ id: 'eq-3b', customerId: 'cust-3', manufacturer: 'Carrier', equipmentType: 'air handler' }),
  ];
  const extractions = [
    extractionRow({ entityId: 'eq-3a', documentId: 'doc-3a', fieldKey: 'tonnage', value: '3 ton' }),
    extractionRow({ entityId: 'eq-3b', documentId: 'doc-3b', fieldKey: 'tonnage', value: '2 ton' }),
  ];
  const answer = await runFastPath(mockAddressEntityDb({ entities, extractions }),
    { intent: 'tonnage', subject: { address: '174 N College Ave, Mesa, AZ 85201' }, raw: "What's the tonnage of the Carrier unit at 174 N College Ave, Mesa, AZ 85201?" },
    { today: '2026-09-26' });
  check('brand narrows to one :: answers the Carrier unit', /Carrier/.test(answer?.text ?? '') && /2 ton/.test(answer?.text ?? ''), answer?.text);
  check('brand narrows to one :: never states the OTHER unit\'s value', !/3 ton/.test(answer?.text ?? ''), answer?.text);
  eq('brand narrows to one :: cites the narrowed unit\'s own document', answer?.facts?.[0]?.sources?.[0]?.documentId, 'doc-3b');
}
{
  // Same two units, nothing in the question disambiguates them -> lists EACH unit, its own
  // answer + source, never merges or guesses.
  const entities = [
    custRow({ id: 'cust-3', name: 'Ortiz', serviceAddress: '174 N College Ave, Mesa, AZ 85201' }),
    eqRow({ id: 'eq-3a', customerId: 'cust-3', manufacturer: 'Trane', equipmentType: 'condenser' }),
    eqRow({ id: 'eq-3b', customerId: 'cust-3', manufacturer: 'Carrier', equipmentType: 'air handler' }),
  ];
  const extractions = [
    extractionRow({ entityId: 'eq-3a', documentId: 'doc-3a', fieldKey: 'tonnage', value: '3 ton' }),
    extractionRow({ entityId: 'eq-3b', documentId: 'doc-3b', fieldKey: 'tonnage', value: '2 ton' }),
  ];
  const answer = await runFastPath(mockAddressEntityDb({ entities, extractions }),
    { intent: 'tonnage', subject: { address: '174 N College Ave, Mesa, AZ 85201' }, raw: "What's the tonnage of the unit at 174 N College Ave, Mesa, AZ 85201?" },
    { today: '2026-09-26' });
  check('no disambiguation :: lists every unit', answer?.facts?.length === 2, JSON.stringify(answer?.facts));
  check('no disambiguation :: text says more than one unit', /more than one unit/i.test(answer?.text ?? ''), answer?.text);
  const docIds = (answer?.facts ?? []).flatMap((f) => f.sources.map((s) => s.documentId));
  check('no disambiguation :: each fact keeps its OWN citation', docIds.includes('doc-3a') && docIds.includes('doc-3b'), JSON.stringify(docIds));
}
{
  // Two DIFFERENT manufacturer words in the question, matching TWO different units of the same
  // customer (a "two values for one dimension" trap) -> narrowing must refuse to pick either;
  // falls back to the multi-unit list, never a wrong single pick.
  const entities = [
    custRow({ id: 'cust-3', name: 'Ortiz', serviceAddress: '174 N College Ave, Mesa, AZ 85201' }),
    eqRow({ id: 'eq-3a', customerId: 'cust-3', manufacturer: 'Trane', equipmentType: 'condenser' }),
    eqRow({ id: 'eq-3b', customerId: 'cust-3', manufacturer: 'Carrier', equipmentType: 'air handler' }),
  ];
  const answer = await runFastPath(mockAddressEntityDb({ entities, extractions: [] }),
    { intent: 'tonnage', subject: { address: '174 N College Ave, Mesa, AZ 85201' }, raw: 'Compare the Trane and Carrier units at 174 N College Ave, Mesa, AZ 85201' },
    { today: '2026-09-26' });
  check('two brand words match two units :: falls back to the list, never picks one', answer?.facts?.length === 2, JSON.stringify(answer));
}
{
  // Several CUSTOMERS at the address (apartment complex, no unit # given) -> asks which one,
  // lists names, never picks.
  const entities = [
    custRow({ id: 'cust-4a', name: 'Delgado', serviceAddress: '3300 S Alma School Rd, Mesa, AZ 85201' }),
    custRow({ id: 'cust-4b', name: 'Ramirez', serviceAddress: '3300 S Alma School Rd, Mesa, AZ 85201' }),
  ];
  const answer = await runFastPath(mockAddressEntityDb({ entities, extractions: [] }),
    { intent: 'manufacturer', subject: { address: '3300 S Alma School Rd, Mesa, AZ 85201' }, raw: 'Who makes the unit at 3300 S Alma School Rd, Mesa, AZ 85201?' },
    { today: '2026-09-26' });
  check('several customers :: declines (kind=no-answer), never picks', answer?.kind === 'no-answer', JSON.stringify(answer));
  check('several customers :: asks which one', /more than one customer/i.test(answer?.text ?? ''), answer?.text);
  check('several customers :: lists BOTH names', /Delgado/.test(answer?.text ?? '') && /Ramirez/.test(answer?.text ?? ''), answer?.text);
}
{
  // Apartment complex WITH a unit # named -> must match ONLY that unit's customer, never the
  // neighbors' — single customer + single unit, so this now ANSWERS (not a decline).
  const entities = [
    custRow({ id: 'cust-101', name: 'Nguyen' }), eqRow({ id: 'eq-101', customerId: 'cust-101', serviceAddress: '3300 S Alma School Rd, Apt 101, Mesa, AZ 85201', manufacturer: 'Rheem', equipmentType: 'condenser' }),
    custRow({ id: 'cust-102', name: 'Barrett' }), eqRow({ id: 'eq-102', customerId: 'cust-102', serviceAddress: '3300 S Alma School Rd, Apt 102, Mesa, AZ 85201', manufacturer: 'Lennox', equipmentType: 'condenser' }),
    custRow({ id: 'cust-103', name: 'Salazar' }), eqRow({ id: 'eq-103', customerId: 'cust-103', serviceAddress: '3300 S Alma School Rd, Apt 103, Mesa, AZ 85201', manufacturer: 'Trane', equipmentType: 'condenser' }),
  ];
  const extractions = [extractionRow({ entityId: 'eq-103', documentId: 'doc-103', fieldKey: 'manufacturer', value: 'Trane' })];
  const answer = await runFastPath(mockAddressEntityDb({ entities, extractions }),
    { intent: 'manufacturer', subject: { address: '3300 S Alma School Rd, Apt 103, Mesa, AZ 85201' }, raw: 'Who makes the unit at 3300 S Alma School Rd, Apt 103, Mesa, AZ 85201?' },
    { today: '2026-09-26' });
  check('apartment + unit # :: answers ONLY that unit', /Trane/.test(answer?.text ?? ''), answer?.text);
  check('apartment + unit # :: never mentions a neighboring unit\'s brand', !/Rheem|Lennox/.test(answer?.text ?? ''), answer?.text);
  check('apartment + unit # :: never names a neighbor', !/Nguyen|Barrett/.test(answer?.text ?? ''), answer?.text);
  eq('apartment + unit # :: cites the right unit\'s document', answer?.facts?.[0]?.sources?.[0]?.documentId, 'doc-103');
}
{
  // Nothing on file at that address at all -> "not on file for that address", unchanged from R15.
  const answer = await runFastPath(mockAddressEntityDb({ entities: [], extractions: [] }),
    { intent: 'manufacturer', subject: { address: '9999 Nowhere Ln, Mesa, AZ 85201' }, raw: 'Who makes the unit at 9999 Nowhere Ln, Mesa, AZ 85201?' },
    { today: '2026-09-26' });
  check('nothing on file :: honest decline', answer?.kind === 'no-answer' && /not on file/i.test(answer?.text ?? ''), JSON.stringify(answer));
}
{
  // A unit resolves fine but this SPECIFIC field has no extraction on file for it -> defers to the
  // model (null), same as every other fast-path field miss — never a fabricated value.
  const entities = [
    custRow({ id: 'cust-1', name: 'Henderson', serviceAddress: '544 E Ray Rd, Mesa, AZ 85201' }),
    eqRow({ id: 'eq-1', customerId: 'cust-1', manufacturer: 'Trane', equipmentType: 'condenser' }),
  ];
  const answer = await runFastPath(mockAddressEntityDb({ entities, extractions: [] }),
    { intent: 'refrigerant', subject: { address: '544 E Ray Rd, Mesa, AZ 85201' }, raw: 'What refrigerant does the unit at 544 E Ray Rd, Mesa, AZ 85201 take?' },
    { today: '2026-09-26' });
  eq('resolved unit, field not on file :: defers to the model (null)', answer, null);
}

/* ---------------------------------------------------------- look-alike traps (required by R16) */
{
  // Same house number, DIFFERENT street — must never be conflated with the real record.
  const entities = [
    custRow({ id: 'cust-5', name: 'Ray St Customer', serviceAddress: '544 E Ray Rd, Mesa, AZ 85201' }),
    eqRow({ id: 'eq-5', customerId: 'cust-5', manufacturer: 'Trane', equipmentType: 'condenser' }),
    custRow({ id: 'cust-6', name: 'Elm St Customer', serviceAddress: '544 E Elm St, Mesa, AZ 85201' }),
    eqRow({ id: 'eq-6', customerId: 'cust-6', manufacturer: 'Goodman', equipmentType: 'furnace' }),
  ];
  const group = await resolveAddressEntityFieldGroup(mockAddressEntityDb({ entities, extractions: [] }), '544 E Ray Rd, Mesa, AZ 85201');
  eq('same house #, different street :: resolves to the RIGHT customer only', group.kind, 'customer');
  eq('same house #, different street :: customer is Ray St, not Elm St', group.customer?.data?.customer_name, 'Ray St Customer');
}
{
  // Same street name/house number, DIFFERENT city — two genuinely different customer accounts
  // that happen to share a house+street token set (R15: city/zip is deliberately not required
  // to match). Must be treated as several customers (ask which), never silently conflated into
  // one customer's data.
  const entities = [
    custRow({ id: 'cust-7', name: 'Mesa Customer', serviceAddress: '544 E Ray Rd, Mesa, AZ 85201' }),
    custRow({ id: 'cust-8', name: 'Casa Grande Customer', serviceAddress: '544 E Ray Rd, Casa Grande, AZ 85122' }),
  ];
  const group = await resolveAddressEntityFieldGroup(mockAddressEntityDb({ entities, extractions: [] }), '544 E Ray Rd, Mesa, AZ 85201');
  eq('same street, different city :: two distinct accounts -> multi-customer, never conflated', group.kind, 'multi-customer');
  check('same street, different city :: both real names surfaced', (group.names ?? []).includes('Mesa Customer') && (group.names ?? []).includes('Casa Grande Customer'), JSON.stringify(group.names));
}
{
  // A typo'd street name must fail SAFE (no match at all) rather than silently matching an
  // unrelated on-file street.
  const entities = [
    custRow({ id: 'cust-9', name: 'College Customer', serviceAddress: '174 N College Ave, Mesa, AZ 85201' }),
    eqRow({ id: 'eq-9', customerId: 'cust-9', manufacturer: 'Trane', equipmentType: 'condenser' }),
  ];
  const group = await resolveAddressEntityFieldGroup(mockAddressEntityDb({ entities, extractions: [] }), '174 N Collige Ave, Mesa, AZ 85201');
  eq('typo\'d street :: fails safe (no-address), never a wrong match', group.kind, 'no-address');
}
{
  // Negative control: a NAME-resolved (not address-resolved) subject for these same intents must
  // be completely unaffected by the new policy — resolveFastPathSubject never sets viaAddress for
  // a non-address subject, so runFastPath never even calls the new policy.
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

/* ======================================================================
 * 8. R16 PART 2 (F1): "4"/"@" numeronym address parsing, business-name-as-
 *    location (with its own look-alike/apartment/multi-customer negatives),
 *    and the "model and serial" compound intent.
 * ====================================================================== */
{
  // Positive: a texting numeronym ("4" = "for") directly ahead of a house number no longer gets
  // read as part of the house number itself.
  const fp = classifyFastPath('wats the tonnage 4 396 w baseline rd');
  eq('slang :: "4" ahead of a house number is stripped, never swallowed as part of it', fp?.subject?.address, '396 w baseline rd');
}
{
  // Positive: "@" as "at", right ahead of a bare (no street-suffix-word) address.
  const subject = extractSubject('need the warranty info 4 the unit @ 322 n greenfield');
  eq('slang :: "@" resolves the same as "at" for a bare house+street address', subject.address, '322 n greenfield');
}
{
  // Negative (look-alike): "4 Main St" is a REAL address (a genuine one-digit house number) —
  // the numeronym rewrite must never fire here (no second bare number follows it).
  const fp = classifyFastPath('is the unit at 4 Main St still under warranty');
  eq('slang :: a genuine one-digit house number is left alone (no second number follows)', fp?.subject?.address, '4 Main St');
}
{
  // Negative (look-alike, review fix): a one-digit house number on a NUMBERED street ("21st",
  // "42nd") must never be corrupted either — the token right after the digit starts with a digit
  // too ("2" of "21st"), but is not itself a bare all-digit token, so the numeronym rewrite must
  // not fire (see deslangForAddressMatch's own doc comment for the `\d+\b` fix).
  const fp1 = classifyFastPath('is the unit at 4 21st St still under warranty');
  eq('slang :: a house number ahead of a NUMBERED street is left alone ("4 21st St")', fp1?.subject?.address, '4 21st St');
  const fp2 = classifyFastPath('is the unit at 2 42nd Ave still under warranty');
  eq('slang :: a house number ahead of a NUMBERED street is left alone ("2 42nd Ave")', fp2?.subject?.address, '2 42nd Ave');
}
{
  // Positive: a business name typed exactly as a dispatcher would (lowercase, no address at all)
  // resolves via resolveFastPathSubject's own case-insensitive name match, same as a person's name.
  const fp = classifyFastPath('whats the refrigerant at holy trinity church');
  eq('business-name :: lowercase business name captured as a name subject', fp?.subject?.name, 'holy trinity church');
}
{
  // Positive: that business name resolves to exactly one customer with exactly one qualifying
  // unit -> answers, with its own citation (never a decline just because the subject came from a
  // name instead of a street address).
  const entities = [
    custRow({ id: 'cust-biz1', name: 'Holy Trinity Church' }),
    eqRow({ id: 'eq-biz1', customerId: 'cust-biz1', manufacturer: 'Goodman', equipmentType: 'condenser' }),
  ];
  const extractions = [extractionRow({ entityId: 'eq-biz1', documentId: 'doc-biz1', fieldKey: 'refrigerant', value: 'R-410A' })];
  const answer = await runFastPath(mockAddressEntityDb({ entities, extractions }),
    { intent: 'refrigerant', subject: { name: 'holy trinity church' }, raw: 'whats the refrigerant at holy trinity church' },
    { today: '2026-09-26' });
  check('business-name :: single-unit customer answers, cited', answer?.kind === 'answer' && /R-410A/.test(answer?.text ?? ''), JSON.stringify(answer));
  eq('business-name :: cites the real document', answer?.facts?.[0]?.sources?.[0]?.documentId, 'doc-biz1');
}
{
  // Negative (real multi-unit ambiguity): the SAME business, but with TWO units on file and
  // nothing in the question to narrow them, must decline honestly — never silently pick one
  // unit's value, and never list every unit either (field-phrasing's own ambiguous_multiunit/
  // two_value oracles grade a multi-unit list here as wrong, unlike the address policy's list
  // branch above — see runCustomerEntityFieldPolicy's own doc comment for why the two differ).
  const entities = [
    custRow({ id: 'cust-biz2', name: 'Grace Community Church' }),
    eqRow({ id: 'eq-biz2a', customerId: 'cust-biz2', manufacturer: 'Trane', equipmentType: 'condenser' }),
    eqRow({ id: 'eq-biz2b', customerId: 'cust-biz2', manufacturer: 'Carrier', equipmentType: 'air handler' }),
  ];
  const answer = await runFastPath(mockAddressEntityDb({ entities, extractions: [] }),
    { intent: 'install_date', subject: { name: 'grace community church' }, raw: 'when was the unit installed at grace community church' },
    { today: '2026-09-26' });
  check('business-name :: real multi-unit ambiguity declines (no facts), never lists or guesses', answer?.kind === 'no-answer' && (answer?.facts ?? []).length === 0, JSON.stringify(answer));
}
{
  // Negative (look-alike names): two different real businesses whose names share a common word —
  // resolveFastPathSubject's own ILIKE %name% must not conflate them; a name specific enough to
  // match only one still resolves to exactly that one.
  const entities = [
    custRow({ id: 'cust-first', name: 'First Baptist Church' }),
    eqRow({ id: 'eq-first', customerId: 'cust-first', manufacturer: 'York', equipmentType: 'furnace' }),
    custRow({ id: 'cust-standrew', name: 'St. Andrew Church' }),
    eqRow({ id: 'eq-standrew', customerId: 'cust-standrew', manufacturer: 'Rheem', equipmentType: 'furnace' }),
  ];
  const extractions = [extractionRow({ entityId: 'eq-first', documentId: 'doc-first', fieldKey: 'manufacturer', value: 'York' })];
  const answer = await runFastPath(mockAddressEntityDb({ entities, extractions }),
    { intent: 'manufacturer', subject: { name: 'first baptist church' }, raw: 'who makes the unit at first baptist church' },
    { today: '2026-09-26' });
  check('business-name :: look-alike business names resolve to the RIGHT one only', /York/.test(answer?.text ?? '') && !/Rheem/.test(answer?.text ?? ''), answer?.text);
}
{
  // Positive: "model and serial" on one already-unique unit answers BOTH fields together, each
  // with its own citation — never just whichever of 'model'/'serial' TRIGGERS matched first.
  const entities = [
    custRow({ id: 'cust-ms', name: 'Kowalski', serviceAddress: '1580 W Camelback Rd, Mesa, AZ 85201' }),
    eqRow({ id: 'eq-ms', customerId: 'cust-ms', manufacturer: 'Trane', model: '4TTR4002L1000AA' }),
  ];
  const extractions = [
    extractionRow({ entityId: 'eq-ms', documentId: 'doc-ms-model', fieldKey: 'model', value: '4TTR4002L1000AA' }),
    extractionRow({ entityId: 'eq-ms', documentId: 'doc-ms-serial', fieldKey: 'serial_number', value: 'F100042' }),
  ];
  const fp = classifyFastPath('hey quick one - whats the model and serial on the unit at 1580 W Camelback Rd, Mesa, AZ 85201');
  eq('compound :: "model and serial" classifies as the combined intent, not just one', fp?.intent, 'model_and_serial');
  const answer = await runFastPath(mockAddressEntityDb({ entities, extractions }), fp, { today: '2026-09-26' });
  check('compound :: answers BOTH fields', /4TTR4002L1000AA/.test(answer?.text ?? '') && /F100042/.test(answer?.text ?? ''), answer?.text);
  eq('compound :: two facts, each with its own citation', (answer?.facts ?? []).map((f) => f.sources?.[0]?.documentId).sort(), ['doc-ms-model', 'doc-ms-serial']);
}
{
  // Negative: "model and serial" for a customer with SEVERAL units and nothing to narrow them —
  // never answer half the pair for the wrong unit, or merge across units; defer to the model.
  const entities = [
    custRow({ id: 'cust-ms2', name: 'Ortiz', serviceAddress: '174 N College Ave, Mesa, AZ 85201' }),
    eqRow({ id: 'eq-ms2a', customerId: 'cust-ms2', manufacturer: 'Trane' }),
    eqRow({ id: 'eq-ms2b', customerId: 'cust-ms2', manufacturer: 'Carrier' }),
  ];
  const fp = classifyFastPath('whats the model and serial on the unit at 174 N College Ave, Mesa, AZ 85201');
  const answer = await runFastPath(mockAddressEntityDb({ entities, extractions: [] }), fp, { today: '2026-09-26' });
  eq('compound :: multi-unit customer, nothing to narrow -> defers (null), never a guess', answer, null);
}
{
  // Negative: only ONE of the pair is on file — never answer half a compound question.
  const entities = [
    custRow({ id: 'cust-ms3', name: 'Fenwick', serviceAddress: '2912 E Broadway Rd, Mesa, AZ 85201' }),
    eqRow({ id: 'eq-ms3', customerId: 'cust-ms3', manufacturer: 'Daikin' }),
  ];
  const extractions = [extractionRow({ entityId: 'eq-ms3', documentId: 'doc-ms3', fieldKey: 'serial_number', value: '2R100078' })];
  const fp = classifyFastPath('whats the model and serial on the unit at 2912 E Broadway Rd, Mesa, AZ 85201');
  const answer = await runFastPath(mockAddressEntityDb({ entities, extractions }), fp, { today: '2026-09-26' });
  eq('compound :: only ONE field on file -> defers (null), never a half-answer', answer, null);
}

console.log(`\n${count - failures}/${count} checks passed.`);
if (failures > 0) {
  console.error(`FAILED: ${failures} check(s).`);
  process.exit(1);
}
