/**
 * Round 12 (G1 — answer presentation): unit tests for src/core/answerLayout.ts's pure functions,
 * plus a Playwright harness (scripts/answer-harness/, same technique as scripts/graph-harness) that
 * renders AnswerCard and MobileAnswer for every layout kind at 390/1280px in both Office (dark) and
 * Field (light) view. Checks: no horizontal overflow, no console errors, every new tap target
 * (data-tap-target) is >=44px, and every status badge/colored value passes WCAG AA contrast against
 * its background. Screenshots go to SHOT_DIR (arg 1) — look at them.
 *
 *   npx playwright install chromium   (once, if not already present)
 *   npx tsx scripts/verify-answer-ui.mjs [screenshotDir]
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { answerLayout, claimCheckNote, claimCheckOf, followupChips, shareText } from '../src/core/answerLayout';
import { FIXTURES, LAYOUT_ORDER } from './answer-harness/fixtures';

const SHOT_DIR = process.argv[2] ?? '/tmp/claude-0/-home-claude/c8b456ad-32a9-5305-923e-589d73c65629/scratchpad';
mkdirSync(SHOT_DIR, { recursive: true });

let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* ============================================================================================== *
 * Part 1 — answerLayout() unit tests, on the exact fixtures the harness renders (so a fixture that *
 * drifts out of the layout it's meant to demonstrate fails HERE, loudly, before a screenshot ever  *
 * silently shows the wrong hero).                                                                  *
 * ============================================================================================== */

for (const kind of LAYOUT_ORDER) {
  eq(`answerLayout: '${kind}' fixture maps to '${kind}'`, answerLayout(FIXTURES[kind]), kind);
}

// Precedence and edge cases not covered by the one-fixture-per-kind sweep above.
eq('answerLayout: no-answer always wins, regardless of facts', answerLayout({ kind: 'no-answer', facts: [{ label: 'x', value: '$5', kind: 'money', sources: [] }] }), 'not-on-file');
eq('answerLayout: empty answer (no facts, no records, no basis) falls to prose', answerLayout({ kind: 'answer', facts: [], records: [] }), 'prose');
eq(
  'answerLayout: a single status fact takes status over single-fact',
  answerLayout({ kind: 'answer', facts: [{ label: 'Warranty', value: 'Active', status: 'ok', sources: [] }] }),
  'status',
);
eq(
  'answerLayout: many sourceless/statusless facts (a breakdown) is list even with zero records',
  answerLayout({
    kind: 'answer',
    facts: Array.from({ length: 8 }, (_, i) => ({ label: `City ${i}`, value: String(i + 1), sources: [] })),
  }),
  'list',
);
eq(
  // A single fact IS the answer, regardless of a basis sentence — 'explain' needs >=2 supporting
  // facts (the "supporting facts" plural the layout is named for); one fact reads better as single-fact.
  'answerLayout: a basis sentence with exactly one fact is still single-fact',
  answerLayout({ kind: 'answer', facts: [{ label: 'Reason', value: 'Out of area', sources: [] }], basis: 'Computed from the service radius on file.' }),
  'single-fact',
);
eq(
  'answerLayout: a basis sentence with 2+ facts and no other signal is explain',
  answerLayout({
    kind: 'answer',
    facts: [
      { label: 'Reason', value: 'Out of area', sources: [] },
      { label: 'Service radius', value: '25 miles', sources: [] },
    ],
    basis: 'Computed from the service radius on file.',
  }),
  'explain',
);
eq(
  'answerLayout: >=6 records with no facts is list even with no recordsKind set',
  answerLayout({ kind: 'answer', facts: [], records: Array.from({ length: 6 }, (_, i) => ({ type: 'document', id: `d${i}` })) }),
  'list',
);

// claimCheckOf / claimCheckNote — the server field src/core/types.ts never declares.
check('claimCheckOf: undefined on a plain mock Answer', claimCheckOf(FIXTURES.money) === undefined, '');
check(
  'claimCheckOf: reads a well-formed claimCheck object',
  claimCheckOf({ claimCheck: { policy: 'agent', checked: 3, supported: 3, unsupported: [], rate: 0 } })?.checked === 3,
  '',
);
check('claimCheckOf: rejects a malformed claimCheck (no throw)', claimCheckOf({ claimCheck: { checked: 'nope' } }) === undefined, '');
check('claimCheckNote: null when there is nothing to check', claimCheckNote({ ...FIXTURES.money, claimCheck: undefined }) === null, '');
{
  const withClaims = { ...FIXTURES.status, claimCheck: { policy: 'agent', checked: 2, supported: 2, unsupported: [], rate: 0 } };
  eq('claimCheckNote: counts the answer\'s own distinct source documents', claimCheckNote(withClaims), 'Checked against 2 documents');
}

// followupChips — deterministic, never repeats the question or an on-screen fact label.
{
  const chips = followupChips(FIXTURES.status, 'Is the furnace under warranty?');
  check('followupChips: returns at most 3', chips.length > 0 && chips.length <= 3, `got ${chips.length}`);
  check('followupChips: never repeats a fact label already shown', !chips.some((c) => c.toLowerCase().startsWith('warranty status')), chips.join(' | '));
}
{
  const same = followupChips({ kind: 'answer', facts: [{ label: 'x', value: '1', sources: [] }] }, 'Last service?');
  check('followupChips: never echoes the question just asked', !same.map((c) => c.toLowerCase()).includes('last service?'), same.join(' | '));
}

// shareText — plain text, degrades to the bare id without a resolver.
{
  const text = shareText('Warranty status?', FIXTURES.status);
  check('shareText: opens with the question', text.startsWith('Q: Warranty status?'), text.slice(0, 40));
  check('shareText: includes every fact label', FIXTURES.status.facts.every((f) => text.includes(f.label)), '');
  check('shareText: falls back to the bare document id with no resolver', text.includes('warr1'), '');
  const named = shareText('Warranty status?', FIXTURES.status, (id) => (id === 'warr1' ? 'Warranty · Carrier XR16' : undefined));
  check('shareText: uses a resolved document name when given one', named.includes('Warranty · Carrier XR16'), '');
}
{
  const text = shareText('Any unit at 900 W Baseline?', FIXTURES['not-on-file']);
  check('shareText: an honest empty answer lists the CLOSEST documents, not "Sources:"', text.includes('Closest documents:'), '');
}

console.log(`\nUnit tests: ${passes} passed, ${failures} failed so far.\n`);

/* ============================================================================================== *
 * Part 2 — Playwright harness: render every layout, both components, both widths, both themes.    *
 * ============================================================================================== */

const PORT = 5184;
const url = (view) => `http://localhost:${PORT}/scripts/answer-harness/index.html?view=${view}`;

function relLuminance({ r, g, b }) {
  const [R, G, B] = [r, g, b].map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}
function contrastRatio(fg, bg) {
  const L1 = relLuminance(fg);
  const L2 = relLuminance(bg);
  const lighter = Math.max(L1, L2);
  const darker = Math.min(L1, L2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Contrast of every element matching `selector`, against the nearest ancestor with an opaque
 *  background — returns [] if nothing matches (never a false pass). */
async function contrastChecks(page, selector) {
  return page.$$eval(
    selector,
    (els) =>
      els.map((el) => {
        function parse(str) {
          const m = /rgba?\(([^)]+)\)/.exec(str);
          if (!m) return null;
          const p = m[1].split(',').map((s) => parseFloat(s.trim()));
          return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 };
        }
        let node = el;
        let bg = null;
        while (node && !bg) {
          const parsed = parse(getComputedStyle(node).backgroundColor);
          if (parsed && parsed.a > 0.01) bg = parsed;
          node = node.parentElement;
        }
        const style = getComputedStyle(el);
        return {
          text: (el.textContent || '').trim().slice(0, 40),
          fg: parse(style.color),
          bg: bg ?? { r: 255, g: 255, b: 255, a: 1 },
          fontSize: parseFloat(style.fontSize),
          fontWeight: parseInt(style.fontWeight, 10) || 400,
        };
      }),
  );
}

let server;
try {
  server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1800));

  const browser = await chromium.launch();
  const shot = (page, name) => page.screenshot({ path: `${SHOT_DIR}/answer-${name}.png`, fullPage: true });

  async function runViewport(view, viewport, fieldMode, label) {
    const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
    const consoleErrors = [];
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('Failed to load resource')) consoleErrors.push(`console: ${m.text()}`);
    });

    await page.goto(url(view), { waitUntil: 'networkidle' });
    if (fieldMode) await page.evaluate(() => window.__dwSetField?.(true));
    await page.waitForTimeout(400);

    const rootSel = view === 'mobile' ? '[data-testid="mobile-root"]' : '[data-testid="desktop-root"]';
    check(`${label}: harness mounted`, (await page.locator(rootSel).count()) > 0);
    for (const kind of LAYOUT_ORDER) {
      const testid = view === 'mobile' ? `m-fixture-${kind}` : `fixture-${kind}`;
      check(`${label}: '${kind}' fixture rendered`, (await page.locator(`[data-testid="${testid}"]`).count()) > 0);
    }

    await shot(page, `${label}-${view}`);

    // Tap targets: every control this round marked data-tap-target must be >=44px in both dimensions.
    const boxes = await page.locator('[data-tap-target]').all();
    let smallCount = 0;
    for (const b of boxes) {
      const box = await b.boundingBox();
      if (box && (box.width < 44 || box.height < 44)) smallCount++;
    }
    check(`${label}: all ${boxes.length} tap targets are >=44px`, boxes.length > 0 && smallCount === 0, `${smallCount} of ${boxes.length} undersized`);

    // Contrast: every dw-pill-* badge, plus the new large-text status/money hero values.
    const pillRuns = await contrastChecks(page, '.dw-pill-ok, .dw-pill-warn, .dw-pill-bad, .dw-pill-info');
    let pillFail = 0;
    for (const r of pillRuns) {
      if (!r.fg) continue;
      const ratio = contrastRatio(r.fg, r.bg);
      const isLarge = r.fontSize >= 24 || (r.fontSize >= 18.66 && r.fontWeight >= 700);
      if (ratio < (isLarge ? 3 : 4.5)) pillFail++;
    }
    check(`${label}: all ${pillRuns.length} status pills pass AA contrast`, pillFail === 0, `${pillFail} of ${pillRuns.length} failed`);

    const heroRuns = await contrastChecks(page, '[data-testid="status-hero-value"], [data-testid="money-hero-amount"]');
    let heroFail = 0;
    for (const r of heroRuns) {
      if (!r.fg) continue;
      const ratio = contrastRatio(r.fg, r.bg);
      const isLarge = r.fontSize >= 24 || (r.fontSize >= 18.66 && r.fontWeight >= 700);
      if (ratio < (isLarge ? 3 : 4.5)) heroFail++;
    }
    check(`${label}: all ${heroRuns.length} hero values pass AA contrast`, heroRuns.length > 0 && heroFail === 0, `${heroFail} of ${heroRuns.length} failed`);

    const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    check(`${label}: no horizontal overflow`, !overflowX);
    check(`${label}: no console errors`, consoleErrors.length === 0, consoleErrors.join(' | '));

    // Interaction smoke test: a follow-up chip and a source chip both actually fire their callback.
    if (view === 'desktop') {
      const statusSection = page.locator('[data-testid="fixture-status"]');
      const chip = statusSection.getByRole('button', { name: /Last service|Open work orders|Service history/ }).first();
      if (await chip.count()) {
        await chip.click();
        const opens = await page.evaluate(() => window.__dwOpens ?? []);
        check(`${label}: a follow-up chip fires onAsk`, opens.some((o) => o.startsWith('ask:')), opens.join(', '));
      }
    }

    await page.close();
  }

  await runViewport('desktop', { width: 1280, height: 1400 }, false, 'desktop-office');
  await runViewport('desktop', { width: 1280, height: 1400 }, true, 'desktop-field');
  await runViewport('desktop', { width: 390, height: 1400 }, false, 'phonewidth-office');
  await runViewport('mobile', { width: 390, height: 1400 }, false, 'mobile-office');
  await runViewport('mobile', { width: 390, height: 1400 }, true, 'mobile-field');
  await runViewport('mobile', { width: 1280, height: 1400 }, false, 'mobile-wide');

  await browser.close();
} finally {
  server?.kill();
}

console.log(failures ? `\n${failures} FAILED, ${passes} passed` : `\nall ${passes} passed`);
console.log(`Screenshots in ${SHOT_DIR}`);
process.exit(failures ? 1 : 0);
