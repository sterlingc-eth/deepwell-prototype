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

/* ------------------------------------------------------------------ warranty-alert */

async function explainWarrantyAlert(db, ctx, today) {
  const units = ctx.scope.equipment;
  if (!units.length) {
    return citeSearched(db, answerEnvelope({ text: `No units on file for ${ctx.label} to flag a warranty alert on.`, facts: [] }), [], { basis: `${ctx.label} has no equipment on file.` });
  }
  const parts = [];
  const facts = [];
  const unitIds = [];
  for (const u of units) {
    const stable = u.data?.warranty ?? null;
    const install = u.data?.installation_date ? humanDate(u.data.installation_date) : 'an unrecorded date';
    const name = brandModel(u);
    unitIds.push(u.id);
    if (!stable) {
      parts.push(`the ${name} (installed ${install}) has no warranty information on file at all — nothing to compute a status from`);
      facts.push({ label: name, value: 'No warranty information on file' });
      continue;
    }
    const desc = describeWarranty(stable, today);
    const tier = alertTier(stable, today);
    if (tier === 'ok') {
      parts.push(`the ${name} (installed ${install}) is NOT currently flagged — its warranty is active${stable.expires ? ` through ${humanDate(stable.expires)}` : ''}`);
      facts.push({ label: name, value: `Active${stable.expires ? ` through ${humanDate(stable.expires)}` : ''}` });
      continue;
    }
    if (tier === 'unknown') {
      parts.push(`the ${name} (installed ${install}) has no expiry or registration deadline on file, so its warranty status is unknown`);
      facts.push({ label: name, value: 'Unknown — no expiry or registration deadline on file' });
      continue;
    }
    const reasonByTier = {
      expired: `its parts warranty expired ${stable.expires ? `on ${humanDate(stable.expires)}` : 'already'}`,
      'expiring-30': `its parts warranty expires ${stable.expires ? `on ${humanDate(stable.expires)}` : 'within 30 days'} — soon`,
      'expiring-90': `its parts warranty expires ${stable.expires ? `on ${humanDate(stable.expires)}` : 'within 90 days'}`,
      'expiring-365': `its parts warranty expires ${stable.expires ? `on ${humanDate(stable.expires)}` : 'within the next year'}`,
      'unregistered-window-closing': `the registration window closes ${stable.registrationDeadline ? `on ${humanDate(stable.registrationDeadline)}` : 'soon'} and it has not been registered`,
    };
    parts.push(`the ${name} (installed ${install}) is flagged because ${reasonByTier[tier] ?? desc.action ?? 'of its warranty status'}${desc.action ? ` — ${desc.action}` : ''}`);
    facts.push({ label: name, value: desc.action ?? tier });
  }
  const text = `${ctx.label}: ${parts.join('; ')}.`;
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
  const text = `${ctx.label}'s last service visit was ${humanDate(top.date)} (${describeVisit(top)}): ${what}.${futureNote(future, today)}`;
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
    return attachCitations(answerEnvelope({
      text: `${ctx.label} needs a follow-up because a note on file says: "${reminder.value}".`,
      facts: [{ label: 'Reason', value: reminder.value, sources: [{ documentId: reminder.document_id, location: { field: 'reminder_text' } }] }],
    }), { records: await documentRecordsFor(db, [reminder.document_id]), total: 1, basis: `Read a follow-up note recorded on one of ${ctx.label}'s documents.` });
  }

  for (const u of ctx.scope.equipment) {
    const stable = u.data?.warranty ?? null;
    if (!stable) continue;
    const tier = alertTier(stable, today);
    if (tier === 'ok' || tier === 'unknown') continue;
    const desc = describeWarranty(stable, today);
    return attachCitations(answerEnvelope({
      text: `${ctx.label} needs a follow-up: the ${brandModel(u)}'s ${desc.action ?? 'warranty needs attention'}`,
      facts: [{ label: 'Reason', value: desc.action ?? tier }],
    }), { records: scopeUnitRecords([u]), total: 1, basis: `Checked ${ctx.label}'s equipment warranty status; the ${brandModel(u)} triggered a follow-up (${tier}).` });
  }

  const visits = await fetchVisits(db, ids);
  const { past } = splitFuture(visits, today);
  if (past.length) {
    const last = past[0];
    const cadence = pack?.maintenance?.defaultCadenceMonths ?? 12;
    const nextDue = addMonths(last.date, cadence);
    if (nextDue && nextDue < today) {
      return attachCitations(answerEnvelope({
        text: `${ctx.label} needs a follow-up: no service visit since ${humanDate(last.date)}, more than ${cadence} month${cadence === 1 ? '' : 's'} ago (overdue for maintenance).`,
        facts: [{ label: 'Last visit', value: humanDate(last.date), sources: [{ documentId: last.documentId, location: { field: 'service_date' } }] }],
      }), { records: await documentRecordsFor(db, [last.documentId]), total: 1, basis: `${ctx.label}'s last service visit (${humanDate(last.date)}) is more than ${cadence} months old.` });
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
