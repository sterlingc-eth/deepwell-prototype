// Round 24 offline simulation of "learn from every handoff" for ONE factory company. No model calls.
//   node scripts/handoff-sim-r24.mjs <company> <tenantsDir: tenants|tenants4|tenants5> [--ntrain 400] [--ndev 150] [--n6 100] [--out file.json]
// Phases: BASE (flag off): dev / bank-6 dev / train stream through the real ask.js handler -> the handed-off train questions become "Claude answered from the records" using the factory
// oracle's gold answer and plan as Claude's grounded answer -> the learning job -> AFTER (flag on): the same dev and bank-6 dev questions again. Never reads test splits.
import fs from "node:fs"; import path from "node:path";
import { FACT, readBank, sampleN } from "./handoff-sim-lib.mjs";
const D = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const args = process.argv.slice(2); const company = args[0]; const tdir = args[1];
const opt = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };
const NTRAIN = +opt("ntrain", 400), NDEV = +opt("ndev", 150), N6 = +opt("n6", 100), OUT = opt("out", `/tmp/claude-0/sim-${company}.json`);
const bankNo = tdir === "tenants5" ? 5 : tdir === "tenants4" ? 4 : 1;
const Q = FACT + "/questions";
const dirs = bankNo === 5 ? { train: Q + "/out5/train5", dev: Q + "/out5/dev5" } : bankNo === 4 ? { train: Q + "/out4/train4", dev: Q + "/out4/dev4" } : { train: Q + "/out", dev: Q + "/out" };
delete process.env.ANTHROPIC_API_KEY; process.env.DONOVAN_HANDOFF_LEARNING = "";
const realLog = console.log; console.log = (...a) => { if (typeof a[0] === "string" && a[0].startsWith('{"')) return; realLog(...a); }; console.warn = () => {}; console.error = () => {};
const off = await import(D + "/scripts/offline-exam.mjs");
await off.installPgHarness(); const counter = await off.installModelBlock();
const { default: Anthropic } = await import(D + "/node_modules/@anthropic-ai/sdk/index.mjs").catch(() => import("@anthropic-ai/sdk"));
const proto = Object.getPrototypeOf(new Anthropic({ apiKey: "x" }).messages); const blocked = proto.create; var calls = 0;
proto.create = async function (p, ...r) { calls++; return blocked.call(this, p, ...r); };
const { SCORECARD_CALL } = await import(D + "/api/_lib/scorecard/hook.js");
const { createUsageMeter, runWithUsageMeter } = await import(D + "/api/_lib/usage.js");
const { default: askHandler, _resetTenantVocabFresh } = await import(D + "/api/ask.js");
const { resetTenantVocabCacheForTests } = await import(D + "/api/_lib/vocab/tenantVocab.js");
const { withTenant } = await import(D + "/api/_lib/recordsStore.js");
const { packForTenant } = await import(D + "/api/_lib/industry/index.js");
const HL = await import(D + "/api/_lib/handoffLearning/index.js");
const { listLearnings } = await import(D + "/api/_lib/handoffLearning/store.js");
const { checkRecord5, buildLexicon } = await import(Q + "/check5.mjs");
const { factoryOp } = await import(D + "/api/_lib/dql/learned/planmap.js");
function makeRes() { const res = { statusCode: 200, headers: {}, headersSent: false, body: undefined, setHeader(k, v) { res.headers[String(k).toLowerCase()] = v; return res; }, getHeader(k) { return res.headers[String(k).toLowerCase()]; }, status(c) { res.statusCode = c; return res; }, json(b) { res.body = b; res.headersSent = true; return res; }, end() { res.headersSent = true; return res; } }; return res; }
const data = JSON.parse(fs.readFileSync(`${FACT}/${tdir}/${company}.json`, "utf8"));
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const loaded = await off.loadExportIntoNewTenant(lite, data, { tenantKey: "offline:" + (data.tenantKey || company), tenantName: data.tenantName || company }); const ctx = loaded.ctx;
const ind = bankNo >= 4 ? "other" : (data.industry ?? company);
await lite.query("UPDATE tenants SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{industry}', to_jsonb($1::text)) WHERE id = $2", [ind, loaded.tenantId]);
const auth = { tenantId: ctx.tenantKey, orgId: "factory", userId: null };
const lex = buildLexicon(data);
async function ask(question) {
  calls = 0; counter.n = 0;
  const req = { method: "POST", headers: {}, query: {}, body: { question, today: "2026-10-07", debug: true }, [SCORECARD_CALL]: { auth, escalate: false } };
  const res = makeRes(); const meter = createUsageMeter();
  try { await runWithUsageMeter(meter, () => askHandler(req, res)); } catch (e) {}
  const body = res.body ?? null; const d = body?.success ? body.data ?? null : null; if (d) delete d.debug;
  return { q: question, model: calls > 0 || counter.n > 0, kind: d?.kind, text: String(d?.text ?? "").replace(/\s+/g, " ").slice(0, 1800), recs: (d?.records || []).length, srcs: (d?.records || []).slice(0, 80).map((r) => ({ id: r.id, documentId: r.documentId ?? r.document_id, type: r.type, label: r.label, sub: r.sublabel, number: r.number })), cites: JSON.stringify(d?.citations ?? d?.sources ?? d?.provenance ?? null).slice(0, 1500) };
}
const GROUND = new Set(["number", "list", "yesno", "date", "name"]);
const single = (r) => !r.prior && GROUND.has(r.expect?.kind);
const devAll = readBank(dirs.dev, company, "dev", { filter: single });
const b6All = readBank(Q + "/out6/dev6", company, "dev", { filter: (r) => single(r) && !(r.style ?? []).includes("misspell") });
const trainAll = readBank(dirs.train, company, "train", { filter: single });
const dev = sampleN(devAll, NDEV, 11), b6 = sampleN(b6All, N6, 13), trainS = sampleN(trainAll, NTRAIN, 17);
const score = async (recs, label) => {
  const rows = []; const t0 = Date.now();
  for (const rec of recs) { const a = await ask(rec.q); const v = checkRecord5(rec, a, lex); rows.push({ id: rec.id, q: rec.q, v: v.v, why: v.why, model: a.model, text: a.text.slice(0, 160) }); }
  process.stderr.write(`${company} ${label}: ${recs.length} asked in ${Math.round((Date.now() - t0) / 1000)}s\n`); return rows;
};
const summ = (rows) => { const n = rows.length, alone = rows.filter((r) => !r.model).length, right = rows.filter((r) => r.v === "right").length, wrong = rows.filter((r) => r.v === "wrong").length; return { n, alone, aloneShare: +(alone / n).toFixed(3), right, wrong, accuracyOfAlone: alone ? +(right / alone).toFixed(3) : null }; };
const result = { company, bank: bankNo, ntrain: trainS.length };
// ---- BASE
const baseDev = await score(dev, "base dev"), baseB6 = await score(b6, "base bank6-dev"), baseTrain = await score(trainS, "base train");
result.before = { dev: summ(baseDev), bank6dev: summ(baseB6) };
// ---- handoffs: the train questions that went to the model
const pack = await packForTenant({ withTenant, ctxArg: ctx });
const handed = trainS.filter((rec, i) => baseTrain[i].model);
result.handoffs = handed.length;
process.env.DONOVAN_HANDOFF_LEARNING = "1";
const recByQ = new Map(); let recorded = 0;
const tv = (await import(D + "/api/_lib/vocab/tenantVocab.js")).buildTenantVocab;
await withTenant(ctx, async (db) => {
  const vocab = await tv(db, pack);
  for (const rec of handed) {
    recByQ.set(rec.q, rec);
    const reading = { op: factoryOp(rec), entity: rec.plan?.entity ?? null, docType: rec.plan?.doc_type ?? null, groupBy: rec.plan?.group_by ?? [] };
    const r = await HL.recordHandoff(db, { question: rec.q, vocab, answer: { text: String(JSON.stringify(rec.expect.value)), citedRecords: [{ id: "gold-" + rec.id }] }, reading });
    if (r.ok) recorded++;
  }
});
result.recorded = recorded;
// ---- the job
const agree = (ans, h) => { const rec = recByQ.get(h.question); if (!rec) return false; const recs = (ans.records ?? []).map((r) => ({ id: r.id, documentId: r.documentId, type: r.type, label: r.label, sub: r.sublabel })); const v = checkRecord5(rec, { text: ans.text, kind: ans.kind, recs: recs.length, srcs: recs, cites: "", model: false }, lex); return v.v === "right"; };
const regression = trainAll.map((r) => r.q);
let rep; const trace = [];
const tj = Date.now();
await withTenant(ctx, async (db) => {
  const engine = await HL.makeEngine(db, { pack, today: "2026-10-07" });
  rep = await HL.runHandoffLearningJob(db, { engine, agree, regression, trace });
});
result.trace = trace; result.job = { seconds: Math.round((Date.now() - tj) / 1000), ...rep, adopted: rep.adopted.length, adoptedList: rep.adopted.map((a) => ({ kind: a.kind, phrase: a.phrase, to: a.canonical, support: a.support })), rejected: rep.rejected.length, rejectedList: rep.rejected.slice(0, 40) };
let learned = []; await withTenant(ctx, async (db) => { learned = await listLearnings(db, {}); }); result.learnedRows = learned.map((l) => ({ kind: l.kind, phrase: l.phrase, canonical: l.canonical, targetKind: l.target_kind, status: l.status, support: l.support }));
// ---- AFTER
resetTenantVocabCacheForTests(); _resetTenantVocabFresh();
const aftDev = await score(dev, "after dev"), aftB6 = await score(b6, "after bank6-dev");
result.after = { dev: summ(aftDev), bank6dev: summ(aftB6) };
// per-question changes
const chg = (b, a) => b.map((x, i) => ({ q: x.q, before: x.v, after: a[i].v, bm: x.model, am: a[i].model, text: a[i].text })).filter((x) => x.before !== x.after || x.bm !== x.am);
result.changes = { dev: chg(baseDev, aftDev), bank6dev: chg(baseB6, aftB6) };
result.unseenOverlap = 0;
fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
realLog(JSON.stringify({ company, before: result.before, after: result.after, handoffs: result.handoffs, recorded, job: { adopted: result.job.adopted, rejected: result.job.rejected, found: rep.found, already: rep.already, noLead: rep.noLead, none: rep.none, mismatch: rep.mismatch, seconds: result.job.seconds } }));
process.exit(0);
