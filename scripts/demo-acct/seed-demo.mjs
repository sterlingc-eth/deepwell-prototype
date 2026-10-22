#!/usr/bin/env node
/**
 * Load the Wave 1 sample paperwork into the demo companies on STAGING (later: production, after Sterling approves),
 * through DeepWell's normal upload and reading pipeline: it runs the staff import tool (scripts/import/deepwell-import.mjs)
 * once per industry, which asks /api/upload-url for upload links, sends each file straight to storage and asks
 * /api/read-document to read it - exactly what the app does for a customer's files. No fact is written directly.
 *
 *   node scripts/demo-acct/seed-demo.mjs --docs "<folder with realestate/ propmgmt/ hvac/ ...>" --base-url https://staging.deepwelltechnology.com [--only hvac,plumbing] [--dry-run]
 *
 * One import key per demo company, each created by Sterling in that company while D1's loading window is open
 * (Billing > API access, scopes: ingest, read, ask), and given ONLY through environment variables he sets himself:
 *   DEEPWELL_DEMO_KEY_REALESTATE  DEEPWELL_DEMO_KEY_PROPMGMT  DEEPWELL_DEMO_KEY_HVAC
 *   DEEPWELL_DEMO_KEY_PLUMBING    DEEPWELL_DEMO_KEY_ELECTRICAL  DEEPWELL_DEMO_KEY_CONTRACTORS
 * Keys are never accepted on the command line, never printed and never written to a file (the import tool's own rule).
 * Safe to run again: files DeepWell already has are skipped (same file = same document), and each industry resumes from
 * its progress file (<docs>/<industry>/.import-progress.jsonl).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOL = path.join(ROOT, 'scripts/import/deepwell-import.mjs');
export const WAVE1 = ['realestate', 'propmgmt', 'hvac', 'plumbing', 'electrical', 'contractors'];

function parse(argv) {
  const o = { docs: null, baseUrl: null, only: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (/dw_live_/i.test(a) || /^--(key|token|secret)/i.test(a)) throw new Error('Keys are never typed on the command line. Set DEEPWELL_DEMO_KEY_<INDUSTRY> environment variables instead.');
    if (a === '--docs') o.docs = argv[++i];
    else if (a === '--base-url') o.baseUrl = argv[++i];
    else if (a === '--only') o.only = String(argv[++i]).split(',');
    else if (a === '--dry-run') o.dryRun = true;
    else throw new Error(`Unknown option ${a}`);
  }
  if (!o.docs) throw new Error('--docs <folder> is required (the folder that holds realestate/, propmgmt/, hvac/ ...).');
  if (!o.dryRun && !o.baseUrl) throw new Error('--base-url is required (the STAGING address first).');
  return o;
}

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TOOL, ...args], { env, stdio: 'inherit' });
    child.on('close', resolve);
  });
}

async function main() {
  let o;
  try { o = parse(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  const results = [];
  for (const slug of WAVE1) {
    if (o.only && !o.only.includes(slug)) continue;
    const folder = path.join(o.docs, slug, 'files');
    if (!fs.existsSync(folder)) { console.error(`${slug}: no folder ${folder}`); results.push({ slug, code: 2 }); continue; }
    const keyVar = `DEEPWELL_DEMO_KEY_${slug.toUpperCase()}`;
    const env = { ...process.env };
    for (const s of WAVE1) delete env[`DEEPWELL_DEMO_KEY_${s.toUpperCase()}`];
    if (!o.dryRun) {
      if (!process.env[keyVar]) { console.error(`${slug}: ${keyVar} is not set - skipped.`); results.push({ slug, code: 2 }); continue; }
      env.DEEPWELL_IMPORT_KEY = process.env[keyVar];
    }
    console.log(`\n=== ${slug} ===`);
    const state = path.join(o.docs, slug, '.import-progress.jsonl');
    const args = ['--folder', folder, '--state', state, ...(o.dryRun ? ['--dry-run'] : ['--base-url', o.baseUrl, '--yes', '--watch-reading'])];
    results.push({ slug, code: await run(args, env) });
  }
  console.log('\nSummary:');
  for (const r of results) console.log(`  ${r.slug.padEnd(12)} ${r.code === 0 ? 'done' : `exit ${r.code} (run again to resume)`}`);
  console.log('\nNext: node scripts/demo-acct/qa-staging.mjs (same keys) - then paste M3-config/demo/D2-finish-seeding.sql.');
  process.exit(results.every((r) => r.code === 0) ? 0 : 1);
}
main();
