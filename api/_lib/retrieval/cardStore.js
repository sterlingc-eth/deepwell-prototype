/**
 * OPTIONAL stored copy of the document cards (switch DONOVAN_CARDS_STORE, default OFF; table created by M3-config/68-document-cards.sql, filled by
 * scripts/build-document-cards.mjs, both run by the owner later). Nothing requires it: retrieval/index.js builds cards on the fly from the same stored rows.
 * When the switch is on and the table exists, a stored card is used for any document that has one; a missing table or row just falls back to the on-the-fly card.
 */
const T = (a) => `${a}.tenant_id = (current_setting('app.tenant_id', true))::uuid`;
export const cardsStoreEnabled = (env = process.env) => /^(?:1|true|on|yes)$/i.test(String(env?.DONOVAN_CARDS_STORE ?? "").trim());

export async function readStoredCards(db, docIds) {
  if (!docIds.length) return [];
  const r = await db.raw(`SELECT c.document_id, c.card_text, d.document_type, d.original_filename AS filename FROM document_cards c JOIN documents d ON d.id = c.document_id
     WHERE c.document_id = ANY($1::uuid[]) AND ${T("c")}`, [docIds]);
  return r.rows.map((x) => ({ documentId: x.document_id, filename: x.filename, documentType: x.document_type, page: 1, text: x.card_text }));
}

export async function writeStoredCards(db, cards) {
  for (const c of cards) {
    await db.raw(`INSERT INTO document_cards (tenant_id, document_id, card_text, built_at) VALUES ((current_setting('app.tenant_id', true))::uuid, $1, $2, NOW())
       ON CONFLICT (tenant_id, document_id) DO UPDATE SET card_text = EXCLUDED.card_text, built_at = NOW()`, [c.documentId, c.text]);
  }
}
