/**
 * Round 28 — Support Assistant, the orchestrator. Pure of HTTP and of any database/SDK: everything it needs
 * from the outside arrives through `deps`, so scripts/verify-support-assistant.mjs drives it with mocks.
 *
 *   message -> hygiene -> sensitive? -> injection? -> small talk -> identity -> human request
 *           -> competitor comparison -> account lookup -> records question (-> Donovan) -> FAQ ($0)
 *           -> weak records signal -> trade how-to / off-topic -> [model, only if allowed] -> canned fallback
 *
 * The first nine steps and the FAQ are free. The model is reached only for an on-topic question the FAQ could
 * not answer, only when a dedicated key exists, the kill switch is off and every $ cap has room.
 */
import { PRICES, ENTRIES, ARTICLES, MODEL_KB, MODEL_KB_PUBLIC } from './kb.generated.js';
import { LIMITS, CANNED, STARTERS, SOURCES_ACCOUNT, SUPPORT_EMAIL } from './policy.js';
import {
  sanitizeInput, detectSensitive, detectInjection, detectSmalltalk, detectIdentity, detectHumanRequest,
  detectHandoffTrigger, detectRecordsStrong, detectRecordsWeak, detectCompetitorComparison, detectTradeHowTo,
  detectOffTopic, hasDeepwellLexicon, detectAccountIntent, validateModelReply, cleanLinksAndMarkup, defang, capWords,
} from './guard.js';
import { matchFaq, suggestionsFor, contactEntry, articleById, PUBLIC_ARTICLES } from './faq.js';
import { buildRequest, sanitizeHistory, RULES_SHINGLES } from './prompt.js';
import { estimateTokens } from '../promptCache.js';
import { SYSTEM_TEXT } from './prompt.js';

const SURFACE_SET = new Set(['public', 'app', 'mobile']);

const bold = (s) => `**${s}**`;
const fmt = (n) => Number(n).toLocaleString('en-US');
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Worst-case cost of a model turn from the request size (cold cache write at the 1h rate + full output). Pure. */
export function estimateTurnCostUsd(request) {
  const inTok = estimateTokens(JSON.stringify(request.system)) + estimateTokens(JSON.stringify(request.tools)) + estimateTokens(JSON.stringify(request.messages));
  return (inTok * 2 * 1 + (request.max_tokens ?? 350) * 5) / 1_000_000; // $1/MTok in (x2 for a 1h write), $5/MTok out
}

function reply(mode, text, extra = {}) {
  return { reply: text, sources: [], mode, ...extra };
}

function withSuggestions(body, list) {
  const s = (list ?? []).filter((x) => typeof x === 'string' && x && x.length <= 70).slice(0, 3);
  return s.length ? { ...body, suggestions: s } : body;
}

export function starter(surface) {
  const s = STARTERS[SURFACE_SET.has(surface) ? surface : 'public'];
  return { greeting: s.greeting, suggestions: [...s.suggestions] };
}

/** Did the previous assistant turn already fail to help? (two misses in a row -> offer a person) */
function lastAssistantWasMiss(history) {
  const last = [...sanitizeHistory(history, 6)].reverse().find((h) => h.role === 'assistant');
  return Boolean(last && (last.text.startsWith("I'm not sure about that one") || last.text.startsWith('I can only help with questions about DeepWell')));
}

function handoff(reason) { return { handoff: { offered: true, reason } }; }

/* ------------------------------------------------------------------ account replies ($0, signed-in only) */

function planLine(plan) {
  const p = plan.plan ? PRICES.plans[plan.plan] : null;
  return p ? `${bold(p.name)} plan ($${fmt(p.monthly)}/month)` : null;
}

const STATE_WORDS = { trialing: 'in its free trial', active: 'active', past_due: 'past due', canceled: 'canceled', none: 'not subscribed yet' };

export function renderAccountReply(intent, plan, uploads) {
  if (intent === 'usage') {
    const pages = plan.pagesAllowance == null ? `${fmt(plan.pagesLast30d)} new pages in the last 30 days` : `${bold(`${fmt(plan.pagesLast30d)} of ${fmt(plan.pagesAllowance)}`)} new pages in the last 30 days`;
    const docs = plan.documentsCap == null ? `${fmt(plan.documentsStored)} documents stored (no storage cap on your plan)` : `${fmt(plan.documentsStored)} of ${fmt(plan.documentsCap)} documents stored`;
    return plan.plan ? `You've used ${pages}. ${cap(docs)}. Donovan questions don't count against these.` : 'You have no active plan yet, so there is no allowance to show. Open Billing to choose a plan.';
  }
  if (intent === 'plan') {
    const pl = planLine(plan);
    if (!pl) return 'Your account has no active plan yet. Open **Billing** in the app to choose one.';
    const logins = plan.loginCap == null ? 'no DeepWell login cap' : `up to ${plan.loginCap} logins (the owner account is not counted)`;
    return `You're on the ${pl}, ${STATE_WORDS[plan.state] ?? plan.state}. It includes ${logins}, ${plan.pagesAllowance ? fmt(plan.pagesAllowance) : 'your'} new pages a month, and unlimited Donovan.${plan.apiAccess ? ' API access is included.' : ''}`;
  }
  if (intent === 'billing') {
    if (!plan.canSeeBilling) return 'Billing dates are visible to your shop admin. Ask them to open **Billing**, where the plan, status and renewal date are shown.';
    const pl = planLine(plan);
    if (!pl) return 'Your account has no active plan yet. Open **Billing** to choose one.';
    const bits = [`Your ${pl} is ${STATE_WORDS[plan.state] ?? plan.state}.`];
    if (plan.state === 'trialing' && plan.trialEndsAt) bits.push(`Your free trial ends on ${bold(plan.trialEndsAt)}, and the card on file is charged after that unless you cancel.`);
    else if (plan.currentPeriodEnd) bits.push(`The current period ends on ${bold(plan.currentPeriodEnd)}.`);
    bits.push('Admins can see invoices and change the card in **Billing → Manage billing**.');
    return bits.join(' ');
  }
  if (intent === 'uploads') {
    if (!uploads || uploads.total === 0) return 'I don\'t see any documents uploaded in the last 7 days. If you just uploaded something, give it a minute and check **Inbox**.';
    const s = uploads.byStage;
    const stages = `received ${s.received}, read ${s.read}, mapped ${s.mapped}, linked ${s.linked}, verified ${s.verified}`;
    const q = uploads.openQuestions == null ? '' : uploads.openQuestions > 0 ? ` ${bold(String(uploads.openQuestions))} ${uploads.openQuestions === 1 ? 'has' : 'have'} an open question waiting for you in **Inbox**.` : ' Nothing is waiting on you.';
    return `In the last 7 days you uploaded ${bold(String(uploads.total))} ${uploads.total === 1 ? 'document' : 'documents'}: ${stages}.${q} A document that sits at "received" for more than about 15 minutes is worth reporting to support.`;
  }
  return null;
}

/* ------------------------------------------------------------------ main entry */

/**
 * @param {{message: string, history?: any[], surface: string, page?: string, turn?: number, auth?: object|null}} input
 * @param {{
 *   tools?: {getPlanAndUsage: Function, getRecentUploadStatus: Function},
 *   model?: {enabled: () => boolean, call: (request: object) => Promise<any>, id?: string, priceUsd: (usage: object) => number},
 *   budget?: {gate: (p: object) => Promise<{allowed: boolean, reason?: string}>, record: (p: object) => Promise<any>},
 * }} deps
 * @returns {Promise<{body: object, meta: object}>}
 */
export async function respond(input, deps = {}) {
  const surface = SURFACE_SET.has(input.surface) ? input.surface : 'public';
  const signedIn = surface !== 'public' && Boolean(input.auth);
  const message = sanitizeInput(input.message).slice(0, LIMITS.maxChars);
  const meta = { path: 'faq', modelCalled: false, usd: 0, faqId: null, reason: null, surface };
  const done = (body, path, extra = {}) => { Object.assign(meta, { path }, extra); return { body: body.sources ? body : { ...body, sources: [] }, meta }; };

  // 0. conversation length (server side; the client also stops sending)
  const userTurnsInHistory = (Array.isArray(input.history) ? input.history : []).filter((h) => h?.role === 'user').length;
  const turn = Number.isFinite(Number(input.turn)) ? Math.max(0, Math.trunc(Number(input.turn))) : 0;
  if (Math.max(userTurnsInHistory, turn) >= LIMITS.maxUserTurns) {
    return done(withSuggestions(reply('guard', CANNED.turnLimit, handoff('turn-limit')), []), 'guard', { reason: 'turn-limit' });
  }

  // 1. sensitive data: refuse before anything else looks at it
  if (detectSensitive(message)) return done(reply('guard', CANNED.sensitive), 'guard', { reason: 'sensitive' });

  // 2. injection screens
  if (detectInjection(message)) return done(reply('guard', CANNED.injection), 'guard', { reason: 'injection' });

  // 3. small talk
  const small = detectSmalltalk(message);
  if (small) {
    if (small === 'greeting' || small === 'empty') {
      const st = starter(surface);
      return done(withSuggestions(reply('faq', CANNED.greeting), st.suggestions), 'faq', { faqId: 'smalltalk' });
    }
    if (small === 'thanks') return done(reply('faq', CANNED.thanks), 'faq', { faqId: 'smalltalk' });
    if (small === 'bye') return done(reply('faq', CANNED.bye), 'faq', { faqId: 'smalltalk' });
    return done(reply('faq', 'Sure. What would you like to know about DeepWell?'), 'faq', { faqId: 'smalltalk' });
  }

  // 4. "are you a bot / which model"
  if (detectIdentity(message)) return done(withSuggestions(reply('guard', CANNED.identity, handoff('asked-human')), []), 'guard', { reason: 'identity' });

  // 5. wants a person
  if (detectHumanRequest(message)) {
    const c = contactEntry();
    return done(withSuggestions(reply('faq', CANNED.humanAsk, { ...handoff('asked-human'), sources: c ? [{ id: c.article, title: articleById(c.article)?.title ?? 'Contacting the DeepWell team' }] : [] }), ['How fast will support respond?', 'How do I contact DeepWell?']), 'faq', { faqId: 'human' });
  }

  // 6. competitor comparisons are declined before the FAQ can mis-hit on them
  if (detectCompetitorComparison(message)) return done(withSuggestions(reply('guard', CANNED.competitor), ['How much does DeepWell cost?', 'What is included in every plan?']), 'guard', { reason: 'competitor' });

  // 7. account lookups (signed in only, read-only, $0)
  const acctIntent = detectAccountIntent(message);
  // Signed-out visitors can't get an account lookup, but the same words are often a general question
  // ("when will I be charged after the trial?"): let the FAQ try first and only then ask them to sign in.
  const needSignIn = Boolean(acctIntent) && (!signedIn || !deps.tools);
  if (acctIntent && !needSignIn) {
    try {
      const needPlan = acctIntent !== 'uploads';
      const [plan, uploads] = await Promise.all([needPlan ? deps.tools.getPlanAndUsage(input.auth) : null, acctIntent === 'uploads' ? deps.tools.getRecentUploadStatus(input.auth) : null]);
      const text = renderAccountReply(acctIntent, plan ?? {}, uploads);
      if (text) return done(withSuggestions(reply('faq', text, { sources: [SOURCES_ACCOUNT] }), acctIntent === 'uploads' ? ['What does needs review mean?', 'How long until an upload is searchable?'] : ['What happens when I reach my page limit?', 'How do I upgrade my plan?']), 'faq', { faqId: `account:${acctIntent}` });
    } catch {
      return done(withSuggestions(reply('fallback', "I couldn't look that up just now. You can see it in **Billing** in the app, or I can pass it to the team.", handoff('lookup-failed')), []), 'fallback', { reason: 'lookup-failed' });
    }
  }

  // 8. a specific customer's own record -> Donovan
  const recStrong = detectRecordsStrong(message);
  if (recStrong) return done(reply('redirect', signedIn ? CANNED.recordsRedirectApp : CANNED.recordsRedirectPublic, { redirectTo: 'ask' }), 'redirect', { reason: `records:${recStrong}` });

  // 9. the free FAQ
  const faq = matchFaq(message, { allowApp: signedIn });
  const trig = detectHandoffTrigger(message);
  if (faq.hit) {
    const { entry, article } = faq.hit;
    let body = reply('faq', entry.a, { sources: [{ id: article.id, title: article.title }] });
    const reason = entry.handoff ?? trig;
    if (reason) body = { ...body, ...handoff(reason) };
    return done(withSuggestions(body, suggestionsFor(entry, { allowApp: signedIn })), 'faq', { faqId: entry.id, score: Math.round(faq.hit.score * 100) / 100 });
  }

  // an app-only topic asked by a signed-out visitor: never the app article, only a pointer + the public overview
  if (faq.appOnly) {
    const ov = articleById(APP_ONLY_OVERVIEW[faq.appOnly.article] ?? 'what-is-deepwell');
    const chips = ENTRIES.filter((e) => e.article === ov.id && e.audience !== 'app').map((e) => e.q).filter((q) => q.length <= 60).slice(0, 3);
    return done(withSuggestions(reply('faq', `That one is covered inside the DeepWell app once you are signed in. For the public overview, see "${ov.title}", or I can pass your question to the team.`, { ...handoff('app-only-topic'), sources: [{ id: ov.id, title: ov.title }] }), chips), 'faq', { faqId: 'app-only', reason: `app-only:${faq.appOnly.article}` });
  }

  if (needSignIn) return done(reply('faq', CANNED.signInForAccount, { sources: [] }), 'faq', { faqId: 'account-signin' });

  // 10. weaker "this is about my own data" signal
  if (detectRecordsWeak(message)) return done(reply('redirect', signedIn ? CANNED.recordsRedirectApp : CANNED.recordsRedirectPublic, { redirectTo: 'ask' }), 'redirect', { reason: 'records:weak' });

  // 11. trade how-to and plainly off-topic
  const near = faq.top.filter((t) => t.score >= 1.6).slice(0, 2).map((t) => t.entry.q);
  const missAgain = lastAssistantWasMiss(input.history);
  if (detectTradeHowTo(message)) return done(withSuggestions(reply('guard', CANNED.hvacHowTo, missAgain ? handoff('repeat-miss') : {}), ['How does DeepWell work?']), 'guard', { reason: 'trade-howto' });
  const lexicon = hasDeepwellLexicon(message);
  if (detectOffTopic(message) || !lexicon) {
    return done(withSuggestions(reply('guard', CANNED.offTopic, missAgain ? handoff('repeat-miss') : {}), starter(surface).suggestions.slice(0, 3)), 'guard', { reason: 'off-topic' });
  }

  // 12. on-topic but the FAQ could not answer: the optional model
  const model = deps.model;
  if (model?.enabled?.() && deps.budget) {
    const pub = surface === 'public' || !input.auth;
    const wantsAccount = signedIn && deps.tools && /\b(?:plan|billing|invoice|page|pages|upload|trial|login|logins|seat|seats|limit|usage|renew|subscription|account)\b/i.test(message);
    let accountContext = null;
    if (wantsAccount) {
      try {
        const [p, u] = await Promise.all([deps.tools.getPlanAndUsage(input.auth), deps.tools.getRecentUploadStatus(input.auth)]);
        accountContext = toModelContext(p, u);
      } catch { accountContext = null; }
    }
    const request = buildRequest({ message, history: input.history, surface, page: input.page, accountContext, model: model.id, publicSurface: !signedIn });
    const estimate = estimateTurnCostUsd(request);
    if (estimate > LIMITS.perTurnMaxUsd) {
      meta.reason = 'turn-cost-cap';
    } else {
      const gate = await deps.budget.gate({ surface, auth: input.auth ?? null });
      if (!gate.allowed) {
        meta.reason = gate.reason ?? 'budget';
      } else {
        const res = await model.call(request);
        meta.modelCalled = true;
        if (res?.ok) {
          const usd = model.priceUsd(res.usage);
          meta.usd = usd;
          meta.usage = res.usage;
          meta.latencyMs = res.latencyMs;
          try { await deps.budget.record({ surface, auth: input.auth ?? null, usd }); } catch { /* best effort */ }
          const out = interpretModelOutput(res.input, { accountUsed: Boolean(accountContext), meta, pub: !signedIn });
          if (out) return done(withSuggestions(out.body, out.suggestions), 'model', {});
        } else {
          meta.reason = `model-${res?.error ?? 'error'}`;
        }
      }
    }
  } else if (!model?.enabled?.()) {
    meta.reason = 'model-off';
  }

  // 13. deterministic fallback: honest, free, offers a person
  const body = reply('fallback', CANNED.fallback, handoff(missAgain ? 'repeat-miss' : 'no-answer'));
  return done(withSuggestions(body, near), 'fallback', {});
}

const CAP_WORDS_PUBLIC = capWords(`${MODEL_KB_PUBLIC}\n${Object.values(CANNED).join('\n')}\n${ARTICLES.filter((a) => PUBLIC_ARTICLES.has(a.id)).map((a) => a.title).join('\n')}`);
const CAP_WORDS_FULL = capWords(`${MODEL_KB}\n${Object.values(CANNED).join('\n')}\n${ARTICLES.map((a) => a.title).join('\n')}`);

/** Public overview article to point a signed-out visitor to, per app-only article (audience enforcement, faq.js). */
const APP_ONLY_OVERVIEW = Object.freeze({
  'signing-in-and-logins': 'plans-and-pricing',
  'change-cancel-plan-invoices': 'trial-and-billing-dates',
  'uploading-and-scanning-web': 'what-is-deepwell',
  'scan-status-and-needs-info': 'what-is-deepwell',
  'exports-and-warranty-export': 'what-is-deepwell',
  'team-and-notifications': 'what-is-deepwell',
  'support-access-grants': 'security-and-privacy',
  'data-export-and-deletion': 'security-and-privacy',
  troubleshooting: 'contacting-humans',
});

/** The small fixed-key context object handed to the model (never free text; no ids, names or filenames). */
export function toModelContext(plan, uploads) {
  const o = {};
  if (plan) o.plan = { plan: plan.plan, state: plan.state, loginCap: plan.loginCap, pagesLast30d: plan.pagesLast30d, pagesAllowance: plan.pagesAllowance, documentsStored: plan.documentsStored, documentsCap: plan.documentsCap, apiAccess: plan.apiAccess, trialEndsAt: plan.trialEndsAt, currentPeriodEnd: plan.currentPeriodEnd };
  if (uploads) o.uploads = uploads;
  return o;
}

/** Turn the model's structured reply into a response body, or null to use the canned fallback. */
function interpretModelOutput(input, { accountUsed, meta, pub = true }) {
  if (!input || typeof input !== 'object') { meta.reason = 'model-no-output'; return null; }
  const scope = input.scope;
  if (scope === 'off_topic') return { body: reply('guard', CANNED.offTopic), suggestions: [] };
  if (scope === 'donovan') return { body: reply('redirect', CANNED.recordsRedirectApp, { redirectTo: 'ask' }), suggestions: [] };
  if (scope === 'handoff') { meta.reason = 'model-handoff'; return null; }
  if (scope !== 'in_scope') { meta.reason = 'model-bad-scope'; return null; }
  const ids = (Array.isArray(input.article_ids) ? input.article_ids : []).map(String).filter((id) => { const a = articleById(id); return a && (!pub || PUBLIC_ARTICLES.has(a.id)); });
  if (ids.length === 0 && !accountUsed) { meta.reason = 'model-no-citation'; return null; }
  const v = validateModelReply(input.answer, { allowedAmounts: PRICES.allowedAmounts, promptShingles: RULES_SHINGLES, knownCapWords: pub ? CAP_WORDS_PUBLIC : CAP_WORDS_FULL });
  if (!v.ok) { meta.reason = `validator:${v.reason}`; return null; }
  const sources = [...new Set(ids)].slice(0, 2).map((id) => ({ id, title: articleById(id).title }));
  if (accountUsed && sources.length === 0) sources.push(SOURCES_ACCOUNT);
  const sugg = (Array.isArray(input.suggestions) ? input.suggestions : [])
    .map((s) => cleanLinksAndMarkup(defang(String(s))).slice(0, 70)).filter((s) => s.length > 3 && !/[@$]|https?:/i.test(s)).slice(0, 3);
  return { body: reply('model', v.text, { sources }), suggestions: sugg };
}

export { SUPPORT_EMAIL, SYSTEM_TEXT };
