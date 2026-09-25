/**
 * TEAM H (2026-09-24): per-tenant VOCABULARY MINING — industry-agnostic by
 * construction. Finds frequent domain terms/abbreviations in a tenant's own
 * extracted document field values that are NOT already known vocabulary
 * (nlNormalize's global VOCAB, the tenant's OWN industry pack, or what has
 * already been learned for this tenant), and proposes synonym/abbreviation
 * entries for them — the exact same code mines a plumbing or electrical
 * shop's corpus as an HVAC one, because "known vocabulary" is always read
 * from that tenant's OWN pack (api/_lib/industry/index.js), never a
 * hard-coded HVAC list.
 *
 * Three layers:
 *   - tokenizeForMining / mineCandidateTerms / topCandidatesForLabeling —
 *     pure, deterministic frequency + co-occurrence (distinct source
 *     documents) mining. No DB, no model.
 *   - validateTenantVocabProposal — pure, closed-vocabulary validation
 *     against the TENANT'S OWN pack, mirroring learning/proposals.js's
 *     global discipline (a learned `to`/entity target must already be known;
 *     only the NEW word being proposed may be unfamiliar).
 *   - labelCandidatesWithModel — the ONLY part that touches the network: at
 *     most 5 Haiku calls per tenant per night (the brief's own cap), one per
 *     top candidate, asking whether it is an abbreviation (and of what) or a
 *     synonym (and of which pack entity). Never throws — any failure comes
 *     back as an unlabeled candidate, same "skip, don't crash the sweep"
 *     discipline as learning/proposer.js's own callModelForGroup.
 */
import Anthropic from '@anthropic-ai/sdk';
import { getApiKey, MODEL_TIMEOUT_MS, withBackoff } from '../claude.js';
import { estimateCostUsd } from '../usage.js';

export const MAX_LABEL_CALLS_PER_TENANT_NIGHT = 5;
export const VOCAB_MINE_MODEL = process.env.DONOVAN_LEARN_MODEL || 'claude-haiku-4-5';
const MAX_OUTPUT_TOKENS = 200;

const WORD_RE = /^[a-z0-9][a-z0-9.-]{1,14}$/;
const STOPWORD_RE = /^(the|and|for|with|from|this|that|none|null|unknown|na|n\/a|yes|no|ok|other|misc)$/;

/**
 * Pure: tokenize one extracted FIELD VALUE (e.g. "TXV replaced, cond fan ok")
 * into mining candidates — short, word- or acronym-shaped tokens a
 * dispatcher would type, never a full sentence. extractions.value rows are
 * field values, not free narrative, so this never sees a customer's name or
 * address (those live in `entities`, a different table this file never
 * reads).
 * @param {string} text
 * @returns {string[]}
 */
export function tokenizeForMining(text) {
  const raw = String(text ?? '').toLowerCase();
  const words = raw.match(/[a-z][a-z0-9.-]*/g) ?? [];
  return words.filter((w) => w.length >= 2 && w.length <= 16 && WORD_RE.test(w) && !STOPWORD_RE.test(w) && !/^\d+$/.test(w));
}

/**
 * Frequency + co-occurrence (distinct source documents) mining over one
 * tenant's extracted field values.
 * @param {Array<{value: string, documentId?: string}>} rows
 * @param {Set<string>} knownVocab  lower-cased words already known (global +
 *   this tenant's pack + already-learned-for-this-tenant) — never re-proposed.
 * @returns {Array<{term: string, count: number, docCount: number}>} sorted by count desc, then docCount desc
 */
export function mineCandidateTerms(rows, knownVocab) {
  const counts = new Map(); // term -> {count, docs: Set}
  for (const r of rows ?? []) {
    const docId = r?.documentId ?? '';
    for (const term of tokenizeForMining(r?.value)) {
      if (knownVocab?.has(term)) continue;
      const e = counts.get(term) ?? { count: 0, docs: new Set() };
      e.count += 1;
      if (docId) e.docs.add(docId);
      counts.set(term, e);
    }
  }
  return [...counts.entries()]
    .map(([term, e]) => ({ term, count: e.count, docCount: e.docs.size || 1 }))
    .sort((a, b) => b.count - a.count || b.docCount - a.docCount);
}

/** Pure: the deterministic top-N above the mining floor — bounds the ≤5/night model-label budget. */
export function topCandidatesForLabeling(candidates, { minCount = 3, minDocs = 2, limit = MAX_LABEL_CALLS_PER_TENANT_NIGHT } = {}) {
  return (candidates ?? []).filter((c) => c.count >= minCount && c.docCount >= minDocs).slice(0, limit);
}

const WORD_FORMAT_RE = /^[a-z0-9&#.-]{2,30}$/;

/** documentTypes/fields entries may be plain strings (a synthetic/test pack) or Team G's real
 *  {id,label,...}/{key,label,...} shape — pull every word form out of either. Pure. */
function packEntryWords(x) {
  if (x == null) return [];
  if (typeof x === 'string') return [x];
  if (typeof x === 'object') return [x.id, x.key, x.label].filter(Boolean);
  return [];
}

/** All the words a tenant's pack already treats as known — the closed target vocabulary a learned
 *  abbreviation/synonym may only point INTO (see this file's own header). Pure. */
export function packKnownVocab(pack) {
  return new Set([
    ...(pack?.documentTypes ?? []).flatMap(packEntryWords),
    ...(pack?.fields ?? []).flatMap(packEntryWords),
    ...Object.keys(pack?.abbreviations ?? {}),
    ...Object.values(pack?.abbreviations ?? {}),
    ...Object.keys(pack?.synonyms ?? {}),
    ...Object.values(pack?.synonyms ?? {}).flat(),
  ].map((w) => String(w).toLowerCase()).filter(Boolean));
}

/**
 * Validate one tenant vocabulary proposal against the TENANT'S OWN pack —
 * the same "a learned word may only map INTO vocabulary already trusted"
 * discipline learning/proposals.js enforces globally, generalized to any
 * pack (swap the pack, the rule doesn't change; nothing here is HVAC-
 * specific).
 * @param {'abbreviation'|'synonym'} kind
 * @param {object} payload  {from,to} for abbreviation, {entity,word} for synonym
 * @param {object} pack     the tenant's industry pack (industry/index.js shape)
 * @returns {{ok: boolean, reason?: string}}
 */
export function validateTenantVocabProposal(kind, payload, pack) {
  if (kind !== 'abbreviation' && kind !== 'synonym') return { ok: false, reason: `unsupported tenant vocab kind "${kind}"` };
  const known = packKnownVocab(pack);

  if (kind === 'abbreviation') {
    const from = String(payload?.from ?? '').toLowerCase();
    const to = String(payload?.to ?? '').toLowerCase();
    if (!WORD_FORMAT_RE.test(from)) return { ok: false, reason: 'abbreviation: "from" must be a 2-30 char lowercase token' };
    if (known.has(from)) return { ok: false, reason: 'abbreviation: "from" is already known vocabulary for this pack' };
    if (!WORD_FORMAT_RE.test(to) || !known.has(to)) return { ok: false, reason: "abbreviation: \"to\" must already be known vocabulary for this tenant's pack" };
    if (from === to) return { ok: false, reason: 'abbreviation: "from" and "to" must differ' };
    return { ok: true };
  }
  const entity = String(payload?.entity ?? '').toLowerCase();
  const word = String(payload?.word ?? '').toLowerCase();
  if (!WORD_FORMAT_RE.test(word)) return { ok: false, reason: 'synonym: "word" must be a 2-30 char lowercase token' };
  if (known.has(word)) return { ok: false, reason: 'synonym: "word" is already known vocabulary for this pack' };
  if (!entity) return { ok: false, reason: 'synonym: "entity" is required' };
  return { ok: true };
}

/* ------------------------------------------------------------------ labeling (network) */

const LABEL_TOOL = {
  name: 'label_term',
  description: 'Classify one domain term found in a shop\'s own documents.',
  input_schema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['abbreviation', 'synonym', 'none'] },
      to: { type: 'string', description: 'For kind=abbreviation: the already-known word/phrase this expands to. Must be one of the KNOWN VOCABULARY words given.' },
      entity: { type: 'string', description: 'For kind=synonym: which known entity/field this term is a plain-English name for.' },
    },
    required: ['kind'],
  },
};

function buildLabelPrompt(pack) {
  const known = [...packKnownVocab(pack)].slice(0, 200).join(', ');
  return [
    `You help Donovan, a ${pack?.businessNoun ?? 'business'} assistant, learn its own trade's shorthand from its customers' documents.`,
    `KNOWN VOCABULARY (may only be used as an abbreviation's "to" or a synonym's "entity"; never invent a target word): ${known || '(none yet)'}`,
    'Call label_term exactly once. kind=abbreviation only when the term clearly expands to one of the known words above; kind=synonym only when it is a plain-English alternate name for a known field/document type; otherwise kind=none.',
  ].join('\n');
}

/** One Haiku call to label one candidate term. Never throws — any failure comes back `{skipped}`. */
async function labelOne(term, pack, outerDeadlineAt = Infinity) {
  try {
    const client = new Anthropic({ apiKey: getApiKey(), timeout: MODEL_TIMEOUT_MS, maxRetries: 0 });
    const deadlineAt = Math.min(Date.now() + MODEL_TIMEOUT_MS, outerDeadlineAt);
    const response = await withBackoff(
      () => client.messages.create(
        {
          model: VOCAB_MINE_MODEL,
          max_tokens: MAX_OUTPUT_TOKENS,
          temperature: 0,
          system: buildLabelPrompt(pack),
          tools: [LABEL_TOOL],
          tool_choice: { type: 'tool', name: 'label_term' },
          messages: [{ role: 'user', content: `TERM: "${term}"` }],
        },
        { timeout: Math.max(1000, deadlineAt - Date.now()) }
      ),
      { deadlineAt }
    );
    const usage = response.usage ?? {};
    const toolUse = response.content?.find((b) => b.type === 'tool_use');
    return {
      raw: toolUse?.input ?? { kind: 'none' },
      costUsd: estimateCostUsd({ inputTokens: Number(usage.input_tokens) || 0, outputTokens: Number(usage.output_tokens) || 0 }),
    };
  } catch (err) {
    return { skipped: 'model-error', error: err?.message, costUsd: 0 };
  }
}

/**
 * Label up to MAX_LABEL_CALLS_PER_TENANT_NIGHT candidates for one tenant,
 * turning each into a validated {kind, payload} proposal (or null when the
 * model said 'none', the response didn't validate, or the call failed).
 * @param {Array<{term:string,count:number,docCount:number}>} candidates
 * @param {object} pack
 * @returns {Promise<{results: Array<{term:string,count:number,docCount:number,kind?:string,payload?:object}>, modelCallsMade: number, costUsd: number}>}
 */
export async function labelCandidatesWithModel(candidates, pack, { deadlineAt = Infinity, budgetUsd = Infinity } = {}) {
  const list = (candidates ?? []).slice(0, MAX_LABEL_CALLS_PER_TENANT_NIGHT);
  const results = [];
  let costUsd = 0;
  let modelCallsMade = 0;
  for (const c of list) {
    // Review r4: never start a label call without time left in the cron's deadline, or once the tenant's
    // remaining learning budget is spent (a Haiku label call costs ~$0.0005; 0.002 is a safe per-call reserve).
    if (deadlineAt - Date.now() < 8000 || budgetUsd - costUsd < 0.002) { results.push({ ...c }); continue; }
    modelCallsMade += 1;
    const r = await labelOne(c.term, pack, deadlineAt - 2000);
    costUsd += r.costUsd ?? 0;
    if (r.skipped || !r.raw || r.raw.kind === 'none') { results.push({ ...c }); continue; }
    const kind = r.raw.kind;
    const payload = kind === 'abbreviation' ? { from: c.term, to: r.raw.to } : { entity: r.raw.entity, word: c.term };
    const v = validateTenantVocabProposal(kind, payload, pack);
    results.push(v.ok ? { ...c, kind, payload } : { ...c });
  }
  return { results, modelCallsMade, costUsd: Math.round(costUsd * 10000) / 10000 };
}
