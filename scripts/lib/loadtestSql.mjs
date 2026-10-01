/**
 * R37 load-test helpers: read the three owner-pasted files in M3-config/loadtest/ and, for the quick PGlite check,
 * scale the seed down by rewriting its single size line ("SELECT 50000 AS n"). The SQL itself is run unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './r35Harness.mjs';

export const LOADTEST_TENANT = '10ad7e57-0000-4000-8000-000000000050';
export const LOADTEST_DIR = path.join(ROOT, 'M3-config', 'loadtest');
const SLICE = 5000; // L1's c_slice
export const FILES = {
  L1: 'L1-seed-50k-test-company.sql',
  L2: 'L2-time-the-50k-company.sql',
  L3: 'L3-remove-test-company.sql',
};

/** The file's text. For L1, `docs` replaces the 50000 on the size line (the one number the file tells the owner to change). */
export function loadtestSql(which, { docs = null } = {}) {
  let sql = fs.readFileSync(path.join(LOADTEST_DIR, FILES[which]), 'utf8');
  if (which === 'L1' && docs != null && Number(docs) !== 50000) {
    if (!/SELECT 50000 AS n/.test(sql)) throw new Error('L1 no longer has its "SELECT 50000 AS n" size line');
    sql = sql.replace('SELECT 50000 AS n', `SELECT ${Math.trunc(Number(docs))} AS n`);
  }
  return sql;
}

/**
 * Runs one file and returns { seconds, rows } where rows are the last statement's result table. `segments` runs the file one
 * "-- ---- " section at a time (each its own transaction) instead of as a single script: the owner's editor and psql handle one
 * long transaction fine, but PGlite (Postgres compiled to WebAssembly, one process, 2 GB of memory) panics or stalls when a
 * 50,000-document seed is a single transaction (and the seed's own 5,000-document slices are then run as separate transactions
 * too, by pointing its slice loop at one slice at a time). The SQL text run is the same either way.
 */
export async function runFile(lite, which, { docs = null, segments = false } = {}) {
  const sql = loadtestSql(which, { docs });
  const t0 = process.hrtime.bigint();
  let last = [];
  if (segments) {
    for (const part of sql.split(/\n(?=-- ---- )/)) {
      if (/DO \$docs\$/.test(part)) {
        const total = Math.trunc(Number(docs ?? 50000));
        for (let lo = 1; lo <= total; lo += SLICE) {
          const one = part.replace('v_lo int := 1;', `v_lo int := ${lo};`)
            .replace("SELECT (settings->>'docs')::int INTO v_total", `SELECT least((settings->>'docs')::int, ${lo + SLICE - 1}) INTO v_total`);
          if (one === part && lo > 1) throw new Error('L1 slice loop changed shape; update scripts/lib/loadtestSql.mjs');
          await lite.exec(one);
        }
        continue;
      }
      const r = await lite.exec(part);
      if (r.length) last = r;
    }
  } else {
    last = await lite.exec(sql);
  }
  const seconds = Number(process.hrtime.bigint() - t0) / 1e9;
  return { seconds, rows: last[last.length - 1]?.rows ?? [], all: last };
}

/** Expected seeded sizes for a given document count (mirrors the arithmetic on L1's settings line). */
export const expectedSizes = (docs) => ({ documents: docs, customers: Math.trunc((docs * 12) / 100), units: Math.trunc((docs * 18) / 100) });
