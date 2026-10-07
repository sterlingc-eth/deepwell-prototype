/**
 * Shared engine for the generator-style CLASS variant tests (plumbing + electrical).
 * Records are written straight into the store as rows (value, corrected_value, audience), the way the app leaves them after
 * extraction and human review. Truth is computed by each variant script from those raw rows with a rule written separately from
 * the product code. A lane may decline (null / decline envelope: always acceptable), but when it answers, the LEADING number and
 * the wording must match the truth. Two companies of the SAME industry share one database in every scenario.
 */
import crypto from 'node:crypto';

export function rng(seed) { let s = (seed >>> 0) || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
export const pick = (r, a) => a[Math.floor(r() * a.length)];
export const chance = (r, p) => r() < p;
export const shuffle = (r, a) => { const o = [...a]; for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; } return o; };

const ZW = new RegExp('[\\u200b-\\u200f\\u2060\\ufeff\\u00ad]', 'g');
const SP = new RegExp('[\\s\\u00a0\\u2000-\\u200a\\u202f\\u205f\\u3000]+', 'g');
/** The effective value of one stored field, written independently of the lanes: a human correction wins (even an empty one = cleared); whitespace of every kind and zero-width marks count as empty. */
export const eff = (fld) => { const raw = fld.corrected !== undefined && fld.corrected !== null ? fld.corrected : fld.value; const s = String(raw ?? '').replace(ZW, '').replace(SP, ' ').trim(); return s === '' ? null : s; };
/** effective single value of a key across a doc spec's fields ('conflict' when two different effective values are stored) */
export function val(doc, key) {
  const vs = [...new Set(doc.fields.filter((x) => x.key === key).map(eff).filter((x) => x != null).map((x) => x.toLowerCase()))];
  if (!vs.length) return null; if (vs.length > 1) return 'CONFLICT';
  return eff(doc.fields.find((x) => x.key === key && eff(x) != null));
}

let docSeq = 0;
/** Insert documents specs into a company: {filename,type,audience?,fields:[{key,value,corrected?,page?}], text?}. Returns ids by filename. */
export async function seedDocs(db, docs) {
  const ids = {}; const { rows: cols } = await db.raw(`SELECT 1 FROM information_schema.columns WHERE table_name='documents' AND column_name='audience'`, []);
  const hasAud = cols.length > 0;
  for (const d of docs) {
    const doc = await db.createDocument({ original_filename: d.filename, document_type: d.type, sha256_hash: crypto.createHash('sha256').update(`${d.filename}|${docSeq++}|${Math.random()}`).digest('hex'), stage: 'mapped' });
    ids[d.filename] = doc.id;
    if (d.audience && hasAud) await db.raw(`UPDATE documents SET audience = $1 WHERE id = $2`, [d.audience, doc.id]);
    for (const f of d.fields) {
      const facet = await db.createFacet({ document_id: doc.id, page_no: f.page ?? 1, label_raw: f.key, value_raw: String(f.value ?? ''), confidence: 0.99 });
      const ex = await db.createExtraction({ document_id: doc.id, field_key: f.key, value: f.value == null ? null : String(f.value), confidence: 0.99, source_facet_id: facet.id });
      if (f.corrected !== undefined && f.corrected !== null) await db.raw(`UPDATE extractions SET corrected_value = $1 WHERE id = $2`, [String(f.corrected), ex.id]);
    }
  }
  return ids;
}

/** A second company of the same industry in the same database. */
export async function addSecondCompany(H, industry, key) {
  const { getTenantContext } = await import('../../api/_lib/recordsStore.js');
  const ctx = { tenantKey: `org_mixed_${industry}_${key}`, tenantName: `Mixed ${industry} ${key}` };
  const id = (await getTenantContext(ctx.tenantKey, ctx.tenantName)).id;
  await H.withTenant(ctx, (db) => H.R.setTenantIndustry(db, industry, { tenantKey: ctx.tenantKey }));
  H.R.resetPacksCacheForTests(); H.I.resetPackForTenantCacheForTests();
  return { industry, ctx, id, as: (fn) => H.withTenant(ctx, fn) };
}

export const leadNumber = (text) => { const m = /^\s*(\d[\d,]*)\b/.exec(String(text ?? '')); return m ? Number(m[1].replace(/,/g, '')) : null; };
const blobOf = (r) => `${r.text} ${(r.facts ?? []).map((f) => `${f.label} ${f.value}`).join(' ')}`.toLowerCase();

/** Judge one answer. exp: {lead?, must?:[], mustNot?:[], decline?:true, exactSet?:{names:[],all:[]}} -> {ok, status, why} */
export function judge(res, exp) {
  if (res == null || res.decline === true || res.clarify === true) return { ok: true, status: 'declined' };
  if (exp.decline) return { ok: false, status: 'wrong', why: `answered where it must decline: ${String(res.text).slice(0, 160)}` };
  const why = []; const blob = blobOf(res);
  if (exp.lead != null) { const n = leadNumber(res.text); if (n !== exp.lead) why.push(`leading number ${n} != ${exp.lead}`); }
  for (const m of exp.must ?? []) if (!blob.includes(String(m).toLowerCase())) why.push(`missing "${m}"`);
  for (const m of exp.mustNot ?? []) if (blob.includes(String(m).toLowerCase())) why.push(`should not contain "${m}"`);
  if (exp.leadNone && !/^\s*(?:none|no |0\b)/i.test(res.text)) why.push(`expected none/no, got ${String(res.text).slice(0, 80)}`);
  return why.length ? { ok: false, status: 'wrong', why: why.join('; ') + ` | ${String(res.text).slice(0, 160)}` } : { ok: true, status: 'answered' };
}

/** Run a question list through a lane in one company; collect stats per class label. */
export async function runCases(as, lane, cases, today, stats, log) {
  await as(async (db) => {
    for (const c of cases) {
      const intent = lane.classify(c.q, { today });
      const res = intent ? await lane.run(db, intent, { today }) : null;
      const j = judge(res, c.exp);
      const s = (stats[c.cls] ??= { answered: 0, declined: 0, wrong: 0 });
      s[j.status === 'wrong' ? 'wrong' : j.status]++;
      if (!j.ok) log(`WRONG [${c.cls}] "${c.q}" ${j.why}`);
    }
  });
}

/** Insert n plain records of one document type in ONE statement per table (volume checks: counts past 200 and 500 must come from the whole table, never from a limited list). fieldsFn(g) -> {key: sqlExpr over g}. */
export async function seedBulk(db, { n, type, prefix, fields }) {
  await db.raw(`INSERT INTO documents (tenant_id, original_filename, document_type, sha256_hash, stage)
                SELECT current_setting('app.tenant_id', true)::uuid, $1 || g::text || '.pdf', $2, md5($1 || g::text || random()::text), 'mapped' FROM generate_series(1, $3::int) g`, [prefix, type, n]);
  for (const [key, expr] of Object.entries(fields)) {
    await db.raw(`INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence)
                  SELECT d.tenant_id, d.id, $1, ${expr}, 0.99 FROM (SELECT d0.*, (regexp_replace(d0.original_filename, '^.*?(\\d+)\\.pdf$', '\\1'))::int AS g FROM documents d0 WHERE d0.original_filename LIKE $2 AND d0.document_type = $3 AND d0.tenant_id = current_setting('app.tenant_id', true)::uuid) d`, [key, `${prefix}%`, type]);
  }
}
