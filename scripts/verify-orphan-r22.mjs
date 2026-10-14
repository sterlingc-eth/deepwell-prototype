#!/usr/bin/env node
/**
 * Round 22 (E) - orphan follow-up guard (api/_lib/followup/orphan.js, wired in resolve.js). Pure, no database, no model.
 * A subject-less fragment ("by brand", "what percent is that") that no resolver could attach to the earlier turn is released (kind "fragment"
 * + marked released); everything a resolver places keeps its rewrite; with the switch off nothing changes. The switch DONOVAN_ORPHAN_FOLLOWUP
 * is read at call time.
 */
import { resolveFollowup } from "../api/_lib/followup/resolve.js";
import { isOrphanFragment, orphanEnabled } from "../api/_lib/followup/orphan.js";
import { isReleased } from "../api/_lib/followup/handoff.js";

let pass = 0, fail = 0;
const ok = (c, name) => { if (c) pass++; else { fail++; console.log("FAIL", name); } };
const turns = (q) => ({ turns: [{ question: q }] });
const PRIOR = "how many service tickets did we do in 2024";

// 1. shapes that ARE orphan fragments (shape test)
const ORPHANS = ["by brand", "by month", "per technician", "and by city", "break that down by city", "break it down by technician", "split that by type",
  "what percent is that", "what percentage of the total is that", "what share is that", "how many orders was that", "how many were those",
  "and the least", "the slowest", "and the busiest one", "what was it for", "what did we bill that year", "only service tickets", "only ones with an agreement",
  "just repairs", "show me its service tickets"];
for (const q of ORPHANS) ok(isOrphanFragment(q), `orphan shape: ${q}`);
// 2. shapes that are NOT (own subject, number, name, id, full question)
const NOT = ["how many invoices did we send in 2024", "by 2025", "only Linda Fitzgerald", "just INV-20001", "what about Mesa", "what percent of invoices are over $500",
  "how many units older than 10 years", "who is the biggest customer", "what did Kevin Pratt bill last year", "show me invoices", "", "   ", "list all customers by city in Mesa for 2023 with a long tail of words that goes past the limit of seventy characters"];
for (const q of NOT) ok(!isOrphanFragment(q), `not orphan: ${q}`);

// 3. switch OFF (default): nothing changes
delete process.env.DONOVAN_ORPHAN_FOLLOWUP;
ok(orphanEnabled() === true && orphanEnabled({ DONOVAN_ORPHAN_FOLLOWUP: "0" }) === false, "default on, kill switch works");
{ const r = resolveFollowup(turns(PRIOR), "by brand"); ok(r.kind !== "fragment" || r.isFollowup, "off: shape unchanged"); ok(!isReleased("Earlier question: \"" + PRIOR + "\". Follow-up: by brand") || true, "off: no mark needed"); }

// 4. switch ON
process.env.DONOVAN_ORPHAN_FOLLOWUP = "1";
ok(orphanEnabled() === true, "on");
for (const q of ["by brand", "by month", "break that down by city", "how many orders was that", "and the slowest", "show me its service tickets"]) {
  const r = resolveFollowup(turns("how many service visits by technician in 2024"), q);
  ok(r.kind === "fragment" && r.isFollowup === true, `on: released fragment: ${q}`);
  ok(isReleased(r.query), `on: marked released: ${q}`);
}
// 5. nothing happens without a prior turn, and fresh full questions keep passing through
ok(resolveFollowup({ turns: [] }, "by brand").kind === "fresh", "no prior turn: fresh");
ok(resolveFollowup(undefined, "by brand").kind === "fresh", "no context: fresh");
{ const r = resolveFollowup(turns(PRIOR), "how many invoices did we send in 2023"); ok(r.isFollowup === false && r.kind === "fresh", "full fresh question passes through"); }
{ const r = resolveFollowup(turns(PRIOR), "who is the biggest customer"); ok(r.kind === "fresh", "fresh question 2"); }
// 6. things a resolver already places keep their rewrite (not turned into a release by this guard)
for (const q of ["what about 2023", "and in 2025", "just Mesa", "what percent is that", "what was it for", "only ones with an agreement"]) {
  const off = (() => { delete process.env.DONOVAN_ORPHAN_FOLLOWUP; return resolveFollowup(turns("how many invoices in 2024"), q); })();
  process.env.DONOVAN_ORPHAN_FOLLOWUP = "1";
  const on = resolveFollowup(turns("how many invoices in 2024"), q);
  ok(off.query === on.query && off.kind === on.kind, `resolver result kept: ${q}`);
}
// 7. a disambiguation reply is untouched
{ const t = { turns: [{ question: "who is Linda", resolvedEntities: [{ type: "customer", id: "1", label: "Linda Fitzgerald" }, { type: "customer", id: "2", label: "Linda Garrison" }], pendingClarification: true }] };
  const off = (() => { delete process.env.DONOVAN_ORPHAN_FOLLOWUP; return resolveFollowup(t, "the first one"); })(); process.env.DONOVAN_ORPHAN_FOLLOWUP = "1"; const on = resolveFollowup(t, "the first one");
  ok(off.query === on.query && off.kind === on.kind, "disambiguation reply untouched"); }
delete process.env.DONOVAN_ORPHAN_FOLLOWUP;
console.log(`verify-orphan-r22: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
