/**
 * Round 21 (L2 — lookup-side needs-model cluster conversions). Every shape this engineer fixed
 * this round gets its own positive (>=5 own paraphrases, never exam/dialogue text) and negative
 * coverage here, plus one end-to-end proof per shape against the golden tenant — same convention
 * as scripts/verify-lookups-r20.mjs.
 *
 *   - fastPath.js (IS_NAME_WARRANTY_RE / DOES_NAME_HAVE_RE): a GREEDY `{0,2}` name-continuation
 *     quantifier swallowed a filler adverb ("still"/"already"/"also") sitting between a full name
 *     and the trigger phrase into the name capture itself ("is Amy Isaacson still under warranty"
 *     -> subject.name = "Amy Isaacson still"), so resolveFastPathSubject's own ILIKE match found
 *     nothing and a uniquely-resolvable customer fell all the way to needs-model. Fixed by making
 *     both quantifiers lazy (`{0,2}?`), which can only ever narrow which capture length wins, never
 *     widen what the regex matches at all.
 *   - contactLookup.js (new Shape 3b-iv, IS_NAME_WARRANTY_STATUS_RE/WARRANTY_STATUS_FOR_NAME_RE):
 *     "is <name> (still) under warranty/covered", "warranty status on/for <name>" for a BARE
 *     surname never reached fastPath at all (no ANCHOR_RE domain word, and fastPath's own name
 *     regexes require a capitalized name this corpus's lowercase-typed questions never carry) —
 *     added as a new named-unit-warranty shape, reusing the exact same resolve/list machinery
 *     NAMED_UNIT_RE's "is the <name> unit still under warranty" already answers with (list every
 *     same-surname match's own status — confirmed correct against exam.json's own h045/h046/
 *     i111-i113 oracle, cmp:"set").
 *   - contactLookup.js (new last-visit phrasings): "last time we were out at <X>" ("out at", not
 *     "at"/"out to"), "last time we serviced <X>" (statement order), "when did we last go out for
 *     <X>", "whens the last time we serviced someone named <X>" — the same lastVisit shape
 *     WHEN_LAST_AT_RE/WHEN_LAST_SERVICE_RE/LAST_TIME_AT_RE already answer, in word orders none of
 *     them covered.
 *   - contactLookup.js (new ACCOUNT_JOB_CONNECTOR_RE / NAME_ACCOUNT_JOB_LEAD_RE): "<field> for the
 *     <name> account/job" (trailing "the ... account" was swallowed whole by CONNECTOR_NAME_RE's
 *     end-anchored capture, then rejected outright by isRealNamePhrase's stopword guard) and "<name>
 *     account/job, <field>" (the name comes first) — both new fallbacks alongside the existing
 *     Shape 1, never replacing it.
 *
 * Pure/offline — no network, no real DB, no model call, ever.
 *
 *   node scripts/verify-lookups-r21.mjs
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { extractSubject, classifyFastPath } from "../api/_lib/fastPath.js";
import { parseContactLookupQuestion } from "../api/_lib/contactLookup.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
let count = 0;
const check = (name, ok, detail = "") => {
  count++;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
};

/* ================================================================ Part A: pure shape detection */

// -- fastPath.js: IS_NAME_WARRANTY_RE / DOES_NAME_HAVE_RE no longer swallow a filler adverb -------
{
  const nameOf = (q) => extractSubject(q).name;
  check('extractSubject: "is Amy Isaacson still under warranty" -> name "Amy Isaacson" (not "...still")', nameOf("is Amy Isaacson still under warranty") === "Amy Isaacson", nameOf("is Amy Isaacson still under warranty"));
  check('extractSubject: "is Jessica Bennett still under warranty" -> name "Jessica Bennett"', nameOf("is Jessica Bennett still under warranty") === "Jessica Bennett", nameOf("is Jessica Bennett still under warranty"));
  check('extractSubject: "is Anthony Bennett still covered" -> name "Anthony Bennett"', nameOf("is Anthony Bennett still covered") === "Anthony Bennett", nameOf("is Anthony Bennett still covered"));
  check('extractSubject: "is Matthew Whitfield out of warranty yet" -> name "Matthew Whitfield"', nameOf("is Matthew Whitfield out of warranty yet") === "Matthew Whitfield", nameOf("is Matthew Whitfield out of warranty yet"));
  // NOTE (verified during this round, not asserted as fixed): DOES_NAME_HAVE_RE's own tail is just
  // `(?:have|need|take)` with no filler-inclusive alternative (unlike IS_NAME_WARRANTY_RE's tail,
  // which already bakes in "still under warranty"/"still covered" as whole literal alternatives) —
  // a filler adverb directly before "have" ("does Henderson Cole still have a warranty") still ends
  // up inside the capture ("Henderson Cole still") under the lazy quantifier exactly as it did under
  // the greedy one, because the ONLY capture length at which the tail matches at all is the one that
  // includes the filler word; lazy only changes which length wins when more than one already matches,
  // it never makes a previously-failing length succeed. Neither exam.json nor dialogues-1.json contain
  // this "does <name> still/already have" phrasing (grepped, zero hits), so this is a real but
  // out-of-corpus gap, not a regression — left as a documented follow-up rather than widening this
  // round's fix on spec (would need "still have"/"already have" added to the tail alternation, the
  // same style of fix IS_NAME_WARRANTY_RE's tail already uses).
  check('extractSubject: "does Henderson Cole have a warranty" (no filler) -> name "Henderson Cole"', nameOf("does Henderson Cole have a warranty") === "Henderson Cole", nameOf("does Henderson Cole have a warranty"));
  check('extractSubject: "does Patricia Alvarez need a warranty" (no filler) -> name "Patricia Alvarez"', nameOf("does Patricia Alvarez need a warranty") === "Patricia Alvarez", nameOf("does Patricia Alvarez need a warranty"));
  // negative: no filler word present at all — still resolves the full 2-word name exactly as before.
  check('extractSubject (negative): "is Amy Isaacson under warranty" (no filler) -> name "Amy Isaacson"', nameOf("is Amy Isaacson under warranty") === "Amy Isaacson", nameOf("is Amy Isaacson under warranty"));
  check('extractSubject (negative): "does Henderson Cole have a warranty" (no filler) -> name "Henderson Cole"', nameOf("does Henderson Cole have a warranty") === "Henderson Cole", nameOf("does Henderson Cole have a warranty"));
  // end-to-end: classifyFastPath's own subject carries the clean name through, never null on the intent.
  const fp = classifyFastPath("is Amy Isaacson still under warranty");
  check("classifyFastPath: intent still classifies as warranty_status with the fix in place", fp?.intent === "warranty_status" && fp?.subject?.name === "Amy Isaacson", JSON.stringify(fp));
}

// -- contactLookup.js: bare-surname "warranty status" shape ---------------------------------------
{
  const field = (q) => parseContactLookupQuestion(q)?.field;
  const name = (q) => parseContactLookupQuestion(q)?.namePhrase;
  const WARR = "unitWarranty";
  check('"warranty status on larkin" -> field unitWarranty, name "larkin"', field("warranty status on larkin") === WARR && name("warranty status on larkin") === "larkin");
  check('"is redwine still under warranty" -> field unitWarranty, name "redwine"', field("is redwine still under warranty") === WARR && name("is redwine still under warranty") === "redwine");
  check('"is dominguez still under warranty" -> field unitWarranty, name "dominguez"', field("is dominguez still under warranty") === WARR && name("is dominguez still under warranty") === "dominguez");
  check('"warranty status for esparza" -> field unitWarranty, name "esparza"', field("warranty status for esparza") === WARR && name("warranty status for esparza") === "esparza");
  check('"is fenwick still covered" -> field unitWarranty, name "fenwick"', field("is fenwick still covered") === WARR && name("is fenwick still covered") === "fenwick");
  check('"is thomas osborn\'s unit still under warranty" -> field unitWarranty, name "thomas osborn" (possessive + "unit" stripped)', field("is thomas osborn's unit still under warranty") === WARR && name("is thomas osborn's unit still under warranty") === "thomas osborn");
  // negatives: a generic pronoun/stopword-led capture must never be read as a literal customer name.
  check('(negative) "is anybody still under warranty" -> not resolved as a name lookup', parseContactLookupQuestion("is anybody still under warranty") === null || field("is anybody still under warranty") !== WARR);
  check('(negative) "is the trane unit under warranty" -> not resolved via this shape (brand word, not a name)', field("is the trane unit under warranty") !== WARR || name("is the trane unit under warranty") !== "the trane unit");
}

// -- contactLookup.js: new last-visit phrasings ----------------------------------------------------
{
  const parsed = (q) => parseContactLookupQuestion(q);
  check('"last time we were out at 3171 n power rd" -> field lastVisit, isStreet', parsed("last time we were out at 3171 n power rd")?.field === "lastVisit" && parsed("last time we were out at 3171 n power rd")?.isStreet === true);
  check('"when did we last go out for alvarez" -> field lastVisit, name "alvarez"', parsed("when did we last go out for alvarez")?.field === "lastVisit" && parsed("when did we last go out for alvarez")?.namePhrase === "alvarez");
  check('"last time we serviced 3541 w southern ave" -> field lastVisit, isStreet', parsed("last time we serviced 3541 w southern ave")?.field === "lastVisit" && parsed("last time we serviced 3541 w southern ave")?.isStreet === true);
  check('"whens the last time we serviced someone named osborn" -> field lastVisit, name "osborn"', parsed("whens the last time we serviced someone named osborn")?.field === "lastVisit" && parsed("whens the last time we serviced someone named osborn")?.namePhrase === "osborn");
  check('"last time we serviced ellison" -> field lastVisit, name "ellison"', parsed("last time we serviced ellison")?.field === "lastVisit" && parsed("last time we serviced ellison")?.namePhrase === "ellison");
  check('"when did we last go out to bracken" -> field lastVisit, name "bracken"', parsed("when did we last go out to bracken")?.field === "lastVisit" && parsed("when did we last go out to bracken")?.namePhrase === "bracken");
  // negative: WHEN_LAST_AT_RE's own pre-existing "at"/"out to" phrasing still resolves unchanged.
  check('(negative, pre-existing) "when were we last at Ellison\'s" still resolves', parsed("when were we last at Ellison's")?.field === "lastVisit");
  // negative: an unrelated question with none of these trigger phrases stays unclaimed by this shape.
  check('(negative) "how many visits have we had" is not claimed as a lastVisit-by-name shape', parsed("how many visits have we had")?.field !== "lastVisit");
}

// -- contactLookup.js: "<name> account/job" connector shapes ---------------------------------------
{
  const parsed = (q) => parseContactLookupQuestion(q);
  check('"phone number for the alvarez account" -> field phone, name "alvarez"', parsed("phone number for the alvarez account")?.field === "phone" && parsed("phone number for the alvarez account")?.namePhrase === "alvarez");
  check('"address for the rios account" -> field address, name "rios"', parsed("address for the rios account")?.field === "address" && parsed("address for the rios account")?.namePhrase === "rios");
  check('"wyckoff account, whats their phone" -> field phone, name "wyckoff"', parsed("wyckoff account, whats their phone")?.field === "phone" && parsed("wyckoff account, whats their phone")?.namePhrase === "wyckoff");
  check('"tovar account phone number" -> field phone, name "tovar"', parsed("tovar account phone number")?.field === "phone" && parsed("tovar account phone number")?.namePhrase === "tovar");
  check('"garrison job, whats the serial" -> field serial, name "garrison"', parsed("garrison job, whats the serial")?.field === "serial" && parsed("garrison job, whats the serial")?.namePhrase === "garrison");
  check('"email for the mercer job" -> field email, name "mercer"', parsed("email for the mercer job")?.field === "email" && parsed("email for the mercer job")?.namePhrase === "mercer");
  // negative: the ordinary "for <name>" shape with no account/job noun keeps resolving the same way
  // (CONNECTOR_NAME_RE's own existing behavior — the new regexes are a fallback, never a replacement).
  // CONNECTOR_NAME_RE has always lowercased its capture (verified against the pre-this-round code via
  // `git stash`) — resolveContactCandidates' own ILIKE matching is case-insensitive, so this was never
  // a bug; asserting the literal original casing here would be wrong, not the code.
  check('(negative, pre-existing) "phone number for Amy Isaacson" still resolves via the plain connector shape', parsed("phone number for Amy Isaacson")?.field === "phone" && parsed("phone number for Amy Isaacson")?.namePhrase === "amy isaacson");
  // negative: a bare "account"/"job" mention with no real name before it must never fabricate a name.
  check('(negative) "phone number for the account" does not resolve (no real name before "account")', parsed("phone number for the account")?.field !== "phone" || !parsed("phone number for the account")?.namePhrase);
}

console.log(`\n${count - failures}/${count} unit checks passed.`);

/* ======================================================= Part B: end to end against the golden tenant */
const offline = await import(path.join(ROOT, "scripts/offline-exam.mjs"));
const { installPgHarness, installModelBlock, createPGlite, setActiveDatabase, loadExportIntoNewTenant } = offline;
const { askViaHandler } = await import(path.join(ROOT, "api/_lib/scorecard/askCall.js"));
const { default: askHandler } = await import(path.join(ROOT, "api/ask.js"));

await installPgHarness();
const modelCounter = await installModelBlock();
const lite = await createPGlite();
await setActiveDatabase(lite);
const exportData = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/golden/golden-export.json"), "utf8"));
const { ctx } = await loadExportIntoNewTenant(lite, exportData, { tenantKey: "verify-lookups-r21", tenantName: "Verify Lookups R21" });
const auth = { tenantId: ctx.tenantKey, orgId: ctx.tenantName ?? ctx.tenantKey, userId: null };
const today = "2026-09-26";

async function ask(question) {
  modelCounter.n = 0;
  const asked = await askViaHandler({ handler: askHandler, auth, question, today });
  return { usedModel: modelCounter.n > 0, data: asked.data };
}

{
  const r = await ask("is Amy Isaacson still under warranty");
  check(
    "e2e :: full name + filler adverb resolves without a model call",
    !r.usedModel && Boolean(r.data) && /Amy Isaacson/i.test(r.data.text ?? ""),
    JSON.stringify(r.data)?.slice(0, 200),
  );
}
{
  const r = await ask("warranty status on larkin");
  check(
    "e2e :: bare-surname warranty status lists every same-surname match, no model call",
    !r.usedModel && Boolean(r.data) && /Cynthia Larkin/i.test(r.data.text ?? "") && /Amy Larkin/i.test(r.data.text ?? ""),
    JSON.stringify(r.data)?.slice(0, 300),
  );
}
{
  const r = await ask("when did we last go out for alvarez");
  check(
    "e2e :: last-visit-by-surname (\"go out for\") resolves without a model call",
    !r.usedModel && Boolean(r.data),
    JSON.stringify(r.data)?.slice(0, 200),
  );
}
{
  const r = await ask("wyckoff account, whats their phone");
  check(
    "e2e :: \"<name> account, whats their phone\" resolves (or honestly declines on ambiguity) without a model call",
    !r.usedModel && Boolean(r.data),
    JSON.stringify(r.data)?.slice(0, 200),
  );
}

console.log(`\n${count - failures}/${count} checks passed.`);
if (failures > 0) {
  console.error(`FAILED: ${failures} check(s).`);
  process.exit(1);
}
process.exit(0);
