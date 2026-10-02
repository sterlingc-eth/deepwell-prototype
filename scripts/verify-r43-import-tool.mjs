/**
 * R43 staff import tool + its server-side override: regression checks.
 *
 *   npx tsx scripts/verify-r43-import-tool.mjs
 *
 * Part A runs scripts/import/deepwell-import.mjs as a real child process against a local mock HTTP server that imitates
 * /api/upload-url, the storage PUT, /api/read-document and /api/v1/intake-status (no real service is contacted).
 * Part B boots the PGlite harness (scripts/lib/r35Harness.mjs: a real Postgres with every migration, the app's RLS role)
 * and proves the staff-import override: off -> refused, on -> allowed, expired -> refused, a customer cannot grant it to
 * themselves, other companies are unaffected, and import pages never use up the monthly allowance. It also runs the real
 * I1 / I2 SQL files.
 * Fake secrets are built by string concatenation (GitHub push protection).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'scripts/import/deepwell-import.mjs');
const FAKE_KEY = 'dw_' + 'live_' + 'c0ffee1234567890'.repeat(4); // 64 hex chars, never a real key
const OTHER_KEY = 'dw_' + 'live_' + 'abcdef0123456789'.repeat(4);

let failed = 0;
let family = 'misc';
const fam = {};
const check = (name, ok, detail = '') => {
  fam[family] ??= { pass: 0, fail: 0 };
  fam[family][ok ? 'pass' : 'fail']++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${family}] ${name}${ok ? '' : detail ? `  -> ${detail}` : ''}`);
  if (!ok) failed++;
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================================================= mock server
function startMock() {
  const m = {
    key: FAKE_KEY, docs: new Map(), puts: [], reads: [], presigns: [], statusPolls: 0, putsBySha: new Map(),
    hooks: {}, // presign(n, body) / put(n) / read(n) / auth: may return {status, headers, body} | 'destroy'
    putDelayMs: 0, preRead: new Set(),
  };
  let counts = { presign: 0, put: 0, read: 0 };
  m.reset = () => {
    m.docs.clear(); m.puts = []; m.reads = []; m.presigns = []; m.statusPolls = 0; m.putsBySha.clear(); m.hooks = {}; m.putDelayMs = 0; m.preRead = new Set();
    counts = { presign: 0, put: 0, read: 0 };
  };
  const readBody = (req) => new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c))); });
  const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = await readBody(req);
    const authed = req.headers.authorization === `Bearer ${m.key}`;
    if (url.pathname.startsWith('/api/') && m.hooks.auth) {
      const o = m.hooks.auth(req);
      if (o) return o === 'destroy' ? req.socket.destroy() : send(res, o.status, o.body, o.headers);
    }
    if (url.pathname.startsWith('/api/') && !authed) return send(res, 401, { error: 'Invalid or revoked API key' });
    if (url.pathname === '/api/upload-url' && req.method === 'POST') {
      const json = JSON.parse(body.toString('utf8') || '{}');
      counts.presign++;
      m.presigns.push(json);
      const o = m.hooks.presign?.(counts.presign, json);
      if (o) return o === 'destroy' ? req.socket.destroy() : send(res, o.status, o.body, o.headers);
      if (!Array.isArray(json.files) || json.files.length === 0) return send(res, 400, { error: 'files must be a non-empty array' });
      if (json.files.length > 50) return send(res, 413, { error: 'A batch is limited to 50 files' });
      const results = json.files.map((f) => {
        if (typeof f.sizeBytes !== 'number') return { filename: f.filename, error: 'sizeBytes is required', status: 400 };
        if (f.__reject) return { filename: f.filename, error: 'rejected', status: 413 };
        let d = m.docs.get(f.sha256);
        if (!d) { d = { id: crypto.randomUUID(), read: false, size: f.sizeBytes, name: f.filename }; if (m.preRead.has(f.sha256)) d.read = true; m.docs.set(f.sha256, d); }
        if (m.hooks.rejectName?.(f.filename)) return { filename: f.filename, error: 'File is larger than 100 MB', status: 413 };
        if (d.read) return { filename: f.filename, documentId: d.id, storageKey: 'k', alreadyUploaded: true, uploadUrl: null };
        return { filename: f.filename, documentId: d.id, storageKey: 'k', alreadyUploaded: false, uploadUrl: `http://127.0.0.1:${server.address().port}/r2/${d.id}?sig=1&size=${f.sizeBytes}` };
      });
      return send(res, 200, { results });
    }
    if (url.pathname.startsWith('/r2/') && req.method === 'PUT') {
      counts.put++;
      const o = m.hooks.put?.(counts.put, url);
      if (m.putDelayMs) await sleep(m.putDelayMs);
      if (o) return o === 'destroy' ? req.socket.destroy() : send(res, o.status, o.body ?? {}, o.headers);
      const declared = Number(url.searchParams.get('size'));
      if (declared !== body.length) return send(res, 403, '<Error>SignatureDoesNotMatch</Error>');
      const id = url.pathname.slice(4);
      const h = sha(body);
      m.puts.push({ id, sha: h, bytes: body.length });
      m.putsBySha.set(h, (m.putsBySha.get(h) ?? 0) + 1);
      return send(res, 200, {});
    }
    if (url.pathname === '/api/read-document' && req.method === 'POST') {
      counts.read++;
      const json = JSON.parse(body.toString('utf8') || '{}');
      const o = m.hooks.read?.(counts.read, json);
      if (o) return o === 'destroy' ? req.socket.destroy() : send(res, o.status, o.body, o.headers);
      m.reads.push(json.documentId);
      for (const d of m.docs.values()) if (d.id === json.documentId) d.read = true;
      return send(res, 202, { documentId: json.documentId, queued: true, extract: true });
    }
    if (url.pathname === '/api/v1/intake-status' && req.method === 'GET') {
      m.statusPolls++;
      const total = [...m.docs.values()].filter((d) => d.read).length;
      return send(res, 200, { total, openQuestions: 0 });
    }
    return send(res, 404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => { m.url = `http://127.0.0.1:${server.address().port}`; m.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }); resolve(m); }));
}

// ============================================================================================= tool runner
function runTool(args, { env = {}, cwd, input, onSpawn } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TOOL, ...args], {
      cwd, env: { ...process.env, DEEPWELL_IMPORT_BACKOFF_MS: '60', DEEPWELL_IMPORT_POLL_MS: '100', ...env }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr, child }));
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
    onSpawn?.(child, () => ({ stdout, stderr }));
  });
}
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-import-test-'));
let caseN = 0;
function makeCase(files = {}) {
  const dir = path.join(tmpRoot, `case${++caseN}`);
  const folder = path.join(dir, 'Customer Files');
  fs.mkdirSync(folder, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(folder, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return { dir, folder, state: path.join(dir, '.deepwell-import-Customer_Files.jsonl') };
}
const uniq = (label, size = 64) => Buffer.from(`${label}-${crypto.randomBytes(8).toString('hex')}-`.padEnd(size, 'x'));
const common = (m, folder, extra = []) => ['--folder', folder, '--base-url', m.url, '--yes', ...extra];
const withKey = { DEEPWELL_IMPORT_KEY: FAKE_KEY };
const readState = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const lastByPath = (file) => { const m = new Map(); for (const r of readState(file)) if (r.t === 'file') m.set(r.path, r); return m; };
const reportNums = (text) => {
  const g = (re) => Number((text.match(re)?.[1] ?? 'NaN').replace(/,/g, ''));
  return {
    found: g(/Files found in the folder \.+ ([\d,]+)/), uploaded: g(/Uploaded and sent to be read \.+ ([\d,]+)/), present: g(/Already in DeepWell \.+ ([\d,]+)/),
    skipped: g(/Skipped by the tool \.+ ([\d,]+)/), failed: g(/Failed \(see the errors file\) \.+ ([\d,]+)/), notAttempted: g(/Not attempted yet \.+ ([\d,]+)/),
  };
};
const mixedTree = () => ({
  'a/invoice-1.pdf': uniq('pdf1'), 'a/invoice-2.pdf': uniq('pdf2'), 'b/deep/photo-1.jpg': uniq('jpg1'), 'b/photo-2.png': uniq('png1'),
  'notes.txt': uniq('txt1'), 'parts.csv': uniq('csv1'),
});

const m = await startMock();
try {
  // ========================================================================================= A1 dry run + classification
  family = 'dry-run';
  {
    const c = makeCase({
      ...mixedTree(), '.DS_Store': 'x', 'Thumbs.db': 'x', '~$report.docx': 'x', 'a/.hidden.pdf': 'x', 'letter.docx': 'x', 'sheet.xlsx': 'x', 'iphone.heic': 'x', 'scan.tif': 'x',
      'doc.gdoc': '{}', 'sheet.gsheet': '{}', 'empty.pdf': '', 'noext': 'x', '.git/config': 'x', '$RECYCLE.BIN/x.pdf': 'x',
    });
    fs.writeFileSync(path.join(c.folder, 'huge.pdf'), ''); fs.truncateSync(path.join(c.folder, 'huge.pdf'), 25 * 1024 * 1024);
    fs.writeFileSync(path.join(c.folder, 'hugetext.csv'), ''); fs.truncateSync(path.join(c.folder, 'hugetext.csv'), 21 * 1024 * 1024);
    const listingBefore = fs.readdirSync(c.folder).sort();
    const r = await runTool(['--folder', c.folder, '--dry-run'], { cwd: c.dir });
    check('dry run exits 0', r.code === 0, `${r.code} ${r.stderr}`);
    check('dry run makes no network calls (mock saw nothing) and uploads nothing', m.presigns.length === 0 && m.puts.length === 0 && m.statusPolls === 0);
    check('dry run says nothing is uploaded', /Nothing was uploaded/.test(r.stdout));
    check('dry run counts 6 files to upload (3 types shown)', /Will be uploaded: 6 files/.test(r.stdout) && /PDFs: 2/.test(r.stdout) && /Photos: 2/.test(r.stdout) && /Text\/CSV: 2/.test(r.stdout), r.stdout.slice(0, 600));
    check('hidden/system files skipped (.DS_Store, Thumbs.db, ~$ temp, dotfile)', /Hidden, system or temporary files: 4 /.test(r.stdout), r.stdout);
    check('Google stubs are named with the export-to-PDF instruction', /Google Docs\/Sheets shortcuts[^\n]*: 2 /.test(r.stdout) && /Export the real file to PDF/.test(r.stdout));
    check('unsupported types (Word, Excel, HEIC, TIFF, no extension) are skipped with what to do', /Types DeepWell cannot read: 5 /.test(r.stdout) && /Convert the file to PDF or JPEG/.test(r.stdout), r.stdout);
    check('empty and oversize files are skipped with the reason', /Empty files \(0 bytes\): 1 /.test(r.stdout) && /Too large to read: 2 /.test(r.stdout));
    check('hidden/system FOLDERS are skipped and not counted', /Hidden\/system or unreadable folders skipped: 2/.test(r.stdout));
    check('files found total adds up (6 + 4 + 2 + 5 + 1 + 2)', /Files found: 20\b/.test(r.stdout), r.stdout.slice(0, 200));
    check('estimates are labelled as estimates and give a cost range and a suggested allowance', /ESTIMATES/.test(r.stdout) && /Reading cost \(Anthropic\): about \$[\d.]+ [^\n]*up to about \$[\d.,]+/.test(r.stdout) && /Suggested import page allowance/.test(r.stdout) && /not a quote/.test(r.stdout));
    check('dry run wrote no progress file, report or error file anywhere', !fs.existsSync(c.state) && !fs.existsSync(`${c.state}.report.txt`) && fs.readdirSync(c.folder).includes('a'));
    check('the customer folder is untouched by a dry run (same entries as before)', JSON.stringify(fs.readdirSync(c.folder).sort()) === JSON.stringify(listingBefore));
    const k = await runTool(['--folder', c.folder, '--dry-run', '--check-key', '--base-url', m.url], { cwd: c.dir, env: withKey });
    check('--check-key in a dry run makes exactly one harmless request and reports the key works', k.code === 0 && m.presigns.length === 1 && m.presigns[0].files.length === 0 && /Key check: OK/.test(k.stdout), `${k.stdout}`);
    check('key check output never contains the key', !k.stdout.includes(FAKE_KEY) && !k.stderr.includes(FAKE_KEY));
    m.reset();
  }

  // ========================================================================================= A2 happy path + report math
  family = 'happy-path';
  {
    const files = mixedTree();
    const c = makeCase({ ...files, '.DS_Store': 'x', 'old.docx': 'x', 'empty.pdf': '' });
    const r = await runTool(common(m, c.folder), { cwd: c.dir, env: withKey });
    check('exits 0', r.code === 0, `${r.code}\n${r.stdout}\n${r.stderr}`);
    check('every supported file was PUT to storage exactly once, with the bytes unchanged', m.puts.length === 6 && [...m.putsBySha.values()].every((n) => n === 1) && Object.values(files).every((b) => m.putsBySha.get(sha(b)) === 1));
    check('every uploaded document was then asked to be read (same pipeline as the browser)', m.reads.length === 6 && new Set(m.reads).size === 6);
    check('presign requests use the browser shape: filename (relative path), sha256, contentType, sizeBytes', m.presigns.every((p) => p.files.every((f) => typeof f.filename === 'string' && /^[0-9a-f]{64}$/.test(f.sha256) && Number.isInteger(f.sizeBytes) && f.sizeBytes > 0 && typeof f.contentType === 'string')) && m.presigns[0].files.some((f) => f.filename === 'b/deep/photo-1.jpg' && f.contentType === 'image/jpeg'));
    check('presign batches are small (<= 20 files)', m.presigns.every((p) => p.files.length <= 20));
    const st = lastByPath(c.state);
    check('checkpoint has one line per file with path, size, mtime, sha256, status, document id and attempts', st.size === 6 && [...st.values()].every((x) => x.status === 'done' && x.sha256 && x.documentId && x.attempts >= 1 && x.size > 0 && Number.isFinite(x.mtimeMs)));
    check('the progress file lives OUTSIDE the customer folder, and nothing was written into it', fs.existsSync(c.state) && !fs.readdirSync(c.folder).some((n) => n.startsWith('.deepwell')) && !fs.readdirSync(c.folder).some((n) => /report|errors/.test(n)));
    check('report and errors files are written next to the progress file', fs.existsSync(`${c.state}.report.txt`) && fs.existsSync(`${c.state}.errors.csv`));
    const rep = fs.readFileSync(`${c.state}.report.txt`, 'utf8');
    const n = reportNums(rep);
    eq('report: found / uploaded / present / skipped / failed / not attempted', n, { found: 9, uploaded: 6, present: 0, skipped: 3, failed: 0, notAttempted: 0 });
    check('report math adds up and says it matches', n.uploaded + n.present + n.skipped + n.failed + n.notAttempted === n.found && /matches files found/.test(rep));
    const csv = fs.readFileSync(`${c.state}.errors.csv`, 'utf8');
    check('errors.csv lists the skipped files with a reason and what to do', /skipped,old\.docx/.test(csv) && /skipped,empty\.pdf/.test(csv) && /Convert the file to PDF or JPEG/.test(csv));
    check('live progress line printed', /Progress: 6\/6 files/.test(r.stdout));
    m.reset();
  }

  // ========================================================================================= A3 resume after kill (no re-upload)
  family = 'resume';
  {
    const tree = {};
    for (let i = 0; i < 50; i++) tree[`d${i % 5}/f${i}.pdf`] = uniq(`kill${i}`);
    const c = makeCase(tree);
    m.putDelayMs = 40;
    let killedAfter = 0;
    const r1 = await runTool(common(m, c.folder, ['--concurrency', '2']), {
      cwd: c.dir, env: withKey,
      onSpawn: (child) => { const t = setInterval(() => { if (m.puts.length >= 12) { clearInterval(t); killedAfter = m.puts.length; child.kill('SIGKILL'); } }, 10); },
    });
    check('first run was killed hard (SIGKILL) part-way', r1.signal === 'SIGKILL' && killedAfter >= 12);
    let lines = 0, bad = 0;
    for (const l of fs.readFileSync(c.state, 'utf8').split('\n').filter(Boolean)) { lines++; try { JSON.parse(l); } catch { bad++; } }
    check('the checkpoint is still valid after the kill (at most the very last line may be cut off)', lines > 1 && bad <= 1);
    const doneBefore = [...lastByPath(c.state).values()].filter((x) => x.status === 'done');
    const putsBefore = new Map(m.putsBySha);
    m.putDelayMs = 0;
    const r2 = await runTool(common(m, c.folder), { cwd: c.dir, env: withKey });
    check('re-run finishes and exits 0', r2.code === 0, `${r2.code}\n${r2.stdout.slice(-600)}`);
    check('files finished before the kill were NOT uploaded again', doneBefore.length > 0 && doneBefore.every((d) => m.putsBySha.get(d.sha256) === putsBefore.get(d.sha256) && m.putsBySha.get(d.sha256) === 1));
    check('all 50 files ended up stored exactly once or at most one in-flight repeat', [...m.putsBySha.values()].filter((x) => x > 1).length <= 2 && m.putsBySha.size === 50);
    check('re-run says it is resuming and reports 50 uploaded', /Resuming: \d+ files were already handled/.test(r2.stdout) && reportNums(fs.readFileSync(`${c.state}.report.txt`, 'utf8')).uploaded === 50);
    const r3 = await runTool(common(m, c.folder), { cwd: c.dir, env: withKey });
    const before = m.puts.length;
    check('a third run with nothing left to do is instant: no hashing, no network, exit 0', r3.code === 0 && m.puts.length === before && /will send 0 files/.test(r3.stdout), r3.stdout.slice(-300));
    m.reset();
  }

  // ========================================================================================= A4 changed file re-upload
  family = 'changed-files';
  {
    const tree = { 'x/one.pdf': uniq('one'), 'x/two.pdf': uniq('two'), 'three.txt': uniq('three') };
    const c = makeCase(tree);
    await runTool(common(m, c.folder), { cwd: c.dir, env: withKey });
    check('baseline run uploaded 3', m.puts.length === 3);
    const changed = uniq('one-v2');
    fs.writeFileSync(path.join(c.folder, 'x/one.pdf'), changed);
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(c.folder, 'x/one.pdf'), future, future);
    // two.pdf: same bytes, new modified time -> re-verified by hash, NOT uploaded again
    fs.utimesSync(path.join(c.folder, 'x/two.pdf'), future, future);
    const r = await runTool(common(m, c.folder), { cwd: c.dir, env: withKey });
    check('exit 0', r.code === 0, r.stdout);
    check('the file whose content changed was uploaded again (new version)', m.putsBySha.get(sha(changed)) === 1 && m.puts.length === 4);
    check('a file that was only touched (same bytes) was re-verified and NOT uploaded again', m.putsBySha.get(sha(tree['x/two.pdf'])) === 1);
    check('the unchanged file was left alone', m.putsBySha.get(sha(tree['three.txt'])) === 1);
    check('the checkpoint now holds the new hash for the changed file', lastByPath(c.state).get('x/one.pdf').sha256 === sha(changed));
    m.reset();
  }

  // ========================================================================================= A5 duplicates
  family = 'duplicates';
  {
    const dupe = uniq('same-bytes');
    const known = uniq('already-in-deepwell');
    const c = makeCase({ 'a/copy1.pdf': dupe, 'b/copy2.pdf': dupe, 'c/copy3.pdf': dupe, 'known.pdf': known, 'new.pdf': uniq('brand-new') });
    m.preRead.add(sha(known));
    const r = await runTool(common(m, c.folder, ['--concurrency', '1']), { cwd: c.dir, env: withKey });
    check('exit 0', r.code === 0, r.stdout);
    check('a file DeepWell already holds (server says alreadyUploaded) is not uploaded', !m.putsBySha.has(sha(known)));
    check('three identical copies in the folder cost ONE upload', m.putsBySha.get(sha(dupe)) === 1);
    const rep = fs.readFileSync(`${c.state}.report.txt`, 'utf8');
    const n = reportNums(rep);
    eq('report: 2 uploaded, 3 already present (1 server-known + 2 identical copies), math ok', [n.found, n.uploaded, n.present, n.failed], [5, 2, 3, 0]);
    check('report explains the two kinds of "already present"', /1 DeepWell already had them; 2 identical copies/.test(rep), rep);
    m.reset();
  }

  // ========================================================================================= A6 429 with Retry-After
  family = 'rate-limit';
  {
    const c = makeCase({ 'one.pdf': uniq('rl1'), 'two.pdf': uniq('rl2') });
    m.hooks.presign = (n) => (n === 1 ? { status: 429, headers: { 'retry-after': '1' }, body: { error: 'Too many requests', scope: 'per-minute' } } : null);
    const t0 = Date.now();
    const r = await runTool(common(m, c.folder), { cwd: c.dir, env: withKey });
    const took = Date.now() - t0;
    check('a 429 with Retry-After: 1 is waited out (at least ~1s) and the run then succeeds', r.code === 0 && took >= 900 && m.puts.length === 2, `${r.code} ${took}ms`);
    check('the report counts the slow-down', /Waited out 1 "slow down"/.test(fs.readFileSync(`${c.state}.report.txt`, 'utf8')));
    m.reset();
    // 503 and per-minute 429 without a header: exponential backoff, then success
    const c2 = makeCase({ 'one.pdf': uniq('rl3') });
    m.hooks.presign = (n) => (n <= 3 ? { status: 503, body: { error: 'busy' } } : null);
    const r2 = await runTool(common(m, c2.folder), { cwd: c2.dir, env: withKey });
    check('three 503s in a row are retried with backoff and then succeed', r2.code === 0 && m.puts.length === 1);
    m.reset();
    // never recovers: capped retries -> files failed, clean stop after repeated failure, non-zero exit, nothing lost
    const tree = {}; for (let i = 0; i < 70; i++) tree[`f${i}.pdf`] = uniq(`busy${i}`);
    const c3 = makeCase(tree);
    m.hooks.presign = () => ({ status: 503, body: { error: 'busy' } });
    const r3 = await runTool(common(m, c3.folder, ['--concurrency', '1']), { cwd: c3.dir, env: withKey });
    check('a server that never recovers: retries are capped, the run stops cleanly with exit 3 and says it is safe to run again', r3.code === 3 && /too busy or unreachable/.test(r3.stdout) && m.puts.length === 0, `${r3.code}\n${r3.stdout.slice(-500)}`);
    check('the presign was tried a bounded number of times (not forever)', m.presigns.length <= 3 * 8 + 2, String(m.presigns.length));
    m.reset();
    // per-day 429 stops at once with an explanation
    const c4 = makeCase({ 'one.pdf': uniq('day') });
    m.hooks.presign = () => ({ status: 429, headers: { 'retry-after': '3600' }, body: { error: 'Daily limit of 2000 ingest units reached', scope: 'per-day' } });
    const r4 = await runTool(common(m, c4.folder), { cwd: c4.dir, env: withKey });
    check('a per-day 429 stops immediately (exit 3) and tells staff what to raise', r4.code === 3 && m.presigns.length === 1 && /daily upload limit/i.test(r4.stdout) && /v_per_day/.test(r4.stdout), r4.stdout);
    m.reset();
  }

  // ========================================================================================= A7 402 stops
  family = 'allowance';
  {
    const tree = {}; for (let i = 0; i < 30; i++) tree[`g${i}.pdf`] = uniq(`al${i}`);
    const c = makeCase(tree);
    m.hooks.presign = () => ({ status: 402, body: { error: "The temporary page allowance for DeepWell's data import on this account (1,000 pages) is used up", code: 'import-allowance-exhausted', url: '/app/?screen=billing' } });
    const r = await runTool(common(m, c.folder, ['--concurrency', '1']), { cwd: c.dir, env: withKey });
    check('402 allowance used up: exit 3, one request only, nothing uploaded', r.code === 3 && m.presigns.length === 1 && m.puts.length === 0, `${r.code} ${m.presigns.length}`);
    check('the message says what to raise (v_pages in I1) and that the tool carries on', /IMPORT PAGE ALLOWANCE USED UP/.test(r.stdout) && /v_pages/.test(r.stdout) && /I1-allow-staff-import\.sql/.test(r.stdout) && /carries on where it stopped/.test(r.stdout), r.stdout);
    check('the report says it STOPPED EARLY and counts the rest as not attempted', /STOPPED EARLY/.test(fs.readFileSync(`${c.state}.report.txt`, 'utf8')) && reportNums(fs.readFileSync(`${c.state}.report.txt`, 'utf8')).notAttempted === 30);
    m.reset();
    const r2 = await runTool(common(m, c.folder), { cwd: c.dir, env: withKey });
    check('after the allowance is raised, a re-run completes all 30', r2.code === 0 && m.puts.length === 30);
    m.reset();
    // per-file 402 inside a batch (allowance runs out mid-batch)
    const c2 = makeCase({ 'a.pdf': uniq('b1'), 'b.pdf': uniq('b2'), 'c.pdf': uniq('b3') });
    m.hooks.presign = (n, body) => ({ status: 200, body: { results: body.files.map((f, i) => (i === 0 ? { filename: f.filename, documentId: crypto.randomUUID(), alreadyUploaded: true } : { filename: f.filename, error: 'Import allowance', status: 402, code: 'import-allowance-exhausted' })) } });
    const r3 = await runTool(common(m, c2.folder), { cwd: c2.dir, env: withKey });
    check('a 402 on one file inside a batch also stops the run with the allowance message', r3.code === 3 && /IMPORT PAGE ALLOWANCE USED UP/.test(r3.stdout));
    m.reset();
    // monthly limit message = the override is not in force
    const c3 = makeCase({ 'a.pdf': uniq('m1') });
    m.hooks.presign = () => ({ status: 402, body: { error: 'Monthly page limit reached (750). It resets on Nov 1. Upgrade your plan for more.' } });
    const r4 = await runTool(common(m, c3.folder), { cwd: c3.dir, env: withKey });
    check('a plain monthly-limit 402 tells staff the import allowance is NOT in force (paste I1, wait 5 minutes)', r4.code === 3 && /NOT in force/.test(r4.stdout) && /paste I1/i.test(r4.stdout), r4.stdout);
    m.reset();
  }

  // ========================================================================================= A8 auth stops
  family = 'auth';
  {
    const c = makeCase({ 'a.pdf': uniq('au1'), 'b.pdf': uniq('au2') });
    const r = await runTool(common(m, c.folder), { cwd: c.dir, env: { DEEPWELL_IMPORT_KEY: OTHER_KEY } });
    check('a refused key (401) stops the run after the repeat attempt with exit 3', r.code === 3 && m.puts.length === 0, `${r.code}`);
    check('the message says the key was refused and to create a new one', /key was refused/i.test(r.stdout));
    check('repeated auth failure does not hammer the server (at most 2 requests)', m.presigns.length <= 2, String(m.presigns.length));
    check('the (wrong) key is not in any output', !r.stdout.includes(OTHER_KEY) && !r.stderr.includes(OTHER_KEY));
    m.reset();
    m.hooks.auth = () => ({ status: 403, body: { error: 'API access is included on the Fleet plan' } });
    const r2 = await runTool(common(m, c.folder), { cwd: c.dir, env: withKey });
    check('403 "Fleet plan" = override not on: tells staff to paste I1', r2.code === 3 && /not switched on for this company/.test(r2.stdout) && /I1/.test(r2.stdout), r2.stdout);
    m.reset();
  }

  // ========================================================================================= A9 network retry
  family = 'network';
  {
    const c = makeCase({ 'a.pdf': uniq('n1'), 'b.pdf': uniq('n2'), 'c.pdf': uniq('n3') });
    m.hooks.presign = (n) => (n === 1 ? 'destroy' : null);
    m.hooks.put = (n) => (n === 2 ? 'destroy' : n === 3 ? { status: 500, body: {} } : null);
    const r = await runTool(common(m, c.folder), { cwd: c.dir, env: withKey });
    check('a dropped connection on the presign and on a PUT, and a 500 from storage, are all retried: run succeeds', r.code === 0 && m.puts.length === 3, `${r.code} ${m.puts.length}\n${r.stdout.slice(-400)}`);
    check('the report counts the network hiccups', /Waited out \d+ "slow down" replies and [1-9]\d* network hiccups/.test(fs.readFileSync(`${c.state}.report.txt`, 'utf8')) || /Waited out [1-9]/.test(fs.readFileSync(`${c.state}.report.txt`, 'utf8')));
    m.reset();
    // one file rejected by the server (413) = failed, exit 1, in errors.csv, NOT retried on the next run
    const c2 = makeCase({ 'ok.pdf': uniq('ok'), 'toobig.pdf': uniq('big') });
    m.hooks.rejectName = (name) => name === 'toobig.pdf';
    const r2 = await runTool(common(m, c2.folder), { cwd: c2.dir, env: withKey });
    const rep = fs.readFileSync(`${c2.state}.report.txt`, 'utf8');
    check('a file the server refuses is counted as failed, exit code is 1, others still upload', r2.code === 1 && reportNums(rep).failed === 1 && reportNums(rep).uploaded === 1, `${r2.code}\n${rep}`);
    check('errors.csv has the failed row with the server message', /failed,toobig\.pdf,File is larger than 100 MB/.test(fs.readFileSync(`${c2.state}.errors.csv`, 'utf8')));
    const presignsBefore = m.presigns.length;
    const r3 = await runTool(common(m, c2.folder), { cwd: c2.dir, env: withKey });
    check('a permanently refused file is not retried on the next run (it would fail the same way)', m.presigns.length === presignsBefore && /will send 0 files/.test(r3.stdout));
    m.reset();
  }

  // ========================================================================================= A10 symlinks
  family = 'symlinks';
  {
    const outside = path.join(tmpRoot, 'outside-secret.pdf');
    const secret = uniq('SECRET-OUTSIDE-FOLDER');
    fs.writeFileSync(outside, secret);
    const outsideDir = path.join(tmpRoot, 'outside-dir'); fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(outsideDir, 'inner.pdf'), uniq('SECRET-DIR'));
    const c = makeCase({ 'real.pdf': uniq('real') });
    fs.symlinkSync(outside, path.join(c.folder, 'link-to-outside.pdf'));
    fs.symlinkSync(outsideDir, path.join(c.folder, 'linked-dir'));
    fs.symlinkSync(path.join(c.folder, 'real.pdf'), path.join(c.folder, 'link-inside.pdf'));
    const r = await runTool(common(m, c.folder), { cwd: c.dir, env: withKey });
    check('exit 0 and only the real file was uploaded', r.code === 0 && m.puts.length === 1);
    check('the file outside the folder was never read or uploaded (its bytes never reached the server)', !m.putsBySha.has(sha(secret)) && !m.presigns.some((p) => p.files.some((f) => f.sha256 === sha(secret) || /link|linked-dir|inner/.test(f.filename))));
    const csv = fs.readFileSync(`${c.state}.errors.csv`, 'utf8');
    check('links are reported as skipped with the reason (never followed)', /skipped,link-to-outside\.pdf/.test(csv) && /skipped,linked-dir/.test(csv) && /never follows links/.test(csv));
    check('even a link that points INSIDE the folder is not followed (no double upload)', /skipped,link-inside\.pdf/.test(csv));
    m.reset();
  }

  // ========================================================================================= A11 key never leaks
  family = 'key-secrecy';
  {
    const c = makeCase({ 'a.pdf': uniq('k1'), 'b.pdf': uniq('k2'), 'c.pdf': uniq('k3') });
    // the server echoes the key (and a Bearer header) back in error text
    m.hooks.presign = (n, body) => ({ status: 200, body: { results: body.files.map((f, i) => (i === 0 ? { filename: f.filename, error: `bad token Bearer ${FAKE_KEY} for ${FAKE_KEY}`, status: 400 } : { filename: f.filename, error: `server said ${FAKE_KEY}`, status: 413 })) } });
    const r1 = await runTool(common(m, c.folder), { cwd: c.dir, env: withKey });
    const reportText = fs.readFileSync(`${c.state}.report.txt`, 'utf8');
    const csvText = fs.readFileSync(`${c.state}.errors.csv`, 'utf8');
    const stateText = fs.readFileSync(c.state, 'utf8');
    const everything = [r1.stdout, r1.stderr, reportText, csvText, stateText];
    check('server replies that echo the key are redacted in stdout, stderr, the progress file, the report and the errors file', everything.every((t) => !t.includes(FAKE_KEY) && !t.includes('c0ffee1234567890c0ffee')) && r1.code === 1, `exit ${r1.code}`);
    check('the redaction marker is present (the text was cleaned, not dropped)', /key hidden|hidden/.test(stateText + csvText + r1.stdout));
    m.reset();
    // crash path / HTML 500 containing the key
    const c2 = makeCase({ 'a.pdf': uniq('k4') });
    m.hooks.presign = () => ({ status: 500, body: `<html>Internal error for Bearer ${FAKE_KEY}</html>` });
    const r2 = await runTool(common(m, c2.folder, ['--concurrency', '1']), { cwd: c2.dir, env: withKey });
    const all2 = [r2.stdout, r2.stderr, ...fs.readdirSync(c2.dir).filter((n) => n.startsWith('.deepwell')).map((n) => fs.readFileSync(path.join(c2.dir, n), 'utf8'))];
    check('an HTML error page containing the key is redacted everywhere', all2.every((t) => !t.includes(FAKE_KEY)));
    m.reset();
    // the key on the command line is refused (and not echoed back)
    for (const bad of [['--key', FAKE_KEY], ['--api-key', FAKE_KEY], [`--key=${FAKE_KEY}`], ['--token', FAKE_KEY], [FAKE_KEY]]) {
      const r = await runTool(['--folder', c.folder, '--dry-run', ...bad], { cwd: c.dir });
      check(`the key as a command-line argument (${bad[0].slice(0, 10)}...) is refused, exit 2, and not echoed`, r.code === 2 && /never be typed on the command line/.test(r.stderr) && !r.stdout.includes(FAKE_KEY) && !r.stderr.includes(FAKE_KEY), r.stderr);
    }
    const r3 = await runTool(common(m, c.folder), { cwd: c.dir, env: {} });
    check('no key available and no terminal: refuses to start (exit 2) with a plain instruction, no upload', r3.code === 2 && /DEEPWELL_IMPORT_KEY/.test(r3.stderr) && m.presigns.length === 0, r3.stderr);
    const r4 = await runTool(common(m, c.folder), { cwd: c.dir, env: { DEEPWELL_IMPORT_KEY: 'not-a-key' } });
    check('a malformed key is refused before any request, and is not echoed', r4.code === 2 && m.presigns.length === 0 && !r4.stdout.includes('not-a-key') && !r4.stderr.includes('not-a-key'));
    const src = fs.readFileSync(TOOL, 'utf8');
    check('the tool source never logs the key variable directly', !/console\.(log|error)\([^)]*ctx\.key/.test(src) && !/(out|errOut|say)\(`?[^)]*\$\{ctx\.key\}/.test(src));
    m.reset();
  }

  // ========================================================================================= A12 safety checks on options
  family = 'safety';
  {
    const c = makeCase({ 'a.pdf': uniq('s1') });
    const r1 = await runTool(['--folder', c.folder, '--state', path.join(c.folder, 'state.jsonl'), '--base-url', m.url, '--yes'], { cwd: c.dir, env: withKey });
    check('a progress file inside the customer folder is refused (exit 2) and nothing is uploaded', r1.code === 2 && /must not be inside the customer folder/.test(r1.stderr) && m.presigns.length === 0);
    const r2 = await runTool(['--folder', c.folder, '--base-url', 'http://files.example.com', '--yes'], { cwd: c.dir, env: withKey });
    check('a non-https server address (other than this computer) is refused so the key cannot travel unencrypted', r2.code === 2 && /https:\/\//.test(r2.stderr));
    const r3 = await runTool(['--folder', path.join(c.dir, 'does-not-exist'), '--dry-run'], { cwd: c.dir });
    check('a missing folder is a clear exit-2 message', r3.code === 2 && /does not exist/.test(r3.stderr));
    const r4 = await runTool(['--folder', c.folder, '--base-url', m.url], { cwd: c.dir, env: withKey });
    check('without --yes and without a terminal it refuses to start rather than guessing', r4.code === 2 && /--yes/.test(r4.stderr) && m.presigns.length === 0);
    const r5 = await runTool(['--help']);
    check('--help works and states the key rule', r5.code === 0 && /DEEPWELL_IMPORT_KEY/.test(r5.stdout) && /never accepted/.test(r5.stdout.replace(/\s+/g, ' ')), r5.stdout.slice(0, 200));
    const r6 = await runTool(['--folder', c.folder, '--concurrency', '99', '--dry-run']);
    check('silly option values are refused', r6.code === 2);
    const src = fs.readFileSync(TOOL, 'utf8');
    check('zero dependencies: the tool imports only node: built-ins', [...src.matchAll(/^import .* from '([^']+)'/gm)].every((x) => x[1].startsWith('node:')));
    m.reset();
  }

  // ========================================================================================= A13 --limit sample
  family = 'limit';
  {
    const tree = {}; for (let i = 0; i < 40; i++) tree[`dir${i % 4}/f${String(i).padStart(2, '0')}.pdf`] = uniq(`lim${i}`, 100 + i * 30);
    const c = makeCase(tree);
    const r = await runTool(common(m, c.folder, ['--limit', '10']), { cwd: c.dir, env: withKey });
    const rep = fs.readFileSync(`${c.state}.report.txt`, 'utf8');
    const n = reportNums(rep);
    check('--limit 10 uploads exactly 10 files, spread across folders, exit 0', r.code === 0 && m.puts.length === 10 && new Set(m.presigns.flatMap((p) => p.files.map((f) => f.filename.split('/')[0]))).size === 4, `${r.code} ${m.puts.length}`);
    check('the remaining 30 are reported as not attempted (the sample), math adds up', n.uploaded === 10 && n.notAttempted === 30 && n.found === 40 && /--limit test run only takes a sample/.test(rep));
    check('the largest file is part of the sample (the test run includes the worst case)', m.presigns.flatMap((p) => p.files).some((f) => f.filename.endsWith('f39.pdf')));
    const r2 = await runTool(common(m, c.folder), { cwd: c.dir, env: withKey });
    check('a later full run uploads only the other 30 (the sample is not repeated)', r2.code === 0 && m.puts.length === 40 && [...m.putsBySha.values()].every((x) => x === 1));
    m.reset();
  }

  // ========================================================================================= A14 Ctrl-C
  family = 'ctrl-c';
  {
    const tree = {}; for (let i = 0; i < 60; i++) tree[`d${i % 3}/c${i}.pdf`] = uniq(`cc${i}`);
    const c = makeCase(tree);
    m.putDelayMs = 40;
    const r1 = await runTool(common(m, c.folder, ['--concurrency', '2']), {
      cwd: c.dir, env: withKey,
      onSpawn: (child) => { const t = setInterval(() => { if (m.puts.length >= 10) { clearInterval(t); child.kill('SIGINT'); } }, 10); },
    });
    check('Ctrl-C (SIGINT): stops cleanly with exit 3 and a plain message, not a crash', r1.code === 3 && /Stopped by you \(Ctrl-C\)/.test(r1.stdout) && !/Unexpected problem/.test(r1.stderr), `${r1.code}\n${r1.stdout.slice(-400)}\n${r1.stderr}`);
    const lines = fs.readFileSync(c.state, 'utf8').split('\n').filter(Boolean);
    check('the checkpoint is fully valid after Ctrl-C (every line parses)', lines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }));
    const doneNow = [...lastByPath(c.state).values()].filter((x) => x.status === 'done');
    const rep = fs.readFileSync(`${c.state}.report.txt`, 'utf8');
    check('a report was still written, with honest counts that add up', /STOPPED EARLY/.test(rep) && /matches files found/.test(rep) && reportNums(rep).uploaded === doneNow.length);
    m.putDelayMs = 0;
    const putsBefore = new Map(m.putsBySha);
    const r2 = await runTool(common(m, c.folder), { cwd: c.dir, env: withKey });
    check('running again carries on and finishes: 60 stored, finished files not repeated', r2.code === 0 && m.putsBySha.size === 60 && doneNow.every((d) => m.putsBySha.get(d.sha256) === putsBefore.get(d.sha256)));
    m.reset();
  }

  // ========================================================================================= A15 watch reading + concurrency
  family = 'watch-reading';
  {
    const c = makeCase({ 'a.pdf': uniq('w1'), 'b.pdf': uniq('w2'), 'c.pdf': uniq('w3') });
    const r = await runTool(common(m, c.folder, ['--watch-reading']), { cwd: c.dir, env: withKey });
    check('--watch-reading polls the existing read-only status endpoint and reports when all are read', r.code === 0 && m.statusPolls >= 2 && /All documents from this run have been read/.test(r.stdout) && /3 of 3 documents finished/.test(r.stdout), `${m.statusPolls}\n${r.stdout.slice(-500)}`);
    m.reset();
    const tree = {}; for (let i = 0; i < 100; i++) tree[`f${i}.txt`] = uniq(`conc${i}`, 80);
    const c2 = makeCase(tree);
    const r2 = await runTool(common(m, c2.folder, ['--concurrency', '4']), { cwd: c2.dir, env: withKey });
    check('100 files: all uploaded, in batches of at most 20, exit 0', r2.code === 0 && m.puts.length === 100 && m.presigns.length >= 5 && m.presigns.every((p) => p.files.length <= 20));
    m.reset();
  }
} finally {
  await m.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
const partA = { ...fam };

// =================================================================================================================
// PART B: the server side (PGlite harness, no network)
// =================================================================================================================
const { bootHarness } = await import('./lib/r35Harness.mjs');
const h = await bootHarness();
const { lite, RS, PLAN, newTenant, resetCaches, rnd, root } = h;
const rel = (p) => path.join(root, p);
const read = (p) => fs.readFileSync(rel(p), 'utf8');
const quiet = async (fn) => { const e = console.error, w = console.warn; console.error = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.error = e; console.warn = w; } };
const mkRes = () => { const r = { statusCode: 0, body: null, headers: {}, status(c) { r.statusCode = c; return r; }, json(b) { r.body = b; return r; }, setHeader(k, v) { r.headers[k] = v; return r; }, end() { return r; } }; return r; };
const throws = async (name, fn, re, status) => { try { await fn(); check(name, false, 'did not throw'); } catch (e) { check(name, (!re || re.test(e.message)) && (status == null || e.status === status), `${e.status} ${e.message}`); } };

const UP = await import(rel('api/upload-url.js'));
const KEYS = await import(rel('api/_lib/routes/keys.js'));
const AUTHK = await import(rel('api/_lib/apiKeyAuth.js'));
const RL = await import(rel('api/_lib/rateLimit.js'));
const RECORDS = await import(rel('api/records.ts'));
const GUARD = await import(rel('api/_lib/agent/sqlGuard.js'));
const BILLING = await import(rel('api/billing.js'));
const { staffImportFor, hasApiAccessFor, hasApiAccess, gateUpload, staffImportWindowFor, STAFF_IMPORT_MAX_DAYS } = PLAN;

const authFor = (key) => ({ tenantId: key, orgId: key, userId: 'user_admin', orgRole: 'admin' });
const iso = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
const H = 3_600_000, D = 24 * H;
const now = Date.now();
const imp = (over = {}) => ({ from: iso(now - H), until: iso(now + 10 * D), pages: 5000, documents: 1000, ingestPerMinute: 600, ingestPerDay: 200_000, maxModelCallsPerDay: 150_000, ...over });
const tenantRow = async (key) => { const t = await RS.getTenantContext(key, key); return { plan: t.plan, billing_status: t.billingStatus, limits: t.limits }; };
const setLimits = async (id, limits) => { await lite.query('UPDATE tenants SET limits = $2::jsonb WHERE id = $1', [id, JSON.stringify(limits)]); resetCaches(); };
const seedPages = async (tenantId, n, createdAt) => {
  const { rows: [d] } = await lite.query(`INSERT INTO documents (tenant_id, original_filename, sha256_hash, file_size_bytes, stage, storage_key, content_type, page_count) VALUES ($1,'seed.pdf',$2,1,'read','k','application/pdf',$3) RETURNING id`, [tenantId, rnd(), n]);
  await lite.query(`INSERT INTO document_pages (tenant_id, document_id, page_no, r2_path, text, created_at) SELECT $1, $2, g, '', 'x', $4::timestamptz FROM generate_series(1, $3) g`, [tenantId, d.id, n, createdAt]);
};

// ============================================================================================= B1 pure rules
family = 'override-rules';
{
  const solo = (limits) => ({ plan: 'solo', billing_status: 'active', limits });
  check('off (no staffImport): no API access on Solo/Team/Crew, Fleet only', ['solo', 'shop', 'crew'].every((p) => !hasApiAccessFor({ plan: p, limits: {} })) && hasApiAccessFor({ plan: 'fleet', limits: {} }));
  check('on: API access on EVERY plan (any plan, not only Fleet)', ['solo', 'shop', 'crew', 'fleet'].every((p) => hasApiAccessFor({ plan: p, limits: { staffImport: imp() } })));
  check('expired (until in the past): refused', !hasApiAccessFor(solo({ staffImport: imp({ from: iso(now - 20 * D), until: iso(now - D) }) })));
  check('not started yet (from in the future): refused', !hasApiAccessFor(solo({ staffImport: imp({ from: iso(now + D), until: iso(now + 5 * D) }) })));
  check('closed by I2 (endedAt in the past): refused, but the window is kept', !hasApiAccessFor(solo({ staffImport: imp({ endedAt: iso(now - 60_000) }) })) && staffImportWindowFor(solo({ staffImport: imp({ endedAt: iso(now - 60_000) }) })) != null);
  check('year-2099 date cannot leave it on forever: clamped to 60 days from start', (() => { const s = staffImportFor(solo({ staffImport: imp({ from: iso(now - 61 * D), until: '2099-01-01T00:00:00Z' }) })); return s && s.active === false && s.end.getTime() === new Date(iso(now - 61 * D)).getTime() + STAFF_IMPORT_MAX_DAYS * D; })());
  check('a start 50 days ago with until in 2099 is still on, but only for 10 more days', (() => { const s = staffImportFor(solo({ staffImport: imp({ from: iso(now - 50 * D), until: '2099-01-01T00:00:00Z' }) })); return s.active && s.end.getTime() - now < 10.1 * D; })());
  for (const [name, bad] of [['not an object', 'yes'], ['array', []], ['missing dates', { pages: 100 }], ['garbage dates', { from: 'x', until: 'y', pages: 100 }], ['numeric dates', { from: 1, until: 99999999999999, pages: 100 }], ['no page budget', { from: iso(now - H), until: iso(now + D) }], ['zero pages', imp({ pages: 0 })], ['negative pages', imp({ pages: -5 })], ['text pages', imp({ pages: 'lots' })], ['boolean true', true]]) {
    check(`malformed override (${name}) grants nothing`, !hasApiAccessFor(solo({ staffImport: bad })) && staffImportFor(solo({ staffImport: bad }))?.active !== true);
  }
  check('hasApiAccess(plan) itself is unchanged (Fleet only)', ['solo', 'shop', 'crew'].every((p) => !hasApiAccess(p)) && hasApiAccess('fleet'));
  // pure gate
  const win = { staffImport: imp({ pages: 1000, documents: 500 }) };
  const g1 = gateUpload(solo(win), { documentsStored: 10, pagesThisMonth: 750, pendingPages: 0, importPagesUsed: 100 });
  check('on: a Solo shop already AT its 750-page monthly cap can still upload, against the import budget', g1.allowed === true && g1.importMode === true && g1.pagesRemaining === 900, JSON.stringify(g1));
  const g2 = gateUpload(solo(win), { documentsStored: 10, pagesThisMonth: 0, pendingPages: 50, importPagesUsed: 950 });
  check('on: when the import budget is used up (pages + pending) -> 402 with the machine code and a staff-facing message', g2.allowed === false && g2.status === 402 && g2.code === 'import-allowance-exhausted' && /1,000 pages/.test(g2.error) && /DeepWell staff can raise/.test(g2.error), JSON.stringify(g2));
  const g3 = gateUpload(solo({}), { documentsStored: 10, pagesThisMonth: 750, pendingPages: 0 });
  check('off: the same shop is refused with the normal monthly message', g3.allowed === false && /Monthly page limit reached \(750\)/.test(g3.error) && !g3.code);
  const g4 = gateUpload(solo({ staffImport: imp({ from: iso(now - 20 * D), until: iso(now - D), pages: 1000 }) }), { documentsStored: 10, pagesThisMonth: 750, pendingPages: 0, importPagesUsed: 0 });
  check('expired: refused with the normal monthly message again', g4.allowed === false && /Monthly page limit reached/.test(g4.error));
  const g5 = gateUpload(solo(win), { documentsStored: 25_000, pagesThisMonth: 0, importPagesUsed: 0 });
  check('on: the stored-document cap is raised by `documents` (25,000 + 500)', g5.allowed === true && g5.documentsRemaining === 500, JSON.stringify(g5));
  const g6 = gateUpload(solo(win), { documentsStored: 25_500, pagesThisMonth: 0, importPagesUsed: 0 });
  check('on: past the raised document cap -> 402', g6.allowed === false && g6.code === 'import-documents-exhausted');
  const g7 = gateUpload({ plan: 'solo', billing_status: 'canceled', limits: win }, { documentsStored: 0, pagesThisMonth: 0, importPagesUsed: 0 });
  check('the override does NOT replace a missing/cancelled subscription (still "choose a plan")', g7.allowed === false && /Choose a plan/.test(g7.error));
  check('batchLimitMessage names the import allowance only while it is active', /temporary page allowance/.test(PLAN.batchLimitMessage('pages', solo(win))) && /Monthly page limit/.test(PLAN.batchLimitMessage('pages', solo({}))));
}

// ============================================================================================= B2 database: keys, gate, monthly allowance
family = 'override-db';
{
  const A = 'org_r43_a', B = 'org_r43_b';
  const idA = await newTenant(A, 'solo');
  const idB = await newTenant(B, 'solo');
  const ctxA = { tenantKey: A, tenantName: A };
  // --- API key creation / use
  const off = await KEYS.createApiKey(ctxA, authFor(A), { name: 'DeepWell staff import', scopes: ['ingest', 'read'] });
  check('override OFF: a Solo company cannot create an API key (403 Fleet-only message)', off.status === 403 && /Fleet plan/.test(off.body.error), JSON.stringify(off.body));
  await setLimits(idA, { staffImport: imp() });
  const on = await KEYS.createApiKey(ctxA, authFor(A), { name: 'DeepWell staff import', scopes: ['ingest', 'read'] });
  check('override ON: the same Solo company can create the import key (201)', on.status === 201 && /^dw_live_[0-9a-f]{64}$/.test(on.body.key), JSON.stringify({ ...on.body, key: undefined }));
  const authOn = await AUTHK.verifyApiKey(on.body.key);
  check('override ON: the key authenticates, bound to that company and the scopes it was given', authOn.tenantId === A && authOn.viaKey === true && authOn.scopes.includes('ingest'));
  await setLimits(idA, { staffImport: imp({ from: iso(now - 20 * D), until: iso(now - D) }) });
  await throws('override EXPIRED: the very same key stops working (403)', () => AUTHK.verifyApiKey(on.body.key), /Fleet plan/, 403);
  const exp = await KEYS.createApiKey(ctxA, authFor(A), { name: 'late', scopes: ['ingest'] });
  check('override EXPIRED: creating a new key is refused again', exp.status === 403);
  await setLimits(idA, { staffImport: imp({ endedAt: iso(now - 1000) }) });
  await throws('override CLOSED by I2: the key stops working (403)', () => AUTHK.verifyApiKey(on.body.key), /Fleet plan/, 403);
  await setLimits(idA, { staffImport: imp() });
  check('re-opened: the same key works again (nothing was deleted)', (await AUTHK.verifyApiKey(on.body.key)).tenantId === A);
  // --- tenant isolation: B is a separate company and gets nothing
  const offB = await KEYS.createApiKey({ tenantKey: B, tenantName: B }, authFor(B), { name: 'x', scopes: ['ingest'] });
  check('tenant isolation: company B (override never opened) still cannot create keys while A has it on', offB.status === 403);
  const gB = await UP.checkUploadGate(authFor(B));
  check('tenant isolation: B has no importMode and no import allowance', gB.allowed === true && !gB.importMode);
  check('tenant isolation: A\'s key cannot read B (the key resolves only to A)', (await AUTHK.verifyApiKey(on.body.key)).tenantId !== B);

  // --- gate against the database: monthly allowance untouched
  const start = new Date(now - H).toISOString();
  await seedPages(idA, 800, new Date(now - 30 * 60_000).toISOString()); // 800 pages read INSIDE the window (Solo's monthly cap is 750)
  resetCaches();
  const gateOn = await UP.checkUploadGate(authFor(A));
  check('db: 800 import pages read, Solo cap 750, override ON: still allowed, 4,200 of the 5,000-page import budget left', gateOn.allowed === true && gateOn.importMode === true && gateOn.pagesRemaining === 4200, JSON.stringify({ ...gateOn, billingRow: undefined }));
  const storeCount = await RS.withTenant(ctxA, (db) => db.countPagesSince(new Date(now - 30 * D).toISOString(), staffImportWindowFor({ limits: { staffImport: imp() } })));
  eq('db: the monthly page count EXCLUDES pages read during the import', storeCount, 0);
  const defaultCount = await RS.withTenant(ctxA, (db) => db.countPagesSince(new Date(now - 30 * D).toISOString()));
  eq('db: the plain one-argument call (bootstrap, billing status, support) finds the window itself and also excludes the import pages', defaultCount, 0);
  const rawCount = await RS.withTenant(ctxA, (db) => db.countPagesSince(new Date(now - 30 * D).toISOString(), null));
  eq('db: without the window the same pages WOULD count (so the exclusion is what protects the allowance)', rawCount, 800);
  await setLimits(idA, { staffImport: imp({ endedAt: iso(now - 1000) }) });
  const gateAfter = await UP.checkUploadGate(authFor(A));
  check('db: after the import is CLOSED the customer still has their whole monthly allowance (800 import pages do not count)', gateAfter.allowed === true && !gateAfter.importMode && gateAfter.pagesRemaining === 750, JSON.stringify({ ...gateAfter, billingRow: undefined }));
  await setLimits(idA, {});
  const gateGone = await UP.checkUploadGate(authFor(A));
  check('db: with NO override on file those same 800 pages count and the shop is refused (proves the test is meaningful)', gateGone.allowed === false && gateGone.status === 402 && /Monthly page limit reached \(750\)/.test(gateGone.error), JSON.stringify(gateGone));
  // customer pages read OUTSIDE the window still count normally
  await setLimits(idA, { staffImport: imp({ from: iso(now - 3 * H), until: iso(now - 2 * H) }) });
  await seedPages(idA, 10, new Date(now - 60_000).toISOString());
  const outside = await RS.withTenant(ctxA, (db) => db.countPagesSince(new Date(now - 30 * D).toISOString(), staffImportWindowFor({ limits: { staffImport: imp({ from: iso(now - 3 * H), until: iso(now - 2 * H) }) } })));
  eq('db: pages read outside the window (normal customer use) still count toward the monthly allowance', outside, 810);
  // budget exhaustion against the database
  await setLimits(idA, { staffImport: imp({ pages: 800 }) });
  const gateFull = await UP.checkUploadGate(authFor(A));
  check('db: import budget of 800 with 800 pages read -> 402 code import-allowance-exhausted', gateFull.allowed === false && gateFull.status === 402 && gateFull.code === 'import-allowance-exhausted', JSON.stringify(gateFull));
  // batch: per-file 402 with the code once the budget is spent
  await setLimits(idA, { staffImport: imp({ pages: 812 }) });
  const gate2 = await UP.checkUploadGate(authFor(A));
  const batch = await UP.createUploadUrls(authFor(A), Array.from({ length: 4 }, (_, i) => ({ filename: `p${i}.pdf`, sha256: rnd(), sizeBytes: 600_000, contentType: 'application/pdf' })), gate2);
  check('db batch: 4 PDFs of ~3 pages against 2 pages of headroom -> first accepted, the rest 402 with the import code', gate2.importMode === true && batch[0].documentId && batch.slice(1).every((x) => x.status === 402 && x.code === 'import-allowance-exhausted' && /temporary page allowance/.test(x.error)), JSON.stringify(batch.map((x) => ({ s: x.status, c: x.code }))));
  // HTTP handler: the single-request 402 carries the code (the tool reads it)
  await setLimits(idA, { staffImport: imp({ pages: 800 }) });
  const apiKeyAuthHdr = { authorization: `Bearer ${on.body.key}` };
  const res = mkRes();
  await quiet(() => UP.default({ method: 'POST', headers: apiKeyAuthHdr, body: { files: [{ filename: 'z.pdf', sha256: rnd(), sizeBytes: 100, contentType: 'application/pdf' }] }, query: {} }, res));
  check('http: POST /api/upload-url with the import key at 0 budget -> 402 with { error, code }', res.statusCode === 402 && res.body?.code === 'import-allowance-exhausted' && /allowance/.test(res.body.error), JSON.stringify(res));
  await setLimits(idA, { staffImport: imp({ pages: 100000 }) });
  const res2 = mkRes();
  await quiet(() => UP.default({ method: 'POST', headers: apiKeyAuthHdr, body: { files: [{ filename: 'y.pdf', sha256: rnd(), sizeBytes: 5000, contentType: 'application/pdf' }] }, query: {} }, res2));
  check('http: the same call with budget left -> 200 and a presigned upload URL (the import key works on /api/upload-url on a Solo plan)', res2.statusCode === 0 || res2.statusCode === 200 ? Boolean(res2.body?.results?.[0]?.documentId) : false, JSON.stringify(res2));
  check('billing screen status carries only the end date while active (no budget numbers leak to the customer UI)', /staffImport: staffImport\?\.active \? \{ until:/.test(read('api/billing.js')));
}

// ============================================================================================= B3 rate and model ceilings
family = 'override-rates';
{
  const lim = (limits, bucket = 'ingest', ov) => RL.limitsFromTenantContext({ plan: 'solo', ...limits }, bucket, ov);
  const base = lim({});
  const on = lim({ staffImport: imp({ ingestPerMinute: 777, ingestPerDay: 123_456 }) });
  check('ingest ceilings: ON -> the override numbers; OFF -> the plan\'s own numbers', on.perMinute === 777 && on.perDay === 123_456 && base.perMinute !== 777 && base.perDay !== 123_456, JSON.stringify({ on, base }));
  const expired = lim({ staffImport: imp({ ingestPerMinute: 777, ingestPerDay: 123_456, from: iso(now - 20 * D), until: iso(now - D) }) });
  check('ingest ceilings: EXPIRED -> back to the plan\'s numbers', expired.perMinute === base.perMinute && expired.perDay === base.perDay);
  const explicit = lim({ staffImport: imp({ ingestPerMinute: 777 }), ingest: { perMinute: 5 } });
  check('an explicit limits.ingest owner override still wins over the staff import', explicit.perMinute === 5);
  const ask = lim({ staffImport: imp({ ingestPerMinute: 777 }) }, 'ask');
  check('only the ingest bucket is affected (ask is untouched)', ask.perMinute !== 777);
  const budgetOf = async (key, limits) => { const id = await newTenant(key, 'solo'); await setLimits(id, limits); return (await RL.getDailyModelBudgetStatus({ tenantKey: key, tenantName: key })).limit; };
  const dflt = await budgetOf('org_r43_m0', {});
  const onB = await budgetOf('org_r43_m1', { staffImport: imp({ maxModelCallsPerDay: 150_000 }) });
  const expB = await budgetOf('org_r43_m2', { staffImport: imp({ maxModelCallsPerDay: 150_000, from: iso(now - 20 * D), until: iso(now - D) }) });
  const ownB = await budgetOf('org_r43_m3', { maxModelCallsPerDay: 321, staffImport: imp({ maxModelCallsPerDay: 150_000 }) });
  check('daily AI-call ceiling: ON 150,000; OFF and EXPIRED the plan default; an explicit owner override still wins', onB === 150_000 && dflt < 150_000 && expB === dflt && ownB === 321, JSON.stringify({ dflt, onB, expB, ownB }));
}

// ============================================================================================= B4 customers cannot self-grant
family = 'no-self-grant';
{
  const C = 'org_r43_c';
  const idC = await newTenant(C, 'solo');
  const before = JSON.stringify((await lite.query('SELECT limits, settings FROM tenants WHERE id = $1', [idC])).rows[0]);
  const hostile = { limits: { staffImport: imp() }, staffImport: imp(), settings: { staffImport: imp() }, tenants: { limits: { staffImport: imp() } }, plan: 'fleet', pages: 99999999, extraPagesPerMonth: 99999999 };
  const call = async (body) => { const res = mkRes(); await quiet(() => RECORDS.processRecords({ method: 'POST', headers: {}, body }, res, authFor(C))); return res; };
  const docRes = await call({ action: 'createDocument', original_filename: 'x.pdf', sha256_hash: rnd(), content_type: 'application/pdf', file_size_bytes: 1000, ...hostile });
  const docId = docRes.body?.id;
  const actions = [
    { action: 'updateDocument', id: docId, updates: { ...hostile, original_filename: 'renamed.pdf' } },
    { action: 'updateDocument', id: docId, ...hostile },
    { action: 'createFacet', document_id: docId, ...hostile },
    { action: 'createExtraction', document_id: docId, field_key: 'serial', value: 'x', ...hostile },
    { action: 'createEntity', type: 'customer', name: 'Hostile', ...hostile },
    { action: 'logAction', ...hostile, resource_type: 'x' },
    { action: 'createProposal', ...hostile },
    { action: 'incrementSchemaVersion', ...hostile },
    { action: 'bootstrap', ...hostile },
    { action: 'getAuditLog', filters: hostile },
    { action: 'listDocuments', filters: hostile },
  ];
  for (const a of actions) await call(a);
  const after = JSON.stringify((await lite.query('SELECT limits, settings FROM tenants WHERE id = $1', [idC])).rows[0]);
  check('every /api/records action given hostile staffImport/limits/plan/pages fields leaves tenants.limits and settings byte-for-byte unchanged', before === after, `${before} -> ${after}`);
  resetCaches();
  const rowC = await tenantRow(C);
  check('...and the company still has no staff import: no API access, no import mode', !hasApiAccessFor(rowC) && staffImportFor(rowC) === null);
  const k = await KEYS.createApiKey({ tenantKey: C, tenantName: C }, authFor(C), { name: 'DeepWell staff import', scopes: ['ingest'], limits: { staffImport: imp() }, staffImport: imp() });
  check('POST /api/keys with a hostile body still returns 403 for a Solo company', k.status === 403);
  const gate = await UP.checkUploadGate(authFor(C));
  check('the upload gate for that company is the normal one (no import mode)', gate.allowed === true && !gate.importMode);
  // settings is a different column: a fake staffImport placed there grants nothing
  await lite.query(`UPDATE tenants SET settings = jsonb_build_object('staffImport', $2::jsonb) WHERE id = $1`, [idC, JSON.stringify(imp())]);
  resetCaches();
  check('a staffImport object placed in tenants.settings (the column customers\' own features write) grants nothing', !hasApiAccessFor(await tenantRow(C)));
  // Donovan's SQL tool cannot touch tenants
  for (const sql of ["UPDATE tenants SET limits = '{}'", "SELECT limits FROM tenants", "SELECT id FROM tenants WHERE limits ? 'staffImport'", "WITH t AS (UPDATE tenants SET limits = '{}' RETURNING 1) SELECT * FROM t", "SELECT 1; UPDATE tenants SET limits = '{}'"]) {
    check(`Donovan's read-only SQL guard refuses: ${sql.slice(0, 50)}`, GUARD.guardSql(sql).ok === false);
  }
  // static: nothing in api/ writes tenants.limits except billing_apply (the Stripe path), and nothing reads staffImport from a request
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(js|ts|mjs)$/.test(e.name) ? [path.join(dir, e.name)] : []));
  const apiFiles = walk(rel('api'));
  const writers = apiFiles.filter((f) => /UPDATE\s+tenants[\s\S]{0,300}?\blimits\b\s*=/i.test(fs.readFileSync(f, 'utf8')) || /INSERT\s+INTO\s+tenants[^;]{0,300}\blimits\b/i.test(fs.readFileSync(f, 'utf8')));
  check('static: no API code anywhere updates or inserts tenants.limits (only the SQL function billing_apply and owner SQL do)', writers.length === 0, writers.join(', '));
  const fromRequest = apiFiles.filter((f) => /(body|payload|req\.query|query)\??\.\s*(staffImport|limits)\b/.test(fs.readFileSync(f, 'utf8')));
  check('static: no API code reads staffImport or limits out of a request body/query', fromRequest.length === 0, fromRequest.join(', '));
  const readers = apiFiles.filter((f) => /staffImport/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(root, f)).sort();
  check('static: staffImport is referenced only by the code that reads it for the gate, keys, limits and status', readers.every((f) => ['api/_lib/plan.js', 'api/_lib/rateLimit.js', 'api/billing.js', 'api/upload-url.js', 'api/_lib/recordsStore.js', 'api/_lib/apiKeyAuth.js', 'api/_lib/support/tools.js', 'api/records.ts', 'api/_lib/staffImport.js'].includes(f)), readers.join(', '));
  const stripe = read('api/_lib/billing.js');
  check('static: the Stripe webhook path never reads customer-supplied fields into limits.staffImport', !/staffImport/.test(stripe));
}

// ============================================================================================= B5 migration 66 keeps it across Stripe events
family = 'migration-66';
{
  const id = await newTenant('org_r43_mig', 'solo');
  await setLimits(id, { staffImport: imp(), extraPagesPerMonth: 5 });
  await lite.query(`SELECT billing_apply($1::uuid, $2::jsonb)`, [id, JSON.stringify({ plan: 'shop', billing_status: 'active', limits: { logins: 5, documentsStored: 100000, pagesPerMonth: 2000 } })]);
  const l = (await lite.query('SELECT limits, plan FROM tenants WHERE id = $1', [id])).rows[0];
  check('a Stripe subscription event replaces the plan limits but KEEPS the staff import and other owner overrides', l.plan === 'shop' && l.limits.staffImport?.pages === 5000 && l.limits.extraPagesPerMonth === 5 && l.limits.pagesPerMonth === 2000, JSON.stringify(l));
  check('migration 66 file keeps every key migration 62 kept and adds staffImport', ['extraPagesPerMonth', 'maxModelCallsPerDay', 'testAccount', "'ask'", "'ingest'", "'read'", "'billing'", "'support'", 'staffImport'].every((k) => read('M3-config/66-staff-import-override.sql').includes(k)));
  check('migration 66 is the next number (after 65) and is idempotent (CREATE OR REPLACE)', fs.existsSync(rel('M3-config/66-staff-import-override.sql')) && fs.existsSync(rel('M3-config/65-scale-donovan-and-customers.sql')) && /CREATE OR REPLACE FUNCTION billing_apply/.test(read('M3-config/66-staff-import-override.sql')));
  check('the harness applied migration 66 (it is picked up by the normal migration order)', h.applied.includes('66-staff-import-override.sql'), h.skipped.join(' | '));
}

// ============================================================================================= B6 the I1 / I2 SQL files
family = 'sql-templates';
{
  const I1 = read('M3-config/import/I1-allow-staff-import.sql');
  const I2 = read('M3-config/import/I2-end-staff-import.sql');
  const PLACEHOLDER = "'TYPE THE COMPANY NAME OR ID HERE'";
  check('each template has exactly ONE clearly marked line to edit', (I1.match(/^\s+-- >>> EDIT THIS LINE <<</gm) ?? []).length === 1 && (I2.match(/^\s+-- >>> EDIT THIS LINE <<</gm) ?? []).length === 1 && I1.includes(PLACEHOLDER) && I2.includes(PLACEHOLDER));
  check('each template opens with a plain-English header (WHAT THIS DOES, IN PLAIN ENGLISH / HOW TO USE IT / SAFE TO RUN AGAIN)', [I1, I2].every((t) => /WHAT THIS DOES, IN PLAIN ENGLISH/.test(t) && /HOW TO USE IT/.test(t) && /SAFE TO RUN AGAIN/.test(t)));
  const run = async (tpl, company) => { const out = await lite.exec(tpl.replace(PLACEHOLDER, `'${company.replace(/'/g, "''")}'`)); return out; };
  const lastRows = (out) => out[out.length - 1].rows;
  const limitsOf = async (id) => (await lite.query('SELECT limits FROM tenants WHERE id = $1', [id])).rows[0].limits;
  const errOf = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message); } };

  const id = await newTenant('org_r43_sql', 'solo');
  await lite.query(`UPDATE tenants SET name = 'Acme Heating & Air' WHERE id = $1`, [id]);
  await lite.query(`UPDATE tenants SET limits = '{"extraPagesPerMonth": 7, "ask": {"perMinute": 9}}'::jsonb WHERE id = $1`, [id]);

  check('unedited placeholder: stops with a plain message and changes nothing', /Edit the line marked/.test(await errOf(() => lite.exec(I1))) && !(await limitsOf(id)).staffImport);
  check('unknown company: stops with a plain message', /No company matches/.test(await errOf(() => run(I1, 'Nobody Inc'))));
  const dup1 = await newTenant('org_r43_dup1', 'solo'); const dup2 = await newTenant('org_r43_dup2', 'solo');
  await lite.query(`UPDATE tenants SET name = 'Twin Plumbing' WHERE id IN ($1,$2)`, [dup1, dup2]);
  check('two companies with the same name: stops and asks for the id, changes neither', /2 companies match/.test(await errOf(() => run(I1, 'Twin Plumbing'))) && !(await limitsOf(dup1)).staffImport && !(await limitsOf(dup2)).staffImport);

  // before migration 66 is pasted: refuses with a clear message (code keeps working)
  const fnDef62 = read('M3-config/62-rate-limit-refund-and-owner-overrides.sql').match(/CREATE OR REPLACE FUNCTION billing_apply[\s\S]*?\$\$;/)[0];
  await lite.exec(fnDef62);
  const e66 = await errOf(() => run(I1, 'Acme Heating & Air'));
  check('before migration 66 is pasted, I1 refuses with a clear message and changes nothing', /Paste M3-config\/66-staff-import-override\.sql first/.test(e66 ?? '') && !(await limitsOf(id)).staffImport, e66);
  await lite.exec(read('M3-config/66-staff-import-override.sql'));

  const out1 = await run(I1, 'acme heating & air'); // case-insensitive name
  const rows1 = lastRows(out1);
  const lim1 = await limitsOf(id);
  check('I1 opens the import: BEFORE and AFTER rows are shown, BEFORE empty, AFTER has the dates and numbers', rows1.length === 2 && rows1[0].when === 'BEFORE' && rows1[0].staff_import == null && rows1[1].when === 'AFTER' && rows1[1].staff_import?.pages === 250000, JSON.stringify(rows1));
  const s1 = staffImportFor({ limits: lim1 });
  check('I1: starts now, ends in about 14 days, never more than 60, active in the app\'s own rules', s1 && s1.active && Math.abs(s1.end.getTime() - (Date.now() + 14 * D)) < 2 * H && Math.abs(s1.from.getTime() - Date.now()) < 2 * H);
  check('I1 sets the higher ingest and AI-call ceilings inside the override (so they expire with it)', lim1.staffImport.ingestPerMinute === 600 && lim1.staffImport.maxModelCallsPerDay === 150000 && lim1.staffImport.documents === 100000);
  check('I1 left the company\'s other owner overrides alone', lim1.extraPagesPerMonth === 7 && lim1.ask?.perMinute === 9, JSON.stringify(lim1));
  resetCaches();
  check('the app now treats the company as in an active staff import (Solo plan, API keys allowed)', hasApiAccessFor(await tenantRow('org_r43_sql')));
  // idempotent: run again by id; from preserved, until refreshed, nothing duplicated
  await lite.query(`UPDATE tenants SET limits = jsonb_set(limits, '{staffImport,until}', to_jsonb($2::text)) WHERE id = $1`, [id, iso(now + 2 * D)]);
  const out2 = await run(I1, id);
  const lim2 = await limitsOf(id);
  check('I1 again (by company id): idempotent - still open, same start time, end date moved out to a fresh 14 days, one staffImport object', lim2.staffImport.from === lim1.staffImport.from && Date.parse(lim2.staffImport.until) > now + 13 * D && Object.keys(lim2).filter((k) => k === 'staffImport').length === 1 && lastRows(out2).length === 2);
  check('I1 by Clerk org id also resolves the company', !(await errOf(() => run(I1, 'org_r43_sql'))));

  // keys created during the import
  await lite.query(`INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash, scopes, created_at) VALUES ($1,'DeepWell staff import 1','aaaa1111',$2,'{ingest}', now()), ($1,'Dispatch system','bbbb2222',$3,'{read}', now())`, [id, rnd(), rnd()]);
  const out3 = await run(I2, 'Acme Heating & Air');
  const lim3 = await limitsOf(id);
  const rows3 = out3[out3.length - 2].rows;
  check('I2 closes it: endedAt is set, the window dates stay on file, BEFORE/AFTER rows are shown', Boolean(lim3.staffImport.endedAt) && lim3.staffImport.from === lim2.staffImport.from && rows3.length === 2 && rows3[1].staff_import?.endedAt, JSON.stringify(rows3));
  resetCaches();
  check('I2: the app no longer treats it as active (API access gone, import budget gone)', !hasApiAccessFor(await tenantRow('org_r43_sql')) && staffImportFor(await tenantRow('org_r43_sql')).active === false);
  const keys = (await lite.query('SELECT name, revoked_at FROM api_keys WHERE tenant_id = $1 ORDER BY name', [id])).rows;
  check('I2 revokes the import key the customer made but leaves their other key alone, and lists what is still active', keys.find((k) => /import/i.test(k.name)).revoked_at && !keys.find((k) => k.name === 'Dispatch system').revoked_at && out3[out3.length - 1].rows.some((r) => r.name === 'Dispatch system'));
  const out4 = await run(I2, 'Acme Heating & Air');
  const lim4 = await limitsOf(id);
  check('I2 again: says it was already closed and changes nothing (the end time is not moved)', lim4.staffImport.endedAt === lim3.staffImport.endedAt && out4.length > 0);
  const out5 = await run(I2, 'Twin Plumbing').catch((e) => e);
  check('I2 refuses an ambiguous name too', out5 instanceof Error && /companies match/.test(out5.message));
  const other = await newTenant('org_r43_sql_none', 'solo');
  await lite.query(`UPDATE tenants SET name = 'Never Imported LLC' WHERE id = $1`, [other]);
  await run(I2, 'Never Imported LLC');
  check('I2 on a company that never had an import changes nothing', !(await limitsOf(other)).staffImport);
  // re-open after close (within 30 days): keeps the original start so the excluded window has no gap, clears endedAt
  const REOPEN = /v_reopen\s+boolean\s+:=\s+false;/;
  check('I1 pasted again AFTER I2 does NOT quietly re-open the import (an old tab / saved query must fail closed); it says how to do it on purpose', REOPEN.test(I1)
    && /already CLOSED/.test(await errOf(() => run(I1, 'Acme Heating & Air'))) && (await limitsOf(id)).staffImport.endedAt === lim3.staffImport.endedAt);
  await lite.exec(I1.replace(REOPEN, 'v_reopen boolean := true;').replace(PLACEHOLDER, "'Acme Heating & Air'"));
  const lim6 = await limitsOf(id);
  check('re-opening after I2: the original start is kept, endedAt is cleared, the import is active again', lim6.staffImport.from === lim1.staffImport.from && !lim6.staffImport.endedAt && staffImportFor({ limits: lim6 }).active);
  // other companies untouched by all of this
  const rowOther = (await lite.query('SELECT limits FROM tenants WHERE id = $1', [other])).rows[0].limits;
  check('other companies were never touched by I1 or I2', !rowOther.staffImport && !(await limitsOf(dup1)).staffImport);
  check('templates sit in a subfolder so the normal migration runner never applies them by accident', !h.applied.some((f) => /^I[12]-/.test(f)) && fs.existsSync(rel('M3-config/import/I1-allow-staff-import.sql')));
}

// ============================================================================================= B6b reviewer hardening
family = 'review-hardening';
{
  const SI = await import(rel('api/_lib/staffImport.js'));
  const { STAFF_IMPORT_CEILINGS, noteDatabaseClock, _resetDatabaseClock } = SI;
  const sf = (over = {}, n = undefined) => staffImportFor({ limits: { staffImport: { ...imp(), ...over } } }, n);
  const active = (over) => sf(over)?.active === true;
  // --- malformed values deny
  check('a start/end date WITHOUT a zone denies (it would be read in the server\'s local time)', !active({ from: iso(now - H).replace('Z', '') }) && !active({ until: iso(now + D).replace('Z', '') }) && active({ from: iso(now - H).replace('Z', '+00:00') }));
  check('a page budget that is an array, boolean, object, zero, negative, fraction or text denies the whole grant', [[5000], true, { n: 1 }, 0, -5, 1.5, 'lots', null].every((p) => !active({ pages: p })) && active({ pages: '5000' }));
  check('a close marker (endedAt) that is present but unreadable still CLOSES it (fails closed, never open)', !active({ endedAt: 'garbage' }) && !active({ endedAt: 12345 }) && sf({ endedAt: 'garbage' })?.end instanceof Date);
  // --- hard ceilings: an extra zero cannot remove a limit
  const big = sf({ pages: 99_999_999_999, documents: 99_999_999, ingestPerMinute: 999_999, ingestPerDay: 999_999_999, maxModelCallsPerDay: 99_999_999, maxModelCalls: 999_999_999 });
  check('every number is clamped to a hard ceiling in the app (page budget, documents, uploads per minute/day, AI calls per day and in total)',
    big.pages === STAFF_IMPORT_CEILINGS.pages && big.documents === STAFF_IMPORT_CEILINGS.documents && big.ingestPerMinute === STAFF_IMPORT_CEILINGS.ingestPerMinute
    && big.ingestPerDay === STAFF_IMPORT_CEILINGS.ingestPerDay && big.maxModelCallsPerDay === STAFF_IMPORT_CEILINGS.maxModelCallsPerDay && big.maxModelCalls === STAFF_IMPORT_CEILINGS.maxModelCalls, JSON.stringify(big));
  check('the whole-import model-call ceiling defaults to 4 calls per budgeted page', sf({ pages: 800 }).maxModelCalls === 3200 && sf({ pages: 800, maxModelCalls: 5000 }).maxModelCalls === 5000);
  // --- the database's clock decides, not this server's
  noteDatabaseClock(new Date(Date.now() + 2 * H));
  check('database clock 2 h AHEAD of this server: an import this server thinks has 1 h left is already over', sf({ from: iso(now - 5 * H), until: iso(now + H) }).active === false && sf({ from: iso(now - 5 * H), until: iso(now + 3 * H) }).active === true);
  noteDatabaseClock(new Date(Date.now() - 2 * H));
  check('database clock 2 h BEHIND: an import this server thinks ended 1 h ago is still running (the database is the authority)', sf({ from: iso(now - 5 * H), until: iso(now - H) }).active === true);
  noteDatabaseClock('not a date'); noteDatabaseClock(undefined);
  check('an unreadable database time is ignored (the last good difference stays)', sf({ from: iso(now - 5 * H), until: iso(now - H) }).active === true);
  _resetDatabaseClock();
  check('with no skew the plain rule applies again', sf({ from: iso(now - 5 * H), until: iso(now - H) }).active === false);
  check('the 60-day maximum still holds (a 300-day "until" is cut to from + 60 days)', Math.abs(sf({ from: iso(now - H), until: iso(now + 300 * D) }).end.getTime() - (now - H + 60 * D)) < 2000);

  // --- a key must stop AT USE TIME when the import is closed, even while this server still holds the old row in its cache
  const K = 'org_r43_stale'; const idK = await newTenant(K, 'solo');
  await setLimits(idK, { staffImport: imp() });
  const kk = await KEYS.createApiKey({ tenantKey: K, tenantName: K }, authFor(K), { name: 'plain name, not an import name', scopes: ['ingest'] });
  check('a key created inside the window works (and warms the cached billing row)', kk.status === 201 && (await AUTHK.verifyApiKey(kk.body.key)).tenantId === K);
  await lite.query(`UPDATE tenants SET limits = jsonb_set(limits, '{staffImport,endedAt}', to_jsonb($2::text)) WHERE id = $1`, [idK, iso(Date.now() - 1000)]); // I2 by hand, WITHOUT clearing any cache
  await throws('I2 run while the old row is still cached: the key is refused on its very next request (checked against the database, not the cache)', () => AUTHK.verifyApiKey(kk.body.key), /Fleet plan/, 403);
  await lite.query(`UPDATE tenants SET limits = limits - 'staffImport' WHERE id = $1`, [idK]);
  await throws('and with no override on file at all', () => AUTHK.verifyApiKey(kk.body.key), /Fleet plan/, 403);
  // a Fleet company's key never needs the import and pays no extra lookup
  const fl = await newTenant('org_r43_fleet', 'fleet');
  const fk = await KEYS.createApiKey({ tenantKey: 'org_r43_fleet', tenantName: 'org_r43_fleet' }, authFor('org_r43_fleet'), { name: 'dispatch', scopes: ['read'] });
  h.stats.queryLog = [];
  const fa = await AUTHK.verifyApiKey(fk.body.key);
  const extra = h.stats.queryLog.filter((q) => /get_tenant_limits\(\$1::uuid\) AS limits, now\(\)/.test(q)).length;
  h.stats.queryLog = null;
  check('a Fleet key still works and makes no extra import-window lookup', fa.tenantId === 'org_r43_fleet' && extra === 0, String(extra));

  // --- Stripe (billing_apply) can neither undo I2, nor write/extend/re-open an import
  const S = await newTenant('org_r43_stripe', 'solo', 'active', { extraPagesPerMonth: 7, staffImport: imp({ endedAt: iso(now - 1000) }) });
  await lite.query(`SELECT billing_apply($1::uuid, $2::jsonb)`, [S, JSON.stringify({ plan: 'solo', limits: { logins: 2, staffImport: imp() } })]); // a stale copy that still says "open"
  const ls = (await lite.query('SELECT limits FROM tenants WHERE id = $1', [S])).rows[0].limits;
  check('a webhook carrying a stale OPEN copy cannot undo I2: the database\'s endedAt stays, the plan\'s own keys still apply, owner keys survive', ls.staffImport.endedAt && ls.logins === 2 && ls.extraPagesPerMonth === 7, JSON.stringify(ls));
  const N = await newTenant('org_r43_nostripe', 'solo');
  await lite.query(`SELECT billing_apply($1::uuid, $2::jsonb)`, [N, JSON.stringify({ plan: 'solo', limits: { logins: 2, staffImport: imp() } })]);
  check('a patch cannot OPEN an import that DeepWell staff did not open', !(await lite.query('SELECT limits FROM tenants WHERE id = $1', [N])).rows[0].limits.staffImport);
  await lite.query(`SELECT billing_apply($1::uuid, $2::jsonb)`, [S, JSON.stringify({ plan: 'solo', limits: null })]);
  await lite.query(`SELECT billing_apply($1::uuid, $2::jsonb)`, [S, JSON.stringify({ plan: 'solo', limits: [1, 2] })]);
  check('a null or non-object limits patch does not break the function and keeps the import record', Boolean((await lite.query('SELECT limits FROM tenants WHERE id = $1', [S])).rows[0].limits.staffImport?.endedAt));
  const defS = (await lite.query(`SELECT p.prosecdef, p.proconfig::text AS cfg FROM pg_proc p WHERE p.proname = 'billing_apply'`)).rows[0];
  check('billing_apply stays SECURITY DEFINER with a pinned search_path that ends in pg_temp', defS.prosecdef === true && /search_path=public, pg_temp/.test(defS.cfg), defS.cfg);

  // --- whole-import ceiling on model calls (a hard stop that retries cannot slip past), per company only
  const M = 'org_r43_calls'; const idM = await newTenant(M, 'solo');
  await setLimits(idM, { staffImport: imp({ pages: 10 }) }); // 4 calls per page -> 40 calls in total for this import
  const M2 = 'org_r43_calls_other'; const idM2 = await newTenant(M2, 'solo');
  await setLimits(idM2, { staffImport: imp({ pages: 10 }) });
  const today = new Date().toISOString().slice(0, 10);
  await lite.query(`SELECT * FROM increment_usage_counters($1::uuid, $2::date, 0, 39, 0, 0)`, [idM, today]);
  const st1 = await RL.getDailyModelBudgetStatus({ tenantKey: M, tenantName: M });
  check('model calls: 39 of 40 whole-import calls used -> still allowed', st1.exceeded === false, JSON.stringify(st1));
  await lite.query(`SELECT * FROM increment_usage_counters($1::uuid, $2::date, 0, 1, 0, 0)`, [idM, today]);
  const st2 = await RL.getDailyModelBudgetStatus({ tenantKey: M, tenantName: M });
  check('model calls: the 40th call spends the whole-import ceiling -> exceeded, scope import-total', st2.exceeded === true && st2.scope === 'import-total' && st2.limit === 40, JSON.stringify(st2));
  let thrown = null; try { await RL.assertModelBudget({ tenantKey: M, tenantName: M }); } catch (e) { thrown = e; }
  check('assertModelBudget throws the import-specific message (not "resumes tomorrow")', thrown?.name === 'ModelBudgetExceededError' && /data import is used up/.test(thrown.message) && thrown.message === RL.IMPORT_MODEL_CALLS_MESSAGE, thrown?.message);
  const st3 = await RL.getDailyModelBudgetStatus({ tenantKey: M2, tenantName: M2 });
  check('model calls: a second company with its own import is unaffected', st3.exceeded === false);
  await lite.query(`SELECT * FROM increment_usage_counters($1::uuid, $2::date, 0, 45, 0, 0)`, [idM2, today]);
  await setLimits(idM2, {}); // no import on file: the ordinary daily number applies, and 45 calls is nowhere near it
  const st4 = await RL.getDailyModelBudgetStatus({ tenantKey: M2, tenantName: M2 });
  check('model calls: with no import on file the ceiling does not exist and the ordinary daily budget is unchanged', st4.exceeded === false && st4.scope === undefined && st4.limit < 150_000 && st4.limit > 0, JSON.stringify(st4));

  // --- the upload gate fails CLOSED while an import is active (a broken page count must not become "no page cap")
  const G = 'org_r43_gate'; const idG = await newTenant(G, 'solo'); const G2 = 'org_r43_gate_plain'; await newTenant(G2, 'solo');
  await setLimits(idG, { staffImport: imp() });
  await lite.exec('ALTER TABLE document_pages RENAME TO document_pages_off');
  let gOn, gOff;
  try { gOn = await quiet(() => UP.checkUploadGate(authFor(G))); gOff = await quiet(() => UP.checkUploadGate(authFor(G2))); } finally { await lite.exec('ALTER TABLE document_pages_off RENAME TO document_pages'); }
  check('import active + the page count cannot be read: the gate REFUSES (503, retried by the tool), it does not wave uploads through', gOn.allowed === false && gOn.status === 503, JSON.stringify(gOn));
  check('no import: the long-standing fail-open behaviour for a broken lookup is unchanged', gOff.allowed === true, JSON.stringify(gOff));

  // --- SQL templates: ceilings
  const I1x = read('M3-config/import/I1-allow-staff-import.sql');
  const nameRow = await newTenant('org_r43_ceil', 'solo'); await lite.query(`UPDATE tenants SET name = 'Ceiling Co' WHERE id = $1`, [nameRow]);
  const tooBig = I1x.replace(/v_pages\s+int\s+:= 250000;/, 'v_pages int := 99999999;').replace("'TYPE THE COMPANY NAME OR ID HERE'", "'Ceiling Co'");
  let eBig = null; try { await lite.exec(tooBig); } catch (e) { eBig = String(e.message); }
  check('I1 refuses a page budget above the hard ceiling (an extra zero) and changes nothing', /hard ceiling/.test(eBig ?? '') && !(await lite.query('SELECT limits FROM tenants WHERE id = $1', [nameRow])).rows[0].limits.staffImport);
  const tooLong = I1x.replace(/v_days\s+int\s+:= 14;/, 'v_days int := 61;').replace("'TYPE THE COMPANY NAME OR ID HERE'", "'Ceiling Co'");
  let eLong = null; try { await lite.exec(tooLong); } catch (e) { eLong = String(e.message); }
  check('I1 refuses more than 60 days', /between 1 and 60/.test(eLong ?? ''));

  // --- the tool: a folder swapped for a link after the scan cannot be followed
  const T = await import(pathToFileURL(TOOL).href);
  const jail = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-jail-')); const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-out-'));
  fs.mkdirSync(path.join(jail, 'sub')); fs.writeFileSync(path.join(jail, 'sub', 'a.pdf'), 'x'); fs.writeFileSync(path.join(out, 'a.pdf'), 'secret');
  const rootReal = fs.realpathSync(jail);
  const inside = T.fileStaysInside(rootReal, path.join(rootReal, 'sub', 'a.pdf'));
  fs.rmSync(path.join(jail, 'sub'), { recursive: true }); fs.symlinkSync(out, path.join(jail, 'sub'));
  check('tool: a file stays inside the root until a folder on its path is swapped for a link to outside, then it is refused', inside === true && T.fileStaysInside(rootReal, path.join(rootReal, 'sub', 'a.pdf')) === false);
  fs.rmSync(jail, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true });
}

// ============================================================================================= B7 repo rules
family = 'repo-rules';
{
  const topLevel = fs.readdirSync(rel('api'));
  check('api/ still has 12 top-level files + _lib (13 entries)', topLevel.length === 13 && topLevel.includes('_lib'), topLevel.join(','));
  const pkg = read('package.json');
  check('package.json has verify:r43-import-tool and it is in the verify:all chain', /"verify:r43-import-tool": "tsx scripts\/verify-r43-import-tool\.mjs"/.test(pkg) && /npm run verify:r43-import-tool/.test(pkg.match(/"verify:all": "[^"]*"/)[0]));
  check('the import page of the app shows the key card only while an import is open (ApiAccessCard takes staffImportUntil)', /staffImportUntil/.test(read('src/components/ApiAccessCard.tsx')) && /staffImport\?\.until/.test(read('src/screens/BillingScreen.tsx')));
  check('the runbook exists and names the dry run, I1, I2, the 500-file test and the small-customer shortcut', (() => { const t = read('handoffs/IMPORT_RUNBOOK.md'); return /--dry-run/.test(t) && /I1-allow-staff-import/.test(t) && /I2-end-staff-import/.test(t) && /--limit 500/.test(t) && /under (about )?5,000/.test(t); })());
}

const totals = Object.entries(fam).reduce((a, [, v]) => ({ pass: a.pass + v.pass, fail: a.fail + v.fail }), { pass: 0, fail: 0 });
console.log('\nfamilies:', Object.entries(fam).map(([k, v]) => `${k} ${v.pass}/${v.pass + v.fail}`).join(', '));
console.log(`\nR43 import tool: ${totals.pass} checks passed, ${totals.fail} failed`);
process.exit(failed ? 1 : 0);
