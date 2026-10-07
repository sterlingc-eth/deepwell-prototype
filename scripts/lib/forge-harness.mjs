// Shared offline /api/ask harness for the FORGE scripts (real handler, model blocked, own PGlite). Returns {ask, ctx(tenant)->..., modelCounter}.
export async function forgeHarness(orgs, { today = "2026-10-07" } = {}) {
  const off = await import("../offline-exam.mjs");
  const realLog = console.log;
  console.log = (...a) => { if (typeof a[0] === "string" && /^\{"(route|event|timestamp|level)"/.test(a[0])) return; realLog(...a); };
  console.warn = () => {}; console.error = () => {};
  await off.installPgHarness(); const modelCounter = await off.installModelBlock();
  const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
  const { askViaHandler } = await import("../../api/_lib/scorecard/askCall.js");
  const { default: askHandler } = await import("../../api/ask.js");
  const ctxs = {};
  for (const [name, data] of Object.entries(orgs)) ctxs[name] = (await off.loadExportIntoNewTenant(lite, data, { tenantKey: `forge:${name}`, tenantName: `forge-${name}` })).ctx;
  const latencies = [];
  async function ask(org, question, extra = {}) {
    const c = ctxs[org]; modelCounter.n = 0;
    const r = await askViaHandler({ handler: askHandler, auth: { tenantId: c.tenantKey, orgId: c.tenantName, userId: null }, question, today, ...extra });
    latencies.push(r.latencyMs); return { ...r, models: modelCounter.n };
  }
  const pct = (p) => { const s = [...latencies].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
  return { ask, ctxs, modelCounter, realLog, latency: () => ({ p50: pct(0.5), p95: pct(0.95), n: latencies.length }) };
}
export const ansText = (d) => [d?.text, ...(d?.facts ?? []).map((f) => `${f.label ?? ""} ${f.value ?? ""}`)].join(" \n ");
