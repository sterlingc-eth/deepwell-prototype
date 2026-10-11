/**
 * router/dqlArbiter.js - when the DQL engine fully explains a question that an OLDER classifyAll lane also claimed, who answers it.
 *
 * DQL only reaches this file with a plan (parseDql explained every word of the question). The older lane that won is described by a "pair":
 *    from = stage[:sub]    (stage = analytics | deterministic | relations | fastPath | contactLookup | docLookup | contentCount | money;
 *                           sub = the deterministic route, the contact field, the relations family ... when the stage has one)
 *    to   = the DQL plan's op (and its dim/by when it has one)
 * A pair is on the allowlist below ONLY when the dev set showed DQL right where the older lane was wrong. A lane that answers a question type
 * correctly is never overridden: no entry, no override. The records-first lane runs inside ask.js before the router and is not touched here.
 *
 * Left OFF the list on purpose: ops whose only dev evidence is that the older lane gave up (no wrong answer to replace) and that answer a period / date question
 * (analytics:count tm_since, tm_inactive, count; tenantcount and money tm_inactive; analytics:list first_ever): a sealed run showed one such question turn from a model call into a wrong answer.
 *
 * analytics:list set_select is off the list too: "which units had service this month" is answered with the number of visits by the older lane (the golden exam's truth), DQL answers
 * with the distinct units.
 *
 * Kill switch: DONOVAN_DQL_ARBITER=0 (the older lane keeps every claim). DONOVAN_DQL_ARBITER=all is a diagnostic mode that overrides every pair
 * (used only to measure new pairs against the dev set).
 */

/**
 * Each entry: { from, ops, why, dev, unless?, only?, plan? }.
 *   unless  a question shape the entry must NOT take (tested on the question text)
 *   only    a question shape the entry is limited to
 *   plan    { has: [plan fields that must be set], not: { "path.in.plan": [values the plan must not carry] } }
 *   from  "stage" matches the whole stage, "stage:sub" matches one sub-lane; a trailing * matches a prefix.
 *   ops   DQL plan ops (or "op:dim") the entry covers; "*" = any op.
 */
export const ARBITER_ALLOWLIST = [
  { from: "deterministic:aggregate", ops: ["sum","set_per_entity","share_pct","tm_compare","set_above_avg","tm_rate","compare_two_values","first_ever","tm_expiry","set_rank:tech"],
    why: "the aggregate route answers a different question (grand total, ungrouped numbers) when the question has a comparison, a share, a rank among rows or a set condition",
    dev: "20 answers improved (wrong, declined or punted before, right now), 0 regressions (per op: sum 4, set_per_entity 1, share_pct 2, tm_compare 3, set_above_avg 6, tm_rate 1, compare_two_values 1, first_ever 2, tm_expiry 2, set_rank:tech 1)" },
  { from: "deterministic:aggregate", ops: ["avg"], plan: { has: ["time"] },
    why: "the average of everything is returned for an average over one period (\"mean invoice total 2026\"); an unfiltered average is answered correctly by the older lane",
    dev: "4 answers improved, 0 regressions (per period: 2026, 2012, 2024, 2025)" },
  { from: "deterministic:aggregate", ops: ["group_sum"], plan: { not: { "groupBy.0.by": ["year", "month", "quarter"] } },
    why: "this year's billings by city were answered with the year's total; billings by year or month are answered correctly by the older lane",
    dev: "2 answers improved, 0 regressions (per op: group_sum 2)" },
  { from: "deterministic:aggregate", ops: ["tm_series"], plan: { not: { mode: ["peak"] } },
    why: "tickets by month of the year were answered with every calendar month; \"busiest month\" questions are answered correctly by the older lane",
    dev: "1 answers improved, 0 regressions (per op: tm_series 1)" },

  { from: "money", ops: ["sum","median","set_rank:customer","tm_compare","bottom_n","tm_series","latest","count","find_document:total","set_select","duplicates","tm_since","group_count","cost_breakdown","find_document:code","missing_field","avg","line_search","top_n","group_sum"],
    why: "the money lane returns the company grand total or a lifetime total for period / city / customer questions, and its fall-through punts",
    dev: "48 answers improved (wrong, declined or punted before, right now), 0 regressions (per op: sum 3, median 2, set_rank:customer 2, tm_compare 4, bottom_n 2, tm_series 2, latest 6, count 1, find_document:total 1, set_select 4, duplicates 3, tm_since 6, group_count 1, cost_breakdown 1, find_document:code 2, missing_field 2, avg 1, line_search 1) + 3 supplement rows (best/highest year, spend by vendor)" },  { from: "money", ops: ["list"], plan: { not: { "filters.0.field": ["total"] } },
    why: "a list of what was billed or quoted in a period / by a kind; an amount threshold (\"invoices over $5,000\") is counted correctly by the older lane",
    dev: "2 answers improved, 0 regressions (per op: list 2)" },

  { from: "deterministic:vendorbills", ops: ["sum","line_search","set_rank:customer","set_building","group_sum"],
    why: "vendor / invoice spend questions: the route says no vendor bills are on file, or punts, where purchase orders and invoices answer",
    dev: "21 answers improved (wrong, declined or punted before, right now), 0 regressions (per op: sum 16, line_search 3, set_rank:customer 1, set_building 1) + 1 supplement row (total billed by city)" },
  { from: "deterministic:tenantcount", ops: ["sum","tm_compare","line_search","group_sum","missing_field","top_n"],
    why: "counts the wrong thing for money and comparison questions (lifetime total instead of the period, a line count for an install count)",
    dev: "18 answers improved (wrong, declined or punted before, right now), 0 regressions (per op: sum 5, tm_compare 6, line_search 5, group_sum 1, missing_field 1) + 1 supplement row (best month in a year)" },
  { from: "analytics:count", ops: ["set_select"], unless: /^\s*(?:did|do|does|is|are|was|were|has|have|can|any)\b/i,
    why: "a customer count where the question asked who has a combination of things (a yes/no question is left to the older lane)",
    dev: "7 answers improved, 0 regressions on non-yes/no questions (1 yes/no question was answered with a list, so those are excluded)" },
  { from: "analytics:count", ops: ["avg","max","list","missing_field","duplicates","tm_expiry","first_ever","field_conflict","line_search","sum"],
    why: "a bare entity count where the question asked for a list, a date, an average, a period or a condition",
    dev: "22 answers improved (wrong, declined or punted before, right now), 0 regressions (per op: avg 1, max 1, list 4, missing_field 3, duplicates 1, tm_expiry 6, first_ever 2, field_conflict 1, line_search 1, sum 1)" },
  { from: "fastPath:invoice_total", ops: ["latest"],
    why: "gives the amount of the last invoice only, without the invoice or its date",
    dev: "1 answers improved (wrong, declined or punted before, right now), 0 regressions (per op: latest 1)" },
  { from: "analytics:list", ops: ["list","tm_expiry","latest","missing_field","exists_yes_no","bottom_n","line_search"],
    why: "a list or a count of the whole entity where the question names a place, a type, a period or a condition",
    dev: "23 answers improved (wrong, declined or punted before, right now), 0 regressions (per op: list 15, tm_expiry 3, latest 1, missing_field 1, exists_yes_no 1, bottom_n 1, line_search 1)" },
  { from: "deterministic:personamt", ops: ["list"], only: /\bwith\s+(?:their\s+)?(?:amounts?|totals?)\b/i,
    why: "an amount-threshold question asked with 'with their totals' that the route punts on",
    dev: "0 dev rows, 1 supplement row (invoices over $7000 with their totals)" },
  { from: "deterministic:quote", ops: ["set_select","median","set_ratio:to"],
    why: "quote questions asked as a median, ratio or set",
    dev: "3 answers improved (wrong, declined or punted before, right now), 0 regressions (per op: set_select 1, median 1, set_ratio:to 1)" },
  { from: "deterministic:custdocrank", ops: ["set_select"],
    why: "customers-without-a-document questions",
    dev: "1 answers improved (wrong, declined or punted before, right now), 0 regressions (per op: set_select 1)" },
  { from: "deterministic:maintenance", ops: ["tm_inactive"],
    why: "answers a 'not serviced since' question with the overdue-maintenance list",
    dev: "1 answers improved (wrong, declined or punted before, right now), 0 regressions (per op: tm_inactive 1)" },
  { from: "docLookup:", ops: ["tm_since","set_select","tm_between","find_document:code","find_document:serial","list","text_search","find_document:filename","median"],
    why: "reads the rest of the question as a customer name (\"I couldn't find a customer named ...\")",
    dev: "11 answers improved (wrong, declined or punted before, right now), 0 regressions (per op: tm_since 1, set_select 1, tm_between 2, find_document:code 2, find_document:serial 1, list 1, text_search 1, find_document:filename 1, median 1)" },
  { from: "fastPath:equipment_list", ops: ["list"],
    why: "gives a count where the question asked which units",
    dev: "1 answers improved (wrong, declined or punted before, right now), 0 regressions (per op: list 1)" },
  { from: "fastPath:document_list_for_subject", ops: ["list"],
    why: "gives a count where the question asked which documents",
    dev: "1 answers improved (wrong, declined or punted before, right now), 0 regressions (per op: list 1)" },
  { from: "contactLookup:lastVisit", ops: ["tm_since"],
    why: "gives the date of the last visit where the question asked how many days ago",
    dev: "3 answers improved (wrong, declined or punted before, right now), 0 regressions (per op: tm_since 3)" },
  { from: "deterministic:serial", ops: ["tm_age"],
    why: "gives the unit card where the question asked for its age",
    dev: "4 answers improved (wrong, declined or punted before, right now), 0 regressions (per op: tm_age 4)" },
  { from: "analytics:groupBy", ops: ["group_count"],
    why: "a grouping of all documents by an empty field where the question names the document kind",
    dev: "2 answers improved (wrong, declined or punted before, right now), 0 regressions (per op: group_count 2)" },
  { from: "deterministic:fieldabsence", ops: ["missing_field"],
    why: "answers a missing-field question with a different count",
    dev: "2 answers improved (wrong, declined or punted before, right now), 0 regressions (per op: missing_field 2)" },
  { from: "contentCount", ops: ["line_search"],
    why: "counts documents that mention a word where line items were asked",
    dev: "1 answers improved (wrong, declined or punted before, right now), 0 regressions (per op: line_search 1)" },
  { from: "contactLookup:slotFill", ops: ["duplicates"],
    why: "asks nothing useful of a duplicate-serial question",
    dev: "1 answers improved (wrong, declined or punted before, right now), 0 regressions (per op: duplicates 1)" },
];

export function arbiterMode() {
  const v = process.env.DONOVAN_DQL_ARBITER;
  return v === "0" ? "off" : v === "all" ? "all" : "on";
}

/** The older lane's pair label. */
export function laneLabel(winner, plan) {
  const n = winner?.name; const it = winner?.intent;
  if (n === "deterministic") return `deterministic:${it?.route ?? ""}`;
  if (n === "relations") return `relations:${it?.family ?? it?.kind ?? ""}`;
  if (n === "contactLookup") return `contactLookup:${it?.field ?? ""}`;
  if (n === "docLookup") return `docLookup:${it?.type ?? it?.docType ?? ""}`;
  if (n === "fastPath") return `fastPath:${it?.intent ?? it?.kind ?? ""}`;
  if (n === "analytics") return `analytics:${plan?.op ?? ""}`;
  return String(n ?? "");
}

export function dqlLabel(plan) {
  return plan ? [plan.op, plan.dim ?? plan.by ?? null].filter(Boolean).join(":") : "";
}

const fromMatches = (pat, label) => (pat.endsWith("*") ? label.startsWith(pat.slice(0, -1)) : pat === label || (!pat.includes(":") && label.startsWith(pat + ":")));
const opMatches = (ops, plan) => ops === "*" || (Array.isArray(ops) ? ops : [ops]).some((o) => o === "*" || o === plan.op || o === dqlLabel(plan));

const pathGet = (o, path) => String(path).split(".").reduce((a, k) => (a == null ? undefined : a[k]), o);
/** An entry's optional plan conditions: has = plan fields that must be set (time / filters ...), not = field value lists the plan must not carry. */
function planFits(cond, plan) {
  if (!cond) return true;
  for (const k of cond.has ?? []) { const v = pathGet(plan, k); if (v == null || (Array.isArray(v) && !v.length)) return false; }
  for (const [k, vals] of Object.entries(cond.not ?? {})) if (vals.includes(pathGet(plan, k))) return false;
  return true;
}

/** true when DQL may take this question from the older lane. */
/**
 * A question that asks WHEN ("when was X last serviced", "what date was ...") is answered by the older lane's own date wording; DQL's date ops answer in days
 * and ties ("2 permits share that date"), which is a different answer to a different question. Those ops never take a "when" question.
 */
const WHEN_QUESTION = /^\s*(?:so\s+|hey\s+|and\s+)?(?:when|what\s+(?:date|day)|which\s+(?:date|day)|on\s+what\s+(?:date|day))\b/i;
const DATE_OPS = new Set(["tm_since", "tm_age", "tm_between", "tm_expiry", "latest", "first_ever"]);

/**
 * The older lanes were written and tuned on one HVAC shop. For an organization that chose a different kind of business at sign-up (tenants.settings.industry,
 * e.g. "legal", "medical-admin", "nonprofit"), the factory runs (10 synthetic companies, dev + train, 4,000 questions each way) showed DQL right wherever an older
 * lane was right and right again on 218 answers where it was wrong, declined or punted, so DQL takes every question it fully reads there. Organizations on the
 * HVAC setting, or with no setting, keep the allowlist above exactly as it was.
 */
export const OTHER_INDUSTRY_TAKES_ALL = true;
const otherIndustry = (k) => OTHER_INDUSTRY_TAKES_ALL && Boolean(k) && String(k).toLowerCase() !== "hvac";

export function arbiterAllows(winner, intent, { oldLabel, question, industryKind } = {}) {
  const mode = arbiterMode();
  if (mode === "off") return false;
  const plan = intent?.plan;
  if (!plan || intent.plain) return false;
  if (mode === "all" || otherIndustry(industryKind)) return true;
  if (DATE_OPS.has(plan.op) && WHEN_QUESTION.test(String(question ?? ""))) return false;
  const label = oldLabel ?? laneLabel(winner, null);
  return ARBITER_ALLOWLIST.some((e) => fromMatches(e.from, label) && opMatches(e.ops, plan) && !(e.unless && e.unless.test(String(question ?? ""))) && (!e.only || e.only.test(String(question ?? ""))) && planFits(e.plan, plan));
}
