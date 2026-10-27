/**
 * "Try your own documents" (public demo, /demo/): every number and every visitor-facing string lives here, so the limits are
 * stated once and the report / tests read the same values the route enforces.
 *
 * What this feature is: a visitor with NO account uploads up to 3 papers; they are read once with the SAME reading steps the real app
 * uses (the PDF's own text layer, then the license barcode, then Haiku vision only for scans and photos), shown back as a document
 * type + fields + a short summary, and the visitor may ask Donovan up to 5 questions about them. Nothing is kept: the bytes go to a
 * temporary object (deleted as soon as they are read, and deleted in the read itself, with a sweep of anything older than 10 minutes behind it) and the results exist only in the
 * visitor's browser tab. It never touches a tenant's tables.
 *
 * Every limit can be tightened from the environment (names in the report); a missing / bad value falls back to the default here,
 * and the master switch DEMO_TRYOWN_ENABLED ships OFF.
 */

export const LIMITS = Object.freeze({
  maxFiles: 3,
  maxPagesTotal: 10,
  maxFileBytes: 15 * 1024 * 1024,
  maxQuestions: 5,
  /** Types the visitor may upload. HEIC / TIFF / GIF / Office files are refused with a friendly note. */
  types: Object.freeze(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']),
});

/** Defaults; each is overridable by the named environment variable (positive numbers only). */
export const DEFAULTS = Object.freeze({
  uploadsPerHour: 3, // per IP, and separately per browser session
  uploadsPerDay: 10, // per IP, and separately per browser session
  questionsPerIpPerDay: 20, // the per-session cap is LIMITS.maxQuestions
  globalUploadsPerDay: 300, // every visitor together: bounds compute even when a read costs $0
  dailyUsd: 3, // the global spend cap for the whole demo, per UTC day
  requestBudgetMs: 55_000, // one read / one question must finish inside this
  tempMaxAgeMs: 10 * 60_000, // temporary objects older than this are deleted by the sweep (the sweep runs on every upload / read, and hourly from the cron)
  uploadUrlSeconds: 120, // the signed upload link stops working 2 minutes after it is issued
  ctxTtlMs: 4 * 3_600_000, // how long a signed question context is honoured
});

const posNum = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : undefined; };

export function resolveConfig(env = process.env) {
  return {
    enabled: env?.DEMO_TRYOWN_ENABLED === '1',
    uploadsPerHour: posNum(env?.DEMO_TRYOWN_UPLOADS_PER_HOUR) ?? DEFAULTS.uploadsPerHour,
    uploadsPerDay: posNum(env?.DEMO_TRYOWN_UPLOADS_PER_DAY) ?? DEFAULTS.uploadsPerDay,
    questionsPerIpPerDay: posNum(env?.DEMO_TRYOWN_QUESTIONS_PER_IP_DAY) ?? DEFAULTS.questionsPerIpPerDay,
    globalUploadsPerDay: posNum(env?.DEMO_TRYOWN_GLOBAL_UPLOADS_PER_DAY) ?? DEFAULTS.globalUploadsPerDay,
    dailyUsd: posNum(env?.DEMO_TRYOWN_DAILY_USD) ?? DEFAULTS.dailyUsd,
    // Haiku only. A value that does not name a Haiku model is ignored.
    model: /haiku/i.test(String(env?.DEMO_TRYOWN_MODEL ?? '')) ? String(env.DEMO_TRYOWN_MODEL) : 'claude-haiku-4-5',
    secret: typeof env?.DEMO_TRYOWN_SECRET === 'string' && env.DEMO_TRYOWN_SECRET.length >= 16 ? env.DEMO_TRYOWN_SECRET : null,
  };
}

/** Haiku list price, USD per million tokens (the same env names usage.js reads, so a price change is made in one place). */
export function haikuPrice(env = process.env) {
  return {
    input: posNum(env?.AI_COST_HAIKU_INPUT_PER_MTOK) ?? 1,
    output: posNum(env?.AI_COST_HAIKU_OUTPUT_PER_MTOK) ?? 5,
  };
}

/** USD for one model response's usage. */
export function usdFor(usage, env = process.env) {
  const p = haikuPrice(env);
  const inTok = Number(usage?.inputTokens ?? usage?.input_tokens ?? 0) || 0;
  const outTok = Number(usage?.outputTokens ?? usage?.output_tokens ?? 0) || 0;
  return (inTok * p.input + outTok * p.output) / 1_000_000;
}

/**
 * The most one read request can cost, from the hard caps in the code: transcription max_tokens (8000 PDF / 3000 image) and the
 * extraction call's 4000, plus generous input allowances. Used ONLY to refuse a read when today's remaining budget is below it
 * (so the cap can be overrun by at most the requests already in flight); the amount actually recorded is the real usage.
 */
export function worstCaseReadUsd(fileCount, env = process.env) {
  const p = haikuPrice(env);
  const perFile = (20_000 * p.input + 8_000 * p.output) / 1_000_000 // vision read: ~20k in, 8k out at the caps
    + (20_000 * p.input + 4_000 * p.output) / 1_000_000; // extraction read: ~20k in, 4k out at the caps
  return Math.max(1, fileCount) * perFile;
}
export const worstCaseAskUsd = (env = process.env) => { const p = haikuPrice(env); return (14_000 * p.input + 600 * p.output) / 1_000_000; };

/* ------------------------------------------------------------------ visitor-facing strings (the report lists them all) */
export const TEXT = Object.freeze({
  notice: 'Your files are read once to show you how DeepWell works and are not kept.',
  panelTitle: 'Try your own documents',
  panelIntro: 'Upload up to 3 of your own papers (PDF or photo, 10 pages in all). DeepWell reads them and you can ask Donovan about them.',
  dropHint: 'Choose files or drop them here',
  accepted: 'PDF, JPEG, PNG or WebP · up to 3 files · 10 pages in all · 15 MB each',
  readButton: 'Read my documents',
  again: 'Try different documents',
  working: 'Reading your documents…',
  stages: ['Uploading', 'Reading pages', 'Finding fields', 'Writing a summary'],
  resultsTitle: 'What DeepWell found',
  fieldsTitle: 'Fields found',
  summaryTitle: 'Summary',
  readHow: { text: 'Read from the PDF text', barcode: 'Read from the license barcode', vision: 'Read from the scan', mixed: 'Read from text and scan' },
  askTitle: 'Ask Donovan about your documents',
  askPlaceholder: 'Ask about your documents',
  askButton: 'Ask',
  questionsLeft: (n) => `${n} ${n === 1 ? 'question' : 'questions'} left`,
  noQuestionsLeft: 'You have used all 5 questions. Start over to try again.',
  hidden: 'Hidden for privacy',
  maskedNote: 'Birth dates and ID, account and card numbers are never shown. Only the last 4 characters of a number appear.',
  notFound: "I couldn't find that in your documents.",
  unavailable: 'The live document demo is resting right now. The sample workspaces still work.',
  capReached: 'The live document demo has reached its limit for today. The sample workspaces still work, and it opens again tomorrow.',
  slowDown: 'You have tried a lot of uploads in a short time. Please wait a little and try again.',
  slowDownQuestions: 'That is a lot of questions in a short time. Please try again later.',
  busy: 'This took longer than expected. Please try again with a smaller file.',
  generic: 'Something went wrong reading those files. Please try again.',
  tooManyFiles: 'Please choose up to 3 files.',
  tooManyPages: 'Those files have more than 10 pages in all. Please choose fewer or shorter files.',
  tooBig: 'One of those files is larger than 15 MB.',
  wrongType: 'Please choose a PDF or a photo (JPEG, PNG or WebP).',
  heic: 'That looks like an iPhone HEIC photo. Please choose a JPEG or PNG instead.',
  emptyFile: 'One of those files is empty.',
  unreadable: 'DeepWell could not read any text on that file.',
  expired: 'That upload expired. Please choose your files again.',
  declined: {
    sensitive: "DeepWell doesn't show birth dates or ID, account and card numbers, so there is nothing to look up.",
    injection: 'I only answer questions about the documents you just uploaded.',
    outside: 'I only have the documents you just uploaded, so I cannot tell you about anything else.',
    other: 'I can only answer questions about the facts written in your documents.',
  },
});
