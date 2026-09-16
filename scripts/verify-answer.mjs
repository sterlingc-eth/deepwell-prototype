/**
 * Pure-function checks for the answer contract: shapeAnswer(), buildAllowed()
 * and buildPrompt() in api/_lib/answer.js. No database, no network — these
 * three functions are where citations get invented or don't, so they need to
 * be checkable without standing up Postgres or calling the model.
 *
 * What this guards, concretely:
 *   - Bug 1 (the trust bug): there is no code path left in this file that
 *     manufactures an "allowed" citation out of anything but retrieval rows.
 *     That fix lives mostly in api/ask.js (the deleted `records` fallback),
 *     but everything here assumes `allowed` is honest, so a regression that
 *     re-widens `allowed` to include unretrieved documents would slip past
 *     these tests — see the note at the bottom about what these tests can't
 *     catch.
 *   - Bug 2: a fact must cite a page (or extracted field) retrieval actually
 *     returned FOR THAT DOCUMENT, not just any document in the allowed set.
 *   - Bug 3: a fact's `basis` is "printed" unless the caller explicitly
 *     vouches for computed evidence (`allowComputed: true`), so a model can't
 *     dodge the page/field check by labelling a fabrication "computed".
 *
 *   node scripts/verify-answer.mjs
 */
import { shapeAnswer, buildAllowed, buildPrompt, ANSWER_TOOL } from '../api/_lib/answer.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// A realistic "retrieval actually returned this" fixture, shared by most cases.
const PASSAGES = [
  { documentId: 'doc-real-1', filename: 'invoice.pdf', documentType: 'invoice', page: 2, excerpt: 'Warranty expires 2034-03-10.' },
  { documentId: 'doc-real-2', filename: 'nameplate.jpg', documentType: 'nameplate', page: 1, excerpt: 'Model CG-4021-A.' },
];
const EXTRACTIONS = [
  { documentId: 'doc-real-1', filename: 'invoice.pdf', field: 'warranty_expires', value: '2034-03-10' },
];
const ALLOWED = buildAllowed({ passages: PASSAGES, extractions: EXTRACTIONS });

const fact = (overrides = {}) => ({
  label: 'Warranty',
  value: 'Expires 2034-03-10',
  sources: [{ documentId: 'doc-real-1', location: { page: 2 } }],
  ...overrides,
});

/* ------------------------------------------------------- required minimum */

{
  // a fact citing a document not in allowedDocs
  const out = shapeAnswer(
    { text: 'x', facts: [fact({ sources: [{ documentId: 'doc-NEVER-RETRIEVED', location: { page: 1 } }] })], confidence: 0.9 },
    ALLOWED
  );
  eq('drops a fact citing an unretrieved document', out.facts, []);
  eq('unretrieved-document fact yields no-answer', out.kind, 'no-answer');
}

{
  // a fact with an empty location
  const out = shapeAnswer(
    { text: 'x', facts: [fact({ sources: [{ documentId: 'doc-real-1', location: {} }] })], confidence: 0.9 },
    ALLOWED
  );
  eq('drops a fact with an empty location (Bug 2)', out.facts, []);
}

{
  // a fact with a page retrieval never returned, on a document it DID return
  const out = shapeAnswer(
    { text: 'x', facts: [fact({ sources: [{ documentId: 'doc-real-1', location: { page: 99 } }] })], confidence: 0.9 },
    ALLOWED
  );
  eq('drops a fact citing an unretrieved page of a real document (Bug 2)', out.facts, []);
}

{
  // a fact with no sources at all
  const out = shapeAnswer({ text: 'x', facts: [fact({ sources: [] })], confidence: 0.9 }, ALLOWED);
  eq('drops a fact with no sources', out.facts, []);
}

{
  // a legitimate fact survives intact, from a passage citation
  const f = fact();
  const out = shapeAnswer({ text: 'Expires 2034-03-10.', facts: [f], confidence: 0.9 }, ALLOWED);
  check('legitimate passage-cited fact survives', out.facts.length === 1 && out.kind === 'answer');
  eq('legitimate fact source is unchanged', out.facts[0].sources, f.sources);
  eq('legitimate fact gets basis "printed" by default', out.facts[0].basis, 'printed');
}

{
  // a legitimate fact survives via an extracted-field citation (no page)
  const out = shapeAnswer(
    {
      text: 'Expires 2034-03-10.',
      facts: [fact({ sources: [{ documentId: 'doc-real-1', location: { field: 'warranty_expires' } }] })],
      confidence: 0.9,
    },
    ALLOWED
  );
  check('legitimate extraction-field-cited fact survives', out.facts.length === 1);
}

{
  // the no-answer shape
  const out = shapeAnswer({ text: 'Nothing in your records answers that.', facts: [], confidence: 0 }, ALLOWED);
  eq('no-answer kind', out.kind, 'no-answer');
  eq('no-answer sources', out.sources, []);
  eq('no-answer confidence', out.confidence, 0);
}

/* -------------------------------------------------------- garbage inputs */

for (const [name, raw] of Object.entries({
  'null model output': null,
  'undefined model output': undefined,
  'string model output': 'not an object',
  'number model output': 42,
  'facts not an array': { text: 'x', facts: 'nope', confidence: 1 },
  'facts array of junk': { text: 'x', facts: [null, 42, 'x', { sources: null }, { label: 1, value: 2, sources: [] }], confidence: 1 },
  'source is a string': { text: 'x', facts: [fact({ sources: ['doc-real-1'] })], confidence: 1 },
  'source with numeric documentId': { text: 'x', facts: [fact({ sources: [{ documentId: 42, location: { page: 2 } }] })], confidence: 1 },
  'source with array location': { text: 'x', facts: [fact({ sources: [{ documentId: 'doc-real-1', location: [] }] })], confidence: 1 },
  'confidence is a string': { text: 'x', facts: [fact()], confidence: 'high' },
})) {
  let threw = false;
  let out;
  try {
    out = shapeAnswer(raw, ALLOWED);
  } catch {
    threw = true;
  }
  check(`does not throw on: ${name}`, !threw);
  if (!threw) check(`falls back to a well-formed shape on: ${name}`, out.kind === 'answer' || out.kind === 'no-answer');
}

{
  // no `allowed` supplied at all — must fail closed, not throw and not trust anything
  const out = shapeAnswer({ text: 'x', facts: [fact()], confidence: 1 });
  eq('missing allowed set fails closed to no-answer', out.kind, 'no-answer');
}

/* ------------------------------------------------ self-attack: Bug 2 redux */

{
  // Cross-document page confusion: page 1 WAS retrieved, but for doc-real-2,
  // not doc-real-1. A check keyed only on "was this page number ever seen
  // anywhere" would let this through.
  const out = shapeAnswer(
    { text: 'x', facts: [fact({ sources: [{ documentId: 'doc-real-1', location: { page: 1 } }] })], confidence: 1 },
    ALLOWED
  );
  eq('drops a real page number attached to the wrong document', out.facts, []);
}

{
  // Cross-document field confusion, same idea: 'warranty_expires' was
  // extracted from doc-real-1, not doc-real-2.
  const out = shapeAnswer(
    {
      text: 'x',
      facts: [fact({ sources: [{ documentId: 'doc-real-2', location: { field: 'warranty_expires' } }] })],
      confidence: 1,
    },
    ALLOWED
  );
  eq('drops a real field name attached to the wrong document', out.facts, []);
}

{
  // One bad citation and one good citation on the SAME fact: the bad one
  // must not get to piggyback on the good one, but the fact should still
  // survive on the strength of the legitimate source.
  const out = shapeAnswer(
    {
      text: 'x',
      facts: [
        fact({
          sources: [
            { documentId: 'doc-real-1', location: { page: 2 } }, // good
            { documentId: 'doc-real-1', location: { page: 55 } }, // fabricated
          ],
        }),
      ],
      confidence: 1,
    },
    ALLOWED
  );
  check('a mixed good/bad source list keeps only the good source', out.facts.length === 1 && out.facts[0].sources.length === 1);
}

{
  // location.page sent as a numeric STRING rather than a number. The tool
  // schema declares it a number; a caller that hand-builds JSON (or a model
  // that ignores the schema) sending "2" must not be treated as page 2.
  const out = shapeAnswer(
    { text: 'x', facts: [fact({ sources: [{ documentId: 'doc-real-1', location: { page: '2' } }] })], confidence: 1 },
    ALLOWED
  );
  eq('a stringified page number is not accepted as a match', out.facts, []);
}

/* ------------------------------------------------------- self-attack: Bug 3 */

{
  // Model marks a fabricated, page-free citation "computed" to try to skip
  // the page/field check. allowComputed defaults to false (as /api/ask uses
  // it), so this must be overruled back to "printed" and still fail.
  const out = shapeAnswer(
    { text: 'x', facts: [fact({ basis: 'computed', sources: [{ documentId: 'doc-real-1', location: {} }] })], confidence: 1 },
    ALLOWED
    // allowComputed omitted -> false
  );
  eq('a claimed "computed" basis does not bypass citation checking by default', out.facts, []);
}

{
  // Same shape, but the caller explicitly vouches for computed evidence
  // (the only way a future warranty endpoint would call this). Now it may
  // survive on documentId membership alone, with no page required.
  const out = shapeAnswer(
    { text: 'x', facts: [fact({ basis: 'computed', sources: [{ documentId: 'doc-real-1', location: {} }] })], confidence: 1 },
    ALLOWED,
    { allowComputed: true }
  );
  check('an opted-in computed fact may cite a document with no page', out.facts.length === 1);
  eq('its basis is preserved as "computed"', out.facts[0].basis, 'computed');
}

{
  // Even with allowComputed:true, a document retrieval never returned must
  // still be rejected — "computed" only waives the page/field requirement,
  // never document membership.
  const out = shapeAnswer(
    { text: 'x', facts: [fact({ basis: 'computed', sources: [{ documentId: 'doc-NEVER-RETRIEVED', location: {} }] })], confidence: 1 },
    ALLOWED,
    { allowComputed: true }
  );
  eq('computed basis still requires a retrieved document', out.facts, []);
}

/* -------------------------------------------------------------- buildAllowed */

{
  const allowed = buildAllowed({ passages: PASSAGES, extractions: EXTRACTIONS });
  check('buildAllowed tracks both documents', allowed.docs.has('doc-real-1') && allowed.docs.has('doc-real-2'));
  check('buildAllowed tracks per-document pages', allowed.pages.get('doc-real-1')?.has(2) && !allowed.pages.get('doc-real-2')?.has(2));
  check('buildAllowed tracks per-document fields', allowed.fields.get('doc-real-1')?.has('warranty_expires'));
  const empty = buildAllowed();
  check('buildAllowed() with no args produces an empty, non-throwing allow-set', empty.docs.size === 0);
}

/* --------------------------------------------------------------- buildPrompt */

{
  const p = buildPrompt({ question: 'when does it expire', today: '2026-09-16', passages: PASSAGES, extractions: EXTRACTIONS });
  check('prompt includes the question', p.includes('when does it expire'));
  check('prompt includes each passage documentId', p.includes('doc-real-1') && p.includes('doc-real-2'));
  check('prompt includes page numbers', p.includes('page: 2') && p.includes('page: 1'));
  check('prompt includes the extracted-fields block', p.includes('ALREADY-EXTRACTED FIELDS'));
  check('prompt tells the model how to cite an extracted field', p.includes('"field"'));
  check('prompt states the no-page-invention rule', p.toLowerCase().includes('do not invent a page'));
}

{
  const p = buildPrompt({ question: 'anything?', today: '2026-09-16', passages: [], extractions: [] });
  check('prompt handles zero passages without crashing', p.includes('(no passages matched)'));
  check('prompt omits the extracted-fields block when there are none', !p.includes('ALREADY-EXTRACTED FIELDS'));
}

/* ------------------------------------------------------------- tool schema */

{
  const factSchema = ANSWER_TOOL.input_schema.properties.facts.items.properties;
  check('ANSWER_TOOL exposes a basis field on each fact (Bug 3 contract)', !!factSchema.basis);
  eq('basis is constrained to printed/computed', factSchema.basis.enum, ['printed', 'computed']);
  check('ANSWER_TOOL still requires a location on every source', ANSWER_TOOL.input_schema.properties.facts.items.properties.sources.items.required.includes('location'));
}

/* ---------------------------------------------------------------- summary */

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');

/**
 * What these tests can't catch, on purpose (and why that's a different
 * layer's job):
 *
 *   - Whether api/ask.js still builds `allowed` from client-supplied data
 *     instead of retrieval rows. That's the actual Bug 1 fix, and it isn't a
 *     pure function — it depends on the request body and the DB call in
 *     api/ask.js. Guarding it here would mean re-implementing ask.js's
 *     control flow as a second copy that could drift from the real one. The
 *     durable guard against that regression is that api/ask.js no longer
 *     HAS a `records` parameter to read, not a unit test asserting it
 *     ignores one.
 *   - Whether the client (answerService.claude.ts) still sends a `records`
 *     payload. Same reason: that's an HTTP request body, not a pure
 *     function, and the fix there is that the field was deleted from the
 *     fetch body, not a mock to assert against.
 *   - A model that returns a syntactically valid citation for a page/field
 *     it was shown, but for the wrong FACT (e.g. citing the warranty page to
 *     support an unrelated claim about install cost). shapeAnswer can only
 *     check "was this exact citation ever shown to the model", not whether
 *     the citation actually supports the specific value string attached to
 *     it — that would require re-reading the excerpt against the claim,
 *     which is a groundedness check, not a sourcing check, and isn't
 *     currently done anywhere in this pipeline.
 */
process.exit(failures ? 1 : 0);
