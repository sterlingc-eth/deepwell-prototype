/** iddocs.js - person-owned papers (driver licence / CDL, DOT medical examiner's certificate, CPR / forklift cards, vehicle registration, insurance card):
 * find the paper by TYPE plus HOLDER NAME and answer expiry / current / number-present / class / issue date / examiner. The logic lives in ONE place,
 * api/_lib/people/peopleLane.js (answerPeople), which ask.js also calls as an early lane; this file only adapts the reader's index to it.
 *
 * ONE env switch, default OFF: DONOVAN_READER_V2_IDDOCS=1. OFF = nothing in this file is consulted (index.js calls it only when the switch is on).
 * NOT MIRRORED in the training loop (lib/*.py): per PLAYBOOK R79(b) a rule must be a one-switch loop+app pair that has passed R52 and the oracle
 * rules before it is turned on; this one has only the app half, so it must stay OFF in any environment the parity check covers.
 * Second tier only: it never replaces an answer (the caller passes only a released question), reads the stored extractions (corrected values win)
 * and the layout reader over the stored page text, and abstains whenever the question names a person it cannot match, two papers disagree, or the
 * field is absent. Licence / card numbers are never shown in full ("on file" + last 4). People and HR papers are never used here: the reader's
 * index already leaves private papers out, and canHr is false. Pure function of (index, question). Never throws: maybe() returns null to keep the reader's own answer. */
import { answerPeople } from '../../people/peopleLane.js';

const truthy = (v) => /^(?:1|true|on|yes)$/i.test(String(v ?? '').trim());
export const ID = { on: false };
export function configureIdDocs() { ID.on = truthy(process.env.DONOVAN_READER_V2_IDDOCS); return ID.on; }

const TYPES = new Set(['license-certification', 'insurance-certificate']);
export function maybe(ix, q, pred) {
  if (!ID.on || pred?.answered) return null;
  try {
    const docs = [...ix.D.values()].filter((x) => TYPES.has(x.type)).map((x) => ({ id: x.id, type: x.type, fields: Object.fromEntries(x.fields), pages: ix.c.pages.get(x.id) || [] }));
    if (!docs.length) return null;
    const today = String(ix.records?.exportedAt ?? '').slice(0, 10) || undefined;
    const r = answerPeople(docs, String(q), { today, canHr: false });
    if (!r) return null;
    return { answered: true, text: r.text, docs: r.docs, page: r.page, pv: Math.max(0.9, Number(pred?.pv) || 0), intent: 'iddoc_' + r.intent, reason: 'iddocs', cands: 1 };
  } catch { return null; }
}
