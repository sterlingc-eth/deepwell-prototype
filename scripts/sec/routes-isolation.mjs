// Area routes (b): table-driven cross-tenant test. Signed in as company A (admin token, member token, A's API key) every action that
// accepts an id / name / cursor / sort / filter / id-array / nested object is called with company B's identifiers.
// Pass = nothing of B came back (leak markers, B ids, B hashes) AND a fingerprint of every tenant_id table of B is unchanged,
// AND no row of A ends up referencing a B id.   Run: npx tsx scripts/sec/routes-isolation.mjs
import fs from 'node:fs';
import { setup } from './routes-common.mjs';
const S = await setup('routes-isolation');
const { H, R, q, A, B, leaks, fingerprint, diffFp, foreignRefs, api } = S;
const bDoc = B.docIds[0], bDoc2 = B.docIds[1], bDoc3 = B.docIds[2];
const bCust = B.customers[0].id, bCust2 = B.customers[1].id, bCustNo = B.customers[0].customer_number;
const bEq = B.equipment[0].id, bSerial = B.equipment[0].data.serial_number;
const bExtr = B.extractions[0].id;
const bDocHash = B.docs[0].sha256_hash, bDocKey = B.docs[0].storage_key;
const aDoc = A.docs[0].id, aCust = A.customers[0].id, aEq = A.equipment[0].id;
const bFacet = (await q('select id::text id from facets where tenant_id=$1 limit 1', [B.tenant]))[0]?.id ?? bExtr;
// seed B rows the notification / outreach / key routes could be pointed at
const bNotif = (await q("insert into notifications (tenant_id,kind,title,body,link) values ($1,'warranty','Zed Zimmer warranty','Beta Cooling body','/x') returning id::text id", [B.tenant]))[0].id;
const bOut = (await q("insert into outreach_messages (tenant_id,customer_id,equipment_id,tier,to_email,subject,body_text,status) values ($1,$2,$3,'expired','zed@beta.example','Zed Zimmer subject','Beta Cooling text','draft') returning id::text id", [B.tenant, bCust, bEq]))[0].id;
const bKeyRaw = await H.mintKey('B'); const bKeyId = (await q('select id::text id from api_keys where tenant_id=$1 order by created_at desc limit 1', [B.tenant]))[0].id;
B.allIds.add(bNotif); B.allIds.add(bOut); B.allIds.add(bKeyId);
const keyA = await H.mintKey('A', ['read', 'ingest', 'ask']);
const keyAread = await H.mintKey('A', ['read']);
const who = { adminA: { token: H.tok.adminA }, memberA: { token: H.tok.memberA }, keyA: { token: keyA }, keyAread: { token: keyAread } };

const rec = await api('records', 'api/records.ts'), review = await api('review', 'api/review.js'), account = await api('account', 'api/account.js'), billingRaw = await api('billing', 'api/billing.js');
// billing.js reads the raw request stream; give the mock request one
const billing = (req, res) => { req.on = (ev, fn) => { if (ev === 'data') setTimeout(() => fn(Buffer.from(JSON.stringify(req.body ?? {}))), 0); if (ev === 'end') setTimeout(fn, 5); return req; }; return billingRaw(req, res); };
const v1 = await api('v1', 'api/v1.js'), ask = await api('ask', 'api/ask.js'), upload = await api('upload', 'api/upload-url.js'), readDoc = await api('read', 'api/read-document.js');
const extract = await api('extract', 'api/extract.js'), docStatus = await api('docstatus', 'api/document-status.js'), warr = await api('warr', 'api/warranty-attention.js');

const matrix = []; let base = await fingerprint(); const ctlStatus = {};
async function run(id, handler, whoKeys, req, { supplied = [], mut = false, route = id.split(':')[0] } = {}) {
  for (const w of whoKeys) {
    const res = await H.call(handler, { token: who[w].token, ...req });
    const found = leaks(res, supplied);
    const after = await fingerprint(); const changed = diffFp(base, after); base = after;
    const ok200 = res.status === 200;
    matrix.push({ id, who: w, status: res.status, leaks: found.length, changedB: changed.length, thrown: res.thrown ? String(res.thrown.message).slice(0, 80) : null });
    R.check(`iso:${id}:${w}`, `A (${w}) -> ${id} with B ids returns nothing of B and changes nothing of B`, found.length === 0 && changed.length === 0,
      { severity: 'Critical', route, status: res.status, detail: `leaks=${found.slice(0, 3).join('; ')} changedB=${changed.join(',')} http=${res.status} ${ok200 ? '' : res.text.slice(0, 80)}` });
    if (res.status >= 500 || res.thrown) console.log(`  note: ${id} ${w} -> ${res.status} ${res.thrown?.message ?? res.text.slice(0, 100)}`);
  }
}
const AM = ['adminA', 'memberA'], AMK = ['adminA', 'memberA', 'keyA'];
const P = (handler, route, body = {}, opts = {}) => ({ handler, req: { method: 'POST', body }, route, ...opts });
const cases = [];
const add = (id, handler, whoKeys, req, opts) => cases.push([id, handler, whoKeys, req, opts]);
const recC = (action, extra = {}, supplied = [], mut = false) => add(`records.${action}${extra.__t ?? ''}`, rec, AM, { method: 'POST', body: (({ __t, ...r }) => ({ action, ...r }))(extra) }, { supplied, mut, route: 'api/records.ts' });

// ---------------- api/records.ts : every action
recC('getDocument', { id: bDoc }, [bDoc]);
recC('getDocumentPage', { id: bDoc, page_no: 1 }, [bDoc]);
recC('listDocuments', { filters: { stage: 'verified', document_type: 'invoice', batch_id: bDoc, id: bDoc, tenant_id: B.tenant } }, [bDoc]);
recC('browseDocuments', { filters: { customerId: bCust, q: 'Zed Zimmer', audience: 'all' } }, [bCust]);
recC('browseDocuments', { __t: '#sortcursor', filters: { sort: 'tenant_id', cursor: Buffer.from(JSON.stringify({ o: 0, ts: '2000-01-01', id: bDoc })).toString('base64url'), site: "' OR 1=1 --", technician: 'Zed', brand: "x'); select * from documents;--", limit: 200 } }, [bDoc]);
recC('browseDocuments', { __t: '#nested', filters: { customerId: { $ne: null }, q: ['Zed'], documentType: { a: 1 } }, facets: false }, []);
recC('browseFacets', { filters: { customerId: bCust, q: 'BINV-' } }, [bCust]);
recC('reviewSummary');
recC('listUnverifiedDocuments', { cursor: Buffer.from(JSON.stringify({ ts: '2999-01-01T00:00:00Z', id: bDoc, k: 'unverified', t: 99999 })).toString('base64url'), limit: 200 }, [bDoc]);
recC('listEntitiesByIds', { ids: [bCust, bEq, bCust2, aCust] }, [bCust, bEq, bCust2]);
recC('getFacet', { id: bFacet }, [bFacet]);
recC('listFacetsByDocument', { documentId: bDoc }, [bDoc]);
recC('getExtraction', { id: bExtr }, [bExtr]);
recC('listExtractionsByDocument', { documentId: bDoc }, [bDoc]);
recC('listExtractionsByDocuments', { documentIds: [bDoc, bDoc2, bDoc3, aDoc] }, [bDoc, bDoc2, bDoc3]);
recC('listExtractionsByEntity', { entityId: bEq }, [bEq]);
recC('getEntity', { id: bCust }, [bCust]);
recC('listEntities', { type: 'customer' });
recC('listEntities', { __t: '#sqli', type: "customer' OR tenant_id<>'x" });
recC('getProposal', { id: bDoc }, [bDoc]);
recC('listProposals', { status: 'pending' });
recC('getAuditLog', { filters: { resource_id: bDoc, user_id: bCust, tenant_id: B.tenant, action: 'x' } }, [bDoc, bCust]);
recC('getSchemaVersion');
recC('bootstrap', { tenantId: B.tenant, org_id: B.org });
recC('updateDocument', { id: bDoc, updates: { document_type: 'pwn', page_count: 99, tenant_id: A.tenant } }, [bDoc], true);
recC('updateDocument', { __t: '#A->B', id: aDoc, updates: { tenant_id: B.tenant, storage_key: bDocKey, document_type: 'invoice' } }, [aDoc], true);
recC('createFacet', { document_id: bDoc, label_raw: 'x', value_raw: 'y' }, [bDoc], true);
recC('updateFacet', { id: bFacet, updates: { value_raw: 'pwn' } }, [bFacet], true);
recC('createExtraction', { document_id: bDoc, entity_id: bEq, field_key: 'serial_number', value: 'PWN' }, [bDoc, bEq], true);
recC('createExtraction', { __t: '#A-doc-B-entity', document_id: aDoc, entity_id: bEq, field_key: 'serial_number', value: 'PWN2', source_facet_id: bFacet }, [bEq, bFacet], true);
recC('updateExtraction', { id: bExtr, updates: { value: 'PWN', confidence: 0 } }, [bExtr], true);
recC('updateExtraction', { __t: '#A-ext-B-entity', id: (await q('select id::text id from extractions where tenant_id=$1 limit 1', [A.tenant]))[0].id, updates: { entity_id: bCust } }, [bCust], true);
recC('createEntity', { entity_type: 'customer', data: { customer_name: 'Quincy Tester' }, customer_id: bCust, tenant_id: B.tenant }, [bCust], true);
recC('updateEntity', { id: bCust, updates: { data: { customer_name: 'PWN' } } }, [bCust], true);
recC('createProposal', { kind: 'x', label: 'x', evidence: { entityId: bCust, tenant_id: B.tenant } }, [bCust], true);
recC('updateProposal', { id: bDoc, updates: { status: 'approved' } }, [bDoc], true);
recC('logAction', { action: 'x', resource_type: 'document', resource_id: bDoc, tenant_id: B.tenant }, [bDoc], true);
recC('incrementSchemaVersion', { description: 'x', changeKind: 'x', tenantId: B.tenant }, [], true);
recC('createDocument', { original_filename: 'a.pdf', sha256_hash: bDocHash, file_size_bytes: 10, content_type: 'application/pdf', storage_key: bDocKey, tenant_id: B.tenant, stage: 'verified' }, [bDoc], true);

// ---------------- api/review.js : every non-operator action
const rv = (action, extra = {}, supplied = [], mut = true) => add(`review.${action}${extra.__t ?? ''}`, review, AM, { method: 'POST', body: (({ __t, ...r }) => ({ action, ...r }))(extra) }, { supplied, mut, route: 'api/review.js' });
rv('correctField', { documentId: bDoc, fieldKey: 'customer_name', value: 'PWN', by: 'x' }, [bDoc]);
rv('correctField', { __t: '#B-extr', documentId: aDoc, extractionId: bExtr, fieldKey: 'serial_number', value: 'PWN', entityId: bEq }, [bExtr, bEq]);
rv('setUnitInstallDate', { entityId: bEq, installDate: '2020-01-01' }, [bEq]);
rv('classifyDocument', { documentId: bDoc, documentType: 'invoice' }, [bDoc]);
rv('linkDocument', { documentId: aDoc, entityId: bCust }, [bCust]);
rv('linkDocument', { __t: '#B-doc', documentId: bDoc, entityId: aCust }, [bDoc]);
rv('linkDocument', { __t: '#both', documentId: bDoc, entityId: bCust }, [bDoc, bCust]);
rv('unlinkDocument', { documentId: bDoc, entityId: bCust }, [bDoc, bCust]);
rv('verifyDocument', { documentId: bDoc, by: 'x' }, [bDoc]);
rv('unverifyDocument', { documentId: bDoc }, [bDoc]);
rv('mergeEntities', { keepId: aCust, dropId: bCust }, [bCust]);
rv('mergeEntities', { __t: '#rev', keepId: bCust, dropId: aCust }, [bCust]);
rv('mergeEntities', { __t: '#eq', keepId: aEq, dropId: bEq }, [bEq]);
rv('listLinks', { documentIds: [bDoc, bDoc2, aDoc] }, [bDoc, bDoc2], false);
rv('listCorrections', { documentIds: [bDoc, bDoc2, aDoc] }, [bDoc, bDoc2], false);
rv('deleteDocuments', { documentIds: [bDoc, bDoc2, bDoc3] }, [bDoc, bDoc2, bDoc3]);
rv('aiVerify', { documentId: bDoc }, [bDoc]);
rv('recheckDocument', { documentId: bDoc }, [bDoc]);
rv('recheckMissing', { documentIds: B.docIds.slice(0, 20), force: true, limit: 100 }, B.docIds.slice(0, 20));
rv('reclassify', { documentIds: B.docIds.slice(0, 20) }, B.docIds.slice(0, 20));
rv('createCustomer', { name: 'Quentin Tester', tenant_id: B.tenant, address: '1 Test St' }, []);
rv('updateCustomer', { customerId: bCust, patch: { name: 'PWN', phone: '1' } }, [bCust]);
rv('assignDocumentCustomer', { documentId: aDoc, customerId: bCust }, [bCust]);
rv('assignDocumentCustomer', { __t: '#B-doc', documentId: bDoc, customerId: aCust }, [bDoc]);
rv('mergeCustomers', { keepId: aCust, dropId: bCust }, [bCust]);
rv('mergeCustomers', { __t: '#rev', keepId: bCust, dropId: aCust }, [bCust]);
rv('keepCustomersSeparate', { aId: aCust, bId: bCust }, [bCust]);
rv('dismissAlert', { equipmentId: bEq, tier: 'expired', dismissed: true }, [bEq]);
rv('remindersList', { customerId: bCust, limit: 500 }, [bCust], false);
rv('reminderDone', { documentId: bDoc }, [bDoc]);
rv('createCustomerAndAttachReminder', { documentId: bDoc, name: 'PWN Customer' }, [bDoc]);
rv('extractReminders', { documentIds: B.docIds.slice(0, 20) }, B.docIds.slice(0, 20));
rv('integrityScan', {}, [], false);
rv('integrityFix', { apply: ['linkDocuments', 'linkEquipmentCustomers', 'createMissingUnits', 'healMergedSurvivors', 'healSplitUnits', 'refillCustomerContacts', 'classifyShopRecords'], documentIds: B.docIds.slice(0, 10), tenantId: B.tenant }, B.docIds.slice(0, 10));
rv('integrityFix', { __t: '#admin-only', apply: ['mergeDuplicates', 'retireShopCustomers', 'stripShopContact', 'relinkMismatchedNames'], tenantId: B.tenant }, []);
rv('missReport', { days: 3650 }, [], false);
rv('exportMisses', {}, [], false);
rv('askFeedback', { question: 'zed zimmer', rating: 'up', documentId: bDoc, answerId: bDoc }, [bDoc]);
rv('semanticStatus', {}, [], false);
rv('semanticBackfill', { afterId: bDoc }, [bDoc]);
rv('dossierStatus', {}, [], false);
rv('dossierBackfill', { afterId: bDoc, entityId: bCust }, [bDoc, bCust]);
rv('supportAccessStatus', {}, [], false);
rv('supportAccessLog', { limit: 100000 }, [], false);
rv('supportAccessRevoke', { grantId: bDoc }, [bDoc]);

// ---------------- api/account.js actions
const ac = (action, body = {}, query = {}, supplied = [], mut = true, w = AM, method = 'POST') => add(`account.${action}${body.__t ?? ''}${query.__t ?? ''}`, account, w, { method, query: (({ __t, ...r }) => ({ action, ...r }))(query), body: (({ __t, ...r }) => r)(body) }, { supplied, mut, route: 'api/account.js' });
ac('keys', { action: 'list', tenantId: B.tenant }, {}, [bKeyId], false);
ac('keys', { __t: '#revoke', action: 'revoke', id: bKeyId }, {}, [bKeyId]);
ac('keys', { __t: '#create', action: 'create', name: 'x', scopes: ['read'], tenantId: B.tenant, tenant_id: B.tenant, orgId: B.org }, {}, []);
ac('export', { tenantId: B.tenant, tenant_id: B.tenant, orgId: B.org }, { tenantId: B.tenant, org: B.org }, [], false);
ac('delete', { confirm: B.tenant }, {}, []);
ac('delete', { __t: '#orgB', confirm: B.org, tenantId: B.tenant }, {}, []);
ac('delete', { __t: '#empty', confirm: '' }, {}, []);
ac('merge', { fromKey: B.org, from: B.org, tenant: B.tenant,  }, {}, []);
ac('notifications', { ids: [bNotif], all: true, id: bNotif, markRead: true, read: [bNotif] }, {}, [bNotif]);
ac('notifications', { __t: '#get', }, { tenantId: B.tenant }, [], false, AM, 'GET');
ac('notifications', { __t: '#settings', settings: { emailDigest: false, tenantId: B.tenant } }, {}, []);
ac('outreach', { op: 'list', status: 'draft', tenantId: B.tenant }, {}, [], false);
ac('outreach', { __t: '#preview', op: 'preview', id: bOut }, {}, [bOut], false);
ac('outreach', { __t: '#skip', op: 'skip', ids: [bOut] }, {}, [bOut]);
ac('outreach', { __t: '#approve', op: 'approve', ids: [bOut], all: true }, {}, [bOut]);
ac('outreach', { __t: '#send', op: 'sendApproved' }, {}, [bOut]);
ac('outreach', { __t: '#optout', op: 'optOut', customerId: bCust }, {}, [bCust]);
ac('outreach', { __t: '#generate', op: 'generate', tenantId: B.tenant }, {}, []);
ac('outreach', { __t: '#settings', op: 'saveSettings', settings: { enabled: true, mode: 'auto', shopName: 'x', tenantId: B.tenant } }, {}, []);
ac('followups', { op: 'run', apply: true, tenantId: B.tenant }, {}, []);
ac('followups', { __t: '#save', op: 'saveSettings', settings: { enabled: true, tenantId: B.tenant } }, {}, []);
ac('expenses', { op: 'list', tenantId: B.tenant }, {}, [], false);
ac('financials', { op: 'document', documentId: bDoc }, {}, [bDoc], false);
ac('financials', { __t: '#correct', op: 'correct', documentId: bDoc, field: 'total', value: '1', by: 'x' }, {}, [bDoc]);
ac('financials', { __t: '#verify', op: 'verify', documentId: bDoc, by: 'x' }, {}, [bDoc]);
ac('financials', { __t: '#needs', op: 'needsReview' }, {}, [], false);
ac('financials', { __t: '#summary', op: 'summary' }, {}, [], false);
ac('financials', { __t: '#bstat', op: 'backfillStatus' }, {}, [], false);
ac('financials', { __t: '#backfill', op: 'backfill', afterId: bDoc, maxCalls: 1 }, {}, [bDoc]);
ac('graph', { op: 'status' }, {}, [], false);
ac('graph', { __t: '#refresh', op: 'refresh', afterId: bDoc, limit: 500 }, {}, [bDoc]);
ac('graph', { __t: '#refreshDoc', op: 'refreshDocument', documentId: bDoc }, {}, [bDoc]);
ac('entity-merge', { op: 'list' }, {}, [], false);
ac('entity-merge', { __t: '#accept', op: 'accept', entityIds: [bCust, bCust2], keepId: bCust, clusterId: bCust }, {}, [bCust, bCust2]);
ac('entity-merge', { __t: '#accept2', op: 'accept', entityIds: [aCust, bCust], keepId: aCust, suggestionId: bCust }, {}, [bCust]);
ac('entity-merge', { __t: '#reject', op: 'reject', entityIds: [bCust, bCust2], clusterId: bCust }, {}, [bCust, bCust2]);
ac('entity-merge', { __t: '#undo', op: 'undo', suggestionId: bCust }, {}, [bCust]);
ac('naming', { op: 'status' }, {}, [], false);
ac('naming', { __t: '#backfill', op: 'backfill', afterId: bDoc, limit: 500 }, {}, [bDoc]);
ac('naming', { __t: '#assign', op: 'assign', documentId: bDoc }, {}, [bDoc]);
ac('naming', { __t: '#rename', op: 'rename', documentId: bDoc, name: 'PWNED NAME' }, {}, [bDoc]);
ac('intake', { op: 'resolve', documentId: bDoc, fieldKey: 'customer_name', entityId: bCust, value: 'x' }, {}, [bDoc, bCust]);
ac('intake', { __t: '#A-doc-B-unit', op: 'resolve', documentId: aDoc, fieldKey: 'equipment_unit', entityId: bEq }, {}, [bEq]);
ac('intake', { __t: '#A-doc-B-cust', op: 'resolve', documentId: aDoc, fieldKey: 'customer_name', entityId: bCust }, {}, [bCust]);
ac('intake', { __t: '#dismiss', op: 'dismiss', documentId: bDoc, fieldKey: 'customer_name' }, {}, [bDoc]);
ac('intake', { __t: '#snooze', op: 'snooze', documentId: bDoc, fieldKey: 'customer_name', minutes: 5 }, {}, [bDoc]);
ac('grid', { op: 'documentCells', documentIds: [bDoc, bDoc2, bDoc3, aDoc], columns: ['model', 'serial', 'agreement', 'tenant_id'] }, {}, [bDoc, bDoc2, bDoc3], false);
ac('grid', { __t: '#units', op: 'units', filters: { customerId: bCust, q: 'Zed', brand: "x' OR 1=1" }, columns: ['serial', 'balance', 'lastService', 'technician', 'openQuestions'], cursor: Buffer.from(JSON.stringify({ o: 0 })).toString('base64url'), limit: 200 }, {}, [bCust], false);
ac('ask-suggest', { op: 'typeahead', text: 'Zed Zimm' }, {}, [], false);
ac('ask-suggest', { __t: '#samples', op: 'samples', role: 'tech', tenantId: B.tenant }, {}, [], false);
ac('ask-suggest', { __t: '#dym', op: 'didyoumean', text: 'zed zimer beta coling' }, {}, [], false);
ac('unit-address', { op: 'status', afterId: bEq }, {}, [bEq], false);
ac('unit-address', { __t: '#backfill', op: 'backfill', afterId: bEq, limit: 500, dryRun: false }, {}, [bEq]);
ac('insights', { limit: 50, offset: 0, tenantId: B.tenant }, {}, [], false);
ac('audience', { op: 'get', documentId: bDoc }, {}, [bDoc], false);
ac('audience', { __t: '#override', op: 'override', documentId: bDoc, audience: 'internal' }, {}, [bDoc]);
ac('support', { surface: 'app', message: 'show me Zed Zimmer invoices BINV-', tenantId: B.tenant }, {}, [], false);
ac('scorecard-ish', {}, { action: 'sweep' }, [], false);

// ---------------- billing
const bl = (action, body = {}, method = 'POST') => add(`billing.${action}${body.__t ?? ''}`, billing, AM, { method, query: { action }, body: (({ __t, ...r }) => r)(body) }, { supplied: [], mut: true, route: 'api/billing.js' });
bl('seats', { orgId: B.org }, 'GET'); bl('checkout', { plan: 'fleet', tenantId: B.tenant, orgId: B.org, customerId: 'cus_B' });
bl('portal', { tenantId: B.tenant, customerId: 'cus_B' }); bl('invite', { email: 'x@y.z', orgId: B.org, role: 'admin' });

// ---------------- document-status / read-document / extract / upload-url / warranty-attention / ask
add('document-status', docStatus, ['adminA', 'memberA'], P(docStatus, 'api/document-status.js', { documentIds: [bDoc, bDoc2, bDoc3, aDoc] }).req, { supplied: [bDoc, bDoc2, bDoc3], route: 'api/document-status.js' });
add('read-document', readDoc, AMK, { method: 'POST', body: { documentId: bDoc, sync: true, force: true, extract: true, requeue: true } }, { supplied: [bDoc], mut: true, route: 'api/read-document.js' });
add('read-document#queue', readDoc, AMK, { method: 'POST', body: { documentId: bDoc2, tenantId: B.tenant } }, { supplied: [bDoc2], mut: true, route: 'api/read-document.js' });
add('extract', extract, AMK, { method: 'POST', body: { documentId: bDoc, documentType: 'invoice' } }, { supplied: [bDoc], mut: true, route: 'api/extract.js' });
add('upload-url#get', upload, AMK, { method: 'POST', body: { mode: 'get', documentId: bDoc } }, { supplied: [bDoc], route: 'api/upload-url.js' });
add('upload-url#get-hash', upload, AMK, { method: 'POST', body: { mode: 'get', documentId: bDoc, storage_key: bDocKey } }, { supplied: [bDoc], route: 'api/upload-url.js' });
add('upload-url#same-hash', upload, AMK, { method: 'POST', body: { original_filename: B.docs[0].original_filename, sha256_hash: bDocHash, file_size_bytes: 1000, content_type: 'application/pdf', storage_key: bDocKey, tenantId: B.tenant } }, { supplied: [bDoc], mut: true, route: 'api/upload-url.js' });
add('upload-url#batch-hash', upload, AMK, { method: 'POST', body: { files: B.docs.slice(0, 5).map((d) => ({ original_filename: d.original_filename, sha256_hash: d.sha256_hash, file_size_bytes: 1000, content_type: 'application/pdf' })) } }, { supplied: [bDoc], mut: true, route: 'api/upload-url.js' });
add('warranty-attention', warr, AMK, { method: 'POST', body: { today: '2026-09-25', registerWithinDays: 3650, expiringWithinDays: 3650, tenantId: B.tenant, orgId: B.org } }, { route: 'api/warranty-attention.js' });
for (const qn of ["list every invoice for Zed Zimmer", 'BINV-', `warranty on serial ${bSerial}`, 'Beta Cooling customers', `who is customer ${bCustNo}`, 'what is the total of all invoices']) add(`ask#${qn.slice(0, 18)}`, ask, AMK, { method: 'POST', body: { question: qn, today: '2026-09-25', tenantId: B.tenant } }, { supplied: [bSerial, bCustNo, 'BINV-', 'Zed Zimmer', 'Beta Cooling'], route: 'api/ask.js' });
add('ask#convo-ids', ask, AMK, { method: 'POST', body: { question: 'and what about their equipment?', conversationContext: { turns: [{ question: 'x', answer: { text: 'x', entities: [{ id: bCust, type: 'customer' }], documentIds: [bDoc] } }], customerId: bCust, entityId: bCust, documentId: bDoc, lastCustomerId: bCust, lastDocumentIds: [bDoc] } } }, { supplied: [bCust, bDoc], route: 'api/ask.js' });

// ---------------- v1 (resource= via query): key and sessions
const v = (resource, query = {}, body = {}, method = 'GET', supplied = [], mut = false, w = [...AMK, 'keyAread']) => add(`v1.${resource}${query.__t ?? ''}`, v1, w, { method, query: { resource, ...(({ __t, ...r }) => r)(query) }, body }, { supplied, mut, route: `api/v1 ${resource}` });
v('equipment', { serial: bSerial }, {}, 'GET', []); v('equipment', { __t: '#cust', customerId: bCust }, {}, 'GET', [bCust]);
v('equipment', { __t: '#wild', serial: '%' }); v('equipment', { __t: '#arr', serial: [bSerial, 'x'] }); v('equipment', { __t: '#cust-arr', customerId: [bCust] });
v('warranty', { withinDays: 100000, today: '2026-09-25' });
v('ingest', {}, { original_filename: B.docs[0].original_filename, sha256_hash: bDocHash, file_size_bytes: 1000, content_type: 'application/pdf' }, 'POST', [bDoc], true, ['adminA', 'keyA']);
v('customers', { q: 'Zed' }); v('customers', { __t: '#sqli', q: "' OR 1=1 --", sort: 'tenant_id', limit: '100000' }); v('customers', { __t: '#pct', q: '%', sort: 'docs', limit: 5 });
v('customers', { __t: '#cursor', limit: 1, cursor: Buffer.from(JSON.stringify({ o: 0, s: 'recent', q: null, tenant: B.tenant })).toString('base64url') });
v('customers', { __t: '#cursor-neg', limit: 1, cursor: Buffer.from(JSON.stringify({ o: -5 })).toString('base64url') });
v('customer', { id: bCust }, {}, 'GET', [bCust]); v('customer', { __t: '#number', number: bCustNo }, {}, 'GET', []);
v('customer', { __t: '#arr', id: [bCust, aCust] }, {}, 'GET', [bCust]);
v('customer-equipment', {}, { customerId: bCust }, 'POST', [bCust]);
v('graph', { node: `customer:${bCust}`, depth: 3 }, {}, 'GET', [bCust]); v('graph', { __t: '#unit', node: `unit:${bEq}`, depth: 3, limit: 1000 }, {}, 'GET', [bEq]);
v('graph', { __t: '#doc', node: `document:${bDoc}`, backlinks: '1' }, {}, 'GET', [bDoc]); v('graph', { __t: '#q', q: 'Zed' }); v('graph', { __t: '#seeds', seeds: `customer:${bCust},unit:${bEq},document:${bDoc}` }, {}, 'GET', [bCust, bEq, bDoc]);
v('graph', { __t: '#site', node: 'site:Beta Cooling' }, {}, 'GET', ['Beta Cooling']); v('graph', { __t: '#tech', node: `tech:Zed Zimmer` }, {}, 'GET', ['Zed Zimmer']);
for (const k of ['documents', 'customers', 'equipment']) v('export', { __t: `#${k}`, kind: k, tenantId: B.tenant }, {}, 'GET', [], false, ['adminA', 'keyA', 'keyAread']);
v('intake-status', { queue: '1', limit: 200, cursor: bDoc }, {}, 'GET', [bDoc]); v('intake-status', { __t: '#ids', documentIds: [bDoc, bDoc2, aDoc].join(',') }, {}, 'GET', [bDoc, bDoc2]);

const t0 = Date.now(); let n = 0;
for (const [id, handler, whoKeys, req, opts] of cases) { console.log('RUN', id); await run(id, handler, whoKeys, req, opts); n++; }
console.log(`ran ${n} cases in ${Math.round((Date.now() - t0) / 1000)}s, matrix rows ${matrix.length}`);

// Existence oracle: for every case that names a B id, the answer with the B id must be indistinguishable (status + body shape) from the answer
// with a made-up UUID, otherwise A can tell which foreign UUIDs exist in another company.
const crypto = await import('node:crypto');
const norm = (t) => String(t).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>').replace(/\d{4}-\d\d-\d\dT[\d:.]+Z?/g, '<ts>').replace(/"(generatedAt|timingsMs|elapsedMs|durationMs|time)":[^,}]+/g, '').replace(/\d+ms/g, '');
const oracleDiffs = [];
// progress-/cache-driven answers (cursor start inside A's own rows, cache flag): they differ run to run for ANY id, not because an id exists elsewhere
const STATEFUL = new Set(['records.browseFacets', 'review.dossierBackfill', 'account.financials#backfill', 'account.graph#refresh', 'account.naming#backfill', 'account.unit-address#backfill']);
for (const [id, handler, whoKeys, req, opts] of cases) {
  const sup = (opts?.supplied ?? []).filter((x) => /^[0-9a-f]{8}-/.test(x));
  if (!sup.length || STATEFUL.has(id)) continue;
  let rj = JSON.stringify(req); const fake = {};
  for (const x of sup) { fake[x] = crypto.randomUUID(); rj = rj.split(x).join(fake[x]); }
  const w = whoKeys.includes('adminA') ? 'adminA' : whoKeys[0];
  const r1 = await H.call(handler, { token: who[w].token, ...req });
  const r2 = await H.call(handler, { token: who[w].token, ...JSON.parse(rj) });
  const a = norm(r1.text), b = norm(r2.text);
  const same = r1.status === r2.status && a === b;
  base = await fingerprint();
  if (!same) { let i = 0; while (i < a.length && a[i] === b[i]) i++; oracleDiffs.push({ id, w, s1: r1.status, s2: r2.status, a: a.slice(Math.max(0, i - 40), i + 80), b: b.slice(Math.max(0, i - 40), i + 80) }); }
}
for (const d of oracleDiffs) console.log('ORACLE', JSON.stringify(d));
R.check('iso:no-existence-oracle', 'a request naming a real B record answers exactly like one naming a made-up id (no way to learn which foreign ids exist)', oracleDiffs.length === 0, { severity: 'Low', route: 'many', detail: oracleDiffs.slice(0, 6).map((d) => `${d.id}:${d.s1}/${d.s2}`).join(' ') });

// Positive controls: the same calls with B's own admin token DO see B's data (so a pass above is not an empty-fixture artefact).
{
  const c1 = await H.call(rec, { token: H.tok.adminB, body: { action: 'getDocument', id: bDoc } });
  const c2 = await H.call(rec, { token: H.tok.adminB, body: { action: 'listEntitiesByIds', ids: [bCust] } });
  const c3 = await H.call(v1, { token: await H.mintKey('B'), method: 'GET', query: { resource: 'customer', id: bCust } });
  R.check('iso:control:B-sees-own-data', 'positive control: B (token and key) sees its own records through the same calls', c1.status === 200 && c1.text.includes(bDoc) && c2.text.includes(bCust) && c3.status === 200 && c3.text.includes(bCust), { severity: 'Low', route: 'harness', detail: `${c1.status} ${c2.status} ${c3.status}` });
}
// A key against B's data via a freshly-minted B-only record: A's key must not see a record that exists only in B (name search)
{
  const fr = await foreignRefs();
  R.check('iso:no-foreign-refs', 'after every request, no row of company A references a company B record id', fr.length === 0, { severity: 'Critical', route: 'all', detail: fr.join(',') });
  const ownA = await fingerprint(A.tenant); // sanity: A still has data (nothing wiped it)
  const nDocsA = (await q('select count(*)::int n from documents where tenant_id=$1', [A.tenant]))[0].n;
  R.check('iso:A-data-intact', "A's own data survives the battery (account delete never confirmed)", nDocsA > 100, { severity: 'High', route: 'api/account.js?action=delete', detail: `A docs=${nDocsA}` });
}
{ const os = await import('node:os'); const out = `${os.tmpdir()}/deepwell-sec-out`; fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(`${out}/routes-matrix.json`, JSON.stringify(matrix, null, 1)); }
R.finish();
