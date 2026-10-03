/**
 * LIMIT TEST (Tester A) - company isolation across EVERY API route/action.
 * Three companies (org_A/B/C) on ONE PGlite database (all M3 migrations, RLS role deepwell_rls), real Clerk-JWT verification
 * (RS256 tokens signed locally, JWKS served by an in-process fetch mock), mock R2, no network. For every ordered pair
 * (attacker X -> victim Y) and every route/action it sends hostile requests (victim ids in every id slot, tenant smuggling
 * fields) and asserts: (1) the response never contains a victim secret (sentinel text, storage key, API key, tenant uuid);
 * (2) the victim's rows are byte-identical before/after (per-table md5 of every tenant_id table + tenants row);
 * (3) no R2 GET/DELETE of a victim-prefixed key was issued. Run: npx tsx scripts/limit-test/isolation-routes.mjs
 */
for (const b of ['READ', 'WRITE', 'INGEST', 'ASK']) { process.env[`RATE_LIMIT_${b}_PER_MINUTE`] = '100000'; process.env[`RATE_LIMIT_${b}_PER_DAY`] = '10000000'; }
delete process.env.DEEPWELL_FOUNDER_TENANT_ID; delete process.env.DEEPWELL_OPERATOR_USER_IDS;
import { boot, call, orgToken, soloToken, check, finish, quiet, r2 } from './lib.mjs';
import { seedTenant, fingerprint, diffFp, sha } from './seed.mjs';

const h = await boot();
const [A, B, C] = await Promise.all([
  seedTenant(h, { key: 'org_A', tag: 'AAA' }), seedTenant(h, { key: 'org_B', tag: 'BBB' }), seedTenant(h, { key: 'org_C', tag: 'CCC' }),
]);
// seeding three companies concurrently must itself not mix them
for (const T of [A, B, C]) {
  const r = await h.lite.query(`SELECT count(*)::int n FROM documents WHERE tenant_id=$1`, [T.uuid]);
  check(`seed (concurrent): ${T.key} has exactly its 2 documents`, r.rows[0].n === 2);
}
const TS = [A, B, C];
const tok = (T) => orgToken(T.key, `user_${T.tag}`, 'admin');
const memberTok = (T) => orgToken(T.key, `member_${T.tag}`, 'member');

const handlers = {};
const load = async (name, p) => { handlers[name] = (await import(p)).default; };
await load('records', '../../api/records.ts'); await load('review', '../../api/review.js'); await load('upload', '../../api/upload-url.js');
await load('read', '../../api/read-document.js'); await load('extract', '../../api/extract.js'); await load('status', '../../api/document-status.js');
await load('warranty', '../../api/warranty-attention.js'); await load('ask', '../../api/ask.js'); await load('billing', '../../api/billing.js');
await load('account', '../../api/account.js'); await load('v1', '../../api/v1.js');
const account = (action) => (o) => handlers.account(o.req, o.res);
const callAcct = (action, o = {}) => call(handlers.account, { ...o, query: { ...(o.query ?? {}), action } });
const callV1 = (resource, o = {}) => call(handlers.v1, { ...o, query: { ...(o.query ?? {}), resource } });

/** table list for a single-round-trip fingerprint */
const tabs = (await h.lite.query(`SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' ORDER BY 1`)).rows.map((r) => r.table_name);
const fpSql = tabs.map((t) => `SELECT '${t}' t, count(*)::int n, md5(coalesce(string_agg(x::text,'|' ORDER BY x::text),'')) m FROM "${t}" x WHERE tenant_id=$1`).join(' UNION ALL ') + ` UNION ALL SELECT 'tenants', count(*)::int, md5(coalesce(string_agg(x::text,'|'),'')) FROM tenants x WHERE id=$1`;
const fp = async (T) => Object.fromEntries((await h.lite.query(fpSql, [T.uuid])).rows.map((r) => [r.t, `${r.n}:${r.m}`]));

const DEBUG = process.env.LT_DEBUG === '1';
const statusCount = {}; const serverErrors = [];
const rows = []; // report rows
const sentBlob = {}; // everything attacker X ever typed (echo of one's own input, e.g. an audit row recording a bogus id, is not a leak)
function leaks(Y, body, reqOpts, X) {
  const s = typeof body === 'string' ? body : JSON.stringify(body ?? null);
  const reqS = (sentBlob[X.tag] = (sentBlob[X.tag] ?? '') + JSON.stringify(reqOpts ?? {}));
  // a presigned/R2 URL in ANY response may only ever name the caller's own tenant prefix
  const urls = s.match(/r2\.cloudflarestorage\.com[^"\s]*/g) ?? [];
  const urlBad = urls.filter((u) => u.includes(Y.uuid)).map((u) => `r2url:${u.slice(0, 90)}`);
  const hit = Y.secrets.filter((x) => x && s.includes(x) && !reqS.includes(x));
  const idHit = Y.ids.filter((x) => s.includes(x) && !reqS.includes(x));
  return [...urlBad, ...hit, ...idHit.map((i) => { const at = s.indexOf(i); return `id:${i} ctx=${s.slice(Math.max(0, at - 120), at + 60).replace(/\s+/g, ' ')}`; })];
}
let nReq = 0;
/** one hostile request X->Y; returns res. fails the run on any leak / victim mutation / foreign R2 access. */
async function hostile(label, X, Y, run, reqOpts) {
  const before = await fp(Y); r2.requested.length = 0;
  const snap = async () => Object.fromEntries(await Promise.all(['extractions', 'facets', 'entities', 'documents'].map(async (t) => [t, (await h.lite.query(`SELECT x::text r FROM ${t} x WHERE tenant_id=$1 ORDER BY 1`, [Y.uuid])).rows.map((q) => q.r)])));
  const rowsBefore = DEBUG ? await snap() : null;
  const res = await quiet(() => run());
  nReq++;
  const after = await fp(Y);
  const code = res.statusCode; statusCount[code] = (statusCount[code] ?? 0) + 1;
  if (code >= 500) serverErrors.push(`${label} ${X.tag}->${Y.tag}: ${code} ${JSON.stringify(res.body)?.slice(0, 120)}`);
  const lk = leaks(Y, res.body, reqOpts, X);
  const changed = diffFp(before, after);
  if (changed.length && DEBUG) { const ra = await snap(); for (const t of changed) if (ra[t]) console.log(`   DIFF ${label} ${X.tag}->${Y.tag} ${t}:\n     before=${JSON.stringify(rowsBefore[t].filter((r) => !ra[t].includes(r))).slice(0, 600)}\n     after=${JSON.stringify(ra[t].filter((r) => !rowsBefore[t].includes(r))).slice(0, 600)}`); }
  const r2bad = r2.requested.filter((q) => q.key.startsWith(`${Y.uuid}/`));
  const bad = lk.length || changed.length || r2bad.length;
  if (bad) check(`${label} ${X.tag}->${Y.tag}`, false, `leaks=${JSON.stringify(lk)} victimTablesChanged=${JSON.stringify(changed)} r2=${JSON.stringify(r2bad)} status=${code}`);
  return { res, bad: !!bad };
}
/** run a labelled group over all 6 ordered pairs and record ONE pass/fail row */
async function group(label, how, fn) {
  let bad = 0, n = 0;
  for (const X of TS) for (const Y of TS) { if (X === Y) continue; const out = await fn(X, Y); for (const o of [].concat(out)) { n++; if (o.bad) { bad++; if (o.why) console.log(`   WHY ${label} ${X.tag}->${Y.tag}: ${o.why}`); } } }
  check(`${label}  [${n} hostile requests, ${how}]`, bad === 0);
  rows.push({ label, how, n, ok: bad === 0 });
}
const smuggle = (Y) => ({ tenantId: Y.key, tenant_id: Y.uuid, tenantKey: Y.key, tenant_key: Y.key, orgId: Y.key, org_id: Y.key, TenantId: Y.key, userId: `user_${Y.tag}`, user_id: `user_${Y.tag}` });
const allIds = (Y, X) => ({ id: Y.docs[0].id, documentId: Y.docs[0].id, documentIds: [Y.docs[0].id, Y.docs[1].id], entityId: Y.customerId, customerId: Y.customerId, unitId: Y.unitId, equipmentId: Y.unitId, ids: [Y.customerId, Y.unitId], entityIds: [Y.customerId, Y.cust2], keepId: Y.customerId, dropId: Y.cust2, aId: Y.customerId, bId: Y.cust2, suggestionId: Y.suggestionId, clusterId: Y.clusterId, messageId: Y.outreachId, markRead: [Y.notifId], storage_key: Y.docs[0].storageKey, storageKey: Y.docs[0].storageKey, ...smuggle(Y) });

/* ------------------------------------------------------------- POSITIVE CONTROLS (the harness really sees data) */
{
  const r = await call(handlers.records, { token: tok(A), body: { action: 'getDocument', id: A.docs[0].id } });
  check('control: A reads its own document via records.getDocument', r.statusCode === 200 && r.body?.id === A.docs[0].id);
  const r2_ = await call(handlers.records, { token: tok(A), body: { action: 'getDocument', id: B.docs[0].id } });
  check('control: A reading B\'s document id via records.getDocument gets null', r2_.statusCode === 200 && r2_.body == null, JSON.stringify(r2_.body)?.slice(0, 100));
  const r3 = await callV1('customers', { method: 'GET', token: A.apiKey });
  check('control: A API key lists its own customers and only those', r3.statusCode === 200 && JSON.stringify(r3.body).includes('NAMEAAA') && !JSON.stringify(r3.body).includes('NAMEBBB'), JSON.stringify(r3.body)?.slice(0, 200));
}

/* ============================================================ api/records.ts (every action) */
const RECORDS_ACTIONS = ['getDocument', 'listDocuments', 'browseDocuments', 'browseFacets', 'reviewSummary', 'listUnverifiedDocuments', 'listEntitiesByIds', 'getFacet', 'listFacetsByDocument', 'getExtraction', 'listExtractionsByDocument', 'listExtractionsByDocuments', 'listExtractionsByEntity', 'getEntity', 'listEntities', 'getProposal', 'listProposals', 'getSchemaVersion', 'bootstrap', 'createDocument', 'updateDocument', 'createFacet', 'updateFacet', 'createExtraction', 'updateExtraction', 'createEntity', 'updateEntity', 'createProposal', 'updateProposal', 'logAction', 'getAuditLog', 'incrementSchemaVersion'];
const CREATE_LIKE = new Set(['createExtraction', 'createFacet', 'createEntity', 'createProposal', 'createDocument', 'logAction', 'incrementSchemaVersion']);
async function recordsGroup(action) {
  await group(`records.ts action=${action}`, 'victim ids in every id slot + tenant smuggling fields', async (X, Y) => {
    const outs = [];
    for (const id of [Y.docs[0].id, Y.customerId, Y.unitId, Y.extractionIds[0], Y.facetId, Y.proposalId]) {
      const body = { action, ...allIds(Y, X), id, documentId: id, entityId: id, documentIds: [id], ids: [id], entity_type: 'customer', type: 'customer', document_id: id, entity_id: id, field_key: 'customer_name', label_raw: 'x', value_raw: 'y', kind: 'field', label: 'HACK',
        sha256_hash: Y.docs[0].hash, original_filename: 'hostile.txt', file_size_bytes: 12, content_type: 'text/plain', data: { customer_name: 'HACKED' }, value: 'HACKED',
        updates: { value: 'HACKED', stage: 'verified', data: { customer_name: 'HACKED' }, status: 'confirmed', document_type: 'invoice', entity_id: id, label: 'HACK', storage_key: Y.docs[0].storageKey, verified_by: 'x', extract_error: 'x', tenant_id: Y.uuid },
        filters: { resource_id: id, batch_id: null, search: 'NAME' + Y.tag, q: Y.tag }, action_name: 'x', resource_id: id, description: 'd', changeKind: 'k' };
      const reqOpts = { token: tok(X), body };
      outs.push(await hostile(`records.${action}`, X, Y, () => call(handlers.records, reqOpts), reqOpts));
    }
    return outs;
  });
}
for (const action of RECORDS_ACTIONS) if (!CREATE_LIKE.has(action)) await recordsGroup(action);
// createDocument/updateDocument cannot be used to point an own document at another company's R2 object
await group('records.ts createDocument/updateDocument cannot set storage_key to a foreign R2 key (then open/read it)', 'own doc -> victim key', async (X, Y) => {
  const hash = sha(`${X.tag}-hostile-doc`);
  const c = await quiet(() => call(handlers.records, { token: tok(X), body: { action: 'createDocument', original_filename: 'mine.txt', sha256_hash: hash, file_size_bytes: 10, content_type: 'text/plain', storage_key: Y.docs[0].storageKey } }));
  const myId = c.body?.id;
  const o = [];
  if (myId) {
    await quiet(() => call(handlers.records, { token: tok(X), body: { action: 'updateDocument', id: myId, updates: { storage_key: Y.docs[0].storageKey, document_type: 'invoice' } } }));
    const req1 = { token: tok(X), body: { mode: 'get', documentId: myId } };
    o.push(await hostile('upload-url get(own doc w/ attempted foreign key)', X, Y, () => call(handlers.upload, req1), req1));
    const req2 = { token: tok(X), body: { documentId: myId, sync: true } };
    o.push(await hostile('read-document(own doc w/ attempted foreign key)', X, Y, () => call(handlers.read, req2), req2));
    const sk = (await h.lite.query(`SELECT storage_key FROM documents WHERE id=$1`, [myId])).rows[0]?.storage_key;
    o.push({ bad: sk != null && !sk.startsWith(`${X.uuid}/`), why: `storage_key stored=${sk}` });
  } else o.push({ bad: true, why: `createDocument failed: ${c.statusCode} ${JSON.stringify(c.body)}` });
  return o;
});

/* ============================================================ api/review.js (every action) */
const REVIEW_ACTIONS = ['correctField', 'setUnitInstallDate', 'classifyDocument', 'linkDocument', 'unlinkDocument', 'verifyDocument', 'unverifyDocument', 'mergeEntities', 'listLinks', 'listCorrections', 'deleteDocuments', 'aiVerify', 'recheckDocument', 'recheckMissing', 'reclassify', 'createCustomer', 'updateCustomer', 'assignDocumentCustomer', 'mergeCustomers', 'keepCustomersSeparate', 'dismissAlert', 'remindersList', 'reminderDone', 'createCustomerAndAttachReminder', 'extractReminders', 'integrityScan', 'integrityFix', 'askFeedback', 'semanticStatus', 'semanticBackfill', 'dossierStatus', 'dossierBackfill', 'supportAccessGrant', 'supportAccessRevoke', 'supportAccessStatus', 'supportAccessLog', 'missReport', 'exportMisses'];
const REVIEW_OPERATOR = ['missDigest', 'learningList', 'learningDecide', 'learningDeactivate', 'learningRunNow', 'learningExport', 'learningReplay', 'learningRejectAllGaps', 'scorecardRun', 'scorecardStatus', 'scorecardBaseline', 'learningAutopilotStatus', 'learningGapReport', 'examPromote', 'examList', 'examExport'];
const reviewBase = (a, Y, X, variant) => {
  const own = { documentId: X.docs[0].id, customerId: X.customerId, entityId: X.unitId, equipmentId: X.unitId, keepId: X.customerId, dropId: X.cust2, aId: X.customerId, bId: X.cust2 };
  const vic = allIds(Y, X);
  const mix1 = { ...vic, documentId: X.docs[0].id, documentIds: [X.docs[0].id], keepId: X.customerId, aId: X.customerId, dropId: Y.customerId, bId: Y.customerId }; // own doc/keep, victim drop/entity
  const mix2 = { ...vic, entityId: X.unitId, equipmentId: X.unitId, customerId: X.customerId, keepId: Y.customerId, aId: Y.customerId, dropId: X.customerId, bId: X.customerId }; // victim doc/keep, own drop
  const mix3 = { ...own, entityId: Y.unitId, customerId: Y.customerId, equipmentId: Y.unitId };                                        // own document -> victim entity
  const base = [vic, mix1, mix2, mix3][variant];
  return { action: a, ...base, fieldKey: 'customer_name', value: 'HACKED-' + X.tag, installDate: '2019-01-01', documentType: 'invoice', name: 'HACKED NAME', patch: { customer_name: 'HACKED', phone: '000' }, tier: 'expired', dismissed: true, by: 'x', confirmDuplicate: true, question: 'who is ' + Y.tag, rating: 'up', limit: 5, serviceAddress: '1 Neutral Rd', hours: 1, reason: 'x', grantId: Y.proposalId, ...smuggle(Y) };
};
for (const a of REVIEW_ACTIONS) {
  await group(`review.js action=${a}`, '4 variants: all-victim ids, own+victim mixes (merge/link/assign across companies), tenant smuggling', async (X, Y) => {
    const outs = [];
    for (let v = 0; v < 4; v++) { const reqOpts = { token: tok(X), body: reviewBase(a, Y, X, v) }; outs.push(await hostile(`review.${a}[v${v}]`, X, Y, () => call(handlers.review, reqOpts), reqOpts)); }
    return outs;
  });
}
await group('review.js operator-only actions refuse non-operator company admins (16 actions)', 'attacker admin of own org, DEEPWELL_FOUNDER_TENANT_ID unset', async (X, Y) => {
  const outs = [];
  for (const a of REVIEW_OPERATOR) { const reqOpts = { token: tok(X), body: { action: a, ...allIds(Y, X) } }; const o = await hostile(`review.${a}(operator)`, X, Y, () => call(handlers.review, reqOpts), reqOpts); if (o.res.statusCode !== 403) { o.bad = true; check(`review.${a} must be 403 for non-operator`, false, `status ${o.res.statusCode}`); } outs.push(o); }
  return outs;
});

/* ============================================================ document / file endpoints */
await group('upload-url.js mode=get (signed file link) with victim documentId / key smuggling', 'presign must never reference a victim key', async (X, Y) => {
  const outs = [];
  for (const id of [Y.docs[0].id, Y.docs[1].id]) { const reqOpts = { token: tok(X), body: { mode: 'get', documentId: id, storage_key: Y.docs[0].storageKey, ...smuggle(Y) } }; const o = await hostile('upload-url get', X, Y, () => call(handlers.upload, reqOpts), reqOpts); if (o.res.statusCode === 200) o.bad = true; outs.push(o); }
  return outs;
});
await group('upload-url.js create (single + batch) with the victim file hash/name', 'key must be <ownTenant>/...; no victim row touched', async (X, Y) => {
  const outs = [];
  for (const body of [{ filename: 'svc.txt', sha256: Y.docs[0].hash, contentType: 'text/plain', sizeBytes: 400, storage_key: Y.docs[0].storageKey, ...smuggle(Y) }, { files: [{ filename: 'svc.txt', sha256: Y.docs[1].hash, contentType: 'text/plain', sizeBytes: 400, storageKey: Y.docs[1].storageKey }] }]) {
    const reqOpts = { token: tok(X), body }; const o = await hostile('upload-url create', X, Y, () => call(handlers.upload, reqOpts), reqOpts);
    const key = o.res.body?.storageKey ?? o.res.body?.results?.[0]?.storageKey; if (key && !key.startsWith(`${X.uuid}/`)) o.bad = true; if (key && key.includes(Y.uuid)) o.bad = true; outs.push(o);
  }
  return outs;
});
await group('read-document.js with victim documentId (sync + force)', 'withTenant + key prefix guard', async (X, Y) => {
  const outs = [];
  for (const id of [Y.docs[0].id]) { const reqOpts = { token: tok(X), body: { documentId: id, sync: true, force: true, extract: true, ...smuggle(Y) } }; outs.push(await hostile('read-document', X, Y, () => call(handlers.read, reqOpts), reqOpts)); }
  return outs;
});
await group('extract.js with victim documentId', 'withTenant', async (X, Y) => {
  const reqOpts = { token: tok(X), body: { documentId: Y.docs[0].id, force: true, ...smuggle(Y) } };
  return hostile('extract', X, Y, () => call(handlers.extract, reqOpts), reqOpts);
});
await group('document-status.js with victim documentIds', 'withTenant', async (X, Y) => {
  const reqOpts = { token: tok(X), body: { documentIds: Y.docs.map((d) => d.id), ...smuggle(Y) } };
  const o = await hostile('document-status', X, Y, () => call(handlers.status, reqOpts), reqOpts); if ((o.res.body?.documents ?? []).length) o.bad = true; return o;
});
await group('warranty-attention.js with tenant smuggling + victim ids', 'withTenant', async (X, Y) => {
  const reqOpts = { token: tok(X), body: { ...allIds(Y, X), today: '2025-01-01' } };
  return hostile('warranty-attention', X, Y, () => call(handlers.warranty, reqOpts), reqOpts);
});
await group('ask.js (Donovan) asked about the victim\'s customer/serial/address by name', 'question text names victim secrets; no model; deterministic path must not see victim rows', async (X, Y) => {
  const outs = [];
  for (const q of [`Who is Cust ${Y.tag} NAME${Y.tag}?`, `What is the warranty on serial SN${Y.tag}1?`, `Show jobs at 101 ${Y.tag}STREET Lane`, `How many documents does ${Y.tag} have?`]) {
    const reqOpts = { token: tok(X), body: { question: q, today: '2025-01-01', ...smuggle(Y) } }; outs.push(await hostile('ask', X, Y, () => call(handlers.ask, reqOpts), reqOpts));
  }
  return outs;
});

/* ============================================================ api/account.js (all 19 actions) + billing */
const ACCT = { // action -> bodies
  keys: (Y, X) => [{ action: 'list' }, { action: 'revoke', id: Y.apiKeyId }, { action: 'revoke', id: Y.readKeyId, ...smuggle(Y) }, { action: 'create', name: 'x', scopes: ['read'], ...smuggle(Y) }],
  export: () => [{ ...{} }],
  notifications: (Y) => [{ markRead: [Y.notifId] }, { all: false, markRead: [Y.notifId], ...smuggle(Y) }],
  outreach: (Y, X) => ['list', 'settings', 'generate', 'approve', 'skip', 'sendApproved', 'preview', 'optOut', 'saveSettings'].map((op) => ({ op, ids: [Y.outreachId], id: Y.outreachId, customerId: Y.customerId, all: false, status: 'draft', settings: { autoSend: false }, ...smuggle(Y) })),
  followups: (Y) => ['settings', 'saveSettings', 'run'].map((op) => ({ op, settings: { enabled: false }, ...smuggle(Y) })),
  expenses: (Y) => ['list', 'add', 'update', 'delete', 'totals', 'monthly', 'receiptUploadUrl', 'receiptExtract', 'receiptViewUrl', 'exportCsv', 'seedInitial', 'operatorStatus'].map((op) => ({ op, id: Y.proposalId, receiptKey: Y.docs[0].storageKey, ...smuggle(Y) })),
  financials: (Y) => ['document', 'correct', 'verify', 'needsReview', 'summary', 'backfillStatus', 'backfill'].map((op) => ({ op, documentId: Y.docs[0].id, field: 'total', value: '1', ...smuggle(Y) })),
  graph: (Y) => ['status', 'refresh', 'refreshDocument'].map((op) => ({ op, documentId: Y.docs[0].id, ...smuggle(Y) })),
  'entity-merge': (Y) => ['list', 'accept', 'reject', 'undo'].map((op) => ({ op, suggestionId: Y.suggestionId, clusterId: Y.clusterId, entityIds: [Y.customerId, Y.cust2], keepId: Y.customerId, ...smuggle(Y) })),
  naming: (Y) => ['status', 'backfill', 'assign', 'rename'].map((op) => ({ op, documentId: Y.docs[0].id, name: 'HACKED NAME', ...smuggle(Y) })),
  intake: (Y) => ['resolve', 'dismiss', 'snooze'].map((op) => ({ op, documentId: Y.docs[0].id, fieldKey: 'service_date', value: '2020-01-01', resolvedLabel: 'x', until: '2030-01-01', ...smuggle(Y) })),
  grid: (Y) => ['documentCells', 'units'].map((op) => ({ op, documentIds: Y.docs.map((d) => d.id), columns: ['customer_name', 'serial_number'], filters: {}, ...smuggle(Y) })),
  'ask-suggest': (Y) => ['typeahead', 'samples', 'didyoumean'].map((op) => ({ op, q: `Cust ${Y.tag}`, text: `NAME${Y.tag}`, question: `NAME${Y.tag}`, ...smuggle(Y) })),
  'unit-address': (Y) => ['status', 'backfill'].map((op) => ({ op, ...smuggle(Y) })),
  insights: (Y) => [{ ...smuggle(Y), today: '2025-01-01' }],
  audience: (Y) => ['get', 'override'].map((op) => ({ op, documentId: Y.docs[0].id, audience: 'internal', ...smuggle(Y) })),
  support: (Y) => [{ question: `where is ${Y.tag}`, surface: 'app', ...smuggle(Y) }],
};
for (const [action, mk] of Object.entries(ACCT)) {
  await group(`account.js action=${action} (${action === 'export' ? 'tenant-export: attacker exports ITS OWN data only' : 'all ops'})`, 'victim ids + tenant smuggling in body AND query string', async (X, Y) => {
    const outs = [];
    for (const body of mk(Y, X)) {
      for (const method of (['notifications'].includes(action) ? ['POST', 'GET'] : ['POST'])) {
        const reqOpts = { method: action === 'export' ? 'POST' : method, token: tok(X), body, query: { ...smuggle(Y), documentId: Y.docs[0].id, id: Y.customerId } };
        const o = await hostile(`account.${action}${body.op ? '/' + body.op : body.action ? '/' + body.action : ''}`, X, Y, () => callAcct(action, reqOpts), reqOpts);
        if (action === 'export' && o.res.statusCode === 200) { const s = typeof o.res.body === 'string' ? o.res.body : JSON.stringify(o.res.body); if (!s.includes(X.sent[1])) { check(`account.export ${X.tag}: own data present in export`, false, 'own sentinel missing'); o.bad = true; } }
        outs.push(o);
      }
    }
    return outs;
  });
}
/* ============================================================ public API /api/v1/* with API keys */
const V1 = ['equipment', 'warranty', 'ingest', 'customer-equipment', 'customers', 'customer', 'export', 'graph', 'intake-status'];
for (const resource of V1) {
  await group(`v1.js resource=${resource} (X's API key + victim ids/serials/numbers)`, 'API key of X; hostile query/body', async (X, Y) => {
    const outs = [];
    const post = ['ingest', 'customer-equipment'].includes(resource);
    const qs = { id: Y.customerId, number: 'C-00001', serial: `SN${Y.tag}1`, q: `NAME${Y.tag}`, node: `customer:${Y.customerId}`, seeds: `customer:${Y.customerId}`, kind: ['documents', 'customers', 'equipment'][0], withinDays: '9999', ...smuggle(Y) };
    for (const kind of resource === 'export' ? ['documents', 'customers', 'equipment'] : [null]) {
      const reqOpts = { method: post ? 'POST' : 'GET', token: X.apiKey, query: { ...qs, ...(kind ? { kind } : {}) }, body: { customerId: Y.customerId, filename: 'x.txt', sha256: Y.docs[0].hash, sizeBytes: 5, contentType: 'text/plain', ...smuggle(Y) } };
      outs.push(await hostile(`v1.${resource}${kind ? '/' + kind : ''}`, X, Y, () => callV1(resource, reqOpts), reqOpts));
    }
    return outs;
  });
}

// ---- cross-company-reference creating actions LAST (their FK rows would cascade-delete when a victim legitimately deletes its own document, confounding the per-request victim diff)
for (const a of CREATE_LIKE) await recordsGroup(a);
// ---- dedicated foreign-parent-id probe: FK targets are checked without RLS, so a write that names ANOTHER company's document/entity id must be rejected by the app
await group('records.ts createExtraction / createFacet / updateExtraction naming ANOTHER company\'s document or entity id are rejected (FK checks bypass RLS)', 'foreign parent id must not be accepted (no cross-company rows, no existence oracle)', async (X, Y) => {
  const outs = [];
  // fresh, surely-existing victim parents (earlier groups legitimately delete/merge the seed rows)
  const mkParents = async (T) => h.RS.withTenant({ tenantKey: T.key, tenantName: T.key }, async (db) => ({ doc: (await db.createDocument({ original_filename: 'probe.txt', sha256_hash: sha(`${T.tag}-probe-${Math.random()}`), file_size_bytes: 5, stage: 'mapped' })).id, ent: (await db.createEntity({ entity_type: 'customer', data: { customer_name: 'probe' } })).id }));
  const vp = await mkParents(Y), xp = await mkParents(X);
  vp.facet = (await h.RS.withTenant({ tenantKey: Y.key, tenantName: Y.key }, async (db) => (await db.createFacet({ document_id: vp.doc, page_no: 1, label_raw: 'p', value_raw: 'q' })).id));
  const probes = [
    ['createExtraction doc=victim', { action: 'createExtraction', document_id: vp.doc, field_key: 'x', value: 'v' }],
    ['createExtraction own doc, entity=victim', { action: 'createExtraction', document_id: xp.doc, entity_id: vp.ent, field_key: 'x', value: 'v' }],
    ['createExtraction own doc, source_facet_id=victim', { action: 'createExtraction', document_id: xp.doc, source_facet_id: vp.facet, field_key: 'x', value: 'v' }],
    ['createFacet doc=victim', { action: 'createFacet', document_id: vp.doc, label_raw: 'x', value_raw: 'y' }],
    ['updateExtraction own row -> entity=victim', { action: 'updateExtraction', id: (await h.RS.withTenant({ tenantKey: X.key, tenantName: X.key }, async (db) => (await db.createExtraction({ document_id: xp.doc, field_key: 'n', value: 'v' })).id)), updates: { entity_id: vp.ent } }],
  ];
  for (const [name, body] of probes) {
    const reqOpts = { token: tok(X), body }; const o = await hostile(`records.${name}`, X, Y, () => call(handlers.records, reqOpts), reqOpts);
    if (o.res.statusCode === 200) { o.bad = true; o.why = `${name}: accepted (HTTP 200) - row now references ${Y.tag}'s id`; }
    outs.push(o);
  }
  // control: own ids still work
  const okc = await quiet(() => call(handlers.records, { token: tok(X), body: { action: 'createExtraction', document_id: xp.doc, entity_id: xp.ent, field_key: 'note', value: 'ok' } }));
  outs.push({ bad: okc.statusCode !== 200, why: `control createExtraction with own ids failed: ${okc.statusCode}` });
  const okf = await quiet(() => call(handlers.records, { token: tok(X), body: { action: 'createFacet', document_id: xp.doc, label_raw: 'a', value_raw: 'b' } }));
  outs.push({ bad: okf.statusCode !== 200, why: `control createFacet with own ids failed: ${okf.statusCode}` });
  return outs;
});
console.log(`\nrequests sent: ${nReq}; status histogram: ${JSON.stringify(statusCount)}`);
console.log(`unexpected 5xx (robustness, not isolation): ${serverErrors.length}`); for (const e of [...new Set(serverErrors)].slice(0, 40)) console.log('   ' + e);

/* cross-company references created by hostile (mixed) requests: informational integrity scan */
const refs = [['extractions', 'document_id', 'documents'], ['extractions', 'entity_id', 'entities'], ['extractions', 'source_facet_id', 'facets'], ['document_entity_links', 'document_id', 'documents'], ['document_entity_links', 'entity_id', 'entities'], ['entities', 'customer_id', 'entities'], ['entities', 'merged_into', 'entities'], ['facets', 'document_id', 'documents'], ['document_pages', 'document_id', 'documents'], ['outreach_messages', 'customer_id', 'entities'], ['outreach_messages', 'equipment_id', 'entities'], ['intake_needs_info', 'document_id', 'documents'], ['intake_needs_info', 'entity_id', 'entities']];
const xref = [];
for (const [t, c, p] of refs) { const r = await h.lite.query(`SELECT count(*)::int n FROM ${t} a JOIN ${p} b ON b.id = a.${c} WHERE a.tenant_id <> b.tenant_id`); if (r.rows[0].n) xref.push(`${t}.${c} -> ${p}: ${r.rows[0].n} row(s) reference ANOTHER company's row`); }
console.log(`cross-company foreign-key references present after attack run: ${xref.length}`); for (const x of xref) console.log('   ' + x);
check('integrity scan: no row references another company\'s row (FK targets bypass RLS)', xref.length === 0, xref.join('; '));
console.log('\nROWS ' + JSON.stringify(rows.map((r) => [r.label, r.n, r.ok ? 'PASS' : 'FAIL'])));
finish();
