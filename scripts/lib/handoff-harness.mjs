// Handoff QA harness: runs the REAL /api/ask handler (api/ask.js) in-process on synthetic tenants (PGlite), with the Claude path replaced by a counting mock.
// Records, per question, which path produced the final answer: rules | reader | v2 | escalated | declined (+ the lane detail and the V2 log line).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function boot({ v2 = true, release = true, extraEnv = {} } = {}) {
  process.env.DEEPWELL_TELEMETRY_OFF = "1";
  process.env.DONOVAN_READER_V2 = v2 ? "1" : "0";
  for (const [k, v] of Object.entries(extraEnv)) process.env[k] = v;
  const off = await import("../offline-exam.mjs");
  await off.installPgHarness();
  const blocked = await off.installModelBlock(); // counts + throws; replaced just below by the mock
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const proto = Object.getPrototypeOf(new Anthropic({ apiKey: "x" }).messages);
  const mock = { calls: 0, kinds: [], mode: "answer", keep: false, prompts: [] };
  proto.create = async function claudeMock(req) {
    mock.calls++;
    const text = JSON.stringify(req.messages ?? "").slice(0, 20000);
    mock.kinds.push(String(req.model ?? ""));
    if (mock.keep) mock.prompts.push(JSON.stringify([req.system ?? "", req.messages ?? ""]).toLowerCase());
    const m = /documentId: ([0-9a-f-]{36}) \| page: (\d+)/.exec(text.replace(/\\n/g, "\n")) ?? [];
    const facts = m[1] ? [{ label: "Mock", value: "mock", status: "info", sources: [{ documentId: m[1], location: { page: Number(m[2]) || 1 } }] }] : [];
    return { content: [{ type: "tool_use", id: "tu_" + mock.calls, name: "answer", input: { text: "MOCK-CLAUDE answer.", confidence: 0.9, status: "answered", facts } }], usage: { input_tokens: 10, output_tokens: 10 }, stop_reason: "tool_use" };
  };
  const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
  const { SCORECARD_CALL } = await import("../../api/_lib/scorecard/hook.js");
  const { createUsageMeter, runWithUsageMeter } = await import("../../api/_lib/usage.js");
  const { default: handler } = await import("../../api/ask.js");
  const realLog = console.log;
  let sink = null;
  console.log = (...a) => { if (typeof a[0] === "string" && (a[0].startsWith('{"route"') || a[0].startsWith('{"event"'))) { sink?.push(a[0]); return; } realLog(...a); };
  console.warn = () => {}; if (!process.env.HANDOFF_DEBUG) console.error = () => {};
  // same as scorecard/askCall.js, but waits for the response to be WRITTEN: ask.js can return before an async send (the V2 hook) has ended the response
  async function askInProcess(auth, question, today, rel) {
    const res = { statusCode: 200, headers: {}, headersSent: false, body: undefined, setHeader(k, v) { res.headers[String(k).toLowerCase()] = v; return res; }, getHeader(k) { return res.headers[String(k).toLowerCase()]; }, status(c) { res.statusCode = c; return res; }, json(b) { res.body = b; res.headersSent = true; return res; }, end() { res.headersSent = true; return res; } };
    const req = { method: "POST", headers: {}, query: {}, body: { question, today, debug: true }, [SCORECARD_CALL]: { auth, escalate: false, releaseEscalation: rel ?? release } };
    const meter = createUsageMeter(); let thrown = null;
    try { await runWithUsageMeter(meter, () => handler(req, res)); } catch (err) { thrown = String(err?.name ?? "error") + ":" + String(err?.message ?? "").slice(0, 80); }
    for (let i = 0; i < 400 && res.body === undefined; i++) await new Promise((r) => setTimeout(r, 25));
    const body = res.body ?? null; const data = body?.success ? body.data ?? null : null; const debug = data?.debug ?? null; if (data && "debug" in data) delete data.debug;
    return { status: res.statusCode, data, debug, error: thrown ?? (data ? null : String(body?.error ?? `http-${res.statusCode}`).slice(0, 160)), lateSend: false };
  }
  const tenants = new Map();
  async function addTenant(key, exportData) {
    const { ctx } = await off.loadExportIntoNewTenant(lite, exportData, { tenantKey: `offline:${key}`, tenantName: exportData.tenantName ?? key });
    tenants.set(key, { ctx, auth: { tenantId: ctx.tenantKey, orgId: ctx.tenantName, userId: null } });
    return ctx;
  }
  async function ask(key, question, today = "2026-10-07", opts = {}) {
    await off.setActiveDatabase(lite);
    const t = tenants.get(key);
    const lines = []; sink = lines; mock.calls = 0; blocked.n = 0;
    let r;
    try { r = await askInProcess(t.auth, question, today, opts.release); } finally { sink = null; }
    const logs = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const d = r.data;
    const v2 = logs.find((l) => l.readerV2)?.readerV2 ?? null;
    const lane = logs.find((l) => l.answer_lane) ?? {};
    const modelCalls = mock.calls;
    // the Claude path ran when the research agent / agent / retrieval+model logged, or the handoff did; the planner call alone does not count
    const claude = logs.some((l) => l.research_agent || l.agent === true || l.release || (l.model && l.stop_reason));
    let p;
    if (!d) p = "error";
    else if (claude) p = d.kind === "no-answer" ? "escalated-declined" : "escalated";
    else if (d.kind === "no-answer") p = "declined";
    else if (v2 && v2.mode === "on" && v2.v2?.answered && v2.cur?.kind === "no-answer") p = "v2";
    else p = "rules";
    return { path: p, claude, release: logs.find((l) => l.release)?.release ?? (logs.find((l) => l.clarify_deferred) ? { cause: `clarify:${logs.find((l) => l.clarify_deferred).clarify_deferred}`, outcome: "deferred" } : null), unfit: logs.some((l) => l.readerV2?.unfit), kind: d?.kind ?? null, text: String(d?.text ?? r.error ?? ""), modelCalls, v2, lane: lane.answer_lane ?? null, detail: lane.detail ?? null, dbg: d?.debug ?? null, data: d, err: r.error ?? null, logs };
  }
  return { ask, addTenant, mock, off, realLog, ROOT };
}
export function loadCompany(key) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, "scripts/fixtures/reader-v2/companies", `${key}.json.gz`))).toString("utf8"));
}
export function loadExpected() {
  return zlib.gunzipSync(fs.readFileSync(path.join(ROOT, "scripts/fixtures/reader-v2/expected.jsonl.gz"))).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
