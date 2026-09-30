/**
 * R31 (Team B) Loop 3: new-capability checks — no network, no model, PGlite for the DB part.
 *   3a passage highlight   src/core/passage.ts (pure)             [UI: scripts/verify-answer-ui.mjs, preview + docsheet views]
 *   3b superseded flag     api/_lib/supersession.js (+ ask.js)    [UI: verify-answer-ui.mjs, "replaced on <date>" note]
 *   3c role-aware answers  src/core/role.ts (pure)
 *   3d why / confidence    src/core/answerLayout.ts whyThisAnswer  [UI: verify-answer-ui.mjs, toggle >=44px, no shift]
 *
 *   npx tsx scripts/verify-r31-capabilities.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0, passes = 0;
const check = (name, ok, detail = "") => { if (ok) passes++; else failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`); };
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const realLog = console.log; console.log = (...a) => { if (typeof a[0] === "string" && a[0].startsWith('{"route"')) return; realLog(...a); };

/* ---------------------------------------------------------------- 3a passage.ts */
const P = await import("../src/core/passage.ts");
{
  const text = "Invoice 48219\nCustomer: Dana   Reyes\nTotal due: $620.00\nBalance due: $420.00";
  const s = P.findPassage(text, "customer: dana reyes");
  check("passage: whitespace/case-insensitive exact match, span in the ORIGINAL text", s && text.slice(s.start, s.end) === "Customer: Dana   Reyes", JSON.stringify(s));
  const s2 = P.findPassage(text, "“Total due: $620.00”");
  check("passage: curly-quote/ellipsis-wrapped needle is trimmed then matched", P.findPassage(text, "…Total due: $620.00…") && text.slice(P.findPassage(text, "…Total due: $620.00…").start).startsWith("Total due: $620.00") && s2 === null);
  const s3 = P.findPassage(text, "Balance due: $420.00 and paid in full on receipt");
  check("passage: a quote the model over-extended still lands on its leading run", s3 && text.slice(s3.start, s3.end) === "Balance due: $420.00", JSON.stringify(s3));
  eq("passage: nothing credible matches -> null (no highlight, never a wrong one)", P.findPassage(text, "completely unrelated words here"), null);
  eq("passage: tiny needle is ignored", P.findPassage(text, "ab"), null);
  eq("passage: empty text / needle are safe", [P.findPassage("", "abc def"), P.findPassage(text, null), P.findPassage(text, undefined)], [null, null, null]);
  const seg = P.splitByPassage(text, "Total due: $620.00");
  check("passage: splitByPassage round-trips the text and marks exactly one segment", seg.map((x) => x.text).join("") === text && seg.filter((x) => x.hit).length === 1 && seg.find((x) => x.hit).text === "Total due: $620.00");
  eq("passage: no match -> one unmarked segment", P.splitByPassage(text, "zzzz qqqq"), [{ text, hit: false }]);
  eq("passage: withPdfPage adds #page=N", P.withPdfPage("https://r2/x.pdf?sig=1", 3), "https://r2/x.pdf?sig=1#page=3");
  eq("passage: withPdfPage leaves bad pages and existing fragments alone", [P.withPdfPage("u", 0), P.withPdfPage("u", undefined), P.withPdfPage("u#a", 2), P.withPdfPage("u", NaN)], ["u", "u", "u#a", "u"]);
  eq("passage: flag defaults on", P.passageHighlightOn(), true);
}
{
  const dp = read("src/components/DocumentPreview.tsx"), ds = read("src/mobile/DocSheet.tsx"), ma = read("src/mobile/MobileApp.tsx"), mm = read("src/mobile/MobileAnswer.tsx"), ac = read("src/components/AnswerCard.tsx"), as = read("src/screens/AskScreen.tsx"), cp = read("src/components/answer/CitationPopover.tsx");
  check("wiring 3a: popover passes the server quote up; AnswerCard turns it into SourceRef.excerpt; AskScreen hands it to the viewer", /citation\.quote\)/.test(cp) && /excerpt: quote/.test(ac) && /excerpt=\{preview\.excerpt\}/.test(as));
  check("wiring 3a: desktop viewer marks + scrolls + opens PDFs at the cited page", /findPassage/.test(dp) && /scrollIntoView/.test(dp) && /withPdfPage\(original\.url, location\?\.page\)/.test(dp));
  check("wiring 3a: phone: page+quote travel MobileAnswer -> MobileApp -> DocSheet, original opens at #page", /onOpenDoc\(documentId, page, quote\)/.test(mm) && /page: number \| undefined|page\?: number, quote\?: string\) => setSheet/.test(ma) && /quote=\{sheet\.quote\}/.test(ma) && /withPdfPage\(original\.url, page\)/.test(ds));
}

/* ---------------------------------------------------------------- 3d why / superseded (pure) + 3c role */
const L = await import("../src/core/answerLayout.ts");
const R = await import("../src/core/role.ts");
const base = { kind: "answer", text: "x", facts: [], sources: [{ documentId: "d1", location: {} }], confidence: 0.9, verifiedCount: 1, unverifiedCount: 1, closest: [], basis: "Read from the invoice.", interpretation: "Balance for Reyes" };
{
  const w = L.whyThisAnswer(base);
  check("why: high band, with interpretation, basis and verified counts", w.level === "high" && w.lines.length === 3 && /1 verified, 1 not yet verified/.test(w.lines[2]), JSON.stringify(w));
  eq("why: a no-answer has nothing to justify", L.whyThisAnswer({ ...base, kind: "no-answer" }), null);
  eq("why: bands by confidence", [0.9, 0.7, 0.3].map((c) => L.whyThisAnswer({ ...base, confidence: c }).level), ["high", "medium", "low"]);
  const cc = L.whyThisAnswer({ ...base, claimCheck: { policy: "agent", checked: 4, supported: 3, unsupported: [{}], rate: 0.75 } });
  check("why: an unsupported claim caps a high answer at medium and says so", cc.level === "medium" && cc.lines.some((l) => /3 of 4 checked/.test(l)));
  const all = L.whyThisAnswer({ ...base, claimCheck: { policy: "deterministic", checked: 2, supported: 2, unsupported: [], rate: 1 } });
  check("why: all claims supported stays high", all.level === "high" && all.lines.some((l) => /Every checked statement \(2\)/.test(l)));
  check("why: never invents a line the answer does not carry", L.whyThisAnswer({ ...base, interpretation: undefined, basis: undefined, sources: [] }).lines.length === 0);
  const sup = { ...base, supersession: [{ documentId: "d1", replacedOn: "2026-09-03", replacedById: "d2" }] };
  check("superseded: read defensively; a replaced source caps confidence and adds a line", L.supersededOf(sup).length === 1 && L.whyThisAnswer(sup).level === "medium" && L.whyThisAnswer(sup).lines.some((l) => /replaced on Sep 3, 2026/.test(l)));
  eq("superseded: junk is ignored", [L.supersededOf({}), L.supersededOf({ supersession: "x" }), L.supersededOf({ supersession: [{ documentId: "a", replacedOn: "not-a-date", replacedById: "b" }] })], [[], [], []]);
  eq("superseded: date label is timezone-proof", [L.replacedOnLabel("2026-01-01"), L.replacedOnLabel("2026-12-31")], ["Jan 1, 2026", "Dec 31, 2026"]);
}
{
  const f = (label) => ({ label, value: "v", sources: [] });
  const facts = [f("Balance due"), f("Model"), f("Weather"), f("Serial number"), f("Invoice total")];
  eq("role: tech puts unit facts first, money last, the rest in between", R.orderFactsForRole(facts, "tech").map((x) => x.label), ["Model", "Serial number", "Weather", "Balance due", "Invoice total"]);
  eq("role: office puts money first, unit facts last", R.orderFactsForRole(facts, "office").map((x) => x.label), ["Balance due", "Invoice total", "Weather", "Model", "Serial number"]);
  check("role: no role, or nothing matching, returns the SAME array (no reorder, nothing dropped)", R.orderFactsForRole(facts, null) === facts && R.orderFactsForRole([f("Weather"), f("Mood")], "tech").length === 2);
  check("role: reordering never drops or rewrites a fact", R.orderFactsForRole(facts, "tech").length === facts.length && [...R.orderFactsForRole(facts, "tech")].every((x) => facts.includes(x)));
  eq("role: ?role= wins, then stored, phone defaults to tech, desktop stays neutral", [R.resolveRole({ search: "?role=office", stored: "tech", mobile: true }), R.resolveRole({ stored: "office", mobile: true }), R.resolveRole({ mobile: true }), R.resolveRole({ mobile: false }), R.resolveRole({ stored: "junk" })], ["office", "office", "tech", null, null]);
  const ans = { ...base, facts, kind: "answer" };
  const ap = R.applyRole(ans, "tech");
  check("role: applyRole returns a new answer with the reordered facts and leaves the input untouched", ap !== ans && ap.facts[0].label === "Model" && ans.facts[0].label === "Balance due" && R.applyRole(ans, null) === ans);
  eq("role: tech gets unit-first chips on a status answer; no role = generic", [R.roleChips("status", "tech", ["a", "b", "c"]).slice(0, 1), R.roleChips("status", null, ["a", "b", "c"])], [["Model and serial?"], ["a", "b", "c"]]);
}

/* ---------------------------------------------------------------- 3b supersession on a real (PGlite) tenant */
let offline;
try { offline = await import("./offline-exam.mjs"); } catch (err) { realLog(`SKIP  offline-exam.mjs failed to load (${err?.message}). Run npm ci.`); process.exit(failures ? 1 : 0); }
const { installPgHarness, createPGlite, setActiveDatabase, loadExportIntoNewTenant } = offline;
await installPgHarness();
const lite = await createPGlite();
await setActiveDatabase(lite);
const exp = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts", "golden", "golden-export.json"), "utf8"));
const { ctx } = await loadExportIntoNewTenant(lite, exp, { tenantKey: "r31-sup", tenantName: "R31 Sup" });
const { withTenant } = await import("../api/_lib/recordsStore.js");
const S = await import("../api/_lib/supersession.js");
const tenantId = (await lite.query("SELECT id FROM tenants WHERE id = (SELECT tenant_id FROM documents LIMIT 1)")).rows[0].id;
const H = (n) => `r31sup${String(n).padStart(58, "0")}`; // unique sha per doc
let hn = 0;
async function addDoc(type, fileName, createdAt, fields) {
  const { rows } = await lite.query(`INSERT INTO documents (tenant_id, original_filename, document_type, sha256_hash, stage, created_at) VALUES ($1,$2,$3,$4,'verified',$5) RETURNING id`, [tenantId, fileName, type, H(++hn), createdAt]);
  for (const [k, v] of Object.entries(fields)) await lite.query(`INSERT INTO extractions (tenant_id, document_id, field_key, value) VALUES ($1,$2,$3,$4)`, [tenantId, rows[0].id, k, v]);
  return rows[0].id;
}
const before = await withTenant(ctx, (db) => S.loadSupersessionMap(db));
const oldInv = await addDoc("invoice", "inv-old.pdf", "2026-06-01T12:00:00Z", { invoice_number: "R31-7001" });
const newInv = await addDoc("invoice", "inv-new.pdf", "2026-09-03T15:00:00Z", { invoice_number: "r31 7001" }); // same number, different punctuation/case
const midInv = await addDoc("invoice", "inv-mid.pdf", "2026-07-10T15:00:00Z", { invoice_number: "R31-7001" });
const lone = await addDoc("invoice", "inv-lone.pdf", "2026-06-01T12:00:00Z", { invoice_number: "R31-9999" });
const otherType = await addDoc("permit", "permit.pdf", "2026-09-05T12:00:00Z", { permit_number: "R31-7001" }); // same number, other type: unrelated
const shortRef = await addDoc("invoice", "short-a.pdf", "2026-06-01T12:00:00Z", { invoice_number: "7" });
const shortRef2 = await addDoc("invoice", "short-b.pdf", "2026-09-01T12:00:00Z", { invoice_number: "7" });
const sameInstant = await addDoc("permit", "p1.pdf", "2026-06-01T12:00:00Z", { permit_number: "PRM-5555" });
const sameInstant2 = await addDoc("permit", "p2.pdf", "2026-06-01T12:00:00Z", { permit_number: "PRM-5555" });
const map = await withTenant(ctx, (db) => S.loadSupersessionMap(db));
check("supersession: the query runs on Postgres (PGlite) and the golden tenant starts with no replaced documents it did not earn", before instanceof Map, String(before));
check("supersession: the older of two same-number invoices is replaced by the NEWEST, on that upload's day", map.get(oldInv)?.replacedById === newInv && map.get(oldInv)?.replacedOn === "2026-09-03" && map.get(oldInv)?.replacedByName === "inv-new.pdf", JSON.stringify(map.get(oldInv)));
check("supersession: a middle copy is replaced by the newest too; the newest and a lone invoice are not", map.get(midInv)?.replacedById === newInv && !map.has(newInv) && !map.has(lone));
check("supersession: the same number under a different document type is unrelated", !map.has(otherType));
check("supersession: a reference under 3 characters is never trusted", !map.has(shortRef) && !map.has(shortRef2));
check("supersession: identical upload instants are ambiguous -> no claim", !map.has(sameInstant) && !map.has(sameInstant2));
{
  const memoCtxCalls = [];
  const spyTenant = (c, fn) => { memoCtxCalls.push(1); return withTenant(c, fn); };
  S._resetSupersessionMemo();
  const a = await S.getSupersessionMap({ withTenant: spyTenant, ctxArg: ctx, tenantKey: "t1" });
  const b = await S.getSupersessionMap({ withTenant: spyTenant, ctxArg: ctx, tenantKey: "t1" });
  check("supersession: memoized per tenant (one query for two asks)", memoCtxCalls.length === 1 && a === b);
  const off = await S.getSupersessionMap({ withTenant: spyTenant, ctxArg: ctx, tenantKey: "t2", env: { DONOVAN_SUPERSEDED: "0" } });
  check("supersession: DONOVAN_SUPERSEDED=0 = off (empty map, no query)", off.size === 0 && memoCtxCalls.length === 1);
  const boom = await S.getSupersessionMap({ withTenant: () => { throw new Error("db down"); }, ctxArg: ctx, tenantKey: "t3" });
  check("supersession: a failing query never breaks an ask (empty map)", boom instanceof Map && boom.size === 0);
}
{
  const data = { kind: "answer", sources: [{ documentId: newInv, location: {} }, { documentId: oldInv, location: {} }, { documentId: lone, location: {} }], records: [] };
  const entries = S.annotateSuperseded(data, map);
  check("annotate: names the replaced source and where the newer copy is", entries.length === 1 && data.supersession[0].documentId === oldInv && data.supersession[0].replacedById === newInv && data.supersession[0].newerAlsoCited === true);
  check("annotate: when both copies are cited the newer leads; nothing is removed", data.sources[0].documentId === newInv && data.sources.length === 3);
  const d2 = { kind: "answer", sources: [{ documentId: oldInv, location: {} }] };
  S.annotateSuperseded(d2, map);
  check("annotate: only the old copy cited -> flagged, sources untouched", d2.supersession?.[0].newerAlsoCited === false && d2.sources.length === 1);
  const d3 = { kind: "answer", sources: [{ documentId: lone, location: {} }] };
  S.annotateSuperseded(d3, map);
  check("annotate: an answer citing nothing replaced is left byte-identical", d3.supersession === undefined && JSON.stringify(d3) === JSON.stringify({ kind: "answer", sources: [{ documentId: lone, location: {} }] }));
  const d4 = { kind: "no-answer", sources: [{ documentId: oldInv }] };
  check("annotate: no-answer / empty map are no-ops", S.annotateSuperseded(d4, map).length === 0 && S.annotateSuperseded({ kind: "answer", sources: [{ documentId: oldInv }] }, new Map()).length === 0);
}
{
  const ask = read("api/ask.js");
  check("wiring 3b: ask.js loads the map after auth and annotates inside send() before finalizeCitations", /getSupersessionMap\(\{ withTenant, ctxArg, tenantKey: auth\.tenantId \}\)/.test(ask) && ask.indexOf("annotateSuperseded(body.data") > 0 && ask.indexOf("annotateSuperseded(body.data") < ask.indexOf("finalizeCitations(body.data)"));
  check("api/ still has exactly 12 top-level files", fs.readdirSync(path.join(ROOT, "api")).filter((f) => fs.statSync(path.join(ROOT, "api", f)).isFile()).length === 12);
}

console.log(failures ? `\n${failures} FAILED, ${passes} passed` : `\nall ${passes} passed`);
process.exit(failures ? 1 : 0);
