#!/usr/bin/env node
/**
 * Owner view of real production precision: audit disagreement rate and flag rate.
 *   DATABASE_URL=<owner role that bypasses RLS> node scripts/safetynet-stats.mjs [--days 30]      (reads the tables directly; the URL is read from the environment only)
 *   node scripts/safetynet-stats.mjs --json stats.json                                              (a saved safetyNetStats response)
 * Operator-only: shows audit cost, which is never shown to customers.
 */
import fs from 'node:fs';
import { summarize } from '../api/_lib/safetynet/store.js';
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const days = Number(arg('--days')) || 30;
let s;
if (arg('--json')) { const j = JSON.parse(fs.readFileSync(arg('--json'), 'utf8')); s = j.stats ?? j; }
else {
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL (owner role) or pass --json <file>.'); process.exit(2); }
  const { default: pg } = await import('pg'); const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  const q = (t, p = []) => c.query(t, p).then((r) => r.rows);
  const iv = String(days);
  const audits = await q(`SELECT lane, count(*)::int audited, count(*) FILTER (WHERE verdict='agree')::int agree, count(*) FILTER (WHERE verdict='disagree')::int disagree, count(*) FILTER (WHERE verdict='unsure')::int unsure, count(*) FILTER (WHERE forced)::int forced, COALESCE(sum(cost_micro_usd),0)::bigint cost_micro_usd FROM donovan_audits WHERE created_at > now() - ($1||' days')::interval GROUP BY lane`, [iv]);
  const cases = await q(`SELECT source, count(*)::int n FROM donovan_learning_cases WHERE created_at > now() - ($1||' days')::interval GROUP BY source`, [iv]);
  const alone = (await q(`SELECT count(*)::int n FROM audit_log WHERE action='document.queried' AND created_at > now() - ($1||' days')::interval AND (changes->>'valuereader'='true' OR changes->>'docrecord'='true')`, [iv]))[0]?.n ?? null;
  await c.end(); s = summarize({ audits, cases, aloneAnswers: alone, days });
}
const pct = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
console.log(`Donovan safety net, last ${s.days} days\n  alone answers: ${s.aloneAnswers ?? 'n/a'}   audited: ${s.audited} (forced low-confidence: ${s.forcedAudits})\n  agree ${s.agree} / disagree ${s.disagree} / unsure ${s.unsure}\n  sampled precision: ${pct(s.sampledPrecision)}   audit disagreement rate: ${pct(s.disagreementRate)}\n  customer reports: ${s.reports}   flag rate (reports+disagreements per alone answer): ${pct(s.flagRate)}\n  learning cases: ${JSON.stringify(s.cases)}\n  audit spend: $${Number(s.auditCostUsd).toFixed(4)}`);
