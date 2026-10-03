// Seeds a tenant through the real recordsStore API (so rows look like production rows) with unique sentinel strings.
import crypto from 'node:crypto';
import { r2 } from './lib.mjs';

export const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export async function seedTenant(h, { key, tag, plan = 'fleet' }) {
  const uuid = await h.newTenant(key, plan, 'active');
  const T = { key, tag, uuid, docs: [], sent: [] };
  const S = (s) => { T.sent.push(s); return s; };
  await h.RS.withTenant({ tenantKey: key, tenantName: key }, async (db) => {
    for (let i = 1; i <= 2; i++) {
      const hash = sha(`${tag}-doc-${i}`);
      const storageKey = `${uuid}/${hash.slice(0, 2)}/${hash}-svc${i}.txt`;
      const d = await db.createDocument({ original_filename: `svc-${S(`FILE${tag}${i}`)}.txt`, sha256_hash: hash, file_size_bytes: 400, content_type: 'text/plain', storage_key: storageKey, stage: 'mapped', uploaded_by: `user_${tag}` });
      await db.upsertPages(d.id, [{ page_no: 1, text: `Service ticket for ${S(`CUSTOMER${tag}`)} at ${S(`${100 + i} ${tag}STREET Lane`)}. Serial ${S(`SN${tag}${i}`)}. Compressor replaced.` }]);
      r2.objects.set(storageKey, { bytes: Buffer.from(`BYTES-OF-${tag}-${i}`), type: 'text/plain' });
      T.docs.push({ id: d.id, storageKey, hash });
    }
    const cust = await db.findOrCreateCustomer({ customer_name: `Cust ${tag} ${S(`NAME${tag}`)}`, service_address: `101 ${tag}STREET Lane`, phone: `555-010${tag.length}`, email: `${tag.toLowerCase()}@example.invalid` });
    T.customerId = cust.id ?? cust;
    const unit = await db.findOrCreateEquipment({ serial_number: `SN${tag}1`, model: `MODEL-${tag}`, manufacturer: 'Carrier', service_address: `101 ${tag}STREET Lane`, installation_date: '2023-01-15' });
    T.unitId = unit.id ?? unit;
    await db.setEquipmentCustomer(T.unitId, T.customerId);
    T.extractionIds = [];
    for (const [fk, v] of [['customer_name', `Cust ${tag} NAME${tag}`], ['serial_number', `SN${tag}1`], ['service_date', '2024-05-05']]) {
      const e = await db.createExtraction({ document_id: T.docs[0].id, entity_id: fk === 'serial_number' ? T.unitId : T.customerId, field_key: fk, value: v, confidence: 0.9 });
      T.extractionIds.push(e.id);
    }
    await db.raw(`INSERT INTO document_entity_links (tenant_id, document_id, entity_id, confidence, linked_by) VALUES ($1,$2,$3,0.9,'ai'),($1,$2,$4,0.9,'ai') ON CONFLICT DO NOTHING`, [uuid, T.docs[0].id, T.customerId, T.unitId]);
    T.facetId = (await db.createFacet({ document_id: T.docs[0].id, page_no: 1, label_raw: 'note', value_raw: S(`FACET${tag}`) }))?.id;
    T.proposalId = (await db.createProposal({ kind: 'field', label: S(`PROPOSAL${tag}`), evidence: {} }))?.id;
    await db.logAction({ action: `seed.${S(`AUDIT${tag}`)}`, resource_type: 'document', resource_id: T.docs[0].id, clerk_user_id: `user_${tag}`, changes: { s: S(`AUDITCHG${tag}`) } });
    await db.raw(`INSERT INTO notifications (tenant_id, kind, title, body) VALUES ($1,'x',$2,$3)`, [uuid, S(`NOTIF${tag}`), 'b']);
    const n = await db.raw(`SELECT id FROM notifications WHERE tenant_id=$1 LIMIT 1`, [uuid]); T.notifId = n.rows[0]?.id;
    await db.raw(`INSERT INTO outreach_messages (tenant_id, customer_id, equipment_id, tier, to_email, subject, body_text, status) VALUES ($1,$2,$3,'expired',$4,$5,'b','draft')`, [uuid, T.customerId, T.unitId, `${tag.toLowerCase()}@example.invalid`, S(`OUTREACH${tag}`)]);
    T.outreachId = (await db.raw(`SELECT id FROM outreach_messages WHERE tenant_id=$1`, [uuid])).rows[0]?.id;
    const c2 = await db.createEntity({ entity_type: 'customer', data: { customer_name: `Dup ${tag} NAME${tag}` } }); T.cust2 = c2.id;
    await db.raw(`INSERT INTO entity_merge_suggestions (tenant_id, cluster_id, entity_ids, score) VALUES ($1,$2,$3::uuid[],0.9)`, [uuid, `clu-${tag}`, [T.customerId, T.cust2]]);
    T.suggestionId = (await db.raw(`SELECT id FROM entity_merge_suggestions WHERE tenant_id=$1`, [uuid])).rows[0]?.id; T.clusterId = `clu-${tag}`;
    await db.raw(`INSERT INTO intake_needs_info (tenant_id, document_id, field_key, question) VALUES ($1,$2,'service_date',$3)`, [uuid, T.docs[0].id, S(`QUESTION${tag}`)]);
    await db.raw(`UPDATE tenants SET settings = COALESCE(settings,'{}'::jsonb) || $2::jsonb WHERE id = $1`, [uuid, JSON.stringify({ address: S(`SETTING${tag}`) })]);
  });
  const { createApiKey } = await import('../../api/_lib/routes/keys.js');
  const k = await createApiKey({ tenantKey: key, tenantName: key }, { userId: `user_${tag}` }, { name: `key-${tag}`, scopes: ['read', 'ingest', 'ask'] });
  T.apiKey = k.body.key; T.apiKeyId = k.body.id;
  const kr = await createApiKey({ tenantKey: key, tenantName: key }, { userId: `user_${tag}` }, { name: `readonly-${tag}`, scopes: ['read'] });
  T.readKey = kr.body.key; T.readKeyId = kr.body.id;
  T.ids = [T.uuid, ...T.docs.map((d) => d.id), T.customerId, T.unitId, T.cust2, ...T.extractionIds, T.facetId, T.proposalId, T.notifId, T.outreachId, T.suggestionId, T.apiKeyId, T.readKeyId].filter(Boolean);
  T.secrets = [...T.sent, ...T.docs.map((d) => d.storageKey), T.apiKey, T.readKey];
  return T;
}

/** md5 per tenant-owned table (superuser view; call only when no request is in flight). */
export async function fingerprint(h, uuid) {
  const tabs = (await h.lite.query(`SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' ORDER BY 1`)).rows.map((r) => r.table_name);
  const out = {};
  for (const t of tabs) {
    const r = await h.lite.query(`SELECT count(*)::int n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) m FROM "${t}" x WHERE tenant_id = $1`, [uuid]);
    out[t] = `${r.rows[0].n}:${r.rows[0].m}`;
  }
  const tr = await h.lite.query(`SELECT md5(x::text) m FROM tenants x WHERE id = $1`, [uuid]);
  out.tenants = tr.rows[0]?.m;
  return out;
}
export const diffFp = (a, b) => Object.keys(a).filter((k) => a[k] !== b[k]);
