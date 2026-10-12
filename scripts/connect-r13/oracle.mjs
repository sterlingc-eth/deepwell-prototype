/**
 * connect-r13 oracle - INDEPENDENT of the DQL code: reads a company export (JSON) and writes
 *   gen   <export.json> <out.json>     the shape-set questions with the expected answer computed here, from the raw rows
 *   score <gen.json> <answers.json>    scores askx/dev answers (right / model / wrong)
 * Link rules (the same ones the product states in its basis line):
 *   - a paper belongs to a person when exactly one customer record is linked to it (directly, or through the customer's asset)
 *   - the date of a paper is its service date, else its invoice date, else the day it was filed
 *   - A turned into B: a B paper for the same person (same job key when both carry one) dated on or after A, within the window (90 days);
 *     each B counts toward the closest earlier A of the same person
 *   - a B with no matching A: no A for the same person within the window either side
 */
import fs from 'node:fs';
const [mode, f1, f2] = process.argv.slice(2);
const TODAY = '2026-10-07';
const DAYMS = 86400000;
const dn = (iso) => Math.round(Date.parse(iso + 'T00:00:00Z') / DAYMS);
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * DAYMS).toISOString().slice(0, 10);
const pad = (n) => String(n).padStart(2, '0');
const toIso = (v) => { const t = String(v ?? '').trim(); let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t); if (m) return `${m[1]}-${m[2]}-${m[3]}`; m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t); return m ? `${m[3]}-${pad(m[1])}-${pad(m[2])}` : null; };
const WORD = { 'proposal-quote': 'quote', invoice: 'invoice', 'purchase-order': 'purchase order', 'work-order': 'work order', 'service-ticket': 'service ticket', agreement: 'agreement', 'maintenance-agreement': 'maintenance agreement', receipt: 'receipt', permit: 'permit', 'inspection-report': 'inspection report', 'lease-agreement': 'lease agreement', 'dispatch-note': 'dispatch note', statement: 'statement', schedule: 'schedule' };
const word = (t) => WORD[t] ?? t.replace(/-/g, ' ');

function load(path) {
  const t = JSON.parse(fs.readFileSync(path, 'utf8'));
  const ents = new Map((t.entities ?? []).filter((e) => !e.merged_into).map((e) => [e.id, e]));
  const fields = new Map();
  for (const x of [...(t.extractions ?? [])].sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')))) {
    const v = String(x.corrected_value ?? x.value ?? '').trim(); if (!v || !x.field_key) continue;
    if (!fields.has(x.document_id)) fields.set(x.document_id, {});
    fields.get(x.document_id)[x.field_key] = v;
  }
  const fin = new Map((t.financials ?? []).map((f) => [f.document_id, f]));
  const custs = new Map();
  for (const l of t.document_entity_links ?? []) {
    const e = ents.get(l.entity_id); if (!e) continue;
    const c = e.entity_type === 'customer' ? e.id : e.entity_type === 'equipment' && e.customer_id && ents.get(e.customer_id) ? e.customer_id : null;
    if (!c) continue;
    if (!custs.has(l.document_id)) custs.set(l.document_id, new Set());
    custs.get(l.document_id).add(c);
  }
  const lines = new Map();
  for (const l of t.financial_lines ?? []) { if (!l.description) continue; if (!lines.has(l.document_id)) lines.set(l.document_id, []); lines.get(l.document_id).push(l.description); }
  const docs = [];
  for (const d of t.documents) {
    const type = String(d.document_type).toLowerCase().replace(/_/g, '-');
    const f = fields.get(d.id) ?? {};
    if (type === 'hr-letter' || f._audience === 'internal') continue;
    const cs = custs.get(d.id); const cid = cs && cs.size === 1 ? [...cs][0] : null;
    const fr = fin.get(d.id);
    const date = toIso(f.service_date) ?? toIso(f.invoice_date) ?? toIso(fr?.invoice_date) ?? toIso(d.created_at);
    const status = f.status ?? (fr && fr.status !== 'unknown' ? fr.status : null);
    docs.push({ id: d.id, type, f, cid, cname: cid ? ents.get(cid).data.customer_name : null, date, jk: fr?.job_key ?? null, total: fr?.total != null ? Number(fr.total) : null, status, tech: f.technician ?? null,
      label: f.invoice_number ?? f.po_number ?? f.permit_number ?? d.original_filename, text: [f.work_performed, f.notes, ...(lines.get(d.id) ?? [])].filter(Boolean) });
  }
  return { t, ents, docs, fin };
}

const same = (a, b) => (a.jk && b.jk ? a.jk === b.jk && (a.cid === b.cid || !a.cid || !b.cid) : Boolean(a.cid) && a.cid === b.cid);
const tied = (d) => Boolean(d.cid || d.jk);
function chain(docs, A, B, W, dir) {
  const As = docs.filter((d) => d.type === A && tied(d) && d.date); const Bs = docs.filter((d) => d.type === B && tied(d) && d.date);
  const aAllDated = As;
  const linked = new Set();
  if (dir === 'forward') {
    for (const b of Bs) {
      const cs = aAllDated.filter((x) => same(x, b) && x.date <= b.date && dn(b.date) - dn(x.date) <= W);
      const top = cs.reduce((m, a) => (a.date > m ? a.date : m), '');
      for (const a of cs) if (a.date === top) linked.add(a.id);
    }
  } else for (const a of As) if (Bs.some((b) => same(a, b) && Math.abs(dn(a.date) - dn(b.date)) <= W)) linked.add(a.id);
  return { As, yes: As.filter((a) => linked.has(a.id)), no: As.filter((a) => !linked.has(a.id)) };
}

/** a chain is only answerable when the rule links papers in this company's data: no (or almost no) ordered links anywhere means release */
const degenerate = (docs, A, B, dir) => { const f = chain(docs, A, B, Infinity, dir); const ord = chain(docs, A, B, Infinity, dir === 'around' ? 'around' : 'forward'); const n = ord.As.length; return n >= 3 && ord.yes.length <= (n >= 20 ? Math.floor(n * 0.02) : 0) && f; };

/* text search (own implementation) */
const STOP = new Set('the and for with was were this that from have has had are not but all out new old per one two three into onto over under after before also about only some more less than then them they their there been being very just done made each other what when where which while will would could should may might can any off own same such too use used via did does'.split(' '));
const tok = (s) => String(s).toLowerCase().replace(/['’]/g, '').match(/[a-z0-9]+/g) ?? [];
const NEG = new Set('no not none never without nor neither cannot cant dont doesnt didnt wasnt isnt arent werent wont couldnt wouldnt hasnt havent negative free zero absent nothing nobody lacks lacking lack'.split(' '));
const stem = (w) => { let x = w; if (x.length > 4 && x.endsWith('ies')) x = x.slice(0, -3) + 'y'; else if (x.length > 3 && x.endsWith('s') && !x.endsWith('ss')) x = x.slice(0, -1); if (x.length > 5 && x.endsWith('ing')) x = x.slice(0, -3); else if (x.length > 4 && x.endsWith('ed')) x = x.slice(0, -2); if (x.length > 4 && x.endsWith('e')) x = x.slice(0, -1); return x; };
function mentions(d, term) {
  const ts = tok(term).map(stem);
  for (const line of d.text) {
    for (const clause of String(line).split(/[,;:.!?()\n]|\s[-–—]\s|\bbut\b/i)) {
      const ws = tok(clause); const ss = ws.map(stem);
      for (let i = 0; i + ts.length <= ss.length; i++) {
        if (ts.every((x, k) => ss[i + k] === x)) {
          let neg = false; for (let j = Math.max(0, i - 4); j < i; j++) if (NEG.has(ws[j])) neg = true;
          for (let j = i + ts.length; j <= Math.min(ws.length - 1, i + ts.length + 1); j++) if (['not', 'none', 'free', 'absent', 'negative'].includes(ws[j])) neg = true;
          if (!neg) return true;
        }
      }
    }
  }
  return false;
}

function gen(path) {
  const load0 = load(path); const { docs, ents } = load0;
  const out = [];
  const byType = {}; for (const d of docs) (byType[d.type] ??= []).push(d);
  const types = Object.keys(byType).filter((t) => byType[t].length >= 8 && byType[t].filter((d) => d.cid && d.date).length >= 8);
  // pairs ranked by how many people have both kinds
  const pairs = [];
  for (const A of types) for (const B of types) {
    if (A === B) continue;
    const ca = new Set(byType[A].map((d) => d.cid).filter(Boolean)); const both = new Set(byType[B].map((d) => d.cid).filter((c) => c && ca.has(c)));
    if (both.size >= 5) pairs.push({ A, B, score: both.size });
  }
  pairs.sort((x, y) => y.score - x.score || (x.A + x.B).localeCompare(y.A + y.B));
  const used = []; for (const p of pairs) { if (used.length >= 3) break; if (!used.some((u) => u.A === p.A && u.B === p.B)) used.push(p); }
  const listQ = (q, shape, sel, total, extra = {}, pool = null) => { const ids = new Set(sel.map((d) => d.label)); out.push({ q, shape, kind: 'list', ids: [...ids], n: sel.length, total, notIds: pool ? [...new Set(pool.map((d) => d.label))].filter((l) => !ids.has(l)) : [], ...extra }); };
  for (const { A, B } of used) {
    const W = Infinity;
    const f = chain(docs, A, B, W, 'forward');
    const a = word(A); const b = word(B);
    if (degenerate(docs, A, B, 'forward')) {
      for (const [q, shape] of [[`Which ${a}s turned into ${b}s?`, 'chain-yes'], [`Which ${a}s never turned into ${b}s?`, 'chain-no'], [`How many ${a}s turned into ${b}s?`, 'chain-count'], [`What percent of ${a}s became ${b}s?`, 'chain-share'], [`Which ${a}s turned into ${b}s within 30 days?`, 'chain-window']]) out.push({ q, shape, kind: 'release' });
      const o0 = chain(docs, B, A, W, 'around');
      listQ(`${b[0].toUpperCase() + b.slice(1)}s with no matching ${a}`, 'orphan', o0.no, o0.As.length, {}, o0.As);
      continue;
    }
    listQ(`Which ${a}s turned into ${b}s?`, 'chain-yes', f.yes, f.As.length, {}, f.As);
    listQ(`Which ${a}s never turned into ${b}s?`, 'chain-no', f.no, f.As.length, {}, f.As);
    out.push({ q: `How many ${a}s turned into ${b}s?`, shape: 'chain-count', kind: 'count', n: f.yes.length, total: f.As.length });
    out.push({ q: `What percent of ${a}s became ${b}s?`, shape: 'chain-share', kind: 'share', n: f.yes.length, total: f.As.length, pct: Math.round((f.yes.length / Math.max(1, f.As.length)) * 1000) / 10 });
    const w30 = chain(docs, A, B, 30, 'forward');
    listQ(`Which ${a}s turned into ${b}s within 30 days?`, 'chain-window', w30.yes, w30.As.length, {}, w30.As);
    const o = chain(docs, B, A, W, 'around');
    listQ(`${b[0].toUpperCase() + b.slice(1)}s with no matching ${a}`, 'orphan', o.no, o.As.length, {}, o.As);
  }
  // billed verbs when invoices exist
  if (byType.invoice) for (const A of types.filter((t) => t !== 'invoice').slice(0, 2)) {
    const f = chain(docs, A, 'invoice', Infinity, 'forward');
    if (f.As.length >= 5 && degenerate(docs, A, 'invoice', 'forward')) out.push({ q: `Which ${word(A)}s never got billed?`, shape: 'never-billed', kind: 'release' });
    else if (f.As.length >= 5) listQ(`Which ${word(A)}s never got billed?`, 'never-billed', f.no, f.As.length, {}, f.As);
  }
  // text sequences
  const cnt = new Map();
  for (const d of docs) for (const line of d.text) for (const w of new Set(tok(line))) if (w.length >= 5 && !STOP.has(w) && !/\d/.test(w)) cnt.set(w, (cnt.get(w) ?? 0) + 1);
  const common = [...cnt.entries()].filter(([, n]) => n >= 8).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([w]) => w);
  const withCust = (term) => docs.filter((d) => d.cid && d.date && mentions(d, term));
  for (let i = 0; i < Math.min(3, common.length - 1); i++) {
    const w1 = common[i]; const w2 = common[i + 1];
    const A = withCust(w1); const B = withCust(w2);
    const hit = new Map();
    for (const a of A) for (const b of B) if (b.id !== a.id && same(a, b) && b.date > a.date && dn(b.date) - dn(a.date) <= 90) { if (!hit.has(a.cid)) hit.set(a.cid, a.cname); }
    out.push({ q: `Who had ${w1} and then ${w2} within 90 days?`, shape: 'seq-people', kind: 'people', names: [...hit.values()], n: hit.size });
  }
  if (byType.invoice) for (let i = 0; i < Math.min(3, common.length); i++) {
    const w = common[i]; const X = 5000;
    const A = withCust(w).filter((d) => d.type !== 'invoice'); const B = docs.filter((d) => d.type === 'invoice' && d.cid && d.date && d.total != null && d.total > X);
    const sel = A.filter((a) => B.some((b) => same(a, b) && b.date >= a.date));
    out.push({ q: `Jobs mentioning ${w} later billed over $${X}`, shape: 'seq-billed', kind: 'list', ids: sel.map((d) => d.label), n: sel.length, total: null, allowZeroPhrase: true });
  }
  // ending soon + status
  const endOf = (d) => { const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*(?:-|to|through|–)\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/i.exec(d.f.agreement_term ?? ''); if (m) return `${m[6]}-${pad(m[4])}-${pad(m[5])}`; return toIso(d.f.lease_end_date) ?? toIso(d.f.coi_expires) ?? toIso(d.f.expiration_date) ?? toIso(d.f.expires) ?? toIso(d.f.end_date); };
  const endTypes = types.filter((t) => byType[t].some((d) => endOf(d)));
  for (const A of endTypes.slice(0, 2)) for (const B of types.filter((t) => t !== A && byType[t].some((d) => d.status)).slice(0, 2)) {
    const sts = [...new Set(byType[B].map((d) => d.status).filter(Boolean))];
    for (const st of sts.slice(0, 1)) {
      const to = addDays(TODAY, 90);
      const ending = byType[A].filter((d) => { const e = endOf(d); return e && e >= TODAY && e <= to && d.cid; });
      const sel = ending.filter((a) => byType[B].some((b) => b.cid === a.cid && String(b.status).toLowerCase() === st.toLowerCase()));
      out.push({ q: `Which ${word(A)}s end soon whose holders have ${st.toLowerCase()} ${word(B)}s?`, shape: 'ending', kind: 'list', ids: sel.map((d) => d.label), n: sel.length, total: ending.length, notIds: ending.filter((d) => !sel.includes(d)).map((d) => d.label) });
    }
  }
  // served after a term ended
  { const eqs = [...ents.values()].filter((e) => e.entity_type === 'equipment' && e.data?.warranty && /^\d{4}-\d{2}-\d{2}/.test(String(e.data.warranty.expires ?? '')));
    if (eqs.length) {
      const exp = new Map(eqs.map((e) => [e.id, String(e.data.warranty.expires).slice(0, 10)]));
      const dUnit = new Map();
      for (const l of load0.t.document_entity_links ?? []) if (exp.has(l.entity_id)) { if (!dUnit.has(l.document_id)) dUnit.set(l.document_id, new Set()); dUnit.get(l.document_id).add(l.entity_id); }
      const hit = new Set();
      for (const d of docs) { const us = dUnit.get(d.id); const sd = toIso(d.f.service_date); if (us && us.size === 1 && sd) { const u = [...us][0]; if (sd > exp.get(u)) hit.add(u); } }
      const serials = [...hit].map((u) => ents.get(u).data.serial_number);
      out.push({ q: 'Which units were serviced after their warranty ended?', shape: 'after-unit', kind: 'list', ids: serials, n: hit.size, total: eqs.length, notIds: [] });
      out.push({ q: 'How many units were serviced after their warranty ended?', shape: 'after-unit-count', kind: 'count', n: hit.size, total: eqs.length });
    } }
  for (const A of endTypes.slice(0, 2)) {
    const hit = new Map();
    for (const a of byType[A]) { const e = endOf(a); if (!e || !a.cid || e >= TODAY) continue; for (const v of docs) if (v.cid === a.cid && v.type !== A && toIso(v.f.service_date) && toIso(v.f.service_date) > e) { const c = hit.get(a.cid); if (!c || e > c.e) hit.set(a.cid, { e, name: a.cname }); } }
    out.push({ q: `Which customers were serviced after their ${word(A)} ended?`, shape: 'after-cust', kind: 'people', names: [...hit.values()].map((x) => x.name), n: hit.size });
  }
  // people across papers (existing capability, measured too)
  { const techDocs = {}; for (const d of docs) if (d.tech && d.cid) (techDocs[d.tech] ??= []).push(d);
    const tt = Object.entries(techDocs).sort((x, y) => y[1].length - x[1].length || x[0].localeCompare(y[0])).slice(0, 2);
    for (const [t, ds] of tt) { const cc = {}; for (const d of ds) cc[d.cname] = (cc[d.cname] ?? 0) + 1; const names = Object.keys(cc).filter((k) => cc[k] >= 2); out.push({ q: `Which customers has ${t} seen more than once?`, shape: 'staff-repeat', kind: 'people', names, n: names.length }); }
    const cs = {}; for (const d of docs) if (d.cid && d.tech) (cs[d.cname] ??= new Set()).add(d.tech);
    const nameCount = {}; for (const e of ents.values()) if (e.entity_type === 'customer') nameCount[e.data.customer_name] = (nameCount[e.data.customer_name] ?? 0) + 1;
    const cn = Object.entries(cs).filter(([c]) => nameCount[c] === 1).sort((x, y) => y[1].size - x[1].size || x[0].localeCompare(y[0])).slice(0, 2);
    for (const [c, ts] of cn) out.push({ q: `Which staff worked for ${c}?`, shape: 'staff-for', kind: 'people', names: [...ts], n: ts.size }); }
  // which job is a paper for
  { const numCount = {}; for (const d of docs) for (const v of [d.f.invoice_number, d.f.po_number, d.f.permit_number]) if (v) numCount[v.toLowerCase().replace(/[^a-z0-9]/g, '')] = (numCount[v.toLowerCase().replace(/[^a-z0-9]/g, '')] ?? 0) + 1;
    const nk = (v) => String(v).toLowerCase().replace(/[^a-z0-9]/g, '');
    const withNum = docs.filter((d) => d.f.invoice_number && numCount[nk(d.f.invoice_number)] === 1 && /^[A-Za-z]{1,6}-?\d{2,}/.test(d.f.invoice_number));
    const picks = [...withNum.filter((d) => d.jk).slice(0, 2), ...withNum.filter((d) => !d.jk && d.cid).slice(0, 1)];
    for (const d of picks) {
      const sibs = d.jk ? docs.filter((o) => o.jk === d.jk) : docs.filter((o) => o.cid === d.cid);
      out.push({ q: `Which job was ${d.f.invoice_number} for?`, shape: 'job', kind: 'job', must: [d.f.invoice_number, d.jk ? `job ${d.jk}` : 'carries no job key', `${sibs.length} papers`], n: sibs.length });
    }
  }
  // addresses
  const streetKey = (a) => String(a ?? '').split(',')[0].replace(/\b(?:apt|apartment|unit|suite|ste|bldg|building|#)\s*[\w-]+/ig, ' ').toLowerCase().replace(/[.']/g, '').split(/[^a-z0-9]+/).filter(Boolean).join(' ');
  const byStreet = new Map();
  for (const e of ents.values()) if (e.entity_type === 'customer' && e.data.service_address && /^\d/.test(e.data.service_address)) { const k = streetKey(e.data.service_address); if (!byStreet.has(k)) byStreet.set(k, []); byStreet.get(k).push(e); }
  const addrs = [...byStreet.entries()].filter(([, v]) => v.length >= 1).sort((x, y) => y[1].length - x[1].length || x[0].localeCompare(y[0]));
  const multi = addrs.filter(([, v]) => v.length >= 2).slice(0, 2); const single = addrs.filter(([, v]) => v.length === 1).slice(0, 1);
  for (const [k, v] of [...multi, ...single]) {
    const street = String(v[0].data.service_address).split(',')[0].replace(/\s+(?:apt|apartment|unit|suite|ste|#)\s*[\w-]+$/i, '').trim();
    out.push({ q: `Who else is at ${street}?`, shape: 'address-people', kind: 'people', names: v.map((e) => e.data.customer_name), n: v.length });
    const ids = new Set(v.map((e) => e.id));
    const yrs = {}; for (const d of docs) if (d.cid && ids.has(d.cid) && d.date) (yrs[d.date.slice(0, 4)] ??= []).push(d);
    const y = Object.keys(yrs).sort((a, b) => yrs[b].length - yrs[a].length || a.localeCompare(b))[0];
    if (y) out.push({ q: `What happened at ${street} in ${y}?`, shape: 'address-story', kind: 'list', ids: yrs[y].map((d) => d.label), n: yrs[y].length, total: null, noneOk: false });
  }
  fs.writeFileSync(f2, JSON.stringify(out, null, 1));
  console.log(path.split('/').pop(), out.length, 'questions');
}

function score(genPath, ansPath) {
  const g = JSON.parse(fs.readFileSync(genPath, 'utf8')); const a = JSON.parse(fs.readFileSync(ansPath, 'utf8'));
  const flat = a.map((r) => (Array.isArray(r) ? r[r.length - 1] : r));
  const res = { right: 0, model: 0, wrong: 0, bad: [] };
  g.forEach((x, i) => {
    const r = flat.find((y) => y.q === x.q) ?? flat[i];
    const text = String(r?.text ?? '');
    if (r?.model === true) { res.model++; return; }
    if (r?.dqlNull || (!r?.op && r?.op !== undefined && r.text == null)) { res.model++; return; }
    if (x.kind === 'release') { res.wrong++; res.bad.push({ q: x.q, want: 'release', got: text.slice(0, 200) }); return; }
    let ok = true;
    const has = (s) => text.includes(s);
    if (x.kind === 'job') ok = x.must.every((m) => has(m));
    else if (x.kind === 'list') {
      if (x.n === 0) ok = /\b(?:none|no |nothing|not )/i.test(text);
      else { ok = (x.n <= 3 ? x.ids.every((id) => has(id)) : x.ids.filter((id) => has(id)).length >= Math.min(x.ids.length, 2)) && !(x.notIds ?? []).some((id) => has(id)) && new RegExp(`\\b${x.n} of\\b|\\b${x.n} papers?\\b`).test(text); }
    } else if (x.kind === 'count') ok = has(`${x.n} of ${x.total}`);
    else if (x.kind === 'share') ok = has(`${x.n} of ${x.total}`) && has(`${x.pct}%`);
    else if (x.kind === 'people') {
      if (x.n === 0) ok = /\b(?:none|no |nobody|not )/i.test(text);
      else ok = x.names.filter((nm) => has(nm)).length >= Math.min(x.names.length, 2) && has(String(x.n)) && (x.shape !== 'address-people' || x.n === 1 || has(`${x.n} customers`) || /only/i.test(text));
    }
    if (ok) res.right++; else { res.wrong++; res.bad.push({ q: x.q, want: x.kind === 'list' ? `${x.n}: ${x.ids.slice(0, 4).join(',')}` : x.kind === 'people' ? `${x.n}: ${x.names.slice(0, 3).join(',')}` : `${x.n}/${x.total}`, got: text.slice(0, 200) }); }
  });
  console.log(JSON.stringify({ right: res.right, model: res.model, wrong: res.wrong }));
  if (process.env.BAD) for (const b of res.bad) console.log('  WRONG', b.q, '| want', b.want, '| got', b.got);
}
const path = f1;
if (mode === 'gen') gen(f1); else if (mode === 'score') score(f1, f2);
