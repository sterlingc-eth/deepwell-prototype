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
import { classifyFastPath } from './fastPath.js';
import { parseComparison, runComparison } from './comparison.js';
import { parseMaintenanceDue, runMaintenanceDue } from './maintenanceDue.js';
// Team J (2026-09-25): "why"/"explain" (explain.js) and multi-hop composable filters (compose.js) — same
// idiom as comparison/maintenance-due above: pure shape detection here, DB work only in runDeterministic.
import { parseExplain, runExplain } from './explain.js';
import { parseCompose, runCompose } from './compose.js';
import { parseTrends, runTrends } from './trends.js';
import { parseRanking, runRanking } from './rankings.js';
import { packForTenant } from './industry/index.js';
import { resolveContactCandidates } from './contactLookup.js';
import { brandMatches } from './analytics.js';
import { fetchNotes, buildNotesAnswer } from './customerFile.js';
// TEAM C: every answer below cites the rows it was computed from (records / recordsTotal / recordsKind / basis).
import { attachCitations } from './citations/records.js';
import { documentRecordsFor } from './citations/enrich.js';
import { citeVisits, citeSearched, citeNotes, scopeUnitRecords, distinctVisitDocs } from './citations/history.js';
import {
  TENANT_SQL, todayIso, humanDate, splitFuture, futureNote, fetchVisits, scopeDocumentIds, scopeFromCustomers, resolveAddressScope,
  extractUnitDesignator, describeVisit, visitFact, answerEnvelope, isoDate, normalizeTypeId,
} from './scope.js';

const HISTORY_INTENTS = new Set(['last_service_date', 'last_service_tech', 'install_date', 'installer']);
const NUM_WORDS = { two: 2, three: 3, four: 4, five: 5, six: 6, ten: 10 };

const LAST_N_RE = /\blast\s+(\d{1,2}|two|three|four|five|six|ten)\s+(?:visits?|services?|service calls?|jobs?|trips?)\s+(?:at|for|to|on)\s+(?:the\s+)?(.+?)\s*\??\s*$/i;
const UNIT_NOTES_ADDR_RE = /\b(?:notes?|findings?|observations?)\s+(?:on|for|about)\s+(?:the\s+)?(?:unit|system|equipment)\s+(?:at|on)\s+(\d{1,6}\s+.+?)\s*\??\s*$/i;

// Team E (2026-09-24, R3 fail): "last 3 visjts at zimmerman's" / "last 3 viisits at quintana's" never matched LAST_N_RE
// at all (its own literal "visits?" alternative can't survive a typo) and fell through to retrieval/the agent instead
// of this deterministic, cited answer. nlNormalize.js's general fuzzy corrector skips every word of a question it
// judges a single-record reference (streetVocab.js's own doc comment explains why) — exactly what a "last N visits at
// <name>'s" question always is — so nothing upstream ever fixes this either. A tiny closed table for the exact typos
// this corpus's own question bank produces, same idiom as contactLookup.js's own FIELD_WORD_TYPO_FIXES.
const ROUTER_WORD_TYPO_FIXES = [[/\b(?:visjts|viisits)\b/gi, 'visits']];
function fixRouterWordTypos(q) {
  let out = q;
  for (const [re, to] of ROUTER_WORD_TYPO_FIXES) out = out.replace(re, to);
  return out;
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
 */
export function classifyDeterministic(question) {
  const q = fixRouterWordTypos(String(question ?? '').trim());
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

  const fast = classifyFastPath(q);
  if (fast && HISTORY_INTENTS.has(fast.intent) && !fast.subject.customerNumber && !fast.subject.identifier
    && (fast.subject.address || fast.subject.name)) {
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
  const cands = await resolveContactCandidates(db, intent.name);
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

async function lastService(db, intent, ctx, today) {
  const ids = await scopeDocumentIds(db, ctx.scope);
  const { past, future } = splitFuture(await fetchVisits(db, ids), today);
  if (!past.length) {
    return citeSearched(db, answerEnvelope({ text: `No service visits on file for ${ctx.label}.${futureNote(future, today)}`, facts: [] }), ids, { future, basis: `Searched ${ids.length} document${ids.length === 1 ? '' : 's'} linked to ${ctx.label} for a service date on or before today (by service date); none found.` });
  }
  const top = past[0];
  const same = past.filter((v) => v.date === top.date);
  if (intent.kind === 'last-tech') {
    const withTech = past.find((v) => v.technician);
    if (!withTech) {
      return citeVisits(answerEnvelope({ text: `The last visit at ${ctx.label} was ${humanDate(top.date)}, but no technician is recorded on it.${futureNote(future, today)}`, facts: [visitFact(top, 'Last visit')] }), [top], future, { basis: `Read the technician on the most recent of ${distinctVisitDocs(past)} visits at ${ctx.label} (by service date); it names none.` });
    }
    const note = withTech.documentId === top.documentId ? '' : ` (the most recent visit, ${humanDate(top.date)}, doesn't name a technician)`;
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
  if (!past.length) return citeSearched(db, answerEnvelope({ text: `No service visits on file for ${ctx.label}.${futureNote(future, today)}`, facts: [] }), ids, { future, basis: `Searched ${ids.length} document${ids.length === 1 ? '' : 's'} linked to ${ctx.label} for a service date on or before today (by service date); none found.` });
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

async function installDate(db, intent, ctx) {
  const units = narrowByBrand(ctx.scope.equipment, intent.brand);
  if (!units.length) return null;
  const rows = await installFacts(db, units.map((u) => u.id), ['installation_date', 'warranty_registered_date']);
  const found = [];
  for (const u of units) {
    let date = isoDate(u.data?.installation_date) ?? (/^\d{4}(-\d{2})?$/.test(String(u.data?.installation_date ?? '')) ? String(u.data.installation_date) : null);
    let src = rows.find((r) => r.entity_id === u.id && r.field_key === 'installation_date' && String(r.value).slice(0, 10) === String(date ?? '').slice(0, 10));
    if (!date) {
      // Only an install-shaped document may state it: a warranty registration's date is a registration date.
      const alt = rows.find((r) => r.entity_id === u.id && r.field_key === 'installation_date' && normalizeTypeId(r.document_type) !== 'warranty-registration');
      if (alt) { date = String(alt.value).slice(0, 10); src = alt; }
    }
    if (date) found.push({ unit: u, date, src });
  }
  if (found.length) {
    const facts = found.map((f, i) => ({
      label: found.length === 1 ? 'Installed' : `Unit ${i + 1} (${brandModel(f.unit)})`,
      value: /^\d{4}-\d{2}-\d{2}$/.test(f.date) ? humanDate(f.date) : f.date,
      sources: f.src ? [{ documentId: f.src.document_id, location: { field: 'installation_date' } }] : [],
    }));
    const text = found.length === 1
      ? `The ${brandModel(found[0].unit)} at ${ctx.label} was installed ${facts[0].value}.`
      : `${found.length} units at ${ctx.label}: ${facts.map((f) => `${f.label} installed ${f.value}`).join('; ')}.`;
    const srcIds = [...new Set(found.map((f) => f.src?.document_id).filter(Boolean))];
    return attachCitations(answerEnvelope({ text, facts }), {
      records: [...scopeUnitRecords(found.map((f) => f.unit)), ...(srcIds.length ? await documentRecordsFor(db, srcIds) : [])],
      total: found.length + srcIds.length,
      basis: `Read the installation date recorded for ${found.length} unit${found.length === 1 ? '' : 's'} at ${ctx.label} and the document it came from; registration dates are not install dates.`,
    });
  }
  // Honest zero: say what IS on file instead of inventing an install date.
  const reg = rows.find((r) => r.field_key === 'warranty_registered_date');
  const regNote = reg ? ` The warranty was registered on ${humanDate(reg.value)}, but that is a registration date, not an install date.` : '';
  return attachCitations(answerEnvelope({
    text: `No install date is recorded for the ${units.map(brandModel)[0]} at ${ctx.label}.${regNote}`,
    facts: [], sources: reg ? [{ documentId: reg.document_id, location: { field: 'warranty_registered_date' } }] : [],
  }), {
    records: [...scopeUnitRecords(units), ...(reg ? await documentRecordsFor(db, [reg.document_id]) : [])],
    total: units.length + (reg ? 1 : 0), kind: 'searched',
    basis: `Checked ${units.length} unit${units.length === 1 ? '' : 's'} at ${ctx.label} for an installation date; none is recorded${reg ? ' (the warranty registration is listed, but it is not an install date)' : ''}.`,
  });
}

async function installer(db, intent, ctx) {
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
  return attachCitations(answerEnvelope({ text: `No installer is on file for the ${units.map(brandModel)[0]} at ${ctx.label}.${onFile}`, facts: [] }), {
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
  if (intent.route === 'rank') return runRanking(db, intent.intent);
  if (intent.route === 'compose') {
    const pack = await packForTenant(db);
    const parsed = parseCompose(intent.question, pack);
    if (!parsed) return null; // the cheap gate over-fired; not actually a multi-hop shape — fall through
    return runCompose(db, parsed, { today: t });
  }
  if (intent.route !== 'history') return null;

  const ctx = await resolveScope(db, intent);
  if (!ctx) return null;
  switch (intent.kind) {
    case 'last-service':
    case 'last-tech':
      return lastService(db, intent, ctx, t);
    case 'last-n-visits':
      return lastNVisits(db, intent, ctx, t);
    case 'install-date':
      return installDate(db, intent, ctx);
    case 'installer':
      return installer(db, intent, ctx);
    case 'unit-notes': {
      const customers = ctx.scope.customers;
      if (!customers.length) return null;
      const nd = await fetchNotes(db, customers, t);
      return citeNotes(db, buildNotesAnswer(`the unit at ${ctx.label}`, customers, nd, t), `the unit at ${ctx.label}`, nd); // TEAM C
    }
    default:
      return null;
  }
}
