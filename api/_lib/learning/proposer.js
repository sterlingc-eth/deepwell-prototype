/**
 * Donovan self-learning loop, Tier 2 Part B (handoffs/DONOVAN_SELF_LEARNING_2026-09-22.md):
 * the nightly PROPOSER. Takes the last 24h's grouped misses (the shape
 * api/_lib/missDigest.js's buildMissDigest already produces — one entry per
 * (outcome, redacted question) with count/tenantCount/detectedConditions) and
 * produces candidate learning proposals, cheapest-first:
 *
 *   1. A DETERMINISTIC pass, no model call at all — typo and abbreviation
 *      candidates found by scanning the question's own words against
 *      nlNormalize.js's closed VOCAB. Free, and covers the large majority of
 *      real dispatcher typos (this is the same table the LIVE fuzzy
 *      corrector already uses, just applied with a slightly wider net — see
 *      deterministicCandidatesForQuestion's own doc comment for exactly how
 *      it differs from fuzzyCorrect).
 *   2. ONE Haiku tool-use call per remaining group (a group the deterministic
 *      pass found nothing for), capped at `maxModelCalls` per run
 *      (DONOVAN_LEARN_MAX_CALLS, default 20) — the cheapest model this
 *      codebase uses anywhere, temperature 0, a ≤300-token output cap, and a
 *      system prompt that explains the closed-vocabulary discipline
 *      (proposals.js's own doc comment) so the model knows it may only map
 *      into vocabulary Donovan already trusts, or propose a few_shot/
 *      capability_gap instead of guessing.
 *
 * EVERY candidate from either pass — deterministic or model — is validated
 * with proposals.js's validateProposal before this function returns it: an
 * invalid one comes back with `valid:false` and a `reason`, never silently
 * dropped (api/_lib/learning/sweep.js is what turns that into an
 * `auto_rejected` donovan_proposals row so an operator can see what was
 * tried). This file itself never touches the database.
 *
 * COST GUARD (build brief item 6): a question is never sent to the model
 * until it has been redacted (missDigest.js's own redactPII — belt and
 * suspenders, since a miss group's question is already redacted before this
 * file ever sees it) and re-checked for anything that still looks like an
 * email or phone number; if one survives redaction, that group is skipped
 * entirely — no model call, no exception.
 */
import Anthropic from '@anthropic-ai/sdk';
import { getApiKey, MODEL_TIMEOUT_MS, withBackoff } from '../claude.js';
import { estimateCostUsd } from '../usage.js';
import { redactPII } from '../missDigest.js';
import { VOCAB } from '../nlNormalize.js';
import { looksLikeSingleRecordReference } from '../analytics.js';
import { validateProposal, PROPOSAL_KINDS, STOPWORDS } from './proposals.js';

export const LEARN_MODEL = process.env.DONOVAN_LEARN_MODEL || 'claude-haiku-4-5';
const DEFAULT_MAX_MODEL_CALLS = 20;
const MAX_OUTPUT_TOKENS = 300;

/* ======================================================== deterministic pass
 * Duplicated from nlNormalize.js rather than imported (withinEditDistance1/
 * fuzzyCorrect/STREET_SUFFIX_WORD_RE aren't exported there) — same reasoning
 * api/_lib/learning/proposals.js's own doc comment gives for duplicating its
 * small closed lists: a handful of lines, not worth widening that file's
 * surface for. VOCAB itself IS imported (the one thing that must never drift
 * out of sync with the live corrector).
 */

const STREET_SUFFIX_WORD_RE =
  /^(?:ave|avenue|rd|road|st|street|blvd|boulevard|dr|drive|ln|lane|ct|court|way)$/i;

/** True when `a`/`b` are the same word, one substitution/transposition apart
 *  (equal length), or one insertion/deletion apart (length differs by 1) —
 *  Damerau-Levenshtein distance <= 1. Identical to nlNormalize.js's own
 *  withinEditDistance1. */
function withinEditDistance1(a, b) {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    let diffCount = 0;
    let i1 = -1;
    let i2 = -1;
    for (let i = 0; i < la; i++) {
      if (a[i] !== b[i]) {
        diffCount++;
        if (diffCount === 1) i1 = i;
        else if (diffCount === 2) i2 = i;
        else return false;
      }
    }
    if (diffCount <= 1) return true;
    return i2 === i1 + 1 && a[i1] === b[i2] && a[i2] === b[i1];
  }
  const [s, l] = la < lb ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let usedSkip = false;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) { i++; j++; continue; }
    if (usedSkip) return false;
    usedSkip = true;
    j++;
  }
  return true;
}

function buildVocabByLen(vocab) {
  const map = new Map();
  for (const w of vocab) {
    if (!map.has(w.length)) map.set(w.length, []);
    map.get(w.length).push(w);
  }
  return map;
}
const VOCAB_BY_LEN = buildVocabByLen(VOCAB);

/**
 * Scans one (already redacted, already-normalized-by-the-live-pipeline)
 * question for typo/abbreviation candidates, in ONE pass over its words so a
 * word never gets flagged as both:
 *
 *   - abbreviation: a token <= 4 chars that is a prefix of EXACTLY ONE vocab
 *     word strictly longer than itself ("wo" -> "warranty" only if no other
 *     vocab word also starts with "wo").
 *   - typo: a token >= 4 chars within Damerau-Levenshtein <= 1 of EXACTLY ONE
 *     vocab word — deliberately a LOWER floor than nlNormalize.js's live
 *     fuzzyCorrect (5+ letters): a question that reached the miss log already
 *     went through the live corrector and still wasn't fixed, so a 4-letter
 *     typo the live pass can never touch by design is exactly the gap this
 *     nightly pass exists to close.
 *
 * Skips a token entirely (same guards normalizeQuestion itself uses) when:
 * the whole question looks like a single-record/address/serial reference,
 * the token itself contains a digit, the token immediately follows a number,
 * the token immediately precedes a street-suffix word, or the token is
 * already in VOCAB. An ambiguous typo match (more than one equally-close
 * vocab word) is dropped rather than guessed.
 */
export function deterministicCandidatesForQuestion(question) {
  const text = String(question ?? '');
  if (!text || looksLikeSingleRecordReference(text)) return [];

  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
  const candidates = [];
  const handled = new Set();

  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i];
    if (/\d/.test(raw)) continue;
    const core = raw.replace(/[^a-z]/g, '');
    if (!core || core.length < 2 || VOCAB.has(core) || handled.has(core) || STOPWORDS.has(core)) continue;

    const prevRaw = i > 0 ? tokens[i - 1].replace(/[^a-z0-9]/g, '') : '';
    if (/^\d+$/.test(prevRaw)) continue;
    const nextRaw = i < tokens.length - 1 ? tokens[i + 1].replace(/[^a-z]/g, '') : '';
    if (STREET_SUFFIX_WORD_RE.test(nextRaw)) continue;

    if (core.length <= 4) {
      const prefixMatches = [];
      for (const w of VOCAB) {
        if (w.length > core.length && w.startsWith(core)) prefixMatches.push(w);
        if (prefixMatches.length > 1) break;
      }
      if (prefixMatches.length === 1) {
        candidates.push({ kind: 'abbreviation', payload: { from: core, to: prefixMatches[0] } });
        handled.add(core);
        continue;
      }
    }

    if (core.length >= 4) {
      let match = null;
      let ambiguous = false;
      for (const len of [core.length - 1, core.length, core.length + 1]) {
        const cands = VOCAB_BY_LEN.get(len);
        if (!cands) continue;
        for (const cand of cands) {
          if (withinEditDistance1(core, cand)) {
            if (match && match !== cand) ambiguous = true;
            match = cand;
          }
        }
      }
      if (match && !ambiguous) {
        candidates.push({ kind: 'typo', payload: { from: core, to: match } });
        handled.add(core);
      }
    }
  }
  return candidates;
}

/* ================================================================ model pass */

const CONTACT_RE =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/;

/** Cost guard (build brief item 6): redact, then refuse to model-call a
 *  question anything still email/phone-shaped survives in. Exported for
 *  scripts/verify-learning.mjs's own redaction-gate test — the meaningful
 *  thing to pin down here is `stillHasContactInfo(redactPII(text)) === false`
 *  for ordinary email/phone shapes, i.e. that redaction actually clears what
 *  this checks for, not just that the regex compiles. */
export function stillHasContactInfo(text) {
  return CONTACT_RE.test(String(text ?? ''));
}

const PROPOSAL_TOOL = {
  name: 'propose_fix',
  description:
    "Propose exactly ONE fix for a question Donovan could only answer honestly, not correctly. " +
    "kind='abbreviation'|'typo': map a NEW short/misspelled word onto a word ALREADY in Donovan's " +
    "vocabulary (from/to) — never invent the 'to' word. kind='synonym': teach a new plain-English " +
    'noun for an entity that already has a closed vocabulary (entity/word). kind=\'few_shot\': a ' +
    'question paired with a valid, executable analytics plan (question/plan). kind=\'capability_gap\': ' +
    "Donovan genuinely cannot do this yet (title/example/note) — use this rather than guessing when " +
    'unsure.',
  input_schema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: PROPOSAL_KINDS },
      from: { type: 'string', description: 'abbreviation/typo only: the new, short/misspelled word.' },
      to: { type: 'string', description: 'abbreviation/typo only: the EXISTING vocabulary word it maps to.' },
      entity: { type: 'string', description: 'synonym only: customers/equipment/warranties/documents/serviceVisits.' },
      word: { type: 'string', description: 'synonym only: the new plain-English noun.' },
      question: { type: 'string', description: 'few_shot only: the example question, verbatim.' },
      plan: {
        type: 'object',
        description:
          'few_shot only: {entity, op, groupBy?, filters?, timeRange?, limit?, sortBy?} — the same ' +
          'analytics_plan shape the live planner fills.',
      },
      title: { type: 'string', description: 'capability_gap only: a short name for the gap.' },
      example: { type: 'string', description: 'capability_gap only: the question that exposed it.' },
      note: { type: 'string', description: 'capability_gap only: why Donovan cannot do this yet.' },
    },
    required: ['kind'],
  },
};

function buildLearningSystemPrompt() {
  return [
    "You help Donovan, an HVAC-shop assistant, learn from questions it could only answer honestly " +
      'instead of correctly (a plain "nothing found," a "can\'t do that yet," an ambiguous lookup, or ' +
      'a rejected analytics plan).',
    'Known entities: customers, equipment, warranties, documents, serviceVisits — each with its own ' +
      'closed set of plain-English synonyms Donovan already recognizes.',
    "You may ONLY: (a) map a new short/misspelled word onto a word ALREADY in that vocabulary " +
      "(never invent the target word), (b) propose a few_shot example with a valid, executable plan, " +
      'or (c) report an informational capability_gap when Donovan genuinely cannot do this yet (e.g. ' +
      'there is no financials/invoicing layer). If you are not confident which of these applies, ' +
      'propose capability_gap rather than guessing.',
    'Call propose_fix exactly once with your single best proposal for the question given.',
  ].join('\n');
}

export function payloadFromModelInput(kind, input) {
  if (!input) return {};
  switch (kind) {
    case 'abbreviation':
    case 'typo':
      return { from: input.from, to: input.to };
    case 'synonym':
      return { entity: input.entity, word: input.word };
    case 'few_shot':
      return { question: input.question, plan: input.plan };
    case 'capability_gap':
      return { title: input.title, example: input.example, note: input.note };
    default:
      return input;
  }
}

/** One Haiku tool-use call for one miss group. Never throws — a timeout, a
 *  malformed response, or any Anthropic error all come back as
 *  `{ skipped: 'model-error', error }`, the same "fall through cleanly"
 *  discipline api/_lib/routes/analytics.js's planAnalyticsQuestion uses. */
async function callModelForGroup(question, group) {
  try {
    const client = new Anthropic({ apiKey: getApiKey(), timeout: MODEL_TIMEOUT_MS, maxRetries: 0 });
    const deadlineAt = Date.now() + MODEL_TIMEOUT_MS;
    const response = await withBackoff(
      () =>
        client.messages.create(
          {
            model: LEARN_MODEL,
            max_tokens: MAX_OUTPUT_TOKENS,
            temperature: 0,
            system: buildLearningSystemPrompt(),
            tools: [PROPOSAL_TOOL],
            tool_choice: { type: 'tool', name: 'propose_fix' },
            messages: [
              {
                role: 'user',
                content:
                  `MISS (outcome: ${group.outcome ?? 'unknown'}, asked ${group.count ?? 1}x across ` +
                  `${group.tenantCount ?? 1} shop(s)): "${question}"`,
              },
            ],
          },
          { timeout: Math.max(1000, deadlineAt - Date.now()) }
        ),
      { deadlineAt }
    );
    const usage = response.usage ?? {};
    const toolUse = response.content?.find((b) => b.type === 'tool_use');
    return {
      raw: toolUse?.input ?? null,
      usage: { inputTokens: Number(usage.input_tokens) || 0, outputTokens: Number(usage.output_tokens) || 0 },
    };
  } catch (err) {
    console.error('donovan-learning proposer: model call failed (non-fatal):', err?.message);
    return { skipped: 'model-error', error: err?.message };
  }
}

/**
 * Workstream A item 2 (learning/gapPromoter.js): the SAME Haiku call shape as callModelForGroup above,
 * but for a CLUSTER of up to 5 example questions (gapReport.js's own clusterFailures — the weekly
 * cross-tenant gap report) rather than one miss group: asks for ONE GENERALIZED fix that would help
 * EVERY example, not just one, so a proposal synthesized here is never overfit to a single shop's
 * wording. Never proposes abbreviation/typo from a cluster (those need one exact from/to word pulled
 * from a single question, not a generalization across several) — the tool schema is unchanged
 * (PROPOSAL_TOOL, above) but the system prompt narrows the model to synonym/few_shot/capability_gap
 * only, and the caller (gapPromoter.js) treats anything else as unusable.
 */
export async function callModelForCluster(capability, examples) {
  try {
    const client = new Anthropic({ apiKey: getApiKey(), timeout: MODEL_TIMEOUT_MS, maxRetries: 0 });
    const deadlineAt = Date.now() + MODEL_TIMEOUT_MS;
    const list = (examples ?? []).slice(0, 5).map((q, i) => `${i + 1}. "${q}"`).join('\n');
    const response = await withBackoff(
      () =>
        client.messages.create(
          {
            model: LEARN_MODEL,
            max_tokens: MAX_OUTPUT_TOKENS,
            temperature: 0,
            system: [
              'You help Donovan, an HVAC-shop assistant, close a capability gap seen across MULTIPLE shops.',
              'You are given several real questions that all failed the same way. Propose ONE generalized ' +
                "fix that would help EVERY example, not just one: kind='synonym' (a new plain-English noun " +
                "for an entity that already has a closed vocabulary) or kind='few_shot' (one representative " +
                'question paired with a valid, executable analytics plan). Only propose ' +
                "kind='capability_gap' if no such generalized fix exists — never guess a fix that would not " +
                'genuinely generalize across the examples given.',
              'Call propose_fix exactly once with your single best proposal.',
            ].join('\n'),
            tools: [PROPOSAL_TOOL],
            tool_choice: { type: 'tool', name: 'propose_fix' },
            messages: [{ role: 'user', content: `CAPABILITY: ${capability}\nFAILING EXAMPLES:\n${list}` }],
          },
          { timeout: Math.max(1000, deadlineAt - Date.now()) }
        ),
      { deadlineAt }
    );
    const usage = response.usage ?? {};
    const toolUse = response.content?.find((b) => b.type === 'tool_use');
    return {
      raw: toolUse?.input ?? null,
      usage: { inputTokens: Number(usage.input_tokens) || 0, outputTokens: Number(usage.output_tokens) || 0 },
    };
  } catch (err) {
    console.error('donovan-gap-promoter: model call failed (non-fatal):', err?.message);
    return { skipped: 'model-error', error: err?.message };
  }
}

/**
 * One candidate result, whatever its source: `{ source, kind, payload,
 * evidence, valid, reason }`. `kind`/`payload` are the VALIDATED, normalized
 * ones when `valid` is true; the best-effort raw ones (for the operator to
 * see what was tried) when false. `kind` is null only in the rare case a
 * model response couldn't even be parsed into one of the five known kinds.
 */
function toResult(source, kind, rawPayload, evidence) {
  const v = kind ? validateProposal(kind, rawPayload) : { ok: false, reason: 'no usable model output' };
  return {
    source,
    kind: v.ok ? v.proposal.kind : (PROPOSAL_KINDS.includes(kind) ? kind : null),
    payload: v.ok ? v.proposal.payload : rawPayload,
    evidence,
    valid: v.ok,
    reason: v.ok ? null : v.reason,
  };
}

/**
 * @param {Array<{question:string, outcome?:string, count?:number, tenantCount?:number, detectedConditions?:unknown}>} missGroups
 * @param {{maxModelCalls?: number}} [opts]  DONOVAN_LEARN_MAX_CALLS (default 20)
 *        this run may spend on the model pass — the deterministic pass is
 *        free and always runs on every group.
 * @returns {Promise<{proposals: object[], modelCallsMade: number, estimatedCostUsd: number}>}
 */
export async function proposeFixesForMisses(missGroups, { maxModelCalls = DEFAULT_MAX_MODEL_CALLS } = {}) {
  const proposals = [];
  const remaining = [];

  for (const group of missGroups ?? []) {
    const question = String(group?.question ?? '');
    if (!question) continue;
    const evidence = { questions: [question], count: group.count ?? 1, tenantCount: group.tenantCount ?? 1 };
    const dCands = deterministicCandidatesForQuestion(question);
    if (dCands.length) {
      for (const c of dCands) proposals.push(toResult('deterministic', c.kind, c.payload, evidence));
    } else {
      remaining.push({ ...group, question });
    }
  }

  let modelCallsMade = 0;
  let estimatedCostUsd = 0;
  const cap = Math.max(0, Number(maxModelCalls) || 0);

  for (const group of remaining) {
    if (modelCallsMade >= cap) break;
    const question = redactPII(group.question);
    const evidence = { questions: [question], count: group.count ?? 1, tenantCount: group.tenantCount ?? 1 };
    if (stillHasContactInfo(question)) {
      proposals.push({
        source: 'model', kind: null, payload: null, evidence,
        valid: false, reason: 'skipped: question still looks like it contains contact info after redaction',
      });
      continue;
    }

    modelCallsMade += 1;
    const result = await callModelForGroup(question, group);
    if (result.skipped) {
      proposals.push({
        source: 'model', kind: null, payload: null, evidence,
        valid: false, reason: `model call skipped/failed: ${result.skipped}${result.error ? ` (${result.error})` : ''}`,
      });
      continue;
    }
    estimatedCostUsd += estimateCostUsd(result.usage);
    const rawKind = result.raw?.kind;
    const payload = payloadFromModelInput(rawKind, result.raw);
    proposals.push(toResult('model', rawKind, payload, evidence));
  }

  if (modelCallsMade > 0) {
    console.log(
      `donovan-learning proposer: ${modelCallsMade} model call(s) (model=${LEARN_MODEL}), ` +
        `estimated cost $${estimatedCostUsd.toFixed(4)}.`
    );
  }

  return { proposals, modelCallsMade, estimatedCostUsd };
}
