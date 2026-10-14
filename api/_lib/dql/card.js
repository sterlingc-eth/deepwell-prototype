/**
 * dql/card.js - the per-company VOCABULARY CARD (R15). Pure; computed from the company's own stored fields, never from a list of industries.
 *
 * Input rows {k: field key, t: document type id, v: value}, the document type ids with counts, and the customer names on file. Output:
 *   kinds    type id -> {n, label, singular, plural, heads[]}         readable names for the kinds of paper
 *   fields   key -> {shape, n, distinct, types[], values[]}           the value shape of every stored field key (date, money, person, count, id, status, category, text, phone, email)
 *   alias    company key -> the key the query engine already reads    (groomer -> technician, groom_date -> service_date ...), only when ONE key fits the role
 *   roles    role -> {key, ...}                                       who is staff, which date is the visit date, which field is the status ...
 *   staffNoun / staffNouns                                            the company's own word for the staff ("groomer", "driver")
 *   moneyByKind, dateByKind                                           the money fields and the date field of each kind
 *   ambiguous                                                         roles two keys could fill: nothing is aliased, the question is released
 * A role is only filled when exactly one key fits; two fits means no alias at all (the coverage rule then releases the question).
 */

const SAMPLE = 400;
const lc = (s) => String(s ?? '').toLowerCase();
const toks = (k) => lc(k).split(/[^a-z0-9]+/).filter(Boolean);
const plural = (s) => (/(?:s|x|ch|sh)$/.test(s) ? `${s}es` : /[^aeiou]y$/.test(s) ? `${s.slice(0, -1)}ies` : `${s}s`);

const RE_DATE = /^(?:\d{4}-\d{2}-\d{2}(?:[T ].*)?|\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Z][a-z]{2,8}\.? \d{1,2},? \d{4})$/;
const RE_MONEY = /^-?\$\s?\d[\d,]*(?:\.\d{1,2})?$|^-?\d{1,3}(?:,\d{3})*\.\d{2}$|^-?\d+\.\d{2}$/;
const RE_PERSON = /^(?:Dr\.? |Mr\.? |Mrs\.? |Ms\.? )?[A-Z][a-zA-Z'.-]+(?: [A-Z][a-zA-Z'.-]+){1,2}$/;
const RE_COUNT = /^\d{1,6}$/;
const RE_RANGE = /^\d{1,2}\/\d{1,2}\/\d{2,4}\s*(?:-|to|through|–)\s*\d{1,2}\/\d{1,2}\/\d{2,4}$|^\d{4}-\d{2}-\d{2}\s*(?:to|through|–|—|-)\s*\d{4}-\d{2}-\d{2}$/;
const RE_PHONE = /^\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}$/;
const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const RE_ID = /^(?=.*\d)[A-Za-z0-9][A-Za-z0-9._/#-]{2,}$/;

/** the shape of one stored field, from its values */
export function shapeOf(values, nDocs = values.length) {
  const vs = values.map((v) => String(v ?? '').trim()).filter(Boolean);
  if (!vs.length) return { shape: 'empty', distinct: 0 };
  const distinct = new Set(vs.map(lc)).size;
  const frac = (re) => vs.filter((v) => re.test(v)).length / vs.length;
  const avgLen = vs.reduce((a, v) => a + v.length, 0) / vs.length;
  const words = vs.reduce((a, v) => a + v.split(/\s+/).length, 0) / vs.length;
  let shape;
  if (frac(RE_DATE) >= 0.8) shape = 'date';
  else if (frac(RE_EMAIL) >= 0.8) shape = 'email';
  else if (frac(RE_PHONE) >= 0.8) shape = 'phone';
  else if (frac(RE_MONEY) >= 0.8) shape = 'money';
  else if (frac(RE_COUNT) >= 0.8) shape = 'count';
  else if (frac(RE_PERSON) >= 0.75 && words <= 3.2) shape = 'person';
  else if (frac(RE_ID) >= 0.8 && words < 1.5 && distinct >= Math.min(vs.length, 8) * 0.5) shape = 'id';
  else if (distinct <= 14 && avgLen <= 28 && words <= 3 && vs.length >= distinct * 2) shape = 'category';
  else shape = 'text';
  return { shape, distinct };
}

const NOT_VISIT_DATE = new Set('expire expires expired expiry expiration due renew renews renewal valid until end ends ending term window through thru review next'.split(' '));
const INVOICE_DATE = new Set('bill billed billing invoice invoiced invoicing stmt statement record recorded issued logged paper rung dated inv posted'.split(' '));
const STATUS_KEY = new Set('status state stage outcome condition attendance result score standing disposition'.split(' '));
const STATUS_VALUES = new Set('completed complete pending open closed paid unpaid scheduled cancelled canceled no-show noshow approved denied active inactive delivered shipped received draft overdue resolved in-progress done booked confirmed passed failed pass fail excellent good fair poor present absent late excused waitlisted expired suspended assigned late'.split(' '));
const TYPE_KEY = new Set('type kind class category pkg package track course code item lane plan menu occasion size service run route'.split(' '));
const AGENT_SUFFIX = /(?:er|or|ist|ian|ant|ent|eer|man|lead|manager|coordinator|rep|agent|driver|tutor|coach|guide|officiant|chef|nurse)$/;
const VENDOR_KEY = new Set('vendor supplier purveyor reseller wholesaler distributor mill lab house stop store shop source maker brand make payee merchant'.split(' '));
const NOT_NOUN = new Set('name by id no num number ref assigned lead_by date on of the for to'.split(' '));

/** @param {{rows:{k:string,t?:string,v:any}[], docTypes?:{id:string,n:number}[], custNames?:Iterable<string>, nDocs?:number}} input */
export function buildCard({ rows = [], docTypes = [], custNames = [], nDocs = 0 } = {}) {
  const byKey = new Map();
  for (const r of rows) {
    const k = String(r.k ?? ''); if (!k || k.startsWith('_')) continue;
    let e = byKey.get(k); if (!e) { e = { n: 0, vals: [], types: new Map() }; byKey.set(k, e); }
    e.n++; if (e.vals.length < SAMPLE) e.vals.push(r.v);
    if (r.t) e.types.set(r.t, (e.types.get(r.t) ?? 0) + 1);
  }
  const cust = new Set([...custNames].map((x) => lc(x).replace(/\s+/g, ' ').trim()));
  const total = nDocs || docTypes.reduce((a, t) => a + t.n, 0) || 1;
  const fields = {};
  for (const [k, e] of [...byKey].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const s = shapeOf(e.vals);
    const f = { shape: s.shape, n: e.n, distinct: s.distinct, cover: e.n / total, types: [...e.types.keys()].sort(), typeN: Object.fromEntries([...e.types].sort((a, b) => (a[0] < b[0] ? -1 : 1))) };
    { const vs = e.vals.map((v) => String(v ?? '').trim()).filter(Boolean); if (vs.length && vs.filter((v) => RE_RANGE.test(v)).length / vs.length >= 0.8) f.range = true; } // "start - end" terms (a lease, a licence, a waiver)
    if (s.shape === 'category' || s.shape === 'person') f.values = [...new Set(e.vals.map((v) => String(v).trim()))].slice(0, 80);
    if (s.shape === 'person') { const dv = [...new Set(e.vals.map((v) => lc(v).replace(/\s+/g, ' ').trim()))]; f.custShare = dv.filter((v) => cust.has(v)).length / dv.length; }
    fields[k] = f;
  }
  const roles = {}; const alias = {}; const ambiguous = [];
  const fill = (role, cands, extra = {}) => {
    if (cands.length === 1) { roles[role] = { key: cands[0], ...extra }; alias[cands[0]] = role; } else if (cands.length > 1) ambiguous.push({ role, keys: cands });
  };
  const keys = Object.keys(fields);
  const has = (k, set) => toks(k).some((t) => set.has(t));
  // dates: the visit date and the paper (invoice) date; expiry/term dates are not either
  const dates = keys.filter((k) => fields[k].shape === 'date' && !has(k, NOT_VISIT_DATE));
  const invD = dates.filter((k) => has(k, INVOICE_DATE));
  const visD = dates.filter((k) => !invD.includes(k));
  let vis = visD; if (vis.length > 1) { const top = Math.max(...vis.map((k) => fields[k].n)); const big = vis.filter((k) => fields[k].n >= top * 0.5); vis = big.length === 1 ? big : vis; }
  fill('service_date', vis);
  fill('invoice_date', invD.length > 1 ? [] : invD);
  // staff: the person-shaped key that sits on the visit papers (a supplier's name sits on order papers) and whose values are not the customers
  const visTypes = new Set(vis.length === 1 ? fields[vis[0]].types : []);
  const overlap = (k) => (visTypes.size ? fields[k].types.filter((t) => visTypes.has(t)).length / Math.max(1, fields[k].types.length) : 1);
  const people = keys.filter((k) => fields[k].shape === 'person' && fields[k].custShare < 0.8 && fields[k].distinct >= 2 && !has(k, VENDOR_KEY) && overlap(k) >= 0.5);
  let staff = people;
  if (staff.length > 1) { const named = staff.filter((k) => toks(k).some((t) => AGENT_SUFFIX.test(t))); if (named.length === 1) staff = named; }
  fill('technician', staff);
  // status: a short word list whose key says so (or whose values are status words); category keys that say "type/kind/class" are the service type
  const cats = keys.filter((k) => fields[k].shape === 'category' && fields[k].distinct >= 2 && fields[k].distinct <= 12);
  const statusVals = (k) => { const v = fields[k].values ?? []; return v.filter((x) => STATUS_VALUES.has(lc(x).replace(/\s+/g, '-'))).length / Math.max(1, v.length); };
  let st = cats.filter((k) => has(k, STATUS_KEY));
  if (!st.length) st = cats.filter((k) => statusVals(k) >= 0.6);
  fill('status', st);
  const stKey = roles.status?.key;
  const svc = cats.filter((k) => k !== stKey && has(k, TYPE_KEY) && !has(k, STATUS_KEY) && statusVals(k) < 0.4);
  fill('service_type', svc);
  // money fields and the date field, per kind of paper
  const moneyByKind = {}; const dateByKind = {};
  for (const k of keys) {
    for (const t of fields[k].types) {
      if (fields[k].shape === 'money') (moneyByKind[t] ??= []).push(k);
      if (fields[k].shape === 'date' && !has(k, NOT_VISIT_DATE)) (dateByKind[t] ??= []).push(k);
    }
  }
  // the company's own word for the staff: the agent-noun in the key's name ("drop_driver" -> driver, "groomer" -> groomer)
  let staffNoun = null;
  const sk = roles.technician?.key;
  if (sk) {
    const ts = toks(sk).filter((t) => !NOT_NOUN.has(t) && t.length >= 4);
    const agent = ts.filter((t) => AGENT_SUFFIX.test(t));
    staffNoun = agent.length ? agent[agent.length - 1] : null;
    if (staffNoun && staffNoun.length > 12) staffNoun = null;
  }
  // kinds of paper
  const kinds = {};
  for (const t of docTypes) {
    const parts = String(t.id).split('-').filter(Boolean);
    const label = parts.join(' ');
    const last = parts[parts.length - 1] ?? label;
    const ofAt = parts.findIndex((p, i) => i > 0 && (p === 'of' || p === 'for' || p === 'to'));
    const pl = ofAt > 0 ? parts.map((p, i) => (i === ofAt - 1 ? plural(p) : p)) : [...parts.slice(0, -1), plural(last)];
    kinds[t.id] = { n: t.n, label, singular: label, plural: pl.join(' '), heads: parts.filter((p) => p.length >= 3 && !['for', 'and', 'the'].includes(p)) };
  }
  const customerKeys = keys.filter((k) => fields[k].shape === 'person' && fields[k].custShare >= 0.8); // person fields whose values are the customers on file (the customer side)
  const nv = nounVocab({ kinds, fields, roles, keys, customerKeys, has });
  return { version: 2, kinds, fields, alias, roles, ambiguous, customerKeys, staffNoun, staffNouns: staffNoun ? [staffNoun, plural(staffNoun)] : [], moneyByKind, dateByKind, ...nv };
}

/* ---- R25: which nouns name a kind of PAPER and which name a VISIT / EVENT, for THIS company, from its own records ---------------------------------------------------------------------------
 * A kind id such as "compounded-rx-fill", "showing-feedback-form" or "health-inspection" carries a word that is not a paper word (fill, showing, inspection): the company's own name for the work done.
 * The visits are the papers that carry the visit date. Someone who says "fills" or "inspections" may mean the papers of that kind or every visit; the two answers are the same only when the
 * visits ARE exactly the papers of the kinds that carry the word. Anything else is ambiguous, and the card says so (nouns[w].ambiguous), so the engine releases instead of guessing. */
export const PAPER_FORM = new Set('report form record note log ticket order invoice receipt statement agreement contract permit certificate letter estimate quote quotation proposal bill binder policy sheet waiver application request notice summary plan schedule card file document paper slip manifest consent authorization checklist survey questionnaire disclosure addendum amendment affidavit voucher memo email copy scan photo license licence lease deed title cert coverage quotes sheets forms'.split(' '));
const GENERIC_WORD = new Set('with from that this have been will your their other into over than then also only each some many most more less here there when what which where after before about during within without under between across such very'.split(' '));
/** the key a word is matched under: lower case, plural folded, cut to six letters so install / installs / installation and delivery / deliverys / deliveries meet */
export function nounKey(w) {
  let s = lc(w).replace(/[^a-z]/g, ''); if (s.length < 4) return '';
  s = s.replace(/ies$/, 'y').replace(/ys$/, 'y').replace(/(ch|sh|x|ss)es$/, '$1').replace(/([^s])s$/, '$1');
  return s.slice(0, 6);
}
function nounVocab({ kinds, fields, roles, keys, customerKeys, has }) {
  const vk = roles.service_date?.key ?? null; const dated = (t) => (vk ? fields[vk]?.typeN?.[t] ?? 0 : 0);
  const visitKinds = vk ? Object.keys(kinds).filter((t) => dated(t) > 0) : [];
  const visitN = visitKinds.reduce((a, t) => a + dated(t), 0);
  const words = {}; // key -> {w, kinds[]}
  for (const [id] of Object.entries(kinds)) {
    for (const tok of String(id).split('-')) {
      if (tok.length < 4 || PAPER_FORM.has(tok) || GENERIC_WORD.has(tok)) continue;
      const key = nounKey(tok); if (!key) continue;
      const e = (words[key] ??= { w: tok, kinds: [] }); if (!e.kinds.includes(id)) e.kinds.push(id);
    }
  }
  const nouns = {};
  for (const [key, e] of Object.entries(words)) {
    const ks = e.kinds.slice().sort(); const inV = ks.filter((t) => dated(t) > 0);
    // the same answer either way: every visit is a paper of a kind that carries the word, and every such paper is a visit
    const exact = !!vk && visitKinds.length > 0 && visitKinds.every((t) => ks.includes(t)) && ks.every((t) => dated(t) >= (kinds[t].n ?? 0) && (kinds[t].n ?? 0) > 0);
    nouns[key] = { w: e.w, kinds: ks, visitKinds: inV, exact, ambiguous: !exact, conf: exact ? 1 : inV.length ? 0.4 : 0.5, why: exact ? 'the visits are exactly these papers' : inV.length ? 'a visit word and a paper word at once: the papers of this kind are only some of the visits' : 'the word names the work done, not only a kind of paper' };
  }
  const entityKinds = {
    customer: { keys: customerKeys },
    staff: { keys: roles.technician ? [roles.technician.key] : [] },
    vendor: { keys: keys.filter((k) => has(k, VENDOR_KEY) && fields[k].shape !== 'money' && fields[k].shape !== 'date') },
    equipment: { keys: keys.filter((k) => toks(k).some((t) => /^(?:equipment|unit|asset|vehicle|machine|appliance|serial|model|plate|vin)$/.test(t))) },
  };
  const fieldLabels = Object.fromEntries(keys.map((k) => [k, { label: toks(k).join(' '), shape: fields[k].shape, n: fields[k].n }]));
  return { nouns, visit: { key: vk, kinds: visitKinds, n: visitN }, entityKinds, fieldLabels };
}

/** the card as role vocabulary for the learned reader's slot filler: words -> role, with confidence and ambiguity flags */
export function roleVocabulary(card) {
  const doc = {}; const visit = {}; const ambiguous = [];
  for (const [id, k] of Object.entries(card?.kinds ?? {})) for (const p of [k.label, k.plural]) doc[p] = { role: 'DT', kind: id, conf: 1 };
  for (const [key, n] of Object.entries(card?.nouns ?? {})) {
    for (const f of [n.w, plural(n.w)]) { visit[f] = { role: n.exact ? 'DT_OR_VISIT' : 'VISIT_OR_DT', kinds: n.kinds, conf: n.conf, ambiguous: n.ambiguous }; if (n.ambiguous) ambiguous.push(f); }
  }
  return { doc, visit, ambiguous, staff: card?.staffNouns ?? [], entityKinds: card?.entityKinds ?? {}, fieldLabels: card?.fieldLabels ?? {} };
}

/** field-key renamer for the snapshot: company key -> the key the engine reads; a key the company already stores under the engine's own name is never overwritten */
export function aliasMap(card, storedKeys) {
  const out = new Map(); if (!card?.alias) return out;
  const stored = new Set(storedKeys);
  const taken = new Set();
  for (const [k, role] of Object.entries(card.alias)) {
    if (k === role) continue;
    if (stored.has(role) || taken.has(role)) continue;
    out.set(k, role); taken.add(role);
  }
  return out;
}
