// Dev helper for the iPad screenshots: run a few starter questions through the REAL /api/ask handler on the locally
// seeded demo companies and save the exact response bodies (the screenshot harness replays them).
import fs from 'node:fs';
import path from 'node:path';
import { bootLocal, localOrgId, ROOT } from './lib/local-env.mjs';
const [stateFile, outFile, ...pairs] = process.argv.slice(2);
const env = await bootLocal({ dataDir: stateFile });
env.model.mode = 'mock'; env.model.answerMock = async () => { const e = new Error('offline'); e.status = 400; throw e; };
console.log = () => {}; console.warn = () => {}; console.error = () => {};
const { SCORECARD_CALL } = await import(path.join(ROOT, 'api/_lib/scorecard/hook.js'));
const { default: ask } = await import(path.join(ROOT, 'api/ask.js'));
const out = {};
for (const p of pairs) {
  const [slug, question] = p.split('::');
  const res = { statusCode: 200, headers: {}, body: undefined, setHeader() { return res; }, getHeader() {}, status(c) { res.statusCode = c; return res; }, json(b) { res.body = b; return res; }, end() { return res; } };
  const req = { method: 'POST', headers: {}, query: {}, body: { question, today: '2026-10-22' }, [SCORECARD_CALL]: { auth: { tenantId: localOrgId(slug), orgId: localOrgId(slug), userId: 'u', orgRole: 'admin' }, escalate: false } };
  await ask(req, res);
  for (let i = 0; i < 200 && res.body === undefined; i++) await new Promise((r) => setTimeout(r, 25));
  if (res.body?.data) delete res.body.data.debug;
  out[`${slug}::${question}`] = res.body;
}
fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
process.stdout.write(Object.entries(out).map(([k, v]) => `${k} -> ${v?.data?.kind}: ${String(v?.data?.text).slice(0, 120)}`).join('\n') + '\n');
process.exit(0);
