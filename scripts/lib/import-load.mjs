// Loads a synthetic import (scripts/lib/import-synth.mjs) into the in-process database for one tenant.
import { insertDocs, insertPages, insertFields, insertCustomers, insertLinks } from './pglite-tenant.mjs';

export async function loadSynthetic(h, ten, synth, batch) {
  await insertCustomers(h.lite, ten, synth.existing);
  const docs = synth.docs;
  await insertDocs(h.lite, ten, docs.map((d) => ({ id: d.id, name: d.name, type: d.type, stage: d.stage === 'linked' ? 'linked' : d.stage, batch: d.batch ? batch : null })));
  await insertPages(h.lite, ten, docs.filter((d) => d.text).map((d) => ({ id: d.id, text: d.text })));
  await insertFields(h.lite, ten, docs.flatMap((d) => d.fields.map((f) => ({ doc: d.id, key: f.key, value: f.value, conf: f.conf }))));
  await insertLinks(h.lite, ten, docs.filter((d) => d.link).map((d) => ({ doc: d.id, entity: d.link })));
  const filed = docs.filter((d) => d.verified).map((d) => d.id);
  if (filed.length) await h.lite.query(`UPDATE documents SET stage = 'verified', verified_by = 'ai', verified_at = NOW() WHERE id = ANY($1::uuid[])`, [filed]);
  for (const s of synth.suggestions) {
    await h.lite.query(`INSERT INTO audit_log (tenant_id, action, resource_type, resource_id, changes) VALUES ($1, 'recheck.link_suggestion', 'document', $2, $3::jsonb)`, [ten, s.doc, JSON.stringify({ candidates: s.candidates })]);
  }
}
