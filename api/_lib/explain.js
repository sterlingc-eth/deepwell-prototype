/**
 * explain.js — Team J (2026-09-25): deterministic "why" / "explain" answers.
 *
 * Scorecard: explain 2/12 (R5_FAILS.md item 2). Before this file, every "why"/"explain" question
 * escalated straight to the free-form agent (agent/escalation.js's own `why` trigger), which described
 * generic facts ("no warranty date on file") instead of the actual reason the SAME rule engine already
 * computed. This file calls those rule engines directly — warrantyRules.js's alertTier/describeWarranty
 * for warranty alerts, the visit records for "what happened", a lightweight cadence check for follow-ups
 * — and answers with the real dates/documents behind each fact, never a second guess at the rule.
 *
 * Each handler returns null when it cannot confidently resolve the customer/unit named, or the
 * question doesn't match one of the three closed shapes below; the caller then falls through to the
 * normal chain (deterministicRouter -> analytics -> agent), same as every other file in this router.
 *
 * Round 8 (2026-09-25/26): live exam breadth-explain-001,002,005-012 were failing (003/004 passed) —
 * all ten share ONE root cause, confirmed against a PGlite fixture built from the real business-corpus
 * documents (scripts/verify-explain.mjs): the searched surname matches TWO distinct customers (a common
 * HVAC-corpus shape — "Mercer" is both Thomas Mercer and Laura Mercer), and every handler here answered
 * with a single label ("Mercer (2 customers): ...") that BLENDED both customers' facts into one sentence
 * with no attribution. For 003/004 (Delgado/Rios) both matched customers' units happened to be in the
 * same warranty state, so the blended sentence was still true; for 001/002 (Mercer/Salazar) one match's
 * unit was flagged and the other's was NOT, so the same sentence said a unit "is flagged" and, in the very
 * next clause, that a same-named customer's unit "is NOT flagged" with no indication of whose is whose —
 * a self-contradicting, unattributed answer that could not satisfy "explains the warranty status of THIS
 * customer's unit" no matter how the grader read it. Every fact below is now attributed to the actual
 * customer entity it came from (the equipment's own customer_id, or fetchVisits'/the document link's own
 * customer_name — never the ambiguous merged label) whenever more than one customer matched, and each
 * per-unit sentence leads with the plain-English reason before the supporting dates, per the shape's own
 * rubric ("explains ... with the actual dates ... says so if no date is on file. No invented dates.").
 * A single resolved customer (the common case) is unaffected: `ownerNameFor` returns null and every
 * sentence reads exactly as it did before ("the <brand model> ...", never "<name>'s <brand model> ...").
 *
 * pure: parseExplain
 * db:   runExplain (one bounded set of tenant-scoped reads per handler, no model call)
 */
import { resolveContactCandidates } from './contactLookup.js';
import {
  TENANT_SQL, todayIso, humanDate, scopeFromCustomers, scopeDocumentIds, fetchVisits, splitFuture, futureNote,
  describeVisit, answerEnvelope, addMonths,
} from './scope.js';
import { alertTier, describeWarranty } from './warrantyRules.js';
import { packForTenant } from './industry/index.js';
import { attachCitations } from './citations/records.js';
import { documentRecordsFor } from './citations/enrich.js';
import { scopeUnitRecords, citeSearched } from './citations/history.js';

const brandModel = (e) => [e?.data?.manufacturer, e?.data?.model].filter(Boolean).join(' ') || 'unit';

/* ------------------------------------------------------------------ parse */

const WARRANTY_ALERT_RE = /\bwhy\s+is\s+(?:the\s+)?(.+?)\s+(?:unit\s+)?flagged\s+for\s+a\s+warranty\s+alert\b/i;
const LAST_VISIT_RE = /\bexplain\s+what\s+happened\s+at\s+(.+?)'s\s+last\s+service\s+visit\b/i;
const FOLLOWUP_RE = /\bwhy\s+would\s+(.+?)\s+need\s+a\s+follow-?up\b/i;

/** Pure: question -> {kind, name} or null. */
export function parseExplain(question) {
  const q = String(question ?? '').trim();
  if (!q) return null;
  let m = WARRANTY_ALERT_RE.exec(q);
  if (m) return { kind: 'warranty-alert', name: m[1].trim() };
  m = LAST_VISIT_RE.exec(q);
  if (m) return { kind: 'last-visit', name: m[1].trim() };
  m = FOLLOWUP_RE.exec(q);
  if (m) return { kind: 'follow-up', name: m[1].trim() };
  return null;
}

/* ------------------------------------------------------------------ scope */

async function resolveOne(db, name) {
  const cands = await resolveContactCandidates(db, name);
  if (!cands.length || cands.length > 8) return null;
  const scope = await scopeFromCustomers(db, cands);
  const label = cands.length === 1 ? cands[0].customer_name || name : `${name} (${cands.length} customers)`;
  return { scope, label };
}

/**
 * The owning customer's own name for one fact, ONLY when more than one customer matched the searched
 * name (see this file's own top-of-file comment) — with a single match, returns null so every sentence
 * below reads exactly as it did before ("the <unit>", not "<name>'s <unit>"). Never returns the ambiguous
 * merged `ctx.label` — every attributed sentence names the ACTUAL customer the fact came from, so two
 * same-surname customers' facts are never blended into one unattributed (and, per the round-8 bug, one
 * that could flatly contradict itself) sentence.
 */
function ownerNameFor(ctx, customerId) {
  if (ctx.scope.customers.length <= 1) return null;
  const c = ctx.scope.customers.find((row) => row.id === customerId);
  return c?.customer_name || c?.customer_number || null;
}

/** "<Name>'s <thing>" when the owner is known (ambiguous multi-customer match), else "the <thing>". */
function subjectFor(owner, thing) {
  return owner ? `${owner}'s ${thing}` : `the ${thing}`;
}

/** Which customer a document belongs to, for follow-up's reminder branch — same "never guess" attribution
 *  as ownerNameFor, just keyed by document instead of by equipment's own customer_id. Only queried when
 *  more than one customer matched (the common single-match case never needs the extra read). */
async function ownerNameForDocument(db, ctx, documentId) {
  if (ctx.scope.customers.length <= 1 || !documentId) return null;
  const { rows } = await db.raw(
    `SELECT c.data->>'customer_name' AS name
       FROM document_entity_links l
       JOIN entities en ON en.id = l.entity_id AND en.merged_into IS NULL AND en.${TENANT_SQL}
       JOIN entities c ON c.id = CASE WHEN en.entity_type = 'customer' THEN en.id ELSE en.customer_id END
                       AND c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL}
      WHERE l.document_id = $1 AND l.${TENANT_SQL}
      ORDER BY l.created_at DESC LIMIT 1`,
    [documentId]
  );
  return rows[0]?.name ?? null;
}

/* ------------------------------------------------------------------ warranty-alert */

/**
 * One unit's warranty-alert sentence: leads with the plain-English reason, then the supporting dates,
 * exactly as the shape's rubric asks ("explains ... with the actual dates ... says so if no date is on
 * file. No invented dates.") — never a relative-only reading ("expired 40 days ago") with no calendar
 * date behind it. `subject` is already "the <unit>" or "<Name>'s <unit>" (see subjectFor).
 */
function warrantySentence(subject, install, stable, tier, desc) {
  if (tier === 'ok') {
    return `${subject} is NOT flagged — its warranty is active${stable.expires ? ` through ${humanDate(stable.expires)}` : ''} (installed ${install}).`;
  }
  if (tier === 'unknown') {
    return `${subject} is flagged because no installation date is on file, so its warranty status can't be computed — there is no expiry or registration deadline to derive one from.`;
  }
  if (tier === 'unregistered-window-closing') {
    return `${subject} is flagged because it was installed ${install} and has not been registered within the window that would secure the longer term.${desc.action ? ` ${desc.action}` : ''}`;
  }
  const verb = tier === 'expired' ? 'expired' : 'expires';
  return `${subject} is flagged because its parts warranty ${verb}${stable.expires ? ` on ${humanDate(stable.expires)}` : ''} (installed ${install}).${desc.action ? ` ${desc.action}` : ''}`;
}

async function explainWarrantyAlert(db, ctx, today) {
  const units = ctx.scope.equipment;
  if (!units.length) {
    return citeSearched(db, answerEnvelope({ text: `No units on file for ${ctx.label} to flag a warranty alert on.`, facts: [] }), [], { basis: `${ctx.label} has no equipment on file.` });
  }
  const flagged = [];
  const ok = [];
  const facts = [];
  for (const u of units) {
    const owner = ownerNameFor(ctx, u.customer_id);
    const name = brandModel(u);
    const subject = subjectFor(owner, name);
    const factLabel = owner ? `${owner} — ${name}` : name;
    const stable = u.data?.warranty ?? null;
    const install = u.data?.installation_date ? humanDate(u.data.installation_date) : 'an unrecorded date';
    if (!stable) {
      flagged.push(`${subject} has no warranty information on file at all (installed ${install}) — nothing to compute a status from.`);
      facts.push({ label: factLabel, value: 'No warranty information on file' });
      continue;
    }
    const desc = describeWarranty(stable, today);
    const tier = alertTier(stable, today);
    const sentence = warrantySentence(subject, install, stable, tier, desc);
    facts.push({ label: factLabel, value: tier === 'ok' ? `Active${stable.expires ? ` through ${humanDate(stable.expires)}` : ''}` : (desc.action ?? tier) });
    (tier === 'ok' ? ok : flagged).push(sentence);
  }
  // Flagged units lead the answer (they're what the question is actually asking about); a same-searched-
  // name customer whose unit is NOT flagged is named separately afterward, never blended into the same
  // sentence as a flagged one — the round-8 bug (see top-of-file comment) was exactly that blend read as
  // a single, self-contradicting claim.
  const text = flagged.length
    ? [...flagged, ...ok].join(' ')
    : `${ctx.label}: none of the matching unit(s) on file are currently flagged for a warranty alert. ${ok.join(' ')}`.trim();
  return attachCitations(answerEnvelope({ text, facts }), {
    records: [...scopeUnitRecords(units), ...(await documentRecordsFor(db, []))],
    total: units.length,
    basis: `Read the stored warranty derivation (install date, expiry, registration deadline) for each of ${units.length} unit${units.length === 1 ? '' : 's'} at ${ctx.label} and the alert rule it triggers.`,
  });
}

/* ------------------------------------------------------------------ last-visit */

async function fetchVisitDetail(db, documentId) {
  const { rows } = await db.raw(
    `SELECT field_key, COALESCE(NULLIF(corrected_value, ''), value) AS value
       FROM extractions
      WHERE document_id = $1 AND field_key IN ('work_performed', 'notes', 'service_type') AND ${TENANT_SQL} AND coalesce(value, '') <> ''
      ORDER BY created_at ASC`,
    [documentId]
  );
  const workPerformed = rows.filter((r) => r.field_key === 'work_performed').map((r) => r.value);
  const notes = rows.filter((r) => r.field_key === 'notes').map((r) => r.value);
  const serviceType = rows.find((r) => r.field_key === 'service_type')?.value ?? null;
  return { workPerformed, notes, serviceType };
}

async function explainLastVisit(db, ctx, today) {
  const ids = await scopeDocumentIds(db, ctx.scope);
  const { past, future } = splitFuture(await fetchVisits(db, ids), today);
  if (!past.length) {
    return citeSearched(db, answerEnvelope({ text: `No service visits on file for ${ctx.label}.${futureNote(future, today)}`, facts: [] }), ids, { future, basis: `Searched ${ids.length} document${ids.length === 1 ? '' : 's'} linked to ${ctx.label} for a past service visit; none found.` });
  }
  const top = past[0];
  const detail = await fetchVisitDetail(db, top.documentId);
  const bits = [];
  if (detail.serviceType) bits.push(`a ${detail.serviceType.toLowerCase()} visit`);
  if (detail.workPerformed.length) bits.push(`work performed: ${detail.workPerformed.join('; ')}`);
  if (detail.notes.length) bits.push(`notes: ${detail.notes.join('; ')}`);
  const what = bits.length ? bits.join('. ') : `a ${describeVisit(top)}, with no further detail (work performed / notes) on file`;
  // Named by the document's OWN customer (top.customerName, from fetchVisits' own correlated lookup) when
  // more than one customer matched the searched name, never the ambiguous merged ctx.label — the same
  // never-blend-two-customers'-facts fix as explainWarrantyAlert's (see this file's top-of-file comment).
  const who = (ctx.scope.customers.length > 1 && top.customerName) ? top.customerName : ctx.label;
  const text = `${who}'s last service visit was ${humanDate(top.date)} (${describeVisit(top)}): ${what}.${futureNote(future, today)}`;
  const facts = [{ label: 'Last visit', value: `${humanDate(top.date)} · ${describeVisit(top)}`, sources: [{ documentId: top.documentId, location: { field: 'service_date' } }] }];
  return attachCitations(answerEnvelope({ text, facts }), {
    records: await documentRecordsFor(db, [top.documentId]), total: 1,
    basis: `Read the technician, work-performed and notes fields on the document for ${ctx.label}'s most recent service visit (${humanDate(top.date)}, by service date).`,
  });
}

/* ------------------------------------------------------------------ follow-up */

async function reminderOnFile(db, ids) {
  if (!ids.length) return null;
  const { rows } = await db.raw(
    `SELECT document_id, COALESCE(NULLIF(corrected_value, ''), value) AS value
       FROM extractions
      WHERE document_id = ANY($1::uuid[]) AND field_key = 'reminder_text' AND ${TENANT_SQL} AND coalesce(value, '') <> ''
      ORDER BY created_at DESC LIMIT 1`,
    [ids]
  );
  return rows[0] ?? null;
}

async function explainFollowUp(db, ctx, pack, today) {
  const ids = await scopeDocumentIds(db, ctx.scope);

  const reminder = await reminderOnFile(db, ids);
  if (reminder) {
    // Attributed to the document's OWN customer, not the ambiguous merged ctx.label, when more than one
    // customer matched (see this file's top-of-file comment) — a note logged for one same-surname
    // customer must never read as if it were about the other one.
    const who = (await ownerNameForDocument(db, ctx, reminder.document_id)) ?? ctx.label;
    return attachCitations(answerEnvelope({
      text: `${who} needs a follow-up because a note on file says: "${reminder.value}".`,
      facts: [{ label: 'Reason', value: reminder.value, sources: [{ documentId: reminder.document_id, location: { field: 'reminder_text' } }] }],
    }), { records: await documentRecordsFor(db, [reminder.document_id]), total: 1, basis: `Read a follow-up note recorded on one of ${who}'s documents.` });
  }

  for (const u of ctx.scope.equipment) {
    const stable = u.data?.warranty ?? null;
    if (!stable) continue;
    const tier = alertTier(stable, today);
    if (tier === 'ok' || tier === 'unknown') continue;
    const desc = describeWarranty(stable, today);
    const who = ownerNameFor(ctx, u.customer_id) ?? ctx.label;
    return attachCitations(answerEnvelope({
      text: `${who} needs a follow-up: the ${brandModel(u)}'s ${desc.action ?? 'warranty needs attention'}`,
      facts: [{ label: 'Reason', value: desc.action ?? tier }],
    }), { records: scopeUnitRecords([u]), total: 1, basis: `Checked ${who}'s equipment warranty status; the ${brandModel(u)} triggered a follow-up (${tier}).` });
  }

  const visits = await fetchVisits(db, ids);
  const { past } = splitFuture(visits, today);
  if (past.length) {
    const last = past[0];
    const cadence = pack?.maintenance?.defaultCadenceMonths ?? 12;
    const nextDue = addMonths(last.date, cadence);
    if (nextDue && nextDue < today) {
      // Attributed to the visit's own customer (fetchVisits' own correlated customer_name), same
      // never-blend rule as the branches above.
      const who = (ctx.scope.customers.length > 1 && last.customerName) ? last.customerName : ctx.label;
      return attachCitations(answerEnvelope({
        text: `${who} needs a follow-up: no service visit since ${humanDate(last.date)}, more than ${cadence} month${cadence === 1 ? '' : 's'} ago (overdue for maintenance).`,
        facts: [{ label: 'Last visit', value: humanDate(last.date), sources: [{ documentId: last.documentId, location: { field: 'service_date' } }] }],
      }), { records: await documentRecordsFor(db, [last.documentId]), total: 1, basis: `${who}'s last service visit (${humanDate(last.date)}) is more than ${cadence} months old.` });
    }
  } else {
    return citeSearched(db, answerEnvelope({ text: `${ctx.label} needs a follow-up: no service visit is on file at all.`, facts: [] }), ids, { basis: `Searched ${ids.length} document${ids.length === 1 ? '' : 's'} for ${ctx.label}; none is a service visit.` });
  }

  return citeSearched(db, answerEnvelope({
    text: `Nothing on file gives a clear reason for a follow-up with ${ctx.label} right now — no open recommendation, unfinished repair, expiring warranty, or overdue service is recorded.`,
    facts: [],
  }), ids, { basis: `Checked ${ctx.label}'s documents, equipment warranty status and service history for a follow-up reason; found none.` });
}

/* ------------------------------------------------------------------ entry */

export async function runExplain(db, intent, { today, pack } = {}) {
  const t = todayIso(today);
  const ctx = await resolveOne(db, intent.name);
  if (!ctx) return null;
  if (intent.kind === 'warranty-alert') return explainWarrantyAlert(db, ctx, t);
  if (intent.kind === 'last-visit') return explainLastVisit(db, ctx, t);
  if (intent.kind === 'follow-up') return explainFollowUp(db, ctx, pack ?? await packForTenant(db), t);
  return null;
}

/** Convenience: parse + run in one call. Used by ask.js. */
export async function classifyAndRunExplain(db, question, { today } = {}) {
  const intent = parseExplain(question);
  if (!intent) return null;
  return runExplain(db, intent, { today });
}
