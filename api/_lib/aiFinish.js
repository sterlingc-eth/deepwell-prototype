/**
 * AI finish (2026-10-26): Claude Haiku finishes the papers the free reader (upload, Re-check, the nightly sweep) left open.
 *
 * A wrong value or a wrong link is far worse than a blank, so every rule below is a way to throw an answer away:
 *   - a fact is kept ONLY when Claude returned an exact quote and that quote is really on the page (groundedFacts.verifyGrounded:
 *     whitespace / case / smart quotes normalised) AND the value can be read out of the quote. No quote, a quote that is not on
 *     the page, or a value the quote does not contain: discarded.
 *   - it asks only for the fields the paper is MISSING, and writes insert-only (SQL NOT EXISTS, like Re-check): a value that is
 *     there, a person's correction, an unconfirmed far-future date, is never replaced.
 *   - the document type is set only when the paper has none or is "other", Claude names a known type with a quoted page phrase and
 *     confidence >= 0.85, and no person ever chose a type for it. (hr-letter / license-certification are never assigned by AI.)
 *   - a CUSTOMER is never linked and never written as a fact here. Claude may pick one of the EXISTING customers shortlisted from
 *     the page; the pick is kept only when its quote is on the page and contains that customer's name (all words) or street address.
 *     It becomes one more candidate on the R6 "Link to <customer>" audit-row suggestion. Never for HR / licence papers, set-aside
 *     papers, papers already linked, or papers a person unlinked.
 *   - then the normal automatic check runs (recheckDocumentTx: deterministic labels, strong-evidence link, autoCheckDecision).
 *
 * Cost is INTERNAL ONLY. Nothing here is shown to a customer: it is recorded in usage counters (recordModelCall), in the paper's
 * `ai_finish.run` audit row, and in the per-tenant monthly (sized by plan) and daily spend ledgers (rate_limit_windows, the table
 * every other spend cap already uses). Haiku only. A paper that failed twice is skipped; a paper Claude already looked at is not paid
 * for again (until AI_FINISH_VERSION is bumped). The run stops cleanly at the per-run cap, the daily/monthly budget, the platform cap
 * or the deadline and reports what is left. No migration: state lives in audit_log + facets.segment_id + rate_limit_windows.
 */
import Anthropic from "@anthropic-ai/sdk";
import { withTenant, FIELD_AI_SEGMENT } from "./recordsStore.js";
import { getApiKey, MODEL_TIMEOUT_MS, withBackoff, isRetryableModelStatus } from "./claude.js";
import { withCache, modelCallLogLine } from "./promptCache.js";
import { recordModelCall, estimateModelCostUsd, createUsageMeter, runWithUsageMeter } from "./usage.js";
import { assertModelBudget, ModelBudgetExceededError } from "./rateLimit.js";
import { sonnetSpentTodayUsd } from "./agent/escalation.js";
import { ROUTE_BUCKETS, dailyCapUsd } from "./planner/spend.js";
import {
  buildExtractPrompt, buildExtractToolForPack, normalizeFields, selectPages, stripControlChars, unconfirmedKey, baseKeyOf,
} from "./extractFields.js";
import { splitExtractPrompt } from "./extractDocument.js";
import { verifyGrounded, norm } from "./modelAvoidance/groundedFacts.js";
import {
  completenessFor, toCompletenessFields, normalizeDocumentType, autoCheckDecision, DOCUMENT_TYPE_IDS, isLabelValue,
  isCompanyRecordType, AI_VERIFY_MIN_CONFIDENCE,
} from "./documentTypes.js";
import { isFragmentName } from "./integrity.js";
import { applyOwnCompanyGuard, loadOwnNames, isOwnName, issuerNotCustomer } from "./modelAvoidance/ownCompany.js";
import { readableChars } from "./modelAvoidance/storedTextReread.js";
import { packForTenant } from "./industry/index.js";
import { isSetAsidePaper, setLinkSuggestion, nameTokens, streetOf, isJunkCustomerName, isIssuerSigner, printedNameMatches, LINK_SUGGESTION_ACTION } from "./bodyNameLink.js";
import { COMPANY_FOLDER_FIELD_KEY, HR_FOLDER_ID } from "./companyFiles.js";
import { recheckDocumentTx, RETYPE_ACTION } from "./recheck.js";
import { bindFieldToLabel, plausibleKeys, BINDABLE_KEYS } from "./aiFinishBind.js";
import { storeSuggestions } from "./aiFinishSuggest.js";
import { splitPartyZones } from "./bodyNameLink.js";

/** Bump to let every paper be looked at again (a paper Claude already looked at is not paid for twice within one version). */
export const AI_FINISH_VERSION = 1;
export const AI_FINISH_ACTION = "ai_finish.run";
export const MONTH_BUCKET = "ai_finish_month_usd_micro";
export const MAX_FAILURES = 2;
export const MIN_FIELD_CONFIDENCE = 0.7;
export const MAX_STORED_CONFIDENCE = 0.9;
/** Types AI never assigns: they take a paper out of customer linking, which a person decides. */
const SKIP_REMEMBERED = new Set(["no-plausible-field", "nothing-to-ask", "would-check-already", "set-aside", "pack-not-supported"]);
const AI_NEVER_ASSIGNS = new Set(["hr-letter", "license-certification"]);
const PAGE_CHAR_BUDGET = 24_000;
const POOR_TEXT_CHARS = 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT = "tenant_id = (current_setting('app.tenant_id', true))::uuid";
const REPEATABLE = new Set(["work_performed", "part_number"]);
const HAS_LINK_SQL = `(EXISTS (SELECT 1 FROM extractions x WHERE x.document_id = d.id AND x.entity_id IS NOT NULL)
                    OR EXISTS (SELECT 1 FROM document_entity_links l WHERE l.document_id = d.id))`;

/** Haiku only: the extraction model if it is a Haiku id, else the default. A Sonnet id in EXTRACT_MODEL never reaches this pass. */
export function aiFinishModel(env = process.env) {
  const m = String(env?.AI_FINISH_MODEL || env?.EXTRACT_MODEL || "");
  return /haiku/i.test(m) ? m : "claude-haiku-4-5";
}
export const isAiFinishEnabled = (env = process.env) => env?.AI_FINISH !== "0";

/* ------------------------------------------------------------------ budgets (internal; never shown to a customer) */

/** Monthly AI budget per plan, USD. About 2x the expected need for that plan (see CLAUDE_FINISH_REPORT.md); env-overridable per plan. */
export const MONTHLY_BUDGET_USD = Object.freeze({ solo: 2, shop: 5, crew: 12, fleet: 25, demo: 0 });
export function monthlyBudgetUsd(plan, env = process.env) {
  if (typeof plan !== "string" || !Object.prototype.hasOwnProperty.call(MONTHLY_BUDGET_USD, plan)) return 0; // no plan, no AI spend
  const raw = env?.[`AI_FINISH_MONTHLY_USD_${plan.toUpperCase()}`];
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : MONTHLY_BUDGET_USD[plan];
}
export const DEFAULT_RUN_CAP_USD = 5;
export function runCapUsd(env = process.env) {
  const n = Number(env?.AI_FINISH_RUN_CAP_USD);
  return Number.isFinite(n) && n >= 0 && env?.AI_FINISH_RUN_CAP_USD !== "" && env?.AI_FINISH_RUN_CAP_USD != null ? n : DEFAULT_RUN_CAP_USD;
}
const monthStartMs = (now = Date.now()) => { const d = new Date(now); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };

/** Internal spend picture for one tenant: month and day so far against their caps. null spend = unreadable (treated as "stop"). */
export async function aiFinishBudget(ctx, plan, { now = Date.now(), env = process.env } = {}) {
  const monthCap = monthlyBudgetUsd(plan, env);
  const dayCap = dailyCapUsd("aiFinish", env);
  const [month, day] = await Promise.all([
    sonnetSpentTodayUsd(withTenant, ctx, monthStartMs(now), MONTH_BUCKET),
    sonnetSpentTodayUsd(withTenant, ctx, now, ROUTE_BUCKETS.aiFinish.bucket),
  ]);
  return { monthCap, dayCap, monthSpent: month, daySpent: day };
}
const dayStartIso = (now) => { const d = new Date(now); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString(); };
const microOf = (usd) => Math.max(0, Math.min(2_000_000_000, Math.round((Number(usd) || 0) * 1_000_000)));

/** Stops the batch cleanly (the paper is put back, nothing was spent beyond what is already settled). */
export class FinishStop extends Error {
  constructor(reason) { super(`ai-finish stop: ${reason}`); this.name = "FinishStop"; this.reason = reason; }
}

/**
 * ATOMIC budget reservation (rev2, D2/D3): add `est` to the month and day ledgers only if the result stays within the caps, in one statement
 * per ledger (INSERT ... ON CONFLICT DO UPDATE ... WHERE units + est <= cap), so concurrent runs cannot both spend the same room.
 * Returns {ok:true} | {ok:false, why:'month-budget'|'day-budget'} | {ok:null} (ledger unreadable: stop).
 */
export async function reserveBudget(ctx, estUsd, { monthCapUsd, dayCapUsd }, now = Date.now()) {
  const est = microOf(estUsd);
  const one = (db, bucket, start, cap) => db.raw(
    `INSERT INTO rate_limit_windows (tenant_id, bucket, window_start, units)
       SELECT (current_setting('app.tenant_id', true))::uuid, $1::text, $2::timestamptz, $3::bigint WHERE $3::bigint <= $4::bigint
     ON CONFLICT (tenant_id, bucket, window_start)
       DO UPDATE SET units = rate_limit_windows.units + EXCLUDED.units WHERE rate_limit_windows.units + EXCLUDED.units <= $4::bigint
     RETURNING units`, [bucket, start, est, microOf(cap)]);
  try {
    return await withTenant(ctx, async (db) => {
      const m = await one(db, MONTH_BUCKET, new Date(monthStartMs(now)).toISOString(), monthCapUsd);
      if (!m.rows?.length) return { ok: false, why: "month-budget" };
      const d = await one(db, ROUTE_BUCKETS.aiFinish.bucket, dayStartIso(now), dayCapUsd);
      if (!d.rows?.length) {
        await db.raw(`UPDATE rate_limit_windows SET units = GREATEST(0, units - $3::bigint) WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid AND bucket = $1::text AND window_start = $2::timestamptz`,
          [MONTH_BUCKET, new Date(monthStartMs(now)).toISOString(), est]);
        return { ok: false, why: "day-budget" };
      }
      return { ok: true };
    });
  } catch { return { ok: null }; }
}

/** Settle a reservation: add (actual - reserved) to both ledgers (negative gives room back). Best effort, never throws. */
export async function adjustBudget(ctx, deltaUsd, now = Date.now()) {
  const delta = Math.round((Number(deltaUsd) || 0) * 1_000_000);
  if (!delta) return;
  try {
    await withTenant(ctx, async (db) => {
      for (const [bucket, start] of [[MONTH_BUCKET, new Date(monthStartMs(now)).toISOString()], [ROUTE_BUCKETS.aiFinish.bucket, dayStartIso(now)]]) {
        await db.raw(
          `INSERT INTO rate_limit_windows (tenant_id, bucket, window_start, units)
             VALUES ((current_setting('app.tenant_id', true))::uuid, $1::text, $2::timestamptz, GREATEST(0, $3::bigint))
           ON CONFLICT (tenant_id, bucket, window_start)
             DO UPDATE SET units = GREATEST(0, LEAST(2000000000, rate_limit_windows.units + $3::bigint))`, [bucket, start, delta]);
      }
    });
  } catch { /* ledger is best effort */ }
}

/** Pure: what one paper is expected to cost, for the reserve-before-you-call cap check. Over-estimates on purpose. */
export function estimatePaperCostUsd(pages, { model = aiFinishModel(), scanned = false, pageCount = 1 } = {}) {
  const chars = Math.min(PAGE_CHAR_BUDGET, (pages ?? []).reduce((n, p) => n + String(p?.text ?? "").length, 0));
  const text = estimateModelCostUsd(model, { inputTokens: Math.ceil(chars / 3.5) + 1500, cacheReadInputTokens: 7000, outputTokens: 700 });
  return Math.round((text + (scanned ? 0.012 * Math.max(1, pageCount) : 0)) * 1e6) / 1e6;
}

/* ------------------------------------------------------------------ pure planning and acceptance (no database, no model) */

/** Every key a missing requirement ("service_address|serial_number") could be satisfied by, minus keys the paper already holds. */
export function wantedFieldKeys(completeness, rows) {
  const have = new Set((rows ?? []).filter((r) => String(r.corrected_value ?? r.value ?? "").trim() !== "").map((r) => baseKeyOf(r.field_key)));
  const want = new Set();
  for (const req of completeness?.missing ?? []) for (const k of String(req).split("|")) if (!have.has(k)) want.add(k);
  // A paper's customer is never written as a fact by this pass (it is a suggestion, below).
  want.delete("customer_name");
  return want;
}

/** Normalised-quote containment on the page text (the same normalisation as verifyGrounded). */
export function quoteOnPage(quote, pages) {
  const q = norm(quote);
  if (q.length < 4) return false;
  const parts = q.split(/\s*…\s*/).filter(Boolean);
  return (pages ?? []).some((p) => { const t = norm(p.text); return parts.every((x) => t.includes(x)); });
}

/**
 * Pure: judge Claude's field answers. Returns {accepted, rejected}. A field is accepted only when it is a wanted key, its confidence is
 * >= MIN_FIELD_CONFIDENCE, its quote is on its page and the value is readable out of that quote.
 */
export function acceptFields(rawFields, { pages, wanted, pageCount, today, pack = null, ownNames = [] }) {
  const accepted = [];
  const rejected = [];
  const suggestions = [];
  const norm1 = normalizeFields(rawFields, { pageCount, today, pack });
  for (const d of norm1.dropped) rejected.push({ field_key: d.key, reason: "invalid-value" });
  let fields = norm1.fields;
  fields = fields.filter((f) => !((f.field_key === "vendor") && (isLabelValue(f.value) || isFragmentName(f.value))));
  try { fields = issuerNotCustomer(fields, pages, ownNames).fields; } catch { /* guard is best effort */ }
  const guard = applyOwnCompanyGuard(fields, ownNames);
  for (const r of guard.removed ?? []) rejected.push({ field_key: r.field_key ?? "vendor", reason: "own-company" });
  fields = guard.fields;
  const seen = new Set();
  let zones = null;
  try { zones = splitPartyZones(pages ?? []); } catch { zones = null; }
  for (let f of fields) {
    const base = baseKeyOf(f.field_key);
    if (!wanted.has(base)) { rejected.push({ field_key: f.field_key, reason: "not-missing" }); continue; }
    if (Number(f.confidence) < MIN_FIELD_CONFIDENCE) { rejected.push({ field_key: f.field_key, reason: "low-confidence" }); continue; }
    const g = verifyGrounded({ field_key: f.field_key, value: f.value, verbatim: f.verbatim, page_no: f.page_no }, pages);
    if (!g.ok) { rejected.push({ field_key: f.field_key, reason: g.reason }); continue; }
    // Rev2: the quote must sit under / right after a label that names THIS field, the date must read the same in the page's own locale,
    // the value must pass its type check and must not come from the issuer's letterhead / remit / footer zone.
    const b = bindFieldToLabel({ ...f, field_key: base }, pages, { zones: zones ?? undefined });
    if (!b.ok && b.soft) {
      // Real quote, readable and type-correct value, failed only the label / zone (or an ambiguous date): a SUGGESTION, never a fact.
      suggestions.push({ field_key: base, value: b.value, options: b.options, quote: b.quote, page_no: b.page_no ?? f.page_no ?? null, reason: b.reason });
      rejected.push({ field_key: f.field_key, reason: `suggested:${b.reason}` });
      continue;
    }
    if (!b.ok) { rejected.push({ field_key: f.field_key, reason: b.reason }); continue; }
    f = { ...f, value: b.value };
    const dupe = REPEATABLE.has(f.field_key) ? `${f.field_key}\u0000${f.value}` : f.field_key;
    if (seen.has(dupe)) continue;
    seen.add(dupe);
    accepted.push({ ...f, confidence: Math.min(Number(f.confidence) || 0, MAX_STORED_CONFIDENCE) });
  }
  return { accepted, rejected, suggestions };
}

/** Pure: may Claude's document type be applied? */
export function acceptType({ answer, currentType, humanChosen, hrOverride = false, pages }) {
  const to = String(answer?.document_type ?? "").trim();
  const evidence = String(answer?.document_type_evidence ?? "").trim();
  const conf = Number(answer?.document_type_confidence);
  if (humanChosen) return { ok: false, reason: "person-chose-type" };
  if (hrOverride) return { ok: false, reason: "hr-filed" };
  const cur = currentType == null || String(currentType).trim() === "" ? null : normalizeDocumentType(currentType);
  const open = cur === null || cur === "other";
  if (!open) return { ok: false, reason: "has-type" };
  if (!to || to === "other" || !DOCUMENT_TYPE_IDS.has(to)) return { ok: false, reason: "no-known-type" };
  if (AI_NEVER_ASSIGNS.has(to)) return { ok: false, reason: "person-decides-this-type" };
  if (!(conf >= AI_VERIFY_MIN_CONFIDENCE)) return { ok: false, reason: "low-confidence" };
  if (!quoteOnPage(evidence, pages)) return { ok: false, reason: evidence ? "quote-not-on-page" : "no-quote" };
  return { ok: true, to, evidence };
}

/**
 * Pure: customers (existing ones only) whose name or street shows up on the page, best first. Claude is only ever shown these.
 * @param {{page_no:number,text:string}[]} pages
 * @param {{id:string,name:string,address?:string}[]} customers
 */
export function shortlistCustomers(pages, customers, { ownNames = [], limit = 12 } = {}) {
  const text = ` ${nameTokens((pages ?? []).map((p) => p.text ?? "").join("\n")).join(" ")} `;
  const out = [];
  for (const c of customers ?? []) {
    if (!c?.id || isJunkCustomerName(c.name) || isOwnName(c.name, ownNames) || /^customer at\b/i.test(c.name ?? "")) continue;
    const toks = nameTokens(c.name).filter((t) => t.length > 1);
    const street = streetOf(c.address);
    let score = 0;
    if (toks.length >= 2 && toks.every((t) => text.includes(` ${t} `))) score += 4;
    else if (toks.length === 1 && toks[0].length >= 6 && text.includes(` ${toks[0]} `)) score += 3;
    else { const last = toks[toks.length - 1]; if (toks.length >= 2 && last && last.length >= 4 && text.includes(` ${last} `)) score += 1; }
    if (street && text.includes(` ${street} `)) score += 4;
    if (score > 0) out.push({ id: c.id, name: c.name, address: c.address ?? "", score });
  }
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
}

/** Pure: may Claude's customer pick become a suggestion? It must be one of the shortlist, quoted on the page, with the name or street in the quote. */
export function acceptCustomerPick({ pick, shortlist, pages, ownNames = [], printedName = null }) {
  const id = String(pick?.customer_id ?? "").trim();
  const quote = String(pick?.quote ?? "").trim();
  if (!id) return { ok: false, reason: "none" };
  const c = (shortlist ?? []).find((x) => x.id === id);
  if (!c) return { ok: false, reason: "not-an-existing-customer" };
  if (!quote) return { ok: false, reason: "no-quote" };
  if (!quoteOnPage(quote, pages)) return { ok: false, reason: "quote-not-on-page" };
  const qTokens = ` ${nameTokens(quote).join(" ")} `;
  const toks = nameTokens(c.name).filter((t) => t.length > 1);
  const nameIn = toks.length >= 2 ? toks.every((t) => qTokens.includes(` ${t} `)) : toks.length === 1 && toks[0].length >= 6 && qTokens.includes(` ${toks[0]} `);
  const street = streetOf(c.address);
  const streetIn = street && qTokens.includes(` ${street} `);
  if (!nameIn && !streetIn) return { ok: false, reason: "quote-lacks-customer-name-or-street" };
  if (isOwnName(c.name, ownNames) || isJunkCustomerName(c.name)) return { ok: false, reason: "not-a-customer" };
  // Two customers with the same name: only the street can tell them apart. Without it in the quote, suggest neither.
  const key = nameTokens(c.name).join(" ");
  const twins = (shortlist ?? []).filter((x) => x.id !== c.id && nameTokens(x.name).join(" ") === key);
  if (twins.length && !(streetIn && twins.every((o) => { const st = streetOf(o.address); return !st || !qTokens.includes(` ${st} `); }))) return { ok: false, reason: "ambiguous-customer" };
  const bodyText = (pages ?? []).map((p) => p.text ?? "").join("\n");
  if (isIssuerSigner(c.name, bodyText)) return { ok: false, reason: "issuer-signer" };
  if (printedName && !printedNameMatches(printedName, c.name)) return { ok: false, reason: "contradicts-printed-customer" };
  return { ok: true, customer: { id: c.id, name: c.name } };
}

/* ------------------------------------------------------------------ the model call */

const FINISH_TASK = (wantedLabels, typeAsk, customers) => `

FINISH PASS. A free reader already went over this paper and left the items below open. Return ONLY them (leave out every other field), and only when the page itself states them.
- Fields still needed: ${wantedLabels.length ? wantedLabels.join(", ") : "none"}.
- NEVER return a date of birth, social security or tax id number, bank account / routing / card number, or a driver's licence / ID number, whatever field it seems to fit.\n- If the page shows a value for one of these but not under its usual label, still return it with its exact quote; a person will look at it before it is used.
- For every field, "verbatim" MUST be an EXACT copy (same spelling, digits and spacing) of a short stretch of the page text that contains the value. A value without an exact quote is thrown away.
${typeAsk ? `- This paper has no document type yet: set document_type to the best-fitting id and put an EXACT page quote that shows it (a title or heading) in document_type_evidence. If nothing on the page shows it, use "other" and leave document_type_evidence out.\n` : ""}${customers.length ? `- Customers already on file that this page may name:\n${customers.map((c) => `    ${c.id} | ${stripControlChars(c.name).slice(0, 80)}${c.address ? ` | ${stripControlChars(c.address).slice(0, 80)}` : ""}`).join("\n")}\n  Fill customer_pick {customer_id, quote} ONLY if the page prints that customer's name or street address, with the exact quote. Otherwise leave customer_pick out. Never guess, and never pick the business that issued the paper.\n` : ""}`;

/** The extract tool plus the two finish-only answers (type evidence, customer pick). */
export function buildFinishTool(pack) {
  const base = buildExtractToolForPack(pack);
  const tool = JSON.parse(JSON.stringify(base));
  tool.input_schema.properties.document_type_evidence = { type: "string", description: "Exact quote from the page that shows the document type. Omit if none." };
  tool.input_schema.properties.customer_pick = {
    type: "object",
    description: "One of the listed existing customers, only if the page itself prints their name or street address.",
    properties: { customer_id: { type: "string" }, quote: { type: "string", description: "Exact quote from the page containing the customer's name or street address." } },
  };
  return tool;
}

async function defaultCallModel({ system, user, tool, model, deadlineAt }) {
  const client = new Anthropic({ apiKey: getApiKey(), timeout: MODEL_TIMEOUT_MS, maxRetries: 0 });
  const startedAt = Date.now();
  const response = await withBackoff(() => client.messages.create({
    model,
    max_tokens: 2500,
    ...(system ? { system: [withCache({ type: "text", text: system }, model, { ttl: "1h" })] } : {}),
    tools: [withCache(tool, model)],
    tool_choice: { type: "tool", name: tool.name },
    messages: [{ role: "user", content: user }],
  }, { timeout: Math.max(1000, Math.min(MODEL_TIMEOUT_MS, deadlineAt - Date.now())) }), { deadlineAt, attempts: 2 });
  const usage = {
    inputTokens: response.usage?.input_tokens, outputTokens: response.usage?.output_tokens,
    cacheReadInputTokens: response.usage?.cache_read_input_tokens, cacheCreationInputTokens: response.usage?.cache_creation_input_tokens,
  };
  console.log(JSON.stringify(modelCallLogLine({ route: "ai-finish", model, ...usage, latencyMs: Date.now() - startedAt })));
  return { toolInput: response.content.find((b) => b.type === "tool_use")?.input ?? null, usage };
}

/* ------------------------------------------------------------------ one paper */

export const CLAIM_ACTION = "ai_finish.claim";
export const RELEASE_ACTION = "ai_finish.release";
const CLAIM_MINUTES = 10;

/**
 * Atomic per-paper claim (rev2, D2): under pg_advisory_xact_lock(paper) the claim row is written only if the paper has no live claim
 * (a claim in the last 10 minutes not followed by a release) and no finished run of this version. Of N concurrent runs exactly one gets "ok".
 */
async function claimPaper(ctx, documentId, actorClerkId) {
  try {
    return await withTenant(ctx, async (db) => {
      await db.raw("SELECT pg_advisory_xact_lock(hashtext($1))", [`aifinish:${documentId}`]);
      const done = await db.raw(
        `SELECT 1 FROM audit_log WHERE resource_id = $1::uuid AND ${TENANT} AND action = '${AI_FINISH_ACTION}'
            AND changes->>'outcome' NOT IN ('failed', 'skip') AND COALESCE((changes->>'version')::int, 0) >= $2 LIMIT 1`, [documentId, AI_FINISH_VERSION]);
      if (done.rows?.length) return "already-looked";
      const last = await db.raw(
        `SELECT action FROM audit_log WHERE resource_id = $1::uuid AND ${TENANT} AND action IN ('${CLAIM_ACTION}', '${RELEASE_ACTION}')
            AND created_at > NOW() - INTERVAL '${CLAIM_MINUTES} minutes' ORDER BY created_at DESC, id DESC LIMIT 1`, [documentId]);
      if (last.rows?.[0]?.action === CLAIM_ACTION) return "claimed";
      await db.logAction({ clerk_user_id: actorClerkId, action: CLAIM_ACTION, resource_type: "document", resource_id: documentId, changes: { version: AI_FINISH_VERSION } });
      return "ok";
    });
  } catch { return "claim-failed"; }
}
async function releaseClaim(ctx, documentId, actorClerkId) {
  try { await withTenant(ctx, (db) => db.logAction({ clerk_user_id: actorClerkId, action: RELEASE_ACTION, resource_type: "document", resource_id: documentId, changes: { version: AI_FINISH_VERSION } })); } catch { /* best effort */ }
}

async function loadForPaper(ctx, documentId) {
  return withTenant(ctx, async (db) => {
    const doc = await db.getDocument(documentId);
    if (!doc) return null;
    const pack = await packForTenant(db).catch(() => null);
    const [pages, rows] = await Promise.all([db.listPages(documentId), db.listExtractionsByDocument(documentId)]);
    const ownNames = await loadOwnNames(db, {}).catch(() => []);
    const linkedRow = await db.raw(`SELECT ${HAS_LINK_SQL} AS linked FROM documents d WHERE d.id = $1::uuid`, [documentId]);
    const audits = (await db.raw(
      `SELECT action, changes FROM audit_log WHERE resource_id = $1::uuid AND ${TENANT}
          AND action IN ('review.document_classified', 'review.document_unlinked', '${AI_FINISH_ACTION}')`, [documentId])).rows;
    return { doc, pack, pages, rows, ownNames, linked: !!linkedRow.rows?.[0]?.linked, audits };
  });
}

/** Pure: everything decided before any money is spent. */
export function planPaper({ doc, pages, rows, linked, audits, ownNames, pack, customers = [] }) {
  const type = normalizeDocumentType(doc.document_type);
  const filename = doc.original_filename ?? null;
  if (doc.stage === "verified") return { skip: "verified" };
  if (isSetAsidePaper({ filename, text: pages.slice(0, 2).map((p) => p.text ?? "").join("\n") })) return { skip: "set-aside" };
  if (pack && pack.id && pack.id !== "hvac") return { skip: "pack-not-supported" };
  const failed = audits.filter((a) => a.action === AI_FINISH_ACTION && a.changes?.outcome === "failed").length;
  if (failed >= MAX_FAILURES) return { skip: "failed-twice" };
  if (audits.some((a) => a.action === AI_FINISH_ACTION && a.changes?.outcome !== "failed" && a.changes?.outcome !== "skip" && Number(a.changes?.version ?? 0) >= AI_FINISH_VERSION)) return { skip: "already-looked" };
  const fields = toCompletenessFields(rows);
  const comp = completenessFor(type, fields, null, { filename });
  const hasText = pages.some((p) => String(p.text ?? "").trim() !== "");
  const verdict = autoCheckDecision(type, fields, { hasText, hasLink: linked, filename, text: pages.map((p) => p.text ?? "").join("\n").slice(0, 20000) });
  if (verdict.ok) return { skip: "would-check-already" };
  const hrFolder = rows.some((r) => r.field_key === COMPANY_FOLDER_FIELD_KEY && r.value === HR_FOLDER_ID);
  const noCustomer = type === "hr-letter" || type === "license-certification" || hrFolder;
  const humanChosenType = audits.some((a) => a.action === "review.document_classified");
  const personUnlinked = audits.some((a) => a.action === "review.document_unlinked");
  const present = new Set(fields.filter((f) => String(f.value ?? "").trim() !== "").map((f) => f.field_key));
  // COST GUARD (rev3): ask only for fields this pass could ever accept or suggest AND whose cue is on the page (no money on a permit, no street text
  // for an address ...). A scan with no readable text yet cannot be judged, so it keeps every bindable field until the vision re-read.
  const poor = pages.reduce((n, p) => n + String(p.text ?? "").trim().length, 0) < POOR_TEXT_CHARS;
  const wantedAll = wantedFieldKeys(comp, rows);
  const wanted = poor ? new Set([...wantedAll].filter((k) => BINDABLE_KEYS.has(k))) : plausibleKeys(wantedAll, { type, pages });
  const typeOpen = !humanChosenType && !hrFolder && (!doc.document_type || normalizeDocumentType(doc.document_type) === "other");
  const customerAsk = !linked && !noCustomer && !personUnlinked && !isCompanyRecordType(type, present) ? shortlistCustomers(pages, customers, { ownNames }) : [];
  if (!wanted.size && !typeOpen && !customerAsk.length) return { skip: wantedAll.size ? "no-plausible-field" : "nothing-to-ask" };
  return { type, comp, wanted, typeOpen, humanChosenType, hrFolder, noCustomer, customerAsk, printed: rows.find((r) => r.field_key === "customer_name") ? String(rows.find((r) => r.field_key === "customer_name").corrected_value || rows.find((r) => r.field_key === "customer_name").value || "") : null, hasText };
}

const VISION_MAX_PAGES = 4;
/** Resolution proxy: a file bigger than this is never sent to the vision reader by this pass (large images become many tokens). */
const VISION_MAX_BYTES = 4 * 1024 * 1024;
/** Most tokens one page can cost to read (the reader sends the image, at most ~1.6k tokens for a page, plus its prompt). */
const VISION_INPUT_TOKENS_PER_PAGE = 3000;
const VISION_PROMPT_TOKENS = 2500;
export class VisionOverrun extends Error { constructor(msg) { super(msg); this.name = "VisionOverrun"; } }

/**
 * Worst-case cost of reading this file: ONE reader call is bounded by its fixed max_tokens (readDocument.js PDF_MAX_TOKENS / IMAGE_MAX_TOKENS)
 * and by the page and byte caps above; the reader may make one second (escalation) pass, so the bound is two calls. This is the reservation.
 */
export function visionBoundUsd(model, pageCount, contentType, caps = {}) {
  const outCap = contentType === "application/pdf" ? (caps.pdfMaxTokens ?? 8000) : (caps.imageMaxTokens ?? 3000);
  const one = estimateModelCostUsd(model, { inputTokens: pageCount * VISION_INPUT_TOKENS_PER_PAGE + VISION_PROMPT_TOKENS, outputTokens: outCap });
  return Math.round(2 * one * 1e6) / 1e6;
}
/** Pessimistic cost of re-reading one page with the vision reader (about $0.012 on Haiku; 0.02 leaves room for the escalation re-read). */
export const VISION_USD_PER_PAGE = 0.02; // kept for callers; the reservation is visionBoundUsd()

/** Look at the file BEFORE paying: its type and page count, so the vision cost can be reserved (and refused) up front. */
async function prepareVision(doc, deps) {
  const rd = deps.readDocument ?? (await import("./readDocument.js"));
  const r2 = deps.r2 ?? (await import("./r2.js"));
  if (!doc.storage_key || !r2.keyBelongsToTenant(doc.storage_key, doc.tenant_id)) return { skip: "no-file" };
  // "Haiku only" must hold for the re-read too: a TRANSCRIBE_MODEL / _STRONG pinned to something else turns this step off.
  const models = rd.resolveTranscribeModels ? rd.resolveTranscribeModels(deps.env ?? process.env) : null;
  if (models && !(/haiku/i.test(models.fast) && /haiku/i.test(models.strong))) return { skip: "vision-model-not-haiku" };
  const bytes = await r2.getObject(doc.storage_key);
  const sniffed = rd.sniffMagicBytes(bytes);
  const ct = sniffed || r2.normalizeContentType(doc.content_type);
  const isPdf = ct === "application/pdf";
  if (!(isPdf || /^image\/(jpeg|png|gif|webp)$/.test(ct ?? ""))) return { skip: "not-readable-type" };
  let pageCount = 1;
  if (isPdf) {
    const n = (Buffer.from(bytes).toString("latin1").match(/\/Type\s*\/Page(?![a-z])/g) ?? []).length;
    pageCount = n > 0 ? n : Math.max(1, Math.ceil(bytes.length / 150_000));
  }
  if (pageCount > VISION_MAX_PAGES) return { skip: "too-many-pages" };
  if (bytes.length > VISION_MAX_BYTES) return { skip: "too-large-for-reread" };
  const model = models?.fast ?? "claude-haiku-4-5";
  return { rd, bytes, ct, pageCount, estUsd: visionBoundUsd(model, pageCount, ct, { pdfMaxTokens: rd.PDF_MAX_TOKENS, imageMaxTokens: rd.IMAGE_MAX_TOKENS }) };
}

/** Re-read a scanned paper's pages with the existing vision reader (readPdfOrImage). The cost was reserved by the caller. Writes pages only if clearly better. */
async function visionReread(ctx, doc, oldPages, prep) {
  const meter = createUsageMeter();
  // Abort: the moment the reader's own calls add up to more than the reservation (or it makes a third call) the next call is not made.
  const baseAdd = meter.add;
  meter.add = (model, usage) => {
    baseAdd(model, usage);
    if (meter.costUsd > prep.estUsd || meter.calls > 2) throw new VisionOverrun("vision-over-reserve");
  };
  let read;
  try {
    read = await runWithUsageMeter(meter, () => prep.rd.readPdfOrImage(prep.bytes, prep.ct, ctx, Date.now()));
  } catch (err) {
    return { pages: null, costUsd: meter.snapshot().costUsd, error: err?.name === "VisionOverrun" ? "vision-over-reserve" : err?.message ?? "reread-failed" };
  }
  const costUsd = meter.snapshot().costUsd;
  const pages = (read.pages ?? []).map((p) => ({ page_no: p.page_no, text: stripControlChars(p.text), ...(p.model ? { model: p.model } : {}), ...(Number.isFinite(p.confidence) ? { confidence: p.confidence } : {}) }));
  if (!prep.rd.hasReadableText(pages) || readableChars(pages) <= readableChars(oldPages) + 20) return { pages: null, costUsd };
  await withTenant(ctx, (db) => db.upsertPages(doc.id, pages));
  return { pages: pages.map((p) => ({ page_no: p.page_no, text: p.text })), costUsd };
}

/**
 * Finish ONE paper. Never throws for a paper-level problem (it records `failed` and returns). Throws only ModelBudgetExceededError
 * so the batch can stop cleanly.
 * @returns {Promise<{documentId:string,status:string,skip?:string,filled:object[],rejected:object[],typed:object|null,suggested:object[],costUsd:number,verified:boolean}>}
 */
export async function finishPaper(ctx, documentId, { today = new Date().toISOString().slice(0, 10), source = "cron", actorClerkId = null, shared = {}, deps = {}, deadlineAt = Date.now() + 60_000, limits = null, gate = null, estimateUsd = null } = {}) {
  const empty = { documentId, status: "skipped", filled: [], rejected: [], typed: null, suggested: [], fieldSuggested: [], costUsd: 0, verified: false };
  if (!UUID_RE.test(String(documentId))) return { ...empty, skip: "bad-id" };
  let loaded = await loadForPaper(ctx, documentId);
  if (!loaded) return { ...empty, skip: "not-found" };
  // NOT shared.customers: recheck.js / bodyNameLink use that key for their own (differently shaped) list.
  if (!shared.finishCustomers) {
    shared.finishCustomers = withTenant(ctx, async (db) => (await db.raw(
      `SELECT id, data->>'customer_name' AS name, data->>'service_address' AS address FROM entities
        WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT} ORDER BY created_at LIMIT 5000`, [])).rows.filter((r) => r.name || r.address).map((r) => ({ id: r.id, name: r.name ?? "", address: r.address ?? "" })));
  }
  const customers = await shared.finishCustomers;
  let plan = planPaper({ ...loaded, customers });
  if (plan.skip) {
    // A stable "nothing to do" is written down (a `skip` row) so the next runs do not re-read the same paper; retried after a week.
    if (SKIP_REMEMBERED.has(plan.skip)) {
      try { await withTenant(ctx, (db) => db.logAction({ clerk_user_id: actorClerkId, action: AI_FINISH_ACTION, resource_type: "document", resource_id: documentId, changes: { version: AI_FINISH_VERSION, outcome: "skip", reason: plan.skip, source } })); } catch { /* best effort */ }
    }
    return { ...empty, skip: plan.skip };
  }

  // One run at a time per paper: an atomic claim (advisory lock + audit row) taken BEFORE any money is spent.
  const claim = await claimPaper(ctx, documentId, actorClerkId);
  if (claim !== "ok") return { ...empty, skip: claim };

  gate = gate ?? shared.finishGate ?? null;
  limits = limits ?? shared.finishLimits ?? null;
  let costUsd = 0;
  let heldGate = 0, heldLedger = 0;
  let finalized = false;
  // Reserve BEFORE the call: the run cap / platform cap (in memory, synchronous) and the month + day ledgers (atomic SQL).
  const reserve = async (est) => {
    const stop = gate ? gate.room(est) : null;
    if (stop) throw new FinishStop(stop);
    gate?.hold(est); heldGate += est;
    if (limits) {
      const r = await reserveBudget(ctx, est, limits);
      if (!r.ok) { gate?.release(est); heldGate -= est; throw new FinishStop(r.ok === null ? "budget-unreadable" : r.why); }
      heldLedger += est;
    }
  };
  const finalize = async () => {
    if (finalized) return;
    finalized = true;
    gate?.settle(heldGate, costUsd);
    await adjustBudget(ctx, costUsd - heldLedger);
  };
  let visionRead = false;
  const model = aiFinishModel();
  const callModel = deps.callModel ?? defaultCallModel;
  const fail = async (reason) => {
    try {
      await withTenant(ctx, (db) => db.logAction({ clerk_user_id: actorClerkId, action: AI_FINISH_ACTION, resource_type: "document", resource_id: documentId, changes: { version: AI_FINISH_VERSION, outcome: "failed", reason: String(reason).slice(0, 120) } }));
    } catch { /* best effort */ }
    await releaseClaim(ctx, documentId, actorClerkId);
    return { ...empty, status: "failed", skip: String(reason).slice(0, 80), costUsd };
  };

  try {
    // 1. Poor or empty stored text on a scan: the existing vision reader first. Its cost is estimated from the page count and reserved
    //    first; a scan that is too long, not a Haiku read, or that would not fit the caps is left alone.
    if (readableChars(loaded.pages) < POOR_TEXT_CHARS) {
      const prep = await prepareVision(loaded.doc, deps);
      if (prep.skip) {
        if (!loaded.pages.some((p) => String(p.text ?? "").trim())) return fail(prep.skip);
      } else {
        await reserve(prep.estUsd);
        const v = await visionReread(ctx, loaded.doc, loaded.pages, prep);
        costUsd += v.costUsd ?? 0;
        if (v.pages) {
          visionRead = true;
          loaded = { ...loaded, pages: v.pages };
          plan = planPaper({ ...loaded, customers });
          if (plan.skip) return { ...empty, skip: plan.skip, costUsd };
        } else if (!loaded.pages.some((p) => String(p.text ?? "").trim())) {
          return fail(v.error ?? "no-readable-text");
        }
      }
    }

    // 2. One Haiku call: the existing extraction prompt and tool (+ the two finish answers), the shared prefix cached.
    await assertModelBudget(ctx);
    const selected = selectPages(loaded.pages, PAGE_CHAR_BUDGET).pages;
    const highestPage = loaded.pages.reduce((n, p) => Math.max(n, Number(p.page_no) || 0), 0);
    const promptType = [loaded.doc.document_type].find((t) => typeof t === "string" && /^[a-z][a-z0-9_-]{0,39}$/i.test(t.trim()))?.trim();
    const full = buildExtractPrompt(selected, promptType, loaded.pack, { ownNames: loaded.ownNames });
    const { dynamic, stable } = splitExtractPrompt(full);
    const tool = buildFinishTool(loaded.pack);
    const labels = [...plan.wanted];
    const user = dynamic + FINISH_TASK(labels, plan.typeOpen, plan.customerAsk);
    await reserve(estimateUsd ?? estimatePaperCostUsd(selected));
    const answer = await callModel({ system: stable, user, tool, model, deadlineAt });
    const usage = answer.usage ?? {};
    const callCost = estimateModelCostUsd(model, usage);
    costUsd += callCost;
    try { await recordModelCall(ctx, { ...usage, model }); } catch { /* usage accounting never fails a paper */ }
    const input = answer.toolInput;
    if (!input || typeof input !== "object") return fail("no-answer");

    // 3. Judge the answer. Everything below is a way to throw it away.
    const fieldsJudged = acceptFields(input.fields, { pages: loaded.pages, wanted: plan.wanted, pageCount: highestPage, today, pack: loaded.pack, ownNames: loaded.ownNames });
    const typeJudged = plan.typeOpen ? acceptType({ answer: input, currentType: loaded.doc.document_type, humanChosen: plan.humanChosenType, hrOverride: plan.hrFolder, pages: loaded.pages }) : { ok: false, reason: "not-asked" };
    const pickJudged = plan.customerAsk.length && input.customer_pick
      ? acceptCustomerPick({ pick: input.customer_pick, shortlist: plan.customerAsk, pages: loaded.pages, ownNames: loaded.ownNames, printedName: plan.printed })
      : { ok: false, reason: "none" };

    // 4. Write, insert-only, in one short transaction; then the normal automatic check.
    const out = await withTenant(ctx, async (db) => {
      await db.raw("SELECT pg_advisory_xact_lock(hashtext($1))", [`recheck:${documentId}`]);
      const cur = await db.getDocument(documentId);
      if (!cur || cur.stage === "verified") return { written: [], typed: null, suggested: [], fieldSug: [], verified: false, stale: true };
      const rowsNow = await db.listExtractionsByDocument(documentId);
      const entityId = rowsNow.find((r) => r.entity_id)?.entity_id ?? null;
      const written = [];
      for (const f of fieldsJudged.accepted) {
        const base = baseKeyOf(f.field_key);
        const guard = REPEATABLE.has(f.field_key) ? "x.field_key = $5::text AND x.value = $4::text" : "x.field_key IN ($5::text, $9::text, $10::text)";
        const r = await db.raw(
          `WITH ins AS (
             INSERT INTO facets (tenant_id, document_id, page_no, segment_id, label_raw, value_raw, confidence, mapped_field_key, mapping_method, created_at)
             SELECT (current_setting('app.tenant_id', true))::uuid, $1::uuid, $2::int, $3::text, COALESCE($6::text, $5::text), $4::text, $7::numeric, $5::text, 'registry', NOW()
              WHERE NOT EXISTS (SELECT 1 FROM extractions x WHERE x.document_id = $1::uuid AND x.${TENANT} AND ${guard})
             RETURNING id
           )
           INSERT INTO extractions (tenant_id, document_id, entity_id, field_key, value, confidence, source_facet_id, created_at)
           SELECT (current_setting('app.tenant_id', true))::uuid, $1::uuid, $8::uuid, $5::text, $4::text, $7::numeric, ins.id, NOW() FROM ins
           RETURNING id`,
          [documentId, f.page_no ?? null, FIELD_AI_SEGMENT, f.value, f.field_key, f.verbatim ?? null, f.confidence, entityId, base, unconfirmedKey(base)]);
        if (r.rowCount > 0) written.push({ field_key: f.field_key, value: f.value, page_no: f.page_no ?? null, method: "ai", ...(f.flags ? { flags: f.flags } : {}) });
      }
      const fieldSug = await storeSuggestions(db, documentId, fieldsJudged.suggestions.filter((q) => !written.some((w) => baseKeyOf(w.field_key) === q.field_key)), { actorClerkId, rowsNow });
      let typed = null;
      if (typeJudged.ok) {
        // Re-check the person-chose rule inside the transaction, on the freshest audit rows (fail closed).
        const cls = await db.getAuditLog({ action: "review.document_classified", resource_type: "document", resource_id: documentId }).catch(() => null);
        const still = cur.document_type == null || normalizeDocumentType(cur.document_type) === "other";
        if (cls !== null && cls.length === 0 && still) {
          await db.updateDocument(documentId, { document_type: typeJudged.to });
          await db.logAction({ clerk_user_id: actorClerkId, action: RETYPE_ACTION, resource_type: "document", resource_id: documentId,
            changes: { from: cur.document_type ?? null, to: typeJudged.to, source: "ai-finish", evidence: String(typeJudged.evidence).slice(0, 200), model_calls: 1, had_fields: rowsNow.length > 0 } });
          typed = { from: cur.document_type ?? null, to: typeJudged.to };
        }
      }
      // The normal automatic check (deterministic label fill, strong-evidence link, autoCheckDecision, stored-value audit).
      const rc = await recheckDocumentTx(db, documentId, { actorClerkId, source: `ai-finish:${source}`, today, shared });
      // A customer suggestion: only while still unlinked, never after a person unlinked it, merged with what Re-check suggested.
      const suggested = [];
      if (pickJudged.ok) {
        const l = await db.raw(`SELECT ${HAS_LINK_SQL} AS linked FROM documents d WHERE d.id = $1::uuid`, [documentId]);
        const unl = await db.raw(`SELECT 1 FROM audit_log WHERE resource_id = $1::uuid AND action = 'review.document_unlinked' AND ${TENANT} LIMIT 1`, [documentId]);
        const typeNow = normalizeDocumentType((await db.getDocument(documentId))?.document_type);
        if (!l.rows?.[0]?.linked && !unl.rows.length && typeNow !== "hr-letter" && typeNow !== "license-certification") {
          const last = await db.raw(`SELECT changes FROM audit_log WHERE resource_id = $1::uuid AND action = $2::text AND ${TENANT} ORDER BY created_at DESC LIMIT 1`, [documentId, LINK_SUGGESTION_ACTION]);
          const existing = (last.rows?.[0]?.changes?.candidates ?? []).filter((c) => c && c.id);
          const merged = [...existing.filter((c) => c.id !== pickJudged.customer.id), pickJudged.customer].slice(-3);
          await setLinkSuggestion(db, documentId, merged);
          suggested.push(pickJudged.customer);
        }
      }
      return { written, typed, suggested, fieldSug, verified: !!rc.aiVerified, linked: !!rc.linked, stale: false };
    });

    const rejected = [...fieldsJudged.rejected, ...(plan.typeOpen && !typeJudged.ok && typeJudged.reason !== "not-asked" && input.document_type && input.document_type !== "other" ? [{ field_key: "document_type", reason: typeJudged.reason }] : []),
      ...(input.customer_pick && !pickJudged.ok ? [{ field_key: "customer_pick", reason: pickJudged.reason }] : [])];
    const touched = out.written.length > 0 || !!out.typed || out.suggested.length > 0 || out.fieldSug.length > 0;
    await withTenant(ctx, (db) => db.logAction({
      clerk_user_id: actorClerkId, action: AI_FINISH_ACTION, resource_type: "document", resource_id: documentId,
      changes: {
        version: AI_FINISH_VERSION, outcome: touched ? "ok" : "nothing", source, model, vision_reread: visionRead,
        filled: out.written, typed: out.typed, suggested: out.suggested.map((c) => c.id), field_suggestions: out.fieldSug.length, rejected: rejected.slice(0, 20),
        verified: out.verified,
        input_tokens: usage.inputTokens ?? 0, output_tokens: usage.outputTokens ?? 0, cache_read: usage.cacheReadInputTokens ?? 0, cache_write: usage.cacheCreationInputTokens ?? 0,
      },
    }));
    return { documentId, status: touched ? "finished" : "nothing", filled: out.written, rejected, typed: out.typed, suggested: out.suggested, fieldSuggested: out.fieldSug, costUsd, verified: out.verified };
  } catch (err) {
    if (err instanceof FinishStop || err instanceof ModelBudgetExceededError || err?.name === "ModelBudgetExceededError") { await releaseClaim(ctx, documentId, actorClerkId); throw err; }
    if (isRetryableModelStatus(err)) { await releaseClaim(ctx, documentId, actorClerkId); const e = new Error("provider-busy"); e.name = "ProviderBusy"; throw e; } // a busy provider is not the paper's fault: stop the run, no failure is held against it
    console.error(`ai-finish: ${documentId} failed: ${err?.message}`);
    return fail(err?.message ?? "error");
  } finally {
    try { await finalize(); } catch { /* ledger is best effort */ }
  }
}

/* ------------------------------------------------------------------ a batch (one tenant) */

/** Papers worth a look: not verified, not already done by this version, fewer than MAX_FAILURES failures. Newest first. */
export async function listFinishCandidates(ctx, { documentIds = null, limit = 500 } = {}) {
  const ids = Array.isArray(documentIds) ? documentIds.filter((x) => typeof x === "string" && UUID_RE.test(x)).slice(0, 500) : null;
  return withTenant(ctx, async (db) => (await db.raw(
    `SELECT d.id FROM documents d
      WHERE d.${TENANT} AND d.stage IN ('read', 'mapped', 'linked')
        ${ids ? "AND d.id = ANY($2::uuid[])" : ""}
        AND EXISTS (SELECT 1 FROM document_pages p WHERE p.document_id = d.id AND p.${TENANT})
        AND (SELECT count(*) FROM audit_log a WHERE a.resource_id = d.id AND a.${TENANT} AND a.action = '${AI_FINISH_ACTION}' AND a.changes->>'outcome' = 'failed') < ${MAX_FAILURES}
        AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.resource_id = d.id AND a.${TENANT} AND a.action = '${AI_FINISH_ACTION}'
                          AND a.changes->>'outcome' NOT IN ('failed', 'skip') AND COALESCE((a.changes->>'version')::int, 0) >= $1)
        AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.resource_id = d.id AND a.${TENANT} AND a.action = '${AI_FINISH_ACTION}'
                          AND a.changes->>'outcome' = 'skip' AND a.created_at > NOW() - INTERVAL '7 days')
      ORDER BY d.created_at DESC LIMIT ${Math.max(1, Math.min(3000, Number(limit) || 500))}`,
    ids ? [AI_FINISH_VERSION, ids] : [AI_FINISH_VERSION])).rows.map((r) => r.id));
}

/**
 * Finish a tenant's remaining papers in a bounded chunk. Reserves each paper's estimated cost BEFORE starting it, so the run cap, the
 * daily/monthly budget and the platform cap are never exceeded by more than the estimate's error. Stops cleanly and reports what is left.
 * @param {object} ctx
 * @param {{plan?:string, documentIds?:string[]|null, limit?:number, runCapUsd?:number, platform?:{remainingUsd:number}, deadlineAt?:number, concurrency?:number, source?:string, actorClerkId?:string|null, today?:string, deps?:object, env?:object}} opts
 * @returns {Promise<{considered:number, processed:number, finished:number, facts:number, suggested:number, typed:number, verified:number, nothing:number, failed:number, skipped:number, stoppedBy:string|null, leftIds:string[], costUsd:number}>}
 */
export async function finishTenantPapers(ctx, opts = {}) {
  const env = opts.env ?? process.env;
  const sum = { considered: 0, processed: 0, finished: 0, facts: 0, fieldSuggestions: 0, savedCalls: 0, suggested: 0, typed: 0, verified: 0, nothing: 0, failed: 0, skipped: 0, stoppedBy: null, leftIds: [], costUsd: 0 };
  if (!isAiFinishEnabled(env)) { sum.stoppedBy = "switched-off"; return sum; }
  const cap = opts.runCapUsd ?? runCapUsd(env);
  const limit = Math.max(1, Math.min(500, Number(opts.limit) || 40));
  const deadlineAt = opts.deadlineAt ?? Date.now() + 150_000;
  const ids = await listFinishCandidates(ctx, { documentIds: opts.documentIds ?? null, limit: Math.max(limit, 500) });
  sum.considered = ids.length;
  const budget = await aiFinishBudget(ctx, opts.plan, { env });
  if (budget.monthSpent === null || budget.daySpent === null) { sum.stoppedBy = "budget-unreadable"; sum.leftIds = ids; return sum; }
  if (budget.monthCap - budget.monthSpent <= 0) { sum.stoppedBy = "month-budget"; sum.leftIds = ids; return sum; }
  if (budget.dayCap - budget.daySpent <= 0) { sum.stoppedBy = "day-budget"; sum.leftIds = ids; return sum; }
  // Shared by every worker (and, through the atomic SQL reservations, by every other run on this tenant): nothing is read once and trusted.
  let reserved = 0;
  const gate = {
    room: (est) => {
      if (sum.costUsd + reserved + est > cap) return "run-cap";
      if (opts.platform && sum.costUsd + reserved + est > opts.platform.remainingUsd) return "platform-cap";
      return null;
    },
    hold: (est) => { reserved += est; },
    release: (est) => { reserved -= est; },
    settle: (est, actual) => { reserved -= est; sum.costUsd += actual; },
  };
  const shared = { finishGate: gate, finishLimits: { monthCapUsd: budget.monthCap, dayCapUsd: budget.dayCap } };
  const queue = [...ids];
  let attempted = 0;
  const work = async () => {
    while (!sum.stoppedBy) {
      if (Date.now() >= deadlineAt) { sum.stoppedBy = "deadline"; return; }
      if (attempted >= limit) { sum.stoppedBy = queue.length ? "chunk-done" : null; return; }
      const id = queue.shift();
      if (!id) return;
      attempted++;
      try {
        const r = await finishPaper(ctx, id, { today: opts.today, source: opts.source ?? "cron", actorClerkId: opts.actorClerkId ?? null, shared, deps: opts.deps ?? {}, deadlineAt, estimateUsd: opts.estimateUsd ?? null });
        if (r.status === "skipped") { sum.skipped++; attempted--; if (r.skip === "no-plausible-field") sum.savedCalls++; }
        else {
          sum.processed++;
          if (r.status === "failed") sum.failed++;
          else if (r.status === "nothing") sum.nothing++;
          else if (r.status === "finished") sum.finished++;
          sum.facts += r.filled.length; sum.fieldSuggestions += r.fieldSuggested?.length ?? 0; sum.suggested += r.suggested.length; sum.typed += r.typed ? 1 : 0; sum.verified += r.verified ? 1 : 0;
        }
      } catch (err) {
        attempted--;
        if (err?.name === "FinishStop") { sum.stoppedBy = sum.stoppedBy ?? err.reason; queue.unshift(id); }
        else if (err?.name === "ModelBudgetExceededError") { sum.stoppedBy = sum.stoppedBy ?? "tenant-model-budget"; queue.unshift(id); }
        else if (err?.name === "ProviderBusy") { sum.stoppedBy = sum.stoppedBy ?? "provider-busy"; queue.unshift(id); }
        else { sum.failed++; sum.processed++; console.error(`ai-finish: ${id}: ${err?.message}`); }
      }
    }
  };
  const workers = Math.max(1, Math.min(4, Number(opts.concurrency) || 3));
  await Promise.all(Array.from({ length: workers }, () => work()));
  if (opts.platform) opts.platform.remainingUsd = Math.max(0, opts.platform.remainingUsd - sum.costUsd);
  sum.leftIds = queue.slice(0, 500);
  sum.costUsd = Math.round(sum.costUsd * 1e6) / 1e6;
  return sum;
}
