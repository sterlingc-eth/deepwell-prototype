/**
 * Unit checks for the frontend truth-pass: the "Try asking" suggestion
 * builder, the deep-link URL parser, and the fetch-failure copy mapper. No
 * DOM, no network, no store — every function under test here is pure.
 *
 *   npx tsx scripts/verify-ui.ts
 */
import { buildSuggestions } from '../src/core/suggestions';
import { parseDeepLink } from '../src/hooks/useDeepLink';
import { describeFetchFailure, NETWORK_ERROR_MESSAGE } from '../src/services/ingestClient';
import type { Entity } from '../src/core/types';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name: string, got: unknown, want: unknown): void =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* -------------------------------------------------------- buildSuggestions */

{
  const property = (id: string, address: string, customerName?: string): Entity => ({
    id,
    type: 'property',
    fields: { address, customerName: customerName ?? null },
  });
  const equipment = (id: string, serial: string): Entity => ({
    id,
    type: 'equipment',
    fields: { serial },
  });

  eq('no entities → no suggestions', buildSuggestions([]), []);

  const one = buildSuggestions([property('p1', '123 Main St')]);
  check('one property → one address question', one.length === 1 && one[0]!.includes('123 Main St'), JSON.stringify(one));

  const withCustomer = buildSuggestions([property('p1', '123 Main St', 'Jane Diaz')]);
  check(
    'a customer name produces a customer question, not just the address one',
    withCustomer.some((q) => q.includes('Jane Diaz')),
    JSON.stringify(withCustomer),
  );

  const withEquipment = buildSuggestions([equipment('e1', 'SN-1234')]);
  check('one equipment → a serial question', withEquipment.some((q) => q.includes('SN-1234')), JSON.stringify(withEquipment));
  check(
    'any equipment present → the generic warranty-expiry question is offered',
    withEquipment.includes('Which warranties expire in the next 12 months?'),
  );

  const noRealData = buildSuggestions([{ id: 'p1', type: 'property', fields: { address: null } }]);
  eq('a property with no address contributes nothing fabricated', noRealData, []);

  const many = Array.from({ length: 10 }, (_, i) => property(`p${i}`, `${i} Elm St`));
  check('never more than max (default 5)', buildSuggestions(many).length <= 5);
  check('respects a smaller explicit max', buildSuggestions(many, 2).length <= 2);

  const dup = [property('p1', 'Same St'), property('p2', 'Same St')];
  eq('duplicate questions are not repeated', buildSuggestions(dup), ['When were we last at Same St?']);
}

/* ------------------------------------------------------------ parseDeepLink */

{
  eq('empty search → nothing', parseDeepLink(''), {});
  eq('bare ? → nothing', parseDeepLink('?'), {});
  eq('entity param', parseDeepLink('?entity=eq-42'), { entityId: 'eq-42' });
  eq('doc param', parseDeepLink('?doc=doc-7'), { docId: 'doc-7' });
  eq('a valid screen is accepted', parseDeepLink('?screen=dashboard'), { screen: 'dashboard' });
  eq('an unknown screen is dropped, not passed through', parseDeepLink('?screen=not-a-real-screen'), {});
  eq(
    'entity + doc + screen together',
    parseDeepLink('?entity=eq-1&doc=doc-2&screen=review'),
    { entityId: 'eq-1', docId: 'doc-2', screen: 'review' },
  );
  eq('leading "?" is optional (URLSearchParams tolerates it either way)', parseDeepLink('entity=eq-1'), { entityId: 'eq-1' });
  eq('an empty value is treated as absent', parseDeepLink('?entity=&doc=doc-1'), { docId: 'doc-1' });
}

/* ------------------------------------------------------- describeFetchFailure */

{
  eq(
    'a JSON body with an error message is passed through verbatim',
    describeFetchFailure(JSON.stringify({ error: 'That file is too large.' })),
    'That file is too large.',
  );
  eq('an HTML error page (a raw Vercel 500) falls back to plain language', describeFetchFailure('<html><body>Internal Server Error</body></html>'), NETWORK_ERROR_MESSAGE);
  eq('an empty body falls back to plain language', describeFetchFailure(''), NETWORK_ERROR_MESSAGE);
  eq('JSON with no "error" key falls back to plain language', describeFetchFailure(JSON.stringify({ ok: false })), NETWORK_ERROR_MESSAGE);
  eq('JSON with a blank "error" string falls back to plain language', describeFetchFailure(JSON.stringify({ error: '   ' })), NETWORK_ERROR_MESSAGE);
  check('the fallback message is plain language, never a raw status line', !/^\d{3}\s/.test(NETWORK_ERROR_MESSAGE));
}

/* ------------------------------------------------------------------ done */

console.log('');
if (failures) {
  console.log(`${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log('All checks passed.');
