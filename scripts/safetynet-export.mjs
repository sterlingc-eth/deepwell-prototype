#!/usr/bin/env node
/**
 * Export opted-in learning cases to donovan-training/v2loop/misses as miss_teach-style JSONL rows (question masked, no tenant/document ids, no personal data).
 *   DATABASE_URL=<owner role> node scripts/safetynet-export.mjs [--out donovan-training/v2loop/misses] [--mark]
 *   node scripts/safetynet-export.mjs --from cases.jsonl [--out dir]      (rows as dumped from donovan_learning_cases)
 * Only rows with export_ok = true (tenant listed in DONOVAN_LEARNING_OPTIN_TENANTS when the case was written) leave the tenant. --mark stamps exported_at.
 */
import fs from 'node:fs'; import path from 'node:path';
import { toMissTeachRow } from '../api/_lib/safetynet/cases.js';
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const out = arg('--out') || 'donovan-training/v2loop/misses';
let rows; let client = null;
if (arg('--from')) rows = fs.readFileSync(arg('--from'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
else {
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL (owner role) or pass --from <jsonl>.'); process.exit(2); }
  const { default: pg } = await import('pg'); client = new pg.Client({ connectionString: process.env.DATABASE_URL }); await client.connect();
  rows = (await client.query(`SELECT id, source, lane, stage, question, given, expected, doc_refs, export_ok FROM donovan_learning_cases WHERE export_ok AND exported_at IS NULL ORDER BY id`)).rows;
}
const ids = []; const lines = [];
for (const r of rows) { const row = toMissTeachRow(r, { salt: 'sn' }); if (row) { lines.push(JSON.stringify(row)); ids.push(r.id); } }
fs.mkdirSync(out, { recursive: true });
const file = path.join(out, `safetynet_${new Date().toISOString().slice(0, 10)}.jsonl`);
if (lines.length) fs.appendFileSync(file, lines.join('\n') + '\n');
if (client) { if (process.argv.includes('--mark') && ids.length) await client.query('UPDATE donovan_learning_cases SET exported_at = now() WHERE id = ANY($1::bigint[])', [ids]); await client.end(); }
console.log(`exported ${lines.length} of ${rows.length} case(s) to ${lines.length ? file : '(nothing written)'}`);
