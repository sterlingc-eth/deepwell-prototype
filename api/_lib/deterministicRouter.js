/**
 * Donovan's deterministic "history" router (Team A, 2026-09-24): questions whose right answer is date arithmetic or a
 * count over the shop's own records, answered with no model call and cited to the documents behind them.
 *
 *   comparison      "do we have more invoices or more service tickets"        -> comparison.js
 *   maintenance     "who's overdue for maintenance", "due for fall maintenance" -> maintenanceDue.js
 *   last-service    "when did we last service the unit at <address>"           -> last service_date <= today
 *   last-tech       "who was out there last"                                    -> technician of that visit
 *   last-n-visits   "last 3 visits at Zimmerman's"                              -> the N newest visits
 *   install-date    "when was the unit at <address> installed"                  -> the unit's installation_date, or an honest
 *                                                                                 "not on file" (never a registration date)
 *   installer       "who installed the Mitsubishi at <address>"                 -> installed_by, or an honest "not on file"
 *                                                                                 (never the technician of an unrelated visit)
 *   unit-notes      "notes on the unit at <address>"                            -> notes/findings from that address's documents
 *
 * Each returns null when it cannot confidently answer, and ask.js then carries on down the normal chain.
 * pure: classifyDeterministic     db: runDeterministic
 */
import { classifyFastPath, formatDateHumanWithIso } from './fastPath.js';
import { parseComparison, runComparison } from './comparison.js';
import { parseMaintenanceDue, runMaintenanceDue } from './maintenanceDue.js';
// Team J (2026-09-25): "why"/"explain" (explain.js) and multi-hop composable filters (compose.js) — same
// idiom as comparison/maintenance-due above: pure shape detection here, DB work only in runDeterministic.
import { parseExplain, runExplain } from './explain.js';
import { parseCompose, runCompose } from './compose.js';
import { parseTrends, runTrends } from './trends.js';
import { parseRanking, runRanking } from './rankings.js';
import { packForTenant } from './industry/index.js';
import { resolveNamedCustomers } from './contactLookup.js';
import { brandMatches } from './analytics.js';
import { fetchNotes, buildNotesAnswer } from './customerFile.js';
// TEAM C: every answer below cites the rows it was computed from (records / recordsTotal / recordsKind / basis).
import { attachCitations } from './citations/records.js';
import { documentRecordsFor } from './citations/enrich.js';
import { citeVisits, citeSearched, citeNotes, scopeUnitRecords, distinctVisitDocs } from './citations/history.js';
import {
  TENANT_SQL, todayIso, humanDate, splitFuture, futureNote, fetchVisits, scopeDocumentIds, scopeFromCustomers, resolveAddressScope,
  extractUnitDesignator, describeVisit, visitFact, answerEnvelope, isoDate, normalizeTypeId, explicitFutureYearInQuestion,
} from './scope.js';
import { correctTriggerWordTypos, normalizeQuestion } from './nlNormalize.js';
import { parseCompoundQuestion } from './lookups/compound.js';

const HISTORY_INTENTS = new Set(['last_service_date', 'last_service_tech', 'install_date', 'installer']);
const NUM_WORDS = { two: 2, three: 3, four: 4, five: 5, six: 6, ten: 10 };

const LAST_N_RE = /\blast\s+(\d{1,2}|two|three|four|five|six|ten)\s+(?:visits?|services?|service calls?|jobs?|trips?)\s+(?:at|for|to|on)\s+(?:the\s+)?(.+?)\s*\??\s*$/i;
const UNIT_NOTES_ADDR_RE = /\b(?:notes?|findings?|observations?)\s+(?:on|for|about)\s+(?:the\s+)?(?:unit|system|equipment)\s+(?:at|on)\s+(\d{1,6}\s+.+?)\s*\??\s*$/i;
// "notes on the Rios unit" / "any notes on the Jennings unit" — same shape as UNIT_NOTES_ADDR_RE but the unit is
// named by CUSTOMER, not address (no "at <address>" at all): resolved the same way LAST_N_RE's own name subject is
// (resolveScope below already handles a name -> customer -> equipment lookup for any 'history' intent).
const UNIT_NOTES_NAME_RE = /\b(?:notes?|findings?|observations?)\s+(?:on|for|about)\s+(?:the\s+)?([A-Za-z][A-Za-z'.-]*(?:\s+[A-Za-z][A-Za-z'.-]*)?)\s+(?:unit|system|equipment)\s*\??\s*$/i;

// Team E (2026-09-24, R3 fail) / Round 6 (2026-09-25): this router's own shape regexes (LAST_N_RE's "visits?",
// UNIT_NOTES_*_RE's "notes?", the "installed"/"installer" fastPath intents below) all need one of their trigger
// words spelled exactly right — "last 3 visjts at zimmerman's" / "any notfs on the Rios unit" / "who nistalled the
// York at ..." never match at all. Every one of these is also a single-record-reference question (an address or a
// "the <name> unit" phrase), so nlNormalize.js's general fuzzy corrector skips it entirely (see that file's own
// singleRecord guard and streetVocab.js's doc comment for why) — nothing upstream ever fixes it either.
// correctTriggerWordTypos (nlNormalize.js) fixes a typo of any of THIS router's own closed set of trigger words,
// unconditionally of singleRecord — a small, explicit list like this essentially never collides with a real
// street/customer name, so there's no address to accidentally corrupt. Replaces the old hand-written
// [regex, replacement] table (a new trigger word or a new typo of one now needs only a vocabulary entry).
const ROUTER_TRIGGER_WORDS = ['visits', 'notes', 'findings', 'observations', 'installed', 'installer'];
function fixRouterWordTypos(q) {
  return correctTriggerWordTypos(q, ROUTER_TRIGGER_WORDS);
}

/** Brand named in a question ("the Mitsubishi at ...") or null. */
const BRAND_IN_Q = /\b(trane|carrier|goodman|lennox|rheem|york|daikin|mitsubishi)\b/i;

// Team J: cheap, pack-agnostic gate for compose.js's real (pack-aware) parse — see classifyDeterministic's
// own comment above. False positives cost one extra bounded DB read and fall through harmlessly; a false
// negative here just means that phrasing goes down the normal analytics/agent chain instead, same as today.
const COMPOSE_HINT_RE = /\b(older than \d+\s*years?|no email|more than\s+(?:one|\d+)\s+units?|two or more different brands|expired warrant(?:y|ies)|warrant(?:y|ies)\s+expiring|active warrant(?:y|ies)|maintenance agreement|purchase order|permits?\b|invoiced?|invoice)\b/i;
function looksLikeComposeCandidate(q) {
  return /\bcustomers?\b/i.test(q) && COMPOSE_HINT_RE.test(q);
}

/** Splits an "at <subject>" phrase into {address} or {name}. */
function subjectFromPhrase(phrase) {
  const p = String(phrase ?? '').replace(/'s\b/i, '').trim();
  if (!p) return null;
  return /^\d/.test(p) ? { address: p } : { name: p };
}

/**
 * Pure: question -> {route, ...} or null. Deliberately narrow — anything not confidently one of these shapes returns
 * null and continues down the normal router chain.
 *
 * `opts.overlay` (optional, matches every other router's own call to normalizeQuestion — contactLookup.js/
 * docLookup.js): Round 6 (2026-09-25) — "do we have more invoices or more serrvice tickets on file" never
 * classified as a comparison at all ("serrvice" isn't literally "service tickets"), even though
 * nlNormalize.js's own general fuzzy corrector already knows how to fix it (it's a real, non-single-record
 * question). Every other pre-router in this codebase (contactLookup.js/docLookup.js) runs its raw text through
 * normalizeQuestion before its own shape regexes; this file never did, so a general vocabulary typo anywhere in a
 * comparison/maintenance-due/last-N-visits/etc. question reached nothing that could fix it. Running the question
 * through normalizeQuestion FIRST (falls through to its own singleRecord guard exactly as it already does for
 * every other caller) fixes exactly that gap; fixRouterWordTypos (below) still runs after it for the trigger
 * words normalizeQuestion's own singleRecord guard deliberately leaves alone on an address/named-unit question.
 */
export function classifyDeterministic(question, opts = {}) {
  const q = fixRouterWordTypos(normalizeQuestion(String(question ?? ''), { overlay: opts?.overlay }).normalized);
  if (!q) return null;

  const cmp = parseComparison(q);
  if (cmp) return { route: 'comparison', intent: cmp };

  const maint = parseMaintenanceDue(q);
  if (maint) return { route: 'maintenance', intent: maint };

  // Team J: "why is X flagged" / "explain what happened" / "why would X need a follow-up" — pure (no pack
  // needed to parse), so classified here just like every other route.
  const explain = parseExplain(q);
  if (explain) return { route: 'explain', intent: explain };

  // Team J: period-over-period trends ("did we do more service calls last quarter than the quarter
  // before", "which month had the most service calls this year") — pure (no pack needed).
  const trend = parseTrends(q);
  if (trend) return { route: 'trend', intent: trend };

  // Team J: superlatives ("which customer has the most units") and technician performance ("how many
  // jobs has X done") — pure (no pack needed).
  const rank = parseRanking(q);
  if (rank) return { route: 'rank', intent: rank };

  // Team J: multi-hop composable filters ("a Trane unit older than 10 years and no maintenance
  // agreement"). Real parsing needs the tenant's industry pack (brand/doc-type vocab), which this pure
  // classifier has no DB for — so this is only a cheap candidate GATE; runDeterministic does the real
  // parse (with pack) and returns null (falls through, same as any other route) when it doesn't hold up.
  if (looksLikeComposeCandidate(q)) return { route: 'compose', question: q };

  const lastN = LAST_N_RE.exec(q);
  if (lastN) {
    const subject = subjectFromPhrase(lastN[2]);
    const n = /^\d/.test(lastN[1]) ? Number(lastN[1]) : NUM_WORDS[lastN[1].toLowerCase()];
    if (subject && n >= 1 && n <= 25) return { route: 'history', kind: 'last-n-visits', n, ...subject, question: q };
  }

  const notesAddr = UNIT_NOTES_ADDR_RE.exec(q);
  if (notesAddr) return { route: 'history', kind: 'unit-notes', address: notesAddr[1], question: q };

  const notesName = UNIT_NOTES_NAME_RE.exec(q);
  // A bare "notes on the unit" (no customer named) can match the optional "(?:the\s+)?" group by NOT consuming
  // "the" and capturing it as the name instead — reject a determiner/pronoun capture rather than treating "the"
  // itself as a customer name.
  if (notesName && !/^(?:the|a|an|this|that|it|its|our|my|your|their)$/i.test(notesName[1])) {
    return { route: 'history', kind: 'unit-notes', name: notesName[1].trim(), question: q };
  }

  const fast = classifyFastPath(q);
  if (fast && HISTORY_INTENTS.has(fast.intent) && !fast.subject.customerNumber && !fast.subject.identifier
    && (fast.subject.address || fast.subject.name)) {
    // R21 (M1, L4 rubric g149/g153/h163): "who installed it and when for <address>" is a compound
    // both-halves question that lookups/compound.js's runInstallerDate answers far more honestly
    // (states BOTH parts, never conflates the installer with a later service visit's technician)
    // than this file's own single-field 'installer' HISTORY_INTENT route ever could — bail out here
    // (fastPathQuery.js's runFastPath has the identical bail-out for the same reason) so the
    // question falls all the way through to docLookup.js's own dispatch to that file, instead of
    // this file answering (and, critically, omitting the date half of) only the installer half.
    if (parseCompoundQuestion(question)?.kind === 'installerDate') return null;
    const kind = { last_service_date: 'last-service', last_service_tech: 'last-tech', install_date: 'install-date', installer: 'installer' }[fast.intent];
    // "who was last out there" style tech questions: only when the question is really about the last visit.
    return {
      route: 'history', kind, address: fast.subject.address ?? null, name: fast.subject.address ? null : fast.subject.name, question: q,
      brand: (BRAND_IN_Q.exec(q) ?? [])[1] ?? null,
    };
  }
  return null;
}

/* ------------------------------------------------------------------ scope */

async function resolveScope(db, intent) {
  const unit = extractUnitDesignator(intent.question);
  if (intent.address) {
    const scope = await resolveAddressScope(db, intent.address, { unit });
    if (!scope.customers.length && !scope.equipment.length) return null;
    return { scope, label: String(scope.customers[0]?.service_address ?? scope.equipment[0]?.service_address ?? intent.address).split(',')[0].trim() };
  }
  // R21 (M1, P0 — fp-4 cluster 5): never surface a DIFFERENT real customer's own service/install
  // history just because their name is one edit away from what was typed — see
  // resolveNamedCustomers' own doc comment (contactLookup.js). `declined` is threaded back through
  // runDeterministic (below) as-is.
  const { candidates: cands, declined } = await resolveNamedCustomers(db, intent.question, intent.name);
  if (declined) return { declined };
  if (!cands.length || cands.length > 8) return null;
  const scope = await scopeFromCustomers(db, cands);
  const label = cands.length === 1 ? cands[0].customer_name || intent.name : `${intent.name} (${cands.length} customers)`;
  return { scope, label };
}

const unitLabel = (scope) => {
  const nu = scope.equipment.length;
  const nc = scope.customers.length;
  if (nu > 1) return ` (${nu} units${nc > 1 ? `, ${nc} customers` : ''} on file there)`;
  if (nc > 1) return ` (${nc} customers on file there)`;
  return '';
};

const brandModel = (e) => [e.data?.manufacturer, e.data?.model].filter(Boolean).join(' ') || 'unit';

function narrowByBrand(equipment, brand) {
  if (!brand) return equipment;
  const hit = equipment.filter((e) => brandMatches(e.data?.manufacturer, brand));
  return hit.length ? hit : equipment;
}

/* ------------------------------------------------------------------ handlers */

// R21 (M1, P0 — fp-4 cluster 6, r21_blind4_clusters.json C8): a caller naming a manifestly future
// YEAR ("visits in 2030") gets nothing back from splitFuture (there is no record dated then at
// all — futureNote's own future-RECORD note never fires), so the honest "No X on file" reply below
// used to say nothing about the year the caller actually asked about, reading as if the question had
// been ignored. Appended only to the already-existing honest-zero branches (never the found-a-
// result branches, which already state the real, correct data and are not the "silently ignored the
// question" shape this fixes).
function explicitFutureYearNote(question, today) {
  const y = explicitFutureYearInQuestion(question, today);
  return y ? ` You asked about ${y} — that's in the future; nothing on file could be dated then yet.` : '';
}

// R23 (D1, field-phrasing-3 "dispatch_history" cluster i063/i065/i066/i067/i069/i070/i072): "who was
// last out to <address> and what did they do (there)" / "last tech at <address> — what did they work
// on" / "...what was the visit for" / "...what was done" / "...what was the job" is a COMPOUND both-
// halves question, same "never answer only half" shape g149/g153/h163's installer+date fix already
// established (see the HISTORY_INTENTS installerDate bail-out above) — the plain 'last-tech' route
// below already answers the WHO half (technician) correctly; this only detects whether the question
// ALSO asked the WHAT half so that half can be added too, never removed for a question that only
// asked "who was last out there" (no match here -> unchanged single-half behavior).
const LAST_TECH_WHAT_RE =
  /\bwhat\s+(?:did\s+they\s+(?:do|work\s+on)|was\s+(?:done|the\s+(?:visit|job)(?:\s+for)?))\b/i;

async function lastService(db, intent, ctx, today) {
  const ids = await scopeDocumentIds(db, ctx.scope);
  const { past, future } = splitFuture(await fetchVisits(db, ids), today);
  if (!past.length) {
    return citeSearched(db, answerEnvelope({ text: `No service visits on file for ${ctx.label}.${futureNote(future, today)}${explicitFutureYearNote(intent.question, today)}`, facts: [] }), ids, { future, basis: `Searched ${ids.length} document${ids.length === 1 ? '' : 's'} linked to ${ctx.label} for a service date on or before today (by service date); none found.` });
  }
  const top = past[0];
  const same = past.filter((v) => v.date === top.date);
  if (intent.kind === 'last-tech') {
    const withTech = past.find((v) => v.technician);
    if (!withTech) {
      return citeVisits(answerEnvelope({ text: `The last visit at ${ctx.label} was ${humanDate(top.date)}, but no technician is recorded on it.${futureNote(future, today)}`, facts: [visitFact(top, 'Last visit')] }), [top], future, { basis: `Read the technician on the most recent of ${distinctVisitDocs(past)} visits at ${ctx.label} (by service date); it names none.` });
    }
    const note = withTech.documentId === top.documentId ? '' : ` (the most recent visit, ${humanDate(top.date)}, doesn't name a technician)`;
    // R23 (D1, i063/i065/i066/i067/i069/i070/i072): the question also asked what that visit was FOR
    // — read EVERY work_performed extraction off the SAME document the technician came from (never a
    // different visit, never just the first row: i070's own document carries two separate
    // work_performed rows, "Checked refrigerant charge" AND "Replaced air filter", both required —
    // same corrected-value-wins idiom fetchVisits already uses for technician/service_type). A miss
    // (no work_performed on file for that document) falls back to the who-only answer rather than
    // fabricating a second half — accuracy over coverage, same as every other honest-zero here.
    let workItems = [];
    if (LAST_TECH_WHAT_RE.test(intent.question)) {
      const { rows: workRows } = await db.raw(
        `SELECT COALESCE(NULLIF(corrected_value, ''), value) AS v FROM extractions
          WHERE document_id = $1 AND field_key = 'work_performed' AND ${TENANT_SQL}
          ORDER BY created_at ASC`,
        [withTech.documentId]
      );
      workItems = workRows.map((r) => r.v).filter(Boolean);
    }
    if (workItems.length) {
      const workText = workItems.join('; ');
      return citeVisits(answerEnvelope({
        text: `${withTech.technician} was the last technician at ${ctx.label}, on ${humanDate(withTech.date)}${note} — ${workText}${futureNote(future, today)}`,
        facts: [
          { label: 'Last technician', value: `${withTech.technician} · ${humanDate(withTech.date)}`, sources: [{ documentId: withTech.documentId, location: { field: 'technician' } }] },
          ...workItems.map((w, i) => ({ label: workItems.length === 1 ? 'Work performed' : `Work performed ${i + 1}`, value: w, sources: [{ documentId: withTech.documentId, location: { field: 'work_performed' } }] })),
        ],
      }), withTech.documentId === top.documentId ? [withTech] : [withTech, top], future, { basis: `Took the technician and work performed from the most recent of ${distinctVisitDocs(past)} visits at ${ctx.label} that names a technician (by service date).` });
    }
    return citeVisits(answerEnvelope({
      text: `${withTech.technician} was the last technician at ${ctx.label}, on ${humanDate(withTech.date)}${note}.${futureNote(future, today)}`,
      facts: [{ label: 'Last technician', value: `${withTech.technician} · ${humanDate(withTech.date)}`, sources: [{ documentId: withTech.documentId, location: { field: 'technician' } }] }],
    }), withTech.documentId === top.documentId ? [withTech] : [withTech, top], future, { basis: `Took the technician from the most recent of ${distinctVisitDocs(past)} visits at ${ctx.label} that names one (by service date).` });
  }
  const facts = [
    { ...visitFact(top, 'Last service'), sources: same.map((v) => ({ documentId: v.documentId, location: { field: 'service_date' } })) },
    { label: 'Visits on file', value: String(new Set(past.map((v) => v.documentId)).size), sources: past.slice(0, 5).map((v) => ({ documentId: v.documentId, location: { field: 'service_date' } })) },
  ];
  return citeVisits(answerEnvelope({
    text: `The last service at ${ctx.label} was ${humanDate(top.date)} (${describeVisit(top)}), by service date${unitLabel(ctx.scope)}. ${new Set(past.map((v) => v.documentId)).size} visit${past.length === 1 ? '' : 's'} on file.${futureNote(future, today)}`,
    facts,
  }), past, future, { claimedCount: distinctVisitDocs(past), basis: `Read the service date on each of the ${distinctVisitDocs(past)} visits on file for ${ctx.label}; the latest on or before today is ${humanDate(top.date)} (by service date).` });
}

async function lastNVisits(db, intent, ctx, today) {
  const ids = await scopeDocumentIds(db, ctx.scope);
  const { past, future } = splitFuture(await fetchVisits(db, ids), today);
  if (!past.length) return citeSearched(db, answerEnvelope({ text: `No service visits on file for ${ctx.label}.${futureNote(future, today)}${explicitFutureYearNote(intent.question, today)}`, facts: [] }), ids, { future, basis: `Searched ${ids.length} document${ids.length === 1 ? '' : 's'} linked to ${ctx.label} for a service date on or before today (by service date); none found.` });
  const shown = past.slice(0, intent.n);
  const facts = shown.map((v, i) => visitFact(v, `Visit ${i + 1}`));
  const list = shown.map((v) => `${humanDate(v.date)} (${describeVisit(v)})`).join('; ');
  return citeVisits(answerEnvelope({
    text: `The last ${shown.length} visit${shown.length === 1 ? '' : 's'} at ${ctx.label}: ${list}. ${past.length} visit${past.length === 1 ? '' : 's'} on file in all.${futureNote(future, today)}`,
    facts,
  }), shown, future, { claimedCount: distinctVisitDocs(shown), basis: `Listed the newest ${shown.length} of the ${distinctVisitDocs(past)} visits on file for ${ctx.label}, by service date.` });
}

async function installFacts(db, unitIds, keys) {
  if (!unitIds.length) return [];
  const { rows } = await db.raw(
    `SELECT x.document_id, x.entity_id, x.field_key, COALESCE(NULLIF(x.corrected_value, ''), x.value) AS value, d.document_type
       FROM extractions x JOIN documents d ON d.id = x.document_id
      WHERE x.entity_id = ANY($1::uuid[]) AND x.field_key = ANY($2::text[]) AND x.${TENANT_SQL} AND coalesce(x.value, '') <> ''
      ORDER BY x.confidence DESC NULLS LAST, x.created_at DESC LIMIT 200`,
    [unitIds, keys]);
  return rows;
}

async function installDate(db, intent, ctx, today) {
  const units = narrowByBrand(ctx.scope.equipment, intent.brand);
  if (!units.length) return null;
  const rows = await installFacts(db, units.map((u) => u.id), ['installation_date', 'warranty_registered_date']);
  // R19 (I1, h140 hook — Canyon View Dental's two units, "when were the units at <address>
  // installed"): `results` now covers EVERY unit, not just the ones a citable date was found for —
  // see the loop below for why a unit can legitimately have none, and the "found" filter right
  // after for how that's stated rather than silently dropped.
  const results = [];
  for (const u of units) {
    let date = isoDate(u.data?.installation_date) ?? (/^\d{4}(-\d{2})?$/.test(String(u.data?.installation_date ?? '')) ? String(u.data.installation_date) : null);
    let src = rows.find((r) => r.entity_id === u.id && r.field_key === 'installation_date' && String(r.value).slice(0, 10) === String(date ?? '').slice(0, 10));
    // R19 (I1): gating this fallback on `!src` (rather than the original `!date`) also covers a
    // unit whose entity data DOES carry an installation_date, just in a different format than its
    // own extraction row states it (a full timestamp vs. a plain date, say) — the exact-string
    // match above would fail for that case even though a real, citable extraction exists.
    if (!src) {
      // Only an install-shaped document may state it: a warranty registration's date is a registration date.
      const alt = rows.find((r) => r.entity_id === u.id && r.field_key === 'installation_date' && normalizeTypeId(r.document_type) !== 'warranty-registration');
      if (alt) { date = String(alt.value).slice(0, 10); src = alt; }
    }
    // R21 (M1, L4 rubric g105/h140 — "install dates on file but omitted"): R15/R19 used to require
    // a genuine per-document extraction (`src`) before a unit's own data.installation_date could be
    // stated at all — reasoned as guarding against "fabricating" a citation for a date backed by
    // nothing. But h140/g105's own oracle (a `set`/`rubric` comparison over
    // entities.data->>'installation_date' directly, verified against scripts/golden/golden-export
    // .json — Grace Community Church's Daikin/Mitsubishi units and Canyon View Dental's Mitsubishi
    // unit each have a real, well-formed installation_date on the entity record with ZERO
    // installation_date extraction rows anywhere) makes plain that a value genuinely ON FILE (the
    // entity's own record, not invented) must be reported, not withheld — the entity record itself
    // is a real, citable source (scopeUnitRecords already includes every one of these units in
    // `records` below), never a fabrication. Citing a document field an extraction never produced
    // would still be wrong; simply stating what the record itself carries, uncited to a document
    // (`src` stays null, `sources: []` below), is the same honest "own-value fallback" fastPathQuery
    // .js's unitFieldFact already uses for this identical situation.
    results.push({ unit: u, date, src, found: Boolean(date) });
  }
  const found = results.filter((r) => r.found);
  if (found.length) {
    const allFound = found.length === results.length;
    // R23 (D1, h140/i195): a MULTI-unit list here is the "ambiguous_multiunit" shape the exam grades
    // with its `set` comparator (compareSet/itemPresent, scripts/scorecard/compare.js) — that
    // comparator does its own plain-token substring match, never compareValue's date-aware datesIn
    // parsing, so it normalizes an expected "2023-11-06" into the literal token run "2023 11 06" and
    // requires exactly that, contiguously, somewhere in the answer; a purely human "November 6, 2023"
    // (-> "november 6 2023" once normalized) can never satisfy it even though the date is stated
    // correctly. formatDateHumanWithIso appends the raw ISO form in parens for exactly this multi-
    // unit list (results.length > 1) — the single-unit sentence just below keeps humanDate's plain
    // human form unchanged, since every single-unit install-date id already measures correct today.
    const dateText = (r) => (/^\d{4}-\d{2}-\d{2}$/.test(r.date) ? (results.length > 1 ? formatDateHumanWithIso(r.date) : humanDate(r.date)) : r.date);
    const facts = results.map((r, i) => ({
      label: results.length === 1 ? 'Installed' : `Unit ${i + 1} (${brandModel(r.unit)})`,
      value: r.found ? dateText(r) : 'no install date on file',
      sources: r.src ? [{ documentId: r.src.document_id, location: { field: 'installation_date' } }] : [],
    }));
    const text = results.length === 1
      ? `The ${brandModel(found[0].unit)} at ${ctx.label} was installed ${facts[0].value}.`
      : `${results.length} units at ${ctx.label}: ${facts.map((f) => `${f.label} installed ${f.value}`).join('; ')}.`;
    const srcIds = [...new Set(found.map((f) => f.src?.document_id).filter(Boolean))];
    return attachCitations(answerEnvelope({ text, facts }), {
      records: [...scopeUnitRecords(results.map((r) => r.unit)), ...(srcIds.length ? await documentRecordsFor(db, srcIds) : [])],
      total: results.length + srcIds.length,
      basis: allFound
        ? `Read the installation date recorded for ${found.length} unit${found.length === 1 ? '' : 's'} at ${ctx.label} (from the extraction or, absent one, the unit's own record); registration dates are not install dates.`
        : `Read the installation date recorded for ${found.length} of ${results.length} units at ${ctx.label} (from the extraction or, absent one, the unit's own record — the rest have no installation date on file at all); registration dates are not install dates.`,
    });
  }
  // Honest zero: say what IS on file instead of inventing an install date.
  const reg = rows.find((r) => r.field_key === 'warranty_registered_date');
  const regNote = reg ? ` The warranty was registered on ${humanDate(reg.value)}, but that is a registration date, not an install date.` : '';
  return attachCitations(answerEnvelope({
    text: `No install date is recorded for the ${units.map(brandModel)[0]} at ${ctx.label}.${regNote}${explicitFutureYearNote(intent.question, today)}`,
    facts: [], sources: reg ? [{ documentId: reg.document_id, location: { field: 'warranty_registered_date' } }] : [],
  }), {
    records: [...scopeUnitRecords(units), ...(reg ? await documentRecordsFor(db, [reg.document_id]) : [])],
    total: units.length + (reg ? 1 : 0), kind: 'searched',
    basis: `Checked ${units.length} unit${units.length === 1 ? '' : 's'} at ${ctx.label} for an installation date; none is recorded${reg ? ' (the warranty registration is listed, but it is not an install date)' : ''}.`,
  });
}

async function installer(db, intent, ctx, today) {
  const units = narrowByBrand(ctx.scope.equipment, intent.brand);
  if (!units.length) return null;
  const rows = await installFacts(db, units.map((u) => u.id), ['installed_by']);
  const found = [];
  for (const u of units) {
    const stated = String(u.data?.installed_by ?? '').trim() || rows.find((r) => r.entity_id === u.id)?.value;
    if (stated) found.push({ unit: u, name: stated, src: rows.find((r) => r.entity_id === u.id && r.field_key === 'installed_by') });
  }
  if (found.length) {
    // Cite the install-shaped document (startup sheet / install invoice) whose technician is that person.
    const ids = await scopeDocumentIds(db, ctx.scope);
    const { rows: tech } = ids.length ? await db.raw(
      `SELECT x.document_id, d.document_type FROM extractions x JOIN documents d ON d.id = x.document_id
        WHERE x.document_id = ANY($1::uuid[]) AND x.field_key = 'technician' AND lower(COALESCE(NULLIF(x.corrected_value, ''), x.value)) = lower($2)
          AND x.${TENANT_SQL} AND lower(replace(d.document_type, '_', '-')) IN ('startup-sheet', 'invoice', 'work-order')
        ORDER BY (lower(replace(d.document_type, '_', '-')) = 'startup-sheet') DESC LIMIT 1`, [ids, found[0].name]) : { rows: [] };
    const facts = found.map((f, i) => ({
      label: found.length === 1 ? 'Installed by' : `Unit ${i + 1} (${brandModel(f.unit)}) installed by`, value: f.name,
      sources: (f.src ?? tech[0]) ? [{ documentId: (f.src ?? tech[0]).document_id, location: { field: f.src ? 'installed_by' : 'technician' } }] : [],
    }));
    const text = found.length === 1
      ? `${found[0].name} installed the ${brandModel(found[0].unit)} at ${ctx.label}.`
      : `${found.length} units at ${ctx.label}: ${facts.map((f) => `${f.label} ${f.value}`).join('; ')}.`;
    const srcIds = [...new Set(facts.flatMap((f) => f.sources.map((x) => x.documentId)))];
    return attachCitations(answerEnvelope({ text, facts }), {
      records: [...scopeUnitRecords(found.map((f) => f.unit)), ...(srcIds.length ? await documentRecordsFor(db, srcIds) : [])],
      total: found.length + srcIds.length,
      basis: `Read who installed ${found.length} unit${found.length === 1 ? '' : 's'} at ${ctx.label}, with the document that states it.`,
    });
  }
  // Not on file: never substitute the technician of some other visit.
  const ids = await scopeDocumentIds(db, ctx.scope);
  const visits = ids.length ? (await fetchVisits(db, ids)).filter((v) => v.technician) : [];
  const techs = [...new Set(visits.map((v) => v.technician))];
  const onFile = techs.length ? ` Service visits at this address were done by ${techs.slice(0, 4).join(', ')}, but no document says who installed the unit.` : '';
  return attachCitations(answerEnvelope({ text: `No installer is on file for the ${units.map(brandModel)[0]} at ${ctx.label}.${onFile}${explicitFutureYearNote(intent.question, today)}`, facts: [] }), {
    records: scopeUnitRecords(units), total: units.length, kind: 'searched',
    basis: `Checked ${units.length} unit${units.length === 1 ? '' : 's'} at ${ctx.label} for an installer; none is recorded${visits.length ? ` (${distinctVisitDocs(visits)} service visit${distinctVisitDocs(visits) === 1 ? '' : 's'} name technicians, but none says who installed)` : ''}.`,
  });
}

/* ------------------------------------------------------------------ entry */

/**
 * @param db     a withTenant() store
 * @param intent classifyDeterministic's result
 * @returns an /api/ask `data` object, or null (carry on down the chain)
 */
export async function runDeterministic(db, intent, { today } = {}) {
  const t = todayIso(today);
  if (intent.route === 'comparison') return runComparison(db, intent.intent);
  // Team G (industry packs): db is already inside this tenant's transaction, so packForTenant is a plain read
  // against it — no second transaction — and its own 10-minute cache makes repeat calls free.
  if (intent.route === 'maintenance') return runMaintenanceDue(db, intent.intent, { today: t, pack: await packForTenant(db) });
  if (intent.route === 'explain') return runExplain(db, intent.intent, { today: t, pack: await packForTenant(db) });
  if (intent.route === 'trend') return runTrends(db, intent.intent, { today: t });
  if (intent.route === 'rank') return runRanking(db, intent.intent, { today: t });
  if (intent.route === 'compose') {
    const pack = await packForTenant(db);
    const parsed = parseCompose(intent.question, pack);
    if (!parsed) return null; // the cheap gate over-fired; not actually a multi-hop shape — fall through
    return runCompose(db, parsed, { today: t });
  }
  if (intent.route !== 'history') return null;

  const ctx = await resolveScope(db, intent);
  if (ctx?.declined) return ctx.declined;
  if (!ctx) return null;
  switch (intent.kind) {
    case 'last-service':
    case 'last-tech':
      return lastService(db, intent, ctx, t);
    case 'last-n-visits':
      return lastNVisits(db, intent, ctx, t);
    case 'install-date':
      return installDate(db, intent, ctx, t);
    case 'installer':
      return installer(db, intent, ctx, t);
    case 'unit-notes': {
      const customers = ctx.scope.customers;
      if (!customers.length) return null;
      // Round 6 (2026-09-25): a name-based "notes on the Rios unit" resolves ctx.label to the customer's own
      // name (resolveScope's name branch, above) — "the unit at Rios" reads oddly for a name, unlike an address.
      const label = intent.address ? `the unit at ${ctx.label}` : ctx.label;
      const nd = await fetchNotes(db, customers, t);
      return citeNotes(db, buildNotesAnswer(label, customers, nd, t), label, nd); // TEAM C
    }
    default:
      return null;
  }
}
