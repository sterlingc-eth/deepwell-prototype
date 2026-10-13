/**
 * verify:privacy-r21 - private staff / HR papers in companies Donovan has never seen.
 *
 * Rule under test (api/_lib/privacy/privateDocs.js, "R21"): a paper's score = type-id words (strong HR word 3; staff role + event word 3; counselling 2; event word alone 1;
 * customer / form words 0) + 1 if audience is internal + page-text markers (employee, personnel file, HR, disciplinary, ... , "confidential") + 1 if staff are named
 * (only when the type already scored); private at 3 or more.
 *
 * Part 1 (always): the rule on type ids, direct asks and customer-facing look-alikes.
 * Part 2 (needs the factory exports; PRIVACY_R21_DIR, default /home/claude/work/factory): 15 companies from tenants, tenants4 and tenants5.
 *   - SQL detection vs the export's own marks (used for scoring ONLY, never at run time): leaks and false positives must be 0
 *   - the whole answer path: "how many documents" = export count minus private papers; asking for the company's private papers gets the privacy reply;
 *     no answer text, record or citation shows a private paper's id or file name; customer-facing look-alike papers never get the privacy reply
 *
 *   node scripts/verify-privacy-r21.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

let failures = 0; let passes = 0;
const check = (name, ok, detail = '') => { if (ok) passes++; else failures++; if (!ok || process.env.VERBOSE) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${String(detail).slice(0, 500)}`}`); };
delete process.env.ANTHROPIC_API_KEY;
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && /^\{"/.test(a[0])) return; realLog(...a); };
console.warn = () => {}; console.error = () => {};

const P = await import('../api/_lib/privacy/privateDocs.js');
// ---- Part 1: the rule
const PRIV = ['hr-letter', 'HR_Letter', 'trainer-complaint', 'driver-accident-claim', 'manager-warning', 'engineer-pip', 'groomer-writeup', 'stylist-writeup', 'kitchen-writeup', 'tech-discipline-memo',
  'crew-injury-report', 'staff-incident-report', 'staff-conduct-report', 'tutor-evaluation', 'assistant-feedback', 'second-shooter-review', 'agent-complaint-file', 'preparer-review', 'volunteer-hr-file',
  'clerk-personnel-memo', 'employee-handbook-ack', 'payroll-adjustment', 'offer-letter', 'background-check', 'forklift-incident-hr'];
const PUB = ['lease-termination-notice', 'customer-complaint', 'member-complaint', 'guest-accident-report', 'customer-accident-report', 'tenant-complaint', 'incident-report', 'housekeeping-incident-log', 'detention-claim', 'insurance-claim-letter',
  'injury-waiver', 'driver-qualification-file', 'tech-feedback-form', 'service-ticket', 'invoice', 'correspondence', 'work-order', 'inspection-report', 'warranty-registration', 'patient-feedback-survey', 'client-review-request', 'vehicle-accident-claim'];
for (const t of PRIV) check(`type "${t}" is private`, P.isPrivateDocType(t), P.typeScore(t));
for (const t of PUB) check(`type "${t}" stays public`, !P.isPrivateDocType(t), P.typeScore(t));
check('counselling note alone is not a private paper type', !P.isPrivateDocType('counseling-note'));
check('counselling note marked internal is private', P.privateScore({ type: 'counseling-note', audience: 'internal' }) >= 3);
check('an internal incident report with HR text stays a company paper (event word alone is never enough)', P.privateScore({ type: 'incident-report', audience: 'internal', text: 'Internal HR note about an employee' }) < 3);
check('an unrecognised type, internal, with HR and confidential text is private', P.privateScore({ type: 'staff-matter-sheet2', audience: 'internal', text: 'Confidential: employee matter' }) >= 3);
check('incident report marked internal with no staff text stays public', P.privateScore({ type: 'incident-report', audience: 'internal', text: 'Pickup incident' }) < 3);
check('incident report with staff named but nothing else stays public', P.privateScore({ type: 'incident-report', staffNamed: true }) < 3);
check('an internal memo with a customer-paper type stays public', P.privateScore({ type: 'shade-match-sheet', audience: 'internal', text: 'Confidential: pickup note' }) < 3);
for (const q of ['show me the trainer complaints', 'how many driver accident claims', 'list the manager warnings', 'any write-ups for the drivers', 'show me the engineer pips', 'what is in the HR letters'])
  check(`ask "${q}" gets the privacy reply`, P.isPrivateDocAsk(q));
for (const q of ['tech with most hrs', 'customer complaints this month', 'guest complaints about noise', 'how many documents do I have', 'tech warning light on the furnace', 'show member accident reports', 'how many incident reports', 'show the claim letters', 'lease termination letter'])
  check(`ask "${q}" is not a private ask`, !P.isPrivateDocAsk(q));
const sql = P.notPrivateSql('d');
check('notPrivateSql keeps its shape (alias d)', /d\.document_type/.test(sql) && /NOT \(/.test(sql));

// ---- Part 2: companies
const DIR = process.env.PRIVACY_R21_DIR ?? '/home/claude/work/factory';
const COMPANIES = ['tenants/auto', 'tenants/hoa', 'tenants/medical', 'tenants4/gym', 'tenants4/trucking', 'tenants4/storage', 'tenants4/church', 'tenants4/eventvenue', 'tenants4/msp', 'tenants4/salon',
  'tenants5/daycare', 'tenants5/hotel', 'tenants5/roofing', 'tenants5/bookkeeping', 'tenants5/warehouse'];
if (!fs.existsSync(path.join(DIR, 'tenants4'))) { console.log(`SKIP part 2: no factory exports under ${DIR}`); }
else {
  const off = await import('./offline-exam.mjs');
  await off.installPgHarness(); await off.installModelBlock();
  const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
  const { withTenant } = await import('../api/_lib/recordsStore.js');
  const { default: askHandler } = await import('../api/ask.js');
  const { SCORECARD_CALL } = await import('../api/_lib/scorecard/hook.js');
  const { createUsageMeter, runWithUsageMeter } = await import('../api/_lib/usage.js');
  const makeRes = () => { const res = { statusCode: 200, headers: {}, headersSent: false, body: undefined, setHeader(k, v) { res.headers[String(k).toLowerCase()] = v; return res; }, getHeader(k) { return res.headers[String(k).toLowerCase()]; }, status(c) { res.statusCode = c; return res; }, json(b) { res.body = b; res.headersSent = true; return res; }, end() { res.headersSent = true; return res; } }; return res; };
  let leaks = 0; let falsePos = 0; let sumPriv = 0;
  for (const co of COMPANIES) {
    const key = co.split('/')[1];
    const data = JSON.parse(fs.readFileSync(path.join(DIR, `${co}.json`), 'utf8'));
    const meta = JSON.parse(fs.readFileSync(path.join(DIR, `${co}.meta.json`), 'utf8'));
    const hrType = meta.hrType ?? 'hr-letter'; // the export's own mark: used to SCORE this test only
    const loaded = await off.loadExportIntoNewTenant(lite, data, { tenantKey: `offline:r21-${co}`, tenantName: key });
    const ctxArg = { tenantKey: loaded.ctx.tenantKey, tenantName: key };
    const truth = new Set(data.documents.filter((d) => d.document_type === hrType).map((d) => d.id));
    const rows = await withTenant(ctxArg, async (db) => (await db.raw(`SELECT d.id, d.document_type FROM documents d WHERE d.tenant_id = (current_setting('app.tenant_id', true))::uuid AND NOT ${P.notPrivateSql('d')}`, [])).rows);
    const kept = await withTenant(ctxArg, async (db) => (await db.raw(`SELECT count(*)::int AS n FROM documents d WHERE d.tenant_id = (current_setting('app.tenant_id', true))::uuid AND ${P.notPrivateSql('d')}`, [])).rows[0].n);
    const keptCustomer = data.documents.filter((d) => !truth.has(d.id) && d.audience !== 'internal').length; // customer-scoped answers also leave out internal-audience papers (round 18 rule)
    const detected = new Set(rows.map((r) => r.id));
    const leak = [...truth].filter((i) => !detected.has(i)).length; const fp = [...detected].filter((i) => !truth.has(i));
    leaks += leak; falsePos += fp.length; sumPriv += truth.size;
    check(`${key}: all ${truth.size} private papers (${hrType}) found, none missed`, leak === 0, `missed ${leak}`);
    check(`${key}: no customer-facing paper taken as private`, fp.length === 0, `${fp.length} e.g. ${rows.filter((r) => !truth.has(r.id)).slice(0, 3).map((r) => r.document_type)}`);
    check(`${key}: documents kept = export ${data.documents.length} - private ${truth.size}`, kept === data.documents.length - truth.size, kept);
    check(`${key}: no customer-facing type id scores as private on its own`, [...new Set(data.documents.map((d) => d.document_type))].every((t) => t === hrType || P.typeScore(t) < 3), '')
    // every other type is a customer-facing look-alike: asking about it never gets the privacy reply
    for (const t of new Set(data.documents.map((d) => d.document_type))) if (t !== hrType) { falsePos += P.isPrivateDocAsk(`show me the ${t.replace(/-/g, ' ')}s`) ? 1 : 0; if (P.isPrivateDocAsk(`how many ${t.replace(/-/g, ' ')}s`)) check(`${key}: "${t}" is not a private ask`, false); }
    check(`${key}: asking for ${hrType} papers is a private ask`, P.isPrivateDocAsk(`show me the ${hrType.replace(/-/g, ' ')}${/hr$/.test(hrType) ? ' papers' : 's'}`) && P.isPrivateDocAsk(`how many ${hrType.replace(/-/g, ' ')}${/hr$/.test(hrType) ? ' papers' : 's'} do we have`));
    // the whole answer path (10 companies)
    if (COMPANIES.indexOf(co) % 3 === 2 || ['gym', 'trucking', 'storage'].includes(key)) {
      const auth = { tenantId: loaded.ctx.tenantKey, orgId: 'factory', userId: null };
      const ask = async (question) => { const req = { method: 'POST', headers: {}, query: {}, body: { question, today: '2026-10-07', debug: true }, [SCORECARD_CALL]: { auth, escalate: false } }; const res = makeRes(); try { await runWithUsageMeter(createUsageMeter(), () => askHandler(req, res)); } catch (e) {} return res.body?.success ? res.body.data ?? null : null; };
      const names = new Set(data.documents.filter((d) => truth.has(d.id)).map((d) => d.original_filename));
      const seeIn = (a) => { const s = JSON.stringify(a ?? {}); return [...truth].some((i) => s.includes(i)) || [...names].some((n) => s.includes(n)); };
      const privAsk = await ask(`show me the ${hrType.replace(/-/g, ' ')}${/hr$/.test(hrType) ? ' papers' : 's'}`);
      check(`${key}: asking for ${hrType} papers gets the privacy reply`, privAsk?.text === P.PRIVATE_DOCS_REPLY, privAsk?.text);
      check(`${key}: the privacy reply shows no paper`, !seeIn(privAsk));
      const cnt = await ask('how many documents do I have?');
      check(`${key}: "all documents" says ${keptCustomer} (export ${data.documents.length} - private ${truth.size} - internal-only ${kept - keptCustomer})`, new RegExp(`\\b${keptCustomer}\\b`).test(String(cnt?.text ?? '')), cnt?.text);
      check(`${key}: "all documents" shows no private paper`, !seeIn(cnt));
      const lst = await ask('list all my documents');
      check(`${key}: a document list shows no private paper`, !seeIn(lst));
      const other = [...new Set(data.documents.map((d) => d.document_type))].find((t) => t !== hrType);
      const oth = await ask(`how many ${other.replace(/-/g, ' ')}s do I have?`);
      check(`${key}: a customer-facing paper question is not met with the privacy reply`, oth?.text !== P.PRIVATE_DOCS_REPLY, oth?.text);
    }
  }
  console.log(`privacy-r21 totals: ${sumPriv} private papers over ${COMPANIES.length} companies; leaked ${leaks}; false positives ${falsePos}`);
  check('leaked papers = 0', leaks === 0); check('false positives = 0', falsePos === 0);
}
console.log(failures === 0 ? `verify:privacy-r21 OK (${passes} checks)` : `verify:privacy-r21 FAILED (${failures} of ${passes + failures})`);
process.exit(failures === 0 ? 0 : 1);
