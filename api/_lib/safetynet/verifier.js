/**
 * safetynet/verifier.js - the cheap second reader. Given ONLY the cited page text, the question and Donovan's answer it says agree / disagree / unsure.
 * Pure parts (prompt, parse, grounding of a suggested correction) are unit-tested with a stub provider; makeAnthropicVerifier is the only paid call.
 */
export const VERIFIER_SYSTEM = 'You check one answer against the page text it cites. Use ONLY the page text given. Reply with a single JSON object and nothing else: {"verdict":"agree"|"disagree"|"unsure","why":"wrong_value"|"wrong_field"|"wrong_doc"|"not_found"|"other","correct":"<exact text copied from the pages, or empty>"}. "agree" only if the answered value is on the page and answers the question; "disagree" if the page shows a different value, a different field, or the value is not there; "unsure" if the pages cannot settle it.';
const PAGE_CAP = 6000;

export function buildVerifierPrompt({ question, answerText, pages }) {
  const body = pages.map((p) => `--- page ${p.page} ---\n${String(p.text ?? '').slice(0, PAGE_CAP)}`).join('\n');
  return `Question: ${String(question).slice(0, 400)}\nDonovan's answer: ${String(answerText).slice(0, 600)}\n\nCited pages:\n${body}`;
}

/** Tolerant parse of the model's reply. Anything unreadable = unsure (never a false disagreement). */
export function parseVerdict(text) {
  const m = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!m) return { verdict: 'unsure', why: 'other', correct: '' };
  try {
    const o = JSON.parse(m[0]);
    const verdict = ['agree', 'disagree', 'unsure'].includes(o.verdict) ? o.verdict : 'unsure';
    const why = ['wrong_value', 'wrong_field', 'wrong_doc', 'not_found', 'other'].includes(o.why) ? o.why : 'other';
    return { verdict, why, correct: String(o.correct ?? '').slice(0, 200) };
  } catch { return { verdict: 'unsure', why: 'other', correct: '' }; }
}

const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
/** A suggested correction is only shown when it is copied verbatim from a cited page. */
export const groundedCorrection = (correct, pages) => { const c = norm(correct); return c.length >= 2 && pages.some((p) => norm(p.text).includes(c)) ? String(correct).trim() : ''; };

/** provider({system,user}) -> {text, usage}. Returns {verdict, why, correct, usage}. A provider error = unsure (an audit never throws). */
export async function verifyAnswer({ question, answerText, pages, provider }) {
  if (!pages?.length) return { verdict: 'unsure', why: 'not_found', correct: '', usage: null };
  try {
    const r = await provider({ system: VERIFIER_SYSTEM, user: buildVerifierPrompt({ question, answerText, pages }) });
    const v = parseVerdict(r?.text);
    return { ...v, correct: v.verdict === 'disagree' ? groundedCorrection(v.correct, pages) : '', usage: r?.usage ?? null };
  } catch { return { verdict: 'unsure', why: 'other', correct: '', usage: null, error: true }; }
}

/** The real provider (haiku, no tools, <= 120 output tokens). Imported lazily by hook.js only when an audit actually runs. */
export async function makeAnthropicVerifier(model) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const { getApiKey } = await import('../claude.js');
  return async ({ system, user }) => {
    const client = new Anthropic({ apiKey: getApiKey(), timeout: 15000, maxRetries: 0 });
    const res = await client.messages.create({ model, max_tokens: 120, system, messages: [{ role: 'user', content: user }] });
    const u = res.usage ?? {};
    return { text: res.content.filter((b) => b.type === 'text').map((b) => b.text).join(''), usage: { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheReadInputTokens: u.cache_read_input_tokens, cacheCreationInputTokens: u.cache_creation_input_tokens, model } };
  };
}
