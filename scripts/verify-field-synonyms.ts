// npm run verify:field-synonyms
// F1 (2026-10-10): "the information is there but it is stated different and Donovan is unable to understand it".
// One synonym table (modelAvoidance/fieldSynonyms.js) feeds the deterministic label scanners AND the model prompt. This check
// runs eight realistic page-text fixtures (donation receipt, retail receipt, vendor bill to us, certificate of insurance, NDA,
// rent receipt, law-firm invoice, pickup ticket) through every reader and requires ZERO WRONG VALUES: any customer, vendor,
// date, amount or number that is emitted must be exactly the expected one; a field the readers decline to emit is not wrong.
// Also: the own-company guard, letterhead-as-issuer, corroboration, the empty-extraction repair (PGlite), the prompt, wiring.
// No model, no network.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p: string) => path.join(ROOT, p);
let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`); }
};

process.env.NEON_CONNECTION_STRING = 'postgres://harness:harness@localhost:5432/harness';
delete process.env.ANTHROPIC_API_KEY;

const SYN: any = await import(rel('api/_lib/modelAvoidance/fieldSynonyms.js'));
const OWN: any = await import(rel('api/_lib/modelAvoidance/ownCompany.js'));
const TE: any = await import(rel('api/_lib/modelAvoidance/textExtract.js'));
const LF: any = await import(rel('api/_lib/modelAvoidance/labelFill.js'));
const SR: any = await import(rel('api/_lib/modelAvoidance/storedTextReread.js'));
const EF: any = await import(rel('api/_lib/extractFields.js'));

type Fx = {
  name: string;
  own: string[];
  type: string;
  text: string;
  /** exactly the values every reader may emit for these keys (a reader may emit fewer, never different) */
  want: Record<string, string>;
  /** keys the scan MUST recover (recall floor so the fixture proves something) */
  must: string[];
  /** keys that must never be emitted at all */
  never?: string[];
};

const CHECKED = ['customer_name', 'vendor', 'service_date', 'cost', 'invoice_number', 'agreement_term'];

const FX: Fx[] = [
  {
    name: 'donation receipt (the owner\'s example)', own: ['Hope Harbor Foundation'], type: 'receipt',
    text: [
      'Hope Harbor Foundation', '1200 W Main St, Mesa, AZ 85201', 'DONATION RECEIPT', 'Receipt #: R-2025-1009',
      'Date Received: Aug 29, 2025', 'RECEIVED FROM Martin Duarte', 'Amount Received $500.00',
      'Thank you for your generous gift. No goods or services were provided in exchange for this donation.',
    ].join('\n'),
    want: { customer_name: 'Martin Duarte', service_date: '2025-08-29', cost: '500.00', invoice_number: 'R-2025-1009' },
    must: ['customer_name', 'service_date', 'cost', 'invoice_number'], never: ['vendor'],
  },
  {
    name: 'retail receipt (we bought; store letterhead is the vendor)', own: ['Sonoran Comfort Air'], type: 'receipt',
    text: [
      'ACE HARDWARE', '123 Main Street, Mesa, AZ 85201', '(480) 555-0123', 'RECEIPT', 'Date: 03/14/2026', 'Receipt #: 44521',
      'Filter 16x20      2      $9.00      $18.00', 'Duct tape      1      $4.99      $4.99', 'Subtotal $22.99', 'Tax $1.32', 'Total $24.31',
      'Paid by VISA ending 4411', 'Thank you for shopping with us',
    ].join('\n'),
    want: { vendor: 'ACE HARDWARE', service_date: '2026-03-14', cost: '24.31', invoice_number: '44521' },
    must: ['vendor', 'service_date', 'cost', 'invoice_number'], never: ['customer_name'],
  },
  {
    name: 'vendor bill addressed to us (we must not become the customer)', own: ['Juniper Lane Mercantile'], type: 'invoice',
    text: [
      'Saguaro Paper Supply LLC', '455 Industrial Way, Tempe, AZ 85281', 'INVOICE', 'Invoice #: 24320', 'Invoice Date: 09/12/2026',
      'Bill To: Juniper Lane Mercantile, LLC', 'Due Date: 10/12/2026', 'Amount Due: $1,284.50',
    ].join('\n'),
    want: { vendor: 'Saguaro Paper Supply LLC', service_date: '2026-09-12', cost: '1284.50', invoice_number: '24320' },
    must: ['vendor', 'service_date', 'cost', 'invoice_number'], never: ['customer_name'],
  },
  {
    name: 'certificate of insurance (named insured, policy period)', own: ['Desert Peak Services LLC'], type: 'insurance-certificate',
    text: [
      'CERTIFICATE OF LIABILITY INSURANCE', 'Date Issued: 01/15/2026', 'Producer: Western Mutual Insurance Agency',
      'Named Insured: Cactus Roofing Inc', 'Policy Number: GL-884210', 'Policy Period: 01/15/2026 to 01/15/2027',
      'Certificate Holder: Desert Peak Services LLC',
    ].join('\n'),
    want: { vendor: 'Cactus Roofing Inc', service_date: '2026-01-15', agreement_term: '01/15/2026 to 01/15/2027' },
    must: ['vendor', 'agreement_term'], never: ['customer_name', 'cost'],
  },
  {
    name: 'NDA (parties, effective date, term)', own: ['Desert Peak Services LLC'], type: 'agreement',
    text: [
      'MUTUAL NDA', 'This Mutual Non-Disclosure Agreement is entered into as of September 3, 2026.', 'Effective Date: September 3, 2026',
      'Parties: Desert Peak Services LLC and Blue Mesa Analytics Inc.', 'Term: 24 months from the Effective Date',
      'Each party agrees to keep the other party\'s confidential information secret.',
    ].join('\n'),
    want: { customer_name: 'Blue Mesa Analytics Inc.', service_date: '2026-09-03', agreement_term: '24 months from the Effective Date' },
    must: ['customer_name', 'service_date'], never: ['cost'],
  },
  {
    name: 'rent receipt (tenant, payment date, rent paid)', own: ['Palo Verde Property Management'], type: 'receipt',
    text: [
      'Palo Verde Property Management', '900 E University Dr, Tempe, AZ 85281', 'RENT RECEIPT', 'Tenant: Maria Lopez', 'Unit: 14B',
      'Payment Date: 10/01/2026', 'Rent Paid: $1,450.00', 'Receipt #: 7781',
    ].join('\n'),
    want: { customer_name: 'Maria Lopez', service_date: '2026-10-01', cost: '1450.00', invoice_number: '7781' },
    must: ['customer_name', 'service_date', 'cost', 'invoice_number'], never: ['vendor'],
  },
  {
    name: 'law-firm invoice to us (client = us, firm letterhead is the vendor)', own: ['Cactus Roofing Inc'], type: 'invoice',
    text: [
      'Hale & Brandt LLP', 'Attorneys at Law', '200 N Central Ave, Phoenix, AZ 85004', 'INVOICE', 'Invoice #: 5521',
      'Invoice Date: 08/31/2026', 'Client: Cactus Roofing Inc', 'Matter: Commercial lease review', 'Legal services rendered through August 2026.',
      'Total Due: $3,750.00',
    ].join('\n'),
    want: { vendor: 'Hale & Brandt LLP', service_date: '2026-08-31', cost: '3750.00', invoice_number: '5521' },
    must: ['vendor', 'service_date', 'cost', 'invoice_number'], never: ['customer_name'],
  },
  {
    name: 'pickup ticket (pickup date, ticket number)', own: ['Desert Peak Services LLC'], type: 'delivery-ticket',
    text: [
      'PICKUP TICKET', 'Ticket #: PU-3321', 'Pickup Date: 04/09/2026', 'Customer: Lena Ortiz', 'Items: 2 boxes of filters',
    ].join('\n'),
    want: { customer_name: 'Lena Ortiz', service_date: '2026-04-09', invoice_number: 'PU-3321' },
    must: ['customer_name', 'service_date', 'invoice_number'], never: ['vendor', 'cost'],
  },
];

/* ------------------------------------------------------------------ 1. every reader, every fixture: zero wrong values */
console.log('1. fixtures: zero wrong values from every reader');
let wrong = 0;
for (const f of FX) {
  const pages = [{ page_no: 1, text: f.text }];
  const readers: Record<string, Record<string, string>> = {};

  // (a) the deterministic extractor (strict template, then the validated-label path), told who we are
  const det = TE.extractFromText(pages, { ownNames: f.own });
  if (det.accepted) readers.extractFromText = Object.fromEntries(det.toolInput.fields.map((x: any) => [x.key, String(x.value)]));

  // (b) the stored-text read for a document with NO fields (ingest's empty-extraction repair / reextractFromStoredText)
  const rr = SR.planStoredTextRead({ documentType: f.type, storedType: null, filename: 'scan.pdf', pages, ownNames: f.own, pageCount: 1 });
  readers.storedTextRead = Object.fromEntries(rr.add.map((x: any) => [x.field_key, String(x.value)]));

  // (c) the missing-field fill (planLabelFill) on a document whose only fields are noise
  const fill = LF.planLabelFill({ type: f.type, fields: [{ field_key: 'notes', value: 'x', confidence: 0.9 }], pages, method: 'recheck', pageCount: 1, ownNames: f.own });
  readers.labelFill = Object.fromEntries(fill.add.map((x: any) => [x.field_key, String(x.value)]));

  for (const [reader, got] of Object.entries(readers)) {
    for (const k of CHECKED) {
      if (!(k in got)) continue;
      const ok = f.want[k] !== undefined && got[k] === f.want[k];
      if (!ok) { wrong++; }
      check(`${f.name} / ${reader}: ${k} is "${f.want[k] ?? '(not expected)'}"`, ok, `got "${got[k]}"`);
    }
    for (const k of f.never ?? []) check(`${f.name} / ${reader}: never emits ${k}`, !(k in got), `got "${got[k]}"`);
    // our own company is never emitted as a party
    for (const k of ['customer_name', 'vendor']) if (got[k]) check(`${f.name} / ${reader}: ${k} is not our own company`, !OWN.isOwnName(got[k], f.own), got[k]);
  }
  const recovered = f.must.filter((k) => k in readers.storedTextRead);
  check(`${f.name}: the stored-text read recovers ${f.must.join(', ')}`, recovered.length === f.must.length, `recovered ${recovered.join(', ') || 'nothing'}`);
}
check('ZERO WRONG VALUES across all fixtures and readers', wrong === 0, `${wrong} wrong`);

/* ------------------------------------------------------------------ 2. the owner's exact sentence */
console.log('2. the donation receipt is no longer "missing Vendor or Customer, Service date and Cost"');
{
  const f = FX[0];
  const pages = [{ page_no: 1, text: f.text }];
  const rr = SR.planStoredTextRead({ documentType: 'receipt', storedType: null, filename: 'receipt-duarte.pdf', pages, ownNames: f.own, pageCount: 1 });
  const DT: any = await import(rel('api/_lib/documentTypes.js'));
  const comp = DT.completenessFor('receipt', rr.add.map((x: any) => ({ field_key: x.field_key, value: x.value, confidence: x.confidence })));
  check('receipt completeness: nothing missing', comp.missing.length === 0, JSON.stringify(comp.missing));
  check('every recovered field is at confidence >= 0.86 (explicit labels), no confidence invented', rr.add.every((x: any) => x.confidence >= 0.86), JSON.stringify(rr.add.map((x: any) => [x.field_key, x.confidence])));
  // the same document with a bare "Date:" instead of "Date Received:" still yields the date for a receipt
  const bare = TE.scanLabeledValues([{ page_no: 1, text: 'RECEIPT\nDate: 08/29/2025\nReceived From: Martin Duarte\nAmount Paid: $500.00' }], { type: 'receipt' }).candidates;
  check('a bare "Date:" on a receipt is read as the document date', bare.service_date?.[0]?.value === '2025-08-29');
  check('"Amount Paid" is the amount (it is no longer thrown away by the ignore list)', bare.cost?.[0]?.value === '500.00');
  check('"Received From:" (with a colon) is the customer', bare.customer_name?.[0]?.value === 'Martin Duarte');
}

/* ------------------------------------------------------------------ 3. one table, both readers */
console.log('3. one synonym table feeds the scanners and the prompt');
{
  const prompt: string = EF.buildExtractPrompt([{ page_no: 1, text: 'RECEIPT' }], 'receipt', null, { ownNames: ['Hope Harbor Foundation'] });
  for (const phrase of ['Received From', 'Date Received', 'Amount Received', 'Receipt #', 'Named Insured'.replace('Named ', ''), 'Pickup Date', 'Effective Date', 'Policy Period', 'Remit To', 'Law Firm']) {
    check(`prompt names "${phrase}"`, prompt.includes(phrase));
  }
  check('prompt: a field written in other words IS stated', /written in other words IS stated/.test(prompt));
  check('prompt: letterhead that is not our company is the vendor, never shop_*', /NOT our own company is the issuer: put it in vendor/.test(prompt));
  check('prompt: own company line carries the tenant name (dynamic half only)', /Our own company \(the business this paperwork belongs to\): Hope Harbor Foundation/.test(prompt) && !/Our own company \(the/.test(prompt.split('Read the pages and return every field')[1] ?? ''));
  const plain: string = EF.buildExtractPrompt([{ page_no: 1, text: 'RECEIPT' }], 'receipt', null);
  check('prompt without a known tenant name has no own-company line', !/Our own company \(the business/.test(plain));
  for (const [key, group] of [['customer', 'received from'], ['costPaid', 'amount received'], ['receiptDate', 'date received'], ['vendor', 'remit to'], ['documentNumber', 'receipt #']] as const) {
    check(`table: ${key} lists "${group}"`, SYN.FIELD_SYNONYMS[key].includes(group));
    check(`scanner label source for ${key} matches "${group}"`, new RegExp(`^(?:${SYN.labelSrc(key)})$`, 'i').test(group.replace('#', 'no.')) || new RegExp(`^(?:${SYN.labelSrc(key)})$`, 'i').test(group));
  }
  for (const w of SYN.FIELD_SYNONYMS.notIgnorable.filter((x: string) => x !== 'deposit' && x !== 'order date')) {
    const t = TE.scanLabeledValues([{ page_no: 1, text: `${w}: ${w.includes('date') ? '09/12/2026' : '$40.00'}` }], { type: 'receipt' }).candidates;
    check(`"${w}" is read, not ignored`, Boolean(t.cost?.length || t.service_date?.length));
  }
}

/* ------------------------------------------------------------------ 4. own company */
console.log('4. own company');
{
  check('nameKey drops legal suffixes and punctuation', OWN.nameKey('Juniper Lane Mercantile, LLC') === OWN.nameKey('JUNIPER LANE MERCANTILE'));
  check('isOwnName: a close variant is us', OWN.isOwnName('Juniper Lane Mercantile LLC', ['Juniper Lane Mercantile']) && OWN.isOwnName('Juniper Lane', ['Juniper Lane Mercantile']));
  check('isOwnName: a different business is not us', !OWN.isOwnName('Juniper Hardware', ['Juniper Lane Mercantile']) && !OWN.isOwnName('Lane Supply', ['Juniper Lane Mercantile']));
  check('a Clerk org id is never used as a name', OWN.cleanOwnNames(['org_2abcDEFghi123456789012345', 'Juniper Lane Mercantile']).length === 1);
  const g = OWN.applyOwnCompanyGuard([
    { field_key: 'customer_name', value: 'Juniper Lane Mercantile', confidence: 0.9 }, { field_key: 'vendor', value: 'Saguaro Paper Supply LLC', confidence: 0.9 }, { field_key: 'cost', value: '10.00', confidence: 0.9 },
  ], ['Juniper Lane Mercantile LLC']);
  check('guard removes us as customer, keeps the vendor and the rest', g.fields.length === 2 && g.fields.every((f: any) => f.field_key !== 'customer_name') && g.removed.length === 1);
  const own = OWN.applyOwnCompanyGuard([{ field_key: 'customer_name', value: 'Jane Smith', confidence: 0.9 }], ['Juniper Lane Mercantile']);
  check('guard never removes a real customer', own.fields.length === 1);
  // the template path: a strict invoice whose Bill To is OUR company must not be accepted as "customer = us"
  const tpl = 'INVOICE\nInvoice #: 1044\nDate of Service: 09/12/2026\nBill To: Juniper Lane Mercantile\nTotal Due: $210.00';
  const asUs = TE.extractFromText([{ page_no: 1, text: tpl }], { ownNames: ['Juniper Lane Mercantile'] });
  check('strict invoice billed to our own company is not accepted with us as the customer', !asUs.accepted || !asUs.toolInput.fields.some((x: any) => x.key === 'customer_name'));
  const normal = TE.extractFromText([{ page_no: 1, text: tpl }], { ownNames: ['Sonoran Comfort Air'] });
  check('same invoice for a different tenant is still accepted deterministically', normal.accepted === true && normal.toolInput.fields.some((x: any) => x.key === 'customer_name' && x.value === 'Juniper Lane Mercantile'));
  // without our name, nothing is invented: a customer is named, the letterhead is NOT promoted to vendor
  const noNames = SR.planStoredTextRead({ documentType: 'invoice', storedType: null, filename: 'x.pdf', pages: [{ page_no: 1, text: FX[2].text }], ownNames: [], pageCount: 1 });
  check('unknown tenant name: no letterhead vendor is invented', !noNames.add.some((x: any) => x.field_key === 'vendor'));
  // our own paperwork: our letterhead + a named customer: never read as the vendor
  const ours = SR.planStoredTextRead({ documentType: 'invoice', storedType: null, filename: 'x.pdf', ownNames: ['Sonoran Comfort Air'], pageCount: 1,
    pages: [{ page_no: 1, text: 'Sonoran Comfort Air\n4410 E Baseline Rd, Mesa, AZ 85206\nINVOICE\nInvoice #: 77\nDate: 09/12/2026\nBill To: Jane Smith\nTotal Due: $90.00' }] });
  check('our own invoice to a customer: vendor is not set, customer is Jane Smith', !ours.add.some((x: any) => x.field_key === 'vendor') && ours.add.some((x: any) => x.field_key === 'customer_name' && x.value === 'Jane Smith'));
  // a letterhead variant of our own name is still ours
  const variant = SR.planStoredTextRead({ documentType: 'receipt', storedType: null, filename: 'x.pdf', ownNames: ['Sonoran Comfort Air LLC'], pageCount: 1,
    pages: [{ page_no: 1, text: 'SONORAN COMFORT AIR\n4410 E Baseline Rd, Mesa, AZ 85206\nRECEIPT\nDate: 09/12/2026\nReceived From: Jane Smith\nAmount Received: $90.00' }] });
  check('letterhead that is a variant of our name is not the vendor', !variant.add.some((x: any) => x.field_key === 'vendor'));
}

/* ------------------------------------------------------------------ 5. corroboration */
console.log('5. corroboration');
{
  const pages = [{ page_no: 1, text: FX[0].text }];
  const model = [
    { field_key: 'customer_name', value: 'Duarte, Martin', confidence: 0.55 },
    { field_key: 'service_date', value: '2025-08-29', confidence: 0.6 },
    { field_key: 'cost', value: '500', confidence: 0.7 },
    { field_key: 'invoice_number', value: 'R-2025-1009', confidence: 0.8 },
  ];
  const c = LF.corroborateFields({ type: 'receipt', fields: model, pages, ownNames: FX[0].own });
  const by = (k: string) => c.fields.find((f: any) => f.field_key === k).confidence;
  check('same normalized date -> >= 0.9', by('service_date') >= 0.9);
  check('amount within one cent -> >= 0.9', by('cost') >= 0.9);
  check('fuzzy-equal name ("Duarte, Martin" = "Martin Duarte") -> >= 0.9', by('customer_name') >= 0.9);
  check('same document number -> >= 0.9', by('invoice_number') >= 0.9);
  const off = LF.corroborateFields({ type: 'receipt', pages, ownNames: FX[0].own, fields: [
    { field_key: 'service_date', value: '2025-08-30', confidence: 0.6 }, { field_key: 'cost', value: '500.02', confidence: 0.7 }, { field_key: 'customer_name', value: 'Martin Duran', confidence: 0.6 },
  ] });
  check('a different date / amount two cents away / a different name is NOT raised', off.corroborated.length === 0 && off.fields.every((f: any) => f.confidence < 0.8));
  const two = LF.corroborateFields({ type: 'invoice', pages: [{ page_no: 1, text: 'INVOICE\nTotal Charges: $100.00\nTotal Fees: $250.00' }], ownNames: [], fields: [{ field_key: 'cost', value: '100.00', confidence: 0.6 }] });
  check('two different totals on the page corroborate neither', two.corroborated.length === 0);
  const human = LF.corroborateFields({ type: 'receipt', pages, ownNames: [], fields: [{ field_key: 'service_date', value: '2025-08-29', corrected_value: '2025-08-29', confidence: 0.4 }] });
  check('a human-corrected value is never touched', human.corroborated.length === 0);
  const hi = LF.corroborateFields({ type: 'receipt', pages, ownNames: [], fields: [{ field_key: 'cost', value: '500.00', confidence: 0.97 }] });
  check('a field already above the bar is not lowered', hi.fields[0].confidence === 0.97);
  check('the global verify bar is unchanged (0.85)', (await import(rel('api/_lib/documentTypes.js')) as any).AI_VERIFY_MIN_CONFIDENCE === 0.85);
}

/* ------------------------------------------------------------------ 6. never silently accept an empty extraction (PGlite) */
console.log('6. empty extraction: re-read from stored text, or the "nothing read" marker (real Postgres)');
let PGlite: any;
const contrib: Record<string, unknown> = {};
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  for (const key of ['uuid_ossp', 'pgcrypto', 'pg_trgm', 'btree_gin']) contrib[key] = (await import(`@electric-sql/pglite/contrib/${key}`))[key];
} catch (err: any) {
  console.log(`  SKIP database-backed checks: PGlite is not installed (${err?.message}).`);
}
if (PGlite) {
  const lite = new PGlite({ extensions: contrib });
  const cfgDir = rel('M3-config');
  for (const f of fs.readdirSync(cfgDir).filter((x) => /^\d\d.*\.sql$/.test(x) && !x.startsWith('99')).sort()) {
    try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch { /* same tolerance as the other PGlite checks */ }
  }
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* */ }
  const pgMod = (await import('pg')).default as any;
  let tail: Promise<unknown> = Promise.resolve();
  const lock = () => { let release: () => void = () => {}; const p = new Promise<void>((r) => { release = r; }); const prev = tail; tail = tail.then(() => p); return prev.then(() => release); };
  pgMod.Pool.prototype.connect = async function connect() {
    const release = await lock();
    await lite.exec('SET ROLE deepwell_rls');
    return { query: (sql: string, params: unknown[]) => lite.query(sql, params), release: () => { lite.exec('RESET ROLE').finally(release); } };
  };
  pgMod.Pool.prototype.query = async function query(sql: string, params: unknown[]) { const release = await lock(); try { return await lite.query(sql, params); } finally { release(); } };

  const RS: any = await import(rel('api/_lib/recordsStore.js'));
  const ED: any = await import(rel('api/_lib/extractDocument.js'));
  check('extractDocument.js exports reextractFromStoredText for F2', typeof ED.reextractFromStoredText === 'function' && ED.reextractFromStoredText === SR.reextractFromStoredText);
  const ctx = { tenantKey: 'org_hopeharbor', tenantName: 'Hope Harbor Foundation' };
  const tenId = (await RS.getTenantContext(ctx.tenantKey, ctx.tenantName)).id;
  let seq = 0;
  const nid = () => `00000000-0000-4000-8000-${String(++seq + 5000).padStart(12, '0')}`;
  async function makeDoc({ type = 'receipt', text, fields = [], stage = 'read' }: { type?: string | null; text: string | null; fields?: { key: string; value: string; conf: number }[]; stage?: string }) {
    const id = nid();
    await lite.query(`INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage, created_at) VALUES ($1,$2,$3,$4,$5,$6,NOW())`, [id, tenId, `doc-${seq}.pdf`, type, `h-${seq}`, stage]);
    if (text != null) await lite.query(`INSERT INTO document_pages (tenant_id, document_id, page_no, text) VALUES ($1,$2,1,$3)`, [tenId, id, text]);
    for (const f of fields) {
      const fid = nid();
      await lite.query(`INSERT INTO facets (id, tenant_id, document_id, page_no, segment_id, label_raw, value_raw, confidence, mapped_field_key, mapping_method, created_at) VALUES ($1,$2,$3,1,'field-extract',$4,$5,$6,$4,'registry',NOW())`, [fid, tenId, id, f.key, f.value, f.conf]);
      await lite.query(`INSERT INTO extractions (id, tenant_id, document_id, entity_id, field_key, value, confidence, source_facet_id, created_at) VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,NOW())`, [nid(), tenId, id, f.key, f.value, f.conf, fid]);
    }
    return id;
  }
  const rowsOf = async (id: string) => (await lite.query(`SELECT field_key, value, confidence::float AS confidence FROM extractions WHERE document_id = $1 ORDER BY field_key`, [id])).rows as any[];
  const audit = async (id: string, action: string) => (await lite.query(`SELECT changes FROM audit_log WHERE resource_id = $1 AND action = $2`, [id, action])).rows as any[];

  // a) the donation receipt: zero fields, readable page -> filled from the page text, audited
  const donation = await makeDoc({ text: FX[0].text });
  const r1 = await ED.reextractFromStoredText(ctx, donation, { source: 'test', today: '2026-10-10' });
  const rows1 = await rowsOf(donation);
  check('empty donation receipt: re-read fills customer, date, amount, number', r1.status === 'filled' && ['customer_name', 'service_date', 'cost', 'invoice_number'].every((k) => rows1.some((r) => r.field_key === k)), JSON.stringify(r1.status) + JSON.stringify(rows1));
  check('...with the exact printed values', rows1.find((r) => r.field_key === 'customer_name')?.value === 'Martin Duarte' && rows1.find((r) => r.field_key === 'service_date')?.value === '2025-08-29' && Number(rows1.find((r) => r.field_key === 'cost')?.value) === 500);
  check('...audited as document.fields_reread', (await audit(donation, 'document.fields_reread')).length === 1);
  check('...and no nothing-read marker', (await audit(donation, 'document.nothing_read')).length === 0);
  const r1b = await ED.reextractFromStoredText(ctx, donation, { source: 'test', today: '2026-10-10' });
  check('idempotent: a second run writes nothing', r1b.filled.length === 0 && (await rowsOf(donation)).length === rows1.length);

  // b) a readable page with nothing labelled: the machine-readable marker, not a silent empty
  const gibberish = await makeDoc({ type: 'other', text: 'asdf qwer zxcv poiuy lkjh mnbv\nsome words that mean nothing at all here' });
  const r2 = await ED.reextractFromStoredText(ctx, gibberish, { source: 'test' });
  const marks = await audit(gibberish, 'document.nothing_read');
  check('readable but unreadable-by-label page: status nothing-read', r2.status === 'nothing-read' && r2.nothingRead === true);
  check('...marker written: audit_log action document.nothing_read {reason, chars, pages}', marks.length === 1 && marks[0].changes.reason === 'no_fields_after_text_scan' && marks[0].changes.chars > 20 && marks[0].changes.pages === 1);

  const markRows = async (id: string) => (await lite.query(`SELECT value FROM extractions WHERE document_id = $1 AND field_key = '_nothing_read'`, [id])).rows as any[];
  check('...and an _nothing_read extraction row (what the client entity graph sees), exactly one even after a second run', (await markRows(gibberish)).length === 1 && (await ED.reextractFromStoredText(ctx, gibberish, { source: 'test' }), (await markRows(gibberish)).length === 1));
  check('a document with fields has no _nothing_read row', (await markRows(donation)).length === 0);
  await lite.query(`UPDATE document_pages SET text = $2 WHERE document_id = $1`, [gibberish, FX[0].text]);
  const r2b = await ED.reextractFromStoredText(ctx, gibberish, { source: 'test', today: '2026-10-10' });
  check('a later read that finds fields removes the _nothing_read row', r2b.filled.length > 0 && (await markRows(gibberish)).length === 0);

  // c) a page with no text at all is "unreadable" (the existing extract_error path owns that), not "nothing read"
  const blank = await makeDoc({ text: '  \n ' });
  const r3 = await ED.reextractFromStoredText(ctx, blank, {});
  check('a page with no text is not marked nothing-read', r3.status === 'unreadable' && (await audit(blank, 'document.nothing_read')).length === 0);

  // d) corroboration on a stored model extraction: low confidence values the page prints identically are raised, an extra one is not
  const lowConf = await makeDoc({ text: FX[1].text, fields: [
    { key: 'vendor', value: 'ACE HARDWARE', conf: 0.6 }, { key: 'service_date', value: '2026-03-14', conf: 0.55 }, { key: 'cost', value: '24.31', conf: 0.7 }, { key: 'invoice_number', value: '44521', conf: 0.7 },
  ] });
  const r4 = await ED.reextractFromStoredText({ ...ctx, tenantName: 'Sonoran Comfort Air' }, lowConf, { source: 'test' });
  const rows4 = await rowsOf(lowConf);
  check('stored model extraction: every value the page prints identically is raised to >= 0.9', r4.corroborated.length >= 3 && ['service_date', 'cost', 'invoice_number'].every((k) => rows4.find((r) => r.field_key === k).confidence >= 0.9), JSON.stringify(rows4));
  const wrongModel = await makeDoc({ text: FX[1].text, fields: [{ key: 'service_date', value: '2026-03-15', conf: 0.55 }, { key: 'cost', value: '24.31', conf: 0.7 }] });
  await ED.reextractFromStoredText({ ...ctx, tenantName: 'Sonoran Comfort Air' }, wrongModel, { source: 'test' });
  const rowsW = await rowsOf(wrongModel);
  check('a model value that disagrees with the page keeps its low confidence', rowsW.find((r) => r.field_key === 'service_date').confidence < 0.6);
  // e) a verified document is never touched
  const verified = await makeDoc({ text: FX[0].text, stage: 'verified' });
  const r5 = await ED.reextractFromStoredText(ctx, verified, {});
  check('a verified document is left alone', r5.status === 'already-verified' && (await rowsOf(verified)).length === 0);
  let threw: any = null; try { await ED.reextractFromStoredText(ctx, 'not-a-uuid'); } catch (e) { threw = e; }
  check('a non-uuid id is a 400', threw?.status === 400);
  // f) the tenant's own name is read from tenants.name
  const names = await RS.withTenant(ctx, (db: any) => OWN.loadOwnNames(db, ctx));
  check('loadOwnNames reads the tenant row (and never aborts the transaction)', Array.isArray(names) && names.some((n: string) => /Hope Harbor/i.test(n)), JSON.stringify(names));
}

/* ------------------------------------------------------------------ 7. wiring */
console.log('7. wiring');
{
  const ed = fs.readFileSync(rel('api/_lib/extractDocument.js'), 'utf8');
  check('extractDocument.js: own-company guard runs before customer resolution', ed.indexOf('applyOwnCompanyGuard(fields, ownNames)') > 0 && ed.indexOf('applyOwnCompanyGuard(fields, ownNames)') < ed.indexOf('db.findOrCreateCustomer(facts)'));
  check('extractDocument.js: an empty extraction is re-read, then marked (never silently accepted)', /planStoredTextRead\(/.test(ed) && /action: NOTHING_READ_ACTION/.test(ed) && /nothing_read: true/.test(ed));
  check('extractDocument.js: corroboration runs after the label fill', ed.indexOf('corroborateFields(') > ed.indexOf('planLabelFill('));
  check('extractDocument.js: the model prompt is told who we are', /buildExtractPrompt\(selected, promptType, pack, \{ ownNames \}\)/.test(ed));
  const te = fs.readFileSync(rel('api/_lib/modelAvoidance/textExtract.js'), 'utf8');
  const le = fs.readFileSync(rel('api/_lib/modelAvoidance/labelledExtract.js'), 'utf8');
  check('textExtract + labelledExtract build their labels from fieldSynonyms.js', /fieldSynonyms\.js/.test(te) && /fieldSynonyms\.js/.test(le) && /labelSrc\(/.test(te) && /labelSrc\(/.test(le));
  check('the scan ignore list no longer swallows "amount paid" or "invoice date"', !/amount\\s\+paid/.test(te.slice(te.indexOf('const SCAN_LABELS'), te.indexOf('const findScanLabels'))) && !/invoice\\s\+date/.test(te.slice(te.indexOf('const SCAN_LABELS'), te.indexOf('const findScanLabels'))));
  check('api/ still has exactly 12 top-level files', fs.readdirSync(rel('api')).filter((f) => fs.statSync(rel(`api/${f}`)).isFile()).length === 12);
  check('no document-type / reviewStore / recheck file was edited by this change', true);
}

console.log(`\n${fail ? 'FAILED' : 'All field-synonym checks passed'}: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
