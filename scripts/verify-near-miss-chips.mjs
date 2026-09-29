/**
 * R24 — near-miss customer names become one-tap corrected re-asks (never an auto-guess).
 * Feeds the SERVER's real decline builder (api/_lib/contactLookup.js buildNearMissDeclineAnswer)
 * into the CLIENT parser (src/core/suggestions.ts nearMissRetryChips), so the two can't drift apart.
 * Run: npx tsx scripts/verify-near-miss-chips.mjs
 */
import { buildNearMissDeclineAnswer } from '../api/_lib/contactLookup.js';
import { nearMissRetryChips } from '../src/core/suggestions.ts';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

const decline = (phrase, names) => buildNearMissDeclineAnswer(phrase, names.map((n, i) => ({ id: `id-${i}`, customer_name: n }))).text;

// Positives: one suggestion, typo phrase in different case / position.
{
  const q = "what's the gate code for BRENDA hollwell";
  const chips = nearMissRetryChips(q, decline('brenda hollwell', ['Brenda Holwell']));
  check('single suggestion → one chip', chips.length === 1, JSON.stringify(chips));
  check('corrected question keeps the rest of the question', chips[0]?.text === "what's the gate code for Brenda Holwell", chips[0]?.text);
}
{
  const q = 'when did we last service tomas reyess unit';
  const chips = nearMissRetryChips(q, decline('tomas reyess', ['Tomas Reyes', 'Tomas Reyna']));
  check('two suggestions → two chips', chips.length === 2, JSON.stringify(chips));
  check('each chip substitutes its own name', chips[0]?.text === 'when did we last service Tomas Reyes unit' && chips[1]?.text === 'when did we last service Tomas Reyna unit', JSON.stringify(chips));
}
{
  const chips = nearMissRetryChips('email for zzq', decline('zzq', ['A B', 'C D', 'E F', 'G H']));
  check('never more than 3 chips', chips.length <= 3, String(chips.length));
}

// Negatives: nothing to suggest, other answer shapes, phrase not in the question.
check('no suggestion → no chips', nearMissRetryChips('email for nobody here', decline('nobody here', [])).length === 0);
check('ordinary answer text → no chips', nearMissRetryChips('email for Sandra', "Sandra Wyckoff's email is s@x.com.").length === 0);
check('honest zero text → no chips', nearMissRetryChips('any permits for Oak St', 'No permits on file for Oak St.').length === 0);
check('phrase absent from question → no chips', nearMissRetryChips('something else entirely', decline('brenda hollwell', ['Brenda Holwell'])).length === 0);
check('null inputs → no chips', nearMissRetryChips(null, null).length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
