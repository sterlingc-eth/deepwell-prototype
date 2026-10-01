// R32: one-off builder for scripts/r32/labels.json + fixtures/corpus/*.pdf. Truth is NOT read from the extractor: identity
// fields come from test-docs/business/ANSWER_KEY.json and the rest from the independent template parser behind
// scripts/golden/golden-export.json (build-golden-export.mjs). Known-bad golden values (service-ticket model glued to
// "Serial:") are replaced by the ANSWER_KEY unit. Usage: node scripts/r32/build-labels.mjs
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const g = JSON.parse(fs.readFileSync(path.join(root, 'scripts/golden/golden-export.json'), 'utf8'));
const key = JSON.parse(fs.readFileSync(path.join(root, 'test-docs/business/ANSWER_KEY.json'), 'utf8'));
const PICK = { invoice: 8, 'service-ticket': 7, 'work-order': 4, 'warranty-registration': 5, 'startup-sheet': 3, 'proposal-quote': 4, permit: 3,
  'maintenance-agreement': 3, 'inspection-report': 3, 'equipment-record': 3, 'dispatch-note': 2, 'purchase-order': 2, correspondence: 2 };
const GOLDEN_KEYS = ['service_date', 'technician', 'status', 'labor_hours', 'tonnage', 'refrigerant', 'warranty_registered_date', 'warranty_term', 'permit_number', 'invoice_number', 'agreement_term', 'equipment_type', 'service_type'];
const custOf = new Map(); for (const c of key.customers) for (const d of c.docs) custOf.set(d, c);
const byDoc = new Map(); for (const e of g.extractions) (byDoc.get(e.document_id) ?? byDoc.set(e.document_id, []).get(e.document_id)).push(e);
const dmy = (s) => s; // ANSWER_KEY installDate is ISO already, same as extractor output
const out = []; const count = {};
for (const d of [...g.documents].sort((a, b) => a.original_filename.localeCompare(b.original_filename))) {
  const type = d.document_type; if ((count[type] ?? 0) >= (PICK[type] ?? 0)) continue;
  const src = path.join(root, 'test-docs/business', d.original_filename); if (!fs.existsSync(src)) continue;
  count[type] = (count[type] ?? 0) + 1;
  fs.copyFileSync(src, path.join(root, 'scripts/r32/fixtures/corpus', d.original_filename));
  const ex = byDoc.get(d.id) ?? []; const gv = (k) => ex.find((e) => e.field_key === k)?.value;
  const truth = {}; const c = custOf.get(d.original_filename);
  if (c) { truth.customer_name = c.canonicalName; truth.service_address = c.address; const txt = g.pages.filter((p) => p.document_id === d.id).map((p) => p.text).join('\n');
    const ph = String(c.phone ?? '').replace(/^\s*(?:ph|cell|phone|tel|mobile)\.?:?\s*/i, ''); // ANSWER_KEY keeps the label prefix of variant formats
    if (ph && txt.includes(ph)) truth.customer_phone = ph; if (c.email && txt.includes(c.email)) truth.customer_email = c.email; }
  const unit = c?.units?.find((u) => u.serial === gv('serial_number'));
  if (unit) { truth.serial_number = unit.serial; truth.model = unit.model; truth.manufacturer = unit.brand; if (gv('installation_date')) truth.installation_date = unit.installDate; }
  for (const k of GOLDEN_KEYS) if (gv(k) != null) truth[k] = gv(k);
  out.push({ file: `corpus/${d.original_filename}`, type, truth });
}
const lp = path.join(root, 'scripts/r32/labels.json');
const tools = fs.existsSync(lp) ? JSON.parse(fs.readFileSync(lp, 'utf8')).tools : []; // hand-labelled tool fixtures are preserved
fs.writeFileSync(lp, JSON.stringify({ note: 'truth from ANSWER_KEY.json + golden template parser; tools[] hand-labelled from the source documents; see build-labels.mjs', docs: out, tools }, null, 1));
console.log(out.length, count);
