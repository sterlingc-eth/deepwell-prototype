/**
 * Company Files: shared folder logic. Decides which of seven company folders a paper belongs in (or none, meaning it is
 * customer paper and stays in the customer record), from its type plus the facts read off it. Pure: no database, no model.
 *
 * HAND-MIRRORED with api/_lib/companyFiles.js (that file is the server's copy). The two share one body, below the
 * "SHARED BODY" marker; scripts/verify-company-files.ts transpiles this file and checks the body is the same text, and
 * runs both against the same fixture matrix. Edit both together.
 */
import { COMPANY_RECORD_TYPES, COMPANY_RECORD_IF_NO_CUSTOMER_OR_ADDRESS_TYPES, LINK_OPTIONAL_TYPES } from '../domains/hvac/documentTypes';

// ---- SHARED BODY (keep identical to api/_lib/companyFiles.js) ----
export const COMPANY_FILES_BODY_VERSION = 1;

export type CompanyFolderId =
  | 'suppliers-vendors'
  | 'purchasing'
  | 'money-in-out'
  | 'people-hr'
  | 'insurance-legal'
  | 'company-admin'
  | 'schedules-operations';

export type FolderLayout = 'vendor' | 'kind' | 'month';

export interface CompanyFolderDef {
  id: CompanyFolderId;
  label: string;
  layout: FolderLayout;
}

/** The seven folders, in the order they are shown. Names are owner-approved wording. */
export const COMPANY_FOLDERS: CompanyFolderDef[] = [
  { id: 'suppliers-vendors', label: 'Suppliers and vendors', layout: 'vendor' },
  { id: 'purchasing', label: 'Purchasing', layout: 'vendor' },
  { id: 'money-in-out', label: 'Money in and out', layout: 'vendor' },
  { id: 'people-hr', label: 'People and HR', layout: 'kind' },
  { id: 'insurance-legal', label: 'Insurance and legal', layout: 'kind' },
  { id: 'company-admin', label: 'Company and admin', layout: 'kind' },
  { id: 'schedules-operations', label: 'Schedules and operations', layout: 'month' },
];
export const COMPANY_FOLDER_IDS: string[] = COMPANY_FOLDERS.map((f) => f.id);
export const HR_FOLDER_ID: CompanyFolderId = 'people-hr';
/** The stored override value that sends a paper back to the customer side. */
export const OVERRIDE_CUSTOMER = 'customer';
/** extractions.field_key that holds a person's folder choice for one document (like '_audience': synthetic, never a fact). */
export const COMPANY_FOLDER_FIELD_KEY = '_company_folder';

export function isFolderId(v: unknown): v is CompanyFolderId {
  return typeof v === 'string' && COMPANY_FOLDER_IDS.includes(v);
}
export function folderLabel(id: string | null | undefined): string {
  return COMPANY_FOLDERS.find((f) => f.id === id)?.label ?? '';
}

export type Facts = Record<string, string | null | undefined>;

export interface CompanyDoc {
  type: string | null | undefined;
  fields?: Facts | null;
  /** File name or display name: only used as a hint (lease, rent). */
  title?: string | null;
  /** A person or the matcher tied this paper to a customer, property or unit. */
  linkedCustomer?: boolean;
  /** A saved folder choice: a folder id, or 'customer'. */
  override?: string | null;
}

export interface FolderOpts {
  /** vendorKey -> folder id ("Always file {vendor} here"). */
  vendorRules?: Record<string, string> | null;
  /** The company's own names (tenant name), so a bill addressed to us is not read as a customer. */
  companyNames?: string[] | null;
}

export interface FolderInfo {
  folder: CompanyFolderId | null;
  /** False when the folder is a best guess (shown as "Not sure this is the right folder"). */
  confident: boolean;
  source: 'override' | 'vendor-rule' | 'type' | 'none';
}

const has = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '';
const val = (f: Facts | null | undefined, k: string): string => (has(f?.[k]) ? String(f?.[k]).trim() : '');

const TYPE_ALIAS: Record<string, string> = {
  'maintenance-plan': 'maintenance-agreement',
  warranty: 'warranty-registration',
  'service-report': 'service-ticket',
  proposal: 'proposal-quote',
  quote: 'proposal-quote',
  nameplate: 'nameplate-photo',
};
/** Canonical type id for a stored spelling ("service_report" -> "service-ticket"). Empty string when there is none. */
export function canonType(raw: unknown): string {
  const n = String(raw ?? '').trim().toLowerCase().replace(/_/g, '-');
  return TYPE_ALIAS[n] ?? n;
}

/** Types that are always customer paper: a job, a unit, a quote we sent. Never a company file on their own. */
export const ALWAYS_CUSTOMER_TYPES: Set<string> = new Set([
  'work-order', 'service-ticket', 'startup-sheet', 'nameplate-photo', 'equipment-record',
  'warranty-registration', 'inspection-report', 'maintenance-agreement',
]);
/** Types that are always the company's own paper: a vendor or bill-to name never pulls them to a customer. */
export const ALWAYS_COMPANY_TYPES: Set<string> = new Set([
  'receipt', 'purchase-order', 'schedule', 'price-list', 'hr-letter', 'insurance-certificate',
]);

const BANK_RE = /\b(bank|credit union|visa|mastercard|master card|amex|american express|discover|card services|fuel|fleet|wex|fleetcor|chase|wells fargo|capital one|citi|paypal|stripe|square|loan)\b/i;
const PRO_RE = /\b(law|legal|attorney|attorneys|cpa|accounting|accountant|accountants|bookkeep\w*|tax|consult\w*|advisor|advisors|payroll|insurance|brokerage)\b/i;
/** A file name that names a customer after a dash ("Invoice 24332 - Perkins") or says "Pay App": the shop's own outgoing paper. */
export const CUSTOMER_TITLE_RE = /^\s*(?:invoice|inv|pay[-_ ]?app\w*)\b.*?\s[-\u2013]\s*\S|\bpay[-_ ]?app\b/i;
export function titleNamesCustomer(title: string | null | undefined): boolean {
  return CUSTOMER_TITLE_RE.test(String(title ?? ''));
}
const LEASE_RE = /\b(lease|rent|rental|landlord|tenancy)\b/i;

/** Lowercase, no punctuation, no legal suffix: "Beacon Roofing Supply, Inc." and "BEACON ROOFING SUPPLY" match. */
export function vendorKey(name: unknown): string {
  const s = String(name ?? '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  if (!s) return '';
  const words = s.split(' ').filter(Boolean);
  while (words.length > 1 && /^(inc|llc|ltd|co|corp|corporation|company|incorporated|the|lp|llp|pllc)$/.test(words[words.length - 1] ?? '')) words.pop();
  if (words.length > 1 && words[0] === 'the') words.shift();
  return words.join(' ').slice(0, 120);
}

function isOwnName(name: string, opts?: FolderOpts): boolean {
  const k = vendorKey(name);
  if (!k) return false;
  return (opts?.companyNames ?? []).some((n) => vendorKey(n) === k);
}

/** A customer name (that is not our own), a service address or a job number found on the paper. */
function customerEvidence(f: Facts | null | undefined, opts: FolderOpts | undefined, { name }: { name: boolean }): boolean {
  if (has(f?.service_address) || has(f?.job_number) || has(f?.job_key) || has(f?.work_order_number)) return true;
  if (name && has(f?.customer_name) && !isOwnName(String(f?.customer_name), opts)) return true;
  return false;
}

/**
 * Where does this paper live? folder null means customer paper. Rules (from the Company Files plan):
 *  - a saved choice wins ('customer' sends it to the customer side);
 *  - customer evidence (a customer name, service address or job number) means customer paper, even when the type looks
 *    internal. Types that are always company paper (receipt, purchase order, schedule, price list, HR letter, insurance
 *    certificate) are never pulled to a customer by a name alone, only by an address or job number; HR letters stay in
 *    People and HR whatever is on them;
 *  - invoices by bill-to / issuer, statements by issuer, agreements by counterparty, permits by service address,
 *    correspondence by customer found; "other" lands in Company and admin.
 */
export function companyFolderInfo(doc: CompanyDoc, opts: FolderOpts = {}): FolderInfo {
  const none: FolderInfo = { folder: null, confident: true, source: 'none' };
  const ov = doc.override ?? null;
  if (ov === OVERRIDE_CUSTOMER) return none;
  if (isFolderId(ov)) return { folder: ov, confident: true, source: 'override' };

  const t = canonType(doc.type);
  if (!t || ALWAYS_CUSTOMER_TYPES.has(t)) return none;
  const f = doc.fields ?? {};
  const always = ALWAYS_COMPANY_TYPES.has(t);
  // An explicit link to a customer, property or unit pulls ordinary papers to the customer side.
  if (doc.linkedCustomer && !always) return none;
  const vendor = val(f, 'vendor');
  const evAny = customerEvidence(f, opts, { name: true });
  const evPlace = customerEvidence(f, opts, { name: false });
  const hint = `${vendor} ${doc.title ?? ''}`;

  let folder: CompanyFolderId | null = null;
  let confident = true;
  switch (t) {
    case 'hr-letter': folder = 'people-hr'; break;
    case 'insurance-certificate': folder = evPlace ? null : 'insurance-legal'; break;
    case 'schedule': folder = evPlace ? null : 'schedules-operations'; break;
    case 'price-list': folder = evPlace ? null : 'suppliers-vendors'; break;
    case 'purchase-order': folder = evPlace ? null : 'purchasing'; break;
    case 'receipt': folder = evPlace ? null : 'money-in-out'; break;
    case 'delivery-ticket': folder = evAny ? null : 'purchasing'; break;
    case 'statement':
      if (evPlace) folder = null;
      else if (vendor) folder = BANK_RE.test(vendor) ? 'money-in-out' : 'suppliers-vendors';
      else if (evAny) folder = null;
      else { folder = 'company-admin'; confident = false; }
      break;
    case 'invoice':
      if (evAny) folder = null;
      else if (vendor) folder = PRO_RE.test(vendor) ? 'money-in-out' : 'suppliers-vendors';
      // No vendor and no customer evidence: never guess "supplier" (our own outgoing invoices look like this).
      else { folder = null; }
      break;
    case 'agreement':
      if (evAny) folder = null;
      else {
        folder = LEASE_RE.test(hint) ? 'company-admin' : 'insurance-legal';
        confident = has(vendor) || has(doc.title);
      }
      break;
    case 'permit': folder = evAny ? null : 'insurance-legal'; break;
    case 'correspondence': folder = evAny ? null : 'company-admin'; break;
    case 'internal': folder = evAny ? null : 'company-admin'; break;
    case 'other': folder = evAny ? null : 'company-admin'; confident = false; break;
    case 'proposal-quote': folder = !evAny && vendor ? 'suppliers-vendors' : null; break;
    case 'dispatch-note': folder = evAny ? null : 'schedules-operations'; confident = false; break;
    default: folder = null;
  }
  if (!folder) return none;
  // "Always file {vendor} here": follows the vendor, but never into People and HR and never for customer paper.
  const rule = vendor ? opts.vendorRules?.[vendorKey(vendor)] : undefined;
  if (isFolderId(rule) && rule !== HR_FOLDER_ID && folder !== HR_FOLDER_ID) return { folder: rule, confident: true, source: 'vendor-rule' };
  return { folder, confident, source: 'type' };
}

export function companyFolderFor(doc: CompanyDoc, opts: FolderOpts = {}): CompanyFolderId | null {
  return companyFolderInfo(doc, opts).folder;
}

/** True when the paper is a company file (it has a company folder). Reuses the shared company-record and link-optional flags
 *  so a type the rest of the app already treats as company paperwork is never customer-linked here. */
export function isCompanyFile(doc: CompanyDoc, opts: FolderOpts = {}): boolean {
  return companyFolderFor(doc, opts) !== null;
}

/** documentTypes flags this module leans on, exported so the test can prove they still line up. */
export const RELIED_ON_FLAGS = {
  companyRecordTypes: [...COMPANY_RECORD_TYPES].sort(),
  linkOptionalTypes: [...LINK_OPTIONAL_TYPES].sort(),
  /** Company paper only while no customer and no address is named on it ("other"). */
  companyIfNoCustomerOrAddressTypes: [...COMPANY_RECORD_IF_NO_CUSTOMER_OR_ADDRESS_TYPES].sort(),
};

// ---- Check these ----

export type CheckReason = 'hard-to-read' | 'no-total' | 'might-be-copy' | 'unsure-folder';
export const CHECK_REASON_LABEL: Record<CheckReason, string> = {
  'hard-to-read': 'Hard to read',
  'no-total': 'No total found',
  'might-be-copy': 'Might be a copy',
  'unsure-folder': 'Not sure this is the right folder',
};
/** Types whose paper is a money document: a missing total is a problem a person should see. */
export const MONEY_TYPES: Set<string> = new Set(['receipt', 'invoice', 'statement', 'purchase-order']);

export interface CheckInput {
  type: string | null | undefined;
  fields?: Facts | null;
  info: FolderInfo;
  /** The paper could not be read, or nothing was read off it. */
  unreadable?: boolean;
  copy?: boolean;
}

export function checkReasons(x: CheckInput): CheckReason[] {
  const out: CheckReason[] = [];
  const t = canonType(x.type);
  if (x.unreadable) out.push('hard-to-read');
  const f = x.fields ?? {};
  if (!x.unreadable && MONEY_TYPES.has(t) && !has(f.cost) && !has(f.total) && !has(f.amount)) out.push('no-total');
  if (x.copy) out.push('might-be-copy');
  if (x.info.source !== 'override' && !x.info.confident) out.push('unsure-folder');
  return out;
}

/** Same vendor + same number + same total means a likely copy. Returns '' when any of the three is missing. */
export function copyKey(type: string | null | undefined, f: Facts | null | undefined): string {
  const v = vendorKey(f?.vendor);
  const n = val(f, 'invoice_number').toLowerCase();
  const total = val(f, 'cost') || val(f, 'total') || val(f, 'amount');
  if (!v || !n || !total) return '';
  return `${canonType(type)}|${v}|${n}|${total.replace(/[^0-9.-]/g, '')}`;
}

// ---- Dates and "Coming up" ----

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const pad2 = (n: number): string => String(n).padStart(2, '0');

function oneDate(s: string): string | null {
  let m: string[] | null = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return `${m[3]}-${pad2(Number(m[1]))}-${pad2(Number(m[2]))}`;
  m = /([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i.exec(s);
  if (m) {
    const word = String(m[1]).toLowerCase().slice(0, 3);
    const mo = MONTHS.findIndex((x) => x.startsWith(word)) + 1;
    if (mo) return `${m[3]}-${pad2(mo)}-${pad2(Number(m[2]))}`;
  }
  return null;
}

/** Last full date found in text ("01/01/2025 - 12/31/2025" -> 2025-12-31). Null when there is none. */
export function parseEndDate(raw: unknown): string | null {
  const s = String(raw ?? '');
  const parts = s.split(/\s+(?:-|–|—|to|through|thru|until)\s+/i);
  for (let i = parts.length - 1; i >= 0; i--) {
    const d = oneDate(parts[i] ?? '');
    if (d) return d;
  }
  return oneDate(s);
}

/** Existing extraction keys that carry an end date, in the order they are trusted. `expires_on` is reserved for a future
 *  extractor field; the others are read today (coi_expires and lease_end_date by the property pack, warranty_expires and
 *  agreement_term by the standard vocabulary). */
export const EXPIRY_FIELD_KEYS: string[] = ['expires_on', 'coi_expires', 'lease_end_date', 'warranty_expires', 'agreement_term', 'next_test_due'];

export function expiryDateFor(f: Facts | null | undefined): string | null {
  for (const k of EXPIRY_FIELD_KEYS) {
    if (!has(f?.[k])) continue;
    const d = parseEndDate(f?.[k]);
    if (d) return d;
  }
  return null;
}

export function addDaysIso(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400000);
}
export const COMING_UP_DAYS = 60;

export type ExpiryState = 'upcoming' | 'expired' | null;
export function expiryState(expiresIso: string | null | undefined, todayIso: string, windowDays: number = COMING_UP_DAYS): ExpiryState {
  if (!expiresIso) return null;
  if (expiresIso < todayIso) return 'expired';
  return expiresIso <= addDaysIso(todayIso, windowDays) ? 'upcoming' : null;
}

export function monthKey(iso: string | null | undefined): string {
  return /^\d{4}-\d{2}/.test(String(iso ?? '')) ? String(iso).slice(0, 7) : '';
}

// ---- Who may open People and HR ----

export interface CompanyFilesSettings {
  vendorRules: Record<string, string>;
  /** Besides admins: whole roles ('member') and/or named members (Clerk user ids). */
  hrAccess: { roles: string[]; members: string[] };
}
export const MAX_VENDOR_RULES = 500;
export const MAX_HR_MEMBERS = 100;

export function normalizeCompanyFilesSettings(raw: unknown): CompanyFilesSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const vendorRules: Record<string, string> = {};
  if (r.vendorRules && typeof r.vendorRules === 'object') {
    for (const [k, v] of Object.entries(r.vendorRules)) {
      if (Object.keys(vendorRules).length >= MAX_VENDOR_RULES) break;
      if (k && k.length <= 120 && isFolderId(v) && v !== HR_FOLDER_ID) vendorRules[k] = v;
    }
  }
  const roles = Array.isArray(r.hrAccess?.roles) ? r.hrAccess.roles.filter((x: unknown) => x === 'member') : [];
  const members = Array.isArray(r.hrAccess?.members)
    ? r.hrAccess.members.filter((x: unknown) => typeof x === 'string' && x && x.length <= 200).slice(0, MAX_HR_MEMBERS)
    : [];
  return { vendorRules, hrAccess: { roles: [...new Set<string>(roles)], members: [...new Set<string>(members)] } };
}

export interface AccessAuth { userId?: string | null; orgId?: string | null; orgRole?: string | null }

/** Admins always; a solo tenant (no shop) is its own admin; everyone else only when the admin granted their role or them. */
export function canSeeHr(auth: AccessAuth | null | undefined, settings: CompanyFilesSettings | null | undefined): boolean {
  if (!auth) return false;
  if (!auth.orgId) return true;
  if (auth.orgRole === 'admin') return true;
  const a = settings?.hrAccess;
  if (!a) return false;
  if (auth.orgRole === 'member' && a.roles.includes('member')) return true;
  return !!auth.userId && a.members.includes(auth.userId);
}

/** Folders a person may see: People and HR is left out unless they have access. */
export function visibleFolders(hrOk: boolean): CompanyFolderDef[] {
  return COMPANY_FOLDERS.filter((f) => hrOk || f.id !== HR_FOLDER_ID);
}

// ---- Moving a paper (pure part of move / undo / vendor memory) ----

export interface MoveRequest {
  to: string;
  alwaysFile?: boolean;
}
export interface MovePlan {
  ok: boolean;
  error?: string;
  /** The override value to store: a folder id or 'customer'. */
  override?: string;
  /** vendorKey to remember, when "Always file {vendor} here" applies. */
  rule?: { key: string; folder: string } | null;
}

/** Validates a move. canHr: may this caller touch People and HR. currentFolder: where the paper is now. */
export function planMove(req: MoveRequest, ctx: { vendor?: string | null; canHr: boolean; currentFolder: string | null }): MovePlan {
  const to = String(req?.to ?? '');
  if (to !== OVERRIDE_CUSTOMER && !isFolderId(to)) return { ok: false, error: 'Unknown folder' };
  if ((to === HR_FOLDER_ID || ctx.currentFolder === HR_FOLDER_ID) && !ctx.canHr) return { ok: false, error: 'Only people with People and HR access can move this' };
  const key = vendorKey(ctx.vendor);
  // "Always file {vendor} here" defaults to on; it is never kept for People and HR or for the customer side.
  const wants = req?.alwaysFile !== false;
  const rule = wants && key && to !== OVERRIDE_CUSTOMER && to !== HR_FOLDER_ID ? { key, folder: to } : null;
  return { ok: true, override: to, rule };
}

/** Applies a move to a settings object; returns the new settings and what to hand back for Undo. */
export function applyMoveToSettings(s: CompanyFilesSettings, plan: MovePlan): { settings: CompanyFilesSettings; previousRule: string | null; ruleKey: string | null } {
  const next: CompanyFilesSettings = { vendorRules: { ...s.vendorRules }, hrAccess: s.hrAccess };
  if (!plan.rule) return { settings: next, previousRule: null, ruleKey: null };
  const previousRule = s.vendorRules[plan.rule.key] ?? null;
  next.vendorRules[plan.rule.key] = plan.rule.folder;
  return { settings: next, previousRule, ruleKey: plan.rule.key };
}

/** Puts a vendor rule back to what it was (null removes it). */
export function undoRuleInSettings(s: CompanyFilesSettings, ruleKey: string | null, previousRule: string | null): CompanyFilesSettings {
  const next: CompanyFilesSettings = { vendorRules: { ...s.vendorRules }, hrAccess: s.hrAccess };
  if (!ruleKey) return next;
  if (previousRule && isFolderId(previousRule)) next.vendorRules[ruleKey] = previousRule;
  else delete next.vendorRules[ruleKey];
  return next;
}
