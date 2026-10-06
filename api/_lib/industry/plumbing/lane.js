/**
 * Plumbing question lanes (Build 2, stage 2C): answers the questions a plumbing contractor actually asks, straight from the
 * extracted paperwork, with the source page, and NO model.
 *
 *   classifyPlumbing(question, {today}) -> intent | null      (pure)
 *   runPlumbing(db, intent, {today})    -> answer envelope | null
 *   plumbingAttention(db, {today, withinDays}) -> {items}      (dashboard card: same definitions as the lane)
 *
 * null always means "not sure": the normal path (and its model) takes over. Out-of-scope code-compliance and legal questions
 * get the fixed decline text. Every fact cites {documentId, location:{field, page}}. Definitions (kept literal and short):
 *   - A backflow DEVICE is one serial number (or, with no serial, one address + device location). Only its LATEST test (by test
 *     date) is current; older certificates for the device are history and never feed a due / overdue / result / tester answer.
 *   - OVERDUE: next test due < today. Due today is not overdue. DUE WITHIN N DAYS: today <= due <= today + N (inclusive both ends).
 *     A device whose latest test FAILED needs a retest; it is only in the failed list, never in a due or overdue list.
 *   - A water heater's warranty is what its warranty registration prints (expires). With no registration on file there is NO
 *     warranty answer (never worked out from brand or age). Under warranty: expires >= today; expired: expires < today.
 *   - A permit is FINISHED when its printed status is final / closed (or a passed final inspection is on file for it); otherwise
 *     EXPIRED when its expiry date is before today (or its printed status says expired); otherwise OPEN. "Open" says what the
 *     file shows, not what the city shows.
 *   - Inspection results are reported as written; "passed" / "failed" only when the wording says so, anything else is shown verbatim.
 *   - An answer that depends on a value we cannot read, two readings that disagree, or a question we do not fully understand
 *     returns null (the normal path) rather than a guess.
 * Company isolation: every query runs inside the caller's tenant transaction (row-level security).
 */
import { answerEnvelope } from '../../scope.js';
import { parseDate, resultClass } from './extract.js';
export { resultClass };

const TENANT = "tenant_id = (current_setting('app.tenant_id', true))::uuid";

export const DECLINE = {
  code: "I can't judge whether plumbing work meets code, whether a test or inspection should have passed, or what the plumbing code requires. I can show what your documents say, with the page. Ask me about a specific device, permit or document.",
  legal: "I can't give legal advice. I can show what your documents say, with the page.",
};

/* ------------------------------------------------------------------ text helpers */
const norm = (s) => String(s ?? '').toLowerCase().replace(/&/g, ' and ').replace(/['’]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
const toks = (s) => norm(s).split(' ').filter(Boolean);
const alnum = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const okIso = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d ?? '');
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const addMonths = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1 + n, 1)); const dim = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate(); return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(d, dim))).toISOString().slice(0, 10); };
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const humanDate = (iso) => { const m = String(iso ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? `${MONTHS_LONG[+m[2] - 1]} ${+m[3]}, ${m[1]}` : String(iso ?? ''); };
const money = (v) => { const n = Number(String(v ?? '').replace(/[$,]/g, '')); return Number.isFinite(n) ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : String(v ?? ''); };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const dayWord = (n) => `${n} day${n === 1 ? '' : 's'}`;

const TYPOS = { hetaer: 'heater', heatr: 'heater', heter: 'heater', watr: 'water', backfow: 'backflow', backflo: 'backflow', bakflow: 'backflow', backflw: 'backflow', bckflow: 'backflow', tnakless: 'tankless', tankles: 'tankless', tanless: 'tankless', permt: 'permit', prmit: 'permit', permitt: 'permit', permis: 'permits', warrenty: 'warranty', warrantee: 'warranty', waranty: 'warranty', warrantys: 'warranties', camra: 'camera', cmaera: 'camera', invioce: 'invoice', invoce: 'invoice', serail: 'serial', seral: 'serial', sewar: 'sewer', sewr: 'sewer', insepction: 'inspection', inspecion: 'inspection', overdeu: 'overdue', ovedue: 'overdue', retset: 'retest', expries: 'expires', expirs: 'expires' };
function prep(question) {
  let s = norm(question).split(' ').map((w) => TYPOS[w] ?? w).join(' ');
  s = s.replace(/\bwhs\b/g, 'water heaters').replace(/\bwh\b/g, 'water heater').replace(/\bhwh\b/g, 'water heater').replace(/\bbfp\b/g, 'backflow').replace(/\bbf\b/g, 'backflow').replace(/\bcctv\b/g, 'camera').replace(/\bt less\b/g, 'tankless');
  return s.replace(/\bafter (?:its|the|their) (?:earlier|previous|prior|last) fail\w*\b/g, ' ');
}

const STREET_SUF = 'st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|way|ct|court|cir|circle|pl|place|pkwy|parkway|hwy|highway|ter|terrace|trl|trail|loop';
const SUF_CANON = { street: 'st', avenue: 'ave', road: 'rd', drive: 'dr', lane: 'ln', court: 'ct', boulevard: 'blvd', circle: 'cir', place: 'pl', parkway: 'pkwy', terrace: 'ter', trail: 'trl', highway: 'hwy' };
const DIR_CANON = { north: 'n', south: 's', east: 'e', west: 'w' };
const SUF_SET = new Set([...Object.keys(SUF_CANON), ...Object.values(SUF_CANON), 'way', 'loop']);
const canonTok = (w) => DIR_CANON[w] ?? SUF_CANON[w] ?? w;
/** One job, however the street is spelled: street part only, suffix/directions canonical, nothing after the suffix; a unit/suite is kept. */
function canonAddr(raw) {
  const t = norm(String(raw ?? '').split(',')[0]).split(' ').filter(Boolean).map(canonTok);
  const i = t.findIndex((w, k) => k > 0 && SUF_SET.has(w));
  const unit = String(raw ?? '').toLowerCase().match(/(?:\b(?:suite|ste|unit|apt|apartment|bldg|building)\b\.?\s*#?\s*|#\s*)([a-z0-9-]+)/);
  return `${(i >= 0 ? t.slice(0, i + 1) : t).join(' ')}${unit ? ` u${unit[1]}` : ''}`;
}
const baseOf = (k) => k.replace(/ u[a-z0-9-]+$/, '');

/* ------------------------------------------------------------------ data */
const DATE_KEY = /_(?:date|expiry|due)$|^(?:warranty_expires|permit_expires)$/;
/** Every document with its extracted values and the page each value came from (corrected values win). */
async function loadDocs(db) {
  const { rows } = await db.raw(
    `SELECT d.id, d.original_filename AS filename, d.document_type AS type, d.created_at,
            x.field_key AS key, COALESCE(x.corrected_value, x.value) AS value, f.page_no AS page
       FROM documents d
       LEFT JOIN extractions x ON x.document_id = d.id AND x.${TENANT}
       LEFT JOIN facets f ON f.id = x.source_facet_id
      WHERE d.${TENANT} AND d.document_type IS NOT NULL
      ORDER BY d.created_at, d.id, x.created_at, x.id`, []);
  const map = new Map(); let order = 0;
  for (const r of rows) {
    let d = map.get(r.id);
    if (!d) { d = { id: r.id, filename: r.filename, type: String(r.type).replace(/_/g, '-'), fields: {}, all: {}, order: order++ }; map.set(r.id, d); }
    if (r.key && r.value != null && String(r.value).trim() !== '') {
      let v = String(r.value);
      // a model-read date can arrive as printed text; the lane only ever compares real ISO dates
      if (DATE_KEY.test(r.key) && !/^\d{4}-\d{2}-\d{2}$/.test(v)) { const iso = parseDate(v); if (iso) v = iso; }
      if (/_(?:expiry|due)$|^(?:warranty_expires|permit_expires)$/.test(r.key) && /^\d{4}-\d{2}$/.test(v)) { const [yy, mm] = v.split('-').map(Number); v = new Date(Date.UTC(yy, mm, 0)).toISOString().slice(0, 10); } // a month-only expiry runs to the end of that month
      (d.all[r.key] ??= []).push({ value: v, page: r.page ?? 1 });
      d.fields[r.key] ??= { value: v, page: r.page ?? 1 };
    }
  }
  return [...map.values()];
}
const f = (d, k) => d?.fields?.[k]?.value ?? null;
const src = (d, k, page) => ({ documentId: d.id, location: { field: k, page: page ?? d.fields[k]?.page ?? 1 } });
const fact = (label, value, d, k, page) => ({ label, value, sources: [src(d, k, page)] });
const addrKey = (d) => canonAddr(f(d, 'service_address'));
const custKey = (d) => norm(f(d, 'customer_name') ?? '');
const byDate = (k) => (a, b) => String(f(a, k) ?? '').localeCompare(String(f(b, k) ?? '')) || a.order - b.order;

/* ------------------------------------------------------------------ models */
const devKind = (t) => { const s = String(t ?? ''); if (/\brpz\b|\brp\b|\brpda\b|reduced pressure/i.test(s)) return 'RPZ'; if (/\bdcva\b|\bdcda\b|\bdc\b|double check/i.test(s)) return 'DCVA'; if (/\bpvb\b|pressure vacuum/i.test(s)) return 'PVB'; if (/\bsvb\b|spill/i.test(s)) return 'SVB'; return null; };

function backflowDevices(docs) {
  const certs = docs.filter((d) => d.type === 'backflow-test-certificate');
  const groups = []; const bySerial = new Map();
  const locKey = (d) => `${addrKey(d)}|${norm(f(d, 'device_location') ?? '')}`;
  for (const d of certs) { const sn = alnum(f(d, 'serial_number')); if (!sn) continue; let g = bySerial.get(sn); if (!g) { g = { certs: [] }; bySerial.set(sn, g); groups.push(g); } g.certs.push(d); }
  for (const d of certs) {
    if (alnum(f(d, 'serial_number'))) continue;
    let g = groups.find((x) => x.certs.some((c) => locKey(c) === locKey(d)));
    if (!g) { g = { certs: [] }; groups.push(g); }
    g.certs.push(d);
  }
  const devsOut = groups.map((g) => {
    const sorted = [...g.certs].sort(byDate('service_date'));
    const current = sorted[sorted.length - 1]; const prev = sorted[sorted.length - 2];
    const dateBad = sorted.some((c) => !okIso(f(c, 'service_date'))); // a certificate with no readable test date: we cannot tell which is the latest, so the device is flagged, never guessed
    const status = dateBad ? 'other' : resultClass(f(current, 'backflow_test_result'));
    const get = (k) => { for (let i = sorted.length - 1; i >= 0; i--) if (f(sorted[i], k)) return { d: sorted[i], v: f(sorted[i], k) }; return null; };
    const kindSrc = get('equipment_type');
    return {
      certs: sorted, current, history: sorted.slice(0, -1), status, get,
      conflict: dateBad || !!prev && f(prev, 'service_date') && f(prev, 'service_date') === f(current, 'service_date') && (resultClass(f(prev, 'backflow_test_result')) !== status || f(prev, 'next_test_due') !== f(current, 'next_test_due')),
      kind: devKind(kindSrc?.v), serial: f(current, 'serial_number') ?? get('serial_number')?.v ?? null,
      tested: f(current, 'service_date'), due: status === 'passed' ? f(current, 'next_test_due') : null,
      addr: addrKey(current), addrRaw: f(current, 'service_address') ?? get('service_address')?.v ?? '', cust: custKey(current), custRaw: f(current, 'customer_name') ?? '',
      loc: get('device_location')?.v ?? '', make: get('manufacturer')?.v ?? '', size: get('device_size')?.v ?? '',
    };
  });
  // the same address and the same test date with different next-due dates where one certificate has no serial: we cannot tell whether
  // it is one device or two, so both are flagged and every answer type treats them the same way (unreadable / clarify / null)
  for (const a of devsOut) for (const b of devsOut) {
    if (a === b || a.status === 'other' || b.status === 'other') continue;
    if (a.addr && a.addr === b.addr && a.tested && a.tested === b.tested && a.due !== b.due && (!alnum(a.serial) || !alnum(b.serial)) && (!a.loc || !b.loc || norm(a.loc) === norm(b.loc))) { a.conflict = true; b.conflict = true; }
  }
  return devsOut;
}
const devLabel = (v) => `${v.kind ? `${v.kind} ` : ''}backflow device${v.loc ? ` (${v.loc})` : ''} at ${String(v.addrRaw).split(',')[0]}`.trim();
const devFactLabel = (v) => `${v.custRaw ? `${v.custRaw} · ` : ''}${v.kind ? `${v.kind} · ` : ''}${String(v.addrRaw).split(',')[0]}${v.loc ? ` · ${v.loc}` : ''}${v.serial ? ` · serial ${v.serial}` : ''}`;

const HEATER_TYPES = new Set(['startup-sheet', 'warranty-registration', 'equipment-record', 'nameplate-photo']);
const NON_HEATER = /softener|disposal|sump|pump|faucet|toilet|fixture|boiler|furnace|air handler|condenser|backflow|rpz|dcva|pvb|a\/c|valve|tub|shower/i;
function waterHeaters(docs) {
  const cand = docs.filter((d) => HEATER_TYPES.has(d.type));
  const groups = []; const bySerial = new Map();
  for (const d of cand) { const sn = alnum(f(d, 'serial_number')); if (!sn) continue; let g = bySerial.get(sn); if (!g) { g = { docs: [] }; bySerial.set(sn, g); groups.push(g); } g.docs.push(d); }
  for (const d of cand) {
    if (alnum(f(d, 'serial_number'))) continue;
    const k = `${addrKey(d)}|${alnum(f(d, 'model') ?? '')}`;
    let g = groups.find((x) => x.docs.some((c) => !alnum(f(c, 'serial_number')) && `${addrKey(c)}|${alnum(f(c, 'model') ?? '')}` === k));
    if (!g) { g = { docs: [] }; groups.push(g); }
    g.docs.push(d);
  }
  const PREF = ['startup-sheet', 'equipment-record', 'nameplate-photo', 'warranty-registration'];
  return groups.filter((g) => !g.docs.some((d) => NON_HEATER.test(f(d, 'equipment_type') ?? '') || NON_HEATER.test(f(d, 'fixture_type') ?? '')) && g.docs.some((d) => d.type === 'startup-sheet' || d.type === 'warranty-registration' || /water heater|tank|tankless/i.test(f(d, 'equipment_type') ?? ''))).map((g) => {
    const ordered = [...g.docs].sort((a, b) => PREF.indexOf(a.type) - PREF.indexOf(b.type) || a.order - b.order);
    const get = (k) => { for (const d of ordered) if (f(d, k)) return { d, v: f(d, k) }; return null; };
    const regs = g.docs.filter((d) => d.type === 'warranty-registration' && f(d, 'warranty_expires'));
    const exps = new Set(regs.map((d) => f(d, 'warranty_expires')));
    const reg = [...regs].sort(byDate('warranty_registered_date')).pop() ?? null;
    const typeText = get('equipment_type')?.v ?? '';
    const fuelText = get('fuel_type')?.v ?? '';
    const addrD = ordered.find((d) => f(d, 'service_address'));
    const termReg = g.docs.filter((d) => d.type === 'warranty-registration' && f(d, 'warranty_term')).pop() ?? null;
    return {
      docs: ordered, get, reg, regAmbiguous: exps.size > 1, exp: exps.size === 1 ? [...exps][0] : null, termReg,
      make: get('manufacturer')?.v ?? '', model: get('model')?.v ?? '', serial: get('serial_number')?.v ?? '',
      tankless: /tankless|on[- ]demand/i.test(typeText) ? true : /\btank\b|storage/i.test(typeText) ? false : null,
      fuel: /electric/i.test(fuelText) ? 'electric' : /gas|propane|\blp\b|natural|\bng\b/i.test(fuelText) ? 'gas' : null,
      addr: addrD ? addrKey(addrD) : '', addrRaw: addrD ? f(addrD, 'service_address') : '', cust: norm(get('customer_name')?.v ?? ''), custRaw: get('customer_name')?.v ?? '',
    };
  });
}
const whLabel = (h) => `${h.make ? `${h.make} ` : ''}water heater${h.addrRaw ? ` at ${String(h.addrRaw).split(',')[0]}` : ''}`;

const FINISHED_OK = /^(?:final|finaled|finalled|finalized|final approved|approved final|final approval|final passed|passed final|final inspection passed|final complete|closed|closed out|complete|completed|signed off|cancel+ed|void|voided|withdrawn)$/i;
const FINISHED_RE = /\b(?:final|finaled|finalled|finalized|closed|complete|completed|signed off|cancel+ed|void|voided|withdrawn)\b/i;
const NOT_DONE = /\b(?:awaiting|pending|required|ready for|needs?|needed|failed|denied|no|not|pre ?final|before|until|call for|schedule|scheduled|request\w*|due)\b/i;
const OPEN_RE = /\b(?:open|issued|active|pending|in progress|approved|under review|valid|current|inspection pending|awaiting)\b/i;
const stageOf = (t) => { const s = String(t ?? ''); if (/\bpre[- ]?final\b|\bnot final\b/i.test(s)) return 'prefinal'; if (/\bfinal(?:ed)?\b|sign[- ]?off/i.test(s)) return 'final'; if (/\brough/i.test(s)) return 'rough'; if (/\bunderground\b|\bunder[- ]?slab\b|\btrench/i.test(s)) return 'underground'; if (/\bpressure|gas test/i.test(s)) return 'pressure'; return 'other'; };
function permitsModel(docs, today) {
  const permitDocs = docs.filter((d) => d.type === 'permit' && f(d, 'permit_number'));
  const byNo = new Map();
  for (const d of permitDocs) { const k = alnum(f(d, 'permit_number')); let p = byNo.get(k); if (!p) { p = { key: k, docs: [], insp: [] }; byNo.set(k, p); } p.docs.push(d); }
  const permits = [...byNo.values()];
  const perAddr = new Map(); for (const p of permits) { const a = addrKey(p.docs[0]); if (a) perAddr.set(a, [...(perAddr.get(a) ?? []), p]); }
  for (const d of docs.filter((x) => x.type === 'inspection-report')) {
    const nk = alnum(f(d, 'permit_number'));
    let p = nk ? byNo.get(nk) : null;
    if (!p && !nk) { const list = perAddr.get(addrKey(d)); if (list?.length === 1) p = list[0]; }
    if (p) p.insp.push(d);
  }
  for (const p of permits) {
    const d = [...p.docs].sort((a, b) => a.order - b.order)[p.docs.length - 1];
    p.d = d; p.no = f(d, 'permit_number'); p.status = f(d, 'permit_status'); p.expires = f(d, 'permit_expires'); p.issued = f(d, 'permit_issued_date'); p.type = f(d, 'permit_type'); p.jur = f(d, 'jurisdiction');
    p.addr = addrKey(d); p.addrRaw = f(d, 'service_address') ?? ''; p.cust = custKey(d); p.custRaw = f(d, 'customer_name') ?? '';
    p.insp.sort(byDate('service_date'));
    p.passedFinal = p.insp.some((i) => stageOf(f(i, 'inspection_type')) === 'final' && resultClass(f(i, 'inspection_result')) === 'passed');
    const st = String(p.status ?? '');
    const finishedByStatus = FINISHED_OK.test(String(st).trim().replace(/[^A-Za-z ]+/g, ' ').replace(/\s+/g, ' ').trim());
    if (finishedByStatus || p.passedFinal) p.state = 'finished';
    else if (/\bexpired\b|\blapsed\b/i.test(st)) p.state = 'expired';
    else if (p.expires && okIso(p.expires) && today && p.expires < today) p.state = 'expired';
    else if (!st || OPEN_RE.test(st) || (FINISHED_RE.test(st) && NOT_DONE.test(st))) p.state = 'open'; // "awaiting final", "final required", "failed final" are not finished
    else p.state = 'other';
    if (p.expires && !okIso(p.expires)) p.state = 'other';
  }
  return permits;
}
const permitLabel = (p) => `Permit ${p.no}${p.addrRaw ? ` · ${String(p.addrRaw).split(',')[0]}` : ''}`;

const NO_DEFECT = /^\s*(?:(?:no|none|nothing)(?:\s+(?:significant\s+|visible\s+)?(?:defects?|issues?|problems?|obstructions?|blockages?|deficienc\w+|damage|roots?|cracks?|findings?))?(?:\s+(?:noted|found|observed|detected|visible|seen))?|line (?:is )?clear|clear|good condition|pipe in good condition)\s*[.!]?\s*$/i; // a plain no-defect statement and nothing else; any finding with a defect word anywhere is a defect
const kindWord = (n) => ({ ticket: 'service ticket', workorder: 'work order', quote: 'proposal / quote', agreement: 'maintenance agreement', po: 'purchase order', dispatch: 'dispatch note', invoice: 'invoice' }[n] ?? n);

/* ------------------------------------------------------------------ places (addresses and customers named in a question) */
const GENERIC_NAME = new Set(['group', 'family', 'company', 'apartments', 'apartment', 'services', 'service', 'plumbing', 'water', 'heater', 'building', 'properties', 'property', 'llc', 'inc', 'corp', 'ltd', 'the', 'and', 'construction', 'hoa', 'association', 'office', 'dental', 'restaurant', 'grill', 'bakery', 'market', 'store', 'shop', 'center', 'church', 'school', 'hotel', 'motel']);
const CORP = new Set(['llc', 'inc', 'corp', 'ltd', 'co', 'company']);
function placeIndex(docs) {
  const sites = new Map(); const customers = new Map();
  for (const d of docs) {
    const ak = addrKey(d); const ck = custKey(d);
    if (ak) { let s = sites.get(ak); if (!s) { s = { key: ak, base: baseOf(ak), raw: f(d, 'service_address'), custs: new Set() }; sites.set(ak, s); } if (ck) s.custs.add(ck); }
    if (ck) { let c = customers.get(ck); if (!c) { c = { key: ck, raw: f(d, 'customer_name'), sites: new Set() }; customers.set(ck, c); } if (ak) c.sites.add(ak); }
  }
  return { sites, customers };
}
const STREET_PHRASE = new RegExp(`\\b\\d{1,6}\\s+(?:[A-Za-z0-9]+\\s+){0,3}(?:${STREET_SUF})\\b|\\b[A-Z][a-z]+(?:\\s[A-Z][a-z]+)?\\s(?:${STREET_SUF.replace(/\|/g, '|').replace(/\b(\w)/g, (m) => m)})\\b`, 'g');
/** Which job(s) / customer(s) does the question name? {sites:Set, tokens:Set, unknown, ambiguous} */
function resolvePlace(docs, rawQ) {
  const { sites, customers } = placeIndex(docs);
  const canonQ = ` ${norm(rawQ).split(' ').map(canonTok).join(' ')} `;
  const hasNum = /\b\d{1,6}\s+[a-z]/i.test(rawQ);
  const matchedSites = new Set(); const tokens = new Set(); const custHit = new Set();
  const baseCount = new Map(); for (const s of sites.values()) baseCount.set(s.base, (baseCount.get(s.base) ?? 0) + 1);
  const allBases = [...new Set([...sites.values()].map((s) => s.base))];
  for (const base of allBases) {
    const bt = base.split(' ');
    const hit = canonQ.includes(` ${base} `) || (bt.length > 2 && canonQ.includes(` ${bt.slice(0, -1).join(' ')} `) && /^\d/.test(base));
    if (hit) { for (const s of sites.values()) if (s.base === base) { matchedSites.add(s.key); } bt.forEach((t) => tokens.add(t)); }
  }
  if (!matchedSites.size) {
    // a street name with no number ("the Elm Street job"), only when it names exactly one street
    const names = new Map();
    for (const base of allBases) { const bt = base.split(' ').slice(/^\d/.test(base) ? 1 : 0); if (bt.length >= 2) names.set(bt.join(' '), [...(names.get(bt.join(' ')) ?? []), base]); }
    for (const [nm, bases] of names) if (canonQ.includes(` ${nm} `) && bases.length === 1) { for (const s of sites.values()) if (s.base === bases[0]) matchedSites.add(s.key); nm.split(' ').forEach((t) => tokens.add(t)); }
  }
  // customers
  const nameTokCount = new Map();
  for (const c of customers.values()) for (const t of new Set(c.key.split(' '))) nameTokCount.set(t, (nameTokCount.get(t) ?? 0) + 1);
  const addrToks = new Set([...sites.values()].flatMap((s) => s.key.split(' ')));
  const qTokens = new Set(canonQ.trim().split(' '));
  for (const c of customers.values()) {
    const ct = c.key.split(' ').filter((t) => !CORP.has(t));
    const full = ` ${ct.join(' ')} `;
    let hit = ct.length > 0 && canonQ.includes(full);
    if (!hit && ct.length > 1) hit = ct.some((t) => t.length >= 4 && !GENERIC_NAME.has(t) && nameTokCount.get(t) === 1 && !addrToks.has(t) && qTokens.has(t));
    if (!hit && ct.length === 1) hit = false;
    if (hit) { custHit.add(c.key); c.key.split(' ').forEach((t) => tokens.add(t)); }
  }
  let custSites = new Set();
  for (const ck of custHit) for (const s of customers.get(ck).sites) custSites.add(s);
  const out = { sites: new Set(), custs: custHit, tokens, unknown: false, conflict: false, any: false };
  if (matchedSites.size && custHit.size) {
    const both = [...matchedSites].filter((s) => custSites.has(s) || [...custHit].some((c) => sites.get(s)?.custs.has(c)));
    if (!both.length) out.conflict = true; else both.forEach((s) => out.sites.add(s));
  } else if (matchedSites.size) matchedSites.forEach((s) => out.sites.add(s));
  else if (custHit.size) { custSites.forEach((s) => out.sites.add(s)); }
  out.any = out.sites.size > 0 || custHit.size > 0;
  // a street the person typed that matches nothing we know is never guessed
  const phrases = String(rawQ).match(STREET_PHRASE) ?? [];
  if (phrases.length && !matchedSites.size) out.unknown = true;
  for (const ph of phrases) { const cp = ` ${norm(ph).split(' ').map(canonTok).join(' ')} `; if (/\d/.test(ph) && !allBases.some((b) => cp.includes(` ${b} `) || ` ${b} `.includes(cp) || (b.split(' ').length > 2 && cp.includes(` ${b.split(' ').slice(0, -1).join(' ')} `)))) out.unknown = true; }
  void hasNum;
  out.siteList = [...out.sites].map((k) => sites.get(k));
  return out;
}
const atPlace = (place, item) => (place.sites.size ? place.sites.has(item.addr) : false) || (!place.sites.size && place.custs.has(item.cust));
function clarify(items, label) {
  const places = [...new Map(items.map((x) => [`${x.addr}|${x.hint ?? ''}`, `${x.addrRaw}${x.hint ? ` (${x.hint})` : ''}`])).values()].filter(Boolean).slice(0, 6);
  return answerEnvelope({ text: `More than one ${label} matches that. Which one do you mean: ${places.join('; ')}?`, facts: [], extra: { clarify: true, clarifyOptions: places } });
}
/** ids typed in a question (permit / invoice / quote / PO / serial numbers): alnum forms of each token and of adjacent pairs */
function idForms(rawQ) {
  const t = String(rawQ).split(/\s+/).map((x) => alnum(x)).filter(Boolean);
  const out = new Set(t); for (let i = 0; i + 1 < t.length; i++) out.add(t[i] + t[i + 1]);
  return out;
}

/* ------------------------------------------------------------------ classification (pure) */
const STOP = new Set(('a an the of for at on in to is are was were be been am do does did has have had how many much what whats which who whom whose when where why show shows list lists tell give me us we our my your their his her its any every all each still now yet ever not no and or with from by about this that these those there theres it into out over under per as than then so if can could would should will shall may might must also please thanks currently right today next last first latest recent we ve i d need needs needed want see look find get got check up there here one ones them they you he she can t only just really do yes anything anyone everything').split(/\s+/));
const NUMW = /^\d{1,4}$/;
const BF_VOCAB = 'water backflow device devices assembly assemblies preventer preventers test tests tested testing retest retested retests retesting due overdue past annual next date result results pass passed passing fail failed failing failure failures serial brand make manufacturer model size big large diameter utility filed reported tester testers cert certs certification certifications certificate certificates number numbers location located installed who need needed status type kind earlier waiting follow rpz dcva pvb svb certified track tracked file on record records documents document us show list late units unit'.split(' ');
const WH_VOCAB = 'active valid water heater heaters tankless tank units unit gas electric fuel made make brand manufacturer manufactured model serial number gallons gallon capacity size big old age installed install installation date warranty warranties expire expires expiring expired expiration under covered coverage out term registered registration years year long how record records file on type propane versus vs'.split(' ');
const PM_VOCAB = 'permit permits plumbing gas number numbers office issued issue date issuing agency city jurisdiction expire expires expiring expired expiration status open closed final finaled type inspection inspections inspector rough in roughin result results pass passed fail failed failing failures when still right now ran out running run that have kind what file on record records'.split(' ');
const CAM_VOCAB = 'sewer drain line lines camera cameras video inspection inspections inspected scope scoped report reports find found finding findings defect defects observed observation observations recommendation recommended recommend footage file recording length long run part section feet how many with show problems problem issues issue condition when date material file on record records'.split(' ');
const SVC_VOCAB = 'service ticket tickets call calls work order orders done performed technician tech plumber assigned scheduled schedule kind type visit last cost total price much amount charge proposal proposals quote quotes estimate agreement agreements maintenance contract term long cover covers covered covering come comes purchase po item items ordered dispatch dispatched going coming sent invoice invoices bill billed bills billing number come total'.split(' ');

const FOREIGN = /\b(?:tonnage|refrigerant|seer|furnace|condenser|compressor|air conditioner|air conditioning|a c|hvac|thermostat|breaker|breakers|panel|panels|nec|amperage|voltage|lease|leases|tenant|tenants|rent roll|btu)\b/;
const TIME_BLOCK = /\b(?:this|last|next|past|previous|coming)\s+(?:week|month|quarter|year)\b|\b(?:since|before|after|during|between|until|through|ago|yesterday|tomorrow|older|newer|oldest|newest|average|avg|mean|median|most|least|top|biggest|largest|smallest|highest|lowest|cheapest|expensive|compare|compared|trend|than|rank|sum|breakdown|percent|percentage|by city|by month|by year|per month|per year|each month|annually|monthly|weekly)\b|\bin (?:january|february|march|april|may|june|july|august|september|october|november|december|20\d\d)\b|\b20\d\d\b|\blast \d|\bpast \d/;

function windowOf(q) {
  const m = q.match(/\b(?:in|within|over|during|for)?\s*(?:the\s+)?(?:next|coming|following)\s+(\d{1,3})\s+(days?|weeks?|months?)\b/) || q.match(/\bwithin\s+(?:the\s+)?(?:next\s+)?(\d{1,3})\s+(days?|weeks?|months?)\b/) || q.match(/\bin\s+(\d{1,3})\s+(days?|weeks?|months?)\b/) || q.match(/\b(\d{1,3})\s+(days?|weeks?|months?)\b/);
  if (m) return { n: +m[1], unit: m[2].startsWith('month') ? 'month' : m[2].startsWith('week') ? 'week' : 'day', text: m[0] };
  if (/\b(?:soon|upcoming|coming up|about to|expiring soon)\b/.test(q)) return { n: 60, unit: 'day', text: '', implicit: true };
  return null;
}
const windowEnd = (today, w) => (w.unit === 'month' ? addMonths(today, w.n) : addDays(today, w.n * (w.unit === 'week' ? 7 : 1)));
const windowLabel = (w) => `${w.n} ${w.unit}${w.n === 1 ? '' : 's'}`;

function restTokens(q, vocab, drop = '') {
  const v = new Set(vocab);
  const t = (drop ? q.replace(drop, ' ') : q).split(' ').filter(Boolean);
  return t.filter((x) => !STOP.has(x) && !v.has(x) && !/^(?:days?|weeks?|months?)$/.test(x) && !(NUMW.test(x) && false));
}

const DOC_TOPICS = [
  ['dispatch', /\bdispatch\w*\b|\bwho (?:is|s) (?:going|coming|headed|being sent|sent)\b|\bwho is going to\b/],
  ['po', /\bpurchase orders?\b|\bpo\b/],
  ['quote', /\b(?:proposals?|quotes?|quotations?|estimates?)\b/],
  ['agreement', /\b(?:maintenance|service) (?:agreements?|contracts?)\b|\bagreements?\b/],
  ['workorder', /\bwork orders?\b/],
  ['ticket', /\bservice tickets?\b|\bservice calls?\b|\btickets?\b|\blast service\b|\bservice visits?\b/],
  ['invoice', /\binvoices?\b|\bbill(?:ed|s)?\b|\bbilling\b/],
  ['camera', /\bcamera\b|\bscope\b|\bscoped\b|\bvideo inspection\b|\bfootage\b/],
  ['startup', /\bstart ?up (?:sheets?|records?|checklists?)\b|\binstallation records?\b|\binstall records?\b/],
  ['wreg', /\bwarranty registrations?\b|\bregistration cards?\b/],
  ['permit', /\bpermits?\b/],
];
const COUNT_TYPES = [
  ['startup-sheet', /\b(?:start ?up (?:sheets?|records?|checklists?)|installation records?)\b/, 'startup sheet'],
  ['warranty-registration', /\bwarranty registrations?\b/, 'warranty registration'],
  ['inspection-report', /\binspection reports?\b|\binspection records?\b/, 'inspection report'],
  ['purchase-order', /\bpurchase orders?\b/, 'purchase order'],
  ['proposal-quote', /\b(?:proposals?|quotes?|quotations?|estimates?)\b/, 'proposal / quote'],
  ['invoice', /\binvoices?\b/, 'invoice'],
  ['service-ticket', /\bservice tickets?\b|\btickets?\b/, 'service ticket'],
  ['work-order', /\bwork orders?\b/, 'work order'],
  ['maintenance-agreement', /\b(?:maintenance |service )?(?:agreements?|contracts?)\b/, 'maintenance agreement'],
  ['dispatch-note', /\bdispatch notes?\b/, 'dispatch note'],
  ['sewer-camera-report', /\b(?:sewer |drain )?camera (?:reports?|inspections?)\b|\bvideo inspections?\b|\bsewer scopes?\b/, 'sewer camera report'],
  ['backflow-test-certificate', /\bbackflow (?:test )?(?:certificates?|certifications?|reports?)\b/, 'backflow test certificate'],
];

function attrCues(cues, q, allowed = []) {
  const hit = cues.filter(([, re]) => re.test(q)).map(([a]) => a);
  if (hit.length <= 1) return hit[0] ?? null;
  for (const grp of allowed) if (hit.every((h) => grp.includes(h))) return grp[0];
  return undefined; // compound ask
}

function classifyInner(question, { today } = {}) {
  void today;
  const raw = String(question ?? '');
  if (!raw.trim() || raw.length > 400) return null;
  let q = prep(raw);
  // the only two negations the lane reads, both fixed idioms for a failed test: "did not pass" and "failed ... not been retested"
  q = q.replace(/\b(?:did not|didnt|do not|dont) pass\b/g, 'failed');
  if (/\bfail\w*\b/.test(q)) q = q.replace(/\b(?:that |which )?(?:have|has|are|is) not (?:yet )?(?:been )?(?:re ?tested|retested)\b/g, ' ');
  // ---- hard-limit declines first (judgement of code / law is never answered, never sent to a model)
  if (/\b(?:sued?|lawsuit|liable|liability|negligen\w*|legal advice)\b/.test(q) || (/\b(?:legal|legally|illegal)\b/.test(q) && /\b(?:is|are|can|could|do|does|to|allowed|permitted)\b/.test(q))) return { kind: 'decline', which: 'legal' };
  if (/\b(?:meet|meets|meeting|comply|complies|complying|compliant|compliance|violat\w*|up to code|to code|per code)\b/.test(q) && /\b(?:code|ipc|upc|compliance|compliant|violation|violate|violates|violating|regulations?|standard|standards)\b/.test(q) && !/\b(?:which|what|who|when|how many|list|show)\b.*\b(?:permit number|inspection result|result)\b/.test(q)) return { kind: 'decline', which: 'code' };
  if (/\bshould (?:it|that|this|the \w+(?: \w+)?)\b.*\b(?:have )?(?:passed|failed|been (?:approved|rejected))\b|\bshould (?:it|that|this) pass\b|\bwill (?:it|this|that) pass\b/.test(q)) return { kind: 'decline', which: 'code' };
  if (FOREIGN.test(q)) return null;
  // a question that negates, excludes or asks about "the first / earlier / original" one is not computed here: the normal path reads it
  if (/\b(?:not|no|never|without|except|besides|excluding|neither|nor|none|isnt|arent|wasnt|werent|dont|doesnt|didnt|cant|wont|couldnt|shouldnt|hasnt|havent)\b|\bother than\b/.test(q)) return null;
  if (/\b(?:first|earlier|previous|previously|original|originally|prior|oldest|initial|initially|before that)\b/.test(q)) return null;
  if (TIME_BLOCK.test(q.replace(new RegExp(`\\b\\d{1,6}\\s+(?:[a-z0-9]+\\s+){0,3}(?:${STREET_SUF})\\b`, 'g'), ' ')) && !/\btank\w* (?:water heaters? )?(?:versus|vs)\b/.test(q)) return null;
  if (/\b(?:and|plus|along with|as well as)\b/.test(q) && [/\bfail\w*\b/, /\boverdue\b|\bpast due\b/, /\bdue\b/, /\bexpir\w*\b/, /\bopen\b/, /\bpass\w*\b/, /\bwarrant\w*\b/].filter((r) => r.test(q.replace(/\bpast due\b/g, 'overdue').replace(/\boverdue\b/g, 'ovrd'))).length >= 2 && !/\bfailed and still need\b/.test(q)) return null; // two different asks in one sentence
  if (/\b(?:and then|as well as|plus|also)\b|\b(?:and|but)\s+(?:which|what|how many)\b/.test(q)) return null;
  if (!(/\b(?:tank|tankless|water heater)/.test(q)) && /\bwho (?:was|is) the (?:technician|tech|plumber)\b/.test(q) && !/\b(?:backflow|test|tested|tester)\b/.test(q)) return { kind: 'svc_fact', doc: 'ticket', attr: 'who', rest: restTokens(q, SVC_VOCAB) };

  if (/\bneed\w*\s+(?:my |our |your )?attention\b|\bneed\w*\s+(?:a look|action)\b/.test(q)) {
    const topics = [/\bbackflow\b/, /\bwarrant\w*\b|\bwater heaters?\b/, /\bpermits?\b/].filter((r) => r.test(q)).length;
    if (topics === 0 || topics >= 2) return { kind: 'attn_all', rest: restTokens(q, ['backflow', 'tests', 'test', 'water', 'heater', 'heaters', 'warranties', 'warranty', 'permits', 'permit', 'need', 'needs', 'attention', 'or', 'anything', 'things', 'items', 'documents', 'jobs', 'right', 'now', 'today', 'look', 'action']) };
  }
  {
    // two qualifiers joined together, "ever", "overdue by 30 days", "30+ days": not implemented, so never answered as something simpler
    const QW = 'overdue|failed|passed|expired|due|open|expiring|under warranty|covered|soon|upcoming|late|failing|passing|closed';
    if (new RegExp(`\\b(?:${QW})\\b\\s*(?:,|or|and|/)\\s*(?:${QW})\\b`).test(q) && !/\boverdue or due\b/.test(q)) return null;
    if (/\bever\b|\boverdue by\b|\b\d+\s*(?:days?|weeks?|months?)\s+(?:overdue|late|past due)\b|\bover \d+\s*(?:days?|weeks?|months?)\b|\b\d+\s*\+/.test(q)) return null;
  }
  const win = windowOf(q);
  const qw = win?.text ? q.replace(win.text, ' ') : q;
  const how = /\bhow many\b(?! (?:gallons?|years?|feet|months?|days?|ft)\b)/.test(q);
  const listCue = /\b(?:which|show|list|any|every|all|anything|anyone)\b|\bwhat\b.*\b(?:devices|tests|assemblies|failures|warranties|permits|inspections|heaters|lines|units)\b/.test(q);
  const present = DOC_TOPICS.filter(([, re]) => re.test(q)).map(([n]) => n);
  const bfSubject = /\bbackflow\b|\brpz\b|\bdcva\b|\bpvb\b|\bsvb\b|\bcross connection\b/.test(q);
  const whSubject = /\bwater heaters?\b|\btankless\b|\bhot water (?:tank|heater)s?\b|\bheaters?\b/.test(q);
  const inspWord = /\binspections?\b|\brough ?in\b|\bfinal\b|\btop ?out\b/.test(q);

  // ---------------------------------------------------------------- counts by document type
  const QUAL = /\b(?:overdue|passed|passing|pass|failed|failing|fail|due|expiring|expired|expire|expires|late|upcoming|soon|open|closed|finaled|pending|unpaid|paid|signed|completed|active|current|tankless|tank|gas|electric|propane|older|newer)\b/;
  if (how && !bfSubject) {
    const ts = COUNT_TYPES.filter(([, re]) => re.test(q));
    const permitOpen = present.includes('permit');
    if (permitOpen) {
      const printed = /\b(?:show|shows|showing|marked|listed|say|says|saying|printed|labeled|labelled|read|reads)\b.*\bopen\b|\bopen status\b|\bstatus (?:is |of |as )?open\b/.test(q);
      const mode = printed && !/\bexpired\b/.test(q) ? 'printed_open' : /\bopen\b/.test(q) && !/\bexpired\b/.test(q) ? 'open' : /\bexpired\b|\bran out\b|\blapsed\b/.test(q) && !/\bopen\b/.test(q) ? 'expired' : /\b(?:open|expired|closed|final\w*|failed|expiring|expire\w*)\b/.test(q) ? null : 'all';
      if (!mode) return null;
      const rest = restTokens(qw, [...PM_VOCAB, 'on', 'file', 'do', 'we', 'have']);
      return { kind: 'pm_count', mode, rest };
    }
    if (ts.length && QUAL.test(q)) return null; // a qualified count ("overdue", "failed", "expiring"...) is never answered with the total
    if (ts.length === 1 && (!whSubject || ts[0][0] === 'startup-sheet')) return { kind: 'count_type', type: ts[0][0], noun: ts[0][2], rest: restTokens(qw, [...SVC_VOCAB, ...WH_VOCAB, ...PM_VOCAB, ...CAM_VOCAB, 'registrations', 'registration', 'startup', 'sheets', 'sheet', 'records', 'record', 'reports', 'report', 'warranty']) };
    if (ts.length === 2 && ts.every(([t]) => ['startup-sheet', 'proposal-quote'].includes(t) || true) && /\bor\b/.test(q) && ts[0][0] === 'startup-sheet') return { kind: 'count_type', type: 'startup-sheet', noun: 'startup sheet / installation record', rest: restTokens(qw, [...WH_VOCAB, 'sheets', 'sheet', 'records', 'record', 'startup', 'or']) };
    if (/\bsewer\b|\bdrain\b|\bcamera\b/.test(q) && present.includes('camera')) return { kind: 'count_type', type: 'sewer-camera-report', noun: 'sewer camera report', rest: restTokens(qw, CAM_VOCAB) };
  }

  // ---------------------------------------------------------------- backflow
  if (bfSubject && !present.some((p) => p !== 'camera' && p !== 'invoice' && p !== 'quote' && p !== 'agreement' && p !== 'ticket' && p !== 'workorder' && p !== 'po' && p !== 'dispatch' && p !== 'permit') && !present.length) {
    const dk = /\brpz\b/.test(q) ? 'RPZ' : /\bdcva\b/.test(q) ? 'DCVA' : /\bpvb\b/.test(q) ? 'PVB' : /\bsvb\b/.test(q) ? 'SVB' : null;
    const rest0 = restTokens(qw, BF_VOCAB);
    if (how) {
      if (!/\bfail\w*\b/.test(q) && QUAL.test(q.replace(/\b(?:rpz|dcva|pvb|svb)\b/g, ' '))) return null;
      const what = /\bcertificates?\b|\bcerts?\b|\bcertifications?\b|\breports?\b/.test(q) ? 'certs' : /\bnot pass\w*|\bfail\w*|\bdidnt pass\b/.test(q) ? 'failed' : dk ? 'kind' : /\bdevices?\b|\bassembl\w+|\bpreventers?\b|\btrack\w*\b/.test(q) ? 'devices' : /\btests?\b/.test(q) && /\b(?:file|have)\b/.test(q) ? 'certs' : null;
      if (!what) return null;
      return { kind: 'bf_count', what, devKind: dk, rest: rest0 };
    }
    const failWord = /\bfail\w*\b|\bnot pass\w*\b|\bdidnt pass\b/.test(q);
    const overdueWord = /\boverdue\b|\bpast due\b|\blate\b/.test(q);
    if (!failWord && /\bneed\w*\s+(?:a\s+|an\s+)?re ?test/.test(q) && (listCue || how)) return null;
    if (overdueWord && /\bdue\b/.test(q.replace(/\bpast due\b/g, ' ')) && !win) return null;
    const singleStart = /^(?:is|are|was|were|did|does|do|has|have)\b/.test(q);
    // lists
    if (failWord && (listCue || /\bfailures\b/.test(q)) && !singleStart && !win) return { kind: 'bf_list', mode: 'failed', devKind: dk, rest: rest0 };
    if (listCue && overdueWord && /\bdue\b/.test(q) && win && !failWord && !/\bwhen\b|\bwho\b/.test(q)) return { kind: 'bf_list', mode: 'due_or_overdue', win, devKind: dk, rest: restTokens(qw, BF_VOCAB) };
    if (overdueWord && (listCue || singleStart) && !/\bwhen\b|\bwho\b/.test(q) && !failWord) return { kind: 'bf_list', mode: 'overdue', devKind: dk, rest: rest0, maybeSingle: true };
    if (/\bdue today\b|\bdue on today\b/.test(q)) return { kind: 'bf_list', mode: 'today', devKind: dk, rest: rest0 };
    if (listCue && win && (/\bdue\b|\bneed\w*\b|\bupcoming\b|\bcoming up\b|\bexpir\w*\b|\btest(?:ed|ing)?\b/.test(q)) && !singleStart && !/\bwhen\b|\bwho\b/.test(q)) return { kind: 'bf_list', mode: 'due', win, devKind: dk, rest: restTokens(qw, [...BF_VOCAB, 'soon']) };
    if (listCue && /\bdue\b/.test(q) && /\boverdue\b/.test(q) && win) return { kind: 'bf_list', mode: 'due_or_overdue', win, devKind: dk, rest: restTokens(qw, BF_VOCAB) };
    if (listCue && /\b(?:due|need\w*)\b/.test(q) && !win) return null;
    // one device
    const CUES = [
      ['cert', /\bcert\b|\bcerts\b|\bcertification\b|\bcertificate number\b|\bcert number\b/], ['utility', /\b(?:utility|filed with|purveyor|reported to|submitted to|water company)\b/], ['serial', /\bserial\b|\bsn\b/],
      ['location', /\bwhere\b|\blocated\b|\blocation\b|\binstalled at\b/], ['size', /\bsize\b|\bhow big\b|\bhow large\b|\bdiameter\b/], ['make', /\bbrand\b|\bmake\b|\bmanufacturer\b|\bwho made\b|\bmanufactured\b/], ['model', /\bmodel\b/],
      ['retest', /\bretest\w*\b|\bre test\b/], ['due', /\bdue date\b|\bnext (?:test|annual|due)\b|\bannual test due\b|\btest due\b|\bwhen\b.*\b(?:due|next|expire\w*|renew\w*|recertif\w*)\b|\bdue\b/], ['overdue', /\boverdue\b|\bpast due\b|\blate\b/],
      ['result', /\bpass\w*\b|\bfail\w*\b|\bresults?\b|\bstatus\b|\boutcome\b/], ['tested', /\blast tested\b|\bwhen\b.*\btested\b|\btest date\b|\bdate (?:of )?(?:the )?(?:last )?test\b|\bwhen was\b.*\btest\w*\b/],
      ['tester', /\bwho\b.*\b(?:test|tested|tester|testing)\b|\btesters?\b|\btested by\b|\bby whom\b/], ['type', /\bwhat (?:kind|type)\b|\btype of\b|\bkind of\b/],
    ];
    const when = /\bwhen\b/.test(q);
    let a = attrCues(CUES, q, [['cert', 'tester'], ['retest', 'result', 'due'], ['result', 'tested'], ['due', 'retest'], ['tester', 'tested'], ['retest', 'tested'], ['overdue', 'due', 'result'], ['location', 'size']]);
    if (a === undefined || a === null) return null;
    if (a === 'retest' && when) a = 'due';
    if (a === 'due' && /\bwhen\b.*\btested\b/.test(q) && !/\bnext\b|\bdue\b/.test(q)) a = 'tested';
    if (a === 'overdue') a = 'overdue';
    return { kind: 'bf_device', attr: a, devKind: dk, rest: rest0 };
  }

  // ---------------------------------------------------------------- water heaters (warranty, make, serial, ...)
  if (whSubject && !present.length) {
    const rest0 = restTokens(qw, WH_VOCAB);
    if (listCue && /\bcovered\b|\bcoverage\b/.test(q) && !/\bat\b/.test(q)) return null; // "which are covered" is not a defined list
    const filters = { tankless: /\btankless\b/.test(q) && !/\btank\w* (?:water heaters? )?(?:versus|vs)\b|\btank or tankless\b|\btankless or tank\b/.test(q), tank: /\btank\b/.test(q) && !/\btankless\b/.test(q), gas: /\bgas\b/.test(q) && !/\bgas or electric\b|\belectric or gas\b/.test(q), electric: /\belectric\b/.test(q) && !/\bgas or electric\b|\belectric or gas\b/.test(q) };
    const versus = /\btank\w* (?:water heaters? )?(?:versus|vs|or|and)\s+tankless\b|\btank or tankless\b/.test(q) && how;
    const warr = /\bwarrant\w*\b/.test(q);
    const expiredW = /\b(?:expired|out of warranty|no longer (?:under )?warranty|run out|ran out)\b/.test(q) || (/\bexpired\b/.test(q));
    if (how) {
      if (versus) return { kind: 'wh_count', versus: true, filters: {}, rest: restTokens(qw, [...WH_VOCAB, 'versus', 'vs']) };
      if (warr && !expiredW) return null;
      return { kind: 'wh_count', filters, expired: warr && expiredW, rest: rest0, needMake: true };
    }
    if ((warr || /\bexpir\w*\b/.test(q)) && listCue && !/\bwhen\b|\bis\b.*\bunder\b/.test(q)) {
      if (expiredW && !/\bexpir(?:e|es|ing)\b/.test(q.replace(/\bexpired\b/g, ''))) return { kind: 'wh_list', mode: 'expired', rest: rest0 };
      if (/\bexpir\w*\b/.test(q) && win) return { kind: 'wh_list', mode: 'expiring', win, rest: restTokens(qw, [...WH_VOCAB, 'soon']) };
      if (expiredW) return { kind: 'wh_list', mode: 'expired', rest: rest0 };
      if (/\bexpir(?:e|es|ing)\b/.test(q)) return { kind: 'wh_list', mode: 'expiring', win: { n: 90, unit: 'day', text: '', defaulted: true }, rest: rest0 };
      return null;
    }
    if (listCue && /\bwhich\b|\blist\b|\bshow\b/.test(q) && !warr && (filters.tankless || filters.tank || filters.gas || filters.electric || /\bwhich water heaters? are\b/.test(q)) && !/\bwhen\b|\bwho\b|\bwhere\b/.test(q)) return { kind: 'wh_list', mode: 'attr', filters, rest: rest0, needMake: true };
    const CUES = [
      ['w_expires', /\bwarrant\w*\b.*\b(?:expire\w*|end|ends|runs? out)\b|\b(?:expire\w*)\b.*\bwarrant\w*\b|\bwhen does the warranty\b/], ['w_status', /\b(?:still|currently|under|covered|out of)\b.*\bwarrant\w*\b|\bwarrant\w*\b.*\b(?:active|valid|left|remaining|good)\b|\bis it covered\b/],
      ['w_term', /\bwarrant\w*\b.*\b(?:term|length|years?|period)\b|\bhow long\b.*\bwarrant\w*\b|\bwarranty term\b/], ['w_registered', /\bregist\w+\b/],
      ['maker', /\bwho made\b|\bbrand\b|\bmake\b|\bmanufacturer\b|\bmanufactured\b/], ['serial', /\bserial\b/], ['model', /\bmodel\b/],
      ['fuel', /\bgas or electric\b|\belectric or gas\b|\bfuel\b|\bpropane\b/], ['type', /\btank or tankless\b|\btankless or tank\b|\btank type\b|\btype of (?:water )?heater\b|\bis (?:it|the water heater.*) (?:a )?tankless\b/],
      ['gallons', /\bhow many gallons\b|\bgallons?\b|\bcapacity\b|\btank size\b|\bwhat size\b|\bhow big\b|\bsize\b/], ['age', /\bhow old\b|\bage\b/], ['installer', /\bwho\b.*\binstall\w*\b/], ['installed', /\binstall\w*\b/],
    ];
    const a = attrCues(CUES, q, [['w_expires', 'w_status'], ['w_status', 'w_expires']]);
    if (a === undefined || a === null) return null;
    let attr = a;
    if (attr === 'w_status' && /\bexpir\w*\b/.test(q) && !/\bstill\b|\bunder\b|\bcovered\b/.test(q)) attr = 'w_expires';
    return { kind: 'wh_fact', attr, rest: restTokens(qw, WH_VOCAB) };
  }

  // ---------------------------------------------------------------- permits and inspections
  if ((present.length === 1 && present[0] === 'permit') || (!present.length && inspWord && !bfSubject && !whSubject)) {
    const hasPermit = present.includes('permit');
    const rest0 = restTokens(qw, PM_VOCAB);
    const stage = /\brough ?in\b|\btop ?out\b/.test(q) && !/\bfinal\b/.test(q) ? 'rough' : /\bfinal\b/.test(q) && !/\brough ?in\b/.test(q) ? 'final' : /\bunderground\b/.test(q) ? 'underground' : null;
    if (/\b(?:gas|sewer|repipe|water heater|plumbing)\b.*\bpermits?\b.*\b(?:for|on)\b/.test(q) && false) return null;
    // lists
    if (hasPermit && listCue && /\bopen\b/.test(q) && !/\bexpired\b/.test(q) && !win && !/\bexpir\w*\b/.test(q)) return { kind: 'pm_list', mode: 'open', rest: rest0 };
    if (hasPermit && (listCue || /\bdo we have\b/.test(q)) && (/\bexpired\b|\bran out\b|\blapsed\b|\bpast their\b/.test(q)) && !/\bopen\b/.test(q)) return { kind: 'pm_list', mode: 'expired', rest: rest0 };
    if (hasPermit && listCue && /\bexpir\w*\b/.test(q) && win) return { kind: 'pm_list', mode: 'expiring', win, rest: restTokens(qw, [...PM_VOCAB, 'soon']) };
    if (/\binspections?\b/.test(q) && /\bfail\w*\b/.test(q) && (listCue || /\bwhich\b/.test(q)) && !hasPermit && !/\bdid\b|\bdoes\b|\bwas\b/.test(q)) return { kind: 'pm_list', mode: 'failed', rest: rest0 };
    if (hasPermit && listCue && !win && /\bopen\b|\bexpired\b/.test(q)) return null;
    // an inspection at a job
    if (inspWord && (/\bpass\w*\b|\bfail\w*\b|\bresults?\b|\bwhen\b|\bdate\b|\bstatus\b|\bget\b.*\bapproved\b|\bapproved\b/.test(q)) && !hasPermit) {
      const attr = /\bwhen\b|\bwhat date\b|\bdate\b/.test(q) && !/\bresult\b|\bpass\w*\b|\bfail\w*\b/.test(q) ? 'date' : 'result';
      return { kind: 'pm_insp', stage, attr, rest: rest0 };
    }
    if (!hasPermit) return null;
    const CUES = [
      ['jurisdiction', /\bwhich (?:office|city|agency|department)\b|\bwho issued\b|\bissued by\b|\bissuing\b|\bjurisdiction\b|\bwhat agency\b|\bwhich jurisdiction\b/], ['issued', /\bwhen\b.*\bissued\b|\bissue date\b|\bdate issued\b|\bissued on\b/],
      ['expires', /\bexpir\w*\b|\bwhen does\b.*\b(?:run out|end)\b|\bvalid (?:through|until)\b/], ['status', /\bstatus\b|\bis the permit\b.*\b(?:still )?(?:open|closed|final|active|expired)\b|\bis it (?:still )?(?:open|closed|expired)\b/],
      ['type', /\bwhat (?:type|kind) of permit\b|\bpermit type\b|\btype of permit\b|\bkind of permit\b/], ['number', /\bpermit (?:number|no|num)\b|\bwhat permit\b|\bwhich permit\b|\bpermit numbers?\b|\bnumber\b/],
    ];
    const a = attrCues(CUES, q, [['status', 'expires']]);
    if (a === undefined || a === null) return null;
    return { kind: 'pm_fact', attr: a, rest: rest0 };
  }

  // ---------------------------------------------------------------- sewer camera
  if (present.length === 1 && present[0] === 'camera' || (!present.length && /\bsewer\b|\bdrain\b/.test(q) && /\b(?:camera|inspected|inspection|scoped|video|defects?|problems?|findings?)\b/.test(q) && !inspWord) || (!present.length && /\bhow long\b.*\b(?:run|line)\b.*\binspected\b/.test(q))) {
    const rest0 = restTokens(qw, CAM_VOCAB);
    if (listCue && /\bdefects?\b|\bproblems?\b|\bissues?\b|\bdamage\w*\b|\bcracks?\b|\broots?\b/.test(q) && !/\bat\b|\bfor\b/.test(q.replace(/\bwhat\b.*\bfor\b/, ''))) return { kind: 'cam_defects', rest: rest0 };
    const CUES = [
      ['recommendation', /\brecommend\w*\b|\bwhat should\b|\badvice\b|\bnext steps?\b/], ['length', /\bhow long\b|\blength\b|\bhow far\b|\bfeet\b|\bhow many feet\b/], ['footage', /\bfootage\b|\bvideo\b|\bfile\b|\brecording\b|\bclip\b|\blink\b/],
      ['location', /\bwhich part\b|\bwhat part\b|\bwhich section\b|\bsection\b|\bportion\b|\bwhich line\b/], ['material', /\bmaterial\b/], ['date', /\bwhen\b|\bwhat date\b|\bdate\b/],
      ['findings', /\bfind\b|\bfound\b|\bfinding\w*\b|\bdefects?\b|\bshow\w*\b|\bobserv\w*\b|\bissues?\b|\bproblems?\b|\bwhat did\b|\bwrong\b|\bcondition\b|\bdamage\b/],
    ];
    const a = attrCues(CUES, q, [['findings', 'date'], ['length', 'footage'], ['recommendation', 'findings']]);
    if (a === undefined || a === null) return null;
    let attr = a; if (attr === 'date' && /\bfind\b|\bfound\b|\bdefects?\b/.test(q)) return null;
    return { kind: 'cam_fact', attr, rest: rest0 };
  }

  // ---------------------------------------------------------------- invoices, tickets, work orders, quotes, agreements, POs, dispatch
  if (present.length === 1 || (present.length === 2 && present.includes('invoice') && !present.includes('permit'))) {
    const topic = present.includes('invoice') ? 'invoice' : present[0];
    if (!['invoice', 'ticket', 'workorder', 'quote', 'agreement', 'po', 'dispatch'].includes(topic)) return null;
    const rest0 = restTokens(qw, SVC_VOCAB);
    const cost = /\bhow much\b|\bcost\b|\btotal\b|\bprice\b|\bamount\b|\bcharge\w*\b|\bcome to\b|\bcomes to\b|\bbill(?:ed|s)?\b/.test(q);
    if (topic === 'dispatch') { if (/\bwho\b/.test(q) && /\bgoing\b|\bdispatch\w*\b|\bcoming\b|\bsent\b|\bheaded\b/.test(q)) return { kind: 'svc_fact', doc: 'dispatch', attr: 'who_when', rest: restTokens(qw, [...SVC_VOCAB, 'and']) }; return null; }
    if (topic === 'invoice') {
      if (how) return null;
      if (/\bwhen\b|\bdate\b/.test(q) && !cost) return { kind: 'svc_fact', doc: 'invoice', attr: 'date', rest: rest0 };
      if (!cost) return null;
      return { kind: 'svc_fact', doc: 'invoice', attr: 'cost', rest: rest0, desc: true };
    }
    if (topic === 'ticket') {
      const CUES = [['cost', /\bhow much\b|\bcost\b|\btotal\b|\bprice\b|\bamount\b|\bcharge\w*\b/], ['who', /\bwho\b|\btechnician\b|\btech\b|\bplumber\b/], ['type', /\bwhat (?:kind|type)\b|\bkind of\b|\btype of\b/], ['date', /\bwhen\b|\bwhat date\b|\bdate\b/], ['work', /\bwhat (?:was|did)\b|\bwhat work\b|\bwork (?:performed|done)\b|\bdone\b|\bperformed\b/]];
      const a = attrCues(CUES, q, [['work', 'date']]);
      if (a === undefined || a === null) return null;
      return { kind: 'svc_fact', doc: 'ticket', attr: a, rest: rest0 };
    }
    if (topic === 'workorder') {
      const CUES = [['who', /\bwho\b|\bassigned\b|\btechnician\b|\btech\b|\bplumber\b/], ['date', /\bwhen\b|\bscheduled\b|\bwhat date\b|\bdate\b/], ['work', /\bwhat\b|\bwork\b|\bscope\b/]];
      const a = attrCues(CUES, q, [['who', 'date', 'work'], ['date', 'work']]);
      if (a === undefined || a === null) return null;
      return { kind: 'svc_fact', doc: 'workorder', attr: /\bwho\b|\bassigned\b|\btechnician\b|\btech\b/.test(q) ? 'who' : /\bwhen\b|\bwhat date\b|\bdate\b/.test(q) ? 'date' : 'work', rest: restTokens(qw, [...SVC_VOCAB, 'is']) };
    }
    if (topic === 'quote') { if (how) return null; if (cost) return { kind: 'svc_fact', doc: 'quote', attr: 'cost', rest: rest0 }; if (/\bwhat work\b|\bcover\w*\b|\bscope\b|\bwhat\b/.test(q)) return { kind: 'svc_fact', doc: 'quote', attr: 'work', rest: rest0 }; return null; }
    if (topic === 'agreement') { if (how && !/\bhow long\b/.test(q)) return null; if (/\bhow long\b|\bterm\b|\blength\b/.test(q)) return { kind: 'svc_fact', doc: 'agreement', attr: 'term', rest: rest0 }; if (/\bcover\w*\b|\bwhat\b|\bincluded?\b/.test(q)) return { kind: 'svc_fact', doc: 'agreement', attr: 'work', rest: rest0 }; return null; }
    if (topic === 'po') { if (how) return null; if (cost && !/\bwhat\b/.test(q)) return { kind: 'svc_fact', doc: 'po', attr: 'cost', rest: rest0 }; if (/\bwhat\b|\bitems?\b|\bordered\b/.test(q)) return { kind: 'svc_fact', doc: 'po', attr: 'items', rest: rest0 }; return null; }
  }
  return null;
}

export function classifyPlumbing(question, opts = {}) {
  const i = classifyInner(question, opts);
  return i ? { ...i, raw: String(question ?? '') } : null;
}

/* ------------------------------------------------------------------ run */
const coverage = (...parts) => { const s = new Set(); for (const p of parts) for (const t of toks(p)) { s.add(t); const c = canonTok(t); s.add(c); if (c === 'st') s.add('street'); } return s; };
const covers = (rest, cov) => rest.every((t) => cov.has(t) || cov.has(canonTok(t)));
const placeCov = (place, docs) => { const { sites, customers } = placeIndex(docs); return coverage(...[...place.sites].map((k) => sites.get(k)?.raw ?? ''), ...[...place.sites].map((k) => [...(sites.get(k)?.custs ?? [])].join(' ')), ...[...place.custs].map((k) => customers.get(k)?.raw ?? '')); };

export async function runPlumbing(db, intent, { today } = {}) {
  if (!intent) return null;
  if (intent.kind === 'decline') return answerEnvelope({ text: DECLINE[intent.which], facts: [], extra: { decline: true, declineKind: intent.which } });
  const docs = await loadDocs(db);
  const t0 = today && okIso(today) ? today : null;
  const rawQ = intent.raw ?? '';
  void rawQ;
  const k = intent.kind;
  if (k.startsWith('bf_')) return runBackflow(docs, intent, t0);
  if (k.startsWith('wh_')) return runHeater(docs, intent, t0);
  if (k.startsWith('pm_')) return runPermit(docs, intent, t0);
  if (k.startsWith('cam_')) return runCamera(docs, intent);
  if (k === 'svc_fact') return runService(docs, intent);
  if (k === 'count_type') return runCountType(docs, intent);
  if (k === 'attn_all') {
    if (intent.rest.length || !t0) return null;
    if (resolvePlace(docs, intent.raw).any) return null;
    const items = attentionItems(docs, t0, 60);
    const by = (c) => items.filter((i) => i.category === c).length;
    const when = (i) => (i.kind === 'failed' ? `failed ${humanDate(i.date)}; needs a retest` : i.kind === 'unreadable' ? 'result unreadable; check the document' : i.days < 0 ? `${i.category === 'backflow' ? 'overdue' : 'expired'} ${humanDate(i.date)} (${dayWord(-i.days)} ago)` : i.days === 0 ? `today, ${humanDate(i.date)}` : `${humanDate(i.date)} (${dayWord(i.days)})`);
    return answerEnvelope({ text: items.length ? `${plural(items.length, 'item')} need attention (within 60 days): ${by('backflow')} backflow, ${by('warranty')} water heater warranty, ${by('permit')} permit.` : 'None. No backflow test, water heater warranty or permit needs attention within 60 days.', facts: items.slice(0, 40).map((i) => ({ label: i.label, value: when(i), sources: [{ documentId: i.documentId, location: { field: i.category === 'permit' ? 'permit_expires' : i.category === 'warranty' ? 'warranty_expires' : i.kind === 'failed' || i.kind === 'unreadable' ? 'backflow_test_result' : 'next_test_due', page: i.page } }] })) });
  }
  return null;
}

function runCountType(docs, intent) {
  if (intent.rest.length) return null;
  const ds = docs.filter((d) => d.type === intent.type);
  return answerEnvelope({ text: `${ds.length} ${intent.noun}${ds.length === 1 ? '' : 's'} on file.`, facts: ds.slice(0, 40).map((d) => ({ label: d.filename, value: intent.noun, sources: [{ documentId: d.id, location: { field: 'document_type', page: 1 } }] })) });
}

/* ---- backflow ---- */
function runBackflow(docs, intent, t0) {
  const devs = backflowDevices(docs);
  if (!devs.length) return null;
  if (intent.kind === 'bf_count') {
    if (intent.rest.length) return null;
    if (intent.what === 'certs') { const ds = docs.filter((d) => d.type === 'backflow-test-certificate'); return answerEnvelope({ text: `${plural(ds.length, 'backflow test certificate document')} on file${devs.length !== ds.length ? ` (${plural(devs.length, 'device')}; older tests for the same device are history)` : ''}.`, facts: ds.slice(0, 40).map((d) => ({ label: d.filename, value: 'backflow test certificate', sources: [{ documentId: d.id, location: { field: 'document_type', page: 1 } }] })) }); }
    const unread = devs.filter((d) => d.status === 'other' || d.conflict);
    let sel = devs; let text;
    if (intent.what === 'failed') { sel = devs.filter((d) => d.status === 'failed' && (!intent.devKind || d.kind === intent.devKind)); text = `${plural(sel.length, `${intent.devKind ? `${intent.devKind} ` : ''}backflow device`)} failed the latest test and ${sel.length === 1 ? 'has' : 'have'} not been retested.`; }
    else if (intent.what === 'kind') { sel = devs.filter((d) => d.kind === intent.devKind); text = `${sel.length} ${intent.devKind} backflow device${sel.length === 1 ? '' : 's'} on file.`; }
    else text = `${plural(sel.length, 'backflow device')} on file.`;
    const noKind = intent.devKind ? devs.filter((d) => !d.kind).length : 0;
    if (noKind) text += ` ${plural(noKind, 'device')} with no device type printed ${noKind === 1 ? 'is' : 'are'} not included.`;
    if (intent.what !== 'devices' && unread.length) { sel = sel.filter((d) => !unread.includes(d)); text += ` ${plural(unread.length, 'device')} with an unreadable or conflicting result ${unread.length === 1 ? 'is' : 'are'} not counted.`; }
    return answerEnvelope({ text, facts: sel.slice(0, 40).map((v) => fact(devFactLabel(v), `latest test ${humanDate(v.tested)}: ${f(v.current, 'backflow_test_result')}`, v.current, 'backflow_test_result')) });
  }
  const place = resolvePlace(docs, intent.raw);
  if (place.unknown || place.conflict) return null;
  const idHit = idForms(intent.raw);
  const byId = devs.filter((v) => v.serial && idHit.has(alnum(v.serial)));
  let scope = devs;
  const cov = new Set();
  if (byId.length) { scope = byId; for (const v of byId) coverage(v.serial).forEach((t) => cov.add(t)); }
  else if (place.any) { scope = devs.filter((v) => atPlace(place, v)); placeCov(place, docs).forEach((t) => cov.add(t)); }
  if (intent.kind === 'bf_list') {
    if (place.any && !scope.length) return null;
    if (intent.maybeSingle && place.any) return runBackflow(docs, { kind: 'bf_device', attr: 'overdue', devKind: intent.devKind, rest: intent.rest, raw: intent.raw }, t0);
    if (!t0) return null;
    if (!covers(intent.rest, cov)) return null;
    const noKindList = intent.devKind ? scope.filter((v) => !v.kind) : [];
    if (intent.devKind) scope = scope.filter((v) => v.kind === intent.devKind);
    const out = bfList(scope, intent, t0, devs);
    if (noKindList.length) { out.text += ` ${plural(noKindList.length, 'device')} with no device type printed ${noKindList.length === 1 ? 'is' : 'are'} not included.`; }
    return out;
  }
  // one device
  if (!place.any && !byId.length) return null;
  if (!scope.length) return null;
  for (const v of scope) { coverage(v.make, f(v.current, 'model') ?? '', v.size, v.loc, v.kind ?? '', 'backflow', v.serial ?? '', f(v.current, 'equipment_type') ?? '').forEach((t) => cov.add(t)); }
  if (!covers(intent.rest, cov)) return null;
  const qn = ` ${norm(intent.raw)} `;
  let cand = scope;
  if (intent.devKind) { cand = cand.filter((v) => v.kind === intent.devKind); if (!cand.length) return null; }
  const makeHit = cand.filter((v) => v.make && qn.includes(` ${norm(v.make)} `)); if (makeHit.length && makeHit.length < cand.length) cand = makeHit;
  const sizeHit = cand.filter((v) => v.size && qn.includes(` ${norm(v.size)} `)); if (sizeHit.length && sizeHit.length < cand.length) cand = sizeHit;
  const locHit = cand.filter((v) => v.loc && qn.includes(` ${norm(v.loc)} `)); if (locHit.length && locHit.length < cand.length) cand = locHit;
  if (cand.length > 1 && new Set(cand.map((v) => v.addr)).size > 1) return clarify(cand.map((v) => ({ addr: v.addr, addrRaw: v.addrRaw, hint: [v.kind, v.make, v.serial ? `serial ${v.serial}` : '', v.loc].filter(Boolean).join(' ') })), 'job');
  if (cand.length > 1) {
    const opts = cand.map((v) => `${v.kind ? `${v.kind} ` : ''}${v.make} ${v.size}${v.serial ? ` serial ${v.serial}` : ''}${v.loc ? ` (${v.loc})` : ''}`.replace(/\s+/g, ' ').trim());
    return answerEnvelope({ text: `More than one backflow device matches that at ${String(cand[0].addrRaw).split(',')[0]}. Which one do you mean: ${opts.join('; ')}?`, facts: [], extra: { clarify: true, clarifyOptions: opts } });
  }
  const v = cand[0];
  if (v.status === 'other' || v.conflict) return null;
  return bfDevice(v, intent.attr, t0);
}

function bfList(scope0, intent, t0, all) {
  const bad = scope0.filter((v) => v.status === 'other' || v.conflict); // a result we cannot read is never hidden: it is listed on its own line
  const scope = scope0.filter((v) => !bad.includes(v));
  const noDue = scope.filter((v) => v.status === 'passed' && !okIso(v.due)).length;
  let pick; let head;
  const w = intent.win;
  if (intent.mode === 'failed') { pick = scope.filter((v) => v.status === 'failed'); head = `${plural(pick.length, 'backflow device')} failed the latest test and still need${pick.length === 1 ? 's' : ''} a retest`; }
  else if (intent.mode === 'overdue') { pick = scope.filter((v) => v.status === 'passed' && okIso(v.due) && v.due < t0); head = `${plural(pick.length, 'backflow test')} overdue`; }
  else if (intent.mode === 'today') { pick = scope.filter((v) => v.status === 'passed' && v.due === t0); head = `${plural(pick.length, 'backflow test')} due today`; }
  else if (intent.mode === 'due_or_overdue') { const end = windowEnd(t0, w); pick = scope.filter((v) => v.status === 'passed' && okIso(v.due) && v.due <= end); head = `${plural(pick.length, 'backflow test')} overdue or due within ${windowLabel(w)}`; }
  else { const end = windowEnd(t0, w); pick = scope.filter((v) => v.status === 'passed' && okIso(v.due) && v.due >= t0 && v.due <= end); head = `${plural(pick.length, 'backflow test')} due within ${windowLabel(w)}`; }
  if (intent.devKind) head = head.replace('backflow test', `${intent.devKind} backflow test`).replace('backflow device', `${intent.devKind} backflow device`);
  if (intent.mode !== 'failed') pick = [...pick].sort((a, b) => String(a.due).localeCompare(String(b.due)));
  const facts = pick.slice(0, 40).map((v) => {
    if (intent.mode === 'failed') return fact(devFactLabel(v), `failed ${humanDate(v.tested)}; needs a retest`, v.current, 'backflow_test_result');
    const dd = daysBetween(t0, v.due);
    return fact(devFactLabel(v), dd < 0 ? `overdue since ${humanDate(v.due)} (${dayWord(-dd)} overdue)` : dd === 0 ? `due today, ${humanDate(v.due)}` : `due ${humanDate(v.due)} (${dayWord(dd)})`, v.current, 'next_test_due');
  });
  const note = intent.mode !== 'failed' && noDue ? ` ${plural(noDue, 'passed device')} ${noDue === 1 ? 'has' : 'have'} no next test date printed, so ${noDue === 1 ? 'it is' : 'they are'} not counted.` : '';
  void all;
  const badNote = bad.length ? ` ${plural(bad.length, 'device')} ${bad.length === 1 ? 'has' : 'have'} a result that could not be read or that disagrees, so ${bad.length === 1 ? 'it is' : 'they are'} not counted here; check ${bad.length === 1 ? 'that document' : 'those documents'}.` : '';
  facts.push(...bad.slice(0, 10).map((v) => fact(devFactLabel(v), 'result unreadable; check the document', v.current, 'backflow_test_result')));
  return answerEnvelope({ text: pick.length ? `${head}. Your documents show these dates.${note}${badNote}` : `None. No ${intent.mode === 'failed' ? 'backflow devices are failed and waiting on a retest' : intent.mode === 'overdue' ? 'backflow tests are overdue' : intent.mode === 'today' ? 'backflow tests are due today' : 'backflow tests are due in that window'}${intent.devKind ? ` for ${intent.devKind} devices` : ''}.${note}${badNote}`, facts });
}

function bfDevice(v, attr, t0) {
  const c = v.current; const d = devLabel(v);
  const tf = (k) => fact(`${devFactLabel(v)} · ${k.replace(/_/g, ' ')}`, f(c, k), c, k);
  const res = f(c, 'backflow_test_result');
  switch (attr) {
    case 'due': case 'overdue': case 'retest': {
      if (v.status === 'failed') return answerEnvelope({ text: `The ${d} failed its latest test (${humanDate(v.tested)}, result: ${res}), so it needs a retest. No next test date applies until it passes.`, facts: [fact(devFactLabel(v), `${res} on ${humanDate(v.tested)}`, c, 'backflow_test_result')] });
      if (!okIso(v.due)) return null;
      if (!t0 && attr === 'overdue') return null;
      const dd = t0 ? daysBetween(t0, v.due) : null;
      const stateTxt = dd == null ? '' : dd < 0 ? ` That is ${dayWord(-dd)} overdue.` : dd === 0 ? ' That is today.' : ` That is in ${dayWord(dd)}.`;
      if (attr === 'retest') return answerEnvelope({ text: dd != null && dd < 0 ? `The ${d} passed on ${humanDate(v.tested)}, but its next test is overdue: it was due ${humanDate(v.due)}.${stateTxt}` : `It passed, so no retest is needed. The ${d} passed on ${humanDate(v.tested)}; its next test is due ${humanDate(v.due)}.${stateTxt}`, facts: [tf('next_test_due')] });
      if (attr === 'overdue') return answerEnvelope({ text: dd < 0 ? `Yes. The ${d} is overdue: its next test was due ${humanDate(v.due)} (${dayWord(-dd)} ago).` : `No. The ${d} is not overdue: its next test is due ${humanDate(v.due)}.`, facts: [tf('next_test_due')] });
      return answerEnvelope({ text: `The next test for the ${d} is due ${humanDate(v.due)}.${stateTxt}`, facts: [tf('next_test_due')] });
    }
    case 'result': return v.tested ? answerEnvelope({ text: `${d.charAt(0).toUpperCase()}${d.slice(1)}: last test result ${res}, tested ${humanDate(v.tested)}.`, facts: [tf('backflow_test_result')] }) : null;
    case 'tested': return v.tested ? answerEnvelope({ text: `The ${d} was last tested ${humanDate(v.tested)}.`, facts: [tf('service_date')] }) : null;
    case 'tester': { const t = f(c, 'technician'); if (!t) return null; const cert = f(c, 'tester_cert_number'); return answerEnvelope({ text: `${t}${cert ? ` (cert ${cert})` : ''} tested the ${d}${v.tested ? ` on ${humanDate(v.tested)}` : ''}.`, facts: [tf('technician'), ...(cert ? [tf('tester_cert_number')] : [])] }); }
    case 'cert': { const cert = f(c, 'tester_cert_number'); if (!cert) return null; return answerEnvelope({ text: `The tester${f(c, 'technician') ? ` (${f(c, 'technician')})` : ''} on the ${d} is certified under ${cert}.`, facts: [tf('tester_cert_number')] }); }
    case 'serial': { const s = f(c, 'serial_number'); if (!s) return null; return answerEnvelope({ text: `The serial number of the ${d} is ${s}.`, facts: [tf('serial_number')] }); }
    default: {
      const map = { size: ['device_size', 'size', v.get('device_size')], make: ['manufacturer', 'brand', v.get('manufacturer')], model: ['model', 'model', v.get('model')], location: ['device_location', 'location', v.get('device_location')], utility: ['water_utility', 'water utility', v.get('water_utility')], type: ['equipment_type', 'type', v.get('equipment_type')] };
      const m = map[attr]; if (!m || !m[2]) return null;
      const [key, nm, g] = m;
      const text = attr === 'location' ? `The ${v.kind ? `${v.kind} ` : ''}backflow device at ${String(v.addrRaw).split(',')[0]} is installed at: ${g.v}.` : attr === 'utility' ? `The ${d} test is filed with ${g.v}.` : `The ${nm} of the ${d} is ${g.v}.`;
      return answerEnvelope({ text, facts: [fact(`${devFactLabel(v)} · ${nm}`, g.v, g.d, key)] });
    }
  }
}

/* ---- water heaters ---- */
function runHeater(docs, intent, t0) {
  const hs = waterHeaters(docs);
  if (!hs.length) return null;
  const qn = ` ${norm(intent.raw)} `;
  const makes = [...new Set(hs.map((h) => h.make).filter(Boolean))];
  const hitMakes = makes.filter((m) => qn.includes(` ${norm(m)} `));
  const cov = new Set(); hitMakes.forEach((m) => coverage(m).forEach((t) => cov.add(t)));
  if (intent.kind === 'wh_count' || (intent.kind === 'wh_list' && intent.mode === 'attr')) {
    const fl = intent.filters ?? {}; let sel = hs;
    if (hs.some((h) => h.tankless == null && (fl.tankless || fl.tank || intent.versus)) ) return null;
    if (fl.tankless) sel = sel.filter((h) => h.tankless === true);
    if (fl.tank) sel = sel.filter((h) => h.tankless === false);
    if (fl.gas || fl.electric) { if (hs.some((h) => !h.fuel)) return null; if (fl.gas) sel = sel.filter((h) => h.fuel === 'gas'); if (fl.electric) sel = sel.filter((h) => h.fuel === 'electric'); }
    if (hitMakes.length) sel = sel.filter((h) => hitMakes.some((m) => norm(m) === norm(h.make)));
    if (intent.expired) { if (!t0 || hs.some((h) => h.regAmbiguous)) return null; sel = sel.filter((h) => h.exp && h.exp < t0); }
    if (!covers(intent.rest, cov)) return null;
    if (intent.kind === 'wh_list') {
      if (!sel.length && !Object.values(fl).some(Boolean) && !hitMakes.length) return null;
      const pretty = [fl.tankless ? 'tankless' : null, fl.tank ? 'tank' : null, fl.gas ? 'gas' : null, fl.electric ? 'electric' : null, ...hitMakes].filter(Boolean).join(' ');
      return answerEnvelope({ text: `${sel.length} ${pretty ? `${pretty} ` : ''}water heater${sel.length === 1 ? '' : 's'}.`, facts: sel.slice(0, 40).map((h) => whListFact(h, 'equipment_type')) });
    }
    if (intent.versus) { const tk = hs.filter((h) => h.tankless === false).length; const tl = hs.filter((h) => h.tankless === true).length; return answerEnvelope({ text: `${tk} tank water heater${tk === 1 ? '' : 's'} and ${tl} tankless water heater${tl === 1 ? '' : 's'}.`, facts: hs.slice(0, 40).map((h) => whListFact(h, 'equipment_type')) }); }
    if (intent.expired) return answerEnvelope({ text: `${sel.length} water heater${sel.length === 1 ? '' : 's'} ${sel.length === 1 ? 'has' : 'have'} an expired warranty (by the expiry date on the warranty registration).${hs.filter((h) => !h.reg).length ? ` ${plural(hs.filter((h) => !h.reg).length, 'water heater')} ${hs.filter((h) => !h.reg).length === 1 ? 'has' : 'have'} no warranty record on file.` : ''}`, facts: sel.slice(0, 40).map((h) => whListFact(h, 'warranty_expires', h.reg)) });
    const pretty = [fl.tankless ? 'tankless' : null, fl.tank ? 'tank' : null, fl.gas ? 'gas' : null, fl.electric ? 'electric' : null, ...hitMakes].filter(Boolean).join(' ');
    return answerEnvelope({ text: `${sel.length} ${pretty ? `${pretty} ` : ''}water heater${sel.length === 1 ? '' : 's'} on file.`, facts: sel.slice(0, 40).map((h) => whListFact(h, 'equipment_type')) });
  }
  const place = resolvePlace(docs, intent.raw);
  if (place.unknown || place.conflict) return null;
  const idHit = idForms(intent.raw);
  const byId = hs.filter((h) => h.serial && idHit.has(alnum(h.serial)));
  if (intent.kind === 'wh_list') {
    if (!t0 || place.any || byId.length || hitMakes.length) return null;
    if (hs.some((h) => h.regAmbiguous)) return null;
    if (!covers(intent.rest, cov)) return null;
    if (intent.mode === 'expired') { const sel = hs.filter((h) => h.exp && okIso(h.exp) && h.exp < t0).sort((a, b) => a.exp.localeCompare(b.exp)); return answerEnvelope({ text: sel.length ? `${plural(sel.length, 'water heater warranty', 'water heater warranties')} ${sel.length === 1 ? 'has' : 'have'} expired, by the dates on the warranty registrations. A heater with no registration on file has no warranty date.${hs.filter((h) => !h.reg).length ? ` ${plural(hs.filter((h) => !h.reg).length, 'water heater')} ${hs.filter((h) => !h.reg).length === 1 ? 'has' : 'have'} no warranty record on file.` : ''}` : `None. No water heater warranty on file has expired.${hs.filter((h) => !h.reg).length ? ` ${plural(hs.filter((h) => !h.reg).length, 'water heater')} ${hs.filter((h) => !h.reg).length === 1 ? 'has' : 'have'} no warranty record on file.` : ''}`, facts: sel.slice(0, 40).map((h) => whListFact(h, 'warranty_expires', h.reg, `expired ${humanDate(h.exp)} (${dayWord(-daysBetween(t0, h.exp))} ago)`)) }); }
    const end = windowEnd(t0, intent.win); const sel = hs.filter((h) => h.exp && okIso(h.exp) && h.exp >= t0 && h.exp <= end).sort((a, b) => a.exp.localeCompare(b.exp));
    return answerEnvelope({ text: sel.length ? `${plural(sel.length, 'water heater warranty', 'water heater warranties')} ${sel.length === 1 ? 'expires' : 'expire'} within ${windowLabel(intent.win)}${intent.win.defaulted ? ' (you gave no period, so this uses 90 days)' : ''}, by the dates on the warranty registrations.` : `None. No water heater warranty on file expires within ${windowLabel(intent.win)}.`, facts: sel.slice(0, 40).map((h) => whListFact(h, 'warranty_expires', h.reg, `expires ${humanDate(h.exp)} (${dayWord(daysBetween(t0, h.exp))})`)) });
  }
  // one heater
  let scope = hs;
  if (byId.length) { scope = byId; byId.forEach((h) => coverage(h.serial).forEach((t) => cov.add(t))); }
  else if (place.any) { scope = hs.filter((h) => (place.sites.size ? place.sites.has(h.addr) : place.custs.has(h.cust))); placeCov(place, docs).forEach((t) => cov.add(t)); }
  else return null;
  if (!scope.length) return null;
  for (const h of scope) coverage(h.make, h.model, h.serial, h.tankless ? 'tankless' : 'tank').forEach((t) => cov.add(t));
  if (!covers(intent.rest, cov)) return null;
  if (hitMakes.length) { const s2 = scope.filter((h) => hitMakes.some((m) => norm(m) === norm(h.make))); if (s2.length) scope = s2; }
  if (scope.length > 1) { const mh = scope.filter((h) => h.model && qn.includes(` ${norm(h.model)} `)); if (mh.length === 1) scope = mh; }
  if (scope.length > 1) return clarify(scope.map((h) => ({ addr: h.addr, addrRaw: h.addrRaw, hint: [h.make, h.model, h.serial ? `serial ${h.serial}` : ''].filter(Boolean).join(' ') })), 'water heater');
  return whFact(scope[0], intent.attr, t0);
}
const whListFact = (h, key, dd, value) => { const d = dd ?? h.get(key)?.d ?? h.docs[0]; return fact(`${h.make ? `${h.make} ` : ''}${h.serial ? `serial ${h.serial}` : 'water heater'}${h.addrRaw ? ` · ${String(h.addrRaw).split(',')[0]}` : ''}`, value ?? (key === 'equipment_type' ? `${h.tankless === true ? 'tankless' : h.tankless === false ? 'tank' : 'water heater'}${h.fuel ? `, ${h.fuel}` : ''}` : f(d, key)), d, key); };

function whFact(h, attr, t0) {
  const L = whLabel(h);
  const g = (k) => h.get(k);
  const mk = (nm, key) => { const x = g(key); return x ? fact(`${L} · ${nm}`, x.v, x.d, key) : null; };
  switch (attr) {
    case 'maker': { const x = mk('manufacturer', 'manufacturer'); return x ? answerEnvelope({ text: `The ${L} is made by ${h.make}.`, facts: [x] }) : null; }
    case 'serial': { const x = mk('serial number', 'serial_number'); return x ? answerEnvelope({ text: `The serial number of the ${L} is ${h.serial}.`, facts: [x] }) : null; }
    case 'model': { const x = mk('model', 'model'); return x ? answerEnvelope({ text: `The model of the ${L} is ${h.model}.`, facts: [x] }) : null; }
    case 'fuel': { const x = g('fuel_type'); if (!x || !h.fuel) return null; return answerEnvelope({ text: `The ${L} runs on ${h.fuel === 'gas' ? 'gas' : 'electricity'} (as printed: ${x.v}).`.replace(/\belectricity\b/, 'electric power'), facts: [fact(`${L} · fuel`, x.v, x.d, 'fuel_type')] }); }
    case 'type': { const x = g('equipment_type'); if (!x || h.tankless == null) return null; return answerEnvelope({ text: `The ${L} is a ${h.tankless ? 'tankless' : 'tank'} water heater (as printed: ${x.v}).`, facts: [fact(`${L} · type`, x.v, x.d, 'equipment_type')] }); }
    case 'gallons': { const x = g('gallons'); if (!x) { return h.tankless ? null : null; } const n = String(x.v).match(/\d+(?:\.\d+)?/)?.[0]; return n ? answerEnvelope({ text: `The ${L} holds ${n} gallon${n === '1' ? '' : 's'}.`, facts: [fact(`${L} · tank size`, `${n} gallon`, x.d, 'gallons')] }) : null; }
    case 'installed': case 'age': {
      const x = g('installation_date'); if (!x || !okIso(x.v)) return null;
      let age = '';
      if (attr === 'age' && t0) { const yrs = (Date.parse(`${t0}T00:00:00Z`) - Date.parse(`${x.v}T00:00:00Z`)) / (365.25 * 86400000); if (yrs >= 0) { const [iy, im, id] = x.v.split('-').map(Number); const [ty, tm, td] = t0.split('-').map(Number); let months = (ty - iy) * 12 + (tm - im) - (td < id ? 1 : 0); months = Math.max(0, months); const yy = Math.floor(months / 12); const mm = months % 12; age = months === 0 ? ' (under a month ago)' : ` (${[yy ? `${yy} year${yy === 1 ? '' : 's'}` : '', mm ? `${mm} month${mm === 1 ? '' : 's'}` : ''].filter(Boolean).join(' ')} ago)`; } }
      return answerEnvelope({ text: `The ${L} was installed ${humanDate(x.v)}${age}.`, facts: [fact(`${L} · installed`, humanDate(x.v), x.d, 'installation_date')] });
    }
    case 'installer': { const x = g('technician'); return x ? answerEnvelope({ text: `${x.v} installed the ${L}.`, facts: [fact(`${L} · installed by`, x.v, x.d, 'technician')] }) : null; }
    default: break;
  }
  // warranty: only what a registration prints
  if (!h.reg || h.regAmbiguous) return null;
  const reg = h.reg;
  if (attr === 'w_term') { const x = f(h.termReg ?? reg, 'warranty_term'); return x ? answerEnvelope({ text: `The warranty on the ${L} is ${x}.`, facts: [fact(`${L} · warranty term`, x, h.termReg ?? reg, 'warranty_term')] }) : null; }
  if (attr === 'w_registered') { const x = f(reg, 'warranty_registered_date'); return x && okIso(x) ? answerEnvelope({ text: `The warranty on the ${L} was registered ${humanDate(x)}.`, facts: [fact(`${L} · registered`, humanDate(x), reg, 'warranty_registered_date')] }) : null; }
  if (!h.exp || !okIso(h.exp)) return null;
  if (attr === 'w_expires') return answerEnvelope({ text: `The warranty on the ${L} expires ${t0 && h.exp === t0 ? 'today, ' : ''}${humanDate(h.exp)}, as printed on the warranty registration.`, facts: [fact(`${L} · warranty expires`, humanDate(h.exp), reg, 'warranty_expires')] });
  if (attr === 'w_status') {
    if (!t0) return null;
    const expired = h.exp < t0;
    return answerEnvelope({ text: expired ? `No. The warranty on the ${L} expired ${humanDate(h.exp)} (${dayWord(-daysBetween(t0, h.exp))} ago).` : `Yes. The warranty on the ${L} runs through ${humanDate(h.exp)} (${dayWord(daysBetween(t0, h.exp))} left), as printed on the warranty registration.`, facts: [fact(`${L} · warranty expires`, humanDate(h.exp), reg, 'warranty_expires')] });
  }
  return null;
}

/* ---- permits ---- */
function runPermit(docs, intent, t0) {
  const permits = permitsModel(docs, t0);
  if (!permits.length && intent.kind !== 'pm_insp') return null;
  const pf = (p, key, value, label) => fact(label ?? permitLabel(p), value, p.d, key);
  if (intent.kind === 'pm_count') {
    if (intent.rest.length) return null;
    if (!t0 && intent.mode !== 'all') return null;
    if (intent.mode !== 'all' && permits.some((p) => p.state === 'other')) return null;
    if (intent.mode === 'printed_open') {
      // what the cards print vs what the dates say: both counts, stated openly
      const printed = permits.filter((p) => /^\s*open\b/i.test(p.status ?? ''));
      const derived = printed.filter((p) => p.state === 'open');
      const late = printed.filter((p) => p.state === 'expired');
      const done = printed.filter((p) => p.state === 'finished');
      const parts = [`${derived.length} open`];
      if (late.length) parts.push(`${late.length} more ${late.length === 1 ? 'shows' : 'show'} Open but ${late.length === 1 ? 'is' : 'are'} past ${late.length === 1 ? 'its' : 'their'} expiry date (${late.map((p) => p.no).join(', ')})`);
      if (done.length) parts.push(`${done.length} more ${done.length === 1 ? 'shows' : 'show'} Open but ${done.length === 1 ? 'has' : 'have'} a passed final inspection on file (${done.map((p) => p.no).join(', ')})`);
      return answerEnvelope({ text: `${plural(printed.length, 'permit')} ${printed.length === 1 ? 'shows' : 'show'} Open status: ${parts.join('; ')}.`, facts: printed.slice(0, 40).map((p) => pf(p, 'permit_status', `printed ${p.status}${p.state === 'expired' ? `; expired ${humanDate(p.expires)}` : p.state === 'finished' ? '; finished' : '; open'}`)) });
    }
    const sel = intent.mode === 'all' ? permits : permits.filter((p) => p.state === intent.mode);
    return answerEnvelope({ text: `${plural(sel.length, 'permit')} ${intent.mode === 'all' ? 'on file' : intent.mode === 'open' ? 'open: not finished and not expired by the dates and status printed on the permits' : 'expired: past the printed expiry date and not finished'}.`, facts: sel.slice(0, 40).map((p) => pf(p, 'permit_number', `${p.state}${p.status ? `, status ${p.status}` : ''}`)) });
  }
  const place = resolvePlace(docs, intent.raw);
  if (place.unknown || place.conflict) return null;
  const cov = new Set();
  if (intent.kind === 'pm_list') {
    if (place.any) return null;
    if (!covers(intent.rest, cov)) return null;
    if (intent.mode === 'failed') {
      const rows = [];
      for (const p of permits) for (const i of p.insp) if (resultClass(f(i, 'inspection_result')) === 'failed') rows.push({ p, i });
      for (const i of docs.filter((x) => x.type === 'inspection-report' && !permits.some((p) => p.insp.includes(x)) && resultClass(f(x, 'inspection_result')) === 'failed')) rows.push({ p: null, i });
      if (docs.some((x) => x.type === 'inspection-report' && resultClass(f(x, 'inspection_result')) === 'other' && !f(x, 'inspection_result'))) return null;
      return answerEnvelope({ text: rows.length ? `${plural(rows.length, 'failed inspection')} on file.` : 'No failed inspections on file.', facts: rows.slice(0, 40).map(({ p, i }) => { const later = p ? p.insp.find((o) => o !== i && stageOf(f(o, 'inspection_type')) === stageOf(f(i, 'inspection_type')) && resultClass(f(o, 'inspection_result')) === 'passed' && String(f(o, 'service_date') ?? '') >= String(f(i, 'service_date') ?? '')) : null; return fact(`${p ? `Permit ${p.no} · ` : ''}${String(f(i, 'service_address') ?? p?.addrRaw ?? i.filename).split(',')[0]} · ${f(i, 'inspection_type') ?? 'inspection'}${f(i, 'service_date') ? ` · ${humanDate(f(i, 'service_date'))}` : ''}`, `${f(i, 'inspection_result')}${later ? ` (later passed ${humanDate(f(later, 'service_date'))})` : ''}`, i, 'inspection_result'); }) });
    }
    if (!t0) return null;
    if (permits.some((p) => p.state === 'other')) return null;
    let sel; let text;
    if (intent.mode === 'open') { sel = permits.filter((p) => p.state === 'open'); text = sel.length ? `${plural(sel.length, 'permit')} open: not finished and not expired by the dates and status printed on the permits. This reflects your documents, not the city's records.` : 'None. No permit on file is open.'; }
    else if (intent.mode === 'expired') { sel = permits.filter((p) => p.state === 'expired'); text = sel.length ? `${plural(sel.length, 'permit')} expired: past the printed expiry date (or printed as expired) and never finished.` : 'None. No permit on file has expired without being finished.'; }
    else { const end = windowEnd(t0, intent.win); sel = permits.filter((p) => p.state === 'open' && okIso(p.expires) && p.expires >= t0 && p.expires <= end); text = sel.length ? `${plural(sel.length, 'open permit')} ${sel.length === 1 ? 'expires' : 'expire'} within ${windowLabel(intent.win)}.` : `None. No open permit expires within ${windowLabel(intent.win)}.`; }
    const key = intent.mode === 'expiring' || intent.mode === 'expired' ? 'permit_expires' : 'permit_status';
    return answerEnvelope({ text, facts: sel.slice(0, 40).map((p) => { const fk = p.d.fields[key] ? key : 'permit_number'; return pf(p, fk, intent.mode === 'open' ? `${p.status ?? 'open'}${p.expires ? `; expires ${humanDate(p.expires)}` : ''}` : `${p.expires ? `${p.expires < t0 ? 'expired' : 'expires'} ${humanDate(p.expires)}` : p.status}`); }) });
  }
  if (!place.any) {
    // a permit number typed in the question
    const ids = idForms(intent.raw); const hit = permits.filter((p) => ids.has(p.key));
    if (hit.length && intent.kind === 'pm_fact') { coverage(...hit.map((p) => p.no)).forEach((t) => cov.add(t)); if (!covers(intent.rest, cov)) return null; return permitFact(hit, intent.attr, t0, pf); }
    return null;
  }
  placeCov(place, docs).forEach((t) => cov.add(t));
  if (intent.kind === 'pm_fact') {
    const sel = permits.filter((p) => atPlace(place, p));
    if (!sel.length) return null;
    if (!covers(intent.rest, cov)) return null;
    if (new Set(sel.map((p) => p.addr)).size > 1 && place.sites.size !== 1 && !place.custs.size) return clarify(sel.map((p) => ({ addr: p.addr, addrRaw: p.addrRaw, hint: `permit ${p.no}` })), 'job');
    return permitFact(sel, intent.attr, t0, pf);
  }
  if (intent.kind === 'pm_insp') {
    const sel = permits.filter((p) => atPlace(place, p));
    let insps = sel.flatMap((p) => p.insp.map((i) => ({ p, i })));
    for (const i of docs.filter((x) => x.type === 'inspection-report' && !permits.some((p) => p.insp.includes(x)) && atPlace(place, { addr: addrKey(x), cust: custKey(x) }))) insps.push({ p: null, i });
    if (!insps.length) return null;
    if (!covers(intent.rest, cov)) return null;
    if (insps.some(({ i }) => !f(i, 'inspection_result') || !f(i, 'inspection_type'))) { const bad = insps.filter(({ i }) => !f(i, 'inspection_result') || !f(i, 'inspection_type')); if (bad.length) return null; }
    if (intent.stage) insps = insps.filter(({ i }) => stageOf(f(i, 'inspection_type')) === intent.stage);
    if (!insps.length) return null;
    if (new Set(insps.map(({ p }) => p?.key ?? '')).size > 1) return null; // several permits at one job: never one headline over another permit's history
    insps.sort((a, b) => String(f(b.i, 'service_date') ?? '').localeCompare(String(f(a.i, 'service_date') ?? '')) || b.i.order - a.i.order);
    const top = insps[0].i;
    if (insps.length > 1 && f(insps[0].i, 'service_date') === f(insps[1].i, 'service_date') && f(insps[0].i, 'inspection_result') !== f(insps[1].i, 'inspection_result')) return answerEnvelope({ text: 'Your documents show different results for the same date; both are listed with their pages.', facts: insps.slice(0, 6).map(({ i }) => fact(`${f(i, 'inspection_type')} · ${humanDate(f(i, 'service_date'))}`, f(i, 'inspection_result'), i, 'inspection_result')) });
    const date = f(top, 'service_date');
    const facts = insps.slice(0, 6).map(({ i }) => fact(`${f(i, 'inspection_type')}${f(i, 'service_date') ? ` · ${humanDate(f(i, 'service_date'))}` : ''}`, f(i, 'inspection_result'), i, intent.attr === 'date' ? 'service_date' : 'inspection_result'));
    if (intent.attr === 'date') return date ? answerEnvelope({ text: `The ${f(top, 'inspection_type')} inspection was ${humanDate(date)}.`, facts }) : null;
    return answerEnvelope({ text: `${f(top, 'inspection_type')} inspection${date ? ` on ${humanDate(date)}` : ''}: ${f(top, 'inspection_result')} (newest first).`, facts });
  }
  return null;
}
function permitFact(sel, attr, t0, pf) {
  const one = sel.length === 1;
  const rows = sel.map((p) => {
    const nm = permitLabel(p);
    switch (attr) {
      case 'number': return { t: p.no, f: pf(p, 'permit_number', p.no) };
      case 'jurisdiction': return p.jur ? { t: `${p.no}: ${p.jur}`, f: pf(p, 'jurisdiction', p.jur) } : null;
      case 'expires': return p.expires && okIso(p.expires) ? { t: `${p.no} ${t0 && p.expires < t0 ? 'expired' : 'expires'} ${t0 && p.expires === t0 ? 'today, ' : ''}${humanDate(p.expires)}`, f: pf(p, 'permit_expires', humanDate(p.expires)) } : null;
      case 'issued': return p.issued && okIso(p.issued) ? { t: `${p.no} was issued ${humanDate(p.issued)}`, f: pf(p, 'permit_issued_date', humanDate(p.issued)) } : null;
      case 'type': return p.type ? { t: `${p.no} is a ${p.type} permit`, f: pf(p, 'permit_type', p.type) } : null;
      case 'status': {
        if (!t0 && p.state !== 'finished') return null;
        if (p.state === 'other') return null;
        const pr = p.status ? ` (printed status: ${p.status})` : '';
        const t = p.state === 'finished' ? `${p.no} is ${p.status && FINISHED_RE.test(p.status) ? p.status.toLowerCase() : 'finished (a passed final inspection is on file)'}` : p.state === 'expired' ? `${p.no} has expired${p.expires ? `: the permit expired ${humanDate(p.expires)}` : ''}${pr}` : `${p.no} is open${pr}: no final and not past its expiry date`;
        return { t, f: p.d.fields.permit_status ? pf(p, 'permit_status', p.state === 'finished' ? (p.status ?? 'finished') : p.state === 'expired' ? 'expired' : (p.status ?? 'open')) : pf(p, 'permit_number', p.state) };
      }
      default: return null;
    }
    void nm;
  });
  if (rows.some((r) => !r)) return null;
  const text = one ? `${rows[0].t}${attr === 'number' ? '' : ''}.` : `${plural(rows.length, 'permit')} on file for that job: ${rows.map((r) => r.t).join('; ')}.`;
  return answerEnvelope({ text: attr === 'number' && one ? `The permit number is ${rows[0].t}${sel[0].jur ? `, issued by ${sel[0].jur}` : ''}.` : text, facts: rows.map((r) => r.f) });
}

/* ---- sewer camera ---- */
function runCamera(docs, intent) {
  const cams = docs.filter((d) => d.type === 'sewer-camera-report');
  if (!cams.length) return null;
  if (intent.kind === 'cam_defects') {
    if (intent.rest.length) return null;
    const place = resolvePlace(docs, intent.raw); if (place.any || place.unknown) return null;
    const latest = new Map(); for (const d of [...cams].sort(byDate('service_date'))) latest.set(addrKey(d) || d.id, d);
    const bad = [...latest.values()].filter((d) => (d.all.line_findings ?? []).some((x) => !NO_DEFECT.test(x.value)));
    if ([...latest.values()].some((d) => !(d.all.line_findings ?? []).length)) return null; // a report with no readable findings: the normal path reads it
    return answerEnvelope({ text: bad.length ? `${plural(bad.length, 'sewer line')} with defects noted on the latest camera report.` : 'No sewer line has defects noted on its latest camera report.', facts: bad.slice(0, 40).map((d) => fact(`${String(f(d, 'service_address')).split(',')[0]}${f(d, 'service_date') ? ` · ${humanDate(f(d, 'service_date'))}` : ''}`, (d.all.line_findings ?? []).map((x) => x.value).join('; '), d, 'line_findings', d.all.line_findings[0].page)) });
  }
  const place = resolvePlace(docs, intent.raw);
  if (place.unknown || place.conflict || !place.any) return null;
  const sel = cams.filter((d) => atPlace(place, { addr: addrKey(d), cust: custKey(d) }));
  if (!sel.length) return null;
  const cov = placeCov(place, docs);
  for (const d of sel) coverage(f(d, 'line_location') ?? '', f(d, 'recommendation') ?? '').forEach((t) => cov.add(t));
  if (!covers(intent.rest, cov)) return null;
  const sites = new Set(sel.map((d) => addrKey(d)));
  if (sites.size > 1) return clarify(sel.map((d) => ({ addr: addrKey(d), addrRaw: f(d, 'service_address'), hint: f(d, 'service_date') ? `inspected ${humanDate(f(d, 'service_date'))}` : f(d, 'footage_ref') ?? '' })), 'job');
  const d = [...sel].sort(byDate('service_date')).pop();
  const earlier = sel.length > 1 ? ` (${plural(sel.length - 1, 'earlier report')} also on file)` : '';
  const when = f(d, 'service_date') ? humanDate(f(d, 'service_date')) : null;
  const where = String(f(d, 'service_address')).split(',')[0];
  const one = (nm, key, text) => (f(d, key) ? answerEnvelope({ text: `${text}${earlier}`, facts: [fact(`${where} · ${nm}`, f(d, key), d, key)] }) : null);
  switch (intent.attr) {
    case 'findings': { const all0 = d.all.line_findings ?? []; const real = all0.filter((x) => !/^\s*(?:none|n\/a|na|nil|-|no (?:other )?(?:findings?|defects?))\.?\s*$/i.test(x.value)); const fs = real.length ? real : all0; if (!fs.length) return null; return answerEnvelope({ text: `Camera inspection at ${where}${when ? ` on ${when}` : ''}: ${fs.map((x) => x.value).join('; ')}.${earlier}`, facts: fs.map((x) => ({ label: `${where} · finding`, value: x.value, sources: [{ documentId: d.id, location: { field: 'line_findings', page: x.page } }] })) }); }
    case 'date': return when ? one('inspection date', 'service_date', `The sewer line at ${where} was camera inspected ${when}.`) : null;
    case 'recommendation': return one('recommendation', 'recommendation', `Recommendation from the camera inspection at ${where}: ${f(d, 'recommendation')}.`);
    case 'footage': return one('footage file', 'footage_ref', `The footage file for the camera inspection at ${where} is ${f(d, 'footage_ref')}.`);
    case 'length': return one('length inspected', 'line_length', `The camera inspection at ${where} covered ${f(d, 'line_length')}.`);
    case 'location': return one('line inspected', 'line_location', `The part of the line inspected at ${where}: ${f(d, 'line_location')}.`);
    case 'material': return one('pipe material', 'pipe_material', `The pipe material noted at ${where} is ${f(d, 'pipe_material')}.`);
    default: return null;
  }
}

/* ---- tickets, work orders, quotes, agreements, purchase orders, dispatch notes, invoices ---- */
const SVC_TYPE = { ticket: 'service-ticket', workorder: 'work-order', quote: 'proposal-quote', agreement: 'maintenance-agreement', po: 'purchase-order', dispatch: 'dispatch-note', invoice: 'invoice' };
function runService(docs, intent) {
  const type = SVC_TYPE[intent.doc];
  const ofType = docs.filter((d) => d.type === type);
  if (!ofType.length) return null;
  const place = resolvePlace(docs, intent.raw);
  if (place.unknown || place.conflict) return null;
  const ids = idForms(intent.raw);
  const byNo = ofType.filter((d) => f(d, 'invoice_number') && ids.has(alnum(f(d, 'invoice_number'))));
  const cov = new Set(); let sel;
  if (byNo.length) { sel = byNo; byNo.forEach((d) => coverage(f(d, 'invoice_number')).forEach((t) => cov.add(t))); }
  else if (place.any) { sel = ofType.filter((d) => atPlace(place, { addr: addrKey(d), cust: custKey(d) })); placeCov(place, docs).forEach((t) => cov.add(t)); }
  else return null;
  if (!sel.length) return null;
  if (!place.any || byNo.length) { /* id-keyed */ }
  const nm = kindWord(intent.doc);
  // an invoice question that names a job: narrow by the described work
  let rest = intent.rest;
  if (intent.doc === 'invoice' && intent.attr === 'cost' && !byNo.length) {
    const wantTotal = /\b(?:total|sum|altogether|all)\b/.test(norm(intent.raw)) && !/\bfor\b.*\b(?:replacement|installation|repipe|repair|test|cleaning|extension|drain|heater|backflow|gas|irrigation)\b/.test(norm(intent.raw));
    const descTok = rest.filter((t) => !cov.has(t));
    if (descTok.length && !wantTotal) {
      const scored = sel.map((d) => ({ d, s: descTok.filter((t) => norm((d.all.work_performed ?? []).map((x) => x.value).join(' ')).split(' ').some((w) => w === t || (t.length > 4 && w.startsWith(t.slice(0, 5))))).length })).sort((a, b) => b.s - a.s);
      if (!scored.length || scored[0].s === 0) return null;
      sel = scored.filter((x) => x.s === scored[0].s).map((x) => x.d);
      descTok.forEach((t) => cov.add(t));
    } else if (!descTok.length) { /* total for the customer */ }
    rest = rest.filter((t) => !cov.has(t));
  }
  if (!covers(rest, cov)) return null;
  const sites = new Set(sel.map((d) => addrKey(d)).filter(Boolean));
  const L = (d) => `${String(f(d, 'service_address') ?? f(d, 'customer_name') ?? d.filename).split(',')[0]}`;
  if (intent.doc === 'invoice') {
    if (byNo.length) { const d = sel[sel.length - 1]; if (intent.attr === 'date') return f(d, 'service_date') ? answerEnvelope({ text: `Invoice ${f(d, 'invoice_number')} is dated ${humanDate(f(d, 'service_date'))}.`, facts: [fact(`Invoice ${f(d, 'invoice_number')} · date`, humanDate(f(d, 'service_date')), d, 'service_date')] }) : null; return f(d, 'cost') ? answerEnvelope({ text: `The total on invoice ${f(d, 'invoice_number')} is ${money(f(d, 'cost'))}${okIso(f(d, 'service_date')) ? `, dated ${humanDate(f(d, 'service_date'))}` : ''}.`, facts: [fact(`Invoice ${f(d, 'invoice_number')} · total`, money(f(d, 'cost')), d, 'cost'), ...(okIso(f(d, 'service_date')) ? [fact(`Invoice ${f(d, 'invoice_number')} · date`, humanDate(f(d, 'service_date')), d, 'service_date')] : [])] }) : null; }
    if (intent.attr === 'date') return null;
    const withCost = sel.filter((d) => f(d, 'cost'));
    if (!withCost.length || withCost.length !== sel.length) return null;
    if (place.sites.size === 0 && place.custs.size > 1) return null;
    const total = withCost.reduce((a, d) => a + Number(String(f(d, 'cost')).replace(/[$,]/g, '')), 0);
    const who = [...new Set(withCost.map((d) => f(d, 'customer_name')).filter(Boolean))];
    return answerEnvelope({ text: withCost.length === 1 ? `${withCost[0] && f(withCost[0], 'invoice_number') ? `Invoice ${f(withCost[0], 'invoice_number')}: ` : ''}${money(total)}${who.length === 1 ? ` billed to ${who[0]}` : ''}${okIso(f(withCost[0], 'service_date')) ? `, dated ${humanDate(f(withCost[0], 'service_date'))}` : ''}.` : `${plural(withCost.length, 'invoice')} on file${who.length === 1 ? ` for ${who[0]}` : ''}, totaling ${money(total)}.`, facts: withCost.slice(0, 40).flatMap((d) => [fact(`Invoice ${f(d, 'invoice_number') ?? d.filename} · ${L(d)}`, money(f(d, 'cost')), d, 'cost'), ...(withCost.length === 1 && okIso(f(d, 'service_date')) ? [fact(`Invoice ${f(d, 'invoice_number') ?? d.filename} · date`, humanDate(f(d, 'service_date')), d, 'service_date')] : [])]) });
  }
  if (intent.doc === 'po') {
    const d = sel[sel.length - 1];
    const items = d.all.part_number ?? [];
    if (intent.attr === 'cost' && !items.length) return f(d, 'cost') ? answerEnvelope({ text: `Purchase order ${f(d, 'invoice_number') ?? ''} totals ${money(f(d, 'cost'))}.`.replace('  ', ' '), facts: [fact('Purchase order · total', money(f(d, 'cost')), d, 'cost')] }) : null;
    if (!items.length) return null;
    return answerEnvelope({ text: `Purchase order ${f(d, 'invoice_number') ?? ''}: ${items.map((x) => x.value).join('; ')}${f(d, 'cost') ? `, ${money(f(d, 'cost'))}` : ''}.`.replace('  ', ' '), facts: [...items.map((x) => ({ label: 'Purchase order · item', value: x.value, sources: [{ documentId: d.id, location: { field: 'part_number', page: x.page } }] })), ...(f(d, 'cost') ? [fact('Purchase order · total', money(f(d, 'cost')), d, 'cost')] : [])] });
  }
  if (sites.size > 1 && !byNo.length) return clarify(sel.map((d) => ({ addr: addrKey(d), addrRaw: f(d, 'service_address'), hint: f(d, 'invoice_number') ?? (f(d, 'service_date') ? humanDate(f(d, 'service_date')) : '') })), 'job');
  const ordered = [...sel].sort((a, b) => String(f(a, 'service_date') ?? '').localeCompare(String(f(b, 'service_date') ?? '')) || a.order - b.order);
  const d = ordered[ordered.length - 1];
  const more = ordered.length > 1 ? ` (the latest of ${ordered.length} on file)` : '';
  const where = L(d);
  const items = d.all.work_performed ?? [];
  const workFacts = items.map((x) => ({ label: `${nm} · ${where} · work`, value: x.value, sources: [{ documentId: d.id, location: { field: 'work_performed', page: x.page } }] }));
  switch (`${intent.doc}:${intent.attr}`) {
    case 'ticket:work': case 'workorder:work': return items.length ? answerEnvelope({ text: `${intent.doc === 'ticket' ? `Service call at ${where}${f(d, 'service_date') ? ` on ${humanDate(f(d, 'service_date'))}` : ''}` : `Work order at ${where}${f(d, 'service_date') ? ` (scheduled ${humanDate(f(d, 'service_date'))})` : ''}`}: ${items.map((x) => x.value).join('; ')}.${more}`, facts: workFacts }) : null;
    case 'ticket:who': case 'workorder:who': return f(d, 'technician') ? answerEnvelope({ text: `${f(d, 'technician')} ${intent.doc === 'ticket' ? 'was the technician' : 'is assigned'} on the ${nm} at ${where}${f(d, 'service_date') ? ` (${humanDate(f(d, 'service_date'))})` : ''}.${more}`, facts: [fact(`${nm} · ${where} · technician`, f(d, 'technician'), d, 'technician')] }) : null;
    case 'ticket:date': case 'workorder:date': return f(d, 'service_date') && okIso(f(d, 'service_date')) ? answerEnvelope({ text: `The ${nm} at ${where} ${intent.doc === 'ticket' ? 'was' : 'is scheduled'} ${humanDate(f(d, 'service_date'))}.${more}`, facts: [fact(`${nm} · ${where} · date`, humanDate(f(d, 'service_date')), d, 'service_date')] }) : null;
    case 'ticket:cost': case 'quote:cost': return f(d, 'cost') ? answerEnvelope({ text: intent.doc === 'quote' ? `${f(d, 'invoice_number') ? `Proposal ${f(d, 'invoice_number')}` : 'The proposal'} comes to ${money(f(d, 'cost'))}${items.length ? `: ${items.map((x) => x.value).join('; ')}` : ''}.${more}` : `The ${nm} at ${where} was ${money(f(d, 'cost'))}.${more}`, facts: [fact(`${nm} · ${where} · total`, money(f(d, 'cost')), d, 'cost')] }) : null;
    case 'ticket:type': return f(d, 'service_type') ? answerEnvelope({ text: `The service call at ${where} was a ${f(d, 'service_type')} call.${more}`, facts: [fact(`${nm} · ${where} · service type`, f(d, 'service_type'), d, 'service_type')] }) : null;
    case 'quote:work': return items.length ? answerEnvelope({ text: `${f(d, 'invoice_number') ? `Quote ${f(d, 'invoice_number')}` : 'The quote'} covers: ${items.map((x) => x.value).join('; ')}.${more}`, facts: workFacts }) : null;
    case 'agreement:term': return f(d, 'agreement_term') ? answerEnvelope({ text: `The maintenance agreement at ${where} runs ${f(d, 'agreement_term')}.${more}`, facts: [fact(`Agreement · ${where} · term`, f(d, 'agreement_term'), d, 'agreement_term')] }) : null;
    case 'agreement:work': return items.length ? answerEnvelope({ text: `The maintenance agreement for ${f(d, 'customer_name') ?? where} covers: ${items.map((x) => x.value).join('; ')}.${more}`, facts: workFacts }) : null;
    case 'dispatch:who_when': return f(d, 'technician') && f(d, 'service_date') && okIso(f(d, 'service_date')) ? answerEnvelope({ text: `${f(d, 'technician')} is dispatched to ${where} on ${humanDate(f(d, 'service_date'))}.${more}`, facts: [fact(`Dispatch · ${where} · technician`, f(d, 'technician'), d, 'technician'), fact(`Dispatch · ${where} · date`, humanDate(f(d, 'service_date')), d, 'service_date')] }) : null;
    default: return null;
  }
}

/* ------------------------------------------------------------------ attention list */
/** Attention list (failed / overdue / due / expiring) for dashboards and digests: same definitions as the lane. */
function attentionItems(docs, today, withinDays) {
  const items = [];
  for (const v of backflowDevices(docs)) {
    const where = `${String(v.addrRaw).split(',')[0]}${v.loc ? ` (${v.loc})` : ''}`;
    if (v.status === 'other') { items.push({ kind: 'unreadable', category: 'backflow', label: `${v.kind ? `${v.kind} ` : ''}backflow test · ${where}`, date: okIso(v.tested) ? v.tested : today, days: 0, documentId: v.current.id, page: v.current.fields.backflow_test_result?.page ?? 1, note: 'unreadable result' }); continue; }
    if (v.status === 'failed') { items.push({ kind: 'failed', category: 'backflow', label: `${v.kind ? `${v.kind} ` : ''}backflow test failed · ${where}`, date: okIso(v.tested) ? v.tested : today, days: okIso(v.tested) ? Math.min(0, daysBetween(today, v.tested)) : 0, documentId: v.current.id, page: v.current.fields.backflow_test_result?.page ?? 1, note: 'needs a retest' }); continue; }
    if (v.status !== 'passed' || !okIso(v.due)) continue;
    const dd = daysBetween(today, v.due);
    if (dd <= withinDays) items.push({ kind: dd < 0 ? 'overdue' : 'due', category: 'backflow', label: `${v.kind ? `${v.kind} ` : ''}backflow test · ${String(v.addrRaw).split(',')[0]}${v.loc ? ` (${v.loc})` : ''}`, date: v.due, days: dd, documentId: v.current.id, page: v.current.fields.next_test_due?.page ?? 1 });
  }
  for (const h of waterHeaters(docs)) {
    if (!h.exp || !okIso(h.exp) || h.regAmbiguous) continue;
    const dd = daysBetween(today, h.exp);
    if (dd >= 0 && dd <= withinDays) items.push({ kind: 'expiring', category: 'warranty', label: `${h.make ? `${h.make} ` : ''}water heater warranty · ${String(h.addrRaw ?? '').split(',')[0] || h.serial}`, date: h.exp, days: dd, documentId: h.reg.id, page: h.reg.fields.warranty_expires?.page ?? 1 });
  }
  for (const p of permitsModel(docs, today)) {
    if (p.state === 'expired') { const dd = okIso(p.expires) ? daysBetween(today, p.expires) : -1; items.push({ kind: 'expired', category: 'permit', label: `Permit ${p.no} · ${String(p.addrRaw).split(',')[0]}`, date: okIso(p.expires) ? p.expires : today, days: Math.min(dd, -1), documentId: p.d.id, page: p.d.fields.permit_expires?.page ?? p.d.fields.permit_number?.page ?? 1, note: 'not finished' }); continue; }
    if (p.state === 'open' && okIso(p.expires)) { const dd = daysBetween(today, p.expires); if (dd >= 0 && dd <= withinDays) items.push({ kind: 'expiring', category: 'permit', label: `Permit ${p.no} · ${String(p.addrRaw).split(',')[0]}`, date: p.expires, days: dd, documentId: p.d.id, page: p.d.fields.permit_expires?.page ?? 1, note: 'still open' }); }
  }
  // order by urgency: failed and unreadable, then overdue / expired (most recent first), then due today / soonest
  const rank = (i) => (i.kind === 'failed' ? 0 : i.kind === 'unreadable' ? 1 : i.days < 0 ? 2 : 3);
  items.sort((a, b) => rank(a) - rank(b) || (rank(a) === 2 ? b.days - a.days : a.days - b.days));
  return items;
}
export async function plumbingAttention(db, { today, withinDays = 60 } = {}) {
  if (!today) return { items: [] };
  return { items: attentionItems(await loadDocs(db), today, withinDays) };
}
