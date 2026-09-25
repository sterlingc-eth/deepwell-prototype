/**
 * trends.js — Team J (2026-09-25): deterministic period-over-period trend answers.
 *
 * Scorecard: trends 4/9 (R5_FAILS.md item 3). None of these questions ("did we do more service calls
 * last quarter than the quarter before", "which month had the most service calls this year") contain a
 * word agent/intents.js's own isReasoningQuestion gate looks for ("trend", "over time", "year-over-year"
 * ...), so they fell into the single-entity analytics planner (which has no notion of two periods to
 * compare) or retrieval. This file recognizes the closed set of period-over-period shapes this corpus's
 * question bank actually uses and answers with the two real counts, the change, and which documents/rows
 * they came from — no model call.
 *
 * METRICS:
 *   serviceCount  distinct (document, service_date) among service-type documents — "service calls",
 *                 "jobs", "service visits"
 *   invoiceSum    SUM(total) of receivable invoices (financeViews.js's own MONEY RULE) — "invoice(d)",
 *                 "invoiced revenue", "revenue"
 *   installCount  count of equipment whose installation year falls in the period — "install(ed) units"
 *
 * pure: parseTrends, periodBounds
 * db:   runTrends (a small number of bounded, tenant-scoped reads, no model call)
 */
import { TENANT_SQL, isoDate, humanDate, isVisitType, normalizeTypeId, answerEnvelope } from './scope.js';
import { installYearOf } from './analytics.js';
import { financialsTableExists } from './financials/store.js';
import { attachCitations } from './citations/records.js';
import { documentRecordsFor } from './citations/enrich.js';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/* ------------------------------------------------------------------ parse */

function detectMetric(q) {
  if (/\binvoice[ds]?\b|\binvoiced revenue\b|\brevenue\b/i.test(q)) return 'invoiceSum';
  if (/\binstall(?:ed)?\b[^.?]*\bunits?\b/i.test(q)) return 'installCount';
  if (/\bservice\s+(?:calls?|visits?)\b|\bjobs?\b/i.test(q)) return 'serviceCount';
  return null;
}

function detectGrain(q) {
  if (/\bquarter\b/i.test(q)) return 'quarter';
  if (/\byear\b/i.test(q)) return 'year';
  if (/\bmonth\b/i.test(q)) return 'month';
  return null;
}

const COMPARATIVE_RE = /\b(?:more|higher|up|greater|fewer|lower|down)\b/i;
const THAN_RE = /\b(?:than|compared\s+(?:to|with))\b/i;

/** Pure: question -> {kind:'compare', metric, grain} | {kind:'monthMax'|'monthSeries', metric} | null. */
export function parseTrends(question) {
  const q = String(question ?? '').trim();
  if (!q) return null;

  if (/\bwhich month\b/i.test(q) && /\bmost\b/i.test(q)) {
    const metric = detectMetric(q) ?? 'serviceCount';
    return { kind: 'monthMax', metric };
  }
  if (/\bhow (?:have|has)\b/i.test(q) && /\bmonthly\b/i.test(q) && /\bchanged\b/i.test(q)) {
    const metric = detectMetric(q) ?? 'serviceCount';
    return { kind: 'monthSeries', metric };
  }
  if (COMPARATIVE_RE.test(q) && THAN_RE.test(q)) {
    const metric = detectMetric(q);
    const grain = detectGrain(q);
    if (metric && grain) return { kind: 'compare', metric, grain };
  }
  return null;
}

/* ------------------------------------------------------------------ period arithmetic */

const pad2 = (n) => String(n).padStart(2, '0');

/** First day of the grain-period containing `iso`, as 'YYYY-MM-DD'. */
export function truncPeriod(iso, grain) {
  const [y, m] = iso.split('-').map(Number);
  if (grain === 'year') return `${y}-01-01`;
  if (grain === 'quarter') return `${y}-${pad2(Math.floor((m - 1) / 3) * 3 + 1)}-01`;
  return `${y}-${pad2(m)}-01`;
}

/** `iso` (a period start) shifted by `n` whole grains, as 'YYYY-MM-DD'. */
export function shiftPeriod(iso, grain, n) {
  const [y, m] = iso.split('-').map(Number);
  if (grain === 'year') return `${y + n}-01-01`;
  const months = grain === 'quarter' ? n * 3 : n;
  const total = y * 12 + (m - 1) + months;
  return `${Math.floor(total / 12)}-${pad2((((total % 12) + 12) % 12) + 1)}-01`;
}

/** The two most-recent full periods before today: [{from,to}, {from,to}] (to exclusive), newest first. */
export function periodBounds(today, grain) {
  const trunc = truncPeriod(today, grain);
  const p0from = shiftPeriod(trunc, grain, -1);
  const p1from = shiftPeriod(trunc, grain, -2);
  return [{ from: p0from, to: trunc }, { from: p1from, to: p0from }];
}

const periodLabel = (grain, from) => {
  if (grain === 'year') return from.slice(0, 4);
  if (grain === 'quarter') return `Q${Math.floor((Number(from.slice(5, 7)) - 1) / 3) + 1} ${from.slice(0, 4)}`;
  return `${MONTH_NAMES[Number(from.slice(5, 7)) - 1]} ${from.slice(0, 4)}`;
};

/* ------------------------------------------------------------------ db reads */

/** Every distinct (document, service_date) for a visit-type document, tenant-wide. Bounded, fetched once. */
async function fetchServiceDates(db) {
  const { rows } = await db.raw(
    `SELECT x.document_id, COALESCE(NULLIF(x.corrected_value, ''), x.value) AS service_date, d.document_type
       FROM extractions x JOIN documents d ON d.id = x.document_id
      WHERE x.field_key = 'service_date' AND x.${TENANT_SQL}
      LIMIT 20000`
  );
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const d = isoDate(r.service_date);
    if (!d || !isVisitType(normalizeTypeId(r.document_type))) continue;
    const key = `${r.document_id}|${d}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ documentId: r.document_id, date: d });
  }
  return out;
}

async function fetchInvoices(db) {
  if (!(await financialsTableExists(db))) return [];
  const { rows } = await db.raw(
    `SELECT document_id,
            (CASE WHEN corrections ? 'total' THEN NULLIF(corrections->>'total', '') ELSE total::text END)::numeric AS total,
            (CASE WHEN corrections ? 'invoice_date' THEN NULLIF(corrections->>'invoice_date', '') ELSE invoice_date::text END) AS invoice_date
       FROM document_financials
      WHERE doc_kind = 'invoice' AND direction = 'receivable' AND ${TENANT_SQL}
      LIMIT 20000`
  );
  return rows.map((r) => ({ documentId: r.document_id, date: isoDate(r.invoice_date), total: Number(r.total) || 0 })).filter((r) => r.date);
}

async function fetchInstalls(db) {
  const { rows } = await db.raw(
    `SELECT id, data->>'installation_date' AS installation_date
       FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT_SQL}
      LIMIT 20000`
  );
  return rows.map((r) => ({ documentId: r.id, year: installYearOf(r.installation_date) })).filter((r) => r.year != null);
}

const inRange = (d, from, to) => d >= from && d < to;

/** {value, docIds} for one metric within [from,to). */
function reduceMetric(metric, rows, from, to) {
  if (metric === 'installCount') {
    const hit = rows.filter((r) => `${r.year}-01-01` >= from && `${r.year}-01-01` < to);
    return { value: hit.length, docIds: hit.map((r) => r.documentId) };
  }
  const hit = rows.filter((r) => inRange(r.date, from, to));
  if (metric === 'invoiceSum') return { value: hit.reduce((s, r) => s + r.total, 0), docIds: hit.map((r) => r.documentId) };
  return { value: hit.length, docIds: hit.map((r) => r.documentId) }; // serviceCount
}

async function metricRows(db, metric) {
  if (metric === 'invoiceSum') return fetchInvoices(db);
  if (metric === 'installCount') return fetchInstalls(db);
  return fetchServiceDates(db);
}

const metricNoun = (metric) => (metric === 'invoiceSum' ? 'invoiced' : metric === 'installCount' ? 'unit(s) installed' : 'service call(s)');
const fmtValue = (metric, v) => (metric === 'invoiceSum' ? `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : String(v));

/* ------------------------------------------------------------------ handlers */

async function runCompare(db, intent, today) {
  const rows = await metricRows(db, intent.metric);
  const [p0, p1] = periodBounds(today, intent.grain);
  const a = reduceMetric(intent.metric, rows, p0.from, p0.to);
  const b = reduceMetric(intent.metric, rows, p1.from, p1.to);
  const up = a.value > b.value;
  const flat = a.value === b.value;
  const noun = metricNoun(intent.metric);
  const l0 = periodLabel(intent.grain, p0.from);
  const l1 = periodLabel(intent.grain, p1.from);
  const text = flat
    ? `No — ${l0} and ${l1} both had ${fmtValue(intent.metric, a.value)} ${noun} on file.`
    : `${up ? 'Yes' : 'No'} — ${l0} had ${fmtValue(intent.metric, a.value)} ${noun}, vs ${fmtValue(intent.metric, b.value)} in ${l1}.`;
  const facts = [
    { label: l0, value: fmtValue(intent.metric, a.value) },
    { label: l1, value: fmtValue(intent.metric, b.value) },
  ];
  const docIds = [...new Set([...a.docIds, ...b.docIds])].slice(0, 40);
  const records = intent.metric === 'installCount'
    ? [] // equipment, not documents — no document records to cite; the counts themselves are the basis
    : await documentRecordsFor(db, docIds);
  return attachCitations(answerEnvelope({ text, facts }), {
    records, total: a.docIds.length + b.docIds.length,
    basis: `Counted ${noun} in ${l0} (${a.docIds.length}) and ${l1} (${b.docIds.length}), by ${intent.metric === 'invoiceSum' ? 'invoice date' : intent.metric === 'installCount' ? 'installation year' : 'service date'}.`,
  });
}

async function runMonthMax(db, intent, today) {
  const rows = await metricRows(db, intent.metric);
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const yearEnd = `${Number(today.slice(0, 4)) + 1}-01-01`;
  const counts = Array.from({ length: 12 }, (_, i) => reduceMetric(intent.metric, rows, `${today.slice(0, 4)}-${pad2(i + 1)}-01`, i === 11 ? yearEnd : `${today.slice(0, 4)}-${pad2(i + 2)}-01`));
  const max = Math.max(...counts.map((c) => c.value));
  const winners = counts.map((c, i) => ({ i, c })).filter((x) => x.c.value === max && max > 0);
  if (!winners.length) {
    return { ...answerEnvelope({ text: `No ${metricNoun(intent.metric)} are on file for this year yet.`, facts: [] }), kind: 'no-answer', confidence: 0 };
  }
  const names = winners.map((w) => MONTH_NAMES[w.i]);
  const text = `${names.join(' and ')} had the most ${metricNoun(intent.metric)} this year, with ${fmtValue(intent.metric, max)}.`;
  const docIds = winners.flatMap((w) => counts[w.i].docIds).slice(0, 40);
  return attachCitations(answerEnvelope({ text, facts: [{ label: 'Month', value: names.join(' and ') }, { label: 'Count', value: String(max) }] }), {
    records: intent.metric === 'installCount' ? [] : await documentRecordsFor(db, docIds), total: max,
    basis: `Counted ${metricNoun(intent.metric)} by calendar month for ${today.slice(0, 4)} (${yearStart} through the end of the year).`,
  });
}

async function runMonthSeries(db, intent, today) {
  const rows = await metricRows(db, intent.metric);
  const year = today.slice(0, 4);
  const yearEnd = `${Number(year) + 1}-01-01`;
  const counts = Array.from({ length: 12 }, (_, i) => reduceMetric(intent.metric, rows, `${year}-${pad2(i + 1)}-01`, i === 11 ? yearEnd : `${year}-${pad2(i + 2)}-01`).value);
  const monthsWithData = counts.map((v, i) => ({ i, v })).filter((_, i) => `${year}-${pad2(i + 1)}-01` <= today);
  const list = monthsWithData.map((m) => `${MONTH_NAMES[m.i]}: ${fmtValue(intent.metric, m.v)}`).join('; ');
  let direction = 'flat';
  if (monthsWithData.length >= 2) {
    const first = monthsWithData[0].v;
    const last = monthsWithData[monthsWithData.length - 1].v;
    direction = last > first ? 'trending up' : last < first ? 'trending down' : 'flat';
  }
  const text = `${year} by month: ${list || 'no data yet'}. Overall, ${metricNoun(intent.metric)} this year are ${direction} (comparing ${monthsWithData[0] ? MONTH_NAMES[monthsWithData[0].i] : 'the first'} to the most recent month).`;
  return attachCitations(answerEnvelope({ text, facts: monthsWithData.map((m) => ({ label: MONTH_NAMES[m.i], value: fmtValue(intent.metric, m.v) })) }), {
    records: [], total: monthsWithData.reduce((s, m) => s + m.v, 0),
    basis: `Counted ${metricNoun(intent.metric)} for each month of ${year} through today (${humanDate(today)}).`,
  });
}

/* ------------------------------------------------------------------ entry */

export async function runTrends(db, intent, { today } = {}) {
  const t = isoDate(today) ?? new Date().toISOString().slice(0, 10);
  if (intent.kind === 'compare') return runCompare(db, intent, t);
  if (intent.kind === 'monthMax') return runMonthMax(db, intent, t);
  if (intent.kind === 'monthSeries') return runMonthSeries(db, intent, t);
  return null;
}

export async function classifyAndRunTrends(db, question, { today } = {}) {
  const intent = parseTrends(question);
  if (!intent) return null;
  return runTrends(db, intent, { today });
}
