#!/usr/bin/env node
/**
 * Builds the base64 upload bundle(s) for scripts/browser-ingest.js, for
 * either the 61-doc synthetic corpus (test-docs/synthetic/) or the 600-doc
 * business corpus (test-docs/business/). Generalizes the one-off snippet in
 * handoffs/LIMIT_TEST_PLAN_2026-09-20.md's Step 1 by chunking output so no
 * single file exceeds 8 MB (the business corpus is well under that as a
 * whole, but this keeps the tool correct if the corpus grows).
 *
 * Usage:
 *   node scripts/build-bundle.mjs test-docs/business
 *   node scripts/build-bundle.mjs test-docs/synthetic
 *   node scripts/build-bundle.mjs                 (defaults to test-docs/business)
 *
 * Writes <dir>/bundle.json when it fits in one file, or
 * <dir>/bundle.1.json, <dir>/bundle.2.json, ... plus <dir>/bundle-manifest.json
 * (chunk count + per-chunk file counts/bytes) when it doesn't.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MAX_CHUNK_BYTES = 8 * 1024 * 1024; // 8 MB budget per the brief

const argDir = process.argv[2] ?? 'test-docs/business';
const dir = path.isAbsolute(argDir) ? argDir : path.join(ROOT, argDir);

if (!fs.existsSync(dir)) {
  console.error(`No such directory: ${dir}`);
  process.exit(1);
}

const mimeFor = (f) => (f.endsWith('.pdf') ? 'application/pdf' : 'text/plain');

const names = fs.readdirSync(dir)
  .filter((f) => (f.endsWith('.pdf') || f.endsWith('.txt')) && f !== 'ANSWER_KEY.json')
  .sort();

const files = names.map((name) => ({
  name,
  mime: mimeFor(name),
  base64: fs.readFileSync(path.join(dir, name)).toString('base64'),
}));

// Clean any stale bundle files from a previous run/shape before writing.
for (const f of fs.readdirSync(dir)) {
  if (/^bundle(\.\d+)?\.json$/.test(f) || f === 'bundle-manifest.json') fs.rmSync(path.join(dir, f), { force: true });
}

// Greedily pack files into chunks under the byte budget, measuring the
// actual JSON.stringify size of each candidate chunk (not just summed base64
// lengths) so the per-file JSON overhead (quotes, keys, commas) is accounted
// for and no chunk can silently exceed the budget by a few bytes.
const chunks = [];
let current = [];
function chunkBytes(list) {
  return Buffer.byteLength(JSON.stringify({ files: list }), 'utf8');
}
for (const f of files) {
  const trial = [...current, f];
  if (current.length > 0 && chunkBytes(trial) > MAX_CHUNK_BYTES) {
    chunks.push(current);
    current = [f];
  } else {
    current = trial;
  }
}
if (current.length) chunks.push(current);

let totalBytes = 0;
if (chunks.length <= 1) {
  const payload = JSON.stringify({ files: chunks[0] ?? [] });
  fs.writeFileSync(path.join(dir, 'bundle.json'), payload);
  totalBytes = Buffer.byteLength(payload, 'utf8');
  console.log(`Bundled ${files.length} files into ${path.relative(ROOT, path.join(dir, 'bundle.json'))} (${(totalBytes / 1024).toFixed(1)} KB)`);
} else {
  const manifest = { chunkCount: chunks.length, totalFiles: files.length, chunks: [] };
  chunks.forEach((chunk, i) => {
    const name = `bundle.${i + 1}.json`;
    const payload = JSON.stringify({ files: chunk });
    fs.writeFileSync(path.join(dir, name), payload);
    const bytes = Buffer.byteLength(payload, 'utf8');
    totalBytes += bytes;
    manifest.chunks.push({ file: name, fileCount: chunk.length, bytes });
    console.log(`Wrote ${path.relative(ROOT, path.join(dir, name))}: ${chunk.length} files, ${(bytes / 1024).toFixed(1)} KB`);
  });
  fs.writeFileSync(path.join(dir, 'bundle-manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`Bundled ${files.length} files into ${chunks.length} chunks under ${path.relative(ROOT, dir)}/ (see bundle-manifest.json)`);
}
console.log(`Total base64 payload: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
