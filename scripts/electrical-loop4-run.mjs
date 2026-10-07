/** Fast standalone runner for the loop-3 electrical regressions: node scripts/electrical-loop4-run.mjs */
let failures = 0; let passes = 0;
const check = (n, ok, d = '') => { if (ok) passes++; else { failures++; console.log(`FAIL  ${n}${d ? `\n      ${d}` : ''}`); } };
const { startMixedHarness } = await import('./lib/mixed-company-harness.mjs');
const { extractElectrical } = await import('../api/_lib/industry/electrical/extract.js');
const { classifyElectrical, runElectrical, electricalAttention } = await import('../api/_lib/industry/electrical/lane.js');
const H = await startMixedHarness();
const { runElectricalLoop4, runElectricalReviewLoop1, runElectricalReviewLoop2, runElectricalReviewLoop3, runElectricalReviewLoop4, runElectricalReviewLoop5, runElectricalReviewLoop6, runElectricalReviewLoop7 } = await import('./lib/electrical-loop4-regressions.mjs');
const L4A = { H, lane: { classify: classifyElectrical, run: runElectrical }, attention: electricalAttention, extract: extractElectrical, check };
await runElectricalLoop4(L4A);
await runElectricalReviewLoop1(L4A);
await runElectricalReviewLoop2(L4A);
await runElectricalReviewLoop3(L4A);
await runElectricalReviewLoop4(L4A);
await runElectricalReviewLoop5(L4A);
await runElectricalReviewLoop6(L4A);
await runElectricalReviewLoop7(L4A);
console.log(failures ? `${failures} FAILED (${passes} passed)` : `${passes} loop-4 checks passed`);
process.exit(failures ? 1 : 0);
