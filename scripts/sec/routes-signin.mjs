// Area routes (c): sign-in states, roles, and "tenant/org ids supplied by the caller are ignored".
// Run: npx tsx scripts/sec/routes-signin.mjs
import { setup } from './routes-common.mjs';
const S = await setup('routes-signin');
const { H, R, q, A, B, leaks, fingerprint, diffFp, api } = S;
process.env.CRON_SECRET = 'cron-secret-for-test-only';
const ask = await api('ask', 'api/ask.js'), rec = await api('records', 'api/records.ts'), review = await api('review', 'api/review.js'), account = await api('account', 'api/account.js');
const billingRaw = await api('billing', 'api/billing.js'), v1 = await api('v1', 'api/v1.js'), upload = await api('upload', 'api/upload-url.js'), readDoc = await api('read', 'api/read-document.js');
const extract = await api('extract', 'api/extract.js'), docStatus = await api('docstatus', 'api/document-status.js'), warr = await api('warr', 'api/warranty-attention.js'), inngest = await api('inngest', 'api/inngest.js');
const billing = (req, res) => { req.on = (ev, fn) => { if (ev === 'data') setTimeout(() => fn(Buffer.from(JSON.stringify(req.body ?? {}))), 0); if (ev === 'end') setTimeout(fn, 5); return req; }; return billingRaw(req, res); };
const bDoc = B.docIds[0], bCust = B.customers[0].id, aDoc = A.docs[0].id, aCust = A.customers[0].id;
const aIds = new Set((await q('select id::text id from documents where tenant_id=$1 union all select id::text from entities where tenant_id=$1', [A.tenant])).map((r) => r.id));
const aLeaks = (res) => { const m = new Set(res.text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? []); return [...m].filter((x) => aIds.has(x.toLowerCase())); };
const fpA0 = await fingerprint(A.tenant), fpB0 = await fingerprint(B.tenant);
const tokClaims = (claims) => `stub.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.ok`;
const keyA = await H.mintKey('A', ['read', 'ingest', 'ask']);
const P = (name, handler, { method = 'POST', query = {}, body = {}, keyOK = false } = {}) => ({ name, handler, method, query, body, keyOK });

// every authenticated entry point with a harmless, well-formed request
const E = [
  P('records.getSchemaVersion', rec, { body: { action: 'getSchemaVersion' } }), P('records.listEntities', rec, { body: { action: 'listEntities', type: 'customer' } }), P('records.updateEntity', rec, { body: { action: 'updateEntity', id: aCust, updates: { data: { customer_name: 'x' } } } }),
  P('review.integrityScan', review, { body: { action: 'integrityScan' } }), P('review.listLinks', review, { body: { action: 'listLinks', documentIds: [aDoc] } }), P('review.deleteDocuments', review, { body: { action: 'deleteDocuments', documentIds: [bDoc] } }),
  ...['keys', 'export', 'delete', 'merge', 'notifications', 'outreach', 'followups', 'expenses', 'financials', 'graph', 'entity-merge', 'naming', 'intake', 'grid', 'ask-suggest', 'unit-address', 'insights', 'audience'].map((a) => P(`account.${a}`, account, { query: { action: a }, body: { op: 'status', action: a === 'keys' ? 'list' : undefined, documentId: aDoc, confirm: 'nope' } })),
  P('account.support(app)', account, { query: { action: 'support' }, body: { surface: 'app', message: 'hello' } }), P('account.support(mobile)', account, { query: { action: 'support' }, body: { surface: 'mobile', message: 'hello' } }),
  P('billing.checkout', billing, { query: { action: 'checkout' }, body: { plan: 'fleet' } }), P('billing.portal', billing, { query: { action: 'portal' } }), P('billing.status', billing, { method: 'GET', query: { action: 'status' } }),
  P('billing.seats', billing, { method: 'GET', query: { action: 'seats' } }), P('billing.invite', billing, { query: { action: 'invite' }, body: { email: 'a@b.co' } }),
  P('document-status', docStatus, { body: { documentIds: [aDoc] } }),
  P('ask', ask, { body: { question: 'how many customers do we have?' }, keyOK: true }), P('read-document', readDoc, { body: { documentId: aDoc }, keyOK: true }), P('extract', extract, { body: { documentId: aDoc }, keyOK: true }),
  P('upload-url', upload, { body: { mode: 'get', documentId: aDoc }, keyOK: true }), P('warranty-attention', warr, { body: {}, keyOK: true }),
  ...[['equipment', { serial: 'x' }], ['warranty', {}], ['customers', {}], ['customer', { id: aCust }], ['graph', { q: 'x' }], ['intake-status', {}], ['export', { kind: 'customers' }]].map(([r, qq]) => P(`v1.${r}`, v1, { method: 'GET', query: { resource: r, ...qq }, keyOK: true })),
  P('v1.ingest', v1, { query: { resource: 'ingest' }, body: { original_filename: 'a.pdf' }, keyOK: true }), P('v1.customer-equipment', v1, { query: { resource: 'customer-equipment' }, body: { customerId: aCust }, keyOK: true }),
];
const skipBillingStatusWhenAuthed = new Set(['billing.status']); // billing status opens a second pool connection while holding one - deadlocks the single-connection in-memory database; auth is still checked before it

/* ================= (c1) no / bad credentials on every entry point ================= */
const valid = H.tok.adminA;
const badStates = {
  none: {}, emptyBearer: { authorization: 'Bearer ' }, spaceBearer: { authorization: 'Bearer    ' }, lowerScheme: { authorization: `bearer ${valid}` }, basic: { authorization: `Basic ${valid}` },
  rawTokenNoScheme: { authorization: valid }, doubleBearer: { authorization: `Bearer ${valid}, Bearer ${valid}` }, trailingJunk: { authorization: `Bearer ${valid} extra` },
  expired: { authorization: `Bearer ${H.tok.expired}` }, garbage: { authorization: `Bearer ${H.tok.garbage}` }, 'null-string': { authorization: 'Bearer null' }, undefinedStr: { authorization: 'Bearer undefined' },
  noSub: { authorization: `Bearer ${tokClaims({ o: { id: A.org, rol: 'admin' } })}` }, emptySub: { authorization: `Bearer ${tokClaims({ sub: '', o: { id: A.org, rol: 'admin' } })}` }, numSub: { authorization: `Bearer ${tokClaims({ sub: 12345, o: { id: A.org, rol: 'admin' } })}` },
  objSub: { authorization: `Bearer ${tokClaims({ sub: { a: 1 }, o: { id: A.org, rol: 'admin' } })}` }, badSig: { authorization: `Bearer ${valid.replace(/\.ok$/, '.bad')}` }, wrongAzp: { authorization: `Bearer ${tokClaims({ sub: 'user_adminA', azp: 'https://evil.example', o: { id: A.org, rol: 'admin' } })}` },
  cookieOnly: { cookie: `__session=${valid}; __clerk_db_jwt=${valid}` }, xAuthToken: { 'x-auth-token': valid, 'x-access-token': valid, 'x-clerk-auth-token': valid }, 'x-api-key-session': { 'x-api-key': valid }, 'x-api-key-realkey': { 'x-api-key': keyA, 'x-dw-api-key': keyA },
  'key-in-wrong-scheme': { authorization: `Token ${keyA}` }, 'key-lowercase-prefix': { authorization: `Bearer ${keyA.replace('dw_live_', 'DW_LIVE_')}` }, 'key-truncated': { authorization: `Bearer ${keyA.slice(0, 40)}` }, 'key-extra-char': { authorization: `Bearer ${keyA}0` },
  'key-uppercased-hex': { authorization: `Bearer dw_live_${keyA.slice(8).toUpperCase()}` },
};
let unauthFailures = 0;
for (const e of E) {
  for (const [sn, headers] of Object.entries(badStates)) {
    if (sn.startsWith('key-') || sn === 'x-api-key-realkey' || sn === 'x-api-key-session') {} // all of these must also fail
    const withQuery = { ...e.query, token: valid, access_token: valid, api_key: keyA }; // credentials in the URL must be ignored too
    const bodyTok = { ...e.body, token: valid, authorization: `Bearer ${valid}`, __session: valid };
    const r = await H.call(e.handler, { method: e.method, query: sn === 'none' ? withQuery : e.query, body: sn === 'none' ? bodyTok : e.body, headers });
    const ok = r.status === 401 && !r.thrown && leaks(r).length === 0 && aLeaks(r).length === 0;
    if (!ok) unauthFailures++;
    R.check(`signin:${e.name}:${sn}`, `${e.name} refuses '${sn}' with 401 and returns nothing`, ok, { severity: 'Critical', route: e.name, status: r.status, detail: `http=${r.status} ${r.text.slice(0, 100)} ${r.thrown?.message ?? ''}` });
  }
}
console.log('bad-credential checks failed:', unauthFailures);
// API keys on the session-only entry points: a key (any scopes) must be refused
for (const e of E.filter((x) => !x.keyOK)) {
  const r = await H.call(e.handler, { method: e.method, query: e.query, body: e.body, token: keyA });
  R.check(`signin:key-on-session-route:${e.name}`, `${e.name} (session-only) refuses a valid API key with 401`, r.status === 401, { severity: 'High', route: e.name, status: r.status, detail: r.text.slice(0, 120) });
}

/* ================= (c2) the few routes that are open or have their own credential ================= */
{
  const h = await H.call(account, { method: 'GET', query: { action: 'health' } });
  R.check('open:health', 'health answers without sign-in and discloses only ok/db/time', h.status === 200 && Object.keys(h.body ?? {}).every((k) => ['ok', 'db', 'time'].includes(k)), { severity: 'Low', route: 'account?action=health', detail: h.text.slice(0, 120) });
  const noSecret = []; const secretFail = [];
  for (const [n, headers, query] of [['none', {}, {}], ['empty bearer', { authorization: 'Bearer ' }, {}], ['wrong', { authorization: 'Bearer nope' }, {}], ['no scheme', { authorization: process.env.CRON_SECRET }, {}], ['lowercase', { authorization: `bearer ${process.env.CRON_SECRET}` }, {}], ['query secret', {}, { secret: process.env.CRON_SECRET, key: process.env.CRON_SECRET, cron_secret: process.env.CRON_SECRET }], ['x-vercel-cron header', { 'x-vercel-cron': '1' }, {}], ['user-agent vercel-cron', { 'user-agent': 'vercel-cron/1.0' }, {}], ['session token', { authorization: `Bearer ${H.tok.adminA}` }, {}], ['api key', { authorization: `Bearer ${keyA}` }, {}], ['secret+suffix', { authorization: `Bearer ${process.env.CRON_SECRET}x` }, {}], ['secret prefix only', { authorization: `Bearer ${process.env.CRON_SECRET.slice(0, 5)}` }, {}]]) {
    for (const m of ['GET', 'POST']) { const r = await H.call(account, { method: m, query: { action: 'sweep', ...query }, headers }); if (r.status !== 401) secretFail.push(`${n}/${m}=${r.status}`); }
  }
  R.check('cron:sweep-denials', 'the nightly sweep refuses every request that lacks the exact cron secret (GET and POST)', secretFail.length === 0, { severity: 'Critical', route: 'account?action=sweep', detail: secretFail.join(' ') });
  const saved = process.env.CRON_SECRET; delete process.env.CRON_SECRET;
  const r0 = await H.call(account, { method: 'GET', query: { action: 'sweep' }, headers: { authorization: 'Bearer undefined' } }); const r1 = await H.call(account, { method: 'GET', query: { action: 'sweep' }, headers: { authorization: 'Bearer ' } });
  process.env.CRON_SECRET = saved;
  R.check('cron:unset-secret-fails-closed', 'with CRON_SECRET unset the sweep refuses even "Bearer undefined"/"Bearer "', r0.status === 401 && r1.status === 401, { severity: 'Critical', route: 'account?action=sweep', detail: `${r0.status} ${r1.status}` });
  // Stripe webhook: only a valid signature gets in
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_only';
  const evt = JSON.stringify({ id: 'evt_x', type: 'customer.subscription.updated', data: { object: { id: 'sub_x', customer: 'cus_x', status: 'active', metadata: { tenant: B.tenant } } } });
  const fpB = await fingerprint(B.tenant); const wh = [];
  for (const sig of [undefined, '', 't=1,v1=00', 'garbage', `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`]) { const r = await H.call(billing, { method: 'POST', query: { action: 'webhook' }, body: JSON.parse(evt), headers: sig === undefined ? {} : { 'stripe-signature': sig } }); if (r.status !== 400) wh.push(`${sig}=${r.status}`); }
  delete process.env.STRIPE_WEBHOOK_SECRET; const wr = await H.call(billing, { method: 'POST', query: { action: 'webhook' }, body: JSON.parse(evt) });
  R.check('open:webhook-signature', 'the Stripe webhook refuses a missing / forged signature (400) and fails closed (503) when no secret is set; B unchanged', wh.length === 0 && wr.status === 503 && diffFp(fpB, await fingerprint(B.tenant)).length === 0, { severity: 'Critical', route: 'billing?action=webhook', detail: `${wh.join(' ')} unset=${wr.status}` });
  const ig = await H.call(inngest, { method: 'POST', body: { name: 'x' }, headers: {} });
  R.check('open:inngest-no-queue', 'with no queue keys configured the Inngest endpoint serves nothing (503)', ig.status === 503, { severity: 'Medium', route: 'api/inngest.js', status: ig.status, detail: ig.text.slice(0, 80) });
  const sp = await H.call(account, { method: 'POST', query: { action: 'support' }, body: { surface: 'public', message: 'what is the total of all invoices for Danny Ochoa' } });
  R.check('open:support-public-no-tenant-data', 'the public support widget answers without sign-in and returns no company records', aLeaks(sp).length === 0 && leaks(sp).length === 0 && !/Danny Ochoa|INV-\d/.test(sp.text.replace(/what is the total[^"]*/, '')), { severity: 'High', route: 'account?action=support (public)', status: sp.status, detail: sp.text.slice(0, 150) });
  const spi = await H.call(account, { method: 'POST', query: { action: 'support' }, body: { surface: 'public', action: 'client-error', kind: 'x', message: 'x' } });
  R.check('open:support-public-client-error-needs-session', 'the client-error report is not available on the public surface', spi.status === 400 || spi.status === 401, { severity: 'Low', route: 'account?action=support', status: spi.status, detail: spi.text.slice(0, 100) });
}

/* ================= (c3) a signed-in user with no organization ================= */
{
  const solo = H.tok.soloC; const soloTok2 = H.mintToken({ userId: 'user_soloD' });
  let bad = [];
  for (const e of E) {
    if (skipBillingStatusWhenAuthed.has(e.name)) continue;
    if (['account.delete', 'account.merge'].includes(e.name)) continue;
    const r = await H.call(e.handler, { method: e.method, query: e.query, body: e.body, token: solo });
    const f = [...leaks(r, []), ...aLeaks(r).map((x) => `A id ${x}`)];
    if (f.length || r.thrown) bad.push(`${e.name}:${f[0] ?? r.thrown?.message}`);
  }
  R.check('solo:no-company-data', 'a signed-in user with no organization sees none of company A or B across every entry point', bad.length === 0, { severity: 'Critical', route: 'all', detail: bad.slice(0, 5).join(' | ') });
  const targets = [['records.getDocument A', rec, { action: 'getDocument', id: aDoc }], ['records.getDocument B', rec, { action: 'getDocument', id: bDoc }], ['records.getEntity A', rec, { action: 'getEntity', id: aCust }], ['records.updateDocument A', rec, { action: 'updateDocument', id: aDoc, updates: { document_type: 'x' } }], ['records.updateEntity B', rec, { action: 'updateEntity', id: bCust, updates: { data: { customer_name: 'PWN' } } }],
    ['review.deleteDocuments A+B', review, { action: 'deleteDocuments', documentIds: [aDoc, bDoc] }], ['review.mergeCustomers A,B', review, { action: 'mergeCustomers', keepId: aCust, dropId: bCust }], ['review.correctField A', review, { action: 'correctField', documentId: aDoc, fieldKey: 'customer_name', value: 'PWN' }]];
  const fa = await fingerprint(A.tenant), fb = await fingerprint(B.tenant); const tb = [];
  for (const [n, h, body] of targets) { const r = await H.call(h, { token: solo, body }); const f = [...leaks(r, [bDoc, bCust]), ...aLeaks(r).filter((x) => x !== aDoc && x !== aCust)]; if (f.length || (r.status === 200 && n.startsWith('records.get') && r.text !== 'null' && r.text !== '[]')) tb.push(`${n}:${r.status}:${f[0] ?? r.text.slice(0, 40)}`); }
  R.check('solo:cannot-touch-A-or-B-by-id', 'a user with no organization naming A or B record ids reads and changes nothing', tb.length === 0 && diffFp(fa, await fingerprint(A.tenant)).length === 0 && diffFp(fb, await fingerprint(B.tenant)).length === 0, { severity: 'Critical', route: 'records/review', detail: tb.join(' | ') });
  const mg = await H.call(account, { token: solo, query: { action: 'merge' }, body: { fromKey: B.org, toKey: A.org, tenantId: A.tenant } });
  R.check('solo:merge-is-noop', 'merge-tenant with no organization moves nothing', mg.status === 200 && /nothing to merge/.test(mg.text) && diffFp(fb, await fingerprint(B.tenant)).length === 0, { severity: 'High', route: 'account?action=merge', status: mg.status, detail: mg.text.slice(0, 100) });
  const del = await H.call(account, { token: solo, query: { action: 'delete' }, body: { confirm: A.org } }); const del2 = await H.call(account, { token: solo, query: { action: 'delete' }, body: { confirm: B.tenant } });
  R.check('solo:delete-wrong-confirm', 'a solo user cannot delete by naming A or B (confirmation must match its own tenant)', del.status === 400 && del2.status === 400 && diffFp(fa, await fingerprint(A.tenant)).length === 0, { severity: 'Critical', route: 'account?action=delete', detail: `${del.status} ${del2.status} ${del.text.slice(0, 80)}` });
  const ex = await H.call(account, { token: solo, query: { action: 'export' }, body: {} });
  R.check('solo:export-own-only', 'a solo user export holds nothing of A or B', leaks(ex).length === 0 && aLeaks(ex).length === 0, { severity: 'Critical', route: 'account?action=export', status: ex.status, detail: ex.text.slice(0, 100) });
  const k = await H.call(account, { token: solo, query: { action: 'keys' }, body: { action: 'create', name: 'solo', scopes: ['read'], tenantId: A.tenant, orgId: A.org } });
  let soloKeyHitsA = 'n/a';
  if (k.status === 200 || k.status === 201) { const raw = k.body?.key ?? k.body?.rawKey ?? k.body?.apiKey; if (raw) { const c = await H.call(v1, { token: raw, method: 'GET', query: { resource: 'customers' } }); soloKeyHitsA = String(aLeaks(c).length + leaks(c).length); } }
  R.check('solo:own-key-sees-nothing-of-A', "a key minted by a solo user (even with A's ids in the request) lists no company records", soloKeyHitsA === 'n/a' || soloKeyHitsA === '0', { severity: 'Critical', route: 'account?action=keys', detail: `keyStatus=${k.status} hits=${soloKeyHitsA}` });
  // two different solo users never share a tenant
  const w1 = await H.call(rec, { token: solo, body: { action: 'createEntity', entity_type: 'customer', data: { customer_name: 'Solo Only Customer' } } });
  const w2 = await H.call(rec, { token: soloTok2, body: { action: 'listEntities', type: 'customer' } });
  R.check('solo:two-solo-users-are-separate', 'one solo user\'s records are invisible to another solo user', w1.status === 200 && !/Solo Only Customer/.test(w2.text), { severity: 'Critical', route: 'api/records.ts', detail: `${w1.status} ${w2.text.slice(0, 60)}` });
}

/* ================= (c4) org role values: only a real admin passes admin-only actions ================= */
const aOrg = A.org;
const roleTok = (rol, shape = 'v2') => (shape === 'v2' ? tokClaims({ sub: 'user_roleX', o: { id: aOrg, ...(rol === undefined ? {} : { rol }) } }) : tokClaims({ sub: 'user_roleX', org_id: aOrg, ...(rol === undefined ? {} : { org_role: rol }) }));
const ADMIN_ONLY = [
  ['keys.list', account, { query: { action: 'keys' }, body: { action: 'list' } }], ['keys.create', account, { query: { action: 'keys' }, body: { action: 'create', name: 'x', scopes: ['read'] } }], ['keys.revoke', account, { query: { action: 'keys' }, body: { action: 'revoke', id: aCust } }],
  ['export', account, { query: { action: 'export' }, body: {} }], ['delete', account, { query: { action: 'delete' }, body: { confirm: aOrg } }],
  ['billing.checkout', billing, { query: { action: 'checkout' }, body: { plan: 'fleet' } }], ['billing.portal', billing, { query: { action: 'portal' }, body: {} }], ['billing.seats', billing, { method: 'GET', query: { action: 'seats' } }], ['billing.invite', billing, { query: { action: 'invite' }, body: { email: 'a@b.co' } }],
  ['naming.status', account, { query: { action: 'naming' }, body: { op: 'status' } }], ['naming.backfill', account, { query: { action: 'naming' }, body: { op: 'backfill' } }], ['naming.assign', account, { query: { action: 'naming' }, body: { op: 'assign', documentId: aDoc } }],
  ['graph.status', account, { query: { action: 'graph' }, body: { op: 'status' } }], ['graph.refresh', account, { query: { action: 'graph' }, body: { op: 'refresh' } }], ['graph.refreshDocument', account, { query: { action: 'graph' }, body: { op: 'refreshDocument', documentId: aDoc } }],
  ['unit-address.status', account, { query: { action: 'unit-address' }, body: { op: 'status' } }], ['unit-address.backfill', account, { query: { action: 'unit-address' }, body: { op: 'backfill' } }],
  ['entity-merge.list', account, { query: { action: 'entity-merge' }, body: { op: 'list' } }], ['entity-merge.accept', account, { query: { action: 'entity-merge' }, body: { op: 'accept', entityIds: [aCust, A.customers[1].id] } }], ['entity-merge.reject', account, { query: { action: 'entity-merge' }, body: { op: 'reject', entityIds: [aCust, A.customers[1].id] } }], ['entity-merge.undo', account, { query: { action: 'entity-merge' }, body: { op: 'undo', suggestionId: aCust } }],
  ['financials.summary', account, { query: { action: 'financials' }, body: { op: 'summary' } }], ['financials.backfillStatus', account, { query: { action: 'financials' }, body: { op: 'backfillStatus' } }], ['financials.backfill', account, { query: { action: 'financials' }, body: { op: 'backfill' } }],
  ['outreach.saveSettings', account, { query: { action: 'outreach' }, body: { op: 'saveSettings', settings: { enabled: true } } }], ['outreach.approve', account, { query: { action: 'outreach' }, body: { op: 'approve', all: true } }], ['outreach.sendApproved', account, { query: { action: 'outreach' }, body: { op: 'sendApproved' } }],
  ['followups.saveSettings', account, { query: { action: 'followups' }, body: { op: 'saveSettings', settings: { enabled: true } } }], ['followups.run', account, { query: { action: 'followups' }, body: { op: 'run', apply: true } }],
  ['notifications.emailDigest', account, { query: { action: 'notifications' }, body: { settings: { emailDigest: false } } }],
  ['review.mergeEntities', review, { body: { action: 'mergeEntities', keepId: aCust, dropId: A.customers[1].id } }], ['review.mergeCustomers', review, { body: { action: 'mergeCustomers', keepId: aCust, dropId: A.customers[1].id } }],
  ['review.deleteDocuments', review, { body: { action: 'deleteDocuments', documentIds: [aDoc] } }], ['review.recheckMissing', review, { body: { action: 'recheckMissing' } }], ['review.missReport', review, { body: { action: 'missReport' } }], ['review.exportMisses', review, { body: { action: 'exportMisses' } }],
  ['review.semanticStatus', review, { body: { action: 'semanticStatus' } }], ['review.semanticBackfill', review, { body: { action: 'semanticBackfill' } }], ['review.dossierStatus', review, { body: { action: 'dossierStatus' } }], ['review.dossierBackfill', review, { body: { action: 'dossierBackfill' } }],
  ['review.supportAccessGrant', review, { body: { action: 'supportAccessGrant', hours: 1, reason: 'x' } }], ['review.supportAccessRevoke', review, { body: { action: 'supportAccessRevoke', grantId: aCust } }], ['review.supportAccessStatus', review, { body: { action: 'supportAccessStatus' } }], ['review.supportAccessLog', review, { body: { action: 'supportAccessLog' } }],
  ['review.integrityFix(admin-only apply)', review, { body: { action: 'integrityFix', apply: ['mergeDuplicates'] } }], ['review.integrityFix(retire)', review, { body: { action: 'integrityFix', apply: ['linkDocuments', 'retireShopCustomers'] } }], ['review.integrityFix(strip)', review, { body: { action: 'integrityFix', apply: ['stripShopContact'] } }], ['review.integrityFix(relink)', review, { body: { action: 'integrityFix', apply: ['relinkMismatchedNames'] } }],
  ['v1.export(session)', v1, { method: 'GET', query: { resource: 'export', kind: 'customers' } }],
  ['records.updateDocument', rec, { body: { action: 'updateDocument', id: aDoc, updates: { document_type: 'x' } } }], ['records.createFacet', rec, { body: { action: 'createFacet', document_id: aDoc, label_raw: 'x', value_raw: 'y' } }], ['records.updateFacet', rec, { body: { action: 'updateFacet', id: aDoc, updates: { value_raw: 'x' } } }],
  ['records.createExtraction', rec, { body: { action: 'createExtraction', document_id: aDoc, field_key: 'x', value: 'y' } }], ['records.updateExtraction', rec, { body: { action: 'updateExtraction', id: aDoc, updates: { value: 'x' } } }],
  ['records.createEntity', rec, { body: { action: 'createEntity', entity_type: 'customer', data: { customer_name: 'rolechk' } } }], ['records.updateEntity', rec, { body: { action: 'updateEntity', id: aCust, updates: { data: { customer_name: 'rolechk' } } } }],
  ['records.createProposal', rec, { body: { action: 'createProposal', kind: 'x', label: 'x' } }], ['records.updateProposal', rec, { body: { action: 'updateProposal', id: aDoc, updates: { status: 'x' } } }], ['records.logAction', rec, { body: { action: 'logAction', action_: 'x' } }], ['records.getAuditLog', rec, { body: { action: 'getAuditLog' } }], ['records.incrementSchemaVersion', rec, { body: { action: 'incrementSchemaVersion', description: 'x', changeKind: 'x' } }],
];
const OPERATOR = [['review.missDigest', review, { body: { action: 'missDigest' } }], ['review.learningList', review, { body: { action: 'learningList' } }], ['review.learningDecide', review, { body: { action: 'learningDecide', id: aDoc, decision: 'approve' } }], ['review.learningExport', review, { body: { action: 'learningExport' } }], ['review.learningRunNow', review, { body: { action: 'learningRunNow' } }], ['review.scorecardRun', review, { body: { action: 'scorecardRun' } }], ['review.scorecardBaseline', review, { body: { action: 'scorecardBaseline' } }], ['review.learningAutopilotStatus', review, { body: { action: 'learningAutopilotStatus' } }], ['review.learningGapReport', review, { body: { action: 'learningGapReport' } }], ['review.examPromote', review, { body: { action: 'examPromote', question: 'x' } }], ['review.examList', review, { body: { action: 'examList' } }], ['review.examExport', review, { body: { action: 'examExport' } }], ['review.learningReplay', review, { body: { action: 'learningReplay', question: 'x' } }], ['review.learningRejectAllGaps', review, { body: { action: 'learningRejectAllGaps' } }], ['review.learningDeactivate', review, { body: { action: 'learningDeactivate', id: aDoc } }], ['review.scorecardStatus', review, { body: { action: 'scorecardStatus' } }], ['expenses.list', account, { query: { action: 'expenses' }, body: { op: 'list' } }], ['expenses.create', account, { query: { action: 'expenses' }, body: { op: 'create', amount: 1 } }]];
const roleVariants = [['member', 'v2'], ['org:member', 'v1'], ['org:member', 'v2'], ['owner', 'v2'], ['org:owner', 'v1'], ['viewer', 'v2'], ['', 'v2'], ['  ', 'v2'], ['administrator', 'v2'], ['org:billing_admin', 'v1'], ['admin_viewer', 'v2'], ['member,admin', 'v2'], [null, 'v2'], [undefined, 'v2'], [undefined, 'v1'], [123, 'v2'], [{ a: 1 }, 'v2'], [true, 'v2'], ['adm1n', 'v2'], ['admin\u0000', 'v2'], ['Adminx', 'v1'], ['superadmin', 'v2'], ['org:admins', 'v1']];
{
  const fa0 = await fingerprint(A.tenant);
  const bad = [];
  let n = 0;
  for (const [rol, shape] of roleVariants) {
    const token = roleTok(rol, shape);
    for (const [name, h, req] of [...ADMIN_ONLY, ...OPERATOR]) {
      const r = await H.call(h, { token, method: req.method ?? 'POST', query: req.query ?? {}, body: req.body ?? {} }); n++;
      if (r.status !== 403) bad.push(`${JSON.stringify(rol)}/${shape} ${name} -> ${r.status} ${r.text.slice(0, 50)}`);
    }
  }
  R.check('role:non-admin-values-are-refused', `${n} calls: ${roleVariants.length} odd org-role values (custom, owner, empty, null, missing, numeric, object, bool, near-misses) are refused (403) on every admin-only and operator-only action`, bad.length === 0, { severity: 'Critical', route: 'all admin-only actions', detail: bad.slice(0, 6).join(' | ') + ` (+${Math.max(0, bad.length - 6)})` });
  R.check('role:no-state-change', 'refused role calls changed nothing in company A', diffFp(fa0, await fingerprint(A.tenant)).length === 0, { severity: 'Critical', route: 'all', detail: diffFp(fa0, await fingerprint(A.tenant)).join(',') });
  // operator actions: not even an admin of company A
  const op = [];
  for (const [name, h, req] of OPERATOR) { const r = await H.call(h, { token: H.tok.adminA, method: 'POST', query: req.query ?? {}, body: req.body ?? {} }); if (r.status !== 403) op.push(`${name}->${r.status}`); }
  R.check('role:operator-actions-not-for-company-admin', 'DeepWell-operator actions (miss digest, learning, scorecard, exam, expenses) refuse a company admin', op.length === 0, { severity: 'Critical', route: 'review.js/expenses', detail: op.join(' ') });
  // controls: genuine admin spellings DO pass (so the refusals above are about the role, not a broken harness)
  const ctl = [];
  for (const [rol, shape] of [['admin', 'v2'], ['org:admin', 'v1'], ['admin', 'v1']]) { const r = await H.call(account, { token: roleTok(rol, shape), query: { action: 'keys' }, body: { action: 'list' } }); if (r.status !== 200) ctl.push(`${rol}/${shape}=${r.status}`); }
  const mem = await H.call(account, { token: H.tok.memberA, query: { action: 'notifications' }, method: 'GET' });
  R.check('role:controls', 'positive control: admin (v2 "admin", v1 "org:admin") lists keys; a member can read notifications', ctl.length === 0 && mem.status === 200, { severity: 'Low', route: 'harness', detail: ctl.join(' ') + ` mem=${mem.status}` });
  // memberA through the documented members-only ops should still work (admin gate is not over-broad)
  // role claim smuggled in the request must not lift a member
  const smug = [];
  for (const [name, h, req] of ADMIN_ONLY.slice(0, 40)) {
    const r = await H.call(h, { token: H.tok.memberA, method: req.method ?? 'POST', query: { ...(req.query ?? {}), role: 'admin', orgRole: 'admin', org_role: 'org:admin', rol: 'admin' }, body: { ...(req.body ?? {}), role: 'admin', orgRole: 'admin', org_role: 'org:admin', admin: true, isAdmin: true, o: { id: aOrg, rol: 'admin' }, auth: { orgRole: 'admin' } }, headers: { 'x-org-role': 'admin', 'x-clerk-org-role': 'org:admin', 'x-role': 'admin', 'x-user-role': 'admin' } });
    if (r.status !== 403) smug.push(`${name}->${r.status}`);
  }
  R.check('role:smuggled-admin-in-request-ignored', 'role/admin flags in the body, query or headers do not lift a member to admin', smug.length === 0, { severity: 'Critical', route: 'all admin-only actions', detail: smug.join(' ') });
  // same, for a member of the OTHER company claiming A's org via request fields: company B member -> A's data
  const crossOrg = [];
  for (const [name, h, req] of [['records.listEntities', rec, { action: 'listEntities', type: 'customer' }], ['review.integrityScan', review, { action: 'integrityScan' }]]) {
    const r = await H.call(h, { token: H.tok.memberB, query: { orgId: aOrg, tenantId: A.tenant, org_id: aOrg }, body: { ...req, orgId: aOrg, org_id: aOrg, tenantId: A.tenant, tenant_id: A.tenant, tenantKey: aOrg }, headers: { 'x-org-id': aOrg, 'x-tenant-id': A.tenant, 'x-clerk-org-id': aOrg, 'x-dw-tenant': aOrg, 'x-dw-expected-tenant': aOrg } });
    if (aLeaks(r).length) crossOrg.push(`${name}:${aLeaks(r)[0]}`);
  }
  R.check('tenant:B-member-naming-A-org-sees-B-only', "a company B member who puts A's org/tenant id in body, query and headers gets no A records", crossOrg.length === 0, { severity: 'Critical', route: 'records/review', detail: crossOrg.join(' ') });
}

/* ================= (c5) tenant / org ids in body, query and headers are ignored ================= */
{
  const injB = { tenantId: B.tenant, tenant_id: B.tenant, tenantKey: B.org, orgId: B.org, org_id: B.org, clerk_org_id: B.org, organizationId: B.org, organization_id: B.org, o: { id: B.org, rol: 'admin' }, org: { id: B.org }, tenant: B.tenant, clerk_user_id: 'user_adminB', userId: 'user_adminB', user_id: 'user_adminB', actorClerkId: 'user_adminB' };
  const hdrB = { 'x-tenant-id': B.tenant, 'x-org-id': B.org, 'x-clerk-org-id': B.org, 'x-dw-tenant': B.org, 'x-tenant': B.tenant, 'x-organization-id': B.org, 'x-forwarded-org': B.org, 'x-user-id': 'user_adminB', 'x-clerk-user-id': 'user_adminB', 'x-dw-org': B.org, 'x-hasura-org-id': B.org, 'x-vercel-oidc-token': 'x' };
  const READS = [P('records.listEntities', rec, { body: { action: 'listEntities', type: 'customer' } }), P('records.reviewSummary', rec, { body: { action: 'reviewSummary' } }), P('records.browseDocuments', rec, { body: { action: 'browseDocuments', filters: { limit: 30, audience: 'all' } } }), P('records.bootstrap', rec, { body: { action: 'bootstrap' } }),
    P('review.integrityScan', review, { body: { action: 'integrityScan' } }), P('review.listLinks', review, { body: { action: 'listLinks', documentIds: [aDoc] } }), P('review.remindersList', review, { body: { action: 'remindersList' } }),
    ...['notifications', 'insights', 'ask-suggest', 'grid', 'outreach', 'followups'].map((a) => P(`account.${a}`, account, { query: { action: a }, body: a === 'grid' ? { op: 'units' } : a === 'ask-suggest' ? { op: 'samples' } : a === 'outreach' ? { op: 'list' } : {}, method: a === 'notifications' ? 'GET' : 'POST' })),
    P('document-status', docStatus, { body: { documentIds: [aDoc] } }), P('warranty-attention', warr, { body: { today: '2026-09-25' } }), P('v1.customers', v1, { method: 'GET', query: { resource: 'customers', limit: 5 } }), P('v1.intake-status', v1, { method: 'GET', query: { resource: 'intake-status' } }), P('ask', ask, { body: { question: 'how many customers do we have?', today: '2026-09-25' } })];
  const cmp = []; const norm = (t) => String(t).replace(/\d{4}-\d\d-\d\dT[\d:.]+Z?/g, '<ts>').replace(/"(generatedAt|timingsMs|elapsedMs|durationMs|time|resetsOn)":[^,}]+/g, '').replace(/"cached":(true|false)/g, '');
  for (const [wn, token] of [['adminA', H.tok.adminA], ['memberA', H.tok.memberA], ['soloC', H.tok.soloC], ['keyA', keyA]]) {
    for (const e of READS) {
      if (wn === 'keyA' && !e.keyOK && !/^(ask|v1|warranty)/.test(e.name)) continue;
      if (wn === 'soloC' && /^(account\.followups)/.test(e.name)) continue;
      await H.call(e.handler, { token, method: e.method, query: e.query, body: e.body }); // warm any per-company cache so cache-vs-fresh shape differences are not mistaken for a difference caused by the injected ids
      const base = await H.call(e.handler, { token, method: e.method, query: e.query, body: e.body });
      const inj = await H.call(e.handler, { token, method: e.method, query: { ...e.query, ...injB }, body: { ...e.body, ...injB }, headers: hdrB });
      const same = base.status === inj.status && norm(base.text) === norm(inj.text);
      const f = leaks(inj);
      if (!same || f.length) { let i = 0; const a = norm(base.text), b = norm(inj.text); while (i < a.length && a[i] === b[i]) i++; cmp.push(`${wn}/${e.name}: ${base.status}->${inj.status} ${f[0] ?? ''} @${i} ${a.slice(Math.max(0, i - 30), i + 50)} | ${b.slice(Math.max(0, i - 30), i + 50)}`); }
    }
  }
  R.check('tenant:injected-ids-ignored', "adding B's tenant/org/user ids to body, query and headers changes nothing for admin, member, solo and key callers on every read entry point", cmp.length === 0, { severity: 'Critical', route: 'many', detail: cmp.slice(0, 6).join(' | ') });
  // writes: same injected ids on write paths land in A, never B
  const fb = await fingerprint(B.tenant);
  const w = [['records.createEntity', rec, { action: 'createEntity', entity_type: 'customer', data: { customer_name: 'Injected Tenant Probe' }, ...injB }], ['review.createCustomer', review, { action: 'createCustomer', name: 'Injected Tenant Probe 2', ...injB }], ['records.logAction', rec, { action: 'logAction', action_: 'x', ...injB }], ['records.createDocument', rec, { action: 'createDocument', original_filename: 'inj.pdf', sha256_hash: 'a'.repeat(64), file_size_bytes: 10, content_type: 'application/pdf', ...injB }], ['account.keys.create', account, { action: 'create', name: 'inj', scopes: ['read'], ...injB }]];
  for (const [n, h, body] of w) await H.call(h, { token: H.tok.adminA, query: h === account ? { action: 'keys' } : {}, body, headers: hdrB });
  const landedA = (await q("select count(*)::int n from entities where tenant_id=$1 and data->>'customer_name' like 'Injected Tenant Probe%'", [A.tenant]))[0].n;
  const landedB = (await q("select count(*)::int n from entities where tenant_id=$1 and data->>'customer_name' like 'Injected Tenant Probe%'", [B.tenant]))[0].n;
  const keysB = (await q('select count(*)::int n from api_keys where tenant_id=$1 and name=$2', [B.tenant, 'inj']))[0].n;
  R.check('tenant:injected-ids-writes-land-in-A', "writes that carry B's tenant/org ids in the body and headers land in A (the signed-in company) and nothing is written into B", landedA >= 1 && landedB === 0 && keysB === 0 && diffFp(fb, await fingerprint(B.tenant)).length === 0, { severity: 'Critical', route: 'records/review/keys', detail: `A=${landedA} B=${landedB} keysB=${keysB} changed=${diffFp(fb, await fingerprint(B.tenant)).join(',')}` });
  // the shop-switch guard on upload-url compares the header to the signed token
  const hdrs = [['B org', { 'x-dw-expected-tenant': B.org }], ['B uuid', { 'x-dw-expected-tenant': B.tenant }], ['array-ish', { 'x-dw-expected-tenant': `${A.org},${B.org}` }]];
  const sw = [];
  for (const [n, h] of hdrs) { const r = await H.call(upload, { token: H.tok.adminA, body: { original_filename: 'sw.pdf', sha256_hash: 'b'.repeat(64), file_size_bytes: 10, content_type: 'application/pdf' }, headers: h }); if (r.status !== 409) sw.push(`${n}=${r.status}`); }
  const swOk = await H.call(upload, { token: H.tok.adminA, body: { original_filename: 'sw.pdf', sha256_hash: 'c'.repeat(64), file_size_bytes: 10, content_type: 'application/pdf' }, headers: { 'x-dw-expected-tenant': A.org } });
  R.check('tenant:upload-expected-tenant-guard', 'upload-url refuses (409) when the expected-company header names another company, and accepts when it names the caller\'s own', sw.length === 0 && swOk.status !== 409, { severity: 'High', route: 'api/upload-url.js', detail: `${sw.join(' ')} own=${swOk.status}` });
}

/* ================= (c6) export resume token, solo-tenant delete, audience override on an own document ================= */
{
  const exTok = H.tok.adminA; const bad = [];
  const sections = ['documents', 'entities', 'extractions', 'document_entity_links'];
  for (const resume of [{ key: 'documents', after: { id: bDoc, c: '2000-01-01 00:00:00+00' } }, { key: 'entities', after: { id: bCust } }, { key: "documents'; select 1;--", after: null }, { key: 'tenants', after: null }, { key: 'documents', after: { id: "x' OR 1=1", c: null } }, { key: 'documents', after: { id: bDoc, c: "2000' OR 1=1 --" } }, { key: 'documents', after: [bDoc] }]) {
    const r = await H.call(account, { token: exTok, query: { action: 'export' }, body: { resume } });
    if (leaks(r, [bDoc, bCust]).length) bad.push(`${JSON.stringify(resume).slice(0, 50)} leaked ${leaks(r, [bDoc, bCust])[0]}`);
    if (r.status !== 200 && r.status !== 400) bad.push(`${JSON.stringify(resume).slice(0, 50)} -> ${r.status}`);
  }
  R.check('export:forged-resume-token-stays-in-A', 'forged export resume tokens (B ids, unknown sections, SQL in the cursor) return only A data or 400', bad.length === 0, { severity: 'Critical', route: 'account?action=export', detail: bad.join(' | ') });
  // a solo user deleting their OWN company with the right confirmation removes only that company
  const soloD = H.mintToken({ userId: 'user_soloDelete' });
  const mk = await H.call(rec, { token: soloD, body: { action: 'createEntity', entity_type: 'customer', data: { customer_name: 'Delete Me Solo' } } });
  const fa = await fingerprint(A.tenant), fb = await fingerprint(B.tenant);
  const own = (await q("select tenant_id::text t from entities where data->>'customer_name'='Delete Me Solo'"))[0]?.t;
  const wrong = await H.call(account, { token: soloD, query: { action: 'delete' }, body: { confirm: 'user_user_soloDelete ' } });
  const del = await H.call(account, { token: soloD, query: { action: 'delete' }, body: { confirm: 'user_user_soloDelete', tenantId: A.tenant, orgId: A.org } });
  const left = (await q("select count(*)::int n from entities where data->>'customer_name'='Delete Me Solo'"))[0].n;
  R.check('delete:solo-delete-touches-only-itself', `a solo user's confirmed delete removes their own records (HTTP ${del.status}, left=${left}) and nothing of A or B, even with A's ids in the body`, mk.status === 200 && !!own && own !== A.tenant && own !== B.tenant && diffFp(fa, await fingerprint(A.tenant)).length === 0 && diffFp(fb, await fingerprint(B.tenant)).length === 0 && wrong.status === 400 && del.status === 200 && left === 0, { severity: 'Critical', route: 'account?action=delete', detail: `mk=${mk.status} wrong=${wrong.status} del=${del.status} left=${left} ${del.text.slice(0, 120)}` });
  const ao = await H.call(account, { token: H.tok.memberA, query: { action: 'audience' }, body: { op: 'override', documentId: aDoc, audience: 'customer' } });
  R.check('audience:own-document-override-works', 'the audience override still works on a document of the caller\'s own company (fix for foreign ids does not break it)', ao.status === 200, { severity: 'Low', route: 'account?action=audience', status: ao.status, detail: ao.text.slice(0, 100) });
  const af = await H.call(account, { token: H.tok.memberA, query: { action: 'audience' }, body: { op: 'override', documentId: bDoc, audience: 'internal' } });
  const ar = await H.call(account, { token: H.tok.memberA, query: { action: 'audience' }, body: { op: 'override', documentId: '11111111-2222-4333-8444-555555555555', audience: 'internal' } });
  R.check('audience:foreign-and-unknown-ids-answer-alike', 'audience override on another company\'s document and on a made-up id both answer 404 (no existence oracle, no cross-company row)', af.status === 404 && ar.status === 404, { severity: 'Low', route: 'account?action=audience', detail: `foreign=${af.status} unknown=${ar.status}` });
}

/* ================= end: A and B untouched by anything above (other than the deliberate A writes) ================= */
{
  const fb = await fingerprint(B.tenant);
  R.check('final:B-unchanged', 'company B is byte-for-byte unchanged after every sign-in / role / injection probe', diffFp(fpB0, fb).length === 0, { severity: 'Critical', route: 'all', detail: diffFp(fpB0, fb).join(',') });
}
R.finish();
