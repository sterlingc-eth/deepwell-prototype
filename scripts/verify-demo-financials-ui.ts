/**
 * verify:demo-financials-ui - the money on the RENDERED screens of the public industry demo (/demo/), in a real browser, for every industry.
 *   npm run verify:demo-financials-ui                       builds the demo (VITE_DEEPWELL_DEMO=true) into a temp folder and checks every industry
 *   npx tsx scripts/verify-demo-financials-ui.ts --only realty,hotel
 *   npx tsx scripts/verify-demo-financials-ui.ts --dist <folder>     check an already built demo
 * For each industry it uploads the sample documents, opens the Dashboard and reads what is on the screen: the tiles, the "open balance by age" rows, the
 * "billing by customer" rows, every row of the documents table; it opens every document and reads its total, charges, payment and page text; it asks every
 * suggested question and reads Donovan's answer. Each figure must equal the one recomputed from the documents (scripts/lib/demo-financials.ts), to the cent.
 * If no browser is installed here it says so and passes (set DW_REQUIRE_UI=1 to make that a failure, as the release check does).
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { DemoDocument, DemoFixture, DemoIndex } from '../src/demo/engine';
import { CANON, expectedOf, fmtC, cents, moneyIn, niceDate, pillOf, valueOf } from './lib/demo-financials';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2); const argOf = (k: string) => (argv.includes('--' + k) ? argv[argv.indexOf('--' + k) + 1] : undefined);
const only = argOf('only')?.split(','); const required = process.env.DW_REQUIRE_UI === '1';
let passed = 0; const failures: string[] = [];
const ok = (c: unknown, name: string) => { if (c) passed++; else failures.push(name); };
const skip = (why: string): never => { console.log(`verify:demo-financials-ui  SKIPPED (${why})`); process.exit(required ? 1 : 0); };

let chromium: { launch: (o?: object) => Promise<any> };
try { chromium = (await import('playwright')).chromium; } catch { skip('playwright is not installed'); }
let browser: any;
try { browser = await chromium!.launch(); } catch (e) { skip('no browser could be started: ' + String(e).split('\n')[0]); }

/* ------------------------------------------------------------ the built demo, served from a temp folder */
let dist = argOf('dist'); let tmp: string | null = null;
if (!dist) {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-demo-fin-'));
  const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const r = spawnSync(process.execPath, [vite, 'build', '--outDir', tmp, '--emptyOutDir', '--logLevel', 'error'], { cwd: ROOT, env: { ...process.env, VITE_DEEPWELL_DEMO: 'true', VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true' }, encoding: 'utf8', timeout: 280000 });
  if (r.status !== 0) { console.log('build failed:\n' + (r.stdout + r.stderr).slice(-1500)); process.exit(1); }
  dist = tmp;
}
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url ?? '/').split('?')[0]!); if (p.endsWith('/')) p += 'index.html';
  const f = path.normalize(path.join(dist!, p)); if (!f.startsWith(path.normalize(dist!)) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] ?? 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/demo/`;
ok(fs.existsSync(path.join(dist!, 'demo', 'index.html')), 'the built demo has /demo/index.html');

/* ------------------------------------------------------------ expected screens */
const FX = path.join(ROOT, 'src', 'demo', 'fixtures');
const index = JSON.parse(fs.readFileSync(path.join(FX, 'index.json'), 'utf8')) as DemoIndex;
const niceText = (t: string) => t.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => niceDate(m));
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const nums = (t: string) => (t.match(/\d[\d,]*(?:\.\d+)?/g) ?? []);

for (const { slug } of index.industries.filter((i) => !only || only.includes(i.slug))) {
  const fx = JSON.parse(fs.readFileSync(path.join(FX, `${slug}.demo.json`), 'utf8')) as DemoFixture; const t = `[${slug}]`;
  const e = expectedOf(fx); const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors: string[] = []; page.on('pageerror', (x: Error) => errors.push(String(x)));
  try {
    await page.goto(`${base}?industry=${slug}`);
    await page.getByRole('button', { name: /Upload sample documents/ }).click();
    await page.getByRole('button', { name: /Skip ahead/ }).click();
    await page.getByRole('button', { name: /See the dashboard/ }).click();
    await page.locator('#demo-dash-h').waitFor();
    // ---- tiles
    const tiles: Record<string, { value: string; note: string }> = {};
    for (const el of await page.locator('[data-tile]').all()) { const label = (await el.getAttribute('data-tile'))!; const ps = await el.locator('p').allTextContents(); tiles[label] = { value: ps[1] ?? '', note: ps[2] ?? '' }; }
    if (e.invoices > 0) {
      ok(tiles['Billed']?.value === fmtC(e.billedC), `${t} Billed tile ${tiles['Billed']?.value} vs ${fmtC(e.billedC)}`);
      ok(tiles['Collected']?.value === fmtC(e.collectedC), `${t} Collected tile ${tiles['Collected']?.value} vs ${fmtC(e.collectedC)}`);
      ok(tiles['Open balance']?.value === fmtC(e.openC), `${t} Open balance tile ${tiles['Open balance']?.value} vs ${fmtC(e.openC)}`);
      ok(tiles['Open balance']?.note === `${e.openInvoices} open · ${fmtC(e.overdueC)} overdue`, `${t} Open balance note "${tiles['Open balance']?.note}"`);
      ok(nums(tiles['Billed']?.note ?? '')[0] === String(e.invoices), `${t} Billed note count "${tiles['Billed']?.note}"`);
      // ---- aging + customers
      const aging = (await page.locator('[data-testid=aging] tr').evaluateAll((trs: Element[]) => trs.map((tr) => [...tr.querySelectorAll('th,td')].map((c) => c.textContent!.trim())))) as string[][];
      const wantAging = [...e.aging.map((a) => [a.label, String(a.invoices), fmtC(a.amountC)]), ['Open balance', String(e.openInvoices), fmtC(e.openC)]];
      ok(JSON.stringify(aging) === JSON.stringify(wantAging), `${t} open balance by age: ${JSON.stringify(aging)} vs ${JSON.stringify(wantAging)}`);
      const cust = (await page.locator('[data-testid=by-customer] tbody tr').evaluateAll((trs: Element[]) => trs.map((tr) => [...tr.querySelectorAll('th,td')].map((c) => c.textContent!.trim())))) as string[][];
      const wantCust = [...e.byCustomer.map((c) => [c.name, fmtC(c.billedC), fmtC(c.collectedC), fmtC(c.openC)]), [cust.at(-1)?.[0] ?? '', fmtC(e.billedC), fmtC(e.collectedC), fmtC(e.openC)]];
      ok(JSON.stringify(cust) === JSON.stringify(wantCust), `${t} billing by customer: ${JSON.stringify(cust.at(-1))} vs ${JSON.stringify(wantCust.at(-1))}`);
      // what is on screen adds up (read back from the rendered strings)
      const sc = cust.slice(0, -1).reduce((a, r) => a + valueOf(r[1]!), 0);
      ok(sc === valueOf(tiles['Billed']!.value), `${t} the customer rows on screen add to the Billed tile`);
      ok(aging.slice(0, -1).reduce((a, r) => a + valueOf(r[2]!), 0) === valueOf(tiles['Open balance']!.value), `${t} the aging rows on screen add to the Open balance tile`);
      ok(valueOf(tiles['Billed']!.value) === valueOf(tiles['Collected']!.value) + valueOf(tiles['Open balance']!.value), `${t} Billed = Collected + Open balance on screen`);
    } else {
      ok(tiles['Amounts on file']?.value === fmtC(e.amountsOnFileC), `${t} Amounts on file tile ${tiles['Amounts on file']?.value} vs ${fmtC(e.amountsOnFileC)}`);
      ok(!tiles['Billed'] && !tiles['Open balance'], `${t} no Billed / Open balance tile without bills`);
    }
    // ---- documents table (as a set; rows with the same date may swap places)
    const rows = (await page.locator('[data-testid=docs] tbody tr').evaluateAll((trs: Element[]) => trs.map((tr) => [...tr.querySelectorAll('td')].map((c) => c.textContent!.trim())))) as string[][];
    const wantRows = fx.documents.map((d) => [`${d.typeLabel}${d.number ? ' ' + d.number : ''}`, d.customer ?? d.vendor ?? '—', niceDate(d.date), d.total != null ? fmtC(cents(d.total)) : '—', pillOf(d, fx.demoToday) ?? d.status ?? '']);
    const key = (r: string[]) => r.join('|');
    ok(JSON.stringify(rows.map(key).sort()) === JSON.stringify(wantRows.map(key).sort()), `${t} documents table differs from the documents`);
    const pillOpen = rows.reduce((a, r) => a + (/^(Open|Overdue) \$/.test(r[4]!) ? valueOf(r[4]!.split(' ')[1]!) : 0), 0);
    ok(pillOpen === (e.invoices > 0 ? e.openC : 0), `${t} the Open / Overdue pills on screen add to the open balance`);
    // ---- every document, opened
    const byFile = new Map(fx.documents.map((d) => [d.file, d]));
    for (let k = 0; k < rows.length; k++) {
      await page.locator('[data-testid=docs] tbody tr').nth(k).locator('button').click();
      const dlg = page.getByRole('dialog');
      const cap = (await dlg.locator('p.text-caption').first().textContent())!; const file = cap.split(' · ')[0]!; const d = byFile.get(file) as DemoDocument | undefined;
      if (!d) { failures.push(`${t} a document opened that is not in the workspace (${file})`); await page.keyboard.press('Escape'); continue; }
      const pairs = async (sel: string) => (await dlg.locator(`${sel} > div`).evaluateAll((ds: Element[]) => ds.map((x) => [x.querySelector('dt')!.textContent!.trim(), x.querySelector('dd')!.textContent!.trim()]))) as string[][];
      const main = await pairs('dl:not([aria-label])'); const charges = await dlg.locator('dl[aria-label=Charges]').count() ? await pairs('dl[aria-label=Charges]') : null; const pay = await dlg.locator('dl[aria-label=Payment]').count() ? await pairs('dl[aria-label=Payment]') : null;
      const pre = (await dlg.locator('pre').allTextContents()).join('\n');
      const n = `${t} ${d.name}`;
      const total = main.find(([a]) => a === 'Total')?.[1] ?? null;
      ok((d.total == null ? null : fmtC(cents(d.total))) === total, `${n}: Total ${total} vs ${d.total}`);
      ok(pre === d.pages.join('\n'), `${n}: page text`);
      const onPage = /^TOTAL: (\$.+)$/m.exec(pre)?.[1] ?? null; ok(onPage === total, `${n}: page TOTAL ${onPage} vs Total ${total}`);
      for (const [fk, fv] of d.fields) if (fv.startsWith('$')) ok(main.some(([a, b]) => a === fk && b === fv), `${n}: field ${fk} ${fv}`);
      if (d.lines) {
        const want = d.lines.map((l) => [l.desc, fmtC(cents(l.amount))]); if (d.tax != null) want.push(['Subtotal', fmtC(cents(d.subtotal!))], [`${d.taxLabel} (${((d.taxRate ?? 0) * 100).toFixed(1)}%)`, fmtC(cents(d.tax))]);
        ok(JSON.stringify(charges) === JSON.stringify(want), `${n}: charges ${JSON.stringify(charges)} vs ${JSON.stringify(want)}`);
        const lsum = (charges ?? []).slice(0, d.lines.length).reduce((a, r) => a + valueOf(r[1]!), 0); const sub = d.tax != null ? valueOf(charges![d.lines.length]![1]!) : lsum;
        ok(lsum === sub && sub + (d.tax != null ? valueOf(charges![d.lines.length + 1]![1]!) : 0) === valueOf(total!), `${n}: the charges on screen add to the Total`);
      } else ok(charges === null, `${n}: charges shown without lines`);
      if (d.pay) {
        const late = Math.max(0, Math.floor((Date.parse(fx.demoToday) - Date.parse(d.pay.dueOn)) / 86400000)) * (cents(d.pay.balance) > 0 ? 1 : 0);
        const want = [['Paid', fmtC(cents(d.pay.paid))], ['Balance', fmtC(cents(d.pay.balance))], ['Due', niceDate(d.pay.dueOn) + (late > 0 ? `, ${late} days overdue` : '')]]; if (d.pay.paidOn) want.push(['Last payment', niceDate(d.pay.paidOn)]);
        ok(JSON.stringify(pay) === JSON.stringify(want), `${n}: payment ${JSON.stringify(pay)} vs ${JSON.stringify(want)}`);
        ok(valueOf(pay![0]![1]!) + valueOf(pay![1]![1]!) === valueOf(total!), `${n}: paid + balance on screen = Total`);
      } else ok(pay === null, `${n}: payment shown for something that is not a bill`);
      for (const m of moneyIn(pre + ' ' + main.map((x) => x[1]).join(' '))) ok(CANON.test(m), `${n}: ${m} is not written as $1,234.00`);
      await page.keyboard.press('Escape');
    }
    // ---- Donovan
    await page.getByRole('button', { name: /^3\. Ask Donovan/ }).click();
    for (const q of fx.questions) {
      await page.getByRole('button', { name: q.q, exact: true }).click();
      const text = norm(await page.locator('[data-testid=answer]').textContent() ?? '');
      ok(text === norm(niceText(q.answer.text)), `${t} answer to "${q.q}": "${text}" vs "${norm(niceText(q.answer.text))}"`);
      for (const m of moneyIn(text)) ok(CANON.test(m), `${t} answer to "${q.q}": ${m} is not written as $1,234.00`);
    }
    ok(errors.length === 0, `${t} no script errors (${errors[0] ?? ''})`);
  } catch (err) { failures.push(`${t} could not be driven: ${String(err).split('\n')[0]}`); }
  await page.close();
}
await browser.close(); server.close(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
console.log(`verify:demo-financials-ui  ${passed} passed, ${failures.length} failed  (${only ?? index.industries.length} ${only ? 'industries' : 'industries, rendered in a browser'})`);
for (const f of failures.slice(0, 40)) console.log('  FAIL ' + f);
process.exit(failures.length ? 1 : 0);
