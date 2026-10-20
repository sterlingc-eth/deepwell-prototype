#!/usr/bin/env node
/**
 * verify:entity-safety - customers with similar names or addresses must always be told apart (owner rule: NO room for error).
 *
 * Runs the REAL /api/ask handler (in-process, PGlite, Claude path = counting mock) on synthetic tenants seeded with near-duplicate customers
 * (scripts/lib/entity-safety-fixture.mjs): "John Smith" / "John Smith Jr." / "John Smith Sr." / "John A. Smith" / "Jon Smith", identical names at
 * different addresses, one street address with several units, one street in several cities, business punctuation variants, typo'd names.
 * Every customer owns values no other customer has (phone, email, invoice number + total, full address), so every answer can be attributed.
 *
 * REQUIRES (any failure exits 1):
 *   (a) ZERO wrong-entity answers: an answer never carries another customer's value; it carries the target's value or nothing
 *   (b) an ambiguous question gets "which one?" naming the candidates with distinguishing details (address / phone / last job date), or a Claude handoff;
 *       never a guess and never a decline ("not on file")
 *   (c) no auto-merge: the pure merge rules never put two distinct customers in an automatic tier, and the only merge entry points are human-confirmed
 *   (d) a typo match is allowed only when exactly ONE candidate exists AND the runner-up is far; otherwise ask or hand off
 *   (e) cross-tenant isolation: no answer carries a value from another tenant (tenants share customer names on purpose)
 *   node scripts/verify-entity-safety.mjs            full set (800+ questions)
 *   node scripts/verify-entity-safety.mjs --quick    a third of it
 *   --json out.json writes every verdict (for the report)
 * No network, no key, no real model call. Synthetic data only.
 */
import fs from "node:fs";
import { boot } from "./lib/handoff-harness.mjs";
import { buildEntityTenant } from "./lib/entity-safety-fixture.mjs";
import { mulberry } from "./lib/handoff-rng.mjs";

const QUICK = process.argv.includes("--quick");
const JSON_OUT = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : null;
const MIN_QUESTIONS = QUICK ? 250 : 800;

/* ------------------------------------------------------------------ text helpers */
const loose = (s) => String(s).toLowerCase().replace(/\./g, "").replace(/[^a-z0-9]+/g, " ").trim();
const damerau = (a, b) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
};
const COMPANY = new Set(["llc", "inc", "co", "corp", "company", "ltd"]);
const coreTokens = (s) => loose(s).split(" ").filter((t) => t && !COMPANY.has(t) && !(t.length === 1));   // middle initials and company suffixes do not make a different "near" name; Jr / Sr do
const sameCore = (a, b) => { const x = coreTokens(a).sort().join(" "), y = coreTokens(b).sort().join(" "); return x === y; };
const ABBR = [[/\bstreet\b/g, "st"], [/\bavenue\b/g, "ave"], [/\blane\b/g, "ln"], [/\bdrive\b/g, "dr"], [/\bcourt\b/g, "ct"], [/\broad\b/g, "rd"], [/\bboulevard\b/g, "blvd"], [/\bapartment\b/g, "apt"], [/\bsuite\b/g, "ste"]];
const streetNorm = (s) => ABBR.reduce((x, [re, to]) => x.replace(re, to), loose(s).replace(/#\s*/g, "apt "));

/* ------------------------------------------------------------------ attribution: which customers' values does a response carry */
function makeAttributor(allCustomers) {
  const digitsOf = (s) => String(s).replace(/\D/g, "");
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (text, tenantKey) => {
    const raw = String(text);
    const low = raw.toLowerCase().replace(/(\d),(\d)/g, "$1$2");
    const dg = digitsOf(raw);
    const hit = new Set(); const kinds = new Map();
    const add = (c, k) => { hit.add(c.key); if (!kinds.has(c.key)) kinds.set(c.key, new Set()); kinds.get(c.key).add(k); };
    for (const c of allCustomers) {
      if (dg.includes(`480555${c.last4}`)) add(c, "phone");
      if (low.includes(c.email.toLowerCase())) add(c, "email");
      for (const inv of c.invoices) { if (low.includes(inv.no.toLowerCase())) add(c, "invoice"); if (low.includes(`$${inv.total}`) || new RegExp(`(^|[^0-9.])${inv.total.replace(".", "\\.")}`).test(low)) add(c, "total"); }
      const a = `${c.street}, ${c.city}`.toLowerCase();
      const i = low.indexOf(a); if (i >= 0 && !/[0-9a-z]/.test(low[i + a.length] ?? " ")) add(c, "address");
    }
    // names (only this tenant's customers). Longest names are consumed first, so "John Smith" inside "John Smith Sr." or "ABC Plumbing" inside
    // "ABC Plumbing & Heating" is not counted. A name two customers share points at both - unless a value already told which one.
    const nameIds = new Set();
    if (tenantKey) {
      let rest = " " + raw.toLowerCase().replace(/\s+/g, " ") + " ";
      const mine = allCustomers.filter((c) => c.tenant === tenantKey).sort((x, y) => y.name.length - x.name.length);
      const seen = new Set();
      for (const c of mine) {
        const nm = c.name.toLowerCase();
        if (seen.has(nm)) continue; seen.add(nm);
        const re = new RegExp(`(^|[^a-z0-9])${esc(nm)}(?![a-z0-9])`, "g");
        if (re.test(rest)) {
          rest = rest.replace(new RegExp(`(^|[^a-z0-9])${esc(nm)}(?![a-z0-9])`, "g"), " ");
          const same = mine.filter((o) => o.name.toLowerCase() === nm);
          const told = same.filter((o) => hit.has(o.key));
          for (const o of (told.length ? told : same)) nameIds.add(o.key);
        }
      }
    }
    return { ids: hit, kinds, nameIds };
  };
}

/* ------------------------------------------------------------------ question generation */
const ftpl = {
  phone: [(n) => `phone number for ${n}`, (n) => `what's ${n}'s phone`, (n) => `${n} phone?`, (n) => `call ${n} - what number`],
  email: [(n) => `email address for ${n}`, (n) => `${n} email`],
  address: [(n) => `service address for ${n}`, (n) => `where does ${n} live`, (n) => `address for ${n}`],
  invoice: [(n) => `latest invoice for ${n}`, (n) => `last invoice total for ${n}`, (n) => `how much was ${n}'s last invoice`],
};
const CHAT = ["", "", "", "quick one: ", "hey, ", "pls ", "client is waiting, ", "Hi Donovan, "];
const TAIL = ["", "", "", " please", " asap", "?", " thanks"];
const typoOf = (name, r) => {
  const words = name.split(" ");
  for (let tries = 0; tries < 12; tries++) {
    const i = Math.floor(r() * words.length); const w = words[i];
    if (w.replace(/[^a-z]/gi, "").length < 5) continue;
    const k = 1 + Math.floor(r() * (w.length - 3)); const mode = Math.floor(r() * 3);
    let nw = w;
    if (mode === 0) nw = w.slice(0, k) + w[k + 1] + w[k] + w.slice(k + 2);
    else if (mode === 1) nw = w.slice(0, k) + w.slice(k + 1);
    else nw = w.slice(0, k) + (w[k] === "e" ? "a" : "e") + w.slice(k + 1);
    if (nw !== w) { const out = [...words]; out[i] = nw; return out.join(" "); }
  }
  return null;
};
const respell = (s) => ABBR.reduce((x, [re, to]) => x, s)
  .replace(/\bSt\b/, "Street").replace(/\bAve\b/, "Avenue").replace(/\bLn\b/, "Lane").replace(/\bDr\b/, "Drive").replace(/\bCt\b/, "Court").replace(/\bRd\b/, "Road").replace(/\bBlvd\b/, "Boulevard");

function generate(tenantKey, cust, seed, share) {
  const r = mulberry(seed); const pick = (a) => a[Math.floor(r() * a.length)];
  const out = []; const wrap = (q) => { let s = pick(CHAT) + q + pick(TAIL); if (r() < 0.2) s = s.toLowerCase(); return s.trim(); };
  const add = (cat, q, gold) => out.push({ tenant: tenantKey, cat, q: wrap(q), gold });
  const names = cust.map((c) => c.name);
  const verbatimCount = (nm) => cust.filter((c) => c.name.toLowerCase() === nm.toLowerCase().trim()).length;
  const nearSet = (nm) => cust.filter((c) => sameCore(c.name, nm) && (c.name.toLowerCase().includes(" jr") === /\bjr\b/i.test(nm)) && (/\bsr\b/i.test(c.name) === /\bsr\b/i.test(nm)));
  /* name given exactly as stored (and punctuation / case variants of it) */
  for (const c of cust) {
    const fields = Object.keys(ftpl);
    for (let k = 0; k < Math.round(4 * share); k++) {
      const f = fields[(k + Math.floor(r() * 4)) % fields.length];
      const forms = [c.name, c.name.toUpperCase(), c.name.replace(/\./g, ""), c.name.replace(/,/g, "")];
      const nm = pick(forms);
      const verb = verbatimCount(c.name);
      if (verb === 1) {
        // an exact (case / punctuation-light) form of ONE stored name: the target is that customer
        const exactForm = loose(nm) === loose(c.name);
        const sameLoose = cust.filter((x) => loose(x.name) === loose(nm));
        if (exactForm && sameLoose.length === 1) add("name-exact", pick(ftpl[f])(nm), { f, target: [c.key], mode: "single" });
        else add("name-variant", pick(ftpl[f])(nm), { f, target: sameLoose.map((x) => x.key), mode: sameLoose.length === 1 ? "single" : "ambiguous" });
      } else {
        // the stored name is shared by several customers: the question cannot say which one
        add("name-shared", pick(ftpl[f])(nm), { f, target: cust.filter((x) => x.name.toLowerCase() === c.name.toLowerCase()).map((x) => x.key), mode: "ambiguous" });
      }
    }
  }
  /* near-duplicate name forms that match several customers only loosely: suffix dropped, initial dropped, "Last, First" */
  for (const c of cust) {
    if (/\b(jr|sr)\.?$/i.test(c.name) || /\b[A-Z]\.\s/.test(c.name) || /(llc|inc)\b/i.test(c.name)) {
      const base = c.name.replace(/\s+(jr|sr)\.?$/i, "").replace(/\s[A-Z]\.\s/, " ").replace(/,?\s*(llc|inc\.?)$/i, "").trim();
      const near = cust.filter((x) => sameCore(x.name, base));
      const verb = cust.filter((x) => x.name.toLowerCase() === base.toLowerCase());
      for (const f of ["phone", "address"]) {
        if (verb.length === 1) add("name-dropped-part", pick(ftpl[f])(base), { f, target: [verb[0].key], mode: "single", near: near.map((x) => x.key) });
        else add("name-dropped-part", pick(ftpl[f])(base), { f, target: near.map((x) => x.key), mode: near.length > 1 ? "ambiguous" : "single" });
      }
    }
    const parts = c.name.replace(/,/g, "").split(" ");
    if (parts.length >= 2 && !/(llc|inc|plumbing|dental|auto|roofing|dentistry|automotive|roofers|heating)/i.test(c.name) && r() < 0.6) {
      const gen = /^(jr|sr)\.?$/i.test(parts[parts.length - 1]) ? parts.pop() : null;
      const last = parts.pop();
      const flip = `${last}, ${parts.join(" ")}${gen ? " " + gen : ""}`;
      const tsorted = (nm) => loose(nm).split(" ").sort().join(" ");
      const tgt = cust.filter((x) => tsorted(x.name) === tsorted(flip.replace(",", "")));
      add("name-flipped", pick(ftpl.phone)(flip), { f: "phone", target: tgt.map((x) => x.key), mode: tgt.length === 1 ? "single" : "ambiguous" });
    }
  }
  /* typos */
  for (const c of cust) {
    for (let k = 0; k < Math.round(2 * share); k++) {
      const t = typoOf(c.name, r); if (!t) continue; if (names.some((n) => loose(n) === loose(t))) continue;
      const f = pick(["phone", "email", "address", "invoice"]);
      // an explicit Jr / Sr / II or middle initial the person typed is part of who they mean: a customer with a DIFFERENT one is not a near candidate
      const gOf = (nm) => loose(nm).split(" ").filter((w) => /^(jr|sr|ii|iii|iv)$/.test(w)).join(",");
      const iOf = (nm) => loose(nm).split(" ").filter((w) => w.length === 1).join(",");
      const compat = (x) => (!gOf(t) || gOf(t) === gOf(x.name)) && (!iOf(t) || !iOf(x.name) || iOf(t) === iOf(x.name));
      const dists = cust.filter(compat).map((x) => ({ key: x.key, d: damerau(loose(x.name), loose(t)) })).sort((a, b) => a.d - b.d);
      const best = dists[0].d; const nearOnes = dists.filter((x) => x.d <= best + 2 && x.d <= 4);
      const uniq = [...new Set(nearOnes.map((x) => loose(cust.find((c2) => c2.key === x.key).name)))];
      if (nearOnes.length === 1 && (dists[1]?.d ?? 99) - best >= 3 && best <= 2) add("typo", pick(ftpl[f])(t), { f, target: [dists[0].key], mode: "single", typo: true });
      else if (best <= 4) add("typo", pick(ftpl[f])(t), { f, target: nearOnes.map((x) => x.key), mode: nearOnes.length > 1 ? "ambiguous" : "single-weak", typo: true });
    }
  }
  /* addresses: street / unit / city, written several ways, with components dropped */
  for (const c of cust) {
    const m = /^(\d+) (.+?)(?: (Apt|Unit|Suite) (\d+))?$/.exec(c.street); if (!m) continue;
    const [, num, st, ukind, unum] = m; const unit = ukind ? `${ukind} ${unum}` : null;
    const forms = [];
    forms.push({ txt: `${num} ${st}${unit ? " " + unit : ""}, ${c.city}`, hasUnit: !!unit, hasCity: true });
    forms.push({ txt: `${respell(`${num} ${st}`)}${unit ? " #" + unum : ""} ${c.city}`.replace(/#(\d+)/, ukind === "Suite" ? "Suite $1" : "#$1"), hasUnit: !!unit, hasCity: true, hash: !!unit && ukind !== "Suite" });
    forms.push({ txt: `${num} ${st}${unit ? " " + unit : ""}`, hasUnit: !!unit, hasCity: false });
    forms.push({ txt: `${num} ${st} ${c.city}`, hasUnit: false, hasCity: true });
    forms.push({ txt: `${num} ${st}`, hasUnit: false, hasCity: false });
    for (const form of forms) {
      if (r() > 0.5 * share + 0.1 && form.hasUnit && form.hasCity) continue;
      const T = cust.filter((x) => {
        const xm = /^(\d+) (.+?)(?: (Apt|Unit|Suite) (\d+))?$/.exec(x.street);
        if (!xm || xm[1] !== num || streetNorm(xm[2]) !== streetNorm(st)) return false;
        if (form.hasUnit && !(xm[3] && `${xm[3]} ${xm[4]}`.toLowerCase() === (unit ?? "").toLowerCase())) return false;
        if (form.hasCity && x.city !== c.city) return false;
        return true;
      }).map((x) => x.key);
      const tpl = pick([(a) => `who lives at ${a}`, (a) => `customer at ${a}`, (a) => `who is at ${a}`, (a) => `phone for the customer at ${a}`]);
      const txt = form.hash ? form.txt : form.txt;
      add("address", tpl(txt), { f: "who", target: T, mode: T.length === 1 ? "single" : "ambiguous" });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ verdict */
const TEXT_CLARIFY = /which one|which of|did you mean|more than one|several customers|multiple customers|these share|tell me which|pick one|which customer|on file twice|won't guess|which .{0,20}do you mean/i;
const NOTE_MARK = /\b(also on file with a similar name|similar names? on file|not to be confused with|other customers with (a )?similar)/i;
function verdict(q, res, attr, byKey, askedTenantKeys) {
  const text = [res.text, ...(Array.isArray(res.data?.didYouMean) ? res.data.didYouMean.map((d) => d.text) : []), ...(Array.isArray(res.data?.closest) ? res.data.closest.map((d) => d.text ?? d.name ?? "") : [])].join(" \n ");
  const handoff = !!res.claude || res.path === "escalated" || res.path === "escalated-declined";
  const T = new Set(q.gold.target);
  const isNoAnswer = res.kind === "no-answer";
  const isClarify = !handoff && (res.data?.clarify || TEXT_CLARIFY.test(res.text)) && !/^Nothing on file|I don't see/i.test(res.text);
  // the answer proper is what comes before an explicit "similar names on file" note (the note may name and describe other customers on purpose)
  const mainText = isClarify ? text : text.split(NOTE_MARK)[0];
  const whole = attr(text, q.tenant);
  const leaked = [...whole.ids].filter((k) => !askedTenantKeys.has(k));
  const out = { q: q.q, cat: q.cat, mode: q.gold.mode, path: res.path, kind: res.kind, text: res.text.slice(0, 400), outcome: null, wrong: false, leak: leaked.length > 0, lane: res.lane, detail: res.detail };
  if (leaked.length) { out.outcome = "CROSS-TENANT-LEAK"; out.wrong = true; return out; }
  if (handoff) { out.outcome = "handoff"; return out; }
  const m = attr(mainText, q.tenant);
  const valueIds = [...m.ids];                                   // phone / email / invoice / total / address carried
  const allIds = [...new Set([...m.ids, ...(isClarify ? [] : m.nameIds)])];   // plus names (answers only; a "which one?" lists names on purpose)
  const others = allIds.filter((k) => !T.has(k));
  const mine = allIds.filter((k) => T.has(k));
  if (q.gold.mode === "single" || q.gold.mode === "single-weak") {
    if (!isClarify && (!isNoAnswer || allIds.length)) {
      if (others.length) { out.outcome = "WRONG-ENTITY (other customer's value)"; out.wrong = true; return out; }
      if (mine.length) { out.outcome = "answered-target"; out.hasNote = NOTE_MARK.test(text); return out; }
      out.outcome = res.kind === "answer" ? "answer-unattributable" : "declined"; out.unverified = true; return out;
    }
    if (isClarify) { out.outcome = "clarified"; out.overAsk = true; return out; }
    out.outcome = "declined-existing"; out.falseDecline = true; return out;
  }
  // ambiguous: must clarify with details (>= 2 candidates' distinguishing values), hand off, or list ALL candidates
  if (!isClarify && (res.kind === "answer" || !isNoAnswer)) {
    if (allIds.length === 0) { out.outcome = "WRONG-ENTITY (definitive answer to an ambiguous question)"; out.wrong = true; return out; }
    if (mine.length === T.size && !others.length && valueIds.length >= Math.min(2, T.size)) { out.outcome = "listed-all-candidates"; out.listsAll = true; return out; }
    out.outcome = "WRONG-ENTITY (guess among candidates)"; out.wrong = true; return out;
  }
  if (isClarify) {
    const withDetail = valueIds.filter((k) => T.has(k)).length;
    out.outcome = "clarified"; out.detailCount = withDetail; out.hasDetails = withDetail >= Math.min(2, T.size);
    return out;
  }
  out.outcome = "declined-existing"; out.falseDecline = true; return out;
}

/* ------------------------------------------------------------------ main */
let failures = 0, passes = 0;
const check = (name, ok, detail = "") => { if (ok) passes++; else failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`); };

const H = await boot({ v2: true, release: true });
const T_DEFS = [{ key: "es_a", variant: 0, seed: 1 }, { key: "es_b", variant: 1, seed: 2 }, { key: "es_c", variant: 2, seed: 3 }];
const tenants = {}; const allCust = [];
for (const t of T_DEFS) {
  const built = buildEntityTenant({ seed: t.seed, variant: t.variant, key: t.key });
  await H.addTenant(t.key, built.export);
  built.customers.forEach((c, i) => { c.key = `${t.key}:${i}`; c.tenant = t.key; });
  tenants[t.key] = built; allCust.push(...built.customers);
}
const attr = makeAttributor(allCust);
const byKey = new Map(allCust.map((c) => [c.key, c]));

let questions = [];
for (const t of T_DEFS) questions.push(...generate(t.key, tenants[t.key].customers, t.seed * 101, 1));
const rs = mulberry(7);
if (QUICK) questions = questions.filter(() => rs() < 0.34);
// cross-tenant: ask tenant A about names that exist in tenant B/C (shared "unique" names) - same names, different data
console.log(`questions: ${questions.length} over ${T_DEFS.length} tenants, ${allCust.length} customers`);
check(`question count >= ${MIN_QUESTIONS}`, questions.length >= MIN_QUESTIONS, `got ${questions.length}`);

const results = [];
let n = 0;
for (const q of questions) {
  const keys = new Set(tenants[q.tenant].customers.map((c) => c.key));
  let res;
  try { res = await H.ask(q.tenant, q.q, "2026-10-07"); } catch (e) { res = { path: "error", kind: null, text: String(e?.message ?? e), claude: false, data: null }; }
  const v = verdict(q, res, attr, byKey, keys); v.tenant = q.tenant;
  results.push(v);
  if (++n % 100 === 0) console.log(`  ... ${n}/${questions.length}`);
}

/* (a) + (e) */
const wrong = results.filter((v) => v.wrong && !v.leak), leaks = results.filter((v) => v.leak);
const show = (arr) => arr.slice(0, 8).map((v) => `[${v.tenant}] ${v.cat}: "${v.q}" -> ${v.outcome}: ${v.text.slice(0, 160)}`).join("\n      ");
check(`(a) zero wrong-entity answers (${wrong.length} of ${results.length})`, wrong.length === 0, show(wrong));
check(`(e) cross-tenant isolation: zero leaks (${leaks.length})`, leaks.length === 0, show(leaks));
/* (b) ambiguous questions */
const amb = results.filter((v) => v.mode === "ambiguous");
const ambBad = amb.filter((v) => v.falseDecline || v.wrong);
check(`(b) ambiguous questions never guessed or declined (${amb.length} asked, ${ambBad.length} bad)`, ambBad.length === 0, show(ambBad));
const ambClar = amb.filter((v) => v.outcome === "clarified" || v.outcome === "clarify-names-non-candidate");
const ambNoDetail = ambClar.filter((v) => !v.hasDetails);
check(`(b) every "which one?" shows distinguishing details (${ambClar.length} clarifications, ${ambNoDetail.length} without)`, ambNoDetail.length === 0, show(ambNoDetail));
const decl = results.filter((v) => v.falseDecline);
check(`(b) no answerable question is declined as "not on file" (${decl.length})`, decl.length === 0, show(decl));
/* (d) typos */
const typ = results.filter((v) => v.cat === "typo");
const typWrong = typ.filter((v) => v.wrong || v.falseDecline);
check(`(d) typo questions: resolved only when unique with a large margin, else ask / hand off (${typ.length} asked, ${typWrong.length} bad)`, typWrong.length === 0, show(typWrong));
/* (f) "Did you mean...?" suggestions (owner requirement: not everyone remembers spellings). Typed vs dictated (inputMode "voice"), names and addresses. */
{
  const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dateText = (iso) => { const [y, m, d] = iso.split("-").map(Number); return `${MONTH[m - 1]} ${d}, ${y}`; };
  const sug = { fails: [], n: 0 };
  const fail = (label, why) => sug.fails.push(`${label}: ${why}`);
  const chipsOf = (res) => res.data?.entityChoices?.chips ?? [];
  const asTenantText = (res) => [res.text, ...chipsOf(res).flatMap((c) => [c.label, c.detail, c.text])].join(" \n ");
  const mine = (t, k) => tenants[t].customers.find((c) => c.name === k);
  const idsOf = (res, t) => [...attr(asTenantText(res), t).ids];
  const leakOf = (res, t) => idsOf(res, t).filter((k) => !new Set(tenants[t].customers.map((c) => c.key)).has(k));
  const hasValuesOf = (res, t, c) => { const a = attr(res.text, t); return a.ids.has(c.key); };
  const isAnswerFor = (res, t, c) => { if (res.kind !== "answer" || res.data?.clarify) return false; const a = attr(res.text, t); const ids = [...new Set([...a.ids, ...a.nameIds])]; return ids.includes(c.key) && ids.every((k) => k === c.key); };
  const typoName = (nm) => { const w = nm.split(" "); const i = w.length - 1; const x = w[i]; let k = 3; while (x[k] === x[k + 1]) k++; return [...w.slice(0, i), x.slice(0, k) + x[k + 1] + x[k] + x.slice(k + 2)].join(" "); };   // swap two (different) letters in the last word
  for (const t of T_DEFS.map((d) => d.key)) {
    const tag = `[${t}]`;
    for (const nm of ["Zelda Quillfeather", "Oberon Ashgrove", "Priya Venkataraman", "Quentin Vandersloot"]) {
      const c = mine(t, nm); const typed = typoName(nm); sug.n++;
      const q = `phone number for ${typed}`;
      /* one clear match, typed: answered for that customer AND says so, with a one-tap "Not this customer?" */
      const r1 = await H.ask(t, q, "2026-10-07");
      if (!isAnswerFor(r1, t, c)) fail(`${tag} typed "${q}"`, `not answered for ${nm} only: ${r1.text.slice(0, 120)}`);
      else {
        if (!new RegExp(`^Showing results for ${nm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, ${c.address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(closest match to "${typed}"\\)`).test(r1.text)) fail(`${tag} typed "${q}"`, `match not stated visibly: ${r1.text.slice(0, 160)}`);
        const ch = r1.data?.entityChoices; if (ch?.heading !== "Not this customer?" || !chipsOf(r1).some((x) => x.label === "None of these" && x.text.includes(`"${typed}"`))) fail(`${tag} typed "${q}"`, `no one-tap "Not this customer?" option`);
      }
      if (leakOf(r1, t).length) fail(`${tag} typed "${q}"`, "cross-tenant value");
      /* "Not this customer?" -> the name as typed: never answers for the customer that was rejected as if it had been named */
      const none = chipsOf(r1).find((x) => x.label === "None of these");
      if (none) { const r1b = await H.ask(t, none.text, "2026-10-07"); const ok = r1b.claude || r1b.data?.clarify || r1b.kind === "no-answer"; if (!ok || /^Showing results for/.test(r1b.text)) fail(`${tag} none-of-these "${none.text}"`, `answered anyway: ${r1b.text.slice(0, 120)}`); if (leakOf(r1b, t).length) fail(`${tag} none-of-these`, "cross-tenant value"); }
      /* dictated: a suggestion, never an answer on a match; the chip carries address, last 4 of the phone, last job date; a tap answers for exactly that customer */
      const r2 = await H.ask(t, q, "2026-10-07", { inputMode: "voice" });
      const k2 = chipsOf(r2);
      if (!r2.data?.clarify || r2.kind !== "answer" || !k2.some((x) => x.label === nm)) fail(`${tag} voice "${q}"`, `no "Did you mean ${nm}" chip: ${r2.text.slice(0, 120)}`);
      else {
        const x = k2.find((y) => y.label === nm);
        if (!x.detail.includes(c.street) || !x.detail.includes(`phone ending ${c.last4}`) || !x.detail.includes(`last job ${dateText(c.lastDate)}`)) fail(`${tag} voice "${q}"`, `chip detail incomplete: ${x.detail}`);
        if (hasValuesOf({ text: r2.data.facts.map((f) => f.label).join(" ") }, t, c) && /\b(invoice|total|email)\b/i.test(r2.text) === false) { /* names only */ }
        if (/INV-\d|\$\d/.test(r2.text) || /@example/.test(r2.text)) fail(`${tag} voice "${q}"`, `answered while asking: ${r2.text.slice(0, 100)}`);
        const r2b = await H.ask(t, x.text, "2026-10-07");
        if (!isAnswerFor(r2b, t, c) || /^Showing results for/.test(r2b.text)) fail(`${tag} tap "${x.text}"`, `tap did not answer for ${nm} alone: ${r2b.text.slice(0, 120)}`);
      }
      if (leakOf(r2, t).length) fail(`${tag} voice "${q}"`, "cross-tenant value");
      /* dictated but spelled exactly as stored: still answered straight away */
      const r3 = await H.ask(t, `phone number for ${nm}`, "2026-10-07", { inputMode: "voice" });
      if (!isAnswerFor(r3, t, c) || /^Showing results for/.test(r3.text)) fail(`${tag} voice exact "${nm}"`, `exact name not answered: ${r3.text.slice(0, 120)}`);
    }
    /* 2-3 plausible matches: chips with distinguishing details, each tap answers for that one customer */
    const kp = mine(t, "Kathryn Pemberton"), kq = mine(t, "Katharine Pemberton"); sug.n++;
    for (const mode of ["typed", "voice"]) {
      const r = await H.ask(t, "phone number for Katheryn Pemberton", "2026-10-07", mode === "voice" ? { inputMode: "voice" } : {});
      const ks = chipsOf(r);
      if (!r.data?.clarify || ks.length < 2 || ks.length > 3 || !ks.every((x) => x.detail.includes("phone ending") && x.detail.includes("last job"))) { fail(`${tag} two close names (${mode})`, `expected 2-3 detailed chips: ${r.text.slice(0, 120)}`); continue; }
      for (const [cc, label] of [[kp, "Kathryn Pemberton"], [kq, "Katharine Pemberton"]]) {
        const x = ks.find((y) => y.label === label); if (!x) { fail(`${tag} two close names (${mode})`, `missing ${label}`); continue; }
        const rb = await H.ask(t, x.text, "2026-10-07");
        if (!isAnswerFor(rb, t, cc)) fail(`${tag} tap ${label}`, `not answered for ${label} alone: ${rb.text.slice(0, 120)}`);
      }
      if (leakOf(r, t).length) fail(`${tag} two close names (${mode})`, "cross-tenant value");
    }
    /* no good match: "no customer by that name" + the closest 1-3 names (never an answer) */
    { const c = mine(t, "Priya Venkataraman"); const typed = "Pria Venkatramn"; sug.n++;   // 3+ edits from the stored name
      const r = await H.ask(t, `phone number for ${typed}`, "2026-10-07"); const ks = chipsOf(r);
      if (!(r.data?.clarify && /No customer named/.test(r.text) && /Did you mean/.test(r.text) && ks.length >= 1 && ks.length <= 3 && ks.some((x) => x.label === c.name))) fail(`${tag} no good match "${typed}"`, `${r.path}/${r.kind}: ${r.text.slice(0, 140)}`);
      if (leakOf(r, t).length) fail(`${tag} no good match`, "cross-tenant value"); }
    /* nobody close at all: no suggestion, no invented customer; the honest decline or the Claude path */
    { const r = await H.ask(t, "phone number for Xavier Brontosaurus", "2026-10-07"); sug.n++;
      if (chipsOf(r).length || [...attr(r.text, t).ids].length) fail(`${tag} unknown name`, `suggested or answered: ${r.text.slice(0, 120)}`); }
    /* addresses: St / Street, Ave / Avenue are one street; a different unit or city stays a different customer (suggested, never answered) */
    { const c = mine(t, "Zelda Quillfeather"); const m = /^(\d+) (.+)$/.exec(c.street); sug.n++;
      const longer = m[2].replace(/\bSt$/, "Street").replace(/\bAve$/, "Avenue").replace(/\bLn$/, "Lane").replace(/\bDr$/, "Drive").replace(/\bCt$/, "Court").replace(/\bRd$/, "Road").replace(/\bBlvd$/, "Boulevard");
      const r = await H.ask(t, `who lives at ${m[1]} ${longer}, ${c.city}`, "2026-10-07");
      if (!isAnswerFor(r, t, c) && !r.claude) fail(`${tag} Street/St`, `${r.text.slice(0, 140)}`);
      const aaron = mine(t, "Aaron Cole"); const am = /^(\d+) (.+?) Apt 2$/.exec(aaron.street);
      const r2 = await H.ask(t, `who lives at ${am[1]} ${am[2]} Apt 9, ${aaron.city}`, "2026-10-07");   // a unit nobody has
      if (!(r2.data?.clarify && /No customer is on file at exactly/.test(r2.text) && chipsOf(r2).length >= 1 && chipsOf(r2).length <= 3) || [...attr(r2.text.split(/Did you mean/)[0], t).ids].length) fail(`${tag} unit not on file`, `${r2.path}: ${r2.text.slice(0, 160)}`);
      const frank = mine(t, "Frank Ortiz"); const fm = /^(\d+) (.+)$/.exec(frank.street);
      const r3 = await H.ask(t, `who lives at ${fm[1]} ${fm[2]}, Chandler`, "2026-10-07");   // right house, other city
      if (!(r3.data?.clarify && chipsOf(r3).length >= 1) || /Showing results/.test(r3.text)) fail(`${tag} other city`, `${r3.path}: ${r3.text.slice(0, 160)}`);
      const stTypo = m[2].replace(/^(\w)(\w)/, "$2$1");                  // "Mian St" for "Main St"
      const r4 = await H.ask(t, `who lives at ${m[1]} ${stTypo}, ${c.city}`, "2026-10-07");
      if (stTypo !== m[2]) {
        if (!(isAnswerFor(r4, t, c) && /^Showing results for .* \(closest match to "/.test(r4.text))) fail(`${tag} street typo typed`, `${r4.path}: ${r4.text.slice(0, 160)}`);
        const r5 = await H.ask(t, `who lives at ${m[1]} ${stTypo}, ${c.city}`, "2026-10-07", { inputMode: "voice" });
        if (!(r5.data?.clarify && chipsOf(r5).some((x) => x.label === c.name))) fail(`${tag} street typo voice`, `${r5.path}: ${r5.text.slice(0, 160)}`);
        else { const r6 = await H.ask(t, chipsOf(r5).find((x) => x.label === c.name).text, "2026-10-07"); if (!isAnswerFor(r6, t, c)) fail(`${tag} street typo tap`, r6.text.slice(0, 140)); }
      }
      for (const x of [r, r2, r3, r4]) if (leakOf(x, t).length) fail(`${tag} address suggestions`, "cross-tenant value"); }
  }
  check(`(f) "Did you mean": one clear match is answered AND stated (+ "Not this customer?"); dictated questions get a tappable suggestion first; 2-3 close names get detailed chips; no match offers the closest names; addresses (St/Street ok, unit/city distinguishing); never cross-tenant (${sug.n} scenarios x tenants, ${sug.fails.length} bad)`, sug.fails.length === 0, sug.fails.slice(0, 8).join("\n      "));
}
/* (c) merge / link rules, pure: distinct customers are never auto-linked, auto-merged or collapsed on create; true duplicates still are */
const S = await import("../api/_lib/entities/similarity.js");
const I = await import("../api/_lib/integrity.js");
const R = await import("../api/_lib/recordsStore.js");
const B = await import("../api/_lib/entities/bulkMerge.js");
const cus = (name, address, phone = "", email = "") => ({ id: `${name}|${address}`, name, address, phone, email, customerNumber: "C-1" });
const FIRST = ["John", "Maria", "Robert", "Linda", "Daniel", "Teresa"], LAST = ["Smith", "Lopez", "Nguyen", "Castillo", "Okafor", "Brandt"], STR = ["Main St", "Oak Ave", "Palm Ln", "Elm Dr"], CITY = [["Mesa", "AZ 85201"], ["Tempe", "AZ 85281"], ["Gilbert", "AZ 85234"]];
const distinct = []; // [label, a, b, hard]  (hard = the two names/units/cities are plainly different people / places)
for (let i = 0; i < 6; i++) {
  const f = FIRST[i], l = LAST[i], st = STR[i % 4], n = 100 + i * 37;
  const A = (unit = "", c = 0) => `${n} ${st}${unit ? " " + unit : ""}, ${CITY[c][0]}, ${CITY[c][1]}`;
  for (const ph of [["", ""], ["(480) 555-0101", ""]]) {   // no contact info at all, and a phone on ONE side only
    const p1 = ph[0], p2 = ph[1];
    distinct.push(["Jr vs plain, same address", cus(`${f} ${l}`, A(), p1), cus(`${f} ${l} Jr.`, A(), p2), true]);
    distinct.push(["Jr vs Sr, same address", cus(`${f} ${l} Jr.`, A(), p1), cus(`${f} ${l} Sr.`, A(), p2), true]);
    distinct.push(["II vs III, same address", cus(`${f} ${l} II`, A(), p1), cus(`${f} ${l} III`, A(), p2), true]);
    distinct.push(["middle initials differ, same address", cus(`${f} A. ${l}`, A(), p1), cus(`${f} B. ${l}`, A(), p2), true]);
    distinct.push(["initial vs none, same address", cus(`${f} ${l}`, A(), p1), cus(`${f} A. ${l}`, A(), p2), false]);
    distinct.push(["same name, different units", cus(`${f} ${l}`, A("Apt 2"), p1), cus(`${f} ${l}`, A("Apt 3"), p2), true]);
    distinct.push(["same name, unit vs none", cus(`${f} ${l}`, A("Apt 2"), p1), cus(`${f} ${l}`, A(), p2), false]);
    distinct.push(["same name, same street, different cities", cus(`${f} ${l}`, A("", 0), p1), cus(`${f} ${l}`, A("", 1), p2), true]);
    distinct.push(["same name, street with city vs without city", cus(`${f} ${l}`, `${n} ${st}`, p1), cus(`${f} ${l}`, A("", 1), p2), false]);
    distinct.push(["same name, different streets", cus(`${f} ${l}`, `${n} ${st}, Mesa, AZ 85201`, p1), cus(`${f} ${l}`, `${n + 50} Cedar Ct, Mesa, AZ 85201`, p2), true]);
    distinct.push(["first-name typo, same address", cus(`${f} ${l}`, A(), p1), cus(`${f.slice(0, -1)} ${l}`, A(), p2), false]);
    distinct.push(["surname typo, same address", cus(`${f} ${l}`, A(), p1), cus(`${f} ${l.slice(0, -2)}${l[l.length - 1]}${l[l.length - 2]}`, A(), p2), false]);
    distinct.push(["different people, one unit each", cus(`${f} ${l}`, A("Apt 2"), p1), cus(`Beth Dunn`, A("Apt 3"), p2), true]);
  }
}
for (const [x, y, ax, ay] of [["ABC Plumbing", "A.B.C. Plumbing LLC", "160 Palm Ln, Mesa, AZ 85201", "161 Elm Dr, Tempe, AZ 85281"], ["Desert Ridge Dental", "Desert Ridge Dentistry", "372 Birch Blvd, Tempe, AZ 85281", "372 Birch Blvd, Tempe, AZ 85281"], ["ABC Plumbing", "ABC Plumbing & Heating", "160 Palm Ln, Mesa, AZ 85201", "160 Palm Ln, Mesa, AZ 85201"], ["Sun Valley Auto", "Sun Valley Auto", "10 Lake St, Mesa, AZ 85201", "10 Lake St, Tempe, AZ 85281"], ["Copper State Roofing", "Copper State Roofing LLC", "55 Hill Ct, Mesa, AZ 85201", "900 Rose St, Phoenix, AZ 85004"]]) {
  for (const ph of [["", ""], ["(480) 555-0101", "(480) 555-0102"]]) distinct.push([`business: ${x} / ${y}`, cus(x, ax, ph[0]), cus(y, ay, ph[1]), x !== "ABC Plumbing" || y !== "ABC Plumbing & Heating" ? false : false]);
}
const bad = { auto: [], link: [], create: [], bulk: [], suggestHard: [] };
for (const [label, a, b2, hard] of distinct) {
  const m = I.evaluateCustomerMatch({ name: a.name, address: a.address, phone: a.phone, email: a.email }, { name: b2.name, address: b2.address, phone: b2.phone, email: b2.email });
  if (m.tier === "auto" || m.score >= I.CUSTOMER_MATCH_THRESHOLD) bad.auto.push(`${label}: "${a.name}" | "${b2.name}" (${a.address} | ${b2.address}) score ${m.score} tier ${m.tier}`);
  // a document for A must not be linked onto the existing customer B
  const sel = R.selectCustomerMatch([{ id: b2.id, customer_number: "C-2", data: { customer_name: b2.name, service_address: b2.address, phone: b2.phone, email: b2.email } }], { name: a.name, address: a.address, phone: a.phone, email: a.email });
  if (sel) bad.link.push(`${label}: doc for "${a.name}" @ ${a.address} would be linked onto "${b2.name}" @ ${b2.address}`);
  // creating A must not collapse onto B
  const ex = I.findExistingCustomerForCreate({ name: a.name, phone: a.phone, email: a.email, address: a.address }, [{ id: b2.id, name: b2.name, address: b2.address, phone: b2.phone, email: b2.email }]);
  if (ex?.kind === "duplicate") bad.create.push(`${label}: create "${a.name}" reuses "${b2.name}" (${ex.basis})`);
  // "merge all exact duplicates" never takes two customers whose names are identical but whose unit / city / street differ
  const g = I.groupDuplicateCustomers([a, b2]);
  const eg = g.exact.map((x) => { const members = [a, b2].filter((r) => x.ids.includes(r.id)); return { ...x, safe: x.safe && B.corroborated(members) }; });
  if (eg.some((x) => x.safe)) bad.bulk.push(`${label}: "${a.name}" | "${b2.name}" is offered to "Merge all exact duplicates"`);
  const e = S.evaluatePair({ name: a.name, phone: a.phone, email: a.email, address: a.address }, { name: b2.name, phone: b2.phone, email: b2.email, address: b2.address });
  if (hard && e.score >= S.ENTITY_SUGGEST_THRESHOLD) bad.suggestHard.push(`${label}: "${a.name}" | "${b2.name}" suggested (${e.reasons.join("; ")})`);
}
const sh = (arr) => arr.slice(0, 6).join("\n      ");
check(`(c) distinct near-duplicates are never auto-merged (tier / score >= .9) (${distinct.length} pairs, ${bad.auto.length} bad)`, bad.auto.length === 0, sh(bad.auto));
check(`(c) a document for one is never linked onto the other (${bad.link.length} bad)`, bad.link.length === 0, sh(bad.link));
check(`(c) creating one customer never collapses onto a distinct look-alike (${bad.create.length} bad)`, bad.create.length === 0, sh(bad.create));
check(`(c) "Merge all exact duplicates" never takes distinct look-alikes (${bad.bulk.length} bad)`, bad.bulk.length === 0, sh(bad.bulk));
check(`(c) plainly different people (Jr/Sr, initials, units, cities) are never even suggested as a merge (${bad.suggestHard.length} bad)`, bad.suggestHard.length === 0, sh(bad.suggestHard));
// positive controls: genuinely identical customers still match (the strict rules must not break dedupe)
{
  const t1 = cus("John Smith", "100 Main St, Mesa, AZ 85201", "(480) 555-0101"), t2 = cus("John Smith", "100 Main St, Mesa, AZ 85201", "(480) 555-0101");
  const m = I.evaluateCustomerMatch({ name: t1.name, address: t1.address, phone: t1.phone }, { name: t2.name, address: t2.address, phone: t2.phone });
  check("(c) control: identical name + address + phone is still recognised as the same customer (human-confirmed merge)", m.score >= I.CUSTOMER_MATCH_THRESHOLD && m.tier === "auto");
  const sel = R.selectCustomerMatch([{ id: "x", customer_number: "C-2", data: { customer_name: "John Smith", service_address: "100 Main St, Mesa, AZ 85201" } }], { name: "John Smith", address: "100 Main St, Mesa, AZ 85201" });
  check("(c) control: the same person on a second document is still linked to the one customer", !!sel);
}
// merges happen only from a human action: nothing unattended applies a merge
{
  const cron = fs.readFileSync(new URL("../api/_lib/routes/cron-sweep.js", import.meta.url), "utf8");
  const applyList = (/apply:\s*\[([^\]]*)\]/.exec(cron)?.[1] ?? "").replace(/\/\/[^\n]*/g, "");
  check("(c) the nightly sweep never merges customers (no mergeDuplicates / absorbAddressPlaceholders in its unattended apply list)", !/mergeDuplicates|absorbAddressPlaceholders/.test(applyList), applyList.replace(/\s+/g, " "));
}

/* summary */
const tally = {}; for (const v of results) tally[v.outcome] = (tally[v.outcome] ?? 0) + 1;
console.log("\noutcomes:", JSON.stringify(tally));
const byCat = {}; for (const v of results) { byCat[v.cat] ??= { n: 0, wrong: 0, handoff: 0, clarified: 0, answered: 0, declined: 0 }; const c = byCat[v.cat]; c.n++; if (v.wrong) c.wrong++; if (v.outcome === "handoff") c.handoff++; else if (/clarif/.test(v.outcome)) c.clarified++; else if (/answered|listed/.test(v.outcome)) c.answered++; else if (/declin/.test(v.outcome)) c.declined++; }
console.log("by category:", JSON.stringify(byCat));
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ total: results.length, wrong: wrong.length, leaks: leaks.length, tally, byCat, failures: results.filter((v) => v.wrong || v.falseDecline || v.noisy || v.unverified || v.overAsk || (v.outcome === 'clarified' && v.hasDetails === false)).slice(0, 900), sample: results.slice(0, 40), handoffs: results.filter((v) => v.outcome === 'handoff').slice(0, 400), clarifies: results.filter((v) => v.outcome === 'clarified').slice(0, 400), answers: results.filter((v) => v.outcome === 'answered-target').slice(0, 60) }, null, 1));
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
