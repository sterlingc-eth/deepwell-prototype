/**
 * Property management pack (Team G, 2026-09-24). See
 * handoffs/INDUSTRY_EXPANSION_2026-09-21.md ("3. Property management") for
 * the ICP/document-set/warranty research this is built from — the largest
 * schema delta of the three, and the only one with no DDL room to add real
 * new entity types (`entities.entity_type` is a fixed CHECK constraint:
 * property/equipment/customer/technician — see M3-config/01-create-schema.sql,
 * and this project takes no DDL). So the new concepts the brief calls for map
 * onto the existing four:
 *   - `property` entity  -> the building/portfolio property itself (unchanged)
 *   - `customer` entity  -> the OWNER (the property's owner, DeepWell's actual
 *                           customer) — matches the brief's own "customer is
 *                           repurposed as Owner" note
 *   - `technician` entity -> the VENDOR (an external party doing the work,
 *                           not a W2 tech) — matches the brief's own
 *                           "vendor replaces technician" note
 *   - `equipment` entity  -> the APPLIANCE, scoped to a unit via fields
 *                           (unit_number) rather than a new `unit` table
 * `unit`/`tenant`/`lease` become FIELDS on documents (unit_number, tenant_name,
 * lease_end_date, ...) rather than new entity types — genuinely poorer than a
 * real schema change, but exactly what "no DDL" allows, and it is what lets
 * the SAME generic oracle SQL templates every pack uses still work here.
 */

const documentTypes = [
  { id: 'work-order', label: 'Work order', definition: 'A unit turn, make-ready or maintenance job: address/unit, date, vendor, and what to do.', requires: ['service_address', 'service_date'], visitType: true, financial: false },
  { id: 'invoice', label: 'Invoice', definition: 'A bill for work or materials: an owner or vendor, a charge, a total cost.', requires: ['service_address', 'cost'], visitType: true, financial: true },
  { id: 'warranty-registration', label: 'Warranty registration', definition: 'Registers a per-unit appliance with the manufacturer for warranty coverage.', requires: ['serial_number', 'model', 'warranty_expires|warranty_term'], visitType: false, financial: false },
  { id: 'permit', label: 'Permit', definition: 'A government/HOA permit or code-compliance filing, carrying a permit number.', requires: ['service_address', 'permit_number'], visitType: false, financial: false },
  { id: 'maintenance-agreement', label: 'Maintenance agreement', definition: 'A recurring vendor service contract covering a property or portfolio.', requires: ['service_address', 'customer_name', 'warranty_term|agreement_term'], visitType: false, financial: true },
  { id: 'service-ticket', label: 'Service ticket', definition: 'A completed maintenance visit: what was found and what was done.', requires: ['service_address', 'service_date', 'work_performed'], visitType: true, financial: false },
  { id: 'proposal-quote', label: 'Proposal / quote', definition: 'A proposed price for work not yet performed.', requires: ['customer_name|service_address', 'cost'], visitType: false, financial: true },
  { id: 'inspection-report', label: 'Inspection report', definition: 'Findings from a code, HOA, or portfolio-compliance inspection.', requires: ['service_address', 'service_date'], visitType: true, financial: false },
  { id: 'purchase-order', label: 'Purchase order', definition: 'An order placed with a vendor for parts or materials.', requires: ['vendor|customer_name', 'cost'], visitType: false, financial: true },
  { id: 'equipment-record', label: 'Appliance record', definition: 'Identifies a per-unit appliance with no service or billing context.', requires: ['serial_number|model'], visitType: false, financial: false },
  { id: 'correspondence', label: 'Correspondence', definition: 'Tenant/owner communication about a unit or property, not a paperwork form.', requires: ['customer_name'], visitType: false, financial: false },
  { id: 'internal', label: 'Shop record', definition: 'Internal-only record naming no owner, tenant, or vendor.', requires: [], visitType: false, financial: false },
  { id: 'other', label: 'Other', definition: 'Does not clearly fit any type above.', requires: [], visitType: true, financial: false },
  // Property-management-specific, per the expansion brief's "▲" additions:
  { id: 'lease-agreement', label: 'Lease agreement', definition: 'A signed lease between the owner and a tenant for one unit, with a start/end date and rent.', requires: ['service_address', 'tenant_name', 'lease_end_date'], visitType: false, financial: true },
  { id: 'move-in-inspection', label: 'Move-in inspection', definition: 'Condition report filed when a tenant takes possession of a unit.', requires: ['service_address', 'service_date'], visitType: true, financial: false },
  { id: 'move-out-inspection', label: 'Move-out inspection', definition: 'Condition report filed when a tenant vacates a unit, used to settle the security deposit.', requires: ['service_address', 'service_date'], visitType: true, financial: false },
  { id: 'certificate-of-insurance', label: 'Certificate of insurance', definition: 'A vendor\'s proof-of-insurance filing, with a policy expiration date.', requires: ['vendor', 'coi_expires'], visitType: false, financial: false },
];

const fields = [
  { key: 'equipment_id', label: 'Appliance ID', perUnit: true, description: 'Internal appliance ID the company uses (e.g. "4B-Fridge"). NOT the serial number.' },
  { key: 'serial_number', label: 'Serial number', perUnit: true, description: 'Manufacturer serial number, exactly as printed.' },
  { key: 'model', label: 'Model', perUnit: true, description: 'Model name or number, exactly as printed.' },
  { key: 'manufacturer', label: 'Manufacturer', perUnit: true, description: 'Appliance manufacturer (Whirlpool, GE, Samsung, LG, Rheem, ...).' },
  { key: 'equipment_type', label: 'Appliance type', perUnit: true, description: 'What the appliance is: refrigerator, range, dishwasher, water heater, HVAC unit, washer, dryer, microwave.' },
  { key: 'unit_number', label: 'Unit number', perUnit: false, description: 'Which unit/apartment/suite at this property, as printed (e.g. "4B", "Suite 210").' },
  { key: 'service_address', label: 'Property address', perUnit: false, description: 'The property/building address — not the management company\'s own letterhead address.' },
  { key: 'shop_address', label: 'Company address', perUnit: false, description: 'The property management company\'s own business/letterhead address.' },
  { key: 'shop_phone', label: 'Company phone', perUnit: false, description: 'The property management company\'s own business/letterhead phone number.' },
  { key: 'shop_email', label: 'Company email', perUnit: false, description: 'The property management company\'s own business/letterhead email address.' },
  { key: 'customer_name', label: 'Owner', perUnit: false, description: 'The property owner\'s name or entity — DeepWell\'s actual customer, never the tenant or a vendor.' },
  { key: 'tenant_name', label: 'Tenant', perUnit: false, description: 'The occupant named on a lease or inspection — the end resident, not the owner.' },
  { key: 'vendor', label: 'Vendor', perUnit: false, description: 'The outside company or contractor that performed the work, e.g. on a purchase order or COI.' },
  { key: 'customer_phone', label: 'Owner phone', perUnit: false, description: 'Owner phone number, exactly as printed.' },
  { key: 'customer_email', label: 'Owner email', perUnit: false, description: 'Owner email address, exactly as printed.' },
  { key: 'installation_date', label: 'Installation date', perUnit: true, description: 'Date the appliance was installed.' },
  { key: 'warranty_expires', label: 'Warranty expires', perUnit: false, description: 'Date the appliance warranty expires.' },
  { key: 'warranty_term', label: 'Term', perUnit: false, description: 'The manufacturer warranty length for the appliance itself.' },
  { key: 'agreement_term', label: 'Agreement term', perUnit: false, description: 'The vendor service/maintenance agreement period.' },
  { key: 'warranty_registered_date', label: 'Warranty registered', perUnit: false, description: 'Date the warranty was registered with the manufacturer.' },
  { key: 'service_date', label: 'Service date', perUnit: false, description: 'Date service, inspection, or a move-in/move-out was performed.' },
  { key: 'service_type', label: 'Service type', perUnit: false, description: 'Make-Ready, Repair, Emergency, Turn, Inspection, Move-In, Move-Out.' },
  { key: 'technician', label: 'Vendor tech', perUnit: false, description: 'Name of the vendor\'s worker who performed the work.' },
  { key: 'work_performed', label: 'Work performed', perUnit: false, description: 'One work item performed. Return one field per item, not a joined list.' },
  { key: 'part_number', label: 'Part number', perUnit: false, description: 'A part number referenced on the document.' },
  { key: 'cost', label: 'Cost', perUnit: false, description: 'Total amount charged, in dollars.' },
  { key: 'labor_hours', label: 'Labor hours', perUnit: false, description: 'Labor hours billed.' },
  { key: 'invoice_number', label: 'Invoice number', perUnit: false, description: 'Invoice, ticket, or work-order number.' },
  { key: 'status', label: 'Status', perUnit: false, description: 'Completed, Pending, In Progress, Occupied, Vacant.' },
  { key: 'notes', label: 'Notes', perUnit: false, description: 'A short observation that does not fit another field.' },
  { key: 'permit_number', label: 'Permit number', perUnit: false, description: 'A government or HOA permit/filing number referenced on the document.' },
  { key: 'lease_start_date', label: 'Lease start', perUnit: false, description: 'The lease\'s start date, as printed.' },
  { key: 'lease_end_date', label: 'Lease end', perUnit: false, description: 'The lease\'s end date, as printed.' },
  { key: 'rent_amount', label: 'Rent amount', perUnit: false, description: 'Monthly rent amount, in dollars, as printed on the lease.' },
  { key: 'security_deposit', label: 'Security deposit', perUnit: false, description: 'Security deposit amount held, in dollars.' },
  { key: 'coi_expires', label: 'COI expiration', perUnit: false, description: 'The vendor\'s certificate-of-insurance expiration date.' },
];

const brands = ['Whirlpool', 'GE', 'Samsung', 'LG', 'Rheem', 'Frigidaire', 'Maytag', 'Kenmore'];

const synonyms = {
  unit: ['unit', 'units', 'apartment', 'apartments', 'suite', 'suites', 'door', 'doors'],
  lease: ['lease', 'leases', 'rental agreement', 'lease agreement'],
  tenant: ['tenant', 'tenants', 'renter', 'renters', 'resident', 'residents', 'occupant', 'occupants'],
  vendor: ['vendor', 'vendors', 'contractor', 'contractors'],
  coi: ['coi', 'certificate of insurance', 'cois', 'proof of insurance', 'insurance certificate'],
  'move-in': ['move-in', 'move in', 'move-ins', 'moved in'],
  'move-out': ['move-out', 'move out', 'move-outs', 'moved out'],
  'work order': ['work order', 'work orders', 'maintenance request', 'maintenance requests', 'maintenance ticket', 'maintenance tickets'],
  'make-ready': ['make-ready', 'make ready', 'turn', 'unit turn', 'turnover'],
  vacant: ['vacant', 'vacancy', 'vacancies', 'empty unit'],
  'security deposit': ['security deposit', 'security deposits', 'deposit', 'deposits'],
  hoa: ['hoa', 'homeowners association', "homeowner's association"],
};

const abbreviations = { hoa: 'homeowners association', coi: 'certificate of insurance', sqft: 'square feet', mtm: 'month to month' };
const typos = { tennant: 'tenant', vender: 'vendor', leese: 'lease', appartment: 'apartment' };

const personas = [
  {
    id: 'property-manager',
    label: 'Property manager',
    sampleQuestions: [
      'How many units do we manage in Mesa?',
      'Which vendors have an expired certificate of insurance?',
      'How many leases expire in the next 60 days?',
      'Is the water heater in unit 4B under warranty?',
      'How many maintenance requests did building X have this month?',
      'Which units haven\'t had a move-out inspection filed?',
      'How many make-ready work orders are open right now?',
      'List all appliances older than 10 years across our portfolio.',
      'Which vendors worked on property X in the last year?',
      'How many units are currently vacant?',
      'What is the lease end date for unit 12C?',
      'How many HVAC units are we responsible for across the portfolio?',
      'Which tenants have an open maintenance ticket?',
      'How many turn requests did we complete last month?',
      'List properties with an expiring HOA inspection.',
      'How many security deposits are we currently holding?',
      'Which unit had the most maintenance calls this year?',
      'How many appliance warranties expire this quarter?',
      'What vendor installed the water heater in unit 7A?',
      'How many COIs are expiring in the next 30 days?',
      'How many move-in inspections are on file?',
      'Which leases are month to month?',
      'How many work orders mention a leak?',
      'What is the average rent amount across the portfolio?',
      'How many units have an appliance warranty on file?',
      'Which vendor has done the most jobs this year?',
      'How many inspection reports are on file for HOA compliance?',
    ],
  },
  {
    id: 'owner',
    label: 'Property owner / investor',
    sampleQuestions: [
      'How much have we been invoiced across our properties this year?',
      'How many open maintenance work orders exist across our units?',
      'How many leases are on file for our portfolio?',
      'How many appliance warranties have already expired?',
      'How many vendors have worked on our properties in the last year?',
      'How many units are currently vacant across our portfolio?',
    ],
  },
];

const examTemplates = [
  { id: 'prop-count-invoices', category: 'financial', question: 'How many invoices do we have on file?', oracle: 'count_documents_by_type:invoice', compare: 'number', citationRequired: false },
  { id: 'prop-sum-invoice-total', category: 'financial', question: 'What is the total of every invoice on file?', oracle: 'sum_financials_total:invoice', compare: 'number', citationRequired: true },
  { id: 'prop-unpaid-invoices', category: 'financial', question: 'How many invoices are unpaid?', oracle: 'count_financials_by_status:unpaid', compare: 'number', citationRequired: false },
  { id: 'prop-count-owners-with-invoice', category: 'financial', question: 'How many owners have at least one invoice?', oracle: 'count_customers_with_doctype:invoice', compare: 'number', citationRequired: false },
  { id: 'prop-avg-cost', category: 'financial', question: 'What is the average cost across every invoice on file?', oracle: 'avg_numeric_field:cost', compare: 'number', citationRequired: false },
  { id: 'prop-count-leases', category: 'leasing', question: 'How many lease agreements are on file?', oracle: 'count_documents_by_type:lease-agreement', compare: 'number', citationRequired: false },
  { id: 'prop-leases-expiring-60', category: 'leasing', question: 'How many leases expire in the next 60 days?', oracle: 'count_field_date_within_days:lease_end_date:60', compare: 'number', citationRequired: true },
  { id: 'prop-leases-expired', category: 'leasing', question: 'How many leases have already expired?', oracle: 'count_field_date_before_today:lease_end_date', compare: 'number', citationRequired: true },
  { id: 'prop-count-tenant-field', category: 'leasing', question: 'How many documents record a tenant name?', oracle: 'count_documents_with_field:tenant_name', compare: 'number', citationRequired: false },
  { id: 'prop-avg-rent', category: 'leasing', question: 'What is the average rent amount across every lease on file?', oracle: 'avg_numeric_field:rent_amount', compare: 'number', citationRequired: false },
  { id: 'prop-leases-missing-end-date', category: 'leasing', question: 'How many lease agreements are missing a lease end date?', oracle: 'count_documents_missing_field:lease-agreement:lease_end_date', compare: 'honest-zero', citationRequired: false },
  { id: 'prop-distinct-security-deposit', category: 'leasing', question: 'How many distinct security deposit amounts are on file?', oracle: 'count_distinct_field_values:security_deposit', compare: 'number', citationRequired: false },
  { id: 'prop-count-move-in', category: 'inspections', question: 'How many move-in inspections are on file?', oracle: 'count_documents_by_type:move-in-inspection', compare: 'number', citationRequired: false },
  { id: 'prop-count-move-out', category: 'inspections', question: 'How many move-out inspections are on file?', oracle: 'count_documents_by_type:move-out-inspection', compare: 'number', citationRequired: false },
  { id: 'prop-count-inspection-reports', category: 'inspections', question: 'How many HOA/code inspection reports are on file?', oracle: 'count_documents_by_type:inspection-report', compare: 'number', citationRequired: false },
  { id: 'prop-move-out-missing-date', category: 'inspections', question: 'How many move-out inspections are missing a service date?', oracle: 'count_documents_missing_field:move-out-inspection:service_date', compare: 'honest-zero', citationRequired: false },
  { id: 'prop-count-coi', category: 'vendor-compliance', question: 'How many certificates of insurance are on file?', oracle: 'count_documents_by_type:certificate-of-insurance', compare: 'number', citationRequired: false },
  { id: 'prop-coi-expiring-30', category: 'vendor-compliance', question: 'How many certificates of insurance expire in the next 30 days?', oracle: 'count_field_date_within_days:coi_expires:30', compare: 'number', citationRequired: true },
  { id: 'prop-coi-expired', category: 'vendor-compliance', question: 'How many certificates of insurance have already expired?', oracle: 'count_field_date_before_today:coi_expires', compare: 'number', citationRequired: true },
  { id: 'prop-count-vendors', category: 'vendor-compliance', question: 'How many vendors are on file?', oracle: 'count_entities_by_type:technician', compare: 'number', citationRequired: false },
  { id: 'prop-count-vendor-field', category: 'vendor-compliance', question: 'How many documents record a vendor name?', oracle: 'count_documents_with_field:vendor', compare: 'number', citationRequired: false },
  { id: 'prop-count-purchase-orders', category: 'vendor-compliance', question: 'How many purchase orders are on file?', oracle: 'count_documents_by_type:purchase-order', compare: 'number', citationRequired: false },
  { id: 'prop-count-warranty-regs', category: 'warranty', question: 'How many appliance warranty registrations are on file?', oracle: 'count_documents_by_type:warranty-registration', compare: 'number', citationRequired: false },
  { id: 'prop-warranty-expiring-90', category: 'warranty', question: 'How many appliance warranties expire in the next 90 days?', oracle: 'count_field_date_within_days:warranty_expires:90', compare: 'number', citationRequired: true },
  { id: 'prop-warranty-expired', category: 'warranty', question: 'How many appliance warranties have already expired?', oracle: 'count_field_date_before_today:warranty_expires', compare: 'number', citationRequired: true },
  { id: 'prop-missing-warranty-serial', category: 'warranty', question: 'How many warranty registrations are missing a serial number?', oracle: 'count_documents_missing_field:warranty-registration:serial_number', compare: 'honest-zero', citationRequired: false },
  { id: 'prop-count-properties', category: 'entities', question: 'How many properties are on file?', oracle: 'count_entities_by_type:property', compare: 'number', citationRequired: false },
  { id: 'prop-count-owners', category: 'entities', question: 'How many owners are on file?', oracle: 'count_entities_by_type:customer', compare: 'number', citationRequired: false },
  { id: 'prop-count-appliances', category: 'entities', question: 'How many appliances are on file?', oracle: 'count_entities_by_type:equipment', compare: 'number', citationRequired: false },
  { id: 'prop-distinct-appliance-type', category: 'entities', question: 'How many distinct appliance types are on file?', oracle: 'count_distinct_field_values:equipment_type', compare: 'number', citationRequired: false },
  { id: 'prop-distinct-unit-numbers', category: 'entities', question: 'How many distinct unit numbers are on file?', oracle: 'count_distinct_field_values:unit_number', compare: 'number', citationRequired: false },
  { id: 'prop-mentions-leak', category: 'content', question: 'How many work orders mention a leak?', oracle: 'count_documents_mentioning:\\yleaks?\\y', compare: 'number', citationRequired: true },
  { id: 'prop-mentions-vacant', category: 'content', question: 'How many documents mention a vacant unit?', oracle: 'count_documents_mentioning:vacant', compare: 'number', citationRequired: true },
  { id: 'prop-mentions-make-ready', category: 'content', question: 'How many documents mention a make-ready or turn?', oracle: 'count_documents_mentioning:make.ready|turnover', compare: 'number', citationRequired: true },
  { id: 'prop-mentions-hoa', category: 'content', question: 'How many documents mention an HOA?', oracle: 'count_documents_mentioning:\\yhoa\\y', compare: 'number', citationRequired: true },
  { id: 'prop-mentions-security-deposit', category: 'content', question: 'How many documents mention a security deposit?', oracle: 'count_documents_mentioning:security\\s+deposit', compare: 'number', citationRequired: true },
  { id: 'prop-mentions-eviction', category: 'content', question: 'How many documents mention an eviction?', oracle: 'count_documents_mentioning:eviction', compare: 'number', citationRequired: true },
  { id: 'prop-count-work-orders', category: 'operations', question: 'How many maintenance work orders are on file?', oracle: 'count_documents_by_type:work-order', compare: 'number', citationRequired: false },
  { id: 'prop-count-service-tickets', category: 'operations', question: 'How many service tickets are on file?', oracle: 'count_documents_by_type:service-ticket', compare: 'number', citationRequired: false },
  { id: 'prop-count-documents-total', category: 'operations', question: 'How many documents do we have on file in total?', oracle: 'count_documents_total', compare: 'number', citationRequired: false },
  { id: 'prop-avg-labor-hours', category: 'operations', question: 'What is the average labor hours billed across every job?', oracle: 'avg_numeric_field:labor_hours', compare: 'number', citationRequired: false },
];

const propertyPack = {
  id: 'property',
  label: 'Property management',
  businessNoun: 'property management company',
  unitNoun: 'property/unit',
  documentTypes,
  fields,
  brands,
  synonyms,
  abbreviations,
  typos,
  maintenance: {
    defaultCadenceMonths: 12,
    cadencePhrases: [
      { re: '\\blease\\b[^?]*\\brenew', months: 12 },
      { re: '\\bhoa\\b[^?]*\\binspection\\b[^?]*\\bannual', months: 12 },
    ],
    seasons: { spring: [3, 5], summer: [6, 8], fall: [9, 11], winter: [12, 2] },
  },
  warranty: {
    brandRules: {
      whirlpool: { label: 'Whirlpool', rule: { registrationWindowDays: 90, unregisteredPartsYears: 1, registeredPartsYears: 1 }, confidence: 'medium', notes: 'Appliance warranties are typically 1yr parts/labor regardless of registration; registration mainly speeds a claim.' },
      ge: { label: 'GE', rule: { registrationWindowDays: 90, unregisteredPartsYears: 1, registeredPartsYears: 1 }, confidence: 'medium', notes: 'Same 1yr appliance-warranty pattern as most major residential brands.' },
    },
    coiFieldKey: 'coi_expires',
    coiCadenceMonths: 12,
  },
  personas,
  examTemplates,
};

export default propertyPack;
