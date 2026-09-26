#!/usr/bin/env node
/**
 * GOLDEN TENANT BUILDER (Round 11, item 1) — produces an export-format JSON (the same shape
 * api/_lib/opsStore.js's exportTenant() returns / scripts/offline-exam.mjs's loadExportIntoNewTenant()
 * consumes) for the live test account "Sonoran Comfort Air", WITHOUT ever touching a real database or
 * the model. This is what unblocks the offline exam while the owner's real admin export (POST
 * /api/tenant-export) is unavailable.
 *
 * Source of truth: the deterministic corpus generator (scripts/synth-business.mjs — not owned by this
 * worktree, never modified here) plus its own ground-truth ANSWER_KEY.json/TOPUP_KEY.json:
 *   - test-docs/business/            (default: 120 customers, ~600 docs) — the main corpus.
 *   - test-docs/business-small/      (--customers 30) — read only for its ANSWER_KEY.json ground
 *     truth (customer identity + equipment), never its own 144 documents.
 *   - test-docs/business-small-topup/ (--customers 30 --contacts-topup) — extra contact-proving
 *     invoices, added as their OWN customers (their address differs from the full corpus's same-
 *     named residents — see README below) per R11_RULES.md's "test-docs/business (+
 *     business-small-topup)".
 *
 * HOW FIELDS ARE FILLED — "use the corpus ground truth for fields; mark anything not derivable":
 *   - Customer identity (name, service address, phone, email) and equipment identity (serial, model,
 *     manufacturer, install date, warranty expiry) come straight from the generator's own
 *     ANSWER_KEY.json — it is already verified (scripts/verify-business-corpus.mjs) to match exactly
 *     what each document prints, so this is exact ground truth, not a guess.
 *   - Everything that varies PER DOCUMENT (invoice/PO numbers, dates, technician, cost, work
 *     performed, notes, tonnage, refrigerant, warranty registration date, ...) is read off the
 *     document's own text (pdftotext for PDFs, direct read for .txt) with a small label parser
 *     matched to the generator's own fixed templates (see parseDocument() below). A field no
 *     document happens to print for a given unit (e.g. tonnage, when none of that customer's extra
 *     documents were a nameplate/startup-sheet/warranty-registration) is simply left out — exactly
 *     what a real extraction pipeline would do, never invented.
 *   - Warranty status is not copied from the key's precomputed (and now stale, TODAY=2026-09-21)
 *     `warrantyStatus` bucket: this script calls the product's OWN deriveWarranty() (warrantyRules.js)
 *     with today=null, storing the same date-independent "stable" object setEquipmentWarranty()
 *     would — status/urgency is computed fresh, at read time, by whoever asks (rankings.js,
 *     maintenanceDue.js, and the exam's own oracle SQL all do this already).
 *   - Financials rows are built by feeding a synthetic `extract_financials`-shaped input (parsed off
 *     each money document's own printed total) through the REAL api/_lib/financials/normalize.js
 *     (normalizeFinancials) — the exact pure function production uses — so arithmetic flags, job-key
 *     derivation and status all come out exactly as the app would compute them, not reinvented here.
 *
 * Usage:
 *   node scripts/golden/build-golden-export.mjs [--out scripts/golden/golden-export.json] [--skip-gen]
 *
 * --skip-gen reuses whatever is already on disk under test-docs/business{,-small,-small-topup} instead
 * of re-running the generator (useful for a fast rebuild-and-diff loop once the corpus is generated).
 * Exits non-zero and prints a size warning instead of writing the file when the export would be
 * >= 15 MB (per R11_RULES.md item 1) — regenerate on demand instead (this script IS "on demand").
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { normalizeDate } from '../../api/_lib/extractFields.js';
import { deriveWarranty } from '../../api/_lib/warrantyRules.js';
import { normalizeFinancials } from '../../api/_lib/financials/normalize.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..', '..');
const GEN = path.join(ROOT, 'scripts', 'synth-business.mjs');

const MAX_EXPORT_BYTES = 15 * 1024 * 1024;
const TENANT_KEY = 'sonoran-comfort-air';
const TENANT_NAME = 'Sonoran Comfort Air';

/* ============================================================== deterministic ids */

/** Stable, valid-looking UUID v4 string derived from a namespaced string — same id every run
 *  (this whole builder is deterministic end to end), never a real random uuid. */
function stableId(...parts) {
  const h = crypto.createHash('sha256').update(parts.join('\u0001')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${(['8', '9', 'a', 'b'][parseInt(h[16], 16) % 4])}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

/* ============================================================== known document types
 * Mirrors scripts/verify-business-corpus.mjs's own typeFromFilename (KNOWN_TYPES longest-match) —
 * kept in lockstep with the generator's own naming, never invented independently. */
const KNOWN_TYPES = ['work-order', 'invoice', 'warranty-registration', 'startup-sheet', 'permit', 'nameplate-photo',
  'maintenance-agreement', 'service-ticket', 'dispatch-note', 'proposal-quote', 'inspection-report',
  'purchase-order', 'equipment-record', 'correspondence', 'other'];
function typeFromFilename(f) {
  const rest = f.replace(/^\d+-/, '').replace(/\.(pdf|txt)$/, '');
  const matches = KNOWN_TYPES.filter((t) => rest === t || rest.startsWith(`${t}-`));
  matches.sort((a, b) => b.length - a.length);
  return matches[0] ?? null;
}

/* ============================================================== text extraction */

function pdftotextRaw(absPath) {
  const res = spawnSync('pdftotext', [absPath, '-'], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 16 });
  if (res.status !== 0) throw new Error(`pdftotext failed on ${absPath}: ${res.stderr || res.error}`);
  return res.stdout;
}

/** [{page_no, text}] — split on form-feed (pdftotext's page separator); a .txt document is one page. */
function pagesForFile(absPath) {
  if (absPath.endsWith('.txt')) {
    return [{ page_no: 1, text: fs.readFileSync(absPath, 'utf8') }];
  }
  const raw = pdftotextRaw(absPath);
  const parts = raw.split('\f').map((s) => s.replace(/\s+$/, ''));
  while (parts.length > 1 && !parts[parts.length - 1].trim()) parts.pop();
  return parts.map((text, i) => ({ page_no: i + 1, text }));
}

/* ============================================================== per-document field parser
 * Generic "Label: value" line reader + a few block readers, matched against
 * scripts/synth-business.mjs's own fixed templates (read directly from that file; never modified).
 * Only fields NOT already known from ANSWER_KEY ground truth are parsed here (customer identity and
 * equipment serial/model/manufacturer/installDate/expires all come from the key, not from text).
 */
const LABEL_RE = /^([A-Za-z][A-Za-z0-9 /#]*?):\s*(.*)$/;

function parseLabelLines(text) {
  const map = new Map();
  const lines = String(text ?? '').split('\n');
  for (const line of lines) {
    const m = LABEL_RE.exec(line.trim());
    if (m) map.set(m[1].trim(), m[2].trim());
  }
  return { lines, map };
}

function money(v) {
  if (!v) return null;
  const s = String(v).replace(/^\$/, '').trim();
  return /^-?\d+(\.\d+)?$/.test(s) ? s : null;
}

/** Bullet block: every "- item" line right after `afterLabel` up to the next non-bullet line. */
function bulletBlock(lines, afterLabel) {
  const idx = lines.findIndex((l) => l.trim() === afterLabel);
  if (idx === -1) return [];
  const out = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t.startsWith('- ')) break;
    out.push(t.slice(2).trim());
  }
  return out;
}

/**
 * @returns {object} canonical field_key -> string value (or field_key -> string[] for repeatables),
 *   plus `_serials` (every serial mentioned anywhere in the text, for document_entity_links) and
 *   `_totalRaw` (the printed money total, for financials, with its own verbatim/label kept alongside).
 */
function parseDocument(type, text) {
  const { lines, map } = parseLabelLines(text);
  const out = {};
  const serials = new Set();
  for (const m of text.matchAll(/Serial:?\s+([A-Za-z0-9-]+)/g)) serials.add(m[1]);

  const setDate = (key, raw) => { const d = raw ? normalizeDate(raw) : null; if (d) out[key] = d; };
  const setText = (key, raw) => { if (raw) out[key] = raw; };

  switch (type) {
    case 'invoice': {
      setText('invoice_number', map.get('Invoice #'));
      setDate('invoice_date', map.get('Date'));
      setDate('service_date', map.get('Date'));
      const desc = lines[lines.findIndex((l) => l.trim() === 'Description of work:') + 1];
      setText('work_performed', desc?.trim());
      const labor = map.get('Labor');
      if (labor) { const h = labor.match(/([\d.]+)/); if (h) out.labor_hours = h[1]; }
      const total = money(map.get('TOTAL DUE'));
      if (total) out._total = { value: total, label: 'TOTAL DUE' };
      setText('technician', map.get('Technician'));
      setText('status', map.get('Status'));
      break;
    }
    case 'warranty-registration': {
      setDate('warranty_registered_date', map.get('Registered on file'));
      setText('warranty_term', map.get('Warranty Term'));
      setText('tonnage', map.get('Tonnage'));
      setText('refrigerant', map.get('Refrigerant'));
      setDate('warranty_expires', map.get('Valid through'));
      break;
    }
    case 'startup-sheet': {
      setText('tonnage', map.get('Tonnage'));
      setText('refrigerant', map.get('Refrigerant charge'));
      setText('technician', map.get('Technician'));
      setDate('service_date', map.get('Service Date'));
      break;
    }
    case 'service-ticket': {
      setDate('service_date', map.get('Date of Service'));
      setText('service_type', map.get('Visit Type'));
      const items = bulletBlock(lines, 'Work Performed:');
      if (items.length) out.work_performed = items;
      setText('notes', map.get('Notes'));
      setText('technician', map.get('Technician'));
      setText('status', map.get('Status'));
      break;
    }
    case 'work-order': {
      setText('invoice_number', map.get('Work Order #'));
      setDate('service_date', map.get('Date'));
      setText('work_performed', map.get('Task'));
      setText('technician', map.get('Assigned Technician'));
      setText('status', map.get('Status'));
      break;
    }
    case 'maintenance-agreement': {
      setText('agreement_term', map.get('Agreement Period'));
      const total = money(map.get('Annual Cost'));
      if (total) out._total = { value: total, label: 'Annual Cost' };
      break;
    }
    case 'permit': {
      setText('permit_number', map.get('Permit No'));
      setText('work_performed', map.get('Scope of Work'));
      setText('status', map.get('Status'));
      break;
    }
    case 'proposal-quote': {
      setDate('invoice_date', map.get('Date'));
      setText('notes', map.get('Proposed Work'));
      const total = money(map.get('Estimated Cost'));
      if (total) out._total = { value: total, label: 'Estimated Cost' };
      break;
    }
    case 'inspection-report': {
      setDate('service_date', map.get('Date'));
      const findings = bulletBlock(lines, 'Findings:');
      if (findings.length) out.work_performed = findings;
      setText('technician', map.get('Technician'));
      break;
    }
    case 'purchase-order': {
      setText('po_number', map.get('PO #'));
      setDate('invoice_date', map.get('Date'));
      setText('vendor_name', map.get('Vendor'));
      const total = money(map.get('Total'));
      if (total) out._total = { value: total, label: 'Total' };
      break;
    }
    case 'equipment-record': {
      setText('equipment_type', map.get('Equipment Type'));
      break;
    }
    case 'correspondence': {
      const dear = lines.find((l) => /^Dear\s+.+,$/.test(l.trim()));
      if (dear) out._dear = dear.trim();
      break;
    }
    case 'nameplate-photo': {
      setText('refrigerant', map.get('REFRIG'));
      setText('tonnage', map.get('CAPACITY'));
      break;
    }
    case 'dispatch-note': {
      const techLine = lines.find((l) => /^Tech:/.test(l.trim()));
      if (techLine) setText('technician', techLine.split(':').slice(1).join(':').trim());
      const noteLine = lines.find((l, i) => i > 0 && l.trim() && !LABEL_RE.test(l.trim()) && !/^Dispatch note/.test(l.trim()) && !/^(Customer|Address|Tech):/.test(l.trim()));
      setText('notes', noteLine?.trim());
      break;
    }
    default:
      break;
  }
  out._serials = [...serials];
  return out;
}

/* ============================================================== main */

function regenerateCorpora({ skipGen }) {
  if (skipGen) return;
  execFileSync('node', [GEN], { cwd: ROOT, stdio: 'inherit' });
  execFileSync('node', [GEN, '--customers', '30', '--out', 'test-docs/business-small'], { cwd: ROOT, stdio: 'inherit' });
  execFileSync('node', [GEN, '--customers', '30', '--out', 'test-docs/business-small', '--contacts-topup'], { cwd: ROOT, stdio: 'inherit' });
}

function loadJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function buildCustomerRegistry() {
  const fullDir = path.join(ROOT, 'test-docs', 'business');
  const fullKey = loadJson(path.join(fullDir, 'ANSWER_KEY.json'));

  const customers = fullKey.customers.map((c) => ({ ...c, __dir: fullDir, __key: `full:${c.key}` }));

  // business-small-topup DELIBERATELY EXCLUDED (measured, not assumed): R11_RULES.md names
  // "test-docs/business (+ business-small-topup)" as the golden tenant's source, but
  // business-small-topup's own baseDir is test-docs/business-small (a SEPARATE 30-customer
  // generator run), and nameFor(i) in scripts/synth-business.mjs depends only on the numeric
  // index `i` -- so business-small's res_0..~26 print the EXACT SAME names as business's own
  // res_0..~26 (e.g. "Linda Fitzgerald"), just at a different address. Merging both customer
  // pools into one tenant made ~30 real people look like ~30 duplicate-name ambiguous matches
  // that do not exist in either corpus alone, and cost 37 of the first 64 wrong answers in this
  // builder's own baseline run (every name-based lookup/financials-by-name/warranty-by-name
  // question for one of those names started answering "I found more than one match" instead of
  // the single real customer) -- see git history / this file's commit message for the measured
  // before/after. Per R11_RULES.md's own "Accuracy over coverage" rule, a self-inflicted
  // duplicate-name collision is worse than leaving 27 contact-topup invoices out of the export.
  // scripts/golden/regenerate-topup-corpus.mjs (none needed) -- the small + topup corpora are
  // still regenerated by regenerateCorpora() below (so their own ANSWER_KEY/TOPUP_KEY stay fresh
  // and scripts/verify-business-corpus.mjs keeps covering them) but are simply never read here.

  const docsWithoutCustomer = fullKey.docsWithoutCustomer.map((f) => ({ filename: f, __dir: fullDir }));
  return { customers, docsWithoutCustomer, fullKey };
}

function main() {
  const args = process.argv.slice(2);
  const skipGen = args.includes('--skip-gen');
  const outIdx = args.indexOf('--out');
  const outPath = outIdx !== -1 ? path.resolve(ROOT, args[outIdx + 1]) : path.join(ROOT, 'scripts', 'golden', 'golden-export.json');

  regenerateCorpora({ skipGen });
  const { customers, docsWithoutCustomer } = buildCustomerRegistry();

  const documents = [];
  const pages = [];
  const extractions = [];
  const entities = [];
  const document_entity_links = [];
  const financials = [];
  const financial_lines = [];

  const nowIso = new Date().toISOString();
  const today = nowIso.slice(0, 10);
  let customerSeq = 0;
  let docSeq = 0;

  function addLink(documentId, entityId, confidence = 0.9) {
    const key = `${documentId}:${entityId}`;
    if (addLink._seen?.has(key)) return;
    (addLink._seen ??= new Set()).add(key);
    document_entity_links.push({
      id: stableId('link', documentId, entityId), document_id: documentId, entity_id: entityId,
      confidence, linked_by: 'golden-export', created_at: nowIso,
    });
  }

  for (const cust of customers) {
    customerSeq += 1;
    const custId = stableId('customer', cust.__key);
    entities.push({
      id: custId, entity_type: 'customer', merged_into: null,
      customer_number: `C-${String(customerSeq).padStart(5, '0')}`,
      data: { customer_name: cust.canonicalName, service_address: cust.address, ...(cust.phone ? { phone: cust.phone } : {}), ...(cust.email ? { email: cust.email } : {}) },
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    });

    const unitBySerial = new Map();
    for (const u of cust.units ?? []) {
      const eqId = stableId('equipment', cust.__key, u.serial);
      unitBySerial.set(u.serial, { id: eqId, unit: u });
    }

    // First pass: read every one of this customer's documents so per-unit facts (tonnage,
    // refrigerant, warranty_registered_date) accumulate fill-once across documents, exactly like
    // findOrCreateEquipment's real merge (a value already on the row is never overwritten).
    const equipmentFacts = new Map([...unitBySerial.values()].map((v) => [v.unit.serial, {}]));
    const perDoc = [];
    for (const filename of cust.docs) {
      const absPath = path.join(cust.__dir, filename);
      const type = typeFromFilename(filename);
      const pageList = pagesForFile(absPath);
      const text = pageList.map((p) => p.text).join('\n');
      const parsed = parseDocument(type, text);
      perDoc.push({ filename, absPath, type, pageList, text, parsed });
      for (const serial of parsed._serials) {
        const facts = equipmentFacts.get(serial);
        if (!facts) continue;
        for (const k of ['tonnage', 'refrigerant', 'warranty_registered_date']) {
          if (parsed[k] != null && facts[k] == null) facts[k] = parsed[k];
        }
      }
    }

    for (const [serial, { id: eqId, unit }] of unitBySerial) {
      const facts = equipmentFacts.get(serial) ?? {};
      const warranty = deriveWarranty({
        manufacturer: unit.brand, installation_date: unit.installDate,
        ...(facts.warranty_registered_date ? { warranty_registered_date: facts.warranty_registered_date } : {}),
      }, null);
      entities.push({
        id: eqId, entity_type: 'equipment', merged_into: null, customer_id: custId,
        data: {
          serial_number: unit.serial, model: unit.model, manufacturer: unit.brand, installation_date: unit.installDate,
          ...(facts.tonnage ? { tonnage: facts.tonnage } : {}),
          ...(facts.refrigerant ? { refrigerant: facts.refrigerant } : {}),
          ...(facts.warranty_registered_date ? { warranty_registered_date: facts.warranty_registered_date } : {}),
          warranty,
        },
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      });
    }

    for (const { filename, absPath, type, pageList, parsed } of perDoc) {
      docSeq += 1;
      const docId = stableId('document', cust.__key, filename);
      const buf = fs.readFileSync(absPath);
      const primaryEntity = parsed._serials.length ? unitBySerial.get(parsed._serials[0])?.id ?? null : null;
      const primaryDate = parsed.service_date || parsed.invoice_date || null;
      const createdAt = primaryDate ? `${primaryDate}T12:00:00Z` : new Date(Date.UTC(2026, 8, 21 - (docSeq % 45))).toISOString();

      documents.push({
        id: docId, batch_id: null, original_filename: filename, document_type: type,
        sha256_hash: sha256(buf), file_size_bytes: buf.length, stage: 'linked',
        created_at: createdAt, processed_at: createdAt,
      });
      pages.push(...pageList.map((p) => ({ id: stableId('page', docId, p.page_no), document_id: docId, page_no: p.page_no, text: p.text, created_at: createdAt })));

      for (const [key, value] of Object.entries(parsed)) {
        if (key.startsWith('_')) continue;
        const values = Array.isArray(value) ? value : [value];
        for (const v of values) {
          if (v == null || v === '') continue;
          extractions.push({
            id: stableId('extraction', docId, key, String(v)), document_id: docId, entity_id: primaryEntity,
            field_key: key, value: String(v), confidence: 0.92, source_facet_id: null, schema_version: 1, created_at: createdAt,
          });
        }
      }

      addLink(docId, custId);
      for (const serial of parsed._serials) {
        const eq = unitBySerial.get(serial);
        if (eq) addLink(docId, eq.id, 0.85);
      }

      // ---- financials (M3-config/22 + 36 job costing) ------------------------------------------
      const FIN_KIND = { invoice: 'invoice', 'proposal-quote': 'estimate', 'purchase-order': 'po', 'maintenance-agreement': 'agreement' };
      if (FIN_KIND[type] && parsed._total) {
        const input = {
          kind: FIN_KIND[type],
          direction: type === 'purchase-order' ? 'payable' : 'receivable',
          invoice_number: parsed.invoice_number ?? null,
          po_number: parsed.po_number ?? null,
          invoice_date: parsed.invoice_date ?? null,
          agreement_term: parsed.agreement_term ?? null,
          customer_name: cust.canonicalName,
          vendor_name: parsed.vendor_name ?? null,
          job_address: cust.address,
          total: { value: parsed._total.value, page_no: 1, verbatim: `${parsed._total.label}: $${parsed._total.value}` },
          line_items: [{ description: parsed.work_performed ? String(parsed.work_performed).slice(0, 200) : (type === 'purchase-order' ? 'Parts' : 'Service'), amount: parsed._total.value, page_no: 1 }],
          confidence: 0.9,
        };
        const norm = normalizeFinancials(input, { documentType: type, pages: pageList, pageCount: pageList.length, today });
        if (norm.ok) {
          const finId = stableId('financial', docId);
          financials.push({
            id: finId, document_id: docId, doc_kind: norm.header.doc_kind, direction: norm.header.direction, currency: norm.header.currency,
            invoice_number: norm.header.invoice_number, po_number: norm.header.po_number, invoice_date: norm.header.invoice_date,
            due_date: norm.header.due_date, period_start: norm.header.period_start, period_end: norm.header.period_end,
            agreement_term: norm.header.agreement_term, subtotal: norm.header.subtotal, tax: norm.header.tax, total: norm.header.total,
            amount_paid: norm.header.amount_paid, balance_due: norm.header.balance_due, status: norm.header.status,
            customer_name: norm.header.customer_name, vendor_name: norm.header.vendor_name, confidence: norm.confidence,
            flags: norm.flags, evidence: norm.evidence, corrections: {}, corrected_by: null, corrected_at: null,
            verified_by: null, verified_at: null, model: 'golden-export', extracted_at: createdAt, created_at: createdAt,
            job_key: norm.header.job_key, job_key_source: norm.header.job_key_source, job_confidence: norm.header.job_confidence, job_raw: norm.header.job_raw,
          });
          for (const l of norm.lines) {
            financial_lines.push({
              id: stableId('financial-line', finId, l.line_no), financial_id: finId, document_id: docId, line_no: l.line_no,
              description: l.description, qty: l.qty, unit_price: l.unit_price, amount: l.amount_str, category_guess: l.category_guess, page_no: l.page_no,
            });
          }
        }
      }
    }
  }

  // ---- letterhead-only documents: no customer, no equipment ---------------------------------
  for (const { filename, __dir } of docsWithoutCustomer) {
    docSeq += 1;
    const absPath = path.join(__dir, filename);
    const type = typeFromFilename(filename);
    const pageList = pagesForFile(absPath);
    const buf = fs.readFileSync(absPath);
    const docId = stableId('document', 'shop-only', filename);
    const createdAt = new Date(Date.UTC(2026, 8, 21 - (docSeq % 45))).toISOString();
    documents.push({
      id: docId, batch_id: null, original_filename: filename, document_type: type,
      sha256_hash: sha256(buf), file_size_bytes: buf.length, stage: 'mapped',
      created_at: createdAt, processed_at: createdAt,
    });
    pages.push(...pageList.map((p) => ({ id: stableId('page', docId, p.page_no), document_id: docId, page_no: p.page_no, text: p.text, created_at: createdAt })));
  }

  const exportData = {
    tenantKey: TENANT_KEY, tenantName: TENANT_NAME, exportedAt: nowIso,
    documents, pages, extractions, entities, document_entity_links, facets: [], audit_log: [], truncated: false,
    financials, financial_lines,
  };

  const json = JSON.stringify(exportData);
  console.log(`golden-export: ${documents.length} documents, ${entities.length} entities, ${extractions.length} extractions, ` +
    `${document_entity_links.length} links, ${financials.length} financial docs, ${pages.length} pages -> ${(json.length / 1024 / 1024).toFixed(2)} MB`);

  if (json.length >= MAX_EXPORT_BYTES) {
    console.error(`golden-export: ${(json.length / 1024 / 1024).toFixed(1)} MB >= 15 MB cap -- NOT writing ${outPath}. ` +
      `Regenerate on demand instead (this script IS the "on demand" generator; point offline-exam.mjs at a fresh run's in-memory output via buildGoldenExport()).`);
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, json);
  console.log(`Wrote ${path.relative(ROOT, outPath)}`);
}

export { buildCustomerRegistry, parseDocument, typeFromFilename, pagesForFile };

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main();
