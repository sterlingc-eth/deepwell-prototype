#!/usr/bin/env node
/** R38: two organizations in ONE database; the same questions must be answered only from the asking organization's own data (vocabulary, counts, citations). */
import fs from "node:fs";
const off = await import("./offline-exam.mjs");
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === "string" && (a[0].startsWith('{"route"') || a[0].startsWith('{"event"'))) return; realLog(...a); };
console.warn = () => {}; console.error = () => {};
await off.installPgHarness(); const modelCounter = await off.installModelBlock();
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const load = async (p, key) => { const d = JSON.parse(fs.readFileSync(p, "utf8")); return (await off.loadExportIntoNewTenant(lite, d, { tenantKey: `offline:${key}`, tenantName: key })).ctx; };
const hvac = await load("scripts/golden/golden-export.json", "iso-hvac");
const plumb = await load("test-docs/tenants/plumbing/export.json", "iso-plumb");
const mk = (id, text) => ({ id, text, category: "iso", cmp: "honest-zero", oracle: { sql: "SELECT 0 AS n", params: [] }, citationRequired: false });
const qs = [mk("a", "how many Navien units do we have"), mk("b", "how many customers do we have in Oro Valley"), mk("c", "how many Carrier units do we have"), mk("d", "how many invoices did Dana Whitfield do")];
const { validQuestions } = await import("../api/_lib/scorecard/exam.js");
const run = async (ctx) => (await off.runOfflineExam({ ctx, questions: validQuestions(qs), today: "2026-09-25", modelCounter })).perQuestion.map((r) => `${r.id}:${String(r.got).slice(0, 70)}`);
const h = await run(hvac), p = await run(plumb);
realLog("HVAC tenant   ->", h.join(" | "));
realLog("PLUMB tenant  ->", p.join(" | "));
const leak = h.some((x) => /Navien|Oro Valley|Whitfield/.test(x) && /\b([1-9]\d*) (of \d+ units|invoices list)/.test(x) && !/^a:.*\b0 of/.test(x));
realLog(leak ? "LEAK?" : "no cross-organization leak seen");
process.exit(leak ? 1 : 0);
