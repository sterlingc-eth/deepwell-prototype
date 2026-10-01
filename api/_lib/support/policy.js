/**
 * Round 28 — DeepWell Support Assistant: every number and every canned string in one place.
 * Pure, no imports, safe to load anywhere (the verify script imports it directly).
 *
 * COST MODEL (why the caps are what they are): the deterministic path (guard -> scope router -> FAQ
 * matcher) costs $0. The optional Haiku path costs about $0.004 per warm turn and about $0.02 for a cold
 * cache write (KB prefix ~8k tokens, see handoffs/SUPPORT_ASSISTANT_R28.md). Every $ cap below is a
 * *stop the model, keep answering from the FAQ* switch, never a hard error for the visitor.
 */

export const SUPPORT_EMAIL = 'support@deepwelltechnology.com';
export const SALES_EMAIL = 'hello@deepwelltechnology.com';
export const CONTACT_EMAILS = Object.freeze(['hello', 'support', 'billing', 'privacy', 'security'].map((n) => `${n}@deepwelltechnology.com`));
export const ALLOWED_LINK_HOSTS = Object.freeze(['deepwelltechnology.com', 'www.deepwelltechnology.com']);

export const SURFACES = Object.freeze(['public', 'app', 'mobile']);

export const LIMITS = Object.freeze({
  maxChars: 600,            // one user message
  maxUserTurns: 12,         // per conversation (server enforces via `turn` and history length)
  maxHistoryAccepted: 24,   // entries accepted from the client (it sends the last 6)
  historyToModel: 6,        // entries forwarded to the model
  historyEntryChars: 600,
  maxTokens: 350,           // model output cap (design: 350 authenticated / 250 public)
  maxTokensPublic: 250,
  modelTimeoutMs: 15_000,
  maxReplyChars: 1200,      // validator: longer model replies are dropped
  perTurnMaxUsd: 0.04,      // never START a model call whose estimated worst case exceeds this
  handoffTranscriptTurns: 12,
  handoffTranscriptChars: 600,
  handoffMessageChars: 2000,
  handoffNameChars: 100,
});

/** Request-rate limits. Overridable per env: SUPPORT_PUBLIC_PER_MINUTE/PER_DAY and (app) RATE_LIMIT_SUPPORT_PER_MINUTE/PER_DAY. */
export const RATE = Object.freeze({
  publicPerMinute: 8,
  publicPerDay: 60,
  appPerMinute: 8,
  appPerDay: 200,
  handoffPublicPerDay: 3,   // per IP
  handoffAppPerDay: 5,      // per user
  clientErrorPerDay: 30,    // browser error reports per user (SUPPORT_CLIENT_ERROR_PER_DAY)
});

/** $ caps for the MODEL path only. Env-overridable (names in `env`). 0 disables the model for that scope. */
export const SPEND = Object.freeze({
  tenantDailyUsd: 0.5,      // SUPPORT_DAILY_USD          (planner/spend.js ROUTE_BUCKETS.support)
  tenantMonthlyUsd: 8,      // SUPPORT_MONTHLY_USD
  platformDailyUsd: 25,     // SUPPORT_PLATFORM_DAILY_USD (authenticated, all tenants)
  publicDailyUsd: 5,        // SUPPORT_PUBLIC_DAILY_USD   (no-tenant pool for website visitors)
});

export const MODEL = Object.freeze({
  id: 'claude-haiku-4-5',
  temperature: 0,
});

/** Random-looking marker planted in the system prompt; if it ever shows up in a reply, the reply is discarded. */
export const CANARY = 'dw-canary-9f3c1a7e42b8';

/* ------------------------------------------------------------------ canned replies */

export const CANNED = Object.freeze({
  greeting: "Hi, I'm the DeepWell Support Assistant, an AI. I can answer questions about DeepWell: plans and pricing, setup, uploading and scanning, the phone app, Donovan, security and billing.",
  thanks: "You're welcome. Anything else about DeepWell I can help with?",
  bye: 'Thanks for stopping by. If you need anything else, I am here, or you can email support@deepwelltechnology.com.',
  identity: "I'm the DeepWell Support Assistant, an AI assistant that answers questions about DeepWell. I can't share how I'm built. If you'd rather talk to a person, I can pass your question to the team.",
  offTopic: 'I can only help with questions about DeepWell: plans and pricing, setup, uploading and scanning, the phone app, Donovan, security, billing and how to reach the team. For anything else, a general search or assistant will serve you better.',
  hvacHowTo: "I can't help with HVAC or trade how-to questions. I only answer questions about DeepWell, the records software. I can tell you how DeepWell finds information in your service records, if that helps.",
  competitor: "I can't compare DeepWell with other products or talk about their pricing, but I can tell you exactly what DeepWell does and costs. What would you like to know?",
  injection: "I can only help with questions about DeepWell, and I can't change how I work or share my instructions. What would you like to know about DeepWell?",
  sensitive: "Please don't share card numbers, Social Security numbers or passwords in this chat. I've ignored that message and it won't be sent anywhere. If you have a billing question, ask it without the number, or email billing@deepwelltechnology.com.",
  tooLong: 'Please keep your message under 600 characters.',
  turnLimit: "We've reached the length limit for one chat. To keep going, start a new chat, or I can pass this conversation to the team so a person can pick it up by email.",
  signInForAccount: "I can look up your plan, usage and upload status when you're signed in. Open the DeepWell app and ask me there. Here I can only answer general questions about DeepWell.",
  recordsRedirectApp: "That's a question about your own records, so Donovan is the right place for it, and it will show you the source document. Open **Ask** and type it there. I can help with questions about how DeepWell works.",
  recordsRedirectPublic: "That's a question about a customer's own records. Donovan answers those inside the DeepWell app, with the source document attached, once you're signed in. This chat only covers DeepWell itself, such as plans, setup and security.",
  negotiate: "Prices are the ones published on the pricing page, and I can't offer discounts, credits, free periods or custom terms, or confirm any. If you'd like to talk about volume or special circumstances, I can pass your request to the team.",
  commitments: "I can't make promises, guarantees or legal commitments for DeepWell, and I can't speculate about future features or dates. I can tell you what is published today, including what is marked coming soon. For contracts, service levels, liability or compliance questions, I can pass you to the team.",
  personal: "I don't share personal details about the people at DeepWell. The website covers who the founders are, and you can reach the team at hello@deepwelltechnology.com.",
  internal: "I don't have, and can't share, DeepWell's internal business details such as revenue, costs, staffing, infrastructure or other customers. I can tell you what is published: plans and prices, security and privacy, and how to reach the team.",
  secrets: "I don't have access to keys, passwords or system settings, and I can't share them. If you need help with your own account, I can pass your question to the team.",
  industryFitRegulated: "DeepWell reads paperwork for any business, but it has no SOC 2 or equivalent certification and no independent audit yet, so please don't assume it is the right place for regulated patient or privileged client records. For compliance questions the team can answer directly, and I can pass your question to them.",
  fallback: "I'm not sure about that one. Want me to pass it to the team? They reply by email.",
  modelUnavailable: "I'm not sure about that one. Want me to pass it to the team? They reply by email.",
  humanAsk: 'Yes, a person can take it from here. Choose **Send to a person** below and add your email, and the team will reply by email. You can also write to support@deepwelltechnology.com.',
  rateMinute: 'You are sending messages a little fast. Please wait a moment and try again.',
  rateDay: "You've reached today's message limit for this chat. Please try again tomorrow, or email support@deepwelltechnology.com.",
});

export const STARTERS = Object.freeze({
  public: {
    greeting: "Hi, I'm the DeepWell Support Assistant, an AI. Ask me about plans and pricing, how setup works, the phone app or security. If I can't help, I can pass you to the team.",
    suggestions: ['How much does DeepWell cost?', 'Is there a free trial?', 'How does DeepWell work?', 'Is my data secure?'],
  },
  app: {
    greeting: "Hi, I'm the DeepWell Support Assistant, an AI. I can help with uploading, scanning, plans and billing, logins and security. Questions about your own customers or equipment belong in Ask (Donovan).",
    suggestions: ['How do I upload documents?', 'How do I invite a technician?', 'How many pages have I used this month?', 'How do I contact support?'],
  },
  mobile: {
    greeting: "Hi, I'm the DeepWell Support Assistant, an AI. I can help with scanning, installing the app and account questions. Questions about your own customers or equipment belong in Ask (Donovan).",
    suggestions: ['How do I scan paperwork with my phone?', 'How do I install the app on iPhone?', 'Why is my upload stuck?', 'How do I contact support?'],
  },
});

export const SOURCES_ACCOUNT = Object.freeze({ id: 'account', title: 'Your account' });
