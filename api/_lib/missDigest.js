/**
 * Donovan self-learning loop, Tier 1 (handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md):
 * a DAILY MISS DIGEST for the DeepWell platform owners — NOT a tenant-facing
 * feature. api/_lib/missStore.js's ask_misses rows are per-tenant (a shop's
 * own admin sees only their own misses, via api/review.js's `missReport`);
 * this file is the cross-tenant view of the same table, for the people who
 * actually improve Donovan's code and question bank.
 *
 * Three layers, same split every other file in this codebase (followups.js /
 * notify.js) uses:
 *   - Pure functions (redaction, grouping/aggregation, the operator gate, the
 *     once-per-day decision) — no DB, no network, unit-tested by
 *     scripts/verify-miss-digest.mjs with zero fixtures.
 *   - buildMissDigest() — one cross-tenant DB read (M3-config/25's
 *     list_ask_misses_window), tolerant of that migration not having run yet
 *     (catch + one warning, same idiom as missStore.js), never throws.
 *   - sendMissDigest() / runMissDigestSweepStep() — delivery: email via the
 *     same Resend path notify.js/followups.js use, an in-app notification to
 *     the founder tenant, and the once-per-day cron guard. Never throws —
 *     wired into cron-sweep.js as a step exactly like notify/outreach/
 *     followups, all of which are fire-and-forget from the sweep's own point
 *     of view.
 *
 * ENV VARS (names only — never logged):
 *   RESEND_API_KEY               — already used by email.js; gates the email send.
 *   DEEPWELL_OWNER_ALERT_EMAILS  — comma-separated recipient list for the digest email.
 *   DEEPWELL_FOUNDER_TENANT_ID   — the platform-owner tenant's own tenant key
 *                                  (a Clerk org id, or the solo `user_<id>`
 *                                  fallback — see api/_lib/auth.js's
 *                                  deriveAuth). Used for: (a) the in-app
 *                                  notification target, (b) the once-per-day
 *                                  cron claim, (c) half of the operator gate
 *                                  below. Unset -> both (a) and (b) are
 *                                  skipped (logged once), and only (c)'s
 *                                  DEEPWELL_OPERATOR_USER_IDS half remains.
 *   DEEPWELL_OPERATOR_USER_IDS   — comma-separated Clerk user ids who may
 *                                  also call the on-demand admin action,
 *                                  independent of which tenant they're in.
 */
import { getPool } from "./recordsStore.js";
import { sendEmail } from "./email.js";
import { capRecipients } from "./notify.js";
// Tier 2 Part B (handoffs/DONOVAN_SELF_LEARNING_2026-09-22.md): read-only —
// this file never writes a proposal, it only folds the LAST 24h's already-
// decided ones into the digest so an operator sees "what Donovan proposed
// last night" beside "what Donovan missed last night" in one place. Tolerant
// of migration 26 not being applied (listProposals returns [] on its own).
import { listProposals } from "./learning/store.js";

/** Cross-tenant aggregation window default: the last 24h. Exported so
 *  scripts/verify-miss-digest.mjs and callers can reason about it without
 *  hand-typing 24 * 60 * 60 * 1000 everywhere. */
export const DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;
/** "New since yesterday" lookback: a question not seen in this many days
 *  before the digest window started is flagged `isNew`. */
export const NEW_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
export const TOP_QUESTIONS_LIMIT = 25;

let warnedMissingDigestSql = false;
function warnMissingDigestSqlOnce(context, err) {
  if (warnedMissingDigestSql) return;
  warnedMissingDigestSql = true;
  console.warn(`miss-digest: ${context} failed (migration M3-config/25-miss-digest.sql may not be applied yet):`, err?.message);
}

/* --------------------------------------------------------------- redaction */

// Ordinary email pattern — same shape a dispatcher would type into an Ask box.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// A 10-digit US phone number, with or without the common separators/parens
// and an optional leading +1 — deliberately broad (per the build brief:
// "anything that LOOKS like ... a 10-digit phone") rather than a strict
// NANP validator, since a false positive here (redacting a serial number
// that happens to look phone-shaped) costs nothing and a false negative
// (a real phone number reaching the digest) is the failure mode that matters.
const PHONE_RE = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;

/** Strip anything that looks like an email address or a 10-digit phone
 *  number out of a question's text. Pure. @param {string} text */
export function redactPII(text) {
  return String(text ?? "")
    .replace(EMAIL_RE, "[redacted-email]")
    .replace(PHONE_RE, "[redacted-phone]");
}

/* ------------------------------------------------------------- env parsing */

/** Comma-separated env var -> trimmed, non-empty entries. Pure. Never logs
 *  the value it's given — only ever returns a derived array to the caller. */
export function parseCsvEnv(raw) {
  return String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** DEEPWELL_OWNER_ALERT_EMAILS, parsed and capped the same way notify.js
 *  caps any other recipient list. @param {string|undefined} raw */
export function parseOwnerAlertEmails(raw) {
  return capRecipients(parseCsvEnv(raw), 10);
}

/**
 * True when `auth` belongs to a DeepWell platform operator, not just a
 * tenant admin: either they ARE the founder tenant (DEEPWELL_FOUNDER_TENANT_ID
 * matches auth.tenantId — the same value withTenant/ctx.tenantKey use
 * everywhere else, see api/_lib/auth.js's deriveAuth), or their Clerk user id
 * is explicitly listed in DEEPWELL_OPERATOR_USER_IDS. A normal tenant admin
 * satisfies neither and gets false — same as no auth at all.
 * @param {{tenantId?: string, userId?: string}|null|undefined} auth
 */
export function isPlatformOperator(auth) {
  if (!auth) return false;
  const founderTenantKey = process.env.DEEPWELL_FOUNDER_TENANT_ID;
  if (founderTenantKey && auth.tenantId === founderTenantKey) return true;
  const operatorIds = parseCsvEnv(process.env.DEEPWELL_OPERATOR_USER_IDS);
  return Boolean(auth.userId) && operatorIds.includes(auth.userId);
}

/* --------------------------------------------------------- pure aggregation */

/** @typedef {{tenant_id: string, outcome: string, question_normalized: string, detected_conditions: unknown, count: number|string, first_seen: string, last_seen: string}} MissWindowRow */

function keyFor(outcome, question) {
  return `${outcome}\u0000${question}`;
}

/**
 * Build the digest JSON from two already-fetched row sets — no DB, no clock
 * read (`now`/`since` are passed in) — so scripts/verify-miss-digest.mjs can
 * assert grouping, cross-tenant aggregation and the "new since" flag against
 * fabricated rows. `currentRows`/`priorRows` are exactly what
 * list_ask_misses_window() returns (see M3-config/25-miss-digest.sql),
 * already grouped by (tenant_id, outcome, question) — this function does the
 * further cross-tenant merge (the same question asked by several tenants).
 * @param {{currentRows: MissWindowRow[], priorRows: MissWindowRow[], since: string, now: string}} args
 */
export function buildDigestFromRows({ currentRows, priorRows, since, now }) {
  const priorKeys = new Set((priorRows ?? []).map((r) => keyFor(r.outcome, redactPII(r.question_normalized))));

  // Per (outcome, question): merge across tenants.
  const byOutcomeQuestion = new Map();
  for (const row of currentRows ?? []) {
    const question = redactPII(row.question_normalized);
    const k = keyFor(row.outcome, question);
    if (!byOutcomeQuestion.has(k)) {
      byOutcomeQuestion.set(k, {
        outcome: row.outcome,
        question,
        count: 0,
        tenantIds: new Set(),
        detectedConditions: Array.isArray(row.detected_conditions) ? row.detected_conditions : [],
        firstSeen: row.first_seen,
        lastSeen: row.last_seen,
      });
    }
    const g = byOutcomeQuestion.get(k);
    g.count += Number(row.count) || 0;
    if (row.tenant_id) g.tenantIds.add(row.tenant_id);
    if (row.first_seen && row.first_seen < g.firstSeen) g.firstSeen = row.first_seen;
    if (row.last_seen && row.last_seen > g.lastSeen) g.lastSeen = row.last_seen;
  }

  const entries = [...byOutcomeQuestion.values()].map((g) => ({
    outcome: g.outcome,
    question: g.question,
    count: g.count,
    tenantCount: g.tenantIds.size,
    detectedConditions: g.detectedConditions,
    firstSeen: g.firstSeen,
    lastSeen: g.lastSeen,
    isNew: !priorKeys.has(keyFor(g.outcome, g.question)),
  }));

  // Group by outcome, same shape/order as missStore.js's missReport.
  const byOutcome = new Map();
  for (const e of entries) {
    if (!byOutcome.has(e.outcome)) byOutcome.set(e.outcome, { outcome: e.outcome, count: 0, questions: [] });
    const g = byOutcome.get(e.outcome);
    g.count += e.count;
    g.questions.push(e);
  }
  const groups = [...byOutcome.values()]
    .map((g) => ({ ...g, questions: g.questions.sort((a, b) => b.count - a.count) }))
    .sort((a, b) => b.count - a.count);

  // Top 25 overall: merge the SAME question text across outcomes too (a
  // question is a question regardless of which honest-fallback it triggered),
  // keeping the most common outcome as the representative label.
  const byQuestionOnly = new Map();
  for (const e of entries) {
    if (!byQuestionOnly.has(e.question)) {
      byQuestionOnly.set(e.question, {
        question: e.question,
        count: 0,
        tenantIds: new Set(),
        outcomeCounts: new Map(),
        isNew: true,
        firstSeen: e.firstSeen,
        lastSeen: e.lastSeen,
      });
    }
    const q = byQuestionOnly.get(e.question);
    q.count += e.count;
    q.isNew = q.isNew && e.isNew; // new only if EVERY outcome bucket for this question text is new
    q.outcomeCounts.set(e.outcome, (q.outcomeCounts.get(e.outcome) ?? 0) + e.count);
    if (e.firstSeen && e.firstSeen < q.firstSeen) q.firstSeen = e.firstSeen;
    if (e.lastSeen && e.lastSeen > q.lastSeen) q.lastSeen = e.lastSeen;
  }
  // tenantCount per question needs the ORIGINAL per-tenant rows, not the
  // per-(outcome,question) merge above (a tenant could in principle hit two
  // outcomes for the same question) — recompute from currentRows directly.
  for (const row of currentRows ?? []) {
    const q = byQuestionOnly.get(redactPII(row.question_normalized));
    if (q && row.tenant_id) q.tenantIds.add(row.tenant_id);
  }

  const topQuestions = [...byQuestionOnly.values()]
    .map((q) => ({
      question: q.question,
      count: q.count,
      tenantCount: q.tenantIds.size,
      isNew: q.isNew,
      outcome: [...q.outcomeCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      firstSeen: q.firstSeen,
      lastSeen: q.lastSeen,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_QUESTIONS_LIMIT);

  const totalMisses = groups.reduce((sum, g) => sum + g.count, 0);
  const distinctTenants = new Set();
  for (const row of currentRows ?? []) if (row.tenant_id) distinctTenants.add(row.tenant_id);
  const newQuestionsCount = [...byQuestionOnly.values()].filter((q) => q.isNew).length;

  return {
    since,
    now,
    totals: {
      totalMisses,
      totalTenants: distinctTenants.size,
      totalQuestions: byQuestionOnly.size,
      newQuestionsCount,
    },
    groups,
    topQuestions,
  };
}

/* ------------------------------------------------- learning proposals fold-in */

/**
 * donovan_proposals rows -> `{total, byStatus, byKind}` for whichever of them
 * were CREATED within [since, now) — i.e. by the most recent nightly learning
 * run(s) that landed inside this digest's own 24h window. Pure (no DB, no
 * clock read) so scripts/verify-learning.mjs can assert it against fabricated
 * rows. A row with no created_at (shouldn't happen — the column is NOT NULL —
 * but defensive) is excluded rather than crashing the comparison.
 * @param {{status: string, kind: string, created_at: string|Date}[]} rows
 * @param {string} sinceIso
 */
export function summarizeLearningProposals(rows, sinceIso) {
  const byStatus = {};
  const byKind = {};
  let total = 0;
  for (const row of rows ?? []) {
    if (!row?.created_at) continue;
    const createdIso = new Date(row.created_at).toISOString();
    if (createdIso < sinceIso) continue;
    total += 1;
    if (row.status) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    if (row.kind) byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
  }
  return { total, byStatus, byKind };
}

/* -------------------------------------------------------------- DB reads */

/**
 * Cross-tenant read for one time window via list_ask_misses_window()
 * (M3-config/25-miss-digest.sql). Tolerant of the migration not having run
 * yet — returns [] and warns once, never throws (missStore.js's own idiom).
 * @param {Date} from @param {Date} to
 */
async function fetchMissWindow(from, to) {
  try {
    const { rows } = await getPool().query("SELECT * FROM list_ask_misses_window($1, $2)", [from.toISOString(), to.toISOString()]);
    return rows;
  } catch (err) {
    warnMissingDigestSqlOnce("list_ask_misses_window", err);
    return [];
  }
}

/**
 * Platform-level aggregation across ALL tenants for the last 24h (or
 * whatever `since` is given), reusing the same cross-tenant idiom
 * cron-sweep.js's other sweeps rely on (a SECURITY DEFINER SQL function,
 * never a per-request tenant transaction — see M3-config/25's header).
 * @param {{since?: Date|string}} [opts]
 */
export async function buildMissDigest({ since } = {}) {
  const now = new Date();
  const sinceDate = since ? new Date(since) : new Date(now.getTime() - DIGEST_WINDOW_MS);
  const priorFrom = new Date(sinceDate.getTime() - NEW_LOOKBACK_MS);

  const [currentRows, priorRows, proposalRows] = await Promise.all([
    fetchMissWindow(sinceDate, now),
    fetchMissWindow(priorFrom, sinceDate),
    // Tier 2 Part B: whatever the nightly learning step has proposed lately —
    // listProposals is already tolerant of migration 26 not being applied
    // (returns [] rather than throwing), so this costs nothing extra to try.
    listProposals({ limit: 200 }),
  ]);

  const digest = buildDigestFromRows({
    currentRows,
    priorRows,
    since: sinceDate.toISOString(),
    now: now.toISOString(),
  });
  digest.learning = summarizeLearningProposals(proposalRows, digest.since);
  return digest;
}

/* ------------------------------------------------------------- rendering */

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/**
 * Plain-text + HTML digest email. Pure — no DB, no clock read (`dateLabel` is
 * passed in) — so scripts/verify-miss-digest.mjs can assert its shape.
 * @param {ReturnType<typeof buildDigestFromRows>} digest
 * @param {string} dateLabel e.g. "2026-09-22"
 */
export function renderMissDigestEmail(digest, dateLabel) {
  const { totals, groups, topQuestions, learning } = digest;
  const subject = `Donovan misses — ${dateLabel}: ${totals.newQuestionsCount} new, ${totals.totalMisses} total`;

  // Tier 2 Part B: a "Proposed fixes" section, only when there's anything to
  // show — a digest built before migration 26 or before the learning step
  // has ever run has `learning.total === 0` and gets exactly the old email.
  const hasLearning = Boolean(learning?.total);
  const statusLine = (byMap) => Object.entries(byMap ?? {}).map(([k, n]) => `${n} ${k}`).join(", ");

  const textLines = [
    subject,
    `${totals.totalTenants} tenant(s), ${totals.totalQuestions} distinct question(s), ${groups.length} outcome bucket(s).`,
    "",
    "By outcome:",
    ...groups.map((g) => `  ${g.outcome}: ${g.count}`),
    "",
    `Top ${topQuestions.length} question(s):`,
    ...topQuestions.map(
      (q) => `  - ${q.isNew ? "[NEW] " : ""}"${q.question}" (${q.outcome}) — ${q.count}x across ${q.tenantCount} tenant(s)`
    ),
    ...(hasLearning
      ? ["", `Proposed fixes (last 24h): ${learning.total} total — ${statusLine(learning.byStatus)}.`]
      : []),
  ];

  const html =
    `<p><strong>${escapeHtml(subject)}</strong></p>` +
    `<p>${totals.totalTenants} tenant(s), ${totals.totalQuestions} distinct question(s), ${groups.length} outcome bucket(s).</p>` +
    `<p><strong>By outcome</strong></p><ul>${groups.map((g) => `<li>${escapeHtml(g.outcome)}: ${g.count}</li>`).join("")}</ul>` +
    `<p><strong>Top ${topQuestions.length} question(s)</strong></p><table cellpadding="6" style="border-collapse:collapse;width:100%">` +
    `<thead><tr style="text-align:left;border-bottom:2px solid #ccc"><th>Question</th><th>Outcome</th><th>Count</th><th>Tenants</th><th>New?</th></tr></thead><tbody>` +
    topQuestions
      .map(
        (q) =>
          `<tr><td>${escapeHtml(q.question)}</td><td>${escapeHtml(q.outcome ?? "")}</td><td>${q.count}</td><td>${q.tenantCount}</td><td>${q.isNew ? "new" : ""}</td></tr>`
      )
      .join("\n") +
    `</tbody></table>` +
    (hasLearning
      ? `<p><strong>Proposed fixes (last 24h)</strong>: ${learning.total} total — ${escapeHtml(statusLine(learning.byStatus))}.</p>`
      : "");

  return { subject, text: textLines.join("\n"), html };
}

/* -------------------------------------------------------------- delivery */

async function writeFounderNotification(founderTenantKey, digest, dateLabel) {
  const title = `Donovan misses — ${dateLabel}: ${digest.totals.newQuestionsCount} new, ${digest.totals.totalMisses} total`;
  const body =
    `${digest.totals.totalTenants} tenant(s), ${digest.totals.totalQuestions} distinct question(s) in the last 24h.` +
    (digest.learning?.total ? ` ${digest.learning.total} learning proposal(s) proposed.` : "");
  try {
    const { rows } = await getPool().query("SELECT insert_platform_notification($1,$2,$3,$4,$5) AS ok", [
      founderTenantKey,
      "miss-digest",
      title,
      body,
      "/app/?screen=team",
    ]);
    return Boolean(rows[0]?.ok);
  } catch (err) {
    warnMissingDigestSqlOnce("insert_platform_notification", err);
    return false;
  }
}

/**
 * Build (or reuse) the digest and deliver it: an email via Resend when
 * RESEND_API_KEY + DEEPWELL_OWNER_ALERT_EMAILS are both set, and — always,
 * whenever there's anything to report — an in-app notification to the
 * founder tenant when DEEPWELL_FOUNDER_TENANT_ID is set. Zero misses in the
 * window skips BOTH channels (one log line) rather than sending an empty
 * "nothing happened" digest. Never throws.
 * @param {{since?: Date|string, digest?: ReturnType<typeof buildDigestFromRows>}} [opts]
 */
export async function sendMissDigest({ since, digest: given } = {}) {
  const digest = given ?? (await buildMissDigest({ since }));
  const dateLabel = digest.now.slice(0, 10);

  if (digest.totals.totalMisses === 0) {
    console.log(`miss-digest: 0 misses in window (${digest.since} to ${digest.now}) — skipping send.`);
    return { digest, emailed: false, notified: false, skippedReason: "no-misses" };
  }

  let emailed = false;
  const recipients = parseOwnerAlertEmails(process.env.DEEPWELL_OWNER_ALERT_EMAILS);
  if (process.env.RESEND_API_KEY && recipients.length) {
    try {
      const rendered = renderMissDigestEmail(digest, dateLabel);
      const result = await sendEmail({ to: recipients, ...rendered });
      emailed = Boolean(result.sent);
    } catch (err) {
      console.error("miss-digest: sendEmail failed (non-fatal):", err?.message);
    }
  }

  let notified = false;
  const founderTenantKey = process.env.DEEPWELL_FOUNDER_TENANT_ID;
  if (founderTenantKey) {
    notified = await writeFounderNotification(founderTenantKey, digest, dateLabel);
  }

  return { digest, emailed, notified };
}

/* ----------------------------------------------------- cron once-per-day */

// Best-effort fallback ONLY for a deployment that hasn't set
// DEEPWELL_FOUNDER_TENANT_ID — there's nowhere durable to store a claim
// without a new table (the repo's own constraint), so this just prevents the
// SAME warm process from re-sending twice in one UTC day. It does not
// survive a cold start; with DEEPWELL_FOUNDER_TENANT_ID set (the intended
// setup — see this file's header), claim_platform_daily_task's row in
// tenants.settings is the real, durable guard and this fallback is unused.
let lastRunDateNoFounderTenant = null;

/**
 * Pure decision the cron step makes before doing any work: given today's
 * date and whatever the last claimed/seen date was, should it run? Exported
 * so scripts/verify-miss-digest.mjs can assert the once-per-day guard logic
 * without a database or a fabricated clock inside the module.
 * @param {string|null} lastRunDate YYYY-MM-DD or null
 * @param {string} today YYYY-MM-DD
 */
export function shouldRunDigestToday(lastRunDate, today) {
  return lastRunDate !== today;
}

/**
 * Nightly cron-sweep step (api/_lib/routes/cron-sweep.js). Guarded to run at
 * most once per UTC day, and never allowed to fail the sweep it's a step of
 * — every error is caught and returned as `{error}` in the summary, exactly
 * like the notifications/outreach/followups steps beside it.
 */
export async function runMissDigestSweepStep() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const founderTenantKey = process.env.DEEPWELL_FOUNDER_TENANT_ID;

    if (founderTenantKey) {
      let claimed;
      try {
        const { rows } = await getPool().query("SELECT claim_platform_daily_task($1,$2,$3) AS claimed", [
          founderTenantKey,
          "lastMissDigestDate",
          today,
        ]);
        claimed = Boolean(rows[0]?.claimed);
      } catch (err) {
        warnMissingDigestSqlOnce("claim_platform_daily_task", err);
        return { skipped: "guard-unavailable" };
      }
      if (!claimed) return { skipped: "already-ran-today" };
    } else {
      if (!shouldRunDigestToday(lastRunDateNoFounderTenant, today)) return { skipped: "already-ran-today" };
      lastRunDateNoFounderTenant = today;
    }

    const result = await sendMissDigest();
    return {
      ranAt: today,
      totalMisses: result.digest.totals.totalMisses,
      newQuestions: result.digest.totals.newQuestionsCount,
      emailed: result.emailed,
      notified: result.notified,
      skippedReason: result.skippedReason,
    };
  } catch (err) {
    console.error("miss-digest sweep step failed (non-fatal):", err?.message);
    return { error: err?.message };
  }
}
